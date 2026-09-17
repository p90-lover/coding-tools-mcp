"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.resolve(__dirname, "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");

test("Paseo and Anneal surfaces keep all visible controls behind the shared copy catalogue", () => {
  const paseo = read("src/features/PaseoOrchestratorSurface.tsx");
  const anneal = read("src/features/AnnealTasksSurface.tsx");
  const copy = read("src/features/orchestration-copy.ts");

  for (const source of [paseo, anneal]) {
    assert.match(source, /orchestrationCopy\(language\)/);
    assert.doesNotMatch(source, />Refresh<\/button>/);
    assert.doesNotMatch(source, />Workspace<\/span>/);
    assert.doesNotMatch(source, />Provider<\/span>/);
    assert.doesNotMatch(source, />Account<\/span>/);
    assert.doesNotMatch(source, />Model<\/span>/);
    assert.doesNotMatch(source, />Allow healthy fallback<\/span>/);
    assert.doesNotMatch(source, />Preview route<\/button>/);
  }

  assert.match(copy, /const ZH_TW: OrchestrationCopy/);
  assert.match(copy, /paseoCreateSession: "建立工作階段"/);
  assert.match(copy, /annealBacklog: "待整理"/);
});

test("orchestration surfaces expose the expected parity components", () => {
  const files = [
    "src/features/PaseoOrchestratorSurface.tsx",
    "src/features/AnnealTasksSurface.tsx",
    "src/features/ProviderOrchestratorSurfaces.tsx",
    "src/features/orchestration-copy.ts",
    "src/features/orchestration-control.css",
  ];

  for (const file of files) {
    assert.ok(fs.existsSync(path.join(root, file)), `${file} missing`);
  }
});
