import { spawnSync } from "node:child_process";
import {
  commandCodeProxyRegistrationPlan,
  renderCommandCodeProxyPlan,
} from "../../src/lib/control-center/commandcode-proxy-provider.ts";

export {
  COMMANDCODE_PROXY_ALTERNATE_LISTEN,
  COMMANDCODE_PROXY_DEFAULT_BASE_URL,
  commandCodeProxyProviderProfile,
  commandCodeProxyRegistrationPlan,
  isLoopbackUrl,
  renderCommandCodeProxyPlan,
} from "../../src/lib/control-center/commandcode-proxy-provider.ts";
export type {
  CommandCodeProxyProviderProfile,
  CommandCodeProxyRegistrationOptions,
  CommandCodeProxyRegistrationPlan,
} from "../../src/lib/control-center/commandcode-proxy-provider.ts";

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

function isMain(): boolean {
  const meta = import.meta as ImportMeta & { main?: boolean };
  if (meta.main) return true;
  const argv1 = process.argv[1];
  return Boolean(argv1 && argv1.replaceAll("\\", "/").endsWith("commandcode-proxy-provider.ts"));
}

if (isMain()) {
  try {
    commandCodeProxyMain();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
