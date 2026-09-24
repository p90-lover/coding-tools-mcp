"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");
const { writePrivateFileAtomic } = require("./atomic-file.cjs");
const { cpaLongRunYamlLines } = require("./cpa-codex-long-run.cjs");

const RUNTIME_MARKER = "CPA_RUNTIME.json";
const MAX_ARCHIVE_LIST_BYTES = 16 * 1024 * 1024;

function requiredAbsolutePath(value, label) {
  const resolved = path.resolve(String(value || ""));
  if (!path.isAbsolute(resolved) || !String(value || "").trim()) {
    throw new Error(`${label} must be an absolute path`);
  }
  return resolved;
}

function assertInside(root, candidate, label) {
  const base = path.resolve(root);
  const target = path.resolve(candidate);
  const relative = path.relative(base, target);
  if (!relative || relative === ".") return target;
  if (relative.startsWith(`..${path.sep}`) || relative === ".." || path.isAbsolute(relative)) {
    throw new Error(`${label} escaped the managed CPA root`);
  }
  return target;
}

function runChecked(executable, args, options = {}) {
  const result = spawnSync(executable, args, {
    encoding: "utf8",
    windowsHide: true,
    maxBuffer: MAX_ARCHIVE_LIST_BYTES,
    ...options,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const detail = String(result.stderr || result.stdout || "").trim().slice(-2_000);
    throw new Error(`${executable} failed (${result.status ?? "unknown"})${detail ? `: ${detail}` : ""}`);
  }
  return result;
}

function validateArchive(artifact) {
  const listing = runChecked("tar", ["-tf", artifact]).stdout;
  const entries = String(listing || "").split(/\r?\n/u).filter(Boolean);
  if (entries.length === 0) throw new Error("CPA release archive is empty");
  for (const entry of entries) {
    const normalized = entry.replaceAll("\\", "/");
    const segments = normalized.split("/").filter(Boolean);
    if (normalized.startsWith("/")
      || /^[A-Za-z]:/u.test(normalized)
      || segments.includes("..")
      || normalized.includes("\0")) {
      throw new Error("CPA release archive contains an unsafe path");
    }
  }

  const verbose = runChecked("tar", ["-tvf", artifact]).stdout;
  for (const line of String(verbose || "").split(/\r?\n/u).filter(Boolean)) {
    const type = line.trimStart()[0];
    if (type === "l" || type === "h") {
      throw new Error("CPA release archive contains a link entry");
    }
  }
}

function findRuntimeBinary(directory) {
  const matches = [];
  const visit = (current) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const candidate = path.join(current, entry.name);
      const stat = fs.lstatSync(candidate);
      if (stat.isSymbolicLink()) throw new Error("CPA runtime contains a symbolic link");
      if (stat.isDirectory()) {
        visit(candidate);
        continue;
      }
      const normalized = entry.name.toLowerCase();
      if (stat.isFile() && (normalized === "cli-proxy-api" || normalized === "cli-proxy-api.exe")) {
        matches.push(candidate);
      }
    }
  };
  visit(directory);
  if (matches.length !== 1) {
    throw new Error(`CPA release archive must contain exactly one runtime binary; found ${matches.length}`);
  }
  return matches[0];
}

function markerPath(home) {
  return path.join(home, "runtime", RUNTIME_MARKER);
}

function prepare(homeValue, stateValue, artifactValue) {
  const home = requiredAbsolutePath(homeValue, "CPA managed home");
  requiredAbsolutePath(stateValue, "CPA state root");
  const artifact = requiredAbsolutePath(artifactValue, "CPA release archive");
  assertInside(home, artifact, "CPA release archive");
  if (!fs.statSync(artifact).isFile()) throw new Error("CPA release archive is not a file");

  const runtimeRoot = path.join(home, "runtime");
  fs.mkdirSync(runtimeRoot, { recursive: true, mode: 0o700 });
  validateArchive(artifact);
  runChecked("tar", ["-xf", artifact, "-C", runtimeRoot]);

  const executable = findRuntimeBinary(runtimeRoot);
  assertInside(runtimeRoot, executable, "CPA runtime binary");
  if (process.platform !== "win32") fs.chmodSync(executable, 0o700);
  const relativeExecutable = path.relative(runtimeRoot, executable);
  writePrivateFileAtomic(markerPath(home), `${JSON.stringify({
    schemaVersion: 1,
    executable: relativeExecutable,
  }, null, 2)}\n`);
}

function requiredSecret(name, minimumLength = 32) {
  const value = String(process.env[name] || "").trim();
  if (value.length < minimumLength || value.includes("\0")) {
    throw new Error(`${name} is missing or invalid`);
  }
  return value;
}

function yamlString(value) {
  return JSON.stringify(String(value));
}

function runtimeConfiguration(state, managementKey, proxyApiKey) {
  const authDirectory = path.join(state, "auth");
  const logDirectory = path.join(state, "logs");
  const pluginDirectory = path.join(state, "plugins");
  fs.mkdirSync(authDirectory, { recursive: true, mode: 0o700 });
  fs.mkdirSync(logDirectory, { recursive: true, mode: 0o700 });
  fs.mkdirSync(pluginDirectory, { recursive: true, mode: 0o700 });
  if (process.platform !== "win32") {
    fs.chmodSync(authDirectory, 0o700);
    fs.chmodSync(logDirectory, 0o700);
    fs.chmodSync(pluginDirectory, 0o700);
  }
  return [
    "host: \"127.0.0.1\"",
    "port: 8317",
    `auth-dir: ${yamlString(authDirectory)}`,
    "api-keys:",
    `  - ${yamlString(proxyApiKey)}`,
    "remote-management:",
    "  allow-remote: false",
    `  secret-key: ${yamlString(managementKey)}`,
    "  disable-control-panel: false",
    "  disable-auto-update-panel: true",
    "debug: false",
    "request-log: false",
    "logging-to-file: true",
    "usage-statistics-enabled: true",
    ...cpaLongRunYamlLines(),
    "plugins:",
    "  enabled: true",
    `  dir: ${yamlString(pluginDirectory)}`,
    "  configs:",
    "    antigravity-coding-filter:",
    "      enabled: true",
    "      priority: 1",
    "      mode: rewrite",
    "      use_default_keywords: true",
    "      custom_mappings: {}",
    "",
  ].join("\n");
}

function run(homeValue, stateValue) {
  const home = requiredAbsolutePath(homeValue, "CPA managed home");
  const state = requiredAbsolutePath(stateValue, "CPA state root");
  const marker = JSON.parse(fs.readFileSync(markerPath(home), "utf8"));
  if (marker?.schemaVersion !== 1 || typeof marker.executable !== "string") {
    throw new Error("CPA runtime marker is invalid");
  }

  const runtimeRoot = path.join(home, "runtime");
  const executable = assertInside(runtimeRoot, path.join(runtimeRoot, marker.executable), "CPA runtime binary");
  const stat = fs.lstatSync(executable);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("CPA runtime binary is invalid");

  fs.mkdirSync(state, { recursive: true, mode: 0o700 });
  if (process.platform !== "win32") fs.chmodSync(state, 0o700);
  const managementKey = requiredSecret("CODING_TOOLS_CPA_MANAGEMENT_KEY");
  const proxyApiKey = requiredSecret("CODING_TOOLS_CPA_PROXY_API_KEY");
  const configPath = path.join(state, "config.yaml");
  writePrivateFileAtomic(configPath, runtimeConfiguration(state, managementKey, proxyApiKey));
  if (process.platform !== "win32") fs.chmodSync(configPath, 0o600);

  const child = spawn(executable, ["--config", configPath, "--no-browser"], {
    cwd: state,
    env: { ...process.env },
    shell: false,
    windowsHide: true,
    stdio: "inherit",
  });

  const forward = (signal) => {
    try {
      if (child.exitCode === null && child.signalCode === null) child.kill(signal);
    } catch {}
  };
  process.once("SIGINT", () => forward("SIGINT"));
  process.once("SIGTERM", () => forward("SIGTERM"));
  child.once("error", (error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
  child.once("exit", (code, signal) => {
    process.exitCode = Number.isInteger(code) ? code : signal ? 1 : 0;
  });
}

if (require.main === module) {
  const command = process.argv[2];
  if (command === "prepare") {
    prepare(process.argv[3], process.argv[4], process.argv[5]);
  } else if (command === "run") {
    run(process.argv[3], process.argv[4]);
  } else {
    throw new Error("CPA managed adapter command must be prepare or run");
  }
}

module.exports = {
  prepare,
  run,
  runtimeConfiguration,
};
