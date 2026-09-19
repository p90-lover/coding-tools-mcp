"use strict";

const BROWSER_SURFACE_ACTIVE_CHANNEL = "launcher:browser-surface-active";
const BROWSER_SHOW_CHANNEL = "launcher:browser-show";
const BROWSER_HIDE_CHANNEL = "launcher:browser-hide";
const SNAPSHOT_CHANNEL = "launcher:snapshot";

function messageOf(value) {
  return value instanceof Error ? value.message : String(value);
}

function missingHandlerFor(error, channel) {
  const message = messageOf(error);
  return message.includes(`No handler registered for '${channel}'`)
    || message.includes(`No handler registered for \"${channel}\"`);
}

function createBrowserSurfaceActiveInvoker(ipcRenderer) {
  if (!ipcRenderer || typeof ipcRenderer.invoke !== "function") {
    throw new TypeError("Browser surface IPC requires ipcRenderer.invoke");
  }

  let hiddenByCompatibilityFallback = false;
  let restoreAfterCompatibilityFallback = false;
  let sequence = Promise.resolve();

  async function invokeSurface(nextActive) {
    try {
      const result = await ipcRenderer.invoke(BROWSER_SURFACE_ACTIVE_CHANNEL, nextActive);
      hiddenByCompatibilityFallback = false;
      restoreAfterCompatibilityFallback = false;
      return result;
    } catch (error) {
      if (!missingHandlerFor(error, BROWSER_SURFACE_ACTIVE_CHANNEL)) throw error;

      // A running pre-update main process can host a newly reloaded renderer/preload.
      // Older main processes understand show/hide but not the surface-ownership channel.
      // Hide the native WebContentsView while another React surface is selected so it
      // cannot remain above the renderer. Commit fallback state only after hide/show
      // succeeds, so a retry never restores a view that was not hidden and never loses
      // a pending restore after a transient show failure.
      if (!nextActive) {
        if (hiddenByCompatibilityFallback) {
          return ipcRenderer.invoke(BROWSER_HIDE_CHANNEL);
        }

        let shouldRestore = false;
        try {
          const snapshot = await ipcRenderer.invoke(SNAPSHOT_CHANNEL);
          shouldRestore = snapshot?.browser?.visible === true;
        } catch {
          shouldRestore = false;
        }

        const result = await ipcRenderer.invoke(BROWSER_HIDE_CHANNEL);
        hiddenByCompatibilityFallback = true;
        restoreAfterCompatibilityFallback = shouldRestore;
        return result;
      }

      if (!hiddenByCompatibilityFallback) return null;
      if (!restoreAfterCompatibilityFallback) {
        hiddenByCompatibilityFallback = false;
        restoreAfterCompatibilityFallback = false;
        return null;
      }

      const result = await ipcRenderer.invoke(BROWSER_SHOW_CHANNEL);
      hiddenByCompatibilityFallback = false;
      restoreAfterCompatibilityFallback = false;
      return result;
    }
  }

  return function setBrowserSurfaceActive(active) {
    const nextActive = active === true;
    const operation = sequence.catch(() => undefined).then(() => invokeSurface(nextActive));
    sequence = operation.catch(() => undefined);
    return operation;
  };
}

module.exports = {
  BROWSER_HIDE_CHANNEL,
  BROWSER_SHOW_CHANNEL,
  BROWSER_SURFACE_ACTIVE_CHANNEL,
  SNAPSHOT_CHANNEL,
  createBrowserSurfaceActiveInvoker,
  missingHandlerFor,
};
