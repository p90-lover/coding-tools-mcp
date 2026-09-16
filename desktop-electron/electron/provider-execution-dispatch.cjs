"use strict";

const crypto = require("node:crypto");
const { createProviderExecutionPlan } = require("./provider-execution-router.cjs");

const EXECUTION_SECRET_KEYS = Object.freeze([
  "executionCredential",
  "engineCredential",
  "credential",
  "token",
  "accessToken",
  "access_token",
]);

function requiredText(value, label, maximum = 2048) {
  if (typeof value !== "string") throw new Error(`${label} is required`);
  const text = value.trim();
  if (!text || text.length > maximum || text.split("").some((character) => character < " ")) {
    throw new Error(`${label} is invalid`);
  }
  return text;
}

function optionalText(value, maximum = 2048) {
  if (value === undefined || value === null || value === "") return null;
  return requiredText(value, "Optional text", maximum);
}

function engineName(value) {
  const engine = requiredText(value, "Execution engine", 32).toLowerCase();
  if (engine !== "paseo" && engine !== "anneal") {
    throw new Error("Execution engine must be paseo or anneal");
  }
  return engine;
}

function executionRoot(value) {
  return value && typeof value === "object" && value.execution && typeof value.execution === "object"
    ? value.execution
    : value;
}

function revision(value, label) {
  const root = executionRoot(value);
  const candidate = Number.isInteger(root?.revision)
    ? root.revision
    : Number.isInteger(value?.revision)
      ? value.revision
      : null;
  if (!Number.isSafeInteger(candidate) || candidate < 0) {
    throw new Error(`${label} revision is unavailable`);
  }
  return candidate;
}

function boardRevision(value) {
  if (Number.isSafeInteger(value?.revision) && value.revision >= 0) return value.revision;
  return revision(value, "Execution board");
}

function missionRevision(value, missionId) {
  const root = executionRoot(value);
  const missions = Array.isArray(root?.missions) ? root.missions : [];
  const record = missions.find((candidate) => (
    candidate?.mission?.spec?.mission_id === missionId
      || candidate?.spec?.mission_id === missionId
      || candidate?.mission_id === missionId
  ));
  const candidate = record?.mission?.revision ?? record?.revision;
  if (!Number.isSafeInteger(candidate) || candidate < 0) {
    throw new Error(`Mission ${missionId} revision is unavailable`);
  }
  return candidate;
}

function providerBindingId(plan, engine) {
  const safeEngine = engineName(engine);
  const raw = `provider-hub-${safeEngine}-${plan?.account?.id ?? ""}`;
  const safe = raw.replace(/[^A-Za-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
  if (!safe) throw new Error("Provider Hub account cannot produce a binding identity");
  if (safe.length <= 128) return safe;
  const digest = crypto.createHash("sha256").update(safe).digest("hex").slice(0, 16);
  return `${safe.slice(0, 111)}-${digest}`;
}

function extractExecutionCredential(secret, fallback) {
  if (typeof fallback === "string" && fallback.length > 0) return fallback;
  if (!secret || typeof secret !== "object") return "";
  for (const key of EXECUTION_SECRET_KEYS) {
    const value = secret[key];
    if (typeof value === "string" && value.length > 0) return value;
  }
  return "";
}

function privateSnapshot(store) {
  const snapshot = store.snapshot();
  return {
    ...snapshot,
    accounts: (snapshot.accounts ?? []).map((account) => ({
      ...account,
      hasCredential: account.auth !== "api_key" || Boolean(store.accountSecret(account.id)),
    })),
  };
}

async function enforceExecutionProxy(snapshot, plan, applyGlobalRouting) {
  if (plan.proxy.mode === "direct") return;
  if (plan.proxy.source !== "global"
      || snapshot.routing?.globalEnabled !== true
      || snapshot.routing?.globalProfileId !== plan.proxy.profile?.id) {
    throw new Error(
      "The selected Provider Hub route uses an account/provider proxy that the local execution engine cannot inherit safely; choose direct routing or make that proxy the global route",
    );
  }
  if (typeof applyGlobalRouting === "function") await applyGlobalRouting();
}

function connectedBinding(value, bindingId, engine, plan) {
  const root = executionRoot(value);
  const bindings = Array.isArray(root?.bindings) ? root.bindings : [];
  return bindings.find((binding) => (
    binding?.id === bindingId
      && binding.engine === engine
      && binding.provider === plan.provider.id
      && binding.model === plan.model
      && binding.enabled === true
      && binding.connected === true
      && binding.current_scope_valid === true
  )) ?? null;
}

function createProviderExecutionDispatcher({ store, requestExecution, applyGlobalRouting }) {
  if (!store || typeof store.snapshot !== "function" || typeof store.accountSecret !== "function") {
    throw new Error("Provider network store is required");
  }
  if (typeof requestExecution !== "function") {
    throw new Error("Headless execution requester is required");
  }

  async function planned(input) {
    const snapshot = privateSnapshot(store);
    const plan = createProviderExecutionPlan(snapshot, input);
    if (!plan.model) throw new Error(`Provider Hub account ${plan.account.id} has no executable model`);
    await enforceExecutionProxy(snapshot, plan, applyGlobalRouting);
    return { snapshot, plan };
  }

  async function configure(input = {}) {
    const workspaceId = requiredText(input.workspaceId, "Workspace ID", 128);
    const engine = engineName(input.engine ?? input.workload);
    const { plan } = await planned({
      workload: input.workload ?? engine,
      providerId: input.providerId,
      accountId: input.accountId,
      model: input.model,
      allowFallback: input.allowFallback,
    });
    const bindingId = providerBindingId(plan, engine);
    const current = await requestExecution("/api/v1/execution/read", {
      workspace_id: workspaceId,
      mission_id: null,
      refresh_source: false,
    });
    const secret = store.accountSecret(plan.account.id);
    const credential = extractExecutionCredential(secret, input.credential);
    if (credential.length > 4096 || credential.split("").some((character) => character < " ")) {
      throw new Error("Execution credential is invalid");
    }
    const maxDurationMin = Number.isInteger(input.maxDurationMin)
      ? input.maxDurationMin
      : 120;
    if (maxDurationMin < 1 || maxDurationMin > 1440) {
      throw new Error("Execution duration must be 1..1440 minutes");
    }

    const result = await requestExecution("/api/v1/execution/provider", {
      workspace_id: workspaceId,
      operation: "configure",
      expected_revision: revision(current, "Execution"),
      binding_id: bindingId,
      settings: {
        id: bindingId,
        engine,
        endpoint: requiredText(input.endpoint, "Execution endpoint", 2048),
        provider: plan.provider.id,
        model: plan.model,
        mode: optionalText(input.mode, 128) ?? "default",
        project_id: optionalText(input.projectId, 128),
        repo_id: optionalText(input.repoId, 128),
        assignee_id: optionalText(input.assigneeId, 128),
        max_duration_min: maxDurationMin,
        allow_codex: input.allowCodex === true || plan.provider.id === "codex-oauth",
        confirm_external_execution: input.confirmExternalExecution !== false,
      },
      credential,
      confirm: input.confirm === true,
    });

    return { plan, bindingId, execution: result };
  }

  async function dispatchMission(input = {}) {
    const workspaceId = requiredText(input.workspaceId, "Workspace ID", 128);
    const engine = engineName(input.engine ?? input.workload);
    const taskId = requiredText(input.taskId, "Task ID", 128);
    const missionId = requiredText(input.missionId, "Mission ID", 128);
    const { plan } = await planned({
      workload: input.workload ?? engine,
      providerId: input.providerId,
      accountId: input.accountId,
      model: input.model,
      allowFallback: input.allowFallback,
    });
    const bindingId = providerBindingId(plan, engine);
    const current = await requestExecution("/api/v1/execution/read", {
      workspace_id: workspaceId,
      mission_id: null,
      refresh_source: false,
    });
    if (!connectedBinding(current, bindingId, engine, plan)) {
      throw new Error(
        `Connect Provider Hub account ${plan.account.label} to ${engine} before dispatching this stage`,
      );
    }

    await requestExecution("/api/v1/execution/update", {
      workspace_id: workspaceId,
      expected_revision: boardRevision(current),
      change: {
        operation: "agent_prepare",
        binding_id: bindingId,
        task_id: taskId,
        mission_id: missionId,
      },
      confirm: input.confirm === true,
    });
    const prepared = await requestExecution("/api/v1/execution/read", {
      workspace_id: workspaceId,
      mission_id: missionId,
      refresh_source: false,
    });
    const execution = await requestExecution("/api/v1/execution/update", {
      workspace_id: workspaceId,
      expected_revision: missionRevision(prepared, missionId),
      change: {
        operation: "agent_control",
        mission_id: missionId,
        request_key: optionalText(input.requestKey, 128) ?? crypto.randomUUID(),
        action: "create",
      },
      confirm: input.confirm === true,
    });
    return { plan, bindingId, missionId, execution };
  }

  return Object.freeze({ configure, dispatchMission });
}

module.exports = Object.freeze({
  createProviderExecutionDispatcher,
  extractExecutionCredential,
  providerBindingId,
});
