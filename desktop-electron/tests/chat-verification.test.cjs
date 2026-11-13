"use strict";
require("./support/temp-dirs.cjs");
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { verificationSpec, fingerprintInputs, prepareVerification, observeVerification, verificationReceipt } = require("../electron/chat-verification.cjs");

async function world(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "verification-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.writeFile(path.join(root, "source.cjs"), "module.exports = 1;\n");
  const args = { cmd: "node --test focused.test.cjs", verification: { inputs: ["source.cjs"], context: "node-test-env" } };
  return { root, args, commands: new Map() };
}

test("verification receipt reuses only actually passed unchanged declared inputs", async t => {
  const { root, args, commands } = await world(t);
  const record = await prepareVerification(root, args, commands, 100);
  await observeVerification(record, { status: "running", exit_code: 0 }, 110);
  assert.equal(record.outcome, "running");
  await observeVerification(record, { status: "exited", exit_code: 0 }, 120);
  commands.set("check-1", { id: "check-1", verification: record });
  const repeated = await prepareVerification(root, args, commands, 130);
  assert.equal(repeated.duplicateOf, "check-1");
  const receipt = await verificationReceipt(record, 140, true);
  assert.equal(receipt.outcome, "passed");
  assert.equal(receipt.input_status, "unchanged");
  assert.equal(receipt.elapsed_ms, 20);
  assert.equal(receipt.advisory_only, true);
  assert.match(receipt.scope_note, /undeclared dependencies/);
  await fs.writeFile(path.join(root, "source.cjs"), "module.exports = 2;\n");
  assert.equal((await verificationReceipt(record, 150, true)).input_status, "changed");
  assert.equal((await prepareVerification(root, args, commands, 160)).duplicateOf, null);
  await fs.unlink(path.join(root, "source.cjs"));
  assert.equal((await verificationReceipt(record, 170, true)).input_status, "unavailable");
});

test("verification receipt rejects false passes and changed-during-check evidence", async t => {
  const { root, args } = await world(t);
  for (const value of [{ status: "exited", exit_code: 1 }, { status: "failed", exit_code: 0 }, { status: "exited", exit_code: 0, termination_reason: "killed" },
    { status: "exited", exit_code: 0, command_ok: false }, { status: "exited", exit_code: null }]) {
    const record = await prepareVerification(root, args, new Map(), 1);
    await observeVerification(record, value, 2);
    assert.notEqual(record.outcome, "passed");
  }
  const record = await prepareVerification(root, args, new Map(), 1);
  await observeVerification(record, { ok: true }, 2);
  assert.equal(record.outcome, "running", "transport success is not process success");
  await fs.writeFile(path.join(root, "source.cjs"), "changed");
  await observeVerification(record, { status: "exited", exit_code: 0 }, 3);
  assert.equal(record.scope, "changed");
  const commands = new Map([["old", { id: "old", verification: record }]]);
  assert.equal((await prepareVerification(root, args, commands, 4)).duplicateOf, null);
});

test("verification scope is bounded, canonical and does not accept path escapes", async t => {
  const { root } = await world(t);
  for (const inputs of [[], Array(17).fill("a"), ["../private"], ["C:\\private"], ["source.cjs:stream"], ["source.cjs", "source.cjs"], ["dir/../private"], ["source.cjs."]]) {
    assert.throws(() => verificationSpec({ inputs }));
  }
  assert.throws(() => verificationSpec({ inputs: ["source.cjs"], context: "a".repeat(257) }));
  const spec = verificationSpec({ inputs: ["source.cjs"] });
  assert.equal((await fingerprintInputs(root, spec)).length, 64);
  await fs.writeFile(path.join(root, "large"), Buffer.alloc(2 * 1024 * 1024 + 1));
  await assert.rejects(fingerprintInputs(root, verificationSpec({ inputs: ["large"] })), /2 MiB/);
  await assert.rejects(fingerprintInputs(root, verificationSpec({ inputs: ["missing"] })));
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), "verification-outside-"));
  t.after(() => fs.rm(outside, { recursive: true, force: true }));
  await fs.writeFile(path.join(outside, "secret"), "not in scope");
  await fs.symlink(outside, path.join(root, "link"), process.platform === "win32" ? "junction" : "dir");
  await assert.rejects(fingerprintInputs(root, verificationSpec({ inputs: ["link/secret"] })), /outside the workspace/);
});
