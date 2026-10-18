"""Run: python -B -m unittest tests.test_api_authenticator."""
import json
import unittest
from unittest.mock import Mock, patch

from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy.pool import StaticPool
from sqlmodel import Session, SQLModel, create_engine

from api import authenticator
from core.db import AccountCredentialModel, AccountModel, AccountOverviewModel


class AuthenticatorTests(unittest.TestCase):

    def setUp(self):
        for patcher in (
            patch.object(authenticator, "_login_backoff", {}, create=True),
            patch.object(authenticator, "_start_service", side_effect=AssertionError("Native service startup is forbidden in tests")),
            patch.object(authenticator.subprocess, "Popen", side_effect=AssertionError("Native process launch is forbidden in tests")),
        ):
            patcher.start()
            self.addCleanup(patcher.stop)


    def test_native_service_error_preserves_registration_codes_without_credential_lockout(self):
        engine = create_engine("sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool)
        SQLModel.metadata.create_all(engine)
        self.addCleanup(engine.dispose)
        with Session(engine) as database:
            database.add(AccountModel(id=1, platform="chatgpt", email="fallback@example.invalid", password="unused"))
            database.add(AccountCredentialModel(account_id=1, scope="platform", key="totp_secret",
                value="GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ"))
            database.commit()
        app = FastAPI()
        app.include_router(authenticator.router, prefix="/api")
        for status_code in (500, 503):
            with self.subTest(status_code=status_code):
                native = Mock()
                status = Mock(status_code=200)
                status.json.return_value = {"setup": True}
                native.get.side_effect = [Mock(status_code=401), status]
                native.post.return_value = Mock(status_code=status_code)
                with patch.object(authenticator, "engine", engine), \
                        patch.object(authenticator, "_vault_config", return_value={
                            "AUTHENTICATOR_USERNAME": "fixture", "AUTHENTICATOR_PASSWORD": "fixture"}), \
                        patch.object(authenticator.requests, "Session", return_value=native):
                    response = TestClient(app).get("/api/authenticator/entries",
                        headers={"X-Requested-With": "reg-machine-authenticator"})
                self.assertEqual(response.status_code, 200)
                payload = response.json()
                self.assertEqual(payload["native"]["status"], "unavailable")
                self.assertNotIn("凭据", payload["native"]["message"])
                self.assertEqual(authenticator._login_backoff, {})
                self.assertEqual([entry["label"] for entry in payload["entries"]], ["fallback@example.invalid"])
                native.post.assert_called_once()
                native.close.assert_called_once()

    def test_native_login_can_resume_after_the_rate_limit_window(self):
        session = Mock()
        status = Mock(status_code=200)
        status.json.return_value = {"setup": True}
        listed = Mock(status_code=200)
        listed.json.return_value = {"entries": []}
        session.get.side_effect = lambda url, **kwargs: status if url.endswith("/api/status") else Mock(status_code=401)
        session.post.return_value = Mock(status_code=429)
        clock = [100]
        with patch.object(authenticator, "_vault_config", return_value={
                "AUTHENTICATOR_USERNAME": "fixture", "AUTHENTICATOR_PASSWORD": "fixture"}), \
                patch.object(authenticator.time, "time", side_effect=lambda: clock[0]), \
                patch.object(authenticator.requests, "Session", return_value=session) as factory:
            self.assertEqual(authenticator._native_entries()["status"], "locked")
            clock[0] = 701
            session.get.side_effect = [Mock(status_code=401), status, listed]
            session.post.return_value = Mock(status_code=200)
            self.assertEqual(authenticator._native_entries()["status"], "ready")
            self.assertEqual(factory.call_count, 2)


    def test_native_accepts_mixed_supported_code_lengths(self):
        session = Mock()
        listed = Mock(status_code=200)
        listed.json.return_value = {"entries": [
            {"id": str(index), "code": "1" * digits, "period": 30, "remaining": 10}
            for index, digits in enumerate((6, 7, 8))
        ]}
        session.get.return_value = listed
        with patch.object(authenticator, "_vault_config", return_value={
                "AUTHENTICATOR_USERNAME": "fixture", "AUTHENTICATOR_PASSWORD": "fixture"}), \
                patch.object(authenticator.requests, "Session", return_value=session):
            result = authenticator._native_entries()
        self.assertEqual(result["status"], "ready")
        self.assertEqual([len(entry["code"]) for entry in result["entries"]], [6, 7, 8])

    def test_rejected_native_login_does_not_repeat_on_every_poll(self):
        session = Mock()
        status = Mock(status_code=200)
        status.json.return_value = {"setup": True}
        session.get.side_effect = lambda url, **kwargs: status if url.endswith("/api/status") else Mock(status_code=401)
        session.post.return_value = Mock(status_code=401)
        config = {"AUTHENTICATOR_USERNAME": "fixture", "AUTHENTICATOR_PASSWORD": "fixture-old"}
        with patch.object(authenticator, "_vault_config", return_value=config), \
                patch.object(authenticator.time, "time", return_value=100), \
                patch.object(authenticator.requests, "Session", return_value=session) as factory:
            self.assertEqual(authenticator._native_entries()["status"], "locked")
            self.assertEqual(authenticator._native_entries()["status"], "locked")
            self.assertEqual(factory.call_count, 1)
            self.assertEqual(session.post.call_count, 1)
            config["AUTHENTICATOR_PASSWORD"] = "fixture-corrected"
            listed = Mock(status_code=200)
            listed.json.return_value = {"entries": []}
            session.get.side_effect = [Mock(status_code=401), status, listed]
            session.post.return_value = Mock(status_code=200)
            self.assertEqual(authenticator._native_entries()["status"], "ready")
            self.assertEqual(factory.call_count, 2)

    def test_native_rate_limit_applies_even_after_credentials_change(self):
        session = Mock()
        status = Mock(status_code=200)
        status.json.return_value = {"setup": True}
        session.get.side_effect = lambda url, **kwargs: status if url.endswith("/api/status") else Mock(status_code=401)
        session.post.return_value = Mock(status_code=429)
        config = {"AUTHENTICATOR_USERNAME": "fixture", "AUTHENTICATOR_PASSWORD": "fixture-old"}
        with patch.object(authenticator, "_vault_config", return_value=config), \
                patch.object(authenticator.time, "time", return_value=100), \
                patch.object(authenticator.requests, "Session", return_value=session) as factory:
            self.assertEqual(authenticator._native_entries()["status"], "locked")
            config["AUTHENTICATOR_PASSWORD"] = "fixture-corrected"
            config["AUTHENTICATOR_URL"] = "http://localhost:8788"
            self.assertEqual(authenticator._native_entries()["status"], "locked")
            self.assertEqual(factory.call_count, 1)

    def test_native_logout_latency_cannot_extend_code_validity(self):
        engine = create_engine("sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool)
        SQLModel.metadata.create_all(engine)
        app = FastAPI()
        app.include_router(authenticator.router, prefix="/api")
        session = Mock()
        status = Mock(status_code=200)
        status.json.return_value = {"setup": True}
        listed = Mock(status_code=200)
        listed.json.return_value = {"entries": [
            {"id": "fixture", "issuer": "Fixture", "label": "fixture@example.invalid",
             "code": "111111", "period": 30, "remaining": 1}
        ]}
        session.get.side_effect = [Mock(status_code=401), status, listed]
        clock = [59.1]
        def post(url, **kwargs):
            if url.endswith("/api/logout"):
                clock[0] = 61.2
            return Mock(status_code=200)
        session.post.side_effect = post
        native_responses = []
        native_reader = authenticator._native_entries
        def capture_native():
            result = native_reader()
            native_responses.append(result)
            return result
        with patch.object(authenticator, "engine", engine), \
                patch.object(authenticator, "_vault_config", return_value={
                    "AUTHENTICATOR_USERNAME": "fixture", "AUTHENTICATOR_PASSWORD": "fixture"}), \
                patch.object(authenticator.requests, "Session", return_value=session), \
                patch.object(authenticator.time, "time", side_effect=lambda: clock[0]), \
                patch.object(authenticator, "_native_entries", side_effect=capture_native):
            response = TestClient(app).get("/api/authenticator/entries",
                headers={"X-Requested-With": "reg-machine-authenticator"})
        self.assertEqual(response.status_code, 200)
        entry = response.json()["entries"][0]
        self.assertEqual(entry["remaining"], 0)
        self.assertLessEqual(entry["expires_at"], 60)
        self.assertEqual(native_responses[0]["entries"][0]["remaining"], 0)
        engine.dispose()

    def test_proxy_keeps_secrets_and_cookies_private(self):
        session = Mock()
        listed = Mock(status_code=200)
        listed.json.return_value = {"entries": [{"id": "vault-1", "issuer": "OpenAI",
            "label": "same@example.com", "code": "123456", "remaining": 12, "period": 30,
            "secret": "never-return-this", "oauthToken": "private-token"}]}
        status = Mock(status_code=200)
        status.json.return_value = {"setup": True}
        session.get.side_effect = [Mock(status_code=401), status, listed]
        session.post.return_value = Mock(status_code=200)
        with patch.object(authenticator, "_vault_config", return_value={
                "AUTHENTICATOR_URL": "http://127.0.0.1:8788",
                "AUTHENTICATOR_USERNAME": "owner", "AUTHENTICATOR_PASSWORD": "private-password"}), \
                patch.object(authenticator.requests, "Session", return_value=session):
            result = authenticator._native_entries()
        self.assertEqual(result["status"], "ready")
        self.assertEqual(result["entries"][0]["code"], "123456")
        self.assertNotIn("never-return-this", json.dumps(result))
        self.assertNotIn("private-password", json.dumps(result))
        self.assertNotIn("private-token", json.dumps(result))
        self.assertFalse(session.trust_env)
        self.assertFalse(session.post.call_args_list[0].kwargs["allow_redirects"])
        self.assertTrue(session.post.call_args.args[0].endswith("/api/logout"))
        session.close.assert_called_once()

    def test_config_rejects_remote_redirect_targets_and_missing_credentials(self):
        for url in ("https://127.0.0.1:8788", "http://example.com", "http://127.0.0.1/a",
                    "http://owner:pass@127.0.0.1", "http://127.0.0.1?host=x", "http://127.0.0.1#x"):
            with self.subTest(url=url), patch.object(authenticator, "_vault_config", return_value={
                    "AUTHENTICATOR_URL": url, "AUTHENTICATOR_USERNAME": "owner",
                    "AUTHENTICATOR_PASSWORD": "private-password"}), \
                    patch.object(authenticator.requests, "Session") as session:
                self.assertEqual(authenticator._native_entries()["status"], "invalid_config")
                session.assert_not_called()
        with patch.object(authenticator, "_vault_config", return_value={}):
            self.assertEqual(authenticator._native_entries()["status"], "missing_config")

    def test_foreign_browser_origin_cannot_unlock_or_read_codes(self):
        app = FastAPI()
        app.include_router(authenticator.router, prefix="/api")
        with patch.object(authenticator, "_native_entries") as native:
            response = TestClient(app).get("/api/authenticator/entries", headers={
                "X-Requested-With": "reg-machine-authenticator", "Origin": "https://foreign.example",
                "Sec-Fetch-Site": "cross-site"})
            self.assertEqual(response.status_code, 403)
            native.assert_not_called()
            response = TestClient(app).get("/api/authenticator/entries")
            self.assertEqual(response.status_code, 403)
            native.assert_not_called()

    def test_registration_codes_deduplicate_and_report_verification(self):
        engine = create_engine("sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool)
        SQLModel.metadata.create_all(engine)
        with Session(engine) as session:
            for index, email in enumerate(("same@example.com", "new@example.com"), 1):
                session.add(AccountModel(id=index, platform="chatgpt", email=email, password="unused"))
                session.add(AccountCredentialModel(account_id=index, scope="platform", key="totp_secret",
                    value="GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ"))
                session.add(AccountOverviewModel(account_id=index,
                    summary_json=json.dumps({"legacy_extra": {"authenticator_verified": index == 1}})))
            session.commit()
        app = FastAPI()
        app.include_router(authenticator.router, prefix="/api")
        with patch.object(authenticator, "engine", engine), \
                patch.object(authenticator.time, "time", return_value=59), \
                patch.object(authenticator, "_native_entries", return_value={"status": "ready",
                    "message": "", "entries": [{"id": "vault-1", "issuer": "OpenAI",
                        "label": "SAME@example.com", "source": "vault", "code": "111111"},
                        {"id": "vault-2", "issuer": "Google", "label": "new@example.com",
                         "source": "vault", "code": "222222"}]}):
            response = TestClient(app).get("/api/authenticator/entries",
                headers={"X-Requested-With": "reg-machine-authenticator"})
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.headers["cache-control"], "no-store")
        entries = response.json()["entries"]
        self.assertEqual(len(entries), 3)
        registered = next(item for item in entries if item["source"] == "registration")
        self.assertEqual(registered["code"], "287082")
        self.assertFalse(registered["verified"])
        self.assertNotIn("GEZDGNBVGY3TQOJQ", response.text)
        self.assertNotIn("set-cookie", response.headers)
        engine.dispose()


if __name__ == "__main__":
    unittest.main()
