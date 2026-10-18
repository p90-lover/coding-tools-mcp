"""Offline Settings API contracts; all data belongs to the fixture database."""


def test_custom_creation_does_not_overwrite_a_builtin_provider_or_its_credentials(client):
    definitions = client.get("/api/provider-definitions", params={"provider_type": "sms"}).json()
    before = next(item for item in definitions if item["provider_key"] == "herosms_api")
    saved = client.post("/api/provider-settings", json={
        "provider_type": "sms", "provider_key": "herosms_api", "enabled": True, "is_default": True,
        "auth": {"herosms_api_key": "fixture-owned-key"}, "config": {"herosms_default_country": "16"},
        "metadata": {"owner": "fixture-owner"},
    })
    assert saved.status_code == 200
    response = client.post("/api/provider-definitions", json={
        "provider_type": "sms", "provider_key": "herosms_api", "label": "Accidental replacement",
        "driver_type": "smsbower_api",
    })
    assert response.status_code == 409
    after = client.get("/api/provider-definitions", params={"provider_type": "sms"}).json()
    assert next(item for item in after if item["provider_key"] == "herosms_api") == before
    settings = client.get("/api/provider-settings", params={"provider_type": "sms"}).json()
    actual = next(item for item in settings if item["provider_key"] == "herosms_api")
    assert actual["auth"]["herosms_api_key"] == "fixture-owned-key"
    assert actual["config"]["herosms_default_country"] == "16"


def test_custom_provider_creation_can_resume_with_the_same_key(client):
    payload = {"provider_type": "sms", "provider_key": "fixture_custom", "label": "Fixture custom",
               "driver_type": "herosms_api"}
    first = client.post("/api/provider-definitions", json=payload)
    assert first.status_code == 200
    second = client.post("/api/provider-definitions", json=payload)
    assert second.status_code == 200
    assert first.json()["item"]["id"] == second.json()["item"]["id"]


def test_missing_definition_update_returns_a_visible_validation_error(client):
    response = client.put("/api/provider-definitions", json={
        "id": 999999, "provider_type": "sms", "provider_key": "fixture_missing",
        "label": "Fixture missing", "driver_type": "herosms_api",
    })
    assert response.status_code == 400
    assert "不存在" in response.json()["detail"]


def test_custom_definition_is_retained_until_its_setting_is_removed(client):
    created = client.post("/api/provider-definitions", json={
        "provider_type": "sms", "provider_key": "fixture_custom", "label": "Fixture custom",
        "driver_type": "herosms_api",
    }).json()["item"]
    client.post("/api/provider-settings", json={
        "provider_type": "sms", "provider_key": "fixture_custom", "auth": {"herosms_api_key": "fixture"},
    })
    assert client.delete("/api/provider-definitions/" + str(created["id"])).status_code == 400
    definitions = client.get("/api/provider-definitions", params={"provider_type": "sms"}).json()
    assert any(item["id"] == created["id"] for item in definitions)
