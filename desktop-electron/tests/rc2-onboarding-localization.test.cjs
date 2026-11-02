"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const ts = require("typescript");

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

function onboardingAutostartFixture({ autoStart = true, enabled = false, setFailure, readFailure, persistFailure } = {}) {
  const source = read("desktop-electron/electron/main.cjs");
  const file = ts.createSourceFile("main.cjs", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const handlers = new Map();
  function visit(node) {
    if (ts.isCallExpression(node) && node.expression.getText(file) === "handle"
      && ["launcher:complete-onboarding", "launcher:autostart"].includes(node.arguments[0]?.text)) {
      handlers.set(node.arguments[0].text, node.arguments[1].getText(file));
    }
    ts.forEachChild(node, visit);
  }
  visit(file); assert.equal(handlers.size, 2, "both real IPC callbacks are exercised");
  const autostart = { exports: {} };
  vm.runInNewContext(read("desktop-electron/electron/autostart.cjs"), {
    module: autostart, process: { platform: "win32", env: {} },
    require: name => name === "node:fs" ? {} : name === "./atomic-file.cjs"
      ? { writePrivateFileAtomic() { throw new Error("No file writes in this fixture"); } } : require(name),
  });
  const state = { autoStart, onboardingComplete: false, language: null, browserInteractionMode: "automatic", githubOpened: false };
  const warnings = [], writes = [], calls = [];
  const context = vm.createContext({
    ...autostart.exports, IS_DEV_PROFILE: false,
    app: { isPackaged: true,
      setLoginItemSettings: value => { calls.push(value); if (setFailure) throw setFailure; },
      getLoginItemSettings: () => { if (readFailure) throw readFailure; return { openAtLogin: enabled }; } },
    stateStore: { read: () => state, update: patch => { if (persistFailure) throw persistFailure; writes.push(patch); return Object.assign(state, patch); } },
    validateLanguage: value => { if (value === "invalid") throw new Error("Invalid language"); return value; },
    validateBrowserInteractionMode: value => value,
    updateTrayMenu() {}, logger: { info() {}, warn: (event, detail) => warnings.push({ event, ...detail }) },
  });
  return { state, warnings, writes, calls,
    finish: (language = "zh-TW", mode = "manual") => vm.runInContext(`(${handlers.get("launcher:complete-onboarding")})`, context)(null, language, mode),
    settings: () => vm.runInContext(`(${handlers.get("launcher:autostart")})`, context)(null, true) };
}

test("onboarding completes when optional OS autostart registration is refused", async t => {
  for (const [name, options, observed] of [
    ["declined registration", {}, false],
    ["registration throws but OS is already enabled", { setFailure: new Error("Policy refused a change"), enabled: true }, true],
    ["registration and observation fail", { setFailure: new Error("x".repeat(600)), readFailure: new Error("OS unavailable") }, false],
  ]) await t.test(name, () => {
    const f = onboardingAutostartFixture(options), result = f.finish();
    assert.equal(result, f.state); assert.equal(result.onboardingComplete, true); assert.equal(result.autoStart, observed);
    assert.equal(result.language, "zh-TW"); assert.equal(result.browserInteractionMode, "manual"); assert.equal(result.githubOpened, false);
    assert.equal(f.writes.length, 1); assert.equal(f.warnings.length, 1);
    assert.equal(f.warnings[0].event, "launcher.autostart_unavailable"); assert.ok(f.warnings[0].message.length <= 300);
  });
});

test("onboarding retains successful or disabled autostart and still rejects validation or persistence failure", () => {
  for (const options of [{ enabled: true }, { autoStart: false, setFailure: new Error("Must not register") }]) {
    const f = onboardingAutostartFixture(options), result = f.finish();
    assert.equal(result.onboardingComplete, true); assert.equal(result.autoStart, options.autoStart !== false);
    assert.equal(f.calls.length, options.autoStart === false ? 0 : 1); assert.deepEqual(f.warnings, []);
  }
  const invalid = onboardingAutostartFixture();
  assert.throws(() => invalid.finish("invalid"), /Invalid language/); assert.equal(invalid.writes.length, 0);
  const failed = onboardingAutostartFixture({ persistFailure: new Error("State unavailable") });
  assert.throws(() => failed.finish(), /State unavailable/); assert.equal(failed.state.onboardingComplete, false);
});

test("Settings still rejects an explicitly refused autostart change without persisting it", () => {
  const f = onboardingAutostartFixture({ autoStart: false });
  assert.throws(() => f.settings(), /did not enable launcher autostart/);
  assert.equal(f.state.autoStart, false); assert.equal(f.writes.length, 0); assert.deepEqual(f.warnings, []);
});
