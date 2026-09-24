import { describe, expect, test } from "bun:test";
import { defaultConfig } from "../src/config";
import { readJsonRequestBody } from "../src/http-body";
import {
  routeRouterWebResponse,
  routerWebModelCatalog,
  routerWebModelsResponse,
} from "../src/router-web-ingress";
import { startServer } from "../src/server";

describe("restricted Coding Tools Web router ingress", () => {
  test("builds a standard provider catalog directly from enabled chatgpt-web routes", async () => {
    const config = defaultConfig("full");
    config.solAvailable = true;
    config.proAvailable = true;
    const catalog = routerWebModelCatalog(config);

    expect(catalog.object).toBe("list");
    expect(Array.isArray(catalog.data)).toBe(true);
    const ids = catalog.data.map(model => model.id);
    // Sol-capable accounts publish one Latest route; effort comes from the ChatGPT web slider.
    expect(ids).toEqual(["chatgpt-web/latest"]);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.every(id => id.startsWith("chatgpt-web/"))).toBe(true);
    expect(ids.some(id => id.startsWith("codex-router/"))).toBe(false);
    expect(ids).not.toContain("gpt-5.6-sol");
    expect(catalog.data.every(model => model.object === "model" && model.owned_by === "coding-tools-web"))
      .toBe(true);

    const response = routerWebModelsResponse(config);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(response.headers.get("cache-control")).toBe("no-store");
    const responseCatalog = await response.json() as typeof catalog;
    expect(responseCatalog).toEqual(catalog);
  });

  test("rejects native, router, missing, and malformed model selections before dispatch", async () => {
    let calls = 0;
    const handler = async (): Promise<Response> => {
      calls += 1;
      return new Response("unexpected");
    };
    for (const body of [
      { model: "gpt-5.6-sol", input: [] },
      { model: "codex-router/deepseek/deepseek-v4-pro", input: [] },
      { input: [] },
      { model: 123, input: [] },
    ]) {
      const response = await routeRouterWebResponse(new Request("http://127.0.0.1/router/v1/responses", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }), handler);
      expect(response.status).toBe(400);
      const text = await response.text();
      expect(text).toContain("chatgpt-web/");
    }
    expect(calls).toBe(0);
  });

  test("delegates an allowed Web request once and preserves its streaming response", async () => {
    let calls = 0;
    const encoder = new TextEncoder();
    const handler = async (request: Request): Promise<Response> => {
      calls += 1;
      expect((await readJsonRequestBody(request) as { model: string }).model).toBe("chatgpt-web/high");
      expect(request.bodyUsed).toBe(false);
      return new Response(new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoder.encode("data: {\"type\":\"response.completed\"}\n\n"));
          controller.close();
        },
      }), {
        status: 200,
        headers: {
          "content-type": "text/event-stream",
          "x-web-ingress": "ok",
        },
      });
    };

    const response = await routeRouterWebResponse(new Request("http://127.0.0.1/router/v1/responses", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "chatgpt-web/high", input: [], stream: true }),
    }), handler);

    expect(calls).toBe(1);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    expect(response.headers.get("x-web-ingress")).toBe("ok");
    expect(await response.text()).toContain("response.completed");
  });

  test("preserves native /goal context after replacing the decoded request body", async () => {
    const goalText = [
      '<codex_internal_context source="goal">',
      "Continue working toward the active objective.",
      "</codex_internal_context>",
    ].join("\n");
    const body = {
      model: "chatgpt-web/high",
      input: [{
        type: "message",
        role: "user",
        id: "goal-context-1",
        content_item_kinds: ["goal.internal_context"],
        content: [{ type: "input_text", text: goalText }],
      }],
      stream: true,
    };
    const request = new Request("http://127.0.0.1/router/v1/responses", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "content-length": String(JSON.stringify(body).length),
      },
      body: JSON.stringify(body),
    });

    const response = await routeRouterWebResponse(request, async validatedRequest => {
      expect(validatedRequest).not.toBe(request);
      expect(request.bodyUsed).toBe(true);
      expect(validatedRequest.bodyUsed).toBe(false);
      expect(validatedRequest.headers.get("content-length")).toBeNull();
      expect(validatedRequest.headers.get("content-encoding")).toBeNull();
      const parsed = await readJsonRequestBody(validatedRequest) as typeof body;
      expect(validatedRequest.bodyUsed).toBe(false);
      expect(parsed).toEqual(body);
      expect(parsed.input[0]!.content_item_kinds).toEqual(["goal.internal_context"]);
      expect(parsed.input[0]!.content[0]!.text).toBe(goalText);
      return Response.json({ ok: true });
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
  });

  test("serves bearer-free Web discovery and rejects router recursion on the real listener", async () => {
    const config = defaultConfig("browser-only");
    config.port = 0;
    config.solAvailable = true;
    config.proAvailable = false;
    let adapterCalls = 0;
    const server = startServer(config, {
      adapterFactory: () => {
        adapterCalls += 1;
        throw new Error("adapter should not be reached by rejected router ingress");
      },
    });
    try {
      const base = `http://127.0.0.1:${server.port}`;
      const catalogResponse = await fetch(`${base}/router/v1/models`);
      expect(catalogResponse.status).toBe(200);
      const catalog = await catalogResponse.json() as { data: Array<{ id: string }> };
      expect(catalog.data.length).toBeGreaterThan(0);
      expect(catalog.data.every(model => model.id.startsWith("chatgpt-web/"))).toBe(true);

      const recursive = await fetch(`${base}/router/v1/responses`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "codex-router/deepseek/deepseek-v4-pro",
          input: [],
          stream: true,
        }),
      });
      expect(recursive.status).toBe(400);
      expect(await recursive.text()).toContain("chatgpt-web/");
      expect(adapterCalls).toBe(0);
    } finally {
      await server.stop(true);
    }
  });
});
