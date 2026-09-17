"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.resolve(__dirname, "..");
const network = require(path.join(root, "electron/provider-network.cjs"));

function jsonResponse(value, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() {
      return value;
    },
  };
}

function fixtureRoot() {
  const directory = path.join(
    root,
    "aiTemp/antigravity-session-binding",
    crypto.randomUUID(),
  );
  fs.mkdirSync(directory, { recursive: true });
  return directory;
}

function controllerFixture(fetchImpl) {
  const opened = [];
  const controller = network.createProviderNetworkController({
    app: {},
    browserPartition: "persist:antigravity-binding-test",
    getBrowserHost: () => null,
    logger: { info() {}, warn() {} },
    safeStorage: { isEncryptionAvailable: () => false },
    session: {
      defaultSession: { setProxy: async () => undefined },
      fromPartition: () => ({ setProxy: async () => undefined }),
    },
    shell: {
      async openExternal(url) {
        opened.push(url);
      },
    },
    userData: fixtureRoot(),
    fetchImpl,
    sleepImpl: async () => undefined,
    oauthPollIntervalMs: 0,
    oauthTimeoutMs: 2_000,
  });
  return { controller, opened };
}

function saveAccount(controller, credential = "management-secret") {
  const snapshot = controller.store.saveAccount({
    providerId: "cliproxyapi-antigravity",
    label: "Bound Antigravity account",
    identity: "",
    auth: "local_proxy",
    status: "pending",
    enabled: true,
    isDefault: false,
    endpoint: "http://127.0.0.1:8317",
    models: [],
    secret: { credential },
  });
  return snapshot.accounts.find((account) => (
    account.providerId === "cliproxyapi-antigravity"
  ));
}

const existing = {
  name: "antigravity-existing@example.test.json",
  auth_index: "auth-existing",
  provider: "antigravity",
  label: "existing@example.test",
  email: "existing@example.test",
  status: "ready",
  status_message: "",
  disabled: false,
  unavailable: false,
};

const bound = {
  name: "antigravity-bound@example.test.json",
  auth_index: "auth-bound",
  provider: "antigravity",
  label: "bound@example.test",
  email: "bound@example.test",
  status: "ready",
  status_message: "",
  disabled: false,
  unavailable: false,
};

test("Antigravity login persists an encrypted auth-file binding and reuses a filtered lookup after credential edits", async () => {
  let phase = "login";
  let fullReads = 0;
  let filteredReads = 0;
  const fetchImpl = async (url, options = {}) => {
    const parsed = new URL(url);
    if (parsed.pathname === "/v0/management/antigravity-auth-url") {
      return jsonResponse({
        status: "ok",
        url: "https://accounts.google.com/o/oauth2/v2/auth?client_id=binding-test",
        state: "binding-state",
      });
    }
    if (parsed.pathname === "/v0/management/get-auth-status") {
      return jsonResponse({ status: "ok" });
    }
    if (parsed.pathname === "/v0/management/auth-files") {
      const name = parsed.searchParams.get("name");
      const authIndex = parsed.searchParams.get("auth_index");
      if (phase === "login") {
        assert.equal(name, null);
        assert.equal(authIndex, null);
        fullReads += 1;
        return jsonResponse({ files: fullReads === 1 ? [existing] : [existing, bound] });
      }
      filteredReads += 1;
      assert.equal(name, bound.name);
      assert.equal(authIndex, bound.auth_index);
      assert.equal(options.headers.Authorization, "Bearer management-secret-2");
      // Simulate an older server that ignores the filters. The persisted binding
      // must still select the exact account instead of the first healthy entry.
      return jsonResponse({ files: [existing, bound] });
    }
    if (parsed.pathname === "/v0/management/auth-files/models") {
      assert.equal(parsed.searchParams.get("name"), bound.name);
      return jsonResponse({ models: [{ id: "gemini-bound-account" }] });
    }
    throw new Error(`Unexpected request: ${parsed.pathname}`);
  };

  const { controller, opened } = controllerFixture(fetchImpl);
  const account = saveAccount(controller);
  const login = await controller.openProviderLogin(account.id);
  assert.deepEqual(opened, ["https://accounts.google.com/o/oauth2/v2/auth?client_id=binding-test"]);
  assert.equal(login.snapshot.accounts.find((item) => item.id === account.id).identity, "bound@example.test");

  const current = login.snapshot.accounts.find((item) => item.id === account.id);
  controller.store.saveAccount({
    ...current,
    secret: { credential: "management-secret-2" },
  });

  phase = "probe";
  const snapshot = await controller.probeProviderAccount(account.id);
  const connected = snapshot.accounts.find((item) => item.id === account.id);
  assert.equal(connected.status, "connected");
  assert.equal(connected.identity, "bound@example.test");
  assert.deepEqual(connected.models, ["gemini-bound-account"]);
  assert.equal(filteredReads, 1);
  assert.equal(JSON.stringify(snapshot).includes(bound.auth_index), false);
  assert.equal(JSON.stringify(snapshot).includes(bound.name), false);
  assert.equal(JSON.stringify(snapshot).includes("management-secret-2"), false);
});

test("a missing bound Antigravity session fails closed instead of silently switching accounts", async () => {
  let phase = "login";
  let fullReads = 0;
  let modelReads = 0;
  const fetchImpl = async (url) => {
    const parsed = new URL(url);
    if (parsed.pathname === "/v0/management/antigravity-auth-url") {
      return jsonResponse({
        status: "ok",
        url: "https://accounts.google.com/o/oauth2/v2/auth?client_id=missing-binding-test",
        state: "missing-binding-state",
      });
    }
    if (parsed.pathname === "/v0/management/get-auth-status") {
      return jsonResponse({ status: "ok" });
    }
    if (parsed.pathname === "/v0/management/auth-files") {
      if (phase === "login") {
        fullReads += 1;
        return jsonResponse({ files: fullReads === 1 ? [] : [bound] });
      }
      assert.equal(parsed.searchParams.get("name"), bound.name);
      assert.equal(parsed.searchParams.get("auth_index"), bound.auth_index);
      // A stale or filter-ignoring server response must not rebind this account.
      return jsonResponse({ files: [existing] });
    }
    if (parsed.pathname === "/v0/management/auth-files/models") {
      modelReads += 1;
      return jsonResponse({ models: [{ id: "wrong-account-model" }] });
    }
    throw new Error(`Unexpected request: ${parsed.pathname}`);
  };

  const { controller } = controllerFixture(fetchImpl);
  const account = saveAccount(controller);
  await controller.openProviderLogin(account.id);
  phase = "missing";

  const snapshot = await controller.probeProviderAccount(account.id);
  const pending = snapshot.accounts.find((item) => item.id === account.id);
  assert.equal(pending.status, "pending");
  assert.match(pending.error, /bound Antigravity session|log in again/i);
  assert.equal(pending.identity, "bound@example.test");
  assert.deepEqual(pending.models, []);
  assert.equal(modelReads, 1, "only the successful login may discover models");
});
