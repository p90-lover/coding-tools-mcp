"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const ts = require("typescript");

const filename = path.join(__dirname, "..", "src", "features", "ProviderOrchestratorSurfaces.tsx");
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
    auth: "local_proxy",
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

test("provider configuration requires the exact connected account and advertised model", () => {
  const { selectConnectedProviderAccount } = moduleUnderTest.exports;
  const accounts = [
    account("wrong-model", "cliproxyapi-antigravity", ["gemini-3.8-pro"], { isDefault: true }),
    account("gemini-worker", "cliproxyapi-antigravity", ["gemini-3.8-flash-high"]),
    account("offline-worker", "cliproxyapi-antigravity", ["gemini-3.8-flash-high"], {
      status: "error",
    }),
  ];

  assert.equal(
    selectConnectedProviderAccount(
      accounts,
      "cliproxyapi-antigravity",
      "gemini-worker",
      "gemini-3.8-flash-high",
    )?.id,
    "gemini-worker",
  );
  assert.equal(
    selectConnectedProviderAccount(
      accounts,
      "cliproxyapi-antigravity",
      "wrong-model",
      "gemini-3.8-flash-high",
    ),
    undefined,
  );
  assert.equal(
    selectConnectedProviderAccount(
      accounts,
      "cliproxyapi-antigravity",
      "offline-worker",
      "gemini-3.8-flash-high",
    ),
    undefined,
  );
});

test("account changes preserve only a model advertised by the selected account", () => {
  const { modelAfterProviderAccountChange } = moduleUnderTest.exports;
  const selected = account(
    "gemini-worker",
    "cliproxyapi-antigravity",
    ["gemini-3.8-flash-high"],
  );

  assert.equal(modelAfterProviderAccountChange(selected, "claude-opus-4-1"), "");
  assert.equal(
    modelAfterProviderAccountChange(selected, "gemini-3.8-flash-high"),
    "gemini-3.8-flash-high",
  );
});
