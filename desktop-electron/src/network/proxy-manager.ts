import type {
  ProxyRoute,
  ProxyRoutingState,
  ProxyTraffic,
} from "./proxy-routing-types";

function normalizeHostname(hostname: string): string {
  const trimmed = hostname.trim().toLowerCase();
  return trimmed.startsWith("[") && trimmed.endsWith("]")
    ? trimmed.slice(1, -1)
    : trimmed;
}

export function isLoopbackHost(hostname: string): boolean {
  const host = normalizeHostname(hostname);
  return host === "localhost"
    || host.endsWith(".localhost")
    || host === "::1"
    || host === "::"
    || host === "0.0.0.0"
    || /^127(?:\.\d{1,3}){3}$/.test(host);
}

function matchesBypass(hostname: string, entries: readonly string[]): boolean {
  const host = normalizeHostname(hostname);
  return entries.some((entry) => {
    const pattern = normalizeHostname(entry);
    if (!pattern) return false;
    if (pattern === "*") return true;
    if (pattern.startsWith("*.")) {
      const suffix = pattern.slice(2);
      return host === suffix || host.endsWith(`.${suffix}`);
    }
    if (pattern.startsWith(".")) {
      const suffix = pattern.slice(1);
      return host === suffix || host.endsWith(`.${suffix}`);
    }
    return host === pattern;
  });
}

export function resolveProxy(
  providerId: string,
  state: ProxyRoutingState,
): ProxyRoute | null {
  const provider = state.providers.find((item) => item.providerId === providerId);

  if (provider?.override?.enabled && validateProxy(provider.override)) {
    return provider.override;
  }

  if (provider?.inheritGlobal === false) return null;
  return state.global?.enabled && validateProxy(state.global) ? state.global : null;
}

export function validateProxy(route: ProxyRoute): boolean {
  const { endpoint } = route;
  return Boolean(
    endpoint.host.trim()
      && Number.isInteger(endpoint.port)
      && endpoint.port > 0
      && endpoint.port < 65_536
      && ["http", "https", "socks5"].includes(endpoint.protocol)
      && route.scopes.length > 0,
  );
}

export function shouldProxyUrl(
  rawUrl: string,
  traffic: ProxyTraffic,
  route: ProxyRoute | null,
): boolean {
  if (!route?.enabled || !validateProxy(route) || traffic === "local-control") return false;

  let target: URL;
  try {
    target = new URL(rawUrl);
  } catch {
    return false;
  }

  if (isLoopbackHost(target.hostname) || matchesBypass(target.hostname, route.bypass)) {
    return false;
  }

  return route.scopes.includes("all") || route.scopes.includes(traffic);
}
