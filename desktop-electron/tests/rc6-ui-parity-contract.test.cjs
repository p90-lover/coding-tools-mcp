"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.resolve(__dirname, "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");

test("Paseo and Anneal surfaces keep all visible controls behind localization helpers", () => {
  const paseo = read("src/features/PaseoOrchestratorSurface.tsx");
  const anneal = read("src/features/AnnealTasksSurface.tsx");

  for (const source of [paseo, anneal]) {
    assert.match(source, /localText\(/);
    assert.doesNotMatch(source, />Refresh<\/button>/);
    assert.doesNotMatch(source, />Workspace<\/span>/);
    assert.doesNotMatch(source, />Provider<\/span>/);
    assert.doesNotMatch(source, />Account<\/span>/);
    assert.doesNotMatch(source, />Model<\/span>/);
  }
});

test("orchestration surfaces expose the expected parity components", () => {
  const files = [
    "src/features/PaseoOrchestratorSurface.tsx",
    "src/features/AnnealTasksSurface.tsx",
    "src/features/ProviderOrchestratorSurfaces.tsx",
    "src/features/orchestration-control.css",
  ];

  for (const file of files) {
    assert.ok(fs.existsSync(path.join(root, file)), `${file} missing`);
  }
});
