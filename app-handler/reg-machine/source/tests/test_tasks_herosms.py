from __future__ import annotations

from application.tasks import _resolve_sms_provider_for_task, serialize_task
from core.db import TaskModel
from infrastructure.provider_settings_repository import ProviderSettingsRepository


def test_resolve_sms_provider_for_task_uses_saved_herosms_default():
    repo = ProviderSettingsRepository()
    repo.definitions.ensure_seeded()
    repo.save(
        setting_id=None,
        provider_type="sms",
        provider_key="herosms_api",
        display_name="HeroSMS",
        auth_mode="apikey",
        enabled=True,
        is_default=True,
        config={
            "sms_service": "dr",
            "sms_country": "187",
            "register_phone_extra_max": "3",
        },
        auth={"herosms_api_key": "hero123"},
        metadata={},
    )

    provider_key, settings = _resolve_sms_provider_for_task({})

    assert provider_key == "herosms_api"
    assert settings["herosms_api_key"] == "hero123"
    assert settings["sms_service"] == "dr"


def test_resolve_sms_provider_for_task_allows_inline_override():
    provider_key, settings = _resolve_sms_provider_for_task({
        "sms_provider": "herosms",
        "herosms_api_key": "inline",
        "sms_country": "52",
    })

    assert provider_key == "herosms"
    assert settings["herosms_api_key"] == "inline"
    assert settings["sms_country"] == "52"


def test_serialized_registration_has_only_saved_safe_config():
    task = TaskModel(id="summary-fixture", type="register", platform="chatgpt")
    task.set_payload({
        "executor_type": "headed", "count": 2,
        "password": "fixture-password", "proxy": "fixture-proxy",
        "extra": {
            "identity_provider": "oauth_browser", "oauth_provider": "google",
            "api_key": "fixture-api-key", "chrome_user_data_dir": "fixture-profile",
        },
    })
    task.set_result({"data": {"unchanged": True}, "errors": []})
    serialized = serialize_task(task)
    assert serialized["result"]["registration_config"] == {
        "executor_type": "headed", "identity_provider": "oauth_browser",
        "oauth_provider": "google", "count": 2, "concurrency": 1,
    }
    assert serialized["result"]["data"] == {"unchanged": True}
    assert set(serialized["result"]) == {"data", "errors", "registration_config"}


def test_serialized_registration_keeps_saved_concurrency():
    task = TaskModel(id="concurrency-fixture", type="register", platform="chatgpt")
    task.set_payload({"count": 50, "concurrency": 5})
    assert serialize_task(task)["result"]["registration_config"]["concurrency"] == 5


def test_serialized_nonregistration_does_not_add_registration_config():
    task = TaskModel(id="action-fixture", type="platform_action", platform="chatgpt")
    task.set_payload({"executor_type": "headed", "password": "fixture-password"})
    task.set_result({"data": {"unchanged": True}})
    assert serialize_task(task)["result"] == {"data": {"unchanged": True}}
