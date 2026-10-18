"""Authentication/session contracts using only disposable application state."""
import pytest

_PASSWORD = "fixture-access-password"


@pytest.fixture(autouse=True)
def app_password(monkeypatch):
    monkeypatch.setenv("APP_PASSWORD", _PASSWORD)


@pytest.fixture
def terminal_task(client):
    from application import tasks
    task = tasks.create_proxy_check_task()
    tasks.TaskLogger(task["id"]).finish(tasks.TASK_STATUS_SUCCEEDED)
    return task["id"]


def test_login_cookie_authorizes_event_source_without_a_token_url(client, terminal_task):
    response = client.post("/api/auth/login", json={"password": _PASSWORD})
    assert response.json()["ok"] is True
    stream = client.get(f"/api/tasks/{terminal_task}/logs/stream")
    assert stream.status_code == 200
    assert stream.headers["content-type"].startswith("text/event-stream")
    assert '"done": true' in stream.text
    cookie = response.headers["set-cookie"].lower()
    assert "httponly" in cookie and "samesite=strict" in cookie and "path=/api" in cookie


def test_bearer_request_restores_a_missing_stream_cookie(client, terminal_task):
    login = client.post("/api/auth/login", json={"password": _PASSWORD}).json()
    client.cookies.clear()
    response = client.get(f"/api/tasks/{terminal_task}", headers={"Authorization": "Bearer " + login["token"]})
    assert response.status_code == 200
    assert "_auth=" in response.headers.get("set-cookie", "")
    assert client.get(f"/api/tasks/{terminal_task}/logs/stream").status_code == 200


def test_unicode_password_produces_a_header_safe_credential(client, monkeypatch):
    password = "fixture-密碼-🔒"
    monkeypatch.setenv("APP_PASSWORD", password)
    response = client.post("/api/auth/login", json={"password": password})
    assert response.status_code == 200 and response.json()["ok"] is True
    token = response.json()["token"]
    assert token.isascii() and token != password
    client.cookies.clear()
    assert client.get("/api/accounts", headers={"Authorization": "Bearer " + token}).status_code == 200


def test_saved_password_configuration_and_explicit_environment_override(client, monkeypatch):
    from core.config_store import config_store
    config_store.set("app_password", "fixture-saved-password")
    monkeypatch.delenv("APP_PASSWORD")
    assert client.get("/api/auth/check").json()["required"] is True
    assert client.get("/api/accounts").status_code == 401
    assert client.post("/api/auth/login", json={"password": "fixture-saved-password"}).json()["ok"] is True
    monkeypatch.setenv("APP_PASSWORD", "fixture-environment-password")
    assert client.get("/api/accounts").status_code == 401
    assert client.post("/api/auth/login", json={"password": "fixture-saved-password"}).json()["ok"] is False
    assert client.post("/api/auth/login", json={"password": "fixture-environment-password"}).json()["ok"] is True
    monkeypatch.setenv("APP_PASSWORD", "")
    assert client.get("/api/auth/check").json()["required"] is False
    assert client.get("/api/accounts").status_code == 200


@pytest.mark.parametrize("credential_kind", ["header", "cookie"])
def test_legacy_password_credentials_remain_accepted(client, credential_kind):
    if credential_kind == "header":
        response = client.get("/api/accounts", headers={"Authorization": "Bearer " + _PASSWORD})
    else:
        client.cookies.set("_auth", _PASSWORD)
        response = client.get("/api/accounts")
    assert response.status_code == 200


def test_changed_password_invalidates_old_session_credentials(client, monkeypatch):
    login = client.post("/api/auth/login", json={"password": _PASSWORD}).json()
    assert client.get("/api/accounts", headers={"Authorization": "Bearer " + login["token"]}).status_code == 200
    monkeypatch.setenv("APP_PASSWORD", "fixture-replaced-password")
    assert client.get("/api/accounts").status_code == 401
    assert client.get("/api/accounts", headers={"Authorization": "Bearer " + login["token"]}).status_code == 401
    assert client.post("/api/auth/login", json={"password": "fixture-replaced-password"}).json()["ok"] is True
    assert client.get("/api/accounts").status_code == 200


def test_health_is_public_and_public_mode_requires_no_session(client, monkeypatch):
    assert client.get("/api/auth/check").json()["required"] is True
    assert client.get("/api/health").status_code == 200
    assert client.get("/api/ready").status_code == 200
    assert client.post("/api/auth/login", json={"password": "fixture-wrong-password"}).json()["ok"] is False
    assert client.get("/api/accounts").status_code == 401
    monkeypatch.setenv("APP_PASSWORD", "")
    assert client.get("/api/auth/check").json()["required"] is False
    assert client.post("/api/auth/login", json={}).json()["ok"] is True
    assert client.get("/api/accounts").status_code == 200


def test_session_auth_keeps_authenticator_origin_guard(client, monkeypatch):
    from api import authenticator
    def forbidden():
        raise AssertionError("Native vault must not be contacted")
    monkeypatch.setattr(authenticator, "_native_entries", forbidden)
    assert client.get("/api/authenticator/entries").status_code == 401
    assert client.post("/api/auth/login", json={"password": _PASSWORD}).json()["ok"] is True
    response = client.get("/api/authenticator/entries", headers={
        "X-Requested-With": "reg-machine-authenticator", "Origin": "https://foreign.invalid",
        "Sec-Fetch-Site": "cross-site"})
    assert response.status_code == 403


def test_https_login_marks_its_session_cookie_secure(client):
    client.base_url = "https://testserver"
    response = client.post("/api/auth/login", json={"password": _PASSWORD})
    assert response.status_code == 200 and response.json()["ok"] is True
    cookie = response.headers.get("set-cookie", "").lower()
    assert "secure" in cookie and "httponly" in cookie and "samesite=strict" in cookie
