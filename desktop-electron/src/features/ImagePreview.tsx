import { useCallback, useEffect, useLayoutEffect, useRef, useState, type FormEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { createPortal, flushSync } from "react-dom";
import {
  MARKUP_COLORS, MARKUP_COLOR_NAMES, MARKUP_DEFAULTS, MARKUP_MAX_PIXELS, clampZoom, constrainShape, drawMarks, exportEraseMask, exportMarkup, markupPins, markupPrompt,
  paintStrokes, zoomStep, type EraseStroke, type MarkupMark, type MarkupShape, type MarkupTool,
} from "./image-markup";
import { MARKUP_ICONS, type MarkupIconName } from "./markup-icons";
import { VIEWER_ICONS, type ViewerIconName } from "./codex-viewer-icons";

// Codex desktop's image preview (26.1016's ImagePreviewOverlay): the app dimmed and blurred behind
// it, a header of translucent pills (the file's menu on the left; zoom, Download and Close on the
// right), the image with a hairline border and a shadow, and a dark tool bar at the bottom: Markup,
// Comment, Remove BG, Erase and Resize. Codex starts a turn with each tool's image and instruction;
// here they land in the chat box (onMarkup), as Markup's "Add to chat" always has.

/** What a tool gives the chat box: the image to send, its preview, and the text for the agent. */
export type MarkupResult = {
  bytes: Uint8Array; preview: string; prompt: string;
  /** The chat box card's name: the tool that made it ("Markup" when not given). */
  label?: string;
  /** Erase's mask (white where to remove), which Codex sends as the second image. */
  mask?: { bytes: Uint8Array; preview: string };
};

/** Codex's instructions for its image tools, verbatim (image-side-panel). */
export const REMOVE_BG_PROMPT = "Remove the background from this image. Keep all foreground subjects unchanged and fully intact, with clean, smooth edges. Make the background transparent.";
export const ERASE_PROMPT = "Remove the area marked in the second image from the first image";
export const resizePrompt = (ratio: string) => `Make the aspect ratio ${ratio}`;
const RATIOS: [label: string, ratio: string, icon: ViewerIconName][] = [["Square", "1:1", "ratioSquare"], ["Portrait", "3:4", "ratioPortrait"],
  ["Story", "9:16", "ratioStory"], ["Landscape", "4:3", "ratioLandscape"], ["Widescreen", "16:9", "ratioWide"]];
const ZOOM_CHOICES = [25, 50, 100, 150, 200];
/** Where the tool bar was dragged to, kept per viewer as Codex keeps it (image-editing-toolbar-position-v2). */
const TOOLBAR_KEY = "cdx-image-toolbar-position";
type Offset = { x: number; y: number };

const MarkupIcon = ({ name, size = 20 }: { name: MarkupIconName; size?: number }) =>
  <svg width={size} height={size} viewBox={MARKUP_ICONS[name].viewBox} aria-hidden="true" dangerouslySetInnerHTML={{ __html: MARKUP_ICONS[name].inner }} />;
const ViewerIcon = ({ name, size = 16 }: { name: ViewerIconName; size?: number }) =>
  <svg width={size} height={size} viewBox={VIEWER_ICONS[name].viewBox} aria-hidden="true" dangerouslySetInnerHTML={{ __html: VIEWER_ICONS[name].inner }} />;

/** The chat's own theme (its Claude palette), which the preview follows: it opens on <body>, outside it. */
const chatIsDark = () => {
  if (typeof document === "undefined") return false;
  const chat = document.querySelector(".ao-workflow[data-theme]");
  return chat ? chat.getAttribute("data-theme") === "dark" : Boolean(window.matchMedia?.("(prefers-color-scheme: dark)").matches);
};

/** The Image menu's lines: the file's name, and the folder it is in. A pasted image is named by its type. */
function fileLabel(name: string | undefined, url: string): { title: string; folder: string } {
  const title = name?.split(/[\\/]/).pop() || `image.${(/^data:image\/(\w+)/.exec(url)?.[1] ?? "png").replace("jpeg", "jpg")}`;
  return { title, folder: name && name.length > title.length ? name.slice(0, name.length - title.length - 1) : "" };
}

const clampOffset = ({ x, y }: Offset): Offset => {
  const reach = typeof window === "undefined" ? 0 : Math.max(0, window.innerWidth / 2 - 120);
  const rise = typeof window === "undefined" ? 0 : Math.max(0, window.innerHeight - 160);
  return { x: Math.round(Math.min(reach, Math.max(-reach, x))), y: Math.round(Math.min(0, Math.max(-rise, y))) };
};
const savedOffset = (): Offset => {
  try {
    const saved = JSON.parse(window.localStorage.getItem(TOOLBAR_KEY) ?? "null") as Offset | null;
    return saved && Number.isFinite(saved.x) && Number.isFinite(saved.y) ? clampOffset(saved) : { x: 0, y: 0 };
  } catch { return { x: 0, y: 0 }; }
};

export function ImagePreviewDialog({ url, name, onClose, onMarkup }: {
  url: string;
  /** The image's file (a path or a name), for the Image menu and the download's name. */
  name?: string;
  onClose: () => void; onMarkup?: (result: MarkupResult) => void | Promise<void>;
}) {
  const [mode, setMode] = useState<"view" | "markup" | "comment" | "erase">("view");
  const [natural, setNatural] = useState<{ width: number; height: number } | null>(null);
  const [failed, setFailed] = useState(false);
  const viewport = useRef<HTMLDivElement>(null);
  const shownImage = useRef<HTMLImageElement>(null);
  const [fit, setFit] = useState(100);
  const [zoom, setZoom] = useState<number | null>(null);
  const [menu, setMenu] = useState<"file" | "zoom" | "resize" | null>(null);
  const [sending, setSending] = useState<"bg" | "resize" | null>(null);
  const [error, setError] = useState("");
  const [dark, setDark] = useState(chatIsDark);
  // Read again once mounted: opened in the same render as its chat, the chat wasn't in the page yet.
  useLayoutEffect(() => { setDark(chatIsDark()); }, []);
  const [offset, setOffset] = useState<Offset>(savedOffset);
  const drag = useRef<{ x: number; y: number; from: Offset } | null>(null);
  const pan = useRef<{ x: number; y: number } | null>(null);
  const press = useRef<{ x: number; y: number } | null>(null);
  const shown = zoom ?? fit;
  const file = fileLabel(name, url);

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

  // Escape closes an open menu, then the preview; Ctrl with +, - or 0 steps the zoom or fits (Codex's).
  useEffect(() => {
    if (mode !== "view") return undefined;
    const keys = (event: KeyboardEvent) => {
      if (event.target instanceof HTMLInputElement) return;
      if (event.key === "Escape") { event.preventDefault(); if (menu) setMenu(null); else onClose(); return; }
      if (!(event.ctrlKey || event.metaKey) || !natural) return;
      if (event.key === "+" || event.key === "=" || event.code === "NumpadAdd") { event.preventDefault(); setZoom(zoomStep(shown, fit, 1)); }
      else if (event.key === "-" || event.key === "_" || event.code === "NumpadSubtract") { event.preventDefault(); setZoom(zoomStep(shown, fit, -1)); }
      else if (event.key === "0" || event.code === "Numpad0") { event.preventDefault(); setZoom(null); }
    };
    window.addEventListener("keydown", keys);
    return () => window.removeEventListener("keydown", keys);
  }, [mode, menu, natural, shown, fit, onClose]);

  // A menu closes on a press anywhere outside it.
  useEffect(() => {
    if (!menu) return undefined;
    const away = (event: PointerEvent) => { if (!(event.target instanceof Element && event.target.closest(".cdx-menu-anchor"))) setMenu(null); };
    window.addEventListener("pointerdown", away, true);
    return () => window.removeEventListener("pointerdown", away, true);
  }, [menu]);

  // Ctrl+wheel (and a trackpad pinch) zooms by exp(−deltaY × 0.01), anchored at the pointer.
  useEffect(() => {
    const box = viewport.current;
    if (!box || mode !== "view") return undefined;
    const wheel = (event: WheelEvent) => {
      if (!event.ctrlKey || !natural) return;
      event.preventDefault();
      const delta = event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? 800 : 1);
      const before = zoom ?? fit;
      const after = clampZoom(before * Math.exp(-delta * 0.01), fit);
      const rect = box.getBoundingClientRect();
      const px = event.clientX - rect.left + box.scrollLeft, py = event.clientY - rect.top + box.scrollTop;
      flushSync(() => setZoom(after));
      box.scrollLeft = px * (after / before) - (event.clientX - rect.left);
      box.scrollTop = py * (after / before) - (event.clientY - rect.top);
    };
    box.addEventListener("wheel", wheel, { passive: false });
    return () => box.removeEventListener("wheel", wheel);
  }, [mode, natural, zoom, fit]);

  const download = () => {
    const link = document.createElement("a");
    link.href = url;
    link.download = file.title;
    link.click();
  };
  const tooLarge = natural ? natural.width * natural.height > MARKUP_MAX_PIXELS : false;
  const zoomed = zoom !== null && Math.abs(zoom - fit) > 0.5;
  const percent = (value: number) => new Intl.NumberFormat(undefined, { style: "percent", maximumFractionDigits: 0 }).format(value / 100);

  // Remove BG and Resize send the image as it is with Codex's instruction.
  const send = async (kind: "bg" | "resize", prompt: string, label: string) => {
    if (!onMarkup || !shownImage.current || sending) return;
    setSending(kind); setError(""); setMenu(null);
    try {
      const bytes = await exportMarkup(shownImage.current, []);
      await finish({ bytes, preview: URL.createObjectURL(new Blob([bytes as BlobPart], { type: "image/png" })), prompt, label });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not prepare the image. Try again");
      setSending(null);
    }
  };
  const placeToolbar = (next: Offset) => {
    const value = clampOffset(next);
    setOffset(value);
    try { window.localStorage.setItem(TOOLBAR_KEY, JSON.stringify(value)); } catch { /* kept for this preview only */ }
  };
  const busy = Boolean(sending);
  const finish = async (result: MarkupResult) => {
    let transferred = false;
    try {
      if (!onMarkup) throw new Error("Image editing is unavailable in this chat. Reopen the image and try again");
      await onMarkup(result);
      transferred = true;
    } finally {
      if (!transferred) {
        URL.revokeObjectURL(result.preview);
        if (result.mask) URL.revokeObjectURL(result.mask.preview);
      }
    }
    onClose();
  };

  // On <body>: it opens from inside a transcript, whose contained scroll box would otherwise hold
  // this full-window overlay to the pane.
  return createPortal(<div className={`cdx-preview is-${mode}`} data-theme={dark ? "dark" : "light"} role="dialog" aria-modal="true" aria-label="Image preview"
    // A click on the space around the image closes it: one that didn't move over 5 px, on no control (Codex's).
    // A zoomed image's scrollbars are the viewport's own and only scroll.
    onPointerDown={(event) => {
      const box = viewport.current, rect = box?.getBoundingClientRect();
      const onBar = box && rect && event.target === box && (event.clientX >= rect.left + box.clientWidth || event.clientY >= rect.top + box.clientHeight);
      press.current = mode === "view" && event.button === 0 && event.isPrimary && !onBar ? { x: event.clientX, y: event.clientY } : null;
    }}
    onClick={(event) => {
      const start = press.current;
      press.current = null;
      if (!start || Math.hypot(event.clientX - start.x, event.clientY - start.y) > 5) return;
      if (event.target instanceof Element && event.target.closest("img, button, a, input, [role=toolbar], [role=menu]")) return;
      onClose();
    }}>
    <h2 className="cdx-sr-only">Image preview</h2>
    {(mode === "markup" || mode === "comment") && natural && onMarkup
      ? <MarkupEditor url={url} natural={natural} dark={dark} initialTool={mode === "comment" ? "comment" : undefined}
        hint={mode === "comment" ? "Click on the image to add comments" : undefined} onBack={() => setMode("view")} onDone={finish} />
      : mode === "erase" && natural && onMarkup
        ? <EraseEditor url={url} natural={natural} onBack={() => setMode("view")} onDone={finish} />
        : <>
          <header className="cdx-viewer-head">
            <span className="cdx-menu-anchor">
              <button type="button" className="cdx-control is-dropdown" aria-label={`File actions for ${file.title}`} title={file.folder ? `${file.title}\n${file.folder}` : file.title}
                aria-haspopup="menu" aria-expanded={menu === "file"} onClick={() => setMenu(menu === "file" ? null : "file")}>
                <ViewerIcon name="photo" /><span className="cdx-control-title">Image</span><ViewerIcon name="chevronDown" /></button>
              {menu === "file" ? <div className="cdx-menu is-file" role="menu" aria-label="File">
                <div className="cdx-file-info"><ViewerIcon name="photo" size={20} />
                  <span><strong>{file.title}</strong>{file.folder ? <small>{file.folder}</small> : null}</span></div>
              </div> : null}
            </span>
            <span className="cdx-viewer-trail">
              {natural ? <span className="cdx-menu-anchor">
                <button type="button" className="cdx-control is-zoom" title="Zoom" aria-label={`Zoom ${percent(shown)}`} aria-haspopup="menu" aria-expanded={menu === "zoom"}
                  onClick={() => setMenu(menu === "zoom" ? null : "zoom")}><span>{percent(shown)}</span><ViewerIcon name="chevronDown" /></button>
                {menu === "zoom" ? <div className="cdx-menu is-end is-narrow" role="menu" aria-label="Zoom">
                  {ZOOM_CHOICES.map((value) => {
                    const picked = zoomed && Math.abs((zoom ?? 0) - value) < 0.5;
                    return <button key={value} type="button" role="menuitemradio" aria-checked={picked} className="cdx-menu-item"
                      onClick={() => { setZoom(value); setMenu(null); }}><span>{value}%</span>{picked ? <ViewerIcon name="check" /> : null}</button>;
                  })}
                  <span className="cdx-menu-sep" role="separator" />
                  <button type="button" role="menuitemradio" aria-checked={!zoomed} className="cdx-menu-item"
                    onClick={() => { setZoom(null); setMenu(null); }}><span>Zoom to fit</span>{!zoomed ? <ViewerIcon name="check" /> : null}</button>
                </div> : null}
              </span> : null}
              <button type="button" className="cdx-control is-round" aria-label="Download" onClick={download}><ViewerIcon name="download" /></button>
              <button type="button" className="cdx-control is-round" aria-label="Close viewer" title="Close viewer" onClick={onClose}><ViewerIcon name="close" /></button>
            </span>
          </header>
          <div className="cdx-preview-viewport" ref={viewport} data-testid="image-preview-dismiss-area">
            {failed ? <p className="cdx-preview-error">Could not load this image. Close and reopen the image to try again</p>
              : <img ref={shownImage} src={url} alt="" draggable={false} className={zoomed ? "is-zoomed" : undefined}
                style={zoomed && natural ? { width: natural.width * shown / 100, height: natural.height * shown / 100 } : undefined}
                onLoad={(event) => setNatural({ width: event.currentTarget.naturalWidth, height: event.currentTarget.naturalHeight })}
                onError={() => setFailed(true)}
                // Zoomed in, a drag pans it.
                onPointerDown={(event) => { if (!zoomed || event.button > 1) return; event.currentTarget.setPointerCapture(event.pointerId); pan.current = { x: event.clientX, y: event.clientY }; }}
                onPointerMove={(event) => {
                  const box = viewport.current, from = pan.current;
                  if (!box || !from) return;
                  box.scrollLeft -= event.clientX - from.x; box.scrollTop -= event.clientY - from.y;
                  pan.current = { x: event.clientX, y: event.clientY };
                }}
                onPointerUp={() => { pan.current = null; }} onPointerCancel={() => { pan.current = null; }} />}
          </div>
          {onMarkup && natural && !failed ? <div className="cdx-tools-dock">
            <div role="toolbar" aria-label="Image editing tools" className="cdx-tools" style={{ translate: `${offset.x}px ${offset.y}px` }}>
              <button type="button" className="cdx-tool is-handle" aria-label="Move toolbar" aria-description="Drag or use arrow keys to move. Press Home to reset."
                onPointerDown={(event) => { event.currentTarget.setPointerCapture(event.pointerId); drag.current = { x: event.clientX, y: event.clientY, from: offset }; }}
                onPointerMove={(event) => { const from = drag.current; if (from) placeToolbar({ x: from.from.x + event.clientX - from.x, y: from.from.y + event.clientY - from.y }); }}
                onPointerUp={() => { drag.current = null; }} onPointerCancel={() => { drag.current = null; }}
                onKeyDown={(event) => {
                  const step = { ArrowLeft: [-10, 0], ArrowRight: [10, 0], ArrowUp: [0, -10], ArrowDown: [0, 10] }[event.key];
                  if (step) { event.preventDefault(); placeToolbar({ x: offset.x + step[0], y: offset.y + step[1] }); }
                  else if (event.key === "Home") { event.preventDefault(); placeToolbar({ x: 0, y: 0 }); }
                }}><ViewerIcon name="drag" /></button>
              <div className="cdx-tools-scroll">
                <button type="button" className="cdx-tool" title="Markup" disabled={busy || tooLarge} onClick={() => setMode("markup")}>
                  <MarkupIcon name="pen" size={20} /><span>Markup</span></button>
                <button type="button" className="cdx-tool" title="Comment" aria-label="Comment" disabled={busy || tooLarge} onClick={() => setMode("comment")}>
                  <ViewerIcon name="comment" /><span>Comment</span></button>
                <button type="button" className="cdx-tool" disabled={busy || tooLarge} onClick={() => void send("bg", REMOVE_BG_PROMPT, "Remove BG")}>
                  {sending === "bg" ? <span className="cdx-spinner" aria-hidden="true" /> : <ViewerIcon name="removeBackground" />}<span>Remove BG</span></button>
                <button type="button" className="cdx-tool" title="Erase" aria-label="Erase" disabled={busy || tooLarge} onClick={() => setMode("erase")}>
                  <ViewerIcon name="eraser" /><span>Erase</span></button>
                <span className="cdx-menu-anchor">
                  <button type="button" className="cdx-tool" aria-haspopup="menu" aria-expanded={menu === "resize"} disabled={busy || tooLarge}
                    onClick={() => setMenu(menu === "resize" ? null : "resize")}>
                    {sending === "resize" ? <span className="cdx-spinner" aria-hidden="true" /> : <ViewerIcon name="resize" size={18} />}<span>Resize</span></button>
                </span>
              </div>
              {/* Beside the scroller, which would clip it; above the bar, at its right end where Resize is. */}
              {menu === "resize" ? <span className="cdx-menu-anchor cdx-resize-anchor">
                <div className="cdx-menu is-up is-narrow" role="menu" aria-label="Resize">
                  {RATIOS.map(([label, ratio, icon]) => <button key={ratio} type="button" role="menuitem" className="cdx-menu-item"
                    onClick={() => void send("resize", resizePrompt(ratio), "Resize")}>
                    <ViewerIcon name={icon} size={20} /><span className="cdx-menu-split">{label}<span>{ratio}</span></span></button>)}
                </div>
              </span> : null}
            </div>
            {error ? <span className="cdx-markup-error" role="alert">{error}</span> : null}
          </div> : null}
        </>}
  </div>, document.body);
}

/** Erase (Codex's brush): paint over what should go; the image and a mask of the strokes go to the chat box. */
function EraseEditor({ url, natural, onBack, onDone }: {
  url: string; natural: { width: number; height: number }; onBack: () => void; onDone: (result: MarkupResult) => Promise<void>;
}) {
  const [strokes, setStrokes] = useState<EraseStroke[]>([]);
  const [undone, setUndone] = useState<EraseStroke[]>([]);
  // Codex's brush: 5 to 130, 70 to start, in 1/500 of the image's shorter side.
  const [brush, setBrush] = useState(70);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const live = useRef<EraseStroke | null>(null);
  const image = useRef<HTMLImageElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const unit = Math.min(natural.width, natural.height) / 500;

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
    paintStrokes(ctx, live.current ? [...strokes, live.current] : strokes, getComputedStyle(board).color);
  }, [strokes, natural]);
  useLayoutEffect(() => { redraw(); }, [redraw]);
  useEffect(() => {
    const observer = new ResizeObserver(() => redraw());
    if (image.current) observer.observe(image.current);
    return () => observer.disconnect();
  }, [redraw]);

  const point = (event: ReactPointerEvent): [number, number] => {
    const rect = canvas.current!.getBoundingClientRect();
    return [Math.min(natural.width, Math.max(0, (event.clientX - rect.left) * natural.width / rect.width)),
      Math.min(natural.height, Math.max(0, (event.clientY - rect.top) * natural.height / rect.height))];
  };
  const undo = () => { if (!strokes.length) return; setUndone((later) => [strokes[strokes.length - 1], ...later]); setStrokes(strokes.slice(0, -1)); };
  const redo = () => { if (!undone.length) return; setStrokes([...strokes, undone[0]]); setUndone(undone.slice(1)); };
  useEffect(() => {
    const keys = (event: KeyboardEvent) => {
      if (event.key === "Escape") { event.preventDefault(); onBack(); return; }
      const mod = event.ctrlKey || event.metaKey;
      if (mod && event.key.toLowerCase() === "z") { event.preventDefault(); if (event.shiftKey) redo(); else undo(); }
      else if (mod && event.key.toLowerCase() === "y") { event.preventDefault(); redo(); }
    };
    window.addEventListener("keydown", keys);
    return () => window.removeEventListener("keydown", keys);
  });

  const send = async () => {
    if (!image.current || busy || !strokes.length) return;
    setBusy(true); setError("");
    try {
      const bytes = await exportMarkup(image.current, []);
      const mask = await exportEraseMask(natural.width, natural.height, strokes);
      const preview = URL.createObjectURL(new Blob([bytes as BlobPart], { type: "image/png" }));
      let maskPreview: string;
      try {
        maskPreview = URL.createObjectURL(new Blob([mask as BlobPart], { type: "image/png" }));
      } catch (cause) {
        URL.revokeObjectURL(preview);
        throw cause;
      }
      await onDone({ bytes, preview, prompt: ERASE_PROMPT, label: "Erase", mask: { bytes: mask, preview: maskPreview } });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not prepare the image. Try again");
      setBusy(false);
    }
  };

  return <div className="cdx-markup">
    <div className="cdx-markup-stage">
      <div className="cdx-markup-surface">
        <img ref={image} src={url} alt="" draggable={false} onLoad={redraw} />
        <canvas ref={canvas} className="cdx-erase-canvas" role="application" aria-label="Mark areas to remove" tabIndex={0}
          onPointerDown={(event) => {
            if (event.button !== 0 || busy) return;
            event.currentTarget.setPointerCapture(event.pointerId);
            live.current = { points: [point(event)], width: brush * unit };
            redraw();
          }}
          onPointerMove={(event) => { if (!live.current) return; live.current.points.push(point(event)); redraw(); }}
          onPointerUp={() => { const stroke = live.current; live.current = null; if (stroke) { setStrokes([...strokes, stroke]); setUndone([]); } }}
          onPointerCancel={() => { live.current = null; redraw(); }} />
      </div>
    </div>
    <div className="cdx-tools-dock">
      <div role="toolbar" aria-label="Erase" className="cdx-tools is-erase">
        <span className="cdx-tools-hint">Brush over what you want to remove</span>
        <label className="cdx-brush" title="Brush size"><span className="cdx-sr-only">Brush size</span>
          <input type="range" min={5} max={130} value={brush} onChange={(event) => setBrush(Number(event.target.value))} /></label>
        <button type="button" className="cdx-tool is-icon" aria-label="Undo" title="Undo" disabled={!strokes.length || busy} onClick={undo}><MarkupIcon name="undo" size={18} /></button>
        <button type="button" className="cdx-tool is-icon" aria-label="Redo" title="Redo" disabled={!undone.length || busy} onClick={redo}><MarkupIcon name="redo" size={18} /></button>
        <button type="button" className="cdx-tool" disabled={busy} onClick={onBack}>Cancel</button>
        <button type="button" className="cdx-tool is-primary" disabled={!strokes.length || busy} onClick={() => void send()}
          title="Add the image and the marked area to the chat box">{busy ? "Adding…" : "Add to chat"}</button>
      </div>
      {error ? <span className="cdx-markup-error" role="alert">{error}</span> : null}
    </div>
  </div>;
}

type Draft = { index: number; text: string; isNew: boolean };

/** Markup, and Comment (the same editor started on its pin tool, with Codex's hint over the image). */
function MarkupEditor({ url, natural, dark, initialTool, hint, onBack, onDone }: {
  url: string; natural: { width: number; height: number }; dark: boolean; initialTool?: MarkupTool; hint?: string;
  onBack: () => void; onDone: (result: MarkupResult) => Promise<void>;
}) {
  const [marks, setMarks] = useState<MarkupMark[]>([]);
  const [undone, setUndone] = useState<MarkupMark[][]>([]);
  const [history, setHistory] = useState<MarkupMark[][]>([]);
  const [tool, setTool] = useState<MarkupTool>(initialTool ?? MARKUP_DEFAULTS.tool);
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

    {hint && tool === "comment" && !pins.length ? <p className="cdx-markup-hint" role="status">{hint}</p> : null}
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
