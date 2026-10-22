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
