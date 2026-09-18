import { describe, expect, test } from "bun:test";
import zhTW from "../src/i18n/locales/zh-TW";
import { electronBridgeContracts } from "../src/integrations/electron-bridge-contracts";
import {
  isLoopbackHost,
  resolveProxy,
  shouldProxyUrl,
  validateProxy,
} from "../src/network/proxy-manager";
import type { ProxyRoute, ProxyRoutingState } from "../src/network/proxy-routing-types";
import { DEFAULT_PROVIDERS } from "../src/providers/provider-types";

const globalRoute: ProxyRoute = {
  enabled: true,
  endpoint: {
    protocol: "socks5",
    host: "127.0.0.1",
    port: 7890,
  },
  scopes: ["all"],
  bypass: ["*.internal.example"],
};

describe("rc.2 provider and proxy foundations", () => {
  test("global proxy accepts a bounded endpoint and never captures loopback control traffic", () => {
    expect(validateProxy(globalRoute)).toBe(true);
    for (const host of ["localhost", "api.localhost", "127.0.0.1", "127.24.8.9", "::1", "::", "0.0.0.0"]) {
      expect(isLoopbackHost(host)).toBe(true);
    }
    for (const url of [
      "http://localhost:3000/health",
      "http://127.0.0.1:6767/ws",
      "http://[::1]:4444/control",
      "http://0.0.0.0:9000/",
    ]) {
      expect(shouldProxyUrl(url, "provider", globalRoute)).toBe(false);
    }
    expect(shouldProxyUrl("https://api.example.com/v1/models", "local-control", globalRoute)).toBe(false);
    expect(shouldProxyUrl("https://api.internal.example/v1/models", "provider", globalRoute)).toBe(false);
    expect(shouldProxyUrl("https://api.example.com/v1/models", "provider", globalRoute)).toBe(true);
  });

  test("provider overrides take precedence while explicit direct mode stays direct", () => {
    const override: ProxyRoute = {
      enabled: true,
      endpoint: { protocol: "http", host: "127.0.0.1", port: 8080 },
      scopes: ["provider"],
      bypass: [],
    };
    const state: ProxyRoutingState = {
      global: globalRoute,
      providers: [
        { providerId: "commandcode-proxy", inheritGlobal: true, override },
        { providerId: "claude-oauth", inheritGlobal: false },
      ],
    };
    expect(resolveProxy("commandcode-proxy", state)).toEqual(override);
    expect(resolveProxy("claude-oauth", state)).toBeNull();
    expect(resolveProxy("chatgpt-web", state)).toEqual(globalRoute);
  });

  test("provider catalog contains unique routable Web, OAuth, and reverse-proxy entries", () => {
    const ids = DEFAULT_PROVIDERS.map((provider) => provider.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of [
      "codex-oauth",
      "claude-oauth",
      "chatgpt-web",
      "gemini-reverse-proxy",
      "commandcode-proxy",
    ]) {
      const provider = DEFAULT_PROVIDERS.find((item) => item.id === id);
      expect(provider).toBeDefined();
      expect(provider?.paseoEnabled).toBe(true);
      expect(provider?.annealEnabled).toBe(true);
    }
  });

  test("Electron bridge and Traditional Chinese copy expose the requested controls", () => {
    expect(electronBridgeContracts.proxy).toEqual({
      snapshot: "proxy.snapshot",
      update: "proxy.update",
      test: "proxy.test",
    });
    expect(electronBridgeContracts.paseo.createMission).toBe("paseo.createMission");
    expect(electronBridgeContracts.anneal.dispatch).toBe("anneal.dispatch");
    expect(zhTW.paseoOrchestrator).toBe("Paseo 協調器");
    expect(zhTW.annealTasks).toBe("Anneal 任務");
    expect(zhTW.networkProxy).toBe("網路代理");
    expect(zhTW.dispatchThroughPaseo).toBe("透過 Paseo 執行");
  });
});
