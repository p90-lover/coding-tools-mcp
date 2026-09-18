from __future__ import annotations

import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
OLD_VERSION = "0.7.0-rc.7"
NEW_VERSION = "0.7.0-rc.8"
OLD_TAG = "v0.7.0-rc.7"
NEW_TAG = "v0.7.0-rc.8"
OLD_WORKFLOW = "codex-router-multiprovider-release-rc7.yml"
NEW_WORKFLOW = "codex-router-multiprovider-release-rc8.yml"

VERSION_PATHS = [
    "desktop-electron/package.json",
    "desktop-electron/electron/product.cjs",
    "desktop-electron/scripts/prepare-package-resources.cjs",
    "desktop-electron/scripts/verify-package.cjs",
    "desktop-electron/tests/product-identity.test.cjs",
    "desktop-electron/tests/installer-upgrade-migration.test.cjs",
    "desktop-electron/tests/package-contents.test.cjs",
    "desktop-electron/tests/package-resource-preparation.test.cjs",
    "desktop-electron/src/App.tsx",
]


def replace_version(relative: str) -> bool:
    path = ROOT / relative
    text = path.read_text(encoding="utf-8")
    if OLD_VERSION in text:
        path.write_text(text.replace(OLD_VERSION, NEW_VERSION), encoding="utf-8")
        return True
    if NEW_VERSION not in text:
        raise SystemExit(f"missing active release identity in {relative}")
    return False


changed: list[str] = []
for relative in VERSION_PATHS:
    if replace_version(relative):
        changed.append(relative)

installer_test = ROOT / "desktop-electron/tests/installer-upgrade-migration.test.cjs"
installer_text = installer_test.read_text(encoding="utf-8")
updated_installer = (
    installer_text
    .replace(OLD_WORKFLOW, NEW_WORKFLOW)
    .replace("aiTemp/rc7-release", "aiTemp/rc8-release")
    .replace("rc.7 installer", "rc.8 installer")
    .replace("rc.7 reinstall", "rc.8 reinstall")
    .replace("rc.7 keeps", "rc.8 keeps")
)
if updated_installer != installer_text:
    installer_test.write_text(updated_installer, encoding="utf-8")
    if "desktop-electron/tests/installer-upgrade-migration.test.cjs" not in changed:
        changed.append("desktop-electron/tests/installer-upgrade-migration.test.cjs")

manifest_path = ROOT / "desktop-electron/package.json"
manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
if manifest.get("version") != NEW_VERSION:
    raise SystemExit(f"desktop manifest version mismatch: {manifest.get('version')}")
build = manifest.get("build")
if not isinstance(build, dict):
    raise SystemExit("desktop manifest build object is missing")
if build.get("publish", "__missing__") is not None:
    rebuilt: dict[str, object] = {}
    inserted = False
    for key, value in build.items():
        rebuilt[key] = value
        if key == "directories":
            rebuilt["publish"] = None
            inserted = True
    if not inserted:
        rebuilt = {"publish": None, **rebuilt}
    manifest["build"] = rebuilt
    manifest_path.write_text(json.dumps(manifest, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    if "desktop-electron/package.json" not in changed:
        changed.append("desktop-electron/package.json")

packager_path = ROOT / "desktop-electron/scripts/package.cjs"
packager = packager_path.read_text(encoding="utf-8")
credential_guard = "const env = { ...process.env };\ndelete env.GH_TOKEN;\ndelete env.GITHUB_TOKEN;\n"
if credential_guard not in packager:
    anchor = "const env = { ...process.env };\n"
    if packager.count(anchor) != 1:
        raise SystemExit("package credential-boundary anchor is missing or ambiguous")
    packager = packager.replace(anchor, credential_guard, 1)
    packager_path.write_text(packager, encoding="utf-8")
    changed.append("desktop-electron/scripts/package.cjs")
if '"--publish",\n  "never"' not in packager:
    raise SystemExit("electron-builder --publish never boundary is missing")

publish_test = ROOT / "desktop-electron/tests/package-publish-boundary.test.cjs"
publish_test.write_text(
    '''"use strict";\n\n'''
    '''const assert = require("node:assert/strict");\n'''
    '''const fs = require("node:fs");\n'''
    '''const path = require("node:path");\n'''
    '''const test = require("node:test");\n\n'''
    '''const root = path.resolve(__dirname, "..");\n'''
    '''const manifest = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));\n'''
    '''const packager = fs.readFileSync(path.join(root, "scripts", "package.cjs"), "utf8");\n\n'''
    '''test("Electron packaging explicitly disables electron-builder publishing and update-provider autodetection", () => {\n'''
    '''  assert.equal(manifest.build.publish, null);\n'''
    '''  assert.match(packager, /"--publish",\\s*\\n\\s*"never"/);\n'''
    '''});\n\n'''
    '''test("the electron-builder child process never receives GitHub release credentials", () => {\n'''
    '''  assert.match(packager, /delete env\\.GH_TOKEN;/);\n'''
    '''  assert.match(packager, /delete env\\.GITHUB_TOKEN;/);\n'''
    '''  assert.ok(packager.indexOf("delete env.GITHUB_TOKEN;") < packager.indexOf("function runChecked"));\n'''
    '''});\n''',
    encoding="utf-8",
)
changed.append("desktop-electron/tests/package-publish-boundary.test.cjs")

rc7_runner = (ROOT / "aiTemp/rc7-release/run-windows-release.mjs").read_text(encoding="utf-8")
runner = (
    rc7_runner
    .replace(OLD_VERSION, NEW_VERSION)
    .replace(OLD_TAG, NEW_TAG)
    .replace("rc7-release", "rc8-release")
    .replace("bun-release-rc7", "bun-release-rc8")
    .replace(OLD_WORKFLOW, NEW_WORKFLOW)
    .replace("RC7_WINDOWS_RELEASE_PUBLISHED", "RC8_WINDOWS_RELEASE_PUBLISHED")
    .replace("publish and read back rc.7 prerelease", "publish and read back rc.8 prerelease")
)
commandcode_anchor = "    'desktop-electron/tests/commandcode-provider-session.test.cjs',\n"
extra_tests = (
    commandcode_anchor
    + "    'desktop-electron/tests/external-services-control-plane.test.cjs',\n"
    + "    'desktop-electron/tests/five-stack-routing-completion.test.cjs',\n"
    + "    'desktop-electron/tests/package-publish-boundary.test.cjs',\n"
)
if "external-services-control-plane.test.cjs" not in runner:
    if runner.count(commandcode_anchor) != 1:
        raise SystemExit("rc.8 focused-test insertion anchor is missing or ambiguous")
    runner = runner.replace(commandcode_anchor, extra_tests, 1)
syntax_anchor = "    'desktop-electron/electron/main.cjs',\n"
extra_syntax = (
    syntax_anchor
    + "    'desktop-electron/electron/external-services.cjs',\n"
    + "    'desktop-electron/electron/runtime-supervisor.cjs',\n"
)
if "electron/external-services.cjs" not in runner:
    if runner.count(syntax_anchor) != 1:
        raise SystemExit("rc.8 syntax insertion anchor is missing or ambiguous")
    runner = runner.replace(syntax_anchor, extra_syntax, 1)
runner_path = ROOT / "aiTemp/rc8-release/run-windows-release.mjs"
runner_path.parent.mkdir(parents=True, exist_ok=True)
runner_path.write_text(runner, encoding="utf-8")
changed.append("aiTemp/rc8-release/run-windows-release.mjs")

migration = (ROOT / "aiTemp/rc7-release/verify-windows-migration.ps1").read_text(encoding="utf-8")
migration = (
    migration
    .replace(OLD_VERSION, NEW_VERSION)
    .replace("rc.7 installer", "rc.8 installer")
    .replace("RC7_WINDOWS_MIGRATION_ACCEPTANCE_OK", "RC8_WINDOWS_MIGRATION_ACCEPTANCE_OK")
)
migration_path = ROOT / "aiTemp/rc8-release/verify-windows-migration.ps1"
migration_path.write_text(migration, encoding="utf-8")
changed.append("aiTemp/rc8-release/verify-windows-migration.ps1")

identity_test = ROOT / "desktop-electron/tests/rc8-release-identity.test.cjs"
identity_test.write_text(
    '''"use strict";\n\n'''
    '''const assert = require("node:assert/strict");\n'''
    '''const fs = require("node:fs");\n'''
    '''const path = require("node:path");\n'''
    '''const test = require("node:test");\n\n'''
    '''const repo = path.resolve(__dirname, "..", "..");\n'''
    '''const read = (relative) => fs.readFileSync(path.join(repo, relative), "utf8");\n\n'''
    '''test("rc.8 product and package identities are aligned", () => {\n'''
    '''  const manifest = JSON.parse(read("desktop-electron/package.json"));\n'''
    '''  assert.equal(manifest.version, "0.7.0-rc.8");\n'''
    '''  assert.match(read("desktop-electron/electron/product.cjs"), /version: "0\\.7\\.0-rc\\.8"/);\n'''
    '''  assert.match(read("desktop-electron/scripts/prepare-package-resources.cjs"), /PRODUCT_VERSION = "0\\.7\\.0-rc\\.8"/);\n'''
    '''  assert.match(read("desktop-electron/scripts/verify-package.cjs"), /version: "0\\.7\\.0-rc\\.8"/);\n'''
    '''});\n\n'''
    '''test("rc.8 exact-source runner covers the completed architecture-B stack", () => {\n'''
    '''  const runner = read("aiTemp/rc8-release/run-windows-release.mjs");\n'''
    '''  assert.match(runner, /releaseVersion === '0\\.7\\.0-rc\\.8'/);\n'''
    '''  assert.match(runner, /external-services-control-plane\\.test\\.cjs/);\n'''
    '''  assert.match(runner, /five-stack-routing-completion\\.test\\.cjs/);\n'''
    '''  assert.match(runner, /package-publish-boundary\\.test\\.cjs/);\n'''
    '''  assert.match(runner, /RC8_WINDOWS_RELEASE_PUBLISHED/);\n'''
    '''});\n''',
    encoding="utf-8",
)
changed.append("desktop-electron/tests/rc8-release-identity.test.cjs")

notes_path = ROOT / "docs/releases/v0.7.0-rc.8.md"
notes_path.parent.mkdir(parents=True, exist_ok=True)
notes_path.write_text(
    "# Coding Tools v0.7.0-rc.8\n\n"
    "## English\n\n"
    "This release completes architecture B: Codex Router, Paseo, and Anneal remain separately installed local services, while Coding Tools owns one unified GUI, encrypted CPA-style Provider Hub, health/lifecycle control plane, and execution-routing policy.\n\n"
    "### Complete five-stack control plane\n\n"
    "- Codex Router is configured and monitored from the Integrations surface, and its loopback URL plus encrypted caller key are injected only into owned runtime processes.\n"
    "- CPA-style Provider Hub manages multiple Codex, CommandCode, Antigravity, API-key, browser-session, and custom provider accounts with default/fallback routing.\n"
    "- CommandCode Proxy supports OAuth, CLI-session import, encrypted account binding, model discovery, and health probing.\n"
    "- Paseo and Anneal expose persisted execution endpoints, install/start/stop/restart/health controls, and full embedded local-service interfaces.\n"
    "- Codex subagents, Paseo, and Anneal share the same provider/account/model/fallback/proxy policies.\n"
    "- Codex OAuth and ChatGPT Web login fail closed until the isolated BrowserHost proves an authenticated session.\n\n"
    "### Packaging and migration\n\n"
    "- Electron Builder publication autodetection is disabled; only the exact-source release publisher may upload GitHub assets.\n"
    "- The Windows installer keeps the validated legacy NSIS and MSI migration path and preserves user data.\n"
    "- Release validation covers strict TypeScript, runtime syntax, focused five-stack contracts, isolated renderer inspection, Windows packaging, packaged launcher smoke, migration acceptance, checksums, provenance, and remote asset readback.\n\n"
    "### Validation boundary\n\n"
    "Automated validation does not consume paid provider quota. Live account and external local-service acceptance remains an explicit manual boundary.\n\n"
    "---\n\n"
    "## 繁體中文\n\n"
    "今次 release 完成架構 B：Codex Router、Paseo 同 Anneal 保持為另外安裝嘅本機服務，而 Coding Tools 會統一管理 GUI、加密 CPA 形式 Provider Hub、健康／生命週期控制，同執行路由政策。\n\n"
    "### 完整五項控制平面\n\n"
    "- Codex Router 可以喺 Integrations 頁面設定同監察；loopback URL 同加密 caller key 只會注入由 App 擁有嘅 runtime process。\n"
    "- CPA 形式 Provider Hub 管理多個 Codex、CommandCode、Antigravity、API Key、瀏覽器 Session 同自訂供應商帳戶，支援預設同後備路由。\n"
    "- CommandCode Proxy 支援 OAuth、CLI Session 匯入、加密帳戶綁定、模型探索同健康檢查。\n"
    "- Paseo 同 Anneal 提供持久化執行端點、安裝／啟動／停止／重新啟動／健康控制，同完整內嵌本機服務介面。\n"
    "- Codex subagent、Paseo 同 Anneal 共用同一套供應商／帳戶／模型／後備／Proxy 政策。\n"
    "- Codex OAuth 同 ChatGPT Web 登入會 fail closed，直至隔離 BrowserHost 證明已完成驗證。\n\n"
    "### 打包同 Migration\n\n"
    "- 已停用 Electron Builder 自動推斷 publication；只有 exact-source release publisher 可以上傳 GitHub asset。\n"
    "- Windows installer 保留已驗證嘅舊 NSIS／MSI migration 流程，並保留使用者資料。\n"
    "- Release 驗證涵蓋 strict TypeScript、runtime syntax、五項集中 contract、隔離 renderer 檢查、Windows 打包、packaged launcher smoke、migration acceptance、checksum、provenance 同遠端 asset readback。\n\n"
    "### 驗證邊界\n\n"
    "自動驗證唔會消耗付費 provider quota。真實帳戶同外部本機服務驗收仍然係明確人工邊界。\n",
    encoding="utf-8",
)
changed.append("docs/releases/v0.7.0-rc.8.md")

for relative in VERSION_PATHS:
    text = (ROOT / relative).read_text(encoding="utf-8")
    if OLD_VERSION in text:
        raise SystemExit(f"stale rc.7 identity remains in {relative}")

print("RC8_RELEASE_MATERIALIZED")
for relative in sorted(set(changed)):
    print(f"CHANGED {relative}")
