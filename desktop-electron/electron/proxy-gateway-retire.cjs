const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const { processRunning } = require("./process-tree.cjs");

// The built-in Proxy Gateway was removed: the app routes through the profiles on its Proxy page
// (ProxyBridge already relays locally). An older version may have left behind:
//   - its helper process, detached so it outlived app restarts and installs;
//   - the app-wide route pointing at the "builtin-gateway" profile ("Use for this app");
//   - that profile with its access key in the encrypted store, and the gateway's settings, state
//     and log files.
// Each start retires what is left. Only a helper that proves it is the gateway (its control port
// answers with the state file's token, naming the gateway service and its own pid) is stopped; one
// that is alive but does not answer keeps its state file so the next start tries again.
const GATEWAY_PROFILE_ID = "builtin-gateway";
const HELPER_SERVICE = "coding-tools-proxy-gateway";
const HOST = "127.0.0.1";

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function control(state, method, pathname, timeoutMs) {
  return new Promise((resolve) => {
    const request = http.request({
      host: HOST,
      port: state.controlPort,
      method,
      path: pathname,
      headers: { Authorization: `Bearer ${state.controlToken}` },
      timeout: timeoutMs,
    }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => {
        try {
          resolve(response.statusCode === 200 ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : null);
        } catch {
          resolve(null);
        }
      });
      response.on("error", () => resolve(null));
    });
    request.on("timeout", () => request.destroy());
    request.on("error", () => resolve(null));
    request.end();
  });
}

async function waitForExit(pid, timeoutMs, isRunning) {
  const until = Date.now() + timeoutMs;
  while (isRunning(pid)) {
    if (Date.now() >= until) return false;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return true;
}

// Returns true when no gateway helper is left running.
async function stopHelper(state, { logger, isRunning, kill, timeoutMs }) {
  const pid = Number(state?.pid);
  if (!Number.isInteger(pid) || pid <= 0 || !isRunning(pid)) return true;
  const verified = Number.isInteger(state.controlPort) && typeof state.controlToken === "string"
    ? await control(state, "GET", "/status", timeoutMs)
    : null;
  if (verified?.service !== HELPER_SERVICE || verified.pid !== pid) {
    logger.warn("proxy_gateway.retire_helper_unverified", { pid });
    return false;
  }
  await control(state, "POST", "/stop", timeoutMs);
  if (!(await waitForExit(pid, 3_000, isRunning))) {
    try { kill(pid); } catch {}
    await waitForExit(pid, 2_000, isRunning);
  }
  const stopped = !isRunning(pid);
  logger.info("proxy_gateway.retired_helper", { pid, stopped });
  return stopped;
}

// Puts back the route that was active before "Use for this app" was switched on, else direct.
function restoreRoute(store, settings) {
  const routing = store.snapshot().routing;
  if (routing.globalProfileId !== GATEWAY_PROFILE_ID) return false;
  const previous = settings?.previousGlobal;
  const usable = typeof previous?.profileId === "string"
    && previous.profileId !== GATEWAY_PROFILE_ID
    && store.activeProxy(previous.profileId);
  store.setGlobalRouting(usable
    ? { enabled: previous.enabled === true, profileId: previous.profileId }
    : { enabled: false, profileId: null });
  return true;
}

async function retireProxyGateway({
  userData,
  store,
  logger,
  isRunning = processRunning,
  kill = (pid) => process.kill(pid),
  timeoutMs = 2_000,
}) {
  const directory = path.join(userData, "providers");
  const settingsPath = path.join(directory, "proxy-gateway.json");
  const statePath = path.join(directory, "proxy-gateway.state.json");
  const settings = readJson(settingsPath);
  const state = readJson(statePath);
  const hasProfile = store.snapshot().proxyProfiles.some((profile) => profile.id === GATEWAY_PROFILE_ID);
  if (!settings && !state && !hasProfile) return { retired: false };

  let routeRestored = false;
  try {
    routeRestored = restoreRoute(store, settings);
    if (hasProfile) store.removeProxyProfile(GATEWAY_PROFILE_ID);
  } catch (error) {
    logger.warn("proxy_gateway.retire_route_failed", { message: error instanceof Error ? error.message : String(error) });
  }
  const helperGone = await stopHelper(state, { logger, isRunning, kill, timeoutMs });
  const files = [settingsPath, path.join(directory, "proxy-gateway.log"), path.join(directory, "proxy-gateway.log.1")];
  if (helperGone) files.push(statePath);
  for (const file of files) {
    try { fs.rmSync(file, { force: true }); } catch {}
  }
  logger.info("proxy_gateway.retired", { routeRestored, helperGone, profileRemoved: hasProfile });
  return { retired: true, routeRestored, helperGone };
}

module.exports = { GATEWAY_PROFILE_ID, retireProxyGateway };
