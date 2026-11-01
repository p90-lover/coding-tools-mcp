"""The native-only account exchange used by Coding Tools' CPA bridge."""
from __future__ import annotations

import hashlib
import json
import os
import secrets
from typing import Annotated

import anyio
from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, ConfigDict, Field, StrictInt, field_validator
from starlette.concurrency import run_in_threadpool

from application.account_exports import _chatgpt_export_payload, _generate_cpa_token_json
from domain.accounts import AccountExportSelection
from infrastructure.accounts_repository import AccountsRepository


def _native_auth(request: Request) -> None:
    password = os.environ.get("APP_PASSWORD", "").strip()
    actual = request.headers.get("authorization", "")
    if not password or not secrets.compare_digest(actual.encode(), ("Bearer " + password).encode()):
        raise HTTPException(status_code=401, detail="Unauthorized")


router = APIRouter(prefix="/coding-tools", tags=["coding-tools"], dependencies=[Depends(_native_auth)])
repository = AccountsRepository()
_DISABLED = {"deactivated", "disabled", "invalid", "fraud_guard", "rate_limit_exceeded"}


class AccountIDs(BaseModel):
    model_config = ConfigDict(extra="forbid")
    ids: Annotated[list[Annotated[StrictInt, Field(gt=0, le=9007199254740991)]], Field(min_length=1, max_length=100)]

    @field_validator("ids")
    @classmethod
    def unique_ids(cls, values: list[int]) -> list[int]:
        if len(set(values)) != len(values):
            raise ValueError("Account IDs must be unique")
        return values


def _revision(item) -> str:
    payload = _chatgpt_export_payload(item)
    material = {key: payload[key] for key in (
        "email", "account_id", "workspace_id", "client_id", "access_token", "refresh_token", "id_token",
    )}
    return hashlib.sha256(json.dumps(material, sort_keys=True, separators=(",", ":")).encode()).hexdigest()


def _disabled(item) -> bool:
    return item.lifecycle_status in _DISABLED or item.display_status in _DISABLED


def _eligible(item) -> bool:
    if item.platform != "chatgpt" or _disabled(item):
        return False
    try:
        _generate_cpa_token_json(item)
        return True
    except (ValueError, TypeError):
        return False


@router.get("/accounts")
def accounts():
    items = repository.select_for_export(AccountExportSelection(platform="chatgpt", select_all=True))
    return {"accounts": [{"id": item.id, "email": item.email, "eligible": _eligible(item),
                          "disabled": _disabled(item), "revision": _revision(item)} for item in items]}


@router.post("/export")
def export_accounts(body: AccountIDs):
    items = [repository.get(account_id) for account_id in body.ids]
    if any(item is None or not _eligible(item) for item in items):
        raise HTTPException(status_code=409, detail="A selected account is unavailable for CPA export")
    return {"files": [{"account_id": item.id, "name": f"register-account-{item.id}.json",
                        "revision": _revision(item), "json": _generate_cpa_token_json(item)} for item in items]}


def _refresh_account(account_id, cancelled):
    # Do not dispatch a platform action: that path may open an interactive login.
    from platforms.chatgpt.token_refresh import refresh_account_token
    item = repository.get(account_id)
    if item is None or item.platform != "chatgpt" or _disabled(item):
        return {"id": account_id, "ok": False, "error": "account_unavailable", "requires_login": False}
    try:
        result = refresh_account_token(account_id, cancelled=cancelled)
        if result.success:
            return {"id": account_id, "ok": True}
        # Upstream diagnostic strings can include a server's credential-bearing response.
        safe_errors = {"account_changed", "persistence_failed", "account_deactivated", "fraud_guard", "cancelled",
                       "rate_limit_exceeded", "access_denied", "challenge_required", "human_verification"}
        error = result.error_type if result.error_type in safe_errors else "refresh_failed"
        return {"id": account_id, "ok": False, "error": error, "requires_login": bool(result.requires_user_action)}
    except Exception:
        return {"id": account_id, "ok": False, "error": "refresh_failed", "requires_login": False}


@router.post("/refresh")
async def refresh_accounts(body: AccountIDs, request: Request):
    results = []
    for account_id in body.ids:
        if await request.is_disconnected():
            break
        cancelled = lambda: anyio.from_thread.run(request.is_disconnected)
        results.append(await run_in_threadpool(_refresh_account, account_id, cancelled))
    return {"results": results}
