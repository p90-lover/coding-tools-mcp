// The "Working" shimmer animates background-position, which only the main thread can paint. Left to run,
// Chromium services it on every refresh even with steps(): 156 main-thread frames a second on a 165 Hz
// screen, about half a core while the window is visible. A paused animation schedules no frames, so this
// pauses each shimmer and moves it forward 30 times a second instead: one frame per step, with the
// keyframes, theme durations and reduced-motion rules still in CSS.
const SHIMMER = "cx-shimmer";
const STEP_MS = 1000 / 30;

export function installShimmerTicker(doc: Document = document): () => void {
  let timer: ReturnType<typeof setInterval> | null = null;
  const stop = () => {
    if (timer !== null) clearInterval(timer);
    timer = null;
  };
  const tick = () => {
    if (doc.hidden) return;
    const now = doc.timeline.currentTime;
    let live = 0;
    for (const animation of doc.getAnimations()) {
      if ((animation as CSSAnimation).animationName !== SHIMMER) continue;
      live += 1;
      if (animation.playState === "running") animation.pause();
      // One shared clock, so every shimmer on screen stays in phase.
      if (now !== null) animation.currentTime = now;
    }
    // A new shimmer fires animationstart and restarts the ticker.
    if (!live) stop();
  };
  const onStart = (event: AnimationEvent) => {
    if (event.animationName !== SHIMMER || timer !== null) return;
    timer = setInterval(tick, STEP_MS);
    tick();
  };
  doc.addEventListener("animationstart", onStart);
  return () => {
    doc.removeEventListener("animationstart", onStart);
    stop();
  };
}
