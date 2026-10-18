from types import SimpleNamespace

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlmodel import Session

import application.actions as actions
import application.tasks as tasks
from api.actions import router
from core.db import AccountModel, AccountOverviewModel, engine
from domain.actions import ActionExecutionCommand


def add_account(account_id, status, platform="chatgpt", display_status=None):
    with Session(engine) as session:
        session.add(AccountModel(id=account_id, platform=platform, email=f"account-{account_id}@example.com", password=""))
        session.add(AccountOverviewModel(account_id=account_id, lifecycle_status=status,
                                         display_status=display_status or status))
        session.commit()


def finish_account(account_id):
    with Session(engine) as session:
        overview = session.get(AccountOverviewModel, account_id)
        overview.lifecycle_status = "registered"
        session.add(overview)
        session.commit()


def fake_runtime(monkeypatch, calls, after=None, error=""):
    class Runtime:
        def execute_action(self, command, *, log_fn=None):
            calls.append(command.account_id)
            assert command.action_id == "complete_registration"
            if error:
                return SimpleNamespace(ok=False, data={}, error=error)
            finish_account(command.account_id)
            if after:
                after(command.account_id)
            return SimpleNamespace(ok=True, data={"status": "registered"}, error="")
    monkeypatch.setattr(tasks, "PlatformRuntime", Runtime)


def test_bulk_api_selects_lifecycle_and_keeps_single_action_contract():
    add_account(1, "phone_required", display_status="invalid")
    add_account(2, "2fa_required")
    add_account(3, "registered")
    add_account(4, "phone_required", platform="cursor")
    app = FastAPI()
    app.include_router(router, prefix="/api")
    with TestClient(app) as client:
        response = client.post("/api/actions/chatgpt/bulk/complete_registration",
                               json={"account_ids": [3, 2, 1], "params": {}})
        assert response.status_code == 200
        task = response.json()
        assert task["status"] == "pending"
        assert task["type"] == "platform_action"
        assert task["progress"] == "0/2"
        with Session(engine) as session:
            payload = session.get(tasks.TaskModel, task["task_id"]).get_payload()
        assert payload["account_ids"] == [2, 1]
        for ids in ([1, 1], [0], [True], ["1"], [], list(range(1, 102))):
            assert client.post("/api/actions/chatgpt/bulk/complete_registration",
                               json={"account_ids": ids}).status_code in (400, 422)
        for ids in ([99], [4], [3]):
            assert client.post("/api/actions/chatgpt/bulk/complete_registration",
                               json={"account_ids": ids}).status_code == 400
        assert client.post("/api/actions/cursor/bulk/complete_registration",
                           json={"account_ids": [4]}).status_code == 400

    service = actions.ActionsService(runtime=SimpleNamespace(list_actions=lambda _: []))
    single = service.execute_action(ActionExecutionCommand("chatgpt", 1, "complete_registration"))
    assert single["progress"] == "0/1"


def test_bulk_is_sequential_and_rechecks_state(monkeypatch):
    for account_id in (1, 2, 3):
        add_account(account_id, "phone_required")
    task = actions.ActionsService().execute_bulk_recovery("chatgpt", [3, 1, 2], {})
    finish_account(1)  # Already recovered while this batch was queued.
    calls = []
    fake_runtime(monkeypatch, calls)
    tasks.execute_task(task["task_id"])
    result = tasks.get_task(task["task_id"])
    assert calls == [3, 2]
    assert result["status"] == "succeeded"
    assert result["success"] == 2
    assert result["error_count"] == 0
    assert result["progress"] == "3/3"
    assert result["data"] == {"recovered": [3, 2], "skipped": [1], "failed": []}


def test_bulk_honors_cancellation_between_accounts(monkeypatch):
    for account_id in (1, 2):
        add_account(account_id, "2fa_required")
    task = actions.ActionsService().execute_bulk_recovery("chatgpt", [1, 2], {})
    calls = []
    fake_runtime(monkeypatch, calls, after=lambda _: tasks.request_cancel(task["task_id"]))
    tasks.execute_task(task["task_id"])
    result = tasks.get_task(task["task_id"])
    assert calls == [1]
    assert result["status"] == "cancelled"
    assert result["progress"] == "1/2"
    assert result["success"] == 1


def test_bulk_preserves_cancellation_after_claim(monkeypatch):
    add_account(1, "phone_required")
    task = actions.ActionsService().execute_bulk_recovery("chatgpt", [1], {})
    assert tasks.claim_next_runnable_task()["id"] == task["task_id"]
    tasks.request_cancel(task["task_id"])
    calls = []
    fake_runtime(monkeypatch, calls)
    tasks.execute_task(task["task_id"])
    assert calls == []
    assert tasks.get_task(task["task_id"])["status"] == "cancelled"


@pytest.mark.parametrize("reason", [
    "fraud_guard: verification needs user action", "WhatsApp channel unavailable",
    "HeroSMS cancellation is pending; unused rental retained", "phone_cleanup_pending",
])
def test_bulk_stops_at_security_or_channel_blocker(monkeypatch, reason):
    for account_id in (1, 2):
        add_account(account_id, "phone_required")
    task = actions.ActionsService().execute_bulk_recovery("chatgpt", [1, 2], {})
    calls = []
    fake_runtime(monkeypatch, calls, error=reason)
    tasks.execute_task(task["task_id"])
    result = tasks.get_task(task["task_id"])
    assert calls == [1]
    assert result["status"] == "failed"
    assert result["error_count"] == 1
    assert result["progress"] == "1/2"
    assert result["data"]["failed"] == [1]
    assert tasks.get_chatgpt_recovery_ids([1, 2]) == [1, 2]


def test_recovery_resource_queues_single_and_bulk_without_blocking_other_platform():
    add_account(1, "phone_required")
    add_account(2, "phone_required")
    batch = actions.ActionsService().execute_bulk_recovery("chatgpt", [1], {})
    single = tasks.create_platform_action_task({"platform": "chatgpt", "account_id": 2,
                                                "action_id": "complete_registration"})
    other = tasks.create_platform_action_task({"platform": "cursor", "account_id": 3,
                                               "action_id": "some_action"})
    claim = tasks.claim_next_runnable_task(max_parallel_per_platform=10)
    assert claim["id"] == batch["task_id"]
    assert "chatgpt:recovery" in claim["account_keys"]
    claim_other = tasks.claim_next_runnable_task(busy_account_keys=set(claim["account_keys"]),
                                                max_parallel_per_platform=10)
    assert claim_other["id"] == other["task_id"]
    assert tasks.get_task(single["task_id"])["status"] == "pending"
