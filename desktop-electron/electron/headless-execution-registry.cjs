"use strict";

let registeredHost = null;

function registerHeadlessExecutionHost(host) {
  if (!host || typeof host.request !== "function") {
    throw new Error("A valid headless execution host is required");
  }
  registeredHost = host;
  return host;
}

function clearHeadlessExecutionHost(host) {
  if (!host || registeredHost === host) registeredHost = null;
}

async function requestHeadlessExecution(pathname, body) {
  if (!registeredHost) {
    throw new Error("Local execution service is unavailable");
  }
  return registeredHost.request(pathname, body);
}

module.exports = Object.freeze({
  registerHeadlessExecutionHost,
  clearHeadlessExecutionHost,
  requestHeadlessExecution,
});
