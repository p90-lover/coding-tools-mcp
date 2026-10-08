import { ROLE_TITLE } from "./AgentOrchestratorTeam";
import { useLayoutEffect, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent, ReactNode } from "react";

export type CanvasNode = {
  id: string; task_id: string; role: string; state: string; parents: string[];
  x: number; y: number; positioned?: boolean; route: { model: string; harness_id?: string };
  settings?: { name?: string };
};
type Point = { x: number; y: number };
const width = 212;
const height = 76;
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

export function AgentOrchestratorCanvas({ nodes, levels, selectedId, busy, onSelect, onMove, onConnect, canConnect, onUnlink, canUnlink, onRemove, canRemove, describe, children }: {
  nodes: CanvasNode[]; levels: CanvasNode[][]; selectedId: string; busy: boolean;
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
  const current = useRef({ nodes, levels, canConnect, onMove });
  current.current = { nodes, levels, canConnect, onMove };
  const [parentId, setParentId] = useState("");
  const [dropTarget, setDropTarget] = useState("");
  const [draggingId, setDraggingId] = useState("");
  const [selected, setSelected] = useState(new Set(selectedId ? [selectedId] : []));
  const [notice, setNotice] = useState("");
  const noticeTimer = useRef(0);
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
    for (const node of current.current.nodes) for (const parent of node.parents) {
      const from = positions.current.get(parent), to = positions.current.get(node.id);
      if (!from || !to) continue;
      const x1 = from.x + width / 2, y1 = from.y + (heights.current.get(parent) || height), x2 = to.x + width / 2, y2 = to.y;
      const dragged = drag.current?.id ? positions.current.get(drag.current.id) : null;
      const influence = dragged ? Math.max(0, 1 - Math.hypot((x1 + x2) / 2 - dragged.x - width / 2, (y1 + y2) / 2 - dragged.y - height / 2) / 400) : 1;
      const bend = reducedMotion.current ? 0 : wind.current * influence;
      const reach = Math.max(60, Math.abs(y2 - y1) * .45);
      const shape = `M${x1},${y1} C${x1 + bend},${y1 + reach} ${x2 + bend},${y2 - reach} ${x2},${y2}`;
      const key = JSON.stringify([parent, node.id]);
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
    return () => {
      cancelAnimationFrame(frame.current); observer.disconnect();
      surface.removeEventListener("wheel", wheel); preference.removeEventListener("change", motionChanged);
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
  const move = (event: ReactPointerEvent) => {
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
      <svg className="ao-canvas-wires" aria-hidden="true">{nodes.flatMap(node => node.parents.flatMap(parent => [<path key={JSON.stringify([parent, node.id])}
        ref={element => { const key = JSON.stringify([parent, node.id]); if (element) paths.current.set(key, element); else paths.current.delete(key); }}
        className={["running", "reserved"].includes(node.state) ? "is-running" : ""} />,
        // A wide invisible twin makes the thin link easy to click.
        onUnlink ? <path key={`${JSON.stringify([parent, node.id])}#hit`} className="ao-wire-hit"
          ref={element => { const key = `${JSON.stringify([parent, node.id])}#hit`; if (element) paths.current.set(key, element); else paths.current.delete(key); }}
          onClick={() => { if (!busy) onUnlink(node.id, parent); }}><title>Click to remove this link</title></path> : null]))}</svg>
      {nodes.map(node => <div key={node.id} data-ao-node={node.id} ref={element => { if (element) elements.current.set(node.id, element); else elements.current.delete(node.id); }}
        className={`ao-canvas-card ao-node-${node.state}${selected.has(node.id) ? " is-selected" : ""}${draggingId && selected.has(node.id) ? " is-dragging" : ""}${dropTarget === node.id ? " is-target" : ""}`}>
        <button type="button" className="ao-card-handle" aria-label={`Edit ${node.settings?.name || node.role}, ${node.state}`}
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
          <span className="ao-card-title"><span className={`ao-dot ao-dot-${node.state}`} title={node.state} aria-hidden="true" />
            <strong>{node.settings?.name || ROLE_TITLE[node.role as keyof typeof ROLE_TITLE] || "Worker"}</strong>
            <span className="ao-canvas-state">{node.role === "reviewer" && node.state === "running" ? "reviewing" : node.state}</span></span>
          <span className="ao-card-route">{describe(node)}</span>
        </button>
        <button type="button" className="ao-port ao-port-in" aria-label={`Connect dependency to ${node.settings?.name || node.role}`}
          disabled={!parentId || !canConnect(node.id, parentId) || busy} onClick={() => { onConnect(node.id, parentId); setParentId(""); }}>●</button>
        <button type="button" className="ao-port ao-port-out" aria-label={`Connect from ${node.settings?.name || node.role}`}
          disabled={busy} aria-pressed={parentId === node.id} onClick={() => setParentId(parentId === node.id ? "" : node.id)}>●</button>
      </div>)}
    </div>
  </div>;
}
