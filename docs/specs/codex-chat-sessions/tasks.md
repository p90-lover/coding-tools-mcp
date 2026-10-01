# Codex chat sessions tasks

## 交付物清单
Two new source/test files; two primary production edits; affected contract assertions/documentation as needed. No new dependency, database, worktree or UI. Reader budget 400 lines; MCP registration budget 50 lines; test budget 250 lines. Existing large modules receive only bounded integration changes.

## 任务列表
### 1. Add a failing authenticated MCP session-read test
- Evidence: mcp-server.ts:662 uses withClaimedTurn; chatgpt-web-harness.test.ts:2608 launches a real StdioClientTransport. getCodexHome at codex-integration-shared.ts:245 already resolves CODEX_HOME/default home.
- Files: new runtime-web/tests/codex-chat-sessions.test.ts, under 250 lines; fixtures under aiTemp.
- Verify missing tool fails before implementation. Links: FR-1–FR-4, design API/testing.

### 2. Implement bounded read-only discovery/list/read
- Evidence: codex-rollout-environment.ts:130 checks canonical files beneath sessions; :143 performs bounded canonical scanning; registry_definitions.rs:79–89 shows the separate Markdown archive API.
- Files: new runtime-web/src/codex-chat-sessions.ts under 400 lines; mcp-server.ts at most 50 added lines; config.ts optional field only.
- Verify identities, scope, redaction, UTF-8 continuation and no mutation. Links: FR-1–FR-3, design technical/data/API decisions.

### 3. Verify and deploy the scoped tool
- Evidence: existing aiTemp/ao-packaged-mcp-check.cjs exercises tools/list; existing runtime build/install helpers validate installed baseline bundles and back up replacements.
- Files: affected contract tests, runtime documentation and aiTemp/work/codex-sessions verification artifacts.
- Run a few relevant tests/typecheck, local real MCP discovery/read and source-to-installed checks. Enable only the approved all-project preference locally. Report any remote connector cache limitation separately. Links: FR-4, design testing/risks.

## 检查点
Source inspection precedes edits; failing contract test precedes implementation; no completion claim until a local MCP read succeeds. Preserve all unrelated staged/untracked work and existing Codex sessions.

## 需求覆盖矩阵
| Requirement | Tasks |
|---|---|
| FR-1 | 1, 2, 3 |
| FR-2 | 1, 2, 3 |
| FR-3 | 1, 2, 3 |
| FR-4 | 1, 3 |

## 文件变更清单
The exact production/test paths and budgets are listed in tasks 1–3. Any necessary contract-fixture update will be recorded in verification, not silently expanded into an unrelated refactor.
