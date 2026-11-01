from __future__ import annotations

from dataclasses import dataclass


@dataclass(slots=True)
class PlatformCapabilitiesUpdate:
    supported_executors: list[str] | None = None
    supported_identity_modes: list[str] | None = None
    supported_oauth_providers: list[str] | None = None
    capabilities: list[str] | None = None
