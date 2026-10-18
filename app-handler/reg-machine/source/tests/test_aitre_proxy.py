from unittest.mock import MagicMock, patch

from core.base_mailbox import AitreMailbox, MAILBOX_FACTORY_REGISTRY


def test_aitre_catalog_factory_keeps_nova_proxy():
    mailbox = MAILBOX_FACTORY_REGISTRY["aitre_api"](
        {"aitre_email": "test@example.com"}, "http://127.0.0.1:17891"
    )
    assert isinstance(mailbox, AitreMailbox)
    assert mailbox.get_email().email == "test@example.com"

    response = MagicMock()
    response.json.return_value = {"emails": [{"id": 7}]}
    with patch("requests.get", return_value=response) as get:
        assert mailbox.get_current_ids(mailbox.get_email()) == {"7"}
    assert get.call_args.kwargs["proxies"] == {
        "http": "http://127.0.0.1:17891",
        "https": "http://127.0.0.1:17891",
    }
