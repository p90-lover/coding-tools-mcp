import json
import re
from io import StringIO
from pathlib import Path
from types import SimpleNamespace

import pytest

from platforms.chatgpt import browser_register as flow


def test_otp_form_fallback_preserves_continue_intent():
    options = flow.ChatGPTBrowserRegister(headless=True)._launch_options()
    with flow.Camoufox(**options, timeout=60000) as browser:
        page = browser.new_page()
        page.route("**/*", lambda route: route.abort())
        page.set_content('<input type="email" name="hidden-email" hidden><input type="email" name="visible-email">')
        selector = flow._find_first_selector(page, flow.EMAIL_INPUT_SELECTORS)
        assert selector
        assert flow._fill_input_like_user(page, selector, "user@example.com")
        assert page.locator('input[name="visible-email"]').input_value() == "user@example.com"
        assert page.locator('input[name="hidden-email"]').input_value() == ""
        page.set_content("""
          <form>
            <input name="code" value="123456">
            <button type="submit" name="intent" value="validate">Continue</button>
            <button type="submit" name="intent" value="resend">Resend email</button>
          </form>
        """)
        page.evaluate("""() => {
          window.submissions = [];
          document.querySelector('form').addEventListener('submit', event => {
            event.preventDefault();
            window.submissions.push(event.submitter?.value || '');
          });
        }""")
        assert flow._submit_form_with_fallback(page, "input[name='code']:visible")
        assert page.evaluate("window.submissions") == ["validate"]
        page.evaluate("document.querySelector('button').disabled = true; window.submissions = []")
        assert not flow._submit_form_with_fallback(page, "input[name='code']:visible")
        assert page.evaluate("window.submissions") == []
        page.evaluate("""() => {
          const form = document.querySelector('form');
          const submitter = form.querySelector('button');
          submitter.disabled = false;
          form.insertBefore(form.querySelector('button[value="resend"]'), submitter);
        }""")
        assert flow._submit_form_with_fallback(page, "input[name='code']:visible")
        assert page.evaluate("window.submissions") == ["validate"]
        page.evaluate("document.querySelector('button[value=validate]').remove(); window.submissions = []")
        assert not flow._submit_form_with_fallback(page, "input[name='code']:visible")
        assert page.evaluate("window.submissions") == []
        page.set_content('<form><input name="name" value="Test User"><input name="age" type="number" required><button>Continue</button></form>')
        page.evaluate("""() => {
          const age = document.querySelector('input[name=age]');
          window.committedAge = '';
          window.submissions = [];
          age.addEventListener('blur', () => { window.committedAge = age.value; });
          age.focus();
          age.value = '21';
          document.querySelector('form').addEventListener('submit', event => {
            event.preventDefault();
            window.submissions.push(window.committedAge);
          });
        }""")
        assert flow._submit_form_with_fallback(page, "input[name='name']:visible")
        assert page.evaluate("window.submissions") == ["21"]


@pytest.mark.parametrize("failure", ["phone_number_in_use", "This phone number has already been registered", "未获取到短信验证码"])
def test_phone_retry_waits_for_confirmed_cleanup_same_page(monkeypatch, failure):
    events, answers, now = [], iter([False, False, True]), [0.0]
    monkeypatch.setattr(flow.time, "monotonic", lambda: now[0])
    old = object()
    callback = SimpleNamespace(phase="need_code", activation=old, completed=False)
    def cleanup():
        assert callback.phase == "need_code" and callback.activation is old
        events.append("cleanup")
        return next(answers)
    callback.cleanup = cleanup
    page = SimpleNamespace(wait_for_timeout=lambda milliseconds: (events.append("wait"), now.__setitem__(0, now[0] + milliseconds / 1000)))
    attempts = []
    def attempt(active_page, controller, **kwargs):
        assert active_page is page and controller is callback
        attempts.append(True)
        if len(attempts) == 1:
            raise RuntimeError(failure)
        assert controller.phase == "need_number" and controller.activation is None
        events.append("next_attempt")
        return {"page_type": "consent"}
    monkeypatch.setattr(flow, "_do_add_phone_attempt", attempt)
    monkeypatch.setattr(flow, "_navigate", lambda active_page, *args, **kwargs: events.append("navigate"))
    monkeypatch.setattr(flow, "_wait_for_openai_browser_check", lambda *args: events.append("ready"))
    result = flow._handle_add_phone_challenge(page, callback, device_id="fixture", user_agent="fixture", log=lambda message: None)
    assert result["page_type"] == "consent"
    assert events == ["cleanup", "wait", "cleanup", "wait", "cleanup", "navigate", "ready", "next_attempt"]


def test_phone_retry_retains_lease_when_cleanup_unconfirmed(monkeypatch):
    now, attempts = [0], []
    old = object()
    callback = SimpleNamespace(phase="need_code", activation=old, completed=False, cleanup=lambda: False)
    page = SimpleNamespace(wait_for_timeout=lambda milliseconds: now.__setitem__(0, now[0] + 60))
    def attempt(*args, **kwargs):
        attempts.append(True)
        raise RuntimeError("phone_number_in_use")
    monkeypatch.setattr(flow, "_do_add_phone_attempt", attempt)
    monkeypatch.setattr(flow.time, "monotonic", lambda: now[0])
    with pytest.raises(RuntimeError, match="phone_cleanup_pending"):
        flow._handle_add_phone_challenge(page, callback, device_id="fixture", user_agent="fixture", log=lambda message: None)
    assert len(attempts) == 1 and callback.activation is old and callback.phase == "need_code"


def test_phone_retry_honors_sanitized_task_logger_closure(monkeypatch):
    from core.base_platform import BasePlatform
    from types import MethodType
    class Logger:
        def log(self, message):
            pass
        def is_cancel_requested(self):
            return True
    class Platform:
        log = BasePlatform.log
        set_logger = BasePlatform.set_logger
    platform = Platform()
    log_fn = Logger().log
    platform.set_logger(lambda message: log_fn(re.sub(r"(?<!\\d)\\d{6}(?!\\d)", "[code]", str(message))))
    context = SimpleNamespace(log_fn=platform.log)
    log = MethodType(lambda owner, message: owner.log_fn(message), context)
    attempts = []
    monkeypatch.setattr(flow, "_do_add_phone_attempt", lambda *args, **kwargs: attempts.append("rental"))
    with pytest.raises(RuntimeError, match="phone_retry_cancelled"):
        flow._handle_add_phone_challenge(SimpleNamespace(), SimpleNamespace(), device_id="fixture", user_agent="fixture", log=log)
    assert attempts == []


def test_phone_retry_honors_cancel_during_cleanup_wait(monkeypatch):
    class Logger:
        cancelled = False
        def log(self, message):
            pass
        def is_cancel_requested(self):
            return self.cancelled
    logger = Logger()
    platform = SimpleNamespace(_log_fn=logger.log)
    from types import MethodType
    log = MethodType(lambda owner, message: owner._log_fn(message), platform)
    old, cleanup_calls = object(), []
    callback = SimpleNamespace(phase="need_code", activation=old, completed=False,
        cleanup=lambda: cleanup_calls.append(True) or False)
    page = SimpleNamespace(wait_for_timeout=lambda milliseconds: setattr(logger, "cancelled", True))
    monkeypatch.setattr(flow, "_do_add_phone_attempt", lambda *args, **kwargs: (_ for _ in ()).throw(RuntimeError("phone_number_in_use")))
    with pytest.raises(RuntimeError, match="phone_retry_cancelled"):
        flow._handle_add_phone_challenge(page, callback, device_id="fixture", user_agent="fixture", log=log)
    assert len(cleanup_calls) == 1 and callback.activation is old and callback.phase == "need_code"


@pytest.mark.parametrize("failure", ["phone_number_in_use fraud_guard", "SMS timeout CAPTCHA", "SMS timeout security rejection",
    "phone number already registered with WhatsApp", "already failed", "OpenAI browser check did not clear"])
def test_phone_retry_does_not_rotate_safety_or_ambiguous_errors(monkeypatch, failure):
    cleanups = []
    callback = SimpleNamespace(cleanup=lambda: cleanups.append(True) or True)
    monkeypatch.setattr(flow, "_do_add_phone_attempt", lambda *args, **kwargs: (_ for _ in ()).throw(RuntimeError(failure)))
    with pytest.raises(RuntimeError, match=re.escape(failure)):
        flow._handle_add_phone_challenge(SimpleNamespace(), callback, device_id="fixture", user_agent="fixture", log=lambda message: None)
    assert cleanups == []


@pytest.mark.parametrize("failure", ["fraud_guard", "SMS channel unavailable: WhatsApp"])
def test_phone_rejection_releases_unused_rental_without_retry(monkeypatch, failure):
    old, attempts, cleanups = object(), [], []
    answers = iter([False, True])
    callback = SimpleNamespace(phase="need_code", activation=old, completed=False,
                               awaiting_external_success=False)
    def cleanup():
        cleanups.append(True)
        assert callback.activation is old
        return next(answers)
    callback.cleanup = cleanup
    page = SimpleNamespace(wait_for_timeout=lambda delay: None)
    def attempt(*args, **kwargs):
        attempts.append(True)
        raise RuntimeError(failure)
    monkeypatch.setattr(flow, "_do_add_phone_attempt", attempt)
    with pytest.raises(RuntimeError, match=re.escape(failure)):
        flow._handle_add_phone_challenge(page, callback, device_id="fixture", user_agent="fixture",
                                         log=lambda message: None)
    assert len(attempts) == 1 and len(cleanups) == 2


@pytest.mark.parametrize("limit, expected", [(1, 1), (9, 9)])
def test_phone_retry_honors_explicit_attempt_ceiling(monkeypatch, limit, expected):
    attempts, cleanups, now = [], [], [0.0]
    monkeypatch.setattr(flow.time, "monotonic", lambda: now[0])
    page = SimpleNamespace(wait_for_timeout=lambda milliseconds: now.__setitem__(0, now[0] + milliseconds / 1000))
    callback = SimpleNamespace(phase="need_code", activation=object(), completed=False,
        cleanup=lambda: cleanups.append(True) or True)
    def attempt(*args, **kwargs):
        callback.activation = object()
        attempts.append(True)
        raise RuntimeError("phone_number_in_use")
    monkeypatch.setattr(flow, "_do_add_phone_attempt", attempt)
    monkeypatch.setattr(flow, "_navigate", lambda *args, **kwargs: None)
    monkeypatch.setattr(flow, "_wait_for_openai_browser_check", lambda *args: None)
    with pytest.raises(RuntimeError, match="phone_number_in_use"):
        flow._handle_add_phone_challenge(page, callback, device_id="fixture", user_agent="fixture",
            log=lambda message: None, max_phone_attempts=limit)
    assert len(attempts) == len(cleanups) == expected


@pytest.fixture
def offline_phone_send(monkeypatch):
    now, sends, rents, cleanups, responses, listeners = [0.0], [], [], [], [], {}
    class Controller:
        phase = "need_number"
        activation = None
        completed = False
        awaiting_external_success = False
        repeat_number = False
        def __call__(self):
            if self.phase == "need_number":
                number = "+447700900123" if self.repeat_number else f"+447700900{123 + len(rents)}"
                rents.append(number)
                self.activation = SimpleNamespace(phone_number=number)
                self.phase = "need_code"
                return number
            return "123456"
        def cleanup(self):
            cleanups.append(self.activation.phone_number)
            return True
        def mark_send_failed(self, reason): pass
        def mark_send_succeeded(self): pass
        def report_success(self): self.completed = True
    controller = Controller()
    page = SimpleNamespace(url="https://auth.openai.com/add-phone", error_text="",
        evaluate=lambda script: {"sms_available": False, "channel": "sms"},
        on=lambda event, callback: listeners.update({event: callback}),
        remove_listener=lambda event, callback: listeners.pop(event),
        wait_for_timeout=lambda milliseconds: now.__setitem__(0, now[0] + milliseconds / 1000))
    monkeypatch.setattr(flow.time, "monotonic", lambda: now[0])
    monkeypatch.setattr(flow.time, "sleep", lambda seconds: None)
    for name in ("_browser_pause", "_wait_for_openai_browser_check", "_navigate", "_dump_debug"):
        monkeypatch.setattr(flow, name, lambda *args, **kwargs: None)
    monkeypatch.setattr(flow, "_select_phone_country_ui", lambda *args: True)
    monkeypatch.setattr(flow, "_fill_input_like_user", lambda *args: True)
    monkeypatch.setattr(flow, "_wait_for_any_selector", lambda page, selectors, **kwargs:
                        "input[name=phone]" if selectors == flow.PHONE_INPUT_SELECTORS else "input[name=code]")
    monkeypatch.setattr(flow, "_extract_auth_error_text", lambda page: page.error_text)
    monkeypatch.setattr(flow, "_submit_otp_via_page", lambda *args: {"ok": True, "status": 200,
                        "url": "https://auth.openai.com/sign-in-with-chatgpt/codex/consent"})
    def send(*args, **kwargs):
        sends.append((controller.activation.phone_number, now[0]))
        payload = responses.pop(0) if responses else {"page": {"type": "phone_otp_verification"}}
        request = SimpleNamespace(method="POST", url="https://auth.openai.com/api/accounts/add-phone/send",
                                  post_data_json={"phone_number": controller.activation.phone_number, "channel": "sms"})
        listeners["request"](request)
        listeners["response"](SimpleNamespace(request=request, url=request.url, status=400 if "error" in payload else 200,
                                             headers={}, json=lambda: payload))
        return "button"
    monkeypatch.setattr(flow, "_click_first", send)
    return SimpleNamespace(page=page, controller=controller, sends=sends, rents=rents, cleanups=cleanups,
                           responses=responses, send=send, now=now)



@pytest.mark.parametrize("owner_matches", [True, False])
def test_existing_rate_hold_manual_resume_never_starts_replacement_chain(
        offline_phone_send, monkeypatch, owner_matches):
    import core.verification_hold as holds
    fixture = offline_phone_send
    hold = {"active": True, "account_id": 99, "detected_at": "fixture-hold",
            "code": "rate_limit_exceeded"}
    monkeypatch.setattr(holds, "get_verification_hold", lambda: hold)
    fixture.controller.config = {
        "_verification_hold_account_id": 99 if owner_matches else 100,
        "_resume_verification_hold": True,
        "_verification_hold_detected_at": "fixture-hold",
    }
    fixture.responses.append({"error": {"message": "We couldn't send text to this number"}})
    with pytest.raises(RuntimeError):
        flow._handle_add_phone_challenge(
            fixture.page, fixture.controller, device_id="fixture",
            user_agent="fixture", log=lambda message: None,
        )
    assert len(fixture.sends) == len(fixture.rents) == (1 if owner_matches else 0)
    assert len(fixture.cleanups) == (1 if owner_matches else 0)
    assert holds.get_verification_hold() == hold



@pytest.mark.parametrize("failure", ["number_in_use", "sms_timeout"])
def test_default_delivery_retry_has_no_hidden_three_number_cap(offline_phone_send, monkeypatch, failure):
    fixture = offline_phone_send
    if failure == "number_in_use":
        fixture.responses.extend([{"error": {
            "code": "phone_number_in_use", "message": "Phone number already linked",
        }} for _ in range(4)])
    else:
        original = type(fixture.controller).__call__
        def delayed_code(controller):
            if controller.phase == "need_code" and len(fixture.rents) <= 4:
                return ""
            return original(controller)
        monkeypatch.setattr(type(fixture.controller), "__call__", delayed_code)
    result = flow._handle_add_phone_challenge(
        fixture.page, fixture.controller, device_id="fixture", user_agent="fixture", log=lambda _: None,
    )
    assert result["page_type"] == "consent"
    assert len(fixture.rents) == len(fixture.sends) == 5
    assert fixture.cleanups == fixture.rents[:4]


def test_ordinary_delivery_replaces_more_than_three_numbers_sequentially(offline_phone_send):
    fixture = offline_phone_send
    fixture.responses.extend([{"error": {"message": "We couldn't send text to this number. Try WhatsApp."},
                               "oai-client-auth-session": {"phone_verification_channel": "whatsapp"}} for _ in range(4)])
    result = flow._handle_add_phone_challenge(fixture.page, fixture.controller, device_id="fixture",
                                              user_agent="fixture", log=lambda message: None)
    assert result["page_type"] == "consent"
    assert len(fixture.sends) == len(fixture.rents) == 5
    assert fixture.cleanups == fixture.rents[:4]
    assert len({number for number, _ in fixture.sends}) == 5
    assert all(after - before >= 5 for (_, before), (_, after) in zip(fixture.sends, fixture.sends[1:]))
    assert fixture.controller.rental_cleanup_confirmed is True



@pytest.mark.parametrize("sms_available", [True, False])
def test_phone_selects_offered_sms_before_renting_a_replacement(offline_phone_send, monkeypatch, sms_available):
    fixture = offline_phone_send
    channel = {"sms_available": sms_available, "sms_checked": False,
               "hidden_present": True, "hidden_sms": False, "channel": "whatsapp"}
    fixture.page.evaluate = lambda script: dict(channel)
    class Label:
        def click(self, **kwargs):
            channel.update(sms_checked=True, hidden_sms=True, channel="sms")
    class Radio:
        @property
        def first(self):
            return self
        def is_checked(self):
            return channel["sms_checked"]
        def locator(self, selector):
            return Label()
    fixture.page.locator = lambda selector: Radio()
    original = type(fixture.controller).__call__
    def rent_only_after_sms(controller):
        if controller.phase == "need_number" and sms_available:
            assert channel["sms_checked"] and channel["hidden_sms"], "SMS must be selected before a new rental"
        return original(controller)
    monkeypatch.setattr(type(fixture.controller), "__call__", rent_only_after_sms)
    def fill_switches_to_whatsapp(*args):
        channel.update(sms_checked=False, hidden_sms=False, channel="whatsapp")
        return True
    monkeypatch.setattr(flow, "_fill_input_like_user", fill_switches_to_whatsapp)
    def send_only_sms(*args, **kwargs):
        assert channel["sms_checked"] and channel["hidden_sms"], "SMS must be rechecked before submission"
        return fixture.send()
    monkeypatch.setattr(flow, "_click_first", send_only_sms)
    if sms_available:
        result = flow._handle_add_phone_challenge(fixture.page, fixture.controller,
            device_id="fixture", user_agent="fixture", log=lambda _: None)
        assert result["page_type"] == "consent"
        assert len(fixture.rents) == len(fixture.sends) == 1
    else:
        with pytest.raises(RuntimeError, match="WhatsApp.*SMS"):
            flow._handle_add_phone_challenge(fixture.page, fixture.controller,
                device_id="fixture", user_agent="fixture", log=lambda _: None)
        assert fixture.rents == fixture.sends == fixture.cleanups == []

@pytest.mark.parametrize("code", ["fraud_guard", "rate_limit_exceeded", "account_deactivated", "captcha", "security_warning"])
def test_remote_guard_precedes_ordinary_whatsapp_and_survives_cleanup(offline_phone_send, monkeypatch, code):
    fixture = offline_phone_send
    monkeypatch.setattr(flow, "activate_verification_hold", lambda *args, **kwargs: None)
    fixture.responses.append({"error": {"code": code, "message": "We couldn't send text. Try WhatsApp."},
                              "oai-client-auth-session": {"phone_verification_channel": "whatsapp"}})
    with pytest.raises(RuntimeError, match=code) as caught:
        flow._handle_add_phone_challenge(fixture.page, fixture.controller, device_id="fixture",
                                        user_agent="fixture", log=lambda message: None)
    assert len(fixture.sends) == len(fixture.rents) == len(fixture.cleanups) == 1
    assert caught.value.verification_error_code == fixture.controller.verification_error_code == code
    assert caught.value.rental_cleanup_confirmed is True


def test_unknown_remote_error_does_not_replace_number(offline_phone_send):
    fixture = offline_phone_send
    fixture.responses.append({"error": {"code": "unknown_failure", "message": "Unknown rejection"}})
    with pytest.raises(RuntimeError, match="unknown_failure"):
        flow._handle_add_phone_challenge(fixture.page, fixture.controller, device_id="fixture",
                                        user_agent="fixture", log=lambda message: None)
    assert len(fixture.sends) == len(fixture.rents) == len(fixture.cleanups) == 1



@pytest.mark.parametrize("message", [
    "HeroSMS cancellation is pending; unused rental retained",
    "phone_cleanup_pending: unresolved supplier rental",
])
def test_provider_pending_rental_is_not_reported_as_cleaned(offline_phone_send, monkeypatch, message):
    fixture = offline_phone_send
    monkeypatch.setattr(
        type(fixture.controller), "__call__",
        lambda self: (_ for _ in ()).throw(RuntimeError(message)),
    )
    with pytest.raises(RuntimeError, match="phone_cleanup_pending") as caught:
        flow._handle_add_phone_challenge(
            fixture.page, fixture.controller, device_id="fixture",
            user_agent="fixture", log=lambda _: None,
        )
    assert fixture.rents == fixture.sends == fixture.cleanups == []
    assert caught.value.rental_cleanup_confirmed is False


def test_provider_failure_stops_without_buying_another_number(offline_phone_send, monkeypatch):
    fixture = offline_phone_send
    monkeypatch.setattr(type(fixture.controller), "__call__",
                        lambda self: (_ for _ in ()).throw(RuntimeError("HeroSMS API request failed")))
    with pytest.raises(RuntimeError, match="HeroSMS") as caught:
        flow._handle_add_phone_challenge(fixture.page, fixture.controller, device_id="fixture",
                                        user_agent="fixture", log=lambda message: None)
    assert fixture.rents == fixture.sends == fixture.cleanups == []
    assert caught.value.rental_cleanup_confirmed is True


def test_ordinary_delivery_honors_explicit_attempt_ceiling(offline_phone_send):
    fixture = offline_phone_send
    fixture.responses.extend([{"error": {"message": "We couldn't send text"}} for _ in range(3)])
    with pytest.raises(RuntimeError, match="phone_delivery_failed"):
        flow._handle_add_phone_challenge(fixture.page, fixture.controller, device_id="fixture",
                                        user_agent="fixture", log=lambda message: None, max_phone_attempts=2)
    assert len(fixture.sends) == len(fixture.rents) == len(fixture.cleanups) == 2


def test_failed_number_is_never_submitted_again(offline_phone_send):
    fixture = offline_phone_send
    fixture.controller.repeat_number = True
    fixture.responses.append({"error": {"message": "We couldn't send text to this number"}})
    with pytest.raises(RuntimeError, match="phone_number_reused"):
        flow._handle_add_phone_challenge(fixture.page, fixture.controller, device_id="fixture",
                                        user_agent="fixture", log=lambda message: None)
    assert len(fixture.sends) == 1 and len(fixture.rents) == len(fixture.cleanups) == 2


def test_phone_native_request_prevents_form_fallback(offline_phone_send, monkeypatch):
    fixture, fallbacks = offline_phone_send, []
    monkeypatch.setattr(flow, "_click_first", lambda *args, **kwargs: (fixture.send(), None)[1])
    monkeypatch.setattr(flow, "_submit_form_with_fallback", lambda *args: fallbacks.append(True) or True)
    result = flow._do_add_phone_attempt(fixture.page, fixture.controller, device_id="fixture",
                                       user_agent="fixture", log=lambda message: None)
    assert result["page_type"] == "consent"
    assert len(fixture.sends) == 1 and fallbacks == []


@pytest.mark.parametrize("request_before_exception", [True, False])
def test_phone_click_exception_after_request_does_not_click_another_button(monkeypatch, request_before_exception):
    clicks, sent = [], [False]
    class Target:
        @property
        def first(self): return self
        def count(self):
            if clicks: sent[0] = True
            return 1
        def click(self, **kwargs):
            clicks.append(True)
            sent[0] = request_before_exception
            raise RuntimeError("click completed but navigation timed out")
    result = flow._click_first(SimpleNamespace(locator=lambda selector: Target()), ["button:first", "button:second"],
                               timeout=1, stop_if=lambda: sent[0])
    assert result and clicks == [True]


def test_guard_metadata_survives_unconfirmed_cleanup(offline_phone_send, monkeypatch):
    fixture = offline_phone_send
    monkeypatch.setattr(flow, "activate_verification_hold", lambda *args, **kwargs: None)
    fixture.controller.cleanup = lambda: False
    fixture.responses.append({"error": {"code": "fraud_guard", "message": "Could not send text. WhatsApp"}})
    with pytest.raises(RuntimeError, match="phone_cleanup_pending") as caught:
        flow._handle_add_phone_challenge(fixture.page, fixture.controller, device_id="fixture",
                                        user_agent="fixture", log=lambda message: None)
    assert caught.value.verification_error_code == fixture.controller.verification_error_code == "fraud_guard"
    assert caught.value.rental_cleanup_confirmed is False
    assert len(fixture.sends) == len(fixture.rents) == 1 and fixture.controller.activation is not None


def test_phone_cancellation_during_delivery_pacing_retains_guard_metadata(offline_phone_send):
    fixture = offline_phone_send
    class Logger:
        def log(self, message): pass
        def is_cancel_requested(self): return fixture.now[0] > 0
    fixture.responses.append({"error": {"message": "We couldn't send text to this number"}})
    with pytest.raises(RuntimeError, match="phone_retry_cancelled"):
        flow._handle_add_phone_challenge(fixture.page, fixture.controller, device_id="fixture",
                                        user_agent="fixture", log=Logger().log)
    assert len(fixture.sends) == len(fixture.rents) == 1 and fixture.controller.rental_cleanup_confirmed is True


def test_failed_oauth_preserves_sanitized_blocking_cause(monkeypatch):
    page = SimpleNamespace(context=SimpleNamespace(cookies=lambda: []))
    class Browser:
        def __enter__(self): return self
        def __exit__(self, *args): return False
        def new_page(self): return page
    def oauth(*args, **kwargs):
        kwargs["failure_context"].update(security_error="phone_cleanup_pending: cancellation not confirmed",
                                        verification_error_code="fraud_guard", rental_cleanup_confirmed=False)
        return None
    checkpoints = []
    monkeypatch.setattr(flow, "Camoufox", lambda **kwargs: Browser())
    monkeypatch.setattr(flow, "_do_codex_oauth", oauth)
    worker = flow.ChatGPTBrowserRegister(headless=True, log_fn=lambda message: None, security_checkpoint=checkpoints.append)
    result = worker.run("original@example.com", "", resume=True)
    assert result["security_error"].startswith("phone_cleanup_pending")
    assert checkpoints[0]["security_error"] == result["security_error"]
    assert checkpoints[0]["verification_error_code"] == result["verification_error_code"] == "fraud_guard"
    assert checkpoints[0]["rental_cleanup_confirmed"] is result["rental_cleanup_confirmed"] is False


def test_phone_country_requires_coherent_selected_label(monkeypatch):
    monkeypatch.setattr(flow.time, "sleep", lambda seconds: None)
    options = flow.ChatGPTBrowserRegister(headless=True)._launch_options()
    with flow.Camoufox(**options, timeout=60000) as browser:
        page = browser.new_page()
        page.route("**/*", lambda route: route.abort())
        for label in ("(+44)", "+44", "United States (+44)", "Royaume-Uni (+44)"):
            options = f'<option value="US">United States (+1)</option><option value="GB" selected>{label}</option>' + ''.join(f'<option value="X{i}">Other (+9)</option>' for i in range(8))
            page.set_content('<html lang="fr"><select>' + options + '</select><button aria-haspopup="listbox">United States (+44)</button></html>')
            assert not flow._select_phone_country_ui(page, "44", "United Kingdom", lambda message: None)
        page.locator('button').evaluate("el => el.textContent = 'Royaume-Uni  (+44)'")
        assert flow._select_phone_country_ui(page, "44", "United Kingdom", lambda message: None)
        page.locator('option[value=GB]').evaluate("el => el.textContent = '(+44)'")
        assert flow._select_phone_country_ui(page, "44", "United Kingdom", lambda message: None)


@pytest.mark.parametrize("sms_disabled", [False, True])
def test_phone_auto_whatsapp_prefers_only_enabled_sms(monkeypatch, sms_disabled):
    events, posts = [], []
    monkeypatch.setattr(flow.time, "sleep", lambda seconds: None)
    monkeypatch.setattr(flow, "_browser_pause", lambda *args, **kwargs: None)
    monkeypatch.setattr(flow, "_wait_for_openai_browser_check", lambda *args: None)
    monkeypatch.setattr(flow, "_select_phone_country_ui", lambda *args: True)
    monkeypatch.setattr(flow, "_click_first", lambda *args, **kwargs: None)
    monkeypatch.setattr(flow, "_dump_debug", lambda *args: None)
    monkeypatch.setattr(flow, "_submit_otp_via_page", lambda *args: {"ok": True, "status": 200,
        "url": "https://auth.openai.com/sign-in-with-chatgpt/codex/consent"})

    class Callback:
        def __call__(self):
            events.append("poll" if "rent" in events else "rent")
            return "123456" if events[-1] == "poll" else "+447700900123"

        def mark_send_succeeded(self):
            events.append("sent")

        def mark_send_failed(self, reason):
            events.append("failed")

        def report_success(self):
            events.append("verified")

    disabled = "disabled" if sms_disabled else ""
    html = f"""<form><input name="phoneNumber" type="tel" required>
      <label><input type="radio" name="choice" value="sms" {disabled}>Text Message</label>
      <label><input type="radio" name="choice" value="whatsapp">WhatsApp</label>
      <input type="hidden" name="channel" value="sms"><button>Continue</button></form>
      <script>
        const sms = document.querySelector('[value=sms][type=radio]'), wa = document.querySelector('[value=whatsapp]');
        const channel = document.querySelector('[name=channel]');
        document.querySelector('[type=tel]').addEventListener('input', () => {{wa.checked=true;sms.checked=false;channel.value='whatsapp';}});
        for (const input of [sms,wa]) input.addEventListener('change', () => {{channel.value=input.value;}});
        document.querySelector('form').addEventListener('submit', event => {{
          event.preventDefault();
          fetch('/api/accounts/add-phone/send', {{method:'POST',headers:{{'Content-Type':'application/json'}},body:JSON.stringify({{phone_number:'+447700900123',channel:channel.value}})}})
            .then(() => {{document.body.innerHTML='<input name="code" autocomplete="one-time-code">';}});
        }});
      </script>"""
    options = flow.ChatGPTBrowserRegister(headless=True)._launch_options()
    with flow.Camoufox(**options, timeout=60000) as browser:
        page = browser.new_page()
        def serve(route):
            if route.request.method == "POST":
                posts.append(route.request.post_data_json["channel"])
                route.fulfill(status=200, content_type="application/json", body='{"page":{"type":"phone_otp_verification"}}')
            else:
                route.fulfill(status=200, content_type="text/html", body=html)
        page.route("**/*", serve)
        page.goto("https://auth.openai.com/add-phone", wait_until="load")
        monkeypatch.setattr(type(page.locator('input')), "click", lambda *args, **kwargs: (_ for _ in ()).throw(RuntimeError("synthetic native click failure")))
        if sms_disabled:
            with pytest.raises(RuntimeError, match="WhatsApp.*SMS"):
                flow._handle_add_phone_challenge(page, Callback(), device_id="fixture", user_agent="fixture", log=lambda message: None)
            assert events == ["rent", "failed"] and posts == []
        else:
            result = flow._handle_add_phone_challenge(page, Callback(), device_id="fixture", user_agent="fixture", log=lambda message: None)
            assert result["page_type"] == "consent"
            assert events == ["rent", "sent", "poll", "verified"] and posts == ["sms"]


@pytest.mark.parametrize("country_selected, otp_ready", [(False, False), (True, False), (True, True), (True, "generic"), (True, "whatsapp"), (True, "whatsapp_response"), ("browser_check", False)])
def test_phone_send_requires_distinct_otp_before_polling(monkeypatch, country_selected, otp_ready):
    events, messages, listeners = [], [], {}

    class Callback:
        def __call__(self):
            events.append("poll" if "rent" in events else "rent")
            return "123456" if events[-1] == "poll" else "+447700900123"

        def set_resend_callback(self, callback):
            pass

        def mark_send_succeeded(self):
            events.append("sent")

        def mark_send_failed(self, reason):
            events.append("failed")

        def report_success(self):
            events.append("verified")

    page = SimpleNamespace(url="https://auth.openai.com/add-phone",
        evaluate=lambda script: {"sms_available": False, "channel": "sms"},
        on=lambda event, callback: listeners.update({event: callback}),
        remove_listener=lambda event, callback: listeners.pop(event))
    monkeypatch.setattr(flow.time, "sleep", lambda seconds: None)
    monkeypatch.setattr(flow, "_browser_pause", lambda *args, **kwargs: None)
    monkeypatch.setattr(flow, "_dump_debug", lambda *args: None)
    def wait_for_browser_check(*args):
        events.append("ready")
        if country_selected == "browser_check":
            raise RuntimeError("OpenAI browser check did not clear")

    monkeypatch.setattr(flow, "_wait_for_openai_browser_check", wait_for_browser_check)
    monkeypatch.setattr(flow, "_select_phone_country_ui", lambda *args: country_selected)
    monkeypatch.setattr(flow, "_fill_input_like_user", lambda *args: True)
    monkeypatch.setattr(flow, "_extract_auth_error_text", lambda *args: "")
    monkeypatch.setattr(flow, "_wait_for_any_selector", lambda page, selectors, **kwargs:
        "input[name=phone]" if selectors == flow.PHONE_INPUT_SELECTORS else "input[random]" if otp_ready == "generic" and any("maxlength" in selector for selector in selectors) else "input[name=code]" if otp_ready is True else None)

    def send(*args, **kwargs):
        request = SimpleNamespace(method="POST", url="https://auth.openai.com/api/accounts/add-phone/send?private=query-secret",
            post_data_json={"phone_number": "+447700900123", "channel": "whatsapp" if otp_ready == "whatsapp" else "sms"})
        listeners["request"](request)
        listeners["response"](SimpleNamespace(request=request, url=request.url, status=200, json=lambda:
            {"page": {"type": "phone_otp_verification"}, "oai-client-auth-session": {"phone_verification_channel": "whatsapp"}} if otp_ready == "whatsapp_response" else {"page": {"type": "phone_otp_verification"}} if otp_ready in (True, "generic", "whatsapp") else {"error": {
            "message": "private@example.com 654321"}}))
        return "button"

    monkeypatch.setattr(flow, "_click_first", send)
    monkeypatch.setattr(flow, "_submit_otp_via_page", lambda *args: {"ok": True, "status": 200,
        "url": "https://auth.openai.com/sign-in-with-chatgpt/codex/consent"})
    if not country_selected or not otp_ready or otp_ready in {"whatsapp", "whatsapp_response"} or country_selected == "browser_check":
        with pytest.raises(RuntimeError, match="国家选择未同步|未进入短信验证码|phone_send_error|WhatsApp|browser check did not clear"):
            flow._handle_add_phone_challenge(page, Callback(), device_id="fixture", user_agent="fixture", log=messages.append)
        assert events == (["ready"] if country_selected == "browser_check" else ["ready", "rent", "failed"])
    else:
        result = flow._handle_add_phone_challenge(page, Callback(), device_id="fixture", user_agent="fixture", log=messages.append)
        assert result["page_type"] == "consent"
        assert events == ["ready", "rent", "sent", "poll", "verified"]
    assert listeners == {}
    trace = "\n".join(message for message in messages if message.startswith("phone_send"))
    assert not any(value in trace for value in ("query-secret", "private@example.com", "654321", "447700900123"))
    if country_selected and country_selected != "browser_check":
        assert "path=/api/accounts/add-phone/send" in trace and '"status": 200' in trace
        assert '"destination_matches_rental": true' in trace
        assert '"payload_fields": ["channel", "phone_number"]' in trace
        assert '"delivery_method": "whatsapp"' in trace if otp_ready in {"whatsapp", "whatsapp_response"} else '"delivery_method": "sms"' in trace


def test_signup_checkpoints_identity_before_same_browser_oauth(monkeypatch):
    events, checkpoints = [], []
    cookies = [{"name": "fixture-session", "value": "fixture-value", "domain": ".chatgpt.com", "path": "/"}]
    page = SimpleNamespace(context=SimpleNamespace(cookies=lambda: cookies))

    class Browser:
        def __enter__(self):
            return self

        def __exit__(self, *args):
            events.append("closed")

        def new_page(self):
            return page

    monkeypatch.setattr(flow, "Camoufox", lambda **kwargs: Browser())
    monkeypatch.setattr(flow, "_browser_registration_flow", lambda *args: {"page_type": "chatgpt_home", "password_set": False})
    worker = flow.ChatGPTBrowserRegister(headless=True, log_fn=lambda message: None,
        security_checkpoint=lambda checkpoint: (events.append("checkpoint"), checkpoints.append(checkpoint)))

    def oauth(active_page, email, password):
        assert active_page is page
        assert events == ["checkpoint"]
        events.append("oauth")
        return None

    monkeypatch.setattr(worker, "_complete_oauth_in_page", oauth)
    monkeypatch.setattr(worker, "_retry_oauth_fresh_browser", lambda *args: pytest.fail("Signup must reuse its browser"))
    result = worker.run("original@example.com", "unused-generated-password")
    assert events == ["checkpoint", "oauth", "checkpoint", "closed"]
    checkpoint = checkpoints[0]
    assert checkpoint["email"] == result["email"] == "original@example.com"
    assert checkpoint["password"] == result["password"] == ""
    assert checkpoint["password_set"] is False and checkpoint["status"] == "phone_required"
    assert json.loads(checkpoint["cookies"]) == cookies
    assert not any(key in checkpoint for key in ("account_id", "access_token", "refresh_token", "id_token", "workspace_id"))


@pytest.mark.parametrize("reject", [True, False])
def test_oauth_validation_precedes_checkpoint_and_mfa(monkeypatch, reject):
    from platforms.chatgpt import plugin
    events = []
    page = SimpleNamespace(context=SimpleNamespace(cookies=lambda: []))

    class Browser:
        def __enter__(self):
            return self

        def __exit__(self, *args):
            return False

        def new_page(self):
            return page

    def validate(result, *, expected_email):
        assert expected_email == "original@example.com"
        assert events == []
        events.append("validate")
        if reject:
            raise RuntimeError("fixture invalid callback")

    monkeypatch.setattr(flow, "Camoufox", lambda **kwargs: Browser())
    monkeypatch.setattr(flow, "_do_codex_oauth", lambda *args, **kwargs: {
        "email": "original@example.com", "account_id": "fixture-account", "access_token": "fixture-access",
        "refresh_token": "fixture-refresh", "id_token": "fixture-id"})
    monkeypatch.setattr(plugin, "_assert_complete_oauth_callback", validate)
    monkeypatch.setattr(flow, "_complete_chatgpt_security", lambda *args: events.append("mfa"))
    worker = flow.ChatGPTBrowserRegister(headless=True, phone_callback=SimpleNamespace(completed=True, phone_verification_succeeded=True),
        log_fn=lambda message: None, security_checkpoint=lambda state: events.append("checkpoint"))
    result = worker._retry_oauth_fresh_browser("original@example.com", "")
    assert events == (["validate"] if reject else ["validate", "checkpoint", "mfa"])
    assert (result is None) is reject
    if reject:
        assert set(worker.security_progress) == {"security_error"}
        assert "fixture invalid callback" in worker.security_progress["security_error"]


def test_camoufox_react_controlled_form_submission(monkeypatch):
    modules = Path("frontend/node_modules")
    scripts = "window.fixtureModules = {}; function require(name) { return window.fixtureModules[name]; }"
    for name, source in (
        ("react", "react/cjs/react.production.js"),
        ("scheduler", "scheduler/cjs/scheduler.production.js"),
        ("react-dom", "react-dom/cjs/react-dom.production.js"),
        ("react-dom/client", "react-dom/cjs/react-dom-client.production.js"),
    ):
        scripts += "(function(){const module={exports:{}};const exports=module.exports;" + (modules / source).read_text(encoding="utf-8") + "\nwindow.fixtureModules[" + json.dumps(name) + "]=module.exports;})();"
    html = '<div id="root"></div><script>' + scripts + """
      const React = require('react');
      function App() {
        const [name, setName] = React.useState('');
        const [age, setAge] = React.useState('');
        const didInitiateSubmit = React.useRef(false);
        return React.createElement('form', {onSubmit(event) {
          event.preventDefault();
          const initiated = didInitiateSubmit.current;
          didInitiateSubmit.current = false;
          if (!initiated) { window.submitWithoutClickBlocked = true; return; }
          window.reactStateMatches = name === 'Fixture User' && age === '21';
          fetch('/mock-profile', {method: 'POST', body: 'synthetic-fixture'});
        }}, React.createElement('input', {name: 'name', value: name, required: true, onChange: event => setName(event.target.value)}),
        React.createElement('input', {name: 'age', type: 'number', min: 18, value: age, required: true, onChange: event => setAge(event.target.value)}),
        React.createElement('input', {name: 'birthday', type: 'hidden', value: age ? '2001-12-25' : '', readOnly: true}),
        React.createElement('button', {type: 'submit', name: 'intent', value: 'resend', onClick: () => {window.resendClicks = (window.resendClicks || 0) + 1;}}, 'Resend email'),
        React.createElement('button', {type: 'submit', name: 'intent', value: 'continue', onClick: () => {didInitiateSubmit.current = true;}}, 'Continue'));
      }
      require('react-dom/client').createRoot(document.getElementById('root')).render(React.createElement(App));
      </script>"""
    posts = []
    options = flow.ChatGPTBrowserRegister(headless=True)._launch_options()
    with flow.Camoufox(**options, timeout=60000) as browser:
        page = browser.new_page()

        def serve(route):
            if route.request.method == "POST":
                posts.append(route.request.post_data)
                route.fulfill(status=200, content_type="application/json", body="{}")
            else:
                route.fulfill(status=200, content_type="text/html", body=html)

        page.route("**/*", serve)
        page.goto("https://fixture.test/form", wait_until="load")
        page.locator('input[name=name]').wait_for(state="visible", timeout=5000)
        assert flow._submit_form_with_fallback(page, 'input[name=name]')
        assert posts == []
        page.reload(wait_until="load")
        page.locator('input[name=name]').wait_for(state="visible", timeout=5000)
        monkeypatch.setattr(type(page.locator('input')), "click", lambda *args, **kwargs: (_ for _ in ()).throw(RuntimeError("synthetic click failure")))
        assert flow._fill_input_like_user(page, 'input[name=name]', "Fixture User")
        assert flow._fill_input_like_user(page, 'input[name=age]', "21")
        assert flow._sync_hidden_birthday_input(page, "2001-12-25", lambda message: None)
        page.evaluate("document.querySelector('form').requestSubmit(document.querySelector('button[value=continue]'))")
        assert page.evaluate("mw:window.submitWithoutClickBlocked")
        assert posts == []
        page.evaluate("document.querySelector('button[value=continue]').disabled = true")
        assert not flow._submit_form_with_fallback(page, 'input[name=name]')
        assert posts == []
        page.evaluate("document.querySelector('button[value=continue]').disabled = false")
        with page.expect_response(lambda response: response.request.method == "POST" and response.url.endswith("/mock-profile"), timeout=5000):
            assert flow._submit_form_with_fallback(page, 'input[name=name]')
        assert page.evaluate("mw:window.reactStateMatches")
        assert posts == ["synthetic-fixture"]
        assert page.evaluate("mw:window.resendClicks || 0") == 0
        page.evaluate("document.querySelector('button[value=continue]').remove()")
        assert not flow._submit_form_with_fallback(page, 'input[name=name]')
        assert posts == ["synthetic-fixture"]


@pytest.mark.parametrize("start_url, next_url, accepted, response_path, response_status, error_code", [
    ("https://auth.openai.com/add-phone", "https://auth.openai.com/add-phone", False, "/awe/api/v2/rum", 400, "invalid_input"),
    ("https://auth.openai.com/add-phone", "https://auth.openai.com/sign-in-with-chatgpt/codex/consent", True, "/awe/api/v2/rum", 400, "invalid_input"),
    ("https://auth.openai.com/add-phone", "https://auth.openai.com/email-verification", False, "/api/accounts/email-otp/validate", 403, "account_deactivated"),
    ("https://auth.openai.com/add-phone", "https://auth.openai.com/sign-in-with-chatgpt/codex/consent", False, "/api/accounts/email-otp/validate", 429, "rate_limit_exceeded"),
    ("https://auth.openai.com/add-phone", "https://auth.openai.com/sign-in-with-chatgpt/codex/consent", True, "/api/accounts/email-otp/validate", 200, ""),
    ("https://auth.openai.com/email-verification", "https://auth.openai.com/mfa-challenge/fixture", True, "/api/accounts/email-otp/validate", 200, ""),
    ("https://auth.openai.com/email-verification", "https://auth.openai.com/mfa", True, "/api/accounts/email-otp/validate", 200, ""),
    ("https://auth.openai.com/email-verification", "https://auth.openai.com/mfa-challenge/fixture", False, "/api/accounts/email-otp/validate", 429, "rate_limit_exceeded"),
    ("https://auth.openai.com/email-verification", "https://fixture.test/mfa-challenge/fixture", False, "/api/accounts/email-otp/validate", 200, ""),
    ("https://auth.openai.com/mfa-challenge/fixture", "https://auth.openai.com/mfa-challenge/fixture?nonce=fixture", False, "/api/accounts/email-otp/validate", 200, ""),
])
def test_otp_requires_transition_and_respects_validation_rejection(
        monkeypatch, start_url, next_url, accepted, response_path, response_status, error_code):
    class Target:
        first = property(lambda self: self)

        def count(self):
            return 0

        def wait_for(self, **kwargs):
            raise RuntimeError("use input fallback")

        def is_visible(self, **kwargs):
            return False

        def text_content(self, **kwargs):
            return ""

    listeners, captures, messages, submissions = {}, [], [], []

    class MemoryCapture(StringIO):
        def __exit__(self, *args):
            captures.append(self.getvalue())
            return super().__exit__(*args)

    monkeypatch.setattr(flow, "open", lambda *args, **kwargs: MemoryCapture(), raising=False)
    page = SimpleNamespace(
        url=start_url,
        wait_for_load_state=lambda *args, **kwargs: None,
        locator=lambda *args, **kwargs: Target(),
        get_by_label=lambda *args, **kwargs: Target(),
        get_by_role=lambda *args, **kwargs: Target(),
        on=lambda event, callback: listeners.update({event: callback}),
        remove_listener=lambda event, callback: listeners.pop(event),
        content=lambda: "<html>test-only capture</html>",
        evaluate=lambda script: {"path": "/add-phone", "inputs": [{"name": "code", "value_length": 6, "validity": {"valid": True}}],
                                 "buttons": [{"name": "intent", "value": "654321", "text": "private@example.com", "disabled": False}]},
    )
    clock = iter([0.0, 0.0, 1.0])
    monkeypatch.setattr(flow.time, "time", lambda: next(clock))
    monkeypatch.setattr(flow.time, "sleep", lambda seconds: None)
    monkeypatch.setattr(flow, "_browser_pause", lambda *args, **kwargs: None)
    monkeypatch.setattr(flow, "_fill_input_like_user", lambda *args: True)
    def submit(*args, **kwargs):
        submissions.append("submit")
        request = SimpleNamespace(method="POST", url="https://auth.openai.com" + response_path + "?code=654321",
                                  failure="NS_ERROR_ABORT https://auth.openai.com" + response_path + "?code=654321")
        listeners["request"](request)
        listeners["response"](SimpleNamespace(request=request, status=response_status,
            json=lambda: {"error": {"code": error_code, "type": "otp", "message": "private@example.com 654321"}}))
        listeners["requestfailed"](request)
        page.url = next_url
        return "button"

    monkeypatch.setattr(flow, "_click_first", submit)
    result = flow._submit_otp_via_page(page, "123456", messages.append, timeout=0.5)
    rejected = response_path == "/api/accounts/email-otp/validate" and response_status >= 400
    assert result["ok"] is accepted
    assert result["status"] == (response_status if rejected else 200 if accepted else 0)
    if rejected:
        assert error_code in result["text"]
        assert result["data"]["error"]["code"] == error_code
    assert submissions == ["submit"]
    assert listeners == {}
    assert len(captures) == (0 if accepted or rejected else 1)
    trace = "\n".join(messages) + json.dumps(result)
    assert "OTP POST response" in trace and "OTP POST failed" in trace
    assert "654321" not in trace and "private@example.com" not in trace and "?code=" not in trace
    assert ("OTP timeout form" in trace) is (not accepted and not rejected)


@pytest.mark.parametrize("has_authenticator_secret", [True, False])
def test_oauth_email_otp_hands_off_to_authenticator_in_same_page(monkeypatch, has_authenticator_secret, vault_callback=None):
    from itertools import count
    from platforms.chatgpt import oauth

    class Target:
        first = property(lambda self: self)
        def count(self): return 0
        def wait_for(self, **kwargs): raise RuntimeError("use input fallback")
        def is_visible(self, **kwargs): return False
        def text_content(self, **kwargs): return ""

    listeners, typed, mail_requests, messages = {}, [], [], []
    email_url = "https://auth.openai.com/email-verification"
    mfa_url = "https://auth.openai.com/mfa-challenge/fixture"
    callback_url = "http://localhost:1455/auth/callback?code=fixture-code&state=fixture-state"
    page = SimpleNamespace(
        url=email_url, evaluate=lambda script: "fixture-agent",
        wait_for_load_state=lambda *args, **kwargs: None,
        locator=lambda *args, **kwargs: Target(),
        get_by_label=lambda *args, **kwargs: Target(),
        get_by_role=lambda *args, **kwargs: Target(),
        on=lambda event, callback: listeners.update({event: callback}),
        remove_listener=lambda event, callback: listeners.pop(event),
        content=lambda: "<html>test-only capture</html>",
    )
    monkeypatch.setattr(flow, "open", lambda *args, **kwargs: StringIO(), raising=False)
    monkeypatch.setattr(oauth, "generate_oauth_url", lambda **kwargs: SimpleNamespace(
        auth_url=email_url, state="fixture-state"))
    monkeypatch.setattr(flow, "_navigate", lambda current, url, **kwargs: setattr(current, "url", url))
    monkeypatch.setattr(flow, "_wait_for_openai_browser_check", lambda *args: None)
    monkeypatch.setattr(flow, "_derive_oauth_state_from_page", lambda current: {
        "page_type": "email_otp_verification", "continue_url": ""})
    monkeypatch.setattr(flow, "_get_page_oauth_url", lambda current: "")
    monkeypatch.setattr(flow, "_browser_pause", lambda *args, **kwargs: None)
    monkeypatch.setattr(flow.time, "time", lambda counter=count(0, 100): next(counter))
    monkeypatch.setattr(flow.time, "sleep", lambda seconds: None)
    def fill(current, selector, value):
        assert current is page
        typed.append(value)
        return True
    def submit(current, *args, **kwargs):
        assert current is page
        if current.url == email_url:
            request = SimpleNamespace(method="POST", url="https://auth.openai.com/api/accounts/email-otp/validate")
            listeners["response"](SimpleNamespace(request=request, status=200, json=lambda: {}))
            current.url = mfa_url
        else:
            assert current.url == mfa_url
            current.url = callback_url
        return "button"
    monkeypatch.setattr(flow, "_fill_input_like_user", fill)
    monkeypatch.setattr(flow, "_click_first", submit)
    def totp(secret):
        assert secret == "fixture-saved-secret"
        return "654321"
    monkeypatch.setattr(flow, "totp_code", totp)
    tokens = {"email": "original@example.com", "account_id": "saved-account",
              "access_token": "fixture-access", "refresh_token": "fixture-refresh", "id_token": "fixture-id"}
    monkeypatch.setattr(flow, "_submit_callback_result", lambda *args: tokens)
    def mailbox_code():
        mail_requests.append("mailbox")
        return "123456"
    failure = {}
    result = flow._do_codex_oauth(
        page, {}, "original@example.com", "", mailbox_code, None, None, messages.append,
        totp_secret="fixture-saved-secret" if has_authenticator_secret else "",
        failure_context=failure, login_only=True,
        **({"totp_callback": vault_callback} if vault_callback else {}),
    )
    assert mail_requests == ["mailbox"]
    assert listeners == {}
    if has_authenticator_secret or vault_callback:
        assert result == tokens
        assert typed == ["123456", "654321"]
        assert page.url == callback_url
    else:
        assert result is None
        assert typed == ["123456"]
        assert "认证器密钥" in failure["security_error"]


def test_oauth_uses_existing_vault_code_without_a_saved_seed(monkeypatch):
    fetched = []
    def code():
        fetched.append("matching-vault-code")
        return "654321"
    test_oauth_email_otp_hands_off_to_authenticator_in_same_page(monkeypatch, False, code)
    assert fetched == ["matching-vault-code"]


@pytest.mark.parametrize("entries, accepted", [
    ([{"issuer": "OpenAI", "label": "original@example.com", "code": "654321", "remaining": 25}], True),
    ([{"issuer": "OpenAI", "label": "other@example.com", "code": "654321", "remaining": 25}], False),
    ([{"issuer": "OpenAI", "label": "original@example.com", "code": "654321", "remaining": 25},
      {"issuer": "OpenAI", "label": "original@example.com", "code": "123456", "remaining": 25}], False),
])
def test_refresh_login_uses_only_one_exact_vault_account(monkeypatch, entries, accepted):
    import api.authenticator as authenticator
    from core.base_platform import Account, RegisterConfig
    from platforms.chatgpt.plugin import ChatGPTPlatform

    monkeypatch.setattr(authenticator, "_native_entries", lambda: {"status": "ready", "entries": entries})
    platform = object.__new__(ChatGPTPlatform)
    platform.config = RegisterConfig()
    platform.mailbox = None
    platform._log_fn = lambda message: None
    account = Account(platform="chatgpt", email="original@example.com", password="fixture-password")
    def login(worker, email, password):
        assert worker.security_progress.get("totp_secret") is None
        return {"code": worker.totp_callback()}
    monkeypatch.setattr(flow.ChatGPTBrowserRegister, "login", login)
    if accepted:
        assert platform._login_for_refresh(account) == {"code": "654321"}
    else:
        with pytest.raises(RuntimeError):
            platform._login_for_refresh(account)



@pytest.mark.parametrize("previously_verified, just_verified", [(True, False), (False, True), (False, False)])
def test_failed_oauth_checkpoints_cookies_without_promoting_account(monkeypatch, previously_verified, just_verified):
    cookies = [{"name": "session-test", "value": "test-value", "domain": ".chatgpt.com", "path": "/"}]
    page = SimpleNamespace(context=SimpleNamespace(cookies=lambda: cookies, add_cookies=lambda values: None))

    class Browser:
        def __enter__(self):
            return self

        def __exit__(self, *args):
            return False

        def new_page(self):
            return page

    checkpoints = []
    monkeypatch.setattr(flow, "Camoufox", lambda **kwargs: Browser())
    monkeypatch.setattr(flow, "_do_codex_oauth", lambda *args, **kwargs: None)
    worker = flow.ChatGPTBrowserRegister(
        headless=True, log_fn=lambda message: None, security_checkpoint=checkpoints.append,
        phone_callback=SimpleNamespace(completed=True, phone_verification_succeeded=just_verified),
        security_progress={"phone_verified": previously_verified, "access_token": "stale-test-token"},
    )
    result = worker.run("original@example.com", "test-password", resume=True)
    assert json.loads(worker.security_progress["cookies"]) == cookies
    assert len(checkpoints) == 1
    assert checkpoints[0]["email"] == result["email"] == "original@example.com"
    assert checkpoints[0]["password"] == result["password"] == "test-password"
    phone_verified = previously_verified or just_verified
    assert checkpoints[0]["status"] == result["status"] == ("2fa_required" if phone_verified else "phone_required")
    assert checkpoints[0]["phone_verified"] is phone_verified
    assert not any(key in checkpoints[0] for key in ("access_token", "refresh_token", "id_token", "account_id", "workspace_id"))


def test_about_you_translated_implicit_submit_and_validation_retry(monkeypatch):
    from platforms.chatgpt import constants

    monkeypatch.setattr(constants, "generate_random_user_info", lambda: {"name": "Test User", "birthdate": "2001-12-25"})
    monkeypatch.setattr(flow, "_click_first", lambda *args, **kwargs: None)
    monkeypatch.setattr(flow, "_browser_pause", lambda *args, **kwargs: None)
    monkeypatch.setattr(flow.time, "sleep", lambda seconds: None)
    monkeypatch.setattr(flow, "_dump_debug", lambda *args: None)
    launch_options = flow.ChatGPTBrowserRegister(headless=True)._launch_options()
    with flow.Camoufox(**launch_options, timeout=60000) as browser:
        page = browser.new_page()

        def serve(route):
            if route.request.resource_type == "script":
                route.fulfill(status=200, content_type="application/javascript", body="""console.error('Sentinel failed private@example.com 654321 state=short-private authstate="quoted-private" nonce-testnonce'); throw new Error('SDK failure https://sentinel.openai.com/sdk.js?token=query-secret');""")
            elif route.request.method == "POST":
                if route.request.post_data == "failure":
                    route.abort("failed")
                    return
                status = 400 if route.request.post_data == "retry" else 200
                route.fulfill(status=status, content_type="application/json", body=json.dumps({
                    "error": {"code": "invalid_input", "type": "test_profile", "param": "age", "message": "never-log-private@example.com 654321"},
                    "continue_url": "https://auth.openai.com/add-phone?code=654321",
                }))
            else:
                route.fulfill(status=200, content_type="text/html", body="""
                  <html lang="es"><body><form>
                    <label>Nombre completo<input name="name" required></label>
                    <label>Edad<input name="age" required></label>
                    <input type="hidden" name="birthday">
                    <button name="intent" value="crear">Finalizar creación de cuenta</button>
                  </form><div role="alert"></div></body></html>
                """)

        page.route("**/*", serve)
        for mode in ("success", "retry", "failure"):
            page.goto("https://auth.openai.com/about-you", wait_until="domcontentloaded")
            page.evaluate("""mw:mode => {
              window.submissions = [];
              document.querySelector('form').addEventListener('submit', event => {
                event.preventDefault();
                window.submissions.push({
                  intent: event.submitter?.value,
                  name: new FormData(event.target).get('name'),
                  age: new FormData(event.target).get('age'),
                });
                const attempt = mode === 'retry' && window.submissions.length === 1 ? 'retry' : mode === 'failure' ? 'failure' : 'success';
                fetch('/api/accounts/create?private=query-secret', {method: 'POST', body: attempt})
                  .then(response => response.json()).then(() => {
                    if (attempt === 'retry') {
                      document.querySelector('[role=alert]').textContent = "doesn't look right";
                    } else {
                      document.querySelector('[role=alert]').textContent = '';
                      history.replaceState({}, '', '/add-phone');
                    }
                  }).catch(() => {
                    performance.mark('hydration_end');
                    window.__loginWebSentinelSdkReady = Promise.resolve();
                    window.SentinelSDK = {init() {}};
                    const script = document.createElement('script');
                    script.src = 'https://sentinel.openai.com/sdk.js?token=query-secret';
                    script.onload = () => { document.querySelector('[role=alert]').textContent = 'transport failure'; };
                    document.head.append(script);
                  });
              });
            }""", mode)
            messages = []
            result = flow._submit_about_you_via_page(page, messages.append)
            assert result["ok"] is (mode != "failure")
            submissions = page.evaluate("mw:window.submissions")
            assert len(submissions) == (2 if mode == "retry" else 1)
            assert all(item["intent"] == "crear" and item["name"] == "Test User" and item["age"] for item in submissions)
            trace = "\n".join(message for message in messages if message.startswith("about_you POST") or message.startswith("about_you failure form:"))
            assert "path=/api/accounts/create" in trace
            if mode == "failure":
                assert "POST failed" in trace
                state = json.loads(next(message.split(": ", 1)[1] for message in messages if message.startswith("about_you failure form:")))
                assert state["forms"][0]["valid"]
                assert state["globals"]["__loginWebSentinelSdkReady"] == "object"
                assert state["globals"]["__submitPendingForm"] == "undefined"
                assert state["sentinel_init_available"]
                assert state["performance_marks"]["hydration_end"]
                assert {"origin": "https://sentinel.openai.com", "path": "/sdk.js", "status": 200} in state["resource_responses"]
                assert any(item["origin"] == "https://sentinel.openai.com" and item["path"] == "/sdk.js" for item in state["script_resources"])
                assert {item["type"] for item in state["page_errors"]} == {"pageerror", "console"}
                assert not any(secret in trace for secret in ("short-private", "quoted-private", "testnonce", "query-secret", "private@example.com", "654321"))
                assert all("value_length" in item and "validity" in item and "value" not in item for item in state["inputs"])
            else:
                assert "POST response" in trace and "continue_path" in trace and "invalid_input" in trace
            assert "query-secret" not in trace and "never-log-private" not in trace and "654321" not in trace
            before = len(messages)
            page.evaluate("fetch('/api/accounts/create', {method: 'POST', body: 'success'})")
            page.wait_for_timeout(200)
            assert len(messages) == before

        page.unroute("**/*")
        page.route("**/*", lambda route: route.fulfill(status=200, content_type="text/html", body="""
          <form>
            <label>Full name<input name="name" required></label>
            <label>Birthday<input name="birthday" type="date" required></label>
            <button>Continuar</button>
          </form>
        """))
        page.goto("https://auth.openai.com/about-you", wait_until="domcontentloaded")
        page.evaluate("""() => {
          document.querySelector('form').addEventListener('submit', event => {
            event.preventDefault();
            history.replaceState({}, '', '/add-phone');
          });
        }""")
        locator_type = type(page.locator('input'))
        normal_click = locator_type.click

        def covered_name(locator, *args, **kwargs):
            if locator.get_attribute("name", timeout=100) == "name":
                raise RuntimeError("simulated name click timeout")
            return normal_click(locator, *args, **kwargs)

        monkeypatch.setattr(locator_type, "click", covered_name)
        result = flow._submit_about_you_via_page(page, lambda message: None)
        assert result["ok"]
        assert page.locator('input[name="name"]').input_value() == "Test User"


def test_about_you_server_rejections_override_retry_text_and_navigation(monkeypatch):
    from platforms.chatgpt import constants
    monkeypatch.setattr(constants, "generate_random_user_info", lambda: {"name": "Test User", "birthdate": "2001-12-25"})
    monkeypatch.setattr(flow, "_click_first", lambda *args, **kwargs: None)
    monkeypatch.setattr(flow, "_browser_pause", lambda *args, **kwargs: None)
    monkeypatch.setattr(flow.time, "sleep", lambda seconds: None)
    monkeypatch.setattr(flow, "_dump_debug", lambda *args: None)
    cases = [("rate_limit_exceeded", 429, False), ("fraud_guard", 403, True),
             ("account_deactivated", 400, True), ("permission_denied", 403, True),
             ("challenge_required", 200, True), ("invalid_input", 400, True)]
    observed = []
    options = flow.ChatGPTBrowserRegister(headless=True)._launch_options()
    with flow.Camoufox(**options, timeout=60000) as browser:
        page = browser.new_page()
        active = {}

        def serve(route):
            if route.request.method == "POST":
                route.fulfill(status=active["status"], content_type="application/json",
                              body=json.dumps({"error": {"code": active["code"], "message": "Try again", "param": "9" * 12}}))
            else:
                route.fulfill(status=200, content_type="text/html", body="""
                    <form><label>Nombre<input name="name" required></label>
                    <label>Edad<input name="age" required></label><input name="birthday" type="hidden">
                    <button>Finalizar</button></form><div role="alert"></div>""")

        page.route("**/*", serve)
        for code, status, navigate in cases:
            active.update(code=code, status=status)
            page.goto("https://auth.openai.com/about-you", wait_until="domcontentloaded")
            page.evaluate("""mw:mode => {
                window.submissions = 0;
                document.querySelector('form').addEventListener('submit', event => {
                    event.preventDefault();
                    window.submissions++;
                    fetch('/api/accounts/create', {method:'POST',body:'fixture-profile'})
                        .then(response => response.json()).then(() => {
                            document.querySelector('[role=alert]').textContent = 'Try again';
                            if (mode === 'navigate') history.replaceState({}, '', '/add-phone');
                        });
                });
            }""", "navigate" if navigate else "stay")
            result = flow._submit_about_you_via_page(page, lambda message: None)
            if navigate:
                page.wait_for_url("**/add-phone", timeout=3000)
            assert result.get("data", {}).get("error", {}).get("param") == "[redacted]"
            observed.append((code, result.get("ok"), result.get("status"),
                             page.evaluate("mw:window.submissions"), code in str(result.get("text") or "")))
    assert observed == [(code, False, status, 1, True) for code, status, _ in cases]
