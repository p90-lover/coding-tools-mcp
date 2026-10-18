"use strict";

const routes = require("./routes.json");
const lifecycle = {
  inspect: { readOnly: true, description: "Describe the bundled Register module without starting it." },
  status: { readOnly: true, description: "Inspect owned Register backend state and missing artifacts." },
  start: { readOnly: false, description: "Start the bundled Register backend with isolated private storage." },
  stop: { readOnly: false, description: "Stop only the Register backend owned by this Coding Tools instance." },
  restart: { readOnly: false, description: "Restart the owned Register backend." },
  "ui-open": { readOnly: false, description: "Start Register and open its complete original UI inside Coding Tools." },
  "portal-owner-session": { readOnly: false, description: "Explicitly sign into the local customer portal as the app owner and return an opaque desktop session." },
};
const specs = Object.freeze([
  ...Object.entries(lifecycle).map(([name, spec]) => ({ name, ...spec })),
  ...routes.map((route) => ({ name: route.name, readOnly: route.readOnly,
    description: `${route.method} ${route.path}${route.stream ? " (event stream)" : ""}` })),
]);
const operations = Object.freeze(specs.map((spec) => spec.name));
module.exports = Object.freeze({
  module: Object.freeze({ id: "reg-machine", name: "Register", operations: specs }),
  operations,
  isReadOnly(operation) { return specs.find((spec) => spec.name === operation)?.readOnly === true; },
  async invoke(operation, args = {}, context = {}) {
    if (!operations.includes(operation)) throw new Error("Unknown Register operation");
    if (operation === "inspect") return { ok: true, status: "ready", id: "reg-machine", kind: "managed-app",
      transport: "in-process", operations, sourceManifest: "app-handler/reg-machine/SOURCE_SNAPSHOT.json" };
    const call = context.services?.regMachine;
    if (typeof call !== "function") return { ok: false, status: "unavailable", reason: "Register service is unavailable" };
    return call(operation, args);
  },
});
