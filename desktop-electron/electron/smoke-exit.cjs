"use strict";

async function terminateLauncherSmoke({ app, browserHost, browserControl, mainWindow }) {
  if (!app || typeof app.exit !== "function") {
    throw new TypeError("Launcher smoke exit requires Electron app.exit");
  }
  if (!browserHost || typeof browserHost.destroy !== "function") {
    throw new TypeError("Launcher smoke exit requires browser host cleanup");
  }
  if (!browserControl || typeof browserControl.close !== "function") {
    throw new TypeError("Launcher smoke exit requires browser control cleanup");
  }
  browserHost.destroy();
  await browserControl.close();
  if (mainWindow
    && typeof mainWindow.isDestroyed === "function"
    && !mainWindow.isDestroyed()) {
    mainWindow.destroy();
  }
  // This path is exclusively for packaged CI smoke verification. app.quit() can leave
  // Chromium utility processes alive on Windows; app.exit(0) makes the verified marker
  // and cleanup the terminal state instead of waiting until the outer smoke command times out.
  app.exit(0);
}

module.exports = { terminateLauncherSmoke };
