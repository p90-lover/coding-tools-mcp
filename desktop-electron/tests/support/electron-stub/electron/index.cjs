"use strict";

// Test-only stand-in for Electron, found through NODE_PATH by modules that are tested outside it
// (runtime-web/launcher has no electron installed). Node looks here only after node_modules, so a
// module whose own package installs electron still gets the real one. Every member is a no-op.
const noop = new Proxy(function () {}, {
  get: (_target, key) => (key === Symbol.toPrimitive ? () => "" : key === "then" ? undefined : noop),
  apply: () => noop,
  construct: () => noop,
});

module.exports = noop;
