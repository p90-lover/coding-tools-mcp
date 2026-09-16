export type ProxyKind = "none" | "http" | "https" | "socks5";

export type ProxyScope =
  | "all"
  | "browser"
  | "providers"
  | "paseo"
  | "anneal";

export interface ProxyRoute {
  enabled: boolean;
  kind: ProxyKind;
  address: string;
  scope: ProxyScope;
  bypass: string[];
}

export interface ProviderProxyPolicy {
  providerId: string;
  inheritGlobal: boolean;
  override?: ProxyRoute;
}

export interface ProxyHealth {
  reachable: boolean;
  latencyMs?: number;
  error?: string;
}
