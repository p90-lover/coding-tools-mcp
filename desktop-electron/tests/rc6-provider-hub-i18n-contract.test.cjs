"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.resolve(__dirname, "..");
const source = fs.readFileSync(path.join(root, "src/features/ProviderHubSurface.tsx"), "utf8");

test("Provider Hub localizes authentication, status, badges, and Anneal routing labels", () => {
  assert.match(source, /function authLabel\(language/);
  assert.match(source, /function statusLabel\(language/);
  assert.match(source, /accountBadge\(language, account\)/);
  assert.match(source, /authLabel\(language, auth\)/);
  assert.match(source, /statusLabel\(language, status\)/);

  assert.doesNotMatch(source, /\{auth\.replaceAll\("_", " "\)\}<\/option>/);
  assert.doesNotMatch(source, /\{status\}<\/option>/);
  assert.doesNotMatch(source, /<span>Anneal project ID<\/span>/);
  assert.doesNotMatch(source, /<span>Anneal repository ID<\/span>/);
  assert.doesNotMatch(source, /<span>Anneal assigned agent ID<\/span>/);
});

test("Paseo and Anneal use the shared orchestration copy catalogue", () => {
  const paseo = fs.readFileSync(path.join(root, "src/features/PaseoOrchestratorSurface.tsx"), "utf8");
  const anneal = fs.readFileSync(path.join(root, "src/features/AnnealTasksSurface.tsx"), "utf8");
  const copy = fs.readFileSync(path.join(root, "src/features/orchestration-copy.ts"), "utf8");

  assert.match(paseo, /orchestrationCopy\(language\)/);
  assert.match(anneal, /orchestrationCopy\(language\)/);
  assert.match(copy, /const ZH_TW: OrchestrationCopy/);
  assert.match(copy, /annealBacklog: "待整理"/);
  assert.match(copy, /paseoCreateSession: "建立工作階段"/);
});
