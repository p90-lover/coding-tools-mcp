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

const stageSource = fs.readFileSync(path.resolve(__dirname, "../src/features/chat-pet-stage.ts"), "utf8");
const stage = {};
vm.runInNewContext(ts.transpileModule(stageSource, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText,
  { exports: stage, Date });

const motionSource = fs.readFileSync(path.resolve(__dirname, "../src/features/chat-pet-motion.ts"), "utf8");
const motion = {};
vm.runInNewContext(ts.transpileModule(motionSource, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText,
  { exports: motion, Number, Math });

test("Clawd reverses toward a destination moved behind it when the chat box resizes", () => {
  const first = motion.advancePetWalk(100, 180, 12);
  assert.equal(first.position, 112);
  assert.equal(first.direction, 1);
  assert.equal(first.arrived, false);
  const resized = motion.advancePetWalk(first.position, 90, 12);
  assert.equal(resized.position, 100);
  assert.equal(resized.direction, -1);
  assert.equal(resized.arrived, false);
  const final = motion.advancePetWalk(resized.position, 90, 20);
  assert.equal(final.position, 90, "the walk stops exactly on its destination, without overshooting");
  assert.equal(final.arrived, true);
});

test("Clawd finishes a zero-distance walk instead of scheduling endless frames", () => {
  const result = motion.advancePetWalk(42, 42, 10);
  assert.equal(result.position, 42);
  assert.equal(result.direction, 0);
  assert.equal(result.arrived, true);
});

test("Clawd keeps the laptop and other work props inward on both sides of the composer", () => {
  assert.equal(motion.petToolSide(50, 600), "right", "a pet near the left edge needs its laptop on the right");
  assert.equal(motion.petToolSide(550, 600), "left", "a pet near the right edge needs its laptop on the left");
  assert.equal(motion.petToolSide(300, 600), "left");
});

test("split view has one pet: it stays in its pane while that stays open, else goes to the focused pane", () => {
  assert.equal(stage.petHost(null, [], null), null);
  assert.equal(stage.petHost(null, ["a", "b"], null), "a");
  assert.equal(stage.petHost(null, ["a", "b"], "b"), "b", "a new split starts in the pane you are in");
  assert.equal(stage.petHost("a", ["a", "b"], "b"), "a", "clicking into another pane does not move it by itself");
  assert.equal(stage.petHost("c", ["a", "b"], "b"), "b", "its pane closed: it moves to the focused one");
});

test("another pane's chat calls the pet over for a request always, a finished turn usually, a failure sometimes", () => {
  assert.equal(stage.petCall("ask", "working", 0.99), "Over here!");
  assert.equal(stage.petCall("done", "working", 0.1), "Done next door!");
  assert.equal(stage.petCall("done", "working", 0.9), null);
  assert.equal(stage.petCall("error", "working", 0.2), "There, there.");
  assert.equal(stage.petCall("error", "working", 0.7), null);
  assert.equal(stage.petCall("working", "idle", 0), null, "starting work does not call it");
  assert.equal(stage.petCall("ask", "ask", 0), null, "no change, no call");
});

test("the stage hands the pet from pane to pane and tells the others what changed", () => {
  let clock = 1000;
  const stage1 = stage.createPetStage(() => clock);
  const events = [];
  stage1.subscribe((event) => events.push(event.kind === "host" ? "host" : `${event.kind}:${event.pane}${event.mood ? `:${event.was}>${event.mood}` : ""}`));
  stage1.focus("b");
  stage1.seat("a", { composer: {}, mood: "idle" });
  assert.equal(stage1.host(), "a", "the only seat hosts it");
  // Seen in a harness: reopening a split seated another pane's box before the focused one's, and
  // the pet started in that other pane.
  stage1.seat("b", { composer: {}, mood: "working" });
  assert.equal(stage1.host(), "b", "the focused pane's box joining right after takes it");
  clock += 2000;
  stage1.seat("c", { composer: {}, mood: "idle" });
  stage1.focus("c");
  assert.equal(stage1.host(), "b", "later, neither a new pane nor a click into one takes it by itself");
  stage1.seat("b", { composer: {}, mood: "ask" });
  stage1.seat("c", { composer: {}, mood: "idle" });
  assert.deepEqual(events, ["focus:b", "host", "host", "focus:c", "mood:b:working>ask"], "a pane's first seat and an unchanged mood send no mood event");

  assert.equal(stage1.handoff("b", { x: 10, carry: false, line: "" }), false, "it is already there");
  assert.equal(stage1.handoff("z", { x: 10, carry: false, line: "" }), false, "no such pane");
  assert.equal(stage1.handoff("a", { x: 40, carry: true, line: "Delivery!" }), true);
  assert.equal(stage1.host(), "a");
  assert.deepEqual({ ...stage1.arrivalFor("a") }, { x: 40, carry: true, line: "Delivery!" });
  assert.equal(stage1.arrivalFor("b"), null, "only the pane it leapt to");
  clock += 5000;
  assert.equal(stage1.arrivalFor("a"), null, "a stale landing does not place a pet that mounts later");

  stage1.leave("a");
  assert.equal(stage1.host(), "c", "its pane closed: to the focused one");
  stage1.leave("c");
  assert.equal(stage1.host(), "b", "else the one left");
  stage1.leave("b");
  assert.equal(stage1.host(), null);
});
