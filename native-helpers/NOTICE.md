# Offline snapshot sandbox — v0.4.4-rc.1

## English

Implementation state: `experimental_snapshot_appcontainer`. Windows-only, opt-in, model-free. This is a custom AppContainer snapshot executor, **not OpenAI's complete Windows Codex sandbox**. The ordinary `exec_command`, `codex_command_exec`, and computer-use tools are unchanged and are not isolated by this feature. Existing OAuth rc.5 behavior and v0.0.7 extension compatibility are preserved.

Open the workspace's Computer controls and the Offline snapshot sandbox panel. With bearer/OAuth authentication and a writable policy, use the local checkbox and Save local approval. Only the visible/focused Desktop UI can grant it; MCP cannot. The grant persists for the same workspace ID, canonical root, authentication/runtime policy and embedded helper SHA-256. Old grants lacking this binding cannot authorize runs. Shared `ask`/`on-request`/`never` approvals still apply; full access skips only that existing soft layer and never replaces local consent or native isolation. Read-only blocks scratch execution. Stop, a permission/profile change, listener shutdown or backup recovery suspends saved grants; deliberate local reapproval is required. Stop affects all snapshot grants because only one snapshot can execute at a time. A revocation-save failure is surfaced; execution remains blocked in that process.

Call `sandbox_status` first. Availability means the build includes the helper, not that a process was tested on your PC. For `sandbox_exec`, supply `argv` with a system-directory EXE or selected input EXE and literal arguments; select individual `input_files` relative to this workspace. Empty selection copies nothing. Hidden/credential/reserved paths, linked projects, reparse points, directories and parent traversal are rejected. Input copies total at most 16 MiB/64 files. The input copy is read-only; writable scratch is a separate application-data `aiTemp/sandbox-snapshots/runs/<id>/work` directory. Programs can use `MCP_SANDBOX_INPUT` and `MCP_SANDBOX_OUTPUT`. Results include bounded stdout/stderr and the retained output directory; changes are never automatically imported into the project. No input credential/configuration is automatically inherited.

Example (substitute the actual Windows system path):

```json
{"argv":["C:\\Windows\\System32\\cmd.exe","/d","/c","type %MCP_SANDBOX_INPUT%\\hello.txt"],"input_files":["hello.txt"],"timeout_ms":5000}
```

The native helper is compiled and embedded with the application, extracted under application `aiTemp` and byte-checked before execution while a read-only handle is held. It must receive a supervision handshake after joining an outer kill-on-close Job. The child starts suspended; its AppContainer flag and requested SID are verified and its nested process Job assigned before resume. No network capabilities or loopback exemption are granted. A private caller-owned file and live loopback connection are negative-tested, with an unsandboxed synthetic baseline proving the resources exist. Descendants terminate on timeout, output overflow, Stop, permission change or helper shutdown. No isolation failure retries on the host. Setup does not use UAC, elevate, download Codex or invoke model APIs.

Limits: 100–30,000 ms execution, 64 KiB per output stream, 16 child processes, 512 MiB job memory. A monitored 64 MiB/1024-entry scratch threshold is **not a hard disk quota** and may overshoot between checks. At 32 retained runs, further calls fail until the user archives the old runs locally; no automated removal or OS-profile deletion is performed. Programs may still access Windows/AppContainer-package-readable locations and their OS-provided container data. This is not an isolated VM, complete filesystem secrecy, private desktop, or universal shell/development-tool compatibility. Source path validation is not a certificate against every same-user filesystem race. Do not put unrelated credentials into a sandbox input, command argument or broadly readable host file.

Verification uses three native boundary groups plus three integrated grant/policy/execution groups, the preserved OAuth browser-to-Rust checks, catalog checks and the Windows installer. Evidence distinguishes real native execution from synthetic test inputs/extension IPC; no user account, provider credential or paid Codex session is used. Windows installer is publisher-unsigned. No claim of live acceptance on the user's PC is made.

## 繁體中文

實作狀態：`experimental_snapshot_appcontainer`。僅支援 Windows，需主動啟用，不使用模型。這是自訂 AppContainer 快照執行器，**不是 OpenAI 完整的 Windows Codex 沙箱**。一般 `exec_command`、`codex_command_exec` 及電腦操作工具不會因此被隔離。保留 rc.5 OAuth 修正及 v0.0.7 擴充功能相容性。

在工作區的電腦控制頁，使用「離線快照沙箱」面板。本機視窗可見且具有焦點、使用 bearer／OAuth 認證及可寫策略時，勾選同意並儲存授權；MCP 不能授予此權限。授權綁定工作區 ID、正式路徑、認證／執行策略及內嵌 helper 的 SHA-256，缺少完整綁定的舊批准不能使用。共用 ask／on-request／never 授權仍有效；Full access 只跳過既有軟性提示，不能取代本機批准或原生隔離。Read-only 禁止暫存執行。停止、權限／設定變更、listener 關閉或備份恢復會暫停授權，必須再次由本機同意。因同時只允許一項快照執行，Stop 會撤銷全部快照批准；儲存撤銷失敗時會明確報錯，當前程序保持禁止執行。

先使用 `sandbox_status`；available 只代表建置包含 helper，不等於已在你的電腦完成執行測試。`sandbox_exec` 的 argv 指定真正 Windows 系統目錄 EXE 或輸入副本內的 EXE，後接逐項參數；input_files 只選擇當前工作區內明確列出的個別相對路徑。沒有選擇便不複製任何檔案。拒絕隱藏／憑證／保留名稱、連結專案、reparse point、資料夾及向上跳出路徑。輸入最多 64 個檔案／16 MiB，副本唯讀；可寫輸出位於應用程式資料的獨立 `aiTemp/sandbox-snapshots/runs/<id>/work`。程式使用 MCP_SANDBOX_INPUT／OUTPUT 環境變數定位；結果回傳有界輸出及保留目錄，不會自動把變更套用原專案，亦不自動繼承憑證或設定。

Helper 由原始碼編譯並內嵌於應用程式；執行前會比較檔案位元組並保持唯讀 handle。Rust 先把 helper 納入關閉即終止的 Job，再傳送固定握手。真正子程序先暫停，確認 AppContainer 標記及指定 SID、指派巢狀 Job 後才執行。不授予網路能力或 loopback 例外。測試先確認模擬私人檔案及 loopback 在無隔離基準可用，再驗證隔離後被拒絕。逾時、輸出溢位、Stop、權限更新或 helper 關閉會終止子程序樹；隔離失敗不會改用宿主重試。設定不使用 UAC、不提權、不下載 Codex，也不呼叫模型 API。

限制為 100–30,000 毫秒、stdout／stderr 各 64 KiB、16 個子程序及 512 MiB Job 記憶體。64 MiB／1024 個項目的暫存用量是監測值，**不是硬性磁碟配額**，檢查間可能超出。保留 32 次後須由使用者在本機封存舊紀錄才可繼續；不會自動刪除檔案或 OS profile。程式可能仍能存取 Windows／AppContainer 套件可讀位置及 OS 提供的 container 資料；不是虛擬機、完整檔案保密邊界、私人桌面或通用開發工具環境。路徑檢查不代表已排除所有同使用者檔案競爭條件。不要將無關憑證放入輸入、參數或公開可讀主機檔案。

驗證使用三組原生邊界及三組整合權限／執行測試，保留 OAuth 瀏覽器至 Rust、工具目錄及 installer 檢查。證據分清真正原生執行與模擬輸入／擴充功能訊息，不使用真實帳戶、供應商憑證或付費 Codex 會話。Windows 安裝程式沒有發行者簽章，未宣稱在使用者電腦驗收成功。


## Archived earlier documentation / 過往文件封存

The text below describes earlier releases, not current availability. / 以下為舊版本說明，不代表目前狀態。

# Upstream provenance and modifications — development only

**Release status: withheld_pending_native_verification. No native command helper binaries are bundled or executable in v0.3.6-rc.1.** The independent remembered/background computer-control and vision features do not depend on this prototype. See `docs/features/native-command-sandbox.md` for the current release boundary.

The preserved experimental Windows command sandbox adapts Apache-2.0 source from https://github.com/openai/codex at `3caf9f9586baedb4158a7b91545ead3dd320c348`. LICENSE-Codex contains the upstream license. This project is not an official OpenAI distribution.

`prepare_upstream.py` is a development adapter for a sandbox-only JSON binary. It namespaces OS accounts/group, requires local explicit preparation before provisioning, bounds captured output, and omits command arguments from ordinary command log previews. The upstream workspace dependency pins remain intact. It does not build or invoke the Codex CLI/agent.

`restrict_reads.py`, `desktop_boundary.py`, and `namespace_objects.py` preserve the experimental read-capability, private-desktop, and separate object-namespace changes for review. Their presence is not proof of successful native isolation or runtime compatibility; those release checks have not all passed. They are not applied during the control-only release build.

A future native command release would require validated helper binaries hash-bound into the installer, not runtime downloads. This candidate contains no such binaries. The prototype would apply only to `sandbox_exec`; it does not enclose graphical applications or retrofit existing command tools.

## 繁體中文

此目錄只保留實驗性原生命令沙箱的來源及授權資料。`v0.3.6-rc.1` 不打包或執行這些輔助程式，因為 Windows 執行環境／隔離驗證尚未全部通過。程式碼存在不代表已啟用或已驗證；電腦操作及視覺功能獨立運作，也不代表既有程式受到作業系統沙箱限制。
