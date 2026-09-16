export type ProxyProtocol = "http" | "https" | "socks5";

export type ProxyScope =
  | "all"
  | "browser"
  | "providers"
  | "paseo"
  | "anneal";

export interface ProxyRoute {
  enabled: boolean;
  protocol: ProxyProtocol;
  host: string;
  port: number;
  scope: ProxyScope[];
  bypass: string[];
}

export interface ProviderProxyOverride {
  providerId: string;
  inheritGlobal: boolean;
  route?: ProxyRoute;
}

export interface ProxySnapshot {
  global: ProxyRoute | null;
  overrides: ProviderProxyOverride[];
  lastHealthCheck?: {
    ok: boolean;
    latencyMs?: number;
    message: string;
  };
}

export interface ProxyServiceApi {
  snapshot(): Promise<ProxySnapshot>;
  update(input: { global?: ProxyRoute | null; overrides?: ProviderProxyOverride[] }): Promise<ProxySnapshot>;
  test(input: { providerId?: string }): Promise<ProxySnapshot["lastHealthCheck"]>;
}
