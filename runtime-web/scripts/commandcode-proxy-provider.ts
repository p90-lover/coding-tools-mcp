import { spawnSync } from "node:child_process";
import { commandCodeProxyProviderProfile } from "../src/routed-providers";

export interface CommandCodeProxyRegistrationPlan {
  provider: ReturnType<typeof commandCodeProxyProviderProfile>;
  commands: string[][];
  credentialPromptRequired: true;
}

export interface CommandCodeProxyRegistrationOptions {
  baseUrl: string;
  routerCli?: string;
  curateCli?: string;
}

function isLoopbackUrl(value: string): boolean {
  const hostname = new URL(value).hostname;
  return hostname === "127.0.0.1" || hostname === "localhost" || hostname === "[::1]";
}

export function commandCodeProxyRegistrationPlan({
  baseUrl,
  routerCli = "model-router",
  curateCli = "curate-models",
}: CommandCodeProxyRegistrationOptions): CommandCodeProxyRegistrationPlan {
  if (!routerCli.trim()) throw new Error("Codex Router CLI path is required");
  if (!curateCli.trim()) throw new Error("Codex Router curate-models path is required");
  const provider = commandCodeProxyProviderProfile(baseUrl);
  const add = [
    routerCli,
    "codex",
    "providers",
    "generic",
    "add",
    provider.id,
    "--name",
    provider.name,
    "--base-url",
    provider.baseUrl,
    "--adapter",
    provider.adapter,
  ];
  if (isLoopbackUrl(provider.baseUrl)) add.push("--allow-private");
  return {
    provider,
    commands: [
      add,
      [routerCli, "codex", "providers", "generic", "credential", provider.id, "set"],
      [routerCli, "codex", "providers", "generic", "enable", provider.id],
      [curateCli, provider.id],
    ],
    credentialPromptRequired: true,
  };
}

function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_./:@=-]+$/.test(value)) return value;
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

export function renderCommandCodeProxyPlan(plan: CommandCodeProxyRegistrationPlan): string {
  return [
    "CommandCode Proxy will be registered as a Codex Router generic provider.",
    "The CommandCode user_* key is entered only in Codex Router's hidden credential prompt; Coding Tools never accepts it.",
    "",
    ...plan.commands.map(command => command.map(shellQuote).join(" ")),
    "",
    "Run the curation step after the provider credential and enable steps so the live /v1/models catalog becomes available to Codex subagents.",
  ].join("\n");
}

function option(args: string[], name: string, fallback: string): string {
  const index = args.indexOf(name);
  if (index < 0) return fallback;
  const value = args[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} requires a value`);
  return value;
}

function run(command: string[]): void {
  const result = spawnSync(command[0]!, command.slice(1), {
    stdio: "inherit",
    shell: false,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command[0]} exited with status ${result.status ?? "unknown"}`);
  }
}

export function commandCodeProxyMain(args = process.argv.slice(2)): void {
  const apply = args.includes("--apply");
  const plan = commandCodeProxyRegistrationPlan({
    baseUrl: option(args, "--base-url", "http://127.0.0.1:3050/v1"),
    routerCli: option(args, "--router-cli", "model-router"),
    curateCli: option(args, "--curate-cli", "curate-models"),
  });
  process.stdout.write(`${renderCommandCodeProxyPlan(plan)}\n`);
  if (!apply) {
    process.stdout.write("Dry run only. Re-run with --apply to execute this exact sequence.\n");
    return;
  }
  for (const command of plan.commands) run(command);
}

if (import.meta.main) {
  try {
    commandCodeProxyMain();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
