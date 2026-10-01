"use strict";

// GPT Browser: an embedded chatgpt.com browser with one persistent session per ChatGPT account.
// Each account lives in its own partition, so its sign-in survives restarts and accounts never
// share cookies. Only the account list (ids, labels, detected emails) is stored here; sessions
// stay inside Chromium's partitions and no password or token is ever read or written.

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { writePrivateFileAtomic } = require("./atomic-file.cjs");

const HOME_URL = "https://chatgpt.com/";
const MAX_ACCOUNTS = 12;
// Background accounts keep their page loaded for instant switching; older ones are unloaded.
const MAX_LIVE_VIEWS = 4;
const ACCOUNT_ID = /^[a-z0-9]{12}$/;
const MAX_LABEL = 64;
const MAX_URL = 4096;

// Hosts a ChatGPT sign-in may pass through. Anything else opens in the system browser.
const SIGN_IN_HOSTS = new Set([
  "chatgpt.com",
  "auth.openai.com",
  "auth0.openai.com",
  "login.openai.com",
  "accounts.openai.com",
  "accounts.google.com",
  "login.microsoftonline.com",
  "login.live.com",
  "appleid.apple.com",
  "idmsa.apple.com",
]);

/** A chatgpt.com page this browser may open on request, or null. */
function chatgptPageUrl(value) {
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_URL) return null;
  let parsed;
  try { parsed = new URL(value.trim()); } catch { return null; }
  if (parsed.protocol !== "https:" || parsed.hostname !== "chatgpt.com") return null;
  if (parsed.username || parsed.password) return null;
  return parsed.toString();
}

function inBrowserHost(value) {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "https:" && SIGN_IN_HOSTS.has(parsed.hostname);
  } catch {
    return false;
  }
}

// Sign-in pages (Google in particular) refuse browsers that announce themselves as Electron.
function cleanUserAgent(value) {
  return String(value || "").replace(/\s+(?:Electron|coding-tools[\w.-]*|Coding Tools)\/\S+/gi, "").trim();
}

const partitionFor = (id) => `persist:gpt-browser-${id}`;

function createGptBrowserHost({
  logger,
  dataRoot,
  createView,
  sessionFor,
  attachView,
  detachView,
  prepareSession = async () => {},
  openExternal = async () => {},
  onChange = () => {},
}) {
  const statePath = path.join(dataRoot, "accounts.json");
  let state = { activeId: null, accounts: [] };
  try {
    const saved = JSON.parse(fs.readFileSync(statePath, "utf8"));
    const accounts = Array.isArray(saved?.accounts)
      ? saved.accounts.filter((entry) => ACCOUNT_ID.test(entry?.id)).slice(0, MAX_ACCOUNTS).map((entry) => ({
        id: entry.id,
        label: typeof entry.label === "string" ? entry.label.slice(0, MAX_LABEL) : "ChatGPT account",
        email: typeof entry.email === "string" ? entry.email.slice(0, 254) : null,
        createdAt: typeof entry.createdAt === "string" ? entry.createdAt : new Date().toISOString(),
      }))
      : [];
    state = { accounts, activeId: accounts.some((entry) => entry.id === saved?.activeId) ? saved.activeId : accounts[0]?.id ?? null };
  } catch (error) {
    if (error?.code !== "ENOENT") logger?.warn?.("gpt_browser.state_unreadable", { message: error.message });
  }

  const pages = new Map(); // id -> { view, url, title, loading, usedAt }
  let surfaceActive = false;
  let bounds = null;
  let attachedId = null;

  function persist() {
    fs.mkdirSync(dataRoot, { recursive: true });
    writePrivateFileAtomic(statePath, `${JSON.stringify(state, null, 2)}\n`);
  }

  function status() {
    const page = state.activeId ? pages.get(state.activeId) : null;
    const history = page?.view.webContents.navigationHistory;
    return {
      accounts: state.accounts.map(({ id, label, email }) => ({ id, label, email })),
      activeId: state.activeId,
      page: page ? {
        url: page.url,
        title: page.title,
        loading: page.loading,
        canGoBack: Boolean(history?.canGoBack()),
        canGoForward: Boolean(history?.canGoForward()),
      } : null,
    };
  }

  const emit = () => { try { onChange(status()); } catch {} };

  function account(id) {
    const found = state.accounts.find((entry) => entry.id === id);
    if (!found) throw new Error("Unknown GPT Browser account");
    return found;
  }

  // Reads only the signed-in email from chatgpt.com's own session endpoint, as the page itself would.
  async function detectEmail(id, contents) {
    try {
      if (!new URL(contents.getURL()).hostname.endsWith("chatgpt.com")) return;
      const email = await contents.executeJavaScript(
        "fetch('/api/auth/session',{credentials:'include'}).then(r=>r.ok?r.json():null).then(j=>j&&j.user&&typeof j.user.email==='string'?j.user.email:null).catch(()=>null)",
        true,
      );
      const entry = state.accounts.find((item) => item.id === id);
      if (!entry) return;
      const next = typeof email === "string" && email.includes("@") ? email.slice(0, 254) : null;
      if (entry.email === next) return;
      entry.email = next;
      persist();
      emit();
    } catch {
      // A page that is mid-navigation or closed simply keeps the previous label.
    }
  }

  function bindPage(id, page) {
    const contents = page.view.webContents;
    contents.setWindowOpenHandler(({ url }) => {
      if (chatgptPageUrl(url)) void contents.loadURL(url).catch(() => {});
      else if (/^https?:/i.test(url)) void openExternal(url);
      return { action: "deny" };
    });
    const guard = (event, url) => {
      if (inBrowserHost(url)) return;
      event.preventDefault();
      if (/^https?:/i.test(url)) void openExternal(url);
    };
    contents.on("will-navigate", guard);
    contents.on("will-redirect", guard);
    const update = () => {
      if (contents.isDestroyed()) return;
      page.url = contents.getURL();
      page.title = contents.getTitle();
      if (state.activeId === id) emit();
    };
    contents.on("did-start-loading", () => { page.loading = true; update(); });
    contents.on("did-stop-loading", () => { page.loading = false; update(); void detectEmail(id, contents); });
    contents.on("did-navigate-in-page", update);
    contents.on("page-title-updated", update);
  }

  async function ensurePage(id, initialUrl = HOME_URL) {
    const existing = pages.get(id);
    if (existing && !existing.view.webContents.isDestroyed()) return existing;
    const partition = partitionFor(id);
    const browserSession = sessionFor(partition);
    browserSession.setUserAgent(cleanUserAgent(browserSession.getUserAgent()));
    await prepareSession(browserSession);
    const view = createView(partition);
    const page = { view, url: initialUrl, title: "ChatGPT", loading: true, usedAt: Date.now() };
    pages.set(id, page);
    bindPage(id, page);
    void view.webContents.loadURL(initialUrl).catch((error) => {
      logger?.warn?.("gpt_browser.load_failed", { message: error instanceof Error ? error.message : String(error) });
    });
    trimLiveViews();
    return page;
  }

  function unload(id) {
    const page = pages.get(id);
    if (!page) return;
    if (attachedId === id) { detachView(page.view); attachedId = null; }
    pages.delete(id);
    if (!page.view.webContents.isDestroyed()) page.view.webContents.close();
  }

  function trimLiveViews() {
    const background = [...pages.entries()]
      .filter(([id]) => id !== state.activeId)
      .sort((a, b) => b[1].usedAt - a[1].usedAt);
    for (const [id] of background.slice(MAX_LIVE_VIEWS - 1)) unload(id);
  }

  // Only the active account's page is ever in the window, and only while the pane is showing.
  function place() {
    const page = state.activeId ? pages.get(state.activeId) : null;
    const wanted = surfaceActive && bounds && page ? state.activeId : null;
    if (attachedId && attachedId !== wanted) {
      const previous = pages.get(attachedId);
      if (previous) detachView(previous.view);
      attachedId = null;
    }
    if (!wanted) return;
    if (attachedId !== wanted) { attachView(page.view); attachedId = wanted; }
    page.view.setBounds(bounds);
  }

  async function activate(id, url) {
    account(id);
    state.activeId = id;
    persist();
    const page = await ensurePage(id, url ?? HOME_URL);
    page.usedAt = Date.now();
    if (url && page.url !== url) await page.view.webContents.loadURL(url).catch(() => {});
    place();
    emit();
    return status();
  }

  return {
    status,
    async addAccount() {
      if (state.accounts.length >= MAX_ACCOUNTS) throw new Error(`GPT Browser holds up to ${MAX_ACCOUNTS} accounts`);
      let id;
      do { id = crypto.randomBytes(9).toString("base64url").toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 12); }
      while (!ACCOUNT_ID.test(id) || state.accounts.some((entry) => entry.id === id));
      state.accounts.push({ id, label: `ChatGPT account ${state.accounts.length + 1}`, email: null, createdAt: new Date().toISOString() });
      return activate(id);
    },
    switchTo(id) {
      if (typeof id !== "string") throw new Error("Unknown GPT Browser account");
      return activate(id);
    },
    async openUrl(value) {
      const url = chatgptPageUrl(value);
      if (!url) throw new Error("Only https://chatgpt.com links open in the GPT Browser");
      if (!state.activeId) throw new Error("Add a ChatGPT account first");
      return activate(state.activeId, url);
    },
    navigate(action) {
      const page = state.activeId ? pages.get(state.activeId) : null;
      if (!page) return status();
      const contents = page.view.webContents;
      if (action === "back" && contents.navigationHistory.canGoBack()) contents.navigationHistory.goBack();
      else if (action === "forward" && contents.navigationHistory.canGoForward()) contents.navigationHistory.goForward();
      else if (action === "reload") contents.reload();
      else if (action === "home") void contents.loadURL(HOME_URL).catch(() => {});
      else if (!["back", "forward"].includes(action)) throw new Error(`Unknown GPT Browser action: ${action}`);
      return status();
    },
    rename(id, label) {
      const entry = account(id);
      const next = typeof label === "string" ? label.trim().slice(0, MAX_LABEL) : "";
      if (!next) throw new Error("Account name cannot be empty");
      entry.label = next;
      persist();
      emit();
      return status();
    },
    // Signs the account out for good: its partition (cookies, storage, cache) is erased.
    async remove(id) {
      account(id);
      unload(id);
      await sessionFor(partitionFor(id)).clearStorageData().catch(() => {});
      state.accounts = state.accounts.filter((entry) => entry.id !== id);
      if (state.activeId === id) state.activeId = state.accounts[0]?.id ?? null;
      persist();
      if (state.activeId) await ensurePage(state.activeId);
      place();
      emit();
      return status();
    },
    async setSurfaceActive(active) {
      surfaceActive = active === true;
      if (surfaceActive && state.activeId) await ensurePage(state.activeId);
      place();
      return status();
    },
    setBounds(next) {
      bounds = next;
      place();
    },
    dispose() {
      for (const id of [...pages.keys()]) unload(id);
    },
  };
}

module.exports = { createGptBrowserHost, chatgptPageUrl, cleanUserAgent, partitionFor, MAX_ACCOUNTS };
