"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const ts = require(require.resolve("typescript", { paths: [path.resolve(__dirname, "..")] }));

const source = fs.readFileSync(path.resolve(__dirname, "../src/features/ao-chat.ts"), "utf8");
const pet = {};
vm.runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText, { exports: pet });

test("the pet's mood follows the chat: a waiting request first, then a running turn, then how the last one ended", () => {
  assert.equal(pet.petMood({ asking: true, running: true, lastStatus: "running" }), "ask", "a request waiting on you wins");
  assert.equal(pet.petMood({ asking: false, running: true, lastStatus: "done" }), "working");
  assert.equal(pet.petMood({ asking: false, running: false, lastStatus: "done" }), "done");
  assert.equal(pet.petMood({ asking: false, running: false, lastStatus: "attention" }), "error");
  assert.equal(pet.petMood({ asking: false, running: false, lastStatus: "stopped", lastFailed: true }), "error", "a failed step frets even when stopped");
  assert.equal(pet.petMood({ asking: false, running: false, lastStatus: "stopped" }), "idle");
  assert.equal(pet.petMood({ asking: false, running: false }), "idle", "a chat with no turn yet");
});
