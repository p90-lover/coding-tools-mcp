from __future__ import annotations

import threading

from services.solver_manager import _disabled, get_status, restart

_restart_lock = threading.Lock()


class SystemRuntime:
    def solver_status(self) -> dict:
        return {**get_status(), "restarting": _restart_lock.locked()}

    def restart_solver(self) -> dict:
        if _disabled():
            return {"ok": False, "disabled": True, "message": "本地求解器已通过环境配置禁用"}
        if not _restart_lock.acquire(blocking=False):
            return {"ok": True, "restarting": True, "message": "重启已在进行中"}

        def run_restart():
            try:
                restart()
            finally:
                _restart_lock.release()

        try:
            threading.Thread(target=run_restart, daemon=True).start()
        except Exception:
            _restart_lock.release()
            raise
        return {"ok": True, "restarting": True, "message": "重启中"}
