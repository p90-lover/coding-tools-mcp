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
// It gets its own plugin routes and a read-only account list, nothing else. The installed plugin
// registers as "codex-review-account-selector"; the earlier name is kept for older builds. With
// only the earlier name here, its page never got the key and asked the user to paste it.
const AUTO_REVIEW_PLUGIN_IDS = ["codex-review-account-selector", "codex-auto-review"];
const ACCOUNT_LIST_PATH = "/v0/management/auth-files";
/** The Codex Auto Review plugin id whose page this path is, or null. */
function autoReviewPluginOf(pathname) {
  return AUTO_REVIEW_PLUGIN_IDS.find((id) => pathname.startsWith(`/v0/resource/plugins/${id}/`)) ?? null;
}

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
        && Boolean(autoReviewPluginOf(location.pathname)) && !location.username && !location.password;
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
        // Only the page's own plugin's routes: one plugin's page never reaches the other's.
        return target.origin === origin && !target.username && !target.password
          && (target.pathname.startsWith(`/v0/management/${autoReviewPluginOf(location.pathname)}/`)
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

  // The quota page loads nothing until "Refresh all credentials" is pressed, and Cline Pass is not one
  // of its providers. Once the panel is seeded, a page script presses it and adds a Cline Pass card.
  async function watchQuotaPage(_event, isMainFrame, processId, routingId) {
    if (isMainFrame) return;
    const frame = webFrameMain.fromId(processId, routingId);
    if (!isManagedPanel(frame)) return;
    try {
      await frame.executeJavaScript(quotaPageScript(sessionMarker));
    } catch {
      logger?.warn?.("cpa.quota_page_script_failed", { retry: "reopen-cpa-panel" });
    }
  }

  webContents.on("did-frame-finish-load", seedPanelSession);
  webContents.on("did-frame-finish-load", signInAutoReview);
  webContents.on("did-frame-finish-load", watchQuotaPage);
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

/**
 * The panel page script for CPA's quota page (#/quota), run once per page load of a seeded panel:
 * - It presses "Refresh all credentials" when the page shows nothing loaded on this visit, and again
 *   every 5 minutes while the page stays open and shown. A press by the user resets that clock.
 * - It adds a Cline Pass card under the page header with each key's 5-hour, weekly and monthly
 *   windows, read from the Cline switcher with the marker (the header hook swaps in the key).
 * "running" when the page already has it, "unseeded" before the panel session is seeded.
 */
function quotaPageScript(marker) {
  return `(() => {
    const marker = ${JSON.stringify(marker)};
    if (sessionStorage.getItem('coding-tools-cpa-session') !== marker) return 'unseeded';
    if (window.__codingToolsQuota) return 'running';
    window.__codingToolsQuota = true;
    const STALE_MS = 5 * 60e3;
    const REFRESHED = 'coding-tools-quota-refreshed';
    const LABELS = { five_hour: '5-hour', weekly: 'Weekly', monthly: 'Monthly' };
    const MONO = 'ui-monospace,SF Mono,Cascadia Mono,JetBrains Mono,Menlo,Consolas,monospace';
    let refreshedThisVisit = false;
    let usage = null;
    let usageAt = 0;
    let renderedAt = 0;
    let loading = false;
    let card = null;
    const onQuotaPage = () => location.hash.split('?')[0] === '#/quota';
    const shown = () => document.visibilityState === 'visible' && innerWidth > 0;
    const header = () => document.querySelector('[class*="QuotaHeader-module__header"]');
    const refreshButton = () => document.querySelector('[class*="QuotaHeader-module__primaryAction"]');
    const el = (tag, css, text) => {
      const node = document.createElement(tag);
      if (css) node.style.cssText = css;
      if (text !== undefined) node.textContent = text;
      return node;
    };
    const until = (iso) => {
      const minutes = Math.round((Date.parse(iso) - Date.now()) / 60e3);
      if (!(minutes > 0)) return 'resets now';
      const d = Math.floor(minutes / 1440), h = Math.floor((minutes % 1440) / 60), m = minutes % 60;
      return 'resets in ' + (d ? d + 'd ' + h + 'h' : h ? h + 'h ' + m + 'm' : m + 'm');
    };
    function windowRow(limit) {
      const left = limit.percentUsed === null ? null : Math.round(100 - limit.percentUsed);
      const row = el('div', 'display:flex;flex-direction:column;gap:5px');
      const line = el('div', 'display:flex;justify-content:space-between;gap:8px;font-size:11.5px');
      line.append(el('span', 'color:var(--text-secondary)', LABELS[limit.type] || limit.type),
        el('span', 'color:var(--text-tertiary)', (left === null ? 'unknown' : left + '% left') + (limit.resetsAt ? ' · ' + until(limit.resetsAt) : '')));
      const bar = el('div', 'height:6px;border-radius:9999px;overflow:hidden;background:color-mix(in srgb, var(--text-primary) 8%, transparent)');
      const color = left === null ? 'var(--text-quaternary)' : left >= 50 ? 'var(--viz-success)' : left >= 20 ? 'var(--quota-medium-color, var(--amber-color))' : 'var(--viz-failure)';
      bar.append(el('div', 'height:100%;border-radius:9999px;width:' + (left === null ? 0 : Math.max(0, Math.min(100, left))) + '%;background:' + color));
      row.append(line, bar);
      return row;
    }
    function render() {
      renderedAt = Date.now();
      const accounts = (usage && Array.isArray(usage.accounts) ? usage.accounts : []).filter((a) => a.enabled);
      if (!accounts.length) { card?.remove(); card = null; return; }
      card = card || el('section', 'margin:12px 0;padding:15px 16px;border:1px solid var(--border-color);border-radius:14px;display:flex;flex-direction:column;gap:11px;background:color-mix(in srgb, var(--bg-primary) 82%, transparent)');
      card.dataset.codingTools = 'cline-quota';
      const head = el('div', 'display:flex;align-items:baseline;justify-content:space-between;gap:8px');
      head.append(el('strong', 'color:var(--text-primary);font-size:14px', 'Cline Pass'),
        el('span', 'color:var(--text-tertiary);font-size:11.5px', accounts.length + (accounts.length === 1 ? ' key' : ' keys')));
      const keys = accounts.map((account) => {
        const box = el('div', 'display:flex;flex-direction:column;gap:9px;padding:10px 11px;border-radius:10px;border:1px solid color-mix(in srgb, var(--border-color) 70%, transparent);background:color-mix(in srgb, var(--bg-secondary) 55%, transparent)');
        box.append(el('div', 'color:var(--text-primary);font:600 12.5px ' + MONO + ';overflow:hidden;text-overflow:ellipsis;white-space:nowrap', account.name));
        if (account.error) box.append(el('div', 'color:var(--viz-failure);font-size:11.5px', account.error));
        else if (!account.limits.length) box.append(el('div', 'color:var(--text-tertiary);font-size:11.5px', 'No usage windows on this key'));
        else box.append(...account.limits.map(windowRow));
        return box;
      });
      const grid = el('div', 'display:grid;gap:10px;grid-template-columns:repeat(auto-fill, minmax(260px, 1fr))');
      grid.append(...keys);
      card.replaceChildren(head, grid);
      place();
    }
    // React re-renders the page and drops nodes it does not own, so the card is put back each tick.
    function place() {
      const top = onQuotaPage() && header();
      if (!card) return;
      if (!top) { card.remove(); return; }
      if (top.nextElementSibling !== card) top.after(card);
    }
    async function loadUsage(fresh) {
      if (loading) return;
      loading = true;
      try {
        const response = await fetch('/v0/management/cline-pass-switcher/api/usage-limits' + (fresh ? '?fresh=1' : ''),
          { headers: { Authorization: 'Bearer ' + marker }, cache: 'no-store' });
        usage = response.ok ? await response.json() : null;
      } catch {
        usage = null;
      } finally {
        loading = false;
        usageAt = Date.now();
        render();
      }
    }
    function tick() {
      if (!onQuotaPage()) { refreshedThisVisit = false; place(); return; }
      if (!shown()) return;
      const button = refreshButton();
      const nothingLoaded = !document.querySelector('[class*="QuotaHeader-module__metaLoaded"]');
      const stale = Date.now() - (Number(sessionStorage.getItem(REFRESHED)) || 0) > STALE_MS;
      if (button && !button.disabled && !button.querySelector('[class*="spinning"]') && (stale || (nothingLoaded && !refreshedThisVisit))) {
        refreshedThisVisit = true;
        sessionStorage.setItem(REFRESHED, String(Date.now()));
        button.click();
      }
      if (Date.now() - usageAt > STALE_MS) loadUsage(false);
      else if (Date.now() - renderedAt > 60e3) render();
      else place();
    }
    // The user's own press: the 5-minute clock restarts and the Cline card skips the switcher's cache.
    document.addEventListener('click', (event) => {
      if (!event.isTrusted || !event.target?.closest?.('[class*="QuotaHeader-module__primaryAction"]')) return;
      sessionStorage.setItem(REFRESHED, String(Date.now()));
      loadUsage(true);
    }, true);
    addEventListener('hashchange', tick);
    setInterval(tick, 1500);
    tick();
    return 'started';
  })()`;
}

module.exports = { installCpaPanelSession, panelStorageEntries, autoReviewSignInScript, quotaPageScript, CPA_HELPER_KEY_STORE };
