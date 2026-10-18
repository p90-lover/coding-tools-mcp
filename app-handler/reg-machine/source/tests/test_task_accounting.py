import asyncio
import importlib
import json
import threading
import time
from types import SimpleNamespace

import pytest

from application import tasks
from core.base_platform import Account, AccountStatus
from core.proxy_pool import proxy_pool



def test_registration_instance_startup_failure_counts_each_attempt(monkeypatch):
    monkeypatch.setattr(tasks, "_resolve_sms_provider_for_task", lambda _: ("", {}))
    monkeypatch.setattr(tasks, "get", lambda _: object())
    def fail(*args, **kwargs):
        raise RuntimeError("fixture platform startup failed")
    monkeypatch.setattr(tasks, "_build_platform_instance", fail)
    monkeypatch.setattr(tasks, "_save_task_log", lambda *args, **kwargs: None)
    monkeypatch.setattr(proxy_pool, "get_next", lambda **kwargs: None)
    task = tasks.create_register_task({
        "platform": "chatgpt", "count": 2, "extra": {"identity_provider": "oauth_browser"},
    })
    tasks.execute_task(task["id"])
    result = tasks.get_task(task["id"])
    assert result["status"] == "failed"
    assert (result["progress"], result["success"], result["error_count"]) == ("2/2", 0, 2)
    assert len(result["errors"]) == 2


def test_registration_mailbox_startup_failure_has_a_visible_error_count(monkeypatch):
    from core import base_mailbox
    monkeypatch.setattr(tasks, "_resolve_sms_provider_for_task", lambda _: ("", {}))
    monkeypatch.setattr(tasks, "get", lambda _: object())
    def fail(*args, **kwargs):
        raise RuntimeError("fixture mailbox startup failed")
    monkeypatch.setattr(base_mailbox, "create_mailbox", fail)
    monkeypatch.setattr(proxy_pool, "get_next", lambda **kwargs: None)
    task = tasks.create_register_task({
        "platform": "chatgpt", "count": 1,
        "extra": {"identity_provider": "mailbox", "mail_provider": "fixture"},
    })
    tasks.execute_task(task["id"])
    result = tasks.get_task(task["id"])
    assert result["status"] == "failed"
    assert result["error_count"] == 1
    assert result["errors"] == ["邮箱初始化失败: fixture mailbox startup failed"]


def test_startup_interrupts_stale_jobs_and_retains_progress():
    pending = tasks.create_register_task({"platform": "chatgpt", "count": 3})
    running = tasks.create_platform_action_task({"platform": "chatgpt", "account_id": 17,
                                               "action_id": "complete_registration"})
    tasks.TaskLogger(running["id"]).mark_running()
    tasks.TaskLogger(running["id"]).set_progress(1, 3)
    tasks.mark_incomplete_tasks_interrupted()
    for original in (pending, running):
        record = tasks.get_task(original["id"])
        assert record["status"] == "interrupted"
        events = tasks.list_task_events(original["id"])
        assert any("服务重启后" in e["message"] for e in events)
    assert tasks.get_task(running["id"])["progress"] == "1/3"


@pytest.mark.parametrize("pending_status", [AccountStatus.PHONE_REQUIRED, AccountStatus.TWO_FA_REQUIRED])
def test_pending_registration_counts_unfinished_attempt(monkeypatch, pending_status):
    account = Account(platform="chatgpt", email="pending@example.com", password="", status=pending_status)
    monkeypatch.setattr(tasks, "_resolve_sms_provider_for_task", lambda _: ("", {}))
    monkeypatch.setattr(tasks, "get", lambda _: object())
    monkeypatch.setattr(tasks, "_build_platform_instance",
                        lambda *args, **kwargs: SimpleNamespace(register=lambda **_: account))
    monkeypatch.setattr(tasks, "save_account", lambda _: None)
    monkeypatch.setattr(tasks, "_save_task_log", lambda *args, **kwargs: None)
    monkeypatch.setattr(proxy_pool, "get_next", lambda **kwargs: None)
    task = tasks.create_register_task({
        "platform": "chatgpt", "count": 1, "extra": {"identity_provider": "oauth_browser"},
    })
    tasks.execute_task(task["task_id"])
    result = tasks.get_task(task["task_id"])
    assert result["status"] == "failed"
    assert result["progress"] == "1/1"
    assert result["success"] == 0
    assert result["error_count"] == 1
    assert len(result["errors"]) == 1
    assert result["errors"][0].startswith(pending_status.value + ":")


@pytest.mark.parametrize("ok", [True, False])
def test_single_action_counts_completed_attempt(monkeypatch, ok):
    class Runtime:
        def execute_action(self, command, *, log_fn=None):
            return SimpleNamespace(ok=ok, data={}, error="" if ok else "still pending")
    monkeypatch.setattr(tasks, "PlatformRuntime", Runtime)
    task = tasks.create_platform_action_task({
        "platform": "chatgpt", "account_id": 42, "action_id": "complete_registration",
    })
    tasks.execute_task(task["task_id"])
    result = tasks.get_task(task["task_id"])
    assert result["status"] == ("succeeded" if ok else "failed")
    assert result["progress"] == "1/1"
    assert result["success"] == int(ok)
    assert result["error_count"] == int(not ok)


@pytest.mark.parametrize("ok", [True, False])
def test_single_action_preserves_cancel_requested_during_runtime(monkeypatch, ok):
    class Runtime:
        def execute_action(self, command, *, log_fn=None):
            tasks.request_cancel(task["task_id"])
            return SimpleNamespace(ok=ok, data={}, error="" if ok else "registration_cancelled")
    monkeypatch.setattr(tasks, "PlatformRuntime", Runtime)
    task = tasks.create_platform_action_task({
        "platform": "chatgpt", "account_id": 42, "action_id": "complete_registration",
    })
    tasks.execute_task(task["task_id"])
    result = tasks.get_task(task["task_id"])
    assert result["status"] == "cancelled"
    assert result["success"] == 0
    assert result["error_count"] == 0


@pytest.mark.parametrize("cancel", [False, True])
def test_uncaught_handler_exception_finishes_task(monkeypatch, cancel):
    class Runtime:
        def execute_action(self, command, *, log_fn=None):
            if cancel:
                tasks.request_cancel(task["task_id"])
            raise RuntimeError("fixture action startup failed")
    monkeypatch.setattr(tasks, "PlatformRuntime", Runtime)
    task = tasks.create_platform_action_task({
        "platform": "chatgpt", "account_id": 42, "action_id": "complete_registration",
    })
    tasks.execute_task(task["task_id"])
    result = tasks.get_task(task["task_id"])
    assert result["status"] == ("cancelled" if cancel else "failed")
    assert result["terminal"] is True
    assert result["error_count"] == int(not cancel)


@pytest.fixture
def runtime_queue(monkeypatch):
    module = importlib.import_module("services.task_runtime")
    idle = threading.Event()
    blocked = threading.Event()
    original_claim = module.claim_next_runnable_task

    def observe_claim(**kwargs):
        result = original_claim(**kwargs)
        if result is None:
            idle.set()
            if kwargs.get("running_platform_counts"):
                blocked.set()
        return result

    monkeypatch.setattr(module, "claim_next_runnable_task", observe_claim)
    return SimpleNamespace(module=module, idle=idle, blocked=blocked)


@pytest.mark.parametrize("sample", range(3))
def test_action_dispatch_wakes_immediately(monkeypatch, runtime_queue, sample):
    module = runtime_queue.module
    completed = threading.Event()

    def execute(task_id):
        tasks.TaskLogger(task_id).finish(tasks.TASK_STATUS_SUCCEEDED)
        completed.set()

    monkeypatch.setattr(module, "execute_task", execute)
    runtime = module.TaskRuntime()
    runtime.start()
    try:
        assert runtime_queue.idle.wait(2)
        task = tasks.create_platform_action_task({
            "platform": "fixture", "account_id": 101, "action_id": "noop",
        })
        submitted_at = time.monotonic()
        runtime.wake_up()
        assert completed.wait(2)
        latency = time.monotonic() - submitted_at
        print(f"dispatch_latency_ms[{sample}]={latency * 1000:.2f}")
        assert tasks.get_task(task["id"])["status"] == "succeeded"
        assert latency < 0.2
    finally:
        runtime.stop()
        with runtime._lock:
            workers = [state.thread for state in runtime._workers.values()]
        runtime._dispatcher.join(2)
        for worker in workers:
            worker.join(2)


def test_worker_release_wakes_next_task_without_parallelizing_platform(monkeypatch, runtime_queue):
    module = runtime_queue.module
    first_started = threading.Event()
    second_started = threading.Event()
    release_first = threading.Event()
    calls = []

    def execute(task_id):
        calls.append(task_id)
        if len(calls) == 1:
            first_started.set()
            release_first.wait(5)
        else:
            second_started.set()
        tasks.TaskLogger(task_id).finish(tasks.TASK_STATUS_SUCCEEDED)

    monkeypatch.setattr(module, "execute_task", execute)
    runtime = module.TaskRuntime(max_parallel_tasks=2, max_parallel_per_platform=1, poll_interval=2)
    runtime.start()
    try:
        assert runtime_queue.idle.wait(2)
        first = tasks.create_platform_action_task({
            "platform": "fixture", "account_id": 101, "action_id": "noop",
        })
        second = tasks.create_platform_action_task({
            "platform": "fixture", "account_id": 102, "action_id": "noop",
        })
        runtime.wake_up()
        assert first_started.wait(3)
        assert runtime_queue.blocked.wait(3)
        assert not second_started.is_set()
        release_first.set()
        assert second_started.wait(0.5)
        assert calls == [first["id"], second["id"]]
    finally:
        release_first.set()
        runtime.stop()
        with runtime._lock:
            workers = [state.thread for state in runtime._workers.values()]
        runtime._dispatcher.join(3)
        for worker in workers:
            worker.join(3)


def test_runtime_stop_interrupts_idle_dispatch_wait(runtime_queue):
    runtime = runtime_queue.module.TaskRuntime(poll_interval=2)
    runtime.start()
    try:
        assert runtime_queue.idle.wait(2)
        runtime.stop()
        runtime._dispatcher.join(0.5)
        assert not runtime._dispatcher.is_alive()
    finally:
        runtime.stop()
        runtime._dispatcher.join(3)


def test_stream_pushes_changed_public_task_snapshots_without_credentials(monkeypatch):
    from application import task_commands
    progress = [
        ("pending", 0), ("running", 1), ("running", 1), ("succeeded", 2),
    ]
    snapshots = iter({
        "status": status, "progress": f"{current}/2",
        "updated_at": f"2026-10-17T00:00:0{current}Z",
        "progress_detail": {"current": current, "total": 2, "label": f"{current}/2"},
        "payload": {"private": "private-payload-marker"},
        "result": {"access_token": "private-token-marker"},
    } for status, current in progress)
    monkeypatch.setattr(task_commands, "get_task", lambda _: next(snapshots))
    monkeypatch.setattr(task_commands, "list_task_events", lambda *args, **kwargs: [])
    original_sleep = asyncio.sleep

    async def immediate_sleep(_):
        await original_sleep(0)

    monkeypatch.setattr(task_commands.asyncio, "sleep", immediate_sleep)

    async def collect():
        return [chunk async for chunk in task_commands.TaskCommandsService().stream_task_events("fixture")]

    chunks = asyncio.run(collect())
    frames = [json.loads(chunk.removeprefix("data: ")) for chunk in chunks if chunk.startswith("data: ")]
    task_frames = [frame["task"] for frame in frames if "task" in frame]
    assert [item["status"] for item in task_frames] == ["pending", "running", "succeeded"]
    assert task_frames[1]["progress_detail"]["current"] == 1
    assert all(set(item) == {"status", "progress", "progress_detail", "updated_at"} for item in task_frames)
    assert [item["updated_at"] for item in task_frames] == [
        "2026-10-17T00:00:00Z", "2026-10-17T00:00:01Z", "2026-10-17T00:00:02Z"]
    assert frames[-1]["done"] is True
    assert "private-payload-marker" not in "".join(chunks)
    assert "private-token-marker" not in "".join(chunks)

@pytest.mark.parametrize("platform,expected_total", [("chatgpt", 61), ("", 65), ("kiro", 0)])
def test_check_all_api_includes_accounts_beyond_fifty(client, monkeypatch, platform, expected_total):
    from core.db import AccountModel, engine
    from sqlmodel import Session

    with Session(engine) as session:
        for index in range(65):
            session.add(AccountModel(platform="chatgpt" if index < 61 else "grok",
                                     email=f"fixture-check-{index}@example.invalid", password=""))
        session.commit()
    checked = []
    monkeypatch.setattr(tasks, "_run_single_account_check",
                        lambda account_id, logger: (checked.append(account_id) is None, {}))
    response = client.post("/api/accounts/check-all", params={"platform": platform})
    assert response.status_code == 200
    task = response.json()
    assert task["progress"] == f"0/{expected_total}"
    tasks.execute_task(task["id"])
    result = tasks.get_task(task["id"])
    assert result["status"] == "succeeded"
    assert len(checked) == len(set(checked)) == expected_total
    assert result["progress"] == f"{expected_total}/{expected_total}"
    assert result["data"] == {"valid": expected_total, "invalid": 0, "error": 0}


def test_check_all_keeps_an_explicit_limit(monkeypatch):
    from core.db import AccountModel, engine
    from sqlmodel import Session

    with Session(engine) as session:
        for index in range(12):
            session.add(AccountModel(platform="chatgpt", email=f"fixture-limit-{index}@example.invalid",
                                     password=""))
        session.commit()
    checked = []
    monkeypatch.setattr(tasks, "_run_single_account_check",
                        lambda account_id, logger: (checked.append(account_id) is None, {}))
    task = tasks.create_account_check_all_task("chatgpt", limit=7)
    assert task["progress"] == "0/7"
    tasks.execute_task(task["id"])
    result = tasks.get_task(task["id"])
    assert len(checked) == 7 and len(set(checked)) == 7
    assert result["progress"] == "7/7"
    assert result["data"] == {"valid": 7, "invalid": 0, "error": 0}


def test_saved_log_list_route_keeps_filter_pagination_and_task_lookup(client):
    from core.db import TaskLog, engine
    from sqlmodel import Session
    with Session(engine) as session:
        for index in range(5):
            session.add(TaskLog(platform="chatgpt" if index < 4 else "grok",
                email=f"fixture-{index}@example.invalid", status="success",
                detail_json=json.dumps({"stage": "fixture-saved"})))
        session.commit()
    task = tasks.create_proxy_check_task()
    response = client.get("/api/tasks/logs", params={"platform": "chatgpt", "page": 2, "page_size": 2})
    assert response.status_code == 200
    payload = response.json()
    assert (payload["total"], payload["page"]) == (4, 2)
    assert [entry["email"] for entry in payload["items"]] == ["fixture-1@example.invalid", "fixture-0@example.invalid"]
    assert all(entry["detail"] == {"stage": "fixture-saved"} for entry in payload["items"])
    assert client.get(f"/api/tasks/{task['id']}").json()["id"] == task["id"]
    assert client.get("/api/tasks/fixture-missing").status_code == 404
    empty = client.get("/api/tasks/logs", params={"platform": "kiro"}).json()
    assert empty["total"] == 0 and empty["items"] == []


def test_saved_log_pagination_reports_the_effective_page(client):
    from core.db import TaskLog, engine
    from sqlmodel import Session
    with Session(engine) as session:
        session.add(TaskLog(platform="chatgpt", email="fixture@example.invalid", status="success"))
        session.commit()
    response = client.get("/api/tasks/logs", params={"page": 0, "page_size": 0})
    assert response.status_code == 200
    payload = response.json()
    assert payload["page"] == 1
    assert payload["total"] == len(payload["items"]) == 1

def test_stream_database_reads_leave_the_event_loop_responsive(monkeypatch):
    from application import task_commands
    main_thread = threading.get_ident()
    read_started = threading.Event()
    release_read = threading.Event()
    read_threads = []

    def read_events(*args, **kwargs):
        read_threads.append(threading.get_ident())
        read_started.set()
        release_read.wait(1)
        return []

    def read_task(_):
        read_threads.append(threading.get_ident())
        return {"status": "running", "progress": "0/1", "updated_at": "fixture"}

    monkeypatch.setattr(task_commands, "list_task_events", read_events)
    monkeypatch.setattr(task_commands, "get_task", read_task)

    async def exercise():
        stream = task_commands.TaskCommandsService().stream_task_events("fixture")
        await anext(stream)
        await anext(stream)
        pending = asyncio.create_task(anext(stream))
        try:
            started = await asyncio.to_thread(read_started.wait, 0.5)
            responsive = started and not pending.done()
            release_read.set()
            await pending
            assert responsive, "Database reads blocked the event loop until completion"
        finally:
            release_read.set()
            await pending
            await stream.aclose()

    asyncio.run(exercise())
    assert read_threads and all(thread != main_thread for thread in read_threads)


def test_stream_drains_full_batches_without_the_idle_poll_delay(monkeypatch):
    from application import task_commands
    events = [{"id": number, "line": f"event {number}"} for number in range(1, 451)]
    last_batch = []
    waits = []
    original_sleep = asyncio.sleep

    def read_events(_, *, since, limit):
        last_batch[:] = [event for event in events if event["id"] > since][:limit]
        return list(last_batch)

    def read_task(_):
        return {"status": "running" if last_batch else "succeeded", "progress": "1/1"}

    async def record_sleep(delay):
        waits.append(delay)
        await original_sleep(0)

    monkeypatch.setattr(task_commands, "list_task_events", read_events)
    monkeypatch.setattr(task_commands, "get_task", read_task)
    monkeypatch.setattr(task_commands.asyncio, "sleep", record_sleep)

    async def collect():
        return [chunk async for chunk in task_commands.TaskCommandsService().stream_task_events("fixture")]

    frames = [json.loads(chunk[6:]) for chunk in asyncio.run(collect()) if chunk.startswith("data: ")]
    assert [frame["id"] for frame in frames if "id" in frame] == list(range(1, 451))
    assert waits == [0, 0, 0.5]
    assert frames[-1]["done"] is True


def test_stream_endpoint_initial_lookup_runs_outside_the_event_loop(client, monkeypatch):
    from api import task_commands

    lookup_on_event_loop = []

    def read_task(_):
        try:
            asyncio.get_running_loop()
        except RuntimeError:
            lookup_on_event_loop.append(False)
        else:
            lookup_on_event_loop.append(True)
        return {"id": "fixture", "status": "succeeded"}

    async def stream(*args, **kwargs):
        yield 'data: {"done": true, "status": "succeeded"}\n\n'

    monkeypatch.setattr(task_commands.query_service, "get_task", read_task)
    monkeypatch.setattr(task_commands.command_service, "stream_task_events", stream)
    response = client.get("/api/tasks/fixture/logs/stream")
    assert response.status_code == 200
    assert json.loads(response.text.removeprefix("data: "))["done"] is True
    assert lookup_on_event_loop == [False]



