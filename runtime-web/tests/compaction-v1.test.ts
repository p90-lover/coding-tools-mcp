import { expect, test } from "bun:test";
import { estimateTokens } from "../src/lib/token-estimate";
import {
  buildCompactV1Output,
  extractCompactUserMessages,
  isReadableCompactionSummaryText,
  SUMMARY_PREFIX,
} from "../src/responses/compaction";

test("recognizes both Codex v1 and transparent v2 readable compaction summaries", () => {
  expect(isReadableCompactionSummaryText(`${SUMMARY_PREFIX}\nv1 summary`)).toBe(true);
  expect(isReadableCompactionSummaryText(`${SUMMARY_PREFIX}\n\nv2 summary`)).toBe(true);
  expect(isReadableCompactionSummaryText(`${SUMMARY_PREFIX}not a summary boundary`)).toBe(false);
});

test("v1 compaction drops native AGENTS refreshes but retains literal and mixed human instructions", () => {
  const refresh = { type: "message", role: "user", id: "msg_agents_refresh",
    content: [{ type: "input_text", text: "# AGENTS.md instructions\n<INSTRUCTIONS>Use repository rules.</INSTRUCTIONS>" }],
    internal_chat_message_metadata_passthrough: { turn_id: "turn_refresh", content_item_kinds: ["agents_md.instructions"] } };
  const literal = { ...refresh, id: "msg_human_literal",
    internal_chat_message_metadata_passthrough: { turn_id: "turn_human", content_item_kinds: ["user.text"] } };
  const mixed = { ...refresh, id: "msg_mixed",
    internal_chat_message_metadata_passthrough: { turn_id: "turn_mixed", content_item_kinds: ["agents_md.instructions", "user.text"] } };
  expect(extractCompactUserMessages([refresh, literal, mixed])).toEqual([literal, mixed]);
});

test("v1 compaction keeps only the newest ten structured images without copying them into text", () => {
  const input = Array.from({ length: 12 }, (_, index) => ({
    type: "message",
    role: "user",
    id: `user-${index}`,
    metadata: { source: `turn-${index}` },
    content: [
      { type: "input_text", text: `request-${index}` },
      {
        type: "input_image",
        image_url: `data:image/png;base64,image-${index}`,
        detail: "high",
      },
    ],
  }));

  const output = buildCompactV1Output(extractCompactUserMessages(input), "checkpoint");
  const retained = output.slice(0, -1) as Array<{
    id?: string;
    metadata?: { source?: string };
    content: Array<{ type: string; text?: string; image_url?: string; detail?: string }>;
  }>;
  expect(retained).toHaveLength(12);
  expect(retained.map(item => item.id)).toEqual(input.map(item => item.id));
  expect(retained.map(item => item.metadata?.source)).toEqual(input.map(item => item.metadata.source));
  const imageUrls = retained.flatMap(item => item.content
    .filter(block => block.type === "input_image")
    .map(block => block.image_url));
  expect(imageUrls).toEqual(input.slice(2).map(item => item.content[1]!.image_url));
  expect(retained.flatMap(item => item.content)
    .filter(block => block.type === "input_text")
    .every(block => !block.text?.includes("data:image"))).toBe(true);
  expect(retained.at(-1)?.content.at(-1)).toMatchObject({ detail: "high" });
});

test("v1 compaction drops persisted one-pixel image sentinels", () => {
  const placeholder = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
  const output = buildCompactV1Output(extractCompactUserMessages([{
    type: "message",
    role: "user",
    content: [
      { type: "input_text", text: "keep the request" },
      { type: "input_image", image_url: placeholder },
      { type: "input_image", image_url: "data:image/png;base64,real-image" },
    ],
  }]), "checkpoint");

  expect(JSON.stringify(output)).not.toContain(placeholder);
  expect(JSON.stringify(output)).toContain("data:image/png;base64,real-image");
});

test("v1 compaction bounds dense retained text by tokens and preserves the latest suffix", () => {
  const text = "测试上下文令牌预算。".repeat(8_000) + " latest request";
  const input = { type: "message", role: "user", id: "dense-user", metadata: { source: "latest" },
    content: [{ type: "input_text", text }] };
  const output = buildCompactV1Output(extractCompactUserMessages([input]), "checkpoint");
  const retained = output[0]!;
  const suffix = (retained.content as Array<{ text: string }>)[0]!.text;
  expect(estimateTokens(text)).toBeGreaterThan(20_000);
  expect(estimateTokens(suffix)).toBeLessThanOrEqual(20_000);
  expect(suffix.length).toBeGreaterThan(0);
  expect(text.endsWith(suffix)).toBe(true);
  expect(suffix.endsWith(" latest request")).toBe(true);
  expect(retained).toMatchObject({ id: "dense-user", metadata: { source: "latest" } });
  expect(input.content[0]!.text).toBe(text);
  expect((output.at(-1)!.content as Array<{ text: string }>)[0]!.text).toBe(`${SUMMARY_PREFIX}\ncheckpoint`);
});

test("v1 compaction keeps long text that fits the retained token budget", () => {
  const text = "a".repeat(120_000);
  expect(estimateTokens(text)).toBeLessThan(20_000);
  const output = buildCompactV1Output([{ type: "message", role: "user", content: text }], "checkpoint");
  expect((output[0]!.content as Array<{ text: string }>)[0]!.text).toBe(text);
});

test("v1 compaction shares the token budget across blocks while retaining older images", () => {
  const newest = "新".repeat(12_000);
  const older = "旧😀漢".repeat(12_000);
  const image = { type: "input_image", image_url: "data:image/png;base64,older-image" };
  const output = buildCompactV1Output([
    { type: "message", role: "user", id: "image-only", content: [image] },
    { type: "message", role: "user", id: "text", content: [
      { type: "input_text", text: older }, { type: "input_text", text: newest },
    ] },
  ], "checkpoint");
  expect(output[0]).toMatchObject({ id: "image-only", content: [image] });
  const blocks = output[1]!.content as Array<{ text: string }>;
  expect(blocks).toHaveLength(2);
  expect(blocks[1]!.text).toBe(newest);
  expect(older.endsWith(blocks[0]!.text)).toBe(true);
  expect(blocks[0]!.text).not.toMatch(/^[\uDC00-\uDFFF]/);
  expect(blocks.reduce((sum, block) => sum + estimateTokens(block.text), 0)).toBeLessThanOrEqual(20_000);
});

test("v1 compaction omits a block when its final code point cannot fit", () => {
  const newest = "新".repeat(19_999);
  expect(estimateTokens(newest)).toBe(19_999);
  expect(estimateTokens("🧬")).toBeGreaterThan(1);
  const output = buildCompactV1Output([{ type: "message", role: "user", content: [
    { type: "input_text", text: "🧬" }, { type: "input_text", text: newest },
  ] }], "checkpoint");
  const blocks = output[0]!.content as Array<{ text: string }>;
  expect(blocks).toHaveLength(1);
  expect(blocks[0]!.text === newest).toBe(true);
});
