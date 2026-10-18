"""Private, read-only bridge to the configured encrypted authenticator."""
import binascii
import hashlib
import math
import os
from pathlib import Path
import subprocess
import threading
import time
from urllib.parse import urlsplit

import requests
from fastapi import APIRouter, HTTPException, Request, Response
from sqlmodel import Session, select

from core.db import AccountCredentialModel, AccountModel, AccountOverviewModel, engine
from platforms.chatgpt.security import totp_code

router = APIRouter(prefix="/authenticator", tags=["authenticator"])
_ROOT = Path(__file__).resolve().parents[1]
_lock = threading.Lock()
_login_backoff: dict[str, dict] = {}


def _vault_config():
    # Match reg-factory's dotenv parsing, but do not import its unrelated settings
    # into the backend process environment.
    keys = {"AUTHENTICATOR_URL", "AUTHENTICATOR_USERNAME", "AUTHENTICATOR_PASSWORD", "AUTH_DATA_DIR"}
    values = {}
    env_file = Path(os.environ.get("REG_FACTORY_ENV_FILE") or _ROOT / "reg-factory" / ".env")
    if env_file.is_file():
        for raw in env_file.read_text(encoding="utf-8").splitlines():
            key, separator, value = raw.strip().partition("=")
            if separator and key.strip() in keys:
                values[key.strip()] = value.strip().strip('"').strip("'")
    values.update({key: os.environ[key] for key in keys if key in os.environ})
    return values


def _start_service(base, config, session):
    project = _ROOT / "reg-factory" / "authenticator"
    data_dir = Path(config.get("AUTH_DATA_DIR") or project / "data")
    if not data_dir.is_absolute():
        data_dir = _ROOT / "reg-factory" / data_dir
    if not (data_dir / "vault.json").is_file():
        return False
    child_env = os.environ.copy()
    parsed = urlsplit(base)
    child_env.update(AUTH_DATA_DIR=str(data_dir), AUTH_HOST=parsed.hostname,
                     AUTH_PORT=str(parsed.port or 80))
    subprocess.Popen(["node", str(project / "src" / "server.js")], cwd=project,
                     env=child_env, creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
                     stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    for _ in range(25):
        try:
            status = session.get(base + "/api/status", timeout=2, allow_redirects=False)
            return status.status_code == 200
        except requests.ConnectionError:
            time.sleep(0.2)
    return False


def _native_entries():
    result = {"status": "missing_config", "message": "请在现有 reg-factory/.env 中配置 AUTHENTICATOR_USERNAME 和 AUTHENTICATOR_PASSWORD。", "entries": []}
    try:
        config = _vault_config()
        base = config.get("AUTHENTICATOR_URL", "http://127.0.0.1:8788").rstrip("/")
        parsed = urlsplit(base)
        if (parsed.scheme != "http" or parsed.hostname not in {"127.0.0.1", "localhost"}
                or parsed.path or parsed.query or parsed.fragment or parsed.username or parsed.password
                or not 1 <= (parsed.port if parsed.port is not None else 80) <= 65535):
            raise ValueError
    except (OSError, ValueError):
        return {**result, "status": "invalid_config", "message": "验证器配置无效：AUTHENTICATOR_URL 必须为本机 loopback HTTP 地址，不含路径、凭据或查询参数。"}
    result["target"] = base
    username, password = config.get("AUTHENTICATOR_USERNAME"), config.get("AUTHENTICATOR_PASSWORD")
    if not username or not password:
        return result
    with _lock:
        target_key = f"127.0.0.1:{parsed.port or 80}"
        fingerprint = hashlib.sha256(f"{username}\0{password}".encode()).hexdigest()
        blocked = _login_backoff.get(target_key) or {}
        if blocked.get("until", 0) > time.time() and (
                blocked.get("rate_limited") or blocked.get("fingerprint") == fingerprint):
            return {**result, "status": "locked", "retry_after": blocked["until"],
                    "message": ("验证器登录已限流，请等待十分钟后重试。本机注册验证码仍可刷新。"
                                if blocked.get("rate_limited") else
                                "验证器自动登录已暂停；请修正凭据后刷新，或等待十分钟后重试。本机注册验证码仍可刷新。")}
        # Native sessions hold a vault snapshot; reopen on each refresh to see
        # entries added by other clients without changing their browser sessions.
        session = requests.Session()
        session.trust_env = False
        unlocked = False
        public = []
        try:
            try:
                listed_at = time.time()
                listed = session.get(base + "/api/entries", timeout=5, allow_redirects=False)
            except requests.ConnectionError:
                if not _start_service(base, config, session):
                    return {**result, "status": "unavailable", "message": "本地验证器未启动或配置的加密 vault.json 不存在；未创建或修改保险库。"}
                listed_at = time.time()
                listed = session.get(base + "/api/entries", timeout=5, allow_redirects=False)
            if listed.status_code == 401:
                status = session.get(base + "/api/status", timeout=5, allow_redirects=False)
                if status.status_code != 200:
                    raise ValueError
                if status.json().get("setup") is not True:
                    return {**result, "status": "not_initialized", "message": "配置的验证器尚未初始化，请使用现有验证器完成设置。"}
                login = session.post(base + "/api/login", json={"username": username, "password": password},
                                     headers={"X-Requested-With": "local-authenticator"},
                                     timeout=10, allow_redirects=False)
                if login.status_code != 200:
                    if login.status_code not in {401, 429}:
                        return {**result, "status": "unavailable",
                                "message": "本地验证器登录服务暂不可用，请稍后刷新重试。本机注册验证码仍可刷新。"}
                    if login.status_code in {401, 429}:
                        _login_backoff[target_key] = {
                            "until": time.time() + 600, "fingerprint": fingerprint,
                            "rate_limited": login.status_code == 429,
                        }
                    return {**result, "status": "locked",
                            "message": ("验证器登录已限流，请等待十分钟后重试。"
                                        if login.status_code == 429 else
                                        "自动登录失败；请检查验证器凭据。重复自动登录已暂停，十分钟后可重试。")}
                _login_backoff.pop(target_key, None)
                unlocked = True
                listed_at = time.time()
                listed = session.get(base + "/api/entries", timeout=5, allow_redirects=False)
            if listed.status_code != 200:
                raise ValueError
            entries = listed.json()["entries"]
            if not isinstance(entries, list) or any(not isinstance(entry, dict) for entry in entries):
                raise ValueError
            for entry in entries:
                code = str(entry.get("code", ""))
                if not code.isascii() or not code.isdigit() or len(code) not in {6, 7, 8}:
                    raise ValueError
                period = int(entry.get("period", 30))
                remaining = int(entry.get("remaining", 0))
                if period not in {15, 30, 60} or not 0 <= remaining <= period:
                    raise ValueError
                public.append({"id": str(entry["id"]), "issuer": str(entry.get("issuer", "")),
                               "label": str(entry.get("label", "")), "code": code,
                               "period": period, "remaining": remaining,
                               "expires_at": math.floor(listed_at) + remaining,
                               "source": "vault", "verified": None})
            return {**result, "status": "ready", "message": "已自动登录现有加密验证器", "entries": public}
        except (requests.RequestException, OSError):
            return {**result, "status": "unavailable", "message": "无法连接本地验证器，请检查配置地址与服务状态。"}
        except (KeyError, TypeError, ValueError):
            return {**result, "status": "invalid_response", "message": "本地验证器响应格式不兼容，验证码暂不可用。"}
        finally:
            if unlocked:
                try:
                    session.post(base + "/api/logout", headers={"X-Requested-With": "local-authenticator"},
                                 timeout=2, allow_redirects=False)
                except requests.RequestException:
                    pass
            ended_at = time.time()
            for entry in public:
                entry["remaining"] = max(0, math.ceil(entry["expires_at"] - ended_at))
            session.close()


@router.get("/entries")
def get_entries(request: Request, response: Response):
    origin = request.headers.get("origin")
    if (request.headers.get("x-requested-with") != "reg-machine-authenticator"
            or request.headers.get("sec-fetch-site") not in {None, "none", "same-origin", "same-site"}
            or (origin and origin != str(request.base_url).rstrip("/"))):
        raise HTTPException(status_code=403, detail="Authenticator requests must come from this application")
    response.headers["Cache-Control"] = "no-store"
    native = dict(_native_entries())
    entries = [dict(entry) for entry in native.pop("entries")]
    seen = {(entry["issuer"].strip().lower(), entry["label"].strip().lower()) for entry in entries}
    now = time.time()
    for entry in entries:
        expires_at = entry.get("expires_at", math.floor(now) + int(entry.get("remaining") or 0))
        entry["expires_at"] = expires_at
        entry["remaining"] = max(0, math.ceil(expires_at - now))
    with Session(engine) as session:
        rows = session.exec(select(AccountCredentialModel, AccountModel, AccountOverviewModel)
                            .join(AccountModel, AccountModel.id == AccountCredentialModel.account_id)
                            .outerjoin(AccountOverviewModel, AccountOverviewModel.account_id == AccountModel.id)
                            .where(AccountCredentialModel.scope == "platform",
                                   AccountCredentialModel.key == "totp_secret",
                                   AccountModel.platform == "chatgpt")).all()
        for credential, account, overview in rows:
            email = account.email.strip().lower()
            if ("openai", email) in seen or not credential.value:
                continue
            summary = overview.get_summary() if overview else {}
            verified = (summary.get("legacy_extra") or {}).get("authenticator_verified") is True
            try:
                code = totp_code(credential.value, timestamp=now)
            except (ValueError, binascii.Error):
                code = ""
            entries.append({"id": f"registration-{account.id}", "issuer": "OpenAI", "label": account.email,
                            "code": code, "period": 30, "remaining": 30 - int(now) % 30,
                            "expires_at": (math.floor(now / 30) + 1) * 30,
                            "source": "registration", "verified": verified})
            seen.add(("openai", email))
    return {"native": native, "entries": entries, "fetched_at": now}
