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
vm.runInNewContext(ts.transpileModule(motionSource, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText,
  { exports: motion, Number, Math });

const petSource = fs.readFileSync(path.resolve(__dirname, "../src/features/ChatPet.tsx"), "utf8");
const petFile = ts.createSourceFile("ChatPet.tsx", petSource, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const petBody = petFile.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === "PetBody");
/** The source of one of PetBody's own functions, from its declaration to the next one's. */
const petPart = (name, next) => petSource.slice(petSource.indexOf(`const ${name} =`), petSource.indexOf(`const ${next} =`));

/**
 * PetBody's own timers, frame clock, leap, landing, walk and teardown, run as written against a fake
 * clock that also drives requestAnimationFrame (`jitter` makes frames arrive late, as in a busy window).
 * With `refresh` (ms), frames come only on a screen's refreshes, and timers run up to `late` ms late,
 * as Windows' do; `paints` lists when Clawd was drawn.
 */
function petTimers({ jitter = 0, refresh = 0, late = 0 } = {}) {
  const declarations = {};
  let cleanup, feed;
  for (const statement of petBody.body.statements) {
    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name)) declarations[declaration.name.text] = declaration.getText(petFile);
      }
    }
    const call = ts.isExpressionStatement(statement) && ts.isCallExpression(statement.expression) ? statement.expression : null;
    if (call && call.expression.getText(petFile) === "useEffect" && ts.isArrowFunction(call.arguments[0]) && ts.isArrowFunction(call.arguments[0].body)) {
      cleanup = call.arguments[0].body.getText(petFile);
    }
  }
  const visit = node => {
    if (ts.isJsxAttribute(node) && node.name.getText(petFile) === "onDoubleClick") feed = node.initializer.expression.getText(petFile);
    ts.forEachChild(node, visit);
  };
  visit(petBody);
  assert(cleanup && feed, "the unmount cleanup and the feed handler");
  const timers = new Map();
  let now = 0, nextId = 0, floaters = [], remembered = 0, landings = 0, roll = 0.37;
  const poses = [], paints = [];
  const random = () => { roll = (roll * 9301 + 0.49297) % 1; return roll; };
  const timer = (fn, ms) => { const id = ++nextId; timers.set(id, { fn, at: now + Math.max(0, ms || 0) }); return id; };
  // The next refresh strictly after now (a frame never comes in the refresh it was asked for in).
  const nextRefresh = () => (Math.round(now / refresh) + (Math.round(now / refresh) * refresh > now + 1e-6 ? 0 : 1)) * refresh;
  const frame = fn => refresh ? timer(() => fn(now), nextRefresh() - now) : timer(() => fn(now), 4 + (jitter ? random() * jitter : 0));
  const ref = current => ({ current });
  const context = {
    exports: {}, Number, Math, Set,
    ...motion,
    useRef: ref,
    window: { setTimeout: (fn, ms) => timer(fn, (ms || 0) + (late ? random() * late : 0)), clearTimeout: id => timers.delete(id),
      requestAnimationFrame: frame, cancelAnimationFrame: id => timers.delete(id) },
    performance: { now: () => now },
    WIDTH: 72, HEIGHT: 48, FEET: 40, FPS: 60, CROUCH_MS: 110, LAND_MS: 320, TURN_MS: 140, BOB: 2, NAP_MS: 45000, REST: {}, still: false, fed: 0,
    clamp: (value, low, high) => Math.max(low, Math.min(high, value)),
    el: ref({ style: { set transform(value) { paints.push(now); } } }), body: ref(null), lot: ref(null),
    composer: ref({ getBoundingClientRect: () => ({ left: 0, top: 600 }), clientLeft: 0, clientTop: 0 }),
    boxNow: ref({ width: 600, height: 90, room: false }), moodNow: ref("idle"), asleepNow: ref(false), pointer: ref({ x: 300, y: 400 }),
    petFlight: { set() {} },
    setSpace() {}, setRiding() {}, setJob() {}, setFace() {}, setAirborne() {}, setFed() {}, setBubble() {}, setFoot() {},
    setPose(pose) { poses.push(typeof pose === "function" ? "update" : JSON.parse(JSON.stringify(pose))); },
    setLanded(value) { if (typeof value !== "function") landings++; },
    setFloaters(update) { floaters = update(floaters); },
    play() {}, wake() {}, act() {}, goHome() {}, nextSpot: () => null, restNear: x => x, remember() { remembered++; },
  };
  const names = ["decorationTimers", "plans", "seq", "motion", "frameId", "frameTimer", "lastFrame", "vsync", "direct", "feet", "shape", "spaceNow", "activity",
    "facing", "footNow", "drag", "dragEnd", "rideTimer", "clickTimer", "bubbleTimer", "napTimer", "wanderTimer", "later", "afterDecoration",
    "stopMotion", "cancelPlans", "say", "float", "busy", "paint", "rest", "moveTo", "toScreen", "onFrame", "schedule", "animate", "timed",
    "walkTo", "land", "leapTo", "poke", "wander", "leave"];
  for (const name of names) assert(declarations[name], `PetBody declares ${name}`);
  const code = names.map(name => `const ${declarations[name]};`).join("\n")
    + `\nexports.float = float; exports.leave = leave; exports.walkTo = walkTo; exports.cancelPlans = cancelPlans;`
    + `\nexports.cleanup = ${cleanup}; exports.feed = ${feed};`
    + `\nexports.ride = () => { activity.current = "ride"; spaceNow.current = "screen"; feet.current = { space: "screen", x: 300, y: 400 }; };`
    + `\nexports.stand = (x) => { activity.current = "box"; spaceNow.current = "box"; feet.current = { space: "box", x, y: 0 }; };`
    + `\nexports.state = () => ({ activity: activity.current, feet: { ...feet.current }, shape: { ...shape.current }, moving: motion.current !== null, facing: facing.current });`;
  vm.runInNewContext(ts.transpileModule(code, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, context);
  return { ...context.exports, poses, paints, state: () => JSON.parse(JSON.stringify(context.exports.state())),
    advance(ms) {
      const until = now + ms;
      let turns = 0;
      for (;;) {
        const entry = [...timers].filter(([, item]) => item.at <= until).sort((a, b) => a[1].at - b[1].at)[0];
        if (!entry) break;
        assert(++turns < 5000, "bounded fake clock");
        timers.delete(entry[0]);
        now = entry[1].at;
        entry[1].fn();
      }
      now = until;
    },
    get pending() { return timers.size; }, get floaters() { return floaters.length; }, get remembered() { return remembered; },
    get landings() { return landings; },
  };
}

test("hidden chat pages do not mount the pet's decorative subtree", () => {
  const React = require("react"), { renderToStaticMarkup } = require("react-dom/server"), cache = {};
  const load = name => {
    if (cache[name]) return cache[name];
    const exports = cache[name] = {};
    const source = fs.readFileSync(path.resolve(__dirname, "../src/features", name), "utf8");
    vm.runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText,
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
  const pet = petTimers();
  if (action === "leave") pet.ride();
  pet[action]("fixture"); assert(pet.pending > 0);
  pet.cleanup(); assert.equal(pet.pending, 0);
  pet.advance(5000); assert.equal(pet.pending, 0); assert.equal(pet.remembered, 0);
});

test("mood-plan cancellation does not strand temporary pet floaters", () => {
  const pet = petTimers(); pet.float("fixture"); assert.equal(pet.floaters, 1);
  pet.cancelPlans(); pet.advance(1100); assert.equal(pet.floaters, 0); assert.equal(pet.pending, 0); pet.cleanup();
});

test("off the pointer, Clawd leaps down onto its box and lands there, at rest, however late its frames come", () => {
  // The user (2026-11-10): "all clawd animation are broken and dumb when moving". Leaps were CSS
  // transitions racing timers: a busy window landed it before it arrived, or left it squashed mid-air.
  for (const jitter of [0, 45]) {
    const pet = petTimers({ jitter });
    pet.ride();
    pet.leave();
    pet.advance(400);
    const midway = pet.state();
    assert.equal(midway.activity, "travel", "still on its way");
    assert(midway.feet.y > 400 - 200 && midway.feet.y < 600 + 1, "in the air between the pointer and the box");
    pet.advance(1600);
    const after = pet.state();
    assert.deepEqual(after.feet, { space: "box", x: 300, y: 0 }, `on its box's top edge, right under where it left (jitter ${jitter})`);
    assert.deepEqual(after.shape, { sx: 1, sy: 1, bob: 0, shrink: 1, fade: 1 }, "nothing left squashed");
    assert.equal(after.activity, "box");
    assert.equal(after.moving, false, "the frame clock stops once nothing moves");
    assert.equal(pet.landings, 1, "one landing, with its dust");
    assert.equal(pet.remembered, 1);
    assert(pet.pending > 0, "its nap and wander timers are running again");
    pet.cleanup(); assert.equal(pet.pending, 0);
  }
});

test("a walk turns round first, then speeds up, strolls and stops exactly on its spot with its feet still", () => {
  const pet = petTimers({ jitter: 30 });
  pet.stand(400);
  pet.walkTo(120, 52);
  assert.deepEqual(pet.poses[0], { look: -1 }, "facing right, it turns left before it walks");
  assert.equal(pet.state().feet.x, 400, "and stays put while it turns");
  pet.advance(200);
  const xs = [];
  for (let step = 0; step < 400 && pet.state().moving; step += 1) { pet.advance(20); xs.push(pet.state().feet.x); }
  assert(xs.every((x, index) => index === 0 || x <= xs[index - 1]), "never a step back");
  const moves = xs.slice(1).map((x, index) => xs[index] - x);
  assert(moves[0] < Math.max(...moves) / 2, "it speeds up from a standstill");
  assert.equal(pet.state().feet.x, 120, "exactly on its spot");
  assert.equal(pet.state().shape.bob, 0, "its bob settles");
  assert.equal(pet.state().facing, -1);
  pet.cleanup();
});

test("Clawd is drawn every refresh of a 60 Hz screen, and no more than 60 times a second on a faster one", () => {
  // Measured offscreen 2026-11-10: the clock waited out each interval with a timer before asking for a
  // frame, and on a 60 Hz screen a timer running late missed the next refresh: frame gaps of 16 and
  // 33 ms (median 28), Clawd moving in fits at about 35 frames a second.
  const gaps = (refresh) => {
    const pet = petTimers({ refresh, late: 6 });
    pet.stand(100);
    pet.walkTo(500, 120);
    pet.advance(4500);
    assert.equal(pet.state().feet.x, 500, "it gets there");
    const drawn = pet.paints.slice(2);
    pet.cleanup();
    return drawn.slice(1).map((at, index) => at - drawn[index]);
  };
  const sixty = gaps(1000 / 60);
  assert(sixty.length > 100);
  assert(sixty.every((gap) => Math.abs(gap - 1000 / 60) < 0.01), `60 Hz: every refresh (longest gap ${Math.max(...sixty).toFixed(1)} ms)`);
  const fast = gaps(1000 / 165);
  assert(fast.every((gap) => gap >= 1000 / 60 - 4), `165 Hz: at most about 60 a second (shortest gap ${Math.min(...fast).toFixed(1)} ms)`);
  const median = [...fast].sort((a, b) => a - b)[Math.floor(fast.length / 2)];
  assert(median <= 1000 / 50, `165 Hz: still smooth (median gap ${median.toFixed(1)} ms)`);
});

test("a walk speeds up, strolls and slows down onto its spot, a short one never reaching full speed", () => {
  const plan = motion.walkPlan(100, 400, 52);
  const at = ms => motion.walkAt(plan, ms);
  assert.equal(at(0).x, 100);
  assert.equal(at(0).speed, 0, "from a standstill");
  assert(Math.abs(at(plan.ms / 2).speed - 52) < 1e-9, "strolling at full speed in the middle");
  let last = 100;
  for (let ms = 0; ms <= plan.ms; ms += 7) {
    const point = at(ms);
    assert(point.x >= last - 1e-9 && point.x <= 400, `never back, never past (${ms} ms)`);
    last = point.x;
  }
  assert(at(plan.ms - 10).speed < 5, "slowing down onto the spot");
  assert.deepEqual({ ...at(plan.ms) }, { x: 400, speed: 0, done: true });
  assert.equal(motion.walkAt(motion.walkPlan(400, 100, 52), 10_000).x, 100, "the other way too");
  const short = motion.walkPlan(100, 108, 52);
  assert(short.cruise < 52 && short.ms > 0, "a short walk never gets up to speed");
  assert(Math.abs(motion.walkAt(short, short.ms / 2).x - 104) < 0.01, "halfway at half its time");
  assert.equal(motion.walkPlan(42, 42, 52).ms, 0, "no walk to where it stands");
  assert.equal(motion.walkAt(motion.walkPlan(42, 42, 52), 0).done, true);
  assert.equal(motion.walkPlan(0, Number.NaN, 52).ms, 0);
});

test("its feet and bob follow the distance walked, so its feet never slide", () => {
  const { STRIDE, gaitAt } = motion;
  assert.equal(gaitAt(0).lift, 0, "both feet down where it starts");
  assert(Math.abs(gaitAt(STRIDE / 2).lift - 1) < 1e-9, "up at the middle of a stride");
  assert(gaitAt(STRIDE - 0.01).lift < 0.01, "and down again at its end");
  assert.notEqual(gaitAt(STRIDE * 0.5).left, gaitAt(STRIDE * 1.5).left, "the feet swap each stride");
  assert.equal(gaitAt(-STRIDE * 1.5).left, gaitAt(STRIDE * 1.5).left, "the same walking left");
  assert.deepEqual({ ...gaitAt(Number.NaN) }, { ...gaitAt(0) });
});

test("a leap rises from both ends, arcs higher the further it goes, and comes down onto its spot", () => {
  const level = motion.leapPlan({ x: 300, y: 700 }, { x: 1300, y: 700 });
  assert(level.arc >= 120, `a long level leap arcs high (${level.arc} px)`);
  assert(level.ms >= 800 && level.ms <= 950, `and takes under a second (${level.ms} ms)`);
  const short = motion.leapPlan({ x: 300, y: 700 }, { x: 380, y: 700 });
  assert(short.arc >= 36 && short.ms >= 380, "a short hop still hops");
  const up = motion.leapPlan({ x: 200, y: 900 }, { x: 260, y: 600 });
  let peak = Infinity;
  for (let ms = 0; ms <= up.ms; ms += 5) peak = Math.min(peak, motion.leapAt(up, ms).y);
  assert(peak <= 600 - 40, `up onto a higher spot it rises past it and comes down onto it (peak ${peak})`);
  for (const [from, to] of [[{ x: 0, y: 0 }, { x: 500, y: 300 }], [{ x: 0, y: 900 }, { x: 40, y: 100 }], [{ x: 0, y: 0 }, { x: -700, y: 0 }]]) {
    const plan = motion.leapPlan(from, to);
    assert.deepEqual([motion.leapAt(plan, 0).x, motion.leapAt(plan, 0).y], [from.x, from.y]);
    assert.deepEqual([motion.leapAt(plan, plan.ms).x, motion.leapAt(plan, plan.ms).y, motion.leapAt(plan, plan.ms).done], [to.x, to.y, true]);
    assert(motion.leapAt(plan, 5).y < from.y, "it takes off upward");
    assert(motion.leapAt(plan, plan.ms - 5).y < to.y, "and lands coming down");
  }
  assert.equal(motion.leapPlan({ x: 0, y: 0 }, { x: Number.NaN, y: 0 }).ms, 0);
});

test("let go, it falls under gravity, faster and faster, and lands harder the further it fell", () => {
  const from = { x: 100, y: 0 }, to = { x: 160, y: 400 };
  const plan = motion.fallPlan(from, to);
  assert(Math.abs(plan.ms - Math.sqrt((2 * 400) / motion.GRAVITY) * 1000) < 1);
  let last = -1, lastDrop = 0;
  for (let ms = 0; ms <= plan.ms; ms += 10) {
    const point = motion.fallAt(plan, ms);
    assert(point.y >= last, "always down");
    if (ms > 10) assert(point.y - last >= lastDrop - 1e-9, "faster and faster");
    lastDrop = point.y - last;
    last = point.y;
  }
  const end = motion.fallAt(plan, plan.ms);
  assert.deepEqual([end.x, end.y, end.done], [160, 400, true], "exactly onto the spot under it");
  assert(motion.fallPlan(from, { x: 100, y: 2 }).ms >= 160, "a tiny drop still shows");
  const gentle = motion.impactOf(motion.fallPlan(from, { x: 100, y: 40 }).speed);
  const hard = motion.impactOf(motion.fallPlan(from, { x: 100, y: 900 }).speed);
  assert(gentle < 0.6 && hard === 1, `a small drop is gentle (${gentle}), a long one flattens it (${hard})`);
});

test("it crouches to leap, stretches in the air and squashes on landing, ending exactly at rest", () => {
  const crouch = motion.crouchAt(1);
  assert(crouch.sy < 0.85 && crouch.sx > 1.05, "lower and wider");
  assert.deepEqual({ ...motion.flightAt(0.5) }, { sx: 1, sy: 1 }, "round at the top of the arc");
  assert(motion.flightAt(0).sy > 1 && motion.flightAt(1).sy > 1, "stretched as it leaves and comes down");
  const hit = motion.landAt(0, 1);
  assert(hit.sy < 0.75 && hit.sx > 1.2, "flattened by a hard landing");
  let rebound = 1;
  for (let t = 0; t <= 1; t += 0.02) rebound = Math.max(rebound, motion.landAt(t, 1).sy);
  assert(rebound > 1.03, "it springs up a little taller");
  assert.deepEqual({ ...motion.landAt(1, 1) }, { sx: 1, sy: 1 }, "and ends at rest");
  assert(Math.abs(motion.landAt(0.98, 1).sy - 1) < 0.02, "settling smoothly into it");
  assert(1 - motion.landAt(0, 0.2).sy < 1 - hit.sy, "a gentle landing squashes less");
});

test("riding the pointer it follows a spring, never overshooting", () => {
  assert.equal(motion.follow(0, 100, 60), 50, "halfway every half-life");
  assert.equal(motion.follow(0, 100, 0), 0);
  assert(motion.follow(0, 100, 600) < 100, "never past it");
  assert.equal(motion.follow(Number.NaN, 100, 16), 100);
});

test("it stands only where it covers nothing to read or click above the box", () => {
  // A 600 px box with the branch chip at its left (0-140) and the chat's last line ending at 300-380.
  const spans = motion.clearSpans(600, [{ left: 300, right: 380 }, { left: -10, right: 140 }], 80);
  const plain = value => JSON.parse(JSON.stringify(value));
  assert.deepEqual(plain(spans), [{ left: 180, right: 260 }, { left: 420, right: 560 }]);
  assert.equal(motion.nearestClear(spans, 100), 180, "off the chip, to the nearest clear spot");
  assert.equal(motion.nearestClear(spans, 300), 260);
  assert.equal(motion.nearestClear(spans, 500), 500, "a clear spot stays put");
  assert.deepEqual(plain(motion.clearSpans(600, [{ left: 100, right: 200 }, { left: 150, right: 520 }], 80)), [{ left: 40, right: 60 }, { left: 560, right: 560 }],
    "overlapping blocks merge into one, leaving room only either side of it");
  assert.deepEqual(plain(motion.clearSpans(600, [{ left: 0, right: 600 }], 80)), []);
  assert.equal(motion.nearestClear([], 300), null, "nowhere clear: no spot");
  assert.equal(motion.pickClear([], 300), null);
  let seed = 0.11;
  const random = () => { seed = (seed * 7.31 + 0.137) % 1; return seed; };
  let near = 0;
  for (let roll = 0; roll < 300; roll += 1) {
    const spot = motion.pickClear(spans, 200, random);
    assert(spans.some(span => spot >= span.left && spot <= span.right), `${spot} is clear`);
    if (Math.abs(spot - 200) <= 260) near += 1;
  }
  assert(near > 200, "mostly a short stroll away");
  // Seen in the harness (2026-11-10): in a 520 px pane scrolled up, the transcript's lines ran across
  // the whole box, nowhere was clear, and Clawd stood on a line of text wherever it happened to be.
  const lines = [{ left: 24, right: 448 }, { left: 24, right: 410 }];
  assert.deepEqual(plain(motion.clearSpans(472, lines, 80)), [], "nowhere clear");
  assert.equal(motion.leastCovered(472, lines, 80, 200), 432, "it stands at the end where it covers least, by the send button");
  assert.equal(motion.leastCovered(472, [{ left: 100, right: 380 }], 80, 300), 420, "the nearer of two equally clear ends");
  assert.equal(motion.leastCovered(472, [{ left: 100, right: 380 }], 80, 10), 40);
  assert.equal(motion.leastCovered(60, lines, 80, 30), null, "an edge too short for it");
});

test("Clawd is moved by one frame clock: transforms only, no CSS transition, no layout read per frame", () => {
  // Its leaps and drops were CSS transitions on left/top racing timers, and its walk set React state
  // each step; each walk step also read the box's rect (1,917 forced layouts in 20 s on a 165 Hz screen).
  const paint = petPart("paint", "rest");
  assert.match(paint, /node\.style\.transform = `translate3d\(/);
  assert.doesNotMatch(paint, /style\.(left|top)\b|getBoundingClientRect/);
  assert.match(petSource, /const FPS = 60;/);
  const schedule = petPart("schedule", "animate");
  assert.match(schedule, /const wait = lastFrame\.current \+ 1000 \/ FPS - performance\.now\(\) - vsync\.current;[\s\S]*window\.setTimeout\(/,
    "on a fast screen it waits out the frame interval");
  assert.match(schedule, /direct\.current = wait <= 2;\s*if \(direct\.current\) \{ frameId\.current = window\.requestAnimationFrame\(onFrame\); return; \}/,
    "at 60 Hz it asks for the next refresh straight away");
  assert.match(petPart("stopMotion", "cancelPlans"), /window\.clearTimeout\(frameTimer\.current\);/, "stopping cancels a waiting frame too");
  const walk = petPart("walkTo", "land");
  const step = walk.slice(walk.indexOf("timed(plan.ms"));
  assert.doesNotMatch(step, /getBoundingClientRect|clearOn\(|toScreen\(/, "no layout read inside a step");
  assert.doesNotMatch(step, /feet\.current\.y/, "a walk stays on the top edge");
  const leap = petPart("leapTo", "nextSpot");
  const flight = leap.slice(leap.indexOf("timed(plan.ms"), leap.indexOf("}, () => {", leap.indexOf("timed(plan.ms")));
  assert.doesNotMatch(flight, /getBoundingClientRect|toScreen\(/, "no layout read in the air");
  // Its feet on the box's top edge, not the bottom of its 48 px box 8 px under them.
  assert.match(petSource, /const FEET = HEIGHT - CELL_H \/ 2;/);
  const css = fs.readFileSync(path.resolve(__dirname, "../src/features/codex-chat.css"), "utf8");
  const rules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].filter(([, selector]) => /\.cx-pet(-body)?(?![\w-])/.test(selector));
  assert(rules.length >= 4);
  for (const [, selector, body] of rules) assert.doesNotMatch(body, /transition/, `${selector.trim()} moves only by the frame clock`);
  assert.match(css, /\.cx-pet-body \{[^}]*transform-origin: 36px 40px;/, "it squashes from its feet");
});

test("its cottage stands beside the box, never above its top edge, and the rooms show only when you look in", () => {
  // The user (2026-11-10): "its house blocking the screen". The 160 px doll's house stood on the box's
  // top edge over the chat's last messages whenever there was no room beside the box.
  assert.match(petSource, /left: box\.width - box\.edge \+ COTTAGE_GAP, top: box\.height - box\.edge - COTTAGE_H/, "its floor level with the box's bottom");
  assert.match(petSource, /x: current\.width - current\.edge \+ COTTAGE_GAP \+ DOOR_X, y: current\.height - current\.edge/, "and Clawd's doorstep on it");
  assert.match(petSource, /const room = height >= COTTAGE_H\s*&& /, "only beside a box at least as tall as it");
  assert.match(petSource, /const houseAt: "beside" \| "yard" \| null = box\?\.room \? "beside" : yard \? "yard" : null;/, "else the yard, else none");
  assert.match(petSource, /\{peek && houseAt && typeof document !== "undefined"/, "the rooms only in the peek");
  assert.match(petPart("goHome", "goOut"), /if \(!step \|\| !current\) \{ if \(nap\) napHere\(\); return; \}/, "no cottage: it naps on its box");
  // Drawn on <body>, outside the chat's theme, the peek and Clawd's bubble over the page take the chat's
  // colours (seen in the harness: <body>'s white text on the peek's white panel).
  assert.match(petSource, /setPalette\(chatPalette\(composer\.current\)\)/);
  assert.match(petSource, /palette=\{palette\} onUse=\{toFurniture\}/);
  assert.match(petSource, /\.\.\.\(space === "screen" \? palette : \{\}\)/);
  // Leaving a house that has gone (the window narrowed) or a trip cut short brings it back onto its box.
  const gone = petSource.slice(petSource.indexOf("// Its cottage went away"), petSource.indexOf("// React to the agent"));
  assert.match(gone, /leaveHome\(\)/);
  assert.match(gone, /flyBack\(\)/);
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
  assert.match(petSource, /findPetYard<HTMLElement>\(anchor\.current\)/);
  assert.doesNotMatch(petSource, /document\.querySelector<HTMLElement>\(YARD\)/);
  // A yard too narrow for the cottage and Clawd in front of it (the list folded away) is no yard.
  assert.match(petSource, /found\.offsetWidth >= COTTAGE_W \+ WIDTH \? found : null/);
});

test("every way out of the house is through its door; only the rooms you watch are walked through first", () => {
  // The user (2026-11-09): "when its in its house, then it try to goes out, it just straight teleport
  // to the platform instead of walking to platform".
  const goOut = petPart("goOut", "leaveHome");
  assert.match(goOut, /if \(peekNow\.current\) homeRun\(exitBeats\(homePlace\(\)\)/, "watched, it climbs out of bed and down the ladder first");
  const leaveHome = petPart("leaveHome", "homeRun");
  assert.match(leaveHome, /exitDoor\(step, \(\) => \{/, "out through the door");
  assert.match(leaveHome, /leapTo\(\{ space: "box", x, y: 0 \}, settleOut/, "and a hop up onto its box");
  const exitDoor = petPart("exitDoor", "goHome");
  assert.match(exitDoor, /shape\.current\.shrink = DOOR_SCALE \+ \(1 - DOOR_SCALE\) \* e;/, "growing back to full size as it steps out");
  const enterDoor = petPart("enterDoor", "exitDoor");
  assert.match(enterDoor, /setFace\(\{ pose: \{ facing: "back" \}/, "in, it shows its back");
  const moodEffect = petSource.slice(petSource.indexOf("// React to the agent"), petSource.indexOf("// Split view: another pane's chat calls it over"));
  assert.match(moodEffect, /else if \(activity\.current === "home"\) goOut\(\);/);
  assert.match(moodEffect, /else if \(activity\.current === "travel"\) flyBack\(\);/, "a trip cut short ends back on its box");
  const calledOver = petSource.slice(petSource.indexOf("// Split view: another pane's chat calls it over"), petSource.indexOf("const full ="));
  assert.match(calledOver, /goOut\(event\.pane\)/);
});
