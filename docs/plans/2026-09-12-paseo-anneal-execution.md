# Paseo + Anneal execution integration

Base: v0.4.5 / 541c50f2d6db720ef2e888bb3f70ede961bbae1a.
Pinned references: getpaseo/paseo fa93c4290eaa87ae58452ab6e2012f85ae6e0c6b; mosonlab/anneal 2eaea1c7ab5fc4444beab703bf1fbab264ad3f58. Source archive: Actions run 34679034258.

## Approved goal / 已批准目標
ChatGPT remains the orchestrator. The MCP app must support assigning worker missions, observing evidence, requiring a distinct review, requesting hold/resume/close and representing actual acknowledgements. Anneal supplies the visible task/chain model. The MCP listener stays alive when a worker is held or closed. This is execution integration, not more read-only links.

## Constraints
No model/provider inference during implementation or tests; no Codex quota. No file, branch, release or project deletion commands. No secret embedded in source, task text or artifacts. All fixtures under aiTemp; retain originals under Trash. Existing OAuth, live workspace policies, root boundaries, screen/input approval and RAM-only screenshots remain independent. External runtimes do not inherit the Desktop AppContainer merely because an HTTP or WS request succeeded. Do not claim that property.

## Architecture
Extend the current shared board rather than create another unrelated task list. Durable mission state references the existing board task and workspace. A local-only explicit provider binding determines endpoint, approved root, provider/mode and execution consent. MCP calls may use but not manufacture that grant. External agents do not receive the MCP operator credentials. A mutation is recorded before transmission, using a unique action receipt; an interrupted response remains unknown and is never silently resubmitted. Read-only reconciliation and explicit review are separate from sending work. Archived upstream records must not be mistaken for deleted files.

## Protocol findings to preserve
Paseo uses hello then server_info, nested session requests, exact requestId, and separate create versus send-message operations. Creation now supports idempotencyKey, and message submission supports messageId. Never put an initial prompt into a keyed creation. cancel_agent_response can contain an error and is not automatically proof of successful interruption. close_items_request archives the specified sessions; it is not permission to stop the management daemon or kill unrelated terminals. Do not send delete_agent_request.

Anneal task creation can eagerly queue a model run when status is TODO. Prepared missions must be created BACKLOG with opensPullRequest=false and approvalGate=true; explicit Start is a separate request. Chain hold blocks subsequent layer dispatch and does NOT necessarily stop the current run. Run cancellation is separately requested and acknowledged. Review must not silently approve merge authorizations, raise spend caps or disable approval gates. No DELETE endpoint is exposed.

## Implementation sequence
1. [ ] Implement typed lifecycle/review state and allowlisted source request/acknowledgement contracts; three focused fixture groups: lifecycle and review, protocol identity/no replay, source mappings/bounds.
2. [ ] Add bounded HTTP/WebSocket transports using exact upstream schemas, no redirect/proxy/DNS endpoints, and no inference during fixture tests. Preserve requested versus observed cancellation.
3. [ ] Wire workspace-scoped persistent admission and source grants into the shared workflow/MCP dispatcher; protect against removed roots, changed policies, stale revisions and duplicate dispatch.
4. [ ] Add actual GUI assignment/review/lifecycle controls beside current task details. Both GUI and MCP use the same transitions; task ownership and review evidence remain visible.
5. [ ] Exercise pinned upstream daemon/API code with model-free fixtures, then Windows compiled Desktop, retained OAuth/permission/native checks. Run user-machine acceptance only through an available host connection. Publish only the exact tested source with honest capability coverage.

## Full integration acceptance
Prepared task -> assigned owned agent -> explicit start -> progress/evidence -> hold requested/acknowledged -> explicit continuation -> worker result -> separate review -> revise or accept -> keep/close, with main listener unaffected. The same task must be visible to MCP and GUI after reconnect. Report missing setup, provider credentials, unsupported actions, incompatible versions and unknown outcomes explicitly. Do not label a partial subsystem as full integration or promise absence of all bugs.

## 本輪承接
目前正式版本只提供唯讀介接及詳情頁面。本分支新增真正執行／審查機制，先驗證生命週期及來源協定，再連接持久化、MCP 與 GUI。Paseo 暫停要核對回覆；Anneal chain hold 並不等於停止當前 runner。不得自動重派遺失回覆的任務，也不得把模型自行聲稱完成當成已審核。三組集中測試使用測試服務，不啟動模型或刪除檔案。只有全部接通及驗證的能力才可列為完成。

Tooling note: native coding-tools-mcp/mcp-probe-kit/GitNexus were not returned by plugin discovery. The pinned npm probe-tool lookup timed out locally; the repository graph itself notes Rust-symbol resolution limitations. Source call-chain review is used, not a fabricated tool impact result. Initial blast radius: new execution module; later wiring touches shared workflow dispatch, data persistence and main-window controls (security-sensitive). No protected auth or native isolation implementation is replaced.
