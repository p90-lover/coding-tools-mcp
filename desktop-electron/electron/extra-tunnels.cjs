"use strict";

// More MCP tunnels beside the main one the runtime supervisor owns. accountId is a local browser
// profile's routing hint; setup checks the actual ChatGPT workspace and Platform tunnel owner.
// Every tunnel runs its own tunnel-client runtime and MCP process (stdio); all reach the same broker.
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { writePrivateFileAtomic } = require("./atomic-file.cjs");

const TUNNEL_ID = /^tunnel_[a-f0-9]{32}$/;
const ENTRY_ID = /^[a-f0-9]{8}$/;
const ACCOUNT_ID = /^[A-Za-z0-9_-]{1,64}$/;
const MAX_TUNNELS = 8;
const MAX_LABEL_LENGTH = 60;
const MAX_KEY_BYTES = 64 * 1024;
const MAX_CONNECTOR_BINDINGS = 64;
const TIMING = Object.freeze({
  monitorMs: 10_000,
  pollMs: 1_000,
  startTimeoutMs: 120_000,
  failureThreshold: 3,
  restartWindowMs: 60_000,
  maxRestarts: 5,
});

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const message = error => (error instanceof Error ? error.message : String(error));

function aliasOf(id) {
  return `codex-chatgpt-web-extra-${id}`;
}

function validEntry(entry) {
  return Boolean(entry && typeof entry === "object"
    && ENTRY_ID.test(entry.id)
    && TUNNEL_ID.test(entry.tunnelId)
    && typeof entry.label === "string" && entry.label.trim() && entry.label.length <= MAX_LABEL_LENGTH
    && (entry.accountId === null || ACCOUNT_ID.test(entry.accountId)));
}

function connectorBinding(value, tunnelId, href = value?.href) {
  if (!value || value.tunnelId !== tunnelId || !TUNNEL_ID.test(tunnelId)
    || typeof value.userId !== "string" || !/^user-[A-Za-z0-9_-]{1,120}$/.test(value.userId)
    || typeof value.workspaceId !== "string" || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value.workspaceId)
    || typeof href !== "string" || href.length > 512) return null;
  let url;
  try { url = new URL(href, "https://chatgpt.com"); } catch { return null; }
  if (url.origin !== "https://chatgpt.com" || url.username || url.password || !url.pathname.startsWith("/plugins/")) return null;
  // The pathname is the connector identity. Directory query strings and unrelated fields are not.
  return { userId: value.userId, workspaceId: value.workspaceId, tunnelId, href: url.pathname };
}

/** tunnel-client's local inventory as alias → { state, ready, pid }. */
function parseInventory(output) {
  const parsed = JSON.parse(output);
  if (!Array.isArray(parsed?.entries)) throw new Error("local inventory has no entries array");
  const byAlias = new Map();
  for (const entry of parsed.entries) {
    if (typeof entry?.alias !== "string") continue;
    const live = entry.live_runtime && typeof entry.live_runtime === "object" ? entry.live_runtime : {};
    const pid = [live.system?.pid, live.status?.pid].find(value => Number.isInteger(value) && value > 0) ?? null;
    byAlias.set(entry.alias, { state: String(entry.runtime_state), ready: entry.runtime_state === "ready", pid });
  }
  return byAlias;
}

class ExtraTunnels {
  /**
   * runTunnel(tunnel, args, timeoutMs, label) runs the tunnel CLI for one tunnel config (off the main thread);
   * connectArgs(config, tunnel) builds `runtimes connect` for it with the bridge's MCP command.
   */
  constructor({ coreHome, logger, runTunnel, connectArgs, diagnostic, absent, onChange, timing }) {
    this.registryPath = path.join(coreHome, "tunnel", "extra-tunnels.json");
    this.secretsDir = path.join(coreHome, "secrets");
    this.logger = logger;
    this.runTunnel = runTunnel;
    this.connectArgs = connectArgs;
    this.diagnostic = typeof diagnostic === "function" ? diagnostic : result => String(result?.output || "").slice(0, 1_200);
    this.absent = typeof absent === "function" ? absent : () => false;
    this.onChange = typeof onChange === "function" ? onChange : () => {};
    this.timing = { ...TIMING, ...timing };
    this.runtime = new Map(); // id → { state, detail, pid, failures, restarts }
    this.config = null; // the runtime config the tunnels run under, while they are supervised
    this.monitorTimer = null;
    this.monitorInFlight = false;
    this.queue = Promise.resolve();
  }

  /** Mutating work runs one at a time: starts, adds, removals, reconnects and monitor restarts. */
  serial(work) {
    const run = this.queue.then(work, work);
    this.queue = run.catch(() => undefined);
    return run;
  }

  entries() {
    let parsed;
    try {
      parsed = JSON.parse(fs.readFileSync(this.registryPath, "utf8"));
    } catch {
      return [];
    }
    return Array.isArray(parsed?.tunnels) ? parsed.tunnels.filter(validEntry) : [];
  }

  writeEntries(tunnels) {
    writePrivateFileAtomic(this.registryPath, `${JSON.stringify({ version: 1, tunnels }, null, 2)}\n`);
  }

  keyPath(id) {
    return path.join(this.secretsDir, `tunnel-runtime-extra-${id}.key`);
  }

  /** The tunnel config for an entry: the main tunnel's client and profile folder, its own alias and key. */
  tunnelFor(entry, config) {
    const main = config?.tunnel;
    if (config?.mode !== "full" || !main) throw new Error("Connect the main MCP tunnel before adding more tunnels.");
    return {
      binaryPath: main.binaryPath,
      tunnelId: entry.tunnelId,
      runtimeKeyFile: this.keyPath(entry.id),
      profileDir: main.profileDir,
      profileName: aliasOf(entry.id),
      alias: aliasOf(entry.id),
    };
  }

  setState(id, state, detail = "", pid = null) {
    const current = this.runtime.get(id) ?? { failures: 0, restarts: [] };
    this.runtime.set(id, { ...current, state, detail, pid });
    this.onChange(this.status());
  }

  /** Every extra tunnel with its runtime state; never the key or its path. */
  status() {
    return this.entries().map(entry => {
      const runtime = this.runtime.get(entry.id);
      return {
        id: entry.id,
        label: entry.label,
        tunnelId: entry.tunnelId,
        accountId: entry.accountId,
        connectorHref: typeof entry.connectorHref === "string" ? entry.connectorHref : null,
        connectorBindings: (Array.isArray(entry.connectorBindings) ? entry.connectorBindings : [])
          .slice(-MAX_CONNECTOR_BINDINGS).map(binding => connectorBinding(binding, entry.tunnelId)).filter(Boolean),
        state: runtime?.state ?? "stopped",
        detail: runtime?.detail ?? "",
        pid: runtime?.pid ?? null,
      };
    });
  }

  async inventory(config) {
    const result = await this.runTunnel(config.tunnel, ["runtimes", "cleanup", "--json"], 5_000, "Local tunnel inventory probe");
    if (result.code !== 0) throw new Error(`local tunnel inventory failed: ${this.diagnostic(result)}`);
    return parseInventory(result.output);
  }

  async stopAlias(tunnel) {
    const result = await this.runTunnel(tunnel, ["runtimes", "stop", tunnel.alias, "--json"], 10_000, "Extra tunnel shutdown");
    if (result.code !== 0 && !this.absent(result.output)) {
      throw new Error(`tunnel runtime refused shutdown: ${this.diagnostic(result)}`);
    }
  }

  async waitReady(tunnel, config) {
    const deadline = Date.now() + this.timing.startTimeoutMs;
    let last = "not observed yet";
    while (Date.now() < deadline) {
      try {
        const seen = (await this.inventory(config)).get(tunnel.alias);
        if (seen?.ready) return seen;
        last = seen ? `state=${seen.state}` : "absent from the local inventory";
      } catch (error) {
        last = message(error);
      }
      await sleep(this.timing.pollMs);
    }
    throw new Error(`did not become ready within ${this.timing.startTimeoutMs} ms (${last})`);
  }

  /** Adopts the entry's runtime when it is ready, else (or when forced) starts it again. */
  async connect(entry, config, { force = false } = {}) {
    const tunnel = this.tunnelFor(entry, config);
    if (!fs.existsSync(tunnel.binaryPath)) throw new Error(`Tunnel client is missing: ${tunnel.binaryPath}`);
    if (!fs.existsSync(tunnel.runtimeKeyFile)) throw new Error("This tunnel's API key is missing. Remove the tunnel and add it again.");
    this.setState(entry.id, "starting", "Connecting");
    try {
      const seen = (await this.inventory(config)).get(tunnel.alias);
      if (seen?.ready && !force) {
        this.setState(entry.id, "ready", "Adopted the running tunnel", seen.pid);
        return;
      }
      if (seen && seen.state !== "stopped") await this.stopAlias(tunnel);
      const result = await this.runTunnel(tunnel, this.connectArgs(config, tunnel), this.timing.startTimeoutMs, "Extra tunnel startup");
      if (result.code !== 0) throw new Error(`tunnel runtime refused startup: ${this.diagnostic(result)}`);
      const ready = await this.waitReady(tunnel, config);
      this.setState(entry.id, "ready", "Connected", ready.pid);
      this.logger?.info?.("runtime.extra_tunnel_ready", { id: entry.id, pid: ready.pid });
    } catch (error) {
      await this.stopAlias(tunnel).catch(() => undefined);
      this.setState(entry.id, "failed", message(error));
      this.logger?.warn?.("runtime.extra_tunnel_failed", { id: entry.id, message: message(error) });
      throw error;
    }
  }

  /** Starts (or adopts) every extra tunnel and watches them. Never throws: failures show per tunnel. */
  start(config) {
    if (config?.mode !== "full" || !config.tunnel) return Promise.resolve();
    this.config = config;
    this.startMonitor();
    return this.serial(async () => {
      for (const entry of this.entries()) {
        if (this.config !== config) return;
        await this.connect(entry, config).catch(() => undefined);
      }
    });
  }

  startMonitor() {
    this.stopMonitor();
    this.monitorTimer = setInterval(() => { void this.check(); }, this.timing.monitorMs);
    this.monitorTimer.unref?.();
  }

  stopMonitor() {
    if (this.monitorTimer) clearInterval(this.monitorTimer);
    this.monitorTimer = null;
  }

  /** One monitor pass: a tunnel seen not ready this many times in a row is restarted, a few times a minute at most. */
  async check() {
    const config = this.config;
    if (!config || this.monitorInFlight) return;
    this.monitorInFlight = true;
    try {
      let inventory;
      try {
        inventory = await this.inventory(config);
      } catch {
        return; // an unknown observation is no evidence of failure
      }
      for (const entry of this.entries()) {
        const runtime = this.runtime.get(entry.id);
        if (!runtime || runtime.state === "starting" || runtime.state === "failed") continue;
        const seen = inventory.get(aliasOf(entry.id));
        if (seen?.ready) {
          if (runtime.state !== "ready" || runtime.failures) this.runtime.set(entry.id, { ...runtime, failures: 0 });
          if (runtime.state !== "ready") this.setState(entry.id, "ready", "Connected", seen.pid);
          continue;
        }
        const failures = runtime.failures + 1;
        this.runtime.set(entry.id, { ...runtime, failures });
        if (failures < this.timing.failureThreshold) continue;
        const now = Date.now();
        const restarts = runtime.restarts.filter(at => at >= now - this.timing.restartWindowMs);
        if (restarts.length >= this.timing.maxRestarts) {
          this.runtime.set(entry.id, { ...this.runtime.get(entry.id), restarts });
          this.setState(entry.id, "failed", `Lost readiness ${restarts.length} times in a minute; reconnect it to try again`);
          continue;
        }
        this.runtime.set(entry.id, { ...runtime, failures: 0, restarts: [...restarts, now] });
        this.logger?.warn?.("runtime.extra_tunnel_restart", { id: entry.id, state: seen?.state ?? "absent" });
        void this.serial(() => (this.config === config ? this.connect(entry, config, { force: true }) : undefined)).catch(() => undefined);
      }
    } finally {
      this.monitorInFlight = false;
    }
  }

  /** Adds a tunnel and connects it; a tunnel that does not connect is not kept. */
  add({ label, tunnelId, runtimeKey, accountId = null }) {
    return this.serial(async () => {
      const config = this.config;
      if (!config) throw new Error("Start the MCP runtime before adding more tunnels.");
      const name = typeof label === "string" ? label.trim() : "";
      const id = typeof tunnelId === "string" ? tunnelId.trim() : "";
      const key = typeof runtimeKey === "string" ? runtimeKey.trim() : "";
      if (!name || name.length > MAX_LABEL_LENGTH) throw new Error(`Give the tunnel a name of up to ${MAX_LABEL_LENGTH} characters.`);
      if (!TUNNEL_ID.test(id)) throw new Error("The Tunnel ID is tunnel_ followed by 32 lowercase hexadecimal characters.");
      if (!key || Buffer.byteLength(key) > MAX_KEY_BYTES) throw new Error("Paste the API key for this tunnel.");
      if (accountId !== null && !ACCOUNT_ID.test(accountId)) throw new Error("The ChatGPT account is invalid.");
      const entries = this.entries();
      if (entries.length >= MAX_TUNNELS) throw new Error(`Up to ${MAX_TUNNELS} extra tunnels are supported.`);
      const taken = [config.tunnel, config.automaticTunnel, config.manualTunnel].map(tunnel => tunnel?.tunnelId)
        .concat(entries.map(entry => entry.tunnelId));
      if (taken.includes(id)) throw new Error("That Tunnel ID is already connected. Each tunnel can serve one connection here.");
      if (accountId !== null && entries.some(entry => entry.accountId === accountId)) {
        throw new Error("That ChatGPT account already has its own tunnel.");
      }
      let entryId;
      do entryId = crypto.randomBytes(4).toString("hex"); while (entries.some(entry => entry.id === entryId));
      const entry = { id: entryId, label: name, tunnelId: id, accountId };
      writePrivateFileAtomic(this.keyPath(entryId), key);
      this.writeEntries([...entries, entry]);
      try {
        await this.connect(entry, config);
      } catch (error) {
        this.writeEntries(this.entries().filter(candidate => candidate.id !== entryId));
        fs.rmSync(this.keyPath(entryId), { force: true });
        this.runtime.delete(entryId);
        this.onChange(this.status());
        throw new Error(`The tunnel did not connect, so it was not added: ${message(error)}`);
      }
      return this.status().find(candidate => candidate.id === entryId);
    });
  }

  /** Stops a tunnel and forgets it and its key. */
  remove(id) {
    return this.serial(async () => {
      const entry = this.entries().find(candidate => candidate.id === id);
      if (!entry) throw new Error("That tunnel is not configured.");
      if (this.config) await this.stopAlias(this.tunnelFor(entry, this.config));
      this.writeEntries(this.entries().filter(candidate => candidate.id !== id));
      fs.rmSync(this.keyPath(id), { force: true });
      this.runtime.delete(id);
      this.onChange(this.status());
      return { removed: true };
    });
  }

  /** Restarts one tunnel now, also one that gave up after repeated failures. */
  reconnect(id) {
    return this.serial(async () => {
      const entry = this.entries().find(candidate => candidate.id === id);
      if (!entry) throw new Error("That tunnel is not configured.");
      if (!this.config) throw new Error("Start the MCP runtime before reconnecting a tunnel.");
      this.runtime.set(id, { ...(this.runtime.get(id) ?? {}), failures: 0, restarts: [] });
      await this.connect(entry, this.config, { force: true });
      return this.status().find(candidate => candidate.id === id);
    });
  }

  /** Records scoped connector identities; saved records still require fresh remote verification. */
  setConnector(id, href, context) {
    const entries = this.entries();
    const entry = entries.find(entry => entry.id === id);
    if (!entry) throw new Error("That tunnel is not configured.");
    const binding = context === undefined ? null : connectorBinding(context, entry.tunnelId, href);
    if (context !== undefined && !binding) throw new Error("The connector binding does not match this tunnel and workspace.");
    const bindings = (Array.isArray(entry.connectorBindings) ? entry.connectorBindings : [])
      .map(saved => connectorBinding(saved, entry.tunnelId)).filter(Boolean);
    const next = binding ? bindings.filter(saved => saved.userId !== binding.userId || saved.workspaceId !== binding.workspaceId)
      .concat(binding).slice(-MAX_CONNECTOR_BINDINGS) : bindings;
    this.writeEntries(entries.map(entry => (entry.id === id ? { ...entry, connectorHref: href, connectorBindings: next } : entry)));
    this.onChange(this.status());
  }

  /** A removed ChatGPT account's tunnels stay, unassigned, so a new account can take them. */
  forgetAccount(accountId) {
    const entries = this.entries();
    const owned = entries.filter(entry => entry.accountId === accountId).length;
    if (!owned) return 0;
    this.writeEntries(entries.map(entry => (entry.accountId === accountId ? { ...entry, accountId: null } : entry)));
    this.onChange(this.status());
    return owned;
  }

  /** Leaves the tunnels running for the next launcher (keep-bridge quit or update). */
  detach() {
    this.config = null;
    this.stopMonitor();
  }

  /** Stops every extra tunnel; returns the failures. */
  stopAll(config) {
    this.config = null;
    this.stopMonitor();
    return this.serial(async () => {
      const failures = [];
      if (config?.mode !== "full" || !config.tunnel) return failures;
      for (const entry of this.entries()) {
        try {
          await this.stopAlias(this.tunnelFor(entry, config));
          this.setState(entry.id, "stopped");
        } catch (error) {
          failures.push(`${entry.label}: ${message(error)}`);
        }
      }
      return failures;
    });
  }
}

module.exports = { ExtraTunnels, MAX_TUNNELS, aliasOf, parseInventory };
