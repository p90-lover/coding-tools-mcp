"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const ts = require("typescript");
const source = name => fs.readFileSync(path.join(__dirname, "../src/features", name), "utf8");
const plain = value => JSON.parse(JSON.stringify(value));
const chat = {};
vm.runInNewContext(ts.transpileModule(source("ao-chat.ts"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
}).outputText, { exports: chat });
const toolParts = {};
const react = {
  createContext: value => ({ _currentValue: value, Provider: ({ children }) => children }),
  useContext: context => context._currentValue,
  useState: value => [value, () => {}],
};
vm.runInNewContext(ts.transpileModule(source("ChatToolParts.tsx"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2020 },
}).outputText, { exports: toolParts, require: name => name === "react" ? react : name === "react/jsx-runtime"
  ? { jsx: (type, props) => ({ type, props }), jsxs: (type, props) => ({ type, props }) } : {} });
const run = (id, extra = {}, minute = 0) => ({
  id, project_id: "task", cancelled: false, execution_mode: "single",
  nodes: [{ id: "lead", role: "planner", state: "finished", x: 0,
    receipt: { answer: `Reply ${id}`, started_at_ms: Date.UTC(2026, 10, 14, 12, minute) } }], ...extra,
});
const context = (run_id, source = "manual") => ({ run_id, revision: 1, source, message: "Continue existing work." });
const description = "First task\n\nFollow-up (2026-11-14 12:05 UTC):\nSecond task";

test("continuations keep later real messages aligned without synthetic bubbles", () => {
  const runs = [run("r1"), run("c1", { continuation: context("r1") }, 2), run("r2", {}, 5)];
  const turns = plain(chat.chatTurns(runs, description));
  assert.deepEqual(turns.map(turn => turn.user?.text), ["First task", undefined, "Second task"]);
  assert.deepEqual(turns.map(turn => turn.messageIndex), [0, undefined, 1]);
  assert.deepEqual(turns[1].continuation, context("r1"));
  assert.ok(turns[1].final || turns[1].steps.length);
});

test("every controller source preserves answers without adding user bubbles", () => {
  const sources = ["manual", "goal", "wake", "watch", "loop", "schedule"];
  const runs = [run("r1"), ...sources.map((name, index) => run(`c${index}`, {
    continuation: context(index ? `c${index - 1}` : "r1", name),
  }, index + 1))];
  const turns = plain(chat.chatTurns(runs, "Original task"));
  assert.equal(turns.filter(turn => turn.user).length, 1);
  assert.deepEqual(turns.slice(1).map(turn => turn.continuation.source), sources);
});

test("message ownership follows continuation, replacement and restart descendants", () => {
  const runs = [run("r1"), run("c1", { continuation: context("r1") }),
    run("c2", { continuation: context("c1", "wake") }), run("retry", { restarts_run_id: "c2" }),
    run("r2"), run("replacement", { replaces_run_id: "r2" }),
    run("c3", { continuation: context("replacement", "goal") })];
  assert.deepEqual(plain(chat.chatRunsOfMessage(runs, "r1")), ["r1", "c1", "c2", "retry"]);
  assert.deepEqual(plain(chat.chatRunsOfMessage(runs, "r2")), ["r2", "replacement", "c3"]);
  assert.deepEqual(plain(chat.chatRunsOfMessage(runs, "")), []);
});

test("flat transcripts keep controller context out of user messages", () => {
  const runs = [run("r1"), run("c1", { continuation: context("r1") }), run("r2", {}, 5)];
  const messages = plain(chat.chatTranscript(runs, description));
  assert.deepEqual(messages.filter(message => message.kind === "user").map(message => message.text), ["First task", "Second task"]);
  assert.deepEqual(messages.filter(message => message.kind === "agent").map(message => message.text), ["Reply r1", "Reply c1", "Reply r2"]);
});

test("Continue tooltip describes an internal continuation rather than a user send", () => {
  toolParts.TurnRestart._currentValue = { onContinue() {}, restarting: false };
  const button = toolParts.WaitingAnswer({ quietMs: 150_000 });
  assert.equal(button.type, "button");
  assert.match(button.props.title, /continue silently without adding a user message/i);
  assert.doesNotMatch(button.props.title, /send [“"]Continue/);
});

test("Continue uses the dedicated action and keeps the existing busy guard", () => {
  const component = source("AgentOrchestratorChat.tsx");
  assert.match(component, /continueChat\s*\(\s*\{\s*taskId:\s*selectedTaskId/);
  assert.doesNotMatch(component, /deliver\s*\(\s*["']Continue\.["']/);
  assert.match(component, /if\s*\(\s*sendBusy\s*\|\|\s*busy\s*\)\s*return/);
});

test("the surface binds Continue to the captured workspace, chat and run", () => {
  const component = source("AgentOrchestratorSurface.tsx");
  assert.match(component, /moduleCall\("chat_continue",\s*\{\s*workspaceId,\s*taskId: input\.taskId/);
  assert.match(component, /continueChat=\{continueChat\}/);
  assert.match(component, /if \(result\.cancelled\) throw new Error/);
  assert.match(component, /if \(result\.ok === false\) throw new Error/);
});
