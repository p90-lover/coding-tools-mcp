const fs = require("node:fs");
const path = require("node:path");
const { createHash, randomBytes } = require("node:crypto");
const { clipboard, WebContentsView, powerMonitor, powerSaveBlocker, shell } = require("electron");
const { writePrivateFileAtomic, writePrivateFileAtomicAsync } = require("./atomic-file.cjs");
const { conversationPatchScript } = require("./chatgpt-conversation-actions.cjs");
const {
  runBrowserHelperOperation,
  verifyConnectorWithBrowserHelper,
} = require("./browser-helper-verifier.cjs");
const { validateConnectorName } = require("./connector-identity.cjs");
const { processRunning } = require("./process-tree.cjs");
const { browserPartitionForLauncherProfile, isBrowserAccountPartition } = require("./profile.cjs");
const { cleanUserAgent } = require("./gpt-browser.cjs");
const { validatePasskeyLoginState } = require("./passkey-login-state.cjs");
const {
  refreshTurnLeasesAfterSuspension,
  shouldBlockSleepForTurns,
  sweepGapIndicatesSuspension,
} = require("./turn-suspension.cjs");
const {
  browserViewVisible,
  constrainBrowserBounds,
  navigateBrowser,
  readBrowserNavigationState,
  scaleBrowserBounds,
  shellZoomActionForInput,
} = require("./browser-state.cjs");

const TEMPORARY_CHAT_URL = "https://chatgpt.com/?temporary-chat=true";
const SAVED_CHAT_URL = "https://chatgpt.com/";
const SAVED_CONVERSATION_PATH = /^\/c\/[0-9a-f-]{36}$/;
const CHATGPT_ORIGIN = "https://chatgpt.com";
// Preserve only a concrete ChatGPT conversation address, never a sign-in page, homepage,
// or a navigation to another origin. The live WebContents URL is the source of truth.
function liveConversationUrl(tab) {
  const contents = tab.view?.webContents;
  let url = tab.url;
  try {
    if (contents && typeof contents.getURL === "function"
      && (typeof contents.isDestroyed !== "function" || !contents.isDestroyed())) {
      url = contents.getURL();
    }
  } catch {
    // A renderer can close between the snapshot and the URL read.
    return undefined;
  }
  if (typeof url !== "string") return undefined;
  try {
    const parsed = new URL(url);
    return parsed.origin === CHATGPT_ORIGIN && SAVED_CONVERSATION_PATH.test(parsed.pathname)
      ? `${parsed.origin}${parsed.pathname}` : undefined;
  } catch {
    return undefined;
  }
}
const IDLE_BROWSER_URL = "data:text/html;charset=utf-8,%3C!doctype%20html%3E%3Chtml%3E%3Chead%3E%3Cmeta%20charset%3D%22utf-8%22%3E%3Ctitle%3ECodex%20Web%20GPT%3C%2Ftitle%3E%3C%2Fhead%3E%3Cbody%3E%3C%2Fbody%3E%3C%2Fhtml%3E#codex-web-gpt-browser-host";
const PRIMARY_VIEW_BOOTSTRAP_TIMEOUT_MS = 10_000;
/** The primary view's idle-document windows at startup: a timed-out load is retried with the next. */
const PRIMARY_VIEW_BOOTSTRAP_ATTEMPTS_MS = Object.freeze([PRIMARY_VIEW_BOOTSTRAP_TIMEOUT_MS, 30_000, 60_000]);
const MAX_BROWSER_VIEW_DIMENSION = 16_384;
// Tabs one ChatGPT account may hold (its setting may lower it), and every account's together.
const MAX_BROWSER_TABS = 5;
const MAX_TOTAL_BROWSER_TABS = 15;
const MAX_CANCELLED_TURN_TRACES = 256;
const MANUAL_SUBMIT_TIMEOUT_MS = 30_000;
const MANUAL_COMPACTION_SUBMIT_TIMEOUT_MS = 120_000;
const MAX_MANUAL_TERMINAL_SIGNALS = 256;
const MAX_MANUAL_PROMPT_CHARS = 1_000_000;
const INTERACTION_MODE_CHANGE_OPERATION = "browser interaction mode change";
const HIDDEN_TURN_VIEWPORT = Object.freeze({ width: 800, height: 600 });
// These are lease/initialization guards only. They do not limit a live ChatGPT turn: active turns
// stay alive as long as the helper keeps heartbeating. They only reclaim a blank surface or a turn
// whose helper disappeared without delivering the normal /v1/turn/end event.
const TURN_HEARTBEAT_SWEEP_MS = 5_000;
const TURN_HEARTBEAT_TIMEOUT_MS = 60_000;
const TURN_TAB_BOOTSTRAP_TIMEOUT_MS = 120_000;
// A finished turn's tab (and its saved ChatGPT chat) is kept this long for the next round of the same
// task, then let go and the chat deleted. 30 minutes left finished task chats in the user's ChatGPT
// history for half an hour; a later round simply starts a new chat with the task's context. The
// time counts from the tab's last use: one being looked at does not run out.
const RETAINED_TURN_TAB_TTL_MS = 5 * 60 * 1000;

/** How long a finished turn's tab stays open for the next turn: the setting, or five minutes. */
function retainedTabTtl(host) {
  const ms = typeof host.retainedTabTtlMs === "function" ? host.retainedTabTtlMs() : null;
  return Number.isFinite(ms) && ms > 0 ? ms : RETAINED_TURN_TAB_TTL_MS;
}

/** The tabs one account may hold: its setting, or the most. */
function tabLimitOf(host, partition) {
  const setting = typeof host.tabLimitFor === "function" ? host.tabLimitFor(partition) : null;
  return Number.isInteger(setting) && setting >= 1 && setting <= MAX_BROWSER_TABS ? setting : MAX_BROWSER_TABS;
}

/** The tabs on one account's partition: its Codex turns' tabs, and the Browser tab's own pages. */
function tabsOnPartition(host, partition) {
  const ownPages = partition === host.partition ? (host.userTabs?.size ?? 0) : 0;
  return ownPages + [...host.turnTabs.values()].filter((tab) => (tab.partition ?? host.partition) === partition).length;
}

// Accounts the Browser tab keeps loaded, the shown one included (GPT Browser keeps 4 as well).
const MAX_WARM_HOMES = 4;
// What a parked account's page keeps of the Browser tab's state.
const HOME_STATE_FIELDS = ["status", "message", "url", "title", "authenticated", "loading", "canGoBack", "canGoForward"];

/**
 * The parked account to unload when more than MAX_WARM_HOMES are loaded, or null to keep them all.
 * `parked`: [{ partition, userTabs: Map, parkedAt: ms, state: { authenticated } }].
 * `turnPartitions`: Set of the partitions Codex turn tabs run on right now.
 */
function parkedHomeToUnload(parked, turnPartitions) {
  // An account a Codex turn runs on stays: unloading it would take the turn's session with it. Of
  // the rest, a page with no tabs of the user's and no sign-in goes first (it costs nothing to
  // load again), then the one parked longest.
  const cost = (home) => (home.userTabs?.size ? 2 : 0) + (home.state?.authenticated ? 1 : 0);
  return parked.filter((home) => !turnPartitions.has(home.partition))
    .sort((a, b) => cost(a) - cost(b) || a.parkedAt - b.parkedAt)[0] ?? null;
}

/**
 * Makes room for one more tab on an account: frees that account's oldest reclaimable tab while it
 * is at its limit, then any account's while all of them together are at the ceiling. Returns null,
 * or the limit that still holds (`evict` false: nothing is freed).
 */
function makeTabRoom(host, partition, evict = true) {
  const limit = tabLimitOf(host, partition);
  while (tabsOnPartition(host, partition) >= limit) {
    if (!evict || !BrowserHost.prototype.evictOldestReclaimableTurnTab.call(host, partition)) return limit;
  }
  while (host.turnTabs.size + (host.userTabs?.size ?? 0) >= MAX_TOTAL_BROWSER_TABS) {
    if (!evict || !BrowserHost.prototype.evictOldestReclaimableTurnTab.call(host)) return MAX_TOTAL_BROWSER_TABS;
  }
  return null;
}

const fullTabsError = (limit) => new Error(
  `ChatGPT Web already has ${limit} browser tabs; close one before starting another turn to avoid excessive parallel traffic on the ChatGPT account`,
);
const BROWSER_NAVIGATION_TIMEOUT_MS = 60_000;
const CHATGPT_AUTH_SESSION_TIMEOUT_MS = 5_000;
// The open page's own session request (the fallback when Cloudflare answers the app's request)
// took 2.6 s on a busy machine and more than 5 s while a turn had just ended.
const CHATGPT_AUTH_PAGE_TIMEOUT_MS = 15_000;
// How long a confirmed ChatGPT session vouches for a check that could not tell.
const CHATGPT_AUTH_RECENT_MS = 10 * 60_000;
/**
 * Whether a session check's answer came from the session endpoint itself. Electron's session.fetch
 * can hand back a response with no url: the exact comparison rejected every answer (169 warnings
 * in the log, each status 200 with the session JSON) and sent each minute's check through the
 * page. With redirects manual, an answer from anywhere else comes back as a redirect.
 */
function sessionEndpointUrl(url) {
  if (!url) return true;
  try {
    const parsed = new URL(url);
    return parsed.origin === CHATGPT_ORIGIN && parsed.pathname === "/api/auth/session";
  } catch { return false; }
}
const urlWithoutQuery = (url) => { try { const parsed = new URL(url); return parsed.origin + parsed.pathname; } catch { return url ? "(not a URL)" : ""; } };
function authenticatedChatGptSession(payload, now = Date.now()) {
  const user = payload?.user;
  if (!user || typeof user !== "object" || Array.isArray(user) || !Object.keys(user).length) return false;
  if (payload.error !== undefined && payload.error !== null && payload.error !== "") return false;
  return payload.expires === undefined || payload.expires === null
    || (typeof payload.expires === "string" && Number.isFinite(Date.parse(payload.expires))
      && Date.parse(payload.expires) > now);
}

const WINDOW_VISIBILITY_EVENTS = ["show", "hide", "minimize", "restore"];
const CHATGPT_BACKEND_REQUEST_FILTER = { urls: [`${CHATGPT_ORIGIN}/backend-api/*`] };
const ZOOM_FACTORS = [0.5, 0.67, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2];
const SHELL_ZOOM_LEVEL_STEP = 0.5;
const SHELL_ZOOM_LEVEL_LIMIT = 5;
const AUTH_PROVIDER_HOSTS = new Set([
  "auth.openai.com",
  "auth0.openai.com",
  "login.openai.com",
  "accounts.openai.com",
  "accounts.google.com",
  "login.microsoftonline.com",
  "appleid.apple.com",
  "idmsa.apple.com",
]);
const CLOUDFLARE_CHALLENGE_RECOVERY_DELAY_MS = 500;
const CLOUDFLARE_CHALLENGE_RECOVERY_SETTLE_MS = 1_000;
const COMPOSER_SELECTOR = [
  '[data-testid="prompt-textarea"]',
  "#prompt-textarea",
  '[contenteditable="true"][data-lexical-editor="true"]',
  '[contenteditable="true"][role="textbox"]',
  "textarea",
].join(", ");
// Pages built for OpenAI's desktop shell (chatgpt.com's Codex UI) mark their fixed header as a
// window drag region. Inside this window Electron honours that, so the page's top row would move
// the window instead of taking clicks. An embedded page never owns the window frame.
const PAGE_NO_DRAG_CSS = "*, *::before, *::after { -webkit-app-region: no-drag !important; }";

// A running turn's tab is unthrottled so its stream never slows, and Chromium then updates the page
// at the display's frame rate while nobody sees it. ChatGPT fades in each streamed segment; in a
// view that presents no frames those animations never start, and 50-65 of them sat pending per tab,
// keeping it at 160+ updates a second (about 18-25% of a core per tab, measured 2026-10-24). Zero
// durations end every animation at once in its end state, so what the turn reads (an element's
// final opacity) is unchanged. The tab gets its animations back when the person looks at it.
const HIDDEN_TURN_STILL_CSS = "*, *::before, *::after { animation-duration: 0s !important; animation-delay: 0s !important;"
  + " transition-duration: 0s !important; transition-delay: 0s !important; }";

function keepPageOutOfWindowFrame(contents) {
  contents.on("dom-ready", () => {
    if (!contents.isDestroyed()) void contents.insertCSS(PAGE_NO_DRAG_CSS, { cssOrigin: "user" }).catch(() => {});
  });
}

// Sign-in pages (Google in particular) refuse a browser that announces itself as Electron: GPT
// Browser drops it and signs in; the Browser tab's accounts did not. The session's agent covers
// pages made later (sign-in popups too); a page that already exists keeps its own, so it is set too.
function signInFriendlyUserAgent(contents) {
  const browserSession = contents?.session;
  if (typeof browserSession?.getUserAgent !== "function") return;
  const clean = cleanUserAgent(browserSession.getUserAgent());
  if (clean !== browserSession.getUserAgent()) browserSession.setUserAgent(clean);
  if (typeof contents.setUserAgent === "function") contents.setUserAgent(clean);
}

const CHATGPT_VIEWPORT_CSS = `
  html,
  body {
    width: 100% !important;
    max-width: 100% !important;
    overflow-x: hidden !important;
    overscroll-behavior-x: none !important;
  }

  #__next {
    width: 100% !important;
    max-width: 100% !important;
    min-width: 0 !important;
    overflow-x: hidden !important;
  }
`;

const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

function javaScriptLiteral(value) {
  return JSON.stringify(value).replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
}

function combinedError(primary, label, secondary) {
  const first = primary instanceof Error ? primary.message : String(primary);
  const second = secondary instanceof Error ? secondary.message : String(secondary);
  return new Error(`${first}; ${label}: ${second}`);
}

function visibleElementScript(selector) {
  return `Array.from(document.querySelectorAll(${JSON.stringify(selector)})).find((element) => {
    const style = getComputedStyle(element);
    const bounds = element.getBoundingClientRect();
    return element.isConnected
      && bounds.width > 0
      && bounds.height > 0
      && style.display !== "none"
      && style.visibility !== "hidden"
      && style.opacity !== "0";
  })`;
}

function normalizeBounds(bounds) {
  const read = (value) => Number.isFinite(value) ? Math.max(0, Math.round(value)) : 0;
  return {
    x: Math.min(MAX_BROWSER_VIEW_DIMENSION, read(bounds?.x)),
    y: Math.min(MAX_BROWSER_VIEW_DIMENSION, read(bounds?.y)),
    width: Math.min(MAX_BROWSER_VIEW_DIMENSION, Math.max(1, read(bounds?.width))),
    height: Math.min(MAX_BROWSER_VIEW_DIMENSION, Math.max(1, read(bounds?.height))),
  };
}

function allowedAuthUrl(value) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    return false;
  }
  if (parsed.protocol !== "https:") return false;
  if (parsed.hostname === "chatgpt.com") {
    return parsed.pathname === "/auth"
      || parsed.pathname.startsWith("/auth/")
      || parsed.pathname === "/login";
  }
  return AUTH_PROVIDER_HOSTS.has(parsed.hostname);
}

function navigationOriginForLog(value) {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:"
      ? parsed.origin
      : parsed.protocol;
  } catch {
    return "invalid-url";
  }
}

// Chromium net errors that mean the proxy, not the site, could not be reached.
const PROXY_NET_ERRORS = new Set([-130, -111, -127, -336]);
const FAILURE_PAGE_PREFIX = "data:text/html;charset=utf-8,";
/**
 * Whether a URL is the "page failed to load" document. The launcher's own idle document shares the
 * data: prefix: read as a failure page, its later load skipped the recovery that writes the
 * ownership descriptor, so a slow start left the launcher unowned for its whole run.
 */
const isFailurePageUrl = (url) => String(url).startsWith(FAILURE_PAGE_PREFIX) && String(url) !== IDLE_BROWSER_URL;
const escapeHtml = (value) => String(value).replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
/**
 * A proxy as the failure page may name it: scheme, host and port only. The route's proxy URL can
 * carry credentials (the built-in gateway's token, an upstream password) that must not reach the
 * page; anything that is not a parseable URL is not shown at all.
 */
function proxyLabel(proxy) {
  try {
    const parsed = new URL(String(proxy));
    return parsed.host ? `${parsed.protocol}//${parsed.host}` : "";
  } catch { return ""; }
}

/**
 * What the ChatGPT view shows when its page fails to load: Electron leaves the view blank otherwise,
 * and the app's own error text sits behind the native view where nobody can see it. A proxy error
 * names the proxy to start. Retry loads the failed page again (only an http(s) one).
 */
function navigationFailurePage({ url = "", errorCode, errorDescription = "", proxy = process.env.HTTPS_PROXY || process.env.HTTP_PROXY || "" } = {}) {
  let retry = "";
  try { const parsed = new URL(url); if (parsed.protocol === "https:" || parsed.protocol === "http:") retry = parsed.toString(); } catch { /* no retry link */ }
  const proxied = PROXY_NET_ERRORS.has(errorCode);
  const host = (() => { try { return new URL(retry).host; } catch { return "the page"; } })();
  const named = proxyLabel(proxy);
  const hint = proxied
    ? `The app reaches the internet through the proxy ${named ? `<b>${escapeHtml(named)}</b>` : "set for this route"}, and nothing is answering there. Start your proxy app (ProxyBridge), then retry.`
    : "Check your connection, then retry.";
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>Can't reach ${escapeHtml(host)}</title><style>
body{margin:0;height:100vh;display:grid;place-items:center;font:14px/1.5 system-ui,sans-serif;background:#fff;color:#1f1f1f}
@media (prefers-color-scheme:dark){body{background:#212121;color:#ececec}a{color:#8ab4ff}}
main{max-width:460px;padding:24px}h1{font-size:18px;margin:0 0 8px}code{font-size:12px;opacity:.7}
a.retry{display:inline-block;margin-top:14px;padding:6px 14px;border-radius:8px;background:#1f1f1f;color:#fff;text-decoration:none}
@media (prefers-color-scheme:dark){a.retry{background:#ececec;color:#1f1f1f}}</style></head><body><main>
<h1>Can't reach ${escapeHtml(host)}</h1><p>${hint}</p><code>${escapeHtml(errorDescription || "Load failed")} (${escapeHtml(errorCode ?? "")})</code><br>
${retry ? `<a class="retry" href="${escapeHtml(retry)}">Retry</a>` : ""}</main></body></html>`;
  return FAILURE_PAGE_PREFIX + encodeURIComponent(html);
}

function navigationErrorForLog(error) {
  if (!error || typeof error !== "object") return { errorType: typeof error };
  const detail = {
    errorType: typeof error.name === "string" && error.name ? error.name : "Error",
  };
  if (typeof error.code === "string" || typeof error.code === "number") {
    detail.errorCode = error.code;
  }
  return detail;
}

function isAbortedNavigationError(error) {
  if (error && typeof error === "object"
    && (error.code === -3 || error.code === "ERR_ABORTED")) {
    return true;
  }
  return error instanceof Error && /\bERR_ABORTED\b/.test(error.message);
}

function useSavedChatsFor(host) {
  return host.getUseSavedChats?.() !== false;
}

/** The empty new chat a task turn starts on; Temporary Chat only when saved chats are off. */
function newChatUrlFor(host) {
  return useSavedChatsFor(host) ? SAVED_CHAT_URL : TEMPORARY_CHAT_URL;
}

/**
 * Where a completed turn left its retained tab. A saved task chat must sit on its own
 * /c/<uuid> page; a Temporary Chat keeps its flag (on /c/<uuid> or, in some builds, the home).
 * Null means the page holds no conversation this turn owns, so it must not be continued: the
 * tab shows the user's history sidebar and could now be one of the user's own chats.
 */
/** The saved chat a bridge turn ended on (the uuid of its /c/<uuid>), or null outside saved chats. */
function ownedSavedConversationId(value, useSavedChats) {
  if (!useSavedChats) return null;
  const location = retainedConversationLocation(value, true);
  return location ? location.slice("/c/".length) : null;
}

const CONVERSATION_DELETE_TIMEOUT_MS = 8_000;

/**
 * Deletes one saved chat from inside its own ChatGPT page, as ChatGPT's Delete menu does (hide it
 * from history with is_visible: false). The page's session token is read and used in the page and
 * never returned. Only a /c/<uuid> id the bridge recorded for its own turn is ever passed here.
 */
function deleteConversationScript(conversationId) {
  return conversationPatchScript(conversationId, "delete");
}

function retainedConversationLocation(value, useSavedChats) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    return null;
  }
  if (parsed.origin !== CHATGPT_ORIGIN) return null;
  const temporary = parsed.searchParams.get("temporary-chat") === "true";
  if (useSavedChats) {
    return !parsed.searchParams.has("temporary-chat") && SAVED_CONVERSATION_PATH.test(parsed.pathname)
      ? parsed.pathname
      : null;
  }
  if (!temporary) return null;
  if (SAVED_CONVERSATION_PATH.test(parsed.pathname)) return `${parsed.pathname}?temporary-chat=true`;
  return parsed.pathname === "/" ? "/?temporary-chat=true" : null;
}

function isNewChatUrl(value, useSavedChats) {
  if (!useSavedChats) return isTemporaryChatUrl(value);
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    return false;
  }
  return parsed.origin === CHATGPT_ORIGIN && parsed.pathname === "/" && !parsed.searchParams.has("temporary-chat");
}

function isTemporaryChatUrl(value) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    return false;
  }
  return parsed.origin === CHATGPT_ORIGIN
    && parsed.pathname === "/"
    && parsed.searchParams.get("temporary-chat") === "true";
}

function isChatGptBackendUrl(value) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    return false;
  }
  return parsed.origin === CHATGPT_ORIGIN && parsed.pathname.startsWith("/backend-api/");
}

function responseHeaderIncludes(responseHeaders, name, expectedValue) {
  const expected = expectedValue.toLowerCase();
  return Object.entries(responseHeaders || {}).some(([headerName, rawValues]) => {
    if (headerName.toLowerCase() !== name.toLowerCase()) return false;
    const values = Array.isArray(rawValues) ? rawValues : [rawValues];
    return values.some(value => String(value)
      .split(",")
      .some(candidate => candidate.trim().toLowerCase() === expected));
  });
}

function isChatGptCloudflareChallengeResponse(details) {
  return details?.statusCode === 403
    && isChatGptBackendUrl(details.url)
    && responseHeaderIncludes(details.responseHeaders, "cf-mitigated", "challenge");
}

function manualPromptDigest(prompt) {
  return createHash("sha256").update(prompt, "utf8").digest("hex");
}

function browserInteractionModeFor(host) {
  const mode = host.interactionModeOverride ?? host.getBrowserInteractionMode?.() ?? "automatic";
  if (mode !== "automatic" && mode !== "manual") {
    throw new Error("Launcher browser interaction mode is invalid");
  }
  return mode;
}

function requireAutomaticBrowserInspection(host, operation) {
  if (browserInteractionModeFor(host) === "manual") {
    const error = new Error(`${operation} is disabled in Zero Risk mode`);
    error.code = "manual_browser_inspection_disabled";
    throw error;
  }
}

class BrowserTurnCancelledError extends Error {
  constructor(traceId) {
    super(`Browser turn ${traceId} was cancelled by the user`);
    this.name = "BrowserTurnCancelledError";
    this.code = "turn_cancelled";
  }
}

/**
 * Loads the idle document, retrying only a timeout with longer windows. A busy machine can miss
 * the first 10 s (seen for the primary view for a day, and for new turn tabs: "Browser idle
 * document did not commit within 10000ms" failed a Web GPT turn as browser_page). The timeout
 * stops the load, so nothing else would retry it.
 */
async function loadIdleSurfaceWithRetries(contents, attempts, onRetry) {
  for (const [attempt, timeoutMs] of attempts.entries()) {
    try {
      await loadCommittedBrowserSurface(contents, IDLE_BROWSER_URL, timeoutMs);
      return;
    } catch (error) {
      const timedOut = /did not commit within/.test(error instanceof Error ? error.message : String(error));
      if (!timedOut || attempt === attempts.length - 1) throw error;
      onRetry?.(attempt + 1, timeoutMs);
    }
  }
}

function loadCommittedBrowserSurface(
  contents,
  url,
  timeoutMs = PRIMARY_VIEW_BOOTSTRAP_TIMEOUT_MS,
) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error("Browser idle document timeout must be positive");
  }
  if (!contents || contents.isDestroyed()) {
    return Promise.reject(new Error("Browser closed before idle document bootstrap"));
  }
  return new Promise((resolve, reject) => {
    let settled = false;
    let loadFinished = false;
    const cleanup = () => {
      clearTimeout(timeout);
      contents.off("did-stop-loading", onReady);
      contents.off("did-finish-load", onReady);
      contents.off("did-fail-load", onFailed);
      contents.off("render-process-gone", onRendererGone);
      contents.off("destroyed", onDestroyed);
    };
    const finish = (error) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error) reject(error);
      else resolve();
    };
    const onReady = () => {
      if (contents.isDestroyed()) {
        finish(new Error("Browser closed during idle document bootstrap"));
        return;
      }
      if (loadFinished && contents.getURL() === url) finish();
    };
    const onFailed = (_event, errorCode, errorDescription, failedUrl, mainFrame) => {
      // A stopped previous load can emit its abort after this attempt starts.
      if (!mainFrame || errorCode === -3) return;
      finish(new Error(
        `Browser idle document failed: ${errorDescription} (${errorCode}) at ${failedUrl}`,
      ));
    };
    const onRendererGone = (_event, details) => {
      finish(new Error(`Browser renderer stopped during idle document bootstrap: ${details.reason}`));
    };
    const onDestroyed = () => finish(new Error("Browser closed during idle document bootstrap"));
    const timeout = setTimeout(() => {
      finish(new Error(`Browser idle document did not commit within ${timeoutMs}ms`));
      if (!contents.isDestroyed()) contents.stop();
    }, timeoutMs);
    timeout.unref?.();
    contents.on("did-stop-loading", onReady);
    contents.on("did-finish-load", onReady);
    contents.on("did-fail-load", onFailed);
    contents.on("render-process-gone", onRendererGone);
    contents.on("destroyed", onDestroyed);
    try {
      Promise.resolve(contents.loadURL(url)).then(() => {
        loadFinished = true;
        onReady();
      }, error => {
        finish(error instanceof Error ? error : new Error(String(error)));
      });
    } catch (error) {
      finish(error instanceof Error ? error : new Error(String(error)));
    }
  });
}

class BrowserHost {
  constructor({
    window,
    descriptorPath,
    cdpPort,
    control,
    cancelTurn,
    getConnectorName,
    helper,
    logger,
    loginWithPasskey,
    partition,
    profile = "production",
    publishState,
    showWindow = () => {},
    clipboardApi = clipboard,
    getBrowserInteractionMode = () => "automatic",
    // Task chats are saved by default: ChatGPT refuses connectors in Temporary Chat.
    getUseSavedChats = () => true,
    // The ChatGPT account a Codex thread is bound to (codex-thread-accounts.cjs), as
    // { accountId, partition, chatLifecycleSync }; null or none: this host's own account.
    resolveTurnAccount = null,
    // Settings (browser-accounts.cjs): the tabs an account's partition may hold, and how long a
    // finished turn's tab stays open.
    tabLimitFor = null,
    retainedTabTtlMs = null,
    // What this host learns about an account: its plan from an inspection with capabilities, and
    // whether its ChatGPT connector bound in a Codex turn ({ bound } or { error }).
    onSessionInspected = null,
    onConnectorObserved = null,
  }) {
    if (typeof getConnectorName !== "function") {
      throw new Error("Browser host connector-name resolver is unavailable");
    }
    if (typeof loginWithPasskey !== "function") {
      throw new Error("Browser host passkey login operation is unavailable");
    }
    this.window = window;
    this.descriptorPath = descriptorPath;
    this.cdpPort = cdpPort;
    this.control = control;
    this.cancelTurn = cancelTurn;
    this.getConnectorName = getConnectorName;
    this.helper = helper;
    this.logger = logger;
    this.loginWithPasskey = loginWithPasskey;
    // The profile's partition or one of its browser-tab accounts' (profile.cjs); nothing else.
    const resolvedPartition = partition ?? browserPartitionForLauncherProfile(profile);
    if (!isBrowserAccountPartition(profile, resolvedPartition)) {
      throw new Error("Browser host partition does not match its profile");
    }
    this.partition = resolvedPartition;
    this.resolveTurnAccount = resolveTurnAccount;
    this.tabLimitFor = tabLimitFor;
    this.retainedTabTtlMs = retainedTabTtlMs;
    this.onSessionInspected = onSessionInspected;
    this.onConnectorObserved = onConnectorObserved;
    this.profile = profile;
    this.publishState = publishState;
    this.showWindow = showWindow;
    this.clipboard = clipboardApi;
    this.getBrowserInteractionMode = getBrowserInteractionMode;
    this.getUseSavedChats = getUseSavedChats;
    this.runBrowserHelperOperation = runBrowserHelperOperation;
    this.verifyConnectorWithBrowserHelper = verifyConnectorWithBrowserHelper;
    this.surfaceId = randomBytes(24).toString("base64url");
    this.visible = false;
    this.surfaceActive = true;
    this.turnTabs = new Map();
    this.userTabs = new Map();
    this.closedTurnOwners = new Map();
    this.userCancelledTurnOwners = new Map();
    this.manualTerminalSignals = new Map();
    this.manualCompletionSignals = new Map();
    this.interactionModeOverride = null;
    this.selectedTabId = "home";
    this.manualOperation = null;
    this.loginOperation = null;
    this.sessionRefreshOperation = null;
    this.cloudflareChallengeRecovery = null;
    this.cloudflareChallengeRecoveryArmed = true;
    this.cloudflareChallengeRecoveryDelayMs = CLOUDFLARE_CHALLENGE_RECOVERY_DELAY_MS;
    this.cloudflareChallengeRecoverySettleMs = CLOUDFLARE_CHALLENGE_RECOVERY_SETTLE_MS;
    this.viewportCssKey = null;
    this.shellZoomShortcutBindings = new Map();
    this.authView = null;
    this.authNavigationError = null;
    this.homeNavigationTimeout = null;
    this.lastTurnSweepAt = Date.now();
    this.powerSaveBlockerId = null;
    this.turnLeaseSweep = setInterval(() => this.reapExpiredTurnTabs(), TURN_HEARTBEAT_SWEEP_MS);
    this.turnLeaseSweep.unref?.();
    this.resumeListener = () => this.refreshTurnLeases("system_resume");
    if (powerMonitor && typeof powerMonitor.on === "function") {
      powerMonitor.on("resume", this.resumeListener);
    } else {
      this.resumeListener = null;
    }
    this.boundsReady = false;
    this.bounds = { x: 0, y: 0, width: 1, height: 1 };
    this.state = {
      status: "idle",
      message: "No active task",
      url: "about:blank",
      title: "ChatGPT",
      authenticated: false,
      visible: false,
      surfaceActive: true,
      loading: false,
      canGoBack: false,
      canGoForward: false,
      zoomFactor: 1,
    };
    // Accounts the Browser tab showed before, kept loaded and hidden so switching back is instant
    // (switchAccount): partition -> { view, surfaceId, userTabs, state, ... }.
    this.parkedHomes = new Map();
    this.recoverySessions = new Set();
    this.view = this.createHomeView(this.partition);
    this.windowVisibilityListener = () => this.syncViewVisibility();
    for (const event of WINDOW_VISIBILITY_EVENTS) {
      this.window.on(event, this.windowVisibilityListener);
    }
    this.bindShellZoomShortcuts(this.window.webContents);
    this.initializationFailed = false;
    this.initializationReady = this.initializePrimaryView().catch((error) => {
      this.initializationFailed = true;
      this.logger.error("browser.initialization_failed", {
        message: error instanceof Error ? error.message : String(error),
      });
      this.setState({ status: "error", message: "Embedded browser failed to initialize" });
      throw error;
    });
  }

  // One account's home page. The shown account's is `this.view`; the others wait in parkedHomes.
  createHomeView(partition) {
    const view = new WebContentsView({
      webPreferences: {
        partition,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        spellcheck: true,
        backgroundThrottling: true,
      },
    });
    keepPageOutOfWindowFrame(view.webContents);
    signInFriendlyUserAgent(view.webContents);
    this.window.contentView.addChildView(view);
    view.webContents.setZoomFactor(this.state.zoomFactor);
    this.bindShellZoomShortcuts(view.webContents);
    this.bindChatGptBackendRecovery(view.webContents.session);
    this.bindWebContents(view.webContents);
    return view;
  }

  async ready() {
    await this.initializationReady;
  }

  async initializePrimaryView() {
    this.view.setBounds(this.hiddenTurnBounds());
    this.view.setVisible(true);
    try {
      // A busy machine can miss the first window (seen: every start for a day missed 10 s), and
      // the launcher then stayed without its ownership descriptor.
      await loadIdleSurfaceWithRetries(
        this.view.webContents,
        this.bootstrapAttemptsMs ?? PRIMARY_VIEW_BOOTSTRAP_ATTEMPTS_MS,
        (attempt, timeoutMs) => this.logger.warn("browser.initialization_retry", { attempt, timeoutMs }),
      );
      if (browserInteractionModeFor(this) === "automatic") await this.markOwnedSurface();
    } finally {
      this.syncViewVisibility();
    }
    await this.writeDescriptor();
    this.logger.info("browser.initialized", { url: this.view.webContents.getURL() });
  }

  currentOperation() {
    return this.manualOperation || (this.loginOperation ? "ChatGPT login" : null);
  }

  assertTurnTabsCanResetForInteractionModeChange() {
    if ([...this.turnTabs.values()].some(tab => tab.status === "running")) {
      throw new Error("Finish or cancel active ChatGPT turns before changing browser interaction mode");
    }
  }

  async withInteractionModeChange(mode, action) {
    if (mode !== "automatic" && mode !== "manual") {
      throw new Error("Browser interaction mode must be automatic or manual");
    }
    if (this.manualOperation) {
      throw new Error(`ChatGPT browser is already busy with ${this.manualOperation}`);
    }
    this.assertTurnTabsCanResetForInteractionModeChange();
    this.interactionModeOverride = mode;
    this.manualOperation = INTERACTION_MODE_CHANGE_OPERATION;
    try {
      let browserCommitted = false;
      const commitBrowserChange = async () => {
        if (browserCommitted) throw new Error("Browser interaction mode change was committed more than once");
        // The runtime setup invokes this callback inside its own rollback boundary. Existing tabs
        // are mode-bound and remain valid history, so the browser commit has no irreversible tab
        // mutation that could survive a runtime rollback.
        if (mode === "automatic") await this.markOwnedSurface();
        browserCommitted = true;
      };
      const result = await action(commitBrowserChange);
      if (!browserCommitted) {
        throw new Error("Runtime setup returned before committing the browser interaction mode");
      }
      return result;
    } finally {
      this.manualOperation = null;
      this.interactionModeOverride = null;
    }
  }

  browserInteractionMode() {
    return browserInteractionModeFor(this);
  }

  requireAutomaticBrowserInspection(operation) {
    requireAutomaticBrowserInspection(this, operation);
  }

  get activeTraceId() {
    return [...this.turnTabs.values()].find((tab) => tab.status === "running")?.traceId || null;
  }

  /** Why the browser cannot change account right now, or null: a running turn or sign-in owns its session. */
  accountSwitchBlocker() {
    if (this.activeTraceId) return "a ChatGPT chat turn is running";
    if (this.manualOperation) return `${this.manualOperation} is running`;
    if (this.loginOperation) return "sign-in is in progress";
    return null;
  }

  /**
   * Why the Browser tab cannot show another account right now, or null. Codex turns keep running
   * in their own tabs on their own accounts, so only what owns the shown account's page blocks it.
   */
  homeSwitchBlocker() {
    if (this.manualOperation) return `${this.manualOperation} is running`;
    if (this.loginOperation || this.authView) return "sign-in is in progress";
    if ([...this.turnTabs.values()].some((tab) => tab.interactionMode === "manual" && tab.status === "running")) {
      return "a Zero Risk turn is waiting to be sent";
    }
    return null;
  }

  /**
   * Shows another account in place. The account left is parked: its page and its own tabs stay
   * loaded and hidden, so switching back is instant (as GPT Browser does). An account not parked
   * gets a new page. If that page cannot load, the account left comes back.
   */
  async switchAccount(partition, { chatLifecycleSync = null } = {}) {
    if (partition === this.partition) return this.snapshot();
    if (!isBrowserAccountPartition(this.profile, partition)) {
      throw new Error("Browser host partition does not match its profile");
    }
    const blocker = this.homeSwitchBlocker();
    if (blocker) throw new Error(`The Browser tab cannot change account while ${blocker}`);
    await this.initializationReady.catch(() => {});
    let warm = this.parkedHomes.get(partition) ?? null;
    if (warm?.view.webContents.isDestroyed()) {
      // Its page closed while parked (a renderer crash): the account starts on a new page.
      this.parkedHomes.delete(partition);
      this.unloadHome(warm);
      warm = null;
    }
    const leaving = this.parkHome();
    if (warm) {
      this.parkedHomes.delete(partition);
      this.restoreHome(warm);
    } else {
      this.restoreHome({
        partition,
        view: this.createHomeView(partition),
        surfaceId: randomBytes(24).toString("base64url"),
        userTabs: new Map(),
        selectedTabId: "home",
        chatLifecycleSync,
        lastAuthenticatedAt: 0,
        viewportCssKey: null,
        state: { status: "idle", message: "No active task", url: "about:blank", title: "ChatGPT", authenticated: false, loading: false },
      });
      try {
        await this.initializePrimaryView();
      } catch (error) {
        const failed = this.parkHome();
        this.restoreHome(leaving);
        this.unloadHome(failed);
        this.syncViewVisibility();
        void this.writeDescriptor();
        this.publishState?.(this.snapshot());
        throw error;
      }
    }
    if (chatLifecycleSync) this.chatLifecycleSync = chatLifecycleSync;
    this.parkedHomes.set(leaving.partition, leaving);
    this.trimParkedHomes();
    this.syncViewVisibility();
    // Shown at once; the switch settles once the bridge can read the new account's surface.
    const published = this.writeDescriptor();
    this.publishState?.(this.snapshot());
    this.logger.info("browser.account_switched", { warm: Boolean(warm), parked: this.parkedHomes.size });
    // A parked page may have been signed out (or in) elsewhere meanwhile: check it again.
    if (warm && browserInteractionModeFor(this) === "automatic") void this.probeAuthentication().catch(() => {});
    await published;
    return this.snapshot();
  }

  // Takes the shown account's page and tabs off screen, kept loaded; returns them as a home.
  parkHome() {
    this.clearHomeNavigationTimeout();
    const home = {
      partition: this.partition,
      view: this.view,
      surfaceId: this.surfaceId,
      userTabs: this.userTabs,
      selectedTabId: this.userTabs.has(this.selectedTabId) ? this.selectedTabId : "home",
      chatLifecycleSync: this.chatLifecycleSync,
      lastAuthenticatedAt: this.lastAuthenticatedAt ?? 0,
      viewportCssKey: this.viewportCssKey,
      state: Object.fromEntries(HOME_STATE_FIELDS.map((field) => [field, this.state[field]])),
      parkedAt: Date.now(),
    };
    if (!home.view.webContents.isDestroyed()) home.view.setVisible(false);
    for (const tab of home.userTabs.values()) tab.view.setVisible(false);
    return home;
  }

  restoreHome(home) {
    this.partition = home.partition;
    this.view = home.view;
    this.surfaceId = home.surfaceId;
    this.userTabs = home.userTabs;
    this.chatLifecycleSync = home.chatLifecycleSync ?? this.chatLifecycleSync;
    this.lastAuthenticatedAt = home.lastAuthenticatedAt;
    this.viewportCssKey = home.viewportCssKey;
    // A Codex turn's tab stays selected; otherwise the account opens where it was left.
    if (!this.turnTabs.has(this.selectedTabId)) this.selectedTabId = home.selectedTabId;
    this.state = { ...this.state, ...home.state, visible: this.visible, surfaceActive: this.surfaceActive };
    // Zoom is the Browser tab's, not the account's: a parked page takes the current one.
    for (const view of [home.view, ...[...home.userTabs.values()].map((tab) => tab.view)]) {
      if (!view.webContents.isDestroyed()) view.webContents.setZoomFactor(this.state.zoomFactor);
    }
  }

  unloadHome(home) {
    for (const view of [...[...home.userTabs.values()].map((tab) => tab.view), home.view]) {
      try { this.window.contentView.removeChildView(view); } catch {}
      if (!view.webContents.isDestroyed()) view.webContents.close();
    }
    home.userTabs.clear();
  }

  // At most MAX_WARM_HOMES accounts stay loaded, the shown one included.
  trimParkedHomes() {
    while (this.parkedHomes.size > MAX_WARM_HOMES - 1) {
      const turnPartitions = new Set([...this.turnTabs.values()].map((tab) => tab.partition).filter(Boolean));
      const home = parkedHomeToUnload([...this.parkedHomes.values()], turnPartitions);
      if (!home) return;
      this.parkedHomes.delete(home.partition);
      this.unloadHome(home);
      this.logger.info("browser.parked_home_unloaded", { userTabs: home.userTabs.size });
    }
  }

  /** Closes a parked account's page and tabs (the account is being removed). */
  releaseAccountHome(partition) {
    if (partition === this.partition) throw new Error("Switch to another account before releasing this one");
    const home = this.parkedHomes.get(partition);
    if (!home) return false;
    this.parkedHomes.delete(partition);
    this.unloadHome(home);
    return true;
  }

  /** The tabs an account's partition holds here (browser-accounts.cjs spreads sessions by it). */
  tabCount(partition) {
    return tabsOnPartition(this, partition);
  }

  /** Whether a turn of this Codex thread is running in one of this host's tabs. */
  threadRunning(threadId) {
    const id = String(threadId ?? "").toLowerCase();
    return [...this.turnTabs.values()].some((tab) => tab.status === "running" && tab.nativeThreadId?.toLowerCase() === id);
  }

  /** Closes a Codex thread's retained turn tabs (never a running one), before its chats move or go. */
  releaseThreadTabs(threadId) {
    const id = String(threadId ?? "").toLowerCase();
    const tabs = [...this.turnTabs.values()].filter((tab) => tab.interactionMode === "automatic"
      && tab.status !== "running" && tab.nativeThreadId?.toLowerCase() === id);
    for (const tab of tabs) this.removeTurnTab(tab, false);
    if (tabs.length) {
      this.publishState?.(this.snapshot());
      void this.writeDescriptor();
    }
    return tabs.length;
  }

  /**
   * Every partition this host's pages use: its own, the parked accounts', and those of the
   * accounts its turn tabs run on.
   */
  livePartitions() {
    return [...new Set([
      this.partition,
      ...(this.parkedHomes?.keys() ?? []),
      ...[...this.turnTabs.values()].map((tab) => tab.partition),
    ].filter(Boolean))];
  }

  tabSnapshot(tab) {
    const conversationUrl = liveConversationUrl(tab);
    const snapshot = {
      id: tab.id,
      traceId: tab.traceId,
      ...(tab.accountId ? { accountId: tab.accountId } : {}),
      // A Codex turn on an account the Browser tab is not showing: listed for ChatGPT browser
      // management, kept out of the shown account's tab strip.
      ...((tab.partition ?? this.partition) !== this.partition ? { otherAccount: true } : {}),
      ...(tab.nativeThreadId ? { threadId: tab.nativeThreadId } : {}),
      ...(conversationUrl ? { conversationUrl } : {}),
      title: tab.label,
      status: tab.status,
      loading: tab.loading === true,
      active: this.selectedTabId === tab.id,
      closable: true,
      // For ChatGPT browser management: how long the tab ran, and when a finished one closes.
      ...(tab.startedAt ? { startedAt: tab.startedAt } : {}),
      ...(tab.finishedAt ? { finishedAt: tab.finishedAt } : {}),
      ...(tab.status === "ready" && this.turnTabs?.get(tab.id) === tab && Number.isFinite(tab.lastHeartbeatAt)
        ? { closesAt: tab.lastHeartbeatAt + retainedTabTtl(this) } : {}),
    };
    if (tab.interactionMode === "manual") {
      Object.assign(snapshot, {
        interactionMode: "manual",
        manualState: tab.manualState,
        ...(tab.manualDeadlineAt ? { manualDeadlineAt: new Date(tab.manualDeadlineAt).toISOString() } : {}),
        canCopyPrompt: typeof tab.prompt === "string" && tab.prompt.length > 0,
        canConfirmSent: tab.manualState === "awaiting-user",
      });
    }
    return snapshot;
  }

  selectedTurnTab() {
    return this.turnTabs.get(this.selectedTabId) || null;
  }

  selectedUserTab() {
    return this.userTabs?.get(this.selectedTabId) || null;
  }

  async createTurnTab(traceId, helperPid, conversationKey, connectorIdentity, nativeThreadId, account = null) {
    // A Codex thread's turns run on the account it is bound to, which need not be this host's.
    const partition = account?.partition ?? this.partition;
    const full = makeTabRoom(this, partition);
    if (full) throw fullTabsError(full);
    const id = randomBytes(12).toString("base64url");
    const surfaceId = randomBytes(24).toString("base64url");
    const ordinal = Array.from({ length: MAX_TOTAL_BROWSER_TABS }, (_unused, index) => index + 1)
      .find(candidate => ![...this.turnTabs.values(), ...(this.userTabs?.values() ?? [])].some(tab => tab.ordinal === candidate));
    if (!ordinal) throw new Error("ChatGPT Web browser tab allocation is inconsistent");
    const view = new WebContentsView({
      webPreferences: {
        partition,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        spellcheck: true,
        backgroundThrottling: false,
      },
    });
    keepPageOutOfWindowFrame(view.webContents);
    signInFriendlyUserAgent(view.webContents);
    const tab = {
      id,
      surfaceId,
      traceId,
      nativeThreadId,
      partition,
      accountId: account?.accountId ?? null,
      chatLifecycleSync: account?.chatLifecycleSync ?? this.chatLifecycleSync,
      conversationKey,
      connectorIdentity,
      connectorBound: false,
      startedAt: Date.now(),
      helperPid,
      view,
      status: "running",
      ordinal,
      label: `ChatGPT ${ordinal}`,
      pageTitle: "ChatGPT",
      url: IDLE_BROWSER_URL,
      loading: true,
      message: "ChatGPT is working",
      interactionMode: "automatic",
      initializingSurface: true,
      bootstrapReady: false,
      rendererReady: false,
      deviceEmulationViewport: null,
      deviceEmulationDirty: true,
      bootstrapDeadlineAt: Date.now() + TURN_TAB_BOOTSTRAP_TIMEOUT_MS,
      lastHeartbeatAt: Date.now(),
    };
    this.turnTabs.set(id, tab);
    this.syncPowerSaveBlocker();
    this.window.contentView.addChildView(view);
    this.presentTurnView(tab, false);
    view.webContents.setZoomFactor(this.state.zoomFactor);
    this.bindShellZoomShortcuts(view.webContents);
    this.bindTurnContents(tab);
    // A new turn tab gets the primary view's retries: one 10 s window failed turns as
    // browser_page on a busy machine. The windows fit the tab's 120 s bootstrap budget. The tab
    // keeps the promise so a repeated start of the same turn waits for it (beginTurn).
    tab.surfaceReady = (async () => {
      await loadIdleSurfaceWithRetries(
        view.webContents,
        this.bootstrapAttemptsMs ?? PRIMARY_VIEW_BOOTSTRAP_ATTEMPTS_MS,
        (attempt, timeoutMs) => this.logger.warn("browser.tab_initialization_retry", { tabId: tab.id, traceId: tab.traceId, attempt, timeoutMs }),
      );
      await this.markTurnTabSurface(tab);
      tab.initializingSurface = false;
      // The helper heartbeats only once its start returns; a slow load must not count against it.
      tab.lastHeartbeatAt = Date.now();
    })();
    try {
      await tab.surfaceReady;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error("browser.tab_initialization_failed", {
        tabId: tab.id,
        traceId: tab.traceId,
        message,
      });
      this.removeTurnTab(tab, true);
      throw error;
    }
    return tab;
  }

  createUserTab() {
    const full = makeTabRoom(this, this.partition, false);
    if (full) throw new Error(`ChatGPT Web already has ${full} browser tabs; close one before opening another`);
    if (!this.surfaceActive) throw new Error("Open the Browser before creating a tab");
    if (this.manualOperation) throw new Error(`Browser tabs cannot open during ${this.manualOperation}`);
    // A signed-out account opens tabs too, as in GPT Browser: the new tab is ChatGPT's own sign-in.
    const ordinal = Array.from({ length: MAX_TOTAL_BROWSER_TABS }, (_unused, index) => index + 1)
      .find(candidate => ![...this.turnTabs.values(), ...this.userTabs.values()]
        .some(tab => tab.ordinal === candidate));
    if (!ordinal) throw new Error("ChatGPT Web browser tab allocation is inconsistent");
    const view = new WebContentsView({
      webPreferences: {
        partition: this.partition,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        spellcheck: true,
        backgroundThrottling: true,
      },
    });
    keepPageOutOfWindowFrame(view.webContents);
    signInFriendlyUserAgent(view.webContents);
    const tab = {
      id: randomBytes(12).toString("base64url"),
      startedAt: Date.now(),
      traceId: null,
      ordinal,
      label: `ChatGPT ${ordinal}`,
      pageTitle: "ChatGPT",
      url: newChatUrlFor(this),
      status: "loading",
      loading: true,
      message: "Opening ChatGPT",
      view,
    };
    this.userTabs.set(tab.id, tab);
    this.window.contentView.addChildView(view);
    view.webContents.setZoomFactor(this.state.zoomFactor);
    this.bindShellZoomShortcuts(view.webContents);
    this.bindUserTabContents(tab);
    this.selectedTabId = tab.id;
    this.show();
    void view.webContents.loadURL(newChatUrlFor(this)).catch((error) => {
      if (this.userTabs.get(tab.id) !== tab || view.webContents.isDestroyed()
        || isAbortedNavigationError(error)) return;
      tab.loading = false;
      tab.status = "error";
      tab.message = error instanceof Error ? error.message : String(error);
      this.logger.error("browser.user_tab_navigation_failed", {
        tabId: tab.id, ...navigationErrorForLog(error),
      });
      this.publishState?.(this.snapshot());
    });
    this.logger.info("browser.user_tab_opened", { tabId: tab.id, ordinal });
    return this.snapshot();
  }

  createManualTurnTab(traceId, helperPid, conversationKey, prompt, manualSubmitTimeoutMs) {
    const full = makeTabRoom(this, this.partition);
    if (full) throw fullTabsError(full);
    const id = randomBytes(12).toString("base64url");
    const ordinal = Array.from({ length: MAX_TOTAL_BROWSER_TABS }, (_unused, index) => index + 1)
      .find(candidate => ![...this.turnTabs.values(), ...(this.userTabs?.values() ?? [])].some(tab => tab.ordinal === candidate));
    if (!ordinal) throw new Error("ChatGPT Web browser tab allocation is inconsistent");
    const view = new WebContentsView({
      webPreferences: {
        partition: this.partition,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        spellcheck: true,
        backgroundThrottling: false,
      },
    });
    keepPageOutOfWindowFrame(view.webContents);
    signInFriendlyUserAgent(view.webContents);
    const tab = {
      id,
      surfaceId: null,
      startedAt: Date.now(),
      traceId,
      // Kept: the Browser tab may show another account while this turn waits.
      partition: this.partition,
      conversationKey,
      connectorIdentity: null,
      connectorBound: false,
      helperPid,
      view,
      status: "running",
      ordinal,
      label: `ChatGPT ${ordinal}`,
      pageTitle: "ChatGPT",
      url: newChatUrlFor(this),
      loading: true,
      message: "Paste the copied prompt, add any images yourself because Zero Risk cannot transfer them, choose a model and effort, then press Sent",
      interactionMode: "manual",
      manualState: "awaiting-user",
      manualSubmitTimeoutMs,
      manualDeadlineAt: Date.now() + manualSubmitTimeoutMs,
      manualDeadlineTimer: null,
      manualWaiters: new Set(),
      manualTerminalWaiters: new Set(),
      manualTerminalResolutionSuppressed: false,
      prompt,
      promptDigest: manualPromptDigest(prompt),
      manualConversationReused: false,
      sentAt: null,
      bootstrapReady: false,
      rendererReady: false,
      lastHeartbeatAt: Date.now(),
    };
    this.turnTabs.set(id, tab);
    this.window.contentView.addChildView(view);
    this.presentTurnView(tab, true);
    view.webContents.setZoomFactor(this.state.zoomFactor);
    this.bindShellZoomShortcuts(view.webContents);
    this.bindManualTurnContents(tab);
    void this.initializeManualTurnTab(tab);
    return tab;
  }

  async initializeManualTurnTab(tab) {
    const contents = tab.view.webContents;
    try {
      await loadCommittedBrowserSurface(contents, IDLE_BROWSER_URL);
    } catch (error) {
      if (this.turnTabs.get(tab.id) !== tab || contents.isDestroyed()) return;
      this.logger.error("browser.manual_tab_initialization_failed", {
        tabId: tab.id,
        traceId: tab.traceId,
        ...navigationErrorForLog(error),
      });
      this.signalManualTerminal(tab, "failed");
      this.removeTurnTab(tab, true);
      return;
    }
    if (this.turnTabs.get(tab.id) !== tab || contents.isDestroyed()) return;
    try {
      // The user mentions the connector here too, so Zero Risk follows "Save chats in ChatGPT".
      await contents.loadURL(newChatUrlFor(this));
    } catch (error) {
      if (this.turnTabs.get(tab.id) !== tab || contents.isDestroyed()) return;
      if (isAbortedNavigationError(error)) {
        this.logger.info("browser.manual_tab_navigation_superseded", {
          tabId: tab.id,
          traceId: tab.traceId,
          ...navigationErrorForLog(error),
        });
        return;
      }
      this.logger.error("browser.manual_tab_navigation_failed", {
        tabId: tab.id,
        traceId: tab.traceId,
        ...navigationErrorForLog(error),
      });
      this.signalManualTerminal(tab, "failed");
      this.removeTurnTab(tab, true);
    }
  }

  /** `partition`: only that account's tabs. */
  evictOldestRetainedTurnTab(partition = null) {
    const retained = [...this.turnTabs.values()]
      .filter(tab => tab.status === "ready" && (!partition || (tab.partition ?? this.partition) === partition))
      .sort((left, right) => (left.lastHeartbeatAt ?? 0) - (right.lastHeartbeatAt ?? 0))[0];
    if (!retained) return false;
    this.removeTurnTab(retained, false);
    return true;
  }

  evictOldestReclaimableTurnTab(partition = null) {
    const terminalManual = [...this.turnTabs.values()]
      .filter(tab => tab.interactionMode === "manual"
        && (!partition || (tab.partition ?? this.partition) === partition)
        && tab.status === "error"
        && ["timed-out", "failed", "cancelled"].includes(tab.manualState))
      .sort((left, right) => (left.lastHeartbeatAt ?? 0) - (right.lastHeartbeatAt ?? 0))[0];
    if (terminalManual) {
      this.removeTurnTab(terminalManual, false);
      return true;
    }
    return BrowserHost.prototype.evictOldestRetainedTurnTab.call(this, partition);
  }

  zoomShell(action) {
    const contents = this.window.webContents;
    if (!contents || contents.isDestroyed()) throw new Error("Launcher shell is unavailable for zoom");
    const current = contents.getZoomLevel();
    if (!Number.isFinite(current)) throw new Error("Launcher shell zoom state is invalid");
    const next = action === "reset"
      ? 0
      : action === "in"
        ? Math.min(SHELL_ZOOM_LEVEL_LIMIT, current + SHELL_ZOOM_LEVEL_STEP)
        : Math.max(-SHELL_ZOOM_LEVEL_LIMIT, current - SHELL_ZOOM_LEVEL_STEP);
    contents.setZoomLevel(next);
  }

  bindShellZoomShortcuts(contents) {
    if (!contents || contents.isDestroyed() || this.shellZoomShortcutBindings.has(contents)) return;
    const handler = (event, input) => {
      const action = shellZoomActionForInput(input);
      if (!action) return;
      event.preventDefault();
      try {
        this.zoomShell(action);
      } catch (error) {
        this.logger.error("launcher.shell_zoom_shortcut_failed", {
          action,
          message: error instanceof Error ? error.message : String(error),
        });
      }
    };
    this.shellZoomShortcutBindings.set(contents, handler);
    contents.on("before-input-event", handler);
    contents.once("destroyed", () => this.shellZoomShortcutBindings.delete(contents));
  }

  bindTurnContents(tab) {
    const contents = tab.view.webContents;
    contents.setWindowOpenHandler(({ url }) => {
      if (allowedAuthUrl(url)) {
        this.logger.warn("browser.turn_authentication_blocked", { tabId: tab.id, traceId: tab.traceId });
        return { action: "deny" };
      }
      let parsed;
      try { parsed = new URL(url); } catch { return { action: "deny" }; }
      if (parsed.protocol === "https:" || parsed.protocol === "http:") void shell.openExternal(parsed.toString()).catch(() => undefined);
      return { action: "deny" };
    });
    const blockAuthenticationNavigation = (event, url) => {
      if (!allowedAuthUrl(url)) return;
      event.preventDefault();
      tab.message = "ChatGPT requires a fresh sign-in; finish this turn, then sign in from Setup";
      this.logger.warn("browser.turn_authentication_blocked", { tabId: tab.id, traceId: tab.traceId });
      this.publishState?.(this.snapshot());
    };
    contents.on("will-navigate", blockAuthenticationNavigation);
    contents.on("will-redirect", blockAuthenticationNavigation);
    contents.on("did-start-navigation", (_event, url, inPlace, mainFrame) => {
      if (!mainFrame) return;
      tab.url = url;
      tab.loading = true;
      if (!inPlace) {
        tab.rendererReady = false;
        tab.deviceEmulationDirty = true;
      }
      this.publishState?.(this.snapshot());
    });
    contents.on("did-start-loading", () => {
      tab.loading = true;
      this.publishState?.(this.snapshot());
    });
    contents.on("did-stop-loading", () => {
      tab.loading = false;
      tab.url = contents.getURL();
      this.publishState?.(this.snapshot());
    });
    contents.on("did-finish-load", () => {
      tab.url = contents.getURL();
      tab.loading = false;
      tab.rendererReady = true;
      if (tab.url.startsWith(CHATGPT_ORIGIN)) tab.bootstrapReady = true;
      this.syncViewVisibility();
      if (browserInteractionModeFor(this) !== "automatic") {
        this.publishState?.(this.snapshot());
        return;
      }
      if (tab.initializingSurface) {
        this.publishState?.(this.snapshot());
        return;
      }
      void this.markTurnTabSurface(tab).then(
        () => this.publishState?.(this.snapshot()),
        (error) => {
          tab.status = "error";
          tab.message = `Browser ownership failed: ${error instanceof Error ? error.message : String(error)}`;
          this.syncPowerSaveBlocker();
          this.publishState?.(this.snapshot());
        },
      );
    });
    contents.on("page-title-updated", (_event, title) => {
      if (browserInteractionModeFor(this) !== "automatic") return;
      if (typeof title === "string" && title.trim()) tab.pageTitle = title.trim();
      this.publishState?.(this.snapshot());
    });
    contents.on("did-navigate-in-page", (_event, url, mainFrame) => {
      if (mainFrame) tab.url = url;
      this.publishState?.(this.snapshot());
    });
    contents.on("did-fail-load", (_event, errorCode, errorDescription, url, mainFrame) => {
      if (!mainFrame || errorCode === -3) return;
      tab.url = url;
      tab.message = errorDescription;
      this.logger.error("browser.tab_navigation_failed", {
        tabId: tab.id,
        traceId: tab.traceId,
        errorCode,
        errorDescription,
        url,
      });
      this.removeTurnTab(tab, true);
    });
    contents.on("render-process-gone", (_event, details) => {
      tab.message = `Browser renderer stopped: ${details.reason}`;
      this.logger.error("browser.tab_renderer_gone", {
        tabId: tab.id,
        traceId: tab.traceId,
        reason: details.reason,
        exitCode: details.exitCode,
      });
      this.removeTurnTab(tab, true);
    });
    contents.on("unresponsive", () => {
      this.logger.warn("browser.tab_unresponsive", { tabId: tab.id, traceId: tab.traceId });
    });
    contents.on("responsive", () => {
      this.logger.info("browser.tab_responsive", { tabId: tab.id, traceId: tab.traceId });
    });
  }

  async markTurnTabSurface(tab) {
    requireAutomaticBrowserInspection(this, "ChatGPT turn surface ownership marking");
    const contents = tab?.view?.webContents;
    if (!contents || contents.isDestroyed()) {
      throw new Error("ChatGPT turn browser closed before ownership was established");
    }
    void contents.insertCSS(CHATGPT_VIEWPORT_CSS).catch(() => {});
    const encoded = JSON.stringify(tab.surfaceId);
    await contents.executeJavaScript(`(() => {
      Object.defineProperty(globalThis, "__CODEX_WEB_GPT_SURFACE_ID__", {
        value: ${encoded}, configurable: true, enumerable: false, writable: false,
      });
      document.documentElement.dataset.codexWebGptSurface = ${encoded};
    })()`, true);
  }

  bindUserTabContents(tab) {
    const contents = tab.view.webContents;
    const publish = () => {
      if (this.userTabs.get(tab.id) === tab) this.publishState?.(this.snapshot());
    };
    contents.setWindowOpenHandler(({ url }) => {
      if (allowedAuthUrl(url)) {
        return { action: "allow", createWindow: options => this.createAuthView(options, url) };
      }
      let parsed;
      try { parsed = new URL(url); } catch { return { action: "deny" }; }
      if (parsed.protocol === "https:" || parsed.protocol === "http:") {
        void shell.openExternal(parsed.toString()).catch((error) => {
          this.logger.warn("browser.user_tab_external_url_failed", {
            tabId: tab.id, errorType: error?.name || "Error",
          });
        });
      }
      return { action: "deny" };
    });
    contents.on("did-start-loading", () => {
      tab.loading = true;
      tab.status = "loading";
      publish();
    });
    contents.on("did-stop-loading", () => {
      tab.loading = false;
      tab.url = contents.getURL();
      if (tab.status !== "error") {
        tab.status = "ready";
        tab.message = "ChatGPT is ready";
      }
      publish();
    });
    contents.on("page-title-updated", (_event, title) => {
      if (typeof title === "string" && title.trim()) tab.pageTitle = title.trim();
      publish();
    });
    contents.on("did-navigate-in-page", (_event, url, mainFrame) => {
      if (mainFrame) tab.url = url;
      publish();
    });
    contents.on("did-fail-load", (_event, code, description, url, mainFrame) => {
      if (!mainFrame || code === -3) return;
      tab.loading = false;
      tab.status = "error";
      tab.url = url;
      tab.message = description;
      this.logger.error("browser.user_tab_navigation_failed", {
        tabId: tab.id, errorCode: code, errorDescription: description,
      });
      publish();
    });
    contents.on("render-process-gone", (_event, details) => {
      tab.loading = false;
      tab.status = "error";
      tab.message = `Browser renderer stopped: ${details.reason}`;
      this.logger.error("browser.user_tab_renderer_gone", {
        tabId: tab.id, reason: details.reason,
      });
      publish();
    });
  }

  bindManualTurnContents(tab) {
    const contents = tab.view.webContents;
    const invalidateConversation = (url, inPlace) => {
      // History state updates and anchor scrolling keep the same document/context.
      if (inPlace && url.split("#", 1)[0] === tab.url?.split("#", 1)[0]) return;
      // Initial login/navigation still carries full context. A later document change
      // cannot prove that an incremental continuation belongs to the same conversation.
      if (!tab.conversationKey
        || (!tab.manualConversationReused && tab.manualState === "awaiting-user")) return;
      tab.conversationKey = undefined;
      if (tab.manualConversationReused && tab.status === "running") {
        tab.status = "error";
        tab.message = "ChatGPT page changed during a resumed Zero Risk turn. Start a new Codex turn to resend the full context.";
        this.signalManualTerminal(tab, "failed");
      }
      this.logger.info("browser.manual_conversation_invalidated", {
        tabId: tab.id,
        traceId: tab.traceId,
      });
    };
    contents.setWindowOpenHandler(({ url }) => {
      let parsed;
      try { parsed = new URL(url); } catch { return { action: "deny" }; }
      if (parsed.protocol === "https:" || parsed.protocol === "http:") {
        void shell.openExternal(parsed.toString()).catch((error) => {
          this.logger.warn("browser.manual_external_url_failed", {
            origin: parsed.origin,
            errorType: error?.name || "Error",
          });
        });
      }
      return { action: "deny" };
    });
    contents.on("did-start-navigation", (_event, url, inPlace, mainFrame) => {
      if (!mainFrame) return;
      invalidateConversation(url, inPlace);
      tab.url = url;
      tab.loading = true;
      this.publishState?.(this.snapshot());
    });
    contents.on("did-start-loading", () => {
      tab.loading = true;
      this.publishState?.(this.snapshot());
    });
    contents.on("did-stop-loading", () => {
      tab.loading = false;
      tab.url = contents.getURL();
      this.publishState?.(this.snapshot());
    });
    contents.on("did-finish-load", () => {
      tab.url = contents.getURL();
      tab.loading = false;
      tab.rendererReady = true;
      tab.bootstrapReady = tab.url.startsWith(CHATGPT_ORIGIN);
      this.syncViewVisibility();
      this.publishState?.(this.snapshot());
    });
    contents.on("did-navigate-in-page", (_event, url, mainFrame) => {
      if (mainFrame) {
        invalidateConversation(url, true);
        tab.url = url;
      }
      this.publishState?.(this.snapshot());
    });
    contents.on("did-fail-load", (_event, errorCode, errorDescription, url, mainFrame) => {
      if (!mainFrame || errorCode === -3) return;
      tab.url = url;
      tab.message = errorDescription;
      this.logger.error("browser.manual_tab_navigation_failed", {
        tabId: tab.id,
        traceId: tab.traceId,
        errorCode,
        origin: navigationOriginForLog(url),
      });
      this.signalManualTerminal(tab, "failed");
      this.removeTurnTab(tab, true);
    });
    contents.on("render-process-gone", (_event, details) => {
      tab.message = `Browser renderer stopped: ${details.reason}`;
      this.logger.error("browser.manual_tab_renderer_gone", {
        tabId: tab.id,
        traceId: tab.traceId,
        reason: details.reason,
        exitCode: details.exitCode,
      });
      this.signalManualTerminal(tab, "failed");
      this.removeTurnTab(tab, true);
    });
  }

  bindWebContents(contents = this.view.webContents) {
    // A parked account's page keeps loading off screen; only the shown account's page sets state.
    const shown = () => this.view?.webContents === contents;
    const on = (event, handler) => contents.on(event, (...args) => { if (shown()) handler(...args); });
    contents.setWindowOpenHandler(({ url }) => {
      if (allowedAuthUrl(url)) {
        return {
          action: "allow",
          createWindow: (options) => this.createAuthView(options, url),
        };
      }
      let parsed;
      try { parsed = new URL(url); } catch { return { action: "deny" }; }
      if (parsed.protocol === "https:" || parsed.protocol === "http:") {
        void shell.openExternal(parsed.toString()).catch((error) => {
          const message = `Could not open the external link: ${error instanceof Error ? error.message : String(error)}`;
          this.logger.error("browser.external_url_open_failed", { url: parsed.toString(), message });
          this.setState({ status: "error", message, loading: false });
        });
      } else {
        this.logger.warn("browser.external_url_rejected", { protocol: parsed.protocol });
      }
      return { action: "deny" };
    });
    on("did-start-navigation", (_event, url, inPlace, mainFrame) => {
      if (!mainFrame || isFailurePageUrl(url)) return;
      if (inPlace) {
        this.setState({ url });
        return;
      }
      this.armHomeNavigationTimeout(contents, url);
      if (this.manualOperation === "ChatGPT login") {
        this.logger.info("browser.auth_navigation_started", {
          surface: "primary",
          origin: navigationOriginForLog(url),
        });
      }
      this.setState(this.activeTraceId || this.manualOperation
        ? { url, loading: true }
        : { status: "loading", message: "Opening ChatGPT", url, loading: true });
    });
    on("did-finish-load", () => {
      this.clearHomeNavigationTimeout();
      // The failure page is not ChatGPT: keep the error state and its URL.
      if (isFailurePageUrl(contents.getURL())) return;
      if (this.manualOperation === "ChatGPT login") {
        this.logger.info("browser.auth_navigation_completed", {
          surface: "primary",
          origin: navigationOriginForLog(contents.getURL()),
        });
      }
      const url = contents.getURL();
      if (browserInteractionModeFor(this) === "manual") {
        this.setState({ status: "idle", message: "No active task", url, loading: false });
        return;
      }
      this.setState({ url, loading: false });
      void this.applyViewportCss();
      void this.markOwnedSurface()
        .then(() => {
          if (this.initializationFailed) {
            void this.writeDescriptor();
            this.initializationFailed = false;
            this.initializationReady = Promise.resolve();
            this.logger.info("browser.initialization_recovered");
          }
          return this.probeAuthentication();
        })
        .catch((error) => {
          this.logger.error("browser.surface_mark_failed", {
            message: error instanceof Error ? error.message : String(error),
          });
          this.setState({ status: "error", message: "Embedded browser ownership could not be established" });
        });
    });
    on("did-start-loading", () => this.setState({ loading: true }));
    on("did-stop-loading", () => {
      this.clearHomeNavigationTimeout();
      if (browserInteractionModeFor(this) === "manual"
        && this.state.status === "loading"
        && !this.activeTraceId
        && !this.manualOperation) {
        this.setState({
          status: "idle",
          message: "No active task",
          url: contents.getURL(),
          loading: false,
        });
        return;
      }
      this.setState({ loading: false });
    });
    on("page-title-updated", (_event, title) => {
      if (browserInteractionModeFor(this) === "manual") return;
      this.setState({ title: typeof title === "string" && title.trim() ? title.trim() : "ChatGPT" });
    });
    on("did-navigate-in-page", (_event, url, mainFrame) => {
      if (mainFrame) this.setState({ url });
    });
    on("did-fail-load", (_event, errorCode, errorDescription, url, mainFrame) => {
      if (!mainFrame || errorCode === -3 || isFailurePageUrl(url)) return;
      this.clearHomeNavigationTimeout();
      this.logger.error(
        this.manualOperation === "ChatGPT login"
          ? "browser.auth_navigation_failed"
          : "browser.navigation_failed",
        {
          ...(this.manualOperation === "ChatGPT login" ? { surface: "primary" } : {}),
          errorCode,
          errorDescription,
          origin: navigationOriginForLog(url),
        },
      );
      this.setState({ status: "error", message: errorDescription, url, loading: false });
      // Show why in the view itself instead of a blank page; the state above keeps the real URL.
      void contents.loadURL(navigationFailurePage({ url, errorCode, errorDescription })).catch(() => {});
    });
    on("render-process-gone", (_event, details) => {
      this.clearHomeNavigationTimeout();
      this.logger.error("browser.renderer_gone", { reason: details.reason, exitCode: details.exitCode });
      this.setState({ status: "error", message: `Browser renderer stopped: ${details.reason}`, loading: false });
    });
  }

  armHomeNavigationTimeout(contents, url) {
    this.clearHomeNavigationTimeout();
    this.homeNavigationTimeout = setTimeout(() => {
      this.homeNavigationTimeout = null;
      if (contents.isDestroyed() || !contents.isLoadingMainFrame()) return;
      contents.stop();
      const message = "ChatGPT did not finish loading within 60 seconds. Check your connection and retry.";
      this.logger.error("browser.navigation_timeout", { origin: navigationOriginForLog(url) });
      this.setState({ status: "error", message, url, loading: false });
    }, BROWSER_NAVIGATION_TIMEOUT_MS);
    this.homeNavigationTimeout.unref?.();
  }

  clearHomeNavigationTimeout() {
    if (!this.homeNavigationTimeout) return;
    clearTimeout(this.homeNavigationTimeout);
    this.homeNavigationTimeout = null;
  }

  async hardRefreshHome(timeoutMs = BROWSER_NAVIGATION_TIMEOUT_MS) {
    const contents = this.view?.webContents;
    if (!contents || contents.isDestroyed()) {
      throw new Error("The managed ChatGPT page is not available for connector verification");
    }
    this.setState({
      status: "loading",
      message: "Refreshing the ChatGPT connector catalog",
      loading: true,
    });
    await new Promise((resolve, reject) => {
      let settled = false;
      let mainNavigationStarted = false;
      const cleanup = () => {
        clearTimeout(timeout);
        contents.off("did-start-navigation", onStarted);
        contents.off("did-navigate", onNavigated);
        contents.off("dom-ready", onDomReady);
        contents.off("did-stop-loading", onStopped);
        contents.off("did-finish-load", onFinished);
        contents.off("did-fail-load", onFailed);
        contents.off("render-process-gone", onRendererGone);
        contents.off("destroyed", onDestroyed);
      };
      const finish = (error) => {
        if (settled) return;
        settled = true;
        cleanup();
        if (error) reject(error);
        else resolve();
      };
      const onStarted = (details) => {
        if (details.isMainFrame && !details.isSameDocument) mainNavigationStarted = true;
      };
      const onNavigated = () => { mainNavigationStarted = true; };
      const onStopped = () => { if (mainNavigationStarted) finish(); };
      const onFinished = () => { if (mainNavigationStarted) finish(); };
      const onDomReady = () => { if (mainNavigationStarted) finish(); };
      const onFailed = (_event, errorCode, errorDescription, url, mainFrame) => {
        if (!mainFrame || errorCode === -3) return;
        finish(new Error(`ChatGPT hard refresh failed: ${errorDescription} (${url})`));
      };
      const onRendererGone = (_event, details) => {
        finish(new Error(`ChatGPT renderer stopped during hard refresh: ${details.reason}`));
      };
      const onDestroyed = () => finish(new Error("ChatGPT closed during hard refresh"));
      const timeout = setTimeout(() => {
        finish(new Error("ChatGPT hard refresh did not finish within 60 seconds"));
        if (!contents.isDestroyed()) contents.stop();
      }, timeoutMs);
      timeout.unref?.();
      contents.on("did-start-navigation", onStarted);
      contents.on("did-navigate", onNavigated);
      contents.on("dom-ready", onDomReady);
      contents.on("did-stop-loading", onStopped);
      contents.on("did-finish-load", onFinished);
      contents.on("did-fail-load", onFailed);
      contents.on("render-process-gone", onRendererGone);
      contents.on("destroyed", onDestroyed);
      try {
        contents.reloadIgnoringCache();
      } catch (error) {
        finish(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  async refreshChatGptHomeDocument(useSavedChats = false) {
    // A navigation from the idle host already creates a fresh ChatGPT document. Reload only an
    // existing new-chat document of the requested kind so the helper observes one authoritative
    // SPA bootstrap (and, for verification, the same kind of chat the task turns use).
    const targetUrl = useSavedChats ? SAVED_CHAT_URL : TEMPORARY_CHAT_URL;
    if (isNewChatUrl(this.view.webContents.getURL(), useSavedChats)) {
      await this.hardRefreshHome();
    } else {
      await this.view.webContents.loadURL(targetUrl);
    }
    await this.waitForAuthenticated(60_000);
  }

  bindChatGptBackendRecovery(browserSession = this.view.webContents.session) {
    // A session holds one onCompleted listener (another call replaces it): one per account. The
    // handler answers only for the shown account's page.
    if (this.recoverySessions.has(browserSession)) return;
    this.recoverySessions.add(browserSession);
    browserSession.webRequest.onCompleted(
      CHATGPT_BACKEND_REQUEST_FILTER,
      details => browserInteractionModeFor(this) === "automatic"
        ? this.handleChatGptBackendResponse(details)
        : undefined,
    );
  }

  handleChatGptBackendResponse(details) {
    const contents = this.view?.webContents;
    if (!contents || contents.isDestroyed() || details?.webContentsId !== contents.id) return false;
    if (!isChatGptBackendUrl(details.url)) return false;

    if (details.statusCode >= 200 && details.statusCode < 400) {
      this.cloudflareChallengeRecoveryArmed = true;
      return false;
    }
    if (!isChatGptCloudflareChallengeResponse(details)) return false;
    if (this.cloudflareChallengeRecovery) {
      this.cloudflareChallengeRecoveryArmed = false;
      return true;
    }
    if (this.activeTraceId || this.manualOperation) {
      this.logger.warn("browser.cloudflare_challenge_not_reloaded", {
        reason: this.activeTraceId ? "turn-active" : "manual-operation-active",
        url: details.url,
      });
      return true;
    }
    if (!this.cloudflareChallengeRecoveryArmed) {
      this.logger.warn("browser.cloudflare_challenge_persisted", { url: details.url });
      return true;
    }
    this.cloudflareChallengeRecoveryArmed = false;
    this.logger.warn("browser.cloudflare_challenge_detected", { url: details.url });
    const recovery = this.reloadHomeAfterCloudflareChallenge();
    const tracked = recovery
      .catch((error) => {
        const message = error instanceof Error ? error.message : String(error);
        this.logger.error("browser.cloudflare_challenge_recovery_failed", { message });
        this.setState({ status: "error", message, loading: false });
      })
      .finally(() => {
        if (this.cloudflareChallengeRecovery === tracked) this.cloudflareChallengeRecovery = null;
      });
    this.cloudflareChallengeRecovery = tracked;
    return true;
  }

  async reloadHomeAfterCloudflareChallenge() {
    const contents = this.view.webContents;
    this.setState({
      status: "loading",
      message: "Refreshing ChatGPT security check",
      loading: true,
    });
    await sleep(this.cloudflareChallengeRecoveryDelayMs);
    if (contents.isDestroyed()) throw new Error("ChatGPT browser closed during security-check recovery");
    const url = contents.getURL();
    if (!url.startsWith(CHATGPT_ORIGIN)) {
      throw new Error("ChatGPT security-check recovery lost its owned browser page");
    }

    // Only responses from this new document may prove that the challenge cleared.
    this.cloudflareChallengeRecoveryArmed = false;
    await contents.loadURL(url);
    await sleep(this.cloudflareChallengeRecoverySettleMs);
    if (!this.cloudflareChallengeRecoveryArmed) {
      throw new Error("ChatGPT security check is still blocking backend requests. Reload ChatGPT and retry.");
    }
    await this.probeAuthentication();
    this.logger.info("browser.cloudflare_challenge_recovered", { url });
  }

  snapshot() {
    const contents = this.activeView()?.webContents;
    const selected = this.selectedTurnTab();
    const selectedUser = this.selectedUserTab();
    const manualInteraction = browserInteractionModeFor(this) === "manual";
    const homeTab = {
      id: "home",
      traceId: null,
      title: manualInteraction ? "ChatGPT" : this.state.title || "ChatGPT",
      status: this.state.status,
      loading: this.state.loading === true,
      active: this.selectedTabId === "home",
      closable: false,
    };
    const state = selected
      ? {
          ...this.state,
          status: selected.status,
          message: selected.message,
          url: selected.url,
          title: selected.interactionMode === "manual" ? selected.label : selected.pageTitle,
          loading: selected.loading,
        }
      : selectedUser
        ? {
            ...this.state,
            status: selectedUser.status,
            message: selectedUser.message,
            url: selectedUser.url,
            title: manualInteraction ? "ChatGPT" : selectedUser.pageTitle,
            loading: selectedUser.loading,
          }
      : manualInteraction
        ? { ...this.state, title: "ChatGPT" }
        : this.state;
    return {
      ...readBrowserNavigationState(contents, {
        ...state,
        visible: this.visible,
        surfaceActive: this.surfaceActive,
      }, {
        readPageTitle: !manualInteraction,
      }),
      activeTabId: this.selectedTabId,
      tabs: this.turnTabs.size + (this.userTabs?.size ?? 0) > 0
        ? [
            // Home is listed while chosen, beside tabs of the user's own, and whenever the chosen
            // tab is a turn on another account (left out of the strip, which would show nothing).
            ...(this.selectedTabId === "home" || (this.userTabs?.size ?? 0) > 0
              || (selected && (selected.partition ?? this.partition) !== this.partition) ? [homeTab] : []),
            ...[...this.turnTabs.values()].map((tab) => this.tabSnapshot(tab)),
            ...[...(this.userTabs?.values() ?? [])].map((tab) => this.tabSnapshot(tab)),
          ]
        : [homeTab],
      // The shown account's limit and the tabs it holds; tabs of sessions on other accounts show too.
      maxTabs: tabLimitOf(this, this.partition),
      accountTabs: tabsOnPartition(this, this.partition),
    };
  }

  setState(patch) {
    this.state = {
      ...this.state,
      ...patch,
      visible: this.visible,
      surfaceActive: this.surfaceActive,
    };
    this.publishState?.(this.snapshot());
  }

  heartbeatTurn(traceId, helperPid, refreshViewport = false) {
    if (typeof refreshViewport !== "boolean") throw new Error("refreshViewport is invalid");
    const tab = [...this.turnTabs.values()].find(candidate => candidate.traceId === traceId);
    if (!tab) {
      const closedOwner = this.closedTurnOwners.get(traceId);
      if (closedOwner === helperPid) throw new Error(`Browser turn ${traceId} was already released`);
      throw new Error(`Browser turn ownership mismatch: no browser tab owns ${traceId}`);
    }
    if (tab.helperPid !== helperPid) {
      throw new Error(`Browser helper ownership mismatch: expected ${tab.helperPid}, received ${helperPid}`);
    }
    if (tab.status !== "running") throw new Error(`Browser turn ${traceId} is no longer running`);
    tab.lastHeartbeatAt = Date.now();
    if (refreshViewport) {
      // Closing an external Playwright CDP session can clear Chromium's effective emulation while
      // Electron still remembers the old dimensions. Mark the exact owned tab dirty and reapply
      // the existing hidden-surface contract before a replacement CDP session is allowed to open.
      tab.deviceEmulationDirty = true;
      this.syncViewVisibility();
    }
    return this.snapshot();
  }

  refreshTurnLeases(reason, now = Date.now()) {
    const refreshed = refreshTurnLeasesAfterSuspension(
      [...this.turnTabs.values()],
      now,
      TURN_TAB_BOOTSTRAP_TIMEOUT_MS,
    );
    if (refreshed.length > 0) {
      this.logger.warn("browser.turn_leases_refreshed_after_suspension", { reason, traceIds: refreshed });
    }
  }

  syncPowerSaveBlocker() {
    // Under plain Node (the launcher test harness) require("electron") exposes no APIs; the
    // blocker is an Electron-only concern and its absence must not break lease bookkeeping.
    if (!powerSaveBlocker || typeof powerSaveBlocker.start !== "function") return;
    const wanted = shouldBlockSleepForTurns([...this.turnTabs.values()]);
    const active = this.powerSaveBlockerId !== null && powerSaveBlocker.isStarted(this.powerSaveBlockerId);
    if (wanted && !active) {
      this.powerSaveBlockerId = powerSaveBlocker.start("prevent-app-suspension");
      this.logger.info("browser.sleep_blocked_for_turns", { blockerId: this.powerSaveBlockerId });
    } else if (!wanted && active) {
      powerSaveBlocker.stop(this.powerSaveBlockerId);
      this.logger.info("browser.sleep_block_released", { blockerId: this.powerSaveBlockerId });
      this.powerSaveBlockerId = null;
    }
  }

  reapExpiredTurnTabs(now = Date.now()) {
    const lastSweepAt = this.lastTurnSweepAt;
    this.lastTurnSweepAt = now;
    if (sweepGapIndicatesSuspension(lastSweepAt, now, TURN_HEARTBEAT_SWEEP_MS)) {
      // The launcher itself was frozen, so missing heartbeats prove suspension rather than a dead
      // helper. Re-baseline every active lease before ordinary reaping resumes.
      this.refreshTurnLeases("sweep_gap", now);
      return;
    }
    for (const tab of [...this.turnTabs.values()]) {
      if (tab.interactionMode === "manual") {
        if (tab.status === "ready") {
          if (now - (tab.lastHeartbeatAt ?? 0) < retainedTabTtl(this)) continue;
          this.logger.info("browser.retained_tab_expired", { tabId: tab.id, traceId: tab.traceId });
          this.removeTurnTab(tab, false);
          continue;
        }
        if (tab.status === "running" && !processRunning(tab.helperPid)) {
          this.logger.warn("browser.manual_orphan_turn_reaped", {
            tabId: tab.id,
            traceId: tab.traceId,
            helperPid: tab.helperPid,
            evidence: "owner_process_exited",
          });
          this.signalManualTerminal(tab, "failed");
          this.removeTurnTab(tab, true);
        }
        continue;
      }
      if (tab.status === "ready") {
        // The tab on screen is in use, not idle: its time starts again once it is left.
        if (this.visible && this.selectedTabId === tab.id) tab.lastHeartbeatAt = now;
        if (now - (tab.lastHeartbeatAt ?? 0) < retainedTabTtl(this)) continue;
        this.logger.info("browser.retained_tab_expired", { tabId: tab.id, traceId: tab.traceId });
        this.removeTurnTab(tab, false);
        continue;
      }
      if (tab.status !== "running") continue;
      // A tab its start is still loading (initializingSurface) stays on the bootstrap deadline even
      // after ChatGPT's page loaded: no helper heartbeats before the start returns, and a load past
      // 60 s was reaped as a lost heartbeat just before its lease was handed out.
      const bootstrapping = tab.bootstrapReady !== true || tab.initializingSurface === true;
      const bootstrapExpired = bootstrapping
        && now >= (tab.bootstrapDeadlineAt ?? Number.POSITIVE_INFINITY);
      const heartbeatExpired = !bootstrapping
        && now - (tab.lastHeartbeatAt ?? 0) >= TURN_HEARTBEAT_TIMEOUT_MS;
      if (!bootstrapExpired && !heartbeatExpired) continue;
      const evidence = bootstrapExpired ? "browser_surface_bootstrap_timeout" : "helper_heartbeat_expired";
      this.logger.warn("browser.orphan_turn_reaped", {
        tabId: tab.id,
        traceId: tab.traceId,
        helperPid: tab.helperPid,
        evidence,
      });
      this.removeTurnTab(tab, true);
    }
  }

  setBounds(bounds, rendererZoomFactor = 1) {
    const [width, height] = this.window.getContentSize();
    this.bounds = constrainBrowserBounds(
      normalizeBounds(scaleBrowserBounds(bounds, rendererZoomFactor)),
      { width, height },
    );
    this.boundsReady = true;
    this.authView?.setBounds(this.bounds);
    this.syncViewVisibility();
    if (browserInteractionModeFor(this) === "automatic") {
      void this.view.webContents.executeJavaScript("window.dispatchEvent(new Event('resize'))", true).catch(() => {});
      if (this.authView && !this.authView.webContents.isDestroyed()) {
        void this.authView.webContents.executeJavaScript("window.dispatchEvent(new Event('resize'))", true).catch(() => {});
      }
    }
  }

  activeView() {
    return this.authView || this.selectedTurnTab()?.view || this.selectedUserTab()?.view || this.view;
  }

  hiddenTurnBounds() {
    const [contentWidth, contentHeight] = this.window.getContentSize();
    const width = Math.max(HIDDEN_TURN_VIEWPORT.width, Math.round(contentWidth || 0));
    const height = Math.max(HIDDEN_TURN_VIEWPORT.height, Math.round(contentHeight || 0));
    return {
      // Electron collapses a hidden WebContentsView's renderer viewport to 0x0. Keep running
      // turn views visible to Chromium and move them wholly outside the launcher content area so
      // Playwright retains a real viewport without exposing the task to the user.
      x: Math.max(width, Math.round(contentWidth || 0)) + 1,
      y: Math.max(height, Math.round(contentHeight || 0)) + 1,
      width,
      height,
    };
  }

  enableHiddenTurnViewport(contents, { width, height }) {
    contents.enableDeviceEmulation({
      screenPosition: "desktop",
      screenSize: { width, height },
      viewPosition: { x: 0, y: 0 },
      deviceScaleFactor: 0,
      viewSize: { width, height },
      scale: 1,
    });
  }

  /** Holds a hidden automatic turn tab's animations still (HIDDEN_TURN_STILL_CSS), or lets them run. */
  holdTurnAnimations(tab, hold) {
    const contents = tab.view.webContents;
    if (typeof contents?.insertCSS !== "function" || contents.isDestroyed() || Boolean(tab.animationsHeld) === hold) return;
    tab.animationsHeld = hold;
    const insert = () => contents.insertCSS(HIDDEN_TURN_STILL_CSS, { cssOrigin: "user" }).catch(() => null);
    if (!tab.animationsHoldBound) {
      tab.animationsHoldBound = true;
      // A new document drops inserted CSS: a held tab is held again.
      contents.on("dom-ready", () => { if (tab.animationsHeld && !contents.isDestroyed()) tab.stillCssKey = insert(); });
    }
    if (hold) {
      tab.stillCssKey = insert();
      return;
    }
    const key = tab.stillCssKey;
    tab.stillCssKey = null;
    void key?.then(value => { if (value && !contents.isDestroyed()) return contents.removeInsertedCSS(value); }).catch(() => {});
  }

  presentTurnView(tab, visible) {
    if (tab.interactionMode === "manual") {
      tab.view.setBounds(visible ? this.bounds : this.hiddenTurnBounds());
      tab.view.setVisible(visible || tab.status === "running");
      return;
    }
    if (visible) {
      // Establish native on-screen bounds before removing the background viewport contract.
      tab.view.setBounds(this.bounds);
      if (tab.rendererReady && tab.deviceEmulationViewport) {
        tab.view.webContents.disableDeviceEmulation();
        tab.deviceEmulationViewport = null;
      }
      if (tab.rendererReady) tab.deviceEmulationDirty = false;
    } else {
      // A WebContentsView born outside a hidden BrowserWindow has a 0x0 renderer even when its
      // native bounds and View visibility are non-zero. Device emulation gives background turns
      // an explicit renderer viewport before moving the view outside the launcher surface.
      const bounds = this.hiddenTurnBounds();
      if (tab.rendererReady
        && (tab.deviceEmulationDirty
          || tab.deviceEmulationViewport?.width !== bounds.width
          || tab.deviceEmulationViewport?.height !== bounds.height)) {
        this.enableHiddenTurnViewport(tab.view.webContents, bounds);
        tab.deviceEmulationViewport = { width: bounds.width, height: bounds.height };
        tab.deviceEmulationDirty = false;
      }
      tab.view.setBounds(bounds);
    }
    this.holdTurnAnimations(tab, !visible);
    tab.view.setVisible(visible || tab.status === "running");
  }

  presentPrimaryView(visible) {
    // Non-browser launcher pages must never be covered by the native ChatGPT view. Keep the
    // descriptor-owned view attached while the browser page is selected, but fully hide it when
    // the launcher explicitly deactivates the browser surface.
    if (!this.surfaceActive) {
      this.view.setVisible(false);
      return;
    }
    this.view.setBounds(visible ? this.bounds : this.hiddenTurnBounds());
    this.view.setVisible(true);
  }

  activateHomeSurface() {
    this.selectedTabId = "home";
    this.syncViewVisibility();
    if (this.visible && this.surfaceActive) this.activeView().webContents.focus();
    this.publishState?.(this.snapshot());
    void this.writeDescriptor();
  }

  syncViewVisibility() {
    const windowVisible = this.window.isVisible() && !this.window.isMinimized();
    const visible = windowVisible
      && browserViewVisible(this.visible, this.surfaceActive, this.boundsReady);
    const selected = this.selectedTurnTab();
    const selectedUser = this.selectedUserTab();
    this.presentPrimaryView(visible && !this.authView && !selected && !selectedUser);
    for (const tab of this.turnTabs.values()) {
      const tabVisible = visible && !this.authView && selected?.id === tab.id;
      this.presentTurnView(tab, tabVisible);
    }
    for (const tab of this.userTabs?.values() ?? []) {
      const tabVisible = visible && !this.authView && selectedUser?.id === tab.id;
      if (tabVisible) tab.view.setBounds(this.bounds);
      tab.view.setVisible(tabVisible);
    }
    this.authView?.setVisible(visible);
  }

  selectTab(tabId) {
    if (tabId !== "home" && !this.turnTabs.has(tabId) && !this.userTabs?.has(tabId)) throw new Error("Browser tab does not exist");
    if (this.authView) this.closeAuthView(this.authView, true);
    this.selectedTabId = tabId;
    this.syncViewVisibility();
    if (this.visible && this.surfaceActive) this.activeView().webContents.focus();
    this.publishState?.(this.snapshot());
    void this.writeDescriptor();
    return this.snapshot();
  }

  /** Deletes the saved chat a released tab's turn wrote in, then closes the tab's page. */
  deleteOwnedConversation(tab) {
    const contents = tab.view.webContents;
    const log = (event, details) => this.logger[event === "browser.conversation_deleted" ? "info" : "warn"](event, {
      tabId: tab.id, traceId: tab.traceId, ...details,
    });
    let origin = null;
    try { origin = new URL(contents.getURL()).origin; } catch {}
    // Only on chatgpt.com: the request is relative to the page, and a tab moved elsewhere skips it.
    if (origin !== CHATGPT_ORIGIN) {
      log("browser.conversation_delete_skipped", { reason: "tab is not on chatgpt.com" });
      contents.close();
      return Promise.resolve();
    }
    let timer;
    const timeout = new Promise((resolve) => {
      timer = setTimeout(() => resolve({ ok: false, reason: "timeout" }), CONVERSATION_DELETE_TIMEOUT_MS);
    });
    return Promise.race([contents.executeJavaScript(deleteConversationScript(tab.ownedConversation), true), timeout])
      .then((result) => log(result?.ok ? "browser.conversation_deleted" : "browser.conversation_delete_failed", {
        ...(result?.status ? { status: result.status } : {}), ...(result?.reason ? { reason: result.reason } : {}),
      }))
      .catch((error) => log("browser.conversation_delete_failed", { reason: String(error?.message || error).slice(0, 200) }))
      .finally(() => {
        clearTimeout(timer);
        if (!contents.isDestroyed()) contents.close();
      });
  }

  removeTurnTab(tab, abortRunning) {
    if (!this.turnTabs.has(tab.id)) return;
    this.turnTabs.delete(tab.id);
    if (tab.interactionMode === "manual") {
      if (tab.manualDeadlineTimer) clearTimeout(tab.manualDeadlineTimer);
      tab.manualDeadlineTimer = null;
      tab.manualDeadlineAt = null;
      tab.prompt = null;
      tab.promptDigest = null;
      for (const resolve of tab.manualWaiters || []) resolve({ status: "cancelled" });
      tab.manualWaiters?.clear();
      if (!tab.manualTerminalResolutionSuppressed) {
        for (const resolve of tab.manualTerminalWaiters || []) resolve({ status: "cancelled" });
      }
      tab.manualTerminalWaiters?.clear();
    }
    this.syncPowerSaveBlocker();
    if (abortRunning && tab.status === "running") {
      this.closedTurnOwners.set(tab.traceId, tab.helperPid);
      tab.status = "aborted";
    }
    try { this.window.contentView.removeChildView(tab.view); } catch {}
    if (!tab.view.webContents.isDestroyed()) {
      // A saved chat the bridge wrote in is deleted when its tab is let go, so saved chats leave no
      // history behind; the hidden page closes once ChatGPT answered (or after a bounded wait).
      // A chat recorded for its Codex thread is kept: the thread's later turns reopen it, and it is
      // archived or deleted with the thread (codex-chat-lifecycle-sync.cjs).
      if (tab.ownedConversation && !tab.persistedConversation && tab.interactionMode !== "manual" && useSavedChatsFor(this)) {
        this.deleteOwnedConversation(tab);
      } else {
        tab.view.webContents.close();
      }
    }
    if (this.selectedTabId === tab.id) {
      this.selectedTabId = [...this.turnTabs.keys()].at(-1) || "home";
      const homeContents = this.view?.webContents;
      if (this.selectedTabId === "home"
        && !this.activeTraceId
        && homeContents
        && typeof homeContents.getURL === "function"
        && homeContents.getURL() === IDLE_BROWSER_URL) {
        // Never reveal the unhydrated about:blank host after a turn tab disappears. It renders as a
        // gray, apparently frozen ChatGPT tab even though there is no browser turn left to show.
        this.hide?.();
      }
    }
    this.syncViewVisibility();
    this.publishState?.(this.snapshot());
    // Reached from a page's load-failure and crash events and from the turn-tab sweep timer, where a
    // throw (a full disk, the file held open) was uncaught. The next change writes it again.
    try {
      void this.writeDescriptor();
    } catch (error) {
      this.logger?.warn?.("browser.descriptor_write_failed", { message: error instanceof Error ? error.message : String(error) });
    }
  }

  removeUserTab(tab) {
    if (this.userTabs?.get(tab.id) !== tab) return;
    this.userTabs.delete(tab.id);
    try { this.window.contentView.removeChildView(tab.view); } catch {}
    if (!tab.view.webContents.isDestroyed()) tab.view.webContents.close();
    if (this.selectedTabId === tab.id) {
      this.selectedTabId = [...this.userTabs.keys()].at(-1) || "home";
    }
    this.syncViewVisibility();
    this.publishState?.(this.snapshot());
  }

  rememberUserCancelledTurn(traceId, helperPid) {
    this.userCancelledTurnOwners.delete(traceId);
    this.userCancelledTurnOwners.set(traceId, helperPid);
    while (this.userCancelledTurnOwners.size > MAX_CANCELLED_TURN_TRACES) {
      const oldest = this.userCancelledTurnOwners.keys().next();
      if (oldest.done) break;
      this.userCancelledTurnOwners.delete(oldest.value);
    }
  }

  async closeTab(tabId) {
    const userTab = this.userTabs?.get(tabId);
    if (userTab) {
      this.removeUserTab(userTab);
      this.logger.info("browser.user_tab_closed", { tabId });
      return this.snapshot();
    }
    const tab = this.turnTabs.get(tabId);
    if (!tab) throw new Error("Browser tab does not exist");
    const running = tab.status === "running";
    if (tab.interactionMode === "manual") {
      this.signalManualTerminal(tab, "cancelled");
      if (running && this.cancelTurn) {
        try {
          await this.cancelTurn(tab.traceId);
        } catch (error) {
          this.logger.warn("browser.manual_turn_cancel_failed", {
            tabId: tab.id,
            traceId: tab.traceId,
            errorType: error?.name || "Error",
          });
        }
      }
      if (this.turnTabs.get(tabId) === tab) this.removeTurnTab(tab, true);
      this.logger.info("browser.tab_closed", { tabId, traceId: tab.traceId, status: tab.status });
      return this.snapshot();
    }
    if (running) {
      this.rememberUserCancelledTurn(tab.traceId, tab.helperPid);
      // A running tab is the browser document for one exact Codex turn. Keep that document alive
      // until the runtime acknowledges cancellation; otherwise a failed control request would
      // destroy the only DOM source while leaving an orphaned Codex turn running.
      if (this.cancelTurn) await this.cancelTurn(tab.traceId);
    }
    // The helper can deliver /v1/turn/end while targeted cancellation is in flight. In that case
    // endTurn already released this exact tab and there is nothing left to destroy here.
    if (this.turnTabs.get(tabId) === tab) this.removeTurnTab(tab, true);
    this.logger.info("browser.tab_closed", { tabId, traceId: tab.traceId, status: tab.status });
    return this.snapshot();
  }

  createAuthView(options = {}, requestedUrl = "") {
    this.closeAuthView(this.authView, true);
    const authView = new WebContentsView({ webContents: options.webContents });
    this.authView = authView;
    this.authNavigationError = null;
    this.window.contentView.addChildView(authView);
    authView.setBounds(this.bounds);
    authView.setVisible(false);
    authView.webContents.setZoomFactor(this.state.zoomFactor);
    this.bindShellZoomShortcuts(authView.webContents);
    const contents = authView.webContents;
    const clearNavigationTimeout = () => {
      if (!authView.navigationTimeout) return;
      clearTimeout(authView.navigationTimeout);
      authView.navigationTimeout = null;
    };
    const armNavigationTimeout = (url) => {
      clearNavigationTimeout();
      authView.navigationTimeout = setTimeout(() => {
        authView.navigationTimeout = null;
        if (this.authView !== authView || contents.isDestroyed()) return;
        contents.stop();
        const message = "The ChatGPT sign-in page did not finish loading within 60 seconds. Check your connection and try again.";
        this.authNavigationError = new Error(message);
        this.logger.error("browser.auth_navigation_timeout", {
          surface: "popup",
          origin: navigationOriginForLog(url),
        });
        this.closeAuthView(authView, true, false);
        this.setState({ status: "error", message, url, loading: false });
      }, BROWSER_NAVIGATION_TIMEOUT_MS);
      authView.navigationTimeout.unref?.();
    };
    armNavigationTimeout(requestedUrl);
    this.setState({
      status: "loading",
      message: "Opening ChatGPT sign-in",
      url: requestedUrl || contents.getURL(),
      loading: true,
    });
    contents.on("did-start-navigation", (_event, url, _inPlace, mainFrame) => {
      if (!mainFrame) return;
      armNavigationTimeout(url);
      this.logger.info("browser.auth_navigation_started", {
        surface: "popup",
        origin: navigationOriginForLog(url),
      });
    });
    contents.on("did-start-loading", () => this.setState({ loading: true }));
    contents.on("did-stop-loading", () => {
      clearNavigationTimeout();
      this.setState({ loading: false });
    });
    contents.on("did-finish-load", () => {
      clearNavigationTimeout();
      this.logger.info("browser.auth_navigation_completed", {
        surface: "popup",
        origin: navigationOriginForLog(contents.getURL()),
      });
      this.setState({ url: contents.getURL(), loading: false });
      // Its page load rejects on an aborted navigation, a proxy failure or no network.
      if (browserInteractionModeFor(this) === "automatic") {
        void this.probeAuthentication().catch((error) => this.logger?.warn?.("browser.auth_probe_failed", {
          message: error instanceof Error ? error.message : String(error),
        }));
      }
    });
    contents.on("page-title-updated", (_event, title) => {
      if (browserInteractionModeFor(this) === "manual") return;
      this.setState({ title: typeof title === "string" && title.trim() ? title.trim() : "ChatGPT" });
    });
    contents.on("close", () => this.closeAuthView(authView, true));
    contents.on("destroyed", () => this.closeAuthView(authView, false));
    contents.on("did-fail-load", (_event, errorCode, errorDescription, url, mainFrame) => {
      if (!mainFrame || errorCode === -3) return;
      clearNavigationTimeout();
      const message = `ChatGPT sign-in page failed to load: ${errorDescription}`;
      this.authNavigationError = new Error(message);
      this.logger.error("browser.auth_navigation_failed", {
        surface: "popup",
        errorCode,
        errorDescription,
        origin: navigationOriginForLog(url),
      });
      this.closeAuthView(authView, true, false);
      this.setState({ status: "error", message, url, loading: false });
    });
    contents.on("render-process-gone", (_event, details) => {
      clearNavigationTimeout();
      const message = `ChatGPT sign-in renderer stopped: ${details.reason}`;
      this.authNavigationError = new Error(message);
      this.logger.error("browser.auth_renderer_gone", { reason: details.reason, exitCode: details.exitCode });
      this.closeAuthView(authView, false);
      this.setState({ status: "error", message, loading: false });
    });
    contents.setWindowOpenHandler(({ url }) => {
      if (allowedAuthUrl(url)) {
        armNavigationTimeout(url);
        void contents.loadURL(url).catch((error) => {
          if (error && typeof error === "object" && error.code === "ERR_ABORTED") return;
          if (this.authView !== authView || contents.isDestroyed()) return;
          clearNavigationTimeout();
          const message = `ChatGPT sign-in page failed to open: ${error instanceof Error ? error.message : String(error)}`;
          this.authNavigationError = new Error(message);
          this.logger.error("browser.auth_window_open_failed", {
            surface: "popup",
            origin: navigationOriginForLog(url),
            ...navigationErrorForLog(error),
          });
          this.closeAuthView(authView, true, false);
          this.setState({ status: "error", message, url, loading: false });
        });
      } else {
        let parsed;
        try { parsed = new URL(url); } catch { return { action: "deny" }; }
        if (parsed.protocol === "https:" || parsed.protocol === "http:") {
          void shell.openExternal(parsed.toString()).catch((error) => {
            const message = `Could not open the external link: ${error instanceof Error ? error.message : String(error)}`;
            this.logger.error("browser.external_url_open_failed", { url: parsed.toString(), message });
            this.setState({ status: "error", message, loading: false });
          });
        }
      }
      return { action: "deny" };
    });
    this.syncViewVisibility();
    this.logger.info("browser.auth_surface_opened");
    return contents;
  }

  closeAuthView(authView, closeContents, refreshMain = true) {
    if (!authView || this.authView !== authView) return;
    if (authView.navigationTimeout) {
      clearTimeout(authView.navigationTimeout);
      authView.navigationTimeout = null;
    }
    this.authView = null;
    try { this.window.contentView.removeChildView(authView); } catch {}
    if (closeContents && !authView.webContents.isDestroyed()) authView.webContents.close();
    this.syncViewVisibility();
    this.logger.info("browser.auth_surface_closed");
    if (refreshMain && this.manualOperation === "ChatGPT login" && !this.view.webContents.isDestroyed()) {
      void this.view.webContents.loadURL(newChatUrlFor(this)).catch((error) => {
        this.logger.error("browser.auth_refresh_failed", {
          origin: navigationOriginForLog(newChatUrlFor(this)),
          ...navigationErrorForLog(error),
        });
      });
    }
  }

  async applyViewportCss() {
    requireAutomaticBrowserInspection(this, "ChatGPT viewport CSS injection");
    const contents = this.view?.webContents;
    if (!contents || contents.isDestroyed()) return;
    if (this.viewportCssKey) {
      await contents.removeInsertedCSS(this.viewportCssKey).catch(() => {});
      this.viewportCssKey = null;
    }
    this.viewportCssKey = await contents.insertCSS(CHATGPT_VIEWPORT_CSS).catch(() => null);
  }

  async markOwnedSurface() {
    requireAutomaticBrowserInspection(this, "ChatGPT DOM surface ownership marking");
    const surfaceId = JSON.stringify(this.surfaceId);
    await this.view.webContents.executeJavaScript(`(() => {
      Object.defineProperty(globalThis, "__CODEX_WEB_GPT_SURFACE_ID__", {
        value: ${surfaceId},
        configurable: true,
        enumerable: false,
        writable: false,
      });
      document.documentElement.dataset.codexWebGptSurface = ${surfaceId};
    })()`, true);
  }

  show() {
    this.visible = true;
    this.syncViewVisibility();
    this.setState({ visible: true });
    if (this.surfaceActive && this.boundsReady) this.activeView().webContents.focus();
  }

  async reveal(inspectSession = true) {
    if (inspectSession) requireAutomaticBrowserInspection(this, "ChatGPT session inspection");
    this.show();
    await this.openHomePage(inspectSession);
    return this.snapshot();
  }

  /**
   * Puts ChatGPT on the shown account's page while it still holds the blank idle document. An
   * account switched to while the Browser tab was hidden stayed blank: only reveal loaded it.
   */
  async openHomePage(inspectSession = true) {
    if (this.selectedTurnTab() || this.view.webContents.getURL() !== IDLE_BROWSER_URL) return;
    await this.view.webContents.loadURL(newChatUrlFor(this));
    if (inspectSession) await this.probeAuthentication();
  }

  hide() {
    this.visible = false;
    this.syncViewVisibility();
    this.setState({ visible: false });
  }

  setSurfaceActive(active) {
    this.surfaceActive = active === true;
    this.syncViewVisibility();
    this.setState({ surfaceActive: this.surfaceActive });
    return this.snapshot();
  }

  async waitForSurfaceReady(timeoutMs = 15_000, pollMs = 50) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (this.surfaceActive && this.boundsReady) return;
      await sleep(pollMs);
    }
    throw new Error(
      "Embedded browser surface did not receive measured bounds before the operation",
    );
  }

  navigate(action) {
    if (this.activeTraceId && !this.selectedUserTab()) {
      throw new Error("Browser navigation is locked while ChatGPT is running a Codex turn");
    }
    if (this.manualOperation) {
      throw new Error(`Browser navigation is locked during ${this.manualOperation}`);
    }
    const contents = this.activeView().webContents;
    navigateBrowser(contents, action);
    return this.snapshot();
  }

  zoom(action) {
    if (action !== "in" && action !== "out" && action !== "reset") {
      throw new Error(`Unknown browser zoom action: ${action}`);
    }
    const current = this.state.zoomFactor;
    const currentIndex = ZOOM_FACTORS.indexOf(current);
    if (currentIndex < 0) throw new Error(`Browser zoom state is invalid: ${current}`);
    const next = action === "reset"
      ? 1
      : action === "in"
        ? ZOOM_FACTORS[Math.min(currentIndex + 1, ZOOM_FACTORS.length - 1)]
        : ZOOM_FACTORS[Math.max(currentIndex - 1, 0)];
    const contents = [this.view, ...[...this.turnTabs.values()].map((tab) => tab.view), ...[...(this.userTabs?.values() ?? [])].map((tab) => tab.view)]
      .map((view) => view?.webContents)
      .filter((candidate) => candidate && !candidate.isDestroyed());
    if (contents.length === 0) throw new Error("ChatGPT browser is unavailable for zoom");
    for (const candidate of contents) candidate.setZoomFactor(next);
    this.setState({ zoomFactor: next });
    return this.snapshot();
  }

  rememberManualTerminal(traceId, helperPid, status) {
    this.manualTerminalSignals.delete(traceId);
    this.manualTerminalSignals.set(traceId, { helperPid, status });
    while (this.manualTerminalSignals.size > MAX_MANUAL_TERMINAL_SIGNALS) {
      const oldest = this.manualTerminalSignals.keys().next();
      if (oldest.done) break;
      this.manualTerminalSignals.delete(oldest.value);
    }
  }

  rememberManualCompletion(traceId, helperPid) {
    this.manualCompletionSignals.delete(traceId);
    this.manualCompletionSignals.set(traceId, { helperPid });
    while (this.manualCompletionSignals.size > MAX_MANUAL_TERMINAL_SIGNALS) {
      const oldest = this.manualCompletionSignals.keys().next();
      if (oldest.done) break;
      this.manualCompletionSignals.delete(oldest.value);
    }
  }

  signalManualTerminal(tab, status) {
    if (tab.interactionMode !== "manual") return;
    if (tab.manualDeadlineTimer) clearTimeout(tab.manualDeadlineTimer);
    tab.manualDeadlineTimer = null;
    tab.manualDeadlineAt = null;
    tab.manualState = status === "timeout" ? "timed-out" : status;
    tab.lastHeartbeatAt = Date.now();
    tab.prompt = null;
    tab.promptDigest = null;
    this.rememberManualTerminal(tab.traceId, tab.helperPid, status);
    for (const resolve of tab.manualWaiters || []) resolve({ status });
    tab.manualWaiters?.clear();
    for (const resolve of tab.manualTerminalWaiters || []) resolve({ status });
    tab.manualTerminalWaiters?.clear();
  }

  armManualTurnDeadline(tab) {
    if (tab.interactionMode !== "manual"
      || tab.manualState !== "awaiting-user"
      || !tab.manualDeadlineAt) return;
    if (tab.manualDeadlineTimer) clearTimeout(tab.manualDeadlineTimer);
    const delay = Math.max(0, tab.manualDeadlineAt - Date.now());
    tab.manualDeadlineTimer = setTimeout(() => {
      if (this.turnTabs.get(tab.id) !== tab
        || tab.manualState !== "awaiting-user") return;
      const timeoutSeconds = Math.round(tab.manualSubmitTimeoutMs / 1_000);
      tab.status = "error";
      tab.message = `Prompt submission was not confirmed within ${timeoutSeconds} seconds`;
      this.signalManualTerminal(tab, "timeout");
      this.publishState?.(this.snapshot());
      this.logger.warn("browser.manual_turn_timed_out", {
        tabId: tab.id,
        traceId: tab.traceId,
        phase: "sent-confirmation",
      });
    }, delay);
    tab.manualDeadlineTimer.unref?.();
  }

  writeManualPrompt(prompt) {
    if (!this.clipboard || typeof this.clipboard.writeText !== "function") {
      throw new Error("Electron clipboard is unavailable");
    }
    // Electron 44+ returns a promise here. The user pastes by hand later, so the
    // turn need not wait; only keep a failed write from becoming an unhandled rejection.
    Promise.resolve(this.clipboard.writeText(prompt)).catch((error) => {
      this.logger.warn("browser.manual_prompt_copy_failed", { error: error instanceof Error ? error.message : String(error) });
    });
  }

  beginManualTurn(traceId, helperPid, prompt, conversationKey, resumePrompt, compaction = false) {
    if (this.manualOperation) {
      throw new Error(`ChatGPT browser is busy with ${this.manualOperation}`);
    }
    if (typeof prompt !== "string" || prompt.length < 1 || prompt.length > MAX_MANUAL_PROMPT_CHARS) {
      throw new Error(`Manual prompt must contain between 1 and ${MAX_MANUAL_PROMPT_CHARS} characters`);
    }
    if (resumePrompt !== undefined
      && (typeof resumePrompt !== "string"
        || resumePrompt.length < 1
        || resumePrompt.length > MAX_MANUAL_PROMPT_CHARS)) {
      throw new Error(`Manual resume prompt must contain between 1 and ${MAX_MANUAL_PROMPT_CHARS} characters`);
    }
    if (typeof compaction !== "boolean") throw new Error("Manual compaction flag must be boolean");
    const manualSubmitTimeoutMs = compaction
      ? MANUAL_COMPACTION_SUBMIT_TIMEOUT_MS
      : MANUAL_SUBMIT_TIMEOUT_MS;
    const completion = this.manualCompletionSignals.get(traceId);
    if (completion) {
      throw new Error(completion.helperPid === helperPid
        ? `Zero Risk turn ${traceId} is already completed`
        : `Zero Risk turn ${traceId} is owned by another process`);
    }
    const terminal = this.manualTerminalSignals.get(traceId);
    if (terminal?.helperPid === helperPid) {
      const error = new Error(terminal.status === "timeout"
        ? `Zero Risk turn ${traceId} timed out before Sent confirmation`
        : `Zero Risk turn ${traceId} is already ${terminal.status}`);
      error.code = terminal.status === "timeout" ? "manual_turn_timed_out" : "turn_cancelled";
      throw error;
    }
    const sameTrace = [...this.turnTabs.values()].find(tab => tab.traceId === traceId);
    if (sameTrace) {
      if (sameTrace.interactionMode !== "manual") {
        throw new Error(`Browser turn ${traceId} already belongs to automatic interaction`);
      }
      if (sameTrace.helperPid !== helperPid) {
        if (processRunning(sameTrace.helperPid)) {
          throw new Error(`Zero Risk turn ${traceId} is owned by another process`);
        }
        this.signalManualTerminal(sameTrace, "failed");
        this.removeTurnTab(sameTrace, true);
        this.rememberManualTerminal(traceId, helperPid, "failed");
        const error = new Error(
          `Zero Risk turn ${traceId} lost its original runtime owner and cannot be resumed; start a new Codex turn`,
        );
        error.code = "manual_turn_owner_lost";
        throw error;
      }
      if (sameTrace.manualSubmitTimeoutMs !== manualSubmitTimeoutMs) {
        throw new Error(`Zero Risk turn ${traceId} was retried with a different compaction mode`);
      }
      const retryPrompt = sameTrace.manualConversationReused ? resumePrompt : prompt;
      if (typeof retryPrompt !== "string"
        || sameTrace.promptDigest !== manualPromptDigest(retryPrompt)) {
        throw new Error(`Zero Risk turn ${traceId} was retried with a different prompt`);
      }
      sameTrace.helperPid = helperPid;
      this.selectedTabId = sameTrace.id;
      this.showWindow();
      this.show();
      this.publishState?.(this.snapshot());
      return {
        tabId: sameTrace.id,
        reused: true,
        deadlineAt: sameTrace.manualDeadlineAt ? new Date(sameTrace.manualDeadlineAt).toISOString() : null,
        state: sameTrace.manualState,
      };
    }
    const retained = conversationKey
      ? [...this.turnTabs.values()].filter(tab => (
          tab.interactionMode === "manual"
          && tab.status === "ready"
          && tab.conversationKey === conversationKey
        ))
      : [];
    if (retained.length > 1) {
      throw new Error(`Manual ChatGPT conversation ${conversationKey} owns multiple browser tabs`);
    }
    let tab = retained[0];
    if (tab) {
      if (typeof resumePrompt !== "string" || !resumePrompt) {
        throw new Error("A retained Zero Risk conversation requires an incremental resume prompt");
      }
      this.writeManualPrompt(resumePrompt);
      tab.traceId = traceId;
      tab.helperPid = helperPid;
      tab.status = "running";
      tab.loading = false;
      tab.message = "Paste the copied prompt, add any images yourself because Zero Risk cannot transfer them, choose a model and effort, then press Sent";
      tab.manualState = "awaiting-user";
      tab.manualSubmitTimeoutMs = manualSubmitTimeoutMs;
      tab.manualDeadlineAt = Date.now() + manualSubmitTimeoutMs;
      tab.prompt = resumePrompt;
      tab.promptDigest = manualPromptDigest(resumePrompt);
      tab.manualConversationReused = true;
      tab.sentAt = null;
      tab.manualTerminalResolutionSuppressed = false;
    } else {
      tab = this.createManualTurnTab(
        traceId,
        helperPid,
        conversationKey,
        prompt,
        manualSubmitTimeoutMs,
      );
      try {
        this.writeManualPrompt(prompt);
      } catch (error) {
        this.signalManualTerminal(tab, "failed");
        this.removeTurnTab(tab, true);
        throw error;
      }
    }
    this.armManualTurnDeadline(tab);
    this.selectedTabId = tab.id;
    this.showWindow();
    this.show();
    this.publishState?.(this.snapshot());
    void this.writeDescriptor();
    this.logger.info("browser.manual_turn_started", {
      tabId: tab.id,
      traceId,
      reused: retained.length === 1,
    });
    return {
      tabId: tab.id,
      reused: retained.length === 1,
      deadlineAt: new Date(tab.manualDeadlineAt).toISOString(),
      state: tab.manualState,
    };
  }

  async waitManualSent(traceId, helperPid, observerTimeoutMs = 35_000) {
    const tab = [...this.turnTabs.values()].find(candidate => candidate.traceId === traceId);
    if (!tab) {
      const terminal = this.manualTerminalSignals.get(traceId);
      if (terminal?.helperPid === helperPid) return { status: terminal.status };
      throw new Error(`Zero Risk turn ownership mismatch: no browser tab owns ${traceId}`);
    }
    if (tab.interactionMode !== "manual" || tab.helperPid !== helperPid) {
      throw new Error(`Zero Risk turn ${traceId} ownership is invalid`);
    }
    if (["sent", "running", "completed"].includes(tab.manualState)) {
      return { status: "sent", sentAt: tab.sentAt };
    }
    if (tab.manualState !== "awaiting-user") {
      return { status: tab.manualState === "timed-out" ? "timeout" : tab.manualState };
    }
    return await new Promise((resolve) => {
      let settled = false;
      const finish = (result) => {
        if (settled) return;
        settled = true;
        clearTimeout(observerTimer);
        tab.manualWaiters.delete(finish);
        resolve(result);
      };
      const observerTimer = setTimeout(() => finish({ status: "pending" }), observerTimeoutMs);
      observerTimer.unref?.();
      tab.manualWaiters.add(finish);
    });
  }

  async waitManualTerminal(traceId, helperPid, observerTimeoutMs = 35_000) {
    const terminal = this.manualTerminalSignals.get(traceId);
    if (terminal?.helperPid === helperPid) return { status: terminal.status };
    const tab = [...this.turnTabs.values()].find(candidate => candidate.traceId === traceId);
    if (!tab || tab.interactionMode !== "manual" || tab.helperPid !== helperPid) {
      throw new Error(`Zero Risk turn ownership mismatch: no browser tab owns ${traceId}`);
    }
    return await new Promise((resolve) => {
      let settled = false;
      const finish = (result) => {
        if (settled) return;
        settled = true;
        clearTimeout(observerTimer);
        tab.manualTerminalWaiters.delete(finish);
        resolve(result);
      };
      const observerTimer = setTimeout(() => finish({ status: "pending" }), observerTimeoutMs);
      observerTimer.unref?.();
      tab.manualTerminalWaiters.add(finish);
    });
  }

  copyManualPrompt(tabId) {
    const tab = this.turnTabs.get(tabId);
    if (!tab || tab.interactionMode !== "manual" || typeof tab.prompt !== "string") {
      throw new Error("Manual prompt is no longer available");
    }
    this.writeManualPrompt(tab.prompt);
    this.logger.info("browser.manual_prompt_copied", { tabId: tab.id, traceId: tab.traceId });
    return this.snapshot();
  }

  confirmManualSent(tabId) {
    const tab = this.turnTabs.get(tabId);
    if (!tab || tab.interactionMode !== "manual") throw new Error("Zero Risk tab does not exist");
    if (tab.manualState !== "awaiting-user") {
      if (["sent", "running", "completed"].includes(tab.manualState)) return this.snapshot();
      throw new Error("Zero Risk turn can no longer be marked as sent");
    }
    if (tab.manualDeadlineTimer) clearTimeout(tab.manualDeadlineTimer);
    tab.manualDeadlineTimer = null;
    tab.manualState = "sent";
    // Sent ends the human handoff deadline. Model thinking is owned by the live turn and
    // remains cancellable through its helper or tab, including before the first MCP bind.
    tab.manualDeadlineAt = null;
    tab.sentAt = new Date().toISOString();
    tab.prompt = null;
    tab.message = "Prompt sent; waiting for ChatGPT to start through the Codex harness";
    for (const resolve of tab.manualWaiters) resolve({ status: "sent", sentAt: tab.sentAt });
    tab.manualWaiters.clear();
    this.publishState?.(this.snapshot());
    this.logger.info("browser.manual_prompt_confirmed", { tabId: tab.id, traceId: tab.traceId });
    return this.snapshot();
  }

  markManualTurnStarted(traceId, helperPid) {
    const tab = [...this.turnTabs.values()].find(candidate => candidate.traceId === traceId);
    if (!tab || tab.interactionMode !== "manual" || tab.helperPid !== helperPid) {
      throw new Error(`Zero Risk turn ownership mismatch: no browser tab owns ${traceId}`);
    }
    if (tab.manualState !== "sent" && tab.manualState !== "running") {
      throw new Error(`Zero Risk turn ${traceId} was not confirmed as sent`);
    }
    if (tab.manualDeadlineTimer) clearTimeout(tab.manualDeadlineTimer);
    tab.manualDeadlineTimer = null;
    tab.manualDeadlineAt = null;
    tab.manualState = "running";
    tab.message = "ChatGPT is working through the Codex harness";
    tab.lastHeartbeatAt = Date.now();
    this.publishState?.(this.snapshot());
    return this.snapshot();
  }

  endManualTurn(traceId, helperPid, status, retain = false) {
    const completion = this.manualCompletionSignals.get(traceId);
    if (completion?.helperPid === helperPid) return { cancelledByUser: false };
    const tab = [...this.turnTabs.values()].find(candidate => candidate.traceId === traceId);
    if (!tab || tab.interactionMode !== "manual" || tab.helperPid !== helperPid) {
      const terminal = this.manualTerminalSignals.get(traceId);
      if (terminal?.helperPid === helperPid) return { cancelledByUser: terminal.status === "cancelled" };
      throw new Error(`Zero Risk turn ownership mismatch: no browser tab owns ${traceId}`);
    }
    if (tab.manualState === "completed") {
      this.rememberManualCompletion(traceId, helperPid);
      return { cancelledByUser: false };
    }
    if (status === "completed" && tab.manualState !== "sent" && tab.manualState !== "running") {
      throw new Error(`Zero Risk turn ${traceId} cannot complete before Sent confirmation`);
    }
    if (status === "completed" && retain && tab.conversationKey) {
      if (tab.manualDeadlineTimer) clearTimeout(tab.manualDeadlineTimer);
      tab.manualDeadlineTimer = null;
      tab.manualDeadlineAt = null;
      tab.prompt = null;
      tab.promptDigest = null;
      tab.manualState = "completed";
      tab.status = "ready";
      tab.message = "Task completed";
      tab.loading = false;
      tab.lastHeartbeatAt = Date.now();
      this.rememberManualCompletion(traceId, helperPid);
      this.publishState?.(this.snapshot());
      return { cancelledByUser: false };
    }
    const cancelledByUser = this.manualTerminalSignals.get(traceId)?.status === "cancelled";
    if (status === "completed") {
      if (tab.manualDeadlineTimer) clearTimeout(tab.manualDeadlineTimer);
      tab.manualDeadlineTimer = null;
      tab.manualDeadlineAt = null;
      tab.prompt = null;
      tab.promptDigest = null;
      tab.manualState = "completed";
      tab.manualTerminalResolutionSuppressed = true;
      this.rememberManualCompletion(traceId, helperPid);
    } else {
      this.signalManualTerminal(tab, status === "aborted" ? "cancelled" : status);
    }
    this.removeTurnTab(tab, false);
    return { cancelledByUser };
  }

  cancelManualTurn(traceId, helperPid) {
    const tab = [...this.turnTabs.values()].find(candidate => candidate.traceId === traceId);
    if (!tab || tab.interactionMode !== "manual" || tab.helperPid !== helperPid) {
      throw new Error(`Zero Risk turn ownership mismatch: no browser tab owns ${traceId}`);
    }
    this.signalManualTerminal(tab, "cancelled");
    this.removeTurnTab(tab, true);
    return { cancelledByUser: true };
  }

  async beginTurn(
    traceId,
    reveal,
    helperPid,
    conversationKey,
    connectorIdentity,
    requireRetainedConversation = false,
    // The start request this call answers (the control server's): the tab records the latest one
    // it was handed to, so an abandoned start releases the tab only if no later start took it.
    startRequest = null,
    nativeThreadId,
  ) {
    if (this.manualOperation) {
      throw new Error(`ChatGPT browser is busy with ${this.manualOperation}`);
    }
    if (this.userCancelledTurnOwners.has(traceId)) {
      throw new BrowserTurnCancelledError(traceId);
    }
    let sameTrace = [...this.turnTabs.values()].find((tab) => tab.traceId === traceId);
    if (sameTrace && sameTrace.interactionMode !== "automatic") {
      throw new Error(`Browser turn ${traceId} already belongs to Zero Risk interaction`);
    }
    // The ChatGPT account this Codex thread is bound to; a turn with no thread runs on this host's.
    const account = nativeThreadId && typeof this.resolveTurnAccount === "function"
      ? await this.resolveTurnAccount(nativeThreadId)
      : null;
    if (account && !isBrowserAccountPartition(this.profile, account.partition)) {
      throw new Error("The Codex thread's ChatGPT account partition does not match this profile");
    }
    const turnPartition = account?.partition ?? this.partition;
    const lifecycleSync = account?.chatLifecycleSync ?? this.chatLifecycleSync;
    if (sameTrace && (sameTrace.conversationKey !== conversationKey
      || sameTrace.connectorIdentity !== connectorIdentity
      || (nativeThreadId && sameTrace.nativeThreadId && sameTrace.nativeThreadId !== nativeThreadId))) {
      throw new Error(`ChatGPT browser turn ${traceId} conversation metadata does not match its owned tab`);
    }
    // A start whose request gave up while its tab was still loading (a busy machine) is repeated by
    // the helper under the same trace. Handing the half-loaded tab back at once made that turn fail
    // as browser_page ("ChatGPT did not complete the context handoff"): wait for the load to end.
    // A load that failed removed its tab, so the turn gets a fresh one below.
    if (sameTrace?.status === "running" && sameTrace.initializingSurface && sameTrace.surfaceReady) {
      this.logger.info("browser.tab_reuse_waits_for_surface", { tabId: sameTrace.id, traceId });
      await sameTrace.surfaceReady.catch(() => {});
      if (this.turnTabs.get(sameTrace.id) !== sameTrace) sameTrace = undefined;
      if (this.manualOperation) throw new Error(`ChatGPT browser is busy with ${this.manualOperation}`);
      if (this.userCancelledTurnOwners.has(traceId)) throw new BrowserTurnCancelledError(traceId);
    }
    const retainedMatches = conversationKey ? [...this.turnTabs.values()].filter((tab) => (
      tab.interactionMode === "automatic"
      && tab.status === "ready"
      && tab.conversationKey === conversationKey
      && (!nativeThreadId || !tab.nativeThreadId || tab.nativeThreadId === nativeThreadId)
      && tab.connectorIdentity === connectorIdentity
      && (!connectorIdentity || tab.connectorBound === true)
      && (tab.partition ?? this.partition) === turnPartition
    )) : [];
    if (retainedMatches.length > 1) {
      throw new Error(`ChatGPT retained conversation ${conversationKey} owns multiple browser tabs`);
    }
    let exactRetained = retainedMatches[0];
    // A retained tab stays a live ChatGPT page with the history sidebar, so the user may have
    // opened another conversation in it. Continuing there would type into the user's own chat:
    // release the tab instead, which takes the existing retained_conversation_unavailable path.
    if (exactRetained && !exactRetained.view.webContents.isDestroyed()
      && retainedConversationLocation(exactRetained.view.webContents.getURL(), useSavedChatsFor(this))
        !== exactRetained.retainedLocation) {
      this.logger.warn("browser.retained_conversation_moved", { tabId: exactRetained.id, traceId });
      this.removeTurnTab(exactRetained, false);
      if (sameTrace === exactRetained) sameTrace = undefined;
      exactRetained = undefined;
    }
    if (sameTrace?.status === "ready" && sameTrace !== exactRetained) {
      throw new Error(`ChatGPT browser turn ${traceId} is retained under different conversation metadata`);
    }
    const existing = sameTrace?.status === "running" ? sameTrace : exactRetained;
    if (existing) {
      const reused = existing.status === "ready";
      if (reused && existing.conversationUrl && liveConversationUrl(existing) !== existing.conversationUrl) {
        const error = new Error("The retained ChatGPT tab has navigated away from its original conversation");
        error.code = "retained_conversation_unavailable";
        throw error;
      }
      if (existing.status === "running" && existing.helperPid !== helperPid) {
        if (processRunning(existing.helperPid)) {
          throw new Error(`ChatGPT browser turn ${traceId} is owned by another helper process`);
        }
        this.logger.warn("browser.stale_turn_owner_replaced", {
          tabId: existing.id,
          traceId,
          previousHelperPid: existing.helperPid,
          helperPid,
          evidence: "previous helper exited",
        });
      }
      existing.helperPid = helperPid;
      if (nativeThreadId) existing.nativeThreadId = nativeThreadId;
      existing.traceId = traceId;
      existing.status = "running";
      existing.loading = true;
      existing.message = "ChatGPT is working";
      if (!reused) {
        existing.bootstrapReady = false;
        existing.bootstrapDeadlineAt = Date.now() + TURN_TAB_BOOTSTRAP_TIMEOUT_MS;
      }
      existing.lastHeartbeatAt = Date.now();
      existing.startRequest = startRequest;
      if (!existing.view.webContents.isDestroyed()) {
        existing.view.webContents.setBackgroundThrottling(false);
      }
      this.selectedTabId = existing.id;
      if (reveal) this.show();
      else this.syncViewVisibility();
      this.publishState?.(this.snapshot());
      await this.writeDescriptor();
      this.logger.info("browser.tab_reused", { tabId: existing.id, traceId });
      const conversationUrl = liveConversationUrl(existing);
      return {
        surfaceId: existing.surfaceId,
        tabId: existing.id,
        reused,
        connectorBound: existing.connectorBound === true,
        ...(conversationUrl ? { conversationUrl } : {}),
      };
    }
    // The original tab is in memory only. Recover its persisted, verified saved-chat URL
    // when the exact native thread, retained epoch and connector identity still agree.
    const savedUrl = useSavedChatsFor(this) && nativeThreadId && conversationKey
      ? lifecycleSync?.findRetainedConversation?.(nativeThreadId, conversationKey, connectorIdentity)
      : undefined;
    if (savedUrl) {
      const restored = await this.createTurnTab(traceId, helperPid, conversationKey, connectorIdentity, nativeThreadId, account);
      try {
        await loadCommittedBrowserSurface(restored.view.webContents, savedUrl, 60_000);
        const location = retainedConversationLocation(restored.view.webContents.getURL(), true);
        if (liveConversationUrl(restored) !== savedUrl || !location) {
          throw new Error("ChatGPT did not restore the verified conversation page");
        }
        // Navigation replaces the document; bind the surface marker to the restored page.
        await this.markTurnTabSurface(restored);
        restored.retainedLocation = location;
        restored.conversationUrl = savedUrl;
        restored.connectorBound = Boolean(connectorIdentity);
        restored.persistedConversation = true;
        restored.startRequest = startRequest;
        this.selectedTabId = restored.id;
        if (reveal) this.show();
        else this.syncViewVisibility();
        this.publishState?.(this.snapshot());
        await this.writeDescriptor();
        this.logger.info("browser.tab_conversation_restored", { tabId: restored.id, traceId });
        return {
          surfaceId: restored.surfaceId, tabId: restored.id, reused: true,
          connectorBound: restored.connectorBound, conversationUrl: savedUrl,
        };
      } catch (error) {
        this.removeTurnTab(restored, false);
        const unavailable = new Error("The saved ChatGPT conversation could not be restored");
        unavailable.code = "retained_conversation_unavailable";
        throw unavailable;
      }
    }
    if (requireRetainedConversation) {
      const error = new Error("The retained ChatGPT conversation is no longer available");
      error.code = "retained_conversation_unavailable";
      throw error;
    }
    const tab = await this.createTurnTab(traceId, helperPid, conversationKey, connectorIdentity, nativeThreadId, account);
    tab.startRequest = startRequest;
    this.selectedTabId = tab.id;
    if (reveal) this.show();
    else this.syncViewVisibility();
    this.publishState?.(this.snapshot());
    this.logger.info("browser.tab_created", { tabId: tab.id, traceId, tabCount: this.turnTabs.size });
    await this.writeDescriptor();
    return { surfaceId: tab.surfaceId, tabId: tab.id, reused: false, connectorBound: false };
  }

  /** Whether the running turn's tab was last handed to `startRequest` (no later start of it took it). */
  ownsTurnStart(traceId, startRequest) {
    const tab = [...this.turnTabs.values()].find((candidate) => candidate.traceId === traceId);
    return Boolean(tab && startRequest && tab.status === "running" && tab.startRequest === startRequest);
  }

  async endTurn(
    traceId,
    helperPid,
    status,
    hideAfterTurn,
    message,
    retain = false,
    connectorBound = false,
  ) {
    const tab = [...this.turnTabs.values()].find((candidate) => candidate.traceId === traceId);
    if (!tab) {
      const closedOwner = this.closedTurnOwners.get(traceId);
      if (closedOwner === helperPid) {
        const cancelledByUser = this.userCancelledTurnOwners.get(traceId) === helperPid;
        this.closedTurnOwners.delete(traceId);
        return { cancelledByUser };
      }
      throw new Error(`Browser turn ownership mismatch: no browser tab owns ${traceId}`);
    }
    if (tab.helperPid !== helperPid) {
      throw new Error(
        `Browser helper ownership mismatch: expected ${tab.helperPid}, received ${helperPid}`,
      );
    }
    const cancelledByUser = this.userCancelledTurnOwners.get(traceId) === helperPid;
    // A connector turn tells whether the account's ChatGPT connector works: it bound, or it failed.
    if (tab.connectorIdentity && tab.interactionMode === "automatic") {
      const observed = connectorBound === true ? { bound: true }
        : status === "error" && /connector/i.test(String(message ?? "")) ? { error: String(message) } : null;
      if (observed) {
        try { this.onConnectorObserved?.(tab.partition ?? this.partition, observed); } catch {}
      }
    }
    tab.status = status === "completed" || status === "superseded" ? "ready" : status === "aborted" ? "aborted" : "error";
    this.syncPowerSaveBlocker();
    tab.message = status === "completed" ? "Task completed"
      : status === "superseded" ? "Continuing this Codex task" : message || `ChatGPT turn ${status}`;
    tab.loading = false;
    tab.finishedAt = Date.now();
    if (!tab.view.webContents.isDestroyed()) tab.view.webContents.setBackgroundThrottling(true);
    if (status === "completed") {
      this.logger.info("browser.tab_completed", { tabId: tab.id, traceId });
    }
    const retainedLocation = (status === "completed" || status === "superseded") && retain && !tab.view.webContents.isDestroyed()
      ? retainedConversationLocation(tab.view.webContents.getURL(), useSavedChatsFor(this))
      : null;
    // The saved chat this turn wrote in, recorded now while the bridge still drives the tab, so its
    // release deletes this chat (as a Temporary Chat would vanish) and never a page the user opened.
    if (!tab.view.webContents.isDestroyed() && typeof tab.view.webContents.getURL === "function") {
      tab.ownedConversation = ownedSavedConversationId(tab.view.webContents.getURL(), useSavedChatsFor(this))
        ?? tab.ownedConversation ?? null;
    }
    if ((status === "completed" || status === "superseded") && retain && !retainedLocation) {
      this.logger.warn("browser.tab_retention_refused", { tabId: tab.id, traceId, reason: "no owned conversation page" });
    }
    if ((status === "completed" || status === "superseded")
      && retain
      && retainedLocation
      && tab.conversationKey
      && (!tab.connectorIdentity || connectorBound)) {
      // The URL stays with the task-scoped retained lease, not with the current prompt.
      // Subsequent turns use the same surfaceId and thus the same physical browser page.
      tab.conversationUrl = liveConversationUrl(tab);
      // Pin the exact conversation: the next turn types into this tab only while it still shows it.
      tab.retainedLocation = retainedLocation;
      tab.connectorBound = connectorBound === true;
      if (tab.nativeThreadId && tab.conversationUrl && tab.connectorBound) {
        try {
          const registered = (tab.chatLifecycleSync ?? this.chatLifecycleSync)?.register?.(
            tab.nativeThreadId, tab.conversationUrl, tab.conversationKey, tab.connectorIdentity,
          );
          if (registered === true) tab.persistedConversation = true;
        } catch (error) {
          this.logger.warn("browser.conversation_persistence_failed", {
            tabId: tab.id, errorType: error instanceof Error ? error.name : "Error",
          });
        }
      }
      tab.lastHeartbeatAt = Date.now();
      if (hideAfterTurn && !this.activeTraceId) this.hide();
      this.logger.info("browser.tab_retained", { tabId: tab.id, traceId });
      this.publishState?.(this.snapshot());
      await this.writeDescriptor();
      return { cancelledByUser, ...(tab.conversationUrl ? { conversationUrl: tab.conversationUrl } : {}) };
    }
    // A finished tab that cannot carry the task on (its page left the conversation: a link was
    // followed, or ChatGPT moved the chat) vanished the moment its turn ended. It now stays for the
    // idle time like a kept tab, closing (and its chat let go) as one when that runs out, but no
    // later turn can match it: it has no trace or conversation left, and the bridge no longer sees it.
    if ((status === "completed" || status === "superseded") && retain && !retainedLocation && !tab.view.webContents.isDestroyed()) {
      tab.traceId = null;
      tab.conversationKey = null;
      tab.retainedLocation = null;
      tab.lingering = true;
      tab.lastHeartbeatAt = Date.now();
      if (hideAfterTurn && !this.activeTraceId) this.hide();
      this.logger.info("browser.tab_lingering", { tabId: tab.id, traceId });
      this.publishState?.(this.snapshot());
      await this.writeDescriptor();
      return { cancelledByUser };
    }
    // A browser tab represents an active Codex turn, not durable task history. The result already
    // lives in Codex, so release the terminal browser document without touching concurrent turns.
    this.removeTurnTab(tab, false);
    if (hideAfterTurn && !this.activeTraceId) this.hide();
    this.logger.info("browser.tab_released", { tabId: tab.id, traceId, status: tab.status });
    return { cancelledByUser };
  }

  async returnToIdle() {
    this.hide();
    this.view.webContents.setBackgroundThrottling(true);
    if (this.view.webContents.getURL() !== IDLE_BROWSER_URL) {
      await this.view.webContents.loadURL(IDLE_BROWSER_URL);
    }
    this.setState({
      status: this.state.authenticated ? "ready" : "signed-out",
      message: this.state.authenticated ? "No active task" : "Sign in to ChatGPT",
    });
  }

  openLogin() {
    requireAutomaticBrowserInspection(this, "Automated ChatGPT sign-in verification");
    if (this.state.authenticated) {
      this.activateHomeSurface();
      this.show();
      return Promise.resolve(this.snapshot());
    }
    if (this.loginOperation) {
      this.activateHomeSurface();
      this.show();
      return this.loginOperation;
    }
    const operation = (async () => {
      const sessionRefresh = this.sessionRefreshOperation;
      if (sessionRefresh) {
        try {
          await sessionRefresh;
        } catch {
          // An explicit login is the recovery path after a failed saved-session refresh.
        }
      }
      return await this.withManualOperation("ChatGPT login", async () => {
        this.authNavigationError = null;
        this.show();
        this.logger.info("browser.login_opened");
        const current = this.view.webContents.getURL();
        if (!current.startsWith(CHATGPT_ORIGIN)) {
          await this.view.webContents.loadURL(newChatUrlFor(this));
        }
        await this.probeAuthentication();
        const authenticated = await this.waitForAuthenticated();
        await this.runSessionInspection(false);
        return authenticated;
      });
    })();
    const tracked = operation.finally(() => {
      if (this.loginOperation === tracked) this.loginOperation = null;
    });
    this.loginOperation = tracked;
    return tracked;
  }

  openPasskeyLogin() {
    requireAutomaticBrowserInspection(this, "Automated ChatGPT passkey import");
    if (this.state.authenticated) {
      this.activateHomeSurface();
      this.show();
      return Promise.resolve(this.snapshot());
    }
    if (this.loginOperation) return this.loginOperation;
    const operation = (async () => {
      const sessionRefresh = this.sessionRefreshOperation;
      if (sessionRefresh) {
        try {
          await sessionRefresh;
        } catch {
          // Explicit sign-in is the recovery path after a failed saved-session refresh.
        }
      }
      return await this.withManualOperation("ChatGPT passkey login", async () => {
        this.authNavigationError = null;
        this.setState({
          authenticated: false,
          status: "loading",
          message: "Waiting for passkey sign-in in Chrome",
          loading: true,
        });
        this.logger.info("browser.passkey_login_started");
        const transfer = await this.loginWithPasskey();
        return await this.installPasskeyLogin(transfer);
      });
    })();
    const tracked = operation.finally(() => {
      if (this.loginOperation === tracked) this.loginOperation = null;
    });
    this.loginOperation = tracked;
    return tracked;
  }

  async clearOwnedSessionForPasskey() {
    if (!(this.turnTabs instanceof Map)) throw new Error("Owned ChatGPT tab registry is unavailable");
    if (this.authView) this.closeAuthView(this.authView, true, false);
    // Only the shown account's: turn tabs on other accounts keep their own sign-in.
    const tabs = [...this.turnTabs.values()].filter((tab) => (tab.partition ?? this.partition) === this.partition);
    const userTabs = [...(this.userTabs?.values() ?? [])];
    const contents = [this.view, ...tabs.map(tab => tab.view), ...userTabs.map(tab => tab.view)]
      .map(view => view?.webContents)
      .filter(candidate => candidate && !candidate.isDestroyed());
    if (contents.length === 0) throw new Error("Owned ChatGPT browser session is unavailable");
    const browserSession = contents[0].session;
    if (contents.some(candidate => candidate.session !== browserSession)) {
      throw new Error("Owned ChatGPT views do not share one browser session");
    }
    await Promise.all(contents.map(candidate => candidate.loadURL(IDLE_BROWSER_URL)));
    await browserSession.clearStorageData();
    browserSession.flushStorageData();
    await browserSession.cookies.flushStore();
    for (const tab of tabs) this.removeTurnTab(tab, false);
    for (const tab of userTabs) this.removeUserTab(tab);
  }

  async resetFailedPasskeyLogin() {
    await this.clearOwnedSessionForPasskey();
    const contents = this.view.webContents;
    await contents.loadURL(newChatUrlFor(this));
    const browser = await this.probeAuthentication();
    if (browser.authenticated) throw new Error("Partial passkey session remained authenticated after cleanup");
    this.setState({ authenticated: false, loading: false, status: "signed-out", message: "Sign in to ChatGPT" });
  }

  async installPasskeyLogin(transfer) {
    requireAutomaticBrowserInspection(this, "Automated ChatGPT session import");
    if (!transfer || typeof transfer !== "object" || typeof transfer.cleanup !== "function") {
      throw new Error("Passkey sign-in returned an invalid transfer handle");
    }
    let error = null;
    let result = null;
    let sessionMutated = false;
    let sessionDiscarded = false;
    let state;
    try {
      state = validatePasskeyLoginState(transfer.storageState);
      const contents = this.view?.webContents;
      if (!contents || contents.isDestroyed()) throw new Error("Owned ChatGPT browser session is unavailable");
      sessionMutated = true;
      await this.clearOwnedSessionForPasskey();
      for (const cookie of state.cookies) await contents.session.cookies.set(cookie);
      contents.session.flushStorageData();
      await contents.session.cookies.flushStore();
      await contents.loadURL(newChatUrlFor(this));
      if (state.localStorage.length > 0) {
        const entries = javaScriptLiteral(state.localStorage);
        await contents.executeJavaScript(`(() => {
          if (location.origin !== ${JSON.stringify(CHATGPT_ORIGIN)}) {
            throw new Error("Passkey storage import reached an unexpected origin");
          }
          for (const entry of ${entries}) localStorage.setItem(entry.name, entry.value);
        })()`, true);
        await contents.loadURL(newChatUrlFor(this));
      }
      result = await this.waitForAuthenticated(60_000);
      await this.runSessionInspection(false);
      this.activateHomeSurface();
      this.show();
      this.logger.info("browser.passkey_login_imported");
    } catch (caught) {
      error = caught;
    }

    if (error && sessionMutated) {
      try {
        await this.resetFailedPasskeyLogin();
        sessionDiscarded = true;
      } catch (cleanupError) {
        error = combinedError(error, "clearing the partial passkey session failed", cleanupError);
      }
    }
    try {
      await transfer.cleanup();
    } catch (cleanupError) {
      error = error
        ? combinedError(error, "removing temporary passkey state failed", cleanupError)
        : new Error(`Removing temporary passkey state failed: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`);
    }
    if (error && sessionMutated && !sessionDiscarded) {
      try {
        await this.resetFailedPasskeyLogin();
        sessionDiscarded = true;
      } catch (cleanupError) {
        error = combinedError(error, "retrying partial passkey session cleanup failed", cleanupError);
      }
    }
    if (error) throw error;
    if (!result?.authenticated) throw new Error("Passkey sign-in completed without an authenticated Launcher session");
    return this.snapshot();
  }

  async logout() {
    requireAutomaticBrowserInspection(this, "Automated ChatGPT logout verification");
    return await this.withManualOperation("ChatGPT logout", async () => {
      if (this.authView) this.closeAuthView(this.authView, true, false);
      for (const tab of [...(this.userTabs?.values() ?? [])]) this.removeUserTab(tab);
      const contents = this.view.webContents;
      await contents.session.clearStorageData();
      this.setState({
        authenticated: false,
        loading: true,
        message: "Signing out of ChatGPT",
        status: "loading",
      });
      await contents.loadURL(newChatUrlFor(this));
      const browser = await this.probeAuthentication();
      if (browser.authenticated) {
        throw new Error("ChatGPT session remained authenticated after local session data was cleared");
      }
      this.activateHomeSurface();
      this.show();
      this.logger.info("browser.logout_completed");
      return this.snapshot();
    });
  }

  refreshAuthentication() {
    requireAutomaticBrowserInspection(this, "ChatGPT authentication refresh");
    if (this.sessionRefreshOperation) return this.sessionRefreshOperation;
    const operation = this.withManualOperation("session refresh", async () => {
      this.setState({ status: "loading", message: "Checking saved ChatGPT session" });
      if (!isNewChatUrl(this.view.webContents.getURL(), useSavedChatsFor(this))) {
        await this.view.webContents.loadURL(newChatUrlFor(this));
      }
      const state = await this.probeAuthentication();
      if (state.authenticated) {
        this.setState({ status: "ready", message: "ChatGPT is ready" });
      }
      return this.snapshot();
    });
    let tracked;
    tracked = operation.finally(() => {
      if (this.sessionRefreshOperation === tracked) this.sessionRefreshOperation = null;
    });
    this.sessionRefreshOperation = tracked;
    return tracked;
  }

  /**
   * Whether the ChatGPT session can serve a turn. A check that could not tell (Cloudflare answering
   * the app's own request, then the page's request slower than its limit on a busy machine) read
   * as "Browser is not ready" while the page was signed in and working. Such an unknown result
   * stands on a session this browser confirmed recently; a signed-out answer never does.
   */
  async authenticationReadiness() {
    const result = await this.checkAuthenticationReadiness();
    const now = Date.now();
    if (result?.authenticated === true && result.ready === true) {
      this.lastAuthenticatedAt = now;
      return result;
    }
    if (result?.authenticated === false) {
      this.lastAuthenticatedAt = 0;
      return result;
    }
    if (this.lastAuthenticatedAt && now - this.lastAuthenticatedAt < CHATGPT_AUTH_RECENT_MS) {
      this.logger?.info?.("browser.readiness_recent", { ageMs: now - this.lastAuthenticatedAt });
      return { authenticated: true, ready: true, recent: true };
    }
    return result;
  }

  async checkAuthenticationReadiness() {
    requireAutomaticBrowserInspection(this, "ChatGPT authentication readiness");
    const contents = this.view?.webContents;
    if (!contents || contents.isDestroyed() || typeof contents.session?.fetch !== "function") {
      return { authenticated: null, ready: false };
    }
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), CHATGPT_AUTH_SESSION_TIMEOUT_MS);
    try {
      const response = await contents.session.fetch(CHATGPT_ORIGIN + "/api/auth/session", {
        credentials: "include", cache: "no-store", redirect: "manual",
        headers: { accept: "application/json" }, signal: controller.signal,
      });
      if (response.status === 401) return { authenticated: false, ready: true };
      // Electron's session.fetch leaves response.url empty (it builds the Response itself; checked on
      // Electron 41.10.7), and a redirect under redirect: "manual" throws rather than answers. Requiring
      // the URL failed every check: "readiness_fetch_unusable" (200, JSON, sameUrl false) every 20 s,
      // each followed by a script run in the ChatGPT page. An empty URL is the one asked for.
      const sameUrl = sessionEndpointUrl(response.url);
      if (!response.ok || !sameUrl || !response.headers.get("content-type")?.includes("application/json")) {
        // Which check failed: a redirect elsewhere, or a page that is not the session JSON (a challenge
        // page). Only the address's origin and path are logged, never its query.
        this.logger?.warn?.("browser.readiness_fetch_unusable", { status: response.status, sameUrl,
          at: urlWithoutQuery(response.url),
          contentType: String(response.headers.get("content-type") || "").split(";")[0].slice(0, 60) });
        return await this.pageAuthenticationReadiness(contents);
      }
      return { authenticated: authenticatedChatGptSession(await response.json()), ready: true };
    } catch { return { authenticated: null, ready: false }; }
    finally { clearTimeout(timeout); }
  }

  // Cloudflare may challenge the main-process request while the open ChatGPT page passes. Ask the
  // page itself, on chatgpt.com only. Only the session's shape leaves the page, never its tokens.
  async pageAuthenticationReadiness(contents) {
    if (!contents.getURL?.().startsWith(CHATGPT_ORIGIN + "/") || typeof contents.executeJavaScript !== "function") {
      return { authenticated: null, ready: false };
    }
    const result = await Promise.race([
      contents.executeJavaScript(`(async () => {
        const response = await fetch("/api/auth/session", { credentials: "include", cache: "no-store",
          redirect: "manual", headers: { accept: "application/json" } });
        if (response.status === 401) return { status: 401 };
        if (!response.ok || !(response.headers.get("content-type") || "").includes("application/json")) return { status: response.status };
        const body = await response.json();
        const user = body && body.user;
        return { status: 200, user: Boolean(user && typeof user === "object" && !Array.isArray(user) && Object.keys(user).length),
          error: Boolean(body && body.error !== undefined && body.error !== null && body.error !== ""),
          expires: body && typeof body.expires === "string" ? body.expires : null };
      })()`, true),
      new Promise(resolve => setTimeout(() => resolve(null), CHATGPT_AUTH_PAGE_TIMEOUT_MS)),
    ]).catch(() => null);
    if (result?.status === 401) return { authenticated: false, ready: true };
    if (result?.status !== 200) {
      this.logger?.warn?.("browser.readiness_page_unusable", { status: typeof result?.status === "number" ? result.status : null });
      return { authenticated: null, ready: false };
    }
    return { authenticated: authenticatedChatGptSession({ user: result.user ? { present: true } : null,
      error: result.error ? "error" : undefined, expires: result.expires }), ready: true };
  }

  async probeAuthentication() {
    requireAutomaticBrowserInspection(this, "ChatGPT authentication probe");
    if (!this.view || this.view.webContents.isDestroyed()) return this.snapshot();
    let url = this.view.webContents.getURL();
    if (url === IDLE_BROWSER_URL) {
      this.setState({
        status: this.state.authenticated ? "ready" : "signed-out",
        message: this.state.authenticated ? "No active task" : "Sign in to ChatGPT",
        url,
      });
      return this.snapshot();
    }
    if (!url.startsWith(CHATGPT_ORIGIN)) {
      this.setState({ status: "signed-out", message: "Sign in to ChatGPT", authenticated: false, url });
      return this.snapshot();
    }
    const probe = (contents) => contents.executeJavaScript(`(async () => {
      const expectedUrl = new URL(${JSON.stringify(TEMPORARY_CHAT_URL)});
      const readSurface = () => {
        const composer = ${visibleElementScript(COMPOSER_SELECTOR)};
        const actualUrl = new URL(location.href);
        return {
          url: actualUrl.href,
          composer: Boolean(composer),
          temporary: actualUrl.origin === expectedUrl.origin
            && actualUrl.pathname === expectedUrl.pathname
            && actualUrl.searchParams.get("temporary-chat") === "true",
          savedHome: actualUrl.origin === expectedUrl.origin
            && actualUrl.pathname === "/"
            && !actualUrl.searchParams.has("temporary-chat"),
          readyState: document.readyState,
        };
      };
      const initialSurface = readSurface();
      let sessionAuthenticated = false;
      if (new URL(initialSurface.url).origin === expectedUrl.origin) {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), ${CHATGPT_AUTH_SESSION_TIMEOUT_MS});
        try {
          const response = await fetch("/api/auth/session", {
            credentials: "include",
            cache: "no-store",
            headers: { accept: "application/json" },
            signal: controller.signal,
          });
          const responseUrl = new URL(response.url);
          const payload = response.ok
            && responseUrl.origin === expectedUrl.origin
            && responseUrl.pathname === "/api/auth/session"
            && response.headers.get("content-type")?.includes("application/json")
            ? await response.json()
            : null;
          sessionAuthenticated = (${authenticatedChatGptSession.toString()})(payload);
        } catch {}
        finally { clearTimeout(timeout); }
      }
      return { ...readSurface(), sessionAuthenticated };
    })()`, true).catch(() => ({
      url: "",
      composer: false,
      temporary: false,
      sessionAuthenticated: false,
      readyState: "unknown",
    }));
    // Connector verification refreshes onto the saved-chat home when saved chats are on; its
    // composer proves the session as well as the Temporary Chat one does.
    const onNewChat = (surface) => surface.temporary || surface.savedHome === true;
    let result = await probe(this.view.webContents);
    if (!(result.composer && onNewChat(result) && result.sessionAuthenticated)
      && this.authView
      && !this.authView.webContents.isDestroyed()) {
      const authResult = await probe(this.authView.webContents);
      if (authResult.sessionAuthenticated) {
        const completedAuthView = this.authView;
        this.closeAuthView(completedAuthView, true, false);
        await this.view.webContents.loadURL(newChatUrlFor(this));
        url = this.view.webContents.getURL();
        result = await probe(this.view.webContents);
      }
    }
    // A login ends on the new chat the setting chooses: with saved chats on, a Temporary Chat (where
    // ChatGPT refuses the connector) is left for the saved home, and the saved home is kept as it is.
    if (this.manualOperation === "ChatGPT login"
      && result.sessionAuthenticated
      && !isNewChatUrl(result.url ?? url, useSavedChatsFor(this))
      && !this.view.webContents.isDestroyed()) {
      await this.view.webContents.loadURL(newChatUrlFor(this));
      url = this.view.webContents.getURL();
      result = await probe(this.view.webContents);
    }
    if (result.composer && onNewChat(result) && result.sessionAuthenticated) {
      if (this.authView && !this.authView.webContents.isDestroyed()) {
        this.closeAuthView(this.authView, true, false);
      }
      const wasAuthenticated = this.state.authenticated;
      const availability = this.activeTraceId
        ? { status: "running", message: "ChatGPT is working" }
        : this.manualOperation
          ? {}
          : { status: "ready", message: "ChatGPT is ready" };
      this.setState({ ...availability, authenticated: true, url: result.url });
      if (!wasAuthenticated) this.logger.info("browser.authenticated", { url: result.url });
    } else {
      const loaded = result.readyState === "complete";
      this.setState({
        status: loaded ? "signed-out" : "loading",
        message: loaded ? "Sign in to ChatGPT" : "Waiting for ChatGPT",
        authenticated: false,
        url: result.url || url,
      });
    }
    return this.snapshot();
  }

  async waitForAuthenticated(timeoutMs = 180_000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (this.authNavigationError) {
        const error = this.authNavigationError;
        this.authNavigationError = null;
        throw error;
      }
      const state = await this.probeAuthentication();
      if (state.authenticated) return state;
      await sleep(750);
    }
    throw new Error("ChatGPT login was not completed before the timeout");
  }

  async smokeTest() {
    requireAutomaticBrowserInspection(this, "ChatGPT browser smoke test");
    return await this.withManualOperation("browser smoke test", () => this.runSmokeTest());
  }

  connectorName() {
    if (typeof this.getConnectorName !== "function") {
      throw new Error("Browser host connector-name resolver is unavailable");
    }
    return validateConnectorName(this.getConnectorName());
  }

  async runSmokeTest() {
    requireAutomaticBrowserInspection(this, "ChatGPT browser smoke test");
    const connectorName = this.connectorName();
    this.show();
    await this.waitForSurfaceReady();
    this.setState({ status: "testing", message: "Running browser smoke test" });
    this.logger.info("smoke.started");
    const result = await this.runBrowserHelperOperation({
      helper: this.helper,
      descriptorPath: this.descriptorPath,
      appName: connectorName,
      operation: "smoke",
      logger: this.logger,
    });
    const evidence = result?.value;
    if (!evidence
      || typeof evidence.effort !== "string"
      || !evidence.effort
      || evidence.response !== "CODEX WEB GPT READY") {
      throw new Error("Browser helper returned invalid smoke-test evidence");
    }
    this.logger.info("smoke.completed", { effort: evidence.effort, responseChars: evidence.response.length });
    this.setState({ status: "ready", message: "Smoke test passed", authenticated: true });
    return { ok: true, ...evidence };
  }

  async verifyConnector(appName) {
    requireAutomaticBrowserInspection(this, "ChatGPT connector verification");
    return await this.withManualOperation("connector verification", () => this.runConnectorVerification(appName));
  }

  async runConnectorVerification(appName) {
    requireAutomaticBrowserInspection(this, "ChatGPT connector verification");
    const connectorName = validateConnectorName(appName);
    this.setState({ status: "testing", message: "Checking ChatGPT connector" });
    const useSavedChats = useSavedChatsFor(this);
    await this.refreshChatGptHomeDocument(useSavedChats);
    try {
      const result = await this.verifyConnectorWithBrowserHelper({
        helper: this.helper,
        descriptorPath: this.descriptorPath,
        appName: connectorName,
        useSavedChats,
        logger: this.logger,
      });
      this.logger.info("connector.verified", { appName: connectorName });
      this.setState({ status: "ready", message: "ChatGPT connector is available", authenticated: true });
      return result;
    } catch (error) {
      this.logger.error("connector.verification_failed", {
        appName: connectorName,
        ...(error && typeof error.operationId === "string" ? { traceId: error.operationId } : {}),
        errorName: error instanceof Error ? error.name : "Error",
        message: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  async inspectSession(detectCapabilities = false) {
    requireAutomaticBrowserInspection(this, "ChatGPT session and capability inspection");
    if (this.manualOperation === INTERACTION_MODE_CHANGE_OPERATION) {
      return await this.runSessionInspection(detectCapabilities);
    }
    return await this.withManualOperation("session inspection", () => this.runSessionInspection(detectCapabilities));
  }

  async runSessionInspection(detectCapabilities = false) {
    requireAutomaticBrowserInspection(this, "ChatGPT session and capability inspection");
    const connectorName = this.connectorName();
    const initialUrl = this.view.webContents.getURL();
    const startedIdle = initialUrl === IDLE_BROWSER_URL;
    if (detectCapabilities) await this.refreshChatGptHomeDocument();
    const result = await this.runBrowserHelperOperation({
      helper: this.helper,
      descriptorPath: this.descriptorPath,
      appName: connectorName,
      operation: "inspect",
      payload: { detectCapabilities },
      logger: this.logger,
    });
    const inspected = result?.value;
    if (!inspected || inspected.authenticated !== true || inspected.temporary !== true || typeof inspected.url !== "string") {
      throw new Error("Browser helper returned invalid ChatGPT session evidence");
    }
    if (detectCapabilities
      && (typeof inspected.solAvailable !== "boolean" || typeof inspected.proAvailable !== "boolean")) {
      throw new Error("Browser helper returned incomplete ChatGPT capability evidence");
    }
    if (detectCapabilities && inspected.proAvailable && !inspected.solAvailable) {
      throw new Error("Browser helper returned contradictory ChatGPT capability evidence");
    }
    if (detectCapabilities) {
      try { this.onSessionInspected?.(inspected); } catch {}
    }
    if (startedIdle) await this.returnToIdle();
    return inspected;
  }

  async withManualOperation(name, action) {
    await this.ready();
    if (this.activeTraceId) {
      throw new Error(`ChatGPT browser is running Codex turn ${this.activeTraceId}`);
    }
    if (this.manualOperation) {
      throw new Error(`ChatGPT browser is already busy with ${this.manualOperation}`);
    }
    this.activateHomeSurface();
    this.manualOperation = name;
    const contents = this.view?.webContents;
    if (contents && !contents.isDestroyed()) contents.setBackgroundThrottling(false);
    try {
      return await action();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.setState({ status: "error", message });
      throw error;
    } finally {
      if (contents && !contents.isDestroyed()) contents.setBackgroundThrottling(true);
      this.manualOperation = null;
    }
  }

  /**
   * Publishes the descriptor the bridge reads, off the main thread: the synchronous write held every
   * window 14.7 s at a turn's start and 4.8 s at a tab's close on the busy hard disk (2026-10-31).
   * Resolves once it is in place; a caller that hands the bridge a surface awaits it. `now` writes it
   * before returning, for the one caller that reads it straight back (launcherControlEnvironment).
   */
  writeDescriptor({ now = false } = {}) {
    const surfaceTargets = {};
    if (browserInteractionModeFor(this) === "automatic") {
      const surfaces = [[this.surfaceId, this.view?.webContents],
        ...[...this.turnTabs.values()].filter(tab => tab.interactionMode === "automatic" && !tab.lingering)
          .map(tab => [tab.surfaceId, tab.view.webContents])];
      for (const [surfaceId, contents] of surfaces) {
        if (!contents || contents.isDestroyed()) continue;
        if (Object.hasOwn(surfaceTargets, surfaceId)) throw new Error("Browser surface ownership is duplicated");
        surfaceTargets[surfaceId] = contents.getOrCreateDevToolsTargetId();
      }
    }
    const descriptor = {
      version: 3,
      kind: "codex-web-gpt-launcher",
      profile: this.profile,
      pid: process.pid,
      endpoint: `http://127.0.0.1:${this.cdpPort}`,
      control: this.control,
      helper: this.helper,
      partition: this.partition,
      idleUrl: IDLE_BROWSER_URL,
      surfaceId: this.surfaceId,
      surfaceTargets,
    };
    // Selecting a tab, a manual turn's start and cancel, and closing a tab each asked for a rewrite,
    // most of them with nothing changed. Each atomic write is about six synchronous disk calls on the
    // main process (every window waits), seconds on the busy hard disk, so an unchanged descriptor
    // that this process already wrote stays as it is. Only this process writes or removes it.
    const unchanged = JSON.stringify(descriptor);
    if (this.writtenDescriptor === unchanged && !now) return this.descriptorWrites ?? Promise.resolve();
    descriptor.createdAt = new Date().toISOString();
    const filePath = this.descriptorPath;
    const text = `${JSON.stringify(descriptor, null, 2)}\n`;
    if (now) {
      writePrivateFileAtomic(filePath, text);
      this.writtenDescriptor = unchanged;
      // The app is back: the bridge no longer needs to wait out a restart.
      try { fs.rmSync(restartMarkerPath(filePath), { force: true }); } catch {}
      return Promise.resolve();
    }
    this.writtenDescriptor = unchanged;
    const generation = this.descriptorGeneration ?? 0;
    const current = () => (this.descriptorGeneration ?? 0) === generation;
    // One write at a time, in the order asked for. A write destroy() overtook removes what it wrote:
    // the descriptor of a closed browser would send the bridge to a page that is gone.
    const write = (this.descriptorWrites ?? Promise.resolve()).catch(() => {}).then(async () => {
      if (!current()) return;
      await writePrivateFileAtomicAsync(filePath, text);
      if (!current()) await fs.promises.rm(filePath, { force: true }).catch(() => {});
      else await fs.promises.rm(restartMarkerPath(filePath), { force: true }).catch(() => {});
    });
    this.descriptorWrites = write;
    write.catch((error) => {
      // Not on disk: the next call writes it again instead of taking it as unchanged.
      if (this.writtenDescriptor === unchanged) this.writtenDescriptor = null;
      this.logger?.warn?.("browser.descriptor_write_failed", { message: error instanceof Error ? error.message.slice(0, 200) : String(error) });
    });
    return write;
  }

  async persistSession() {
    // Every loaded account's sign-in: the shown one's and the parked ones'.
    const sessions = new Set([this.view, ...[...(this.parkedHomes?.values() ?? [])].map((home) => home.view)]
      .map((view) => view?.webContents)
      .filter((contents) => contents && !contents.isDestroyed())
      .map((contents) => contents.session));
    for (const browserSession of sessions) {
      browserSession.flushStorageData();
      await browserSession.cookies.flushStore();
    }
  }

  destroy() {
    try {
      const current = JSON.parse(fs.readFileSync(this.descriptorPath, "utf8"));
      if (current.pid === process.pid) fs.rmSync(this.descriptorPath, { force: true });
    } catch {}
    this.writtenDescriptor = null;
    this.descriptorGeneration = (this.descriptorGeneration ?? 0) + 1;
    for (const [contents, handler] of this.shellZoomShortcutBindings) {
      if (!contents.isDestroyed()) contents.off("before-input-event", handler);
    }
    this.shellZoomShortcutBindings.clear();
    for (const event of WINDOW_VISIBILITY_EVENTS) {
      this.window.off(event, this.windowVisibilityListener);
    }
    this.closeAuthView(this.authView, true);
    this.clearHomeNavigationTimeout();
    if (this.turnLeaseSweep) clearInterval(this.turnLeaseSweep);
    if (this.resumeListener && powerMonitor && typeof powerMonitor.removeListener === "function") {
      powerMonitor.removeListener("resume", this.resumeListener);
      this.resumeListener = null;
    }
    if (this.powerSaveBlockerId !== null && powerSaveBlocker && typeof powerSaveBlocker.stop === "function") {
      powerSaveBlocker.stop(this.powerSaveBlockerId);
      this.powerSaveBlockerId = null;
    }
    for (const tab of this.turnTabs.values()) {
      if (tab.interactionMode === "manual") {
        if (tab.manualDeadlineTimer) clearTimeout(tab.manualDeadlineTimer);
        tab.prompt = null;
        tab.promptDigest = null;
        for (const resolve of tab.manualWaiters || []) resolve({ status: "cancelled" });
        tab.manualWaiters?.clear();
        for (const resolve of tab.manualTerminalWaiters || []) resolve({ status: "cancelled" });
        tab.manualTerminalWaiters?.clear();
      }
      try { this.window.contentView.removeChildView(tab.view); } catch {}
      if (!tab.view.webContents.isDestroyed()) tab.view.webContents.close();
    }
    this.turnTabs.clear();
    for (const tab of this.userTabs?.values() ?? []) {
      try { this.window.contentView.removeChildView(tab.view); } catch {}
      if (!tab.view.webContents.isDestroyed()) tab.view.webContents.close();
    }
    this.userTabs?.clear();
    for (const home of this.parkedHomes?.values() ?? []) this.unloadHome(home);
    this.parkedHomes?.clear();
    if (this.view && !this.view.webContents.isDestroyed()) this.view.webContents.close();
  }
}

// While the app restarts and leaves the Codex bridge running (an update install, "Restart app (keep
// Codex bridge)"), there is no descriptor for minutes. The quitting app writes this marker next to
// it, with when the restart should be over by; a turn that reaches the bridge meanwhile waits for
// the new app instead of failing. The new app removes it once its descriptor is written. A crash
// writes none, so the bridge still fails fast then (runtime-web launcher-browser-host.ts reads it).
// `until` is at most 15 minutes away, which every bridge honours; an update has taken 12, so
// `holdUntil` (30 minutes) is read by bridges that know it. An older bridge ignores a marker whose
// `until` is further than 15 minutes, which is why that one field stays within it.
const RESTART_MARKER_MAX_MS = 15 * 60_000;
const RESTART_MARKER_HOLD_MS = 30 * 60_000;
function restartMarkerPath(descriptorPath) {
  return path.join(path.dirname(descriptorPath), "launcher-browser.restarting.json");
}
function writeRestartMarker(descriptorPath, { reason, withinMs = RESTART_MARKER_MAX_MS, now = Date.now() } = {}) {
  const until = now + Math.max(0, Math.min(withinMs, RESTART_MARKER_MAX_MS));
  const holdUntil = now + RESTART_MARKER_HOLD_MS;
  writePrivateFileAtomic(restartMarkerPath(descriptorPath), `${JSON.stringify({
    version: 1, pid: process.pid, reason: String(reason || "restart").slice(0, 40),
    createdAt: new Date(now).toISOString(), until: new Date(until).toISOString(), holdUntil: new Date(holdUntil).toISOString(),
  }, null, 2)}\n`);
}

module.exports = {
  RESTART_MARKER_MAX_MS,
  restartMarkerPath,
  writeRestartMarker,
  allowedAuthUrl,
  BrowserHost,
  BrowserTurnCancelledError,
  CHATGPT_VIEWPORT_CSS,
  deleteConversationScript,
  makeTabRoom,
  MAX_WARM_HOMES,
  ownedSavedConversationId,
  parkedHomeToUnload,
  IDLE_BROWSER_URL,
  isChatGptCloudflareChallengeResponse,
  isTemporaryChatUrl,
  loadCommittedBrowserSurface,
  loadIdleSurfaceWithRetries,
  MANUAL_SUBMIT_TIMEOUT_MS,
  MANUAL_COMPACTION_SUBMIT_TIMEOUT_MS,
  navigationErrorForLog,
  navigationFailurePage,
  navigationOriginForLog,
  TEMPORARY_CHAT_URL,
};
