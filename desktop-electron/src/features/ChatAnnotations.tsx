import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import type { ChatAnnotation } from "./ao-chat";
import { FloatingLayer } from "./ChatMenu";
import { annotationBounds, annotationPosition } from "./annotation-layout";
import { useSurfaceHidden } from "./page-visibility";

// Annotations, as Codex has them: select words in an answer and an "Add to chat" bar pops up over
// them; adding one marks the words with a number and opens a small box for an optional comment.
// The composer shows "N annotations" (hover for the list, edit or remove each), and the message
// goes out with them in Codex's own format (chatMessageWithAnnotations).

/**
 * An annotation not sent yet. `id` ties it to its live range; `anchor` says where its words are (the
 * nth answer in the transcript, character offsets in it), so the range is found again after the
 * transcript re-renders, or when the chat is left and opened again.
 */
export type DraftAnnotation = ChatAnnotation & { id: number; anchor?: { answer: number; start: number; end: number } };

// The selected words of each annotation as a live DOM Range, by id: they draw its highlight and
// place its number. Outside React state, since a Range is a live DOM object. Entries outlive a chat
// switch (their annotations come back with the chat) and are rebuilt from anchors when stale.
const RANGES = new Map<number, Range>();
const HIGHLIGHT = "cx-annotation";
// Each chat's highlighted words, by chat: split view shows several chats, and one chat setting the
// shared highlight to its own words alone erased the others'.
const LIVE_RANGES = new Map<object, Range[]>();
function paintHighlights() {
  const api = highlightApi();
  if (!api) return;
  const all = [...LIVE_RANGES.values()].flat();
  if (all.length) api.registry.set(HIGHLIGHT, new api.Highlight(...all)); else api.registry.delete(HIGHLIGHT);
}
/** The longest selection kept; a whole answer selected is still context, not a quote to resend. */
const MAX_TEXT = 4000;
/**
 * What an answer is: the turn's final answer, a DeepSeek reply, or an agent message in the live
 * work list. The person's own messages, reasoning, tool output and status text are not answers.
 */
const ANSWER = ".cx-answer, .dsh-reply, .cx-live-item.kind-message";

type Highlights = { set(name: string, value: unknown): void; delete(name: string): void };
const highlightApi = (): { registry: Highlights; Highlight: new (...ranges: Range[]) => unknown } | null => {
  const registry = (globalThis as unknown as { CSS?: { highlights?: Highlights } }).CSS?.highlights;
  const Highlight = (globalThis as unknown as { Highlight?: new (...ranges: Range[]) => unknown }).Highlight;
  return registry && Highlight ? { registry, Highlight } : null;
};

/** The answer a node belongs to, inside the transcript, or null (controls never count). */
function answerOf(root: HTMLElement, node: Node | null): Element | null {
  const element = node instanceof Element ? node : node?.parentElement;
  if (!element || !root.contains(element) || element.closest("textarea, input, button, .cx-annotation-ui")) return null;
  const answer = element.closest(ANSWER);
  return answer && root.contains(answer) ? answer : null;
}

/** A range over characters [start, end) of an element's text. */
function rangeAt(container: Element, start: number, end: number): Range | null {
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
  const range = document.createRange();
  let seen = 0, began = false;
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const length = node.textContent?.length ?? 0;
    if (!began && start <= seen + length) { range.setStart(node, start - seen); began = true; }
    if (began && end <= seen + length) { range.setEnd(node, end - seen); return range; }
    seen += length;
  }
  return null;
}

/** The annotation's words as a live range: the one made when it was added, or one found again. */
function rangeFor(root: HTMLElement, item: DraftAnnotation): Range | null {
  const kept = RANGES.get(item.id);
  if (kept && !kept.collapsed && kept.startContainer.isConnected && root.contains(kept.startContainer)) return kept;
  if (!item.anchor) return null;
  const answers = [...root.querySelectorAll(ANSWER)];
  const quote = item.text.replace(/\s+/g, " ").trim();
  const matches = (range: Range | null) => Boolean(range && range.toString().replace(/\s+/g, " ").trim() === quote);
  // Where it was, then anywhere in that answer, then in any answer (the transcript may have grown).
  let found = answers[item.anchor.answer] ? rangeAt(answers[item.anchor.answer], item.anchor.start, item.anchor.end) : null;
  if (!matches(found)) {
    found = null;
    for (const answer of [answers[item.anchor.answer], ...answers].filter(Boolean)) {
      const at = answer.textContent?.indexOf(item.text) ?? -1;
      if (at >= 0) { found = rangeAt(answer, at, at + item.text.length); break; }
    }
  }
  if (found) RANGES.set(item.id, found);
  return found;
}

export function SelectionAnnotator({ root, annotations, onAdd, onComment }: {
  /** The transcript the person selects in. */
  root: RefObject<HTMLElement | null>;
  annotations: DraftAnnotation[];
  /** Adds the selected text as an annotation (with where it is) and returns its id. */
  onAdd: (text: string, anchor?: DraftAnnotation["anchor"]) => number;
  onComment: (id: number, comment: string) => void;
}) {
  const hidden = useSurfaceHidden()();
  const [offer, setOffer] = useState<{ text: string; range: Range; anchor?: DraftAnnotation["anchor"] } | null>(null);
  const [editing, setEditing] = useState<{ id: number; draft: string } | null>(null);
  // Bumped when anything moves (a scroll, a resize, the transcript growing): positions are read again.
  const [, setLayout] = useState(0);
  // This chat's place in LIVE_RANGES.
  const highlightOwner = useRef({});

  // A selection made in the transcript offers "Add to chat"; any other selection, or none, hides it.
  useEffect(() => {
    const check = () => {
      const area = root.current, selection = window.getSelection();
      if (!area || !selection || selection.isCollapsed || !selection.rangeCount) { setOffer(null); return; }
      const range = selection.getRangeAt(0);
      const text = selection.toString().trim();
      // Words from one answer only: a selection running into a message of yours, a tool call or
      // another turn would be sent to the agent as text it had written.
      const answer = answerOf(area, range.startContainer);
      if (!text || !answer || answerOf(area, range.endContainer) !== answer) { setOffer(null); return; }
      const before = document.createRange();
      before.setStart(answer, 0);
      before.setEnd(range.startContainer, range.startOffset);
      const start = before.toString().length;
      const anchor = { answer: [...area.querySelectorAll(ANSWER)].indexOf(answer), start, end: start + range.toString().length };
      setOffer({ text: text.slice(0, MAX_TEXT), range: range.cloneRange(), anchor });
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

  // The added words stay highlighted (ranges found again after a re-render), and positions follow
  // the transcript as it scrolls and grows.
  useEffect(() => {
    const area = root.current;
    const api = highlightApi();
    if (!area || !api) return;
    // A chat with no annotation, and none drawn before, has no highlight to redraw on each render.
    if (!annotations.length && !LIVE_RANGES.get(highlightOwner.current)?.length) return;
    LIVE_RANGES.set(highlightOwner.current, annotations.map((item) => rangeFor(area, item)).filter((range): range is Range => Boolean(range)));
    paintHighlights();
  });
  useEffect(() => {
    // Kept ranges are bounded: the oldest go first (a gone one is found again from its anchor).
    if (RANGES.size > 200) for (const id of [...RANGES.keys()].slice(0, RANGES.size - 200)) RANGES.delete(id);
    setLayout((value) => value + 1);
  }, [annotations]);
  useEffect(() => {
    const area = root.current;
    if (hidden || !area || (!annotations.length && !offer && !editing)) return undefined;
    let frame = 0;
    const relayout = () => { if (!frame) frame = window.requestAnimationFrame(() => { frame = 0; setLayout((value) => value + 1); }); };
    window.addEventListener("scroll", relayout, true);
    window.addEventListener("resize", relayout);
    const observer = new MutationObserver(relayout);
    observer.observe(area, { childList: true, subtree: true, characterData: true });
    const resize = new ResizeObserver(relayout);
    resize.observe(area.closest(".cx-pane") ?? area);
    return () => {
      window.removeEventListener("scroll", relayout, true);
      window.removeEventListener("resize", relayout);
      observer.disconnect();
      resize.disconnect();
      if (frame) window.cancelAnimationFrame(frame);
    };
  }, [root, annotations.length, Boolean(offer), Boolean(editing), hidden]);
  useEffect(() => () => { LIVE_RANGES.delete(highlightOwner.current); paintHighlights(); }, []);

  const area = root.current;
  // Nothing to place, nothing read: the chat renders on every poll, each just after it changed the
  // transcript, so a bounds read here laid out the whole window each time (82k elements across five
  // panes: 7.4 s of the renderer's 10 s, with not one annotation).
  if (hidden || !area || (!annotations.length && !offer && !editing)) return null;
  const bounds = area.getBoundingClientRect();
  const paneBounds = annotationBounds(area);
  const visible = (rect: DOMRect) => rect.bottom > bounds.top && rect.top < bounds.bottom
    && rect.right > Math.max(bounds.left, paneBounds.left) && rect.left < Math.min(bounds.right, paneBounds.right)
    && bounds.width > 0 && bounds.height > 0 && (rect.width > 0 || rect.height > 0);

  const add = () => {
    if (!offer) return;
    const id = onAdd(offer.text, offer.anchor && offer.anchor.answer >= 0 ? offer.anchor : undefined);
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
    const range = rangeFor(area, item);
    if (!range) return [];
    const rects = range.getClientRects();
    const last = rects[rects.length - 1];
    return last && visible(last) ? [{ id: item.id, number: index + 1, x: Math.min(last.right, paneBounds.right - 28), y: Math.max(paneBounds.top + 16, Math.min(last.top + last.height / 2, paneBounds.bottom - 16)) }] : [];
  });
  const offerRect = offer?.range.getBoundingClientRect();
  const editItem = editing ? annotations.find((item) => item.id === editing.id) : undefined;
  const editRange = editItem ? rangeFor(area, editItem) : null;
  const editRect = editRange ? editRange.getBoundingClientRect() : undefined;
  const offerPosition = offerRect ? annotationPosition(offerRect, paneBounds, 100, 30) : undefined;
  const editPosition = annotationPosition(editRect ?? bounds, paneBounds, 294, 36, true);

  return <FloatingLayer className="cx-annotation-overlay" style={{}}>
    {marks.map((mark) => <span key={mark.id} className="cx-annotation-mark cx-annotation-ui" aria-hidden="true"
      style={{ left: mark.x, top: mark.y }}>{mark.number}</span>)}
    {offer && offerRect && visible(offerRect) ? <div className="cx-selection-bar cx-annotation-ui" role="toolbar" aria-label="Selected text"
      // Above the words, or below them when they sit at the top of the transcript (30px bar, 8px gap).
      style={offerPosition}
      // Pressing on the bar must not clear the selection it acts on.
      onMouseDown={(event) => event.preventDefault()}>
      <button type="button" onClick={add}>Add to chat</button>
    </div> : null}
    {editing && bounds.width > 0 && bounds.height > 0 ? <form className="cx-annotation-editor cx-annotation-ui"
      style={editPosition}
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
  </FloatingLayer>;
}

const plural = (count: number) => `${count} annotation${count === 1 ? "" : "s"}`;

/** Codex's attachment pill and numbered details, shared by drafts and sent messages. */
function AnnotationAttachment({ annotations, onComment, onRemove, onClear, sent = false }: {
  annotations: (ChatAnnotation & { id?: number })[];
  onComment?: (id: number, comment: string) => void;
  onRemove?: (id: number) => void;
  onClear?: () => void;
  sent?: boolean;
}) {
  const hidden = useSurfaceHidden()();
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<{ id: number; draft: string } | null>(null);
  const closer = useRef<number | undefined>(undefined);
  const tray = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLOListElement>(null);
  const [position, setPosition] = useState<ReturnType<typeof annotationPosition> | null>(null);
  useEffect(() => () => window.clearTimeout(closer.current), []);
  useLayoutEffect(() => {
    const anchor = tray.current;
    if (hidden || !open || !annotations.length || !anchor) return;
    let frame = 0;
    const place = () => {
      const rect = anchor.getBoundingClientRect(), bounds = annotationBounds(anchor);
      if (!rect.width || !rect.height || rect.bottom <= bounds.top || rect.top >= bounds.bottom
        || rect.right <= bounds.left || rect.left >= bounds.right) { setPosition(null); return; }
      const next = annotationPosition(rect, bounds, 384, Math.min(320, (list.current?.scrollHeight ?? 318) + 2));
      setPosition((old) => old && Object.keys(next).every((key) => old[key as keyof typeof old] === next[key as keyof typeof next]) ? old : next);
    };
    const relayout = () => { if (!frame) frame = requestAnimationFrame(() => { frame = 0; place(); }); };
    place();
    const observer = new ResizeObserver(relayout);
    observer.observe(anchor.closest(".cx-pane") ?? anchor);
    if (list.current) observer.observe(list.current);
    window.addEventListener("resize", relayout);
    window.addEventListener("scroll", relayout, true);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", relayout);
      window.removeEventListener("scroll", relayout, true);
      if (frame) cancelAnimationFrame(frame);
    };
  }, [open, annotations, Boolean(editing), Boolean(position), hidden]);
  if (hidden || !annotations.length) return null;
  const show = () => { window.clearTimeout(closer.current); setOpen(true); };
  const hide = () => { closer.current = window.setTimeout(() => { if (!editing) setOpen(false); }, 100); };
  const finish = () => {
    if (editing && annotations.some((item) => item.id === editing.id)) onComment?.(editing.id, editing.draft.trim());
    setEditing(null);
  };
  return <div ref={tray} className={`cx-annotation-tray cx-annotation-ui${sent ? " cx-sent-annotations" : ""}`}
    onMouseEnter={show} onMouseLeave={hide} onFocus={show}
    onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget) && !list.current?.contains(event.relatedTarget)) hide(); }}
    onKeyDown={(event) => { if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); setOpen(false); setEditing(null); } }}>
    {open && position ? <FloatingLayer className="cx-annotation-popover cx-annotation-ui" style={position} onMouseEnter={show} onMouseLeave={hide}>
      <ol ref={list} className="cx-annotation-list" aria-label="Annotations" style={{ maxHeight: position.maxHeight }}>
      {annotations.map((item, index) => <li key={item.id ?? index}>
        <span className="cx-annotation-number">{index + 1}.</span>
        <div className="cx-annotation-body">
          <div><small>Selected text:</small><span className="cx-annotation-quote">{item.text}</span></div>
          {editing && editing.id === item.id
            ? <input autoFocus aria-label={`Comment on annotation ${index + 1}`} placeholder="Add an optional comment…" value={editing.draft} maxLength={2000}
              onChange={(event) => setEditing({ id: editing.id, draft: event.target.value })} onBlur={finish}
              onKeyDown={(event) => {
                if (event.key === "Enter") { event.preventDefault(); event.stopPropagation(); finish(); }
                else if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); setEditing(null); }
              }} />
            : item.comment ? <div><small>User comment:</small><span className="cx-annotation-comment">{item.comment}</span></div> : null}
        </div>
        {onComment ? <button type="button" aria-label={`Edit annotation ${index + 1}`} title="Edit comment"
          onClick={() => { if (item.id !== undefined) setEditing({ id: item.id, draft: item.comment }); }}>
          <svg width="13" height="13" viewBox="0 0 16 16" aria-hidden="true"><path d="M10.5 2.5l3 3L6 13H3v-3z" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" /></svg>
        </button> : null}
        {onRemove ? <button type="button" aria-label={`Remove annotation ${index + 1}`} title="Remove"
          onClick={() => { if (item.id !== undefined) onRemove(item.id); setEditing(null); if (annotations.length === 1) setOpen(false); }}>
          <svg width="13" height="13" viewBox="0 0 16 16" aria-hidden="true"><path d="M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.7 8.5h5.6l.7-8.5" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" /></svg>
        </button> : null}
      </li>)}
    </ol></FloatingLayer> : null}
    <span className="cx-annotation-chip">
      <button type="button" aria-expanded={open} onClick={show}>
        <svg width="12" height="12" viewBox="0 0 16 16" aria-hidden="true"><path d="M3 3h10v7H7l-3 3v-3H3z" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" /></svg>
        {plural(annotations.length)}
      </button>
      {onClear ? <button type="button" className="cx-annotation-clear" aria-label="Remove annotations attachment" onClick={() => { onClear(); setOpen(false); }}>
        <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true"><path d="M2 2l6 6M8 2l-6 6" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" /></svg>
      </button> : null}
    </span>
  </div>;
}

/** The composer's annotation attachment; editing/removing uses each draft's stable id. */
export function AnnotationTray({ annotations, onComment, onRemove, onClear }: {
  annotations: DraftAnnotation[];
  onComment: (id: number, comment: string) => void;
  onRemove: (id: number) => void;
  onClear: () => void;
}) {
  return <AnnotationAttachment annotations={annotations} onComment={onComment} onRemove={onRemove} onClear={onClear} />;
}

/** The same attachment above a sent message, with read-only details instead of a native tooltip. */
export function SentAnnotations({ annotations }: { annotations: ChatAnnotation[] }) {
  return <AnnotationAttachment annotations={annotations} sent />;
}
