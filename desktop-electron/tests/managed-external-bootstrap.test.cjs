"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.resolve(__dirname, "..");
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), "utf8");

test("managed external-services controller owns the automatic bootstrap coordinator", () => {
  const source = read("electron/managed-external-services.cjs");

  assert.match(source, /require\("\.\/managed-bootstrap\.cjs"\)/);
  assert.match(source, /createManagedBootstrapImpl\s*=\s*createManagedBootstrap/);
  assert.match(source, /bootstrap\s*=\s*createManagedBootstrapImpl\(/);
  assert.match(source, /snapshot:\s*combinedSnapshot/);
  assert.match(source, /install:\s*installManagedComponent/);
  assert.match(source, /repair:\s*repairManagedComponent/);
  assert.match(source, /start,/);
  assert.match(source, /inspect,/);
  assert.match(source, /managedBootstrapSnapshot:\s*\(\)\s*=>\s*bootstrap\.getSnapshot\(\)/);
  assert.match(source, /reconcileManagedComponents:\s*\(input\)\s*=>\s*bootstrap\.reconcile\(input\)/);
});

test("saving a managed credential queues targeted reconciliation without returning the credential", () => {
  const source = read("electron/managed-external-services.cjs");

  assert.match(
    source,
    /setManagedComponentCredential[\s\S]*?bootstrap\.reconcile\(\{[\s\S]*?reason:\s*"credential-saved"[\s\S]*?componentIds:\s*\[serviceId\]/,
  );
  assert.doesNotMatch(source, /return\s+value\s*;/);
  assert.match(source, /bootstrap\?\.dispose\(\)/);
});
