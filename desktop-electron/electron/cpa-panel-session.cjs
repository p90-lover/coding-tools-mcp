"use strict";

const { randomBytes } = require("node:crypto");

const CPA_ORIGIN = "http://127.0.0.1:8317";

function installCpaPanelSession({ webContents, webFrameMain, getConnection, logger, origin = CPA_ORIGIN }) {
  const endpoint = new URL(origin);
  if (endpoint.protocol !== "http:" || endpoint.hostname !== "127.0.0.1"
    || endpoint.username || endpoint.password || endpoint.origin !== origin) {
    throw new Error("Managed CPA panel must use a loopback HTTP origin");
  }
  // The upstream panel needs a non-empty key in its auth store. Give it an
  // opaque marker; the real management key stays in the main process.
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

  browserSession.webRequest.onBeforeSendHeaders({
    urls: [`${origin}/v0/management/*`],
  }, (details, callback) => {
    const headers = { ...details.requestHeaders };
    if (details.webContentsId !== webContents.id || !isManagedPanel(details.frame)) {
      callback({ requestHeaders: headers });
      return;
    }
    const authorizationHeader = Object.keys(headers).find((name) => name.toLowerCase() === "authorization");
    if (authorizationHeader && headers[authorizationHeader] === `Bearer ${sessionMarker}`) {
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
        localStorage.setItem('cli-proxy-auth', JSON.stringify({
          state: { apiBase: location.origin, managementKey: marker, rememberPassword: true }, version: 0
        }));
        // CPA's first asynchronous restore may still persist its empty store.
        // Its supported legacy keys survive that write and migrate on reload.
        localStorage.setItem('apiBase', JSON.stringify(location.origin));
        localStorage.setItem('managementKey', JSON.stringify(marker));
        localStorage.setItem('isLoggedIn', 'true');
        sessionStorage.setItem('coding-tools-cpa-session', marker);
        return true;
      })()`);
      if (seeded && isManagedPanel(frame)) {
        frame.reload();
        logger?.info?.("cpa.panel_session_seeded", { credentialInRenderer: false });
      }
    } catch {
      // Never log script text or upstream errors at this credential boundary.
      logger?.warn?.("cpa.panel_session_failed", { retry: "reopen-cpa-panel" });
    } finally {
      pendingFrames.delete(frame);
    }
  }

  webContents.on("did-frame-finish-load", seedPanelSession);
  webContents.once("destroyed", () => {
    browserSession.webRequest.onBeforeSendHeaders({ urls: [`${origin}/v0/management/*`] }, null);
  });
}

module.exports = { installCpaPanelSession };
