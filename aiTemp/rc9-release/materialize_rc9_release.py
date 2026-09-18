from __future__ import annotations

from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]

SOURCE_WORKFLOW = ROOT / ".github/workflows/codex-router-multiprovider-release-rc8.yml"
SOURCE_RUNNER = ROOT / "aiTemp/rc8-release/run-windows-release.mjs"
SOURCE_MIGRATION = ROOT / "aiTemp/rc8-release/verify-windows-migration.ps1"

TARGET_WORKFLOW = ROOT / ".github/workflows/codex-router-multiprovider-release-rc9.yml"
TARGET_RUNNER = ROOT / "aiTemp/rc9-release/run-windows-release.mjs"
TARGET_MIGRATION = ROOT / "aiTemp/rc9-release/verify-windows-migration.ps1"
TARGET_NOTES = ROOT / "docs/releases/v0.7.0-rc.9.md"

REPLACEMENTS = (
    ("release/codex-router-multiprovider-0.7.0-rc.8", "release/codex-router-multiprovider-0.7.0-rc.9"),
    ("codex-router-multiprovider-release-rc8.yml", "codex-router-multiprovider-release-rc9.yml"),
    ("aiTemp/rc8-release", "aiTemp/rc9-release"),
    ("docs/releases/v0.7.0-rc.8.md", "docs/releases/v0.7.0-rc.9.md"),
    ("v0.7.0-rc.8", "v0.7.0-rc.9"),
    ("0.7.0-rc.8", "0.7.0-rc.9"),
    ("rc.8 exact-source", "rc.9 exact-source"),
    ("rc.8 release", "rc.9 release"),
    ("rc.8 prerelease", "rc.9 prerelease"),
    ("rc.8 migration", "rc.9 migration"),
    ("rc8-release", "rc9-release"),
)


def transformed(source: Path) -> str:
    text = source.read_text(encoding="utf-8")
    for old, new in REPLACEMENTS:
        text = text.replace(old, new)
    return text


def write_exact(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")


workflow = transformed(SOURCE_WORKFLOW)
runner = transformed(SOURCE_RUNNER)
migration = transformed(SOURCE_MIGRATION)

# Extend the authoritative release runner with the rc.9 managed-runtime and CPA gates.
anchor = "    'desktop-electron/tests/external-services-control-plane.test.cjs',\n"
extra_tests = """    'desktop-electron/tests/cpa-oauth-adapter.test.cjs',
    'desktop-electron/tests/cpa-provider-login-routing.test.cjs',
    'desktop-electron/tests/cpa-unified-oauth-catalog.test.cjs',
    'desktop-electron/tests/managed-components-runtime.test.cjs',
    'desktop-electron/tests/rc9-five-stack-completion.test.cjs',
    'desktop-electron/tests/rc9-managed-five-stack.test.cjs',
    'desktop-electron/tests/rc9-package-identity-alignment.test.cjs',
"""
if extra_tests not in runner:
    if runner.count(anchor) != 1:
        raise SystemExit(f"expected one rc.9 test insertion anchor, found {runner.count(anchor)}")
    runner = runner.replace(anchor, anchor + extra_tests, 1)

syntax_anchor = "    'desktop-electron/electron/external-services.cjs',\n"
extra_syntax = """    'desktop-electron/electron/managed-components.cjs',
    'desktop-electron/electron/managed-external-services.cjs',
    'desktop-electron/electron/cpa-oauth-adapter.cjs',
    'desktop-electron/electron/codex-router-managed.cjs',
"""
if extra_syntax not in runner:
    if runner.count(syntax_anchor) != 1:
        raise SystemExit(f"expected one rc.9 syntax insertion anchor, found {runner.count(syntax_anchor)}")
    runner = runner.replace(syntax_anchor, syntax_anchor + extra_syntax, 1)

notes = """# Coding Tools v0.7.0-rc.9

## English

This release makes the complete five-stack app-managed from the Coding Tools GUI while retaining loopback process isolation.

### Integrated stack

- **Codex Router:** pinned source preparation, repair, foreground supervision, state-isolated wrappers, encrypted caller-key health checks, and in-app lifecycle controls.
- **CPA / CLIProxyAPI Provider Hub:** encrypted multi-account OAuth/import adapters for Codex, Claude, Gemini, Antigravity, CommandCode, API-key, browser-session, and custom providers.
- **CommandCode Proxy:** pinned app-managed source, CommandCode OAuth/CLI-session authority, generated main-process-only proxy key, model discovery, and health probing.
- **Paseo:** pinned source installation, server build, start/stop/restart/repair, full embedded upstream sections, and shared provider/account/model/fallback/proxy routing.
- **Anneal:** pinned source, persistent configuration, encrypted GitHub read credential, marker-protected dedicated database initialization, PostgreSQL/API/runner/web topology, and WSL2 boundary on Windows.

### Security and retention

- Provider API/OAuth secrets stay in the encrypted main-process vault.
- Paseo and Anneal use a separate bounded request-only control credential.
- All managed services are loopback-only and fail closed when authentication is incomplete.
- Installation work is staged under `aiTemp`; superseded or incomplete runtime material is retained under `Trash`.
- No project file or user-data path is deleted by the integration lifecycle.

### Validation

The exact-source Windows release gate covers managed-runtime and CPA contracts, runtime syntax, strict TypeScript, production renderer build, Rust headless build, Windows installer packaging, package verification, packaged-launcher smoke, legacy NSIS/MSI migration, checksums, provenance, remote asset readback, and no-delete enforcement.

Live OAuth and paid-provider acceptance remain explicit user-machine validation boundaries; CI does not consume provider quota or persist real user credentials.

---

## 繁體中文

今次 release 將完整五項系統改成由 Coding Tools GUI 管理，同時保留 loopback 程序隔離。

### 已整合系統

- **Codex Router：** 固定版本 source 準備、修復、前景監督、獨立狀態 wrapper、加密 caller key 健康檢查，同 App 內生命週期控制。
- **CPA／CLIProxyAPI Provider Hub：** Codex、Claude、Gemini、Antigravity、CommandCode、API Key、瀏覽器 Session 同自訂供應商嘅加密多帳戶 OAuth／匯入 adapter。
- **CommandCode Proxy：** 固定版本並由 App 管理嘅 source、CommandCode OAuth／CLI Session 權限、只存在主程序嘅自動 proxy key、模型探索同健康檢查。
- **Paseo：** 固定 source 安裝、server build、啟動／停止／重新啟動／修復、完整內嵌 upstream 頁面，同共用供應商／帳戶／模型／後備／Proxy 路由。
- **Anneal：** 固定 source、持久設定、加密 GitHub 唯讀憑證、marker 保護嘅獨立資料庫初始化、PostgreSQL／API／runner／web topology，以及 Windows WSL2 邊界。

### 安全同保留規則

- Provider API／OAuth secret 只會保留喺加密主程序 vault。
- Paseo 同 Anneal 使用獨立、有長度限制、只屬於單次請求嘅 control credential。
- 所有受管理服務只准使用 loopback；驗證未完成時會 fail closed。
- 安裝工作只會喺 `aiTemp` 暫存；舊版或未完成 runtime 會保留到 `Trash`。
- 整合生命週期唔會刪除 project file 或使用者資料路徑。

### 驗證

Exact-source Windows release gate 會驗證 managed runtime／CPA contracts、runtime syntax、strict TypeScript、production renderer、Rust headless build、Windows installer、package verification、packaged-launcher smoke、舊 NSIS／MSI migration、checksum、provenance、遠端 asset readback 同禁止刪檔規則。

真實 OAuth 同付費 provider 驗收仍然係使用者電腦上嘅明確手動邊界；CI 唔會消耗 provider quota，亦唔會保存真實使用者憑證。
"""

write_exact(TARGET_WORKFLOW, workflow)
write_exact(TARGET_RUNNER, runner)
write_exact(TARGET_MIGRATION, migration)
write_exact(TARGET_NOTES, notes)

print("materialized rc.9 exact-source release lane")
