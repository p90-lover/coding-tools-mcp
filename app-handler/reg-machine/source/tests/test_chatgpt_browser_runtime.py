"""Offline coverage for the project-managed Camoufox runtime."""
from types import SimpleNamespace

import pytest

from platforms.chatgpt import browser_register as flow


def write_runtime(directory, version="156.0.1-beta.36"):
    directory.mkdir(parents=True, exist_ok=True)
    executable = directory / "camoufox.exe"
    executable.write_bytes(b"fixture runtime; never executed")
    (directory / "application.ini").write_text(f"[App]\nVersion={version}\n", encoding="utf-8")
    return executable


@pytest.fixture
def runtime(monkeypatch, tmp_path):
    binary = write_runtime(tmp_path / "runtime")
    monkeypatch.setenv("REG_MACHINE_CAMOUFOX_EXECUTABLE", str(binary))
    return binary


@pytest.mark.parametrize("headless", [True, False])
@pytest.mark.parametrize("action", ["login", "signup", "recovery"])
def test_browser_runtime_reaches_every_launch_path(monkeypatch, runtime, headless, action):
    launches = []
    page = SimpleNamespace(context=SimpleNamespace(cookies=lambda: [], add_cookies=lambda _: None))

    class Browser:
        def __init__(self, **options):
            launches.append(options)

        def __enter__(self):
            return SimpleNamespace(new_page=lambda: page)

        def __exit__(self, *args):
            return False

    class StopBeforeOAuth(Exception):
        pass

    def oauth(*args, **kwargs):
        raise StopBeforeOAuth()

    monkeypatch.setattr(flow, "Camoufox", Browser)
    monkeypatch.setattr(flow, "_do_codex_oauth", oauth)
    monkeypatch.setattr(flow, "_get_cookies", lambda _: {})
    monkeypatch.setattr(flow, "_browser_registration_flow", lambda *args: {"page_type": "fixture"})
    worker = flow.ChatGPTBrowserRegister(headless=headless, proxy="http://127.0.0.1:17891", log_fn=lambda _: None)
    worker._complete_oauth_in_page = lambda *args: {"fixture": True}
    if action == "login":
        with pytest.raises(StopBeforeOAuth):
            worker.login("fixture@example.invalid", "")
    else:
        worker.run("fixture@example.invalid", "", resume=action == "recovery")
    assert launches == [{"headless": headless, "main_world_eval": True,
        "executable_path": str(runtime), "ff_version": 156,
        "proxy": {"server": "http://127.0.0.1:17891"}, "geoip": True}]


def test_browser_runtime_uses_managed_bundle_for_any_server_entrypoint(monkeypatch, tmp_path):
    monkeypatch.delenv("REG_MACHINE_CAMOUFOX_EXECUTABLE", raising=False)
    monkeypatch.setattr(flow, "__file__", str(tmp_path / "platforms/chatgpt/browser_register.py"))
    binary = write_runtime(tmp_path / ".venv/camoufox-browser")
    options = flow.ChatGPTBrowserRegister(headless=True)._launch_options()
    assert options["executable_path"] == str(binary)
    assert options["ff_version"] == 156


def test_browser_runtime_keeps_sdk_default_without_a_managed_bundle(monkeypatch, tmp_path):
    monkeypatch.delenv("REG_MACHINE_CAMOUFOX_EXECUTABLE", raising=False)
    monkeypatch.setattr(flow, "__file__", str(tmp_path / "platforms/chatgpt/browser_register.py"))
    assert flow.ChatGPTBrowserRegister(headless=False)._launch_options() == {
        "headless": False, "main_world_eval": True}


def test_browser_runtime_rejects_missing_override(monkeypatch, tmp_path):
    monkeypatch.setenv("REG_MACHINE_CAMOUFOX_EXECUTABLE", str(tmp_path / "missing.exe"))
    with pytest.raises(RuntimeError, match="runtime is unavailable"):
        flow.ChatGPTBrowserRegister(headless=True)._launch_options()


def test_browser_runtime_rejects_missing_version_metadata(monkeypatch, runtime):
    runtime.with_name("application.ini").write_text("[App]\n", encoding="utf-8")
    with pytest.raises(RuntimeError, match="runtime version is unavailable"):
        flow.ChatGPTBrowserRegister(headless=True)._launch_options()


def test_browser_input_wait_uses_native_visibility_and_selector_priority(monkeypatch):
    calls = []

    class Page:
        ready = False

        def wait_for_selector(self, selector, **options):
            calls.append((selector, options))
            self.ready = True

        def query_selector(self, selector):
            return object() if self.ready and selector == "input#preferred:visible" else None

    monkeypatch.setattr(flow.time, "sleep", lambda *_: pytest.fail("Input readiness must use the browser wait"))
    assert flow._wait_for_any_selector(Page(), ["input#preferred", "input#other"], timeout=2) == "input#preferred:visible"
    assert calls == [("input#preferred:visible, input#other:visible", {"state": "visible", "timeout": 2000})]


def test_browser_input_wait_preserves_timeouts_and_empty_inputs(monkeypatch):
    from playwright.sync_api import TimeoutError
    calls = []

    class Page:
        def wait_for_selector(self, selector, **options):
            calls.append(options["timeout"])
            raise TimeoutError("Fixture input never appeared")

        def query_selector(self, selector):
            return None

    monkeypatch.setattr(flow.time, "sleep", lambda *_: pytest.fail("Input readiness must use the browser wait"))
    page = Page()
    assert flow._wait_for_any_selector(page, ["input"], timeout=0.2) is None
    assert flow._wait_for_any_selector(page, ["input"], timeout=0) is None
    assert flow._wait_for_any_selector(page, [], timeout=1) is None
    assert calls == [200]

