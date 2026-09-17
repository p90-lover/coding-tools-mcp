"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
  COMMANDCODE_PROVIDER_ID,
  DEFAULT_COMMANDCODE_PROXY_URL,
  commandCodeAuthFilePath,
  commandCodeModelIds,
  commandCodeToken,
  createProviderNetworkController,
} = require("../electron/provider-network.cjs");

function temporaryDirectory(name) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `${name}-`));
}

function safeStorage() {
  return {
    isEncryptionAvailable: () => false,
  };
}

function sessionMock() {
  const target = { setProxy: async () => {} };
  return {
    defaultSession: target,
    fromPartition: () => target,
  };
}

function logger() {
  return {
    info() {},
    warn() {},
  };
}

function jsonResponse(value, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() { return value; },
  };
}

function commandCodeFetch() {
  return async (rawUrl, options = {}) => {
    const url = new URL(rawUrl);
    const authorization = options.headers?.Authorization ?? options.headers?.authorization;
    assert.match(String(authorization), /^Bearer cc-/);
    if (url.hostname === "api.commandcode.ai" && url.pathname === "/alpha/whoami") {
      return jsonResponse({ id: "commandcode-user", email: "user@example.test" });
    }
    if (url.hostname === "127.0.0.1" && url.pathname === "/v1/models") {
      return jsonResponse({ data: [{ id: "cc-model-one" }, { id: "cc-model-two" }] });
    }
    if (url.hostname === "127.0.0.1" && ["/health", "/api/status"].includes(url.pathname)) {
      return jsonResponse({ status: "ok" });
    }
    return jsonResponse({ error: `unexpected ${url}` }, 404);
  };
}

function controller({ homeDirectory, shell, fetchImpl = commandCodeFetch() }) {
  return createProviderNetworkController({
    app: {},
    browserPartition: "persist:commandcode-test",
    getBrowserHost: () => null,
    logger: logger(),
    safeStorage: safeStorage(),
    session: sessionMock(),
    shell,
    userData: temporaryDirectory("commandcode-user-data"),
    homeDirectory,
    fetchImpl,
    oauthTimeoutMs: 3_000,
    requestTimeoutMs: 1_000,
  });
}

function addCommandCodeAccount(active, overrides = {}) {
  const snapshot = active.store.saveAccount({
    providerId: COMMANDCODE_PROVIDER_ID,
    label: "CommandCode main",
    identity: "",
    endpoint: DEFAULT_COMMANDCODE_PROXY_URL,
    auth: "local_proxy",
    status: "pending",
    enabled: true,
    isDefault: false,
    models: [],
    ...overrides,
  });
  return snapshot.accounts[0];
}

test("CommandCode token and model normalization accept CLI and OpenAI-compatible payloads", () => {
  assert.equal(commandCodeToken({ apiKey: " cc-one " }), "cc-one");
  assert.equal(commandCodeToken({ token: "cc-two" }), "cc-two");
  assert.equal(commandCodeToken({ credential: "cc-three" }), "cc-three");
  assert.deepEqual(
    commandCodeModelIds({ data: [{ id: "model-b" }, { id: "model-a" }, { id: "model-a" }] }),
    ["model-a", "model-b"],
  );
});

test("CommandCode CLI session import stays encrypted and refreshes identity and models", async () => {
  const homeDirectory = temporaryDirectory("commandcode-home");
  const authPath = commandCodeAuthFilePath(homeDirectory);
  fs.mkdirSync(path.dirname(authPath), { recursive: true });
  fs.writeFileSync(authPath, JSON.stringify({ apiKey: "cc-imported-token" }), { mode: 0o600 });

  const active = controller({
    homeDirectory,
    shell: { openExternal: async () => {} },
  });
  const account = addCommandCodeAccount(active);
  const snapshot = await active.importProviderSession(account.id);
  const connected = snapshot.accounts.find((candidate) => candidate.id === account.id);

  assert.equal(connected.status, "connected");
  assert.equal(connected.identity, "user@example.test");
  assert.deepEqual(connected.models, ["cc-model-one", "cc-model-two"]);
  assert.equal(connected.hasCredential, true);
  assert.equal(JSON.stringify(snapshot).includes("cc-imported-token"), false);
  assert.equal(active.store.accountSecret(account.id).apiKey, "cc-imported-token");
});

test("CommandCode browser OAuth captures the callback token without exposing it to the renderer", async () => {
  const homeDirectory = temporaryDirectory("commandcode-oauth-home");
  let openedUrl = null;
  const active = controller({
    homeDirectory,
    shell: {
      openExternal: async (url) => {
        openedUrl = new URL(url);
        const callback = new URL(openedUrl.searchParams.get("callback"));
        callback.searchParams.set("state", openedUrl.searchParams.get("state"));
        callback.searchParams.set("token", "cc-browser-token");
        setTimeout(() => {
          http.get(callback).on("error", () => {});
        }, 25);
      },
    },
  });
  const account = addCommandCodeAccount(active);
  const result = await active.openProviderLogin(account.id);
  const connected = result.snapshot.accounts.find((candidate) => candidate.id === account.id);

  assert.equal(openedUrl.hostname, "commandcode.ai");
  assert.equal(openedUrl.pathname, "/studio/auth/cli");
  assert.equal(result.mode, "external");
  assert.equal(connected.status, "connected");
  assert.equal(connected.identity, "user@example.test");
  assert.equal(JSON.stringify(result).includes("cc-browser-token"), false);
  assert.equal(active.store.accountSecret(account.id).apiKey, "cc-browser-token");
});

test("CommandCode integration is exposed through provider metadata, IPC and UI", () => {
  const root = path.resolve(__dirname, "..");
  const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), "utf8");
  const types = read("src/providers/provider-types.ts");
  const bootstrap = read("electron/provider-bootstrap.cjs");
  const preload = read("electron/preload.cjs");
  const rendererTypes = read("src/types.ts");
  const surface = read("src/features/ProviderHubSaasSurface.tsx");

  assert.match(types, /"commandcode_oauth"/);
  assert.match(types, /loginMode:\s*"commandcode_oauth"/);
  assert.match(bootstrap, /launcher:provider-session-import/);
  assert.match(preload, /importProviderSession/);
  assert.match(rendererTypes, /importProviderSession\(accountId: string\)/);
  assert.match(surface, /Login with CommandCode/);
  assert.match(surface, /Import CommandCode CLI session/);
  assert.match(surface, /accountValidation/);
  assert.match(surface, /provider-account-inline-error/);
  assert.match(surface, /routingRequirements/);
});
