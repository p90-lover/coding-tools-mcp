import { describe, expect, test } from "bun:test";
import {
  filterRouterWebCatalog,
  routeRouterWebResponse,
  routerWebModelsResponse,
} from "../src/router-web-ingress";

describe("restricted Coding Tools Web router ingress", () => {
  test("publishes only chatgpt-web models without mutating the source catalog", async () => {
    const source = {
      object: "list",
      revision: "fixture",
      models: [
        { slug: "gpt-5.6-sol", display_name: "Native Sol" },
        { slug: "chatgpt-web/high", display_name: "Web High" },
        { slug: "codex-router/deepseek/deepseek-v4-pro", display_name: "Routed DeepSeek" },
        { slug: "chatgpt-web/pro", display_name: "Web Pro" },
      ],
    };
    const before = structuredClone(source);

    const filtered = filterRouterWebCatalog(source);
    expect(source).toEqual(before);
    expect(filtered).toEqual({
      object: "list",
      revision: "fixture",
      models: [
        { slug: "chatgpt-web/high", display_name: "Web High" },
        { slug: "chatgpt-web/pro", display_name: "Web Pro" },
      ],
    });

    const response = await routerWebModelsResponse(new Response(JSON.stringify(source), {
      status: 200,
      headers: {
        "content-type": "application/json",
        "content-encoding": "gzip",
        "content-length": "999",
        "x-source": "native-plus-web",
      },
    }));
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(response.headers.get("content-encoding")).toBeNull();
    expect(response.headers.get("content-length")).toBeNull();
    expect(response.headers.get("x-source")).toBe("native-plus-web");
    expect((await response.json() as { models: Array<{ slug: string }> }).models.map(model => model.slug))
      .toEqual(["chatgpt-web/high", "chatgpt-web/pro"]);
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
      expect((await request.clone().json() as { model: string }).model).toBe("chatgpt-web/high");
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
});
