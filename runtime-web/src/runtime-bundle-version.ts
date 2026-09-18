import { VERSION } from "./version";

const RELEASE_VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z][0-9A-Za-z.-]*)?$/;

export function resolveRuntimeBundleAppVersion(
  env: Record<string, string | undefined> = process.env,
): string {
  const requested = env.CODEX_CHATGPT_WEB_BUNDLE_APP_VERSION?.trim();
  if (!requested) return VERSION;
  if (!RELEASE_VERSION.test(requested)) {
    throw new Error(`Runtime bundle release version is invalid: ${JSON.stringify(requested)}`);
  }
  return requested;
}
