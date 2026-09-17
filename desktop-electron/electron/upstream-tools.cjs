"use strict";

const fs = require("node:fs");
const http = require("node:http");
const https = require("node:https");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");

const TOOL_IDS = Object.freeze(["anneal", "paseo"]);
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1"]);
const DEFAULT_PROBE_TIMEOUT_MS = 2_500;
const DEFAULT_START_TIMEOUT_MS = 120_000;
const DEFAULT_STOP_TIMEOUT_MS = 5_000;
const MAX_LOG_BYTES = 16_000;

function manifestPath(toolId) {
  return path.join(__dirname, "..", "vendor", "upstream", `${toolId}.json`);
}

function loadManifest(toolId) {
  if (!TOOL_IDS.includes(toolId)) throw new Error(`Unknown upstream tool: ${toolId}`);
  const filePath = manifestPath(toolId);
  const manifest = JSON.parse(fs.readFileSync(filePath, "utf8"));
  if (manifest.id !== toolId) throw new Error(`Upstream tool manifest ID mismatch: ${toolId}`);
  if (!Array.isArray(manifest.sections) || manifest.sections.length === 0) {
    throw new Error(`Upstream tool manifest has no sections: ${toolId}`);
  }
  if (!manifest.managed || manifest.managed.strategy !== "pinned-source") {
    throw new Error(`Upstream tool has no managed pinned-source contract: ${toolId}`);
  }
  if (!Array.isArray(manifest.managed.services) || manifest.managed.services.length === 0) {
    throw new Error(`Upstream tool has no managed service topology: ${toolId}`);
  }
  return Object.freeze({
    ...manifest,
    sections: Object.freeze([...manifest.sections]),
    managed: Object.freeze({
      ...manifest.managed,
      prerequisites: Object.freeze([...(manifest.managed.prerequisites || [])]),
      setup: Object.freeze([...(manifest.managed.setup || [])]),
      services: Object.freeze([...(manifest.managed.services || [])]),
      stop: Object.freeze([...(manifest.managed.stop || [])]),
    }),
  });
}

function canonicalHostname(value) {
  const hostname = String(value || "").toLowerCase();
  return hostname.startsWith("[") && hostname.endsWith("]")
    ? hostname.slice(1, -1)
    : hostname;
}

function isLoopbackHostname(value) {
  return LOOPBACK_HOSTS.has(canonicalHostname(value));
}

function normalizeLoopbackEndpoint(value) {
  const parsed = new URL(String(value || ""));
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("Upstream tool endpoints must use HTTP or HTTPS");
  }
  if (!isLoopbackHostname(parsed.hostname)) {
    throw new Error("Upstream tools are restricted to 127.0.0.1 or [::1]");
  }
  if (parsed.username || parsed.password) {
    throw new Error("Upstream tool endpoints must not contain credentials");
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
  if (!isLoopbackHostname(target.hostname)) {
    throw new Error("Upstream section URL escaped the loopback boundary");
  }
  return target.toString();
}

function probeEndpoint(endpoint, timeoutMs = DEFAULT_PROBE_TIMEOUT_MS) {
  const normalized = normalizeLoopbackEndpoint(endpoint);
  const target = new URL(normalized);
  const transport = target.protocol === "https:" ? https : http;
  return new Promise((resolve) => {
    const startedAt = Date.now();
    const request = transport.request(target, {
      method: "GET",
      headers: { accept: "text/html,application/json;q=0.9,*/*;q=0.1" },
      timeout: timeoutMs,
    }, (response) => {
      response.resume();
      resolve({
        reachable: true,
        statusCode: response.statusCode || 0,
        latencyMs: Date.now() - startedAt,
      });
    });
    request.once("timeout", () => request.destroy(new Error("probe timed out")));
    request.once("error", (error) => resolve({
      reachable: false,
      statusCode: 0,
      latencyMs: Date.now() - startedAt,
      error: error instanceof Error ? error.message : String(error),
    }));
    request.end();
  });
}

function defaultIntegrationRoot(env) {
  const configured = String(env.CODING_TOOLS_INTEGRATIONS_HOME || "").trim();
  if (configured) return path.resolve(configured);
  const dataRoot = String(env.APPDATA || env.XDG_DATA_HOME || "").trim()
    || path.join(os.homedir(), ".local", "share");
  return path.join(dataRoot, "Coding Tools", "integrations");
}

function safeSegment(value) {
  return String(value || "unknown").replace(/[^A-Za-z0-9._-]+/g, "-").slice(0, 96);
}

function timestampSegment(nowValue) {
  return safeSegment(String(nowValue).replace(/[:]/g, "-"));
}

function readJsonIfPresent(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function quoteForBash(value) {
  return `'${String(value).replaceAll("'", `'\"'\"'`)}'`;
}

function createUpstreamToolController({
  env = process.env,
  logger = null,
  openExternal = null,
  spawnProcess = spawn,
  now = () => new Date().toISOString(),
  platform = process.platform,
  integrationRoot = defaultIntegrationRoot(env),
} = {}) {
  const manifests = new Map(TOOL_IDS.map((toolId) => [toolId, loadManifest(toolId)]));
  const processes = new Map();
  const runtime = new Map();
  const aiTempRoot = path.join(integrationRoot, "aiTemp");
  const trashRoot = path.join(integrationRoot, "Trash");

  for (const [toolId, manifest] of manifests) {
    const configured = env[manifest.environmentEndpoint];
    const endpoint = normalizeLoopbackEndpoint(configured || manifest.defaultEndpoint);
    runtime.set(toolId, {
      endpoint,
      status: "unknown",
      pid: null,
      startedAt: null,
      checkedAt: null,
      latencyMs: null,
      error: null,
      installStatus: "idle",
      installStep: null,
    });
  }

  function requireTool(toolId) {
    const manifest = manifests.get(toolId);
    if (!manifest) throw new Error(`Unknown upstream tool: ${toolId}`);
    return manifest;
  }

  function publish(toolId, patch) {
    const current = runtime.get(toolId);
    const next = { ...current, ...patch };
    runtime.set(toolId, next);
    return next;
  }

  function modeFor(manifest) {
    return manifest.managed.platformModes?.[platform] || "native";
  }

  function explicitSourceHome(manifest) {
    return String(env[manifest.environmentHome] || "").trim();
  }

  function managedSourceHome(manifest) {
    return path.join(integrationRoot, manifest.id, safeSegment(manifest.commit), "source");
  }

  function markerPath(sourceHome) {
    return path.join(sourceHome, ".coding-tools-integration.json");
  }

  function sourceIsPinned(sourceHome, manifest) {
    if (!sourceHome || !fs.existsSync(sourceHome)) return false;
    const marker = readJsonIfPresent(markerPath(sourceHome));
    return marker?.schemaVersion === 1
      && marker.id === manifest.id
      && marker.commit === manifest.commit
      && marker.version === manifest.version;
  }

  function sourceDetails(manifest) {
    const explicit = explicitSourceHome(manifest);
    if (explicit) {
      return {
        home: path.resolve(explicit),
        mode: "external-pinned-source",
        configured: true,
        available: fs.existsSync(explicit),
      };
    }
    const home = managedSourceHome(manifest);
    return {
      home,
      mode: `managed-${modeFor(manifest)}`,
      configured: Boolean(manifest.managed.autoInstall),
      available: sourceIsPinned(home, manifest),
    };
  }

  function serviceRecords(toolId) {
    const manifest = requireTool(toolId);
    const active = processes.get(toolId) || new Map();
    return manifest.managed.services.map((service) => {
      const child = active.get(service.id) || null;
      return {
        id: service.id,
        detached: service.detached === true,
        pid: child?.pid || null,
        running: Boolean(child && child.exitCode === null && child.signalCode === null),
      };
    });
  }

  function project(toolId) {
    const manifest = requireTool(toolId);
    const state = runtime.get(toolId);
    const source = sourceDetails(manifest);
    return {
      id: manifest.id,
      name: manifest.name,
      repository: manifest.repository,
      commit: manifest.commit,
      version: manifest.version || null,
      license: manifest.license,
      sections: [...manifest.sections],
      endpoint: state.endpoint,
      status: state.status,
      pid: state.pid,
      startedAt: state.startedAt,
      checkedAt: state.checkedAt,
      latencyMs: state.latencyMs,
      error: state.error,
      sourceConfigured: source.configured,
      sourceAvailable: source.available,
      sourceMode: source.mode,
      managedHome: source.home,
      installStatus: state.installStatus,
      installStep: state.installStep,
      platformMode: modeFor(manifest),
      services: serviceRecords(toolId),
      prerequisites: manifest.managed.prerequisites.map((entry) => entry.id),
    };
  }

  function snapshot() {
    return { version: 1, tools: TOOL_IDS.map(project) };
  }

  async function inspect(toolId) {
    requireTool(toolId);
    const state = runtime.get(toolId);
    const result = await probeEndpoint(state.endpoint);
    const active = processes.get(toolId);
    publish(toolId, {
      status: result.reachable ? "ready" : active?.size ? "starting" : "offline",
      checkedAt: now(),
      latencyMs: result.latencyMs,
      error: result.reachable ? null : result.error || "The local service is unavailable",
    });
    return project(toolId);
  }

  function setEndpoint(toolId, endpoint) {
    requireTool(toolId);
    publish(toolId, {
      endpoint: normalizeLoopbackEndpoint(endpoint),
      status: "unknown",
      checkedAt: null,
      latencyMs: null,
      error: null,
    });
    return project(toolId);
  }

  async function openEmbeddedTool(toolId, section) {
    const manifest = requireTool(toolId);
    const selectedSection = section || manifest.sections[0];
    const state = await inspect(toolId);
    return {
      tool: state,
      section: selectedSection,
      url: sectionUrl(manifest, state.endpoint, selectedSection),
      embedded: true,
    };
  }

  async function openExternalTool(toolId, section) {
    if (typeof openExternal !== "function") {
      throw new Error("External upstream-tool navigation is unavailable");
    }
    const result = await openEmbeddedTool(toolId, section);
    await openExternal(result.url);
    return { ...result, embedded: false };
  }

  function commandSpec(step, { cwd, mode, extraEnvironment = {} }) {
    const executable = String(step.executable || "").trim();
    const args = Array.isArray(step.arguments) ? step.arguments.map(String) : [];
    if (!executable) throw new Error(`Managed integration step ${step.id || "unknown"} has no executable`);
    const environment = { ...env, ...(step.environment || {}), ...extraEnvironment };
    const useManagedMode = step.execution === "managed-mode";

    if (mode === "wsl2" && useManagedMode) {
      const exported = Object.entries({ ...(step.environment || {}), ...extraEnvironment })
        .map(([key, value]) => `export ${key}=${quoteForBash(value)}`)
        .join("; ");
      const command = [executable, ...args].map(quoteForBash).join(" ");
      const script = exported ? `${exported}; exec ${command}` : `exec ${command}`;
      return {
        executable: "wsl.exe",
        arguments: ["--cd", cwd, "--exec", "bash", "-lc", script],
        options: {
          env,
          shell: false,
          windowsHide: true,
          stdio: ["ignore", "pipe", "pipe"],
        },
      };
    }

    return {
      executable,
      arguments: args,
      options: {
        cwd,
        env: environment,
        shell: platform === "win32",
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      },
    };
  }

  function appendOutput(current, chunk) {
    const next = `${current}${String(chunk || "")}`;
    return next.length > MAX_LOG_BYTES ? next.slice(-MAX_LOG_BYTES) : next;
  }

  function runStep(step, context) {
    const spec = commandSpec(step, context);
    return new Promise((resolve, reject) => {
      const child = spawnProcess(spec.executable, spec.arguments, spec.options);
      let stdout = "";
      let stderr = "";
      let settled = false;
      const fail = (error) => {
        if (settled) return;
        settled = true;
        reject(error);
      };
      child.stdout?.on("data", (chunk) => {
        stdout = appendOutput(stdout, chunk);
        const message = String(chunk || "").trim().slice(-2_000);
        if (message) logger?.debug?.("upstream.setup.stdout", { step: step.id, message });
      });
      child.stderr?.on("data", (chunk) => {
        stderr = appendOutput(stderr, chunk);
        const message = String(chunk || "").trim().slice(-2_000);
        if (message) logger?.debug?.("upstream.setup.stderr", { step: step.id, message });
      });
      child.once("error", (error) => fail(error));
      child.once("exit", (code, signal) => {
        if (settled) return;
        settled = true;
        if (code === 0) {
          resolve({ stdout, stderr });
          return;
        }
        const detail = stderr.trim() || stdout.trim() || signal || `exit ${code}`;
        reject(new Error(`${step.id || step.executable} failed: ${detail}`));
      });
    });
  }

  async function runPrerequisites(manifest, sourceHome) {
    const mode = modeFor(manifest);
    if (mode === "wsl2") {
      await runStep(
        { id: "wsl2", executable: "wsl.exe", arguments: ["--status"] },
        { cwd: sourceHome, mode: "native" },
      );
    }
    for (const prerequisite of manifest.managed.prerequisites) {
      await runStep(prerequisite, { cwd: sourceHome, mode });
    }
  }

  async function runSetupSteps(manifest, sourceHome) {
    const mode = modeFor(manifest);
    for (const step of manifest.managed.setup) {
      publish(manifest.id, { installStatus: "installing", installStep: step.id, error: null });
      await runStep(step, { cwd: sourceHome, mode });
    }
  }

  function moveToTrash(sourcePath, manifest, reason) {
    if (!sourcePath || !fs.existsSync(sourcePath)) return null;
    const destination = path.join(
      trashRoot,
      manifest.id,
      `${timestampSegment(now())}-${safeSegment(reason)}-${safeSegment(manifest.commit.slice(0, 12))}`,
    );
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.renameSync(sourcePath, destination);
    writeJson(path.join(destination, "CODING_TOOLS_TRASH_RECORD.json"), {
      schemaVersion: 1,
      id: manifest.id,
      commit: manifest.commit,
      reason,
      movedAt: now(),
    });
    return destination;
  }

  async function ensureManagedSource(toolId) {
    const manifest = requireTool(toolId);
    const explicit = explicitSourceHome(manifest);
    if (explicit) {
      const sourceHome = path.resolve(explicit);
      if (!fs.existsSync(sourceHome)) {
        throw new Error(`${manifest.environmentHome} points to a missing directory: ${sourceHome}`);
      }
      await runPrerequisites(manifest, sourceHome);
      return sourceHome;
    }
    if (!manifest.managed.autoInstall) {
      throw new Error(`${manifest.name} managed installation is disabled`);
    }

    const target = managedSourceHome(manifest);
    if (sourceIsPinned(target, manifest)) {
      await runPrerequisites(manifest, target);
      return target;
    }

    publish(toolId, { installStatus: "preparing", installStep: "prerequisites", error: null });
    await runPrerequisites(manifest, integrationRoot);

    if (fs.existsSync(target)) moveToTrash(target, manifest, "unpinned-source");

    const stagingRoot = path.join(
      aiTempRoot,
      `${manifest.id}-${timestampSegment(now())}-${safeSegment(manifest.commit.slice(0, 12))}`,
    );
    const stagedSource = path.join(stagingRoot, "source");
    fs.mkdirSync(stagingRoot, { recursive: true });
    writeJson(path.join(stagingRoot, "INSTALL_REQUEST.json"), {
      schemaVersion: 1,
      id: manifest.id,
      repository: manifest.managed.source.repositoryUrl,
      commit: manifest.managed.source.commit,
      requestedAt: now(),
    });

    try {
      publish(toolId, { installStatus: "installing", installStep: "git-clone" });
      await runStep({
        id: "git-clone",
        executable: "git",
        arguments: [
          "clone",
          "--filter=blob:none",
          "--no-checkout",
          manifest.managed.source.repositoryUrl,
          stagedSource,
        ],
      }, { cwd: stagingRoot, mode: "native" });
      await runStep({
        id: "git-fetch-pinned-commit",
        executable: "git",
        arguments: ["-C", stagedSource, "fetch", "--depth", "1", "origin", manifest.commit],
      }, { cwd: stagingRoot, mode: "native" });
      await runStep({
        id: "git-checkout-pinned-commit",
        executable: "git",
        arguments: ["-C", stagedSource, "checkout", "--detach", manifest.commit],
      }, { cwd: stagingRoot, mode: "native" });

      await runSetupSteps(manifest, stagedSource);
      writeJson(markerPath(stagedSource), {
        schemaVersion: 1,
        id: manifest.id,
        repository: manifest.repository,
        commit: manifest.commit,
        version: manifest.version,
        installedAt: now(),
        platformMode: modeFor(manifest),
      });

      fs.mkdirSync(path.dirname(target), { recursive: true });
      if (fs.existsSync(target)) moveToTrash(target, manifest, "replaced-before-activate");
      fs.renameSync(stagedSource, target);
      writeJson(path.join(stagingRoot, "COMPLETED.json"), {
        schemaVersion: 1,
        id: manifest.id,
        target,
        completedAt: now(),
      });
      publish(toolId, { installStatus: "ready", installStep: null, error: null });
      return target;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      writeJson(path.join(stagingRoot, "FAILED.json"), {
        schemaVersion: 1,
        id: manifest.id,
        failedAt: now(),
        error: message,
      });
      publish(toolId, { installStatus: "error", installStep: null, error: message });
      throw error;
    }
  }

  function attachServiceLogging(toolId, serviceId, child) {
    const logChunk = (stream, chunk) => {
      const message = String(chunk || "").trim().slice(-2_000);
      if (message) logger?.debug?.(`upstream.${toolId}.${serviceId}.${stream}`, { message });
    };
    child.stdout?.on("data", (chunk) => logChunk("stdout", chunk));
    child.stderr?.on("data", (chunk) => logChunk("stderr", chunk));
  }

  async function startServiceTopology(toolId, sourceHome) {
    const manifest = requireTool(toolId);
    const mode = modeFor(manifest);
    const active = new Map();
    processes.set(toolId, active);

    for (const service of manifest.managed.services) {
      if (service.detached === true) {
        await runStep(service, { cwd: sourceHome, mode });
        continue;
      }
      const spec = commandSpec(service, { cwd: sourceHome, mode });
      const child = spawnProcess(spec.executable, spec.arguments, spec.options);
      active.set(service.id, child);
      attachServiceLogging(toolId, service.id, child);
      child.once("error", (error) => {
        active.delete(service.id);
        publish(toolId, {
          status: "error",
          pid: active.values().next().value?.pid || null,
          checkedAt: now(),
          error: `${service.id}: ${error instanceof Error ? error.message : String(error)}`,
        });
      });
      child.once("exit", (code, signal) => {
        active.delete(service.id);
        const remaining = active.values().next().value || null;
        publish(toolId, {
          status: active.size ? runtime.get(toolId).status : "offline",
          pid: remaining?.pid || null,
          checkedAt: now(),
          error: code === 0 ? null : `${service.id} exited (${code ?? signal ?? "unknown"})`,
        });
      });
      publish(toolId, {
        status: "starting",
        pid: active.values().next().value?.pid || null,
        startedAt: runtime.get(toolId).startedAt || now(),
        error: null,
      });
    }
    return active;
  }

  async function waitUntilReady(toolId, timeoutMs = DEFAULT_START_TIMEOUT_MS) {
    const deadline = Date.now() + timeoutMs;
    let latest = await inspect(toolId);
    while (latest.status !== "ready" && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 500));
      latest = await inspect(toolId);
    }
    if (latest.status !== "ready") {
      throw new Error(`${latest.name} did not become reachable at ${latest.endpoint}`);
    }
    return latest;
  }

  async function start(toolId) {
    const manifest = requireTool(toolId);
    const existing = await inspect(toolId);
    if (existing.status === "ready") return existing;
    if (processes.get(toolId)?.size) return waitUntilReady(toolId);

    publish(toolId, {
      status: "starting",
      startedAt: now(),
      installStatus: "preparing",
      installStep: "source",
      error: null,
    });
    try {
      const sourceHome = await ensureManagedSource(toolId);
      publish(toolId, { installStatus: "ready", installStep: null });
      await startServiceTopology(toolId, sourceHome);
      return await waitUntilReady(toolId, manifest.managed.startTimeoutMs || DEFAULT_START_TIMEOUT_MS);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      publish(toolId, {
        status: "error",
        pid: null,
        checkedAt: now(),
        error: message,
      });
      throw error;
    }
  }

  async function killChildBounded(child) {
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    const exited = await new Promise((resolve) => {
      let settled = false;
      let timer = null;
      const finish = (value) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        child.removeListener("exit", onExit);
        child.removeListener("error", onError);
        resolve(value);
      };
      const onExit = () => finish(true);
      const onError = () => finish(true);
      child.once("exit", onExit);
      child.once("error", onError);
      timer = setTimeout(() => finish(false), DEFAULT_STOP_TIMEOUT_MS);
      timer.unref?.();
      try {
        if (!child.kill("SIGTERM")) finish(false);
      } catch {
        finish(false);
      }
    });
    if (!exited && child.exitCode === null && child.signalCode === null) {
      try { child.kill("SIGKILL"); } catch {}
    }
  }

  async function runStopSteps(manifest, sourceHome) {
    const mode = modeFor(manifest);
    for (const step of manifest.managed.stop) {
      try {
        await runStep(step, { cwd: sourceHome, mode });
      } catch (error) {
        logger?.warn?.("upstream.stop.step_failed", {
          toolId: manifest.id,
          step: step.id,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  async function stop(toolId) {
    const manifest = requireTool(toolId);
    const active = processes.get(toolId) || new Map();
    const children = [...active.values()].reverse();
    for (const child of children) await killChildBounded(child);
    processes.delete(toolId);

    const source = sourceDetails(manifest);
    if (source.available || (source.mode === "external-pinned-source" && fs.existsSync(source.home))) {
      await runStopSteps(manifest, source.home);
    }
    publish(toolId, {
      status: "offline",
      pid: null,
      checkedAt: now(),
      error: null,
      installStep: null,
    });
    return project(toolId);
  }

  async function restart(toolId) {
    requireTool(toolId);
    await stop(toolId);
    return start(toolId);
  }

  function dispose() {
    for (const [toolId, active] of processes) {
      for (const child of active.values()) {
        if (!child.killed) {
          try { child.kill("SIGTERM"); } catch {}
        }
      }
      publish(toolId, { status: "offline", pid: null, checkedAt: now() });
      const manifest = requireTool(toolId);
      const source = sourceDetails(manifest);
      if (source.available) void runStopSteps(manifest, source.home);
    }
    processes.clear();
  }

  return Object.freeze({
    snapshot,
    inspect,
    setEndpoint,
    start,
    stop,
    restart,
    openEmbeddedTool,
    openExternalTool,
    dispose,
  });
}

module.exports = {
  TOOL_IDS,
  createUpstreamToolController,
  defaultIntegrationRoot,
  loadManifest,
  normalizeLoopbackEndpoint,
  probeEndpoint,
  sectionUrl,
};
