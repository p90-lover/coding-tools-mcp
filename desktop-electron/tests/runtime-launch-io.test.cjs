require("./support/temp-dirs.cjs");
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createHash } = require("node:crypto");
const runtime = require("../electron/runtime-install.cjs");

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "runtime-launch-io-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const resourcesPath = path.join(root, "resources"), source = path.join(resourcesPath, "runtime");
  const app = { isPackaged: true, getVersion: () => "0.1.0" }, coreHome = path.join(root, "core");
  const files = [
    [`runtime/${process.platform === "win32" ? "bun.exe" : "bun"}`, "bun"],
    ["app/cli.js", "cli"], ["app/browser-helper.cjs", "helper"],
    [`bin/${process.platform === "win32" ? "codex-chatgpt-web.cmd" : "codex-chatgpt-web"}`, "launcher"],
    ...Array.from({ length: 16 }, (_, i) => [`app/packages/p${i % 4}/file${i}.js`, "x".repeat(1024)]),
  ].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([file, content]) => {
    const target = path.join(source, ...file.split("/"));
    fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, content);
    if (file.startsWith("runtime/") && process.platform !== "win32") fs.chmodSync(target, 0o755);
    return { path: file, size: Buffer.byteLength(content), sha256: createHash("sha256").update(content).digest("hex") };
  });
  const hash = createHash("sha256");
  for (const file of files) hash.update(`${file.path}\0${file.size}\0${file.sha256}\0`);
  fs.writeFileSync(path.join(source, "manifest.json"), JSON.stringify({ schemaVersion: 2, appVersion: app.getVersion(), platform: process.platform,
    arch: process.arch, bundleId: hash.digest("hex"), bunVersion: "1.4.4", playwright: "1.62.0", entrypoint: "app/cli.js",
    launcher: `bin/${process.platform === "win32" ? "codex-chatgpt-web.cmd" : "codex-chatgpt-web"}`, files }));
  return { root, resourcesPath, source, app, coreHome, files, options: { app, coreHome, resourcesPath } };
}

async function operations(run) {
  const names = ["lstat", "readdir", "readFile", "cp"], calls = [];
  const originals = Object.fromEntries(names.map(name => [name, fs.promises[name]]));
  for (const name of names) fs.promises[name] = function (file, ...rest) {
    calls.push({ name, file: String(file) }); return originals[name].call(this, file, ...rest);
  };
  try { return { value: await run(), calls }; } finally { Object.assign(fs.promises, originals); }
}

test("a warm launch checks its installed files once and never walks the unused packaged source", async t => {
  const f = fixture(t);
  const installed = await runtime.ensurePackagedRuntimeAsync(f.options);
  const baseline = await operations(async () => {
    await runtime.waitForPackagedRuntimeSource(f.options);
    return runtime.ensurePackagedRuntimeAsync(f.options);
  });
  const before = baseline.calls.filter(call => call.name === "lstat").length;
  assert.equal(before, f.files.length * 2, "the previous launch path checks both complete trees");
  assert.equal(typeof runtime.preparePackagedRuntime, "function");
  const after = await operations(() => runtime.preparePackagedRuntime(f.options));
  assert.equal(after.value, installed);
  assert.equal(after.calls.filter(call => call.name === "lstat").length, f.files.length);
  assert.equal(after.calls.filter(call => ["lstat", "readdir"].includes(call.name) && call.file.startsWith(f.source)).length, 0);
  assert.equal(after.calls.filter(call => call.name === "cp").length, 0);
  t.diagnostic(`warm launch lstat calls: ${before} -> ${f.files.length}; source directory walks: 1 -> 0`);
});

test("a first launch verifies source, staging and the moved destination, without verifying destination twice", async t => {
  const f = fixture(t);
  assert.equal(typeof runtime.preparePackagedRuntime, "function");
  const result = await operations(() => runtime.preparePackagedRuntime(f.options));
  const destinationStats = result.calls.filter(call => call.name === "lstat" && call.file.startsWith(result.value + path.sep));
  assert.equal(destinationStats.length, f.files.length);
  assert.equal(result.calls.filter(call => call.name === "lstat").length, f.files.length * 3);
  assert.equal(fs.readFileSync(path.join(result.value, "app", "cli.js"), "utf8"), "cli");
});

test("launch still repairs changed content and reports an installed fallback for a broken source manifest", async t => {
  const f = fixture(t);
  assert.equal(typeof runtime.preparePackagedRuntime, "function");
  const installed = await runtime.preparePackagedRuntime(f.options);
  fs.writeFileSync(path.join(installed, "app", "cli.js"), "CLI");
  assert.equal(await runtime.preparePackagedRuntime(f.options), installed);
  assert.equal(fs.readFileSync(path.join(installed, "app", "cli.js"), "utf8"), "cli", "same-size damage is not trusted");
  fs.writeFileSync(path.join(f.source, "manifest.json"), "torn");
  const warnings = [];
  assert.equal(await runtime.preparePackagedRuntime({ ...f.options, onFallback: error => warnings.push(error.message) }), installed);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /manifest is invalid/);
});

test("launch waits for partially materialized files but does not retry an unrelated copy I/O failure", async t => {
  const f = fixture(t);
  assert.equal(typeof runtime.preparePackagedRuntime, "function");
  const cli = path.join(f.source, "app", "cli.js"); fs.unlinkSync(cli);
  const timer = setTimeout(() => fs.writeFileSync(cli, "cli"), 30);
  t.after(() => clearTimeout(timer));
  const installed = await runtime.preparePackagedRuntime({ ...f.options, timeoutMs: 1000, intervalMs: 10 });
  assert.equal(fs.existsSync(path.join(installed, "app", "cli.js")), true);
  fs.rmSync(path.join(f.coreHome, "versions"), { recursive: true, force: true });
  const original = fs.promises.cp; let copies = 0;
  fs.promises.cp = async () => { copies++; throw Object.assign(new Error("device failure"), { code: "EIO" }); };
  try {
    await assert.rejects(runtime.preparePackagedRuntime({ ...f.options, timeoutMs: 1000, intervalMs: 10 }), /device failure/);
    assert.equal(copies, 1, "a copy failure is not repeated as a source-materialization retry");
  } finally { fs.promises.cp = original; }
});

test("preparation preserves a full-disk source fallback and bounds incomplete-package retries", async t => {
  const f = fixture(t), copy = fs.promises.cp;
  fs.promises.cp = async () => { throw Object.assign(new Error("full disk"), { code: "ENOSPC" }); };
  try { assert.equal(await runtime.preparePackagedRuntime(f.options), f.source); }
  finally { fs.promises.cp = copy; }
  fs.unlinkSync(path.join(f.source, "app", "cli.js"));
  await assert.rejects(runtime.preparePackagedRuntime({ ...f.options, timeoutMs: 0 }), /did not fully materialize within 0ms/);
  await assert.rejects(runtime.preparePackagedRuntime({ ...f.options, intervalMs: 0 }), /positive intervalMs/);
  assert.equal(await runtime.preparePackagedRuntime({ ...f.options, app: { isPackaged: false } }), null);
});

test("launcher prepares once and defers runtime cleanup until after first paint", () => {
  const ts = require("typescript"), vm = require("node:vm");
  const source = fs.readFileSync(path.resolve(__dirname, "../electron/main.cjs"), "utf8");
  assert.equal(source.match(/await preparePackagedRuntime\(/g)?.length, 1);
  assert.doesNotMatch(source, /await waitForPackagedRuntimeSource|await ensurePackagedRuntimeAsync/);
  const tree = ts.createSourceFile("main.cjs", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  let listener;
  const visit = node => {
    if (ts.isCallExpression(node) && node.expression.getText(tree) === "mainWindow.once"
      && node.arguments[0]?.text === "ready-to-show" && node.arguments[1]?.getText(tree).includes("pruneOldRuntimes")) listener = node.arguments[1];
    ts.forEachChild(node, visit);
  };
  visit(tree); assert.ok(listener);
  let scheduled, retired = 0, unref = 0;
  const context = { exports: {}, app: {}, CORE_HOME: "/fixture", pruneOldRuntimes: async () => { retired++; },
    setTimeout: (callback, delay) => { scheduled = { callback, delay }; return { unref: () => { unref++; } }; } };
  vm.runInNewContext("exports.ready = " + listener.getText(tree), context);
  assert.equal(scheduled, undefined);
  context.exports.ready();
  assert.equal(retired, 0); assert.equal(scheduled.delay, 30_000); assert.equal(unref, 1);
  scheduled.callback(); assert.equal(retired, 1);
});

test("asynchronous checks hash payloads as streams, not whole-file buffers", async t => {
  const f = fixture(t), original = fs.promises.readFile, createReadStream = fs.createReadStream;
  const buffers = [];
  fs.createReadStream = function (file, options) {
    buffers.push({ file: String(file), size: options.highWaterMark });
    return createReadStream.call(this, file, options);
  };
  fs.promises.readFile = function (file, ...rest) {
    if (String(file).startsWith(f.source) && !String(file).endsWith("manifest.json")) throw new Error("whole payload read");
    return original.call(this, file, ...rest);
  };
  try {
    await runtime.validateRuntimeBundleAsync(f.source, { version: f.app.getVersion(), platform: process.platform, arch: process.arch });
    assert.equal(buffers.length, f.files.length);
    for (const buffer of buffers) {
      const file = f.files.find(file => path.join(f.source, ...file.path.split("/")) === buffer.file);
      assert.equal(buffer.size, Math.max(1, Math.min(file.size, 256 * 1024)), "small files do not allocate a full 256 KiB buffer");
    }
  } finally { fs.promises.readFile = original; fs.createReadStream = createReadStream; }
});
