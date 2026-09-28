# 0.4.3 model-free execution and shared workflow / 免模型執行與共用流程

Continue the approved local-tool integration without model inference. The native bridge gets a separate local command grant and exposes only bounded command/exec requests using :read-only. A request ledger prevents replay; revocation stops the owned process. No generic native RPC, thread creation, provider calls, or unsandboxed fallback is added. MCP workflow tools bind to the listener's stored workspace identity, use optimistic board revision checks, and record AI observations separately from human checklist attestations. The UI refreshes committed board changes without discarding draft text. Compatibility tool catalogs retain truthful mutation hints.

延續已批准的本機工具整合，不呼叫模型。原生橋接加入獨立命令授權，只使用有限的唯讀 command/exec；重播保護與撤銷會保留。共用流程綁定監聽服務的工作區身分，以修訂版檢查防止覆寫，AI 觀察不會冒充人類審核。介面刷新不清空草稿；相容目錄仍如實標示寫入工具。

- [x] Read exact source, upstream command schema, project instructions; attempted local pinned graph/plan tools (offline cache missing, logs retained).
- [x] Reproduce missing independent command consent on unmodified production code (34365005126, expected failing assertion).
- [ ] Add bounded native command admission/execution, independent consent, zero-model fixture and denial/replay checks.
- [ ] Add workspace-scoped workflow list/change with actual store persistence, human/AI evidence separation, revision conflicts and refresh.
- [ ] Verify focused native/HTTP/scope/UI regressions on exact committed source. No paid or synthetic model turns.
- [ ] Build Windows/macOS installers, inspect packaged binary and licenses, publish new exact-source prerelease and fast-forward main without deleting anything.

Impact: Hub connects to the same owned process; long command RPC must not hold the live-policy lock. Remote mutations still pass the central hard-policy and approval preflight. ToolContext's new workspace binding is set only at listener construction; it is never accepted from tool arguments. Board updates remain inside the DataStore transaction. Native command controls do not enable native model use. No screenshot, OAuth state or tunnel path changes.
