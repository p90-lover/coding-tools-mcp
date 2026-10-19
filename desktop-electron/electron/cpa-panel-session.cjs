"use strict";

const { randomBytes } = require("node:crypto");

const CPA_ORIGIN = "http://127.0.0.1:8317";
// Bundled CPA Helper plugin (web/app.js KEY_STORE): CPAMC shows its page in a
// same-origin iframe and it sends this raw localStorage value as a Bearer token.
const CPA_HELPER_KEY_STORE = "cpaHelper.managementKey";
const CPA_HELPER_RESOURCE_PREFIX = "/v0/resource/plugins/cpa-helper/";
const CPA_HELPER_API_PREFIX = "/v0/management/cpa-helper/";
const CLINE_RESOURCE_PREFIX = "/v0/resource/plugins/cline-pass-switcher/";
const CLINE_API_PREFIX = "/v0/management/cline-pass-switcher/";
// The user's own Codex Auto Review plugin: its page signs in with the management key (kept only in
// the page's memory) to list CPA's Codex accounts and save the one that serves codex-auto-review.
// It gets its own plugin routes and a read-only account list, nothing else.
const AUTO_REVIEW_RESOURCE_PREFIX = "/v0/resource/plugins/codex-auto-review/";
const AUTO_REVIEW_API_PREFIX = "/v0/management/codex-auto-review/";
const ACCOUNT_LIST_PATH = "/v0/management/auth-files";

// localStorage entries seeded into the managed CPA origin. Values carry only the
// opaque session marker; the real key is swapped in by the main-process header hook.
function panelStorageEntries(origin, marker) {
  return [
    ["cli-proxy-auth", JSON.stringify({
      state: { apiBase: origin, managementKey: marker, rememberPassword: true }, version: 0,
    })],
    // CPA may persist its empty store after the first asynchronous restore.
    // Its legacy keys survive that write and migrate on reload.
    ["apiBase", JSON.stringify(origin)],
    ["managementKey", JSON.stringify(marker)],
    ["isLoggedIn", "true"],
    [CPA_HELPER_KEY_STORE, marker],
  ];
}

function installCpaPanelSession({ webContents, webFrameMain, getConnection, logger, origin = CPA_ORIGIN }) {
  const endpoint = new URL(origin);
  if (endpoint.protocol !== "http:" || endpoint.hostname !== "127.0.0.1"
    || endpoint.username || endpoint.password || endpoint.origin !== origin) {
    throw new Error("Managed CPA panel must use a loopback HTTP origin");
  }
  // CPA needs a non-empty auth value; only an opaque marker reaches its iframe.
  const sessionMarker = `coding-tools-${randomBytes(24).toString("hex")}`;
  const pendingFrames = new WeakSet();
  const browserSession = webContents.session;

  function isManagedPanel(frame) {
    if (!frame || frame.isDestroyed() || webContents.isDestroyed()) return false;
    try {
      const location = new URL(frame.url);
      return frame !== webContents.mainFrame
        && frame.top === webContents.mainFrame
        && location.origin === origin
        && location.pathname === "/management.html"
        && !location.username && !location.password;
    } catch {
      return false;
    }
  }

  /** Whether this frame is the Codex Auto Review plugin's page, a direct child iframe of the panel. */
  function isAutoReviewPage(frame) {
    if (!frame || frame.isDestroyed() || webContents.isDestroyed()) return false;
    try {
      const location = new URL(frame.url);
      return isManagedPanel(frame.parent) && location.origin === origin
        && location.pathname.startsWith(AUTO_REVIEW_RESOURCE_PREFIX) && !location.username && !location.password;
    } catch {
      return false;
    }
  }

  // CPA Helper's page is a direct child iframe of the managed panel and may only
  // exchange its marker on its own plugin API routes. Codex Auto Review's page may also read the
  // account list (GET only).
  function isCpaHelperRequest(frame, url, method = "GET") {
    if (!frame || frame.isDestroyed() || webContents.isDestroyed()) return false;
    try {
      const location = new URL(frame.url);
      const target = new URL(url);
      if (isAutoReviewPage(frame)) {
        return target.origin === origin && !target.username && !target.password
          && (target.pathname.startsWith(AUTO_REVIEW_API_PREFIX)
            || (String(method).toUpperCase() === "GET" && target.pathname === ACCOUNT_LIST_PATH));
      }
      return isManagedPanel(frame.parent)
        && location.origin === origin
        && (location.pathname.startsWith(CPA_HELPER_RESOURCE_PREFIX) || location.pathname.startsWith(CLINE_RESOURCE_PREFIX))
        && !location.username && !location.password
        && target.origin === origin
        && target.pathname.startsWith(location.pathname.startsWith(CPA_HELPER_RESOURCE_PREFIX)
          ? CPA_HELPER_API_PREFIX : CLINE_API_PREFIX);
    } catch {
      return false;
    }
  }

  browserSession.webRequest.onBeforeSendHeaders({
    urls: [`${origin}/v0/management/*`],
  }, (details, callback) => {
    const headers = { ...details.requestHeaders };
    if (process.env.CODING_TOOLS_CPA_AUTH_DIAG === "1"
      && details.url?.startsWith(`${origin}/v0/management/config`)) {
      const header = Object.keys(headers).find((name) => name.toLowerCase() === "authorization");
      const topTreeId = details.frame?.top?.frameTreeNodeId;
      const mainTreeId = webContents.mainFrame?.frameTreeNodeId;
      logger?.info?.("cpa.panel_auth_probe", {
        webContentsMatch: details.webContentsId === webContents.id,
        framePresent: Boolean(details.frame),
        frameManaged: isManagedPanel(details.frame),
        frameTopSame: details.frame?.top === webContents.mainFrame,
        frameTopTreeSame: Number.isInteger(topTreeId) && topTreeId === mainTreeId,
        markerMatches: Boolean(header) && headers[header] === `Bearer ${sessionMarker}`,
      });
    }
    if (details.webContentsId !== webContents.id
      || !(isManagedPanel(details.frame) || isCpaHelperRequest(details.frame, details.url, details.method))) {
      callback({ requestHeaders: headers });
      return;
    }
    const authorizationHeader = Object.keys(headers).find((name) => name.toLowerCase() === "authorization");
    // Accounts and CPA share persisted UI storage, including markers from earlier
    // launcher instances. The owned frame/origin above is the authorization boundary;
    // these opaque placeholders never authenticate directly with CPA.
    if (authorizationHeader && /^Bearer coding-tools-[a-f0-9]{48}$/.test(headers[authorizationHeader])) {
      try {
        const connection = getConnection();
        if (connection?.baseUrl !== origin || !connection.managementKey) {
          callback({ cancel: true });
          return;
        }
        headers[authorizationHeader] = `Bearer ${connection.managementKey}`;
      } catch {
        callback({ cancel: true });
        return;
      }
    }
    callback({ requestHeaders: headers });
  });

  async function seedPanelSession(_event, isMainFrame, processId, routingId) {
    if (isMainFrame) return;
    const frame = webFrameMain.fromId(processId, routingId);
    if (!isManagedPanel(frame) || pendingFrames.has(frame)) return;
    pendingFrames.add(frame);
    try {
      const seeded = await frame.executeJavaScript(`(() => {
        if (location.origin !== ${JSON.stringify(origin)} || location.pathname !== '/management.html') return false;
        const marker = ${JSON.stringify(sessionMarker)};
        if (sessionStorage.getItem('coding-tools-cpa-session') === marker) return false;
        for (const [key, value] of ${JSON.stringify(panelStorageEntries(origin, sessionMarker))}) {
          localStorage.setItem(key, value);
        }
        sessionStorage.setItem('coding-tools-cpa-session', marker);
        return true;
      })()`);
      if (seeded && isManagedPanel(frame)) {
        await frame.executeJavaScript("location.reload()");
        logger?.info?.("cpa.panel_session_seeded", { credentialInRenderer: false });
      }
    } catch {
      logger?.warn?.("cpa.panel_session_failed", { retry: "reopen-cpa-panel" });
    } finally {
      pendingFrames.delete(frame);
    }
  }

  // Codex Auto Review keeps the key only in its page's memory, so no storage can carry it: its
  // sign-in form is filled with the marker, which the header hook above swaps for the key on that
  // plugin's own routes. Only an input the page labels as the management key is filled.
  async function signInAutoReview(_event, isMainFrame, processId, routingId) {
    if (isMainFrame) return;
    const frame = webFrameMain.fromId(processId, routingId);
    if (!isAutoReviewPage(frame) || pendingFrames.has(frame)) return;
    pendingFrames.add(frame);
    try {
      const result = await frame.executeJavaScript(autoReviewSignInScript(sessionMarker));
      if (result === "signed-in") logger?.info?.("cpa.auto_review_signed_in", { credentialInRenderer: false });
    } catch {
      logger?.warn?.("cpa.auto_review_sign_in_failed", { retry: "reopen-plugin-page" });
    } finally {
      pendingFrames.delete(frame);
    }
  }

  webContents.on("did-frame-finish-load", seedPanelSession);
  webContents.on("did-frame-finish-load", signInAutoReview);
  webContents.once("destroyed", () => {
    browserSession.webRequest.onBeforeSendHeaders({ urls: [`${origin}/v0/management/*`] }, null);
  });
}

/**
 * The page script that signs Codex Auto Review's page in with the marker: it waits up to 5 s for
 * the input the page labels as the management key, fills it as typing would and presses the
 * sign-in button beside it. "filled" when it already held a value, "no-form" when none showed.
 */
function autoReviewSignInScript(marker) {
  return `(async () => {
    const marker = ${JSON.stringify(marker)};
    const labelled = (el) => {
      const own = [el.name, el.id, el.placeholder, el.getAttribute('aria-label'), ...(el.labels ? [...el.labels].map((l) => l.textContent) : [])].join(' ');
      if (/management/i.test(own) && /key/i.test(own)) return true;
      for (let node = el.parentElement, depth = 0; node && depth < 3; node = node.parentElement, depth += 1) {
        if (/management\\s*key/i.test((node.textContent || '').slice(0, 400))) return true;
      }
      return false;
    };
    for (let attempt = 0; attempt < 25; attempt += 1) {
      const field = [...document.querySelectorAll('input')].find((el) => !el.disabled && !['hidden', 'checkbox', 'radio'].includes(el.type) && labelled(el));
      if (field) {
        if (field.value) return 'filled';
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(field, marker);
        field.dispatchEvent(new Event('input', { bubbles: true }));
        field.dispatchEvent(new Event('change', { bubbles: true }));
        let button = null;
        for (let scope = field.parentElement, depth = 0; scope && !button && depth < 5; scope = scope.parentElement, depth += 1) {
          button = [...scope.querySelectorAll('button')].find((b) => !b.disabled && /sign\\s*in|log\\s*in/i.test(b.textContent || ''));
        }
        if (button) button.click(); else if (field.form) field.form.requestSubmit();
        return 'signed-in';
      }
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    return 'no-form';
  })()`;
}

module.exports = { installCpaPanelSession, panelStorageEntries, autoReviewSignInScript, CPA_HELPER_KEY_STORE };
