"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.resolve(__dirname, "..", "..");
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), "utf8");

test("onboarding exposes Traditional Chinese without mandatory social clicks", () => {
  const types = read("desktop-electron/src/types.ts");
  const app = read("desktop-electron/src/App.tsx");
  const i18n = read("desktop-electron/src/i18n.ts");

  assert.match(types, /Language\s*=\s*[^;]*"zh-TW"/);
  assert.match(app, /selectedLanguage === "zh-TW"/);
  assert.match(app, /setSelectedLanguage\("zh-TW"\)/);
  assert.match(app, /marker="繁"/);
  assert.doesNotMatch(
    app,
    /disabled=\{busy\s*\|\|\s*\(stage === "support"[^}]*githubOpened[^}]*xOpened/,
  );
  assert.match(app, /label:\s*copy\.traditionalChinese,\s*value:\s*"zh-TW"/);
  assert.match(app, /language === "zh-TW"\s*\?\s*"zh-TW"/);
  assert.match(i18n, /language === "zh-TW"/);
  assert.match(i18n, /zhTWOverrides/);
});

test("launcher uses the project owner links and never blocks completion on social state", () => {
  const main = read("desktop-electron/electron/main.cjs");
  const state = read("desktop-electron/electron/state.cjs");

  assert.match(main, /https:\/\/github\.com\/p90-lover\/coding-tools-mcp/);
  assert.match(main, /https:\/\/x\.com\/GIBUSHAT/);
  assert.doesNotMatch(main, /Open the GitHub and X pages before continuing/);
  assert.match(main, /value !== "zh-TW"/);
  assert.match(main, /"zh-TW": Object\.freeze\(/);
  assert.match(state, /state\.language !== "zh-TW"/);
});

test("Traditional Chinese overrides cover onboarding and new orchestration surfaces", () => {
  const locale = read("desktop-electron/src/i18n/locales/zh-TW.ts");
  for (const key of [
    "chooseLanguage",
    "traditionalChinese",
    "supportTitle",
    "supportBody",
    "finishWelcome",
    "providers",
    "paseoOrchestrator",
    "annealTasks",
    "networkProxy",
  ]) {
    assert.match(locale, new RegExp(`\\b${key}:`), `missing Traditional Chinese key ${key}`);
  }
  assert.match(locale, /可選|選擇性/);
});
