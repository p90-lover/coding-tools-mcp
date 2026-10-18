"""Task orchestration and persistence helpers."""
from __future__ import annotations

import json
import threading
import time
import uuid
from concurrent.futures import FIRST_COMPLETED, ThreadPoolExecutor, wait
from threading import Event
from datetime import datetime, timezone
from typing import Any, Callable, Optional

from sqlalchemy import case, update
from sqlmodel import Session, select, func

from core.account_graph import (
    load_account_graphs,
    patch_account_graph,
    recover_lifecycle_status_for_valid_account,
)
from core.base_platform import AccountStatus, RegisterConfig
from core.datetime_utils import format_local_clock, serialize_datetime
from core.db import AccountModel, AccountOverviewModel, TaskEventModel, TaskLog, TaskModel, engine, save_account
from core.platform_accounts import build_platform_account
from core.registry import get
from core.verification_hold import get_verification_hold, can_resume_verification_hold
from infrastructure.platform_runtime import PERSISTED_ACTION_DATA_KEYS, PlatformRuntime
from domain.actions import ActionExecutionCommand, ActionExecutionResult

TASK_TYPE_REGISTER = "register"
TASK_TYPE_ACCOUNT_CHECK = "account_check"
TASK_TYPE_ACCOUNT_CHECK_ALL = "account_check_all"
TASK_TYPE_PLATFORM_ACTION = "platform_action"
TASK_TYPE_PROXY_CHECK = "proxy_check"
_proxy_check_create_lock = threading.Lock()

TASK_STATUS_PENDING = "pending"
TASK_STATUS_CLAIMED = "claimed"
TASK_STATUS_RUNNING = "running"
TASK_STATUS_SUCCEEDED = "succeeded"
TASK_STATUS_FAILED = "failed"
TASK_STATUS_INTERRUPTED = "interrupted"
TASK_STATUS_CANCEL_REQUESTED = "cancel_requested"
TASK_STATUS_CANCELLED = "cancelled"
TASK_STATUS_PAUSED = "paused"

TERMINAL_TASK_STATUSES = {
    TASK_STATUS_SUCCEEDED,
    TASK_STATUS_FAILED,
    TASK_STATUS_INTERRUPTED,
    TASK_STATUS_CANCELLED,
    TASK_STATUS_PAUSED,
}
ACTIVE_TASK_STATUSES = {
    TASK_STATUS_CLAIMED,
    TASK_STATUS_RUNNING,
    TASK_STATUS_CANCEL_REQUESTED,
}

_task_locks: dict[str, threading.Lock] = {}
_task_locks_guard = threading.Lock()


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


def _utcnow_iso() -> str:
    return _utcnow().isoformat().replace("+00:00", "Z")


def _serialize_datetime(value: datetime | None) -> str | None:
    return serialize_datetime(value)


def _json_default(value: Any) -> Any:
    if isinstance(value, datetime):
        return _serialize_datetime(value)
    raise TypeError(f"Object of type {value.__class__.__name__} is not JSON serializable")


def _dump_json(data: Any) -> str:
    return json.dumps(data or {}, ensure_ascii=False, default=_json_default)


def _task_lock(task_id: str) -> threading.Lock:
    with _task_locks_guard:
        lock = _task_locks.get(task_id)
        if lock is None:
            lock = threading.Lock()
            _task_locks[task_id] = lock
        return lock


def _mutate_task(task_id: str, fn: Callable[[TaskModel], None], *, event: TaskEventModel | None = None) -> Optional[TaskModel]:
    with _task_lock(task_id):
        with Session(engine) as session:
            task = session.get(TaskModel, task_id)
            if not task:
                return None
            fn(task)
            if event is not None:
                session.add(event)
            task.updated_at = _utcnow()
            session.add(task)
            session.commit()
            session.refresh(task)
            return task


def _save_task_log(platform: str, email: str, status: str, error: str = "", detail: dict | None = None) -> None:
    with Session(engine) as session:
        log = TaskLog(
            platform=platform,
            email=email,
            status=status,
            error=error,
            detail_json=_dump_json(detail or {}),
        )
        session.add(log)
        session.commit()


def _task_result_seed(result: dict[str, Any] | None = None) -> dict[str, Any]:
    base = {"errors": [], "cashier_urls": [], "data": None}
    if result:
        base.update(result)
    return base


def _task_account_keys(task_type: str, payload: dict[str, Any]) -> list[str]:
    if task_type == TASK_TYPE_PROXY_CHECK:
        return ["proxies:check"]
    if task_type not in {TASK_TYPE_ACCOUNT_CHECK, TASK_TYPE_PLATFORM_ACTION}:
        return []
    ids = payload.get("account_ids") or [payload.get("account_id", 0)]
    keys = [f"account:{int(account_id)}" for account_id in ids if int(account_id or 0) > 0]
    if payload.get("platform") == "chatgpt" and payload.get("action_id") == "complete_registration":
        keys.append("chatgpt:recovery")
    return keys


def _task_verification_hold(task_type: str, payload: dict[str, Any]):
    if payload.get("platform") != "chatgpt":
        return None
    if task_type != TASK_TYPE_REGISTER and not (task_type == TASK_TYPE_PLATFORM_ACTION and payload.get("action_id") == "complete_registration"):
        return None
    hold = get_verification_hold()
    if task_type == TASK_TYPE_PLATFORM_ACTION and "account_ids" not in payload:
        params = payload.get("params") or {}
        if can_resume_verification_hold(hold, payload.get("account_id"), params.get("resume_verification_hold"), params.get("_verification_hold_detected_at")):
            return None
    return hold


def serialize_task(task: TaskModel) -> dict[str, Any]:
    result = task.get_result()
    if task.status == TASK_STATUS_PENDING:
        hold = _task_verification_hold(task.type, task.get_payload())
        if hold:
            result["verification_hold"] = hold
        else:
            result.pop("verification_hold", None)
    if task.type == TASK_TYPE_REGISTER:
        payload = task.get_payload()
        extra = payload.get("extra") or {}
        result["registration_config"] = {
            "executor_type": payload.get("executor_type") or "protocol",
            "identity_provider": extra.get("identity_provider") or "mailbox",
            "oauth_provider": extra.get("oauth_provider") or "",
            "count": max(int(payload.get("count", 1) or 1), 1),
            "concurrency": max(int(payload.get("concurrency", 1) or 1), 1),
        }
    progress_total = int(task.progress_total or 0)
    progress_current = int(task.progress_current or 0)
    return {
        "id": task.id,
        "task_id": task.id,
        "type": task.type,
        "platform": task.platform,
        "status": task.status,
        "terminal": task.status in TERMINAL_TASK_STATUSES,
        "cancellable": task.status in {TASK_STATUS_PENDING, TASK_STATUS_CLAIMED, TASK_STATUS_RUNNING, TASK_STATUS_CANCEL_REQUESTED},
        "progress": f"{progress_current}/{progress_total}" if progress_total else "0/0",
        "progress_detail": {
            "current": progress_current,
            "total": progress_total,
            "label": f"{progress_current}/{progress_total}" if progress_total else "0/0",
        },
        "success": int(task.success_count or 0),
        "error_count": int(task.error_count or 0),
        "errors": list(result.get("errors", [])),
        "cashier_urls": list(result.get("cashier_urls", [])),
        "data": result.get("data"),
        "result": result,
        "error": task.error,
        "created_at": _serialize_datetime(task.created_at),
        "started_at": _serialize_datetime(task.started_at),
        "finished_at": _serialize_datetime(task.finished_at),
        "updated_at": _serialize_datetime(task.updated_at),
    }


def serialize_event(event: TaskEventModel) -> dict[str, Any]:
    return {
        "id": event.id,
        "task_id": event.task_id,
        "type": event.type,
        "level": event.level,
        "message": event.message,
        "line": f"[{format_local_clock(event.created_at)}] {event.message}",
        "detail": event.get_detail(),
        "created_at": _serialize_datetime(event.created_at),
    }


def create_task(
    *,
    task_type: str,
    platform: str,
    payload: dict[str, Any],
    progress_total: int = 1,
    result_seed: dict[str, Any] | None = None,
) -> dict[str, Any]:
    task_id = f"task_{int(time.time() * 1000)}_{uuid.uuid4().hex[:6]}"
    task = TaskModel(
        id=task_id,
        type=task_type,
        platform=platform,
        status=TASK_STATUS_PENDING,
        payload_json=_dump_json(payload),
        result_json=_dump_json(_task_result_seed(result_seed)),
        progress_current=0,
        progress_total=max(int(progress_total or 0), 0),
    )
    with Session(engine) as session:
        session.add(task)
        session.commit()
        session.refresh(task)
    append_task_event(task.id, f"任务已创建: {task_type}", event_type="state")
    return serialize_task(task)


def get_active_proxy_check_task() -> Optional[dict[str, Any]]:
    with Session(engine) as session:
        task = session.exec(select(TaskModel)
            .where(TaskModel.type == TASK_TYPE_PROXY_CHECK)
            .where(TaskModel.status.in_([TASK_STATUS_PENDING, *ACTIVE_TASK_STATUSES]))
            .order_by(TaskModel.created_at.desc())).first()
        return serialize_task(task) if task else None


def create_proxy_check_task() -> dict[str, Any]:
    with _proxy_check_create_lock:
        existing = get_active_proxy_check_task()
        if existing:
            return existing
        return create_task(task_type=TASK_TYPE_PROXY_CHECK, platform="", payload={}, progress_total=0)


def create_register_task(payload: dict[str, Any]) -> dict[str, Any]:
    count = payload.get("count", 1)
    concurrency = payload.get("concurrency", 1)
    if isinstance(count, bool) or not isinstance(count, int) or count < 1:
        raise ValueError("批量数量必须是大于 0 的整数")
    if isinstance(concurrency, bool) or not isinstance(concurrency, int) or not 1 <= concurrency <= 5:
        raise ValueError("并发数量必须是 1 到 5 的整数")
    return create_task(
        task_type=TASK_TYPE_REGISTER,
        platform=str(payload.get("platform", "")),
        payload=payload,
        progress_total=count,
    )


def create_account_check_task(account_id: int) -> dict[str, Any]:
    platform = ""
    with Session(engine) as session:
        model = session.get(AccountModel, account_id)
        if model:
            platform = model.platform
    return create_task(
        task_type=TASK_TYPE_ACCOUNT_CHECK,
        platform=platform,
        payload={"account_id": int(account_id)},
        progress_total=1,
    )


def create_account_check_all_task(platform: str = "", limit: int | None = None) -> dict[str, Any]:
    limit = max(int(limit or 50), 1) if limit is not None else None
    with Session(engine) as session:
        query = select(func.count()).select_from(AccountModel)
        if platform:
            query = query.where(AccountModel.platform == platform)
        total = session.exec(query).one()
    return create_task(
        task_type=TASK_TYPE_ACCOUNT_CHECK_ALL,
        platform=platform,
        payload={"platform": platform, "limit": limit},
        progress_total=min(total, limit) if limit is not None else total,
    )


def _get_chatgpt_account_states(account_ids: list[int], *, strict: bool = True) -> dict:
    with Session(engine) as session:
        rows = session.exec(
            select(AccountModel.id, AccountModel.platform, AccountOverviewModel.lifecycle_status)
            .outerjoin(AccountOverviewModel, AccountOverviewModel.account_id == AccountModel.id)
            .where(AccountModel.id.in_(account_ids))
        ).all()
    states = {account_id: (platform, status) for account_id, platform, status in rows}
    if strict and any(account_id not in states or states[account_id][0] != "chatgpt" for account_id in account_ids):
        raise ValueError("所选账号不存在或不属于 ChatGPT")
    return states


def get_chatgpt_recovery_ids(account_ids: list[int], *, strict: bool = True) -> list[int]:
    states = _get_chatgpt_account_states(account_ids, strict=strict)
    return [account_id for account_id in account_ids
            if states.get(account_id, ("", ""))[0] == "chatgpt"
            and states[account_id][1] in {"phone_required", "2fa_required"}]


def get_chatgpt_refresh_ids(account_ids: list[int], *, strict: bool = True) -> list[int]:
    states = _get_chatgpt_account_states(account_ids, strict=strict)
    return [account_id for account_id in account_ids
            if states.get(account_id, ("", ""))[0] == "chatgpt"
            and states[account_id][1] not in {"phone_required", "2fa_required", "fraud_guard", "rate_limit_exceeded"}]


def create_platform_action_task(payload: dict[str, Any]) -> dict[str, Any]:
    result_seed = None
    if payload.get("platform") == "chatgpt" and payload.get("action_id") == "refresh_token" and "account_ids" in payload:
        result_seed = {"data": {"refreshed": [], "skipped": [], "failed": [],
                                "remaining": list(payload["account_ids"])}}
    return create_task(
        task_type=TASK_TYPE_PLATFORM_ACTION,
        platform=str(payload.get("platform", "")),
        payload=payload,
        progress_total=len(payload["account_ids"]) if "account_ids" in payload else 1,
        result_seed=result_seed,
    )


def get_task(task_id: str) -> Optional[dict[str, Any]]:
    with Session(engine) as session:
        task = session.get(TaskModel, task_id)
        return serialize_task(task) if task else None


def list_tasks(*, platform: str = "", status: str = "", page: int = 1, page_size: int = 50, task_type: str = "") -> dict[str, Any]:
    page = max(page, 1)
    page_size = min(max(page_size, 1), 200)
    with Session(engine) as session:
        q = select(TaskModel)
        total_q = select(func.count()).select_from(TaskModel)
        if platform:
            q = q.where(TaskModel.platform == platform)
            total_q = total_q.where(TaskModel.platform == platform)
        if task_type:
            q = q.where(TaskModel.type == task_type)
            total_q = total_q.where(TaskModel.type == task_type)
        statuses = list(dict.fromkeys(value.strip() for value in status.split(",") if value.strip()))
        if statuses:
            q = q.where(TaskModel.status.in_(statuses))
            total_q = total_q.where(TaskModel.status.in_(statuses))
            if len(statuses) > 1:
                q = q.order_by(case({value: index for index, value in enumerate(statuses)}, value=TaskModel.status))
        q = q.order_by(TaskModel.created_at.desc())
        total = int(session.exec(total_q).one() or 0)
        items = session.exec(q.offset((page - 1) * page_size).limit(page_size)).all()
    return {"total": total, "page": page, "items": [serialize_task(item) for item in items]}


def list_task_events(task_id: str, *, since: int = 0, limit: int = 200) -> list[dict[str, Any]]:
    limit = min(max(limit, 1), 500)
    with Session(engine) as session:
        q = (
            select(TaskEventModel)
            .where(TaskEventModel.task_id == task_id)
            .where(TaskEventModel.id > since)
            .order_by(TaskEventModel.id)
            .limit(limit)
        )
        items = session.exec(q).all()
    return [serialize_event(item) for item in items]


def append_task_event(task_id: str, message: str, *, event_type: str = "log", level: str = "info", detail: dict | None = None) -> dict[str, Any]:
    with Session(engine) as session:
        event = TaskEventModel(
            task_id=task_id,
            type=event_type,
            level=level,
            message=message,
            detail_json=_dump_json(detail or {}),
        )
        session.add(event)
        session.commit()
        session.refresh(event)
    return serialize_event(event)


def mark_incomplete_tasks_interrupted() -> None:
    with Session(engine) as session:
        non_terminal = [TASK_STATUS_PENDING] + list(ACTIVE_TASK_STATUSES)
        tasks = session.exec(
            select(TaskModel).where(TaskModel.status.in_(non_terminal))
        ).all()
        task_ids = [task.id for task in tasks]
        for task in tasks:
            task.status = TASK_STATUS_INTERRUPTED
            task.error = task.error or "任务在服务重启后被中断"
            task.finished_at = _utcnow()
            task.updated_at = _utcnow()
            session.add(task)
        session.commit()
    for task_id in task_ids:
        append_task_event(
            task_id,
            "任务在服务重启后被标记为中断",
            event_type="state",
            level="warning",
        )


def request_cancel(task_id: str) -> Optional[dict[str, Any]]:
    task = _mutate_task(
        task_id,
        lambda model: _request_cancel_mutation(model),
    )
    if not task:
        return None
    append_task_event(task_id, "已请求取消任务", event_type="state", level="warning")
    return serialize_task(task)


def _request_cancel_mutation(task: TaskModel) -> None:
    if task.status in TERMINAL_TASK_STATUSES:
        return
    if task.status == TASK_STATUS_PENDING:
        task.status = TASK_STATUS_CANCELLED
        task.finished_at = _utcnow()
        task.error = task.error or "任务在开始前被取消"
    else:
        task.status = TASK_STATUS_CANCEL_REQUESTED


def claim_next_runnable_task(
    *,
    running_platform_counts: dict[str, int] | None = None,
    busy_account_keys: set[str] | None = None,
    max_parallel_per_platform: int = 1,
) -> Optional[dict[str, Any]]:
    running_platform_counts = dict(running_platform_counts or {})
    busy_account_keys = set(busy_account_keys or set())
    with Session(engine) as session:
        tasks = session.exec(
            select(TaskModel)
            .where(TaskModel.status == TASK_STATUS_PENDING)
            .order_by(TaskModel.created_at)
        ).all()
        for task in tasks:
            payload = task.get_payload()
            platform = task.platform or str(payload.get("platform", "") or "")
            account_keys = _task_account_keys(task.type, payload)
            hold = _task_verification_hold(task.type, payload)
            if hold:
                result = task.get_result()
                result["verification_hold"] = hold
                task.set_result(result)
                session.add(task)
                session.commit()
                continue
            if platform and running_platform_counts.get(platform, 0) >= max_parallel_per_platform:
                continue
            if account_keys and busy_account_keys.intersection(account_keys):
                continue
            result = task.get_result()
            result.pop("verification_hold", None)
            with _task_lock(task.id):
                claimed = session.execute(
                    update(TaskModel)
                    .where(TaskModel.id == task.id, TaskModel.status == TASK_STATUS_PENDING)
                    .values(status=TASK_STATUS_CLAIMED, result_json=_dump_json(result),
                            started_at=task.started_at or _utcnow(), updated_at=_utcnow())
                    .execution_options(synchronize_session=False)
                )
                session.commit()
            if claimed.rowcount == 1:
                return {"id": task.id, "platform": platform, "account_keys": account_keys}
    return None


class TaskLogger:
    def __init__(self, task_id: str):
        self.task_id = task_id

    def log(self, message: str, *, level: str = "info", event_type: str = "log", detail: dict | None = None) -> None:
        append_task_event(
            self.task_id,
            message,
            event_type=event_type,
            level=level,
            detail=detail,
        )
        # Console output must not interrupt the task after its event is saved.
        try:
            print(f"[task:{self.task_id}] {message}")
        except (UnicodeEncodeError, OSError):
            pass

    def private_log(self, message: str) -> None:
        """Expose only literal startup stages; retain bound task cancellation ownership."""
        if message in {
            "  OAuth startup: starting Camoufox",
            "  OAuth startup: creating page",
            "  OAuth startup: restoring saved cookies",
            "  OAuth startup: reading cookies",
            "  OAuth startup: ready",
        }:
            self.log(message)

    def mark_running(self) -> None:
        def _update(task: TaskModel) -> None:
            if task.status not in TERMINAL_TASK_STATUSES and task.status != TASK_STATUS_CANCEL_REQUESTED:
                task.status = TASK_STATUS_RUNNING
            task.started_at = task.started_at or _utcnow()

        _mutate_task(self.task_id, _update)
        self.log("任务已开始执行", event_type="state")

    def is_cancel_requested(self) -> bool:
        with Session(engine) as session:
            task = session.get(TaskModel, self.task_id)
            return bool(task and task.status in {TASK_STATUS_CANCEL_REQUESTED, TASK_STATUS_CANCELLED})

    def set_progress(self, current: int, total: Optional[int] = None) -> None:
        current = max(int(current), 0)

        def _update(task: TaskModel) -> None:
            task.progress_current = current
            if total is not None:
                task.progress_total = max(int(total), 0)

        _mutate_task(self.task_id, _update)

    def record_success(self) -> None:
        def _update(task: TaskModel) -> None:
            task.success_count += 1

        _mutate_task(self.task_id, _update)

    def record_error(self, error: str) -> None:
        def _update(task: TaskModel) -> None:
            task.error_count += 1
            result = task.get_result()
            errors = list(result.get("errors", []))
            errors.append(error)
            result["errors"] = errors
            task.set_result(result)

        _mutate_task(self.task_id, _update)

    def add_cashier_url(self, url: str) -> None:
        def _update(task: TaskModel) -> None:
            result = task.get_result()
            urls = list(result.get("cashier_urls", []))
            urls.append(url)
            result["cashier_urls"] = urls
            task.set_result(result)

        _mutate_task(self.task_id, _update)

    def set_result_data(self, data: Any) -> None:
        def _update(task: TaskModel) -> None:
            result = task.get_result()
            result["data"] = data
            task.set_result(result)

        _mutate_task(self.task_id, _update)

    def pause_verification_hold(self, hold) -> None:
        def _update(task: TaskModel) -> None:
            result = task.get_result()
            result["verification_hold"] = hold
            task.set_result(result)
        _mutate_task(self.task_id, _update)
        self.log("手机验证请求过多，执行已暂停；账号及会话已保存，需要手动恢复当前账号", level="warning", event_type="state")
        self.finish(TASK_STATUS_PAUSED, error="verification_hold: Too many phone verification requests")

    def finish(self, status: str, *, error: str = "") -> None:
        def _update(task: TaskModel) -> None:
            task.status = status
            task.finished_at = _utcnow()
            if error:
                task.error = error

        message = f"任务结束: {status}"
        event_level = "error" if status == TASK_STATUS_FAILED else ("warning" if status in {TASK_STATUS_INTERRUPTED, TASK_STATUS_CANCELLED, TASK_STATUS_PAUSED} else "info")
        event = TaskEventModel(task_id=self.task_id, type="state", level=event_level,
                               message=message, detail_json=_dump_json({"status": status, "error": error}))
        if _mutate_task(self.task_id, _update, event=event):
            try:
                print(f"[task:{self.task_id}] {message}")
            except (UnicodeEncodeError, OSError):
                pass


def _auto_push_any2api(task_logger: TaskLogger, account) -> None:
    """注册成功后自动推送账号到 Any2API（如果已配置）。"""
    try:
        from core.any2api_sync import push_account_to_any2api
        push_account_to_any2api(account, log_fn=task_logger.log)
    except Exception as exc:
        task_logger.log(f"  [Any2API] 自动推送异常: {exc}", level="warning")


def _auto_upload_cpa(task_logger: TaskLogger, account) -> None:
    if getattr(account, "platform", "") != "chatgpt":
        return
    try:
        from core.config_store import config_store

        cpa_url = config_store.get("cpa_api_url", "")
        if cpa_url:
            from platforms.chatgpt.cpa_upload import generate_token_json, upload_to_cpa

            class _AccountProxy:
                pass

            target = _AccountProxy()
            target.email = account.email
            extra = account.extra or {}
            target.access_token = extra.get("access_token") or account.token
            target.refresh_token = extra.get("refresh_token", "")
            target.id_token = extra.get("id_token", "")
            target.session_token = extra.get("session_token", "")
            target.user_id = account.user_id or ""
            target.account_id = account.user_id or ""
            target.cookies = extra.get("cookies", "")

            token_data = generate_token_json(target)
            ok, msg = upload_to_cpa(token_data)
            task_logger.log(f"  [CPA] {'✓ ' + msg if ok else '✗ ' + msg}")
    except Exception as exc:
        task_logger.log(f"  [CPA] 自动上传异常: {exc}", level="warning")


def _build_platform_instance(platform_name: str, payload: dict[str, Any], logger: TaskLogger, resolved_proxy: str | None = None, shared_mailbox=None):
    from core.base_identity import normalize_identity_provider
    from core.base_mailbox import create_mailbox

    executor_type = str(payload.get("executor_type", "protocol") or "protocol")
    captcha_solver = str(payload.get("captcha_solver", "auto") or "auto")
    extra = dict(payload.get("extra") or {})
    config = RegisterConfig(
        executor_type=executor_type,
        captcha_solver=captcha_solver,
        proxy=resolved_proxy,
        extra=extra,
    )
    identity_provider = normalize_identity_provider(extra.get("identity_provider", "mailbox"))
    mailbox = shared_mailbox
    if mailbox is None and identity_provider == "mailbox":
        if not extra.get("mail_provider"):
            from infrastructure.provider_settings_repository import ProviderSettingsRepository

            extra["mail_provider"] = ProviderSettingsRepository().get_default_provider_key("mailbox")
        mailbox = create_mailbox(
            provider=extra.get("mail_provider", ""),
            extra=extra,
            proxy=resolved_proxy,
        )

    platform_cls = get(platform_name)
    platform = platform_cls(config=config, mailbox=mailbox)
    if hasattr(platform, "set_logger"):
        platform.set_logger(logger.log)
    else:
        platform._log_fn = logger.log
    return platform


def _run_single_account_check(account_id: int, logger: TaskLogger | None = None) -> tuple[bool, dict[str, Any]]:
    with Session(engine) as session:
        model = session.get(AccountModel, account_id)
        if not model:
            raise ValueError("账号不存在")
        plugin = get(model.platform)(config=RegisterConfig())
        account = build_platform_account(session, model)

    valid = plugin.check_valid(account)
    with Session(engine) as session:
        model = session.get(AccountModel, account_id)
        if model:
            model.updated_at = _utcnow()
            current_graph = load_account_graphs(session, [account_id]).get(account_id, {})
            summary_updates = {"checked_at": _utcnow_iso(), "valid": bool(valid)}
            if hasattr(plugin, "get_last_check_overview"):
                summary_updates.update(plugin.get_last_check_overview() or {})
            lifecycle_status = None
            if valid:
                lifecycle_status = recover_lifecycle_status_for_valid_account(current_graph)
            patch_account_graph(
                session,
                model,
                lifecycle_status=lifecycle_status,
                summary_updates=summary_updates,
            )
            session.add(model)
            session.commit()

    result = {"account_id": account_id, "valid": bool(valid), "platform": account.platform, "email": account.email}
    if logger:
        logger.log(f"{account.email}: {'有效' if valid else '失效'}")
    return valid, result


def execute_task(task_id: str) -> None:
    with Session(engine) as session:
        task = session.get(TaskModel, task_id)
        if not task or task.status in TERMINAL_TASK_STATUSES:
            return
        task_type = task.type
        payload = task.get_payload()

    logger = TaskLogger(task_id)
    logger.mark_running()

    if logger.is_cancel_requested():
        logger.finish(TASK_STATUS_CANCELLED, error="任务在启动后立即被取消")
        return

    handlers: dict[str, Callable[[dict[str, Any], TaskLogger], None]] = {
        TASK_TYPE_REGISTER: _execute_register_task,
        TASK_TYPE_ACCOUNT_CHECK: _execute_account_check_task,
        TASK_TYPE_ACCOUNT_CHECK_ALL: _execute_account_check_all_task,
        TASK_TYPE_PLATFORM_ACTION: _execute_platform_action_task,
        TASK_TYPE_PROXY_CHECK: _execute_proxy_check_task,
    }
    handler = handlers.get(task_type)
    if not handler:
        logger.finish(TASK_STATUS_FAILED, error=f"未知任务类型: {task_type}")
        return
    try:
        hold = _task_verification_hold(task_type, payload)
        if hold:
            logger.pause_verification_hold(hold)
            return
        handler(payload, logger)
    except Exception as exc:
        if logger.is_cancel_requested():
            logger.finish(TASK_STATUS_CANCELLED, error="任务已取消")
        else:
            error = str(exc)
            logger.record_error(error)
            logger.log(f"任务执行异常: {error}", level="error")
            logger.finish(TASK_STATUS_FAILED, error=error)


def _resolve_sms_provider_for_task(extra: dict[str, Any]) -> tuple[str, dict[str, Any]]:
    from infrastructure.provider_definitions_repository import ProviderDefinitionsRepository
    from infrastructure.provider_settings_repository import ProviderSettingsRepository

    settings_repo = ProviderSettingsRepository()
    definitions_repo = ProviderDefinitionsRepository()
    provider_key = str(
        extra.get("sms_provider")
        or extra.get("phone_provider")
        or settings_repo.get_default_provider_key("sms")
        or ""
    ).strip()
    if not provider_key:
        provider_key = "sms_activate" if extra.get("sms_activate_api_key") else ""
    definition = definitions_repo.get_by_key("sms", provider_key) if provider_key else None
    settings = settings_repo.resolve_runtime_settings("sms", provider_key, extra) if definition else dict(extra)
    return provider_key, settings


def _bool_config(value: Any, default: bool) -> bool:
    if value in (None, ""):
        return default
    if isinstance(value, bool):
        return value
    return str(value).strip().lower() not in {"0", "false", "no", "off", "否"}


def _int_config(value: Any, default: int) -> int:
    try:
        return int(value)
    except (TypeError, ValueError):
        return default


def _auto_followup_windsurf_payment(
    *,
    saved_account: AccountModel,
    platform_name: str,
    payload: dict[str, Any],
    platform,
    account,
    logger: "TaskLogger",
) -> None:
    if platform_name != "windsurf":
        return
    executor_type = str(payload.get("executor_type", "") or "").strip()
    use_browser = executor_type in {"headless", "headed"}
    if not use_browser:
        extra_cfg = dict(payload.get("extra") or {})
        if not _bool_config(extra_cfg.get("auto_payment_link"), True):
            return
    if not str(getattr(account, "password", "") or "").strip() and use_browser:
        logger.log("Windsurf 注册后自动升级已跳过: 账号缺少密码", level="error")
        return
    extra = dict(payload.get("extra") or {})
    turnstile_token = str(extra.get("turnstile_token") or "").strip()
    if use_browser:
        action_id = "generate_link_browser"
        params = {
            "timeout": _int_config(extra.get("windsurf_payment_timeout"), 240),
            "headless": "true" if _bool_config(extra.get("windsurf_payment_headless"), False) else "false",
            "payment_channel": "checkout",
        }
        if turnstile_token:
            params["turnstile_token"] = turnstile_token
    else:
        action_id = "generate_link"
        params = {}
        if turnstile_token:
            params["turnstile_token"] = turnstile_token
    logger.log("注册成功，开始自动生成 Windsurf Pro Trial Stripe 链接")
    try:
        result = platform.execute_action(action_id, account, params)
    except Exception as exc:
        message = f"Windsurf 注册后自动升级失败: {exc}"
        logger.record_error(message)
        logger.log(message, level="error")
        return
    if not result.get("ok"):
        message = f"Windsurf 注册后自动升级失败: {result.get('error') or 'unknown error'}"
        logger.record_error(message)
        logger.log(message, level="error")
        return
    data = dict(result.get("data") or {})
    cashier_url = str(data.get("cashier_url") or data.get("url") or "").strip()
    if data:
        with Session(engine) as session:
            locked = session.exec(
                update(AccountModel)
                .where(AccountModel.id == saved_account.id,
                       AccountModel.platform == saved_account.platform,
                       AccountModel.email == saved_account.email,
                       AccountModel.user_id == saved_account.user_id)
                .values(updated_at=_utcnow())
            )
            if locked.rowcount != 1:
                raise ValueError("原注册账号已删除或身份已改变，后续结果未保存")
            model = session.get(AccountModel, saved_account.id)
            patch_account_graph(
                session, model,
                credential_updates={key: value for key, value in data.items()
                                    if key in PERSISTED_ACTION_DATA_KEYS and value not in (None, "")},
                summary_updates={key: value for key, value in data.items()
                                 if key not in PERSISTED_ACTION_DATA_KEYS},
                cashier_url=cashier_url or None,
            )
            session.add(model)
            session.commit()
        account.extra = {**dict(getattr(account, "extra", {}) or {}), **data}
    if cashier_url:
        logger.log(f"Windsurf 自动升级链接已生成: {cashier_url}")
        logger.add_cashier_url(cashier_url)


def _execute_register_task(payload: dict[str, Any], logger: TaskLogger) -> None:
    from core.proxy_pool import proxy_pool

    count = max(int(payload.get("count", 1) or 1), 1)
    concurrency = min(max(int(payload.get("concurrency", 1) or 1), 1), count, 5)
    platform_name = str(payload.get("platform", ""))
    email = payload.get("email") or None
    password = payload.get("password") or None
    proxy = payload.get("proxy") or None
    extra = dict(payload.get("extra") or {})
    sms_provider_key, sms_settings = _resolve_sms_provider_for_task(extra)
    herosms_enabled = sms_provider_key in {"herosms", "herosms_api"} and bool(str(sms_settings.get("herosms_api_key") or "").strip())
    hero_extra_max = max(_int_config(sms_settings.get("register_phone_extra_max"), 3), 0) if herosms_enabled else 0
    hero_reuse_to_max = _bool_config(sms_settings.get("register_reuse_phone_to_max"), True) if herosms_enabled else False
    target_success = count
    max_success = count + hero_extra_max if herosms_enabled and hero_reuse_to_max and platform_name != "chatgpt" else count
    progress_total = max_success if herosms_enabled else count

    logger.set_progress(0, progress_total)
    if herosms_enabled and platform_name == "chatgpt":
        logger.log(f"ChatGPT 模式: 仅执行原计划 {count} 个账号，受限账号保留，不补建替代账号")
    elif herosms_enabled:
        logger.log(
            f"HeroSMS 模式: 成功目标 {target_success}，失败自动补尝试，"
            f"号码仍可复用时最多额外成功 {hero_extra_max} 个"
        )

    try:
        get(platform_name)
    except Exception as exc:
        logger.log(f"致命错误: {exc}", level="error")
        logger.finish(TASK_STATUS_FAILED, error=str(exc))
        return

    success = 0
    errors: list[str] = []
    blocked_stop = Event()

    # Pre-create a shared mailbox instance for the entire task to avoid
    # concurrent initialization issues (e.g. MoeMail auto-registering
    # multiple provider accounts simultaneously).
    shared_mailbox = None
    try:
        from core.base_identity import normalize_identity_provider
        from core.base_mailbox import create_mailbox

        identity_provider = normalize_identity_provider(extra.get("identity_provider", "mailbox"))
        if identity_provider == "mailbox":
            if not extra.get("mail_provider"):
                from infrastructure.provider_settings_repository import ProviderSettingsRepository
                extra["mail_provider"] = ProviderSettingsRepository().get_default_provider_key("mailbox")
            shared_mailbox = create_mailbox(
                provider=extra.get("mail_provider", ""),
                extra=extra,
                proxy=proxy or proxy_pool.get_next(),
            )
    except Exception as exc:
        logger.record_error(f"邮箱初始化失败: {exc}")
        logger.log(f"邮箱初始化失败: {exc}", level="error")
        logger.finish(TASK_STATUS_FAILED, error=f"邮箱初始化失败: {exc}")
        return

    def _do_one(index: int) -> bool | str:
        if blocked_stop.is_set():
            return "__blocked_stop__"
        if platform_name == "chatgpt" and get_verification_hold():
            return "__verification_hold__"
        if logger.is_cancel_requested():
            return "__cancel_requested__"
        resolved_proxy = None

        try:
            resolved_proxy = proxy or proxy_pool.get_next()
            platform = _build_platform_instance(platform_name, payload, logger, resolved_proxy=resolved_proxy, shared_mailbox=shared_mailbox)
            logger.log(f"开始注册第 {index + 1}/{count} 个账号")
            if resolved_proxy:
                logger.log(f"使用代理: {resolved_proxy}")
            account = platform.register(email=email, password=password)
            registration_account_id = getattr(platform, "_local_account_id", None)
            if registration_account_id is None:
                saved_account = save_account(account)
            else:
                saved_account = save_account(account, account_id=registration_account_id)
            if logger.is_cancel_requested():
                return "__cancel_requested__"
            if account.status in {AccountStatus.PHONE_REQUIRED, AccountStatus.TWO_FA_REQUIRED,
                                   AccountStatus.FRAUD_GUARD, AccountStatus.RATE_LIMITED}:
                if platform_name == "chatgpt" and (
                    account.status in {AccountStatus.RATE_LIMITED, AccountStatus.FRAUD_GUARD} or
                    account.extra.get("rental_cleanup_confirmed") is False or
                    (account.status == AccountStatus.FRAUD_GUARD and
                     account.extra.get("rental_cleanup_confirmed") is not True)
                ):
                    blocked_stop.set()
                if resolved_proxy:
                    proxy_pool.report_success(resolved_proxy)
                message = f"{account.status.value}: {account.email}"
                logger.record_error(message)
                logger.log(message, level="warning")
                _save_task_log(platform_name, account.email, "pending", error=message)
                return message
            _auto_followup_windsurf_payment(
                saved_account=saved_account,
                platform_name=platform_name,
                payload=payload,
                platform=platform,
                account=account,
                logger=logger,
            )
            if logger.is_cancel_requested():
                return "__cancel_requested__"
            if resolved_proxy:
                proxy_pool.report_success(resolved_proxy)
            logger.record_success()
            logger.log(f"✓ 注册成功: {account.email}")
            _save_task_log(platform_name, account.email, "success")
            if logger.is_cancel_requested():
                return "__cancel_requested__"
            _auto_upload_cpa(logger, account)
            if logger.is_cancel_requested():
                return "__cancel_requested__"
            _auto_push_any2api(logger, account)
            extra = dict(account.extra or {})
            overview = dict(extra.get("account_overview") or {})
            cashier_url = str(extra.get("cashier_url") or overview.get("cashier_url") or "")
            if cashier_url:
                logger.log(f"  [升级链接] {cashier_url}")
                logger.add_cashier_url(cashier_url)
            return True
        except Exception as exc:
            if resolved_proxy:
                proxy_pool.report_fail(resolved_proxy)
            error = str(exc)
            if platform_name == "chatgpt" and (
                getattr(exc, "rental_cleanup_confirmed", None) is False or
                any(marker in error.casefold() for marker in (
                    "phone_cleanup_pending", "rate_limit_exceeded", "fraud_guard",
                    "account_deactivated", "human_verification", "browser check did not clear", "about_you_rejected",
                ))
            ):
                blocked_stop.set()
            logger.record_error(error)
            logger.log(f"✗ 注册失败: {error}", level="error")
            _save_task_log(platform_name, email or "", "failed", error=error)
            return error

    try:
        submitted = 0
        completed = 0
        futures: dict[Any, int] = {}
        max_attempts = max(count if platform_name == "chatgpt" or not herosms_enabled else max_success * 3, 1)

        def _hero_phone_alive() -> bool:
            if not (herosms_enabled and hero_reuse_to_max):
                return False
            try:
                from core.base_sms import is_herosms_phone_cache_alive
                alive, info = is_herosms_phone_cache_alive(sms_settings)
                if alive:
                    logger.log(
                        "HeroSMS 号码仍可复用: "
                        f"{str(info.get('phone_number') or '')[:5]}**** "
                        f"剩余 {int(info.get('remaining_seconds') or 0)} 秒，"
                        f"已成功 {int(info.get('use_count') or 0)} 次"
                    )
                return bool(alive)
            except Exception:
                return False

        def _should_submit_more() -> bool:
            if platform_name == "chatgpt" and get_verification_hold():
                return False
            if submitted >= max_attempts or logger.is_cancel_requested() or blocked_stop.is_set():
                return False
            if platform_name == "chatgpt" or not herosms_enabled:
                return submitted < count
            if success + len(futures) >= max_success:
                return False
            if success < target_success:
                return True
            if success >= max_success:
                return False
            return _hero_phone_alive()

        with ThreadPoolExecutor(max_workers=concurrency) as pool:
            while _should_submit_more() and len(futures) < concurrency:
                futures[pool.submit(_do_one, submitted)] = submitted
                submitted += 1

            while futures:
                done, _ = wait(set(futures.keys()), return_when=FIRST_COMPLETED)
                for future in done:
                    futures.pop(future, None)
                    result = future.result()
                    if result == "__blocked_stop__":
                        continue
                    completed += 1
                    if result is True:
                        success += 1
                    elif result not in {"__cancel_requested__", "__verification_hold__"}:
                        errors.append(str(result))
                    logger.set_progress(min(success if herosms_enabled and platform_name != "chatgpt" else completed, progress_total), progress_total)
                while _should_submit_more() and len(futures) < concurrency:
                    futures[pool.submit(_do_one, submitted)] = submitted
                    submitted += 1
                if logger.is_cancel_requested() and not futures:
                    break
    except Exception as exc:
        logger.log(f"致命错误: {exc}", level="error")
        logger.finish(TASK_STATUS_FAILED, error=str(exc))
        return

    if herosms_enabled:
        logger.set_result_data({
            "target_count": target_success,
            "attempts": submitted,
            "success": success,
            "fail": len(errors),
            "extra_success": max(0, success - target_success),
            "hero_sms_reuse": True,
        })
    hold = get_verification_hold() if platform_name == "chatgpt" else None
    if hold:
        logger.pause_verification_hold(hold)
        return
    summary = f"完成: 成功 {success} 个, 失败 {len(errors)} 个"
    logger.log(summary, event_type="summary")
    if logger.is_cancel_requested():
        logger.finish(TASK_STATUS_CANCELLED, error="任务已取消")
        return
    if blocked_stop.is_set():
        logger.finish(TASK_STATUS_PAUSED, error="验证限制或租号清理未确认，保留账号并暂停后续尝试")
        return
    final_status = TASK_STATUS_FAILED if errors and success == 0 else TASK_STATUS_SUCCEEDED
    final_error = "" if final_status == TASK_STATUS_SUCCEEDED else errors[0]
    logger.finish(final_status, error=final_error)


def _execute_bulk_recovery_task(payload: dict[str, Any], logger: TaskLogger) -> None:
    account_ids = list(payload.get("account_ids") or [])
    if payload.get("platform") != "chatgpt" or payload.get("action_id") != "complete_registration" or not account_ids:
        logger.finish(TASK_STATUS_FAILED, error="无效的批量恢复任务")
        return
    runtime = PlatformRuntime()
    summary: dict[str, list[int]] = {"recovered": [], "skipped": [], "failed": []}
    logger.set_progress(0, len(account_ids))
    for index, account_id in enumerate(account_ids, 1):
        hold = get_verification_hold()
        if hold:
            logger.set_result_data(summary)
            logger.pause_verification_hold(hold)
            return
        if logger.is_cancel_requested():
            logger.finish(TASK_STATUS_CANCELLED, error="任务已取消")
            return
        if not get_chatgpt_recovery_ids([account_id], strict=False):
            summary["skipped"].append(account_id)
            logger.log(f"账号 {account_id} 已不在待恢复状态，跳过")
        else:
            logger.log(f"开始恢复账号 {account_id} ({index}/{len(account_ids)})")
            try:
                result = runtime.execute_action(
                    ActionExecutionCommand("chatgpt", account_id, "complete_registration", dict(payload.get("params") or {})),
                    log_fn=logger.log,
                )
            except Exception as exc:
                result = ActionExecutionResult(ok=False, error=str(exc))
            if result.ok:
                summary["recovered"].append(account_id)
                logger.record_success()
            else:
                summary["failed"].append(account_id)
                error = result.error or "验证尚未完成，账号保留待恢复状态"
                logger.record_error(f"账号 {account_id}: {error}")
                logger.log(f"账号 {account_id}: {error}", level="error")
                data = result.data if isinstance(result.data, dict) else {}
                hold = data.get("verification_hold") or get_verification_hold()
                if hold:
                    logger.set_result_data(summary)
                    logger.set_progress(index, len(account_ids))
                    logger.pause_verification_hold(hold)
                    return
                blocker = str(error).casefold() + " " + str(data.get("error_type") or "").casefold()
                if data.get("requires_user_action") or any(token in blocker for token in (
                    "fraud_guard", "captcha", "security warning", "security_warning",
                    "challenge_required", "whatsapp", "user action", "需要人工", "安全警告", "人机验证",
                    "phone_cleanup_pending", "cancellation is pending", "cancellation_pending", "号码取消未确认",
                )):
                    logger.set_result_data(summary)
                    logger.set_progress(index, len(account_ids))
                    logger.log("批量恢复已停止，需要处理当前账号的验证限制", level="warning")
                    logger.finish(TASK_STATUS_FAILED, error=error)
                    return
        logger.set_result_data(summary)
        logger.set_progress(index, len(account_ids))
    if logger.is_cancel_requested():
        logger.finish(TASK_STATUS_CANCELLED, error="任务已取消")
    else:
        logger.finish(TASK_STATUS_FAILED if summary["failed"] else TASK_STATUS_SUCCEEDED)


def _execute_bulk_refresh_task(payload: dict[str, Any], logger: TaskLogger) -> None:
    account_ids = list(payload.get("account_ids") or [])
    if payload.get("platform") != "chatgpt" or payload.get("action_id") != "refresh_token" or not account_ids:
        logger.finish(TASK_STATUS_FAILED, error="无效的批量刷新 Token 任务")
        return
    runtime = PlatformRuntime()
    summary: dict[str, list[int]] = {"refreshed": [], "skipped": [], "failed": [], "remaining": account_ids[:]}
    logger.set_result_data(summary)
    logger.set_progress(0, len(account_ids))
    for index, account_id in enumerate(account_ids, 1):
        if logger.is_cancel_requested():
            logger.finish(TASK_STATUS_CANCELLED, error="任务已取消")
            return
        if not get_chatgpt_refresh_ids([account_id], strict=False):
            summary["skipped"].append(account_id)
            logger.log(f"账号 {account_id} 不适用 Token 刷新，跳过")
        else:
            logger.log(f"开始刷新账号 {account_id} ({index}/{len(account_ids)})")
            try:
                # Raw runtime messages/data can contain credentials; allow only fixed safe stages.
                result = runtime.execute_action(
                    ActionExecutionCommand("chatgpt", account_id, "refresh_token", dict(payload.get("params") or {})),
                    log_fn=logger.private_log,
                )
            except Exception as exc:
                result = ActionExecutionResult(ok=False, error=str(exc))
            data = result.data if isinstance(result.data, dict) else {}
            blocker = str(result.error or "").casefold() + " " + str(data.get("error_type") or "").casefold()
            requires_action = bool(data.get("verification_hold") or data.get("requires_user_action") or any(
                token in blocker for token in (
                    "fraud_guard", "captcha", "security warning", "security_warning",
                    "challenge", "verification", "phone_required", "2fa_required", "mfa_required",
                    "rate_limit_exceeded", "whatsapp", "user action", "需要人工", "安全警告", "人机验证",
                    "phone_cleanup_pending", "cancellation is pending", "cancellation_pending", "号码取消未确认",
                )
            ))
            account_only_verification = (
                data.get("error_type") in {"phone_required", "2fa_required", "mfa_required"}
                or "原账号需要手机号验证" in blocker
                or "原账号需要完成注册或手机验证" in blocker
            ) and not (data.get("verification_hold") or any(
                token in blocker for token in (
                    "fraud_guard", "captcha", "security", "challenge", "browser check",
                    "rate_limit", "account_deactivated", "verification_hold", "whatsapp",
                    "phone_cleanup_pending", "cancellation", "安全", "人机", "号码取消未确认",
                )
            ))
            if result.ok and not requires_action:
                summary["refreshed"].append(account_id)
                logger.record_success()
                logger.log(f"账号 {account_id} Token 已刷新")
            else:
                summary["failed"].append(account_id)
                error = f"账号 {account_id}: " + ("Token 刷新需要人工处理验证限制" if requires_action else "Token 刷新失败")
                logger.record_error(error)
                logger.log(error, level="error")
            summary["remaining"] = account_ids[index:]
            logger.set_result_data(summary)
            logger.set_progress(index, len(account_ids))
            if logger.is_cancel_requested():
                logger.finish(TASK_STATUS_CANCELLED, error="任务已取消")
                return
            if requires_action and not account_only_verification:
                logger.log("批量刷新已停止，剩余账号未执行；请先处理当前账号验证限制", level="warning")
                logger.finish(TASK_STATUS_FAILED, error=error)
                return
        summary["remaining"] = account_ids[index:]
        logger.set_result_data(summary)
        logger.set_progress(index, len(account_ids))
    if logger.is_cancel_requested():
        logger.finish(TASK_STATUS_CANCELLED, error="任务已取消")
    else:
        logger.finish(TASK_STATUS_FAILED if summary["failed"] else TASK_STATUS_SUCCEEDED)


def _execute_platform_action_task(payload: dict[str, Any], logger: TaskLogger) -> None:
    if "account_ids" in payload:
        if payload.get("action_id") == "refresh_token":
            _execute_bulk_refresh_task(payload, logger)
        else:
            _execute_bulk_recovery_task(payload, logger)
        return
    command_platform = str(payload.get("platform", ""))
    account_id = int(payload.get("account_id", 0) or 0)
    action_id = str(payload.get("action_id", ""))
    params = dict(payload.get("params") or {})
    runtime = PlatformRuntime()
    result = runtime.execute_action(
        type("Command", (), {
            "platform": command_platform,
            "account_id": account_id,
            "action_id": action_id,
            "params": params,
        })(),
        log_fn=logger.log,
    )
    logger.set_progress(1, 1)
    if logger.is_cancel_requested():
        logger.finish(TASK_STATUS_CANCELLED, error="任务已取消")
        return
    if command_platform == "chatgpt" and action_id == "complete_registration":
        hold = (result.data or {}).get("verification_hold") if isinstance(result.data, dict) else None
        hold = hold or get_verification_hold()
        if hold:
            logger.set_result_data(result.data)
            if not result.ok:
                logger.record_error(result.error)
            logger.pause_verification_hold(hold)
            return
    if not result.ok:
        logger.record_error(result.error)
        logger.finish(TASK_STATUS_FAILED, error=result.error)
        return
    logger.record_success()
    logger.set_result_data(result.data)
    message = ""
    if isinstance(result.data, dict):
        message = str(result.data.get("message", "") or "")
    if message:
        logger.log(message, event_type="summary")
    logger.finish(TASK_STATUS_SUCCEEDED)


def _execute_proxy_check_task(payload: dict[str, Any], logger: TaskLogger) -> None:
    from core.proxy_pool import proxy_pool

    def progress(current: int, total: int, results: dict) -> None:
        def update(task: TaskModel) -> None:
            task.progress_current = current
            task.progress_total = total
            task.success_count = results["ok"]
            task.error_count = results["fail"]
            result = task.get_result()
            result["data"] = dict(results)
            task.set_result(result)
        _mutate_task(logger.task_id, update)
        logger.log(f"代理检测 {current}/{total}：成功 {results['ok']}，不可用 {results['fail']}")

    try:
        proxy_pool.check_all(cancelled=logger.is_cancel_requested, progress=progress)
    except Exception:
        raise RuntimeError("代理检测失败，请检查代理池或服务状态") from None
    logger.finish(TASK_STATUS_CANCELLED if logger.is_cancel_requested() else TASK_STATUS_SUCCEEDED)


def _execute_account_check_task(payload: dict[str, Any], logger: TaskLogger) -> None:
    account_id = int(payload.get("account_id", 0) or 0)
    if account_id <= 0:
        logger.finish(TASK_STATUS_FAILED, error="缺少 account_id")
        return
    try:
        _, result = _run_single_account_check(account_id, logger)
        logger.set_result_data(result)
        logger.set_progress(1, 1)
        logger.finish(TASK_STATUS_SUCCEEDED)
    except Exception as exc:
        logger.record_error(str(exc))
        logger.finish(TASK_STATUS_FAILED, error=str(exc))


def _execute_account_check_all_task(payload: dict[str, Any], logger: TaskLogger) -> None:
    platform = str(payload.get("platform", "") or "")
    limit = payload.get("limit")

    with Session(engine) as session:
        q = select(AccountModel)
        if platform:
            q = q.where(AccountModel.platform == platform)
        q = q.order_by(AccountModel.created_at.desc(), AccountModel.id.desc())
        if limit is not None:
            q = q.limit(max(int(limit or 50), 1))
        accounts = session.exec(q).all()

    total = len(accounts)
    logger.set_progress(0, total)
    if total == 0:
        logger.set_result_data({"valid": 0, "invalid": 0, "error": 0})
        logger.finish(TASK_STATUS_SUCCEEDED)
        return

    results = {"valid": 0, "invalid": 0, "error": 0}
    completed = 0
    for model in accounts:
        if logger.is_cancel_requested():
            logger.finish(TASK_STATUS_CANCELLED, error="任务已取消")
            return
        try:
            valid, _ = _run_single_account_check(int(model.id or 0), logger)
            if valid:
                results["valid"] += 1
            else:
                results["invalid"] += 1
        except Exception as exc:
            results["error"] += 1
            logger.record_error(str(exc))
            logger.log(f"{model.email}: 检测异常 {exc}", level="error")
        completed += 1
        logger.set_progress(completed, total)
    logger.set_result_data(results)
    logger.finish(TASK_STATUS_SUCCEEDED)
