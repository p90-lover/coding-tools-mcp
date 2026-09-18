"use strict";

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

function wrappers(home, state, env) {
  const bin = path.join(state, "bin");
  if (process.platform === "win32") {
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

function readBundledMarker(home) {
  const markerPath = path.join(home, "CODING_TOOLS_BUNDLED.json");
  try {
    return JSON.parse(fs.readFileSync(markerPath, "utf8"));
  } catch {
    return null;
  }
}

function prepareOfflineFromBundle(home, state, env) {
  const secret = requiredFile(home, "src/secret.mjs");
  runChecked(process.execPath, [secret, "ensure"], home, env);
  const catalog = path.join(home, "src", "catalog.mjs");
  if (fs.existsSync(catalog) && fs.statSync(catalog).isFile()) {
    try {
      runChecked(process.execPath, [catalog, "--refresh-native", "--bundled-native"], home, env);
    } catch {
      runChecked(process.execPath, [catalog], home, env);
    }
  }
  const liteLlm = path.join(home, "src", "litellm-config.mjs");
  if (fs.existsSync(liteLlm) && fs.statSync(liteLlm).isFile()) {
    runChecked(process.execPath, [liteLlm], home, env);
  }
  const callerSecret = path.join(state, "router", "caller-secret");
  if (!fs.existsSync(callerSecret) || !fs.readFileSync(callerSecret, "utf8").trim()) {
    fail("Bundled Codex Router did not create its caller secret");
  }
}

function prepare(home, state) {
  const pkg = JSON.parse(fs.readFileSync(requiredFile(home, "package.json"), "utf8"));
  if (pkg.name !== "codex-model-router" || pkg.version !== "0.6.0") fail(`Unexpected Codex Router package ${pkg.name}@${pkg.version}`);
  requiredFile(home, "src/foreground-start.mjs");
  requiredFile(home, "src/curate-models.mjs");
  requiredFile(home, "apps/control-center/electron/main.mjs");
  requiredFile(home, "apps/control-center/package.json");
  const env = environment(home, state);
  const bundled = readBundledMarker(home);
  if (bundled?.skipNetworkPrepare === true) {
    prepareOfflineFromBundle(home, state, env);
  } else if (process.platform === "win32") {
    runChecked("powershell.exe", [
      "-NoProfile", "-ExecutionPolicy", "Bypass",
      "-File", requiredFile(home, "install.ps1"),
      "-CheckoutInstall", "-PrepareOnly", "-Target", "codex", "-InstallDir", home,
    ], home, env);
  } else {
    runChecked("bash", [requiredFile(home, "bin/install"), "--prepare-only"], home, env);
  }
  wrappers(home, state, env);
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

function run(home, state) {
  applyLongRunLiteLlmTimeout(home);
  const env = environment(home, state);
  const child = spawn(process.execPath, [requiredFile(home, "src/foreground-start.mjs")], {
    cwd: home,
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
  environment,
  prepare,
  run,
};
