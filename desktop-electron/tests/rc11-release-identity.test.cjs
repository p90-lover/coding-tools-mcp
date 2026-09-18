"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const repo = path.resolve(__dirname, "..", "..");
const read = (relativePath) => fs.readFileSync(path.join(repo, relativePath), "utf8");

test("rc.11 product, package, and integrated Apps identities are aligned", () => {
  const manifest = JSON.parse(read("desktop-electron/package.json"));
  assert.equal(manifest.version, "0.7.0-rc.11");
  assert.match(read("desktop-electron/electron/product.cjs"), /version: "0\.7\.0-rc\.11"/);
  assert.match(read("desktop-electron/scripts/prepare-package-resources.cjs"), /PRODUCT_VERSION = "0\.7\.0-rc\.11"/);
  assert.match(read("desktop-electron/scripts/verify-package.cjs"), /version: "0\.7\.0-rc\.11"/);

  const apps = read("desktop-electron/src/features/IntegratedAppsSurface.tsx");
  for (const tab of ["cpa", "codex-router", "commandcode-proxy", "paseo", "anneal"]) {
    assert.match(apps, new RegExp(`id: ["']${tab}["']`));
  }
  assert.match(read("desktop-electron/src/App.tsx"), /surface === "apps"/);
});

test("rc.11 publishes a new immutable tag and leaves rc.9 history untouched", () => {
  const workflow = read(".github/workflows/codex-router-multiprovider-release-rc11.yml");
  assert.match(workflow, /RELEASE_VERSION: 0\.7\.0-rc\.11/);
  assert.match(workflow, /RELEASE_TAG: v0\.7\.0-rc\.11/);
  assert.match(workflow, /release\/codex-router-multiprovider-0\.7\.0-rc\.11/);
  assert.match(workflow, /docs\/releases\/v0\.7\.0-rc\.11\.md/);
  assert.match(workflow, /integrated-app-tabs\.test\.cjs/);
  assert.doesNotMatch(workflow, /RELEASE_TAG: v0\.7\.0-rc\.9/);
  assert.doesNotMatch(workflow, /git push[^\n]*--force/);

  const historical = read(".github/workflows/codex-router-multiprovider-release-rc9.yml");
  assert.match(historical, /RELEASE_TAG: v0\.7\.0-rc\.9/);
});
