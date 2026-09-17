"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const repositoryRoot = path.resolve(__dirname, "..", "..");
const read = (relativePath) => fs.readFileSync(path.join(repositoryRoot, relativePath), "utf8");

test("rc.6 release builds the legacy uninstall fixture through the retained dotnet helper", () => {
  const workflow = read(".github/workflows/codex-router-multiprovider-release-rc6.yml");

  assert.match(workflow, /scripts[\\/]build-legacy-uninstall-fixture\.ps1/);
  assert.doesNotMatch(workflow, /Add-Type[\s\S]*-OutputType\s+(?:ConsoleApplication|WindowsApplication)/);
  assert.match(workflow, /Create a legacy Tauri uninstall fixture/);
  assert.match(workflow, /Verify legacy uninstall and rc\.6 reinstall/);
});

test("fixture helper uses dotnet publish, keeps build evidence under aiTemp, and never deletes files", () => {
  const helper = read("scripts/build-legacy-uninstall-fixture.ps1");

  assert.match(helper, /dotnet\s+publish/i);
  assert.match(helper, /PublishSingleFile=true/);
  assert.match(helper, /SelfContained=false/);
  assert.match(helper, /aiTemp[\\/]installer-upgrade[\\/]legacy-uninstall-fixture-build/);
  assert.match(helper, /Test-Path[\s\S]*throw/);
  assert.doesNotMatch(helper, /\bRemove-Item\b/);
  assert.doesNotMatch(helper, /\bdel(?:ete)?\b/i);
});
