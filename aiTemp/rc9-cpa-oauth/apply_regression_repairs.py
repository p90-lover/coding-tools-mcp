from __future__ import annotations

from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


def replace_once(relative: str, old: str, new: str) -> None:
    path = ROOT / relative
    source = path.read_text(encoding="utf-8")
    if new and new in source:
        return
    count = source.count(old)
    if count != 1:
        raise SystemExit(f"expected one repair anchor in {relative}, found {count}: {old[:140]!r}")
    path.write_text(source.replace(old, new, 1), encoding="utf-8")


# Bound CPA probes must keep server-side name/auth-index filters and then verify
# the exact file client-side in case an older server ignores those filters.
replace_once(
    "desktop-electron/electron/cpa-oauth-adapter.cjs",
    '''  boundAuthFileId = null,
  identity = "",
  requireBound = false,
}) {
  const listing = await requestJson("/v0/management/auth-files");
''',
    '''  boundAuthFileId = null,
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
''',
)
replace_once(
    "desktop-electron/electron/cpa-oauth-adapter.cjs",
    '''  boundAuthFileId = null,
  reservedAuthFileIds = [],
  requireBound = false,
}) {
''',
    '''  boundAuthFileId = null,
  boundAuthFileName = null,
  boundAuthFileIndex = null,
  reservedAuthFileIds = [],
  requireBound = false,
}) {
''',
)
path = ROOT / "desktop-electron/electron/cpa-oauth-adapter.cjs"
source = path.read_text(encoding="utf-8")
old_sequence = '''      boundAuthFileId,
      identity,
      requireBound,
'''
new_sequence = '''      boundAuthFileId,
      boundAuthFileName,
      boundAuthFileIndex,
      identity,
      requireBound,
'''
count = source.count(old_sequence)
if count != 2:
    raise SystemExit(f"expected two CPA login resolution anchors, found {count}")
source = source.replace(old_sequence, new_sequence)
old_inspect = '''    boundAuthFileId: options.boundAuthFileId,
    identity: options.identity,
'''
new_inspect = '''    boundAuthFileId: options.boundAuthFileId,
    boundAuthFileName: options.boundAuthFileName,
    boundAuthFileIndex: options.boundAuthFileIndex,
    identity: options.identity,
'''
if source.count(old_inspect) != 1:
    raise SystemExit("expected one CPA inspect binding anchor")
path.write_text(source.replace(old_inspect, new_inspect, 1), encoding="utf-8")

# Auth-file identities are encrypted binding state, not renderer-facing account
# fields. Keep only the adapter and credential-source classifications public.
for relative in [
    "desktop-electron/src/types.ts",
    "desktop-electron/electron/provider-network.cjs",
]:
    path = ROOT / relative
    source = path.read_text(encoding="utf-8")
    for line in [
        "  authFileId?: string;\n",
        "  authFileName?: string;\n",
        "    authFileId?: string;\n",
        "      authFileId: optionalText(account.authFileId, 512),\n",
        "      authFileName: optionalText(account.authFileName, 512),\n",
        "      authFileId: input.authFileId ?? previous?.authFileId,\n",
        "      authFileName: input.authFileName ?? previous?.authFileName,\n",
        "    if (Object.hasOwn(input, \"authFileId\")) account.authFileId = optionalText(input.authFileId, 512);\n",
        "    if (Object.hasOwn(input, \"authFileName\")) account.authFileName = optionalText(input.authFileName, 512);\n",
        "        authFileId: result.authFile.id,\n",
    ]:
        source = source.replace(line, "")
    path.write_text(source, encoding="utf-8")

replace_once(
    "desktop-electron/electron/provider-network.cjs",
    '''  function cpaSessionBinding(account) {
    const secret = store.accountSecret(account.id) || {};
    return {
      id: account.authFileId
        || String(secret.cpaAuthIndex ?? secret.antigravityAuthIndex ?? "").trim()
        || String(secret.cpaAuthName ?? secret.antigravityAuthName ?? "").trim()
        || null,
      name: account.authFileName
        || String(secret.cpaAuthName ?? secret.antigravityAuthName ?? "").trim()
        || null,
    };
  }
''',
    '''  function cpaSessionBinding(account) {
    const secret = store.accountSecret(account.id) || {};
    const authIndex = String(secret.cpaAuthIndex ?? secret.antigravityAuthIndex ?? "").trim() || null;
    const name = String(secret.cpaAuthName ?? secret.antigravityAuthName ?? "").trim() || null;
    return {
      id: authIndex || name,
      name,
      authIndex,
    };
  }
''',
)
replace_once(
    "desktop-electron/electron/provider-network.cjs",
    '''  function reservedCpaAuthFileIds(accountId) {
    return store.snapshot().accounts
      .filter((candidate) => candidate.id !== accountId && !candidate.archivedAt)
      .map((candidate) => candidate.authFileId)
      .filter(Boolean);
  }
''',
    '''  function reservedCpaAuthFileIds(accountId) {
    return store.snapshot().accounts
      .filter((candidate) => candidate.id !== accountId && !candidate.archivedAt)
      .flatMap((candidate) => {
        const secret = store.accountSecret(candidate.id) || {};
        return [
          String(secret.cpaAuthIndex ?? secret.antigravityAuthIndex ?? "").trim(),
          String(secret.cpaAuthName ?? secret.antigravityAuthName ?? "").trim(),
        ].filter(Boolean);
      });
  }
''',
)
replace_once(
    "desktop-electron/electron/provider-network.cjs",
    '''      credentialSource: "cpa",
      authFileId: authFile.id,
      authFileName: authFile.name,
      error: authFile.status === "connected" ? result.modelError : authFile.error,
''',
    '''      credentialSource: "cpa",
      error: authFile.status === "connected" ? result.modelError : authFile.error,
''',
)

network = ROOT / "desktop-electron/electron/provider-network.cjs"
source = network.read_text(encoding="utf-8")
old_login_binding = '''        identity: account.identity,
        boundAuthFileId: binding.id,
        reservedAuthFileIds: reservedCpaAuthFileIds(account.id),
'''
new_login_binding = '''        identity: account.identity,
        boundAuthFileId: binding.id,
        boundAuthFileName: binding.name,
        boundAuthFileIndex: binding.authIndex,
        reservedAuthFileIds: reservedCpaAuthFileIds(account.id),
'''
if source.count(old_login_binding) != 1:
    raise SystemExit(f"expected one CPA login binding anchor, found {source.count(old_login_binding)}")
source = source.replace(old_login_binding, new_login_binding, 1)
network.write_text(source, encoding="utf-8")

replace_once(
    "desktop-electron/electron/provider-network.cjs",
    '''  async function inspectCpaProviderAccount(account, adapterId) {
    const binding = cpaSessionBinding(account);
    if (!binding.id) {
      return store.updateAccountConnection(account.id, {
        status: "pending",
        loginAdapterId: adapterId,
        credentialSource: "cpa",
        models: [],
        error: "No CPA auth file is bound to this account",
      });
    }
    const result = await inspectCpaAccount({
      adapterId,
      requestJson: (pathname, options) => managementJson(account, pathname, options),
      identity: account.identity,
      boundAuthFileId: binding.id,
      reservedAuthFileIds: reservedCpaAuthFileIds(account.id),
    });
    return persistCpaBinding(account, adapterId, result);
  }
''',
    '''  async function inspectCpaProviderAccount(account, adapterId) {
    const binding = cpaSessionBinding(account);
    try {
      const result = await inspectCpaAccount({
        adapterId,
        requestJson: (pathname, options) => managementJson(account, pathname, options),
        identity: account.identity,
        boundAuthFileId: binding.id,
        boundAuthFileName: binding.name,
        boundAuthFileIndex: binding.authIndex,
        reservedAuthFileIds: reservedCpaAuthFileIds(account.id),
        requireBound: Boolean(binding.id),
      });
      return persistCpaBinding(account, adapterId, result);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!binding.id && /No available .* account exists in CPA/i.test(message)) {
        return store.updateAccountConnection(account.id, {
          status: "pending",
          loginAdapterId: adapterId,
          credentialSource: "cpa",
          models: [],
          error: "No CPA auth file is available for this account",
        });
      }
      if (binding.id && /bound CPA account is unavailable/i.test(message)) {
        return store.updateAccountConnection(account.id, {
          status: "pending",
          loginAdapterId: adapterId,
          credentialSource: "cpa",
          identity: account.identity,
          models: [],
          error: "The bound Antigravity session is unavailable; log in again",
        });
      }
      throw error;
    }
  }
''',
)

# Keep the established bilingual refresh copy while adapter selection conveys
# which CPA/native source is being refreshed.
ui = ROOT / "desktop-electron/src/features/ProviderHubSaasSurface.tsx"
source = ui.read_text(encoding="utf-8")
source = source.replace('text(language, "Refresh CPA session", "更新 CPA 工作階段")', 'text(language, "Refresh session", "更新工作階段")')
ui.write_text(source, encoding="utf-8")

# Update focused contracts for the stricter secret boundary and adapter-aware
# call shape. These are contract corrections, not production bypasses.
replace_once(
    "desktop-electron/tests/cpa-unified-oauth-catalog.test.cjs",
    '''  assert.match(source, /beginProviderLogin\\(saved\\.id, selectedLoginAdapter\\.id\\)/);
''',
    '''  assert.match(source, /beginProviderLogin\\(saved\\.id,\\s*(?:selectedLoginAdapter|adapter)\\.id\\)/);
''',
)
replace_once(
    "desktop-electron/tests/cpa-provider-login-routing.test.cjs",
    '''  assert.equal(connected.authFileId, "codex-index");
  assert.equal(connected.authFileName, "codex-user.json");
  assert.deepEqual(connected.models, ["gpt-5.6-codex"]);
  assert.equal(JSON.stringify(result.snapshot).includes("management-secret"), false);
''',
    '''  const storedBinding = controller.store.accountSecret(account.id);
  assert.equal(storedBinding.cpaAuthIndex, "codex-index");
  assert.equal(storedBinding.cpaAuthName, "codex-user.json");
  assert.deepEqual(connected.models, ["gpt-5.6-codex"]);
  assert.equal(JSON.stringify(result.snapshot).includes("management-secret"), false);
  assert.equal(JSON.stringify(result.snapshot).includes("codex-index"), false);
  assert.equal(JSON.stringify(result.snapshot).includes("codex-user.json"), false);
''',
)
replace_once(
    "desktop-electron/tests/cpa-provider-login-routing.test.cjs",
    '''  assert.equal(connected.status, "connected");
  assert.equal(connected.authFileName, "gemini-user.json");
''',
    '''  assert.equal(connected.status, "connected");
  const storedBinding = controller.store.accountSecret(account.id);
  assert.equal(storedBinding.cpaAuthName, "gemini-user.json");
  assert.equal(JSON.stringify(result.snapshot).includes("gemini-user.json"), false);
''',
)
replace_once(
    "desktop-electron/tests/antigravity-provider-session.test.cjs",
    '''  assert.match(bootstrap, /active\\.openProviderLogin\\(accountId\\)/);
''',
    '''  assert.match(bootstrap, /active\\.openProviderLogin\\(accountId(?:,\\s*adapterId)?\\)/);
''',
)

print("RC9_CPA_REGRESSION_REPAIRS_OK")
