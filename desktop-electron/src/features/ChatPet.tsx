import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type CSSProperties, type PointerEvent as ReactPointerEvent,
  type ReactElement } from "react";
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
//
// In split view there is one Clawd for all the panes (chat-pet-stage.ts). It lives on one pane's box
// and leaps across to the others: to visit, to follow you to the pane you click into, to deliver its
// file box to another working chat, and when another chat asks for you, finishes or fails. Its house
// stands under the chat list; it leaps there to sleep, and out again to the pane you are in. Drop it
// over another pane's box and it lands there.

import type { PetMood } from "./ao-chat";
import { petCall, petStage, type PetArrival } from "./chat-pet-stage";
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
/** The squash on landing and the dust it kicks up (codex-chat.css cx-pet-land, cx-pet-dust). */
const LAND_MS = 420;
/** How a drop lands: how hard it squashes and kicks up dust (0 none, 1 the most), whether it bounces
 *  back up with a hop once it has squashed, and what it says (null: nothing). */
type Landing = { impact: number; hop: boolean; line: string | null };
/** The landing for a drop from `height` px above the box's top edge (0: let go level with it or below). */
function landingFor(height: number): Landing {
  // Harder with the drop's square root, as its fall time grows, so small drops still show; even let
  // go at the edge, a little squash. A middling drop bounces back up with a hop; a big one flattens
  // it too much to bounce.
  const impact = Math.min(1, 0.15 + 0.85 * Math.sqrt(height / 400));
  if (height >= 300) return { impact, hop: false, line: "Oof!" };
  if (height >= 80) return { impact, hop: true, line: height >= 160 ? "Nailed it" : null };
  return { impact, hop: false, line: null };
}
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
/** How often a walking Bit is redrawn; it still moves by the time each frame took. */
const WALK_FPS = 60;
/** How near (px) the pointer must come before Bit turns its eyes to it, and before it leaps on. */
const NOTICE = 180;
const REACH = 70;
/** How often (ms), while the pointer moves, Bit checks where it is (every frame only while riding it). */
const LOOK_EVERY_MS = 100;
/** Between two leaps onto the pointer, so it plays now and then rather than pestering. */
const PLAY_EVERY = 15_000;
/** A ride lasts at most this long (ms) before it jumps off by itself; a click, Escape or a quick
 *  shake of the pointer makes it jump off at once. */
const MAX_RIDE = 4_000;
/** A pointer move this fast (px in one frame) shakes it off. */
const SHAKE = 90;
/** What it does now and then while riding, from Claude Code's own animations. */
const RIDE_PLAYS: AnimationName[] = ["jump", "wink", "look", "boop", "tap"];
/** In split view: the yard under the chat list where its house stands. */
const YARD = ".ao-workflow > .cx-threads .cx-pet-yard";
/** How often it follows you into the pane you click into, and how long it takes to notice (ms). */
const FOLLOW_CHANCE = 0.6;
const FOLLOW_MS = 900;

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
const VISITING = ["Knock knock", "What's going on here?", "Just visiting", "Hi, neighbour"];
const FOLLOWING = ["Wait for me!", "Coming along", "Right behind you"];

// Props and the house, in Clawd's pixels.
const P = { frame: "#3d3d3a", screen: "#1f2a33", glow: "#7fd1ff", key: "#b4b2a7", mug: "#efede6", rim: "#8c8a82", steam: "#c9c7bd",
  page: "#faf9f5", cover: "#6a9bcc", wood: "#8a5a3c", metal: "#5b5a55", lens: "#bfe3f5", box: "#c8a26b", boxDark: "#9b7a48",
  roof: "#b85c3f", roofEdge: "#8f4430", wall: "#e3cfa6", wallEdge: "#b89b6a", door: "#5a3a26", knob: "#f5c451",
  glass: "#3d5a73", lit: "#f5c451", frameLight: "#faf9f5",
  // The room: walls a shade darker than the house's outside, so the furniture stands out against them.
  inside: "#cfb586", insideEdge: "#a8895a", floor: "#8a5a3c", plank: "#74482e", rug: "#4f7fb3", rugEdge: "#c0563f",
  shelf: "#5a3a26", sky: "#9fd3f0", leaf: "#5f9a4c", leafDark: "#3f7a34" };

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
 * middle of the room (columns 8-25 of its 3-30), on a rug, in front of a framed landscape, with a
 * bookshelf and a plant on it to its left and a window over a cabinet to its right; its walls (rows
 * 6-12) are a row taller than Clawd. Each piece is a few pixels across, in colours that stand out
 * from the walls (the user: at a pixel each, the room read as having no furniture).
 */
function HouseInside({ home, asleep }: { home: boolean; asleep: boolean }) {
  const r = rect;
  const lit = home && !asleep;
  return houseSvg([
    // Back wall with a skirting board, a planked floor and the rug Clawd stands on.
    r(3, 6, 28, 6, P.inside, "back"), r(3, 11, 28, 1, P.insideEdge, "skirting"), r(3, 12, 28, 1, P.floor, "floor"),
    ...[5, 9, 22, 28].map((x) => r(x, 12, 1, 1, P.plank, `plank${x}`)),
    r(9, 12, 16, 1, P.rug, "rug"), r(9, 12, 1, 1, P.rugEdge, "rug-l"), r(24, 12, 1, 1, P.rugEdge, "rug-r"),
    // Middle: a framed landscape over where Clawd stands, so the room is not bare while it is out.
    r(13, 7, 8, 4, P.wood, "picture"), r(14, 8, 6, 2, P.sky, "picture-sky"), r(14, 9, 6, 1, P.leaf, "picture-hill"),
    r(17, 8, 2, 1, P.leaf, "picture-hilltop"),
    // Left: a bookshelf, two shelves of books, a plant on top.
    r(3, 7, 5, 5, P.shelf, "shelf"),
    r(4, 8, 1, 1, P.cover, "book-1"), r(5, 8, 1, 1, P.roof, "book-2"), r(6, 8, 1, 1, P.knob, "book-3"),
    r(4, 10, 1, 1, P.leaf, "book-4"), r(5, 10, 1, 1, P.page, "book-5"), r(6, 10, 1, 1, P.cover, "book-6"),
    r(4, 6, 3, 1, P.leaf, "plant"), r(5, 6, 1, 1, P.leafDark, "plant-middle"),
    // Right: a window (lit while Clawd is home awake) on its sill, over a cabinet.
    r(26, 6, 4, 3, P.frameLight, "window-frame"), r(27, 7, 2, 1, lit ? P.lit : P.sky, "window"), r(26, 9, 4, 1, P.wood, "window-sill"),
    r(26, 10, 4, 2, P.shelf, "cabinet"), r(28, 10, 1, 1, P.knob, "cabinet-knob"),
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
/**
 * `at` on a box that has just resized: the same spot on the same side and the same lap. The box
 * grows and shrinks from its top as text is typed or sent, so on the top edge it keeps its distance
 * from the left corner (riding the edge up and down), and on the sides it keeps its distance from
 * the bottom, which stays put. (Kept as a bare distance, every line typed slid it to another side
 * and turned it a quarter: the user saw it go crazy.)
 */
export function reanchor(from: Loop, to: Loop, at: number): number {
  const lap = Math.floor(at / from.length);
  const { x, y, side } = spotAt(from, at);
  const { width: w, height: h } = to;
  const clamp = (value: number, max: number) => Math.max(0, Math.min(max, value));
  // Its height down the side, from the top, at the same distance from the bottom as before.
  const down = clamp(h - (from.height - y), h);
  const along = side === 0 ? clamp(x, w)
    : side === 1 ? w + down
    : side === 2 ? w + h + (w - clamp(x, w))
    : 2 * w + h + (h - down);
  // A spot at the very end of a side is the next side's start; keep it under one lap.
  return lap * to.length + Math.min(along, to.length - 0.001);
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

type PetProps = {
  mood: PetMood;
  /** Share of the context window in use (0–1), when the agent reports it. */
  context: number | null;
  onHide: () => void;
};
/** Where Clawd's feet are on the screen (the middle of its bottom edge). */
type Point = { x: number; y: number };

function PetBody({ mood, context, onHide, split }: PetProps & {
  /** In split view: the pane it lives in now (one pet for all panes). Null outside split view. */
  split: { pane: HTMLElement } | null;
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
  // Where along the box's top edge a fall lands (px from its left), for the shadow growing there.
  const [dropX, setDropX] = useState<number | null>(null);
  // Just landed: how hard (0–1), squashing it and kicking up dust until the squash ends (null: not).
  const [landing, setLanding] = useState<number | null>(null);
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
  // Where the walk under way ends (a distance around), moved with the box when it resizes.
  const walkTarget = useRef(0);
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
  // Leaping across the screen (to another pane's box, or to and from its house under the chat list):
  // its feet, and how long the leap takes (ms; 0 at the start, before it takes off). Its own timer.
  const [leap, setLeap] = useState<(Point & { ms: number }) | null>(null);
  const leapNow = useRef(leap);
  leapNow.current = leap;
  const leapTimer = useRef<number | undefined>(undefined);
  // In split view, the yard under the chat list where its house stands (none while the list is
  // hidden or too narrow: the house then stands by the box as outside split view), and the house's lot.
  const [yard, setYard] = useState<HTMLElement | null>(null);
  const yardNow = useRef(yard);
  yardNow.current = yard;
  const lot = useRef<HTMLDivElement>(null);
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
    || doorNow.current || leapNow.current !== null;
  /** The other panes' boxes it can leap to (split view). */
  const otherPanes = () => split ? [...petStage.seats().keys()].filter((pane) => pane !== split.pane && pane.isConnected) : [];

  // Its yard under the chat list, while the list shows wide enough for the house.
  useEffect(() => {
    if (!split) return undefined;
    const found = document.querySelector<HTMLElement>(YARD);
    const check = () => setYard(found && found.isConnected && found.offsetWidth >= HOUSE_W ? found : null);
    check();
    if (!found) return undefined;
    const observer = new ResizeObserver(check);
    observer.observe(found);
    return () => observer.disconnect();
  }, []);

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
      const current = loopNow.current;
      if (current && current.width === width && current.height === height && current.beside === beside) return;
      const next: Loop = { width, height, length: 2 * (width + height), beside };
      // Resized (the box grows a line at a time as text is typed): it stays where it stands, and a
      // walk under way still heads for the same spot.
      if (current && !Number.isNaN(atNow.current)) {
        atNow.current = reanchor(current, next, atNow.current);
        setAt(atNow.current);
        if (walkFrame.current) walkTarget.current = reanchor(current, next, walkTarget.current);
      }
      loopNow.current = next;
      setLoop(next);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(parent);
    // The room beside the box changes with the window as well as with the box itself.
    window.addEventListener("resize", measure);
    return () => { observer.disconnect(); window.removeEventListener("resize", measure); };
  }, []);
  // First placement: where it just leapt to from another pane, else the saved fraction of the way
  // round, else near the top-right corner.
  useEffect(() => {
    if (!loop || !Number.isNaN(atNow.current)) return;
    const arrival = split ? petStage.arrivalFor(split.pane) : null;
    if (arrival) { land(arrival); return; }
    let saved = Number.NaN;
    try { saved = Number(localStorage.getItem(POSITION_KEY) ?? Number.NaN); } catch { /* first visit */ }
    setAt(saved >= 0 && saved < 1 ? saved * loop.length : Math.max(WIDTH / 2, loop.width - 2 * WIDTH));
    if (!entrancePlayed && !still) { entrancePlayed = true; play(pickOne(ENTRANCES)); }
  }, [loop]);
  /** Landed on this pane's box from another pane: a hop, a word, and on with what it came to do. */
  const land = (arrival: PetArrival) => {
    const current = loopNow.current;
    if (!current) return;
    atNow.current = nearLap(current, Math.max(WIDTH / 2, Math.min(current.width - WIDTH / 2, arrival.x)), 0);
    setAt(atNow.current);
    play("jump");
    if (arrival.line) say(arrival.line, 1600);
    remember();
    poke();
    cancelPlans();
    if (moodNow.current === "ask") { runToSend(); wander(); return; }
    if (arrival.carry && !still) {
      // The file box it brought: carried a little way along and set down here.
      setJob("carry");
      walkTo(nextSpot(true), SCURRY * 0.8, () => { setJob("none"); play("jump"); float("📦"); wander(); });
      return;
    }
    wander();
  };
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
  /** Whether standing at `spot` (a distance around) would cover one of `rects`. `frame` is the box's
   *  rect: a walk reads it once, since reading it right after each step moved Bit forced a layout on
   *  every frame (1,917 layouts in 20 s while Bit strolled, seen 2026-10-23). */
  const blocked = (spot: number, rects: DOMRect[], frame = composer.current?.getBoundingClientRect()) => {
    const current = loopNow.current;
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
    // With its house under the chat list, it leaps off the top edge's left end, the end nearest the list.
    if (yardNow.current) return nearLap(current, WIDTH / 2, atNow.current);
    return nearLap(current, current.beside ? current.width + current.height - WIDTH / 2 : houseLeft(current) + HOUSE_W / 2, atNow.current);
  };
  /** Whether standing at `spot` would leave it half behind the house: it only stops there to go in.
   *  Beside the box that is the right side next to the house, and the top edge's right end when the
   *  house is taller than the box and stands up past its top; on the top edge, the house's span. */
  const inHouse = (spot: number) => {
    const current = loopNow.current;
    if (!current || current.beside || yardNow.current) return false;
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
    const box = composer.current?.getBoundingClientRect();
    const direction = target >= atNow.current ? 1 : -1;
    walkTarget.current = target;
    setPose({ ...REST, walking: true, look: direction > 0 ? 1 : -1 });
    let last = performance.now();
    let shown = 0;
    const frame = (now: number) => {
      const elapsed = Math.min(0.05, (now - last) / 1000);
      last = now;
      // Where it is headed: the box resizing (reanchor) can move the spot while it walks.
      const end = walkTarget.current;
      const next = atNow.current + direction * speed * (blocked(atNow.current, rects, box) ? DASH : 1) * elapsed;
      const arrived = direction > 0 ? next >= end : next <= end;
      atNow.current = arrived ? end : next;
      // Bit moves every frame but is drawn at most WALK_FPS times a second: on a 165 Hz screen each
      // step re-rendered the pet and recalculated styles 165 times a second.
      if (arrived || now - shown >= 1000 / WALK_FPS) { shown = now; setAt(atNow.current); }
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
    const others = otherPanes();
    if (moodNow.current === "working") {
      // At work: settle at a tool for a while; carrying walks on to drop the box somewhere. In split
      // view a box is sometimes for another working chat: it carries it over and leaps across with it.
      const next = pick(WORK);
      const working = others.filter((pane) => petStage.seats().get(pane)?.mood === "working");
      if (next === "carry" && working.length && Math.random() < 0.5) {
        setJob("carry");
        walkTo(nextSpot(true), SCURRY * 0.8, () => { if (!hop(pick(working), "Delivery!", true)) { setJob("none"); play("jump"); } });
        return;
      }
      if (next === "carry") { setJob("carry"); walkTo(nextSpot(true), SCURRY * 0.8, () => { setJob("none"); play("jump"); }); return; }
      setJob(next);
      later(5000 + Math.random() * 4000, () => setJob("none"));
      return;
    }
    // In split view, now and then it leaps over to visit another pane.
    const choices: ("play" | "sit" | "muse" | "coffee" | "read" | "rest" | "visit")[] = ["play", "play", "play", "sit", "muse", "coffee", "read", "rest"];
    if (others.length) choices.push("visit", "visit");
    const choice = pick(choices);
    if (choice === "visit") { hop(pick(others), pick(VISITING)); return; }
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

  /** Feet on the box's top edge at `x` (px from its left end), on the screen. */
  const topEdge = (composer: HTMLElement, x: number): Point & { along: number } => {
    const frame = composer.getBoundingClientRect();
    const along = Math.max(WIDTH / 2, Math.min(frame.width - WIDTH / 2, x));
    return { x: frame.left + along, y: frame.top, along };
  };
  /** Its feet in its room in the house under the chat list, on the screen. */
  const roomFeet = (): Point | null => {
    const spot = lot.current?.getBoundingClientRect();
    return spot ? { x: spot.left + HOUSE_W / 2, y: spot.top + HOUSE_H } : null;
  };
  /**
   * A leap across the screen, feet from `from` to `to` (an arc: up first, then down onto the spot),
   * then `done`. It flies on the page itself, over every pane, so no pane's edge clips it.
   */
  const leapTo = (from: Point, to: Point, done: () => void) => {
    window.clearTimeout(leapTimer.current);
    const ms = still ? 0 : Math.round(Math.min(900, Math.max(380, Math.hypot(to.x - from.x, to.y - from.y) * 0.9)));
    leapNow.current = { ...from, ms: 0 };
    setLeap(leapNow.current);
    setPose({ ...REST, arms: "both", walking: true, look: to.x < from.x ? -1 : 1 });
    // Two frames later, so the leap starts from where it stood.
    window.requestAnimationFrame(() => window.requestAnimationFrame(() => setLeap((current) => current && { ...to, ms })));
    leapTimer.current = window.setTimeout(() => {
      leapNow.current = null;
      setLeap(null);
      setPose(REST);
      done();
    }, ms + 34);
  };
  /**
   * Over to another pane's box (split view): it leaps onto that box's top edge, and the pet there
   * carries on (with the file box, when it brought one). False when it cannot go there now.
   */
  const hop = (pane: HTMLElement, line: string, carry = false) => {
    const seat = petStage.seats().get(pane);
    if (!split || !seat || pane === split.pane || !seat.composer.isConnected || seat.composer.offsetWidth < 2 * WIDTH) return false;
    cancelPlans();
    window.clearTimeout(doorTimer.current);
    setJob(carry ? "carry" : "none");
    const from = screenAt(atNow.current);
    const frame = seat.composer.getBoundingClientRect();
    const to = topEdge(seat.composer, from.x - frame.left);
    leapTo(from, to, () => {
      if (petStage.handoff(pane, { x: to.along, carry, line })) return;
      // That pane closed mid-leap: it is back where it took off.
      setJob("none");
      wander();
    });
    return true;
  };
  /** It runs to the top-right corner, by the send button, and waves for attention. */
  const runToSend = () => {
    const current = loopNow.current;
    if (!still && current && !leapNow.current) walkTo(freeNear(nearLap(current, current.width - WIDTH / 2, atNow.current)), SCURRY * 1.4, () => play("jump"));
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
      // Its house under the chat list: from the box's left end it leaps across into its room.
      const room = yardNow.current && !still ? roomFeet() : null;
      if (room) { leapTo(screenAt(atNow.current), room, inside); return; }
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
  /** Out of the house, through the door on the side facing the box; `walkOut` strolls off too. From
   *  its house under the chat list it leaps out onto a box: `toward`'s, else the focused pane's. */
  const leaveHome = (walkOut = true, toward?: HTMLElement) => {
    if (!homeNow.current && !doorNow.current) return;
    window.clearTimeout(doorTimer.current);
    const room = homeNow.current && yardNow.current && split ? roomFeet() : null;
    if (room && split) {
      const focused = petStage.focused();
      const pane = toward ?? (focused && petStage.seats().has(focused) ? focused : split.pane);
      const target = (pane === split.pane ? null : petStage.seats().get(pane)?.composer) ?? composer.current;
      if (target) {
        homeNow.current = false;
        setHome(false);
        setAsleep(false);
        // It lands near the box's left end, the end nearest the house.
        const to = topEdge(target, 1.5 * WIDTH);
        leapTo(room, to, () => {
          if (target !== composer.current && petStage.handoff(pane, { x: to.along, carry: false, line: "" })) return;
          const current = loopNow.current;
          if (current) { atNow.current = nearLap(current, to.along, atNow.current); setAt(atNow.current); }
          play("jump");
          remember();
          poke();
          if (moodNow.current === "ask") runToSend();
          wander();
        });
        return;
      }
    }
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
    if (mood === "ask") { say(LINES.ask, 2600); runToSend(); }
    wander();
    return cancelPlans;
  }, [mood]);

  // Split view: another pane's chat calls it over (a request waiting on you, a finished turn, a
  // failure), and it now and then follows you into the pane you click into.
  useEffect(() => {
    if (!split || still) return undefined;
    let follow = 0;
    const off = petStage.subscribe((event) => {
      if (event.kind === "host" || event.pane === split.pane) return;
      if (drag.current || heldNow.current || rideNow.current || leapNow.current || moodNow.current === "ask") return;
      if (event.kind === "mood") {
        const line = petCall(event.mood, event.was, Math.random());
        if (line === null) return;
        window.clearTimeout(follow);
        if (homeNow.current) { setAsleep(false); leaveHome(true, event.pane); return; }
        cancelPlans();
        hop(event.pane, line);
        return;
      }
      window.clearTimeout(follow);
      const calm = moodNow.current === "idle" || moodNow.current === "done";
      if (!calm || asleepNow.current || homeNow.current || Math.random() >= FOLLOW_CHANCE) return;
      follow = window.setTimeout(() => { if (!busyElsewhere() && petStage.focused() === event.pane) hop(event.pane, pick(FOLLOWING)); }, FOLLOW_MS);
    });
    return () => { off(); window.clearTimeout(follow); };
  }, []);
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
    let timer = 0;
    let moved = 0;
    const onMove = (event: PointerEvent) => {
      moved += event.clientX - pointer.current.x;
      pointer.current = { x: event.clientX, y: event.clientY };
      if (frame || timer) return;
      // Aboard, it follows the pointer every frame. Otherwise it only turns its head or starts a
      // game, which ten checks a second cover: a frame asked for on every move made the whole window
      // lay out and paint at the screen's rate (136 times a second) whenever the mouse moved.
      if (rideNow.current) frame = window.requestAnimationFrame(check);
      else timer = window.setTimeout(check, LOOK_EVERY_MS);
    };
    const check = () => {
      frame = 0;
      timer = 0;
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
      if (!body || asleepNow.current || drag.current || heldNow.current || leapNow.current) return;
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
    return () => {
      window.removeEventListener("pointermove", onMove); form?.removeEventListener("input", onInput);
      if (frame) window.cancelAnimationFrame(frame);
      if (timer) window.clearTimeout(timer);
    };
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
    window.clearTimeout(napTimer.current); window.clearTimeout(fallTimer.current); window.clearTimeout(doorTimer.current); window.clearTimeout(leapTimer.current);
    dragEnd.current?.(); cancelPlans();
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
   * from wherever on the screen it was let go: arms up and feet kicking, its shadow growing where it
   * will land. It lands with a squash and a puff of dust (landingFor: harder the higher), a hop after
   * a middling drop, then hops off any button it landed on.
   */
  const dragDrop = () => {
    const state = drag.current;
    drag.current = null;
    if (!state?.moved) { if (!asleepNow.current) wander(); return; }
    const current = loopNow.current;
    const frame = composer.current?.getBoundingClientRect();
    if (!current || !frame) { setPose(REST); setHeld(null); wander(); return; }
    setPose({ ...REST, arms: "both", walking: true });
    // In split view, let go over another pane, it falls onto that pane's box and lives there.
    const other = otherPanes().find((pane) => {
      const rect = pane.getBoundingClientRect();
      return state.lastX >= rect.left && state.lastX <= rect.right && state.lastY >= rect.top && state.lastY <= rect.bottom;
    });
    const otherBox = other && petStage.seats().get(other)?.composer;
    const across = otherBox ? topEdge(otherBox, state.lastX - otherBox.getBoundingClientRect().left) : null;
    const x = Math.max(WIDTH / 2, Math.min(current.width - WIDTH / 2, state.lastX - frame.left));
    const spot = nearLap(current, x, atNow.current);
    const to = across ? { x: across.x, y: across.y - HEIGHT / 2 } : { x: frame.left + x, y: frame.top - HEIGHT / 2 };
    // How far above the top edge it lands on it was let go (0 level with it or below).
    const height = Math.max(0, Math.round(to.y - state.lastY));
    // A longer drop takes longer, as a fall does: 420 ms from 400 px.
    const distance = Math.hypot(to.x - state.lastX, to.y - state.lastY);
    const fallMs = still ? 0 : Math.round(Math.min(1100, Math.max(260, FALL_MS * Math.sqrt(Math.max(distance, 1) / 400))));
    if (height > 40) say("Wheee", 900);
    // The shadow is drawn on this box's top edge; over another pane's box it has none.
    setDropX(across ? null : x);
    // Two frames later, so the fall starts from where it was let go.
    window.requestAnimationFrame(() => window.requestAnimationFrame(() => setHeld({ ...to, fall: fallMs })));
    // Its own timer: a mood change clears the wander plans, and must not leave it in the air.
    window.clearTimeout(fallTimer.current);
    fallTimer.current = window.setTimeout(() => {
      if (other && across && petStage.handoff(other, { x: across.along, carry: false, line: "" })) return;
      atNow.current = spot;
      setAt(spot);
      setHeld(null);
      setPose(REST);
      const { impact, hop, line } = landingFor(height);
      const squashed = !still && impact > 0;
      if (squashed) setLanding(Math.min(1, impact));
      if (line) say(line, 1100);
      poke();
      // Once the squash is over, a hop if it bounces, then off any button and on with its day.
      later(squashed ? LAND_MS : 0, () => {
        if (hop) play("jump");
        const free = freeNear(atNow.current);
        if (free !== atNow.current) walkTo(free, SCURRY * DASH, () => { remember(); wander(); });
        else { remember(); wander(); }
      });
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
  // Home in its house under the chat list (split view): in the middle of the room there.
  const inLot = Boolean(yard && home && !ride && !held && !leap);
  const inRoom = home && !ride && !held && !leap && (yard ? { left: 0, top: 0 } : loop?.beside ? housePlace(loop) : null) || null;
  // On its doorstep in the yard: upright on the ground, just out from the box's right side, facing the
  // open front. Between there and the room it walks at DOOR_MS (the walls are drawn over it).
  const atDoor = door && !home && !ride && !held && !leap && !yard && loop?.beside ? { left: loop.width + 2, top: loop.height - HEIGHT } : null;
  const doorWalk: CSSProperties = door && (inRoom || atDoor) ? { transition: `left ${DOOR_MS}ms linear, top .2s ease-in, transform .18s ease-out` } : {};
  // Upright on the ground, as many whole turns as the laps it walked: stepping off the box's side is
  // a quarter turn back, not a spin through every lap.
  const upright: CSSProperties = { transform: `rotate(${loop && !Number.isNaN(at) ? Math.floor(at / loop.length) * 360 : 0}deg)`,
    transformOrigin: `${WIDTH / 2}px ${HEIGHT}px` };
  const side = loop && !Number.isNaN(at) && !ride && !held && !leap && !inRoom && !atDoor ? spotAt(loop, at).side : 0;
  // On the box: feet on the outline, body outward, so upright on top, sideways on the sides and
  // upside down under it. On the pointer or held: upright, above everything.
  const placement: CSSProperties = inRoom
    ? { left: inRoom.left + HOUSE_W / 2 - WIDTH / 2, top: inRoom.top + HOUSE_H - HEIGHT, ...upright, ...doorWalk }
    : atDoor
    ? { ...atDoor, ...upright, ...doorWalk }
    : leap
    // Leaping: across in a straight line, up and then down (the overshoot of the curve is the arc).
    ? { position: "fixed", left: leap.x - WIDTH / 2, top: leap.y - HEIGHT, zIndex: 60, pointerEvents: "none",
      transition: leap.ms ? `left ${leap.ms}ms linear, top ${leap.ms}ms cubic-bezier(.3,-.6,.6,1)` : "none" }
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
  const pet = <div ref={box} className={`cx-pet side-${side}${held ? " is-held" : ""}${ride ? ` is-riding ride-${ride.mode}` : ""}${home ? " is-home" : ""}${leap ? " is-leaping" : ""}`}
    style={{ ...placement, ...(landing !== null ? { "--cx-pet-impact": landing } as CSSProperties : {}) }}>
    {bubble ? <span className="cx-pet-bubble" role="status">{bubble}</span> : null}
    {landing !== null ? <><span className="cx-pet-dust is-left" aria-hidden="true" /><span className="cx-pet-dust is-right" aria-hidden="true" /></> : null}
    {busy ? <span className="cx-pet-spinner" aria-hidden="true">{SPINNER[spin]}</span> : null}
    {floaters.map((item) => <span key={item.id} className="cx-pet-float" style={{ left: item.offset }} aria-hidden="true">{item.text}</span>)}
    <button type="button" className={`cx-pet-body is-${shown}${asleep ? " is-asleep" : ""}${pose.walking ? " is-walking" : ""}${job !== "none" ? ` is-${job}` : ""}${landing !== null ? " is-landing" : ""}`}
      // The squash ends itself, so no cancelled plan can leave it squashed.
      onAnimationEnd={(event) => { if (event.animationName === "cx-pet-land") setLanding(null); }}
      aria-label={`Bit the pet: ${asleep ? "napping" : LINES[shown]}${percent !== null ? ` Context ${percent}%.` : ""}`}
      title={asleep ? "Napping. Click to wake" : `${LINES[shown]}${percent !== null ? ` · ${percent}% context` : ""}\nClick to pet · double-click to feed · drag to move`}
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
  // In split view the house stands in its yard under the chat list, with Clawd in it when home.
  const rooms = (place: CSSProperties, inside: ReactElement | null) => <>
    <div className="cx-pet-house-spot is-inside" style={place}><HouseInside home={home} asleep={asleep} /></div>
    {inside}
    <div className="cx-pet-house-spot" style={place}>
      <House home={home} asleep={asleep} onKnock={() => { if (!wake()) goHome(false); }} />
    </div>
  </>;
  const house = yard ? createPortal(<div ref={lot} className="cx-pet-lot">{rooms({ left: 0, top: 0 }, inLot ? pet : null)}</div>, yard)
    : loop ? rooms(housePlace(loop), null) : null;
  // Falling onto this box, its shadow grows on the top edge where it will land.
  const shadow = held?.fall && dropX !== null ? <span className="cx-pet-drop-shadow" aria-hidden="true"
    style={{ left: dropX, animationDuration: `${held.fall}ms` }} /> : null;
  // Aboard the pointer, carried or leaping, it lives on the page itself, so no panel's edge clips it.
  return <>{house}{shadow}{inLot ? null : (ride || held || leap) && typeof document !== "undefined" ? createPortal(pet, document.body) : pet}</>;
}

/**
 * Bit on a chat box. Outside split view each chat box has its own; in split view there is one for
 * all the panes, living on one pane's box at a time (chat-pet-stage.ts): every other pane only
 * offers it a seat, its box and its chat's mood, and draws nothing.
 */
export function ChatPet(props: PetProps) {
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
