import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { CSSProperties, KeyboardEvent as ReactKeyboardEvent, ReactNode } from "react";
import { createPortal } from "react-dom";

/** Codex's context-menu glyphs (Lucide outlines, 14 px, drawn in the text colour). */
const MENU_ICONS = {
  rename: <path d="M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z" />,
  pin: <><path d="M12 17v5" /><path d="M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V17h14v-1.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1z" /></>,
  unread: <><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Z" /><circle cx="12" cy="12" r="3" /></>,
  project: <path d="M4 20h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.7-.9L9.6 3.9A2 2 0 0 0 7.9 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z" />,
  section: <><path d="M8 6h13M8 12h13M8 18h13" /><path d="M3 6h.01M3 12h.01M3 18h.01" /></>,
  fork: <><circle cx="6" cy="6" r="3" /><circle cx="6" cy="18" r="3" /><circle cx="18" cy="6" r="3" /><path d="M18 9a9 9 0 0 1-9 9M6 9v6" /></>,
  schedule: <><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></>,
  share: <><path d="M4 12v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8" /><path d="m16 6-4-4-4 4M12 2v13" /></>,
  copy: <><rect x="8" y="8" width="14" height="14" rx="2" /><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2" /></>,
  window: <><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M3 9h18" /></>,
  openIn: <path d="M7 17 17 7M7 7h10v10" />,
  archive: <><rect x="2" y="3" width="20" height="5" rx="1" /><path d="M4 8v11a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8M10 12h4" /></>,
  delete: <><path d="M3 6h18M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" /></>,
  folder: <path d="M4 20h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.7-.9L9.6 3.9A2 2 0 0 0 7.9 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z" />,
  edit: <path d="M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z" />,
  plus: <path d="M12 5v14M5 12h14" />,
  more: <><circle cx="5" cy="12" r="1" /><circle cx="12" cy="12" r="1" /><circle cx="19" cy="12" r="1" /></>,
  spark: <path d="M12 3l1.9 5.6L19.5 10.5l-5.6 1.9L12 18l-1.9-5.6L4.5 10.5l5.6-1.9Z" />,
  // Codex's new-chat mark: a speech bubble holding a terminal prompt.
  codex: <><path d="M21 12a8.5 8.5 0 0 1-12.4 7.6L3 21l1.4-5.4A8.5 8.5 0 1 1 21 12Z" /><path d="m8.5 10 2.5 2-2.5 2M13 14h3" /></>,
  mic: <><rect x="9" y="2" width="6" height="12" rx="3" /><path d="M5 10a7 7 0 0 0 14 0M12 17v5" /></>,
  monitor: <><rect x="2" y="3" width="20" height="14" rx="2" /><path d="M8 21h8M12 17v4" /></>,
  settings: <><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3h0a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8v0a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1Z" /></>,
  repo: <><path d="M4 19.5v-15A2.5 2.5 0 0 1 6.5 2H20v20H6.5a2.5 2.5 0 0 1 0-5H20" /></>,
} satisfies Record<string, ReactNode>;

export type ChatMenuIcon = keyof typeof MENU_ICONS;

/**
 * One Codex context-menu item. An item with no `run` and no `items` is shown disabled with its
 * `reason` as the tooltip: every entry either does something real or says why it can't.
 */
export type ChatMenuItem =
  | { kind?: "item"; label: string; icon?: ChatMenuIcon; shortcut?: string; run?: () => void; items?: ChatMenuItem[]; reason?: string; danger?: boolean; checked?: boolean;
      /** A dimmed value on the right ("main", "No environment"), and an on/off switch drawn after it. */
      detail?: string; toggle?: boolean }
  | { kind: "separator" };

export type ChatMenuState = { x: number; y: number; items: ChatMenuItem[]; label: string } | null;

const actionable = (item: ChatMenuItem) => item.kind !== "separator" && Boolean(item.run || item.items?.length);

/** One of the menu's glyphs, for other Codex chrome (the sidebar's project folders). */
export function ChatGlyph({ name, size = 14 }: { name: ChatMenuIcon; size?: number }) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{MENU_ICONS[name]}</svg>;
}

function MenuIcon({ name }: { name?: ChatMenuIcon }) {
  return <span className="cx-menu-icon" aria-hidden="true">
    {name ? <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">{MENU_ICONS[name]}</svg> : null}
  </span>;
}

function MenuList({ items, label, onClose, autoFocus, style }: {
  items: ChatMenuItem[]; label: string; onClose: () => void; autoFocus?: boolean; style?: CSSProperties;
}) {
  const [submenu, setSubmenu] = useState<number | null>(null);
  const [flip, setFlip] = useState(false);
  const list = useRef<HTMLDivElement>(null);
  const withIcons = items.some((item) => item.kind !== "separator" && item.icon);
  useEffect(() => {
    if (autoFocus) list.current?.querySelector<HTMLButtonElement>("button[role=menuitem]:not([aria-disabled=true])")?.focus();
  }, [autoFocus]);
  // A submenu opens to the right like Codex's, or to the left when it would leave the window.
  useLayoutEffect(() => {
    const box = list.current?.getBoundingClientRect();
    if (style?.position === "absolute" && box && box.right > window.innerWidth - 4) setFlip(true);
  }, [style?.position]);
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
  const placed = flip ? { ...style, left: "auto", right: "100%" } : style;
  return <div ref={list} className="cx-menu" role="menu" aria-label={label} style={placed} onKeyDown={onKeyDown}>
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
            {withIcons ? <MenuIcon name={item.icon} /> : null}
            <span className="cx-menu-label">{item.checked ? "✓ " : ""}{item.label}</span>
            {item.detail ? <span className="cx-menu-detail">{item.detail}</span> : null}
            {item.toggle !== undefined ? <span className={"cx-menu-toggle" + (item.toggle ? " is-on" : "")} aria-hidden="true" /> : null}
            {item.shortcut ? <kbd>{item.shortcut}</kbd> : null}
            {item.items?.length ? <span className="cx-menu-more" aria-hidden="true">›</span> : null}
          </button>
          {submenu === index && item.items?.length
            ? <MenuList items={item.items} label={item.label} autoFocus onClose={() => { setSubmenu(null); (buttons()[index])?.focus(); }}
              style={{ position: "absolute", left: "100%", top: -5 }} />
            : null}
        </div>)}
  </div>;
}

/**
 * A Codex-style context menu at the pointer, kept on screen; closes on outside click, Esc or a choice.
 * It is portalled to <body>: an ancestor with backdrop-filter (the app's .workspace) would
 * otherwise become the containing block of this position:fixed layer and shift it off the pointer.
 */
export function ChatMenu({ menu, onClose }: { menu: ChatMenuState; onClose: () => void }) {
  const root = useRef<HTMLDivElement>(null);
  const anchor = useRef<HTMLSpanElement>(null);
  const [position, setPosition] = useState<{ left: number; top: number } | null>(null);
  const [theme, setTheme] = useState<CSSProperties>({});
  useLayoutEffect(() => {
    if (!menu) { setPosition(null); return; }
    // The palette is set on the chat surface, which the portal leaves; carry the current values.
    const computed = anchor.current ? getComputedStyle(anchor.current) : null;
    if (computed) setTheme({ ...Object.fromEntries(THEME_VARIABLES.map((name) => [name, computed.getPropertyValue(name)])), fontFamily: computed.fontFamily } as CSSProperties);
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
    window.addEventListener("resize", blur);
    return () => { document.removeEventListener("pointerdown", outside); window.removeEventListener("blur", blur); window.removeEventListener("resize", blur); };
  }, [menu, onClose]);
  return <>
    <span ref={anchor} hidden />
    {menu ? createPortal(
      <div ref={root} className="cx-menu-root" style={{ ...theme, left: position?.left ?? menu.x, top: position?.top ?? menu.y, visibility: position ? "visible" : "hidden" }}
        onContextMenu={(event) => event.preventDefault()}>
        <MenuList items={menu.items} label={menu.label} onClose={onClose} autoFocus />
      </div>,
      document.body,
    ) : null}
  </>;
}

/** Palette variables the menu's CSS reads; defined on .ao-workflow for the dark and light themes. */
const THEME_VARIABLES = ["--color-bg-primary", "--color-text-primary", "--ao-line", "--ao-muted", "--ao-red", "--ao-blue", "--ao-green", "--ao-amber", "--cx-hover", "--cx-active"] as const;

/**
 * A position:fixed layer (e.g. a hover card) rendered on <body> with the chat surface's palette,
 * so it sits exactly at the window coordinates it is given. See ChatMenu for why.
 */
export function FloatingLayer({ className, style, children, role, onMouseEnter, onMouseLeave }: {
  className: string; style: CSSProperties; children: ReactNode; role?: string; onMouseEnter?: () => void; onMouseLeave?: () => void;
}) {
  const anchor = useRef<HTMLSpanElement>(null);
  const [theme, setTheme] = useState<CSSProperties>({});
  useLayoutEffect(() => {
    const computed = anchor.current ? getComputedStyle(anchor.current) : null;
    if (computed) setTheme({ ...Object.fromEntries(THEME_VARIABLES.map((name) => [name, computed.getPropertyValue(name)])), fontFamily: computed.fontFamily } as CSSProperties);
  }, []);
  return <>
    <span ref={anchor} hidden />
    {createPortal(<div className={className} role={role} style={{ ...theme, ...style }} onMouseEnter={onMouseEnter} onMouseLeave={onMouseLeave}>{children}</div>, document.body)}
  </>;
}
