const test = require("node:test");
const assert = require("node:assert/strict");
const { estimateTokens, contextBreakdown, readContextBreakdown } = require("../electron/ao-context-breakdown.cjs");

const message = (sequence, text) => ({ kind: "message", sequence, role: "user", text });
const command = (sequence, output) => ({ kind: "activity", sequence, activityKind: "command", detail: { command: "ls", output } });
const compaction = (sequence) => ({ kind: "activity", sequence, activityKind: "system", detail: { event: "compaction" } });
const byId = (breakdown) => Object.fromEntries(breakdown.categories.map((category) => [category.id, category.tokens]));

test("Latin text costs about four characters a token and CJK about one a character", () => {
  assert.equal(estimateTokens("abcdefgh"), 2);
  assert.equal(estimateTokens("你好世界"), 4);
  assert.equal(estimateTokens(""), 0);
  assert.equal(estimateTokens(null), 0);
});

test("what the agent reports beyond the counted messages and tool calls is its system prompt and tools", () => {
  const breakdown = contextBreakdown({
    messages: [message(1, "a".repeat(400))],
    activities: [command(2, "b".repeat(796))],
    usage: { contextUsed: 10_000, contextWindow: 200_000 },
  });
  assert.deepEqual(byId(breakdown), { system: 9_700, tools: 200, messages: 100 });
  assert.equal(breakdown.free, 190_000);
  assert.deepEqual(breakdown.counts, { messages: 1, toolCalls: 1 });
});

test("ACP tool calls count their input and their output or content blocks", () => {
  const acp = (sequence, detail) => ({ kind: "activity", sequence, activityKind: "mcp_tool", detail });
  const breakdown = contextBreakdown({
    activities: [
      acp(1, { input: { file_path: "x".repeat(400) }, output: "y".repeat(400) }),
      acp(2, { input: {}, content: [{ type: "content", content: { type: "text", text: "z".repeat(800) } }] }),
    ],
    usage: { contextUsed: 100_000, contextWindow: 200_000 },
  });
  assert.ok(byId(breakdown).tools >= 400, `tools ${byId(breakdown).tools}`);
  assert.equal(breakdown.counts.toolCalls, 2);
});

test("the backend bundle carries the breakdown module the upstream service requires", () => {
  const { BACKEND_MODULES } = require("../electron/backend-bundle.cjs");
  assert.ok(BACKEND_MODULES.includes("ao-context-breakdown.cjs"));
});

test("only the history after the last compaction is counted", () => {
  const breakdown = contextBreakdown({
    messages: [message(1, "a".repeat(4_000)), message(5, "a".repeat(40))],
    activities: [compaction(3)],
    usage: { contextUsed: 1_000, contextWindow: 100_000 },
  });
  assert.equal(byId(breakdown).messages, 10);
  assert.equal(breakdown.sinceCompaction, true);
});

test("counted text larger than the reported total shares it instead of going negative", () => {
  const breakdown = contextBreakdown({
    messages: [message(1, "a".repeat(4_000))],
    activities: [command(2, "b".repeat(4_000))],
    usage: { contextUsed: 500, contextWindow: null },
  });
  const split = byId(breakdown);
  assert.equal(split.system, 0);
  assert.equal(split.messages + split.tools, 500);
  assert.equal(breakdown.free, null);
});

test("no reported context means no breakdown", () => {
  assert.equal(contextBreakdown({ usage: null }), null);
  assert.equal(contextBreakdown({ usage: { contextUsed: 0, contextWindow: 100 } }), null);
});

test("the timeline is read back page by page and stops at the compaction", async () => {
  const queries = [];
  const pages = [
    { messages: [message(900, "a".repeat(40))], activities: [], hasMoreBefore: true, oldestSequence: 600 },
    { messages: [message(500, "a".repeat(40))], activities: [compaction(400)], hasMoreBefore: true, oldestSequence: 300 },
    { messages: [message(100, "never read")], activities: [], hasMoreBefore: false, oldestSequence: 1 },
  ];
  const breakdown = await readContextBreakdown(async (query) => { queries.push(query); return pages[queries.length - 1]; },
    { contextUsed: 1_000, contextWindow: 10_000 });
  assert.deepEqual(queries, ["limit=500", "limit=500&beforeSequence=600"]);
  assert.equal(byId(breakdown).messages, 20);
  assert.equal(breakdown.complete, true);
});
