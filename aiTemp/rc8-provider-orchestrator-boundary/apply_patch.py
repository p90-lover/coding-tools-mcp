from __future__ import annotations

from pathlib import Path


def replace_once(pathname: str, old: str, new: str) -> None:
    path = Path(pathname)
    text = path.read_text(encoding="utf-8")
    if new and new in text:
        return
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"expected one anchor in {pathname}, found {count}: {old[:100]!r}")
    path.write_text(text.replace(old, new, 1), encoding="utf-8")


# Provider API/OAuth credentials belong to the encrypted provider vault. They
# are not Paseo or Anneal control-plane bearer tokens.
replace_once(
    "desktop-electron/electron/main.cjs",
    '''function storedProviderCredential(secret) {
  if (!secret || typeof secret !== "object") return "";
  for (const key of ["apiKey", "token", "credential", "password"]) {
    const value = secret[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

function accountNeedsStoredCredential(auth) {
  return auth === "api_key" || auth === "local_proxy";
}

''',
    "",
)
replace_once(
    "desktop-electron/electron/main.cjs",
    '''    let settings = input.settings;
    let credential = "";
''',
    '''    let settings = input.settings;
    const controlCredential = typeof input.controlCredential === "string"
      ? input.controlCredential.trim()
      : "";
''',
)
replace_once(
    "desktop-electron/electron/main.cjs",
    '''      const secret = providerNetwork.store.accountSecret(plan.account.id);
      credential = storedProviderCredential(secret);
      if (accountNeedsStoredCredential(plan.account.auth) && !credential) {
        throw new Error(`Provider account ${plan.account.id} has no usable stored credential`);
      }
''',
    "",
)
replace_once(
    "desktop-electron/electron/main.cjs",
    '''      settings: executionSettingsPayload(settings),
      credential,
      confirm: input.confirm === true,
''',
    '''      settings: executionSettingsPayload(settings),
      credential: controlCredential,
      confirm: input.confirm === true,
''',
)

# The renderer can submit a bounded request-only local orchestrator credential.
# Sensitive response filtering already rejects this field from responses.
replace_once(
    "desktop-electron/electron/ipc-schema.cjs",
    '''    providerAccountId: Object.freeze({ type: "string", minLength: 1, maxLength: 160, nullable: true }),
    allowProviderFallback: Object.freeze({ type: "boolean" }),
    confirm: Object.freeze({ type: "boolean" }),
''',
    '''    providerAccountId: Object.freeze({ type: "string", minLength: 1, maxLength: 160, nullable: true }),
    allowProviderFallback: Object.freeze({ type: "boolean" }),
    controlCredential: Object.freeze({ type: "string", maxLength: 8192 }),
    confirm: Object.freeze({ type: "boolean" }),
''',
)
replace_once(
    "desktop-electron/src/api/contracts.ts",
    '''      readonly providerAccountId?: string | null;
      readonly allowProviderFallback?: boolean;
      readonly confirm: boolean;
''',
    '''      readonly providerAccountId?: string | null;
      readonly allowProviderFallback?: boolean;
      readonly controlCredential?: string;
      readonly confirm: boolean;
''',
)

# Provider Hub keeps the local orchestrator token ephemeral and distinct from
# provider account secrets. It is cleared when selection changes and after a
# successful binding operation.
replace_once(
    "desktop-electron/src/features/ProviderHubSaasSurface.tsx",
    '''  const [secret, setSecret] = useState("");
  const [selectedModel, setSelectedModel] = useState("");
''',
    '''  const [secret, setSecret] = useState("");
  const [controlCredential, setControlCredential] = useState("");
  const [selectedModel, setSelectedModel] = useState("");
''',
)
replace_once(
    "desktop-electron/src/features/ProviderHubSaasSurface.tsx",
    '''  const selectProvider = (providerId: string) => {
    setSelectedProviderId(providerId);
    setEditorOpen(false);
    setNotice("");
''',
    '''  const selectProvider = (providerId: string) => {
    setSelectedProviderId(providerId);
    setEditorOpen(false);
    setNotice("");
    setControlCredential("");
''',
)
replace_once(
    "desktop-electron/src/features/ProviderHubSaasSurface.tsx",
    '''  const selectAccount = (account: ProviderAccountRecord) => {
    setSelectedProviderId(account.providerId);
''',
    '''  const selectAccount = (account: ProviderAccountRecord) => {
    setControlCredential("");
    setSelectedProviderId(account.providerId);
''',
)
replace_once(
    "desktop-electron/src/features/ProviderHubSaasSurface.tsx",
    '''  const startNewAccount = (providerId = selectedProviderId) => {
    const provider = providerDefinition(providerId);
''',
    '''  const startNewAccount = (providerId = selectedProviderId) => {
    setControlCredential("");
    const provider = providerDefinition(providerId);
''',
)
replace_once(
    "desktop-electron/src/features/ProviderHubSaasSurface.tsx",
    '''        providerAccountId: selectedAccount.id,
        allowProviderFallback,
        settings: {
''',
    '''        providerAccountId: selectedAccount.id,
        allowProviderFallback,
        controlCredential: controlCredential.trim(),
        settings: {
''',
)
replace_once(
    "desktop-electron/src/features/ProviderHubSaasSurface.tsx",
    '''      await refreshBindings();
      setNotice(text(
''',
    '''      await refreshBindings();
      setControlCredential("");
      setNotice(text(
''',
)
replace_once(
    "desktop-electron/src/features/ProviderHubSaasSurface.tsx",
    '''                    <label>
                      <span>{text(language, "Engine endpoint", "引擎端點")}</span>
                      <input value={engineEndpoint} onChange={(event) => setEngineEndpoint(event.target.value)} />
                    </label>
                    <label>
                      <span>{text(language, "Mode", "模式")}</span>
''',
    '''                    <label>
                      <span>{text(language, "Engine endpoint", "引擎端點")}</span>
                      <input value={engineEndpoint} onChange={(event) => setEngineEndpoint(event.target.value)} />
                    </label>
                    <label className="provider-full-row">
                      <span>{text(language, "Paseo / Anneal control credential", "Paseo／Anneal 控制憑證")}</span>
                      <input
                        autoComplete="off"
                        maxLength={8192}
                        onChange={(event) => setControlCredential(event.target.value)}
                        placeholder={text(
                          language,
                          "Optional local orchestrator token — never the provider API/OAuth secret",
                          "選填本機協調器 Token——絕不可使用供應商 API／OAuth 憑證",
                        )}
                        type="password"
                        value={controlCredential}
                      />
                      <small>{text(
                        language,
                        "Used only to authenticate the Paseo or Anneal control plane for this connection.",
                        "只用於今次連線的 Paseo 或 Anneal 控制平面驗證。",
                      )}</small>
                    </label>
                    <label>
                      <span>{text(language, "Mode", "模式")}</span>
''',
)

print("RC8_PROVIDER_ORCHESTRATOR_BOUNDARY_PATCH_OK")
