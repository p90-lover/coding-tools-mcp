# Native upstream command sandbox (Windows)

## What is integrated

A dedicated helper is built from the `codex-windows-sandbox` library at OpenAI Codex commit `3caf9f9586baedb4158a7b91545ead3dd320c348`. The build does not build or launch a Codex agent, CLI model session, cloud task, AI reviewer or inference fallback. The helper accepts one bounded JSON request, not Codex prompts or agent CLI flags. The adapter initializes no model client or telemetry service.

The `sandbox_exec` MCP tool uses the upstream elevated Windows sandbox backend: dedicated sandbox identities, restricted filesystem capabilities, a restricted network policy, and a private desktop for command processes. The policy blocks workspace writes and restricts direct networking. Explicit workspace/platform/helper roots are used for setup grants, not a read-path whitelist. Reads remain subject to the dedicated sandbox account Windows ACLs; shared or world-readable files outside the workspace can remain readable. This follows the upstream write-restricted-token design. Do not treat this as a confidentiality boundary for otherwise shared files. Arbitrary environment variables, user profiles, write roots, network widening, elevation requests and alternate helpers are not exposed as MCP arguments. Existing file or shell tools are not automatically migrated to this backend. GUI computer-use permissions remain independent and graphical apps retain their ordinary authority.

The helper and its command-runner/setup binaries are hash-verified against a manifest whose digest is embedded in the app build. Mismatches fail closed; no unverified executable or unsandboxed retry is used. The helper has a process-wide non-queuing permit, input/output limits, bounded execution timeout and process-tree lifetime supervision. If output pipes do not close after termination, future launches are blocked until app restart. A submitted OS action cannot be recalled instantaneously, and provisioning may involve a separate Windows UAC interaction.

## Setup and use

Use **Native command sandbox → Prepare / approve** in the local, focused workspace UI. Windows may request one-time administrator consent for OS account/ACL/firewall provisioning. MCP callers cannot initiate setup or provide that consent. The adapter uses distinct `CTMcpSandboxOffline` / `CTMcpSandboxOnline` accounts and `CodingToolsMcpSandboxUsers`, rather than changing an existing Codex sandbox installation. Preparation writes sandbox state and diagnostics to this app's dedicated configuration area. It does not record screen images. Disabling the grant preserves OS accounts and existing files.

After preparation, `sandbox_status({})` reports build availability and the local workspace grant. `sandbox_exec({"argv":["C:\\Windows\\System32\\cmd.exe","/d","/c","ver"],"timeout_ms":10000})` submits a bounded command. Use an absolute executable and literal arguments. Read-only means that workflows requiring source-file writes must use separately authorized mechanisms; no silent full-access fallback is provided. The tool reports actual exit status and bounded output, not just command submission.

Runtime requests cannot silently repair an invalid sandbox using UAC. Missing setup or changed workspace configuration must be addressed locally. The source adapter and upstream LICENSE are included under native-helpers; the build records the immutable upstream revision and helper hashes. Mac builds do not expose Windows sandbox execution.

## Scope and validation

The release process compiles the sandbox-only binaries, exercises local preparation on the isolated CI Windows host, then checks permitted workspace/shared reads, denied workspace writes, denied reads of an ACL-protected private fixture and denied direct loopback networking. The private fixture has an unsandboxed positive-read control; shared-file readability is deliberately reported rather than falsely counted as denied. CI fixture success is not a claim that a particular user's Windows policies, antivirus, elevation consent or ChatGPT connection have been verified. Inspect the release's native verification evidence for executed results.

These helpers are not the entire Codex permissions stack, an isolation layer around already-running user applications, a replacement for human confirmation on consequential GUI actions, or a guarantee that every possible sandbox escape is eliminated. Keep permissions narrow. No Codex subscription quota is consumed by native sandbox execution itself; the connected chat still follows its own usage limits.

## 繁體中文

獨立輔助程式使用固定 Commit 的上游 Codex Windows 沙箱函式庫，而不是 Codex Agent／模型／雲端任務。`sandbox_exec` 使用獨立系統帳戶、檔案權限、網絡限制及私有桌面，阻止工作區寫入並限制網絡。讀取依據獨立沙箱帳戶的 Windows ACL，並非僅限工作區的路徑白名單；範圍外可共用讀取的檔案仍可能可讀。不會將既有命令工具或正在運行的 GUI 程式自動納入沙箱。

首次在本機按「準備／批准」，Windows 可要求一次 UAC 授權；遠端 MCP 不能自行設定或提升權限。輔助程式會驗證與發佈綁定的 SHA-256，不符或未設定時拒絕，不會退回無沙箱執行。系統設定／診斷資料會寫入本程式專用區，但截圖不會儲存。停用只撤銷授權並保留帳戶／既有檔案。

驗證紀錄會列出實際執行的隔離檢查；不宣稱你的 Windows／ChatGPT 環境已完成實機測試，也不把此後端說成完整 Codex 權限系統。
