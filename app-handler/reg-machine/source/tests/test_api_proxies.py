"""Proxy management endpoint tests."""
from __future__ import annotations


def test_list_proxies_empty(client):
    resp = client.get("/api/proxies")
    assert resp.status_code == 200
    data = resp.json()
    assert isinstance(data, list)
    assert len(data) == 0


def test_add_proxy(client):
    resp = client.post("/api/proxies", json={"url": "http://127.0.0.1:7890", "region": "US"})
    assert resp.status_code == 200
    data = resp.json()
    assert data["url"] == "http://127.0.0.1:7890"
    assert data["region"] == "US"


def test_add_and_list_proxy(client):
    client.post("/api/proxies", json={"url": "http://127.0.0.1:7890"})
    resp = client.get("/api/proxies")
    data = resp.json()
    assert len(data) == 1


def test_delete_proxy(client):
    create_resp = client.post("/api/proxies", json={"url": "http://127.0.0.1:7890"})
    proxy_id = create_resp.json()["id"]
    del_resp = client.delete(f"/api/proxies/{proxy_id}")
    assert del_resp.status_code == 200
    # Verify deleted
    list_resp = client.get("/api/proxies")
    assert len(list_resp.json()) == 0


def test_bulk_add_proxies(client):
    resp = client.post("/api/proxies/bulk", json={
        "proxies": ["http://1.1.1.1:8080", "http://2.2.2.2:8080"],
        "region": "SG",
    })
    assert resp.status_code == 200
    list_resp = client.get("/api/proxies")
    assert len(list_resp.json()) == 2


def test_proxy_check_returns_one_durable_job_and_persists_results(client, monkeypatch):
    from types import SimpleNamespace
    from application import tasks
    from core.proxy_pool import proxy_pool
    import requests
    original_check = proxy_pool.check_all
    monkeypatch.setattr(proxy_pool, "check_all", lambda **kwargs: {"ok": 0, "fail": 0})
    for url in ["http://fixture:private@first.example.invalid:80", "http://second.example.invalid:80"]:
        assert client.post("/api/proxies", json={"url": url}).status_code == 200
    first = client.post("/api/proxies/check").json()
    task_id = first.get("task_id")
    assert task_id, "proxy check must expose a persisted task"
    assert client.post("/api/proxies/check").json()["task_id"] == task_id
    assert client.get("/api/proxies/check").json()["task"]["id"] == task_id
    calls = []
    def probe(url, **kwargs):
        assert url == "https://httpbin.org/ip"
        calls.append(kwargs["proxies"]["http"])
        return SimpleNamespace(status_code=200 if len(calls) == 1 else 503)
    monkeypatch.setattr(requests, "get", probe)
    monkeypatch.setattr(proxy_pool, "check_all", original_check)
    tasks.execute_task(task_id)
    result = client.get(f"/api/tasks/{task_id}").json()
    assert result["status"] == "succeeded"
    assert (result["success"], result["error_count"], result["progress"]) == (1, 1, "2/2")
    assert result["result"]["data"] == {"ok": 1, "fail": 1}
    assert client.get("/api/proxies/check").json()["task"] is None
    listed = client.get("/api/proxies").json()
    assert [(row["success_count"], row["fail_count"]) for row in listed] == [(1, 0), (0, 1)]
    events = tasks.list_task_events(task_id)
    assert all("private" not in event["message"] and "example.invalid" not in event["message"] for event in events)
    monkeypatch.setattr(proxy_pool, "check_all", lambda **kwargs: {"ok": 0, "fail": 0})
    assert client.post("/api/proxies/check").json()["task_id"] != task_id


def test_proxy_check_cancellation_keeps_current_result_and_stops_next_probe(client, monkeypatch):
    from types import SimpleNamespace
    from application import tasks
    import requests
    for index in range(2):
        client.post("/api/proxies", json={"url": f"http://fixture-{index}.example.invalid:80"})
    task = tasks.create_proxy_check_task()
    calls = []
    def probe(*args, **kwargs):
        calls.append(True)
        tasks.request_cancel(task["id"])
        return SimpleNamespace(status_code=200)
    monkeypatch.setattr(requests, "get", probe)
    tasks.execute_task(task["id"])
    result = tasks.get_task(task["id"])
    assert calls == [True]
    assert result["status"] == "cancelled" and result["progress"] == "1/2"
    assert result["data"] == {"ok": 1, "fail": 0}


def test_concurrent_proxy_check_submissions_share_one_task_and_resource_key():
    from concurrent.futures import ThreadPoolExecutor
    from application import tasks
    with ThreadPoolExecutor(max_workers=5) as pool:
        created = list(pool.map(lambda _: tasks.create_proxy_check_task(), range(10)))
    assert len({task["id"] for task in created}) == 1
    assert tasks.claim_next_runnable_task()["id"] == created[0]["id"]
    assert tasks.create_proxy_check_task()["id"] == created[0]["id"]
    tasks.create_task(task_type="proxy_check", platform="", payload={})
    assert tasks.claim_next_runnable_task(busy_account_keys={"proxies:check"}) is None


def test_proxy_check_failure_does_not_expose_proxy_credentials(monkeypatch):
    from application import tasks
    from core.proxy_pool import proxy_pool
    task = tasks.create_proxy_check_task()
    def fail(**kwargs):
        raise RuntimeError("http://fixture:private@proxy.example.invalid")
    monkeypatch.setattr(proxy_pool, "check_all", fail)
    tasks.execute_task(task["id"])
    result = tasks.get_task(task["id"])
    assert result["status"] == "failed"
    assert "private" not in result["error"] and "proxy.example.invalid" not in result["error"]
