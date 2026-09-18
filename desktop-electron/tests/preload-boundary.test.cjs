const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const Module = require("node:module");

const REQUIRED_NAMESPACES = [
  "runtime",
  "workspaces",
  "permissions",
  "computer",
  "tasks",
  "history",
  "nativeCodex",
  "integrations",
  "execution",
  "updates",
  "diagnostics",
  "tools",
];

function loadPreload(respond = () => null) {
  const exposed = Object.create(null);
  const invocations = [];
  const electronMock = {
    contextBridge: {
      exposeInMainWorld(name, value) {
        exposed[name] = value;
      },
    },
    ipcRenderer: {
      async invoke(channel, payload) {
        const clonedPayload = structuredClone(payload);
        invocations.push({ channel, payload: clonedPayload });
        return respond(channel, clonedPayload);
      },
      on() {},
      removeListener() {},
      send() {},
    },
  };

  const preloadPath = path.resolve(__dirname, "../electron/preload.cjs");
  const originalLoad = Module._load;
  Module._load = function load(request, parent, isMain) {
    if (request === "electron") return electronMock;
    return originalLoad.call(this, request, parent, isMain);
  };

  try {
    delete require.cache[require.resolve(preloadPath)];
    require(preloadPath);
  } finally {
    Module._load = originalLoad;
  }

  return { api: exposed.codingTools, launcher: exposed.codexWebLauncher, invocations };
}

test("preload exposes only the named Coding Tools domains and no generic privileged API", () => {
  const { api, launcher } = loadPreload();

  assert.ok(launcher, "the existing launcher API must remain available");
  assert.ok(api, "the typed Coding Tools API must be exposed");
  assert.deepEqual(Object.keys(api).sort(), [...REQUIRED_NAMESPACES].sort());
  assert.equal(api.invoke, undefined);
  assert.equal(api.spawn, undefined);
  assert.equal(api.readFile, undefined);
  assert.equal(api.cookies, undefined);
});

test("a typed workspace list call uses its exact channel and validates its response", async () => {
  const response = {
    items: [{
      id: "workspace-1",
      name: "Fixture",
      path: "C:\\fixture",
      mcpState: "running",
      policyRevision: 7,
    }],
    nextCursor: null,
  };
  const { api, invocations } = loadPreload(() => response);

  assert.deepEqual(await api.workspaces.list({ cursor: 0, limit: 25 }), response);
  assert.deepEqual(invocations, [{
    channel: "coding-tools:workspaces:list",
    payload: { cursor: 0, limit: 25 },
  }]);
});

test("runtime status remains bounded without freezing the producer-owned DTO", async () => {
  const response = {
    ready: true,
    accepting: true,
    active_requests: 1,
    automatic_replay: false,
  };
  const { api, invocations } = loadPreload(() => response);

  assert.deepEqual(await api.runtime.status(), response);
  assert.deepEqual(invocations, [{
    channel: "coding-tools:runtime:status",
    payload: {},
  }]);
});

test("validated requests are snapshotted before IPC so accessors cannot change them", async () => {
  let reads = 0;
  const input = { cursor: 0 };
  Object.defineProperty(input, "limit", {
    enumerable: true,
    get() {
      reads += 1;
      return reads <= 3 ? 25 : 1000;
    },
  });
  const { api, invocations } = loadPreload(() => ({ items: [], nextCursor: null }));

  await api.workspaces.list(input);

  assert.deepEqual(invocations, [{
    channel: "coding-tools:workspaces:list",
    payload: { cursor: 0, limit: 25 },
  }]);
  assert.equal(reads, 1, "validation must read each accessor only once");
});

test("schema-invalid and oversized requests fail before Electron IPC", async () => {
  const { api, invocations } = loadPreload();

  await assert.rejects(
    api.workspaces.list({ cursor: 0, limit: 25, extra: true }),
    /IPC_REQUEST_SCHEMA_INVALID/,
  );
  await assert.rejects(
    api.workspaces.list({ cursor: Number.MAX_SAFE_INTEGER + 1 }),
    /IPC_REQUEST_SCHEMA_INVALID/,
  );
  await assert.rejects(
    api.history.search({ workspaceRoot: "C:\\fixture", query: "x".repeat(70_000) }),
    /IPC_REQUEST_TOO_LARGE/,
  );
  const cyclic = { workspaceId: "workspace-1" };
  cyclic.self = cyclic;
  await assert.rejects(
    api.permissions.snapshot(cyclic),
    /IPC_REQUEST_SCHEMA_INVALID/,
  );
  assert.equal(invocations.length, 0);
});

test("forged validation codes thrown by accessors are normalized", async () => {
  const input = {};
  Object.defineProperty(input, "workspaceId", {
    enumerable: true,
    get() {
      throw { code: "IPC_REQUEST_SCHEMA_INVALID", message: "forged renderer error" };
    },
  });
  const { api, invocations } = loadPreload();

  await assert.rejects(api.permissions.snapshot(input), (error) => {
    assert.equal(error instanceof Error, true);
    assert.match(error.message, /IPC_REQUEST_SCHEMA_INVALID: payload could not be read safely/);
    assert.doesNotMatch(error.message, /forged renderer error/);
    return true;
  });
  assert.equal(invocations.length, 0);
});

test("excessive object entries are rejected before reading accessors", async () => {
  let reads = 0;
  const response = {};
  for (let index = 0; index < 10_000; index += 1) {
    response[`key-${index}`] = index;
  }
  Object.defineProperty(response, "lateGetter", {
    enumerable: true,
    get() {
      reads += 1;
      return "must not run";
    },
  });
  const { api } = loadPreload(() => response);

  await assert.rejects(api.diagnostics.snapshot(), /IPC_RESPONSE_SCHEMA_INVALID/);
  assert.equal(reads, 0, "entry-count rejection must happen before getter evaluation");
});

test("an invalid workspace response is rejected before reaching the renderer", async () => {
  const response = {
    items: [{
      id: "workspace-1",
      name: "Fixture",
      path: "C:\\fixture",
      mcpState: "mystery",
      policyRevision: 7,
    }],
    nextCursor: null,
  };
  const { api } = loadPreload(() => response);

  await assert.rejects(api.workspaces.list(), /IPC_RESPONSE_SCHEMA_INVALID/);
});

test("secret-bearing response keys never cross the preload boundary", async () => {
  const { api } = loadPreload(() => ({
    ready: true,
    credentials: { access_token: "must-not-reach-renderer" },
  }));

  await assert.rejects(api.diagnostics.snapshot(), /IPC_RESPONSE_SCHEMA_INVALID/);
});

test("camelCase credential response keys never cross the preload boundary", async () => {
  for (const key of [
    "setCookie",
    "idToken",
    "authToken",
    "oauthToken",
    "bearerToken",
    "secretKey",
  ]) {
    const { api } = loadPreload(() => ({
      ready: true,
      credentials: { [key]: "must-not-reach-renderer" },
    }));

    await assert.rejects(
      api.diagnostics.snapshot(),
      /IPC_RESPONSE_SCHEMA_INVALID/,
      `${key} must be rejected`,
    );
  }
});

test("main-process transport failures do not leak raw credential-bearing errors", async () => {
  const { api } = loadPreload(() => {
    throw new Error("Authorization: Bearer must-not-reach-renderer");
  });

  await assert.rejects(api.diagnostics.snapshot(), (error) => {
    assert.equal(error instanceof Error, true);
    assert.match(error.message, /IPC_TRANSPORT_FAILED/);
    assert.doesNotMatch(error.message, /Authorization|Bearer|must-not-reach-renderer/);
    return true;
  });
});

test("prototype-pollution keys are rejected from main-process responses", async () => {
  const response = Object.create(null);
  Object.defineProperty(response, "__proto__", {
    value: { polluted: true },
    enumerable: true,
  });
  const { api } = loadPreload(() => response);

  await assert.rejects(api.diagnostics.snapshot(), /IPC_RESPONSE_SCHEMA_INVALID/);
});
