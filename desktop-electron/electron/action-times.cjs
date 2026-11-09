"use strict";

// Activity > Action time: how long each app tab takes to show and to answer, and how long each
// web page (Browser tab accounts, GPT Browser, sign-in pages) takes to answer and to load. Kept in
// memory only, a bounded number of entries with their recent samples: nothing is written to disk.

const path = require("node:path");
const { performance } = require("node:perf_hooks");

const MAX_ENTRIES = 60;
const MAX_SAMPLES = 40;
const MAX_MS = 10 * 60_000;
const TAB_ID = /^[a-z0-9-]{1,48}$/;
// The calls that read and write these records would otherwise time themselves.
const OWN_CHANNELS = new Set(["launcher:action-times", "launcher:action-times-clear", "launcher:action-time-tab"]);

function series() {
  return { count: 0, lastMs: null, maxMs: null, samples: [] };
}

function addSample(target, ms) {
  target.count += 1;
  target.lastMs = ms;
  target.maxMs = target.maxMs === null ? ms : Math.max(target.maxMs, ms);
  target.samples.push(ms);
  if (target.samples.length > MAX_SAMPLES) target.samples.shift();
}

// Median and 95th percentile of the recent samples: one slow outlier (a cold start, a minute-long
// setup call) shows as the slowest, not as a skewed average.
function summarize(target) {
  const sorted = [...target.samples].sort((a, b) => a - b);
  const at = (fraction) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(fraction * sorted.length))] : null);
  return { count: target.count, lastMs: target.lastMs, medianMs: at(0.5), p95Ms: at(0.95), maxMs: target.maxMs };
}

const validMs = (value) => typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= MAX_MS;
const roundMs = (value) => Math.round(value * 10) / 10;

// A path with ids collapsed, query and fragment dropped (they can carry tokens): chatgpt.com/c/:id.
function pageShape(rawUrl) {
  let url;
  try { url = new URL(rawUrl); } catch { return null; }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  const segments = url.pathname.split("/").filter(Boolean).slice(0, 2)
    .map((segment) => (/^[0-9a-f-]{16,}$/i.test(segment) || /\d/.test(segment) && segment.length >= 12 || /^\d+$/.test(segment) ? ":id" : segment.slice(0, 32)));
  return `${url.hostname}/${segments.join("/")}`;
}

// Which part of the app a page belongs to, from its session's partition folder.
function partitionGroup(partition) {
  const name = String(partition || "").replace(/^persist:/, "");
  if (/^coding-tools-chatgpt(-|$)/.test(name)) return "Browser";
  if (/^gpt-browser-/.test(name)) return "GPT Browser";
  if (/^coding-tools-register/.test(name)) return "Register";
  if (/chatgpt-desktop/.test(name)) return "ChatGPT Desktop";
  return "App";
}

function partitionOf(contents) {
  const storagePath = contents?.session?.storagePath;
  return typeof storagePath === "string" && storagePath ? `persist:${path.basename(storagePath)}` : null;
}

function createActionTimes({ now = () => Date.now() } = {}) {
  const tabs = new Map(); // tab -> { tab, render, firstMs, response, slowest: { channel, ms }, lastAt }
  const pages = new Map(); // key -> { group, account, page, response, render, lastStatus, failures, lastError, lastAt }
  let currentTab = null;

  // Most recently used last; the least recently used entry goes once the list is full.
  function entry(map, key, create) {
    let found = map.get(key);
    if (found) map.delete(key);
    else found = create();
    map.set(key, found);
    while (map.size > MAX_ENTRIES) map.delete(map.keys().next().value);
    return found;
  }

  const tabEntry = (tab) => entry(tabs, tab, () => ({ tab, render: series(), firstMs: null, response: series(), slowest: null, lastAt: null }));

  return {
    /** The renderer's report: the tab shown and how long it took to draw (first: its first mount). */
    tabRendered(input) {
      const tab = input?.tab;
      if (typeof tab !== "string" || !TAB_ID.test(tab) || !validMs(input?.ms)) throw new Error("Invalid tab timing");
      currentTab = tab;
      const found = tabEntry(tab);
      const ms = roundMs(input.ms);
      if (input.first === true && found.firstMs === null) found.firstMs = ms;
      else addSample(found.render, ms);
      found.lastAt = new Date(now()).toISOString();
    },
    /** One request from the app window answered: counted against the tab shown when it was made. */
    ipcAnswered(channel, ms, tab = currentTab) {
      if (!tab || OWN_CHANNELS.has(channel) || !validMs(ms)) return;
      const found = tabs.get(tab) ?? tabEntry(tab);
      const rounded = roundMs(ms);
      addSample(found.response, rounded);
      if (!found.slowest || rounded >= found.slowest.ms) found.slowest = { channel: String(channel).slice(0, 80), ms: rounded };
    },
    currentTab: () => currentTab,
    /** One main-frame load of a web page. */
    pageTimed({ group, account = null, page, status = null, responseMs = null, renderMs = null, error = null }) {
      if (!page) return;
      const key = `${group}\u0000${account ?? ""}\u0000${page}`;
      const found = entry(pages, key, () => ({
        group, account, page, response: series(), render: series(), lastStatus: null, failures: 0, lastError: null, lastAt: null,
      }));
      if (validMs(responseMs)) addSample(found.response, roundMs(responseMs));
      if (validMs(renderMs)) addSample(found.render, roundMs(renderMs));
      if (Number.isInteger(status) && status > 0) found.lastStatus = status;
      if (error) {
        found.failures += 1;
        found.lastError = String(error).slice(0, 120);
      }
      found.lastAt = new Date(now()).toISOString();
    },
    snapshot() {
      return {
        currentTab,
        tabs: [...tabs.values()].reverse().map((item) => ({
          tab: item.tab,
          firstMs: item.firstMs,
          render: summarize(item.render),
          response: summarize(item.response),
          slowest: item.slowest,
          lastAt: item.lastAt,
        })),
        pages: [...pages.values()].reverse().map((item) => ({
          group: item.group,
          account: item.account,
          page: item.page,
          response: summarize(item.response),
          render: summarize(item.render),
          lastStatus: item.lastStatus,
          failures: item.failures,
          lastError: item.lastError,
          lastAt: item.lastAt,
        })),
      };
    },
    clear() {
      tabs.clear();
      pages.clear();
    },
  };
}

/**
 * Times every main-frame navigation of a web page: response = start until the server's answer
 * commits (did-navigate), render = start until the page has loaded (did-finish-load). Only http(s)
 * pages; the app's own window is timed per tab by the renderer instead. Nothing runs in the page.
 */
function watchPageTimes(contents, { times, describe = () => ({}), clock = () => performance.now() }) {
  if (typeof contents?.on !== "function") return;
  let pending = null;
  const record = (fields) => {
    if (!pending) return;
    const partition = partitionOf(contents);
    let described = {};
    try { described = describe(partition) || {}; } catch {}
    times.pageTimed({
      group: described.group || partitionGroup(partition),
      account: typeof described.account === "string" && described.account ? described.account.slice(0, 80) : null,
      page: pending.page,
      status: pending.status,
      responseMs: pending.responseMs,
      ...fields,
    });
    pending = null;
  };
  contents.on("did-start-navigation", (first, legacyUrl, legacySameDocument, legacyMainFrame) => {
    // Electron passes a details event (url, isSameDocument, isMainFrame); older ones passed them
    // as arguments.
    const details = first && typeof first === "object" && "url" in first
      ? first : { url: legacyUrl, isSameDocument: legacySameDocument, isMainFrame: legacyMainFrame };
    if (!details.isMainFrame || details.isSameDocument) return;
    const page = pageShape(details.url);
    // A navigation that replaces one still loading is no failure: the first keeps its response
    // time if the server had answered, and has no render time.
    if (pending?.responseMs !== null && pending?.responseMs !== undefined) record({ renderMs: null });
    pending = page ? { page, startedAt: clock(), status: null, responseMs: null } : null;
  });
  contents.on("did-navigate", (_event, url, httpResponseCode) => {
    if (!pending) return;
    pending.status = Number.isInteger(httpResponseCode) ? httpResponseCode : null;
    pending.responseMs = clock() - pending.startedAt;
    const page = pageShape(url);
    if (page) pending.page = page;
  });
  contents.on("did-finish-load", () => {
    if (pending) record({ renderMs: clock() - pending.startedAt });
  });
  contents.on("did-fail-load", (_event, errorCode, errorDescription, _url, isMainFrame) => {
    // -3 (aborted) is a navigation another one took over; the next start records that.
    if (!pending || isMainFrame === false || errorCode === -3) return;
    record({ renderMs: null, error: errorDescription || `error ${errorCode}` });
  });
  contents.once?.("destroyed", () => { pending = null; });
}

/**
 * Wraps an IPC handler so each request from the app window is timed against the tab shown when
 * it was made (a slow answer that lands after a switch still belongs to the tab that asked).
 * Requests from other pages pass through untimed.
 */
function timeIpcHandler(times, channel, handler, { isAppWindow, clock = () => performance.now() }) {
  if (OWN_CHANNELS.has(channel)) return handler;
  return async (event, ...args) => {
    const tab = isAppWindow(event?.sender) ? times.currentTab() : null;
    if (!tab) return handler(event, ...args);
    const startedAt = clock();
    try {
      return await handler(event, ...args);
    } finally {
      times.ipcAnswered(channel, clock() - startedAt, tab);
    }
  };
}

module.exports = { createActionTimes, watchPageTimes, timeIpcHandler, pageShape, partitionGroup, MAX_ENTRIES, MAX_SAMPLES };
