from __future__ import annotations

from datetime import datetime, timezone

from sqlmodel import Session, select

from core.db import PlatformCapabilityOverrideModel, engine
from core.registry import _capabilities_lock, get_platform_capabilities, list_platforms
from domain.platform_caps import PlatformCapabilitiesUpdate


class PlatformCapabilitiesRepository:
    ALLOWED_KEYS = {"supported_executors", "supported_identity_modes", "supported_oauth_providers", "capabilities"}

    @staticmethod
    def _utcnow() -> datetime:
        return datetime.now(timezone.utc)

    def list_platforms(self) -> list[dict]:
        return list_platforms()

    def update(self, name: str, update: PlatformCapabilitiesUpdate) -> dict:
        with _capabilities_lock:
            payload = {
                "supported_executors": update.supported_executors,
                "supported_identity_modes": update.supported_identity_modes,
                "supported_oauth_providers": update.supported_oauth_providers,
                "capabilities": update.capabilities,
            }
            safe = {key: value for key, value in payload.items() if key in self.ALLOWED_KEYS and value is not None}
            current = get_platform_capabilities(name)
            with Session(engine) as session:
                item = session.exec(
                    select(PlatformCapabilityOverrideModel)
                    .where(PlatformCapabilityOverrideModel.platform_name == name)
                ).first()
                if not item:
                    item = PlatformCapabilityOverrideModel(platform_name=name)
                    item.created_at = self._utcnow()
                item.set_capabilities({**current, **safe})
                item.updated_at = self._utcnow()
                session.add(item)
                session.commit()
            return {"ok": True}

    def reset(self, name: str) -> dict:
        with _capabilities_lock:
            with Session(engine) as session:
                item = session.exec(
                    select(PlatformCapabilityOverrideModel)
                    .where(PlatformCapabilityOverrideModel.platform_name == name)
                ).first()
                if item:
                    session.delete(item)
                    session.commit()
            return {"ok": True}
