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
