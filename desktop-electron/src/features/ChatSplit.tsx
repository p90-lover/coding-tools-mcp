import { useEffect, useRef, useState } from "react";
import type { CSSProperties, DragEvent as ReactDragEvent, KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent, ReactNode } from "react";
import {
  SPLIT_DRAG_TYPE, SPLIT_MIN_PX, SPLIT_ROW, clampRowSplit, defaultPlace, splitBadge, splitColumns, splitDropTarget, splitMaxColumns, splitWeights,
  type SplitBadge, type SplitDropTarget, type SplitPane,
} from "./chat-split";

/** A chat dragged from the sidebar: its project and id. */
export type DraggedChat = { workspaceId: string; taskId: string };

// The divider steps Claude Code's resize handles take from the keyboard (Shift: a larger step).
const KEY_STEP_PX = 8;
const KEY_STEP_LARGE_PX = 32;
// A press moves a divider only once the pointer has gone further than this.
const DRAG_THRESHOLD_PX = 3;
// A pane follows its grip only past this, so a click on the grip stays a click.
const MOVE_THRESHOLD_PX = 4;
// While a drag hovers the host, dragover arrives about every 50 ms; this long without one, the
// drag has ended somewhere that sent no dragend (dropped outside the window, a drag from outside).
const DRAG_IDLE_MS = 400;

/**
 * Claude Code's split view host: the window's own chat (children, the primary pane) and the other
 * panes in a grid of columns, each column one pane or a top and a bottom one. Dividers resize the
 * columns and the row split, a corner handle both; a chat dragged from the sidebar shows where it
 * would open; a pane dragged by its grip (or with Ctrl held) moves.
 */
export function ChatSplit({ children, panes, focused, onFocus, weights, onWeights, rowSplit, onRowSplit, maxColumns, onMaxColumns, onDropChat, onMovePane }: {
  children: ReactNode;
  panes: (SplitPane & { content: ReactNode })[];
  focused: string;
  onFocus: (id: string) => void;
  weights?: number[];
  onWeights?: (weights: number[]) => void;
  rowSplit: number;
  onRowSplit?: (value: number) => void;
  maxColumns: number;
  onMaxColumns?: (count: number) => void;
  /** A chat dropped on the grid: where (null: where a new pane goes). Not set: no drops here. */
  onDropChat?: (chat: DraggedChat, target: SplitDropTarget | null) => void;
  /** A pane (never the primary) dragged by its grip to a target. Not set: panes don't move. */
  onMovePane?: (id: string, target: SplitDropTarget) => void;
}) {
  const host = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  const [drop, setDrop] = useState<SplitBadge | null>(null);
  const dragIdle = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  // The moving pane's title, following the pointer (Claude Code's drag label).
  const [moveLabel, setMoveLabel] = useState<{ text: string; x: number; y: number } | null>(null);
  const [ctrlHeld, setCtrlHeld] = useState(false);
  const split = panes.length > 0;
  const columns = splitColumns(panes);
  const tracks = splitWeights(weights, columns, size.width);
  const total = tracks.reduce((sum, weight) => sum + weight, 0) || 1;
  const hasBelow = (col: number) => panes.some((pane) => pane.col === col && pane.row === 1);

  useEffect(() => {
    const element = host.current;
    if (!element || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(([entry]) => {
      const { width, height } = entry.contentRect;
      setSize({ width, height });
      onMaxColumns?.(splitMaxColumns(width));
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  // A drag that ends anywhere (dropped on the sidebar, cancelled with Esc) takes its badge along.
  useEffect(() => {
    if (!drop) return;
    const clear = () => setDrop(null);
    window.addEventListener("dragend", clear);
    window.addEventListener("drop", clear);
    return () => { window.removeEventListener("dragend", clear); window.removeEventListener("drop", clear); };
  }, [Boolean(drop)]);
  useEffect(() => () => clearTimeout(dragIdle.current), []);
  // Ctrl held over a split shows which panes can be moved by dragging anywhere on them.
  const movable = split && Boolean(onMovePane);
  useEffect(() => {
    if (!movable) return;
    const key = (event: KeyboardEvent) => setCtrlHeld(event.ctrlKey && !event.altKey);
    const off = () => setCtrlHeld(false);
    window.addEventListener("keydown", key);
    window.addEventListener("keyup", key);
    window.addEventListener("blur", off);
    return () => { window.removeEventListener("keydown", key); window.removeEventListener("keyup", key); window.removeEventListener("blur", off); setCtrlHeld(false); };
  }, [movable]);

  const targetAt = (event: { clientX: number; clientY: number }) => {
    const box = host.current!.getBoundingClientRect();
    return splitDropTarget({ x: event.clientX - box.left, y: event.clientY - box.top, width: box.width, height: box.height,
      weights: tracks, rowSplit, maxColumns });
  };

  /**
   * Claude Code's pane move: a press on a pane's grip, or anywhere on it with Ctrl held, drags the
   * pane; its title follows the pointer and the badge shows where it lands. Esc cancels.
   */
  const startMove = (id: string, event: ReactPointerEvent<HTMLElement>) => {
    if (!onMovePane || id === "main" || event.button !== 0) return;
    const element = event.currentTarget.closest<HTMLElement>(".cx-pane");
    if (!element || !host.current) return;
    event.preventDefault();
    const hostElement = host.current, pointerId = event.pointerId, start = { x: event.clientX, y: event.clientY };
    const text = element.querySelector(".cx-thread-head h2")?.textContent?.trim() || "New session";
    let moving = false;
    let target: SplitDropTarget | null = null;
    const finish = () => {
      window.removeEventListener("pointermove", move, true);
      window.removeEventListener("pointerup", release, true);
      window.removeEventListener("pointercancel", finish, true);
      window.removeEventListener("keydown", escape, true);
      delete hostElement.dataset.paneDragging;
      setMoveLabel(null);
      setDrop(null);
    };
    const move = (next: PointerEvent) => {
      if (next.pointerId !== pointerId) return;
      if (!moving) {
        if (Math.abs(next.clientX - start.x) < MOVE_THRESHOLD_PX && Math.abs(next.clientY - start.y) < MOVE_THRESHOLD_PX) return;
        moving = true;
        hostElement.dataset.paneDragging = id;
      }
      target = targetAt(next);
      setMoveLabel({ text, x: next.clientX, y: next.clientY });
      setDrop(target ? splitBadge(target, panes, tracks) : null);
    };
    const release = (next: PointerEvent) => {
      if (next.pointerId !== pointerId) return;
      const landed = moving ? target : null;
      finish();
      if (landed) onMovePane(id, landed);
    };
    const escape = (next: KeyboardEvent) => {
      if (next.key !== "Escape" || !moving) return;
      next.preventDefault();
      next.stopImmediatePropagation();
      finish();
    };
    window.addEventListener("pointermove", move, true);
    window.addEventListener("pointerup", release, true);
    window.addEventListener("pointercancel", finish, true);
    window.addEventListener("keydown", escape, true);
  };
  /** Where a drop with no target goes (a hint at the next free place, as Claude Code shows it). */
  const hintBadge = (): SplitBadge => {
    const place = defaultPlace(panes, maxColumns);
    const at = "replace" in place ? panes.find((pane) => pane.id === place.replace)! : place;
    const target: SplitDropTarget = at.col >= columns ? { kind: "column" } : { kind: "cell", col: at.col, row: at.row };
    return { ...splitBadge(target, panes, tracks), label: "Split view", hint: true };
  };
  const dragOver = onDropChat ? (event: ReactDragEvent<HTMLDivElement>) => {
    if (!Array.from(event.dataTransfer.types).includes(SPLIT_DRAG_TYPE)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
    const target = targetAt(event);
    const badge = target ? splitBadge(target, panes, tracks) : hintBadge();
    if (JSON.stringify(badge) !== JSON.stringify(drop)) setDrop(badge);
    clearTimeout(dragIdle.current);
    dragIdle.current = setTimeout(() => setDrop(null), DRAG_IDLE_MS);
  } : undefined;
  const dragLeave = (event: ReactDragEvent<HTMLDivElement>) => {
    if (!drop || (event.relatedTarget instanceof Node && host.current?.contains(event.relatedTarget))) return;
    setDrop(null);
  };
  const dropped = onDropChat ? (event: ReactDragEvent<HTMLDivElement>) => {
    const raw = event.dataTransfer.getData(SPLIT_DRAG_TYPE);
    setDrop(null);
    if (!raw) return;
    event.preventDefault();
    try {
      const chat = JSON.parse(raw) as DraggedChat;
      if (typeof chat?.taskId === "string" && chat.taskId && typeof chat.workspaceId === "string") onDropChat({ workspaceId: chat.workspaceId, taskId: chat.taskId }, targetAt(event));
    } catch { /* Not a chat this app dragged. */ }
  } : undefined;

  /** Moves the divider after column `index` by `px`, each side keeping 320 px. */
  const shiftColumn = (index: number, px: number, from: number[] = tracks) => {
    const least = (SPLIT_MIN_PX / Math.max(1, size.width)) * total;
    const units = (px / Math.max(1, size.width)) * total;
    const pair = from[index] + from[index + 1];
    if (pair - least < least) return;
    const next = [...from];
    next[index] = Math.min(pair - least, Math.max(least, from[index] + units));
    next[index + 1] = pair - next[index];
    onWeights?.(next);
  };
  const columnEdge = (index: number) => (100 * tracks.slice(0, index + 1).reduce((sum, weight) => sum + weight, 0)) / total;

  /** A divider between column `index` and the next: drag, arrows (8 px, Shift 32 px), Home/End, double-click resets. */
  const columnHandle = (index: number) => {
    const at = columnEdge(index);
    const shift = (px: number, from = tracks) => shiftColumn(index, px, from);
    const press = (event: ReactPointerEvent<HTMLDivElement>) => {
      if (event.button !== 0) return;
      const handle = event.currentTarget, start = event.clientX, from = [...tracks];
      let moving = false;
      handle.setPointerCapture(event.pointerId);
      const move = (next: PointerEvent) => {
        const dx = next.clientX - start;
        if (!moving && Math.abs(dx) <= DRAG_THRESHOLD_PX) return;
        moving = true;
        handle.dataset.dragging = "";
        shift(dx, from);
      };
      const end = () => {
        delete handle.dataset.dragging;
        handle.removeEventListener("pointermove", move);
        handle.removeEventListener("lostpointercapture", end);
      };
      handle.addEventListener("pointermove", move);
      handle.addEventListener("lostpointercapture", end);
    };
    const key = (event: ReactKeyboardEvent<HTMLDivElement>) => {
      const step = event.shiftKey ? KEY_STEP_LARGE_PX : KEY_STEP_PX;
      if (event.key === "ArrowLeft" || event.key === "ArrowRight") { event.preventDefault(); shift(event.key === "ArrowLeft" ? -step : step); }
      else if (event.key === "Home" || event.key === "End") { event.preventDefault(); shift(event.key === "Home" ? -size.width : size.width); }
    };
    return <div key={`col:${index}`} className="cx-split-resize is-col" role="separator" aria-orientation="vertical" aria-label="Resize pane columns"
      aria-valuenow={Math.round(at)} aria-valuemin={0} aria-valuemax={100} tabIndex={0} style={{ left: `${at}%` }}
      onPointerDown={press} onKeyDown={key} onDoubleClick={() => onWeights?.(tracks.map(() => 1))}>
      <span className="cx-split-pill" aria-hidden="true" />
    </div>;
  };
  /** The row divider of a column split top and bottom: one split for every column, as in Claude Code. */
  const rowHandle = (col: number) => {
    const left = (100 * tracks.slice(0, col).reduce((sum, weight) => sum + weight, 0)) / total;
    const set = (value: number) => onRowSplit?.(clampRowSplit(value, size.height));
    const press = (event: ReactPointerEvent<HTMLDivElement>) => {
      if (event.button !== 0) return;
      const handle = event.currentTarget, start = event.clientY, from = rowSplit;
      let moving = false;
      handle.setPointerCapture(event.pointerId);
      const move = (next: PointerEvent) => {
        const dy = next.clientY - start;
        if (!moving && Math.abs(dy) <= DRAG_THRESHOLD_PX) return;
        moving = true;
        handle.dataset.dragging = "";
        set(from + dy / Math.max(1, size.height));
      };
      const end = () => {
        delete handle.dataset.dragging;
        handle.removeEventListener("pointermove", move);
        handle.removeEventListener("lostpointercapture", end);
      };
      handle.addEventListener("pointermove", move);
      handle.addEventListener("lostpointercapture", end);
    };
    const key = (event: ReactKeyboardEvent<HTMLDivElement>) => {
      const step = (event.shiftKey ? KEY_STEP_LARGE_PX : KEY_STEP_PX) / Math.max(1, size.height);
      if (event.key === "ArrowUp" || event.key === "ArrowDown") { event.preventDefault(); set(rowSplit + (event.key === "ArrowUp" ? -step : step)); }
      else if (event.key === "Home" || event.key === "End") { event.preventDefault(); set(event.key === "Home" ? 0 : 1); }
    };
    return <div key={`row:${col}`} className="cx-split-resize is-row" role="separator" aria-orientation="horizontal" aria-label="Resize pane rows"
      aria-valuenow={Math.round(rowSplit * 100)} aria-valuemin={Math.round(SPLIT_ROW.MIN * 100)} aria-valuemax={Math.round(SPLIT_ROW.MAX * 100)} tabIndex={0}
      style={{ left: `${left}%`, width: `${(100 * tracks[col]) / total}%` }}
      onPointerDown={press} onKeyDown={key} onDoubleClick={() => onRowSplit?.(SPLIT_ROW.DEFAULT)}>
      <span className="cx-split-pill" aria-hidden="true" />
    </div>;
  };

  /**
   * Claude Code's corner handle, where the divider after column `index` meets a row divider beside
   * it: one drag moves both.
   */
  const cornerHandle = (index: number) => {
    const press = (event: ReactPointerEvent<HTMLDivElement>) => {
      if (event.button !== 0) return;
      const handle = event.currentTarget, start = { x: event.clientX, y: event.clientY }, from = [...tracks], fromRow = rowSplit;
      let moving = false;
      handle.setPointerCapture(event.pointerId);
      const move = (next: PointerEvent) => {
        const dx = next.clientX - start.x, dy = next.clientY - start.y;
        if (!moving && Math.abs(dx) <= DRAG_THRESHOLD_PX && Math.abs(dy) <= DRAG_THRESHOLD_PX) return;
        moving = true;
        handle.dataset.dragging = "";
        shiftColumn(index, dx, from);
        onRowSplit?.(clampRowSplit(fromRow + dy / Math.max(1, size.height), size.height));
      };
      const end = () => {
        delete handle.dataset.dragging;
        handle.removeEventListener("pointermove", move);
        handle.removeEventListener("lostpointercapture", end);
      };
      handle.addEventListener("pointermove", move);
      handle.addEventListener("lostpointercapture", end);
    };
    return <div key={`corner:${index}`} className="cx-split-corner" aria-hidden="true" style={{ left: `${columnEdge(index)}%` }}
      onPointerDown={press} onDoubleClick={() => { onWeights?.(tracks.map(() => 1)); onRowSplit?.(SPLIT_ROW.DEFAULT); }} />;
  };

  const pane = (id: string, col: number, row: 0 | 1, content: ReactNode) => <div key={id}
    className={`cx-pane${id === "main" ? "" : " cx-pane-extra"}`} data-col={col} data-row={row}
    role={split ? "region" : undefined} aria-label={split ? (id === "main" ? "Primary pane" : "Secondary pane") : undefined}
    aria-current={split && focused === id ? "true" : undefined} data-focused={focused === id ? "" : undefined}
    data-pane-immovable={split && (id === "main" || !onMovePane) ? "" : undefined}
    style={{ gridColumn: col + 1, gridRow: row === 1 ? 2 : hasBelow(col) ? 1 : "1 / span 2" }}
    onPointerDownCapture={() => { if (focused !== id) onFocus(id); }} onFocusCapture={() => { if (focused !== id) onFocus(id); }}
    onPointerDown={(event) => {
      // Ctrl+click keeps its meaning on links, buttons and fields (Ctrl+click a chat link, select a word).
      if (event.ctrlKey && !event.altKey && !(event.target as Element).closest?.("a, button, input, textarea, select, [contenteditable]")) startMove(id, event);
    }}>
    {content}
    {movable && id !== "main" ? <button type="button" aria-hidden="true" tabIndex={-1} className="cx-pane-grip" title="Move"
      onPointerDown={(event) => startMove(id, event)} onMouseDown={(event) => event.preventDefault()} /> : null}
  </div>;

  return <div ref={host} className="cx-split" data-split={split ? "" : undefined} data-ctrl-held={ctrlHeld ? "" : undefined}
    style={{ "--cx-col-tracks": tracks.map((weight) => `minmax(0, ${weight}fr)`).join(" "), "--cx-pane-row": rowSplit } as CSSProperties}
    onDragOver={dragOver} onDragLeave={dragLeave} onDrop={dropped}>
    {pane("main", 0, 0, children)}
    {panes.map((item) => pane(item.id, item.col, item.row, item.content))}
    {split ? tracks.slice(0, -1).map((_, index) => columnHandle(index)) : null}
    {split ? tracks.map((_, col) => hasBelow(col) ? rowHandle(col) : null) : null}
    {split ? tracks.slice(0, -1).map((_, index) => hasBelow(index) || hasBelow(index + 1) ? cornerHandle(index) : null) : null}
    {moveLabel ? <div className="cx-pane-drag-label" aria-hidden="true" style={{ transform: `translate(${moveLabel.x}px, ${moveLabel.y}px)` }}>
      <span>{moveLabel.text}</span>
    </div> : null}
    {drop ? <div className="cx-drop-overlay" aria-hidden="true">
      <div className="cx-drop-badge" data-hint={drop.hint ? "" : undefined} style={{
        left: `calc(${drop.left}% + 8px)`, width: `calc(${drop.width}% - 16px)`,
        top: drop.band === "bottom" ? "calc(var(--cx-pane-row) * 100% + 8px)" : 8,
        height: drop.band === "full" ? "calc(100% - 16px)" : drop.band === "top" ? "calc(var(--cx-pane-row) * 100% - 16px)" : "calc((1 - var(--cx-pane-row)) * 100% - 16px)",
      }}><span className="cx-drop-label">{drop.label}</span></div>
    </div> : null}
  </div>;
}
