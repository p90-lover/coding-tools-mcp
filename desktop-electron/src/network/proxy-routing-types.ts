export type ProxyProtocol = "http" | "https" | "socks5";

export type ProxyTraffic =
  | "browser"
  | "provider"
  | "paseo"
  | "anneal"
  | "update"
  | "local-control";

export type ProxyScope = Exclude<ProxyTraffic, "local-control"> | "all";

export interface ProxyEndpoint {
  protocol: ProxyProtocol;
  host: string;
  port: number;
  usernameRef?: string;
  passwordRef?: string;
}

export interface ProxyRoute {
  enabled: boolean;
  endpoint: ProxyEndpoint;
  scopes: ProxyScope[];
  bypass: string[];
}

export interface ProviderProxyPolicy {
  providerId: string;
  inheritGlobal: boolean;
  override?: ProxyRoute;
}

export interface ProxyRoutingState {
  global: ProxyRoute | null;
  providers: ProviderProxyPolicy[];
}

export interface ProxyHealth {
  reachable: boolean;
  latencyMs?: number;
  error?: string;
}
