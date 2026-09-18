import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const ROOT = process.cwd();
const PREVIOUS_VERSION = "0.7.0-rc.9";
const RELEASE_VERSION = "0.7.0-rc.11";
const RELEASE_TAG = `v${RELEASE_VERSION}`;
const RELEASE_BRANCH = "release/codex-router-multiprovider-0.7.0-rc.11";

function absolute(relativePath) {
  return path.join(ROOT, ...relativePath.split("/"));
}

function read(relativePath) {
  return fs.readFileSync(absolute(relativePath), "utf8");
}

function write(relativePath, content) {
  const target = absolute(relativePath);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content.endsWith("\n") ? content : `${content}\n`, "utf8");
  process.stdout.write(`materialized ${relativePath}\n`);
}

function replaceRequired(source, before, after, label) {
  if (!source.includes(before)) {
    throw new Error(`RC11_ANCHOR_MISSING:${label}:${before}`);
  }
  return source.split(before).join(after);
}

function bumpVersion(relativePath, { replaceLabel = false } = {}) {
  const source = read(relativePath);
  let next = replaceRequired(source, PREVIOUS_VERSION, RELEASE_VERSION, relativePath);
  if (replaceLabel) next = next.split("rc.9").join("rc.11");
  if (next.includes(PREVIOUS_VERSION)) {
    throw new Error(`RC11_STALE_VERSION:${relativePath}`);
  }
  write(relativePath, next);
}

for (const relativePath of [
  "desktop-electron/package.json",
  "desktop-electron/electron/product.cjs",
  "desktop-electron/scripts/prepare-package-resources.cjs",
  "desktop-electron/scripts/verify-package.cjs",
  "desktop-electron/tests/product-identity.test.cjs",
  "desktop-electron/tests/package-contents.test.cjs",
  "desktop-electron/tests/package-resource-preparation.test.cjs",
]) {
  bumpVersion(relativePath);
}

bumpVersion("desktop-electron/tests/installer-upgrade-migration.test.cjs", { replaceLabel: true });

write("desktop-electron/tests/rc9-package-identity-alignment.test.cjs", `"use strict";

// Filename retained for compatibility with the inherited exact-source runner.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const desktopRoot = path.resolve(__dirname, "..");
const read = (relativePath) => fs.readFileSync(path.join(desktopRoot, relativePath), "utf8");
const RELEASE_VERSION = "${RELEASE_VERSION}";
const PREVIOUS_VERSION = "${PREVIOUS_VERSION}";

const activeIdentityFiles = [
  "electron/product.cjs",
  "scripts/prepare-package-resources.cjs",
  "scripts/verify-package.cjs",
  "tests/product-identity.test.cjs",
  "tests/package-contents.test.cjs",
  "tests/package-resource-preparation.test.cjs",
  "tests/installer-upgrade-migration.test.cjs",
];

test("the rc.11 manifest and every active package identity use one release version", () => {
  const manifest = JSON.parse(read("package.json"));
  assert.equal(manifest.version, RELEASE_VERSION);

  for (const relativePath of activeIdentityFiles) {
    const source = read(relativePath);
    assert.match(source, /0\\.7\\.0-rc\\.11/, \`${"${relativePath}"} must declare ${RELEASE_VERSION}\`);
    assert.doesNotMatch(source, /0\\.7\\.0-rc\\.9/, \`${"${relativePath}"} still declares ${PREVIOUS_VERSION}\`);
  }
});

test("the installer migration contract names the current rc.11 release", () => {
  const source = read("tests/installer-upgrade-migration.test.cjs");
  assert.match(source, /rc\\.11 keeps the stable Electron installer identity/);
  assert.match(source, /manifest\\.version, "0\\.7\\.0-rc\\.11"/);
});
`);

let releaseWorkflow = read(".github/workflows/codex-router-multiprovider-release-rc9.yml");
releaseWorkflow = replaceRequired(releaseWorkflow, PREVIOUS_VERSION, RELEASE_VERSION, "workflow-version");
releaseWorkflow = replaceRequired(releaseWorkflow, "rc.9", "rc.11", "workflow-label");
releaseWorkflow = replaceRequired(releaseWorkflow, "rc9-release", "rc11-release", "workflow-temp-root");
releaseWorkflow = replaceRequired(
  releaseWorkflow,
  "codex-router-multiprovider-release-rc9.yml",
  "codex-router-multiprovider-release-rc11.yml",
  "workflow-file-name",
);

const extraTestAnchor = `            "    'desktop-electron/tests/rc9-package-identity-alignment.test.cjs',"`;
const extraTests = [
  `            "    'desktop-electron/tests/integrated-app-tabs.test.cjs',"`,
  `            "    'desktop-electron/tests/provider-console-saas.test.cjs',"`,
  `            "    'desktop-electron/tests/rc11-release-identity.test.cjs',"`,
].join("\n");
if (!releaseWorkflow.includes("integrated-app-tabs.test.cjs")) {
  releaseWorkflow = replaceRequired(
    releaseWorkflow,
    extraTestAnchor,
    `${extraTestAnchor}\n${extraTests}`,
    "workflow-extra-tests",
  );
}

const selectAnchor = "          Select-String -Path $runnerTarget -SimpleMatch 'rc9-package-identity-alignment.test.cjs' | Out-Null";
const selectAdditions = [
  "          Select-String -Path $runnerTarget -SimpleMatch 'integrated-app-tabs.test.cjs' | Out-Null",
  "          Select-String -Path $runnerTarget -SimpleMatch 'provider-console-saas.test.cjs' | Out-Null",
  "          Select-String -Path $runnerTarget -SimpleMatch 'rc11-release-identity.test.cjs' | Out-Null",
].join("\n");
if (!releaseWorkflow.includes("Select-String -Path $runnerTarget -SimpleMatch 'integrated-app-tabs.test.cjs'")) {
  releaseWorkflow = replaceRequired(
    releaseWorkflow,
    selectAnchor,
    `${selectAnchor}\n${selectAdditions}`,
    "workflow-test-validation",
  );
}

if (!releaseWorkflow.includes(`RELEASE_VERSION: ${RELEASE_VERSION}`)
    || !releaseWorkflow.includes(`RELEASE_TAG: ${RELEASE_TAG}`)
    || !releaseWorkflow.includes(RELEASE_BRANCH)
    || releaseWorkflow.includes("RELEASE_TAG: v0.7.0-rc.9")) {
  throw new Error("RC11_WORKFLOW_IDENTITY_INVALID");
}
write(".github/workflows/codex-router-multiprovider-release-rc11.yml", releaseWorkflow);

write("desktop-electron/tests/rc11-release-identity.test.cjs", `"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const repo = path.resolve(__dirname, "..", "..");
const read = (relativePath) => fs.readFileSync(path.join(repo, relativePath), "utf8");

test("rc.11 product, package, and integrated Apps identities are aligned", () => {
  const manifest = JSON.parse(read("desktop-electron/package.json"));
  assert.equal(manifest.version, "${RELEASE_VERSION}");
  assert.match(read("desktop-electron/electron/product.cjs"), /version: "0\\.7\\.0-rc\\.11"/);
  assert.match(read("desktop-electron/scripts/prepare-package-resources.cjs"), /PRODUCT_VERSION = "0\\.7\\.0-rc\\.11"/);
  assert.match(read("desktop-electron/scripts/verify-package.cjs"), /version: "0\\.7\\.0-rc\\.11"/);

  const apps = read("desktop-electron/src/features/IntegratedAppsSurface.tsx");
  for (const tab of ["cpa", "codex-router", "commandcode-proxy", "paseo", "anneal"]) {
    assert.match(apps, new RegExp(`id: ["']${tab}["']`));
  }
  assert.match(read("desktop-electron/src/App.tsx"), /surface === "apps"/);
});

test("rc.11 publishes a new immutable tag and leaves rc.9 history untouched", () => {
  const workflow = read(".github/workflows/codex-router-multiprovider-release-rc11.yml");
  assert.match(workflow, /RELEASE_VERSION: 0\\.7\\.0-rc\\.11/);
  assert.match(workflow, /RELEASE_TAG: v0\\.7\\.0-rc\\.11/);
  assert.match(workflow, /release\\/codex-router-multiprovider-0\\.7\\.0-rc\\.11/);
  assert.match(workflow, /docs\\/releases\\/v0\\.7\\.0-rc\\.11\\.md/);
  assert.match(workflow, /integrated-app-tabs\\.test\\.cjs/);
  assert.doesNotMatch(workflow, /RELEASE_TAG: v0\\.7\\.0-rc\\.9/);
  assert.doesNotMatch(workflow, /git push[^\\n]*--force/);

  const historical = read(".github/workflows/codex-router-multiprovider-release-rc9.yml");
  assert.match(historical, /RELEASE_TAG: v0\\.7\\.0-rc\\.9/);
});
`);

write("docs/releases/v0.7.0-rc.11.md", `# Coding Tools v0.7.0-rc.11

## English

This prerelease promotes the verified unified **Apps** workspace while preserving the complete app-managed five-stack and its security boundaries.

### Unified application workspace

- One **Apps** destination replaces fragmented top-level Provider, Integrations, Paseo, and Anneal destinations.
- Dedicated tabs expose CPA / Accounts, Codex Router, CommandCode Proxy, Paseo, and Anneal.
- CPA continues to use the encrypted multi-account Provider Hub.
- Codex Router and CommandCode Proxy reuse the existing lifecycle controller in focused mode.
- Paseo and Anneal reuse their embedded upstream interfaces and native orchestration controls.
- Keyboard tab navigation, visible focus states, narrow-window horizontal scrolling, English, and Traditional Chinese are included.
- Only the non-secret selected tab identifier is retained locally.

### Runtime and release integrity

- Existing OAuth, API-key, proxy, provider-routing, and execution boundaries remain unchanged.
- Managed services remain loopback-only and fail closed when authentication is incomplete.
- The historical v0.7.0-rc.9 tag and published assets are retained without mutation.
- Generated and superseded material is retained under aiTemp/Trash; project files are not deleted.
- The exact-source release gate covers focused UI contracts, provider execution, strict TypeScript, production renderer, Rust headless build, Windows packaging, packaged-launcher smoke, legacy migration, checksums, provenance, and remote asset readback.

Live OAuth and paid-provider acceptance remain explicit user-machine validation boundaries. CI does not consume provider quota or persist real user credentials.

---

## 繁體中文

今次預覽版本會發佈已驗證嘅統一 **應用程式**工作區，同時保留完整五項受 App 管理系統以及原有安全邊界。

### 統一應用程式工作區

- 使用單一 **應用程式**入口，取代分散嘅供應商、整合服務、Paseo 同 Anneal 頂層入口。
- 獨立分頁包括 CPA／帳戶、Codex Router、CommandCode Proxy、Paseo 同 Anneal。
- CPA 繼續使用加密多帳戶供應商中心。
- Codex Router 同 CommandCode Proxy 會重用現有生命週期控制器嘅集中模式。
- Paseo 同 Anneal 會重用內嵌上游介面以及原生協調控制。
- 支援鍵盤分頁導航、清晰焦點狀態、窄視窗橫向捲動、英文同繁體中文。
- 本機只會保留唔含秘密資料嘅已選分頁識別碼。

### 執行環境同發佈完整性

- 現有 OAuth、API Key、Proxy、供應商路由同執行安全邊界維持不變。
- 所有受管理服務繼續只准使用 loopback，驗證未完成時會 fail closed。
- 歷史 v0.7.0-rc.9 Tag 同已發佈資產會完整保留，絕不改寫。
- 產生或已取代嘅材料會保留到 aiTemp/Trash；唔會刪除 Project File。
- Exact-source Release Gate 會驗證集中 UI、供應商執行、Strict TypeScript、Production Renderer、Rust Headless Build、Windows Packaging、Packaged-launcher Smoke、舊版 Migration、Checksum、Provenance 同遠端資產回讀。

真實 OAuth 同付費供應商驗收仍然係使用者電腦上嘅明確驗證邊界。CI 唔會消耗供應商額度，亦唔會保存真實使用者憑證。
`);

process.stdout.write(`RC11_RELEASE_MATERIALIZED ${JSON.stringify({
  releaseVersion: RELEASE_VERSION,
  releaseTag: RELEASE_TAG,
  releaseBranch: RELEASE_BRANCH,
})}\n`);
