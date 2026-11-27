"use strict";

// The host the app runs on (docs/specs/electron-host-seam-panes): main.cjs registers the one it
// built at start; modules that cannot be handed it by argument, browser-host.cjs among them, ask
// for it when they use a service. Electron's host today; the WebView2 host registers itself the same
// way in phase 3, and those modules need no change.
//
// With nothing registered (the tests, under plain Node), each call builds a host from
// require("electron") at that moment, with no cache: a test that installs an Electron stand-in, at
// any point before the call, gets that stand-in's services.

const { createElectronHost } = require("./electron-host.cjs");

let registered = null;

/** Registers the running app's host (main.cjs, once at start). */
function setCurrentHost(host) {
  registered = host ?? null;
}

/** The registered host, or one built from require("electron") now. */
function currentHost() {
  return registered ?? createElectronHost(require("electron"));
}

module.exports = { setCurrentHost, currentHost };
