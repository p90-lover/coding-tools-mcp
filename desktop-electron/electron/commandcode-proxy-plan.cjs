"use strict";

const { spawnSync } = require("node:child_process");

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);
const PROVIDER_ID = "commandcode-proxy";
const PROVIDER_NAME = "CommandCode Proxy";
const COMMANDCODE_DEFAULT_BASE_URL = "http://127.0.0.1:9090/v1";
const COMMANDCODE_ALTERNATE_LISTEN = "http://127.0.0.1:3050/";

function normalizeOrigin(value, label, allowRemoteHttps) {
  let url;
  try {
    url = new URL(String(value || "").trim());
  } catch {
    throw new Error(`${label} must be a valid URL`);
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error(`${label} must not contain credentials, query parameters, or fragments`);
  }
  const hostname = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  const loopback = LOOPBACK_HOSTS.has(hostname) || LOOPBACK_HOSTS.has(url.hostname);
  if (url.protocol === "http:" && !loopback) {
    throw new Error(`${label} must use loopback or HTTPS`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`${label} must use HTTP(S)`);
  }
  if (!loopback && !allowRemoteHttps) {
    throw new Error(`${label} must use a loopback host`);
  }
  url.pathname = url.pathname.replace(/\/+$/u, "") || "/";
  return url.toString().replace(/\/$/u, "");
}

function isLoopbackUrl(value) {
  const hostname = new URL(value).hostname.replace(/^\[|\]$/g, "").toLowerCase();
  return LOOPBACK_HOSTS.has(hostname);
}

function commandCodeProxyProviderProfile(baseUrl) {
  const normalized = normalizeOrigin(baseUrl, "CommandCode Proxy URL", true);
  return {
    id: PROVIDER_ID,
    name: PROVIDER_NAME,
    baseUrl: normalized,
    adapter: "openai-chat",
    modelEndpoint: "/models",
  };
}

function safeCli(value, label) {
  const trimmed = typeof value === "string" ? value.trim() : "";
  if (!trimmed || trimmed.length > 256) throw new Error(`${label} path is required`);
  if (trimmed.includes("..") || /[\0\s]/u.test(trimmed)) {
    throw new Error(`${label} must be a simple executable name or absolute path`);
  }
  if (!/^[A-Za-z0-9_./:@=-]+$/u.test(trimmed)) {
    throw new Error(`${label} must be a simple executable name or absolute path`);
  }
  return trimmed;
}

function commandCodeProxyRegistrationPlan({
  baseUrl = COMMANDCODE_DEFAULT_BASE_URL,
  routerCli = "model-router",
  curateCli = "curate-models",
} = {}) {
  const router = safeCli(routerCli, "Codex Router CLI");
  const curate = safeCli(curateCli, "Codex Router curate-models");
  const provider = commandCodeProxyProviderProfile(baseUrl);
  const add = [
    router,
    "codex",
    "providers",
    "generic",
    "add",
    provider.id,
    "--name",
    provider.name,
    "--base-url",
    provider.baseUrl,
    "--adapter",
    provider.adapter,
  ];
  if (isLoopbackUrl(provider.baseUrl)) add.push("--allow-private");
  return {
    provider,
    commands: [
      add,
      [router, "codex", "providers", "generic", "credential", provider.id, "set"],
      [router, "codex", "providers", "generic", "enable", provider.id],
      [curate, provider.id],
    ],
    credentialPromptRequired: true,
  };
}

function shellQuote(value) {
  if (/^[A-Za-z0-9_./:@=-]+$/u.test(value)) return value;
  return `'${String(value).replaceAll("'", `'"'"'`)}'`;
}

function renderCommandCodeProxyPlan(plan) {
  return [
    "CommandCode Proxy will be registered as a Codex Router generic provider.",
    "The CommandCode user_* key is entered only in Codex Router's hidden credential prompt; Coding Tools never accepts it.",
    "",
    ...plan.commands.map((command) => command.map(shellQuote).join(" ")),
    "",
    "Run the curation step after the provider credential and enable steps so the live /v1/models catalog becomes available to Codex subagents.",
  ].join("\n");
}

function nonSecretCommands(plan) {
  return [
    { name: "add", command: plan.commands[0] },
    { name: "enable", command: plan.commands[2] },
    { name: "curate", command: plan.commands[3] },
  ];
}

function applyCommandCodeProxyPlan(options = {}, { spawnSyncImpl = spawnSync } = {}) {
  const plan = commandCodeProxyRegistrationPlan(options);
  const serialized = JSON.stringify(plan);
  if (serialized.includes("user_*") && plan.commands.some((command) => command.includes("user_*"))) {
    throw new Error("CommandCode plans must not collect a user_* key");
  }
  const steps = nonSecretCommands(plan).map(({ name, command }) => {
    if (command.includes("credential")) {
      throw new Error("Credential commands cannot be applied from Coding Tools");
    }
    const result = spawnSyncImpl(command[0], command.slice(1), {
      encoding: "utf8",
      timeout: 30_000,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    if (result.error) {
      return {
        name,
        ok: false,
        detail: `${command[0]} is not runnable (${result.error.message}). Copy the plan and run it where Codex Router CLI is installed.`,
      };
    }
    if ((result.status ?? 1) !== 0) {
      const detail = String(result.stderr || result.stdout || "").trim().slice(0, 240);
      return {
        name,
        ok: false,
        detail: detail || `${name} exited with ${result.status ?? "unknown"}`,
      };
    }
    return { name, ok: true, detail: `${name} completed` };
  });
  return {
    endpoint: plan.provider.baseUrl,
    credentialPromptRequired: true,
    steps,
    planText: renderCommandCodeProxyPlan(plan),
  };
}

function commandCodeBanner(endpoint, health = null, modelCount = null) {
  const parsed = new URL(normalizeOrigin(endpoint, "CommandCode Proxy URL", false));
  const origin = `${parsed.protocol}//${parsed.host}`;
  const path = parsed.pathname.replace(/\/+$/u, "");
  const cursorBase = !path || path === "/" || path === "/v1"
    ? `${origin}/v1`
    : path.endsWith("/v1")
      ? `${origin}${path}`
      : `${origin}${path}/v1`;
  return {
    version: null,
    listen: parsed.toString().replace(/\/$/u, "") || origin,
    cursor_base_url: cursorBase,
    anthropic_base_url: origin,
    health: health == null ? null : String(health).replace(/[\u0000-\u001f]/gu, "").slice(0, 32),
    model_count: modelCount,
  };
}

module.exports = {
  COMMANDCODE_ALTERNATE_LISTEN,
  COMMANDCODE_DEFAULT_BASE_URL,
  applyCommandCodeProxyPlan,
  commandCodeBanner,
  commandCodeProxyProviderProfile,
  commandCodeProxyRegistrationPlan,
  renderCommandCodeProxyPlan,
};
