type Box = Pick<DOMRect, "left" | "right" | "top" | "bottom">;

/** Fixed layers use viewport coordinates, restricted to their chat rather than the whole window. */
export function annotationBounds(anchor: HTMLElement): Box {
  const rect = (anchor.closest(".cx-pane") ?? anchor.closest(".ao-workflow") ?? anchor).getBoundingClientRect();
  return { left: Math.max(0, rect.left), right: Math.min(window.innerWidth, rect.right),
    top: Math.max(0, rect.top), bottom: Math.min(window.innerHeight, rect.bottom) };
}

export function annotationPosition(anchor: Box, bounds: Box, desiredWidth: number, desiredHeight: number, below = false) {
  const leftEdge = bounds.left + 8, rightEdge = bounds.right - 8;
  const topEdge = bounds.top + 8, bottomEdge = bounds.bottom - 8;
  const width = Math.max(0, Math.min(desiredWidth, rightEdge - leftEdge));
  const above = Math.max(0, anchor.top - 6 - topEdge), under = Math.max(0, bottomEdge - anchor.bottom - 6);
  const useBelow = below ? under >= desiredHeight || under >= above : above < desiredHeight && under > above;
  const maxHeight = Math.max(0, Math.min(desiredHeight, Math.max(above, under) ? (useBelow ? under : above) : bottomEdge - topEdge));
  return { left: Math.max(leftEdge, Math.min(anchor.left, rightEdge - width)),
    top: Math.max(topEdge, Math.min(useBelow ? anchor.bottom + 6 : anchor.top - 6 - maxHeight, bottomEdge - maxHeight)),
    width, maxHeight };
}
