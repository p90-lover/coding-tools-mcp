from __future__ import annotations

from pathlib import Path

ROOT = Path.cwd()
PAYLOAD = Path(__file__).resolve().parent / "payload"


def replace_once(path: Path, before: str, after: str) -> None:
    text = path.read_text(encoding="utf-8")
    if after in text:
        print(f"already patched: {path}")
        return
    if before not in text:
        raise SystemExit(f"required patch anchor missing in {path}: {before[:160]!r}")
    path.write_text(text.replace(before, after, 1), encoding="utf-8")
    print(f"patched: {path}")


def materialize(relative: str) -> None:
    source = PAYLOAD / relative
    destination = ROOT / relative
    destination.parent.mkdir(parents=True, exist_ok=True)
    content = source.read_bytes()
    if destination.exists() and destination.read_bytes() == content:
        print(f"already current: {destination}")
        return
    destination.write_bytes(content)
    print(f"materialized: {destination}")


def patch_provider_network() -> None:
    path = ROOT / "desktop-electron/electron/provider-network.cjs"
    replace_once(
        path,
        '''function normalizeModels(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value
    .filter((item) => typeof item === "string")
    .map((item) => item.trim())
    .filter(Boolean))]
    .slice(0, 128);
}

function normalizeBypass(value) {''',
        '''function normalizeModels(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value
    .filter((item) => typeof item === "string")
    .map((item) => item.trim())
    .filter(Boolean))]
    .slice(0, 128);
}

function secretHasCredential(secret) {
  if (!secret || typeof secret !== "object" || Array.isArray(secret)) return false;
  return ["apiKey", "accessToken", "token", "credential"].some((key) => (
    typeof secret[key] === "string" && secret[key].trim().length > 0
  ));
}

function normalizeBypass(value) {''',
    )
    replace_once(
        path,
        '''  function publicSnapshot() {
    return {
      version: STORE_VERSION,
      accounts: clone(state.accounts),
      proxyProfiles: state.proxyProfiles.map((profile) => ({ ...clone(profile) })),''',
        '''  function accountCredentialPresent(account) {
    if (account.auth !== "api_key") return account.status === "connected";
    return secretHasCredential(codec.decrypt(state.secrets.accounts[account.id]));
  }

  function publicSnapshot() {
    return {
      version: STORE_VERSION,
      accounts: state.accounts.map((account) => ({
        ...clone(account),
        hasCredential: accountCredentialPresent(account),
      })),
      proxyProfiles: state.proxyProfiles.map((profile) => ({ ...clone(profile) })),''',
    )
    replace_once(
        path,
        '''    const statusInput = input.status ?? previous?.status;
    const status = ACCOUNT_STATUS.has(statusInput)
      ? statusInput
      : suppliedSecret ? "connected" : "pending";
    const account = normalizeAccount({''',
        '''    const statusInput = input.status ?? previous?.status;
    const requestedStatus = ACCOUNT_STATUS.has(statusInput)
      ? statusInput
      : suppliedSecret ? "connected" : "pending";
    const credentialPresent = auth !== "api_key"
      || secretHasCredential(codec.decrypt(state.secrets.accounts[id]));
    const status = requestedStatus === "connected" && !credentialPresent
      ? "pending"
      : requestedStatus;
    const account = normalizeAccount({''',
    )
    replace_once(
        path,
        '''    } else if (account.status === "disabled") {
      account.status = state.secrets.accounts[account.id] ? "connected" : "pending";
    }''',
        '''    } else if (account.status === "disabled") {
      account.status = account.auth === "api_key" && !accountCredentialPresent(account)
        ? "pending"
        : "connected";
    }''',
    )
    replace_once(
        path,
        '''    state.routing.accounts = [
      ...state.routing.accounts.filter((item) => item.accountId !== accountId),
      policy,
    ];
    write();''',
        '''    state.routing.accounts = [
      ...state.routing.accounts.filter((item) => item.accountId !== accountId),
      policy,
    ];
    account.proxyProfileId = undefined;
    account.updatedAt = new Date().toISOString();
    write();''',
    )


def patch_types() -> None:
    path = ROOT / "desktop-electron/src/types.ts"
    replace_once(
        path,
        '''  models: string[];
  proxyProfileId?: string;''',
        '''  models: string[];
  hasCredential?: boolean;
  proxyProfileId?: string;''',
    )


def main() -> None:
    materialize("desktop-electron/electron/provider-execution-router.cjs")
    patch_provider_network()
    patch_types()
    print("PROVIDER_PLANNER_SAFETY_PATCH_OK")


if __name__ == "__main__":
    main()
