require("./support/temp-dirs.cjs"); // removes the temp folders this file makes when it ends
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createStateFileWriter, readStateFile, removeStateFile, writeStateFile } = require("../electron/durable-state.cjs");
const { createStateStore } = require("../electron/state.cjs");
const { createSecretCodec } = require("../electron/external-services.cjs");

const tempRoot = () => fs.mkdtempSync(path.join(os.tmpdir(), "durable-state-test-"));
const parse = (text) => JSON.parse(text);
// What a power cut or a failing disk left behind: the file's size, all NUL bytes.
const tear = (file) => fs.writeFileSync(file, Buffer.alloc(fs.statSync(file).size));

test("a credential read can preserve unreadable bytes in place for a later retry", () => {
  const root = tempRoot(), file = path.join(root, "credential.json");
  fs.writeFileSync(file, "torn");
  const read = readStateFile(file, parse, { preserveUnreadable: true });
  assert.equal(read.source, "unreadable");
  assert.equal(read.setAside, null);
  assert.equal(fs.readFileSync(file, "utf8"), "torn");
  fs.writeFileSync(file, JSON.stringify({ recovered: true }));
  assert.deepEqual(readStateFile(file, parse, { preserveUnreadable: true }).value, { recovered: true });
});

test("a state file is written with a copy and read back from the copy when torn", () => {
  const root = tempRoot();
  const file = path.join(root, "state.json");
  writeStateFile(file, JSON.stringify({ n: 1 }));
  assert.deepEqual(readStateFile(file, parse), { value: { n: 1 }, source: "file", error: null, setAside: null });
  assert.equal(fs.readFileSync(`${file}.bak`, "utf8"), JSON.stringify({ n: 1 }));

  tear(file);
  const read = readStateFile(file, parse, { now: () => 42 });
  assert.equal(read.source, "backup");
  assert.deepEqual(read.value, { n: 1 });
  assert.equal(read.setAside, `${file}.corrupt-42`);
  assert.ok(fs.readFileSync(read.setAside).every((byte) => byte === 0), "the torn bytes are kept for recovery by hand");
  assert.equal(fs.existsSync(file), false, "nothing is written over them");

  // A file lost between writes (its rename never reached the disk) is read from the copy too.
  assert.equal(readStateFile(file, parse).source, "backup");
});

test("two torn files set aside in the same millisecond both keep their bytes", () => {
  const root = tempRoot();
  const file = path.join(root, "state.json");
  for (const n of [1, 2]) {
    fs.writeFileSync(file, `torn ${n}`);
    readStateFile(file, parse, { now: () => 5 });
  }
  assert.equal(fs.readFileSync(`${file}.corrupt-5`, "utf8"), "torn 1");
  assert.equal(fs.readFileSync(`${file}.corrupt-5-1`, "utf8"), "torn 2");
});

test("a state file with no usable copy reads as unreadable, and a first start as none", () => {
  const root = tempRoot();
  const file = path.join(root, "state.json");
  assert.deepEqual(readStateFile(file, parse), { value: undefined, source: "none", error: null, setAside: null });
  writeStateFile(file, JSON.stringify({ n: 1 }));
  tear(file);
  tear(`${file}.bak`);
  const read = readStateFile(file, parse, { now: () => 7 });
  assert.equal(read.source, "unreadable");
  assert.equal(read.value, undefined);
  assert.ok(read.error instanceof SyntaxError);
  assert.equal(read.setAside, `${file}.corrupt-7`);
  removeStateFile(file);
  assert.equal(fs.existsSync(`${file}.bak`), false);
});

test("torn settings come back from their copy instead of a first start", () => {
  const root = tempRoot();
  const file = path.join(root, "launcher-state.json");
  const store = createStateStore(file);
  store.update({ onboardingComplete: true, language: "ja", automaticUpdates: false });
  assert.equal(store.recovery, null);

  tear(file);
  const recovered = createStateStore(file);
  assert.equal(recovered.recovery.source, "backup");
  assert.equal(recovered.read().onboardingComplete, true);
  assert.equal(recovered.read().language, "ja");
  assert.equal(recovered.read().automaticUpdates, false);

  // Both copies torn: defaults, with the torn file kept aside rather than written over.
  tear(`${file}.bak`);
  fs.writeFileSync(file, "\0\0\0\0");
  const reset = createStateStore(file);
  assert.equal(reset.recovery.source, "unreadable");
  assert.equal(reset.read().onboardingComplete, false);
  assert.ok(fs.existsSync(reset.recovery.setAside));
  reset.update({ language: "en" });
  assert.ok(fs.existsSync(reset.recovery.setAside), "a later save leaves the torn file where it was set aside");
});

test("a torn fallback key is read from its copy, so secrets it encrypted stay readable", () => {
  const root = tempRoot();
  const keyPath = path.join(root, "external-services.key");
  const sealed = createSecretCodec({ safeStorage: null, keyPath }).encrypt({ apiKey: "sk-test" });
  tear(keyPath);
  assert.deepEqual(createSecretCodec({ safeStorage: null, keyPath }).decrypt(sealed), { apiKey: "sk-test" });
  assert.notEqual(fs.readFileSync(keyPath)[0], 0, "the key file is written whole again");
  const setAside = () => fs.readdirSync(root).filter((name) => name.startsWith("external-services.key.corrupt-")).length;
  assert.equal(setAside(), 1);

  // With no usable copy a new key is made, and the old file is set aside instead of written over.
  tear(keyPath);
  tear(`${keyPath}.bak`);
  createSecretCodec({ safeStorage: null, keyPath }).encrypt({ apiKey: "sk-new" });
  assert.equal(setAside(), 2);
});

test("a state file saved as the app is used flushes off the main thread, one write per burst", async () => {
  // 2026-10-31: the chat queue and score log flushed on the main thread, holding every window
  // 0.5-2.4 s on the hard disk.
  const root = tempRoot();
  const file = path.join(root, "queue.json");
  const sync = [];
  const spied = ["fsyncSync", "writeFileSync", "writeSync", "renameSync"];
  const originals = Object.fromEntries(spied.map((name) => [name, fs[name]]));
  for (const name of spied) fs[name] = (...args) => { sync.push(name); return originals[name](...args); };
  const opened = [];
  const open = fs.promises.open;
  fs.promises.open = (target, ...rest) => { opened.push(path.basename(String(target)).replace(/.tmp-.*/, "")); return open(target, ...rest); };
  try {
    const writer = createStateFileWriter(file);
    for (let n = 1; n <= 5; n += 1) writer.save(JSON.stringify({ n }));
    await writer.saved();
    assert.deepEqual(sync, [], "nothing is written or flushed on the main thread");
    assert.deepEqual(opened, ["queue.json", "queue.json"], "five saves in a row are the first plus the latest");
  } finally {
    Object.assign(fs, originals);
    fs.promises.open = open;
  }
  assert.deepEqual(readStateFile(file, parse).value, { n: 5 });
  assert.equal(fs.readFileSync(`${file}.bak`, "utf8"), JSON.stringify({ n: 5 }), "its copy is kept too");

  const errors = [];
  const blocked = path.join(root, "blocked");
  fs.writeFileSync(blocked, "a file where the folder should be");
  const failing = createStateFileWriter(path.join(blocked, "state.json"), { onError: (error) => errors.push(error.code) });
  failing.save("{}");
  await failing.saved();
  assert.equal(errors.length, 1, "a failed save is reported, not thrown at whoever changed the state");
});
