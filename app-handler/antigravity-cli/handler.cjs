"use strict";

const SPECS = Object.freeze({
  inspect: { readOnly: true, description: "Describe the Antigravity CLI tool module without contacting CPA or the network." },
  status: { readOnly: true, description: "Inspect the pinned Antigravity CLI install and CPA Antigravity (Gemini) account health." },
  install: { readOnly: false, description: "Download, verify and install the pinned Antigravity CLI after local confirmation." },
  terminal_open: { readOnly: false, description: "Open the Antigravity CLI in an in-app terminal routed through the global network proxy." },
  terminal_close: { readOnly: false, description: "Close one in-app Antigravity CLI terminal." },
  refresh: { readOnly: false, description: "Force CPA to refresh one Antigravity account's token." },
  sign_in: { readOnly: false, description: "Re-authenticate one CPA Antigravity account through CPA's own browser sign-in." },
  sweep: { readOnly: false, description: "Refresh expired CPA Antigravity accounts now and re-authenticate any that need it." },
  set_auto: { readOnly: false, description: "Turn automatic CPA Antigravity re-authentication on or off." },
});

module.exports = Object.freeze({
  operations: Object.freeze(Object.keys(SPECS)),
  module: Object.freeze({
    id: "antigravity-cli",
    name: "Antigravity CLI",
    operations: Object.freeze(Object.entries(SPECS).map(([name, spec]) => ({ name, ...spec }))),
  }),
  isReadOnly(operation) {
    return SPECS[operation]?.readOnly === true;
  },
  async invoke(operation, args = {}, context = {}) {
    if (!Object.hasOwn(SPECS, operation)) throw new Error("Unknown Antigravity CLI operation");
    if (operation === "inspect") {
      return { ok: true, status: "ready", id: "antigravity-cli", kind: "managed-tool", transport: "in-process",
        operations: Object.keys(SPECS), credentialAccess: "none" };
    }
    const call = context.services?.antigravityCli;
    if (typeof call !== "function") return { ok: false, status: "unavailable", reason: "Antigravity CLI service is unavailable" };
    return call(operation, args);
  },
});
