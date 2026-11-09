"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createAgentInstructions, MAX_PROMPT_BYTES } = require("../electron/agent-instructions.cjs");

function world() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-instructions-"));
  const project = path.join(root, "project");
  fs.mkdirSync(project);
  const globalFile = path.join(root, "data", "instructions", "AGENTS.md");
  const instructions = createAgentInstructions({ globalFile,
    workspaces: async () => [{ id: "ws-1", name: "Demo", path: project }, { id: "ws-2", path: "relative/folder" }, { id: "ws-3", path: path.join(root, "other") }] });
  return { root, project, globalFile, instructions, done: () => fs.rmSync(root, { recursive: true, force: true }) };
}

test("Settings reads and saves the global AGENTS.md and the project's own", async () => {
  const { project, globalFile, instructions, done } = world();
  try {
    assert.deepEqual(await instructions.read("ws-1"), { global: "", globalFile, workspace: "", workspaceFile: path.join(project, "AGENTS.md") });
    await instructions.save({ scope: "global", text: "Answer in English.\r\n" });
    assert.equal(fs.readFileSync(globalFile, "utf8"), "Answer in English.\n", "kept with plain line ends");
    const saved = await instructions.save({ scope: "workspace", workspaceId: "ws-1", text: "Run bun test." });
    assert.equal(fs.readFileSync(path.join(project, "AGENTS.md"), "utf8"), "Run bun test.");
    assert.equal(saved.workspace, "Run bun test.");
    assert.equal(saved.global, "Answer in English.\n");
    // A project without an absolute folder has no workspace file to save.
    assert.equal((await instructions.read("ws-2")).workspace, null);
    await assert.rejects(instructions.save({ scope: "workspace", workspaceId: "ws-2", text: "x" }), /Choose a project with a folder/);
    await assert.rejects(instructions.save({ scope: "other", text: "x" }), /global or the workspace/);
    await assert.rejects(instructions.save({ scope: "global", text: "x".repeat(300 * 1024) }), /under 256 KB/);
    assert.deepEqual((await instructions.projects()).map((item) => [item.id, item.name]), [["ws-1", "Demo"], ["ws-3", "other"]]);
  } finally { done(); }
});

test("a launch's message starts with both files, global first, and nothing when both are empty", async () => {
  const { project, globalFile, instructions, done } = world();
  try {
    assert.deepEqual(await instructions.forLaunch("ws-1"), { text: "", hash: "" });
    fs.mkdirSync(path.dirname(globalFile), { recursive: true });
    fs.writeFileSync(globalFile, "﻿Answer in English.");
    fs.writeFileSync(path.join(project, "AGENTS.md"), "Run bun test.");
    const block = await instructions.forLaunch("ws-1");
    assert.match(block.text, /^<user_instructions>\n/);
    assert.ok(block.text.indexOf("Answer in English.") < block.text.indexOf("Run bun test."), "the global file comes first");
    assert.ok(block.text.includes(globalFile) && block.text.includes(path.join(project, "AGENTS.md")), "each names its file");
    assert.match(block.text, /<\/user_instructions>\n\n$/, "the person's message follows after a blank line");
    // Unchanged files keep their fingerprint; any edit changes it.
    assert.equal((await instructions.forLaunch("ws-1")).hash, block.hash);
    fs.writeFileSync(path.join(project, "AGENTS.md"), "Run bun test, then lint.");
    assert.notEqual((await instructions.forLaunch("ws-1")).hash, block.hash);
    // Another project gets the global file alone.
    assert.doesNotMatch((await instructions.forLaunch("ws-3")).text, /Workspace AGENTS\.md/);
  } finally { done(); }
});

test("instructions fit the room the message leaves, and say where the rest is", async () => {
  const { globalFile, instructions, done } = world();
  try {
    fs.mkdirSync(path.dirname(globalFile), { recursive: true });
    fs.writeFileSync(globalFile, "é".repeat(MAX_PROMPT_BYTES));
    const roomy = await instructions.forLaunch("ws-1");
    assert.ok(Buffer.byteLength(roomy.text) <= 2 * MAX_PROMPT_BYTES);
    assert.match(roomy.text, /\[Cut here: the rest is in .*AGENTS\.md; read it before you go on\.\]/);
    assert.doesNotMatch(roomy.text, /�/, "never a split character");
    const tight = await instructions.forLaunch("ws-1", { maxBytes: 2000 });
    assert.ok(Buffer.byteLength(tight.text) <= 2000, `fits: ${Buffer.byteLength(tight.text)}`);
    assert.match(tight.text, /Cut here/);
    // No room for any of the text: the agent is still told to read the file.
    const pointer = await instructions.forLaunch("ws-1", { maxBytes: 600 });
    assert.ok(Buffer.byteLength(pointer.text) <= 600);
    assert.match(pointer.text, new RegExp(`Read ${globalFile.replace(/[\\.]/g, "\\$&")} \\(Global AGENTS\\.md`));
    assert.equal(pointer.hash, roomy.hash, "the same files, the same fingerprint");
    assert.deepEqual(await instructions.forLaunch("ws-1", { maxBytes: 40 }), { text: "", hash: "" }, "and nothing past that");
  } finally { done(); }
});
