"use strict";

const HANDLER_VERSION = "0.1.0";
const CONTRACT_VERSION = 1;
const RUNTIME_METHODS = Object.freeze([
  "call", "start", "stop", "show", "hide", "snapshot",
  "survivingChatHosts", "endChatHosts", "aoShimFolder",
]);
const HARNESS_METHODS = Object.freeze([
  "watch", "catalog", "models", "spawn", "recover", "observe", "continuable",
  "setContextWindow", "exitAgent", "releaseAgent", "idleChatSessions",
  "quietWorkingChatSessions", "staleSessions", "send", "steer", "kill",
  "sessionWorkspace", "anySessionWorking", "warmSessions", "resolveInput",
  "resolveApproval", "timeline", "compact", "compactionStatus", "interrupt",
  "openTerminal", "closeTerminal",
]);

// Shape compatibility is not proof of an engine's behavioral compatibility.
function inspectRuntime(runtime) {
  const missing = [];
  for (const name of RUNTIME_METHODS) {
    if (typeof runtime?.[name] !== "function") missing.push(name);
  }
  for (const name of HARNESS_METHODS) {
    if (typeof runtime?.harness?.[name] !== "function") missing.push(`harness.${name}`);
  }
  return Object.freeze({ contractVersion: CONTRACT_VERSION, shapeCompatible: missing.length === 0, missing: Object.freeze(missing) });
}

function bindMethods(target, names) {
  return Object.fromEntries(names.map(name => {
    const method = target[name];
    // Do not make this async: watch returns an unsubscribe function synchronously,
    // and callers can depend on a driver's exact promise and error identities.
    return [name, (...args) => Reflect.apply(method, target, args)];
  }));
}

function createOrchestratorHandler({ runtime, contractVersion = CONTRACT_VERSION } = {}) {
  if (contractVersion !== CONTRACT_VERSION) {
    throw new Error(`Unsupported Orchestrator contract version: ${String(contractVersion)}`);
  }
  const compatibility = inspectRuntime(runtime);
  if (!compatibility.shapeCompatible) {
    throw new Error(`Incompatible Orchestrator runtime; missing methods: ${compatibility.missing.join(", ")}`);
  }
  // A handler stays bound to one engine. Retrying a mutation on a different engine
  // could duplicate work or apply an approval to a different session.
  return Object.freeze({
    ...bindMethods(runtime, RUNTIME_METHODS),
    harness: Object.freeze(bindMethods(runtime.harness, HARNESS_METHODS)),
  });
}

module.exports = { HANDLER_VERSION, CONTRACT_VERSION, RUNTIME_METHODS, HARNESS_METHODS, inspectRuntime, createOrchestratorHandler };
