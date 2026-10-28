"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { chatHostSession } = require("../electron/agent-orchestrator-upstream.cjs");

// Command lines as Task Manager showed them on 2026-10-28 (token shortened).
const root = "C:\\Users\\simon\\.ao\\coding-tools";
const host = (session, dataRoot) => `"H:\\Apps\\Coding Tools\\resources\\agent-orchestrator\\ao-daemon.exe" chat-host ${session} ${dataRoot} "F:\\clash of clan macro" acp abc123 -- "H:\\Apps\\Coding Tools\\resources\\acp-runtime\\node\\node.exe" agent.js`;

test("a chat host of this data root names its session", () => {
  assert.equal(chatHostSession(host("clash-of-clan-macro-92", root), root), "clash-of-clan-macro-92");
  assert.equal(chatHostSession(host("autosellbot_v3-10", "C:\\USERS\\simon\\.ao\\coding-tools\\"), root), "autosellbot_v3-10");
  assert.equal(chatHostSession(host("x-1", `"${root}"`), root), "x-1");
});

test("only this data root's chat hosts are ended: never the daemon, another root's host, or other processes", () => {
  assert.equal(chatHostSession(`"H:\\Apps\\Coding Tools\\resources\\agent-orchestrator\\ao-daemon.exe" daemon`, root), null);
  assert.equal(chatHostSession(host("dev-1", "G:\\Projects\\.scratch\\ao-dev"), root), null);
  assert.equal(chatHostSession(`"C:\\node.exe" chat-host`, root), null);
  assert.equal(chatHostSession("", root), null);
  assert.equal(chatHostSession(undefined, root), null);
});
