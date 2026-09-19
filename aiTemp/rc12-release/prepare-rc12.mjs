import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const root = process.cwd();
const fromVersion = '0.7.0-rc.11';
const toVersion = '0.7.0-rc.12';
const fromLabel = 'rc.11';
const toLabel = 'rc.12';
const expectedBranch = 'release/v0.7.0-rc.12-browser-network-fix';

function fail(code, detail = '') {
  throw new Error(`${code}${detail ? `: ${detail}` : ''}`);
}

function absolute(relativePath) {
  const resolved = path.resolve(root, relativePath);
  const relative = path.relative(root, resolved);
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    fail('RC12_PATH_OUTSIDE_REPOSITORY', relativePath);
  }
  return resolved;
}

function read(relativePath) {
  return fs.readFileSync(absolute(relativePath), 'utf8');
}

function write(relativePath, content) {
  const filePath = absolute(relativePath);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, 'utf8');
}

function replaceRequired(relativePath, replacements) {
  let content = read(relativePath);
  const original = content;
  for (const [from, to] of replacements) {
    if (!content.includes(from)) fail('RC12_REPLACEMENT_ANCHOR_MISSING', `${relativePath}: ${from}`);
    content = content.replaceAll(from, to);
  }
  if (content === original) fail('RC12_FILE_UNCHANGED', relativePath);
  write(relativePath, content);
}

function copyReleaseTemplate(sourcePath, targetPath) {
  if (fs.existsSync(absolute(targetPath))) fail('RC12_TARGET_ALREADY_EXISTS', targetPath);
  const source = read(sourcePath);
  const transformed = source
    .replaceAll(fromVersion, toVersion)
    .replaceAll('rc11', 'rc12')
    .replaceAll('RC11', 'RC12');
  if (source.includes(fromVersion) && transformed.includes(fromVersion)) {
    fail('RC12_TEMPLATE_TRANSFORM_FAILED', `${sourcePath} -> ${targetPath}`);
  }
  write(targetPath, transformed);
}

const branch = process.env.GITHUB_REF_NAME || process.env.RC12_PREPARE_BRANCH || '';
if (branch && branch !== expectedBranch) fail('RC12_PREPARE_BRANCH_MISMATCH', branch);

for (const relativePath of [
  'desktop-electron/electron/product.cjs',
  'desktop-electron/package.json',
  'desktop-electron/scripts/prepare-package-resources.cjs',
  'desktop-electron/scripts/verify-package.cjs',
  'desktop-electron/tests/package-contents.test.cjs',
  'desktop-electron/tests/package-resource-preparation.test.cjs',
  'desktop-electron/tests/product-identity.test.cjs',
]) {
  replaceRequired(relativePath, [[fromVersion, toVersion]]);
}

for (const relativePath of [
  'desktop-electron/tests/installer-upgrade-migration.test.cjs',
  'desktop-electron/tests/rc9-package-identity-alignment.test.cjs',
]) {
  replaceRequired(relativePath, [
    [fromVersion, toVersion],
    [fromLabel, toLabel],
  ]);
}

const historicalWorkflow = `# Historical v0.7.0-rc.11 record. This workflow intentionally cannot publish or move the immutable tag.\nname: Coding Tools v0.7.0-rc.11 historical release record\n\non:\n  workflow_dispatch:\n\npermissions:\n  contents: read\n\nenv:\n  RELEASE_VERSION: 0.7.0-rc.11\n  RELEASE_TAG: v0.7.0-rc.11\n\njobs:\n  immutable-history:\n    runs-on: ubuntu-24.04\n    steps:\n      - uses: actions/checkout@11bd71901bbe5b1630ceea73d27597364c9af683\n        with:\n          persist-credentials: false\n      - name: Confirm retained historical notes\n        run: |\n          test -s docs/releases/v0.7.0-rc.11.md\n          echo 'v0.7.0-rc.11 is retained as immutable history; use the newer release workflow for publishing.'\n`;
write('.github/workflows/codex-router-multiprovider-release-rc11.yml', historicalWorkflow);

const historicalIdentity = `"use strict";\n\nconst assert = require("node:assert/strict");\nconst fs = require("node:fs");\nconst path = require("node:path");\nconst test = require("node:test");\n\nconst repo = path.resolve(__dirname, "..", "..");\nconst read = (relativePath) => fs.readFileSync(path.join(repo, relativePath), "utf8");\n\ntest("rc.11 release history remains immutable and non-publishing", () => {\n  const workflow = read(".github/workflows/codex-router-multiprovider-release-rc11.yml");\n  const notes = read("docs/releases/v0.7.0-rc.11.md");\n  assert.match(workflow, /RELEASE_VERSION: 0\\.7\\.0-rc\\.11/);\n  assert.match(workflow, /RELEASE_TAG: v0\\.7\\.0-rc\\.11/);\n  assert.match(workflow, /workflow_dispatch/);\n  assert.doesNotMatch(workflow, /publish-v0\\.6\\.0-rc\\.1/);\n  assert.doesNotMatch(workflow, /git push[^\\n]*--force/);\n  assert.match(notes, /Coding Tools v0\\.7\\.0-rc\\.11/);\n});\n`;
write('desktop-electron/tests/rc11-release-identity.test.cjs', historicalIdentity);

copyReleaseTemplate(
  'aiTemp/rc11-release/run-windows-release.mjs',
  'aiTemp/rc12-release/run-windows-release.mjs',
);
copyReleaseTemplate(
  'aiTemp/rc11-release/verify-windows-migration.ps1',
  'aiTemp/rc12-release/verify-windows-migration.ps1',
);
copyReleaseTemplate(
  '.github/workflows/codex-router-multiprovider-release-rc11.yml',
  '.github/workflows/codex-router-multiprovider-release-rc12.yml',
);

// The historical workflow above is intentionally minimal, so construct the active
// rc.12 publisher from the verified pre-conversion rc.11 workflow stored in HEAD.
const historicalWorkflowFromHead = process.env.RC12_ORIGINAL_WORKFLOW;
if (!historicalWorkflowFromHead) {
  fail('RC12_ORIGINAL_WORKFLOW_MISSING', 'workflow must export the verified rc.11 template before running this driver');
}
const activeWorkflow = Buffer.from(historicalWorkflowFromHead, 'base64').toString('utf8')
  .replaceAll(fromVersion, toVersion)
  .replaceAll('rc11', 'rc12')
  .replaceAll('RC11', 'RC12');
if (!activeWorkflow.includes('RELEASE_TAG: v0.7.0-rc.12') || activeWorkflow.includes(fromVersion)) {
  fail('RC12_WORKFLOW_TRANSFORM_FAILED');
}
write('.github/workflows/codex-router-multiprovider-release-rc12.yml', activeWorkflow);

const rc12Identity = `"use strict";\n\nconst assert = require("node:assert/strict");\nconst fs = require("node:fs");\nconst path = require("node:path");\nconst test = require("node:test");\n\nconst repo = path.resolve(__dirname, "..", "..");\nconst read = (relativePath) => fs.readFileSync(path.join(repo, relativePath), "utf8");\n\ntest("rc.12 product, package, and browser/network fixes are aligned", () => {\n  const manifest = JSON.parse(read("desktop-electron/package.json"));\n  assert.equal(manifest.version, "0.7.0-rc.12");\n  assert.match(read("desktop-electron/electron/product.cjs"), /version: "0\\.7\\.0-rc\\.12"/);\n  assert.match(read("desktop-electron/scripts/prepare-package-resources.cjs"), /PRODUCT_VERSION = "0\\.7\\.0-rc\\.12"/);\n  assert.match(read("desktop-electron/scripts/verify-package.cjs"), /version: "0\\.7\\.0-rc\\.12"/);\n  assert.match(read("desktop-electron/tests/browser-surface-ipc.test.cjs"), /missing dedicated handler falls back/);\n  assert.match(read("desktop-electron/tests/network-proxy-localization.test.cjs"), /Traditional Chinese/);\n});\n\ntest("rc.12 publishes a new immutable tag without rewriting rc.11", () => {\n  const workflow = read(".github/workflows/codex-router-multiprovider-release-rc12.yml");\n  assert.match(workflow, /RELEASE_VERSION: 0\\.7\\.0-rc\\.12/);\n  assert.match(workflow, /RELEASE_TAG: v0\\.7\\.0-rc\\.12/);\n  assert.match(workflow, /aiTemp\\/rc12-release\\/run-windows-release\\.mjs/);\n  assert.match(workflow, /browser-surface-ipc\\.test\\.cjs/);\n  assert.match(workflow, /network-proxy-localization\\.test\\.cjs/);\n  assert.doesNotMatch(workflow, /git push[^\\n]*--force/);\n\n  const historical = read(".github/workflows/codex-router-multiprovider-release-rc11.yml");\n  assert.match(historical, /RELEASE_TAG: v0\\.7\\.0-rc\\.11/);\n  assert.doesNotMatch(historical, /publish-v0\\.6\\.0-rc\\.1/);\n});\n`;
write('desktop-electron/tests/rc12-release-identity.test.cjs', rc12Identity);

const releaseNotes = `# Coding Tools v0.7.0-rc.12\n\n## English\n\nThis prerelease publishes the verified browser-surface ownership and complete Network Proxy localization repairs on top of the unified five-stack application.\n\n### Browser surface ownership\n\n- Switching away from Browser now hides the native ChatGPT WebContentsView instead of leaving it above Provider, Network, Paseo, Anneal, or other React surfaces.\n- Matching app versions use the dedicated browser-surface ownership IPC.\n- Split-version updates fail over narrowly to the compatible show/hide channels only when that exact IPC handler is missing.\n- Rapid tab changes are serialized, failed hide operations do not arm a later restore, and failed restores remain retryable.\n- Unrelated IPC errors remain visible rather than being silently swallowed.\n\n### Network Proxy localization and routing\n\n- Profile management, field labels, statuses, scopes, validation, notices, routing modes, provider routing, account routing, and action buttons are fully localized.\n- Traditional Chinese, Simplified Chinese, Japanese, and English are supported.\n- The typed subagent traffic scope is now visible and included in new global proxy profiles.\n- Loopback control traffic remains direct and protected.\n\n### Release integrity\n\n- The existing v0.7.0-rc.11 tag is retained unchanged as immutable history.\n- v0.7.0-rc.12 uses a new exact-source tag and installer identity.\n- Release gates cover browser ownership, Network Proxy localization, five-stack contracts, strict TypeScript, production renderer, Rust headless build, Windows packaging, packaged-launcher smoke, legacy migration, checksums, provenance, remote asset readback, and no-file-deletion enforcement.\n- Generated and superseded material remains under aiTemp and Trash.\n\nLive OAuth, paid-provider quota, and local third-party runtime credentials remain user-machine validation boundaries.\n\n---\n\n## 繁體中文\n\n今次預覽版本會喺統一五項系統應用程式之上，正式發佈已驗證嘅瀏覽器介面擁有權修正，以及完整網路代理本地化。\n\n### 瀏覽器介面擁有權\n\n- 離開「瀏覽器」分頁時，原生 ChatGPT WebContentsView 而家會正確隱藏，唔會再覆蓋供應商、網路代理、Paseo、Anneal 或其他 React 畫面。\n- 版本一致時會使用專用 browser-surface ownership IPC。\n- Split-version 更新只會喺精確 IPC handler 缺失時，有限度轉用相容嘅顯示／隱藏通道。\n- 快速切換分頁會順序處理；隱藏失敗唔會錯誤安排稍後恢復；恢復失敗亦可以重試。\n- 其他 IPC 錯誤唔會被靜默隱藏。\n\n### 網路代理本地化同路由\n\n- 設定檔管理、欄位名稱、狀態、流量範圍、驗證訊息、通知、路由模式、供應商路由、帳戶路由及操作按鈕已完整本地化。\n- 支援繁體中文、簡體中文、日文同英文。\n- 已補回有型別保護嘅子代理流量範圍，並加入新全域代理設定檔。\n- Loopback 控制流量繼續保持直接連線及受保護。\n\n### 發佈完整性\n\n- 既有 v0.7.0-rc.11 Tag 會原封不動保留做不可變歷史記錄。\n- v0.7.0-rc.12 使用全新 exact-source Tag 同安裝程式身份。\n- Release gate 會驗證瀏覽器擁有權、網路代理本地化、五項系統 contracts、Strict TypeScript、Production Renderer、Rust Headless Build、Windows Packaging、Packaged-launcher Smoke、舊版 Migration、Checksum、Provenance、遠端資產回讀同禁止刪檔規則。\n- 產生及已取代嘅材料會保留喺 aiTemp 同 Trash。\n\n真實 OAuth、付費供應商額度同本機第三方 runtime 憑證仍然係使用者電腦上嘅驗證邊界。\n`;
write('docs/releases/v0.7.0-rc.12.md', releaseNotes);

for (const required of [
  '.github/workflows/codex-router-multiprovider-release-rc12.yml',
  'aiTemp/rc12-release/run-windows-release.mjs',
  'aiTemp/rc12-release/verify-windows-migration.ps1',
  'desktop-electron/tests/rc12-release-identity.test.cjs',
  'docs/releases/v0.7.0-rc.12.md',
]) {
  if (!fs.existsSync(absolute(required))) fail('RC12_OUTPUT_MISSING', required);
}

for (const current of [
  'desktop-electron/electron/product.cjs',
  'desktop-electron/package.json',
  'desktop-electron/scripts/prepare-package-resources.cjs',
  'desktop-electron/scripts/verify-package.cjs',
  'desktop-electron/tests/installer-upgrade-migration.test.cjs',
  'desktop-electron/tests/package-contents.test.cjs',
  'desktop-electron/tests/package-resource-preparation.test.cjs',
  'desktop-electron/tests/product-identity.test.cjs',
  'desktop-electron/tests/rc9-package-identity-alignment.test.cjs',
]) {
  if (!read(current).includes(toVersion)) fail('RC12_ACTIVE_IDENTITY_MISSING', current);
}

process.stdout.write(`RC12_PREPARATION_COMPLETE ${toVersion}\n`);
