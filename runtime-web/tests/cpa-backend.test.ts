import { describe, expect, test } from "bun:test";
import {
  describeProviderBackends,
  resolveAnnealExecutionLoopback,
  resolveCpaConnection,
  resolvePaseoExecutionLoopback,
} from "../src/routed-providers";

const key = "test_cpa_proxy_key_abcdefghijklmnopqrstuvwxyz012345";

describe("CPA backend discovery", () => {
  test("discovers only a loopback CPA backend without exposing its key", () => {
    const env = {
      CODING_TOOLS_CPA_URL: "http://127.0.0.1:8317/",
      CODING_TOOLS_CPA_PROXY_API_KEY: key,
    };
    expect(resolveCpaConnection(env)).toEqual({
      origin: "http://127.0.0.1:8317",
      proxyApiKey: key,
      baseUrl: "http://127.0.0.1:8317/v1",
    });
    const discovery = describeProviderBackends(env);
    expect(discovery.backends.cpa?.healthUrl).toBe("http://127.0.0.1:8317/v1/models");
    expect(JSON.stringify(discovery)).not.toContain(key);
    expect(describeProviderBackends({}).backends).toEqual({});
    expect(() => resolveCpaConnection({
      CODING_TOOLS_CPA_URL: "http://cpa.example:8317",
      CODING_TOOLS_CPA_PROXY_API_KEY: key,
    })).toThrow("loopback");
  });

  test("keeps Paseo and Anneal execution endpoints on loopback", () => {
    expect(resolvePaseoExecutionLoopback({
      CODING_TOOLS_PASEO_EXECUTION_URL: "ws://127.0.0.1:6768/ws",
    })).toBe("ws://127.0.0.1:6768/ws");
    expect(resolveAnnealExecutionLoopback({
      CODING_TOOLS_ANNEAL_EXECUTION_URL: "http://127.0.0.1:3000/",
    })).toBe("http://127.0.0.1:3000");
    expect(() => resolvePaseoExecutionLoopback({
      CODING_TOOLS_PASEO_EXECUTION_URL: "ws://paseo.example/ws",
    })).toThrow("loopback");
  });
});
