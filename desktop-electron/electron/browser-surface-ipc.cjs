"use strict";

const BROWSER_SURFACE_ACTIVE_CHANNEL = "launcher:browser-surface-active";
const BROWSER_SHOW_CHANNEL = "launcher:browser-show";
const BROWSER_HIDE_CHANNEL = "launcher:browser-hide";

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

  return async function setBrowserSurfaceActive(active) {
    const nextActive = active === true;
    try {
      const result = await ipcRenderer.invoke(BROWSER_SURFACE_ACTIVE_CHANNEL, nextActive);
      hiddenByCompatibilityFallback = false;
      return result;
    } catch (error) {
      if (!missingHandlerFor(error, BROWSER_SURFACE_ACTIVE_CHANNEL)) throw error;

      // A running pre-update main process can host a newly reloaded renderer/preload.
      // Older main processes understand show/hide but not the surface-ownership channel.
      // Hide the native WebContentsView while another React surface is selected so it
      // cannot remain above the renderer, then restore it only if this fallback hid it.
      if (!nextActive) {
        hiddenByCompatibilityFallback = true;
        return ipcRenderer.invoke(BROWSER_HIDE_CHANNEL);
      }
      if (hiddenByCompatibilityFallback) {
        hiddenByCompatibilityFallback = false;
        return ipcRenderer.invoke(BROWSER_SHOW_CHANNEL);
      }
      return null;
    }
  };
}

module.exports = {
  BROWSER_HIDE_CHANNEL,
  BROWSER_SHOW_CHANNEL,
  BROWSER_SURFACE_ACTIVE_CHANNEL,
  createBrowserSurfaceActiveInvoker,
  missingHandlerFor,
};
