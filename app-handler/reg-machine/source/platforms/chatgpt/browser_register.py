"""ChatGPT 浏览器注册流程（Camoufox）。"""
import base64
import json
import os
import random
import re
import secrets
import time
import uuid
from pathlib import Path
from typing import Callable, Optional
from urllib.parse import urljoin, urlparse

from camoufox.sync_api import Camoufox
from core.verification_hold import activate_verification_hold
from .security import complete_chatgpt_security as _complete_chatgpt_security, totp_code, _navigate

from .constants import (
    OPENAI_AUTH,
    CHATGPT_APP,
    PLATFORM_LOGIN_ENTRY,
    SENTINEL_SDK_URL,
    SENTINEL_REQ_URL,
    SENTINEL_FRAME_URL,
    SENTINEL_BASE,
    OAUTH_CONSENT_FORM_SELECTOR,
)

EMAIL_INPUT_SELECTORS = [
    'input#login-email',
    'input[type="email"]',
    'input[name="email"]',
    'input[name="username"]',
    'input[autocomplete="username"]',
    'input[autocomplete*="username"]',
    'input[inputmode="email"]',
    'input[id*="email"]',
]

PASSWORD_INPUT_SELECTORS = [
    'input[type="password"]',
    'input[name="password"]',
    'input[autocomplete="new-password"]',
]

EMAIL_SUBMIT_SELECTORS = [
    'button[type="submit"]',
    'button[data-testid="continue-button"]',
    'button:has-text("Continue")',
    'button:has-text("continue")',
    'button:has-text("Next")',
    'button:has-text("next")',
]

PASSWORD_SUBMIT_SELECTORS = [
    'button[type="submit"]',
    'button[data-testid="continue-button"]',
    'button:has-text("Continue")',
    'button:has-text("continue")',
    'button:has-text("Sign up")',
    'button:has-text("sign up")',
    'button:has-text("Create account")',
    'button:has-text("create account")',
]

OTP_INPUT_SELECTORS = [
    "input[inputmode='numeric']",
    "input[autocomplete='one-time-code']",
    "input[type='tel']",
    "input[type='number']",
    "input[name*='code' i]",
    "input[id*='code' i]",
]

SIGNUP_RECOVERY_SELECTORS = [
    'a:has-text("Sign up")',
    'button:has-text("Sign up")',
    'a:has-text("sign up")',
    'button:has-text("sign up")',
    'a:has-text("Register")',
    'button:has-text("Register")',
    'a:has-text("Create account")',
    'button:has-text("Create account")',
    'a:has-text("创建账号")',
    'button:has-text("创建账号")',
    'a:has-text("注册")',
    'button:has-text("注册")',
]

PASSWORDLESS_LOGIN_SELECTORS = [
    'button[name="intent"][value="passwordless_login_send_otp"]',
    'button[value="passwordless_login_send_otp"]',
    'button:has-text("one-time code")',
    'button:has-text("one time code")',
    'button:has-text("passwordless")',
    'button:has-text("一次性验证码")',
    'button:has-text("驗證碼")',
    'button:has-text("验证码")',
    'button:has-text("código único")',
    'button:has-text("code unique")',
    'button:has-text("Einmalcode")',
    'button:has-text("código de uso único")',
]

# add-phone 页面国际拨号码 -> 国家名映射（用于 UI 下拉选择）
PHONE_COUNTRY_CODE_MAP = {
    "1": "United States", "7": "Russia", "20": "Egypt", "27": "South Africa",
    "30": "Greece", "31": "Netherlands", "32": "Belgium", "33": "France",
    "34": "Spain", "36": "Hungary", "39": "Italy", "40": "Romania",
    "44": "United Kingdom", "45": "Denmark", "46": "Sweden", "47": "Norway",
    "48": "Poland", "49": "Germany", "51": "Peru", "52": "Mexico",
    "53": "Cuba", "54": "Argentina", "55": "Brazil", "56": "Chile",
    "57": "Colombia", "58": "Venezuela", "60": "Malaysia", "61": "Australia",
    "62": "Indonesia", "63": "Philippines", "64": "New Zealand",
    "65": "Singapore", "66": "Thailand", "81": "Japan", "82": "South Korea",
    "84": "Vietnam", "86": "China", "90": "Turkey", "91": "India",
    "92": "Pakistan", "93": "Afghanistan", "94": "Sri Lanka", "95": "Myanmar",
    "98": "Iran", "212": "Morocco", "213": "Algeria", "216": "Tunisia",
    "218": "Libya", "220": "Gambia", "221": "Senegal", "234": "Nigeria",
    "254": "Kenya", "255": "Tanzania", "256": "Uganda", "260": "Zambia",
    "263": "Zimbabwe", "351": "Portugal", "353": "Ireland", "354": "Iceland",
    "358": "Finland", "370": "Lithuania", "371": "Latvia", "372": "Estonia",
    "374": "Armenia", "375": "Belarus", "380": "Ukraine", "381": "Serbia",
    "385": "Croatia", "420": "Czech Republic", "421": "Slovakia",
    "855": "Cambodia", "856": "Laos", "880": "Bangladesh", "886": "Taiwan",
    "960": "Maldives", "966": "Saudi Arabia", "971": "United Arab Emirates",
    "972": "Israel", "977": "Nepal", "992": "Tajikistan",
    "993": "Turkmenistan", "994": "Azerbaijan", "995": "Georgia",
    "996": "Kyrgyzstan", "998": "Uzbekistan",
}

# 拨号码 -> ISO 3166-1 alpha-2 国家代码（用于 React Aria <select> 的 value 匹配）
PHONE_DIAL_TO_ISO = {
    "1": "US", "7": "RU", "20": "EG", "27": "ZA",
    "30": "GR", "31": "NL", "32": "BE", "33": "FR",
    "34": "ES", "36": "HU", "39": "IT", "40": "RO",
    "44": "GB", "45": "DK", "46": "SE", "47": "NO",
    "48": "PL", "49": "DE", "51": "PE", "52": "MX",
    "53": "CU", "54": "AR", "55": "BR", "56": "CL",
    "57": "CO", "58": "VE", "60": "MY", "61": "AU",
    "62": "ID", "63": "PH", "64": "NZ",
    "65": "SG", "66": "TH", "81": "JP", "82": "KR",
    "84": "VN", "86": "CN", "90": "TR", "91": "IN",
    "92": "PK", "93": "AF", "94": "LK", "95": "MM",
    "98": "IR", "212": "MA", "213": "DZ", "216": "TN",
    "218": "LY", "220": "GM", "221": "SN", "234": "NG",
    "254": "KE", "255": "TZ", "256": "UG", "260": "ZM",
    "263": "ZW", "351": "PT", "353": "IE", "354": "IS",
    "358": "FI", "370": "LT", "371": "LV", "372": "EE",
    "374": "AM", "375": "BY", "380": "UA", "381": "RS",
    "385": "HR", "420": "CZ", "421": "SK",
    "855": "KH", "856": "LA", "880": "BD", "886": "TW",
    "960": "MV", "966": "SA", "971": "AE",
    "972": "IL", "977": "NP", "992": "TJ",
    "993": "TM", "994": "AZ", "995": "GE",
    "996": "KG", "998": "UZ",
}

PHONE_INPUT_SELECTORS = [
    'input[type="tel"]',
    'input[name="phone"]',
    'input[name="phone_number"]',
    'input[name="phoneNumber"]',
    'input[id*="phone" i]',
    'input[placeholder*="phone" i]',
    'input[autocomplete="tel"]',
    'input[autocomplete="tel-national"]',
]

PHONE_SEND_SELECTORS = [
    'button:has-text("Send code via SMS")',
    'button:has-text("Send code")',
    'button:has-text("Send via SMS")',
    'button:has-text("Send link via SMS")',
    'button:has-text("Send")',
    'button[type="submit"]',
    'button:has-text("Continue")',
    'button:has-text("continue")',
    'button:has-text("发送")',
]

PHONE_VERIFY_SELECTORS = [
    'button:has-text("Verify")',
    'button:has-text("verify")',
    'button:has-text("Check")',
    'button[type="submit"]',
    'button:has-text("Continue")',
    'button:has-text("continue")',
    'button:has-text("验证")',
    'button:has-text("确认")',
]


def _parse_phone_country_and_local(phone_number: str) -> tuple[str, str, str]:
    """从完整手机号解析出 (拨号码, 本地号码, 国家名)。

    例: +66959075673 -> ("66", "959075673", "Thailand")
    """
    num = str(phone_number or "").lstrip("+").strip()
    for length in (3, 2, 1):
        if length > len(num):
            continue
        prefix = num[:length]
        if prefix in PHONE_COUNTRY_CODE_MAP:
            return prefix, num[length:], PHONE_COUNTRY_CODE_MAP[prefix]
    return "", num, ""


def _select_phone_country_ui(page, dial_code: str, country_name: str, log) -> bool:
    """在 add-phone 页面的国家下拉框中选择对应国家。

    OpenAI add-phone 页面使用 React Aria Select 组件，底层有一个隐藏的原生 <select>
    和一个可视的 button trigger + listbox 弹出层。
    """
    if not dial_code and not country_name:
        log("  无法识别国家码，跳过国家选择")
        return False

    iso_code = PHONE_DIAL_TO_ISO.get(dial_code, "")
    log(f"  目标国家: {country_name} (+{dial_code}) ISO={iso_code}")

    # 先检查当前下拉框是否已经是目标国家
    dial_pattern = f"(+{dial_code})"
    def _country_ui_matches():
        return bool(page.evaluate(
            r"""({isoCode, dialPattern, countryName}) => {
              const select = Array.from(document.querySelectorAll('select')).find(el =>
                Array.from(el.options).some(option => isoCode
                  ? option.value.toUpperCase() === isoCode
                  : countryName && option.text.includes(countryName)));
              const selected = select?.selectedOptions[0];
              if (!selected || (isoCode && selected.value.toUpperCase() !== isoCode)) return false;
              const normalize = value => String(value || '').replace(/\(?\+\d{1,4}\)?/g, '').replace(/\s+/g, ' ').trim().toLocaleLowerCase();
              const label = normalize(selected.text || selected.label);
              const trigger = document.querySelector('button[aria-haspopup="listbox"]') ||
                              document.querySelector('.react-aria-Select button') ||
                              document.querySelector('[role="combobox"]');
              if (!trigger || !trigger.getBoundingClientRect().width) return false;
              const text = (trigger.innerText || trigger.textContent || '').replace(/\s+/g, ' ').trim();
              const names = [countryName];
              try {
                for (const style of ['long', 'short']) names.push(new Intl.DisplayNames(
                  [document.documentElement.lang || navigator.language], {type: 'region', style}).of(isoCode));
              } catch (_) {}
              const expectedNames = names.filter(Boolean).map(normalize);
              return text.includes(dialPattern) && expectedNames.includes(normalize(text)) &&
                     (!label || expectedNames.includes(label));
            }""",
            {"isoCode": iso_code, "dialPattern": dial_pattern, "countryName": country_name},
        ))

    already = _country_ui_matches()
    if already:
        log(f"  国家已是目标值: (+{dial_code})")
        return True

    # ═══════════════════════════════════════════════════════════════════
    # 策略 1: 通过底层原生 <select> 直接设置值（最可靠）
    # React Aria Select 底层会有一个隐藏的 <select> 用于表单提交和无障碍。
    # 直接修改它的值并触发 change 事件可以同步 React 状态。
    # ═══════════════════════════════════════════════════════════════════
    native_selected = page.evaluate(
        """
        ({ isoCode, dialCode, countryName }) => {
          const selects = document.querySelectorAll('select');
          for (const sel of selects) {
            if (sel.options.length < 10) continue;  // 排除非国家的 select

            // 尝试多种匹配策略找到目标 option
            let targetValue = null;
            for (const opt of sel.options) {
              const v = (opt.value || '').trim();
              const t = (opt.text || opt.label || '').trim();
              // 匹配 ISO 代码 (如 "TH")
              if (isoCode && v.toUpperCase() === isoCode) { targetValue = v; break; }
              // 匹配拨号码 (如 value 包含 "66" 或 text 包含 "+66")
              if (!isoCode && countryName && t.includes(countryName)) { targetValue = v; break; }
            }

            if (targetValue !== null) {
              // 使用 React 兼容的方式设置值
              const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
                window.HTMLSelectElement.prototype, 'value'
              )?.set;
              if (nativeInputValueSetter) {
                nativeInputValueSetter.call(sel, targetValue);
              } else {
                sel.value = targetValue;
              }
              sel.dispatchEvent(new Event('change', { bubbles: true }));
              sel.dispatchEvent(new Event('input', { bubbles: true }));
              return { ok: true, value: targetValue, method: 'native_setter' };
            }
          }
          return { ok: false };
        }
        """,
        {"isoCode": iso_code, "dialCode": dial_code, "countryName": country_name},
    )
    if native_selected and native_selected.get("ok"):
        log(f"  ✓ 通过原生 <select> 选择成功: value={native_selected.get('value')}")
        time.sleep(0.5)
        # 验证 UI 是否同步更新
        verify = page.evaluate(
            "(dp) => { const b = document.querySelector('button[aria-haspopup=\"listbox\"]'); return b ? (b.innerText || '').trim() : ''; }",
            dial_pattern,
        )
        if _country_ui_matches():
            log(f"  ✓ UI 已同步: {verify}")
            return True
        log(f"  原生 select 已设置但 UI 未同步 ({verify})，尝试 UI 交互...")

    # ═══════════════════════════════════════════════════════════════════
    # 策略 2: 通过 React Aria 的 key 属性直接操作
    # ═══════════════════════════════════════════════════════════════════
    key_selected = page.evaluate(
        """
        ({ isoCode, dialCode, countryName }) => {
          // 找到 React Aria Select 的隐藏 <select> 并通过 selectOption 模拟
          const selects = document.querySelectorAll('select');
          for (const sel of selects) {
            if (sel.options.length < 10) continue;
            for (const opt of sel.options) {
              const v = (opt.value || '').trim();
              const t = (opt.text || opt.label || '').trim();
              if ((isoCode && v.toUpperCase() === isoCode) || (!isoCode && countryName && t.includes(countryName))) {
                sel.value = v;
                // 触发 React 合成事件
                const ev = new Event('change', { bubbles: true });
                Object.defineProperty(ev, 'target', { writable: false, value: sel });
                sel.dispatchEvent(ev);
                return { ok: true, value: v, text: t };
              }
            }
          }
          return { ok: false };
        }
        """,
        {"isoCode": iso_code, "dialCode": dial_code, "countryName": country_name},
    )

    # ═══════════════════════════════════════════════════════════════════
    # 策略 3: 使用 Playwright 的 selectOption API（对原生 select 最可靠）
    # ═══════════════════════════════════════════════════════════════════
    try:
        select_el = page.query_selector("select")
        if select_el:
            # 尝试用 ISO 代码选择
            if iso_code:
                try:
                    select_el.select_option(value=iso_code)
                    log(f"  ✓ Playwright selectOption(value={iso_code}) 成功")
                    time.sleep(0.5)
                    if _country_ui_matches():
                        return True
                except Exception:
                    pass
            # 尝试用 label 匹配（包含国家名或拨号码）
            try:
                # 获取所有 option 的 value 和 text，找到匹配的
                match_value = page.evaluate(
                    """
                    ({ dialCode, countryName }) => {
                      const sel = document.querySelector('select');
                      if (!sel) return '';
                      for (const opt of sel.options) {
                        const t = (opt.text || opt.label || '').trim();
                        const v = (opt.value || '').trim();
                        if (t.includes('(+' + dialCode + ')') || t.includes(countryName)) return v;
                      }
                      return '';
                    }
                    """,
                    {"dialCode": dial_code, "countryName": country_name},
                )
                if match_value:
                    select_el.select_option(value=match_value)
                    log(f"  Playwright selectOption(value={match_value}) 已执行")
                    time.sleep(0.5)
                    if _country_ui_matches():
                        return True
            except Exception as e:
                log(f"  selectOption label 匹配失败: {e}")
    except Exception as e:
        log(f"  Playwright selectOption 策略失败: {e}")

    # ═══════════════════════════════════════════════════════════════════
    # 策略 4: 点击 trigger 按钮打开 listbox，然后在 listbox 中选择
    # ═══════════════════════════════════════════════════════════════════
    trigger = None
    for sel in [
        'button[aria-haspopup="listbox"]',
        '.react-aria-Select button',
        'button[class*="select" i]',
        'button[class*="country" i]',
    ]:
        trigger = page.query_selector(sel)
        if trigger:
            break

    if not trigger:
        trigger = page.evaluate(
            r"""
            () => {
              const pattern = /\(\+\d{1,4}\)/;
              const all = document.querySelectorAll('button, [role="button"], [role="combobox"]');
              for (const el of all) {
                const r = el.getBoundingClientRect();
                if (r.width === 0 || r.height === 0) continue;
                const text = (el.innerText || '').trim();
                if (pattern.test(text)) {
                  el.scrollIntoView({ block: 'center' });
                  el.click();
                  return true;
                }
              }
              return false;
            }
            """,
        )
        if not trigger:
            log("  ⚠️ 未找到国家选择器触发按钮")
            return False
        log("  已通过 JS 点击触发按钮")
    else:
        trigger.scroll_into_view_if_needed()
        try:
            trigger.click(timeout=1500)
        except Exception:
            trigger.evaluate("el => el.click()")
        log("  已点击国家选择器下拉框")

    time.sleep(0.8)

    # 等待 listbox 出现
    listbox = None
    for _ in range(10):
        listbox = page.query_selector('[role="listbox"]')
        if listbox:
            break
        time.sleep(0.3)

    if not listbox:
        log("  ⚠️ 下拉框 listbox 未出现")
        return False

    log("  listbox 已出现")

    # 在 listbox 中查找并点击目标 option
    option = None
    if iso_code:
        for attr in ["data-key", "data-value", "value", "id"]:
            # 尝试精确匹配和包含匹配
            option = page.query_selector(f'[role="option"][{attr}="{iso_code}"]')
            if not option:
                option = page.query_selector(f'[role="option"][{attr}*="{iso_code}"]')
            if option:
                log(f"  找到 option: [{attr} 含 {iso_code}]")
                break

    if not option:
        option_idx = page.evaluate(
            """
            ({ countryName, dialCode }) => {
              const options = document.querySelectorAll('[role="option"]');
              for (let i = 0; i < options.length; i++) {
                const text = (options[i].innerText || options[i].textContent || '').trim();
                if (text.includes(countryName) || text.includes('(+' + dialCode + ')') || text.includes('+' + dialCode)) {
                  return i;
                }
              }
              // 宽松匹配：只匹配拨号码数字
              for (let i = 0; i < options.length; i++) {
                const text = (options[i].innerText || options[i].textContent || '').trim();
                if (text.includes(dialCode)) {
                  return i;
                }
              }
              return -1;
            }
            """,
            {"countryName": country_name, "dialCode": dial_code},
        )
        if option_idx >= 0:
            options = page.query_selector_all('[role="option"]')
            if option_idx < len(options):
                option = options[option_idx]
                log(f"  找到 option: 文本匹配 index={option_idx}")

    if option:
        option.scroll_into_view_if_needed()
        try:
            option.click(timeout=1500)
        except Exception:
            option.evaluate("el => el.click()")
        time.sleep(0.5)
        new_text = page.evaluate(
            """() => {
              const btn = document.querySelector('button[aria-haspopup="listbox"]') ||
                          document.querySelector('.react-aria-Select button');
              return btn ? (btn.innerText || '').trim() : '';
            }""",
        )
        log(f"  选择后下拉框显示: {new_text}")
        if _country_ui_matches():
            log(f"  ✓ 国家选择成功: {new_text}")
            return True

    # 键盘 type-ahead 搜索
    log(f"  尝试键盘 type-ahead: {country_name}")
    page.keyboard.type(country_name, delay=80)
    time.sleep(0.8)

    # 按 Enter 确认选择
    page.keyboard.press("Enter")
    time.sleep(0.5)

    # 验证
    final_text = page.evaluate(
        """() => {
          const btn = document.querySelector('button[aria-haspopup="listbox"]') ||
                      document.querySelector('.react-aria-Select button');
          return btn ? (btn.innerText || '').trim() : '';
        }""",
    )
    if _country_ui_matches():
        log(f"  ✓ type-ahead 选择成功: {final_text}")
        return True

    log(f"  ⚠️ 下拉框已展开但未找到匹配国家: {country_name} (+{dial_code})")
    try:
        page.keyboard.press("Escape")
    except Exception:
        pass
    return False


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


def _wait_for_url(page, substring: str, timeout: int = 60) -> bool:
    deadline = time.time() + timeout
    while time.time() < deadline:
        if substring in page.url:
            return True
        time.sleep(1)
    return False


def _find_first_selector(page, selectors: list[str]) -> str | None:
    for sel in selectors:
        visible_selector = f"{sel}:visible"
        try:
            node = page.query_selector(visible_selector)
        except Exception:
            node = None
        if node:
            return visible_selector
    return None


def _wait_for_any_selector(page, selectors: list[str], timeout: int = 30):
    if not selectors or timeout <= 0:
        return None
    from playwright.sync_api import TimeoutError as PlaywrightTimeoutError

    try:
        page.wait_for_selector(", ".join(f"{selector}:visible" for selector in selectors),
                               state="visible", timeout=timeout * 1000)
    except PlaywrightTimeoutError:
        return None
    return _find_first_selector(page, selectors)


def _click_first(page, selectors: list[str], *, timeout: int = 10, log=None, stop_if=None) -> str | None:
    deadline = time.time() + timeout
    logged_failure = False
    while time.time() < deadline:
        for sel in selectors:
            try:
                target = page.locator(f"{sel}:visible").first
                if target.count():
                    if stop_if and stop_if():
                        return sel
                    target.click(timeout=1500)
                    return sel
            except Exception as exc:
                if stop_if and stop_if():
                    return sel
                if log and not logged_failure:
                    details = re.sub(r"<([\w-]+)[^>]*>", r"<\1>", str(exc))
                    details = re.sub(r"https?://\S+", lambda m: urlparse(m[0]).path, details)
                    details = re.sub(r"[\w.+-]+@[\w.-]+", "[email omitted]", details)
                    details = re.sub(r"\b\d{6}\b|[A-Za-z0-9_-]{32,}", "[redacted]", details)
                    log(f"按钮点击失败: {type(exc).__name__}: {details[:1800]}")
                    logged_failure = True
                continue
        time.sleep(0.2)
    return None


def _is_login_password_url(url: str) -> bool:
    return bool(re.search(r"(?:auth|accounts)\.openai\.com/.*log-?in/password", str(url or ""), flags=re.I))


def _build_manual_flow_state(page_type: str, current_url: str) -> dict:
    state = _extract_flow_state(None, current_url)
    state["page_type"] = page_type
    state["current_url"] = current_url
    return state


def _get_visible_page_text(page) -> str:
    try:
        return str(page.evaluate("() => document.body?.innerText || ''") or "")
    except Exception:
        return ""


def _has_signup_registration_choice(page) -> bool:
    if not _is_login_password_url(str(page.url or "")):
        return False
    if _find_first_selector(page, SIGNUP_RECOVERY_SELECTORS):
        return True
    text = _get_visible_page_text(page)
    return bool(re.search(r"sign\s*up|register|create\s*account|还没有帐户|还没有账户|請註冊|请注册|去注册|注册", text, flags=re.I))


def _click_passwordless_login_if_available(page, log, *, context: str) -> bool:
    selector = _click_first(page, PASSWORDLESS_LOGIN_SELECTORS, timeout=1)
    if selector:
        log(f"{context} 已选择一次性验证码登录: {selector}")
        time.sleep(1)
        return True
    try:
        clicked = bool(
            page.evaluate(
                """
                () => {
                  const nodes = Array.from(document.querySelectorAll('button, [role="button"], a'));
                  const visible = (el) => {
                    const style = window.getComputedStyle(el);
                    const rect = el.getBoundingClientRect();
                    return style && style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
                  };
                  const target = nodes.find((el) => {
                    const text = String(el.innerText || el.textContent || '').replace(/\\s+/g, ' ').trim();
                    return visible(el) && /使用一次性验证码登录|使用一次性驗證碼登入|one-time code|one time code|passwordless/i.test(text);
                  });
                  if (!target) return false;
                  target.click();
                  return true;
                }
                """
            )
        )
    except Exception:
        clicked = False
    if clicked:
        log(f"{context} 已选择一次性验证码登录")
        time.sleep(1)
    return clicked


def _get_page_oauth_url(page) -> str:
    try:
        return str(
            page.evaluate(
                """
                () => {
                  const visible = (el) => {
                    const style = window.getComputedStyle(el);
                    const rect = el.getBoundingClientRect();
                    return style && style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
                  };
                  const anchors = Array.from(document.querySelectorAll('a[href*="/api/oauth/authorize"]'));
                  const anchor = anchors.find((el) => visible(el));
                  return anchor ? String(anchor.href || anchor.getAttribute('href') || '') : '';
                }
                """
            )
            or ""
        ).strip()
    except Exception:
        return ""


def _oauth_url_matches_state(url: str, state: str) -> bool:
    if not url or not state:
        return False
    return f"state={state}" in url or f"state%3D{state}" in url


def _extract_auth_error_text(page) -> str:
    selectors = [
        "text=Failed to create account",
        "text=Sorry, we cannot create your account",
        "text=Please try again",
        "text=Invalid code",
        "text=Enter a valid age to continue",
        "text=doesn't look right",
        "[role='alert']",
        ".error, [class*='error'], [class*='Error']",
    ]
    for selector in selectors:
        try:
            text = str(page.locator(selector).first.text_content(timeout=350) or "").strip()
        except Exception:
            text = ""
        if text and "oai_log" not in text and "SSR_HTML" not in text:
            return text
    return ""


def _fill_input_like_user(page, selector: str, value: str, log=None) -> bool:
    try:
        locator = page.locator(selector).first
        locator.wait_for(state="visible", timeout=2000)
        current = str(locator.input_value() or "").strip()
        if current == str(value).strip():
            return True
        locator.click(timeout=1500)
        _browser_pause(page)
        try:
            locator.fill("")
        except Exception:
            pass
        _browser_pause(page, headed=False)
        try:
            locator.type(value, delay=random.randint(35, 85))
        except Exception as exc:
            if log:
                log(f"输入控件键入失败: {type(exc).__name__}: {str(exc).split(chr(10), 1)[0][:160]}")
            try:
                page.fill(selector, value)
            except Exception as exc:
                if log:
                    log(f"输入控件填入失败: {type(exc).__name__}: {str(exc).split(chr(10), 1)[0][:160]}")
                return False
        final_value = str(locator.input_value() or "").strip()
        if final_value == str(value):
            return True
        if log:
            log(f"输入控件值未保持: actual_length={len(final_value)} expected_length={len(str(value))}")
    except Exception as exc:
        if log:
            log(f"输入控件操作失败: {type(exc).__name__}: {str(exc).split(chr(10), 1)[0][:160]}")

    try:
        ok = page.locator(selector).first.evaluate(
            """
            (input, value) => {
              if (!input) return false;
              const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
              if (!setter) return false;
              setter.call(input, value);
              input.dispatchEvent(new Event('input', { bubbles: true }));
              input.dispatchEvent(new Event('change', { bubbles: true }));
              return String(input.value || '') === String(value || '');
            }
            """,
            value,
        )
        return bool(ok)
    except Exception:
        return False


def _submit_form_with_fallback(page, input_selector: str) -> bool:
    try:
        return bool(
            page.locator(input_selector).first.evaluate(
                """
                async (input) => {
                  if (!input) return false;
                  document.activeElement?.blur?.();
                  await Promise.resolve();
                  const form = input.form || input.closest?.('form');
                  const submitters = Array.from(form?.elements || []).filter((el) =>
                    (el.tagName === 'BUTTON' || el.tagName === 'INPUT') && el.type === 'submit');
                  const submitter = submitters.find((el) => !/resend/i.test(`${el.value || ''} ${el.textContent || ''}`));
                  if ((submitters.length && !submitter) || submitter?.disabled) return false;
                  if (submitter) {
                    submitter.click();
                    return true;
                  }
                  if (form?.requestSubmit) {
                    form.requestSubmit(submitter);
                    return true;
                  }
                  if (form?.submit) {
                    form.submit();
                    return true;
                  }
                  input.focus?.();
                  for (const type of ['keydown', 'keypress', 'keyup']) {
                    input.dispatchEvent(new KeyboardEvent(type, {
                      key: 'Enter',
                      code: 'Enter',
                      bubbles: true,
                      cancelable: true,
                    }));
                  }
                  return true;
                }
                """,
            )
        )
    except Exception:
        return False


def _sync_hidden_birthday_input(page, birthdate: str, log) -> bool:
    try:
        synced = bool(
            page.evaluate(
                """
                (value) => {
                  const input = document.querySelector("input[name='birthday']");
                  if (!input) return false;
                  input.value = value;
                  input.dispatchEvent(new Event('input', { bubbles: true }));
                  input.dispatchEvent(new Event('change', { bubbles: true }));
                  return String(input.value || '') === String(value || '');
                }
                """,
                birthdate,
            )
        )
    except Exception:
        synced = False
    if synced:
        log(f"about_you 已同步隐藏 birthday: {birthdate}")
    return synced


def _collect_visible_text_inputs(page) -> list[dict]:
    try:
        inputs = page.evaluate(
            """
            () => {
              const normalize = (value) => String(value || '').replace(/\\s+/g, ' ').trim();
              const nodes = Array.from(document.querySelectorAll("input:not([type='hidden']):not([disabled]):not([readonly])"));
              const visible = nodes.filter((el) => {
                const style = window.getComputedStyle(el);
                const rect = el.getBoundingClientRect();
                return style
                  && style.display !== 'none'
                  && style.visibility !== 'hidden'
                  && rect.width > 0
                  && rect.height > 0;
              });
              return visible.map((el, visibleIndex) => {
                const explicitLabels = Array.from(document.querySelectorAll('label'))
                  .filter((label) => String(label.getAttribute('for') || '') === String(el.id || ''))
                  .map((label) => normalize(label.textContent));
                const wrappedLabel = normalize(el.closest('label')?.textContent || '');
                const ariaLabel = normalize(el.getAttribute('aria-label'));
                const labelledByText = normalize(
                  String(el.getAttribute('aria-labelledby') || '')
                    .split(/\\s+/)
                    .filter(Boolean)
                    .map((id) => normalize(document.getElementById(id)?.textContent || ''))
                    .join(' ')
                );
                const parentText = normalize(el.parentElement?.textContent || '');
                return {
                  visibleIndex,
                  type: normalize(el.getAttribute('type') || el.type || ''),
                  name: normalize(el.getAttribute('name') || ''),
                  id: normalize(el.id || ''),
                  placeholder: normalize(el.getAttribute('placeholder') || ''),
                  ariaLabel,
                  labels: explicitLabels.filter(Boolean),
                  wrappedLabel,
                  labelledByText,
                  parentText,
                };
              });
            }
            """
        ) or []
    except Exception:
        inputs = []
    return [item for item in inputs if isinstance(item, dict)]


def _about_you_input_hints(entry: dict) -> str:
    parts: list[str] = []
    labels = entry.get("labels") or []
    if isinstance(labels, list):
        parts.extend(str(item or "") for item in labels)
    parts.extend(
        [
            str(entry.get("wrappedLabel") or ""),
            str(entry.get("labelledByText") or ""),
            str(entry.get("ariaLabel") or ""),
            str(entry.get("placeholder") or ""),
            str(entry.get("name") or ""),
            str(entry.get("id") or ""),
            str(entry.get("parentText") or ""),
        ]
    )
    return " ".join(part for part in parts if part).strip().lower()


def _pick_best_about_you_input(entries: list[dict], field: str, exclude_visible_indices: set[int] | None = None) -> dict | None:
    exclude = {int(value) for value in (exclude_visible_indices or set())}
    best_entry = None
    best_score = float("-inf")
    for entry in entries:
        try:
            visible_index = int(entry.get("visibleIndex"))
        except Exception:
            continue
        if visible_index in exclude:
            continue
        hints = _about_you_input_hints(entry)
        if not hints:
            continue

        score = 0
        if field == "name":
            if any(token in hints for token in ("full name", "fullname", "全名", "姓名", "nombre completo", "nom complet", "vollständiger name", "nome completo")):
                score += 10
            if any(token in hints for token in (" name ", "name", "autocomplete=name", "nombre", "nom", "nome")):
                score += 3
            if any(token in hints for token in ("age", "年龄", "edad", "âge", "alter", "idade", "birthday", "birth", "date of birth", "出生", "生日")):
                score -= 8
        elif field == "age":
            if any(token in hints for token in ("age", "年龄", "how old", "edad", "âge", "alter", "idade", "나이")):
                score += 10
            if any(token in hints for token in ("full name", "fullname", "全名", "姓名", "nombre completo", "nom complet")):
                score -= 10
            if "name" in hints and "age" not in hints and "年龄" not in hints and "edad" not in hints:
                score -= 6
            if any(token in hints for token in ("birthday", "birth", "date of birth", "出生", "生日", "fecha de nacimiento", "nascimento")):
                score -= 3
        else:
            continue

        if score > best_score:
            best_score = score
            best_entry = entry

    if best_score > 0:
        return best_entry

    if field == "age" and len(entries) == 2:
        ordered = []
        for entry in entries:
            try:
                visible_index = int(entry.get("visibleIndex"))
            except Exception:
                continue
            if visible_index not in exclude:
                ordered.append(entry)
        if len(ordered) == 1:
            return ordered[0]
        if len(ordered) == 2:
            return ordered[1]
    return None


def _derive_registration_state_from_page(page) -> dict:
    current_url = str(page.url or "")
    state = _extract_flow_state(None, current_url)
    if state.get("page_type"):
        return state

    if _find_first_selector(page, PASSWORD_INPUT_SELECTORS):
        page_type = "login_password" if _is_login_password_url(current_url) else "create_account_password"
        return _build_manual_flow_state(page_type, current_url)

    otp_selector = _find_first_selector(page, OTP_INPUT_SELECTORS)
    if otp_selector and "password" not in otp_selector:
        return _build_manual_flow_state("email_otp_verification", current_url)

    try:
        about_visible = bool(
            page.evaluate(
                """
                () => {
                  const inputs = Array.from(document.querySelectorAll("input:not([type='hidden'])"));
                  const text = String(document.body?.innerText || '').toLowerCase();
                  const hasName = inputs.some((el) => {
                    const hint = `${el.name || ''} ${el.id || ''} ${el.placeholder || ''}`.toLowerCase();
                    return hint.includes('name') || hint.includes('姓名') || hint.includes('全名');
                  });
                  const hasAgeOrBirth = inputs.some((el) => {
                    const hint = `${el.name || ''} ${el.id || ''} ${el.placeholder || ''}`.toLowerCase();
                    return hint.includes('age') || hint.includes('birth') || hint.includes('birthday') || hint.includes('年龄') || hint.includes('生日');
                  });
                  return (hasName && hasAgeOrBirth) || text.includes('about you');
                }
                """
            )
        )
    except Exception:
        about_visible = False
    if about_visible:
        return _build_manual_flow_state("about_you", current_url)

    return state


def _recover_signup_password_page(page, log) -> bool:
    if not _is_login_password_url(str(page.url or "")):
        return False
    if not _has_signup_registration_choice(page):
        return False
    selector = _click_first(page, SIGNUP_RECOVERY_SELECTORS, timeout=2)
    if not selector:
        return False
    log(f"密码页落到登录态，尝试点击注册入口恢复: {selector}")
    time.sleep(1.2)
    return True


def _wait_for_signup_entry_transition(page, log, timeout: int = 20) -> dict:
    deadline = time.time() + timeout
    while time.time() < deadline:
        if _click_passwordless_login_if_available(page, log, context="邮箱页提交后"):
            time.sleep(0.5)
            continue
        state = _derive_registration_state_from_page(page)
        if state.get("page_type") in {
            "create_account_password",
            "login_password",
            "email_otp_verification",
            "about_you",
            "add_phone",
            "chatgpt_home",
            "oauth_callback",
        }:
            if state.get("page_type") == "login_password" and _recover_signup_password_page(page, log):
                return _derive_registration_state_from_page(page)
            return state
        error_text = _extract_auth_error_text(page)
        if error_text:
            raise RuntimeError(f"邮箱页提交失败: {error_text[:300]}")
        time.sleep(0.25)
    raise RuntimeError("邮箱页提交后未进入密码/验证码页面")


def _start_browser_signup_via_page(page, email: str, log) -> dict:
    for entry_url in (PLATFORM_LOGIN_ENTRY, f"{OPENAI_AUTH}/log-in"):
        try:
            log(f"打开 OpenAI 注册入口: {entry_url}")
            _navigate(page, entry_url, wait_until="domcontentloaded", timeout=30000)
        except Exception as exc:
            log(f"注册入口访问失败: {entry_url} -> {exc}")
            continue

        _wait_for_openai_browser_check(page, log)
        initial_state = _derive_registration_state_from_page(page)
        if initial_state.get("page_type") in {
            "create_account_password",
            "login_password",
            "email_otp_verification",
            "about_you",
            "add_phone",
        }:
            return initial_state

        email_selector = _wait_for_any_selector(page, EMAIL_INPUT_SELECTORS, timeout=12)
        if not email_selector:
            continue
        if not _fill_input_like_user(page, email_selector, email, log):
            failed_state = _derive_registration_state_from_page(page)
            raise RuntimeError(f"邮箱页填写失败: selector={email_selector} page={failed_state.get('page_type') or '-'} path={urlparse(str(page.url or '')).path}")
        log(f"邮箱页输入框: {email_selector}")

        inline_state = _derive_registration_state_from_page(page)
        if inline_state.get("page_type") in {"create_account_password", "login_password"}:
            if inline_state.get("page_type") == "login_password" and _recover_signup_password_page(page, log):
                return _derive_registration_state_from_page(page)
            return inline_state

        submit_selector = _click_first(page, EMAIL_SUBMIT_SELECTORS, timeout=8)
        if submit_selector:
            log(f"邮箱页已点击继续按钮: {submit_selector}")
        elif _submit_form_with_fallback(page, email_selector):
            log("邮箱页未找到可点击 Continue，已使用表单 fallback 提交")
        else:
            raise RuntimeError("邮箱页未找到 Continue 按钮")

        return _wait_for_signup_entry_transition(page, log)

    raise RuntimeError("未找到 OpenAI 注册入口邮箱输入框")


def _start_browser_signup_via_authorize(page, email: str, device_id: str, log) -> dict:
    log("访问 ChatGPT 首页...")
    _navigate(page, f"{CHATGPT_APP}/", wait_until="domcontentloaded", timeout=30000)

    _wait_for_openai_browser_check(page, log)
    log("获取 CSRF token...")
    csrf_token = _get_browser_csrf_token(page)
    if not csrf_token:
        raise RuntimeError("获取 CSRF token 失败")

    log(f"提交邮箱: {email}")
    authorize_url = _start_browser_signin(page, email, device_id, csrf_token)
    if not authorize_url:
        raise RuntimeError("提交邮箱失败，未获取 authorize URL")

    final_url = _browser_authorize(page, authorize_url, log)
    if not final_url:
        raise RuntimeError("访问 authorize URL 失败")
    _wait_for_openai_browser_check(page, log)
    return _derive_registration_state_from_page(page)


def _dump_debug(page, prefix: str) -> None:
    Path(f"aiTemp/{prefix}").parent.mkdir(parents=True, exist_ok=True)
    page.screenshot(path=f"aiTemp/{prefix}.png")
    with open(f"aiTemp/{prefix}.html", "w", encoding="utf-8") as f:
        f.write(page.content())


def _get_cookies(page) -> dict:
    cookies = {}
    for cookie in page.context.cookies():
        domain = str(cookie.get("domain") or "").lstrip(".").casefold()
        if domain in {"auth.openai.com", "chatgpt.com", "chat.openai.com", "openai.com"}:
            cookies[cookie["name"]] = cookie["value"]
    return cookies


def _random_chrome_ua() -> str:
    patch = random.randint(0, 220)
    return (
        f"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
        f"(KHTML, like Gecko) Chrome/136.0.7103.{patch} Safari/537.36"
    )


def _infer_sec_ch_ua(user_agent: str) -> str:
    match = re.search(r"Chrome/(\d+)", str(user_agent or ""))
    major = str(match.group(1) if match else "136")
    return f'"Chromium";v="{major}", "Google Chrome";v="{major}", "Not.A/Brand";v="99"'


def _build_browser_headers(
    *,
    user_agent: str,
    accept: str,
    referer: str = "",
    origin: str = "",
    content_type: str = "",
    navigation: bool = False,
    extra_headers: dict | None = None,
) -> dict:
    headers = {
        "user-agent": user_agent or _random_chrome_ua(),
        "accept-language": "en-US,en;q=0.9",
        "sec-ch-ua": _infer_sec_ch_ua(user_agent),
        "sec-ch-ua-mobile": "?0",
        "sec-ch-ua-platform": '"Windows"',
        "accept": accept,
    }
    if referer:
        headers["referer"] = referer
    if origin:
        headers["origin"] = origin
    if content_type:
        headers["content-type"] = content_type
    if navigation:
        headers["sec-fetch-dest"] = "document"
        headers["sec-fetch-mode"] = "navigate"
        headers["sec-fetch-user"] = "?1"
        headers["upgrade-insecure-requests"] = "1"
    else:
        headers["sec-fetch-dest"] = "empty"
        headers["sec-fetch-mode"] = "cors"
    for key, value in dict(extra_headers or {}).items():
        if value is not None:
            headers[key] = value
    return headers


def _browser_pause(page, *, headed: bool = True):
    delay_ms = random.randint(150, 450) if headed else random.randint(60, 180)
    try:
        page.wait_for_timeout(delay_ms)
    except Exception:
        time.sleep(delay_ms / 1000)


def _generate_datadog_trace_headers() -> dict:
    trace_hex = secrets.token_hex(8).rjust(16, "0")
    parent_hex = secrets.token_hex(8).rjust(16, "0")
    trace_id = str(int(trace_hex, 16))
    parent_id = str(int(parent_hex, 16))
    return {
        "traceparent": f"00-0000000000000000{trace_hex}-{parent_hex}-01",
        "tracestate": "dd=s:1;o:rum",
        "x-datadog-origin": "rum",
        "x-datadog-parent-id": parent_id,
        "x-datadog-sampling-priority": "1",
        "x-datadog-trace-id": trace_id,
    }


def _infer_page_type(data: dict | None, current_url: str = "") -> str:
    raw = data if isinstance(data, dict) else {}
    page_type = str(((raw.get("page") or {}).get("type")) or "").strip().lower().replace("-", "_").replace("/", "_").replace(" ", "_")
    if page_type:
        return page_type
    url = (current_url or "").lower()
    if "code=" in url:
        return "oauth_callback"
    if "create-account/password" in url:
        return "create_account_password"
    if "email-verification" in url or "email-otp" in url:
        return "email_otp_verification"
    if "about-you" in url:
        return "about_you"
    if "log-in/password" in url:
        return "login_password"
    if "sign-in-with-chatgpt" in url and "consent" in url:
        return "consent"
    if "workspace" in url and "select" in url:
        return "workspace_selection"
    if "organization" in url and "select" in url:
        return "organization_selection"
    if "add-phone" in url:
        return "add_phone"
    if "/api/oauth/oauth2/auth" in url:
        return "external_url"
    if urlparse(url).hostname == "chatgpt.com":
        return "chatgpt_home"
    return ""


def _extract_flow_state(data: dict | None, current_url: str = "") -> dict:
    raw = data if isinstance(data, dict) else {}
    page = raw.get("page") or {}
    payload = page.get("payload") or {}
    continue_url = str(raw.get("continue_url") or payload.get("url") or "").strip()
    if continue_url and continue_url.startswith("/"):
        continue_url = urljoin(OPENAI_AUTH, continue_url)
    effective_url = continue_url or current_url
    return {
        "page_type": _infer_page_type(raw, effective_url),
        "continue_url": continue_url,
        "method": str(raw.get("method") or payload.get("method") or "GET").upper(),
        "current_url": effective_url,
        "payload": payload if isinstance(payload, dict) else {},
        "raw": raw,
    }


def _extract_code_from_url(url: str) -> str:
    if not url or "code=" not in url:
        return ""
    try:
        from urllib.parse import parse_qs, urlparse as _up

        parsed = _up(url)
        values = parse_qs(parsed.query, keep_blank_values=True)
        return str((values.get("code") or [""])[0] or "").strip()
    except Exception:
        return ""


def _normalize_url(target_url: str, base_url: str = OPENAI_AUTH) -> str:
    value = str(target_url or "").strip()
    if not value:
        return ""
    if value.startswith(("http://", "https://")):
        return value
    try:
        return urljoin(base_url, value)
    except Exception:
        return value


def _decode_jwt_payload(token: str) -> dict:
    try:
        parts = token.split(".")
        if len(parts) < 2:
            return {}
        payload = parts[1]
        pad = "=" * ((4 - (len(payload) % 4)) % 4)
        return json.loads(base64.urlsafe_b64decode((payload + pad).encode("ascii")).decode("utf-8"))
    except Exception:
        return {}


class _SentinelTokenGenerator:
    def __init__(self, device_id: str, user_agent: str):
        self.device_id = device_id or str(uuid.uuid4())
        self.user_agent = user_agent or _random_chrome_ua()
        self.sid = str(uuid.uuid4())

    @staticmethod
    def _fnv1a32(text: str) -> str:
        h = 2166136261
        for ch in text:
            h ^= ord(ch)
            h = (h * 16777619) & 0xFFFFFFFF
        h ^= (h >> 16)
        h = (h * 2246822507) & 0xFFFFFFFF
        h ^= (h >> 13)
        h = (h * 3266489909) & 0xFFFFFFFF
        h ^= (h >> 16)
        return f"{h & 0xFFFFFFFF:08x}"

    @staticmethod
    def _b64(data) -> str:
        return base64.b64encode(json.dumps(data, separators=(",", ":")).encode("utf-8")).decode("ascii")

    def _config(self) -> list:
        perf_now = 1000 + random.random() * 49000
        return [
            "1920x1080",
            time.strftime("%a, %d %b %Y %H:%M:%S GMT+0000 (Coordinated Universal Time)", time.gmtime()),
            4294705152,
            random.random(),
            self.user_agent,
            SENTINEL_SDK_URL,
            None,
            None,
            "en-US",
            "en-US,en",
            random.random(),
            "webkitTemporaryStorage−undefined",
            "location",
            "Object",
            perf_now,
            self.sid,
            "",
            random.choice([4, 8, 12, 16]),
            int(time.time() * 1000 - perf_now),
        ]

    def generate_requirements_token(self) -> str:
        cfg = self._config()
        cfg[3] = 1
        cfg[9] = round(5 + random.random() * 45)
        return "gAAAAAC" + self._b64(cfg)

    def generate_token(self, seed: str, difficulty: str) -> str:
        max_attempts = 500000
        cfg = self._config()
        start_ms = int(time.time() * 1000)
        diff = str(difficulty or "0")
        for nonce in range(max_attempts):
            cfg[3] = nonce
            cfg[9] = round(int(time.time() * 1000) - start_ms)
            encoded = self._b64(cfg)
            digest = self._fnv1a32((seed or "") + encoded)
            if digest[: len(diff)] <= diff:
                return "gAAAAAB" + encoded + "~S"
        return "gAAAAAB" + self._b64(None)


def _browser_fetch(page, url: str, *, method: str = "GET", headers: dict | None = None, body: str | None = None, redirect: str = "manual", timeout_ms: int = 30000) -> dict:
    return page.evaluate(
        """
        async ({ url, method, headers, body, redirect, timeoutMs }) => {
          const controller = new AbortController();
          const timer = setTimeout(() => controller.abort(new Error(`fetch timeout after ${timeoutMs}ms`)), timeoutMs);
          try {
            const resp = await fetch(url, {
              method,
              headers: headers || {},
              body: body === null ? undefined : body,
              redirect,
              signal: controller.signal,
            });
            const respHeaders = {};
            resp.headers.forEach((v, k) => { respHeaders[k] = v; });
            let text = '';
            try { text = await resp.text(); } catch {}
            let data = null;
            try { data = JSON.parse(text); } catch {}
            return { ok: resp.ok, status: resp.status, url: resp.url || url, headers: respHeaders, text, data };
          } catch (e) {
            return { ok: false, status: 0, url, headers: {}, text: String(e && e.message || e), data: null };
          } finally {
            clearTimeout(timer);
          }
        }
        """,
        {
            "url": url,
            "method": method,
            "headers": headers or {},
            "body": body,
            "redirect": redirect,
            "timeoutMs": timeout_ms,
        },
    )


def _build_browser_sentinel_token(page, device_id: str, flow: str, user_agent: str) -> str:
    generator = _SentinelTokenGenerator(device_id, user_agent)
    req_body = json.dumps(
        {"p": generator.generate_requirements_token(), "id": device_id, "flow": flow},
        separators=(",", ":"),
    )
    result = _browser_fetch(
        page,
        SENTINEL_REQ_URL,
        method="POST",
        headers=_build_browser_headers(
            user_agent=user_agent,
            accept="*/*",
            referer=SENTINEL_FRAME_URL,
            origin=SENTINEL_BASE,
            content_type="text/plain;charset=UTF-8",
            extra_headers={
                "sec-fetch-site": "same-origin",
            },
        ),
        body=req_body,
        redirect="follow",
    )
    data = result.get("data") or {}
    challenge_token = str(data.get("token") or "").strip()
    if not challenge_token:
        return ""
    pow_meta = data.get("proofofwork") or {}
    if pow_meta.get("required") and pow_meta.get("seed"):
        p_value = generator.generate_token(str(pow_meta.get("seed") or ""), str(pow_meta.get("difficulty") or "0"))
    else:
        p_value = generator.generate_requirements_token()
    return json.dumps(
        {
            "p": p_value,
            "t": "",
            "c": challenge_token,
            "id": device_id,
            "flow": flow,
        },
        separators=(",", ":"),
    )


def _submit_browser_user_register(page, email: str, password: str, device_id: str, user_agent: str) -> dict:
    headers = _build_browser_headers(
        user_agent=user_agent,
        accept="application/json",
        referer=f"{OPENAI_AUTH}/create-account/password",
        origin=OPENAI_AUTH,
        content_type="application/json",
        extra_headers={
            "sec-fetch-site": "same-origin",
            "oai-device-id": device_id,
            **_generate_datadog_trace_headers(),
        },
    )
    sentinel = _build_browser_sentinel_token(page, device_id, "username_password_create", user_agent)
    if sentinel:
        headers["openai-sentinel-token"] = sentinel
    _browser_pause(page)
    return _browser_fetch(
        page,
        f"{OPENAI_AUTH}/api/accounts/user/register",
        method="POST",
        headers=headers,
        body=json.dumps({"username": email, "password": password}),
        redirect="follow",
    )


def _send_browser_email_otp(page) -> dict:
    _browser_pause(page)
    return _browser_fetch(
        page,
        f"{OPENAI_AUTH}/api/accounts/email-otp/send",
        method="GET",
        headers={
            "accept": "application/json, text/plain, */*",
            "referer": f"{OPENAI_AUTH}/create-account/password",
            "sec-fetch-site": "same-origin",
            "sec-fetch-mode": "cors",
            "sec-fetch-dest": "empty",
            "accept-language": "en-US,en;q=0.9",
        },
        redirect="follow",
    )


def _decode_oauth_session_cookie(cookies_dict: dict) -> dict:
    raw = str(cookies_dict.get("oai-client-auth-session") or "").strip()
    if not raw:
        return {}
    first = raw.split(".")[0]
    for decoder in (base64.urlsafe_b64decode, base64.b64decode):
        try:
            pad = "=" * ((4 - (len(first) % 4)) % 4)
            decoded = decoder((first + pad).encode("ascii")).decode("utf-8")
            parsed = json.loads(decoded)
            if isinstance(parsed, dict):
                return parsed
        except Exception:
            continue
    return {}


def _extract_workspace_from_consent_html(session, consent_url: str) -> dict:
    try:
        response = session.get(consent_url, allow_redirects=True, timeout=30)
        html = response.text or ""
        if "workspaces" not in html:
            return {}
        ids = re.findall(r'"id"(?:,|:)"([0-9a-f-]{36})"', html, flags=re.I)
        kinds = re.findall(r'"kind"(?:,|:)"([^"]+)"', html, flags=re.I)
        if not ids:
            return {}
        seen: set[str] = set()
        workspaces: list[dict] = []
        for idx, workspace_id in enumerate(ids):
            if workspace_id in seen:
                continue
            seen.add(workspace_id)
            item = {"id": workspace_id}
            if idx < len(kinds):
                item["kind"] = kinds[idx]
            workspaces.append(item)
        return {"workspaces": workspaces} if workspaces else {}
    except Exception:
        return {}


def _seed_session_cookies(session, cookies_dict: dict):
    for name, value in cookies_dict.items():
        for domain in [".openai.com", ".chatgpt.com", ".auth.openai.com", "auth.openai.com", "chatgpt.com"]:
            try:
                session.cookies.set(name, value, domain=domain, path="/")
            except Exception:
                pass


def _follow_redirects_for_code(session, start_url: str, log, *, max_redirects: int = 12) -> str:
    current_url = start_url
    for idx in range(max_redirects):
        response = session.get(current_url, allow_redirects=False, timeout=30)
        log(f"  redirect-follow[{idx+1}] {response.status_code} {str(current_url)[:140]}")
        location = str(response.headers.get("Location") or "").strip()
        if not location:
            break
        next_url = urljoin(current_url, location)
        code = _extract_code_from_url(next_url)
        if code:
            return next_url
        if response.status_code not in (301, 302, 303, 307, 308):
            break
        current_url = next_url
    return ""


def _complete_oauth_with_session(cookies_dict: dict, oauth_start, proxy: str | None, log) -> dict | None:
    from .oauth import submit_callback_url
    from curl_cffi import requests as cffi_requests

    s = cffi_requests.Session(impersonate="chrome131")
    if proxy:
        s.proxies = {"http": proxy, "https": proxy}
    _seed_session_cookies(s, cookies_dict)

    try:
        session_meta = _decode_oauth_session_cookie(cookies_dict)
        consent_url = "https://auth.openai.com/sign-in-with-chatgpt/codex/consent"
        workspaces = list(session_meta.get("workspaces") or [])
        if not workspaces:
            session_meta = _extract_workspace_from_consent_html(s, consent_url)
            workspaces = list(session_meta.get("workspaces") or [])
        if not workspaces:
            log("  ⚠️ 缺少 oai-client-auth-session workspaces，OAuth 失败")
            return None
        workspace_id = str((workspaces[0] or {}).get("id") or "").strip()
        log(f"  选择 workspace: {workspace_id}")
        ws_resp = s.post(
            "https://auth.openai.com/api/accounts/workspace/select",
            headers={
                "accept": "application/json",
                "referer": consent_url,
                "origin": OPENAI_AUTH,
                "content-type": "application/json",
                "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36",
            },
            data=json.dumps({"workspace_id": workspace_id}),
            allow_redirects=False,
            timeout=30,
        )
        log(f"  workspace/select -> {ws_resp.status_code}")

        next_url = str(ws_resp.headers.get("Location") or "").strip()
        next_data = {}
        if not next_url:
            try:
                next_data = ws_resp.json() or {}
            except Exception:
                next_data = {}
            next_url = str(next_data.get("continue_url") or "").strip()
        next_url = _normalize_url(next_url, consent_url)
        direct_code = _extract_code_from_url(next_url)
        if direct_code:
            result_json = submit_callback_url(
                callback_url=next_url,
                expected_state=oauth_start.state,
                code_verifier=oauth_start.code_verifier,
                proxy_url=proxy,
            )
            return json.loads(result_json)

        orgs = list((((next_data.get("data") or {}).get("orgs")) or []))
        if orgs and orgs[0].get("id"):
            org_id = str(orgs[0].get("id") or "").strip()
            org_body = {"org_id": org_id}
            projects = list(orgs[0].get("projects") or [])
            if projects and projects[0].get("id"):
                org_body["project_id"] = str(projects[0].get("id") or "").strip()
            log(f"  选择 organization: {org_id}")
            org_resp = s.post(
                "https://auth.openai.com/api/accounts/organization/select",
                headers={
                    "accept": "application/json",
                    "referer": consent_url,
                    "origin": OPENAI_AUTH,
                    "content-type": "application/json",
                    "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36",
                },
                data=json.dumps(org_body),
                allow_redirects=False,
                timeout=30,
            )
            log(f"  organization/select -> {org_resp.status_code}")
            next_url = str(org_resp.headers.get("Location") or "").strip() or next_url
            if not next_url:
                try:
                    org_data = org_resp.json() or {}
                    next_url = str(org_data.get("continue_url") or "").strip()
                    if not next_url:
                        org_state = _extract_flow_state(org_data, str(org_resp.url))
                        next_url = org_state.get("continue_url") or org_state.get("current_url") or ""
                except Exception:
                    next_url = ""
            next_url = _normalize_url(next_url, consent_url)

        if not next_url and next_data:
            state = _extract_flow_state(next_data, str(ws_resp.url))
            next_url = state.get("continue_url") or state.get("current_url") or ""
            next_url = _normalize_url(next_url, consent_url)

        if not next_url:
            next_url = "https://auth.openai.com/api/oauth/oauth2/auth?" + oauth_start.auth_url.split("?", 1)[1]

        callback_url = _follow_redirects_for_code(s, next_url, log)
        if not callback_url:
            log("  ⚠️ 未能跟到 OAuth callback")
            return None
        result_json = submit_callback_url(
            callback_url=callback_url,
            expected_state=oauth_start.state,
            code_verifier=oauth_start.code_verifier,
            proxy_url=proxy,
        )
        return json.loads(result_json)
    except Exception as e:
        log(f"  OAuth 会话补全异常: {e}")
        return None


def _submit_callback_result(callback_url: str, oauth_start, proxy: str | None) -> dict:
    from .oauth import submit_callback_url

    result_json = submit_callback_url(
        callback_url=callback_url,
        expected_state=oauth_start.state,
        code_verifier=oauth_start.code_verifier,
        redirect_uri=oauth_start.redirect_uri,
        client_id=oauth_start.client_id,
        proxy_url=proxy,
    )
    return json.loads(result_json)


def _extract_callback_url_from_exception(exc: Exception) -> str:
    text = str(exc or "")
    if not text:
        return ""
    match = re.search(r"(https?://localhost[^\s\"')]+)", text, flags=re.I)
    if not match:
        return ""
    callback_url = str(match.group(1) or "").strip().rstrip(".,")
    return callback_url if _extract_code_from_url(callback_url) else ""


def _derive_oauth_state_from_page(page) -> dict:
    if urlparse(str(page.url or "")).path == "/choose-an-account":
        return _build_manual_flow_state("account_selection", str(page.url or ""))
    state = _derive_registration_state_from_page(page)
    if state.get("page_type"):
        return state
    current_url = str(page.url or "")
    if _find_first_selector(page, EMAIL_INPUT_SELECTORS):
        return _build_manual_flow_state("login_email", current_url)
    return _extract_flow_state(None, current_url)


def _submit_login_email_via_page(page, email: str, log) -> dict:
    input_selector = _wait_for_any_selector(page, EMAIL_INPUT_SELECTORS, timeout=15)
    if not input_selector:
        raise RuntimeError("OAuth 邮箱页未找到输入框")
    if not _fill_input_like_user(page, input_selector, email):
        raise RuntimeError("OAuth 邮箱页填写失败")
    log(f"OAuth 邮箱页输入框: {input_selector}")
    _browser_pause(page)

    start_url = str(page.url or "")
    submit_selector = _click_first(page, EMAIL_SUBMIT_SELECTORS, timeout=8)
    if submit_selector:
        log(f"OAuth 邮箱页已点击继续按钮: {submit_selector}")
    elif _submit_form_with_fallback(page, input_selector):
        log("OAuth 邮箱页未找到可点击 Continue，已使用表单 fallback 提交")
    else:
        raise RuntimeError("OAuth 邮箱页未找到 Continue 按钮")

    deadline = time.time() + 600
    last_url = start_url
    while time.time() < deadline:
        current_url = str(page.url or "")
        last_url = current_url or last_url
        if _click_passwordless_login_if_available(page, log, context="OAuth 邮箱页提交后"):
            time.sleep(0.5)
            continue
        state = _derive_oauth_state_from_page(page)
        page_type = str(state.get("page_type") or "")
        if page_type in {
            "login_password",
            "create_account_password",
            "email_otp_verification",
            "about_you",
            "consent",
            "workspace_selection",
            "organization_selection",
            "add_phone",
            "external_url",
            "oauth_callback",
            "chatgpt_home",
        }:
            return {"ok": True, "status": 200, "url": current_url, "data": None, "text": ""}
        if current_url != start_url and page_type != "login_email":
            return {"ok": True, "status": 200, "url": current_url, "data": None, "text": ""}
        error_text = _extract_auth_error_text(page)
        if error_text:
            return {"ok": False, "status": 400, "url": current_url, "data": None, "text": error_text}
        time.sleep(0.5)
    _dump_debug(page, "chatgpt_oauth_email_stuck")
    return {"ok": False, "status": 0, "url": last_url, "data": None, "text": "OAuth 邮箱页提交后未跳转"}


def _is_openai_browser_check(page) -> bool:
    if urlparse(str(page.url or "")).hostname not in {"auth.openai.com", "accounts.openai.com", "chatgpt.com"}:
        return False
    try:
        if page.evaluate("""
            () => Boolean(
              document.querySelector('#challenge-form, #challenge-running, #cf-challenge-running') ||
              Array.from(document.scripts).some(script => script.textContent.includes('window._cf_chl_opt'))
            )
        """) is True:
            return True
    except Exception:
        pass
    try:
        return str(page.title() or "").strip().lower().startswith(("just a moment", "un momento"))
    except Exception:
        return False


def _task_cancel_requested(log):
    logger = log
    for _ in range(3):
        owner = getattr(logger, "__self__", None)
        check = getattr(owner, "is_cancel_requested", None)
        if callable(check):
            return bool(check())
        for cell in getattr(logger, "__closure__", ()) or ():
            try:
                wrapped = cell.cell_contents
            except ValueError:
                continue
            if callable(wrapped):
                check = getattr(getattr(wrapped, "__self__", None), "is_cancel_requested", None)
                if callable(check):
                    return bool(check())
        logger = getattr(owner, "_log_fn", None) or getattr(owner, "log_fn", None)
    return False

def _wait_for_openai_browser_check(page, log, *, timeout: float = 300) -> None:
    if _task_cancel_requested(log):
        raise RuntimeError("registration_cancelled: 注册已取消")
    if not _is_openai_browser_check(page):
        return
    log("  OpenAI browser check is active; waiting up to 5 minutes")
    deadline = time.monotonic() + timeout
    while _is_openai_browser_check(page):
        if _task_cancel_requested(log):
            raise RuntimeError("registration_cancelled: 浏览器验证等待已取消")
        if time.monotonic() >= deadline:
            raise RuntimeError("OpenAI browser check did not clear")
        page.wait_for_timeout(2000)
    log("  OpenAI browser check cleared")


def _safe_browser_location(url: str) -> str:
    """Keep only the public origin/path in browser diagnostics."""
    try:
        parsed = urlparse(str(url or ""))
        path = re.sub(r"[A-Za-z0-9_-]{24,}|\d{5,}|[\w.+-]+@[\w.-]+", "[redacted]", parsed.path)
        host = parsed.hostname or ""
        port = f":{parsed.port}" if parsed.port else ""
        return f"{parsed.scheme}://{host}{port}{path}" if host else path
    except Exception:
        return "[unknown location]"


def _recover_oauth_selection_with_same_account_login(page, target, log) -> bool:
    """Use the site's offered login route once; the caller retains the exact email."""
    try:
        current = urlparse(str(page.url or ""))
        if current.scheme != "https" or current.hostname != "auth.openai.com" or current.path != "/choose-an-account":
            return False
        if _is_openai_browser_check(page) or _extract_auth_error_text(page):
            return False
        if target.count() != 1 or not target.is_enabled() or target.get_attribute("aria-busy") == "true":
            return False
        login = page.locator('a[href^="/log-in-or-create-account"]:visible')
        if login.count() != 1 or not login.is_enabled():
            return False
        href = str(login.get_attribute("href") or "")
        destination = urlparse(_normalize_url(href, str(page.url or "")))
        if (destination.scheme != "https" or destination.hostname != "auth.openai.com"
                or destination.path != "/log-in-or-create-account"):
            return False
        log("  OAuth session choice stalled; reopening normal login for the same account")
        login.click(timeout=15000)
        page.wait_for_url(
            lambda url: urlparse(str(url)).hostname == "auth.openai.com"
            and urlparse(str(url)).path == "/log-in-or-create-account",
            wait_until="commit", timeout=30000,
        )
        return True
    except Exception as exc:
        log("  OAuth same-account login recovery did not advance: " + type(exc).__name__)
        return False


def _log_oauth_selection_probe(page, target, log, phase: str, *, click_error: str = "") -> None:
    """Observe chooser state without logging identity, session IDs, or URL queries."""
    data = {"phase": phase}
    for key, read in (
        ("matches", lambda: target.count()),
        ("enabled", lambda: target.is_enabled()),
        ("aria_busy", lambda: target.get_attribute("aria-busy")),
    ):
        try:
            value = read()
            if key == "aria_busy":
                value = value if value in {"true", "false"} else None
            elif key == "matches":
                value = value if type(value) is int else None
            elif key == "enabled":
                value = value if type(value) is bool else None
            data[key] = value
        except Exception:
            data[key] = None
    try:
        ready = page.evaluate("document.readyState")
        data["ready_state"] = ready if ready in {"loading", "interactive", "complete"} else None
    except Exception:
        data["ready_state"] = None
    try:
        parsed = urlparse(str(page.url or ""))
        data["host"] = parsed.hostname
        data["path"] = re.sub(r"[A-Za-z0-9_-]{24,}", "[redacted]", parsed.path)
    except Exception:
        data["host"], data["path"] = None, None
    if click_error:
        data["click_error_type"] = click_error
    log("  OAuth selection probe: " + json.dumps(data, ensure_ascii=False))


def _do_codex_oauth(page, cookies_dict: dict, email: str, password: str, otp_callback, phone_callback, proxy: str | None, log, *, totp_secret: str = "", failure_context: dict | None = None, login_only: bool = False, totp_callback=None) -> dict | None:
    """在真实浏览器会话内完成 Codex OAuth，返回完整 token 包。"""
    from .oauth import generate_oauth_url
    from .constants import CODEX_CLIENT_ID, CODEX_REDIRECT_URI, CODEX_SCOPE

    oauth_start = generate_oauth_url(
        redirect_uri=CODEX_REDIRECT_URI,
        scope=CODEX_SCOPE,
        client_id=CODEX_CLIENT_ID,
    )
    user_agent = ""
    if not login_only:
        try:
            user_agent = str(page.evaluate("() => navigator.userAgent") or "").strip() or _random_chrome_ua()
        except Exception:
            user_agent = _random_chrome_ua()
    device_id = str(cookies_dict.get("oai-did") or uuid.uuid4())
    log("  OAuth flow started")
    same_account_login_recovered = False
    identity_recovery = (failure_context or {}).get("recovery_record_rebuilt_from_history")

    try:
        try:
            _navigate(page, oauth_start.auth_url, wait_until="domcontentloaded", timeout=30000)
        except Exception as exc:
            callback_url = _extract_callback_url_from_exception(exc)
            if callback_url:
                log("  OAuth bootstrap captured a callback")
                return _submit_callback_result(callback_url, oauth_start, proxy)
            raise

        current_url = str(page.url or "")
        log(f"  OAuth bootstrap -> {_safe_browser_location(current_url)}")
        _wait_for_openai_browser_check(page, log)

        for step in range(20):
            _wait_for_openai_browser_check(page, log)
            state = _derive_oauth_state_from_page(page)
            current_url = str(page.url or "")
            next_url = str(state.get("continue_url") or "").strip()
            log(
                f"  OAuth state step[{step+1}/20]: "
                f"page={state.get('page_type') or '-'} next={_safe_browser_location(next_url)}"
                f" url={_safe_browser_location(current_url)}"
            )

            callback_url = ""
            if _extract_code_from_url(current_url):
                callback_url = current_url
            elif _extract_code_from_url(next_url):
                callback_url = next_url
            if callback_url:
                return _submit_callback_result(callback_url, oauth_start, proxy)

            page_oauth_url = _get_page_oauth_url(page)
            if (
                page_oauth_url
                and page_oauth_url != current_url
                and _oauth_url_matches_state(page_oauth_url, oauth_start.state)
            ):
                log("  OAuth 页面检测到更新的授权链接，跟随页面授权链接...")
                _navigate(page, page_oauth_url, wait_until="domcontentloaded", timeout=30000)
                continue

            if identity_recovery and state["page_type"] in {"create_account_password", "about_you"}:
                raise RuntimeError("Original registration details are missing; manual completion is required.")

            if login_only and state["page_type"] in {"create_account_password", "about_you", "add_phone"}:
                raise RuntimeError("原账号需要完成注册或手机验证，请使用恢复注册操作")

            if state["page_type"] == "account_selection":
                target = page.locator('button[name="session_id"]:visible').filter(
                    has=page.get_by_text(email, exact=True)
                )
                target.first.wait_for(state="visible", timeout=15000)
                if target.count() != 1:
                    raise RuntimeError("OAuth 账号选择页未找到唯一匹配的目标邮箱")
                log("  OAuth 选择已登录目标账号")
                _log_oauth_selection_probe(page, target, log, "before_click")
                try:
                    if target.get_attribute("aria-busy") != "true":
                        target.click(timeout=15000)
                        _log_oauth_selection_probe(page, target, log, "click_returned")
                    else:
                        _log_oauth_selection_probe(page, target, log, "selection_in_flight")
                except Exception as exc:
                    _log_oauth_selection_probe(page, target, log, "click_failed", click_error=type(exc).__name__)
                    callback_url = _extract_callback_url_from_exception(exc)
                    if callback_url:
                        return _submit_callback_result(callback_url, oauth_start, proxy)
                try:
                    page.wait_for_url(
                        lambda url: (urlparse(str(url)).hostname, urlparse(str(url)).path)
                        != (urlparse(current_url).hostname, urlparse(current_url).path),
                        wait_until="commit", timeout=120000,
                    )
                except Exception:
                    _log_oauth_selection_probe(page, target, log, "navigation_stalled")
                    log(f"  OAuth account selection stalled: path={urlparse(str(page.url or '')).path}")
                    try:
                        _dump_debug(page, "chatgpt_account_selection_stalled_" + uuid.uuid4().hex)
                    except Exception as exc:
                        log("  OAuth selection diagnostic capture failed: " + type(exc).__name__)
                    if not same_account_login_recovered and _recover_oauth_selection_with_same_account_login(page, target, log):
                        same_account_login_recovered = True
                        continue
                    raise RuntimeError("OAuth account selection did not advance") from None
                _log_oauth_selection_probe(page, target, log, "navigation_observed")
                continue

            if "/mfa" in urlparse(current_url).path:
                if not totp_secret and not totp_callback:
                    raise RuntimeError("恢复登录需要已保存的认证器密钥")
                code = totp_code(totp_secret) if totp_secret else totp_callback()
                otp_resp = _submit_otp_via_page(page, code, log)
                if not otp_resp.get("ok"):
                    raise RuntimeError("认证器登录验证码被拒绝")
                continue

            if state["page_type"] == "login_email":
                log("  OAuth 页面需要邮箱登录，提交邮箱...")
                email_resp = _submit_login_email_via_page(page, email, log)
                log(f"  OAuth 邮箱页提交状态: {email_resp.get('status', 0)}")
                if not email_resp.get("ok"):
                    raise RuntimeError(f"OAuth 邮箱页提交失败: {(email_resp.get('text') or '')[:300]}")
                continue

            if (login_only or identity_recovery) and state["page_type"] == "login_password" and not password:
                if otp_callback and _click_passwordless_login_if_available(page, log, context="Token refresh"):
                    continue
                raise RuntimeError("原账号未保存密码，且无法使用邮箱验证码登录")

            if state["page_type"] in {"login_password", "create_account_password"}:
                log("  OAuth 页面需要密码登录，提交密码...")
                # OAuth 流程中直接填密码登录，不尝试恢复到注册态
                password_resp = _submit_oauth_password_direct(page, password, log)
                log(f"  OAuth 密码页提交状态: {password_resp.get('status', 0)}")
                if not password_resp.get("ok"):
                    raise RuntimeError(f"OAuth 密码页提交失败: {(password_resp.get('text') or '')[:300]}")
                continue

            if state["page_type"] == "email_otp_verification":
                if not otp_callback:
                    log("  ⚠️ OAuth 需要邮箱 OTP 但没有 otp_callback")
                    return None
                log("  OAuth 等待邮箱验证码...")
                code = otp_callback()
                if not code:
                    log("  ⚠️ OAuth OTP 获取失败")
                    return None
                otp_resp = _submit_otp_via_page(page, code, log)
                log(f"  OAuth 验证码页提交状态: {otp_resp.get('status', 0)}")
                if not otp_resp.get("ok"):
                    raise RuntimeError(f"OAuth 验证码校验失败: {(otp_resp.get('text') or '')[:300]}")
                continue

            if state["page_type"] == "about_you":
                log("  OAuth 页面出现 about_you，继续页面填写...")
                about_resp = _submit_about_you_via_page(page, log)
                log(f"  OAuth about_you 提交状态: {about_resp.get('status', 0)}")
                if not about_resp.get("ok"):
                    raise RuntimeError(f"OAuth about_you 提交失败: {(about_resp.get('text') or '')[:300]}")
                continue

            if state["page_type"] in {"consent", "workspace_selection", "organization_selection", "external_url"}:
                browser_result = _complete_oauth_in_browser(page, oauth_start, proxy, log)
                if browser_result:
                    return browser_result
                cookies_dict = _get_cookies(page)
                session_result = _complete_oauth_with_session(cookies_dict, oauth_start, proxy, log)
                if session_result:
                    return session_result
                log("  ⚠️ 页面已到 consent/workspace，但会话补全失败")
                return None

            if state["page_type"] == "add_phone":
                if phone_callback:
                    log("  OAuth 检测到 add_phone，优先执行短信验证...")
                    try:
                        _handle_add_phone_challenge(
                            page, phone_callback,
                            device_id=device_id, user_agent=user_agent,
                            log=log, resume_url=oauth_start.auth_url,
                        )
                        continue
                    except Exception as exc:
                        if failure_context is not None:
                            _remember_phone_failure(failure_context, exc, phone_callback)
                        log(f"  短信验证失败，停止 OAuth 流程: {exc}")
                        return None

                log("  add_phone 必须完成手机号验证；当前未配置接码服务")
                return None

            # chatgpt_home: 页面可能正在 JS 重定向（如跳转到 add-phone）
            # 等待更长时间让重定向完成
            if state["page_type"] == "chatgpt_home":
                # 检查是否是错误页面
                if "error" in current_url:
                    error_msg = current_url.split("error=")[-1].split("&")[0] if "error=" in current_url else "unknown"
                    log(f"  OAuth 错误页面: {error_msg} url={current_url[:150]}")
                    raise RuntimeError(f"OpenAI OAuth 错误: {error_msg}")
                time.sleep(2)
                new_url = str(page.url or "")
                if new_url != current_url:
                    continue
                # 检查 cookie 里是否有 session
                cookies_dict = _get_cookies(page)
                for ck, cv in cookies_dict.items():
                    if "session" in ck.lower() and cv:
                        log(f"  chatgpt_home 检测到 session cookie: {ck}")
                        session_result = _complete_oauth_with_session(cookies_dict, oauth_start, proxy, log)
                        if session_result:
                            return session_result
                        break
                continue

            if not state["page_type"]:
                try:
                    safe_title = re.sub(r"\b\d{6}\b|[A-Za-z0-9_-]{32,}", "[redacted]", str(page.title() or ""))[:120]
                except Exception:
                    safe_title = "unavailable"
                log(f"  OAuth 未识别页面: title={safe_title} path={urlparse(current_url).path}")
            target_url = _normalize_url(state.get("continue_url") or "", OPENAI_AUTH)
            if target_url and target_url != current_url:
                try:
                    _navigate(page, target_url, wait_until="domcontentloaded", timeout=30000)
                except Exception as exc:
                    callback_url = _extract_callback_url_from_exception(exc)
                    if callback_url:
                        return _submit_callback_result(callback_url, oauth_start, proxy)
                    log(f"  OAuth navigation failed: {exc}")
                    break
                continue

            error_text = _extract_auth_error_text(page)
            if error_text:
                raise RuntimeError(f"OAuth 页面错误: {error_text[:300]}")
            time.sleep(0.5)
    except Exception as e:
        if failure_context is not None:
            _remember_phone_failure(failure_context, e, phone_callback)
        log(f"  OAuth 异常: {e}")
        return None

    cookies_dict = _get_cookies(page)
    try:
        safe_title = re.sub(r"\b\d{6}\b|[A-Za-z0-9_-]{32,}", "[redacted]", str(page.title() or ""))[:120]
    except Exception:
        safe_title = "unavailable"
    log(
        f"  OAuth 循环结束: title={safe_title} path={urlparse(str(page.url or '')).path}"
        f" client_auth_cookie={bool(cookies_dict.get('oai-client-auth-session'))}"
        f" session_cookie={bool(cookies_dict.get('__Secure-next-auth.session-token'))}"
    )
    result = _complete_oauth_with_session(cookies_dict, oauth_start, proxy, log)
    if result:
        return result

    session_token = cookies_dict.get("__Secure-next-auth.session-token", "")
    if not session_token:
        log("  ⚠️ 无 session_token，OAuth 失败")
        return None
    log("  ⚠️ 完整 OAuth 失败，回退 session access_token")
    return None


def _wait_for_access_token(page, timeout: int = 60) -> str:
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            r = page.evaluate("""
            async () => {
                const r = await fetch('/api/auth/session');
                const j = await r.json();
                return j.accessToken || '';
            }
            """)
            if r:
                return r
        except Exception:
            pass
        time.sleep(2)
    return ""


def _is_registration_complete(state: dict) -> bool:
    page_type = str(state.get("page_type") or "")
    url = str(state.get("current_url") or state.get("continue_url") or "").lower()
    return page_type in {"callback", "oauth_callback", "chatgpt_home"} or (
        "chatgpt.com" in url and "redirect_uri" not in url and "about-you" not in url
    )


def _handle_post_signup_onboarding(page, log) -> None:
    current_url = str(page.url or "")
    if "chatgpt.com" not in current_url:
        return
    try:
        # 可能弹出 persistent storage 提示，优先点 Allow，不影响主流程也可点 Block。
        allow_selector = _click_first(
            page,
            [
                'button:has-text("Allow")',
                'button:has-text("allow")',
                'button:has-text("Block")',
                'button:has-text("block")',
            ],
            timeout=1,
        )
        if allow_selector:
            log(f"已处理浏览器弹窗: {allow_selector}")
    except Exception:
        pass

    # 新账号常见 onboarding 问卷页，优先 Skip。
    try:
        if page.locator("text=What brings you to ChatGPT?").first.count() > 0:
            skip_selector = _click_first(
                page,
                [
                    'button:has-text("Skip")',
                    'button:has-text("skip")',
                    'button:has-text("Next")',
                    'button:has-text("next")',
                ],
                timeout=5,
            )
            if skip_selector:
                log(f"已处理 onboarding 页面: {skip_selector}")
                _browser_pause(page)
    except Exception:
        pass


def _is_password_registration(state: dict) -> bool:
    return str(state.get("page_type") or "") in {"create_account_password", "password"}


def _is_email_otp(state: dict) -> bool:
    target = f"{state.get('continue_url') or ''} {state.get('current_url') or ''}".lower()
    return str(state.get("page_type") or "") == "email_otp_verification" or "email-verification" in target or "email-otp" in target


def _is_about_you(state: dict) -> bool:
    target = f"{state.get('continue_url') or ''} {state.get('current_url') or ''}".lower()
    return str(state.get("page_type") or "") == "about_you" or "about-you" in target


def _is_add_phone(state: dict) -> bool:
    target = f"{state.get('continue_url') or ''} {state.get('current_url') or ''}".lower()
    return str(state.get("page_type") or "") == "add_phone" or "add-phone" in target


def _mask_phone_number(phone_number: str) -> str:
    text = str(phone_number or "").strip()
    if len(text) <= 4:
        return text
    if len(text) <= 8:
        return f"{text[:2]}****{text[-2:]}"
    return f"{text[:4]}****{text[-2:]}"


def _is_invalid_phone_otp_response(result: dict) -> bool:
    status = int((result or {}).get("status") or 0)
    if status != 400:
        return False
    data = (result or {}).get("data")
    if isinstance(data, dict):
        error = data.get("error")
        if isinstance(error, dict):
            message = str(error.get("message") or "").lower()
            code = str(error.get("code") or "").lower()
            return code == "invalid_input" and "invalid otp code" in message
    text = str((result or {}).get("text") or "").lower()
    return "invalid otp code" in text


PHONE_VERIFICATION_GUARDS = (
    "fraud", "rate_limit", "rate limit", "too many phone verification requests",
    "verification_hold", "captcha", "security", "browser check", "安全验证",
    "account_deactivated", "deactivated", "challenge_required",
)


def _phone_verification_error(message, phone_callback):
    error = RuntimeError(message)
    error.verification_error_code = getattr(phone_callback, "verification_error_code", "")
    error.rental_cleanup_confirmed = getattr(phone_callback, "rental_cleanup_confirmed", False) is True
    return error


def _remember_phone_failure(context, error, phone_callback):
    if context is None:
        return
    context["security_error"] = re.sub(
        r"https?://\S+|[\w.+-]+@[\w.-]+|\b\d{5,}\b|[A-Za-z0-9_-]{32,}", "[redacted]", str(error),
    )[:400]
    for key in ("verification_error_code", "rental_cleanup_confirmed"):
        value = getattr(error, key, getattr(phone_callback, key, None))
        if value is not None:
            context[key] = value


def _handle_add_phone_challenge(
    page, phone_callback, *, device_id: str, user_agent: str, log,
    resume_url: str = "", max_phone_attempts: int | None = None,
) -> dict:
    """Replace confirmed ordinary delivery failures; never retry verification restrictions."""
    if not phone_callback:
        raise RuntimeError("ChatGPT 注册遇到手机号验证，但未配置 phone_callback。")
    phone_callback._failed_phone_numbers = set()
    phone_callback.verification_error_code = ""
    phone_callback.rental_cleanup_confirmed = not (getattr(phone_callback, "activation", None) and not (
        getattr(phone_callback, "completed", False) or getattr(phone_callback, "awaiting_external_success", False)))
    from core.verification_hold import can_resume_verification_hold, get_verification_hold
    entry_hold = get_verification_hold()
    if entry_hold:
        config = getattr(phone_callback, "config", {}) or {}
        if not can_resume_verification_hold(
            entry_hold, config.get("_verification_hold_account_id"),
            config.get("_resume_verification_hold"), config.get("_verification_hold_detected_at"),
        ):
            phone_callback.verification_error_code = str(entry_hold.get("code") or "")
            phone_callback.verification_hold = entry_hold
            raise _phone_verification_error("verification_hold: 验证已暂停，禁止换号", phone_callback)
        # A manual hold resume authorizes one probe, not an automatic replacement chain.
        max_phone_attempts = 1
    attempts = 0
    retry_at = 0.0
    last_error = None
    while max_phone_attempts is None or attempts < max_phone_attempts:
        while time.monotonic() < retry_at:
            if _task_cancel_requested(log):
                raise _phone_verification_error("phone_retry_cancelled: 手机号重试已取消", phone_callback)
            page.wait_for_timeout(min(500, max(1, int((retry_at - time.monotonic()) * 1000))))
        if _task_cancel_requested(log):
            raise _phone_verification_error("phone_retry_cancelled: 手机号重试已取消，停止换号", phone_callback)
        if hasattr(phone_callback, "check_verification_hold"):
            phone_callback.check_verification_hold()
        callback_hold = getattr(phone_callback, "verification_hold", None)
        if callback_hold and (not entry_hold or callback_hold.get("detected_at") != entry_hold.get("detected_at")):
            raise _phone_verification_error("verification_hold: 验证已暂停，停止换号", phone_callback)
        if attempts:
            log(f"换号重试第 {attempts + 1} 次...")
            _navigate(page, f"{OPENAI_AUTH}/add-phone", wait_until="domcontentloaded", timeout=15000)
            _wait_for_openai_browser_check(page, log)
        attempts += 1
        phone_callback.verification_error_code = ""
        phone_callback._attempt_phone_number = ""
        try:
            result = _do_add_phone_attempt(
                page, phone_callback, device_id=device_id, user_agent=user_agent, log=log, resume_url=resume_url,
            )
            phone_callback.rental_cleanup_confirmed = not (
                getattr(phone_callback, "activation", None) and not (
                    getattr(phone_callback, "completed", False) or getattr(phone_callback, "awaiting_external_success", False)
                )
            )
            return result
        except Exception as exc:
            code = getattr(exc, "verification_error_code", "") or phone_callback.verification_error_code
            phone_callback.verification_error_code = code
            if not getattr(phone_callback, "verification_hold_owner", None):
                phone_callback.verification_hold_owner = uuid.uuid4().hex
            hold = getattr(exc, "verification_hold", None) or activate_verification_hold(
                code + " " + str(exc), account_id=(getattr(phone_callback, "config", {}) or {}).get("_verification_hold_account_id"),
                owner=phone_callback.verification_hold_owner,
            )
            if hold:
                phone_callback.verification_hold = hold
            message = (code + " " + str(exc)).casefold()
            blocked = bool(hold) or any(marker in message for marker in PHONE_VERIFICATION_GUARDS)
            number_in_use = "phone_number_in_use" in message or bool(re.search(
                r"phone number.*(?:already (?:been )?(?:registered|linked|associated|in use)|is in use)", message))
            sms_timeout = "未获取到短信验证码" in message or bool(re.search(r"sms (?:code )?(?:timeout|timed out)", message))
            legacy = number_in_use or sms_timeout
            delivery = getattr(exc, "phone_delivery_failure", False) is True
            channel_only = "whatsapp" in message and not delivery
            provider_error = any(marker in message for marker in ("herosms", "sms_activate", "provider", "供应商"))
            retryable = not blocked and not provider_error and not channel_only and (delivery or legacy)
            if max_phone_attempts is not None and attempts >= max_phone_attempts:
                retryable = False
            retry_at = time.monotonic() + 5
            unused_rental = bool(getattr(phone_callback, "activation", None)) and not (
                getattr(phone_callback, "completed", False) or getattr(phone_callback, "awaiting_external_success", False))
            phone_callback.rental_cleanup_confirmed = not unused_rental
            if not unused_rental and any(marker in message for marker in (
                "phone_cleanup_pending", "cancellation is pending", "cancellation_pending", "号码取消未确认",
            )):
                phone_callback.rental_cleanup_confirmed = False
                raise _phone_verification_error("phone_cleanup_pending: 供应商仍保留未释放号码", phone_callback) from exc
            if unused_rental:
                cleanup = getattr(phone_callback, "cleanup", None)
                if not callable(cleanup):
                    raise _phone_verification_error("phone_cleanup_pending: 号码清理无法确认，保留当前号码", phone_callback) from exc
                log("等待确认当前未使用号码已释放...")
                deadline = time.monotonic() + 180
                while True:
                    if _task_cancel_requested(log):
                        raise _phone_verification_error("phone_retry_cancelled: 手机号重试已取消，原号码保留待清理", phone_callback) from exc
                    try:
                        confirmed = cleanup() is True
                    except Exception:
                        raise _phone_verification_error("phone_cleanup_pending: 号码取消异常，保留当前号码", phone_callback) from exc
                    if confirmed:
                        phone_callback.rental_cleanup_confirmed = True
                        break
                    if time.monotonic() >= deadline:
                        raise _phone_verification_error("phone_cleanup_pending: 号码取消仍未确认，保留当前号码", phone_callback) from exc
                    page.wait_for_timeout(5000)
            last_error = _phone_verification_error(str(exc), phone_callback)
            if not retryable:
                raise last_error from exc
            failed_number = phone_callback._attempt_phone_number
            if failed_number:
                phone_callback._failed_phone_numbers.add(failed_number)
            if hasattr(phone_callback, "phase"):
                phone_callback.phase = "need_number"
                phone_callback.activation = None
                phone_callback.completed = False
    raise last_error or _phone_verification_error("短信验证失败: 已达到显式尝试上限", phone_callback)


def _select_phone_sms_channel_ui(page, phone_callback):
    """Select only an offered SMS option; never enable a disabled channel."""
    channel_probe = """() => {
      const sms = document.querySelector('input[type="radio"][value="sms"]');
      const label = sms?.closest('label'), rect = label?.getBoundingClientRect();
      const style = label && getComputedStyle(label);
      const hidden = document.querySelector('input[type="hidden"][name="channel"]');
      const checked = document.querySelector('input[type="radio"]:checked');
      return {
        sms_available: Boolean(sms && !sms.disabled && sms.getAttribute('aria-disabled') !== 'true' &&
          !sms.closest('[aria-disabled="true"], [data-disabled="true"], fieldset[disabled]') &&
          rect?.width && rect?.height && style.display !== 'none' && style.visibility !== 'hidden'),
        sms_checked: Boolean(sms?.checked), hidden_present: Boolean(hidden), hidden_sms: hidden?.value === 'sms',
        channel: hidden?.value === 'whatsapp' || checked?.value === 'whatsapp' ? 'whatsapp' : 'sms'
      };
    }"""
    selection = page.evaluate(channel_probe)
    if selection.get("sms_available"):
        sms = page.locator('input[type="radio"][value="sms"]').first
        label = sms.locator("..")
        if not sms.is_checked():
            try:
                label.click(timeout=1500)
            except Exception:
                if not page.evaluate(channel_probe).get("sms_available"):
                    raise RuntimeError("SMS 选项已不可操作，已停止手机号提交")
                label.evaluate("el => el.click()")
        _browser_pause(page)
        selected = page.evaluate(channel_probe)
        if not selected.get("sms_checked") or (selected.get("hidden_present") and not selected.get("hidden_sms")):
            raise RuntimeError("SMS 选项未同步，已停止手机号提交")
    elif selection.get("channel") == "whatsapp":
        if hasattr(phone_callback, "mark_send_failed"):
            phone_callback.mark_send_failed("sms_channel_unavailable")
        raise RuntimeError("WhatsApp 渠道没有正常启用的 SMS 选项，已停止手机号提交")


def _do_add_phone_attempt(
    page,
    phone_callback,
    *,
    device_id: str,
    user_agent: str,
    log,
    resume_url: str = "",
) -> dict:
    """单次手机号验证尝试（内部函数）。"""

    # 保留 HTTP resend 回调供 SMS provider 内部使用
    referer = _normalize_url(str(page.url or ""), OPENAI_AUTH) or f"{OPENAI_AUTH}/add-phone"
    headers = _build_browser_headers(
        user_agent=user_agent,
        accept="application/json",
        referer=referer,
        origin=OPENAI_AUTH,
        content_type="application/json",
        extra_headers={
            "sec-fetch-site": "same-origin",
            "oai-device-id": device_id,
            **_generate_datadog_trace_headers(),
        },
    )

    def _request_openai_resend():
        if hasattr(phone_callback, "check_verification_hold"):
            phone_callback.check_verification_hold()
        # 浏览器模式下只通过页面 UI 点击 Resend 按钮
        resend_clicked = _click_first(page, [
            'button:has-text("Resend")',
            'button:has-text("resend")',
            'button:has-text("Resend code")',
            'button:has-text("重新发送")',
            'a:has-text("Resend")',
            'a:has-text("resend")',
            'a:has-text("Resend code")',
        ], timeout=3)
        if resend_clicked:
            log(f"  phone-otp/resend -> 已点击页面 Resend 按钮: {resend_clicked}")
        else:
            log("  phone-otp/resend -> 页面未找到 Resend 按钮，跳过（浏览器模式不走 HTTP）")

    if hasattr(phone_callback, "set_resend_callback"):
        phone_callback.set_resend_callback(_request_openai_resend)

    # 先完成正常导航及被动浏览器检查，再占用付费号码。
    if "add-phone" not in str(page.url or ""):
        _navigate(page, f"{OPENAI_AUTH}/add-phone", wait_until="domcontentloaded", timeout=30000)
    _wait_for_openai_browser_check(page, log)

    _select_phone_sms_channel_ui(page, phone_callback)

    # ---- 第1步: 获取手机号 ----
    log("注册流程已进入 add_phone，开始准备租号并接收短信验证码...")
    phone_number = str(phone_callback() or "").strip()
    if not phone_number:
        raise RuntimeError("未获取到手机号")
    normalized_number = re.sub(r"\D", "", phone_number)
    phone_callback.rental_cleanup_confirmed = False
    phone_callback._attempt_phone_number = normalized_number
    if normalized_number in getattr(phone_callback, "_failed_phone_numbers", set()):
        raise _phone_verification_error("phone_number_reused: 接码服务返回已失败号码，停止重复提交", phone_callback)
    log(f"检测到 add_phone，提交手机号(UI): {_mask_phone_number(phone_number)}")

    # 解析国家拨号码和本地号码
    dial_code, local_number, country_name = _parse_phone_country_and_local(phone_number)
    log(f"  解析号码: 国家={country_name or '未知'} 拨号码=+{dial_code} 本地号={local_number[:4]}...")

    # ---- 第2步: 选择国家 ----
    country_selected = _select_phone_country_ui(page, dial_code, country_name, log)
    if not country_selected and PHONE_DIAL_TO_ISO.get(dial_code):
        if hasattr(phone_callback, "mark_send_failed"):
            phone_callback.mark_send_failed("phone_country_unsynchronized")
        prefix = f"phone-country-failure-{uuid.uuid4().hex}/page"
        try:
            _dump_debug(page, prefix)
            log(f"phone_send failure capture: aiTemp/{prefix}")
        except Exception as exc:
            log(f"phone_send failure capture unavailable: {type(exc).__name__}")
        raise RuntimeError("手机号国家选择未同步，已停止手机号提交")
    _browser_pause(page)

    # ---- 第3步: 填写手机号 ----
    phone_input_sel = _wait_for_any_selector(page, PHONE_INPUT_SELECTORS, timeout=10)
    if phone_input_sel:
        # 如果成功选了国家，输入本地号码；否则输入完整号码
        fill_value = local_number if country_selected else phone_number
        filled = _fill_input_like_user(page, phone_input_sel, fill_value)
        # _fill_input_like_user 用严格相等验证，但 add-phone 页面可能在 input 中自动加了国家前缀
        # 所以额外检查 input.value 是否包含我们填入的号码
        if not filled:
            try:
                actual_val = str(page.locator(phone_input_sel).first.input_value() or "")
                # 如果 input 值包含我们的号码（可能前面有 +56 之类的前缀），认为成功
                filled_digits = re.sub(r"\D", "", fill_value)
                actual_digits = re.sub(r"\D", "", actual_val)
                if filled_digits and actual_digits.endswith(filled_digits):
                    filled = True
                    log(f"  手机号已填写(含前缀): {actual_val[:12]}...")
            except Exception:
                pass
        if not filled:
            # fallback: 尝试先清空再用 keyboard.type 输入
            log(f"  _fill_input_like_user 失败，尝试 keyboard fallback...")
            try:
                page.click(phone_input_sel)
                time.sleep(0.3)
                # 三次全选删除确保清空
                for _ in range(3):
                    page.keyboard.press("Meta+a")
                    time.sleep(0.1)
                    page.keyboard.press("Backspace")
                    time.sleep(0.1)
                page.keyboard.type(fill_value, delay=random.randint(30, 70))
                time.sleep(0.3)
                # 验证输入值
                actual = page.locator(phone_input_sel).first.input_value()
                actual_clean = re.sub(r"\D", "", str(actual or ""))
                if actual_clean.endswith(re.sub(r"\D", "", fill_value)):
                    filled = True
                    log(f"  keyboard fallback 成功: {str(actual or '')[:12]}...")
            except Exception as e:
                log(f"  keyboard fallback 失败: {e}")
        if not filled:
            # 最终 fallback: 直接用 JS 设置值
            try:
                js_ok = page.locator(phone_input_sel).first.evaluate(
                    """
                    (input, value) => {
                      if (!input) return false;
                      input.focus();
                      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
                      if (setter) setter.call(input, value);
                      else input.value = value;
                      input.dispatchEvent(new Event('input', { bubbles: true }));
                      input.dispatchEvent(new Event('change', { bubbles: true }));
                      // 也触发 React 合成事件
                      const nativeEvent = new Event('input', { bubbles: true });
                      Object.defineProperty(nativeEvent, 'target', { writable: false, value: input });
                      input.dispatchEvent(nativeEvent);
                      const digits = (text) => String(text || '').replace(/\\D/g, '');
                      return Boolean(digits(value)) && digits(input.value).endsWith(digits(value));
                    }
                    """,
                    fill_value,
                )
                if js_ok:
                    filled = True
                    log(f"  JS setValue fallback 成功")
            except Exception as e:
                log(f"  JS setValue fallback 失败: {e}")
        if not filled:
            raise RuntimeError(f"手机号输入框填写失败: {phone_input_sel}")
        log(f"  手机号输入框已填写: {phone_input_sel} value={fill_value[:4]}...")
    else:
        raise RuntimeError("未找到手机号输入框")
    _browser_pause(page)

    _select_phone_sms_channel_ui(page, phone_callback)

    phone_send_page_type = ""
    phone_send_delivery_method = ""
    phone_send_error_code = ""
    phone_send_error_message = ""
    phone_send_requested = False
    phone_delivery_failed = False

    def _phone_request_path(request):
        parsed = urlparse(str(request.url or ""))
        if request.method == "POST" and parsed.hostname == "auth.openai.com" and parsed.path.startswith("/api/accounts/"):
            return re.sub(r"[A-Za-z0-9_-]{32,}|\d{5,}", "[redacted]", parsed.path)
        return ""

    def _phone_request(request):
        nonlocal phone_send_delivery_method, phone_send_requested
        path = _phone_request_path(request)
        if path:
            details = {}
            if path == "/api/accounts/add-phone/send":
                phone_send_requested = True
                try:
                    payload = request.post_data_json
                    if isinstance(payload, dict):
                        details["payload_fields"] = sorted(key for key in payload if re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]{0,63}", str(key)))
                        destination = payload.get("phone_number")
                        details["destination_matches_rental"] = re.sub(r"\D", "", destination) == re.sub(r"\D", "", phone_number) if isinstance(destination, str) else None
                        channel = payload.get("channel")
                        phone_send_delivery_method = channel if channel in {"sms", "whatsapp"} else ""
                        details["delivery_method"] = phone_send_delivery_method or "unspecified"
                except Exception:
                    pass
            log(f"phone_send POST request: path={path} details={json.dumps(details)}")

    def _phone_response(response):
        nonlocal phone_send_page_type, phone_send_delivery_method, phone_send_error_code, phone_send_error_message
        path = _phone_request_path(response.request)
        if not path:
            return
        details = {"path": path, "status": response.status}
        try:
            payload = response.json()
            state = _extract_flow_state(payload, response.url)
            if state.get("page_type"):
                phone_send_page_type = state["page_type"]
                details["page_type"] = phone_send_page_type
            session = payload.get("oai-client-auth-session")
            if isinstance(session, dict):
                channel = session.get("set_phone_verification_channel") or session.get("phone_verification_channel")
                if channel in {"sms", "whatsapp"}:
                    if phone_send_delivery_method != "whatsapp":
                        phone_send_delivery_method = channel
                    details["delivery_method"] = channel
            error = payload.get("error")
            if isinstance(error, dict):
                code = str(error.get("code") or "")
                if re.fullmatch(r"[A-Za-z_][A-Za-z0-9_.-]{0,30}", code):
                    phone_send_error_code = code
                    phone_callback.verification_error_code = code
                phone_send_error_message = str(error.get("message") or "")
                if not getattr(phone_callback, "verification_hold_owner", None):
                    phone_callback.verification_hold_owner = uuid.uuid4().hex
                hold = activate_verification_hold(
                    code + " " + str(error.get("message") or ""),
                    account_id=(getattr(phone_callback, "config", {}) or {}).get("_verification_hold_account_id"),
                    retry_after=response.headers.get("retry-after"),
                    owner=phone_callback.verification_hold_owner,
                )
                if hold:
                    phone_callback.verification_hold = hold
                details["error"] = {key: value if re.fullmatch(r"[A-Za-z_][A-Za-z0-9_.-]{0,30}", str(value)) else "[redacted]"
                                    for key, value in error.items() if key in {"code", "type", "param"}}
        except Exception:
            pass
        log(f"phone_send POST response: {json.dumps(details)}")

    def _phone_failed(request):
        path = _phone_request_path(request)
        if path:
            failure = str(request.failure or "")
            kind = failure if re.fullmatch(r"(?:NS_ERROR_[A-Z_]+|net::ERR_[A-Z_]+)", failure) else "request_failed"
            log(f"phone_send POST failed: path={path} kind={kind}")

    listeners = [("request", _phone_request), ("response", _phone_response), ("requestfailed", _phone_failed)]
    for event, listener in listeners:
        page.on(event, listener)
    try:
        # ---- 第4步: 点击发送按钮并确认已进入独立验证码输入状态 ----
        if hasattr(phone_callback, "check_verification_hold"):
            phone_callback.check_verification_hold()
        send_sel = _click_first(page, PHONE_SEND_SELECTORS, timeout=8, stop_if=lambda: phone_send_requested)
        if send_sel:
            log(f"  已点击发送按钮: {send_sel}")
        elif phone_send_requested:
            log("  原生点击已发出 phone_send 请求，停止 fallback 重复提交")
        elif _submit_form_with_fallback(page, phone_input_sel):
            log("  未找到发送按钮，已使用表单 fallback 提交")
        else:
            raise RuntimeError("未找到发送验证码按钮")
        time.sleep(2)
        error_text = _extract_auth_error_text(page) or phone_send_error_message
        rejection = (phone_send_error_code + " " + error_text).casefold()
        if getattr(phone_callback, "verification_hold", None) or any(marker in rejection for marker in PHONE_VERIFICATION_GUARDS):
            raise _phone_verification_error(
                f"手机号提交失败: {phone_send_error_code or 'verification_restricted'} {error_text[:200]}", phone_callback)
        delivery_text = rejection.replace("’", "'")
        phone_delivery_failed = any(marker in delivery_text for marker in (
            "couldn't send text", "couldn't send a text", "could not send text", "unable to send text",
            "couldn't send sms", "could not send sms", "unable to send sms", "sms delivery failed",
        ))
        if phone_delivery_failed:
            raise _phone_verification_error("phone_delivery_failed: OpenAI couldn't send text", phone_callback)
        if phone_send_error_code or error_text:
            raise _phone_verification_error(f"手机号提交失败: {phone_send_error_code or 'phone_send_error'} {error_text[:200]}", phone_callback)
        if phone_send_delivery_method == "whatsapp":
            raise RuntimeError("手机号验证使用 WhatsApp 渠道，SMS 接码服务无法接收，已停止等待")
        phone_otp_selectors = [f"{selector}:not([disabled]):not([readonly])" for selector in OTP_INPUT_SELECTORS if "code" in selector]
        if phone_send_page_type == "phone_otp_verification":
            phone_otp_selectors.append("input[maxlength='6']:not([type='tel']):not([autocomplete^='tel']):not([name*='phone' i]):not([id*='phone' i]):not([disabled]):not([readonly])")
        if not _wait_for_any_selector(page, phone_otp_selectors, timeout=15):
            raise RuntimeError("手机号提交后未进入短信验证码页面，已停止等待")
    except Exception as exc:
        exc.verification_error_code = phone_send_error_code
        exc.phone_delivery_failure = phone_delivery_failed
        if hasattr(phone_callback, "mark_send_failed"):
            phone_callback.mark_send_failed(phone_send_error_code or "phone_send_unconfirmed")
        prefix = f"phone-send-failure-{uuid.uuid4().hex}/page"
        try:
            _dump_debug(page, prefix)
            log(f"phone_send failure capture: aiTemp/{prefix}")
        except Exception as exc:
            log(f"phone_send failure capture unavailable: {type(exc).__name__}")
        raise
    finally:
        for event, listener in listeners:
            page.remove_listener(event, listener)
    if hasattr(phone_callback, "mark_send_succeeded"):
        phone_callback.mark_send_succeeded()
    log("手机号提交成功(UI)，已确认短信验证码输入框，开始等待短信验证码...")

    # ---- 第5步: 等待 SMS 验证码并在页面 OTP 输入框中填写 ----
    for code_attempt in range(3):
        sms_code = str(phone_callback() or "").strip()
        if _task_cancel_requested(log):
            raise RuntimeError("registration_cancelled: 短信验证已取消")
        if not sms_code:
            raise RuntimeError("未获取到短信验证码")

        # 等待 OTP 输入框出现
        otp_sel = _wait_for_any_selector(page, phone_otp_selectors, timeout=10)
        if not otp_sel:
            raise RuntimeError("未找到短信验证码输入框")

        # 使用与邮箱 OTP 相同的填写逻辑
        if _task_cancel_requested(log):
            raise RuntimeError("registration_cancelled: 短信验证已取消")
        otp_resp = _submit_otp_via_page(page, sms_code, log)
        otp_status = int(otp_resp.get("status") or 0)
        log(f"  phone-otp 页面提交状态: {otp_status}")
        otp_data = otp_resp.get("data") or {}
        otp_error = otp_data.get("error") if isinstance(otp_data, dict) else None
        if isinstance(otp_error, dict):
            otp_code = str(otp_error.get("code") or "")
            if re.fullmatch(r"[A-Za-z_][A-Za-z0-9_.-]{0,30}", otp_code):
                phone_callback.verification_error_code = otp_code
            if not getattr(phone_callback, "verification_hold_owner", None):
                phone_callback.verification_hold_owner = uuid.uuid4().hex
            hold = activate_verification_hold(
                str(otp_error.get("code") or "") + " " + str(otp_error.get("message") or ""),
                account_id=(getattr(phone_callback, "config", {}) or {}).get("_verification_hold_account_id"),
                owner=phone_callback.verification_hold_owner,
            )
            if hold:
                phone_callback.verification_hold = hold
                raise _phone_verification_error("rate_limit_exceeded: Too many phone verification requests", phone_callback)
            if any(marker in (otp_code + " " + str(otp_error.get("message") or "")).casefold() for marker in PHONE_VERIFICATION_GUARDS):
                raise _phone_verification_error(f"短信验证码校验失败: {otp_code or 'verification_restricted'}", phone_callback)

        if otp_resp.get("ok") or otp_status in (200, 201, 204):
            phone_callback.phone_verification_succeeded = True
            if hasattr(phone_callback, "report_success"):
                phone_callback.report_success()
            # 等待页面跳转
            time.sleep(1.5)
            state = _extract_flow_state(
                otp_resp.get("data"),
                otp_resp.get("url", page.url),
            )
            if not state.get("page_type"):
                state = _derive_registration_state_from_page(page)
            next_url = _normalize_url(resume_url, OPENAI_AUTH) if resume_url else ""
            if next_url:
                _navigate(page, next_url, wait_until="domcontentloaded", timeout=30000)
                return _extract_flow_state(None, page.url)
            return state

        # 检查是否是无效验证码
        page_error = _extract_auth_error_text(page)
        if page_error and any(kw in page_error.lower() for kw in ("invalid", "incorrect", "wrong", "expired")):
            log(f"短信验证码被判定无效: {page_error[:100]}，继续等待下一条...")
            if hasattr(phone_callback, "mark_code_failed"):
                phone_callback.mark_code_failed(page_error or "invalid otp code")
            continue

        if hasattr(phone_callback, "mark_code_failed"):
            phone_callback.mark_code_failed(page_error or f"status {otp_status}")
        raise RuntimeError(f"短信验证码校验失败: {page_error[:200] if page_error else f'status {otp_status}'}")

    raise RuntimeError("短信验证码校验失败: 多次验证码均无效或未通过")


def _requires_registration_navigation(state: dict) -> bool:
    if str(state.get("method") or "GET").upper() != "GET":
        return False
    if str(state.get("page_type") or "") == "external_url" and state.get("continue_url"):
        return True
    continue_url = str(state.get("continue_url") or "")
    current_url = str(state.get("current_url") or "")
    return bool(continue_url and continue_url != current_url)


def _browser_add_cookies(page, cookies: list[dict]) -> None:
    try:
        page.context.add_cookies(cookies)
    except Exception:
        pass


def _seed_browser_device_id(page, device_id: str) -> None:
    _browser_add_cookies(
        page,
        [
            {"name": "oai-did", "value": device_id, "domain": "chatgpt.com", "path": "/"},
            {"name": "oai-did", "value": device_id, "domain": ".chatgpt.com", "path": "/"},
            {"name": "oai-did", "value": device_id, "domain": "openai.com", "path": "/"},
            {"name": "oai-did", "value": device_id, "domain": "auth.openai.com", "path": "/"},
            {"name": "oai-did", "value": device_id, "domain": ".auth.openai.com", "path": "/"},
        ],
    )


def _get_browser_csrf_token(page) -> str:
    result = _browser_fetch(
        page,
        f"{CHATGPT_APP}/api/auth/csrf",
        method="GET",
        headers={
            "accept": "application/json",
            "referer": f"{CHATGPT_APP}/",
            "sec-fetch-site": "same-origin",
        },
        redirect="follow",
    )
    if result.get("ok") and isinstance(result.get("data"), dict):
        return str((result.get("data") or {}).get("csrfToken") or "").strip()
    return ""


def _start_browser_signin(page, email: str, device_id: str, csrf_token: str) -> str:
    from urllib.parse import urlencode

    query = urlencode(
        {
            "prompt": "login",
            "ext-oai-did": device_id,
            "auth_session_logging_id": str(uuid.uuid4()),
            "screen_hint": "login_or_signup",
            "login_hint": email,
        }
    )
    body = urlencode(
        {
            "callbackUrl": f"{CHATGPT_APP}/",
            "csrfToken": csrf_token,
            "json": "true",
        }
    )
    result = _browser_fetch(
        page,
        f"{CHATGPT_APP}/api/auth/signin/openai?{query}",
        method="POST",
        headers={
            "accept": "application/json",
            "referer": f"{CHATGPT_APP}/",
            "origin": CHATGPT_APP,
            "content-type": "application/x-www-form-urlencoded",
            "sec-fetch-site": "same-origin",
        },
        body=body,
        redirect="follow",
    )
    if result.get("ok") and isinstance(result.get("data"), dict):
        return str((result.get("data") or {}).get("url") or "").strip()
    return ""


def _browser_authorize(page, auth_url: str, log) -> str:
    if not auth_url:
        return ""
    try:
        _navigate(page, auth_url, wait_until="domcontentloaded", timeout=30000)
        final_url = page.url
        log(f"Authorize -> {_safe_browser_location(final_url)}")
        return final_url
    except Exception as exc:
        # Firefox may abort the superseded request after a real auth redirect.
        # Reuse only an already-visible first-party form; never retry a warning or challenge.
        if "NS_BINDING_ABORTED" in str(exc) or "net::ERR_ABORTED" in str(exc):
            observed = str(page.url or "")
            parsed = urlparse(observed)
            auth_form_paths = {
                "/log-in", "/log-in-or-create-account", "/create-account",
                "/create-account/password", "/create-account-password",
                "/email-verification", "/email-otp-verification",
                "/about-you", "/add-phone", "/phone-otp-verification",
            }
            if (observed != auth_url and parsed.scheme == "https"
                    and parsed.hostname == "auth.openai.com" and parsed.path in auth_form_paths):
                try:
                    page.wait_for_load_state("domcontentloaded", timeout=15000)
                except Exception:
                    pass
                if not _is_openai_browser_check(page) and not _extract_auth_error_text(page):
                    selectors = [
                        'input[type="email"]', 'input[type="password"]',
                        *OTP_INPUT_SELECTORS, 'input[name="name"]', 'input[name="full_name"]',
                        'input[type="tel"]',
                    ]
                    if _find_first_selector(page, selectors):
                        log(f"Authorize redirect observed: host={parsed.hostname} path={parsed.path}")
                        return observed
        log(f"Authorize 失败: {exc}")
        return ""


def _validate_browser_email_otp(page, code: str, device_id: str, user_agent: str, referer: str) -> dict:
    headers = _build_browser_headers(
        user_agent=user_agent,
        accept="application/json",
        referer=referer or f"{OPENAI_AUTH}/email-verification",
        origin=OPENAI_AUTH,
        content_type="application/json",
        extra_headers={
            "sec-fetch-site": "same-origin",
            "oai-device-id": device_id,
            **_generate_datadog_trace_headers(),
        },
    )
    sentinel = _build_browser_sentinel_token(page, device_id, "email_otp_validate", user_agent)
    if sentinel:
        headers["openai-sentinel-token"] = sentinel
    _browser_pause(page)
    return _browser_fetch(
        page,
        f"{OPENAI_AUTH}/api/accounts/email-otp/validate",
        method="POST",
        headers=headers,
        body=json.dumps({"code": code}),
        redirect="follow",
    )


def _submit_browser_about_you(page, device_id: str, user_agent: str, referer: str) -> dict:
    from .constants import generate_random_user_info

    headers = _build_browser_headers(
        user_agent=user_agent,
        accept="application/json",
        referer=referer or f"{OPENAI_AUTH}/about-you",
        origin=OPENAI_AUTH,
        content_type="application/json",
        extra_headers={
            "sec-fetch-site": "same-origin",
            "oai-device-id": device_id,
            **_generate_datadog_trace_headers(),
        },
    )
    sentinel = _build_browser_sentinel_token(page, device_id, "oauth_create_account", user_agent)
    if sentinel:
        headers["openai-sentinel-token"] = sentinel
    user_info = generate_random_user_info()
    _browser_pause(page)
    return _browser_fetch(
        page,
        f"{OPENAI_AUTH}/api/accounts/create_account",
        method="POST",
        headers=headers,
        body=json.dumps(user_info),
        redirect="follow",
    )


def _complete_oauth_in_browser(page, oauth_start, proxy, log) -> dict | None:
    """在浏览器里完成 OAuth consent 流程，多策略重试点击 Continue。

    参考 Chrome 扩展项目的 step9 实现:
    - consent 页面是一个 <form action="/sign-in-with-chatgpt/.../consent">
    - 首选 form.requestSubmit(button) 而非 button.click()
    - 多轮重试: requestSubmit → click → dispatchEvent → 刷新重试
    """
    from .oauth import submit_callback_url

    CONSENT_FORM_SEL = OAUTH_CONSENT_FORM_SELECTOR
    MAX_ROUNDS = 4
    CLICK_EFFECT_TIMEOUT = 30

    def _try_extract_callback(url: str) -> dict | None:
        if not url or "code=" not in url:
            return None
        try:
            return json.loads(submit_callback_url(
                callback_url=url,
                expected_state=oauth_start.state,
                code_verifier=oauth_start.code_verifier,
                redirect_uri=oauth_start.redirect_uri,
                client_id=oauth_start.client_id,
                proxy_url=proxy,
            ))
        except ValueError as ve:
            # state 缺失或不匹配时，如果 URL 确实是我们的 callback，跳过 state 验证直接换 token
            if "state" in str(ve) and "localhost" in url and "code=" in url:
                try:
                    # 手动提取 code，跳过 state 验证
                    from urllib.parse import urlparse, parse_qs
                    parsed = urlparse(url)
                    params = parse_qs(parsed.query)
                    code = (params.get("code") or [""])[0]
                    if code:
                        from .oauth import _post_form, _jwt_claims_no_verify, OAUTH_TOKEN_URL
                        import time as _time
                        token_resp = _post_form(
                            OAUTH_TOKEN_URL,
                            {
                                "grant_type": "authorization_code",
                                "client_id": oauth_start.client_id,
                                "code": code,
                                "redirect_uri": oauth_start.redirect_uri,
                                "code_verifier": oauth_start.code_verifier,
                            },
                            proxy_url=proxy,
                        )
                        access_token = (token_resp.get("access_token") or "").strip()
                        refresh_token = (token_resp.get("refresh_token") or "").strip()
                        id_token = (token_resp.get("id_token") or "").strip()
                        if access_token:
                            claims = _jwt_claims_no_verify(id_token)
                            auth_claims = claims.get("https://api.openai.com/auth") or {}
                            now = int(_time.time())
                            expires_in = int(token_resp.get("expires_in") or 0)
                            return {
                                "id_token": id_token,
                                "access_token": access_token,
                                "refresh_token": refresh_token,
                                "account_id": str(auth_claims.get("chatgpt_account_id") or ""),
                                "email": str(claims.get("email") or ""),
                                "expired": _time.strftime("%Y-%m-%dT%H:%M:%SZ", _time.gmtime(now + max(expires_in, 0))),
                                "last_refresh": _time.strftime("%Y-%m-%dT%H:%M:%SZ", _time.gmtime(now)),
                            }
                except Exception:
                    pass
            return None
        except Exception:
            return None

    def _check_current_url() -> dict | None:
        url = str(page.url or "")
        result = _try_extract_callback(url)
        if result:
            return result
        cb = _extract_callback_url_from_exception(Exception(url))
        return _try_extract_callback(cb) if cb else None

    def _wait_for_callback(timeout_sec: int) -> dict | None:
        deadline = time.time() + timeout_sec
        checked_urls = set()
        while time.time() < deadline:
            try:
                url = str(page.url or "")
            except Exception:
                url = ""
            if url and url not in checked_urls:
                checked_urls.add(url)
                if "code=" in url or "localhost" in url:
                    log(f"  [callback_wait] 检测到 URL 变化: {url[:150]}")
            result = _check_current_url()
            if result:
                return result
            # 也检查是否有导航到 localhost 的请求（即使页面加载失败）
            if "localhost" in url and "code=" in url:
                result = _try_extract_callback(url)
                if result:
                    return result
            time.sleep(0.8)
        # 最后再检查一次
        try:
            final_url = str(page.url or "")
            if "code=" in final_url:
                log(f"  [callback_wait] 超时后最终 URL: {final_url[:150]}")
                result = _try_extract_callback(final_url)
                if result:
                    return result
        except Exception:
            pass
        return None

    def _find_consent_button():
        """按优先级查找 consent 页面的 Continue 按钮"""
        # 策略 1: 在 consent form 内找 submit 按钮
        _sel = CONSENT_FORM_SEL
        btn = page.evaluate("""(sel) => {
            const form = document.querySelector(sel);
            if (!form) return null;
            const buttons = form.querySelectorAll('button[type="submit"], input[type="submit"], [role="button"]');
            for (const el of buttons) {
                if (el.offsetParent === null) continue;
                const text = (el.textContent || '').trim().toLowerCase();
                const ddName = el.getAttribute('data-dd-action-name') || '';
                if (ddName === 'Continue' || /continue|继续|continuar|fortfahren|continuer|続ける/i.test(text)) return 'form-continue';
            }
            const first = Array.from(buttons).find(el => el.offsetParent !== null);
            if (first) return 'form-submit';
            return null;
        }""", _sel)
        if btn:
            return btn
        # 策略 2: 全局查找 Continue 按钮
        for sel in [
            'button[type="submit"][data-dd-action-name="Continue"]',
            'button:has-text("Continue")',
            'button:has-text("继续")',
            'button:has-text("Continuar")',
            'button:has-text("Fortfahren")',
            'button:has-text("Continuer")',
            'button:has-text("Allow")',
            'button:has-text("Authorize")',
            'button[type="submit"]',
        ]:
            try:
                loc = page.locator(sel).first
                if loc.is_visible(timeout=500):
                    return sel
            except Exception:
                continue
        return None

    def _click_strategy_request_submit(log_round: int) -> bool:
        """策略 1: form.requestSubmit(button) — 最可靠的表单提交方式"""
        try:
            result = page.evaluate("""(sel) => {
                const form = document.querySelector(sel);
                if (!form) return 'no-form';
                const buttons = form.querySelectorAll('button[type="submit"], input[type="submit"]');
                let target = null;
                for (const el of buttons) {
                    if (el.offsetParent === null) continue;
                    const text = (el.textContent || '').trim().toLowerCase();
                    const ddName = el.getAttribute('data-dd-action-name') || '';
                    if (ddName === 'Continue' || /continue|继续|continuar|fortfahren|continuer/i.test(text)) { target = el; break; }
                }
                if (!target) target = Array.from(buttons).find(el => el.offsetParent !== null);
                if (!target) return 'no-button';
                if (typeof form.requestSubmit === 'function') {
                    form.requestSubmit(target);
                    return 'requestSubmit';
                }
                target.click();
                return 'click-fallback';
            }""", CONSENT_FORM_SEL)
            log(f"  consent 第{log_round}轮 requestSubmit: {result}")
            return result not in ("no-form", "no-button")
        except Exception as e:
            log(f"  consent requestSubmit 异常: {e}")
            return False

    def _click_strategy_playwright(log_round: int) -> bool:
        """策略 2: Playwright locator.click()"""
        for sel in [
            'button:has-text("Continue")',
            'button:has-text("继续")',
            'button:has-text("Continuar")',
            'button:has-text("Fortfahren")',
            'button:has-text("Continuer")',
            'button[type="submit"]',
        ]:
            try:
                loc = page.locator(sel).first
                if loc.is_visible(timeout=1500):
                    loc.click()
                    log(f"  consent 第{log_round}轮 playwright click: {sel}")
                    return True
            except Exception:
                continue
        return False

    def _click_strategy_js_dispatch(log_round: int) -> bool:
        """策略 3: JS dispatchEvent 模拟点击"""
        try:
            result = page.evaluate("""() => {
                const buttons = document.querySelectorAll('button, [role="button"]');
                for (const el of buttons) {
                    if (el.offsetParent === null) continue;
                    const text = (el.textContent || '').trim().toLowerCase();
                    const ddName = el.getAttribute('data-dd-action-name') || '';
                    if (ddName === 'Continue' || /continue|继续|continuar|fortfahren|continuer/i.test(text)) {
                        el.focus();
                        el.dispatchEvent(new MouseEvent('click', {bubbles: true, cancelable: true, view: window}));
                        return text || 'dispatched';
                    }
                }
                return null;
            }
            """)
            if result:
                log(f"  consent 第{log_round}轮 JS dispatch: {result}")
                return True
            return False
        except Exception:
            return False

    strategies = [
        _click_strategy_request_submit,
        _click_strategy_playwright,
        _click_strategy_js_dispatch,
        _click_strategy_request_submit,
    ]

    try:
        current_url = str(page.url or "")
        log(f"  浏览器 consent 处理: {current_url[:100]}")

        # 先检查当前 URL 是否已经有 code
        result = _check_current_url()
        if result:
            log("  ✓ 页面已在 callback URL")
            return result

        # 等待页面加载
        try:
            page.wait_for_load_state("domcontentloaded", timeout=8000)
        except Exception:
            pass
        time.sleep(1)

        # 检查 "Try again" 按钮
        try:
            try_again = page.query_selector('button:has-text("Try again")')
            if try_again and try_again.is_visible():
                log("  consent 页面报错，点击 Try again...")
                try_again.click()
                time.sleep(3)
        except Exception:
            pass

        # 多轮策略重试
        for round_idx in range(MAX_ROUNDS):
            result = _check_current_url()
            if result:
                log("  ✓ 浏览器 OAuth consent 完成")
                return result

            strategy_fn = strategies[min(round_idx, len(strategies) - 1)]
            clicked = strategy_fn(round_idx + 1)

            if clicked:
                # consent 提交后会跳转到 localhost:1455/auth/callback
                # 由于没有本地服务监听，浏览器可能报连接错误，但 URL 已经更新
                try:
                    page.wait_for_url("**/auth/callback*", timeout=15000)
                except Exception:
                    pass  # 超时或导航错误都忽略，下面会检查 URL
                time.sleep(1)
                result = _wait_for_callback(CLICK_EFFECT_TIMEOUT)
                if result:
                    log("  ✓ 浏览器 OAuth consent 完成")
                    return result
                log(f"  consent 第{round_idx + 1}轮点击后页面未跳转")
            else:
                log(f"  consent 第{round_idx + 1}轮未找到按钮")

            # 最后一轮前刷新页面重试
            if round_idx < MAX_ROUNDS - 1:
                log(f"  consent 刷新页面准备第{round_idx + 2}轮...")
                try:
                    page.reload(wait_until="domcontentloaded", timeout=15000)
                except Exception:
                    pass
                time.sleep(2)

        log(f"  consent {MAX_ROUNDS}轮尝试后仍未完成，当前: {str(page.url or '')[:100]}")
        return None
    except Exception as exc:
        cb = _extract_callback_url_from_exception(exc)
        if cb:
            result = _try_extract_callback(cb)
            if result:
                log("  ✓ 从异常中提取 callback 完成 OAuth")
                return result
        log(f"  浏览器 OAuth consent 异常: {exc}")
        return None


def _submit_oauth_password_direct(page, password: str, log) -> dict:
    """OAuth 流程专用：直接填密码登录，不尝试恢复到注册态。"""
    input_selector = _wait_for_any_selector(page, PASSWORD_INPUT_SELECTORS, timeout=15)
    if not input_selector:
        # 密码输入框没出现，可能页面还在加载或跳转了
        # 等一下再试
        time.sleep(2)
        input_selector = _wait_for_any_selector(page, PASSWORD_INPUT_SELECTORS, timeout=10)
    if not input_selector:
        raise RuntimeError("OAuth 密码页未找到输入框")
    if not _fill_input_like_user(page, input_selector, password):
        raise RuntimeError("OAuth 密码页填写失败")
    log(f"  OAuth 密码页输入框: {input_selector}")
    _browser_pause(page)

    submit_selector = _click_first(page, PASSWORD_SUBMIT_SELECTORS, timeout=8)
    if submit_selector:
        log(f"  OAuth 密码页已点击继续按钮: {submit_selector}")
    elif _submit_form_with_fallback(page, input_selector):
        log("  OAuth 密码页使用表单 fallback 提交")
    else:
        raise RuntimeError("OAuth 密码页未找到 Continue 按钮")

    deadline = time.time() + 20
    while time.time() < deadline:
        current_url = str(page.url or "")
        state = _derive_registration_state_from_page(page)
        page_type = str(state.get("page_type") or "")
        if page_type in {"email_otp_verification", "about_you", "consent", "workspace_selection",
                         "organization_selection", "add_phone", "oauth_callback", "chatgpt_home", "external_url"}:
            return {"ok": True, "status": 200, "url": current_url, "data": None, "text": ""}
        if "code=" in current_url:
            return {"ok": True, "status": 200, "url": current_url, "data": None, "text": ""}
        error_text = _extract_auth_error_text(page)
        if error_text:
            return {"ok": False, "status": 400, "url": current_url, "data": None, "text": error_text}
        time.sleep(0.5)
    return {"ok": False, "status": 0, "url": str(page.url or ""), "data": None, "text": "OAuth 密码提交后未跳转"}


def _submit_password_via_page(page, password: str, log) -> dict:
    if _recover_signup_password_page(page, log):
        time.sleep(1)

    input_selector = _wait_for_any_selector(page, PASSWORD_INPUT_SELECTORS, timeout=15)
    if not input_selector:
        raise RuntimeError("密码页未找到输入框")
    if not _fill_input_like_user(page, input_selector, password):
        raise RuntimeError("密码页填写失败")
    log(f"密码页输入框: {input_selector}")
    _browser_pause(page)

    start_url = str(page.url or "")
    submit_selector = _click_first(page, PASSWORD_SUBMIT_SELECTORS, timeout=8)
    if submit_selector:
        log(f"密码页已点击继续按钮: {submit_selector}")
    elif _submit_form_with_fallback(page, input_selector):
        log("密码页未找到可点击 Continue，已使用表单 fallback 提交")
    else:
        raise RuntimeError("密码页未找到 Continue 按钮")

    deadline = time.time() + 20
    last_url = str(page.url or "")
    while time.time() < deadline:
        current_url = str(page.url or "")
        last_url = current_url or last_url
        state = _derive_registration_state_from_page(page)
        page_type = str(state.get("page_type") or "")
        if page_type in {"email_otp_verification", "about_you", "add_phone", "oauth_callback", "chatgpt_home"}:
            return {"ok": True, "status": 200, "url": current_url, "data": None, "text": ""}
        if current_url != start_url and page_type and page_type not in {"create_account_password", "login_password"}:
            return {"ok": True, "status": 200, "url": current_url, "data": None, "text": ""}
        if page_type == "login_password" and _recover_signup_password_page(page, log):
            input_selector = _wait_for_any_selector(page, PASSWORD_INPUT_SELECTORS, timeout=5)
            if not input_selector:
                return {"ok": False, "status": 400, "url": current_url, "data": None, "text": "登录密码页恢复后未找到注册密码输入框"}
            if not _fill_input_like_user(page, input_selector, password):
                return {"ok": False, "status": 400, "url": current_url, "data": None, "text": "登录密码页恢复后密码重新填写失败"}
            submit_selector = _click_first(page, PASSWORD_SUBMIT_SELECTORS, timeout=5)
            if submit_selector:
                log(f"恢复后重新点击密码提交按钮: {submit_selector}")
                start_url = str(page.url or start_url)
                time.sleep(0.4)
                continue
            if _submit_form_with_fallback(page, input_selector):
                log("恢复后未找到密码提交按钮，已使用表单 fallback 提交")
                start_url = str(page.url or start_url)
                time.sleep(0.4)
                continue
            return {"ok": False, "status": 400, "url": current_url, "data": None, "text": "登录密码页恢复后未找到提交方式"}
        error_text = _extract_auth_error_text(page)
        if error_text:
            _dump_debug(page, "chatgpt_password_fail")
            return {"ok": False, "status": 400, "url": current_url, "data": None, "text": error_text}
        time.sleep(0.5)
    _dump_debug(page, "chatgpt_password_fail")
    return {"ok": False, "status": 0, "url": last_url, "data": None, "text": "密码页提交后未跳转"}


def _submit_otp_via_page(page, code: str | Callable[[], str], log, *, timeout: float = 300) -> dict:
    if _task_cancel_requested(log):
        raise RuntimeError("registration_cancelled: 验证码提交已取消")
    otp = "" if callable(code) else str(code or "").strip()

    def ready_code():
        nonlocal otp
        if _task_cancel_requested(log):
            raise RuntimeError("registration_cancelled: 验证码提交已取消")
        if callable(code):
            otp = str(code() or "").strip()
        if _task_cancel_requested(log):
            raise RuntimeError("registration_cancelled: 验证码提交已取消")
        return otp

    if not otp and not callable(code):
        return {"ok": False, "status": 400, "url": page.url, "data": None, "text": "验证码为空"}

    start_url = str(page.url or "")
    # 等待页面加载完成，确保 OTP 输入框已渲染
    try:
        page.wait_for_load_state("domcontentloaded", timeout=5000)
    except Exception:
        pass
    time.sleep(1)

    filled = False

    # 先尝试 6 格 OTP 输入框
    try:
        digit_inputs = page.locator(
            "input[inputmode='numeric'], input[autocomplete='one-time-code'], input[type='tel'], input[type='number']"
        )
        count = digit_inputs.count()
        if count >= 6:
            digit_inputs.nth(0).wait_for(state="visible", timeout=1200)
            otp = ready_code()
            if not otp:
                raise RuntimeError("验证码为空")
            done = 0
            for i in range(min(count, len(otp))):
                box = digit_inputs.nth(i)
                try:
                    box.wait_for(state="visible", timeout=800)
                    box.fill("")
                    box.type(otp[i], delay=random.randint(20, 60))
                    done += 1
                except Exception:
                    break
            if done >= len(otp):
                filled = True
                log(f"验证码页已填写 {done} 位分格输入框")
    except Exception:
        pass

    # 再尝试单输入框
    if not filled:
        otp_candidates = [
            page.get_by_label(re.compile(r"verification code|code|otp", re.IGNORECASE)),
            page.get_by_role("textbox", name=re.compile(r"verification code|code|otp", re.IGNORECASE)),
            page.locator("input[autocomplete='one-time-code']"),
            page.locator("input[name*='code' i]"),
            page.locator("input[id*='code' i]"),
            page.locator("input[type='text']"),
            page.locator("input"),
        ]
        for candidate in otp_candidates:
            try:
                target = candidate.first
                target.wait_for(state="visible", timeout=1200)
                target.click(timeout=1200)
                otp = ready_code()
                if not otp:
                    continue
                target.fill("")
                target.type(otp, delay=random.randint(18, 45))
                final_value = str(target.input_value() or "").strip()
                if final_value:
                    filled = True
                    log("验证码页已填写单输入框")
                    break
            except Exception:
                continue

    if not filled:
        # 再等 3 秒重试一次（页面可能还在渲染）
        time.sleep(3)
        otp_retry_selectors = [
            "input[inputmode='numeric']",
            "input[autocomplete='one-time-code']",
            "input[name*='code' i]",
            "input[type='text']",
        ]
        for sel in otp_retry_selectors:
            try:
                target = page.locator(sel).first
                if target.is_visible(timeout=2000):
                    target.click(timeout=1500)
                    otp = ready_code()
                    if not otp:
                        continue
                    target.fill("")
                    target.type(otp, delay=random.randint(18, 45))
                    if str(target.input_value() or "").strip():
                        filled = True
                        log("验证码页已填写单输入框(重试)")
                        break
            except Exception:
                continue

    if not filled and _fill_input_like_user(page, "input[name='code']", otp):
        filled = True
        log("验证码页已填写 Code 输入框(fallback)")
    if not filled:
        _dump_debug(page, "chatgpt_otp_no_input")
        return {"ok": False, "status": 0, "url": page.url, "data": None, "text": "验证码页未找到可填写输入框"}

    def _otp_safe(value):
        text = re.sub(r"https?://\S+", lambda m: urlparse(m[0]).path, str(value or ""))
        text = re.sub(r"[\w.+-]+@[\w.-]+", "[email omitted]", text)
        return re.sub(r"\b\d{6}\b|[A-Za-z0-9_-]{32,}", "[redacted]", text)

    def _otp_post_path(request):
        parsed = urlparse(str(request.url or ""))
        return parsed.path if request.method == "POST" and parsed.hostname == "auth.openai.com" else ""

    def _otp_request(request):
        path = _otp_post_path(request)
        if path:
            log(f"OTP POST request: path={path}")

    otp_rejection = {}

    def _otp_response(response):
        path = _otp_post_path(response.request)
        if not path:
            return
        details = {"path": path, "status": response.status}
        try:
            payload = response.json()
            error = payload.get("error") if isinstance(payload, dict) else None
            if isinstance(error, dict):
                details["error"] = {key: _otp_safe(error[key]) for key in ("code", "type") if key in error}
        except Exception:
            pass
        log(f"OTP POST response: {json.dumps(details, ensure_ascii=False)}")
        if path == "/api/accounts/email-otp/validate" and response.status >= 400:
            error = details.get("error") or {"code": "otp_validation_rejected"}
            otp_rejection.update(ok=False, status=response.status, data={"error": error},
                                 text="OTP validation rejected: " + str(error.get("code") or "otp_validation_rejected"))

    def _otp_failed(request):
        path = _otp_post_path(request)
        if path:
            log(f"OTP POST failed: path={path} kind={_otp_safe(request.failure)[:200]}")

    otp_listeners = [
        ("request", _otp_request), ("response", _otp_response), ("requestfailed", _otp_failed),
    ]
    for event, listener in otp_listeners:
        page.on(event, listener)

    def _finish_otp(result):
        for event, listener in otp_listeners:
            page.remove_listener(event, listener)
        return result

    _browser_pause(page)
    if _task_cancel_requested(log):
        _finish_otp({})
        raise RuntimeError("registration_cancelled: 验证码提交已取消")
    submit_selector = _click_first(
        page,
        [
            'button[type="submit"]',
            'button[data-testid="continue-button"]',
            'button:has-text("Continue")',
            'button:has-text("continue")',
            'button:has-text("Verify")',
            'button:has-text("verify")',
            'button:has-text("Next")',
            'button:has-text("next")',
        ],
        timeout=8,
    )
    if not submit_selector and _submit_form_with_fallback(page, "input[name='code']"):
        submit_selector = "form fallback"
    if not submit_selector:
        return _finish_otp({"ok": False, "status": 0, "url": page.url, "data": None, "text": "验证码页未找到 Continue 按钮"})
    log(f"验证码页已点击继续按钮: {submit_selector}")

    deadline = time.time() + timeout
    last_url = page.url
    while time.time() < deadline:
        current_url = page.url
        last_url = current_url or last_url
        if otp_rejection:
            return _finish_otp({**otp_rejection, "url": current_url})
        if current_url != start_url:
            current_location = urlparse(str(current_url))
            if (current_location.hostname == "auth.openai.com"
                    and current_location.path.startswith("/mfa")
                    and not urlparse(start_url).path.startswith("/mfa")):
                log("邮箱验证码验证完成，继续原浏览器的认证器 2FA 步骤")
                return _finish_otp({"ok": True, "status": 200, "url": current_url, "data": None, "text": ""})
            if "about-you" in current_url:
                return _finish_otp({"ok": True, "status": 200, "url": current_url, "data": None, "text": ""})
            if "add-phone" in current_url or "chatgpt.com" in current_url or "code=" in current_url:
                return _finish_otp({"ok": True, "status": 200, "url": current_url, "data": None, "text": ""})
            if "consent" in current_url or "sign-in-with-chatgpt" in current_url or "workspace" in current_url or "organization" in current_url:
                return _finish_otp({"ok": True, "status": 200, "url": current_url, "data": None, "text": ""})
        try:
            error_text = page.locator("text=Invalid code").first.text_content(timeout=400)
        except Exception:
            error_text = ""
        if error_text:
            return _finish_otp({"ok": False, "status": 400, "url": current_url, "data": None, "text": error_text})
        time.sleep(0.5)
    try:
        state = page.evaluate("""() => ({
          path: location.pathname,
          inputs: Array.from(document.querySelectorAll('input')).map(el => ({
            name: el.name, type: el.type, required: el.required, disabled: el.disabled, readonly: el.readOnly,
            value_length: String(el.value || '').length,
            validity: Object.fromEntries(['valid', 'valueMissing', 'typeMismatch', 'patternMismatch',
              'rangeUnderflow', 'rangeOverflow', 'stepMismatch', 'badInput', 'customError']
              .map(key => [key, Boolean(el.validity[key])]))
          })),
          buttons: Array.from(document.querySelectorAll('button')).map(el => ({
            text: el.textContent, name: el.name, value: el.value, disabled: el.disabled
          }))
        })""")
        log(f"OTP timeout form: {_otp_safe(json.dumps(state, ensure_ascii=False))}")
        with open("aiTemp/mfa-fix-20261002/otp-submit-fail.html", "w", encoding="utf-8") as capture:
            capture.write(page.content())
    except Exception as exc:
        log(f"OTP timeout capture unavailable: {type(exc).__name__}")
    return _finish_otp({"ok": False, "status": 0, "url": last_url, "data": None, "text": "验证码页提交后未跳转"})


def _submit_about_you_via_page(page, log) -> dict:
    from .constants import generate_random_user_info

    user_info = generate_random_user_info()
    name = str(user_info.get("name") or "").strip()
    birthdate = str(user_info.get("birthdate") or "").strip()
    if not name or not birthdate:
        raise RuntimeError("about_you 数据生成失败")
    date_parts = birthdate.split("-")
    if len(date_parts) == 3:
        yyyy, mm, dd = date_parts
        us_birthdate = f"{mm}/{dd}/{yyyy}"
        cn_birthdate = f"{yyyy}/{mm}/{dd}"
    else:
        us_birthdate = birthdate
        cn_birthdate = birthdate.replace("-", "/")
    log(f"about_you 表单: name={name}, birthdate={birthdate}, ui_birthdate={us_birthdate}, cn_birthdate={cn_birthdate}")

    def _fill_locator(locator, value: str) -> bool:
        try:
            target = locator.first
            target.wait_for(state="visible", timeout=1500)
            target.click(timeout=1500)
            _browser_pause(page, headed=False)
            try:
                applied = bool(
                    target.evaluate(
                        """
                        (input, nextValue) => {
                          const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
                          if (!setter) return false;
                          setter.call(input, nextValue);
                          input.dispatchEvent(new Event('input', { bubbles: true }));
                          input.dispatchEvent(new Event('change', { bubbles: true }));
                          return String(input.value || '') === String(nextValue || '');
                        }
                        """,
                        value,
                    )
                )
            except Exception:
                applied = False
            if not applied:
                target.fill("")
                target.type(value, delay=random.randint(25, 70))
            try:
                target.dispatch_event("blur")
            except Exception:
                pass
            final_val = str(target.input_value() or "").strip()
            return final_val == str(value).strip()
        except Exception:
            return False

    def _locator_from_visible_input_entry(entry: dict):
        try:
            visible_index = int(entry.get("visibleIndex"))
        except Exception:
            return None
        return page.locator("input:visible:not([type='hidden']):not([disabled]):not([readonly])").nth(visible_index)

    def _fill_visible_input_entry(entry: dict | None, value: str) -> bool:
        if not entry:
            return False
        locator = _locator_from_visible_input_entry(entry)
        if locator is None:
            return False
        return _fill_locator(locator, value)

    def _resolve_visible_input_selector(selectors: list[str]) -> str | None:
        for selector in selectors:
            try:
                locator = page.locator(selector).first
                locator.wait_for(state="visible", timeout=500)
                return selector
            except Exception:
                continue
        return None

    def _fill_second_visible_input(values: list[str], excluded_visible_indices: set[int] | None = None) -> bool:
        """兜底：about_you 卡片一般是 Full name + Birthday/Age 两个输入框。"""
        try:
            locator = page.locator(
                "input:visible:not([type='hidden']):not([disabled]):not([readonly])"
            )
            count = locator.count()
            if count < 2:
                return False
            excluded = {int(value) for value in (excluded_visible_indices or set())}
            target_index = None
            for idx in range(count):
                if idx not in excluded:
                    target_index = idx
                    if idx > 0:
                        break
            if target_index is None:
                return False
            target = locator.nth(target_index)
            target.click(timeout=1200)
            _browser_pause(page, headed=False)
            for value in values:
                try:
                    target.fill("")
                except Exception:
                    pass
                try:
                    target.type(str(value), delay=random.randint(18, 45))
                except Exception:
                    continue
                final_val = str(target.input_value() or "").strip()
                if final_val:
                    return True
            return False
        except Exception:
            return False

    def _has_visible(locator) -> bool:
        try:
            locator.first.wait_for(state="visible", timeout=700)
            return True
        except Exception:
            return False

    def _fill_birthday_selects(yyyy: str, mm: str, dd: str) -> bool:
        """处理 Month/Day/Year 下拉样式的生日控件。"""
        try:
            select_locator = page.locator("select:visible")
            count = select_locator.count()
            if count < 2:
                return False

            month_num = int(mm)
            day_num = int(dd)
            year_num = int(yyyy)
            month_short = time.strftime("%b", time.strptime(str(month_num), "%m"))
            month_full = time.strftime("%B", time.strptime(str(month_num), "%m"))

            assigned = {"month": False, "day": False, "year": False}

            for i in range(count):
                sel = select_locator.nth(i)
                try:
                    options = sel.locator("option")
                    option_count = options.count()
                except Exception:
                    option_count = 0
                if option_count <= 0:
                    continue

                texts: list[str] = []
                for idx in range(min(option_count, 80)):
                    try:
                        texts.append(str(options.nth(idx).inner_text(timeout=300) or "").strip())
                    except Exception:
                        continue
                joined = " ".join(texts).lower()

                try:
                    if (not assigned["month"]) and (
                        "january" in joined or "february" in joined or "march" in joined or "april" in joined
                    ):
                        for candidate in (month_full, month_short, str(month_num), f"{month_num:02d}"):
                            try:
                                sel.select_option(label=candidate, timeout=800)
                                assigned["month"] = True
                                break
                            except Exception:
                                try:
                                    sel.select_option(value=candidate, timeout=800)
                                    assigned["month"] = True
                                    break
                                except Exception:
                                    continue
                        continue

                    if (not assigned["year"]) and any(str(y) in joined for y in (year_num, year_num - 1, year_num + 1, 2026, 2025)):
                        for candidate in (str(year_num),):
                            try:
                                sel.select_option(label=candidate, timeout=800)
                                assigned["year"] = True
                                break
                            except Exception:
                                try:
                                    sel.select_option(value=candidate, timeout=800)
                                    assigned["year"] = True
                                    break
                                except Exception:
                                    continue
                        continue

                    if (not assigned["day"]) and any(str(x) in joined for x in (" 1 ", "2", "30", "31")):
                        for candidate in (str(day_num), f"{day_num:02d}"):
                            try:
                                sel.select_option(label=candidate, timeout=800)
                                assigned["day"] = True
                                break
                            except Exception:
                                try:
                                    sel.select_option(value=candidate, timeout=800)
                                    assigned["day"] = True
                                    break
                                except Exception:
                                    continue
                except Exception:
                    continue

            # 下拉顺序兜底：month/day/year
            if count >= 3:
                try:
                    if not assigned["month"]:
                        select_locator.nth(0).select_option(label=month_short, timeout=800)
                        assigned["month"] = True
                except Exception:
                    pass
                try:
                    if not assigned["day"]:
                        select_locator.nth(1).select_option(label=str(day_num), timeout=800)
                        assigned["day"] = True
                except Exception:
                    pass
                try:
                    if not assigned["year"]:
                        select_locator.nth(2).select_option(label=str(year_num), timeout=800)
                        assigned["year"] = True
                except Exception:
                    pass

            return assigned["month"] and assigned["day"] and assigned["year"]
        except Exception:
            return False

    visible_inputs = _collect_visible_text_inputs(page)
    if visible_inputs:
        log(
            "about_you 可见输入框: "
            + " | ".join(
                f"#{int(item.get('visibleIndex', 0))} {(_about_you_input_hints(item) or '-')[:80]}"
                for item in visible_inputs[:4]
            )
        )
    ordered_visible_entries = sorted(
        [item for item in visible_inputs if str(item.get("visibleIndex", "")).isdigit()],
        key=lambda item: int(item.get("visibleIndex", 0)),
    )
    name_entry = _pick_best_about_you_input(visible_inputs, "name")
    age_entry = _pick_best_about_you_input(
        visible_inputs,
        "age",
        exclude_visible_indices={int(name_entry.get("visibleIndex"))} if name_entry and str(name_entry.get("visibleIndex", "")).isdigit() else set(),
    )

    name_candidates = [
        page.get_by_label(re.compile(r"full\s*name", re.IGNORECASE)),
        page.get_by_label(re.compile(r"全名|姓名", re.IGNORECASE)),
        page.get_by_role("textbox", name=re.compile(r"full\s*name|name", re.IGNORECASE)),
        page.get_by_role("textbox", name=re.compile(r"全名|姓名", re.IGNORECASE)),
        page.locator("input[autocomplete='name']"),
        page.locator("input[name*='name' i]"),
        page.locator("input[id*='name' i]"),
        page.locator("input[name*='姓名']"),
        page.locator("input[id*='姓名']"),
        page.locator(
            "xpath=//*[contains(translate(normalize-space(string(.)),'ABCDEFGHIJKLMNOPQRSTUVWXYZ','abcdefghijklmnopqrstuvwxyz'),'full name')]/following::input[1]"
        ),
        page.locator("xpath=//*[contains(normalize-space(string(.)),'全名') or contains(normalize-space(string(.)),'姓名')]/following::input[1]"),
    ]
    birthday_candidates = [
        page.get_by_label(re.compile(r"birthday|date of birth|birth", re.IGNORECASE)),
        page.get_by_label(re.compile(r"生日|出生", re.IGNORECASE)),
        page.get_by_role("textbox", name=re.compile(r"birthday|date of birth|birth", re.IGNORECASE)),
        page.get_by_role("textbox", name=re.compile(r"生日|出生", re.IGNORECASE)),
        page.get_by_placeholder(re.compile(r"mm.?dd.?yyyy|yyyy.?mm.?dd|birthday|生日", re.IGNORECASE)),
        page.locator("input[name*='birth' i]"),
        page.locator("input[id*='birth' i]"),
        page.locator("input[placeholder*='MM' i]"),
        page.locator("input[placeholder*='DD' i]"),
        page.locator("input[placeholder*='YYYY' i]"),
        page.locator("input[placeholder*='年']"),
        page.locator("input[placeholder*='月']"),
        page.locator("input[placeholder*='日']"),
        page.locator("input[inputmode='numeric']"),
        page.locator(
            "xpath=//*[contains(translate(normalize-space(string(.)),'ABCDEFGHIJKLMNOPQRSTUVWXYZ','abcdefghijklmnopqrstuvwxyz'),'birthday')]/following::input[1]"
        ),
        page.locator("xpath=//*[contains(normalize-space(string(.)),'生日') or contains(normalize-space(string(.)),'出生')]/following::input[1]"),
        page.locator("input[type='date']"),
    ]

    age_years = None
    try:
        birth_year = int(str(birthdate).split("-")[0])
        current_year = int(time.strftime("%Y"))
        age_years = max(25, min(40, current_year - birth_year))
    except Exception:
        age_years = random.randint(25, 35)

    age_candidates = [
        page.get_by_label(re.compile(r"age", re.IGNORECASE)),
        page.get_by_label(re.compile(r"年龄", re.IGNORECASE)),
        page.get_by_role("textbox", name=re.compile(r"age", re.IGNORECASE)),
        page.get_by_role("textbox", name=re.compile(r"年龄", re.IGNORECASE)),
        page.locator("input[name*='age' i]"),
        page.locator("input[id*='age' i]"),
        page.locator("input[placeholder*='Age' i]"),
        page.locator("input[placeholder*='年龄']"),
        page.locator(
            "xpath=//*[contains(translate(normalize-space(string(.)),'ABCDEFGHIJKLMNOPQRSTUVWXYZ','abcdefghijklmnopqrstuvwxyz'),'age')]/following::input[1]"
        ),
        page.locator("xpath=//*[contains(normalize-space(string(.)),'年龄')]/following::input[1]"),
    ]

    fill_result = {"name": False, "birthdate": False, "age": False, "month": False, "day": False, "year": False}
    if _fill_visible_input_entry(name_entry, name):
        fill_result["name"] = True
    if not fill_result.get("name"):
        for candidate in name_candidates:
            if _fill_locator(candidate, name):
                fill_result["name"] = True
                break
    mode_probe = {}
    try:
        mode_probe = page.evaluate(
            """
            () => {
              const labels = Array.from(document.querySelectorAll('label'))
                .map((n) => String(n.textContent || '').trim().toLowerCase())
                .filter(Boolean);
              const placeholders = Array.from(document.querySelectorAll('input'))
                .map((n) => String(n.placeholder || '').trim().toLowerCase())
                .filter(Boolean);
              const headings = Array.from(document.querySelectorAll('h1,h2,h3'))
                .map((n) => String(n.textContent || '').trim().toLowerCase())
                .filter(Boolean);
              const allText = labels.concat(placeholders).concat(headings);
              const hasAge = allText.some((t) => t === 'age' || t === 'edad' || t === 'âge' || t === 'alter' || t === 'idade' || t.includes('how old') || t.includes('年龄') || t.includes('나이'));
              const hasBirthday = allText.some((t) =>
                t.includes('birthday') || t.includes('date of birth') || t.includes('birth') || t.includes('生日') || t.includes('出生') || t.includes('fecha de nacimiento') || t.includes('nascimento') || t.includes('geburtstag') || t.includes('naissance')
              );
              return { labels, placeholders, headings, hasAge, hasBirthday };
            }
            """
        ) or {}
    except Exception:
        mode_probe = {}

    has_age_label = bool(mode_probe.get("hasAge"))
    has_birthday_label = bool(mode_probe.get("hasBirthday"))
    has_age_field = any(_has_visible(candidate) for candidate in age_candidates[:3])
    has_birthday_field = any(_has_visible(candidate) for candidate in birthday_candidates[:3])
    has_birthday_select = False
    try:
        has_birthday_select = page.locator("select:visible").count() >= 2
    except Exception:
        has_birthday_select = False
    if has_birthday_select:
        about_mode = "birthday_select"
    elif (has_age_label and not has_birthday_label) or (has_age_field and not has_birthday_field):
        about_mode = "age"
    else:
        about_mode = "birthday"
    log(f"about_you 页面模式: {about_mode} labels={mode_probe.get('labels', [])[:4]}")
    direct_name_selector = _resolve_visible_input_selector(
        [
            'input[name="name"]',
            'input[name="full_name"]',
            'input[autocomplete="name"]',
            'input[placeholder*="全名"]',
            'input[placeholder*="name" i]',
            'input[id*="name" i]:not([type="hidden"])',
        ]
    )
    direct_age_selector = _resolve_visible_input_selector(
        [
            'input[name="age"]',
            'input[placeholder="Age"]',
            'input[placeholder="age"]',
            'input[placeholder*="年龄"]',
            'input[id*="age" i]',
        ]
    )
    if not fill_result.get("name") and direct_name_selector:
        fill_result["name"] = _fill_input_like_user(page, direct_name_selector, name)
    if about_mode == "age" and len(ordered_visible_entries) >= 2:
        name_entry = ordered_visible_entries[0]
        age_entry = ordered_visible_entries[1]
        log(
            f"about_you age 输入框映射: name=#{int(name_entry.get('visibleIndex', 0))}, "
            f"age=#{int(age_entry.get('visibleIndex', 0))}"
        )
    if about_mode == "age":
        log(
            "about_you age 直接定位: "
            f"name={direct_name_selector or '-'}, age={direct_age_selector or '-'}"
        )

    def _fill_segmented_date(mm: str, dd: str, yyyy: str) -> bool:
        """处理 MM / DD / YYYY 分段日期输入框（React DateField 样式）。
        特征：一个 Birthday label 下有多个小 input 或 div[data-type] 段。"""
        try:
            # 方式1: div[data-type] 段 (React Aria DateField)
            month_seg = page.locator('div[data-type="month"], input[data-type="month"]')
            day_seg = page.locator('div[data-type="day"], input[data-type="day"]')
            year_seg = page.locator('div[data-type="year"], input[data-type="year"]')
            if month_seg.count() > 0 and day_seg.count() > 0 and year_seg.count() > 0:
                month_seg.first.click(force=True)
                page.keyboard.type(mm, delay=50)
                time.sleep(0.3)
                day_seg.first.click(force=True)
                page.keyboard.type(dd, delay=50)
                time.sleep(0.3)
                year_seg.first.click(force=True)
                page.keyboard.type(yyyy, delay=50)
                return True

            # 方式2: 单个 date input 里有 MM/DD/YYYY 占位符
            # 点击输入框，然后按顺序输入 MM DD YYYY（Tab 切换段）
            date_input = page.locator("input[placeholder*='MM'], input[placeholder*='mm'], input[type='date']")
            if date_input.count() > 0:
                date_input.first.click(force=True)
                time.sleep(0.2)
                page.keyboard.type(mm, delay=50)
                page.keyboard.type(dd, delay=50)
                page.keyboard.type(yyyy, delay=50)
                return True

            # 方式3: Birthday label 下的第二个可见 input，直接点击后按数字键输入
            birthday_input = page.get_by_label(re.compile(r"birthday|birth", re.IGNORECASE))
            if birthday_input.count() > 0:
                birthday_input.first.click(force=True)
                time.sleep(0.2)
                page.keyboard.type(mm, delay=50)
                page.keyboard.type(dd, delay=50)
                page.keyboard.type(yyyy, delay=50)
                return True

            # 方式4: 第二个可见 input（name 是第一个）
            inputs = page.locator("input:visible:not([type='hidden']):not([disabled])")
            if inputs.count() >= 2:
                target = inputs.nth(1)
                target.click(force=True)
                time.sleep(0.3)
                # 先清空
                page.keyboard.press("Control+a")
                page.keyboard.press("Backspace")
                time.sleep(0.1)
                # 输入 MM，Tab 到 DD，Tab 到 YYYY
                page.keyboard.type(mm, delay=80)
                time.sleep(0.3)
                page.keyboard.type(dd, delay=80)
                time.sleep(0.3)
                page.keyboard.type(yyyy, delay=80)
                time.sleep(0.3)
                # 验证是否填入了正确的值
                val = str(target.input_value() or "").strip()
                if val and val != target.get_attribute("placeholder"):
                    return True
                # 如果直接输入不行，试 Tab 切换
                target.click(force=True)
                time.sleep(0.2)
                page.keyboard.press("Control+a")
                page.keyboard.press("Backspace")
                for i, part in enumerate([mm, dd, yyyy]):
                    page.keyboard.type(part, delay=80)
                    if i < 2:
                        page.keyboard.press("Tab")
                        time.sleep(0.2)
                return True
        except Exception:
            pass
        return False

    if about_mode == "birthday_select":
        if len(date_parts) == 3 and _fill_birthday_selects(yyyy, mm, dd):
            fill_result["month"] = True
            fill_result["day"] = True
            fill_result["year"] = True
            fill_result["birthdate"] = True
    elif about_mode == "age":
        if direct_name_selector and _fill_input_like_user(page, direct_name_selector, name):
            fill_result["name"] = True
        elif _fill_visible_input_entry(name_entry, name):
            fill_result["name"] = True
        if age_years is not None:
            if direct_age_selector and _fill_input_like_user(page, direct_age_selector, str(age_years)):
                fill_result["age"] = True
            elif _fill_visible_input_entry(age_entry, str(age_years)):
                fill_result["age"] = True
            if not fill_result.get("age") and len(ordered_visible_entries) < 2:
                for candidate in age_candidates:
                    if _fill_locator(candidate, str(age_years)):
                        fill_result["age"] = True
                        break
        # fallback: 直接找 placeholder="Age" 的输入框
        if not fill_result.get("age") and age_years is not None and len(ordered_visible_entries) < 2:
            try:
                age_input = page.locator("input[placeholder='Age'], input[placeholder='age']")
                if age_input.count() > 0:
                    age_input.first.click(force=True)
                    time.sleep(0.2)
                    age_input.first.fill("")
                    age_input.first.type(str(age_years), delay=random.randint(30, 60))
                    fill_result["age"] = True
            except Exception:
                pass
        if not fill_result.get("age") and age_years is not None:
            excluded_indices = set()
            if name_entry and str(name_entry.get("visibleIndex", "")).isdigit():
                excluded_indices.add(int(name_entry.get("visibleIndex")))
            if _fill_second_visible_input([str(age_years)], excluded_visible_indices=excluded_indices):
                fill_result["age"] = True
        if len(date_parts) == 3 and _sync_hidden_birthday_input(page, f"{yyyy}-{mm}-{dd}", log):
            fill_result["birthdate"] = True
    elif about_mode == "birthday" or about_mode == "birthday_text":
        # 先尝试分段日期输入（MM / DD / YYYY 格式的 DateField）
        if len(date_parts) == 3 and _fill_segmented_date(mm, dd, yyyy):
            fill_result["birthdate"] = True
            log("about_you 使用分段日期输入成功")
        # 再尝试普通文本输入
        if not fill_result.get("birthdate"):
            for candidate in birthday_candidates:
                if _fill_locator(candidate, cn_birthdate):
                    fill_result["birthdate"] = True
                    break
                if _fill_locator(candidate, us_birthdate):
                    fill_result["birthdate"] = True
                    break
                if _fill_locator(candidate, birthdate):
                    fill_result["birthdate"] = True
                    break
                if _fill_locator(candidate, cn_birthdate.replace("/", "")):
                    fill_result["birthdate"] = True
                    break
                if _fill_locator(candidate, us_birthdate.replace("/", "")):
                    fill_result["birthdate"] = True
                    break
        if not fill_result.get("birthdate"):
            fallback_values = [cn_birthdate, cn_birthdate.replace("/", " / "), cn_birthdate.replace("/", ""), us_birthdate, us_birthdate.replace("/", " / "), us_birthdate.replace("/", ""), birthdate]
            if _fill_second_visible_input(fallback_values):
                fill_result["birthdate"] = True

    log(f"about_you 填写结果: {fill_result}")
    if not fill_result.get("name"):
        _dump_debug(page, "mfa-fix-20261002/about-you-fill-fail")
        raise RuntimeError("about_you 未成功填写 Full name")
    if not (
        fill_result.get("birthdate")
        or fill_result.get("age")
        or (fill_result.get("month") and fill_result.get("day") and fill_result.get("year"))
    ):
        _dump_debug(page, "mfa-fix-20261002/about-you-fill-fail")
        raise RuntimeError("about_you 未成功填写 Birthday/Age")
    _browser_pause(page)

    profile_errors = []
    profile_resources = []
    profile_post = {"rejection": None, "can_retry_validation": False}

    def _profile_safe_error(value):
        text = re.sub(r"https?://\S+", "[URL omitted]", str(value or ""))
        text = re.sub(r"[\w.+-]+@[\w.-]+|\b\d{5,}\b|[A-Za-z0-9_/-]{32,}", "[redacted]", text)
        return re.sub(r"(?i)(nonce-|(?:password|token|auth[_-]?state|state|code)[\"']?\s*[:=]\s*[\"']?)[^\s,;\"']+", r"\1[redacted]", text)[:400]

    def _profile_page_error(error):
        if len(profile_errors) < 10:
            profile_errors.append({"type": "pageerror", "message": _profile_safe_error(error)})

    def _profile_console(message):
        if message.type == "error" and len(profile_errors) < 10:
            profile_errors.append({"type": "console", "message": _profile_safe_error(message.text)})

    def _profile_resource(request, **details):
        parsed = urlparse(str(request.url or ""))
        if len(profile_resources) < 40 and parsed.hostname in {"auth-cdn.oaistatic.com", "sentinel.openai.com"}:
            profile_resources.append({"origin": f"{parsed.scheme}://{parsed.netloc}", "path": parsed.path, **details})

    def _profile_post_path(request):
        parsed = urlparse(str(request.url or ""))
        return parsed.path if request.method == "POST" and parsed.hostname == "auth.openai.com" else ""

    def _profile_request(request):
        path = _profile_post_path(request)
        if path:
            log(f"about_you POST request: path={path}")

    def _profile_response(response):
        _profile_resource(response.request, status=response.status)
        path = _profile_post_path(response.request)
        if not path:
            return
        details = {"path": path, "status": response.status}
        try:
            payload = response.json()
            if isinstance(payload, dict):
                error = payload.get("error")
                if isinstance(error, dict):
                    details["error"] = {key: _profile_safe_error(error[key]) for key in ("code", "type", "param") if key in error}
                target = urlparse(urljoin(OPENAI_AUTH, str(payload.get("continue_url") or "")))
                if payload.get("continue_url") and target.scheme == "https" and target.hostname in {"auth.openai.com", "chatgpt.com"}:
                    details["continue_path"] = target.path
        except Exception:
            pass
        if path == "/api/accounts/create":
            error = details.get("error") or {}
            error_kind = " ".join(str(error.get(key) or "") for key in ("code", "type")).casefold()
            restricted = any(marker in error_kind for marker in (*PHONE_VERIFICATION_GUARDS, "human_verification"))
            rejected = response.status >= 400 or restricted
            profile_post["can_retry_validation"] = (
                response.status == 400 and error.get("code") == "invalid_input" and not restricted
            )
            profile_post["rejection"] = ({
                "ok": False, "status": response.status, "url": str(page.url or ""),
                "data": {"error": error},
                "text": f"about_you_rejected: HTTP {response.status} " + str(error.get("code") or error.get("type") or ""),
            } if rejected else None)
        log(f"about_you POST response: {json.dumps(details, ensure_ascii=False)}")

    def _profile_request_failed(request):
        _profile_resource(request, failure=_profile_safe_error(request.failure))
        path = _profile_post_path(request)
        if path:
            failure = re.sub(r"https?://\S+", "[URL omitted]", str(request.failure or ""))[:200]
            log(f"about_you POST failed: path={path} kind={failure}")

    profile_listeners = [
        ("request", _profile_request), ("response", _profile_response),
        ("requestfailed", _profile_request_failed),
        ("pageerror", _profile_page_error), ("console", _profile_console),
    ]
    for event, listener in profile_listeners:
        page.on(event, listener)

    def _stop_profile_diagnostics(failed=False):
        if failed:
            try:
                state = page.evaluate("""mw:() => ({
                  path: location.pathname,
                  globals: Object.fromEntries([
                    '__loginWebSentinelSdkReady', 'SentinelSDK', '__submitPendingForm',
                    '__reactRouterContext', '__reactRouterManifest', '__reactRouterRouteModules'
                  ].map(name => [name, typeof window[name]])),
                  sentinel_init_available: typeof window.SentinelSDK?.init === 'function',
                  performance_marks: Object.fromEntries([
                    'bootstrap_start', 'bootstrap_end', 'statsig_init_start', 'statsig_init_end',
                    'client_entry_end', 'hydration_start', 'hydration_end'
                  ].map(name => [name, performance.getEntriesByName(name).map(entry => Math.round(entry.startTime))])),
                  script_resources: [...new Set([
                    ...performance.getEntriesByType('resource').filter(entry => entry.initiatorType === 'script').map(entry => entry.name),
                    ...Array.from(document.scripts).map(script => script.src).filter(Boolean)
                  ])].slice(-40).map(name => {
                    const url = new URL(name), entry = performance.getEntriesByName(name).at(-1);
                    return {origin: url.origin, path: url.pathname,
                            ...(entry?.responseStatus ? {status: entry.responseStatus} : {})};
                  }),
                  forms: Array.from(document.forms).map(form => ({
                    valid: Array.from(form.elements).filter(el => el.willValidate).every(el => el.validity.valid)
                  })),
                  inputs: Array.from(document.querySelectorAll('input')).map(el => ({
                    name: el.name, type: el.type, required: el.required, disabled: el.disabled,
                    readonly: el.readOnly, value_length: String(el.value || '').length,
                    validity: Object.fromEntries([
                      'valid', 'valueMissing', 'typeMismatch', 'patternMismatch', 'tooLong', 'tooShort',
                      'rangeUnderflow', 'rangeOverflow', 'stepMismatch', 'badInput', 'customError'
                    ].map(key => [key, Boolean(el.validity[key])]))
                  }))
                })""")
                state.update(page_errors=profile_errors, resource_responses=profile_resources)
                log(f"about_you failure form: {json.dumps(state, ensure_ascii=False)}")
            except Exception as exc:
                log(f"about_you failure form unavailable: {type(exc).__name__}")
        for event, listener in profile_listeners:
            page.remove_listener(event, listener)

    submit_input_selector = direct_name_selector or direct_age_selector or "input:visible:not([type='hidden']):not([disabled]):not([readonly])"
    submit_selector = _click_first(
        page,
        [
            'button:has-text("Finish creating account")',
            'button:has-text("finish creating account")',
            'button[type="submit"]',
            'button[data-testid="continue-button"]',
            'button:has-text("Continue")',
            'button:has-text("continue")',
            'button:has-text("Next")',
            'button:has-text("next")',
        ],
        timeout=8, log=log,
    )
    if not submit_selector and _submit_form_with_fallback(page, submit_input_selector):
        submit_selector = "form fallback"
    if not submit_selector:
        _stop_profile_diagnostics(failed=True)
        raise RuntimeError("about_you 未找到提交按钮")
    log(f"about_you 已点击继续按钮: {submit_selector}")

    deadline = time.time() + 20
    retried_generic_validation = False
    last_url = page.url
    while time.time() < deadline:
        rejection = profile_post["rejection"]
        if rejection and not profile_post["can_retry_validation"]:
            _stop_profile_diagnostics(failed=True)
            return rejection
        current_url = page.url
        last_url = current_url or last_url
        if ("code=" in current_url or "chatgpt.com" in current_url
                or "sign-in-with-chatgpt" in current_url or "add-phone" in current_url):
            _stop_profile_diagnostics(failed=bool(rejection))
            return rejection or {"ok": True, "status": 200, "url": current_url, "data": None, "text": ""}
        try:
            error_text = page.locator("text=Sorry, we cannot create your account").first.text_content(timeout=500)
        except Exception:
            error_text = ""
        if not error_text:
            try:
                error_text = page.locator("text=Enter a valid age to continue").first.text_content(timeout=300)
            except Exception:
                error_text = ""
        if not error_text:
            try:
                error_text = page.locator("text=doesn't look right").first.text_content(timeout=300)
            except Exception:
                error_text = ""
        if not error_text:
            try:
                error_text = page.locator("[role='alert']").first.text_content(timeout=300)
            except Exception:
                error_text = ""
        if not error_text:
            try:
                error_text = page.locator(".error, [class*='error'], [class*='Error']").first.text_content(timeout=300)
            except Exception:
                error_text = ""
        # Responses can arrive while the UI error probes are waiting.
        rejection = profile_post["rejection"]
        if rejection and (not profile_post["can_retry_validation"]
                          or urlparse(str(page.url)).path != urlparse(str(current_url)).path):
            _stop_profile_diagnostics(failed=True)
            return rejection
        if error_text and "oai_log" not in error_text and "SSR_HTML" not in error_text:
            normalized_error = str(error_text).strip().lower()
            if (
                about_mode == "age"
                and not retried_generic_validation
                and ("doesn't look right" in normalized_error or "try again" in normalized_error)
            ):
                retried_generic_validation = True
                log("about_you age 模式提交被拒，重新同步 Full name/Age/hidden birthday 后重试一次...")
                if direct_name_selector and _fill_input_like_user(page, direct_name_selector, name):
                    fill_result["name"] = True
                elif _fill_visible_input_entry(name_entry, name):
                    fill_result["name"] = True
                elif len(ordered_visible_entries) < 2:
                    for candidate in name_candidates:
                        if _fill_locator(candidate, name):
                            fill_result["name"] = True
                            break
                if age_years is not None:
                    if direct_age_selector and _fill_input_like_user(page, direct_age_selector, str(age_years)):
                        fill_result["age"] = True
                    elif _fill_visible_input_entry(age_entry, str(age_years)):
                        fill_result["age"] = True
                    elif len(ordered_visible_entries) < 2:
                        for candidate in age_candidates:
                            if _fill_locator(candidate, str(age_years)):
                                fill_result["age"] = True
                                break
                if len(date_parts) == 3 and _sync_hidden_birthday_input(page, f"{yyyy}-{mm}-{dd}", log):
                    fill_result["birthdate"] = True
                _browser_pause(page)
                retry_submit_selector = _click_first(
                    page,
                    [
                        'button:has-text("Finish creating account")',
                        'button:has-text("finish creating account")',
                        'button[type="submit"]',
                        'button[data-testid="continue-button"]',
                        'button:has-text("Continue")',
                        'button:has-text("continue")',
                        'button:has-text("Next")',
                        'button:has-text("next")',
                    ],
                    timeout=5, log=log,
                )
                if not retry_submit_selector and _submit_form_with_fallback(page, submit_input_selector):
                    retry_submit_selector = "form fallback"
                if retry_submit_selector:
                    log(f"about_you 重试提交按钮: {retry_submit_selector}")
                    time.sleep(0.5)
                    continue
            _stop_profile_diagnostics(failed=True)
            return rejection or {"ok": False, "status": 400, "url": current_url, "data": None, "text": error_text}
        time.sleep(0.5)
    _stop_profile_diagnostics(failed=True)
    _dump_debug(page, "chatgpt_about_you_fail")
    return profile_post["rejection"] or {"ok": False, "status": 0, "url": last_url, "data": None, "text": "about_you 提交后未跳转"}


def _browser_registration_flow(page, email: str, password: str, otp_callback, phone_callback, log) -> dict:
    device_id = str(uuid.uuid4())
    try:
        user_agent = str(page.evaluate("() => navigator.userAgent") or "").strip() or _random_chrome_ua()
    except Exception:
        user_agent = _random_chrome_ua()

    _seed_browser_device_id(page, device_id)
    try:
        state = _start_browser_signup_via_page(page, email, log)
    except Exception as exc:
        log(f"页面驱动注册入口失败，回退 ChatGPT authorize 入口: {exc}")
        state = _start_browser_signup_via_authorize(page, email, device_id, log)
    auth_cookies = _get_cookies(page)
    log(
        "授权态 cookies: "
        f"login_session={'yes' if auth_cookies.get('login_session') else 'no'}, "
        f"oai-did={'yes' if auth_cookies.get('oai-did') else 'no'}"
    )
    log(f"注册状态起点: page={state.get('page_type') or '-'} url={(state.get('current_url') or '')[:100]}")
    register_submitted = False
    password_set = False
    seen_states: dict[str, int] = {}

    for step in range(12):
        _wait_for_openai_browser_check(page, log)
        signature = "|".join(
            [
                str(state.get("page_type") or ""),
                str(state.get("method") or ""),
                str(state.get("continue_url") or ""),
                str(state.get("current_url") or ""),
            ]
        )
        seen_states[signature] = seen_states.get(signature, 0) + 1
        log(
            f"注册状态推进: step={step+1} page={state.get('page_type') or '-'} "
            f"next={str(state.get('continue_url') or '')[:60]} seen={seen_states[signature]}"
        )
        if seen_states[signature] > 2:
            raise RuntimeError(f"注册状态卡住: page={state.get('page_type') or '-'}")

        if _is_registration_complete(state):
            _handle_post_signup_onboarding(page, log)
            return {**_extract_flow_state(None, page.url), "password_set": password_set}

        if _is_password_registration(state):
            if register_submitted:
                raise RuntimeError("重复进入密码注册阶段")
            log("提交注册密码...")
            pre_cookies = _get_cookies(page)
            log(
                "密码阶段 cookies: "
                f"login_session={'yes' if pre_cookies.get('login_session') else 'no'}, "
                f"oai-client-auth-session={'yes' if pre_cookies.get('oai-client-auth-session') else 'no'}"
            )
            reg_resp = _submit_password_via_page(page, password, log)
            log(f"密码页提交状态: {reg_resp.get('status', 0)}")
            if not reg_resp.get("ok"):
                raise RuntimeError(f"密码页提交失败: {(reg_resp.get('text') or '')[:300]}")
            register_submitted = True
            password_set = True
            state = _extract_flow_state(reg_resp.get("data"), reg_resp.get("url", page.url))
            if not state.get("page_type") or _is_password_registration(state):
                state = _derive_registration_state_from_page(page)
            continue

        if str(state.get("page_type") or "") == "login_password":
            if _recover_signup_password_page(page, log):
                state = _derive_registration_state_from_page(page)
                continue
            log("注册流程落到已有账号登录密码页，按登录流程继续认证...")
            login_resp = _submit_oauth_password_direct(page, password, log)
            log(f"登录密码页提交状态: {login_resp.get('status', 0)}")
            if not login_resp.get("ok"):
                raise RuntimeError(f"登录密码页提交失败: {(login_resp.get('text') or '')[:300]}")
            password_set = True
            state = _extract_flow_state(login_resp.get("data"), login_resp.get("url", page.url))
            if not state.get("page_type"):
                state = _derive_registration_state_from_page(page)
            continue

        if _is_email_otp(state):
            if not otp_callback:
                raise RuntimeError("ChatGPT 注册需要邮箱验证码但未提供 otp_callback")
            log("等待 ChatGPT 验证码")
            code = otp_callback()
            if not code:
                raise RuntimeError("未获取到验证码")
            otp_resp = _submit_otp_via_page(page, code, log)
            log(f"验证码页提交状态: {otp_resp.get('status', 0)}")
            if not otp_resp.get("ok"):
                raise RuntimeError(f"验证码校验失败: {(otp_resp.get('text') or '')[:300]}")
            state = _extract_flow_state(otp_resp.get("data"), otp_resp.get("url", page.url))
            if not state.get("page_type"):
                state = _derive_registration_state_from_page(page)
            continue

        if _is_about_you(state):
            log("提交 about_you 信息...")
            target_url = _normalize_url(
                str(state.get("current_url") or state.get("continue_url") or f"{OPENAI_AUTH}/about-you"),
                OPENAI_AUTH,
            )
            if "about-you" not in str(page.url):
                log(f"跳转到 about_you 页面: {target_url[:120]}")
                _navigate(page, target_url, wait_until="domcontentloaded", timeout=30000)
            about_resp = _submit_about_you_via_page(page, log)
            log(f"about_you 提交状态: {about_resp.get('status', 0)}")
            if not about_resp.get("ok"):
                raise RuntimeError(f"about_you 提交失败: {(about_resp.get('text') or '')[:300]}")
            state = _extract_flow_state(about_resp.get("data"), about_resp.get("url", page.url))
            if not state.get("page_type"):
                state = _derive_registration_state_from_page(page)
            if _is_add_phone(state):
                if not phone_callback:
                    return state
                log("about_you 后进入 add_phone，尝试短信验证...")
                try:
                    state = _handle_add_phone_challenge(
                        page,
                        phone_callback,
                        device_id=device_id,
                        user_agent=user_agent,
                        log=log,
                        resume_url=f"{CHATGPT_APP}/",
                    )
                except Exception as exc:
                    exc.password_set = password_set
                    raise
            continue

        if _is_add_phone(state):
            if not phone_callback:
                return {**state, "password_set": password_set}
            log("注册流程进入 add_phone，尝试短信验证...")
            try:
                state = _handle_add_phone_challenge(
                    page,
                    phone_callback,
                    device_id=device_id,
                    user_agent=user_agent,
                    log=log,
                    resume_url=f"{CHATGPT_APP}/",
                )
            except Exception as exc:
                exc.password_set = password_set
                raise
            continue

        if _requires_registration_navigation(state):
            target_url = _normalize_url(str(state.get("continue_url") or state.get("current_url") or ""), OPENAI_AUTH)
            if not target_url:
                raise RuntimeError("缺少可跟随的 continue_url")
            _navigate(page, target_url, wait_until="domcontentloaded", timeout=30000)
            state = _extract_flow_state(None, page.url)
            continue

        raise RuntimeError(f"未支持的注册状态: page={state.get('page_type') or '-'}")

    raise RuntimeError("注册状态机超出最大步数")


class ChatGPTBrowserRegister:
    def __init__(
        self, *, headless: bool, proxy: Optional[str] = None,
        otp_callback: Optional[Callable[[], str]] = None,
        phone_callback: Optional[Callable[[], str]] = None,
        totp_callback: Optional[Callable[[], str]] = None,
        log_fn: Callable[[str], None] = print,
        security_checkpoint=None, security_progress=None,
    ):
        self.headless = headless
        self.proxy = proxy
        self.otp_callback = otp_callback
        self.phone_callback = phone_callback
        self.totp_callback = totp_callback
        self.log = log_fn
        self.security_checkpoint = security_checkpoint
        self.security_progress = dict(security_progress or {})
        set_cancel = getattr(self.phone_callback, "set_cancel_callback", None)
        if callable(set_cancel):
            set_cancel(lambda: _task_cancel_requested(self.log))

    def _launch_options(self):
        launch_opts = {"headless": self.headless, "main_world_eval": True}
        configured = os.environ.get("REG_MACHINE_CAMOUFOX_EXECUTABLE", "").strip()
        binary = Path(configured).expanduser().resolve() if configured else (
            Path(__file__).resolve().parents[2] / ".venv" / "camoufox-browser" / "camoufox.exe"
        )
        if configured or binary.is_file():
            from configparser import ConfigParser
            if not binary.is_file():
                raise RuntimeError("Configured Camoufox runtime is unavailable")
            metadata = ConfigParser()
            metadata.read(binary.with_name("application.ini"), encoding="utf-8")
            version = metadata.get("App", "Version", fallback="").split(".", 1)[0]
            if not version.isdigit():
                raise RuntimeError("Configured Camoufox runtime version is unavailable")
            launch_opts.update(executable_path=str(binary), ff_version=int(version))
        proxy = _build_proxy_config(self.proxy)
        if proxy:
            launch_opts.update(proxy=proxy, geoip=True)
        return launch_opts

    def _restore_saved_session(self, page):
        from .payment import _parse_cookie_str
        from .switch import extract_session_token

        cookies = _parse_cookie_str(self.security_progress.get("cookies"), "chatgpt.com")
        session_token = self.security_progress.get("session_token")
        if session_token and not extract_session_token("", cookies):
            cookies.extend(_parse_cookie_str({"__Secure-next-auth.session-token": session_token}, "chatgpt.com"))
        if cookies:
            page.context.add_cookies(cookies)

    def login(self, email: str, password: str) -> dict:
        """Acquire OAuth tokens for the saved account without registration or MFA changes."""
        from .constants import CODEX_CLIENT_ID
        from .plugin import _assert_complete_oauth_callback
        launch_opts = self._launch_options()
        def startup_stage(stage):
            if _task_cancel_requested(self.log):
                raise RuntimeError("registration_cancelled: OAuth 启动已取消")
            self.log(f"  OAuth startup: {stage}")

        startup_stage("starting Camoufox")
        with Camoufox(**launch_opts) as browser:
            startup_stage("creating page")
            page = browser.new_page()
            startup_stage("restoring saved cookies")
            self._restore_saved_session(page)
            startup_stage("reading cookies")
            cookies_dict = _get_cookies(page)
            startup_stage("ready")
            failure = {}
            result = _do_codex_oauth(
                page, cookies_dict, email, password, self.otp_callback, None,
                self.proxy, self.log, totp_secret=self.security_progress.get("totp_secret", ""),
                failure_context=failure, login_only=True, totp_callback=self.totp_callback,
            )
            if not result:
                raise RuntimeError(failure.get("security_error") or "登录需要人工验证，请检查原账号邮箱或认证器")
            _assert_complete_oauth_callback(result, expected_email=email)
            result.update(
                client_id=CODEX_CLIENT_ID, cookies=json.dumps(page.context.cookies()),
                session_token=_get_cookies(page).get("__Secure-next-auth.session-token", ""),
            )
            return result

    def run(self, email: str, password: str, *, resume: bool = False) -> dict:
        if not resume:
            launch_opts = self._launch_options()
            with Camoufox(**launch_opts) as browser:
                page = browser.new_page()
                self.log("启动 Camoufox 浏览器上下文注册状态机")
                try:
                    state = _browser_registration_flow(
                        page, email, password, self.otp_callback, self.phone_callback, self.log,
                    )
                except Exception as exc:
                    hold = getattr(self.phone_callback, "verification_hold", None) or getattr(exc, "verification_hold", None)
                    _remember_phone_failure(self.security_progress, exc, self.phone_callback)
                    if getattr(exc, "password_set", None) is False:
                        password = ""
                        self.security_progress["password_set"] = False
                    if not (hold or self.security_progress.get("verification_error_code")
                            or getattr(self.phone_callback, "activation", None)):
                        raise
                    if hold:
                        self.security_progress["verification_hold"] = hold
                    return self._checkpoint_pending(page, email, password)
                self.log(f"注册流程完成: page={state.get('page_type') or '-'}")
                if state.get("password_set") is False:
                    password = ""
                    self.security_progress["password_set"] = False
                if state.get("page_type") == "chatgpt_home":
                    self.security_progress["cookies"] = json.dumps(page.context.cookies())
                    if "password_set" in state:
                        self.security_progress["password_set"] = bool(state["password_set"])
                    if callable(self.security_checkpoint):
                        checkpoint = self._pending_progress()
                        phone_verified = bool(getattr(self.phone_callback, "phone_verification_succeeded", False) or self.security_progress.get("phone_verified"))
                        checkpoint.update(email=email, password=password, phone_verified=phone_verified,
                                          status="2fa_required" if phone_verified else "phone_required")
                        self.security_checkpoint(checkpoint)
                        self.log("注册已创建，已在 OAuth 前保存待处理账号及恢复会话")
                try:
                    result = self._complete_oauth_in_page(page, email, password)
                except Exception as exc:
                    _remember_phone_failure(self.security_progress, exc, self.phone_callback)
                    result = None
                if result:
                    return {"email": email, "password": password, **result}
                return self._checkpoint_pending(page, email, password)
        result = self._retry_oauth_fresh_browser(email, password)
        if result:
            return {"email": email, "password": password, **result}
        hold = self.security_progress.get("verification_hold")
        phone_verified = bool(getattr(self.phone_callback, "phone_verification_succeeded", False) or self.security_progress.get("phone_verified"))
        stage = "2fa_required" if phone_verified else "phone_required"
        self.log(f"ChatGPT 验证未完成，保存为 {stage}")
        return {**self._pending_progress(), "email": email, "password": password,
                "phone_verified": phone_verified, "status": stage}

    def _pending_progress(self):
        return {key: value for key, value in self.security_progress.items()
                if key not in {"account_id", "access_token", "refresh_token", "id_token", "workspace_id", "oauth_email"}}

    def _checkpoint_pending(self, page, email, password):
        hold = getattr(self.phone_callback, "verification_hold", None)
        if hold:
            self.security_progress["verification_hold"] = hold
        phone_verified = bool(getattr(self.phone_callback, "phone_verification_succeeded", False) or self.security_progress.get("phone_verified"))
        for key in ("verification_error_code", "rental_cleanup_confirmed"):
            value = getattr(self.phone_callback, key, None)
            if value is not None:
                self.security_progress[key] = value
        self.security_progress.update(
            cookies=json.dumps(page.context.cookies()), phone_verified=phone_verified,
            email=email, password=password, status="2fa_required" if phone_verified else "phone_required",
        )
        if callable(self.security_checkpoint):
            checkpoint = self._pending_progress()
            checkpoint["_verification_hold_owner"] = getattr(self.phone_callback, "verification_hold_owner", None)
            saved = self.security_checkpoint(checkpoint)
            saved_hold = (getattr(saved, "extra", {}) or {}).get("verification_hold")
            if saved_hold:
                self.security_progress["verification_hold"] = saved_hold
        return self._pending_progress()

    def _complete_oauth_in_page(self, page, email, password):
        from .plugin import _assert_complete_oauth_callback
        if _task_cancel_requested(self.log):
            raise RuntimeError("registration_cancelled: OAuth 已取消")
        result = None
        cached = dict(self.security_progress)
        cached["email"] = cached.get("oauth_email") or cached.get("email") or ""
        if all(cached.get(key) for key in ("account_id", "access_token", "refresh_token", "id_token")):
            try:
                _assert_complete_oauth_callback(cached, expected_email=email)
                from .switch import _fetch_profile
                try:
                    valid, profile = _fetch_profile(cached["access_token"], proxy=self.proxy)
                except Exception as exc:
                    valid, profile = False, {"error": str(exc)}
                profile = profile if isinstance(profile, dict) else {}
                status = int(profile.get("status_code") or 0)
                failure = str(profile.get("body") or profile.get("error") or "").casefold()
                code = next((value for value in (
                    "account_deactivated", "fraud_guard", "rate_limit_exceeded",
                    "challenge_required", "human_verification", "captcha", "security_restriction",
                ) if value in failure), "")
                if status in {403, 429} or code or any(marker in failure for marker in PHONE_VERIFICATION_GUARDS):
                    code = code or ("rate_limit_exceeded" if status == 429 else "security_restriction")
                    self.security_progress.update(
                        requires_user_action=True,
                        security_error=f"已保存的登录凭据验证被拒绝: {code}" + (f" (HTTP {status})" if status else ""),
                    )
                    return None
                profile_email = str(profile.get("email") or "").strip()
                if valid is True and profile_email.casefold() == email.strip().casefold():
                    result = cached
            except Exception:
                pass
        if result is None:
            self.log("执行 OAuth 并完成认证器及手机登录设置")
            result = _do_codex_oauth(
                page, _get_cookies(page), email, password, self.otp_callback,
                self.phone_callback, self.proxy, self.log,
                totp_secret=self.security_progress.get("totp_secret", ""),
                failure_context=self.security_progress,
            )
        if not result:
            return None
        _assert_complete_oauth_callback(result, expected_email=email)
        result.update({key: value for key, value in self.security_progress.items()
                       if key in {"totp_secret", "cookies", "session_token", "password_set"}})
        result["phone_verified"] = bool(
            getattr(self.phone_callback, "phone_verification_succeeded", False) or self.security_progress.get("phone_verified")
        )
        result.update(authenticator_verified=False, phone_mfa_disabled=False)
        if result["phone_verified"]:
            try:
                if not callable(self.security_checkpoint):
                    raise RuntimeError("MFA setup requires a persistent account checkpoint")
                result["cookies"] = json.dumps(page.context.cookies())
                self.security_checkpoint(result)
                _complete_chatgpt_security(
                    page, email, password, self.otp_callback, result,
                    self.security_checkpoint, self.log,
                )
            except Exception as exc:
                result["security_error"] = str(exc)
                self.log(f"认证器/手机登录设置未完成: {exc}")
                if callable(self.security_checkpoint):
                    self.security_checkpoint(result)
        self.security_progress.update(result)
        return result

    def _retry_oauth_fresh_browser(self, email, password):
        for key in ("security_error", "requires_user_action"):
            self.security_progress.pop(key, None)
        launch_opts = self._launch_options()
        try:
            with Camoufox(**launch_opts) as browser:
                page = browser.new_page()
                self._restore_saved_session(page)
                result = self._complete_oauth_in_page(page, email, password)
                if not result:
                    self._checkpoint_pending(page, email, password)
                return result
        except Exception as exc:
            _remember_phone_failure(self.security_progress, exc, self.phone_callback)
            self.log(f"OAuth/安全设置异常: {exc}")
            return None
