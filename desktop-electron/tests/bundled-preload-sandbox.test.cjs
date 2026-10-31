const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const test = require("node:test");
const { buildSync } = require("esbuild");

test("packaged preload exposes the module API with Electron sandbox restrictions", () => {
  const code = process.env.CODEX_PRELOAD_ARTIFACT
    ? fs.readFileSync(process.env.CODEX_PRELOAD_ARTIFACT, "utf8")
    : buildSync({ entryPoints: [path.join(__dirname, "../electron/preload.cjs")], bundle: true,
      platform: "node", format: "cjs", target: "node22", external: ["electron"], write: false,
    }).outputFiles[0].text;
  const exposed = {};
  const electron = {
    contextBridge: { exposeInMainWorld: (name, api) => { exposed[name] = api; } },
    ipcRenderer: { invoke: async () => null, send() {}, on() {}, removeListener() {} },
  };
  vm.runInNewContext(code, {
    require(name) { if (name !== "electron") throw Error(`Sandbox cannot require ${name}`); return electron; },
    console, setTimeout, clearTimeout, TextEncoder, structuredClone,
  });
  assert(exposed.codexWebLauncher);
  assert.equal(typeof exposed.codingTools?.apps?.call, "function");
  assert.equal(typeof exposed.codingTools?.execution?.update, "function");
  assert.equal(exposed.codingTools.invoke, undefined);
  assert.equal(exposed.codingTools.readFile, undefined);
});

test("while main says the window is away, app calls stop in the preload instead of flooding main with refusals", async () => {
  const code = buildSync({ entryPoints: [path.join(__dirname, "../electron/preload.cjs")], bundle: true,
    platform: "node", format: "cjs", target: "node22", external: ["electron"], write: false,
  }).outputFiles[0].text;
  const exposed = {};
  const listeners = new Map();
  const invoked = [];
  const electron = {
    contextBridge: { exposeInMainWorld: (name, api) => { exposed[name] = api; } },
    ipcRenderer: {
      invoke: async (channel) => { invoked.push(channel); return { ok: true }; },
      send() {}, on(channel, listener) { listeners.set(channel, listener); }, removeListener() {},
    },
  };
  const sandbox = vm.createContext({
    require(name) { if (name !== "electron") throw Error(`Sandbox cannot require ${name}`); return electron; },
    console, setTimeout, clearTimeout, TextEncoder, structuredClone,
  });
  vm.runInContext(code, sandbox);
  // Made in the preload's own realm, as contextBridge hands the page's arguments over.
  const call = () => exposed.codingTools.apps.call(vm.runInContext('({ moduleId: "agent-orchestrator", operation: "activity" })', sandbox));

  listeners.get("launcher:window-shown")({}, false);
  await assert.rejects(call(), /not minimized/);
  assert.deepEqual(invoked, [], "nothing reached main while the window was minimized");

  listeners.get("launcher:window-shown")({}, true);
  await call().catch(() => {});
  assert.deepEqual(invoked, ["coding-tools:apps:call"], "calls go through again once it is shown");
});

test("the page learns the window is away from <html> data-window-away, with a visibilitychange each time it flips", () => {
  const code = buildSync({ entryPoints: [path.join(__dirname, "../electron/preload.cjs")], bundle: true,
    platform: "node", format: "cjs", target: "node22", external: ["electron"], write: false,
  }).outputFiles[0].text;
  const listeners = new Map();
  const electron = {
    contextBridge: { exposeInMainWorld() {} },
    ipcRenderer: { invoke: async () => null, send() {}, on(channel, listener) { listeners.set(channel, listener); }, removeListener() {} },
  };
  const attributes = new Set();
  const events = [];
  const document = {
    documentElement: { hasAttribute: (name) => attributes.has(name), toggleAttribute: (name, on) => { if (on) attributes.add(name); else attributes.delete(name); } },
    dispatchEvent: (event) => { events.push(event.type); return true; },
  };
  vm.runInNewContext(code, {
    require(name) { if (name !== "electron") throw Error(`Sandbox cannot require ${name}`); return electron; },
    console, setTimeout, clearTimeout, TextEncoder, structuredClone, document, Event: class { constructor(type) { this.type = type; } },
  });
  const shown = listeners.get("launcher:window-shown");
  shown({}, false);
  assert.ok(attributes.has("data-window-away"), "minimized: marked away");
  shown({}, false);
  assert.deepEqual(events, ["visibilitychange"], "the same state again fires nothing");
  shown({}, true);
  assert.ok(!attributes.has("data-window-away"), "restored: no longer away");
  assert.deepEqual(events, ["visibilitychange", "visibilitychange"]);
});
