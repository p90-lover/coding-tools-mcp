import { spawnSync } from "node:child_process";
import { basename } from "node:path";
import { commandCodeProxyProviderProfile } from "../src/routed-providers";
import { codingToolsWebProviderRegistrationPlan } from "./codex-router-coding-tools-web-provider";

export interface GenericProviderSnapshot {
  id: string;
  displayName: string;
  baseUrl: string;
  adapter: string;
  allowPrivate?: boolean;
  enabled?: boolean;
}

export interface CodexRouterIntegrationPlan {
  commands: string[][];
  ensureCommandCodeCredential: boolean;
  managedProviderIds: string[];
}

export interface CodexRouterIntegrationOptions {
  existingProviders?: GenericProviderSnapshot[];
  withCommandCodeProxy?: boolean;
  withCpa?: boolean;
  webBaseUrl?: string;
  commandCodeBaseUrl?: string;
  cpaBaseUrl?: string;
  routerCli?: string;
  curateCli?: string;
}

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);

function packagedRouterCli(command: string): boolean {
  const name = basename(command).toLowerCase();
  return name === "codex-router" || name === "codex-router.exe" || name === "codex-router.ps1";
}

function routerCommand(routerCli: string, ...args: string[]): string[] {
  return packagedRouterCli(routerCli)
    ? [routerCli, ...args]
    : [routerCli, "codex", ...args];
}

function curateCommand(curateCli: string, providerId: string): string[] {
  return packagedRouterCli(curateCli)
    ? [curateCli, "curate-models", providerId]
    : [curateCli, providerId];
}

function loopback(value: string): boolean {
  try {
    return LOOPBACK_HOSTS.has(new URL(value).hostname);
  } catch {
    return false;
  }
}

function expectedSnapshot(
  id: string,
  displayName: string,
  baseUrl: string,
  adapter: string,
): GenericProviderSnapshot {
  return {
    id,
    displayName,
    baseUrl,
    adapter,
    allowPrivate: loopback(baseUrl),
  };
}

function sameDescriptor(actual: GenericProviderSnapshot, expected: GenericProviderSnapshot): boolean {
  return actual.id === expected.id
    && actual.displayName === expected.displayName
    && actual.baseUrl.replace(/\/+$/, "") === expected.baseUrl.replace(/\/+$/, "")
    && actual.adapter === expected.adapter
    && Boolean(actual.allowPrivate) === Boolean(expected.allowPrivate);
}

function existingProvider(
  providers: GenericProviderSnapshot[],
  expected: GenericProviderSnapshot,
): GenericProviderSnapshot | undefined {
  const actual = providers.find(provider => provider.id === expected.id);
  if (!actual) return undefined;
  if (!sameDescriptor(actual, expected)) {
    throw new Error(
      `Generic provider ${expected.id} already exists with a conflicting descriptor; `
        + "Coding Tools will not edit, remove, or replace it automatically.",
    );
  }
  return actual;
}

function addProviderCommand(
  routerCli: string,
  provider: GenericProviderSnapshot,
): string[] {
  const command = routerCommand(
    routerCli,
    "providers",
    "generic",
    "add",
    provider.id,
    "--name",
    provider.displayName,
    "--base-url",
    provider.baseUrl,
    "--adapter",
    provider.adapter,
  );
  if (provider.allowPrivate) command.push("--allow-private");
  return command;
}

export function codexRouterIntegrationPlan({
  existingProviders = [],
  withCommandCodeProxy = false,
  withCpa = false,
  webBaseUrl = "http://127.0.0.1:17841/router/v1",
  commandCodeBaseUrl = "http://127.0.0.1:3050/v1",
  cpaBaseUrl = "http://127.0.0.1:8317/v1",
  routerCli = "model-router",
  curateCli = "curate-models",
}: CodexRouterIntegrationOptions = {}): CodexRouterIntegrationPlan {
  const webPlan = codingToolsWebProviderRegistrationPlan({
    baseUrl: webBaseUrl,
    routerCli,
    curateCli,
  });
  const web = expectedSnapshot(
    webPlan.provider.id,
    webPlan.provider.name,
    webPlan.provider.baseUrl,
    webPlan.provider.adapter,
  );

  const desired = [web];
  let commandCode: GenericProviderSnapshot | undefined;
  if (withCommandCodeProxy) {
    const profile = commandCodeProxyProviderProfile(commandCodeBaseUrl);
    commandCode = expectedSnapshot(profile.id, profile.name, profile.baseUrl, profile.adapter);
    desired.push(commandCode);
  }
  if (withCpa) {
    let origin;
    try {
      origin = new URL(cpaBaseUrl);
    } catch {
      throw new Error("CPA URL must be a valid URL");
    }
    if (!LOOPBACK_HOSTS.has(origin.hostname)) {
      throw new Error("CPA URL must use a loopback host");
    }
    origin.pathname = origin.pathname.replace(/\/+$/, "") || "/v1";
    desired.push(expectedSnapshot(
      "cpa",
      "CPA / CLIProxyAPI",
      origin.toString().replace(/\/$/, ""),
      "openai-chat",
    ));
  }

  // Validate every owned id before producing any mutation command. A conflict in the optional
  // provider must not allow the Web provider to be added first and leave a partial setup.
  const present = new Map<string, GenericProviderSnapshot | undefined>();
  for (const provider of desired) {
    present.set(provider.id, existingProvider(existingProviders, provider));
  }

  const commands: string[][] = [];
  for (const provider of desired) {
    if (!present.get(provider.id)) commands.push(addProviderCommand(routerCli, provider));
    if (provider.id === "commandcode-proxy") {
      commands.push(routerCommand(
        routerCli,
        "providers",
        "generic",
        "credential",
        provider.id,
        "status",
        "--json",
      ));
    }
    commands.push(routerCommand(routerCli, "providers", "generic", "enable", provider.id));
    commands.push(curateCommand(curateCli, provider.id));
  }

  return {
    commands,
    ensureCommandCodeCredential: Boolean(commandCode),
    managedProviderIds: desired.map(provider => provider.id),
  };
}

function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_./:@=-]+$/.test(value)) return value;
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

export function renderCodexRouterIntegrationPlan(plan: CodexRouterIntegrationPlan): string {
  const lines = [
    "Coding Tools will integrate providers through Codex Router's supported CLI only.",
    "Existing matching descriptors are reused; conflicting managed ids fail closed and are never edited or removed.",
    "",
    ...plan.commands.map(command => command.map(shellQuote).join(" ")),
  ];
  if (plan.ensureCommandCodeCredential) {
    lines.push(
      "",
      "CommandCode credential status is checked first. If unconfigured, Codex Router opens its hidden local prompt; Coding Tools never receives or prints the provider API key.",
    );
  }
  if (plan.managedProviderIds.includes("cpa")) {
    lines.push(
      "",
      "CPA / CLIProxyAPI is the in-app loopback at 127.0.0.1:8317. Coding Tools supplies CODING_TOOLS_CPA_PROXY_API_KEY on the Router process and does not prompt for that key.",
    );
  }
  return lines.join("\n");
}

function runCapture(command: string[]): string {
  const result = spawnSync(command[0]!, command.slice(1), {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    shell: false,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const detail = String(result.stderr || "").trim();
    throw new Error(`${command[0]} exited with status ${result.status ?? "unknown"}${detail ? `: ${detail}` : ""}`);
  }
  return String(result.stdout || "");
}

function runInteractive(command: string[]): void {
  const result = spawnSync(command[0]!, command.slice(1), {
    stdio: "inherit",
    shell: false,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command[0]} exited with status ${result.status ?? "unknown"}`);
  }
}

function readGenericProviders(routerCli: string): GenericProviderSnapshot[] {
  const output = runCapture(routerCommand(routerCli, "providers", "generic", "list", "--json"));
  const parsed = JSON.parse(output) as { providers?: unknown };
  if (!Array.isArray(parsed.providers)) {
    throw new Error("Codex Router generic provider list returned an invalid JSON contract");
  }
  return parsed.providers.map((provider, index) => {
    if (!provider || typeof provider !== "object" || Array.isArray(provider)) {
      throw new Error(`Codex Router generic provider ${index} is invalid`);
    }
    const value = provider as Record<string, unknown>;
    for (const field of ["id", "displayName", "baseUrl", "adapter"] as const) {
      if (typeof value[field] !== "string" || !value[field]) {
        throw new Error(`Codex Router generic provider ${index} is missing ${field}`);
      }
    }
    return {
      id: value.id as string,
      displayName: value.displayName as string,
      baseUrl: value.baseUrl as string,
      adapter: value.adapter as string,
      ...(typeof value.allowPrivate === "boolean" ? { allowPrivate: value.allowPrivate } : {}),
      ...(typeof value.enabled === "boolean" ? { enabled: value.enabled } : {}),
    };
  });
}

function credentialStatus(command: string[]): boolean {
  const output = runCapture(command);
  const parsed = JSON.parse(output) as { configured?: unknown };
  if (typeof parsed.configured !== "boolean") {
    throw new Error("Codex Router generic credential status returned an invalid JSON contract");
  }
  return parsed.configured;
}

function option(args: string[], name: string, fallback: string): string {
  const index = args.indexOf(name);
  if (index < 0) return fallback;
  const value = args[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} requires a value`);
  return value;
}

export function codexRouterIntegrationMain(args = process.argv.slice(2)): void {
  const apply = args.includes("--apply");
  const withCommandCodeProxy = args.includes("--with-commandcode-proxy");
  const withCpa = args.includes("--with-cpa");
  const routerCli = option(args, "--router-cli", "model-router");
  const curateCli = option(args, "--curate-cli", "curate-models");
  const shared = {
    withCommandCodeProxy,
    withCpa,
    webBaseUrl: option(args, "--web-base-url", "http://127.0.0.1:17841/router/v1"),
    commandCodeBaseUrl: option(args, "--commandcode-base-url", "http://127.0.0.1:3050/v1"),
    cpaBaseUrl: option(args, "--cpa-base-url", "http://127.0.0.1:8317/v1"),
    routerCli,
    curateCli,
  };
  const existingProviders = apply ? readGenericProviders(routerCli) : [];
  const plan = codexRouterIntegrationPlan({ ...shared, existingProviders });
  process.stdout.write(`${renderCodexRouterIntegrationPlan(plan)}\n`);
  if (!apply) {
    process.stdout.write("Dry run only. Re-run with --apply after reviewing the exact commands.\n");
    return;
  }

  for (const command of plan.commands) {
    const credentialStatusCommand = command.includes("credential")
      && command.includes("status")
      && command.includes("commandcode-proxy");
    if (!credentialStatusCommand) {
      runInteractive(command);
      continue;
    }
    if (credentialStatus(command)) continue;
    runInteractive(routerCommand(
      routerCli,
      "providers",
      "generic",
      "credential",
      "commandcode-proxy",
      "set",
    ));
  }
}

if (import.meta.main) {
  try {
    codexRouterIntegrationMain();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
