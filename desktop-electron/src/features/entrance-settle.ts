// Turns and timeline rows fade and rise in as they arrive (claude-rise and claude-fade in
// claude-theme.css). A hidden window draws no frames, so nothing that arrives while you are in another
// app gets to start its entrance: each one waits on its first keyframe (opacity 0, `backwards`). On
// 2026-11-03 a window covered for a while held 2,492 of them across 154k elements; the first frame
// back started them all together, one composited layer each, and the window stayed black (the
// #181818 window background) while the renderer worked through them. They are finished the moment
// the window shows again, so what arrived meanwhile is simply there.
const ENTRANCES = new Set(["claude-rise", "claude-fade"]);

export function installEntranceSettle(doc: Document = document): () => void {
  const settle = () => {
    // A minimized window still reads visible; the preload marks it away (see page-visibility.ts).
    if (doc.hidden || doc.documentElement?.hasAttribute("data-window-away")) return;
    // One walk of the document per return to the window. It brings styles up to date, which the
    // first frame back needs anyway; the shimmer ticker must not do this on every step.
    for (const animation of doc.getAnimations()) {
      if (ENTRANCES.has((animation as CSSAnimation).animationName) && animation.playState === "running") animation.finish();
    }
  };
  doc.addEventListener("visibilitychange", settle);
  return () => doc.removeEventListener("visibilitychange", settle);
}
