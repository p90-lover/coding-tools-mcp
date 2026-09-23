import { readLauncherBrowserHostDescriptor } from "./launcher-browser-host";

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

/** Native Codex keeps its own bearer auth while Chromium supplies the launcher's proxy session. */
export async function fetchNativeCodex(request: Request): Promise<Response> {
  const descriptorPath = process.env.CODEX_CHATGPT_WEB_BROWSER_HOST_DESCRIPTOR?.trim();
  // Standalone CLI and explicitly configured proxy environments retain Bun's existing semantics,
  // including NO_PROXY. No proxy variables or machine-wide settings are rewritten.
  if (!descriptorPath || ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy"]
    .some(key => process.env[key]?.trim())) return fetch(request);

  const descriptor = readLauncherBrowserHostDescriptor(descriptorPath);
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
