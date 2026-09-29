#!/usr/bin/env node
"use strict";

// Packages the swappable backend tier (see electron/backend-bundle.cjs) from the current build
// outputs, and optionally deploys it into a running Coding Tools, which installs it and restarts
// only the backend. The GUI, Codex bridge, MCP tunnel and CPA proxy keep running.
//
//   node scripts/package-backend.cjs            write artifacts/backend/<id>/
//   node scripts/package-backend.cjs --deploy   also hand it to the running app
//   --user-data <dir>                            app user-data folder (default %APPDATA%/Coding Tools)
//
// Inputs: electron/<backend modules>, vendor/tools/*.json, ../app-handler,
// build/package-resources/coding-tools (bun run build:package-resources) and
// build/agent-orchestrator (bun run build:agent-orchestrator).

const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { BACKEND_MODULES, MANIFEST_NAME, READY_MARKER, SCHEMA_VERSION, verifyBundle } = require("../electron/backend-bundle.cjs");

const desktopRoot = path.resolve(__dirname, "..");
const repositoryRoot = path.resolve(desktopRoot, "..");
const args = process.argv.slice(2);
const deploy = args.includes("--deploy");
const userDataIndex = args.indexOf("--user-data");
const userData = userDataIndex >= 0 ? path.resolve(args[userDataIndex + 1] || "") : defaultUserData();
const RETIRED_APP_MODULES = new Set(["paseo", "anneal", "codex-router", "commandcode-proxy"]);

function defaultUserData() {
  const product = require(path.join(desktopRoot, "package.json")).productName || "Coding Tools";
  if (process.platform === "win32") return path.join(process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming"), product);
  if (process.platform === "darwin") return path.join(os.homedir(), "Library", "Application Support", product);
  return path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"), product);
}

function fail(message) {
  console.error(`[package-backend] ${message}`);
  process.exit(1);
}

function walk(root, filter = () => true, prefix = "") {
  const files = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (!filter(rel, entry)) continue;
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) files.push(...walk(full, filter, rel));
    else if (entry.isFile()) files.push(rel);
  }
  return files;
}

// The backend JavaScript may require only Node built-ins and other backend modules; anything
// else would silently keep running the installed copy and break the separation.
function assertBackendClosure() {
  for (const name of BACKEND_MODULES) {
    const source = fs.readFileSync(path.join(desktopRoot, "electron", name), "utf8");
    for (const match of source.matchAll(/require\(\s*["']([^"']+)["']\s*\)/g)) {
      const target = match[1];
      if (target.startsWith("node:")) continue;
      if (target.startsWith("./") && BACKEND_MODULES.includes(target.slice(2))) continue;
      if (target.startsWith("./") && BACKEND_MODULES.includes(`${target.slice(2)}.cjs`)) continue;
      fail(`electron/${name} requires ${target}, which is outside the backend bundle`);
    }
  }
}

function collect() {
  const sources = new Map(); // rel -> absolute source
  for (const name of BACKEND_MODULES) sources.set(`electron/${name}`, path.join(desktopRoot, "electron", name));
  const toolsRoot = path.join(desktopRoot, "vendor", "tools");
  for (const rel of walk(toolsRoot, (rel) => !rel.includes("/") ? rel.endsWith(".json") : false)) {
    sources.set(`vendor/tools/${rel}`, path.join(toolsRoot, rel));
  }
  const appHandlerRoot = path.join(repositoryRoot, "app-handler");
  for (const rel of walk(appHandlerRoot, (rel) => {
    const first = rel.split("/")[0];
    return !RETIRED_APP_MODULES.has(first) && !rel.split("/").includes("node_modules") && !rel.includes("source/test");
  })) {
    sources.set(`app-handler/${rel}`, path.join(appHandlerRoot, rel));
  }
  const headlessName = process.platform === "win32" ? "coding-tools-headless.exe" : "coding-tools-headless";
  const headless = path.join(desktopRoot, "build", "package-resources", "coding-tools", headlessName);
  if (!fs.existsSync(headless)) fail(`${path.relative(desktopRoot, headless)} is missing; run bun run build:package-resources`);
  sources.set(`coding-tools/${headlessName}`, headless);
  const aoRoot = path.join(desktopRoot, "build", "agent-orchestrator");
  if (!fs.existsSync(path.join(aoRoot, "manifest.json"))) fail("build/agent-orchestrator is missing; run bun run build:agent-orchestrator");
  for (const rel of walk(aoRoot)) sources.set(`agent-orchestrator/${rel}`, path.join(aoRoot, rel));
  return sources;
}

function sha256(filePath) {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function main() {
  assertBackendClosure();
  const sources = collect();
  const files = {};
  for (const [rel, source] of [...sources].sort(([a], [b]) => a.localeCompare(b))) files[rel] = sha256(source);
  const digest = crypto.createHash("sha256").update(JSON.stringify(files)).digest("hex").slice(0, 10);
  const appVersion = require(path.join(desktopRoot, "package.json")).version;
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..*$/, "").replace("T", "-");
  const id = `${appVersion}-${stamp}-${digest}`.replace(/[^A-Za-z0-9._-]/g, "-");
  const manifest = { schemaVersion: SCHEMA_VERSION, id, builtAt: new Date().toISOString(), appVersion, files };

  const outputRoot = path.join(desktopRoot, "artifacts", "backend", id);
  fs.rmSync(outputRoot, { recursive: true, force: true });
  for (const [rel, source] of sources) {
    const target = path.join(outputRoot, ...rel.split("/"));
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(source, target);
  }
  fs.writeFileSync(path.join(outputRoot, MANIFEST_NAME), `${JSON.stringify(manifest, null, 2)}\n`);
  verifyBundle(outputRoot);
  console.log(`[package-backend] ${Object.keys(files).length} files -> ${path.relative(desktopRoot, outputRoot)}`);

  if (deploy) {
    const incoming = path.join(userData, "backend", "incoming", id);
    fs.rmSync(incoming, { recursive: true, force: true });
    fs.cpSync(outputRoot, incoming, { recursive: true });
    // The running app installs a bundle only after this marker exists.
    fs.writeFileSync(path.join(incoming, READY_MARKER), `${manifest.builtAt}\n`);
    console.log(`[package-backend] deployed to ${incoming}; the running app installs it within a few seconds`);
  }
  console.log(`BACKEND_BUNDLE_ID=${id}`);
}

main();
