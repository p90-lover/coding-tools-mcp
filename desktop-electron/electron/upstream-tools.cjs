"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const https = require("node:https");
const path = require("node:path");
const { spawn } = require("node:child_process");

const TOOL_IDS = Object.freeze(["anneal", "paseo"]);
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1"]);
const DEFAULT_PROBE_TIMEOUT_MS = 2_500;
const DEFAULT_START_TIMEOUT_MS = 30_000;
const COMMAND_OUTPUT_LIMIT = 1_048_576;

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
  if (!/^[0-9a-f]{40}$/i.test(String(manifest.commit || ""))) {
    throw new Error(`Upstream tool manifest must pin a full commit: ${toolId}`);
  }
  return Object.freeze({
    ...manifest,
    sections: Object.freeze([...manifest.sections]),
    runtime: Object.freeze({
      managed: manifest.runtime?.managed === true,
      platforms: Object.freeze([...(manifest.runtime?.platforms || [])]),
      prerequisites: Object.freeze([...(manifest.runtime?.prerequisites || [])]),
      provisionCommands: Object.freeze([...(manifest.runtime?.provisionCommands || [])]),
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

function markerPath(root) {
  return path.join(root, "coding-tools-upstream.json");
}

function readManagedMarker(root) {
  try {
    return JSON.parse(fs.readFileSync(markerPath(root), "utf8"));
  } catch {
    return null;
  }
}

function managedCheckoutValid(root, manifest) {
  if (!root || !fs.existsSync(root) || !fs.statSync(root).isDirectory()) return false;
  const marker = readManagedMarker(root);
  return Boolean(
    marker
      && marker.repository === manifest.repository
      && marker.commit === manifest.commit
      && fs.existsSync(path.join(root, manifest.licenseFile)),
  );
}

function resolveRuntimeSource(manifest, {
  env = process.env,
  managedRoot = path.join(process.cwd(), "aiTemp", "upstream-runtime"),
  resourcesPath = process.resourcesPath || "",
  platform = process.platform,
} = {}) {
  const platforms = [...(manifest.runtime?.platforms || [])];
  const supported = platforms.length === 0 || platforms.includes(platform);
  const externalRoot = String(env[manifest.environmentHome] || "").trim();
  const packagedRoot = resourcesPath
    ? path.join(resourcesPath, "upstream", manifest.id, manifest.commit)
    : "";
  const managedPath = path.join(managedRoot, manifest.id, manifest.commit);

  if (externalRoot) {
    return {
      mode: "external",
      root: path.resolve(externalRoot),
      available: fs.existsSync(externalRoot),
      managedRoot: managedPath,
      supported,
      platforms,
    };
  }
  if (packagedRoot && managedCheckoutValid(packagedRoot, manifest)) {
    return {
      mode: "packaged",
      root: packagedRoot,
      available: true,
      managedRoot: managedPath,
      supported,
      platforms,
    };
  }
  if (managedCheckoutValid(managedPath, manifest)) {
    return {
      mode: "managed",
      root: managedPath,
      available: true,
      managedRoot: managedPath,
      supported,
      platforms,
    };
  }
  return {
    mode: "unavailable",
    root: "",
    available: false,
    managedRoot: managedPath,
    supported,
    platforms,
  };
}

function createUpstreamToolController({
  env = process.env,
  logger = null,
  managedRoot = path.join(process.cwd(), "aiTemp", "upstream-runtime"),
  openExternal = null,
  platform = process.platform,
  resourcesPath = process.resourcesPath || "",
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
      provisioning: false,
    });
  }

  function requireTool(toolId) {
    const manifest = manifests.get(toolId);
    if (!manifest) throw new Error(`Unknown upstream tool: ${toolId}`);
    return manifest;
  }

  function sourceFor(manifest) {
    return resolveRuntimeSource(manifest, {
      env,
      managedRoot,
      resourcesPath,
      platform,
    });
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
    const source = sourceFor(manifest);
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
      sourceConfigured: source.mode !== "unavailable",
      sourceAvailable: source.available,
      sourcePath: source.root || null,
      runtimeMode: source.mode,
      managedRoot: source.managedRoot,
      prerequisites: [...manifest.runtime.prerequisites],
      platforms: [...source.platforms],
      supported: source.supported,
      provisionable: manifest.runtime.managed && source.supported,
      provisioning: state.provisioning,
    };
  }

  function snapshot() {
    return { version: 1, tools: TOOL_IDS.map(project) };
  }

  async function inspect(toolId) {
    requireTool(toolId);
    const state = runtime.get(toolId);
    const result = await probeEndpoint(state.endpoint);
    const active = processes.get(toolId) || [];
    publish(toolId, {
      status: result.reachable ? "ready" : active.length > 0 ? "starting" : "offline",
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

  function appendOutput(current, chunk) {
    const next = `${current}${String(chunk || "")}`;
    return next.length <= COMMAND_OUTPUT_LIMIT ? next : next.slice(-COMMAND_OUTPUT_LIMIT);
  }

  function runCommand(executable, args, { cwd, commandEnv = env } = {}) {
    return new Promise((resolve, reject) => {
      let stdout = "";
      let stderr = "";
      const child = spawnProcess(executable, args, {
        cwd,
        env: { ...commandEnv },
        shell: platform === "win32",
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
      child.stdout?.on("data", (chunk) => { stdout = appendOutput(stdout, chunk); });
      child.stderr?.on("data", (chunk) => { stderr = appendOutput(stderr, chunk); });
      child.once("error", reject);
      child.once("exit", (code, signal) => {
        if (code === 0) {
          resolve({ stdout, stderr });
          return;
        }
        const detail = stderr.trim() || stdout.trim() || String(signal || code || "unknown");
        reject(new Error(`${executable} ${args.join(" ")} failed: ${detail.slice(-2_000)}`));
      });
    });
  }

  function moveIntoTrash(sourcePath, label) {
    if (!sourcePath || !fs.existsSync(sourcePath)) return null;
    const trashRoot = path.join(managedRoot, "aiTemp", "Trash");
    fs.mkdirSync(trashRoot, { recursive: true });
    const destination = path.join(
      trashRoot,
      `${label}-${Date.now()}-${crypto.randomUUID()}`,
    );
    fs.renameSync(sourcePath, destination);
    return destination;
  }

  async function provision(toolId) {
    const manifest = requireTool(toolId);
    const source = sourceFor(manifest);
    if (!manifest.runtime.managed) {
      throw new Error(`${manifest.name} does not provide a managed runtime contract`);
    }
    if (!source.supported) {
      throw new Error(
        `${manifest.name} cannot be provisioned on ${platform}. Prerequisites: ${manifest.runtime.prerequisites.join(", ")}`,
      );
    }
    if (source.mode === "managed" || source.mode === "packaged") return project(toolId);

    const target = source.managedRoot;
    if (fs.existsSync(target)) moveIntoTrash(target, `${toolId}-invalid-runtime`);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const stagingRoot = path.join(managedRoot, "aiTemp");
    fs.mkdirSync(stagingRoot, { recursive: true });
    const staging = path.join(stagingRoot, `${toolId}-${Date.now()}-${crypto.randomUUID()}`);
    fs.mkdirSync(staging, { recursive: true });
    publish(toolId, { provisioning: true, status: "starting", error: null });

    try {
      const repositoryUrl = `https://github.com/${manifest.repository}.git`;
      await runCommand("git", ["init"], { cwd: staging });
      await runCommand("git", ["remote", "add", "origin", repositoryUrl], { cwd: staging });
      await runCommand("git", ["fetch", "--depth", "1", "origin", manifest.commit], { cwd: staging });
      await runCommand("git", ["checkout", "--detach", "FETCH_HEAD"], { cwd: staging });
      const revision = await runCommand("git", ["rev-parse", "HEAD"], { cwd: staging });
      if (revision.stdout.trim().toLowerCase() !== manifest.commit.toLowerCase()) {
        throw new Error(`${manifest.name} checkout does not match pinned commit ${manifest.commit}`);
      }
      if (!fs.existsSync(path.join(staging, manifest.licenseFile))) {
        throw new Error(`${manifest.name} checkout is missing ${manifest.licenseFile}`);
      }

      for (const command of manifest.runtime.provisionCommands) {
        if (!command?.executable || !Array.isArray(command.arguments)) {
          throw new Error(`${manifest.name} has an invalid provision command`);
        }
        await runCommand(command.executable, command.arguments, {
          cwd: staging,
          commandEnv: { ...env, ...(command.environment || {}) },
        });
      }

      fs.writeFileSync(markerPath(staging), `${JSON.stringify({
        version: 1,
        id: manifest.id,
        repository: manifest.repository,
        commit: manifest.commit,
        license: manifest.license,
        provisionedAt: now(),
      }, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
      fs.renameSync(staging, target);
      publish(toolId, {
        provisioning: false,
        status: "offline",
        checkedAt: now(),
        error: null,
      });
      return project(toolId);
    } catch (error) {
      const retained = moveIntoTrash(staging, `${toolId}-failed-provision`);
      publish(toolId, {
        provisioning: false,
        status: "error",
        checkedAt: now(),
        error: `${error instanceof Error ? error.message : String(error)}${retained ? `; retained at ${retained}` : ""}`,
      });
      throw error;
    }
  }

  function launchCommands(manifest) {
    if (Array.isArray(manifest.launch?.processes) && manifest.launch.processes.length > 0) {
      return manifest.launch.processes;
    }
    if (manifest.launch?.executable && Array.isArray(manifest.launch.arguments)) {
      return [manifest.launch];
    }
    throw new Error(`${manifest.name} has no launch command`);
  }

  function allChildrenExited(children) {
    return children.every((child) => child.exitCode !== null || child.signalCode !== null);
  }

  async function start(toolId) {
    const manifest = requireTool(toolId);
    const existing = await inspect(toolId);
    if (existing.status === "ready") return existing;
    if ((processes.get(toolId) || []).length > 0) return waitUntilReady(toolId);

    const source = sourceFor(manifest);
    if (!source.supported) {
      throw new Error(
        `${manifest.name} local runtime is unsupported on ${platform}. Prerequisites: ${manifest.runtime.prerequisites.join(", ")}`,
      );
    }
    if (!source.available || !source.root) {
      throw new Error(
        `${manifest.name} runtime is unavailable. Provision the pinned ${manifest.commit} runtime or set ${manifest.environmentHome}.`,
      );
    }

    const commands = launchCommands(manifest);
    const children = [];
    for (const command of commands) {
      const child = spawnProcess(command.executable, command.arguments, {
        cwd: source.root,
        env: { ...env, ...(manifest.launch.environment || {}), ...(command.environment || {}) },
        shell: platform === "win32",
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
      children.push(child);
      const logChunk = (stream, chunk) => {
        const message = String(chunk || "").trim().slice(-2_000);
        if (message) logger?.debug?.(`upstream.${toolId}.${stream}`, { message });
      };
      child.stdout?.on("data", (chunk) => logChunk("stdout", chunk));
      child.stderr?.on("data", (chunk) => logChunk("stderr", chunk));
      child.once("error", (error) => {
        publish(toolId, {
          status: "error",
          checkedAt: now(),
          error: error instanceof Error ? error.message : String(error),
        });
      });
      child.once("exit", (code, signal) => {
        if (allChildrenExited(children)) {
          processes.delete(toolId);
          publish(toolId, {
            status: "offline",
            pid: null,
            checkedAt: now(),
            error: code === 0 ? null : `${manifest.name} process exited (${code ?? signal ?? "unknown"})`,
          });
        }
      });
    }

    processes.set(toolId, children);
    publish(toolId, {
      status: "starting",
      pid: children[0]?.pid || null,
      startedAt: now(),
      error: null,
    });
    return waitUntilReady(toolId);
  }

  async function terminateChild(child) {
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
      timer = setTimeout(() => finish(false), 5_000);
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

  async function stop(toolId) {
    requireTool(toolId);
    const children = processes.get(toolId) || [];
    await Promise.all(children.map(terminateChild));
    processes.delete(toolId);
    publish(toolId, { status: "offline", pid: null, checkedAt: now(), error: null });
    return project(toolId);
  }

  async function restart(toolId) {
    requireTool(toolId);
    await stop(toolId);
    return start(toolId);
  }

  function dispose() {
    for (const [toolId, children] of processes) {
      for (const child of children) {
        if (!child.killed) child.kill("SIGTERM");
      }
      publish(toolId, { status: "offline", pid: null, checkedAt: now() });
    }
    processes.clear();
  }

  return Object.freeze({
    snapshot,
    inspect,
    setEndpoint,
    provision,
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
  normalizeLoopbackEndpoint,
  probeEndpoint,
  resolveRuntimeSource,
  sectionUrl,
};
