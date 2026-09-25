"use strict";

const fs = require("node:fs");
const path = require("node:path");

const FIVE_STACK_ENDPOINTS = Object.freeze({
  web: Object.freeze({
    origin: "http://127.0.0.1:17841",
    v1: "http://127.0.0.1:17841/v1",
  }),
  cpa: Object.freeze({
    origin: "http://127.0.0.1:8317",
    v1: "http://127.0.0.1:8317/v1",
  }),
  "codex-router": Object.freeze({
    origin: "http://127.0.0.1:4202",
    v1: "http://127.0.0.1:4202/v1",
  }),
  "commandcode-proxy": Object.freeze({
    origin: "http://127.0.0.1:9090",
    v1: "http://127.0.0.1:9090/v1",
  }),
  paseo: Object.freeze({
    origin: "http://127.0.0.1:6768",
    ws: "ws://127.0.0.1:6768/ws",
  }),
  anneal: Object.freeze({
    web: "http://127.0.0.1:5173",
    api: "http://127.0.0.1:3000",
  }),
});

const OPENAI_COMPAT_KEYS = Object.freeze([
  "OPENAI_BASE_URL",
  "OPENAI_API_BASE",
  "OPENAI_API_KEY",
]);

function stripEmpty(entries) {
  return Object.fromEntries(
    Object.entries(entries).filter(([, value]) => typeof value === "string" && value.length > 0),
  );
}

function omitKeys(source, keys) {
  const skip = new Set(keys);
  return Object.fromEntries(Object.entries(source).filter(([key]) => !skip.has(key)));
}

function publicUrlMap({
  cpaOrigin = FIVE_STACK_ENDPOINTS.cpa.origin,
  routerOrigin = FIVE_STACK_ENDPOINTS["codex-router"].origin,
  commandCodeOrigin = FIVE_STACK_ENDPOINTS["commandcode-proxy"].origin,
  paseoOrigin = FIVE_STACK_ENDPOINTS.paseo.origin,
  paseoExecution = FIVE_STACK_ENDPOINTS.paseo.ws,
  annealWeb = FIVE_STACK_ENDPOINTS.anneal.web,
  annealApi = FIVE_STACK_ENDPOINTS.anneal.api,
} = {}) {
  const cpa = String(cpaOrigin || "").replace(/\/$/, "");
  const router = String(routerOrigin || "").replace(/\/$/, "");
  const commandCode = String(commandCodeOrigin || "").replace(/\/$/, "");
  const paseo = String(paseoOrigin || "").replace(/\/$/, "");
  const anneal = String(annealWeb || "").replace(/\/$/, "");
  const annealExecution = String(annealApi || "").replace(/\/$/, "");
  return stripEmpty({
    CODING_TOOLS_FIVE_STACK_CROSS_USE: "1",
    CODING_TOOLS_CPA_URL: cpa,
    CODING_TOOLS_CPA_OPENAI_BASE_URL: `${cpa}/v1`,
    CODING_TOOLS_CODEX_ROUTER_URL: router,
    CODING_TOOLS_COMMANDCODE_URL: commandCode,
    CODING_TOOLS_COMMANDCODE_OPENAI_BASE_URL: `${commandCode}/v1`,
    CODING_TOOLS_PASEO_URL: paseo,
    CODING_TOOLS_PASEO_EXECUTION_URL: paseoExecution,
    CODING_TOOLS_ANNEAL_URL: anneal,
    CODING_TOOLS_ANNEAL_EXECUTION_URL: annealExecution,
    PASEO_ANNEAL_API_URL: annealExecution,
    ANNEAL_PASEO_URL: paseo,
    ANNEAL_API_URL: annealExecution,
  });
}

function inAppGenericProviders() {
  return Object.freeze([
    Object.freeze({
      id: "cpa",
      name: "CPA / CLIProxyAPI",
      baseUrl: FIVE_STACK_ENDPOINTS.cpa.v1,
      adapter: "openai-chat",
      allowPrivate: true,
      apiKeyEnv: "CODING_TOOLS_CPA_PROXY_API_KEY",
    }),
    Object.freeze({
      id: "commandcode-proxy",
      name: "CommandCode Proxy",
      baseUrl: FIVE_STACK_ENDPOINTS["commandcode-proxy"].v1,
      adapter: "openai-chat",
      allowPrivate: true,
      apiKeyEnv: "CODING_TOOLS_COMMANDCODE_API_KEY",
    }),
  ]);
}

function buildFiveStackCrossUseEnvironment({
  cpaProxyApiKey = "",
  commandCodeProxyApiKey = "",
  routerCallerKey = "",
  urls = {},
} = {}) {
  const map = publicUrlMap(urls);
  const cpaKey = String(cpaProxyApiKey || "").trim();
  const commandCodeKey = String(commandCodeProxyApiKey || "").trim();
  const callerKey = String(routerCallerKey || "").trim();
  return stripEmpty({
    ...map,
    ...(cpaKey ? {
      CODING_TOOLS_CPA_PROXY_API_KEY: cpaKey,
      OPENAI_BASE_URL: map.CODING_TOOLS_CPA_OPENAI_BASE_URL,
      OPENAI_API_BASE: map.CODING_TOOLS_CPA_OPENAI_BASE_URL,
      OPENAI_API_KEY: cpaKey,
      PASEO_OPENAI_BASE_URL: map.CODING_TOOLS_CPA_OPENAI_BASE_URL,
      PASEO_OPENAI_API_KEY: cpaKey,
      ANNEAL_OPENAI_BASE_URL: map.CODING_TOOLS_CPA_OPENAI_BASE_URL,
      ANNEAL_OPENAI_API_KEY: cpaKey,
      COMMANDCODE_UPSTREAM_BASE_URL: map.CODING_TOOLS_CPA_OPENAI_BASE_URL,
      COMMANDCODE_UPSTREAM_API_KEY: cpaKey,
    } : {}),
    ...(commandCodeKey ? { CODING_TOOLS_COMMANDCODE_API_KEY: commandCodeKey } : {}),
    ...(callerKey ? { CODING_TOOLS_CODEX_ROUTER_CALLER_KEY: callerKey } : {}),
  });
}

function peerEnvironmentFor(componentId, secrets = {}) {
  const env = buildFiveStackCrossUseEnvironment(secrets);
  if (componentId === "cpa") {
    return omitKeys(env, OPENAI_COMPAT_KEYS);
  }
  return env;
}

function writeInAppProvidersFile(routerStateDir) {
  if (!routerStateDir || !path.isAbsolute(routerStateDir)) {
    throw new Error("Codex Router state directory must be absolute");
  }
  fs.mkdirSync(routerStateDir, { recursive: true, mode: 0o700 });
  const destination = path.join(routerStateDir, "in-app-providers.json");
  const payload = `${JSON.stringify({
    schemaVersion: 1,
    source: "coding-tools-desktop",
    providers: inAppGenericProviders(),
  }, null, 2)}\n`;
  fs.writeFileSync(destination, payload, { encoding: "utf8", mode: 0o600 });
  return destination;
}

module.exports = {
  FIVE_STACK_ENDPOINTS,
  buildFiveStackCrossUseEnvironment,
  inAppGenericProviders,
  peerEnvironmentFor,
  publicUrlMap,
  writeInAppProvidersFile,
};
