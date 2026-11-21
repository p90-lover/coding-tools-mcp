import type { LauncherApi } from "../types";

// OpenAI Platform pages an account opens in the Browser tab.
export const PLATFORM_SIGN_IN_URL = "https://platform.openai.com/login";
export const PLATFORM_TUNNELS_URL = "https://platform.openai.com/settings/organization/tunnels";

// The start of PLATFORM_SIGN_IN_UNFINISHED (electron/mcp-connector-setup.cjs): Connect MCP stopped at
// Platform's sign-in, which only the person can finish.
const PLATFORM_SIGN_IN_ASKED = "OpenAI Platform asked this account to sign in again";

/** Whether an account's MCP failure is Platform asking it to sign in. */
export function needsPlatformSignIn(detail: string | null | undefined) {
  return typeof detail === "string" && detail.includes(PLATFORM_SIGN_IN_ASKED);
}

/**
 * An account's OpenAI Platform sign-in. On Windows it happens in the person's Chrome and is kept in the
 * account's own saved session for later setups (2026-11-18): resolves true, signed in. Elsewhere
 * Platform's login opens in the Browser tab for the person to finish: resolves false.
 */
export async function signInToPlatform({ api, accountId, showBrowser }: {
  api: Pick<LauncherApi, "openPlatformSignIn" | "switchBrowserAccount" | "openBrowserUrl">;
  accountId: string;
  showBrowser?: () => void;
}) {
  if ((await api.openPlatformSignIn(accountId)).inChrome) return true;
  await openPlatformInBrowser({ api, accountId, url: PLATFORM_SIGN_IN_URL, showBrowser });
  return false;
}

// Main opens no tab until the Browser tab shows (BrowserHost.createUserTab), and showing it takes a render.
const BROWSER_NOT_SHOWN = /Open the Browser tab before creating a tab/;

/**
 * Opens a Platform page for one account in the Browser tab, in a tab of the person's own: switches to the
 * account (no change when it is in use), shows the Browser tab and opens the page there. Before
 * 2026-11-17 an account's Platform sign-in had nowhere to happen: Connect MCP stopped at it in a hidden
 * window, and "Platform settings" opened Platform in another hidden window.
 */
export async function openPlatformInBrowser({ api, accountId, url, showBrowser, wait = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)), tries = 30 }: {
  api: Pick<LauncherApi, "switchBrowserAccount" | "openBrowserUrl">;
  accountId: string;
  url: string;
  showBrowser?: () => void;
  wait?: (ms: number) => Promise<void>;
  tries?: number;
}) {
  await api.switchBrowserAccount(accountId);
  showBrowser?.();
  for (let attempt = 1; ; attempt++) {
    try {
      return await api.openBrowserUrl(url);
    } catch (cause) {
      const message = cause && typeof cause === "object" && "message" in cause ? String(cause.message) : String(cause);
      if (attempt >= tries || !BROWSER_NOT_SHOWN.test(message)) throw cause;
    }
    await wait(100);
  }
}
