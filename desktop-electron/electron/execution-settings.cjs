"use strict";

function executionSettingsPayload(settings, plan) {
  if (!settings) return null;
  if (!plan?.provider?.id || !plan?.account?.id || !plan?.model) {
    throw new Error("A verified route is required for external execution");
  }
  if (plan.fallbackUsed === true) throw new Error("Execution route fallback is not allowed");
  if (settings.provider !== plan.provider.id || settings.model !== plan.model) {
    throw new Error("Execution route does not match the exact model and provider");
  }
  const routeId = plan.proxy?.mode === "profile" ? plan.proxy.profile?.id : null;
  if (plan.proxy?.mode === "profile" && !routeId) {
    throw new Error("Selected proxy route is unavailable");
  }
  return {
    id: settings.id ?? null,
    engine: settings.engine,
    endpoint: settings.endpoint,
    provider: plan.provider.id,
    model: plan.model,
    account_id: plan.account.id,
    route_id: routeId,
    mode: settings.mode,
    project_id: settings.projectId ?? null,
    repo_id: settings.repoId ?? null,
    assignee_id: settings.assigneeId ?? null,
    max_duration_min: settings.maxDurationMin,
    allow_codex: settings.allowCodex,
    confirm_external_execution: settings.confirmExternalExecution,
  };
}

module.exports = { executionSettingsPayload };
