import { waitForLauncherBrowserHostDescriptor } from "./launcher-browser-host";

function proxyError(message: string): Error {
  return Object.assign(new Error(message), { code: "NativeProxyConfigurationError" });
}

/** Use the first route selected by Chromium, without guessing another proxy protocol or retrying. */
export function nativeProxyFromPac(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length > 4096) {
    throw proxyError("Launcher returned invalid native proxy configuration");
  }
  const first = value.split(";")[0]!.trim();
  if (first === "DIRECT") return undefined;
  const match = /^(PROXY|HTTPS) ([^\s/;]+)$/.exec(first);
  if (!match) {
    throw proxyError("Native Codex requires an HTTP(S) system proxy; the selected proxy protocol is unsupported");
  }
  try {
    const proxy = new URL(`${match[1] === "HTTPS" ? "https" : "http"}://${match[2]}`);
    if (!proxy.hostname || proxy.username || proxy.password || proxy.search || proxy.hash) throw new Error();
    return proxy.href;
  } catch {
    throw proxyError("Launcher returned invalid native proxy configuration");
  }
}

/**
 * Native Codex keeps its own bearer auth while Chromium supplies the launcher's proxy session.
 *
 * The launcher's descriptor is read for every request, never cached. When the app crashed (its
 * descriptor names an exited process) or announced a restart, the request waits for the relaunched
 * app's descriptor (LAUNCHER_RESTART_WAIT_MS) instead of failing with a 502 at once; a clean quit
 * fails at once.
 */
export async function fetchNativeCodex(
  request: Request,
  descriptorWait: Pick<Parameters<typeof waitForLauncherBrowserHostDescriptor>[1] & object,
    "timeoutMs" | "intervalMs" | "now" | "sleep"> = {},
): Promise<Response> {
  const descriptorPath = process.env.CODEX_CHATGPT_WEB_BROWSER_HOST_DESCRIPTOR?.trim();
  // The launcher owns proxy authentication; its exported proxy environment has no credentials.
  // Standalone CLI requests still use Bun's proxy settings when there is no launcher.
  if (!descriptorPath) return fetch(request);

  const descriptor = await waitForLauncherBrowserHostDescriptor(descriptorPath, {
    ...descriptorWait,
    signal: request.signal,
    missingIsRestart: false,
  });
  const headers = new Headers(request.headers);
  const nativeAuthorization = headers.get("authorization");
  if (!nativeAuthorization?.startsWith("Bearer ") || nativeAuthorization.length <= 7) {
    throw proxyError("Native Codex request has no Bearer authorization");
  }
  for (const name of ["host", "connection", "content-length", "cookie", "proxy-authorization"]) headers.delete(name);
  headers.set("authorization", `Bearer ${descriptor.control.token}`);
  headers.set("x-native-authorization", nativeAuthorization);
  headers.set("x-native-url", request.url);
  headers.set("x-native-method", request.method);
  headers.set("x-native-redirect", request.redirect);
  const response = await fetch(`${descriptor.control.endpoint}/v1/network/native-fetch`, {
    method: "POST",
    headers,
    ...(request.body ? { body: request.body, duplex: "half" as const } : {}),
    signal: request.signal,
    redirect: "error",
  } as RequestInit & { duplex?: "half" });
  if (response.status === 404) throw proxyError("Launcher native fetch relay is unavailable");
  return response;
}
