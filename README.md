# Coding Tools MCP

**繁體中文** · [English](README.en.md) · [版本及 Windows 安裝程式](https://github.com/p90-lover/coding-tools-mcp/releases) · [AI／人類協作流程](docs/guides/ai-human-workflow.zh-Hant.md)

協助 AI 開發工作的本機桌面控制中心：人類訂立目標與權限，已連接的 AI 思考任務，應用程式執行獲准的本機工具並回傳證據。專案歷史讓下一次對話接續已驗證的工作，而非憑記憶重建進度。

**版本系列：`v0.4.4-rc.1`——限定 OAuth 彈出視窗來源修正。** 請閱讀[版本說明](docs/releases/v0.4.4-rc.1.md)及公開版本所附的驗證紀錄。原始碼中的版本號不代表建置已通過；這是候選版本，不是經認證的安全沙箱。

## 為何 ChatGPT 可能看不到全部工具

已存工具目錄與執行權限是兩種不同設定。本版修正 Core／Advanced／full 別名的選項，ChatGPT 設定現會顯示運行中服務實際公開及被目錄隱藏的名稱，以及中繼資料雜湊；`server_info.tool_catalog` 回報相同證據，不會假稱已知 ChatGPT 對話載入了哪些工具。[查看工具公開指南](docs/guides/tool-exposure.zh-Hant.md)。

## 選用的原生 Codex 橋接

目前候選版本加入須明確啟用的原生 App Server 介接，與已發佈的免模型工具分開。`codex_runtime_status`、`codex_agent_read` 及 `codex_agent_control` 支援所屬文字會話、原生審查、壓縮、中斷及取消訂閱。模型使用同意、可信任執行檔 SHA-256、請求／期限上限及停止，都由本機桌面控制。[閱讀設定、流程及精確限制](docs/features/native-codex-runtime.md)。原始碼存在不代表已發佈或已通過供應商推論驗證。

## 下載及開始使用

從[指定版本頁面](https://github.com/p90-lover/coding-tools-mcp/releases/tag/v0.4.4-rc.1)取得 `Coding.Tools.MCP_0.4.4-rc.1_x64-setup.exe`。本次 Windows 修正版提供 SHA-256 校驗碼、原始碼來源及驗證紀錄；Apple Silicon `.dmg` 仍保留於前一版 `v0.4.3-rc.1`。Windows 安裝程式沒有發佈者簽署；macOS 使用 ad-hoc 簽署，未經公證。開啟下載檔案前，請先核對來源及校驗碼。

安裝並開啟程式，把專案目錄加入工作區，選擇認證及權限設定，然後啟動 MCP。遠端用戶端需要設定支援的 FRP／Cloudflare 連線，再複製介面顯示的 HTTPS `/mcp` 網址。在用戶端完成授權及工具掃描；修改前先使用 `server_info`、`codex_tools_status`、`get_default_cwd` 及 `git_status`。

使用 ChatGPT 時，請依帳戶／工作區提供的 Apps／開發人員模式設定。功能資格、操作確認及工具刷新受用戶端與管理員控制；本程式不能授予 ChatGPT 帳戶權限，也不能取消其確認要求。請參閱 [OpenAI 最新設定指引](https://help.openai.com/en/articles/12584461-developer-mode-and-mcp-apps-in-chatgpt-beta)，不要把舊選單截圖當成現行指示。本程式提供輔助設定，不會靜默建立或重新授權連接器。

## 產品包含甚麼

| 範疇 | 已實作行為 |
| --- | --- |
| 控制中心 | 工作區／服務總覽、可搜尋導覽、會話、整合設定、本機交付看板、深淺主題及英文／繁體中文控制項；部分沿用的進階表單保留既有語言。 |
| 本機開發 | 檔案讀取／列出／搜尋、交易式修補、命令、有限輸出及標準輸入、Git 檢查、限定操作的批准請求與專案指示。 |
| 即時權限 | 只變更權限時，直接更新運行中的 MCP／Actions，不重啟監聽服務、不更換隧道網址，也不重建認證狀態。 |
| 電腦觀察 | Windows 視窗探索，以及觀察已批准、受支援且未縮小的背景視窗；預設不把它切到前台。 |
| 電腦輸入 | 在本機批准、可見監控、重試保護及緊急停止之下，對指定前台應用程式執行鍵鼠操作；不是隱形背景輸入。 |
| 記住批准 | 持續啟用直到停止、選擇記住指定執行檔、重啟後恢復及 Windows 登入時啟動；仍會核對安全設定與執行檔身分。 |
| 視覺 | 螢幕／視窗擷取、圖片查看／資訊／比較，以及 GPT 所見／即時預覽；截圖像素只留在應用程式記憶體。 |
| Paseo＋Anneal | 讀取已存在本機服務的唯讀介接器、附上游授權的狀態／排序邏輯，以及由使用者操作的十二階段交付清單；不是完整自主 Agent 引擎。 |

詳細文件：[電腦操作](docs/features/local-computer-use.md)、[記住批准](docs/features/remembered-control.md)、[視覺](docs/features/local-vision.md)、[Paseo／Anneal 整合](docs/features/paseo-anneal-control-center.md)。

## 變更權限，不必重新連接 MCP

開啟工作區的權限面板，修改 **Permission mode／權限模式**、**Approval mode／批准模式**、命令規則或螢幕擷取權限，再儲存。下一個獲准進入執行流程的請求會使用已發佈的權限修訂版；`server_info.live_permissions` 可查看修訂版及實際設定。

只變更權限不會替換監聽服務、網址、Bearer Token 或 OAuth 執行環境，也保留既有歷史及目前目錄。舊操作批准會被撤銷；運行中的所屬命令會拒絕後續輸入並收到終止要求，但輸出仍可讀取。若短操作正在提交，可能回傳 `LIVE_POLICY_BUSY`：重試儲存即可，不必重啟服務。儲存失敗不會部分套用權限；已送出的作業系統操作不能追回。

**權限模式不等於工具設定檔。** 改變工具設定檔可能會公開不同工具結構，用戶端便可能需要刷新清單。認證、連接埠及工作區根目錄變更屬於另一類生命週期變更。Quick Tunnel 換網址後，仍要更新用戶端端點；固定網域可避免網址輪替。已記住的程式批准與安全設定綁定，變更安全設定後可能需要本機重新批准，但不是重新連接 MCP。

[閱讀即時權限約定](docs/features/live-permissions.md)。

## MCP 內有哪些 Codex 類工具？

這些是**可實際呼叫的本機對應功能**，使用 `tools/list` 回傳的結構，不是複製的 Codex Agent 執行環境。`tool_search` 可搜尋目前目錄，`codex_tools_status` 會列出已支援及未包含的能力。

| 工具類別 | MCP 工具／界線 |
| --- | --- |
| 執行與檢查 | `exec_command`、`write_stdin`、`read_output`、`kill_command`；保留舊 `session_id` 及 `kill_session` 相容性。 |
| 檔案與修補 | `read_file`、`list_dir`、`list_files`、`search_text`、`grep_text`、`apply_patch`；其他工具視所選設定檔而定。 |
| 計劃與探索 | `update_plan`、`get_plan`、`tool_search`、`get_current_time`；計劃是有上限、屬於該監聽服務的記憶體狀態，不是自主排程器或永久任務檔案。 |
| 權限 | `request_permissions` 只針對指定操作；永久權限設定仍由本機介面管理。 |
| 圖片與桌面 | `view_image`、`image_info`、`compare_images`、`capture_screenshot`、`capture_window` 及 `computer_*` 工具。 |
| 持久上下文 | `history_session_bootstrap`、`history_session_search`、`history_session_read`、`history_session_checkpoint`、`history_session_validate`。 |
| 可選原生執行環境候選功能 | `codex_runtime_status`、`codex_agent_read`、`codex_agent_control`；另經本機啟用後，可呼叫已安裝的 Codex 進行文字回合、審查及原生壓縮。 |
| 未包含 | 全部 Codex 內部工具對等功能、雲端網頁搜尋／帳戶／外掛 API、Paseo／Anneal 自主引擎及未驗證的原生命令沙箱。 |

**不是每一項 Codex 內部工具都已加入。** 單純執行本機工具不會呼叫 Codex 或消耗其推論配額；所選 AI 用戶端仍有自己的用量，外部 Paseo／Anneal Agent 也可能自行消耗供應商配額。已發佈的免模型路徑不會啟動那些 Agent 或另一個 AI 審查員；但另外明確啟用的原生介接可以開始模型工作及原生審查，不能把它描述為不消耗配額。

## 協作流程：人類 → AI → 工具 → 證據

```text
人類：目標、允許範圍、驗收條件及風險限制
  → AI：閱讀專案指示並恢復有界歷史
  → 人類＋AI：確定小範圍計劃與相關檢查
  → 程式：按最新權限核對每次工具請求
  → 工具：檢查／修補／執行／觀察
  → AI：把實際結果與驗收條件比較
  → 人類：審查變更、處理疑問、接受或要求修改
  → 歷史：保留證據及精確交接位置
  → 明確授權交付：已驗證原始碼＋安裝程式＋校驗碼
```

本機看板依次記錄「規格 → 計劃 → 計劃審查 → 修訂計劃 → 實作 → 程式碼審查 → 獨立審查 → 套用修正 → 文件 → 驗證 → 合併準備 → 交付」。這些是使用者管理的檢查點；推進卡片不會執行程式、完成獨立審查或合併 Pull Request。

[協作流程指南](docs/guides/ai-human-workflow.zh-Hant.md)包含實例、會話提示及學習紀錄範本。目的是建立更緊密、可檢查的回饋流程：減少重複解釋、讓變更更小而易審查，並明確附上證據；沒有量度自己的工作流程前，不能保證速度或品質有所提升。

## AI 與人類如何從工作中學習

人類審查假設、預測結果、核對實際輸出，再解釋修正原因；AI 則可在下次會話讀取已批准的專案指示與先前驗證紀錄，以取得更好的任務上下文。歷史檢查點或看板卡片不會重新訓練模型，也不會改變模型權重。

學習筆記應記錄事實：症狀、假設、最小有用檢查、結果、原因、修正、回歸風險及可重用經驗。把觀察結果與推測分開，保留被否定的假設。持久經驗應寫入經審查的專案 Markdown 或歷史，不要記錄憑證或截圖。可追蹤重複回歸、審查返工、不明結果重試及交接時間，而不是未經驗證地宣稱 AI 變得更聰明。

## 安全與私隱界線

螢幕擷取需要在本機選擇啟用。監控顯示真實畫面，而非生成預覽；**Exact agent frame／GPT 所見畫面**使用最近回傳給用戶端的相同圖片位元組。保留**暫停、停止及 Ctrl + Alt + Esc**。持續啟用不代表持續錄影、批准所有視窗或允許解鎖 Windows；受保護／已縮小視窗可能無法擷取。

程式不會把截圖寫成圖片檔、縮圖、錄影或磁碟截圖快取。作業系統可能把記憶體分頁至磁碟或建立當機傾印，接收圖片的用戶端也可能保留圖片；畫面像素不會自動遮蔽機密。

臨時工作使用 `aiTemp/`，不用的檔案移至 `Trash/`，不要永久刪除。Patch 的刪除操作會改為移至已批准根目錄內的 `aiTemp/Trash/`。**任意子程序並沒有全面的「禁止刪除」或檔案系統沙箱保證。** 命令界線仍是 `policy_only`，`sandbox_enforced: false`；未驗證的沙箱執行器仍停用，也不會回退至無限制執行。完整存取權限不等於管理員權限或作業系統隔離。

## 開發與驗證

程式使用 Rust、Tauri 2 及 SvelteKit。請使用鎖定檔與發佈流程指定的版本，並安裝 [Tauri 平台先決條件](https://v2.tauri.app/start/prerequisites/)。

```sh
npm ci
npm run check
npm run build
npm run desktop
```

即時權限修改應優先驗證同一個 HTTP 服務上的權限切換、原子儲存／撤銷，以及本機工具往返；電腦操作修改還須執行隔離 Windows 鍵鼠／截圖測試。只預覽前端，不能驗證原生 IPC、認證或桌面輸入。發佈閘門會檢查安裝程式內的實際執行檔、版本與授權條款，並重新下載檔案核對 SHA-256。

原始碼位於 `src/`（介面）、`src-tauri/src/tools/`（共用執行），以及 `src-tauri/src/` 之下的 `mcp/`、`actions/`、`tunnel/`、`integrations/`（傳輸、連線及管理介接器）。`old/` 保留固定上游快照。舊 README 保留於 `aiTemp/Trash/readme-before-live-permissions/`，只作歷史文件，不是現行設定指引。

## 授權與來源

[Apache-2.0](https://www.apache.org/licenses/LICENSE-2.0)。上游資訊及隨安裝程式提供的授權條款：[Paseo／Anneal 聲明](third_party/CONTROL_CENTER_NOTICES.md)。本專案並非 OpenAI／Codex 官方產品。

## 共用流程與免模型原生命令

`workflow_list` 及 `workflow_update` 把經認證的 MCP 工作區連接到同一本機看板；遠端觀察不會冒充人類批准。`codex_command_exec` 使用固定版本的原生命令 API，須獨立本機授權，不啟動模型回合。只變更權限仍不須重新連接／重啟 MCP。範圍、分頁、範例、配額及限制請見[雙語流程／命令指南](docs/features/workflow-native-commands.md)。
