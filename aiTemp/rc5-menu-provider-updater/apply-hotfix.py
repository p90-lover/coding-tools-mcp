from pathlib import Path

OLD_RELEASE = "0.7.0-rc.4"
NEW_RELEASE = "0.7.0-rc.5"


def read(path: str) -> str:
    return Path(path).read_text(encoding="utf-8")


def write(path: str, value: str) -> None:
    Path(path).write_text(value, encoding="utf-8")


def replace_once(path: str, old: str, new: str, label: str) -> None:
    text = read(path)
    if new in text and old not in text:
        return
    if old not in text:
        raise SystemExit(f"{label} anchor missing: {path}")
    if text.count(old) != 1:
        raise SystemExit(f"{label} anchor is not unique ({text.count(old)}): {path}")
    write(path, text.replace(old, new, 1))


def require(path: str, needle: str, label: str) -> None:
    if needle not in read(path):
        raise SystemExit(f"{label} missing: {path}")


# Keep all shipped product identity surfaces aligned to the project release.
identity_paths = [
    "desktop-electron/package.json",
    "desktop-electron/electron/product.cjs",
    "desktop-electron/scripts/prepare-package-resources.cjs",
    "desktop-electron/scripts/verify-package.cjs",
    "desktop-electron/tests/package-contents.test.cjs",
    "desktop-electron/tests/package-resource-preparation.test.cjs",
    "desktop-electron/tests/product-identity.test.cjs",
]
for path in identity_paths:
    text = read(path)
    if OLD_RELEASE in text:
        text = text.replace(OLD_RELEASE, NEW_RELEASE)
        write(path, text)
    elif NEW_RELEASE not in text:
        raise SystemExit(f"release identity anchor missing: {path}")

# Route the in-app updater to this project, including GitHub prereleases.
update_path = "desktop-electron/electron/update.cjs"
replace_once(
    update_path,
    '''const REPOSITORY = "miuuyy/codex-chatgpt-web";\nconst RELEASE_API_URL = `https://api.github.com/repos/${REPOSITORY}/releases/latest`;\nconst USER_AGENT = "codex-web-gpt-launcher-updater";\nconst MAX_REDIRECTS = 5;\n''',
    '''const REPOSITORY = "p90-lover/coding-tools-mcp";\nconst RELEASE_API_URL = `https://api.github.com/repos/${REPOSITORY}/releases?per_page=20`;\nconst CHECKSUM_ASSET_NAME = "SHA256SUMS.txt";\nconst USER_AGENT = "coding-tools-launcher-updater";\nconst MAX_REDIRECTS = 5;\n''',
    "project updater repository",
)
replace_once(
    update_path,
    '''function releaseAssetName(version, platform = process.platform, arch = process.arch) {\n  if (platform === "darwin" && ["arm64", "x64"].includes(arch)) {\n    return `codex-web-gpt-${version}-mac-${arch}.zip`;\n  }\n  if (platform === "win32" && arch === "x64") {\n    return `codex-web-gpt-${version}-win-x64.exe`;\n  }\n  if (platform === "linux" && arch === "x64") {\n    return `codex-web-gpt-${version}-linux-x64.AppImage`;\n  }\n  return null;\n}\n''',
    '''function releaseAssetName(version, platform = process.platform, arch = process.arch) {\n  if (platform === "darwin" && ["arm64", "x64"].includes(arch)) {\n    return `Coding.Tools_${version}_mac_${arch}.zip`;\n  }\n  if (platform === "win32" && arch === "x64") {\n    return `Coding.Tools_${version}_windows_x64_setup.exe`;\n  }\n  if (platform === "linux" && arch === "x64") {\n    return `Coding.Tools_${version}_linux_x64.AppImage`;\n  }\n  return null;\n}\n\nfunction selectCompatibleRelease(payload, platform = process.platform, arch = process.arch) {\n  const releases = Array.isArray(payload) ? payload : payload ? [payload] : [];\n  const candidates = [];\n  for (const release of releases) {\n    if (!release || release.draft === true) continue;\n    let version;\n    try {\n      version = releaseVersion(release.tag_name);\n    } catch {\n      continue;\n    }\n    const assetName = releaseAssetName(version, platform, arch);\n    if (!assetName) continue;\n    const assets = Array.isArray(release.assets) ? release.assets : [];\n    const asset = assets.find((item) => item?.name === assetName);\n    const checksums = assets.find((item) => item?.name === CHECKSUM_ASSET_NAME);\n    if (!asset?.browser_download_url || !checksums?.browser_download_url) continue;\n    candidates.push({ release, version, assetName, asset, checksums });\n  }\n  candidates.sort((left, right) => compareVersions(right.version, left.version));\n  return candidates[0] ?? null;\n}\n''',
    "Coding Tools release asset selector",
)
replace_once(
    update_path,
    '''  throw new Error(`checksums.txt has no entry for ${assetName}`);\n''',
    '''  throw new Error(`${CHECKSUM_ASSET_NAME} has no entry for ${assetName}`);\n''',
    "checksum manifest name",
)
replace_once(
    update_path,
    '''      const release = await deps.fetchRelease();\n      const version = releaseVersion(release?.tag_name);\n      if (compareVersions(version, currentVersion) <= 0) {\n        candidate = null;\n        return transition({ status: "up-to-date" });\n      }\n      const assetName = releaseAssetName(version, platform, arch);\n      if (!assetName) return transition({ status: "disabled" });\n      const assets = Array.isArray(release?.assets) ? release.assets : [];\n      const asset = assets.find((item) => item?.name === assetName);\n      const checksums = assets.find((item) => item?.name === "checksums.txt");\n      if (!asset?.browser_download_url || !checksums?.browser_download_url) {\n        throw new Error(`Release v${version} is missing ${assetName} or checksums.txt`);\n      }\n      candidate = {\n        version,\n        assetName,\n        assetUrl: validateReleaseAssetUrl(asset.browser_download_url, version, assetName),\n        checksumsUrl: validateReleaseAssetUrl(checksums.browser_download_url, version, "checksums.txt"),\n      };\n''',
    '''      const selected = selectCompatibleRelease(await deps.fetchRelease(), platform, arch);\n      if (!selected || compareVersions(selected.version, currentVersion) <= 0) {\n        candidate = null;\n        return transition({ status: "up-to-date" });\n      }\n      const { version, assetName, asset, checksums } = selected;\n      candidate = {\n        version,\n        assetName,\n        assetUrl: validateReleaseAssetUrl(asset.browser_download_url, version, assetName),\n        checksumsUrl: validateReleaseAssetUrl(\n          checksums.browser_download_url,\n          version,\n          CHECKSUM_ASSET_NAME,\n        ),\n      };\n''',
    "prerelease-aware update selection",
)
replace_once(
    update_path,
    '''      const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "codex-web-gpt-update-"));\n''',
    '''      const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "coding-tools-update-"));\n''',
    "project update staging prefix",
)
replace_once(
    update_path,
    '''  releaseAssetName,\n  releaseVersion,\n  validateReleaseAssetUrl,\n''',
    '''  releaseAssetName,\n  releaseVersion,\n  selectCompatibleRelease,\n  validateReleaseAssetUrl,\n''',
    "release selector export",
)

# Hide the native ChatGPT view synchronously before switching to non-browser menu pages.
app_path = "desktop-electron/src/App.tsx"
replace_once(
    app_path,
    '''  const navigateSurface = (next: Surface) => {\n    setSurface(next);\n    if (compactSidebar) setSidebarOpen(false);\n  };\n''',
    '''  const navigateSurface = (next: Surface) => {\n    if (next !== "browser") {\n      void api!.setBrowserSurfaceActive(false).catch((cause) => setError(messageOf(cause)));\n    }\n    setSurface(next);\n    if (compactSidebar) setSidebarOpen(false);\n  };\n''',
    "eager browser surface hide",
)
replace_once(
    app_path,
    '''                  label={updateBusy ? copy.updating : `${copy.updateAvailable} v${updateVersion}`}\n''',
    '''                  label={updateBusy ? copy.updating : `${copy.updateAvailable} Coding Tools v${updateVersion}`}\n''',
    "project update label",
)
replace_once(
    app_path,
    '''                showMcp={() => {\n                  setMcpTargetMode(null);\n                  setSurface("mcp");\n                }}\n''',
    '''                showMcp={() => {\n                  setMcpTargetMode(null);\n                  navigateSurface("mcp");\n                }}\n''',
    "setup menu navigation",
)
replace_once(
    app_path,
    '''                onDone={() => {\n                  setMcpTargetMode(null);\n                  setSurface("browser");\n                }}\n''',
    '''                onDone={() => {\n                  setMcpTargetMode(null);\n                  navigateSurface("browser");\n                }}\n''',
    "MCP completion navigation",
)
replace_once(
    app_path,
    '''                configureInteractionMode={(mode) => {\n                  setMcpTargetMode(mode);\n                  setSurface("mcp");\n                }}\n''',
    '''                configureInteractionMode={(mode) => {\n                  setMcpTargetMode(mode);\n                  navigateSurface("mcp");\n                }}\n''',
    "settings menu navigation",
)

# Fully hide the primary native WebContentsView while a different launcher surface is active.
browser_host_path = "desktop-electron/electron/browser-host.cjs"
replace_once(
    browser_host_path,
    '''  presentPrimaryView(visible) {\n    // The descriptor advertises this exact WebContents for the lifetime of the launcher. Hiding\n    // the native View can make Windows drop it from the remote-debugging target set, leaving a\n    // live descriptor whose ownership id cannot be leased. Keep the View attached and drawable\n    // offscreen; only its placement, never its ownership lifetime, follows the launcher UI.\n    this.view.setBounds(visible ? this.bounds : this.hiddenTurnBounds());\n    this.view.setVisible(true);\n  }\n''',
    '''  presentPrimaryView(visible) {\n    // Non-browser launcher pages must never be covered by the native ChatGPT view. Keep the\n    // descriptor-owned view attached while the browser page is selected, but fully hide it when\n    // the launcher explicitly deactivates the browser surface.\n    if (!this.surfaceActive) {\n      this.view.setVisible(false);\n      return;\n    }\n    this.view.setBounds(visible ? this.bounds : this.hiddenTurnBounds());\n    this.view.setVisible(true);\n  }\n''',
    "native browser menu isolation",
)

# Surface real multi-account totals in Provider Center.
provider_path = "desktop-electron/src/features/ProviderHubSurface.tsx"
replace_once(
    provider_path,
    '''  const activeAccounts = useMemo(() => snapshot.accounts.filter((account) => !account.archivedAt), [snapshot]);\n  const selectedAccount = activeAccounts.find((account) => account.id === selectedAccountId);\n''',
    '''  const activeAccounts = useMemo(() => snapshot.accounts.filter((account) => !account.archivedAt), [snapshot]);\n  const providerAccountCounts = useMemo(() => {\n    const counts = new Map<string, number>();\n    for (const account of activeAccounts) {\n      counts.set(account.providerId, (counts.get(account.providerId) ?? 0) + 1);\n    }\n    return counts;\n  }, [activeAccounts]);\n  const activeProviderCount = providerAccountCounts.size;\n  const selectedAccount = activeAccounts.find((account) => account.id === selectedAccountId);\n''',
    "Provider Hub account totals",
)
replace_once(
    provider_path,
    '''        <button className="secondary-button" onClick={() => void refreshBindings().catch((cause) => setError(messageOf(cause)))} type="button">\n          {text(language, "Refresh bindings", "刷新綁定")}\n        </button>\n        {notice ? <p className="inline-notice">{notice}</p> : null}\n''',
    '''        <button className="secondary-button" onClick={() => void refreshBindings().catch((cause) => setError(messageOf(cause)))} type="button">\n          {text(language, "Refresh bindings", "刷新綁定")}\n        </button>\n        <p className="inline-notice provider-account-summary" data-provider-account-summary>\n          {text(\n            language,\n            `${activeAccounts.length} account${activeAccounts.length === 1 ? "" : "s"} across ${activeProviderCount} provider${activeProviderCount === 1 ? "" : "s"}`,\n            `${activeAccounts.length} 個帳戶・${activeProviderCount} 個供應商`,\n          )}\n        </p>\n        {notice ? <p className="inline-notice">{notice}</p> : null}\n''',
    "Provider Hub account summary",
)
replace_once(
    provider_path,
    '''            const provider = providerDefinition(account.providerId);\n            const active = account.id === selectedAccountId;\n            const connected = account.enabled && account.status === "connected";\n''',
    '''            const provider = providerDefinition(account.providerId);\n            const providerAccountCount = providerAccountCounts.get(account.providerId) ?? 0;\n            const active = account.id === selectedAccountId;\n            const connected = account.enabled && account.status === "connected";\n''',
    "per-provider account total",
)
replace_once(
    provider_path,
    '''                  <span>{account.models.length} models</span>\n''',
    '''                  <span>{text(\n                    language,\n                    `${providerAccountCount} account${providerAccountCount === 1 ? "" : "s"} · ${account.models.length} models`,\n                    `${providerAccountCount} 個帳戶 · ${account.models.length} 個模型`,\n                  )}</span>\n''',
    "account card total",
)

# Update focused updater regressions for the project release contract.
update_test_path = "desktop-electron/tests/update.test.cjs"
text = read(update_test_path)
replacements = {
    "miuuyy/codex-chatgpt-web": "p90-lover/coding-tools-mcp",
    "codex-web-gpt-1.2.0-mac-arm64.zip": "Coding.Tools_1.2.0_mac_arm64.zip",
    "codex-web-gpt-1.2.0-mac-x64.zip": "Coding.Tools_1.2.0_mac_x64.zip",
    "codex-web-gpt-1.2.0-win-x64.exe": "Coding.Tools_1.2.0_windows_x64_setup.exe",
    "codex-web-gpt-1.2.0-linux-x64.AppImage": "Coding.Tools_1.2.0_linux_x64.AppImage",
    "checksums.txt": "SHA256SUMS.txt",
}
for old, new in replacements.items():
    if old not in text and new not in text:
        raise SystemExit(f"update regression anchor missing: {old}")
    text = text.replace(old, new)
text = text.replace(
    '''  releaseAssetName,\n  validateReleaseAssetUrl,\n''',
    '''  releaseAssetName,\n  selectCompatibleRelease,\n  validateReleaseAssetUrl,\n''',
    1,
)
comparison_anchor = '''  assert.equal(compareVersions("1.2.0", "1.1.99"), 1);\n'''
comparison_extra = comparison_anchor + '''  assert.equal(compareVersions("0.7.0-rc.5", "0.7.0-rc.4"), 1);\n  assert.equal(compareVersions("0.7.0", "0.7.0-rc.5"), 1);\n'''
if comparison_extra not in text:
    if comparison_anchor not in text:
        raise SystemExit("prerelease comparison test anchor missing")
    text = text.replace(comparison_anchor, comparison_extra, 1)
selection_anchor = '''test("macOS bundle resolution never guesses outside Contents/MacOS", () => {\n'''
selection_test = '''test("project updater selects the newest complete prerelease and ignores draft or incomplete releases", () => {\n  const release = selectCompatibleRelease([\n    {\n      tag_name: "v0.7.0-rc.6",\n      draft: true,\n      assets: [],\n    },\n    {\n      tag_name: "v0.7.0-rc.5",\n      prerelease: true,\n      assets: [\n        {\n          name: "Coding.Tools_0.7.0-rc.5_windows_x64_setup.exe",\n          browser_download_url: "https://github.com/p90-lover/coding-tools-mcp/releases/download/v0.7.0-rc.5/Coding.Tools_0.7.0-rc.5_windows_x64_setup.exe",\n        },\n        {\n          name: "SHA256SUMS.txt",\n          browser_download_url: "https://github.com/p90-lover/coding-tools-mcp/releases/download/v0.7.0-rc.5/SHA256SUMS.txt",\n        },\n      ],\n    },\n    {\n      tag_name: "v5.0.7",\n      assets: [],\n    },\n  ], "win32", "x64");\n  assert.equal(release?.version, "0.7.0-rc.5");\n  assert.equal(release?.assetName, "Coding.Tools_0.7.0-rc.5_windows_x64_setup.exe");\n});\n\n'''
if selection_test not in text:
    if selection_anchor not in text:
        raise SystemExit("release selection test insertion anchor missing")
    text = text.replace(selection_anchor, selection_test + selection_anchor, 1)
write(update_test_path, text)

# Extend source-level regressions so the legacy renderer list cannot silently become active again.
provider_test_path = "desktop-electron/tests/provider-center-account-wiring.test.cjs"
replace_once(
    provider_test_path,
    '''  assert.ok(surface.length > 0, "ProviderHubSurface.tsx must exist");\n});\n''',
    '''  assert.ok(surface.length > 0, "ProviderHubSurface.tsx must exist");\n  assert.doesNotMatch(app, /ProviderOrchestratorSurfaces/);\n});\n''',
    "legacy provider import guard",
)
replace_once(
    provider_test_path,
    '''  assert.match(surface, /archiveProviderAccount\\(/);\n\n  assert.match(preload, /saveProviderAccount/);\n''',
    '''  assert.match(surface, /archiveProviderAccount\\(/);\n  assert.match(surface, /data-provider-account-summary/);\n  assert.match(surface, /providerAccountCounts/);\n  assert.match(surface, /個帳戶/);\n\n  assert.match(preload, /saveProviderAccount/);\n''',
    "provider count regression",
)

# Verify the native view is actually hidden on non-browser surfaces and restored on browser return.
browser_test_path = "desktop-electron/tests/browser-host.test.cjs"
replace_once(
    browser_test_path,
    '''test("descriptor-owned home surface stays attached offscreen while another launcher surface is active", () => {\n  const calls = [];\n  const hiddenBounds = { x: 1201, y: 801, width: 1200, height: 800 };\n  const fixture = Object.assign(Object.create(BrowserHost.prototype), {\n    window: {\n      isVisible: () => true,\n      isMinimized: () => false,\n    },\n    visible: false,\n    surfaceActive: false,\n    boundsReady: true,\n    bounds: { x: 200, y: 100, width: 900, height: 650 },\n    hiddenTurnBounds: () => hiddenBounds,\n    view: {\n      setBounds: bounds => calls.push(["bounds", bounds]),\n      setVisible: visible => calls.push(["visible", visible]),\n    },\n    authView: null,\n    turnTabs: new Map(),\n    selectedTurnTab: () => null,\n  });\n\n  BrowserHost.prototype.syncViewVisibility.call(fixture);\n\n  assert.deepEqual(calls, [\n    ["bounds", hiddenBounds],\n    ["visible", true],\n  ]);\n});\n''',
    '''test("descriptor-owned home surface is hidden outside Browser and restored when Browser returns", () => {\n  const calls = [];\n  const hiddenBounds = { x: 1201, y: 801, width: 1200, height: 800 };\n  const fixture = Object.assign(Object.create(BrowserHost.prototype), {\n    window: {\n      isVisible: () => true,\n      isMinimized: () => false,\n    },\n    visible: false,\n    surfaceActive: false,\n    boundsReady: true,\n    bounds: { x: 200, y: 100, width: 900, height: 650 },\n    hiddenTurnBounds: () => hiddenBounds,\n    view: {\n      setBounds: bounds => calls.push(["bounds", bounds]),\n      setVisible: visible => calls.push(["visible", visible]),\n    },\n    authView: null,\n    turnTabs: new Map(),\n    selectedTurnTab: () => null,\n  });\n\n  BrowserHost.prototype.syncViewVisibility.call(fixture);\n  assert.deepEqual(calls, [["visible", false]]);\n\n  calls.length = 0;\n  fixture.surfaceActive = true;\n  fixture.visible = true;\n  BrowserHost.prototype.syncViewVisibility.call(fixture);\n  assert.deepEqual(calls, [\n    ["bounds", fixture.bounds],\n    ["visible", true],\n  ]);\n});\n''',
    "browser menu overlay regression",
)

# A post-build contract proves the packaged renderer contains the encrypted Provider Hub, not the
# preserved legacy localStorage implementation.
bundle_test = Path("desktop-electron/tests/renderer-provider-bundle.test.cjs")
bundle_test.write_text('''"use strict";\n\nconst assert = require("node:assert/strict");\nconst fs = require("node:fs");\nconst path = require("node:path");\nconst test = require("node:test");\n\nconst root = path.resolve(__dirname, "..");\nconst assets = path.join(root, "dist", "assets");\n\ntest("packaged renderer selects Provider Hub and project-scoped update copy", () => {\n  const scripts = fs.readdirSync(assets)\n    .filter((name) => /^index-.*\\.js$/u.test(name))\n    .sort();\n  assert.equal(scripts.length, 1, `expected one renderer entry script, got ${scripts.join(", ")}`);\n  const bundle = fs.readFileSync(path.join(assets, scripts[0]), "utf8");\n  assert.match(bundle, /data-provider-account-summary/);\n  assert.match(bundle, /Refresh accounts/);\n  assert.match(bundle, /Coding Tools v/);\n  assert.doesNotMatch(bundle, /coding-tools-provider-instances-v1/);\n});\n''', encoding="utf-8")

release_notes = Path("docs/releases/v0.7.0-rc.5.md")
release_notes.write_text('''# Coding Tools v0.7.0-rc.5\n\n## English\n\nThis focused hotfix repairs the desktop navigation, Provider Center account totals, and in-app update source.\n\n### Fixes\n\n- The native ChatGPT WebContentsView is hidden before Provider Center, Paseo, Anneal, Network Proxy, Activity, Setup, MCP, or Settings is shown, preventing the white “Unable to load site” panel from covering menu pages.\n- Provider Center displays the total active account count, provider count, and per-provider account/model totals.\n- The updater now reads prereleases from `p90-lover/coding-tools-mcp`, selects the newest complete compatible Coding Tools release, and uses `SHA256SUMS.txt`. It no longer advertises upstream `codex-chatgpt-web` v5.0.7.\n- The update row names Coding Tools explicitly.\n- A post-build contract rejects a renderer bundle that contains the preserved legacy localStorage provider implementation.\n\n### Validation boundary\n\nFocused automated tests and packaging checks do not spend provider quota. Real OAuth and external Paseo/Anneal acceptance remain manual.\n\n---\n\n## 繁體中文\n\n今次集中式 hotfix 修正桌面選單、供應商中心帳戶數量，同應用程式內更新來源。\n\n### 修正內容\n\n- 顯示供應商中心、Paseo、Anneal、網路代理、活動、設定、MCP 或初始設定之前，會先隱藏原生 ChatGPT WebContentsView，避免白色「Unable to load site」畫面遮住選單。\n- 供應商中心會顯示有效帳戶總數、供應商總數，以及每個供應商嘅帳戶／模型數量。\n- 更新器而家會由 `p90-lover/coding-tools-mcp` 讀取 prerelease，選擇最新而且完整相容嘅 Coding Tools release，並使用 `SHA256SUMS.txt`；唔會再顯示 upstream `codex-chatgpt-web` v5.0.7。\n- 更新列會明確顯示 Coding Tools 名稱。\n- 新增打包後合約，防止保留作審計嘅舊 localStorage 供應商介面再次進入正式 renderer bundle。\n\n### 驗證邊界\n\n集中式自動測試同打包檢查唔會消耗 provider quota；真實 OAuth 同外部 Paseo／Anneal 驗收仍然保留為人工步驟。\n''', encoding="utf-8")

# Final source-contract checks.
require(update_path, 'const REPOSITORY = "p90-lover/coding-tools-mcp";', "project repository")
require(update_path, "selectCompatibleRelease", "prerelease selector")
require(app_path, "Coding Tools v${updateVersion}", "project update row")
require(provider_path, "data-provider-account-summary", "provider account summary")
require(browser_host_path, "if (!this.surfaceActive)", "native view isolation")
print("CODING_TOOLS_RC5_MENU_PROVIDER_UPDATER_PATCH_OK")
