# Continuous local control and connection recovery

## Enable without a time limit

Select one application in **Computer control**, check **Always enabled**, then select **Enable until stopped** and approve the local confirmation. The existing **Enable for 10 min** mode remains the default. Continuous mode has no expiry deadline: the overlay shows **Always enabled**, not a fake long countdown or `0s`.

This is an explicit grant for the selected workspace/window/process while this app is running. Pause/Stop, Ctrl+Alt+Escape, target/focus checks and visible-monitor heartbeat still apply. Closing/minimizing the monitor, stopping/changing the service, or exiting the app ends the grant. It does not silently re-arm after application/Windows restart, and it does not grant access to a replacement process. Only the visible local UI can enable or resume control; MCP cannot switch the mode.

Screenshots remain in memory, including Live target and Exact agent frame. This release adds no image files, disk screenshot cache, thumbnails, recording or payload logging. OS paging/crash dumps and retention by the receiving client remain outside that application-level guarantee. No Codex model, agent, AI reviewer or inference fallback is invoked by these features or the build.

## Continuous use and replay protection

The request ledger is still bounded to 256 submitted actions per `session_id`. In continuous mode, call `computer_status` when `request_window_refresh_needed` is true (eight slots reserved for a bounded sequence). Once the current sequence is complete and all receipts are known submitted inputs, status can rotate to a fresh request-window `session_id` without asking the local user to enable control again. Use the returned ID for new work. Old IDs cannot authorize input; receipts are never silently evicted inside the same request window. The local target/grant and duration mode do not change. Uncertain outcomes, paused grants and incomplete sequences prevent this rotation. Reobserve and resolve them rather than replaying inputs.

## Connection improvements

The application health loop now checks its own Cloudflare children. An exited child can be restarted only when its saved workspace/auth/runtime configuration still matches and this app still owns the local listening service. Explicit Stop removes recovery eligibility. Retries use bounded backoff with a five-attempt cap; stable operation for two minutes resets the crash budget. At most two recoveries are attempted per health pass. Living cloudflared processes retain their own internal reconnect behavior; transient HTTP failures do not trigger restarts. No new service is started automatically after an app restart.

A changed Quick Tunnel URL is committed to the serialized profile store with a compare-before-update check; the existing trusted-origin resolver then updates OAuth discovery without regenerating OAuth secrets or restarting the MCP listener. Same-address restarts preserve the address. A changed hostname still requires the user's ChatGPT app update/authorization. Use a Named Tunnel with a fixed HTTPS hostname to avoid URL-driven connector recreation.

**Test tunnel** no longer stop/starts a running tunnel. It performs credential-free, redirect-free GET checks of the actual public discovery endpoint and, for OAuth, verifies issuer/resource/authorization/token endpoints, S256 and refresh support. Responses and timeouts are bounded. A failed probe leaves the running tunnel unchanged. The local service must be running before verification. A probe is not proof of a ChatGPT account connection or proof of end-to-end refresh-token acceptance.

The ChatGPT setup panel polls current tunnel/recovery status, warns when the address differs from the explicitly confirmed address, and offers the repair/setup handoff. URL conversion avoids `/mcp/mcp`. Named-tunnel tokens are passed via `TUNNEL_TOKEN` rather than process arguments; this is not a claim that environment variables are inaccessible to administrators. Startup failure/timeout stops the owned child instead of leaving an orphan.

## Scope

These are this app's Windows UIA/SendInput tools, not a bundled Codex computer-use runtime or upstream Codex OS sandbox. No silent ChatGPT consent, connector-management API, universal background desktop, or automatic authorization after reboot is claimed. Cloudflare account deployment and the user's actual ChatGPT image delivery still require real environment verification. Windows control is Windows-only; macOS retains the vision build.

## 繁體中文

在 **Computer control／電腦操作** 選擇視窗，勾選 **Always enabled／持續啟用**，再按 **Enable until stopped／啟用直到停止** 並確認。沒有十分鐘到期限制；原有十分鐘模式仍保留。停止、暫停、緊急快捷鍵、可見監控及指定視窗／程序限制不變。關閉監控或重啟程式會結束授權，不會在重啟後自動控制另一個程序。截圖仍只留在記憶體。

長時間操作可透過 `computer_status` 取得新的請求時段 `session_id`，避免 256 次操作後必須重新本機授權，同時拒絕舊 ID 重播。結果不明、未完成序列或暫停時不會自動清除記錄。

隧道新增自有 Cloudflare 子程序崩潰恢復、有上限的退避重試、明確停止後不自動復活、可信公開位址同步，以及不重啟連線的真實 MCP／OAuth 探索檢查。ChatGPT 設定面板會顯示恢復狀態及網址變更；固定網域可避免因換網址而重建連接。ChatGPT App 建立／更新及授權同意仍由使用者完成，不宣稱靜默設定已完成，也沒有呼叫 Codex 模型。
