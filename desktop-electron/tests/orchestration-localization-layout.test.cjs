"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.resolve(__dirname, "..");
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), "utf8");

const paseoPath = "src/features/PaseoOrchestratorSurface.tsx";
const annealPath = "src/features/AnnealTasksSurface.tsx";
const copyPath = "src/features/orchestration-copy.ts";
const providerHubPath = "src/providers/ProviderHubIntegration.tsx";
const stylesPath = "src/features/orchestration-control.css";

test("Paseo and Anneal use one complete localized copy surface", () => {
  assert.equal(fs.existsSync(path.join(root, copyPath)), true, "missing orchestration copy module");
  const copy = read(copyPath);
  const paseo = read(paseoPath);
  const anneal = read(annealPath);

  for (const traditionalChinese of [
    "更新",
    "工作區",
    "供應商",
    "自動選擇",
    "帳戶",
    "模型",
    "允許健康帳戶後備切換",
    "預覽路由",
    "建立工作階段",
    "Paseo 工作階段",
    "Anneal 任務板",
    "待整理",
    "待執行",
    "執行中",
    "審查",
    "完成",
  ]) {
    assert.match(copy, new RegExp(traditionalChinese), `missing zh-TW copy: ${traditionalChinese}`);
  }

  assert.match(paseo, /orchestrationCopy\(language\)/);
  assert.match(anneal, /orchestrationCopy\(language\)/);
  for (const hardcoded of [
    />Refresh</,
    />Workspace</,
    />Provider</,
    />Account</,
    />Preview route</,
    />Allow healthy fallback</,
  ]) {
    assert.doesNotMatch(paseo, hardcoded);
    assert.doesNotMatch(anneal, hardcoded);
  }
});

test("Paseo renders a session workbench rather than the generic two-panel form", () => {
  const paseo = read(paseoPath);
  const styles = read(stylesPath);

  for (const className of [
    "paseo-studio",
    "paseo-session-rail",
    "paseo-workbench",
    "paseo-inspector",
    "paseo-composer",
    "paseo-meta-chip",
  ]) {
    assert.match(paseo, new RegExp(className));
    assert.match(styles, new RegExp(`\\.${className}`));
  }
  assert.doesNotMatch(paseo, /control-grid two-column/);
});

test("Anneal renders a five-column task board and selected-task dispatch drawer", () => {
  const anneal = read(annealPath);
  const styles = read(stylesPath);

  for (const column of ["backlog", "todo", "doing", "review", "done"]) {
    assert.match(anneal, new RegExp(`id:\\s*\"${column}\"`));
  }
  for (const className of [
    "anneal-board",
    "anneal-column",
    "anneal-column-head",
    "anneal-task-card",
    "anneal-dispatch-drawer",
  ]) {
    assert.match(anneal, new RegExp(className));
    assert.match(styles, new RegExp(`\\.${className}`));
  }
  assert.doesNotMatch(anneal, /control-grid two-column/);
});

test("Provider Hub follows the canonical launcher language", () => {
  const source = read(providerHubPath);

  assert.doesNotMatch(source, /coding-tools-provider-locale/);
  assert.doesNotMatch(source, /navigator\.language/);
  assert.match(source, /api\?\.snapshot\(\)/);
  assert.match(source, /api\?\.onStateChanged/);
  assert.match(source, /api\?\.setLanguage/);
});
