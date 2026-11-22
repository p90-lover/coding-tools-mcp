"use strict";

const crypto = require("node:crypto");


const AUTH_HOSTS = new Set(["accounts.google.com", "antigravity.google"]);
const AUTH_REQUESTS = { urls: [...AUTH_HOSTS].map(host => `https://${host}/*`) };
const DEFAULT_RATE_LIMIT_MS = 60_000;
const loopback = host => ["localhost", "127.0.0.1", "[::1]"].includes(host);

function rateLimitDeadline(headers, receivedAt) {
  const header = Object.entries(headers ?? {}).find(([name]) => name.toLowerCase() === "retry-after");
  const value = String(header?.[1]?.[0] ?? "").trim();
  const deadline = /^\d+$/.test(value) ? receivedAt + Number(value) * 1000 : Date.parse(value);
  return Number.isSafeInteger(deadline) && deadline > receivedAt ? deadline : receivedAt + DEFAULT_RATE_LIMIT_MS;
}

/** An owned, ephemeral Google browser. No navigation happens until its fixed proxy is installed. */
function createAntigravityAuthBrowser({ BrowserWindow, sessionFor, proxyEnvironment, cleanUserAgent,
  now = Date.now, onRateLimited = () => {} }) {
  const windows = new Set();
  let generation = 0;
  let blockedUntil = 0;
  function rateLimitError(at) {
    const seconds = Math.max(1, Math.ceil((blockedUntil - at) / 1000));
    return Object.assign(new Error(`Antigravity sign-in got HTTP 429 (too many requests). Try again in ${seconds} ${seconds === 1 ? "second" : "seconds"}.`),
      { status: 429, code: "ANTIGRAVITY_SIGN_IN_RATE_LIMITED", retryAt: blockedUntil });
  }
  function checkCooldown() {
    const at = now();
    if (at < blockedUntil) throw rateLimitError(at);
  }
  async function open(rawUrl, { signal, onCancel = () => {} } = {}) {
    const openingGeneration = generation;
    const url = new URL(rawUrl);
    if (url.protocol !== "https:" || !AUTH_HOSTS.has(url.hostname) || url.username || url.password) {
      throw new Error("Antigravity sign-in URL is unsafe");
    }
    signal?.throwIfAborted();
    checkCooldown();
    const env = await proxyEnvironment();
    if (openingGeneration !== generation) throw new Error("Antigravity sign-in cancelled");
    if (!env.HTTPS_PROXY) throw new Error("Select an HTTP or HTTPS global proxy on the Proxy page first");
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
    checkCooldown();
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
    let shown = false;
    let failure;
    const close = () => {
      finished = true;
      signal?.removeEventListener("abort", close);
      if (!window.isDestroyed()) window.close();
    };
    signal?.addEventListener("abort", close, { once: true });
    window.on("closed", () => {
      windows.delete(window);
      signal?.removeEventListener("abort", close);
      browserSession.webRequest.onHeadersReceived(null);
      if (!finished) onCancel();
    });
    const throwIfFailed = () => { if (failure) throw failure; };
    browserSession.webRequest.onHeadersReceived(AUTH_REQUESTS, (details, respond) => {
      if (details.resourceType !== "mainFrame" || details.statusCode !== 429) return respond({});
      const at = now();
      blockedUntil = Math.max(blockedUntil, rateLimitDeadline(details.responseHeaders, at));
      failure = rateLimitError(at);
      respond({ cancel: true });
      if (shown) close();
      try { onRateLimited(failure); } catch {}
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
      if (safeNavigation(target)) void window.loadURL(target).catch(() => {
        if (!finished && !failure) onCancel();
        close();
      });
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
      throwIfFailed();
      if (!window.isDestroyed()) { shown = true; window.show(); }
      return { close, throwIfFailed };
    } catch (error) { close(); throw failure ?? error; }
  }
  open.closeAll = () => {
    generation += 1;
    for (const window of windows) if (!window.isDestroyed()) window.close();
  };
  return open;
}

module.exports = { createAntigravityAuthBrowser };
