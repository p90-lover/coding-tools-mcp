"use strict";

const assert = require("node:assert/strict");
const path = require("node:path");
const contexts = new WeakMap();

function recordGuardianContext(session, input, id, now = Date.now()) {
  if (!session || input?.hook_event_name !== "PreToolUse" || typeof id !== "string" || !id || id !== input.tool_use_id
    || !["Bash", "PowerShell"].includes(input.tool_name) || typeof input.tool_input?.command !== "string"
    || Buffer.byteLength(input.tool_input.command) > 4000 || typeof input.cwd !== "string"
    || Buffer.byteLength(input.cwd) > 2048 || !path.isAbsolute(input.cwd)) return;
  let entries = contexts.get(session);
  if (!entries) contexts.set(session, entries = new Map());
  if (entries.has(id)) {
    entries.set(id, null);
    return;
  }
  if (entries.size >= 32) entries.delete(entries.keys().next().value);
  entries.set(id, { tool: input.tool_name, command: input.tool_input.command, cwd: input.cwd, now });
}

function takeGuardianContext(session, id, tool, input, requiresHuman, now = Date.now()) {
  const entries = contexts.get(session);
  const saved = entries?.get(id);
  entries?.delete(id);
  if (requiresHuman) return { requiresHuman: true };
  if (saved && saved.tool === tool && saved.command === input?.command && now >= saved.now && now - saved.now <= 30_000) {
    return { cwd: saved.cwd };
  }
}

function patchClaudeGuardianContext(source) {
  function insert(anchor, replacement) {
    assert.equal(source.split(anchor).length, 2, "The pinned Claude ACP Guardian hook seam changed");
    source = source.replace(anchor, () => replacement);
  }
  const pathImport = 'import * as path from "node:path";';
  insert(pathImport, `${pathImport}\nconst contexts = new WeakMap();\n${recordGuardianContext}\n${takeGuardianContext}`);
  const hook = '...(this.v2 || subagentConfigHook\n                    ? {\n                        PreToolUse: [';
  insert(hook, '...{\n                        PreToolUse: [');
  const tail = `                            ...(this.v2
                                ? [{ matcher: "Edit|Write", hooks: [this.fileChangePreviewHook(sessionId)] }]
                                : []),
                        ],
                    }
                    : {}),
                PostToolUse: [`;
  insert(tail, `                            ...(this.v2
                                ? [{ matcher: "Edit|Write", hooks: [this.fileChangePreviewHook(sessionId)] }]
                                : []),
                            { matcher: "Bash|PowerShell", hooks: [async (input, toolUseID) => {
                                recordGuardianContext(this.sessions[sessionId], input, toolUseID);
                                return {};
                            }] },
                        ],
                    },
                PostToolUse: [`);
  const permission = "const permissionOptions = buildClaudePermissionOptions({";
  insert(permission, `const guardianContext = takeGuardianContext(session, toolUseID, toolName, toolInput,
                matchedAskRule !== undefined || suppressAlwaysAllowRule === true || defaultToNo === true);
            if (guardianContext) {
                const meta = presentation.toolCall._meta ?? {};
                presentation.toolCall._meta = { ...meta, claudeCode: { ...meta.claudeCode, toolName, guardianContext } };
            }
            ${permission}`);
  return source;
}

module.exports = { patchClaudeGuardianContext, recordGuardianContext, takeGuardianContext };
