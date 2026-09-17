from __future__ import annotations

from pathlib import Path
import re

ROOT = Path(__file__).resolve().parents[2]
OLD = "0.7.0-rc.6"
NEW = "0.7.0-rc.7"
OLD_PATTERN = re.compile(r"0\.7\.0-rc\.6(?!\.\d)")

REQUIRED_VERSION_PATHS = [
    "desktop-electron/package.json",
    "desktop-electron/electron/product.cjs",
    "desktop-electron/scripts/prepare-package-resources.cjs",
    "desktop-electron/scripts/verify-package.cjs",
    "desktop-electron/tests/product-identity.test.cjs",
    "desktop-electron/tests/installer-upgrade-migration.test.cjs",
]

OPTIONAL_VERSION_PATHS = [
    "desktop-electron/src/App.tsx",
    "desktop-electron/tests/package-contents.test.cjs",
    "desktop-electron/tests/package-resource-preparation.test.cjs",
]

changed: list[str] = []
for relative in REQUIRED_VERSION_PATHS + OPTIONAL_VERSION_PATHS:
    path = ROOT / relative
    text = path.read_text(encoding="utf-8")
    if OLD_PATTERN.search(text):
        updated, replacements = OLD_PATTERN.subn(NEW, text)
        if replacements < 1:
            raise SystemExit(f"Release identity did not change in {relative}")
        path.write_text(updated, encoding="utf-8")
        changed.append(relative)
        continue
    if relative in REQUIRED_VERSION_PATHS and NEW not in text:
        raise SystemExit(f"Missing required release identity anchor in {relative}")

installer_test = ROOT / "desktop-electron/tests/installer-upgrade-migration.test.cjs"
installer_source = installer_test.read_text(encoding="utf-8")
installer_source = installer_source.replace(
    "codex-router-multiprovider-release-rc6-csc.yml",
    "codex-router-multiprovider-release-rc7.yml",
)
installer_source = installer_source.replace("rc.6 reinstall", "rc.7 reinstall")
installer_source = installer_source.replace("rc.6 keeps", "rc.7 keeps")
installer_test.write_text(installer_source, encoding="utf-8")
if "desktop-electron/tests/installer-upgrade-migration.test.cjs" not in changed:
    changed.append("desktop-electron/tests/installer-upgrade-migration.test.cjs")

for relative in REQUIRED_VERSION_PATHS:
    text = (ROOT / relative).read_text(encoding="utf-8")
    if NEW not in text:
        raise SystemExit(f"New release identity missing from {relative}")
    if OLD_PATTERN.search(text):
        raise SystemExit(f"Old active release identity remains in {relative}")

notes = ROOT / "docs/releases/v0.7.0-rc.7.md"
notes.parent.mkdir(parents=True, exist_ok=True)
notes.write_text(
    "# Coding Tools v0.7.0-rc.7\n\n"
    "## English\n\n"
    "This release consolidates the current Provider Center, CommandCode Proxy, reliable project updater, pinned Paseo and Anneal surfaces, and the repaired Windows upgrade path.\n\n"
    "### Installer compatibility\n\n"
    "- Detects historical Tauri-based `Coding Tools MCP` NSIS registrations in HKCU/HKLM and both 32-bit and 64-bit registry views.\n"
    "- Detects historical MSI registrations stored under Windows Installer product-code GUIDs with `WindowsInstaller=1`.\n"
    "- Validates the exact legacy display name and uninstall metadata before execution.\n"
    "- Runs the registered NSIS uninstaller with `/S`, or the system Windows Installer with `/x {GUID} /qn /norestart`.\n"
    "- Accepts Windows Installer success codes 0 and 3010, waits for the legacy registration to disappear, and only then continues the Electron installation.\n"
    "- Preserves application data and never manually deletes old directories, files, or registry keys.\n\n"
    "### Integrated desktop work\n\n"
    "- CPA-style multi-account Provider Center and CommandCode Proxy session binding.\n"
    "- Pinned Paseo and Anneal tabs and desktop bridge surfaces.\n"
    "- Reliable prerelease discovery and one-click update flow for `p90-lover/coding-tools-mcp`.\n"
    "- Existing OAuth, proxy, Traditional Chinese, packaging, launcher-smoke, and no-delete protections remain in place.\n\n"
    "### Validation boundary\n\n"
    "The exact-source release workflow runs strict TypeScript, focused provider/updater/integration tests, production renderer inspection, Windows package verification, launcher smoke, a legacy NSIS uninstall-to-reinstall fixture, and a GUID-based MSI production-macro fixture before publication. Live external-account acceptance remains an explicit manual boundary.\n\n"
    "---\n\n"
    "## 繁體中文\n\n"
    "今次 release 整合目前 Provider Center、CommandCode Proxy、可靠嘅專案更新器、已固定版本嘅 Paseo／Anneal 介面，同修復後嘅 Windows 舊版本升級流程。\n\n"
    "### Installer 相容性\n\n"
    "- 會喺 HKCU／HKLM 同 32-bit／64-bit registry view 尋找舊 Tauri `Coding Tools MCP` NSIS 解除安裝記錄。\n"
    "- 會偵測以 Windows Installer product-code GUID 儲存、並帶有 `WindowsInstaller=1` 嘅舊 MSI 記錄。\n"
    "- 執行前會驗證精確嘅舊版顯示名稱同解除安裝資料。\n"
    "- NSIS 版本會使用已登記嘅 uninstaller `/S`；MSI 版本會使用系統 Windows Installer `/x {GUID} /qn /norestart`。\n"
    "- 接受 Windows Installer 成功代碼 0 同 3010，等舊記錄消失後先繼續安裝 Electron 新版。\n"
    "- 保留應用程式資料，唔會自行刪除舊資料夾、檔案或 registry key。\n\n"
    "### 已整合桌面功能\n\n"
    "- CPA 形式多帳戶 Provider Center 同 CommandCode Proxy session 綁定。\n"
    "- 已固定版本嘅 Paseo／Anneal tabs 同桌面 bridge。\n"
    "- 由 `p90-lover/coding-tools-mcp` 可靠尋找 prerelease，同一鍵更新流程。\n"
    "- 保留 OAuth、代理、繁體中文、打包、launcher smoke 同 no-delete 保護。\n\n"
    "### 驗證邊界\n\n"
    "精確 source release workflow 會喺發佈前執行 strict TypeScript、focused provider／updater／integration tests、production renderer 檢查、Windows package verification、launcher smoke、舊 NSIS uninstall-to-reinstall fixture，同 GUID-based MSI production-macro fixture。真實外部帳戶驗收仍然係明確人工邊界。\n",
    encoding="utf-8",
)
changed.append("docs/releases/v0.7.0-rc.7.md")

print("RC7_RELEASE_IDENTITY_READY")
for relative in changed:
    print(f"CHANGED {relative}")
