"""Owned desktop entrypoint; the source snapshot remains unchanged."""
from __future__ import annotations

import argparse
from contextlib import asynccontextmanager
import hashlib
import hmac
import os
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parent
SOURCE = ROOT / "source"
sys.path.insert(0, str(SOURCE))


def run():
    if os.environ.get("CAMOUFOX_CACHE_DIR"):
        from browser_runtime import configure
        pkgman = configure(os.environ["CAMOUFOX_CACHE_DIR"])
        os.environ["REG_MACHINE_CAMOUFOX_EXECUTABLE"] = pkgman.launch_path()
    if "--verify-browsers" in sys.argv:
        from playwright.sync_api import sync_playwright
        from patchright.sync_api import sync_playwright as sync_patchright
        for launch in (sync_playwright, sync_patchright):
            with launch() as runtime:
                browser = runtime.chromium.launch(headless=True)
                try:
                    page = browser.new_page()
                    page.context.set_offline(True)
                    page.goto("data:text/html,<title>Register runtime</title>")
                    assert page.title() == "Register runtime"
                finally:
                    browser.close()
        from camoufox.sync_api import Camoufox
        with Camoufox(headless=True, geoip=False) as browser:
            page = browser.new_page()
            page.context.set_offline(True)
            page.goto("data:text/html,<title>Register runtime</title>")
            assert page.title() == "Register runtime"
        print("Register browser runtimes verified")
        return
    if len(sys.argv) > 1 and sys.argv[1] == "--solver":
        sys.argv = [sys.argv[0]] + sys.argv[2:]
        from services.turnstile_solver.start import main as solver_main
        solver_main()
        return
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, required=True)
    options = parser.parse_args()
    password = os.environ.get("APP_PASSWORD", "")
    instance = os.environ.get("CODING_TOOLS_REGISTER_INSTANCE", "")
    if not password or not instance:
        raise RuntimeError("Register must be launched by Coding Tools")
    from fastapi.responses import JSONResponse
    from main import app, lifespan
    from customer_portal_api.main import app as portal, lifespan as portal_lifespan

    @asynccontextmanager
    async def desktop_lifespan(application):
        async with lifespan(application):
            async with portal_lifespan(portal):
                try:
                    yield
                finally:
                    from services.solver_manager import stop
                    stop()

    app.router.lifespan_context = desktop_lifespan
    app.mount("/portal", portal)
    # The SPA fallback must remain last, otherwise it captures portal endpoints.
    for route in list(app.router.routes):
        if getattr(route, "path", None) == "/{full_path:path}":
            app.router.routes.remove(route)
            app.router.routes.append(route)

    token = hashlib.sha256(("reg-machine-auth\0" + password).encode()).hexdigest()

    @app.middleware("http")
    async def desktop_session(request, call_next):
        if request.url.path == "/api/desktop/health":
            return JSONResponse({"instance": instance})
        bearer = request.headers.get("authorization", "").removeprefix("Bearer ")
        if (request.method == "POST" and request.url.path == "/api/solver/restart"
                and hmac.compare_digest(bearer, token)):
            os.environ.pop("ANY_AUTO_DISABLE_SOLVER", None)
        if request.url.path == "/api/auth/check":
            if hmac.compare_digest(bearer, token):
                return JSONResponse({"required": True, "authenticated": True})
        return await call_next(request)

    import uvicorn
    uvicorn.run(app, host="127.0.0.1", port=options.port, access_log=False, log_level="warning")


if __name__ == "__main__":
    run()
