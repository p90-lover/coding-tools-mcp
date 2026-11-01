import { expect, test } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { defaultConfig } from "../src/config";
import { parseRequest } from "../src/responses/parser";
import { expandPreviousResponseInput, flushResponseState, rememberResponseState } from "../src/responses/state";
import { responseRequest } from "../src/server";

const freeformFormat = {
  type: "grammar",
  syntax: "lark",
  definition: 'start: "tool"',
};

function responsesLiteTools() {
  return [{
    type: "namespace",
    name: "functions",
    description: "",
    tools: [
      { type: "custom", name: "exec", description: "Run native Codex code", format: freeformFormat },
      {
        type: "function",
        name: "wait",
        description: "Wait for native Codex code",
        strict: false,
        parameters: { type: "object", properties: {} },
      },
    ],
  }, {
    type: "namespace",
    name: "mcp__python",
    description: "Python tools",
    tools: [{
      type: "custom",
      name: "run_script",
      description: "Run a Python script",
      format: freeformFormat,
    }],
  }];
}

test("Responses Lite exposes native exec from the default functions namespace only", () => {
  const parsed = parseRequest({
    model: "chatgpt-web/luna",
    input: [{ type: "additional_tools", role: "developer", tools: responsesLiteTools() }],
  });

  expect(parsed.context.tools).toContainEqual(expect.objectContaining({
    name: "exec",
    freeform: true,
    nativeNamespace: "functions",
  }));
  const waitTool = parsed.context.tools?.find(tool => tool.name === "wait");
  expect(waitTool).toEqual(expect.objectContaining({ name: "wait" }));
  expect(waitTool).not.toHaveProperty("namespace");
  expect(parsed.context.tools?.some(tool => tool.name === "run_script")).toBe(false);
});

test("current request tools replace historical Code Mode declarations after a model switch", () => {
  const command = { type: "function", name: "exec_command", parameters: { type: "object", properties: {} } };
  for (const tools of [[command], []]) {
    const parsed = parseRequest({
      model: "chatgpt-web/high",
      tools,
      input: [
        { type: "additional_tools", role: "developer", tools: responsesLiteTools() },
        { type: "custom_tool_call", call_id: "previous_exec", name: "exec", input: "text('previous result')" },
        { type: "custom_tool_call_output", call_id: "previous_exec", output: "previous result" },
        { type: "message", role: "user", content: "Continue with the current model" },
      ],
    });
    expect((parsed.context.tools ?? []).map(tool => tool.name)).toEqual(tools.map(tool => tool.name));
    expect(parsed.context.messages.some(message => message.role === "toolResult"
      && message.toolCallId === "previous_exec" && message.content === "previous result")).toBe(true);
  }
});

test("omitted request tools retain Code Mode and discovered tools during a continuation", () => {
  const parsed = parseRequest({
    model: "chatgpt-web/high",
    input: [
      { type: "additional_tools", role: "developer", tools: responsesLiteTools() },
      { type: "message", role: "user", content: "Continue using the same tools" },
      { type: "custom_tool_call", call_id: "previous_exec", name: "exec", input: "text('previous result')" },
      { type: "custom_tool_call_output", call_id: "previous_exec", output: "previous result" },
      { type: "tool_search_call", call_id: "search", execution: "client", arguments: { query: "preview" } },
      { type: "tool_search_output", call_id: "search", status: "completed", tools: [{
        type: "namespace", name: "panel_verification", tools: [{
          type: "function", name: "preview_read", parameters: { type: "object", properties: {} },
        }],
      }] },
    ],
  });
  expect(parsed.context.tools).toContainEqual(expect.objectContaining({ name: "exec", freeform: true }));
  expect(parsed.context.tools).toContainEqual(expect.objectContaining({ name: "wait" }));
  expect(parsed.context.tools).toContainEqual(expect.objectContaining({ name: "preview_read", namespace: "panel_verification" }));
});

test("deferred discovery is scoped to the current user turn across response continuations", () => {
  const storageRoot = resolve(import.meta.dir, "../../aiTemp", `deferred-tools-${crypto.randomUUID()}`);
  const previousHome = process.env.CODEX_CHATGPT_WEB_HOME;
  mkdirSync(storageRoot, { recursive: true });
  process.env.CODEX_CHATGPT_WEB_HOME = storageRoot;
  try {
    for (const provenance of ["request", "user", "none"]) {
      const turnId = `discovery_${provenance}`;
      const nextTurn = `${turnId}_next`;
      const discoveryId = `response_${crypto.randomUUID()}`;
      const callId = `search_${provenance}`;
      const tools = [{ type: "tool_search" }];
      const discoveredTools = [{ type: "namespace", name: "mcp__panel_verification", tools: [{
        type: "function", name: "preview_read", parameters: { type: "object", properties: {} },
      }] }];
      const metadata = provenance === "request" ? { metadata: { turn_id: turnId } } : {};
      const itemMetadata = provenance !== "none" ? { internal_chat_message_metadata_passthrough: { turn_id: turnId } } : {};
      const request = { model: "chatgpt-web/high", tools, ...metadata,
        input: [{ type: "message", role: "user", content: "Read the live panel", ...itemMetadata }] };
      rememberResponseState(request, { id: discoveryId, status: "completed", output: [{
        type: "tool_search_call", call_id: callId, execution: "client", arguments: { query: "preview" },
      }] });
      const discovered = expandPreviousResponseInput({ model: request.model, tools, ...metadata,
        previous_response_id: discoveryId, input: [{ type: "tool_search_output", call_id: callId,
          status: "completed", tools: discoveredTools, ...itemMetadata }] }) as Record<string, unknown>;
      const expected = expect.objectContaining({ name: "preview_read", namespace: "mcp__panel_verification" });
      expect(parseRequest(discovered).context.tools).toContainEqual(expected);

      const readId = `response_${crypto.randomUUID()}`;
      rememberResponseState(discovered, { id: readId, status: "completed", output: [{
        type: "function_call", call_id: `read_${provenance}`, name: "preview_read",
        namespace: "mcp__panel_verification", arguments: "{}",
      }] });
      const continued = expandPreviousResponseInput({ model: request.model, tools, ...metadata,
        previous_response_id: readId, input: [{ type: "function_call_output", call_id: `read_${provenance}`, output: "Counter: 0" }] });
      expect(parseRequest(continued).context.tools).toContainEqual(expected);
      expect(parseRequest(continued).context.messages.at(-1)).toMatchObject({ role: "toolResult", content: "Counter: 0" });
      if (provenance !== "none") {
        expect(parseRequest({ ...discovered, input: [...discovered.input as unknown[],
          { type: "message", role: "user", content: "Same-turn context", ...itemMetadata },
        ] }).context.tools).toContainEqual(expected);
      }

      const later = expandPreviousResponseInput({ model: request.model, tools,
        ...(provenance === "request" ? { metadata: { turn_id: nextTurn } } : {}), previous_response_id: readId,
        input: [{ type: "message", role: "user", content: "A later user turn or fork",
          ...(provenance !== "none" ? { internal_chat_message_metadata_passthrough: { turn_id: nextTurn } } : {}) }] }) as Record<string, unknown>;
      const parsedLater = parseRequest(later);
      expect(parsedLater.context.tools?.map(tool => tool.name)).toEqual(["tool_search"]);
      expect(parsedLater.context.messages.some(message => message.role === "toolResult"
        && message.toolCallId === callId && typeof message.content === "string"
        && message.content.includes("preview_read"))).toBe(true);
      if (provenance === "request") {
        expect(parseRequest({ ...discovered, metadata: { turn_id: nextTurn } }).context.tools?.map(tool => tool.name))
          .toEqual(["tool_search"]);
      }
      const rediscovered = parseRequest({ ...later, input: [...later.input as unknown[],
        { type: "tool_search_call", call_id: `${callId}_fresh`, execution: "client", arguments: { query: "preview" } },
        { type: "tool_search_output", call_id: `${callId}_fresh`, status: "completed", tools: discoveredTools,
          ...(provenance !== "none" ? { internal_chat_message_metadata_passthrough: { turn_id: nextTurn } } : {}) },
      ] });
      expect(rediscovered.context.tools).toContainEqual(expected);
      expect(parseRequest({ ...later, tools: discoveredTools }).context.tools).toContainEqual(expected);
    }
  } finally {
    flushResponseState();
    if (previousHome === undefined) delete process.env.CODEX_CHATGPT_WEB_HOME;
    else process.env.CODEX_CHATGPT_WEB_HOME = previousHome;
    rmSync(storageRoot, { recursive: true, force: true });
  }
});

test("Responses Lite native tools preserve declared namespaces in JSON and SSE without qualifying legacy calls", async () => {
  const config = defaultConfig("full");
  config.solAvailable = false;
  config.proAvailable = false;
  for (const declaredNamespace of [true, false]) for (const stream of [false, true]) {
    const turnId = `turn_responses_lite_exec_${declaredNamespace}_${stream}`;
    const response = await responseRequest(new Request("http://127.0.0.1:17841/v1/responses", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "chatgpt-web/luna",
        stream,
        metadata: { turn_id: turnId, thread_id: "thread_responses_lite_exec_regression" },
        input: [{
          type: "additional_tools",
          role: "developer",
          tools: declaredNamespace ? responsesLiteTools().slice(0, 1) : responsesLiteTools()[0]!.tools,
        }, {
          type: "message",
          id: "msg_responses_lite_exec_regression",
          role: "user",
          content: [{ type: "input_text", text: "Use the native exec tool" }],
          internal_chat_message_metadata_passthrough: { turn_id: turnId },
        }],
      }),
    }), config, () => ({
      name: "responses-lite-exec-regression",
      async runTurn(parsed, _incoming, emit) {
        expect(parsed.context.tools).toContainEqual(expect.objectContaining({ name: "exec", freeform: true }));
        emit({ type: "tool_call_start", id: "call_exec", name: "exec" });
        emit({ type: "tool_call_delta", arguments: JSON.stringify({ input: "text('ok')" }) });
        emit({ type: "tool_call_end" });
        emit({ type: "tool_call_start", id: "call_wait", name: "wait" });
        emit({ type: "tool_call_delta", arguments: "{}" });
        emit({ type: "tool_call_end" });
        emit({ type: "done", endTurn: false });
      },
    }), { rememberState: false });

    expect(response.status).toBe(200);
    const outputs: Array<Array<Record<string, unknown>>> = [];
    if (stream) {
      const events = (await response.text()).split("\n").filter(line => line.startsWith("data: ") && line !== "data: [DONE]")
        .map(line => JSON.parse(line.slice(6)));
      for (const type of ["response.output_item.added", "response.output_item.done"]) {
        outputs.push(events.filter(event => event.type === type).map(event => event.item));
      }
      outputs.push(events.find(event => event.type === "response.completed").response.output);
    } else {
      const body = await response.json() as { output: Array<Record<string, unknown>> };
      outputs.push(body.output);
    }
    for (const calls of outputs) {
      expect(calls.map(({ type, name, namespace }) => ({ type, name, namespace }))).toEqual([
        { type: "custom_tool_call", name: "exec", namespace: declaredNamespace ? "functions" : undefined },
        { type: "function_call", name: "wait", namespace: declaredNamespace ? "functions" : undefined },
      ]);
      if (!declaredNamespace) for (const call of calls) expect(call).not.toHaveProperty("namespace");
    }
    expect(outputs.at(-1)![0]).toMatchObject({ call_id: "call_exec", input: "text('ok')" });
  }
});
