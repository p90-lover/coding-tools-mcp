const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const test = require("node:test");
const ts = require("typescript");

test("runtime upgrade waits for the saved-session refresh to release the browser", async () => {
  const source = fs.readFileSync(process.env.CODEX_STARTUP_SOURCE || path.join(__dirname, "../electron/main.cjs"), "utf8");
  const file = ts.createSourceFile("main.cjs", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  let startup;
  function visit(node) {
    if (ts.isArrowFunction(node) && node.body.getText(file).includes("const upgrade = await runtimeHost.upgradeManagedRuntime()")) startup = node;
    ts.forEachChild(node, visit);
  }
  visit(file);
  assert(startup, "production startup callback exists");
  const events = [];
  let finishRefresh;
  const startupAuthenticationRefresh = new Promise(resolve => { finishRefresh = resolve; });
  const stop = new Error("Stop after testing upgrade entry");
  const start = vm.runInNewContext(`(${startup.getText(file)})`, {
    startupAuthenticationRefresh,
    runtimeHost: { upgradeManagedRuntime: async () => { events.push("upgrade"); throw stop; } },
  });
  const result = start().catch(error => error);
  await Promise.resolve();
  assert.deepEqual(events, [], "upgrade must not inspect a busy authentication surface");
  finishRefresh({ authenticated: true });
  assert.equal(await result, stop);
  assert.deepEqual(events, ["upgrade"]);
});
