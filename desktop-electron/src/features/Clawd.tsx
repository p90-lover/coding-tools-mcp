import { useEffect, useRef, useState } from "react";

// Claude Code's Clawd, ported from the CLI (claude-code 2.1.299) so the chat's pet is the same
// creature: the same quadrant-block glyphs on a 9×3 grid of terminal cells, the same poses, turn
// frames and animations, one frame every 60 ms. A cell is drawn 8×16 px (a 14 px terminal), so
// each quadrant is a 4×8 px pixel.

export const CELL_W = 8;
export const CELL_H = 16;
/** Clawd's box: 9 cells wide and 3 rows high, as in the CLI (`to`, `oo`). */
export const COLS = 9;
export const ROWS = 3;
export const FRAME_MS = 60;

/** The CLI's `clawd_body` and `clawd_background` (the eyes and eyelids). */
export const CLAWD_BODY = "#d77757";
export const CLAWD_BACKGROUND = "#000000";

export type Eyes = "open" | "left" | "right" | "closed" | "wink";
export type Arms = "down" | "up" | "one-up";
export type Feet = "both" | "left" | "right";
export type Facing = "right-12" | "right-30" | "right-55" | "right-75" | "edge" | "back-105" | "back-125" | "back-150" | "back"
  | "left-75" | "left-55" | "left-30" | "left-12";
export type Parts = { eyes: Eyes; arms: Arms; feet: Feet };
export type Pose = "default" | "arms-up" | "look-left" | "look-right" | Parts | { facing: Facing };
export type Frame = { pose: Pose; offset: number; x?: number; poof?: "dot" | "wave"; shadow?: "wide" | "narrow" };

const POSES: Record<"default" | "arms-up" | "look-left" | "look-right", Parts> = {
  default: { eyes: "open", arms: "down", feet: "both" },
  "arms-up": { eyes: "open", arms: "up", feet: "both" },
  "look-left": { eyes: "left", arms: "down", feet: "both" },
  "look-right": { eyes: "right", arms: "down", feet: "both" },
};
const ARMS: Record<Arms, { r1L: string; r1R: string; r2L: string; r2R: string }> = {
  down: { r1L: " ▐", r1R: "", r2L: "▝▜", r2R: "█▀" },
  up: { r1L: "▗▟", r1R: "▄", r2L: " ▜", r2R: "█▘" },
  "one-up": { r1L: " ▐", r1R: "▄", r2L: "▝▜", r2R: "█▘" },
};
const EYES: Record<Eyes, { glyphs: string; lid?: boolean }[]> = {
  open: [{ glyphs: "▛███▛█" }],
  left: [{ glyphs: "▟███▟█" }],
  right: [{ glyphs: "█▟███▟" }],
  closed: [{ glyphs: "▂", lid: true }, { glyphs: "███" }, { glyphs: "▂", lid: true }, { glyphs: "█" }],
  wink: [{ glyphs: "▛███" }, { glyphs: "▂", lid: true }, { glyphs: "█" }],
};
const FEET: Record<Feet, string> = { both: " ▝▝   ▝▝ ", left: " ▝▝      ", right: "      ▝▝ " };
/** Turning frames: each row's glyphs, with the eye-backed span [from, to). */
const FACINGS: Record<Facing, { glyphs: string; from: number; to: number }[]> = {
  "right-12": [{ glyphs: " ▐█▜██▛█ ", from: 2, to: 8 }, { glyphs: "▝▜██████▀", from: 2, to: 7 }, { glyphs: " ▝▝   ▝▝ ", from: 0, to: 0 }],
  "right-30": [{ glyphs: "  █▛██▛▌ ", from: 2, to: 7 }, { glyphs: " ▝█████▛ ", from: 2, to: 7 }, { glyphs: "  ▘▘  ▘▘ ", from: 0, to: 0 }],
  "right-55": [{ glyphs: "  ▐█▛█▜  ", from: 3, to: 7 }, { glyphs: "  ▐████  ", from: 3, to: 7 }, { glyphs: "  ▝▝ ▝▝  ", from: 0, to: 0 }],
  "right-75": [{ glyphs: "   ██▛▌  ", from: 3, to: 6 }, { glyphs: "   ███▌  ", from: 3, to: 6 }, { glyphs: "   ▘  ▘  ", from: 0, to: 0 }],
  edge: [{ glyphs: "   ▐██   ", from: 4, to: 6 }, { glyphs: "   ▐██   ", from: 4, to: 6 }, { glyphs: "   ▝ ▝   ", from: 0, to: 0 }],
  "back-105": [{ glyphs: "   ███▌  ", from: 3, to: 6 }, { glyphs: "   ███▌  ", from: 3, to: 6 }, { glyphs: "   ▘  ▘  ", from: 0, to: 0 }],
  "back-125": [{ glyphs: "  ▐████  ", from: 3, to: 7 }, { glyphs: "  ▐████  ", from: 3, to: 7 }, { glyphs: "  ▝▝ ▝▝  ", from: 0, to: 0 }],
  "back-150": [{ glyphs: "  █████▌ ", from: 2, to: 7 }, { glyphs: " ▝█████▛ ", from: 2, to: 7 }, { glyphs: "  ▘▘  ▘▘ ", from: 0, to: 0 }],
  back: [{ glyphs: " ▐██████ ", from: 2, to: 8 }, { glyphs: "▝▜██████▀", from: 2, to: 7 }, { glyphs: " ▝▝   ▝▝ ", from: 0, to: 0 }],
  "left-75": [{ glyphs: "   ▛██▌  ", from: 3, to: 6 }, { glyphs: "   ███▌  ", from: 3, to: 6 }, { glyphs: "   ▘  ▘  ", from: 0, to: 0 }],
  "left-55": [{ glyphs: "  ▐▜▛██  ", from: 3, to: 7 }, { glyphs: "  ▐████  ", from: 3, to: 7 }, { glyphs: "  ▝▝ ▝▝  ", from: 0, to: 0 }],
  "left-30": [{ glyphs: "  ▛██▛█▌ ", from: 2, to: 7 }, { glyphs: " ▝█████▛ ", from: 2, to: 7 }, { glyphs: "  ▘▘  ▘▘ ", from: 0, to: 0 }],
  "left-12": [{ glyphs: " ▐▛███▜█ ", from: 2, to: 8 }, { glyphs: "▝▜██████▀", from: 2, to: 7 }, { glyphs: " ▝▝   ▝▝ ", from: 0, to: 0 }],
};

// The CLI's animation builders (`be`, `Mr`, `kr`, `lo`) and its sequences, unchanged.
const CROUCH = ROWS;
const AWAY = COLS;
const REST_FRAME: Frame = { pose: "default", offset: 0 };
const repeat = (pose: Pose, count: number, extra: Omit<Frame, "pose" | "offset"> & { offset?: number } = {}): Frame[] =>
  Array.from({ length: count }, () => ({ pose, offset: extra.offset ?? 0, x: extra.x, poof: extra.poof, shadow: extra.shadow }));
const turning = (facings: Facing[], shadow?: Frame["shadow"]) => facings.flatMap((facing) => repeat({ facing }, 1, { shadow }));
const land = (): Frame[] => [{ pose: "default", offset: 1, poof: "dot" }, { pose: "default", offset: 1, poof: "wave" }];
const parts = (eyes: Eyes, arms: Arms = "down", feet: Feet = "both"): Parts => ({ eyes, arms, feet });
const blinkEnd: Frame[] = [...repeat(parts("closed"), 1), REST_FRAME];

const jump = [...land(), ...repeat("arms-up", 3), ...repeat("default", 1), ...land(), ...repeat("arms-up", 3), ...repeat("default", 1)];
export const ANIMATIONS = {
  jump,
  look: [...repeat("look-right", 5), ...repeat("look-left", 5), ...repeat("default", 1)],
  celebrate: [...jump, ...repeat("default", 3, { offset: 1 })],
  skip: [...repeat("default", 1, { offset: 1, x: -AWAY }), ...repeat("arms-up", 2, { x: -6 }), ...repeat("default", 1, { x: -6 }),
    ...repeat("default", 1, { offset: 1, x: -6 }), ...repeat("arms-up", 2, { x: -3 }), ...repeat("default", 1, { x: -3 }),
    ...repeat("default", 1, { offset: 1, x: -3 }), ...repeat("arms-up", 2), ...land(), ...repeat("default", 1)],
  spin: [...repeat("look-left", 2), ...repeat("look-right", 2), ...repeat("look-left", 2), ...repeat("arms-up", 3), ...repeat("default", 1)],
  peekaboo: [...repeat("default", 1, { offset: CROUCH }), ...repeat("default", 3, { offset: 2 }), ...repeat("look-right", 3, { offset: 2 }),
    ...repeat("look-left", 3, { offset: 2 }), ...repeat("default", 2, { offset: 2 }), ...repeat("default", 1, { offset: 1 }),
    ...repeat("arms-up", 4), ...repeat("default", 2), ...blinkEnd],
  drop: [...repeat("arms-up", 1, { offset: -CROUCH }), ...repeat("arms-up", 2, { offset: -2 }), ...repeat("arms-up", 2, { offset: -1 }),
    ...repeat("arms-up", 1), ...land(), ...repeat("default", 3), ...blinkEnd],
  waddle: [...repeat("look-right", 1, { x: -AWAY }),
    ...[-6, -5, -4, -3, -2, -1].flatMap((x) => repeat(parts("right", "down", x % 2 === 0 ? "left" : "right"), 2, { x })),
    ...repeat("look-right", 2), ...repeat("default", 2), ...blinkEnd],
  peek: [...repeat("look-right", 1, { x: -AWAY }), ...repeat("look-right", 5, { x: -6 }), ...repeat("look-right", 3, { x: -AWAY }),
    ...repeat("look-right", 4, { x: -5 }), ...repeat("arms-up", 2, { x: -3 }), ...repeat("arms-up", 2), ...land(), REST_FRAME],
  wink: [...repeat(parts("wink"), 5), REST_FRAME],
  boop: [...repeat(parts("closed"), 1, { offset: 1, poof: "dot" }), ...repeat(parts("closed"), 2, { offset: 1, poof: "wave" }),
    ...repeat("look-left", 4), ...repeat("default", 2), ...blinkEnd],
  tap: [...repeat(parts("open", "down", "left"), 2), ...repeat(parts("open", "down", "right"), 2), ...repeat(parts("open", "down", "left"), 2),
    ...repeat(parts("open", "down", "right"), 2), ...repeat(parts("open", "down", "left"), 1), ...repeat(parts("open", "down", "right"), 1),
    ...repeat("arms-up", 3), REST_FRAME],
  sneeze: [...repeat(parts("closed", "up"), 4), ...repeat(parts("closed"), 2, { offset: 1, poof: "wave" }), ...repeat(parts("closed"), 2),
    ...repeat("default", 2), ...blinkEnd],
  turn: [...turning(["right-12", "right-30", "right-55", "right-75", "edge"]), ...turning(["back-105", "back-125", "back-150", "back", "back"]),
    ...turning(["back-150", "back-125", "back-105", "edge"]), ...turning(["left-75", "left-55", "left-30", "left-12"]), REST_FRAME],
  "coin-hop": [...repeat("default", 2, { offset: 1 }), ...repeat("arms-up", 1, { shadow: "wide" }),
    ...turning(["right-55", "edge", "back-125", "back"], "narrow"), ...turning(["back-125", "edge", "left-55"], "narrow"),
    ...repeat("arms-up", 1, { shadow: "wide" }), ...land(), REST_FRAME],
} satisfies Record<string, Frame[]>;
export type AnimationName = keyof typeof ANIMATIONS;
/** The CLI's entrance picks (`ou`), and the ones a click can play: those that start in place (`nu`). */
export const ENTRANCES: AnimationName[] = ["skip", "jump", "look", "spin", "peekaboo", "drop", "waddle", "peek", "wink", "boop", "tap", "sneeze", "turn", "coin-hop"];
export const CLICKABLE: AnimationName[] = ENTRANCES.filter((name) => (ANIMATIONS[name][0]?.x ?? 0) === 0);

/** Which quadrants of a cell a block glyph fills: upper-left, upper-right, lower-left, lower-right. */
const QUADRANTS: Record<string, [number, number, number, number]> = {
  "█": [1, 1, 1, 1], "▀": [1, 1, 0, 0], "▄": [0, 0, 1, 1], "▌": [1, 0, 1, 0], "▐": [0, 1, 0, 1],
  "▘": [1, 0, 0, 0], "▝": [0, 1, 0, 0], "▖": [0, 0, 1, 0], "▗": [0, 0, 0, 1],
  "▛": [1, 1, 1, 0], "▜": [1, 1, 0, 1], "▙": [1, 0, 1, 1], "▟": [0, 1, 1, 1], "▚": [1, 0, 0, 1], "▞": [0, 1, 1, 0],
};

type Cell = { col: number; row: number; glyph: string; color: string; background?: string };

/** One run of glyphs from `column`, as the CLI's `N`: eye spans sit on the background colour, a lid inverts it. */
function run(cells: Cell[], glyphs: string, column: number, row: number, color: string, on?: "eyes" | "lid") {
  Array.from(glyphs).forEach((glyph, index) => {
    if (glyph === " " && !on) return;
    cells.push(on === "lid" ? { col: column + index, row, glyph, color: CLAWD_BACKGROUND, background: color }
      : { col: column + index, row, glyph, color, background: on === "eyes" ? CLAWD_BACKGROUND : undefined });
  });
}

/** The cells of a pose, laid out as the CLI's `aEe` (or `ae` for a turning frame). */
export function clawdCells(pose: Pose, color = CLAWD_BODY): Cell[] {
  const cells: Cell[] = [];
  if (typeof pose !== "string" && "facing" in pose) {
    FACINGS[pose.facing].forEach(({ glyphs, from, to }, row) => {
      Array.from(glyphs).forEach((glyph, col) => {
        const backed = col >= from && col < to;
        if (glyph !== " " || backed) cells.push({ col, row, glyph, color, background: backed ? CLAWD_BACKGROUND : undefined });
      });
    });
    return cells;
  }
  const { eyes, arms, feet } = typeof pose === "string" ? POSES[pose] : pose;
  const limbs = ARMS[arms];
  run(cells, limbs.r1L, 0, 0, color);
  let column = 2;
  for (const span of EYES[eyes]) { run(cells, span.glyphs, column, 0, color, span.lid ? "lid" : "eyes"); column += span.glyphs.length; }
  run(cells, limbs.r1R, 8, 0, color);
  run(cells, limbs.r2L, 0, 1, color);
  run(cells, "█████", 2, 1, color, "eyes");
  run(cells, limbs.r2R, 7, 1, color);
  run(cells, FEET[feet], 0, 2, color);
  return cells;
}

/** A cell's shapes in viewBox units (a cell is 2×4: quadrants are 1×2). */
function shapes(cell: Cell) {
  const x = cell.col * 2, y = cell.row * 4;
  const out: { x: number; y: number; w: number; h: number; fill: string }[] = [];
  if (cell.background) out.push({ x, y, w: 2, h: 4, fill: cell.background });
  if (cell.glyph === "▂") out.push({ x, y: y + 3, w: 2, h: 1, fill: cell.color });
  else if (cell.glyph === "▁") out.push({ x, y: y + 3.5, w: 2, h: 0.5, fill: cell.color });
  else {
    const q = QUADRANTS[cell.glyph];
    if (q) q.forEach((on, index) => { if (on) out.push({ x: x + (index % 2), y: y + (index < 2 ? 0 : 2), w: 1, h: 2, fill: cell.color }); });
  }
  return out;
}

/** Clawd in one pose, drawn crisp: 72×48 px. */
export function ClawdGlyphs({ pose, color }: { pose: Pose; color?: string }) {
  const rects = clawdCells(pose, color).flatMap(shapes);
  return <svg className="cx-clawd-glyphs" viewBox={`0 0 ${COLS * 2} ${ROWS * 4}`} width={COLS * CELL_W} height={ROWS * CELL_H}
    shapeRendering="crispEdges" aria-hidden="true">
    {rects.map((r, index) => <rect key={index} x={r.x} y={r.y} width={r.w} height={r.h} fill={r.fill} />)}
  </svg>;
}

/**
 * One frame in Clawd's box, as the CLI's `Yke`: the box is 9×3 cells and clips, so a crouch (offset 1)
 * sinks the feet out of sight, peekaboo rises from the ground and a skip comes in from the left. A
 * landing puffs a dot or a wave either side; a hop casts a shadow.
 */
export function ClawdFrame({ frame, color }: { frame: Frame; color?: string }) {
  return <span className="cx-clawd" style={{ width: COLS * CELL_W, height: ROWS * CELL_H }}>
    <span className="cx-clawd-sprite" style={{ transform: `translate(${(frame.x ?? 0) * CELL_W}px, ${frame.offset * CELL_H}px)` }}>
      <ClawdGlyphs pose={frame.pose} color={color} />
    </span>
    {frame.poof && frame.offset > 0 ? <>
      <span className="cx-clawd-mark" style={{ top: (ROWS - 1) * CELL_H, left: 0 }}>{frame.poof === "dot" ? "·" : "~"}</span>
      <span className="cx-clawd-mark" style={{ top: (ROWS - 1) * CELL_H, right: 0 }}>{frame.poof === "dot" ? "·" : "~"}</span>
    </> : null}
    {frame.shadow ? <span className="cx-clawd-mark" style={{ top: (ROWS - 1) * CELL_H, left: (frame.shadow === "wide" ? 3 : 4) * CELL_W }}>
      {frame.shadow === "wide" ? "▁▁▁" : "▁"}</span> : null}
  </span>;
}

/**
 * Plays the CLI's animations: `play(name)` steps through its frames every 60 ms, then hands back to
 * the caller's resting frame. Reduced motion plays nothing.
 */
export function useClawdPlayer(still: boolean) {
  const [state, setState] = useState<{ frames: Frame[]; index: number } | null>(null);
  const done = useRef<(() => void) | undefined>(undefined);
  useEffect(() => {
    if (!state) return undefined;
    if (state.index >= state.frames.length) {
      setState(null);
      const finish = done.current;
      done.current = undefined;
      finish?.();
      return undefined;
    }
    const timer = window.setTimeout(() => setState((current) => current && { ...current, index: current.index + 1 }), FRAME_MS);
    return () => window.clearTimeout(timer);
  }, [state]);
  const play = (name: AnimationName, then?: () => void) => {
    if (still) { then?.(); return; }
    done.current = then;
    setState({ frames: ANIMATIONS[name], index: 0 });
  };
  const stop = () => { done.current = undefined; setState(null); };
  const frame = state && state.index < state.frames.length ? state.frames[state.index]! : null;
  return { frame, playing: frame !== null, play, stop };
}

export const pickOne = <T,>(items: readonly T[]) => items[Math.floor(Math.random() * items.length)]!;
