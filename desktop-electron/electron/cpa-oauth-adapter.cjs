"use strict";

const CPA_LOGIN_ADAPTERS = Object.freeze({
  "cpa-codex": Object.freeze({
    id: "cpa-codex",
    kind: "cpa_oauth",
    route: "codex-auth-url",
    providers: Object.freeze(["codex", "openai", "openai-codex"]),
  }),
  "cpa-claude": Object.freeze({
    id: "cpa-claude",
    kind: "cpa_oauth",
    route: "anthropic-auth-url",
    providers: Object.freeze(["anthropic", "claude"]),
  }),
  "cpa-antigravity": Object.freeze({
    id: "cpa-antigravity",
    kind: "cpa_oauth",
    route: "antigravity-auth-url",
    providers: Object.freeze(["antigravity"]),
  }),
  "cpa-gemini": Object.freeze({
    id: "cpa-gemini",
    kind: "cpa_auth_file",
    route: null,
    providers: Object.freeze(["gemini", "gemini-cli", "google-gemini"]),
  }),
});

function adapterDefinition(adapterId) {
  const adapter = CPA_LOGIN_ADAPTERS[String(adapterId || "").trim()];
  if (!adapter) throw new Error(`Unsupported CPA login adapter: ${adapterId || "<missing>"}`);
  return adapter;
}

function normalizedText(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function authFileProvider(entry) {
  return String(entry?.provider ?? entry?.type ?? "").trim().toLowerCase();
}

function authFileName(entry) {
  return normalizedText(entry?.name ?? entry?.id);
}

function authFileIndex(entry) {
  return normalizedText(entry?.auth_index ?? entry?.authIndex);
}

function authFileId(entry) {
  return authFileIndex(entry) ?? authFileName(entry);
}

function authFileIdentity(entry) {
  return normalizedText(entry?.email ?? entry?.account ?? entry?.label ?? entry?.username);
}

function authFileDetail(entry) {
  return `${entry?.status ?? ""} ${entry?.status_message ?? ""}`.trim();
}

function connectionStatus(entry) {
  const detail = authFileDetail(entry);
  if (entry?.disabled === true) return "disabled";
  if (/expired|invalid[_ -]?grant|refresh token|reauth/i.test(detail)) return "expired";
  if (entry?.unavailable === true || /error|failed|invalid/i.test(detail)) return "error";
  return "connected";
}

function normalizedAuthFile(entry) {
  const id = authFileId(entry);
  const name = authFileName(entry);
  if (!id || !name) return null;
  return {
    id,
    name,
    authIndex: authFileIndex(entry),
    provider: authFileProvider(entry),
    identity: authFileIdentity(entry),
    status: connectionStatus(entry),
    error: connectionStatus(entry) === "connected" ? null : authFileDetail(entry) || null,
    raw: entry,
  };
}

function adapterFiles(listing, adapter) {
  const files = Array.isArray(listing?.files) ? listing.files : [];
  const providers = new Set(adapter.providers);
  return files
    .map(normalizedAuthFile)
    .filter((entry) => entry && providers.has(entry.provider));
}

function selectAuthFile({
  files,
  boundAuthFileId = null,
  baselineIds = new Set(),
  reservedAuthFileIds = new Set(),
  identity = "",
  requireBound = false,
}) {
  if (boundAuthFileId) {
    const bound = files.find((entry) => entry.id === boundAuthFileId || entry.name === boundAuthFileId);
    if (bound) return bound;
    if (requireBound) throw new Error("The bound CPA account is unavailable; sign in or import it again");
  }
  const available = files.filter((entry) => !reservedAuthFileIds.has(entry.id));
  const created = available.find((entry) => !baselineIds.has(entry.id));
  if (created) return created;
  const normalizedIdentity = String(identity || "").trim().toLowerCase();
  if (normalizedIdentity) {
    const matching = available.find((entry) => (
      String(entry.identity || "").trim().toLowerCase() === normalizedIdentity
    ));
    if (matching) return matching;
  }
  return available.find((entry) => entry.status === "connected")
    ?? available.find((entry) => entry.status !== "disabled")
    ?? available[0]
    ?? null;
}

function modelIds(value) {
  const rows = Array.isArray(value?.models) ? value.models : [];
  return [...new Set(rows.flatMap((entry) => {
    const id = typeof entry === "string" ? entry : entry?.id ?? entry?.name ?? entry?.model;
    return typeof id === "string" && id.trim() ? [id.trim()] : [];
  }))].sort().slice(0, 128);
}

async function resolveAuthFile({
  adapter,
  requestJson,
  baselineIds = new Set(),
  reservedAuthFileIds = new Set(),
  boundAuthFileId = null,
  boundAuthFileName = null,
  boundAuthFileIndex = null,
  identity = "",
  requireBound = false,
}) {
  const params = new URLSearchParams();
  if (boundAuthFileName) params.set("name", boundAuthFileName);
  if (boundAuthFileIndex) params.set("auth_index", boundAuthFileIndex);
  const query = params.toString();
  const listing = await requestJson(
    `/v0/management/auth-files${query ? `?${query}` : ""}`,
  );
  const files = adapterFiles(listing, adapter);
  const selected = selectAuthFile({
    files,
    boundAuthFileId,
    baselineIds,
    reservedAuthFileIds,
    identity,
    requireBound,
  });
  if (!selected) {
    const provider = adapter.providers[0];
    throw new Error(`No available ${provider} account exists in CPA; complete its CPA/CLI login first`);
  }
  let models = [];
  let modelError = null;
  try {
    const catalogue = await requestJson(
      `/v0/management/auth-files/models?name=${encodeURIComponent(selected.name)}`,
    );
    models = modelIds(catalogue);
  } catch (error) {
    modelError = error instanceof Error ? error.message : String(error);
  }
  return { authFile: selected, models, modelError };
}

async function startCpaAccountLogin({
  adapterId,
  requestJson,
  openExternal,
  sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
  now = Date.now,
  timeoutMs = 5 * 60_000,
  pollIntervalMs = 1_000,
  identity = "",
  boundAuthFileId = null,
  boundAuthFileName = null,
  boundAuthFileIndex = null,
  reservedAuthFileIds = [],
  requireBound = false,
}) {
  if (typeof requestJson !== "function") throw new Error("CPA management request adapter is required");
  const adapter = adapterDefinition(adapterId);
  const reserved = new Set(reservedAuthFileIds.filter(Boolean));
  if (boundAuthFileId) reserved.delete(boundAuthFileId);

  if (adapter.kind === "cpa_auth_file") {
    const resolved = await resolveAuthFile({
      adapter,
      requestJson,
      reservedAuthFileIds: reserved,
      boundAuthFileId,
      boundAuthFileName,
      boundAuthFileIndex,
      identity,
      requireBound,
    });
    return { opened: false, mode: "import", state: null, ...resolved };
  }

  const baselineListing = await requestJson("/v0/management/auth-files");
  const baselineIds = new Set(adapterFiles(baselineListing, adapter).map((entry) => entry.id));
  const login = await requestJson(`/v0/management/${adapter.route}?is_webui=true`);
  const state = normalizedText(login?.state);
  const loginUrl = normalizedText(login?.url);
  if (login?.status !== "ok" || !state || !loginUrl) {
    throw new Error(`CPA did not start ${adapter.providers[0]} authentication`);
  }
  if (typeof openExternal !== "function") throw new Error("CPA OAuth browser opener is unavailable");
  await openExternal(loginUrl);

  const deadline = now() + Math.max(1, timeoutMs);
  while (now() <= deadline) {
    const status = await requestJson(
      `/v0/management/get-auth-status?state=${encodeURIComponent(state)}`,
    );
    if (status?.status === "ok") {
      const resolved = await resolveAuthFile({
        adapter,
        requestJson,
        baselineIds,
        reservedAuthFileIds: reserved,
        boundAuthFileId,
        boundAuthFileName,
        boundAuthFileIndex,
        identity,
        requireBound,
      });
      return { opened: true, mode: "external", state, ...resolved };
    }
    if (status?.status === "error") {
      throw new Error(String(status.error || `${adapter.providers[0]} authentication failed`));
    }
    await sleep(Math.max(1, pollIntervalMs));
  }

  try {
    await requestJson(
      `/v0/management/oauth-session?state=${encodeURIComponent(state)}`,
      { method: "DELETE" },
    );
  } catch {}
  throw new Error(`${adapter.providers[0]} authentication timed out`);
}

async function inspectCpaAccount(options) {
  const adapter = adapterDefinition(options.adapterId);
  const reserved = new Set((options.reservedAuthFileIds ?? []).filter(Boolean));
  if (options.boundAuthFileId) reserved.delete(options.boundAuthFileId);
  const resolved = await resolveAuthFile({
    adapter,
    requestJson: options.requestJson,
    reservedAuthFileIds: reserved,
    boundAuthFileId: options.boundAuthFileId,
    boundAuthFileName: options.boundAuthFileName,
    boundAuthFileIndex: options.boundAuthFileIndex,
    identity: options.identity,
    requireBound: true,
  });
  return { opened: false, mode: "inspect", state: null, ...resolved };
}

module.exports = {
  CPA_LOGIN_ADAPTERS,
  adapterDefinition,
  authFileId,
  authFileIdentity,
  authFileName,
  inspectCpaAccount,
  normalizedAuthFile,
  selectAuthFile,
  startCpaAccountLogin,
};
