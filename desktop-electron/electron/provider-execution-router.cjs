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
  { id: "cliproxyapi-antigravity", name: "CLIProxyAPI / Antigravity", protocol: "openai_chat", priority: 40, paseoEnabled: true, annealEnabled: true },
  { id: "commandcode-proxy", name: "CommandCode Proxy", protocol: "openai_chat", priority: 30, paseoEnabled: true, annealEnabled: true },
  { id: "ollama", name: "Ollama", protocol: "openai_chat", priority: 20, paseoEnabled: true, annealEnabled: true },
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
  return Boolean(
    account
      && account.enabled !== false
      && !account.archivedAt
      && account.status === "connected",
  );
}

function activeProfile(snapshot, profileId) {
  if (!profileId) return null;
  const profile = snapshot.proxyProfiles?.find((candidate) => (
    candidate.id === profileId
      && candidate.enabled !== false
      && !candidate.archivedAt
  ));
  if (!profile) return null;
  return {
    id: profile.id,
    name: profile.name,
    endpoint: {
      protocol: profile.endpoint.protocol,
      host: profile.endpoint.host,
      port: profile.endpoint.port,
    },
    scopes: Array.isArray(profile.scopes) ? [...profile.scopes] : ["all"],
    bypass: Array.isArray(profile.bypass) ? [...profile.bypass] : [],
  };
}

function selectProviderAccount(snapshot, providerId, preferredAccountId) {
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
  }
  return candidates[0] ?? null;
}

function resolveExecutionProxy(snapshot, providerId, accountId) {
  const accountPolicy = (snapshot.routing?.accounts ?? []).find((candidate) => (
    candidate.accountId === accountId && candidate.providerId === providerId
  ));

  if (accountPolicy) {
    const selected = activeProfile(snapshot, accountPolicy.profileId);
    if (selected) return { mode: "profile", source: "account", profile: selected };
    if (accountPolicy.inheritProvider === false) {
      if (accountPolicy.inheritGlobal === false) {
        return { mode: "direct", source: "account", profile: null };
      }
      const global = snapshot.routing?.globalEnabled
        ? activeProfile(snapshot, snapshot.routing.globalProfileId)
        : null;
      return global
        ? { mode: "profile", source: "global", profile: global }
        : { mode: "direct", source: "account", profile: null };
    }
  }

  const accountRecord = (snapshot.accounts ?? []).find((candidate) => candidate.id === accountId);
  const accountProfile = activeProfile(snapshot, accountRecord?.proxyProfileId);
  if (accountProfile) return { mode: "profile", source: "account", profile: accountProfile };

  const providerPolicy = (snapshot.routing?.providers ?? []).find((candidate) => (
    candidate.providerId === providerId
  ));
  if (providerPolicy) {
    const selected = activeProfile(snapshot, providerPolicy.profileId);
    if (selected) return { mode: "profile", source: "provider", profile: selected };
    if (providerPolicy.inheritGlobal === false) {
      return { mode: "direct", source: "provider", profile: null };
    }
  }

  const global = snapshot.routing?.globalEnabled
    ? activeProfile(snapshot, snapshot.routing.globalProfileId)
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

  if (requestedProviderId && !providers.some((provider) => provider.id === requestedProviderId)) {
    throw new Error(`Provider ${requestedProviderId} is not enabled for ${workload}`);
  }

  const ordered = requestedProviderId
    ? [
        ...providers.filter((provider) => provider.id === requestedProviderId),
        ...(allowFallback ? providers.filter((provider) => provider.id !== requestedProviderId) : []),
      ]
    : providers;

  let selectedProvider = null;
  let selectedAccount = null;
  for (const provider of ordered) {
    const preferred = provider.id === requestedProviderId ? requestedAccountId : null;
    const account = selectProviderAccount(snapshot, provider.id, preferred);
    if (account) {
      selectedProvider = provider;
      selectedAccount = account;
      break;
    }
  }

  if (!selectedProvider || !selectedAccount) {
    const detail = requestedProviderId
      ? ` for provider ${requestedProviderId}`
      : "";
    throw new Error(`No connected provider account is available for ${workload}${detail}`);
  }

  const fallbackUsed = Boolean(
    (requestedProviderId && selectedProvider.id !== requestedProviderId)
      || (requestedAccountId && selectedAccount.id !== requestedAccountId),
  );
  const requestedModel = typeof input.model === "string" ? input.model.trim() : "";
  const model = requestedModel || selectedAccount.models?.[0] || null;
  const proxy = resolveExecutionProxy(snapshot, selectedProvider.id, selectedAccount.id);

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
