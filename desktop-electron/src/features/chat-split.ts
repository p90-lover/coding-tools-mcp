// Claude Code's split view (its desktop app's pane store and pane host): an adaptive grid of chats.
// The window's own chat is the primary pane, always at column 0, row 0; every other chat is a pane
// at a column and a row (0 the top, 1 below it). One column per 360 px of width, up to five.

export type PanePos = { col: number; row: 0 | 1 };
export type SplitPane = PanePos & { id: string; workspaceId: string; taskId: string };
export type SplitDropTarget = { kind: "column" } | { kind: "left" } | ({ kind: "cell" } & PanePos);
export type SplitBadge = { left: number; width: number; band: "full" | "top" | "bottom"; label: string; hint?: boolean };

export const SPLIT_MAX_COLUMNS = 5;
export const SPLIT_COLUMN_PX = 360;
export const SPLIT_MIN_PX = 320;
export const SPLIT_ROW = { MIN: 0.15, MAX: 0.85, DEFAULT: 0.5 };
/** What a dragged chat carries, beside its plain-text id (the sidebar's own reordering). */
export const SPLIT_DRAG_TYPE = "application/x-coding-tools-chat";
export const SPLIT_STORE = "coding-tools:ao:split-view";

/** Columns that fit a host this wide. */
export function splitMaxColumns(width: number): number {
  return Math.min(SPLIT_MAX_COLUMNS, Math.max(1, Math.floor(width / SPLIT_COLUMN_PX)));
}
export function splitColumns(panes: readonly PanePos[]): number {
  return panes.reduce((count, pane) => Math.max(count, pane.col + 1), 1);
}
export const paneOrder = (a: PanePos, b: PanePos) => a.col - b.col || a.row - b.row;
const taken = (panes: readonly PanePos[], col: number, row: number) => (col === 0 && row === 0) || panes.some((pane) => pane.col === col && pane.row === row);

/**
 * Where a pane opened from the menu or a click goes: a new column while one fits, then the first
 * column with a free bottom row, else in place of the last pane that holds a chat (or the last one).
 */
export function defaultPlace(panes: readonly SplitPane[], maxColumns: number): PanePos | { replace: string } {
  const columns = splitColumns(panes);
  if (columns < maxColumns) return { col: columns, row: 0 };
  for (let col = 0; col < columns; col++) if (!taken(panes, col, 1)) return { col, row: 1 };
  const ordered = [...panes].sort(paneOrder);
  return { replace: (ordered.filter((pane) => pane.taskId).at(-1) ?? ordered.at(-1))!.id };
}

/** "New session below": the focused pane's column gets a bottom row when it has none. */
export function belowPlace(panes: readonly SplitPane[], focused: PanePos, maxColumns: number): PanePos | { replace: string } {
  return taken(panes, focused.col, 1) ? defaultPlace(panes, maxColumns) : { col: focused.col, row: 1 };
}

/**
 * The grid after a pane left it: columns numbered without gaps, and a pane left alone at the
 * bottom of a column moves to its top. The primary column (0) always stays.
 */
export function normalizeSplit(panes: readonly SplitPane[]): SplitPane[] {
  const columns = Array.from(new Set([0, ...panes.map((pane) => pane.col)])).sort((a, b) => a - b);
  return panes.map((pane) => {
    const col = columns.indexOf(pane.col);
    const alone = col > 0 && pane.row === 1 && !panes.some((other) => other.col === pane.col && other.row === 0);
    return { ...pane, col, row: alone ? 0 : pane.row };
  });
}

/**
 * The grid after pane `id` was dragged by its grip to `target` (Claude Code's pane move): a new
 * column at the end, or a cell, trading places with the pane already there. null: no change (its
 * own cell, the primary's, or "left", which the window handles by making the chat its own).
 */
export function movePane(panes: readonly SplitPane[], id: string, target: SplitDropTarget): SplitPane[] | null {
  const moving = panes.find((pane) => pane.id === id);
  if (!moving || target.kind === "left") return null;
  const to: PanePos = target.kind === "column" ? { col: splitColumns(panes), row: 0 } : { col: target.col, row: target.row };
  if ((to.col === 0 && to.row === 0) || (to.col === moving.col && to.row === moving.row)) return null;
  const other = panes.find((pane) => pane.col === to.col && pane.row === to.row);
  const next = normalizeSplit(panes.map((pane) => pane.id === id ? { ...pane, ...to }
    : pane.id === other?.id ? { ...pane, col: moving.col, row: moving.row } : pane));
  return next.every((pane, index) => pane.col === panes[index].col && pane.row === panes[index].row) ? null : next;
}

/**
 * The grid after the chat already open in pane `id` was dragged from the sidebar onto `target`: it
 * opens there, in place of any chat in that cell (as a dropped chat does), and its old pane closes,
 * so the chat is still open once. null: no change (its own cell, the primary's, or "left", which
 * the window handles as a pane move).
 */
export function relocatePane(panes: readonly SplitPane[], id: string, target: SplitDropTarget): SplitPane[] | null {
  const moving = panes.find((pane) => pane.id === id);
  if (!moving || target.kind === "left") return null;
  const to: PanePos = target.kind === "column" ? { col: splitColumns(panes), row: 0 } : { col: target.col, row: target.row };
  if ((to.col === 0 && to.row === 0) || (to.col === moving.col && to.row === moving.row)) return null;
  const next = normalizeSplit(panes.filter((pane) => pane.id === id || pane.col !== to.col || pane.row !== to.row)
    .map((pane) => pane.id === id ? { ...pane, ...to } : pane));
  const same = next.length === panes.length && next.every((pane, index) => pane.col === panes[index].col && pane.row === panes[index].row);
  return same ? null : next;
}

/** Column weights for `count` columns: the saved ones while each column keeps 320 px, else equal. */
export function splitWeights(saved: readonly number[] | undefined, count: number, width: number): number[] {
  const even = Array.from({ length: count }, () => 1);
  if (!saved || saved.length !== count || saved.some((weight) => !(weight > 0))) return even;
  const total = saved.reduce((sum, weight) => sum + weight, 0);
  return width > 0 && saved.some((weight) => (weight / total) * width < SPLIT_MIN_PX) ? even : [...saved];
}

export function clampRowSplit(value: number, height: number): number {
  const least = Math.max(SPLIT_ROW.MIN, height > 0 ? SPLIT_MIN_PX / height : SPLIT_ROW.MIN);
  return Math.min(SPLIT_ROW.MAX, Math.max(Math.min(least, SPLIT_ROW.MAX), value));
}

/**
 * Where a chat dragged over the host would open (Claude Code's drop zones), from the pointer's
 * place in the host: the right half of the last column while a column still fits opens a new one;
 * the left band of the primary pane (16 px in, up to a third of it) puts the chat first; any other
 * cell is that cell, its top or bottom by the row split. The rest of the primary pane is no target.
 */
export function splitDropTarget(input: {
  x: number; y: number; width: number; height: number; weights: readonly number[]; rowSplit: number; maxColumns: number;
}): SplitDropTarget | null {
  const { x, y, width, height, weights, rowSplit, maxColumns } = input;
  if (x < 0 || y < 0 || x > width || y > height) return null;
  const total = weights.reduce((sum, weight) => sum + weight, 0) || 1;
  let left = 0, col = weights.length - 1;
  for (let index = 0; index < weights.length; index++) {
    const span = (weights[index] / total) * width;
    if (x < left + span) { col = index; break; }
    left += span;
  }
  const span = (weights[col] / total) * width;
  const columns = weights.length;
  if (col === columns - 1 && columns < maxColumns && x >= left + span / 2) return { kind: "column" };
  const row = y >= height * rowSplit ? 1 : 0;
  if (col !== 0 || row !== 0) return { kind: "cell", col, row };
  return columns < maxColumns && x >= left + 16 && x < left + span / 3 ? { kind: "left" } : null;
}

/**
 * The badge a drop target shows over the grid, in percent of the host: 8 px inside the cell it
 * opens in. "Open here" when a chat is already there, "Split view" for a new or empty cell.
 */
export function splitBadge(target: SplitDropTarget, panes: readonly SplitPane[], weights: readonly number[]): SplitBadge {
  const total = weights.reduce((sum, weight) => sum + weight, 0) || 1;
  const columns = weights.length;
  if (target.kind === "column") return { left: (100 * columns) / (columns + 1), width: 100 / (columns + 1), band: "full", label: "Split view" };
  if (target.kind === "left") return { left: 0, width: 100 / (columns + 1), band: "full", label: "Split view" };
  const left = (100 * weights.slice(0, target.col).reduce((sum, weight) => sum + weight, 0)) / total;
  const width = (100 * weights[target.col]) / total;
  const hasBelow = panes.some((pane) => pane.col === target.col && pane.row === 1);
  const filled = (target.col === 0 && target.row === 0) || panes.some((pane) => pane.col === target.col && pane.row === target.row);
  return { left, width, band: target.row === 1 ? "bottom" : hasBelow ? "top" : "full", label: filled ? "Open here" : "Split view" };
}

/** Panes in the order Ctrl+] and Ctrl+[ step through them: the primary first, then by column and row. */
export function focusOrder(panes: readonly SplitPane[]): string[] {
  return ["main", ...[...panes].sort(paneOrder).map((pane) => pane.id)];
}

/** The pane beside `from` in a direction (Ctrl+Alt+Arrow), or undefined. */
export function spatialNeighbour(panes: readonly SplitPane[], from: string, direction: "left" | "right" | "up" | "down"): string | undefined {
  const all: (PanePos & { id: string })[] = [{ id: "main", col: 0, row: 0 }, ...panes];
  const here = all.find((pane) => pane.id === from);
  if (!here) return undefined;
  if (direction === "up" || direction === "down") {
    return all.find((pane) => pane.col === here.col && pane.row === (direction === "down" ? 1 : 0) && pane.id !== here.id)?.id;
  }
  const col = here.col + (direction === "right" ? 1 : -1);
  return (all.find((pane) => pane.col === col && pane.row === here.row) ?? all.find((pane) => pane.col === col && pane.row === 0))?.id;
}

/** What the split view keeps between runs: panes that hold a chat (new, unsent chats are not kept). */
export type SplitSaved = { panes: Omit<SplitPane, "id">[]; weights?: number[]; rowSplit?: number };
export function readSplit(raw: string | null): SplitSaved {
  try {
    const value = JSON.parse(raw || "null") as Partial<SplitSaved> | null;
    const panes: Omit<SplitPane, "id">[] = [];
    for (const pane of Array.isArray(value?.panes) ? value!.panes : []) {
      if (!pane || typeof pane.workspaceId !== "string" || typeof pane.taskId !== "string" || !pane.taskId) continue;
      const row = pane.row === 1 ? 1 : 0;
      // A cell is held once (never the primary's), and a chat is open in one pane only.
      if (!Number.isInteger(pane.col) || pane.col < 0 || pane.col >= SPLIT_MAX_COLUMNS || (pane.col === 0 && row === 0)) continue;
      if (panes.some((other) => (other.col === pane.col && other.row === row) || other.taskId === pane.taskId)) continue;
      panes.push({ workspaceId: pane.workspaceId, taskId: pane.taskId, col: pane.col, row });
    }
    return {
      panes,
      weights: Array.isArray(value?.weights) && value!.weights.every((weight) => typeof weight === "number" && weight > 0) ? value!.weights : undefined,
      rowSplit: typeof value?.rowSplit === "number" ? Math.min(SPLIT_ROW.MAX, Math.max(SPLIT_ROW.MIN, value.rowSplit)) : undefined,
    };
  } catch { return { panes: [] }; }
}
