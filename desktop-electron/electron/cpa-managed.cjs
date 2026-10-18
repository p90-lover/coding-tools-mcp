"use strict";

const { createHash, randomBytes } = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");
const { writePrivateFileAtomic } = require("./atomic-file.cjs");
const { watchCpaPluginModels } = require("./cpa-plugin-models.cjs");
const { cpaLongRunYamlLines } = require("./cpa-codex-long-run.cjs");
const { createProxyGateway, validateUpstream } = require("./proxy-gateway-relay.cjs");

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

const COMMANDCODE_PLUGINS = [
  { id: "cline-pass-switcher", file: "cline-pass-switcher-v0.1.0-codingtools.1.dll", sha256: "9f06040bda6c8c2a8f0850dedddc306978c487593de0be55f7b237a63247a7fd" },
  { id: "commandcode-go", file: "commandcode-go-v1.0.0-codingtools.1.dll", sha256: "ffb690666d979bbeb529ce076291b808aac39b9091ef62f28b5c8e37285cb70c" },
  { id: "auth-commandcode", file: "auth-commandcode-v0.1.0-codingtools.1.dll", sha256: "b9ab54aa73d1c9fd4e9baaaa4960643aa81f2caecb2f69e5463fc3a62f079afc" },
  // CPA Helper (usage, costs, Codex keeper), rebuilt from walkingddd/CPA-Helper as a native plugin.
  { id: "cpa-helper", file: "cpa-helper-v0.1.0.dll", sha256: "3e1c57168b1bef6f789041026a2437482e540d8be3b7c5e4a2b943011c1eb55c" },
  // Grok Build/Web/Console provider built from chenyme/grok2api (vendor/cpa-plugins/grok-login-provider).
  { id: "grok-login-provider", file: "grok-login-provider-v0.1.0-codingtools.1.dll", sha256: "57fbdce4ad770499e604a7d3654bc7b700532e0572c0980ff040818a83117cb7" },
];

function installBundledCommandCodePlugin(state) {
  if (process.platform !== "win32" || process.arch !== "x64") return [];
  const bundle = path.join(__dirname, "..", "vendor", "bundled", "cpa-plugins", "windows", "amd64");
  const digest = (file) => createHash("sha256").update(fs.readFileSync(file)).digest("hex");
  const sources = COMMANDCODE_PLUGINS.map((plugin) => ({
    ...plugin, source: path.join(bundle, plugin.file),
  }));
  for (const plugin of sources) {
    if (digest(plugin.source) !== plugin.sha256) throw new Error(`Bundled ${plugin.id} CPA plugin hash mismatch`);
  }

  const directory = path.join(state, "plugins", "windows", "amd64");
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  return sources.map((plugin) => {
    const target = path.join(directory, plugin.file);
    const stat = fs.existsSync(target) ? fs.lstatSync(target) : null;
    if (stat && !stat.isFile()) throw new Error(`${plugin.id} CPA plugin path is not a regular file`);
    const current = stat && digest(target) === plugin.sha256;
    const old = fs.readdirSync(directory).filter((name) => (
      (name === `${plugin.id}.dll` || (name.startsWith(`${plugin.id}-v`) && name.endsWith(".dll")))
      && (name !== plugin.file || !current)
    ));
    if (old.length) {
      const archive = path.join(state, "Trash", "plugins", `${Date.now()}-${plugin.id}`);
      fs.mkdirSync(archive, { recursive: true, mode: 0o700 });
      for (const name of old) {
        const previous = path.join(directory, name);
        if (!fs.lstatSync(previous).isFile()) throw new Error(`${plugin.id} CPA plugin path is not a regular file`);
        fs.renameSync(previous, path.join(archive, name));
      }
    }
    if (!current) fs.copyFileSync(plugin.source, target, fs.constants.COPYFILE_EXCL);
    return target;
  });
}

function runtimeConfiguration(state, managementKey, proxyApiKey, outboundProxyUrl = "", clineProxyUrl = outboundProxyUrl) {
  const authDirectory = path.join(state, "auth");
  const logDirectory = path.join(state, "logs");
  const pluginDirectory = path.resolve(state, "plugins");
  fs.mkdirSync(pluginDirectory, { recursive: true, mode: 0o700 });
  fs.mkdirSync(authDirectory, { recursive: true, mode: 0o700 });
  fs.mkdirSync(logDirectory, { recursive: true, mode: 0o700 });
  const clineAuth = path.join(authDirectory, "cline-pass-switcher.json");
  if (!fs.existsSync(clineAuth)) {
    writePrivateFileAtomic(clineAuth, `${JSON.stringify({ type: "cline", switcher: true, label: "Cline Pass" })}\n`);
  }
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
    ...(outboundProxyUrl ? [`proxy-url: ${yamlString(outboundProxyUrl)}`] : []),
    "remote-management:",
    "  allow-remote: false",
    `  secret-key: ${yamlString(managementKey)}`,
    "  disable-control-panel: false",
    "  disable-auto-update-panel: true",
    "plugins:",
    "  enabled: true",
    `  dir: ${yamlString(pluginDirectory)}`,
    "  configs:",
    "    commandcode-go:",
    "      enabled: true",
    "    auth-commandcode:",
    "      enabled: true",
    "    cpa-helper:",
    "      enabled: true",
    `      data_dir: ${yamlString(path.join(state, "cpa-helper-data"))}`,
    "      keeper_enabled: false",
    // CPA leaves a plugin without a configs entry unregistered.
    "    cline-pass-switcher:",
    "      enabled: true",
    `      runtime-executable: ${yamlString(process.execPath)}`,
    `      data-dir: ${yamlString(path.join(state, "cline-pass-switcher-data"))}`,
    ...(clineProxyUrl ? [`      proxy-url: ${yamlString(clineProxyUrl)}`] : []),
    "    grok-login-provider:",
    "      enabled: true",
    // Ask OpenAI's Responses models for a reasoning summary. Claude Code never sends the
    // `thinking.display` that would make CPA request one, so its chats showed no reasoning; CPA
    // turns the summary into thinking blocks, which the agent then reports as reasoning. A default
    // only fills a field the request leaves out, so the effort the user chose is unchanged.
    "payload:",
    "  default:",
    "    - models: [{name: \"*\", protocol: \"codex\"}]",
    "      params: {\"reasoning.summary\": \"auto\"}",
    "debug: false",
    "request-log: false",
    "logging-to-file: true",
    "usage-statistics-enabled: true",
    ...cpaLongRunYamlLines(),
    "",
  ].join("\n");
}

// CPA's Go transport supports SOCKS5; the Cline child's fetch only accepts HTTP(S).
// Keep CPA's selected route intact and adapt only the child through an authenticated,
// ephemeral loopback relay owned by this wrapper (which can outlive the desktop app).
async function createClineProxyRoute(outboundProxyUrl) {
  if (!outboundProxyUrl) return { url: "", stop: async () => {} };
  let parsed;
  try { parsed = new URL(outboundProxyUrl); }
  catch { throw new Error("Invalid CPA outbound proxy URL"); }
  if (parsed.protocol === "http:" || parsed.protocol === "https:") {
    return { url: outboundProxyUrl, stop: async () => {} };
  }
  if (parsed.protocol !== "socks5:") throw new Error("CPA needs an HTTP, HTTPS or SOCKS5 proxy");
  const upstream = validateUpstream({
    protocol: "socks5", host: parsed.hostname, port: Number(parsed.port || 1080),
    username: decodeURIComponent(parsed.username), password: decodeURIComponent(parsed.password),
  });
  const proxyToken = randomBytes(32).toString("hex");
  const relay = createProxyGateway({ port: 0, proxyToken, getUpstream: () => upstream });
  try {
    const address = await relay.start();
    return { url: `http://ct:${proxyToken}@127.0.0.1:${address.port}`, stop: () => relay.stop() };
  } catch (error) {
    await relay.stop();
    throw error;
  }
}

async function run(homeValue, stateValue) {
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
  installBundledCommandCodePlugin(state);
  const managementKey = requiredSecret("CODING_TOOLS_CPA_MANAGEMENT_KEY");
  const proxyApiKey = requiredSecret("CODING_TOOLS_CPA_PROXY_API_KEY");
  const configPath = path.join(state, "config.yaml");
  const outboundProxyUrl = String(process.env.CODING_TOOLS_CPA_OUTBOUND_PROXY_URL || "");
  const clineRoute = await createClineProxyRoute(outboundProxyUrl);
  let child;
  try {
    writePrivateFileAtomic(configPath, runtimeConfiguration(
      state, managementKey, proxyApiKey, outboundProxyUrl, clineRoute.url,
    ));
    if (process.platform !== "win32") fs.chmodSync(configPath, 0o600);
    child = spawn(executable, ["--config", configPath, "--no-browser"], {
      cwd: state,
      env: { ...process.env },
      shell: false,
      windowsHide: true,
      stdio: "inherit",
    });
  } catch (error) {
    await clineRoute.stop();
    throw error;
  }

  const forward = (signal) => {
    try {
      if (child.exitCode === null && child.signalCode === null) child.kill(signal);
    } catch {}
  };
  process.once("SIGINT", () => forward("SIGINT"));
  process.once("SIGTERM", () => forward("SIGTERM"));
  child.once("error", (error) => {
    pluginModels.stop();
    void clineRoute.stop();
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
  // CPA outlives the app (a keep-bridge quit detaches it), and reads a plugin's models only when
  // it loads the plugin's auth file: keep the plugin model watcher running for as long as CPA.
  // The app runs one too, so a CPA started by an older wrapper is still covered.
  const pluginModels = watchCpaPluginModels({
    stateRoot: state,
    logger: { warn: (event, detail) => console.error(`${event} ${detail?.message ?? ""}`.trim()) },
  });
  child.once("exit", (code, signal) => {
    pluginModels.stop();
    void clineRoute.stop();
    process.exitCode = Number.isInteger(code) ? code : signal ? 1 : 0;
  });
}

if (require.main === module) {
  const command = process.argv[2];
  if (command === "prepare") {
    prepare(process.argv[3], process.argv[4], process.argv[5]);
  } else if (command === "run") {
    void run(process.argv[3], process.argv[4]).catch((error) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    });
  } else {
    throw new Error("CPA managed adapter command must be prepare or run");
  }
}

function helperPricesPath(stateRoot) {
  return path.join(requiredAbsolutePath(stateRoot, "CPA state root"), "cpa-helper-data", "prices.json");
}

module.exports = {
  helperPricesPath,
  createClineProxyRoute,
  prepare,
  run,
  runtimeConfiguration,
  installBundledCommandCodePlugin,
};
