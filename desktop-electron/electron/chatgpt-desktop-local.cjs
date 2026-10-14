"use strict";

// The user's own ChatGPT desktop app, the one they run themselves (not a copy Coding Tools
// docks): a still preview of its window and, only when the user sends from the ChatGPT Desktop
// panel, a message typed into its composer. Copies Coding Tools runs are never targeted.
//
// It runs in its own Win32 helper process, so a slow send (UI Automation on a large ChatGPT
// window can take seconds) never holds up the docked window's placement loop.

const { createWin32Helper } = require("./chatgpt-desktop-win32.cjs");

const MAX_MESSAGE_CHARS = 4_000;
const PREVIEW_MAX_WIDTH = 1_280;
const SEND_TIMEOUT_MS = 60_000;
const PREVIEW_STATES = new Set(["ok", "minimized", "hidden", "blank"]);

// Plain text only: line breaks are kept (typed as Shift+Enter), tabs become spaces (a Tab key
// would move focus out of the composer), and other control characters are refused.
function normalizeLocalMessage(value) {
  if (typeof value !== "string") throw new Error("The message must be text");
  const text = value.replace(/\r\n?/g, "\n").replace(/\t/g, "    ").trim();
  if (!text) throw new Error("Type a message first");
  if (text.length > MAX_MESSAGE_CHARS) throw new Error(`Messages are limited to ${MAX_MESSAGE_CHARS} characters`);
  if (/[\u0000-\u0009\u000b-\u001f\u007f]/.test(text)) throw new Error("The message contains control characters");
  return text;
}

function createLocalChatGpt({
  logger,
  platform = process.platform,
  // Command-line marker of Coding Tools' own copies (their slots folder).
  ownedMarker,
  ownedPids = () => [],
  createHelper = () => createWin32Helper({ logger }),
  now = Date.now,
}) {
  let helper = null;
  let target = null; // { pid, hwnd }
  let sending = false;

  const ensureHelper = () => (helper ??= createHelper());

  async function locate() {
    const found = await ensureHelper().call("local-find", {
      exclude: ownedMarker,
      ownedPids: ownedPids().filter((pid) => Number.isSafeInteger(pid) && pid > 0),
    });
    target = found?.pid && Number(found.hwnd) > 0 ? { pid: Number(found.pid), hwnd: Number(found.hwnd) } : null;
    return target;
  }

  function empty(state) {
    return { state, title: null, image: null, width: 0, height: 0, capturedAt: now() };
  }

  async function preview() {
    if (platform !== "win32") return empty("unsupported");
    for (let attempt = 0; attempt < 2; attempt += 1) {
      // The window handle is reused between ticks; it is looked up again when it went away.
      const current = target ?? await locate();
      if (!current) return empty("not-running");
      const shot = await ensureHelper().call("local-capture", { hwnd: current.hwnd, pid: current.pid, maxWidth: PREVIEW_MAX_WIDTH });
      if (shot?.state === "gone") {
        target = null;
        continue;
      }
      const state = PREVIEW_STATES.has(shot?.state) ? shot.state : "blank";
      if (state !== "ok" || typeof shot.data !== "string" || !shot.data) return { ...empty(state === "ok" ? "blank" : state), title: shot?.title ?? null };
      return {
        state,
        title: typeof shot.title === "string" ? shot.title : null,
        image: `data:image/jpeg;base64,${shot.data}`,
        width: Number(shot.width) || 0,
        height: Number(shot.height) || 0,
        capturedAt: now(),
      };
    }
    return empty("not-running");
  }

  // One message at a time, always after a fresh lookup: a cached handle could by now belong to
  // a window that is not the user's ChatGPT.
  async function send(value, { returnTo = 0 } = {}) {
    const text = normalizeLocalMessage(value);
    if (platform !== "win32") throw new Error("Sending to the ChatGPT desktop app works on Windows only");
    if (sending) throw new Error("A message is already being sent");
    sending = true;
    try {
      const current = await locate();
      if (!current) throw new Error("Your ChatGPT desktop app is not open");
      await ensureHelper().call("local-send", {
        hwnd: current.hwnd,
        pid: current.pid,
        text,
        returnTo: Number.isSafeInteger(returnTo) && returnTo > 0 ? returnTo : 0,
      }, SEND_TIMEOUT_MS);
      // Only the length is logged; the message itself stays out of the logs.
      logger?.info?.("chatgpt_desktop.local_message_sent", { characters: text.length });
      return { ok: true, sentAt: now() };
    } catch (error) {
      logger?.warn?.("chatgpt_desktop.local_send_failed", { message: error instanceof Error ? error.message : String(error) });
      throw error;
    } finally {
      sending = false;
    }
  }

  function dispose() {
    const current = helper;
    helper = null;
    target = null;
    current?.dispose();
  }

  return { preview, send, dispose };
}

module.exports = { MAX_MESSAGE_CHARS, createLocalChatGpt, normalizeLocalMessage };
