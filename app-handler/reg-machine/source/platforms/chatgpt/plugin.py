"""ChatGPT / Codex CLI 平台插件"""
import secrets
import re
from core.base_platform import BasePlatform, Account, AccountStatus, RegisterConfig
from core.base_mailbox import BaseMailbox
from core.registration import BrowserRegistrationAdapter, OtpSpec, ProtocolMailboxAdapter, ProtocolOAuthAdapter, RegistrationCapability, RegistrationResult
from core.registration.helpers import resolve_timeout
from core.registry import register


def _result_text(result, key: str) -> str:
    if isinstance(result, dict):
        return str(result.get(key, "") or "")
    return str(getattr(result, key, "") or "")


def _assert_complete_oauth_callback(result, *, expected_email: str = "") -> None:
    required = ("account_id", "access_token", "refresh_token", "id_token")
    missing = [key for key in required if not _result_text(result, key)]
    if missing:
        raise RuntimeError(
            "ChatGPT 注册未完成完整 OAuth callback，缺少: " + ", ".join(missing)
        )
    if expected_email and _result_text(result, "email").strip().casefold() != expected_email.strip().casefold():
        raise RuntimeError("ChatGPT OAuth identity does not match the requested account")


def _generate_chatgpt_registration_password(length: int = 16) -> str:
    """生成更稳定通过 OpenAI 注册页校验的密码。

    旧协议流已经验证过：至少带小写、数字、符号时，成功率明显更稳。
    这里再补一个大写字符，避免浏览器流随机生成出“看起来够长但组合不够强”的密码。
    """
    specials = ",._!@#"
    minimum_length = 12
    size = max(int(length or minimum_length), minimum_length)
    required = [
        secrets.choice("abcdefghijklmnopqrstuvwxyz"),
        secrets.choice("ABCDEFGHIJKLMNOPQRSTUVWXYZ"),
        secrets.choice("0123456789"),
        secrets.choice(specials),
    ]
    pool = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789" + specials
    required.extend(secrets.choice(pool) for _ in range(size - len(required)))
    secrets.SystemRandom().shuffle(required)
    return "".join(required)


@register
class ChatGPTPlatform(BasePlatform):
    name = "chatgpt"
    display_name = "ChatGPT"
    version = "1.0.0"
    supported_executors = ["protocol", "headless", "headed"]
    supported_identity_modes = ["mailbox", "oauth_browser"]
    supported_oauth_providers = ["google", "microsoft"]
    protocol_captcha_order = ("2captcha", "capsolver", "auto")

    # Declarative capabilities
    capabilities = [
        "complete_registration",  # Resume phone/authenticator verification
        "query_state",      # Query account state/quota
        "refresh_token",    # Refresh auth token
        "generate_link",    # Generate payment link
        "switch_desktop",   # Switch to Codex desktop
        "upload_cpa",       # Upload to CPA system
        "upload_tm",        # Upload to Team Manager
    ]

    def __init__(self, config: RegisterConfig = None, mailbox: BaseMailbox = None):
        super().__init__(config)
        self.mailbox = mailbox

    def check_valid(self, account: Account) -> bool:
        self._last_check_overview = {}
        try:
            from platforms.chatgpt.payment import fetch_subscription_status_details
            from core.proxy_pool import proxy_pool
            class _A: pass
            a = _A()
            extra = account.extra or {}
            a.access_token = extra.get("access_token") or account.token
            a.id_token = extra.get("id_token", "")
            a.cookies = extra.get("cookies", "")
            a.extra = extra

            region = str(getattr(account, "region", "") or extra.get("region", "") or "").strip()
            configured_proxy = self.config.proxy if self.config else None
            proxy_candidates: list[tuple[str | None, bool]] = []
            if configured_proxy:
                proxy_candidates.append((configured_proxy, False))
            else:
                pooled_proxy = proxy_pool.get_next(region=region)
                if pooled_proxy:
                    proxy_candidates.append((pooled_proxy, True))
            proxy_candidates.append((None, False))

            for proxy, should_report in proxy_candidates:
                try:
                    details = fetch_subscription_status_details(a, proxy=proxy)
                    if should_report and proxy:
                        proxy_pool.report_success(proxy)
                    status = details.get("status")
                    overview = {
                        "plan": status,
                        "plan_name": status,
                        "check_source": details.get("source"),
                    }
                    if isinstance(details.get("usage"), dict):
                        overview["chatgpt_usage"] = details["usage"]
                    self._last_check_overview = overview
                    return status not in ("expired", "invalid", "banned", None)
                except Exception:
                    if should_report and proxy:
                        proxy_pool.report_fail(proxy)
                    continue
        except Exception:
            return False
        return False

    def get_last_check_overview(self) -> dict:
        return dict(getattr(self, "_last_check_overview", {}) or {})

    def _prepare_registration_password(self, password: str | None) -> str | None:
        if password:
            return password
        return _generate_chatgpt_registration_password()

    def _map_chatgpt_result(self, result: dict, *, password: str = "", user_id: str = "", expected_email: str = "") -> RegistrationResult:
        phone_verified = result.get("phone_verified") is True
        authenticator_verified = result.get("authenticator_verified") is True
        phone_mfa_disabled = result.get("phone_mfa_disabled") is True
        security_complete = phone_verified and authenticator_verified and phone_mfa_disabled
        guard_code = str(result.get("verification_error_code") or "").strip().lower()
        if guard_code not in {"fraud_guard", "rate_limit_exceeded"}:
            guard_code = ""
        hold = result.get("verification_hold") or {}
        if not guard_code and not security_complete and isinstance(hold, dict) and hold.get("active"):
            guard_code = str(hold.get("code") or "")
        if not guard_code:
            match = re.search(r"\b(fraud_guard|rate_limit_exceeded)\b", str(result.get("security_error") or "").lower())
            guard_code = match.group(1) if match else ""
        blocked = guard_code in {"fraud_guard", "rate_limit_exceeded"}
        verified = security_complete and not blocked
        status = (AccountStatus(guard_code) if blocked else
                  AccountStatus.REGISTERED if verified else
                  AccountStatus.TWO_FA_REQUIRED if phone_verified else AccountStatus.PHONE_REQUIRED)
        oauth_complete = all(_result_text(result, key) for key in ("account_id", "access_token", "refresh_token", "id_token"))
        if verified or oauth_complete:
            _assert_complete_oauth_callback(result, expected_email=expected_email)
        return RegistrationResult(
            email=result.get("email", ""),
            password="" if result.get("password_set") is False else password or result.get("password", ""),
            user_id=user_id or result.get("account_id", ""),
            token=result.get("access_token", "") if verified else "",
            status=status,
            extra={
                "totp_secret": result.get("totp_secret", ""),
                "session_token": result.get("session_token", ""),
                "cookies": result.get("cookies", ""),
                "security_error": result.get("security_error", ""),
                "verification_error_code": guard_code if blocked else "",
                "rental_cleanup_confirmed": result.get("rental_cleanup_confirmed"),
                **({"verification_hold": dict(result["verification_hold"])} if isinstance(result.get("verification_hold"), dict) else {}),
                "phone_verified": phone_verified,
                "authenticator_verified": authenticator_verified,
                "phone_mfa_disabled": phone_mfa_disabled,
                "pending_reason": guard_code if blocked else "" if verified else ("phone_verification" if not phone_verified else "authenticator_2fa_or_phone_mfa"),
                **({
                    **({"account_overview": {"valid": True}} if verified else {}),
                    "oauth_email": result.get("email", ""),
                    "account_id": result.get("account_id", ""),
                    "access_token": result.get("access_token", ""),
                    "refresh_token": result.get("refresh_token", ""),
                    "id_token": result.get("id_token", ""),
                    "session_token": result.get("session_token", ""),
                    "workspace_id": result.get("workspace_id", ""),
                    "cookies": result.get("cookies", ""),
                    "profile": result.get("profile", {}),
                } if oauth_complete else {}),
            },
        )

    def _run_protocol_oauth(self, ctx) -> dict:
        from platforms.chatgpt.browser_oauth import register_with_browser_oauth

        return register_with_browser_oauth(
            proxy=ctx.proxy,
            oauth_provider=ctx.identity.oauth_provider,
            email_hint=ctx.identity.email,
            timeout=resolve_timeout(ctx.extra, ("browser_oauth_timeout", "manual_oauth_timeout"), 300),
            log_fn=ctx.log,
            headless=(ctx.executor_type == "headless"),
            chrome_user_data_dir=ctx.identity.chrome_user_data_dir,
            chrome_cdp_url=ctx.identity.chrome_cdp_url,
        )

    def _save_security_checkpoint(self, ctx, state):
        from core.db import save_account
        from sqlalchemy import inspect
        if _result_text(state, "access_token"):
            _assert_complete_oauth_callback(state, expected_email=ctx.identity.email)
        from core.verification_hold import get_verification_hold
        active_hold = get_verification_hold()
        mapped = self._map_chatgpt_result({
            **state, "email": ctx.identity.email, "password": ctx.password or "",
            "verification_hold": state.get("verification_hold") or active_hold or {"active": False},
        }, expected_email=ctx.identity.email)
        account = self._account_from_registration_result(mapped)
        self._attach_identity_metadata(account, ctx.identity)
        model = save_account(account, account_id=getattr(self, "_local_account_id", None))
        saved_id = inspect(model).identity[0] if model is not None else None
        if saved_id is not None:
            self._local_account_id = saved_id
        hold = account.extra.get("verification_hold")
        if hold and hold.get("active") and model is not None:
            from core.verification_hold import bind_verification_hold
            bound = bind_verification_hold(saved_id, hold.get("detected_at"), state.get("_verification_hold_owner"))
            if bound and bound != hold:
                account.extra["verification_hold"] = bound
                save_account(account, account_id=saved_id)
        return account

    def _complete_pending_registration(self, account: Account, params: dict | None = None) -> dict:
        from core.base_identity import IdentityMaterial
        from core.base_mailbox import MailboxAccount, create_mailbox
        from core.proxy_pool import proxy_pool
        from core.registration.models import RegistrationContext
        from core.registration.helpers import build_otp_callback, build_phone_callbacks
        from infrastructure.provider_settings_repository import ProviderSettingsRepository
        from .browser_register import ChatGPTBrowserRegister
        from core.verification_hold import (get_verification_hold, can_resume_verification_hold,
                                            clear_verification_hold, verification_hold_result)

        hold = get_verification_hold()
        local_account_id = getattr(self, "_local_account_id", None)
        resume_hold = (params or {}).get("resume_verification_hold") is True
        if hold and not can_resume_verification_hold(hold, local_account_id, resume_hold, (params or {}).get("_verification_hold_detected_at")):
            return verification_hold_result(hold)
        if resume_hold and not hold:
            return {"ok": False, "error": "没有可恢复的手机验证暂停"}
        if account.status == AccountStatus.FRAUD_GUARD or (account.status == AccountStatus.RATE_LIMITED and not resume_hold):
            return {"ok": False, "error": "原账号处于验证限制暂停，禁止自动重试",
                    "data": {"requires_user_action": True, "error_type": account.status.value}}
        if account.status not in {AccountStatus.PHONE_REQUIRED, AccountStatus.TWO_FA_REQUIRED, AccountStatus.RATE_LIMITED}:
            return {"ok": False, "error": "恢复注册仅适用于 phone_required / 2fa_required 账号"}
        extra = account.extra or {}
        history = {**((extra.get("account_overview") or {}).get("legacy_extra") or {}), **extra}
        legacy_guard = re.search(r"\b(fraud_guard|rate_limit_exceeded)\b", str(history.get("security_error") or "").lower())
        if legacy_guard and (legacy_guard.group(1) == "fraud_guard" or not resume_hold):
            return {"ok": False, "error": "原账号已记录验证限制，禁止自动重试",
                    "data": {"requires_user_action": True, "error_type": legacy_guard.group(1)}}
        if "account_deactivated" in str(history.get("security_error") or ""):
            return {"ok": False, "error": "account_deactivated: OpenAI 已停用此账号，请人工处理，禁止自动重试",
                    "data": {"error_type": "account_deactivated", "requires_user_action": True}}
        provider_account = next((item for item in extra.get("provider_accounts", [])
                                 if item.get("provider_type") == "mailbox" and item.get("provider_name")), {})
        provider_key = provider_account.get("provider_name") or ProviderSettingsRepository().get_default_provider_key("mailbox")
        if not provider_key:
            return {"ok": False, "error": "请先配置原账号的邮箱服务，以便接收恢复验证码"}
        resource = next((item for item in extra.get("provider_resources", [])
                         if item.get("resource_type") == "mailbox" and
                         (item.get("handle") == account.email or (item.get("metadata") or {}).get("email") == account.email)), {})
        metadata = resource.get("metadata") or {}
        mailbox_id = metadata.get("account_id") or metadata.get("token") or (provider_account.get("metadata") or {}).get("account_id") or ""
        proxy = self.config.proxy or proxy_pool.get_next()
        self.config = RegisterConfig(executor_type="headed", proxy=proxy,
                                     extra={**(self.config.extra or {}), "mail_provider": provider_key,
                                            "_verification_hold_account_id": local_account_id,
                                            "_resume_verification_hold": resume_hold,
                                            "_verification_hold_detected_at": (params or {}).get("_verification_hold_detected_at")})
        self.mailbox = create_mailbox(provider_key, extra=self.config.extra, proxy=proxy)
        mail_account = MailboxAccount(email=account.email, account_id=str(mailbox_id),
                                     extra={"mailbox_provider_key": provider_key,
                                            "provider_account": provider_account, "provider_resource": resource})
        identity = IdentityMaterial(email=account.email, mailbox_account=mail_account,
                                    before_ids=self.mailbox.get_current_ids(mail_account))
        ctx = RegistrationContext(self.name, self.display_name, self, identity, self.config,
                                  account.email, account.password, self.log)
        progress = {key: history[key] for key in (
            "totp_secret", "cookies", "session_token", "account_id", "access_token",
            "refresh_token", "id_token", "oauth_email", "client_id", "workspace_id",
        ) if history.get(key)}
        progress["phone_verified"] = history.get("phone_verified") is True or account.status == AccountStatus.TWO_FA_REQUIRED
        if history.get("recovery_record_rebuilt_from_history"):
            progress["recovery_record_rebuilt_from_history"] = history["recovery_record_rebuilt_from_history"]
        phone_callback, cleanup = build_phone_callbacks(ctx, service=self.name)
        worker = ChatGPTBrowserRegister(
            headless=False, proxy=proxy, otp_callback=build_otp_callback(ctx, timeout=180),
            phone_callback=phone_callback, log_fn=self.log, security_progress=progress,
            security_checkpoint=lambda state: self._save_security_checkpoint(ctx, state),
        )
        try:
            raw = worker.run(email=account.email, password=account.password, resume=True)
            recovered = self._save_security_checkpoint(ctx, raw)
        finally:
            if cleanup:
                cleanup()
        complete = recovered.status == AccountStatus.REGISTERED
        if complete and hold and resume_hold and getattr(phone_callback, "phone_verification_succeeded", False):
            if clear_verification_hold(local_account_id, hold["detected_at"]):
                recovered.extra["verification_hold"] = {**hold, "active": False}
                from core.db import save_account
                save_account(recovered, account_id=local_account_id)
        active_hold = get_verification_hold()
        return {"ok": complete,
                "error": "" if complete else raw.get("security_error") or "验证尚未完成，账号保留待处理状态，可再次恢复",
                "data": {"email": recovered.email, "status": recovered.status.value,
                         "phone_verified": recovered.extra.get("phone_verified", False),
                         "authenticator_verified": recovered.extra.get("authenticator_verified", False),
                         "phone_mfa_disabled": recovered.extra.get("phone_mfa_disabled", False),
                         **({"requires_user_action": True, "error_type": "remote_verification"}
                            if not complete and raw.get("requires_user_action") is True else {}),
                         **({"verification_hold": active_hold, "requires_user_action": True,
                             "error_type": "verification_hold"} if active_hold else {})}}

    def build_browser_registration_adapter(self):
        return BrowserRegistrationAdapter(
            result_mapper=lambda ctx, result: self._map_chatgpt_result(result, expected_email=ctx.identity.email),
            browser_worker_builder=lambda ctx, artifacts: __import__("platforms.chatgpt.browser_register", fromlist=["ChatGPTBrowserRegister"]).ChatGPTBrowserRegister(
                headless=(ctx.executor_type == "headless"),
                proxy=ctx.proxy,
                otp_callback=artifacts.otp_callback,
                phone_callback=artifacts.phone_callback,
                log_fn=ctx.log,
                security_checkpoint=lambda state: self._save_security_checkpoint(ctx, state),
            ),
            browser_register_runner=lambda worker, ctx, artifacts: worker.run(
                email=ctx.identity.email or "",
                password=ctx.password or "",
            ),
            oauth_runner=self._run_protocol_oauth,
            capability=RegistrationCapability(oauth_headless_requires_browser_reuse=True),
            otp_spec=OtpSpec(wait_message="等待验证码...", timeout=600),
        )

    def build_protocol_oauth_adapter(self):
        return ProtocolOAuthAdapter(
            oauth_runner=self._run_protocol_oauth,
            result_mapper=lambda ctx, result: self._map_chatgpt_result(result, user_id=result.get("account_id", ""), expected_email=ctx.identity.email),
        )

    def build_protocol_mailbox_adapter(self):
        def _build_worker(ctx, artifacts):
            from platforms.chatgpt.protocol_mailbox import ChatGPTProtocolMailboxWorker

            return ChatGPTProtocolMailboxWorker(
                mailbox=self.mailbox,
                mailbox_account=ctx.identity.mailbox_account,
                provider=(self.config.extra or {}).get("mail_provider", ""),
                proxy_url=ctx.proxy,
                log_fn=ctx.log,
            )

        def _map_result(ctx, result):
            return RegistrationResult(
                email=result.email,
                password=result.password or (ctx.password or ""),
                user_id=result.account_id,
                token="",
                status=AccountStatus.PHONE_REQUIRED,
                extra={
                    "phone_verified": False,
                    "authenticator_verified": False,
                    "phone_mfa_disabled": False,
                    "pending_reason": "phone_verification",
                },
            )

        return ProtocolMailboxAdapter(
            result_mapper=_map_result,
            worker_builder=_build_worker,
            register_runner=lambda worker, ctx, artifacts: worker.run(
                email=ctx.identity.email,
                password=ctx.password,
            ),
        )

    def get_platform_actions(self) -> list:
        return [
            {"id": "complete_registration", "label": "恢复注册（手机验证 / 认证器 2FA）", "params": []},
            {"id": "switch_account", "label": "切换到 Codex 桌面端", "params": []},
            {"id": "query_state", "label": "查询账号状态/订阅", "params": []},
            {"id": "refresh_token", "label": "刷新 Token", "params": []},
            {"id": "payment_link", "label": "生成支付链接",
             "params": [
                 {"key": "country", "label": "地区", "type": "select",
                  "options": ["US","SG","TR","HK","JP","GB","AU","CA"]},
                 {"key": "plan", "label": "套餐", "type": "select",
                  "options": ["plus", "team"]},
             ]},
            {"id": "upload_cpa", "label": "上传 CPA",
             "params": [
                 {"key": "api_url", "label": "CPA API URL", "type": "text"},
                 {"key": "api_key", "label": "CPA API Key", "type": "text"},
             ]},
            {"id": "upload_tm", "label": "上传 Team Manager",
             "params": [
                 {"key": "api_url", "label": "TM API URL", "type": "text"},
                 {"key": "api_key", "label": "TM API Key", "type": "text"},
             ]},
        ]

    def execute_action(self, action_id: str, account: Account, params: dict) -> dict:
        # Keep existing menus/task records compatible with the capability IDs.
        action_id = {"switch_account": "switch_desktop", "payment_link": "generate_link"}.get(action_id, action_id)
        if action_id not in self.capabilities:
            return super().execute_action(action_id, account, params)
        if not self.config.proxy:
            from core.proxy_pool import proxy_pool
            self.config.proxy = proxy_pool.get_next()
        if action_id in {"switch_desktop", "upload_cpa", "upload_tm"}:
            return self._execute_platform_action(action_id, account, params)
        return super().execute_action(action_id, account, params)

    def get_desktop_state(self) -> dict:
        from platforms.chatgpt.switch import get_codex_desktop_state

        return get_codex_desktop_state()

    def _execute_platform_action(self, action_id: str, account: Account, params: dict) -> dict:
        """Handle ChatGPT-specific actions."""
        if action_id == "complete_registration":
            return self._complete_pending_registration(account, params)
        proxy = self.config.proxy if self.config else None
        extra = account.extra or {}

        class _A: pass
        a = _A()
        a.email = account.email
        a.access_token = extra.get("access_token") or account.token
        a.refresh_token = extra.get("refresh_token", "")
        a.id_token = extra.get("id_token", "")
        a.session_token = extra.get("session_token", "")
        from .constants import OAUTH_CLIENT_ID
        a.client_id = extra.get("client_id", OAUTH_CLIENT_ID)
        a.cookies = extra.get("cookies", "")
        a.user_id = account.user_id or ""
        a.account_id = account.user_id or ""

        if action_id == "switch_desktop":
            from platforms.chatgpt.switch import (
                close_codex_app,
                extract_session_token,
                fetch_chatgpt_account_state,
                get_codex_desktop_state,
                read_current_codex_account,
                restart_codex_app,
                switch_codex_account,
            )

            session_token = extract_session_token(a.session_token, a.cookies)
            if not session_token:
                return {"ok": False, "error": "Switch to Codex desktop requires session_token"}

            close_ok, close_msg = close_codex_app()
            switch_ok, switch_data = switch_codex_account(session_token=session_token, cookies=a.cookies)
            if not switch_ok:
                return {"ok": False, "error": switch_data.get("error", "Switch failed")}

            remote_state = fetch_chatgpt_account_state(
                access_token=a.access_token,
                id_token=a.id_token,
                session_token=session_token,
                cookies=a.cookies,
                proxy=proxy,
            )
            local_state = read_current_codex_account()
            restart_ok, restart_msg = restart_codex_app()
            message_parts = [switch_data.get("message", "Codex credentials written")]
            if close_msg:
                message_parts.append(close_msg)
            if restart_msg:
                message_parts.append(restart_msg)
            data = {
                "message": ".".join(part for part in message_parts if part),
                "close": {"ok": close_ok, "message": close_msg},
                "restart": {"ok": restart_ok, "message": restart_msg},
                "local_app_account": local_state,
                "desktop_app_state": get_codex_desktop_state(),
                "remote_state": remote_state,
                "switch_details": switch_data,
            }
            if remote_state.get("access_token"):
                data["access_token"] = remote_state["access_token"]
            if remote_state.get("refresh_token"):
                data["refresh_token"] = remote_state["refresh_token"]
            return {"ok": True, "data": data}

        if action_id == "upload_cpa":
            from platforms.chatgpt.cpa_upload import upload_to_cpa, generate_token_json
            token_data = generate_token_json(a)
            ok, msg = upload_to_cpa(token_data, api_url=params.get("api_url"),
                                    api_key=params.get("api_key"))
            return {"ok": ok, "data": msg, "error": "" if ok else str(msg)}

        if action_id == "upload_tm":
            from platforms.chatgpt.cpa_upload import upload_to_team_manager
            ok, msg = upload_to_team_manager(a, api_url=params.get("api_url"),
                                             api_key=params.get("api_key"))
            return {"ok": ok, "data": msg, "error": "" if ok else str(msg)}

        raise NotImplementedError(f"Unknown action: {action_id}")

    # Override specific capability handlers
    def _handle_query_state(self, account: Account, params: dict) -> dict:
        """Handle query_state capability for ChatGPT."""
        proxy = self.config.proxy if self.config else None
        extra = account.extra or {}

        class _A: pass
        a = _A()
        a.access_token = extra.get("access_token") or account.token
        a.id_token = extra.get("id_token", "")
        a.session_token = extra.get("session_token", "")
        a.cookies = extra.get("cookies", "")

        from platforms.chatgpt.switch import fetch_chatgpt_account_state, get_codex_desktop_state, read_current_codex_account

        data = fetch_chatgpt_account_state(
            access_token=a.access_token,
            id_token=a.id_token,
            session_token=a.session_token,
            cookies=a.cookies,
            proxy=proxy,
        )
        data["local_app_account"] = read_current_codex_account()
        data["desktop_app_state"] = get_codex_desktop_state()
        return {"ok": True, "data": data}

    def _handle_refresh_token(self, account: Account, params: dict) -> dict:
        from .token_refresh import _account_refresh_restriction
        blocked = _account_refresh_restriction(account)
        if blocked:
            return {"ok": False, "error": blocked.error_message,
                    "data": {"requires_user_action": True, "error_type": blocked.error_type}}
        proxy = self.config.proxy
        extra = account.extra or {}
        from types import SimpleNamespace
        from .constants import CODEX_CLIENT_ID
        from .token_refresh import TokenRefreshManager
        a = SimpleNamespace(
            email=account.email, access_token=extra.get("access_token") or account.token,
            refresh_token=extra.get("refresh_token", ""), id_token=extra.get("id_token", ""),
            session_token=extra.get("session_token", ""), cookies=extra.get("cookies", ""),
            client_id=extra.get("client_id") or CODEX_CLIENT_ID,
        )
        self.log("正在刷新原账号的 OAuth Token")
        result = TokenRefreshManager(proxy_url=proxy).refresh_account(a)
        if getattr(result, "requires_user_action", False):
            return {"ok": False, "error": result.error_message,
                    "data": {"requires_user_action": True,
                             "error_type": getattr(result, "error_type", "") or "remote_verification"}}
        if result.success and result.refresh_token:
            data = {"access_token": result.access_token, "refresh_token": result.refresh_token,
                    "id_token": result.id_token or a.id_token, "client_id": a.client_id}
            try:
                from .switch import fetch_chatgpt_account_state
                data["account_state"] = fetch_chatgpt_account_state(
                    access_token=result.access_token, id_token=data["id_token"],
                    session_token=a.session_token, cookies=a.cookies, proxy=proxy,
                )
            except Exception:
                pass
            return {"ok": True, "data": data}

        self.log("OAuth Token 缺失或已失效，启动原账号浏览器登录")
        try:
            data = self._login_for_refresh(account)
            _assert_complete_oauth_callback(data, expected_email=account.email)
            return {"ok": True, "data": {**data, "oauth_login_verified": True,
                                         "message": "原账号登录完成，已获取并保存 OAuth Token"}}
        except Exception as exc:
            return {"ok": False, "error": f"原账号登录未完成: {exc}",
                    "data": {"requires_user_action": True}}

    def _login_for_refresh(self, account: Account) -> dict:
        from core.config_store import config_store
        from core.base_identity import IdentityMaterial
        from core.base_mailbox import MailboxAccount, create_mailbox
        from core.registration.models import RegistrationContext
        from core.registration.helpers import build_otp_callback
        from infrastructure.provider_settings_repository import ProviderSettingsRepository
        from .browser_register import ChatGPTBrowserRegister

        if not account.email:
            raise ValueError("账号缺少邮箱，无法确定登录身份")
        extra = account.extra or {}
        provider_account = next((item for item in extra.get("provider_accounts", [])
                                 if item.get("provider_type") == "mailbox" and item.get("provider_name")), {})
        provider_key = provider_account.get("provider_name") or ProviderSettingsRepository().get_default_provider_key("mailbox")
        identity = IdentityMaterial(email=account.email)
        if provider_key:
            resource = next((item for item in extra.get("provider_resources", [])
                             if item.get("resource_type") == "mailbox" and
                             (item.get("handle") == account.email or (item.get("metadata") or {}).get("email") == account.email)), {})
            metadata = resource.get("metadata") or {}
            mailbox_id = metadata.get("account_id") or metadata.get("token") or (provider_account.get("metadata") or {}).get("account_id") or ""
            self.mailbox = create_mailbox(provider_key, extra={**self.config.extra, "mail_provider": provider_key},
                                          proxy=self.config.proxy)
            mail_account = MailboxAccount(email=account.email, account_id=str(mailbox_id),
                                          extra={"mailbox_provider_key": provider_key,
                                                 "provider_account": provider_account, "provider_resource": resource})
            identity = IdentityMaterial(email=account.email, mailbox_account=mail_account,
                                        before_ids=self.mailbox.get_current_ids(mail_account))
        elif not account.password and not (extra.get("cookies") or extra.get("session_token")):
            raise ValueError("请先配置原账号邮箱服务，才能自动接收登录验证码")
        ctx = RegistrationContext(self.name, self.display_name, self, identity, self.config,
                                  account.email, account.password, self.log)
        history = {**((extra.get("account_overview") or {}).get("legacy_extra") or {}), **extra}
        progress = {key: history[key] for key in ("totp_secret", "cookies", "session_token") if history.get(key)}
        def authenticator_code():
            from api.authenticator import _native_entries
            import time
            for attempt in range(2):
                native = _native_entries()
                entries = [entry for entry in native.get("entries", [])
                           if str(entry.get("issuer", "")).strip().casefold() in {"openai", "chatgpt"}
                           and str(entry.get("label", "")).strip().casefold() == account.email.strip().casefold()]
                if native.get("status") != "ready" or len(entries) != 1:
                    raise RuntimeError("现有验证器中没有唯一匹配的原账号 OpenAI 验证码")
                entry = entries[0]
                remaining = int(entry.get("remaining", 0))
                if remaining > 5:
                    return entry["code"]
                if not attempt:
                    self.log("认证器验证码即将过期，等待下一周期")
                    time.sleep(max(0, remaining) + 1)
            raise RuntimeError("现有验证器验证码即将过期，请稍后重试")

        worker = ChatGPTBrowserRegister(
            headless=(config_store.get("chatgpt_token_refresh_headless", "false").strip().lower() == "true"),
            proxy=self.config.proxy,
            otp_callback=build_otp_callback(ctx, timeout=180), log_fn=self.log,
            security_progress=progress, totp_callback=authenticator_code,
        )
        return worker.login(email=account.email, password=account.password)

    def _handle_generate_link(self, account: Account, params: dict) -> dict:
        """Handle generate_link capability for ChatGPT."""
        proxy = self.config.proxy if self.config else None
        extra = account.extra or {}

        class _A: pass
        a = _A()
        a.email = account.email
        a.password = account.password
        a.session_token = extra.get("session_token", "")
        a.cookies = extra.get("cookies", "")

        from platforms.chatgpt.payment import generate_plus_link, generate_team_link, open_url_incognito
        plan = params.get("plan", "plus")
        country = params.get("country", "US")

        # Manually construct basic cookie in case old accounts don't have complete cookie string
        if not a.cookies and a.session_token:
            a.cookies = f"__Secure-next-auth.session-token={a.session_token}"

        if plan == "plus":
            url = generate_plus_link(a, proxy=proxy, country=country)
        else:
            url = generate_team_link(a, proxy=proxy, country=country)

        # Use local fingerprint browser incognito to mount Cookie and force open payment page
        if url and a.cookies:
            open_url_incognito(url, a.cookies)

        return {"ok": bool(url), "data": {"url": url, "message": "Payment link generated, opening browser with credentials..."}} 

    
