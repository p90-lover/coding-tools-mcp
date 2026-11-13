import { useContext, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type CSSProperties, type PointerEvent as ReactPointerEvent,
  type ReactElement } from "react";
import { createPortal } from "react-dom";

// Bit, the chat's pet: Claude Code's Clawd living on the chat box's top edge. It strolls along the
// edge, never stopping over the text or the chips just above the box; while the agent works it gets
// to work itself (typing at a little laptop, searching with a magnifier, hammering, carrying a file
// box); idle, it sips coffee, reads, looks around. When the pointer comes close it may leap onto it
// for a hug or a ride. It runs to the send button when a request waits for you, celebrates a finished
// turn and frets at a failed one. Left alone while nothing runs, it goes home to its cottage beside
// the box (or in the yard under the chat list) and sleeps there; click the cottage to look inside,
// where it cooks, bathes, reads and works (chat-pet-house.tsx, chat-pet-home.ts). Click Clawd to
// pet it, double-click to feed it, drag it anywhere (let go, it falls back onto the box), right-click
// to hide it. Pure view: it reads the chat's state and changes nothing.
//
// Clawd itself (Clawd.tsx) is Claude Code's: the CLI's glyphs, poses and animations, frame for frame.
//
// How it moves (the user, 2026-11-10: "all clawd animation are broken and dumb when moving"): one
// frame clock writes its position and its squash and stretch straight onto the page (paint), from
// pure functions of time (chat-pet-motion.ts). A walk speeds up and slows down, its feet and a bob
// follow the distance walked, it turns before walking back the other way, a leap crouches, flies a
// parabola and lands with a squash, a drop falls under gravity, and it goes into its cottage through
// the door. Nothing is a CSS transition racing a timer, so nothing lands before it arrives.
//
// In split view there is one Clawd for all the panes (chat-pet-stage.ts). It lives on one pane's box
// and leaps across to another only to follow you to the pane you click into, and when another chat
// asks for you, finishes or fails.

import type { PetMood } from "./ao-chat";
import { SurfaceHiddenContext } from "./page-visibility";
import { chatPalette } from "./ChatMenu";
import { findPetYard, petCall, petFlight, petStage } from "./chat-pet-stage";
import { clearSpans, crouchAt, fallAt, fallPlan, flightAt, follow, gaitAt, impactOf, landAt, leapAt, leapPlan, leastCovered, nearestClear, petToolSide, pickClear,
  turnFacings, walkAt, walkPlan, WALK_FACING, type Point, type Span } from "./chat-pet-motion";
import { ENTRY, FLOOR_LINE, choreBeats, exitBeats, pickChore, type Chore, type HomeBeat, type HomeMemory } from "./chat-pet-home";
import { COTTAGE_H, COTTAGE_W, Cottage, DOOR_SCALE, DOOR_X, HousePeek, P, PIXEL_H, PIXEL_W, rect, type HomeView } from "./chat-pet-house";
import { CELL_H, CELL_W, CLICKABLE, COLS, ClawdFrame, ENTRANCES, PLAYFUL, ROWS, pickOne, useClawdPlayer,
  type AnimationName, type Arms as ClawdArms, type Eyes, type Feet, type Frame } from "./Clawd";

/** Where it was left: how far along the box's top edge, as a share of its width. */
const POSITION_KEY = "coding-tools:ao:pet-x";
/** Where older builds kept its spot (a share of the way round the box's outline) and how far it was
 *  held off the box: only cleared now. */
const OLD_KEYS = ["coding-tools:ao:pet-around", "coding-tools:ao:pet-lift"];
const WIDTH = COLS * CELL_W;
const HEIGHT = ROWS * CELL_H;
/**
 * Where its feet touch the ground in its 72 × 48 box: its feet are the top half of the last row. It
 * stood on the box's bottom edge, with 8 px of nothing under its feet, so it hovered over the chat
 * box's edge instead of standing on it.
 */
const FEET = HEIGHT - CELL_H / 2;
/** Between the chat box's right end and its cottage. */
const COTTAGE_GAP = 18;
const NAP_MS = 45_000;
const CHEER_MS = 6_000;
/** Walking speed in px/s: a stroll while nothing runs, a scurry while the agent works. */
const STROLL = 52;
const SCURRY = 120;
/** How high it bobs each stride (px). */
const BOB = 2;
/** The frame clock's cap: no more than 60 paints a second, whatever the screen's rate. */
const FPS = 60;
/** Turning round to walk back the other way (ms): four of the CLI's turn frames, near its 60 ms beat. */
const TURN_MS = 200;
/** The crouch before a leap, and the squash after a landing (ms). */
const CROUCH_MS = 110;
const LAND_MS = 320;
/** Going in or out through the cottage's door (ms). */
const DOOR_MS = 420;
/** A hop up onto (or down off) the bed, a chair or the tub, seen through the peek: up first, then down onto it. */
const HOP_EASE = "cubic-bezier(.3,-.6,.6,1)";
/** Chores on a visit, before it goes back out to the box (a click on furniture adds one). */
const VISIT_CHORES = 2;
/** Leaving the house in a hurry (a request waits on you), its way out takes this share as long. */
const HURRY = 0.6;
/** How near (px) the pointer must come before Bit turns its eyes to it, and before it leaps on. */
const NOTICE = 180;
const REACH = 70;
/** How often (ms), while the pointer moves, Bit checks where it is. */
const LOOK_EVERY_MS = 100;
/** Between two leaps onto the pointer, so it plays now and then rather than pestering. */
const PLAY_EVERY = 15_000;
/** A ride lasts at most this long (ms) before it jumps off by itself; a click, Escape or a quick
 *  shake of the pointer makes it jump off at once. */
const MAX_RIDE = 4_000;
/** A pointer move this fast (px between two checks) shakes it off. */
const SHAKE = 90;
/** What it does now and then while riding, from Claude Code's own animations. */
const RIDE_PLAYS: AnimationName[] = ["jump", "wink", "look", "boop", "tap"];
/** How often it follows you into the pane you click into, and how long it takes to notice (ms). */
const FOLLOW_CHANCE = 0.6;
const FOLLOW_MS = 900;
/** The pointer resting near it gets a wave (at most this often); resting over its box further
 *  along, it now and then walks over to see (at most this often, after the pointer rests this long). */
const WAVE_EVERY = 25_000;
const VISIT_EVERY = 20_000;
const LINGER_MS = 1_200;
/** Petted this many times in PET_STREAK_MS: a happy dance. */
const PET_STREAK = 3;
const PET_STREAK_MS = 4_000;
/** While a request waits on you, a nudge (tapping its feet, a hop, a wave) this often, at most this many. */
const NUDGE_MS = 8_000;
const NUDGES = 5;
/** The entrance plays once per window, as the CLI plays one once per version. */
let entrancePlayed = false;
/** Claude Code's working spinner, cycled over Clawd's head while the agent works. */
const SPINNER = ["·", "✢", "✳", "✶", "✻", "✽", "✻", "✶", "✳", "✢"];

const LINES: Record<PetMood, string> = {
  idle: "Nothing running. Want to start something?",
  working: "Busy busy. The agent is on it.",
  ask: "Psst, the agent is asking you something.",
  done: "Turn finished. Nice work.",
  error: "Something broke. Retry the step?",
};
const PETTED = ["Hehe", "More pets, please", "I like you", "*purr*"];
const MUSINGS = ["Hmm…", "*looks around*", "What are we building?", "♪", "Nice code"];
const RIDING = ["Wheee!", "Take me somewhere", "Faster!", "Hold on tight"];
const FOLLOWING = ["Wait for me!", "Coming along", "Right behind you"];
const SENT = ["Off it goes!", "Sent!", "On its way"];

/** What Clawd is busy with: a prop beside it (or on its head) and how its arms move. At home it also
 *  stirs a pot (cook), eats a cookie (snack) and carries its plate to the table (serve). */
export type Job = "none" | "laptop" | "search" | "build" | "carry" | "coffee" | "read" | "cook" | "snack" | "serve";
type Arms = "down" | "left" | "right" | "both" | "reach";
/** `stride`: walking somewhere on its own feet (not kicking in the air, carried or riding). */
export type Pose = { look: -1 | 0 | 1; arms: Arms; walking: boolean; sit: boolean; stride?: boolean };

/**
 * The frame Clawd rests in between animations, built from the CLI's own parts: eyes turned where it
 * looks (closed asleep or blinking), feet stepping left and right as it walks (the CLI's waddle),
 * arms up to ask or carry, one arm working its tool or typing, and a one-row crouch to sit.
 */
export function restFrame({ mood, asleep, step, pose, blink, job, toolSide }: { mood: PetMood; asleep: boolean; step: boolean; pose: Pose; blink: boolean; job: Job; toolSide: "left" | "right" }): Frame {
  // The CLI has genuine side-facing Clawd glyphs. Use one for typing rather than a
  // front-facing face that appears to ignore the computer beside it.
  if (job === "laptop" && !pose.walking && !asleep) {
    return { pose: { facing: toolSide === "left" ? "left-12" : "right-12" }, offset: pose.sit ? 1 : 0 };
  }
  // Walking somewhere, its body turns a little toward where it goes and it steps along on the CLI's
  // turn frames, one foot up each stride. It slid sideways facing us, only its eyes turned (the
  // user, 2026-11-12: "fix all clawd animation"). Carrying something it still faces us, arms up.
  if (pose.stride && pose.walking && pose.look !== 0 && job === "none" && !asleep) {
    return { pose: { facing: pose.look < 0 ? WALK_FACING.left : WALK_FACING.right, step: step ? "left" : "right" }, offset: 0 };
  }
  const eyes: Eyes = asleep || blink ? "closed"
    : job !== "none" && job !== "carry" && job !== "serve" ? toolSide
    : pose.look < 0 ? "left" : pose.look > 0 ? "right" : "open";
  let arms: ClawdArms = "down";
  if (!asleep) {
    // A tool is held up in the hand on its side (Prop draws it there). The right arm went up whatever
    // side the tool was on, with the tool down by its feet, and with no tool at all it "typed" in the
    // air: it read as Clawd checking its watch (the user, 2026-10-30).
    const holding: ClawdArms = toolSide === "left" ? "left-up" : "one-up";
    if (job === "carry" || job === "serve" || (mood === "ask" && !pose.walking) || pose.arms === "both") arms = "up";
    else if (job !== "none" && job !== "laptop") arms = holding;
    else if (pose.arms === "left") arms = "left-up";
    else if (pose.arms !== "down") arms = "one-up";
  }
  const feet: Feet = pose.walking ? (step ? "left" : "right") : "both";
  return { pose: { eyes, arms, feet }, offset: pose.sit ? 1 : 0 };
}

/** A file box carried over its head, held up in both hands. */
export function CarriedBox() {
  const r = rect;
  return <svg className="cx-pet-box" viewBox="0 0 8 2" width={8 * PIXEL_W} height={2 * PIXEL_H} preserveAspectRatio="none" aria-hidden="true" shapeRendering="crispEdges">
    {[r(0, 0, 8, 2, P.box, "box"), r(0, 0, 8, 1, P.boxDark, "box-lid"), r(3, 1, 2, 1, P.boxDark, "box-tape")]}
  </svg>;
}

/** Its plate held up in both hands on the way to the table, the stew steaming. */
export function CarriedPlate({ tick }: { tick: number }) {
  const r = rect;
  return <svg className="cx-pet-box" viewBox="0 0 8 3" width={8 * PIXEL_W} height={3 * PIXEL_H} preserveAspectRatio="none" aria-hidden="true" shapeRendering="crispEdges">
    {[r(1, 2, 6, 1, P.porcelain, "plate"), r(2, 1, 4, 1, P.stew, "stew"), r(3 + (tick % 2), 0, 1, 1, P.steam, "steam")]}
  </svg>;
}

/**
 * The tool beside it, on a 9×7 grid of the same pixels, its bottom on the same ground line. Clawd's
 * raised hand (restFrame) is at the grid's row 2, just left of column 0 (mirrored on its left side),
 * so a tool it holds starts there: the mug, magnifier, hammer and book were drawn by its feet while
 * the arm went up empty, and the mug's steam and the loose hammer's sparks read as fireworks.
 */
export function Prop({ job, step, tick, bites = 3 }: { job: Job; step: boolean; tick: number; bites?: number }) {
  if (job === "none" || job === "carry" || job === "serve") return null;
  const r = rect;
  const parts: ReactElement[] = [];
  if (job === "laptop") {
    // A laptop turned toward Clawd, with a paw tapping the keyboard each beat.
    parts.push(r(1, 3, 6, 3, P.frame, "lid"), r(2, 3, 4, 2, P.screen, "screen"), r(0, 6, 8, 1, P.key, "keys"));
    for (let line = 0; line < 2; line += 1) parts.push(r(2, 3 + line, 1 + ((tick + line * 3) % 4), 1, P.glow, `line${line}`));
    parts.push(r(0, step ? 5 : 6, 1, 1, "#d77757", "typing-paw"));
  } else if (job === "search") {
    // A magnifier held up by its grip, its lens glinting from side to side as it scans.
    parts.push(r(0, 2, 2, 1, P.wood, "grip"), r(2, 0, 2, 1, P.metal, "ring-t"), r(1, 1, 1, 1, P.metal, "ring-l"),
      r(4, 1, 1, 1, P.metal, "ring-r"), r(2, 2, 2, 1, P.metal, "ring-b"), r(2, 1, 2, 1, P.lens, "lens"),
      r(step ? 3 : 2, 1, 1, 1, P.page, "glint"));
  } else if (job === "build") {
    // A hammer in its hand, raised and then down onto a nail in the ground, a spark on each hit.
    parts.push(r(4, 5, 1, 2, P.metal, "nail"));
    if (step) parts.push(r(0, 2, 2, 1, P.wood, "handle"), r(2, 3, 1, 1, P.wood, "handle-end"), r(3, 3, 2, 2, P.metal, "head"),
      r(5, 4, 1, 1, P.knob, "spark"));
    else parts.push(r(0, 1, 1, 2, P.wood, "handle"), r(0, 0, 3, 1, P.metal, "head"));
  } else if (job === "coffee") {
    // A mug in its hand by the handle, a wisp of steam curling over it.
    parts.push(r(0, 2, 1, 1, P.rim, "handle"), r(1, 1, 3, 2, P.mug, "mug"), r(1, 1, 3, 1, P.rim, "rim"),
      r(1 + (tick % 3), 0, 1, 1, P.steam, "steam"));
  } else if (job === "read") {
    // An open book held up in its hand, a page turning now and then.
    parts.push(r(0, 1, 3, 2, P.page, "page-l"), r(4, 1, 3, 2, P.page, "page-r"), r(3, 1, 1, 3, P.cover, "spine"), r(0, 3, 7, 1, P.cover, "cover"));
    if (tick % 6 === 0) parts.push(r(3, 0, 2, 1, P.page, "turn"));
  } else if (job === "cook") {
    // A ladle by its handle, its bowl dipping into the pot and coming up again.
    parts.push(r(0, 2, 2, 1, P.wood, "ladle-handle"), r(2, step ? 3 : 2, 1, 1, P.wood, "ladle-neck"),
      r(3, step ? 4 : 3, 2, 1, P.metal, "ladle-bowl"));
    if (!step) parts.push(r(3, 2, 1, 1, P.stew, "ladle-stew"));
  } else if (job === "snack") {
    // A cookie in its hand, a bite gone each time (bites left: 3 whole, 0 gone).
    // The far side goes first; the bit in its hand (column 0) is never bitten off.
    const gone = [[2, 1], [2, 2], [1, 1]].slice(0, 3 - Math.max(0, Math.min(3, bites)));
    for (const [x, y] of [[0, 1], [1, 1], [2, 1], [0, 2], [1, 2], [2, 2]] as const) {
      if (!gone.some(([gx, gy]) => gx === x && gy === y)) parts.push(r(x, y, 1, 1, (x + y) % 3 === 0 ? P.chip : P.cookie, `cookie${x}${y}`));
    }
  }
  return <svg className="cx-pet-prop" viewBox="0 0 9 7" width={9 * PIXEL_W} height={7 * PIXEL_H} preserveAspectRatio="none" aria-hidden="true" shapeRendering="crispEdges">{parts}</svg>;
}

type Floater = { id: number; text: string; offset: number };
const REST: Pose = { look: 0, arms: "down", walking: false, sit: false };
const pick = <T,>(items: readonly T[]) => items[Math.floor(Math.random() * items.length)]!;
const WORK: readonly Job[] = ["laptop", "laptop", "search", "build", "carry"];
const clamp = (value: number, low: number, high: number) => Math.max(low, Math.min(high, value));

/**
 * Where Clawd is drawn, and so what its feet's x and y are measured from:
 * - "box": its chat box, in the box's own px: the top edge it lives on is y 0, and the ground its
 *   cottage stands on beside the box is y = the box's height;
 * - "yard": the lot under the chat list where its cottage stands (the lot's px, the ground at
 *   y = COTTAGE_H), in split view or when there is no room beside the box;
 * - "screen": the page itself (client px), while it leaps across, is carried or rides the pointer.
 */
type Space = "box" | "yard" | "screen";
type Place = Point & { space: Space };
/** What it is up to: on its box (strolling, working, napping there), on its way somewhere (a leap,
 *  the door), on the pointer, carried, or in its house. */
type Activity = "box" | "travel" | "ride" | "held" | "home";
/** The box it lives on: its size (border included), whether there is room for its cottage beside its
 *  right end, and its border's width (what it stands on is placed inside the border). */
type BoxSize = { width: number; height: number; room: boolean; edge: number };
/** Elements just above the box that hold something to read or click: Clawd never stops on them. */
const CONTENT = "button, a, input, select, textarea, img, svg, video, canvas, [role='button']";

type PetProps = {
  mood: PetMood;
  /** Share of the context window in use (0–1), when the agent reports it. */
  context: number | null;
  onHide: () => void;
};

function PetBody({ mood, context, onHide, split }: PetProps & {
  /** In split view: the pane it lives in now (one pet for all panes). Null outside split view. */
  split: { pane: HTMLElement } | null;
}) {
  const anchor = useRef<HTMLSpanElement>(null);
  const el = useRef<HTMLDivElement>(null);
  const body = useRef<HTMLButtonElement>(null);
  // The chat box it lives on: the parent it is mounted in.
  const composer = useRef<HTMLElement | null>(null);
  const lot = useRef<HTMLDivElement>(null);
  const cottageSpot = useRef<HTMLSpanElement>(null);
  // Where its feet are (see Space), and its squash, stretch, bob, size and fade: written onto the
  // page every frame by paint, never through React.
  const feet = useRef<Place>({ space: "box", x: Number.NaN, y: 0 });
  const shape = useRef({ sx: 1, sy: 1, bob: 0, shrink: 1, fade: 1 });
  const [space, setSpace] = useState<Space>("box");
  // The space React has drawn it in so far: paint waits for it to get there.
  const spaceNow = useRef<Space>("box");
  const [placed, setPlaced] = useState(false);
  const [box, setBox] = useState<BoxSize | null>(null);
  const boxNow = useRef(box);
  const [yard, setYard] = useState<HTMLElement | null>(null);
  const activity = useRef<Activity>("box");
  const [inside, setInside] = useState(false);
  const insideNow = useRef(inside);
  insideNow.current = inside;
  const [doorOpen, setDoorOpen] = useState(false);
  // A frame shown instead of its resting one: its back as it goes in at the door.
  const [face, setFace] = useState<Frame | null>(null);
  const [foot, setFoot] = useState(false);
  const footNow = useRef(false);
  const facing = useRef<-1 | 1>(1);
  const [pose, setPose] = useState<Pose>(REST);
  const [job, setJob] = useState<Job>("none");
  const [step, setStep] = useState(false);
  const [tick, setTick] = useState(0);
  const [blink, setBlink] = useState(false);
  const [spin, setSpin] = useState(0);
  const [asleep, setAsleep] = useState(false);
  const asleepNow = useRef(asleep);
  asleepNow.current = asleep;
  const [cheering, setCheering] = useState(false);
  const [bubble, setBubble] = useState<string | null>(null);
  const [floaters, setFloaters] = useState<Floater[]>([]);
  const [fed, setFed] = useState(0);
  // At home: the beat it is on (where in the house it stands and what it is doing there), what it has
  // done there lately, and the chores left before it goes out.
  const [scene, setScene] = useState<HomeBeat | null>(null);
  const sceneNow = useRef(scene);
  sceneNow.current = scene;
  const homeMemory = useRef<HomeMemory>({ last: null, sinceMeal: 0, hour: 0 });
  const visitLeft = useRef(0);
  const [peek, setPeek] = useState(false);
  // The chat's colours, for what is drawn on <body> outside its theme: the peek, and Clawd's speech
  // bubble while it is over the page (white on white otherwise: <body>'s text colour is the dark theme's).
  const [palette, setPalette] = useState<CSSProperties>({});
  const peekNow = useRef(peek);
  peekNow.current = peek;
  const [riding, setRiding] = useState(false);
  const [held, setHeld] = useState(false);
  // In a leap or a fall: nothing on it can be clicked.
  const [airborne, setAirborne] = useState(false);
  // Just landed: how hard (0-1), for its dust, and a count that restarts the dust's animation.
  const [landed, setLanded] = useState<{ count: number; impact: number } | null>(null);
  // Falling onto its box: its shadow there, where it will land (px along the box) and when (ms).
  const [drop, setDrop] = useState<{ x: number; ms: number } | null>(null);
  // Called out by another pane while in its house: it leaps there once it is out.
  const outToward = useRef<HTMLElement | null>(null);
  const drag = useRef<{ moved: boolean; x: number; y: number; lastX: number; lastY: number } | null>(null);
  // The window listeners of a drag in progress (removed on drop or unmount).
  const dragEnd = useRef<(() => void) | null>(null);
  const pointer = useRef({ x: 0, y: 0 });
  const lastPlay = useRef(0);
  const clickTimer = useRef<number | undefined>(undefined);
  const rideTimer = useRef<number | undefined>(undefined);
  const bubbleTimer = useRef<number | undefined>(undefined);
  const napTimer = useRef<number | undefined>(undefined);
  const wanderTimer = useRef<number | undefined>(undefined);
  // Every scheduled behaviour (an arrival, an action's end, a turn's pause), cleared together.
  const plans = useRef<number[]>([]);
  // Floaters, feeding and the door closing finish independently of the plans, but none may outlive
  // this pet (including when its chat page becomes hidden).
  const decorationTimers = useRef(new Set<number>());
  const seq = useRef(0);
  const moodNow = useRef(mood);
  moodNow.current = mood;
  const [still] = useState(() => { try { return window.matchMedia("(prefers-reduced-motion: reduce)").matches; } catch { return false; } });
  const clawd = useClawdPlayer(still);
  // Whether one of its animations is playing now, for listeners set up once (they see this render's).
  const playingNow = useRef(false);
  playingNow.current = clawd.playing;
  // Shaken off the pointer: dizzy once it lands. Recent pets, for a happy dance at PET_STREAK.
  const dizzy = useRef(false);
  const pets = useRef<number[]>([]);
  // The frame clock: the motion under way (null when nothing moves), its frame request and the wait
  // before it, when it last painted, the screen's refresh interval as measured, and whether the
  // pending frame was asked for straight away (so its gap measures that interval).
  const motion = useRef<((now: number) => boolean) | null>(null);
  const frameId = useRef(0);
  const frameTimer = useRef(0);
  const lastFrame = useRef(0);
  const vsync = useRef(1000 / FPS);
  const direct = useRef(false);

  const later = (ms: number, run: () => void) => { plans.current.push(window.setTimeout(run, ms)); };
  const afterDecoration = (ms: number, run: () => void) => {
    const timer = window.setTimeout(() => { decorationTimers.current.delete(timer); run(); }, ms);
    decorationTimers.current.add(timer);
  };
  const stopMotion = () => {
    motion.current = null;
    if (frameId.current) window.cancelAnimationFrame(frameId.current);
    window.clearTimeout(frameTimer.current);
    frameId.current = 0;
    frameTimer.current = 0;
  };
  const cancelPlans = () => {
    plans.current.forEach((timer) => window.clearTimeout(timer));
    plans.current = [];
    window.clearTimeout(wanderTimer.current);
    stopMotion();
    // Cut off on its box mid-turn, mid-stride or mid-landing, it stands there at rest. A landing a
    // new mood stopped left it squashed, a walk left it hovering a bob over the edge, and a turn
    // left it showing a turning frame, until something else happened to reset them.
    if (activity.current === "box") {
      setFace(null);
      if (feet.current.space === "box") { rest(); paint(); }
    }
  };
  const say = (text: string, ms = 1800) => {
    setBubble(text);
    window.clearTimeout(bubbleTimer.current);
    if (ms) bubbleTimer.current = window.setTimeout(() => setBubble(null), ms);
  };
  /** One of Claude Code's own animations. */
  const play = (name: AnimationName) => clawd.play(name);
  const float = (text: string, left = 10 + Math.round(Math.random() * 24)) => {
    const id = ++seq.current;
    setFloaters((current) => [...current, { id, text, offset: left }]);
    afterDecoration(1100, () => setFloaters((current) => current.filter((item) => item.id !== id)));
  };
  /** Busy with something other than its life on the box. */
  const busy = () => activity.current !== "box" || asleepNow.current || drag.current !== null;
  /** The other panes' boxes it can leap to (split view). */
  const otherPanes = () => split ? [...petStage.seats().keys()].filter((pane) => pane !== split.pane && pane.isConnected) : [];

  /** Its position, squash and fade onto the page: one transform each on it and its body, no layout. */
  const paint = () => {
    const node = el.current;
    const { x, y, space: at } = feet.current;
    if (!node || !Number.isFinite(x) || at !== spaceNow.current) return;
    const look = shape.current;
    node.style.transform = `translate3d(${Math.round(x - WIDTH / 2)}px, ${Math.round(y - FEET - look.bob)}px, 0)`;
    const sprite = body.current;
    if (sprite) {
      const sx = look.sx * look.shrink, sy = look.sy * look.shrink;
      sprite.style.transform = sx === 1 && sy === 1 ? "" : `scale(${sx.toFixed(3)}, ${sy.toFixed(3)})`;
      sprite.style.opacity = look.fade >= 1 ? "" : look.fade.toFixed(2);
    }
    // Over the page, a native view it passes over (the chat's Preview) swaps in a still of its page.
    if (at === "screen") petFlight.set({ left: x - WIDTH / 2, top: y - FEET, right: x + WIDTH / 2, bottom: y - FEET + HEIGHT });
  };
  const rest = () => { Object.assign(shape.current, { sx: 1, sy: 1, bob: 0, shrink: 1, fade: 1 }); };
  /** Its feet at `place`, moving it into that space's part of the page if it is drawn in another
   *  (React moves it there; it is painted once it is there). */
  const moveTo = (place: Place) => {
    feet.current = { ...place };
    if (place.space !== spaceNow.current) setSpace(place.space);
    paint();
  };
  /** The page position of a spot in a space. */
  const toScreen = (place: Place): Point => {
    if (place.space === "screen") return { x: place.x, y: place.y };
    const origin = place.space === "yard" ? lot.current : composer.current;
    const frame = origin?.getBoundingClientRect();
    return frame && origin ? { x: frame.left + origin.clientLeft + place.x, y: frame.top + origin.clientTop + place.y } : { x: place.x, y: place.y };
  };

  // The frame clock: one motion at a time, painted at most FPS times a second.
  const onFrame = (now: number) => {
    frameId.current = 0;
    const run = motion.current;
    if (!run) return;
    const gap = now - lastFrame.current;
    // Asked for straight away, a frame comes the next refresh: its gap is the screen's interval.
    if (direct.current && gap > 2) vsync.current = Math.min(gap, vsync.current * 0.9 + gap * 0.1);
    // Too soon on a fast screen (120, 165 Hz): wait for a later one.
    if (gap < 1000 / FPS - 4) { schedule(); return; }
    lastFrame.current = now;
    const going = run(now);
    paint();
    if (motion.current === run && !going) motion.current = null;
    if (motion.current) schedule();
  };
  /**
   * The next frame. Asking for one every refresh costs Chromium a main-thread frame even when nothing
   * draws, so on a screen faster than FPS it waits out most of the interval first. At FPS it asks
   * straight away: a wait there missed the next refresh whenever the timer ran late, and Clawd moved
   * at 30 frames a second, in fits (measured 2026-11-10: frame gaps of 16 and 33 ms, median 28).
   */
  const schedule = () => {
    if (frameId.current || frameTimer.current) return;
    const wait = lastFrame.current + 1000 / FPS - performance.now() - vsync.current;
    direct.current = wait <= 2;
    if (direct.current) { frameId.current = window.requestAnimationFrame(onFrame); return; }
    frameTimer.current = window.setTimeout(() => {
      frameTimer.current = 0;
      frameId.current = window.requestAnimationFrame(onFrame);
    }, wait);
  };
  const animate = (run: (now: number) => boolean) => { motion.current = run; schedule(); };
  /**
   * A motion lasting `ms`: `update(t)` every frame, `t` from 0 on its first frame to 1, then `done`.
   * Timed from its first frame, so it starts from where Clawd stood and a late frame never cuts it
   * short. Reduced motion jumps straight to the end.
   */
  const timed = (ms: number, update: (t: number) => void, done?: () => void) => {
    if (still || ms <= 0) { stopMotion(); update(1); paint(); done?.(); return; }
    let began = Number.NaN;
    animate((now) => {
      if (Number.isNaN(began)) began = now;
      const t = Math.min(1, (now - began) / ms);
      update(t);
      if (t < 1) return true;
      done?.();
      return false;
    });
  };

  // The box it lives on: measured now and whenever it or the window resizes, with whether there is
  // room for its cottage beside the box's right end.
  useLayoutEffect(() => {
    const parent = anchor.current?.parentElement;
    if (!parent) return undefined;
    composer.current = parent;
    // What the cottage must stay inside: in split view its own pane. The nearest clipping surface was
    // the whole split grid there, so a pane's padding counted as room and the cottage stood in the
    // gap over the next column (2026-11-12, ten panes). Outside split view, the nearest surface around
    // the box that clips what stands outside it.
    let clip: HTMLElement | null = split?.pane ?? parent.parentElement;
    while (!split && clip && getComputedStyle(clip).overflowX === "visible") clip = clip.parentElement;
    const measure = () => {
      const width = parent.offsetWidth, height = parent.offsetHeight;
      if (width <= 0 || height <= 0) return;
      // Room beside it, and a box at least as tall as the cottage, so its roof never rises above the
      // box's top edge into the chat.
      const room = height >= COTTAGE_H
        && (clip ? clip.getBoundingClientRect().right : window.innerWidth) - parent.getBoundingClientRect().right >= COTTAGE_GAP + COTTAGE_W + 4;
      const current = boxNow.current;
      const edge = parent.clientLeft;
      if (current && current.width === width && current.height === height && current.room === room && current.edge === edge) return;
      boxNow.current = { width, height, room, edge };
      setBox(boxNow.current);
      // On its box it stays where it stands, clear of the ends (the box grows a line at a time from
      // its top as text is typed, and its top edge, Clawd's ground, moves with it).
      if (activity.current === "box" && feet.current.space === "box" && Number.isFinite(feet.current.x)) {
        feet.current.x = clamp(feet.current.x, WIDTH / 2, width - WIDTH / 2);
        paint();
      }
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(parent);
    window.addEventListener("resize", measure);
    return () => { observer.disconnect(); window.removeEventListener("resize", measure); };
  }, []);
  // The yard under its own page's chat list, while the list shows wide enough for the cottage and
  // Clawd in front of it. Used when there is no room beside the box (split view panes have none).
  useEffect(() => {
    const found = findPetYard<HTMLElement>(anchor.current);
    const check = () => setYard(found && found.isConnected && found.offsetWidth >= COTTAGE_W + WIDTH ? found : null);
    check();
    if (!found) return undefined;
    const observer = new ResizeObserver(check);
    observer.observe(found);
    return () => observer.disconnect();
  }, []);
  /**
   * Where its cottage stands. In split view: in the yard above Settings, one house for every pane,
   * else beside its box only when that pane has room. Outside split view: beside the box when there
   * is room, else in the yard. Nowhere when neither is there.
   */
  const houseAt: "beside" | "yard" | null = split
    ? (yard ? "yard" : box?.room ? "beside" : null)
    : box?.room ? "beside" : yard ? "yard" : null;
  const houseNow = useRef(houseAt);
  houseNow.current = houseAt;
  /** Its feet on the doorstep, in front of the cottage's door. */
  const doorstep = (): Place | null => {
    const current = boxNow.current;
    if (houseNow.current === "beside" && current) return { space: "box", x: current.width - current.edge + COTTAGE_GAP + DOOR_X, y: current.height - current.edge };
    if (houseNow.current === "yard" && lot.current) return { space: "yard", x: DOOR_X, y: COTTAGE_H };
    return null;
  };

  /**
   * Stretches of `target`'s top edge (its px) where a footprint `width` px wide covers nothing to read
   * or click just above the box: the branch bar's chip, the chat's last line, a button. Text counts
   * only where its words are, not the whole width of its paragraph.
   */
  const blockedOn = (target: HTMLElement): { length: number; blocked: Span[] } => {
    const frame = target.getBoundingClientRect();
    if (frame.width <= 0) return { length: 0, blocked: [] };
    const top = frame.top - FEET, bottom = frame.top;
    const blocked: Span[] = [];
    const add = (found: DOMRect | DOMRectReadOnly) => {
      if (found.width > 0 && found.bottom > top && found.top < bottom) blocked.push({ left: found.left - frame.left - 6, right: found.right - frame.left + 6 });
    };
    const seen = new Set<Element>();
    // The topmost element is enough unless it is the pet itself: the whole stack under each of ~100
    // points cost 126-144 ms a look on a 50k-element chat, the topmost alone 20 ms (2026-11-13), and
    // the pet looks every few seconds.
    const PET = ".cx-pet, .cx-pet-cottage-spot, .cx-pet-peek";
    const under = (x: number, y: number) => {
      const first = document.elementFromPoint(x, y);
      return first && !first.closest(PET) ? first : document.elementsFromPoint(x, y).find((found) => !found.closest(PET));
    };
    for (let x = frame.left + 4; x < frame.right; x += 14) {
      for (const y of [bottom - 6, bottom - 20, top + 6]) {
        const hit = under(x, y);
        if (!hit || seen.has(hit) || target.contains(hit)) continue;
        seen.add(hit);
        const control = hit.closest(CONTENT);
        if (control) { add(control.getBoundingClientRect()); continue; }
        for (const node of hit.childNodes) {
          if (node.nodeType !== Node.TEXT_NODE || !node.textContent?.trim()) continue;
          const range = document.createRange();
          range.selectNodeContents(node);
          for (const line of range.getClientRects()) add(line);
        }
      }
    }
    return { length: frame.width, blocked };
  };
  /** The spot on `target` nearest `x` that covers nothing; when nowhere is clear, the one covering least. */
  const spotOn = (target: HTMLElement, x: number, width = WIDTH + 8): number | null => {
    const { length, blocked } = blockedOn(target);
    return nearestClear(clearSpans(length, blocked, width), x) ?? leastCovered(length, blocked, width, x);
  };
  /** Its spot on its own box nearest `x` (see spotOn), clear of the ends. */
  const restNear = (x: number, width = WIDTH + 8) => {
    const current = boxNow.current;
    const spot = composer.current ? spotOn(composer.current, x, width) : null;
    return spot ?? (current ? clamp(x, WIDTH / 2, current.width - WIDTH / 2) : x);
  };
  const remember = () => {
    const current = boxNow.current;
    if (!current || activity.current !== "box" || feet.current.space !== "box" || !Number.isFinite(feet.current.x)) return;
    try { localStorage.setItem(POSITION_KEY, (feet.current.x / current.width).toFixed(4)); } catch { /* the spot still applies now */ }
  };

  /** Walks along the top edge to `x`, turning round first if it faces the other way; then `arrive`. */
  const walkTo = (x: number, speed: number, arrive?: () => void) => {
    stopMotion();
    const current = boxNow.current;
    const from = feet.current.x;
    const to = current ? clamp(x, WIDTH / 2, current.width - WIDTH / 2) : x;
    const plan = walkPlan(from, to, speed);
    if (!plan.ms) { arrive?.(); return; }
    const way: -1 | 1 = to > from ? 1 : -1;
    const go = () => {
      setFace(null);
      setPose({ ...REST, walking: true, look: way, stride: true });
      timed(plan.ms, (t) => {
        const at = walkAt(plan, t * plan.ms);
        const width = boxNow.current?.width;
        feet.current.x = width ? clamp(at.x, WIDTH / 2, width - WIDTH / 2) : at.x;
        // Its feet and bob follow the distance walked, easing in and out with its speed.
        const gait = gaitAt(at.x - from);
        shape.current.bob = at.done ? 0 : BOB * gait.lift * Math.min(1, at.speed / (0.6 * speed));
        if (gait.left !== footNow.current) { footNow.current = gait.left; setFoot(gait.left); }
      }, () => { shape.current.bob = 0; setPose(REST); remember(); arrive?.(); });
    };
    // Facing the other way, it turns round first rather than walking off backwards: its body comes
    // round through the CLI's turn frames, a quarter of the turn each.
    if (facing.current !== way && !still) {
      facing.current = way;
      setPose({ ...REST, look: way });
      turnFacings(way).forEach((side, index) => later((TURN_MS * index) / 4, () => setFace({ pose: { facing: side }, offset: 0 })));
      later(TURN_MS, go);
      return;
    }
    facing.current = way;
    go();
  };

  /** The landing: a squash by `impact` (0-1) that springs back, and dust either side; then `then`. */
  const land = (impact: number, then?: () => void) => {
    const count = seq.current + 1;
    seq.current = count;
    setLanded({ count, impact });
    afterDecoration(600, () => setLanded((current) => current?.count === count ? null : current));
    setPose(REST);
    timed(LAND_MS, (t) => { Object.assign(shape.current, landAt(t, impact)); }, () => { rest(); then?.(); });
  };
  /**
   * A leap to `to`: it crouches, takes off stretched, flies a parabola (over the page itself when it
   * goes to another space, so no pane's edge clips it) and lands with a squash. `land: false` skips the
   * landing (the pet in the pane it leapt to lands instead); `crouch: false` takes off at once.
   */
  const leapTo = (to: Place, then: () => void, options: { impact?: number; land?: boolean; crouch?: boolean } = {}) => {
    stopMotion();
    const start = { ...feet.current };
    const across = start.space !== to.space;
    const a = across ? toScreen(start) : start;
    const b = across ? toScreen(to) : to;
    const way: -1 | 1 = b.x < a.x ? -1 : 1;
    facing.current = way;
    setJob("none");
    setFace(null);
    setPose({ ...REST, look: way });
    const fly = () => {
      if (across) moveTo({ space: "screen", x: a.x, y: a.y });
      setAirborne(true);
      setPose({ ...REST, arms: "both", walking: true, look: way });
      const plan = leapPlan(a, b);
      timed(plan.ms, (t) => {
        const at = leapAt(plan, t * plan.ms);
        feet.current.x = at.x;
        feet.current.y = at.y;
        Object.assign(shape.current, flightAt(t));
      }, () => {
        setAirborne(false);
        rest();
        if (options.land === false) { setPose(REST); then(); return; }
        moveTo(to);
        land(options.impact ?? 0.5, then);
      });
    };
    if (options.crouch === false || still) { fly(); return; }
    timed(CROUCH_MS, (t) => { Object.assign(shape.current, crouchAt(t)); }, fly);
  };

  /**
   * A spot to stroll to on its box: mostly a short way along, sometimes far, never over the chat.
   * With nowhere clear, it goes to where it covers least and stays there.
   */
  const nextSpot = (working: boolean) => {
    const current = composer.current;
    if (!current) return null;
    const width = working ? WIDTH + 40 : WIDTH + 8;
    const { length, blocked } = blockedOn(current);
    return pickClear(clearSpans(length, blocked, width), feet.current.x, Math.random, working ? 0.4 : 0.25)
      ?? leastCovered(length, blocked, width, feet.current.x);
  };
  /** One thing to do on arriving somewhere, so a stroll never looks like sliding. */
  const act = () => {
    if (busy()) return;
    if (moodNow.current === "working") {
      // At work: settle at a tool for a while; carrying walks on to drop the box somewhere.
      const next = pick(WORK);
      if (next === "carry") {
        const to = nextSpot(true);
        if (to !== null) { setJob("carry"); walkTo(to, SCURRY * 0.8, () => { setJob("none"); play("jump"); }); }
        return;
      }
      setJob(next);
      later(5000 + Math.random() * 4000, () => setJob("none"));
      return;
    }
    // At either end of its box it often stops to peer out over the edge.
    const current = boxNow.current;
    const x = feet.current.x;
    if (current && Number.isFinite(x) && (x < WIDTH * 1.25 || x > current.width - WIDTH * 1.25) && Math.random() < 0.45) { play("peer"); return; }
    const choice = pick(["play", "play", "fun", "sit", "muse", "coffee", "read", "rest", "stretch"] as const);
    if (choice === "play") play(pickOne(CLICKABLE));
    else if (choice === "fun") play(pickOne(PLAYFUL));
    else if (choice === "stretch") play(moodNow.current === "idle" && Math.random() < 0.5 ? "yawn" : "stretch");
    else if (choice === "sit") { setPose({ ...REST, sit: true }); later(2600, () => setPose(REST)); }
    else if (choice === "coffee" || choice === "read") { setJob(choice); later(3500 + Math.random() * 2500, () => setJob("none")); }
    else if (choice === "muse" && moodNow.current === "idle") say(pick(MUSINGS), 1500);
  };
  /** The wander loop: a pause (or a job), a walk somewhere clear, an action, again. One loop at a time. */
  const wander = () => {
    window.clearTimeout(wanderTimer.current);
    if (still) return;
    const working = moodNow.current === "working";
    const pause = working ? 5500 + Math.random() * 4000 : 2200 + Math.random() * 3200;
    wanderTimer.current = window.setTimeout(() => {
      // Hidden or minimized, nobody sees it stroll: it waits instead of measuring the page for a spot.
      const away = document.hidden || document.documentElement.hasAttribute("data-window-away");
      if (away || busy() || motion.current || moodNow.current === "ask" || moodNow.current === "error") { wander(); return; }
      setJob("none");
      const to = nextSpot(working);
      if (to === null || Math.abs(to - feet.current.x) < 8) { act(); wander(); return; }
      walkTo(to, working ? SCURRY : STROLL, () => { act(); wander(); });
    }, pause);
  };
  /** It runs along to the send button's end of the box and jumps for attention. */
  const runToSend = () => {
    const current = boxNow.current;
    if (still || !current || busy()) return;
    walkTo(restNear(current.width - WIDTH / 2), SCURRY * 1.4, () => play("jump"));
  };
  /** Back on its box from somewhere else: on with the chat's mood, and its wander. */
  const settleOut = () => {
    activity.current = "box";
    remember();
    poke();
    if (moodNow.current === "ask") runToSend();
    else if (moodNow.current === "working") setJob("laptop");
    wander();
  };
  /**
   * From wherever it is off its box (in the air, by its cottage, in the yard), a leap back onto its
   * box's top edge. Anything that interrupts a trip (a turn starting mid-way) brings it back this way,
   * so it is never left half through a door or hanging in the air.
   */
  const flyBack = (then: () => void = settleOut) => {
    stopMotion();
    setAirborne(false);
    setFace(null);
    setDoorOpen(false);
    const current = boxNow.current;
    const parent = composer.current;
    if (!current || !parent) return;
    const at = feet.current;
    // Still on its box's top edge (stopped mid-walk): it is back already.
    if (at.space === "box" && at.y === 0 && Number.isFinite(at.x)) { rest(); paint(); then(); return; }
    activity.current = "travel";
    const x = restNear(toScreen(at).x - parent.getBoundingClientRect().left);
    if (!Number.isFinite(at.x)) { rest(); moveTo({ space: "box", x, y: 0 }); then(); return; }
    shape.current.shrink = 1;
    shape.current.fade = 1;
    leapTo({ space: "box", x, y: 0 }, then, { crouch: false, impact: 0.4 });
  };

  /** Over to another pane's box (split view): it leaps onto that box's top edge, and the pet there carries on. */
  const hop = (pane: HTMLElement, line: string) => {
    const seat = petStage.seats().get(pane);
    if (!split || !seat || pane === split.pane || !seat.composer.isConnected || seat.composer.offsetWidth < 2 * WIDTH) return false;
    cancelPlans();
    setJob("none");
    if (asleepNow.current) { asleepNow.current = false; setAsleep(false); }
    activity.current = "travel";
    const from = toScreen(feet.current);
    const frame = seat.composer.getBoundingClientRect();
    const along = spotOn(seat.composer, from.x - frame.left) ?? clamp(from.x - frame.left, WIDTH / 2, frame.width - WIDTH / 2);
    leapTo({ space: "screen", x: frame.left + along, y: frame.top }, () => {
      if (petStage.handoff(pane, { x: along, carry: false, line })) return;
      // That pane closed mid-leap: back to its own box.
      flyBack();
    }, { land: false });
    return true;
  };
  /** Bedtime with no cottage to go to: it curls up where it stands. */
  const napHere = () => {
    cancelPlans();
    setJob("none");
    say("Nap time…", 1300);
    asleepNow.current = true;
    setAsleep(true);
    setPose({ ...REST, sit: true });
  };

  /** In through the cottage's door from the doorstep: its back to us, smaller through the doorway, gone; the door shuts. */
  const enterDoor = (then: () => void) => {
    setDoorOpen(true);
    setPose(REST);
    setFace({ pose: { facing: "back" }, offset: 0 });
    later(still ? 0 : 160, () => {
      const base = feet.current.y;
      timed(DOOR_MS, (t) => {
        const e = t * t * (3 - 2 * t);
        shape.current.shrink = 1 - (1 - DOOR_SCALE) * e;
        shape.current.fade = t < 0.65 ? 1 : Math.max(0, 1 - (t - 0.65) / 0.35);
        feet.current.y = base - 8 * e;
      }, () => {
        feet.current.y = base;
        rest();
        setFace(null);
        activity.current = "home";
        setInside(true);
        afterDecoration(still ? 0 : 260, () => setDoorOpen(false));
        then();
      });
    });
  };
  /** Out through the door onto the doorstep, growing back to full size as it steps out; then `then`. */
  const exitDoor = (from: Place, then: () => void) => {
    activity.current = "travel";
    rest();
    shape.current.shrink = DOOR_SCALE;
    shape.current.fade = 0;
    moveTo({ ...from, y: from.y - 8 });
    setScene(null);
    setJob("none");
    setFace(null);
    setPose(REST);
    setInside(false);
    setDoorOpen(true);
    later(still ? 0 : 180, () => timed(DOOR_MS, (t) => {
      const e = 1 - (1 - t) * (1 - t);
      shape.current.shrink = DOOR_SCALE + (1 - DOOR_SCALE) * e;
      shape.current.fade = Math.min(1, t / 0.3);
      feet.current.y = from.y - 8 * (1 - e);
    }, () => {
      rest();
      feet.current.y = from.y;
      afterDecoration(still ? 0 : 240, () => setDoorOpen(false));
      then();
    }));
  };

  /**
   * Home to its cottage: along its box to the end nearest the cottage, a hop down (or a leap across to
   * the yard) onto the doorstep, and in through the door. Bedtime (`nap`) takes it to bed; a visit does
   * a couple of chores, or `chore` first when you clicked a piece of furniture, and comes back out.
   */
  const goHome = (nap = true, chore?: Chore) => {
    if (activity.current === "home") {
      if (nap && !asleepNow.current) { cancelPlans(); visitLeft.current = 0; homeLife("sleep"); }
      return;
    }
    if (activity.current !== "box" || drag.current) return;
    const step = doorstep();
    const current = boxNow.current;
    if (!step || !current) { if (nap) napHere(); return; }
    cancelPlans();
    setJob("none");
    if (asleepNow.current) { asleepNow.current = false; setAsleep(false); }
    activity.current = "travel";
    const comeIn = () => enterDoor(() => {
      visitLeft.current = nap ? 0 : VISIT_CHORES;
      later(still ? 0 : 350, () => homeLife(nap ? "sleep" : chore));
    });
    const speed = nap ? STROLL * 1.3 : SCURRY;
    // Beside the box: to its right end and a hop down. In the yard: to its left end, nearest the chat list, and a leap across.
    const setOff = () => walkTo(step.space === "box" ? current.width - WIDTH / 2 : WIDTH / 2, speed,
      () => leapTo(step, comeIn, { impact: step.space === "box" ? 0.35 : 0.45 }));
    // Bedtime starts with a yawn where it stands; a visit is straight off.
    if (nap && !still) {
      play("yawn");
      say("*yawn*", 1100);
      later(1300, () => { say("Home time…", 1300); setOff(); });
    } else {
      say(nap ? "Home time…" : "Coming!", 1300);
      setOff();
    }
  };
  /**
   * Out of its cottage (toward `toward`'s pane when another pane called it). Watched through the peek,
   * it gets out of bed, down the ladder and across to the door first; unwatched, it is straight out.
   */
  const goOut = (toward?: HTMLElement) => {
    if (toward) outToward.current = toward;
    if (activity.current !== "home") return;
    cancelPlans();
    asleepNow.current = false;
    setAsleep(false);
    const hurry = moodNow.current === "ask" ? HURRY : 1;
    if (peekNow.current) homeRun(exitBeats(homePlace()).map((beat) => ({ ...beat, ms: Math.round(beat.ms * hurry) })), leaveHome);
    else leaveHome();
  };
  /** Through the door and onto its box: a hop up beside the box, or a leap from the yard to the pane that called it. */
  const leaveHome = () => {
    const step = doorstep();
    const current = boxNow.current;
    setPeek(false);
    if (!step || !current) {
      // Its cottage went away (the window narrowed, the chat list closed): it is back on its box.
      activity.current = "travel";
      setInside(false);
      setScene(null);
      rest();
      moveTo({ space: "box", x: restNear(current ? current.width - WIDTH / 2 : WIDTH), y: 0 });
      land(0.3, settleOut);
      return;
    }
    exitDoor(step, () => {
      const toward = outToward.current;
      outToward.current = null;
      if (split) {
        const focused = petStage.focused();
        const pane = toward ?? (focused && focused !== split.pane && petStage.seats().has(focused) ? focused : null);
        if (pane && hop(pane, "")) return;
      }
      const x = restNear(step.space === "box" ? current.width - WIDTH / 2 - 12 : 1.5 * WIDTH);
      leapTo({ space: "box", x, y: 0 }, settleOut, { impact: 0.4 });
    });
  };
  /** Plays home beats one after another, each for its ms (a move takes that long to get there), then `done`. */
  const homeRun = (beats: HomeBeat[], done?: () => void) => {
    const [beat, ...rest] = beats;
    if (!beat) { done?.(); return; }
    sceneNow.current = beat;
    setScene(beat);
    const moving = beat.doing === "walk" || beat.doing === "climb" || beat.doing === "serve";
    setPose({ ...REST, look: beat.look, walking: moving, stride: beat.doing === "walk", arms: beat.doing === "climb" ? "both" : "down" });
    setJob(beat.doing === "cook" || beat.doing === "snack" || beat.doing === "serve" || beat.doing === "read" ? beat.doing : "none");
    if (beat.say) say(beat.say, Math.min(1800, beat.ms + 600));
    if (beat.float) float(beat.float, 26);
    later(still && (moving || beat.doing === "hop") ? 0 : beat.ms, () => homeRun(rest, done));
  };
  const homePlace = (): HomeBeat => sceneNow.current ?? { ...ENTRY, doing: "stand", look: 0, ms: 0 };
  /**
   * One chore (`chore`, else one it picks), then the next until the visit is over, then out to its
   * box. While you look in through the peek it stays and keeps busy. Sleep ends in bed, asleep, until
   * something wakes it.
   */
  const homeLife = (chore?: Chore) => {
    if (activity.current !== "home" || asleepNow.current) return;
    if (!chore && visitLeft.current <= 0 && !peekNow.current) { goOut(); return; }
    if (!chore && visitLeft.current > 0) visitLeft.current -= 1;
    const memory = homeMemory.current;
    const next = chore ?? pickChore({ ...memory, hour: new Date().getHours() });
    homeRun(choreBeats(next, homePlace()), () => {
      homeMemory.current = { last: next, sinceMeal: next === "cook" || next === "snack" ? 0 : memory.sinceMeal + 1, hour: 0 };
      if (next === "sleep") { asleepNow.current = true; setAsleep(true); return; }
      homeLife();
    });
  };
  /** A piece of furniture clicked in the peek: Clawd comes home if it is out, and goes to use it. */
  const toFurniture = (chore: Chore) => {
    poke();
    if (activity.current === "box") { goHome(chore === "sleep", chore === "sleep" ? undefined : chore); return; }
    if (activity.current !== "home") return;
    if (asleepNow.current && chore === "sleep") return;
    cancelPlans();
    // Up now, not at the next render: homeLife reads it right away.
    if (asleepNow.current) { asleepNow.current = false; setAsleep(false); say("Huh? Okay!", 1200); }
    visitLeft.current = Math.max(visitLeft.current, 1);
    homeLife(chore);
  };
  /** Clawd clicked in the peek: up out of bed if it was asleep, and on with a chore. */
  const wakeInside = () => {
    poke();
    if (activity.current !== "home" || !asleepNow.current) return;
    cancelPlans();
    asleepNow.current = false;
    setAsleep(false);
    say("Huh? I'm up.", 1400);
    visitLeft.current = Math.max(visitLeft.current, 1);
    homeLife();
  };
  /** The cottage clicked: the peek opens (or closes), and Clawd, if it is out on its box, comes home to show you round. */
  const onCottage = () => {
    if (peekNow.current) { setPeek(false); return; }
    peekNow.current = true;
    setPeek(true);
    poke();
    if (activity.current === "box") goHome(false);
  };
  // One function for the peek's lifetime, so its outside-click and Escape listeners are set up once.
  const closePeek = useRef(() => setPeek(false)).current;
  // Nothing running for a while: it goes home to sleep. Any touch, or the agent starting, wakes it.
  const poke = () => {
    window.clearTimeout(napTimer.current);
    napTimer.current = window.setTimeout(() => {
      if ((moodNow.current === "idle" || moodNow.current === "done") && activity.current === "box" && !drag.current) goHome();
    }, NAP_MS);
  };
  /** Napping on its box: up, and on with its day. */
  const wake = () => {
    if (!asleepNow.current || activity.current !== "box") return false;
    asleepNow.current = false;
    setAsleep(false);
    setPose(REST);
    say("Huh? I'm up.", 1500);
    play("stretch");
    poke();
    cancelPlans();
    wander();
    return true;
  };

  /** It leaps off the pointer back onto its box below where the pointer is (never onto the chat). */
  const leave = () => {
    window.clearTimeout(rideTimer.current);
    if (activity.current !== "ride") return;
    setRiding(false);
    const current = boxNow.current;
    const parent = composer.current;
    if (!current || !parent) return;
    activity.current = "travel";
    const x = restNear(clamp(pointer.current.x - parent.getBoundingClientRect().left, WIDTH / 2, current.width - WIDTH / 2));
    leapTo({ space: "box", x, y: 0 }, () => {
      activity.current = "box";
      remember();
      poke();
      cancelPlans();
      // Shaken off, it comes round from a dizzy spell. (Not "✦": rising stars read as fireworks, 2026-10-30.)
      if (dizzy.current) { dizzy.current = false; play("dizzy"); float("💫", 28); }
      wander();
    }, { crouch: false, impact: 0.5 });
  };
  /** It leaps onto the pointer: for a short hug with hearts, or for a ride of a few seconds. */
  const board = (stay: number) => {
    cancelPlans();
    setJob("none");
    activity.current = "ride";
    setRiding(true);
    // Sitting on the pointer's tip, a little behind it as it moves.
    const seat = (): Place => ({ space: "screen", x: pointer.current.x, y: pointer.current.y - 2 });
    leapTo(seat(), () => {
      if (activity.current !== "ride") return;
      setPose({ ...REST, walking: true });
      float("♥", 18); float("♥", 40);
      afterDecoration(200, () => float("♥", 28));
      say(stay > 2000 ? pick(RIDING) : "Hi!", 1400);
      let last = Number.NaN;
      animate((now) => {
        const ms = Number.isNaN(last) ? 16 : now - last;
        last = now;
        const goal = seat();
        const before = feet.current.x;
        feet.current.x = follow(feet.current.x, goal.x, ms);
        feet.current.y = follow(feet.current.y, goal.y, ms);
        const moved = feet.current.x - before;
        const way = moved < -0.6 ? -1 : moved > 0.6 ? 1 : 0;
        if (way && way !== facing.current) { facing.current = way; setPose((current) => ({ ...current, look: way })); }
        return activity.current === "ride";
      });
      window.clearTimeout(rideTimer.current);
      rideTimer.current = window.setTimeout(leave, Math.min(stay, MAX_RIDE));
    }, { land: false });
  };

  // First placement, once the box is measured: where it just leapt to from another pane, else where
  // it was left, else near the right end.
  useEffect(() => {
    if (!box || placed) return;
    const arrival = split ? petStage.arrivalFor(split.pane) : null;
    let x = Number.NaN;
    if (arrival) x = arrival.x;
    else {
      try {
        const saved = Number(localStorage.getItem(POSITION_KEY) ?? Number.NaN);
        if (saved >= 0 && saved <= 1) x = saved * box.width;
        OLD_KEYS.forEach((key) => localStorage.removeItem(key));
      } catch { /* first visit */ }
      if (!Number.isFinite(x)) x = box.width - 2 * WIDTH;
      // Never over the chat's last line or a chip, even where it was left.
      x = restNear(clamp(x, WIDTH / 2, box.width - WIDTH / 2));
    }
    activity.current = "box";
    moveTo({ space: "box", x: clamp(x, WIDTH / 2, box.width - WIDTH / 2), y: 0 });
    setPlaced(true);
    if (arrival) {
      // Landed here from another pane: the landing it leapt into, a word, and on with its day.
      land(0.55, () => {
        if (arrival.line) say(arrival.line, 1600);
        remember();
        poke();
        if (moodNow.current === "ask") runToSend();
        wander();
      });
      return;
    }
    if (!entrancePlayed && !still) { entrancePlayed = true; play(pickOne(ENTRANCES)); }
  }, [box]);
  // React has drawn it in the space it went to: paint it there now, before the page shows.
  useLayoutEffect(() => {
    spaceNow.current = space;
    paint();
    if (space !== "screen") petFlight.set(null);
  }, [space, inside, placed]);
  // Read when it goes over the page or the peek opens, so a theme switched since is picked up.
  useLayoutEffect(() => {
    if ((space === "screen" || peek) && composer.current) setPalette(chatPalette(composer.current));
  }, [space, peek]);
  // Its cottage went away (the window narrowed, the chat list closed) while it was in it or on its way:
  // it is back on its box.
  useEffect(() => {
    if (houseAt) return;
    if (activity.current === "home") { cancelPlans(); leaveHome(); }
    else if (activity.current === "travel" && feet.current.space !== "box") { cancelPlans(); flyBack(); }
    setPeek(false);
  }, [houseAt]);

  // React to the agent: each mood gets its own little scene, then the wander loop resumes.
  useEffect(() => {
    cancelPlans();
    // On the pointer: it jumps off. In its house: it comes out through the door. On its way somewhere:
    // back onto its box. It takes up the new mood's scene once it is back (settleOut).
    if (activity.current === "ride") leave();
    else if (activity.current === "home") goOut();
    else if (activity.current === "travel") flyBack();
    else if (activity.current === "box") {
      asleepNow.current = false;
      setAsleep(false);
      setPose(REST);
      setJob("none");
    }
    poke();
    if (mood === "done") {
      setCheering(true);
      float("✓");
      play(Math.random() < 0.5 ? "celebrate" : "dance");
      const timer = window.setTimeout(() => setCheering(false), CHEER_MS);
      wander();
      return () => { window.clearTimeout(timer); cancelPlans(); };
    }
    setCheering(false);
    if (mood === "working" && !still) later(400, () => {
      // Still out somewhere: it takes up its laptop once it is back (settleOut).
      if (busy() || motion.current || moodNow.current !== "working") return;
      const spot = restNear(feet.current.x, WIDTH + 40);
      if (Math.abs(spot - feet.current.x) > 4) walkTo(spot, SCURRY, () => { if (moodNow.current === "working") setJob("laptop"); });
      else setJob("laptop");
    });
    if (mood === "error") { play("sad"); say("Uh oh", 1600); }
    if (mood === "ask") { say(LINES.ask, 2600); runToSend(); }
    wander();
    return cancelPlans;
  }, [mood]);
  // A request waiting on you: by the send button it taps its feet, hops or waves now and then, a few
  // times, so a request you missed still catches your eye without it pestering for ever.
  useEffect(() => {
    if (mood !== "ask" || still) return undefined;
    let nudges = 0;
    const timer = window.setInterval(() => {
      if (busy() || motion.current || playingNow.current) return;
      play(pickOne(["tap", "jump", "wave"] as const));
      if (++nudges >= NUDGES) window.clearInterval(timer);
    }, NUDGE_MS);
    return () => window.clearInterval(timer);
  }, [mood, still]);

  // Split view: another pane's chat calls it over (a request waiting on you, a finished turn, a
  // failure), and it now and then follows you into the pane you click into.
  useEffect(() => {
    if (!split || still) return undefined;
    let following = 0;
    const off = petStage.subscribe((event) => {
      if (event.kind === "host" || event.pane === split.pane) return;
      if (drag.current || activity.current === "held" || activity.current === "ride" || activity.current === "travel" || moodNow.current === "ask") return;
      if (event.kind === "mood") {
        const line = petCall(event.mood, event.was, Math.random());
        if (line === null) return;
        window.clearTimeout(following);
        if (activity.current === "home") { goOut(event.pane); return; }
        hop(event.pane, line);
        return;
      }
      window.clearTimeout(following);
      const calm = moodNow.current === "idle" || moodNow.current === "done";
      if (!calm || asleepNow.current || activity.current !== "box" || Math.random() >= FOLLOW_CHANCE) return;
      following = window.setTimeout(() => { if (!busy() && petStage.focused() === event.pane) hop(event.pane, pick(FOLLOWING)); }, FOLLOW_MS);
    });
    return () => { off(); window.clearTimeout(following); };
  }, []);
  const full = context !== null && context >= 0.8;
  useEffect(() => { if (full) say("I'm getting full. Compact soon?", 2600); }, [full]);

  // At work its arms and tools keep a beat; at home so do its chores (the pot's lid, the bubbles, the
  // bites, the laptop's lines, its feet across the floor); carried or riding, its feet kick.
  const homeBusy = inside && scene !== null && scene.doing !== "stand";
  const homeWalking = inside && scene !== null && (scene.doing === "walk" || scene.doing === "climb" || scene.doing === "serve");
  const beating = !asleep && (mood === "working" || job !== "none" || homeBusy || riding || held);
  useEffect(() => {
    if (!beating) { setStep(false); return undefined; }
    const beat = homeWalking || riding || held ? 140 : job === "build" ? 260 : job === "coffee" || job === "read" ? 900 : 200;
    const timer = window.setInterval(() => { setStep((current) => !current); setTick((current) => current + 1); }, beat);
    return () => window.clearInterval(timer);
  }, [beating, homeWalking, riding, held, job]);
  // Light code bubbles make the typing recognizable without replacing Clawd's original pixels.
  useEffect(() => { if (job === "laptop" && step && tick % 4 === 0 && !still && !inside) float("{}", 20); }, [job, step, tick, still]);
  // While the agent works, Claude Code's spinner turns over its head.
  const spinning = mood === "working" && !asleep && job !== "carry" && !riding && !inside;
  useEffect(() => {
    if (!spinning || still) { setSpin(0); return undefined; }
    const timer = window.setInterval(() => setSpin((current) => (current + 1) % SPINNER.length), 120);
    return () => window.clearInterval(timer);
  }, [spinning, still]);
  // Awake, it blinks now and then.
  useEffect(() => {
    if (asleep || still) return undefined;
    let timer = 0;
    const next = () => {
      timer = window.setTimeout(() => {
        setBlink(true);
        timer = window.setTimeout(() => { setBlink(false); next(); }, 120);
      }, 2500 + Math.random() * 3500);
    };
    next();
    return () => { window.clearTimeout(timer); setBlink(false); };
  }, [asleep, still]);

  // It watches the pointer when it comes near, now and then leaps onto it, waves when it rests
  // nearby, wanders over when it rests over its box further along, and perks up while you type in
  // the box and when you send.
  useEffect(() => {
    if (still) return undefined;
    let timer = 0;
    let moved = 0;
    let linger = 0;
    let lastWave = 0;
    let lastVisit = 0;
    const onMove = (event: PointerEvent) => {
      moved += event.clientX - pointer.current.x;
      pointer.current = { x: event.clientX, y: event.clientY };
      window.clearTimeout(linger);
      linger = window.setTimeout(rested, LINGER_MS);
      // Aboard, the frame clock follows the pointer and these checks only catch a shake. Otherwise it
      // only turns its head or starts a game, which ten checks a second cover.
      if (timer) return;
      timer = window.setTimeout(check, LOOK_EVERY_MS);
    };
    /** Where the pointer is from Clawd: its offset, and its distance from Clawd's middle. */
    const fromPet = () => {
      const { x, y } = pointer.current;
      const at = toScreen(feet.current);
      return { x, y, at, distance: Math.hypot(x - at.x, y - (at.y - FEET / 2)) };
    };
    // The pointer has come to rest while it is calm on its box: close by, a wave hello; over its box
    // further along, now and then a walk over to see, stopping beside the pointer, facing it.
    const rested = () => {
      linger = 0;
      if (activity.current !== "box" || asleepNow.current || drag.current || feet.current.space !== "box"
        || motion.current || playingNow.current || !(moodNow.current === "idle" || moodNow.current === "done")) return;
      const { x, y, at, distance } = fromPet();
      const now = Date.now();
      if (distance < NOTICE) {
        if (now - lastWave < WAVE_EVERY) return;
        lastWave = now;
        setPose((current) => (current.walking ? current : { ...current, look: x < at.x ? -1 : 1 }));
        play("wave");
        return;
      }
      const frame = composer.current?.getBoundingClientRect();
      if (!frame || x < frame.left || x > frame.right || y < frame.top - 140 || y > frame.bottom) return;
      if (now - lastVisit < VISIT_EVERY || Math.random() >= 0.35) return;
      lastVisit = now;
      const side = x < at.x ? 1 : -1;
      walkTo(restNear(x - frame.left + side * WIDTH * 0.75), STROLL * 1.5, () => {
        const there = fromPet();
        setPose({ ...REST, look: there.x < there.at.x ? -1 : 1 });
        if (there.distance < NOTICE * 1.5) { lastWave = Date.now(); play("wave"); }
      });
    };
    const check = () => {
      timer = 0;
      const dx = moved;
      moved = 0;
      if (activity.current === "ride") {
        // Shaken hard, it lets go and jumps back to the box, dizzy.
        if (Math.abs(dx) > SHAKE) { dizzy.current = true; say("Whoa!", 900); leave(); }
        return;
      }
      if (activity.current !== "box" || asleepNow.current || drag.current || feet.current.space !== "box") return;
      const { x, y } = pointer.current;
      const at = toScreen(feet.current);
      const middle = at.x;
      const distance = Math.hypot(x - middle, y - (at.y - FEET / 2));
      const calm = moodNow.current === "idle" || moodNow.current === "done";
      if (calm && distance < REACH && !motion.current && Date.now() - lastPlay.current > PLAY_EVERY && Math.random() < 0.6) {
        lastPlay.current = Date.now();
        board(Math.random() < 0.5 ? 1200 : 2200 + Math.random() * 1800);
        return;
      }
      setPose((current) => {
        if (current.walking || current.sit) return current;
        const look: Pose["look"] = distance > NOTICE ? 0 : x < middle - 12 ? -1 : x > middle + 12 ? 1 : 0;
        return current.look === look ? current : { ...current, look };
      });
    };
    let lastTyped = 0;
    const form = composer.current ?? anchor.current?.parentElement;
    const onInput = () => {
      const now = Date.now();
      if (now - lastTyped < 1500 || asleepNow.current || activity.current !== "box") return;
      lastTyped = now;
      play("wink");
      poke();
    };
    // Enter sends: once the box has emptied, it hops and sends a letter off. The chat clears the box
    // itself, which fires no input event, so it is read again a moment after the key.
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Enter" || event.shiftKey || event.isComposing) return;
      const field = event.target instanceof HTMLElement ? event.target : null;
      const text = () => (field instanceof HTMLTextAreaElement || field instanceof HTMLInputElement ? field.value : field?.textContent ?? "").trim();
      if (!text()) return;
      afterDecoration(250, () => {
        if (text() || asleepNow.current || activity.current !== "box" || playingNow.current) return;
        play("jump");
        float("✉", 30);
        if (Math.random() < 0.5) say(pick(SENT), 1100);
      });
    };
    window.addEventListener("pointermove", onMove);
    form?.addEventListener("input", onInput);
    form?.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("pointermove", onMove);
      form?.removeEventListener("input", onInput);
      form?.removeEventListener("keydown", onKey);
      if (timer) window.clearTimeout(timer);
      window.clearTimeout(linger);
    };
  }, [still]);

  // While it rides: any click or Escape makes it jump off, and it hops, winks and looks about.
  useEffect(() => {
    if (!riding) return undefined;
    const off = () => leave();
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") leave(); };
    window.addEventListener("pointerdown", off, true);
    window.addEventListener("keydown", onKey, true);
    const timer = window.setInterval(() => play(pickOne(RIDE_PLAYS)), 1600);
    return () => {
      window.removeEventListener("pointerdown", off, true);
      window.removeEventListener("keydown", onKey, true);
      window.clearInterval(timer);
    };
  }, [riding]);

  useEffect(() => () => {
    decorationTimers.current.forEach((timer) => window.clearTimeout(timer));
    decorationTimers.current.clear();
    window.clearTimeout(rideTimer.current); window.clearTimeout(clickTimer.current); window.clearTimeout(bubbleTimer.current);
    window.clearTimeout(napTimer.current);
    dragEnd.current?.(); cancelPlans();
    petFlight.set(null);
  }, []);

  /** Picked up and moved: it follows the pointer anywhere on the screen, held by its middle, feet kicking. */
  const dragMove = (clientX: number, clientY: number) => {
    const state = drag.current;
    if (!state) return;
    if (!state.moved) {
      if (Math.hypot(clientX - state.x, clientY - state.y) <= 4) return;
      state.moved = true;
      cancelPlans();
      setJob("none");
      setFace(null);
      setAirborne(false);
      rest();
      if (asleepNow.current) { asleepNow.current = false; setAsleep(false); }
      activity.current = "held";
      setHeld(true);
    }
    const way: -1 | 0 | 1 = clientX < state.lastX - 1 ? -1 : clientX > state.lastX + 1 ? 1 : 0;
    state.lastX = clientX;
    state.lastY = clientY;
    if (way) facing.current = way;
    setPose((current) => current.walking && current.look === facing.current ? current : { ...REST, walking: true, look: facing.current });
    moveTo({
      space: "screen",
      x: clamp(clientX, WIDTH / 2, window.innerWidth - WIDTH / 2),
      y: clamp(clientY, HEIGHT / 2, window.innerHeight - HEIGHT / 2) + FEET - HEIGHT / 2,
    });
  };
  /**
   * Let go, it falls under gravity onto the top edge of the box under where it was let go (another
   * pane's box, in split view), arms up and feet kicking, its shadow growing where it will land. It
   * lands harder the further it fell, with a word after a big drop and a hop after a middling one.
   * Let go below the box's top edge, it hops up onto it instead.
   */
  const dragDrop = () => {
    const state = drag.current;
    drag.current = null;
    if (!state?.moved) return;
    setHeld(false);
    const parent = composer.current;
    const current = boxNow.current;
    if (!parent || !current) { activity.current = "box"; return; }
    const other = otherPanes().find((pane) => {
      const frame = pane.getBoundingClientRect();
      return state.lastX >= frame.left && state.lastX <= frame.right && state.lastY >= frame.top && state.lastY <= frame.bottom;
    });
    const target = (other && petStage.seats().get(other)?.composer) || parent;
    const frame = target.getBoundingClientRect();
    const along = spotOn(target, state.lastX - frame.left) ?? clamp(state.lastX - frame.left, WIDTH / 2, frame.width - WIDTH / 2);
    const to = { x: frame.left + along, y: frame.top };
    const from = { x: feet.current.x, y: feet.current.y };
    activity.current = "travel";
    const arrive = (impact: number, line: string | null, bounce: boolean) => {
      if (target !== parent && other && petStage.handoff(other, { x: along, carry: false, line: line ?? "" })) return;
      activity.current = "travel";
      moveTo({ space: "box", x: along, y: 0 });
      if (line) say(line, 1100);
      land(impact, () => {
        activity.current = "box";
        if (bounce) play("jump");
        // A drop from near the top of the window: dizzy for a moment.
        else if (impact >= 0.9) { play("dizzy"); float("💫", 28); }
        remember();
        poke();
        wander();
      });
    };
    if (from.y > to.y - 12) {
      leapTo({ space: "screen", ...to }, () => arrive(0.35, null, false), { land: false, crouch: false });
      return;
    }
    const plan = fallPlan(from, to);
    const height = to.y - from.y;
    if (height > 40) say("Wheee", 900);
    setPose({ ...REST, arms: "both", walking: true, look: facing.current });
    if (target === parent) setDrop({ x: along, ms: plan.ms });
    setAirborne(true);
    timed(plan.ms, (t) => {
      const at = fallAt(plan, t * plan.ms);
      feet.current.x = at.x;
      feet.current.y = at.y;
      Object.assign(shape.current, { sx: 1 - 0.05 * t, sy: 1 + 0.08 * t });
    }, () => {
      setAirborne(false);
      setDrop(null);
      rest();
      arrive(impactOf(plan.speed), height >= 300 ? "Oof!" : height >= 160 ? "Nailed it" : null, height >= 80 && height < 300);
    });
  };

  const onPointerDown = (event: ReactPointerEvent<HTMLButtonElement>) => {
    if (event.button !== 0 || drag.current || activity.current === "held" || activity.current === "ride") return;
    drag.current = { moved: false, x: event.clientX, y: event.clientY, lastX: event.clientX, lastY: event.clientY };
    // The window follows the drag: carried off the box, Clawd moves onto the page itself. Only the
    // pointer that picked it up counts: a second finger or a pen neither moves nor drops it.
    const id = event.pointerId;
    const move = (moved: PointerEvent) => { if (moved.pointerId === id) dragMove(moved.clientX, moved.clientY); };
    const end = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
      dragEnd.current = null;
    };
    const up = (released: PointerEvent) => { if (released.pointerId !== id) return; end(); dragDrop(); };
    dragEnd.current = end;
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
  };

  const shown: PetMood = mood === "done" && !cheering ? "idle" : mood;
  const percent = context === null ? null : Math.round(context * 100);
  // Tools go on the box's inward side, so a laptop never disappears past its end; at home it holds
  // things on the side it faces (the ladle toward the stove, the cookie toward the fridge).
  const toolSide = inside && scene ? (scene.look < 0 ? "left" : "right")
    : box && Number.isFinite(feet.current.x) ? petToolSide(feet.current.x, box.width) : "left";
  const frame: Frame = face ?? clawd.frame ?? restFrame({ mood: shown, asleep, job, toolSide,
    step: pose.walking && !riding && !held && !inside ? foot : step,
    // Chewing at the table: its eyes squeeze shut on each bite.
    blink: blink || (inside && scene?.doing === "eat" && step), pose });
  const label = `Bit the pet: ${asleep ? "napping" : LINES[shown]}${percent !== null ? ` Context ${percent}%.` : ""}`;
  const pet = <div ref={el} className={`cx-pet${space === "screen" ? " is-screen" : ""}${held ? " is-held" : ""}${riding ? " is-riding" : ""}${airborne ? " is-flying" : ""}`}
    style={{ ...(space === "screen" ? palette : {}), ...(placed ? {} : { visibility: "hidden" }), ...(landed ? { "--cx-pet-impact": landed.impact } as CSSProperties : {}) }}>
    {bubble ? <span className="cx-pet-bubble" role="status">{bubble}</span> : null}
    {/* Napping on its box (no cottage to go to): z's rise over it. */}
    {asleep ? <span className="cx-pet-house-z cx-pet-nap-z" aria-hidden="true"><span>z</span><span>z</span><span>Z</span></span> : null}
    {landed ? <span key={landed.count} className="cx-pet-dusts" aria-hidden="true"><span className="cx-pet-dust is-left" /><span className="cx-pet-dust is-right" /></span> : null}
    {spinning ? <span className="cx-pet-spinner" aria-hidden="true">{SPINNER[spin]}</span> : null}
    {floaters.map((item) => <span key={item.id} className="cx-pet-float" style={{ left: item.offset }} aria-hidden="true">{item.text}</span>)}
    <button ref={body} type="button" className={`cx-pet-body is-${shown}${asleep ? " is-asleep" : ""}${pose.walking ? " is-walking" : ""}${job !== "none" ? ` is-${job} is-tool-${toolSide}` : ""}`}
      aria-label={label}
      title={asleep ? "Napping. Click to wake" : `${LINES[shown]}${percent !== null ? ` · ${percent}% context` : ""}\nClick to pet · double-click to feed · drag to move`}
      onPointerDown={onPointerDown}
      onClick={() => {
        if (drag.current?.moved) return;
        window.clearTimeout(clickTimer.current);
        clickTimer.current = window.setTimeout(() => {
          if (wake()) return;
          const now = Date.now();
          pets.current = [...pets.current.filter((at) => now - at < PET_STREAK_MS), now];
          poke();
          // Petted again and again: a happy dance and a shower of hearts.
          if (pets.current.length >= PET_STREAK) {
            pets.current = [];
            play("dance"); float("♥", 8); float("♥", 30); float("♥", 52);
            say("Best day ever!", 1500);
            return;
          }
          // As in Claude Code: a click plays one of Clawd's animations (or one of its own extras).
          play(pickOne(Math.random() < 0.25 ? PLAYFUL : CLICKABLE)); float("♥"); float("♥");
          say(pick(PETTED), 1400);
        }, 220);
      }}
      onDoubleClick={() => {
        window.clearTimeout(clickTimer.current);
        wake();
        setFed((count) => count + 1);
        float("🍪"); afterDecoration(250, () => float("nom"));
        say(fed >= 3 ? "So full. Maybe compact me?" : "Nom. Tokens are tasty", 1600);
        play("boop");
        poke();
      }}
      onContextMenu={(event) => { event.preventDefault(); onHide(); }}>
      {!asleep && job === "carry" ? <CarriedBox /> : null}
      <ClawdFrame frame={frame} />
      <Prop job={asleep || riding ? "none" : job} step={step} tick={tick} />
    </button>
  </div>;

  // Its cottage: beside the box, its floor level with the box's bottom, or in the yard under the
  // chat list. Never above the box, where it covered the chat's last messages.
  const view: HomeView = { home: inside, asleep, doing: inside ? scene?.doing ?? null : null, tick, step, bites: scene?.bites ?? 3 };
  const cottage = <Cottage home={inside} asleep={asleep} doing={view.doing} open={doorOpen} peeking={peek} onClick={onCottage} />;
  // Seen through the peek: Clawd at half size where it is in the house, moving there over the beat
  // (walking a floor, climbing the ladder, hopping onto a piece).
  const place = scene ?? { ...ENTRY, doing: "stand" as const, look: 0 as const, ms: 0 };
  const inRoom: CSSProperties = {
    left: place.x * PIXEL_W - WIDTH / 2,
    top: (FLOOR_LINE[place.storey] - place.lift) * PIXEL_H - FEET,
    transition: still || !scene ? "none" : `left ${scene.ms}ms linear, top ${scene.ms}ms ${scene.doing === "hop" ? HOP_EASE : "linear"}`,
  };
  const roomClawd = inside ? <div className="cx-pet-peek-clawd" style={inRoom}>
    {bubble ? <span className="cx-pet-bubble" role="status">{bubble}</span> : null}
    {floaters.map((item) => <span key={item.id} className="cx-pet-float" style={{ left: item.offset }} aria-hidden="true">{item.text}</span>)}
    <button type="button" className={`cx-pet-peek-sprite${job !== "none" ? ` is-tool-${toolSide}` : ""}`} aria-label={asleep ? "Clawd, asleep: click to wake it" : "Clawd"}
      onClick={wakeInside}>
      {!asleep && job === "serve" ? <CarriedPlate tick={tick} /> : null}
      <ClawdFrame frame={frame} />
      <Prop job={asleep ? "none" : job} step={step} tick={tick} bites={scene?.bites ?? 3} />
    </button>
  </div> : null;
  return <>
    <span ref={anchor} hidden />
    {houseAt === "beside" && box
      ? <span ref={cottageSpot} className="cx-pet-cottage-spot" style={{ left: box.width - box.edge + COTTAGE_GAP, top: box.height - box.edge - COTTAGE_H }}>{cottage}</span>
      : null}
    {houseAt === "yard" && yard
      ? createPortal(<div ref={lot} className="cx-pet-lot"><span ref={cottageSpot} className="cx-pet-cottage-spot">{cottage}</span>
        {space === "yard" && !inside ? pet : null}</div>, yard)
      : null}
    {drop ? <span className="cx-pet-drop-shadow" aria-hidden="true" style={{ left: drop.x, animationDuration: `${drop.ms}ms` }} /> : null}
    {!inside && space === "box" ? pet : null}
    {!inside && space === "screen" && typeof document !== "undefined" ? createPortal(pet, document.body) : null}
    {peek && houseAt && typeof document !== "undefined"
      ? createPortal(<HousePeek view={view} anchor={() => cottageSpot.current?.getBoundingClientRect() ?? null} clawd={roomClawd}
        palette={palette} onUse={toFurniture} onClose={closePeek} />, document.body)
      : null}
  </>;
}

/**
 * Bit on a chat box. Outside split view each chat box has its own; in split view there is one for
 * all the panes, living on one pane's box at a time (chat-pet-stage.ts): every other pane only
 * offers it a seat, its box and its chat's mood, and draws nothing.
 */
function VisibleChatPet(props: PetProps) {
  const anchor = useRef<HTMLSpanElement>(null);
  // The split pane this box is in, null outside split view. Read from the split grid: opening a
  // split marks the same grid (data-split) without remounting the window's own chat.
  const [pane, setPane] = useState<HTMLElement | null>(null);
  const host = useSyncExternalStore(petStage.subscribe, petStage.host, () => null);
  useLayoutEffect(() => {
    const at = anchor.current;
    if (!at) return undefined;
    // The window's grid is the outermost one: a pane's own chat has a grid of its own, never split.
    let grid: Element | null = null;
    for (let found = at.closest(".cx-split"); found; found = found.parentElement?.closest(".cx-split") ?? null) grid = found;
    const read = () => {
      const split = grid?.hasAttribute("data-split") ? grid : null;
      setPane(split ? [...split.children].find((child): child is HTMLElement => child instanceof HTMLElement && child.contains(at)) ?? null : null);
      petStage.focus(split?.querySelector<HTMLElement>(":scope > .cx-pane[data-focused]") ?? null);
    };
    read();
    if (!grid) return undefined;
    const watch = new MutationObserver(read);
    watch.observe(grid, { attributes: true, subtree: true, attributeFilter: ["data-split", "data-focused"] });
    return () => watch.disconnect();
  }, []);
  useEffect(() => {
    const composer = anchor.current?.parentElement;
    if (pane && composer) petStage.seat(pane, { composer, mood: props.mood });
  }, [pane, props.mood]);
  useEffect(() => pane ? () => petStage.leave(pane) : undefined, [pane]);
  return <>
    <span ref={anchor} hidden />
    {!pane ? <PetBody key="solo" {...props} split={null} />
      : host === pane ? <PetBody key="split" {...props} split={{ pane }} /> : null}
  </>;
}

/** Hidden pages keep their chats running, but dispose the pet's decorative work and seats. */
export function ChatPet(props: PetProps) {
  const hidden = useContext(SurfaceHiddenContext);
  return hidden ? null : <VisibleChatPet {...props} />;
}
