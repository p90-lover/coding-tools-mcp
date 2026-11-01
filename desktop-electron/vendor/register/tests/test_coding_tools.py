"""Isolated SQLite tests: no lifespan, real accounts, providers or network."""
import importlib.util
import asyncio
import os
from pathlib import Path
import sys
import tempfile
import threading
import unittest
from concurrent.futures import ThreadPoolExecutor
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[4]
WORK = ROOT / "aiTemp" / "register-cpa-20261023" / "runtime-tests"
WORK.mkdir(parents=True, exist_ok=True)
TEMP = tempfile.TemporaryDirectory(dir=WORK)
os.environ.update(CT_REGISTER_DATA_DIR=TEMP.name, ACCOUNT_MANAGER_DATA_DIR=TEMP.name,
                  ACCOUNT_MANAGER_DATABASE_URL="sqlite:///" + str(Path(TEMP.name) / "test.db").replace("\\", "/"),
                  APP_PASSWORD="isolated-fixture-password", CT_REGISTER_INSTANCE_ID="fixture-instance")
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "app"))

from fastapi.testclient import TestClient
from main import app
from core.db import init_db, engine
from domain.accounts import AccountCreateCommand, AccountUpdateCommand
from infrastructure.accounts_repository import AccountsRepository
from platforms.chatgpt.token_refresh import TokenRefreshResult


class CodingToolsAPI(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        init_db()
        cls.repository = AccountsRepository()
        cls.client = TestClient(app)
        cls.headers = {"Authorization": "Bearer isolated-fixture-password"}
        cls.good = cls.repository.create(AccountCreateCommand(
            platform="chatgpt", email="fixture@example.test", password="fixture-not-real",
            user_id="fixture-subject", credentials={"access_token": "fixture-access", "refresh_token": "fixture-refresh"}))
        cls.other = cls.repository.create(AccountCreateCommand(
            platform="grok", email="other@example.test", password="fixture-not-real"))
        cls.disabled = cls.repository.create(AccountCreateCommand(
            platform="chatgpt", email="disabled@example.test", password="fixture-not-real", user_id="disabled-subject",
            lifecycle_status="deactivated", credentials={"access_token": "fixture-disabled"}))

    @classmethod
    def tearDownClass(cls):
        cls.client.close()
        engine.dispose()
        TEMP.cleanup()

    def test_auth_and_metadata_never_exposes_credentials(self):
        for route in ("accounts", "export", "refresh"):
            request = self.client.get if route == "accounts" else self.client.post
            self.assertEqual(request("/api/coding-tools/" + route).status_code, 401)
        response = self.client.get("/api/coding-tools/accounts", headers=self.headers)
        self.assertEqual(response.status_code, 200)
        data = response.json()["accounts"]
        self.assertEqual({item["id"] for item in data}, {self.good.id, self.disabled.id})
        self.assertTrue(next(item for item in data if item["id"] == self.good.id)["eligible"])
        self.assertTrue(next(item for item in data if item["id"] == self.disabled.id)["disabled"])
        self.assertNotIn("fixture-access", response.text)
        self.assertNotIn("fixture-refresh", response.text)
        self.assertNotIn("fixture-not-real", response.text)
        self.assertEqual(self.client.get("/api/health").json()["instance_id"], "fixture-instance")

    def test_explicit_ids_and_credential_revision(self):
        for body in ({"ids": []}, {"ids": [True]}, {"ids": ["1"]}, {"ids": [0]}, {"ids": [-1]},
                     {"ids": [2**63]},
                     {"ids": [self.good.id, self.good.id]}, {"ids": list(range(1, 102))}, {"ids": [1], "select_all": True}):
            for route in ("export", "refresh"):
                response = self.client.post("/api/coding-tools/" + route, headers=self.headers, json=body)
                self.assertEqual(response.status_code, 422, body)
        for ids in ([self.other.id], [self.disabled.id], [999999], [self.good.id, 999999]):
            response = self.client.post("/api/coding-tools/export", headers=self.headers, json={"ids": ids})
            self.assertEqual(response.status_code, 409)
            self.assertNotIn("fixture-access", response.text)
        def export():
            response = self.client.post("/api/coding-tools/export", headers=self.headers, json={"ids": [self.good.id]})
            self.assertEqual(response.status_code, 200)
            return response.json()["files"][0]
        first = export()
        self.assertEqual(first["account_id"], self.good.id)
        self.assertEqual(first["json"]["type"], "codex")
        self.repository.update(self.good.id, AccountUpdateCommand(password="changed-unrelated-password"))
        self.assertEqual(export()["revision"], first["revision"])
        self.repository.update(self.good.id, AccountUpdateCommand(credentials={"access_token": "fixture-rotated"}))
        self.assertNotEqual(export()["revision"], first["revision"])

    def test_refresh_only_calls_noninteractive_path_and_sanitizes_failures(self):
        with patch("platforms.chatgpt.token_refresh.refresh_account_token", return_value=TokenRefreshResult(success=True)) as refresh:
            response = self.client.post("/api/coding-tools/refresh", headers=self.headers,
                                        json={"ids": [self.good.id, self.disabled.id, self.other.id, 999999]})
            self.assertEqual(response.status_code, 200)
            refresh.assert_called_once()
            self.assertEqual(refresh.call_args.args, (self.good.id,))
            self.assertTrue(response.json()["results"][0]["ok"])
            self.assertFalse(response.json()["results"][1]["ok"])
        with patch("platforms.chatgpt.token_refresh.refresh_account_token", side_effect=RuntimeError("secret-provider-token")):
            response = self.client.post("/api/coding-tools/refresh", headers=self.headers, json={"ids": [self.good.id]})
            self.assertNotIn("secret-provider-token", response.text)
            self.assertEqual(response.json()["results"][0]["error"], "refresh_failed")
        with patch("platforms.chatgpt.token_refresh.refresh_account_token", return_value=TokenRefreshResult(
                success=False, error_message="secret-provider-token", error_type="fraud_guard", requires_user_action=True)):
            result = self.client.post("/api/coding-tools/refresh", headers=self.headers, json={"ids": [self.good.id]}).json()["results"][0]
            self.assertEqual(result["error"], "fraud_guard")
            self.assertTrue(result["requires_login"])
            self.assertNotIn("secret-provider-token", str(result))

    def test_concurrent_lifecycle_and_native_refresh_use_latest_rotated_token(self):
        from core.lifecycle import refresh_expiring_tokens
        started, release, native_started, second_grant = (threading.Event() for _ in range(4))
        guard = threading.Lock()
        observed, active, maximum = [], 0, 0
        initial = next(item["value"] for item in self.repository.get(self.good.id).credentials
                       if item["key"] == "refresh_token")

        def grant(manager, material):
            nonlocal active, maximum
            with guard:
                active += 1
                maximum = max(maximum, active)
                observed.append(material.refresh_token)
                sequence = len(observed)
            if sequence == 1:
                started.set()
                if not release.wait(3):
                    raise AssertionError("test did not release the first token grant")
            else:
                second_grant.set()
            with guard:
                active -= 1
            return TokenRefreshResult(success=True, access_token=f"fixture-access-{sequence}",
                                      refresh_token=f"fixture-rotation-{sequence}")

        from platforms.chatgpt.token_refresh import refresh_account_token as actual_native_refresh

        def native_refresh(account_id, **kwargs):
            native_started.set()
            return actual_native_refresh(account_id, **kwargs)

        with patch("platforms.chatgpt.token_refresh.TokenRefreshManager.refresh_account", autospec=True, side_effect=grant), \
                patch("platforms.chatgpt.token_refresh.refresh_account_token", side_effect=native_refresh):
            with ThreadPoolExecutor(max_workers=2) as executor:
                lifecycle = executor.submit(refresh_expiring_tokens, platform="chatgpt", log_fn=lambda value: None)
                self.assertTrue(started.wait(3))
                native = executor.submit(self.client.post, "/api/coding-tools/refresh", headers=self.headers,
                                         json={"ids": [self.good.id]})
                try:
                    self.assertTrue(native_started.wait(3))
                    self.assertFalse(second_grant.wait(0.15))
                    self.assertFalse(native.done())
                finally:
                    release.set()
                self.assertEqual(lifecycle.result(timeout=5)["refreshed"], 1)
                self.assertTrue(native.result(timeout=5).json()["results"][0]["ok"])
        self.assertEqual(maximum, 1)
        self.assertEqual(observed, [initial, "fixture-rotation-1"])
        stored = self.repository.get(self.good.id)
        self.assertEqual(next(item["value"] for item in stored.credentials if item["key"] == "refresh_token"),
                         "fixture-rotation-2")

    def test_disconnect_stops_queued_and_remaining_refresh_grants(self):
        from api.coding_tools import AccountIDs, refresh_accounts
        from types import SimpleNamespace
        for disconnect_after, expected_calls in ((1, 0), (2, 1)):
            checks = 0

            async def disconnected():
                nonlocal checks
                checks += 1
                return checks > disconnect_after

            with patch("platforms.chatgpt.token_refresh.TokenRefreshManager.refresh_account", return_value=
                       TokenRefreshResult(success=True, access_token="fixture-disconnect-access")) as grant:
                result = asyncio.run(refresh_accounts(AccountIDs(ids=[self.good.id, self.disabled.id]),
                                                     SimpleNamespace(is_disconnected=disconnected)))
                self.assertEqual(grant.call_count, expected_calls)
                self.assertEqual(len(result["results"]), 1)
                self.assertEqual(result["results"][0]["ok"], bool(expected_calls))

    def test_managed_storage_precedes_app_import(self):
        spec = importlib.util.spec_from_file_location("register_entry", Path(__file__).resolve().parents[1] / "entry.py")
        entry = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(entry)
        previous = Path.cwd()
        try:
            self.assertEqual(entry.configure_runtime(), Path(TEMP.name))
            from core.base_sms import _project_data_dir
            from core.local_ms_mailbox import DEFAULT_STATE_FILE
            self.assertEqual(_project_data_dir(), Path(TEMP.name) / "data")
            self.assertEqual(DEFAULT_STATE_FILE, Path(TEMP.name) / "data" / ".local_ms_mailbox_pool_state.json")
            self.assertEqual(Path.cwd(), Path(TEMP.name))
        finally:
            os.chdir(previous)


if __name__ == "__main__":
    unittest.main()
