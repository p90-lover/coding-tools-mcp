import { useEffect, useRef, useState, type RefObject } from "react";
import { createPortal } from "react-dom";
import type { ChatAnnotation } from "./ao-chat";

// Annotations, as Codex has them: select words in an answer and an "Add to chat" bar pops up over
// them; adding one marks the words with a number and opens a small box for an optional comment.
// The composer shows "N annotations" (hover for the list, edit or remove each), and the message
// goes out with them in Codex's own format (chatMessageWithAnnotations).

/** An annotation not sent yet; `id` ties it to its live range in the transcript. */
export type DraftAnnotation = ChatAnnotation & { id: number };

// The selected words of each annotation as a live DOM Range, by id: they draw its highlight and
// place its number. Outside React state, since a Range is a live DOM object.
const RANGES = new Map<number, Range>();
const HIGHLIGHT = "cx-annotation";
/** The longest selection kept; a whole answer selected is still context, not a quote to resend. */
const MAX_TEXT = 4000;

type Highlights = { set(name: string, value: unknown): void; delete(name: string): void };
const highlightApi = (): { registry: Highlights; Highlight: new (...ranges: Range[]) => unknown } | null => {
  const registry = (globalThis as unknown as { CSS?: { highlights?: Highlights } }).CSS?.highlights;
  const Highlight = (globalThis as unknown as { Highlight?: new (...ranges: Range[]) => unknown }).Highlight;
  return registry && Highlight ? { registry, Highlight } : null;
};

/** Whether a node is answer text the person may annotate: in the thread, not a control or the composer. */
function annotatable(root: HTMLElement, node: Node | null) {
  const element = node instanceof Element ? node : node?.parentElement;
  return Boolean(element && root.contains(element) && !element.closest("textarea, input, button, .cx-composer, .cx-annotation-ui"));
}

export function SelectionAnnotator({ root, annotations, onAdd, onComment }: {
  /** The transcript the person selects in. */
  root: RefObject<HTMLElement | null>;
  annotations: DraftAnnotation[];
  /** Adds the selected text as an annotation and returns its id. */
  onAdd: (text: string) => number;
  onComment: (id: number, comment: string) => void;
}) {
  const [offer, setOffer] = useState<{ text: string; range: Range } | null>(null);
  const [editing, setEditing] = useState<{ id: number; draft: string } | null>(null);
  // Bumped when anything moves (a scroll, a resize, the transcript growing): positions are read again.
  const [, setLayout] = useState(0);

  // A selection made in the transcript offers "Add to chat"; any other selection, or none, hides it.
  useEffect(() => {
    const check = () => {
      const area = root.current, selection = window.getSelection();
      if (!area || !selection || selection.isCollapsed || !selection.rangeCount) { setOffer(null); return; }
      const range = selection.getRangeAt(0);
      const text = selection.toString().trim();
      if (!text || !annotatable(area, range.startContainer) || !annotatable(area, range.endContainer)) { setOffer(null); return; }
      setOffer({ text: text.slice(0, MAX_TEXT), range: range.cloneRange() });
    };
    const onUp = (event: MouseEvent) => {
      if (event.target instanceof Element && event.target.closest(".cx-annotation-ui")) return;
      window.setTimeout(check, 0);
    };
    const onKey = (event: KeyboardEvent) => { if (event.shiftKey || event.key === "Shift") check(); };
    const onChange = () => { const selection = window.getSelection(); if (!selection || selection.isCollapsed) setOffer(null); };
    document.addEventListener("mouseup", onUp);
    document.addEventListener("keyup", onKey);
    document.addEventListener("selectionchange", onChange);
    return () => {
      document.removeEventListener("mouseup", onUp);
      document.removeEventListener("keyup", onKey);
      document.removeEventListener("selectionchange", onChange);
    };
  }, [root]);

  // The added words stay highlighted, and positions follow the transcript as it scrolls and grows.
  useEffect(() => {
    const ids = new Set(annotations.map((item) => item.id));
    for (const id of RANGES.keys()) if (!ids.has(id)) RANGES.delete(id);
    const api = highlightApi();
    const live = annotations.map((item) => RANGES.get(item.id)).filter((range): range is Range => Boolean(range && !range.collapsed));
    if (api) { if (live.length) api.registry.set(HIGHLIGHT, new api.Highlight(...live)); else api.registry.delete(HIGHLIGHT); }
    setLayout((value) => value + 1);
  }, [annotations]);
  useEffect(() => {
    const area = root.current;
    if (!area || (!annotations.length && !offer && !editing)) return undefined;
    let frame = 0;
    const relayout = () => { if (!frame) frame = window.requestAnimationFrame(() => { frame = 0; setLayout((value) => value + 1); }); };
    window.addEventListener("scroll", relayout, true);
    window.addEventListener("resize", relayout);
    const observer = new MutationObserver(relayout);
    observer.observe(area, { childList: true, subtree: true, characterData: true });
    return () => {
      window.removeEventListener("scroll", relayout, true);
      window.removeEventListener("resize", relayout);
      observer.disconnect();
      if (frame) window.cancelAnimationFrame(frame);
    };
  }, [root, annotations.length, Boolean(offer), Boolean(editing)]);
  useEffect(() => () => { highlightApi()?.registry.delete(HIGHLIGHT); }, []);

  const area = root.current;
  if (!area) return null;
  const bounds = area.getBoundingClientRect();
  const visible = (rect: DOMRect) => rect.bottom > bounds.top && rect.top < bounds.bottom && (rect.width > 0 || rect.height > 0);

  const add = () => {
    if (!offer) return;
    const id = onAdd(offer.text);
    RANGES.set(id, offer.range);
    window.getSelection()?.removeAllRanges();
    setOffer(null);
    setEditing({ id, draft: "" });
  };
  const save = () => {
    if (!editing) return;
    onComment(editing.id, editing.draft.trim());
    setEditing(null);
  };

  // Each annotation's number sits at the end of its words, as in Codex.
  const marks = annotations.flatMap((item, index) => {
    const range = RANGES.get(item.id);
    if (!range || range.collapsed || !range.startContainer.isConnected) return [];
    const rects = range.getClientRects();
    const last = rects[rects.length - 1];
    return last && visible(last) ? [{ id: item.id, number: index + 1, x: last.right, y: last.top + last.height / 2 }] : [];
  });
  const offerRect = offer?.range.getBoundingClientRect();
  const editRange = editing ? RANGES.get(editing.id) : undefined;
  const editRect = editRange && !editRange.collapsed ? editRange.getBoundingClientRect() : undefined;
  const host = area.closest(".ao-workflow") ?? document.body;
  const clampX = (x: number, width: number) => Math.max(8, Math.min(window.innerWidth - width - 8, x));

  return createPortal(<>
    {marks.map((mark) => <span key={mark.id} className="cx-annotation-mark cx-annotation-ui" aria-hidden="true"
      style={{ left: mark.x, top: mark.y }}>{mark.number}</span>)}
    {offer && offerRect && visible(offerRect) ? <div className="cx-selection-bar cx-annotation-ui" role="toolbar" aria-label="Selected text"
      // Above the words, or below them when they sit at the top of the transcript (30px bar, 8px gap).
      style={{ left: clampX(offerRect.left + offerRect.width / 2 - 50, 100), top: offerRect.top > bounds.top + 44 ? offerRect.top - 38 : offerRect.bottom + 8 }}
      // Pressing on the bar must not clear the selection it acts on.
      onMouseDown={(event) => event.preventDefault()}>
      <button type="button" onClick={add}>Add to chat</button>
    </div> : null}
    {editing ? <form className="cx-annotation-editor cx-annotation-ui"
      style={{ left: clampX((editRect?.left ?? bounds.left + 24), 294), top: Math.min(window.innerHeight - 56, (editRect?.bottom ?? bounds.bottom - 60) + 6) }}
      // React events cross portals: an Enter here must not also submit the chat box it sits under.
      onSubmit={(event) => { event.preventDefault(); event.stopPropagation(); save(); }}>
      <input autoFocus aria-label="Note" placeholder="Add an optional comment…" value={editing.draft} maxLength={2000}
        onChange={(event) => setEditing({ ...editing, draft: event.target.value })}
        onKeyDown={(event) => { if (event.key === "Escape") { event.preventDefault(); setEditing(null); } }}
        onBlur={save} />
      <button type="submit" aria-label="Save note" onMouseDown={(event) => event.preventDefault()}>
        <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true"><path d="M6 10V2M2.5 5.5L6 2l3.5 3.5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" /></svg>
      </button>
    </form> : null}
  </>, host);
}

const plural = (count: number) => `${count} annotation${count === 1 ? "" : "s"}`;

/** The composer's "N annotations" chip; hovering it lists them, each with edit and remove. */
export function AnnotationTray({ annotations, onComment, onRemove, onClear }: {
  annotations: DraftAnnotation[];
  onComment: (id: number, comment: string) => void;
  onRemove: (id: number) => void;
  onClear: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<{ id: number; draft: string } | null>(null);
  const closer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(closer.current), []);
  if (!annotations.length) return null;
  const show = () => { window.clearTimeout(closer.current); setOpen(true); };
  const hide = () => { closer.current = window.setTimeout(() => { if (!editing) setOpen(false); }, 180); };
  const finish = () => { if (editing) onComment(editing.id, editing.draft.trim()); setEditing(null); };
  return <div className="cx-annotation-tray cx-annotation-ui" onMouseEnter={show} onMouseLeave={hide} onFocus={show} onBlur={hide}>
    {open ? <ol className="cx-annotation-list" aria-label="Annotations">
      {annotations.map((item, index) => <li key={item.id}>
        <span className="cx-annotation-number">{index + 1}.</span>
        <div className="cx-annotation-body">
          <small>Selected text:</small>
          <span className="cx-annotation-quote">{item.text}</span>
          {editing?.id === item.id
            ? <input autoFocus aria-label={`Comment on annotation ${index + 1}`} placeholder="Add an optional comment…" value={editing.draft}
              onChange={(event) => setEditing({ id: item.id, draft: event.target.value })} onBlur={finish}
              onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); finish(); } else if (event.key === "Escape") { event.preventDefault(); setEditing(null); } }} />
            : item.comment ? <span className="cx-annotation-comment">{item.comment}</span> : null}
        </div>
        <button type="button" aria-label={`Edit annotation ${index + 1}`} title="Edit comment"
          onClick={() => setEditing({ id: item.id, draft: item.comment })}>
          <svg width="13" height="13" viewBox="0 0 16 16" aria-hidden="true"><path d="M10.5 2.5l3 3L6 13H3v-3z" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" /></svg>
        </button>
        <button type="button" aria-label={`Remove annotation ${index + 1}`} title="Remove"
          onClick={() => { onRemove(item.id); if (annotations.length === 1) setOpen(false); }}>
          <svg width="13" height="13" viewBox="0 0 16 16" aria-hidden="true"><path d="M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.7 8.5h5.6l.7-8.5" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" /></svg>
        </button>
      </li>)}
    </ol> : null}
    <span className="cx-annotation-chip">
      <button type="button" aria-expanded={open} onClick={() => setOpen((value) => !value)} title={plural(annotations.length)}>
        <svg width="12" height="12" viewBox="0 0 16 16" aria-hidden="true"><path d="M3 3h10v7H7l-3 3v-3H3z" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" /></svg>
        {plural(annotations.length)}
      </button>
      <button type="button" className="cx-annotation-clear" aria-label="Remove annotations attachment" onClick={() => { onClear(); setOpen(false); }}>
        <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true"><path d="M2 2l6 6M8 2l-6 6" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" /></svg>
      </button>
    </span>
  </div>;
}

/** A sent message's annotations, above its bubble: the count, and each one on hover. */
export function SentAnnotations({ annotations }: { annotations: ChatAnnotation[] }) {
  return <div className="cx-sent-annotations" title={annotations.map((item, index) => `${index + 1}. "${item.text.slice(0, 160)}"${item.comment ? ` — ${item.comment}` : ""}`).join("\n")}>
    <svg width="12" height="12" viewBox="0 0 16 16" aria-hidden="true"><path d="M3 3h10v7H7l-3 3v-3H3z" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" /></svg>
    {plural(annotations.length)}
  </div>;
}
