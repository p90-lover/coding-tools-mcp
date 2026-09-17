"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const desktopRoot = path.resolve(__dirname, "..");
const repositoryRoot = path.resolve(desktopRoot, "..");
const retainedValidationRoot = path.join(repositoryRoot, "aiTemp", "rc6-csc", "renderer");

function resolveRendererRoot() {
  const configuredRoot = process.env.CODING_TOOLS_RENDERER_DIST;
  if (configuredRoot) return path.resolve(configuredRoot);
  if (fs.existsSync(path.join(retainedValidationRoot, "assets"))) return retainedValidationRoot;
  return path.join(desktopRoot, "dist");
}

test("packaged renderer selects Provider Hub and project-scoped update copy", () => {
  const rendererRoot = resolveRendererRoot();
  const assets = path.join(rendererRoot, "assets");
  assert.ok(fs.existsSync(assets), `renderer assets are missing at ${assets}`);
  const scripts = fs.readdirSync(assets)
    .filter((name) => /^index-.*\.js$/u.test(name))
    .sort();
  assert.equal(
    scripts.length,
    1,
    `expected one renderer entry script in ${assets}, got ${scripts.join(", ")}`,
  );
  const bundle = fs.readFileSync(path.join(assets, scripts[0]), "utf8");
  assert.match(bundle, /data-provider-account-summary/);
  assert.match(bundle, /Refresh accounts/);
  assert.match(bundle, /Coding Tools v/);
  assert.doesNotMatch(bundle, /coding-tools-provider-instances-v1/);
});
