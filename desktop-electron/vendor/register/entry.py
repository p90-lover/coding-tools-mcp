"""Relocatable Register service entry point. Set all storage before importing the app."""
from __future__ import annotations

import argparse
import os
from pathlib import Path
import sys


def configure_runtime() -> Path:
    configured = os.environ.get("CT_REGISTER_DATA_DIR") or os.environ.get("ACCOUNT_MANAGER_DATA_DIR")
    if not configured or not Path(configured).is_absolute():
        raise RuntimeError("Register requires an absolute managed data directory")
    data = Path(configured).resolve()
    data.mkdir(parents=True, exist_ok=True)
    os.environ["CT_REGISTER_DATA_DIR"] = str(data)
    os.environ["ACCOUNT_MANAGER_DATA_DIR"] = str(data)
    os.environ.setdefault("ACCOUNT_MANAGER_DATABASE_URL", "sqlite:///" + (data / "account_manager.db").as_posix())
    os.environ["PYTHONUTF8"] = "1"
    os.environ["PYTHONDONTWRITEBYTECODE"] = "1"
    sys.dont_write_bytecode = True
    os.chdir(data)
    sys.path.insert(0, str(Path(getattr(sys, "_MEIPASS", Path(__file__).resolve().parent)) / "app"))
    frozen_root = Path(sys.executable).resolve().parent if getattr(sys, "frozen", False) else None
    if frozen_root:
        os.environ["PLAYWRIGHT_BROWSERS_PATH"] = str(frozen_root / "browsers" / "playwright")
        browser = frozen_root / "browsers" / "camoufox"
        executable = browser / ("camoufox.exe" if sys.platform == "win32" else
                                "Camoufox.app/Contents/MacOS/camoufox" if sys.platform == "darwin" else "camoufox-bin")
        os.environ["REG_MACHINE_CAMOUFOX_EXECUTABLE"] = str(executable)
        # Camoufox's package manager otherwise selects or installs a browser in the user's cache.
        import camoufox.pkgman as pkgman
        pkgman.camoufox_path = lambda download_if_missing=True: browser
        pkgman.installed_verstr = lambda: "158.0-beta.40"
        import camoufox.utils as utils
        utils.installed_verstr = pkgman.installed_verstr
        import camoufox.addons as addons
        addons.ADDONS_DIR = data / "browser-addons"
        import camoufox.geolocation as geolocation
        geolocation.GEOIP_DIR = data / "browser-geoip"
        geolocation.MMDB_DIR = geolocation.GEOIP_DIR / "mmdb"
        geolocation.GEOIP_CONFIG = geolocation.GEOIP_DIR / "config.yml"
    return data


def main() -> None:
    configure_runtime()
    if len(sys.argv) > 1 and sys.argv[1] == "--solver":
        sys.argv = [sys.argv[0]] + sys.argv[2:]
        if "--host" not in sys.argv:
            sys.argv.extend(["--host", "127.0.0.1"])
        from services.turnstile_solver.start import main as solver_main
        solver_main()
        return
    parser = argparse.ArgumentParser(description="Coding Tools Register service")
    parser.add_argument("--host", choices=["127.0.0.1"], default="127.0.0.1")
    parser.add_argument("--port", type=int, required=True)
    parser.add_argument("--offline-smoke", action="store_true", help="Initialize isolated data without starting background workers")
    parser.add_argument("--verify-browsers", action="store_true", help="Verify bundled engines on offline synthetic pages")
    arguments = parser.parse_args()
    if not 1 <= arguments.port <= 65535 or not os.environ.get("APP_PASSWORD", "").strip():
        parser.error("A valid port and native APP_PASSWORD are required")
    if arguments.verify_browsers:
        import importlib
        import json
        from camoufox.sync_api import Camoufox
        from camoufox.addons import DefaultAddons
        verified = []
        with Camoufox(headless=True, geoip=False, exclude_addons=list(DefaultAddons)) as browser:
            context = browser.new_context()
            context.set_offline(True)
            page = context.new_page()
            page.set_content("<title>Register browser verification</title>")
            assert page.title() == "Register browser verification"
            verified.append({"engine": "camoufox", "version": browser.version})
            context.close()
        for name in ("playwright", "patchright"):
            module = importlib.import_module(name + ".sync_api")
            with module.sync_playwright() as playwright:
                browser = playwright.chromium.launch(headless=True)
                context = browser.new_context()
                context.set_offline(True)
                page = context.new_page()
                page.set_content("<title>Register browser verification</title>")
                assert page.title() == "Register browser verification"
                verified.append({"engine": name, "version": browser.version})
                context.close()
                browser.close()
        print(json.dumps({"ok": True, "browsers": verified}))
        return
    import uvicorn
    from main import app
    if arguments.offline_smoke:
        from core.db import init_db
        from core.registry import load_all
        from providers.registry import load_all as load_providers
        init_db()
        load_all()
        load_providers()
    uvicorn.run(app, host=arguments.host, port=arguments.port,
                lifespan="off" if arguments.offline_smoke else "on", access_log=False)


if __name__ == "__main__":
    main()
