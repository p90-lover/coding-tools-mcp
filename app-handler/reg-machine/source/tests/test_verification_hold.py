from concurrent.futures import ThreadPoolExecutor
import importlib
import json
from threading import Event, Lock
from types import SimpleNamespace

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlmodel import Session, select

import application.actions as actions
import application.tasks as tasks
import core.base_sms as sms
import core.verification_hold as holds
from api.tasks import router as tasks_router
from core.base_platform import Account, AccountStatus, RegisterConfig
from core.config_store import config_store
from core.db import AccountModel, AccountOverviewModel, TaskModel, engine
from domain.actions import ActionExecutionCommand
from platforms.chatgpt import browser_register as flow
from platforms.chatgpt.plugin import ChatGPTPlatform


@pytest.mark.parametrize("error,expected", [
    ("rate_limit_exceeded", True), ("Too many phone verification requests", True),
    ("phone_number_in_use", False), ("invalid phone number", False),
    ("SMS timeout", False), ("net::ERR_FAILED", False),
])
def test_hold_only_matches_phone_limit(error, expected):
    record = holds.activate_verification_hold(error, account_id=17)
    assert bool(record) is expected
    if record:
        assert set(record) == {"active", "code", "reason", "detected_at", "account_id"}
        assert record["account_id"] == 17


def test_hold_precedes_cleanup_and_never_retries(monkeypatch):
    attempts, cleaned = [], []
    callback = SimpleNamespace(activation=object(), completed=False, awaiting_external_success=False)
    def cleanup():
        assert holds.get_verification_hold()["active"]
        cleaned.append(True)
        return True
    callback.cleanup = cleanup
    def attempt(*args, **kwargs):
        attempts.append(True)
        raise RuntimeError("rate_limit_exceeded: Too many phone verification requests")
    monkeypatch.setattr(flow, "_do_add_phone_attempt", attempt)
    with pytest.raises(RuntimeError, match="rate_limit_exceeded"):
        flow._handle_add_phone_challenge(SimpleNamespace(), callback, device_id="fixture",
                                        user_agent="fixture", log=lambda _: None)
    assert len(attempts) == len(cleaned) == 1
    record = callback.verification_hold
    assert holds.bind_verification_hold(99, record["detected_at"], "different-owner").get("account_id") is None
    assert holds.bind_verification_hold(17, record["detected_at"], callback.verification_hold_owner)["account_id"] == 17
    assert "_owner" not in holds.get_verification_hold()


def test_waiting_controller_rechecks_hold_before_rental(monkeypatch):
    arrived, rentals = Event(), []
    lock = Lock()
    lock.acquire()
    class VerifyLock:
        def acquire(self, timeout=-1):
            arrived.set()
            return lock.acquire(timeout=timeout)
        def release(self):
            lock.release()
    monkeypatch.setattr(sms, "_HERO_SMS_VERIFY_LOCK", VerifyLock())
    controller = sms.PhoneCallbackController("herosms", {"_verification_hold_platform": "chatgpt"},
                                            service="dr", log_fn=lambda _: None)
    controller.provider = SimpleNamespace(get_number=lambda **kwargs: rentals.append(True))
    with ThreadPoolExecutor(max_workers=1) as pool:
        future = pool.submit(controller)
        try:
            assert arrived.wait(2)
            holds.activate_verification_hold("rate_limit_exceeded", account_id=17)
        finally:
            lock.release()
        with pytest.raises(holds.VerificationHoldError):
            future.result(timeout=2)
    assert rentals == [] and not controller._verify_lock_acquired
    other = sms.PhoneCallbackController("fixture", {"_verification_hold_platform": "grok"},
                                      service="dr", log_fn=lambda _: None)
    other.provider = SimpleNamespace(get_number=lambda **kwargs: SimpleNamespace(
        metadata={}, phone_number="fixture", activation_id="fixture"))
    assert other() == "fixture"


def test_persistent_claim_gate_allows_only_exact_single_resume_and_unrelated_jobs():
    record = holds.activate_verification_hold("rate_limit_exceeded", account_id=17)
    signup = tasks.create_register_task({"platform": "chatgpt", "count": 3})
    bulk = tasks.create_platform_action_task({"platform": "chatgpt", "account_ids": [17, 18],
        "action_id": "complete_registration", "params": {"resume_verification_hold": True}})
    wrong = tasks.create_platform_action_task({"platform": "chatgpt", "account_id": 18,
        "action_id": "complete_registration", "params": {"resume_verification_hold": True}})
    query = tasks.create_platform_action_task({"platform": "chatgpt", "account_id": 17, "action_id": "query_state"})
    other = tasks.create_register_task({"platform": "cursor", "count": 1})
    resume = tasks.create_platform_action_task({"platform": "chatgpt", "account_id": 17,
        "action_id": "complete_registration", "params": {"resume_verification_hold": True,
                                                      "_verification_hold_detected_at": record["detected_at"]}})
    importlib.reload(holds)  # The record is read from ConfigItem after a new module lifetime.
    assert holds.get_verification_hold() == record
    assert tasks.claim_next_runnable_task(max_parallel_per_platform=10)["id"] == query["id"]
    assert tasks.claim_next_runnable_task(max_parallel_per_platform=10)["id"] == other["id"]
    assert tasks.claim_next_runnable_task(max_parallel_per_platform=10)["id"] == resume["id"]
    for task in (signup, bulk, wrong):
        snapshot = tasks.get_task(task["id"])
        assert snapshot["status"] == "pending"
        assert snapshot["result"]["verification_hold"] == record
    assert holds.get_verification_hold() == record


def test_paused_execution_is_terminal_and_survives_restart():
    record = holds.activate_verification_hold("rate_limit_exceeded", account_id=17)
    task = tasks.create_register_task({"platform": "chatgpt", "count": 2})
    tasks.execute_task(task["id"])
    tasks.mark_incomplete_tasks_interrupted()
    snapshot = tasks.get_task(task["id"])
    assert snapshot["status"] == "paused" and snapshot["terminal"] is True
    assert snapshot["result"]["verification_hold"] == record


def test_hold_endpoint_and_recovery_rejections_create_no_tasks():
    record = holds.activate_verification_hold("rate_limit_exceeded", account_id=17)
    app = FastAPI()
    app.include_router(tasks_router, prefix="/api")
    with TestClient(app) as client:
        assert client.get("/api/tasks/verification-hold").json() == {"verification_hold": {**record, "account_exists": False}}
    service = actions.ActionsService(runtime=SimpleNamespace(list_actions=lambda _: []))
    for account_id, params in ((17, {}), (18, {"resume_verification_hold": True})):
        result = service.execute_action(ActionExecutionCommand("chatgpt", account_id, "complete_registration", params))
        assert result["data"]["verification_hold"] == record
        assert result["data"]["error_type"] == "verification_hold"
    assert service.execute_bulk_recovery("chatgpt", [17, 18], {"resume_verification_hold": True})["ok"] is False
    with Session(engine) as session:
        assert session.exec(select(TaskModel)).all() == []
    task = service.execute_action(ActionExecutionCommand("chatgpt", 17, "complete_registration",
                                                        {"resume_verification_hold": True}))
    assert task["progress"] == "0/1" and task["status"] == "pending"
    assert holds.get_verification_hold() == record


def test_hold_notice_tracks_deleted_account_without_clearing_restriction():
    record = holds.activate_verification_hold("rate_limit_exceeded", account_id=17)
    app = FastAPI()
    app.include_router(tasks_router, prefix="/api")
    with Session(engine) as session:
        session.add(AccountModel(id=17, platform="chatgpt", email="fixture@example.invalid", password=""))
        session.commit()
    with TestClient(app) as client:
        assert client.get("/api/tasks/verification-hold").json()["verification_hold"]["account_exists"] is True
        with Session(engine) as session:
            session.delete(session.get(AccountModel, 17))
            session.commit()
        response = client.get("/api/tasks/verification-hold").json()["verification_hold"]
        assert response == {**record, "account_exists": False}
    assert holds.get_verification_hold() == record
    with pytest.raises(holds.VerificationHoldError):
        holds.require_phone_verification_allowed()


def test_registration_restore_query_filters_history_and_preserves_status_priority():
    from datetime import datetime, timedelta, timezone
    now = datetime.now(timezone.utc)
    with Session(engine) as session:
        session.add_all([TaskModel(id=f"other-{i}", type="platform_action", platform="chatgpt",
                                  status="pending", created_at=now) for i in range(60)])
        session.add(TaskModel(id="active-register", type="register", platform="chatgpt",
                              status="running", created_at=now - timedelta(days=1)))
        session.add(TaskModel(id="paused-register", type="register", platform="chatgpt",
                              status="paused", created_at=now))
        session.commit()
    app = FastAPI()
    app.include_router(tasks_router, prefix="/api")
    with TestClient(app) as client:
        response = client.get("/api/tasks", params={"task_type": "register",
            "status": "pending,claimed,running,cancel_requested,paused", "page_size": 1})
        assert response.status_code == 200
        data = response.json()
        assert data["total"] == 2
        assert [item["id"] for item in data["items"]] == ["active-register"]
        # Existing task-history callers still receive unfiltered pages in date order.
        history = client.get("/api/tasks", params={"status": "pending"}).json()
        assert history["total"] == 60 and len(history["items"]) == 50
        paused = client.get("/api/tasks", params={"task_type": "register", "status": "paused"}).json()
        assert [item["id"] for item in paused["items"]] == ["paused-register"]


def test_new_rejection_invalidates_queued_manual_resume():
    old = holds.activate_verification_hold("rate_limit_exceeded", account_id=17)
    service = actions.ActionsService(runtime=SimpleNamespace(list_actions=lambda _: []))
    queued = service.execute_action(ActionExecutionCommand("chatgpt", 17, "complete_registration",
                                                          {"resume_verification_hold": True}))
    latest = holds.activate_verification_hold("rate_limit_exceeded", account_id=17)
    assert latest["detected_at"] != old["detected_at"]
    assert tasks.claim_next_runnable_task() is None
    assert tasks.get_task(queued["id"])["result"]["verification_hold"] == latest
    fresh = service.execute_action(ActionExecutionCommand("chatgpt", 17, "complete_registration",
                                                         {"resume_verification_hold": True}))
    assert tasks.claim_next_runnable_task()["id"] == fresh["id"]


def test_authoritative_retry_after_blocks_manual_resume_without_auto_clearing():
    record = holds.activate_verification_hold("rate_limit_exceeded", account_id=17, retry_after="120")
    assert record["retry_after_until"]
    assert not holds.can_resume_verification_hold(record, 17, True, record["detected_at"])
    assert holds.get_verification_hold() == record


def test_initial_signup_hold_checkpoints_identity_and_cookies(monkeypatch):
    callback = SimpleNamespace(verification_hold_owner="first-rejection")
    record = holds.activate_verification_hold("rate_limit_exceeded", owner=callback.verification_hold_owner)
    callback.verification_hold = record
    page = SimpleNamespace(context=SimpleNamespace(cookies=lambda: [{"name": "fixture", "value": "fixture"}]))
    class Browser:
        def __enter__(self): return self
        def __exit__(self, *args): return False
        def new_page(self): return page
    monkeypatch.setattr(flow, "Camoufox", lambda **kwargs: Browser())
    monkeypatch.setattr(flow, "_browser_registration_flow",
                        lambda *args: (_ for _ in ()).throw(RuntimeError("rate_limit_exceeded")))
    monkeypatch.setattr(flow.ChatGPTBrowserRegister, "_retry_oauth_fresh_browser",
                        lambda *args: pytest.fail("must not start OAuth after hold"))
    checkpoints = []
    worker = flow.ChatGPTBrowserRegister(headless=True, phone_callback=callback,
                                        log_fn=lambda _: None, security_checkpoint=checkpoints.append)
    result = worker.run("fixture@example.com", "fixture")
    assert result["status"] == "phone_required" and result["phone_verified"] is False
    assert checkpoints[0]["email"] == "fixture@example.com"
    assert checkpoints[0]["cookies"] and result["verification_hold"] == record
    assert "_verification_hold_owner" not in result


def test_first_rejection_keeps_checkpoint_ownership_and_saved_account_badge():
    from core.account_display import build_account_display_summary
    record = holds.activate_verification_hold("rate_limit_exceeded", owner="first")
    def checkpoint(email, owner):
        platform = object.__new__(ChatGPTPlatform)
        platform._attach_identity_metadata = lambda account, identity: None
        ctx = SimpleNamespace(identity=SimpleNamespace(email=email), password="")
        return platform._save_security_checkpoint(ctx, {
            "verification_hold": record, "_verification_hold_owner": owner,
            "cookies": "[]", "phone_verified": False,
        })
    checkpoint("waiter@example.com", "waiter")
    assert "account_id" not in holds.get_verification_hold()
    account = checkpoint("first@example.com", "first")
    bound = holds.get_verification_hold()
    with Session(engine) as session:
        model = session.exec(select(AccountModel).where(AccountModel.email == account.email)).one()
        assert bound["account_id"] == model.id
        overview = session.get(AccountOverviewModel, model.id)
        assert overview.lifecycle_status == "rate_limit_exceeded"
        summary = overview.get_summary()
        assert summary["legacy_extra"]["verification_hold"] == bound
    display = build_account_display_summary(platform="chatgpt", email=account.email,
        lifecycle_status="phone_required", validity_status="unknown", plan_state="unknown",
        plan_name="", display_status="phone_required", overview=summary)
    assert any(item["key"] == "verification_hold" for item in display["warnings"])
    assert {"label": "验证已暂停", "tone": "warning"} in display["badges"]


def test_register_batch_stops_refilling_after_hold(monkeypatch):
    calls = []
    def register(**kwargs):
        calls.append(True)
        record = holds.activate_verification_hold("rate_limit_exceeded", account_id=17)
        return Account(platform="chatgpt", email="fixture@example.com", password="",
                       status=AccountStatus.PHONE_REQUIRED, extra={"verification_hold": record})
    monkeypatch.setattr(tasks, "_resolve_sms_provider_for_task", lambda _: ("", {}))
    monkeypatch.setattr(tasks, "get", lambda _: object())
    monkeypatch.setattr(tasks, "_build_platform_instance",
                        lambda *args, **kwargs: SimpleNamespace(register=register))
    monkeypatch.setattr(tasks, "save_account", lambda _: None)
    monkeypatch.setattr(tasks, "_save_task_log", lambda *args, **kwargs: None)
    from core.proxy_pool import proxy_pool
    monkeypatch.setattr(proxy_pool, "get_next", lambda **kwargs: None)
    task = tasks.create_register_task({"platform": "chatgpt", "count": 3, "concurrency": 1,
                                      "extra": {"identity_provider": "oauth_browser"}})
    tasks.execute_task(task["id"])
    assert len(calls) == 1
    assert tasks.get_task(task["id"])["status"] == "paused"


def test_bulk_stops_before_next_account_on_hold(monkeypatch):
    for account_id in (17, 18):
        with Session(engine) as session:
            session.add(AccountModel(id=account_id, platform="chatgpt", email=f"fixture-{account_id}@example.com", password=""))
            session.add(AccountOverviewModel(account_id=account_id, lifecycle_status="phone_required"))
            session.commit()
    calls = []
    class Runtime:
        def execute_action(self, command, **kwargs):
            calls.append(command.account_id)
            record = holds.activate_verification_hold("rate_limit_exceeded", account_id=command.account_id)
            return SimpleNamespace(ok=False, data={"verification_hold": record}, error="verification_hold")
    monkeypatch.setattr(tasks, "PlatformRuntime", Runtime)
    task = tasks.create_platform_action_task({"platform": "chatgpt", "account_ids": [17, 18],
                                              "action_id": "complete_registration"})
    tasks.execute_task(task["id"])
    assert calls == [17]
    assert tasks.get_task(task["id"])["status"] == "paused"


@pytest.mark.parametrize("complete,phone_succeeded", [(False, False), (False, True), (True, False), (True, True)])
def test_manual_resume_keeps_hold_until_same_account_phone_and_full_recovery(monkeypatch, complete, phone_succeeded):
    record = holds.activate_verification_hold("rate_limit_exceeded", account_id=17)
    platform = object.__new__(ChatGPTPlatform)
    platform._local_account_id = 17
    platform.config = RegisterConfig()
    platform._log_fn = lambda _: None
    account = Account(platform="chatgpt", email="fixture@example.com", password="",
                      status=AccountStatus.PHONE_REQUIRED,
                      extra={"provider_accounts": [{"provider_type": "mailbox", "provider_name": "fixture"}]})
    with Session(engine) as session:
        session.add(AccountModel(id=17, platform="chatgpt", email=account.email, password=""))
        session.add(AccountOverviewModel(account_id=17, lifecycle_status="phone_required"))
        session.commit()
    import core.base_mailbox as mailbox
    import core.registration.helpers as helpers
    monkeypatch.setattr(mailbox, "create_mailbox", lambda *args, **kwargs:
                        SimpleNamespace(get_current_ids=lambda _: set()))
    callback = SimpleNamespace(phone_verification_succeeded=phone_succeeded)
    monkeypatch.setattr(helpers, "build_phone_callbacks", lambda *args, **kwargs: (callback, lambda: True))
    monkeypatch.setattr(helpers, "build_otp_callback", lambda *args, **kwargs: None)
    from core.proxy_pool import proxy_pool
    monkeypatch.setattr(proxy_pool, "get_next", lambda **kwargs: None)
    class Worker:
        def __init__(self, **kwargs): pass
        def run(self, **kwargs):
            assert holds.get_verification_hold() == record
            holds.require_phone_verification_allowed(account_id=17, resume=True, detected_at=record["detected_at"])
            return {}
    monkeypatch.setattr(flow, "ChatGPTBrowserRegister", Worker)
    recovered = Account(platform="chatgpt", email=account.email, password="",
                        status=AccountStatus.REGISTERED if complete else AccountStatus.PHONE_REQUIRED,
                        extra={"phone_verified": phone_succeeded})
    platform._save_security_checkpoint = lambda ctx, state: recovered
    result = platform._complete_pending_registration(account, {"resume_verification_hold": True,
                                                               "_verification_hold_detected_at": record["detected_at"]})
    assert result["ok"] is complete
    assert (holds.get_verification_hold() is None) is (complete and phone_succeeded)


def test_queued_task_drops_stale_hold_when_verified_resume_clears_gate():
    record = holds.activate_verification_hold("rate_limit_exceeded", account_id=17)
    queued = tasks.create_register_task({"platform": "chatgpt", "count": 1})
    assert tasks.claim_next_runnable_task() is None
    assert tasks.get_task(queued["id"])["result"]["verification_hold"] == record
    assert holds.clear_verification_hold(17, record["detected_at"])
    assert "verification_hold" not in tasks.get_task(queued["id"])["result"]
    assert tasks.claim_next_runnable_task()["id"] == queued["id"]
    assert "verification_hold" not in tasks.get_task(queued["id"])["result"]


def test_paused_stream_reports_hold_instead_of_completion():
    import asyncio
    from application.task_commands import TaskCommandsService
    record = holds.activate_verification_hold("rate_limit_exceeded", account_id=17)
    task = tasks.create_register_task({"platform": "chatgpt", "count": 1})
    tasks.execute_task(task["id"])
    async def collect():
        return [chunk async for chunk in TaskCommandsService().stream_task_events(task["id"])]
    chunks = asyncio.run(collect())
    done = [json.loads(chunk[6:].strip()) for chunk in chunks if chunk.startswith("data: ") and '"done": true' in chunk]
    assert len(done) == 1
    assert done[0]["status"] == "paused"
    assert done[0]["line"] != "任务已完成"
    assert record["reason"] in done[0]["line"]

@pytest.mark.parametrize("other_record,delete_target", [(True, False), (True, True), (False, True)])
def test_bound_checkpoint_keeps_its_exact_target(monkeypatch, other_record, delete_target):
    from core.db import AccountCredentialModel
    from infrastructure.accounts_repository import AccountsRepository

    with Session(engine) as session:
        if other_record:
            session.add(AccountModel(id=17, platform="chatgpt", email="duplicate@example.invalid",
                                     password="older-password"))
            session.add(AccountOverviewModel(account_id=17, lifecycle_status="registered"))
            session.add(AccountCredentialModel(account_id=17, key="access_token", value="older-access"))
        session.add(AccountModel(id=18, platform="chatgpt", email="duplicate@example.invalid",
                                 password="selected-password"))
        session.add(AccountOverviewModel(account_id=18, lifecycle_status="phone_required"))
        session.commit()
    platform = object.__new__(ChatGPTPlatform)
    platform._local_account_id = 18
    platform._attach_identity_metadata = lambda account, identity: None
    record = holds.activate_verification_hold("rate_limit_exceeded", owner="selected-owner")
    ctx = SimpleNamespace(identity=SimpleNamespace(email="duplicate@example.invalid"),
                          password="updated-selected-password")
    state = {"verification_hold": record, "_verification_hold_owner": "selected-owner",
             "cookies": "[]", "phone_verified": False}

    if delete_target:
        original_bind = holds.bind_verification_hold

        def remove_target_after_binding(*args, **kwargs):
            bound = original_bind(*args, **kwargs)
            assert AccountsRepository().delete(18)
            return bound

        monkeypatch.setattr(holds, "bind_verification_hold", remove_target_after_binding)
        with pytest.raises(ValueError, match="目标账号不存在或身份不匹配"):
            platform._save_security_checkpoint(ctx, state)
    else:
        checkpoint = platform._save_security_checkpoint(ctx, state)
        assert checkpoint.extra["verification_hold"]["account_id"] == 18

    with Session(engine) as session:
        if other_record:
            assert session.get(AccountModel, 17).password == "older-password"
            assert session.get(AccountOverviewModel, 17).lifecycle_status == "registered"
            credential = session.exec(select(AccountCredentialModel).where(
                AccountCredentialModel.account_id == 17,
                AccountCredentialModel.key == "access_token")).one()
            assert credential.value == "older-access"
        assert len(session.exec(select(AccountModel)).all()) == int(other_record) + int(not delete_target)
        selected = session.get(AccountModel, 18)
        if delete_target:
            assert selected is None
        else:
            assert selected.password == "updated-selected-password"
            summary = session.get(AccountOverviewModel, 18).get_summary()
            assert summary["legacy_extra"]["verification_hold"] == holds.get_verification_hold()
    assert holds.get_verification_hold()["account_id"] == 18
