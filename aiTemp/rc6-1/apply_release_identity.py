from pathlib import Path
import re

ROOT = Path(__file__).resolve().parents[2]
NEW = "0.7.0-rc.6.1"
OLD_PATTERN = re.compile(r"0\.7\.0-rc\.6(?!\.\d)")

REQUIRED_VERSION_PATHS = [
    "desktop-electron/package.json",
    "desktop-electron/electron/product.cjs",
    "desktop-electron/scripts/prepare-package-resources.cjs",
    "desktop-electron/scripts/verify-package.cjs",
    "desktop-electron/tests/product-identity.test.cjs",
]

OPTIONAL_VERSION_PATHS = [
    "desktop-electron/src/App.tsx",
    "desktop-electron/tests/package-contents.test.cjs",
    "desktop-electron/tests/package-resource-preparation.test.cjs",
]

changed = []
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

for relative in REQUIRED_VERSION_PATHS:
    text = (ROOT / relative).read_text(encoding="utf-8")
    if NEW not in text:
        raise SystemExit(f"New release identity missing from {relative}")
    if OLD_PATTERN.search(text):
        raise SystemExit(f"Old active release identity remains in {relative}")

notes = ROOT / "docs/releases/v0.7.0-rc.6.1.md"
if not notes.exists():
    notes.parent.mkdir(parents=True, exist_ok=True)
    notes.write_text(
        "# Coding Tools v0.7.0-rc.6.1\n\n"
        "## English\n\n"
        "This non-destructive hotfix keeps every Gemini Antigravity / CLIProxyAPI account bound to its own encrypted auth-file identity. Refresh and model discovery now use the bound `name` and `auth_index`, fail closed when that session disappears, and never silently switch to another signed-in account. It also preserves the complete rc.6 Provider Hub, Paseo, Anneal, proxy, localization, package-smoke, and legacy-upgrade behavior.\n\n"
        "The previous `v0.7.0-rc.6` tag and assets remain unchanged. This release uses a new SemVer prerelease identifier because the rc.6 tag already points to the earlier verified source.\n\n"
        "Automated validation covers focused provider/session tests, strict TypeScript, production renderer inspection, Windows package verification, launcher smoke, and legacy uninstall → reinstall migration. Live Google account acceptance remains an explicit manual boundary.\n\n"
        "## 繁體中文\n\n"
        "今次非破壞式 hotfix 會將每個 Gemini Antigravity／CLIProxyAPI 帳戶綁定到自己嘅加密認證檔案身份。重新整理同模型探索會使用已綁定嘅 `name` 同 `auth_index`；工作階段消失時會 fail closed，唔會靜默切換到另一個已登入帳戶。同時保留完整 rc.6 Provider Hub、Paseo、Anneal、代理、本地化、打包 smoke 同舊版本升級行為。\n\n"
        "舊有 `v0.7.0-rc.6` tag 同 assets 保持不變。由於 rc.6 tag 已經指向較早嘅已驗證 source，今次使用全新 SemVer prerelease 版本。\n\n"
        "自動驗證包括 focused provider／session tests、strict TypeScript、production renderer 檢查、Windows package verification、launcher smoke，同 legacy uninstall → reinstall migration。真實 Google 帳戶驗收仍然係明確人工邊界。\n",
        encoding="utf-8",
    )
    changed.append("docs/releases/v0.7.0-rc.6.1.md")

print("RC6_1_RELEASE_IDENTITY_READY")
for relative in changed:
    print(f"CHANGED {relative}")
