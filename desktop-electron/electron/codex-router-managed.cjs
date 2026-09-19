"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");
const {
  applyLongRunLiteLlmTimeout,
  routerLongRunEnvironment,
} = require("./cpa-codex-long-run.cjs");

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

function absolute(value, label) {
  if (!value || !path.isAbsolute(value)) fail(`${label} must be absolute`);
  return path.resolve(value);
}

function requiredFile(home, relative) {
  const candidate = path.join(home, relative);
  const back = path.relative(home, candidate);
  if (back.startsWith("..") || path.isAbsolute(back)) fail(`${relative} escaped the managed source`);
  if (!fs.existsSync(candidate) || !fs.statSync(candidate).isFile()) fail(`Codex Router is missing ${relative}`);
  return candidate;
}

function environment(home, state) {
  const routerState = path.join(state, "router");
  const codexHome = path.join(state, "codex-home");
  fs.mkdirSync(routerState, { recursive: true, mode: 0o700 });
  fs.mkdirSync(codexHome, { recursive: true, mode: 0o700 });
  return {
    ...process.env,
    MODEL_ROUTER_TARGET: "codex",
    MODEL_ROUTER_STATE_DIR: routerState,
    CODEX_ROUTER_STATE_DIR: routerState,
    CODEX_HOME: codexHome,
    CODEX_ROUTER_SOURCE_ROOT: home,
    CODEX_ROUTER_NODE_BIN: process.execPath,
    ...routerLongRunEnvironment(),
  };
}

function runChecked(executable, args, cwd, env) {
  const result = spawnSync(executable, args, {
    cwd,
    env,
    stdio: "inherit",
    windowsHide: true,
    shell: false,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) fail(`${path.basename(executable)} failed (${result.status ?? "unknown"})`);
}

function quoteCmd(value) {
  return `"${String(value).replaceAll('"', '""')}"`;
}

function quoteSh(value) {
  return `'${String(value).replaceAll("'", `'"'"'`)}'`;
}

function writeWrapper(filePath, value, mode) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  if (!fs.existsSync(filePath) || fs.readFileSync(filePath, "utf8") !== value) {
    fs.writeFileSync(filePath, value, { encoding: "utf8", mode });
  }
  if (process.platform !== "win32") fs.chmodSync(filePath, mode);
}

function wrapperExports(env, quote) {
  return [
    ["MODEL_ROUTER_TARGET", "codex"],
    ["MODEL_ROUTER_STATE_DIR", env.MODEL_ROUTER_STATE_DIR],
    ["CODEX_ROUTER_STATE_DIR", env.CODEX_ROUTER_STATE_DIR],
    ["CODEX_HOME", env.CODEX_HOME],
    ...Object.entries(routerLongRunEnvironment()),
  ].map(([name, value]) => [name, quote ? quote(value) : value]);
}

function isAiTempPath(value) {
  return String(value || "")
    .replaceAll("\\", "/")
    .split("/")
    .some((part) => part.toLowerCase() === "aitemp");
}

function readJson(filePath) {
  try { return JSON.parse(fs.readFileSync(filePath, "utf8")); }
  catch { return null; }
}

function safeSegment(value) {
  return String(value || "unknown").replace(/[^A-Za-z0-9._-]+/g, "-").slice(0, 120);
}

function routerVersion(home) {
  const bundled = readJson(path.join(home, "CODING_TOOLS_BUNDLED.json"));
  if (bundled?.version) return safeSegment(bundled.version);
  const marker = readJson(path.join(home, ".coding-tools-managed-component.json"));
  if (marker?.version) return safeSegment(marker.version);
  const pkg = readJson(path.join(home, "package.json"));
  if (pkg?.version) return safeSegment(pkg.version);
  return "";
}

function resolveLiveComponentHome(home, stateDir) {
  const resolvedHome = path.resolve(home);
  if (!isAiTempPath(resolvedHome)) return resolvedHome;
  const resolvedState = path.resolve(stateDir);
  const dataRoot = path.dirname(path.dirname(resolvedState));
  const version = routerVersion(resolvedHome);
  if (!version) {
    throw new Error("Managed Codex Router wrappers cannot target a temporary unpack directory");
  }
  return path.resolve(dataRoot, "components", "codex-router", version);
}

function wrapperFileTargets(content) {
  const targets = [];
  for (const match of String(content || "").matchAll(/-File\s+(?:"([^"]+)"|'([^']+)'|(\S+))/gi)) {
    targets.push(match[1] || match[2] || match[3]);
  }
  return targets;
}

function quotedPaths(content) {
  const values = [];
  for (const match of String(content || "").matchAll(/"([^"\r\n]+)"|'([^'\r\n]+)'/g)) {
    values.push(match[1] || match[2]);
  }
  return values;
}

function wrapperLooksStale(filePath, liveHome) {
  if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) return true;
  const content = fs.readFileSync(filePath, "utf8");
  const liveNormalized = path.resolve(liveHome).replaceAll("\\", "/").toLowerCase();
  const candidates = [...wrapperFileTargets(content), ...quotedPaths(content)];
  let sawLiveTarget = false;
  for (const candidate of candidates) {
    if (!candidate) continue;
    if (isAiTempPath(candidate)) return true;
    const resolved = path.resolve(candidate);
    if (isAiTempPath(resolved)) return true;
    const normalized = resolved.replaceAll("\\", "/").toLowerCase();
    if (normalized.startsWith(`${liveNormalized}/`) || normalized === liveNormalized) {
      sawLiveTarget = true;
      continue;
    }
    if (
      /\.(?:ps1|mjs|cmd)$/i.test(candidate)
      || /(?:^|[/\\])(?:model-router|curate-models)$/i.test(candidate)
    ) {
      if (!fs.existsSync(resolved)) return true;
    }
  }
  return !sawLiveTarget;
}

function wrappers(home, state, env, platform = process.platform) {
  const bin = path.join(state, "bin");
  if (platform === "win32") {
    writeWrapper(path.join(bin, "model-router.cmd"), [
      "@echo off",
      "setlocal",
      ...wrapperExports(env).map(([name, value]) => `set ${name}=${value}`),
      `powershell.exe -NoProfile -ExecutionPolicy Bypass -File ${quoteCmd(path.join(home, "codex-router.ps1"))} %*`,
      "",
    ].join("\r\n"), 0o600);
    writeWrapper(path.join(bin, "curate-models.cmd"), [
      "@echo off",
      "setlocal",
      `set MODEL_ROUTER_STATE_DIR=${env.MODEL_ROUTER_STATE_DIR}`,
      ...wrapperExports(env).map(([name, value]) => `set ${name}=${value}`),
      `${quoteCmd(process.execPath)} ${quoteCmd(path.join(home, "src", "curate-models.mjs"))} %*`,
      "",
    ].join("\r\n"), 0o600);
    return;
  }
  const exports = wrapperExports(env, quoteSh)
    .map(([name, value]) => `export ${name}=${value}`)
    .join("\n");
  writeWrapper(
    path.join(bin, "model-router"),
    `#!/usr/bin/env bash\nset -euo pipefail\n${exports}\nexec bash ${quoteSh(path.join(home, "bin", "model-router"))} codex "$@"\n`,
    0o700,
  );
  writeWrapper(
    path.join(bin, "curate-models"),
    `#!/usr/bin/env bash\nset -euo pipefail\n${exports}\nexec ${quoteSh(process.execPath)} ${quoteSh(path.join(home, "src", "curate-models.mjs"))} "$@"\n`,
    0o700,
  );
}

function binWrapperPaths(stateDir, platform = process.platform) {
  const bin = path.join(stateDir, "bin");
  if (platform === "win32") {
    return [path.join(bin, "model-router.cmd"), path.join(bin, "curate-models.cmd")];
  }
  return [path.join(bin, "model-router"), path.join(bin, "curate-models")];
}

function ensureBinWrappers({ home, stateDir, platform = process.platform } = {}) {
  if (!home || !path.isAbsolute(home)) throw new Error("Codex Router home must be absolute");
  if (!stateDir || !path.isAbsolute(stateDir)) throw new Error("Codex Router state directory must be absolute");
  const liveHome = resolveLiveComponentHome(home, stateDir);
  if (isAiTempPath(liveHome)) {
    throw new Error("Managed Codex Router wrappers cannot target a temporary unpack directory");
  }
  wrappers(liveHome, stateDir, environment(liveHome, stateDir), platform);
  return liveHome;
}

function bundledSkipNetworkPrepare(home) {
  const marker = path.join(home, "CODING_TOOLS_BUNDLED.json");
  if (!fs.existsSync(marker)) return false;
  try {
    const parsed = JSON.parse(fs.readFileSync(marker, "utf8"));
    return parsed?.skipNetworkPrepare === true;
  } catch {
    return false;
  }
}

function assertRouterIdentity(home) {
  const pkg = JSON.parse(fs.readFileSync(requiredFile(home, "package.json"), "utf8"));
  if (pkg.name !== "codex-model-router" || pkg.version !== "0.6.0") {
    fail(`Unexpected Codex Router package ${pkg.name}@${pkg.version}`);
  }
  requiredFile(home, "src/foreground-start.mjs");
  requiredFile(home, "src/curate-models.mjs");
  requiredFile(home, "apps/control-center/electron/main.mjs");
  requiredFile(home, "apps/control-center/package.json");
}

function ensureCallerSecret(state) {
  const directory = path.join(state, "router");
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const callerSecret = path.join(directory, "caller-secret");
  if (fs.existsSync(callerSecret) && fs.readFileSync(callerSecret, "utf8").trim()) return callerSecret;
  fs.writeFileSync(callerSecret, `${crypto.randomBytes(24).toString("base64url")}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  return callerSecret;
}

function finishPrepare(home, state) {
  ensureBinWrappers({ home, stateDir: state });
  applyLongRunLiteLlmTimeout(home);
  const { ensureOriginalControlCenter } = require("./codex-router-original-ui.cjs");
  try {
    ensureOriginalControlCenter(home);
  } catch (error) {
    fail(`Codex Router Control Center prepare failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  const callerSecret = path.join(state, "router", "caller-secret");
  if (!fs.existsSync(callerSecret) || !fs.readFileSync(callerSecret, "utf8").trim()) {
    fail("Codex Router did not create its caller secret");
  }
}

function prepareOfflineFromBundle(home, state) {
  assertRouterIdentity(home);
  ensureCallerSecret(state);
  finishPrepare(home, state);
}

function prepare(home, state) {
  if (bundledSkipNetworkPrepare(home)) {
    prepareOfflineFromBundle(home, state);
    return;
  }
  assertRouterIdentity(home);
  const env = environment(home, state);
  if (process.platform === "win32") {
    runChecked("powershell.exe", [
      "-NoProfile", "-ExecutionPolicy", "Bypass",
      "-File", requiredFile(home, "install.ps1"),
      "-CheckoutInstall", "-PrepareOnly", "-Target", "codex", "-InstallDir", home,
    ], home, env);
  } else {
    runChecked("bash", [requiredFile(home, "bin/install"), "--prepare-only"], home, env);
  }
  finishPrepare(home, state);
}

function run(home, state) {
  const liveHome = ensureBinWrappers({ home, stateDir: state });
  applyLongRunLiteLlmTimeout(liveHome);
  const env = environment(liveHome, state);
  const child = spawn(process.execPath, [requiredFile(liveHome, "src/foreground-start.mjs")], {
    cwd: liveHome,
    env,
    stdio: "inherit",
    windowsHide: true,
    shell: false,
  });
  const forward = (signal) => {
    try { child.kill(signal); } catch {}
  };
  process.once("SIGINT", () => forward("SIGINT"));
  process.once("SIGTERM", () => forward("SIGTERM"));
  child.once("error", (error) => fail(error.message));
  child.once("exit", (code, signal) => {
    if (signal) process.kill(process.pid, signal);
    else process.exit(code ?? 1);
  });
}

if (require.main === module) {
  const [action, homeValue, stateValue] = process.argv.slice(2);
  const home = absolute(homeValue, "Codex Router home");
  const state = absolute(stateValue, "Codex Router state");
  if (action === "prepare") prepare(home, state);
  else if (action === "run") run(home, state);
  else fail(`Unsupported managed Codex Router action: ${action || "missing"}`);
}

module.exports = {
  bundledSkipNetworkPrepare,
  ensureBinWrappers,
  environment,
  isAiTempPath,
  prepare,
  prepareOfflineFromBundle,
  resolveLiveComponentHome,
  run,
  wrapperFileTargets,
  wrapperLooksStale,
  binWrapperPaths,
};
