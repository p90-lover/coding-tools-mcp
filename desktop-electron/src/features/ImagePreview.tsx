import { useCallback, useEffect, useLayoutEffect, useRef, useState, type FormEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { createPortal, flushSync } from "react-dom";
import {
  MARKUP_COLORS, MARKUP_COLOR_NAMES, MARKUP_DEFAULTS, MARKUP_MAX_PIXELS, clampZoom, constrainShape, drawMarks, exportMarkup, markupPins, markupPrompt,
  zoomStep, type MarkupMark, type MarkupShape, type MarkupTool,
} from "./image-markup";
import { MARKUP_ICONS, type MarkupIconName } from "./markup-icons";

// Codex desktop's image preview (its full-window dialog: black backdrop, round buttons top right,
// a zoom pill at the bottom) and its Markup mode (draw on the image, numbered comment pins). Markup
// hands the marked image and its pin lines to the chat box (onMarkup); Codex finishes Markup by
// sending from a composer beside it, so here "Add to chat" puts it in the chat box instead.

/** What Markup gives the chat box: the image with the marks burned in, and the text for the agent. */
export type MarkupResult = { bytes: Uint8Array; preview: string; prompt: string };

const MarkupIcon = ({ name, size = 20 }: { name: MarkupIconName; size?: number }) =>
  <svg width={size} height={size} viewBox={MARKUP_ICONS[name].viewBox} aria-hidden="true" dangerouslySetInnerHTML={{ __html: MARKUP_ICONS[name].inner }} />;
const Glyph = ({ d, size = 18 }: { d: string; size?: number }) =>
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={d} /></svg>;

export function ImagePreviewDialog({ url, onClose, onMarkup }: { url: string; onClose: () => void; onMarkup?: (result: MarkupResult) => void | Promise<void> }) {
  const [mode, setMode] = useState<"view" | "markup">("view");
  const [natural, setNatural] = useState<{ width: number; height: number } | null>(null);
  const [failed, setFailed] = useState(false);
  const viewport = useRef<HTMLDivElement>(null);
  const [fit, setFit] = useState(100);
  const [zoom, setZoom] = useState<number | null>(null);
  const shown = zoom ?? fit;

  // Fit = min(1, viewport / natural) × 100: never upscaled (Codex's).
  useLayoutEffect(() => {
    if (!natural || !viewport.current) return undefined;
    const measure = () => {
      const box = viewport.current;
      if (!box) return;
      setFit(Math.min(1, box.clientWidth / natural.width, box.clientHeight / natural.height) * 100);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(viewport.current);
    return () => observer.disconnect();
  }, [natural, mode]);

  useEffect(() => {
    if (mode !== "view") return undefined;
    const keys = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !(event.target instanceof HTMLInputElement)) { event.preventDefault(); onClose(); }
    };
    window.addEventListener("keydown", keys);
    return () => window.removeEventListener("keydown", keys);
  }, [mode, onClose]);

  // Ctrl+wheel (and a trackpad pinch) zooms by exp(−deltaY / 200), anchored at the pointer.
  useEffect(() => {
    const box = viewport.current;
    if (!box || mode !== "view") return undefined;
    const wheel = (event: WheelEvent) => {
      if (!event.ctrlKey || !natural) return;
      event.preventDefault();
      const delta = event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? 800 : 1);
      const before = zoom ?? fit;
      const after = clampZoom(before * Math.exp(-delta / 200), fit);
      const rect = box.getBoundingClientRect();
      const px = event.clientX - rect.left + box.scrollLeft, py = event.clientY - rect.top + box.scrollTop;
      flushSync(() => setZoom(after));
      box.scrollLeft = px * (after / before) - (event.clientX - rect.left);
      box.scrollTop = py * (after / before) - (event.clientY - rect.top);
    };
    box.addEventListener("wheel", wheel, { passive: false });
    return () => box.removeEventListener("wheel", wheel);
  }, [mode, natural, zoom, fit]);

  // The buttons stand in a column at the image's top right, beside it: in the window's top right
  // corner the title bar's minimize, maximize and close covered them.
  const picture = useRef<HTMLImageElement>(null);
  const [beside, setBeside] = useState<{ left: number; top: number } | null>(null);
  useLayoutEffect(() => {
    const box = viewport.current;
    if (mode !== "view" || !box) return undefined;
    const measure = () => {
      const view = box.getBoundingClientRect();
      const shownBox = picture.current && natural ? picture.current.getBoundingClientRect() : view;
      setBeside({ left: Math.min(Math.min(shownBox.right, view.right) + 12, window.innerWidth - 52), top: Math.max(shownBox.top, view.top) });
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(box);
    if (picture.current) observer.observe(picture.current);
    box.addEventListener("scroll", measure, { passive: true });
    return () => { observer.disconnect(); box.removeEventListener("scroll", measure); };
  }, [mode, natural, shown, failed]);

  // A press anywhere but the image and its controls closes it, its zoom pill's row included; a
  // zoomed image's scrollbars are the viewport's own and only scroll.
  const dismiss = (event: ReactPointerEvent<HTMLDivElement>) => {
    const target = event.target as HTMLElement;
    if (mode !== "view" || target.closest("img, button, .cdx-zoom-pill")) return;
    const box = viewport.current;
    if (box && target === box) {
      const rect = box.getBoundingClientRect();
      if (event.clientX >= rect.left + box.clientWidth || event.clientY >= rect.top + box.clientHeight) return;
    }
    onClose();
  };

  const download = () => {
    const link = document.createElement("a");
    link.href = url;
    link.download = /^data:image\/(\w+)/.exec(url)?.[1] ? `image.${/^data:image\/(\w+)/.exec(url)![1].replace("jpeg", "jpg")}` : "image.png";
    link.click();
  };
  const tooLarge = natural ? natural.width * natural.height > MARKUP_MAX_PIXELS : false;
  const zoomed = zoom !== null && Math.abs(zoom - fit) > 0.5;

  // On <body>: it opens from inside a transcript, whose contained scroll box would otherwise hold
  // this full-window overlay to the pane.
  return createPortal(<div className="cdx-preview" role="dialog" aria-modal="true" aria-label="Image preview" onPointerDown={dismiss}>
    <h2 className="cdx-sr-only">Image preview</h2>
    {mode === "markup" && natural && onMarkup
      ? <MarkupEditor url={url} natural={natural} onBack={() => setMode("view")} onDone={async (result) => { await onMarkup(result); onClose(); }} />
      : <div className="cdx-preview-column">
        <div className="cdx-preview-viewport" ref={viewport} data-testid="image-preview-dismiss-area">
          {failed ? <p className="cdx-preview-error">Could not load this image. Close and reopen the image to try again</p>
            : <img ref={picture} src={url} alt="" draggable={false} className={zoomed ? "is-zoomed" : undefined}
              style={zoomed && natural ? { width: natural.width * shown / 100, height: natural.height * shown / 100 } : undefined}
              onLoad={(event) => setNatural({ width: event.currentTarget.naturalWidth, height: event.currentTarget.naturalHeight })}
              onError={() => setFailed(true)} />}
        </div>
        {natural ? <div className="cdx-preview-bottom">
          <div className="cdx-zoom-pill">
            <button type="button" aria-label="Zoom out image" disabled={shown <= clampZoom(0, fit) + 0.5} onClick={() => setZoom(zoomStep(shown, fit, -1))}><Glyph d="M6 12h12" /></button>
            <span className="cdx-zoom-label">{new Intl.NumberFormat(undefined, { style: "percent", maximumFractionDigits: 0 }).format(shown / 100)}</span>
            <button type="button" aria-label="Zoom in image" disabled={shown >= clampZoom(Infinity, fit) - 0.5} onClick={() => setZoom(zoomStep(shown, fit, 1))}><Glyph d="M12 6v12M6 12h12" /></button>
          </div>
        </div> : null}
      </div>}
    {mode === "view" ? <div className="cdx-preview-actions is-beside" style={beside ?? { visibility: "hidden" }}>
      {onMarkup && natural && !failed ? <button type="button" className="cdx-preview-button" disabled={tooLarge} aria-label="Markup"
        title={tooLarge ? "Images over 20 megapixels can't be marked up" : "Markup"} onClick={() => setMode("markup")}>
        <MarkupIcon name="pen" /></button> : null}
      <button type="button" className="cdx-preview-button" aria-label="Download image" title="Download image" onClick={download}><Glyph d="M12 4v11m0 0-4.5-4.5M12 15l4.5-4.5M5 19.5h14" size={16} /></button>
      <button type="button" className="cdx-preview-button" aria-label="Close image preview" title="Close image preview" onClick={onClose}><Glyph d="M6 6l12 12M18 6 6 18" /></button>
    </div> : null}
  </div>, document.body);
}

type Draft = { index: number; text: string; isNew: boolean };

function MarkupEditor({ url, natural, onBack, onDone }: {
  url: string; natural: { width: number; height: number }; onBack: () => void; onDone: (result: MarkupResult) => Promise<void>;
}) {
  const [marks, setMarks] = useState<MarkupMark[]>([]);
  const [undone, setUndone] = useState<MarkupMark[][]>([]);
  const [history, setHistory] = useState<MarkupMark[][]>([]);
  const [tool, setTool] = useState<MarkupTool>(MARKUP_DEFAULTS.tool);
  const [color, setColor] = useState(MARKUP_DEFAULTS.color);
  const [menu, setMenu] = useState<"shapes" | "color" | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [scale, setScale] = useState(1);
  const live = useRef<MarkupMark | null>(null);
  const image = useRef<HTMLImageElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const stage = useRef<HTMLDivElement>(null);
  const dark = typeof window !== "undefined" && window.matchMedia?.("(prefers-color-scheme: dark)").matches;
  const colors = dark ? ["#ffffff", ...MARKUP_COLORS.slice(1)] : MARKUP_COLORS;

  const commit = useCallback((next: MarkupMark[]) => { setHistory((past) => [...past, marks]); setUndone([]); setMarks(next); }, [marks]);
  const undo = () => { if (!history.length) return; setUndone((future) => [marks, ...future]); setMarks(history[history.length - 1]); setHistory((past) => past.slice(0, -1)); setDraft(null); };
  const redo = () => { if (!undone.length) return; setHistory((past) => [...past, marks]); setMarks(undone[0]); setUndone((future) => future.slice(1)); };

  // The canvas matches the shown image; marks are kept in the image's own pixels and scaled to it.
  const redraw = useCallback(() => {
    const img = image.current, board = canvas.current;
    if (!img || !board) return;
    const rect = img.getBoundingClientRect();
    const ratio = window.devicePixelRatio || 1;
    board.width = Math.round(rect.width * ratio); board.height = Math.round(rect.height * ratio);
    board.style.width = `${rect.width}px`; board.style.height = `${rect.height}px`;
    const ctx = board.getContext("2d");
    if (!ctx) return;
    ctx.setTransform((rect.width / natural.width) * ratio, 0, 0, (rect.height / natural.height) * ratio, 0, 0);
    ctx.clearRect(0, 0, natural.width, natural.height);
    // Pins are buttons over the canvas (clickable to edit); the export burns them in.
    drawMarks(ctx, [...marks, ...(live.current ? [live.current] : [])].filter((mark) => mark.kind !== "comment"));
    setScale(rect.width / natural.width);
  }, [marks, natural]);
  useLayoutEffect(() => { redraw(); }, [redraw]);
  useEffect(() => {
    const observer = new ResizeObserver(() => redraw());
    if (stage.current) observer.observe(stage.current);
    return () => observer.disconnect();
  }, [redraw]);

  const point = (event: ReactPointerEvent): [number, number] => {
    const rect = canvas.current!.getBoundingClientRect();
    return [
      Math.min(natural.width, Math.max(0, (event.clientX - rect.left) * natural.width / rect.width)),
      Math.min(natural.height, Math.max(0, (event.clientY - rect.top) * natural.height / rect.height)),
    ];
  };
  const toDoc = (px: number) => px / (scale || 1);

  const down = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    if (event.button !== 0 || busy) return;
    setMenu(null);
    const [x, y] = point(event);
    if (tool === "comment") {
      if (draft) { saveDraft(); return; }
      const size = toDoc(MARKUP_DEFAULTS.pinPx);
      const pin: MarkupMark = { kind: "comment", x: Math.min(natural.width - size / 2, Math.max(size / 2, x)), y: Math.min(natural.height - size / 2, Math.max(size / 2, y)), size, text: "" };
      setMarks((current) => [...current, pin]);
      setDraft({ index: marks.length, text: "", isNew: true });
      return;
    }
    event.currentTarget.setPointerCapture(event.pointerId);
    const width = toDoc(MARKUP_DEFAULTS.widthPx);
    live.current = tool === "pen" ? { kind: "pen", points: [[x, y]], color, width } : { kind: tool, x1: x, y1: y, x2: x, y2: y, color, width };
    redraw();
  };
  const move = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    const mark = live.current;
    if (!mark) return;
    const [x, y] = point(event);
    if (mark.kind === "pen") mark.points.push([x, y]);
    else if (mark.kind !== "comment") {
      const [x2, y2] = event.shiftKey ? constrainShape(mark.kind, mark.x1, mark.y1, x, y) : [x, y];
      mark.x2 = x2; mark.y2 = y2;
    }
    redraw();
  };
  const up = () => {
    const mark = live.current;
    live.current = null;
    if (!mark) return;
    // Shapes smaller than 2 image pixels are dropped, as Codex drops them.
    if (mark.kind !== "pen" && mark.kind !== "comment" && Math.hypot(mark.x2 - mark.x1, mark.y2 - mark.y1) < 2) { redraw(); return; }
    commit([...marks, mark]);
  };

  function saveDraft(text = draft?.text ?? ""): MarkupMark[] {
    if (!draft) return marks;
    const pins = marks;
    if (draft.isNew && !text.trim()) {
      const next = pins.filter((_, index) => index !== draft.index);
      setMarks(next); setDraft(null);
      return next;
    }
    const next = pins.map((mark, index) => index === draft.index && mark.kind === "comment" ? { ...mark, text: text.trim() } : mark);
    setHistory((past) => [...past, draft.isNew ? pins.filter((_, index) => index !== draft.index) : pins]); setUndone([]);
    setMarks(next); setDraft(null);
    return next;
  }
  const cancelDraft = () => {
    if (!draft) return;
    if (draft.isNew) setMarks((current) => current.filter((_, index) => index !== draft.index));
    setDraft(null);
  };
  const deletePin = (index: number) => { commit(marks.filter((_, at) => at !== index)); setDraft(null); };

  const leave = () => { if (marks.length || draft) setConfirming(true); else onBack(); };
  useEffect(() => {
    const keys = (event: KeyboardEvent) => {
      const typing = event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement;
      if (event.key === "Escape") { event.preventDefault(); if (confirming) setConfirming(false); else if (draft) cancelDraft(); else if (menu) setMenu(null); else leave(); return; }
      if (typing || confirming) return;
      const mod = event.ctrlKey || event.metaKey;
      if (mod && event.key.toLowerCase() === "z") { event.preventDefault(); if (event.shiftKey) redo(); else undo(); }
      else if (mod && event.key.toLowerCase() === "y") { event.preventDefault(); redo(); }
    };
    window.addEventListener("keydown", keys);
    return () => window.removeEventListener("keydown", keys);
  });

  const finish = async () => {
    if (!image.current || busy) return;
    const finalMarks = draft ? saveDraft() : marks;
    setBusy(true); setError("");
    try {
      const bytes = await exportMarkup(image.current, finalMarks);
      const preview = URL.createObjectURL(new Blob([bytes as BlobPart], { type: "image/png" }));
      await onDone({ bytes, preview, prompt: markupPrompt(finalMarks, natural.width, natural.height) });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not prepare markup. Try again");
      setBusy(false);
    }
  };

  const toolButton = (name: MarkupTool, label: string, icon: MarkupIconName) =>
    <button type="button" className={`cdx-markup-tool${tool === name ? " is-pressed" : ""}`} aria-label={label} title={label} aria-pressed={tool === name}
      onPointerDown={(event) => event.preventDefault()} onClick={() => { setTool(name); setMenu(null); }}><MarkupIcon name={icon} /></button>;
  const shapes: [MarkupShape["kind"], string, MarkupIconName][] = [["line", "Line", "line"], ["arrow", "Arrow", "arrow"], ["rectangle", "Rectangle", "rectangle"], ["ellipse", "Ellipse", "ellipse"]];
  const shapeActive = shapes.some(([kind]) => kind === tool);
  const pins = markupPins(marks);
  const pinIndex = (index: number) => marks.slice(0, index + 1).filter((mark) => mark.kind === "comment").length;
  const hasMarks = marks.length > 0;

  return <div className="cdx-markup">
    <fieldset className="cdx-markup-toolbar" aria-label="Drawing tools">
      {toolButton("comment", "Add comment", "comment")}
      <span className="cdx-markup-divider" aria-hidden="true" />
      {toolButton("pen", "Pen", "pen")}
      <span className="cdx-markup-menu-anchor">
        <button type="button" className={`cdx-markup-tool${shapeActive ? " is-pressed" : ""}`} aria-label="Shapes" title="Shapes" aria-expanded={menu === "shapes"}
          onPointerDown={(event) => event.preventDefault()} onClick={() => setMenu(menu === "shapes" ? null : "shapes")}>
          <MarkupIcon name={shapeActive ? shapes.find(([kind]) => kind === tool)![2] : "shapes"} /></button>
        {menu === "shapes" ? <span className="cdx-markup-popover cdx-markup-shapes" role="menu">
          {shapes.map(([kind, label, icon]) => <button key={kind} type="button" role="menuitemradio" aria-checked={tool === kind}
            className={`cdx-markup-tool${tool === kind ? " is-pressed" : ""}`} aria-label={label} title={label}
            onClick={() => { setTool(kind); setMenu(null); }}><MarkupIcon name={icon} /></button>)}
        </span> : null}
      </span>
      <span className="cdx-markup-menu-anchor">
        <button type="button" className="cdx-markup-tool" aria-label="Ink color" title="Ink color" aria-expanded={menu === "color"}
          onPointerDown={(event) => event.preventDefault()} onClick={() => setMenu(menu === "color" ? null : "color")}>
          <span className="cdx-markup-swatch" style={{ background: color }} /></button>
        {menu === "color" ? <span className="cdx-markup-popover cdx-markup-colors" role="menu">
          {colors.map((value, index) => <button key={value} type="button" className={`cdx-markup-color${value === color ? " is-selected" : ""}`}
            style={{ background: value }} aria-label={`Use ${index === 0 && dark ? "white" : MARKUP_COLOR_NAMES[index]}`}
            onClick={() => { setColor(value); setMenu(null); if (tool === "comment") setTool("pen"); }} />)}
        </span> : null}
      </span>
      <span className="cdx-markup-divider" aria-hidden="true" />
      <button type="button" className="cdx-markup-tool" aria-label="Undo" title="Undo" disabled={!history.length} onPointerDown={(event) => event.preventDefault()} onClick={undo}><MarkupIcon name="undo" /></button>
      <button type="button" className="cdx-markup-tool" aria-label="Redo" title="Redo" disabled={!undone.length} onPointerDown={(event) => event.preventDefault()} onClick={redo}><MarkupIcon name="redo" /></button>
      <span className="cdx-markup-divider" aria-hidden="true" />
      <button type="button" className="cdx-markup-tool" aria-label="Cancel markup" title="Cancel markup" onPointerDown={(event) => event.preventDefault()} onClick={leave}><MarkupIcon name="cancel" /></button>
    </fieldset>

    <div className="cdx-markup-stage" ref={stage}>
      <div className="cdx-markup-surface">
        <img ref={image} src={url} alt="" draggable={false} onLoad={redraw} />
        <canvas ref={canvas} className={`cdx-markup-canvas${tool === "comment" ? " is-comment" : " is-draw"}`} role="application" aria-label="Draw on image" tabIndex={0}
          onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={up} />
        {marks.map((mark, index) => mark.kind !== "comment" ? null
          : <button key={index} type="button" className="cdx-markup-pin" aria-label={`Comment ${pinIndex(index)}${mark.text ? `: ${mark.text}` : ""}`}
            style={{ left: mark.x * scale, top: mark.y * scale, width: mark.size * scale, height: mark.size * scale }}
            onClick={() => { if (draft?.index !== index) setDraft({ index, text: mark.text, isNew: false }); }}>
            <span className="cdx-markup-pin-dot" style={{ fontSize: (mark.size * scale) / Math.max(2, String(pinIndex(index)).length) }}>{pinIndex(index)}</span>
            {mark.text && draft?.index !== index ? <span className="cdx-markup-pin-hover">{mark.text}</span> : null}
          </button>)}
        {draft && marks[draft.index]?.kind === "comment" ? <PinComposer draft={draft} pin={marks[draft.index] as Extract<MarkupMark, { kind: "comment" }>} scale={scale}
          onText={(text) => setDraft({ ...draft, text })} onSave={(text) => saveDraft(text)} onCancel={cancelDraft} onDelete={() => deletePin(draft.index)} /> : null}
      </div>
    </div>

    <div className="cdx-preview-actions">
      {error ? <span className="cdx-markup-error" role="alert">{error}</span> : null}
      <button type="button" className="cdx-preview-button has-label is-primary" disabled={busy || !hasMarks} onClick={() => void finish()}
        title={pins.length ? `Add the marked image and ${pins.length} comment${pins.length === 1 ? "" : "s"} to the chat box` : "Add the marked image to the chat box"}>
        {busy ? "Adding…" : "Add to chat"}</button>
      <button type="button" className="cdx-preview-button has-label" onClick={leave}>Back to image</button>
    </div>

    {confirming ? <div className="cdx-discard" role="alertdialog" aria-label="Discard changes?">
      <form className="cdx-discard-card" onSubmit={(event) => { event.preventDefault(); setConfirming(false); }}>
        <h3>Discard changes?</h3>
        <p>Your changes won't be saved</p>
        <button type="submit" className="cdx-discard-keep" autoFocus>Keep editing</button>
        <button type="button" className="cdx-discard-drop" onClick={() => { setConfirming(false); onBack(); }}>Discard changes</button>
      </form>
    </div> : null}
  </div>;
}

/** A pin's comment, beside it (Codex's popover: 309 px, to the right, flipped left when it doesn't fit). */
function PinComposer({ draft, pin, scale, onText, onSave, onCancel, onDelete }: {
  draft: Draft; pin: Extract<MarkupMark, { kind: "comment" }>; scale: number;
  onText: (text: string) => void; onSave: (text: string) => void; onCancel: () => void; onDelete: () => void;
}): ReactNode {
  const box = useRef<HTMLFormElement>(null);
  const [side, setSide] = useState<"right" | "left">("right");
  useLayoutEffect(() => {
    const rect = box.current?.getBoundingClientRect();
    if (rect && rect.right > window.innerWidth - 8) setSide("left");
  }, []);
  const half = (pin.size * scale) / 2;
  const style = side === "right"
    ? { left: pin.x * scale + half + 6, top: pin.y * scale - 22 }
    : { left: pin.x * scale - half - 6 - 309, top: pin.y * scale - 22 };
  return <form ref={box} className="cdx-markup-comment" style={style} onPointerDown={(event) => event.stopPropagation()}
    onSubmit={(event: FormEvent) => { event.preventDefault(); onSave(draft.text); }}>
    <input name="image-annotation-instruction" aria-label="Comment" placeholder="Add a comment…" autoFocus value={draft.text}
      onChange={(event) => onText(event.target.value)}
      onKeyDown={(event) => { if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); onCancel(); } }} />
    <button type="submit" className="cdx-markup-comment-save" aria-label="Save comment" title="Save comment" disabled={!draft.text.trim() && draft.isNew}><MarkupIcon name="save" size={16} /></button>
    {draft.isNew
      ? <button type="button" className="cdx-markup-tool" aria-label="Cancel comment" title="Cancel comment" onClick={onCancel}><MarkupIcon name="close16" size={16} /></button>
      : <button type="button" className="cdx-markup-tool" aria-label="Delete comment" title="Delete comment" onClick={onDelete}><MarkupIcon name="trash" size={16} /></button>}
  </form>;
}
