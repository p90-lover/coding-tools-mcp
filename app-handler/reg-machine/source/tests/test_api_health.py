"""Health / readiness endpoint tests."""
from __future__ import annotations


def test_health(client):
    resp = client.get("/api/health")
    assert resp.status_code == 200
    data = resp.json()
    assert data.get("ok") is True


def test_ready(client):
    resp = client.get("/api/ready")
    assert resp.status_code == 200


def test_frontend_bootstrap_resources_and_deep_links(client):
    import re
    from pathlib import Path
    import pytest
    import main
    if not (Path(main._static_dir) / "index.html").is_file():
        pytest.skip("A frontend build is required for bootstrap resource verification")
    index = client.get("/")
    assert index.status_code == 200 and index.headers["content-type"].startswith("text/html")
    links = re.findall(r'(?:href|src)=["\']([^"\']+)["\']', index.text)
    local = [link for link in links if link.startswith("/")]
    assert "/favicon.svg" in local
    for link in local:
        response = client.get(link)
        assert response.status_code == 200
        assert "text/html" not in response.headers["content-type"], link
    assert client.get("/favicon.svg").headers["content-type"].startswith("image/svg+xml")
    for path in ("/accounts", "/accounts/chatgpt", "/register", "/history", "/tasks", "/authenticator", "/proxies", "/settings?tab=general"):
        response = client.get(path)
        assert response.status_code == 200
        assert response.content == index.content


def test_unknown_get_api_routes_return_json_not_the_frontend(client):
    for path in ("/api", "/api/qa-route-that-does-not-exist"):
        response = client.get(path)
        assert response.status_code == 404
        assert response.headers["content-type"].startswith("application/json")
        assert response.json()["detail"] == "Not Found"
    assert client.get("/api/health").status_code == 200

