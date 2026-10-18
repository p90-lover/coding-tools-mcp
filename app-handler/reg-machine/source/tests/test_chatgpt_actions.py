"""Offline regressions for ChatGPT account-menu actions and OAuth renewal."""
import importlib
import json
from types import SimpleNamespace

import pytest

from core.base_platform import Account, AccountStatus, RegisterConfig
from platforms.chatgpt import browser_register as flow
from platforms.chatgpt.plugin import ChatGPTPlatform


@pytest.fixture
def platform():
    instance = object.__new__(ChatGPTPlatform)
    instance.config = RegisterConfig(proxy="http://127.0.0.1:17891")
    instance.mailbox = None
    instance._log_fn = lambda message: None
    return instance


@pytest.fixture
def account():
    return Account(platform="chatgpt", email="original@example.com", password="fixture-password")


@pytest.mark.parametrize("nested", [False, True])
def test_deactivated_pending_account_cannot_start_recovery(platform, account, monkeypatch, nested):
    import core.base_mailbox as mail
    import core.verification_hold as hold

    account.status = AccountStatus.TWO_FA_REQUIRED
    account.extra = {"provider_accounts": [{"provider_type": "mailbox", "provider_name": "cfworker"}]}
    restriction = {"security_error": "OAuth validation rejected: account_deactivated"}
    account.extra.update({"account_overview": {"legacy_extra": restriction}} if nested else restriction)
    monkeypatch.setattr(hold, "get_verification_hold", lambda: None)
    monkeypatch.setattr(mail, "create_mailbox",
                        lambda *args, **kwargs: pytest.fail("Deactivated account must not contact its mailbox or browser"))
    result = platform._complete_pending_registration(account)
    assert result["ok"] is False
    assert "account_deactivated" in result["error"]
    assert result["data"]["requires_user_action"] is True
    assert result["data"]["error_type"] == "account_deactivated"


def test_reconstructed_identity_marker_reaches_recovery_worker(platform, account, monkeypatch):
    import core.base_mailbox as mail
    import core.registration.helpers as helpers
    import core.verification_hold as hold

    account.status = AccountStatus.PHONE_REQUIRED
    account.password = ""
    account.extra = {
        "provider_accounts": [{"provider_type": "mailbox", "provider_name": "cfworker_admin_api"}],
        "recovery_record_rebuilt_from_history": "fixture-task",
    }
    captured = []
    monkeypatch.setattr(hold, "get_verification_hold", lambda: None)
    monkeypatch.setattr(mail, "create_mailbox", lambda *args, **kwargs:
                        SimpleNamespace(get_current_ids=lambda acct: set()))
    monkeypatch.setattr(helpers, "build_phone_callbacks", lambda *args, **kwargs: (None, None))
    monkeypatch.setattr(helpers, "build_otp_callback", lambda *args, **kwargs: lambda: "unused-fixture-code")

    def worker(**kwargs):
        captured.append(dict(kwargs["security_progress"]))
        return SimpleNamespace(run=lambda **kwargs: {"security_error": "fixture manual completion"})

    monkeypatch.setattr(flow, "ChatGPTBrowserRegister", worker)
    monkeypatch.setattr(platform, "_save_security_checkpoint", lambda ctx, raw: account)
    result = platform._complete_pending_registration(account)
    assert captured[0].get("recovery_record_rebuilt_from_history") == "fixture-task"
    assert captured[0]["phone_verified"] is False
    assert result["ok"] is False


@pytest.mark.parametrize(("action_id", "expected"), [
    ("switch_account", "switch_desktop"),
    ("payment_link", "generate_link"),
    ("upload_cpa", "upload_cpa"),
    ("upload_tm", "upload_tm"),
])
def test_menu_ids_reach_their_implemented_handlers(platform, account, monkeypatch, action_id, expected):
    monkeypatch.setattr(platform, "_execute_platform_action",
                        lambda action, acct, params: {"ok": True, "data": action})
    monkeypatch.setattr(platform, "_handle_generate_link",
                        lambda acct, params: {"ok": True, "data": "generate_link"})
    result = platform.execute_action(action_id, account, {})
    assert result == {"ok": True, "data": expected}


def test_actions_use_the_configured_proxy_pool(platform, account, monkeypatch):
    from core.proxy_pool import proxy_pool
    platform.config.proxy = None
    monkeypatch.setattr(proxy_pool, "get_next", lambda: "http://127.0.0.1:17891")
    monkeypatch.setattr(platform, "_handle_query_state",
                        lambda acct, params: {"ok": True, "data": platform.config.proxy})
    assert platform.execute_action("query_state", account, {})["data"] == "http://127.0.0.1:17891"


def test_refresh_module_imports_without_a_removed_account_model():
    module = importlib.import_module("platforms.chatgpt.token_refresh")
    result = module.TokenRefreshManager().refresh_account(
        SimpleNamespace(email="original@example.com", session_token="", refresh_token="", client_id=""))
    assert result.success is False
    assert "session_token" in result.error_message


def test_oauth_refresh_takes_priority_and_returns_rotated_credentials(monkeypatch):
    from platforms.chatgpt.token_refresh import TokenRefreshManager
    from platforms.chatgpt.constants import CODEX_CLIENT_ID

    posted = {}
    response = SimpleNamespace(status_code=200, json=lambda: {
        "access_token": "new-access", "refresh_token": "new-refresh",
        "id_token": "new-id", "expires_in": 3600,
    })
    manager = TokenRefreshManager()
    monkeypatch.setattr(manager, "_create_session", lambda: SimpleNamespace(
        post=lambda url, **kwargs: posted.update(kwargs["data"]) or response))
    monkeypatch.setattr(manager, "refresh_by_session_token",
                        lambda token: pytest.fail("A web session must not skip OAuth renewal"))
    result = manager.refresh_account(SimpleNamespace(
        email="original@example.com", session_token="old-session",
        refresh_token="old-refresh", client_id=CODEX_CLIENT_ID))
    assert result.success is True
    assert (result.access_token, result.refresh_token, result.id_token) == (
        "new-access", "new-refresh", "new-id")
    assert posted["client_id"] == CODEX_CLIENT_ID
    assert posted["refresh_token"] == "old-refresh"


def test_successful_refresh_does_not_login_again(platform, account, monkeypatch):
    from platforms.chatgpt.token_refresh import TokenRefreshManager
    account.extra = {"refresh_token": "old-refresh", "client_id": "saved-client"}
    def refresh(manager, material):
        assert material.email == account.email
        assert material.client_id == "saved-client"
        return SimpleNamespace(success=True, access_token="new-access",
                               refresh_token="new-refresh", id_token="new-id")
    monkeypatch.setattr(TokenRefreshManager, "refresh_account", refresh)
    monkeypatch.setattr(flow.ChatGPTBrowserRegister, "login",
                        lambda *args, **kwargs: pytest.fail("Refresh succeeded; login is unnecessary"),
                        raising=False)
    from platforms.chatgpt import switch
    monkeypatch.setattr(switch, "fetch_chatgpt_account_state", lambda **kwargs: {"valid": True})
    result = platform.execute_action("refresh_token", account, {})
    assert result["ok"] is True
    assert result["data"]["refresh_token"] == "new-refresh"
    assert result["data"]["id_token"] == "new-id"


@pytest.mark.parametrize(("extra", "session_success"), [({}, False), ({"session_token": "old-session"}, False),
    ({"refresh_token": "expired-refresh"}, False), ({"session_token": "old-session"}, True)])
def test_missing_or_expired_tokens_fall_back_to_saved_account_login(platform, account, monkeypatch, extra, session_success):
    from platforms.chatgpt.token_refresh import TokenRefreshManager
    account.extra = extra
    monkeypatch.setattr(TokenRefreshManager, "refresh_account", lambda *args: SimpleNamespace(
        success=session_success, access_token="session-access" if session_success else "",
        refresh_token="", id_token="", error_message="expired"))
    monkeypatch.setattr(platform, "_login_for_refresh", lambda acct: {
        "email": acct.email, "account_id": "saved-account", "access_token": "new-access",
        "refresh_token": "new-refresh", "id_token": "new-id", "client_id": "saved-client",
    }, raising=False)
    result = platform.execute_action("refresh_token", account, {})
    assert result["ok"] is True
    assert result["data"]["refresh_token"] == "new-refresh"
    assert result["data"]["account_id"] == "saved-account"


@pytest.mark.parametrize("status", [AccountStatus.PHONE_REQUIRED, AccountStatus.TWO_FA_REQUIRED])
def test_pending_registration_is_not_completed_by_refresh(platform, account, monkeypatch, status):
    account.status = status
    monkeypatch.setattr(flow.ChatGPTBrowserRegister, "login",
                        lambda *args, **kwargs: pytest.fail("Pending registration needs its own action"),
                        raising=False)
    result = platform.execute_action("refresh_token", account, {})
    assert result["ok"] is False
    assert result["data"]["requires_user_action"] is True


@pytest.mark.parametrize("background", [None, "false", "true"])
def test_passwordless_login_reuses_original_mailbox_without_registering(platform, account, monkeypatch, background):
    import core.base_mailbox as mail
    from platforms.chatgpt.constants import CODEX_CLIENT_ID

    from infrastructure.config_repository import ConfigRepository

    config = ConfigRepository()
    config.update_flat({"default_executor": "headed"})
    if background is not None:
        setting = {"chatgpt_token_refresh_headless": background}
        assert config.update_flat(setting) == list(setting)
        assert config.get_flat()["chatgpt_token_refresh_headless"] == background

    account.password = ""
    account.extra = {
        "totp_secret": "fixture-totp",
        "provider_accounts": [{"provider_type": "mailbox", "provider_name": "cfworker",
                               "metadata": {"account_id": "original-mailbox"}}],
        "provider_resources": [{"resource_type": "mailbox", "handle": account.email,
                                "metadata": {"account_id": "original-mailbox"}}],
    }
    mailbox = SimpleNamespace(get_current_ids=lambda acct: {"previous-email"})
    def wait_for_code(acct, **kwargs):
        assert acct.email == "original@example.com"
        assert acct.account_id == "original-mailbox"
        assert kwargs["before_ids"] == {"previous-email"}
        return "123456"
    mailbox.wait_for_code = wait_for_code
    mailbox.create_account = lambda *args: pytest.fail("Login must not create another mailbox")
    monkeypatch.setattr(mail, "create_mailbox", lambda key, **kwargs: mailbox)
    def login(worker, email, password):
        assert (email, password) == ("original@example.com", "")
        assert worker.phone_callback is None
        assert worker.otp_callback() == "123456"
        assert worker.security_progress["totp_secret"] == "fixture-totp"
        assert worker.headless is (background == "true")
        assert config.get_flat()["default_executor"] == "headed"
        return {"email": email, "account_id": "saved-account", "access_token": "new-access",
                "refresh_token": "new-refresh", "id_token": "new-id", "client_id": CODEX_CLIENT_ID}
    monkeypatch.setattr(flow.ChatGPTBrowserRegister, "login", login, raising=False)
    result = platform._login_for_refresh(account)
    assert result["email"] == account.email
    assert result["refresh_token"] == "new-refresh"


@pytest.mark.parametrize("page_type", ["create_account_password", "about_you", "add_phone"])
def test_login_only_oauth_stops_before_registration_or_phone_actions(monkeypatch, page_type):
    from platforms.chatgpt import oauth
    start = SimpleNamespace(auth_url="https://auth.openai.com/oauth/authorize",
                            state="fixture-state")
    monkeypatch.setattr(oauth, "generate_oauth_url", lambda **kwargs: start)
    page = SimpleNamespace(url="https://auth.openai.com/login", evaluate=lambda script: "fixture-agent")
    monkeypatch.setattr(flow, "_navigate", lambda *args, **kwargs: None)
    monkeypatch.setattr(flow, "_wait_for_openai_browser_check", lambda *args: None)
    monkeypatch.setattr(flow, "_derive_oauth_state_from_page",
                        lambda page: {"page_type": page_type, "continue_url": ""})
    monkeypatch.setattr(flow, "_get_page_oauth_url", lambda page: "")
    for name in ("_submit_about_you_via_page", "_submit_oauth_password_direct", "_handle_add_phone_challenge"):
        monkeypatch.setattr(flow, name, lambda *args, **kwargs: pytest.fail("Login crossed into registration"))
    failure = {}
    assert flow._do_codex_oauth(page, {}, "original@example.com", "fixture-password", None,
                               lambda: pytest.fail("Login must not buy/send SMS"),
                               None, lambda message: None, login_only=True, failure_context=failure) is None
    assert failure["security_error"]


@pytest.mark.parametrize("identity", ["matching", "wrong_email", "missing_refresh"])
def test_browser_login_validates_identity_without_security_enrollment(monkeypatch, identity):
    from platforms.chatgpt.constants import CODEX_CLIENT_ID
    cookies = [{"name": "__Secure-next-auth.session-token", "value": "new-session",
                "domain": ".chatgpt.com", "path": "/", "secure": True}]
    context = SimpleNamespace(cookies=lambda: cookies, add_cookies=lambda values: None)
    page = SimpleNamespace(context=context)
    class Browser:
        def __enter__(self): return self
        def __exit__(self, *args): return False
        def new_page(self): return page
    monkeypatch.setattr(flow, "Camoufox", lambda **kwargs: Browser())
    monkeypatch.setattr(flow, "_get_cookies", lambda page: {"__Secure-next-auth.session-token": "new-session"})
    tokens = {"email": "original@example.com", "account_id": "saved-account",
              "access_token": "new-access", "refresh_token": "new-refresh", "id_token": "new-id"}
    if identity == "wrong_email":
        tokens["email"] = "other@example.com"
    elif identity == "missing_refresh":
        tokens["refresh_token"] = ""
    def oauth(page, cookies, email, password, otp_callback, phone_callback, proxy, log, **kwargs):
        assert kwargs["login_only"] is True
        assert phone_callback is None
        return dict(tokens)
    monkeypatch.setattr(flow, "_do_codex_oauth", oauth)
    monkeypatch.setattr(flow, "_complete_chatgpt_security",
                        lambda *args: pytest.fail("Login must not enroll/change MFA"))
    worker = flow.ChatGPTBrowserRegister(headless=True, log_fn=lambda message: None)
    if identity != "matching":
        with pytest.raises(RuntimeError):
            worker.login("original@example.com", "fixture-password")
        return
    result = worker.login("original@example.com", "fixture-password")
    assert result["refresh_token"] == "new-refresh"
    assert result["session_token"] == "new-session"
    assert result["client_id"] == CODEX_CLIENT_ID
    assert json.loads(result["cookies"]) == cookies

@pytest.mark.parametrize("offered", [True, False])
def test_passwordless_refresh_login_uses_the_email_code_option(monkeypatch, offered):
    from platforms.chatgpt import oauth
    monkeypatch.setattr(oauth, "generate_oauth_url", lambda **kwargs: SimpleNamespace(
        auth_url="https://auth.openai.com/oauth/authorize", state="fixture-state"))
    page = SimpleNamespace(url="https://auth.openai.com/log-in/password",
                           evaluate=lambda script: "fixture-agent")
    states = iter([{"page_type": "login_password", "continue_url": ""},
                   {"page_type": "callback", "continue_url":
                    "http://localhost:1455/auth/callback?code=fixture-code&state=fixture-state"}])
    monkeypatch.setattr(flow, "_navigate", lambda *args, **kwargs: None)
    monkeypatch.setattr(flow, "_wait_for_openai_browser_check", lambda *args: None)
    monkeypatch.setattr(flow, "_derive_oauth_state_from_page", lambda page: next(states))
    monkeypatch.setattr(flow, "_get_page_oauth_url", lambda page: "")
    monkeypatch.setattr(flow, "_click_passwordless_login_if_available", lambda *args, **kwargs: offered)
    monkeypatch.setattr(flow, "_submit_oauth_password_direct",
                        lambda *args: pytest.fail("Do not submit an empty password"))
    monkeypatch.setattr(flow, "_submit_callback_result", lambda *args: {"refresh_token": "new-refresh"})
    failure = {}
    result = flow._do_codex_oauth(page, {}, "original@example.com", "", lambda: "123456", None,
                                 None, lambda message: None, login_only=True, failure_context=failure)
    assert result == ({"refresh_token": "new-refresh"} if offered else None)
    if not offered:
        assert failure["security_error"]


def test_login_credentials_are_persisted_to_the_original_account_only(monkeypatch):
    from core.db import AccountModel, engine, save_account
    from core.platform_accounts import build_platform_account
    from core.proxy_pool import proxy_pool
    from domain.actions import ActionExecutionCommand
    from sqlmodel import Session, select
    import infrastructure.platform_runtime as runtime
    from sqlalchemy import inspect
    from platforms.chatgpt.token_refresh import TokenRefreshManager

    original = save_account(Account(platform="chatgpt", email="original@example.com", password=""))
    other = save_account(Account(platform="chatgpt", email="other@example.com", password="", token="untouched"))
    original_id = inspect(original).identity[0]
    other_id = inspect(other).identity[0]
    monkeypatch.setattr(runtime, "load_all", lambda: None)
    monkeypatch.setattr(runtime, "get", lambda name: ChatGPTPlatform)
    monkeypatch.setattr(proxy_pool, "get_next", lambda: None)
    monkeypatch.setattr(TokenRefreshManager, "refresh_account",
                        lambda *args: SimpleNamespace(success=False, error_message="no tokens"))
    monkeypatch.setattr(ChatGPTPlatform, "_login_for_refresh", lambda self, acct: {
        "email": acct.email, "account_id": "saved-account", "access_token": "new-access",
        "refresh_token": "new-refresh", "id_token": "new-id", "client_id": "saved-client",
        "session_token": "new-session",
    }, raising=False)
    result = runtime.PlatformRuntime().execute_action(ActionExecutionCommand(
        platform="chatgpt", account_id=original_id, action_id="refresh_token", params={}))
    assert result.ok is True
    with Session(engine) as session:
        reloaded = build_platform_account(session, session.get(AccountModel, original_id))
        untouched = build_platform_account(session, session.get(AccountModel, other_id))
        assert len(session.exec(select(AccountModel)).all()) == 2
    assert reloaded.email == "original@example.com"
    assert reloaded.extra["refresh_token"] == "new-refresh"
    assert reloaded.extra["id_token"] == "new-id"
    assert reloaded.extra["client_id"] == "saved-client"
    assert reloaded.extra["session_token"] == "new-session"
    assert untouched.token == "untouched"

@pytest.mark.parametrize("initial_status", [AccountStatus.REGISTERED, AccountStatus.INVALID])
@pytest.mark.parametrize("verified", [True, False])
def test_invalid_account_recovers_only_after_verified_same_account_login(monkeypatch, initial_status, verified):
    from sqlalchemy import inspect
    from sqlmodel import Session
    from core.db import AccountModel, engine, save_account
    from core.account_graph import load_account_graphs
    from core.proxy_pool import proxy_pool
    from domain.actions import ActionExecutionCommand
    from platforms.chatgpt.token_refresh import TokenRefreshManager
    import infrastructure.platform_runtime as runtime

    saved = save_account(Account(
        platform="chatgpt", email="original@example.com", password="",
        status=initial_status, extra={"account_overview": {"valid": False, "plan_state": "free"}},
    ))
    account_id = inspect(saved).identity[0]
    monkeypatch.setattr(runtime, "load_all", lambda: None)
    monkeypatch.setattr(runtime, "get", lambda name: ChatGPTPlatform)
    monkeypatch.setattr(proxy_pool, "get_next", lambda: None)
    monkeypatch.setattr(TokenRefreshManager, "refresh_account",
                        lambda *args: SimpleNamespace(success=False, error_message="expired"))
    if verified:
        monkeypatch.setattr(ChatGPTPlatform, "_login_for_refresh", lambda self, acct: {
            "email": acct.email, "account_id": "saved-account", "access_token": "new-access",
            "refresh_token": "new-refresh", "id_token": "new-id", "client_id": "saved-client",
        })
    else:
        monkeypatch.setattr(ChatGPTPlatform, "_login_for_refresh",
                            lambda *args: (_ for _ in ()).throw(RuntimeError("verification pending")))
    result = runtime.PlatformRuntime().execute_action(ActionExecutionCommand(
        platform="chatgpt", account_id=account_id, action_id="refresh_token", params={}))
    assert result.ok is verified
    with Session(engine) as session:
        graph = load_account_graphs(session, [account_id])[account_id]
        assert graph["display_status"] == ("registered" if verified else "invalid")
        assert graph["validity_status"] == ("valid" if verified else "invalid")
        assert graph["lifecycle_status"] == ("registered" if verified else initial_status.value)



def _install_recovery_fakes(monkeypatch):
    import application.actions as action_service
    import application.tasks as task_service
    import core.base_mailbox as mail
    import core.registration.helpers as helpers
    import core.verification_hold as hold
    from core.proxy_pool import proxy_pool
    from platforms.chatgpt import switch

    state = SimpleNamespace(
        email="resume@example.invalid", claimed_email="resume@example.invalid",
        profile_email="resume@example.invalid", profile_status=200, profile_code="",
        network_error=False, oauth_success=True, mfa_complete=True, hold=None, on_profile=None,
        saved_cookies=None, saved_session_token=None, cookie_calls=[],
        profile_calls=[], oauth_calls=[], mfa_calls=[], mailbox_accounts=[], closes=[], cleanup_calls=[],
    )
    state.cached = {"account_id": "fixture-cached-account", "access_token": "fixture-cached-access",
                    "refresh_token": "fixture-cached-refresh", "id_token": "fixture-cached-id",
                    "client_id": "fixture-client"}
    state.fresh = {"email": state.email, "account_id": "fixture-fresh-account",
                   "access_token": "fixture-fresh-access", "refresh_token": "fixture-fresh-refresh",
                   "id_token": "fixture-fresh-id", "client_id": "fixture-client"}
    for module in (hold, action_service, task_service):
        monkeypatch.setattr(module, "get_verification_hold", lambda: state.hold)
    monkeypatch.setattr(proxy_pool, "get_next", lambda **kwargs: "http://127.0.0.1:17891")
    def inbox_ids(account):
        assert account.email == state.email and account.account_id == "fixture-original-mailbox"
        state.mailbox_accounts.append(account.email)
        return {"fixture-before"}
    mailbox = SimpleNamespace(get_current_ids=inbox_ids,
                              create_account=lambda *args, **kwargs: pytest.fail("Recovery created a new mailbox"))
    monkeypatch.setattr(mail, "create_mailbox", lambda *args, **kwargs: mailbox)
    monkeypatch.setattr(helpers, "build_phone_callbacks", lambda *args, **kwargs:
                        (None, lambda: state.cleanup_calls.append(True)))
    monkeypatch.setattr(helpers, "build_otp_callback", lambda *args, **kwargs:
                        lambda: pytest.fail("Unexpected email OTP in recovery fixture"))
    jar = []
    def add_cookies(values):
        state.cookie_calls.append([dict(value) for value in values])
        jar.extend(values)
    page = SimpleNamespace(context=SimpleNamespace(cookies=lambda: list(jar), add_cookies=add_cookies))
    class Browser:
        def __enter__(self):
            jar.clear()
            return SimpleNamespace(new_page=lambda: page)
        def __exit__(self, *args):
            state.closes.append(True)
    monkeypatch.setattr(flow, "Camoufox", lambda **kwargs: Browser())
    def profile(access_token, *, proxy=None):
        state.profile_calls.append(access_token)
        if state.on_profile:
            state.on_profile()
        if state.network_error:
            raise RuntimeError("fixture profile connection unavailable")
        if state.profile_status != 200:
            return False, {"status_code": state.profile_status, "body": json.dumps({
                "error": {"code": state.profile_code, "message": "fixture private response"}})}
        profile_data = {"email": state.profile_email}
        if state.profile_code:
            profile_data["error"] = {"code": state.profile_code}
        return True, profile_data
    monkeypatch.setattr(switch, "_fetch_profile", profile)
    monkeypatch.setattr(switch, "fetch_chatgpt_account_state",
                        lambda **kwargs: (_ for _ in ()).throw(AssertionError("Cache validation queried quota")))
    def oauth(current, cookies, email, password, *args, **kwargs):
        assert current is page and email == state.email
        state.oauth_calls.append(email)
        return dict(state.fresh) if state.oauth_success else None
    monkeypatch.setattr(flow, "_do_codex_oauth", oauth)
    def security(current, email, password, otp, result, checkpoint, log):
        assert current is page and email == state.email
        state.mfa_calls.append(result["access_token"])
        if state.mfa_complete:
            result.update(authenticator_verified=True, phone_mfa_disabled=True)
    monkeypatch.setattr(flow, "_complete_chatgpt_security", security)
    return state


@pytest.fixture
def recovery_fakes(client, monkeypatch):
    return _install_recovery_fakes(monkeypatch)


def _create_recovery_record(client, state, *, shadow=False):
    credentials = ({"account_id": "fixture-shadow-account", "access_token": "fixture-shadow-access",
                    "refresh_token": "fixture-shadow-refresh", "id_token": "fixture-shadow-id"}
                   if shadow else {**state.cached, "cookies": getattr(state, "saved_cookies", None) if getattr(state, "saved_cookies", None) is not None else json.dumps([{
                       "name": "login_session", "value": "fixture-cookie",
                       "domain": "auth.openai.com", "path": "/"}])})
    if not shadow and getattr(state, "saved_session_token", None) is not None:
        credentials["session_token"] = state.saved_session_token
    response = client.post("/api/accounts", json={
        "platform": "chatgpt", "email": state.email, "password": "fixture-shadow" if shadow else "fixture-original",
        "user_id": "fixture-shadow-account" if shadow else state.cached["account_id"],
        "lifecycle_status": "registered" if shadow else "2fa_required",
        "credentials": credentials,
        "overview": {"legacy_extra": {"phone_verified": True, "oauth_email": state.claimed_email}},
        "provider_accounts": [{"provider_type": "mailbox", "provider_name": "cfworker",
                               "metadata": {"account_id": "fixture-original-mailbox"}}],
        "provider_resources": [{"provider_type": "mailbox", "provider_name": "cfworker",
                                "resource_type": "mailbox", "handle": state.email,
                                "resource_identifier": state.email,
                                "metadata": {"account_id": "fixture-original-mailbox", "email": state.email}}],
    })
    assert response.status_code == 200
    return response.json()["id"]


def _run_recovery_action(client, account_id):
    import application.tasks as tasks
    response = client.post(f"/api/actions/chatgpt/{account_id}/complete_registration", json={"params": {}})
    assert response.status_code == 200 and response.json().get("task_id")
    task_id = response.json()["task_id"]
    tasks.execute_task(task_id)
    return client.get(f"/api/tasks/{task_id}").json()


def test_recovery_action_reuses_saved_oauth_for_the_original_account(client, recovery_fakes):
    state = recovery_fakes
    account_id = _create_recovery_record(client, state)
    result = _run_recovery_action(client, account_id)
    assert result["status"] == "succeeded"
    assert state.profile_calls == [state.cached["access_token"]]
    assert state.oauth_calls == []
    assert state.mfa_calls == [state.cached["access_token"]]
    restored = client.get(f"/api/accounts/{account_id}").json()
    assert restored["lifecycle_status"] == "registered"
    assert restored["user_id"] == state.cached["account_id"]
    assert state.mailbox_accounts == [state.email] and state.cleanup_calls == state.closes == [True]


def test_recovery_checkpoint_updates_selected_duplicate_email_record_only(client, recovery_fakes):
    state = recovery_fakes
    shadow_id = _create_recovery_record(client, state, shadow=True)
    account_id = _create_recovery_record(client, state)
    before = client.get(f"/api/accounts/{shadow_id}").json()
    result = _run_recovery_action(client, account_id)
    assert result["status"] == "succeeded"
    assert client.get(f"/api/accounts/{shadow_id}").json() == before
    assert client.get(f"/api/accounts/{account_id}").json()["lifecycle_status"] == "registered"
    assert client.get("/api/accounts").json()["total"] == 2


@pytest.mark.parametrize(("status", "code"), [
    (429, "rate_limit_exceeded"), (403, "fraud_guard"), (403, ""),
    (401, "account_deactivated"), (200, "challenge_required"),
])
def test_recovery_cache_rejection_does_not_start_login_or_mfa(client, recovery_fakes, status, code):
    state = recovery_fakes
    state.profile_status, state.profile_code = status, code
    account_id = _create_recovery_record(client, state)
    before = client.get(f"/api/accounts/{account_id}").json()
    result = _run_recovery_action(client, account_id)
    assert result["status"] == "failed" and result["error_count"] == 1
    assert state.profile_calls == [state.cached["access_token"]]
    assert state.oauth_calls == state.mfa_calls == []
    restored = client.get(f"/api/accounts/{account_id}").json()
    assert restored["lifecycle_status"] != "registered"
    assert {(item["scope"], item["key"]): item["value"] for item in restored["credentials"]} == {
        (item["scope"], item["key"]): item["value"] for item in before["credentials"]}
    assert restored["user_id"] == before["user_id"]


def test_recovery_keeps_pending_status_until_mfa_is_verified(client, recovery_fakes):
    state = recovery_fakes
    state.mfa_complete = False
    account_id = _create_recovery_record(client, state)
    result = _run_recovery_action(client, account_id)
    assert result["status"] == "failed"
    assert state.profile_calls == [state.cached["access_token"]] and state.oauth_calls == []
    assert client.get(f"/api/accounts/{account_id}").json()["lifecycle_status"] == "2fa_required"
    state.mfa_complete = True
    assert _run_recovery_action(client, account_id)["status"] == "succeeded"
    assert state.profile_calls == [state.cached["access_token"]] * 2 and state.oauth_calls == []


@pytest.mark.parametrize("stage", ["new", "existing"])
def test_internal_account_checkpoint_rolls_back_the_entire_graph(client, monkeypatch, stage):
    import core.account_graph as graph
    from core.db import save_account
    from infrastructure.accounts_repository import AccountsRepository
    from domain.accounts import AccountQuery
    repository = AccountsRepository()
    original = None
    if stage == "existing":
        model = save_account(Account(platform="chatgpt", email="rollback-checkpoint@example.invalid",
                                     password="fixture-before", user_id="fixture-before-id",
                                     status=AccountStatus.TWO_FA_REQUIRED,
                                     extra={"access_token": "fixture-before-access"}))
        original = repository.get(model.id)
    persist = graph.sync_platform_account_graph
    def fail_after_graph_write(*args, **kwargs):
        persist(*args, **kwargs)
        raise RuntimeError("fixture graph write failed")
    monkeypatch.setattr(graph, "sync_platform_account_graph", fail_after_graph_write)
    with pytest.raises(RuntimeError, match="fixture graph write failed"):
        save_account(Account(platform="chatgpt", email="rollback-checkpoint@example.invalid",
                             password="fixture-after", user_id="fixture-after-id",
                             status=AccountStatus.PHONE_REQUIRED,
                             extra={"access_token": "fixture-after-access"}), account_id=original.id if original else None)
    if original:
        assert repository.get(original.id) == original
    else:
        assert repository.list(AccountQuery())[0] == 0


@pytest.mark.parametrize("deleted", [False, True])
def test_targeted_checkpoint_never_updates_or_recreates_another_identity(client, monkeypatch, deleted):
    from core.db import save_account
    state = SimpleNamespace(email="checkpoint-owner@example.invalid", claimed_email="checkpoint-owner@example.invalid",
                            cached={"account_id": "fixture-owner"})
    account_id = _create_recovery_record(client, state)
    before = client.get(f"/api/accounts/{account_id}").json()
    if deleted:
        assert client.delete(f"/api/accounts/{account_id}").status_code == 200
    with pytest.raises(ValueError):
        save_account(Account(platform="chatgpt", email="other-identity@example.invalid",
                             password="fixture-wrong"), account_id=account_id)
    if deleted:
        assert client.get("/api/accounts").json()["total"] == 0
    else:
        assert client.get(f"/api/accounts/{account_id}").json() == before


@pytest.mark.parametrize("reason", ["expired", "service_unavailable", "network", "wrong_owner", "missing_claim", "wrong_claim", "partial"])
def test_recovery_cache_uses_normal_original_account_fallback(client, recovery_fakes, reason):
    state = recovery_fakes
    if reason == "expired":
        state.profile_status = 401
    elif reason == "service_unavailable":
        state.profile_status = 503
    elif reason == "network":
        state.network_error = True
    elif reason == "wrong_owner":
        state.profile_email = "other-owner@example.invalid"
    elif reason in {"missing_claim", "wrong_claim"}:
        state.claimed_email = "" if reason == "missing_claim" else "other-owner@example.invalid"
    else:
        state.cached.pop("id_token")
    account_id = _create_recovery_record(client, state)
    result = _run_recovery_action(client, account_id)
    assert result["status"] == "succeeded"
    assert state.oauth_calls == [state.email] and state.mfa_calls == [state.fresh["access_token"]]
    assert state.profile_calls == ([] if reason in {"missing_claim", "wrong_claim", "partial"}
                                   else [state.cached["access_token"]])
    assert client.get(f"/api/accounts/{account_id}").json()["user_id"] == state.fresh["account_id"]


def test_recovery_cache_failed_login_never_relabels_unvalidated_credentials(client, recovery_fakes):
    state = recovery_fakes
    state.claimed_email = "other-owner@example.invalid"
    state.oauth_success = False
    account_id = _create_recovery_record(client, state)
    before = client.get(f"/api/accounts/{account_id}").json()
    result = _run_recovery_action(client, account_id)
    assert result["status"] == "failed"
    assert state.profile_calls == state.mfa_calls == [] and state.oauth_calls == [state.email]
    restored = client.get(f"/api/accounts/{account_id}").json()
    assert restored["lifecycle_status"] == "2fa_required" and restored["user_id"] == before["user_id"]
    assert restored["overview"]["legacy_extra"]["oauth_email"] == state.claimed_email
    assert {(item["scope"], item["key"]): item["value"] for item in restored["credentials"]} == {
        (item["scope"], item["key"]): item["value"] for item in before["credentials"]}


def test_recovery_cache_hold_prevents_all_remote_work(client, recovery_fakes):
    state = recovery_fakes
    account_id = _create_recovery_record(client, state)
    state.hold = {"active": True, "account_id": account_id + 1, "detected_at": "fixture-hold",
                  "code": "rate_limit_exceeded"}
    response = client.post(f"/api/actions/chatgpt/{account_id}/complete_registration", json={"params": {}})
    assert response.status_code == 200 and response.json()["data"]["requires_user_action"] is True
    assert state.profile_calls == state.oauth_calls == state.mfa_calls == state.mailbox_accounts == []


def test_recovery_cache_restriction_stops_bulk_before_another_account(client, recovery_fakes):
    import application.tasks as tasks
    state = recovery_fakes
    first = _create_recovery_record(client, state)
    state.email = "second-resume@example.invalid"
    second = _create_recovery_record(client, state)
    state.email = "resume@example.invalid"
    state.profile_status, state.profile_code = 429, "rate_limit_exceeded"
    before_second = client.get(f"/api/accounts/{second}").json()
    response = client.post("/api/actions/chatgpt/bulk/complete_registration",
                           json={"account_ids": [first, second], "params": {}})
    assert response.status_code == 200 and response.json().get("task_id")
    task_id = response.json()["task_id"]
    tasks.execute_task(task_id)
    result = client.get(f"/api/tasks/{task_id}").json()
    assert result["status"] == "failed" and result["progress"] == "1/2"
    assert result["success"] == 0 and result["error_count"] == 1
    assert state.mailbox_accounts == [state.email] and state.oauth_calls == state.mfa_calls == []
    assert client.get(f"/api/accounts/{second}").json() == before_second


def test_recovery_checkpoint_deleted_target_never_recreates_or_updates_a_duplicate(client, recovery_fakes):
    state = recovery_fakes
    shadow_id = _create_recovery_record(client, state, shadow=True)
    account_id = _create_recovery_record(client, state)
    before_shadow = client.get(f"/api/accounts/{shadow_id}").json()
    def remove_selected():
        assert client.delete(f"/api/accounts/{account_id}").status_code == 200
    state.on_profile = remove_selected
    result = _run_recovery_action(client, account_id)
    assert result["status"] == "failed" and state.mfa_calls == []
    assert client.get(f"/api/accounts/{account_id}").status_code == 404
    assert client.get("/api/accounts").json()["total"] == 1
    assert client.get(f"/api/accounts/{shadow_id}").json() == before_shadow


_SESSION_COOKIE = "__Secure-next-auth.session-token"


def _saved_session_case(kind):
    jar = {_SESSION_COOKIE: "fixture-jar-session", "oai-did": "fixture-device"}
    if kind == "list":
        return json.dumps([
            {"name": "login_session", "value": "fixture-auth", "domain": "auth.openai.com", "path": "/",
             "httpOnly": True, "secure": True, "sameSite": "Lax"},
            {"name": _SESSION_COOKIE, "value": jar[_SESSION_COOKIE], "domain": ".chatgpt.com", "path": "/", "secure": True},
            {"name": "oai-did", "value": jar["oai-did"], "domain": ".chatgpt.com", "path": "/"},
        ]), None, {**jar, "login_session": "fixture-auth"}
    if kind == "object":
        return json.dumps({"name": _SESSION_COOKIE, "value": "fixture-jar-session", "domain": ".chatgpt.com",
                           "path": "/", "httpOnly": True, "secure": True}), None, {_SESSION_COOKIE: "fixture-jar-session"}
    if kind in {"map", "map-precedence"}:
        return json.dumps(jar), ("fixture-separate-session" if kind == "map-precedence" else None), jar
    if kind == "header":
        return "; ".join(f"{key}={value}" for key, value in jar.items()), None, jar
    if kind == "device-with-session":
        return json.dumps({"oai-did": jar["oai-did"]}), "fixture-separate-session", {
            "oai-did": jar["oai-did"], _SESSION_COOKIE: "fixture-separate-session"}
    if kind == "device-only":
        return json.dumps({"oai-did": jar["oai-did"]}), None, {"oai-did": jar["oai-did"]}
    if kind == "empty-list-session":
        return "[]", "fixture-separate-session", {_SESSION_COOKIE: "fixture-separate-session"}
    if kind == "session-only":
        return "", "fixture-separate-session", {_SESSION_COOKIE: "fixture-separate-session"}
    return "", None, {}


@pytest.mark.parametrize("kind", ["list", "object", "map", "header", "map-precedence", "device-with-session",
                                  "device-only", "empty-list-session", "session-only", "empty"])
def test_recovery_restores_saved_session_formats(client, recovery_fakes, kind):
    state = recovery_fakes
    state.saved_cookies, state.saved_session_token, expected = _saved_session_case(kind)
    account_id = _create_recovery_record(client, state)
    result = _run_recovery_action(client, account_id)
    assert result["status"] == "succeeded"
    restored = [cookie for batch in state.cookie_calls for cookie in batch]
    assert {cookie["name"]: cookie["value"] for cookie in restored} == expected
    assert state.oauth_calls == [] and state.mfa_calls == [state.cached["access_token"]]
    if kind == "list":
        auth_cookie = next(cookie for cookie in restored if cookie["name"] == "login_session")
        assert auth_cookie["domain"] == "auth.openai.com" and auth_cookie["httpOnly"] is True
        assert auth_cookie["secure"] is True and auth_cookie["sameSite"] == "Lax"
    elif expected:
        assert all(cookie["domain"] == ".chatgpt.com" and cookie["path"] == "/" for cookie in restored)
    if _SESSION_COOKIE in expected:
        assert next(cookie for cookie in restored if cookie["name"] == _SESSION_COOKIE)["secure"] is True


@pytest.mark.parametrize("kind", ["list", "object", "map", "header", "map-precedence", "device-with-session",
                                  "device-only", "empty-list-session", "session-only", "empty"])
def test_saved_account_login_restores_the_same_session_formats(recovery_fakes, kind):
    state = recovery_fakes
    cookies, token, expected = _saved_session_case(kind)
    worker = flow.ChatGPTBrowserRegister(headless=True, log_fn=lambda _: None,
                                         security_progress={"cookies": cookies, "session_token": token})
    result = worker.login(state.email, "fixture-original")
    restored = [cookie for batch in state.cookie_calls for cookie in batch]
    assert {cookie["name"]: cookie["value"] for cookie in restored} == expected
    assert result["session_token"] == expected.get(_SESSION_COOKIE, "")
    assert state.oauth_calls == [state.email] and state.mfa_calls == []


@pytest.mark.parametrize("kind", ["list", "map", "header"])
def test_cookie_consumers_accept_saved_json_and_headers_without_desktop_writes(kind):
    from platforms.chatgpt.switch import extract_session_token
    from platforms.chatgpt.payment import _extract_oai_did
    cookies, _, _ = _saved_session_case(kind)
    assert extract_session_token("", cookies) == "fixture-jar-session"
    assert extract_session_token("fixture-explicit-session", cookies) == "fixture-explicit-session"
    assert _extract_oai_did(cookies) == "fixture-device"


def test_cookie_consumers_do_not_remap_foreign_domain_cookies():
    from platforms.chatgpt.switch import extract_session_token, _parse_cookie_header
    cookies = json.dumps([
        {"name": _SESSION_COOKIE, "value": "fixture-foreign", "domain": "other.example.invalid", "path": "/"},
        {"name": "public-suffix", "value": "fixture-public-suffix", "domain": "com", "path": "/"},
        {"name": "login_session", "value": "fixture-auth", "domain": "auth.openai.com", "path": "/"},
        {"name": "oai-did", "value": "fixture-auth-device", "domain": "auth.openai.com", "path": "/"},
        {"name": "oai-did", "value": "fixture-app-device", "domain": ".chatgpt.com", "path": "/"},
    ])
    assert extract_session_token("", cookies) == ""
    assert _parse_cookie_header(cookies) == {"oai-did": "fixture-app-device"}


def test_protocol_cookie_collection_excludes_foreign_origins():
    page = SimpleNamespace(context=SimpleNamespace(cookies=lambda: [
        {"name": "login_session", "value": "fixture-auth", "domain": "auth.openai.com"},
        {"name": _SESSION_COOKIE, "value": "fixture-app", "domain": ".chatgpt.com"},
        {"name": "foreign", "value": "fixture-foreign", "domain": "other.example.invalid"},
        {"name": "lookalike", "value": "fixture-lookalike", "domain": "notchatgpt.com"},
        {"name": "suffix", "value": "fixture-suffix", "domain": "chatgpt.com.example.invalid"},
        {"name": "public-suffix", "value": "fixture-public-suffix", "domain": "com"},
    ]))
    assert flow._get_cookies(page) == {"login_session": "fixture-auth", _SESSION_COOKIE: "fixture-app"}


def test_saved_cookie_parser_preserves_original_cookie_objects():
    from platforms.chatgpt.payment import _parse_cookie_str
    original = [{"name": "login_session", "value": "fixture-auth", "domain": "auth.openai.com",
                 "path": "/", "httpOnly": True, "secure": True, "sameSite": "Lax"}]
    baseline = json.loads(json.dumps(original))
    restored = _parse_cookie_str(original, "chatgpt.com")
    restored[0]["value"] = "fixture-new"
    restored.append({"name": "extra", "value": "fixture-extra"})
    assert original == baseline


@pytest.mark.parametrize("cookies", ['{"unfinished":', '[{"name":"fixture"}', '["fixture-invalid-entry"]'])
def test_saved_cookie_parser_invalid_json_has_a_safe_error(cookies):
    from platforms.chatgpt.payment import _parse_cookie_str
    with pytest.raises(ValueError, match="Cookie JSON"):
        _parse_cookie_str(cookies, "chatgpt.com")

def test_native_saved_sessions_restore_without_network_or_persistent_profiles():
    import json
    worker = flow.ChatGPTBrowserRegister(headless=True, log_fn=lambda _: None)
    with flow.Camoufox(**worker._launch_options(), timeout=60000) as browser:
        page = browser.new_page()
        page.context.route("**/*", lambda route: route.abort())
        for kind in ("list", "object", "map", "header", "map-precedence", "device-with-session",
                     "device-only", "empty-list-session", "session-only", "empty"):
            cookies, session_token, expected = _saved_session_case(kind)
            page.context.clear_cookies()
            worker.security_progress = {"cookies": cookies, "session_token": session_token}
            worker._restore_saved_session(page)
            actual = page.context.cookies()
            assert {cookie["name"]: cookie["value"] for cookie in actual} == expected, kind
            if kind == "list":
                auth = next(cookie for cookie in actual if cookie["name"] == "login_session")
                assert auth["domain"] == "auth.openai.com" and auth["httpOnly"] and auth["secure"]
                assert auth["sameSite"] == "Lax"
        page.context.clear_cookies()
        worker.security_progress = {"cookies": json.dumps([{
            "name": _SESSION_COOKIE, "value": "fixture-foreign", "domain": "other.example.invalid",
            "path": "/", "secure": True}]), "session_token": "fixture-owned"}
        worker._restore_saved_session(page)
        assert flow._get_cookies(page)[_SESSION_COOKIE] == "fixture-owned"
        assert len(page.context.cookies()) == 2
        page.close()


@pytest.mark.parametrize("cookies", ['{"unfinished":', '["fixture-invalid-entry"]',
                                    '[{"domain":".chatgpt.com"}]',
                                    '[{"name":"__Secure-next-auth.session-token","value":null,"domain":".chatgpt.com"}]'])
def test_optional_malformed_cookies_do_not_block_access_token_state_query(monkeypatch, cookies):
    from platforms.chatgpt import switch, payment
    monkeypatch.setattr(switch, "_fetch_profile", lambda *args, **kwargs: (True, {"email": "query@example.invalid"}))
    monkeypatch.setattr(payment, "fetch_subscription_status_details",
                        lambda *args, **kwargs: {"status": "free", "source": "fixture"})
    state = switch.fetch_chatgpt_account_state(access_token="fixture-query-access", cookies=cookies)
    assert state["valid"] is True and state["profile"]["email"] == "query@example.invalid"
    assert state["session_token_present"] is False
    assert payment._extract_oai_did(cookies) is None

@pytest.mark.parametrize("status,code", [
    (429, "rate_limit_exceeded"), (403, "fraud_guard"),
    (401, "account_deactivated"), (200, "challenge_required"), (403, ""),
])
def test_token_restriction_stops_session_and_browser_fallback(platform, account, monkeypatch, status, code):
    from platforms.chatgpt.token_refresh import TokenRefreshManager
    response = SimpleNamespace(status_code=status, json=lambda: {"error": {"code": code}},
                               text=json.dumps({"error": {"code": code}}))
    session_fallbacks, browser_logins = [], []
    monkeypatch.setattr(TokenRefreshManager, "_create_session", lambda _: SimpleNamespace(
        post=lambda *args, **kwargs: response))
    monkeypatch.setattr(TokenRefreshManager, "refresh_by_session_token", lambda *args:
                        session_fallbacks.append(True) or SimpleNamespace(
                            success=True, access_token="session-access", refresh_token="", id_token=""))
    monkeypatch.setattr(platform, "_login_for_refresh", lambda acct: browser_logins.append(True) or {
        "email": acct.email, "account_id": "fixture-account", "access_token": "browser-access",
        "refresh_token": "browser-refresh", "id_token": "browser-id"})
    account.extra = {"refresh_token": "saved-refresh", "session_token": "saved-session"}
    result = platform.execute_action("refresh_token", account, {})
    assert result["ok"] is False
    assert result["data"]["requires_user_action"] is True
    assert session_fallbacks == browser_logins == []


def test_ordinary_expired_oauth_can_still_use_the_saved_web_session(monkeypatch):
    from platforms.chatgpt.token_refresh import TokenRefreshManager
    response = SimpleNamespace(status_code=400, json=lambda: {"error": "invalid_grant"},
                               text='{"error":"invalid_grant"}')
    manager = TokenRefreshManager()
    monkeypatch.setattr(manager, "_create_session", lambda: SimpleNamespace(post=lambda *args, **kwargs: response))
    fallbacks = []
    monkeypatch.setattr(manager, "refresh_by_session_token", lambda token:
                        fallbacks.append(token) or SimpleNamespace(success=True, access_token="fresh-session-access"))
    result = manager.refresh_account(SimpleNamespace(email="fixture@example.invalid", refresh_token="expired",
                                                    session_token="saved-session", client_id="fixture-client"))
    assert result.success is True
    assert fallbacks == ["saved-session"]


@pytest.mark.parametrize("status,code", [
    (429, "rate_limit_exceeded"), (403, "fraud_guard"),
    (401, "account_deactivated"), (200, "challenge_required"),
])
def test_state_query_stops_after_explicit_profile_restriction(monkeypatch, status, code):
    from platforms.chatgpt import switch, payment
    response = SimpleNamespace(status_code=status, json=lambda: {"error": {"code": code}},
                               text=json.dumps({"error": {"code": code}}))
    requests, subscription_queries = [], []
    monkeypatch.setattr(switch.curl_requests, "get", lambda *args, **kwargs: requests.append(True) or response)
    monkeypatch.setattr(payment, "fetch_subscription_status_details", lambda *args, **kwargs:
                        subscription_queries.append(True) or {"status": "free", "source": "fixture"})
    state = switch.fetch_chatgpt_account_state(access_token="fixture-access")
    assert state["valid"] is None and state["requires_user_action"] is True
    assert len(requests) == 1 and subscription_queries == []


def test_state_query_stops_when_session_refresh_requires_user_action(monkeypatch):
    from platforms.chatgpt import switch, payment
    from platforms.chatgpt.token_refresh import TokenRefreshManager
    monkeypatch.setattr(switch, "_fetch_profile", lambda *args, **kwargs:
                        (False, {"status_code": 401, "body": "expired token"}))
    monkeypatch.setattr(TokenRefreshManager, "refresh_by_session_token", lambda *args:
                        SimpleNamespace(success=False, error_message="rate_limit_exceeded",
                                        requires_user_action=True, error_type="rate_limit_exceeded"))
    subscription_queries = []
    monkeypatch.setattr(payment, "fetch_subscription_status_details", lambda *args, **kwargs:
                        subscription_queries.append(True) or {"status": "free", "source": "fixture"})
    state = switch.fetch_chatgpt_account_state(access_token="expired", session_token="saved-session")
    assert state["valid"] is None and state["requires_user_action"] is True
    assert subscription_queries == []

def test_unconfirmed_deactivation_stops_refresh_without_claiming_a_ban(monkeypatch):
    from platforms.chatgpt.token_refresh import TokenRefreshManager
    response = SimpleNamespace(status_code=401, json=lambda: {
        "error": "invalid_grant", "error_description": "The account has been deactivated"},
        text="fixture response")
    manager = TokenRefreshManager()
    monkeypatch.setattr(manager, "_create_session", lambda: SimpleNamespace(post=lambda *args, **kwargs: response))
    fallbacks = []
    monkeypatch.setattr(manager, "refresh_by_session_token", lambda token:
                        fallbacks.append(token) or SimpleNamespace(success=True))
    result = manager.refresh_account(SimpleNamespace(email="fixture@example.invalid", refresh_token="old-refresh",
                                                    session_token="saved-session", client_id="fixture-client"))
    assert result.success is False and result.requires_user_action is True
    assert result.error_type == "deactivation_unconfirmed"
    assert fallbacks == []

@pytest.fixture
def token_helper_records(client, monkeypatch):
    from domain.accounts import AccountCreateCommand
    from infrastructure.accounts_repository import AccountsRepository
    from platforms.chatgpt import token_refresh

    repository = AccountsRepository()
    state = SimpleNamespace(repository=repository, calls=[], after_refresh=None)
    state.response = token_refresh.TokenRefreshResult(
        success=True, access_token="returned-access", refresh_token="returned-refresh",
        id_token="returned-id", session_token="returned-session")

    def seed(name="one", *, platform_name="chatgpt", status="registered", overview=None):
        return repository.create(AccountCreateCommand(
            platform=platform_name, email=f"{name}@example.invalid", password="",
            user_id="fixture-" + name, lifecycle_status=status, overview=overview or {},
            credentials={"access_token":"saved-access", "refresh_token":"saved-refresh",
                         "id_token":"saved-id", "session_token":"saved-session", "client_id":"saved-client"}))
    state.seed = seed
    state.values = lambda identifier: {item["key"]:item["value"] for item in repository.get(identifier).credentials}

    def refresh(manager, material):
        state.calls.append(("refresh", material.email, material.client_id, manager.proxy_url))
        if state.after_refresh:
            state.after_refresh()
        return state.response
    def validate(manager, access_token):
        state.calls.append(("validate", access_token, manager.proxy_url))
        return True, None
    monkeypatch.setattr(token_refresh.TokenRefreshManager, "refresh_account", refresh)
    monkeypatch.setattr(token_refresh.TokenRefreshManager, "validate_token", validate)
    return state


@pytest.mark.parametrize("helper", ["refresh", "validate"])
def test_public_token_helpers_handle_missing_accounts(client, monkeypatch, helper):
    from platforms.chatgpt import token_refresh
    monkeypatch.setattr(token_refresh.TokenRefreshManager, "_create_session",
                        lambda *args: pytest.fail("Missing accounts must not contact OpenAI"))
    result = (token_refresh.refresh_account_token(999) if helper == "refresh"
              else token_refresh.validate_account_token(999))
    assert (result.success if helper == "refresh" else result[0]) is False


def test_public_refresh_helper_updates_only_the_selected_record(token_helper_records):
    from platforms.chatgpt.token_refresh import refresh_account_token
    state = token_helper_records
    older = state.seed("duplicate")
    target = state.seed("duplicate")
    before = state.repository.get(older.id)
    response = refresh_account_token(target.id, proxy_url="http://127.0.0.1:17891")
    assert response.success is True
    assert state.repository.get(older.id) == before
    saved = state.values(target.id)
    assert (saved["access_token"],saved["refresh_token"],saved["id_token"],saved["session_token"]) == (
        "returned-access","returned-refresh","returned-id","returned-session")
    assert saved["client_id"] == "saved-client"
    assert state.repository.get(target.id).lifecycle_status == "registered"
    assert state.calls == [("refresh",target.email,"saved-client","http://127.0.0.1:17891")]


def test_public_validation_helper_reads_current_credentials_without_writing(token_helper_records):
    from platforms.chatgpt.token_refresh import validate_account_token
    state = token_helper_records
    target = state.seed()
    before = state.repository.get(target.id)
    assert validate_account_token(target.id, proxy_url="http://127.0.0.1:17891") == (True, None)
    assert state.repository.get(target.id) == before
    assert state.calls == [("validate","saved-access","http://127.0.0.1:17891")]


@pytest.mark.parametrize("helper", ["refresh", "validate"])
@pytest.mark.parametrize("status,history", [
    ("phone_required", {}), ("2fa_required", {}), ("fraud_guard", {}),
    ("rate_limit_exceeded", {}), ("invalid", {"legacy_extra":{"security_error":"account_deactivated"}}),
])
def test_public_token_helpers_preserve_restricted_accounts(token_helper_records, helper, status, history):
    from platforms.chatgpt import token_refresh
    state = token_helper_records
    target = state.seed(status=status, overview=history)
    before = state.repository.get(target.id)
    result = (token_refresh.refresh_account_token(target.id) if helper == "refresh"
              else token_refresh.validate_account_token(target.id))
    assert (result.success if helper == "refresh" else result[0]) is False
    assert state.calls == []
    assert state.repository.get(target.id) == before


@pytest.mark.parametrize("helper", ["refresh", "validate"])
def test_public_token_helpers_do_not_use_other_platform_credentials(token_helper_records, helper):
    from platforms.chatgpt import token_refresh
    state = token_helper_records
    target = state.seed(platform_name="grok")
    result = (token_refresh.refresh_account_token(target.id) if helper == "refresh"
              else token_refresh.validate_account_token(target.id))
    assert (result.success if helper == "refresh" else result[0]) is False
    assert state.calls == []


def test_public_refresh_helper_preserves_failed_response_and_saved_credentials(token_helper_records):
    from platforms.chatgpt.token_refresh import TokenRefreshResult, refresh_account_token
    state = token_helper_records
    target = state.seed()
    before = state.repository.get(target.id)
    state.response = TokenRefreshResult(success=False,error_message="fixture rejection",requires_user_action=True)
    assert refresh_account_token(target.id) is state.response
    assert state.repository.get(target.id) == before


def test_public_refresh_helper_does_not_recreate_a_deleted_target(token_helper_records):
    from platforms.chatgpt.token_refresh import refresh_account_token
    state = token_helper_records
    target = state.seed()
    state.after_refresh = lambda: state.repository.delete(target.id)
    result = refresh_account_token(target.id)
    assert result.success is False
    assert state.repository.get(target.id) is None


@pytest.mark.parametrize("nested", [False, True])
def test_cached_deactivation_prevents_menu_refresh_before_any_request(platform, account, monkeypatch, nested):
    from platforms.chatgpt.token_refresh import TokenRefreshManager
    account.status = AccountStatus.INVALID
    metadata = {"security_error":"OAuth validation rejected: account_deactivated"}
    account.extra = {"account_overview":{"legacy_extra":metadata}} if nested else metadata
    requests = []
    monkeypatch.setattr(TokenRefreshManager, "refresh_account", lambda *args:
                        requests.append(True) or SimpleNamespace(success=False,error_message="unused"))
    monkeypatch.setattr(platform, "_login_for_refresh", lambda *args:
                        requests.append(True) or {})
    result = platform.execute_action("refresh_token", account, {})
    assert result["ok"] is False and result["data"]["error_type"] == "account_deactivated"
    assert requests == []

def test_public_refresh_helper_rolls_back_and_retains_returned_keys_on_save_failure(token_helper_records, monkeypatch):
    from platforms.chatgpt.token_refresh import refresh_account_token
    import core.account_graph as graph
    state = token_helper_records
    target = state.seed()
    before = state.repository.get(target.id)
    original = graph.patch_account_graph
    def fail_after_write(*args, **kwargs):
        original(*args, **kwargs)
        raise RuntimeError("fixture database failure")
    monkeypatch.setattr(graph,"patch_account_graph",fail_after_write)
    result = refresh_account_token(target.id)
    assert result.success is False and result.requires_user_action is True
    assert result.error_type == "persistence_failed"
    assert result.refresh_token == "returned-refresh"
    assert state.repository.get(target.id) == before


@pytest.mark.parametrize("helper", ["refresh","validate"])
def test_public_token_helpers_reject_boolean_ids_before_accessing_record_one(token_helper_records, helper):
    from platforms.chatgpt import token_refresh
    state = token_helper_records
    target = state.seed()
    assert target.id == 1
    before = state.repository.get(target.id)
    result = (token_refresh.refresh_account_token(True) if helper == "refresh"
              else token_refresh.validate_account_token(True))
    assert (result.success if helper == "refresh" else result[0]) is False
    assert state.calls == [] and state.repository.get(target.id) == before


