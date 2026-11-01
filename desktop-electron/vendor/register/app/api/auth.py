from __future__ import annotations

import secrets

from fastapi import APIRouter, Request, Response
from pydantic import BaseModel

from core.auth import _auth_token, _get_password, _set_auth_cookie

router = APIRouter(prefix="/auth", tags=["auth"])


class LoginRequest(BaseModel):
    password: str = ""


@router.get("/check")
def auth_check():
    """Return whether the app requires a password."""
    password = _get_password()
    return {"required": bool(password)}


@router.post("/login")
def auth_login(body: LoginRequest, request: Request, response: Response):
    password = _get_password()
    if not password:
        return {"ok": True}
    if secrets.compare_digest(body.password.encode("utf-8"), password.encode("utf-8")):
        token = _auth_token(password)
        _set_auth_cookie(response, request, token)
        return {"ok": True, "token": token}
    return {"ok": False, "error": "密码错误"}
