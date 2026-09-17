from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
TARGET = ROOT / "desktop-electron/electron/provider-network.cjs"


def replace_once(before: str, after: str) -> None:
    text = TARGET.read_text(encoding="utf-8")
    if after in text:
        return
    if before not in text:
        raise SystemExit(f"Antigravity edge-case anchor missing: {before[:160]!r}")
    TARGET.write_text(text.replace(before, after, 1), encoding="utf-8")


replace_once(
    '''function providerModelIds(value) {
''',
    '''function antigravityAuthFileName(entry) {
  const value = String(entry?.name ?? entry?.id ?? "").trim();
  return value || null;
}

function providerModelIds(value) {
''',
)

replace_once(
    '''  async function inspectAntigravitySession(account) {
''',
    '''  async function inspectAntigravitySession(account, { baselineAuthNames = new Set() } = {}) {
''',
)

replace_once(
    '''    const identity = String(account.identity || "").trim().toLowerCase();
    const selected = files.find((entry) => {
      const candidate = String(entry.email ?? entry.label ?? "").trim().toLowerCase();
      return identity && candidate === identity;
    }) ?? files.find((entry) => entry.disabled !== true) ?? files[0];
    const detail = `${selected.status ?? ""} ${selected.status_message ?? ""}`.trim();
    let status = "connected";
    if (selected.disabled === true) status = "disabled";
    else if (selected.unavailable === true || providerSessionFailureStatus(detail) === "expired") status = "expired";
    else if (/error|failed|invalid/i.test(detail)) status = "error";
''',
    '''    const identity = String(account.identity || "").trim().toLowerCase();
    const newlyCreated = files.find((entry) => {
      const name = antigravityAuthFileName(entry);
      return name && !baselineAuthNames.has(name);
    });
    const selected = files.find((entry) => {
      const candidate = String(entry.email ?? entry.label ?? "").trim().toLowerCase();
      return identity && candidate === identity;
    }) ?? newlyCreated ?? files.find((entry) => entry.disabled !== true) ?? files[0];
    const detail = `${selected.status ?? ""} ${selected.status_message ?? ""}`.trim();
    let status = "connected";
    if (selected.disabled === true) status = "disabled";
    else if (providerSessionFailureStatus(detail) === "expired") status = "expired";
    else if (selected.unavailable === true || /error|failed|invalid/i.test(detail)) status = "error";
''',
)

replace_once(
    '''    if (account.providerId === ANTIGRAVITY_PROVIDER_ID) {
      store.updateAccountConnection(account.id, { status: "pending", error: undefined });
''',
    '''    if (account.providerId === ANTIGRAVITY_PROVIDER_ID) {
      let baselineAuthNames = new Set();
      try {
        const baseline = await managementJson(account, "/v0/management/auth-files");
        baselineAuthNames = new Set(
          antigravityAuthFiles(baseline)
            .map(antigravityAuthFileName)
            .filter(Boolean),
        );
      } catch (error) {
        logger.warn("provider.antigravity_baseline_failed", {
          accountId: account.id,
          error: error instanceof Error ? error.message : String(error),
        });
      }
      store.updateAccountConnection(account.id, { status: "pending", error: undefined });
''',
)

replace_once(
    '''            snapshot: await inspectAntigravitySession(accountRecord(account.id)),
''',
    '''            snapshot: await inspectAntigravitySession(accountRecord(account.id), {
              baselineAuthNames,
            }),
''',
)

print("ANTIGRAVITY_EDGE_CASES_APPLIED")
