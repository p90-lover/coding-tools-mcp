"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { Readable } = require("node:stream");
const { pipeline } = require("node:stream/promises");
const { spawn, spawnSync } = require("node:child_process");
const { writePrivateFileAtomic } = require("./atomic-file.cjs");

const COMPONENT_IDS = Object.freeze([
  "codex-router",
  "commandcode-proxy",
  "cpa",
  "paseo",
  "anneal",
]);
const COMPONENT_ID_SET = new Set(COMPONENT_IDS);
const INSTALL_STATES = Object.freeze([
  "not-installed",
  "installing",
  "installed",
  "repair-required",
  "external",
  "error",
]);
const INSTALL_STATE_SET = new Set(INSTALL_STATES);
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1"]);
const ALLOWED_STEP_KINDS = new Set(["download", "verify", "git-checkout", "assert-file", "command", "activate"]);
const SAFE_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;
const FORBIDDEN_COMMANDS = new Set([
  "del",
  "erase",
  "rd",
  "remove-item",
  "rmdir",
  "rm",
  "shred",
  "unlink",
]);
const SHELL_COMMANDS = new Set(["bash", "cmd", "powershell", "pwsh", "sh"]);
const DESTRUCTIVE_SHELL_PATTERN = /(?:^|[;&|\s])(?:del|erase|rd|remove-item|rmdir|rm|shred|unlink)(?:$|[;&|\s])/iu;
const SHA256 = /^[a-f0-9]{64}$/;
const COMMIT_SHA = /^[a-f0-9]{40}$/;
const MAX_DOWNLOAD_BYTES = 512 * 1024 * 1024;
const DEFAULT_COMMAND_TIMEOUT_MS = 30 * 60_000;
const DEFAULT_STOP_TIMEOUT_MS = 8_000;
const MARKER_NAME = ".coding-tools-managed-component.json";
const SECRET_VERSION = 1;

function requiredComponentId(value) {
  const id = typeof value === "string" ? value.trim() : "";
  if (!COMPONENT_ID_SET.has(id)) throw new Error(`Unknown managed component: ${id || "missing"}`);
  return id;
}

function canonicalHost(value) {
  return String(value || "").replace(/^\[|\]$/g, "").toLowerCase();
}

function assertLoopbackUrl(value, label) {
  let parsed;
  try {
    parsed = new URL(String(value || ""));
  } catch {
    throw new Error(`${label} must be a valid URL`);
  }
  if (!new Set(["http:", "https:", "ws:", "wss:"]).has(parsed.protocol)) {
    throw new Error(`${label} uses an unsupported protocol`);
  }
  if (!LOOPBACK_HOSTS.has(canonicalHost(parsed.hostname))) {
    throw new Error(`${label} must use a loopback host`);
  }
  if (parsed.username || parsed.password) throw new Error(`${label} must not contain credentials`);
  return parsed.toString();
}

function assertSafeRelativePath(value, label) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} is required`);
  const normalized = path.posix.normalize(value.replaceAll("\\", "/"));
  if (normalized.startsWith("../") || normalized === ".." || path.posix.isAbsolute(normalized)) {
    throw new Error(`${label} escapes the component root`);
  }
  return normalized;
}

function assertNonDestructiveCommand(executable, argumentsValue, label) {
  const rawBase = path.basename(String(executable || "")).toLowerCase();
  const base = rawBase.replace(/\.(?:bat|cmd|exe|ps1)$/iu, "");
  const args = Array.isArray(argumentsValue) ? argumentsValue.map(String) : [];
  if (FORBIDDEN_COMMANDS.has(base)) throw new Error(`${label} contains a destructive executable`);
  if (base === "git" && args[0]?.toLowerCase() === "clean") {
    throw new Error(`${label} must not run git clean`);
  }
  if (base === "docker" && args.some((value) => value.toLowerCase() === "down")) {
    throw new Error(`${label} must not destroy the managed Docker topology`);
  }
  if (SHELL_COMMANDS.has(base) && DESTRUCTIVE_SHELL_PATTERN.test(args.join(" "))) {
    throw new Error(`${label} contains a destructive shell command`);
  }
}

function assertSafeCommand(step, label) {
  if (!step || typeof step !== "object") throw new Error(`${label} is invalid`);
  if (!SAFE_ID.test(String(step.id || ""))) throw new Error(`${label} has an invalid id`);
  if (!ALLOWED_STEP_KINDS.has(step.kind || "command")) throw new Error(`${label} has an unsupported kind`);
  if (step.kind === "command" || step.kind === undefined) {
    if (typeof step.executable !== "string" || !step.executable.trim()) {
      throw new Error(`${label} executable is required`);
    }
    if (!Array.isArray(step.arguments)) throw new Error(`${label} arguments must be an array`);
    if (step.arguments.length > 96) throw new Error(`${label} has too many arguments`);
    for (const argument of step.arguments) {
      if (typeof argument !== "string" || argument.includes("\0") || argument.length > 4_096) {
        throw new Error(`${label} contains an invalid argument`);
      }
    }
    assertNonDestructiveCommand(step.executable, step.arguments, label);
  }
  if (step.kind === "assert-file") assertSafeRelativePath(step.path, `${label} path`);
}

function assertSafeManifest(manifest, expectedId) {
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
    throw new Error(`Managed component manifest ${expectedId} is invalid`);
  }
  if (manifest.schemaVersion !== 1) throw new Error(`Managed component ${expectedId} schema is unsupported`);
  if (manifest.id !== expectedId || !SAFE_ID.test(manifest.id)) {
    throw new Error(`Managed component manifest ID mismatch: ${expectedId}`);
  }
  if (manifest.managedBy !== "Coding Tools") throw new Error(`${expectedId} is not owned by Coding Tools management`);
  if (manifest.loopbackOnly !== true) throw new Error(`${expectedId} must be loopback-only`);
  if (manifest.strategy !== "release-binary" && manifest.strategy !== "git-source") {
    throw new Error(`${expectedId} has an unsupported installation strategy`);
  }
  if (typeof manifest.name !== "string" || !manifest.name.trim()) throw new Error(`${expectedId} name is required`);
  if (typeof manifest.version !== "string" || !manifest.version.trim()) throw new Error(`${expectedId} version is required`);
  assertLoopbackUrl(manifest.health?.endpoint, `${expectedId} health endpoint`);
  if (manifest.executionEndpoint) assertLoopbackUrl(manifest.executionEndpoint, `${expectedId} execution endpoint`);
  if (!Array.isArray(manifest.install?.steps) || manifest.install.steps.length === 0) {
    throw new Error(`${expectedId} has no installation steps`);
  }
  for (const step of manifest.install.steps) {
    if (step.kind === "command" || step.kind === "assert-file") {
      assertSafeCommand(step, `${expectedId} install step`);
    } else if (!step || !ALLOWED_STEP_KINDS.has(step.kind)) {
      throw new Error(`${expectedId} has an unsupported installation step`);
    }
  }
  if (!Array.isArray(manifest.launch?.processes) || manifest.launch.processes.length === 0) {
    throw new Error(`${expectedId} has no launch topology`);
  }
  for (const processEntry of manifest.launch.processes) {
    assertSafeCommand({ ...processEntry, kind: "command" }, `${expectedId} launch process`);
  }
  for (const stopEntry of manifest.launch.stop || []) {
    assertSafeCommand({ ...stopEntry, kind: "command" }, `${expectedId} stop process`);
  }
  if (manifest.strategy === "git-source") {
    if (typeof manifest.repositoryUrl !== "string" || !manifest.repositoryUrl.startsWith("https://github.com/")) {
      throw new Error(`${expectedId} repository URL must be an HTTPS GitHub URL`);
    }
    if (!COMMIT_SHA.test(String(manifest.commit || ""))) throw new Error(`${expectedId} commit must be pinned`);
  } else {
    const platformEntries = manifest.platforms && typeof manifest.platforms === "object"
      ? Object.values(manifest.platforms)
      : [];
    if (platformEntries.length === 0) throw new Error(`${expectedId} has no release platform assets`);
    for (const architectures of platformEntries) {
      for (const asset of Object.values(architectures || {})) {
        if (!asset || typeof asset.url !== "string" || !asset.url.startsWith("https://github.com/")) {
          throw new Error(`${expectedId} release asset must be hosted on GitHub HTTPS`);
        }
        if (!SHA256.test(String(asset.sha256 || ""))) throw new Error(`${expectedId} release asset checksum is invalid`);
        assertSafeRelativePath(asset.fileName, `${expectedId} release filename`);
      }
    }
  }
  return Object.freeze(manifest);
}

function loadManagedManifest(componentId, manifestRoot) {
  const id = requiredComponentId(componentId);
  const filePath = path.join(manifestRoot, `${id}.json`);
  const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
  return assertSafeManifest(parsed, id);
}

function pathInside(root, candidate) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function safeSegment(value) {
  return String(value || "unknown").replace(/[^A-Za-z0-9._-]+/g, "-").slice(0, 120);
}

function timestampSegment(value) {
  return safeSegment(String(value).replaceAll(":", "-"));
}

function readJson(filePath) {
  try { return JSON.parse(fs.readFileSync(filePath, "utf8")); }
  catch { return null; }
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  writePrivateFileAtomic(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function sha256File(filePath) {
  const hash = crypto.createHash("sha256");
  const descriptor = fs.openSync(filePath, "r");
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  try {
    let bytesRead = 0;
    do {
      bytesRead = fs.readSync(descriptor, buffer, 0, buffer.length, null);
      if (bytesRead > 0) hash.update(buffer.subarray(0, bytesRead));
    } while (bytesRead > 0);
  } finally {
    fs.closeSync(descriptor);
  }
  return hash.digest("hex");
}

function verifySha256(filePath, expected) {
  const actual = sha256File(filePath);
  if (actual !== expected) throw new Error(`SHA-256 mismatch for ${path.basename(filePath)}`);
  return actual;
}

function createSecretCodec({ safeStorage, keyPath }) {
  let fallbackKey = null;

  function encryptionAvailable() {
    try { return Boolean(safeStorage?.isEncryptionAvailable?.()); }
    catch { return false; }
  }

  function loadFallbackKey() {
    if (fallbackKey) return fallbackKey;
    try {
      const candidate = Buffer.from(fs.readFileSync(keyPath, "utf8").trim(), "base64");
      if (candidate.length === 32) {
        fallbackKey = candidate;
        return fallbackKey;
      }
    } catch {}
    fallbackKey = crypto.randomBytes(32);
    fs.mkdirSync(path.dirname(keyPath), { recursive: true, mode: 0o700 });
    writePrivateFileAtomic(keyPath, `${fallbackKey.toString("base64")}\n`);
    return fallbackKey;
  }

  function encrypt(value) {
    const plain = JSON.stringify(value);
    if (encryptionAvailable()) {
      return {
        version: SECRET_VERSION,
        scheme: "electron-safe-storage-v1",
        data: safeStorage.encryptString(plain).toString("base64"),
      };
    }
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv("aes-256-gcm", loadFallbackKey(), iv);
    const encrypted = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
    return {
      version: SECRET_VERSION,
      scheme: "aes-256-gcm-v1",
      iv: iv.toString("base64"),
      tag: cipher.getAuthTag().toString("base64"),
      data: encrypted.toString("base64"),
    };
  }

  function decrypt(envelope) {
    if (!envelope || envelope.version !== SECRET_VERSION) return null;
    try {
      if (envelope.scheme === "electron-safe-storage-v1" && encryptionAvailable()) {
        return JSON.parse(safeStorage.decryptString(Buffer.from(envelope.data, "base64")));
      }
      if (envelope.scheme !== "aes-256-gcm-v1") return null;
      const decipher = crypto.createDecipheriv(
        "aes-256-gcm",
        loadFallbackKey(),
        Buffer.from(envelope.iv, "base64"),
      );
      decipher.setAuthTag(Buffer.from(envelope.tag, "base64"));
      const plain = Buffer.concat([
        decipher.update(Buffer.from(envelope.data, "base64")),
        decipher.final(),
      ]).toString("utf8");
      return JSON.parse(plain);
    } catch {
      return null;
    }
  }

  return Object.freeze({ encrypt, decrypt });
}

function quoteBash(value) {
  return `'${String(value).replaceAll("'", `'\"'\"'`)}'`;
}

function createManagedComponentController({
  manifestRoot = path.join(__dirname, "..", "vendor", "managed-components"),
  dataRoot,
  platform = process.platform,
  arch = process.arch,
  env = process.env,
  safeStorage = null,
  logger = null,
  fetchImpl = globalThis.fetch,
  spawnProcess = spawn,
  spawnSyncProcess = spawnSync,
  resolveRuntimeExecutable = () => process.execPath,
  publish = null,
  now = () => new Date().toISOString(),
} = {}) {
  if (!dataRoot || !path.isAbsolute(dataRoot)) throw new Error("Managed component data root must be absolute");
  if (typeof fetchImpl !== "function") throw new Error("Managed component downloads require fetch");

  const manifests = new Map(COMPONENT_IDS.map((id) => [id, loadManagedManifest(id, manifestRoot)]));
  const componentsRoot = path.join(dataRoot, "components");
  const stateRoot = path.join(dataRoot, "state");
  const aiTempRoot = path.join(dataRoot, "aiTemp", "managed-components");
  const trashRoot = path.join(dataRoot, "Trash", "managed-components");
  const secretPath = path.join(dataRoot, "managed-components.secrets.json");
  const secretKeyPath = path.join(dataRoot, "managed-components.key");
  const codec = createSecretCodec({ safeStorage, keyPath: secretKeyPath });
  const operations = new Map();
  const processes = new Map();
  let secrets = readJson(secretPath) || { version: SECRET_VERSION, components: {} };

  for (const directory of [componentsRoot, stateRoot, aiTempRoot, trashRoot]) {
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    if (platform !== "win32") fs.chmodSync(directory, 0o700);
  }

  function manifestFor(idValue) {
    const id = requiredComponentId(idValue);
    return manifests.get(id);
  }

  function componentHome(manifest) {
    return path.join(componentsRoot, manifest.id, safeSegment(manifest.version));
  }

  function componentState(manifest) {
    return path.join(stateRoot, manifest.id);
  }

  function managedAdapterRoot() {
    const packedMarker = `${path.sep}app.asar${path.sep}`;
    return __dirname.includes(packedMarker)
      ? __dirname.replace(packedMarker, `${path.sep}app.asar.unpacked${path.sep}`)
      : __dirname;
  }

  function markerPath(home) {
    return path.join(home, MARKER_NAME);
  }

  function expectedMarker(manifest) {
    return {
      schemaVersion: 1,
      id: manifest.id,
      version: manifest.version,
      strategy: manifest.strategy,
      repository: manifest.repository,
      commit: manifest.commit || null,
    };
  }

  function markerMatches(manifest, marker) {
    const expected = expectedMarker(manifest);
    return marker?.schemaVersion === expected.schemaVersion
      && marker.id === expected.id
      && marker.version === expected.version
      && marker.strategy === expected.strategy
      && marker.repository === expected.repository
      && (marker.commit || null) === expected.commit;
  }

  function readMarker(manifest) {
    return readJson(markerPath(componentHome(manifest)));
  }

  function sourceState(manifest) {
    const home = componentHome(manifest);
    const exists = fs.existsSync(home);
    const marker = exists ? readMarker(manifest) : null;
    if (!exists) return { state: "not-installed", home, marker: null };
    if (!markerMatches(manifest, marker)) return { state: "repair-required", home, marker };
    return { state: "installed", home, marker };
  }

  function operationState(id) {
    return operations.get(id) || null;
  }

  function secretFor(id) {
    return codec.decrypt(secrets.components?.[id]) || {};
  }

  function writeSecret(id, value) {
    secrets = {
      version: SECRET_VERSION,
      components: {
        ...(secrets.components || {}),
        [id]: codec.encrypt(value),
      },
    };
    writeJson(secretPath, secrets);
  }

  function ensureComponentSecrets(id) {
    let current = secretFor(id);
    let changed = false;
    if ((id === "commandcode-proxy" || id === "cpa") && !current.proxyApiKey) {
      current = { ...current, proxyApiKey: crypto.randomBytes(36).toString("base64url") };
      changed = true;
    }
    if (id === "cpa" && !current.managementKey) {
      current = { ...current, managementKey: crypto.randomBytes(36).toString("base64url") };
      changed = true;
    }
    if (changed) writeSecret(id, current);
    return current;
  }

  function missingCredentials(manifest) {
    const current = secretFor(manifest.id);
    return Object.entries(manifest.credentials || {})
      .filter(([_key, descriptor]) => descriptor?.required === true)
      .map(([key]) => key)
      .filter((key) => typeof current[key] !== "string" || !current[key]);
  }

  function setComponentCredential(idValue, keyValue, value) {
    const id = requiredComponentId(idValue);
    const manifest = manifestFor(id);
    const key = String(keyValue || "").trim();
    const descriptor = manifest.credentials?.[key];
    if (!descriptor) throw new Error(`${manifest.name} does not accept credential ${key || "missing"}`);
    if (typeof value !== "string") throw new Error(`${manifest.name} credential ${key} must be text`);
    const normalized = value.trim();
    const minimumLength = Number.isInteger(descriptor.minimumLength) ? descriptor.minimumLength : 1;
    if (normalized.length < minimumLength || normalized.length > 8_192 || normalized.includes("\0")) {
      throw new Error(`${manifest.name} credential ${key} is invalid`);
    }
    writeSecret(id, { ...secretFor(id), [key]: normalized });
    emit();
    return project(id);
  }

  function platformMode(manifest) {
    return manifest.platformModes?.[platform] || "native";
  }

  function selectedReleaseAsset(manifest) {
    const platformAssets = manifest.platforms?.[platform];
    const asset = platformAssets?.[arch];
    if (!asset) throw new Error(`${manifest.name} has no managed asset for ${platform}/${arch}`);
    return asset;
  }

  function serviceProcesses(id) {
    const active = processes.get(id) || new Map();
    return [...active.entries()].map(([processId, child]) => ({
      id: processId,
      pid: child?.pid || null,
      running: Boolean(child && child.exitCode === null && child.signalCode === null),
    }));
  }

  function project(idValue) {
    const id = requiredComponentId(idValue);
    const manifest = manifestFor(id);
    const source = sourceState(manifest);
    const operation = operationState(id);
    const installState = operation?.state && INSTALL_STATE_SET.has(operation.state)
      ? operation.state
      : source.state;
    return {
      id,
      name: manifest.name,
      version: manifest.version,
      commit: manifest.commit || null,
      strategy: manifest.strategy,
      installState,
      managedHome: source.home,
      installedAt: source.marker?.installedAt || null,
      currentStep: operation?.step || null,
      error: operation?.error || null,
      platformMode: platformMode(manifest),
      processes: serviceProcesses(id),
      secretConfigured: Object.keys(secretFor(id)).length > 0,
      missingCredentials: missingCredentials(manifest),
    };
  }

  function snapshot() {
    return { version: 1, components: COMPONENT_IDS.map(project) };
  }

  function emit() {
    const value = snapshot();
    try { publish?.(value); } catch {}
    return value;
  }

  function setOperation(id, patch) {
    const next = { ...(operationState(id) || {}), ...patch };
    operations.set(id, next);
    emit();
    return next;
  }

  function assertWithin(root, candidate, label) {
    if (!pathInside(root, candidate)) throw new Error(`${label} escaped its managed root`);
  }

  function moveToTrash(sourcePath, manifest, reason) {
    if (!sourcePath || !fs.existsSync(sourcePath)) return null;
    assertWithin(dataRoot, sourcePath, "Managed component source");
    const destination = path.join(
      trashRoot,
      manifest.id,
      `${timestampSegment(now())}-${safeSegment(reason)}-${crypto.randomUUID()}`,
    );
    assertWithin(trashRoot, destination, "Managed component Trash destination");
    fs.mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 });
    fs.renameSync(sourcePath, destination);
    writeJson(path.join(destination, "CODING_TOOLS_TRASH_RECORD.json"), {
      schemaVersion: 1,
      id: manifest.id,
      version: manifest.version,
      commit: manifest.commit || null,
      reason,
      movedAt: now(),
    });
    return destination;
  }

  function npmExecutable() {
    return platform === "win32" ? "npm.cmd" : "npm";
  }

  function wslPath(home) {
    const result = spawnSyncProcess("wsl.exe", ["--exec", "wslpath", "-a", "-u", home], {
      encoding: "utf8",
      windowsHide: true,
    });
    if (result.error) throw result.error;
    if (result.status !== 0 || !String(result.stdout || "").trim()) {
      throw new Error(`WSL2 could not map the managed Anneal path: ${String(result.stderr || "").trim()}`);
    }
    return String(result.stdout).trim();
  }

  function expandToken(value, context) {
    return String(value)
      .replaceAll("{home}", context.home)
      .replaceAll("{state}", context.state)
      .replaceAll("{adapterRoot}", context.adapterRoot)
      .replaceAll("{artifact}", context.artifact || "")
      .replaceAll("{runtime}", context.runtime)
      .replaceAll("{npm}", context.npm)
      .replace(/\{secret:([A-Za-z0-9_-]+)\}/g, (_match, key) => {
        const secret = context.secrets[key];
        if (typeof secret !== "string" || !secret) throw new Error(`Missing managed secret: ${key}`);
        return secret;
      });
  }

  function commandSpec(entry, context) {
    const executable = expandToken(entry.executable, context);
    const args = (entry.arguments || []).map((value) => expandToken(value, context));
    const environment = Object.fromEntries(Object.entries(entry.environment || {}).map(([key, value]) => [
      key,
      expandToken(value, context),
    ]));
    const managedMode = entry.execution === "managed-mode";
    if (context.mode === "wsl2" && managedMode) {
      const linuxHome = context.wslHome || wslPath(context.home);
      const linuxState = context.wslState || wslPath(context.state);
      const linuxAdapterRoot = context.wslAdapterRoot || wslPath(context.adapterRoot);
      const wslContext = {
        ...context,
        home: linuxHome,
        state: linuxState,
        adapterRoot: linuxAdapterRoot,
        npm: "npm",
      };
      const wslExecutable = expandToken(entry.executable, wslContext);
      const wslArgs = (entry.arguments || []).map((value) => expandToken(value, wslContext));
      const wslEnvironment = Object.fromEntries(Object.entries(entry.environment || {}).map(([key, value]) => [
        key,
        expandToken(value, wslContext),
      ]));
      const exported = Object.entries(wslEnvironment)
        .map(([key, value]) => `export ${key}=${quoteBash(value)}`)
        .join("; ");
      const command = [wslExecutable, ...wslArgs].map(quoteBash).join(" ");
      const script = exported ? `${exported}; exec ${command}` : `exec ${command}`;
      return {
        executable: "wsl.exe",
        args: ["--cd", linuxHome, "--exec", "bash", "-lc", script],
        options: {
          env: { ...env },
          shell: false,
          windowsHide: true,
          stdio: ["ignore", "pipe", "pipe"],
        },
      };
    }
    if (platform === "win32" && context.mode === "native" && /\.(?:cmd|bat)$/i.test(executable)) {
      return {
        executable: env.ComSpec || process.env.ComSpec || "cmd.exe",
        args: ["/d", "/s", "/c", executable, ...args],
        options: {
          cwd: context.home,
          env: { ...env, ...environment },
          shell: false,
          windowsHide: true,
          stdio: ["ignore", "pipe", "pipe"],
        },
      };
    }
    return {
      executable,
      args,
      options: {
        cwd: context.home,
        env: { ...env, ...environment },
        shell: false,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      },
    };
  }

  function boundedOutput(value, previous = "") {
    const combined = `${previous}${String(value || "")}`;
    return combined.length > 24_000 ? combined.slice(-24_000) : combined;
  }

  function runCommand(entry, context, timeoutMs = DEFAULT_COMMAND_TIMEOUT_MS) {
    const spec = commandSpec(entry, context);
    return new Promise((resolve, reject) => {
      const child = spawnProcess(spec.executable, spec.args, spec.options);
      let stdout = "";
      let stderr = "";
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        try { child.kill("SIGTERM"); } catch {}
        reject(new Error(`${entry.id} timed out`));
      }, timeoutMs);
      timer.unref?.();
      child.stdout?.on?.("data", (chunk) => {
        stdout = boundedOutput(chunk, stdout);
        const message = String(chunk || "").trim().slice(-2_000);
        if (message) logger?.debug?.("managed-component.stdout", { componentId: context.id, step: entry.id, message });
      });
      child.stderr?.on?.("data", (chunk) => {
        stderr = boundedOutput(chunk, stderr);
        const message = String(chunk || "").trim().slice(-2_000);
        if (message) logger?.debug?.("managed-component.stderr", { componentId: context.id, step: entry.id, message });
      });
      child.once?.("error", (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(error);
      });
      child.once?.("exit", (code, signal) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (code === 0) resolve({ stdout, stderr });
        else reject(new Error(`${entry.id} failed (${code ?? signal ?? "unknown"}): ${stderr.trim() || stdout.trim()}`));
      });
    });
  }

  async function downloadAsset(url, destination) {
    const response = await fetchImpl(url, { redirect: "follow" });
    if (!response.ok || !response.body) throw new Error(`Download failed: HTTP ${response.status}`);
    const length = Number(response.headers?.get?.("content-length") || 0);
    if (Number.isFinite(length) && length > MAX_DOWNLOAD_BYTES) throw new Error("Managed component download exceeds the size limit");
    fs.mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 });
    const file = fs.createWriteStream(destination, { flags: "wx", mode: 0o700 });
    await pipeline(Readable.fromWeb(response.body), file);
    if (fs.statSync(destination).size > MAX_DOWNLOAD_BYTES) throw new Error("Managed component download exceeds the size limit");
  }

  async function prepareReleaseBinary(manifest, stagingHome) {
    const asset = selectedReleaseAsset(manifest);
    const artifact = path.join(stagingHome, assertSafeRelativePath(asset.fileName, `${manifest.id} filename`));
    setOperation(manifest.id, { state: "installing", step: "download-release", error: null });
    await downloadAsset(asset.url, artifact);
    setOperation(manifest.id, { state: "installing", step: "verify-sha256", error: null });
    verifySha256(artifact, asset.sha256);
    if (platform !== "win32") fs.chmodSync(artifact, 0o700);
    return { artifact };
  }

  async function prepareGitSource(manifest, stagingHome) {
    const parent = path.dirname(stagingHome);
    fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
    setOperation(manifest.id, { state: "installing", step: "clone-pinned-source", error: null });
    await runCommand({
      id: "git-clone",
      executable: "git",
      arguments: ["clone", "--filter=blob:none", "--no-checkout", manifest.repositoryUrl, stagingHome],
    }, {
      id: manifest.id,
      home: parent,
      state: componentState(manifest),
      adapterRoot: managedAdapterRoot(),
      artifact: "",
      runtime: resolveRuntimeExecutable(),
      npm: npmExecutable(),
      secrets: ensureComponentSecrets(manifest.id),
      mode: "native",
    });
    await runCommand({
      id: "git-fetch-pinned-commit",
      executable: "git",
      arguments: ["-C", stagingHome, "fetch", "--depth", "1", "origin", manifest.commit],
    }, {
      id: manifest.id,
      home: parent,
      state: componentState(manifest),
      adapterRoot: managedAdapterRoot(),
      artifact: "",
      runtime: resolveRuntimeExecutable(),
      npm: npmExecutable(),
      secrets: ensureComponentSecrets(manifest.id),
      mode: "native",
    });
    await runCommand({
      id: "git-checkout-pinned-commit",
      executable: "git",
      arguments: ["-C", stagingHome, "checkout", "--detach", manifest.commit],
    }, {
      id: manifest.id,
      home: parent,
      state: componentState(manifest),
      adapterRoot: managedAdapterRoot(),
      artifact: "",
      runtime: resolveRuntimeExecutable(),
      npm: npmExecutable(),
      secrets: ensureComponentSecrets(manifest.id),
      mode: "native",
    });
    return { artifact: "" };
  }

  async function executeInstallSteps(manifest, stagingHome, artifact) {
    const context = {
      id: manifest.id,
      home: stagingHome,
      state: componentState(manifest),
      adapterRoot: managedAdapterRoot(),
      artifact,
      runtime: resolveRuntimeExecutable(),
      npm: npmExecutable(),
      secrets: ensureComponentSecrets(manifest.id),
      mode: platformMode(manifest),
    };
    for (const step of manifest.install.steps) {
      if (["download", "verify", "git-checkout", "activate"].includes(step.kind)) continue;
      setOperation(manifest.id, { state: "installing", step: step.id, error: null });
      if (step.kind === "assert-file") {
        const expected = path.join(stagingHome, assertSafeRelativePath(step.path, `${step.id} path`));
        assertWithin(stagingHome, expected, "Managed component assertion");
        if (!fs.existsSync(expected) || !fs.statSync(expected).isFile()) {
          throw new Error(`${manifest.name} is missing required file ${step.path}`);
        }
        continue;
      }
      await runCommand(step, context);
    }
  }

  function markerArtifactRelative(stagingHome, artifact) {
    if (!artifact) return null;
    return path.relative(stagingHome, artifact).replaceAll("\\", "/");
  }

  async function installComponent(idValue, { repair = false } = {}) {
    const id = requiredComponentId(idValue);
    const manifest = manifestFor(id);
    const source = sourceState(manifest);
    if (source.state === "installed" && !repair) return project(id);
    if (operationState(id)?.state === "installing") throw new Error(`${manifest.name} installation is already running`);
    const missing = missingCredentials(manifest);
    if (missing.length > 0) throw new Error(`${manifest.name} requires configured credentials: ${missing.join(", ")}`);
    fs.mkdirSync(componentState(manifest), { recursive: true, mode: 0o700 });
    if (platform !== "win32") fs.chmodSync(componentState(manifest), 0o700);

    setOperation(id, { state: "installing", step: "prepare", error: null });
    const stagingRoot = path.join(
      aiTempRoot,
      `${id}-${timestampSegment(now())}-${crypto.randomUUID()}`,
    );
    const stagingHome = path.join(stagingRoot, "component");
    assertWithin(aiTempRoot, stagingRoot, "Managed component staging path");
    fs.mkdirSync(stagingRoot, { recursive: true, mode: 0o700 });
    writeJson(path.join(stagingRoot, "INSTALL_REQUEST.json"), {
      schemaVersion: 1,
      id,
      version: manifest.version,
      commit: manifest.commit || null,
      requestedAt: now(),
      repair: repair === true,
    });

    try {
      let prepared;
      if (manifest.strategy === "release-binary") {
        fs.mkdirSync(stagingHome, { recursive: true, mode: 0o700 });
        prepared = await prepareReleaseBinary(manifest, stagingHome);
      } else {
        prepared = await prepareGitSource(manifest, stagingHome);
      }
      await executeInstallSteps(manifest, stagingHome, prepared.artifact);
      const marker = {
        ...expectedMarker(manifest),
        installedAt: now(),
        platform,
        arch,
        artifact: markerArtifactRelative(stagingHome, prepared.artifact),
      };
      writeJson(markerPath(stagingHome), marker);

      const target = componentHome(manifest);
      if (fs.existsSync(target)) moveToTrash(target, manifest, repair ? "repair-replaced" : "version-replaced");
      fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
      fs.renameSync(stagingHome, target);
      writeJson(path.join(stagingRoot, "COMPLETED.json"), {
        schemaVersion: 1,
        id,
        completedAt: now(),
        target,
      });
      setOperation(id, { state: "installed", step: null, error: null });
      return project(id);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      writeJson(path.join(stagingRoot, "FAILED.json"), {
        schemaVersion: 1,
        id,
        failedAt: now(),
        error: message,
      });
      setOperation(id, { state: "error", step: null, error: message });
      throw error;
    }
  }

  function repairComponent(id) {
    return installComponent(id, { repair: true });
  }

  function launchContext(manifest) {
    const home = componentHome(manifest);
    const marker = readMarker(manifest);
    if (!markerMatches(manifest, marker)) throw new Error(`${manifest.name} is not installed or requires repair`);
    const artifact = marker.artifact ? path.join(home, assertSafeRelativePath(marker.artifact, "Managed artifact")) : "";
    return {
      id: manifest.id,
      home,
      state: componentState(manifest),
      adapterRoot: managedAdapterRoot(),
      artifact,
      runtime: resolveRuntimeExecutable(),
      npm: npmExecutable(),
      secrets: ensureComponentSecrets(manifest.id),
      mode: platformMode(manifest),
    };
  }

  function attachProcessLogging(manifest, processEntry, child) {
    const log = (stream, chunk) => {
      const message = String(chunk || "").trim().slice(-2_000);
      if (message) logger?.debug?.(`managed-component.${manifest.id}.${processEntry.id}.${stream}`, { message });
    };
    child.stdout?.on?.("data", (chunk) => log("stdout", chunk));
    child.stderr?.on?.("data", (chunk) => log("stderr", chunk));
  }

  async function startComponent(idValue) {
    const id = requiredComponentId(idValue);
    const manifest = manifestFor(id);
    const context = launchContext(manifest);
    const existing = processes.get(id);
    if (existing && [...existing.values()].some((child) => child && child.exitCode === null && child.signalCode === null)) {
      return project(id);
    }

    const active = new Map();
    processes.set(id, active);
    try {
      for (const processEntry of manifest.launch.processes) {
        if (processEntry.detached === true || processEntry.mode === "command") {
          await runCommand(processEntry, context);
          continue;
        }
        const spec = commandSpec(processEntry, context);
        const child = spawnProcess(spec.executable, spec.args, spec.options);
        active.set(processEntry.id, child);
        attachProcessLogging(manifest, processEntry, child);
        child.once?.("error", (error) => {
          active.delete(processEntry.id);
          setOperation(id, { state: "error", step: null, error: `${processEntry.id}: ${error.message}` });
        });
        child.once?.("exit", (code, signal) => {
          active.delete(processEntry.id);
          if (code !== 0 && code !== null) {
            setOperation(id, { state: "error", step: null, error: `${processEntry.id} exited (${code ?? signal ?? "unknown"})` });
          } else emit();
        });
      }
      setOperation(id, { state: "installed", step: null, error: null });
      return project(id);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setOperation(id, { state: "error", step: null, error: message });
      throw error;
    }
  }

  async function stopChild(child) {
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    const exited = await new Promise((resolve) => {
      let settled = false;
      let timer;
      const finish = (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        child.removeListener?.("exit", onExit);
        child.removeListener?.("error", onError);
        resolve(value);
      };
      const onExit = () => finish(true);
      const onError = () => finish(true);
      child.once?.("exit", onExit);
      child.once?.("error", onError);
      timer = setTimeout(() => finish(false), DEFAULT_STOP_TIMEOUT_MS);
      timer.unref?.();
      try {
        if (child.kill("SIGTERM") === false) finish(false);
      } catch {
        finish(false);
      }
    });
    if (!exited && child.exitCode === null && child.signalCode === null) {
      try { child.kill("SIGKILL"); } catch {}
    }
  }

  async function stopComponent(idValue) {
    const id = requiredComponentId(idValue);
    const manifest = manifestFor(id);
    const active = processes.get(id) || new Map();
    for (const child of [...active.values()].reverse()) await stopChild(child);
    processes.delete(id);
    const context = sourceState(manifest).state === "installed" ? launchContext(manifest) : null;
    if (context) {
      for (const stopEntry of manifest.launch.stop || []) {
        try { await runCommand(stopEntry, context); }
        catch (error) {
          logger?.warn?.("managed-component.stop-step-failed", {
            componentId: id,
            step: stopEntry.id,
            message: error instanceof Error ? error.message : String(error),
          });
        }
      }
    }
    emit();
    return project(id);
  }

  async function restartComponent(id) {
    await stopComponent(id);
    return startComponent(id);
  }

  function runtimeConfiguration(idValue) {
    const id = requiredComponentId(idValue);
    const manifest = manifestFor(id);
    const source = sourceState(manifest);
    if (source.state !== "installed") return null;
    const context = launchContext(manifest);
    const primary = manifest.launch.processes.find((entry) => entry.id === manifest.launch.primaryProcessId)
      || manifest.launch.processes.find((entry) => entry.mode !== "command" && entry.detached !== true)
      || manifest.launch.processes[0];
    const spec = commandSpec(primary, context);
    const cli = manifest.cli?.[platform] || manifest.cli?.default || null;
    const callerSecretPath = path.join(context.state, "router", "caller-secret");
    const callerKey = id === "codex-router" && fs.existsSync(callerSecretPath)
      ? fs.readFileSync(callerSecretPath, "utf8").trim()
      : "";
    return {
      home: context.home,
      executable: spec.executable,
      arguments: [...spec.args],
      endpoint: manifest.health.endpoint.replace("{callerKey}", ""),
      executionEndpoint: manifest.executionEndpoint || undefined,
      ...(id === "codex-router" ? {
        routerCli: cli ? expandToken(cli.router, context) : context.artifact,
        curateCli: cli ? expandToken(cli.curate, context) : context.artifact,
        callerKey,
      } : {}),
    };
  }

  function runtimeSecrets(idValue) {
    const id = requiredComponentId(idValue);
    return { ...ensureComponentSecrets(id) };
  }

  function healthHeaders(idValue) {
    const id = requiredComponentId(idValue);
    const template = manifestFor(id).health?.authorization;
    if (!template) return {};
    const current = ensureComponentSecrets(id);
    const authorization = String(template).replace(
      /\{secret:([A-Za-z0-9_-]+)\}/g,
      (_match, key) => String(current[key] || ""),
    );
    if (!authorization || authorization.includes("{secret:")) {
      throw new Error(`${manifestFor(id).name} health credential is unavailable`);
    }
    return { Authorization: authorization };
  }

  function dispose() {
    for (const active of processes.values()) {
      for (const child of active.values()) {
        if (child && child.exitCode === null && child.signalCode === null) {
          try { child.kill("SIGTERM"); } catch {}
        }
      }
    }
    processes.clear();
  }

  return Object.freeze({
    snapshot,
    project,
    installComponent,
    repairComponent,
    setComponentCredential,
    startComponent,
    stopComponent,
    restartComponent,
    runtimeConfiguration,
    runtimeSecrets,
    healthHeaders,
    dispose,
  });
}

module.exports = {
  COMPONENT_IDS,
  INSTALL_STATES,
  assertSafeManifest,
  createManagedComponentController,
  loadManagedManifest,
  verifySha256,
};
