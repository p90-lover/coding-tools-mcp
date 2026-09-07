# Native Codex mode

Native Codex mode uses the official `codex app-server --listen stdio://` process. It does not emulate the Codex sandbox with command regexes or rename the legacy execution policy. The desktop owns the connection; the native engine owns task execution, tools, sandboxing and its configured account/provider. Version 0.153.4 is the reviewed protocol version. Other versions are rejected until compatibility is verified.

## Enabling a workspace

1. Install the official native Codex CLI outside all writable project roots. Complete Codex login/provider setup yourself. On Windows select the real `codex.exe`, not an npm `.cmd` wrapper. Complete Codex's native Windows sandbox setup in Codex before using a sandboxed mode here; this app never approves UAC for you.
2. In MCP policy select **Native Codex** (`codex-native`), then save the desired sandbox and approval policy. Restart any MCP/Actions listeners that should use it. HTTP clients must authenticate with OAuth, bearer or API key.
3. In the local desktop Native Codex panel select the installed executable and command-network setting. Click Connect and review the OS-native consent dialog, executable path, workspace and additional writable roots. Enabling the bridge allows authenticated clients to submit tasks using your Codex account/provider and quota.
4. Submit a task locally, or through `codex_start` and `codex_continue`. Observe output with cursor-based `codex_status`; stop a turn with `codex_interrupt`. Sensitive native operations appear in the local desktop panel for one-time or session approval. The HTTP tool API has no approval endpoint, binary selector, arbitrary RPC method, sandbox override or writable-root override.

Settings, credentials or linked roots changing invalidates local consent. Restart the listener, then reconnect locally. Listeners created after consent are not automatically authorized. Closing the application or disconnecting terminates only this app's Codex process; the native Codex session files are retained. An uncertain RPC timeout closes the connection and never automatically replays a turn.

## Real execution policy

- `read-only`: native Codex read-only sandbox, command networking disabled.
- `workspace-write`: native Codex workspace sandbox, only the workspace and approved read-write linked roots added as writable, command networking disabled unless locally enabled. Automatic `/tmp` and `TMPDIR` write exemptions are excluded; use workspace `aiTemp/`.
- `danger-full-access`: native Codex unsandboxed full-access mode, including networking. An explicit warning is required locally. It is not a workspace boundary or an OS-level prohibition on deleting files.
- Approval choices are native `untrusted`, `on-request` and `never`; legacy Ask maps to native `untrusted`. This means trusting known safe operations rather than literally asking before every read. Legacy approval tokens are not used.

The app verifies the effective cwd, sandbox, network, writable roots and native approval reviewer returned by thread/start. A mismatch, unsupported native version or unavailable sandbox fails without switching to old tools or unsandboxed execution. Administrator policy enforced by Codex remains authoritative.

The configured native model/account, project instructions, skills and tools are those available in Codex, not copies of Claude Code. This app is a client of that engine, not a redistribution of the complete Codex desktop UI. It does not add its own screenshot/mouse/keyboard computer-use implementation.

## Boundaries and resource controls

At most four workspaces may be connected. Stdio frames, RPC queues, outstanding requests, pending approvals and retained output are bounded. Stdio uses backpressure, not periodic health polling; UI updates are event-driven and coalesced. Output is paginated, and old retained output can be dropped with an explicit truncation indication. Stderr/account/config notifications are not published to remote tool callers. A request ID deduplicates recent accepted task submissions; callers must not retry an uncertain operation automatically.

Only native command-execution, file-change and permission approval requests are currently presented. Unsupported interactive requests (including arbitrary custom-tool execution, account operations and MCP elicitation) are rejected, never automatically approved. Local approvals expire after five minutes and cannot be replayed across connections. Long tasks that require an unsupported interaction can fail; this is not a claim of full UI/protocol parity.

Selecting a binary and checking its version is not publisher-signature verification. Install from a trusted official distribution and protect the installation and Codex configuration from project writes. OS sandbox guarantees are provided by the selected official engine and supported host OS, not by this app's strings. Full access disables those guarantees. File-preservation instructions ask Codex to move unwanted files to Trash; they are not a kernel-enforced deletion ban. Keep recoverable backups.

Native model tasks use your existing Codex account quota or configured provider billing. CI validation must use only no-model local command/exec and protocol tests, never submit a billed turn or change your account. Existing v0.3.2 legacy profiles remain available for compatibility but are not advertised as native sandboxed mode.

## 繁體中文

原生模式會啟動官方 Codex app-server，由真正的 Codex 引擎處理任務、工具、沙箱及批准；不是只改權限名称，也不會在失敗時退回舊工具。先安裝並登入官方原生 Codex 0.153.4；Windows 需先在 Codex 完成沙箱設定，這個程式不會代你操作 UAC。

選擇 `codex-native` 工具模式、儲存政策並重新啟動 MCP／Actions，再在本機 Native Codex 面板選擇工作區外的可信任執行檔及允許的網絡範圍。點擊連線後會出現本機同意對話框。原生任務會使用你的 Codex 帳戶／供應商及額度；請只授權可信任用戶端和專案。

遠端只能啟動、繼續、查看或中止任務，不能改沙箱、指定執行檔或自行批准。需要批准的命令／檔案／權限請求只會出現在本機桌面。設定、密鑰或 linked roots 改變後需重新啟動 listener 並由本機重新連線。連線中斷或逾時不會自動重播不確定的操作。

唯讀及工作區模式預設不允許命令連網；工作區模式只加入本機已批准的可寫入 roots。Full access 真正移除 Codex 沙箱限制，並非安全工作區。舊 Ask 映射為 Codex `untrusted`，不是每個唯讀操作都詢問。程式會核對 Codex 回報的實際政策，不符時拒絕連線。

目前只支援指定的原生批准請求；不支援的互動會拒絕，而不是默認允許。本整合不是完整 Codex 桌面介面的複製，也沒有另行加入滑鼠／鍵盤／桌面截圖工具。帳戶及 session 檔案不會在斷線時刪除。保留檔案／移至 Trash 是給引擎的指示，不是作業系統禁止刪除的保證；請保留備份。原生安全界線及驗證結果會在實際測試後說明，不能單憑建置成功聲稱完全相容。
