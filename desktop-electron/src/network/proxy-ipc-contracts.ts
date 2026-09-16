export type ProxyTransport = "http" | "https" | "socks5";

export type ProxyScope =
  | "all"
  | "browser"
  | "providers"
  | "paseo"
  | "anneal";

export interface ProxyRoute {
  enabled: boolean;
  transport: ProxyTransport;
  endpoint: string;
  scope: ProxyScope;
  bypass: string[];
}

export interface ProviderProxyOverride {
  providerId: string;
  inheritGlobal: boolean;
  route?: ProxyRoute;
}

export interface ProxySnapshot {
  global: ProxyRoute;
  overrides: ProviderProxyOverride[];
  healthy: boolean;
  latencyMs?: number;
}

export interface ProxyApi {
  snapshot(): Promise<ProxySnapshot>;
  update(route: ProxyRoute): Promise<ProxySnapshot>;
  test(endpoint: string): Promise<{ ok: boolean; latencyMs?: number; error?: string }>;
}
