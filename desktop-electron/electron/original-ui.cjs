"use strict";

const path = require("node:path");
const { ORIGINAL_SECTIONS, openOriginalControlCenter } = require("./codex-router-original-ui.cjs");
const { attachCpaCodexLongRun } = require("./cpa-codex-long-run.cjs");

const TOOL_IDS = Object.freeze(["cpa", "codex-router"]);
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1", "localhost"]);
const READY_WAIT_MS = {
  cpa: 45_000,
  "codex-router": 5 * 60_000,
};
const READY_POLL_MS = 250;

function manifestPath(toolId) {
  return path.join(__dirname, "..", "vendor", "upstream", `${toolId}.json`);
}

function loadManifest(toolId) {
  if (!TOOL_IDS.includes(toolId)) throw new Error(`Unknown original UI: ${toolId}`);
  const filePath = manifestPath(toolId);
  const manifest = JSON.parse(require("node:fs").readFileSync(filePath, "utf8"));
  if (manifest.id !== toolId) throw new Error(`Original UI manifest ID mismatch: ${toolId}`);
  if (!Array.isArray(manifest.sections) || manifest.sections.length === 0) {
    throw new Error(`Original UI manifest has no sections: ${toolId}`);
  }
  return Object.freeze({ ...manifest, sections: Object.freeze([...manifest.sections]) });
}

function canonicalHostname(value) {
  const hostname = String(value || "").toLowerCase();
  return hostname.startsWith("[") && hostname.endsWith("]")
    ? hostname.slice(1, -1)
    : hostname;
}

function normalizeLoopbackEndpoint(value) {
  const parsed = new URL(String(value || ""));
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("Original UI endpoints must use HTTP or HTTPS");
  }
  if (!LOOPBACK_HOSTS.has(canonicalHostname(parsed.hostname))) {
    throw new Error("Original UI endpoints are restricted to 127.0.0.1 or [::1]");
  }
  if (parsed.username || parsed.password) {
    throw new Error("Original UI endpoints must not contain credentials");
  }
  parsed.hash = "";
  parsed.search = "";
  if (!parsed.pathname.endsWith("/")) parsed.pathname += "/";
  return parsed.toString();
}

function sectionUrl(manifest, endpoint, section) {
  if (!manifest.sections.includes(section)) {
    throw new Error(`Unsupported ${manifest.id} section: ${section}`);
  }
  const pathname = manifest.sectionPaths?.[section] || `/${section}`;
  const target = new URL(pathname, normalizeLoopbackEndpoint(endpoint));
  if (!LOOPBACK_HOSTS.has(canonicalHostname(target.hostname))) {
    throw new Error("Original UI section URL escaped the loopback boundary");
  }
  return target.toString();
}

function createOriginalUiCore({
  externalServices = null,
  openExternal = null,
  spawnProcess = null,
  electronExecutable = process.execPath,
  npm = "npm",
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
} = {}) {
  const manifests = new Map(TOOL_IDS.map((toolId) => [toolId, loadManifest(toolId)]));
  let controlCenterChild = null;

  function requireTool(toolId) {
    const manifest = manifests.get(toolId);
    if (!manifest) throw new Error(`Unknown original UI: ${toolId}`);
    return manifest;
  }

  function service(toolId) {
    return externalServices?.snapshot?.().services?.find((entry) => entry.id === toolId) || null;
  }

  function project(toolId) {
    const manifest = requireTool(toolId);
    const current = service(toolId);
    return {
      id: manifest.id,
      name: manifest.name,
      repository: manifest.repository,
      commit: String(manifest.commit || ""),
      version: manifest.version || null,
      license: manifest.license || "",
      sections: [...manifest.sections],
      endpoint: current?.endpoint || manifest.defaultEndpoint,
      status: current?.status || "unknown",
      pid: current?.pid ?? null,
      error: current?.error || null,
      sourceConfigured: Boolean(current?.home),
      installState: current?.managedInstall?.state || "not-installed",
      originalChrome: true,
    };
  }

  function snapshot() {
    return { version: 1, tools: TOOL_IDS.map(project) };
  }

  async function inspect(toolId) {
    requireTool(toolId);
    if (externalServices?.inspect) await externalServices.inspect(toolId);
    return project(toolId);
  }

  function stopControlCenter() {
    const child = controlCenterChild;
    controlCenterChild = null;
    if (!child) return;
    try {
      if (child.exitCode == null && child.signalCode == null) child.kill();
    } catch {}
  }

  function rememberControlCenter(child) {
    if (!child) return;
    if (controlCenterChild && controlCenterChild !== child && controlCenterChild.exitCode == null) {
      child.once?.("exit", () => {});
      return;
    }
    controlCenterChild = child;
    child.once?.("exit", () => {
      if (controlCenterChild === child) controlCenterChild = null;
    });
  }

  async function waitUntilReady(toolId) {
    const started = Date.now();
    while (true) {
      const state = await inspect(toolId);
      if (state.status === "ready") return state;
      if (state.status === "error") {
        throw new Error(state.error || `${requireTool(toolId).name} failed to start`);
      }
      if (Date.now() - started >= (READY_WAIT_MS[toolId] || 45_000)) {
        throw new Error(`${requireTool(toolId).name} is not ready`);
      }
      await sleep(READY_POLL_MS);
    }
  }

  async function start(toolId) {
    requireTool(toolId);
    const current = service(toolId);
    const installState = current?.managedInstall?.state;
    if (installState === "not-installed" && externalServices?.installManagedComponent) {
      await externalServices.installManagedComponent(toolId);
    } else if (
      (installState === "repair-required" || installState === "error")
      && externalServices?.repairManagedComponent
    ) {
      await externalServices.repairManagedComponent(toolId);
    } else if (externalServices?.start) {
      await externalServices.start(toolId);
    } else {
      throw new Error(`${requireTool(toolId).name} lifecycle is unavailable`);
    }
    return inspect(toolId);
  }

  async function stop(toolId) {
    requireTool(toolId);
    if (toolId === "codex-router") stopControlCenter();
    if (!externalServices?.stop) throw new Error(`${requireTool(toolId).name} lifecycle is unavailable`);
    await externalServices.stop(toolId);
    return inspect(toolId);
  }

  async function restart(toolId) {
    requireTool(toolId);
    if (toolId === "codex-router") stopControlCenter();
    if (!externalServices?.restart) throw new Error(`${requireTool(toolId).name} lifecycle is unavailable`);
    await externalServices.restart(toolId);
    return inspect(toolId);
  }

  async function openEmbedded(toolId, section) {
    const manifest = requireTool(toolId);
    const selected = section || manifest.sections[0];
    let state = await inspect(toolId);
    if (state.status !== "ready") {
      await start(toolId);
      state = await waitUntilReady(toolId);
    }
    if (toolId === "codex-router") {
      const current = service(toolId);
      if (!current?.home) throw new Error("Install the pinned Codex Router source before opening its original Control Center");
      const stateDir = current.stateDir
        || path.join(path.dirname(path.dirname(path.dirname(current.home))), "state", "codex-router");
      const opened = openOriginalControlCenter({
        home: current.home,
        state: stateDir,
        section: ORIGINAL_SECTIONS.includes(selected) ? selected : "dashboard",
        electronExecutable,
        spawnProcess: spawnProcess || require("node:child_process").spawn,
        npm,
      });
      rememberControlCenter(opened.child);
      return {
        tool: state,
        section: selected,
        url: "",
        embedded: false,
        originalWindow: true,
        pid: opened.pid,
      };
    }
    return {
      tool: state,
      section: selected,
      url: sectionUrl(manifest, state.endpoint, selected),
      embedded: true,
      originalWindow: false,
    };
  }

  async function openExternalTool(toolId, section) {
    const result = await openEmbedded(toolId, section);
    if (result.url && typeof openExternal === "function") await openExternal(result.url);
    return { ...result, embedded: false };
  }

  function cpaManagementKey() {
    const connection = externalServices?.cpaConnection?.();
    const key = String(connection?.managementKey || "").trim();
    if (!key) throw new Error("Install and start managed CPA before copying its management key");
    return { configured: true, length: key.length, value: key };
  }

  function copyCpaManagementKey(clipboard) {
    const { value, length } = cpaManagementKey();
    if (!clipboard?.writeText) throw new Error("Clipboard is unavailable");
    clipboard.writeText(value);
    return { copied: true, length };
  }

  function dispose() {
    stopControlCenter();
  }

  return Object.freeze({
    snapshot,
    inspect,
    start,
    stop,
    restart,
    openEmbedded,
    openExternalTool,
    cpaManagementKey,
    copyCpaManagementKey,
    dispose,
  });
}

function createOriginalUiController(options = {}) {
  const core = createOriginalUiCore(options);
  if (options.longRun === false) return core;
  return attachCpaCodexLongRun(core, {
    statePath: options.longRun?.statePath || options.statePath || null,
    now: options.now,
    setTimeoutFn: options.setTimeoutFn,
    clearTimeoutFn: options.clearTimeoutFn,
    powerSaveBlocker: options.powerSaveBlocker || options.longRun?.powerSaveBlocker,
    logger: options.logger,
    resumeOnCreate: options.resumeOnCreate !== false,
  });
}

module.exports = {
  TOOL_IDS,
  READY_WAIT_MS,
  createOriginalUiController,
  createOriginalUiCore,
  loadManifest,
  normalizeLoopbackEndpoint,
  sectionUrl,
};
