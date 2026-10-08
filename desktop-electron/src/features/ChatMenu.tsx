import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { CSSProperties, KeyboardEvent as ReactKeyboardEvent } from "react";

/**
 * One Codex context-menu item. An item with no `run` and no `items` is shown disabled with its
 * `reason` as the tooltip: every entry either does something real or says why it can't.
 */
export type ChatMenuItem =
  | { kind?: "item"; label: string; shortcut?: string; run?: () => void; items?: ChatMenuItem[]; reason?: string; danger?: boolean; checked?: boolean }
  | { kind: "separator" };

export type ChatMenuState = { x: number; y: number; items: ChatMenuItem[]; label: string } | null;

const actionable = (item: ChatMenuItem) => item.kind !== "separator" && Boolean(item.run || item.items?.length);

function MenuList({ items, label, onClose, autoFocus, style }: {
  items: ChatMenuItem[]; label: string; onClose: () => void; autoFocus?: boolean; style?: CSSProperties;
}) {
  const [submenu, setSubmenu] = useState<number | null>(null);
  const list = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (autoFocus) list.current?.querySelector<HTMLButtonElement>("button[role=menuitem]:not([aria-disabled=true])")?.focus();
  }, [autoFocus]);
  const buttons = () => Array.from(list.current?.querySelectorAll<HTMLButtonElement>(":scope > div > button[role=menuitem]") ?? []);
  const onKeyDown = (event: ReactKeyboardEvent) => {
    const all = buttons();
    const at = all.indexOf(document.activeElement as HTMLButtonElement);
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault(); event.stopPropagation();
      const step = event.key === "ArrowDown" ? 1 : -1;
      for (let probe = 1; probe <= all.length; probe += 1) {
        const next = all[(((at + step * probe) % all.length) + all.length) % all.length];
        if (next && next.getAttribute("aria-disabled") !== "true") { next.focus(); break; }
      }
    } else if (event.key === "Escape") {
      event.preventDefault(); event.stopPropagation(); onClose();
    }
  };
  return <div ref={list} className="cx-menu" role="menu" aria-label={label} style={style} onKeyDown={onKeyDown}>
    {items.map((item, index) => item.kind === "separator"
      ? <div key={index} className="cx-menu-sep" role="separator" />
      : <div key={index} className="cx-menu-row" onMouseEnter={() => setSubmenu(item.items?.length ? index : null)}>
          <button type="button" role="menuitem" className={item.danger ? "is-danger" : undefined}
            aria-disabled={!actionable(item)} aria-haspopup={item.items?.length ? "menu" : undefined} aria-expanded={item.items?.length ? submenu === index : undefined}
            aria-checked={item.checked} title={!actionable(item) ? item.reason : undefined}
            onClick={() => {
              if (!actionable(item)) return;
              if (item.items?.length) { setSubmenu(submenu === index ? null : index); return; }
              onClose(); item.run!();
            }}
            onKeyDown={(event) => {
              if (event.key === "ArrowRight" && item.items?.length) { event.preventDefault(); event.stopPropagation(); setSubmenu(index); }
              if (event.key === "ArrowLeft") { event.preventDefault(); event.stopPropagation(); onClose(); }
            }}>
            <span className="cx-menu-label">{item.checked ? "✓ " : ""}{item.label}</span>
            {item.shortcut ? <kbd>{item.shortcut}</kbd> : null}
            {item.items?.length ? <span aria-hidden="true">›</span> : null}
          </button>
          {submenu === index && item.items?.length
            ? <MenuList items={item.items} label={item.label} autoFocus onClose={() => { setSubmenu(null); (buttons()[index])?.focus(); }}
              style={{ position: "absolute", left: "100%", top: 0 }} />
            : null}
        </div>)}
  </div>;
}

/** A Codex-style context menu at the pointer, kept on screen; closes on outside click, Esc or a choice. */
export function ChatMenu({ menu, onClose }: { menu: ChatMenuState; onClose: () => void }) {
  const root = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<{ left: number; top: number } | null>(null);
  useLayoutEffect(() => {
    if (!menu) { setPosition(null); return; }
    const box = root.current?.getBoundingClientRect();
    const width = box?.width ?? 240, height = box?.height ?? 300;
    setPosition({ left: Math.max(4, Math.min(menu.x, window.innerWidth - width - 4)), top: Math.max(4, Math.min(menu.y, window.innerHeight - height - 4)) });
  }, [menu]);
  useEffect(() => {
    if (!menu) return;
    const outside = (event: PointerEvent) => { if (!root.current?.contains(event.target as Node)) onClose(); };
    const blur = () => onClose();
    document.addEventListener("pointerdown", outside);
    window.addEventListener("blur", blur);
    return () => { document.removeEventListener("pointerdown", outside); window.removeEventListener("blur", blur); };
  }, [menu, onClose]);
  if (!menu) return null;
  return <div ref={root} className="cx-menu-root" style={{ left: position?.left ?? menu.x, top: position?.top ?? menu.y, visibility: position ? "visible" : "hidden" }}>
    <MenuList items={menu.items} label={menu.label} onClose={onClose} autoFocus />
  </div>;
}
