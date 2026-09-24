import { expect, test } from "bun:test";
import { createResponsesWebsocketHandlers, upgradeResponsesWebsocket } from "../src/responses-websocket";

test("generated WebSocket requests reach the response handler after prewarm and retain useful HTTP errors", async () => {
  const requests: Request[] = [];
  const handlers = createResponsesWebsocketHandlers({
    isDraining: () => false,
    createResponse: async request => {
      requests.push(request);
      return new Response("private upstream diagnostic", { status: 503 });
    },
  });
  const server = Bun.serve<Parameters<typeof handlers.open>[0]["data"]>({
    port: 0,
    hostname: "127.0.0.1",
    fetch: (request, activeServer) => upgradeResponsesWebsocket(request, activeServer, false),
    websocket: handlers,
  });
  const socket = new WebSocket(`ws://127.0.0.1:${server.port}/v1/responses`);
  try {
    const failure = await new Promise<Record<string, unknown>>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("WebSocket response timed out")), 3_000);
      socket.addEventListener("error", () => {
        clearTimeout(timeout);
        reject(new Error("WebSocket connection failed"));
      });
      socket.addEventListener("open", () => socket.send(JSON.stringify({
        type: "response.create", generate: false, model: "chatgpt-web/high", input: [],
      })));
      socket.addEventListener("message", event => {
        const message = JSON.parse(String(event.data));
        if (message.type === "response.completed") {
          socket.send(JSON.stringify({
            type: "response.create", stream_id: "actual-turn", model: "chatgpt-web/high",
            input: [{ role: "user", content: "hello" }],
          }));
        }
        if (message.type === "error") {
          clearTimeout(timeout);
          resolve(message);
        }
      });
    });
    expect(requests).toHaveLength(1);
    expect(await requests[0]!.json()).toMatchObject({
      model: "chatgpt-web/high", stream: true, input: [{ role: "user", content: "hello" }],
    });
    expect(failure).toEqual({
      type: "error", stream_id: "actual-turn",
      error: { message: "Responses request failed (HTTP 503)", type: "server_error", status: 503 },
    });
  } finally {
    socket.close();
    await server.stop(true);
  }
});
