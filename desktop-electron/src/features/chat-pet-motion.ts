/** Advance toward the current destination, including when a resized composer moves it behind us. */
export function advancePetWalk(position: number, target: number, distance: number) {
  if (!Number.isFinite(position) || !Number.isFinite(target) || !Number.isFinite(distance)) {
    return { position, direction: 0, arrived: true } as const;
  }
  const delta = target - position;
  const direction = Math.sign(delta);
  const traveled = Math.min(Math.abs(delta), Math.max(0, distance));
  return {
    position: position + direction * traveled,
    direction,
    arrived: traveled >= Math.abs(delta),
  };
}

/** Place work props on the inside of the chat box instead of clipping them at its edge. */
export function petToolSide(x: number, width: number): "left" | "right" {
  return Number.isFinite(x) && Number.isFinite(width) && x < width / 2 ? "right" : "left";
}

/**
 * A leap across the screen, feet from `from` to `to` (px): how long it takes (ms) and how high it
 * arcs over the straight line between them (px). The arc is its own, so it clears both ends: before,
 * the only rise was a curve's overshoot on the drop between the two heights, and between two chat
 * boxes at one height (split panes, the house under the chat list) the leap was a flat 900 ms slide
 * that read as a teleport (the user, 2026-11-09).
 */
export function petLeap(from: { x: number; y: number }, to: { x: number; y: number }) {
  const distance = Math.hypot(to.x - from.x, to.y - from.y);
  if (!Number.isFinite(distance)) return { ms: 0, arc: 0 };
  const ms = Math.round(Math.min(950, Math.max(420, 300 + distance * 0.5)));
  const arc = Math.round(Math.max(Math.abs(to.y - from.y) / 2 + 28, Math.min(160, 36 + distance * 0.15)));
  return { ms, arc };
}

/**
 * Where Clawd stands on the porch of its house under the chat list (its feet, px from the house's
 * left): out in front of the house's right side, as far into the yard beside it as it fits whole,
 * so it walks out of the house to there (growing to full size) before it leaps across to a chat box.
 */
export function petPorchX(yardWidth: number, houseWidth: number, petWidth: number, entryX: number) {
  const margin = Number.isFinite(yardWidth) ? Math.max(0, (yardWidth - houseWidth) / 2) : 0;
  return Math.max(entryX, houseWidth + Math.min(margin, petWidth) - petWidth / 2 - 2);
}
