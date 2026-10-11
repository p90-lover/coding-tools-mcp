import { ROLE_TITLE } from "./AgentOrchestratorTeam";
import { ChatMenu, type ChatMenuState } from "./ChatMenu";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { MouseEvent as ReactMouseEvent, PointerEvent as ReactPointerEvent, ReactNode } from "react";

export type CanvasNode = {
  id: string; task_id: string; role: string; state: string; parents: string[];
  x: number; y: number; positioned?: boolean; route: { model: string; harness_id?: string };
  settings?: { name?: string };
};
type Point = { x: number; y: number };
const width = 212;
const height = 76;

export type WireBox = { x: number; y: number; w: number; h: number };
const cubicAt = (t: number, a: number, b: number, c: number, d: number) =>
  (1 - t) ** 3 * a + 3 * (1 - t) ** 2 * t * b + 3 * (1 - t) * t * t * c + t ** 3 * d;
const crosses = (box: WireBox, x: number, y: number, pad = 10) =>
  x > box.x - pad && x < box.x + box.w + pad && y > box.y - pad && y < box.y + box.h + pad;

/** Polyline with rounded corners, so a detour reads as one smooth link. */
function rounded(points: [number, number][], radius: number): string {
  let d = `M${points[0][0]},${points[0][1]}`;
  for (let i = 1; i < points.length - 1; i++) {
    const [px, py] = points[i - 1], [cx, cy] = points[i], [nx, ny] = points[i + 1];
    const into = Math.hypot(cx - px, cy - py) || 1, out = Math.hypot(nx - cx, ny - cy) || 1;
    const r = Math.min(radius, into / 2, out / 2);
    d += ` L${cx + (px - cx) / into * r},${cy + (py - cy) / into * r} Q${cx},${cy} ${cx + (nx - cx) / out * r},${cy + (ny - cy) / out * r}`;
  }
  const [lx, ly] = points[points.length - 1];
  return `${d} L${lx},${ly}`;
}

/**
 * A link from the bottom of `from` to the top of `to`. The usual curve is kept when the child is
 * below and nothing is in the way; otherwise the link goes around: out of the parent, along the
 * shorter side clear of every card it would cross, and into the child from above (a reviewer
 * linking back to the orchestrator loops around instead of running through the workers).
 */
export function wirePath(from: WireBox, to: WireBox, others: WireBox[], bend = 0, via?: Point | null): string {
  const x1 = from.x + from.w / 2, y1 = from.y + from.h, x2 = to.x + to.w / 2, y2 = to.y;
  // A link the user pulled to a point passes through it: out of the parent, through the point
  // along the line between the two ends, and into the child from above.
  if (via) {
    const length = Math.hypot(x2 - x1, y2 - y1) || 1, pull = Math.min(140, length / 4);
    const ux = (x2 - x1) / length * pull, uy = (y2 - y1) / length * pull;
    const outReach = Math.max(48, Math.abs(via.y - y1) * .5), inReach = Math.max(48, Math.abs(y2 - via.y) * .5);
    return `M${x1},${y1} C${x1},${y1 + outReach} ${via.x - ux},${via.y - uy} ${via.x},${via.y} S${x2},${y2 - inReach} ${x2},${y2}`;
  }
  const reach = Math.max(60, Math.abs(y2 - y1) * .45);
  const blocked = others.filter(other => Array.from({ length: 19 }, (_, i) => (i + 1) / 20)
    .some(t => crosses(other, cubicAt(t, x1, x1 + bend, x2 + bend, x2), cubicAt(t, y1, y1 + reach, y2 - reach, y2))));
  if (y2 > y1 + 24 && !blocked.length) return `M${x1},${y1} C${x1 + bend},${y1 + reach} ${x2 + bend},${y2 - reach} ${x2},${y2}`;
  const out = y1 + 24, into = y2 - 24, gap = 36;
  const span = [from, to, ...blocked];
  const left = Math.min(...span.map(item => item.x)) - gap, right = Math.max(...span.map(item => item.x + item.w)) + gap;
  const goLeft = Math.abs(x1 - left) + Math.abs(x2 - left) <= Math.abs(right - x1) + Math.abs(right - x2);
  let side = goLeft ? left : right;
  // Step further out while the side lane still runs through a card.
  const top = Math.min(out, into), bottom = Math.max(out, into);
  for (let guard = 0; guard < 24; guard++) {
    const hit = others.find(other => side > other.x - 10 && side < other.x + other.w + 10 && other.y < bottom && other.y + other.h > top);
    if (!hit) break;
    side = goLeft ? hit.x - gap : hit.x + hit.w + gap;
  }
  return rounded([[x1, y1], [x1, out], [side, out], [side, into], [x2, into], [x2, y2]], 14);
}

export type WireLink = { key: string; from: string; to: string; via?: Point | null };
/** Clearance kept around every card, the straight run out of and into a port, and the gap between parallel links. */
const CLEAR = 16, STUB = 18, LANE = 8;
/** Route costs: a turn, running along a link already placed (per pixel, and for joining it at all), crossing one. */
const TURN = 36, SHARE = 6, JOIN = 80, CROSS = 14;

/**
 * Where each link leaves its parent and enters its child: one point per link, spread across the
 * middle half of the card's edge and ordered by where the link's other end is, so links into one
 * card fan in side by side instead of piling onto a single point.
 */
export function linkPorts(boxes: Map<string, WireBox>, links: WireLink[]): Map<string, { out: number; into: number }> {
  const middle = (id: string) => { const box = boxes.get(id)!; return box.x + box.w / 2; };
  const along = (box: WireBox, count: number, index: number) => Math.round(count === 1 ? box.x + box.w / 2 : box.x + box.w * (.25 + .5 * index / (count - 1)));
  const ports = new Map<string, { out: number; into: number }>();
  const groups = (end: "from" | "to") => {
    const grouped = new Map<string, WireLink[]>();
    for (const link of links) if (boxes.has(link.from) && boxes.has(link.to)) grouped.set(link[end], [...grouped.get(link[end]) ?? [], link]);
    return grouped;
  };
  for (const [id, list] of groups("from")) {
    list.sort((a, b) => middle(a.to) - middle(b.to) || a.key.localeCompare(b.key));
    list.forEach((link, index) => ports.set(link.key, { out: along(boxes.get(id)!, list.length, index), into: 0 }));
  }
  for (const [id, list] of groups("to")) {
    list.sort((a, b) => middle(a.from) - middle(b.from) || a.key.localeCompare(b.key));
    list.forEach((link, index) => { ports.get(link.key)!.into = along(boxes.get(id)!, list.length, index); });
  }
  return ports;
}

const inside = (box: WireBox, x: number, y: number) => x > box.x && x < box.x + box.w && y > box.y && y < box.y + box.h;

/**
 * The routing grid for one layout: lines through every card's cleared edges, the channels between
 * them and every link's start and goal, with which steps are open. It also remembers how many links
 * already use each step, so later links pay to share a lane or to cross one and take their own.
 */
function routeGrid(walls: WireBox[], ends: Point[]) {
  const lines = (pick: (box: WireBox) => number[], own: number[]) => {
    const values = [...new Set([...own, ...walls.flatMap(pick)].map(Math.round))].sort((a, b) => a - b);
    const between = values.slice(1).map((value, index) => Math.round((value + values[index]) / 2));
    return [...new Set([...values, ...between, values[0] - 40, values[values.length - 1] + 40])].sort((a, b) => a - b);
  };
  const xs = lines(box => [box.x, box.x + box.w], ends.map(point => point.x));
  const ys = lines(box => [box.y, box.y + box.h], ends.map(point => point.y));
  const nx = xs.length, ny = ys.length, count = nx * ny;
  const open = new Uint8Array(count), right = new Uint8Array(count), down = new Uint8Array(count);
  for (let yi = 0; yi < ny; yi++) for (let xi = 0; xi < nx; xi++) {
    const node = yi * nx + xi, x = xs[xi], y = ys[yi];
    open[node] = walls.some(box => inside(box, x, y)) ? 0 : 1;
    // A step is open when it runs through no card's cleared area (its edges may be followed).
    if (xi + 1 < nx) right[node] = walls.some(box => y > box.y && y < box.y + box.h && box.x < xs[xi + 1] && box.x + box.w > x) ? 0 : 1;
    if (yi + 1 < ny) down[node] = walls.some(box => x > box.x && x < box.x + box.w && box.y < ys[yi + 1] && box.y + box.h > y) ? 0 : 1;
  }
  return { xs, ys, nx, ny, open, right, down, usedRight: new Uint16Array(count), usedDown: new Uint16Array(count),
    crossedH: new Uint16Array(count), crossedV: new Uint16Array(count) };
}
type RouteGrid = ReturnType<typeof routeGrid>;

/**
 * The cheapest orthogonal path from `start` to `goal` on the grid. Turns, running along a link
 * already placed and crossing one cost extra; links leave their parent and reach their child heading down.
 */
function searchRoute(grid: RouteGrid, start: Point, goal: Point): number[] | null {
  const { xs, ys, nx, ny, open, right, down, usedRight, usedDown, crossedH, crossedV } = grid;
  const startNode = ys.indexOf(Math.round(start.y)) * nx + xs.indexOf(Math.round(start.x));
  const goalNode = ys.indexOf(Math.round(goal.y)) * nx + xs.indexOf(Math.round(goal.x));
  if (startNode < 0 || goalNode < 0 || !open[startNode] || !open[goalNode]) return null;
  const count = nx * ny;
  // State = node × heading (0 right, 1 left, 2 down, 3 up).
  const best = new Float64Array(count * 4).fill(Infinity), previous = new Int32Array(count * 4).fill(-1);
  const heap: number[] = [], keys: number[] = [];
  const push = (state: number, key: number) => {
    heap.push(state); keys.push(key);
    for (let i = heap.length - 1; i > 0;) {
      const up = (i - 1) >> 1; if (keys[up] <= keys[i]) break;
      [heap[up], heap[i]] = [heap[i], heap[up]]; [keys[up], keys[i]] = [keys[i], keys[up]]; i = up;
    }
  };
  const pop = () => {
    const top = heap[0], lastState = heap.pop()!, lastKey = keys.pop()!;
    if (heap.length) {
      heap[0] = lastState; keys[0] = lastKey;
      for (let i = 0; ;) {
        const l = i * 2 + 1, r = l + 1; let m = i;
        if (l < heap.length && keys[l] < keys[m]) m = l;
        if (r < heap.length && keys[r] < keys[m]) m = r;
        if (m === i) break;
        [heap[m], heap[i]] = [heap[i], heap[m]]; [keys[m], keys[i]] = [keys[i], keys[m]]; i = m;
      }
    }
    return top;
  };
  const goalX = xs[goalNode % nx], goalY = ys[Math.floor(goalNode / nx)];
  const estimate = (node: number) => Math.abs(xs[node % nx] - goalX) + Math.abs(ys[Math.floor(node / nx)] - goalY);
  const first = startNode * 4 + 2;
  best[first] = 0; push(first, estimate(startNode));
  const reverse = [1, 0, 3, 2];
  for (let guard = 0; heap.length && guard < 400_000; guard++) {
    const state = pop(), node = state >> 2, heading = state & 3, cost = best[state];
    if (node === goalNode) {
      const path: number[] = [];
      for (let at = state; at >= 0; at = previous[at]) path.unshift(at >> 2);
      return path;
    }
    const xi = node % nx, yi = Math.floor(node / nx);
    for (let turn = 0; turn < 4; turn++) {
      if (turn === reverse[heading]) continue;
      let next: number, length: number, shared: number, crossings: number;
      if (turn === 0) { if (xi + 1 >= nx || !right[node]) continue; next = node + 1; length = xs[xi + 1] - xs[xi]; shared = usedRight[node]; crossings = crossedV[next]; }
      else if (turn === 1) { if (xi === 0 || !right[node - 1]) continue; next = node - 1; length = xs[xi] - xs[xi - 1]; shared = usedRight[next]; crossings = crossedV[next]; }
      else if (turn === 2) { if (yi + 1 >= ny || !down[node]) continue; next = node + nx; length = ys[yi + 1] - ys[yi]; shared = usedDown[node]; crossings = crossedH[next]; }
      else { if (yi === 0 || !down[node - nx]) continue; next = node - nx; length = ys[yi] - ys[yi - 1]; shared = usedDown[next]; crossings = crossedH[next]; }
      if (!open[next]) continue;
      const total = cost + length + (turn === heading ? 0 : TURN) + (shared ? JOIN + length * SHARE : 0) + crossings * CROSS
        // A link arrives at its child heading down; arriving sideways costs the last turn.
        + (next === goalNode && turn !== 2 ? TURN : 0);
      const target = next * 4 + turn;
      if (total < best[target]) { best[target] = total; previous[target] = state; push(target, total + estimate(next)); }
    }
  }
  return null;
}

/** Marks a found path's steps as used, so the links routed after it look for their own lanes. */
function claimRoute(grid: RouteGrid, path: number[]) {
  for (let i = 0; i + 1 < path.length; i++) {
    const a = path[i], b = path[i + 1];
    if (Math.abs(a - b) === 1) { grid.usedRight[Math.min(a, b)]++; grid.crossedH[a]++; grid.crossedH[b]++; }
    else { grid.usedDown[Math.min(a, b)]++; grid.crossedV[a]++; grid.crossedV[b]++; }
  }
}

/** Drops points in the middle of a straight run, so each segment is one whole lane. */
function straighten(points: Point[]): Point[] {
  return points.filter((point, index) => {
    if (index === 0 || index === points.length - 1) return true;
    const before = points[index - 1], after = points[index + 1];
    return !(before.x === point.x && point.x === after.x || before.y === point.y && point.y === after.y);
  });
}

/**
 * Every link's drawn path. A link keeps its curve while nothing is in its way; otherwise it is
 * routed around the cards with its own lane where there is room, and links still sharing a lane
 * are spread a few pixels apart so each one can be followed. A link pulled to a point keeps it.
 */
export function routeLinks(boxes: Map<string, WireBox>, links: WireLink[]): Map<string, string> {
  const shapes = new Map<string, string>();
  const ports = linkPorts(boxes, links);
  const wallOf = new Map([...boxes].map(([id, box]) => [id, { x: box.x - CLEAR, y: box.y - CLEAR, w: box.w + CLEAR * 2, h: box.h + CLEAR * 2 }]));
  const walls = [...wallOf.values()];
  const routed: { link: WireLink; points: Point[] }[] = [];
  const pending: { link: WireLink; start: Point; goal: Point; out: Point; into: Point }[] = [];
  for (const link of links) {
    const from = boxes.get(link.from), to = boxes.get(link.to), port = ports.get(link.key);
    if (!from || !to || !port) continue;
    const x1 = port.out, y1 = Math.round(from.y + from.h), x2 = port.into, y2 = Math.round(to.y);
    if (link.via) { shapes.set(link.key, wirePath({ ...from, x: x1 - from.w / 2 }, { ...to, x: x2 - to.w / 2 }, [], 0, link.via)); continue; }
    // The curve may not touch any other card's cleared area (its own two cards are where it starts and ends).
    const others = [...wallOf].filter(([id]) => id !== link.from && id !== link.to).map(([, wall]) => wall);
    const reach = Math.max(60, Math.abs(y2 - y1) * .45);
    const clear = y2 > y1 + STUB * 2 && Array.from({ length: 23 }, (_, i) => (i + 1) / 24)
      .every(t => !others.some(wall => inside(wall, cubicAt(t, x1, x1, x2, x2), cubicAt(t, y1, y1 + reach, y2 - reach, y2))));
    if (clear) { shapes.set(link.key, `M${x1},${y1} C${x1},${y1 + reach} ${x2},${y2 - reach} ${x2},${y2}`); continue; }
    pending.push({ link, out: { x: x1, y: y1 }, into: { x: x2, y: y2 }, start: { x: x1, y: y1 + STUB }, goal: { x: x2, y: y2 - STUB } });
  }
  // Shorter links first: they have the fewest ways round, so they take their lanes before longer ones.
  pending.sort((a, b) => Math.abs(a.goal.x - a.start.x) + Math.abs(a.goal.y - a.start.y) - Math.abs(b.goal.x - b.start.x) - Math.abs(b.goal.y - b.start.y));
  const grid = pending.length ? routeGrid(walls, pending.flatMap(item => [item.start, item.goal])) : null;
  for (const { link, start, goal, out, into } of pending) {
    const path = grid && grid.nx * grid.ny <= 60_000 ? searchRoute(grid, start, goal) : null;
    if (!grid || !path) { shapes.set(link.key, wirePath(boxes.get(link.from)!, boxes.get(link.to)!, [...boxes.values()].filter(box => box !== boxes.get(link.from) && box !== boxes.get(link.to)))); continue; }
    claimRoute(grid, path);
    const middle = path.map(node => ({ x: grid.xs[node % grid.nx], y: grid.ys[Math.floor(node / grid.nx)] }));
    routed.push({ link, points: straighten([out, ...middle, into].map(point => ({ ...point }))) });
  }
  // Links still sharing a lane: spread each group apart around the lane, ordered by where they start.
  const runs = routed.flatMap(({ link, points }) => points.slice(1, -2).map((a, index) => {
    const b = points[index + 2], vertical = a.x === b.x;
    return { link: link.key, a, b, vertical, at: vertical ? a.x : a.y, lo: Math.min(vertical ? a.y : a.x, vertical ? b.y : b.x), hi: Math.max(vertical ? a.y : a.x, vertical ? b.y : b.x), order: points[0].x };
  }));
  const seen = new Set<number>();
  runs.forEach((run, index) => {
    if (seen.has(index)) return;
    const group = [index];
    for (let probe = 0; probe < group.length; probe++) {
      const current = runs[group[probe]];
      runs.forEach((other, j) => {
        if (seen.has(j) || group.includes(j) || other.vertical !== current.vertical || other.at !== current.at || other.link === current.link) return;
        if (Math.min(current.hi, other.hi) - Math.max(current.lo, other.lo) > 0) group.push(j);
      });
    }
    group.forEach(j => seen.add(j));
    if (group.length < 2) return;
    const lane = Math.min(LANE, 28 / (group.length - 1));
    group.sort((x, y) => runs[x].order - runs[y].order).forEach((j, slot) => {
      const shift = (slot - (group.length - 1) / 2) * lane, { a, b, vertical } = runs[j];
      if (vertical) { a.x += shift; b.x += shift; } else { a.y += shift; b.y += shift; }
    });
  });
  for (const { link, points } of routed) shapes.set(link.key, rounded(points.map(point => [point.x, point.y]), 10));
  return shapes;
}
const gapX = 252;
const gapY = 56;
const arrowMoves: Record<string, [number, number]> = { ArrowLeft: [-16, 0], ArrowRight: [16, 0], ArrowUp: [0, -16], ArrowDown: [0, 16] };

export function moveCanvasSelection(points: Map<string, Point>, dx: number, dy: number): Map<string, Point> {
  if (!points.size) return new Map();
  const values = [...points.values()];
  const x = Math.max(-9500 - Math.min(...values.map(p => p.x)), Math.min(9500 - Math.max(...values.map(p => p.x)), Math.round(dx)));
  const y = Math.max(-9500 - Math.min(...values.map(p => p.y)), Math.min(9500 - Math.max(...values.map(p => p.y)), Math.round(dy)));
  return new Map([...points].map(([id, point]) => [id, { x: point.x + x, y: point.y + y }]));
}

export type LinkAction = { kind: "connect" | "disconnect"; id: string; parentId: string };

/** How a team stores the point a link is pulled through: "parent>child", or "loop". */
export const linkPointKey = (parentId: string, id: string) => `${parentId}>${id}`;
export const LOOP_LINK = "loop";
/** A scene point from a pointer position, under the canvas camera. */
export function scenePoint(clientX: number, clientY: number, bounds: { left: number; top: number }, view: { x: number; y: number; scale: number }): Point {
  return { x: Math.round((clientX - bounds.left - view.x) / view.scale), y: Math.round((clientY - bounds.top - view.y) / view.scale) };
}

/**
 * What shift-clicking `target` does while `starter` is the active card: an existing removable link
 * between them (either direction) is removed, otherwise the target is linked below the starter, or
 * above it when only that direction is allowed. Null when the two cards cannot be (un)linked.
 */
export function shiftLinkAction(starter: string, target: string,
  canConnect: (id: string, parentId: string) => boolean,
  canDisconnect: (id: string, parentId: string) => boolean): LinkAction | null {
  if (!starter || !target || starter === target) return null;
  if (canDisconnect(target, starter)) return { kind: "disconnect", id: target, parentId: starter };
  if (canDisconnect(starter, target)) return { kind: "disconnect", id: starter, parentId: target };
  if (canConnect(target, starter)) return { kind: "connect", id: target, parentId: starter };
  if (canConnect(starter, target)) return { kind: "connect", id: starter, parentId: target };
  return null;
}

/** Why a card can't be removed from its team, for the right-click menu. */
export function removalReason(node: CanvasNode, nodes: CanvasNode[]): string {
  if (node.role === "planner") return "The orchestrator runs the team, so it stays";
  if (node.role === "reviewer") return "The main reviewer closes every round, so it stays";
  if (node.role === "review_split") return "Remove the sub-reviewers instead; this split goes with them";
  if (node.role === "worker" && nodes.filter(item => item.role === "worker").length < 2) return "A team needs at least one worker";
  return "This card can't be removed";
}

export function canvasLayout(nodes: CanvasNode[], levels: CanvasNode[][], heights = new Map<string, number>()): Map<string, Point> {
  const order = new Map(nodes.map((node, index) => [node.id, index]));
  const extent = Math.max(640, ...levels.map(level => level.length * gapX - (gapX - width)));
  let y = 60;
  const result = new Map<string, Point>();
  for (const level of levels) {
    [...level].sort((a, b) => order.get(a.id)! - order.get(b.id)!).forEach((node, index) => result.set(node.id,
      node.positioned ? { x: node.x, y: node.y } : { x: 60 + (extent - (level.length * gapX - (gapX - width))) / 2 + index * gapX, y }));
    y += Math.max(height, ...level.map(node => heights.get(node.id) || height)) + gapY;
  }
  return result;
}

export function AgentOrchestratorCanvas({ nodes, levels, selectedId, busy, onSelect, onMove, onConnect, canConnect, onUnlink, canUnlink, onRemove, canRemove, describe, children, showState = true, loop = null, points, onBend }: {
  /** The reviewer's way back to the orchestrator, drawn as a dashed link (not a dependency). */
  loop?: { from: string; to: string } | null;
  /** Points links are pulled through, keyed by `linkPointKey` (or `LOOP_LINK`). */
  points?: Record<string, Point>;
  /** Shift-drag a link to pull it through a point; Shift-double-click resets it (point null). */
  onBend?: (key: string, point: Point | null) => void;
  nodes: CanvasNode[]; levels: CanvasNode[][]; selectedId: string; busy: boolean;
  /** A saved team is a template that never runs: its cards show no run state. */
  showState?: boolean;
  describe: (node: CanvasNode) => string;
  children?: ReactNode;
  onSelect: (id: string) => void;
  onMove: (positions: { id: string; x: number; y: number }[], parentId?: string) => Promise<void>;
  onConnect: (id: string, parentId: string) => void;
  canConnect: (id: string, parentId: string) => boolean;
  /** Click a link to remove it. */
  onUnlink?: (id: string, parentId: string) => void;
  /** Whether a link may be removed (shift-click toggles links using the same rule). */
  canUnlink?: (id: string, parentId: string) => boolean;
  /** Remove a card (never the orchestrator). */
  onRemove?: (id: string) => void;
  canRemove?: (id: string) => boolean;
}) {
  const viewport = useRef<HTMLDivElement>(null);
  const scene = useRef<HTMLDivElement>(null);
  const zoomLabel = useRef<HTMLSpanElement>(null);
  const elements = useRef(new Map<string, HTMLDivElement>());
  const paths = useRef(new Map<string, SVGPathElement>());
  const positions = useRef(new Map<string, Point>());
  const heights = useRef(new Map<string, number>());
  const camera = useRef({ x: 0, y: 0, scale: 1 });
  const manuallyNavigated = useRef(false);
  const drag = useRef<{ id: string | null; start: Point; original: Point; group: Map<string, Point>; last: Point; moved: boolean; parent?: string } | null>(null);
  const wind = useRef(0);
  const frame = useRef(0);
  const reducedMotion = useRef(false);
  const current = useRef({ nodes, levels, canConnect, onMove, loop, points });
  current.current = { nodes, levels, canConnect, onMove, loop, points };
  // A link being pulled: its key and where it is now, ahead of the saved point. A point just
  // released is kept here until the page's saved points catch up, so the link doesn't snap back.
  const bending = useRef<{ key: string; point: Point | null } | null>(null);
  const released = useRef(new Map<string, Point | null>());
  // The last full routing and the layout it was made for.
  const routes = useRef<{ signature: string; shapes: Map<string, string> }>({ signature: "", shapes: new Map() });
  const [parentId, setParentId] = useState("");
  const [dropTarget, setDropTarget] = useState("");
  const [draggingId, setDraggingId] = useState("");
  const [selected, setSelected] = useState(new Set(selectedId ? [selectedId] : []));
  // When the page clears its selection (the Team page's role popover closing), drop the highlight too.
  useEffect(() => { if (!selectedId) setSelected(current => current.size ? new Set() : current); }, [selectedId]);
  const [notice, setNotice] = useState("");
  const noticeTimer = useRef(0);
  // The card under the pointer: its links stand out and the others fade.
  const [hovered, setHovered] = useState("");
  const [menu, setMenu] = useState<ChatMenuState>(null);
  const cardMenu = (event: ReactMouseEvent, node: CanvasNode) => {
    event.preventDefault(); event.stopPropagation();
    if (!onRemove) return;
    const name = node.settings?.name || ROLE_TITLE[node.role as keyof typeof ROLE_TITLE] || "Worker";
    setSelected(new Set([node.id]));
    setMenu({ x: event.clientX, y: event.clientY, label: name, items: [
      { label: "Edit", icon: "edit", run: () => onSelect(node.id) },
      { kind: "separator" },
      busy ? { label: "Remove from team", icon: "delete", danger: true, reason: "The team is saving" }
        : canRemove?.(node.id) ? { label: "Remove from team", icon: "delete", danger: true, run: () => onRemove(node.id) }
        : { label: "Remove from team", icon: "delete", danger: true, reason: removalReason(node, current.current.nodes) },
    ] });
  };
  const initialized = useRef(false);
  useLayoutEffect(() => () => window.clearTimeout(noticeTimer.current), []);

  const toggleSelected = (id: string) =>
    setSelected(previous => { const next = new Set(previous); if (next.has(id)) next.delete(id); else next.add(id); return next; });
  const flash = (text: string) => {
    window.clearTimeout(noticeTimer.current);
    setNotice(text);
    noticeTimer.current = window.setTimeout(() => setNotice(""), 2200);
  };
  // Shift-click links (or unlinks) the clicked card with the active one: an armed out-port, or
  // the single selected card. The starter stays selected so several cards can be linked in a row.
  const shiftLink = (id: string) => {
    const starter = parentId || (selected.size === 1 ? [...selected][0] : "");
    if (!starter || starter === id) return false;
    const action = shiftLinkAction(starter, id, canConnect, (child, parent) => Boolean(onUnlink && canUnlink?.(child, parent)));
    if (!action) {
      const linked = current.current.nodes.some(node => node.id === id && node.parents.includes(starter)
        || node.id === starter && node.parents.includes(id));
      flash(linked ? "This link is required and can't be removed" : "These cards can't be linked");
      return true;
    }
    if (action.kind === "connect") onConnect(action.id, action.parentId);
    else onUnlink?.(action.id, action.parentId);
    flash(action.kind === "connect" ? "Linked" : "Unlinked");
    setParentId("");
    setSelected(new Set([starter]));
    return true;
  };

  const draw = () => {
    frame.current = 0;
    const view = camera.current;
    if (scene.current) scene.current.style.transform = `translate(${view.x}px, ${view.y}px) scale(${view.scale})`;
    if (zoomLabel.current) zoomLabel.current.textContent = `${Math.round(view.scale * 100)}%`;
    for (const [id, point] of positions.current) {
      const element = elements.current.get(id);
      if (element) element.style.transform = `translate(${point.x}px, ${point.y}px)`;
    }
    // ponytail: the graph is capped at 24 cards; one bounded scan per drag frame is enough.
    const box = (id: string): WireBox | null => {
      const point = positions.current.get(id);
      return point ? { x: point.x, y: point.y, w: width, h: heights.current.get(id) || height } : null;
    };
    const pulled = (key: string) => bending.current?.key === key ? bending.current.point
      : released.current.has(key) ? released.current.get(key)! : current.current.points?.[key] ?? null;
    const links = current.current.nodes.flatMap(node => node.parents.map(parent => ({ parent, id: node.id, key: JSON.stringify([parent, node.id]), point: linkPointKey(parent, node.id) })));
    const loopLink = current.current.loop;
    if (loopLink) links.push({ parent: loopLink.from, id: loopLink.to, key: LOOP_LINK, point: LOOP_LINK });
    // At rest every link is routed together (own ports, own lanes); the result is kept until a card,
    // a link or a pulled point changes. While a card is dragged, links follow it as quick curves.
    if (!drag.current?.id) {
      const boxes = new Map(current.current.nodes.map(node => [node.id, box(node.id)] as const)
        .filter((entry): entry is [string, WireBox] => Boolean(entry[1])));
      const wires = links.map(link => ({ key: link.key, from: link.parent, to: link.id, via: pulled(link.point) }));
      const signature = JSON.stringify([[...boxes], wires]);
      if (routes.current.signature !== signature) routes.current = { signature, shapes: routeLinks(boxes, wires) };
      for (const { key } of links) {
        const shape = routes.current.shapes.get(key);
        if (!shape) continue;
        paths.current.get(key)?.setAttribute("d", shape);
        paths.current.get(`${key}#hit`)?.setAttribute("d", shape);
      }
      wind.current = 0;
      return;
    }
    for (const { parent, id, key, point } of links) {
      const from = box(parent), to = box(id);
      if (!from || !to) continue;
      const x1 = from.x + width / 2, y1 = from.y + from.h, x2 = to.x + width / 2, y2 = to.y;
      const dragged = drag.current?.id ? positions.current.get(drag.current.id) : null;
      const influence = dragged ? Math.max(0, 1 - Math.hypot((x1 + x2) / 2 - dragged.x - width / 2, (y1 + y2) / 2 - dragged.y - height / 2) / 400) : 1;
      const bend = reducedMotion.current ? 0 : wind.current * influence;
      const others = current.current.nodes.filter(other => other.id !== parent && other.id !== id)
        .map(other => box(other.id)).filter((other): other is WireBox => Boolean(other));
      const shape = wirePath(from, to, others, bend, pulled(point));
      paths.current.get(key)?.setAttribute("d", shape);
      paths.current.get(`${key}#hit`)?.setAttribute("d", shape);
    }
    if (!drag.current && Math.abs(wind.current) > .3 && !reducedMotion.current) {
      wind.current *= -.68;
      frame.current = requestAnimationFrame(draw);
    }
  };
  const schedule = () => { if (!frame.current) frame.current = requestAnimationFrame(draw); };
  // Returns false when the viewport cannot be measured yet (e.g. the view is still hidden):
  // fitting a 0×0 box would pin the scale to its minimum and centre the graph on nothing.
  const fit = () => {
    const box = viewport.current?.getBoundingClientRect();
    const points = [...positions.current.values()];
    if (!box || !points.length || box.width < 120 || box.height < 160) return false;
    const left = Math.min(...points.map(p => p.x)), top = Math.min(...points.map(p => p.y));
    const w = Math.max(...points.map(p => p.x)) + width - left;
    const h = Math.max(...[...positions.current].map(([id, p]) => p.y + (heights.current.get(id) || height))) - top;
    const scale = Math.max(.3, Math.min(1.25, (box.width - 80) / w, (box.height - 120) / h));
    camera.current = { x: (box.width - w * scale) / 2 - left * scale, y: (box.height - h * scale) / 2 - top * scale, scale };
    manuallyNavigated.current = false;
    schedule();
    return true;
  };
  const zoom = (factor: number, x = viewport.current!.clientWidth / 2, y = viewport.current!.clientHeight / 2) => {
    manuallyNavigated.current = true;
    const before = camera.current, scale = Math.max(.3, Math.min(2, before.scale * factor));
    camera.current = { x: x - (x - before.x) * scale / before.scale, y: y - (y - before.y) * scale / before.scale, scale };
    schedule();
  };

  useLayoutEffect(() => {
    for (const [id, element] of elements.current) heights.current.set(id, element.offsetHeight || height);
    const next = canvasLayout(nodes, levels, heights.current);
    if (drag.current?.id) for (const id of drag.current.group.keys()) {
      const point = positions.current.get(id);
      if (point) next.set(id, point);
    }
    positions.current = next;
    if (!initialized.current) initialized.current = fit(); else schedule();
  }, [nodes, levels]);

  // New saved points (or a loop switched on or off) redraw the links; a released point gives way.
  useLayoutEffect(() => { released.current.clear(); schedule(); }, [points, loop?.from, loop?.to]);

  // Automatic views refit on pane/window resize. Manual navigation keeps its world centre
  // unless resizing would leave every card offscreen, in which case restore an inspectable view.
  useLayoutEffect(() => {
    const surface = viewport.current;
    if (!surface || typeof ResizeObserver === "undefined") return;
    let previous = { width: surface.clientWidth, height: surface.clientHeight };
    const observer = new ResizeObserver(() => {
      const next = { width: surface.clientWidth, height: surface.clientHeight };
      const hidden = next.width === 0 || next.height === 0;
      const wasHidden = previous.width === 0 || previous.height === 0;
      if (!hidden && (wasHidden || !initialized.current)) initialized.current = fit() || initialized.current;
      else if (!hidden && (next.width !== previous.width || next.height !== previous.height)) {
        if (!manuallyNavigated.current) fit();
        else {
          const view = camera.current;
          view.x += (next.width - previous.width) / 2;
          view.y += (next.height - previous.height) / 2;
          const visible = [...positions.current].some(([id, point]) => {
            const x = view.x + (point.x + width / 2) * view.scale;
            const y = view.y + (point.y + (heights.current.get(id) || height) / 2) * view.scale;
            return x >= 0 && x <= next.width && y >= 0 && y <= next.height;
          });
          if (!visible) fit(); else schedule();
        }
      }
      previous = next;
    });
    observer.observe(surface);
    return () => observer.disconnect();
  }, []);

  useLayoutEffect(() => {
    const surface = viewport.current!;
    const preference = matchMedia("(prefers-reduced-motion: reduce)");
    const motionChanged = () => { reducedMotion.current = preference.matches; if (preference.matches) wind.current = 0; schedule(); };
    motionChanged(); preference.addEventListener("change", motionChanged);
    const wheel = (event: WheelEvent) => {
      event.preventDefault();
      if (drag.current) return;
      if (event.ctrlKey || event.metaKey) {
        const bounds = surface.getBoundingClientRect();
        zoom(Math.exp(-event.deltaY * .002), event.clientX - bounds.left, event.clientY - bounds.top);
      } else {
        manuallyNavigated.current = true;
        camera.current.x -= event.shiftKey ? event.deltaY : event.deltaX;
        camera.current.y -= event.shiftKey ? 0 : event.deltaY;
        schedule();
      }
    };
    surface.addEventListener("wheel", wheel, { passive: false });
    const observer = new ResizeObserver(schedule); observer.observe(surface);
    // Shift held: links show they can be pulled rather than removed.
    const shift = (event: KeyboardEvent) => surface.classList.toggle("is-shift", event.shiftKey);
    window.addEventListener("keydown", shift); window.addEventListener("keyup", shift);
    return () => {
      cancelAnimationFrame(frame.current); observer.disconnect();
      surface.removeEventListener("wheel", wheel); preference.removeEventListener("change", motionChanged);
      window.removeEventListener("keydown", shift); window.removeEventListener("keyup", shift);
    };
  }, []);

  const begin = (event: ReactPointerEvent, id: string | null) => {
    if (event.button !== 0 || busy || event.target instanceof Element && event.target.closest(".ao-port")) return;
    if (id === null && event.target instanceof Element && event.target.closest(".ao-canvas-card, .ao-canvas-controls, .ao-canvas-overlay")) return;
    event.preventDefault();
    if (id && event.shiftKey && shiftLink(id)) return;
    if (id && (event.shiftKey || event.ctrlKey || event.metaKey)) { toggleSelected(id); return; }
    const ids = id ? selected.has(id) ? selected : new Set([id]) : new Set<string>();
    const group = new Map([...positions.current].filter(([key]) => ids.has(key)));
    viewport.current!.setPointerCapture(event.pointerId);
    drag.current = { id, start: { x: event.clientX, y: event.clientY }, last: { x: event.clientX, y: event.clientY }, original: id ? positions.current.get(id)! : { ...camera.current }, group, moved: false };
    if (id) { setSelected(new Set(ids)); onSelect(id); setDraggingId(id); }
  };
  // Shift-drag on a link pulls it through the pointer; the point is saved when the drag ends.
  const startBend = (event: ReactPointerEvent, key: string) => {
    if (!onBend || busy || event.button !== 0 || !event.shiftKey) return false;
    event.preventDefault(); event.stopPropagation();
    viewport.current!.setPointerCapture(event.pointerId);
    bending.current = { key, point: scenePoint(event.clientX, event.clientY, viewport.current!.getBoundingClientRect(), camera.current) };
    schedule();
    return true;
  };
  const move = (event: ReactPointerEvent) => {
    if (bending.current) {
      bending.current.point = scenePoint(event.clientX, event.clientY, viewport.current!.getBoundingClientRect(), camera.current);
      schedule();
      return;
    }
    const active = drag.current;
    if (!active) return;
    const dx = event.clientX - active.start.x, dy = event.clientY - active.start.y;
    active.moved ||= Math.hypot(dx, dy) > 4;
    if (active.id) {
      for (const [id, point] of moveCanvasSelection(active.group, dx / camera.current.scale, dy / camera.current.scale)) positions.current.set(id, point);
      const point = positions.current.get(active.id)!;
      wind.current = Math.max(-38, Math.min(38, (event.clientX - active.last.x) * 2));
      let nearest = 72; let target = "";
      for (const node of current.current.nodes) {
        if (active.group.size !== 1 || !current.current.canConnect(active.id, node.id)) continue;
        const parent = positions.current.get(node.id)!;
        const distance = Math.hypot(parent.x - point.x, parent.y + (heights.current.get(node.id) || height) - point.y);
        if (distance < nearest) { nearest = distance; target = node.id; }
      }
      active.parent = target || undefined; setDropTarget(previous => previous === target ? previous : target);
    } else { manuallyNavigated.current = true; camera.current.x = active.original.x + dx; camera.current.y = active.original.y + dy; }
    active.last = { x: event.clientX, y: event.clientY }; schedule();
  };
  const end = (cancelled: boolean) => {
    const pulling = bending.current;
    if (pulling) {
      bending.current = null;
      if (!cancelled && pulling.point) { released.current.set(pulling.key, pulling.point); onBend?.(pulling.key, pulling.point); }
      schedule();
      return;
    }
    const active = drag.current;
    if (!active) return;
    drag.current = null; setDraggingId(""); setDropTarget("");
    if (active.id) {
      if (cancelled) for (const [id, point] of active.group) positions.current.set(id, point);
      else if (active.moved) persist(active.group, active.parent);
    }
    schedule();
  };
  const persist = (before: Map<string, Point>, parent?: string) => {
    void current.current.onMove([...before.keys()].map(id => ({ id, ...positions.current.get(id)! })), parent).catch(() => {
      for (const [id, point] of before) positions.current.set(id, point);
      schedule();
    });
  };
  const align = (axis: "x" | "y") => {
    if (busy) return;
    const before = new Map([...positions.current].filter(([id]) => selected.has(id)));
    if (before.size < 2) return;
    const value = Math.min(...[...before.values()].map(point => point[axis]));
    for (const [id, point] of before) positions.current.set(id, { ...point, [axis]: value });
    schedule(); persist(before);
  };

  return <div ref={viewport} className="ao-canvas" role="region" aria-label="Movable team canvas"
    onPointerDown={event => begin(event, null)} onPointerMove={move} onPointerUp={() => end(false)} onPointerCancel={() => end(true)}
    onKeyDown={event => {
      if (event.target instanceof Element && event.target.closest(".ao-canvas-overlay")) return;
      if (event.key === "Escape") { end(true); setParentId(""); setSelected(new Set()); }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "a") { event.preventDefault(); setSelected(new Set(nodes.map(node => node.id))); }
    }}>
    <div className="ao-canvas-controls" aria-label="Canvas controls">
      <button type="button" onClick={() => zoom(1 / 1.2)} aria-label="Zoom out" title="Zoom out">−</button><span ref={zoomLabel}>100%</span>
      <button type="button" onClick={() => zoom(1.2)} aria-label="Zoom in" title="Zoom in">+</button><button type="button" onClick={fit} aria-label="Fit to screen" title="Fit">⤢</button>
      {selected.size > 1 ? <><span role="status">{selected.size}</span><button type="button" disabled={busy} onClick={() => align("x")} aria-label="Align left" title="Align left">⇤</button><button type="button" disabled={busy} onClick={() => align("y")} aria-label="Align top" title="Align top">⤒</button></> : null}
      {parentId ? <button type="button" onClick={() => setParentId("")} aria-label="Cancel connection" title="Cancel connection">✕</button> : null}
      {onRemove && selected.size === 1 && canRemove?.([...selected][0]) ? <button type="button" disabled={busy} onClick={() => onRemove([...selected][0])}
        aria-label="Remove selected card" title="Remove card (its task passes to another worker)">🗑</button> : null}
    </div>
    {notice || dropTarget || parentId ? <span className="ao-connect-hint" role="status">
      {notice || (dropTarget ? "Drop to link" : "Shift-click a card to link or unlink")}</span> : null}
    {children}
    <div ref={scene} className="ao-canvas-scene">
      <svg className={hovered && !draggingId ? "ao-canvas-wires has-hover" : "ao-canvas-wires"} aria-hidden="true">{nodes.flatMap(node => node.parents.flatMap(parent => [<path key={JSON.stringify([parent, node.id])}
        ref={element => { const key = JSON.stringify([parent, node.id]); if (element) paths.current.set(key, element); else paths.current.delete(key); }}
        className={[["running", "reserved"].includes(node.state) ? "is-running" : "", hovered && (hovered === parent || hovered === node.id) ? "is-related" : ""].filter(Boolean).join(" ")} />,
        // A wide invisible twin makes the thin link easy to click (or Shift-drag to pull it).
        onUnlink || onBend ? <path key={`${JSON.stringify([parent, node.id])}#hit`} className="ao-wire-hit"
          ref={element => { const key = `${JSON.stringify([parent, node.id])}#hit`; if (element) paths.current.set(key, element); else paths.current.delete(key); }}
          onPointerDown={event => { startBend(event, linkPointKey(parent, node.id)); }}
          onDoubleClick={event => { if (event.shiftKey && !busy) { released.current.set(linkPointKey(parent, node.id), null); onBend?.(linkPointKey(parent, node.id), null); schedule(); } }}
          onClick={event => { if (!busy && !event.shiftKey) onUnlink?.(node.id, parent); }}>
          <title>{[onUnlink ? "Click to remove this link" : "", onBend ? "Shift-drag to bend it, Shift-double-click to straighten it" : ""].filter(Boolean).join("; ")}</title></path> : null]))}
        {loop ? <>
          <path key={LOOP_LINK} className={hovered && (hovered === loop.from || hovered === loop.to) ? "is-loop is-related" : "is-loop"} ref={element => { if (element) paths.current.set(LOOP_LINK, element); else paths.current.delete(LOOP_LINK); }} />
          {onBend ? <path key={`${LOOP_LINK}#hit`} className="ao-wire-hit"
            ref={element => { if (element) paths.current.set(`${LOOP_LINK}#hit`, element); else paths.current.delete(`${LOOP_LINK}#hit`); }}
            onPointerDown={event => { startBend(event, LOOP_LINK); }}
            onDoubleClick={event => { if (event.shiftKey && !busy) { released.current.set(LOOP_LINK, null); onBend(LOOP_LINK, null); schedule(); } }}>
            <title>The reviewer reports back to the orchestrator. Shift-drag to bend it, Shift-double-click to straighten it</title></path> : null}
        </> : null}</svg>
      {nodes.map(node => <div key={node.id} data-ao-node={node.id}
        onPointerEnter={() => setHovered(node.id)} onPointerLeave={() => setHovered(current => current === node.id ? "" : current)}
        onContextMenu={event => cardMenu(event, node)} ref={element => { if (element) elements.current.set(node.id, element); else elements.current.delete(node.id); }}
        className={`ao-canvas-card ao-node-${node.state}${selected.has(node.id) ? " is-selected" : ""}${draggingId && selected.has(node.id) ? " is-dragging" : ""}${dropTarget === node.id ? " is-target" : ""}`}>
        <button type="button" className="ao-card-handle" aria-label={showState ? `Edit ${node.settings?.name || node.role}, ${node.state}` : `Edit ${node.settings?.name || node.role}`}
          aria-pressed={selected.has(node.id)}
          title="Shift-click another card to link or unlink it with this one; Ctrl-click to select several; arrow keys move the selection"
          onPointerDown={event => { event.stopPropagation(); begin(event, node.id); }} onClick={event => {
            if (event.detail !== 0) return;
            if (event.shiftKey && shiftLink(node.id)) return;
            if (event.shiftKey || event.ctrlKey || event.metaKey) toggleSelected(node.id);
            else { setSelected(new Set([node.id])); onSelect(node.id); }
          }}
          onKeyDown={event => {
            const delta = arrowMoves[event.key];
            if (!delta || busy) return;
            event.preventDefault();
            const ids = selected.has(node.id) ? selected : new Set([node.id]);
            setSelected(new Set(ids));
            const before = new Map([...positions.current].filter(([id]) => ids.has(id)));
            for (const [id, point] of moveCanvasSelection(before, delta[0], delta[1])) positions.current.set(id, point);
            wind.current = 0; schedule(); persist(before);
          }}>
          <span className="ao-card-title">{showState ? <span className={`ao-dot ao-dot-${node.state}`} title={node.state} aria-hidden="true" /> : null}
            <strong>{node.settings?.name || ROLE_TITLE[node.role as keyof typeof ROLE_TITLE] || "Worker"}</strong>
            {showState ? <span className="ao-canvas-state">{node.role === "reviewer" && node.state === "running" ? "reviewing" : node.state}</span> : null}</span>
          <span className="ao-card-route">{describe(node)}</span>
        </button>
        <button type="button" className="ao-port ao-port-in" aria-label={`Connect dependency to ${node.settings?.name || node.role}`}
          disabled={!parentId || !canConnect(node.id, parentId) || busy} onClick={() => { onConnect(node.id, parentId); setParentId(""); }}>●</button>
        <button type="button" className="ao-port ao-port-out" aria-label={`Connect from ${node.settings?.name || node.role}`}
          disabled={busy} aria-pressed={parentId === node.id} onClick={() => setParentId(parentId === node.id ? "" : node.id)}>●</button>
      </div>)}
    </div>
    <ChatMenu menu={menu} onClose={() => setMenu(null)} />
  </div>;
}
