import type {
  AccountProxyPolicy,
  ProviderProxyPolicy,
  ProxyProfile,
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

function copyRoute(route: ProxyRoute): ProxyRoute {
  return {
    enabled: route.enabled,
    endpoint: { ...route.endpoint },
    scopes: [...route.scopes],
    bypass: [...route.bypass],
  };
}

function routeFromProfile(
  profileId: string | undefined,
  profiles: readonly ProxyProfile[],
): ProxyRoute | null {
  if (!profileId) return null;
  const profile = profiles.find((item) => item.id === profileId && !item.archivedAt);
  if (!profile || !validateProxy(profile)) return null;
  return copyRoute(profile);
}

function routeFromPolicy(
  policy: Pick<ProviderProxyPolicy | AccountProxyPolicy, "profileId" | "override"> | undefined,
  profiles: readonly ProxyProfile[],
): ProxyRoute | null {
  if (!policy) return null;
  if (policy.override?.enabled && validateProxy(policy.override)) {
    return copyRoute(policy.override);
  }
  return routeFromProfile(policy.profileId, profiles);
}

function globalRoute(state: ProxyRoutingState): ProxyRoute | null {
  if (state.globalEnabled === false) return null;
  const saved = routeFromProfile(state.globalProfileId ?? undefined, state.profiles ?? []);
  if (saved) return saved;
  return state.global?.enabled && validateProxy(state.global)
    ? copyRoute(state.global)
    : null;
}

export function resolveProxy(
  providerId: string,
  state: ProxyRoutingState,
  accountId?: string,
): ProxyRoute | null {
  const profiles = state.profiles ?? [];
  const account = accountId
    ? state.accounts?.find((item) => item.accountId === accountId && item.providerId === providerId)
    : undefined;
  let allowGlobal = true;

  if (account) {
    const accountRoute = routeFromPolicy(account, profiles);
    if (accountRoute) return accountRoute;
    allowGlobal = account.inheritGlobal !== false;
    if (account.inheritProvider === false) {
      return allowGlobal ? globalRoute(state) : null;
    }
  }

  const provider = state.providers.find((item) => item.providerId === providerId);
  const providerRoute = routeFromPolicy(provider, profiles);
  if (providerRoute) return providerRoute;

  if (provider?.inheritGlobal === false || !allowGlobal) return null;
  return globalRoute(state);
}

export function validateProxy(route: ProxyRoute): boolean {
  const { endpoint } = route;
  return Boolean(
    endpoint.host.trim()
      && Number.isInteger(endpoint.port)
      && endpoint.port > 0
      && endpoint.port < 65_536
      && ["http", "https", "socks4", "socks5"].includes(endpoint.protocol)
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

export function proxyUrl(route: ProxyRoute): string | null {
  if (!validateProxy(route)) return null;
  const protocol = route.endpoint.protocol;
  const host = route.endpoint.host.includes(":")
    ? `[${normalizeHostname(route.endpoint.host)}]`
    : normalizeHostname(route.endpoint.host);
  return `${protocol}://${host}:${route.endpoint.port}`;
}
