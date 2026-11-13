// The "Working" shimmers (cx-shimmer, and dsh-shimmer in the deep-dive transcript) animate
// background-position, which only the main thread can paint. Left to run, Chromium services them on every
// refresh even with steps(): 156 main-thread frames a second on a 165 Hz screen, about half a core while the
// window is visible. A paused animation schedules no frames, so this pauses each shimmer and moves it
// forward 30 times a second instead: one frame per step, with the keyframes, theme durations and
// reduced-motion rules still in CSS.
//
// The looping status marks (the pulsing dots of working steps, tools and replies, the chats' spinners, the
// scroll button's dots) are compositor animations, but each one running still has the compositor draw a
// frame on every refresh. With ~90 of them in a busy chat, the GPU process used a core on a 157 Hz screen,
// two thirds of it for these marks (2026-11-13: 99% with them running, 33% paused). They are stepped the same
// way, 10 times a second, on the same clock, so every mark on screen stays in phase and they cost at most
// one frame per step together.
//
// Animations are collected from the element that fires animationstart. Asking the document for its
// animations on every step forced a style recalculation of the whole page each time: 13% of a core in a
// 24k-element chat, even with the window covered and painting about once a second (2026-11-01).
const SHIMMERS = new Set(["cx-shimmer", "dsh-shimmer"]);
const LOOPS = new Set(["cx-pulse", "cx-spin", "cdx-spin", "cx-rplan-spin", "cx-scroll-dot-wave", "cx-receipt-sending", "ao-spin"]);
const SHIMMER_STEP_MS = 1000 / 30;
const LOOP_STEP_MS = 100;

export function installShimmerTicker(doc: Document = document): () => void {
  let timer: ReturnType<typeof setInterval> | null = null;
  let timerMs = 0;
  const shimmers = new Set<Animation>();
  const loops = new Set<Animation>();
  const stop = () => {
    if (timer !== null) clearInterval(timer);
    timer = null;
  };
  // A shimmer needs 30 steps a second; marks alone need 10.
  const schedule = () => {
    const ms = shimmers.size ? SHIMMER_STEP_MS : loops.size ? LOOP_STEP_MS : 0;
    if (ms === timerMs && timer !== null) return;
    stop();
    timerMs = ms;
    if (ms) timer = setInterval(tick, ms);
  };
  const tick = () => {
    // A minimized window still reads visible; the preload marks it away (see page-visibility.ts).
    const away = doc.hidden || doc.documentElement?.hasAttribute("data-window-away");
    const now = away ? null : doc.timeline.currentTime;
    // playState can flush pending style. Read every animation before any pause/currentTime write:
    // interleaving them made each shimmer flush the changes from the previous one (129 ms/tick
    // in a ten-pane, 65k-element chat). Only the first read should need to settle pending style.
    const running: Animation[] = [];
    for (const set of [shimmers, loops]) {
      for (const animation of set) {
        const state = animation.playState;
        // Removing the element or its class cancels the animation; a new one fires animationstart.
        if (state === "idle" || !(animation.effect as KeyframeEffect | null)?.target?.isConnected) {
          set.delete(animation);
          continue;
        }
        if (state === "running") running.push(animation);
      }
    }
    for (const animation of running) animation.pause();
    // One shared clock, so every shimmer and mark on screen stays in phase.
    if (now !== null) for (const set of [shimmers, loops]) for (const animation of set) animation.currentTime = now;
    schedule();
  };
  const onStart = (event: AnimationEvent) => {
    const name = event.animationName;
    if (!SHIMMERS.has(name) && !LOOPS.has(name)) return;
    const target = event.target as Element | null;
    for (const animation of target?.getAnimations?.() ?? []) {
      const started = (animation as CSSAnimation).animationName;
      if (SHIMMERS.has(started)) shimmers.add(animation);
      else if (LOOPS.has(started)) loops.add(animation);
    }
    if (!shimmers.size && !loops.size) return;
    schedule();
    tick();
  };
  doc.addEventListener("animationstart", onStart);
  return () => {
    doc.removeEventListener("animationstart", onStart);
    stop();
    shimmers.clear();
    loops.clear();
  };
}
