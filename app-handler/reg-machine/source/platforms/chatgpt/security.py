"""ChatGPT security completion; reuse the existing browser and mailbox flow."""
import base64
import hashlib
import hmac
import json
import struct
import time
from urllib.parse import urlencode, urlparse, urljoin

from .constants import CHATGPT_APP


def totp_code(secret, timestamp=None, *, min_remaining=0):
    # Same RFC 6238 calculation used by reg-factory/common/oauth_codex.py.
    normalized = str(secret or "").replace(" ", "").upper()
    key = base64.b32decode(normalized + "=" * (-len(normalized) % 8), casefold=True)
    if timestamp is None:
        timestamp = time.time()
        remaining = 30 - timestamp % 30
        if remaining < min_remaining:
            time.sleep(remaining)
            timestamp = time.time()
    counter = int(timestamp // 30)
    digest = hmac.new(key, struct.pack(">Q", counter), hashlib.sha1).digest()
    offset = digest[-1] & 15
    return f"{(struct.unpack('>I', digest[offset:offset + 4])[0] & 0x7fffffff) % 1000000:06d}"


def _api(page, url, *, headers=None, data=None):
    from .browser_register import _browser_fetch
    response = _browser_fetch(page, url, method="POST" if data is not None else "GET",
                              headers=headers, body=json.dumps(data) if data is not None else None,
                              redirect="follow")
    if not response.get("ok") or not isinstance(response.get("data"), dict):
        raise RuntimeError(f"ChatGPT security request failed: HTTP {response.get('status', 0)}")
    return response["data"]


def _navigate(page, url, *, wait_until="domcontentloaded", timeout=60000):
    parsed = urlparse(url)
    if parsed.scheme == "https" and parsed.hostname == "auth.openai.com" and parsed.path == "/api/accounts/authorize":
        response = page.context.request.get(url, max_redirects=0, timeout=timeout)
        try:
            location = response.headers.get("location")
            target = urljoin(url, location) if location and response.status in {301, 302, 303, 307, 308} else url
        finally:
            response.dispose()
        parsed = urlparse(target)
        if parsed.scheme != "https" or parsed.hostname not in {"auth.openai.com", "chatgpt.com"}:
            raise RuntimeError("OpenAI authorization returned an untrusted redirect")
        url = target
    previous_url = str(page.url or "")
    try:
        page.goto(url, wait_until=wait_until, timeout=timeout)
    except Exception as exc:
        if "NS_BINDING_ABORTED" not in str(exc):
            raise
        if str(page.url or "") == previous_url:
            try:
                page.wait_for_url(lambda target: str(target) != previous_url, wait_until=wait_until, timeout=timeout)
            except Exception:
                raise exc
        current_url = str(page.url or "")
        parsed = urlparse(current_url)
        if (current_url == previous_url or parsed.scheme != "https"
                or parsed.hostname not in {"auth.openai.com", "chatgpt.com"}):
            raise


def _reauthenticate(page, email, password, otp_callback, secret, log):
    from .browser_register import (
        _get_browser_csrf_token, _browser_fetch, _derive_registration_state_from_page,
        _submit_login_email_via_page, _submit_oauth_password_direct,
        _submit_otp_via_page, _click_first, _get_cookies, _wait_for_openai_browser_check,
    )
    _navigate(page, CHATGPT_APP + "/")
    _wait_for_openai_browser_check(page, log)
    csrf = _get_browser_csrf_token(page)
    if not csrf:
        raise RuntimeError("MFA setup could not obtain a CSRF token")
    query = urlencode({"connection": "password", "login_hint": email, "reauth": "password", "max_age": "0"})
    body = urlencode({"callbackUrl": CHATGPT_APP + "/?action=enable&factor=totp", "csrfToken": csrf, "json": "true"})
    response = _browser_fetch(page, CHATGPT_APP + "/api/auth/signin/openai?" + query,
                              method="POST", headers={"content-type": "application/x-www-form-urlencoded"},
                              body=body, redirect="follow")
    auth_url = str((response.get("data") or {}).get("url") or "")
    if not response.get("ok") or urlparse(auth_url).hostname not in {"auth.openai.com", "chatgpt.com"}:
        raise RuntimeError("MFA reauthentication did not return an OpenAI URL")
    _navigate(page, auth_url)
    for _ in range(20):
        _wait_for_openai_browser_check(page, log)
        if urlparse(page.url).hostname == "chatgpt.com":
            session = _api(page, CHATGPT_APP + "/api/auth/session")
            if session.get("accessToken"):
                if str((session.get("user") or {}).get("email") or "").lower() != email.lower():
                    raise RuntimeError("MFA session belongs to a different account")
                session["cookies"] = _get_cookies(page)
                session["browser_cookies"] = page.context.cookies()
                return session
        state = _derive_registration_state_from_page(page)
        kind = state.get("page_type")
        if "/mfa" in urlparse(page.url).path:
            if not secret:
                raise RuntimeError("Existing authenticator secret is required to resume this account")
            response = _submit_otp_via_page(page, lambda: totp_code(secret, min_remaining=8), log)
        elif kind == "login_email":
            response = _submit_login_email_via_page(page, email, log)
        elif kind in {"login_password", "create_account_password"}:
            response = _submit_oauth_password_direct(page, password, log)
        elif kind == "email_otp_verification":
            code = otp_callback() if otp_callback else ""
            if not code:
                raise RuntimeError("MFA reauthentication needs a fresh mailbox code")
            response = _submit_otp_via_page(page, code, log)
        elif kind in {"consent", "workspace_selection", "organization_selection"}:
            if not _click_first(page, ["button[type='submit']", "button:has-text('Continue')"], timeout=5):
                raise RuntimeError("MFA reauthentication consent could not continue")
            time.sleep(1)
            continue
        else:
            target = state.get("continue_url") or ""
            if target and target != page.url and urlparse(target).hostname in {"auth.openai.com", "chatgpt.com"}:
                _navigate(page, target)
            else:
                time.sleep(1)
            continue
        if not response.get("ok"):
            raise RuntimeError("MFA reauthentication was rejected")
    raise RuntimeError("MFA reauthentication did not finish")


def _disable_phone_mfa(page, log):
    # Exact factor labels are present in the preserved Security and login UI.
    page.get_by_role("button", name="Open profile menu", exact=True).click(timeout=15000)
    from .browser_register import _click_first
    if not _click_first(page, ["[role='menuitem']:has-text('Settings')", "button:has-text('Settings')"], timeout=5):
        raise RuntimeError("Could not open ChatGPT security settings")
    page.get_by_role("button", name="Security and login", exact=True).click(timeout=15000)
    row = page.get_by_text("Text message", exact=True).locator("xpath=ancestor::*[.//button][1]")
    buttons = row.locator("button")
    if buttons.count() != 1:
        raise RuntimeError("SMS MFA control is ambiguous; phone login was left unchanged")
    _check_cancelled(log)
    buttons.click(timeout=15000)
    dialog = page.get_by_role("dialog")
    confirm = dialog.get_by_role("button", name="Disable", exact=True)
    if confirm.count() == 1 and confirm.is_visible():
        _check_cancelled(log)
        confirm.click(timeout=15000)
    log("SMS MFA change requested; checking OpenAI factor state")


def _factors(data):
    factors = data.get("factors")
    if not isinstance(factors, dict) or not isinstance(factors.get("totp"), list) or not isinstance(factors.get("sms"), list):
        raise RuntimeError("OpenAI MFA factor state is missing or unsupported")
    return factors["totp"], factors["sms"]


def _check_cancelled(log):
    from .browser_register import _task_cancel_requested
    if _task_cancel_requested(log):
        raise RuntimeError("registration_cancelled: 安全设置已取消")


def complete_chatgpt_security(page, email, password, otp_callback, result, checkpoint, log):
    if not callable(checkpoint):
        raise RuntimeError("MFA setup requires persistent recovery storage")
    _check_cancelled(log)
    session = _reauthenticate(page, email, password, otp_callback, result.get("totp_secret", ""), log)
    _check_cancelled(log)
    cookies = session.get("cookies") or {}
    result["session_token"] = cookies.get("__Secure-next-auth.session-token", "")
    result["cookies"] = json.dumps(session.get("browser_cookies") or cookies)
    # Store the authenticated session too, so a failed security step can resume.
    checkpoint(result)
    headers = {"authorization": "Bearer " + session["accessToken"], "content-type": "application/json"}
    info_url = CHATGPT_APP + "/backend-api/accounts/mfa_info"
    totp, sms = _factors(_api(page, info_url, headers=headers))
    if not totp:
        _check_cancelled(log)
        enrollment = _api(page, CHATGPT_APP + "/backend-api/accounts/mfa/enroll",
                          headers=headers, data={"factor_type": "totp"})
        secret = str(enrollment.get("secret") or "")
        session_id = str(enrollment.get("session_id") or "")
        if not secret or not session_id:
            raise RuntimeError("TOTP enrollment did not return a setup key")
        result["totp_secret"] = secret
        checkpoint(result)  # Persist the key before OpenAI can activate it.
        _check_cancelled(log)
        activation_code = totp_code(secret, min_remaining=8)
        _check_cancelled(log)
        activation = _api(page, CHATGPT_APP + "/backend-api/accounts/mfa/user/activate_enrollment",
                          headers=headers, data={"code": activation_code, "factor_type": "totp", "session_id": session_id})
        if activation.get("success") is not True:
            raise RuntimeError("TOTP activation was not accepted")
        totp, sms = _factors(_api(page, info_url, headers=headers))
    if not totp:
        raise RuntimeError("TOTP enrollment could not be verified")
    result["authenticator_verified"] = True
    checkpoint(result)
    if sms:
        _check_cancelled(log)
        _disable_phone_mfa(page, log)
        for _ in range(5):
            totp, sms = _factors(_api(page, info_url, headers=headers))
            if totp and not sms:
                break
            time.sleep(1)
    if not totp or sms:
        raise RuntimeError("SMS MFA is still active or authenticator MFA is missing")
    _check_cancelled(log)
    result["phone_mfa_disabled"] = True
    checkpoint(result)
    log("Authenticator MFA verified; SMS MFA disabled")
