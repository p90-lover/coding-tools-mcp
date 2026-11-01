from __future__ import annotations

from fastapi import APIRouter, HTTPException

from application.tasks_query import TasksQueryService

router = APIRouter(prefix="/tasks", tags=["tasks"])
service = TasksQueryService()


@router.get("")
def list_tasks(platform: str = "", status: str = "", page: int = 1, page_size: int = 50, task_type: str = ""):
    return service.list_tasks(platform=platform, status=status, page=page, page_size=page_size, task_type=task_type)


@router.get("/verification-hold")
def get_verification_hold():
    from core.verification_hold import get_verification_hold as get_hold
    hold = get_hold()
    if hold and hold.get("account_id"):
        from sqlmodel import Session
        from core.db import AccountModel, engine
        with Session(engine) as session:
            account = session.get(AccountModel, hold["account_id"])
            hold["account_exists"] = bool(account and account.platform == "chatgpt")
    return {"verification_hold": hold}


@router.get("/{task_id}")
def get_task(task_id: str):
    task = service.get_task(task_id)
    if not task:
        raise HTTPException(404, "任务不存在")
    return task


@router.get("/{task_id}/events")
def list_task_events(task_id: str, since: int = 0, limit: int = 200):
    task = service.get_task(task_id)
    if not task:
        raise HTTPException(404, "任务不存在")
    return service.list_events(task_id, since=since, limit=limit)
