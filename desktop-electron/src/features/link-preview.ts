import type { LinkPreview } from "../api/contracts";

/** Reads a web page's preview (the main process's `links.preview`). */
export type LinkPreviewLoader = (url: string) => Promise<LinkPreview | null | undefined> | null | undefined;

// How long the pointer rests on a link before its card opens: passing over links shows nothing.
export const LINK_PREVIEW_REST_MS = 350;
const GAP = 6;
const MARGIN = 8;
const CACHE_LIMIT = 100;
// The hovered link's own palette, so a light chat's card stays light under a dark launcher.
// A chat sets no --color-border-heavy, so its own line colour (--ao-line) draws the card's edge.
const PALETTE = ["--color-background-elevated", "--color-text-primary", "--color-text-secondary", "--color-border-heavy", "--ao-line"];
const FILE_KINDS: Record<string, string> = {
  "application/pdf": "PDF",
  "application/zip": "ZIP archive",
  "application/json": "JSON file",
  "application/octet-stream": "File",
  "text/plain": "Text file",
  "text/markdown": "Markdown file",
  "text/csv": "CSV file",
};

type Destination = { href: string; link: Element; x?: number; y?: number };
type Shown = "link" | "loading" | LinkPreview;

function isWeb(href: string): boolean {
  return /^https?:\/\//i.test(href);
}

function hostOf(href: string): string {
  try { return new URL(href).host; } catch { return ""; }
}

/** Why a page has no preview, in a few words; empty when the address alone says enough. */
export function previewReason(reason: string): string {
  const status = /^http-(\d{3})$/.exec(reason)?.[1];
  if (status === "404" || status === "410") return `Page not found (${status})`;
  if (status === "401" || status === "403") return `The site needs a sign-in (${status})`;
  if (status) return `The site answered ${status}`;
  switch (reason) {
    case "private": return "Local address: not previewed";
    case "credentials": return "The link holds a sign-in: not previewed";
    case "timeout": return "The site took too long to answer";
    case "network": return "Couldn't reach the site";
    case "invalid":
    case "unsupported": return "";
    default: return "No preview";
  }
}

function sizeText(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB"];
  let value = bytes / 1024, unit = 0;
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit += 1; }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}

/** What a non-page link downloads: "PDF · 1.2 MB". */
export function fileLabel(contentType: string, size?: number): string {
  const kind = FILE_KINDS[contentType]
    ?? (contentType.startsWith("image/") ? "Image" : contentType.startsWith("video/") ? "Video"
      : contentType.startsWith("audio/") ? "Audio" : "File");
  return typeof size === "number" && size > 0 ? `${kind} · ${sizeText(size)}` : kind;
}

/**
 * A card under (or above) the link the pointer rests on, or the keyboard focuses: the page's icon,
 * site, title, description and share image, then its address. One delegated installer outside the
 * React tree serves every link in the window. The card is inert (no pointer events), so it never
 * covers a click, and it closes on leave, Escape, scrolling, resizing, window blur or a hidden window.
 * Only http(s) links are read, through `load`; any other link shows its address alone.
 */
export function installLinkPreview(doc: Document = document, { load }: { load?: LinkPreviewLoader } = {}): () => void {
  const win = doc.defaultView;
  const card = doc.createElement("div");
  card.className = "cx-link-preview";
  card.setAttribute("aria-hidden", "true");
  card.hidden = true;
  doc.body.append(card);

  let hovered: Destination | null = null, focused: Destination | null = null, shown: Destination | null = null;
  let paletteSource: Element | null = null;
  let timer: number | undefined;
  const previews = new Map<string, Promise<LinkPreview | null>>();

  const hrefAt = (target: EventTarget | null, event?: PointerEvent): Destination | null => {
    const element = target as Element | null;
    const link = typeof element?.closest === "function" ? element.closest("a[href]") : null;
    const raw = link?.getAttribute("href");
    if (!raw || !link || raw.startsWith("#") || /^javascript:/i.test(raw.trim())) return null;
    let href = raw;
    try { href = new URL(raw, doc.baseURI).href; } catch {}
    return event ? { href, link, x: event.clientX, y: event.clientY } : { href, link };
  };
  const same = (a: Destination | null, b: Destination | null) => Boolean(a && b && a.link === b.link && a.href === b.href);

  const node = (tag: string, className: string, text?: string): HTMLElement => {
    const element = doc.createElement(tag);
    element.className = className;
    if (text !== undefined) element.textContent = text;
    return element;
  };

  const place = (destination: Destination) => {
    if (!win) return;
    const rects = Array.from(destination.link.getClientRects?.() ?? []);
    const { x, y } = destination;
    const rect = (x !== undefined && y !== undefined
      ? rects.find((item) => x >= item.left && x <= item.right && y >= item.top && y <= item.bottom)
      : undefined) ?? rects[0] ?? destination.link.getBoundingClientRect();
    const width = card.offsetWidth, height = card.offsetHeight;
    let top = rect.bottom + GAP;
    if (top + height > win.innerHeight - MARGIN && rect.top - GAP - height >= MARGIN) top = rect.top - GAP - height;
    top = Math.max(MARGIN, Math.min(top, win.innerHeight - height - MARGIN));
    const left = Math.max(MARGIN, Math.min(rect.left, win.innerWidth - width - MARGIN));
    card.style.left = `${Math.round(left)}px`;
    card.style.top = `${Math.round(top)}px`;
  };

  const image = (src: string, className: string, onLoad: (element: HTMLImageElement) => void) => {
    const element = node("img", className) as HTMLImageElement;
    element.alt = "";
    element.decoding = "async";
    element.addEventListener("load", () => onLoad(element));
    element.addEventListener("error", () => { element.remove(); if (shown) place(shown); });
    element.src = src;
    return element;
  };

  const render = (destination: Destination, state: Shown) => {
    const page = typeof state === "object" && state.ok && state.kind === "page" ? state : null;
    const file = typeof state === "object" && state.ok && state.kind === "file" ? state : null;
    const failed = typeof state === "object" && !state.ok ? state : null;
    const parts: HTMLElement[] = [];
    if (page?.image?.startsWith("data:image/")) {
      parts.push(image(page.image, "cx-link-preview-image", (element) => {
        // A wide share image runs across the top; a square one (a logo, an avatar) sits beside the title.
        card.dataset.image = element.naturalWidth >= element.naturalHeight * 1.3 ? "wide" : "square";
        if (shown) place(shown);
      }));
    }
    const body = node("div", "cx-link-preview-body");
    const host = hostOf(destination.href);
    if (isWeb(destination.href) && host) {
      const site = node("div", "cx-link-preview-site");
      if (page?.icon?.startsWith("data:image/")) site.append(image(page.icon, "cx-link-preview-icon", () => undefined));
      site.append(node("span", "", page?.siteName || host));
      body.append(site);
    }
    const title = page?.title || (file ? fileLabel(file.contentType, file.size) : "");
    if (title) {
      const heading = node("div", "cx-link-preview-title", title);
      heading.dir = "auto";
      body.append(heading);
    }
    if (page?.description) {
      const description = node("div", "cx-link-preview-description", page.description);
      description.dir = "auto";
      body.append(description);
    }
    const note = state === "loading" ? "Loading preview…" : failed ? previewReason(failed.reason) : "";
    if (note) body.append(node("div", "cx-link-preview-note", note));
    const address = node("div", "cx-link-preview-url", destination.href);
    address.dir = "ltr";
    body.append(address);
    parts.push(body);
    card.dataset.state = typeof state === "string" ? state : state.ok ? state.kind : "error";
    delete card.dataset.image;
    card.replaceChildren(...parts);
    place(destination);
  };

  const preview = (href: string): Promise<LinkPreview | null> | null => {
    if (!load) return null;
    const key = href.replace(/#.*$/, "");
    let pending = previews.get(key);
    if (!pending) {
      pending = Promise.resolve()
        .then(() => load(key))
        .then((value) => value ?? null)
        .catch(() => null);
      // A failed read is asked again on the next hover; an answer is kept (the main process caches too).
      void pending.then((value) => { if (!value && previews.get(key) === pending) previews.delete(key); });
      previews.set(key, pending);
      while (previews.size > CACHE_LIMIT) previews.delete(previews.keys().next().value as string);
    }
    return pending;
  };

  const show = (destination: Destination) => {
    timer = undefined;
    shown = destination;
    if (paletteSource !== destination.link) {
      const palette = win?.getComputedStyle(destination.link);
      for (const name of PALETTE) {
        const value = palette?.getPropertyValue(name).trim();
        if (value) card.style.setProperty(name, value);
        else card.style.removeProperty(name);
      }
      paletteSource = destination.link;
      // A dark card puts the site's icon on a light chip: many favicons are drawn black on nothing.
      const rgb = (win?.getComputedStyle(card).backgroundColor.match(/\d+(?:\.\d+)?/g) ?? []).map(Number);
      card.dataset.tone = rgb.length >= 3 && 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2] < 128 ? "dark" : "light";
    }
    const pending = isWeb(destination.href) ? preview(destination.href) : null;
    card.hidden = false;
    render(destination, pending ? "loading" : "link");
    if (!pending) return;
    void pending.then((value) => {
      if (shown !== destination) return;
      render(destination, value ?? "link");
    });
  };

  const hide = () => {
    if (timer !== undefined) win?.clearTimeout(timer);
    timer = undefined;
    shown = null;
    paletteSource = null;
    if (!card.hidden) card.hidden = true;
  };

  const update = () => {
    const wanted = hovered || focused;
    if (!wanted) return hide();
    if (same(wanted, shown)) return;
    if (timer !== undefined) win?.clearTimeout(timer);
    timer = undefined;
    // Keyboard focus, or a move straight from one open card's link to the next, opens at once.
    if (wanted === focused || shown) return show(wanted);
    timer = win?.setTimeout(() => show(wanted), LINK_PREVIEW_REST_MS);
  };

  const over = (event: PointerEvent) => {
    if (event.pointerType === "touch") return;
    const next = hrefAt(event.target, event);
    if (same(next, hovered)) return;
    hovered = next;
    update();
  };
  const out = (event: PointerEvent) => {
    if (event.pointerType === "touch") return;
    const next = hrefAt(event.relatedTarget, event);
    if (same(next, hovered)) return;
    hovered = next;
    update();
  };
  const focus = (event: FocusEvent) => {
    const target = event.target as Element | null;
    focused = target?.matches?.(":focus-visible") ? hrefAt(target) : null;
    update();
  };
  const unfocus = () => { focused = null; update(); };
  const clear = () => { hovered = focused = null; hide(); };
  const key = (event: KeyboardEvent) => { if (event.key === "Escape") clear(); };
  const visibility = () => { if (doc.hidden) clear(); };
  const scroll = () => { hovered = null; hide(); };

  doc.addEventListener("pointerover", over);
  doc.addEventListener("pointerout", out);
  doc.addEventListener("focusin", focus);
  doc.addEventListener("focusout", unfocus);
  doc.addEventListener("keydown", key);
  doc.addEventListener("visibilitychange", visibility);
  doc.addEventListener("scroll", scroll, true);
  win?.addEventListener("blur", clear);
  win?.addEventListener("resize", scroll);
  return () => {
    hide();
    doc.removeEventListener("pointerover", over);
    doc.removeEventListener("pointerout", out);
    doc.removeEventListener("focusin", focus);
    doc.removeEventListener("focusout", unfocus);
    doc.removeEventListener("keydown", key);
    doc.removeEventListener("visibilitychange", visibility);
    doc.removeEventListener("scroll", scroll, true);
    win?.removeEventListener("blur", clear);
    win?.removeEventListener("resize", scroll);
    card.remove();
  };
}
