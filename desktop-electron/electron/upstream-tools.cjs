"use strict";

const fs = require("node:fs");
const http = require("node:http");
const https = require("node:https");
const path = require("node:path");
const { spawn } = require("node:child_process");

const TOOL_IDS = Object.freeze(["anneal", "paseo"]);
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1"]);
const DEFAULT_PROBE_TIMEOUT_MS = 2_500;
const DEFAULT_START_TIMEOUT_MS = 30_000;

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
  return Object.freeze({ ...manifest, sections: Object.freeze([...manifest.sections]) });
}

function normalizeLoopbackEndpoint(value) {
  const parsed = new URL(String(value || ""));
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("Upstream tool endpoints must use HTTP or HTTPS");
  }
  if (!LOOPBACK_HOSTS.has(parsed.hostname)) {
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
  if (!LOOPBACK_HOSTS.has(target.hostname)) {
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

function createUpstreamToolController({
  env = process.env,
  logger = null,
  openExternal = null,
  spawnProcess = spawn,
  now = () => new Date().toISOString(),
} = {}) {
  const manifests = new Map(TOOL_IDS.map((toolId) => [toolId, loadManifest(toolId)]));
  const processes = new Map();
  const runtime = new Map();

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

  function project(toolId) {
    const manifest = requireTool(toolId);
    const state = runtime.get(toolId);
    const sourceHome = env[manifest.environmentHome]?.trim() || "";
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
      sourceConfigured: Boolean(sourceHome),
      sourceAvailable: Boolean(sourceHome && fs.existsSync(sourceHome)),
    };
  }

  function snapshot() {
    return { version: 1, tools: TOOL_IDS.map(project) };
  }

  async function inspect(toolId) {
    requireTool(toolId);
    const state = runtime.get(toolId);
    const result = await probeEndpoint(state.endpoint);
    publish(toolId, {
      status: result.reachable ? "ready" : processes.has(toolId) ? "starting" : "offline",
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
    if (processes.has(toolId)) return waitUntilReady(toolId);

    const sourceHome = env[manifest.environmentHome]?.trim() || "";
    if (!sourceHome || !fs.existsSync(sourceHome)) {
      throw new Error(
        `${manifest.name} source is not configured. Set ${manifest.environmentHome} to the pinned ${manifest.commit} checkout.`,
      );
    }
    const launch = manifest.launch;
    if (!launch?.executable || !Array.isArray(launch.arguments)) {
      throw new Error(`${manifest.name} has no launch command`);
    }

    const child = spawnProcess(launch.executable, launch.arguments, {
      cwd: sourceHome,
      env: { ...env },
      shell: process.platform === "win32",
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    processes.set(toolId, child);
    publish(toolId, {
      status: "starting",
      pid: child.pid || null,
      startedAt: now(),
      error: null,
    });

    const logChunk = (stream, chunk) => {
      const message = String(chunk || "").trim().slice(-2_000);
      if (message) logger?.debug?.(`upstream.${toolId}.${stream}`, { message });
    };
    child.stdout?.on("data", (chunk) => logChunk("stdout", chunk));
    child.stderr?.on("data", (chunk) => logChunk("stderr", chunk));
    child.once("error", (error) => {
      processes.delete(toolId);
      publish(toolId, {
        status: "error",
        pid: null,
        checkedAt: now(),
        error: error instanceof Error ? error.message : String(error),
      });
    });
    child.once("exit", (code, signal) => {
      processes.delete(toolId);
      publish(toolId, {
        status: "offline",
        pid: null,
        checkedAt: now(),
        error: code === 0 ? null : `${manifest.name} exited (${code ?? signal ?? "unknown"})`,
      });
    });

    return waitUntilReady(toolId);
  }

  async function stop(toolId) {
    requireTool(toolId);
    const child = processes.get(toolId);
    if (child && !child.killed) child.kill("SIGTERM");
    processes.delete(toolId);
    publish(toolId, { status: "offline", pid: null, checkedAt: now(), error: null });
    return project(toolId);
  }

  function dispose() {
    for (const [toolId, child] of processes) {
      if (!child.killed) child.kill("SIGTERM");
      publish(toolId, { status: "offline", pid: null, checkedAt: now() });
    }
    processes.clear();
  }

  return Object.freeze({
    snapshot,
    inspect,
    setEndpoint,
    start,
    stop,
    openEmbeddedTool,
    openExternalTool,
    dispose,
  });
}

module.exports = {
  TOOL_IDS,
  createUpstreamToolController,
  normalizeLoopbackEndpoint,
  probeEndpoint,
  sectionUrl,
};
