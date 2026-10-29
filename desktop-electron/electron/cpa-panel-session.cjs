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
 * - CPA keeps quota only in the page's memory, so every reload or app restart showed an empty page.
 *   The script keeps each account's last good quota answer (localStorage, which the app's default
 *   session keeps across restarts) and replays it when the page opens, so the page shows at once.
 * - It refreshes from the network every 2 minutes while the page is open and shown, and every 5
 *   minutes after an upstream 429 (refreshEvery). An account that answers 429 or fails keeps
 *   showing its last good quota. A press by the user always goes to the network.
 * - It adds a Cline Pass card under the page header with each key's 5-hour, weekly and monthly
 *   windows, read from the Cline switcher with the marker (the header hook swaps in the key), and
 *   kept the same way.
 * - On the Auth Files page (#/auth-files) it puts the same Cline Pass windows inside the switcher's
 *   card, and each Codex account's credit balance on its card's plan line, paced and kept likewise.
 *   A Provider Manager upstream's card names its own provider (OpenCode, not "Provider-manager")
 *   and shows an OpenCode Go key's 5-hour, weekly and monthly windows. Cards that wait at "Click
 *   here to refresh quota" (Antigravity, Claude, ...) are pressed, one per tick.
 * "running" when the page already has it, "unseeded" before the panel session is seeded.
 */
function quotaPageScript(marker) {
  return `(() => {
    const marker = ${JSON.stringify(marker)};
    if (sessionStorage.getItem('coding-tools-cpa-session') !== marker) return 'unseeded';
    if (window.__codingToolsQuota) return 'running';
    window.__codingToolsQuota = true;
    const REFRESHED = 'coding-tools-quota-refreshed';
    const LIMITED = 'coding-tools-quota-limited';
    const SAVED = 'coding-tools-quota-saved';
    const CLINE_SAVED = 'coding-tools-quota-cline';
    const LABELS = { five_hour: '5-hour', rolling: '5-hour', weekly: 'Weekly', monthly: 'Monthly' };
    const MONO = 'ui-monospace,SF Mono,Cascadia Mono,JetBrains Mono,Menlo,Consolas,monospace';
    const read = (key) => { try { return JSON.parse(localStorage.getItem(key)); } catch { return null; } };
    const write = (key, value) => { try { localStorage.setItem(key, JSON.stringify(value)); } catch {} };
    const limitedAt = () => Number(read(LIMITED)) || 0;
    const noteLimited = () => write(LIMITED, Date.now());
    // How long a refresh holds before the next one goes to the network. 2 minutes normally; after an
    // upstream 429 (limitedAt(), 0 when never), 5 minutes, so the page does not keep the limit hit.
    // The slower pace lasts 30 minutes from the last 429; a limit still hit renews it.
    function refreshEvery() {
      return Date.now() - limitedAt() < 30 * 60e3 ? 5 * 60e3 : 2 * 60e3;
    }
    const savedCline = read(CLINE_SAVED);
    let refreshedThisVisit = false;
    let networkUntil = 0;
    let usage = savedCline?.value ?? null;
    let usageAt = Number(savedCline?.at) || 0;
    let usageTriedAt = usageAt;
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
    const ago = (at) => {
      const minutes = Math.floor((Date.now() - at) / 60e3);
      return minutes < 1 ? 'updated just now' : minutes < 60 ? 'updated ' + minutes + 'm ago' : 'updated ' + Math.floor(minutes / 60) + 'h ago';
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
        el('span', 'color:var(--text-tertiary);font-size:11.5px', accounts.length + (accounts.length === 1 ? ' key' : ' keys') + ' · ' + ago(usageAt)));
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
        if (response.status === 429) noteLimited();
        // A failed read keeps the last good one on screen; the attempt still waits its turn.
        if (response.ok) {
          usage = await response.json();
          usageAt = Date.now();
          write(CLINE_SAVED, { at: usageAt, value: usage });
          if ((usage?.accounts || []).some((a) => /\\b429\\b|rate.?limit/i.test(a.error || ''))) noteLimited();
        }
      } catch {
        // offline or CPA restarting: keep what is shown
      } finally {
        loading = false;
        usageTriedAt = Date.now();
        render();
      }
    }
    // Auth Files page (#/auth-files): CPA's own cards show each OAuth account's quota, but not the
    // Cline Pass switcher's windows, nor a Codex account's credit balance (wham/usage has it under
    // \`credits\`). Both are added inside the cards with the page's own quota classes, and kept and
    // paced like the quota page's answers.
    const CREDITS_SAVED = 'coding-tools-quota-credits';
    const onAuthFiles = () => location.hash.split('?')[0] === '#/auth-files';
    let credits = read(CREDITS_SAVED) || {};
    let creditsTriedAt = Math.max(0, ...Object.values(credits).map((entry) => Number(entry?.at) || 0));
    let creditsLoading = false;
    const authorized = (extra) => ({ Authorization: 'Bearer ' + marker, ...extra });
    async function loadCredits() {
      if (creditsLoading) return;
      creditsLoading = true;
      try {
        const listed = await fetch('/v0/management/auth-files', { headers: authorized(), cache: 'no-store' });
        if (!listed.ok) return;
        const files = ((await listed.json())?.files || [])
          .filter((file) => (file.type || file.provider) === 'codex' && file.disabled !== true && (file.auth_index ?? file.authIndex));
        const next = {};
        for (const file of files) {
          const index = file.auth_index ?? file.authIndex;
          const name = String(file.name || '').replace(/[.]json$/, '');
          try {
            const response = await fetch('/v0/management/api-call', { method: 'POST', headers: authorized({ 'content-type': 'application/json' }),
              body: JSON.stringify({ authIndex: index, method: 'GET', url: 'https://chatgpt.com/backend-api/wham/usage', header: { Authorization: 'Bearer $TOKEN$' } }) });
            const reply = response.ok ? await response.json() : null;
            const upstream = Number(reply?.status_code) || 0;
            if (upstream === 429 || response.status === 429) noteLimited();
            const body = typeof reply?.body === 'string' ? JSON.parse(reply.body) : reply?.body;
            // An account that fails keeps its last good balance on screen.
            if (upstream >= 200 && upstream < 300 && body?.credits) next[index] = { at: Date.now(), name, ...body.credits };
            else if (credits[index]) next[index] = credits[index];
          } catch {
            if (credits[index]) next[index] = credits[index];
          }
        }
        credits = next;
        write(CREDITS_SAVED, credits);
      } catch {
        // offline or CPA restarting: keep what is shown
      } finally {
        creditsLoading = false;
        creditsTriedAt = Date.now();
      }
    }
    // Provider Manager (the user's own CPA plugin) puts each API-key upstream in CPA as an auth file
    // named cpa-provider-manager-<id>, under the plugin's one provider key, so the card read
    // "Provider-manager" and had no quota. The plugin's state names each upstream's kind and, for an
    // OpenCode Go key, its 5-hour ("rolling"), weekly and monthly windows (percent used).
    const PROVIDERS_SAVED = 'coding-tools-quota-provider-manager';
    const PROVIDER_BADGES = { 'opencode-go': 'OpenCode' };
    const PROVIDER_WINDOWS = ['rolling', 'weekly', 'monthly'];
    let providers = read(PROVIDERS_SAVED) || {};
    let providersTriedAt = Math.max(0, ...Object.values(providers).map((entry) => Number(entry?.at) || 0));
    let providersLoading = false;
    async function loadProviders() {
      if (providersLoading) return;
      providersLoading = true;
      try {
        const response = await fetch('/v0/management/cpa-provider-manager/api/state', { headers: authorized(), cache: 'no-store' });
        if (response.status === 429) noteLimited();
        // Not installed (404) or CPA restarting: keep what is shown.
        if (!response.ok) return;
        const next = {};
        for (const upstream of (await response.json())?.providers || []) {
          if (!upstream?.id || !upstream.enabled) continue;
          const windows = upstream.quota?.windows && Object.keys(upstream.quota.windows).length ? upstream.quota.windows : null;
          const error = upstream.quota?.error || '';
          if (/\\b429\\b/.test(error)) noteLimited();
          const kept = providers[upstream.id];
          // A failed quota read keeps the last good windows on screen.
          next[upstream.id] = windows ? { at: Date.now(), kind: upstream.kind, windows }
            : kept?.windows ? { ...kept, kind: upstream.kind }
            : { at: Date.now(), kind: upstream.kind, error };
        }
        providers = next;
        write(PROVIDERS_SAVED, providers);
      } catch {
        // offline or CPA restarting: keep what is shown
      } finally {
        providersLoading = false;
        providersTriedAt = Date.now();
      }
    }
    const providerLimits = (windows) => PROVIDER_WINDOWS.filter((type) => windows[type]).map((type) => {
      const used = Number(windows[type].percent);
      return { type, percentUsed: Number.isFinite(used) ? used : null, resetsAt: windows[type].resetsAt || null };
    });
    // A card's auth file name: OAuth cards show it as the file name, a plugin's runtime-only card
    // (Cline, Provider Manager) as the account line.
    const cardFile = (card) => String((card.querySelector('[class*="AuthFileCard-module__fileName"]')
      || card.querySelector('[class*="AuthFileCard-module__account"]'))?.textContent || '').trim().replace(/[.]json$/, '');
    // The page's CSS-module class for one of AuthFileQuota's names (hashed per build), or '' when no
    // card on the page has one yet.
    function quotaClass(name) {
      const prefix = 'AuthFileQuota-module__' + name + '___';
      const node = document.querySelector('[class*="' + prefix + '"]');
      return node ? String(node.className).split(' ').find((value) => value.startsWith(prefix)) || '' : '';
    }
    function quotaRow(limit) {
      if (!quotaClass('quotaRow')) return windowRow(limit);
      const left = limit.percentUsed === null ? null : Math.round(100 - limit.percentUsed);
      const row = el('div');
      row.className = quotaClass('quotaRow');
      const head = el('div');
      head.className = quotaClass('quotaRowHeader');
      const label = el('span', '', (LABELS[limit.type] || limit.type) + ' limit');
      label.className = quotaClass('quotaModel');
      const meta = el('div', '', (left === null ? 'unknown' : left + '% left') + (limit.resetsAt ? ' · ' + until(limit.resetsAt) : ''));
      meta.className = quotaClass('quotaMeta');
      head.append(label, meta);
      const bar = el('div');
      bar.className = quotaClass('quotaBar');
      const level = left === null ? '' : left >= 50 ? 'quotaBarFillHigh' : left >= 20 ? 'quotaBarFillMedium' : 'quotaBarFillLow';
      const fill = el('div', 'width:' + (left === null ? 0 : Math.max(0, Math.min(100, left))) + '%' + (level && !quotaClass(level) ? ';background:var(--quota-medium-color, var(--amber-color))' : ''));
      fill.className = [quotaClass('quotaBarFill'), level && quotaClass(level)].filter(Boolean).join(' ');
      bar.append(fill);
      row.append(head, bar);
      return row;
    }
    // One block of window rows per card (key), built again only when its reading changes or a
    // minute passes (the "resets in" text), so the tick puts the same node back after a re-render.
    const blocks = new Map();
    function windowsBlock(key, entries, at) {
      const stamp = at + ':' + Math.floor(Date.now() / 60e3) + ':' + Boolean(quotaClass('quotaRow'));
      const held = blocks.get(key);
      if (held && held.stamp === stamp) return held.node;
      const section = el('div', quotaClass('quotaSection') ? '' : 'display:flex;flex-direction:column;gap:10px;margin:0 16px 12px');
      section.className = quotaClass('quotaSection');
      section.dataset.codingTools = key;
      for (const entry of entries) {
        if (entries.length > 1) section.append(el('div', 'color:var(--text-primary);font-size:12px;font-weight:600', entry.name));
        if (entry.error) section.append(el('div', 'color:var(--viz-failure);font-size:11.5px', entry.error));
        else if (!entry.limits.length) section.append(el('div', 'color:var(--text-tertiary);font-size:11.5px', 'No usage windows on this key'));
        else section.append(...entry.limits.map(quotaRow));
      }
      section.append(el('div', 'color:var(--text-tertiary);font-size:11px', ago(at)));
      held?.node.remove();
      blocks.set(key, { stamp, node: section });
      return section;
    }
    function clineAuthBlock() {
      const accounts = (usage && Array.isArray(usage.accounts) ? usage.accounts : []).filter((account) => account.enabled);
      return accounts.length ? windowsBlock('cline-auth-quota', accounts, usageAt) : null;
    }
    // Puts a block just above the card's actions, where CPA's own quota sits.
    function placeBlock(card, block) {
      const footer = card.querySelector('footer');
      if (block.parentElement !== card || block.nextElementSibling !== footer) card.insertBefore(block, footer);
    }
    // CPA leaves Antigravity, Claude and other cards at "Click here to refresh quota" until each is
    // pressed. Each tick presses one idle card, each card at most once per refresh period; the
    // request hook answers from the saved answers while they are fresh.
    const pressedAt = new Map();
    function pressIdleQuota(cards) {
      for (const card of cards) {
        const button = card.querySelector('[class*="AuthFileQuota-module__quotaMessageAction"]');
        const name = button && !button.disabled && cardFile(card);
        if (!name || Date.now() - (pressedAt.get(name) || 0) < refreshEvery()) continue;
        pressedAt.set(name, Date.now());
        button.click();
        return;
      }
    }
    function creditsItem(entry) {
      const item = el('span');
      item.className = quotaClass('codexPlanItem');
      item.dataset.codingTools = 'codex-credits';
      item.dataset.at = String(entry.at);
      const label = el('span', '', 'Credits');
      label.className = quotaClass('codexPlanLabel');
      const balance = Number(entry.balance);
      const value = el('span', '', entry.unlimited ? 'Unlimited' : !entry.has_credits ? 'None'
        : Number.isFinite(balance) ? Math.floor(balance).toLocaleString('en-US') : String(entry.balance));
      value.className = quotaClass('codexPlanValue');
      item.append(label, value);
      return item;
    }
    // React redraws the cards and drops nodes it does not own, so each tick puts them back.
    function decorateAuthFiles() {
      const cards = [...document.querySelectorAll('article[class*="AuthFileCard-module__card"]')];
      const clineCard = cards.find((card) => (card.textContent || '').includes('cline-pass-switcher'));
      const block = clineCard && clineAuthBlock();
      if (block) placeBlock(clineCard, block);
      for (const [id, entry] of Object.entries(providers)) {
        const card = cards.find((candidate) => cardFile(candidate) === 'cpa-provider-manager-' + id);
        if (!card) continue;
        const badge = card.querySelector('[class*="AuthFileCard-module__providerBadge"]');
        const label = PROVIDER_BADGES[entry.kind];
        if (badge && label && badge.textContent !== label) badge.textContent = label;
        if (!entry.windows && !entry.error) continue;
        placeBlock(card, windowsBlock('provider-quota-' + id, [{ error: entry.windows ? '' : entry.error, limits: entry.windows ? providerLimits(entry.windows) : [] }], entry.at));
      }
      pressIdleQuota(cards);
      for (const entry of Object.values(credits)) {
        const card = entry?.name && cards.find((candidate) => (candidate.textContent || '').includes(entry.name));
        const plan = card?.querySelector('[class*="AuthFileQuota-module__codexPlan___"]');
        if (!plan) continue;
        const shown = plan.querySelector('[data-coding-tools="codex-credits"]');
        if (shown?.dataset.at === String(entry.at) && shown.parentElement === plan) continue;
        shown?.remove();
        plan.append(creditsItem(entry));
      }
    }
    // CPA's quota page asks each account through POST /v0/management/api-call ({authIndex, method,
    // url, header, data}); CPA answers 200 with the upstream's status_code and body. On this page the
    // script answers those requests itself: from the saved answer while it is fresh, else from the
    // network, saving a good answer and falling back to the saved one when the upstream refuses.
    const NativeXhr = window.XMLHttpRequest;
    const savedAnswers = () => read(SAVED) || {};
    const answerKey = (request, body) => {
      if (!(onQuotaPage() || onAuthFiles()) || request.method.toUpperCase() !== 'POST' || !/\\/v0\\/management\\/api-call$/.test(request.url.split('?')[0])) return null;
      let call;
      try { call = JSON.parse(body); } catch { return null; }
      if (!call?.url || /consume/i.test(call.url)) return null;
      return [call.authIndex ?? call.auth_index ?? '', call.method || 'GET', call.url, call.data ?? ''].join(' ');
    };
    const answerWith = (xhr, status, text) => {
      for (const [name, value] of Object.entries({ readyState: 4, status, statusText: status === 200 ? 'OK' : '', responseText: text, response: text, responseURL: xhr.__codingTools.url })) {
        Object.defineProperty(xhr, name, { configurable: true, value });
      }
      xhr.getAllResponseHeaders = () => 'content-type: application/json\\r\\n';
      xhr.getResponseHeader = (name) => /^content-type$/i.test(name) ? 'application/json' : null;
      setTimeout(() => {
        for (const type of status ? ['readystatechange', 'load', 'loadend'] : ['readystatechange', 'error', 'loadend']) xhr['on' + type]?.(new Event(type));
      });
    };
    if (NativeXhr) {
      const { open, send, setRequestHeader, abort } = NativeXhr.prototype;
      NativeXhr.prototype.open = function (method, url, ...rest) {
        this.__codingTools = { method: String(method), url: String(url), headers: [] };
        return open.call(this, method, url, ...rest);
      };
      NativeXhr.prototype.setRequestHeader = function (name, value) {
        this.__codingTools?.headers.push([name, value]);
        return setRequestHeader.call(this, name, value);
      };
      NativeXhr.prototype.abort = function () {
        this.__codingTools?.inner?.abort();
        return abort.call(this);
      };
      NativeXhr.prototype.send = function (body) {
        const request = this.__codingTools;
        const key = request && answerKey(request, body);
        if (!key) return send.call(this, body);
        const saved = savedAnswers()[key];
        if (saved && Date.now() > networkUntil && Date.now() - saved.at < refreshEvery()) return answerWith(this, 200, saved.text);
        const inner = new NativeXhr();
        request.inner = inner;
        open.call(inner, request.method, request.url, true);
        for (const [name, value] of request.headers) setRequestHeader.call(inner, name, value);
        inner.timeout = this.timeout;
        inner.withCredentials = this.withCredentials;
        inner.onloadend = () => {
          let upstream = 0;
          try { upstream = Number(JSON.parse(inner.responseText).status_code) || 0; } catch {}
          const good = inner.status === 200 && upstream >= 200 && upstream < 300;
          if (inner.status === 429 || upstream === 429) noteLimited();
          const answers = savedAnswers();
          if (good) {
            answers[key] = { at: Date.now(), text: inner.responseText };
            write(SAVED, answers);
          }
          if (!good && answers[key]) answerWith(this, 200, answers[key].text);
          else answerWith(this, inner.status, inner.responseText);
        };
        send.call(inner, body);
      };
    }
    function tick() {
      if (onAuthFiles() && shown()) {
        if (Date.now() - usageTriedAt > refreshEvery()) loadUsage(false);
        if (Date.now() - creditsTriedAt > refreshEvery()) loadCredits();
        if (Date.now() - providersTriedAt > refreshEvery()) loadProviders();
        decorateAuthFiles();
      }
      if (!onQuotaPage()) { refreshedThisVisit = false; place(); return; }
      if (!shown()) return;
      const button = refreshButton();
      const nothingLoaded = !document.querySelector('[class*="QuotaHeader-module__metaLoaded"]');
      const due = Date.now() - (Number(read(REFRESHED)) || 0) > refreshEvery();
      if (button && !button.disabled && !button.querySelector('[class*="spinning"]') && (due || (nothingLoaded && !refreshedThisVisit))) {
        refreshedThisVisit = true;
        // A due press goes to the network; any other only puts the saved answers back on the page.
        if (due) toNetwork();
        button.click();
      }
      if (Date.now() - usageTriedAt > refreshEvery()) loadUsage(false);
      else if (Date.now() - renderedAt > 60e3) render();
      else place();
    }
    function toNetwork() {
      networkUntil = Date.now() + 30e3;
      write(REFRESHED, Date.now());
    }
    // The user's own press: it goes to the network, the clock restarts and the Cline card skips the
    // switcher's cache. Capture phase, so this runs before the page sends its requests.
    document.addEventListener('click', (event) => {
      if (!event.isTrusted) return;
      // A card's own "Click here to refresh quota", pressed by the user, also skips the saved answer.
      if (event.target?.closest?.('[class*="AuthFileQuota-module__quotaMessageAction"]')) networkUntil = Date.now() + 30e3;
      if (!event.target?.closest?.('[class*="QuotaHeader-module__primaryAction"]')) return;
      toNetwork();
      loadUsage(true);
    }, true);
    addEventListener('hashchange', tick);
    setInterval(tick, 1500);
    tick();
    return 'started';
  })()`;
}

module.exports = { installCpaPanelSession, panelStorageEntries, autoReviewSignInScript, quotaPageScript, CPA_HELPER_KEY_STORE };
