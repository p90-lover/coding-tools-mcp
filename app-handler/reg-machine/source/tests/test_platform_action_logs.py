import io
import pytest
from types import SimpleNamespace
from sqlmodel import Session
from core.db import AccountModel, engine
import application.tasks as tasks
import infrastructure.platform_runtime as runtime


def test_action_task_forwards_its_logger(monkeypatch):
    messages = []
    class FakeRuntime:
        def execute_action(self, command, *, log_fn=None):
            if log_fn:
                log_fn("Checking MFA")
            return SimpleNamespace(ok=False, error="still pending", data=None)
    monkeypatch.setattr(tasks, "PlatformRuntime", FakeRuntime)
    logger = SimpleNamespace(log=messages.append, record_error=lambda _: None,
                             set_progress=lambda *args: None,
                             is_cancel_requested=lambda: False,
                             finish=lambda *args, **kwargs: None)
    tasks._execute_platform_action_task(
        {"platform": "chatgpt", "account_id": 1, "action_id": "complete_registration"}, logger,
    )
    assert messages == ["Checking MFA"]


def test_runtime_routes_stage_logs_without_persisting_otp(monkeypatch):
    with Session(engine) as session:
        model = AccountModel(platform="chatgpt", email="test@example.com", password="password")
        session.add(model)
        session.commit()
        account_id = model.id
    class Plugin:
        def __init__(self, config): self.logger = lambda _: None
        def set_logger(self, logger): self.logger = logger
        def execute_action(self, *args):
            self.logger("Email verification 123456")
            return {"ok": False, "error": "still pending"}
    monkeypatch.setattr(runtime, "load_all", lambda: None)
    monkeypatch.setattr(runtime, "get", lambda _: Plugin)
    messages = []
    command = SimpleNamespace(platform="chatgpt", account_id=account_id,
                              action_id="complete_registration", params={})
    result = runtime.PlatformRuntime().execute_action(command, log_fn=messages.append)
    assert result.ok is False
    assert messages == ["Email verification [code]"]

@pytest.mark.parametrize("console_kind", ["cp1252", "broken_pipe"])
def test_console_failure_cannot_leave_a_durable_task_running(monkeypatch, console_kind):
    class BrokenConsole(io.StringIO):
        def write(self, message):
            raise BrokenPipeError("fixture console is closed")
    sink = io.TextIOWrapper(io.BytesIO(), encoding="cp1252") if console_kind == "cp1252" else BrokenConsole()
    monkeypatch.setattr(tasks, "_execute_proxy_check_task",
        lambda payload, logger: logger.finish(tasks.TASK_STATUS_SUCCEEDED))
    task = tasks.create_proxy_check_task()
    try:
        with monkeypatch.context() as context:
            context.setattr("sys.stdout", sink)
            tasks.execute_task(task["id"])
    finally:
        sink.close()
    result = tasks.get_task(task["id"])
    assert result["status"] == "succeeded" and result["terminal"] is True
    messages = [event["message"] for event in tasks.list_task_events(task["id"])]
    assert "任务已开始执行" in messages
    assert any("任务结束" in message and "succeeded" in message for message in messages)


def test_task_event_persistence_errors_are_not_masked_by_console_handling(monkeypatch):
    def fail(*args, **kwargs):
        raise OSError("fixture durable store unavailable")
    monkeypatch.setattr(tasks, "append_task_event", fail)
    with pytest.raises(OSError, match="durable store unavailable"):
        tasks.TaskLogger("fixture").log("fixture event")


@pytest.mark.parametrize("action_id,method", [("upload_cpa", "upload_to_cpa"), ("upload_tm", "upload_to_team_manager")])
def test_upload_failure_reason_reaches_the_durable_task(client, monkeypatch, action_id, method):
    from platforms.chatgpt import cpa_upload
    reason = "Fixture destination rejected the import"
    monkeypatch.setattr(cpa_upload, method, lambda *args, **kwargs: (False, reason))
    created = client.post("/api/accounts", json={"platform": "chatgpt", "email": "fixture-upload@example.invalid",
        "password": "", "user_id": "fixture-upload-account", "credentials": {"access_token": "fixture-upload-access"}})
    assert created.status_code == 200
    account_id = created.json()["id"]
    before = client.get(f"/api/accounts/{account_id}").json()
    response = client.post(f"/api/actions/chatgpt/{account_id}/{action_id}", json={"params": {
        "api_url": "http://127.0.0.1:1", "api_key": "fixture-destination-key"}})
    assert response.status_code == 200
    task_id = response.json().get("task_id") or response.json().get("id")
    assert task_id
    tasks.execute_task(task_id)
    result = client.get(f"/api/tasks/{task_id}").json()
    assert result["status"] == "failed" and result["error_count"] == 1
    assert result["error"] == reason and result["errors"] == [reason]
    assert client.get(f"/api/accounts/{account_id}").json() == before



