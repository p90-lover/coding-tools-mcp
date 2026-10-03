"use strict";

const crypto = require("node:crypto");


const AUTH_HOSTS = new Set(["accounts.google.com", "antigravity.google"]);
const loopback = host => ["localhost", "127.0.0.1", "[::1]"].includes(host);

/** An owned, ephemeral Google browser. No navigation happens until its fixed proxy is installed. */
function createAntigravityAuthBrowser({ BrowserWindow, sessionFor, proxyEnvironment, cleanUserAgent }) {
  const windows = new Set();
  let generation = 0;
  async function open(rawUrl, { signal, onCancel = () => {} } = {}) {
    const openingGeneration = generation;
    const url = new URL(rawUrl);
    if (url.protocol !== "https:" || !AUTH_HOSTS.has(url.hostname) || url.username || url.password) {
      throw new Error("Antigravity sign-in URL is unsafe");
    }
    signal?.throwIfAborted();
    const env = await proxyEnvironment();
    if (openingGeneration !== generation) throw new Error("Antigravity sign-in cancelled");
    if (!env.HTTPS_PROXY) throw new Error("Select an HTTP or HTTPS global proxy in Network Proxy first");
    const proxy = new URL(env.HTTPS_PROXY);
    if (!["http:", "https:"].includes(proxy.protocol)) throw new Error("Antigravity sign-in needs an HTTP or HTTPS proxy");
    const username = decodeURIComponent(proxy.username);
    const password = decodeURIComponent(proxy.password);
    proxy.username = ""; proxy.password = "";
    const browserSession = sessionFor(`antigravity-auth-${crypto.randomUUID()}`);
    await browserSession.setProxy({ mode: "fixed_servers", proxyRules: proxy.origin,
      proxyBypassRules: env.NO_PROXY || "localhost,127.0.0.1,[::1]" });
    signal?.throwIfAborted();
    if (openingGeneration !== generation) throw new Error("Antigravity sign-in cancelled");
    browserSession.setUserAgent(cleanUserAgent(browserSession.getUserAgent()));
    browserSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
    browserSession.setPermissionCheckHandler(() => false);
    const window = new BrowserWindow({
      width: 560, height: 760, show: false, title: "Antigravity — Google sign-in",
      webPreferences: { session: browserSession, contextIsolation: true, nodeIntegration: false, sandbox: true },
    });
    window.webContents.__codingToolsAntigravityAuth = true;
    windows.add(window);
    let finished = false;
    const close = () => {
      finished = true;
      signal?.removeEventListener("abort", close);
      if (!window.isDestroyed()) window.close();
    };
    signal?.addEventListener("abort", close, { once: true });
    window.on("closed", () => {
      windows.delete(window);
      signal?.removeEventListener("abort", close);
      if (!finished) onCancel();
    });
    const safeNavigation = value => {
      try {
        const target = new URL(value);
        return !target.username && !target.password && (target.protocol === "https:" || (target.protocol === "http:" && loopback(target.hostname)));
      } catch { return false; }
    };
    for (const event of ["will-navigate", "will-redirect"]) {
      window.webContents.on(event, (navigation, target) => { if (!safeNavigation(target)) navigation.preventDefault(); });
    }
    window.webContents.setWindowOpenHandler(({ url: target }) => {
      if (safeNavigation(target)) void window.loadURL(target).catch(() => { onCancel(); close(); });
      return { action: "deny" };
    });
    // Credentials are sent only in response to this exact proxy, never to a page.
    window.webContents.on("login", (event, _details, authInfo, callback) => {
      if (!authInfo?.isProxy) return;
      event.preventDefault();
      const matches = String(authInfo.host).replace(/^\[|\]$/g, "").toLowerCase() === proxy.hostname.replace(/^\[|\]$/g, "").toLowerCase()
        && Number(authInfo.port) === Number(proxy.port || (proxy.protocol === "https:" ? 443 : 80));
      callback(...(matches ? [username, password] : []));
    });
    try {
      await window.loadURL(url.toString());
      signal?.throwIfAborted();
      if (!window.isDestroyed()) window.show();
      return { close };
    } catch (error) { close(); throw error; }
  }
  open.closeAll = () => {
    generation += 1;
    for (const window of windows) if (!window.isDestroyed()) window.close();
  };
  return open;
}

module.exports = { createAntigravityAuthBrowser };
