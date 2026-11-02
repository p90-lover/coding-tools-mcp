# Design
## 概述
Reuse mcp-connector-setup.cjs chatGptMcpContextScript, normal-request observation, guarded popup lifecycle and exact connector bindings. Reuse main.cjs partition routing, browser account registry and MCP operation guards. Existing planText currently maps proAvailable to Team or Pro; replace only that subscription inference.
## 技术方案
Keep one manual-operation lock across member inspection, candidate discovery, administrator creation/sharing and member consent. Candidate identity is verified from fresh account metadata and the selected workspace request. A workspace name is only a UI navigation hint and must be confirmed by workspace id. Verify tunnel owner/access on the publishing identity; member connection uses exact shared provenance and a verified matching workspace. Every mutation rechecks identity, role, workspace, tunnel settings and caller lifecycle. Store verified creation before sharing or consent so retries never duplicate it. Use ChatGPT's native Publish to workspace control for the configured connector in the exact verified workspace, and wait for positive completion before closing the publisher window. The button explains this behavior. Workspace roles, global plugin permissions and tunnel access scopes are not changed.
## Plans
Store server plan type, workspace id, role, structure and identity with a separate metadata timestamp. Model capability booleans retain their current bridge meaning. Refresh runs in the requested partition and publishes only if that account still exists. Unknown metadata remains unknown. Sign-out/user changes invalidate plan identity.
## Errors and recovery
Return bounded actionable administrator-not-found, sharing-required and context-changed errors. Preserve server/tunnel denial classification. Destroy every owned popup and detach observers on completion, failure or timeout. Preserve original browser account and unrelated saved bindings.
## Validation
Use existing connector/account registry tests and bounded new behavioral cases. Render subscription labels and original-member connection details at desktop and narrow viewports. Check graph impact before edits and detect changes before commit. Open a follow-up PR against main; per-account setup PR #800 merged while this enhancement was in progress.

## 文件结构
Modify desktop-electron/electron/mcp-connector-setup.cjs, main.cjs, browser-accounts.cjs and corresponding IPC types/preload and Browser Management component.
对应需求: FR-1, FR-2, FR-3, FR-4, FR-5.
