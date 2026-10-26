import { expect, test } from "bun:test";
import { estimateChatGptWebInputTokens, resolveBiggerContextMultipartParts } from "../src/adapters/chatgpt-web/usage";
import { compileChatGptWebPrompt, formatChatGptWebMultipartCommit } from "../src/adapters/chatgpt-web/prompt";
import { compiledChatGptWebMessages, estimateChatGptWebImageTokens, estimateCompiledChatGptWebInputTokens } from "../src/adapters/chatgpt-web/input-tokens";
import { assertChatGptWebMultipartInputWithinLimits, resolveChatGptWebMultipartStagingMode } from "../src/adapters/chatgpt-web/browser-worker";
import { estimateTokens } from "../src/lib/token-estimate";
import type { CodexParsedRequest } from "../src/types";

const capabilities = { localToolsEnabled: false, solAvailable: true, proAvailable: true };

function request(text: string): CodexParsedRequest {
  return {
    modelId: "gpt-5.6-sol",
    stream: false,
    context: { messages: [{ role: "user", content: text, timestamp: 1 }] },
    options: { reasoning: "high" },
  };
}

test.each([
  ["highly compressible", "a".repeat(480_000)],
  ["ordinary repeated words", `${"word ".repeat(79_999)}word`],
])("%s context uses tokenizer-derived usage without character-pressure inflation", (_label, text) => {
  expect(estimateChatGptWebInputTokens(request(text), capabilities)).toBeLessThan(100_000);
}, 15_000);

test("multipart selection accounts for whole-record and composer fit before submission", () => {
  const plus = { ...capabilities, proAvailable: false };
  for (const [contents, expected] of [
    [["small task"], undefined],
    [[50_000, 40_000, 50_000, 5_000].map(n => "word ".repeat(n)), 3],
    [Array.from({ length: 3 }, () => " ".repeat(450_000)), 2],
  ] as const) {
    const parsed = request("");
    parsed.context.messages = contents.map((content, index) => ({ role: "user", content, timestamp: index + 1 }));
    const parts = resolveBiggerContextMultipartParts(parsed, plus);
    expect(parts).toBe(expected);
    const compiled = compileChatGptWebPrompt(parsed, plus, undefined, { experimentalMultipartParts: parts });
    if (parts) {
      expect(compiled.multipart!.parts.flatMap(part => JSON.parse(part).records).map(record => record.message.content))
        .toEqual([...contents]);
    }
  }
}, 30_000);

test("Bigger Context compaction selects three parts before the legacy inline byte budget", () => {
  const parsed = request("x".repeat(160_000));
  parsed._compactionRequest = true;
  const parts = resolveBiggerContextMultipartParts(parsed, capabilities);
  expect(parts).toBe(3);
  const compiled = compileChatGptWebPrompt(parsed, capabilities, undefined, { experimentalMultipartParts: parts });
  expect(compiled.trimmedCompactionMessages).toBeUndefined();
  expect(compiled.multipart!.parts.flatMap(part => JSON.parse(part).records).map(record => record.message.content))
    .toEqual([parsed.context.messages[0]!.content]);
});

test("native GPT to Web GPT compaction transports one oversized history message without dropping it", () => {
  const plus = { ...capabilities, proAvailable: false };
  // One native-history item can be larger than the entire capacity of any single web effort.
  // The whole transaction still fits the three available message budgets.
  const history = `native-model-transcript: ${"word ".repeat(174_241)}`;
  const parsed = request(history);
  parsed._compactionRequest = true;
  parsed.context.messages.push({ role: "user", content: "latest request after model switch", timestamp: 2 });
  expect(estimateTokens(history)).toBeGreaterThan(100_000);

  const compiled = compileChatGptWebPrompt(parsed, plus, undefined, { experimentalMultipartParts: 3 });
  const records = compiled.multipart!.parts.flatMap(part => JSON.parse(part).records as Array<{
    kind: string;
    record_index?: number;
    fragment_index?: number;
    fragment_count?: number;
    record_json_fragment?: string;
    message?: { content: string };
  }>);
  const fragments = records.filter(record => record.kind === "record_fragment");
  expect(fragments.length).toBeGreaterThan(1);
  expect(fragments.map(fragment => fragment.fragment_index))
    .toEqual(Array.from({ length: fragments.length }, (_, index) => index + 1));
  expect(fragments.every(fragment => fragment.fragment_count === fragments.length && fragment.record_index === 0)).toBe(true);
  const recovered = JSON.parse(fragments.map(fragment => fragment.record_json_fragment).join(""));
  expect(recovered).toEqual({ kind: "message", message_index: 0, message: { role: "user", content: history } });
  expect(records.at(-1)?.message?.content).toBe("latest request after model switch");
  expect(formatChatGptWebMultipartCommit(compiled.multipart!, `ctx_${"0".repeat(32)}`))
    .toContain("record_json_fragment");

  const messages = compiledChatGptWebMessages(compiled);
  const stageTokens = Math.max(...messages.slice(0, -1).map(message => estimateTokens(message)));
  const stageChars = Math.max(...messages.slice(0, -1).map(message => message.length));
  const staging = resolveChatGptWebMultipartStagingMode(parsed.modelId, plus, stageTokens, stageChars);
  expect(() => assertChatGptWebMultipartInputWithinLimits(
    estimateCompiledChatGptWebInputTokens(compiled, parsed.modelId),
    Math.max(...messages.map(message => estimateTokens(message))),
    parsed.modelId, "high", plus, Math.max(...messages.map(message => message.length)), 3,
    {
      stagingEffort: staging.effort,
      maxStageMessageTokens: stageTokens,
      maxStageChars: stageChars,
      finalMessageTokens: estimateTokens(messages.at(-1)!),
      finalMessageChars: messages.at(-1)!.length,
      finalImageTokens: 0,
    },
  )).not.toThrow();
}, 30_000);

test("multipart planning leaves room for final attachments and execution instructions without losing history", () => {
  for (const scenario of [
    { proAvailable: false, images: 3, schema: false },
    { proAvailable: true, images: 10, schema: false },
    { proAvailable: false, images: 0, schema: true },
  ]) {
    const caps = { ...capabilities, proAvailable: scenario.proAvailable };
    const parsed = request("");
    const texts = Array.from({ length: 36 }, (_, index) => `record ${index}: ${"word ".repeat(5_000)}`);
    parsed.context.messages = texts.map((content, index) => ({ role: "user", content, timestamp: index + 1 }));
    const images = Array.from({ length: scenario.images }, (_, index) => ({
      type: "image" as const, imageUrl: `data:image/png;base64,partition-image-${index}`, detail: "original" as const,
    }));
    if (images.length) parsed.context.messages.push({ role: "user", content: images, timestamp: 37 });
    if (scenario.schema) parsed.options.outputFormat = {
      type: "json_schema", name: "result", strict: true, schema: { type: "string", description: "schema ".repeat(24_000) },
    };
    const compiled = compileChatGptWebPrompt(parsed, caps, undefined, { experimentalMultipartParts: 3 });
    const records = compiled.multipart!.parts.flatMap(part => JSON.parse(part).records);
    expect(records.map(record => record.message_index)).toEqual(parsed.context.messages.map((_, index) => index));
    expect(records.slice(0, texts.length).map(record => record.message.content)).toEqual(texts);
    expect(compiled.images.map(image => ({ imageUrl: image.imageUrl, detail: image.detail })))
      .toEqual(images.map(image => ({ imageUrl: image.imageUrl, detail: image.detail })));
    if (scenario.schema) expect(compiled.multipart!.commit).toContain(JSON.stringify(parsed.options.outputFormat!.schema));
    const messages = compiledChatGptWebMessages(compiled);
    const tokens = messages.map(text => estimateTokens(text));
    const chars = messages.map(text => text.length);
    const maxStageMessageTokens = Math.max(...tokens.slice(0, -1));
    const maxStageChars = Math.max(...chars.slice(0, -1));
    const stage = resolveChatGptWebMultipartStagingMode(parsed.modelId, caps, maxStageMessageTokens, maxStageChars);
    expect(() => assertChatGptWebMultipartInputWithinLimits(
      estimateCompiledChatGptWebInputTokens(compiled, parsed.modelId), Math.max(...tokens),
      parsed.modelId, "high", caps, Math.max(...chars), 3,
      { stagingEffort: stage.effort, maxStageMessageTokens, maxStageChars, finalMessageTokens: tokens[2]!, finalMessageChars: chars[2]!, finalImageTokens: estimateChatGptWebImageTokens(compiled) },
    )).not.toThrow();
  }
}, 30_000);
