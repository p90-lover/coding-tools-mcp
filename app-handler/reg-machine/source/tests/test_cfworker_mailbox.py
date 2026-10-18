from unittest.mock import MagicMock, patch

from core.base_mailbox import CFWorkerMailbox


def test_cfworker_create_and_read_code_directly_without_logging_token(capsys):
    session = MagicMock()
    with patch("requests.Session", return_value=session):
        mailbox = CFWorkerMailbox(
            "https://mail-api.leunghongyu.com",
            admin_token="test-admin-secret",
            domain="leunghongyu.com",
            proxy="http://127.0.0.1:17891",
        )
    assert session.trust_env is False

    created = MagicMock()
    created.json.return_value = {
        "address": "alice@leunghongyu.com",
        "jwt": "test-mailbox-jwt",
        "address_id": 1,
    }
    session.post.return_value = created
    account = mailbox.get_email()
    assert account.email == "alice@leunghongyu.com"
    assert account.account_id == "test-mailbox-jwt"
    assert "test-mailbox-jwt" not in capsys.readouterr().out
    assert "proxies" not in session.post.call_args.kwargs

    inbox = MagicMock()
    inbox.json.return_value = {
        "results": [{"id": 7, "raw": "Subject: Verification\\r\\n\\r\\nYour code is 123456"}]
    }
    session.get.return_value = inbox
    assert mailbox.wait_for_code(account, timeout=1) == "123456"
    assert "proxies" not in session.get.call_args.kwargs
