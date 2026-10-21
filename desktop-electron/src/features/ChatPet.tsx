import { useEffect, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent, type ReactElement } from "react";
import { createPortal } from "react-dom";

// Bit, the chat's pet: Claude Code's Clawd living on the chat box. It walks all the way around the
// box (along the top, down the right side, upside down underneath, up the left side), dashing across
// any button it passes and never stopping on one. While the agent works it gets to work itself:
// typing at a little laptop, searching with a magnifier, hammering, carrying a file box; idle, it
// sips coffee, reads, looks around, waves. When the pointer comes close it may leap onto it, for a
// hug with hearts or a ride wherever the pointer goes, then jump back home to the box. It runs to
// the send button to wave when a request waits for you, dances when a turn finishes and frets when
// one fails. Left alone while nothing runs, it walks home to its house beside the box's right side
// and sleeps there. Click to pet it, double-click to feed it, drag it anywhere on the screen (let
// go, it falls back onto the box). Pure view: it reads the chat's state and changes nothing.
//
// Clawd itself (Clawd.tsx) is Claude Code's: the CLI's glyphs, poses and animations, frame for frame.

import type { PetMood } from "./ao-chat";
import { CELL_H, CELL_W, CLICKABLE, COLS, ClawdFrame, ENTRANCES, ROWS, pickOne, useClawdPlayer,
  type AnimationName, type Arms as ClawdArms, type Eyes, type Feet, type Frame } from "./Clawd";

// Where it was left, as a fraction of the way around the box from the top-left corner.
const POSITION_KEY = "coding-tools:ao:pet-around";
// LIFT_KEY is where an older build kept how far it was held off the box (it then hovered there after
// every restart); it is only cleared now. Dragged, it follows the pointer anywhere on the screen
// (it was held only straight out from the box's edge, and never past the box's ends); let go, it
// falls onto the box's top edge under where it was dropped, faster the shorter the drop.
const LIFT_KEY = "coding-tools:ao:pet-lift";
const FALL_MS = 420;
const NAP_MS = 45_000;
const CHEER_MS = 6_000;
// Props and the house use the same pixels as Clawd's quadrants: half a terminal cell, twice as tall
// as wide.
const PIXEL_W = CELL_W / 2;
const PIXEL_H = CELL_H / 2;
const WIDTH = COLS * CELL_W;
const HEIGHT = ROWS * CELL_H;
/** Clawd's house, 34×13 pixels, standing beside the box's right side (not on top of it, where it
 *  covered the box's top edge), its floor level with the box's bottom, this far out from it. */
const HOUSE_COLS = 34;
const HOUSE_ROWS = 13;
const HOUSE_W = HOUSE_COLS * PIXEL_W;
const HOUSE_H = HOUSE_ROWS * PIXEL_H;
/** On the top edge (no room beside the box), this far in from its right end. */
const HOUSE_INSET = 18;
/** The entrance plays once per window, as the CLI plays one once per version. */
let entrancePlayed = false;
/** Claude Code's working spinner, cycled over Clawd's head while the agent works. */
const SPINNER = ["·", "✢", "✳", "✶", "✻", "✽", "✻", "✶", "✳", "✢"];
/** Walking speed in px/s: a stroll while nothing runs, a scurry while the agent works. */
const STROLL = 46;
const SCURRY = 115;
/** Over a button or chip it dashes, so it never sits in the way of a click. */
const DASH = 2.8;
/** How near (px) the pointer must come before Bit turns its eyes to it, and before it leaps on. */
const NOTICE = 180;
const REACH = 70;
/** Between two leaps onto the pointer, so it plays now and then rather than pestering. */
const PLAY_EVERY = 15_000;
/** A ride lasts at most this long (ms) before it jumps off by itself; a click, Escape or a quick
 *  shake of the pointer makes it jump off at once. */
const MAX_RIDE = 4_000;
/** A pointer move this fast (px in one frame) shakes it off. */
const SHAKE = 90;
/** What it does now and then while riding, from Claude Code's own animations. */
const RIDE_PLAYS: AnimationName[] = ["jump", "wink", "look", "boop", "tap"];

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

// Props and the house, in Clawd's pixels.
const P = { frame: "#3d3d3a", screen: "#1f2a33", glow: "#7fd1ff", key: "#b4b2a7", mug: "#efede6", rim: "#8c8a82", steam: "#c9c7bd",
  page: "#faf9f5", cover: "#6a9bcc", wood: "#8a5a3c", metal: "#5b5a55", lens: "#bfe3f5", box: "#c8a26b", boxDark: "#9b7a48",
  roof: "#b85c3f", roofEdge: "#8f4430", wall: "#e3cfa6", wallEdge: "#b89b6a", door: "#5a3a26", knob: "#f5c451",
  glass: "#3d5a73", lit: "#f5c451", frameLight: "#faf9f5",
  inside: "#d6bf92", insideEdge: "#bfa576", floor: "#9c6b47", rug: "#7f9db8", shade: "#e8dcb8", leaf: "#7fa36b" };

/** What Clawd is busy with: a prop beside it (or on its head) and how its arms move. */
type Job = "none" | "laptop" | "search" | "build" | "carry" | "coffee" | "read";
type Arms = "down" | "left" | "right" | "both" | "reach";
type Pose = { look: -1 | 0 | 1; arms: Arms; walking: boolean; sit: boolean };
/** On the pointer: leaping on, riding along, or leaping back home to the box (screen px). */
type Ride = { x: number; y: number; mode: "boarding" | "riding" | "leaving"; look: -1 | 0 | 1 };

const rect = (x: number, y: number, w: number, h: number, color: string, key: string) =>
  <rect key={key} x={x} y={y} width={w} height={h} fill={color} />;

/**
 * The frame Clawd rests in between animations, built from the CLI's own parts: eyes turned where it
 * looks (closed asleep or blinking), feet stepping left and right as it walks (the CLI's waddle),
 * arms up to ask or carry, one arm working its tool or typing, and a one-row crouch to sit.
 */
function restFrame({ mood, asleep, step, pose, blink, job }: { mood: PetMood; asleep: boolean; step: boolean; pose: Pose; blink: boolean; job: Job }): Frame {
  const working = mood === "working" && !asleep;
  const typing = working && !pose.walking && pose.arms === "down" && job === "none";
  const eyes: Eyes = asleep || blink ? "closed"
    : job === "laptop" || job === "read" || job === "coffee" ? "right"
    : pose.look < 0 ? "left" : pose.look > 0 ? "right" : "open";
  let arms: ClawdArms = "down";
  if (!asleep) {
    if (job === "carry" || (mood === "ask" && !pose.walking) || pose.arms === "both") arms = "up";
    else if (job !== "none") arms = (job === "laptop" || job === "build") && step ? "down" : "one-up";
    else if (typing) arms = step ? "one-up" : "down";
    else if (pose.arms !== "down") arms = "one-up";
  }
  const feet: Feet = pose.walking ? (step ? "left" : "right") : "both";
  return { pose: { eyes, arms, feet }, offset: pose.sit ? 1 : 0 };
}

const houseSvg = (parts: ReactElement[]) =>
  <svg viewBox={`0 0 ${HOUSE_COLS} ${HOUSE_ROWS}`} width={HOUSE_W} height={HOUSE_H} preserveAspectRatio="none" aria-hidden="true"
    shapeRendering="crispEdges">{parts}</svg>;

/**
 * Clawd's house is a doll's house with its front swung open, so you can see in: its rooms are drawn
 * behind Clawd (HouseInside) and its roof and side walls in front (House). Clawd stands in the
 * middle of the room, on a rug, with a bookshelf and a picture to its left and a window and a lamp
 * to its right; it fills the room's middle (18 of its 28 pixels), and its walls (rows 6-12) are a
 * row taller than Clawd.
 */
function HouseInside({ home, asleep }: { home: boolean; asleep: boolean }) {
  const r = rect;
  const lit = home && !asleep;
  return houseSvg([
    // Back wall with a darker band at its foot, then the floor and the rug Clawd stands on.
    r(3, 6, 28, 6, P.inside, "back"), r(3, 10, 28, 1, P.insideEdge, "dado"), r(3, 12, 28, 1, P.floor, "floor"), r(9, 12, 16, 1, P.rug, "rug"),
    // Left: a framed picture over a bookshelf of three books and a plant.
    r(4, 7, 3, 2, P.wood, "picture"), r(5, 7, 1, 1, P.lens, "picture-sky"), r(5, 8, 1, 1, P.leaf, "picture-hill"),
    // Left: a framed landscape over a bookshelf of four books.
    r(3, 9, 4, 3, P.wood, "shelf"), r(3, 10, 1, 1, P.cover, "book-1"), r(4, 10, 1, 1, P.roof, "book-2"), r(5, 10, 1, 1, P.leaf, "book-3"),
    r(6, 10, 1, 1, P.page, "book-4"),
    // Right: a window (lit while Clawd is home awake) and a lamp beside it, lit with it.
    r(26, 7, 4, 3, P.frameLight, "window-frame"), r(27, 7, 2, 2, lit ? P.lit : P.glass, "window"),
    r(28, 10, 3, 1, lit ? P.lit : P.shade, "lamp-shade"), r(29, 11, 1, 1, P.metal, "lamp-stand"),
  ]);
}

/**
 * The front of Clawd's house, standing beside the box's right side and drawn over Clawd:
 * a clay roof with its chimney, the side walls, and the front wall swung open on its hinge at the
 * left. Asleep inside, z's rise from it.
 */
function House({ home, asleep, onKnock }: { home: boolean; asleep: boolean; onKnock: () => void }) {
  const r = rect;
  const parts: ReactElement[] = [r(25, 0, 2, 3, P.roofEdge, "chimney")];
  // The roof, three pixels wider each side each row down, with an eave line under it.
  [[14, 6], [11, 12], [8, 18], [5, 24], [2, 30]].forEach(([x, w], row) => parts.push(r(x!, row, w!, 1, P.roof, `roof${row}`)));
  parts.push(r(1, 5, 32, 1, P.roofEdge, "eave"));
  // The side walls, edged darker outside; between them the room is open.
  parts.push(r(2, 6, 1, 7, P.wall, "wall-l"), r(1, 6, 1, 7, P.wallEdge, "wall-l-edge"),
    r(31, 6, 1, 7, P.wall, "wall-r"), r(32, 6, 1, 7, P.wallEdge, "wall-r-edge"));
  // The front wall, swung open on its left hinge so its edge shows, with the door's knob on it.
  parts.push(r(0, 6, 1, 7, P.wall, "front"), r(0, 9, 1, 1, P.knob, "front-knob"));
  return <button type="button" className={`cx-pet-house${home ? " is-home" : ""}${asleep ? " is-asleep" : ""}`}
    title={home ? (asleep ? "Clawd is napping. Click to wake it" : "Clawd is home") : "Clawd's house. Click to call Clawd home"}
    aria-label={home ? (asleep ? "Clawd's house: Clawd is napping inside" : "Clawd's house: Clawd is home") : "Clawd's house"}
    onClick={onKnock}>
    {houseSvg(parts)}
    {home && asleep ? <span className="cx-pet-house-z" aria-hidden="true"><span>z</span><span>z</span><span>Z</span></span> : null}
  </button>;
}

/** A file box carried over its head, held up in both hands. */
function CarriedBox() {
  const r = rect;
  return <svg className="cx-pet-box" viewBox="0 0 8 2" width={8 * PIXEL_W} height={2 * PIXEL_H} preserveAspectRatio="none" aria-hidden="true" shapeRendering="crispEdges">
    {[r(0, 0, 8, 2, P.box, "box"), r(0, 0, 8, 1, P.boxDark, "box-lid"), r(3, 1, 2, 1, P.boxDark, "box-tape")]}
  </svg>;
}

/** The tool beside it, on a 9×7 grid of the same pixels, standing on the same ground line. */
function Prop({ job, step, tick }: { job: Job; step: boolean; tick: number }) {
  if (job === "none" || job === "carry") return null;
  const r = rect;
  const parts: ReactElement[] = [];
  if (job === "laptop") {
    // A laptop facing Clawd: its screen's lines scroll as it types.
    parts.push(r(1, 3, 6, 3, P.frame, "lid"), r(2, 3, 4, 2, P.screen, "screen"), r(0, 6, 8, 1, P.key, "keys"));
    for (let line = 0; line < 2; line += 1) parts.push(r(2, 3 + line, 1 + ((tick + line * 3) % 4), 1, P.glow, `line${line}`));
  } else if (job === "search") {
    // A magnifier held up, bobbing as it scans.
    const y = step ? 2 : 3;
    parts.push(r(1, y, 3, 1, P.metal, "ring-t"), r(1, y + 2, 3, 1, P.metal, "ring-b"), r(0, y + 1, 1, 1, P.metal, "ring-l"),
      r(4, y + 1, 1, 1, P.metal, "ring-r"), r(1, y + 1, 3, 1, P.lens, "lens"), r(4, y + 3, 1, 1, P.wood, "grip"));
  } else if (job === "build") {
    // A hammer swinging down onto a nail, a spark on each hit.
    if (step) parts.push(r(0, 3, 1, 1, P.wood, "handle"), r(0, 4, 3, 1, P.metal, "head"), r(4, 6, 1, 1, P.metal, "nail"), r(5, 5, 1, 1, "#f5c451", "spark"));
    else parts.push(r(0, 1, 1, 3, P.wood, "handle"), r(0, 0, 3, 1, P.metal, "head"), r(4, 6, 1, 1, P.metal, "nail"));
  } else if (job === "coffee") {
    // A mug, lifted for a sip now and then, steam curling up.
    const y = step ? 3 : 4;
    parts.push(r(1, y, 3, 2, P.mug, "mug"), r(1, y, 3, 1, P.rim, "rim"), r(4, y + 1, 1, 1, P.rim, "handle"));
    const curl = tick % 3;
    parts.push(r(1 + curl, y - 1, 1, 1, P.steam, "steam1"), r(3 - curl, y - 2, 1, 1, P.steam, "steam2"));
  } else if (job === "read") {
    // An open book, a page turning now and then.
    parts.push(r(0, 4, 3, 2, P.page, "page-l"), r(4, 4, 3, 2, P.page, "page-r"), r(3, 4, 1, 3, P.cover, "spine"), r(0, 6, 7, 1, P.cover, "cover"));
    if (tick % 6 === 0) parts.push(r(3, 3, 2, 1, P.page, "turn"));
  }
  return <svg className="cx-pet-prop" viewBox="0 0 9 7" width={9 * PIXEL_W} height={7 * PIXEL_H} preserveAspectRatio="none" aria-hidden="true" shapeRendering="crispEdges">{parts}</svg>;
}

type Floater = { id: number; text: string; offset: number };
const REST: Pose = { look: 0, arms: "down", walking: false, sit: false };
const pick = <T,>(items: readonly T[]) => items[Math.floor(Math.random() * items.length)]!;
const WORK: readonly Job[] = ["laptop", "laptop", "search", "build", "carry"];

/**
 * The box's outline as one loop: its size, and the spot and side at a distance around it. `beside`:
 * there is room for the house to the box's right (it stood on the box's top edge, over the corner of
 * the text box; the user wanted it beside the box).
 */
type Loop = { width: number; height: number; length: number; beside: boolean };
/**
 * The yard between the box's right edge and a house standing beside it: wider than Clawd is tall, so
 * walking down the box's right side (sideways, its body out by its height) it passes beside the
 * house. At 10 px it walked through the house's front, as if no house stood there.
 */
const HOUSE_GAP = HEIGHT + 4;
/** From its doorstep in the yard through the open front to the middle of its room (ms), and back. */
const DOOR_MS = 900;
function spotAt(loop: Loop, at: number): { x: number; y: number; side: 0 | 1 | 2 | 3 } {
  const { width: w, height: h, length } = loop;
  const s = ((at % length) + length) % length;
  if (s < w) return { x: s, y: 0, side: 0 };
  if (s < w + h) return { x: w, y: s - w, side: 1 };
  if (s < 2 * w + h) return { x: w - (s - w - h), y: h, side: 2 };
  return { x: 0, y: h - (s - 2 * w - h), side: 3 };
}
/** Where the house stands on the top edge (with no room beside the box): its left side, in from the box's right end. */
const houseLeft = (loop: Loop) => Math.max(0, loop.width - HOUSE_W - HOUSE_INSET);
/** The house's top-left corner, from the box's: beside the box on its right, its floor level with
 *  the box's bottom, or on the top edge when there is no room beside it. */
const housePlace = (loop: Loop) => loop.beside
  ? { left: loop.width + HOUSE_GAP, top: loop.height - HOUSE_H }
  : { left: houseLeft(loop), top: -HOUSE_H };
/** `along` (a distance from the top-left corner, under one lap) on the lap nearest `near`. */
const nearLap = (loop: Loop, along: number, near: number) => along + Math.round((near - along) / loop.length) * loop.length;

export function ChatPet({ mood, context, onHide }: {
  mood: PetMood;
  /** Share of the context window in use (0–1), when the agent reports it. */
  context: number | null;
  onHide: () => void;
}) {
  const box = useRef<HTMLDivElement>(null);
  // The chat box it lives on: its parent when first mounted (it rides the pointer outside it).
  const composer = useRef<HTMLElement | null>(null);
  // Distance walked around the box from its top-left corner, NaN until the box is measured. It is
  // never wrapped, so every lap keeps turning the same way at the corners.
  const [at, setAt] = useState(Number.NaN);
  useEffect(() => { try { localStorage.removeItem(LIFT_KEY); } catch { /* nothing saved */ } }, []);
  // Picked up: the middle of its body on the screen, and, once let go, how long its fall back onto
  // the box takes (ms; 0 while held). Null on the box.
  const [held, setHeld] = useState<{ x: number; y: number; fall: number } | null>(null);
  const heldNow = useRef(held);
  heldNow.current = held;
  const [loop, setLoop] = useState<Loop | null>(null);
  const [pose, setPose] = useState<Pose>(REST);
  const [job, setJob] = useState<Job>("none");
  // Inside its house (out of sight behind the walls), asleep or not.
  const [home, setHome] = useState(false);
  // Walking in or out through the open front of the house beside the box (DOOR_MS): on the doorstep
  // in the yard, or on its way between there and the room. Its own timer: a click that clears the
  // wander plans must not leave it stuck in the doorway.
  const [door, setDoor] = useState(false);
  const doorTimer = useRef<number | undefined>(undefined);
  const [ride, setRide] = useState<Ride | null>(null);
  const [step, setStep] = useState(false);
  const [tick, setTick] = useState(0);
  const [blink, setBlink] = useState(false);
  const [spin, setSpin] = useState(0);
  const [asleep, setAsleep] = useState(false);
  const [cheering, setCheering] = useState(false);
  const [bubble, setBubble] = useState<string | null>(null);
  const [floaters, setFloaters] = useState<Floater[]>([]);
  const [fed, setFed] = useState(0);
  const drag = useRef<{ moved: boolean; x: number; y: number; lastX: number; lastY: number } | null>(null);
  // The window listeners of a drag in progress (removed on drop or unmount), and its fall's timer.
  const dragEnd = useRef<(() => void) | null>(null);
  const fallTimer = useRef<number | undefined>(undefined);
  const pointer = useRef({ x: 0, y: 0 });
  const lastPlay = useRef(0);
  const clickTimer = useRef<number | undefined>(undefined);
  // The end of a ride: its own timer, so nothing that clears the wander plans can leave it riding.
  const rideTimer = useRef<number | undefined>(undefined);
  const bubbleTimer = useRef<number | undefined>(undefined);
  const napTimer = useRef<number | undefined>(undefined);
  const walkFrame = useRef(0);
  // Every scheduled behaviour (the next stroll, an arrival, an action's frames), cleared together.
  const plans = useRef<number[]>([]);
  const seq = useRef(0);
  // Timers and listeners fire later; they read the state then, not the state they were set up in.
  const atNow = useRef(at);
  atNow.current = at;
  const loopNow = useRef(loop);
  loopNow.current = loop;
  const moodNow = useRef(mood);
  moodNow.current = mood;
  const asleepNow = useRef(asleep);
  asleepNow.current = asleep;
  const homeNow = useRef(home);
  homeNow.current = home;
  const doorNow = useRef(door);
  doorNow.current = door;
  const rideNow = useRef(ride);
  rideNow.current = ride;
  const [still] = useState(() => { try { return window.matchMedia("(prefers-reduced-motion: reduce)").matches; } catch { return false; } });
  const clawd = useClawdPlayer(still);

  const later = (ms: number, run: () => void) => { plans.current.push(window.setTimeout(run, ms)); };
  const stopWalking = () => { if (walkFrame.current) window.cancelAnimationFrame(walkFrame.current); walkFrame.current = 0; };
  const cancelPlans = () => { plans.current.forEach((timer) => window.clearTimeout(timer)); plans.current = []; stopWalking(); };
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
    window.setTimeout(() => setFloaters((current) => current.filter((item) => item.id !== id)), 1100);
  };
  const busyElsewhere = () => asleepNow.current || drag.current !== null || heldNow.current !== null || rideNow.current !== null || homeNow.current
    || doorNow.current;

  // The box it walks around: measured now and whenever it resizes.
  useEffect(() => {
    const parent = box.current?.parentElement;
    if (!parent) return undefined;
    composer.current = parent;
    // The nearest surface around the box that clips what stands outside it (the chat's workflow pane).
    let clip: HTMLElement | null = parent.parentElement;
    while (clip && getComputedStyle(clip).overflowX === "visible") clip = clip.parentElement;
    const measure = () => {
      const width = parent.offsetWidth, height = parent.offsetHeight;
      if (width <= 0 || height <= 0) return;
      const room = (clip ? clip.getBoundingClientRect().right : window.innerWidth) - parent.getBoundingClientRect().right;
      const beside = room >= HOUSE_GAP + HOUSE_W;
      setLoop((current) => current && current.width === width && current.height === height && current.beside === beside
        ? current : { width, height, length: 2 * (width + height), beside });
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(parent);
    // The room beside the box changes with the window as well as with the box itself.
    window.addEventListener("resize", measure);
    return () => { observer.disconnect(); window.removeEventListener("resize", measure); };
  }, []);
  // First placement: the saved fraction of the way round, else near the top-right corner.
  useEffect(() => {
    if (!loop || !Number.isNaN(atNow.current)) return;
    let saved = Number.NaN;
    try { saved = Number(localStorage.getItem(POSITION_KEY) ?? Number.NaN); } catch { /* first visit */ }
    setAt(saved >= 0 && saved < 1 ? saved * loop.length : Math.max(WIDTH / 2, loop.width - 2 * WIDTH));
    if (!entrancePlayed && !still) { entrancePlayed = true; play(pickOne(ENTRANCES)); }
  }, [loop]);
  const remember = () => {
    const current = loopNow.current;
    if (!current || Number.isNaN(atNow.current)) return;
    try {
      localStorage.setItem(POSITION_KEY, String((((atNow.current % current.length) + current.length) % current.length) / current.length));
    } catch { /* the spot still applies now */ }
  };

  /** Buttons, chips and fields around the box: Bit dashes across them and never rests on one. */
  const obstacles = () => {
    const area = composer.current?.parentElement;
    if (!area) return [];
    return [...area.querySelectorAll("button, a, input, select, [role='button']"), ...document.querySelectorAll(".cx-turn-stats > *")]
      .filter((element) => !composer.current?.contains(element))
      .map((element) => element.getBoundingClientRect())
      .filter((found) => found.width > 0 && found.height > 0);
  };
  /** Whether standing at `spot` (a distance around) would cover one of `rects`. */
  const blocked = (spot: number, rects: DOMRect[]) => {
    const current = loopNow.current;
    const frame = composer.current?.getBoundingClientRect();
    if (!current || !frame) return false;
    const { x, y, side } = spotAt(current, spot);
    const half = WIDTH / 2;
    // Its footprint stands outward from the box: above the top, right of the right side, and so on.
    const [left, top, right, bottom] = side === 0 ? [x - half, y - HEIGHT, x + half, y]
      : side === 1 ? [x, y - half, x + HEIGHT, y + half]
      : side === 2 ? [x - half, y, x + half, y + HEIGHT]
      : [x - HEIGHT, y - half, x, y + half];
    return rects.some((found) => found.left < frame.left + right && found.right > frame.left + left
      && found.top < frame.top + bottom && found.bottom > frame.top + top);
  };
  /** Where Clawd walks to go in: behind the house's middle on the top edge, or, with the house beside
   *  the box, the foot of the box's right side, from where it steps down into the yard and walks in
   *  through the open front (it used to vanish into the room from the top edge's right end). */
  const homeSpot = () => {
    const current = loopNow.current;
    if (!current) return atNow.current;
    return nearLap(current, current.beside ? current.width + current.height - WIDTH / 2 : houseLeft(current) + HOUSE_W / 2, atNow.current);
  };
  /** Whether standing at `spot` would leave it half behind the house: it only stops there to go in.
   *  Beside the box that is the right side next to the house, and the top edge's right end when the
   *  house is taller than the box and stands up past its top; on the top edge, the house's span. */
  const inHouse = (spot: number) => {
    const current = loopNow.current;
    if (!current || current.beside) return false;
    const { x, side } = spotAt(current, spot);
    const left = houseLeft(current);
    return side === 0 && x > left - WIDTH / 2 && x < left + HOUSE_W + WIDTH / 2;
  };
  /** The nearest spot to `spot` that covers no button. */
  const freeNear = (spot: number) => {
    const current = loopNow.current;
    const rects = obstacles();
    if (!current || !blocked(spot, rects)) return spot;
    for (let offset = 8; offset < current.length / 2; offset += 8) {
      const free = [spot + offset, spot - offset].find((candidate) => !blocked(candidate, rects));
      if (free !== undefined) return free;
    }
    return spot;
  };

  /** Walks around the box to `target` (a distance around it), dashing over buttons; then `arrive`. */
  const walkTo = (target: number, speed: number, arrive?: () => void) => {
    stopWalking();
    const rects = obstacles();
    const direction = target >= atNow.current ? 1 : -1;
    setPose({ ...REST, walking: true, look: direction > 0 ? 1 : -1 });
    let last = performance.now();
    const frame = (now: number) => {
      const elapsed = Math.min(0.05, (now - last) / 1000);
      last = now;
      const next = atNow.current + direction * speed * (blocked(atNow.current, rects) ? DASH : 1) * elapsed;
      const arrived = direction > 0 ? next >= target : next <= target;
      atNow.current = arrived ? target : next;
      setAt(atNow.current);
      if (!arrived) { walkFrame.current = window.requestAnimationFrame(frame); return; }
      walkFrame.current = 0;
      setPose(REST);
      remember();
      arrive?.();
    };
    walkFrame.current = window.requestAnimationFrame(frame);
  };

  /** A spot to walk to: mostly a short way along, sometimes a long way round, never on a button. */
  const nextSpot = (working: boolean) => {
    const current = loopNow.current;
    if (!current) return atNow.current;
    const rects = obstacles();
    for (let attempt = 0; attempt < 12; attempt += 1) {
      const far = Math.random() < (working ? 0.4 : 0.25);
      const span = far ? current.length * (0.5 + Math.random() * 0.7) : 60 + Math.random() * 200;
      const target = atNow.current + (Math.random() < 0.5 ? -1 : 1) * span;
      if (!blocked(target, rects) && !inHouse(target)) return target;
    }
    return atNow.current;
  };

  /** One thing to do on arriving somewhere, so a stroll never looks like sliding. */
  const act = () => {
    if (busyElsewhere()) return;
    if (moodNow.current === "working") {
      // At work: settle at a tool for a while; carrying walks on to drop the box somewhere.
      const next = pick(WORK);
      if (next === "carry") { setJob("carry"); walkTo(nextSpot(true), SCURRY * 0.8, () => { setJob("none"); play("jump"); }); return; }
      setJob(next);
      later(5000 + Math.random() * 4000, () => setJob("none"));
      return;
    }
    const choice = pick(["play", "play", "play", "sit", "muse", "coffee", "read", "rest"] as const);
    if (choice === "play") play(pickOne(CLICKABLE));
    else if (choice === "sit") { setPose({ ...REST, sit: true }); later(2600, () => setPose(REST)); }
    else if (choice === "coffee" || choice === "read") { setJob(choice); later(3500 + Math.random() * 2500, () => setJob("none")); }
    else if (choice === "muse" && moodNow.current === "idle") say(pick(MUSINGS), 1500);
  };

  /** The wander loop: a pause (or a job), a walk somewhere, an action, again. */
  const wander = () => {
    if (still) return;
    const working = moodNow.current === "working";
    const pause = working ? 5500 + Math.random() * 4000 : 2000 + Math.random() * 3000;
    later(pause, () => {
      if (busyElsewhere() || moodNow.current === "ask" || moodNow.current === "error") { wander(); return; }
      setJob("none");
      walkTo(nextSpot(working), working ? SCURRY : STROLL, () => { act(); wander(); });
    });
  };

  /** Bedtime: it walks home to its house on the box's top edge, goes in and falls asleep there. A
   *  visit (`nap` false) stays a moment and comes back out. */
  const goHome = (nap = true) => {
    cancelPlans();
    window.clearTimeout(doorTimer.current);
    setDoor(false);
    setJob("none");
    if (!loopNow.current) return;
    say(nap ? "Home time…" : "Coming!", 1300);
    const inside = () => {
      homeNow.current = true;
      setDoor(false);
      setHome(true);
      setPose(REST);
      if (nap) later(still ? 0 : 700, () => setAsleep(true));
      else later(2500, () => leaveHome());
    };
    // Beside the box it steps down off the box's side onto its doorstep, then walks in through the
    // open front to the middle of its room, the walls passing in front of it.
    const settle = () => {
      if (still || !loopNow.current?.beside) { inside(); return; }
      setDoor(true);
      setPose({ ...REST, walking: true, look: 1 });
      window.clearTimeout(doorTimer.current);
      doorTimer.current = window.setTimeout(() => {
        setHome(true);
        doorTimer.current = window.setTimeout(inside, DOOR_MS);
      }, 200);
    };
    if (still) { atNow.current = homeSpot(); setAt(atNow.current); settle(); return; }
    walkTo(homeSpot(), nap ? STROLL * 1.3 : SCURRY, settle);
  };
  /** Out of the house, through the door on the side facing the box; `walkOut` strolls off too. */
  const leaveHome = (walkOut = true) => {
    if (!homeNow.current && !doorNow.current) return;
    window.clearTimeout(doorTimer.current);
    const out = () => {
      homeNow.current = false;
      setHome(false);
      setDoor(false);
      if (!walkOut || still || !loopNow.current) return;
      // Back the way it came, clear of the house: up the right side and along the top, or back along the top.
      const { y, side } = spotAt(loopNow.current, atNow.current);
      walkTo(freeNear(atNow.current - (side === 1 ? y + 1.5 * WIDTH : HOUSE_W / 2 + WIDTH)), STROLL, () => { play("jump"); remember(); wander(); });
    };
    // From the room beside the box it walks out through the open front to its doorstep first;
    // lifted out (a drag), it is just gone from the house.
    if (!walkOut || still || !homeNow.current || !loopNow.current?.beside) { out(); return; }
    setDoor(true);
    setPose({ ...REST, walking: true, look: -1 });
    setHome(false);
    doorTimer.current = window.setTimeout(out, DOOR_MS);
  };
  // Nothing running for a while: it goes home to sleep. Any touch, or the agent starting, wakes it.
  const poke = () => {
    window.clearTimeout(napTimer.current);
    napTimer.current = window.setTimeout(() => {
      if ((moodNow.current === "idle" || moodNow.current === "done") && !rideNow.current && !drag.current) goHome();
    }, NAP_MS);
  };
  const wake = () => {
    if (!asleepNow.current && !homeNow.current) return false;
    setAsleep(false);
    setPose(REST);
    say("Huh? I'm up.", 1500);
    poke();
    cancelPlans();
    if (homeNow.current) leaveHome(); else wander();
    return true;
  };

  /** Feet on the box at `spot`, in screen px. */
  const screenAt = (spot: number) => {
    const current = loopNow.current;
    const frame = composer.current?.getBoundingClientRect();
    if (!current || !frame) return { x: pointer.current.x, y: pointer.current.y };
    const { x, y } = spotAt(current, spot);
    return { x: frame.left + x, y: frame.top + y };
  };
  /** It jumps off the pointer, back onto the box's top edge below it (never onto a button). */
  const leave = () => {
    window.clearTimeout(rideTimer.current);
    if (rideNow.current?.mode === "leaving") return;
    const current = loopNow.current;
    const frame = composer.current?.getBoundingClientRect();
    if (!rideNow.current || !current || !frame) { setRide(null); return; }
    rideNow.current = { ...rideNow.current, mode: "leaving" };
    const x = Math.max(WIDTH / 2, Math.min(current.width - WIDTH / 2, pointer.current.x - frame.left));
    const spot = freeNear(nearLap(current, x, atNow.current));
    setPose({ ...REST, arms: "both" });
    setRide((ridden) => ridden && { ...ridden, ...screenAt(spot), mode: "leaving" });
    window.setTimeout(() => {
      atNow.current = spot;
      setAt(spot);
      setRide(null);
      setPose(REST);
      play("jump");
      remember();
      poke();
      cancelPlans();
      wander();
    }, still ? 0 : 480);
  };
  /** It leaps onto the pointer: for a short hug with hearts, or for a ride of a few seconds. */
  const board = (stay: number) => {
    cancelPlans();
    setJob("none");
    setRide({ ...screenAt(atNow.current), mode: "boarding", look: 0 });
    setPose({ ...REST, arms: "both" });
    // Two frames later, so the leap starts from where it stood.
    window.requestAnimationFrame(() => window.requestAnimationFrame(() =>
      setRide((current) => current && { ...current, ...pointer.current, mode: "boarding" })));
    later(420, () => {
      setRide((current) => current && { ...current, ...pointer.current, mode: "riding" });
      // Aboard, its feet dangle and it looks the way it is carried (see the ride frame below).
      setPose({ ...REST, walking: true });
      float("♥", 18); float("♥", 40);
      later(200, () => float("♥", 28));
      say(stay > 2000 ? pick(RIDING) : "Hi!", 1400);
    });
    window.clearTimeout(rideTimer.current);
    rideTimer.current = window.setTimeout(leave, 420 + Math.min(stay, MAX_RIDE));
  };

  // React to the agent: each mood gets its own little scene, then the wander loop resumes.
  useEffect(() => {
    cancelPlans();
    if (rideNow.current) leave();
    setAsleep(false);
    leaveHome(false);
    setPose(REST);
    setJob("none");
    poke();
    if (mood === "done") {
      setCheering(true);
      float("✓");
      play("celebrate");
      const timer = window.setTimeout(() => setCheering(false), CHEER_MS);
      wander();
      return () => { window.clearTimeout(timer); cancelPlans(); };
    }
    setCheering(false);
    if (mood === "working" && !still) later(400, () => setJob("laptop"));
    if (mood === "error") { play("look"); say("Uh oh", 1600); }
    if (mood === "ask") {
      // It runs to the top-right corner, by the send button, and waves for attention.
      say(LINES.ask, 2600);
      const current = loopNow.current;
      if (!still && current) walkTo(freeNear(nearLap(current, current.width - WIDTH / 2, atNow.current)), SCURRY * 1.4, () => play("jump"));
    }
    wander();
    return cancelPlans;
  }, [mood]);
  const full = context !== null && context >= 0.8;
  useEffect(() => { if (full) say("I'm getting full. Compact soon?", 2600); }, [full]);

  // Legs cycle while it walks; at work, its arms and tools keep the same beat.
  const walking = !asleep && (pose.walking || mood === "working" || job !== "none");
  useEffect(() => {
    if (!walking) { setStep(false); return undefined; }
    const beat = pose.walking ? 120 : job === "build" ? 260 : job === "coffee" || job === "read" ? 900 : 200;
    const timer = window.setInterval(() => { setStep((current) => !current); setTick((current) => current + 1); }, beat);
    return () => window.clearInterval(timer);
  }, [walking, pose.walking, job]);
  // A spark flies on each hammer blow.
  useEffect(() => { if (job === "build" && step && !still) float("✦", 48); }, [job, step]);
  // While the agent works, Claude Code's spinner turns over its head.
  const busy = mood === "working" && !asleep && job !== "carry" && !ride;
  useEffect(() => {
    if (!busy || still) { setSpin(0); return undefined; }
    const timer = window.setInterval(() => setSpin((current) => (current + 1) % SPINNER.length), 120);
    return () => window.clearInterval(timer);
  }, [busy, still]);
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

  // It watches the pointer when it comes near, rides it once aboard, now and then leaps onto it,
  // and perks up while you type in the box.
  useEffect(() => {
    if (still) return undefined;
    let frame = 0;
    let moved = 0;
    const onMove = (event: PointerEvent) => {
      moved += event.clientX - pointer.current.x;
      pointer.current = { x: event.clientX, y: event.clientY };
      if (frame) return;
      frame = window.requestAnimationFrame(() => {
        frame = 0;
        const { x, y } = pointer.current;
        const dx = moved;
        moved = 0;
        if (rideNow.current) {
          // Aboard, it goes wherever the pointer goes, facing the way it is carried.
          if (rideNow.current.mode !== "riding") return;
          // Shaken hard, it lets go and jumps back to the box.
          if (Math.abs(dx) > SHAKE) { say("Whoa!", 900); leave(); return; }
          setRide((current) => current && { ...current, x, y, look: dx < -1 ? -1 : dx > 1 ? 1 : current.look });
          return;
        }
        const body = box.current?.getBoundingClientRect();
        if (!body || asleepNow.current || drag.current || heldNow.current) return;
        const middle = body.left + body.width / 2;
        const distance = Math.hypot(x - middle, y - (body.top + body.height / 2));
        const calm = moodNow.current === "idle" || moodNow.current === "done";
        if (calm && distance < REACH && !homeNow.current && Date.now() - lastPlay.current > PLAY_EVERY && Math.random() < 0.6) {
          lastPlay.current = Date.now();
          board(Math.random() < 0.5 ? 1200 : 2200 + Math.random() * 1800);
          return;
        }
        setPose((current) => {
          if (current.walking || current.sit) return current;
          const look: Pose["look"] = distance > NOTICE ? 0 : x < middle - 12 ? -1 : x > middle + 12 ? 1 : 0;
          return current.look === look ? current : { ...current, look };
        });
      });
    };
    let lastTyped = 0;
    const form = composer.current ?? box.current?.parentElement;
    const onInput = () => {
      const now = Date.now();
      if (now - lastTyped < 1500 || asleepNow.current) return;
      lastTyped = now;
      play("wink");
      poke();
    };
    window.addEventListener("pointermove", onMove);
    form?.addEventListener("input", onInput);
    return () => { window.removeEventListener("pointermove", onMove); form?.removeEventListener("input", onInput); if (frame) window.cancelAnimationFrame(frame); };
  }, [still]);

  // While it rides: any click or Escape makes it jump off, and it hops, winks and looks about.
  const riding = ride?.mode === "riding";
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
    window.clearTimeout(rideTimer.current); window.clearTimeout(clickTimer.current); window.clearTimeout(bubbleTimer.current);
    window.clearTimeout(napTimer.current); window.clearTimeout(fallTimer.current); window.clearTimeout(doorTimer.current); dragEnd.current?.(); cancelPlans();
  }, []);

  const shown: PetMood = mood === "done" && !cheering ? "idle" : mood;

  /** Picked up and moved: it follows the pointer anywhere on the screen, held by its middle. */
  const dragMove = (clientX: number, clientY: number) => {
    const state = drag.current;
    if (!state) return;
    if (!state.moved && Math.hypot(clientX - state.x, clientY - state.y) > 4) {
      state.moved = true;
      // Lifted out of its house.
      setAsleep(false);
      leaveHome(false);
    }
    if (!state.moved) return;
    const look: Pose["look"] = clientX < state.lastX - 1 ? -1 : clientX > state.lastX + 1 ? 1 : pose.look;
    state.lastX = clientX;
    state.lastY = clientY;
    // Its feet dangle while it is carried, facing the way it goes.
    setPose({ ...REST, walking: true, look });
    setHeld({
      x: Math.max(WIDTH / 2, Math.min(window.innerWidth - WIDTH / 2, clientX)),
      y: Math.max(HEIGHT / 2, Math.min(window.innerHeight - HEIGHT / 2, clientY)),
      fall: 0,
    });
  };
  /**
   * Let go, it falls onto the box's top edge under where it was dropped (as far as the box reaches),
   * from wherever on the screen it was let go, then hops off any button it landed on.
   */
  const dragDrop = () => {
    const state = drag.current;
    drag.current = null;
    if (!state?.moved) { if (!asleepNow.current) wander(); return; }
    const current = loopNow.current;
    const frame = composer.current?.getBoundingClientRect();
    setPose(REST);
    if (!current || !frame) { setHeld(null); wander(); return; }
    const x = Math.max(WIDTH / 2, Math.min(current.width - WIDTH / 2, state.lastX - frame.left));
    const landing = nearLap(current, x, atNow.current);
    const to = { x: frame.left + x, y: frame.top - HEIGHT / 2 };
    // A longer drop takes longer, as a fall does: 420 ms from 400 px.
    const distance = Math.hypot(to.x - state.lastX, to.y - state.lastY);
    const fallMs = still ? 0 : Math.round(Math.min(1100, Math.max(260, FALL_MS * Math.sqrt(Math.max(distance, 1) / 400))));
    say("Wheee", 900);
    // Two frames later, so the fall starts from where it was let go.
    window.requestAnimationFrame(() => window.requestAnimationFrame(() => setHeld({ ...to, fall: fallMs })));
    // Its own timer: a mood change clears the wander plans, and must not leave it in the air.
    window.clearTimeout(fallTimer.current);
    fallTimer.current = window.setTimeout(() => {
      atNow.current = landing;
      setAt(landing);
      setHeld(null);
      play("jump");
      poke();
      const free = freeNear(atNow.current);
      if (free !== atNow.current) walkTo(free, SCURRY * DASH, () => { remember(); wander(); });
      else { remember(); wander(); }
    }, fallMs + 34);
  };

  const onPointerDown = (event: ReactPointerEvent<HTMLButtonElement>) => {
    // Still falling from the last drop: a press now would cancel nothing and could leave it in the
    // air (the landing is its own timer), so it lands first.
    if (event.button !== 0 || drag.current || heldNow.current) return;
    // Picked up mid-walk or mid-job: it stops where it is and goes where it is carried.
    cancelPlans();
    setJob("none");
    drag.current = { moved: false, x: event.clientX, y: event.clientY, lastX: event.clientX, lastY: event.clientY };
    // The window follows the drag: carried off the box, Clawd moves onto the page itself, and the
    // button it was picked up by is no longer the one under the pointer. Only the pointer that
    // picked it up counts: a second finger or a pen neither moves nor drops it.
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

  const percent = context === null ? null : Math.round(context * 100);
  // Home in the house beside the box: upright in the middle of its room, feet on its floor, as it
  // stands in the house on the top edge (its walk ends sideways at the foot of the box's right side).
  const inRoom = home && !ride && !held && loop?.beside ? housePlace(loop) : null;
  // On its doorstep in the yard: upright on the ground, just out from the box's right side, facing the
  // open front. Between there and the room it walks at DOOR_MS (the walls are drawn over it).
  const atDoor = door && !home && !ride && !held && loop?.beside ? { left: loop.width + 2, top: loop.height - HEIGHT } : null;
  const doorWalk: CSSProperties = door && (inRoom || atDoor) ? { transition: `left ${DOOR_MS}ms linear, top .2s ease-in, transform .18s ease-out` } : {};
  // Upright on the ground, as many whole turns as the laps it walked: stepping off the box's side is
  // a quarter turn back, not a spin through every lap.
  const upright: CSSProperties = { transform: `rotate(${loop && !Number.isNaN(at) ? Math.floor(at / loop.length) * 360 : 0}deg)`,
    transformOrigin: `${WIDTH / 2}px ${HEIGHT}px` };
  const side = loop && !Number.isNaN(at) && !ride && !held && !inRoom && !atDoor ? spotAt(loop, at).side : 0;
  // On the box: feet on the outline, body outward, so upright on top, sideways on the sides and
  // upside down under it. On the pointer or held: upright, above everything.
  const placement: CSSProperties = inRoom
    ? { left: inRoom.left + HOUSE_W / 2 - WIDTH / 2, top: inRoom.top + HOUSE_H - HEIGHT, ...upright, ...doorWalk }
    : atDoor
    ? { ...atDoor, ...upright, ...doorWalk }
    : ride
    ? { position: "fixed", left: ride.x - WIDTH / 2, top: ride.y - HEIGHT + 4, zIndex: 60, pointerEvents: "none",
      transition: ride.mode === "riding" ? "none" : "left .42s ease-out, top .42s cubic-bezier(.3,-.7,.6,1)" }
    : held
    ? { position: "fixed", left: held.x - WIDTH / 2, top: held.y - HEIGHT / 2, zIndex: 60,
      transition: held.fall ? `left ${held.fall}ms ease-out, top ${held.fall}ms cubic-bezier(.55, 0, 1, .45)` : "none" }
    : loop && !Number.isNaN(at) ? (() => {
      const { x, y } = spotAt(loop, at);
      return { left: x - WIDTH / 2, top: y - HEIGHT, transform: `rotate(${side * 90 + Math.floor(at / loop.length) * 360}deg)`,
        transformOrigin: `${WIDTH / 2}px ${HEIGHT}px` };
    })() : { visibility: "hidden" };
  const pet = <div ref={box} className={`cx-pet side-${side}${held ? " is-held" : ""}${ride ? ` is-riding ride-${ride.mode}` : ""}${home ? " is-home" : ""}`}
    style={placement}>
    {bubble ? <span className="cx-pet-bubble" role="status">{bubble}</span> : null}
    {busy ? <span className="cx-pet-spinner" aria-hidden="true">{SPINNER[spin]}</span> : null}
    {floaters.map((item) => <span key={item.id} className="cx-pet-float" style={{ left: item.offset }} aria-hidden="true">{item.text}</span>)}
    <button type="button" className={`cx-pet-body is-${shown}${asleep ? " is-asleep" : ""}${pose.walking ? " is-walking" : ""}${job !== "none" ? ` is-${job}` : ""}`}
      aria-label={`Bit the pet: ${asleep ? "napping" : LINES[shown]}${percent !== null ? ` Context ${percent}%.` : ""}`}
      title={asleep ? "Napping. Click to wake" : `${LINES[shown]}${percent !== null ? ` · ${percent}% context` : ""}\nClick to pet · double-click to feed · drag it anywhere on the screen`}
      onPointerDown={onPointerDown}
      onClick={() => {
        if (drag.current?.moved) return;
        window.clearTimeout(clickTimer.current);
        clickTimer.current = window.setTimeout(() => {
          if (wake()) return;
          // As in Claude Code: a click plays one of Clawd's animations.
          play(pickOne(CLICKABLE)); float("♥"); float("♥");
          say(pick(PETTED), 1400);
          poke();
        }, 220);
      }}
      onDoubleClick={() => {
        window.clearTimeout(clickTimer.current);
        wake();
        setFed((count) => count + 1);
        float("🍪"); window.setTimeout(() => float("nom"), 250);
        say(fed >= 3 ? "So full. Maybe compact me?" : "Nom. Tokens are tasty", 1600);
        play("boop");
        poke();
      }}
      onContextMenu={(event) => { event.preventDefault(); onHide(); }}>
      {!asleep && job === "carry" ? <CarriedBox /> : null}
      <ClawdFrame frame={clawd.frame ?? restFrame({ mood: shown, asleep, step, blink, job,
        pose: ride ? { ...pose, walking: ride.mode === "riding", look: ride.look } : pose })} />
      <Prop job={asleep || ride ? "none" : job} step={step} tick={tick} />
    </button>
  </div>;
  // The room behind Clawd, the roof and walls in front of it: with the front open, it shows inside.
  const house = loop ? <>
    <div className="cx-pet-house-spot is-inside" style={housePlace(loop)}><HouseInside home={home} asleep={asleep} /></div>
    <div className="cx-pet-house-spot" style={housePlace(loop)}>
      <House home={home} asleep={asleep} onKnock={() => { if (!wake()) goHome(false); }} />
    </div>
  </> : null;
  // Aboard the pointer or carried, it lives on the page itself, so no panel's edge clips it.
  return <>{house}{(ride || held) && typeof document !== "undefined" ? createPortal(pet, document.body) : pet}</>;
}
