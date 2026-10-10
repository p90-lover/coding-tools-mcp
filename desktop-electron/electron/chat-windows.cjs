"use strict";
// "Open in new window" for a Mission chat: a read-only, live copy of one chat in its own window.
// The window gets no preload, is sandboxed and its page CSP blocks scripts; it never reaches the
// app API, which only the focused main window may call. The main window renders the chat and sends
// the markup here (show), then pushes updates (update) while the chat changes.

const KEY = /^[A-Za-z0-9_-]{1,128}$/;
const MAX_MARKUP = 4 * 1024 * 1024;

function text(value, limit, name) {
  if (typeof value !== "string" || value.length > limit) throw new Error(`Chat window ${name} is invalid`);
  return value;
}

function createChatWindows({ BrowserWindow, logger = console }) {
  const windows = new Map();

  function replaceBody(window, body) {
    // Keeps the reader at the bottom when they were following along, otherwise where they were.
    const script = `(() => { const main = document.querySelector("main"); if (!main) return false;
      const follow = window.innerHeight + window.scrollY >= document.body.scrollHeight - 40;
      main.innerHTML = ${JSON.stringify(body)};
      if (follow) window.scrollTo(0, document.body.scrollHeight); return true; })()`;
    return window.webContents.executeJavaScript(script, false);
  }

  function create(key, title, page) {
    const window = new BrowserWindow({
      width: 780, height: 900, minWidth: 420, minHeight: 320, title, autoHideMenuBar: true, show: false,
      webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true, spellcheck: false },
    });
    window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    window.webContents.on("will-navigate", (event) => event.preventDefault());
    window.webContents.on("will-redirect", (event) => event.preventDefault());
    window.on("page-title-updated", (event) => event.preventDefault());
    window.once("ready-to-show", () => window.show());
    window.on("closed", () => { if (windows.get(key) === window) windows.delete(key); });
    windows.set(key, window);
    void window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(page)}`)
      .catch((error) => logger.warn?.("chat_window.load_failed", { message: String(error?.message || error) }));
    return window;
  }

  return {
    /**
     * mode "open" shows (or creates) the chat's window; mode "update" refreshes it only if it is
     * still open. Returns { open } so the main window can stop pushing to a closed one.
     */
    async show(input = {}) {
      if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Chat window request is invalid");
      const key = text(input.key, 128, "key");
      if (!KEY.test(key)) throw new Error("Chat window key is invalid");
      const title = text(input.title, 240, "title").trim() || "Chat";
      const page = text(input.page, MAX_MARKUP, "page");
      const body = text(input.body, MAX_MARKUP, "body");
      const mode = input.mode === "update" ? "update" : "open";
      let window = windows.get(key);
      if (window?.isDestroyed()) { windows.delete(key); window = undefined; }
      if (!window) {
        if (mode === "update") return { open: false };
        create(key, title, page);
        return { open: true };
      }
      window.setTitle(title);
      const replaced = await replaceBody(window, body).catch(() => false);
      if (!replaced) await window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(page)}`).catch(() => undefined);
      if (mode === "open") { if (window.isMinimized()) window.restore(); window.show(); window.focus(); }
      return { open: true };
    },
    closeAll() {
      for (const window of windows.values()) if (!window.isDestroyed()) window.close();
      windows.clear();
    },
  };
}

module.exports = { createChatWindows };
