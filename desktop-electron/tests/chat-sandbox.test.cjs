"use strict";

const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { PassThrough } = require("node:stream");
const test = require("node:test");
const { createSandboxRunner, findCodexSandbox, PRIVATE_ENV } = require("../electron/chat-sandbox.cjs");

/** A spawn that records its call and hands back a child the test drives. */
function fakeSpawn() {
  const spawned = [];
  const spawnProcess = (file, args, options) => {
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.stdin = new PassThrough();
    child.input = [];
    child.stdin.on("data", (chunk) => child.input.push(chunk.toString("utf8")));
    child.pid = undefined; // kill() then ends it with child.kill(), never taskkill
    child.kill = () => setImmediate(() => child.emit("close", null, "SIGTERM"));
    child.finish = (code) => child.emit("close", code, null);
    spawned.push({ file, args, options, child, script: fs.readFileSync(args.at(-1), "utf8") });
    return child;
  };
  return { spawned, spawnProcess };
}

function runner(extra = {}) {
  const scriptDir = fs.mkdtempSync(path.join(os.tmpdir(), "chat-sandbox-"));
  const fake = fakeSpawn();
  const sandbox = createSandboxRunner({
    locate: () => ({ codex: "C:/codex/codex.exe", folder: "C:/codex" }), roots: () => ["C:/cache/npm"], scriptDir,
    env: { PATH: "C:/bin", OPENAI_API_KEY: "k", CODING_TOOLS_TOKEN: "t", NODE_OPTIONS: "--x", GITHUB_TOKEN: "g", HOME: "C:/u" },
    spawnProcess: fake.spawnProcess, logger: { info() {} }, ...extra,
  });
  return { sandbox, ...fake, scriptDir, cleanup: () => fs.rmSync(scriptDir, { recursive: true, force: true }) };
}

test("a command runs under codex sandbox, unelevated, with the worktree and caches writable and the network on", async () => {
  const { sandbox, spawned, cleanup } = runner();
  try {
    assert.equal(sandbox.available(), true);
    const id = sandbox.start({ cmd: 'echo "a b" && echo second', cwd: "G:/work/src", writable: "G:/work" });
    assert.match(id, /^sbx-[A-Za-z0-9]+$/);
    const [{ file, args, options, script }] = spawned;
    assert.equal(file, "C:/codex/codex.exe");
    assert.deepEqual(args.slice(0, 9), ["sandbox", "-c", "windows.sandbox='unelevated'", "-c", "sandbox_mode='workspace-write'",
      "-c", "sandbox_workspace_write.network_access=true", "-c", "sandbox_workspace_write.writable_roots=['G:/work','C:/cache/npm']"]);
    assert.deepEqual(args.slice(9, 13), ["--", "cmd.exe", "/d", "/c"]);
    assert.ok(!args.join(" ").includes("elevated'") || args.includes("windows.sandbox='unelevated'"), "never the elevated mode");
    assert.ok(script.endsWith('echo "a b" && echo second\r\n'), "the command reaches cmd.exe through a script, quotes intact");
    assert.equal(options.cwd, "G:/work/src");
    assert.deepEqual(Object.keys(options.env).sort(), ["HOME", "PATH"], "the app's credentials and runtime switches stay out");
  } finally { cleanup(); }
});

test("output is kept with absolute offsets, stdin reaches the command, and the script is removed when it ends", async () => {
  const { sandbox, spawned, cleanup } = runner();
  try {
    const id = sandbox.start({ cmd: "set /p NAME=", cwd: "G:/work", writable: "G:/work", stdin: "first\n" });
    const { child, args } = spawned[0];
    child.stdout.write("hello ");
    child.stdout.write("world");
    await new Promise((resolve) => setImmediate(resolve));
    let snap = sandbox.snapshot(id);
    assert.equal(snap.status, "running");
    assert.equal(snap.stdout, "hello world");
    assert.equal(snap.command_ok, null);
    const part = sandbox.read(id, "stdout", 6, 3);
    assert.deepEqual([part.content, part.offset, part.next_read_offset, part.truncated], ["wor", 6, 9, true]);
    sandbox.write(id, "second\n");
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(child.input, ["first\n", "second\n"]);

    child.finish(3);
    await sandbox.wait(id, 1000);
    snap = sandbox.snapshot(id);
    assert.deepEqual([snap.status, snap.exit_code, snap.command_ok, snap.stdin_open], ["exited", 3, false, false]);
    assert.throws(() => sandbox.write(id, "late"), /not running/);
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(fs.existsSync(args.at(-1)), false, "the script file is gone");
  } finally { cleanup(); }
});

test("kill ends a running command; ids it never started are not its own", async () => {
  const { sandbox, cleanup } = runner();
  try {
    const id = sandbox.start({ cmd: "npm run dev", cwd: "G:/work", writable: "G:/work" });
    assert.equal(sandbox.owns(id), true);
    assert.equal(sandbox.owns("c1"), false);
    const result = await sandbox.kill(id);
    assert.equal(result.status, "exited");
    assert.equal(result.termination_reason, "killed");
    assert.throws(() => sandbox.snapshot("c1"), /No such sandboxed command/);
  } finally { cleanup(); }
});

test("without the sandbox nothing starts, and the real locator finds nothing off Windows", () => {
  const { sandbox, spawned, cleanup } = runner({ locate: () => null });
  try {
    assert.equal(sandbox.available(), false);
    assert.equal(sandbox.describe(), null);
    assert.throws(() => sandbox.start({ cmd: "dir", cwd: "G:/work", writable: "G:/work" }), /not installed/);
    assert.equal(spawned.length, 0);
  } finally { cleanup(); }
  assert.equal(findCodexSandbox({ platform: "linux" }), null);
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "codex-bin-"));
  try {
    const bin = path.join(base, "OpenAI", "Codex", "bin", "1.0");
    fs.mkdirSync(bin, { recursive: true });
    fs.writeFileSync(path.join(bin, "codex.exe"), "");
    assert.equal(findCodexSandbox({ platform: "win32", localAppData: base, home: base }), null, "codex.exe alone is not enough");
    fs.writeFileSync(path.join(bin, "codex-windows-sandbox-setup.exe"), "");
    assert.equal(findCodexSandbox({ platform: "win32", localAppData: base, home: base }).folder, bin);
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});

test("an empty command is refused, and private environment names are recognised", () => {
  const { sandbox, cleanup } = runner();
  try {
    assert.throws(() => sandbox.start({ cmd: "  ", cwd: "G:/work", writable: "G:/work" }), /required/);
    assert.throws(() => sandbox.start({ cmd: "a\0b", cwd: "G:/work", writable: "G:/work" }), /required/);
  } finally { cleanup(); }
  for (const name of ["OPENAI_API_KEY", "GITHUB_TOKEN", "AWS_SECRET", "DB_PASSWORD", "CODING_TOOLS_PORT", "ELECTRON_RUN_AS_NODE", "NODE_OPTIONS"]) {
    assert.ok(PRIVATE_ENV.test(name), name);
  }
  for (const name of ["PATH", "HOME", "NODE_ENV", "TOKENIZERS_PARALLELISM"]) assert.ok(!PRIVATE_ENV.test(name), name);
});
