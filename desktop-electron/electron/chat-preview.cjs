"use strict";

// Each chat agent's own browser, for previewing what it builds: the web app or API its dev server
// serves on this machine. One preview per AO session (a chat card's agent), drawn in the chat's
// Preview pane while the user looks at it and kept painting in an invisible native host otherwise,
// so the agent can always see, read and use the page it opened.
//
// - Loopback only: http(s) on localhost, *.localhost, 127.0.0.0/8 or [::1]. A page never reaches
//   the app's own services (its debugging port, headless, AO, the agent tools, the proxies):
//   blockedPorts() names them, and any request to one of them is cancelled, from the agent, the
//   page or the user alike. Which loopback origins a chat may open is the caller's decision
//   (`permit`); a page's own links and redirects stay within origins already opened.
// - Nothing of the user's: each preview has its own in-memory partition (no cookies, storage or
//   logins of the app or of the user's browsers), denies every permission (camera, notifications,
//   clipboard, ...), cancels downloads, and opens no other window (a popup to an allowed origin
//   loads in the same preview).
// - Input and screenshots go through the page's own DevTools protocol (webContents.debugger), which
//   works whether or not the preview is on screen.

const crypto = require("node:crypto");
const path = require("node:path");

const VIEWPORT = Object.freeze({ width: 1280, height: 800 });
const MAX_PREVIEWS = 8;
const MAX_CONSOLE = 300;
const MAX_FAILURES = 100;
const LOAD_TIMEOUT_MS = 30_000;
const MAX_WAIT_MS = 10_000;
const MAX_TEXT = 40_000;
const MAX_ELEMENTS = 250;
const MAX_TYPED = 4_000;
// Worst-case JSON escaping stays below the agent MCP server's 1 MB request budget.
const MAX_PANEL_BYTES = 128 * 1024;
// A small offline subset of the native fragment styles. No host APIs or network libraries.
const VISUALIZE_STYLE = `:root{--background:Canvas;--foreground:CanvasText;--card:Canvas;--card-foreground:CanvasText;--popover:Canvas;--popover-foreground:CanvasText;--primary:Highlight;--primary-foreground:HighlightText;--secondary:ButtonFace;--secondary-foreground:ButtonText;--muted:color-mix(in srgb,CanvasText 8%,Canvas);--muted-foreground:color-mix(in srgb,CanvasText 70%,Canvas);--accent:color-mix(in srgb,Highlight 12%,Canvas);--accent-foreground:CanvasText;--border:color-mix(in srgb,CanvasText 20%,Canvas);--input:var(--border);--ring:Highlight;--font-size-base:14px;--destructive:light-dark(#b42318,#ffb4ab);--viz-series-1:Highlight}body{background:var(--background);color:var(--foreground)}.card{background:var(--card);color:var(--card-foreground);padding:16px;border:1px solid var(--border);border-radius:8px}.btn{font:inherit;padding:6px 12px;border:1px solid var(--border);border-radius:6px;background:var(--secondary);color:var(--secondary-foreground)}.btn-primary,button[aria-pressed=true]{background:var(--primary);color:var(--primary-foreground)}.btn-ghost{background:transparent}.btn-block{display:block;width:100%}.viz-row,.viz-controls{display:flex;flex-wrap:wrap;align-items:center;gap:12px}.viz-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,180px),1fr));gap:12px}.form-label{display:block}.form-control,.form-select{box-sizing:border-box;max-width:100%;padding:6px;border:1px solid var(--border);border-radius:4px;background:var(--background);color:var(--foreground)}.form-range{max-width:100%}.text-muted{color:var(--muted-foreground)}.text-small{font-size:12px}.tabular-nums{font-variant-numeric:tabular-nums}.table{border-collapse:collapse;width:100%}.table th,.table td{padding:8px;text-align:start;border-bottom:1px solid var(--border)}.table-responsive{overflow:auto}.sr-only{position:absolute;width:1px;height:1px;overflow:hidden;clip-path:inset(50%)}button,input,select,textarea{max-width:100%}`;
const LIVE_PANEL_URL = "about:blank#live-panel";
// A page script that does not answer within this fails the call.
const EVALUATE_TIMEOUT_MS = 5_000;
// A full-page screenshot is cut at this height (CSS pixels).
const MAX_SHOT_HEIGHT = 6_000;
const MAX_SHOT_WIDTH = 1_280;
// A preview neither shown nor used by its agent this long stops painting (its page's animations
// kept the GPU busy for nothing); the agent's next call wakes it first.
const IDLE_SLEEP_MS = 30_000;
// The partition's proxy: a port nothing serves (discard), which loopback bypasses implicitly.
const BLACK_HOLE_PROXY = "127.0.0.1:9";
const LOOPBACK_NAMES = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

// Load failures where the connection itself broke (not an HTTP error page), and those of them a
// moment later may cure.
const CONNECTION_FAILURES = new Set(["ERR_CONNECTION_RESET", "ERR_CONNECTION_REFUSED", "ERR_CONNECTION_CLOSED",
  "ERR_EMPTY_RESPONSE", "ERR_CONNECTION_ABORTED", "ERR_ADDRESS_UNREACHABLE", "ERR_SOCKET_NOT_CONNECTED"]);
const TRANSIENT_FAILURES = new Set(["ERR_CONNECTION_RESET", "ERR_CONNECTION_CLOSED", "ERR_EMPTY_RESPONSE", "ERR_CONNECTION_ABORTED"]);
const RETRY_DELAY_MS = 750;

/** The same address over IPv4 (127.0.0.1) when it names "localhost", else null. */
function ipv4Alternative(raw) {
  try {
    const url = new URL(raw);
    if (url.hostname.toLowerCase() !== "localhost") return null;
    url.hostname = "127.0.0.1";
    return url.href;
  } catch { return null; }
}

class PreviewError extends Error {}

const portOf = (url) => Number(url.port || (url.protocol === "https:" ? 443 : 80));
const isLoopbackHost = (hostname) => {
  const host = hostname.toLowerCase();
  return LOOPBACK_NAMES.has(host) || host.endsWith(".localhost") || /^127(?:\.\d{1,3}){3}$/.test(host);
};

/**
 * Where a preview may go: `{ url, origin }` for an http(s) loopback address that is not one of the
 * app's own service ports, otherwise `{ refused }` with the reason for the agent.
 */
function previewTarget(raw, { blockedPorts = [] } = {}) {
  let url;
  try { url = new URL(String(raw ?? "").trim()); } catch { return { refused: "That is not a URL; use one like http://localhost:5173/" }; }
  if (url.protocol !== "http:" && url.protocol !== "https:") return { refused: `Only http and https pages open in the preview, not ${url.protocol}` };
  if (url.username || url.password) return { refused: "A preview URL may not carry a user name or password" };
  if (!isLoopbackHost(url.hostname)) {
    return { refused: `The preview opens pages served on this machine only (localhost, 127.0.0.1, [::1]), not ${url.hostname}` };
  }
  if (new Set(blockedPorts.map(Number)).has(portOf(url))) {
    return { refused: `Port ${portOf(url)} belongs to Coding Tools itself; the preview never opens the app's own services` };
  }
  return { url: url.href, origin: url.origin };
}

// Keys the agent may press, as the DevTools protocol names them.
const KEYS = Object.freeze({
  Enter: { code: "Enter", keyCode: 13, text: "\r" }, Tab: { code: "Tab", keyCode: 9 }, Escape: { code: "Escape", keyCode: 27 },
  Backspace: { code: "Backspace", keyCode: 8 }, Delete: { code: "Delete", keyCode: 46 }, Space: { code: "Space", keyCode: 32, key: " ", text: " " },
  ArrowUp: { code: "ArrowUp", keyCode: 38 }, ArrowDown: { code: "ArrowDown", keyCode: 40 },
  ArrowLeft: { code: "ArrowLeft", keyCode: 37 }, ArrowRight: { code: "ArrowRight", keyCode: 39 },
  Home: { code: "Home", keyCode: 36 }, End: { code: "End", keyCode: 35 }, PageUp: { code: "PageUp", keyCode: 33 }, PageDown: { code: "PageDown", keyCode: 34 },
});

const REF = /^[0-9]{1,6}$/;

// Runs in the page: its text and the elements the agent can use, each tagged with a ref that
// stays on the element across snapshots. A password field's value is never read.
const snapshotScript = (maxText, maxElements) => `(() => {
  const selector = 'a[href],button,input,textarea,select,summary,[role=button],[role=link],[role=checkbox],[role=radio],[role=tab],[role=menuitem],[role=option],[role=switch],[contenteditable=""],[contenteditable=true],[onclick],[tabindex]:not([tabindex="-1"])';
  const shown = (el) => { const r = el.getBoundingClientRect(); const s = getComputedStyle(el); return r.width > 0 && r.height > 0 && s.visibility !== "hidden" && s.display !== "none"; };
  const root = document.documentElement;
  let next = Number(root.dataset.ctRefNext || 1);
  const elements = [];
  for (const el of document.querySelectorAll(selector)) {
    if (elements.length >= ${maxElements}) break;
    if (!shown(el)) continue;
    if (!el.dataset.ctRef) el.dataset.ctRef = String(next++);
    const type = el.getAttribute("type") || "";
    const name = (el.getAttribute("aria-label") || el.innerText || el.getAttribute("placeholder") || el.getAttribute("title") || el.getAttribute("alt") || el.getAttribute("name") || "").replace(/\\s+/g, " ").trim().slice(0, 80);
    const item = { ref: el.dataset.ctRef, role: el.getAttribute("role") || el.tagName.toLowerCase() + (type ? ":" + type : ""), name };
    if ("value" in el && el.tagName !== "BUTTON" && type.toLowerCase() !== "password") item.value = String(el.value ?? "").slice(0, 80);
    if (el.disabled) item.disabled = true;
    if (el.checked) item.checked = true;
    if (el.tagName === "A") item.href = el.getAttribute("href").slice(0, 200);
    elements.push(item);
  }
  root.dataset.ctRefNext = String(next);
  const text = (document.body ? document.body.innerText : "").replace(/\\n{3,}/g, "\\n\\n");
  return { url: location.href, title: document.title, text: text.slice(0, ${maxText}), text_truncated: text.length > ${maxText}, elements };
})()`;

// Runs in the page: scrolls an element into view and returns its center, or null when it is gone.
const pointScript = (ref, focus = false, clear = false) => `(() => {
  const el = document.querySelector('[data-ct-ref="${ref}"]');
  if (!el) return null;
  el.scrollIntoView({ block: "center", inline: "center" });
  ${focus ? "el.focus();" : ""}
  ${clear ? "if ('value' in el) { el.value = ''; el.dispatchEvent(new Event('input', { bubbles: true })); } else if (el.isContentEditable) { el.textContent = ''; }" : ""}
  const r = el.getBoundingClientRect();
  return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
})()`;

const object = (properties, required = []) => ({ type: "object", properties, ...(required.length ? { required } : {}), additionalProperties: false });
const refArgument = { type: "string", description: "An element's ref from preview_read" };

/** The preview tools as MCP tool definitions. */
const PREVIEW_TOOL_DEFS = Object.freeze([
  { name: "preview_render", title: "Create or update a live panel",
    description: "Create a live, interactive AI-editable panel in this chat's Preview pane using self-contained HTML, CSS and JavaScript. Call this again to replace the content in the same panel during a later turn. No dev server or file is needed. Use preview_read, preview_click and preview_screenshot to interact and verify it. Network requests, external scripts, app access and downloads are blocked; include everything the panel needs in html. Up to 128 KB of UTF-8 HTML. Use preview_open with a project dev server for larger web apps.",
    inputSchema: object({ html: { type: "string", minLength: 1, maxLength: MAX_PANEL_BYTES } }, ["html"]) },
  { name: "preview_open", title: "Open a page in the preview",
    description: "The browser for checking any web page, frontend or GUI you build or change: open a page your dev server serves on this machine (http://localhost:<port>/... or http://127.0.0.1:<port>/...) in this chat's own browser, which opens the chat's Preview pane for the user. Use it (then preview_screenshot and preview_read) instead of curl, a headless browser or asking the user to open the page. Waits for the page to load. Only localhost, 127.0.0.1 and [::1] addresses open; the first time this chat opens an address, the user may be asked. The page may only reach addresses this chat opened: another port (an API on :3000, a separate hot-reload port), the other spelling of the host (localhost vs 127.0.0.1) and anything on the internet (CDN scripts, web fonts) are blocked and show in preview_console. Open a second local address with preview_open (then return to the page) if the app needs it.",
    inputSchema: object({ url: { type: "string", description: "e.g. http://localhost:5173/" } }, ["url"]) },
  { name: "preview_read", title: "Read the preview page",
    description: "The page's URL, title, visible text and the elements you can use (links, buttons, fields), each with a ref for preview_click and preview_type.",
    inputSchema: object({ max_chars: { type: "integer", minimum: 500, maximum: MAX_TEXT, description: `Text limit (default 12000, at most ${MAX_TEXT})` } }) },
  { name: "preview_screenshot", title: "Screenshot the preview",
    description: "A PNG of what the preview shows now: how the page you opened with preview_open looks to the user.",
    inputSchema: object({ full_page: { type: "boolean", description: "Capture the whole page, not only the visible part" } }) },
  { name: "preview_click", title: "Click in the preview",
    description: "Click an element by its ref from preview_read, or a point (x, y in CSS pixels of the visible page).",
    inputSchema: object({ ref: refArgument, x: { type: "number" }, y: { type: "number" }, double: { type: "boolean" } }) },
  { name: "preview_type", title: "Type in the preview",
    description: "Type text into an element (by ref) or into whatever has focus; `clear` empties the field first and `submit` presses Enter after.",
    inputSchema: object({ ref: refArgument, text: { type: "string" }, clear: { type: "boolean" }, submit: { type: "boolean" } }, ["text"]) },
  { name: "preview_press", title: "Press a key in the preview",
    description: `Press one key: ${Object.keys(KEYS).join(", ")}, or a single character.`,
    inputSchema: object({ key: { type: "string" } }, ["key"]) },
  { name: "preview_scroll", title: "Scroll the preview",
    description: "Scroll the page by dy (down is positive) and dx pixels, or bring an element (by ref) into view.",
    inputSchema: object({ dy: { type: "number" }, dx: { type: "number" }, ref: refArgument }) },
  { name: "preview_navigate", title: "Back, forward or reload the preview",
    description: "Go back, go forward or reload the page (after a code change, if the dev server does not reload it itself).",
    inputSchema: object({ action: { type: "string", enum: ["back", "forward", "reload"] } }, ["action"]) },
  { name: "preview_wait", title: "Wait for the preview",
    description: `Wait until the page shows some text, or for a number of milliseconds (at most ${MAX_WAIT_MS}).`,
    inputSchema: object({ text: { type: "string" }, ms: { type: "integer", minimum: 0, maximum: MAX_WAIT_MS } }) },
  { name: "preview_console", title: "Read the preview's console and failed requests",
    description: "Console messages (errors, warnings, logs) and failed network requests of the preview since `after` (a seq from an earlier call).",
    inputSchema: object({ after: { type: "integer", minimum: 0 }, errors_only: { type: "boolean" } }) },
]);
const PREVIEW_TOOLS = new Set(PREVIEW_TOOL_DEFS.map((tool) => tool.name));

/** Standalone final-answer references only: quoted, fenced and partial tokens have no authority. */
function visualizeReference(answer) {
  if (typeof answer !== "string") return null;
  let fence = null, found = null;
  for (const line of answer.split(/\r?\n/)) {
    if (fence) {
      const close = /^\s{0,3}(`{3,}|~{3,})\s*$/.exec(line)?.[1];
      if (close && close[0] === fence[0] && close.length >= fence.length) fence = null;
      continue;
    }
    const run = /^ {0,3}(`{3,}|~{3,})/.exec(line)?.[1];
    if (run) { fence = run; continue; }
    if (/^ {4}|^\t/.test(line)) continue;
    const match = /^\s*visualize([^\r\n]+)\s*$/.exec(line);
    if (!match) continue;
    if (found) return { error: "This Preview supports one visualization per chat agent. Use one final reference." };
    try {
      const value = JSON.parse(match[1]);
      if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some(key => !["path", "title", "mode"].includes(key))
        || typeof value.path !== "string" || value.path.length > 4096 || /[\u0000-\u001f]/.test(value.path)
        || !path.isAbsolute(value.path) || !/\.html$/i.test(value.path)
        || value.title !== undefined && (typeof value.title !== "string" || value.title.length > 250)
        || value.mode !== undefined && value.mode !== "wide") throw new Error("invalid");
      found = value;
    } catch { return { error: "This visualization reference is invalid. Use an absolute HTML fragment path." }; }
  }
  return found;
}

function visualizeFragmentError(html) {
  if (typeof html !== "string" || !html.trim()) return "The visualization file is empty or unavailable.";
  if (Buffer.byteLength(html, "utf8") > MAX_PANEL_BYTES) return "This Preview supports fragments up to 128 KiB; larger native visualizations are unsupported.";
  if (/<!doctype|<\/?(?:html|head|body)\b/i.test(html)) return "This Preview needs an HTML fragment, not a complete document.";
  if (/\b(?:openai|lucide)\s*(?:\.|\[)|\bTweak\s*(?:\.|\()|\bdata-lucide\s*=/i.test(html)) return "This visualization requires native host APIs that Coding Tools Preview does not provide.";
  if (/<(?:script|link)\b[^>]*\b(?:src|href)\s*=|<(?:iframe|object|embed|base)\b|\b(?:src|href)\s*=\s*["']?https?:|@import\b|url\(\s*["']?https?:|\b(?:fetch|XMLHttpRequest|WebSocket|EventSource)\s*\(/i.test(html)) {
    return "This visualization requires external resources or network APIs. Coding Tools Preview supports offline fragments only.";
  }
  return null;
}

const textResult = (value, isError = false) => ({ content: [{ type: "text", text: JSON.stringify(value) }], structuredContent: value, isError });
const failure = (message) => ({ content: [{ type: "text", text: message }], isError: true });
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * The previews. `createView(partition)` makes a WebContentsView, `attachView`/`detachView` add it to
 * or remove it from the main window, `contentSize()` is the window's content size [width, height],
 * and `blockedPorts()` the app's own loopback service ports.
 */
function createChatPreviews({ createView, attachView, detachView, contentSize = () => [VIEWPORT.width, VIEWPORT.height],
  blockedPorts = () => [], logger = console, now = Date.now, openContextMenu = null } = {}) {
  if (typeof createView !== "function") throw new Error("createView is required");
  const previews = new Map(); // key -> preview
  let shown = null; // { key, bounds }
  let sequence = 0;
  let ownerGeneration = 0;

  const blocked = () => {
    try { return (blockedPorts() || []).map(Number).filter((port) => Number.isInteger(port) && port > 0); } catch { return []; }
  };
  const target = (raw) => previewTarget(raw, { blockedPorts: blocked() });


  /**
   * Whether the page may make this request: http(s) and ws(s) only to an origin this chat opened
   * (a websocket counts as its page's origin), never to an app service port; inline data, blobs and
   * error pages stay local. Anything else (a CDN, another loopback service, the LAN) is refused.
   */
  function requestAllowed(preview, raw) {
    let url;
    try { url = new URL(raw); } catch { return { allowed: false, why: "not a URL" }; }
    if (["data:", "blob:", "about:", "chrome-error:"].includes(url.protocol)) return { allowed: true };
    if (preview.panelMode) return { allowed: false, why: "live panels are offline" };
    const web = { "http:": "http:", "https:": "https:", "ws:": "http:", "wss:": "https:" }[url.protocol];
    if (!web) return { allowed: false, why: `${url.protocol} requests are not allowed` };
    const port = Number(url.port || (web === "https:" ? 443 : 80));
    if (blocked().includes(port)) return { allowed: false, why: "an app service port" };
    const origin = `${web}//${url.host}`;
    return preview.origins.has(origin) ? { allowed: true } : { allowed: false, why: "an address this chat has not opened" };
  }

  function place(preview) {
    const contents = preview.view.webContents;
    if (contents.isDestroyed()) return;
    const visible = shown?.key === preview.key;
    // A clipped view can have a 0x0 native surface even when Blink emulates a viewport.
    // Keep background views at real bounds in their own invisible host.
    const moved = attachView?.(preview.view, visible) === true;
    preview.view.setBounds(visible ? shown.bounds : { x: 0, y: 0, ...VIEWPORT });
    const awake = visible || now() - preview.usedAt < IDLE_SLEEP_MS;
    try { contents.setBackgroundThrottling?.(!awake); } catch { /* destroyed */ }
    // Moved into the other window while already awake (the agent used it within IDLE_SLEEP_MS),
    // setVisible(true) changed nothing, so the page never drew a frame in its new window: the
    // pane stayed white while the page underneath still took clicks. A hide-and-show plus an
    // invalidate makes it paint there; a shown page is invalidated on every placement too.
    if (moved && awake) preview.view.setVisible?.(false);
    preview.view.setVisible?.(awake);
    if (awake && (moved || visible)) { try { contents.invalidate?.(); } catch { /* destroyed */ } }
    clearTimeout(preview.sleepTimer);
    preview.sleepTimer = null;
    if (awake && !visible) {
      preview.sleepTimer = setTimeout(() => place(preview), IDLE_SLEEP_MS + 100);
      preview.sleepTimer.unref?.();
    }
  }

  function remember(preview, list, max, entry) {
    sequence += 1;
    list.push({ seq: sequence, at: now(), ...entry });
    if (list.length > max) list.splice(0, list.length - max);
  }

  function create(key) {
    while (previews.size >= MAX_PREVIEWS) {
      const oldest = [...previews.values()].filter((item) => item.key !== shown?.key).sort((a, b) => a.usedAt - b.usedAt)[0];
      if (!oldest) break;
      close(oldest.key);
    }
    const view = createView(`chat-preview-${crypto.randomUUID()}`);
    const contents = view.webContents;
    const preview = { key, view, origins: new Set(), console: [], failures: [], debuggerReady: false, usedAt: now(), loading: false };
    const session = contents.session;
    session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    session.setPermissionCheckHandler?.(() => false);
    session.on("will-download", (event, item) => { event.preventDefault?.(); item.cancel?.(); });
    // Nothing leaves this machine: every request is held to the origins this chat opened (below),
    // and as a second wall the partition's proxy is a dead port with loopback bypassing it, so a
    // request the filter missed (and the DNS lookup a direct connection would make) goes nowhere.
    // Without that wall no page loads (load() rethrows this).
    preview.ready = typeof session.setProxy === "function"
      ? Promise.resolve(session.setProxy({ proxyRules: BLACK_HOLE_PROXY, proxyBypassRules: "" }))
        .then(() => undefined, () => { throw new PreviewError("The preview's network guard could not be set up, so no page opens"); })
      : Promise.reject(new PreviewError("The preview's network guard is unavailable, so no page opens"));
    preview.ready.catch(() => undefined);
    // WebRTC may not send UDP around the proxy (a STUN request is not a web request).
    try { contents.setWebRTCIPHandlingPolicy?.("disable_non_proxied_udp"); } catch { /* older Electron */ }
    // The app's own services stay unreachable whoever asks, matched by port on any host: a name
    // that resolves to this machine (localtest.me, a rebinding domain, 0.0.0.0, [::ffff:7f00:1])
    // reaches the same listener as localhost does.
    session.webRequest.onBeforeRequest({ urls: ["<all_urls>"] }, (details, callback) => {
      const verdict = previews.get(key) === preview ? requestAllowed(preview, details.url) : { allowed: false, why: "the preview closed" };
      if (!verdict.allowed) remember(preview, preview.failures, MAX_FAILURES, { url: details.url.slice(0, 300), error: `blocked: ${verdict.why}` });
      callback({ cancel: !verdict.allowed });
    });
    session.webRequest.onCompleted({ urls: ["<all_urls>"] }, (details) => {
      if (details.statusCode >= 400) remember(preview, preview.failures, MAX_FAILURES, { url: details.url.slice(0, 300), status: details.statusCode, method: details.method });
    });
    session.webRequest.onErrorOccurred({ urls: ["<all_urls>"] }, (details) => {
      if (details.error !== "net::ERR_ABORTED") remember(preview, preview.failures, MAX_FAILURES, { url: details.url.slice(0, 300), error: details.error, method: details.method });
    });
    contents.setWindowOpenHandler(({ url }) => {
      const allowed = target(url);
      if (!preview.panelMode && allowed.url && preview.origins.has(allowed.origin)) void contents.loadURL(allowed.url).catch(() => undefined);
      return { action: "deny" };
    });
    const guard = (event, url) => {
      const allowed = target(url);
      if (!preview.panelMode && allowed.url && preview.origins.has(allowed.origin)) return;
      event.preventDefault();
      remember(preview, preview.console, MAX_CONSOLE, { level: "warning", text: `Navigation to ${String(url).slice(0, 200)} was blocked: ${allowed.refused ?? "open it with preview_open first"}`, source: "preview" });
    };
    contents.on("will-navigate", guard);
    contents.on("will-redirect", guard);
    // Frames too: an iframe navigates within the origins this chat opened, like the page.
    contents.on("will-frame-navigate", (details) => {
      if (details?.isMainFrame) return;
      guard({ preventDefault: () => details.preventDefault?.() }, details?.url);
    });
    contents.on("console-message", (event, level, message, line, sourceId) => {
      // Electron passes the details on the event; older versions pass them as arguments.
      const details = typeof level === "number"
        ? { level: ["verbose", "info", "warning", "error"][level] ?? "info", message, lineNumber: line, sourceId }
        : { level: event.level, message: event.message, lineNumber: event.lineNumber, sourceId: event.sourceId };
      remember(preview, preview.console, MAX_CONSOLE, {
        level: details.level === "debug" ? "verbose" : details.level, text: String(details.message ?? "").slice(0, 2000),
        ...(details.sourceId ? { source: `${String(details.sourceId).slice(0, 200)}:${details.lineNumber ?? ""}` } : {}),
      });
    });
    contents.on("render-process-gone", (_event, details) => {
      remember(preview, preview.console, MAX_CONSOLE, { level: "error", text: `The page crashed (${details?.reason ?? "unknown"})`, source: "preview" });
    });
    // Right-click: Chrome's menu for what was clicked (a link, an image, a field, a selection, the
    // page), with Inspect; a link opens only within the origins this chat opened.
    contents.on("context-menu", (_event, params) => {
      try {
        openContextMenu?.({ contents, params, openLink: (url) => {
          const allowed = target(url);
          if (!allowed.url || !preview.origins.has(allowed.origin)) return false;
          void contents.loadURL(allowed.url).catch(() => undefined);
          return true;
        }, canOpen: (url) => { const allowed = target(url); return Boolean(!preview.panelMode && allowed.url && preview.origins.has(allowed.origin)); },
          reload: () => run(preview, "preview_navigate", { action: "reload" }).catch(error => logger.warn?.("chat_preview.reload_failed", { message: String(error?.message ?? error) })) });
      } catch { /* a menu that cannot open leaves the page as it is */ }
    });
    contents.on("dom-ready", () => place(preview));
    contents.on("did-start-loading", () => { preview.loading = true; });
    contents.on("did-stop-loading", () => { preview.loading = false; });
    previews.set(key, preview);
    place(preview);
    return preview;
  }

  function close(key) {
    const preview = previews.get(key);
    if (!preview) return;
    previews.delete(key);
    clearTimeout(preview.sleepTimer);
    if (shown?.key === key) shown = null;
    try { detachView?.(preview.view); } catch { /* the window is gone */ }
    const contents = preview.view.webContents;
    // The partition outlives its page in Electron: drop what the page stored and the handlers that
    // hold this preview, so a closed preview keeps nothing.
    try {
      const session = contents.session;
      session.webRequest.onBeforeRequest(null);
      session.webRequest.onCompleted(null);
      session.webRequest.onErrorOccurred(null);
      void Promise.resolve(session.clearStorageData?.()).catch(() => undefined);
      void Promise.resolve(session.clearCache?.()).catch(() => undefined);
    } catch { /* already gone */ }
    try { if (!contents.isDestroyed()) contents.close?.(); } catch { /* already closed */ }
  }

  async function protocol(preview, method, params = {}) {
    const debug = preview.view.webContents.debugger;
    if (!preview.debuggerReady) {
      if (!debug.isAttached()) debug.attach("1.3");
      preview.debuggerReady = true;
      if (!preview.detachHooked) {
        preview.detachHooked = true;
        debug.on("detach", () => { preview.debuggerReady = false; });
      }
    }
    return debug.sendCommand(method, params);
  }

  /** A page script's value; a page that never answers fails the call instead of hanging it. */
  async function evaluate(preview, expression) {
    let timer;
    try {
      const answer = await Promise.race([
        protocol(preview, "Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true, timeout: EVALUATE_TIMEOUT_MS }),
        new Promise((_, reject) => { timer = setTimeout(() => reject(new PreviewError("The page did not answer in time")), EVALUATE_TIMEOUT_MS + 1_000); }),
      ]);
      if (answer?.exceptionDetails) throw new PreviewError(`The page script failed: ${answer.exceptionDetails.text ?? "exception"}`);
      return answer?.result?.value;
    } finally {
      clearTimeout(timer);
    }
  }

  async function loadOnce(contents, url) {
    let timer;
    try {
      await Promise.race([
        contents.loadURL(url),
        new Promise((_, reject) => { timer = setTimeout(() => reject(new PreviewError(`The page did not finish loading within ${LOAD_TIMEOUT_MS / 1000} s`)), LOAD_TIMEOUT_MS); }),
      ]);
      return null;
    } catch (error) {
      if (error instanceof PreviewError) throw error;
      return /ERR_[A-Z_]+/.exec(String(error?.message ?? error))?.[0] ?? "load failed";
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Loads `url`, and when the connection itself failed, the same page over IPv4: "localhost" is
   * tried on [::1] first, where on Windows another listener (WSL's localhost relay, a proxy, a
   * second server) can take or reset the connection while the agent's dev server listens on
   * 127.0.0.1 only; its health check (curl 127.0.0.1) passed while the preview got
   * ERR_CONNECTION_RESET. A reset is also retried once after a moment, as a dev server that is
   * reloading drops its first connections. Returns the URL that loaded.
   */
  async function load(preview, url) {
    const contents = preview.view.webContents;
    // The black-hole proxy is in place before the first request.
    await preview.ready;
    let code = await loadOnce(contents, url);
    if (!code) return url;
    let loaded = url;
    const ipv4 = ipv4Alternative(url);
    if (ipv4 && CONNECTION_FAILURES.has(code)) {
      // The same machine and port: the chat may open it as it may open the address it asked for.
      preview.origins.add(new URL(ipv4).origin);
      const retried = await loadOnce(contents, ipv4);
      if (!retried) return ipv4;
      code = retried;
      loaded = ipv4;
    }
    if (TRANSIENT_FAILURES.has(code)) {
      await sleep(RETRY_DELAY_MS);
      const retried = await loadOnce(contents, loaded);
      if (!retried) return loaded;
      code = retried;
    }
    if (code === "ERR_CONNECTION_REFUSED") {
      throw new PreviewError(`Nothing is listening at ${url} (${code}); start the dev server first, then open it again.`);
    }
    if (CONNECTION_FAILURES.has(code)) {
      throw new PreviewError(`The dev server at ${url} closed the connection (${code})${ipv4 ? `, over ${new URL(ipv4).host} too` : ""}. `
        + "This is the page's server, not the preview: check the server's output, and that it serves http (not https) on that port.");
    }
    throw new PreviewError(`The page did not load (${code}).`);
  }

  const summary = (preview) => {
    const contents = preview.view.webContents;
    return { url: preview.panelMode ? LIVE_PANEL_URL : contents.getURL(), title: contents.getTitle() };
  };

  // Serialize mode changes too: an old panel must be gone before web-page network access resumes.
  async function changePage(preview, change, signal) {
    const current = () => !signal?.aborted && previews.get(preview.key) === preview && !preview.view.webContents.isDestroyed();
    const render = (preview.changing ?? Promise.resolve()).catch(() => undefined).then(async () => {
      if (!current()) throw new PreviewError("This chat's panel request ended.");
      await change(current);
      if (!current()) throw new PreviewError("This chat's panel request ended.");
    });
    preview.changing = render;
    try { await render; } finally { if (preview.changing === render) preview.changing = null; }
  }

  async function renderPanel(preview, html, signal, visualization = preview.visualization === true) {
    await changePage(preview, async current => {
      const source = html ?? preview.html;
      if (typeof source !== "string") throw new PreviewError("This chat has no live panel to restore.");
      preview.panelMode = true;
      const markup = "<!doctype html><meta charset=\"utf-8\"><meta http-equiv=\"Content-Security-Policy\" content=\"default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'\"><meta name=\"viewport\" content=\"width=device-width, initial-scale=1\"><title>Live panel</title><style>:root{color-scheme:light dark}body{margin:0;padding:16px;font:14px system-ui}button,input,select,textarea{font:inherit}" + (visualization ? VISUALIZE_STYLE : "") + "</style>" + source;
      // A fresh opaque origin prevents a panel from inheriting a project's cookies or storage.
      await load(preview, `data:text/html;base64,${Buffer.from(markup, "utf8").toString("base64")}`);
      if (!current()) throw new PreviewError("This chat's panel request ended.");
      preview.view.webContents.navigationHistory?.clear?.();
      preview.html = source;
      preview.visualization = visualization;
    }, signal);
  }

  async function openProjectPage(preview, allowed, signal) {
    await changePage(preview, async current => {
      const wasPanel = preview.panelMode;
      if (wasPanel) await load(preview, "about:blank");
      if (!current()) throw new PreviewError("This chat's preview request ended.");
      // A failed project load must not leave an offline panel reachable with web access enabled.
      if (wasPanel) preview.view.webContents.navigationHistory?.clear?.();
      preview.panelMode = false;
      preview.origins.add(allowed.origin);
      await load(preview, allowed.url);
      if (wasPanel) preview.view.webContents.navigationHistory?.clear?.();
    }, signal);
  }

  async function point(preview, args, { focus = false, clear = false } = {}) {
    if (args.ref !== undefined) {
      if (typeof args.ref !== "string" || !REF.test(args.ref)) throw new PreviewError("ref must be a ref from preview_read");
      const found = await evaluate(preview, pointScript(args.ref, focus, clear));
      if (!found) throw new PreviewError(`No element has ref ${args.ref} now; call preview_read again`);
      return found;
    }
    if (Number.isFinite(args.x) && Number.isFinite(args.y)) return { x: args.x, y: args.y };
    return null;
  }

  async function press(preview, name) {
    const key = KEYS[name] ?? (typeof name === "string" && [...name].length === 1 ? { key: name, text: name } : null);
    if (!key) throw new PreviewError(`Unknown key ${String(name).slice(0, 40)}; use one of ${Object.keys(KEYS).join(", ")} or one character`);
    const base = { key: key.key ?? name, ...(key.code ? { code: key.code } : {}), ...(key.keyCode ? { windowsVirtualKeyCode: key.keyCode } : {}) };
    await protocol(preview, "Input.dispatchKeyEvent", { type: key.text ? "keyDown" : "rawKeyDown", ...base, ...(key.text ? { text: key.text } : {}) });
    await protocol(preview, "Input.dispatchKeyEvent", { type: "keyUp", ...base });
  }

  async function run(preview, name, args) {
    const contents = preview.view.webContents;
    switch (name) {
      case "preview_read": {
        const max = Number.isInteger(args.max_chars) ? Math.min(MAX_TEXT, Math.max(500, args.max_chars)) : 12_000;
        const snapshot = await evaluate(preview, snapshotScript(max, MAX_ELEMENTS));
        if (preview.panelMode && snapshot) snapshot.url = LIVE_PANEL_URL;
        return textResult(snapshot);
      }
      case "preview_screenshot": {
        let clip;
        if (args.full_page === true) {
          // The whole page, cut at MAX_SHOT_HEIGHT so a very long page cannot make a huge image.
          const metrics = await protocol(preview, "Page.getLayoutMetrics");
          const size = metrics?.cssContentSize ?? metrics?.contentSize;
          if (size?.width && size?.height) {
            // At most MAX_SHOT_WIDTH wide (scaled down to fit) and MAX_SHOT_HEIGHT tall after scaling.
            const scale = Math.min(1, MAX_SHOT_WIDTH / size.width);
            clip = { x: 0, y: 0, width: size.width, height: Math.min(size.height, Math.floor(MAX_SHOT_HEIGHT / scale)), scale };
          }
        }
        const shot = await protocol(preview, "Page.captureScreenshot", { format: "png", ...(clip ? { clip, captureBeyondViewport: true } : {}) });
        if (!shot?.data) throw new PreviewError("The preview could not be captured");
        return { content: [{ type: "image", data: shot.data, mimeType: "image/png" }, { type: "text", text: JSON.stringify(summary(preview)) }], isError: false };
      }
      case "preview_click": {
        const at = await point(preview, args);
        if (!at) throw new PreviewError("Give a ref from preview_read, or x and y");
        const count = args.double === true ? 2 : 1;
        await protocol(preview, "Input.dispatchMouseEvent", { type: "mouseMoved", x: at.x, y: at.y });
        for (let click = 1; click <= count; click += 1) {
          await protocol(preview, "Input.dispatchMouseEvent", { type: "mousePressed", x: at.x, y: at.y, button: "left", clickCount: click });
          await protocol(preview, "Input.dispatchMouseEvent", { type: "mouseReleased", x: at.x, y: at.y, button: "left", clickCount: click });
        }
        await sleep(150);
        return textResult({ ok: true, clicked: at, ...summary(preview) });
      }
      case "preview_type": {
        if (typeof args.text !== "string") throw new PreviewError("text is required");
        if (args.text.length > MAX_TYPED) throw new PreviewError(`Type at most ${MAX_TYPED} characters at a time`);
        if (args.ref !== undefined) {
          const at = await point(preview, args, { focus: true, clear: args.clear === true });
          // A click puts the caret where a user's would be.
          await protocol(preview, "Input.dispatchMouseEvent", { type: "mousePressed", x: at.x, y: at.y, button: "left", clickCount: 1 });
          await protocol(preview, "Input.dispatchMouseEvent", { type: "mouseReleased", x: at.x, y: at.y, button: "left", clickCount: 1 });
        }
        if (args.text) await protocol(preview, "Input.insertText", { text: args.text });
        if (args.submit === true) await press(preview, "Enter");
        await sleep(100);
        return textResult({ ok: true, typed: args.text.length, ...summary(preview) });
      }
      case "preview_press":
        await press(preview, args.key);
        await sleep(100);
        return textResult({ ok: true, ...summary(preview) });
      case "preview_scroll": {
        if (args.ref !== undefined) {
          await point(preview, args);
          return textResult({ ok: true });
        }
        await protocol(preview, "Input.dispatchMouseEvent", { type: "mouseWheel", x: 200, y: 200,
          deltaX: Number.isFinite(args.dx) ? args.dx : 0, deltaY: Number.isFinite(args.dy) ? args.dy : 400 });
        await sleep(150);
        return textResult({ ok: true });
      }
      case "preview_navigate": {
        const history = contents.navigationHistory;
        if (args.action === "back") { if (history?.canGoBack?.()) history.goBack(); }
        else if (args.action === "forward") { if (history?.canGoForward?.()) history.goForward(); }
        else if (args.action === "reload") {
          if (preview.panelMode && preview.html) await renderPanel(preview);
          else contents.reload();
        }
        else throw new PreviewError("action must be back, forward or reload");
        await sleep(400);
        return textResult({ ok: true, ...summary(preview) });
      }
      case "preview_wait": {
        if (typeof args.text === "string" && args.text) {
          const until = now() + MAX_WAIT_MS;
          const needle = JSON.stringify(args.text);
          while (now() < until) {
            if (await evaluate(preview, `Boolean(document.body && document.body.innerText.includes(${needle}))`)) return textResult({ ok: true, found: true });
            await sleep(250);
          }
          return textResult({ ok: true, found: false, waited_ms: MAX_WAIT_MS });
        }
        const ms = Number.isInteger(args.ms) ? Math.min(MAX_WAIT_MS, Math.max(0, args.ms)) : 1000;
        await sleep(ms);
        return textResult({ ok: true, waited_ms: ms });
      }
      case "preview_console": {
        const after = Number.isInteger(args.after) ? args.after : 0;
        const errorsOnly = args.errors_only === true;
        const messages = preview.console.filter((entry) => entry.seq > after && (!errorsOnly || entry.level === "error"));
        const failures = preview.failures.filter((entry) => entry.seq > after);
        return textResult({ messages, failed_requests: failures, next_after: sequence });
      }
      default:
        throw new PreviewError(`Unknown preview tool ${name}`);
    }
  }

  return Object.freeze({
    /**
     * One preview tool call for the agent of `key`. `permit(origin)` decides whether this chat may
     * open an origin it has not opened before: true, or the refusal (an MCP result) to return.
     */
    async call(key, name, args = {}, { permit = async () => true, signal, visualization = false } = {}) {
      if (!PREVIEW_TOOLS.has(name)) return failure(`Unknown tool: ${name}`);
      const generation = ownerGeneration;
      if (signal?.aborted) return failure("This chat's preview request was cancelled.");
      try {
        if (name === "preview_render") {
          if (typeof args.html !== "string" || !args.html.trim()) return failure("html must contain the panel's HTML.");
          if (Buffer.byteLength(args.html, "utf8") > MAX_PANEL_BYTES) return failure("The panel HTML is larger than 128 KB.");
          const preview = previews.get(key) ?? create(key);
          preview.usedAt = now();
          place(preview);
          await renderPanel(preview, args.html, signal, visualization);
          return textResult({ ok: true, ...summary(preview) });
        }
        if (name === "preview_open") {
          const allowed = target(args.url);
          if (!allowed.url) return failure(allowed.refused);
          let preview = previews.get(key);
          if (!preview?.origins.has(allowed.origin)) {
            const answer = await permit(allowed.origin);
            if (answer !== true) return answer;
          }
          if (signal?.aborted || generation !== ownerGeneration) return failure("This chat's preview request ended before the address was approved.");
          preview = previews.get(key) ?? create(key);
          preview.usedAt = now();
          place(preview);
          await openProjectPage(preview, allowed, signal);
          return textResult({ ok: true, ...summary(preview) });
        }
        const preview = previews.get(key);
        if (!preview) return failure("This chat has no page open yet; open one with preview_open first.");
        preview.usedAt = now();
        place(preview);
        const hidden = shown?.key !== preview.key;
        const contents = preview.view.webContents;
        try {
          // Keep the page producing frames while its agent interacts, without OS window focus.
          if (hidden) await protocol(preview, "Emulation.setFocusEmulationEnabled", { enabled: true });
          return await run(preview, name, args);
        } finally {
          if (hidden && !contents.isDestroyed()) await protocol(preview, "Emulation.setFocusEmulationEnabled", { enabled: false });
        }
      } catch (error) {
        if (error instanceof PreviewError) return failure(error.message);
        logger.warn?.("chat_preview.call_failed", { tool: name, message: String(error?.message ?? error).slice(0, 300) });
        return failure(`The preview could not do that: ${String(error?.message ?? error).slice(0, 300)}`);
      }
    },
    /** Internal artifact reuse check; never exposes panel source through the UI/tool state. */
    matchesPanel(key, html) {
      const preview = previews.get(key);
      return Boolean(preview?.panelMode && !preview.view.webContents.isDestroyed() && preview.html === html);
    },
    /** What the chat's Preview pane shows for one agent, or null when it has opened nothing. */
    state(key) {
      const preview = previews.get(key);
      if (!preview || preview.view.webContents.isDestroyed()) return null;
      const contents = preview.view.webContents;
      return {
        url: preview.panelMode ? LIVE_PANEL_URL : contents.getURL(), title: contents.getTitle(), loading: preview.loading,
        canGoBack: Boolean(contents.navigationHistory?.canGoBack?.()), canGoForward: Boolean(contents.navigationHistory?.canGoForward?.()),
        errors: preview.console.filter((entry) => entry.level === "error").length + preview.failures.length,
        shown: shown?.key === key,
      };
    },
    /** Draws one agent's preview in the pane at `bounds` (CSS pixels of the app page, scaled by its zoom). */
    show(key, bounds, zoom = 1) {
      const preview = previews.get(key);
      if (!preview) return false;
      const scale = Number.isFinite(zoom) && zoom > 0 ? zoom : 1;
      const [width, height] = contentSize();
      const x = Math.max(0, Math.round(bounds.x * scale));
      const y = Math.max(0, Math.round(bounds.y * scale));
      const scaled = { x, y, width: Math.max(0, Math.min(Math.round(bounds.width * scale), (width || Infinity) - x)),
        height: Math.max(0, Math.min(Math.round(bounds.height * scale), (height || Infinity) - y)) };
      // A slot with no room left (the window's size lagging a resize) would give the page a 0x0
      // surface it never repaints from: it is taken out of the pane instead, until the next show.
      if (scaled.width < 2 || scaled.height < 2) {
        if (shown?.key === key) { shown = null; place(preview); }
        return false;
      }
      const previous = shown?.key && shown.key !== key ? previews.get(shown.key) : null;
      shown = { key, bounds: scaled };
      if (previous) place(previous);
      place(preview);
      return true;
    },
    /**
     * A still of the page shown in the pane, as a JPEG data URL (null when none is shown). The pane
     * draws it in the view's place while something of the app page passes over it (Clawd carried
     * across): the native view is drawn above the whole page and would cover it.
     */
    async snapshot(key) {
      const preview = shown?.key === key ? previews.get(key) : null;
      const contents = preview?.view.webContents;
      if (!contents || contents.isDestroyed()) return null;
      try {
        const image = await contents.capturePage();
        return image.isEmpty() ? null : `data:image/jpeg;base64,${image.toJPEG(80).toString("base64")}`;
      } catch { return null; }
    },
    /**
     * Takes the shown preview out of the pane; it keeps running in the background host. With `key`,
     * only when that agent's page is the one shown: split panes each have a Preview, and one pane
     * hiding its page (Clawd passing over it, its tab closing) took another pane's page off too.
     */
    hide(key) {
      if (key !== undefined && shown?.key !== key) return false;
      const preview = shown ? previews.get(shown.key) : null;
      shown = null;
      if (preview) place(preview);
      return true;
    },
    /** The user's own navigation from the pane: back, forward, reload or a loopback URL. */
    async navigate(key, { action, url } = {}) {
      if (url !== undefined) {
        const saved = previews.get(key);
        if (url === LIVE_PANEL_URL) {
          if (!saved?.html) return { ok: false, error: "This chat has no live panel to restore." };
          try { await renderPanel(saved); return { ok: true }; }
          catch (error) { return { ok: false, error: String(error?.message ?? error) }; }
        }
        const allowed = target(url);
        if (!allowed.url) return { ok: false, error: allowed.refused };
        const preview = previews.get(key) ?? create(key);
        try {
          await openProjectPage(preview, allowed);
        } catch (error) { return { ok: false, error: String(error?.message ?? error) }; }
        return { ok: true };
      }
      const preview = previews.get(key);
      if (!preview) return { ok: false, error: "No page is open" };
      const answer = await run(preview, "preview_navigate", { action });
      return { ok: !answer.isError };
    },
    close,
    closeAll() { ownerGeneration += 1; for (const key of [...previews.keys()]) close(key); },
    /** Re-places the shown preview after the window is resized. */
    relayout() { for (const preview of previews.values()) place(preview); },
  });
}


/**
 * The preview page's right-click menu, as Chrome builds one for what was clicked: a link (open,
 * copy address), an image (copy, copy address), an editable field (undo/redo, cut/copy/paste,
 * select all), selected text (copy), else the page (back, forward, reload, select all); Inspect
 * last. Each entry is enabled as Chrome would enable it. A link opens only within the origins this
 * chat opened (canOpen), as every other navigation of the preview does; downloads stay off, so
 * there is no "Save as".
 */
function previewMenuTemplate({ contents, params, openLink, canOpen, clipboard, reload = () => contents.reload() }) {
  const flags = params?.editFlags ?? {};
  const history = contents.navigationHistory;
  const sections = [];
  // Electron 44+ writes the clipboard asynchronously; a failed copy is not worth a crash.
  const copyText = (text) => Promise.resolve(clipboard?.writeText(text)).catch(() => undefined);
  if (params?.linkURL) {
    sections.push([
      { label: "Open link", enabled: canOpen(params.linkURL), click: () => openLink(params.linkURL) },
      { label: "Copy link address", enabled: Boolean(clipboard), click: () => copyText(params.linkURL) },
    ]);
  }
  if (params?.mediaType === "image" && params.srcURL) {
    sections.push([
      { label: "Copy image", click: () => contents.copyImageAt?.(params.x, params.y) },
      { label: "Copy image address", enabled: Boolean(clipboard), click: () => copyText(params.srcURL) },
    ]);
  }
  if (params?.isEditable) {
    sections.push([
      { label: "Undo", accelerator: "CmdOrCtrl+Z", enabled: flags.canUndo !== false, click: () => contents.undo() },
      { label: "Redo", accelerator: "CmdOrCtrl+Shift+Z", enabled: flags.canRedo !== false, click: () => contents.redo() },
    ], [
      { label: "Cut", accelerator: "CmdOrCtrl+X", enabled: flags.canCut !== false, click: () => contents.cut() },
      { label: "Copy", accelerator: "CmdOrCtrl+C", enabled: flags.canCopy !== false, click: () => contents.copy() },
      { label: "Paste", accelerator: "CmdOrCtrl+V", enabled: flags.canPaste !== false, click: () => contents.paste() },
      { label: "Paste as plain text", accelerator: "CmdOrCtrl+Shift+V", enabled: flags.canPaste !== false, click: () => contents.pasteAndMatchStyle() },
      { label: "Select all", accelerator: "CmdOrCtrl+A", enabled: flags.canSelectAll !== false, click: () => contents.selectAll() },
    ]);
  } else if (params?.selectionText?.trim()) {
    sections.push([{ label: "Copy", accelerator: "CmdOrCtrl+C", click: () => contents.copy() }]);
  } else if (!params?.linkURL && params?.mediaType !== "image") {
    sections.push([
      { label: "Back", accelerator: "Alt+Left", enabled: Boolean(history?.canGoBack?.()), click: () => history?.goBack?.() },
      { label: "Forward", accelerator: "Alt+Right", enabled: Boolean(history?.canGoForward?.()), click: () => history?.goForward?.() },
      { label: "Reload", accelerator: "CmdOrCtrl+R", click: reload },
    ], [
      { label: "Select all", accelerator: "CmdOrCtrl+A", click: () => contents.selectAll() },
    ]);
  }
  sections.push([{ label: "Inspect", click: () => contents.inspectElement?.(params?.x ?? 0, params?.y ?? 0) }]);
  return sections.flatMap((section, index) => (index ? [{ type: "separator" }, ...section] : section));
}

/** Native hosting shared by the app and the Electron regression fixture. */
function createNativeChatPreviews({ BaseWindow, WebContentsView, Menu, clipboard, mainWindow, platform = process.platform, ...options }) {
  let background = null;
  const windows = new WeakSet();
  let previews;
  const closeAll = () => {
    previews.closeAll();
    if (background && !background.isDestroyed()) background.destroy();
    background = null;
  };
  previews = createChatPreviews({
    ...options,
    openContextMenu: Menu ? ({ contents, params, openLink, canOpen, reload }) => {
      const window = mainWindow();
      if (!window || window.isDestroyed()) return;
      const template = previewMenuTemplate({ contents, params, openLink, canOpen, clipboard, reload });
      if (template.length) Menu.buildFromTemplate(template).popup({ window });
    } : null,
    createView: (partition) => {
      const window = mainWindow();
      if (!window || window.isDestroyed()) throw new PreviewError("The preview's window has closed.");
      return new WebContentsView({
        webPreferences: { partition, contextIsolation: true, nodeIntegration: false, sandbox: true, spellcheck: false, backgroundThrottling: false },
      });
    },
    attachView: (view, visible) => {
      const window = mainWindow();
      if (!window || window.isDestroyed()) return;
      if (!visible && (!background || background.isDestroyed())) {
        // Windows needs a shown native surface to paint reliably. Zero opacity, no focus and
        // click-through keep this host invisible and unable to intercept the user's input.
        const needsSurface = platform === "win32" || platform === "darwin";
        background = new BaseWindow({ show: false, frame: false, useContentSize: true, ...VIEWPORT,
          skipTaskbar: true, focusable: false, ...(needsSurface ? { opacity: 0 } : {}) });
        background.setIgnoreMouseEvents(true);
        if (needsSurface) background.showInactive();
      }
      const host = visible ? window : background;
      // Whether the view changed windows: the caller then makes it paint in its new one.
      const moved = !host.contentView.children.includes(view);
      if (moved) host.contentView.addChildView(view);
      if (!windows.has(window)) {
        windows.add(window);
        window.once("closed", closeAll);
        // Back from the tray, a minimize or a (un)maximize, the renderer reports the same slot, so
        // nothing re-placed the page and it could come back white: it is placed and repainted here.
        for (const event of ["restore", "show", "maximize", "unmaximize"]) {
          window.on(event, () => { try { previews.relayout(); } catch { /* closing */ } });
        }
      }
      return moved;
    },
    detachView: (view) => {
      for (const host of [mainWindow(), background]) {
        if (host && !host.isDestroyed() && host.contentView.children.includes(view)) host.contentView.removeChildView(view);
      }
    },
    contentSize: () => {
      const window = mainWindow();
      return window && !window.isDestroyed() ? window.getContentSize() : [VIEWPORT.width, VIEWPORT.height];
    },
  });
  return Object.freeze({ ...previews, closeAll });
}

module.exports = Object.freeze({ PREVIEW_TOOL_DEFS, PREVIEW_TOOLS, createChatPreviews, createNativeChatPreviews, previewMenuTemplate, previewTarget, isLoopbackHost, visualizeReference, visualizeFragmentError });
