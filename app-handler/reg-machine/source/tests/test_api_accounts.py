"""Account CRUD endpoint tests."""
from __future__ import annotations

import base64
import json
from datetime import datetime, timedelta, timezone
import pytest

from application.account_exports import AccountExportsService
from domain.accounts import AccountCreateCommand, AccountExportSelection
from infrastructure.accounts_repository import AccountsRepository


def _make_jwt(payload: dict) -> str:
    header = base64.urlsafe_b64encode(json.dumps({"alg": "none", "typ": "JWT"}).encode()).decode().rstrip("=")
    body = base64.urlsafe_b64encode(json.dumps(payload).encode()).decode().rstrip("=")
    return f"{header}.{body}.sig"


def _create_account(client, **overrides):
    payload = {
        "platform": "chatgpt",
        "email": "test@example.com",
        "password": "TestPass123!",
        **overrides,
    }
    return client.post("/api/accounts", json=payload)


def test_create_account(client):
    resp = _create_account(client)
    assert resp.status_code == 200
    data = resp.json()
    assert data["platform"] == "chatgpt"
    assert data["email"] == "test@example.com"
    assert "id" in data


def test_list_accounts_empty(client):
    resp = client.get("/api/accounts")
    assert resp.status_code == 200
    data = resp.json()
    assert data["total"] == 0
    assert data["items"] == []


def test_list_accounts_after_create(client):
    _create_account(client)
    resp = client.get("/api/accounts")
    data = resp.json()
    assert data["total"] == 1
    assert data["items"][0]["email"] == "test@example.com"


def test_get_account_by_id(client):
    create_resp = _create_account(client)
    account_id = create_resp.json()["id"]
    resp = client.get(f"/api/accounts/{account_id}")
    assert resp.status_code == 200
    assert resp.json()["email"] == "test@example.com"


def test_get_account_not_found(client):
    resp = client.get("/api/accounts/99999")
    assert resp.status_code == 404


def test_delete_account(client):
    create_resp = _create_account(client)
    account_id = create_resp.json()["id"]
    del_resp = client.delete(f"/api/accounts/{account_id}")
    assert del_resp.status_code == 200
    assert del_resp.json()["ok"] is True
    # Verify it's gone
    get_resp = client.get(f"/api/accounts/{account_id}")
    assert get_resp.status_code == 404



@pytest.mark.parametrize("fail_storage", [False, True])
def test_delete_is_scoped_to_one_record_and_rolls_back_storage_failure(client, monkeypatch, fail_storage):
    from sqlalchemy import text
    from sqlmodel import Session
    from core.db import engine, AccountCredentialModel, ProviderAccountModel, ProviderResourceModel
    import infrastructure.accounts_repository as repository_module

    target = _create_account(client, platform="grok", email="same@example.invalid", password="fixture-target").json()["id"]
    survivor = _create_account(client, platform="grok", email="same@example.invalid", password="fixture-survivor").json()["id"]
    assert target != survivor
    with Session(engine) as db:
        for account_id in (target, survivor):
            db.add(AccountCredentialModel(account_id=account_id, provider_name="local-fixture",
                key="fixture_note", value="fixture-value", credential_type="secret"))
            db.add(ProviderAccountModel(account_id=account_id, provider_type="notes",
                provider_name="local-fixture", login_identifier="same-reference"))
            db.add(ProviderResourceModel(account_id=account_id, provider_type="notes",
                provider_name="local-fixture", resource_identifier="same-reference"))
        db.commit()

    owned = ("accounts", "account_overviews", "account_credentials", "provider_accounts", "provider_resources")
    def snapshot(owner=None):
        result = {}
        with Session(engine) as db:
            for table in (*owned, "provider_definitions", "provider_settings"):
                key = "id" if table == "accounts" else "account_id"
                query = "select * from " + table
                if owner is not None and table in owned:
                    query += f" where {key}=:owner"
                query += " order by " + ("account_id" if table == "account_overviews" else "id")
                result[table] = [tuple(row) for row in db.exec(text(query).bindparams(
                    **({"owner": owner} if owner is not None and table in owned else {})
                )).all()]
        return result
    before, survivor_before = snapshot(), snapshot(survivor)
    if fail_storage:
        purge = repository_module.purge_account_graph
        def fail_after_purge(*args):
            purge(*args)
            raise RuntimeError("Fixture delete storage failure")
        monkeypatch.setattr(repository_module, "purge_account_graph", fail_after_purge)
    response = client.delete(f"/api/accounts/{target}")
    if fail_storage:
        assert response.status_code == 500
        assert snapshot() == before
    else:
        assert response.status_code == 200 and response.json()["ok"] is True
        assert client.get(f"/api/accounts/{target}").status_code == 404
        deleted = snapshot(target)
        assert all(not deleted[table] for table in owned)
        assert snapshot(survivor) == survivor_before
        after = snapshot()
        for table in ("provider_definitions", "provider_settings"):
            assert after[table] == before[table]
        assert client.delete(f"/api/accounts/{target}").status_code == 404
        assert snapshot() == after
    assert client.get(f"/api/accounts/{survivor}").status_code == 200


def test_update_account(client):
    create_resp = _create_account(client)
    account_id = create_resp.json()["id"]
    patch_resp = client.patch(
        f"/api/accounts/{account_id}",
        json={"password": "NewPass456!"},
    )
    assert patch_resp.status_code == 200


def test_filter_accounts_by_platform(client):
    _create_account(client, platform="chatgpt", email="a@test.com")
    _create_account(client, platform="cursor", email="b@test.com")
    resp = client.get("/api/accounts", params={"platform": "cursor"})
    data = resp.json()
    assert data["total"] == 1
    assert data["items"][0]["platform"] == "cursor"


def test_account_stats(client):
    _create_account(client)
    resp = client.get("/api/accounts/stats")
    assert resp.status_code == 200


def test_export_kiro_go(client):
    # Create a kiro account first
    client.post("/api/accounts", json={
        "platform": "kiro",
        "email": "kiro@test.com",
        "password": "",
    })
    resp = client.post("/api/accounts/export/kiro-go", json={
        "platform": "kiro",
        "select_all": True,
    })
    assert resp.status_code == 200
    assert "kiro_go_config" in resp.headers.get("content-disposition", "")


def test_export_any2api_multi_platform(client):
    client.post("/api/accounts", json={"platform": "kiro", "email": "k@test.com", "password": ""})
    client.post("/api/accounts", json={"platform": "grok", "email": "g@test.com", "password": ""})
    client.post("/api/accounts", json={"platform": "cursor", "email": "c@test.com", "password": ""})
    resp = client.post("/api/accounts/export/any2api", json={"select_all": True})
    assert resp.status_code == 200
    assert "any2api_admin" in resp.headers.get("content-disposition", "")



@pytest.mark.parametrize("platform,credential_key", [
    ("chatgpt", "access_token"), ("cursor", "session_token"), ("blink", "firebase_refresh_token"),
])
def test_any2api_multiple_single_config_accounts_require_explicit_selection(client, platform, credential_key):
    ids = []
    for index in range(2):
        created = _create_account(client, platform=platform, email=f"fixture-{platform}-{index}@example.invalid",
                                  credentials={credential_key: f"fixture-{platform}-{index}-credential"})
        assert created.status_code == 200
        ids.append(created.json()["id"])
    response = client.post("/api/accounts/export/any2api", json={"platform": platform, "select_all": True})
    assert response.status_code == 400
    assert "一个账号" in response.json()["detail"]
    assert client.get("/api/accounts", params={"platform": platform}).json()["total"] == 2
    selected = client.post("/api/accounts/export/any2api", json={"platform": platform, "ids": [ids[0]]})
    assert selected.status_code == 200
    assert f"fixture-{platform}-0-credential" in selected.text
    assert f"fixture-{platform}-1-credential" not in selected.text


def test_chatgpt_csv_roundtrip_restores_passwordless_oauth_credentials():
    from application.accounts import AccountsService
    from domain.accounts import AccountQuery

    repository = AccountsRepository()
    for index, password in enumerate(("", "fixture-password")):
        credentials = {key: f"fixture-{index}-{key}" for key in
            ("access_token", "refresh_token", "id_token", "session_token", "client_id", "account_id", "workspace_id")}
        original = repository.create(AccountCreateCommand(
            platform="chatgpt", email=f"roundtrip-{index}@example.com", password=password, credentials=credentials))
        artifact = AccountExportsService(repository).export_chatgpt_csv(
            AccountExportSelection(platform="chatgpt", ids=[original.id]))
        result = AccountsService(repository).import_accounts("chatgpt", artifact.content.splitlines())
        assert result["created"] == 1
        _, items = repository.list(AccountQuery(platform="chatgpt", email=original.email))
        restored = next(item for item in items if item.id != original.id)
        assert restored.password == password
        restored_credentials = {item["key"]: item["value"] for item in restored.credentials}
        assert all(restored_credentials.get(key) == value for key, value in credentials.items())


def test_export_cpa_uses_standard_payload_schema():
    exp_timestamp = 1777166030
    expected_expired = datetime.fromtimestamp(
        exp_timestamp, tz=timezone(timedelta(hours=8))
    ).strftime("%Y-%m-%dT%H:%M:%S+08:00")
    access_token = _make_jwt({
        "exp": exp_timestamp,
        "https://api.openai.com/auth": {
            "chatgpt_account_id": "acct-standard",
        },
    })
    id_token = _make_jwt({
        "https://api.openai.com/auth": {
            "chatgpt_account_id": "acct-standard",
        },
    })
    repository = AccountsRepository()
    repository.create(
        AccountCreateCommand(
            platform="chatgpt",
            email="cpa@test.com",
            password="TestPass123!",
            user_id="acct-standard",
            credentials={
                "access_token": access_token,
                "refresh_token": "rt_standard",
                "id_token": id_token,
            },
        )
    )
    service = AccountExportsService(repository)

    artifact = service.export_chatgpt_cpa(AccountExportSelection(platform="chatgpt", select_all=True))
    payload = json.loads(artifact.content)
    assert list(payload.keys()) == [
        "access_token",
        "account_id",
        "email",
        "expired",
        "id_token",
        "last_refresh",
        "refresh_token",
        "type",
    ]
    assert payload["access_token"] == access_token
    assert payload["account_id"] == "acct-standard"
    assert payload["email"] == "cpa@test.com"
    assert payload["expired"] == expected_expired
    assert payload["id_token"] == id_token
    assert payload["last_refresh"].endswith("+08:00")
    assert payload["refresh_token"] == "rt_standard"
    assert payload["type"] == "codex"


def test_export_cpa_falls_back_to_stored_user_id_for_account_id():
    repository = AccountsRepository()
    repository.create(
        AccountCreateCommand(
            platform="chatgpt",
            email="fallback@test.com",
            password="TestPass123!",
            user_id="acct-from-user-id",
            credentials={
                "access_token": _make_jwt({"exp": 1777166030}),
                "refresh_token": "rt_fallback",
            },
        )
    )
    service = AccountExportsService(repository)

    artifact = service.export_chatgpt_cpa(AccountExportSelection(platform="chatgpt", select_all=True))
    payload = json.loads(artifact.content)
    assert payload["account_id"] == "acct-from-user-id"
    assert payload["refresh_token"] == "rt_fallback"


def test_export_cpa_rejects_account_without_auth_tokens(client):
    account = _create_account(client, email="no-auth@test.com", user_id="acct-no-auth").json()

    response = client.post("/api/accounts/export/cpa", json={
        "platform": "chatgpt",
        "ids": [account["id"]],
    })

    assert response.status_code == 400
    assert "访问/刷新 Token" in response.json()["detail"]


def test_export_cpa_all_and_selected_accounts(client):
    import io
    import zipfile

    ids = []
    for email in ("first@example.com", "second@example.com"):
        response = _create_account(
            client, email=email, user_id=email,
            credentials={"access_token": "test-access", "refresh_token": "test-refresh"},
        )
        ids.append(response.json()["id"])
    _create_account(client, platform="grok", email="grok@example.com")

    response = client.post("/api/accounts/export/cpa", json={
        "platform": "chatgpt", "select_all": True,
    })
    assert response.status_code == 200
    with zipfile.ZipFile(io.BytesIO(response.content)) as archive:
        assert set(archive.namelist()) == {"first@example.com.json", "second@example.com.json"}
        assert all(json.loads(archive.read(name))["type"] == "codex" for name in archive.namelist())

    response = client.post("/api/accounts/export/cpa", json={
        "platform": "chatgpt", "ids": [ids[1]],
    })
    assert response.status_code == 200
    assert response.json()["email"] == "second@example.com"


def test_export_cpa_rejects_empty_result(client):
    response = client.post("/api/accounts/export/cpa", json={
        "platform": "chatgpt", "select_all": True,
    })
    assert response.status_code == 400



@pytest.mark.parametrize("term,matching,nonmatching", [
    ("under_", "under_value", "underXvalue"),
    ("percent%", "percent%value", "percentvalue"),
    ("slash/", "slash/value", "slashvalue"),
    ("combo/_%", "combo/_%value", "combo/Xvalue"),
])
def test_email_search_and_csv_selection_use_literal_text(client, term, matching, nonmatching):
    import csv
    import io

    wanted_email = matching + "@example.invalid"
    wanted = _create_account(client, platform="grok", email=wanted_email,
        password='fixture,"password"', lifecycle_status="invalid").json()["id"]
    _create_account(client, platform="grok", email=nonmatching + "@example.invalid",
        lifecycle_status="invalid")
    _create_account(client, platform="cursor", email=wanted_email, lifecycle_status="invalid")

    for search in (term, term.upper()):
        response = client.get("/api/accounts", params={
            "platform": "grok", "email": search, "status": "invalid", "page_size": 1,
        })
        assert response.status_code == 200
        assert response.json()["total"] == 1
        assert [item["id"] for item in response.json()["items"]] == [wanted]
        second = client.get("/api/accounts", params={
            "platform": "grok", "email": search, "page": 2, "page_size": 1,
        }).json()
        assert second["total"] == 1 and second["items"] == []

    payload = {"platform": "grok", "select_all": True, "search_filter": term, "status_filter": "invalid"}
    response = client.post("/api/accounts/export/table-csv", json=payload)
    assert response.status_code == 200
    exported = list(csv.DictReader(io.StringIO(response.text)))
    assert [item["email"] for item in exported] == [wanted_email]
    assert exported[0]["password"] == 'fixture,"password"'
    legacy = client.get("/api/accounts/export", params={"platform": "grok", "email": term, "status": "invalid"})
    assert legacy.status_code == 200
    assert [item["email"] for item in csv.DictReader(io.StringIO(legacy.text))] == [wanted_email]


def test_generic_csv_exports_all_filtered_pages_and_only_selected_ids(client):
    import csv
    import io
    from sqlmodel import Session
    from core.db import AccountModel, AccountOverviewModel, engine
    with Session(engine) as session:
        rows = [AccountModel(platform="grok", email=f"fixture-{index:03d}@example.invalid",
                             password='fixture,"password"') for index in range(205)]
        session.add_all(rows)
        session.add(AccountModel(platform="cursor", email="other@example.invalid", password="other"))
        session.flush()
        wanted_id = rows[0].id
        session.add(AccountOverviewModel(account_id=wanted_id, lifecycle_status="invalid",
                                        validity_status="invalid", display_status="invalid"))
        session.commit()
    pages = [client.get("/api/accounts", params={"platform": "grok", "page": page, "page_size": 100}).json()
             for page in (1, 2, 3)]
    assert [len(page["items"]) for page in pages] == [100, 100, 5]
    assert all(page["total"] == 205 for page in pages)
    assert len({row["id"] for page in pages for row in page["items"]}) == 205

    def exported(payload):
        response = client.post("/api/accounts/export/table-csv", json=payload)
        assert response.status_code == 200
        return list(csv.DictReader(io.StringIO(response.text)))

    all_rows = exported({"platform": "grok", "select_all": True})
    assert len(all_rows) == 205 and all(row["platform"] == "grok" for row in all_rows)
    selected = exported({"platform": "grok", "ids": [wanted_id]})
    assert len(selected) == 1 and selected[0]["email"] == "fixture-000@example.invalid"
    assert selected[0]["password"] == 'fixture,"password"'
    filtered = exported({"platform": "grok", "select_all": True,
                         "status_filter": "invalid", "search_filter": "fixture-000"})
    assert [row["email"] for row in filtered] == ["fixture-000@example.invalid"]
    assert exported({"platform": "cursor", "ids": [wanted_id]}) == []
    assert client.post("/api/accounts/export/table-csv", json={"platform": "grok"}).status_code == 400
    legacy = client.get("/api/accounts/export", params={"platform": "grok", "email": "fixture-000"})
    assert legacy.status_code == 200
    assert [row["email"] for row in csv.DictReader(io.StringIO(legacy.text))] == ["fixture-000@example.invalid"]


def test_any2api_default_provider_is_present_in_the_export(client):
    cases = [
        ("chatgpt", {"access_token": "fixture-access"}, "chatgptConfig"),
        ("grok", {"sso": "fixture-sso"}, "grokTokens"),
        ("blink", {"firebase_refresh_token": "fixture-refresh"}, "blinkConfig"),
        ("cursor", {"session_token": "fixture-session"}, "cursorConfig"),
        ("kiro", {"refresh_token": "fixture-refresh"}, "kiroAccounts"),
    ]
    for platform, credentials, provider_key in cases:
        created = _create_account(client, platform=platform,
                                  email=f"fixture-{platform}@example.invalid", credentials=credentials)
        assert created.status_code == 200
        response = client.post("/api/accounts/export/any2api", json={
            "platform": platform, "ids": [created.json()["id"]],
        })
        assert response.status_code == 200
        payload = response.json()
        assert payload["providers"][provider_key]
        assert payload["settings"]["defaultProvider"] == platform


def test_any2api_mixed_export_retains_existing_provider_precedence(client):
    _create_account(client, email="fixture-chatgpt@example.invalid",
                    credentials={"access_token": "fixture-access"})
    _create_account(client, platform="cursor", email="fixture-cursor@example.invalid",
                    credentials={"session_token": "fixture-session"})
    body = {"platform": "", "select_all": True}
    assert client.post("/api/accounts/export/any2api", json=body).json()["settings"]["defaultProvider"] == "cursor"
    _create_account(client, platform="kiro", email="fixture-kiro@example.invalid",
                    credentials={"refresh_token": "fixture-refresh"})
    assert client.post("/api/accounts/export/any2api", json=body).json()["settings"]["defaultProvider"] == "kiro"

def test_create_invalid_graph_rolls_back_account(client):
    response = _create_account(client, email="rollback-create@example.invalid",
                               overview={"trial_end_time": "invalid-fixture-value"})
    assert response.status_code == 400
    assert client.get("/api/accounts").json()["total"] == 0


def test_failed_graph_update_rolls_back_all_fields(client, monkeypatch):
    import infrastructure.accounts_repository as repository
    created = _create_account(client, email="rollback-update@example.invalid", user_id="fixture-original-id",
                              lifecycle_status="phone_required", credentials={"access_token": "fixture-original-token"})
    account_id = created.json()["id"]
    original = client.get(f"/api/accounts/{account_id}").json()
    persist = repository.patch_account_graph

    def fail_after_graph_write(*args, **kwargs):
        persist(*args, **kwargs)
        raise RuntimeError("Fixture storage failure after graph write")

    monkeypatch.setattr(repository, "patch_account_graph", fail_after_graph_write)
    response = client.patch(f"/api/accounts/{account_id}", json={
        "password": "fixture-new-password", "user_id": "fixture-new-id",
        "primary_token": "fixture-new-token", "lifecycle_status": "2fa_required",
        "cashier_url": "https://fixture.invalid/changed",
    })
    assert response.status_code == 500
    restored = client.get(f"/api/accounts/{account_id}").json()
    for key in ("password", "user_id", "primary_token", "lifecycle_status", "cashier_url", "updated_at"):
        assert restored[key] == original[key], key
    assert restored["credentials"] == original["credentials"]


def test_failed_create_after_graph_write_leaves_no_orphan_rows(client, monkeypatch):
    import infrastructure.accounts_repository as repository
    from core.db import AccountModel, AccountCredentialModel, AccountOverviewModel, engine
    from sqlmodel import Session, select
    persist = repository.patch_account_graph

    def fail_after_graph_write(*args, **kwargs):
        persist(*args, **kwargs)
        raise RuntimeError("Fixture create storage failure")

    monkeypatch.setattr(repository, "patch_account_graph", fail_after_graph_write)
    response = _create_account(client, email="failed-create@example.invalid",
                               credentials={"access_token": "fixture-create-token"})
    assert response.status_code == 500
    with Session(engine) as session:
        for model in (AccountModel, AccountCredentialModel, AccountOverviewModel):
            assert session.exec(select(model)).all() == []


def test_invalid_import_rolls_back_the_entire_batch(client):
    response = client.post("/api/accounts/import", json={"platform": "chatgpt", "lines": [
        'first@example.invalid fixture-first {"credentials":{"access_token":"fixture-first-token"}}',
        'second@example.invalid fixture-second {"overview":{"trial_end_time":"invalid-fixture-value"}}',
    ]})
    assert response.status_code == 400
    assert client.get("/api/accounts").json()["total"] == 0


def test_repeated_email_import_preserves_each_line_credentials(client):
    response = client.post("/api/accounts/import", json={"platform": "chatgpt", "lines": [
        'repeat@example.invalid fixture-first {"credentials":{"access_token":"fixture-first-token"}}',
        'repeat@example.invalid fixture-second {"credentials":{"access_token":"fixture-second-token"}}',
    ]})
    assert response.status_code == 200 and response.json()["created"] == 2
    items = client.get("/api/accounts").json()["items"]
    assert {item["password"]: item["primary_token"] for item in items} == {
        "fixture-first": "fixture-first-token", "fixture-second": "fixture-second-token",
    }


def test_account_pages_load_only_requested_account_details(client, monkeypatch):
    from sqlmodel import Session, select
    from core.account_graph import matches_status_filter
    from core.db import AccountModel, AccountOverviewModel, engine

    states = [
        {"lifecycle_status": "registered", "display_status": "registered", "plan_state": "free", "validity_status": "valid"},
        {"lifecycle_status": "phone_required", "display_status": "phone_required"},
        {"lifecycle_status": "registered", "display_status": "invalid", "plan_state": "trial", "validity_status": "invalid"},
        {"lifecycle_status": "failed", "display_status": "", "plan_state": "", "validity_status": ""},
        {"lifecycle_status": " \tphone_required\n", "display_status": "\t ", "plan_state": " free ", "validity_status": " valid "},
        None,
    ]
    with Session(engine) as session:
        for index in range(43):
            model = AccountModel(platform="chatgpt", email=f"fast-{index:03d}@example.invalid",
                                 password="fixture", created_at=datetime(2026, 1, 1, tzinfo=timezone.utc))
            session.add(model)
            session.flush()
            state = states[index % len(states)]
            if state is not None:
                session.add(AccountOverviewModel(account_id=model.id, **state))
        session.add(AccountModel(platform="grok", email="fast-other@example.invalid", password="fixture"))
        session.commit()
        models = session.exec(select(AccountModel).where(AccountModel.platform == "chatgpt")
                              .order_by(AccountModel.created_at.desc(), AccountModel.id.desc())).all()
        expected = AccountsRepository._load_records(session, models)

    original_load = AccountsRepository._load_records
    detail_counts = []

    def load_page(session, models):
        detail_counts.append(len(models))
        assert len(models) <= 7, "Account details must be loaded after filtering and pagination"
        return original_load(session, models)

    monkeypatch.setattr(AccountsRepository, "_load_records", staticmethod(load_page))
    for status in ("", " phone_required ", "free", "invalid", "unknown", "registered", "valid", "\t", "absent"):
        filtered = [item for item in expected if matches_status_filter({
            "lifecycle_status": item.lifecycle_status, "display_status": item.display_status,
            "plan_state": item.plan_state, "validity_status": item.validity_status,
        }, status)]
        for page in (1, 2, 99):
            response = client.get("/api/accounts", params={
                "platform": "chatgpt", "email": "fast-", "status": status, "page": page, "page_size": 7,
            })
            assert response.status_code == 200
            data = response.json()
            assert data["total"] == len(filtered), status
            assert [item["id"] for item in data["items"]] == [item.id for item in filtered[(page - 1) * 7:page * 7]]
    assert detail_counts and max(detail_counts) == 7


def test_account_statistics_skip_credentials_and_overview_json(client):
    from sqlalchemy import event
    from sqlmodel import Session
    from core.db import AccountModel, AccountCredentialModel, AccountOverviewModel, engine

    with Session(engine) as session:
        first = AccountModel(platform="chatgpt", email="fast-summary@example.invalid", password="fixture")
        second = AccountModel(platform="grok", email="fast-missing@example.invalid", password="fixture")
        session.add_all([first, second])
        session.flush()
        session.add(AccountOverviewModel(account_id=first.id, lifecycle_status="phone_required",
                                        display_status="phone_required", plan_state="free", validity_status="valid",
                                        summary_json='{"unused":"fixture-heavy-summary"}'))
        session.add(AccountCredentialModel(account_id=first.id, key="access_token", value="fixture-unused-token"))
        session.commit()

    statements = []

    def capture(connection, cursor, statement, parameters, context, many):
        statements.append(statement.lower())

    event.listen(engine, "before_cursor_execute", capture)
    try:
        response = client.get("/api/accounts/stats")
    finally:
        event.remove(engine, "before_cursor_execute", capture)
    assert response.status_code == 200
    data = response.json()
    assert data["total"] == 2
    assert data["by_platform"] == {"chatgpt": 1, "grok": 1}
    assert data["by_lifecycle_status"] == {"phone_required": 1, "registered": 1}
    assert data["by_plan_state"] == {"free": 1, "unknown": 1}
    assert data["by_validity_status"] == {"valid": 1, "unknown": 1}
    assert data["by_display_status"] == {"phone_required": 1, "registered": 1}
    assert not any(any(name in statement for name in (
        "account_credentials", "provider_accounts", "provider_resources", "summary_json",
    )) for statement in statements)


def test_first_account_page_avoids_unnecessary_count_query(client):
    from sqlalchemy import event
    from core.db import engine
    _create_account(client, email="short-page@example.invalid")
    statements = []

    def capture(connection, cursor, statement, parameters, context, many):
        statements.append(statement.lower())

    event.listen(engine, "before_cursor_execute", capture)
    try:
        response = client.get("/api/accounts", params={"page_size": 100})
    finally:
        event.remove(engine, "before_cursor_execute", capture)
    assert response.status_code == 200
    assert response.json()["total"] == len(response.json()["items"]) == 1
    assert not any("count(" in statement for statement in statements)
    beyond = client.get("/api/accounts", params={"page_size": 100, "page": 99}).json()
    assert beyond["total"] == 1 and beyond["items"] == []


def test_account_list_direct_json_preserves_dates_unicode_and_strict_numbers(client, monkeypatch):
    import api.accounts as accounts_api
    from fastapi.encoders import jsonable_encoder
    from fastapi.responses import JSONResponse
    checked_at = datetime(2026, 1, 1, tzinfo=timezone.utc)
    payload = {"total": 1, "page": 1, "items": [{
        "id": 1, "display_status": "已注册", "overview": {"checked_at": checked_at},
        "credentials": [{"key": "access_token", "value": "fixture-json-token"}],
    }]}
    monkeypatch.setattr(accounts_api.service, "list_accounts", lambda query: payload)
    converted = []

    def convert_non_native(value):
        converted.append(value)
        assert not isinstance(value, (dict, list)), "Native JSON containers must avoid the recursive conversion"
        return jsonable_encoder(value)

    monkeypatch.setattr(accounts_api, "jsonable_encoder", convert_non_native)
    response = client.get("/api/accounts")
    assert response.status_code == 200
    assert response.headers["content-type"] == "application/json"
    assert response.content == JSONResponse(jsonable_encoder(payload)).body
    assert converted == [checked_at]
    payload["items"][0]["quota"] = float("nan")
    assert client.get("/api/accounts").status_code == 500


@pytest.mark.parametrize("email", ["fixture-帳戶@example.invalid", "fixture%name@example.invalid"])
@pytest.mark.parametrize("format", ["cpa", "sub2api"])
def test_single_account_download_preserves_filename_and_payload(client, email, format):
    from email.message import Message
    created = _create_account(client, email=email, user_id="fixture-export-account",
        credentials={"access_token": "fixture-export-access", "refresh_token": "fixture-export-refresh"})
    assert created.status_code == 200
    account_id = created.json()["id"]
    before = client.get(f"/api/accounts/{account_id}").json()
    response = client.post(f"/api/accounts/export/{format}", json={"platform": "chatgpt", "ids": [account_id]})
    assert response.status_code == 200
    header = response.headers["content-disposition"]
    assert header.isascii()
    message = Message()
    message["Content-Disposition"] = header
    expected = email + ("_sub2api.json" if format == "sub2api" else ".json")
    assert message.get_filename() == expected
    payload = response.json()
    assert (payload["email"] if format == "cpa" else payload["accounts"][0]["name"]) == email
    assert client.get(f"/api/accounts/{account_id}").json() == before


@pytest.mark.parametrize("format", ["cpa", "sub2api"])
@pytest.mark.parametrize("second_email", ["same-export@example.invalid", "SAME-EXPORT@EXAMPLE.INVALID"])
def test_archive_export_keeps_distinct_records_with_the_same_email(client, format, second_email):
    import io
    import zipfile
    ids = []
    for index in range(2):
        created = _create_account(client, email="same-export@example.invalid" if index == 0 else second_email, user_id=f"fixture-owner-{index}",
            credentials={"access_token": f"fixture-access-{index}", "refresh_token": f"fixture-refresh-{index}"})
        assert created.status_code == 200
        ids.append(created.json()["id"])
    response = client.post(f"/api/accounts/export/{format}", json={"platform": "chatgpt", "ids": ids})
    assert response.status_code == 200
    with zipfile.ZipFile(io.BytesIO(response.content)) as archive:
        names = archive.namelist()
        assert len(names) == len({name.casefold() for name in names}) == 2
        payloads = [json.loads(archive.read(name)) for name in names]
    owners = {payload["account_id"] if format == "cpa" else
              payload["accounts"][0]["credentials"]["chatgpt_account_id"] for payload in payloads}
    assert owners == {"fixture-owner-0", "fixture-owner-1"}


@pytest.mark.parametrize("format", ["cpa", "sub2api"])
@pytest.mark.parametrize("emails", [
    ("folder/name@example.invalid", "folder\\name@example.invalid"),
    ("fixture\0first@example.invalid", "fixture\0second@example.invalid"),
    ("../outside@example.invalid", "..\\outside@example.invalid"),
])
def test_archive_export_names_are_simple_and_unique_after_zip_normalization(client, format, emails):
    import io
    import zipfile
    from pathlib import PurePosixPath, PureWindowsPath
    ids = []
    for index, email in enumerate(emails):
        response = _create_account(client, email=email, user_id=f"fixture-normalized-{index}",
            credentials={"access_token": f"fixture-access-{index}", "refresh_token": f"fixture-refresh-{index}"})
        assert response.status_code == 200
        ids.append(response.json()["id"])
    response = client.post(f"/api/accounts/export/{format}", json={"platform": "chatgpt", "ids": ids})
    assert response.status_code == 200
    with zipfile.ZipFile(io.BytesIO(response.content)) as archive:
        names = archive.namelist()
        assert len(names) == len({name.casefold() for name in names}) == 2
        assert all(name == PurePosixPath(name).name == PureWindowsPath(name).name for name in names)
        assert all(name.endswith(".json") and not any(ord(char) < 32 or char in '<>:"/\\|?*' for char in name) for name in names)
        payloads = [json.loads(archive.read(name)) for name in names]
    identities = {payload["email"] if format == "cpa" else payload["accounts"][0]["name"] for payload in payloads}
    assert identities == set(emails)


@pytest.mark.parametrize("format", ["cpa", "sub2api"])
def test_single_export_names_are_simple_without_changing_identity(client, format):
    from email.message import Message
    from pathlib import PurePosixPath, PureWindowsPath
    for index, email in enumerate(("../outside@example.invalid", "folder\\name@example.invalid", "fixture\0value@example.invalid", 'quoted"name@example.invalid')):
        response = _create_account(client, email=email, user_id=f"fixture-single-{index}",
            credentials={"access_token": f"fixture-access-{index}", "refresh_token": f"fixture-refresh-{index}"})
        assert response.status_code == 200
        response = client.post(f"/api/accounts/export/{format}", json={"platform": "chatgpt", "ids": [response.json()["id"]]})
        assert response.status_code == 200
        message = Message()
        message["Content-Disposition"] = response.headers["content-disposition"]
        name = message.get_filename()
        assert name == PurePosixPath(name).name == PureWindowsPath(name).name
        assert name.endswith(".json") and not any(ord(char) < 32 or char in '<>:"/\\|?*' for char in name)
        payload = response.json()
        assert (payload["email"] if format == "cpa" else payload["accounts"][0]["name"]) == email


@pytest.mark.parametrize("format", ["cpa", "sub2api"])
def test_export_names_avoid_windows_device_names(client, format):
    import ntpath
    from email.message import Message
    for index, email in enumerate(("CON", "con.txt", "AUX.thing", "LPT1", "COM¹")):
        response = _create_account(client, email=email, user_id=f"fixture-device-{index}",
            credentials={"access_token": f"fixture-access-{index}", "refresh_token": f"fixture-refresh-{index}"})
        assert response.status_code == 200
        response = client.post(f"/api/accounts/export/{format}", json={"platform": "chatgpt", "ids": [response.json()["id"]]})
        assert response.status_code == 200
        message = Message()
        message["Content-Disposition"] = response.headers["content-disposition"]
        filename = message.get_filename()
        from pathlib import PureWindowsPath
        is_reserved = getattr(ntpath, 'isreserved', lambda value: PureWindowsPath(value).is_reserved())
        assert not is_reserved(filename)
        payload = response.json()
        assert (payload["email"] if format == "cpa" else payload["accounts"][0]["name"]) == email


@pytest.mark.parametrize("format", ["cpa", "sub2api"])
def test_long_export_names_stay_bounded_and_archive_identities_remain_distinct(client, format):
    import io
    import zipfile
    from email.message import Message
    long_email = "a" * 64 + "@" + "b" * 63 + "." + "c" * 63 + "." + "d" * 57 + ".com"
    assert len(long_email) == 254
    emails = [long_email, long_email[:-4] + ".net", "戶" * 130 + "a@example.invalid", "戶" * 130 + "b@example.invalid"]
    ids = []
    for index, email in enumerate(emails):
        response = _create_account(client, email=email, user_id=f"fixture-long-{index}",
            credentials={"access_token": f"fixture-access-{index}", "refresh_token": f"fixture-refresh-{index}"})
        assert response.status_code == 200
        ids.append(response.json()["id"])
        response = client.post(f"/api/accounts/export/{format}", json={"platform": "chatgpt", "ids": [ids[-1]]})
        assert response.status_code == 200
        message = Message()
        message["Content-Disposition"] = response.headers["content-disposition"]
        filename = message.get_filename()
        assert len(filename.encode("utf-8")) <= 255 and filename.endswith(".json")
    response = client.post(f"/api/accounts/export/{format}", json={"platform": "chatgpt", "ids": ids})
    assert response.status_code == 200
    with zipfile.ZipFile(io.BytesIO(response.content)) as archive:
        names = archive.namelist()
        assert len(names) == len({name.casefold() for name in names}) == len(ids)
        assert all(len(name.encode("utf-8")) <= 255 and "\ufffd" not in name for name in names)
        payloads = [json.loads(archive.read(name)) for name in names]
    identities = {payload["email"] if format == "cpa" else payload["accounts"][0]["name"] for payload in payloads}
    assert identities == set(emails)


def test_cpa_export_missing_identity_does_not_contact_or_refresh_remote_account(client, monkeypatch):
    from platforms.chatgpt import cpa_upload
    attempted = []
    def forbidden(*args, **kwargs):
        attempted.append(True)
        raise AssertionError("Implicit remote lookup is forbidden during export")
    monkeypatch.setattr(cpa_upload.cffi_requests, "get", forbidden)
    monkeypatch.setattr(cpa_upload.cffi_requests, "Session", forbidden)
    created = _create_account(client, email="fixture-offline@example.invalid", user_id="",
        lifecycle_status="phone_required", credentials={"access_token": "fixture-opaque-access",
            "refresh_token": "fixture-refresh", "session_token": "fixture-session"})
    assert created.status_code == 200
    account_id = created.json()["id"]
    before = client.get(f"/api/accounts/{account_id}").json()
    response = client.post("/api/accounts/export/cpa", json={"platform": "chatgpt", "ids": [account_id]})
    assert response.status_code == 400
    assert attempted == []
    assert client.get(f"/api/accounts/{account_id}").json() == before


@pytest.mark.parametrize("claims", [None, [], True, 7, "fixture", {"https://api.openai.com/auth": []},
    {"exp": 10**100, "iat": 10**100}])
def test_exports_preserve_opaque_credentials_when_optional_claims_are_malformed(client, claims):
    import csv
    import io
    token = _make_jwt(claims)
    created = _create_account(client, email="fixture-claims@example.invalid", user_id="fixture-saved-account",
        credentials={"access_token": token, "id_token": token, "refresh_token": "fixture-refresh"})
    assert created.status_code == 200
    account_id = created.json()["id"]
    before = client.get(f"/api/accounts/{account_id}").json()
    for format in ("json", "csv", "cpa", "sub2api"):
        response = client.post(f"/api/accounts/export/{format}", json={"platform": "chatgpt", "ids": [account_id]})
        assert response.status_code == 200, format
        if format == "json":
            assert response.json()[0]["access_token"] == token
        elif format == "csv":
            assert list(csv.DictReader(io.StringIO(response.text)))[0]["Access Token"] == token
        elif format == "cpa":
            assert response.json()["access_token"] == token and response.json()["account_id"] == "fixture-saved-account"
        else:
            assert response.json()["accounts"][0]["credentials"]["access_token"] == token
    assert client.get(f"/api/accounts/{account_id}").json() == before


@pytest.mark.parametrize("auth_claims", [None, [], "fixture", 42,
    {"chatgpt_account_id": {"unexpected": "object"}}, {"chatgpt_account_id": ["unexpected"]},
    {"chatgpt_account_id": True}, {"chatgpt_account_id": 42}])
def test_invalid_identity_claims_remain_incomplete_without_network(client, monkeypatch, auth_claims):
    from platforms.chatgpt import cpa_upload
    attempted = []
    def forbidden(*args, **kwargs):
        attempted.append(True)
        raise AssertionError("Export cannot repair identity over the network")
    monkeypatch.setattr(cpa_upload.cffi_requests, "get", forbidden)
    monkeypatch.setattr(cpa_upload.cffi_requests, "Session", forbidden)
    token = _make_jwt({"https://api.openai.com/auth": auth_claims})
    created = _create_account(client, email="fixture-incomplete-claims@example.invalid", user_id="",
        lifecycle_status="phone_required", credentials={"access_token": token, "id_token": token,
            "refresh_token": "fixture-refresh", "session_token": "fixture-session"})
    assert created.status_code == 200
    account_id = created.json()["id"]
    before = client.get(f"/api/accounts/{account_id}").json()
    response = client.post("/api/accounts/export/cpa", json={"platform": "chatgpt", "ids": [account_id]})
    assert response.status_code == 400
    assert attempted == []
    assert client.get(f"/api/accounts/{account_id}").json() == before
