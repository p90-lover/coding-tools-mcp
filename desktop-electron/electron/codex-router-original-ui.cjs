"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");

const CONTROL_CENTER_RELATIVE = path.join("apps", "control-center");
const ORIGINAL_SECTIONS = Object.freeze([
  "dashboard",
  "usage",
  "status",
  "models",
  "local",
  "harness",
  "context",
  "settings",
]);
const ARGV_SECTIONS = Object.freeze(["usage"]);

function requiredAbsolute(value, label) {
  const resolved = path.resolve(String(value || ""));
  if (!path.isAbsolute(resolved)) throw new Error(`${label} must be an absolute path`);
  return resolved;
}

function assertInside(root, candidate, label) {
  const base = path.resolve(root);
  const target = path.resolve(candidate);
  const relative = path.relative(base, target);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`${label} escaped the managed Codex Router source`);
  }
  return target;
}

function controlCenterRoot(home) {
  return assertInside(home, path.join(home, CONTROL_CENTER_RELATIVE), "Codex Router Control Center");
}

function rendererPath(home) {
  return path.join(controlCenterRoot(home), "dist", "index.html");
}

function packagePath(home) {
  return path.join(controlCenterRoot(home), "package.json");
}

function bundledElectronPath(root) {
  if (process.platform === "win32") {
    return path.join(root, "node_modules", "electron", "dist", "electron.exe");
  }
  if (process.platform === "darwin") {
    return path.join(
      root,
      "node_modules",
      "electron",
      "dist",
      "Electron.app",
      "Contents",
      "MacOS",
      "Electron",
    );
  }
  return path.join(root, "node_modules", "electron", "dist", "electron");
}

function routerEnvironment(home, state) {
  const routerState = path.join(state, "router");
  const codexHome = path.join(state, "codex-home");
  fs.mkdirSync(routerState, { recursive: true, mode: 0o700 });
  fs.mkdirSync(codexHome, { recursive: true, mode: 0o700 });
  return {
    MODEL_ROUTER_TARGET: "codex",
    MODEL_ROUTER_STATE_DIR: routerState,
    MODEL_ROUTER_SOURCE_ROOT: home,
    CODEX_ROUTER_STATE_DIR: routerState,
    CODEX_HOME: codexHome,
    CODEX_ROUTER_SOURCE_ROOT: home,
    CODEX_ROUTER_NODE_BIN: process.execPath,
  };
}

function runChecked(executable, args, options) {
  const result = spawnSync(executable, args, {
    encoding: "utf8",
    windowsHide: true,
    ...options,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const detail = String(result.stderr || result.stdout || "").trim().slice(-2_000);
    throw new Error(`${path.basename(executable)} failed (${result.status ?? "unknown"})${detail ? `: ${detail}` : ""}`);
  }
  return result;
}

function ensureOriginalControlCenter(home, { npm = "npm", run = runChecked } = {}) {
  const root = controlCenterRoot(requiredAbsolute(home, "Codex Router source"));
  const manifest = JSON.parse(fs.readFileSync(packagePath(home), "utf8"));
  if (manifest.name !== "@codex-router/control-center" || manifest.version !== "0.6.0") {
    throw new Error(`Unexpected Codex Router Control Center package ${manifest.name}@${manifest.version}`);
  }
  if (manifest.main !== "electron/main.mjs") {
    throw new Error("Codex Router Control Center main entry is not the original Electron host");
  }
  if (!fs.existsSync(rendererPath(home))) {
    run(npm, ["ci", "--ignore-scripts"], { cwd: root, stdio: "inherit" });
    run(npm, ["run", "build"], { cwd: root, stdio: "inherit" });
  }
  if (!fs.existsSync(rendererPath(home))) {
    throw new Error("Codex Router Control Center renderer was not built");
  }
  return {
    root,
    renderer: rendererPath(home),
    preload: path.join(root, "electron", "preload.cjs"),
    main: path.join(root, "electron", "main.mjs"),
    sections: [...ORIGINAL_SECTIONS],
  };
}

function resolveElectronExecutable(root, fallback, run = runChecked) {
  const bundled = bundledElectronPath(root);
  if (fs.existsSync(bundled)) return bundled;
  const installer = path.join(root, "node_modules", "electron", "install.js");
  if (fs.existsSync(installer)) {
    run(process.execPath, [installer], { cwd: root, stdio: "inherit" });
    if (fs.existsSync(bundled)) return bundled;
  }
  if (fallback) return fallback;
  throw new Error("Codex Router Control Center Electron runtime is not installed");
}

function controlCenterEnvironment(home, state) {
  const env = {
    ...process.env,
    ...routerEnvironment(home, state),
  };
  delete env.VITE_DEV_SERVER_URL;
  delete env.ELECTRON_RUN_AS_NODE;
  return env;
}

function openOriginalControlCenter({
  home,
  state,
  section = "dashboard",
  electronExecutable = null,
  spawnProcess = spawn,
  npm = "npm",
  run = runChecked,
} = {}) {
  const source = requiredAbsolute(home, "Codex Router source");
  const runtimeState = requiredAbsolute(state, "Codex Router state");
  if (!ORIGINAL_SECTIONS.includes(section)) {
    throw new Error(`Unsupported Codex Router Control Center section: ${section}`);
  }
  const prepared = ensureOriginalControlCenter(source, { npm, run });
  const executable = resolveElectronExecutable(prepared.root, electronExecutable, run);
  const userData = path.join(runtimeState, "control-center-ui");
  fs.mkdirSync(userData, { recursive: true, mode: 0o700 });
  const args = [`--user-data-dir=${userData}`, "."];
  if (ARGV_SECTIONS.includes(section)) {
    args.push("--router-destination", section);
  }
  const child = spawnProcess(executable, args, {
    cwd: prepared.root,
    env: controlCenterEnvironment(source, runtimeState),
    stdio: "ignore",
    windowsHide: false,
    shell: false,
    detached: false,
  });
  if (!child) throw new Error("Codex Router Control Center failed to start");
  return {
    ok: true,
    section,
    pid: child.pid ?? null,
    renderer: prepared.renderer,
    root: prepared.root,
    executable,
    child,
  };
}

module.exports = {
  ARGV_SECTIONS,
  ORIGINAL_SECTIONS,
  bundledElectronPath,
  ensureOriginalControlCenter,
  openOriginalControlCenter,
  rendererPath,
  routerEnvironment,
};
