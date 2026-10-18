"""Simple bearer-token authentication middleware.

Set the environment variable ``APP_PASSWORD`` (or config key ``app_password``)
to enable password protection.  When set, every API request must carry either:

  - Header ``Authorization: Bearer <login-token>`` (legacy passwords also work)
  - Cookie ``_auth=<login-token>`` (legacy passwords also work)

Login establishes an HttpOnly cookie for browser event streams. An explicitly
set APP_PASSWORD takes precedence over the saved setting.

The health / ready endpoints are always public so that Docker health-checks
work without credentials.
"""
from __future__ import annotations

import hashlib
import os
import secrets

from fastapi import Request, Response
from starlette.middleware.base import BaseHTTPMiddleware
from starlette.concurrency import run_in_threadpool

_PUBLIC_PREFIXES = ("/api/health", "/api/ready", "/api/auth/")


def _get_password() -> str:
    configured = os.environ.get("APP_PASSWORD")
    if configured is not None:
        return configured.strip()
    from core.config_store import config_store
    return (config_store.get("app_password", "") or "").strip()


def _auth_token(password: str) -> str:
    return hashlib.sha256(("reg-machine-auth\0" + password).encode("utf-8")).hexdigest()


def _set_auth_cookie(response: Response, request: Request, token: str) -> None:
    response.set_cookie("_auth", token, path="/api", httponly=True,
                        samesite="strict", secure=request.url.scheme == "https")


class AuthMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request: Request, call_next):
        path = request.url.path
        if any(path.startswith(prefix) for prefix in _PUBLIC_PREFIXES) or not path.startswith("/api"):
            return await call_next(request)

        password = await run_in_threadpool(_get_password)
        if not password:
            return await call_next(request)

        token = _auth_token(password)
        expected = (password.encode("utf-8"), token.encode("ascii"))
        auth_header = request.headers.get("authorization", "")
        bearer = auth_header[7:] if auth_header.startswith("Bearer ") else ""
        cookie = request.cookies.get("_auth", "")
        for credential in (bearer, cookie):
            if credential and any(secrets.compare_digest(credential.encode("utf-8"), value) for value in expected):
                response = await call_next(request)
                if cookie != token:
                    _set_auth_cookie(response, request, token)
                return response

        return Response(content='{"detail":"Unauthorized"}', status_code=401, media_type="application/json")
