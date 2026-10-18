"""Offline registration contracts: no provider calls or real credentials."""
import itertools
import threading
from types import SimpleNamespace

import pytest
from sqlmodel import Session, select

from application import tasks
from core.base_platform import AccountStatus, RegisterConfig
from core.db import AccountModel, AccountOverviewModel, PlatformCapabilityOverrideModel, engine
from core import base_sms as sms


@pytest.mark.parametrize("count", [0, -1, 1.5, "", True, None])
def test_register_api_rejects_invalid_count_without_creating_a_task(client, count):
    response = client.post("/api/tasks/register", json={"platform": "chatgpt", "count": count})
    assert response.status_code == 422
    assert tasks.list_tasks()["total"] == 0


@pytest.mark.parametrize("count", [0, -1, 1.5, "", True, None])
def test_direct_registration_command_does_not_coerce_invalid_count(count):
    with pytest.raises(ValueError, match="整数"):
        tasks.create_register_task({"platform": "chatgpt", "count": count})
    assert tasks.list_tasks()["total"] == 0


def test_cancellation_between_candidate_read_and_claim_is_not_overwritten(monkeypatch):
    task = tasks.create_register_task({"platform": "chatgpt", "count": 1})
    def cancel_during_lookup(*args):
        tasks.request_cancel(task["id"])
        return None
    monkeypatch.setattr(tasks, "_task_verification_hold", cancel_during_lookup)
    assert tasks.claim_next_runnable_task() is None
    assert tasks.get_task(task["id"])["status"] == "cancelled"


def test_cancel_before_mark_running_never_starts_registration(monkeypatch):
    task = tasks.create_register_task({"platform": "chatgpt", "count": 1})
    original = tasks.TaskLogger.mark_running
    def cancel_before_mark(logger):
        tasks.request_cancel(logger.task_id)
        original(logger)
    monkeypatch.setattr(tasks.TaskLogger, "mark_running", cancel_before_mark)
    monkeypatch.setattr(tasks, "_execute_register_task", lambda *args: pytest.fail("cancelled job started"))
    tasks.execute_task(task["id"])
    assert tasks.get_task(task["id"])["status"] == "cancelled"


def test_fifty_fixture_registrations_persist_exact_accounts_and_task_counts(client, monkeypatch):
    from platforms.chatgpt.plugin import ChatGPTPlatform
    platform = ChatGPTPlatform(RegisterConfig())
    sequence = itertools.count()
    def register(**kwargs):
        index = next(sequence)
        email = f"fixture-{index}@example.invalid"
        mapped = platform._map_chatgpt_result({
            "email": email, "account_id": f"fixture-account-{index}",
            "access_token": f"fixture-access-{index}", "refresh_token": f"fixture-refresh-{index}",
            "id_token": f"fixture-id-{index}", "phone_verified": True,
            "authenticator_verified": True, "phone_mfa_disabled": True,
        }, expected_email=email)
        return platform._account_from_registration_result(mapped)
    monkeypatch.setattr(tasks, "_resolve_sms_provider_for_task", lambda _: ("", {}))
    monkeypatch.setattr(tasks, "_build_platform_instance", lambda *args, **kwargs: SimpleNamespace(register=register))
    monkeypatch.setattr(tasks, "_auto_upload_cpa", lambda *args: None)
    monkeypatch.setattr(tasks, "_auto_push_any2api", lambda *args: None)
    monkeypatch.setattr(tasks, "_auto_followup_windsurf_payment", lambda **kwargs: None)
    from core.proxy_pool import proxy_pool
    monkeypatch.setattr(proxy_pool, "get_next", lambda **kwargs: None)
    response = client.post("/api/tasks/register", json={"platform": "chatgpt", "count": 50,
        "concurrency": 5, "extra": {"identity_provider": "oauth_browser"}})
    assert response.status_code == 200
    task_id = response.json()["task_id"]
    assert tasks.claim_next_runnable_task()["id"] == task_id
    tasks.execute_task(task_id)
    result = client.get(f"/api/tasks/{task_id}").json()
    assert (result["status"], result["progress"], result["success"], result["error_count"]) == ("succeeded", "50/50", 50, 0)
    with Session(engine) as session:
        accounts = session.exec(select(AccountModel)).all()
        assert {account.email for account in accounts} == {f"fixture-{index}@example.invalid" for index in range(50)}
        overviews = session.exec(select(AccountOverviewModel)).all()
        assert len(overviews) == 50
        assert all(item.lifecycle_status == "registered" for item in overviews)




@pytest.mark.parametrize("executor", ["protocol", "headless"])
@pytest.mark.parametrize("change", ["deleted", "replaced", "edited", "identity_changed"])
def test_registration_followup_preserves_the_saved_account_identity(client, monkeypatch, executor, change):
    from core.base_platform import Account
    from core import base_mailbox
    from core.proxy_pool import proxy_pool
    from domain.accounts import AccountCreateCommand, AccountUpdateCommand
    from infrastructure.accounts_repository import AccountsRepository

    repository = AccountsRepository()
    untouched = repository.create(AccountCreateCommand(
        platform="windsurf", email="untouched-followup@example.invalid", password="fixture-untouched",
        user_id="fixture-untouched", credentials={"session_token": "untouched-session"}))
    account = Account(platform="windsurf", email="followup-owned@example.invalid", password="fixture-original",
                      user_id="fixture-original", extra={"session_token": "original-session", "auth_token": "original-auth"})
    state, uploads = {}, []
    checkout = "http://127.0.0.1/fixture-followup"

    class Platform:
        def register(self, **kwargs):
            return account

        def execute_action(self, action_id, current, params):
            assert action_id == ("generate_link" if executor == "protocol" else "generate_link_browser")
            with Session(engine) as session:
                selected = session.exec(select(AccountModel).where(AccountModel.email == account.email)).one()
                state["id"] = int(selected.id)
            if change == "deleted":
                assert repository.delete(state["id"])
            elif change == "replaced":
                repository.create(AccountCreateCommand(platform="windsurf", email="sentinel-followup@example.invalid", password=""))
                assert repository.delete(state["id"])
                replacement = repository.create(AccountCreateCommand(
                    platform="windsurf", email=account.email, password="fixture-replacement", user_id="fixture-replacement",
                    credentials={"session_token": "replacement-session", "auth_token": "replacement-auth"}))
                state["replacement"] = repository.get(replacement.id)
            elif change == "edited":
                repository.update(state["id"], AccountUpdateCommand(
                    password="fixture-user-edit", overview={"user_note": "keep this edit"},
                    credentials={"session_token": "edited-session"}))
            else:
                repository.update(state["id"], AccountUpdateCommand(
                    user_id="fixture-replacement", credentials={"session_token": "replacement-session"}))
                state["changed"] = repository.get(state["id"])
            return {"ok": True, "data": {"cashier_url": checkout, "url": checkout, "auth_token": "returned-auth"}}

    monkeypatch.setattr(tasks, "_resolve_sms_provider_for_task", lambda _: ("", {}))
    monkeypatch.setattr(tasks, "_build_platform_instance", lambda *args, **kwargs: Platform())
    monkeypatch.setattr(base_mailbox, "create_mailbox", lambda *args, **kwargs: SimpleNamespace())
    monkeypatch.setattr(proxy_pool, "get_next", lambda **kwargs: None)
    monkeypatch.setattr(tasks, "_auto_upload_cpa", lambda *args: uploads.append("cpa"))
    monkeypatch.setattr(tasks, "_auto_push_any2api", lambda *args: uploads.append("any2api"))
    response = client.post("/api/tasks/register", json={
        "platform": "windsurf", "count": 1, "executor_type": executor,
        "extra": {"identity_provider": "mailbox", "mail_provider": "cfworker_admin_api"},
    })
    assert response.status_code == 200
    task_id = response.json()["task_id"]
    tasks.execute_task(task_id)
    result = tasks.get_task(task_id)
    assert repository.get(untouched.id) == untouched
    if change == "edited":
        saved = repository.get(state["id"])
        credentials = {item["key"]: item["value"] for item in saved.credentials}
        assert saved.password == "fixture-user-edit"
        assert saved.overview["user_note"] == "keep this edit"
        assert credentials["session_token"] == "edited-session"
        assert credentials["auth_token"] == "returned-auth"
        assert saved.cashier_url == checkout
        assert result["status"] == "succeeded" and result["success"] == 1
        assert uploads == ["cpa", "any2api"]
    else:
        assert result["status"] == "failed" and result["success"] == 0
        assert uploads == []
        if change == "identity_changed":
            assert repository.get(state["id"]) == state["changed"]
        else:
            assert repository.get(state["id"]) is None
            if change == "replaced":
                assert repository.get(state["replacement"].id) == state["replacement"]
            else:
                with Session(engine) as session:
                    assert session.exec(select(AccountModel).where(AccountModel.email == account.email)).all() == []


def test_registration_followup_serializes_identity_changes_during_persistence(monkeypatch):
    from core.base_platform import Account
    from core.db import save_account
    from domain.accounts import AccountUpdateCommand
    from infrastructure.accounts_repository import AccountsRepository

    account = Account(platform="windsurf", email="serialized-followup@example.invalid", password="fixture-original",
                      user_id="fixture-original", extra={"session_token": "original-session"})
    saved = save_account(account)
    repository = AccountsRepository()
    started, finished = threading.Event(), threading.Event()
    errors, workers = [], []
    original_patch = tasks.patch_account_graph

    def user_edit():
        started.set()
        try:
            repository.update(saved.id, AccountUpdateCommand(
                user_id="fixture-user-choice",
                credentials={"session_token": "user-session", "auth_token": "user-auth"}))
        except Exception as exc:
            errors.append(type(exc).__name__)
        finally:
            finished.set()

    def patch_while_editing(*args, **kwargs):
        worker = threading.Thread(target=user_edit)
        workers.append(worker)
        worker.start()
        assert started.wait(1)
        assert not finished.wait(0.1), "Identity changed between validation and persistence"
        return original_patch(*args, **kwargs)

    monkeypatch.setattr(tasks, "patch_account_graph", patch_while_editing)
    platform = SimpleNamespace(execute_action=lambda *args: {
        "ok": True, "data": {"auth_token": "returned-auth", "cashier_url": "http://127.0.0.1/serialized-followup"}})
    logger = SimpleNamespace(log=lambda *args, **kwargs: None, record_error=lambda message: pytest.fail(message),
                             add_cashier_url=lambda value: None)
    try:
        tasks._auto_followup_windsurf_payment(
            saved_account=saved, platform_name="windsurf", payload={"executor_type": "protocol"},
            platform=platform, account=account, logger=logger)
    finally:
        for worker in workers:
            worker.join(5)
    assert workers and all(not worker.is_alive() for worker in workers)
    assert errors == []
    record = repository.get(saved.id)
    credentials = {item["key"]: item["value"] for item in record.credentials}
    assert record.user_id == "fixture-user-choice"
    assert credentials["session_token"] == "user-session"
    assert credentials["auth_token"] == "user-auth"


@pytest.mark.parametrize("case", ["different_uid", "missing_uid", "ambiguous_same_uid", "ambiguous_missing_uid"])
def test_initial_save_rejects_unscoped_identity_collisions(case):
    from core.base_platform import Account
    from core.db import save_account
    from domain.accounts import AccountCreateCommand
    from infrastructure.accounts_repository import AccountsRepository

    repository = AccountsRepository()
    email = "collision@example.invalid"
    original = repository.create(AccountCreateCommand(
        platform="chatgpt", email=email, password="fixture-original", user_id="fixture-original",
        credentials={"access_token": "original-access"}))
    rows = [original]
    if case.startswith("ambiguous"):
        rows.append(repository.create(AccountCreateCommand(
            platform="chatgpt", email=email, password="fixture-second",
            user_id="fixture-original" if case=="ambiguous_same_uid" else "fixture-second",
            credentials={"access_token": "second-access"})))
    incoming_id = "" if case in {"missing_uid", "ambiguous_missing_uid"} else (
        "fixture-original" if case=="ambiguous_same_uid" else "fixture-different")
    with pytest.raises(ValueError):
        save_account(Account(platform="chatgpt", email=email, password="fixture-incoming",
                             user_id=incoming_id, extra={"access_token": "incoming-access"}))
    for row in rows:
        assert repository.get(row.id) == row
    with Session(engine) as session:
        assert len(session.exec(select(AccountModel)).all()) == len(rows)


def test_initial_save_selects_the_remote_identity_among_duplicate_emails():
    from core.base_platform import Account
    from core.db import save_account
    from domain.accounts import AccountCreateCommand
    from infrastructure.accounts_repository import AccountsRepository

    repository = AccountsRepository()
    first = repository.create(AccountCreateCommand(
        platform="chatgpt", email="selected-identity@example.invalid", password="fixture-first",
        user_id="fixture-first", credentials={"access_token": "first-access"}))
    selected = repository.create(AccountCreateCommand(
        platform="chatgpt", email=first.email, password="fixture-selected",
        user_id="fixture-selected", credentials={"access_token": "selected-access"}))
    saved = save_account(Account(platform="chatgpt", email=first.email, password="fixture-updated",
                                 user_id=selected.user_id, extra={"access_token": "updated-access"}))
    assert saved.id == selected.id
    assert repository.get(first.id) == first
    updated = repository.get(selected.id)
    assert updated.password == "fixture-updated"
    assert next(item["value"] for item in updated.credentials if item["key"]=="access_token") == "updated-access"


@pytest.mark.parametrize("attempt_password", ["", "fixture-unused-attempt"])
def test_passwordless_checkpoint_keeps_an_existing_password(client, attempt_password):
    from core.base_platform import RegisterConfig
    from core.db import save_account
    from domain.accounts import AccountCreateCommand
    from infrastructure.accounts_repository import AccountsRepository
    from platforms.chatgpt.plugin import ChatGPTPlatform

    repository = AccountsRepository()
    original = repository.create(AccountCreateCommand(
        platform="chatgpt", email="password-checkpoint@example.invalid", password="fixture-saved-password",
        user_id="fixture-owner", lifecycle_status="2fa_required",
        credentials={"session_token":"saved-session"}))
    platform = ChatGPTPlatform(RegisterConfig())
    platform._local_account_id = original.id
    ctx = SimpleNamespace(identity=SimpleNamespace(email=original.email), password=attempt_password)
    pending = platform._save_security_checkpoint(ctx, {
        "account_id":original.user_id, "session_token":"returned-session",
        "password_set":False, "phone_verified":False,
    })
    assert pending.password == "", "A passwordless flow must not invent an attempted password"
    assert repository.get(original.id).password == "fixture-saved-password"
    save_account(pending, account_id=original.id)
    restored = repository.get(original.id)
    assert restored.password == "fixture-saved-password"
    assert next(item["value"] for item in restored.credentials if item["key"]=="session_token") == "returned-session"


def test_checkpoint_saves_a_password_that_was_actually_set(client):
    from core.base_platform import RegisterConfig
    from domain.accounts import AccountCreateCommand
    from infrastructure.accounts_repository import AccountsRepository
    from platforms.chatgpt.plugin import ChatGPTPlatform

    repository = AccountsRepository()
    original = repository.create(AccountCreateCommand(
        platform="chatgpt", email="confirmed-password@example.invalid", password="fixture-old-password",
        user_id="fixture-owner", lifecycle_status="phone_required"))
    platform = ChatGPTPlatform(RegisterConfig())
    platform._local_account_id = original.id
    ctx = SimpleNamespace(identity=SimpleNamespace(email=original.email),password="fixture-confirmed-password")
    platform._save_security_checkpoint(ctx, {
        "account_id":original.user_id,"password_set":True,"phone_verified":False,
    })
    assert repository.get(original.id).password == "fixture-confirmed-password"


def test_new_passwordless_checkpoint_remains_empty(client):
    from core.base_platform import RegisterConfig
    from infrastructure.accounts_repository import AccountsRepository
    from platforms.chatgpt.plugin import ChatGPTPlatform

    platform = ChatGPTPlatform(RegisterConfig())
    ctx = SimpleNamespace(identity=SimpleNamespace(email="new-passwordless@example.invalid"),
                          password="fixture-unused-attempt")
    pending = platform._save_security_checkpoint(ctx, {
        "account_id":"fixture-new-owner","password_set":False,"phone_verified":False,
    })
    assert pending.password == ""
    assert AccountsRepository().get(platform._local_account_id).password == ""


def test_deleted_account_id_does_not_reassign_a_verification_hold(client):
    import core.verification_hold as holds
    from domain.accounts import AccountCreateCommand
    from infrastructure.accounts_repository import AccountsRepository

    repository = AccountsRepository()
    original = repository.create(AccountCreateCommand(
        platform="chatgpt",email="held-row@example.invalid",password="",lifecycle_status="phone_required"))
    hold = holds.activate_verification_hold("rate_limit_exceeded", account_id=original.id)
    assert repository.delete(original.id)
    replacement = repository.create(AccountCreateCommand(
        platform="chatgpt",email="new-row@example.invalid",password="",lifecycle_status="phone_required"))
    current = client.get("/api/tasks/verification-hold").json()["verification_hold"]
    assert current["account_id"] == original.id and current["account_exists"] is False
    assert replacement.id > original.id
    assert not holds.can_resume_verification_hold(hold,replacement.id,True,hold["detected_at"])


def test_deleted_checkpoint_id_never_updates_a_replacement_record(client):
    from core.base_platform import RegisterConfig
    from domain.accounts import AccountCreateCommand
    from infrastructure.accounts_repository import AccountsRepository
    from platforms.chatgpt.plugin import ChatGPTPlatform

    repository = AccountsRepository()
    platform = ChatGPTPlatform(RegisterConfig())
    ctx = SimpleNamespace(identity=SimpleNamespace(email="reused-checkpoint@example.invalid"),password="fixture-original")
    raw = {"account_id":"fixture-owner","session_token":"original-session","phone_verified":False}
    platform._save_security_checkpoint(ctx,raw)
    original_id = platform._local_account_id
    assert repository.delete(original_id)
    replacement = repository.create(AccountCreateCommand(
        platform="chatgpt",email=ctx.identity.email,password="fixture-replacement",user_id="fixture-owner",
        credentials={"session_token":"replacement-session"}))
    with pytest.raises(ValueError):
        platform._save_security_checkpoint(ctx,{**raw,"session_token":"late-session"})
    assert repository.get(replacement.id) == replacement
    assert replacement.id > original_id


def test_queued_action_for_a_deleted_id_does_not_run_on_its_replacement(client, monkeypatch):
    import infrastructure.platform_runtime as runtime
    from domain.accounts import AccountCreateCommand
    from infrastructure.accounts_repository import AccountsRepository

    repository = AccountsRepository()
    original = repository.create(AccountCreateCommand(
        platform="chatgpt",email="queued-owner@example.invalid",password="",user_id="fixture-original"))
    queued = tasks.create_platform_action_task({
        "platform":"chatgpt","account_id":original.id,"action_id":"query_state","params":{}})
    assert repository.delete(original.id)
    replacement = repository.create(AccountCreateCommand(
        platform="chatgpt",email="unrelated-owner@example.invalid",password="",user_id="fixture-replacement"))
    calls = []
    class Platform:
        def __init__(self,config):pass
        def set_logger(self,log):pass
        def execute_action(self,action_id,account,params):
            calls.append(account.email)
            return {"ok":True,"data":{}}
    monkeypatch.setattr(runtime,"get",lambda _:Platform)
    tasks.execute_task(queued["id"])
    assert calls == []
    assert tasks.get_task(queued["id"])["status"] == "failed"
    assert repository.get(replacement.id) == replacement



@pytest.mark.parametrize("outcome", ["success", "missing_token", "order_unavailable"])
def test_trae_checkout_action_uses_only_the_saved_account_token(client, monkeypatch, outcome):
    from urllib.parse import urlsplit
    from sqlmodel import Session, select
    from core.base_platform import Account
    from core.db import AccountCredentialModel, AccountModel, engine, save_account
    from core.account_graph import load_account_graphs
    from platforms.trae.plugin import TraePlatform

    token = "" if outcome == "missing_token" else "fixture-target-token"
    target = save_account(Account(platform="trae", email="target@example.invalid",
        password="fixture-target-password", token=token, user_id="fixture-target",
        extra={"cashier_url": "https://fixture.invalid/old-target"}))
    other = save_account(Account(platform="trae", email="other@example.invalid",
        password="fixture-other-password", token="fixture-other-token", user_id="fixture-other",
        extra={"cashier_url": "https://fixture.invalid/old-other"}))

    def snapshot():
        with Session(engine) as db:
            return {
                "credentials": [{key: value for key, value in row.model_dump().items() if key not in {"id", "created_at", "updated_at"}}
                    for row in db.exec(select(AccountCredentialModel).order_by(AccountCredentialModel.account_id, AccountCredentialModel.key)).all()],
                "other": db.get(AccountModel, other.id).model_dump(),
                "graphs": load_account_graphs(db, [target.id, other.id]),
            }
    before = snapshot()
    calls = []
    class Executor:
        def __enter__(self):
            calls.append("enter")
            return self
        def __exit__(self, *args):
            calls.append("close")
        def post(self, url, **kwargs):
            path = urlsplit(url).path
            calls.append(path)
            if path != "/trae/api/v1/pay/create_order":
                raise ConnectionError("Fixture sign-in service unavailable")
            assert kwargs["headers"]["Authorization"] == "Cloud-IDE-JWT fixture-target-token"
            assert kwargs["json"]["product_ids"] == ["2"]
            if outcome == "order_unavailable":
                raise ConnectionError("Fixture order service unavailable")
            return SimpleNamespace(status_code=200, text="fixture-order",
                json=lambda: {"order_info": {"cashier_url": "https://fixture.invalid/target-checkout"}})
    monkeypatch.setattr(TraePlatform, "_make_executor", lambda self: Executor())

    response = client.post(f"/api/actions/trae/{target.id}/get_cashier_url", json={"params": {}})
    assert response.status_code == 200
    task_id = response.json()["id"]
    tasks.execute_task(task_id)
    task = tasks.get_task(task_id)
    after = snapshot()
    assert after["credentials"] == before["credentials"]
    assert after["other"] == before["other"]
    assert after["graphs"][other.id] == before["graphs"][other.id]
    if outcome == "missing_token":
        assert calls == []
        assert task["status"] == "failed"
    else:
        assert calls == ["enter", "/trae/api/v1/pay/create_order", "close"]
        assert task["status"] == ("succeeded" if outcome == "success" else "failed")
    if outcome == "success":
        assert after["graphs"][target.id]["overview"]["cashier_url"] == "https://fixture.invalid/target-checkout"
    else:
        assert after["graphs"][target.id] == before["graphs"][target.id]


def test_explicit_password_clear_still_uses_the_account_api(client):
    from domain.accounts import AccountCreateCommand
    from infrastructure.accounts_repository import AccountsRepository

    repository = AccountsRepository()
    original = repository.create(AccountCreateCommand(
        platform="chatgpt",email="clear-password@example.invalid",password="fixture-saved-password",
        user_id="fixture-owner"))
    response = client.patch("/api/accounts/"+str(original.id),json={"password":""})
    assert response.status_code == 200
    assert repository.get(original.id).password == ""


def test_initial_save_can_complete_one_unknown_identity_and_targeted_repair():
    from core.base_platform import Account
    from core.db import save_account
    from domain.accounts import AccountCreateCommand
    from infrastructure.accounts_repository import AccountsRepository

    repository = AccountsRepository()
    pending = repository.create(AccountCreateCommand(
        platform="chatgpt", email="unknown-identity@example.invalid", password="fixture-before",
        lifecycle_status="2fa_required", credentials={"session_token": "saved-session"}))
    completed = save_account(Account(platform="chatgpt", email=pending.email, password="fixture-after",
                                     user_id="fixture-verified", extra={"access_token": "returned-access"}))
    assert completed.id == pending.id and completed.user_id == "fixture-verified"
    repaired = save_account(Account(platform="chatgpt", email=pending.email, password="fixture-verified",
                                    user_id="fixture-authoritative", extra={"access_token": "fresh-access"}),
                           account_id=pending.id)
    assert repaired.id == pending.id and repaired.user_id == "fixture-authoritative"


@pytest.mark.parametrize("change", ["deleted", "duplicate"])
def test_fresh_checkpoints_keep_their_local_record_between_callbacks(client, change):
    from core.base_platform import RegisterConfig
    from domain.accounts import AccountCreateCommand
    from infrastructure.accounts_repository import AccountsRepository
    from platforms.chatgpt.plugin import ChatGPTPlatform

    repository = AccountsRepository()
    platform = ChatGPTPlatform(RegisterConfig())
    ctx = SimpleNamespace(identity=SimpleNamespace(email="checkpoint-pinned@example.invalid"), password="fixture-password")
    state = {"account_id": "fixture-owner", "session_token": "first-session", "phone_verified": False}
    platform._save_security_checkpoint(ctx, state)
    with Session(engine) as session:
        original = session.exec(select(AccountModel).where(AccountModel.email==ctx.identity.email)).one()
        original_id = int(original.id)
    if change=="deleted":
        assert repository.delete(original_id)
        with pytest.raises(ValueError):
            platform._save_security_checkpoint(ctx, {**state, "session_token": "second-session"})
        assert repository.get(original_id) is None
        with Session(engine) as session:
            assert session.exec(select(AccountModel).where(AccountModel.email==ctx.identity.email)).all() == []
    else:
        duplicate = repository.create(AccountCreateCommand(
            platform="chatgpt", email=ctx.identity.email, password="fixture-duplicate", user_id="fixture-owner",
            credentials={"session_token": "duplicate-session"}))
        platform._save_security_checkpoint(ctx, {**state, "session_token": "second-session"})
        assert repository.get(duplicate.id) == duplicate
        selected = repository.get(original_id)
        assert next(item["value"] for item in selected.credentials if item["key"]=="session_token") == "second-session"
    assert platform._local_account_id == original_id


@pytest.mark.parametrize("replacement", [False, True])
def test_final_registration_save_keeps_the_platform_checkpoint_target(client, monkeypatch, replacement):
    from core.base_platform import Account
    from core.db import save_account
    from core import base_mailbox
    from core.proxy_pool import proxy_pool
    from domain.accounts import AccountCreateCommand
    from infrastructure.accounts_repository import AccountsRepository

    repository = AccountsRepository()
    state, uploads = {}, []
    account = Account(platform="chatgpt", email="checkpoint-final@example.invalid", password="fixture-original",
                      user_id="fixture-owner", extra={"session_token": "original-session"})
    class Platform:
        def register(self, **kwargs):
            model = save_account(account)
            self._local_account_id = int(model.id)
            state["id"] = int(model.id)
            if replacement:
                repository.create(AccountCreateCommand(platform="chatgpt", email="sentinel-final@example.invalid", password=""))
            assert repository.delete(state["id"])
            if replacement:
                row = repository.create(AccountCreateCommand(
                    platform="chatgpt", email=account.email, password="fixture-replacement",
                    user_id=account.user_id, credentials={"session_token": "replacement-session"}))
                state["replacement"] = repository.get(row.id)
            return account
    monkeypatch.setattr(tasks, "_resolve_sms_provider_for_task", lambda _: ("", {}))
    monkeypatch.setattr(tasks, "_build_platform_instance", lambda *args, **kwargs: Platform())
    monkeypatch.setattr(base_mailbox, "create_mailbox", lambda *args, **kwargs: SimpleNamespace())
    monkeypatch.setattr(proxy_pool, "get_next", lambda **kwargs: None)
    monkeypatch.setattr(tasks, "_auto_upload_cpa", lambda *args: uploads.append("cpa"))
    monkeypatch.setattr(tasks, "_auto_push_any2api", lambda *args: uploads.append("any2api"))
    response = client.post("/api/tasks/register", json={"platform":"chatgpt","count":1,
        "extra":{"identity_provider":"mailbox","mail_provider":"cfworker_admin_api"}})
    assert response.status_code==200
    task_id = response.json()["task_id"]
    tasks.execute_task(task_id)
    assert repository.get(state["id"]) is None
    if replacement:
        assert repository.get(state["replacement"].id) == state["replacement"]
    assert tasks.get_task(task_id)["status"]=="failed" and tasks.get_task(task_id)["success"]==0
    assert uploads == []


def test_initial_save_serializes_same_email_selection(monkeypatch):
    from core import db
    from core.base_platform import Account

    selected, release, entered_second, finished_second = (threading.Event() for _ in range(4))
    errors, ids = [], []
    original_session = db.Session
    class PausedSession(original_session):
        def exec(self, statement, *args, **kwargs):
            result = super().exec(statement, *args, **kwargs)
            if (threading.current_thread().name=="initial-save-first"
                    and str(statement).startswith("SELECT accounts.") and not selected.is_set()):
                selected.set()
                assert release.wait(3)
            return result
    monkeypatch.setattr(db, "Session", PausedSession)
    def save(second):
        if second:
            entered_second.set()
        try:
            model = db.save_account(Account(platform="chatgpt", email="parallel-save@example.invalid",
                                           password="fixture-password", user_id="fixture-owner"))
            ids.append(int(model.id))
        except Exception as exc:
            errors.append(type(exc).__name__)
        finally:
            if second:
                finished_second.set()
    first = threading.Thread(target=save,args=(False,),name="initial-save-first")
    second = threading.Thread(target=save,args=(True,),name="initial-save-second")
    first.start()
    try:
        assert selected.wait(2)
        second.start()
        assert entered_second.wait(1)
        assert not finished_second.wait(0.1), "Concurrent save bypassed identity selection"
    finally:
        release.set()
        first.join(5)
        if second.ident:
            second.join(5)
    assert not first.is_alive() and not second.is_alive() and errors==[]
    assert len(ids)==2 and len(set(ids))==1
    with Session(engine) as session:
        assert len(session.exec(select(AccountModel).where(AccountModel.email=="parallel-save@example.invalid")).all())==1


def test_capability_overrides_and_empty_lists_survive_reads_and_reset(client):
    from core.registry import get_platform_capabilities
    original = get_platform_capabilities("chatgpt")
    response = client.put("/api/platforms/chatgpt/capabilities",
        json={"supported_executors": ["headless"], "supported_oauth_providers": []})
    assert response.status_code == 200
    for _ in range(2):
        current = get_platform_capabilities("chatgpt")
        assert current["supported_executors"] == ["headless"]
        assert current["supported_oauth_providers"] == []
        assert current["capabilities"] == original["capabilities"]
        listed = next(item for item in client.get("/api/platforms").json() if item["name"] == "chatgpt")
        assert listed["supported_executors"] == ["headless"]
    from platforms.chatgpt.plugin import ChatGPTPlatform
    instance = ChatGPTPlatform(RegisterConfig(executor_type="headless"))
    assert instance.supported_oauth_providers == []
    assert client.put("/api/platforms/chatgpt/capabilities", json={"supported_executors": []}).status_code == 200
    with pytest.raises(NotImplementedError):
        ChatGPTPlatform(RegisterConfig(executor_type="headless")).register()
    assert client.get("/api/actions/chatgpt").status_code == 200
    assert client.delete("/api/platforms/chatgpt/capabilities").status_code == 200
    assert get_platform_capabilities("chatgpt") == original


def test_old_capability_row_seeds_only_missing_keys(client):
    from core.registry import get_platform_capabilities
    original = get_platform_capabilities("chatgpt")
    with Session(engine) as session:
        row = session.exec(select(PlatformCapabilityOverrideModel).where(
            PlatformCapabilityOverrideModel.platform_name == "chatgpt")).one()
        row.set_capabilities({"supported_executors": ["headless"]})
        session.add(row)
        session.commit()
    current = get_platform_capabilities("chatgpt")
    assert current == {**original, "supported_executors": ["headless"]}


@pytest.mark.parametrize("cancel_waiter", [False, True])
def test_herosms_alias_serializes_lease_and_cancels_lock_wait(monkeypatch, cancel_waiter):
    lock = threading.Lock()
    monkeypatch.setattr(sms, "_HERO_SMS_VERIFY_LOCK", lock)
    acquired = []
    cancelled = threading.Event()
    class Provider:
        def get_number(self, **kwargs):
            acquired.append(threading.current_thread().name)
            return sms.SmsActivation("fixture-lease", "+15550001111")
        def cancel(self, activation_id): return True
    monkeypatch.setattr(sms, "create_sms_provider", lambda *args: Provider())
    first = sms.PhoneCallbackController("herosms_api", {}, service="fixture", log_fn=lambda _: None)
    second = sms.PhoneCallbackController("herosms_api", {}, service="fixture", log_fn=lambda _: None)
    second.set_cancel_callback(cancelled.is_set)
    first()
    entered = threading.Event()
    finished = threading.Event()
    errors = []
    def run_second():
        entered.set()
        try:
            second()
        except RuntimeError as error:
            errors.append(str(error))
        finally:
            second.cleanup()
            finished.set()
    worker = threading.Thread(target=run_second)
    worker.start()
    try:
        assert entered.wait(1)
        assert not finished.wait(0.1)
        assert len(acquired) == 1
        if cancel_waiter:
            cancelled.set()
            assert finished.wait(1)
            assert len(acquired) == 1
        first.cleanup()
        worker.join(2)
        assert not worker.is_alive()
        assert len(acquired) == (1 if cancel_waiter else 2)
        assert bool(errors) is cancel_waiter
    finally:
        cancelled.set()
        first.cleanup()
        worker.join(2)
    assert not lock.locked()


def test_cancel_during_sms_status_poll_stops_before_code_or_resend(monkeypatch):
    provider = sms.HeroSmsProvider("fixture-key")
    cancelled = [False]
    calls = []
    provider.set_cancel_callback(lambda: cancelled[0])
    monkeypatch.setattr(sms, "_HERO_SMS_CACHE", None)
    def status(*args):
        calls.append("status")
        cancelled[0] = True
        return {"status": "ok", "code": "fixture-code", "sms_key": "fixture-event"}
    monkeypatch.setattr(provider, "get_status_v2", status)
    monkeypatch.setattr(provider, "get_status", lambda *args: pytest.fail("polled after cancellation"))
    monkeypatch.setattr(provider, "request_resend_sms", lambda *args: pytest.fail("resent after cancellation"))
    with pytest.raises(RuntimeError, match="registration_cancelled"):
        provider.wait_for_code("fixture-lease", timeout=1)
    assert calls == ["status"]


def test_sms_logs_hide_secrets_and_cancelled_received_code_is_released(monkeypatch):
    events, logs = [], []
    cancelled = [False]
    class Provider:
        auto_report_success_on_code = False
        def get_number(self, **kwargs): return sms.SmsActivation("fixture-private-lease", "+15550001111")
        def get_code(self, *args, **kwargs): return "123456"
        def report_success(self, *args): events.append("success")
        def cancel(self, *args): events.append("cancel"); return True
    monkeypatch.setattr(sms, "create_sms_provider", lambda *args: Provider())
    callback = sms.PhoneCallbackController("fixture", {}, service="fixture", log_fn=logs.append)
    callback.set_cancel_callback(lambda: cancelled[0])
    assert callback() == "+15550001111"
    assert callback() == "123456"
    cancelled[0] = True
    assert callback.cleanup() is True
    assert events == ["cancel"]
    assert not any(secret in "\n".join(logs) for secret in ["fixture-private-lease", "+15550001111", "123456"])


def test_initial_phone_failure_checkpoints_same_account_without_oauth_retry(monkeypatch):
    from platforms.chatgpt import browser_register as flow
    checkpoints, closed = [], []
    page = SimpleNamespace(context=SimpleNamespace(cookies=lambda: [{"name": "fixture", "value": "fixture-cookie"}]))
    class Browser:
        def __enter__(self): return self
        def __exit__(self, *args): closed.append(True)
        def new_page(self): return page
    monkeypatch.setattr(flow, "Camoufox", lambda **kwargs: Browser())
    def reject(*args):
        error = RuntimeError("fraud_guard: fixture verification rejected")
        error.verification_error_code = "fraud_guard"
        error.rental_cleanup_confirmed = True
        error.password_set = False
        raise error
    monkeypatch.setattr(flow, "_browser_registration_flow", reject)
    callback = SimpleNamespace(verification_error_code="fraud_guard", rental_cleanup_confirmed=True)
    worker = flow.ChatGPTBrowserRegister(headless=True, phone_callback=callback,
        security_checkpoint=lambda state: checkpoints.append(state), log_fn=lambda _: None)
    monkeypatch.setattr(worker, "_retry_oauth_fresh_browser", lambda *args: pytest.fail("retried a rejected signup"))
    result = worker.run("fixture@example.invalid", "unused-generated-password")
    assert result["password"] == "" and result["password_set"] is False
    assert len(checkpoints) == 1 and closed == [True]
    assert result["email"] == "fixture@example.invalid"
    assert result["verification_error_code"] == "fraud_guard"
    assert result["rental_cleanup_confirmed"] is True
    assert result["status"] == "phone_required"
    assert "fixture-cookie" in result["cookies"]


@pytest.mark.parametrize("accepted", [False, True])
def test_only_accepted_phone_otp_can_start_security_completion(monkeypatch, accepted):
    from platforms.chatgpt import browser_register as flow
    from platforms.chatgpt.plugin import ChatGPTPlatform
    calls = []
    raw = {"email": "fixture@example.invalid", "account_id": "fixture-account",
           "access_token": "fixture-access", "refresh_token": "fixture-refresh", "id_token": "fixture-id"}
    monkeypatch.setattr(flow, "_do_codex_oauth", lambda *args, **kwargs: dict(raw))
    def security(*args):
        calls.append("security")
        args[4].update(authenticator_verified=True, phone_mfa_disabled=True)
    monkeypatch.setattr(flow, "_complete_chatgpt_security", security)
    page = SimpleNamespace(context=SimpleNamespace(cookies=lambda: []))
    callback = SimpleNamespace(completed=True, phone_verification_succeeded=accepted)
    worker = flow.ChatGPTBrowserRegister(headless=True, phone_callback=callback,
        security_checkpoint=lambda state: None, log_fn=lambda _: None)
    result = worker._complete_oauth_in_page(page, raw["email"], "")
    assert result["phone_verified"] is accepted
    assert calls == (["security"] if accepted else [])
    mapped = ChatGPTPlatform(RegisterConfig())._map_chatgpt_result(result, expected_email=raw["email"])
    assert mapped.status == (AccountStatus.REGISTERED if accepted else AccountStatus.PHONE_REQUIRED)


def test_cancel_during_rental_keeps_lease_owned_for_cleanup(monkeypatch):
    cancelled = [False]
    released = []
    class Provider:
        def get_number(self, **kwargs):
            cancelled[0] = True
            return sms.SmsActivation("fixture-lease", "+15550001111")
        def cancel(self, activation_id):
            released.append(activation_id)
            return True
    monkeypatch.setattr(sms, "create_sms_provider", lambda *args: Provider())
    callback = sms.PhoneCallbackController("fixture", {}, service="fixture", log_fn=lambda _: None)
    callback.set_cancel_callback(lambda: cancelled[0])
    with pytest.raises(RuntimeError, match="registration_cancelled"):
        callback()
    assert callback.activation.activation_id == "fixture-lease"
    assert callback.cleanup() is True
    assert released == ["fixture-lease"]


def test_cancel_after_account_creation_preserves_account_without_external_followups(monkeypatch):
    from core.base_platform import Account
    task = tasks.create_register_task({"platform": "chatgpt", "count": 1,
        "extra": {"identity_provider": "oauth_browser"}})
    def register(**kwargs):
        tasks.request_cancel(task["id"])
        return Account(platform="chatgpt", email="fixture-cancel@example.invalid", password="", status=AccountStatus.REGISTERED)
    monkeypatch.setattr(tasks, "_resolve_sms_provider_for_task", lambda _: ("", {}))
    monkeypatch.setattr(tasks, "_build_platform_instance", lambda *args, **kwargs: SimpleNamespace(register=register))
    for name in ("_auto_upload_cpa", "_auto_push_any2api", "_auto_followup_windsurf_payment"):
        monkeypatch.setattr(tasks, name, lambda *args, **kwargs: pytest.fail("external follow-up after cancellation"))
    from core.proxy_pool import proxy_pool
    monkeypatch.setattr(proxy_pool, "get_next", lambda **kwargs: None)
    tasks.execute_task(task["id"])
    result = tasks.get_task(task["id"])
    assert result["status"] == "cancelled" and result["success"] == 0
    with Session(engine) as session:
        assert session.exec(select(AccountModel).where(AccountModel.email == "fixture-cancel@example.invalid")).one()


@pytest.mark.parametrize("stage", ["reauth", "factor_info", "enrollment", "code_generation", "disable"])
def test_mfa_cancellation_prevents_next_remote_mutation(monkeypatch, stage):
    from platforms.chatgpt import security
    class Logger:
        cancelled = False
        def log(self, message): pass
        def is_cancel_requested(self): return self.cancelled
    logger = Logger()
    mutations = []
    def reauthenticate(*args):
        logger.cancelled = stage == "reauth"
        return {"accessToken": "fixture-access", "cookies": {}}
    monkeypatch.setattr(security, "_reauthenticate", reauthenticate)
    def api(page, url, **kwargs):
        if url.endswith("mfa_info"):
            logger.cancelled = stage in {"factor_info", "disable"}
            return {"factors": {"totp": ["fixture"] if stage == "disable" else [], "sms": ["fixture"]}}
        mutations.append(url.rsplit("/", 1)[-1])
        assert stage in {"enrollment", "code_generation"} and url.endswith("/enroll")
        logger.cancelled = stage == "enrollment"
        return {"secret": "fixture-secret", "session_id": "fixture-session"}
    monkeypatch.setattr(security, "_api", api)
    def generate(*args, **kwargs):
        logger.cancelled = True
        return "fixture-code"
    monkeypatch.setattr(security, "totp_code", generate)
    monkeypatch.setattr(security, "_disable_phone_mfa", lambda *args: pytest.fail("disabled MFA after cancellation"))
    with pytest.raises(RuntimeError, match="registration_cancelled"):
        security.complete_chatgpt_security(SimpleNamespace(), "fixture@example.invalid", "", None, {},
                                           lambda state: None, logger.log)
    assert mutations == (["enroll"] if stage in {"enrollment", "code_generation"} else [])


@pytest.mark.parametrize("restricted", ["fraud_guard", "rate_limit_exceeded", "account_deactivated", "human_verification", "about_you_rejected"])
def test_security_rejection_stops_batch_without_switching_accounts(client, monkeypatch, restricted):
    from core.base_platform import Account
    calls = []
    def register(**kwargs):
        calls.append(True)
        if restricted in {"fraud_guard", "rate_limit_exceeded"}:
            return Account(platform="chatgpt", email="fixture-restricted@example.invalid", password="",
                status=AccountStatus(restricted), extra={"rental_cleanup_confirmed": True})
        raise RuntimeError(restricted + ": fixture rejection")
    monkeypatch.setattr(tasks, "_resolve_sms_provider_for_task", lambda _: ("", {}))
    monkeypatch.setattr(tasks, "_build_platform_instance", lambda *args, **kwargs: SimpleNamespace(register=register))
    from core.proxy_pool import proxy_pool
    monkeypatch.setattr(proxy_pool, "get_next", lambda **kwargs: None)
    task = tasks.create_register_task({"platform": "chatgpt", "count": 3,
        "extra": {"identity_provider": "oauth_browser"}})
    tasks.execute_task(task["id"])
    result = tasks.get_task(task["id"])
    assert len(calls) == 1
    assert result["status"] == "paused"
    assert result["success"] == 0 and result["error_count"] == 1


def test_terminal_state_and_final_log_become_visible_in_the_same_commit(monkeypatch):
    task = tasks.create_register_task({"platform": "chatgpt", "count": 1})
    original_commit = Session.commit
    observed = []
    def commit(session):
        original_commit(session)
        current = tasks.get_task(task["id"])
        if current["status"] in tasks.TERMINAL_TASK_STATUSES:
            messages = [event["message"] for event in tasks.list_task_events(task["id"])]
            observed.append(any(message == "任务结束: succeeded" for message in messages))
    monkeypatch.setattr(Session, "commit", commit)
    tasks.TaskLogger(task["id"]).finish(tasks.TASK_STATUS_SUCCEEDED)
    assert observed and all(observed)


def test_provider_alias_migration_does_not_merge_different_authentication_identities():
    from core.db import init_db, ProviderDefinitionModel, ProviderSettingModel
    from infrastructure.provider_settings_repository import ProviderSettingsRepository
    legacy = ProviderSettingModel(provider_type="mailbox", provider_key="moemail", auth_mode="token")
    legacy.set_auth({"session_token": "fixture-owner-a"})
    canonical = ProviderSettingModel(provider_type="mailbox", provider_key="moemail_api", auth_mode="password")
    canonical.set_auth({"username": "fixture-owner-b", "password": "fixture-password"})
    definition = ProviderDefinitionModel(provider_type="mailbox", provider_key="moemail",
                                         driver_type="moemail_api")
    definition.set_auth_modes([{"value": "token"}])
    with Session(engine) as session:
        session.add(legacy)
        session.add(canonical)
        session.add(definition)
        session.commit()
    for _ in range(2):
        init_db()
        repo = ProviderSettingsRepository()
        old = repo.get_by_key("mailbox", "moemail")
        current = repo.get_by_key("mailbox", "moemail_api")
        assert old is not None and old.get_auth() == {"session_token": "fixture-owner-a"}
        assert current.get_auth() == {"username": "fixture-owner-b", "password": "fixture-password"}
        assert current.auth_mode == "password"


@pytest.mark.parametrize("provider_type,provider_key,enabled", [
    ("mailbox", "tempmail_lol_api", True),
    ("captcha", "manual", True),
    ("mailbox", "tempmail_lol_api", False),
])
def test_zero_config_provider_selection_survives_restart(client, provider_type, provider_key, enabled):
    from core.db import init_db
    from infrastructure.provider_settings_repository import ProviderSettingsRepository
    response = client.put("/api/provider-settings", json={
        "provider_type": provider_type, "provider_key": provider_key,
        "enabled": enabled, "is_default": True,
    })
    assert response.status_code == 200
    setting_id = response.json()["item"]["id"]
    for _ in range(2):
        init_db()
        saved = ProviderSettingsRepository().get(setting_id)
        assert saved is not None, "startup removed an intentional zero-config provider"
        assert saved.provider_key == provider_key and saved.enabled is enabled and saved.is_default


@pytest.mark.parametrize("conflicting", [False, True])
def test_provider_alias_migration_preserves_saved_credentials_and_configuration(conflicting):
    from core.db import init_db, ProviderDefinitionModel, ProviderSettingModel
    from infrastructure.provider_settings_repository import ProviderSettingsRepository
    old = ProviderSettingModel(provider_type="sms", provider_key="herosms",
                               display_name="Saved fixture", auth_mode="api_key", is_default=True)
    old.set_auth({"herosms_api_key": "fixture-original"})
    old.set_config({"herosms_default_country": "16", "herosms_max_price": "0.08"})
    old.set_metadata({"fixture": "keep"})
    current = ProviderSettingModel(provider_type="sms", provider_key="herosms_api",
                                   auth_mode="apikey", enabled=False)
    current.set_auth({"herosms_api_key": "fixture-current" if conflicting else ""})
    current.set_config({"sms_service": "dr"})
    with Session(engine) as session:
        session.add(old)
        session.add(current)
        session.add(ProviderDefinitionModel(provider_type="sms", provider_key="herosms", driver_type="herosms_api"))
        session.commit()
    for _ in range(2):
        init_db()
        repo = ProviderSettingsRepository()
        legacy = repo.get_by_key("sms", "herosms")
        canonical = repo.get_by_key("sms", "herosms_api")
        assert canonical is not None
        assert canonical.enabled is False, "migration changed an explicit disabled selection"
        if conflicting:
            assert legacy is not None, "migration discarded a conflicting saved credential"
            assert legacy.get_auth()["herosms_api_key"] == "fixture-original"
            assert canonical.get_auth()["herosms_api_key"] == "fixture-current"
            assert repo.definitions.get_by_key("sms", "herosms") is not None
        else:
            assert legacy is None
            resolved = repo.resolve_runtime_settings("sms", "herosms_api")
            assert resolved["herosms_api_key"] == "fixture-original"
            assert resolved["herosms_default_country"] == "16"
            assert resolved["herosms_max_price"] == "0.08" and resolved["sms_service"] == "dr"
            assert canonical.get_metadata() == {"fixture": "keep"}
            assert canonical.is_default


@pytest.mark.parametrize("driver,provider_class,auth_key,prefix", [
    ("herosms_api", "HeroSmsProvider", "herosms_api_key", "herosms"),
    ("smsbower_api", "SmsBowerProvider", "smsbower_api_key", "smsbower"),
    ("sms_activate_api", "SmsActivateProvider", "sms_activate_api_key", "sms_activate"),
])
def test_custom_sms_catalog_key_resolves_its_driver_without_losing_settings_or_hold(
        monkeypatch, driver, provider_class, auth_key, prefix):
    from core.db import ProviderDefinitionModel, ProviderSettingModel
    from core.registration import RegistrationContext
    from core.registration.helpers import build_phone_callbacks
    captures, guards, released = [], [], []
    definition = ProviderDefinitionModel(provider_type="sms", provider_key="fixture-custom",
                                         driver_type=driver, default_auth_mode="apikey")
    definition.set_fields([{"key": auth_key, "category": "auth"}])
    saved = ProviderSettingModel(provider_type="sms", provider_key="fixture-custom", is_default=True)
    saved.set_auth({auth_key: "fixture-selected-key"})
    saved.set_config({prefix + "_default_country": "16", prefix + "_default_service": "dr",
                      prefix + "_max_price": "0.08"})
    with Session(engine) as session:
        session.add(definition)
        session.add(saved)
        session.commit()
    class Provider:
        def __init__(self, **kwargs): captures.append(kwargs)
        def get_number(self, **kwargs):
            captures.append(kwargs)
            return sms.SmsActivation("fixture-lease", "+15550001111")
        def cancel(self, activation_id):
            released.append(activation_id)
            return True
    monkeypatch.setattr(sms, provider_class, Provider)
    monkeypatch.setattr("core.verification_hold.require_phone_verification_allowed", lambda **kwargs: guards.append(kwargs))
    ctx = RegistrationContext(platform_name="chatgpt", platform_display_name="ChatGPT",
        platform=SimpleNamespace(), identity=SimpleNamespace(), email=None, password=None,
        config=RegisterConfig(executor_type="headless", extra={
            "sms_provider": "fixture-custom", "_verification_hold_account_id": 999,
            "_verification_hold_detected_at": "fixture-hold",
        }), log_fn=lambda _: None)
    callback, cleanup = build_phone_callbacks(ctx)
    try:
        assert callback() == "+15550001111"
        assert captures[0]["api_key"] == "fixture-selected-key"
        assert captures[1] == {"service": "dr", "country": "16"}
        assert guards and all(item["account_id"] == 999 and item["resume"] is False
                              and item["detected_at"] == "fixture-hold" for item in guards)
    finally:
        cleanup()
    assert released == ["fixture-lease"]

