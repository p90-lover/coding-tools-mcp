"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.resolve(__dirname, "..");
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), "utf8");

test("launcher starts one-app reconciliation without blocking window creation", () => {
  const main = read("electron/main.cjs");

  assert.match(
    main,
    /void\s+externalServicesController\.reconcileManagedComponents\(\{\s*reason:\s*"startup"\s*\}\)\.catch/s,
  );
  assert.match(main, /managed-bootstrap\.startup-failed/);
  assert.doesNotMatch(
    main,
    /for\s*\(const service of externalServicesController\?\.snapshot\(\)\.services[\s\S]*?externalServicesController\.start\(service\.id\)/,
  );
});

test("main, preload, and renderer types expose focused Retry all IPC", () => {
  const main = read("electron/main.cjs");
  const preload = read("electron/preload.cjs");
  const types = read("src/types.ts");

  assert.match(
    main,
    /handle\("launcher:managed-components-retry-all",\s*\(event\)\s*=>\s*\{[\s\S]*?assertFocusedMainWindow\(event, true\);[\s\S]*?reconcileManagedComponents\(\{\s*reason:\s*"manual-retry"\s*\}\)/,
  );
  assert.match(
    preload,
    /retryManagedComponents:\s*\(\)\s*=>\s*ipcRenderer\.invoke\("launcher:managed-components-retry-all"\)/,
  );
  assert.match(types, /export interface ManagedBootstrapSnapshot/);
  assert.match(types, /managedBootstrap:\s*ManagedBootstrapSnapshot\s*\|\s*null/);
  assert.match(types, /retryManagedComponents\(\):\s*Promise<ManagedBootstrapSnapshot>/);
});
