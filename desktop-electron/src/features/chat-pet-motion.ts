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
