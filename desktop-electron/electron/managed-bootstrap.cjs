"use strict";

const DEFAULT_COMPONENT_IDS = Object.freeze([
  "cpa",
  "codex-router",
  "commandcode-proxy",
  "paseo",
  "anneal",
]);

const COMPONENT_STATUSES = new Set([
  "pending",
  "installing",
  "repairing",
  "starting",
  "ready",
  "blocked",
  "error",
]);

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function boundedMessage(value) {
  const text = value instanceof Error ? value.message : String(value || "Unknown managed component failure");
  return text.replaceAll("\0", "").slice(0, 2_000);
}

function componentRecord(id) {
  return {
    id,
    status: "pending",
    action: null,
    missingCredentials: [],
    message: null,
  };
}

function normalizeComponentIds(values) {
  if (!Array.isArray(values) || values.length === 0) {
    throw new Error("Managed bootstrap requires at least one component ID");
  }
  const normalized = [];
  const seen = new Set();
  for (const value of values) {
    const id = typeof value === "string" ? value.trim() : "";
    if (!id) throw new Error("Managed bootstrap component IDs must be non-empty strings");
    if (seen.has(id)) continue;
    seen.add(id);
    normalized.push(id);
  }
  return Object.freeze(normalized);
}

function createManagedBootstrap({
  componentIds = DEFAULT_COMPONENT_IDS,
  snapshot,
  install,
  repair,
  start,
  inspect,
  publish = null,
  logger = null,
  now = () => new Date().toISOString(),
} = {}) {
  const ids = normalizeComponentIds(componentIds);
  const idSet = new Set(ids);
  for (const [name, candidate] of Object.entries({ snapshot, install, repair, start, inspect })) {
    if (typeof candidate !== "function") throw new Error(`Managed bootstrap ${name} callback is required`);
  }
  if (publish !== null && typeof publish !== "function") {
    throw new Error("Managed bootstrap publish callback must be a function");
  }
  if (typeof now !== "function") throw new Error("Managed bootstrap clock must be a function");

  let state = {
    status: "idle",
    reason: null,
    startedAt: null,
    completedAt: null,
    components: ids.map(componentRecord),
  };
  let disposed = false;
  let activeRun = null;
  let queuedReason = null;
  const queuedIds = new Set();

  function getSnapshot() {
    return clone(state);
  }

  function emit() {
    const projected = getSnapshot();
    try { publish?.(projected); }
    catch (error) {
      logger?.warn?.("managed-bootstrap.publish-failed", {
        message: boundedMessage(error),
      });
    }
    return projected;
  }

  function updateComponent(id, patch) {
    const index = state.components.findIndex((component) => component.id === id);
    if (index < 0) throw new Error(`Managed bootstrap component is unknown: ${id}`);
    const current = state.components[index];
    const nextStatus = patch.status ?? current.status;
    if (!COMPONENT_STATUSES.has(nextStatus)) {
      throw new Error(`Managed bootstrap status is invalid: ${nextStatus}`);
    }
    const components = [...state.components];
    components[index] = {
      ...current,
      ...patch,
      missingCredentials: patch.missingCredentials
        ? [...patch.missingCredentials]
        : [...current.missingCredentials],
    };
    state = { ...state, components };
    emit();
    return components[index];
  }

  function serviceFor(id) {
    const value = snapshot();
    const services = Array.isArray(value?.services) ? value.services : [];
    const service = services.find((candidate) => candidate?.id === id);
    if (!service) throw new Error(`Managed service snapshot is missing ${id}`);
    if (!service.managedInstall || typeof service.managedInstall !== "object") {
      throw new Error(`Managed service snapshot for ${id} has no installation state`);
    }
    return service;
  }

  function requestedIds(values) {
    if (values === undefined || values === null) return [...ids];
    if (!Array.isArray(values)) throw new Error("Managed bootstrap componentIds must be an array");
    const selected = [];
    const seen = new Set();
    for (const value of values) {
      const id = typeof value === "string" ? value.trim() : "";
      if (!idSet.has(id)) throw new Error(`Managed bootstrap component is unknown: ${id || "missing"}`);
      if (seen.has(id)) continue;
      seen.add(id);
      selected.push(id);
    }
    return selected;
  }

  function aggregateStatus() {
    if (state.components.some((component) => component.status === "error")) return "error";
    if (state.components.some((component) => component.status === "blocked")) return "blocked";
    if (state.components.every((component) => component.status === "ready")) return "ready";
    return "idle";
  }

  function assertHealthyResult(id, result) {
    if (result?.status === "error") {
      throw new Error(result.error || `${id} health inspection failed`);
    }
    return result;
  }

  async function reconcileComponent(id) {
    const service = serviceFor(id);
    const managed = service.managedInstall;
    const missingCredentials = Array.isArray(managed.missingCredentials)
      ? managed.missingCredentials.filter((key) => typeof key === "string" && key)
      : [];

    updateComponent(id, {
      status: "pending",
      action: null,
      missingCredentials: [],
      message: null,
    });

    if (missingCredentials.length > 0) {
      updateComponent(id, {
        status: "blocked",
        action: null,
        missingCredentials,
        message: `Missing required credentials: ${missingCredentials.join(", ")}`,
      });
      return;
    }

    let action = null;
    try {
      switch (managed.state) {
        case "not-installed":
          action = "install";
          updateComponent(id, { status: "installing", action });
          assertHealthyResult(id, await install(id));
          break;
        case "repair-required":
          action = "repair";
          updateComponent(id, { status: "repairing", action });
          assertHealthyResult(id, await repair(id));
          break;
        case "error":
          action = managed.installedAt ? "repair" : "install";
          updateComponent(id, {
            status: action === "repair" ? "repairing" : "installing",
            action,
          });
          assertHealthyResult(id, await (action === "repair" ? repair(id) : install(id)));
          break;
        case "installed":
          action = "start";
          updateComponent(id, { status: "starting", action });
          assertHealthyResult(id, await start(id));
          action = "inspect";
          updateComponent(id, { status: "starting", action });
          assertHealthyResult(id, await inspect(id));
          break;
        case "external":
          action = "inspect";
          updateComponent(id, { status: "starting", action });
          assertHealthyResult(id, await inspect(id));
          break;
        case "installing":
          updateComponent(id, {
            status: "blocked",
            action: null,
            message: "Managed installation is already in progress",
          });
          return;
        default:
          throw new Error(`Unsupported managed installation state for ${id}: ${managed.state || "missing"}`);
      }

      updateComponent(id, {
        status: "ready",
        action,
        missingCredentials: [],
        message: null,
      });
    } catch (error) {
      const message = boundedMessage(error);
      logger?.warn?.("managed-bootstrap.component-failed", {
        componentId: id,
        action,
        message,
      });
      updateComponent(id, {
        status: "error",
        action,
        missingCredentials: [],
        message,
      });
    }
  }

  async function runPass(selectedIds, reason) {
    state = {
      ...state,
      status: "running",
      reason,
      startedAt: now(),
      completedAt: null,
    };
    emit();

    for (const id of selectedIds) {
      if (disposed) break;
      await reconcileComponent(id);
    }

    state = {
      ...state,
      status: aggregateStatus(),
      reason,
      completedAt: now(),
    };
    return emit();
  }

  async function drain() {
    while (!disposed && queuedIds.size > 0) {
      const selectedIds = ids.filter((id) => queuedIds.has(id));
      queuedIds.clear();
      const reason = queuedReason || "manual";
      queuedReason = null;
      await runPass(selectedIds, reason);
    }
    return getSnapshot();
  }

  function reconcile({ reason = "manual", componentIds: selectedValues = null } = {}) {
    if (disposed) throw new Error("Managed bootstrap has been disposed");
    const selectedIds = requestedIds(selectedValues);
    if (selectedIds.length === 0) return activeRun || Promise.resolve(getSnapshot());
    for (const id of selectedIds) queuedIds.add(id);
    queuedReason = typeof reason === "string" && reason.trim() ? reason.trim() : "manual";
    if (!activeRun) {
      const run = drain();
      activeRun = run;
      const clear = () => {
        if (activeRun === run) activeRun = null;
      };
      run.then(clear, clear);
    }
    return activeRun;
  }

  function dispose() {
    disposed = true;
    queuedIds.clear();
    queuedReason = null;
  }

  return Object.freeze({
    reconcile,
    getSnapshot,
    dispose,
  });
}

module.exports = Object.freeze({
  DEFAULT_COMPONENT_IDS,
  createManagedBootstrap,
});
