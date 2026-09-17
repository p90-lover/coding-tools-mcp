"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.resolve(__dirname, "../..");
const workflowPath = path.join(
  root,
  ".github/workflows/codex-router-multiprovider-release-rc6-csc.yml",
);
const fixtureScriptPath = path.join(
  root,
  "desktop-electron/scripts/create-legacy-uninstall-fixture.ps1",
);
const workflow = fs.existsSync(workflowPath)
  ? fs.readFileSync(workflowPath, "utf8")
  : "";
const fixtureScript = fs.existsSync(fixtureScriptPath)
  ? fs.readFileSync(fixtureScriptPath, "utf8")
  : "";

test("rc.6 release delegates legacy fixture creation to a checked-in script", () => {
  assert.ok(workflow.length > 0, "CSC release workflow must exist");
  assert.match(workflow, /create-legacy-uninstall-fixture\.ps1/);
  assert.ok(fixtureScript.length > 0, "legacy fixture script must exist");
});

test("legacy fixture compilation avoids unsupported PowerShell Add-Type output kinds", () => {
  assert.doesNotMatch(
    workflow,
    /Add-Type[\s\S]*?-OutputType\s+(?:ConsoleApplication|WindowsApplication)/,
  );
  assert.doesNotMatch(
    fixtureScript,
    /Add-Type[\s\S]*?-OutputType\s+(?:ConsoleApplication|WindowsApplication)/,
  );
  assert.match(fixtureScript, /csc\.exe/i);
  assert.match(fixtureScript, /\/target:exe/i);
  assert.match(fixtureScript, /\/out:/i);
});

test("fixture creation remains retained-data safe and race tolerant", () => {
  assert.match(fixtureScript, /aiTemp|RootPath/);
  assert.match(fixtureScript, /TrashPath/);
  assert.match(fixtureScript, /LEGACY_FIXTURE_READY/);
  assert.match(fixtureScript, /Wait-Process -Id/);
  assert.match(fixtureScript, /ErrorAction SilentlyContinue/);
  assert.doesNotMatch(fixtureScript, /Remove-Item|Directory\.Delete|File\.Delete/);
});
