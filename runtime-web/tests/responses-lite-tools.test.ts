import { expect, test } from "bun:test";
import { defaultConfig } from "../src/config";
import { parseRequest } from "../src/responses/parser";
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
      { type: "custom_tool_call", call_id: "previous_exec", name: "exec", input: "text('previous result')" },
      { type: "custom_tool_call_output", call_id: "previous_exec", output: "previous result" },
      { type: "tool_search_call", call_id: "search", execution: "client", arguments: { query: "preview" } },
      { type: "tool_search_output", call_id: "search", status: "completed", tools: [{
        type: "namespace", name: "panel_verification", tools: [{
          type: "function", name: "preview_read", parameters: { type: "object", properties: {} },
        }],
      }] },
      { type: "message", role: "user", content: "Continue using the same tools" },
    ],
  });
  expect(parsed.context.tools).toContainEqual(expect.objectContaining({ name: "exec", freeform: true }));
  expect(parsed.context.tools).toContainEqual(expect.objectContaining({ name: "wait" }));
  expect(parsed.context.tools).toContainEqual(expect.objectContaining({ name: "preview_read", namespace: "panel_verification" }));
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
