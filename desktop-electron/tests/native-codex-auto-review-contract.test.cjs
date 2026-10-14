"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const electronRoot = path.resolve(__dirname, "..");
const projectRoot = path.resolve(electronRoot, "..");
const read = (relativePath) => fs.readFileSync(path.join(electronRoot, relativePath), "utf8");
const readProject = (relativePath) => fs.readFileSync(path.join(projectRoot, relativePath), "utf8");

test("Native Codex UI exposes a real opt-in reviewer instead of claiming it is always enabled", () => {
  const panel = read("src/features/NativeCodexPanel.tsx");
  assert.match(panel, /setApprovalReviewer.*useState<"user" \| "auto_review">\("user"\)/);
  assert.match(panel, /approvalsReviewer: permissionProfile === ":workspace" && allowModelUsage \? approvalReviewer : "user"/);
  assert.match(panel, /Codex Auto-review \(Approve for me\)/);
  assert.match(panel, /disabled=\{locked \|\| permissionProfile !== ":workspace" \|\| !allowModelUsage\}/);
  assert.match(panel, /status\.approval_policy === "on-request" && status\.approvals_reviewer === "auto_review"/);
});

test("Native Codex IPC fails closed on unsupported reviewer or missing consent", () => {
  const main = read("electron/main.cjs");
  const section = main.split('handle("coding-tools:native-codex:connect", async (event, input) => {')[1]
    ?.split('handle("coding-tools:native-codex:disconnect"')[0];
  assert.ok(section, "native connection handler exists");
  assert.match(section, /assertFocusedMainWindow\(event, true\)/);
  assert.match(section, /reviewer !== "user" && reviewer !== "auto_review"/);
  assert.match(section, /reviewer === "auto_review" && \(input.permissionProfile !== ":workspace" \|\| input.allowModelUsage !== true\)/);
  assert.match(section, /approval_policy: "on-request", approvals_reviewer: reviewer/);
  assert.match(section, /\{ localConfirmation: true \}/);
  assert.match(read("src/api/contracts.ts"), /approvalsReviewer\?: "user" \| "auto_review"/);
});

test("the existing native policy rejects substitutions and checks exact runtime acknowledgement", () => {
  const native = readProject("src-tauri/src/codex_bridge/mod.rs");
  const policy = readProject("src-tauri/src/codex_bridge/permissions.rs");
  assert.match(native, /pub approvals_reviewer: Option<String>/);
  assert.match(native, /"approvals_reviewer":bridge\.approvals_reviewer\(\)/);
  assert.match(policy, /"user" \| "auto_review"/);
  assert.match(policy, /Native runtime did not acknowledge the exact selected permission profile/);
  assert.match(policy, /reviewer == Some\("auto_review"\) && policy == Some\("never"\)/);
});
