"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const test = require("node:test");

const desktopRoot = path.resolve(__dirname, "..");
const overlayPath = path.join(
  desktopRoot,
  "vendor",
  "five-stack-runtime",
  "overlays",
  "codex-router",
  "src",
  "service-process.mjs",
);

test("Codex Router overlay helper matches start.mjs and foreground-start.mjs with Windows paths", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "coding-tools-service-process-"));
  const src = path.join(directory, "src");
  fs.mkdirSync(src, { recursive: true });
  fs.writeFileSync(path.join(src, "file-security.mjs"), `
import { writeFileSync } from "node:fs";
export function writePrivateJson(filePath, value) {
  writeFileSync(filePath, JSON.stringify(value));
}
`);
  fs.writeFileSync(path.join(src, "paths.mjs"), `
export const PORTS = { router: 4202 };
export const SERVICE_PROCESS_STATE_PATH = ${JSON.stringify(path.join(directory, "state.json"))};
export const SOURCE_ROOT = ${JSON.stringify(directory)};
export const STATE_DIR = ${JSON.stringify(directory)};
`);
  fs.writeFileSync(path.join(src, "process-identity.mjs"), `
export function processCommandLine() { return ""; }
export function processStartIdentity() { return ""; }
`);
  fs.copyFileSync(overlayPath, path.join(src, "service-process.mjs"));

  const {
    buildServiceProcessState,
    commandLineMatchesServiceEntrypoint,
    serviceProcessOwns,
    writeServiceProcessState,
  } = await import(pathToFileURL(path.join(src, "service-process.mjs")).href);

  const root = path.join(directory, "checkout");
  const windowsRoot = String(root).replaceAll("/", "\\");
  const identity = () => "2026-08-18T00:00:00Z|node.exe";

  assert.equal(
    commandLineMatchesServiceEntrypoint(`node "${root}/src/start.mjs"`, root),
    true,
  );
  assert.equal(
    commandLineMatchesServiceEntrypoint(`bun "${windowsRoot}\\src\\foreground-start.mjs"`, root),
    true,
  );
  assert.equal(
    commandLineMatchesServiceEntrypoint("node C:/other/src/start.mjs", root),
    false,
  );

  const foregroundState = buildServiceProcessState({
    pid: 4242,
    platform: "win32",
    identity,
    commandLine: () => `bun "${windowsRoot}\\src\\foreground-start.mjs"`,
    sourceRoot: root,
    stateDir: directory,
    ports: { router: 4202 },
  });
  assert.equal(foregroundState.pid, 4242);
  assert.equal(
    serviceProcessOwns(foregroundState, {
      platform: "win32",
      identity,
      commandLine: () => `bun "${windowsRoot}\\src\\foreground-start.mjs"`,
      sourceRoot: root,
      stateDir: directory,
    }),
    true,
  );

  const startState = buildServiceProcessState({
    pid: 4242,
    platform: "win32",
    identity,
    commandLine: () => `node "${root}/src/start.mjs"`,
    sourceRoot: root,
    stateDir: directory,
    ports: { router: 4202 },
  });
  assert.equal(startState.pid, 4242);

  const statePath = path.join(directory, "service-process.json");
  writeServiceProcessState({
    pid: 4242,
    platform: "win32",
    identity,
    commandLine: () => `bun "${windowsRoot}\\src\\foreground-start.mjs"`,
    sourceRoot: root,
    stateDir: directory,
    statePath,
  });
  assert.equal(JSON.parse(fs.readFileSync(statePath, "utf8")).pid, 4242);
});
