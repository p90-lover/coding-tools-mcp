// The "Working" shimmers (cx-shimmer, and dsh-shimmer in the deep-dive transcript) animate
// background-position, which only the main thread can paint. Left to run, Chromium services them on every
// refresh even with steps(): 156 main-thread frames a second on a 165 Hz screen, about half a core while the
// window is visible. A paused animation schedules no frames, so this pauses each shimmer and moves it
// forward 30 times a second instead: one frame per step, with the keyframes, theme durations and
// reduced-motion rules still in CSS.
//
// Shimmers are collected from the element that fires animationstart. Asking the document for its
// animations on every step forced a style recalculation of the whole page each time: 13% of a core in a
// 24k-element chat, even with the window covered and painting about once a second (2026-11-01).
const SHIMMERS = new Set(["cx-shimmer", "dsh-shimmer"]);
const STEP_MS = 1000 / 30;

export function installShimmerTicker(doc: Document = document): () => void {
  let timer: ReturnType<typeof setInterval> | null = null;
  const shimmers = new Set<Animation>();
  const stop = () => {
    if (timer !== null) clearInterval(timer);
    timer = null;
  };
  const tick = () => {
    // A minimized window still reads visible; the preload marks it away (see page-visibility.ts).
    if (doc.hidden || doc.documentElement?.hasAttribute("data-window-away")) return;
    const now = doc.timeline.currentTime;
    for (const animation of shimmers) {
      // Removing the element or its class cancels the animation; a new one fires animationstart.
      if (animation.playState === "idle" || !(animation.effect as KeyframeEffect | null)?.target?.isConnected) {
        shimmers.delete(animation);
        continue;
      }
      if (animation.playState === "running") animation.pause();
      // One shared clock, so every shimmer on screen stays in phase.
      if (now !== null) animation.currentTime = now;
    }
    if (!shimmers.size) stop();
  };
  const onStart = (event: AnimationEvent) => {
    if (!SHIMMERS.has(event.animationName)) return;
    const target = event.target as Element | null;
    for (const animation of target?.getAnimations?.() ?? []) {
      if (SHIMMERS.has((animation as CSSAnimation).animationName)) shimmers.add(animation);
    }
    if (!shimmers.size) return;
    if (timer === null) timer = setInterval(tick, STEP_MS);
    tick();
  };
  doc.addEventListener("animationstart", onStart);
  return () => {
    doc.removeEventListener("animationstart", onStart);
    stop();
    shimmers.clear();
  };
}
