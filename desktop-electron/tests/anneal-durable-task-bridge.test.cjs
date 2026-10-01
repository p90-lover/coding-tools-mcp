"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { createCodingToolsShellBridge } = require("../electron/coding-tools-shell-bridge.cjs");
const { invokeContract } = require("../electron/ipc-schema.cjs");

test("tasks.list returns the workspace-scoped durable workflow page", async () => {
  const requests = [];
  const bridge = createCodingToolsShellBridge({
    assertFocusedMainWindow() {},
    headlessHost: {
      async request(pathname, body, options) {
        requests.push({ pathname, body, options });
        return {
          ok: true,
          operation: {
            state: "completed",
            result: {
              ok: true,
              workspace_id: "ws-1",
              revision: 7,
              tasks: [{
                id: "task-1",
                workspace_id: "ws-1",
                title: "Run the real task",
                state: "in_progress",
                step: 4,
                updated_at: 123,
                evidence_count: 2,
              }],
              next_offset: 3,
            },
          },
        };
      },
    },
  });

  const page = await bridge.listTasks({}, { workspaceId: "ws-1", cursor: 2, limit: 1 });

  assert.deepEqual(page, {
    items: [{
      id: "task-1",
      title: "Run the real task",
      description: "",
      state: "in_progress",
    }],
    nextCursor: 3,
    revision: 7,
  });
  assert.equal(requests.length, 1);
  assert.equal(requests[0].pathname, "/api/v1/tools/call");
  assert.equal(requests[0].options.method, "POST");
  assert.equal(requests[0].body.workspace_id, "ws-1");
  assert.equal(requests[0].body.tool, "workflow_list");
  assert.deepEqual(requests[0].body.arguments, {
    offset: 2,
    limit: 1,
    include_archived: false,
  });
});

test("tasks.list IPC accepts only the bounded task page DTO with revision", async () => {
  const page = {
    items: [{
      id: "task-1",
      title: "Run the real task",
      description: "",
      state: "in_progress",
    }],
    nextCursor: null,
    revision: 7,
  };
  const ipcRenderer = { invoke: async () => page };

  assert.deepEqual(
    await invokeContract(ipcRenderer, "tasks.list", { workspaceId: "ws-1", limit: 20 }),
    page,
  );
});

test("Anneal dispatch uses the durable task revision and refreshes selected source state", () => {
  const source = fs.readFileSync(
    path.join(__dirname, "..", "src", "features", "AnnealTasksSurface.tsx"),
    "utf8",
  );

  assert.match(source, /api\.tasks\.list\(\{ workspaceId, limit: 100 \}\)/);
  assert.match(source, /setTaskRevision\(page\.revision\)/);
  assert.match(source, /expectedRevision:\s*taskRevision/);
  assert.match(source, /refreshSource:\s*true/);
  assert.match(source, /onClick=\{\(\) => void refresh\(true\)\}/);
  assert.match(source, /mission\.lastStatus/);
  assert.doesNotMatch(source, /root\.annealTasks/);
});
