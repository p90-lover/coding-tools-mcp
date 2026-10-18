"""数据库模型 - SQLite via SQLModel"""
import json
import os
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

from sqlalchemy import UniqueConstraint, inspect
from sqlmodel import Field, SQLModel, Session, create_engine, select


def _utcnow():
    return datetime.now(timezone.utc)


def _default_database_url() -> str:
    database_path = Path(__file__).resolve().parent.parent / "account_manager.db"
    return f"sqlite:///{database_path}"


DATABASE_URL = os.getenv("ACCOUNT_MANAGER_DATABASE_URL", _default_database_url())
engine = create_engine(DATABASE_URL)


class AccountModel(SQLModel, table=True):
    __tablename__ = "accounts"
    __table_args__ = {"sqlite_autoincrement": True}

    id: Optional[int] = Field(default=None, primary_key=True)
    platform: str = Field(index=True)
    email: str = Field(index=True)
    password: str
    user_id: str = ""
    created_at: datetime = Field(default_factory=_utcnow)
    updated_at: datetime = Field(default_factory=_utcnow)


class AccountOverviewModel(SQLModel, table=True):
    __tablename__ = "account_overviews"

    account_id: int = Field(primary_key=True, foreign_key="accounts.id")
    lifecycle_status: str = Field(default="registered", index=True)
    validity_status: str = Field(default="unknown", index=True)
    plan_state: str = Field(default="unknown", index=True)
    plan_name: str = ""
    display_status: str = Field(default="registered", index=True)
    remote_email: str = ""
    checked_at: Optional[datetime] = None
    summary_json: str = "{}"
    created_at: datetime = Field(default_factory=_utcnow)
    updated_at: datetime = Field(default_factory=_utcnow)

    def get_summary(self) -> dict:
        return json.loads(self.summary_json or "{}")

    def set_summary(self, data: dict):
        self.summary_json = json.dumps(data or {}, ensure_ascii=False)


class AccountCredentialModel(SQLModel, table=True):
    __tablename__ = "account_credentials"

    id: Optional[int] = Field(default=None, primary_key=True)
    account_id: int = Field(index=True, foreign_key="accounts.id")
    scope: str = Field(default="platform", index=True)
    provider_name: str = Field(default="", index=True)
    credential_type: str = Field(default="secret", index=True)
    key: str = Field(default="", index=True)
    value: str = ""
    is_primary: bool = False
    source: str = ""
    metadata_json: str = "{}"
    created_at: datetime = Field(default_factory=_utcnow)
    updated_at: datetime = Field(default_factory=_utcnow)

    def get_metadata(self) -> dict:
        return json.loads(self.metadata_json or "{}")

    def set_metadata(self, data: dict):
        self.metadata_json = json.dumps(data or {}, ensure_ascii=False)


class ProviderAccountModel(SQLModel, table=True):
    __tablename__ = "provider_accounts"

    id: Optional[int] = Field(default=None, primary_key=True)
    account_id: int = Field(index=True, foreign_key="accounts.id")
    provider_type: str = Field(default="mailbox", index=True)
    provider_name: str = Field(default="", index=True)
    login_identifier: str = Field(default="", index=True)
    display_name: str = ""
    credentials_json: str = "{}"
    metadata_json: str = "{}"
    created_at: datetime = Field(default_factory=_utcnow)
    updated_at: datetime = Field(default_factory=_utcnow)

    def get_credentials(self) -> dict:
        return json.loads(self.credentials_json or "{}")

    def set_credentials(self, data: dict):
        self.credentials_json = json.dumps(data or {}, ensure_ascii=False)

    def get_metadata(self) -> dict:
        return json.loads(self.metadata_json or "{}")

    def set_metadata(self, data: dict):
        self.metadata_json = json.dumps(data or {}, ensure_ascii=False)


class ProviderResourceModel(SQLModel, table=True):
    __tablename__ = "provider_resources"

    id: Optional[int] = Field(default=None, primary_key=True)
    account_id: int = Field(index=True, foreign_key="accounts.id")
    provider_type: str = Field(default="mailbox", index=True)
    provider_name: str = Field(default="", index=True)
    resource_type: str = Field(default="resource", index=True)
    resource_identifier: str = Field(default="", index=True)
    handle: str = ""
    display_name: str = ""
    metadata_json: str = "{}"
    created_at: datetime = Field(default_factory=_utcnow)
    updated_at: datetime = Field(default_factory=_utcnow)

    def get_metadata(self) -> dict:
        return json.loads(self.metadata_json or "{}")

    def set_metadata(self, data: dict):
        self.metadata_json = json.dumps(data or {}, ensure_ascii=False)


class ProviderDefinitionModel(SQLModel, table=True):
    __tablename__ = "provider_definitions"
    __table_args__ = (
        UniqueConstraint("provider_type", "provider_key", name="uq_provider_definitions_type_key"),
    )

    id: Optional[int] = Field(default=None, primary_key=True)
    provider_type: str = Field(index=True)
    provider_key: str = Field(index=True)
    label: str = ""
    description: str = ""
    driver_type: str = ""
    default_auth_mode: str = ""
    enabled: bool = True
    is_builtin: bool = False
    category: str = ""  # "free" | "selfhost" | "custom"
    auth_modes_json: str = "[]"
    fields_json: str = "[]"
    metadata_json: str = "{}"
    created_at: datetime = Field(default_factory=_utcnow)
    updated_at: datetime = Field(default_factory=_utcnow)

    def get_auth_modes(self) -> list[dict]:
        return json.loads(self.auth_modes_json or "[]")

    def set_auth_modes(self, data: list[dict]):
        self.auth_modes_json = json.dumps(data or [], ensure_ascii=False)

    def get_fields(self) -> list[dict]:
        return json.loads(self.fields_json or "[]")

    def set_fields(self, data: list[dict]):
        self.fields_json = json.dumps(data or [], ensure_ascii=False)

    def get_metadata(self) -> dict:
        return json.loads(self.metadata_json or "{}")

    def set_metadata(self, data: dict):
        self.metadata_json = json.dumps(data or {}, ensure_ascii=False)


class ProviderSettingModel(SQLModel, table=True):
    __tablename__ = "provider_settings"
    __table_args__ = (
        UniqueConstraint("provider_type", "provider_key", name="uq_provider_settings_type_key"),
    )

    id: Optional[int] = Field(default=None, primary_key=True)
    provider_type: str = Field(index=True)
    provider_key: str = Field(index=True)
    display_name: str = ""
    auth_mode: str = ""
    enabled: bool = True
    is_default: bool = False
    config_json: str = "{}"
    auth_json: str = "{}"
    metadata_json: str = "{}"
    created_at: datetime = Field(default_factory=_utcnow)
    updated_at: datetime = Field(default_factory=_utcnow)

    def get_config(self) -> dict:
        return json.loads(self.config_json or "{}")

    def set_config(self, data: dict):
        self.config_json = json.dumps(data or {}, ensure_ascii=False)

    def get_auth(self) -> dict:
        return json.loads(self.auth_json or "{}")

    def set_auth(self, data: dict):
        self.auth_json = json.dumps(data or {}, ensure_ascii=False)

    def get_metadata(self) -> dict:
        return json.loads(self.metadata_json or "{}")

    def set_metadata(self, data: dict):
        self.metadata_json = json.dumps(data or {}, ensure_ascii=False)


class PlatformCapabilityOverrideModel(SQLModel, table=True):
    __tablename__ = "platform_capability_overrides"
    __table_args__ = (
        UniqueConstraint("platform_name", name="uq_platform_capability_overrides_platform"),
    )

    id: Optional[int] = Field(default=None, primary_key=True)
    platform_name: str = Field(index=True)
    capabilities_json: str = "{}"
    created_at: datetime = Field(default_factory=_utcnow)
    updated_at: datetime = Field(default_factory=_utcnow)

    def get_capabilities(self) -> dict:
        return json.loads(self.capabilities_json or "{}")

    def set_capabilities(self, data: dict):
        self.capabilities_json = json.dumps(data or {}, ensure_ascii=False)


class TaskLog(SQLModel, table=True):
    __tablename__ = "task_logs"

    id: Optional[int] = Field(default=None, primary_key=True)
    platform: str
    email: str
    status: str        # success | failed
    error: str = ""
    detail_json: str = "{}"
    created_at: datetime = Field(default_factory=_utcnow)


class TaskModel(SQLModel, table=True):
    __tablename__ = "tasks"

    id: str = Field(primary_key=True)
    type: str = Field(index=True)
    platform: str = Field(default="", index=True)
    status: str = Field(default="pending", index=True)
    payload_json: str = "{}"
    result_json: str = "{}"
    progress_current: int = 0
    progress_total: int = 0
    success_count: int = 0
    error_count: int = 0
    error: str = ""
    started_at: Optional[datetime] = None
    finished_at: Optional[datetime] = None
    created_at: datetime = Field(default_factory=_utcnow)
    updated_at: datetime = Field(default_factory=_utcnow)

    def get_payload(self) -> dict:
        return json.loads(self.payload_json or "{}")

    def set_payload(self, data: dict):
        self.payload_json = json.dumps(data or {}, ensure_ascii=False)

    def get_result(self) -> dict:
        return json.loads(self.result_json or "{}")

    def set_result(self, data: dict):
        self.result_json = json.dumps(data or {}, ensure_ascii=False)


class TaskEventModel(SQLModel, table=True):
    __tablename__ = "task_events"

    id: Optional[int] = Field(default=None, primary_key=True)
    task_id: str = Field(index=True)
    type: str = Field(default="log", index=True)
    level: str = "info"
    message: str = ""
    detail_json: str = "{}"
    created_at: datetime = Field(default_factory=_utcnow)

    def get_detail(self) -> dict:
        return json.loads(self.detail_json or "{}")

    def set_detail(self, data: dict):
        self.detail_json = json.dumps(data or {}, ensure_ascii=False)


class ProxyModel(SQLModel, table=True):
    __tablename__ = "proxies"

    id: Optional[int] = Field(default=None, primary_key=True)
    url: str = Field(unique=True)
    region: str = ""
    success_count: int = 0
    fail_count: int = 0
    is_active: bool = True
    last_checked: Optional[datetime] = None


def save_account(account, *, account_id: Optional[int] = None) -> 'AccountModel':
    """保存账号与关联凭据；不指定 ID 时只更新唯一可确认的身份。"""
    from core.account_graph import sync_platform_account_graph

    if account_id is not None and (type(account_id) is not int or account_id <= 0):
        raise ValueError("目标账号不存在或身份不匹配")
    with Session(engine) as session:
        # Serialize identity selection with the account and graph writes.
        session.connection().exec_driver_sql("BEGIN IMMEDIATE")
        if account_id is not None:
            model = session.get(AccountModel, account_id)
            if not model or model.platform != account.platform or model.email != account.email:
                raise ValueError("目标账号不存在或身份不匹配")
        else:
            candidates = session.exec(
                select(AccountModel)
                .where(AccountModel.platform == account.platform)
                .where(AccountModel.email == account.email)
            ).all()
            matches = [item for item in candidates if account.user_id and item.user_id == account.user_id]
            if not candidates:
                model = None
            elif len(matches) == 1:
                model = matches[0]
            elif len(candidates) == 1 and not candidates[0].user_id:
                model = candidates[0]
            else:
                raise ValueError("同邮箱账号身份不明确，请选择原账号恢复")
        if model is None:
            model = AccountModel(platform=account.platform, email=account.email,
                                 password=account.password, user_id=account.user_id or "")
        else:
            model.password = account.password or model.password
            model.user_id = account.user_id or model.user_id or ""
            model.updated_at = _utcnow()
        session.add(model)
        session.flush()
        sync_platform_account_graph(session, model, account)
        session.commit()
        session.refresh(model)
        return model


LEGACY_ACCOUNT_COLUMNS = (
    "region",
    "token",
    "status",
    "trial_end_time",
    "cashier_url",
    "extra_json",
)


def _load_json(value: str) -> dict:
    try:
        data = json.loads(value or "{}")
    except Exception:
        return {}
    return data if isinstance(data, dict) else {}




def _migrate_legacy_accounts_schema() -> None:
    """Preserve account identities while upgrading legacy fields and SQLite ID allocation."""
    from core.account_graph import sync_legacy_account_graph

    with engine.connect() as connection:
        foreign_keys = int(connection.exec_driver_sql("PRAGMA foreign_keys").scalar_one())
        connection.commit()
        connection.exec_driver_sql("PRAGMA foreign_keys=OFF")
        connection.commit()
        try:
            with connection.begin():
                connection.exec_driver_sql("BEGIN IMMEDIATE")
                table_sql = connection.exec_driver_sql(
                    "SELECT sql FROM sqlite_master WHERE type='table' AND name='accounts'"
                ).scalar()
                if not table_sql:
                    return
                columns = {row[1] for row in connection.exec_driver_sql("PRAGMA table_info(accounts)")}
                legacy = bool(columns.intersection(LEGACY_ACCOUNT_COLUMNS))
                expected = {"id", "platform", "email", "password", "user_id", "created_at", "updated_at"}
                if columns - expected - set(LEGACY_ACCOUNT_COLUMNS):
                    raise RuntimeError("账号表包含未知列，迁移已停止")
                sequence_exists = connection.exec_driver_sql(
                    "SELECT 1 FROM sqlite_master WHERE type='table' AND name='sqlite_sequence'"
                ).scalar()
                previous_sequence = (connection.exec_driver_sql(
                    "SELECT seq FROM sqlite_sequence WHERE name='accounts'"
                ).scalar() or 0) if sequence_exists else 0
                floor = max(int(previous_sequence), int(connection.exec_driver_sql(
                    "SELECT COALESCE(MAX(id),0) FROM accounts").scalar_one()))
                references = []
                hold = _load_json(connection.exec_driver_sql(
                    "SELECT value FROM configs WHERE key=?", ("chatgpt_phone_verification_hold",)
                ).scalar() or "")
                references.append(hold.get("account_id"))
                for raw in connection.exec_driver_sql(
                    "SELECT payload_json FROM tasks WHERE type=?", ("platform_action",)
                ).scalars():
                    payload = _load_json(raw)
                    references.append(payload.get("account_id"))
                    if isinstance(payload.get("account_ids"), list):
                        references.extend(payload["account_ids"])
                for value in references:
                    if type(value) is int or (isinstance(value, str) and value.isdecimal()):
                        value = int(value)
                        if 0 < value < 2**63 - 1:
                            floor = max(floor, value)

                before_foreign_keys = set(connection.exec_driver_sql("PRAGMA foreign_key_check").all())
                if legacy:
                    defaults = {
                        "region": "''", "token": "''", "status": "'registered'",
                        "trial_end_time": "0", "cashier_url": "''", "extra_json": "'{}'",
                    }
                    fields = [
                        f"COALESCE({name},{default}) AS {name}" if name in columns else f"{default} AS {name}"
                        for name, default in defaults.items()
                    ]
                    rows = connection.exec_driver_sql(
                        "SELECT id,platform," + ",".join(fields) + " FROM accounts"
                    ).mappings().all()
                    with Session(bind=connection, join_transaction_mode="create_savepoint") as session:
                        for row in rows:
                            sync_legacy_account_graph(
                                session, account_id=int(row["id"] or 0), platform=str(row["platform"] or ""),
                                lifecycle_status=str(row["status"] or "registered"),
                                region=str(row["region"] or ""), legacy_token=str(row["token"] or ""),
                                trial_end_time=int(row["trial_end_time"] or 0),
                                cashier_url=str(row["cashier_url"] or ""),
                                extra=_load_json(str(row["extra_json"] or "{}")),
                            )
                        session.commit()

                if legacy or "AUTOINCREMENT" not in table_sql.upper():
                    objects = connection.exec_driver_sql(
                        "SELECT sql FROM sqlite_master WHERE tbl_name='accounts' "
                        "AND type IN ('index','trigger') AND sql IS NOT NULL"
                    ).scalars().all()
                    connection.exec_driver_sql(
                        """
                        CREATE TABLE accounts__new (
                            id INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
                            platform VARCHAR NOT NULL,
                            email VARCHAR NOT NULL,
                            password VARCHAR NOT NULL,
                            user_id VARCHAR NOT NULL,
                            created_at DATETIME NOT NULL,
                            updated_at DATETIME NOT NULL
                        )
                        """
                    )
                    connection.exec_driver_sql(
                        """
                        INSERT INTO accounts__new (id, platform, email, password, user_id, created_at, updated_at)
                        SELECT id, platform, email, password, user_id, created_at, updated_at FROM accounts
                        """
                    )
                    connection.exec_driver_sql("DROP TABLE accounts")
                    connection.exec_driver_sql("ALTER TABLE accounts__new RENAME TO accounts")
                    for statement in objects:
                        connection.exec_driver_sql(statement)
                    connection.exec_driver_sql("CREATE INDEX IF NOT EXISTS ix_accounts_platform ON accounts (platform)")
                    connection.exec_driver_sql("CREATE INDEX IF NOT EXISTS ix_accounts_email ON accounts (email)")
                    if set(connection.exec_driver_sql("PRAGMA foreign_key_check").all()) - before_foreign_keys:
                        raise RuntimeError("账号 ID 迁移产生了新的关联错误")

                sequence = connection.exec_driver_sql(
                    "SELECT seq FROM sqlite_sequence WHERE name='accounts'"
                ).scalar()
                if floor > int(sequence or 0):
                    if sequence is None:
                        connection.exec_driver_sql(
                            "INSERT INTO sqlite_sequence(name,seq) VALUES ('accounts',?)", (floor,)
                        )
                    else:
                        connection.exec_driver_sql(
                            "UPDATE sqlite_sequence SET seq=? WHERE name='accounts'", (floor,)
                        )
        finally:
            connection.exec_driver_sql(f"PRAGMA foreign_keys={foreign_keys}")
            connection.commit()


def init_db():
    SQLModel.metadata.create_all(engine)
    from core.account_graph import sync_all_account_graphs
    from infrastructure.provider_definitions_repository import ProviderDefinitionsRepository

    _migrate_legacy_accounts_schema()
    _ensure_column("provider_definitions", "category", "TEXT DEFAULT ''")
    SQLModel.metadata.create_all(engine)

    with Session(engine) as session:
        ProviderDefinitionsRepository().ensure_seeded()
        _migrate_legacy_provider_keys()
        _cleanup_non_real_providers()
        sync_all_account_graphs(session)
        session.commit()


def _ensure_column(table: str, column: str, col_type: str):
    """给已有表安全地加一列（SQLite 不支持 IF NOT EXISTS ADD COLUMN）。"""
    inspector = inspect(engine)
    tables = set(inspector.get_table_names())
    if table not in tables:
        return
    existing = {c["name"] for c in inspector.get_columns(table)}
    if column in existing:
        return
    with engine.begin() as conn:
        conn.exec_driver_sql(f"ALTER TABLE {table} ADD COLUMN {column} {col_type}")
    print(f"[DB] 已添加列 {table}.{column}")


# 旧版 provider_key → 新版 provider_key 映射
_LEGACY_PROVIDER_KEY_MAP: dict[tuple[str, str], str] = {
    # mailbox
    ("mailbox", "moemail"): "moemail_api",
    ("mailbox", "generic_http"): "generic_http_mailbox",
    ("mailbox", "tempmail_lol"): "tempmail_lol_api",
    ("mailbox", "tempmail_web"): "tempmail_web_api",
    ("mailbox", "duckmail"): "duckmail_api",
    ("mailbox", "freemail"): "freemail_api",
    ("mailbox", "cfworker"): "cfworker_admin_api",
    ("mailbox", "testmail"): "testmail_api",
    ("mailbox", "laoudo"): "laoudo_api",
    # sms
    ("sms", "sms_activate"): "sms_activate_api",
    ("sms", "herosms"): "herosms_api",
    # captcha
    ("captcha", "yescaptcha"): "yescaptcha_api",
    ("captcha", "twocaptcha"): "twocaptcha_api",
}

# 旧版 auth_mode 值 → 新版 auth_mode 值映射
_LEGACY_AUTH_MODE_MAP: dict[str, str] = {
    "endpoint_only": "password",
    "manual_login": "password",
    "bearer_token": "bearer",
    "jwt_token": "token",
    "admin_token": "token",
    "api_key": "apikey",
}


def _migrate_legacy_provider_keys():
    """将旧版 provider_key 和 auth_mode 迁移到新版命名。

    同时迁移 provider_settings 和 provider_definitions 两张表。
    新 key 已存在时合并缺失配置；有冲突则保留旧记录，避免丢失凭据。
    迁移后还会修正 auth_mode 值，使其匹配新版 definition 的有效值。
    """
    with Session(engine) as session:
        migrated = 0

        # 1. 迁移 provider_key
        for (ptype, old_key), new_key in _LEGACY_PROVIDER_KEY_MAP.items():
            # --- provider_settings ---
            old_setting = session.exec(
                select(ProviderSettingModel)
                .where(ProviderSettingModel.provider_type == ptype)
                .where(ProviderSettingModel.provider_key == old_key)
            ).first()
            if old_setting:
                new_setting = session.exec(
                    select(ProviderSettingModel)
                    .where(ProviderSettingModel.provider_type == ptype)
                    .where(ProviderSettingModel.provider_key == new_key)
                ).first()
                if new_setting:
                    old_mode = _LEGACY_AUTH_MODE_MAP.get(old_setting.auth_mode, old_setting.auth_mode)
                    new_mode = _LEGACY_AUTH_MODE_MAP.get(new_setting.auth_mode, new_setting.auth_mode)
                    if old_mode and new_mode and old_mode != new_mode:
                        # Authentication modes may use different keys for different identities.
                        continue
                    merged_values = {}
                    conflicting = False
                    for field in ("config", "auth", "metadata"):
                        old_values = getattr(old_setting, f"get_{field}")()
                        new_values = getattr(new_setting, f"get_{field}")()
                        if any(
                            value not in (None, "") and new_values.get(key) not in (None, "", value)
                            for key, value in old_values.items()
                        ):
                            conflicting = True
                            break
                        merged = dict(new_values)
                        for key, value in old_values.items():
                            if merged.get(key) in (None, ""):
                                merged[key] = value
                        merged_values[field] = merged
                    if conflicting:
                        # Keep both the old setting and its definition for manual reconciliation.
                        continue
                    for field, values in merged_values.items():
                        getattr(new_setting, f"set_{field}")(values)
                    new_setting.display_name = new_setting.display_name or old_setting.display_name
                    new_setting.auth_mode = new_setting.auth_mode or old_setting.auth_mode
                    new_setting.is_default = new_setting.is_default or old_setting.is_default
                    session.add(new_setting)
                    session.delete(old_setting)
                else:
                    old_setting.provider_key = new_key
                    session.add(old_setting)
                migrated += 1

            # --- provider_definitions ---
            old_defn = session.exec(
                select(ProviderDefinitionModel)
                .where(ProviderDefinitionModel.provider_type == ptype)
                .where(ProviderDefinitionModel.provider_key == old_key)
            ).first()
            if old_defn:
                new_defn = session.exec(
                    select(ProviderDefinitionModel)
                    .where(ProviderDefinitionModel.provider_type == ptype)
                    .where(ProviderDefinitionModel.provider_key == new_key)
                ).first()
                if new_defn:
                    session.delete(old_defn)
                else:
                    old_defn.provider_key = new_key
                    session.add(old_defn)
                migrated += 1

        if migrated:
            session.commit()
            print(f"[DB] 已迁移 {migrated} 条旧版 provider key")

        # 2. 修正 auth_mode 值
        fixed = 0
        all_settings = session.exec(select(ProviderSettingModel)).all()
        for item in all_settings:
            old_mode = item.auth_mode or ""
            if not old_mode:
                continue
            # 查找对应的 definition
            defn = session.exec(
                select(ProviderDefinitionModel)
                .where(ProviderDefinitionModel.provider_type == item.provider_type)
                .where(ProviderDefinitionModel.provider_key == item.provider_key)
            ).first()
            if not defn:
                continue
            valid_modes = {m.get("value") for m in defn.get_auth_modes()}
            if not valid_modes or old_mode in valid_modes:
                # 当前值已经有效，跳过
                continue
            # 尝试映射
            new_mode = _LEGACY_AUTH_MODE_MAP.get(old_mode)
            if new_mode and new_mode in valid_modes:
                item.auth_mode = new_mode
            elif defn.default_auth_mode:
                item.auth_mode = defn.default_auth_mode
            else:
                continue
            session.add(item)
            fixed += 1

        if fixed:
            session.commit()
            print(f"[DB] 已修正 {fixed} 条旧版 auth_mode")


def _cleanup_non_real_providers():
    """generic_http 不是真实邮箱，从 DB 中清除其 definition 和空 setting。"""
    remove_keys = [("mailbox", "generic_http")]
    with Session(engine) as session:
        for pt, pk in remove_keys:
            setting = session.exec(
                select(ProviderSettingModel)
                .where(ProviderSettingModel.provider_type == pt)
                .where(ProviderSettingModel.provider_key == pk)
            ).first()
            if setting:
                config = setting.get_config() or {}
                auth = setting.get_auth() or {}
                if not config and not auth:
                    session.delete(setting)
            defn = session.exec(
                select(ProviderDefinitionModel)
                .where(ProviderDefinitionModel.provider_type == pt)
                .where(ProviderDefinitionModel.provider_key == pk)
            ).first()
            if defn:
                remaining = session.exec(
                    select(ProviderSettingModel)
                    .where(ProviderSettingModel.provider_type == pt)
                    .where(ProviderSettingModel.provider_key == pk)
                ).first()
                if not remaining:
                    session.delete(defn)
        session.commit()


def get_session():
    with Session(engine) as session:
        yield session
