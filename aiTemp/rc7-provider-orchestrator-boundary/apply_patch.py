from __future__ import annotations

from pathlib import Path


def replace_once(pathname: str, old: str, new: str) -> None:
    path = Path(pathname)
    text = path.read_text(encoding="utf-8")
    if new in text:
        return
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"expected one anchor in {pathname}, found {count}: {old[:80]!r}")
    path.write_text(text.replace(old, new, 1), encoding="utf-8")


# Keep provider API/OAuth secrets inside the provider vault.  The local
# Paseo/Anneal control plane receives only its own explicit credential.
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

# Bound the renderer-to-main control credential independently of provider
# account credentials.  It remains request-only and is rejected from responses.
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

# Provider Hub exposes an ephemeral, bilingual orchestrator credential field.
# It is never persisted with provider accounts and is cleared after use or when
# the user changes the selected provider/account.
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

# Update the regression contract to the canonical Codex Router identity and
# verify the typed API surface as well as both orchestrator admission flags.
test_path = Path("desktop-electron/tests/provider-orchestrator-credential-boundary.test.cjs")
test_path.write_text('''"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const desktopRoot = path.resolve(__dirname, "..");
const read = (relativePath) => fs.readFileSync(path.join(desktopRoot, relativePath), "utf8");

function executionProviderHandler(source) {
  const start = source.indexOf('handle("coding-tools:execution:provider"');
  const end = source.indexOf('handle("coding-tools:execution:update"', start);
  assert.ok(start >= 0 && end > start, "execution provider IPC handler is missing");
  return source.slice(start, end);
}

test("provider account secrets never become Paseo or Anneal control-plane credentials", () => {
  const handler = executionProviderHandler(read("electron/main.cjs"));

  assert.doesNotMatch(handler, /accountSecret\\(/, "provider vault secret must not leave the provider boundary");
  assert.doesNotMatch(handler, /storedProviderCredential\\(/, "provider secret extraction must not feed orchestration auth");
  assert.match(handler, /controlCredential/);
  assert.match(handler, /credential:\\s*controlCredential/);
});

test("execution IPC and typed API declare a separate bounded control-plane credential", () => {
  const schema = read("electron/ipc-schema.cjs");
  const contracts = read("src/api/contracts.ts");
  assert.match(schema, /controlCredential:\\s*Object\\.freeze\\(\\{\\s*type:\\s*"string"/);
  assert.match(schema, /controlCredential[^\\n]*maxLength:\\s*8192/);
  assert.match(contracts, /readonly controlCredential\\?: string/);
});

test("Provider Hub keeps provider and orchestrator credentials in separate controls", () => {
  const source = read("src/features/ProviderHubSaasSurface.tsx");

  assert.match(source, /const \\[controlCredential, setControlCredential\\] = useState\\(""\\)/);
  assert.match(source, /controlCredential:\\s*controlCredential\\.trim\\(\\)/);
  assert.match(source, /Paseo \\/ Anneal control credential/);
  assert.match(source, /Paseo／Anneal 控制憑證/);
  assert.match(source, /maxLength=\\{8192\\}/);
  assert.doesNotMatch(source, /controlCredential:\\s*secret/);
});

test("the routed provider set covers Codex Router, CPA Antigravity, and CommandCode", () => {
  const router = require(path.join(desktopRoot, "electron", "provider-execution-router.cjs"));
  for (const providerId of [
    "codex-oauth",
    "cliproxyapi-antigravity",
    "commandcode-proxy",
  ]) {
    const provider = router.PROVIDER_EXECUTION_CATALOG.find((candidate) => candidate.id === providerId);
    assert.ok(provider, `missing routed provider ${providerId}`);
    assert.equal(provider.paseoEnabled, true, `${providerId} must support Paseo`);
    assert.equal(provider.annealEnabled, true, `${providerId} must support Anneal`);
  }
});
''', encoding="utf-8")

print("RC7_PROVIDER_ORCHESTRATOR_BOUNDARY_PATCH_OK")
