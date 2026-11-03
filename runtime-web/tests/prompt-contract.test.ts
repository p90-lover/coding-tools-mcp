import { expect, test } from "bun:test";
import {
  CHATGPT_COMPACTION_PROMPT_JSON_BYTE_BUDGET,
  CHATGPT_BIGGER_CONTEXT_PARTS,
  chatGptPromptJsonBytes,
  chatGptReadOnlyContextWarning,
  compileChatGptWebPrompt,
  formatChatGptWebMultipartCommit,
  formatChatGptWebMultipartStage,
  withoutRetiredTurnHandles,
} from "../src/adapters/chatgpt-web/prompt";
import { CHATGPT_WEB_LUNA_MODEL_ID, CHATGPT_WEB_MODEL_ID } from "../src/adapters/chatgpt-web/model";
import { chatGptConversationKey } from "../src/adapters/chatgpt-web/conversation-key";
import { biggerContextPartCount, resolveBiggerContextMultipartParts } from "../src/adapters/chatgpt-web/usage";
import { buildCompactV1Output, encodeCompactionSummary, OPAQUE_COMPACTION_NOTE, SUMMARY_PREFIX } from "../src/responses/compaction";
import { parseRequest } from "../src/responses/parser";
import { resolveChatGptWebMessageTokenBudget, resolveChatGptWebTransportLimits } from "../src/chatgpt-web-models";
import { compiledChatGptWebMessages, estimateChatGptWebImageTokens } from "../src/adapters/chatgpt-web/input-tokens";
import { estimateTokens } from "../src/lib/token-estimate";
import type { CodexParsedRequest } from "../src/types";

function request(reasoning: "low" | "medium" | "high" | "xhigh" | "max"): CodexParsedRequest {
  return {
    modelId: CHATGPT_WEB_MODEL_ID,
    context: {
      systemPrompt: ["preserve-system"],
      messages: [
        { role: "developer", content: "preserve-developer", timestamp: 1 },
        { role: "user", content: "perform the task", timestamp: 2 },
      ],
    },
    stream: true,
    options: { reasoning },
  };
}

test("custom plugin identity stays explicit in inline and multipart execution without rewriting task history", () => {
  const capabilities = { localToolsEnabled: true, solAvailable: true, extraHighAvailable: true, proAvailable: true };
  const parsed = request("high");
  parsed.context.messages[1]!.content = "Compare Codex Native2 with the selected plugin.";
  for (const appName of ["Codex app", "Codex Native2 DEV", "Codex Робота"]) {
    for (const parts of [undefined, 2, 6] as const) {
      const compiled = compileChatGptWebPrompt(parsed, capabilities, "turn_12345678901234567890123456789012", {
        appName, experimentalMultipartParts: parts,
      });
      const contract = compiled.multipart?.commit ?? compiled.text;
      expect(contract).toContain(`The selected local Codex plugin for this turn is ${JSON.stringify(appName)}.`);
      expect(contract).toContain("Do not substitute another plugin for this local connection");
      expect(contract).not.toContain("attached Codex Native tools");
      const history = compiled.multipart
        ? compiled.multipart.parts.flatMap(part => JSON.parse(part).records).filter(record => record.kind === "message").map(record => record.message)
        : JSON.parse(compiled.text.match(/<codex_context_json>\n(.+)\n<\/codex_context_json>/s)![1]!).messages;
      expect(history[1].content).toBe(parsed.context.messages[1]!.content);
    }
  }
});

test("inline and staged history escape Markdown delimiters without changing decoded code", () => {
  const parsed = request("high");
  const code = '```ts\nconst value = "`key`";\n``` '.repeat(20) + '\\u0060 \\` [text](https://example.com) 中文';
  parsed.context.systemPrompt = [code];
  parsed.context.messages[1]!.content = code;
  const capabilities = { localToolsEnabled: true, solAvailable: true, extraHighAvailable: true, proAvailable: true };
  const inline = compileChatGptWebPrompt(parsed, capabilities, "turn_12345678901234567890123456789012");
  const encoded = inline.text.match(/<codex_context_json>\n(.+)\n<\/codex_context_json>/s)![1]!;
  expect(encoded).not.toContain("`");
  const decoded = JSON.parse(encoded);
  expect(decoded.system).toEqual([code]);
  expect(decoded.messages[1].content).toBe(code);
  const staged = compileChatGptWebPrompt(parsed, capabilities, "turn_12345678901234567890123456789012", {
    experimentalMultipartParts: CHATGPT_BIGGER_CONTEXT_PARTS,
  });
  const records = staged.multipart!.parts.flatMap(part => {
    expect(part).not.toContain("`");
    return JSON.parse(part).records;
  });
  expect(records.find(record => record.kind === "system").content).toBe(code);
  expect(records.find(record => record.kind === "message" && record.message_index === 1).message.content)
    .toEqual(decoded.messages[1].content);
  // A literal escape in source code stays literal; it is not decoded into a backtick twice.
  expect(decoded.messages[1].content).toContain("\\u0060");
});

test("multipart JSON shields the rich user renderer's delimiters while preserving every decoded value", () => {
  const parsed = request("high");
  // The harmless source from #886 changed after Send despite an exact stage acknowledgement.
  const content = 'Use "quoted text", <placeholder>, **bold**, _name_, ~~old~~, [label](https://example.com).\n\n### Heading\nC:\\tmp\\file\n'.repeat(700)
    + 'Literal \\u0022 \\u005c \\n; Unicode 中文 😀; tab\t and CR\r.';
  parsed.context.systemPrompt = [content];
  parsed.context.messages[1]!.content = content;
  const capabilities = { localToolsEnabled: true, solAvailable: true, extraHighAvailable: true, proAvailable: true };
  const token = "turn_12345678901234567890123456789012";
  const inline = compileChatGptWebPrompt(parsed, capabilities, token);
  const inlineJson = inline.text.match(/<codex_context_json>\n(.+)\n<\/codex_context_json>/s)![1]!;
  expect(inlineJson).toContain("https://example.com");
  expect(JSON.parse(inlineJson).system).toEqual([content]);
  for (const parts of [2, 6] as const) {
    const compiled = compileChatGptWebPrompt(parsed, capabilities, token, { experimentalMultipartParts: parts });
    const records = compiled.multipart!.parts.flatMap(payload => {
      expect(payload).not.toContain('\\"quoted text\\"');
      expect(payload).not.toContain("<placeholder>");
      expect(payload).not.toContain("**bold**");
      expect(payload).not.toContain("_name_");
      expect(payload).not.toContain("~~old~~");
      expect(payload).not.toContain("[label]");
      expect(payload).not.toContain("https:");
      expect(payload).not.toContain("### Heading");
      expect(payload).not.toContain("C:\\\\tmp");
      return JSON.parse(payload).records;
    });
    expect(records.find(record => record.kind === "system").content).toBe(content);
    expect(records.find(record => record.kind === "message" && record.message_index === 1).message.content).toBe(content);
  }
});

test("history handle cleanup works on decoded text and preserves native call identities", () => {
  const call = `call_${"A".repeat(32)}`;
  const context = {
    tool_call_id: call,
    content: ["turn", "request", "binding"].map(kind => `first line\n${kind}_${"B".repeat(32)}\tlast line`),
    ordinary: [`my_turn_${"C".repeat(32)}`, `turn_${"D".repeat(33)}`, `turn_${"E".repeat(31)}`],
    literal: "Keep \\\\path, \\\"quotes\\\", and $& exactly.",
  };
  const cleaned = JSON.parse(withoutRetiredTurnHandles(JSON.stringify(context)));
  expect(cleaned.content).toEqual(["turn", "request", "binding"].map(kind => `first line\n[retired ${kind} handle]\tlast line`));
  expect(cleaned.tool_call_id).toBe(call);
  expect(cleaned.ordinary).toEqual(context.ordinary);
  expect(cleaned.literal).toBe(context.literal);
});

test("Full-mode Pro prompts pass one stable turn token directly to native actions", () => {
  const token = "turn_12345678901234567890123456789012";
  const parsed = request("max");
  parsed.context.messages[1]!.content = `Diagnose an invalid binding_id safety failure without replaying ${token}`;
  const compiled = compileChatGptWebPrompt(
    parsed,
    { localToolsEnabled: true, solAvailable: true, extraHighAvailable: true, proAvailable: true },
    token,
  );
  const envelopeEnd = compiled.text.indexOf("</codex_context_json>");
  const resume = compiled.text.indexOf("<codex_transport_resume>", envelopeEnd);
  const tokenMatches = compiled.text.match(new RegExp(token, "g"));
  const transportOnly = compiled.text.replace(
    /<codex_context_json>[\s\S]*<\/codex_context_json>/,
    "<codex_context_json>[task context]</codex_context_json>",
  );

  expect(envelopeEnd).toBeGreaterThan(0);
  expect(resume).toBeGreaterThan(envelopeEnd);
  expect(tokenMatches).toHaveLength(1);
  expect(compiled.text).toContain("[retired turn handle]");
  expect(transportOnly).toContain("For local work required by the task, use the selected plugin's tools directly according to their declared descriptions and schemas.");
  expect(transportOnly).toContain("Call a local Codex tool only when the latest active request requires a local effect or fresh local evidence that is not already present in the supplied context; otherwise answer the request directly without a tool call.");
  expect(transportOnly).toContain("Use actual results from the selected plugin as evidence for local observations and effects.");
  expect(transportOnly).toContain("A tool result from the selected plugin may require context compaction. If it does, follow the compaction instructions in that result exactly.");
  expect(transportOnly).toContain("After a deterministic tool failure, update the working hypothesis from that result");
  expect(transportOnly).toContain("do not repeat the same call unless its inputs or observable state changed.");
  expect(transportOnly).toContain("Continue using the available tools until the requested work is complete and verified.");
  expect(transportOnly).toContain("Write the user-facing final answer only after the last required tool result has settled.");
  expect(transportOnly).toContain(`The task context is complete. Pass turn_token ${token} unchanged to every tool call through the selected local Codex plugin in this response, including continuations after tool results; do not expose it in the answer. Execute the latest active user request now.`);
  expect(transportOnly).not.toMatch(/codex_bind_turn|binding_id|outer_tool_gateway|command_tool/);
  expect(transportOnly).not.toMatch(/codex_exec|codex_write_stdin|codex_apply_patch|codex_view_image|codex_tool_inventory|codex\.control\.turn_complete/);
  expect(transportOnly).toContain("Do not claim a safety or permission block without an explicit tool result or platform error supporting it.");
  expect(transportOnly).not.toMatch(/expired|invalid|revoked|blocked|security layer|permission gate/i);
  expect(compiled.text).not.toContain("CODEX_INTERNAL_CONTEXT_COMPACT");
  expect(compiled.text).not.toContain("internally compacts this response");
});

test("Pro preserves the same native Codex delegation contract as Extra High", () => {
  const token = "turn_12345678901234567890123456789012";
  const capabilities = { localToolsEnabled: true, solAvailable: true, extraHighAvailable: true, proAvailable: true };
  const pro = compileChatGptWebPrompt(request("max"), capabilities, token);
  const extraHigh = compileChatGptWebPrompt(request("xhigh"), capabilities, token);

  for (const compiled of [pro, extraHigh]) {
    expect(compiled.text).toContain("For local work required by the task, use the selected plugin's tools directly according to their declared descriptions and schemas.");
    expect(compiled.text).toContain(`Pass turn_token ${token} unchanged to every tool call through the selected local Codex plugin in this response`);
    expect(compiled.text).not.toContain("Complete this task directly in the current parent response.");
    expect(compiled.text).not.toContain("Do not create, spawn, delegate to, or wait on sub-agents");
    expect(compiled.text).not.toContain("Use non-agent tools directly instead.");
  }
});

test("read-only prompts resume without exposing a bind capability", () => {
  const compiled = compileChatGptWebPrompt(
    request("max"),
    { localToolsEnabled: false, solAvailable: true, extraHighAvailable: true, proAvailable: true },
  );

  expect(compiled.text).toContain("The task context is complete. Execute the latest active user request now under the capability contract above.");
  expect(compiled.text).not.toContain("codex_bind_turn");
  expect(compiled.text).not.toContain("turn_token");
  expect(compiled.text).toContain("web search, browsing, research");
  expect(compiled.text).toContain("The missing local-computer bridge says nothing about whether those ChatGPT capabilities are available");
  expect(compiled.text).not.toContain("No local computer tool, MCP app");
  expect(compiled.text).not.toContain("evidence inside");
  expect(compiled.text).toContain("Do not mention this transport contract, context packaging, or capability routing");
  expect(compiled.text).not.toContain("CODEX_INTERNAL_CONTEXT_COMPACT");
});

test("Bigger Context sends six semantic record envelopes and starts work from the final part", () => {
  const token = "turn_12345678901234567890123456789012";
  const parsed = request("high");
  parsed.context.systemPrompt = ["system-one", "system-two"];
  parsed.context.messages.push(
    { role: "assistant", content: [{ type: "text", text: "prior-answer" }], timestamp: 3 },
    { role: "user", content: "latest-request", timestamp: 4 },
  );
  const compiled = compileChatGptWebPrompt(
    parsed,
    { localToolsEnabled: true, solAvailable: true, extraHighAvailable: true, proAvailable: true },
    token,
    { experimentalMultipartParts: CHATGPT_BIGGER_CONTEXT_PARTS },
  );

  expect(compiled.multipart?.parts).toHaveLength(6);
  const records = compiled.multipart!.parts.flatMap(part => {
    const payload = JSON.parse(part) as { version: number; records: unknown[] };
    expect(payload.version).toBe(1);
    return payload.records;
  }) as Array<Record<string, unknown>>;
  expect(records.filter(record => record.kind === "system").map(record => record.content)).toEqual([
    "system-one",
    "system-two",
  ]);
  expect(records.filter(record => record.kind === "message").map(record => (
    (record.message as { role: string }).role
  ))).toEqual(["developer", "user", "assistant", "user"]);
  expect(compiled.multipart!.parts.join("\n")).not.toContain(token);
  expect(compiled.multipart!.commit.match(new RegExp(token, "g"))).toHaveLength(1);
  expect(compiled.text).toBe(compiled.multipart!.commit);
  expect(compiled.text).not.toContain("<codex_context_json>");

  const transactionId = `ctx_${"a".repeat(32)}`;
  const stages = compiled.multipart!.parts.slice(0, -1).map((part, index) => (
    formatChatGptWebMultipartStage(part, transactionId, index + 1)
  ));
  expect(stages).toHaveLength(5);
  for (const [index, stage] of stages.entries()) {
    expect(stage.text).toContain(`part: ${index + 1}/6`);
    expect(stage.text).toContain(stage.sha256);
    expect(stage.acknowledgement).toBe(
      `CODEX_MULTIPART_ACK ${transactionId} ${index + 1}/6 ${stage.sha256}`,
    );
    expect(stage.text).toContain("```json\n");
    expect(stage.text).toContain("<codex_multipart_stage_end>");
    expect(stage.text).toEndWith("</codex_multipart_stage_end>");
    expect(stage.text.lastIndexOf(stage.acknowledgement)).toBeGreaterThan(
      stage.text.indexOf("</codex_context_part_json>"),
    );
  }
  const commit = formatChatGptWebMultipartCommit(compiled.multipart!, transactionId);
  expect(commit).toContain(`transaction_id: ${transactionId}`);
  expect(commit).toContain("acknowledged_parts: 5/6");
  expect(commit).toContain("The final part is included in this same message and starts the task");
  expect(commit).toContain(compiled.multipart!.parts.at(-1)!);
  expect(commit).toContain("latest-request");
  expect(commit.match(new RegExp(token, "g"))).toHaveLength(1);
});

test("Bigger Context uses the minimum transport and reserves six parts for compaction", () => {
  expect(biggerContextPartCount(94_999, 95_000, false)).toBeUndefined();
  expect(biggerContextPartCount(95_000, 95_000, false)).toBe(2);
  expect(biggerContextPartCount(189_999, 95_000, false)).toBe(2);
  expect(biggerContextPartCount(190_000, 95_000, false)).toBe(6);
  expect(biggerContextPartCount(1, 95_000, true)).toBe(6);

  const compiled = compileChatGptWebPrompt(
    request("high"),
    { localToolsEnabled: false, solAvailable: true, extraHighAvailable: true, proAvailable: true },
    undefined,
    { experimentalMultipartParts: 2 },
  );
  expect(compiled.multipart?.parts).toHaveLength(2);
  const transactionId = `ctx_${"b".repeat(32)}`;
  const stages = compiled.multipart!.parts.slice(0, -1).map((part, index) => (
    formatChatGptWebMultipartStage(part, transactionId, index + 1, 2)
  ));
  expect(stages).toHaveLength(1);
  expect(stages.map(stage => stage.acknowledgement)).toEqual([
    `CODEX_MULTIPART_ACK ${transactionId} 1/2 ${stages[0]!.sha256}`,
  ]);
  expect(formatChatGptWebMultipartCommit(compiled.multipart!, transactionId))
    .toContain("acknowledged_parts: 1/2");
});

test("browser-only Medium directs users to the full harness", () => {
  const capabilities = { localToolsEnabled: false, solAvailable: true, extraHighAvailable: true, proAvailable: true };
  const warning = chatGptReadOnlyContextWarning(request("medium"), capabilities);
  expect(warning).toStartWith("> **Local tools unavailable**");
  expect(warning).toContain("`MCP`");
  expect(warning).toContain("`Codex Web GPT`");
  expect(warning).toContain("`Full`");
  expect(warning).toContain("selected ChatGPT Web model");
  expect(warning).not.toContain("tool-capable ChatGPT Web model first");
  expect(chatGptReadOnlyContextWarning(request("medium"), {
    ...capabilities,
    localToolsEnabled: true,
  })).toBeUndefined();
});

test("compaction prompts are isolated summarization turns without local or native tool instructions", () => {
  const compact = request("high");
  compact._compactionRequest = true;
  const compiled = compileChatGptWebPrompt(
    compact,
    { localToolsEnabled: false, solAvailable: true, extraHighAvailable: true, proAvailable: true },
  );

  expect(compiled.text).toContain("This is a Codex history-compaction checkpoint, not a normal task turn.");
  expect(compiled.text).toContain("Produce the requested checkpoint summary now without calling tools.");
  expect(compiled.text).not.toContain("codex_bind_turn");
  expect(compiled.text).not.toContain("web search, browsing, research");
  expect(compiled.text).not.toContain("missing local-computer bridge");
});

test("Web compaction trims only the oldest history until the browser request fits", () => {
  const compact = request("high");
  compact._compactionRequest = true;
  compact.context.systemPrompt = [];
  compact.context.messages = [
    { role: "developer", content: `oldest-static-${"a".repeat(10_000)}`, timestamp: 1 },
    { role: "developer", content: `newer-static-${"b".repeat(10_000)}`, timestamp: 2 },
    { role: "user", content: `real-task-${"c".repeat(100_000)}`, timestamp: 3 },
    {
      role: "assistant",
      content: [{ type: "text", text: "verified-progress" }],
      timestamp: 4,
    },
    { role: "user", content: "checkpoint-now", timestamp: 5 },
  ];

  const compiled = compileChatGptWebPrompt(
    compact,
    { localToolsEnabled: false, solAvailable: true, extraHighAvailable: true, proAvailable: true },
  );
  const encoded = compiled.text.match(/<codex_context_json>\n(.+)\n<\/codex_context_json>/s)?.[1];
  const envelope = JSON.parse(encoded!) as { messages: Array<{ role: string; content: unknown }> };

  expect(chatGptPromptJsonBytes(compiled.text)).toBeLessThanOrEqual(CHATGPT_COMPACTION_PROMPT_JSON_BYTE_BUDGET);
  expect(compiled.trimmedCompactionMessages).toBe(2);
  expect(compiled.text).not.toContain("oldest-static");
  expect(compiled.text).not.toContain("newer-static");
  expect(compiled.text).toContain("real-task-");
  expect(compiled.text).toContain("verified-progress");
  expect(envelope.messages.at(-1)).toEqual({ role: "user", content: "checkpoint-now" });

  const normal = structuredClone(compact);
  delete normal._compactionRequest;
  const untrimmed = compileChatGptWebPrompt(
    normal,
    { localToolsEnabled: false, solAvailable: true, extraHighAvailable: true, proAvailable: true },
  );
  expect(untrimmed.text).toContain("oldest-static");
  expect(untrimmed.text).toContain("newer-static");
  expect(untrimmed.trimmedCompactionMessages).toBeUndefined();
});

test("inline compaction carries the newest cumulative checkpoint across discarded tool output", () => {
  for (const textParts of [false, true]) {
    const compact = request("high");
    compact._compactionRequest = true;
    compact.context.systemPrompt = [];
    const checkpoint = `${SUMMARY_PREFIX}\n\nVerified cumulative scope: ${"s".repeat(20_000)}`;
    compact.context.messages = [
      { role: "user", content: `${SUMMARY_PREFIX}\nObsolete summary`, timestamp: 1 },
      { role: "user", content: textParts ? [{ type: "text", text: checkpoint }] : checkpoint, timestamp: 2 },
      { role: "toolResult", toolCallId: "old-output", toolName: "read", isError: false,
        content: [{ type: "text", text: "x".repeat(100_000) }, { type: "image", imageUrl: "data:image/png;base64,old-image" }], timestamp: 3 },
      { role: "assistant", content: [{ type: "text", text: "recent verified progress" }], timestamp: 4 },
      { role: "user", content: "checkpoint-now", timestamp: 5 },
    ];
    const before = structuredClone(compact);
    const compiled = compileChatGptWebPrompt(compact, {
      localToolsEnabled: false, solAvailable: true, extraHighAvailable: true, proAvailable: true,
    });
    const envelope = JSON.parse(compiled.text.split("<codex_context_json>\n")[1]!.split("\n</codex_context_json>")[0]!);
    expect(envelope.messages.map((message: { role: string }) => message.role)).toEqual(["user", "assistant", "user"]);
    expect(JSON.stringify(envelope.messages[0])).toContain("Verified cumulative scope:");
    expect(envelope.messages.at(-1).content).toBe("checkpoint-now");
    expect(compiled.text).not.toContain("Obsolete summary");
    expect(compiled.images).toEqual([]);
    expect(compiled.trimmedCompactionMessages).toBe(2);
    expect(compiled.text).toContain("history is incomplete");
    expect(compiled.text).not.toContain("The task context is complete.");
    expect(chatGptPromptJsonBytes(compiled.text)).toBeLessThanOrEqual(CHATGPT_COMPACTION_PROMPT_JSON_BYTE_BUDGET);
    expect(compact).toEqual(before);
    const manual = compileChatGptWebPrompt(compact, {
      localToolsEnabled: true, solAvailable: true, extraHighAvailable: true, proAvailable: true,
    }, "turn_12345678901234567890123456789012", { manualControl: true });
    expect(manual.text).toContain("Verified cumulative scope:");
    expect(manual.text).toContain("history is incomplete");
    expect(manual.text).not.toContain("without calling tools");
    expect(chatGptPromptJsonBytes(manual.text)).toBeLessThanOrEqual(CHATGPT_COMPACTION_PROMPT_JSON_BYTE_BUDGET);
  }
});

test("inline compaction rejects a required checkpoint that cannot fit instead of forgetting it", () => {
  const compact = request("high");
  compact._compactionRequest = true;
  compact.context.systemPrompt = [];
  compact.context.messages = [
    { role: "user", content: `${SUMMARY_PREFIX}\n${"s".repeat(120_000)}`, timestamp: 1 },
    { role: "assistant", content: [{ type: "text", text: "recent progress" }], timestamp: 2 },
    { role: "user", content: "checkpoint-now", timestamp: 3 },
  ];
  expect(() => compileChatGptWebPrompt(compact, {
    localToolsEnabled: false, solAvailable: true, extraHighAvailable: true, proAvailable: true,
  })).toThrow("cumulative checkpoint");
});

test("Bigger Context compaction preserves history above the retired inline byte budget", () => {
  const compact = request("high");
  compact._compactionRequest = true;
  compact.context.systemPrompt = [];
  compact.context.messages = Array.from({ length: 6 }, (_unused, index) => ({
    role: "user" as const,
    content: `multipart-history-${index + 1}-${String.fromCharCode(97 + index).repeat(160_000)}`,
    timestamp: index + 1,
  }));

  const multipart = compileChatGptWebPrompt(
    compact,
    { localToolsEnabled: false, solAvailable: true, extraHighAvailable: true, proAvailable: true },
    undefined,
    { experimentalMultipartParts: CHATGPT_BIGGER_CONTEXT_PARTS },
  );

  expect(multipart.trimmedCompactionMessages).toBeUndefined();
  expect(multipart.multipart?.parts).toHaveLength(6);
  const transactionId = `ctx_${"0".repeat(32)}`;
  const stageBytes = multipart.multipart!.parts.map((payload, index) => chatGptPromptJsonBytes(
    formatChatGptWebMultipartStage(payload, transactionId, index + 1).text,
  ));
  expect(Math.max(...stageBytes)).toBeGreaterThan(CHATGPT_COMPACTION_PROMPT_JSON_BYTE_BUDGET);
  const staged = multipart.multipart!.parts.join("\n");
  for (let index = 1; index <= 6; index += 1) {
    expect(staged).toContain(`multipart-history-${index}-`);
  }
}, 30_000);

test("Bigger Context keeps preliminary parts small and preserves all records in order", () => {
  const compact = request("high");
  compact._compactionRequest = true;
  compact.context.systemPrompt = ["system".repeat(1_000)];
  compact.context.messages = [
    ...Array.from({ length: 6 }, (_unused, index) => ({
      role: "user" as const,
      content: `history-${index}-${"x".repeat(100_000)}`,
      timestamp: index + 1,
    })),
    { role: "user", content: "compact now", timestamp: 7 },
  ];

  const multipart = compileChatGptWebPrompt(
    compact,
    { localToolsEnabled: false, solAvailable: true, extraHighAvailable: false, proAvailable: false },
    undefined,
    { experimentalMultipartParts: CHATGPT_BIGGER_CONTEXT_PARTS },
  );
  const parts = multipart.multipart!.parts.map(part => JSON.parse(part) as { records: unknown[] });

  expect(parts).toHaveLength(6);
  expect(parts.flatMap(part => part.records)).toHaveLength(8);
  expect(Math.max(...multipart.multipart!.parts.slice(0, -1).map(part => part.length))).toBeLessThan(120_000);
  // The selected High mode can carry a larger final part than an Instant upload.
  expect(multipart.multipart!.parts.at(-1)!.length).toBeLessThan(1_048_572);
}, 30_000);

test("multipart compaction recovers exhausted stage budgets and rebuilds remaining attachments", () => {
  const capabilities = { localToolsEnabled: false, solAvailable: true, extraHighAvailable: false, proAvailable: false };
  // Each size leaves room for exactly one of the two large records in that transaction.
  for (const [parts, repeat] of [[2, 6_000], [CHATGPT_BIGGER_CONTEXT_PARTS, 13_000]] as const) {
    const compact = request("high");
    compact._compactionRequest = true;
    compact.context.messages = [
      ...["oldest", "newer"].map((label, index) => ({
        role: "user" as const,
        content: [
          { type: "text" as const, text: `${label}-${"a!b@c#d$e%f^g&h*".repeat(repeat)}` },
          { type: "image" as const, imageUrl: `data:image/png;base64,${label}-image` },
        ],
        timestamp: index + 1,
      })),
      { role: "assistant", content: [{ type: "text", text: "verified-progress" }], timestamp: 3 },
      { role: "user", content: "preserve-latest-checkpoint", timestamp: 4 },
    ];
    const original = structuredClone(compact);
    const compiled = compileChatGptWebPrompt(compact, capabilities, undefined, { experimentalMultipartParts: parts });
    const staged = compiled.multipart!.parts.join("\n");
    expect(compiled.trimmedCompactionMessages).toBe(1);
    expect(compiled.multipart!.parts).toHaveLength(parts);
    expect(staged).not.toContain("oldest-");
    for (const kept of ["newer-", "preserve-system", "verified-progress", "preserve-latest-checkpoint"]) {
      expect(staged).toContain(kept);
    }
    expect(compiled.images).toEqual([{ ref: "codex-input-image-1", imageUrl: "data:image/png;base64,newer-image" }]);
    for (const [index, message] of compiledChatGptWebMessages(compiled).entries()) {
      const final = index === parts - 1;
      const effort = final ? "high" : "medium";
      expect(estimateTokens(message)).toBeLessThanOrEqual(resolveChatGptWebMessageTokenBudget(
        CHATGPT_WEB_MODEL_ID, effort, capabilities, final ? estimateChatGptWebImageTokens(compiled) : 0,
      ));
      expect(message.length).toBeLessThanOrEqual(
        resolveChatGptWebTransportLimits(CHATGPT_WEB_MODEL_ID, effort, capabilities).browserComposerCharLimit!,
      );
    }
    expect(compact).toEqual(original);
    const normal = structuredClone(compact);
    delete normal._compactionRequest;
    expect(() => compileChatGptWebPrompt(normal, capabilities, undefined, { experimentalMultipartParts: parts }))
      .toThrow("Bigger Context cannot fit");
  }
}, 60_000);

test("multipart compaction refuses an irreducible final instruction without discarding it", () => {
  const compact = request("high");
  compact._compactionRequest = true;
  compact.context.messages = [{ role: "user", content: "a!b@c#d$e%f^g&h*".repeat(20_000), timestamp: 1 }];
  for (const parts of [2, CHATGPT_BIGGER_CONTEXT_PARTS] as const) {
    let failure: unknown;
    try {
      compileChatGptWebPrompt(compact,
        { localToolsEnabled: false, solAvailable: true, extraHighAvailable: false, proAvailable: false },
        undefined, { experimentalMultipartParts: parts });
    } catch (error) { failure = error; }
    // Two parts exhaust the stage budgets; six fit the stages but not the transaction ceiling.
    expect(failure).toMatchObject({ code: "context_length_exceeded", retryable: false });
    expect((failure as Error).message).toMatch(parts === 2 ? /Bigger Context cannot fit/ : /compaction still requires/);
  }
  expect(compact.context.messages).toHaveLength(1);
}, 60_000);

test("Web compaction rebuilds attachments after trimming an oversized oldest image message", () => {
  const compact = request("high");
  compact._compactionRequest = true;
  compact.context.systemPrompt = [];
  compact.context.messages = [
    {
      role: "user",
      content: [
        { type: "text", text: `discard-${"x".repeat(120_000)}` },
        { type: "image", imageUrl: "data:image/png;base64,discarded-image" },
      ],
      timestamp: 1,
    },
    { role: "user", content: "preserve-latest-checkpoint", timestamp: 2 },
  ];

  const compiled = compileChatGptWebPrompt(
    compact,
    { localToolsEnabled: false, solAvailable: true, extraHighAvailable: true, proAvailable: true },
  );

  const envelope = compiled.text.split("<codex_context_json>")[1]!.split("</codex_context_json>")[0]!;
  expect(compiled.images).toEqual([]);
  expect(compiled.trimmedCompactionMessages).toBe(1);
  expect(compiled.text).not.toContain("discard-");
  expect(envelope).not.toContain("image_attachment");
  expect(compiled.text).toContain("preserve-latest-checkpoint");
});

test("Luna rejects a separate compaction prompt because continuity is already rolling", () => {
  const compact = request("low");
  compact.modelId = CHATGPT_WEB_LUNA_MODEL_ID;
  compact._compactionRequest = true;
  expect(() => compileChatGptWebPrompt(
    compact,
    { localToolsEnabled: false, solAvailable: false, extraHighAvailable: false, proAvailable: false },
  )).toThrow("does not accept a separate compaction turn");
});

test("Web compaction fails closed when its final instruction alone exceeds the transport budget", () => {
  const compact = request("high");
  compact._compactionRequest = true;
  compact.context.systemPrompt = [];
  compact.context.messages = [{ role: "user", content: "z".repeat(120_000), timestamp: 1 }];

  expect(() => compileChatGptWebPrompt(
    compact,
    { localToolsEnabled: false, solAvailable: true, extraHighAvailable: true, proAvailable: true },
  )).toThrow("final compaction instruction alone exceeds");
});

test("assigns prior assistant output to the model and never attributes Codex context to the human", () => {
  const attributed = request("max");
  attributed.context.messages = [
    { role: "user", content: "hi", timestamp: 1 },
    {
      role: "assistant",
      content: [{ type: "text", text: "Hi! How can I help?" }],
      timestamp: 2,
    },
    {
      role: "user",
      content: "what did I write before?\n<environment_context><cwd>/private/project</cwd></environment_context>",
      timestamp: 3,
    },
  ];
  const compiled = compileChatGptWebPrompt(
    attributed,
    { localToolsEnabled: false, solAvailable: true, extraHighAvailable: true, proAvailable: true },
  );
  const encoded = compiled.text.match(/<codex_context_json>\n(.+)\n<\/codex_context_json>/s)?.[1];
  const envelope = JSON.parse(encoded!) as { messages: Array<Record<string, unknown>> };

  expect(envelope.messages[1]).toEqual({
    role: "assistant",
    content: [{ type: "text", text: "Hi! How can I help?" }],
  });
  expect(compiled.text).toContain("assistant messages are your own earlier replies");
  expect(compiled.text).toContain("environment_context, are operational context rather than human-authored text");
  expect(compiled.text).toContain("answer only from the human-authored text in user messages");
  expect(compiled.text).toContain("do not attribute, quote, summarize, or otherwise mention them");
});

test("a long task keeps the newest images and drops the overflow instead of failing", () => {
  const image = (marker: string) => ({
    type: "image" as const,
    imageUrl: `data:image/png;base64,${marker}`,
  });
  const markers = Array.from({ length: 13 }, (_unused, index) => `IMG${index + 1}`);
  const replayed: CodexParsedRequest = {
    modelId: CHATGPT_WEB_MODEL_ID,
    context: {
      systemPrompt: ["preserve-system"],
      messages: markers.map((marker, index) => ({
        role: "user" as const,
        content: [{ type: "text" as const, text: `step ${index + 1}` }, image(marker)],
        timestamp: index + 1,
      })),
    },
    stream: true,
    options: { reasoning: "high" },
  };

  const compiled = compileChatGptWebPrompt(
    replayed,
    { localToolsEnabled: true, solAvailable: true, extraHighAvailable: true, proAvailable: true },
    "turn_12345678901234567890123456789012",
  );

  expect(compiled.images.map(entry => entry.imageUrl)).toEqual(
    markers.slice(-10).map(marker => `data:image/png;base64,${marker}`),
  );
  expect(compiled.text).toContain("older image not attached");
  expect(compiled.text).toContain("step 1");
  expect(compiled.text).toContain("step 13");
});

test("Web compaction attaches the newest ten images as files and never embeds their base64 in prompt text", () => {
  const imagePayloads = Array.from({ length: 13 }, (_unused, index) =>
    Buffer.from(`compaction-image-${index + 1}`).toString("base64"));
  const parsed: CodexParsedRequest = {
    modelId: CHATGPT_WEB_MODEL_ID,
    context: {
      systemPrompt: ["preserve-system"],
      messages: imagePayloads.map((payload, index) => ({
        role: "user" as const,
        content: [
          { type: "text" as const, text: `checkpoint ${index + 1}` },
          { type: "image" as const, imageUrl: `data:image/png;base64,${payload}` },
        ],
        timestamp: index + 1,
      })),
    },
    stream: true,
    options: { reasoning: "high" },
    _compactionRequest: true,
  };

  const compiled = compileChatGptWebPrompt(
    parsed,
    { localToolsEnabled: false, solAvailable: true, extraHighAvailable: true, proAvailable: true },
  );

  expect(compiled.images.map(image => image.imageUrl)).toEqual(
    imagePayloads.slice(-10).map(payload => `data:image/png;base64,${payload}`),
  );
  expect(compiled.text).not.toContain("data:image");
  for (const payload of imagePayloads) expect(compiled.text).not.toContain(payload);
  expect(compiled.text.match(/"type":"image_attachment"/g)).toHaveLength(10);
  expect(compiled.text.match(/older image not attached/g)).toHaveLength(3);
});

test("persisted one-pixel image sentinels are not attached to ChatGPT", () => {
  const placeholder = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
  const parsed: CodexParsedRequest = {
    modelId: CHATGPT_WEB_MODEL_ID,
    context: {
      messages: [{
        role: "user",
        content: [
          { type: "text", text: "inspect the real image" },
          ...Array.from({ length: 30 }, () => ({ type: "image" as const, imageUrl: placeholder })),
          { type: "image", imageUrl: "data:image/png;base64,real-image" },
        ],
        timestamp: 1,
      }],
    },
    stream: true,
    options: { reasoning: "high" },
  };

  const compiled = compileChatGptWebPrompt(parsed, { localToolsEnabled: false, solAvailable: true, extraHighAvailable: true, proAvailable: true });

  expect(compiled.images.map(image => image.imageUrl)).toEqual(["data:image/png;base64,real-image"]);
  expect(compiled.text.match(/"type":"image_attachment"/g)).toHaveLength(1);
  expect(compiled.text).not.toContain("older image not attached");
});

test("the replayed context never carries a finished turn's broker handles", () => {
  const staleToken = "turn_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
  const staleBinding = "binding_BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";
  const token = "turn_12345678901234567890123456789012";
  const replayed: CodexParsedRequest = {
    modelId: CHATGPT_WEB_MODEL_ID,
    context: {
      systemPrompt: ["preserve-system"],
      messages: [
        { role: "user", content: "keep working", timestamp: 1 },
        {
          role: "assistant",
          content: [{ type: "toolCall", id: "call_1", name: "codex_bind_turn", arguments: { turn_token: staleToken } }],
          timestamp: 2,
        },
        {
          role: "toolResult",
          toolCallId: "call_1",
          toolName: "codex_bind_turn",
          isError: false,
          content: `{"binding_id":"${staleBinding}"}`,
          timestamp: 3,
        },
      ],
    },
    stream: true,
    options: { reasoning: "high" },
  };

  const compiled = compileChatGptWebPrompt(replayed, { localToolsEnabled: true, solAvailable: true, extraHighAvailable: true, proAvailable: true }, token);

  expect(compiled.text).not.toContain(staleToken);
  expect(compiled.text).not.toContain(staleBinding);
  expect(compiled.text).toContain("[retired turn handle]");
  expect(compiled.text).toContain("[retired binding handle]");
  expect(compiled.text).toContain(token);
  expect(compiled.text).toContain("keep working");
  const envelope = compiled.text.split("<codex_context_json>")[1]!.split("</codex_context_json>")[0]!.trim();
  expect(() => JSON.parse(envelope) as unknown).not.toThrow();
});

test("requires ChatGPT-native rich results to include a safe Markdown answer for Codex", () => {
  const compiled = compileChatGptWebPrompt(
    request("max"),
    { localToolsEnabled: false, solAvailable: true, extraHighAvailable: true, proAvailable: true },
  );

  expect(compiled.text).toContain("also provide the relevant result as ordinary Markdown in the final answer");
  expect(compiled.text).toContain("A private ChatGPT UI widget never replaces the Markdown answer returned to Codex");
  expect(compiled.text).toContain("Never copy a ChatGPT widget's HTML, CSS, class names, or DOM markup");
});

test("uses the public Instant name without leaking the browser menu alias into the prompt", () => {
  const compiled = compileChatGptWebPrompt(
    request("low"),
    { localToolsEnabled: false, solAvailable: true, extraHighAvailable: true, proAvailable: true },
  );

  expect(compiled.text).toContain("This is ChatGPT Web Instant with no local Codex bridge");
  expect(compiled.text).not.toContain("Instant 5.5");
});

test("keeps large contexts intact in the inline text envelope", () => {
  const token = "turn_12345678901234567890123456789012";
  const largeContent = "x".repeat(600_000);
  const large = request("high");
  large.context.messages.push({
    role: "toolResult",
    toolCallId: "call_large",
    toolName: "exec_command",
    content: largeContent,
    isError: false,
    timestamp: 3,
  });
  const compiled = compileChatGptWebPrompt(
    large,
    { localToolsEnabled: true, solAvailable: true, extraHighAvailable: true, proAvailable: true },
    token,
  );

  expect(compiled.text.length).toBeGreaterThan(600_000);
  expect(compiled.text).toContain(largeContent);
  expect(compiled.text).toContain(token);
  expect(compiled.text).toContain(`<codex_context_json>`);
  expect(compiled.text).not.toContain(`<codex_context_attachment>`);
  expect(compiled.text).not.toContain("sha256");
  expect(compiled.text).not.toContain("SHA-256");
});

test("plain prompts send the person's own words and one turn-token line when ChatGPT holds the rest", () => {
  const token = "turn_12345678901234567890123456789012";
  const capabilities = { localToolsEnabled: true, solAvailable: true, extraHighAvailable: false, proAvailable: true };
  const image = "data:image/png;base64," + "A".repeat(200);
  const first: CodexParsedRequest = {
    ...request("high"),
    context: {
      systemPrompt: ["preserve-system"],
      messages: [
        { role: "developer", content: "<permissions instructions>sandbox</permissions instructions>", timestamp: 1 },
        { role: "user", content: "# AGENTS.md instructions for G:\\repo\n\nbe careful", timestamp: 2 },
        { role: "user", content: "<environment_context>\n<cwd>G:\\repo</cwd>\n</environment_context>", timestamp: 3 },
        { role: "user", content: [{ type: "text", text: "fix the login bug on /register" }, { type: "image", imageUrl: image }], timestamp: 4 },
      ],
    },
  };
  const plain = compileChatGptWebPrompt(first, capabilities, token, { plainPrompt: true });
  expect(plain.text).toBe(`fix the login bug on /register\n\n(turn_token ${token} — pass it to Codex tools)`);
  expect(plain.images.map(item => item.imageUrl)).toEqual([image]);
  expect(plain.text).not.toContain("codex_context_json");

  // A retained conversation's next message: only what follows the last reply, still plain.
  const resumed = compileChatGptWebPrompt({ ...first, context: { messages: [
    { role: "user", content: "now add a test, not turn_abcdefghijklmnopqrstuvwxyz012345", timestamp: 5 },
  ] } }, capabilities, token, { plainPrompt: true });
  expect(resumed.text).toBe(`now add a test, not [retired turn handle]\n\n(turn_token ${token} — pass it to Codex tools)`);

  // History the ChatGPT conversation does not hold (an earlier reply) still goes as the full contract.
  const unretained = compileChatGptWebPrompt({ ...first, context: { systemPrompt: ["preserve-system"], messages: [
    ...first.context.messages,
    { role: "assistant", content: [{ type: "text", text: "fixed" }], timestamp: 5 },
    { role: "user", content: "and the other one", timestamp: 6 },
  ] } }, capabilities, token, { plainPrompt: true });
  expect(unretained.text).toContain("<codex_context_json>");

  // Off unless asked, and never for a read-only effort, which has no token.
  expect(compileChatGptWebPrompt(first, capabilities, token).text).toContain("<codex_context_json>");
});

for (const { name, count, sentinel } of [
  { name: "ten eligible images stay plain", count: 10, sentinel: false },
  { name: "eleven eligible images use the newest-image budget", count: 11, sentinel: false },
  { name: "a one-pixel sentinel does not use an attachment slot", count: 10, sentinel: true },
]) test(`plain image budget: ${name}`, () => {
  const token = "turn_12345678901234567890123456789012";
  const capabilities = { localToolsEnabled: true, solAvailable: true, extraHighAvailable: false, proAvailable: false };
  // The existing computer-vision fixture is 2x2; detail markers distinguish first/newest without changing its bytes.
  const image = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAE0lEQVR4nGP4z8DwHwwZGP6DAQBJyAn3FGMynQAAAABJRU5ErkJggg==";
  const placeholder = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
  const parsed = parseRequest({ model: CHATGPT_WEB_MODEL_ID, reasoning: { effort: "high" }, input: [{
    role: "user", content: [
      { type: "input_text", text: "Compare the newest image." },
      ...Array.from({ length: count }, (_, index) => ({ type: "input_image", image_url: image,
        detail: index === 0 ? "low" : index === 10 ? "high" : "auto" })),
      ...(sentinel ? [{ type: "input_image", image_url: placeholder }] : []),
    ],
  }] });
  const compiled = compileChatGptWebPrompt(parsed, capabilities, token, { plainPrompt: true });
  const full = compileChatGptWebPrompt(parsed, capabilities, token);
  expect(compiled.images).toEqual(full.images);
  expect(compiled.images).toHaveLength(10);
  if (count === 11) {
    expect(compiled.text).toContain("<codex_context_json>");
    expect(compiled.text.match(/older image not attached/g)).toHaveLength(1);
    expect(compiled.images[0]?.detail).toBe("auto");
    expect(compiled.images.at(-1)?.detail).toBe("high");
  } else {
    expect(compiled.text).toBe(`Compare the newest image.\n\n(turn_token ${token} — pass it to Codex tools)`);
    expect(compiled.images[0]?.detail).toBe("low");
    expect(compiled.images.some(item => item.imageUrl === placeholder)).toBe(false);
  }
  expect(estimateTokens(compiled.text)).toBeLessThan(
    resolveChatGptWebMessageTokenBudget(CHATGPT_WEB_MODEL_ID, "high", capabilities, estimateChatGptWebImageTokens(compiled)),
  );
});

for (const format of ["v1", "v2", "opaque"] as const) test.each([false, true])(
  `${format} post-compaction prompts restore current instructions in a fresh conversation (Bigger Context=%s)`,
  experimentalBiggerContext => {
    const token = "turn_12345678901234567890123456789012";
    const capabilities = { localToolsEnabled: true, solAvailable: true, extraHighAvailable: false, proAvailable: true, experimentalBiggerContext };
    const system = "Current system instruction: verify the result.";
    const developer = "Current developer instruction: preserve unrelated edits.";
    const agents = "# AGENTS.md instructions for G:\\repo\n\nUse the existing tests.";
    const environment = "<environment_context>\n<cwd>G:\\repo</cwd>\n</environment_context>";
    const summary = "Checkpoint: the previous implementation is complete; validation remains.";
    const checkpoint = format === "opaque" ? OPAQUE_COMPACTION_NOTE : summary;
    const source = { type: "message", role: "user", content: [{ type: "input_text", text: "Finish the existing task." }] };
    const context = [
      { type: "message", role: "developer", content: [{ type: "input_text", text: developer }] },
      { type: "message", role: "user", content: [{ type: "input_text", text: agents }] },
      { type: "message", role: "user", content: [{ type: "input_text", text: environment }] },
    ];
    const body = {
      model: CHATGPT_WEB_MODEL_ID,
      instructions: system,
      reasoning: { effort: "high" },
      client_metadata: { "x-codex-turn-metadata": JSON.stringify({ thread_id: "thread_compacted_prompt", turn_id: "turn_compacted_prompt" }) },
    };
    const before = parseRequest({ ...body, input: [...context, source] });
    const replacement = format === "v1"
      ? buildCompactV1Output([source], summary)
      : [source, { type: "compaction", encrypted_content: format === "opaque" ? "gAAAAABnative-opaque-checkpoint" : encodeCompactionSummary(summary) }];
    const parsed = parseRequest({ ...body, input: [...context, ...replacement] });
    expect(chatGptConversationKey(parsed, "provider")).not.toBe(chatGptConversationKey(before, "provider"));

    const parts = experimentalBiggerContext ? resolveBiggerContextMultipartParts(parsed, capabilities) : undefined;
    expect(parts).toBeUndefined();
    const compiled = compileChatGptWebPrompt(parsed, capabilities, token, { plainPrompt: true, experimentalMultipartParts: parts });
    const encoded = compiled.text.match(/<codex_context_json>\n(.+)\n<\/codex_context_json>/s)?.[1];
    expect(encoded).toBeDefined();
    const envelope = JSON.parse(encoded!) as { system: string[]; messages: Array<{ role: string; content: string }> };
    expect(envelope.system).toEqual([system]);
    for (const [role, content] of [["developer", developer], ["user", agents], ["user", environment]]) {
      expect(envelope.messages).toContainEqual({ role, content });
    }
    expect(compiled.text).toContain(checkpoint);
    expect(compiled.text).toContain("Finish the existing task.");
    expect(compiled.text).toContain(token);
    expect(compiled.text).toContain("use the selected plugin's tools directly");
  },
);

test("a /goal continuation sends Codex's goal instruction as the prompt and says where update_goal is", () => {
  const token = "turn_12345678901234567890123456789012";
  const capabilities = { localToolsEnabled: true, solAvailable: true, extraHighAvailable: false, proAvailable: true };
  const goal = "<codex_internal_context source=\"goal\">\nContinue working toward the active thread goal.\n\n<objective>\nship the upgrade cycle\n</objective>\n\nIf the objective is achieved, call update_goal with status \"complete\".\n</codex_internal_context>";
  const goalTurn: CodexParsedRequest = { ...request("high"), context: { messages: [
    { role: "developer", content: "<codex_apps_client_time_context></codex_apps_client_time_context>", timestamp: 1 },
    { role: "user", content: goal, timestamp: 2 },
  ] } };
  const plain = compileChatGptWebPrompt(goalTurn, capabilities, token, { plainPrompt: true });
  expect(plain.text.startsWith(`${goal}\n\n`)).toBe(true);
  expect(plain.text).toContain("The latest native Codex /goal objective is authoritative.");
  expect(plain.text.endsWith(`\n\n(turn_token ${token} — pass it to Codex tools; call update_goal through codex_tool_call)`)).toBe(true);
  // Other Codex blocks in the user role are still left out, and an ordinary prompt's line is unchanged.
  const page = compileChatGptWebPrompt({ ...goalTurn, context: { messages: [
    { role: "user", content: "<external_codex_apps_open_page>{\"page_id\":null}</external_codex_apps_open_page>", timestamp: 1 },
    { role: "user", content: "keep going", timestamp: 2 },
  ] } }, capabilities, token, { plainPrompt: true });
  expect(page.text).toBe(`keep going\n\n(turn_token ${token} — pass it to Codex tools)`);
});

test("serialized history cannot feed code-fence backtracking into ChatGPT's link lexer", () => {
  const original = {
    content: '```python\nprint("hello")\n``` '.repeat(20),
    nested: { '`key`': ["`inline`", "\\u0060", "\\`", "中文", "[link](url)"] },
  };
  const encoded = withoutRetiredTurnHandles(JSON.stringify(original));
  expect(encoded).not.toContain("`");
  expect(JSON.parse(encoded)).toEqual(original);
});

test("inline and multipart transports preserve code while escaping its Markdown delimiters", () => {
  const parsed = request("high");
  parsed.context.messages[1]!.content = '```python\nprint("hello")\n``` '.repeat(20);
  const capabilities = { localToolsEnabled: true, solAvailable: true, extraHighAvailable: true, proAvailable: true };
  const inline = compileChatGptWebPrompt(parsed, capabilities, "turn_12345678901234567890123456789012");
  const envelope = inline.text.split("<codex_context_json>\n")[1]!.split("\n</codex_context_json>")[0]!;
  expect(envelope).not.toContain("`");
  expect(JSON.stringify(JSON.parse(envelope))).toContain("```python");
  const multipart = compileChatGptWebPrompt(parsed, capabilities, "turn_12345678901234567890123456789012", { experimentalMultipartParts: CHATGPT_BIGGER_CONTEXT_PARTS });
  expect(multipart.multipart).toBeDefined();
  for (const part of multipart.multipart!.parts) {
    expect(part).not.toContain("`");
    expect(() => JSON.parse(part)).not.toThrow();
  }
  expect(JSON.stringify(multipart.multipart!.parts.map(part => JSON.parse(part)))).toContain("```python");
});
