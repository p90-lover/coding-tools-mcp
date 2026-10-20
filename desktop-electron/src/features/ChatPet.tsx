import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";

// Bit, the chat's pet: Claude Code's Clawd perched on the chat box, as Claude Code's buddy sits by
// its prompt, but it shows what the agent is doing. It wanders along the box's top edge (scurrying
// while the agent works), stops to look around, hop, wave or stretch, watches your pointer and perks
// up as you type; it runs over and waves when a request waits for you, dances when a turn finishes
// and frets when one fails. Click to pet it, double-click to feed it, drag it along the box; left
// alone while nothing runs, it naps. Pure view: it reads the chat's state and changes nothing.

import type { PetMood } from "./ao-chat";

// Measured from the chat box's right edge: the left end of its top edge holds the branch chip.
const POSITION_KEY = "coding-tools:ao:pet-right";
const NAP_MS = 45_000;
const CHEER_MS = 6_000;
const SCALE = 3;
const WIDTH = 18 * SCALE;
const HEIGHT = 7 * SCALE;
/** Space kept clear between the pet and the branch chip when it is dragged left. */
const CHIP_GAP = 8;
/** Walking speed in px/s: a stroll while nothing runs, a scurry while the agent works. */
const STROLL = 42;
const SCURRY = 110;
/** How near (px) the pointer must come before Bit turns its eyes to it. */
const NOTICE = 180;

const LINES: Record<PetMood, string> = {
  idle: "Nothing running. Want to start something?",
  working: "Busy busy. The agent is on it.",
  ask: "Psst, the agent is asking you something.",
  done: "Turn finished. Nice work.",
  error: "Something broke. Retry the step?",
};
const PETTED = ["Hehe", "More pets, please", "I like you", "*purr*"];
const MUSINGS = ["Hmm…", "*looks around*", "What are we building?", "♪", "Nice code"];

// Claude Code's Clawd: its banner glyph " ▐▛███▜▌ / ▝▜█████▛▘ /   ▘▘ ▝▝" read as 2×2 quadrants
// is an 18×5 sprite. The two quadrants missing from the top row are its eyes.
const C = { body: "#D97757", eye: "#1F1E1D", tint: "#B85C3F" };

type Arms = "down" | "right" | "both";
type Pose = { look: -1 | 0 | 1; arms: Arms; walking: boolean; sit: boolean };

/** Clawd on an 18×7 grid: two rows above its head for raised arms and a "!". */
function Sprite({ mood, asleep, step, pose }: { mood: PetMood; asleep: boolean; step: boolean; pose: Pose }) {
  const r = (x: number, y: number, w: number, h: number, color: string, key: string) =>
    <rect key={key} x={x} y={y} width={w} height={h} fill={color} />;
  // Sitting, the body drops a row onto its tucked legs.
  const top = pose.sit ? 3 : 2;
  const asking = mood === "ask" && !asleep;
  const arms: Arms = asleep ? "down" : asking ? "right" : pose.arms;
  const parts = [
    r(3, top, 12, 2, C.body, "head"),
    r(3, top + 2, 12, 2, C.body, "body"),
    // The arms stick out of the second body row; raised, they go up beside the head.
    arms === "both" ? r(2, top - 1, 1, 3, C.body, "arm-l") : r(1, top + 2, 2, 1, C.body, "arm-l"),
    arms === "down" ? r(15, top + 2, 2, 1, C.body, "arm-r") : r(15, top - 1, 1, 3, C.body, "arm-r"),
  ];
  // Eyes: holes in the head (drawn dark to read on a light page), turned where it looks; closed
  // when napping or pleased; wide and worried after an error.
  const look = asleep ? 0 : pose.look;
  if (asleep || mood === "done") parts.push(r(5, top + 1, 1, 1, C.tint, "eye-l"), r(12, top + 1, 1, 1, C.tint, "eye-r"));
  else if (mood === "error") parts.push(r(5, top, 1, 2, C.eye, "eye-l"), r(12, top, 1, 2, C.eye, "eye-r"));
  else parts.push(r(5 + look, top + 1, 1, 1, C.eye, "eye-l"), r(12 + look, top + 1, 1, 1, C.eye, "eye-r"));
  // Four legs, cycling while it walks; none showing while it sits.
  if (!pose.sit) {
    const legs = (pose.walking || (mood === "working" && !asleep)) && step ? [3, 7, 10, 14] : [4, 6, 11, 13];
    legs.forEach((x, index) => parts.push(r(x, top + 4, 1, 1, C.body, `leg${index}`)));
  }
  if (asking) parts.push(r(16, 0, 1, 2, C.eye, "bang"), r(16, 3, 1, 1, C.eye, "bang-dot"));
  return <svg viewBox="0 0 18 7" width={WIDTH} height={HEIGHT} aria-hidden="true" shapeRendering="crispEdges">{parts}</svg>;
}

type Floater = { id: number; text: string; offset: number };
const REST: Pose = { look: 0, arms: "down", walking: false, sit: false };
const pick = <T,>(items: readonly T[]) => items[Math.floor(Math.random() * items.length)]!;

export function ChatPet({ mood, context, onHide }: {
  mood: PetMood;
  /** Share of the context window in use (0–1), when the agent reports it. */
  context: number | null;
  onHide: () => void;
}) {
  const box = useRef<HTMLDivElement>(null);
  const [right, setRight] = useState(() => { try { const value = Number(localStorage.getItem(POSITION_KEY)); return Number.isFinite(value) && value >= 0 ? value : 16; } catch { return 16; } });
  const [travelMs, setTravelMs] = useState(0);
  const [pose, setPose] = useState<Pose>(REST);
  const [step, setStep] = useState(false);
  const [asleep, setAsleep] = useState(false);
  const [cheering, setCheering] = useState(false);
  const [bubble, setBubble] = useState<string | null>(null);
  const [motion, setMotion] = useState("");
  const [floaters, setFloaters] = useState<Floater[]>([]);
  const [fed, setFed] = useState(0);
  const drag = useRef<{ x: number; right: number; max: number; moved: boolean } | null>(null);
  const clickTimer = useRef<number | undefined>(undefined);
  const bubbleTimer = useRef<number | undefined>(undefined);
  const napTimer = useRef<number | undefined>(undefined);
  // Every scheduled behaviour (the next stroll, an arrival, an action's frames), cleared together.
  const plans = useRef<number[]>([]);
  const seq = useRef(0);
  const rightNow = useRef(right);
  rightNow.current = right;
  // Timers fire later; they read the mood and sleep then, not the ones they were set in.
  const moodNow = useRef(mood);
  moodNow.current = mood;
  const asleepNow = useRef(asleep);
  asleepNow.current = asleep;
  const [still] = useState(() => { try { return window.matchMedia("(prefers-reduced-motion: reduce)").matches; } catch { return false; } });

  const later = (ms: number, run: () => void) => { plans.current.push(window.setTimeout(run, ms)); };
  const cancelPlans = () => { plans.current.forEach((timer) => window.clearTimeout(timer)); plans.current = []; };
  const say = (text: string, ms = 1800) => {
    setBubble(text);
    window.clearTimeout(bubbleTimer.current);
    if (ms) bubbleTimer.current = window.setTimeout(() => setBubble(null), ms);
  };
  const play = (name: "hop" | "shake" | "spin" | "bounce") => { setMotion(""); window.requestAnimationFrame(() => setMotion(name)); };
  const float = (text: string) => {
    const id = ++seq.current;
    setFloaters((current) => [...current, { id, text, offset: 10 + Math.round(Math.random() * 24) }]);
    window.setTimeout(() => setFloaters((current) => current.filter((item) => item.id !== id)), 1100);
  };
  // Nothing running for a while: it naps. Any touch, or the agent starting, wakes it.
  const poke = () => {
    window.clearTimeout(napTimer.current);
    napTimer.current = window.setTimeout(() => {
      if (moodNow.current === "idle" || moodNow.current === "done") { cancelPlans(); setPose(REST); setAsleep(true); setBubble("Zzz"); }
    }, NAP_MS);
  };

  /** The farthest from the right edge it may sit: short of the branch chip on the box's top edge. */
  const maxRight = () => {
    const composer = box.current?.parentElement;
    const width = composer?.clientWidth ?? 600;
    const chip = composer?.parentElement?.querySelector(".cx-branch-chip, .cx-branch-note");
    const chipEnd = chip && composer ? chip.getBoundingClientRect().right - composer.getBoundingClientRect().left + CHIP_GAP : 0;
    return Math.max(0, width - WIDTH - Math.max(8, chipEnd));
  };
  // A saved spot from a wider window, or a chip that grew, never leaves it on the chip.
  useEffect(() => { const max = maxRight(); if (right > max) { setTravelMs(0); setRight(max); } });

  /** Walks to `target` (a right offset), facing its way, legs cycling; then runs `arrive`. */
  const walkTo = (target: number, speed: number, arrive?: () => void) => {
    const to = Math.max(0, Math.min(maxRight(), target));
    const distance = Math.abs(to - rightNow.current);
    if (distance < 4) { arrive?.(); return; }
    const ms = Math.round((distance / speed) * 1000);
    // A larger right offset moves it left on screen.
    setPose({ ...REST, walking: true, look: to > rightNow.current ? -1 : 1 });
    setTravelMs(ms);
    setRight(to);
    later(ms, () => { setTravelMs(0); setPose(REST); arrive?.(); });
  };

  /** One thing to do on arriving somewhere, so a stroll never looks like sliding. */
  const act = () => {
    if (asleepNow.current || drag.current) return;
    const choice = pick(["look", "look", "hop", "wave", "stretch", "spin", "sit", "muse", "rest"] as const);
    if (choice === "look") {
      setPose({ ...REST, look: -1 });
      later(500, () => setPose({ ...REST, look: 1 }));
      later(1000, () => setPose({ ...REST, look: 0 }));
    } else if (choice === "hop") play("hop");
    else if (choice === "wave") {
      [0, 260, 520, 780].forEach((at, index) => later(at, () => setPose({ ...REST, arms: index % 2 ? "down" : "right", look: 1 })));
      later(1040, () => setPose(REST));
    } else if (choice === "stretch") { setPose({ ...REST, arms: "both" }); later(900, () => setPose(REST)); }
    else if (choice === "spin") play("spin");
    else if (choice === "sit") { setPose({ ...REST, sit: true }); later(2600, () => setPose(REST)); }
    else if (choice === "muse" && moodNow.current === "idle") say(pick(MUSINGS), 1500);
  };

  /** The wander loop: a pause, a walk somewhere, an action, again. Working, it scurries more often. */
  const wander = () => {
    if (still) return;
    const working = moodNow.current === "working";
    const pause = working ? 1000 + Math.random() * 1500 : 2000 + Math.random() * 3000;
    later(pause, () => {
      if (asleepNow.current || drag.current || moodNow.current === "ask" || moodNow.current === "error") { wander(); return; }
      const max = maxRight();
      // Short trips along the edge mostly, now and then a long one across; working, longer ones.
      const span = Math.random() < (working ? 0.45 : 0.25) ? max : Math.min(max, working ? 240 : 160);
      const target = Math.max(0, Math.min(max, rightNow.current + (Math.random() * 2 - 1) * span));
      walkTo(target, working ? SCURRY : STROLL, () => { act(); wander(); });
    });
  };

  // React to the agent: each mood gets its own little scene, then the wander loop resumes.
  useEffect(() => {
    cancelPlans();
    setAsleep(false);
    setTravelMs(0);
    setPose(REST);
    poke();
    if (mood === "done") {
      setCheering(true);
      float("✓");
      if (!still) [0, 380, 760].forEach((at, index) => later(at, () => { play("hop"); setPose({ ...REST, look: index % 2 ? -1 : 1, arms: "both" }); }));
      later(1200, () => setPose(REST));
      const timer = window.setTimeout(() => setCheering(false), CHEER_MS);
      wander();
      return () => { window.clearTimeout(timer); cancelPlans(); };
    }
    setCheering(false);
    if (mood === "error") { play("shake"); say("Uh oh", 1600); }
    if (mood === "ask") {
      // It runs to the right end, by the send button, and waves for attention.
      say(LINES.ask, 2600);
      if (!still) walkTo(0, SCURRY, () => play("hop"));
    }
    wander();
    return cancelPlans;
  }, [mood]);
  const full = context !== null && context >= 0.8;
  useEffect(() => { if (full) say("I'm getting full. Compact soon?", 2600); }, [full]);

  // Legs cycle while it walks or the agent works.
  const walking = !asleep && (pose.walking || mood === "working");
  useEffect(() => {
    if (!walking) { setStep(false); return undefined; }
    const timer = window.setInterval(() => setStep((current) => !current), pose.walking ? 140 : 280);
    return () => window.clearInterval(timer);
  }, [walking, pose.walking]);

  // It watches the pointer when it comes near, and perks up while you type in the box.
  useEffect(() => {
    if (still) return undefined;
    let frame = 0;
    const onMove = (event: PointerEvent) => {
      if (frame) return;
      frame = window.requestAnimationFrame(() => {
        frame = 0;
        const body = box.current?.getBoundingClientRect();
        if (!body || asleepNow.current || drag.current) return;
        const dx = event.clientX - (body.left + body.width / 2);
        const dy = event.clientY - (body.top + body.height / 2);
        setPose((current) => {
          if (current.walking || current.sit) return current;
          const look: Pose["look"] = Math.hypot(dx, dy) > NOTICE ? 0 : dx < -12 ? -1 : dx > 12 ? 1 : 0;
          return current.look === look ? current : { ...current, look };
        });
      });
    };
    let lastTyped = 0;
    const form = box.current?.parentElement;
    const onInput = () => {
      const now = Date.now();
      if (now - lastTyped < 1500 || asleepNow.current) return;
      lastTyped = now;
      play("bounce");
      poke();
    };
    window.addEventListener("pointermove", onMove);
    form?.addEventListener("input", onInput);
    return () => { window.removeEventListener("pointermove", onMove); form?.removeEventListener("input", onInput); if (frame) window.cancelAnimationFrame(frame); };
  }, [still]);

  useEffect(() => () => { window.clearTimeout(clickTimer.current); window.clearTimeout(bubbleTimer.current); window.clearTimeout(napTimer.current); cancelPlans(); }, []);

  const shown: PetMood = mood === "done" && !cheering ? "idle" : mood;
  const wake = () => {
    if (!asleep) return false;
    setAsleep(false); say("Huh? I'm up.", 1500); play("hop"); poke(); wander();
    return true;
  };

  const onPointerDown = (event: ReactPointerEvent<HTMLButtonElement>) => {
    // Picked up mid-stroll: it stops where it is and goes where it is carried.
    cancelPlans();
    const at = box.current?.parentElement && box.current
      ? box.current.parentElement.getBoundingClientRect().right - box.current.getBoundingClientRect().right : right;
    setTravelMs(0);
    setRight(at);
    setPose(REST);
    drag.current = { x: event.clientX, right: at, max: maxRight(), moved: false };
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  const onPointerMove = (event: ReactPointerEvent<HTMLButtonElement>) => {
    const state = drag.current;
    if (!state) return;
    const dx = event.clientX - state.x;
    if (Math.abs(dx) > 4) state.moved = true;
    if (!state.moved) return;
    setRight(Math.max(0, Math.min(state.max, state.right - dx)));
  };
  const onPointerUp = () => {
    const state = drag.current;
    drag.current = null;
    if (!state?.moved) { wander(); return; }
    try { localStorage.setItem(POSITION_KEY, String(Math.round(right))); } catch { /* the spot still applies now */ }
    wake();
    say("Wheee", 900);
    play("hop");
    poke();
    wander();
  };

  const percent = context === null ? null : Math.round(context * 100);
  return <div ref={box} className="cx-pet" style={{ right, transition: travelMs ? `right ${travelMs}ms linear` : "none" }}>
    {bubble ? <span className="cx-pet-bubble" role="status">{bubble}</span> : null}
    {floaters.map((item) => <span key={item.id} className="cx-pet-float" style={{ left: item.offset }} aria-hidden="true">{item.text}</span>)}
    <button type="button" className={`cx-pet-body is-${shown}${asleep ? " is-asleep" : ""}${pose.walking ? " is-walking" : ""}${motion ? ` is-${motion}` : ""}`}
      aria-label={`Bit the pet: ${asleep ? "napping" : LINES[shown]}${percent !== null ? ` Context ${percent}%.` : ""}`}
      title={asleep ? "Napping. Click to wake" : `${LINES[shown]}${percent !== null ? ` · ${percent}% context` : ""}\nClick to pet · double-click to feed · drag to move`}
      onAnimationEnd={() => setMotion("")}
      onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp}
      onClick={() => {
        if (drag.current?.moved) return;
        window.clearTimeout(clickTimer.current);
        clickTimer.current = window.setTimeout(() => {
          if (wake()) return;
          play("hop"); float("♥"); float("♥");
          setPose({ ...REST, arms: "both" });
          later(700, () => setPose(REST));
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
        play("bounce");
        poke();
      }}
      onContextMenu={(event) => { event.preventDefault(); onHide(); }}>
      <Sprite mood={shown} asleep={asleep} step={step} pose={pose} />
    </button>
  </div>;
}
