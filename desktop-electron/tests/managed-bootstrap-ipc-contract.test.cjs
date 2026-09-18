"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.resolve(__dirname, "..");
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), "utf8");

test("launcher starts managed bootstrap without blocking window creation and exposes retry IPC", () => {
  const main = read("electron/main.cjs");
  const preload = read("electron/preload.cjs");
  const types = read("src/types.ts");
  const combined = read("electron/managed-external-services.cjs");

  assert.match(main, /launcher:managed-components-retry-all/);
  assert.match(main, /reconcileManagedComponents\(\{\s*reason:\s*"startup"\s*\}\)/);
  assert.match(main, /void externalServicesController\.reconcileManagedComponents/);
  assert.doesNotMatch(
    main,
    /await externalServicesController\.reconcileManagedComponents\(\{\s*reason:\s*"startup"/,
  );
  assert.match(
    main,
    /handle\("launcher:managed-components-retry-all",[\s\S]*?assertFocusedMainWindow\(event, true\)/,
  );
  assert.match(preload, /retryManagedComponents:\s*\(\)\s*=>\s*ipcRenderer\.invoke\("launcher:managed-components-retry-all"\)/);
  assert.match(types, /managedBootstrap\?: ManagedBootstrapSnapshot/);
  assert.match(types, /retryManagedComponents\(\): Promise<ExternalServicesSnapshot>/);
  assert.match(combined, /createManagedBootstrap/);
  assert.match(combined, /reason:\s*"credential-saved"/);
  assert.match(combined, /function reconcileManagedComponents/);
});
