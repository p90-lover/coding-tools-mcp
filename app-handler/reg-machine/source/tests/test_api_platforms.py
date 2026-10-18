"""Platform listing endpoint tests."""
from __future__ import annotations


def test_list_platforms(client):
    resp = client.get("/api/platforms")
    assert resp.status_code == 200
    data = resp.json()
    assert isinstance(data, list)
    names = [p["name"] for p in data]
    # At least the core platforms should be loaded
    assert "chatgpt" in names
    assert "cursor" in names


def test_platform_has_required_fields(client):
    resp = client.get("/api/platforms")
    data = resp.json()
    for platform in data:
        assert "name" in platform
        assert "display_name" in platform
        assert "version" in platform
        assert "supported_executors" in platform
        assert isinstance(platform["supported_executors"], list)

def test_warm_platform_metadata_skips_discovery_but_keeps_live_capabilities(client, monkeypatch):
    from core import registry
    from domain.platform_caps import PlatformCapabilitiesUpdate
    from infrastructure.platform_caps_repository import PlatformCapabilitiesRepository

    response = client.get("/api/platforms")
    assert response.status_code == 200
    before = response.json()
    scans = []
    original = registry.pkgutil.iter_modules

    def record_scan(*args, **kwargs):
        scans.append(True)
        return original(*args, **kwargs)

    monkeypatch.setattr(registry.pkgutil, "iter_modules", record_scan)
    assert client.get("/api/platforms").json() == before
    PlatformCapabilitiesRepository().update(
        "chatgpt", PlatformCapabilitiesUpdate(supported_executors=["headless"]))
    current = client.get("/api/platforms").json()
    assert next(item for item in current if item["name"] == "chatgpt")["supported_executors"] == ["headless"]
    assert scans == []
