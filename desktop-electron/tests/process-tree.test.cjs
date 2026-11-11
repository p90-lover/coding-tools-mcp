const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const test = require("node:test");
const { processRunning, terminateOwnedProcessTreeAsync } = require("../electron/process-tree.cjs");

test("an owned Windows process tree is ended without blocking the main thread", {
  skip: process.platform !== "win32",
}, async () => {
  // The synchronous form waited on taskkill (up to two 10 s runs) on the app's main thread.
  // A parent that starts a grandchild, so the whole tree has to go.
  const parent = spawn(process.execPath, ["-e", [
    'const { spawn } = require("node:child_process");',
    'const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });',
    'process.stdout.write(String(child.pid) + "\\n");',
    'setInterval(() => {}, 1000);',
  ].join("\n")], { stdio: ["ignore", "pipe", "ignore"], windowsHide: true });
  const grandchild = await new Promise((resolve) => parent.stdout.once("data", (chunk) => resolve(Number(String(chunk).trim()))));
  assert.ok(processRunning(parent.pid) && processRunning(grandchild));
  let ticks = 0;
  const ticker = setInterval(() => { ticks += 1; }, 5);
  try {
    const ending = terminateOwnedProcessTreeAsync(parent);
    assert.ok(ending instanceof Promise);
    await ending;
    await new Promise((resolve) => (parent.exitCode !== null || parent.signalCode !== null ? resolve() : parent.once("exit", resolve)));
    assert.ok(ticks > 0, "timers kept running while taskkill ran");
    assert.equal(processRunning(parent.pid), false);
    const deadline = Date.now() + 5_000;
    while (processRunning(grandchild) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(processRunning(grandchild), false, "the grandchild went with it");
    // An exited child is left alone.
    await terminateOwnedProcessTreeAsync(parent);
  } finally {
    clearInterval(ticker);
    for (const pid of [parent.pid, grandchild]) { try { if (processRunning(pid)) process.kill(pid); } catch {} }
  }
});


// 2026-11-11 08:33:11Z: execFile("taskkill.exe") held the main process 88.5 s on the busy machine.
test("the async tree kill starts taskkill from a worker, never from the calling thread", {
  skip: process.platform !== "win32",
}, async () => {
  const childProcess = require("node:child_process");
  const parent = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore", windowsHide: true });
  await new Promise((resolve) => parent.once("spawn", resolve));
  const modules = ["../electron/process-tree.cjs", "../electron/off-thread-run.cjs"].map((name) => require.resolve(name));
  const saved = modules.map((file) => require.cache[file]);
  const originals = { execFile: childProcess.execFile, spawn: childProcess.spawn, spawnSync: childProcess.spawnSync };
  const here = [];
  for (const name of Object.keys(originals)) {
    childProcess[name] = (file, ...rest) => { here.push(`${name} ${file}`); return originals[name](file, ...rest); };
  }
  try {
    for (const file of modules) delete require.cache[file];
    const fresh = require("../electron/process-tree.cjs");
    await fresh.terminateOwnedProcessTreeAsync(parent);
    await new Promise((resolve) => (parent.exitCode !== null || parent.signalCode !== null ? resolve() : parent.once("exit", resolve)));
    assert.equal(processRunning(parent.pid), false);
    assert.deepEqual(here.filter((call) => /taskkill/i.test(call)), [], "taskkill was not started on this thread");
  } finally {
    Object.assign(childProcess, originals);
    modules.forEach((file, index) => { if (saved[index]) require.cache[file] = saved[index]; else delete require.cache[file]; });
    try { if (processRunning(parent.pid)) process.kill(parent.pid); } catch {}
  }
});
