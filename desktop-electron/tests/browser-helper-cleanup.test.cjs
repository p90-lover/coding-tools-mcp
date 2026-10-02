const assert = require("node:assert/strict");
const { ChildProcess } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { runBrowserHelperOperation } = require("../electron/browser-helper-verifier.cjs");
const { processRunning, terminateOwnedProcessTree } = require("../electron/process-tree.cjs");

test("Windows verification cleans up its owned helper when Node termination is refused", {
  skip: process.platform !== "win32",
}, async () => {
  // A helper that answers one verification and then ignores every shutdown request, so cleanup
  // has to fall back to ending its process tree. Written here so the test needs no local fixture.
  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "browser-helper-ignore-shutdown-"));
  const script = path.join(fixtureRoot, "browser-helper-ignore-shutdown.cjs");
  fs.writeFileSync(script, [
    'process.on("SIGTERM", () => {});',
    'process.stdin.on("end", () => {});',
    'setInterval(() => {}, 1000);',
    'let buffered = "";',
    'process.stdin.on("data", (chunk) => {',
    '  buffered += chunk;',
    '  const end = buffered.indexOf("\\n");',
    '  if (end < 0) return;',
    '  const request = JSON.parse(buffered.slice(0, end));',
    '  process.stdout.write(JSON.stringify({ type: "result", id: request.id, text: "ready", pid: process.pid }) + "\\n");',
    '});',
    'process.stdout.write(JSON.stringify({ type: "ready" }) + "\\n");',
  ].join("\n"));
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
    fs.rmSync(fixtureRoot, { recursive: true, force: true });
  }
});
