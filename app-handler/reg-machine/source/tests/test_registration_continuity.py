"""Offline checks for continuity, validated recovery, and late OTP generation."""
from types import SimpleNamespace

import pytest
from core.base_platform import AccountStatus, RegisterConfig
from platforms.chatgpt import browser_register as flow
from platforms.chatgpt.plugin import ChatGPTPlatform


def tokens(email="fixture@example.com"):
    return dict(email=email, account_id="fixture-account", access_token="fixture-access",
                refresh_token="fixture-refresh", id_token="fixture-id")


def browser_fixture(monkeypatch):
    page = SimpleNamespace(context=SimpleNamespace(
        cookies=lambda: [{"name": "login_session", "value": "fixture-cookie", "domain": "auth.openai.com"}],
        add_cookies=lambda values: None,
    ))
    opened, closed = [], []
    class Browser:
        def __enter__(self): opened.append("browser"); return self
        def __exit__(self, *args): closed.append("browser"); return False
        def new_page(self): return page
    monkeypatch.setattr(flow, "Camoufox", lambda **kwargs: Browser())
    monkeypatch.setattr(flow, "_browser_registration_flow",
                        lambda *args: {"page_type": "chatgpt_home", "password_set": False})
    return page, opened, closed


def test_signup_and_oauth_share_the_same_open_page(monkeypatch):
    page, opened, closed = browser_fixture(monkeypatch)
    def oauth(current, *args, **kwargs):
        assert current is page and opened == ["browser"] and closed == []
        return tokens()
    monkeypatch.setattr(flow, "_do_codex_oauth", oauth)
    worker = flow.ChatGPTBrowserRegister(headless=True, log_fn=lambda _: None,
                                         security_checkpoint=lambda _: None)
    result = worker.run("fixture@example.com", "")
    assert result["account_id"] == "fixture-account"
    assert opened == closed == ["browser"]


def test_valid_oauth_is_retained_when_security_is_pending():
    data = {**tokens(), "phone_verified": True}
    mapped = ChatGPTPlatform(RegisterConfig())._map_chatgpt_result(
        data, expected_email="fixture@example.com")
    assert mapped.status == AccountStatus.TWO_FA_REQUIRED
    assert mapped.token == ""
    assert mapped.extra["access_token"] == "fixture-access"
    assert mapped.extra["refresh_token"] == "fixture-refresh"
    assert mapped.extra["oauth_email"] == "fixture@example.com"
    with pytest.raises(RuntimeError, match="identity"):
        ChatGPTPlatform(RegisterConfig())._map_chatgpt_result(
            data, expected_email="other@example.com")


@pytest.mark.parametrize("profile_email,use_cache", [
    ("fixture@example.com", True), ("other@example.com", False), ("", False),
])
def test_recovery_reuses_only_remotely_validated_same_account_oauth(monkeypatch, profile_email, use_cache):
    import platforms.chatgpt.switch as switch
    page, opened, closed = browser_fixture(monkeypatch)
    monkeypatch.setattr(switch, "_fetch_profile", lambda *args, **kwargs: (True, {"email": profile_email}))
    calls = []
    def oauth(*args, **kwargs):
        calls.append("oauth")
        return tokens()
    monkeypatch.setattr(flow, "_do_codex_oauth", oauth)
    def security(current, email, password, otp, result, checkpoint, log):
        assert current is page
        result.update(authenticator_verified=True, phone_mfa_disabled=True)
    monkeypatch.setattr(flow, "_complete_chatgpt_security", security)
    worker = flow.ChatGPTBrowserRegister(
        headless=True, log_fn=lambda _: None, security_checkpoint=lambda _: None,
        security_progress={**tokens(), "oauth_email": "fixture@example.com", "phone_verified": True},
    )
    result = worker.run("fixture@example.com", "", resume=True)
    assert calls == ([] if use_cache else ["oauth"])
    assert result["authenticator_verified"] is True


def test_cached_callback_is_not_promoted_without_current_remote_validation(monkeypatch):
    import platforms.chatgpt.switch as switch
    browser_fixture(monkeypatch)
    monkeypatch.setattr(switch, "_fetch_profile", lambda *args, **kwargs: (False, {"status_code": 401}))
    calls = []
    monkeypatch.setattr(flow, "_do_codex_oauth", lambda *args, **kwargs: calls.append("fresh") or None)
    worker = flow.ChatGPTBrowserRegister(
        headless=True, log_fn=lambda _: None, security_checkpoint=lambda _: None,
        security_progress={**tokens(), "oauth_email": "fixture@example.com", "phone_verified": True},
    )
    result = worker.run("fixture@example.com", "", resume=True)
    assert calls == ["fresh"]
    assert result["status"] == "2fa_required"


def test_callable_mfa_code_is_generated_after_input_is_ready(monkeypatch):
    events, listeners = [], {}
    class Target:
        first = property(lambda self: self)
        def wait_for(self, **kwargs): events.append("ready")
        def click(self, **kwargs): events.append("focus")
        def fill(self, value): pass
        def type(self, value, **kwargs): events.append(("typed", value))
        def input_value(self): return "654321"
        def count(self): return 0
    page = SimpleNamespace(
        url="https://auth.openai.com/mfa-challenge/fixture",
        wait_for_load_state=lambda *args, **kwargs: events.append("loaded"),
        locator=lambda *args: Target(), get_by_label=lambda *args: Target(),
        get_by_role=lambda *args, **kwargs: Target(),
        on=lambda name, cb: listeners.update({name: cb}),
        remove_listener=lambda name, cb: listeners.pop(name, None),
    )
    monkeypatch.setattr(flow.time, "sleep", lambda _: None)
    monkeypatch.setattr(flow, "_browser_pause", lambda _: None)
    def submit(current, *args, **kwargs):
        current.url = "http://localhost:1455/auth/callback?code=fixture"
        return "submit"
    monkeypatch.setattr(flow, "_click_first", submit)
    def code():
        assert "ready" in events
        events.append("generated")
        return "654321"
    result = flow._submit_otp_via_page(page, code, lambda _: None, timeout=1)
    assert result["ok"]
    assert ("typed", "654321") in events
    assert events.index("ready") < events.index("generated")
    assert listeners == {}
