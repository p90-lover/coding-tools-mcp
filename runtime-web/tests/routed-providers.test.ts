import { describe, expect, test } from "bun:test";
import { defaultConfig } from "../src/config";
import {
  augmentWithCodexRouterModels,
  codexRouterModelId,
  commandCodeProxyProviderProfile,
  forwardCodexRouterResponse,
  parseCodexRouterModelId,
  redactRouterError,
  resolveCodexRouterConnection,
} from "../src/routed-providers";

const CALLER_KEY = "test_router_caller_key_abcdefghijklmnopqrstuvwxyz012345";

function nativeCatalog(): Record<string, unknown> {
  return {
    models: [
      {
        slug: "gpt-5.6-sol",
        display_name: "5.6 Sol",
        description: "native",
        priority: 2,
        visibility: "list",
        supported_in_api: true,
        multi_agent_version: "v2",
        supported_reasoning_levels: [
          { effort: "medium", description: "Medium" },
          { effort: "high", description: "High" },
        ],
        tool_mode: "code_mode_only",
        context_window: 300_000,
        max_context_window: 320_000,
        auto_compact_token_limit: 270_000,
        comp_hash: "native-contract",
        additional_speed_tiers: [{ id: "fast" }],
        service_tiers: [{ id: "fast", name: "Fast" }],
        default_service_tier: "fast",
      },
      {
        slug: "chatgpt-web/high",
        display_name: "ChatGPT Web High",
        priority: 3,
        visibility: "list",
        supported_in_api: true,
        multi_agent_version: "v2",
        supported_reasoning_levels: [{ effort: "high", description: "High" }],
        tool_mode: null,
      },
    ],
  };
}

describe("Codex Router provider contract", () => {
  test("constructs only an authenticated loopback caller connection", () => {
    const connection = resolveCodexRouterConnection({
      CODING_TOOLS_CODEX_ROUTER_URL: "http://127.0.0.1:4202/",
      CODING_TOOLS_CODEX_ROUTER_CALLER_KEY: CALLER_KEY,
    });
    expect(connection).toEqual({
      origin: "http://127.0.0.1:4202",
      callerKey: CALLER_KEY,
      baseUrl: `http://127.0.0.1:4202/_codex-router/${CALLER_KEY}/v1`,
    });

    expect(resolveCodexRouterConnection({})).toBeUndefined();
    expect(() => resolveCodexRouterConnection({
      CODING_TOOLS_CODEX_ROUTER_URL: "http://router.example:4202",
      CODING_TOOLS_CODEX_ROUTER_CALLER_KEY: CALLER_KEY,
    })).toThrow("loopback");
  });

  test("round-trips routed model ids without guessing another namespace", () => {
    expect(codexRouterModelId("deepseek/deepseek-v4-pro"))
      .toBe("codex-router/deepseek/deepseek-v4-pro");
    expect(parseCodexRouterModelId("codex-router/deepseek/deepseek-v4-pro"))
      .toBe("deepseek/deepseek-v4-pro");
    expect(parseCodexRouterModelId("chatgpt-web/high")).toBeUndefined();
    expect(parseCodexRouterModelId("codex-router/")).toBeUndefined();
  });

  test("redacts caller capabilities from router failures", () => {
    const connection = resolveCodexRouterConnection({
      CODING_TOOLS_CODEX_ROUTER_URL: "http://127.0.0.1:4202",
      CODING_TOOLS_CODEX_ROUTER_CALLER_KEY: CALLER_KEY,
    })!;
    const redacted = redactRouterError(
      `failed at ${connection.baseUrl}/responses with ${CALLER_KEY}`,
      connection,
    );
    expect(redacted).not.toContain(CALLER_KEY);
    expect(redacted).toContain("[REDACTED]");
  });

  test("defines CommandCode Proxy as a Codex Router openai-chat provider", () => {
    expect(commandCodeProxyProviderProfile("http://127.0.0.1:3050/v1/"))
      .toEqual({
        id: "commandcode-proxy",
        name: "CommandCode Proxy",
        baseUrl: "http://127.0.0.1:3050/v1",
        adapter: "openai-chat",
        modelEndpoint: "/models",
      });
    expect(() => commandCodeProxyProviderProfile("http://commandcode.example/v1"))
      .toThrow("loopback or HTTPS");
  });

  test("imports router models as isolated native-subagent catalog rows", async () => {
    const connection = resolveCodexRouterConnection({
      CODING_TOOLS_CODEX_ROUTER_URL: "http://127.0.0.1:4202",
      CODING_TOOLS_CODEX_ROUTER_CALLER_KEY: CALLER_KEY,
    })!;
    const original = nativeCatalog();
    const snapshot = structuredClone(original);
    const calls: string[] = [];
    const fetchImpl = async (input: RequestInfo | URL): Promise<Response> => {
      calls.push(String(input));
      return Response.json({
        object: "list",
        data: [
          { id: "deepseek/deepseek-v4-pro", object: "model", owned_by: "deepseek" },
          { id: "commandcode-proxy/claude-sonnet-4-6", object: "model", owned_by: "commandcode-proxy" },
          { id: "deepseek/deepseek-v4-pro", object: "model", owned_by: "deepseek" },
        ],
      });
    };
    const config = defaultConfig("full");
    config.subagentProtocol = "native";
    const result = await augmentWithCodexRouterModels(original, config, connection, fetchImpl);
    const models = result.models as Array<Record<string, unknown>>;

    expect(original).toEqual(snapshot);
    expect(calls).toEqual([`${connection.baseUrl}/models`]);
    expect(models.slice(0, 2)).toEqual(snapshot.models as Array<Record<string, unknown>>);
    expect(models.slice(2).map(model => model.slug)).toEqual([
      "codex-router/deepseek/deepseek-v4-pro",
      "codex-router/commandcode-proxy/claude-sonnet-4-6",
    ]);
    expect(models[2]).toMatchObject({
      display_name: "deepseek/deepseek-v4-pro (Codex Router)",
      visibility: "list",
      supported_in_api: true,
      multi_agent_version: "v2",
      tool_mode: null,
      additional_speed_tiers: [],
      service_tiers: [],
      default_service_tier: null,
    });
    expect(models[2]).not.toHaveProperty("comp_hash");
  });

  test("keeps the base catalog usable when router discovery is unavailable", async () => {
    const connection = resolveCodexRouterConnection({
      CODING_TOOLS_CODEX_ROUTER_URL: "http://127.0.0.1:4202",
      CODING_TOOLS_CODEX_ROUTER_CALLER_KEY: CALLER_KEY,
    })!;
    const original = nativeCatalog();
    const result = await augmentWithCodexRouterModels(
      original,
      defaultConfig("full"),
      connection,
      async () => new Response("offline", { status: 503 }),
    );
    expect(result).toEqual(original);
    expect(result).not.toBe(original);
  });

  test("forwards routed Responses without buffering the upstream stream", async () => {
    const connection = resolveCodexRouterConnection({
      CODING_TOOLS_CODEX_ROUTER_URL: "http://127.0.0.1:4202",
      CODING_TOOLS_CODEX_ROUTER_CALLER_KEY: CALLER_KEY,
    })!;
    const seen: Array<{ url: string; body: Record<string, unknown> }> = [];
    const encoder = new TextEncoder();
    const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      seen.push({
        url: String(input),
        body: JSON.parse(String(init?.body)),
      });
      return new Response(new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoder.encode("data: {\"type\":\"response.completed\"}\n\n"));
          controller.close();
        },
      }), {
        status: 200,
        headers: { "content-type": "text/event-stream", "x-router": "ok" },
      });
    };
    const raw = {
      model: "codex-router/deepseek/deepseek-v4-pro",
      input: [{ role: "user", content: "hello" }],
      stream: true,
    };
    const response = await forwardCodexRouterResponse(
      new Request("http://127.0.0.1:17841/v1/responses", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(raw),
      }),
      raw,
      connection,
      fetchImpl,
    );

    expect(seen).toEqual([{
      url: `${connection.baseUrl}/responses`,
      body: { ...raw, model: "deepseek/deepseek-v4-pro" },
    }]);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    expect(response.headers.get("x-router")).toBe("ok");
    expect(await response.text()).toContain("response.completed");
  });
});
