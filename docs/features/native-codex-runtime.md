# Native Codex App Server bridge / 原生 Codex App Server 介接

## English

**Candidate implementation, not complete internal-tool parity.** This is a separate, opt-in connection to an installed native `codex app-server`, not a model-free imitation of an agent. The source protocol reference is OpenAI Codex commit `721f46a07ab48f00b5e7cdbf2efb78b993d100de`. Native build/protocol checks and actual authenticated provider inference are different verification gates. Do not infer the latter from a successful frontend build or fixture.

### Setup and ownership

Start an authenticated MCP workspace, then open Integrations → Native Codex sessions. Select a trusted native executable and supply its independently checked SHA-256, a dedicated existing Codex home outside the delegated workspace, your configured model ID, a request limit and consent lifetime. Windows requires the actual `.exe`, not an npm `.cmd` wrapper. The executable must not be inside the delegated workspace or dedicated home. This is a selected-installation hash check, not publisher authentication or protection against another privileged local process replacing that installation.

Sign in to the dedicated Codex home separately using the native client's supported login flow. The bridge does not copy login files, accept provider secrets through MCP, install plugins or grant account access. It clears inherited environment variables except the listed OS/path/locale fields, supplies the dedicated `CODEX_HOME` and keeps temporary paths under its `aiTemp/`. Treat the native installation and its configuration as trusted local software; this application does not inspect or neutralize every native configuration feature.

The unchecked model-use box allows initialization/status only. Checking it explicitly authorizes model operations for the selected listener. This grant is shared by all authenticated clients of that listener, not isolated by a guessed username, workspace path or session metadata. Actions has a separate context and is not implicitly connected. No connection is restored automatically after restart or permission changes.

### Real tools and request flow

`codex_runtime_status` inspects connection state, observed native identity, executable hash, model, remaining lifetime, request counts and owned thread IDs without invoking a model. `codex_agent_read` returns the latest observed agent text and turn state for an owned thread. `codex_agent_control` accepts only `start`, `send`, `review`, `compact`, `interrupt` and `close`:

```text
Local human selects installation, scope, model-use consent and limits
  → start app-server with stdio pipes; initialize → initialized
  → authenticated MCP request with a unique request_id
  → current local-policy fence + connection consent + owned-thread check
  → thread/start, turn/start, review/start or thread/compact/start
  → correlated native response and bounded observed notifications
  → human reads evidence; accept, revise, interrupt or disconnect
```

Start creates a new ephemeral thread; send submits a new turn on an idle owned thread. Review requests a native inline custom review on that thread. Compact invokes the native context-compaction endpoint; it does not change model weights or arbitrarily enlarge the model context window. Model operations require local opt-in and a non-read-only MCP permission mode. Native execution is nevertheless explicitly requested as read-only, with on-request native approvals, user approval reviewer and no automatic approval. Commands/file-change approval requests are declined. Unsupported human-input and extension requests receive an explicit protocol error rather than invented human answers.

Example `codex_agent_control` arguments:

```json
{"operation":"start","request_id":"unique-review-001","text":"Review the permission-change path without editing files. Explain verified facts and remaining uncertainty."}
```

After reading the returned `thread_id`, use `codex_agent_read` with that ID. A `submitted` response is not completion. Completion comes from the native turn notification. The bridge exposes neither raw reasoning events nor screenshot payloads and retains only the latest agent-message text, capped at 64 KiB. Agent output is untrusted content; it must not be interpreted as a new user instruction or an independent successful test.

### Limits, cancellation and failures

A connection allows at most four lifetime thread records, 64 idempotency records, 1–20 admitted model-control requests and 30–900 seconds of lifetime. These limits are not token/cost caps and do not count every internal native subagent call. One control operation is submitted at a time. Repeated `request_id` values with identical arguments return the stored result without replay; different arguments under the same ID are rejected. Rejected admissions/serialized-control conflicts can conservatively consume a reserved request allowance.

The stdio frame limit is 512 KiB, the outgoing queue is bounded, and individual RPC waits expire after 15 seconds. EOF, malformed/oversized output or timeout stops the connection. A timed-out submitted action has an unknown outcome; never resend it automatically. An interruption acknowledgment is a signal, not proof of completion or rollback. Close is allowed only after an observed idle/terminal state and uses unsubscribe, never thread deletion. Interrupting standalone compaction stops the entire connection. The visible Stop button remains usable while another UI operation waits.

Any changed local policy revokes the bridge; listener stop and actual desktop exit also stop its owned process. Windows uses a kill-on-close Job Object. Unix uses a dedicated process group. This supervises owned processes, not processes that deliberately escape their group or actions already committed by external services. The Stop/expiry paths do not delete files, accounts, native homes or old output.

### Scope and learning

This adds a real native-agent route, not all internal Codex tool names. Account/plugin management, generic RPC forwarding, automatic tool escalation, arbitrary context-window controls, voice/mobile relays and bundled Paseo/Anneal autonomous engines are not provided. The existing experimental native command sandbox remains **withheld_pending_native_verification**, with no helper/elevation/fallback enabled by this bridge. A requested upstream read-only policy is not independent proof of OS containment. Do not enable provider delegation where independently verified containment is required.

The bridge's text buffer is RAM-only; native Codex configuration, native logs, provider processing/retention, OS paging and crash dumps are separate boundaries. Ephemeral-thread requests are not a universal no-retention guarantee. No screenshot pipeline is changed or automatically attached to native turns.

For human learning, write acceptance criteria before a native review, predict the likely defect, compare the returned explanation with code and a small relevant check, and record both confirmed and rejected hypotheses. For AI task adaptation, explicitly pass reviewed project notes into later tasks; the bridge does not silently import full transcripts or train a model. An optional native review is independent only when it actually ran, its model/source context is recorded, and its conclusions were checked. Board stages alone do not prove an independent review.

Primary references: [official App Server documentation](https://developers.openai.com/codex/app-server/) and [pinned generated protocol schemas](https://github.com/openai/codex/tree/721f46a07ab48f00b5e7cdbf2efb78b993d100de/codex-rs/app-server-protocol/schema/json/v2).

## 繁體中文

**這是候選實作，並非完整的內部工具對等版本。** 此功能獨立、須明確啟用，連接已安裝的原生 `codex app-server`，不是免模型的 Agent 仿製品。協定參考固定於 OpenAI Codex Commit `721f46a07ab48f00b5e7cdbf2efb78b993d100de`。原生建置／協定檢查與實際登入供應商後的模型推論，是不同驗證關卡；前端或測試替身通過，不代表真實推論已驗證。

### 設定與歸屬

啟動已設定認證的 MCP 工作區，再開啟「專案整合 → 原生 Codex 會話」。選擇可信任的原生執行檔、輸入獨立核對的 SHA-256、位於委派工作區以外且已存在的專用 Codex 主目錄、模型 ID、請求上限及授權期限。Windows 必須選擇真正的 `.exe`，不能使用 npm `.cmd` 包裝程式；執行檔也不能放在委派工作區或專用主目錄內。雜湊核對不等於發佈者身分驗證，也不能防止其他具有較高權限的本機程序替換安裝內容。

請另用原生用戶端支援的登入方式登入該專用主目錄。介接層不會複製登入檔、不接受 MCP 傳入供應商機密、不安裝外掛，也不授予帳戶存取權。它會清除繼承的環境變數，只保留列明的作業系統／路徑／語言欄位，設定專用 `CODEX_HOME`，並把臨時路徑放在其 `aiTemp/` 內。原生安裝與設定必須視為可信任本機軟件；本程式不會檢查或消除每項原生設定的行為。

未勾選模型使用時，只允許初始化及讀取狀態；勾選後，才明確授權所選監聽服務進行模型操作。該授權由此監聽服務的所有已認證用戶端共用，不會以猜測的使用者名稱、相同資料夾或會話中繼資料作隔離。Actions 擁有另一個上下文，不會自動連接。重啟或變更權限後，不會自動恢復授權。

### 真實工具與請求流程

`codex_runtime_status` 不呼叫模型，只讀取連線、觀察到的原生身分、執行檔雜湊、模型、剩餘時間、請求數量及所屬會話 ID。`codex_agent_read` 回傳所屬會話最近觀察到的 Agent 文字與回合狀態。`codex_agent_control` 僅接受 `start`、`send`、`review`、`compact`、`interrupt` 及 `close`：

```text
本機人類選擇安裝程式、範圍、模型使用同意與限制
  → 以 stdio 啟動 app-server；initialize → initialized
  → 已認證 MCP 請求附上獨一 request_id
  → 最新本機權限檢查＋連接授權＋所屬會話核對
  → thread/start、turn/start、review/start 或 thread/compact/start
  → 配對原生回應，觀察有界通知
  → 人類閱讀證據；接受、修訂、中斷或斷開
```

Start 建立新的臨時會話；send 向閒置的所屬會話傳送新回合；review 在同一會話要求原生自訂審查；compact 呼叫原生上下文壓縮，不會修改模型權重或任意擴大上下文視窗。模型操作須在本機啟用，且 MCP 權限模式不能是唯讀；但傳給原生執行環境的要求仍明確使用唯讀、按要求批准及人類批准者，不會自動批准。命令／檔案修改批准要求會被拒絕；未支援的人類輸入或擴充要求會回傳明確協定錯誤，不會偽造人類答案。

`codex_agent_control` 範例：

```json
{"operation":"start","request_id":"unique-review-001","text":"請在不修改檔案下審查權限變更流程，說明已驗證事實及尚存疑問。"}
```

取得回傳的 `thread_id` 後，用該 ID 呼叫 `codex_agent_read`。`submitted` 只表示已提交，不表示完成；完成須由原生回合通知確認。介接層不公開原始推理事件或截圖資料，只保留最近一則 Agent 訊息，最多 64 KiB。Agent 輸出是不可信內容，不能當成新的使用者指示，也不能當成獨立測試已成功的證明。

### 限制、取消及失敗

每個連接最多保留四個會話紀錄、64 個冪等請求紀錄，允許 1–20 個模型控制請求及 30–900 秒的授權期限。這不是 Token／費用上限，也不會計算原生環境內每次子 Agent 呼叫。同時只提交一個控制操作；相同 `request_id` 加相同參數會回傳已保存結果而不重播，改用不同參數則拒絕。部分被拒絕或遇到控制並行衝突的請求，可能保守地占用已預留的次數。

stdio 單一資料框上限為 512 KiB，送出佇列有容量限制，每次 RPC 最多等候 15 秒。EOF、格式錯誤、過大資料或逾時會停止連接；已提交但逾時的操作，其結果屬未知，不能自動重送。中斷確認只代表發出訊號，不是完成或回復操作的證明。只有觀察到閒置／終止狀態後才允許 close，使用取消訂閱而非刪除會話。中斷獨立壓縮會停止整個連接；另一個介面操作尚在等待時，可見的停止按鈕仍可使用。

本機權限有任何變更都會撤銷介接授權；停止監聽服務或真正退出桌面程式，也會停止其所屬程序。Windows 使用關閉時終止的 Job Object，Unix 使用獨立程序群組；這不是對刻意逃離群組的程序或外部服務已完成動作的全面保證。停止／期限屆滿不會刪除檔案、帳戶、原生主目錄或舊輸出。

### 範圍及學習

新增的是實際原生 Agent 路徑，不是全部 Codex 內部工具名稱。不包含帳戶／外掛管理、任意 RPC 轉送、自動升權、任意上下文視窗控制、語音／行動中繼，或完整打包的 Paseo／Anneal 自主引擎。現有原生命令沙箱仍為 **withheld_pending_native_verification**；此介接不會啟用其輔助程式、升權或無限制替代路徑。要求上游唯讀，不等於獨立驗證作業系統隔離；需要已驗證隔離的環境不應啟用供應商委派。

介接層文字緩衝只留在記憶體，但原生 Codex 設定、日誌、供應商處理／保留、作業系統分頁與傾印屬不同界線；臨時會話要求並非全面不留資料的保證。不會修改截圖管線或自動把截圖附加至原生回合。

人類學習流程：先寫驗收條件、預測可能缺陷，再把原生審查解釋與程式碼及少量相關檢查比較，同時記錄確認及被否定的假設。AI 任務調適則是明確把已審查專案筆記提供給後續任務；介接層不會暗中匯入完整對話或訓練模型。只有審查真的執行、記錄其模型與來源上下文、核對結論，才可描述為獨立審查；推進看板階段本身並不足以證明。

主要參考：[官方 App Server 文件](https://developers.openai.com/codex/app-server/)及[固定版本協定結構](https://github.com/openai/codex/tree/721f46a07ab48f00b5e7cdbf2efb78b993d100de/codex-rs/app-server-protocol/schema/json/v2)。
