"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.resolve(__dirname, "..");
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), "utf8");

test("Integrations shows one-app setup progress and Retry all without dropping per-component controls", () => {
  const surface = read("src/features/ExternalServicesSurface.tsx");
  const styles = read("src/features/external-services.css");

  assert.match(surface, /Preparing integrations/);
  assert.match(surface, /正在準備整合功能/);
  assert.match(surface, /All integrations are ready/);
  assert.match(surface, /所有整合功能已就緒/);
  assert.match(surface, /Setup is blocked/);
  assert.match(surface, /設定暫時受阻/);
  assert.match(surface, /Retry all/);
  assert.match(surface, /全部重試/);
  assert.match(surface, /retryManagedComponents\(\)/);
  assert.match(surface, /managed-bootstrap-card/);
  assert.match(surface, /Install \/ Repair/);
  assert.match(styles, /\.managed-bootstrap-card/);
});
