"use strict";

const { cleanUserAgent } = require("./browser-url.cjs");

// Cloudflare's check in place of a ChatGPT page. The Browser tab's own pages (browser-host.cjs) and
// the hidden windows that inspect accounts and set up MCP (chatgpt-workspace.cjs,
// mcp-connector-setup.cjs) all meet it.

/**
 * Runs inside the page (injected with toString, like authenticatedChatGptSession): true while the
 * document is Cloudflare's check page in place of ChatGPT. `doc` and `win` are the page's document
 * and window, passed in so the check can be tested without a browser.
 */
function isCloudflareCheckPage(doc, win) {
  // The check page sets _cf_chl_opt and loads Cloudflare's challenge "orchestrate" script, in every
  // language; its title is translated, and the old #challenge-form markup is gone (checked live).
  // ChatGPT's own pages load Cloudflare's bot-detection script from /cdn-cgi/challenge-platform/
  // too (scripts/jsd/), so that folder alone does not mean a check is showing.
  if (win?._cf_chl_opt && typeof win._cf_chl_opt === "object") return true;
  return [...(doc?.scripts ?? [])].some((script) => /\/cdn-cgi\/challenge-platform\/.*\/orchestrate\/chl_page\//.test(script.src || ""));
}

// How long a hidden setup window waits for Cloudflare's check to pass before it gives up and says
// so. The Browser tab gives each hidden page 2 minutes a try (CHECK_RENDER_MS); a setup window has
// a person waiting on it.
const SETUP_CHECK_WAIT_MS = 60_000;
const SETUP_CHECK_MESSAGE = "ChatGPT is showing a Cloudflare security check for this account. Open the account in the Browser tab, let ChatGPT load, then retry.";

/**
 * Gives a hidden setup window the user agent the Browser tab's pages use. Cloudflare ties its
 * clearance to the user agent, and a new window takes its session's agent, which still names
 * Electron and Coding Tools for an account whose Browser page was not opened since launch: on
 * 2026-11-09 such a window was sent the check although the account had passed it.
 */
function matchBrowserUserAgent(window) {
  const contents = window.webContents;
  if (typeof contents?.getUserAgent !== "function" || typeof contents.setUserAgent !== "function") return;
  const clean = cleanUserAgent(contents.getUserAgent());
  if (clean && clean !== contents.getUserAgent()) contents.setUserAgent(clean);
}

/**
 * Loads `url` in a hidden setup window (a BrowserWindow). Cloudflare can answer with its check (a
 * 403 document) in place of the page: the check runs in the page and, once passed, reloads it.
 * On 2026-11-09 a Refresh of an idle account met the check and gave up first (12 s to see the
 * workspace, 35 s in all), and the check's own reload would also have read as a changed context.
 * Here that reload is part of the load: this resolves once the page has loaded with a 2xx/3xx
 * answer, and throws SETUP_CHECK_MESSAGE when the check has not passed within `waitMs`. `onCheck`
 * runs as a check starts, so the caller can give its own deadline the time. Resolves true when a
 * check was passed, false when there was none.
 */
async function loadPastCloudflareCheck(window, url, { waitMs = SETUP_CHECK_WAIT_MS, onCheck } = {}) {
  const contents = window.webContents;
  // One record for the whole load: the check can pass and reload while this asks the page whether
  // it is the check.
  const page = { status: null, loaded: false };
  let wake = null;
  const navigated = (_event, _url, code) => { page.status = code; page.loaded = false; wake?.(); };
  const loaded = () => { page.loaded = true; wake?.(); };
  contents.on("did-navigate", navigated);
  contents.on("did-finish-load", loaded);
  try {
    await window.loadURL(url);
    if (page.status !== 403) return false;
    const check = await contents.executeJavaScript(`(${isCloudflareCheckPage.toString()})(document, window)`, true)
      .catch(() => false);
    if (check !== true) return false;
    onCheck?.();
    const passed = () => page.loaded && page.status >= 200 && page.status < 400;
    await new Promise((resolve, reject) => {
      const finish = (error) => {
        clearTimeout(timer);
        wake = null;
        contents.removeListener("destroyed", gone);
        if (error) reject(error); else resolve();
      };
      const gone = () => finish(new Error(SETUP_CHECK_MESSAGE));
      const timer = setTimeout(() => finish(new Error(SETUP_CHECK_MESSAGE)), waitMs);
      timer.unref?.();
      wake = () => { if (passed()) finish(); };
      contents.once("destroyed", gone);
      wake();
    });
    return true;
  } finally {
    contents.removeListener("did-navigate", navigated);
    contents.removeListener("did-finish-load", loaded);
  }
}

module.exports = { isCloudflareCheckPage, matchBrowserUserAgent, loadPastCloudflareCheck, SETUP_CHECK_WAIT_MS, SETUP_CHECK_MESSAGE };
