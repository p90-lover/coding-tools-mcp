"use strict";

// The window's localStorage settings survive a reset store (Bitdefender quarantined two files of
// Local Storage\leveldb on 2026-11-27 and every setting was lost): main keeps a userData copy
// (electron/ui-settings-mirror.cjs) and the page refills an emptied store from it before any screen
// reads it (src/ui-settings-mirror.ts). The split view's own round trip is in ao-chat.test.cjs.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { buildSync } = require("esbuild");
const { writePrivateFileAtomicAsync } = require("../electron/atomic-file.cjs");
const { connectMain, fakeClock, fakeWindow, loadPageMirror, main, mirrorDir, storageType } = require("./support/ui-settings-mirror-harness.cjs");

const plain = (value) => JSON.parse(JSON.stringify(value));
const SPLIT = "coding-tools:ao:split-view";
const SPLIT_VALUE = JSON.stringify({ panes: [{ workspaceId: "w", taskId: "t2", col: 1, row: 0 }], weights: [0.6, 0.4], rowSplit: 0.5 });

function countingStore(dir, options = {}) {
  const filePath = path.join(dir, main.MIRROR_FILE);
  const writes = [];
  const mirror = main.createUiSettingsMirror({
    filePath,
    writeFile: (file, text, writeOptions) => {
      writes.push(text);
      return writePrivateFileAtomicAsync(file, text, writeOptions);
    },
    ...options,
  });
  return { filePath, writes, mirror, read: () => JSON.parse(fs.readFileSync(filePath, "utf8")) };
}

test("main keeps only the app's keys, written atomically, and never rewrites the same entries", async (t) => {
  const dir = mirrorDir(t);
  const { filePath, writes, mirror, read } = countingStore(dir);
  assert.equal(mirror.save({
    [SPLIT]: SPLIT_VALUE,
    "coding-tools:ao:sections": "[\"one\"]",
    "coding-tools:provider-api-key": "sk-live",
    "coding-tools:ao:token": "abc",
    "coding-tools:browser-cookie": "c",
    "someone-else:theme": "dark",
    "coding-tools:ao:count": 5,
  }), true);
  await mirror.saved();
  const saved = read();
  assert.equal(saved.version, 1);
  assert.match(saved.savedAt, /^\d{4}-\d\d-\d\dT/);
  assert.deepEqual(saved.entries, { "coding-tools:ao:sections": "[\"one\"]", [SPLIT]: SPLIT_VALUE },
    "secret-named, foreign and non-string entries never reach the file");
  assert.equal(writes.length, 1);
  assert.deepEqual(fs.readdirSync(dir), [main.MIRROR_FILE], "the temp file was renamed into place");

  mirror.save({ [SPLIT]: SPLIT_VALUE, "coding-tools:ao:sections": "[\"one\"]" });
  await mirror.saved();
  assert.equal(writes.length, 1, "the same entries are not written again");
  const restarted = countingStore(dir);
  restarted.mirror.save({ "coding-tools:ao:sections": "[\"one\"]", [SPLIT]: SPLIT_VALUE });
  await restarted.mirror.saved();
  assert.equal(restarted.writes.length, 0, "a new run compares with the file before writing");

  mirror.save({ [SPLIT]: SPLIT_VALUE });
  mirror.save({ [SPLIT]: SPLIT_VALUE, "coding-tools:ao:pet": "1" });
  mirror.save({ [SPLIT]: SPLIT_VALUE, "coding-tools:ao:pet": "2" });
  await mirror.saved();
  assert.deepEqual(read().entries, { "coding-tools:ao:pet": "2", [SPLIT]: SPLIT_VALUE }, "the newest copy lands last");
  assert.ok(writes.length <= 3, "saves made during a write are coalesced");
  assert.deepEqual(fs.readdirSync(dir), [main.MIRROR_FILE]);

  assert.equal(mirror.save({ big: "x" }), true, "a copy with no app keys is an empty copy");
  assert.equal(mirror.save("not entries"), false);
  assert.equal(mirror.save({ [SPLIT]: "x".repeat(200 * 1024), ...Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`coding-tools:big:${i}`, "y".repeat(200 * 1024)])) }), false,
    "more than 2 MiB is refused whole; the page leaves the biggest values out before sending");
  await mirror.saved();
  assert.deepEqual(read().entries, {}, "the empty copy was kept; the oversized one was not");
  assert.ok(fs.statSync(filePath).size < 1024);
});

test("main's load: a missing, damaged, busy or edited copy", async (t) => {
  const dir = mirrorDir(t);
  const { filePath, mirror, writes } = countingStore(dir);
  assert.deepEqual(plain(mirror.load()), { ok: true, entries: null }, "no file yet");

  fs.writeFileSync(filePath, "{\"version\":1,\"entries\":{\"coding-tools:ao:x\":");
  assert.deepEqual(plain(mirror.load()), { ok: true, entries: null, damaged: true }, "a damaged file is no copy at all");
  mirror.save({ [SPLIT]: SPLIT_VALUE });
  await mirror.saved();
  assert.equal(writes.length, 1, "and the next change replaces it");

  fs.writeFileSync(filePath, `\uFEFF${JSON.stringify({ version: 1, entries: { [SPLIT]: SPLIT_VALUE, "coding-tools:secret-thing": "s", "coding-tools:ao:n": 3 } })}`);
  assert.deepEqual(plain(mirror.load()), { ok: true, entries: { [SPLIT]: SPLIT_VALUE } }, "the key rule applies to what is read back too");
  fs.writeFileSync(filePath, JSON.stringify({ version: 2, entries: { [SPLIT]: SPLIT_VALUE } }));
  assert.equal(mirror.load().damaged, true, "another format is not read as this one");

  const busy = main.createUiSettingsMirror({ filePath, readFileSync: () => { throw Object.assign(new Error("busy"), { code: "EBUSY" }); } });
  assert.deepEqual(plain(busy.load()), { ok: false, reason: "unreadable" }, "a held file is reported, so the page keeps it");
  assert.throws(() => main.createUiSettingsMirror({}), /needs a file path/);
});

test("the sync load always answers, and only the app's own top frame is served", async (t) => {
  const dir = mirrorDir(t);
  const { mirror, writes } = countingStore(dir);
  let trusted = false;
  const { handlers, channels } = connectMain(mirror, { appFrame: () => trusted });
  assert.deepEqual(channels, [main.LOAD_CHANNEL, main.SAVE_CHANNEL]);
  const ask = () => { const event = {}; handlers.get(main.LOAD_CHANNEL)(event); return plain(event.returnValue); };

  assert.deepEqual(ask(), { ok: false, reason: "refused" }, "another page or frame gets no settings");
  handlers.get(main.SAVE_CHANNEL)({}, { [SPLIT]: SPLIT_VALUE });
  await mirror.saved();
  assert.equal(writes.length, 0, "and cannot write them");

  trusted = true;
  assert.deepEqual(ask(), { ok: true, entries: null });
  const broken = connectMain({ load() { throw new Error("disk gone"); }, save() { throw new Error("disk gone"); } }).handlers;
  const event = {};
  broken.get(main.LOAD_CHANNEL)(event);
  assert.deepEqual(plain(event.returnValue), { ok: false, reason: "failed" }, "a throwing load still answers: a sendSync left unanswered freezes the window");
  assert.doesNotThrow(() => broken.get(main.SAVE_CHANNEL)({}, {}));
});

test("an emptied store is refilled from the copy before anything reads it, and changes are mirrored after a quiet moment", () => {
  const page = loadPageMirror();
  const Storage = storageType();
  const clock = fakeClock();
  const win = fakeWindow();
  const sent = [];
  const storage = new Storage();
  const session = new Storage({ "coding-tools:ao:selection": "x" });
  const bridge = {
    loadUiSettingsMirror: () => ({ ok: true, entries: { [SPLIT]: SPLIT_VALUE, "coding-tools:ao:chat-sections": "[]", "coding-tools:sneaky-token": "t", "other:key": "o" } }),
    saveUiSettingsMirror: (entries) => sent.push(plain(entries)),
  };
  const result = page.installUiSettingsMirror({ storage, bridge, target: win, ...clock });
  assert.equal(result.restored, 2);
  assert.equal(result.mirroring, true);
  assert.deepEqual(storage.toJSON(), { "coding-tools:ao:chat-sections": "[]", [SPLIT]: SPLIT_VALUE },
    "the copy is back in the store when install returns, before main.tsx's other imports run");
  assert.match(page.logs[0], /restored 2 window settings/);
  assert.equal(clock.pending(), 0, "putting the copy back is not a change to send");

  storage.setItem("coding-tools:ao:pet", "1");
  clock.advance(1000);
  storage.setItem("coding-tools:ao:pet", "2");
  storage.setItem("coding-tools:ao:pet-x", "40");
  clock.advance(1000);
  assert.equal(sent.length, 0, "nothing goes while changes keep coming within 1.5 s");
  clock.advance(500);
  assert.deepEqual(sent, [{ "coding-tools:ao:chat-sections": "[]", "coding-tools:ao:pet": "2", "coding-tools:ao:pet-x": "40", [SPLIT]: SPLIT_VALUE }],
    "one copy of all the app keys, sorted");

  storage.setItem("someone-else:theme", "dark");
  session.setItem("coding-tools:ao:selection", "y");
  storage.getItem(SPLIT);
  assert.equal(clock.pending(), 0, "foreign keys, another Storage (sessionStorage) and reads send nothing");

  storage.setItem("coding-tools:ao:pet", "2");
  clock.advance(1500);
  assert.equal(sent.length, 1, "the same keys are not sent again");

  storage.removeItem("coding-tools:ao:pet-x");
  clock.advance(1500);
  assert.equal(sent.length, 2);
  assert.equal(sent[1]["coding-tools:ao:pet-x"], undefined, "a removal is mirrored");

  for (let second = 0; second < 12; second += 1) {
    storage.setItem("coding-tools:ao:workbench-width", String(300 + second));
    clock.advance(1000);
  }
  assert.equal(sent.length, 3, "a long drag still sends at most every 10 s");
  assert.equal(sent[2]["coding-tools:ao:workbench-width"], "309");
  clock.advance(1500);
  assert.equal(sent.length, 4);

  storage.setItem("coding-tools:ao:last-chat-route", "chat");
  win.fire("pagehide");
  assert.equal(sent.length, 5, "a change pending when the window closes goes at once");
  assert.equal(clock.pending(), 0);
  win.fire("beforeunload");
  assert.equal(sent.length, 5, "and only once");

  storage.clear();
  clock.advance(1500);
  assert.deepEqual(sent[5], {}, "clearing the store clears the copy");
});

test("an intact store never asks main, and a copy that could not be read is never overwritten", () => {
  const page = loadPageMirror();
  const clock = fakeClock();
  const run = (initial, bridge) => {
    const Storage = storageType();
    const storage = new Storage(initial);
    const result = page.installUiSettingsMirror({ storage, bridge, target: fakeWindow(), ...clock });
    storage.setItem("coding-tools:ao:pet", "1");
    clock.advance(2000);
    return { result, storage };
  };
  let loads = 0;
  const sent = [];
  const bridge = (load) => ({ loadUiSettingsMirror: () => { loads += 1; return load; }, saveUiSettingsMirror: (entries) => sent.push(plain(entries)) });

  const intact = run({ [SPLIT]: SPLIT_VALUE, "other:key": "o" }, bridge({ ok: true, entries: { "coding-tools:ao:x": "1" } }));
  assert.equal(loads, 0, "no IPC and no file read while the store has the app's keys");
  assert.equal(intact.result.restored, 0);
  assert.equal(intact.storage.getItem("coding-tools:ao:x"), null);
  assert.equal(sent.length, 1, "and its changes are mirrored");

  const unreadable = run({}, bridge({ ok: false, reason: "unreadable" }));
  assert.equal(unreadable.result.mirroring, false);
  assert.equal(sent.length, 1, "an empty store whose copy could not be read never replaces that copy");
  const oldMain = run({}, { saveUiSettingsMirror: (entries) => sent.push(entries) });
  assert.equal(oldMain.result.mirroring, false, "a main without the load (an older app with a newer page) changes nothing");
  assert.equal(sent.length, 1);
  assert.equal(run({}, undefined).result.mirroring, false, "no bridge at all (a plain browser)");

  const firstRun = run({}, bridge({ ok: true, entries: null }));
  assert.equal(firstRun.result.mirroring, true, "no copy yet: start one");
  assert.deepEqual(sent[1], { "coding-tools:ao:pet": "1" });
  const noSave = run({ [SPLIT]: SPLIT_VALUE }, { loadUiSettingsMirror: () => ({ ok: true, entries: null }) });
  assert.equal(noSave.result.mirroring, false);
});

test("over the 2 MiB cap the biggest values stay out, so the small settings still fit", () => {
  const page = loadPageMirror();
  const Storage = storageType();
  const big = "x".repeat(200 * 1024);
  const storage = new Storage({
    [SPLIT]: SPLIT_VALUE,
    "coding-tools:huge": "y".repeat(300 * 1024),
    ...Object.fromEntries(Array.from({ length: 11 }, (_, index) => [`coding-tools:big:${String(index).padStart(2, "0")}`, big])),
  });
  const entries = plain(page.appEntries(storage));
  assert.equal(entries["coding-tools:huge"], undefined, "a value over 256 KiB is never copied");
  assert.equal(entries[SPLIT], SPLIT_VALUE);
  const total = Object.entries(entries).reduce((sum, [key, value]) => sum + key.length + value.length, 0);
  assert.ok(total <= main.MAX_TOTAL_LENGTH, `${total} fits`);
  assert.equal(Object.keys(entries).filter((key) => key.startsWith("coding-tools:big:")).length, 10, "only as many big ones as fit");
  assert.deepEqual(Object.keys(entries), Object.keys(entries).sort());
  assert.equal(main.cleanEntries(entries) !== null, true, "and main accepts what the page sends");
});

test("the page and main agree on the key rule, and every key the renderer writes is mirrored", () => {
  const page = loadPageMirror();
  const keys = [
    SPLIT, "coding-tools:ao:split-view:page-2", "coding-tools-provider-instances-v1", "coding-tools-orchestrators-v1",
    "native-codex:w1", "email.read.https://mail.example", "cdx-image-toolbar-position",
    "coding-tools:api_key", "coding-tools:ApiKey", "coding-tools:x:password", "coding-tools:access-token", "native-codex:credentials",
    "coding-tools:session-cookie", "coding-tools:bearer", "coding-tools:private-key", "coding-tools:client-secret",
    "cdx-image-toolbar-position-2", "theme", "", "coding-tools:" + "k".repeat(600), "Coding-Tools:upper",
  ];
  for (const key of keys) assert.equal(page.isMirroredUiKey(key), main.isMirroredUiKey(key), key);
  assert.equal(page.isMirroredUiKey(7), false);
  // The rule's own lines, word for word, so a prefix added on one side only fails here.
  const rule = (file) => {
    const source = fs.readFileSync(path.join(__dirname, "..", file), "utf8");
    return ["MIRRORED_PREFIXES", "MIRRORED_KEYS", "SECRET_WORDS", "MAX_KEY_LENGTH", "MAX_VALUE_LENGTH", "MAX_TOTAL_LENGTH"]
      .map((name) => source.match(new RegExp(`const ${name} = ([^;]+);`))?.[1]);
  };
  assert.deepEqual(rule("src/ui-settings-mirror.ts"), rule("electron/ui-settings-mirror.cjs"));
  assert.ok(rule("src/ui-settings-mirror.ts").every(Boolean));

  // Every literal key, and every key template's fixed start, that the renderer stores.
  const root = path.resolve(__dirname, "../src");
  const files = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith(".")) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.tsx?$/.test(entry.name)) files.push(full);
    }
  };
  walk(root);
  // Every file: some keys live beside the code that parses them (SPLIT_STORE in chat-split.ts).
  // A bare `key` is a React list key, never a storage one.
  const found = new Map();
  for (const file of files) {
    const source = fs.readFileSync(file, "utf8");
    const literals = [
      ...source.matchAll(/localStorage\.(?:setItem|getItem)\(\s*(["'`])([^"'`$]+)\1/g),
      ...source.matchAll(/const\s+[A-Za-z_]+(?:KEY|STORE|ROUTE|ACTIVE|Key)\s*=\s*(["'`])([^"'`$]+)\1/g),
    ].map((match) => match[2]);
    const templates = [...source.matchAll(/(?:const\s+[A-Za-z_]+(?:Key|KEY)\s*=\s*[^`\n;]*|localStorage\.(?:setItem|getItem)\(\s*)`([^`$]+)\$\{/g)]
      .map((match) => `${match[1]}sample`);
    for (const key of [...literals, ...templates]) found.set(key, path.relative(root, file));
  }
  for (const key of [SPLIT, "coding-tools:ao:chat-pages", "coding-tools:ao:open-projects", "coding-tools:ao:project-order",
    "coding-tools:ao:chat-sections", "cdx-image-toolbar-position", "coding-tools:agy:terminal", "coding-tools:ao:last-chat-route",
    "coding-tools:ao:response-style:v1", "coding-tools:ao:model-tuning:sample", "native-codex:sample", "email.read.sample"]) {
    assert.ok(found.has(key), `the scan finds ${key}`);
  }
  const missed = [...found].filter(([key]) => !page.isMirroredUiKey(key));
  assert.deepEqual(missed, [], "a new settings key needs an app prefix or an entry in both key rules");
});

test("through the bundled preload: an emptied store comes back from the userData copy", async (t) => {
  const dir = mirrorDir(t);
  const code = buildSync({ entryPoints: [path.join(__dirname, "../electron/preload.cjs")], bundle: true,
    platform: "node", format: "cjs", target: "node22", external: ["electron"], write: false }).outputFiles[0].text;
  const preload = (ipcRenderer) => {
    const exposed = {};
    const electron = { contextBridge: { exposeInMainWorld: (name, api) => { exposed[name] = api; } }, ipcRenderer: { invoke: async () => null, on() {}, removeListener() {}, ...ipcRenderer } };
    require("node:vm").runInNewContext(code, { require: (name) => electron, console, setTimeout, clearTimeout, TextEncoder, structuredClone });
    return exposed.codexWebLauncher;
  };
  // A main process per run: the same file, a new store instance, the real handlers.
  const mainRun = () => {
    const mirror = main.createUiSettingsMirror({ filePath: path.join(dir, main.MIRROR_FILE) });
    const { handlers } = connectMain(mirror);
    const launcher = preload({
      sendSync: (channel) => { const event = {}; handlers.get(channel)(event); return structuredClone(event.returnValue); },
      send: (channel, entries) => handlers.get(channel)({}, structuredClone(entries)),
    });
    return { mirror, launcher };
  };
  const page = loadPageMirror();
  const Storage = storageType();
  const clock = fakeClock();

  const before = mainRun();
  const used = new Storage({ "coding-tools:ao:workspace": "w" });
  page.installUiSettingsMirror({ storage: used, bridge: before.launcher, target: fakeWindow(), ...clock });
  used.setItem(SPLIT, SPLIT_VALUE);
  used.setItem("coding-tools:ao:open-projects", "[\"w\"]");
  used.setItem("cdx-image-toolbar-position", "{\"x\":12}");
  clock.advance(1500);
  await before.mirror.saved();

  // Chromium starts an empty store; the next run gets everything back.
  const after = mainRun();
  const reset = new Storage();
  const result = page.installUiSettingsMirror({ storage: reset, bridge: after.launcher, target: fakeWindow(), ...clock });
  assert.equal(result.restored, 4);
  assert.deepEqual(reset.toJSON(), used.toJSON(), "the emptied store is the store it was");

  const noSync = preload({});
  assert.deepEqual(plain(noSync.loadUiSettingsMirror()), { ok: false, reason: "unavailable" }, "a host without sendSync answers instead of throwing");
  assert.deepEqual(plain(preload({ sendSync: () => undefined }).loadUiSettingsMirror()), { ok: false, reason: "unavailable" });
});

test("main.tsx installs the mirror before React and every screen, and main serves it before the renderer loads", () => {
  const read = (file) => fs.readFileSync(path.join(__dirname, "..", file), "utf8");
  const entry = read("src/main.tsx");
  const imports = [...entry.matchAll(/^import .*$/gm)].map((match) => match[0]);
  assert.equal(imports[0], "import \"./ui-settings-mirror-start\";", "the first import, so it runs before the others evaluate");
  assert.match(read("src/ui-settings-mirror-start.ts"), /installUiSettingsMirror\(\{ storage: window\.localStorage, bridge: window\.codexWebLauncher, target: window \}\)/);
  const mainSource = read("electron/main.cjs");
  const minimal = mainSource.slice(mainSource.indexOf("function registerMinimalPreRendererIpc"), mainSource.indexOf("function registerIpc("));
  assert.match(minimal, /installUiSettingsMirrorChannels\(logger\)/, "registered with the pre-renderer IPC");
  assert.match(mainSource, /event\.sender === mainWindow\.webContents\s+&& event\.sender\.mainFrame && event\.senderFrame === event\.sender\.mainFrame/);
});
