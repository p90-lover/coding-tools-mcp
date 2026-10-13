"use strict";

// Each chat agent's own browser, for previewing what it builds: the web app or API its dev server
// serves on this machine. One preview per AO session (a chat card's agent), drawn in the chat's
// Preview pane while the user looks at it and kept painting just outside the window otherwise,
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

const VIEWPORT = Object.freeze({ width: 1280, height: 800 });
const MAX_PREVIEWS = 8;
const MAX_CONSOLE = 300;
const MAX_FAILURES = 100;
const LOAD_TIMEOUT_MS = 30_000;
const MAX_WAIT_MS = 10_000;
const MAX_TEXT = 40_000;
const MAX_ELEMENTS = 250;
const MAX_TYPED = 4_000;
const LOOPBACK_NAMES = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

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
  { name: "preview_open", title: "Open a page in the preview",
    description: "Open a page your dev server serves on this machine (http://localhost:<port>/...) in this chat's preview, which the user sees in the chat's Preview pane. Waits for the page to load. Only localhost, 127.0.0.1 and [::1] addresses open; the first time this chat opens an address, the user may be asked.",
    inputSchema: object({ url: { type: "string", description: "e.g. http://localhost:5173/" } }, ["url"]) },
  { name: "preview_read", title: "Read the preview page",
    description: "The page's URL, title, visible text and the elements you can use (links, buttons, fields), each with a ref for preview_click and preview_type.",
    inputSchema: object({ max_chars: { type: "integer", minimum: 500, maximum: MAX_TEXT, description: `Text limit (default 12000, at most ${MAX_TEXT})` } }) },
  { name: "preview_screenshot", title: "Screenshot the preview",
    description: "A PNG of what the preview shows now.",
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

const textResult = (value, isError = false) => ({ content: [{ type: "text", text: JSON.stringify(value) }], structuredContent: value, isError });
const failure = (message) => ({ content: [{ type: "text", text: message }], isError: true });
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * The previews. `createView(partition)` makes a WebContentsView, `attachView`/`detachView` add it to
 * or remove it from the main window, `contentSize()` is the window's content size [width, height],
 * and `blockedPorts()` the app's own loopback service ports.
 */
function createChatPreviews({ createView, attachView, detachView, contentSize = () => [VIEWPORT.width, VIEWPORT.height],
  blockedPorts = () => [], logger = console, now = Date.now } = {}) {
  if (typeof createView !== "function") throw new Error("createView is required");
  const previews = new Map(); // key -> preview
  let shown = null; // { key, bounds }
  let sequence = 0;

  const blocked = () => {
    try { return (blockedPorts() || []).map(Number).filter((port) => Number.isInteger(port) && port > 0); } catch { return []; }
  };
  const target = (raw) => previewTarget(raw, { blockedPorts: blocked() });

  function offscreen() {
    const [width, height] = contentSize();
    // Wholly outside the content area, at a real size, so the page keeps a viewport and paints.
    return { x: Math.max(VIEWPORT.width, Math.round(width || 0)) + 1, y: Math.max(VIEWPORT.height, Math.round(height || 0)) + 1, ...VIEWPORT };
  }

  function place(preview) {
    const contents = preview.view.webContents;
    if (contents.isDestroyed()) return;
    const visible = shown?.key === preview.key;
    if (visible) {
      preview.view.setBounds(shown.bounds);
      if (preview.emulated) { try { contents.disableDeviceEmulation(); } catch { /* not ready */ } preview.emulated = false; }
    } else {
      const bounds = offscreen();
      // A view outside the window gets no renderer viewport of its own: give it one.
      try {
        contents.enableDeviceEmulation({ screenPosition: "desktop", screenSize: VIEWPORT, viewPosition: { x: 0, y: 0 },
          deviceScaleFactor: 0, viewSize: VIEWPORT, scale: 1 });
        preview.emulated = true;
      } catch { /* the renderer is not ready; dom-ready places it again */ }
      preview.view.setBounds(bounds);
    }
    preview.view.setVisible?.(true);
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
    const preview = { key, view, origins: new Set(), console: [], failures: [], emulated: false, debuggerReady: false, usedAt: now(), loading: false };
    const session = contents.session;
    session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    session.setPermissionCheckHandler?.(() => false);
    session.on("will-download", (event, item) => { event.preventDefault?.(); item.cancel?.(); });
    // The app's own services stay unreachable from the page, whoever loads it.
    session.webRequest.onBeforeRequest({ urls: ["<all_urls>"] }, (details, callback) => {
      let cancel = false;
      try {
        const url = new URL(details.url);
        cancel = (url.protocol === "http:" || url.protocol === "https:" || url.protocol === "ws:" || url.protocol === "wss:")
          && isLoopbackHost(url.hostname) && blocked().includes(Number(url.port || (url.protocol === "https:" || url.protocol === "wss:" ? 443 : 80)));
      } catch { cancel = false; }
      if (cancel) remember(preview, preview.failures, MAX_FAILURES, { url: details.url.slice(0, 300), error: "blocked: an app service port" });
      callback({ cancel });
    });
    session.webRequest.onCompleted({ urls: ["<all_urls>"] }, (details) => {
      if (details.statusCode >= 400) remember(preview, preview.failures, MAX_FAILURES, { url: details.url.slice(0, 300), status: details.statusCode, method: details.method });
    });
    session.webRequest.onErrorOccurred({ urls: ["<all_urls>"] }, (details) => {
      if (details.error !== "net::ERR_ABORTED") remember(preview, preview.failures, MAX_FAILURES, { url: details.url.slice(0, 300), error: details.error, method: details.method });
    });
    contents.setWindowOpenHandler(({ url }) => {
      const allowed = target(url);
      if (allowed.url && preview.origins.has(allowed.origin)) void contents.loadURL(allowed.url).catch(() => undefined);
      return { action: "deny" };
    });
    const guard = (event, url) => {
      const allowed = target(url);
      if (allowed.url && preview.origins.has(allowed.origin)) return;
      event.preventDefault();
      remember(preview, preview.console, MAX_CONSOLE, { level: "warning", text: `Navigation to ${String(url).slice(0, 200)} was blocked: ${allowed.refused ?? "open it with preview_open first"}`, source: "preview" });
    };
    contents.on("will-navigate", guard);
    contents.on("will-redirect", guard);
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
    contents.on("dom-ready", () => place(preview));
    contents.on("did-start-loading", () => { preview.loading = true; });
    contents.on("did-stop-loading", () => { preview.loading = false; });
    attachView?.(view);
    previews.set(key, preview);
    place(preview);
    return preview;
  }

  function close(key) {
    const preview = previews.get(key);
    if (!preview) return;
    previews.delete(key);
    if (shown?.key === key) shown = null;
    try { detachView?.(preview.view); } catch { /* the window is gone */ }
    try { if (!preview.view.webContents.isDestroyed()) preview.view.webContents.close?.(); } catch { /* already closed */ }
  }

  async function protocol(preview, method, params = {}) {
    const debug = preview.view.webContents.debugger;
    if (!preview.debuggerReady) {
      if (!debug.isAttached()) debug.attach("1.3");
      preview.debuggerReady = true;
      debug.on("detach", () => { preview.debuggerReady = false; });
    }
    return debug.sendCommand(method, params);
  }

  async function evaluate(preview, expression) {
    const answer = await protocol(preview, "Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    if (answer?.exceptionDetails) throw new PreviewError(`The page script failed: ${answer.exceptionDetails.text ?? "exception"}`);
    return answer?.result?.value;
  }

  async function load(preview, url) {
    const contents = preview.view.webContents;
    let timer;
    try {
      await Promise.race([
        contents.loadURL(url),
        new Promise((_, reject) => { timer = setTimeout(() => reject(new PreviewError(`The page did not finish loading within ${LOAD_TIMEOUT_MS / 1000} s`)), LOAD_TIMEOUT_MS); }),
      ]);
    } catch (error) {
      if (error instanceof PreviewError) throw error;
      const code = /ERR_[A-Z_]+/.exec(String(error?.message ?? error))?.[0] ?? "load failed";
      throw new PreviewError(code === "ERR_CONNECTION_REFUSED"
        ? `Nothing is listening at ${url} (${code}); start the dev server first, then open it again.`
        : `The page did not load (${code}).`);
    } finally {
      clearTimeout(timer);
    }
  }

  const summary = (preview) => {
    const contents = preview.view.webContents;
    return { url: contents.getURL(), title: contents.getTitle() };
  };

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
        return textResult(await evaluate(preview, snapshotScript(max, MAX_ELEMENTS)));
      }
      case "preview_screenshot": {
        const shot = await protocol(preview, "Page.captureScreenshot", { format: "png", captureBeyondViewport: args.full_page === true });
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
        else if (args.action === "reload") contents.reload();
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
    async call(key, name, args = {}, { permit = async () => true } = {}) {
      if (!PREVIEW_TOOLS.has(name)) return failure(`Unknown tool: ${name}`);
      try {
        if (name === "preview_open") {
          const allowed = target(args.url);
          if (!allowed.url) return failure(allowed.refused);
          let preview = previews.get(key);
          if (!preview?.origins.has(allowed.origin)) {
            const answer = await permit(allowed.origin);
            if (answer !== true) return answer;
          }
          preview = previews.get(key) ?? create(key);
          preview.usedAt = now();
          preview.origins.add(allowed.origin);
          await load(preview, allowed.url);
          return textResult({ ok: true, ...summary(preview) });
        }
        const preview = previews.get(key);
        if (!preview) return failure("This chat has no page open yet; open one with preview_open first.");
        preview.usedAt = now();
        return await run(preview, name, args);
      } catch (error) {
        if (error instanceof PreviewError) return failure(error.message);
        logger.warn?.("chat_preview.call_failed", { tool: name, message: String(error?.message ?? error).slice(0, 300) });
        return failure(`The preview could not do that: ${String(error?.message ?? error).slice(0, 300)}`);
      }
    },
    /** What the chat's Preview pane shows for one agent, or null when it has opened nothing. */
    state(key) {
      const preview = previews.get(key);
      if (!preview || preview.view.webContents.isDestroyed()) return null;
      const contents = preview.view.webContents;
      return {
        url: contents.getURL(), title: contents.getTitle(), loading: preview.loading,
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
      const previous = shown?.key && shown.key !== key ? previews.get(shown.key) : null;
      shown = { key, bounds: scaled };
      if (previous) place(previous);
      place(preview);
      return true;
    },
    /** Takes the shown preview out of the pane; it keeps running just outside the window. */
    hide() {
      const preview = shown ? previews.get(shown.key) : null;
      shown = null;
      if (preview) place(preview);
    },
    /** The user's own navigation from the pane: back, forward, reload or a loopback URL. */
    async navigate(key, { action, url } = {}) {
      if (url !== undefined) {
        const allowed = target(url);
        if (!allowed.url) return { ok: false, error: allowed.refused };
        const preview = previews.get(key) ?? create(key);
        preview.origins.add(allowed.origin);
        try { await load(preview, allowed.url); } catch (error) { return { ok: false, error: String(error?.message ?? error) }; }
        return { ok: true };
      }
      const preview = previews.get(key);
      if (!preview) return { ok: false, error: "No page is open" };
      const answer = await run(preview, "preview_navigate", { action });
      return { ok: !answer.isError };
    },
    close,
    closeAll() { for (const key of [...previews.keys()]) close(key); },
    /** Re-places the shown preview after the window is resized. */
    relayout() { for (const preview of previews.values()) place(preview); },
  });
}

module.exports = Object.freeze({ PREVIEW_TOOL_DEFS, PREVIEW_TOOLS, createChatPreviews, previewTarget, isLoopbackHost });
