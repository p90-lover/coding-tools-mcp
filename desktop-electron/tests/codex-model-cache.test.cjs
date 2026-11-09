"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { readCodexModelCache, codexSkipsBridge, watchCodexModelCache } = require("../electron/codex-model-cache.cjs");

const scratch = (t) => {
  const parent = path.resolve(__dirname, "../../aiTemp");
  fs.mkdirSync(parent, { recursive: true });
  const root = fs.mkdtempSync(path.join(parent, "codex-model-cache-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
};
const writeCache = (root, fetchedAt, slugs, clientVersion = "0.163.0") => fs.writeFileSync(path.join(root, "models_cache.json"),
  JSON.stringify({ fetched_at: fetchedAt, etag: "PRIVATE_ETAG", client_version: clientVersion, identity: "PRIVATE_IDENTITY",
    models: slugs.map(slug => ({ slug, display_name: slug })) }));

test("Codex's model cache gives only when, by which version, and whether WebGPT rows are listed", async t => {
  const root = scratch(t);
  assert.equal(await readCodexModelCache(root), null, "no cache yet");
  writeCache(root, "2026-11-09T01:37:19.934966Z", ["gpt-6.1-sol", "gpt-6-luna", "codex-auto-review"]);
  const cache = await readCodexModelCache(root);
  assert.deepEqual({ ...cache, modifiedAt: typeof cache.modifiedAt }, {
    fetchedAt: Date.parse("2026-11-09T01:37:19.934Z"), modifiedAt: "number", clientVersion: "0.163.0", webModels: false });
  assert.doesNotMatch(JSON.stringify(cache), /PRIVATE/);
  writeCache(root, "2026-11-09T01:40:00Z", ["gpt-6.1-sol", "chatgpt-web/gpt-6-sol"]);
  assert.equal((await readCodexModelCache(root)).webModels, true);
  fs.writeFileSync(path.join(root, "models_cache.json"), "{ torn");
  assert.equal(await readCodexModelCache(root), null);
  assert.equal(await readCodexModelCache(""), null);
});

test("only a list fetched after the bridge last answered, and without WebGPT rows, went around the bridge", () => {
  const served = Date.parse("2026-11-09T01:34:04.516Z");
  const cache = (at, webModels) => ({ fetchedAt: Date.parse(at), webModels });
  // The live case: the Codex app's 01:37 refresh, three minutes after the app's own Codex asked the bridge.
  assert.equal(codexSkipsBridge(cache("2026-11-09T01:37:19Z", false), served), true);
  assert.equal(codexSkipsBridge(cache("2026-11-09T01:37:19Z", true), served), false);
  assert.equal(codexSkipsBridge(cache("2026-11-09T01:30:00Z", false), served), false, "a list from before may predate the route");
  assert.equal(codexSkipsBridge(cache("2026-11-09T01:37:19Z", false), NaN), false, "no bridge answer, no comparison");
  assert.equal(codexSkipsBridge(null, served), false);
});

test("the watch shows Restart Codex while a Codex goes around the bridge, and clears it once that Codex lists WebGPT", async () => {
  let cache = null, routed = true, restart = false, served = Date.parse("2026-11-09T01:34:04Z"), reads = 0;
  const logs = [];
  const watch = watchCodexModelCache({
    codexHome: "home", routed: () => routed, bridgeServedAt: async () => served,
    restartRequired: () => restart, setRestartRequired: value => { restart = value; },
    logger: { warn: (event, detail) => logs.push([event, detail]), info: (event, detail) => logs.push([event, detail]) },
    read: async () => { reads++; return cache; }, setInterval: () => ({}), clearInterval: () => {},
  });
  const at = (iso, webModels, clientVersion = "0.163.0", modifiedAt = Date.parse(iso)) => ({ fetchedAt: Date.parse(iso), modifiedAt, webModels, clientVersion });
  cache = at("2026-11-09T01:37:19Z", false);
  await watch.check();
  assert.equal(restart, true);
  assert.deepEqual(logs[0], ["codex.model_cache_skips_bridge", { clientVersion: "0.163.0", fetchedAt: "2026-11-09T01:37:19.000Z" }]);
  await watch.check();
  assert.equal(reads, 2, "the file is statted each time");
  assert.equal(logs.length, 1, "an unchanged file is not judged again");
  // The app's own Codex (another version) lists WebGPT through the bridge: the Codex app still does not.
  served = Date.parse("2026-11-09T01:38:00Z");
  cache = at("2026-11-09T01:38:01Z", true, "0.164.0");
  await watch.check();
  assert.equal(restart, true, "another Codex's list does not prove the Codex app restarted");
  cache = at("2026-11-09T01:45:00Z", true, "0.163.0");
  await watch.check();
  assert.equal(restart, false, "that Codex version now lists WebGPT: it restarted");
  routed = false;
  cache = at("2026-11-09T01:50:00Z", false);
  await watch.check();
  assert.equal(restart, false, "without the route there is nothing to restart for");
});
