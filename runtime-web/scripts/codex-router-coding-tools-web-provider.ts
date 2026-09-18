import { spawnSync } from "node:child_process";

export interface CodingToolsWebProviderProfile {
  id: "coding-tools-web";
  name: "Coding Tools Web";
  baseUrl: string;
  adapter: "openai-responses";
}

export interface CodingToolsWebProviderRegistrationPlan {
  provider: CodingToolsWebProviderProfile;
  commands: string[][];
  credentialPromptRequired: false;
}

export interface CodingToolsWebProviderRegistrationOptions {
  baseUrl: string;
  routerCli?: string;
  curateCli?: string;
}

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);

function codingToolsWebBaseUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new Error("Coding Tools Web provider URL must be a valid loopback URL");
  }
  if (
    !["http:", "https:"].includes(url.protocol)
    || !LOOPBACK_HOSTS.has(url.hostname)
    || url.username
    || url.password
    || url.search
    || url.hash
  ) {
    throw new Error("Coding Tools Web provider URL must be a credential-free loopback HTTP(S) URL");
  }
  const pathname = url.pathname.replace(/\/+$/, "") || "/";
  if (pathname !== "/router/v1") {
    throw new Error("Coding Tools Web provider URL must target the restricted /router/v1 ingress");
  }
  url.pathname = pathname;
  return url.toString().replace(/\/$/, "");
}

function requireCommand(value: string, label: string): string {
  const command = value.trim();
  if (!command) throw new Error(`${label} path is required`);
  return command;
}

export function codingToolsWebProviderRegistrationPlan({
  baseUrl,
  routerCli = "model-router",
  curateCli = "curate-models",
}: CodingToolsWebProviderRegistrationOptions): CodingToolsWebProviderRegistrationPlan {
  const provider: CodingToolsWebProviderProfile = {
    id: "coding-tools-web",
    name: "Coding Tools Web",
    baseUrl: codingToolsWebBaseUrl(baseUrl),
    adapter: "openai-responses",
  };
  const router = requireCommand(routerCli, "Codex Router CLI");
  const curate = requireCommand(curateCli, "Codex Router curate-models");
  return {
    provider,
    commands: [
      [
        router,
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
        "--allow-private",
      ],
      [router, "codex", "providers", "generic", "enable", provider.id],
      [curate, provider.id],
    ],
    credentialPromptRequired: false,
  };
}

function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_./:@=-]+$/.test(value)) return value;
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

export function renderCodingToolsWebProviderPlan(
  plan: CodingToolsWebProviderRegistrationPlan,
): string {
  return [
    "Coding Tools Web will be registered as a credentialless Codex Router generic provider.",
    "Only the restricted loopback /router/v1 ingress is exposed; no native or codex-router/* model can enter this provider.",
    "Adapter: openai-responses",
    "",
    ...plan.commands.map(command => command.map(shellQuote).join(" ")),
    "",
    "No provider credential is configured or requested for coding-tools-web.",
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

export function codingToolsWebProviderMain(args = process.argv.slice(2)): void {
  const apply = args.includes("--apply");
  const plan = codingToolsWebProviderRegistrationPlan({
    baseUrl: option(args, "--base-url", "http://127.0.0.1:17841/router/v1"),
    routerCli: option(args, "--router-cli", "model-router"),
    curateCli: option(args, "--curate-cli", "curate-models"),
  });
  process.stdout.write(`${renderCodingToolsWebProviderPlan(plan)}\n`);
  if (!apply) {
    process.stdout.write("Dry run only. Re-run with --apply to execute this exact sequence.\n");
    return;
  }
  for (const command of plan.commands) run(command);
}

if (import.meta.main) {
  try {
    codingToolsWebProviderMain();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
