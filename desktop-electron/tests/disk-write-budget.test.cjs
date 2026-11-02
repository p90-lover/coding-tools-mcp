require("./support/temp-dirs.cjs");
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { PassThrough } = require("node:stream");
const { createLogger, exportSanitizedLogs, installProcessDiagnosticGuards } = require("../electron/logging.cjs");
const { createStateFileWriter } = require("../electron/durable-state.cjs");
const { pruneOldRuntimes } = require("../electron/runtime-install.cjs");

function directory(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "disk-write-budget-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

test("memory-only launcher activity restores, appends and flushes without any log filesystem calls", async t => {
  const root = directory(t), filePath = path.join(root, "launcher.jsonl"), calls = [], published = [];
  const originals = [];
  for (const [owner, names] of [[fs, ["readFileSync", "appendFileSync", "mkdirSync"]],
    [fs.promises, ["open", "readFile", "appendFile", "mkdir", "stat"]]]) {
    for (const name of names) {
      const original = owner[name]; originals.push(() => { owner[name] = original; });
      owner[name] = function (file, ...rest) {
        if (String(file).startsWith(root)) calls.push(name);
        return original.call(this, file, ...rest);
      };
    }
  }
  const stream = new PassThrough();
  let logger;
  try {
    logger = createLogger({ filePath, persist: false, publish: record => published.push(record) });
    for (let n = 0; n < 1000; n++) logger.info("fixture.activity", { n, runtimeKey: "private" });
    await logger.restored; await logger.flush();
    installProcessDiagnosticGuards({ filePath, streams: [stream], persist: false });
    stream.emit("error", new Error("closed diagnostic pipe"));
    assert.deepEqual(calls, []);
    assert.equal(logger.filePath, null);
    assert.equal(logger.recent(300).length, 300);
    assert.equal(published.length, 1000);
    assert.equal(logger.recent(1)[0].detail.runtimeKey, "[redacted]");
  } finally { originals.reverse().forEach(restore => restore()); stream.destroy(); }
  const destinationPath = path.join(root, "chosen-export.jsonl");
  logger.info("fixture.export", { prompt: "private prompt", url: "https://example.com/private?secret=hidden" });
  assert.equal(exportSanitizedLogs({ records: logger.recent(300), destinationPath }), 300);
  const exported = fs.readFileSync(destinationPath, "utf8");
  assert.doesNotMatch(exported, /private prompt|secret=hidden|\/private/);
  assert.match(exported, /fixture.export/);
  assert.equal(fs.existsSync(filePath), false, "only the user-selected export is created");
});

test("the launcher opts out of all its diagnostic file sinks unless explicitly enabled", () => {
  const main = fs.readFileSync(path.resolve(__dirname, "../electron/main.cjs"), "utf8");
  assert.match(main, /installProcessDiagnosticGuards\(\{[\s\S]*?persist: process\.env\.CODING_TOOLS_PERSIST_LOGS === "1"/);
  assert.match(main, /const logger = createLogger\(\{[\s\S]*?persist: process\.env\.CODING_TOOLS_PERSIST_LOGS === "1"/);
  assert.match(main, /if \(process\.env\.CODING_TOOLS_PERSIST_LOGS === "1"\) \{\s*try \{\s*fs\.appendFileSync/);
  assert.match(main, /records: logger\.filePath \? \[\] : logger\.recent\(300\)/);
  assert.match(main, /defaultPath: path\.join\(app\.getPath\("userData"\), `codex-web-gpt-diagnostics-/);
});

test("identical state saves write and flush one primary plus one backup", async t => {
  const root = directory(t), file = path.join(root, "state.json"), open = fs.promises.open;
  let writes = 0;
  fs.promises.open = function (target, ...rest) { if (String(target).startsWith(file + ".tmp-")) writes++; return open.call(this, target, ...rest); };
  try {
    const writer = createStateFileWriter(file);
    for (let n = 0; n < 20; n++) writer.save('{"state":1}');
    await writer.saved();
    for (let n = 0; n < 20; n++) { writer.save('{"state":1}'); await writer.saved(); }
    assert.equal(writes, 1, "unchanged state causes no additional primary fsyncs");
    assert.equal(fs.readFileSync(file, "utf8"), '{"state":1}');
    assert.equal(fs.readFileSync(file + ".bak", "utf8"), '{"state":1}');
    writer.save('{"state":2}'); writer.save('{"state":3}'); await writer.saved();
    assert.equal(fs.readFileSync(file, "utf8"), '{"state":3}', "a newer queued value is not dropped");
    assert.equal(fs.readFileSync(file + ".bak", "utf8"), '{"state":3}');
  } finally { fs.promises.open = open; }
});

test("a failed backup invalidates deduplication and an identical save repairs both copies", async t => {
  const root = directory(t), file = path.join(root, "state.json"), writeFile = fs.promises.writeFile;
  let blocked = true;
  fs.promises.writeFile = function (target, ...rest) {
    if (blocked && String(target).startsWith(file + ".bak.tmp-")) return Promise.reject(Object.assign(new Error("backup failed"), { code: "EIO" }));
    return writeFile.call(this, target, ...rest);
  };
  try {
    const writer = createStateFileWriter(file);
    writer.save("first"); await writer.saved();
    assert.equal(fs.existsSync(file + ".bak"), false);
    blocked = false; writer.save("first"); await writer.saved();
    assert.equal(fs.readFileSync(file + ".bak", "utf8"), "first");
    blocked = true; writer.save("second"); await writer.saved();
    blocked = false; writer.save("first"); await writer.saved();
    assert.equal(fs.readFileSync(file, "utf8"), "first", "an older success is not mistaken for the current primary after a partial failure");
  } finally { fs.promises.writeFile = writeFile; }
});

test("a failed primary write is retried even when the requested content is identical", async t => {
  const root = directory(t), file = path.join(root, "retry.json"), open = fs.promises.open, errors = [];
  let blocked = true;
  fs.promises.open = function (target, ...rest) {
    if (blocked && String(target).startsWith(file + ".tmp-")) return Promise.reject(Object.assign(new Error("primary failed"), { code: "EIO" }));
    return open.call(this, target, ...rest);
  };
  try {
    const writer = createStateFileWriter(file, { onError: error => errors.push(error.code) });
    writer.save("same"); await writer.saved();
    assert.deepEqual(errors, ["EIO"]); assert.equal(fs.existsSync(file), false);
    blocked = false; writer.save("same"); await writer.saved();
    assert.equal(fs.readFileSync(file, "utf8"), "same");
    assert.equal(fs.readFileSync(file + ".bak", "utf8"), "same");
    const buffer = Buffer.from("next"); writer.save(buffer); await writer.saved();
    buffer.write("last"); writer.save(buffer); await writer.saved();
    assert.equal(fs.readFileSync(file, "utf8"), "last", "mutable buffers are never deduplicated by reference");
  } finally { fs.promises.open = open; }
});

test("runtime cleanup is asynchronous, serial and never deletes a directory whose retirement is refused", async t => {
  const root = directory(t), versions = path.join(root, "versions"), suffix = `-${process.platform}-${process.arch}`;
  for (const version of ["0.1.0", "0.2.0", "0.3.0"]) fs.mkdirSync(path.join(versions, version + suffix), { recursive: true });
  const originals = { readdirSync: fs.readdirSync, statSync: fs.statSync, renameSync: fs.renameSync, rename: fs.promises.rename, rm: fs.promises.rm };
  const sync = []; let active = 0, peak = 0;
  for (const name of ["readdirSync", "statSync", "renameSync"]) fs[name] = function (file, ...rest) {
    if (String(file).startsWith(versions)) sync.push(name); return originals[name].call(this, file, ...rest);
  };
  fs.promises.rename = function (from, to) {
    if (String(from).endsWith("0.1.0" + suffix)) return Promise.reject(Object.assign(new Error("in use"), { code: "EBUSY" }));
    return originals.rename.call(this, from, to);
  };
  fs.promises.rm = async function (...args) { active++; peak = Math.max(peak, active); try { return await originals.rm.call(this, ...args); } finally { active--; } };
  try {
    await pruneOldRuntimes({ app: { isPackaged: true, getVersion: () => "0.4.0" }, coreHome: root, keepOthers: 0 });
    assert.deepEqual(sync, []);
    assert.equal(peak, 1);
    assert.equal(fs.existsSync(path.join(versions, "0.1.0" + suffix)), true);
    assert.equal(fs.existsSync(path.join(versions, "0.2.0" + suffix)), false);
  } finally {
    for (const name of ["readdirSync", "statSync", "renameSync"]) fs[name] = originals[name];
    fs.promises.rename = originals.rename; fs.promises.rm = originals.rm;
  }
});
