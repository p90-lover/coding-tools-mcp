"use strict";

const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const { createRetentionSession } = require("./prepare-package-resources.cjs");

const launcherRoot = path.resolve(__dirname, "..");
const repositoryRoot = path.resolve(launcherRoot, "..");
const output = path.join(launcherRoot, "build", "runtime");
const aiTempRoot = path.join(repositoryRoot, "aiTemp");
const retainedEvidenceRoot = path.join(aiTempRoot, "Trash", "runtime-bundles");
const bun = process.env.CODEX_WEB_GPT_BUN || process.execPath;
const session = createRetentionSession({
  repositoryRoot,
  label: "runtime-bundles",
});
const staging = path.join(session.workRoot, "runtime");

function runChecked(command, args) {
  const result = spawnSync(command, args, {
    cwd: repositoryRoot,
    env: process.env,
    stdio: "inherit",
    shell: false,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`RUNTIME_BUNDLE_COMMAND_FAILED: ${command} exited with ${result.status ?? "unknown"}`);
  }
}

let preparationError = null;
try {
  runChecked(bun, ["run", "scripts/build-runtime-bundle.ts", staging]);
  for (const required of [
    "manifest.json",
    "THIRD_PARTY_NOTICES.txt",
    "LICENSE",
    "LICENSES",
  ]) {
    if (!fs.existsSync(path.join(staging, required))) {
      throw new Error(`RUNTIME_BUNDLE_REQUIRED_ENTRY_MISSING: ${required}`);
    }
  }
  const preservedPath = session.publishDirectory(staging, output, "prior-runtime-bundles");
  const normalizedTrash = path.resolve(retainedEvidenceRoot);
  if (preservedPath
      && preservedPath !== normalizedTrash
      && !preservedPath.startsWith(`${normalizedTrash}${path.sep}`)) {
    throw new Error(`RUNTIME_BUNDLE_RETENTION_OUTSIDE_AITEMP: ${preservedPath}`);
  }
  process.stdout.write(`RUNTIME_BUNDLE_PREPARED ${JSON.stringify({ output, preservedPath })}\n`);
} catch (error) {
  preparationError = error;
}

let retentionError = null;
try {
  if (fs.existsSync(staging)) session.preservePath(staging, "failed-runtime-bundles");
} catch (error) {
  retentionError = error;
}

if (preparationError && retentionError) {
  throw new AggregateError(
    [preparationError, retentionError],
    "Runtime preparation and evidence retention both failed",
  );
}
if (preparationError) throw preparationError;
if (retentionError) throw retentionError;
