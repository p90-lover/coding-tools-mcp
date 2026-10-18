from __future__ import annotations

from types import SimpleNamespace

import pytest

from core.base_platform import Account, AccountStatus, RegisterConfig
from platforms.chatgpt import browser_register as browser_register_module
from platforms.chatgpt.plugin import (
    ChatGPTPlatform,
    _assert_complete_oauth_callback,
    _generate_chatgpt_registration_password,
)


def test_assert_complete_oauth_callback_accepts_complete_payload():
    _assert_complete_oauth_callback({
        "account_id": "acct_123",
        "access_token": "at_123",
        "refresh_token": "rt_123",
        "id_token": "id_123",
    })


def test_assert_complete_oauth_callback_rejects_missing_access_token():
    with pytest.raises(RuntimeError, match="完整 OAuth callback"):
        _assert_complete_oauth_callback({
            "account_id": "acct_123",
            "access_token": "",
        })

@pytest.mark.parametrize("missing", ["refresh_token", "id_token", "email"])
def test_oauth_rejects_incomplete_codex_result(missing):
    result = {"account_id": "acct_123", "access_token": "at_123",
              "refresh_token": "rt_123", "id_token": "id_123", "email": "original@example.com"}
    result.pop(missing)
    with pytest.raises(RuntimeError):
        _assert_complete_oauth_callback(result, expected_email="original@example.com")


def test_oauth_rejects_wrong_account_before_checkpoint():
    result = {"account_id": "acct_123", "access_token": "at_123",
              "refresh_token": "rt_123", "id_token": "id_123", "email": "other@example.com"}
    with pytest.raises(RuntimeError, match="identity"):
        _assert_complete_oauth_callback(result, expected_email="original@example.com")
    result["email"] = "Original@Example.com"
    _assert_complete_oauth_callback(result, expected_email=" original@example.com ")


def test_generate_chatgpt_registration_password_meets_openai_strength_requirements():
    for _ in range(8):
        password = _generate_chatgpt_registration_password()
        assert len(password) >= 12
        assert any(ch.islower() for ch in password)
        assert any(ch.isupper() for ch in password)
        assert any(ch.isdigit() for ch in password)
        assert any(ch in ",._!@#" for ch in password)


def test_chatgpt_platform_preserves_user_supplied_password():
    platform = object.__new__(ChatGPTPlatform)
    assert platform._prepare_registration_password("Secret123!") == "Secret123!"


def test_protocol_mailbox_mapper_waits_for_phone():
    platform = object.__new__(ChatGPTPlatform)
    platform.mailbox = None
    platform.config = RegisterConfig()
    adapter = ChatGPTPlatform.build_protocol_mailbox_adapter(platform)
    ctx = SimpleNamespace(password="Secret123!", proxy=None, log=lambda message: None)
    result = SimpleNamespace(
        email="user@example.com",
        password="Secret123!",
        account_id="acct_123",
        access_token="at_123",
        refresh_token="",
        id_token="",
        session_token="sess_123",
        workspace_id="",
    )

    pending = adapter.result_mapper(ctx, result)
    assert pending.status.value == "phone_required"
    assert pending.token == ""


@pytest.mark.parametrize("password_set", [True, False])
def test_browser_register_run_preserves_pending_account(monkeypatch, password_set):
    class FakePage:
        def __init__(self):
            self.url = "about:blank"
            self.context = SimpleNamespace(cookies=lambda: [])

        def goto(self, url, **kwargs):
            self.url = url

    class FakeBrowser:
        def __enter__(self):
            return self

        def __exit__(self, exc_type, exc, tb):
            return False

        def new_page(self):
            return FakePage()

    monkeypatch.setattr(browser_register_module, "Camoufox", lambda **kwargs: FakeBrowser())
    monkeypatch.setattr(browser_register_module, "_browser_registration_flow", lambda *args, **kwargs: {"page_type": "chatgpt_home", "password_set": password_set})
    monkeypatch.setattr(browser_register_module, "_click_first", lambda page, selectors, timeout=3: setattr(page, "url", "https://auth.openai.com/log-in") or selectors[0])
    monkeypatch.setattr(browser_register_module, "_get_cookies", lambda page: {})
    monkeypatch.setattr(browser_register_module, "_do_codex_oauth", lambda *args, **kwargs: None)
    monkeypatch.setattr(browser_register_module.ChatGPTBrowserRegister, "_retry_oauth_fresh_browser", lambda self, email, password: None)
    monkeypatch.setattr(browser_register_module.time, "sleep", lambda seconds: None)

    worker = browser_register_module.ChatGPTBrowserRegister(
        headless=True,
        proxy=None,
        otp_callback=None,
        log_fn=lambda message: None,
    )

    result = worker.run(email="user@example.com", password="Secret123!")
    assert result["email"] == "user@example.com"
    assert result["password"] == ("Secret123!" if password_set else "")
    assert result["status"] == "phone_required"


def test_passwordless_signup_does_not_save_unused_generated_password():
    platform = object.__new__(ChatGPTPlatform)
    result = platform._map_chatgpt_result(
        {"email": "user@example.com", "password_set": False},
        password="GeneratedButUnused123!",
    )
    assert result.password == ""


def test_chatgpt_account_requires_phone_authenticator_and_no_phone_mfa():
    platform = object.__new__(ChatGPTPlatform)
    base = {
        "email": "user@example.com", "password": "Secret123!",
        "account_id": "acct_123", "access_token": "at_123",
        "refresh_token": "rt_123", "id_token": "id_123",
    }

    phone = platform._map_chatgpt_result(base)
    assert phone.status.value == "phone_required"
    assert phone.token == ""

    mfa = platform._map_chatgpt_result({**base, "phone_verified": True})
    assert mfa.status.value == "2fa_required"
    assert mfa.extra["phone_verified"] is True
    assert mfa.token == ""
    assert mfa.extra["access_token"] == base["access_token"]
    assert mfa.extra["refresh_token"] == base["refresh_token"]
    assert mfa.extra["id_token"] == base["id_token"]
    assert mfa.extra.get("account_overview", {}).get("valid") is not True

    sms = platform._map_chatgpt_result({
        **base, "phone_verified": True, "authenticator_verified": True,
    })
    assert sms.status.value == "2fa_required"

    complete = platform._map_chatgpt_result({
        **base, "phone_verified": True, "authenticator_verified": True,
        "phone_mfa_disabled": True,
    })
    assert complete.status.value == "registered"
    assert complete.token == "at_123"


def test_click_first_skips_failed_button_and_uses_visible_alternative():
    clicked = []

    class Target:
        def __init__(self, selector):
            self.selector = selector
            self.first = self

        def count(self):
            return 1

        def click(self, timeout):
            if "submit" in self.selector:
                raise RuntimeError("button covered")
            clicked.append(self.selector)

    page = SimpleNamespace(locator=lambda selector: Target(selector))
    result = browser_register_module._click_first(
        page, ["button[type='submit']", "button:has-text('Continue')"], timeout=1
    )
    assert result == "button:has-text('Continue')"
    assert clicked == ["button:has-text('Continue'):visible"]


@pytest.mark.parametrize("pending_status", [AccountStatus.PHONE_REQUIRED, AccountStatus.TWO_FA_REQUIRED])
def test_pending_chatgpt_task_saves_account_without_counting_success(monkeypatch, pending_status):
    from application import tasks as task_module
    from core.proxy_pool import proxy_pool

    saved = []
    events = []
    pending = Account(
        platform="chatgpt", email="user@example.com", password="",
        status=pending_status,
    )
    logger = SimpleNamespace(
        set_progress=lambda *args: None,
        log=lambda *args, **kwargs: None,
        is_cancel_requested=lambda: False,
        record_success=lambda: events.append("success"),
        record_error=lambda *args: None,
        finish=lambda status, error="": events.append((status, error)),
    )
    monkeypatch.setattr(task_module, "_resolve_sms_provider_for_task", lambda extra: ("", {}))
    monkeypatch.setattr(task_module, "get", lambda name: object())
    monkeypatch.setattr(task_module, "_build_platform_instance", lambda *args, **kwargs: SimpleNamespace(register=lambda **kwargs: pending))
    monkeypatch.setattr(task_module, "save_account", saved.append)
    monkeypatch.setattr(task_module, "_save_task_log", lambda *args, **kwargs: None)
    monkeypatch.setattr(proxy_pool, "get_next", lambda **kwargs: None)

    task_module._execute_register_task(
        {"platform": "chatgpt", "count": 1, "extra": {"identity_provider": "oauth_browser"}},
        logger,
    )
    assert saved == [pending]
    assert "success" not in events
    assert events[-1][0] == "failed"
    assert events[-1][1].startswith(pending_status.value + ":")


@pytest.mark.parametrize("matching_accounts", [0, 1, 2])
@pytest.mark.parametrize("transition", ["immediate", "deferred", "detached", "busy"])
def test_oauth_selects_only_one_exact_matching_account(monkeypatch, matching_accounts, transition):
    from platforms.chatgpt import oauth

    email = "user@example.com"
    chosen = []

    class Page:
        url = "about:blank"

        def goto(self, url, **kwargs):
            self.url = "https://auth.openai.com/choose-an-account"

        def evaluate(self, script):
            return "test-user-agent"

        def title(self):
            return "Welcome back"

        def locator(self, selector):
            assert selector == 'button[name="session_id"]:visible'
            return Choices(self)

        def get_by_text(self, text, *, exact):
            return (text, exact)

        def wait_for_timeout(self, milliseconds):
            pass

        def wait_for_url(self, predicate, **kwargs):
            self.url = "http://localhost:1455/auth/callback?code=test-code&state=test-state"
            assert predicate(self.url)

    class Choices:
        def __init__(self, page):
            self.page = page
            self.first = self

        def filter(self, *, has):
            assert has == (email, True)
            return self

        def wait_for(self, **kwargs):
            pass

        def count(self):
            return matching_accounts

        def get_attribute(self, name):
            assert name == "aria-busy"
            return "true" if transition == "busy" else "false"

        def click(self, **kwargs):
            chosen.append(email)
            if transition == "immediate":
                self.page.url = "http://localhost:1455/auth/callback?code=test-code&state=test-state"
            elif transition == "detached":
                raise RuntimeError("element detached during navigation")

    start = SimpleNamespace(auth_url="https://auth.openai.com/oauth/authorize", state="test-state")
    tokens = {"account_id": "acct-test", "access_token": "at-test", "refresh_token": "rt-test"}
    monkeypatch.setattr(oauth, "generate_oauth_url", lambda **kwargs: start)
    monkeypatch.setattr(browser_register_module, "_derive_registration_state_from_page", lambda page: {"page_type": ""})
    monkeypatch.setattr(browser_register_module, "_find_first_selector", lambda *args, **kwargs: None)
    monkeypatch.setattr(browser_register_module, "_get_page_oauth_url", lambda page: "")
    monkeypatch.setattr(browser_register_module, "_submit_callback_result", lambda *args: tokens)
    monkeypatch.setattr(browser_register_module, "_get_cookies", lambda page: {})
    monkeypatch.setattr(browser_register_module, "_complete_oauth_with_session", lambda *args: None)
    monkeypatch.setattr(browser_register_module.time, "sleep", lambda seconds: None)

    result = browser_register_module._do_codex_oauth(
        Page(), {}, email, "", None, None, None, lambda message: None,
    )
    assert chosen == ([email] if matching_accounts == 1 and transition != "busy" else [])
    assert result == (tokens if matching_accounts == 1 else None)



@pytest.mark.parametrize("observed,visible,check,error,aborted,expected", [
    ("https://auth.openai.com/about-you", True, False, "", True, True),
    ("https://auth.openai.com/email-verification", True, False, "", True, True),
    ("https://auth.openai.com/api/accounts/authorize", True, False, "", True, False),
    ("https://example.invalid/about-you", True, False, "", True, False),
    ("https://auth.openai.com/reset-password", True, False, "", True, False),
    ("https://auth.openai.com/about-you", True, True, "", True, False),
    ("https://auth.openai.com/about-you", True, False, "verification required", True, False),
    ("https://auth.openai.com/about-you", False, False, "", True, False),
    ("https://auth.openai.com/about-you", True, False, "", False, False),
])
def test_authorize_abort_recovers_only_observed_first_party_form(monkeypatch, observed, visible, check, error, aborted, expected):
    url = "https://auth.openai.com/api/accounts/authorize"
    page = SimpleNamespace(url=url, wait_for_load_state=lambda *args, **kwargs: None)
    def navigate(*args, **kwargs):
        page.url = observed
        raise RuntimeError("NS_BINDING_ABORTED" if aborted else "connection failed")
    monkeypatch.setattr(browser_register_module, "_navigate", navigate)
    monkeypatch.setattr(browser_register_module, "_is_openai_browser_check", lambda _: check)
    monkeypatch.setattr(browser_register_module, "_extract_auth_error_text", lambda _: error)
    monkeypatch.setattr(browser_register_module, "_find_first_selector", lambda *args: "input:visible" if visible else None)
    result = browser_register_module._browser_authorize(page, url, lambda _: None)
    assert result == (observed if expected else "")


def test_selection_probe_logs_only_safe_state():
    logs = []
    target = SimpleNamespace(count=lambda: 1, is_enabled=lambda: True,
                             get_attribute=lambda _: "false")
    page = SimpleNamespace(url="https://auth.openai.com/choose-an-account?code=private-fixture",
                           evaluate=lambda _: "complete")
    browser_register_module._log_oauth_selection_probe(page, target, logs.append, "before_click")
    import json
    record = json.loads(logs[0].split("OAuth selection probe: ", 1)[1])
    assert record["matches"] == 1 and record["enabled"] is True
    assert record["ready_state"] == "complete"
    assert record["path"] == "/choose-an-account"
    assert "private-fixture" not in logs[0]
    assert "session_id" not in record and "email" not in record



@pytest.mark.parametrize("check,error,target_enabled,busy,href,expected", [
    (False, "", True, None, "/log-in-or-create-account", True),
    (True, "", True, None, "/log-in-or-create-account", False),
    (False, "rate_limit_exceeded", True, None, "/log-in-or-create-account", False),
    (False, "fraud_guard", True, None, "/log-in-or-create-account", False),
    (False, "", False, None, "/log-in-or-create-account", False),
    (False, "", True, "true", "/log-in-or-create-account", False),
    (False, "", True, None, "https://example.invalid/log-in-or-create-account", False),
    (False, "", True, None, "/create-account", False),
])
def test_same_account_login_recovery_respects_guard_and_offered_route(monkeypatch, check, error, target_enabled, busy, href, expected):
    clicks = []
    target = SimpleNamespace(count=lambda: 1, is_enabled=lambda: target_enabled,
                             get_attribute=lambda _: busy)
    class Login:
        def count(self): return 1
        def is_enabled(self): return True
        def get_attribute(self, key): return href
        def click(self, **kwargs):
            clicks.append(True)
            page.url = "https://auth.openai.com/log-in-or-create-account"
    page = SimpleNamespace(url="https://auth.openai.com/choose-an-account",
                           locator=lambda selector: Login(),
                           wait_for_url=lambda predicate, **kwargs: predicate(page.url))
    monkeypatch.setattr(browser_register_module, "_is_openai_browser_check", lambda _: check)
    monkeypatch.setattr(browser_register_module, "_extract_auth_error_text", lambda _: error)
    assert browser_register_module._recover_oauth_selection_with_same_account_login(page, target, lambda _: None) is expected
    assert len(clicks) == int(expected)


def test_stalled_chooser_reauthenticates_same_email_without_creating_another_account(monkeypatch):
    from platforms.chatgpt import oauth
    selected, logins, submitted = [], [], []
    email = "original@example.com"
    class Choices:
        first = property(lambda self: self)
        def filter(self, **kwargs): return self
        def wait_for(self, **kwargs): pass
        def count(self): return 1
        def is_enabled(self): return True
        def get_attribute(self, name): return None
        def click(self, **kwargs): selected.append(email)
    class Login:
        def count(self): return 1
        def is_enabled(self): return True
        def get_attribute(self, name): return "/log-in-or-create-account"
        def click(self, **kwargs):
            logins.append(True)
            page.url = "https://auth.openai.com/log-in-or-create-account"
    class Page:
        url = "about:blank"
        def goto(self, *args, **kwargs): self.url = "https://auth.openai.com/choose-an-account"
        def evaluate(self, script): return "complete" if script == "document.readyState" else "fixture-user-agent"
        def get_by_text(self, text, **kwargs):
            assert text == email
            return text
        def locator(self, selector):
            return Login() if selector.startswith("a[") else Choices()
        def wait_for_url(self, predicate, **kwargs):
            if "/log-in-or-create-account" in self.url:
                assert predicate(self.url)
                return
            raise RuntimeError("selection did not advance")
    page = Page()
    start = SimpleNamespace(auth_url="https://auth.openai.com/oauth/authorize", state="fixture-state")
    tokens = {"access_token": "fixture-access", "refresh_token": "fixture-refresh",
              "id_token": "fixture-id", "email": email}
    def state(p):
        if "/choose-an-account" in p.url: return {"page_type": "account_selection"}
        if "/log-in-or-create-account" in p.url: return {"page_type": "login_email"}
        return {"page_type": "oauth_callback"}
    def submit(p, entered, log):
        submitted.append(entered)
        p.url = "http://localhost:1455/auth/callback?code=fixture-code&state=fixture-state"
        return {"ok": True, "status": 200}
    monkeypatch.setattr(oauth, "generate_oauth_url", lambda **kwargs: start)
    monkeypatch.setattr(browser_register_module, "_derive_oauth_state_from_page", state)
    monkeypatch.setattr(browser_register_module, "_wait_for_openai_browser_check", lambda *args, **kwargs: None)
    monkeypatch.setattr(browser_register_module, "_is_openai_browser_check", lambda _: False)
    monkeypatch.setattr(browser_register_module, "_extract_auth_error_text", lambda _: "")
    monkeypatch.setattr(browser_register_module, "_get_page_oauth_url", lambda _: "")
    monkeypatch.setattr(browser_register_module, "_submit_login_email_via_page", submit)
    monkeypatch.setattr(browser_register_module, "_submit_callback_result", lambda *args: tokens)
    monkeypatch.setattr(browser_register_module, "_dump_debug", lambda *args: None)
    result = browser_register_module._do_codex_oauth(page, {}, email, "", None, None, None, lambda _: None)
    assert result == tokens
    assert selected == [email] and logins == [True] and submitted == [email]


def test_safe_browser_location_removes_token_queries_fragments_and_long_ids():
    location = browser_register_module._safe_browser_location(
        "https://auth.openai.com/choose-an-account?code=private-fixture#secret")
    assert location == "https://auth.openai.com/choose-an-account"
    location = browser_register_module._safe_browser_location(
        "https://auth.openai.com/" + "a" * 40 + "/123456")
    assert "a" * 40 not in location and "123456" not in location


@pytest.mark.parametrize("login_only", [True, False])
def test_login_oauth_user_agent_is_only_read_for_registration(monkeypatch, login_only):
    evaluations, logs = [], []
    page = SimpleNamespace(url="about:blank")
    def evaluate(script):
        evaluations.append(script)
        return "fixture-user-agent"
    page.evaluate = evaluate
    page.goto = lambda *args, **kwargs: setattr(page, "url", "http://localhost:1455/auth/callback?code=fixture")
    tokens = {"access_token": "fixture-access"}
    monkeypatch.setattr(browser_register_module, "_wait_for_openai_browser_check", lambda *args: None)
    monkeypatch.setattr(browser_register_module, "_derive_oauth_state_from_page", lambda page: {"page_type": "", "continue_url": ""})
    monkeypatch.setattr(browser_register_module, "_submit_callback_result", lambda *args: tokens)
    result = browser_register_module._do_codex_oauth(
        page, {}, "original@example.com", "", None, None, None, logs.append, login_only=login_only,
    )
    assert result == tokens
    assert evaluations == ([] if login_only else ["() => navigator.userAgent"])
    assert logs[0] == "  OAuth flow started"


@pytest.mark.parametrize("page_type, reconstructed, allowed", [
    ("create_account_password", True, False),
    ("about_you", True, False),
    ("login_password", True, False),
    ("add_phone", True, True),
    ("about_you", False, True),
    ("create_account_password", False, True),
])
def test_reconstructed_identity_oauth_respects_existing_account_boundaries(monkeypatch, page_type, reconstructed, allowed):
    stage, calls = {"page_type": page_type, "continue_url": ""}, []
    failure = {"recovery_record_rebuilt_from_history": "fixture-task"} if reconstructed else {}
    page = SimpleNamespace(url="about:blank", evaluate=lambda script: "fixture-user-agent")
    monkeypatch.setattr(browser_register_module, "_navigate",
                        lambda *args, **kwargs: setattr(page, "url", "https://auth.openai.com/" + page_type))
    monkeypatch.setattr(browser_register_module, "_wait_for_openai_browser_check", lambda *args: None)
    monkeypatch.setattr(browser_register_module, "_derive_oauth_state_from_page", lambda page: dict(stage))
    monkeypatch.setattr(browser_register_module, "_get_page_oauth_url", lambda page: "")
    monkeypatch.setattr(browser_register_module, "_click_passwordless_login_if_available", lambda *args, **kwargs: False)

    def advance(*args, **kwargs):
        calls.append(page_type)
        stage["page_type"] = "consent"
        page.url = "https://auth.openai.com/consent"
        return {"ok": True, "status": 200}

    for handler in ("_submit_oauth_password_direct", "_submit_about_you_via_page", "_handle_add_phone_challenge"):
        monkeypatch.setattr(browser_register_module, handler, advance)
    completed = {"fixture_success": True}
    monkeypatch.setattr(browser_register_module, "_complete_oauth_in_browser", lambda *args: completed)
    result = browser_register_module._do_codex_oauth(
        page, {}, "original@example.com", "", lambda: "unused-fixture-code", lambda: "unused-fixture-phone",
        None, lambda message: None, failure_context=failure,
    )
    assert result == (completed if allowed else None)
    assert calls == ([page_type] if allowed else [])
    if not allowed:
        assert failure.get("security_error")
    assert "access_token" not in failure and "totp_secret" not in failure


def test_login_only_rejects_phone_without_requesting_sms(monkeypatch):
    phone_calls, failure = [], {}
    page = SimpleNamespace(url="about:blank", evaluate=lambda script: "fixture-user-agent")
    page.goto = lambda *args, **kwargs: setattr(page, "url", "https://auth.openai.com/add-phone")
    monkeypatch.setattr(browser_register_module, "_wait_for_openai_browser_check", lambda *args: None)
    monkeypatch.setattr(browser_register_module, "_derive_oauth_state_from_page", lambda page: {"page_type": "add_phone", "continue_url": ""})
    monkeypatch.setattr(browser_register_module, "_get_page_oauth_url", lambda page: "")
    result = browser_register_module._do_codex_oauth(
        page, {}, "original@example.com", "", None, lambda: phone_calls.append(True), None,
        lambda message: None, login_only=True, failure_context=failure,
    )
    assert result is None
    assert phone_calls == []
    assert "恢复注册操作" in failure["security_error"]


@pytest.mark.parametrize("cancel_after", ["before_start", "launch", "page", "restore", "read", None])
def test_login_startup_logs_safe_stages_and_checks_cancellation(monkeypatch, cancel_after):
    calls, logs = [], []
    class Logger:
        cancelled = cancel_after == "before_start"
        def log(self, message):
            logs.append(message)
        def is_cancel_requested(self):
            return self.cancelled
    logger = Logger()
    def completed(operation):
        calls.append(operation)
        if operation == cancel_after:
            logger.cancelled = True
    class Context:
        def add_cookies(self, cookies):
            completed("restore")
        def cookies(self):
            completed("read")
            return [{"name": "fixture-cookie", "value": "private-cookie-value"}]
    page = SimpleNamespace(context=Context())
    class Browser:
        def __enter__(self):
            completed("launch")
            return self
        def __exit__(self, *args):
            calls.append("close")
        def new_page(self):
            completed("page")
            return page
    monkeypatch.setattr(browser_register_module, "Camoufox", lambda **kwargs: Browser())
    tokens = {"email": "original@example.com", "account_id": "fixture-account",
              "access_token": "fixture-access", "refresh_token": "fixture-refresh", "id_token": "fixture-id"}
    def oauth(*args, **kwargs):
        completed("oauth")
        assert kwargs["login_only"] is True
        return dict(tokens)
    monkeypatch.setattr(browser_register_module, "_do_codex_oauth", oauth)
    worker = browser_register_module.ChatGPTBrowserRegister(
        headless=True, log_fn=logger.log,
        security_progress={"cookies": [{"name": "fixture-cookie", "value": "private-cookie-value"}]},
    )
    if cancel_after:
        with pytest.raises(RuntimeError, match="registration_cancelled"):
            worker.login("original@example.com", "")
        expected = []
        if cancel_after != "before_start":
            operations = ["launch", "page", "restore", "read"]
            expected = operations[:operations.index(cancel_after) + 1] + ["close"]
        assert calls == expected
        assert "oauth" not in calls
    else:
        assert worker.login("original@example.com", "")["access_token"] == "fixture-access"
        assert calls[:5] == ["launch", "page", "restore", "read", "oauth"]
        assert calls[-1] == "close"
        assert logs == [
            "  OAuth startup: starting Camoufox",
            "  OAuth startup: creating page",
            "  OAuth startup: restoring saved cookies",
            "  OAuth startup: reading cookies",
            "  OAuth startup: ready",
        ]
    assert all("original@example.com" not in message and "private-cookie-value" not in message for message in logs)
