import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { createPortal } from "react-dom";

// Bit, the chat's pet: Claude's Clawd, drawn with the sprites of the Claude desktop app installed on
// this computer (electron/claude-sprites.cjs reads them; nothing of Claude's is copied into this
// app), at 2 screen px per sprite pixel; without Claude installed it keeps its own drawing.
//
// It lives on the chat box's top edge and acts out what the agent does: thinking (Thinking), running
// commands and writing (at the laptop), editing (at the desktop), reading (an idea lights up);
// waits pointing when a request needs you, dances when a turn finishes, and is disappointed, dizzy
// or facepalms when one fails. Idle, it looks around, sways, meditates and strolls (dashing past
// buttons). Drag it anywhere, with no limit; let go and it falls back onto the box (or to the
// window's floor, and hops back up). Come close and it may hop onto the pointer for a ride. Left
// alone while nothing runs it pulls a bed out of itself and naps. Click to pet, double-click to
// feed, right-click for its menu. Pure view: it reads the chat's state and changes nothing.

import type { PetActivity, PetMood } from "./ao-chat";

const SCALE = 2;
const POSITION_KEY = "coding-tools:ao:pet-ground";
const NAP_MS = 45_000;
const GRAVITY = 2600;
const WALK = 42, RUN = 110, DASH = 2.8;
/** How near (px) the pointer must stay, and for how long (ms), before Bit hops onto it. */
const REACH = 56, HOVER_MS = 700;
/** How high (px) the bed's mattress is: Clawd lies on it. */
const MATTRESS = 5 * SCALE;

type RawSprite = { w: number; h: number; fps: number; palette: string[]; base: string; deltas: string[]; a0: number[] };
type Sheet = { w: number; h: number; fps: number; ax: number; ay: number; frames: HTMLCanvasElement[] };
type Anim = "Walking" | "Running" | "Laptop" | "Desktop" | "Thinking" | "Lightbulb" | "Spark" | "Waving" | "Pointing" | "JumpingHappy"
  | "Jumping" | "DancingHappy" | "Excited" | "Disappointed" | "Facepalm" | "Dizzy" | "Meditating" | "LookingAround" | "Swaying" | "Turning";

const LINES: Record<PetMood, string> = {
  idle: "Nothing running. Want to start something?",
  working: "Busy busy. The agent is on it.",
  ask: "Psst, the agent is asking you something.",
  done: "Turn finished. Nice work.",
  error: "Something broke. Retry the step?",
};
const WORKING: Record<NonNullable<PetActivity> | "none", Anim> = {
  thinking: "Thinking", command: "Laptop", writing: "Laptop", edit: "Desktop", read: "Lightbulb", none: "Laptop",
};
const IDLE: readonly Anim[] = ["LookingAround", "Swaying", "Meditating", "LookingAround", "Turning"];
const PETTED = ["Hehe", "More pets, please", "I like you", "*purr*"];
const pick = <T,>(items: readonly T[]) => items[Math.floor(Math.random() * items.length)]!;

/** A sprite's frames as canvases, decoded as Claude's engine does (base, then each delta in turn). */
function decode(raw: RawSprite): Sheet {
  const pixels = Uint8Array.from([...raw.base].map((char) => char === "." ? 255 : parseInt(char, 36)));
  const frames: Uint8Array[] = [pixels.slice()];
  for (const delta of raw.deltas) {
    if (delta) for (const change of delta.split(",")) {
      const end = change.length - 1;
      pixels[parseInt(change.slice(0, end), 36)] = change[end] === "." ? 255 : parseInt(change[end]!, 36);
    }
    frames.push(pixels.slice());
  }
  const canvases = frames.map((frame) => {
    const canvas = document.createElement("canvas");
    canvas.width = raw.w; canvas.height = raw.h;
    const context = canvas.getContext("2d");
    if (!context) return canvas;
    const image = context.createImageData(raw.w, raw.h);
    frame.forEach((index, at) => {
      if (index === 255) return;
      const color = raw.palette[index] ?? "#d97757";
      image.data[at * 4] = parseInt(color.slice(1, 3), 16);
      image.data[at * 4 + 1] = parseInt(color.slice(3, 5), 16);
      image.data[at * 4 + 2] = parseInt(color.slice(5, 7), 16);
      image.data[at * 4 + 3] = 255;
    });
    context.putImageData(image, 0, 0);
    return canvas;
  });
  const box = raw.a0[2]! > 0 ? raw.a0 : [0, 0, raw.w, raw.h];
  return { w: raw.w, h: raw.h, fps: raw.fps || 12, ax: box[0]! + box[2]! / 2, ay: box[1]! + box[3]!, frames: canvases };
}

/** Bit's own Clawd (no Claude installed): the banner glyph's 18×5 sprite, legs stepping. */
function ownSprite(): RawSprite {
  const w = 18, h = 7;
  const frame = (legs: number[]) => {
    const grid = Array.from({ length: w * h }, () => ".");
    const fill = (x: number, y: number, width: number, height: number, color: string) => {
      for (let row = y; row < y + height; row += 1) for (let col = x; col < x + width; col += 1) grid[row * w + col] = color;
    };
    fill(3, 2, 12, 4, "1"); fill(1, 4, 2, 1, "1"); fill(15, 4, 2, 1, "1");
    fill(5, 3, 1, 1, "0"); fill(12, 3, 1, 1, "0");
    legs.forEach((x) => fill(x, 6, 1, 1, "1"));
    return grid.join("");
  };
  const base = frame([4, 6, 11, 13]), step = frame([3, 7, 10, 14]);
  const delta = [...step].map((char, at) => char !== base[at] ? `${at.toString(36)}${char}` : "").filter(Boolean).join(",");
  const back = [...base].map((char, at) => char !== step[at] ? `${at.toString(36)}${char}` : "").filter(Boolean).join(",");
  return { w, h, fps: 6, palette: ["#1f1e1d", "#d97757"], base, deltas: [delta, back], a0: [0, 2, 18, 5] };
}

// Sheets are decoded once per app run and shared by every chat.
let sheets: Partial<Record<Anim, Sheet>> | null = null;
let loading: Promise<Partial<Record<Anim, Sheet>>> | null = null;
function loadSheets(): Promise<Partial<Record<Anim, Sheet>>> {
  if (sheets) return Promise.resolve(sheets);
  loading ??= (async () => {
    let raw: Record<string, RawSprite> = {};
    try {
      const result = await window.codexWebLauncher?.clawdSprites?.();
      if (result?.source === "claude") raw = result.sprites as Record<string, RawSprite>;
    } catch { /* Claude's sprites are optional */ }
    const own = decode(ownSprite());
    const decoded: Partial<Record<Anim, Sheet>> = {};
    for (const [name, sprite] of Object.entries(raw)) { try { decoded[name as Anim] = decode(sprite); } catch { /* left out */ } }
    // Every animation falls back to the nearest one there is, and finally to Bit's own drawing.
    const fallback = (name: Anim, ...others: Anim[]) => decoded[name] ?? others.map((other) => decoded[other]).find(Boolean) ?? decoded.Walking ?? own;
    const all: Anim[] = ["Walking", "Running", "Laptop", "Desktop", "Thinking", "Lightbulb", "Spark", "Waving", "Pointing", "JumpingHappy",
      "Jumping", "DancingHappy", "Excited", "Disappointed", "Facepalm", "Dizzy", "Meditating", "LookingAround", "Swaying", "Turning"];
    sheets = Object.fromEntries(all.map((name) => [name, fallback(name, "Excited", "LookingAround")])) as Record<Anim, Sheet>;
    return sheets;
  })();
  return loading;
}

/** Clawd's bed (pulled out of him at bedtime) and its quilt, in the same chunky pixels. */
function Bed() {
  const r = (x: number, y: number, w: number, h: number, color: string) => <rect key={`${x}-${y}-${color}`} x={x} y={y} width={w} height={h} fill={color} />;
  return <svg className="cx-pet-bed" viewBox="0 0 32 9" width={32 * SCALE} height={9 * SCALE} shapeRendering="crispEdges" aria-hidden="true">
    {[r(29, 0, 3, 9, "#8a5a3c"), r(0, 3, 3, 6, "#8a5a3c"), r(1, 6, 30, 2, "#8a5a3c"), r(3, 4, 26, 2, "#f3f1ea"), r(22, 2, 6, 2, "#ffffff"),
      r(1, 8, 2, 1, "#8a5a3c"), r(29, 8, 2, 1, "#8a5a3c")]}
  </svg>;
}

type Mode = "ground" | "drag" | "fall" | "hop" | "ride" | "bed";

export function ChatPet({ mood, activity = null, context, onHide }: {
  mood: PetMood;
  /** What the agent is doing now (petActivity), acted out while it works. */
  activity?: PetActivity;
  /** Share of the context window in use (0–1), when the agent reports it. */
  context: number | null;
  onHide: () => void;
}) {
  const anchor = useRef<HTMLSpanElement>(null);
  const holder = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const [ready, setReady] = useState<Partial<Record<Anim, Sheet>> | null>(sheets);
  const [bubble, setBubble] = useState<string | null>(null);
  const [floaters, setFloaters] = useState<{ id: number; text: string; dx: number }[]>([]);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const [bed, setBed] = useState<"none" | "out" | "in">("none");
  // Where the bed stands, as an offset from the box's left edge.
  const [bedAt, setBedAt] = useState(0);
  const [still] = useState(() => { try { return window.matchMedia("(prefers-reduced-motion: reduce)").matches; } catch { return false; } });
  // Everything the frame loop reads and writes, outside React: it runs every frame.
  const state = useRef({
    mode: "ground" as Mode, x: 0, y: 0, vy: 0, groundX: Number.NaN, facing: 1 as 1 | -1,
    anim: "LookingAround" as Anim, animStart: 0, walkTo: null as number | null, speed: WALK, dashRects: [] as DOMRect[],
    hop: null as { fromX: number; fromY: number; toX: number; toY: number; start: number; ms: number; then: () => void } | null,
    grab: { dx: 0, dy: 0, startX: 0, startY: 0, moved: false, down: false }, pointer: { x: -1e4, y: -1e4 }, hoverSince: 0,
    lastTouch: Date.now(), cooldownUntil: 0, plans: [] as number[], fed: 0, seq: 0,
  });
  const moodNow = useRef(mood); moodNow.current = mood;
  const activityNow = useRef(activity); activityNow.current = activity;

  useEffect(() => { let alive = true; void loadSheets().then((loaded) => { if (alive) setReady(loaded); }); return () => { alive = false; }; }, []);

  const composer = () => anchor.current?.parentElement?.getBoundingClientRect() ?? null;
  const play = (anim: Anim) => { const s = state.current; if (s.anim !== anim) { s.anim = anim; s.animStart = performance.now(); } };
  const later = (ms: number, run: () => void) => { state.current.plans.push(window.setTimeout(run, ms)); };
  const cancelPlans = () => { state.current.plans.forEach((timer) => window.clearTimeout(timer)); state.current.plans = []; state.current.walkTo = null; };
  // Its own timer, not a plan: a mood change cancels the plans but must not leave a bubble up.
  const bubbleTimer = useRef<number | undefined>(undefined);
  const say = (text: string, ms = 1800) => {
    setBubble(text);
    window.clearTimeout(bubbleTimer.current);
    bubbleTimer.current = window.setTimeout(() => setBubble((current) => current === text ? null : current), ms);
  };
  const float = (text: string) => {
    const id = ++state.current.seq;
    setFloaters((current) => [...current, { id, text, dx: Math.round(Math.random() * 28) - 14 }]);
    window.setTimeout(() => setFloaters((current) => current.filter((item) => item.id !== id)), 1100);
  };
  const touch = () => { state.current.lastTouch = Date.now(); };
  const remember = () => {
    const box = composer();
    if (box && box.width > 0) try { localStorage.setItem(POSITION_KEY, String((state.current.x - box.left) / box.width)); } catch { /* still applies now */ }
  };

  /** Where on the box's top edge x can stand (Clawd stays fully on it). */
  const clampToBox = (x: number, box: DOMRect) => Math.max(box.left + 14 * SCALE, Math.min(box.right - 14 * SCALE, x));
  const buttonsNearBox = (box: DOMRect) => [...(anchor.current?.parentElement?.parentElement?.querySelectorAll("button, a, input, select, [role='button']") ?? [])]
    .filter((element) => !anchor.current?.parentElement?.contains(element)).map((element) => element.getBoundingClientRect())
    .filter((rect) => rect.width > 0 && rect.bottom > box.top - 70 && rect.top < box.top + 4);

  /** Walk along the top edge to x; over a button or chip it dashes and never stops there. */
  const walkTo = (x: number, fast = false) => {
    const s = state.current, box = composer();
    if (!box || still) return;
    s.walkTo = clampToBox(x, box);
    s.speed = fast ? RUN : WALK;
    s.dashRects = buttonsNearBox(box);
  };
  /** A hop in an arc from where it is to a spot on the box's top edge (or `lift` px above it). */
  const hopTo = (x: number, then: () => void = () => undefined, lift = 0) => {
    const s = state.current, box = composer();
    if (!box) return;
    const toX = clampToBox(x, box);
    s.mode = "hop";
    s.hop = { fromX: s.x, fromY: s.y, toX, toY: box.top - lift, start: performance.now(), ms: 650,
      then: () => { s.groundX = toX - box.left; s.mode = "ground"; remember(); then(); } };
    play("Jumping");
  };

  // The routine: what to do next, from the chat's state and what the agent is doing.
  const routine = () => {
    const s = state.current;
    if (s.mode !== "ground") { later(800, routine); return; }
    const now = moodNow.current;
    if (now === "working") {
      play(WORKING[activityNow.current ?? "none"]);
      // Now and then it scurries to another spot to work there.
      if (Math.random() < 0.18) { const box = composer(); if (box) walkTo(box.left + Math.random() * box.width, true); }
      later(2600 + Math.random() * 2400, routine);
      return;
    }
    if (now === "ask") { play("Pointing"); later(3000, routine); return; }
    if (now === "error") { play(pick(["Disappointed", "Facepalm", "Dizzy"] as const)); later(3200, routine); return; }
    if (bedRef.current !== "none") { later(1500, routine); return; }
    if (Date.now() - s.lastTouch > NAP_MS && (now === "idle" || now === "done")) { goToBed(); return; }
    if (Math.random() < 0.45) { const box = composer(); if (box) walkTo(box.left + Math.random() * box.width); }
    else play(pick(IDLE));
    later(2400 + Math.random() * 2600, routine);
  };

  /** Bedtime: a bed pops out of him and lands beside him, he hops in under the quilt and naps. */
  const bedRef = useRef(bed); bedRef.current = bed;
  const goToBed = () => {
    const s = state.current, box = composer();
    if (!box || s.mode !== "ground") return;
    cancelPlans();
    say("Bedtime…", 1300);
    play("Excited");
    const side = s.x + 40 * SCALE < box.right ? 1 : -1;
    s.facing = side as 1 | -1;
    // The bed has its own spot on the box, beside him; he hops onto its mattress.
    const spot = clampToBox(s.x + side * 24 * SCALE, box);
    later(500, () => { setBedAt(spot - box.left); setBed("out"); });
    later(1400, () => hopTo(spot, () => { s.mode = "bed"; setBed("in"); play("Meditating"); setBubble("Zzz"); }, MATTRESS));
  };
  const wake = () => {
    if (bedRef.current === "none") return false;
    if (state.current.mode === "bed") state.current.mode = "ground";
    setBed("none"); setBubble(null);
    say("Huh? I'm up.", 1300); play("Excited"); touch();
    later(1300, routine);
    return true;
  };

  // React to the chat: each mood gets a little scene, then the routine resumes.
  useEffect(() => {
    const s = state.current;
    cancelPlans();
    if (bedRef.current !== "none" && mood !== "idle") wake();
    touch();
    if (mood === "done") { play("DancingHappy"); float("✓"); later(2600, () => play("JumpingHappy")); later(4200, routine); return cancelPlans; }
    if (mood === "error") { play("Disappointed"); say("Uh oh", 1600); }
    if (mood === "ask") {
      say(LINES.ask, 2600);
      const box = composer();
      if (box && s.mode === "ground") walkTo(box.right, true);
    }
    later(600, routine);
    return cancelPlans;
  }, [mood]);
  // A new activity shows at once rather than at the routine's next turn.
  useEffect(() => { if (moodNow.current === "working" && state.current.mode === "ground" && state.current.walkTo === null) play(WORKING[activity ?? "none"]); }, [activity]);
  useEffect(() => { if (context !== null && context >= 0.8) say("I'm getting full. Compact soon?", 2600); }, [context !== null && context >= 0.8]);

  // The frame loop: physics, walking, the ride, and drawing the current frame.
  useEffect(() => {
    if (!ready) return undefined;
    const s = state.current;
    const box = composer();
    if (box) {
      let saved = Number.NaN;
      try { saved = Number(localStorage.getItem(POSITION_KEY)); } catch { /* first time */ }
      s.groundX = Number.isFinite(saved) && saved >= 0 && saved <= 1 ? saved * box.width : box.width - 60 * SCALE;
      s.x = clampToBox(box.left + s.groundX, box); s.y = box.top;
    }
    let frame = 0, last = performance.now();
    // One bad frame must never stop the pet: the next frame is always asked for first.
    const step = (now: number) => {
      frame = window.requestAnimationFrame(step);
      try { tick(now); } catch { /* skip this frame */ }
    };
    const tick = (now: number) => {
      const dt = Math.max(0, Math.min(0.05, (now - last) / 1000)); last = now;
      const rect = composer();
      if (rect && rect.width > 0) {
        if (s.mode === "ground") {
          // Standing on the box: it follows the box as the window or the chat resizes.
          if (s.walkTo !== null) {
            const over = s.dashRects.some((r) => s.x > r.left - 10 && s.x < r.right + 10);
            const speed = s.speed * (over ? DASH : 1);
            const dir = s.walkTo > s.x ? 1 : -1;
            s.facing = dir as 1 | -1;
            play(over || s.speed === RUN ? "Running" : "Walking");
            s.x += dir * speed * dt;
            if ((dir > 0 && s.x >= s.walkTo) || (dir < 0 && s.x <= s.walkTo)) { s.x = s.walkTo; s.walkTo = null; s.groundX = s.x - rect.left; remember(); }
            else s.groundX = s.x - rect.left;
          }
          s.x = clampToBox(rect.left + s.groundX, rect); s.y = rect.top;
        } else if (s.mode === "fall") {
          s.vy += GRAVITY * dt; s.y += s.vy * dt;
          // It lands on the box when it falls onto it, else on the window's floor.
          const overBox = s.x > rect.left && s.x < rect.right && s.y - s.vy * dt <= rect.top + 1;
          const ground = overBox ? rect.top : window.innerHeight - 4;
          if (s.y >= ground) {
            const height = s.vy;
            s.y = ground; s.vy = 0;
            if (overBox) {
              s.mode = "ground"; s.groundX = clampToBox(s.x, rect) - rect.left; remember();
              play(height > 1400 ? "Dizzy" : "Excited");
              later(height > 1400 ? 1600 : 700, routine);
            } else {
              // On the window's floor: a moment there (a hop with no arc holds it still), then it
              // hops back up onto the box.
              s.mode = "hop"; s.hop = null;
              play(height > 1400 ? "Dizzy" : "LookingAround");
              later(height > 1400 ? 1500 : 700, () => hopTo(s.x, () => later(400, routine)));
            }
          }
        } else if (s.mode === "hop" && s.hop) {
          const t = Math.min(1, (now - s.hop.start) / s.hop.ms);
          s.x = s.hop.fromX + (s.hop.toX - s.hop.fromX) * t;
          s.y = s.hop.fromY + (s.hop.toY - s.hop.fromY) * t - Math.sin(Math.PI * t) * 46;
          s.facing = s.hop.toX >= s.hop.fromX ? 1 : -1;
          if (t >= 1) { const then = s.hop.then; s.hop = null; then(); }
        } else if (s.mode === "ride") {
          s.x = s.pointer.x; s.y = s.pointer.y + 2;
        } else if (s.mode === "bed") {
          // In bed: on the mattress, wherever the box is now.
          s.x = clampToBox(rect.left + s.groundX, rect); s.y = rect.top - MATTRESS;
        }
      }
      // Draw: feet at (x, y).
      const sheet = (ready[s.anim] ?? ready.Walking)!;
      const el = holder.current, cv = canvas.current;
      if (el && cv) {
        const width = sheet.w * SCALE, height = sheet.h * SCALE;
        if (cv.width !== width || cv.height !== height) { cv.width = width; cv.height = height; }
        // A frame's timestamp can come a moment before the animation started: never a negative index.
        const index = still ? 0 : Math.floor((Math.max(0, now - s.animStart) / 1000) * sheet.fps) % sheet.frames.length;
        const image = sheet.frames[index] ?? sheet.frames[0];
        const context2d = cv.getContext("2d");
        if (context2d && image) {
          context2d.imageSmoothingEnabled = false;
          context2d.clearRect(0, 0, width, height);
          context2d.drawImage(image, 0, 0, width, height);
        }
        el.style.transform = `translate(${Math.round(s.x)}px, ${Math.round(s.y)}px)`;
        cv.style.left = `${-sheet.ax * SCALE}px`;
        cv.style.top = `${-sheet.ay * SCALE}px`;
        cv.style.transform = s.facing < 0 ? "scaleX(-1)" : "";
        cv.style.transformOrigin = `${sheet.ax * SCALE}px 0`;
      }
    };
    frame = window.requestAnimationFrame(step);
    return () => window.cancelAnimationFrame(frame);
  }, [ready, still]);

  // The pointer: it hops on after the pointer stays near a moment, then rides it for a while.
  useEffect(() => {
    if (still) return undefined;
    const onMove = (event: PointerEvent) => {
      const s = state.current;
      s.pointer = { x: event.clientX, y: event.clientY };
      if (s.grab.down) return;
      const near = Math.hypot(event.clientX - s.x, event.clientY - (s.y - 16 * SCALE)) < REACH;
      if (s.mode === "ground" && near && moodNow.current !== "working" && bedRef.current === "none" && Date.now() > s.cooldownUntil) {
        if (!s.hoverSince) s.hoverSince = Date.now();
        else if (Date.now() - s.hoverSince > HOVER_MS) {
          s.hoverSince = 0; s.cooldownUntil = Date.now() + 12_000;
          cancelPlans(); touch();
          s.mode = "ride"; play("Excited"); float("♥"); float("♥"); say(pick(["Wheee!", "Take me somewhere", "Hold on tight"]), 1400);
          later(4000 + Math.random() * 4000, () => { if (s.mode === "ride") { s.mode = "fall"; s.vy = 0; play("Jumping"); } });
        }
      } else s.hoverSince = 0;
    };
    const onInput = () => { touch(); if (state.current.mode === "ground" && moodNow.current !== "working") { play("Excited"); later(900, routine); } };
    const form = anchor.current?.parentElement;
    window.addEventListener("pointermove", onMove);
    form?.addEventListener("input", onInput);
    return () => { window.removeEventListener("pointermove", onMove); form?.removeEventListener("input", onInput); };
  }, [still]);

  useEffect(() => () => cancelPlans(), []);

  // Drag anywhere: it dangles while carried and falls when let go.
  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    const s = state.current;
    s.grab = { dx: event.clientX - s.x, dy: event.clientY - s.y, startX: event.clientX, startY: event.clientY, moved: false, down: true };
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const s = state.current;
    if (!s.grab.down) return;
    if (!s.grab.moved && Math.hypot(event.clientX - s.grab.startX, event.clientY - s.grab.startY) > 4) {
      s.grab.moved = true; cancelPlans(); touch();
      if (bedRef.current !== "none") { setBed("none"); setBubble(null); }
      s.mode = "drag"; play("Jumping"); say("Wheee", 900);
    }
    if (s.grab.moved) { s.x = event.clientX - s.grab.dx; s.y = event.clientY - s.grab.dy; }
  };
  const onPointerUp = () => {
    const s = state.current;
    const wasDrag = s.grab.moved;
    s.grab.down = false; s.grab.moved = false;
    if (wasDrag) { s.mode = "fall"; s.vy = 0; return; }
    // A click: pet it (or wake it).
    if (wake()) return;
    touch(); cancelPlans();
    play("JumpingHappy"); float("♥"); float("♥"); say(pick(PETTED), 1400);
    later(1500, routine);
  };

  const run = (what: string) => {
    setMenu(null);
    const s = state.current;
    cancelPlans(); touch();
    if (what === "nap") { s.lastTouch = 0; goToBed(); return; }
    if (bedRef.current !== "none") wake();
    if (what === "dance") { play("DancingHappy"); later(3000, routine); }
    else if (what === "wave") { play("Waving"); say("Hi!", 1200); later(2200, routine); }
    else if (what === "think") { play("Lightbulb"); later(3500, routine); }
    else if (what === "ride") { s.mode = "ride"; play("Excited"); later(6000, () => { if (s.mode === "ride") { s.mode = "fall"; s.vy = 0; } }); }
    else if (what === "hide") onHide();
  };

  const percent = context === null ? null : Math.round(context * 100);
  const layer = <div ref={holder} className={`cx-pet${bed !== "none" ? ` bed-${bed}` : ""}`} aria-hidden={false}>
    <canvas ref={canvas} className="cx-pet-canvas" role="img"
      aria-label={`Bit the pet: ${bed === "in" ? "napping" : LINES[mood]}${percent !== null ? ` Context ${percent}%.` : ""}`}
      title={`${bed === "in" ? "Napping. Click to wake" : LINES[mood]}${percent !== null ? ` · ${percent}% context` : ""}\nClick to pet · double-click to feed · drag anywhere · right-click for more`} />
    <div className="cx-pet-hit" onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp}
      onDoubleClick={() => { touch(); cancelPlans(); state.current.fed += 1; play("Excited"); float("🍪"); say(state.current.fed > 3 ? "So full. Maybe compact me?" : "Nom. Tokens are tasty", 1600); later(1600, routine); }}
      onContextMenu={(event) => { event.preventDefault(); setMenu({ x: event.clientX, y: event.clientY }); }} />
    {bed === "in" ? <span className="cx-pet-zzz" aria-hidden="true">z</span> : null}
    {bubble ? <span className="cx-pet-bubble" role="status">{bubble}</span> : null}
    {floaters.map((item) => <span key={item.id} className="cx-pet-float" style={{ left: item.dx }} aria-hidden="true">{item.text}</span>)}
  </div>;
  return <span ref={anchor} className="cx-pet-anchor" aria-hidden="true">
    {typeof document !== "undefined" && ready ? createPortal(<>
      {bed !== "none" && composer() ? <div className={`cx-pet-bedspot bed-${bed}`}
        style={{ left: composer()!.left + bedAt - 16 * SCALE, top: composer()!.top - 9 * SCALE }}><Bed /></div> : null}
      {layer}
      {menu ? <div className="cx-pet-menu" role="menu" style={{ left: menu.x, top: menu.y }} onMouseLeave={() => setMenu(null)}>
        {[["nap", "Nap now"], ["dance", "Dance"], ["wave", "Wave"], ["think", "Have an idea"], ["ride", "Ride the pointer"], ["hide", "Hide pet"]]
          .map(([id, label]) => <button key={id} type="button" role="menuitem" onClick={() => run(id!)}>{label}</button>)}
      </div> : null}
    </>, document.body) : null}
  </span>;
}
