from __future__ import annotations

import os

from fastapi import APIRouter

from application.health import HealthService

router = APIRouter(tags=["health"])
service = HealthService()


@router.get("/health")
def health():
    result = service.health()
    if os.environ.get("CT_REGISTER_INSTANCE_ID"):
        result["instance_id"] = os.environ["CT_REGISTER_INSTANCE_ID"]
    return result


@router.get("/ready")
def ready():
    return service.readiness()
