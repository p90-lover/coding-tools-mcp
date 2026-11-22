"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const ts = require(require.resolve("typescript", { paths: [path.resolve(__dirname, "..")] }));
const source = fs.readFileSync(path.resolve(__dirname, "../src/features/AgentOrchestratorChat.tsx"), "utf8");
const start = source.indexOf("  const deliver = async");
const end = source.indexOf("  const recoverMessage =", start);
assert.ok(start >= 0 && end > start);
const program = ts.transpileModule(`${source.slice(start, end)}\nexports.deliver = deliver;`, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;

function fixture({ acceptError = null, sendError = null, newerDraft = null, pending = true, retypeDuringAcceptance = false } = {}) {
  const state = { sends: [], recoveries: [], notices: [], settled: [], accepted: 0, outgoing: null, card: null };
  const composing = { current: { draft: "submitted input", attachments: [], annotations: [], cacheKey: "first", taskId: "", snapshot: {} } };
  const update = (field, value) => { composing.current = { ...composing.current, [field]: typeof value === "function" ? value(composing.current[field]) : value }; };
  const context = {
    exports: {}, composing, draftsNow: { current: pending ? { pending: async () => [] } : {} },
    selectedTaskId: "", carried: null, steering: false, steer: null, pendingSteers: [], turns: [], title: "",
    alive: { current: true }, sendsInFlight: { current: 0 }, CHAT_DRAFTS: new Map(), CHAT_ATTACHMENTS: new Map(),
    acceptMessage: async message => {
      state.accepted += 1;
      if (acceptError) throw acceptError;
      if (retypeDuringAcceptance) {
        composing.current = { ...composing.current, draft: "other text", snapshot: {} };
        composing.current = { ...composing.current, draft: message, snapshot: {} };
      }
      return { inputId: "stable-input-1", destination: { message }, payload: { attachments: composing.current.attachments } };
    },
    sameAttachmentSnapshot: (current, original, accepted) => current === original || current === accepted,
    setDraft: value => update("draft", value), setAttachments: value => update("attachments", value),
    setAnnotations: value => update("annotations", value), setAttachNote() {}, setSending() {}, setPendingSteers() {},
    setOutgoing: value => { state.outgoing = typeof value === "function" ? value(state.outgoing) : value; },
    followBottom() {}, setTitle() {}, setCarried() {}, trimDraftEntry() {}, forgetAcceptedInput() {}, setPendingRefresh() {},
    setCard: update => { state.card = update(state.card); },
    say: (title, text) => { state.notices.push({ title, text }); state.card = { title, text }; },
    refusalText: error => error.message, chatMessageReadable: value => value, sendRefusedForNow: () => false,
    enqueue: async () => {}, recoverMessage: (...args) => state.recoveries.push(args),
    settleSavedDraft: (_owner, handedOff) => state.settled.push({ handedOff, draft: composing.current.draft }),
    send: async args => {
      state.sends.push(args);
      if (newerDraft !== null) update("draft", newerDraft);
      if (sendError) throw sendError;
    },
  };
  vm.runInNewContext(program, context);
  return { state, composing, deliver: context.exports.deliver };
}

test("failed acceptance keeps the composer and never dispatches", async () => {
  const f = fixture({ acceptError: new Error("storage unavailable") });
  assert.equal(await f.deliver("submitted input"), false);
  assert.equal(f.composing.current.draft, "submitted input");
  assert.equal(f.state.sends.length, 0);
  assert.equal(f.state.notices.at(-1).title, "Not sent");
});

test("accepted input with a lost acknowledgement stays out of the editable composer", async () => {
  const f = fixture({ sendError: new Error("acknowledgement lost") });
  assert.equal(await f.deliver("submitted input"), false);
  assert.equal(f.state.sends[0].inputId, "stable-input-1");
  assert.equal(f.composing.current.draft, "");
  assert.equal(f.state.recoveries.length, 0);
  assert.equal(f.state.settled.at(-1).draft, "");
  assert.equal(f.state.notices.length, 0);
});

test("accepted delivery failure preserves newer typing without prepending the old input", async () => {
  const f = fixture({ sendError: new Error("acknowledgement lost"), newerDraft: "newer typing" });
  assert.equal(await f.deliver("submitted input"), false);
  assert.equal(f.composing.current.draft, "newer typing");
  assert.equal(f.state.recoveries.length, 0);
  assert.equal(f.state.settled.at(-1).draft, "newer typing");
});

test("an older acceptance does not clear a retyped same-text draft", async () => {
  const f = fixture({ retypeDuringAcceptance: true });
  assert.equal(await f.deliver("submitted input"), true);
  assert.deepEqual(f.state.sends.map(input => input.inputId), ["stable-input-1"]);
  assert.equal(f.composing.current.draft, "submitted input");
  assert.equal(f.state.settled.at(-1).draft, "submitted input");
});

test("acceptance cannot claim the saved revision of a different same-text edit", async () => {
  const start = source.indexOf("  const acceptMessage = async");
  const end = source.indexOf("  const forgetAcceptedInput =", start);
  assert.ok(start >= 0 && end > start);
  const acceptProgram = ts.transpileModule(`${source.slice(start, end)}\nexports.acceptMessage = acceptMessage;`, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  for (const retype of [false, true]) {
    const owner = { draft: "submitted input", attachments: [], annotations: [], cacheKey: "first", snapshot: {} };
    const composing = { current: owner };
    const requestLog = [];
    const writer = {
      queueChange() {}, matchesSaved: () => true, getKnownRevision: () => 4, preservedDraft: value => value,
      async flush() {
        if (retype) composing.current = { ...owner, snapshot: {} };
      },
      pauseForAcceptance: () => () => {},
    };
    const store = { getExecutionSelection: () => ({ execution: {}, executable: {} }),
      async accept(request) {
        requestLog.push(request);
        return { inputId: request.inputId, payload: request.payload, draft: { revision: 4 } };
      },
    };
    const context = {
      exports: {}, composing, draftsNow: { current: store },
      draftBinding: { current: { key: owner.cacheKey, loaded: true, ready: Promise.resolve(), writer } },
      acceptingInput: { current: false }, pendingAccepts: { current: new Map() }, alive: { current: true },
      selectedTaskId: "", title: "", savedDraftOf: (text, attachments, annotations) => ({ text, attachments, annotations }),
      rebuildAttachmentMessage: message => message, buildAcceptDestination: value => value, createUuid: () => "stable-input-1",
      setAttachments() {}, setPendingRefresh() {},
    };
    vm.runInNewContext(acceptProgram, context);
    await context.exports.acceptMessage(owner.draft, "send", owner, true);
    assert.equal(requestLog.length, 1);
    assert.equal(requestLog[0].draftRevision, retype ? undefined : 4);
  }
});

test("saved-input recovery reuses its identity and leaves the current draft alone", async () => {
  const f = fixture();
  f.state.card = { title: "Not sent" };
  assert.equal(await f.deliver("older input", undefined, false, false, "original-input"), true);
  assert.equal(f.state.accepted, 0);
  assert.equal(f.state.sends[0].inputId, "original-input");
  assert.equal(f.composing.current.draft, "submitted input");
  assert.equal(f.state.card, null);
});

test("legacy callers without pending-input recovery retain their failed draft", async () => {
  const f = fixture({ pending: false, sendError: new Error("delivery failed") });
  assert.equal(await f.deliver("submitted input"), false);
  assert.equal(f.composing.current.draft, "submitted input");
});

test("a queued saved input is hidden only when the chat queue contains its exact identity", () => {
  const match = source.match(/pendingInputs\.filter\((.*?)\)\.map\(item => <section/);
  assert.ok(match);
  const visible = (items, queued) => vm.runInNewContext(`pendingInputs.filter(${match[1]})`, { pendingInputs: items, queued });
  const input = { inputId: "one", state: "queued", mode: "send" };
  assert.equal(visible([input], []).length, 1);
  assert.equal(visible([input], [{ inputId: "different" }]).length, 1);
  assert.equal(visible([input], [{ inputId: "one" }]).length, 0);
  assert.equal(visible([{ ...input, state: "unknown" }], [{ inputId: "one" }]).length, 1);
});
