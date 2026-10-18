from __future__ import annotations

import json

from sqlmodel import Session, select

from application.tasks import _run_single_account_check
from core.account_graph import patch_account_graph
from core.base_platform import RegisterConfig
from core.db import AccountModel, AccountOverviewModel, engine
from core.lifecycle import check_accounts_validity
from core.proxy_pool import proxy_pool
from platforms.chatgpt import payment
from platforms.chatgpt.plugin import ChatGPTPlatform


class _AlwaysValidPlatform:
    def __init__(self, config: RegisterConfig | None = None):
        self.config = config

    def check_valid(self, account) -> bool:
        return True


class _AlwaysInvalidPlatform:
    def __init__(self, config: RegisterConfig | None = None):
        self.config = config

    def check_valid(self, account) -> bool:
        return False


def _create_account(*, platform: str = "chatgpt", lifecycle_status: str = "registered") -> int:
    with Session(engine) as session:
        model = AccountModel(platform=platform, email=f"{platform}@example.com", password="secret")
        session.add(model)
        session.commit()
        session.refresh(model)
        patch_account_graph(
            session,
            model,
            lifecycle_status=lifecycle_status,
            summary_updates={"valid": lifecycle_status != "invalid"},
        )
        session.commit()
        return int(model.id or 0)


def _overview(account_id: int):
    with Session(engine) as session:
        return session.exec(
            select(AccountOverviewModel).where(AccountOverviewModel.account_id == account_id)
        ).one()


def test_single_account_check_recovers_previously_invalid_account(monkeypatch):
    account_id = _create_account(lifecycle_status="invalid")
    monkeypatch.setattr("application.tasks.get", lambda _platform: _AlwaysValidPlatform)

    valid, result = _run_single_account_check(account_id)

    assert valid is True
    assert result["valid"] is True
    overview = _overview(account_id)
    assert overview.lifecycle_status == "registered"
    assert overview.validity_status == "valid"
    assert overview.display_status == "registered"
    assert overview.checked_at


def test_lifecycle_validity_check_does_not_overwrite_lifecycle_status(monkeypatch):
    account_id = _create_account(lifecycle_status="registered")
    monkeypatch.setattr("core.lifecycle.get", lambda _platform: _AlwaysInvalidPlatform)

    results = check_accounts_validity(platform="chatgpt", limit=10)

    assert results["invalid"] == 1
    overview = _overview(account_id)
    assert overview.lifecycle_status == "registered"
    assert overview.validity_status == "invalid"
    assert overview.display_status == "invalid"
    assert overview.checked_at


def test_chatgpt_subscription_status_falls_back_to_wham_usage(monkeypatch):
    captured_headers: dict[str, str] = {}

    class _Resp:
        def __init__(self, data=None, error: Exception | None = None):
            self._data = data
            self._error = error

        def raise_for_status(self):
            if self._error:
                raise self._error

        def json(self):
            return self._data

    def _fake_get(url, **kwargs):
        if url.endswith("/backend-api/me"):
            return _Resp(error=RuntimeError("403"))
        captured_headers.update(kwargs.get("headers") or {})
        return _Resp(data={"plan_type": "free"})

    monkeypatch.setattr(payment.cffi_requests, "get", _fake_get)
    account = type(
        "AccountStub",
        (),
        {
            "access_token": "token",
            "cookies": "",
            "id_token": json.dumps({"chatgpt_account_id": "acct-123"}),
            "extra": {},
        },
    )()

    status = payment.check_subscription_status(account)

    assert status == "free"
    assert captured_headers["Authorization"] == "Bearer token"
    assert captured_headers["Chatgpt-Account-Id"] == "acct-123"


def test_chatgpt_check_valid_uses_proxy_pool_before_direct(monkeypatch):
    calls: list[str | None] = []
    proxy_events: list[tuple[str, str]] = []

    def _fake_status(account, proxy=None):
        calls.append(proxy)
        if proxy != "http://127.0.0.1:7890":
            raise RuntimeError("should use proxy first")
        return {
            "status": "free",
            "source": "backend-api/wham/usage",
            "usage": {"plan_type": "free"},
        }

    monkeypatch.setattr(payment, "fetch_subscription_status_details", _fake_status)
    monkeypatch.setattr(proxy_pool, "get_next", lambda region="": "http://127.0.0.1:7890")
    monkeypatch.setattr(proxy_pool, "report_success", lambda url: proxy_events.append(("success", url)))
    monkeypatch.setattr(proxy_pool, "report_fail", lambda url: proxy_events.append(("fail", url)))

    plugin = ChatGPTPlatform.__new__(ChatGPTPlatform)
    plugin.config = RegisterConfig()
    plugin.mailbox = None
    account = type(
        "AccountStub",
        (),
        {
            "token": "token",
            "region": "",
            "extra": {
                "access_token": "token",
                "id_token": "",
                "cookies": "",
            },
        },
    )()

    assert plugin.check_valid(account) is True
    assert calls == ["http://127.0.0.1:7890"]
    assert proxy_events == [("success", "http://127.0.0.1:7890")]
    assert plugin.get_last_check_overview()["chatgpt_usage"] == {"plan_type": "free"}


def test_chatgpt_state_menu_uses_supported_query_capability(monkeypatch):
    plugin = ChatGPTPlatform(config=RegisterConfig(proxy="http://127.0.0.1:17891"))
    state_action = next(
        action for action in plugin.get_platform_actions()
        if action["label"] == "查询账号状态/订阅"
    )
    assert state_action["id"] == "query_state"
    expected = {"ok": True, "data": {"valid": True, "subscription_status": "free"}}
    monkeypatch.setattr(plugin, "_handle_query_state", lambda account, params: expected)
    assert plugin.execute_action(state_action["id"], object(), {}) == expected


def test_chatgpt_subscription_status_updates_account_overview():
    from infrastructure.platform_runtime import _build_account_overview

    overview = _build_account_overview(
        "chatgpt", {"valid": True, "subscription_status": "free"},
    )
    assert overview["valid"] is True
    assert overview["plan_name"] == "free"
    assert overview["plan_state"] == "free"

def test_chatgpt_state_uses_usage_when_profile_is_blocked(monkeypatch):
    from platforms.chatgpt import switch

    monkeypatch.setattr(switch, "_fetch_profile", lambda *args, **kwargs: (False, {"status_code": 403, "body": "<html>blocked</html>"}))

    def usage(account, proxy=None):
        assert account.id_token == "identity-token"
        return {"status": "free", "source": "backend-api/wham/usage", "usage": {"plan_type": "free"}}

    monkeypatch.setattr(payment, "fetch_subscription_status_details", usage)
    state = switch.fetch_chatgpt_account_state(access_token="token", id_token="identity-token")

    assert state["valid"] is True
    assert state["subscription_status"] == "free"
    assert state["chatgpt_usage"] == {"plan_type": "free"}


def test_blocked_chatgpt_checks_remain_unknown(monkeypatch):
    from platforms.chatgpt import switch
    from infrastructure.platform_runtime import _build_account_overview
    from core.account_graph import _derive_validity_status

    monkeypatch.setattr(switch, "_fetch_profile", lambda *args, **kwargs: (False, {"status_code": 403, "body": "<html>blocked</html>"}))

    def blocked(*args, **kwargs):
        raise RuntimeError("403 upstream access blocked")

    monkeypatch.setattr(payment, "fetch_subscription_status_details", blocked)
    state = switch.fetch_chatgpt_account_state(access_token="token")

    assert state["valid"] is None
    overview = _build_account_overview("chatgpt", state)
    assert overview["valid"] is None
    assert "失效" not in overview["chips"]
    assert _derive_validity_status("registered", overview) == "unknown"
