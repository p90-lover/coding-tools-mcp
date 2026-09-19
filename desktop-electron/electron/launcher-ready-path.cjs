"use strict";

const DEFAULT_RENDERER_LOAD_TIMEOUT_MS = 6_000;
const DEFAULT_RENDERER_RETRY_DELAYS_MS = Object.freeze([1_000, 3_000]);
const DEFAULT_SNAPSHOT_RETRY_DELAYS_MS = Object.freeze([0, 50, 200, 500, 1_500, 3_000]);

function messageOf(value) {
  return value instanceof Error ? value.message : String(value);
}

function isBlankRendererUrl(url) {
  const value = String(url || "").trim();
  if (!value) return true;
  const lower = value.toLowerCase();
  return lower === "about:blank" || lower.startsWith("data:");
}

function canonicalizeRendererUrl(url) {
  const value = String(url || "").trim();
  if (!value) return "";
  try {
    const parsed = new URL(value);
    parsed.hash = "";
    parsed.search = "";
    return parsed.href;
  } catch {
    return value;
  }
}

function shouldLoadRenderer(currentUrl, packagedRendererUrl) {
  if (isBlankRendererUrl(currentUrl)) return true;
  const packaged = canonicalizeRendererUrl(packagedRendererUrl);
  if (!packaged) return true;
  return canonicalizeRendererUrl(currentUrl) !== packaged;
}

function createLazyFactory(factory) {
  if (typeof factory !== "function") {
    throw new TypeError("Lazy factory requires a function");
  }
  let value;
  let ready = false;
  const lazy = {
    get() {
      if (ready) return value;
      value = factory();
      ready = true;
      return value;
    },
    tryGet() {
      try {
        return { ok: true, value: lazy.get() };
      } catch (error) {
        return { ok: false, error };
      }
    },
    ready: () => ready,
  };
  return lazy;
}

function withReentryGuard(fn, fallback) {
  if (typeof fn !== "function") {
    throw new TypeError("Reentry guard requires a function");
  }
  let busy = false;
  return function guarded(...args) {
    if (busy) {
      return typeof fallback === "function" ? fallback.apply(this, args) : fallback;
    }
    busy = true;
    try {
      return fn.apply(this, args);
    } finally {
      busy = false;
    }
  };
}

function deferUiWork(work, { schedule = setImmediate, onError } = {}) {
  schedule(() => {
    try {
      work();
    } catch (error) {
      onError?.(error);
    }
  });
  return true;
}

function scheduleAfterPaint(work, { schedule = setImmediate, onError } = {}) {
  return deferUiWork(work, { schedule, onError });
}

function createRendererLoader({
  getUrl,
  load,
  packagedRendererUrl = "",
  timeoutMs = DEFAULT_RENDERER_LOAD_TIMEOUT_MS,
  retryDelaysMs = DEFAULT_RENDERER_RETRY_DELAYS_MS,
  schedule = (fn, delayMs) => (
    delayMs > 0 ? setTimeout(fn, delayMs) : setImmediate(fn)
  ),
} = {}) {
  if (typeof getUrl !== "function") throw new TypeError("Renderer loader requires getUrl");
  if (typeof load !== "function") throw new TypeError("Renderer loader requires load");

  let inFlight = null;

  function beginLoad() {
    if (inFlight) return inFlight;
    inFlight = Promise.resolve().then(async () => {
      if (!shouldLoadRenderer(getUrl(), packagedRendererUrl)) {
        return { loaded: false, skipped: true };
      }
      await load();
      return { loaded: true, skipped: false };
    }).finally(() => {
      inFlight = null;
    });
    return inFlight;
  }

  async function loadOnce() {
    const work = beginLoad();
    if (!(timeoutMs > 0)) return work;
    let timer = null;
    try {
      return await Promise.race([
        work,
        new Promise((_, reject) => {
          timer = schedule(() => reject(new Error("renderer load timed out")), timeoutMs);
        }),
      ]);
    } finally {
      if (timer && typeof timer === "object" && typeof timer.unref === "function") {
        timer.unref();
      }
    }
  }

  function startRetries({ onLoad, onError } = {}) {
    const delays = Array.isArray(retryDelaysMs) ? retryDelaysMs : DEFAULT_RENDERER_RETRY_DELAYS_MS;
    for (const delayMs of delays) {
      schedule(() => {
        if (!shouldLoadRenderer(getUrl(), packagedRendererUrl)) return;
        void loadOnce().then((result) => {
          if (result?.loaded) onLoad?.(result);
        }, (error) => onError?.(error));
      }, delayMs);
    }
  }

  return { loadOnce, startRetries };
}

function missingHandlerMessage(error, channel) {
  const message = messageOf(error);
  return message.includes(`No handler registered for '${channel}'`)
    || message.includes(`No handler registered for "${channel}"`);
}

function createRetryingInvoker(ipcRenderer, channel, {
  delaysMs = DEFAULT_SNAPSHOT_RETRY_DELAYS_MS,
  sleep = (delayMs) => new Promise((resolve) => setTimeout(resolve, delayMs)),
} = {}) {
  if (!ipcRenderer || typeof ipcRenderer.invoke !== "function") {
    throw new TypeError("Retrying IPC invoker requires ipcRenderer.invoke");
  }
  const delays = Array.isArray(delaysMs) && delaysMs.length > 0
    ? delaysMs
    : DEFAULT_SNAPSHOT_RETRY_DELAYS_MS;

  return async function invokeWhenRegistered(...args) {
    let lastError;
    for (let index = 0; index < delays.length; index += 1) {
      const delayMs = Number(delays[index]) || 0;
      if (delayMs > 0) await sleep(delayMs);
      try {
        return await ipcRenderer.invoke(channel, ...args);
      } catch (error) {
        lastError = error;
        const retryable = missingHandlerMessage(error, channel) && index < delays.length - 1;
        if (!retryable) throw error;
      }
    }
    throw lastError;
  };
}

function safeRead(label, read, fallback, logger) {
  try {
    return read();
  } catch (error) {
    logger?.warn?.(`${label}_failed`, { message: messageOf(error) });
    return fallback;
  }
}

module.exports = {
  DEFAULT_RENDERER_LOAD_TIMEOUT_MS,
  DEFAULT_RENDERER_RETRY_DELAYS_MS,
  DEFAULT_SNAPSHOT_RETRY_DELAYS_MS,
  canonicalizeRendererUrl,
  createLazyFactory,
  createRendererLoader,
  createRetryingInvoker,
  deferUiWork,
  isBlankRendererUrl,
  missingHandlerMessage,
  safeRead,
  scheduleAfterPaint,
  shouldLoadRenderer,
  withReentryGuard,
};
