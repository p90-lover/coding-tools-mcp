const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const ts = require("typescript");
function fixture() {
  const exports = {};
  let tick, cleared = 0;
  vm.runInNewContext(ts.transpileModule(fs.readFileSync(path.join(__dirname, "../src/features/ChatGptBrowserManagement.tsx"), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
  }).outputText, { exports, require: () => ({}), window: {
    setInterval: callback => { tick = callback; return 0; }, clearInterval: () => { cleared++; },
  } });
  return { start: exports.startBrowserThreadPoll, tick: () => tick(), cleared: () => cleared };
}

test("session inventory reads coalesce and late replies cannot overwrite a replaced management page", async () => {
  const poll = fixture(), published = [];
  let calls = 0, finish;
  const stop = poll.start(() => { calls++; return new Promise(resolve => { finish = resolve; }); }, value => published.push(value), 15000);
  for (let i = 0; i < 20; i++) poll.tick();
  assert.equal(calls, 1);
  stop();
  finish({ threads: [{ threadId: "old-account" }] });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(published, []);
  poll.tick();
  assert.equal(calls, 1);
  assert.equal(poll.cleared(), 1, "clear interval even when its ID is zero");
});

test("a failed session inventory read retries and publishes only the next successful response", async () => {
  const poll = fixture(), published = [];
  let calls = 0;
  const stop = poll.start(async () => {
    if (++calls === 1) throw new Error("temporarily unavailable");
    return { threads: [{ threadId: "current-account", tokensUsed: 42 }] };
  }, value => published.push(value), 15000);
  await new Promise(resolve => setImmediate(resolve));
  poll.tick();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls, 2);
  assert.equal(published[0][0].tokensUsed, 42);
  stop();
});
