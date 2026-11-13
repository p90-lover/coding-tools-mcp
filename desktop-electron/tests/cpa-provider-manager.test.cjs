"use strict";
require("./support/temp-dirs.cjs"); // removes the temp folders this file makes when it ends
const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const {
  ACCOUNT_KINDS, RETIRED_PLUGINS, installBundledCommandCodePlugin, mergePluginConfigs, migrateAuthFiles,
  providerManagerDataDir, runtimeConfiguration, stampAccountKind,
} = require("../electron/cpa-managed.cjs");
const { ACCOUNT_KINDS_PATH, withAccountKinds } = require("../electron/cpa-account-kinds.cjs");

// CPA loads one plugin, Provider Manager. The other plugins are its parts, and the accounts of the
// former provider plugins are provider-manager auth files with a kind.

const tempState = (name) => fs.mkdtempSync(path.join(os.tmpdir(), `${name}-`));
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const readDir = (directory) => Object.fromEntries(fs.readdirSync(directory).sort().map((name) => [name, fs.readFileSync(path.join(directory, name), "utf8")]));

test("migrateAuthFiles stamps the four account kinds, keeps the originals in Trash, and is idempotent", () => {
  assert.deepEqual([...ACCOUNT_KINDS].sort(), ["cline", "commandcode", "commandcode-go", "grok"]);
  const state = tempState("cpa-pm-migrate");
  const auth = path.join(state, "auth");
  fs.mkdirSync(auth);
  const migrated = {
    "cline-pass-switcher.json": { type: "cline", switcher: true, label: "Cline Pass" },
    "commandcode-go-user.json": { type: "commandcode-go", email: "go@example.test", api_key: "fixture-go" },
    "commandcode-user.json": { type: "commandcode", email: "cc@example.test", access_token: "fixture-cc" },
    "grok-user.json": { type: "grok", grok_upstream: "web", auth_kind: "sso" },
    "GROK-UPPER.JSON": { type: "grok", label: "upper-case extension" },
  };
  const untouched = {
    "codex-user.json": JSON.stringify({ type: "codex", email: "codex@example.test" }),
    "provider-manager.json": JSON.stringify({ type: "provider-manager", label: "Provider Manager" }),
    "stamped.json": JSON.stringify({ type: "provider-manager", kind: "grok", kindType: "grok", email: "x@example.test" }),
    "broken.json": "{ not json",
    "list.json": JSON.stringify([{ type: "grok" }]),
    "notes.txt": JSON.stringify({ type: "grok" }),
  };
  for (const [name, body] of Object.entries(migrated)) fs.writeFileSync(path.join(auth, name), JSON.stringify(body));
  for (const [name, body] of Object.entries(untouched)) fs.writeFileSync(path.join(auth, name), body);

  assert.equal(migrateAuthFiles(state), Object.keys(migrated).length);
  for (const [name, original] of Object.entries(migrated)) {
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(auth, name), "utf8")),
      { ...original, type: "provider-manager", kind: original.type, kindType: original.type }, name);
  }
  for (const [name, body] of Object.entries(untouched)) {
    assert.equal(fs.readFileSync(path.join(auth, name), "utf8"), body, `${name} is left alone`);
  }
  // Each original goes to Trash, unchanged, before its file is rewritten.
  const trash = path.join(state, "Trash", "auth");
  const [archive, ...more] = fs.readdirSync(trash);
  assert.deepEqual(more, []);
  assert.match(archive, /^\d+-provider-manager-kinds$/);
  assert.deepEqual(readDir(path.join(trash, archive)),
    Object.fromEntries(Object.entries(migrated).map(([name, body]) => [name, JSON.stringify(body)]).sort(([a], [b]) => (a < b ? -1 : 1))));

  // A second run finds nothing to do: no file changes and no new Trash folder.
  const after = readDir(auth);
  assert.equal(migrateAuthFiles(state), 0);
  assert.deepEqual(readDir(auth), after);
  assert.deepEqual(fs.readdirSync(trash), [archive]);

  // No auth folder yet: nothing to migrate, and no Trash is made.
  const empty = tempState("cpa-pm-migrate-empty");
  assert.equal(migrateAuthFiles(empty), 0);
  assert.equal(fs.existsSync(path.join(empty, "Trash")), false);
});

test("stampAccountKind changes only a former provider plugin's account", () => {
  assert.deepEqual(stampAccountKind({ type: "grok", email: "g@example.test" }),
    { type: "provider-manager", kind: "grok", kindType: "grok", email: "g@example.test" });
  for (const value of [{ type: "codex" }, { type: "provider-manager", kind: "grok", kindType: "grok" }, [{ type: "grok" }], null, "grok"]) {
    assert.equal(stampAccountKind(value), value);
  }
});

test("CPA's config step migrates the auth files before CPA reads them", () => {
  const state = tempState("cpa-pm-config-migrate");
  fs.mkdirSync(path.join(state, "auth"));
  fs.writeFileSync(path.join(state, "auth", "grok-user.json"), JSON.stringify({ type: "grok", label: "Grok" }));
  runtimeConfiguration(state, "m".repeat(36), "p".repeat(36));
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(state, "auth", "grok-user.json"), "utf8")),
    { type: "provider-manager", kind: "grok", kindType: "grok", label: "Grok" });
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(state, "auth", "cline-pass-switcher.json"), "utf8")),
    { type: "provider-manager", kind: "cline", kindType: "cline", switcher: true, label: "Cline Pass" },
    "the Cline bridge marker is written already stamped");
  assert.equal(providerManagerDataDir(state), path.join(state, "cpa-provider-manager-data"));
});

test("mergePluginConfigs drops retired blocks, keeps saved Provider Manager keys, and seeds unmanaged parts", () => {
  const managedBlock = {
    enabled: true, "data-dir": "/state/cpa-provider-manager-data",
    "legacy-data-dirs": { helper: "/state/cpa-helper-data", autoreview: "/state/codex-review-account-selector-data", cline: "/state/cline-pass-switcher-data" },
    helper: { keeper_enabled: false },
    cline: { "runtime-executable": "/runtime/bun" },
  };
  const saved = {
    "cpa-provider-manager": {
      enabled: false, "data-dir": "/old/provider-manager", "sync-minutes": 15,
      cline: { "runtime-executable": "/old/bun", "proxy-url": "http://stale.invalid:1/" },
      helper: { keeper_enabled: true, port: 1 },
    },
    "cline-pass-switcher": { enabled: true, "data-dir": "/old/cline", "proxy-url": "http://older.invalid/" },
    "cpa-helper": { enabled: true, data_dir: "/old/helper", keeper_enabled: true },
    "grok-login-provider": { enabled: true, "data-dir": "/old/grok", data_dir: "/old/grok2", "base-url": "https://grok.example.test", "request-timeout": 30 },
    "commandcode-go": { enabled: true },
    "auth-commandcode": { enabled: true, data_dir: "/old/commandcode" },
    "codex-review-account-selector": { enabled: true, "data-dir": "/old/review" },
    "codex-auto-review": { enabled: true, model: "codex-auto-review" },
    "user-own-plugin": { enabled: true, strategy: "saved-user-setting" },
  };
  const merged = mergePluginConfigs(saved, { "cpa-provider-manager": managedBlock });
  for (const id of RETIRED_PLUGINS) assert.equal(id in merged, false, `${id} is dropped`);
  assert.deepEqual(Object.keys(merged).sort(), ["cpa-provider-manager", "user-own-plugin"]);
  assert.deepEqual(merged["user-own-plugin"], saved["user-own-plugin"]);
  assert.deepEqual(merged["cpa-provider-manager"], {
    ...managedBlock,
    // A saved Provider Manager setting nothing manages stays.
    "sync-minutes": 15,
    // The managed sections replace the saved ones whole: no stale outbound proxy, no keeper.
    helper: { keeper_enabled: false },
    cline: { "runtime-executable": "/runtime/bun" },
    // Grok is unmanaged: it starts from its former plugin's block, without what is Provider Manager's now.
    grok: { "base-url": "https://grok.example.test", "request-timeout": 30 },
  });
  assert.equal("autoreview" in merged["cpa-provider-manager"], false, "a former block with nothing of its own seeds nothing");
  assert.equal("commandcode-go" in merged["cpa-provider-manager"], false);
  assert.equal("commandcode" in merged["cpa-provider-manager"], false);

  // A part's saved Provider Manager section wins over its former plugin's block.
  const again = mergePluginConfigs({ ...saved, "cpa-provider-manager": { grok: { "base-url": "https://chosen.example.test" } } },
    { "cpa-provider-manager": managedBlock });
  assert.deepEqual(again["cpa-provider-manager"].grok, { "base-url": "https://chosen.example.test" });

  // A managed outbound proxy for the Cline part reaches it; nothing saved is needed.
  const proxied = { ...managedBlock, cline: { ...managedBlock.cline, "proxy-url": "http://proxy.example.test:10000/" } };
  assert.deepEqual(mergePluginConfigs(undefined, { "cpa-provider-manager": proxied }), { "cpa-provider-manager": proxied });
  assert.deepEqual(mergePluginConfigs([], { "cpa-provider-manager": managedBlock }), { "cpa-provider-manager": managedBlock });
});

test("a saved stale Cline proxy never outlives the managed route in CPA's written config", () => {
  const yaml = globalThis.Bun?.YAML ?? require("js-yaml");
  const state = tempState("cpa-pm-config-merge");
  fs.writeFileSync(path.join(state, "config.yaml"), JSON.stringify({
    plugins: { configs: {
      "cpa-provider-manager": { enabled: true, "sync-minutes": 20, cline: { "proxy-url": "http://stale.invalid:1/" } },
      "cline-pass-switcher": { enabled: true, "proxy-url": "http://older.invalid/" },
      "grok-login-provider": { enabled: true, "base-url": "https://grok.example.test" },
    } },
  }));
  const parse = (text) => (yaml.parse ?? yaml.load)(text);
  const direct = parse(runtimeConfiguration(state, "m".repeat(36), "p".repeat(36))).plugins.configs;
  assert.deepEqual(Object.keys(direct), ["cpa-provider-manager"]);
  assert.equal(direct["cpa-provider-manager"]["sync-minutes"], 20);
  assert.deepEqual(direct["cpa-provider-manager"].cline, { "runtime-executable": process.execPath });
  assert.deepEqual(direct["cpa-provider-manager"].grok, { "base-url": "https://grok.example.test" });
  const routed = parse(runtimeConfiguration(state, "m".repeat(36), "p".repeat(36), "http://proxy.example.test:10000/")).plugins.configs;
  assert.deepEqual(routed["cpa-provider-manager"].cline, { "runtime-executable": process.execPath, "proxy-url": "http://proxy.example.test:10000/" });
});

test("installing Provider Manager moves every retired plugin's DLL to one Trash folder",
  { skip: process.platform !== "win32" || process.arch !== "x64" }, () => {
    assert.equal(RETIRED_PLUGINS.includes("cpa-provider-manager"), false);
    const bundle = JSON.parse(fs.readFileSync(path.join(__dirname, "../vendor/bundled/cpa-plugins/BUNDLE.json"), "utf8"));
    const asset = bundle.platforms["win32/x64"];
    const state = tempState("cpa-pm-retired");
    const directory = path.join(state, "plugins", "windows", "amd64");
    fs.mkdirSync(directory, { recursive: true });
    const retired = Object.fromEntries(RETIRED_PLUGINS.map((id, index) => [
      // Both the versioned form and a bare <id>.dll.
      index % 2 ? `${id}.dll` : `${id}-v1.0.${index}.dll`, `retired ${id}`,
    ]));
    for (const [name, body] of Object.entries(retired)) fs.writeFileSync(path.join(directory, name), body);
    // An update of a retired plugin from GitHub doesn't keep it loading.
    fs.writeFileSync(path.join(state, "plugin-updates.json"), JSON.stringify({ schemaVersion: 1, plugins: {
      "cpa-helper": { version: "9.0.0", file: "cpa-helper-v1.0.3.dll", sha256: sha256("retired cpa-helper") },
    } }));
    const kept = ["user-plugin-v1.0.0.dll", "cpa-helper-v0.2.0.dll.bak", "cpa-helper-notes.txt"];
    for (const name of kept) fs.writeFileSync(path.join(directory, name), name);
    // Only regular files move.
    fs.mkdirSync(path.join(directory, "cline-pass-switcher-v9.dll"));

    const installed = installBundledCommandCodePlugin(state);
    const target = path.join(directory, path.basename(asset.path));
    assert.deepEqual(installed, [target]);
    assert.equal(sha256(fs.readFileSync(target)), asset.sha256);
    assert.deepEqual(fs.readdirSync(directory).sort(), [...kept, "cline-pass-switcher-v9.dll", path.basename(asset.path)].sort());
    const trash = path.join(state, "Trash", "plugins");
    const [archive, ...more] = fs.readdirSync(trash);
    assert.deepEqual(more, []);
    assert.match(archive, /^\d+-retired$/);
    assert.deepEqual(readDir(path.join(trash, archive)), Object.fromEntries(Object.entries(retired).sort(([a], [b]) => (a < b ? -1 : 1))));

    // A second start has nothing to move.
    assert.deepEqual(installBundledCommandCodePlugin(state), installed);
    assert.deepEqual(fs.readdirSync(trash), [archive]);
  });

test("withAccountKinds lists each Provider Manager account under its kind", async () => {
  assert.equal(ACCOUNT_KINDS_PATH, "/v0/management/cpa-provider-manager/api/kinds");
  const listing = {
    total: 5,
    files: [
      { name: "grok-user.json", provider: "provider-manager", type: "provider-manager", email: "g@example.test" },
      { name: "cline-pass-switcher.json", type: "provider-manager", switcher: true },
      { name: "codex-user.json", provider: "codex", type: "codex" },
      { name: "unnamed-kind.json", provider: "provider-manager", type: "provider-manager" },
      { name: "odd-kind.json", provider: "provider-manager", type: "provider-manager" },
    ],
  };
  const original = structuredClone(listing);
  let asked = 0;
  const kinds = { files: { "grok-user.json": "grok", "cline-pass-switcher.json": "cline", "codex-user.json": "grok", "odd-kind.json": 5 } };
  const result = await withAccountKinds(listing, async () => { asked += 1; return kinds; });
  assert.equal(asked, 1);
  assert.deepEqual(listing, original, "the listing it was given is not changed");
  assert.equal(result.total, 5);
  assert.deepEqual(result.files, [
    { ...original.files[0], provider: "grok", type: "grok", kind: "grok" },
    { ...original.files[1], provider: "cline", type: "cline", kind: "cline" },
    // Not a Provider Manager file: its listed provider stands, whatever the kinds say.
    original.files[2],
    // Provider Manager names no kind (or no usable one): left as listed.
    original.files[3],
    original.files[4],
  ]);
});

test("withAccountKinds asks nothing without Provider Manager files and keeps the listing when the kinds can't be read", async () => {
  const codexOnly = { files: [{ name: "codex-user.json", provider: "codex" }] };
  assert.equal(await withAccountKinds(codexOnly, () => assert.fail("no provider-manager file, no kinds request")), codexOnly);
  for (const value of [null, undefined, { files: "none" }, {}]) {
    assert.equal(await withAccountKinds(value, () => assert.fail("not a listing")), value);
  }
  const listing = { files: [{ name: "grok-user.json", provider: "provider-manager", type: "provider-manager" }] };
  const original = structuredClone(listing);
  assert.deepEqual(await withAccountKinds(listing, async () => { throw new Error("kinds route is down"); }), original);
  assert.deepEqual(await withAccountKinds(listing, () => { throw new Error("synchronous failure"); }), original);
  for (const body of [null, { files: null }, { error: "unauthorized" }, "grok"]) {
    assert.deepEqual(await withAccountKinds(listing, async () => body), original, JSON.stringify(body));
  }
});
