import type {
  ProviderProxyPolicy,
  ProxyHealth,
  ProxyRoute,
} from "./proxy-routing-types";

export interface ProxySnapshot {
  global: ProxyRoute | null;
  overrides: ProviderProxyPolicy[];
  lastHealthCheck?: ProxyHealth;
}

export interface ProxyUpdateInput {
  global?: ProxyRoute | null;
  overrides?: ProviderProxyPolicy[];
}

export interface ProxyApi {
  snapshot(): Promise<ProxySnapshot>;
  update(input: ProxyUpdateInput): Promise<ProxySnapshot>;
  test(input: { providerId?: string }): Promise<ProxyHealth>;
}

export type {
  ProviderProxyPolicy,
  ProxyEndpoint,
  ProxyHealth,
  ProxyProtocol,
  ProxyRoute,
  ProxyRoutingState,
  ProxyScope,
  ProxyTraffic,
} from "./proxy-routing-types";
