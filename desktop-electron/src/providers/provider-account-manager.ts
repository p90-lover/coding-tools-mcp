import type { ProviderAuth } from "./provider-types";

export type ProviderAccountStatus =
  | "pending"
  | "connected"
  | "expired"
  | "error"
  | "disabled";

export interface ProviderAccount {
  id: string;
  providerId: string;
  label: string;
  identity?: string;
  auth: ProviderAuth;
  status: ProviderAccountStatus;
  enabled: boolean;
  isDefault: boolean;
  models: string[];
  proxyProfileId?: string;
  createdAt: string;
  updatedAt: string;
  lastUsedAt?: string;
  archivedAt?: string;
  error?: string;
}

export interface ProviderAccountState {
  version: 1;
  accounts: ProviderAccount[];
  autoRotate: boolean;
}

export interface ProviderAccountInput {
  id: string;
  providerId: string;
  label: string;
  identity?: string;
  auth: ProviderAuth;
  status?: ProviderAccountStatus;
  enabled?: boolean;
  isDefault?: boolean;
  models?: string[];
  proxyProfileId?: string;
  createdAt?: string;
  updatedAt?: string;
  lastUsedAt?: string;
  archivedAt?: string;
  error?: string;
}

function requiredText(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`${label} is required`);
  if (normalized.length > 160) throw new Error(`${label} is too long`);
  return normalized;
}

function optionalText(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized || undefined;
}

function normalizedModels(models: readonly string[] | undefined): string[] {
  return [...new Set((models ?? [])
    .map((model) => model.trim())
    .filter(Boolean))]
    .slice(0, 128);
}

function usable(account: ProviderAccount): boolean {
  return account.enabled
    && !account.archivedAt
    && account.status === "connected";
}

function normalizeDefaults(accounts: ProviderAccount[]): ProviderAccount[] {
  const chosen = new Map<string, string>();
  for (const account of accounts) {
    if (usable(account) && account.isDefault) chosen.set(account.providerId, account.id);
  }

  for (const account of accounts) {
    if (!chosen.has(account.providerId) && usable(account)) {
      chosen.set(account.providerId, account.id);
    }
  }

  return accounts.map((account) => ({
    ...account,
    isDefault: usable(account) && chosen.get(account.providerId) === account.id,
  }));
}

function cloneState(state: ProviderAccountState): ProviderAccountState {
  return {
    version: 1,
    autoRotate: state.autoRotate !== false,
    accounts: state.accounts.map((account) => ({
      ...account,
      models: [...account.models],
    })),
  };
}

export function createProviderAccountState(
  accounts: readonly ProviderAccount[] = [],
  autoRotate = true,
): ProviderAccountState {
  return {
    version: 1,
    autoRotate,
    accounts: normalizeDefaults(accounts.map((account) => ({
      ...account,
      id: requiredText(account.id, "Account ID"),
      providerId: requiredText(account.providerId, "Provider ID"),
      label: requiredText(account.label, "Account label"),
      identity: optionalText(account.identity),
      enabled: account.enabled !== false,
      isDefault: account.isDefault === true,
      models: normalizedModels(account.models),
    }))),
  };
}

export function upsertProviderAccount(
  state: ProviderAccountState,
  input: ProviderAccountInput,
  now = new Date().toISOString(),
): ProviderAccountState {
  const next = cloneState(state);
  const id = requiredText(input.id, "Account ID");
  const providerId = requiredText(input.providerId, "Provider ID");
  const index = next.accounts.findIndex((account) => account.id === id);
  const previous = index >= 0 ? next.accounts[index] : undefined;
  if (previous && previous.providerId !== providerId) {
    throw new Error("An account cannot move between providers");
  }

  const account: ProviderAccount = {
    id,
    providerId,
    label: requiredText(input.label, "Account label"),
    identity: optionalText(input.identity),
    auth: input.auth,
    status: input.status ?? previous?.status ?? "pending",
    enabled: input.enabled ?? previous?.enabled ?? true,
    isDefault: input.isDefault ?? previous?.isDefault ?? false,
    models: normalizedModels(input.models ?? previous?.models),
    proxyProfileId: optionalText(input.proxyProfileId ?? previous?.proxyProfileId),
    createdAt: previous?.createdAt ?? input.createdAt ?? now,
    updatedAt: input.updatedAt ?? now,
    lastUsedAt: input.lastUsedAt ?? previous?.lastUsedAt,
    archivedAt: input.archivedAt ?? previous?.archivedAt,
    error: optionalText(input.error),
  };

  if (account.archivedAt) {
    account.enabled = false;
    account.isDefault = false;
    account.status = "disabled";
  }
  if (!account.enabled) {
    account.isDefault = false;
    if (account.status === "connected") account.status = "disabled";
  }

  if (index >= 0) next.accounts[index] = account;
  else next.accounts.push(account);

  if (account.isDefault && usable(account)) {
    for (const sibling of next.accounts) {
      if (sibling.providerId === providerId && sibling.id !== account.id) sibling.isDefault = false;
    }
  }
  next.accounts = normalizeDefaults(next.accounts);
  return next;
}

export function setDefaultProviderAccount(
  state: ProviderAccountState,
  providerId: string,
  accountId: string,
): ProviderAccountState {
  const next = cloneState(state);
  const selected = next.accounts.find((account) => account.id === accountId);
  if (!selected || selected.providerId !== providerId) {
    throw new Error("Provider account was not found");
  }
  if (!usable(selected)) throw new Error("Only a connected account can be the default");

  next.accounts = next.accounts.map((account) => ({
    ...account,
    isDefault: account.providerId === providerId
      ? account.id === accountId
      : account.isDefault,
  }));
  return next;
}

export function setProviderAccountEnabled(
  state: ProviderAccountState,
  accountId: string,
  enabled: boolean,
  now = new Date().toISOString(),
): ProviderAccountState {
  const next = cloneState(state);
  const index = next.accounts.findIndex((account) => account.id === accountId);
  if (index < 0) throw new Error("Provider account was not found");
  const account = next.accounts[index];
  if (account.archivedAt && enabled) throw new Error("Archived accounts cannot be enabled");
  next.accounts[index] = {
    ...account,
    enabled,
    isDefault: enabled ? account.isDefault : false,
    status: enabled && account.status === "disabled" ? "pending" : enabled ? account.status : "disabled",
    updatedAt: now,
  };
  next.accounts = normalizeDefaults(next.accounts);
  return next;
}

export function archiveProviderAccount(
  state: ProviderAccountState,
  accountId: string,
  now = new Date().toISOString(),
): ProviderAccountState {
  const next = cloneState(state);
  const index = next.accounts.findIndex((account) => account.id === accountId);
  if (index < 0) throw new Error("Provider account was not found");
  const account = next.accounts[index];
  next.accounts[index] = {
    ...account,
    enabled: false,
    isDefault: false,
    status: "disabled",
    archivedAt: now,
    updatedAt: now,
  };
  next.accounts = normalizeDefaults(next.accounts);
  return next;
}

export function selectProviderAccount(
  state: ProviderAccountState,
  providerId: string,
  preferredAccountId?: string,
): ProviderAccount | null {
  const candidates = state.accounts.filter((account) => (
    account.providerId === providerId && usable(account)
  ));
  if (preferredAccountId) {
    const preferred = candidates.find((account) => account.id === preferredAccountId);
    if (preferred) return { ...preferred, models: [...preferred.models] };
  }
  const selected = candidates.find((account) => account.isDefault)
    ?? candidates.sort((left, right) => {
      const used = (right.lastUsedAt ?? "").localeCompare(left.lastUsedAt ?? "");
      return used || left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id);
    })[0];
  return selected ? { ...selected, models: [...selected.models] } : null;
}
