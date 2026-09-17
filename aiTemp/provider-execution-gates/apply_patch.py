from __future__ import annotations

from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


def replace_once(relative: str, old: str, new: str) -> None:
    path = ROOT / relative
    text = path.read_text(encoding="utf-8")
    if new in text and old not in text:
        print(f"already patched: {relative}")
        return
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"expected exactly one match in {relative}, found {count}: {old[:100]!r}")
    path.write_text(text.replace(old, new, 1), encoding="utf-8")
    print(f"patched: {relative}")


replace_once(
    "desktop-electron/electron/provider-network.cjs",
    '''function accountUsable(account) {
  return account.enabled && !account.archivedAt && account.status === "connected";
}
''',
    '''function requiresStoredCredential(auth) {
  return auth === "api_key" || auth === "local_proxy";
}

function accountUsable(account) {
  return account.enabled && !account.archivedAt && account.status === "connected";
}
''',
)

replace_once(
    "desktop-electron/electron/provider-network.cjs",
    '''      accounts: clone(state.accounts),
''',
    '''      accounts: state.accounts.map((account) => ({
        ...clone(account),
        hasCredential: Boolean(state.secrets.accounts[account.id]),
      })),
''',
)

replace_once(
    "desktop-electron/electron/provider-network.cjs",
    '''    const statusInput = input.status ?? previous?.status;
    const status = ACCOUNT_STATUS.has(statusInput)
      ? statusInput
      : suppliedSecret ? "connected" : "pending";
''',
    '''    const hasCredential = Boolean(state.secrets.accounts[id]);
    const statusInput = input.status ?? previous?.status;
    let status = ACCOUNT_STATUS.has(statusInput)
      ? statusInput
      : suppliedSecret ? "connected" : "pending";
    if (status === "connected" && requiresStoredCredential(auth) && !hasCredential) {
      status = "pending";
    }
''',
)

replace_once(
    "desktop-electron/electron/provider-network.cjs",
    '''    if (!accountUsable(account)) throw new Error("Only a connected account can be the default");
''',
    '''    if (!accountUsable(account)
      || (requiresStoredCredential(account.auth) && !state.secrets.accounts[account.id])) {
      throw new Error("Only a connected account with its required credential can be the default");
    }
''',
)

replace_once(
    "desktop-electron/electron/provider-network.cjs",
    '''    } else if (account.status === "disabled") {
      account.status = state.secrets.accounts[account.id] ? "connected" : "pending";
    }
''',
    '''    } else if (account.status === "disabled") {
      account.status = requiresStoredCredential(account.auth) && !state.secrets.accounts[account.id]
        ? "pending"
        : "connected";
    }
''',
)

replace_once(
    "desktop-electron/electron/main.cjs",
    '''const { createUpdateController } = require("./update.cjs");
''',
    '''const { createUpdateController } = require("./update.cjs");
const { providerNetworkReady } = require("./provider-bootstrap.cjs");
const { createProviderExecutionPlan } = require("./provider-execution-router.cjs");
''',
)

replace_once(
    "desktop-electron/electron/main.cjs",
    '''function registerIpc({ logger, stateStore }) {
''',
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

function registerIpc({ logger, stateStore }) {
''',
)

replace_once(
    "desktop-electron/electron/main.cjs",
    '''  handle("coding-tools:execution:provider", async (event, input) => {
    assertFocusedMainWindow(event, true);
    if (!headlessHost) throw new Error("Local execution service is unavailable");
    return headlessHost.request("/api/v1/execution/provider", {
      workspace_id: input.workspaceId,
      operation: input.operation,
      expected_revision: input.expectedRevision ?? null,
      binding_id: input.bindingId ?? null,
      settings: executionSettingsPayload(input.settings),
      credential: input.credential ?? "",
      confirm: input.confirm === true,
    });
  });
''',
    '''  handle("coding-tools:execution:provider", async (event, input) => {
    assertFocusedMainWindow(event, true);
    if (!headlessHost) throw new Error("Local execution service is unavailable");

    let settings = input.settings;
    let credential = "";
    const plannedWorkload = input.operation === "configure"
      && settings
      && (settings.engine === "paseo" || settings.engine === "anneal");
    if (plannedWorkload) {
      const providerNetwork = await providerNetworkReady();
      const plan = createProviderExecutionPlan(providerNetwork.store.snapshot(), {
        workload: settings.engine,
        providerId: settings.provider,
        accountId: input.providerAccountId ?? undefined,
        model: settings.model,
        allowFallback: input.allowProviderFallback !== false,
      });
      const secret = providerNetwork.store.accountSecret(plan.account.id);
      credential = storedProviderCredential(secret);
      if (accountNeedsStoredCredential(plan.account.auth) && !credential) {
        throw new Error(`Provider account ${plan.account.id} has no usable stored credential`);
      }
      settings = {
        ...settings,
        provider: plan.provider.id,
        model: plan.model ?? settings.model,
      };
      logger.info("execution.provider_planned", {
        workload: plan.workload,
        providerId: plan.provider.id,
        accountId: plan.account.id,
        model: plan.model,
        fallbackUsed: plan.fallbackUsed,
        proxyMode: plan.proxy.mode,
        proxySource: plan.proxy.source,
        proxyProfileId: plan.proxy.profile?.id ?? null,
      });
    }

    return headlessHost.request("/api/v1/execution/provider", {
      workspace_id: input.workspaceId,
      operation: input.operation,
      expected_revision: input.expectedRevision ?? null,
      binding_id: input.bindingId ?? null,
      settings: executionSettingsPayload(settings),
      credential,
      confirm: input.confirm === true,
    });
  });
''',
)

replace_once(
    "desktop-electron/electron/ipc-schema.cjs",
    '''    settings: Object.freeze({ ...executionSettings, nullable: true }),
    credential: Object.freeze({ type: "string", maxLength: 4096 }),
    confirm: Object.freeze({ type: "boolean" }),
''',
    '''    settings: Object.freeze({ ...executionSettings, nullable: true }),
    providerAccountId: Object.freeze({ type: "string", minLength: 1, maxLength: 160, nullable: true }),
    allowProviderFallback: Object.freeze({ type: "boolean" }),
    confirm: Object.freeze({ type: "boolean" }),
''',
)

replace_once(
    "desktop-electron/src/features/ProviderOrchestratorSurfaces.tsx",
    '''        credential,
        confirm: true,
''',
    '''        allowProviderFallback: true,
        confirm: true,
''',
)

replace_once(
    "desktop-electron/src/types.ts",
    '''  isDefault: boolean;
  models: string[];
''',
    '''  isDefault: boolean;
  hasCredential: boolean;
  models: string[];
''',
)
