/**
 * Clawd's motion as pure functions of time, so one frame clock in ChatPet drives all of it: a walk
 * that speeds up and slows down, feet and a bob that follow the distance walked, a leap that crouches,
 * flies a parabola and squashes on landing, a fall under gravity, a spring that follows the pointer,
 * and the stretches of the chat box's top edge where it may stand without covering anything.
 *
 * Before (the user, 2026-11-10: "all clawd animation are broken and dumb when moving"): it slid at
 * a constant speed with its feet on a timer of their own, turned on the spot, walked sideways down the
 * box's sides and upside down under it, and its leaps and drops were CSS transitions on `left`/`top`
 * racing timers, so a busy window landed it before it arrived or left it squashed in the air.
 */

export type Point = { x: number; y: number };
export type Span = { left: number; right: number };

const clamp = (value: number, low: number, high: number) => Math.max(low, Math.min(high, value));
const finite = (...values: number[]) => values.every(Number.isFinite);

/** How long it takes to get up to walking speed, and to stop again (s). */
const RAMP_S = 0.22;

/** A walk along the top edge: from, to (px), how long it takes (ms), and its speeds. */
export type WalkPlan = { from: number; to: number; ms: number; accel: number; cruise: number };

/**
 * A walk from `from` to `to` at up to `cruise` px/s: it speeds up over RAMP_S, strolls, and slows
 * down onto the spot. A short walk never gets up to speed: it speeds up half the way and slows down
 * the rest.
 */
export function walkPlan(from: number, to: number, cruise: number): WalkPlan {
  const distance = Math.abs(to - from);
  if (!finite(from, to, cruise) || cruise <= 0 || distance < 0.5) return { from, to: finite(to) ? to : from, ms: 0, accel: 0, cruise: 0 };
  const accel = cruise / RAMP_S;
  const ramp = (cruise * RAMP_S) / 2;
  if (distance <= 2 * ramp) {
    const half = Math.sqrt(distance / accel);
    return { from, to, ms: Math.round(2 * half * 1000), accel, cruise: accel * half };
  }
  return { from, to, ms: Math.round((2 * RAMP_S + (distance - 2 * ramp) / cruise) * 1000), accel, cruise };
}

/** Where a walk is `ms` into it, and how fast it is going there (px/s). */
export function walkAt(plan: WalkPlan, ms: number): { x: number; speed: number; done: boolean } {
  if (plan.ms <= 0 || !(ms < plan.ms)) return { x: plan.to, speed: 0, done: true };
  const distance = Math.abs(plan.to - plan.from);
  const t = Math.max(0, ms) / 1000;
  const total = plan.ms / 1000;
  const ramp = plan.cruise / plan.accel;
  let covered: number;
  let speed: number;
  if (t < ramp) {
    covered = 0.5 * plan.accel * t * t;
    speed = plan.accel * t;
  } else if (t > total - ramp) {
    const left = total - t;
    covered = distance - 0.5 * plan.accel * left * left;
    speed = plan.accel * left;
  } else {
    covered = 0.5 * plan.cruise * ramp + plan.cruise * (t - ramp);
    speed = plan.cruise;
  }
  return { x: plan.from + Math.sign(plan.to - plan.from) * clamp(covered, 0, distance), speed: Math.max(0, speed), done: false };
}

/** One stride (px): its feet swap each stride, and it rises and comes down once in each. */
export const STRIDE = 11;

/**
 * Its feet and bob `walked` px into a walk: which foot is down, and how far up it is in this stride
 * (0 on the ground, 1 at the top). Tied to the distance, not a timer, so its feet never slide.
 */
export function gaitAt(walked: number): { left: boolean; lift: number } {
  const phase = Math.abs(finite(walked) ? walked : 0) / STRIDE;
  const stride = Math.floor(phase);
  return { left: stride % 2 === 0, lift: Math.sin((phase - stride) * Math.PI) };
}

/** A leap: its two ends, how long it flies (ms) and how high it arcs over the line between them (px). */
export type LeapPlan = { from: Point; to: Point; ms: number; arc: number };

/**
 * A leap from `from` to `to` (feet, px, y down). It always clears the higher end by a margin, so it
 * comes down onto a box rather than sliding up to it, and a longer leap arcs higher and flies longer.
 */
export function leapPlan(from: Point, to: Point): LeapPlan {
  const distance = Math.hypot(to.x - from.x, to.y - from.y);
  if (!finite(distance)) return { from, to: from, ms: 0, arc: 0 };
  const arc = Math.round(Math.max(Math.abs(to.y - from.y) / 2 + 22, Math.min(150, 30 + distance * 0.16)));
  const ms = Math.round(clamp(300 + distance * 0.42 + arc * 0.9, 380, 920));
  return { from, to, ms, arc };
}

/** Where a leap is `ms` into it: across at a steady pace, as a thrown thing goes, and up and down a parabola. */
export function leapAt(plan: LeapPlan, ms: number): Point & { t: number; done: boolean } {
  const t = plan.ms > 0 ? clamp(ms / plan.ms, 0, 1) : 1;
  return {
    x: plan.from.x + (plan.to.x - plan.from.x) * t,
    y: plan.from.y + (plan.to.y - plan.from.y) * t - 4 * plan.arc * t * (1 - t),
    t,
    done: t >= 1,
  };
}

/** Pixels per second squared it falls at when let go. */
export const GRAVITY = 2600;

/** A fall from where it was let go onto `to` (feet, px): how long it takes (ms) and how fast it lands (px/s). */
export type FallPlan = { from: Point; to: Point; ms: number; speed: number };

export function fallPlan(from: Point, to: Point): FallPlan {
  const height = to.y - from.y;
  if (!finite(height, to.x, from.x)) return { from, to: from, ms: 0, speed: 0 };
  const seconds = Math.max(0.16, Math.sqrt((2 * Math.max(0, height)) / GRAVITY));
  return { from, to, ms: Math.round(seconds * 1000), speed: GRAVITY * seconds };
}

/** Where a fall is `ms` into it: dropping faster and faster, drifting across to the spot under it. */
export function fallAt(plan: FallPlan, ms: number): Point & { done: boolean } {
  const t = plan.ms > 0 ? clamp(ms / plan.ms, 0, 1) : 1;
  const drift = 1 - (1 - t) * (1 - t);
  return { x: plan.from.x + (plan.to.x - plan.from.x) * drift, y: plan.from.y + (plan.to.y - plan.from.y) * t * t, done: t >= 1 };
}

/** How hard a landing at `speed` px/s is (0-1): a hop is gentle, a drop from the top of the window flattens it. */
export const impactOf = (speed: number) => clamp(0.2 + (finite(speed) ? speed : 0) / 2200, 0.2, 1);

/** Squash and stretch from the feet: x and y scale. */
export type Shape = { sx: number; sy: number };

/** Crouching to leap, `t` 0-1 of the crouch: lower and wider. */
export function crouchAt(t: number): Shape {
  const e = Math.sin((clamp(t, 0, 1) * Math.PI) / 2);
  return { sx: 1 + 0.12 * e, sy: 1 - 0.2 * e };
}

/** In the air, `t` 0-1 of the leap: stretched tall as it leaves the ground and as it comes down, round at the top. */
export function flightAt(t: number): Shape {
  const s = 0.1 * Math.abs(1 - 2 * clamp(t, 0, 1));
  return { sx: 1 - 0.6 * s, sy: 1 + s };
}

/**
 * Landing, `t` 0-1 of LAND time, `impact` 0-1: flattened by the impact, springing up a little taller,
 * and settling, a damped spring that ends exactly at rest so nothing is left squashed.
 */
export function landAt(t: number, impact: number): Shape {
  const u = clamp(t, 0, 1);
  if (u >= 1) return { sx: 1, sy: 1 };
  const k = clamp(impact, 0, 1) * Math.exp(-4 * u) * Math.cos(u * Math.PI * 2.5);
  return { sx: 1 + 0.26 * k, sy: 1 - 0.32 * k };
}

/** `current` sprung toward `target` over `ms`: halfway there every `halfLife` ms, never past it. */
export function follow(current: number, target: number, ms: number, halfLife = 60): number {
  if (!finite(current)) return target;
  return target + (current - target) * Math.pow(0.5, Math.max(0, ms) / halfLife);
}

/**
 * Where along an edge `length` px long a footprint `width` px wide may stand (the spans its middle
 * may be in) without covering any of `blocked` (px along the same edge).
 */
export function clearSpans(length: number, blocked: readonly Span[], width: number): Span[] {
  if (!finite(length, width) || length < width) return [];
  const merged: Span[] = [];
  for (const span of [...blocked].filter((item) => finite(item.left, item.right) && item.right > 0 && item.left < length)
    .sort((a, b) => a.left - b.left)) {
    const last = merged.at(-1);
    if (last && span.left <= last.right) last.right = Math.max(last.right, Math.min(length, span.right));
    else merged.push({ left: Math.max(0, span.left), right: Math.min(length, span.right) });
  }
  const spans: Span[] = [];
  let start = 0;
  for (const span of [...merged, { left: length, right: length }]) {
    if (span.left - start >= width) spans.push({ left: start + width / 2, right: span.left - width / 2 });
    start = Math.max(start, span.right);
  }
  return spans;
}

/**
 * When nowhere is clear (the chat scrolled up, its text right down to the box all the way across):
 * where along the edge a footprint `width` px wide covers least of `blocked`, nearest `x` among equally
 * good spots. Null only when the edge is too short for it.
 */
export function leastCovered(length: number, blocked: readonly Span[], width: number, x: number): number | null {
  if (!finite(length, width, x) || length < width) return null;
  let best = width / 2;
  let least = Number.POSITIVE_INFINITY;
  // Every 4 px along, and the far end itself (by the send button).
  const spots: number[] = [];
  for (let middle = width / 2; middle < length - width / 2; middle += 4) spots.push(middle);
  spots.push(length - width / 2);
  for (const middle of spots) {
    const left = middle - width / 2, right = middle + width / 2;
    let covered = 0;
    for (const span of blocked) covered += Math.max(0, Math.min(right, span.right) - Math.max(left, span.left));
    if (covered < least - 0.5 || (covered <= least + 0.5 && Math.abs(middle - x) < Math.abs(best - x))) { best = middle; least = Math.min(least, covered); }
  }
  return best;
}

/** The spot in `spans` nearest `x`, or null when there is none. */
export function nearestClear(spans: readonly Span[], x: number): number | null {
  let best: number | null = null;
  for (const span of spans) {
    const spot = clamp(x, span.left, span.right);
    if (best === null || Math.abs(spot - x) < Math.abs(best - x)) best = spot;
  }
  return best;
}

/**
 * A spot to stroll to from `x`: mostly a short way along (60-260 px) in a clear span, now and then
 * (`far` of the time) anywhere clear. Null when nowhere is clear.
 */
export function pickClear(spans: readonly Span[], x: number, random: () => number = Math.random, far = 0.25): number | null {
  if (!spans.length) return null;
  if (random() >= far) {
    const reach = 60 + random() * 200;
    const way = random() < 0.5 ? -1 : 1;
    for (const target of [x + way * reach, x - way * reach]) {
      const spot = nearestClear(spans, target);
      if (spot !== null && Math.abs(spot - x) >= 24) return spot;
    }
  }
  const total = spans.reduce((sum, span) => sum + (span.right - span.left) + 1, 0);
  let roll = random() * total;
  for (const span of spans) {
    const size = span.right - span.left + 1;
    if (roll < size) return span.left + Math.min(size - 1, roll);
    roll -= size;
  }
  return spans.at(-1)!.right;
}

/** The CLI's turn frames Clawd walks in: its body turned a little toward where it goes. */
export const WALK_FACING = { left: "left-30", right: "right-30" } as const;

/**
 * Turning round to face `way` (-1 left, 1 right) through the CLI's turn frames: its body comes round
 * past the front, rather than its eyes flicking across while its body stays put.
 */
export function turnFacings(way: -1 | 1): ("left-30" | "left-12" | "right-12" | "right-30")[] {
  return way < 0 ? ["right-30", "right-12", "left-12", "left-30"] : ["left-30", "left-12", "right-12", "right-30"];
}

/** Place work props on the inside of the chat box instead of clipping them at its edge. */
export function petToolSide(x: number, width: number): "left" | "right" {
  return Number.isFinite(x) && Number.isFinite(width) && x < width / 2 ? "right" : "left";
}
