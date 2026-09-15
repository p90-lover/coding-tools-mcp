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
  "updates",
  "diagnostics",
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

test("an invalid main-process response is rejected before reaching the renderer", async () => {
  const { api } = loadPreload(() => ({ state: "mystery" }));
  await assert.rejects(api.runtime.status(), /IPC_RESPONSE_SCHEMA_INVALID/);
});
