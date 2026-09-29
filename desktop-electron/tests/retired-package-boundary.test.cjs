"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const projectRoot = path.resolve(__dirname, "../..");
const desktopRoot = path.join(projectRoot, "desktop-electron");
const { COMPONENT_IDS } = require("../scripts/prepare-five-stack-runtime.cjs");
const { BUNDLED_IDS } = require("../scripts/vendor-upstream-bundles.cjs");
const { resolveFiveStackRuntimeRoot, validateCpaRuntime } = require("../scripts/prepare-package-resources.cjs");
const { REQUIRED_ASAR_FILES, REQUIRED_MODULE_FILES, retiredPackagePath, validateCpaPlugins } = require("../scripts/verify-package.cjs");

test("upstream actions load without excluded Paseo files and still reject retired integrations", async () => {
  const fixtureRoot = path.join(projectRoot, "aiTemp", "retired-package-boundary-tests", crypto.randomUUID());
  fs.mkdirSync(fixtureRoot, { recursive: true });
  const isolatedModule = path.join(fixtureRoot, "upstream-actions.cjs");
  fs.copyFileSync(path.join(desktopRoot, "electron", "upstream-actions.cjs"), isolatedModule);
  const { actUpstream } = require(isolatedModule);
  for (const toolId of ["paseo", "anneal", "codex-router", "commandcode-proxy"]) {
    await assert.rejects(actUpstream({ toolId }), /Retired upstream integration/);
  }
});

test("package inputs keep CPA plugins and AO/CPA handlers without retired standalone assets", () => {
  const build = require("../package.json").build;
  assert.deepEqual(COMPONENT_IDS, ["cpa"]);
  assert.deepEqual(BUNDLED_IDS, []);
  assert.ok(build.files.includes("vendor/bundled/cpa-plugins/**"));
  for (const glob of ["vendor/upstream/**", "vendor/managed-components/**", "vendor/bundled/**"]) {
    assert.ok(!build.files.includes(glob), glob);
  }
  for (const copy of [...build.files.filter((entry) => typeof entry === "object"), ...build.extraResources.filter((entry) => entry.from === "../app-handler" || entry.from === "../modules")]) {
    for (const id of ["paseo", "anneal", "codex-router", "commandcode-proxy"]) {
      assert.ok(copy.filter.includes(`!${id}/**`), `${copy.to}: ${id}`);
    }
  }
  for (const required of [REQUIRED_ASAR_FILES, REQUIRED_MODULE_FILES]) {
    assert.ok(required.includes("app-handler/agent-orchestrator/handler.cjs"));
    assert.ok(required.includes("app-handler/cpa/handler.cjs"));
    assert.ok(required.every((entry) => !retiredPackagePath(entry)));
  }
  for (const path of [
    "app-handler/paseo/handler.cjs",
    "app-modules/anneal/handler.cjs",
    "modules/codex-router/handler.cjs",
    "vendor/bundled/commandcode-proxy/proxy.mjs",
    "vendor/managed-components/paseo.json",
    "electron/paseo-provider-routes.cjs",
    "five-stack-runtime/anneal/source/index.js",
  ]) assert.equal(retiredPackagePath(path), true, path);
  assert.equal(retiredPackagePath("vendor/bundled/cpa-plugins/windows/amd64/commandcode-go.dll"), false);
  assert.equal(retiredPackagePath("app-handler/agent-orchestrator/handler.cjs"), false);
});

test("cached five-stack runtime must be CPA only before resource staging", () => {
  const root = path.join(projectRoot, "aiTemp", "retired-package-boundary-tests", `${process.pid}-${crypto.randomUUID()}`);
  const runtime = path.join(root, "runtime");
  fs.mkdirSync(path.join(runtime, "cpa"), { recursive: true });
  const payload = Buffer.from("cpa release payload");
  const sha256 = crypto.createHash("sha256").update(payload).digest("hex");
  const component = { id: "cpa", fileName: "cpa.zip", sha256 };
  const manifest = { schemaVersion: 1, platform: "win32", arch: "x64", components: [component] };
  fs.writeFileSync(path.join(runtime, "MANIFEST.json"), JSON.stringify(manifest));
  fs.writeFileSync(path.join(runtime, "cpa", "BUNDLE.json"), JSON.stringify(component));
  fs.writeFileSync(path.join(runtime, "cpa", "cpa.zip"), payload);
  const pinned = path.join(root, "vendor", "managed-components", "cpa.json");
  fs.mkdirSync(path.dirname(pinned), { recursive: true });
  fs.writeFileSync(pinned, JSON.stringify({ id: "cpa", platforms: { win32: { x64: { sha256 } } } }));
  assert.equal(resolveFiveStackRuntimeRoot({ desktopRoot: root, explicit: runtime, required: true, platform: "win32", arch: "x64" }), runtime);
  const wrongPayload = Buffer.from("wrong CPA release payload");
  const wrongSha256 = crypto.createHash("sha256").update(wrongPayload).digest("hex");
  fs.writeFileSync(path.join(runtime, "cpa", "cpa.zip"), wrongPayload);
  fs.writeFileSync(path.join(runtime, "cpa", "BUNDLE.json"), JSON.stringify({ ...component, sha256: wrongSha256 }));
  fs.writeFileSync(path.join(runtime, "MANIFEST.json"), JSON.stringify({ ...manifest, components: [{ ...component, sha256: wrongSha256 }] }));
  assert.throws(() => resolveFiveStackRuntimeRoot({ desktopRoot: root, explicit: runtime, required: true, platform: "win32", arch: "x64" }), /PACKAGE_RESOURCE_CPA_RUNTIME_INVALID/);
  assert.equal(fs.existsSync(path.join(root, "build", "package-resources")), false);
  fs.writeFileSync(path.join(runtime, "cpa", "cpa.zip"), payload);
  fs.writeFileSync(path.join(runtime, "cpa", "BUNDLE.json"), JSON.stringify(component));
  fs.writeFileSync(path.join(runtime, "MANIFEST.json"), JSON.stringify(manifest));
  assert.equal(validateCpaRuntime(runtime, "win32", "x64").sha256, sha256);
  fs.renameSync(path.join(runtime, "cpa", "cpa.zip"), path.join(root, "cpa.zip.backup"));
  assert.throws(() => resolveFiveStackRuntimeRoot({ desktopRoot: root, explicit: runtime, required: true, platform: "win32", arch: "x64" }), /PACKAGE_RESOURCE_CPA_RUNTIME/);
  fs.renameSync(path.join(root, "cpa.zip.backup"), path.join(runtime, "cpa", "cpa.zip"));
  fs.renameSync(path.join(runtime, "cpa"), path.join(root, "cpa.backup"));
  assert.throws(() => resolveFiveStackRuntimeRoot({ desktopRoot: root, explicit: runtime, required: true, platform: "win32", arch: "x64" }), /PACKAGE_RESOURCE_INPUT_MISSING/);
  fs.renameSync(path.join(root, "cpa.backup"), path.join(runtime, "cpa"));
  fs.mkdirSync(path.join(runtime, "paseo"));
  assert.throws(() => resolveFiveStackRuntimeRoot({ desktopRoot: root, explicit: runtime, required: true, platform: "win32", arch: "x64" }), /PACKAGE_RESOURCE_FIVE_STACK_RUNTIME_RETIRED/);
  fs.renameSync(path.join(runtime, "paseo"), path.join(runtime, "ignored"));
  fs.writeFileSync(path.join(runtime, "MANIFEST.json"), JSON.stringify({ ...manifest, components: [{ id: "cpa" }, { id: "anneal" }] }));
  assert.throws(() => resolveFiveStackRuntimeRoot({ desktopRoot: root, explicit: runtime, required: true, platform: "win32", arch: "x64" }), /PACKAGE_RESOURCE_FIVE_STACK_RUNTIME_RETIRED/);
});

test("packaged CPA Go and Studio OAuth DLLs match the bundled manifest", () => {
  const root = path.join(projectRoot, "aiTemp", "retired-package-boundary-tests", `${process.pid}-${crypto.randomUUID()}`);
  const pluginRoot = path.join(root, "app.asar.unpacked", "vendor", "bundled", "cpa-plugins");
  const entries = [
    ["platforms", "go.dll", Buffer.from("MZgo")],
    ["studio", "studio.dll", Buffer.from("MZstudio")],
  ];
  const manifest = { id: "commandcode-go", studio: { id: "auth-commandcode", platforms: {} }, platforms: {} };
  for (const [section, name, bytes] of entries) {
    const record = {
      path: `windows/amd64/${name}`,
      sha256: crypto.createHash("sha256").update(bytes).digest("hex"),
      size: bytes.length,
    };
    if (section === "studio") manifest.studio.platforms["win32/x64"] = record;
    else manifest.platforms["win32/x64"] = record;
    const destination = path.join(pluginRoot, ...record.path.split("/"));
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.writeFileSync(destination, bytes);
  }
  fs.writeFileSync(path.join(pluginRoot, "BUNDLE.json"), JSON.stringify(manifest));
  assert.equal(validateCpaPlugins(root, manifest).length, 2);
  const studio = path.join(pluginRoot, "windows", "amd64", "studio.dll");
  fs.renameSync(studio, path.join(root, "studio.dll.backup"));
  assert.throws(() => validateCpaPlugins(root, manifest), /PACKAGE_CPA_PLUGIN/);
  fs.renameSync(path.join(root, "studio.dll.backup"), studio);
  fs.writeFileSync(studio, Buffer.from("MZtampered"));
  assert.throws(() => validateCpaPlugins(root, manifest), /PACKAGE_CPA_PLUGIN_CHECKSUM_MISMATCH/);
});
