"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const desktopRoot = path.resolve(__dirname, "..");
const repositoryRoot = path.resolve(desktopRoot, "..");
const aiTempRoot = path.join(repositoryRoot, "aiTemp");
const SHA256 = /^[a-f0-9]{64}$/;
const SOURCE_SHA = /^[a-f0-9]{40}$/;
const MAX_TEXT_BYTES = 2 * 1024 * 1024;

const PRODUCT = Object.freeze({
  name: "Coding Tools",
  packageName: "coding-tools-full-harness-desktop",
  version: "0.7.0-rc.12",
  appId: "dev.codingtools.fullharness",
  platform: "win32",
  arch: "x64",
});
const SOURCE_REPOSITORY = "p90-lover/coding-tools-mcp";
const UPSTREAM = Object.freeze({
  repository: "miuuyy/codex-chatgpt-web",
  version: "v5.0.6",
  commit: "e85e3693fdb4e3e033348c08df0298c20fcdb612",
});
const STABLE_ROLLBACK = Object.freeze({
  releaseTag: "v0.4.10",
  assetName: "Coding.Tools.MCP_0.4.10_x64-setup.exe",
  size: 6461938,
  sha256: "3c3f60262672556ae113a8cccbc671e7b559bb7106392333cd4a0628471427d1",
});
const OFFICIAL_TUNNEL_RELEASE = Object.freeze({
  repository: "openai/tunnel-client",
  version: "v0.0.12",
  platform: "windows/amd64",
  archiveName: "tunnel-client-v0.0.12-windows-amd64.zip",
  archiveSha256: "2a2804933924e38a502d62b61f0266cb80d56d65744f4c29876b2bf9c1544356",
  licenseName: "tunnel-client-v0.0.12-windows-amd64-licenses.txt",
  licenseSha256: "7d85227df86c38a689fca913d6f4a0b49ad030d6e056155a6832312cf7fb4bad",
  spdxName: "tunnel-client-v0.0.12-windows-amd64.spdx.json",
  spdxSha256: "4c6b46a645b71853d55f50cfb4b2c51324422a57f007984ba113d3edcfeb4f2c",
  cloudflaredBinaryName: "cloudflared.exe",
  cloudflaredVersion: "2026.7.2",
  cloudflaredReleaseCommit: "8679787525edc8575b2948a7c4a50b6292c6d426",
});
const REQUIRED_TUNNEL_MEMBERS = Object.freeze([
  "LICENSE",
  "NOTICE",
  "cloudflared-manifest.json",
  "cloudflared.exe",
  "tunnel-client-v0.0.12-windows-amd64-licenses.txt",
  "tunnel-client-v0.0.12-windows-amd64.spdx.json",
  "tunnel-client.exe",
]);
const REQUIRED_COMPONENTS = Object.freeze({
  "migration-manifest": "migration/manifest.json",
  "rollback-manifest": "rollback/manifest.json",
  "runtime-manifest": "runtime/manifest.json",
  "rust-headless": "coding-tools/coding-tools-headless.exe",
  "third-party-notices": "coding-tools/THIRD_PARTY_NOTICES.md",
  "tunnel-client": "native/tunnel-client.exe",
});
const REQUIRED_ASAR_FILES = Object.freeze([
  "electron/main.cjs",
  "electron/preload.cjs",
  "electron/product.cjs",
  "electron/runtime-supervisor.cjs",
]);
const REQUIRED_MODULE_FILES = Object.freeze([
  "modules/host.cjs",
  "modules/handler-registry.cjs",
  "modules/lib/in-process-handler.cjs",
  "modules/cpa/handler.cjs",
  "modules/codex-router/handler.cjs",
  "modules/commandcode-proxy/handler.cjs",
  "modules/paseo/handler.cjs",
  "modules/anneal/handler.cjs",
]);
const COMPONENT_VERSIONS = Object.freeze({
  "migration-manifest": PRODUCT.version,
  "rollback-manifest": "0.4.10",
  "runtime-manifest": PRODUCT.version,
  "rust-headless": PRODUCT.version,
  "third-party-notices": PRODUCT.version,
  "tunnel-client": "0.0.12",
});
const TEXT_EXTENSIONS = new Set([
  ".bat", ".cjs", ".cmd", ".conf", ".cfg", ".crt", ".env", ".ini", ".js",
  ".json", ".md", ".mjs", ".ps1", ".sh", ".toml", ".ts", ".tsx", ".txt",
  ".xml", ".yaml", ".yml",
]);
const SECRET_PATTERNS = Object.freeze([
  ["private-key-block", /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----[\s\S]{80,}?-----END (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/],
  ["openai-token", /\bsk-(?:proj-)?[A-Za-z0-9_-]{24,}\b/],
  ["github-token", /\bgh[pousr]_[A-Za-z0-9]{24,}\b/],
  ["aws-access-key", /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/],
  ["slack-token", /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/],
]);

function fail(code, detail) {
  throw new Error(`${code}: ${detail}`);
}
function sortText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}
function plain(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
function digest(bytes) {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}
function readJson(filePath, code) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (error) {
    fail(code, `${filePath}: ${error instanceof Error ? error.message : String(error)}`);
  }
}
function safePath(value, code) {
  if (typeof value !== "string" || !value || value.includes("\\")
    || path.posix.isAbsolute(value) || path.posix.normalize(value) !== value
    || value.split("/").some((part) => !part || part === "." || part === "..")) {
    fail(code, JSON.stringify(value));
  }
  return value;
}
function regularFile(root, relativePath, code) {
  safePath(relativePath, `${code}_PATH_UNSAFE`);
  const absolutePath = path.join(root, ...relativePath.split("/"));
  let stat;
  try {
    stat = fs.lstatSync(absolutePath);
  } catch {
    fail(`${code}_MISSING`, absolutePath);
  }
  if (stat.isSymbolicLink()) fail(`${code}_SYMLINK_FORBIDDEN`, absolutePath);
  if (!stat.isFile()) fail(`${code}_NOT_FILE`, absolutePath);
  const canonicalRoot = fs.realpathSync(root);
  const canonicalFile = fs.realpathSync(absolutePath);
  if (canonicalFile !== canonicalRoot && !canonicalFile.startsWith(`${canonicalRoot}${path.sep}`)) {
    fail(`${code}_ESCAPES_ROOT`, absolutePath);
  }
  return { absolutePath, stat };
}
function walkFiles(root) {
  const result = [];
  const visit = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => sortText(a.name, b.name))) {
      const absolute = path.join(directory, entry.name);
      const relative = path.relative(root, absolute).split(path.sep).join("/");
      if (entry.isSymbolicLink()) fail("PACKAGE_SYMLINK_FORBIDDEN", absolute);
      if (entry.isDirectory()) visit(absolute);
      else if (entry.isFile()) result.push(relative);
      else fail("PACKAGE_ENTRY_UNSUPPORTED", absolute);
    }
  };
  visit(root);
  return result.sort(sortText);
}
function runtimeBundleId(files) {
  const hash = crypto.createHash("sha256");
  for (const file of files) {
    hash.update(file.path).update("\0").update(String(file.size)).update("\0")
      .update(file.sha256).update("\0");
  }
  return hash.digest("hex");
}

function validateRuntimeBundle(runtimeRoot) {
  const manifest = readJson(path.join(runtimeRoot, "manifest.json"), "PACKAGE_RUNTIME_MANIFEST_INVALID");
  if (!plain(manifest) || manifest.schemaVersion !== 2 || manifest.appVersion !== PRODUCT.version
    || manifest.platform !== PRODUCT.platform || manifest.arch !== PRODUCT.arch
    || manifest.launcher !== "bin/codex-chatgpt-web.cmd" || manifest.entrypoint !== "app/cli.js"
    || typeof manifest.bunVersion !== "string" || !manifest.bunVersion
    || typeof manifest.playwright !== "string" || !manifest.playwright
    || !SHA256.test(manifest.bundleId) || !Array.isArray(manifest.files) || !manifest.files.length) {
    fail("PACKAGE_RUNTIME_IDENTITY_MISMATCH", JSON.stringify(manifest));
  }
  let previous = null;
  const files = manifest.files.map((entry, index) => {
    if (!plain(entry) || !Number.isSafeInteger(entry.size) || entry.size < 0 || !SHA256.test(entry.sha256)) {
      fail("PACKAGE_RUNTIME_FILE_RECORD_INVALID", String(index));
    }
    const relative = safePath(entry.path, "PACKAGE_RUNTIME_FILE_PATH_UNSAFE");
    if (relative === "manifest.json") fail("PACKAGE_RUNTIME_MANIFEST_SELF_REFERENCE", relative);
    if (previous !== null && sortText(previous, relative) >= 0) {
      fail("PACKAGE_RUNTIME_FILES_NOT_SORTED_UNIQUE", relative);
    }
    previous = relative;
    return { path: relative, size: entry.size, sha256: entry.sha256 };
  });
  if (runtimeBundleId(files) !== manifest.bundleId) fail("PACKAGE_RUNTIME_BUNDLE_ID_MISMATCH", runtimeRoot);
  const expected = files.map((entry) => entry.path);
  const actual = walkFiles(runtimeRoot).filter((entry) => entry !== "manifest.json");
  if (JSON.stringify(expected) !== JSON.stringify(actual)) {
    fail("PACKAGE_RUNTIME_FILE_SET_MISMATCH", JSON.stringify({ expected, actual }));
  }
  for (const required of [
    "app/browser-helper.cjs", "app/cli.js", "bin/codex-chatgpt-web.cmd",
    "LICENSE", "runtime/bun.exe", "THIRD_PARTY_NOTICES.txt",
  ]) {
    if (!expected.includes(required)) fail("PACKAGE_RUNTIME_REQUIRED_FILE_MISSING", required);
  }
  if (!expected.some((entry) => entry.startsWith("LICENSES/"))) {
    fail("PACKAGE_RUNTIME_LICENSE_INVENTORY_MISSING", runtimeRoot);
  }
  for (const entry of files) {
    const current = regularFile(runtimeRoot, entry.path, "PACKAGE_RUNTIME_FILE");
    if (current.stat.size !== entry.size) fail("PACKAGE_RUNTIME_FILE_SIZE_MISMATCH", entry.path);
    if (digest(fs.readFileSync(current.absolutePath)) !== entry.sha256) {
      fail("PACKAGE_RUNTIME_FILE_CHECKSUM_MISMATCH", entry.path);
    }
  }
  const bun = fs.readFileSync(path.join(runtimeRoot, "runtime", "bun.exe"));
  if (bun.subarray(0, 2).toString("ascii") !== "MZ") fail("PACKAGE_RUNTIME_BUN_NOT_WINDOWS_EXECUTABLE", runtimeRoot);
  return { bundleId: manifest.bundleId, bunVersion: manifest.bunVersion, playwright: manifest.playwright, fileCount: files.length };
}

function validateComponentRecords(resourcesRoot, manifest) {
  if (!Array.isArray(manifest.components)) fail("PACKAGE_COMPONENTS_INVALID", "components must be an array");
  const requiredIds = Object.keys(REQUIRED_COMPONENTS).sort(sortText);
  const actualIds = [];
  let previous = null;
  for (const [index, component] of manifest.components.entries()) {
    if (!plain(component) || typeof component.id !== "string" || typeof component.version !== "string"
      || !Number.isSafeInteger(component.size) || component.size < 0 || !SHA256.test(component.sha256)) {
      fail("PACKAGE_COMPONENT_RECORD_INVALID", String(index));
    }
    if (previous !== null && sortText(previous, component.id) >= 0) fail("PACKAGE_COMPONENTS_NOT_SORTED_UNIQUE", component.id);
    previous = component.id;
    actualIds.push(component.id);
    const expectedPath = REQUIRED_COMPONENTS[component.id];
    if (!expectedPath) fail("PACKAGE_COMPONENT_UNEXPECTED", component.id);
    if (safePath(component.path, "PACKAGE_COMPONENT_PATH_UNSAFE") !== expectedPath) {
      fail("PACKAGE_COMPONENT_PATH_MISMATCH", component.id);
    }
    if (component.version !== COMPONENT_VERSIONS[component.id]) fail("PACKAGE_COMPONENT_VERSION_MISMATCH", component.id);
    const current = regularFile(resourcesRoot, expectedPath, "PACKAGE_COMPONENT");
    if (current.stat.size !== component.size) fail("PACKAGE_COMPONENT_SIZE_MISMATCH", component.id);
    if (digest(fs.readFileSync(current.absolutePath)) !== component.sha256) fail("PACKAGE_COMPONENT_CHECKSUM_MISMATCH", component.id);
    if (["rust-headless", "tunnel-client"].includes(component.id)
      && fs.readFileSync(current.absolutePath).subarray(0, 2).toString("ascii") !== "MZ") {
      fail("PACKAGE_COMPONENT_NOT_WINDOWS_EXECUTABLE", component.id);
    }
  }
  if (JSON.stringify(actualIds) !== JSON.stringify(requiredIds)) {
    fail("PACKAGE_COMPONENT_INVENTORY_MISMATCH", JSON.stringify({ requiredIds, actualIds }));
  }
  return actualIds;
}

function validateExpectedTunnelRelease(release) {
  if (!plain(release)
    || release.repository !== "openai/tunnel-client"
    || release.version !== "v0.0.12"
    || release.platform !== "windows/amd64"
    || release.archiveName !== "tunnel-client-v0.0.12-windows-amd64.zip"
    || !SHA256.test(release.archiveSha256)
    || release.licenseName !== "tunnel-client-v0.0.12-windows-amd64-licenses.txt"
    || !SHA256.test(release.licenseSha256)
    || release.spdxName !== "tunnel-client-v0.0.12-windows-amd64.spdx.json"
    || !SHA256.test(release.spdxSha256)
    || release.cloudflaredBinaryName !== "cloudflared.exe"
    || release.cloudflaredVersion !== "2026.7.2"
    || release.cloudflaredReleaseCommit !== "8679787525edc8575b2948a7c4a50b6292c6d426") {
    fail("PACKAGE_TUNNEL_EXPECTED_RELEASE_INVALID", JSON.stringify(release));
  }
  return release;
}

function validateTunnelSupplyChain(resourcesRoot, manifest, expectedRelease = OFFICIAL_TUNNEL_RELEASE) {
  const expected = validateExpectedTunnelRelease(expectedRelease);
  const tunnel = manifest?.supply_chain?.tunnel_client;
  if (!plain(tunnel) || tunnel.repository !== expected.repository || tunnel.version !== expected.version) {
    fail("PACKAGE_TUNNEL_SUPPLY_CHAIN_INVALID", JSON.stringify(tunnel ?? null));
  }
  const archive = tunnel.archive;
  if (!plain(archive) || archive.name !== expected.archiveName
    || archive.sha256 !== expected.archiveSha256 || !Array.isArray(archive.members)) {
    fail("PACKAGE_TUNNEL_ARCHIVE_IDENTITY_MISMATCH", JSON.stringify(archive ?? null));
  }

  const nativeRoot = path.join(resourcesRoot, "native");
  let nativeStat;
  try { nativeStat = fs.lstatSync(nativeRoot); }
  catch { fail("PACKAGE_TUNNEL_NATIVE_ROOT_MISSING", nativeRoot); }
  if (nativeStat.isSymbolicLink()) fail("PACKAGE_TUNNEL_NATIVE_ROOT_SYMLINK_FORBIDDEN", nativeRoot);
  if (!nativeStat.isDirectory()) fail("PACKAGE_TUNNEL_NATIVE_ROOT_INVALID", nativeRoot);

  const requiredNames = [...REQUIRED_TUNNEL_MEMBERS].sort(sortText);
  const memberRecords = [];
  let previous = null;
  for (const [index, record] of archive.members.entries()) {
    if (!plain(record) || typeof record.name !== "string"
      || !Number.isSafeInteger(record.size) || record.size < 0 || !SHA256.test(record.sha256)) {
      fail("PACKAGE_TUNNEL_MEMBER_RECORD_INVALID", String(index));
    }
    const name = safePath(record.name, "PACKAGE_TUNNEL_MEMBER_PATH_UNSAFE");
    if (name.includes("/")) fail("PACKAGE_TUNNEL_MEMBER_PATH_UNSAFE", name);
    if (previous !== null && sortText(previous, name) >= 0) {
      fail("PACKAGE_TUNNEL_MEMBERS_NOT_SORTED_UNIQUE", name);
    }
    previous = name;
    memberRecords.push({ name, size: record.size, sha256: record.sha256 });
  }
  const memberNames = memberRecords.map((entry) => entry.name);
  if (JSON.stringify(memberNames) !== JSON.stringify(requiredNames)) {
    fail("PACKAGE_TUNNEL_MEMBER_INVENTORY_MISMATCH", JSON.stringify({ requiredNames, memberNames }));
  }
  const actualNativeFiles = walkFiles(nativeRoot);
  if (JSON.stringify(actualNativeFiles) !== JSON.stringify(requiredNames)) {
    fail("PACKAGE_TUNNEL_NATIVE_FILE_SET_MISMATCH", JSON.stringify({ requiredNames, actualNativeFiles }));
  }

  const byName = new Map();
  for (const record of memberRecords) {
    const current = regularFile(nativeRoot, record.name, "PACKAGE_TUNNEL_MEMBER");
    if (current.stat.size !== record.size) fail("PACKAGE_TUNNEL_MEMBER_SIZE_MISMATCH", record.name);
    const currentDigest = digest(fs.readFileSync(current.absolutePath));
    if (currentDigest !== record.sha256) fail("PACKAGE_TUNNEL_MEMBER_CHECKSUM_MISMATCH", record.name);
    byName.set(record.name, record);
  }
  for (const executable of ["tunnel-client.exe", expected.cloudflaredBinaryName]) {
    const current = regularFile(nativeRoot, executable, "PACKAGE_TUNNEL_EXECUTABLE");
    if (fs.readFileSync(current.absolutePath).subarray(0, 2).toString("ascii") !== "MZ") {
      fail("PACKAGE_TUNNEL_MEMBER_NOT_WINDOWS_EXECUTABLE", executable);
    }
  }

  const cloudflared = tunnel.cloudflared;
  const cloudflaredRecord = byName.get(expected.cloudflaredBinaryName);
  const cloudflaredManifestRecord = byName.get("cloudflared-manifest.json");
  if (!plain(cloudflared)
    || cloudflared.binaryName !== expected.cloudflaredBinaryName
    || cloudflared.binarySha256 !== cloudflaredRecord.sha256
    || cloudflared.manifestSha256 !== cloudflaredManifestRecord.sha256
    || cloudflared.version !== expected.cloudflaredVersion
    || cloudflared.releaseCommit !== expected.cloudflaredReleaseCommit) {
    fail("PACKAGE_TUNNEL_CLOUDFLARED_METADATA_MISMATCH", JSON.stringify(cloudflared ?? null));
  }
  const cloudflaredManifest = readJson(
    path.join(nativeRoot, "cloudflared-manifest.json"),
    "PACKAGE_TUNNEL_CLOUDFLARED_MANIFEST_INVALID",
  );
  if (!plain(cloudflaredManifest)
    || cloudflaredManifest.version !== expected.cloudflaredVersion
    || cloudflaredManifest.release_commit !== expected.cloudflaredReleaseCommit
    || !Array.isArray(cloudflaredManifest.platforms)
    || !cloudflaredManifest.platforms.includes(expected.platform)) {
    fail("PACKAGE_TUNNEL_CLOUDFLARED_IDENTITY_MISMATCH", JSON.stringify(cloudflaredManifest));
  }

  const licenseReport = tunnel.license_report;
  const licenseRecord = byName.get(expected.licenseName);
  if (!plain(licenseReport) || licenseReport.name !== expected.licenseName
    || licenseReport.sha256 !== expected.licenseSha256
    || licenseRecord.sha256 !== expected.licenseSha256) {
    fail("PACKAGE_TUNNEL_LICENSE_REPORT_MISMATCH", JSON.stringify(licenseReport ?? null));
  }
  const spdxMetadata = tunnel.spdx;
  const spdxRecord = byName.get(expected.spdxName);
  if (!plain(spdxMetadata) || spdxMetadata.name !== expected.spdxName
    || spdxMetadata.sha256 !== expected.spdxSha256
    || spdxRecord.sha256 !== expected.spdxSha256) {
    fail("PACKAGE_TUNNEL_SPDX_MISMATCH", JSON.stringify(spdxMetadata ?? null));
  }
  const spdx = readJson(path.join(nativeRoot, expected.spdxName), "PACKAGE_TUNNEL_SPDX_INVALID");
  if (!plain(spdx) || spdx.spdxVersion !== "SPDX-2.3") {
    fail("PACKAGE_TUNNEL_SPDX_INVALID", String(spdx?.spdxVersion));
  }

  return {
    archiveName: archive.name,
    archiveSha256: archive.sha256,
    memberCount: memberRecords.length,
    cloudflaredVersion: cloudflared.version,
    cloudflaredReleaseCommit: cloudflared.releaseCommit,
  };
}

function validateMigrationRollback(resourcesRoot) {
  const migration = readJson(path.join(resourcesRoot, REQUIRED_COMPONENTS["migration-manifest"]), "PACKAGE_MIGRATION_MANIFEST_INVALID");
  if (!plain(migration) || migration.schema !== 1 || migration.sourceVersion !== "0.4.10"
    || migration.targetVersion !== PRODUCT.version) fail("PACKAGE_MIGRATION_IDENTITY_MISMATCH", JSON.stringify(migration));
  const rollback = readJson(path.join(resourcesRoot, REQUIRED_COMPONENTS["rollback-manifest"]), "PACKAGE_ROLLBACK_MANIFEST_INVALID");
  if (!plain(rollback) || rollback.schema !== 1 || rollback.stableVersion !== "0.4.10"
    || !["reference", "bundled"].includes(rollback.mode)) fail("PACKAGE_ROLLBACK_IDENTITY_MISMATCH", JSON.stringify(rollback));
  if (rollback.mode === "reference") {
    if (rollback.releaseTag !== STABLE_ROLLBACK.releaseTag
      || rollback.assetName !== STABLE_ROLLBACK.assetName
      || rollback.size !== STABLE_ROLLBACK.size
      || rollback.sha256 !== STABLE_ROLLBACK.sha256) {
      fail("PACKAGE_ROLLBACK_REFERENCE_INVALID", JSON.stringify({
        releaseTag: rollback.releaseTag,
        assetName: rollback.assetName,
        size: rollback.size,
        sha256: rollback.sha256,
      }));
    }
  } else {
    const asset = safePath(rollback.asset, "PACKAGE_ROLLBACK_ASSET_PATH_UNSAFE");
    const current = regularFile(path.join(resourcesRoot, "rollback"), asset, "PACKAGE_ROLLBACK_ASSET");
    if (!SHA256.test(rollback.sha256) || !Number.isSafeInteger(rollback.size) || rollback.size < 1
      || current.stat.size !== rollback.size || digest(fs.readFileSync(current.absolutePath)) !== rollback.sha256) {
      fail("PACKAGE_ROLLBACK_ASSET_MISMATCH", asset);
    }
  }
}

function envTemplateName(base) {
  return /^\.env(?:\.[a-z0-9._-]+)*\.(?:example|sample|template)$/i.test(base);
}

function forbiddenName(relative) {
  const base = path.posix.basename(relative).toLowerCase();
  const extension = path.posix.extname(base);
  // Bundled Paseo/Anneal/CommandCode ship .env.example for first-run setup.
  // Those templates are not secrets; live .env / .env.production still fail closed.
  if (base.startsWith(".env") && !envTemplateName(base)) return "environment-file";
  if (["id_rsa", "id_ecdsa", "id_ed25519", "credentials.json", "secrets.json", "token.json", "service-account.json"].includes(base)) {
    return "credential-file-name";
  }
  if ([".key", ".pem", ".p12", ".pfx", ".jks", ".kdbx"].includes(extension)) return "credential-file-extension";
  return null;
}
function bundledRuntimeVendorPath(relative) {
  const normalized = String(relative).replaceAll("\\", "/");
  const markers = [
    "bundled-runtimes/codex-router/source/",
    "five-stack-runtime/",
  ];
  for (const marker of markers) {
    const index = normalized.indexOf(marker);
    if (index < 0) continue;
    const parts = normalized.slice(index + marker.length).split("/");
    if (parts.includes("node_modules") || parts.includes(".venv")) return true;
  }
  return false;
}
function bundledRouterVendorPath(relative) {
  return bundledRuntimeVendorPath(relative);
}
function bundledUpstreamSourcePath(relative) {
  const normalized = String(relative).replaceAll("\\", "/");
  return [
    "five-stack-runtime/",
    "bundled-components/",
    "vendor/bundled/",
    "bundled-runtimes/",
  ].some((marker) => normalized.includes(marker));
}
function secretIn(bytes) {
  if (bytes.length > MAX_TEXT_BYTES || bytes.includes(0)) return null;
  const text = bytes.toString("utf8");
  for (const [rule, pattern] of SECRET_PATTERNS) if (pattern.test(text)) return rule;
  return null;
}
function scanEntries(entries, read) {
  const findings = [];
  for (const relative of entries) {
    if (bundledRuntimeVendorPath(relative)) continue;
    const nameRule = forbiddenName(relative);
    if (nameRule) findings.push({ path: relative, rule: nameRule });
    if (bundledUpstreamSourcePath(relative)) continue;
    const base = path.posix.basename(relative).toLowerCase();
    if (!base.startsWith(".env") && !TEXT_EXTENSIONS.has(path.posix.extname(base))) continue;
    let bytes;
    try { bytes = read(relative); } catch { continue; }
    const contentRule = secretIn(Buffer.from(bytes));
    if (contentRule) findings.push({ path: relative, rule: contentRule });
  }
  return findings;
}
function asarApi() {
  let resolved;
  try { resolved = require.resolve("@electron/asar", { paths: [desktopRoot] }); }
  catch { fail("PACKAGE_ASAR_READER_UNAVAILABLE", "@electron/asar is required"); }
  const api = require(resolved);
  if (typeof api.extractFile !== "function" || typeof api.listPackage !== "function") fail("PACKAGE_ASAR_READER_INVALID", resolved);
  return api;
}
function asarManifest(asarPath) {
  try { return JSON.parse(Buffer.from(asarApi().extractFile(asarPath, "package.json")).toString("utf8")); }
  catch (error) { fail("PACKAGE_ASAR_MANIFEST_INVALID", error instanceof Error ? error.message : String(error)); }
}
function normalizeAsarEntries(entries) {
  const normalized = entries.map((entry) => String(entry).replaceAll("\\", "/").replace(/^\/+/, ""))
    .filter(Boolean).sort(sortText);
  for (let index = 1; index < normalized.length; index += 1) {
    if (normalized[index] === normalized[index - 1]) fail("PACKAGE_ASAR_ENTRIES_NOT_UNIQUE", normalized[index]);
  }
  return normalized;
}
function listAsarEntries(asarPath) {
  return normalizeAsarEntries(asarApi().listPackage(asarPath));
}
function validateAsarIntegration(entries) {
  const set = new Set(normalizeAsarEntries(entries));
  for (const required of REQUIRED_ASAR_FILES) {
    if (!set.has(required)) fail("PACKAGE_ASAR_REQUIRED_FILE_MISSING", required);
  }
}
function scanAsar(asarPath, entries) {
  const api = asarApi();
  return scanEntries(entries, (entry) => api.extractFile(asarPath, entry))
    .map((finding) => ({ ...finding, path: `app.asar/${finding.path}` }));
}

function validatePackageManifest(resourcesRoot, appManifest, options = {}) {
  if (!plain(appManifest) || appManifest.name !== PRODUCT.packageName || appManifest.version !== PRODUCT.version) {
    fail("PACKAGE_APP_IDENTITY_MISMATCH", JSON.stringify({ name: appManifest?.name, version: appManifest?.version }));
  }
  const manifest = readJson(path.join(resourcesRoot, "coding-tools", "package-manifest.json"), "PACKAGE_MANIFEST_INVALID");
  const expectedSource = options.expectedSourceSha?.toLowerCase();
  if (!plain(manifest) || manifest.schema !== 1 || manifest.product?.name !== PRODUCT.name
    || manifest.product?.version !== PRODUCT.version || manifest.product?.app_id !== PRODUCT.appId
    || manifest.product?.platform !== PRODUCT.platform || manifest.product?.arch !== PRODUCT.arch
    || manifest.product?.installer?.kind !== "nsis" || manifest.product?.installer?.scope !== "current-user"
    || manifest.product?.installer?.allow_elevation !== false || manifest.source?.repository !== SOURCE_REPOSITORY
    || !SOURCE_SHA.test(manifest.source?.sha) || (expectedSource && manifest.source.sha !== expectedSource)
    || manifest.upstream?.repository !== UPSTREAM.repository || manifest.upstream?.version !== UPSTREAM.version
    || manifest.upstream?.commit !== UPSTREAM.commit) {
    fail("PACKAGE_MANIFEST_IDENTITY_MISMATCH", JSON.stringify({ product: manifest?.product, source: manifest?.source, upstream: manifest?.upstream }));
  }
  const componentIds = validateComponentRecords(resourcesRoot, manifest);
  let tunnelSupplyChain = null;
  if (manifest.supply_chain !== undefined || options.appManifest === undefined) {
    tunnelSupplyChain = validateTunnelSupplyChain(
      resourcesRoot,
      manifest,
      options.expectedTunnelRelease || OFFICIAL_TUNNEL_RELEASE,
    );
  }
  const runtime = validateRuntimeBundle(path.join(resourcesRoot, "runtime"));
  validateMigrationRollback(resourcesRoot);
  const notices = fs.readFileSync(path.join(resourcesRoot, REQUIRED_COMPONENTS["third-party-notices"]), "utf8");
  for (const marker of ["codex-chatgpt-web", "MIT", "Apache-2.0"]) {
    if (!notices.includes(marker)) fail("PACKAGE_NOTICES_INCOMPLETE", marker);
  }
  return { componentIds, runtime, sourceSha: manifest.source.sha, tunnelSupplyChain };
}

function inspectExtractedApplication(appRoot, options = {}) {
  const root = path.resolve(appRoot);
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) fail("PACKAGE_APP_ROOT_INVALID", root);
  const launcher = regularFile(root, `${PRODUCT.name}.exe`, "PACKAGE_LAUNCHER");
  if (fs.readFileSync(launcher.absolutePath).subarray(0, 2).toString("ascii") !== "MZ") fail("PACKAGE_LAUNCHER_NOT_WINDOWS_EXECUTABLE", launcher.absolutePath);
  const resources = path.join(root, "resources");
  if (!fs.existsSync(resources) || !fs.statSync(resources).isDirectory()) fail("PACKAGE_RESOURCES_MISSING", resources);
  for (const relative of REQUIRED_MODULE_FILES) {
    regularFile(resources, relative, "PACKAGE_MODULES_HOST");
    regularFile(resources, relative.replace(/^modules\//, "app-modules/"), "PACKAGE_APP_MODULES_HOST");
  }
  const asarPath = path.join(resources, "app.asar");
  const appManifest = options.appManifest ?? asarManifest(asarPath);
  const asarEntries = options.asarEntries ? normalizeAsarEntries(options.asarEntries) : listAsarEntries(asarPath);
  validateAsarIntegration(asarEntries);
  const validated = validatePackageManifest(resources, appManifest, options);
  const findings = scanEntries(walkFiles(root), (relative) => fs.readFileSync(path.join(root, ...relative.split("/"))));
  if (!options.appManifest) findings.push(...scanAsar(asarPath, asarEntries));
  if (findings.length) fail("PACKAGE_SECRET_MATERIAL_FOUND", JSON.stringify(findings));
  return { ok: true, productVersion: PRODUCT.version, appId: PRODUCT.appId, sourceSha: validated.sourceSha,
    componentIds: validated.componentIds, runtime: validated.runtime,
    tunnelSupplyChain: validated.tunnelSupplyChain, secretsFound: [] };
}

function installerName(name) {
  return name === `Coding.Tools_${PRODUCT.version}_win_x64.exe`
    || name === `Coding.Tools_${PRODUCT.version}_windows_x64_setup.exe`;
}
function findWindowsInstaller(inputPath) {
  const input = path.resolve(inputPath);
  if (!fs.existsSync(input)) fail("PACKAGE_INPUT_MISSING", input);
  if (fs.statSync(input).isFile()) {
    if (!installerName(path.basename(input))) fail("PACKAGE_INSTALLER_NAME_MISMATCH", path.basename(input));
    return input;
  }
  if (!fs.statSync(input).isDirectory()) fail("PACKAGE_INPUT_INVALID", input);
  const matches = fs.readdirSync(input, { withFileTypes: true }).filter((entry) => entry.isFile() && installerName(entry.name))
    .map((entry) => path.join(input, entry.name)).sort(sortText);
  if (matches.length !== 1) fail("PACKAGE_INSTALLER_COUNT_MISMATCH", matches.map((entry) => path.basename(entry)).join(", ") || "none");
  return matches[0];
}
function sevenZip() {
  const candidates = [...new Set([process.env.SEVEN_ZIP, "7z", "7z.exe", "7zz"].filter(Boolean))];
  for (const candidate of candidates) {
    const probe = spawnSync(candidate, ["i"], { encoding: "utf8", windowsHide: true, timeout: 15_000 });
    if (!probe.error && probe.status === 0) return candidate;
  }
  fail("PACKAGE_7ZIP_UNAVAILABLE", candidates.join(", "));
}
function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, env: process.env, encoding: "utf8", windowsHide: true,
    timeout: 180_000, maxBuffer: 16 * 1024 * 1024 });
  if (result.error || result.status !== 0) fail("PACKAGE_COMMAND_FAILED", `${command}: ${result.error?.message || result.stderr?.trim() || result.stdout?.trim() || result.status}`);
}
function retainedRoot() {
  const configured = process.env.CODING_TOOLS_RETENTION_ROOT
    ? path.resolve(process.env.CODING_TOOLS_RETENTION_ROOT)
    : path.join(aiTempRoot, "Trash", "package-verifier");
  const relative = path.relative(aiTempRoot, configured);
  if (relative.startsWith("..") || path.isAbsolute(relative)) fail("PACKAGE_RETENTION_ROOT_OUTSIDE_AITEMP", configured);
  fs.mkdirSync(configured, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const session = path.join(configured, `${stamp}-${process.pid}-${crypto.randomBytes(4).toString("hex")}`);
  fs.mkdirSync(session);
  return session;
}
function extract(archive, destination, command) {
  fs.mkdirSync(destination, { recursive: true });
  run(command, ["x", "-y", "-bd", "-bb0", `-o${destination}`, archive], path.dirname(archive));
}
function oneMatch(root, pattern, code, transform = (entry) => entry) {
  const matches = walkFiles(root).filter((entry) => pattern.test(entry))
    .map((entry) => transform(path.join(root, ...entry.split("/"))));
  const unique = [...new Set(matches.map((entry) => path.resolve(entry)))];
  if (unique.length !== 1) fail(code, unique.join(", ") || "none");
  return unique[0];
}
function verifyPackage(inputPath, options = {}) {
  const input = path.resolve(inputPath);
  if (fs.existsSync(path.join(input, "resources"))) return inspectExtractedApplication(input, options);
  const installer = findWindowsInstaller(input);
  const bytes = fs.readFileSync(installer);
  if (bytes.length < (options.minimumInstallerBytes ?? 1024 * 1024)) fail("PACKAGE_INSTALLER_TOO_SMALL", String(bytes.length));
  if (bytes.subarray(0, 2).toString("ascii") !== "MZ") fail("PACKAGE_INSTALLER_NOT_WINDOWS_EXECUTABLE", installer);
  const evidence = retainedRoot();
  const outer = path.join(evidence, "installer");
  const application = path.join(evidence, "application");
  const command = sevenZip();
  extract(installer, outer, command);
  const appArchive = oneMatch(outer, /(?:^|\/)app-64\.7z$/i, "PACKAGE_APP_ARCHIVE_COUNT_MISMATCH");
  extract(appArchive, application, command);
  const appRoot = oneMatch(application, /(?:^|\/)resources\/app\.asar$/i, "PACKAGE_EXTRACTED_APP_COUNT_MISMATCH",
    (entry) => path.dirname(path.dirname(entry)));
  return { ...inspectExtractedApplication(appRoot, options),
    installer: { name: path.basename(installer), size: bytes.length, sha256: digest(bytes) },
    retainedEvidenceRoot: evidence };
}

function parseArguments(argv) {
  const args = [...argv];
  const input = args.shift();
  if (!input) fail("PACKAGE_USAGE", "node verify-package.cjs <root-or-installer> [--source <sha>] [--json-out <aiTemp path>]");
  const options = {};
  while (args.length) {
    const flag = args.shift();
    const value = args.shift();
    if (!value) fail("PACKAGE_USAGE", `${flag} requires a value`);
    if (flag === "--source") options.expectedSourceSha = value.toLowerCase();
    else if (flag === "--json-out") options.jsonOut = value;
    else fail("PACKAGE_USAGE", `unknown option ${flag}`);
  }
  if (!options.expectedSourceSha) options.expectedSourceSha = (process.env.SOURCE_SHA || process.env.GITHUB_SHA || "").toLowerCase() || undefined;
  if (options.expectedSourceSha && !SOURCE_SHA.test(options.expectedSourceSha)) fail("PACKAGE_SOURCE_SHA_INVALID", options.expectedSourceSha);
  return { input, options };
}
function writeEvidence(filePath, value) {
  const absolute = path.resolve(filePath);
  const relative = path.relative(aiTempRoot, absolute);
  if (relative.startsWith("..") || path.isAbsolute(relative)) fail("PACKAGE_EVIDENCE_PATH_OUTSIDE_AITEMP", absolute);
  fs.mkdirSync(path.dirname(absolute), { recursive: true });
  fs.writeFileSync(absolute, `${JSON.stringify(value, null, 2)}\n`);
}

if (require.main === module) {
  try {
    const { input, options } = parseArguments(process.argv.slice(2));
    const result = verifyPackage(input, options);
    if (options.jsonOut) writeEvidence(options.jsonOut, result);
    process.stdout.write(`PACKAGE_VERIFICATION_PASS ${JSON.stringify({
      productVersion: result.productVersion, sourceSha: result.sourceSha,
      componentIds: result.componentIds, runtimeBundleId: result.runtime.bundleId,
      tunnelArchiveSha256: result.tunnelSupplyChain?.archiveSha256,
      installer: result.installer, retainedEvidenceRoot: result.retainedEvidenceRoot,
    })}\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}

module.exports = {
  OFFICIAL_TUNNEL_RELEASE,
  PRODUCT,
  REQUIRED_ASAR_FILES,
  REQUIRED_MODULE_FILES,
  REQUIRED_COMPONENTS,
  REQUIRED_TUNNEL_MEMBERS,
  bundledRouterVendorPath,
  bundledRuntimeVendorPath,
  bundledUpstreamSourcePath,
  findWindowsInstaller,
  forbiddenName,
  inspectExtractedApplication,
  validatePackageManifest,
  validateRuntimeBundle,
  validateTunnelSupplyChain,
  verifyPackage,
};
