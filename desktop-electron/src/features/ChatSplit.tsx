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

/**
 * Claude Code's split view host: the window's own chat (children, the primary pane) and the other
 * panes in a grid of columns, each column one pane or a top and a bottom one. Dividers resize the
 * columns and the row split; a chat dragged from the sidebar shows where it would open.
 */
export function ChatSplit({ children, panes, focused, onFocus, weights, onWeights, rowSplit, onRowSplit, maxColumns, onMaxColumns, onDropChat }: {
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
}) {
  const host = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  const [drop, setDrop] = useState<SplitBadge | null>(null);
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

  const targetAt = (event: ReactDragEvent<HTMLElement>) => {
    const box = host.current!.getBoundingClientRect();
    return splitDropTarget({ x: event.clientX - box.left, y: event.clientY - box.top, width: box.width, height: box.height,
      weights: tracks, rowSplit, maxColumns });
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

  /** A divider between column `index` and the next: drag, arrows (8 px, Shift 32 px), Home/End, double-click resets. */
  const columnHandle = (index: number) => {
    const at = (100 * tracks.slice(0, index + 1).reduce((sum, weight) => sum + weight, 0)) / total;
    const least = (SPLIT_MIN_PX / Math.max(1, size.width)) * total;
    const shift = (px: number, from = tracks) => {
      const units = (px / Math.max(1, size.width)) * total;
      const pair = from[index] + from[index + 1];
      const first = Math.min(pair - least, Math.max(least, from[index] + units));
      if (pair - least < least) return;
      const next = [...from];
      next[index] = first; next[index + 1] = pair - first;
      onWeights?.(next);
    };
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

  const pane = (id: string, col: number, row: 0 | 1, content: ReactNode) => <div key={id}
    className={`cx-pane${id === "main" ? "" : " cx-pane-extra"}`} data-col={col} data-row={row}
    role={split ? "region" : undefined} aria-label={split ? (id === "main" ? "Primary pane" : "Secondary pane") : undefined}
    aria-current={split && focused === id ? "true" : undefined} data-focused={focused === id ? "" : undefined}
    style={{ gridColumn: col + 1, gridRow: row === 1 ? 2 : hasBelow(col) ? 1 : "1 / span 2" }}
    onPointerDownCapture={() => { if (focused !== id) onFocus(id); }} onFocusCapture={() => { if (focused !== id) onFocus(id); }}>
    {content}
  </div>;

  return <div ref={host} className="cx-split" data-split={split ? "" : undefined}
    style={{ "--cx-col-tracks": tracks.map((weight) => `minmax(0, ${weight}fr)`).join(" "), "--cx-pane-row": rowSplit } as CSSProperties}
    onDragOver={dragOver} onDragLeave={dragLeave} onDrop={dropped}>
    {pane("main", 0, 0, children)}
    {panes.map((item) => pane(item.id, item.col, item.row, item.content))}
    {split ? tracks.slice(0, -1).map((_, index) => columnHandle(index)) : null}
    {split ? tracks.map((_, col) => hasBelow(col) ? rowHandle(col) : null) : null}
    {drop ? <div className="cx-drop-overlay" aria-hidden="true">
      <div className="cx-drop-badge" data-hint={drop.hint ? "" : undefined} style={{
        left: `calc(${drop.left}% + 8px)`, width: `calc(${drop.width}% - 16px)`,
        top: drop.band === "bottom" ? "calc(var(--cx-pane-row) * 100% + 8px)" : 8,
        height: drop.band === "full" ? "calc(100% - 16px)" : drop.band === "top" ? "calc(var(--cx-pane-row) * 100% - 16px)" : "calc((1 - var(--cx-pane-row)) * 100% - 16px)",
      }}><span className="cx-drop-label">{drop.label}</span></div>
    </div> : null}
  </div>;
}
