"""Offline migration coverage for non-reusable local account identities."""
import json

import pytest
from sqlalchemy import event
from sqlmodel import Session, select

from application import tasks
from core import db
from core.base_platform import Account
from core.config_store import config_store
from core.verification_hold import HOLD_KEY, activate_verification_hold
from domain.accounts import AccountCreateCommand
from infrastructure.accounts_repository import AccountsRepository


@pytest.fixture(params=[False, True], ids=["current-schema", "legacy-schema"])
def old_account_schema(client, request):
    legacy = (", region VARCHAR DEFAULT '', token VARCHAR DEFAULT '', status VARCHAR DEFAULT 'registered', "
              "trial_end_time INTEGER DEFAULT 0, cashier_url VARCHAR DEFAULT '', extra_json VARCHAR DEFAULT '{}'"
              if request.param else "")
    with db.engine.begin() as connection:
        connection.exec_driver_sql("DROP TABLE accounts")
        connection.exec_driver_sql(
            "CREATE TABLE accounts (id INTEGER NOT NULL PRIMARY KEY, platform VARCHAR NOT NULL, "
            "email VARCHAR NOT NULL, password VARCHAR NOT NULL, user_id VARCHAR NOT NULL, "
            "created_at DATETIME NOT NULL, updated_at DATETIME NOT NULL"+legacy+")")
    repository = AccountsRepository()
    rows = [
        repository.create(AccountCreateCommand(
            platform="chatgpt", email="first-migration@example.invalid", password="fixture-first", user_id="fixture-first",
            credentials={"session_token":"first-session","refresh_token":"first-refresh"},
            provider_accounts=[{"provider_type":"mailbox","provider_name":"cfworker_admin_api",
                                "login_identifier":"first-migration@example.invalid","metadata":{"fixture":"keep"}}],
            provider_resources=[{"provider_type":"mailbox","provider_name":"cfworker_admin_api","resource_type":"mailbox",
                                 "resource_identifier":"fixture-mailbox","handle":"first-migration@example.invalid"}])),
        repository.create(AccountCreateCommand(
            platform="grok", email="second-migration@example.invalid", password="fixture-second", user_id="fixture-second",
            credentials={"api_key":"second-key"})),
    ]
    with db.engine.begin() as connection:
        connection.exec_driver_sql("CREATE INDEX account_owner_test ON accounts (user_id)")
        connection.exec_driver_sql("CREATE TRIGGER account_noop_test AFTER UPDATE ON accounts BEGIN SELECT 1; END")
    def enable_foreign_keys(connection, record):
        connection.execute("PRAGMA foreign_keys=ON")
    event.listen(db.engine, "connect", enable_foreign_keys)
    db.engine.dispose()
    try:
        yield repository, rows
    finally:
        event.remove(db.engine, "connect", enable_foreign_keys)
        db.engine.dispose()


def _raw_accounts():
    with db.engine.connect() as connection:
        return list(connection.exec_driver_sql(
            "SELECT id,platform,email,password,user_id,created_at,updated_at FROM accounts ORDER BY id"))


def test_account_id_upgrade_preserves_data_and_persisted_references(old_account_schema):
    repository, rows = old_account_schema
    gone = repository.create(AccountCreateCommand(
        platform="chatgpt",email="gone-migration@example.invalid",password="",
        user_id="fixture-gone",lifecycle_status="phone_required"))
    activate_verification_hold("rate_limit_exceeded",account_id=gone.id,owner="fixture-owner")
    assert repository.delete(gone.id)
    single = tasks.create_platform_action_task({
        "platform":"chatgpt","account_id":50,"action_id":"query_state","params":{}})
    bulk = tasks.create_platform_action_task({
        "platform":"chatgpt","account_ids":[55,60],"action_id":"complete_registration","params":{}})
    before = _raw_accounts()
    hold_before = config_store.get(HOLD_KEY)
    task_before = [tasks.get_task(single["id"]),tasks.get_task(bulk["id"])]
    saved = {row.id:repository.get(row.id) for row in rows}
    db.init_db()
    assert _raw_accounts() == before
    assert config_store.get(HOLD_KEY) == hold_before
    assert [tasks.get_task(single["id"]),tasks.get_task(bulk["id"])] == task_before
    for row in rows:
        current = repository.get(row.id)
        assert current.password == saved[row.id].password and current.user_id == saved[row.id].user_id
        for attribute in ("credentials","provider_accounts","provider_resources"):
            current_items = [{key:value for key,value in item.items() if key!="id"}
                             for item in getattr(current,attribute)]
            saved_items = [{key:value for key,value in item.items() if key!="id"}
                           for item in getattr(saved[row.id],attribute)]
            assert current_items == saved_items
    with db.engine.connect() as connection:
        sql = connection.exec_driver_sql("SELECT sql FROM sqlite_master WHERE name='accounts'").scalar_one()
        assert "AUTOINCREMENT" in sql.upper()
        assert connection.exec_driver_sql("PRAGMA foreign_key_check").all() == []
        assert connection.exec_driver_sql("PRAGMA foreign_keys").scalar_one() == 1
        objects = {row[0] for row in connection.exec_driver_sql(
            "SELECT name FROM sqlite_master WHERE tbl_name='accounts' AND type IN ('index','trigger')")}
        assert {"account_owner_test","account_noop_test","ix_accounts_platform","ix_accounts_email"} <= objects
    first_new = repository.create(AccountCreateCommand(platform="chatgpt",email="after-upgrade@example.invalid",password=""))
    assert first_new.id > 60
    assert repository.delete(first_new.id)
    db.init_db()
    next_new = repository.create(AccountCreateCommand(platform="chatgpt",email="after-restart@example.invalid",password=""))
    assert next_new.id > first_new.id
    assert config_store.get(HOLD_KEY) == hold_before


def test_account_id_upgrade_rolls_back_schema_and_restores_foreign_keys(old_account_schema):
    repository, rows = old_account_schema
    before = _raw_accounts()
    saved = {row.id:repository.get(row.id) for row in rows}
    def fail_before_rename(connection,cursor,statement,parameters,context,executemany):
        if statement.strip().startswith("ALTER TABLE accounts__new RENAME"):
            raise RuntimeError("fixture migration failure")
    event.listen(db.engine,"before_cursor_execute",fail_before_rename)
    try:
        with pytest.raises(RuntimeError,match="fixture migration failure"):
            db._migrate_legacy_accounts_schema()
    finally:
        event.remove(db.engine,"before_cursor_execute",fail_before_rename)
    assert _raw_accounts() == before
    for row in rows:
        assert repository.get(row.id) == saved[row.id]
    with db.engine.connect() as connection:
        assert connection.exec_driver_sql(
            "SELECT count(*) FROM sqlite_master WHERE name='accounts__new'").scalar_one() == 0
        assert connection.exec_driver_sql("PRAGMA foreign_keys").scalar_one() == 1
        assert connection.exec_driver_sql("PRAGMA foreign_key_check").all() == []



def test_unknown_account_columns_stop_upgrade_without_data_loss(old_account_schema):
    with db.engine.begin() as connection:
        connection.exec_driver_sql("ALTER TABLE accounts ADD COLUMN fixture_external_note VARCHAR DEFAULT 'keep'")
    before = _raw_accounts()
    with pytest.raises(RuntimeError,match="未知列"):
        db._migrate_legacy_accounts_schema()
    assert _raw_accounts() == before
    with db.engine.connect() as connection:
        assert connection.exec_driver_sql("SELECT fixture_external_note FROM accounts").scalars().all() == ["keep","keep"]
        assert connection.exec_driver_sql("PRAGMA foreign_keys").scalar_one() == 1


def test_malformed_reference_metadata_does_not_break_account_id_startup(client):
    from core.db import TaskModel
    config_store.set(HOLD_KEY,"not-json")
    with Session(db.engine) as session:
        session.add(TaskModel(id="fixture-malformed-reference",type="platform_action",platform="chatgpt",
                              payload_json=json.dumps({"account_id":True,"account_ids":"bad"})))
        session.commit()
    db.init_db()
    account = AccountsRepository().create(AccountCreateCommand(
        platform="chatgpt",email="valid-after-metadata@example.invalid",password=""))
    assert account.id > 0
