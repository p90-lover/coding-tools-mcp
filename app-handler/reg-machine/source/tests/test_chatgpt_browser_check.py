from types import SimpleNamespace

import pytest

from platforms.chatgpt import browser_register as flow


def test_localized_browser_check_waits_before_oauth_state_loop(monkeypatch):
    class Page:
        url = "about:blank"
        checking = True
        waits = 0

        def goto(self, url, **kwargs):
            self.url = "https://auth.openai.com/oauth/authorize"

        def title(self):
            return "Un momento…" if self.checking else "Sign in"

        def evaluate(self, script):
            if "navigator.userAgent" in script:
                return "test-user-agent"
            return self.checking

        def wait_for_timeout(self, delay):
            self.waits += 1
            self.checking = False
            self.url = "http://localhost:1455/auth/callback?code=test-code&state=test-state"

        def screenshot(self, **kwargs):
            pass

    page = Page()
    result = {"account_id": "test-account", "access_token": "test-token"}
    monkeypatch.setattr(flow, "_derive_oauth_state_from_page", lambda page: {"page_type": "", "continue_url": ""})
    monkeypatch.setattr(flow, "_get_page_oauth_url", lambda page: "")
    monkeypatch.setattr(flow, "_extract_auth_error_text", lambda page: "")
    monkeypatch.setattr(flow, "_get_cookies", lambda page: {})
    monkeypatch.setattr(flow, "_complete_oauth_with_session", lambda *args: None)
    monkeypatch.setattr(flow, "_submit_callback_result", lambda *args: result)
    monkeypatch.setattr(flow.time, "sleep", lambda seconds: None)
    assert flow._do_codex_oauth(page, {}, "original@example.com", "", None, None, None, lambda message: None) == result
    assert page.waits == 1


@pytest.mark.parametrize("title, structural_marker, expected", [
    ("Un momento…", True, True),
    ("Un momento…", False, True),
    ("Veuillez patienter…", True, True),
    ("Sign in", False, False),
    ("Iniciar sesión", False, False),
])
def test_browser_check_detection_keeps_normal_sign_in_available(title, structural_marker, expected):
    page = SimpleNamespace(url="https://auth.openai.com/oauth/authorize",
                           title=lambda: title, evaluate=lambda script: structural_marker)
    assert flow._is_openai_browser_check(page) is expected


def test_browser_check_wait_stops_at_existing_bound(monkeypatch):
    page = SimpleNamespace(url="https://auth.openai.com/oauth/authorize",
                           title=lambda: "Un momento…", evaluate=lambda script: True,
                           wait_for_timeout=lambda delay: None)
    times = iter([0, 301])
    monkeypatch.setattr(flow.time, "monotonic", lambda: next(times))
    with pytest.raises(RuntimeError, match="browser check did not clear"):
        flow._wait_for_openai_browser_check(page, lambda message: None)

@pytest.mark.parametrize("cancel_before_wait", [True, False])
def test_browser_check_honors_task_cancellation(monkeypatch, cancel_before_wait):
    class Logger:
        cancelled = cancel_before_wait
        def log(self, message): pass
        def is_cancel_requested(self): return self.cancelled
    logger = Logger()
    waits, now = [], [0]
    def wait(delay):
        waits.append(delay)
        now[0] += 1
        logger.cancelled = True
    monkeypatch.setattr(flow.time, "monotonic", lambda: now[0])
    page = SimpleNamespace(wait_for_timeout=wait)
    monkeypatch.setattr(flow, "_is_openai_browser_check", lambda page: True)
    with pytest.raises(RuntimeError, match="registration_cancelled"):
        flow._wait_for_openai_browser_check(page, logger.log, timeout=2)
    assert len(waits) == (0 if cancel_before_wait else 1)
