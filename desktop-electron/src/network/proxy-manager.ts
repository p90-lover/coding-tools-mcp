export type ProxyProtocol = "http" | "https" | "socks5";

export interface ProxyConfig {
  enabled: boolean;
  protocol: ProxyProtocol;
  host: string;
  port: number;
}

export interface ProviderProxyRule {
  providerId: string;
  inheritGlobal: boolean;
  override?: ProxyConfig;
}

export interface ProxyRoutingState {
  global: ProxyConfig | null;
  providers: ProviderProxyRule[];
}

export function resolveProxy(
  providerId: string,
  state: ProxyRoutingState,
): ProxyConfig | null {
  const provider = state.providers.find((item) => item.providerId === providerId);

  if (provider?.override?.enabled) {
    return provider.override;
  }

  if (provider?.inheritGlobal === false) {
    return null;
  }

  return state.global?.enabled ? state.global : null;
}

export function validateProxy(config: ProxyConfig): boolean {
  return Boolean(
    config.host.trim()
      && config.port > 0
      && config.port < 65536,
  );
}
