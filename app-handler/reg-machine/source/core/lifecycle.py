"""账号生命周期管理 — 定时检测、自动续期、过期预警。"""
from __future__ import annotations

import logging
import threading
import time
from datetime import datetime, timezone
from typing import Any
from types import SimpleNamespace

from sqlmodel import Session, select

from core.account_graph import load_account_graphs, patch_account_graph
from core.base_platform import AccountStatus, RegisterConfig
from core.db import AccountModel, AccountOverviewModel, engine
from core.platform_accounts import build_platform_account, build_platform_extra
from core.registry import get

logger = logging.getLogger(__name__)


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


def _utcnow_iso() -> str:
    return _utcnow().isoformat().replace("+00:00", "Z")


def _utcnow_ts() -> int:
    return int(_utcnow().timestamp())


# ---------------------------------------------------------------------------
# Account validity check
# ---------------------------------------------------------------------------

def check_accounts_validity(*, platform: str = "", limit: int = 100, log_fn=None) -> dict[str, int]:
    """Check active accounts; unknown results count as errors, not invalid accounts."""
    from platforms.chatgpt.token_refresh import _account_refresh_restriction
    log = log_fn or logger.info
    active_statuses = {"registered", "trial", "subscribed"}
    with Session(engine) as session:
        query = select(AccountModel)
        if platform:
            query = query.where(AccountModel.platform == platform)
        accounts = session.exec(query.order_by(AccountModel.created_at.desc(), AccountModel.id.desc()).limit(limit)).all()
        graphs = load_account_graphs(session, [int(account.id) for account in accounts if account.id])
    targets = [account for account in accounts
               if graphs.get(int(account.id or 0), {}).get("lifecycle_status") in active_statuses]
    results = {"valid": 0, "invalid": 0, "error": 0, "skipped": len(accounts) - len(targets)}
    for account in targets:
        identity = (account.platform, account.email, account.user_id)
        try:
            plugin = get(account.platform)(config=RegisterConfig())
            with Session(engine) as session:
                current = session.get(AccountModel, account.id)
                if not current or (current.platform, current.email, current.user_id) != identity:
                    results["skipped"] += 1
                    continue
                material = build_platform_account(session, current)
                if material.status.value not in active_statuses:
                    results["skipped"] += 1
                    continue
            if account.platform == "chatgpt" and _account_refresh_restriction(material):
                results["skipped"] += 1
                continue
            valid = plugin.check_valid(material)
            summary_updates = {"checked_at": _utcnow_iso(), "valid": valid}
            if hasattr(plugin, "get_last_check_overview"):
                summary_updates.update(plugin.get_last_check_overview() or {})
            reported = summary_updates.get("valid")
            if type(reported) is not bool:
                reported = summary_updates["valid"] = None
            with Session(engine) as session:
                current = session.get(AccountModel, account.id)
                if not current or (current.platform, current.email, current.user_id) != identity:
                    results["skipped"] += 1
                    continue
                current.updated_at = _utcnow()
                patch_account_graph(session, current, summary_updates=summary_updates)
                session.add(current)
                session.commit()
            if reported is True:
                results["valid"] += 1
            elif reported is False:
                results["invalid"] += 1
                log(f"  {account.email} ({account.platform}): 失效")
            else:
                results["error"] += 1
                log(f"  {account.email} ({account.platform}): 检测结果未知")
        except Exception as exc:
            results["error"] += 1
            log(f"  {account.email} ({account.platform}): 检测异常 {exc}")
    log(f"检测完成: 有效 {results['valid']}, 失效 {results['invalid']}, "
        f"异常 {results['error']}, 跳过 {results['skipped']}")
    return results


# ---------------------------------------------------------------------------
# Token auto-refresh (ChatGPT-specific for now, extensible)
# ---------------------------------------------------------------------------

def _mark_deactivated_account(account) -> None:
    with Session(engine) as session:
        model = session.get(AccountModel, account.id)
        if not model or (model.platform, model.email, model.user_id) != (
                account.platform, account.email, account.user_id):
            return
        model.updated_at = _utcnow()
        patch_account_graph(
            session, model, lifecycle_status=AccountStatus.INVALID.value,
            summary_updates={"valid": False, "security_error": "account_deactivated",
                             "deactivated_at": _utcnow_iso(), "deactivated_reason": "account_deactivated"},
        )
        session.add(model)
        session.commit()


def refresh_expiring_tokens(
    *, platform: str = "", hours_before_expiry: int = 24, limit: int = 50, log_fn=None,
) -> dict[str, int]:
    """Refresh active accounts whose known access-token expiry is within the window."""
    from platforms.chatgpt.cpa_upload import _decode_jwt_payload
    from platforms.chatgpt.token_refresh import TokenRefreshManager, _account_refresh_restriction
    log = log_fn or logger.info
    results = {"refreshed": 0, "failed": 0, "skipped": 0}
    with Session(engine) as session:
        query = select(AccountModel)
        if platform:
            query = query.where(AccountModel.platform == platform)
        accounts = session.exec(query.limit(limit)).all()
        graphs = load_account_graphs(session, [int(account.id) for account in accounts if account.id])
    cutoff = _utcnow_ts() + max(0, hours_before_expiry) * 3600
    for account in accounts:
        graph = graphs.get(int(account.id or 0), {})
        if account.platform != "chatgpt" or graph.get("lifecycle_status") not in {"registered", "trial", "subscribed"}:
            results["skipped"] += 1
            continue
        credentials = {item["key"]: item["value"] for item in graph.get("credentials", [])
                       if item.get("scope") == "platform"}
        if _account_refresh_restriction(SimpleNamespace(
                status=AccountStatus(graph["lifecycle_status"]), extra=build_platform_extra(account, graph))):
            results["skipped"] += 1
            continue
        expiry = _decode_jwt_payload(credentials.get("access_token", "")).get("exp")
        if type(expiry) is int and expiry > cutoff:
            results["skipped"] += 1
            continue
        if not credentials.get("refresh_token") and not credentials.get("session_token"):
            results["skipped"] += 1
            continue
        try:
            material = SimpleNamespace(email=account.email, refresh_token=credentials.get("refresh_token", ""),
                                       session_token=credentials.get("session_token", ""),
                                       client_id=credentials.get("client_id", ""))
            result = TokenRefreshManager().refresh_account(material)
            if not result.success:
                results["failed"] += 1
                log(f"  {account.email}: {result.error_message}")
                if getattr(result, "error_type", "") == "account_deactivated":
                    _mark_deactivated_account(account)
                if getattr(result, "requires_user_action", False):
                    break
                continue
            updates = {key: getattr(result, key, "") for key in
                       ("access_token", "refresh_token", "id_token", "session_token") if getattr(result, key, "")}
            with Session(engine) as session:
                model = session.get(AccountModel, account.id)
                if not model or (model.platform, model.email, model.user_id) != (
                        account.platform, account.email, account.user_id):
                    results["failed"] += 1
                    continue
                model.updated_at = _utcnow()
                patch_account_graph(session, model, credential_updates=updates,
                                    summary_updates={"last_refresh_at": _utcnow_iso(), "refresh_success": True})
                session.add(model)
                session.commit()
            results["refreshed"] += 1
            log(f"  {account.email}: token 刷新成功")
        except Exception as exc:
            results["failed"] += 1
            log(f"  {account.email}: 刷新异常 {exc}")
    log(f"刷新完成: 成功 {results['refreshed']}, 失败 {results['failed']}, 跳过 {results['skipped']}")
    return results


# ---------------------------------------------------------------------------
# Trial expiry warning
# ---------------------------------------------------------------------------

def flag_expiring_trials(
    *,
    hours_warning: int = 48,
    log_fn=None,
) -> dict[str, int]:
    """Flag trial accounts that will expire within `hours_warning` hours."""
    log = log_fn or logger.info
    now_ts = _utcnow_ts()
    warning_ts = now_ts + hours_warning * 3600
    results = {"warned": 0, "expired": 0, "skipped": 0}

    with Session(engine) as session:
        overviews = session.exec(
            select(AccountOverviewModel)
            .where(AccountOverviewModel.lifecycle_status == "trial")
        ).all()

    for overview in overviews:
        summary = overview.get_summary()
        trial_end = int(summary.get("trial_end_time") or 0)
        if not trial_end:
            results["skipped"] += 1
            continue

        if trial_end < now_ts:
            # Already expired
            with Session(engine) as session:
                model = session.get(AccountModel, overview.account_id)
                if model:
                    model.updated_at = _utcnow()
                    patch_account_graph(
                        session, model,
                        lifecycle_status=AccountStatus.EXPIRED.value,
                        summary_updates={"expiry_warning": "expired"},
                    )
                    session.add(model)
                    session.commit()
            results["expired"] += 1
        elif trial_end < warning_ts:
            # Expiring soon
            hours_left = max(0, (trial_end - now_ts) // 3600)
            with Session(engine) as session:
                model = session.get(AccountModel, overview.account_id)
                if model:
                    model.updated_at = _utcnow()
                    patch_account_graph(
                        session, model,
                        summary_updates={
                            "expiry_warning": f"expiring_in_{hours_left}h",
                            "expiry_warning_hours": hours_left,
                        },
                    )
                    session.add(model)
                    session.commit()
            results["warned"] += 1
        else:
            results["skipped"] += 1

    log(f"过期预警: 已过期 {results['expired']}, 即将过期 {results['warned']}, "
        f"跳过 {results['skipped']}")
    return results


# ---------------------------------------------------------------------------
# ChatGPT token refresh + CPA sync + liveness check
# ---------------------------------------------------------------------------

def refresh_and_sync_cpa(*, platform: str = "chatgpt", limit: int = 200, log_fn=None) -> dict[str, int]:
    """Refresh saved web sessions, check account availability, then use the shared CPA uploader."""
    from curl_cffi import requests as cffi_requests
    from core.config_store import config_store
    from platforms.chatgpt.cpa_upload import generate_token_json, upload_to_cpa
    from platforms.chatgpt.token_refresh import _account_refresh_restriction, _response_restriction
    log = log_fn or logger.info
    results = {"refreshed": 0, "uploaded": 0, "dead": 0, "skipped": 0, "error": 0}
    cpa_api_url = config_store.get("cpa_api_url", "")
    cpa_api_key = config_store.get("cpa_api_key", "")
    with Session(engine) as session:
        query = select(AccountModel).where(AccountModel.platform == platform)
        accounts = session.exec(query.order_by(AccountModel.created_at.desc()).limit(limit)).all()
        graphs = load_account_graphs(session, [int(account.id) for account in accounts if account.id])
    for account in accounts:
        graph = graphs.get(int(account.id or 0), {})
        credentials = {item["key"]: item["value"] for item in graph.get("credentials", [])
                       if item.get("scope") == "platform"}
        if graph.get("lifecycle_status") not in {"registered", "trial", "subscribed"} or not credentials.get("session_token"):
            results["skipped"] += 1
            continue
        try:
            if _account_refresh_restriction(SimpleNamespace(
                    status=AccountStatus(graph["lifecycle_status"]), extra=build_platform_extra(account, graph))):
                results["skipped"] += 1
                continue
            proxy = credentials.get("proxy") or None
            transport = cffi_requests.Session(impersonate="chrome120", proxy=proxy)
            transport.cookies.set("__Secure-next-auth.session-token", credentials["session_token"],
                                  domain=".chatgpt.com", path="/")
            response = transport.get("https://chatgpt.com/api/auth/session",
                                     headers={"accept": "application/json"}, timeout=30)
            restriction = _response_restriction(response)
            if restriction:
                if restriction == "account_deactivated":
                    _mark_deactivated_account(account)
                    results["dead"] += 1
                else:
                    results["error"] += 1
                log(f"  {account.email}: 刷新暂停: {restriction}")
                break
            if response.status_code != 200:
                results["error"] += 1
                log(f"  {account.email}: session 刷新失败 HTTP {response.status_code}")
                continue
            data = response.json()
            access_token = data.get("accessToken")
            if not isinstance(access_token, str) or not access_token.strip():
                results["error"] += 1
                log(f"  {account.email}: session 响应缺少 accessToken")
                continue
            updates = {"access_token": access_token}
            new_session = transport.cookies.get("__Secure-next-auth.session-token")
            if new_session and new_session != credentials["session_token"]:
                updates["session_token"] = new_session
            with Session(engine) as session:
                model = session.get(AccountModel, account.id)
                if not model or (model.platform, model.email, model.user_id) != (
                        account.platform, account.email, account.user_id):
                    results["error"] += 1
                    continue
                model.updated_at = _utcnow()
                patch_account_graph(session, model, credential_updates=updates,
                                    summary_updates={"last_refresh_at": _utcnow_iso(), "refresh_success": True})
                session.add(model)
                session.commit()
            results["refreshed"] += 1
            response = cffi_requests.get(
                "https://chatgpt.com/backend-api/me",
                headers={"authorization": f"Bearer {access_token}", "accept": "application/json"},
                proxy=proxy, timeout=15, impersonate="chrome120")
            restriction = _response_restriction(response)
            if restriction:
                if restriction == "account_deactivated":
                    _mark_deactivated_account(account)
                    results["dead"] += 1
                else:
                    results["error"] += 1
                log(f"  {account.email}: 检测暂停: {restriction}")
                break
            if response.status_code != 200:
                results["error"] += 1
                log(f"  {account.email}: 状态检测失败 HTTP {response.status_code}")
                continue
            if cpa_api_url and cpa_api_key:
                material = SimpleNamespace(email=account.email, user_id=account.user_id,
                                           credentials={**credentials, **updates}, last_refresh=_utcnow_iso())
                token_data = generate_token_json(material)
                token_data["disabled"] = False
                ok, message = upload_to_cpa(token_data, api_url=cpa_api_url, api_key=cpa_api_key)
                if ok:
                    results["uploaded"] += 1
                else:
                    results["error"] += 1
                log(f"  {account.email}: {message}")
            time.sleep(0.5)
        except Exception as exc:
            results["error"] += 1
            log(f"  {account.email}: 同步异常 {exc}")
    log(f"[CPA Sync] 刷新 {results['refreshed']}, 上传 {results['uploaded']}, "
        f"封禁 {results['dead']}, 跳过 {results['skipped']}, 错误 {results['error']}")
    return results


# ---------------------------------------------------------------------------
# Lifecycle manager (combines all periodic tasks)
# ---------------------------------------------------------------------------

class LifecycleManager:
    """Runs periodic lifecycle tasks in a background thread."""

    def __init__(
        self,
        *,
        check_interval_hours: float = 6,
        refresh_interval_hours: float = 12,
        cpa_sync_interval_hours: float = 6,
        warning_hours: int = 48,
    ):
        self.check_interval = check_interval_hours * 3600
        self.refresh_interval = refresh_interval_hours * 3600
        self.cpa_sync_interval = cpa_sync_interval_hours * 3600
        self.warning_hours = warning_hours
        self._running = False
        self._thread: threading.Thread | None = None
        self._last_check = 0.0
        self._last_refresh = 0.0
        self._last_cpa_sync = 0.0

    def start(self):
        if self._running:
            return
        self._running = True
        self._thread = threading.Thread(target=self._loop, daemon=True, name="lifecycle-manager")
        self._thread.start()
        print("[LifecycleManager] 已启动")

    def stop(self):
        self._running = False

    def _loop(self):
        # Wait a bit before first run to let the app fully initialize
        time.sleep(30)
        while self._running:
            now = time.time()
            try:
                # Trial expiry warnings — run every cycle
                flag_expiring_trials(hours_warning=self.warning_hours)

                # Validity check
                if now - self._last_check >= self.check_interval:
                    print("[LifecycleManager] 开始账号有效性检测...")
                    check_accounts_validity()
                    self._last_check = now

                # Token refresh
                if now - self._last_refresh >= self.refresh_interval:
                    print("[LifecycleManager] 开始 token 自动续期...")
                    refresh_expiring_tokens()
                    self._last_refresh = now

                # CPA sync (刷新 token + 存活检查 + 上传)
                if now - self._last_cpa_sync >= self.cpa_sync_interval:
                    print("[LifecycleManager] 开始 CPA 同步 (刷新+检查+上传)...")
                    refresh_and_sync_cpa()
                    self._last_cpa_sync = now

            except Exception as exc:
                print(f"[LifecycleManager] 错误: {exc}")

            # Sleep in small increments so stop() is responsive
            for _ in range(60):
                if not self._running:
                    break
                time.sleep(1)


lifecycle_manager = LifecycleManager()
