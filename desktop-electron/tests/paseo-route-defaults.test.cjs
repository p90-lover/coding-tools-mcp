"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const ts = require("typescript");

const filename = path.join(__dirname, "..", "src", "features", "PaseoOrchestratorSurface.tsx");
const compiled = ts.transpileModule(fs.readFileSync(filename, "utf8"), {
  compilerOptions: {
    jsx: ts.JsxEmit.ReactJSX,
    module: ts.ModuleKind.CommonJS,
    target: ts.ScriptTarget.ES2022,
  },
  fileName: filename,
});
const moduleUnderTest = { exports: {} };
Function("require", "module", "exports", compiled.outputText)(
  () => ({}),
  moduleUnderTest,
  moduleUnderTest.exports,
);

function account(id, providerId, models, overrides = {}) {
  return {
    id,
    providerId,
    label: id,
    auth: "browser_session",
    status: "connected",
    enabled: true,
    isDefault: false,
    hasCredential: true,
    models,
    createdAt: "2026-09-23T00:00:00.000Z",
    updatedAt: "2026-09-23T00:00:00.000Z",
    ...overrides,
  };
}

test("Paseo resolves only the exact Web GPT and Gemini worker defaults", () => {
  const { paseoRouteDefaults } = moduleUnderTest.exports;
  const defaults = paseoRouteDefaults([
    account("cpa-claude", "cliproxyapi", ["claude-opus-4-1"]),
    account("expired-web", "chatgpt-web", ["chatgpt-web/high"], { status: "expired" }),
    account("chatgpt-web-local", "chatgpt-web", ["chatgpt-web/low", "chatgpt-web/high"], {
      isDefault: true,
    }),
    account(
      "antigravity-main",
      "cliproxyapi-antigravity",
      ["gemini-3.8-flash-low", "gemini-3.8-flash-high"],
    ),
  ]);

  assert.deepEqual(defaults.orchestrator, {
    providerId: "chatgpt-web",
    accountId: "chatgpt-web-local",
    model: "chatgpt-web/high",
  });
  assert.deepEqual(defaults.worker, {
    providerId: "cliproxyapi-antigravity",
    accountId: "antigravity-main",
    model: "gemini-3.8-flash-high",
  });
});

test("Paseo route requests always disable provider fallback", () => {
  const { paseoRouteSelection } = moduleUnderTest.exports;

  assert.deepEqual(
    paseoRouteSelection("chatgpt-web", "chatgpt-web-local", "chatgpt-web/high"),
    {
      providerId: "chatgpt-web",
      accountId: "chatgpt-web-local",
      model: "chatgpt-web/high",
      allowFallback: false,
    },
  );
});
