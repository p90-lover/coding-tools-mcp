# MCP connection repair / MCP 連線修復

## English

A recognized @mention, a running desktop process, a copied endpoint, and a successful JSON health probe do not prove that ChatGPT has loaded this app's tools. Diagnose registration, public reachability, authentication, MCP initialization, tools/list, and tool selection separately. Do not delete/recreate an existing connection just because a model says it has no tools.

### Transport fixes in 0.4.1-rc.2

OAuth-protected MCP 401 responses now include a WWW-Authenticate Bearer challenge pointing to protected-resource metadata at the desktop-managed origin. Untrusted Host/Forwarded headers cannot choose that URL. Missing/expired tokens stay rejected; this is not an authentication bypass. The /mcp-specific well-known discovery alias is also exposed.

Accepted notifications, including notifications/initialized, now receive an empty HTTP 202 rather than HTTP 200 containing JSON null. Invalid/id-less tool requests are rejected before dispatch. An HTTP GET asking for an SSE stream is authenticated and then receives HTTP 405 because this transport does not offer an independent SSE stream. Ordinary JSON health discovery remains available. Tool responses can continue using JSON over POST; the server does not falsely advertise a tools/list_changed stream.

### Locate the failure

Use the existing workspace logs. During a fresh Scan Tools attempt, `authentication_rejected status=401` means a request reached the listener but did not authenticate. A following `catalog_served tools_count=N` means an authenticated caller successfully retrieved the catalog; it does not prove that caller was ChatGPT or that a particular chat has loaded it. No traffic during the attempt leaves client registration and network reachability unresolved; absence of a log line alone cannot distinguish them.

Compare the current public /mcp URL with the installed plugin's URL. Only an actual difference establishes an address mismatch. With the same address, retain the existing client ID, secret and OAuth grant; reconnect/refresh the existing plugin as needed. Verify the plugin is installed, enabled and selected in the intended chat/account/workspace. Refresh approved tool definitions after catalog changes. Plan, mode and administrator restrictions are controlled by ChatGPT, not the desktop app.

A fixed Named Tunnel hostname avoids Quick Tunnel address rotation, but does not repair absent plugin registration. The desktop cannot silently inject a namespace into a chat. Report the current /mcp URL, app version, Scan Tools error and relevant status-only logs. Never share profiles.json, OAuth passwords, client secrets, access/refresh tokens or Cloudflare tokens.

### Protocol negotiation and catalog refresh

The server now explicitly negotiates 2025-03-26, 2025-06-18 and 2025-11-25. It echoes a supported proposal and otherwise returns its highest implemented handshake revision, 2025-11-25. It does not blindly echo newer dates or claim the separate 2026 stateless protocol. Requests after initialization reject unsupported or duplicate MCP-Protocol-Version headers with HTTP 400; clients without that header retain legacy compatibility. A fallback only requires disconnection when the client does not support the selected revision—not every downgrade is a failure.

`tools.listChanged: false` means no server-push catalog notifications, not “cache forever.” It remains false because this build deliberately offers JSON POST, not a catalog-notification SSE stream. Flipping it without implementing a real stream is incorrect. ChatGPT's approved/frozen action snapshot is a separate host control; review/refresh the existing app where supported rather than deleting it as the first repair step.

The five v0.4.1 tools (`update_plan`, `get_plan`, `tool_search`, `get_current_time`, `codex_tools_status`) are present in both core and read-only catalogs, and in advanced. Unknown profile strings normalize to core. A read-only profile legitimately omits some execution/history tools, but it does not produce an empty catalog or hide these five tools.

`tools/list` now returns a SHA-256 fingerprint, normalized profile and count in `_meta`; `codex_tools_status` reports the same fingerprint and explicit supported versions. The hash covers definitions only, so permission-only updates leave it unchanged. Status logs record requested/negotiated protocol dates and the catalog fingerprint, without tokens or tool arguments. Compare an actual scan attempt's log with the host's approved tool snapshot before diagnosing the failure.

### Preserved boundaries

Permission-only updates retain the listener, tool schemas and authentication. This patch does not modify token issuance/rotation, stored credentials, computer-control grants, screenshot persistence, provider configuration or the unfinished native Codex branch. Installing a new binary still requires restarting the desktop application. No Codex/model calls are needed to build or test this repair. Verification uses three isolated local HTTP cases; it is not a test of the user's Windows installation or ChatGPT account.

## 繁體中文

ChatGPT 能識別 @mention、桌面程式正在運行、已複製端點，或 JSON 健康檢查成功，都不代表 ChatGPT 已載入此 App 的工具。請分開檢查註冊、公開連通性、認證、MCP 初始化、tools/list 及對話工具選擇。不要單憑模型說沒有工具，就刪除及重建既有連接。

### 0.4.1-rc.2 的傳輸層修正

受 OAuth 保護的 MCP 在回傳 401 時，現會附上 WWW-Authenticate Bearer 挑戰，指向由桌面程式設定的可信網域之資源認證資料。不可信的 Host／Forwarded 標頭不能更改該網址。缺少或過期的 Token 仍會被拒絕，並非繞過認證。亦加入 /mcp 專用的 well-known 探索路徑。

已接受的通知（包括 notifications/initialized）現會回傳沒有內容的 HTTP 202，而不是包含 JSON null 的 HTTP 200。無效或缺少 ID 的工具請求會在執行前被拒絕。要求 SSE 串流的 HTTP GET 會先驗證身分，然後回傳 HTTP 405，因為此傳輸並不提供獨立 SSE 串流。普通 JSON 健康檢查仍可使用；工具請求繼續透過 POST 回傳 JSON，不會假稱支援 tools/list_changed 串流。

### 找出失敗環節

在重新掃描工具時查看既有工作區紀錄。`authentication_rejected status=401` 代表請求已到達，但未通過認證。其後出現 `catalog_served tools_count=N` 代表某個已認證用戶端成功取得目錄，但不能單憑此證明該用戶端是 ChatGPT，或指定對話已載入工具。若掃描期間沒有流量，註冊及網絡問題都未排除；沒有紀錄本身不能區分兩者。

比較目前公開的 /mcp 網址與已安裝 Plugin 的網址，只有實際不同才證實網址不符。網址相同時，保留既有 Client ID、Secret 及 OAuth 授權，按需要重連／刷新既有 Plugin。確認在正確的帳戶／工作區／對話中已安裝、啟用及選擇 Plugin；工具目錄有變更時刷新已批准的定義。方案、模式及管理員限制由 ChatGPT 控制，不是桌面程式決定。

固定網域的 Named Tunnel 可避免 Quick Tunnel 換網址，但不能修復沒有註冊的 Plugin。桌面程式無法靜默向對話加入工具命名空間。診斷時提供目前 /mcp 網址、程式版本、Scan Tools 錯誤及相關狀態紀錄即可。不要分享 profiles.json、OAuth 密碼、Client Secret、Access／Refresh Token 或 Cloudflare Token。

### 協定協商與工具目錄刷新

伺服器現明確協商 2025-03-26、2025-06-18 及 2025-11-25。若支援用戶端提出的版本，會回傳相同版本；否則回傳已實作的最高握手版本 2025-11-25，不會盲目回傳更新的日期，亦不會假稱實作了另一套 2026 無狀態協定。初始化後的請求如包含不支援或重複的 MCP-Protocol-Version 標頭，會收到 HTTP 400；未提供標頭的舊用戶端保留相容性。只有用戶端不支援伺服器選定的版本時才應斷線，並非每次降版都會失敗。

`tools.listChanged: false` 代表沒有伺服器主動推送目錄變更通知，不是「永久快取」。本版本刻意使用 JSON POST 而非目錄通知 SSE 串流，因此保留 false；沒有真正實作串流就改為 true 並不正確。ChatGPT 已批准／凍結的工具快照是另一項用戶端控制；在介面支援的情況下，先審查／刷新既有 App，而不是先刪除連接。

五個 v0.4.1 工具（`update_plan`、`get_plan`、`tool_search`、`get_current_time`、`codex_tools_status`）同時存在於 core、read-only 及 advanced 目錄。未知的設定檔字串會正規化為 core。唯讀設定檔確實會省略部分執行／歷史工具，但不會令整個目錄變空，亦不會隱藏這五個工具。

`tools/list` 現在於 `_meta` 回傳 SHA-256 指紋、正規化設定檔及工具數量；`codex_tools_status` 亦會顯示相同指紋及明確支援的版本。雜湊只涵蓋工具定義，因此只修改權限時保持不變。狀態紀錄包含請求／選定的協定日期及目錄指紋，不包含 Token 或工具參數。請把一次實際掃描的紀錄與用戶端已批准的工具快照比對，再判斷失敗環節。

### 保留的限制

只修改權限時仍保留監聽服務、工具定義及認證。此修正沒有改動 Token 簽發／輪換、已存憑證、電腦操作授權、截圖儲存行為、供應商設定或未完成的原生 Codex 分支。安裝新執行檔仍須重新啟動桌面程式。建置及測試不用呼叫 Codex／模型。驗證使用三個隔離的本機 HTTP 案例，並非在使用者的 Windows 安裝或 ChatGPT 帳戶進行測試。

## References / 參考

- https://developers.openai.com/plugins/build/auth
- https://developers.openai.com/plugins/deploy/troubleshooting
- https://modelcontextprotocol.io/specification/2025-06-18/basic/transports
- https://help.openai.com/en/articles/12584461

- https://modelcontextprotocol.io/specification/2025-11-25/basic/lifecycle
- https://modelcontextprotocol.io/specification/2025-11-25/server/tools
