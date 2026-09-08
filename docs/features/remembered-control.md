# Remembered Windows control and background observation

## Local approval choices

The existing Always enabled mode removes the timer. This release additionally exposes **Remember this exact app**, **Restore after app restart**, **Start at Windows sign-in**, **Discover all window titles**, and **Start observation without taking focus**. Each is off unless the local user explicitly approves it, except the no-focus observation preference, which defaults on. Windows startup is a current-user Run entry; disabling it writes an empty entry rather than deleting files or registry keys.

Remembered authority is bound to a canonical workspace, its authentication/security settings, and the application's canonical executable path plus SHA-256. It is not an unrestricted desktop grant. Changed executables, changed workspace/authentication policy, ambiguous duplicate windows or minimized/locked desktops are not automatically authorized. App updates require renewed approval. One workspace can be automatically restored at a time. There are at most 16 remembered executables per workspace and 32 remembered workspaces.

On application startup, a bounded discovery loop waits for the already-running preferred app. It never launches the target app. An exact matching window can restore its saved authenticated MCP service/tunnel, its no-expiry control session and the visible control monitor. There is no action until the monitor supplies a live heartbeat. It does not unlock Windows, interact with UAC or operate on the secure desktop. After one hour without an unambiguous match, it stops searching. This is sign-in startup, not pre-login access or operation while Windows is locked.

Pause, local or remote Stop, the emergency shortcut and monitor hide/minimize/close suspend the remembered automatic grant. Normal explicit application Quit releases RAM session state without revoking the remembered preference. A backed-up profile restored after corruption has all remembered permissions suspended. The local UI can resume or revoke remembered approval; remote MCP cannot enable it. Failure to save revocation is reported, and sign-in startup is disabled where possible. Never interpret a failed persistent-write operation as successful revocation across reboots.

## Background discovery and images

`computer_list_windows({"query":"..."})` enumerates bounded, visible top-level window metadata without activating any window. It reports title, HWND, PID, foreground and minimized state. With explicit desktop-title discovery permission it can list other applications. Without that permission it is restricted to the currently authorized process, and still requires a valid session. Window titles may be sensitive; listing is itself an explicit permission choice.

`computer_select_window({"session_id":"...","window_id":123,"pid":456,"activate":false})` changes the observation target to a window from the current process or an exact remembered executable. It returns a new session ID and invalidates old snapshots/request IDs. Incomplete or uncertain operations must be resolved before switching. `activate:false` is the default and does not take foreground focus. Use the returned ID with `computer_snapshot` or UIA control-finding tools. Setting `activate:true` explicitly requests foreground focus for an already-approved application.

Capturing and reading UIA from a supported non-minimized background window does not require taking focus. Minimized windows can be listed but are not silently restored or captured. Some GPU/protected application surfaces may not return useful pixels; this is not a promise of capture support for every application. Real mouse/keyboard input still targets the Windows foreground. This is not a second virtual desktop that permits concurrent human and agent keyboard use.

The always-on-top monitor retains Live target and Exact agent frame; the latter is the latest exact image returned through the computer tools. Screenshots remain in RAM. No screenshot files, thumbnails, image logs or disk screenshot cache are added. Operating-system paging/crash dumps and receiving-client retention are not controlled by this guarantee.

## Remaining platform boundaries

These are the application's own UIA and SendInput computer tools, not OpenAI's proprietary computer-use UI/runtime. The separate native command sandbox applies only to `sandbox_exec`; it does not restrict approved graphical applications or retrofit the existing shell tools. Refer to native-command-sandbox.md.

The existing OAuth refresh-token support, Cloudflare child recovery and assisted ChatGPT setup remain. A fixed Named Tunnel endpoint avoids changed-URL connector updates. The application cannot silently create or rewrite a ChatGPT account connection using an undocumented account API or bypass login, consent, administrator policy or revoked credentials. Account-specific connection testing requires the user's actual environment. Publisher signing and Apple notarization require the owner's signing identities; this release does not pretend ad-hoc signing is publisher authentication.

## 繁體中文

此版本新增記住指定程式、程式重啟後恢復、Windows 登入時啟動，以及背景視窗探索。首次必須在本機確認；授權綁定工作區、認證設定及程式路徑／SHA-256。重啟後只會尋找已經運行的已批准程式，不啟動其他程式、不繞過 Windows 鎖定或 UAC。程式更新、模糊的多視窗或設定變更會要求重新確認。

`computer_list_windows` 可在獲准後探索背景及已縮小視窗的標題／PID。`computer_select_window` 預設只切換觀察目標，不搶焦點；只有目前或曾明確批准的程式才可選取。背景觀察不等於背景鍵鼠：Windows 真實輸入仍使用前台。縮小視窗只列出，不自動還原。截圖及兩種預覽仍只留在記憶體。

暫停、停止或關閉／縮小監控會暫停記住的自動恢復；正常退出程式則保留設定。沒有靜默批准 ChatGPT 帳戶授權、鎖定畫面存取、發布者憑證或未經驗證的實機連接聲稱。
