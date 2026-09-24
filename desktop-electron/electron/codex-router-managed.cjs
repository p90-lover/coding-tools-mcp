"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");
const {
  applyLongRunLiteLlmTimeout,
  routerLongRunEnvironment,
} = require("./cpa-codex-long-run.cjs");

const MANAGED_PYTHON_VERSION = "3.13";

function managedPythonBinary(state, name) {
  return path.join(state, "python", process.platform === "win32" ? "Scripts" : "bin", `${name}${process.platform === "win32" ? ".exe" : ""}`);
}

function resolvePythonExecutable({ env = process.env, platform = process.platform, spawnSyncProcess = spawnSync } = {}) {
  const pathValue = Object.entries(env).find(([key]) => key.toLowerCase() === "path")?.[1] || "";
  const candidates = env.CODING_TOOLS_PYTHON_EXE ? [env.CODING_TOOLS_PYTHON_EXE] : [
    ...(platform === "win32" ? [
      env.LOCALAPPDATA && path.join(env.LOCALAPPDATA, "Programs", "Python", `Python${MANAGED_PYTHON_VERSION.replace(".", "")}`, "python.exe"),
      env.ProgramFiles && path.join(env.ProgramFiles, `Python${MANAGED_PYTHON_VERSION.replace(".", "")}`, "python.exe"),
    ] : [`python${MANAGED_PYTHON_VERSION}`]),
    ...String(pathValue).split(platform === "win32" ? ";" : ":").filter(Boolean)
      .filter((dir) => !/(?:WindowsApps|Python[\\/]bin)(?:[\\/]|$)/i.test(dir))
      .map((dir) => path.join(dir, platform === "win32" ? "python.exe" : `python${MANAGED_PYTHON_VERSION}`)),
  ];
  for (const candidate of new Set(candidates.filter(Boolean))) {
    const result = spawnSyncProcess(candidate, ["-I", "-B", "-c", `import sys; assert sys.implementation.name == 'cpython' and sys.version_info[:2] == (${MANAGED_PYTHON_VERSION.replace(".", ", ")}); print(sys.executable)`], {
      env, encoding: "utf8", shell: false, windowsHide: true, timeout: 15_000,
    });
    const executable = String(result.stdout || "").trim();
    if (!result.error && result.status === 0 && path.isAbsolute(executable)) return executable;
  }
  throw new Error(`Codex Router requires CPython ${MANAGED_PYTHON_VERSION} with venv and pip. Set CODING_TOOLS_PYTHON_EXE to that interpreter; offline preparation does not download Python.`);
}

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
    ...(bundledSkipNetworkPrepare(home) || fs.existsSync(managedPythonBinary(state, "litellm")) ? {
      MODEL_ROUTER_LITELLM_BIN: managedPythonBinary(state, "litellm"),
      CODEX_ROUTER_LITELLM_BIN: managedPythonBinary(state, "litellm"),
    } : {}),
    ...routerLongRunEnvironment(),
  };
}

function runChecked(executable, args, cwd, env, spawnSyncProcess = spawnSync) {
  const result = spawnSyncProcess(executable, args, {
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
    ...(env.MODEL_ROUTER_LITELLM_BIN ? [
      ["MODEL_ROUTER_LITELLM_BIN", env.MODEL_ROUTER_LITELLM_BIN],
      ["CODEX_ROUTER_LITELLM_BIN", env.CODEX_ROUTER_LITELLM_BIN || env.MODEL_ROUTER_LITELLM_BIN],
    ] : []),
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
      `powershell.exe -NoProfile -File ${quoteCmd(path.join(home, "codex-router.ps1"))} %*`,
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

/** Rewrite state/bin wrappers to the live component home after staging activation. */
function ensureBinWrappers(home, state) {
  const env = environment(home, state);
  wrappers(home, state, env);
  return env;
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

function applyRouterLocalProxyPolicy(home, state) {
  const foreground = fs.readFileSync(requiredFile(home, "src/foreground-start.mjs"), "utf8");
  if (!foreground.includes('import("./start.mjs")')) return false;
  const patches = [
    ["src/start.mjs", [[
      "const cursorTunnelSpec = cursorEdge ? cursorTunnelRunSpec() : undefined;",
      'const cursorTunnelSpec = process.env.CODING_TOOLS_LOCAL_ONLY === "1" ? undefined : cursorEdge ? cursorTunnelRunSpec() : undefined;',
    ]]],
    ["src/generic-providers.mjs", [
      [
        'import { Agent, fetch as undiciFetch } from "undici";',
        'import { Agent, EnvHttpProxyAgent, fetch as undiciFetch } from "undici";\nimport { environmentHttpProxyConfigured } from "./proxy-environment.mjs";',
      ],
      [
        "  return new Agent({",
        "  const useProxy = environmentHttpProxyConfigured() && !isPrivateGenericProviderHostname(endpoint.hostname);\n  return new (useProxy ? EnvHttpProxyAgent : Agent)({",
      ],
      [
        "    connect: { lookup },",
        "    ...(useProxy ? {} : { connect: { lookup } }),",
      ],
      [
        "    await dispatcher?.close().catch(() => undefined);",
        '    if (typeof dispatcher?.close === "function") await dispatcher.close().catch(() => undefined);',
        2,
      ],
    ]],
  ];
  const updates = [];
  for (const [relative, replacements] of patches) {
    const filePath = requiredFile(home, relative);
    const original = fs.readFileSync(filePath, "utf8");
    let next = original;
    for (const [before, after, expected = 1] of replacements) {
      const beforeCount = next.split(before).length - 1;
      const afterCount = next.split(after).length - 1;
      if (beforeCount === 0 && afterCount === expected) continue;
      if (beforeCount !== expected || afterCount !== 0) {
        throw new Error(`Codex Router network policy cannot patch ${relative}; source changed`);
      }
      next = next.replaceAll(before, after);
    }
    if (next !== original) updates.push({ filePath, original, next });
  }
  for (const { filePath, original, next } of updates) {
    const backupDir = path.join(state, "Trash", "router-network-policy");
    fs.mkdirSync(backupDir, { recursive: true, mode: 0o700 });
    const hash = crypto.createHash("sha256").update(original).digest("hex").slice(0, 12);
    const backupPath = path.join(backupDir, `${path.basename(filePath)}.${hash}.bak`);
    if (!fs.existsSync(backupPath)) fs.copyFileSync(filePath, backupPath);
    fs.writeFileSync(filePath, next);
  }
  return updates.length > 0;
}

function finishPrepare(home, state) {
  const env = environment(home, state);
  wrappers(home, state, env);
  applyLongRunLiteLlmTimeout(home);
  applyRouterLocalProxyPolicy(home, state);
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

function ensureManagedPython(home, state, { spawnSyncProcess = spawnSync } = {}) {
  const requirements = requiredFile(home, "requirements/python.txt");
  const lock = fs.readFileSync(requirements, "utf8");
  const wheels = path.join(home, "requirements", "wheels");
  if (!fs.existsSync(wheels) || !fs.readdirSync(wheels).some((name) => name.endsWith(".whl"))) {
    throw new Error("Codex Router bundled Python wheels are missing; repair requires a complete offline payload.");
  }
  const versions = ["litellm", "fastapi"].map((name) => {
    const version = lock.match(new RegExp(`^${name}==([^\\s;\\\\]+)`, "m"))?.[1];
    if (!version) throw new Error(`Codex Router Python lock is missing its ${name} pin`);
    return `assert version(${JSON.stringify(name)}) == ${JSON.stringify(version)}`;
  });
  const root = path.join(state, "python");
  const python = managedPythonBinary(state, "python");
  const litellm = managedPythonBinary(state, "litellm");
  const stamp = path.join(root, ".coding-tools-python-lock");
  const expected = `${MANAGED_PYTHON_VERSION}\n${crypto.createHash("sha256").update(lock).digest("hex")}\n`;
  const scratch = path.join(state, "aiTemp", "python");
  fs.mkdirSync(scratch, { recursive: true, mode: 0o700 });
  const env = { ...environment(home, state), TEMP: scratch, TMP: scratch, LITELLM_LOCAL_MODEL_COST_MAP: "True", LITELLM_MODE: "PRODUCTION" };
  const probeArgs = ["-I", "-B", "-c", `import sys, encodings; from importlib.metadata import version; assert sys.version_info[:2] == (${MANAGED_PYTHON_VERSION.replace(".", ", ")}); ${versions.join("; ")}; from litellm.proxy.proxy_cli import run_server`];
  const probe = () => spawnSyncProcess(python, probeArgs, { cwd: home, env, encoding: "utf8", shell: false, windowsHide: true, timeout: 45_000 });
  if (fs.existsSync(python) && fs.existsSync(litellm) && fs.existsSync(stamp) && fs.readFileSync(stamp, "utf8") === expected) {
    const result = probe();
    if (!result.error && result.status === 0) return litellm;
  }
  const hostPython = resolvePythonExecutable({ env, spawnSyncProcess });
  if (fs.existsSync(root)) {
    const retained = path.join(state, "Trash", `python-${crypto.randomUUID()}`);
    fs.mkdirSync(path.dirname(retained), { recursive: true, mode: 0o700 });
    fs.renameSync(root, retained);
  }
  runChecked(hostPython, ["-I", "-B", "-m", "venv", root], home, env, spawnSyncProcess);
  runChecked(python, ["-I", "-m", "pip", "--isolated", "--disable-pip-version-check", "install", "--no-index", "--no-cache-dir", "--only-binary=:all:", "--require-hashes", "--find-links", wheels, "-r", requirements], home, env, spawnSyncProcess);
  runChecked(python, ["-I", "-m", "pip", "--isolated", "--disable-pip-version-check", "check"], home, env, spawnSyncProcess);
  const verified = probe();
  if (verified.error || verified.status !== 0 || !fs.existsSync(litellm)) throw new Error("Codex Router's offline Python environment failed verification; its files were retained for inspection.");
  writeWrapper(stamp, expected, 0o600);
  return litellm;
}

function prepareOfflineFromBundle(home, state, options = {}) {
  assertRouterIdentity(home);
  ensureManagedPython(home, state, options);
  ensureCallerSecret(state);
  finishPrepare(home, state);
}

function prepare(home, state, options = {}) {
  if (bundledSkipNetworkPrepare(home)) {
    prepareOfflineFromBundle(home, state, options);
    return;
  }
  assertRouterIdentity(home);
  const env = environment(home, state);
  if (process.platform === "win32") {
    runChecked("powershell.exe", [
      "-NoProfile",
      "-File", requiredFile(home, "install.ps1"),
      "-CheckoutInstall", "-PrepareOnly", "-Target", "codex", "-InstallDir", home,
    ], home, env);
  } else {
    runChecked("bash", [requiredFile(home, "bin/install"), "--prepare-only"], home, env);
  }
  finishPrepare(home, state);
}

function run(home, state) {
  applyRouterLocalProxyPolicy(home, state);
  applyLongRunLiteLlmTimeout(home);
  const env = ensureBinWrappers(home, state);
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
  MANAGED_PYTHON_VERSION,
  applyRouterLocalProxyPolicy,
  ensureBinWrappers,
  wrappers,
  bundledSkipNetworkPrepare,
  environment,
  prepare,
  prepareOfflineFromBundle,
  resolvePythonExecutable,
  run,
};
