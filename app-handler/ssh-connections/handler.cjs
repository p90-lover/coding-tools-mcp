"use strict";

// The SSH hosts the person approved and the host key pinned for each. The store, its validation
// and every ssh command line live in desktop-electron/electron/ssh-connections.cjs; this module
// only names its operations for the app window.
//
// "list" is the only read. Every other operation decides which servers agents may reach or which
// host key is trusted, or opens or closes an SSH session, so the app's focus guard asks for the
// focused window before it runs
// ("inspect" changes nothing, and is held to the same rule so that the table has one exception),
// and no agent-facing tool reaches this module at all (coding-tools-apps-mcp.cjs leaves it out).
const SPECS = Object.freeze({
  inspect: { readOnly: false, description: "Describe the SSH hosts module without reading the hosts list or contacting any server." },
  list: { readOnly: true, description: "List the SSH hosts the person approved, with the fingerprint of each pinned host key." },
  add: { readOnly: false, description: "Add an SSH host as a draft; it cannot be used until the person confirms its host key." },
  update: { readOnly: false, description: "Rename an SSH host or change its production flag. The host, port and user cannot change." },
  remove: { readOnly: false, description: "Remove an SSH host and its pinned host key." },
  fetch_key: { readOnly: false, description: "Ask the server for its host key and show it to the person. The key is not trusted." },
  confirm_key: { readOnly: false, description: "Pin the fetched host key after the person compared or pasted its fingerprint." },
  // The in-app terminal (milestone 2). Each opens or closes a live SSH session, so neither is a read.
  terminal_open: { readOnly: false, description: "Open the in-app SSH terminal to an approved host, with its pinned host key." },
  terminal_close: { readOnly: false, description: "Close an in-app SSH terminal this page opened." },
});

module.exports = Object.freeze({
  operations: Object.freeze(Object.keys(SPECS)),
  module: Object.freeze({
    id: "ssh-connections",
    name: "SSH hosts",
    operations: Object.freeze(Object.entries(SPECS).map(([name, spec]) => ({ name, ...spec }))),
  }),
  isReadOnly(operation) {
    return Object.hasOwn(SPECS, operation) && SPECS[operation].readOnly === true;
  },
  async invoke(operation, args = {}, context = {}) {
    if (!Object.hasOwn(SPECS, operation)) throw new Error("Unknown SSH hosts operation");
    if (operation === "inspect") {
      return { ok: true, status: "ready", id: "ssh-connections", kind: "app-store", transport: "in-process",
        operations: Object.keys(SPECS), agentAccess: "none" };
    }
    const call = context.services?.sshConnections;
    if (typeof call !== "function") return { ok: false, status: "unavailable", error: "SSH hosts are unavailable right now. Try again in a moment." };
    return call(operation, args);
  },
});
