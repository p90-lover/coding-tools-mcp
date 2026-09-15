import { resolve } from "node:path";

const MACOS_CHATGPT_CODEX_PATH = "/Applications/ChatGPT.app/Contents/Resources/codex";

export function resolveCodexSmokeExecutable(
  args: readonly string[],
  environment: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
): string {
  const explicit = args.find(argument => argument !== "--v1" && argument !== "--v2")?.trim();
  const configured = explicit || environment.CODEX_SMOKE_BIN?.trim();
  if (configured) return resolve(configured);
  if (platform === "darwin") {
    // This branch is intentionally platform-injected for cross-platform CI. Using
    // the host's node:path implementation here would turn this POSIX path into a
    // Windows drive path when the darwin contract is tested on Windows.
    return MACOS_CHATGPT_CODEX_PATH;
  }
  throw new Error(
    "Codex smoke executable is not configured. Pass its path or set CODEX_SMOKE_BIN.",
  );
}
