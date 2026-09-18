"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.resolve(__dirname, "..");
const repositoryRoot = path.resolve(root, "..");

function rendererRoot() {
  const configured = process.env.CODING_TOOLS_RENDERER_DIST?.trim();
  if (configured) return path.resolve(configured);

  const retainedReleaseBuild = path.join(repositoryRoot, "aiTemp", "rc6-csc", "renderer");
  if (fs.existsSync(retainedReleaseBuild)) return retainedReleaseBuild;

  return path.join(root, "dist");
}

test("packaged renderer selects Provider Hub and project-scoped update copy", () => {
  const dist = rendererRoot();
  const assets = path.join(dist, "assets");
  assert.equal(
    fs.existsSync(assets),
    true,
    `renderer assets are missing from ${assets}`,
  );

  const scripts = fs.readdirSync(assets)
    .filter((name) => /^index-.*\.js$/u.test(name))
    .sort();
  assert.equal(
    scripts.length,
    1,
    `expected one renderer entry script in ${assets}, got ${scripts.join(", ")}`,
  );

  const bundlePath = path.join(assets, scripts[0]);
  const bundle = fs.readFileSync(bundlePath, "utf8");
  assert.match(bundle, /data-provider-account-summary/, `Provider Hub summary missing from ${bundlePath}`);
  assert.match(bundle, /Refresh accounts/, `account refresh control missing from ${bundlePath}`);
  assert.match(bundle, /Coding Tools v/, `project-scoped update copy missing from ${bundlePath}`);
  assert.doesNotMatch(
    bundle,
    /coding-tools-provider-instances-v1/,
    `legacy localStorage provider implementation leaked into ${bundlePath}`,
  );
});
