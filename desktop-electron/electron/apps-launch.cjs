"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { writePrivateFileAtomic } = require("./atomic-file.cjs");

const CONFIG_VERSION = 1;
const SNAPSHOT_VERSION = 1;
const DEFAULT_CORE_READY_TIMEOUT_MS = 120_000;
const LAUNCHABLE_INSTALL_STATES = new Set(["installed", "repair-required", "error", "external"]);
const MODULE_STATUSES = new Set(["pending", "waiting", "launching", "ready", "blocked", "error", "skipped"]);

function messageOf(value) {
  const text = value instanceof Error ? value.message : String(value || "");
  return text.replaceAll("\0", "").slice(0, 2_000);
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function emptyConfig() {
  return { version: CONFIG_VERSION, modules: {}, lastLaunch: {} };
}

function normalizeConfig(raw) {
  if (!isPlainObject(raw) || raw.version !== CONFIG_VERSION) return emptyConfig();
  const modules = {};
  for (const [id, entry] of Object.entries(isPlainObject(raw.modules) ? raw.modules : {})) {
    if (!isPlainObject(entry)) continue;
    modules[id] = {
      ...(typeof entry.autoStart === "boolean" ? { autoStart: entry.autoStart } : {}),
      ...(typeof entry.enabled === "boolean" ? { enabled: entry.enabled } : {}),
      updatedAt: typeof entry.updatedAt === "string" ? entry.updatedAt : null,
    };
  }
  const lastLaunch = {};
  for (const [id, entry] of Object.entries(isPlainObject(raw.lastLaunch) ? raw.lastLaunch : {})) {
    if (!isPlainObject(entry)) continue;
    lastLaunch[id] = {
      at: typeof entry.at === "string" ? entry.at : null,
      reason: typeof entry.reason === "string" ? entry.reason : null,
      status: typeof entry.status === "string" ? entry.status : null,
      message: typeof entry.message === "string" ? entry.message : null,
      version: typeof entry.version === "string" ? entry.version : null,
      installState: typeof entry.installState === "string" ? entry.installState : null,
    };
  }
  return { version: CONFIG_VERSION, modules, lastLaunch };
}

function mapBootstrapStatus(status) {
  switch (status) {
    case "ready": return "ready";
    case "blocked": return "blocked";
    case "error": return "error";
    case "pending": return "waiting";
    default: return "launching";
  }
}

/**
 * Decides which Coding Tools app modules launch automatically once the core
 * launcher is fully up, in which order, and persists the operator's overrides
 * plus the outcome of every pass. All defaults come from the module manifests
 * (`app-handler/<id>/module.json`), never from constants in this file.
 */
function createAppsLaunchCoordinator({
  registry,
  configPath,
  snapshot,
  reconcile,
  publish = null,
  logger = null,
  now = () => new Date().toISOString(),
  clock = () => Date.now(),
  coreReadyTimeoutMs = DEFAULT_CORE_READY_TIMEOUT_MS,
} = {}) {
  if (!registry || typeof registry.launchOrder !== "function" || typeof registry.launch !== "function") {
    throw new Error("Apps launch coordinator requires the app-handler registry");
  }
  if (!configPath || !path.isAbsolute(configPath)) {
    throw new Error("Apps launch config path must be absolute");
  }
  if (typeof snapshot !== "function") throw new Error("Apps launch coordinator requires a services snapshot");
  if (typeof reconcile !== "function") throw new Error("Apps launch coordinator requires a reconcile callback");

  let config;
  try {
    config = normalizeConfig(JSON.parse(fs.readFileSync(configPath, "utf8")));
  } catch {
    config = emptyConfig();
  }

  const order = Object.freeze(registry.launchOrder());
  let state = {
    version: SNAPSHOT_VERSION,
    status: "idle",
    reason: null,
    startedAt: null,
    coreReadyAt: null,
    completedAt: null,
    waitedMs: null,
    order: [...order],
    modules: order.map((id) => moduleRecord(id, "pending", null)),
  };
  let activeRun = null;
  let disposed = false;

  function writeConfig() {
    writePrivateFileAtomic(configPath, `${JSON.stringify(config, null, 2)}\n`);
  }

  function serviceFor(id) {
    try {
      const value = snapshot();
      const services = Array.isArray(value?.services) ? value.services : [];
      return services.find((candidate) => candidate?.id === id) || null;
    } catch (error) {
      logger?.warn?.("apps-launch.snapshot_failed", { moduleId: id, message: messageOf(error) });
      return null;
    }
  }

  function effectiveAutoStart(id) {
    const override = config.modules[id]?.autoStart;
    if (typeof override === "boolean") return override;
    return registry.launch(id)?.autoStart !== false;
  }

  function effectiveEnabled(id) {
    const override = config.modules[id]?.enabled;
    if (typeof override === "boolean") return override;
    return true;
  }

  function moduleRecord(id, status, message, extra = {}) {
    const launch = registry.launch(id);
    const snap = typeof registry.snapshot === "function" ? registry.snapshot(id) : null;
    const service = serviceFor(id);
    const record = {
      id,
      name: snap?.name || id,
      order: launch?.order ?? 100,
      dependsOn: [...(launch?.dependsOn || [])],
      startupPolicy: launch?.startupPolicy || "auto",
      autoStart: effectiveAutoStart(id),
      autoStartDefault: launch?.autoStart !== false,
      enabled: effectiveEnabled(id),
      readyTimeoutMs: launch?.readyTimeoutMs ?? null,
      embed: snap?.visual?.embed || "none",
      installState: service?.managedInstall?.state || null,
      bundledRuntime: service?.managedInstall?.bundledRuntime === true,
      serviceStatus: service?.status || null,
      planned: false,
      action: "skip",
      skipReason: null,
      status: MODULE_STATUSES.has(status) ? status : "pending",
      message: message ? messageOf(message) : null,
      lastLaunch: config.lastLaunch[id] ? { ...config.lastLaunch[id] } : null,
      ...extra,
    };
    return record;
  }

  function decide(id) {
    const launch = registry.launch(id);
    const service = serviceFor(id);
    if (!launch) return { planned: false, action: "skip", skipReason: "unknown-module" };
    if (!effectiveEnabled(id)) return { planned: false, action: "skip", skipReason: "module-disabled" };
    if (launch.startupPolicy === "manual") return { planned: false, action: "skip", skipReason: "manual-policy" };
    if (!effectiveAutoStart(id)) return { planned: false, action: "skip", skipReason: "auto-start-disabled" };
    if (!service) return { planned: false, action: "skip", skipReason: "service-unknown" };
    if (service.enabled === false) return { planned: false, action: "skip", skipReason: "service-disabled" };
    const installState = service.managedInstall?.state || "not-installed";
    if (installState === "installing") return { planned: false, action: "skip", skipReason: "install-in-progress" };
    if (installState === "not-installed") {
      if (launch.startupPolicy === "installed-only") return { planned: false, action: "skip", skipReason: "not-installed" };
      if (!launch.installOnStartup) return { planned: false, action: "skip", skipReason: "install-on-startup-disabled" };
      if (service.managedInstall?.bundledRuntime !== true) {
        return { planned: false, action: "skip", skipReason: "no-bundled-runtime" };
      }
      return { planned: true, action: "install" };
    }
    if (LAUNCHABLE_INSTALL_STATES.has(installState)) {
      return {
        planned: true,
        action: installState === "repair-required" || installState === "error"
          ? "repair"
          : installState === "external" ? "inspect" : "start",
      };
    }
    return { planned: false, action: "skip", skipReason: `install-state:${installState}` };
  }

  function plan(reason = "manual", ids = null) {
    const selected = Array.isArray(ids) && ids.length > 0
      ? order.filter((id) => ids.includes(id))
      : [...order];
    return {
      reason,
      order: [...order],
      modules: selected.map((id) => {
        const decision = decide(id);
        return moduleRecord(id, decision.planned ? "waiting" : "skipped", null, {
          planned: decision.planned,
          action: decision.action,
          skipReason: decision.skipReason || null,
        });
      }),
    };
  }

  function getSnapshot() {
    return clone(state);
  }

  function emit() {
    const projected = getSnapshot();
    try { publish?.(projected); } catch (error) {
      logger?.warn?.("apps-launch.publish_failed", { message: messageOf(error) });
    }
    return projected;
  }

  function aggregate(modules) {
    const planned = modules.filter((module) => module.planned);
    if (planned.length === 0) return "skipped";
    if (planned.every((module) => module.status === "ready")) return "ready";
    if (planned.some((module) => module.status === "ready")) return "partial";
    if (planned.some((module) => module.status === "error")) return "error";
    if (planned.some((module) => module.status === "blocked")) return "blocked";
    return "error";
  }

  function recordOutcome(module, reason, version) {
    config.lastLaunch[module.id] = {
      at: now(),
      reason,
      status: module.status,
      message: module.message || null,
      version: version || null,
      installState: module.installState || null,
    };
  }

  async function runPass({ reason = "manual", ids = null, version = null } = {}) {
    const planned = plan(reason, ids);
    state = {
      ...state,
      status: "running",
      reason,
      startedAt: state.startedAt || now(),
      completedAt: null,
      modules: planned.modules.map((module) => (
        module.planned ? { ...module, status: "launching" } : module
      )),
    };
    emit();

    const targets = planned.modules.filter((module) => module.planned).map((module) => module.id);
    let bootstrap = null;
    let failure = null;
    if (targets.length > 0) {
      try {
        bootstrap = await reconcile({ reason: `apps-launch:${reason}`, componentIds: targets });
      } catch (error) {
        failure = messageOf(error);
        logger?.warn?.("apps-launch.reconcile_failed", { reason, message: failure });
      }
    }
    const byId = new Map(
      (Array.isArray(bootstrap?.components) ? bootstrap.components : []).map((component) => [component.id, component]),
    );
    const modules = state.modules.map((module) => {
      if (!module.planned) return moduleRecord(module.id, "skipped", null, {
        planned: false,
        action: module.action,
        skipReason: module.skipReason,
      });
      const component = byId.get(module.id);
      const status = failure ? "error" : component ? mapBootstrapStatus(component.status) : "error";
      const message = failure || component?.message || (component ? null : "Managed bootstrap returned no result");
      const next = moduleRecord(module.id, status, message, {
        planned: true,
        action: module.action,
        skipReason: null,
        bootstrapAction: component?.action || null,
        missingCredentials: Array.isArray(component?.missingCredentials) ? [...component.missingCredentials] : [],
      });
      recordOutcome(next, reason, version);
      next.lastLaunch = { ...config.lastLaunch[module.id] };
      return next;
    });
    try { writeConfig(); } catch (error) {
      logger?.warn?.("apps-launch.config_write_failed", { message: messageOf(error) });
    }
    state = {
      ...state,
      status: aggregate(modules),
      reason,
      completedAt: now(),
      modules,
    };
    logger?.info?.("apps-launch.completed", {
      reason,
      status: state.status,
      launched: modules.filter((module) => module.planned).map((module) => `${module.id}:${module.status}`),
      skipped: modules.filter((module) => !module.planned).map((module) => `${module.id}:${module.skipReason}`),
    });
    return emit();
  }

  function run(options = {}) {
    if (disposed) throw new Error("Apps launch coordinator has been disposed");
    if (activeRun) return activeRun;
    const current = runPass(options);
    activeRun = current;
    const clear = () => {
      if (activeRun === current) activeRun = null;
    };
    current.then(clear, clear);
    return current;
  }

  /**
   * Waits for the Coding Tools core (runtime supervisor, browser, provider
   * network) before launching anything. The wait is bounded so a stuck core
   * startup never leaves the integrated apps offline forever.
   */
  async function runAfterCoreReady(readiness, { reason = "startup", version = null, timeoutMs = coreReadyTimeoutMs } = {}) {
    if (disposed) throw new Error("Apps launch coordinator has been disposed");
    const startedAt = clock();
    state = {
      ...state,
      status: "waiting",
      reason,
      startedAt: now(),
      completedAt: null,
      modules: plan(reason).modules,
    };
    emit();
    let timedOut = false;
    let timer = null;
    const waits = (Array.isArray(readiness) ? readiness : [readiness]).filter(Boolean);
    try {
      await Promise.race([
        Promise.allSettled(waits.map((entry) => (typeof entry === "function" ? entry() : entry))),
        new Promise((resolve) => {
          timer = setTimeout(() => {
            timedOut = true;
            resolve();
          }, Math.max(0, Number(timeoutMs) || 0));
          if (typeof timer.unref === "function") timer.unref();
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
    const waitedMs = clock() - startedAt;
    state = { ...state, coreReadyAt: now(), waitedMs };
    if (timedOut) {
      logger?.warn?.("apps-launch.core_ready_timeout", { reason, waitedMs, timeoutMs });
    } else {
      logger?.info?.("apps-launch.core_ready", { reason, waitedMs });
    }
    if (disposed) return getSnapshot();
    return run({ reason, version });
  }

  function configure(idValue, input = {}) {
    const id = String(idValue || "").trim();
    if (!order.includes(id)) throw new Error(`Unknown Coding Tools module: ${id || "missing"}`);
    if (!isPlainObject(input)) throw new Error("Module launch configuration is required");
    const current = config.modules[id] || {};
    config.modules[id] = {
      ...current,
      ...(input.autoStart !== undefined ? { autoStart: input.autoStart === true } : {}),
      ...(input.enabled !== undefined ? { enabled: input.enabled === true } : {}),
      updatedAt: now(),
    };
    writeConfig();
    state = {
      ...state,
      modules: state.modules.map((module) => (
        module.id === id
          ? moduleRecord(id, module.status, module.message, {
              planned: module.planned,
              action: module.action,
              skipReason: module.skipReason,
            })
          : module
      )),
    };
    return emit();
  }

  function configSnapshot() {
    return clone(config);
  }

  function dispose() {
    disposed = true;
  }

  return Object.freeze({
    order,
    plan,
    run,
    runAfterCoreReady,
    configure,
    configSnapshot,
    getSnapshot,
    dispose,
  });
}

module.exports = Object.freeze({
  CONFIG_VERSION,
  DEFAULT_CORE_READY_TIMEOUT_MS,
  createAppsLaunchCoordinator,
  normalizeConfig,
});
