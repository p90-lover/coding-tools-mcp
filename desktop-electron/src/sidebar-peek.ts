export const SIDEBAR_PEEK_DELAY_MS = 90;
export const SIDEBAR_LEAVE_DELAY_MS = 110;

/** Bind to the clipped, visible panel, not an invisible coordinate strip across the window. */
export function bindSidebarPeek(panel: HTMLElement, onChange: (open: boolean) => void) {
  const doc = panel.ownerDocument;
  const win = doc.defaultView!;
  let open = false;
  let pending: boolean | null = null;
  let timer: number | undefined;
  const cancel = () => { win.clearTimeout(timer); timer = undefined; pending = null; };
  const settle = (want: boolean, delay: number) => {
    if (want === open) { cancel(); return; }
    if (pending === want) return;
    cancel();
    pending = want;
    timer = win.setTimeout(() => {
      timer = undefined;
      pending = null;
      open = want;
      onChange(want);
    }, delay);
  };
  const overPanel = (event: PointerEvent) => {
    const box = panel.getBoundingClientRect();
    return event.clientX >= box.left && event.clientX < box.right
      && event.clientY >= box.top && event.clientY < box.bottom
      && panel.contains(doc.elementFromPoint(event.clientX, event.clientY));
  };
  const enter = (event: PointerEvent) => {
    if (event.pointerType !== "touch" && overPanel(event)) settle(true, SIDEBAR_PEEK_DELAY_MS);
  };
  // Mouse focus from clicking a navigation item is not a reason to keep its panel pinned open.
  const leave = () => settle(false, SIDEBAR_LEAVE_DELAY_MS);
  const move = (event: PointerEvent) => {
    if ((open || pending === true) && event.pointerType !== "touch" && !overPanel(event)) leave();
  };
  const close = () => {
    cancel();
    if (open) { open = false; onChange(false); }
  };
  const key = (event: KeyboardEvent) => { if (event.key === "Escape") close(); };
  const focus = (event: FocusEvent) => {
    const target = event.target as HTMLElement;
    if (target.matches(":focus-visible")) settle(true, 0);
  };
  const blur = (event: FocusEvent) => { if (!panel.contains(event.relatedTarget as Node)) leave(); };
  const visibility = () => { if (doc.hidden) close(); };
  panel.addEventListener("pointerenter", enter);
  panel.addEventListener("pointerleave", leave);
  panel.addEventListener("focusin", focus);
  panel.addEventListener("focusout", blur);
  win.addEventListener("pointermove", move, { passive: true });
  win.addEventListener("blur", close);
  win.addEventListener("resize", close);
  win.addEventListener("keydown", key);
  doc.documentElement.addEventListener("pointerleave", close);
  doc.addEventListener("visibilitychange", visibility);
  return {
    close,
    dispose() {
      cancel();
      panel.removeEventListener("pointerenter", enter);
      panel.removeEventListener("pointerleave", leave);
      panel.removeEventListener("focusin", focus);
      panel.removeEventListener("focusout", blur);
      win.removeEventListener("pointermove", move);
      win.removeEventListener("blur", close);
      win.removeEventListener("resize", close);
      win.removeEventListener("keydown", key);
      doc.documentElement.removeEventListener("pointerleave", close);
      doc.removeEventListener("visibilitychange", visibility);
    },
  };
}
