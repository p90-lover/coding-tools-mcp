"""Grok (x.ai) 浏览器注册流程（Camoufox）。"""
import time
from typing import Callable, Optional
from urllib.parse import urlparse

from camoufox.sync_api import Camoufox

ACCOUNTS_URL = "https://accounts.x.ai"
GROK_APP_URL = "https://grok.com"


def _build_proxy_config(proxy: Optional[str]) -> Optional[dict]:
    if not proxy:
        return None
    parsed = urlparse(proxy)
    if not parsed.scheme or not parsed.hostname or not parsed.port:
        return {"server": proxy}
    config = {"server": f"{parsed.scheme}://{parsed.hostname}:{parsed.port}"}
    if parsed.username:
        config["username"] = parsed.username
    if parsed.password:
        config["password"] = parsed.password
    return config


def _get_cookies(page, names: list) -> dict:
    return {c["name"]: c["value"] for c in page.context.cookies() if c["name"] in names}


def _wait_for_cookies(page, names: list, timeout: int = 120) -> dict:
    deadline = time.time() + timeout
    while time.time() < deadline:
        found = _get_cookies(page, names)
        if all(n in found for n in names):
            return found
        time.sleep(1)
    return _get_cookies(page, names)


class GrokBrowserRegister:
    def __init__(
        self,
        *,
        headless: bool,
        proxy: Optional[str] = None,
        otp_callback: Optional[Callable[[], str]] = None,
        log_fn: Callable[[str], None] = print,
        given_name: str = "",
        family_name: str = "",
    ):
        self.headless = headless
        self.proxy = proxy
        self.otp_callback = otp_callback
        self.log = log_fn
        self.given_name = given_name
        self.family_name = family_name

    def run(self, email: str, password: str) -> dict:
        proxy = _build_proxy_config(self.proxy)
        launch_opts = {"headless": self.headless}
        if proxy:
            launch_opts["proxy"] = proxy
            launch_opts["geoip"] = True

        with Camoufox(**launch_opts) as browser:
            page = browser.new_page()
            self.log("打开 Grok 注册页")
            page.goto(f"{ACCOUNTS_URL}/sign-up", wait_until="networkidle", timeout=30000)
            time.sleep(2)

            # Wait for the email form; this first button can ignore an early click.
            btn_email_sel = 'button:has-text("email")'
            email_sel = 'input[type="email"], input[name="email"], input[name="username"]'
            for _ in range(3):
                if page.query_selector(email_sel):
                    break
                if page.query_selector(btn_email_sel):
                    page.locator(btn_email_sel).first.dispatch_event("click")
                page.wait_for_timeout(2000)
            try:
                page.wait_for_selector(email_sel, timeout=15000)
            except Exception:
                page.screenshot(path="aiTemp/grok-live/grok_email_stuck.png")
                with open("aiTemp/grok-live/grok_email_stuck.html", "w", encoding="utf-8") as f:
                    f.write(page.content())
                raise
            page.fill(email_sel, email)

            btn_sel = 'button[type="submit"], button[data-testid="continue"]'
            if page.query_selector(btn_sel):
                page.locator(btn_sel).first.dispatch_event("click")
            time.sleep(3)

            # OTP sent to email
            try:
                page.wait_for_selector('input[name="code"], input[placeholder*="code"], input[placeholder*="Code"]', timeout=20000)
            except Exception:
                fb = ""
                for sel in ['[role="alert"]', '.error']:
                    el = page.query_selector(sel)
                    if el:
                        fb = el.inner_text()
                        break
                raise RuntimeError(f"未进入验证码页面: {fb or page.url}")

            page.screenshot(path="aiTemp/grok-live/grok_code_pending.png")
            if not self.otp_callback:
                raise RuntimeError("Grok 注册需要邮箱验证码但未提供 otp_callback")
            self.log("等待 Grok 验证码")
            code = self.otp_callback()
            if not code:
                raise RuntimeError("未获取到验证码")

            code_sel = 'input[name="code"], input[data-input-otp="true"]'
            if not page.query_selector(code_sel):
                code_sel = 'input[placeholder*="code"], input[placeholder*="Code"]'
            
            # The input expects 6 characters without hyphen
            clean_code = code.replace("-", "")
            try:
                page.fill(code_sel, clean_code, force=True)
            except:
                page.locator(code_sel).press_sequentially(clean_code)

            confirm_btn = 'button:has-text("Confirm email")'
            if page.query_selector(confirm_btn):
                page.locator(confirm_btn).first.dispatch_event("click")
            elif page.query_selector(btn_sel):
                page.locator(btn_sel).first.dispatch_event("click")
            time.sleep(3)

            # May need name + password
            self.log("等待姓名/密码填写步骤")
            for _ in range(15):
                if page.query_selector('input[name="given_name"], input[placeholder*="First"], input[name="password"], input[type="password"]'):
                    break
                time.sleep(1)
            else:
                self.log("未检测到姓名或密码输入框，保存截图到 aiTemp/grok-live/grok_debug.png")
                page.screenshot(path="aiTemp/grok-live/grok_debug.png")
                with open("aiTemp/grok-live/grok_debug.html", "w", encoding="utf-8") as f:
                    f.write(page.content())

            # DEBUG SCREENSHOT
            page.screenshot(path="aiTemp/grok-live/grok_name_pass.png")

            if page.query_selector('input[name="given_name"], input[name="givenName"], input[placeholder*="First"]'):
                import random, string
                first = self.given_name or ''.join(random.choices(string.ascii_lowercase, k=5)).capitalize()
                last = self.family_name or ''.join(random.choices(string.ascii_lowercase, k=5)).capitalize()
                fname_sel = 'input[name="given_name"], input[name="givenName"], input[placeholder*="First"]'
                if page.query_selector(fname_sel):
                    page.fill(fname_sel, first)
                lname_sel = 'input[name="family_name"], input[name="familyName"], input[placeholder*="Last"]'
                if page.query_selector(lname_sel):
                    page.fill(lname_sel, last)
                # DO NOT CLICK YET if password is also on screen
                if not page.query_selector('input[name="password"], input[type="password"]'):
                    if page.query_selector(btn_sel):
                        page.locator(btn_sel).first.dispatch_event("click")
                    time.sleep(2)

            for _ in range(10):
                if page.query_selector('input[name="password"], input[type="password"]'):
                    break
                time.sleep(1)

            if page.query_selector('input[name="password"], input[type="password"]'):
                page.fill('input[name="password"], input[type="password"]', password)
                marketing = page.get_by_label("Receive email updates on new features and offers")
                if marketing.count() and marketing.is_checked():
                    marketing.dispatch_event("click")
                challenge = page.locator('iframe[src*="challenges.cloudflare.com"], [name="cf-turnstile-response"]')
                if challenge.count():
                    self.log("等待人工完成 Grok 的 Verify you are human")
                    deadline = time.time() + 900
                    while time.time() < deadline:
                        if _get_cookies(page, ["sso"]).get("sso"):
                            break
                        token = page.evaluate("() => document.querySelector('[name=cf-turnstile-response]')?.value || ''")
                        if token:
                            break
                        page.wait_for_timeout(1000)
                    else:
                        page.screenshot(path="aiTemp/grok-live/grok_turnstile_pending.png")
                        raise RuntimeError("Grok human verification was not completed")
                if not _get_cookies(page, ["sso"]).get("sso"):
                    submit_btn = 'button:has-text("Complete sign up"), button:has-text("Sign up"), button[type="submit"]'
                    try:
                        page.locator(submit_btn).first.dispatch_event("click")
                    except Exception:
                        self.log("Grok submit needs a manual click; waiting for session")

            # Wait for sso cookie
            self.log("等待 Grok sso cookie")
            cookies = _wait_for_cookies(page, ["sso"], timeout=300)
            sso = cookies.get("sso", "")
            if not sso:
                self.log("未获取到 sso cookie，保存截图到 aiTemp/grok-live/grok_fail_final.png")
                page.screenshot(path="aiTemp/grok-live/grok_fail_final.png")
                with open("aiTemp/grok-live/grok_fail_final.html", "w", encoding="utf-8") as f:
                    f.write(page.content())
                raise RuntimeError("未获取到 Grok sso cookie")
            sso_rw = _get_cookies(page, ["sso-rw"]).get("sso-rw", "")
            self.log(f"注册成功: {email}")
            return {"email": email, "password": password, "sso": sso, "sso_rw": sso_rw}
