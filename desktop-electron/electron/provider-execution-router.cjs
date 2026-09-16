"use strict";

const WORKLOADS = new Set(["paseo", "anneal"]);

const PROVIDER_EXECUTION_CATALOG = Object.freeze([
  { id: "codex-oauth", name: "Codex OAuth", protocol: "openai_responses", priority: 100, paseoEnabled: true, annealEnabled: true },
  { id: "openai-api", name: "OpenAI API", protocol: "openai_responses", priority: 95, paseoEnabled: true, annealEnabled: true },
  { id: "claude-oauth", name: "Claude OAuth", protocol: "anthropic_messages", priority: 90, paseoEnabled: true, annealEnabled: true },
  { id: "anthropic-api", name: "Anthropic API", protocol: "anthropic_messages", priority: 85, paseoEnabled: true, annealEnabled: true },
  { id: "chatgpt-web", name: "ChatGPT Web", protocol: "openai_responses", priority: 80, paseoEnabled: true, annealEnabled: true },
  { id: "gemini-api", name: "Gemini API", protocol: "gemini_native", priority: 75, paseoEnabled: true, annealEnabled: true },
  { id: "ai-studio-reverse-proxy", name: "AI Studio Reverse Proxy", protocol: "gemini_native", priority: 70, paseoEnabled: true, annealEnabled: true },
  { id: "openrouter", name: "OpenRouter", protocol: "openai_chat", priority: 65, paseoEnabled: true, annealEnabled: true },
  { id: "gemini-reverse-proxy", name: "Gemini Reverse Proxy", protocol: "gemini_native", priority: 60, paseoEnabled: true, annealEnabled: true },
  { id: "aistudio-to-api", name: "AIStudioToAPI", protocol: "openai_chat", priority: 50, paseoEnabled: true, annealEnabled: true },
  { id: "cliproxyapi-antigravity", name: "CLIProxyAPI / Antigravity", protocol: "openai_chat", proxyMode: "direct", priority: 40, paseoEnabled: true, annealEnabled: true },
  { id: "commandcode-proxy", name: "CommandCode Proxy", protocol: "openai_chat", priority: 30, paseoEnabled: true, annealEnabled: true },
  { id: "ollama", name: "Ollama", protocol: "openai_chat", proxyMode: "direct", priority: 20, paseoEnabled: true, annealEnabled: true },
  { id: "custom-openai-compatible", name: "Custom OpenAI Compatible", protocol: "openai_chat", priority: 10, paseoEnabled: true, annealEnabled: true },
]);

function requiredWorkload(value) {
  const workload = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (!WORKLOADS.has(workload)) {
    throw new Error("Workload must be paseo or anneal");
  }
  return workload;
}

function accountUsable(account) {
  if (!account
      || account.enabled === false
      || account.archivedAt
      || account.status !== "connected") {
    return false;
  }
  return account.auth !== "api_key" || account.hasCredential === true;
}

function activeProfile(snapshot, profileId, workload) {
  if (!profileId) return null;
  const profile = snapshot.proxyProfiles?.find((candidate) => (
    candidate.id === profileId
      && candidate.enabled !== false
      && !candidate.archivedAt
  ));
  if (!profile) return null;

  const scopes = Array.isArray(profile.scopes) && profile.scopes.length > 0
    ? profile.scopes
      .filter((scope) => typeof scope === "string")
      .map((scope) => scope.trim().toLowerCase())
      .filter(Boolean)
    : ["all"];
  const requiredScope = typeof workload === "string" ? workload.trim().toLowerCase() : "";
  if (requiredScope && !scopes.includes("all") && !scopes.includes(requiredScope)) {
    return null;
  }

  return {
    id: profile.id,
    name: profile.name,
    endpoint: {
      protocol: profile.endpoint.protocol,
      host: profile.endpoint.host,
      port: profile.endpoint.port,
    },
    scopes,
    bypass: Array.isArray(profile.bypass) ? [...profile.bypass] : [],
  };
}

function selectProviderAccount(
  snapshot,
  providerId,
  preferredAccountId,
  allowFallback = true,
) {
  const candidates = (snapshot.accounts ?? [])
    .filter((account) => account.providerId === providerId && accountUsable(account))
    .sort((left, right) => {
      if (left.isDefault !== right.isDefault) return left.isDefault ? -1 : 1;
      const used = String(right.lastUsedAt ?? "").localeCompare(String(left.lastUsedAt ?? ""));
      if (used !== 0) return used;
      const created = String(left.createdAt ?? "").localeCompare(String(right.createdAt ?? ""));
      return created || String(left.id).localeCompare(String(right.id));
    });

  if (preferredAccountId) {
    const preferred = candidates.find((account) => account.id === preferredAccountId);
    if (preferred) return preferred;
    if (!allowFallback) return null;
  }
  return candidates[0] ?? null;
}

function resolveExecutionProxy(
  snapshot,
  providerId,
  accountId,
  workload,
  providerProxyMode = "inherit",
) {
  const accountPolicy = (snapshot.routing?.accounts ?? []).find((candidate) => (
    candidate.accountId === accountId && candidate.providerId === providerId
  ));

  if (accountPolicy) {
    const selected = activeProfile(snapshot, accountPolicy.profileId, workload);
    if (selected) return { mode: "profile", source: "account", profile: selected };
    if (accountPolicy.inheritProvider === false) {
      if (accountPolicy.inheritGlobal === false) {
        return { mode: "direct", source: "account", profile: null };
      }
      const global = snapshot.routing?.globalEnabled
        ? activeProfile(snapshot, snapshot.routing.globalProfileId, workload)
        : null;
      return global
        ? { mode: "profile", source: "global", profile: global }
        : { mode: "direct", source: "account", profile: null };
    }
    if (accountPolicy.inheritGlobal === false) {
      return { mode: "direct", source: "account", profile: null };
    }
  } else {
    const accountRecord = (snapshot.accounts ?? []).find((candidate) => candidate.id === accountId);
    const accountProfile = activeProfile(snapshot, accountRecord?.proxyProfileId, workload);
    if (accountProfile) return { mode: "profile", source: "account", profile: accountProfile };
  }

  const providerPolicy = (snapshot.routing?.providers ?? []).find((candidate) => (
    candidate.providerId === providerId
  ));
  if (providerPolicy) {
    const selected = activeProfile(snapshot, providerPolicy.profileId, workload);
    if (selected) return { mode: "profile", source: "provider", profile: selected };
    if (providerPolicy.inheritGlobal === false) {
      return { mode: "direct", source: "provider", profile: null };
    }
  } else if (providerProxyMode === "direct") {
    return { mode: "direct", source: "provider-default", profile: null };
  }

  const global = snapshot.routing?.globalEnabled
    ? activeProfile(snapshot, snapshot.routing.globalProfileId, workload)
    : null;
  return global
    ? { mode: "profile", source: "global", profile: global }
    : { mode: "direct", source: "default", profile: null };
}

function eligibleProviders(workload, catalog) {
  const flag = workload === "paseo" ? "paseoEnabled" : "annealEnabled";
  return catalog
    .filter((provider) => provider[flag] === true)
    .sort((left, right) => right.priority - left.priority || left.id.localeCompare(right.id));
}

function createProviderExecutionPlan(snapshot, input = {}, catalog = PROVIDER_EXECUTION_CATALOG) {
  if (!snapshot || typeof snapshot !== "object") {
    throw new Error("Provider network snapshot is required");
  }

  const workload = requiredWorkload(input.workload);
  const providers = eligibleProviders(workload, catalog);
  const requestedProviderId = typeof input.providerId === "string" && input.providerId.trim()
    ? input.providerId.trim()
    : null;
  const requestedAccountId = typeof input.accountId === "string" && input.accountId.trim()
    ? input.accountId.trim()
    : null;
  const allowFallback = input.allowFallback !== false;
  const requestedAccount = requestedAccountId
    ? (snapshot.accounts ?? []).find((account) => account.id === requestedAccountId) ?? null
    : null;

  if (requestedProviderId && !providers.some((provider) => provider.id === requestedProviderId)) {
    throw new Error(`Provider ${requestedProviderId} is not enabled for ${workload}`);
  }
  if (requestedAccountId && !requestedAccount && !allowFallback) {
    throw new Error(`Provider Hub account ${requestedAccountId} was not found`);
  }
  if (requestedProviderId
      && requestedAccount
      && requestedAccount.providerId !== requestedProviderId) {
    throw new Error(
      `Provider Hub account ${requestedAccountId} does not belong to provider ${requestedProviderId}`,
    );
  }

  const anchoredProviderId = requestedProviderId || requestedAccount?.providerId || null;
  if (anchoredProviderId && !providers.some((provider) => provider.id === anchoredProviderId)) {
    throw new Error(`Provider ${anchoredProviderId} is not enabled for ${workload}`);
  }

  const ordered = anchoredProviderId
    ? [
        ...providers.filter((provider) => provider.id === anchoredProviderId),
        ...(allowFallback ? providers.filter((provider) => provider.id !== anchoredProviderId) : []),
      ]
    : providers;

  let selectedProvider = null;
  let selectedAccount = null;
  for (const provider of ordered) {
    const preferred = provider.id === anchoredProviderId ? requestedAccountId : null;
    const account = selectProviderAccount(
      snapshot,
      provider.id,
      preferred,
      preferred ? allowFallback : true,
    );
    if (account) {
      selectedProvider = provider;
      selectedAccount = account;
      break;
    }
  }

  if (!selectedProvider || !selectedAccount) {
    const detail = anchoredProviderId
      ? ` for provider ${anchoredProviderId}`
      : "";
    throw new Error(`No connected provider account is available for ${workload}${detail}`);
  }

  const fallbackUsed = Boolean(
    (requestedProviderId && selectedProvider.id !== requestedProviderId)
      || (requestedAccountId && selectedAccount.id !== requestedAccountId),
  );
  const requestedModel = typeof input.model === "string" ? input.model.trim() : "";
  const availableModels = Array.isArray(selectedAccount.models)
    ? selectedAccount.models
      .filter((model) => typeof model === "string")
      .map((model) => model.trim())
      .filter(Boolean)
    : [];
  if (requestedModel && availableModels.length > 0 && !availableModels.includes(requestedModel)) {
    throw new Error(
      `Requested model ${requestedModel} is not available for Provider Hub account ${selectedAccount.id}`,
    );
  }
  const model = requestedModel || availableModels[0] || null;
  const proxy = resolveExecutionProxy(
    snapshot,
    selectedProvider.id,
    selectedAccount.id,
    workload,
    selectedProvider.proxyMode ?? "inherit",
  );

  return {
    version: 1,
    workload,
    provider: {
      id: selectedProvider.id,
      name: selectedProvider.name,
      protocol: selectedProvider.protocol,
    },
    account: {
      id: selectedAccount.id,
      label: selectedAccount.label,
      identity: selectedAccount.identity ?? null,
      auth: selectedAccount.auth,
    },
    model,
    proxy,
    fallbackUsed,
    credentialHandle: {
      providerId: selectedProvider.id,
      accountId: selectedAccount.id,
    },
  };
}

module.exports = {
  PROVIDER_EXECUTION_CATALOG,
  createProviderExecutionPlan,
  resolveExecutionProxy,
  selectProviderAccount,
};
