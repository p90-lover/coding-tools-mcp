from __future__ import annotations

from domain.platform_caps import PlatformCapabilitiesUpdate
from infrastructure.platform_caps_repository import PlatformCapabilitiesRepository


class PlatformCapabilitiesService:
    def __init__(self, repository: PlatformCapabilitiesRepository | None = None):
        self.repository = repository or PlatformCapabilitiesRepository()

    def list_platforms(self) -> list[dict]:
        return self.repository.list_platforms()

    def update(self, name: str, payload: dict) -> dict:
        update = PlatformCapabilitiesUpdate(
            supported_executors=list(payload["supported_executors"] or []) if "supported_executors" in payload else None,
            supported_identity_modes=list(payload["supported_identity_modes"] or []) if "supported_identity_modes" in payload else None,
            supported_oauth_providers=list(payload["supported_oauth_providers"] or []) if "supported_oauth_providers" in payload else None,
            capabilities=list(payload["capabilities"] or []) if "capabilities" in payload else None,
        )
        return self.repository.update(name, update)

    def reset(self, name: str) -> dict:
        return self.repository.reset(name)
