from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
TARGET = ROOT / "desktop-electron/electron/provider-network.cjs"

text = TARGET.read_text(encoding="utf-8")
changed = False


def replace_once(before: str, after: str, label: str) -> None:
    global text, changed
    if after in text:
        return
    if before not in text:
        raise SystemExit(f"Missing Antigravity binding anchor: {label}")
    text = text.replace(before, after, 1)
    changed = True


replace_once(
    '''    if (suppliedSecret && Object.keys(suppliedSecret).length > 0) {
      state.secrets.accounts[id] = codec.encrypt(suppliedSecret);
    }
''',
    '''    if (suppliedSecret && Object.keys(suppliedSecret).length > 0) {
      const previousSecret = codec.decrypt(state.secrets.accounts[id]) || {};
      state.secrets.accounts[id] = codec.encrypt({
        ...previousSecret,
        ...suppliedSecret,
      });
    }
''',
    "preserve encrypted session metadata when credentials are edited",
)

replace_once(
    '''  function accountSecret(accountId) {
    return codec.decrypt(state.secrets.accounts[accountId]);
  }

  function proxySecret(profileId) {
''',
    '''  function accountSecret(accountId) {
    return codec.decrypt(state.secrets.accounts[accountId]);
  }

  function mergeAccountSecret(accountId, patch = {}) {
    const account = findAccount(accountId);
    if (!account || account.archivedAt) throw new Error("Provider account was not found");
    const current = accountSecret(accountId) || {};
    for (const key of ["antigravityAuthName", "antigravityAuthIndex"]) {
      if (!Object.hasOwn(patch, key)) continue;
      const value = optionalText(patch[key], 512);
      if (value) current[key] = value;
      else delete current[key];
    }
    state.secrets.accounts[accountId] = codec.encrypt(current);
    write();
  }

  function proxySecret(profileId) {
''',
    "add encrypted account-session metadata merge",
)

replace_once(
    '''    recordProxyHealth,
    accountSecret,
    proxySecret,
''',
    '''    recordProxyHealth,
    accountSecret,
    mergeAccountSecret,
    proxySecret,
''',
    "expose internal session metadata merge",
)

replace_once(
    '''function antigravityAuthFileName(entry) {
  const value = String(entry?.name ?? entry?.id ?? "").trim();
  return value || null;
}

function providerModelIds(value) {
''',
    '''function antigravityAuthFileName(entry) {
  const value = String(entry?.name ?? entry?.id ?? "").trim();
  return value || null;
}

function antigravityAuthIndex(entry) {
  const value = String(entry?.auth_index ?? entry?.authIndex ?? "").trim();
  return value || null;
}

function antigravityIdentity(entry) {
  const value = String(entry?.email ?? entry?.account ?? entry?.label ?? "").trim();
  return value || null;
}

function providerModelIds(value) {
''',
    "add stable auth identity helpers",
)

replace_once(
    '''    return { baseUrl, managementKey };
  }

  async function managementJson(account, pathname) {
''',
    '''    return { baseUrl, managementKey };
  }

  function antigravitySessionBinding(account) {
    const secret = store.accountSecret(account.id) || {};
    return {
      name: String(secret.antigravityAuthName ?? "").trim() || null,
      authIndex: String(secret.antigravityAuthIndex ?? "").trim() || null,
    };
  }

  async function managementJson(account, pathname) {
''',
    "read encrypted Antigravity session binding",
)

if "const binding = antigravitySessionBinding(account);" not in text:
    start = text.find("  async function inspectAntigravitySession(")
    end = text.find("\n  async function probeProviderAccount", start)
    if start < 0 or end < 0:
        raise SystemExit("Missing Antigravity session inspection function")
    replacement = '''  async function inspectAntigravitySession(
    account,
    { baselineAuthNames = new Set(), baselineAuthIndexes = new Set() } = {},
  ) {
    const binding = antigravitySessionBinding(account);
    const query = new URLSearchParams();
    if (binding.name) query.set("name", binding.name);
    if (binding.authIndex) query.set("auth_index", binding.authIndex);
    const pathname = query.size > 0
      ? `/v0/management/auth-files?${query.toString()}`
      : "/v0/management/auth-files";
    const listing = await managementJson(account, pathname);
    const files = antigravityAuthFiles(listing);
    if (files.length === 0) {
      return store.updateAccountConnection(account.id, {
        status: "pending",
        models: [],
        error: binding.name || binding.authIndex
          ? "The bound Antigravity session is unavailable; log in again"
          : undefined,
      });
    }

    const exactBound = files.find((entry) => (
      (binding.authIndex && antigravityAuthIndex(entry) === binding.authIndex)
        || (binding.name && antigravityAuthFileName(entry) === binding.name)
    ));
    if ((binding.name || binding.authIndex) && !exactBound) {
      return store.updateAccountConnection(account.id, {
        status: "pending",
        models: [],
        error: "The bound Antigravity session is unavailable; log in again",
      });
    }

    const identity = String(account.identity || "").trim().toLowerCase();
    const newlyCreated = files.find((entry) => {
      const name = antigravityAuthFileName(entry);
      const authIndex = antigravityAuthIndex(entry);
      return (name && !baselineAuthNames.has(name))
        || (authIndex && !baselineAuthIndexes.has(authIndex));
    });
    const selected = exactBound ?? files.find((entry) => {
      const candidate = String(antigravityIdentity(entry) || "").toLowerCase();
      return identity && candidate === identity;
    }) ?? newlyCreated ?? files.find((entry) => {
      const detail = `${entry.status ?? ""} ${entry.status_message ?? ""}`.trim();
      return entry.disabled !== true
        && entry.unavailable !== true
        && providerSessionFailureStatus(detail) !== "expired"
        && !/error|failed|invalid/i.test(detail);
    }) ?? files.find((entry) => entry.disabled !== true) ?? files[0];

    const selectedName = antigravityAuthFileName(selected);
    const selectedAuthIndex = antigravityAuthIndex(selected);
    store.mergeAccountSecret(account.id, {
      antigravityAuthName: selectedName,
      antigravityAuthIndex: selectedAuthIndex,
    });

    const detail = `${selected.status ?? ""} ${selected.status_message ?? ""}`.trim();
    let status = "connected";
    if (selected.disabled === true) status = "disabled";
    else if (providerSessionFailureStatus(detail) === "expired") status = "expired";
    else if (selected.unavailable === true || /error|failed|invalid/i.test(detail)) status = "error";

    let models = Array.isArray(account.models) ? account.models : [];
    let modelError;
    if (status === "connected" && selectedName) {
      try {
        const catalogue = await managementJson(
          account,
          `/v0/management/auth-files/models?name=${encodeURIComponent(selectedName)}`,
        );
        const discovered = providerModelIds(catalogue);
        if (discovered.length > 0) models = discovered;
      } catch (error) {
        modelError = error instanceof Error ? error.message : String(error);
      }
    }

    return store.updateAccountConnection(account.id, {
      status,
      identity: antigravityIdentity(selected) ?? account.identity,
      models,
      error: status === "connected" ? modelError : (selected.status_message || detail || undefined),
    });
  }
'''
    text = text[:start] + replacement + text[end:]
    changed = True

replace_once(
    '''      let baselineAuthNames = new Set();
      try {
        const baseline = await managementJson(account, "/v0/management/auth-files");
        baselineAuthNames = new Set(
          antigravityAuthFiles(baseline)
            .map(antigravityAuthFileName)
            .filter(Boolean),
        );
''',
    '''      let baselineAuthNames = new Set();
      let baselineAuthIndexes = new Set();
      try {
        const baseline = await managementJson(account, "/v0/management/auth-files");
        const baselineFiles = antigravityAuthFiles(baseline);
        baselineAuthNames = new Set(
          baselineFiles.map(antigravityAuthFileName).filter(Boolean),
        );
        baselineAuthIndexes = new Set(
          baselineFiles.map(antigravityAuthIndex).filter(Boolean),
        );
''',
    "record auth indexes before login",
)

replace_once(
    '''            snapshot: await inspectAntigravitySession(accountRecord(account.id), {
              baselineAuthNames,
            }),
''',
    '''            snapshot: await inspectAntigravitySession(accountRecord(account.id), {
              baselineAuthNames,
              baselineAuthIndexes,
            }),
''',
    "pass baseline auth indexes after login",
)

if changed:
    TARGET.write_text(text, encoding="utf-8")
    print("ANTIGRAVITY_SESSION_BINDING_PATCH_APPLIED")
else:
    print("ANTIGRAVITY_SESSION_BINDING_PATCH_ALREADY_APPLIED")
