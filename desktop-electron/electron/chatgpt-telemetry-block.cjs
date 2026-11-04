"use strict";

// ChatGPT's experiment and analytics hosts, which the app's ChatGPT pages do without. Measured
// 2026-11-04 on a signed-in page through the Decodo proxy: ab.chatgpt.com sent 751 KB in 2 requests
// on each load (more than the 167 chatgpt.com requests together), and blocking it brought the load
// event from about 2.17 s to 1.95 s; the composer, the model picker and the session were unchanged.
// Suggested on linux.do (topic 3121699) as a Clash reject rule.
const BLOCKED_URLS = ["*://ab.chatgpt.com/*", "*://oaistatsig.com/*", "*://*.oaistatsig.com/*"];

const blockedSessions = new WeakSet();

/**
 * Cancels requests to ChatGPT's experiment and analytics hosts in one Electron session, once.
 * The session's onBeforeRequest belongs to this: no other handler is set on ChatGPT partitions
 * (Electron keeps one per session, so a second would replace this one).
 */
function blockChatGptTelemetry(browserSession) {
  if (!browserSession?.webRequest || blockedSessions.has(browserSession)) return false;
  blockedSessions.add(browserSession);
  browserSession.webRequest.onBeforeRequest({ urls: BLOCKED_URLS }, (_details, callback) => callback({ cancel: true }));
  return true;
}

module.exports = { BLOCKED_URLS, blockChatGptTelemetry };
