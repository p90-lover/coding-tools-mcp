"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const {
  binWrapperPaths,
  ensureBinWrappers,
  isAiTempPath,
  resolveLiveComponentHome,
  wrapperFileTargets,
  wrapperLooksStale,
  wrappers,
} = require("../electron/codex-router-managed.cjs");

function temporaryDirectory(name) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `${name}-`));
}

function writeFile(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, value);
}

function seedRouterHome(home) {
  writeFile(path.join(home, "package.json"), `${JSON.stringify({
    name: "codex-model-router",
    version: "0.6.0",
  })}\n`);
  writeFile(path.join(home, "CODING_TOOLS_BUNDLED.json"), `${JSON.stringify({
    schemaVersion: 1,
    id: "codex-router",
    version: "0.6.0",
  })}\n`);
  writeFile(path.join(home, "codex-router.ps1"), "Write-Output 'router'\n");
  writeFile(path.join(home, "src", "curate-models.mjs"), "export {};\n");
  writeFile(path.join(home, "bin", "model-router"), "#!/usr/bin/env bash\n");
}

test("aiTemp path detection is segment-based and case-insensitive", () => {
  assert.equal(isAiTempPath("/data/aiTemp/managed-components/x"), true);
  assert.equal(isAiTempPath("C:\\Users\\simon\\AppData\\Roaming\\Coding Tools\\aiTemp\\managed-components\\x"), true);
  assert.equal(isAiTempPath("C:/Users/simon/AppData/Roaming/Coding Tools/aiTemp/managed-components/x"), true);
  assert.equal(isAiTempPath("/data/components/codex-router/0.6.0"), false);
  assert.equal(isAiTempPath("/data/waitemp/nope"), false);
});

test("ensureBinWrappers retargets stale Windows cmds from wiped aiTemp to live component home", () => {
  const dataRoot = temporaryDirectory("coding-tools-router-wrappers");
  const stateDir = path.join(dataRoot, "state", "codex-router");
  const liveHome = path.join(dataRoot, "components", "codex-router", "0.6.0");
  const stagingHome = path.join(
    dataRoot,
    "aiTemp",
    "managed-components",
    "codex-router-2026-09-18T03-00-00.000Z",
    "component",
  );
  seedRouterHome(liveHome);
  seedRouterHome(stagingHome);

  const stalePs1 = path.join(stagingHome, "codex-router.ps1");
  const staleCmd = path.join(stateDir, "bin", "model-router.cmd");
  writeFile(staleCmd, [
    "@echo off",
    "setlocal",
    `powershell.exe -NoProfile -ExecutionPolicy Bypass -File "${stalePs1}" %*`,
    "",
  ].join("\r\n"));
  writeFile(path.join(stateDir, "bin", "curate-models.cmd"), [
    "@echo off",
    `node "${path.join(stagingHome, "src", "curate-models.mjs")}" %*`,
    "",
  ].join("\r\n"));

  assert.equal(wrapperLooksStale(staleCmd, liveHome), true);
  assert.deepEqual(wrapperFileTargets(fs.readFileSync(staleCmd, "utf8")), [stalePs1]);
  assert.equal(resolveLiveComponentHome(stagingHome, stateDir), liveHome);

  fs.rmSync(stagingHome, { recursive: true, force: true });
  assert.equal(fs.existsSync(stalePs1), false);

  const resolved = ensureBinWrappers(liveHome, stateDir, "win32");
  assert.equal(resolved, liveHome);

  const [routerCmd, curateCmd] = binWrapperPaths(stateDir, "win32");
  const routerText = fs.readFileSync(routerCmd, "utf8");
  const curateText = fs.readFileSync(curateCmd, "utf8");
  assert.match(routerText, /-File /);
  assert.match(routerText, /codex-router\.ps1/);
  assert.doesNotMatch(routerText, /aiTemp/i);
  assert.equal(routerText.includes(liveHome), true);
  assert.doesNotMatch(curateText, /aiTemp/i);
  assert.match(curateText, /curate-models\.mjs/);
  assert.equal(wrapperLooksStale(routerCmd, liveHome), false);
  assert.deepEqual(
    wrapperFileTargets(routerText).map((value) => path.resolve(value)),
    [path.resolve(liveHome, "codex-router.ps1")],
  );
});

test("ensureBinWrappers maps a staging home onto the live component path before writing wrappers", () => {
  const dataRoot = temporaryDirectory("coding-tools-router-staging-wrappers");
  const stateDir = path.join(dataRoot, "state", "codex-router");
  const liveHome = path.join(dataRoot, "components", "codex-router", "0.6.0");
  const stagingHome = path.join(
    dataRoot,
    "aiTemp",
    "managed-components",
    "codex-router-2026-09-18T04-00-00.000Z",
    "component",
  );
  seedRouterHome(stagingHome);

  const resolved = ensureBinWrappers(stagingHome, stateDir, "win32");
  assert.equal(resolved, liveHome);
  const routerText = fs.readFileSync(path.join(stateDir, "bin", "model-router.cmd"), "utf8");
  assert.doesNotMatch(routerText, /aiTemp/i);
  assert.equal(routerText.includes(liveHome), true);
});

test("run always rewrites wrappers before spawning foreground-start, and wrappers is exported", () => {
  const adapter = fs.readFileSync(path.join(__dirname, "..", "electron", "codex-router-managed.cjs"), "utf8");
  const runStart = adapter.indexOf("function run(home, state)");
  const spawnStart = adapter.indexOf("src/foreground-start.mjs", runStart);
  assert.ok(runStart >= 0 && spawnStart > runStart);
  const runBody = adapter.slice(runStart, spawnStart);
  assert.match(runBody, /ensureBinWrappers\(home, state\)/);
  assert.equal(typeof wrappers, "function");
  assert.equal(typeof ensureBinWrappers, "function");
  const prepareStart = adapter.indexOf("function finishPrepare(home, state)");
  const prepareBody = adapter.slice(prepareStart, adapter.indexOf("function prepareOfflineFromBundle", prepareStart));
  assert.match(prepareBody, /wrappers\(liveHome, state, environment\(liveHome, state\)\)/);
});
