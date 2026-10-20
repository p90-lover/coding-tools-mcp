import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";

// Bit, the chat's pet: a pixel critter perched on the chat box, as Claude Code's buddy sits by its
// prompt, but it shows what the agent is doing. It types along while the agent works, raises a
// flag when a request waits for you, jumps when a turn finishes and frets when one fails; its belly
// fills with the context. Click to pet it, double-click to feed it, drag it along the box; left
// alone while nothing runs, it naps. Pure view: it reads the chat's state and changes nothing.

import type { PetMood } from "./ao-chat";

// Measured from the chat box's right edge: the left end of its top edge holds the branch chip.
const POSITION_KEY = "coding-tools:ao:pet-right";
const NAP_MS = 12_000;
const CHEER_MS = 6_000;
const SCALE = 3;
const WIDTH = 18 * SCALE;
const HEIGHT = 7 * SCALE;
/** Space kept clear between the pet and the branch chip when it is dragged left. */
const CHIP_GAP = 8;

const LINES: Record<PetMood, string> = {
  idle: "Nothing running. Want to start something?",
  working: "Busy busy. The agent is on it.",
  ask: "Psst, the agent is asking you something.",
  done: "Turn finished. Nice work.",
  error: "Something broke. Retry the step?",
};
const PETTED = ["Hehe", "More pets, please", "I like you", "*purr*"];

// Claude Code's Clawd: its banner glyph " ▐▛███▜▌ / ▝▜█████▛▘ /   ▘▘ ▝▝" read as 2×2 quadrants
// is an 18×5 sprite. The two quadrants missing from the top row are its eyes.
const C = { body: "#D97757", eye: "#1F1E1D", tint: "#B85C3F" };

/** Clawd for a mood, on an 18×7 grid: two rows above its head for a raised arm, a "!" or a "z". */
function Sprite({ mood, asleep, step }: { mood: PetMood; asleep: boolean; step: boolean }) {
  const r = (x: number, y: number, w: number, h: number, color: string, key: string) =>
    <rect key={key} x={x} y={y} width={w} height={h} fill={color} />;
  const top = 2;
  const asking = mood === "ask" && !asleep;
  const parts = [
    r(3, top, 12, 2, C.body, "head"),
    r(3, top + 2, 12, 2, C.body, "body"),
    // The arms stick out of the second body row; asking, the right one goes up to wave.
    r(1, top + 2, 2, 1, C.body, "arm-l"),
    asking ? r(15, top - 1, 1, 3, C.body, "arm-r") : r(15, top + 2, 2, 1, C.body, "arm-r"),
  ];
  // Eyes: open holes (drawn dark to read on a light page), closed when napping or pleased.
  if (asleep || (mood === "done" && !asleep)) parts.push(r(5, top + 1, 1, 1, C.tint, "eye-l"), r(12, top + 1, 1, 1, C.tint, "eye-r"));
  else if (mood === "error") parts.push(r(5, top, 1, 1, C.eye, "eye-l"), r(12, top, 1, 1, C.eye, "eye-r"), r(5, top + 1, 1, 1, C.eye, "eye-l2"), r(12, top + 1, 1, 1, C.eye, "eye-r2"));
  else parts.push(r(5, top + 1, 1, 1, C.eye, "eye-l"), r(12, top + 1, 1, 1, C.eye, "eye-r"));
  // Four legs; working, they alternate like Claude Code's walking Clawd.
  const legs = mood === "working" && !asleep && step ? [3, 7, 10, 14] : [4, 6, 11, 13];
  legs.forEach((x, index) => parts.push(r(x, top + 4, 1, 1, C.body, `leg${index}`)));
  if (asking) parts.push(r(16, 0, 1, 2, C.eye, "bang"), r(16, 3, 1, 1, C.eye, "bang-dot"));
  return <svg viewBox="0 0 18 7" width={WIDTH} height={HEIGHT} aria-hidden="true" shapeRendering="crispEdges">{parts}</svg>;
}

type Floater = { id: number; text: string; offset: number };

export function ChatPet({ mood, context, onHide }: {
  mood: PetMood;
  /** Share of the context window in use (0–1), when the agent reports it. */
  context: number | null;
  onHide: () => void;
}) {
  const box = useRef<HTMLDivElement>(null);
  const [right, setRight] = useState(() => { try { const value = Number(localStorage.getItem(POSITION_KEY)); return Number.isFinite(value) && value >= 0 ? value : 16; } catch { return 16; } });
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
  const seq = useRef(0);
  // The nap timer fires later; it reads the mood then, not the one it was set in.
  const moodNow = useRef(mood);
  moodNow.current = mood;

  const say = (text: string, ms = 1800) => {
    setBubble(text);
    window.clearTimeout(bubbleTimer.current);
    if (ms) bubbleTimer.current = window.setTimeout(() => setBubble(null), ms);
  };
  const play = (name: "hop" | "shake") => { setMotion(""); window.requestAnimationFrame(() => setMotion(name)); };
  const float = (text: string) => {
    const id = ++seq.current;
    setFloaters((current) => [...current, { id, text, offset: 10 + Math.round(Math.random() * 18) }]);
    window.setTimeout(() => setFloaters((current) => current.filter((item) => item.id !== id)), 1100);
  };
  // Nothing running for a while: it naps. Any touch, or the agent starting, wakes it.
  const poke = () => {
    window.clearTimeout(napTimer.current);
    napTimer.current = window.setTimeout(() => {
      if (moodNow.current === "idle" || moodNow.current === "done") { setAsleep(true); setBubble("Zzz"); }
    }, NAP_MS);
  };

  // React to the agent: a finished turn is celebrated for a moment, then it settles back to idle.
  useEffect(() => {
    setAsleep(false);
    poke();
    if (mood === "done") { setCheering(true); play("hop"); float("✓"); const timer = window.setTimeout(() => setCheering(false), CHEER_MS); return () => window.clearTimeout(timer); }
    setCheering(false);
    if (mood === "error") play("shake");
    if (mood === "ask") { play("hop"); say(LINES.ask, 2600); }
    return undefined;
  }, [mood]);
  const full = context !== null && context >= 0.8;
  useEffect(() => { if (full) say("I'm getting full. Compact soon?", 2600); }, [full]);
  // While the agent works, Clawd walks in place.
  const walking = mood === "working" && !asleep;
  useEffect(() => {
    if (!walking) { setStep(false); return undefined; }
    const timer = window.setInterval(() => setStep((current) => !current), 280);
    return () => window.clearInterval(timer);
  }, [walking]);
  useEffect(() => () => { window.clearTimeout(clickTimer.current); window.clearTimeout(bubbleTimer.current); window.clearTimeout(napTimer.current); }, []);

  const shown: PetMood = mood === "done" && !cheering ? "idle" : mood;
  const wake = () => { if (!asleep) return false; setAsleep(false); say("Huh? I'm up.", 1500); play("hop"); poke(); return true; };

  /** The farthest from the right edge it may sit: short of the branch chip on the box's top edge. */
  const maxRight = () => {
    const composer = box.current?.parentElement;
    const width = composer?.clientWidth ?? 600;
    const chip = composer?.parentElement?.querySelector(".cx-branch-chip, .cx-branch-note");
    const chipEnd = chip && composer ? chip.getBoundingClientRect().right - composer.getBoundingClientRect().left + CHIP_GAP : 0;
    return Math.max(0, width - WIDTH - Math.max(8, chipEnd));
  };
  // A saved spot from a wider window, or a chip that grew, never leaves it on the chip.
  useEffect(() => { const max = maxRight(); if (right > max) setRight(max); });

  const onPointerDown = (event: ReactPointerEvent<HTMLButtonElement>) => {
    drag.current = { x: event.clientX, right, max: maxRight(), moved: false };
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
    if (!state?.moved) return;
    try { localStorage.setItem(POSITION_KEY, String(Math.round(right))); } catch { /* the spot still applies now */ }
    wake();
    say("Wheee", 900);
    play("hop");
    poke();
  };

  const percent = context === null ? null : Math.round(context * 100);
  return <div ref={box} className="cx-pet" style={{ right }}>
    {bubble ? <span className="cx-pet-bubble" role="status">{bubble}</span> : null}
    {floaters.map((item) => <span key={item.id} className="cx-pet-float" style={{ left: item.offset }} aria-hidden="true">{item.text}</span>)}
    <button type="button" className={`cx-pet-body is-${shown}${asleep ? " is-asleep" : ""}${motion ? ` is-${motion}` : ""}`}
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
          say(PETTED[Math.floor(Math.random() * PETTED.length)], 1400);
          poke();
        }, 220);
      }}
      onDoubleClick={() => {
        window.clearTimeout(clickTimer.current);
        wake();
        setFed((count) => count + 1);
        float("🍪"); window.setTimeout(() => float("nom"), 250);
        say(fed >= 3 ? "So full. Maybe compact me?" : "Nom. Tokens are tasty", 1600);
        play("hop");
        poke();
      }}
      onContextMenu={(event) => { event.preventDefault(); onHide(); }}>
      <Sprite mood={shown} asleep={asleep} step={step} />
    </button>
  </div>;
}
