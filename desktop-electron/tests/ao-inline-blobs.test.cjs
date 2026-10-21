const test = require("node:test");
const assert = require("node:assert/strict");
const { dropInlineBlobs } = require("../electron/agent-orchestrator-upstream.cjs");

// The shape a screenshot Read left in a conversation (seen live on clash-of-clan-macro-64): the
// image as base64 twice, once as a content block and once inside the JSON-encoded output.
function screenshotActivity() {
  const image = "/9j/4AAQSkZJRgABAQAAAQABAAD".repeat(20000);
  return {
    id: "act-1", activityKind: "mcp_tool", summary: "Read aiTemp\\monitor\\w7411.jpg",
    detail: {
      tool: "Read", input: { file_path: "aiTemp\\monitor\\w7411.jpg" },
      content: [{ type: "image", content: { data: image, mimeType: "image/jpeg" } }],
      output: JSON.stringify([{ type: "image", source: { data: image, media_type: "image/jpeg" } }]),
    },
  };
}

test("a conversation reply loses its inline screenshots but keeps everything else", () => {
  const reply = {
    messages: [{ id: "m1", role: "assistant", text: "checking the board" }],
    activities: [screenshotActivity(), { id: "act-2", activityKind: "approval", status: "pending", detail: { command: "git status" } }],
  };
  const before = JSON.stringify(reply).length;
  dropInlineBlobs(reply);
  const after = JSON.stringify(reply).length;
  assert.ok(before > 1_000_000 && after < 4096, `reply went from ${before} to ${after} bytes`);
  const detail = reply.activities[0].detail;
  assert.match(detail.content[0].content.data, /KB of inline binary data not shown/);
  assert.equal(detail.input.file_path, "aiTemp\\monitor\\w7411.jpg");
  const output = JSON.parse(detail.output);
  assert.equal(output[0].source.media_type, "image/jpeg");
  assert.match(output[0].source.data, /not shown/);
  assert.deepEqual(reply.activities[1].detail, { command: "git status" }, "the pending approval is untouched");
  assert.equal(reply.messages[0].text, "checking the board");
});

test("long text output is not mistaken for an inline blob", () => {
  const log = "build step done with warnings\n".repeat(4000);
  const reply = { activities: [{ detail: { output: log, json: JSON.stringify({ lines: [log] }) } }] };
  dropInlineBlobs(reply);
  assert.equal(reply.activities[0].detail.output, log);
  assert.equal(JSON.parse(reply.activities[0].detail.json).lines[0], log);
});
