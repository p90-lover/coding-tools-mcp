from __future__ import annotations

from types import SimpleNamespace
import importlib
import pytest

from platforms.chatgpt import browser_register as browser


def test_browser_finishes_security_before_returning_oauth(monkeypatch):
    page = SimpleNamespace(context=SimpleNamespace(cookies=lambda: [{"name": "login_session", "value": "test-session", "domain": "auth.openai.com", "path": "/"}]))
    class Context:
        def __enter__(self): return self
        def __exit__(self, *args): return False
        def new_page(self): return page
    monkeypatch.setattr(browser, "Camoufox", lambda **kwargs: Context())
    monkeypatch.setattr(browser, "_do_codex_oauth", lambda *args, **kwargs: {"account_id": "account", "access_token": "token",
                         "email": "test@example.com", "refresh_token": "test-refresh", "id_token": "test-id"})
    called = []
    checkpoints = []
    def complete(page, email, password, otp_callback, result, checkpoint, log):
        called.append(email)
        result.update(authenticator_verified=True, phone_mfa_disabled=True)
    monkeypatch.setattr(browser, "_complete_chatgpt_security", complete, raising=False)
    worker = browser.ChatGPTBrowserRegister(headless=True, phone_callback=SimpleNamespace(completed=True, phone_verification_succeeded=True), log_fn=lambda _: None, security_checkpoint=lambda state: checkpoints.append(dict(state)))
    result = worker._retry_oauth_fresh_browser("test@example.com", "test-password")
    assert called == ["test@example.com"]
    assert "login_session" in checkpoints[0]["cookies"]
    assert checkpoints[0]["authenticator_verified"] is False
    assert result["authenticator_verified"] is True
    assert result["phone_mfa_disabled"] is True


@pytest.mark.parametrize("destination,accepted", [
    ("https://auth.openai.com/create-account", True),
    ("https://example.com/", False),
])
def test_navigation_waits_for_delayed_redirect_without_accepting_untrusted_page(destination, accepted):
    class Page:
        url = "https://chatgpt.com/"
        def goto(self, *args, **kwargs):
            raise RuntimeError("NS_BINDING_ABORTED")
        def wait_for_url(self, predicate, **kwargs):
            self.url = destination
            assert predicate(destination)
    if accepted:
        security_module()._navigate(Page(), "https://auth.openai.com/authorize")
    else:
        with pytest.raises(RuntimeError):
            security_module()._navigate(Page(), "https://auth.openai.com/authorize")


@pytest.mark.parametrize("location,accepted", [
    ("/email-verification", True),
    ("https://example.com/login", False),
])
def test_authorization_bootstrap_follows_only_trusted_redirect_in_same_context(location, accepted):
    calls = []
    response = SimpleNamespace(status=302, headers={"location": location},
                               dispose=lambda: calls.append("disposed"))
    class Page:
        url = "https://chatgpt.com/"
        context = SimpleNamespace(request=SimpleNamespace(get=lambda url, **kwargs: response))
        def goto(self, url, **kwargs):
            calls.append(url)
            self.url = url
    page = Page()
    if accepted:
        security_module()._navigate(page, "https://auth.openai.com/api/accounts/authorize")
        assert page.url == "https://auth.openai.com/email-verification"
        assert calls == ["disposed", page.url]
    else:
        with pytest.raises(RuntimeError, match="untrusted"):
            security_module()._navigate(page, "https://auth.openai.com/api/accounts/authorize")
        assert calls == ["disposed"]


def security_module():
    return importlib.import_module("platforms.chatgpt.security")


def test_totp_uses_rfc6238_vector():
    assert security_module().totp_code("GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ", timestamp=59) == "287082"


@pytest.mark.parametrize("timestamp,expected_wait", [(58.5, 1.5), (45.0, None), (52.0, None)])
def test_totp_freshness_waits_only_near_rollover(monkeypatch, timestamp, expected_wait):
    module = security_module()
    secret = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ"
    clock = [timestamp]
    waits = []
    monkeypatch.setattr(module.time, "time", lambda: clock[0])
    def sleep(seconds):
        waits.append(seconds)
        clock[0] += seconds
    monkeypatch.setattr(module.time, "sleep", sleep)
    code = module.totp_code(secret, min_remaining=8)
    assert waits == ([] if expected_wait is None else [expected_wait])
    assert code == module.totp_code(secret, timestamp=clock[0])
    if expected_wait is not None:
        assert code != module.totp_code(secret, timestamp=timestamp)


def test_totp_explicit_timestamp_never_reads_or_waits_for_clock(monkeypatch):
    module = security_module()
    monkeypatch.setattr(module.time, "time", lambda: pytest.fail("explicit timestamp read clock"))
    monkeypatch.setattr(module.time, "sleep", lambda _: pytest.fail("explicit timestamp waited"))
    assert module.totp_code("GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ", timestamp=59,
                            min_remaining=8) == "287082"


def test_totp_default_live_call_does_not_wait(monkeypatch):
    module = security_module()
    monkeypatch.setattr(module.time, "time", lambda: 59)
    monkeypatch.setattr(module.time, "sleep", lambda _: pytest.fail("default call waited"))
    assert module.totp_code("GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ") == "287082"


def test_reauthentication_defers_totp_until_ready_input(monkeypatch):
    module = security_module()
    page = SimpleNamespace(url="https://chatgpt.com/", context=SimpleNamespace(cookies=lambda: []))
    events = []
    def navigate(page, url, **kwargs):
        page.url = url
    monkeypatch.setattr(module, "_navigate", navigate)
    monkeypatch.setattr(browser, "_wait_for_openai_browser_check", lambda *args: None)
    monkeypatch.setattr(browser, "_get_browser_csrf_token", lambda _: "csrf")
    monkeypatch.setattr(browser, "_browser_fetch", lambda *args, **kwargs:
                        {"ok": True, "data": {"url": "https://auth.openai.com/mfa"}})
    monkeypatch.setattr(browser, "_derive_registration_state_from_page", lambda _: {"page_type": "mfa"})
    monkeypatch.setattr(browser, "_get_cookies", lambda _: {})
    monkeypatch.setattr(module, "_api", lambda *args, **kwargs:
                        {"accessToken": "token", "user": {"email": "test@example.com"}})
    def totp(secret, *, min_remaining=0):
        assert events == ["input-ready"]
        assert secret == "secret" and min_remaining == 8
        events.append("generated")
        return "123456"
    monkeypatch.setattr(module, "totp_code", totp)
    def submit(page, code, log):
        assert callable(code)
        assert events == []
        events.append("input-ready")
        assert code() == "123456"
        page.url = "https://chatgpt.com/"
        return {"ok": True}
    monkeypatch.setattr(browser, "_submit_otp_via_page", submit)
    session = module._reauthenticate(page, "test@example.com", "password", None, "secret", lambda _: None)
    assert session["accessToken"] == "token"
    assert events == ["input-ready", "generated"]


def test_security_checkpoint_precedes_activation_and_phone_removal(monkeypatch):
    module = security_module()
    events = []
    result = {"phone_verified": True}
    info = {"factors": {"totp": [], "sms": [{"id": "sms-factor"}]}}
    def api(page, url, **kwargs):
        if url.endswith("mfa_info"): return info
        if url.endswith("/mfa/enroll"):
            events.append("enroll")
            return {"secret": "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ", "session_id": "session"}
        if url.endswith("/activate_enrollment"):
            assert events[-1] == "fresh-code"
            assert kwargs["data"]["code"] == "123456"
            events.append("activate")
            info["factors"]["totp"] = [{"id": "totp-factor"}]
            return {"success": True}
        pytest.fail("unexpected endpoint")
    monkeypatch.setattr(module, "_reauthenticate", lambda *args: {"accessToken": "token", "user": {"email": "test@example.com"}})
    monkeypatch.setattr(module, "_api", api)
    def fresh_code(secret, *, min_remaining=0):
        assert events[-1] == "save-key"
        assert secret == result["totp_secret"]
        assert min_remaining == 8
        events.append("fresh-code")
        return "123456"
    monkeypatch.setattr(module, "totp_code", fresh_code)
    def disable(page, log):
        events.append("disable-phone")
        info["factors"]["sms"] = []
    monkeypatch.setattr(module, "_disable_phone_mfa", disable)
    module.complete_chatgpt_security(None, "test@example.com", "password", None, result,
                                    lambda state: events.append("save-key" if state.get("totp_secret") else "checkpoint"), lambda _: None)
    assert events.index("save-key") < events.index("activate") < events.index("disable-phone")
    assert result["authenticator_verified"] is True
    assert result["phone_mfa_disabled"] is True


def test_failed_totp_activation_never_removes_phone(monkeypatch):
    module = security_module()
    result = {"phone_verified": True}
    def api(page, url, **kwargs):
        if url.endswith("mfa_info"): return {"factors": {"totp": [], "sms": [{"id": "sms-factor"}]}}
        if url.endswith("/mfa/enroll"): return {"secret": "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ", "session_id": "session"}
        return {"success": False}
    monkeypatch.setattr(module, "_reauthenticate", lambda *args: {"accessToken": "token", "user": {"email": "test@example.com"}})
    monkeypatch.setattr(module, "_api", api)
    monkeypatch.setattr(module, "_disable_phone_mfa", lambda *args: pytest.fail("phone removed before verified TOTP"))
    with pytest.raises(RuntimeError, match="TOTP"):
        module.complete_chatgpt_security(None, "test@example.com", "password", None, result, lambda _: None, lambda _: None)
    assert result["totp_secret"]
    assert not result.get("phone_mfa_disabled")


def test_phone_removal_must_be_confirmed_by_provider(monkeypatch):
    module = security_module()
    monkeypatch.setattr(module, "_reauthenticate", lambda *args: {"accessToken": "token", "user": {"email": "test@example.com"}})
    monkeypatch.setattr(module, "_api", lambda *args, **kwargs: {"factors": {"totp": [{"id": "totp-factor"}], "sms": [{"id": "sms-factor"}]}})
    monkeypatch.setattr(module, "_disable_phone_mfa", lambda *args: None)
    with pytest.raises(RuntimeError, match="SMS"):
        module.complete_chatgpt_security(None, "test@example.com", "password", None, {}, lambda _: None, lambda _: None)


def test_missing_factor_state_cannot_mark_registered(monkeypatch):
    module = security_module()
    monkeypatch.setattr(module, "_reauthenticate", lambda *args: {"accessToken": "token", "user": {"email": "test@example.com"}})
    monkeypatch.setattr(module, "_api", lambda *args, **kwargs: {})
    with pytest.raises(RuntimeError, match="MFA"):
        module.complete_chatgpt_security(None, "test@example.com", "password", None, {}, lambda _: None, lambda _: None)


def test_mailbox_codes_are_not_reused_between_login_and_mfa():
    from core.registration.helpers import build_otp_callback
    observed = []
    mailbox = SimpleNamespace(
        wait_for_code=lambda account, **kwargs: observed.append(set(kwargs["before_ids"])) or "123456",
        get_current_ids=lambda account: {"consumed-message"},
    )
    ctx = SimpleNamespace(platform=SimpleNamespace(mailbox=mailbox),
                          identity=SimpleNamespace(mailbox_account=object(), before_ids=set()), log=lambda _: None)
    callback = build_otp_callback(ctx)
    callback()
    callback()
    assert observed == [set(), {"consumed-message"}]


def test_totp_key_survives_account_reload():
    from core.base_platform import Account, AccountStatus
    from core.db import save_account, engine, AccountModel
    from core.platform_accounts import build_platform_account
    from sqlmodel import Session, select
    saved = save_account(Account(platform="chatgpt", email="test@example.com", password="password",
                                 status=AccountStatus.TWO_FA_REQUIRED,
                                 extra={"totp_secret": "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ"}))
    with Session(engine) as session:
        reloaded = build_platform_account(session, session.exec(select(AccountModel).where(AccountModel.email == "test@example.com")).one())
    assert reloaded.extra["totp_secret"] == "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ"


@pytest.mark.parametrize("complete", [False, True])
def test_resume_action_reuses_mailbox_and_preserves_completion_gate(monkeypatch, complete):
    from core.base_platform import Account, AccountStatus, RegisterConfig
    from core.db import save_account, engine, AccountModel
    from core.platform_accounts import build_platform_account
    from platforms.chatgpt.plugin import ChatGPTPlatform
    from sqlmodel import Session, select
    import core.base_mailbox as mail
    import core.registration.helpers as helpers
    account = Account(platform="chatgpt", email="test@example.com", password="password",
                      status=AccountStatus.TWO_FA_REQUIRED,
                      extra={"provider_accounts": [{"provider_type": "mailbox", "provider_name": "cfworker_admin_api"}],
                             "account_overview": {"valid": False}})
    original = save_account(account)
    mailbox = SimpleNamespace(get_current_ids=lambda account: set(),
                              get_email=lambda: pytest.fail("resume allocated a new mailbox"))
    monkeypatch.setattr(mail, "create_mailbox", lambda *args, **kwargs: mailbox)
    monkeypatch.setattr(helpers, "build_phone_callbacks", lambda *args, **kwargs: (None, None))
    class Worker:
        def __init__(self, **kwargs): self.options = kwargs
        def run(self, email, password, *, resume=False):
            assert resume is True
            return {"email": email, "password": password, "account_id": "account",
                    "access_token": "token", "refresh_token": "fixture-refresh", "id_token": "fixture-id",
                    "phone_verified": True,
                    "authenticator_verified": complete, "phone_mfa_disabled": complete}
    monkeypatch.setattr(browser, "ChatGPTBrowserRegister", Worker)
    platform = ChatGPTPlatform(config=RegisterConfig())
    response = platform.execute_action("complete_registration", account, {})
    assert response["ok"] is complete
    with Session(engine) as session:
        reloaded = build_platform_account(session, session.exec(select(AccountModel).where(AccountModel.email == "test@example.com")).one())
    assert reloaded.status == (AccountStatus.REGISTERED if complete else AccountStatus.TWO_FA_REQUIRED)
    assert reloaded.extra["account_overview"]["validity_status"] == ("valid" if complete else "invalid")


def test_phone_mfa_control_accepts_a_native_button_with_switch_role(monkeypatch):
    module = security_module()
    clicks = []
    class Target:
        def __init__(self, name, count=1): self.name, self.size = name, count
        def count(self): return self.size
        def click(self, **kwargs): clicks.append(self.name)
    class Row:
        def get_by_role(self, role): return Target("missing-button-role", 0)
        def locator(self, selector):
            assert selector == "button"
            return Target("sms-switch")
    class Label:
        def locator(self, selector): return Row()
    class Dialog:
        def get_by_role(self, *args, **kwargs): return Target("confirmation", 0)
    class Page:
        def get_by_role(self, role, **kwargs):
            return Dialog() if role == "dialog" else Target(kwargs["name"])
        def get_by_text(self, *args, **kwargs): return Label()
    monkeypatch.setattr(browser, "_click_first", lambda *args, **kwargs: "settings")
    module._disable_phone_mfa(Page(), lambda _: None)
    assert clicks == ["Open profile menu", "Security and login", "sms-switch"]


def test_public_account_response_hides_totp_key_without_mutating_recovery_data():
    import json
    from application.accounts import AccountsService
    item = SimpleNamespace(
        id=1, platform="chatgpt", email="test@example.com", password="password",
        user_id="", primary_token="access", trial_end_time=0, cashier_url="",
        lifecycle_status="registered", validity_status="valid", plan_state="free",
        plan_name="free", display_status="registered", display_summary={},
        provider_accounts=[], provider_resources=[], created_at=None, updated_at=None,
        overview={"totp_secret": "private-totp-key",
                  "legacy_extra": {"totp_secret": "private-totp-key", "other": True}},
        credentials=[{"scope": "platform", "key": "totp_secret", "value": "private-totp-key"},
                     {"scope": "platform", "key": "access_token", "value": "access"}],
    )
    response = AccountsService._serialize(item)
    assert "private-totp-key" not in json.dumps(response)
    assert response["credentials"] == [item.credentials[1]]
    assert response["overview"]["legacy_extra"]["other"] is True
    assert item.overview["legacy_extra"]["totp_secret"] == "private-totp-key"
    assert item.credentials[0]["value"] == "private-totp-key"


@pytest.mark.parametrize("url,error,accepted", [
    ("https://auth.openai.com/email-verification", "NS_BINDING_ABORTED", True),
    ("https://chatgpt.com/", "NS_BINDING_ABORTED", True),
    ("https://example.com/", "NS_BINDING_ABORTED", False),
    ("http://auth.openai.com/email-verification", "NS_BINDING_ABORTED", False),
    ("about:blank", "NS_BINDING_ABORTED", False),
    ("https://auth.openai.com/log-in", "certificate failure", False),
])
def test_security_navigation_only_tolerates_trusted_redirect_abort(url, error, accepted):
    module = security_module()
    class Page:
        def __init__(self): self.url = "about:blank"
        def goto(self, *args, **kwargs):
            self.url = url
            raise RuntimeError(error)
    if accepted:
        module._navigate(Page(), "https://auth.openai.com/log-in")
    else:
        with pytest.raises(RuntimeError):
            module._navigate(Page(), "https://auth.openai.com/log-in")
