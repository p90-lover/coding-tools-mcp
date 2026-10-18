"""Concurrent metadata reads must not turn capability seeding into HTTP 500s."""
import threading
import time
from concurrent.futures import ThreadPoolExecutor

from sqlmodel import Session, select

from core import registry
from core.db import PlatformCapabilityOverrideModel, engine
from infrastructure.platform_caps_repository import PlatformCapabilitiesRepository


def _slow_new_capability_commits(monkeypatch):
    original = Session.commit
    def commit(session):
        if any(isinstance(item, PlatformCapabilityOverrideModel) for item in session.new):
            time.sleep(0.02)
        return original(session)
    monkeypatch.setattr(Session, "commit", commit)


def test_simultaneous_cold_metadata_reads_share_capability_seeding(monkeypatch):
    registry.load_all()
    _slow_new_capability_commits(monkeypatch)
    start = threading.Barrier(8)
    def read(index):
        start.wait(timeout=5)
        return registry.list_platforms() if index % 2 else registry.get_platform_capabilities("chatgpt")
    with ThreadPoolExecutor(max_workers=8) as pool:
        results = list(pool.map(read, range(8)))
    assert all(results)
    platforms = registry.list_platforms()
    with Session(engine) as session:
        rows = session.exec(select(PlatformCapabilityOverrideModel)).all()
    assert {item.platform_name for item in rows} == {item["name"] for item in platforms}


def test_reset_update_and_metadata_reads_can_run_together(monkeypatch):
    registry.load_all()
    repository = PlatformCapabilitiesRepository()
    registry.list_platforms()
    _slow_new_capability_commits(monkeypatch)
    start = threading.Barrier(12)
    def operation(index):
        start.wait(timeout=5)
        if index % 4 == 0:
            return repository.reset("chatgpt")
        if index % 4 == 1:
            from domain.platform_caps import PlatformCapabilitiesUpdate
            return repository.update("chatgpt", PlatformCapabilitiesUpdate(supported_oauth_providers=[]))
        return registry.list_platforms()
    with ThreadPoolExecutor(max_workers=12) as pool:
        results = list(pool.map(operation, range(12)))
    assert all(results)
    assert "supported_executors" in registry.get_platform_capabilities("chatgpt")
