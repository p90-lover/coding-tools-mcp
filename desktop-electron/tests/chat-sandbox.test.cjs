"use strict";
require("./support/temp-dirs.cjs"); // removes the temp folders this file makes when it ends

const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const fs = require("node:fs");
const path = require("node:path");
const { PassThrough } = require("node:stream");
const test = require("node:test");
const { createSandboxRunner, findCodexSandbox, PRIVATE_ENV, windowsChildEnvironment, compactWindowsPath, MAX_WINDOWS_PATH } = require("../electron/chat-sandbox.cjs");

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

// Test files stay in the repo's aiTemp, never the system temp folder on C: (AGENTS.md).
function testRoot() {
  const root = path.join(__dirname, "..", "..", "aiTemp", "chat-sandbox-tests");
  fs.mkdirSync(root, { recursive: true });
  return root;
}

function runner(extra = {}) {
  const scriptDir = fs.mkdtempSync(path.join(testRoot(), "run-"));
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
    // Seen live 2026-10-31: the synchronous script write held every window for 0.5 s per command.
    const { mkdirSync, writeFileSync } = fs;
    let blocking = 0;
    fs.mkdirSync = (...args) => { blocking += 1; return mkdirSync(...args); };
    fs.writeFileSync = (...args) => { blocking += 1; return writeFileSync(...args); };
    let id;
    try {
      id = await sandbox.start({ cmd: 'echo "a b" && echo second', cwd: "G:/work/src", writable: "G:/work" });
    } finally {
      Object.assign(fs, { mkdirSync, writeFileSync });
    }
    assert.equal(blocking, 0, "the script is written without a synchronous disk call");
    assert.match(id, /^sbx-[A-Za-z0-9]+$/);
    const [{ file, args, options, script }] = spawned;
    assert.equal(file, "C:/codex/codex.exe");
    assert.deepEqual(args.slice(0, 9), ["sandbox", "-c", "windows.sandbox='unelevated'", "-c", "sandbox_mode='workspace-write'",
      "-c", "sandbox_workspace_write.network_access=true", "-c", "sandbox_workspace_write.writable_roots=['G:/work','C:/cache/npm']"]);
    assert.deepEqual(args.slice(9, 13), ["--", "cmd.exe", "/d", "/c"]);
    assert.ok(!args.join(" ").includes("elevated'") || args.includes("windows.sandbox='unelevated'"), "never the elevated mode");
    assert.ok(script.endsWith('echo "a b" && echo second\r\n'), "the command reaches cmd.exe through a script, quotes intact");
    // Codex's sandbox hangs unless it starts in a writable root, so the script moves to the subfolder.
    assert.equal(options.cwd, "G:/work");
    assert.ok(script.includes(`cd /d "${path.resolve("G:/work/src")}" || exit /b 1\r\necho "a b"`), "the script enters the requested folder first");
    assert.equal(options.env.HOME, "C:/u");
    assert.equal(options.env.PATH, "C:/bin");
    for (const name of ["OPENAI_API_KEY", "CODING_TOOLS_TOKEN", "NODE_OPTIONS", "GITHUB_TOKEN"]) {
      assert.equal(options.env[name], undefined, `${name} stays out of the command's environment`);
    }
  } finally { cleanup(); }
});

test("AO's `ao` folder goes first on a command's PATH, and a broken provider changes nothing", async () => {
  // Seen live: an agent's `ao` command through the app's terminal was "not recognized"; AO puts its
  // shim folder only on its own sessions' PATH.
  const shim = path.resolve("C:/ao/runtime/ao-path/12a8f4aa");
  const { sandbox, spawned, cleanup } = runner({ extraPath: () => [shim, "relative/ignored", null] });
  const broken = runner({ extraPath: () => { throw new Error("AO not started"); } });
  try {
    await sandbox.start({ cmd: "ao status", cwd: "G:/work", writable: "G:/work" });
    const pathValue = spawned[0].options.env.PATH;
    assert.ok(pathValue.startsWith(`${shim}${process.platform === "win32" ? ";" : ":"}`), pathValue);
    assert.ok(pathValue.includes("C:/bin"), "the inherited PATH stays after it");
    assert.ok(!pathValue.includes("relative/ignored"), "only absolute folders");
    await broken.sandbox.start({ cmd: "echo ok", cwd: "G:/work", writable: "G:/work" });
    assert.equal(broken.spawned[0].options.env.PATH, "C:/bin");
  } finally { cleanup(); broken.cleanup(); }
});

test("a command in the worktree itself starts there without a folder change, and % in a folder survives cmd", async () => {
  const { sandbox, spawned, cleanup } = runner();
  try {
    await sandbox.start({ cmd: "echo here", cwd: "G:/work", writable: "G:/work" });
    await sandbox.start({ cmd: "echo there", cwd: "G:/work/50%off", writable: "G:/work" });
    const [root, odd] = spawned;
    assert.equal(root.options.cwd, "G:/work");
    assert.ok(!root.script.includes("cd /d"), "no folder change when it already starts there");
    assert.equal(odd.options.cwd, "G:/work");
    assert.ok(odd.script.includes(`cd /d "${path.resolve("G:/work/50%off").replace("%", "%%")}"`), "% is doubled for cmd");
  } finally { cleanup(); }
});

test("output is kept with absolute offsets, stdin reaches the command, and the script is removed when it ends", async () => {
  const { sandbox, spawned, cleanup } = runner();
  try {
    const id = await sandbox.start({ cmd: "set /p NAME=", cwd: "G:/work", writable: "G:/work", stdin: "first\n" });
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
    const id = await sandbox.start({ cmd: "npm run dev", cwd: "G:/work", writable: "G:/work" });
    assert.equal(sandbox.owns(id), true);
    assert.equal(sandbox.owns("c1"), false);
    const result = await sandbox.kill(id);
    assert.equal(result.status, "exited");
    assert.equal(result.termination_reason, "killed");
    assert.throws(() => sandbox.snapshot("c1"), /No such sandboxed command/);
  } finally { cleanup(); }
});

test("read_output keeps UTF-8 scalars within strict raw limits and preserves absolute gap cursors", async () => {
  const { sandbox, spawned, cleanup } = runner();
  try {
    const id = await sandbox.start({ cmd: "echo unicode", cwd: "G:/work", writable: "G:/work" });
    const text = "a".repeat(4095) + "éz";
    spawned[0].child.stdout.write(Buffer.from(text));
    let offset = 0, rebuilt = "";
    while (offset < Buffer.byteLength(text)) {
      const page = sandbox.read(id, "stdout", offset, 4096);
      assert.equal(page.ok, true);
      assert.ok(page.next_read_offset > offset && page.next_read_offset - offset <= 4096);
      if (offset === 0) assert.equal(page.next_read_offset, 4095);
      rebuilt += page.content;
      offset = page.next_read_offset;
    }
    assert.equal(rebuilt, text);
    const fractional = sandbox.read(id, "stdout", 4091.75, 5.5);
    assert.deepEqual([fractional.content, fractional.offset, fractional.next_read_offset], ["aaaa", 4091, 4095]);
    const fractionalSmall = sandbox.read(id, "stdout", 4095.75, 1.5);
    assert.deepEqual([fractionalSmall.error.code, fractionalSmall.error.details.offset,
      fractionalSmall.error.details.next_read_offset, fractionalSmall.error.details.limit,
      fractionalSmall.error.details.required_min_limit], ["OUTPUT_LIMIT_TOO_SMALL", 4095, 4095, 1, 2]);
    for (const scalar of ["é", "中", "💡"]) {
      const unicode = await sandbox.start({ cmd: "echo scalar", cwd: "G:/work", writable: "G:/work" });
      spawned.at(-1).child.stdout.write(Buffer.from(scalar));
      for (let limit = 1; limit <= 4; limit += 1) {
        const page = sandbox.read(unicode, "stdout", 0, limit);
        if (limit < Buffer.byteLength(scalar)) {
          assert.equal(page.ok, false);
          assert.equal(page.error.code, "OUTPUT_LIMIT_TOO_SMALL");
          assert.deepEqual([page.error.details.offset, page.error.details.next_read_offset, page.error.details.limit,
            page.error.details.required_min_limit], [0, 0, limit, Buffer.byteLength(scalar)]);
        } else assert.deepEqual([page.content, page.next_read_offset], [scalar, Buffer.byteLength(scalar)]);
      }
      spawned.at(-1).child.finish(0);
    }
    // Retention drops the first raw chunk without changing byte ownership or absolute cursors.
    const gapId = await sandbox.start({ cmd: "echo retained", cwd: "G:/work", writable: "G:/work" });
    const gapChild = spawned.at(-1).child;
    const retainedStart = 4 * 1024 * 1024;
    gapChild.stdout.write(Buffer.alloc(retainedStart, 0x61));
    gapChild.stdout.write(Buffer.from("éz"));
    const tooSmall = sandbox.read(gapId, "stdout", 0, 1);
    assert.deepEqual([tooSmall.error.details.offset, tooSmall.error.details.next_read_offset, tooSmall.error.details.output_gap],
      [retainedStart, retainedStart, true]);
    const retained = sandbox.read(gapId, "stdout", 0, 2);
    assert.deepEqual([retained.content, retained.offset, retained.next_read_offset, retained.output_gap, retained.truncated],
      ["é", retainedStart, retainedStart + 2, true, true]);
    const inside = sandbox.read(gapId, "stdout", retainedStart + 1, 1);
    assert.deepEqual([inside.content, inside.offset, inside.next_read_offset], ["�", retainedStart + 1, retainedStart + 2]);
    gapChild.finish(0);
    spawned[0].child.finish(0);
  } finally { cleanup(); }
});

test("read_output waits for incomplete live scalars through split writes and process status until child close", async () => {
  const { sandbox, spawned, cleanup } = runner();
  try {
    const id = await sandbox.start({ cmd: "echo split", cwd: "G:/work", writable: "G:/work" });
    const child = spawned[0].child;
    child.stdout.write(Buffer.from([0x61, 0xc3]));
    const prefix = sandbox.read(id, "stdout", 0, 4096);
    assert.deepEqual([prefix.content, prefix.next_read_offset, prefix.truncated], ["a", 1, true]);
    let pending = sandbox.read(id, "stdout", 1, 4096);
    assert.equal(pending.error.code, "OUTPUT_PENDING");
    assert.deepEqual([pending.error.details.offset, pending.error.details.next_read_offset, pending.error.retryable], [1, 1, true]);
    child.stdout.write(Buffer.from([0xa9, 0x7a]));
    assert.deepEqual([sandbox.read(id, "stdout", 1, 4096).content, sandbox.read(id, "stdout", 1, 4096).next_read_offset], ["éz", 4]);
    child.finish(0);

    const terminal = await sandbox.start({ cmd: "echo terminal", cwd: "G:/work", writable: "G:/work" });
    const terminalChild = spawned[1].child;
    terminalChild.stdout.write(Buffer.from([0xf0, 0x9f]));
    terminalChild.emit("error", new Error("spawn failed before stdio closed"));
    pending = sandbox.read(terminal, "stdout", 0, 4096);
    assert.equal(pending.error.code, "OUTPUT_PENDING");
    assert.equal(pending.error.details.status, "exited", "process status is separate from output completion");
    assert.equal(pending.error.details.next_read_offset, 0);
    terminalChild.finish(1);
    assert.deepEqual([sandbox.read(terminal, "stdout").content, sandbox.read(terminal, "stdout").next_read_offset], ["�", 2]);

    const invalid = await sandbox.start({ cmd: "echo invalid", cwd: "G:/work", writable: "G:/work" });
    spawned[2].child.stdout.write(Buffer.from([0x80, 0xbf, 0xff, 0xe0, 0x80]));
    const bytes = sandbox.read(invalid, "stdout", 0, 4096);
    assert.equal(bytes.ok, true);
    assert.equal(bytes.next_read_offset, 5, "genuinely invalid bytes retain lossy decoding and raw accounting");
    spawned[2].child.finish(0);
  } finally { cleanup(); }
});

test("without the sandbox nothing starts, and the real locator finds nothing off Windows", async () => {
  const { sandbox, spawned, cleanup } = runner({ locate: () => null });
  try {
    assert.equal(sandbox.available(), false);
    assert.equal(sandbox.describe(), null);
    await assert.rejects(() => sandbox.start({ cmd: "dir", cwd: "G:/work", writable: "G:/work" }), /not installed/);
    assert.equal(spawned.length, 0);
  } finally { cleanup(); }
  assert.equal(findCodexSandbox({ platform: "linux" }), null);
  const base = fs.mkdtempSync(path.join(testRoot(), "codex-bin-"));
  try {
    const bin = path.join(base, "OpenAI", "Codex", "bin", "1.0");
    fs.mkdirSync(bin, { recursive: true });
    fs.writeFileSync(path.join(bin, "codex.exe"), "");
    assert.equal(findCodexSandbox({ platform: "win32", localAppData: base, home: base }), null, "codex.exe alone is not enough");
    fs.writeFileSync(path.join(bin, "codex-windows-sandbox-setup.exe"), "");
    assert.equal(findCodexSandbox({ platform: "win32", localAppData: base, home: base }).folder, bin);
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});

test("an empty command is refused, and private environment names are recognised", async () => {
  const { sandbox, cleanup } = runner();
  try {
    await assert.rejects(() => sandbox.start({ cmd: "  ", cwd: "G:/work", writable: "G:/work" }), /required/);
    await assert.rejects(() => sandbox.start({ cmd: "a\0b", cwd: "G:/work", writable: "G:/work" }), /required/);
  } finally { cleanup(); }
  for (const name of ["OPENAI_API_KEY", "GITHUB_TOKEN", "AWS_SECRET", "DB_PASSWORD", "CODING_TOOLS_PORT", "ELECTRON_RUN_AS_NODE", "NODE_OPTIONS"]) {
    assert.ok(PRIVATE_ENV.test(name), name);
  }
  for (const name of ["PATH", "HOME", "NODE_ENV", "TOKENIZERS_PARALLELISM"]) assert.ok(!PRIVATE_ENV.test(name), name);
});

// Chat agents' Bash commands failed on Windows with "dofork: child -1 - CreateProcess failed ...
// 0xC0000142": Git Bash forks need SystemRoot, TEMP and the rest in every child's environment.
test("a Windows child environment gets what a process needs to start, without changing what it has", () => {
  const env = windowsChildEnvironment({ Path: "C:\\tools;c:\\TOOLS\\;;C:\\bin", TMP: "C:\\t", USERPROFILE: "C:\\Users\\me" },
    { platform: "win32", system: { SystemRoot: "D:\\Win", LOCALAPPDATA: "C:\\Users\\me\\AppData\\Local", USERPROFILE: "C:\\elsewhere" } });
  assert.equal(env.SystemRoot, "D:\\Win");
  assert.equal(env.windir, "D:\\Win");
  assert.equal(env.SystemDrive, "D:");
  assert.equal(env.ComSpec, "D:\\Win\\System32\\cmd.exe");
  assert.match(env.PATHEXT, /\.EXE/);
  assert.equal(env.TEMP, "C:\\t", "TEMP follows TMP");
  assert.equal(env.TMP, "C:\\t");
  assert.equal(env.USERPROFILE, "C:\\Users\\me", "a value it has is kept");
  assert.equal(env.LOCALAPPDATA, "C:\\Users\\me\\AppData\\Local");
  assert.equal(env.Path, "C:\\tools;C:\\bin", "PATH keeps its spelling, without empty or repeated entries");
  assert.equal(env.PATH, undefined);
  const kept = { systemroot: "C:\\Windows", Windir: "C:\\Windows" };
  const same = windowsChildEnvironment(kept, { platform: "win32" });
  assert.equal(same.systemroot, "C:\\Windows");
  assert.equal(same.SystemRoot, undefined, "never a second spelling of a variable it has");
  assert.deepEqual(windowsChildEnvironment({ PATH: "/a:/a" }, { platform: "linux" }), { PATH: "/a:/a" }, "unchanged off Windows");
});

test("a long Windows PATH is capped, keeping its first (highest-priority) entries", () => {
  const entries = Array.from({ length: 2000 }, (_, index) => `C:\\some\\long\\directory\\number${index}`);
  const capped = compactWindowsPath(entries.join(";"));
  assert.ok(capped.length <= MAX_WINDOWS_PATH, `${capped.length} characters`);
  assert.ok(capped.startsWith(`${entries[0]};${entries[1]};`));
});

test("sandboxed commands on Windows carry the essential variables", async () => {
  const { sandbox, spawned, cleanup } = runner({ platform: "win32" });
  try {
    await sandbox.start({ cmd: "bash -lc ls", cwd: "G:/work", writable: "G:/work" });
    const [{ options }] = spawned;
    for (const name of ["SystemRoot", "windir", "ComSpec", "PATHEXT", "TEMP", "TMP"]) assert.ok(options.env[name], name);
    assert.equal(options.env.OPENAI_API_KEY, undefined, "credentials still stay out");
  } finally { cleanup(); }
});
