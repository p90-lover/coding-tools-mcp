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

const petSource = fs.readFileSync(path.resolve(__dirname, "../src/features/ChatPet.tsx"), "utf8");
const petFile = ts.createSourceFile("ChatPet.tsx", petSource, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const petBody = petFile.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === "PetBody");

function petTimers() {
  const declarations = {}, callbacks = {};
  let cleanup;
  const visit = node => {
    if (ts.isVariableDeclaration(node)) declarations[node.name.getText(petFile)] = node.getText(petFile);
    if (ts.isJsxAttribute(node) && node.name.getText(petFile) === "onDoubleClick") callbacks.feed = node.initializer.expression.getText(petFile);
    if (ts.isCallExpression(node) && node.expression.getText(petFile) === "useEffect" && ts.isArrowFunction(node.arguments[0])
      && ts.isArrowFunction(node.arguments[0].body)) cleanup = node.arguments[0].body.getText(petFile);
    ts.forEachChild(node, visit);
  };
  visit(petBody); assert(cleanup && callbacks.feed);
  const timers = new Map(), plans = { current: [] }; let now = 0, nextId = 0, floaters = [], remembered = 0;
  const ref = current => ({ current });
  const context = { exports: {}, useRef: ref, Number, Math, WIDTH: 72, REST: {}, NAP_MS: 45000, fed: 0,
    window: { setTimeout(fn, ms) { const id = ++nextId; timers.set(id, { fn, at: now + ms }); return id; }, clearTimeout(id) { timers.delete(id); } },
    plans, seq: ref(0), rideTimer: ref(), clickTimer: ref(), bubbleTimer: ref(), napTimer: ref(), fallTimer: ref(), doorTimer: ref(), leapTimer: ref(), dragEnd: ref(null),
    rideNow: ref({ mode: "riding", x: 100, y: 100 }), loopNow: ref({ width: 600 }), composer: ref({ getBoundingClientRect: () => ({ left: 0 }) }),
    pointer: ref({ x: 100 }), atNow: ref(100), moodNow: ref("idle"), drag: ref(null), still: false,
    cancelTransitionFrame() {}, freeNear: value => value, nearLap: (_, value) => value, screenAt: x => ({ x, y: 0 }),
    setPose() {}, setAt() {}, setRide() {}, play() {}, wake() {}, setFed() {}, say() {}, setJob() {},
    remember() { remembered++; }, setFloaters(update) { floaters = update(floaters); },
    busyElsewhere: () => true, nextSpot: () => 0, walkTo() {}, act() {}, goHome() {},
    cancelPlans() { plans.current.forEach(id => timers.delete(id)); plans.current = []; },
  };
  const names = ["decorationTimers", "afterDecoration", "later", "float", "poke", "wander", "leave"];
  const code = names.filter(name => declarations[name]).map(name => `const ${declarations[name]};`).join("\n")
    + `\nexports.float = float; exports.leave = leave; exports.cleanup = ${cleanup}; exports.feed = ${callbacks.feed};`;
  vm.runInNewContext(ts.transpileModule(code, { compilerOptions: { target: ts.ScriptTarget.ES2020 } }).outputText, context);
  return { ...context.exports, cancelPlans: context.cancelPlans,
    advance(ms) { const until = now + ms; let turns = 0;
      for (;;) { const entry = [...timers].filter(([, timer]) => timer.at <= until).sort((a, b) => a[1].at - b[1].at)[0];
        if (!entry) break; assert(++turns < 100, "bounded fake clock"); timers.delete(entry[0]); now = entry[1].at; entry[1].fn(); }
      now = until;
    },
    get pending() { return timers.size; }, get floaters() { return floaters.length; }, get remembered() { return remembered; },
  };
}

test("hidden chat pages do not mount the pet's decorative subtree", () => {
  const React = require("react"), { renderToStaticMarkup } = require("react-dom/server"), cache = {};
  const load = name => {
    if (cache[name]) return cache[name];
    const exports = cache[name] = {};
    const source = fs.readFileSync(path.resolve(__dirname, "../src/features", name), "utf8");
    vm.runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, jsx: ts.JsxEmit.ReactJSX } }).outputText,
      { exports, require: name => name === "react" ? React : name === "react-dom" ? require("react-dom") : name === "react/jsx-runtime" ? require("react/jsx-runtime")
        : load(name.slice(2) + (fs.existsSync(path.resolve(__dirname, "../src/features", name.slice(2) + ".tsx")) ? ".tsx" : ".ts")) });
    return exports;
  };
  const { ChatPet } = load("ChatPet.tsx"), { SurfaceHiddenContext } = load("page-visibility.ts");
  const render = hidden => renderToStaticMarkup(React.createElement(SurfaceHiddenContext.Provider, { value: hidden },
    React.createElement(ChatPet, { mood: "working", context: null, onHide() {} })));
  assert.match(render(false), /Bit the pet/); assert.equal(render(true), ""); assert.match(render(false), /Bit the pet/);
});

for (const action of ["leave", "float", "feed"]) test(`pet ${action} callbacks cannot recreate work after teardown`, () => {
  const pet = petTimers(); pet[action]("fixture"); assert(pet.pending > 0);
  pet.cleanup(); assert.equal(pet.pending, 0);
  pet.advance(5000); assert.equal(pet.pending, 0); assert.equal(pet.remembered, 0);
});

test("mood-plan cancellation does not strand temporary pet floaters", () => {
  const pet = petTimers(); pet.float("fixture"); assert.equal(pet.floaters, 1);
  pet.cancelPlans(); pet.advance(1100); assert.equal(pet.floaters, 0); assert.equal(pet.pending, 0); pet.cleanup();
});

test("a visible pet still completes its pointer return before teardown", () => {
  const pet = petTimers(); pet.leave(); pet.advance(480);
  assert.equal(pet.remembered, 1); assert(pet.pending > 0, "normal nap/wander resume");
  pet.cleanup(); assert.equal(pet.pending, 0);
});

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

test("the pet's flight tells the Preview pane where it is, once per move, and when it lands", () => {
  const flight = stage.createPetFlight();
  const seen = [];
  const stop = flight.subscribe((rect) => seen.push(rect && rect.left));
  flight.set({ left: 10, top: 10, right: 82, bottom: 58 });
  flight.set({ left: 10, top: 10, right: 82, bottom: 58 });
  flight.set({ left: 20, top: 10, right: 92, bottom: 58 });
  flight.set(null);
  stop();
  flight.set({ left: 30, top: 10, right: 102, bottom: 58 });
  assert.deepEqual(seen, [10, 20, null], "the same box twice is one move; after unsubscribing nothing");
  const pane = { left: 200, top: 100, right: 600, bottom: 500 };
  assert.equal(stage.petOverlaps({ left: 150, top: 120, right: 199, bottom: 160 }, pane), false);
  assert.equal(stage.petOverlaps({ left: 150, top: 120, right: 199, bottom: 160 }, pane, 48), true, "near enough to swap in the still");
  assert.equal(stage.petOverlaps({ left: 300, top: 200, right: 372, bottom: 248 }, pane), true);
});
