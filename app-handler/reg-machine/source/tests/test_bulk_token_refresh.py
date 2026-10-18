"""Offline coverage for sequential, exact-account bulk OAuth refresh."""
from types import SimpleNamespace

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlmodel import Session, select

import application.actions as actions
import application.tasks as tasks
from api.actions import router
from core.db import AccountModel, AccountOverviewModel, engine


def add_account(account_id, status="registered", platform="chatgpt"):
    with Session(engine) as session:
        session.add(AccountModel(id=account_id, platform=platform,
                                 email=f"account-{account_id}@example.com", password=""))
        session.add(AccountOverviewModel(account_id=account_id, lifecycle_status=status,
                                         display_status=status))
        session.commit()


def set_status(account_id, status):
    with Session(engine) as session:
        overview = session.get(AccountOverviewModel, account_id)
        overview.lifecycle_status = status
        session.add(overview)
        session.commit()


def test_bulk_refresh_api_validates_exact_selection():
    add_account(1)
    add_account(2, "invalid")
    add_account(3, "phone_required")
    add_account(4, platform="cursor")
    app = FastAPI()
    app.include_router(router, prefix="/api")
    with TestClient(app) as client:
        response = client.post("/api/actions/chatgpt/bulk/refresh_token",
                               json={"account_ids": [2, 3, 1], "params": {}})
        assert response.status_code == 200
        result = response.json()
        assert result["type"] == "platform_action"
        assert result["status"] == "pending"
        assert result["progress"] == "0/3"
        assert result["data"] == {"refreshed": [], "skipped": [], "failed": [], "remaining": [2, 3, 1]}
        with Session(engine) as session:
            payload = session.get(tasks.TaskModel, result["task_id"]).get_payload()
        assert payload == {"platform": "chatgpt", "action_id": "refresh_token",
                           "account_ids": [2, 3, 1], "params": {}}
        for ids in ([1, 1], [0], [True], ["1"], [], list(range(1, 102))):
            assert client.post("/api/actions/chatgpt/bulk/refresh_token",
                               json={"account_ids": ids}).status_code in (400, 422)
        for ids in ([99], [4], [1, 4]):
            assert client.post("/api/actions/chatgpt/bulk/refresh_token",
                               json={"account_ids": ids}).status_code == 400
        assert client.post("/api/actions/cursor/bulk/refresh_token",
                           json={"account_ids": [4]}).status_code == 400
        assert client.post("/api/actions/chatgpt/bulk/refresh_token",
                           json={"account_ids": [1], "params": {"resume_verification_hold": True}}).status_code == 400

    service = actions.ActionsService()
    for ids in ([True], ["1"], [1, 1], [], list(range(1, 102))):
        with pytest.raises(ValueError):
            service.execute_bulk_refresh("chatgpt", ids, {})


def test_bulk_refresh_rechecks_state_and_never_records_credentials(monkeypatch):
    for account_id, status in ((1, "invalid"), (2, "registered"),
                               (3, "phone_required"), (4, "2fa_required"), (5, "registered")):
        add_account(account_id, status)
    task = actions.ActionsService().execute_bulk_refresh("chatgpt", [1, 2, 3, 4, 5], {})
    set_status(2, "phone_required")  # Changed while queued: must not launch recovery or SMS.
    with Session(engine) as session:
        session.get(AccountModel, 5).platform = "cursor"
        session.commit()
    calls = []
    class Runtime:
        def execute_action(self, command, *, log_fn=None):
            calls.append(command.account_id)
            assert command.platform == "chatgpt" and command.action_id == "refresh_token"
            if log_fn:
                log_fn("access_token=secret-token password=secret-password")
            return SimpleNamespace(ok=True, data={"access_token": "secret-token"}, error="")
    monkeypatch.setattr(tasks, "PlatformRuntime", Runtime)
    tasks.execute_task(task["task_id"])
    result = tasks.get_task(task["task_id"])
    assert calls == [1]
    assert result["status"] == "succeeded"
    assert result["success"] == 1
    assert result["progress"] == "5/5"
    assert result["data"] == {"refreshed": [1], "skipped": [2, 3, 4, 5], "failed": [], "remaining": []}
    with Session(engine) as session:
        assert session.get(AccountOverviewModel, 1).lifecycle_status == "invalid"
        events = session.exec(select(tasks.TaskEventModel).where(
            tasks.TaskEventModel.task_id == task["task_id"])).all()
    assert "secret-" not in str(result) + str([event.message for event in events])


def test_bulk_refresh_continues_ordinary_failure_without_faking_success(monkeypatch):
    add_account(1, "invalid")
    add_account(2)
    task = actions.ActionsService().execute_bulk_refresh("chatgpt", [1, 2], {})
    calls = []
    class Runtime:
        def execute_action(self, command, *, log_fn=None):
            calls.append(command.account_id)
            if command.account_id == 1:
                raise RuntimeError("network failure access_token=secret-token")
            return SimpleNamespace(ok=True, data={"refresh_token": "secret-token"}, error="")
    monkeypatch.setattr(tasks, "PlatformRuntime", Runtime)
    tasks.execute_task(task["task_id"])
    result = tasks.get_task(task["task_id"])
    assert calls == [1, 2]
    assert result["status"] == "failed"
    assert result["success"] == result["error_count"] == 1
    assert result["data"] == {"refreshed": [2], "skipped": [], "failed": [1], "remaining": []}
    with Session(engine) as session:
        assert session.get(AccountOverviewModel, 1).lifecycle_status == "invalid"
        events = session.exec(select(tasks.TaskEventModel).where(
            tasks.TaskEventModel.task_id == task["task_id"])).all()
    assert "secret-token" not in str(result) + str([event.message for event in events])


@pytest.mark.parametrize("mode", ["cancel", "requires_user_action", "captcha"])
def test_bulk_refresh_stops_between_accounts_and_retains_summary(monkeypatch, mode):
    for account_id in (1, 2, 3):
        add_account(account_id)
    task = actions.ActionsService().execute_bulk_refresh("chatgpt", [1, 2, 3], {})
    calls = []
    hold = {"active": True, "account_id": 1, "detected_at": "test-detection"}
    monkeypatch.setattr(tasks, "get_verification_hold", lambda: hold if mode in {"hold", "hold_after_success"} and calls else None)
    class Runtime:
        def execute_action(self, command, *, log_fn=None):
            calls.append(command.account_id)
            if mode in {"cancel", "hold_after_success"}:
                if mode == "cancel":
                    tasks.request_cancel(task["task_id"])
                return SimpleNamespace(ok=True, data={}, error="")
            return SimpleNamespace(ok=False, data={"requires_user_action": mode == "requires_user_action"},
                                   error="captcha secret-token" if mode == "captcha" else "secret-token")
    monkeypatch.setattr(tasks, "PlatformRuntime", Runtime)
    tasks.execute_task(task["task_id"])
    result = tasks.get_task(task["task_id"])
    assert calls == [1]
    assert result["status"] == ("cancelled" if mode == "cancel" else "paused" if mode.startswith("hold") else "failed")
    assert result["progress"] == "1/3"
    assert result["data"] == {"refreshed": [1] if mode in {"cancel", "hold_after_success"} else [],
                              "skipped": [], "failed": [] if mode in {"cancel", "hold_after_success"} else [1],
                              "remaining": [2, 3]}
    assert "secret-token" not in str(result)


def test_bulk_refresh_propagates_cancellation_through_private_runtime_logger(monkeypatch):
    import re
    from platforms.chatgpt.browser_register import _task_cancel_requested

    add_account(1)
    add_account(2)
    task = actions.ActionsService().execute_bulk_refresh("chatgpt", [1, 2], {})
    calls = []
    observed = []
    class Runtime:
        def execute_action(self, command, *, log_fn=None):
            calls.append(command.account_id)
            # Match PlatformRuntime's OTP-redacting logger closure.
            wrapped = lambda message: log_fn(re.sub(r"(?<!\d)\d{6}(?!\d)", "[code]", str(message)))
            wrapped("access_token=secret-token password=secret-password OTP=123456")
            observed.extend([_task_cancel_requested(log_fn), _task_cancel_requested(wrapped)])
            tasks.request_cancel(task["task_id"])
            observed.extend([_task_cancel_requested(log_fn), _task_cancel_requested(wrapped)])
            return SimpleNamespace(ok=False, data={}, error="cancelled secret-token")
    monkeypatch.setattr(tasks, "PlatformRuntime", Runtime)
    tasks.execute_task(task["task_id"])
    result = tasks.get_task(task["task_id"])
    assert observed == [False, False, True, True]
    assert calls == [1]
    assert result["status"] == "cancelled"
    assert result["progress"] == "1/2"
    assert result["data"] == {"refreshed": [], "skipped": [], "failed": [1], "remaining": [2]}
    with Session(engine) as session:
        events = session.exec(select(tasks.TaskEventModel).where(
            tasks.TaskEventModel.task_id == task["task_id"])).all()
    assert "secret-" not in str(result) + str([event.message for event in events])


def test_bulk_refresh_private_logger_only_exposes_literal_startup_stages(capsys):
    add_account(1)
    task = actions.ActionsService().execute_bulk_refresh("chatgpt", [1], {})
    logger = tasks.TaskLogger(task["task_id"])
    stages = [
        "  OAuth startup: starting Camoufox",
        "  OAuth startup: creating page",
        "  OAuth startup: restoring saved cookies",
        "  OAuth startup: reading cookies",
        "  OAuth startup: ready",
    ]
    for stage in stages:
        logger.private_log(stage)
        logger.private_log(stage + " access_token=secret-token")
    logger.private_log("access_token=secret-token password=secret-password")
    logger.private_log("OAuth startup: ready")
    with Session(engine) as session:
        events = session.exec(select(tasks.TaskEventModel).where(
            tasks.TaskEventModel.task_id == task["task_id"])).all()
    assert [event.message for event in events if event.type == "log"] == stages
    assert "secret-" not in str([event.message for event in events]) + capsys.readouterr().out


def test_bulk_refresh_cancel_after_claim_preserves_all_remaining(monkeypatch):
    add_account(1)
    add_account(2)
    task = actions.ActionsService().execute_bulk_refresh("chatgpt", [1, 2], {})
    assert tasks.claim_next_runnable_task()["id"] == task["task_id"]
    tasks.request_cancel(task["task_id"])
    tasks.execute_task(task["task_id"])
    result = tasks.get_task(task["task_id"])
    assert result["status"] == "cancelled"
    assert result["data"] == {"refreshed": [], "skipped": [], "failed": [], "remaining": [1, 2]}


def test_bulk_refresh_runs_unrelated_accounts_during_phone_verification_hold(monkeypatch):
    add_account(1, "invalid")
    add_account(2)
    add_account(46, "fraud_guard")
    hold = {"active": True, "account_id": 46, "detected_at": "test-detection"}
    monkeypatch.setattr(actions, "get_verification_hold", lambda: hold)
    monkeypatch.setattr(tasks, "get_verification_hold", lambda: hold)
    task = actions.ActionsService().execute_bulk_refresh("chatgpt", [1, 46, 2], {})
    assert task.get("task_id")
    calls = []
    class Runtime:
        def execute_action(self, command, *, log_fn=None):
            calls.append(command.account_id)
            assert command.action_id == "refresh_token" and command.params == {}
            return SimpleNamespace(ok=True, data={}, error="")
    monkeypatch.setattr(tasks, "PlatformRuntime", Runtime)
    tasks.execute_task(task["task_id"])
    result = tasks.get_task(task["task_id"])
    assert calls == [1, 2]
    assert result["status"] == "succeeded"
    assert result["data"] == {"refreshed": [1, 2], "skipped": [46], "failed": [], "remaining": []}
    assert actions.get_verification_hold() == hold
    with Session(engine) as session:
        assert session.get(AccountOverviewModel, 46).lifecycle_status == "fraud_guard"


@pytest.mark.parametrize("first_succeeds", [True, False])
def test_bulk_refresh_ignores_unrelated_phone_hold_created_between_accounts(monkeypatch, first_succeeds):
    for account_id in (1, 2, 3):
        add_account(account_id)
    task = actions.ActionsService().execute_bulk_refresh("chatgpt", [1, 2, 3], {})
    calls = []
    hold = {"active": True, "account_id": 46, "detected_at": "new-detection"}
    monkeypatch.setattr(tasks, "get_verification_hold", lambda: hold if calls else None)
    class Runtime:
        def execute_action(self, command, *, log_fn=None):
            calls.append(command.account_id)
            return SimpleNamespace(ok=first_succeeds or command.account_id != 1,
                                   data={}, error="" if first_succeeds else "ordinary failure")
    monkeypatch.setattr(tasks, "PlatformRuntime", Runtime)
    tasks.execute_task(task["task_id"])
    result = tasks.get_task(task["task_id"])
    assert calls == [1, 2, 3]
    assert result["status"] == ("succeeded" if first_succeeds else "failed")
    assert result["data"] == {"refreshed": [1, 2, 3] if first_succeeds else [2, 3],
                              "skipped": [], "failed": [] if first_succeeds else [1], "remaining": []}


@pytest.mark.parametrize("security_error", ["", "captcha"])
@pytest.mark.parametrize("structured_error", [True, False])
def test_bulk_refresh_keeps_unrelated_accounts_runnable_after_local_phone_prompt(monkeypatch, security_error, structured_error):
    add_account(1)
    add_account(2)
    task = actions.ActionsService().execute_bulk_refresh("chatgpt", [1, 2], {})
    calls = []
    class Runtime:
        def execute_action(self, command, *, log_fn=None):
            calls.append(command.account_id)
            if command.account_id == 1:
                return SimpleNamespace(ok=False,
                    data={"requires_user_action": True, **({"error_type": "phone_required"} if structured_error else {})},
                    error="原账号登录未完成: 原账号需要完成注册或手机验证，请使用恢复注册操作 " + security_error)
            return SimpleNamespace(ok=True, data={}, error="")
    monkeypatch.setattr(tasks, "PlatformRuntime", Runtime)
    tasks.execute_task(task["task_id"])
    result = tasks.get_task(task["task_id"])
    assert calls == ([1] if security_error else [1, 2])
    assert result["status"] == "failed"
    assert result["data"] == {"refreshed": [] if security_error else [2],
                              "skipped": [], "failed": [1], "remaining": [2] if security_error else []}


def test_bulk_refresh_uses_authoritative_original_account_persistence(monkeypatch):
    import infrastructure.platform_runtime as runtime
    from core.account_graph import load_account_graphs
    from core.platform_accounts import build_platform_account

    add_account(1, "invalid")
    add_account(2, "invalid")
    calls = []
    class Platform:
        def __init__(self, config):
            pass
        def set_logger(self, logger):
            pass
        def execute_action(self, action_id, account, params):
            calls.append((action_id, account.email))
            return {"ok": True, "data": {
                "email": account.email, "account_id": "same-account", "oauth_login_verified": True,
                "access_token": "secret-access", "refresh_token": "secret-refresh", "id_token": "secret-id",
            }}
    monkeypatch.setattr(runtime, "load_all", lambda: None)
    monkeypatch.setattr(runtime, "get", lambda _: Platform)
    task = actions.ActionsService().execute_bulk_refresh("chatgpt", [1], {})
    tasks.execute_task(task["task_id"])
    result = tasks.get_task(task["task_id"])
    assert calls == [("refresh_token", "account-1@example.com")]
    assert result["data"] == {"refreshed": [1], "skipped": [], "failed": [], "remaining": []}
    assert "secret-" not in str(result)
    with Session(engine) as session:
        original = build_platform_account(session, session.get(AccountModel, 1))
        other = build_platform_account(session, session.get(AccountModel, 2))
        graphs = load_account_graphs(session, [1, 2])
        assert len(session.exec(select(AccountModel)).all()) == 2
    assert original.extra["refresh_token"] == "secret-refresh"
    assert other.extra.get("refresh_token", "") == ""
    assert graphs[1]["lifecycle_status"] == "registered"
    assert graphs[2]["lifecycle_status"] == "invalid"
