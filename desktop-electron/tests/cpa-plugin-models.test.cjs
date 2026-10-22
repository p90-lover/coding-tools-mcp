const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { clineModelsRevision, syncClineMarker, watchCpaPluginModels } = require("../electron/cpa-plugin-models.cjs");

function stateRoot({ models, marker = { type: "cline", switcher: true, label: "Cline Pass" } }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cpa-plugin-models-"));
  fs.mkdirSync(path.join(root, "cline-pass-switcher-data"), { recursive: true });
  fs.mkdirSync(path.join(root, "auth"), { recursive: true });
  fs.writeFileSync(path.join(root, "cline-pass-switcher-data", "config.json"), JSON.stringify({ knownModels: models, perModel: {}, accounts: [{ key: "secret" }] }));
  if (marker) fs.writeFileSync(path.join(root, "auth", "cline-pass-switcher.json"), JSON.stringify(marker));
  return root;
}
const markerOf = (root) => JSON.parse(fs.readFileSync(path.join(root, "auth", "cline-pass-switcher.json"), "utf8"));
const configOf = (root) => path.join(root, "cline-pass-switcher-data", "config.json");

test("the revision follows the model list, not its order or the switcher's other settings", () => {
  const one = clineModelsRevision({ knownModels: ["a", "b"], perModel: { c: {} }, accounts: [1] });
  assert.equal(one, clineModelsRevision({ knownModels: ["b", "a"], perModel: { c: {} }, accounts: [2, 3] }));
  assert.notEqual(one, clineModelsRevision({ knownModels: ["a", "b", "d"], perModel: { c: {} } }));
  assert.equal(clineModelsRevision(null), null);
});

test("a model the switcher learns rewrites the bridge marker so CPA reloads it, and only then", async () => {
  const root = stateRoot({ models: ["cline-pass/deepseek-v4-flash"] });
  assert.equal(await syncClineMarker(root), true, "the first sync stamps the marker");
  const first = markerOf(root);
  assert.deepEqual({ ...first, modelsRevision: undefined }, { type: "cline", switcher: true, label: "Cline Pass", modelsRevision: undefined });
  assert.equal(await syncClineMarker(root), false, "an unchanged list leaves the marker alone");
  fs.writeFileSync(configOf(root), JSON.stringify({ knownModels: ["cline-pass/deepseek-v4-flash", "cline-pass/deepseek-v4.1-flash"], perModel: {} }));
  assert.equal(await syncClineMarker(root), true);
  assert.notEqual(markerOf(root).modelsRevision, first.modelsRevision);
  assert.equal(JSON.stringify(markerOf(root)).includes("secret"), false, "no switcher credential reaches the marker");
});

test("a missing or foreign marker and a missing config are left alone", async () => {
  const none = stateRoot({ models: ["x"], marker: null });
  assert.equal(await syncClineMarker(none), false);
  assert.equal(fs.existsSync(path.join(none, "auth", "cline-pass-switcher.json")), false, "no marker is created");
  const foreign = stateRoot({ models: ["x"], marker: { type: "codex", email: "a@b" } });
  assert.equal(await syncClineMarker(foreign), false);
  assert.deepEqual(markerOf(foreign), { type: "codex", email: "a@b" });
  const disabled = stateRoot({ models: ["x"], marker: { type: "cline", switcher: true, disabled: true } });
  assert.equal(await syncClineMarker(disabled), true);
  assert.equal(markerOf(disabled).disabled, true, "the marker's own fields are kept");
  fs.rmSync(configOf(disabled));
  assert.equal(await syncClineMarker(disabled), false);
});

test("the watcher checks at start and logs a change without throwing on bad state", async () => {
  const root = stateRoot({ models: ["x"] });
  const events = [];
  const watcher = watchCpaPluginModels({ stateRoot: root, intervalMs: 60_000, logger: { info: (event) => events.push(event), warn: (event) => events.push(event) } });
  await watcher.ready;
  watcher.stop();
  assert.deepEqual(events, ["cpa.plugin_models_changed"]);
  const broken = watchCpaPluginModels({ stateRoot: path.join(root, "missing"), intervalMs: 60_000, logger: { info: () => {}, warn: () => {} } });
  await broken.ready;
  broken.stop();
});

test("with the catalog exposed, an upstream catalog refresh changes the revision; without it the catalog is ignored", async () => {
  const exposed = { knownModels: ["a"], perModel: { tuned: {} }, exposeCatalog: true };
  const before = clineModelsRevision(exposed, { catalog: ["a", "b"] });
  assert.notEqual(before, clineModelsRevision(exposed, { catalog: ["a", "b", "c"] }), "a new catalog model is noticed");
  assert.equal(before, clineModelsRevision(exposed, { catalog: ["b", "a"], history: [1, 2] }), "order and history do not matter");
  const hidden = { ...exposed, exposeCatalog: false };
  assert.equal(clineModelsRevision(hidden, { catalog: ["x"] }), clineModelsRevision(hidden, { catalog: ["y"] }));
  const root = stateRoot({ models: ["a"] });
  fs.writeFileSync(configOf(root), JSON.stringify(exposed));
  fs.writeFileSync(path.join(root, "cline-pass-switcher-data", "metadata.json"), JSON.stringify({ catalog: ["a", "b"] }));
  assert.equal(await syncClineMarker(root), true);
  assert.equal(await syncClineMarker(root), false);
  fs.writeFileSync(path.join(root, "cline-pass-switcher-data", "metadata.json"), JSON.stringify({ catalog: ["a", "b", "c"] }));
  assert.equal(await syncClineMarker(root), true, "the marker follows the catalog");
});

test("the watcher asks the switcher to fetch Cline's official model list on a schedule, through CPA's management route", async (t) => {
  const { refreshClineModels } = require("../electron/cpa-plugin-models.cjs");
  const calls = [];
  const added = await refreshClineModels({ baseUrl: "http://127.0.0.1:8317", managementKey: "manage",
    fetchImpl: async (url, init) => { calls.push([url, init.method, init.headers.Authorization]); return { ok: true, json: async () => ({ added: ["cline-pass/deepseek-v4.1-flash-1017"] }) }; } });
  assert.deepEqual(calls, [["http://127.0.0.1:8317/v0/management/cline-pass-switcher/api/fetch-official-models", "POST", "Bearer manage"]]);
  assert.deepEqual(added, ["cline-pass/deepseek-v4.1-flash-1017"]);
  await assert.rejects(refreshClineModels({ baseUrl: "http://127.0.0.1:8317", managementKey: "manage", fetchImpl: async () => ({ ok: false, status: 404 }) }), /HTTP 404/);
});
