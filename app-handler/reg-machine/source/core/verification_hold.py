"""Persistent, manual-only pause for ChatGPT phone verification limits."""
from __future__ import annotations

from datetime import datetime, timedelta, timezone
from email.utils import parsedate_to_datetime
import json
import re
import threading

from core.config_store import config_store

HOLD_KEY = "chatgpt_phone_verification_hold"
HOLD_REASON = "Too many phone verification requests"
_lock = threading.RLock()


class VerificationHoldError(RuntimeError):
    def __init__(self, hold):
        self.verification_hold = hold
        super().__init__("verification_hold: " + HOLD_REASON)


def _stored_verification_hold():
    raw = config_store.get(HOLD_KEY, "")
    try:
        hold = json.loads(raw) if raw else None
    except (TypeError, ValueError):
        return None
    return hold if isinstance(hold, dict) and hold.get("active") is True else None


def get_verification_hold():
    hold = _stored_verification_hold()
    if not hold:
        return None
    # Only safe metadata crosses API/checkpoint boundaries.
    safe = {"active": True, "code": "rate_limit_exceeded", "reason": HOLD_REASON,
            "detected_at": str(hold.get("detected_at") or "")}
    if type(hold.get("account_id")) is int and hold["account_id"] > 0:
        safe["account_id"] = hold["account_id"]
    if hold.get("retry_after_until"):
        safe["retry_after_until"] = str(hold["retry_after_until"])
    return safe


def is_phone_verification_limit(error):
    message = str(error or "").casefold()
    return bool(re.search(r"\brate_limit_exceeded\b", message) or
                "too many phone verification requests" in message)


def activate_verification_hold(error, *, account_id=None, retry_after=None, owner=None):
    if not is_phone_verification_limit(error):
        return None
    with _lock:
        hold = _stored_verification_hold()
        if not hold:
            hold = {"active": True, "code": "rate_limit_exceeded", "reason": HOLD_REASON,
                    "detected_at": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")}
            if owner:
                hold["_owner"] = owner
            if account_id:
                hold["account_id"] = int(account_id)
        elif account_id and hold.get("account_id") == int(account_id):
            # A fresh rejection invalidates older queued manual-resume authorizations.
            hold["detected_at"] = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
        if retry_after:
            try:
                until = (datetime.now(timezone.utc) + timedelta(seconds=max(0, int(retry_after)))) if str(retry_after).isdigit() else parsedate_to_datetime(str(retry_after))
                hold["retry_after_until"] = until.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")
            except (TypeError, ValueError, OverflowError):
                pass
        config_store.set(HOLD_KEY, json.dumps(hold))
        return get_verification_hold()


def bind_verification_hold(account_id, detected_at, owner=None):
    with _lock:
        hold = _stored_verification_hold()
        if hold and hold["detected_at"] == detected_at and not hold.get("account_id") and owner and hold.get("_owner") == owner:
            hold["account_id"] = int(account_id)
            config_store.set(HOLD_KEY, json.dumps(hold))
        return get_verification_hold()


def can_resume_verification_hold(hold, account_id, requested, detected_at=None):
    if not hold or requested is not True or type(account_id) is not int or hold.get("account_id") != account_id or hold.get("detected_at") != detected_at:
        return False
    if hold.get("retry_after_until"):
        try:
            if datetime.fromisoformat(hold["retry_after_until"].replace("Z", "+00:00")) > datetime.now(timezone.utc):
                return False
        except (TypeError, ValueError):
            return False
    return True


def require_phone_verification_allowed(*, account_id=None, resume=False, detected_at=None):
    hold = get_verification_hold()
    if hold and not can_resume_verification_hold(hold, account_id, resume, detected_at):
        raise VerificationHoldError(hold)


def clear_verification_hold(account_id, detected_at):
    with _lock:
        hold = get_verification_hold()
        if hold and hold.get("account_id") == account_id and hold["detected_at"] == detected_at:
            config_store.set(HOLD_KEY, "")
            return True
        return False


def verification_hold_result(hold):
    return {"ok": False, "error": "verification_hold: " + HOLD_REASON,
            "data": {"verification_hold": hold, "requires_user_action": True,
                     "error_type": "verification_hold"}}
