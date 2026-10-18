"""Lifecycle management API tests."""
from __future__ import annotations

import base64
import json
from datetime import datetime, timezone
from types import SimpleNamespace

import pytest


def test_lifecycle_status(client):
    resp = client.get("/api/lifecycle/status")
    assert resp.status_code == 200
    data = resp.json()
    assert "running" in data
    assert "check_interval_hours" in data
    assert "refresh_interval_hours" in data
    assert "warning_hours" in data


def test_trigger_validity_check_empty(client):
    resp = client.post("/api/lifecycle/check", json={"platform": "", "limit": 10})
    assert resp.status_code == 200
    data = resp.json()
    assert data["ok"] is True
    assert data["data"]["valid"] == 0
    assert data["data"]["invalid"] == 0


def test_trigger_token_refresh_empty(client):
    resp = client.post("/api/lifecycle/refresh", json={"platform": "", "limit": 10})
    assert resp.status_code == 200
    data = resp.json()
    assert data["ok"] is True
    assert data["data"]["refreshed"] == 0


def test_trigger_expiry_warning_empty(client):
    resp = client.post("/api/lifecycle/warn", json={"hours": 48})
    assert resp.status_code == 200
    data = resp.json()
    assert data["ok"] is True


def test_trigger_check_with_platform_filter(client):
    resp = client.post("/api/lifecycle/check", json={"platform": "chatgpt", "limit": 5})
    assert resp.status_code == 200
    assert resp.json()["ok"] is True



def _lifecycle_jwt(payload):
    encoded = base64.urlsafe_b64encode(json.dumps(payload).encode()).decode().rstrip("=")
    return "fixture." + encoded + ".fixture"


@pytest.fixture
def lifecycle_fakes(client, monkeypatch):
    from core import lifecycle
    from core.config_store import config_store
    from curl_cffi import requests
    from domain.accounts import AccountCreateCommand
    from infrastructure.accounts_repository import AccountsRepository

    repository = AccountsRepository()
    state = SimpleNamespace(
        session_status=200, session_body={"accessToken": "rotated-access"},
        oauth_status=200, oauth_body={"access_token": "rotated-access", "refresh_token": "rotated-refresh",
                                      "id_token": "rotated-id", "expires_in": 3600},
        profile_status=200, profile_body={"id": "fixture-user"},
        upload_status=201, session_calls=[], oauth_calls=[], profile_calls=[], uploads=[],
        new_session="rotated-session", after_refresh=None, repository=repository, client=client,
    )

    def response(status, data):
        return SimpleNamespace(status_code=status, json=lambda: data, text=json.dumps(data))

    class Cookies:
        def __init__(self):
            self.values = {}
        def set(self, key, value, **kwargs):
            self.values[key] = value
        def get(self, key, default=None):
            return self.values.get(key, default)

    class Session:
        def __init__(self, **kwargs):
            self.cookies = Cookies()
        def get(self, url, **kwargs):
            assert url == "https://chatgpt.com/api/auth/session"
            state.session_calls.append(self.cookies.get("__Secure-next-auth.session-token"))
            self.cookies.set("__Secure-next-auth.session-token", state.new_session)
            if state.after_refresh:
                state.after_refresh()
            return response(state.session_status, state.session_body)
        def post(self, url, **kwargs):
            assert url == "https://auth.openai.com/oauth/token"
            state.oauth_calls.append(dict(kwargs["data"]))
            if state.after_refresh:
                state.after_refresh()
            return response(state.oauth_status, state.oauth_body)

    def profile(url, **kwargs):
        assert url == "https://chatgpt.com/backend-api/me"
        state.profile_calls.append(kwargs["headers"]["authorization"])
        return response(state.profile_status, state.profile_body)

    def upload(url, **kwargs):
        assert url.startswith("http://127.0.0.1:7/v0/management/auth-files?")
        state.uploads.append(json.loads(kwargs["data"]))
        return response(state.upload_status, {"message": "fixture destination response"})

    monkeypatch.setattr(requests, "Session", Session)
    monkeypatch.setattr(requests, "get", profile)
    monkeypatch.setattr(requests, "post", upload)
    monkeypatch.setattr(lifecycle, "time", SimpleNamespace(sleep=lambda _: None))
    config_store.set("cpa_api_url", "http://127.0.0.1:7")
    config_store.set("cpa_api_key", "fixture-cpa-key")

    def seed(name="one", *, refresh=False, access="saved-access", user_id="fixture-account", overview=None):
        return repository.create(AccountCreateCommand(
            platform="chatgpt", email=f"{name}@example.invalid", password="",
            user_id=user_id, lifecycle_status="registered", overview={"valid": True, **(overview or {})},
            credentials={"access_token": access, "id_token": "saved-genuine-id",
                         "session_token": "session-" + name, "client_id": "saved-client",
                         **({"refresh_token": "refresh-" + name} if refresh else {})}))
    state.seed = seed
    state.values = lambda account_id: {item["key"]: item["value"] for item in repository.get(account_id).credentials}
    return state


def test_lifecycle_cpa_preserves_genuine_identity_and_rotated_session(lifecycle_fakes):
    from core.lifecycle import refresh_and_sync_cpa
    state = lifecycle_fakes
    account = state.seed()
    result = refresh_and_sync_cpa()
    saved = state.values(account.id)
    assert saved["id_token"] == "saved-genuine-id"
    assert saved["session_token"] == "rotated-session"
    assert result["refreshed"] == result["uploaded"] == 1
    assert result["dead"] == result["error"] == 0
    assert state.uploads[0]["id_token"] == "saved-genuine-id"
    assert state.uploads[0]["account_id"] == account.user_id


@pytest.mark.parametrize("status", [401, 403, 429, 500])
def test_lifecycle_cpa_http_errors_do_not_deactivate_accounts(lifecycle_fakes, status):
    from core.lifecycle import refresh_and_sync_cpa
    state = lifecycle_fakes
    account = state.seed()
    state.profile_status, state.profile_body = status, {"detail": "fixture upstream failure"}
    result = refresh_and_sync_cpa()
    assert state.repository.get(account.id).lifecycle_status == "registered"
    assert result["dead"] == 0 and result["error"] == 1
    assert state.uploads == []


@pytest.mark.parametrize("stage,status,code", [
    ("session", 429, "rate_limit_exceeded"), ("session", 403, "fraud_guard"),
    ("session", 200, "challenge_required"), ("profile", 429, "rate_limit_exceeded"),
    ("profile", 403, "fraud_guard"), ("profile", 200, "challenge_required"),
])
def test_lifecycle_cpa_stops_batch_at_remote_restrictions(lifecycle_fakes, stage, status, code):
    from core.lifecycle import refresh_and_sync_cpa
    state = lifecycle_fakes
    older = state.seed("older")
    state.seed("newer")
    before = state.values(older.id)
    setattr(state, stage + "_status", status)
    setattr(state, stage + "_body", {"error": {"code": code}})
    result = refresh_and_sync_cpa()
    assert len(state.session_calls) == 1
    assert state.uploads == []
    assert state.values(older.id) == before
    assert result["error"] == 1 and result["dead"] == 0


@pytest.mark.parametrize("stage", ["session", "profile"])
def test_lifecycle_cpa_only_records_explicit_deactivation(lifecycle_fakes, stage):
    from core.lifecycle import refresh_and_sync_cpa
    state = lifecycle_fakes
    older = state.seed("older")
    newer = state.seed("newer")
    setattr(state, stage + "_status", 401)
    setattr(state, stage + "_body", {"error": {"code": "account_deactivated"}})
    result = refresh_and_sync_cpa()
    assert result["dead"] == 1
    assert state.repository.get(newer.id).lifecycle_status == "invalid"
    assert state.repository.get(older.id).lifecycle_status == "registered"
    assert len(state.session_calls) == 1 and state.uploads == []


def test_lifecycle_cpa_counts_failed_upload(lifecycle_fakes):
    from core.lifecycle import refresh_and_sync_cpa
    state = lifecycle_fakes
    state.seed(access=_lifecycle_jwt({"https://api.openai.com/auth": {"chatgpt_account_id": "fixture-account"}}))
    state.upload_status = 503
    result = refresh_and_sync_cpa()
    assert result["refreshed"] == 1 and result["uploaded"] == 0
    assert result["error"] == 1 and result["dead"] == 0


def test_lifecycle_cpa_reuses_saved_identity_for_optional_bad_claims(lifecycle_fakes):
    from core.lifecycle import refresh_and_sync_cpa
    state = lifecycle_fakes
    state.seed(access="unused-old-access")
    state.session_body = {"accessToken": _lifecycle_jwt(["optional-nonobject-claims"])}
    result = refresh_and_sync_cpa()
    assert result["uploaded"] == 1 and result["error"] == 0
    assert state.uploads[0]["account_id"] == "fixture-account"


@pytest.mark.parametrize("operation", ["refresh", "cpa"])
def test_lifecycle_deleted_target_is_never_reported_refreshed(lifecycle_fakes, operation):
    from core import lifecycle
    state = lifecycle_fakes
    account = state.seed(refresh=operation == "refresh")
    state.after_refresh = lambda: state.repository.delete(account.id)
    result = (lifecycle.refresh_expiring_tokens() if operation == "refresh"
              else lifecycle.refresh_and_sync_cpa())
    assert result["refreshed"] == 0
    assert state.repository.get(account.id) is None
    assert state.profile_calls == state.uploads == []


def test_lifecycle_refresh_saves_rotated_oauth_identity(lifecycle_fakes):
    state = lifecycle_fakes
    account = state.seed(refresh=True)
    response = state.client.post("/api/lifecycle/refresh", json={"platform": "chatgpt", "limit": 1})
    assert response.status_code == 200 and response.json()["data"]["refreshed"] == 1
    saved = state.values(account.id)
    assert saved["id_token"] == "rotated-id"
    assert saved["refresh_token"] == "rotated-refresh"
    assert state.oauth_calls[0]["client_id"] == "saved-client"
    assert state.session_calls == []


def test_lifecycle_refresh_retains_rotated_session(lifecycle_fakes):
    state = lifecycle_fakes
    account = state.seed()
    response = state.client.post("/api/lifecycle/refresh", json={"limit": 1})
    assert response.status_code == 200 and response.json()["data"]["refreshed"] == 1
    assert state.values(account.id)["session_token"] == "rotated-session"
    assert state.values(account.id)["id_token"] == "saved-genuine-id"


def test_lifecycle_skips_access_tokens_outside_the_refresh_window(lifecycle_fakes):
    from core import lifecycle
    state = lifecycle_fakes
    access = _lifecycle_jwt({"exp": int(datetime.now(timezone.utc).timestamp()) + 3 * 24 * 3600})
    account = state.seed(refresh=True, access=access)
    before = state.values(account.id)
    result = lifecycle.refresh_expiring_tokens(hours_before_expiry=24)
    assert result == {"refreshed": 0, "failed": 0, "skipped": 1}
    assert state.oauth_calls == state.session_calls == []
    assert state.values(account.id) == before

@pytest.mark.parametrize("detail", ["The upstream session was deactivated", "This account is not deactivated",
                                    "deactivated", "account_deactivated"])
def test_lifecycle_text_alone_does_not_confirm_account_deactivation(lifecycle_fakes, detail):
    from core.lifecycle import refresh_and_sync_cpa
    state = lifecycle_fakes
    account = state.seed()
    state.profile_status, state.profile_body = 500, {"detail": detail}
    result = refresh_and_sync_cpa()
    assert state.repository.get(account.id).lifecycle_status == "registered"
    assert result["dead"] == 0 and result["error"] == 1

@pytest.mark.parametrize("reported,check_value,expected", [
    (None,False,{"valid":0,"invalid":0,"error":1,"skipped":0}),
    (True,False,{"valid":1,"invalid":0,"error":0,"skipped":0}),
    (False,True,{"valid":0,"invalid":1,"error":0,"skipped":0}),
])
def test_lifecycle_check_counts_the_authoritative_reported_validity(lifecycle_fakes, monkeypatch, reported, check_value, expected):
    from core import lifecycle
    state = lifecycle_fakes
    account = state.seed()
    class CheckedPlatform:
        def __init__(self,config):pass
        def check_valid(self,current):return check_value
        def get_last_check_overview(self):return {"valid":reported}
    monkeypatch.setattr(lifecycle,"get",lambda _:CheckedPlatform)
    response = state.client.post("/api/lifecycle/check",json={"platform":"chatgpt","limit":1})
    assert response.status_code == 200 and response.json()["data"] == expected
    assert state.repository.get(account.id).validity_status == (
        "unknown" if reported is None else "valid" if reported else "invalid")




@pytest.mark.parametrize("operation", ["check", "refresh", "cpa"])
@pytest.mark.parametrize("overview", [
    {"security_error": "account_deactivated"},
    {"legacy_extra": {"security_error": "account_deactivated"}},
])
def test_lifecycle_skips_saved_deactivation_without_blocking_healthy_accounts(
    lifecycle_fakes, monkeypatch, operation, overview,
):
    from core import lifecycle
    state = lifecycle_fakes
    healthy = state.seed("healthy", refresh=True)
    blocked = state.seed("blocked", refresh=True, overview=overview)
    before = state.repository.get(blocked.id)
    checked = []

    class CheckedPlatform:
        def __init__(self, config):
            pass
        def check_valid(self, account):
            checked.append(account.email)
            return True

    monkeypatch.setattr(lifecycle, "get", lambda _: CheckedPlatform)
    if operation == "check":
        response = state.client.post("/api/lifecycle/check", json={"platform": "chatgpt", "limit": 10})
        assert response.status_code == 200
        assert response.json()["data"] == {"valid": 1, "invalid": 0, "error": 0, "skipped": 1}
        assert checked == [healthy.email]
        assert state.oauth_calls == state.session_calls == state.profile_calls == state.uploads == []
    elif operation == "refresh":
        response = state.client.post("/api/lifecycle/refresh", json={"platform": "chatgpt", "limit": 10})
        assert response.status_code == 200
        assert response.json()["data"] == {"refreshed": 1, "failed": 0, "skipped": 1}
        assert [call["refresh_token"] for call in state.oauth_calls] == ["refresh-healthy"]
        assert state.session_calls == state.profile_calls == state.uploads == []
    else:
        assert lifecycle.refresh_and_sync_cpa() == {
            "refreshed": 1, "uploaded": 1, "dead": 0, "skipped": 1, "error": 0,
        }
        assert state.session_calls == ["session-healthy"]
        assert len(state.profile_calls) == len(state.uploads) == 1
        assert state.oauth_calls == []
    assert state.repository.get(blocked.id) == before
    assert state.repository.get(healthy.id).lifecycle_status == "registered"


def test_lifecycle_check_skips_a_target_deleted_during_the_request(lifecycle_fakes, monkeypatch):
    from core import lifecycle
    state = lifecycle_fakes
    account = state.seed()
    class CheckedPlatform:
        def __init__(self,config):pass
        def check_valid(self,current):
            assert state.repository.delete(account.id)
            return True
    monkeypatch.setattr(lifecycle,"get",lambda _:CheckedPlatform)
    result = lifecycle.check_accounts_validity(platform="chatgpt",limit=1)
    assert result == {"valid":0,"invalid":0,"error":0,"skipped":1}
    assert state.repository.get(account.id) is None
