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

test("Clawd's house goes in the yard under its own page's chat list, not a hidden page's", () => {
  // Seen 2026-11-09 on page 2 of a split chat: page 1's surface stays mounted while hidden, chat list
  // and yard included, and the whole-document lookup found that yard (0 px wide), so the house stood
  // on a pane's chat box over its last messages instead of under the list, above Settings.
  const yardOf = (name) => ({ name });
  const page = (name) => ({ querySelector: (selector) => selector === stage.PET_YARD ? yardOf(name) : null });
  const doc = page("first page in the document");
  const inPage2 = { closest: (selector) => selector === ".cx-chat-page" ? page("page 2") : null, ownerDocument: doc };
  assert.equal(stage.findPetYard(inPage2).name, "page 2");
  const noPages = { closest: () => null, ownerDocument: doc };
  assert.equal(stage.findPetYard(noPages).name, "first page in the document", "without chat pages: the document's");
  assert.equal(stage.findPetYard(null), null);
  const petSource = fs.readFileSync(path.resolve(__dirname, "../src/features/ChatPet.tsx"), "utf8");
  assert.match(petSource, /findPetYard<HTMLElement>\(box\.current\)/);
  assert.doesNotMatch(petSource, /document\.querySelector<HTMLElement>\(YARD\)/);
  // With the chat list hidden there is no house in split view: Clawd naps on its box.
  assert.match(petSource, /: loop && !split \? rooms\(housePlace\(loop\), null\) : null;/);
  assert.match(petSource, /if \(split && !yardNow\.current\) \{ if \(nap\) napHere\(\); return; \}/);
});

test("a leap arcs clear of both ends, even between two boxes at one height", () => {
  // Between split panes (and from the box to the house under the list) both ends are about level:
  // the old curve rose only by the drop between them, so the leap was a flat slide.
  const level = motion.petLeap({ x: 300, y: 700 }, { x: 1300, y: 700 });
  assert(level.arc >= 120, `a long level leap arcs high (${level.arc} px)`);
  assert(level.ms >= 800 && level.ms <= 950, `and takes under a second (${level.ms} ms)`);
  const short = motion.petLeap({ x: 300, y: 700 }, { x: 380, y: 700 });
  assert(short.arc >= 36 && short.ms >= 420, "a short hop still hops");
  const up = motion.petLeap({ x: 200, y: 900 }, { x: 260, y: 600 });
  assert(up.arc - 300 / 2 >= 28, "up onto a higher spot it rises past it");
  assert.deepEqual({ ...motion.petLeap({ x: 0, y: 0 }, { x: Number.NaN, y: 0 }) }, { ms: 0, arc: 0 });
});

test("Clawd's porch is in front of its house, as far into the yard as it fits whole", () => {
  // The yard under a 288 px chat list is 272 px wide; the house is 160 px and Clawd 72 px.
  const porch = motion.petPorchX(272, 160, 72, 104);
  assert.equal(porch, 178);
  assert(porch + 72 / 2 <= 160 + (272 - 160) / 2, "all of Clawd stays inside the yard (the list clips it)");
  assert.equal(motion.petPorchX(160, 160, 72, 104), 122, "no room beside the house: in front of its right side");
  assert.equal(motion.petPorchX(Number.NaN, 160, 72, 104), 122);
  assert.equal(motion.petPorchX(100, 160, 72, 130), 130, "never inside the entry");
});

test("every way out of the house walks out the way it came; only a drag lifts Clawd straight out", () => {
  // The user (2026-11-09): "when its in its house, then it try to goes out, it just straight teleport
  // to the platform instead of walking to platform". A turn starting, or another pane calling, popped
  // it from wherever it was in the house (in bed, upstairs) onto the box at full size in one frame.
  const source = fs.readFileSync(path.resolve(__dirname, "../src/features/ChatPet.tsx"), "utf8");
  const calls = [...source.matchAll(/leaveHome\(false\)/g)];
  assert.equal(calls.length, 1, "leaveHome(false) has one caller");
  const dragMove = source.slice(source.indexOf("const dragMove ="), source.indexOf("const dragDrop ="));
  assert.match(dragMove, /leaveHome\(false\)/, "and it is the drag");
  const goOut = source.slice(source.indexOf("const goOut ="), source.indexOf("const leaveHome ="));
  assert.match(goOut, /homeRun\(exitBeats\(homePlace\(\)\)/, "goOut climbs out of bed and down the ladder first");
  const moodEffect = source.slice(source.indexOf("// React to the agent"), source.indexOf("// Split view: another pane's chat calls it over"));
  assert.match(moodEffect, /if \(homeNow\.current \|\| doorNow\.current \|\| doorWay\.current\) goOut\(\);/);
  const calledOver = source.slice(source.indexOf("// Split view: another pane's chat calls it over"), source.indexOf("const full ="));
  assert.match(calledOver, /goOut\(event\.pane\)/);
  const wake = source.slice(source.indexOf("const wake = () =>"), source.indexOf("/** Feet on the box at"));
  assert.match(wake, /if \(homeNow\.current\) goOut\(\);/);
  // Out of the house under the list it walks onto the porch (growing to full size) before it leaps;
  // in, it lands on the porch and walks in (shrinking) before it is inside.
  const leaveHome = source.slice(source.indexOf("const leaveHome ="), source.indexOf("const leapOut ="));
  assert.match(leaveHome, /setDoor\(true\);[\s\S]*doorTimer\.current = window\.setTimeout\(leapOut, still \? 0 : DOOR_MS\);/);
  assert.match(source, /const onPorch = yard && door && !home/);
  // From the doorstep beside the box it steps up onto the box's side instead of being put there.
  assert.match(leaveHome, /setGlide\(true\);[\s\S]*window\.setTimeout\(walkOn, STEP_MS\)/);
});
