import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import type { ChangedFile } from "./ChatReplyHead";
import "./chat-changed-files.css";

/** Keep the hover card inside the window, even in a narrow chat at its bottom edge. */
export function changedFilesPosition(anchor: { left: number; right: number; top: number; bottom: number }, width: number, height: number, viewport: { width: number; height: number }) {
  const gutter = 8, gap = 6;
  const below = viewport.height - anchor.bottom - gap - gutter;
  const above = anchor.top - gap - gutter;
  const maxHeight = Math.max(0, Math.min(400, Math.max(below, above)));
  const shownHeight = Math.min(height, maxHeight);
  return {
    left: Math.max(gutter, Math.min(anchor.right - width, viewport.width - width - gutter)),
    top: below >= shownHeight ? anchor.bottom + gap : Math.max(gutter, anchor.top - gap - shownHeight),
    maxHeight,
  };
}

function Counts({ additions, deletions }: { additions: number; deletions: number }) {
  return <span className="cx-file-counts"><span className="is-add">+{additions.toLocaleString()}</span><span className="is-del">−{deletions.toLocaleString()}</span></span>;
}

/** One quiet footer control; the file list exists only while it is being read. No diff fetches. */
export function ChatChangedFiles({ files, onOpen }: { files: ChangedFile[]; onOpen?: (path?: string) => void }) {
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState<{ left: number; top: number; maxHeight: number } | null>(null);
  const root = useRef<HTMLSpanElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const restoringFocus = useRef(false);
  const id = useId();
  const additions = files.reduce((sum, file) => sum + file.additions, 0);
  const deletions = files.reduce((sum, file) => sum + file.deletions, 0);
  const count = `${files.length} ${files.length === 1 ? "file" : "files"}`;
  const cancelClose = () => { clearTimeout(closeTimer.current); closeTimer.current = undefined; };
  const show = () => { cancelClose(); setOpen(true); };
  const dismiss = (restore = false) => {
    cancelClose(); setOpen(false); setPosition(null);
    if (restore) {
      restoringFocus.current = true;
      button.current?.focus();
      restoringFocus.current = false;
    }
  };
  const leave = () => {
    cancelClose();
    closeTimer.current = setTimeout(() => {
      if (!root.current?.contains(document.activeElement)) dismiss();
    }, 180);
  };
  useEffect(() => () => cancelClose(), []);
  useLayoutEffect(() => {
    if (!open || !files.length || !panel.current || !button.current) return;
    // Native top layer escapes the thread's overflow and transformed multi-chat cards without
    // a body portal, so the chat's theme variables still inherit (including live theme changes).
    panel.current.showPopover();
    const bounds = panel.current.getBoundingClientRect();
    setPosition(changedFilesPosition(button.current.getBoundingClientRect(), bounds.width, bounds.height,
      { width: window.innerWidth, height: window.innerHeight }));
  }, [open, files]);
  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => { if (!root.current?.contains(event.target as Node)) dismiss(); };
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); dismiss(true); }
    };
    const scroll = (event: Event) => { if (!panel.current?.contains(event.target as Node)) dismiss(); };
    const blur = () => dismiss();
    document.addEventListener("pointerdown", outside);
    document.addEventListener("keydown", key, true);
    window.addEventListener("scroll", scroll, true);
    window.addEventListener("resize", blur);
    window.addEventListener("blur", blur);
    return () => {
      document.removeEventListener("pointerdown", outside);
      document.removeEventListener("keydown", key, true);
      window.removeEventListener("scroll", scroll, true);
      window.removeEventListener("resize", blur);
      window.removeEventListener("blur", blur);
    };
  }, [open]);
  if (!files.length) return null;
  return <span className="cx-changed-files" ref={root} onBlur={(event) => {
    if (!event.currentTarget.contains(event.relatedTarget as Node)) dismiss();
  }}>
    <button ref={button} type="button" className="cx-changed-files-trigger" aria-label={`${count} changed, ${additions.toLocaleString()} lines added, ${deletions.toLocaleString()} lines removed`}
      aria-expanded={open} aria-controls={open ? id : undefined} aria-haspopup="dialog"
      onPointerEnter={(event) => { if (event.pointerType !== "touch") show(); }} onPointerLeave={leave}
      onFocus={() => { if (!restoringFocus.current) show(); }} onClick={show}>
      <svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M9.5 2.5H4a1 1 0 0 0-1 1v9a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1V6L9.5 2.5Z" stroke="currentColor" strokeLinejoin="round" /><path d="M9 2.5V6h3.5M5.5 9H10M5.5 11H9" stroke="currentColor" strokeLinecap="round" /></svg>
      <span>{count}</span><Counts additions={additions} deletions={deletions} />
    </button>
    {open ? <div ref={panel} id={id} popover="manual" role="dialog" aria-label="Changed files" className="cx-changed-files-popover"
      style={{ ...position, visibility: position ? "visible" : "hidden" }} onPointerEnter={cancelClose} onPointerLeave={leave}>
      <div className="cx-changed-files-heading"><div><strong>Changed files</strong><span>{count} · This turn's edits</span></div>
        <Counts additions={additions} deletions={deletions} /></div>
      <ul className="cx-changed-files-list">{files.map((file) => {
        const normalized = file.path.replace(/\\/g, "/"), slash = normalized.lastIndexOf("/");
        const label = <><span className="cx-changed-file-path"><span className="cx-changed-file-name">{normalized.slice(slash + 1)}</span>
          {slash >= 0 ? <span className="cx-changed-file-dir">{normalized.slice(0, slash + 1)}</span> : null}</span>
          <Counts additions={file.additions} deletions={file.deletions} /></>;
        return <li key={file.path}>{onOpen ? <button type="button" className="cx-changed-file" onClick={() => { dismiss(); onOpen(file.path); }}>{label}</button>
          : <div className="cx-changed-file">{label}</div>}</li>;
      })}</ul>
      <div className="cx-changed-files-foot">{onOpen ? <button type="button" onClick={() => { dismiss(); onOpen(); }}>View all changes <span aria-hidden="true">→</span></button>
        : <span>Lines added / removed across this turn's edits</span>}<kbd>Esc</kbd></div>
    </div> : null}
  </span>;
}
