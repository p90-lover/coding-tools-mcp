export type ProxyProtocol = "http" | "https" | "socks4" | "socks5";

export type ProxyTraffic =
  | "browser"
  | "provider"
  | "oauth"
  | "paseo"
  | "anneal"
  | "mcp"
  | "websocket"
  | "http"
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

export interface ProxyProfile extends ProxyRoute {
  id: string;
  name: string;
  lastCheckedAt?: string;
  latencyMs?: number;
  lastError?: string;
  archivedAt?: string;
}

export interface ProviderProxyPolicy {
  providerId: string;
  inheritGlobal: boolean;
  profileId?: string;
  override?: ProxyRoute;
}

export interface AccountProxyPolicy {
  accountId: string;
  providerId: string;
  inheritProvider: boolean;
  inheritGlobal: boolean;
  profileId?: string;
  override?: ProxyRoute;
}

export interface ProxyRoutingState {
  global: ProxyRoute | null;
  providers: ProviderProxyPolicy[];
  accounts?: AccountProxyPolicy[];
  profiles?: ProxyProfile[];
  globalEnabled?: boolean;
  globalProfileId?: string | null;
}

export interface ProxyHealth {
  reachable: boolean;
  latencyMs?: number;
  error?: string;
}
