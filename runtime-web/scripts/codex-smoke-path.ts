import { resolve } from "node:path";

export function resolveCodexSmokeExecutable(
  args: readonly string[],
  environment: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
): string {
  const explicit = args.find(argument => argument !== "--v1" && argument !== "--v2")?.trim();
  const configured = explicit || environment.CODEX_SMOKE_BIN?.trim();
  if (configured) return resolve(configured);
  if (platform === "darwin") {
    return resolve("/Applications/ChatGPT.app/Contents/Resources/codex");
  }
  throw new Error(
    "Codex smoke executable is not configured. Pass its path or set CODEX_SMOKE_BIN.",
  );
}
