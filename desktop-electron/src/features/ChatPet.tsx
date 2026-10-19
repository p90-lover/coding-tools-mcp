import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";

// Bit, the chat's pet: a pixel critter perched on the chat box, as Claude Code's buddy sits by its
// prompt, but it shows what the agent is doing. It types along while the agent works, raises a
// flag when a request waits for you, jumps when a turn finishes and frets when one fails; its belly
// fills with the context. Click to pet it, double-click to feed it, drag it along the box; left
// alone while nothing runs, it naps. Pure view: it reads the chat's state and changes nothing.

import type { PetMood } from "./ao-chat";

const POSITION_KEY = "coding-tools:ao:pet-left";
const NAP_MS = 12_000;
const CHEER_MS = 6_000;
const WIDTH = 48;

const LINES: Record<PetMood, string> = {
  idle: "Nothing running. Want to start something?",
  working: "Busy busy. The agent is on it.",
  ask: "Psst, the agent is asking you something.",
  done: "Turn finished. Nice work.",
  error: "Something broke. Retry the step?",
};
const PETTED = ["Hehe", "More pets, please", "I like you", "*purr*"];

const C = { body: "#D85A30", dark: "#993C1D", eye: "#2C2C2A", shine: "#FFFFFF", belly: "#F0997B", desk: "#FAECE7" };

/** The 16×14 sprite for a mood, its belly filled to the context fraction. */
function Sprite({ mood, asleep, fill }: { mood: PetMood; asleep: boolean; fill: number }) {
  const r = (x: number, y: number, w: number, h: number, color: string, key: string) =>
    <rect key={key} x={x} y={y} width={w} height={h} fill={color} />;
  const parts = [r(4, 2, 8, 1, C.body, "a"), r(3, 3, 10, 1, C.body, "b"), r(2, 4, 12, 5, C.body, "c"), r(3, 9, 10, 1, C.body, "d"),
    r(1, 5, 1, 2, C.body, "e"), r(14, 5, 1, 2, C.body, "f")];
  if (fill >= 0.8) parts.push(r(1, 4, 1, 4, C.body, "g"), r(14, 4, 1, 4, C.body, "h"), r(2, 9, 12, 1, C.body, "i"));
  const belly = Math.round(Math.max(0, Math.min(1, fill)) * 4);
  if (belly) parts.push(r(5, 9 - belly, 6, belly, C.belly, "j"));
  if (asleep) parts.push(r(5, 6, 2, 1, C.eye, "k"), r(9, 6, 2, 1, C.eye, "l"));
  else if (mood === "error") parts.push(r(5, 5, 1, 1, C.eye, "k"), r(6, 6, 1, 1, C.eye, "l"), r(9, 6, 1, 1, C.eye, "m"), r(10, 5, 1, 1, C.eye, "n"), r(6, 8, 4, 1, C.dark, "o"));
  else if (mood === "done") parts.push(r(5, 6, 1, 1, C.eye, "k"), r(6, 5, 1, 1, C.eye, "l"), r(9, 5, 1, 1, C.eye, "m"), r(10, 6, 1, 1, C.eye, "n"),
    r(6, 7, 4, 1, C.dark, "o"), r(5, 6, 1, 1, C.dark, "p"), r(10, 6, 1, 1, C.dark, "q"));
  else {
    parts.push(r(5, 5, 2, 2, C.eye, "k"), r(9, 5, 2, 2, C.eye, "l"), r(mood === "working" ? 6 : 5, 5, 1, 1, C.shine, "m"), r(mood === "working" ? 10 : 9, 5, 1, 1, C.shine, "n"));
    parts.push(mood === "ask" ? r(7, 7, 2, 2, C.dark, "o") : r(7, 8, 2, 1, C.dark, "o"));
    if (mood === "ask") parts.push(r(14, 1, 1, 3, C.dark, "p"), r(14, 0, 1, 1, C.dark, "q"));
  }
  parts.push(r(4, 10, 2, 2, C.dark, "r"), r(10, 10, 2, 2, C.dark, "s"));
  if (mood === "working" && !asleep) parts.push(r(1, 11, 14, 1, C.desk, "t"), ...[2, 5, 8, 11].map((x) => r(x, 11, 1, 1, C.dark, `u${x}`)));
  return <svg viewBox="0 0 16 14" width={WIDTH} height={42} aria-hidden="true" shapeRendering="crispEdges">{parts}</svg>;
}

type Floater = { id: number; text: string; offset: number };

export function ChatPet({ mood, context, onHide }: {
  mood: PetMood;
  /** Share of the context window in use (0–1), when the agent reports it. */
  context: number | null;
  onHide: () => void;
}) {
  const box = useRef<HTMLDivElement>(null);
  const [left, setLeft] = useState(() => { try { const value = Number(localStorage.getItem(POSITION_KEY)); return Number.isFinite(value) && value >= 0 ? value : 16; } catch { return 16; } });
  const [asleep, setAsleep] = useState(false);
  const [cheering, setCheering] = useState(false);
  const [bubble, setBubble] = useState<string | null>(null);
  const [motion, setMotion] = useState("");
  const [floaters, setFloaters] = useState<Floater[]>([]);
  const [fed, setFed] = useState(0);
  const drag = useRef<{ x: number; left: number; moved: boolean } | null>(null);
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
  useEffect(() => () => { window.clearTimeout(clickTimer.current); window.clearTimeout(bubbleTimer.current); window.clearTimeout(napTimer.current); }, []);

  const shown: PetMood = mood === "done" && !cheering ? "idle" : mood;
  const wake = () => { if (!asleep) return false; setAsleep(false); say("Huh? I'm up.", 1500); play("hop"); poke(); return true; };

  const onPointerDown = (event: ReactPointerEvent<HTMLButtonElement>) => {
    drag.current = { x: event.clientX, left, moved: false };
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  const onPointerMove = (event: ReactPointerEvent<HTMLButtonElement>) => {
    const state = drag.current;
    if (!state) return;
    const dx = event.clientX - state.x;
    if (Math.abs(dx) > 4) state.moved = true;
    if (!state.moved) return;
    const room = (box.current?.parentElement?.clientWidth ?? 600) - WIDTH - 8;
    setLeft(Math.max(0, Math.min(room, state.left + dx)));
  };
  const onPointerUp = () => {
    const state = drag.current;
    drag.current = null;
    if (!state?.moved) return;
    try { localStorage.setItem(POSITION_KEY, String(Math.round(left))); } catch { /* the spot still applies now */ }
    wake();
    say("Wheee", 900);
    play("hop");
    poke();
  };

  const percent = context === null ? null : Math.round(context * 100);
  return <div ref={box} className="cx-pet" style={{ left }}>
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
      <Sprite mood={shown} asleep={asleep} fill={context ?? 0} />
    </button>
  </div>;
}
