from unittest.mock import patch

from services import solver_manager



def test_disabled_solver_status_is_explicit_without_probing_a_service(monkeypatch):
    import pytest
    monkeypatch.setenv("ANY_AUTO_DISABLE_SOLVER", "1")
    monkeypatch.setattr(solver_manager, "is_running", lambda: pytest.fail("disabled service was probed"))
    status = solver_manager.get_status()
    assert status["disabled"] is True
    assert status["running"] is False


def test_disabled_restart_is_rejected_without_starting_a_thread(monkeypatch):
    import threading
    from infrastructure.system_runtime import SystemRuntime
    monkeypatch.setenv("ANY_AUTO_DISABLE_SOLVER", "1")
    with patch.object(threading, "Thread") as thread:
        result = SystemRuntime().restart_solver()
    thread.assert_not_called()
    assert result["ok"] is False and result["disabled"] is True


def test_solver_restarts_share_one_active_operation(monkeypatch):
    import threading
    from infrastructure import system_runtime
    monkeypatch.delenv("ANY_AUTO_DISABLE_SOLVER", raising=False)
    monkeypatch.setattr(system_runtime, "_restart_lock", threading.Lock(), raising=False)
    targets, calls = [], []
    class Thread:
        def __init__(self, *, target, daemon):
            targets.append(target)
        def start(self):
            pass
    monkeypatch.setattr(threading, "Thread", Thread)
    monkeypatch.setattr(system_runtime, "restart", lambda: calls.append("restart"))
    monkeypatch.setattr(system_runtime, "get_status", lambda: {"running": False})
    runtime = system_runtime.SystemRuntime()
    first = runtime.restart_solver()
    second = runtime.restart_solver()
    assert len(targets) == 1
    assert first["restarting"] is True and second["restarting"] is True
    assert runtime.solver_status()["restarting"] is True
    targets[0]()
    assert calls == ["restart"]
    assert runtime.solver_status()["restarting"] is False


def test_nova_mode_disables_solver_start_stop_and_restart(monkeypatch):
    monkeypatch.setenv("ANY_AUTO_DISABLE_SOLVER", "1")
    with (
        patch.object(solver_manager, "is_running") as running,
        patch.object(solver_manager, "_ensure_camoufox_browser") as fetch,
        patch.object(solver_manager, "_kill_by_port") as kill,
    ):
        solver_manager.start()
        solver_manager.stop()
        solver_manager.restart()
    running.assert_not_called()
    fetch.assert_not_called()
    kill.assert_not_called()
