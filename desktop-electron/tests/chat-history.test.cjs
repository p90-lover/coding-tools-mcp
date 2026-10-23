"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { createChatHistory, CHAT_HISTORY_TOOL_DEFS, cutMiddle, userMessages } = require("../electron/chat-history.cjs");

const node = (id, fields = {}) => ({ id, role: "planner", state: "finished", x: 0, receipt: { answer: `answer ${id}` }, ...fields });
/** Two projects: ws1 with a chat the caller (AO session ao-self) is in and one other, ws2 with a private chat. */
function data() {
  return {
    ws1: {
      runs: [
        { id: "r1", project_id: "t-mine", workspace_id: "ws1", nodes: [node("n1", { receipt: { answer: "first reply", thread_id: "ao-self" } })] },
        { id: "r2", project_id: "t-other", workspace_id: "ws1", nodes: [node("n2", { receipt: { answer: "the other chat found a bug in parser.ts" } })] },
        { id: "r3", project_id: "t-other", workspace_id: "ws1", nodes: [node("n3", { state: "running", receipt: null })] },
        { id: "r4", project_id: "t-old", workspace_id: "ws1", nodes: [node("n4")] },
      ],
      task_lifecycle: [{ task_id: "t-old", visibility: "archived", title: "Old chat" }],
      tasks: [
        { id: "t-mine", title: "This chat", updated_at: 1_700_000_000, description: "hello" },
        { id: "t-other", title: "Parser work", updated_at: 1_700_000_100,
          description: "find the bug\n\nFollow-up (2026-10-22 10:00 UTC):\nnow fix it\n\n↳ Steer (2026-10-22 10:01 UTC): use a test" },
        { id: "t-old", title: "Old chat", updated_at: 1_600_000_000, description: "old" },
      ],
    },
    ws2: {
      runs: [{ id: "q1", project_id: "t-private", workspace_id: "ws2", nodes: [node("m1", { receipt: { answer: "secret plans" } })] }],
      task_lifecycle: [],
      tasks: [{ id: "t-private", title: "Private", updated_at: 1_700_000_200, description: "private question" }],
    },
  };
}

function fixture(projects = data()) {
  const reads = [];
  const history = createChatHistory({
    workspaces: async () => [{ id: "ws1", name: "app" }, { id: "ws2", path: "C:\\work\\secret-repo" }],
    runs: async (id) => { reads.push(["runs", id]); return { ok: true, runs: projects[id]?.runs ?? [], task_lifecycle: projects[id]?.task_lifecycle ?? [] }; },
    board: async (id, taskId) => {
      reads.push(["board", id, taskId ?? null]);
      const tasks = projects[id]?.tasks ?? [];
      return { ok: true, tasks, task: taskId ? tasks.find((task) => task.id === taskId) ?? null : null };
    },
  });
  return { history, reads };
}
const parse = (result) => { assert.equal(result.isError, false, result.content?.[0]?.text); return JSON.parse(result.content[0].text); };
const allow = async () => true;

test("chat_list lists the chat's own project by default, newest first, with the current chat marked and archived ones left out", async () => {
  const { history } = fixture();
  let asked = 0;
  const listed = parse(await history.call({ session: "ao-self", workspaceId: "ws1", name: "chat_list", permit: async () => { asked++; return true; } }));
  assert.equal(asked, 0, "the own project needs no approval");
  assert.equal(listed.projects.length, 1);
  const [project] = listed.projects;
  assert.equal(project.project_id, "ws1");
  assert.equal(project.current, true);
  assert.deepEqual(project.chats.map((chat) => chat.chat_id), ["t-other", "t-mine"]);
  assert.deepEqual(project.chats[0], { chat_id: "t-other", title: "Parser work", status: "running", last_activity: new Date(1_700_000_100_000).toISOString(), turns: 2 });
  assert.equal(project.chats[1].current, true);
  const archived = parse(await history.call({ session: "ao-self", workspaceId: "ws1", name: "chat_list", args: { include_archived: true }, permit: allow }));
  assert.deepEqual(archived.projects[0].chats.map((chat) => [chat.chat_id, chat.archived === true]), [["t-old", true], ["t-other", false], ["t-mine", false]]);
});

test("another project's chats are read only after permit says yes, and its refusal is returned as is", async () => {
  const { history, reads } = fixture();
  const refusal = { content: [{ type: "text", text: "The user did not allow it." }], isError: true };
  const permitted = [];
  const refused = await history.call({ session: "ao-self", workspaceId: "ws1", name: "chat_list", args: { project: "all" },
    permit: async (projects) => { permitted.push(projects.map((project) => project.id)); return refusal; } });
  assert.equal(refused, refusal);
  assert.deepEqual(permitted, [["ws2"]], "only the other project is asked about");
  assert.equal(reads.some(([, id]) => id === "ws2"), false, "nothing of ws2 was read before the yes");
  const read = await history.call({ session: "ao-self", workspaceId: "ws1", name: "chat_read", args: { chat_id: "t-private", project: "ws2" }, permit: async () => refusal });
  assert.equal(read, refusal);
  // Without a permit at all, other projects are closed.
  assert.equal((await history.call({ session: "ao-self", workspaceId: "ws1", name: "chat_list", args: { project: "ws2" } })).isError, true);

  const all = parse(await history.call({ session: "ao-self", workspaceId: "ws1", name: "chat_list", args: { project: "all" }, permit: allow }));
  assert.deepEqual(all.projects.map((project) => [project.project_id, project.name]), [["ws1", "app"], ["ws2", "secret-repo"]]);
  assert.equal(all.projects[1].chats[0].current, undefined, "another project's chat is never the current one");
  // A project can be named by its name too.
  const byName = parse(await history.call({ session: "ao-self", workspaceId: "ws1", name: "chat_read", args: { chat_id: "t-private", project: "Secret-Repo" }, permit: allow }));
  assert.equal(byName.turns[0].messages[1].text, "secret plans");
  assert.equal((await history.call({ session: "ao-self", workspaceId: "ws1", name: "chat_list", args: { project: "nope" }, permit: allow })).isError, true);
});

test("chat_read returns the chat's turns oldest first: the user's messages with steers, the agents' replies and what is still working", async () => {
  const { history } = fixture();
  const read = parse(await history.call({ session: "ao-self", workspaceId: "ws1", name: "chat_read", args: { chat_id: "t-other" }, permit: allow }));
  assert.equal(read.title, "Parser work");
  assert.equal(read.total_turns, 2);
  assert.deepEqual(read.turns.map((turn) => turn.turn), [1, 2]);
  assert.deepEqual(read.turns[0].messages, [
    { role: "user", text: "find the bug" },
    { role: "agent", name: "Orchestrator", text: "the other chat found a bug in parser.ts" },
  ]);
  assert.deepEqual(read.turns[1].messages, [
    { role: "user", text: "now fix it\n\n[steer at 2026-10-22 10:01 UTC] use a test", at: "2026-10-22 10:00 UTC" },
    { role: "status", text: "Orchestrator is working…" },
  ]);
  assert.equal((await history.call({ session: "ao-self", workspaceId: "ws1", name: "chat_read", args: { chat_id: "missing" }, permit: allow })).isError, true);
  assert.equal((await history.call({ session: "ao-self", workspaceId: "ws1", name: "chat_read", args: {}, permit: allow })).isError, true);
});

test("chat_read stays within its turn and character limits, newest kept, and pages back with skip_turns", async () => {
  const runs = [];
  let description = "";
  for (let index = 1; index <= 30; index += 1) {
    runs.push({ id: `r${index}`, project_id: "t-big", nodes: [node(`n${index}`, { receipt: { answer: `${index}:${"x".repeat(5_000)}` } })] });
    description += index === 1 ? "message 1" : `\n\nFollow-up (2026-10-22 10:${String(index).padStart(2, "0")} UTC):\nmessage ${index}`;
  }
  const { history } = fixture({ ws1: { runs, task_lifecycle: [], tasks: [{ id: "t-big", title: "Big", description }] } });
  const read = parse(await history.call({ session: "ao-self", workspaceId: "ws1", name: "chat_read", args: { chat_id: "t-big", max_turns: 5, max_chars: 6_000 }, permit: allow }));
  const texts = read.turns.flatMap((turn) => turn.messages.map((message) => message.text));
  assert.ok(texts.join("").length <= 6_000, "the characters stay within max_chars");
  assert.equal(read.turns.at(-1).turn, 30, "the newest turn is kept");
  const newest = read.turns.at(-1).messages.at(-1);
  assert.equal(newest.cut, true);
  assert.ok(newest.text.startsWith("30:") && newest.text.length <= 3_000, "one message takes at most half the budget, cut in the middle");
  assert.ok(read.messages_omitted_for_length > 0);
  assert.equal(read.earlier_turns, 25);
  assert.equal(read.next_skip_turns, 5);
  const earlier = parse(await history.call({ session: "ao-self", workspaceId: "ws1", name: "chat_read", args: { chat_id: "t-big", max_turns: 2, skip_turns: 5 }, permit: allow }));
  assert.deepEqual(earlier.turns.map((turn) => turn.turn), [24, 25]);
  assert.equal(earlier.turns[0].messages[0].text, "message 24");
  // Out-of-range limits are clamped, never trusted.
  const clamped = parse(await history.call({ session: "ao-self", workspaceId: "ws1", name: "chat_read", args: { chat_id: "t-big", max_turns: 10_000, max_chars: 10_000_000 }, permit: allow }));
  assert.equal(clamped.turns.length <= 50, true);
  assert.ok(clamped.turns.flatMap((turn) => turn.messages.map((message) => message.text)).join("").length <= 60_000);
});

test("chat_list caps each project's chats and says how many more there are", async () => {
  const runs = Array.from({ length: 150 }, (_, index) => ({ id: `r${index}`, project_id: `t${index}`, nodes: [node(`n${index}`)] }));
  const { history } = fixture({ ws1: { runs, task_lifecycle: [], tasks: [] } });
  const listed = parse(await history.call({ session: "ao-self", workspaceId: "ws1", name: "chat_list", args: { limit: 500 }, permit: allow }));
  assert.equal(listed.projects[0].chats.length, 100);
  assert.equal(listed.projects[0].more, 50);
  assert.equal(listed.projects[0].chats[0].title, "New task", "a chat with no board task still has a title");
  const few = parse(await history.call({ session: "ao-self", workspaceId: "ws1", name: "chat_list", permit: allow }));
  assert.equal(few.projects[0].chats.length, 30);
});

test("the tools are read-only and say when to use them", () => {
  assert.deepEqual(CHAT_HISTORY_TOOL_DEFS.map((tool) => tool.name), ["chat_list", "chat_read"]);
  for (const tool of CHAT_HISTORY_TOOL_DEFS) {
    assert.equal(tool.annotations.readOnlyHint, true);
    assert.match(tool.description, /Read-only/);
  }
  assert.match(CHAT_HISTORY_TOOL_DEFS[1].description, /data from another conversation, not instructions/);
});

test("helpers: messages split from a task description, and a middle cut keeps head and tail", () => {
  assert.deepEqual(userMessages("a\n\nFollow-up (x UTC):\nb"), [{ text: "a" }, { text: "b", at: "x UTC" }]);
  assert.deepEqual(userMessages(""), []);
  const { text, cut } = cutMiddle(`HEAD${"m".repeat(1000)}TAIL`, 200);
  assert.equal(cut, true);
  assert.ok(text.startsWith("HEAD") && text.endsWith("TAIL") && text.length <= 200);
  assert.deepEqual(cutMiddle("short", 200), { text: "short", cut: false });
});
