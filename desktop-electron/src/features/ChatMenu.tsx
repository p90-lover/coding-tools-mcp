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
  // Settings → Updates: a circular arrow.
  update: <path d="M20 12a8 8 0 1 1-2.34-5.66M20 4v4.5h-4.5" />,
} satisfies Record<string, ReactNode>;

/**
 * Codex 26.1016's own sidebar icons, verbatim (filled 16 px paths from its app-shared bundle:
 * folder-light-16, folder-open-light-16, square-and-pencil-light-16, ellipsis-horizontal-light-16,
 * plus-md-light-16). ChatGlyph draws these where Codex does; the menus keep their outlines.
 */
const CODEX_GLYPHS = {
  "folder": <path fillRule="evenodd" clipRule="evenodd" d="M5.55933 2.14136C6.06479 2.14136 6.55777 2.30207 6.96655 2.59937L7.81812 3.21851C8.04741 3.38523 8.32368 3.47534 8.60718 3.47534H11.9666C13.2874 3.47534 14.3582 4.54606 14.3582 5.86694V11.4666C14.3582 12.7874 13.2874 13.8582 11.9666 13.8582H4.03296C2.71229 13.8579 1.64136 12.7873 1.64136 11.4666V4.53296C1.6416 3.21244 2.71244 2.1416 4.03296 2.14136H5.55933ZM2.69214 7.85913V11.4666C2.69214 12.2074 3.29219 12.8081 4.03296 12.8083H11.9666C12.7075 12.8083 13.3083 12.2075 13.3083 11.4666V7.85913H2.69214ZM4.03296 3.19214C3.29234 3.19238 2.69239 3.79234 2.69214 4.53296V6.80835H13.3083V5.86694C13.3083 5.12596 12.7075 4.52515 11.9666 4.52515H8.60718C8.10172 4.52515 7.60874 4.36541 7.19995 4.06812L6.34839 3.448C6.11917 3.28145 5.84268 3.19214 5.55933 3.19214H4.03296Z" fill="currentColor" />,
  "folderOpen": <path fillRule="evenodd" clipRule="evenodd" d="M4.81201 2.14124C5.31747 2.14124 5.81045 2.30195 6.21924 2.59924L7.0708 3.21838C7.30005 3.38501 7.57645 3.47522 7.85986 3.47522H11.3862C12.0185 3.47532 12.5577 3.67505 12.9692 4.06604C13.3715 4.44832 13.6089 4.9722 13.73 5.54846C13.775 5.76289 13.8477 6.09046 13.9097 6.36682C13.9228 6.42541 13.9351 6.48168 13.9468 6.53381H14.1099C15.0509 6.53385 15.6585 7.52947 15.229 8.36682L13.2769 12.1725C12.8674 12.9704 12.0458 13.4733 11.1489 13.4733H3.49854C2.29874 13.4731 1.42701 12.5185 1.37354 11.4489L1.36963 11.4498L0.72998 4.58167L0.727051 4.55725V4.53284C0.727297 3.21232 1.79813 2.14148 3.11865 2.14124H4.81201ZM5.16357 7.58459C4.67855 7.5847 4.23107 7.8462 3.99365 8.26917L2.56104 10.8219C2.15931 11.5383 2.67708 12.4223 3.49854 12.4225H11.1489C11.6519 12.4225 12.1135 12.1414 12.3433 11.694L14.2954 7.88733C14.3662 7.74877 14.2655 7.58463 14.1099 7.58459H5.16357ZM3.11865 3.19202C2.38162 3.19226 1.78385 3.78642 1.77783 4.52209L2.22119 9.28088L3.07764 7.75549C3.50089 7.00144 4.29887 6.53392 5.16357 6.53381H12.8716C12.8128 6.27117 12.7458 5.96987 12.7026 5.76428C12.6101 5.32415 12.4475 5.01958 12.2456 4.82776C12.0532 4.64496 11.7843 4.52512 11.3862 4.52502H7.85986C7.35447 4.52502 6.86139 4.36522 6.45264 4.06799L5.60107 3.44788C5.37181 3.28123 5.09545 3.19202 4.81201 3.19202H3.11865Z" fill="currentColor" />,
  "compose": <><path d="M6.33325 1.80763C6.62314 1.80763 6.85855 2.04315 6.85864 2.33302C6.85864 2.62297 6.6232 2.85841 6.33325 2.85841H4.66626C3.66786 2.85859 2.85891 3.66765 2.85864 4.66603V11.333C2.85864 12.3316 3.66769 13.1414 4.66626 13.1416H11.3333C12.332 13.1416 13.1418 12.3317 13.1418 11.333V9.66603C13.1421 9.37642 13.3766 9.14179 13.6663 9.14161C13.956 9.14161 14.1914 9.37631 14.1917 9.66603V11.333C14.1917 12.9116 12.9119 14.1914 11.3333 14.1914H4.66626C3.0878 14.1912 1.80786 12.9115 1.80786 11.333V4.66603C1.80813 3.08775 3.08796 1.80781 4.66626 1.80763H6.33325Z" fill="currentColor" /><path fillRule="evenodd" clipRule="evenodd" d="M10.842 2.32228C11.6259 1.55049 12.8863 1.55435 13.6643 2.33204C14.4442 3.11205 14.4469 4.37706 13.6702 5.16017L9.41626 9.4463C9.05652 9.80879 8.59956 10.0601 8.10083 10.1699L6.19263 10.5899C5.7111 10.6958 5.28165 10.2666 5.38794 9.78517L5.80884 7.88185C5.9196 7.38036 6.17342 6.92096 6.53931 6.56056L10.842 2.32228ZM12.9221 3.07521C12.552 2.7051 11.9524 2.70322 11.5793 3.07033L7.27563 7.30861C7.05429 7.52663 6.90125 7.80504 6.83423 8.10841L6.54028 9.43849L7.87524 9.14454C8.17687 9.07807 8.45355 8.92625 8.67114 8.70704L12.9241 4.41993C13.2934 4.04741 13.2928 3.44631 12.9221 3.07521Z" fill="currentColor" /></>,
  "more": <><path d="M3.33362 6.80811C3.99161 6.80828 4.52502 7.34246 4.52502 8.00049C4.52485 8.65837 3.9915 9.19172 3.33362 9.19189C2.67559 9.19189 2.14141 8.65848 2.14124 8.00049C2.14124 7.34235 2.67548 6.80811 3.33362 6.80811Z" fill="currentColor" /><path d="M8.00061 6.80811C8.65849 6.80841 9.19202 7.34254 9.19202 8.00049C9.19184 8.65829 8.65838 9.19159 8.00061 9.19189C7.34258 9.19189 6.8084 8.65848 6.80823 8.00049C6.80823 7.34235 7.34247 6.80811 8.00061 6.80811Z" fill="currentColor" /><path d="M12.6666 6.80811C13.3246 6.80828 13.858 7.34246 13.858 8.00049C13.8579 8.65837 13.3245 9.19172 12.6666 9.19189C12.0088 9.1917 11.4744 8.65836 11.4742 8.00049C11.4742 7.34247 12.0087 6.8083 12.6666 6.80811Z" fill="currentColor" /></>,
  "plus": <path d="M8 2.47461C8.28995 2.47461 8.52539 2.71005 8.52539 3V7.47461H13C13.2899 7.47461 13.5254 7.71005 13.5254 8C13.5254 8.28995 13.2899 8.52539 13 8.52539H8.52539V13C8.52539 13.2899 8.28995 13.5254 8 13.5254C7.71005 13.5254 7.47461 13.2899 7.47461 13V8.52539H3C2.71005 8.52539 2.47461 8.28995 2.47461 8C2.47461 7.71005 2.71005 7.47461 3 7.47461H7.47461V3C7.47461 2.71005 7.71005 2.47461 8 2.47461Z" fill="currentColor" />,
  // Settings (gear-light-16) and its "Back to app" row (arrow-left-lg-light-16), from the same bundle.
  "gear": <><path fillRule="evenodd" clipRule="evenodd" d="M8.00062 5.27979C9.50689 5.27979 10.7289 6.50112 10.7291 8.00733C10.7289 9.51359 9.50693 10.7358 8.00062 10.7358C6.49463 10.7355 5.27328 9.51337 5.27308 8.00733C5.27335 6.50135 6.49467 5.28016 8.00062 5.27979ZM8.00062 6.33057C7.07457 6.33094 6.32413 7.08125 6.32386 8.00733C6.32406 8.93347 7.07453 9.6847 8.00062 9.68506C8.92703 9.68506 9.67816 8.9337 9.67836 8.00733C9.67809 7.08102 8.92699 6.33057 8.00062 6.33057Z" fill="currentColor" /><path fillRule="evenodd" clipRule="evenodd" d="M8.59633 1.24073C9.07592 1.2409 9.51987 1.49692 9.75941 1.91358C9.97218 2.28401 10.2906 2.83827 10.5465 3.28272C10.5982 3.37225 10.694 3.42724 10.7985 3.42725L12.3795 3.42823C12.8587 3.42842 13.3021 3.68417 13.5416 4.09913L14.1295 5.11768C14.3672 5.52975 14.3684 6.03702 14.1334 6.45069L13.2536 8.00147L14.1334 9.54835C14.3685 9.96221 14.3675 10.4711 14.1295 10.8833L13.5416 11.9019C13.302 12.3167 12.8586 12.5726 12.3795 12.5728L10.7975 12.5718C10.6934 12.572 10.5981 12.6281 10.5465 12.7173C10.2906 13.1618 9.97118 13.716 9.75844 14.0864C9.51881 14.5032 9.07511 14.7593 8.59535 14.7593C8.17471 14.7593 7.8383 14.7583 7.40492 14.7583C6.92515 14.7583 6.48146 14.5032 6.24183 14.0864C6.02905 13.716 5.70972 13.1619 5.45375 12.7173C5.40213 12.6278 5.3062 12.5718 5.20179 12.5718H3.62172C3.14243 12.5718 2.69927 12.3159 2.45961 11.9009L1.87172 10.8823C1.63401 10.4703 1.63199 9.963 1.86683 9.54932L2.74769 7.99952L1.86683 6.45069C1.63181 6.03685 1.63375 5.52887 1.87172 5.1167L2.45961 4.09913C2.69922 3.68437 3.14176 3.42844 3.62074 3.42823H5.20179C5.30622 3.42823 5.4021 3.37221 5.45375 3.28272C5.70967 2.83823 6.0281 2.28399 6.24086 1.91358C6.48037 1.49684 6.92432 1.24093 7.40394 1.24073C7.83772 1.24072 8.1753 1.24072 8.59633 1.24073ZM7.40492 2.29053C7.2999 2.29053 7.20281 2.34685 7.15101 2.43702C6.93819 2.80754 6.62008 3.36219 6.3639 3.80713C6.12441 4.2228 5.6814 4.47781 5.20277 4.47803H3.62172C3.51764 4.47803 3.42093 4.53349 3.36879 4.62354L2.7809 5.6421C2.72924 5.7316 2.72899 5.84223 2.77992 5.93213L3.80629 7.73975C3.84008 7.79927 3.86295 7.86466 3.87172 7.93213L3.87562 7.99952C3.87565 8.06812 3.86231 8.13662 3.83656 8.19971L3.80629 8.26026L2.77894 10.0679C2.72805 10.1578 2.72924 10.2684 2.7809 10.3579L3.36879 11.3765C3.42092 11.4666 3.51761 11.522 3.62172 11.522H5.20179C5.68071 11.522 6.12432 11.777 6.3639 12.1929C6.62013 12.6379 6.93914 13.1924 7.15199 13.563C7.20372 13.6529 7.29923 13.7093 7.40394 13.7095C7.83771 13.7095 8.17531 13.7085 8.59633 13.7085C8.70115 13.7083 8.79754 13.653 8.84926 13.563C9.06202 13.1926 9.38023 12.6387 9.63636 12.1939C9.87592 11.7778 10.3195 11.522 10.7985 11.522H12.3795C12.4834 11.5218 12.5794 11.4663 12.6315 11.3765L13.2194 10.3579C13.271 10.2684 13.2714 10.1578 13.2203 10.0679L12.193 8.26026C12.1481 8.18098 12.1256 8.0906 12.1256 7.99952C12.1257 7.90839 12.149 7.818 12.194 7.73878L13.2203 5.93213C13.2712 5.84235 13.2708 5.73252 13.2194 5.64307L12.6315 4.62452C12.5794 4.53428 12.4828 4.47803 12.3786 4.47803L10.7985 4.47901C10.3197 4.47901 9.87697 4.22287 9.63734 3.80713C9.38106 3.36201 9.0621 2.80661 8.84926 2.43604C8.79741 2.34609 8.70021 2.29053 8.59535 2.29053C8.17471 2.29053 7.8383 2.29053 7.40492 2.29053Z" fill="currentColor" /></>,
  "back": <path d="M6.96231 2.96214C7.16727 2.7574 7.49953 2.75742 7.7045 2.96214C7.90913 3.16712 7.9092 3.49939 7.7045 3.70433L3.93301 7.47483H13.3334C13.6232 7.47501 13.8578 7.71038 13.8578 8.00022C13.8577 8.28999 13.6232 8.52544 13.3334 8.52562H3.93301L7.7045 12.2951C7.90924 12.5001 7.90909 12.8323 7.7045 13.0373C7.49953 13.2423 7.16735 13.2422 6.96231 13.0373L2.53067 8.60667L2.47208 8.54124C2.21571 8.22666 2.21566 7.77279 2.47208 7.45823L2.53067 7.3928L6.96231 2.96214Z" fill="currentColor" />,
} satisfies Record<string, ReactNode>;

export type ChatMenuIcon = keyof typeof MENU_ICONS;
export type ChatGlyphName = ChatMenuIcon | keyof typeof CODEX_GLYPHS;

/**
 * One Codex context-menu item. An item with no `run` and no `items` is shown disabled with its
 * `reason` as the tooltip: every entry either does something real or says why it can't.
 */
export type ChatMenuItem =
  | { kind?: "item"; label: string; icon?: ChatMenuIcon; shortcut?: string; run?: () => void; items?: ChatMenuItem[]; reason?: string; danger?: boolean; checked?: boolean;
      /** A dimmed value on the right ("main", "No environment"), and an on/off switch drawn after it. */
      detail?: string; toggle?: boolean }
  | { kind: "separator" };

/** `owner` is the button that opened the menu: a press on it is left to the button, which toggles. */
export type ChatMenuState = { x: number; y: number; items: ChatMenuItem[]; label: string; owner?: Element | null } | null;

const actionable = (item: ChatMenuItem) => item.kind !== "separator" && Boolean(item.run || item.items?.length);

/** One of the menu's glyphs, for other Codex chrome (the sidebar's project folders). */
export function ChatGlyph({ name, size = 14 }: { name: ChatGlyphName; size?: number }) {
  if (name in CODEX_GLYPHS) {
    return <svg width={size} height={size} viewBox="0 0 16 16" fill="none" aria-hidden="true">{CODEX_GLYPHS[name as keyof typeof CODEX_GLYPHS]}</svg>;
  }
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{MENU_ICONS[name as ChatMenuIcon]}</svg>;
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
    } else if (/^[1-9]$/.test(event.key) && !event.ctrlKey && !event.altKey && !event.metaKey) {
      // Claude Code's numbered items ("Open in ▸ 1 Split view"): the digit chooses the item.
      const index = items.findIndex((item) => item.kind !== "separator" && item.shortcut === event.key && actionable(item));
      if (index < 0) return;
      event.preventDefault(); event.stopPropagation();
      list.current?.querySelectorAll<HTMLButtonElement>(":scope > div > button[role=menuitem]")
        [items.slice(0, index).filter((item) => item.kind !== "separator").length]?.click();
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
    const outside = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!root.current?.contains(target) && !menu.owner?.contains(target)) onClose();
    };
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

/**
 * Palette variables the menu's CSS reads; defined on .ao-workflow for the dark and light themes.
 * One missing here falls back to <body>'s dark-theme value: --color-text-secondary did, and the chat
 * details panel's labels, branch and setup lines were white on its light background.
 */
const THEME_VARIABLES = ["--color-bg-primary", "--color-text-primary", "--color-text-secondary", "--ao-line", "--ao-muted", "--ao-red", "--ao-blue", "--ao-green", "--ao-amber", "--cx-hover", "--cx-active"] as const;

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
