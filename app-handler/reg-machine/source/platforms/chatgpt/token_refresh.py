"""
Token 刷新模块
支持 Session Token 和 OAuth Refresh Token 两种刷新方式
"""

import logging
import re
import json
import time
from typing import Optional, Dict, Any, Tuple
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone

from curl_cffi import requests as cffi_requests

# from ..config.settings import get_settings  # removed: external dep
# from ..database.session import get_db  # removed: external dep
# from ..database import crud  # removed: external dep
# from ..database.models import Account  # removed: external dep

logger = logging.getLogger(__name__)


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


@dataclass
class TokenRefreshResult:
    """Token 刷新结果"""
    success: bool
    access_token: str = ""
    refresh_token: str = ""
    expires_at: Optional[datetime] = None
    error_message: str = ""
    id_token: str = ""
    session_token: str = ""
    error_type: str = ""
    requires_user_action: bool = False


def _response_restriction(response) -> str:
    try:
        payload = response.json()
    except Exception:
        payload = None
    if isinstance(payload, dict):
        codes = [payload.get("code")]
        for key in ("error", "detail"):
            item = payload.get(key)
            if isinstance(item, dict):
                codes.append(item.get("code"))
            elif key == "error":
                codes.append(item)
        if any(isinstance(code, str) and code == "account_deactivated" for code in codes):
            return "account_deactivated"
        text = json.dumps({key: payload[key] for key in ("error", "detail", "code", "error_description")
                           if key in payload}, ensure_ascii=True).casefold()
    else:
        text = str(getattr(response, "text", "") or "").casefold()
    match = re.search(r"\b(fraud_guard|rate_limit_exceeded|challenge_required|captcha_required|human_verification|security_warning)\b", text)
    if match:
        return match.group(1)
    if re.search(r"\b(account_deactivated|deactivated)\b", text):
        return "deactivation_unconfirmed"
    if any(marker in text for marker in ("captcha", "verify you are human", "human verification")):
        return "human_verification"
    if response.status_code == 429:
        return "rate_limit_exceeded"
    if response.status_code == 403:
        return "access_denied"
    return ""


def _account_refresh_restriction(account) -> Optional[TokenRefreshResult]:
    from core.base_platform import AccountStatus
    extra = account.extra if isinstance(account.extra, dict) else {}
    overview = extra.get("account_overview") if isinstance(extra.get("account_overview"), dict) else {}
    for metadata in (extra, overview, overview.get("legacy_extra")):
        if isinstance(metadata, dict) and re.search(r"\baccount_deactivated\b",
                                                  str(metadata.get("security_error") or "").casefold()):
            return TokenRefreshResult(success=False, error_message="account_deactivated: 原账号已停用，请人工处理",
                                      error_type="account_deactivated", requires_user_action=True)
    if account.status in {AccountStatus.FRAUD_GUARD, AccountStatus.RATE_LIMITED}:
        return TokenRefreshResult(success=False, error_message="原账号处于验证限制暂停，禁止自动重试",
                                  error_type=account.status.value, requires_user_action=True)
    if account.status in {AccountStatus.PHONE_REQUIRED, AccountStatus.TWO_FA_REQUIRED}:
        return TokenRefreshResult(success=False, error_message="请先使用恢复注册操作完成原账号验证",
                                  error_type=account.status.value, requires_user_action=True)
    return None


class TokenRefreshManager:
    """
    Token 刷新管理器
    支持两种刷新方式：
    1. OAuth Refresh Token 刷新（优先，保存轮换后的令牌）
    2. Session Token 刷新
    """

    # OpenAI OAuth 端点
    SESSION_URL = "https://chatgpt.com/api/auth/session"
    TOKEN_URL = "https://auth.openai.com/oauth/token"

    def __init__(self, proxy_url: Optional[str] = None):
        """
        初始化 Token 刷新管理器

        Args:
            proxy_url: 代理 URL
        """
        self.proxy_url = proxy_url
        from .constants import OAUTH_CLIENT_ID, OAUTH_REDIRECT_URI
        self._oauth_client_id = OAUTH_CLIENT_ID
        self._oauth_redirect_uri = OAUTH_REDIRECT_URI

    def _create_session(self) -> cffi_requests.Session:
        """创建 HTTP 会话"""
        session = cffi_requests.Session(impersonate="chrome120", proxy=self.proxy_url)
        return session

    def refresh_by_session_token(self, session_token: str) -> TokenRefreshResult:
        result = TokenRefreshResult(success=False)
        try:
            session = self._create_session()
            session.cookies.set("__Secure-next-auth.session-token", session_token,
                                domain=".chatgpt.com", path="/")
            response = session.get(self.SESSION_URL, headers={"accept": "application/json"},
                                   timeout=30)
            restriction = _response_restriction(response)
            if restriction:
                return TokenRefreshResult(success=False, error_message=f"Session token 刷新暂停: {restriction}",
                                          error_type=restriction, requires_user_action=True)
            if response.status_code != 200:
                result.error_message = f"Session token 刷新失败: HTTP {response.status_code}"
                return result
            data = response.json()
            access_token = data.get("accessToken")
            if not isinstance(access_token, str) or not access_token.strip():
                result.error_message = "Session token 刷新失败: 未找到 accessToken"
                return result
            expires_at = None
            if data.get("expires"):
                try:
                    expires_at = datetime.fromisoformat(data["expires"].replace("Z", "+00:00"))
                except (AttributeError, TypeError, ValueError):
                    pass
            result.success = True
            result.access_token = access_token
            result.session_token = session.cookies.get("__Secure-next-auth.session-token") or session_token
            result.expires_at = expires_at
            return result
        except Exception as exc:
            result.error_message = f"Session token 刷新异常: {exc}"
            return result

    def refresh_by_oauth_token(self, refresh_token: str, client_id: Optional[str] = None) -> TokenRefreshResult:
        result = TokenRefreshResult(success=False)
        try:
            session = self._create_session()
            response = session.post(
                self.TOKEN_URL,
                headers={"content-type": "application/x-www-form-urlencoded", "accept": "application/json"},
                data={"client_id": client_id or self._oauth_client_id, "grant_type": "refresh_token",
                      "refresh_token": refresh_token, "redirect_uri": self._oauth_redirect_uri},
                timeout=30,
            )
            restriction = _response_restriction(response)
            if restriction:
                return TokenRefreshResult(success=False, error_message=f"OAuth token 刷新暂停: {restriction}",
                                          error_type=restriction, requires_user_action=True)
            if response.status_code != 200:
                result.error_message = f"OAuth token 刷新失败: HTTP {response.status_code}"
                return result
            data = response.json()
            access_token = data.get("access_token")
            new_refresh_token = data.get("refresh_token", refresh_token)
            if (not isinstance(access_token, str) or not access_token.strip()
                    or not isinstance(new_refresh_token, str)):
                result.error_message = "OAuth token 刷新失败: 响应凭据无效"
                return result
            expires_at = None
            try:
                if type(data.get("expires_in")) in (int, float):
                    expires_at = _utcnow() + timedelta(seconds=data["expires_in"])
            except (ValueError, OverflowError):
                pass
            result.success = True
            result.access_token = access_token
            result.refresh_token = new_refresh_token
            result.id_token = data.get("id_token") if isinstance(data.get("id_token"), str) else ""
            result.expires_at = expires_at
            return result
        except Exception as exc:
            result.error_message = f"OAuth token 刷新异常: {exc}"
            return result

    def refresh_account(self, account: Any) -> TokenRefreshResult:
        """Renew OAuth first; only ordinary expiry may fall back to the saved web session."""
        oauth_result = None
        if account.refresh_token:
            oauth_result = self.refresh_by_oauth_token(
                refresh_token=account.refresh_token, client_id=account.client_id)
            if oauth_result.success or getattr(oauth_result, "requires_user_action", False):
                return oauth_result
        if account.session_token:
            return self.refresh_by_session_token(account.session_token)
        return oauth_result or TokenRefreshResult(
            success=False, error_message="账号没有可用的刷新方式（缺少 session_token 和 refresh_token）")

    def validate_token(self, access_token: str) -> Tuple[bool, Optional[str]]:
        """
        验证 Access Token 是否有效

        Args:
            access_token: 访问令牌

        Returns:
            Tuple[bool, Optional[str]]: (是否有效, 错误信息)
        """
        try:
            session = self._create_session()

            # 调用 OpenAI API 验证 token
            response = session.get(
                "https://chatgpt.com/backend-api/me",
                headers={
                    "authorization": f"Bearer {access_token}",
                    "accept": "application/json"
                },
                timeout=30
            )

            if response.status_code == 200:
                return True, None
            elif response.status_code == 401:
                return False, "Token 无效或已过期"
            elif response.status_code == 403:
                return False, "账号可能被封禁"
            else:
                return False, f"验证失败: HTTP {response.status_code}"

        except Exception as e:
            return False, f"验证异常: {str(e)}"


def refresh_account_token(account_id: int, proxy_url: Optional[str] = None) -> TokenRefreshResult:
    """Refresh the selected ChatGPT record through the current account graph."""
    from types import SimpleNamespace
    from sqlmodel import Session
    from core.db import AccountModel, engine
    from core.account_graph import patch_account_graph
    from core.platform_accounts import build_platform_account
    if type(account_id) is not int or account_id <= 0:
        return TokenRefreshResult(success=False, error_message="账号 ID 无效")
    with Session(engine) as session:
        model = session.get(AccountModel, account_id)
        if not model:
            return TokenRefreshResult(success=False, error_message="账号不存在")
        if model.platform != "chatgpt":
            return TokenRefreshResult(success=False, error_message="账号不是 ChatGPT 平台")
        identity = (model.platform, model.email, model.user_id)
        account = build_platform_account(session, model)
    blocked = _account_refresh_restriction(account)
    if blocked:
        return blocked
    extra = account.extra
    material = SimpleNamespace(
        email=account.email, refresh_token=extra.get("refresh_token") or extra.get("refreshToken", ""),
        session_token=extra.get("session_token") or extra.get("sessionToken", ""),
        client_id=extra.get("client_id") or extra.get("clientId", ""),
    )
    result = TokenRefreshManager(proxy_url=proxy_url).refresh_account(material)
    if not result.success:
        return result
    if not isinstance(result.access_token, str) or not result.access_token.strip():
        return TokenRefreshResult(success=False, error_message="刷新未返回有效凭据")
    updates = {key: getattr(result, key, "") for key in
               ("access_token", "refresh_token", "id_token", "session_token") if getattr(result, key, "")}
    try:
        with Session(engine) as session:
            current = session.get(AccountModel, account_id)
            if not current or (current.platform, current.email, current.user_id) != identity:
                return TokenRefreshResult(success=False, error_message="目标账号不存在或身份不匹配",
                                          error_type="account_changed", requires_user_action=True)
            current.updated_at = _utcnow()
            patch_account_graph(session, current, credential_updates=updates,
                                summary_updates={"last_refresh_at": _utcnow().isoformat().replace("+00:00", "Z"),
                                                 "refresh_success": True})
            session.add(current)
            session.commit()
    except Exception:
        result.success = False
        result.error_message = "Token 已刷新，但本地保存失败，请人工处理"
        result.error_type = "persistence_failed"
        result.requires_user_action = True
    return result


def validate_account_token(account_id: int, proxy_url: Optional[str] = None) -> Tuple[bool, Optional[str]]:
    """Validate the selected record's saved access token without changing it."""
    from sqlmodel import Session
    from core.db import AccountModel, engine
    from core.platform_accounts import build_platform_account
    if type(account_id) is not int or account_id <= 0:
        return False, "账号 ID 无效"
    with Session(engine) as session:
        model = session.get(AccountModel, account_id)
        if not model:
            return False, "账号不存在"
        if model.platform != "chatgpt":
            return False, "账号不是 ChatGPT 平台"
        account = build_platform_account(session, model)
    blocked = _account_refresh_restriction(account)
    if blocked:
        return False, blocked.error_message
    access_token = account.extra.get("access_token") or account.extra.get("accessToken", "")
    if not access_token:
        return False, "账号没有 access_token"
    return TokenRefreshManager(proxy_url=proxy_url).validate_token(access_token)
