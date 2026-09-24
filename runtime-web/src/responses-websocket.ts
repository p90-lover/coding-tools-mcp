import type { Server, ServerWebSocket } from "bun";
import { rememberResponseState } from "./responses/state";

export function responsesWebsocketUnavailable(): Response {
  return new Response(
    "Responses WebSocket transport is not enabled on this local route",
    {
      status: 426,
      headers: { "content-type": "text/plain; charset=utf-8" },
    },
  );
}

type ResponsesWsData = {
  headers: Headers;
  abort: AbortController;
  lanes: Map<string, Promise<void>>;
};

export interface ResponsesWebsocketContext {
  isDraining: () => boolean;
  createResponse: (request: Request) => Promise<Response>;
}

function uuid(): string {
  return crypto.randomUUID().replace(/-/g, "");
}

function streamKey(streamId: unknown): string {
  return typeof streamId === "string" && streamId.length > 0 ? streamId : "";
}

function withStreamId(event: Record<string, unknown>, streamId: string): Record<string, unknown> {
  return streamId ? { ...event, stream_id: streamId } : event;
}

function sendJson(ws: ServerWebSocket<ResponsesWsData>, event: Record<string, unknown>): void {
  if (ws.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify(event));
}

function sendError(
  ws: ServerWebSocket<ResponsesWsData>,
  error: Record<string, unknown>,
  streamId = "",
): void {
  sendJson(ws, withStreamId({ type: "error", error }, streamId));
}

function parseClientEvent(raw: string | Buffer): Record<string, unknown> | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(typeof raw === "string" ? raw : raw.toString("utf8"));
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
  const event = parsed as Record<string, unknown>;
  if (event.type === "message" && event.message && typeof event.message === "object" && !Array.isArray(event.message)) {
    return event.message as Record<string, unknown>;
  }
  return event;
}

function responsesHeaders(source: Headers): Headers {
  const headers = new Headers();
  for (const [name, value] of source) {
    const lower = name.toLowerCase();
    if (
      lower === "connection"
      || lower === "upgrade"
      || lower === "host"
      || lower === "content-length"
      || lower.startsWith("sec-websocket-")
    ) continue;
    headers.append(name, value);
  }
  headers.set("content-type", "application/json");
  return headers;
}

function createBody(event: Record<string, unknown>): Record<string, unknown> {
  const body = { ...event };
  delete body.type;
  delete body.stream_id;
  delete body.generate;
  delete body.client_metadata;
  body.stream = true;
  return body;
}

function warmupResponse(model: string): Record<string, unknown> {
  return {
    id: `resp_${uuid()}`,
    object: "response",
    created_at: Math.floor(Date.now() / 1000),
    status: "completed",
    model,
    output: [],
    usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
  };
}

function consumeSse(buffer: string, onEvent: (data: string) => void): string {
  let start = 0;
  while (true) {
    const lf = buffer.indexOf("\n\n", start);
    const crlf = buffer.indexOf("\r\n\r\n", start);
    let at = -1;
    let skip = 0;
    if (lf >= 0 && (crlf < 0 || lf <= crlf)) {
      at = lf;
      skip = 2;
    } else if (crlf >= 0) {
      at = crlf;
      skip = 4;
    } else break;
    const block = buffer.slice(start, at);
    start = at + skip;
    const dataLines: string[] = [];
    for (const line of block.split(/\r?\n/)) {
      if (line.startsWith("data:")) dataLines.push(line.slice(5).trimStart());
    }
    if (dataLines.length > 0) onEvent(dataLines.join("\n"));
  }
  return buffer.slice(start);
}

async function forwardHttpResponse(
  response: Response,
  ws: ServerWebSocket<ResponsesWsData>,
  streamId: string,
): Promise<void> {
  const contentType = (response.headers.get("content-type") ?? "").toLowerCase();
  if (!contentType.includes("text/event-stream")) {
    // Read once: json() consumes the body even when parsing a text error fails.
    const responseText = await response.text();
    let payload: unknown;
    try {
      payload = JSON.parse(responseText);
    } catch {
      payload = null;
    }
    const error = payload && typeof payload === "object" && !Array.isArray(payload)
      && "error" in payload
      && (payload as { error: unknown }).error
      && typeof (payload as { error: unknown }).error === "object"
      ? (payload as { error: Record<string, unknown> }).error
      : { message: `Responses request failed (HTTP ${response.status})`, type: "server_error" };
    sendError(ws, { ...error, status: response.status }, streamId);
    return;
  }
  if (!response.body) {
    sendError(ws, { message: "Responses stream was empty", type: "server_error" }, streamId);
    return;
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const chunk = await reader.read();
    if (chunk.done) break;
    buffer += decoder.decode(chunk.value, { stream: true });
    buffer = consumeSse(buffer, data => {
      if (data === "[DONE]") return;
      let frame: unknown;
      try {
        frame = JSON.parse(data);
      } catch {
        return;
      }
      if (!frame || typeof frame !== "object" || Array.isArray(frame)) return;
      sendJson(ws, withStreamId(frame as Record<string, unknown>, streamId));
    });
  }
}

function enqueueLane(data: ResponsesWsData, streamId: string, work: () => Promise<void>): void {
  const previous = data.lanes.get(streamId) ?? Promise.resolve();
  const next = previous.then(work, work);
  data.lanes.set(streamId, next);
}

export function createResponsesWebsocketHandlers(context: ResponsesWebsocketContext) {
  return {
    open(ws: ServerWebSocket<ResponsesWsData>) {
      ws.data.abort = new AbortController();
      ws.data.lanes = new Map();
    },
    close(ws: ServerWebSocket<ResponsesWsData>) {
      ws.data.abort.abort("websocket closed");
    },
    message(ws: ServerWebSocket<ResponsesWsData>, message: string | Buffer) {
      const event = parseClientEvent(message);
      if (!event) {
        sendError(ws, { message: "WebSocket frame must be a JSON object", type: "invalid_request_error" });
        return;
      }
      if (event.type !== "response.create") return;
      const streamId = streamKey(event.stream_id);
      enqueueLane(ws.data, streamId, async () => {
        if (ws.data.abort.signal.aborted || context.isDraining()) return;
        if (event.generate === false) {
          const model = typeof event.model === "string" && event.model ? event.model : "chatgpt-web/medium";
          const response = warmupResponse(model);
          rememberResponseState(createBody(event), response, { force: true });
          const inProgress = { ...response, status: "in_progress" };
          sendJson(ws, withStreamId({ type: "response.created", response: inProgress }, streamId));
          sendJson(ws, withStreamId({ type: "response.in_progress", response: inProgress }, streamId));
          sendJson(ws, withStreamId({ type: "response.completed", response }, streamId));
          return;
        }
        const request = new Request("http://127.0.0.1/v1/responses", {
          method: "POST",
          headers: responsesHeaders(ws.data.headers),
          body: JSON.stringify(createBody(event)),
          signal: ws.data.abort.signal,
        });
        try {
          await forwardHttpResponse(await context.createResponse(request), ws, streamId);
        } catch (error) {
          sendError(ws, {
            message: error instanceof Error ? error.message : String(error),
            type: "server_error",
          }, streamId);
        }
      });
    },
  };
}

export function upgradeResponsesWebsocket(
  req: Request,
  server: Server<ResponsesWsData>,
  draining: boolean,
): Response | undefined {
  if (draining) {
    return new Response(JSON.stringify({
      error: { message: "codex-chatgpt-web is draining for a requested service operation", type: "server_error" },
    }), { status: 503, headers: { "content-type": "application/json" } });
  }
  const upgraded = server.upgrade(req, {
    data: {
      headers: req.headers,
      abort: new AbortController(),
      lanes: new Map<string, Promise<void>>(),
    },
  });
  if (upgraded) return undefined;
  return responsesWebsocketUnavailable();
}
