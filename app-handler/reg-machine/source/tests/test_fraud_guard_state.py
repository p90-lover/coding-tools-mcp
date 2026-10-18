"""Offline guards: real blocked states, no success credit, original queue only."""
from types import SimpleNamespace

import pytest
from sqlmodel import Session, select

from core.base_platform import Account, AccountStatus, RegisterConfig
from core.db import AccountModel, AccountOverviewModel, engine, save_account
from core.platform_accounts import build_platform_account
from core.account_graph import _derive_display_status
from core.proxy_pool import proxy_pool
from platforms.chatgpt.plugin import ChatGPTPlatform
from application import tasks


@pytest.mark.parametrize("code", ["fraud_guard", "rate_limit_exceeded"])
def test_guard_mapping_and_persistence_are_not_registered(code):
    platform = ChatGPTPlatform(RegisterConfig())
    mapped = platform._map_chatgpt_result({
        "email": "guard@example.com", "verification_error_code": code,
        "security_error": "SMS delivery failed; WhatsApp fallback",
        "rental_cleanup_confirmed": True,
    })
    assert mapped.status.value == code
    assert mapped.token == ""
    assert mapped.extra["verification_error_code"] == code
    assert mapped.extra["rental_cleanup_confirmed"] is True
    save_account(Account(platform="chatgpt", email=mapped.email, password="",
                         status=mapped.status, extra=mapped.extra))
    with Session(engine) as session:
        model = session.exec(select(AccountModel)).first()
        restored = build_platform_account(session, model)
        overview = session.get(AccountOverviewModel, model.id)
    assert restored.status.value == code
    assert overview.display_status == code
    assert _derive_display_status(code, "invalid", "subscribed") == code


@pytest.mark.parametrize("code", ["fraud_guard", "rate_limit_exceeded"])
def test_blocked_account_never_launches_manual_recovery_or_refresh(monkeypatch, code):
    monkeypatch.setattr("core.verification_hold.get_verification_hold", lambda: None)
    platform = ChatGPTPlatform(RegisterConfig())
    account = Account(platform="chatgpt", email="guard@example.com", password="",
                      status=AccountStatus(code))
    monkeypatch.setattr(platform, "_login_for_refresh", lambda _: pytest.fail("blocked login launched"))
    for action in (platform._complete_pending_registration, platform._handle_refresh_token):
        result = action(account, {})
        assert result["ok"] is False and result["data"]["requires_user_action"] is True


@pytest.mark.parametrize("code", ["fraud_guard", "rate_limit_exceeded"])
def test_guard_accounts_are_excluded_from_bulk_eligibility(code):
    save_account(Account(platform="chatgpt", email="guard@example.com", password="",
                         status=AccountStatus(code)))
    with Session(engine) as session:
        account_id = session.exec(select(AccountModel.id)).first()
    assert tasks.get_chatgpt_recovery_ids([account_id]) == []
    assert tasks.get_chatgpt_refresh_ids([account_id]) == []


@pytest.mark.parametrize("code,cleaned,expected_calls,expected_status", [
    ("fraud_guard", True, 1, "paused"),
    ("fraud_guard", False, 1, "paused"),
    ("rate_limit_exceeded", True, 1, "paused"),
    ("phone_required", False, 1, "paused"),
    ("exception_cleanup", False, 1, "paused"),
])
def test_registration_guards_do_not_export_or_manufacture_replacements(
        monkeypatch, code, cleaned, expected_calls, expected_status):
    calls, exports = [], []
    def register(**kwargs):
        calls.append(len(calls) + 1)
        if len(calls) == 1:
            if code == "exception_cleanup":
                error = RuntimeError("phone_cleanup_pending: fixture")
                error.rental_cleanup_confirmed = False
                raise error
            return Account(platform="chatgpt", email="guard@example.com", password="",
                           status=AccountStatus(code), extra={"rental_cleanup_confirmed": cleaned})
        return Account(platform="chatgpt", email="good@example.com", password="")
    monkeypatch.setattr(tasks, "_resolve_sms_provider_for_task", lambda _: (
        "herosms", {"herosms_api_key": "fixture", "register_phone_extra_max": 3,
                    "register_reuse_phone_to_max": True}))
    monkeypatch.setattr(tasks, "get", lambda _: object())
    monkeypatch.setattr(tasks, "_build_platform_instance", lambda *args, **kwargs: SimpleNamespace(register=register))
    monkeypatch.setattr(tasks, "save_account", lambda _: None)
    monkeypatch.setattr(tasks, "_save_task_log", lambda *args, **kwargs: None)
    monkeypatch.setattr(tasks, "get_verification_hold", lambda: None)
    monkeypatch.setattr(proxy_pool, "get_next", lambda **kwargs: None)
    monkeypatch.setattr(tasks, "_auto_upload_cpa", lambda logger, account: exports.append(account.email))
    monkeypatch.setattr(tasks, "_auto_push_any2api", lambda *args: None)
    monkeypatch.setattr("core.base_sms.is_herosms_phone_cache_alive", lambda _: (True, {}))
    task = tasks.create_register_task({
        "platform": "chatgpt", "count": 2, "concurrency": 1,
        "extra": {"identity_provider": "oauth_browser"},
    })
    tasks.execute_task(task["task_id"])
    result = tasks.get_task(task["task_id"])
    assert len(calls) == expected_calls
    assert result["success"] == expected_calls - 1 and result["error_count"] == 1
    assert result["status"] == expected_status
    assert result["progress"] == f"{expected_calls}/2"
    assert "guard@example.com" not in exports
    assert exports == (["good@example.com"] if expected_calls == 2 else [])



@pytest.mark.parametrize("code", ["fraud_guard", "rate_limit_exceeded"])
def test_legacy_guard_reason_cannot_launch_automatic_recovery(monkeypatch, code):
    monkeypatch.setattr("core.verification_hold.get_verification_hold", lambda: None)
    platform = ChatGPTPlatform(RegisterConfig())
    account = Account(platform="chatgpt", email="guard@example.com", password="",
                      status=AccountStatus.PHONE_REQUIRED,
                      extra={"security_error": "phone_send rejected: " + code})
    result = platform._complete_pending_registration(account, {})
    assert result["ok"] is False
    assert result["data"]["requires_user_action"] is True
    assert result["data"]["error_type"] == code


def test_completed_verified_recovery_is_not_demoted_by_prior_hold():
    data = {
        "email": "guard@example.com", "account_id": "fixture-account",
        "access_token": "fixture-access", "refresh_token": "fixture-refresh", "id_token": "fixture-id",
        "phone_verified": True, "authenticator_verified": True, "phone_mfa_disabled": True,
        "verification_hold": {"active": True, "code": "rate_limit_exceeded"},
    }
    platform = ChatGPTPlatform(RegisterConfig())
    assert platform._map_chatgpt_result(data).status == AccountStatus.REGISTERED
    rejected = platform._map_chatgpt_result({**data, "verification_error_code": "fraud_guard"})
    assert rejected.status == AccountStatus.FRAUD_GUARD
    with pytest.raises(RuntimeError, match="OAuth callback"):
        platform._map_chatgpt_result({**data, "refresh_token": ""})


def test_whatsapp_message_alone_is_not_fraud():
    mapped = ChatGPTPlatform(RegisterConfig())._map_chatgpt_result({
        "email": "guard@example.com", "security_error": "SMS unavailable; use WhatsApp",
    })
    assert mapped.status == AccountStatus.PHONE_REQUIRED


@pytest.mark.parametrize("hold,error,expected", [
    ({"active": True, "code": "rate_limit_exceeded"}, "ordinary rejection", "rate_limit_exceeded"),
    ({}, "phone_send failed: fraud_guard", "fraud_guard"),
])
def test_generic_error_code_cannot_hide_guard(hold, error, expected):
    result = ChatGPTPlatform(RegisterConfig())._map_chatgpt_result({
        "email": "guard@example.com", "verification_error_code": "invalid_input",
        "verification_hold": hold, "security_error": error,
    })
    assert result.status.value == expected
    assert result.extra["verification_error_code"] == expected


def test_exact_owner_manual_rate_hold_resume_is_preserved(monkeypatch):
    hold = {"active": True, "account_id": 99, "detected_at": "fixture-detection",
            "code": "rate_limit_exceeded"}
    monkeypatch.setattr("core.verification_hold.get_verification_hold", lambda: hold)
    monkeypatch.setattr(
        "infrastructure.provider_settings_repository.ProviderSettingsRepository.get_default_provider_key",
        lambda *args: None,
    )
    platform = ChatGPTPlatform(RegisterConfig())
    platform._local_account_id = 99
    account = Account(platform="chatgpt", email="guard@example.com", password="",
                      status=AccountStatus.RATE_LIMITED)
    result = platform._complete_pending_registration(account, {
        "resume_verification_hold": True, "_verification_hold_detected_at": "fixture-detection",
    })
    assert "邮箱服务" in result["error"]  # Reached ordinary prerequisite, not blocked-state rejection.
    assert result["ok"] is False
    other = platform._complete_pending_registration(account, {
        "resume_verification_hold": True, "_verification_hold_detected_at": "stale-detection",
    })
    assert other["data"]["requires_user_action"] is True
