# Shared workflow and native commands / 共用流程與原生命令

## English

### Human and AI work on the same board

An authenticated MCP or Actions listener exposes `workflow_list` and `workflow_update`. The listener's workspace identity and canonical root determine the scope; arguments cannot choose another workspace. Create a task directly in Backlog, In progress, Needs attention (`blocked`) or Done. Move, reorder, edit, archive and restore it without deleting history. Use `expected_revision` from the last read: a stale request is rejected without a partial save. After a lost response, read again rather than create a second task automatically.

`workflow_list` returns paged summaries (50 default, 100 maximum), or one task with 20 evidence entries per page when `task_id` is supplied. Continue with `next_offset` until null. `workflow_update` returns the updated task with the new board revision. Example:

```json
{"expected_revision":0,"change":{"operation":"create","title":"Check MCP tools","state":"blocked","description":"Verify discovery, then ask the operator to review the evidence."}}
```

Replace revision 0 with the actual revision. After reading the returned task ID, attach an observation:

```json
{"expected_revision":1,"change":{"operation":"observe","id":"returned-task-id","note":"Observed tools/list succeeding; the operator still needs to verify the intended chat can use those tools."}}
```

An observation is explicitly `mcp_observation`. It never advances the twelve human review checkpoints or becomes an operator attestation. Moving a card to Done does not certify its checklist. Humans review the observation and record their own checkpoint in the local UI. The open local board quietly refreshes committed changes every 2.5 seconds while visible, without resetting draft text; it pauses refresh during drag. Conflicts require a fresh read. Paseo/Anneal views remain read-only observations of separately managed services, not hidden autonomous engines.

The loop is: human goal → small plan → locally approved tool → observed result → shared board note → human correction/attestation → checkpoint → delivery. Reusing verified notes and history helps the next AI session avoid rediscovering the same facts. Humans learn by comparing the predicted result, actual evidence and correction. This is auditable context reuse, not automatic training of model weights.

### Standalone native commands without model use

`codex_command_exec` calls the official Codex App Server's `command/exec`, not `turn/start`, `process/spawn`, or `thread/shellCommand`. It creates no thread and requests no model inference. In the native panel, select the trusted official executable and a dedicated home outside the workspace, leave model permission unchecked, and separately approve standalone commands. The release is pinned to the exact official 0.153.4 executable digest verified during its build; another digest is rejected rather than silently ignoring an unsupported permission parameter. The expected digest is visible in runtime status.

```json
{"request_id":"diagnostic-001","argv":["cmd.exe","/d","/c","echo Ready"],"timeout_ms":5000}
```

Arguments are a literal argv array. The bridge fixes cwd to the approved workspace and `permissionProfile` to `:read-only`; callers cannot supply environment, a different profile, unlimited output, or an unsandboxed fallback. Limits: 32 arguments, 16,000 combined argument bytes, 100–10,000 ms, 16 KiB per output stream, 64 retained receipts per connection. A retry with the same request ID and arguments returns the original receipt; changed arguments or an unfinished receipt are rejected. Nonzero `exit_code` is an unsuccessful command even when the transport result has `ok:true`. Stop or a permission change invalidates the owned native process; an already submitted effect cannot be undone.

Read-only is not a workspace-only confidentiality boundary. Native read access can extend beyond the workspace; only run trusted commands. This new path is distinct from ordinary `exec_command` (software-policy governed) and the old withheld `sandbox_exec` helper. A specific write-denial regression is not certification of every native OS boundary. Native model use remains separately opt-in and can consume provider quota if a person enables it. No native model consent is necessary for standalone commands.

### Permissions, storage and compatibility

All workflow mutations pass the current hard-policy and approval checks. Permission-only saves keep the MCP listener, URL and OAuth identity, but revoke old grants and native sessions. Read-only mode rejects remote board mutations; reading the board remains available. The compatibility/full catalog exposes truthful mutation hints rather than relabelling writers as read-only. A client may require a tool-list refresh when schemas change. Installing a new executable requires restarting the application once; that differs from changing permissions.

Task notes persist in the app's existing data store. Screenshots do not: native image capture/preview remains RAM-only and no image logging was added. Keep secrets out of task notes. Fixed-hostname tunnel recovery and existing connection guidance remain unchanged; the app cannot silently register or reauthorize itself inside ChatGPT. Tests use isolated files under `aiTemp/`, no paid/synthetic model turns, and do not validate the user's live connection. No existing files or old releases are deleted.

## 繁體中文

### 人類與 AI 使用同一個看板

經認證的 MCP／Actions 監聽服務提供 `workflow_list` 與 `workflow_update`。範圍由服務綁定的工作區身分及正規化根目錄決定，參數不能指定其他工作區。可直接在待辦、進行中、需要處理（`blocked`）或完成欄建立任務，並移動、排序、編輯、封存及還原，不刪除歷史。使用最近讀取的 `expected_revision`；過期請求會被拒絕，不會部分儲存。若回應遺失，先重新讀取，不要自動建立另一個重複任務。

`workflow_list` 提供分頁摘要（預設 50、最多 100 項），指定 `task_id` 時則每頁提供該任務最多 20 項依據；依 `next_offset` 繼續，直至 null。`workflow_update` 回傳更新後任務及新修訂版。以上 JSON 的 revision 0、1 及示例 ID 必須換成實際回傳值。

AI 觀察明確標為 `mcp_observation`，不會推進十二個人類審查關卡，也不能冒充操作者確認。把卡片移到完成欄，不代表清單已驗證。人類應閱讀觀察，再於本機 UI 記錄自己的審核。可見的本機看板每 2.5 秒悄悄刷新已提交變更，不清空輸入草稿；拖曳期間暫停刷新。衝突必須重新讀取。Paseo／Anneal 頁面仍是獨立服務的唯讀觀察，不會偷偷啟動自主引擎。

流程是：人類目標 → 小範圍計劃 → 本機批准工具 → 觀察結果 → 共用任務筆記 → 人類修正／確認 → 檢查點 → 交付。下次 AI 會話可以重用已驗證筆記，避免重複摸索；人類則透過比較預測、證據及修正學習。這是可稽核的上下文重用，不是自動訓練模型權重。

### 不呼叫模型的獨立原生命令

`codex_command_exec` 呼叫官方 Codex App Server 的 `command/exec`，不是 `turn/start`、`process/spawn` 或 `thread/shellCommand`；不建立會話，也不要求模型推論。在原生面板選擇可信官方執行檔及工作區外的專用主目錄，保持模型權限不勾選，再獨立批准命令。版本綁定建置時驗證的官方 0.153.4 執行檔雜湊；不同雜湊會被拒絕，不會靜默忽略不支援的權限參數。狀態面板會顯示所需雜湊。

參數是 argv 字串陣列，cwd 固定為已批准工作區，`permissionProfile` 固定為 `:read-only`。用戶端不能傳入環境變數、其他權限、無限輸出或無沙箱後備模式。上限：32 個參數、合計 16,000 位元組、100–10,000 毫秒、每個輸出串流 16 KiB、每條連接保留 64 份收據。相同 ID 及參數重試只回傳原收據；參數不同或結果未定會拒絕。即使傳輸結果為 `ok:true`，非零 `exit_code` 仍代表命令失敗。停止或權限變更會撤銷所屬程序，已送出的作用不能撤回。

唯讀不是只限工作區的保密界線，原生可讀範圍可能更廣；只應執行可信命令。這條路徑與一般 `exec_command`（軟體策略）及仍未發佈的舊 `sandbox_exec` 輔助程式分開。特定拒絕寫入測試不等於所有作業系統界線均已認證。模型使用仍須另外明確啟用，啟用後可能消耗供應商額度；獨立命令不需要模型授權。

### 權限、儲存與相容性

流程變更均須通過目前的硬性策略及批准檢查。只修改權限時保留 MCP 服務、網址及 OAuth 身分，但會撤銷舊授權和原生連接。唯讀模式拒絕遠端看板修改，仍允許讀取。相容／完整目錄如實標示寫入工具，不會假裝它們是唯讀。工具定義變更可能要用戶端刷新目錄；安裝新執行檔則要重新啟動程式一次，與修改權限不同。

任務筆記會存在既有資料庫，截圖則不會。原生擷取／預覽仍只在記憶體處理，沒有新增圖片日誌。不要把秘密寫入任務筆記。既有固定網域隧道恢復及連接指引保留；程式不能靜默向 ChatGPT 註冊或重新授權。測試只在 `aiTemp/` 的隔離檔案中執行，不啟動付費或模擬模型回合，亦不代表你的實際連線已驗證。現有檔案及舊版本均不刪除。
