const assert = require("node:assert/strict");
const { ChildProcess } = require("node:child_process");
const path = require("node:path");
const test = require("node:test");
const { runBrowserHelperOperation } = require("../electron/browser-helper-verifier.cjs");
const { processRunning, terminateOwnedProcessTree } = require("../electron/process-tree.cjs");

test("Windows verification cleans up its owned helper when Node termination is refused", {
  skip: process.platform !== "win32",
}, async () => {
  const script = path.resolve(__dirname, "../../aiTemp/browser-helper-ignore-shutdown.cjs");
  const originalKill = ChildProcess.prototype.kill;
  let refusedPid = 0;
  ChildProcess.prototype.kill = function (signal) {
    if (signal === "SIGTERM" && this.spawnargs?.includes(script)) {
      refusedPid = this.pid;
      return false;
    }
    return originalKill.call(this, signal);
  };
  try {
    const result = await runBrowserHelperOperation({
      helper: { executable: process.execPath, script },
      descriptorPath: "C:/test/launcher-browser.json",
      appName: "Test connector",
      operation: "verify",
    });
    assert.equal(result.text, "ready");
    assert.equal(processRunning(result.pid), false);
  } finally {
    ChildProcess.prototype.kill = originalKill;
    if (refusedPid && processRunning(refusedPid)) {
      terminateOwnedProcessTree({ pid: refusedPid, exitCode: null, signalCode: null });
    }
  }
});
