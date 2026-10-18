from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from application.actions import ActionsService
from domain.actions import ActionExecutionCommand

router = APIRouter(prefix="/actions", tags=["actions"])
service = ActionsService()


class ActionRequest(BaseModel):
    params: dict = Field(default_factory=dict)


class BulkRecoveryRequest(ActionRequest):
    account_ids: list[Annotated[int, Field(gt=0, strict=True)]] = Field(min_length=1, max_length=100)


@router.get("/{platform}")
def list_actions(platform: str):
    return service.list_actions(platform)


@router.get("/{platform}/capabilities")
def list_capabilities(platform: str):
    return service.list_capabilities(platform)


@router.post("/{platform}/bulk/complete_registration")
def execute_bulk_recovery(platform: str, body: BulkRecoveryRequest):
    try:
        return service.execute_bulk_recovery(platform, body.account_ids, body.params)
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc


@router.post("/{platform}/bulk/refresh_token")
def execute_bulk_refresh(platform: str, body: BulkRecoveryRequest):
    try:
        return service.execute_bulk_refresh(platform, body.account_ids, body.params)
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc


@router.post("/{platform}/{account_id}/{action_id}")
def execute_action(platform: str, account_id: int, action_id: str, body: ActionRequest):
    task = service.execute_action(
        ActionExecutionCommand(
            platform=platform,
            account_id=account_id,
            action_id=action_id,
            params=body.params,
        )
    )
    if not task:
        raise HTTPException(400, "任务创建失败")
    return task
