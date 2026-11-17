# Local Windows computer control

This app uses its own native Windows UI Automation and SendInput executor, following the structured-first approach discussed in the Linux.do Windows automation reference. It does not bundle or launch the Codex computer-use plugin, Codex agent, or CursorTouch Windows-MCP server. There is no model/API client, OCR service, telemetry integration, automatic package download or administrator elevation in this new path. ChatGPT or another authenticated MCP caller makes decisions.

## Local activation and visible supervision

In an authenticated workspace, enable screen capture and use non-read-only permissions, then restart MCP. In the workspace's **Computer control** panel, refresh windows, select exactly one application, and confirm **Enable for 10 min**. The local grant is bound to the canonical workspace, window handle, process ID and expiry. No MCP method can arm or resume control. Actions/no-auth listeners cannot use it.

A separate always-on-top monitor shows real pixels, target name, action status, remaining time, Pause/Resume and Stop. **Live target** refreshes the selected window locally; **Exact agent frame** displays the identical latest image bytes returned by a computer tool, not a recreated mock-up. Each is timestamped; stale frames are labelled. The display says ChatGPT/MCP, not that Codex is running. This is the app's own display, not OpenAI's proprietary computer-use interface. Live preview does not send continuous images to ChatGPT.

Closing/minimizing/hiding the monitor revokes authorization when detected; loss of its heartbeat blocks input within three seconds. Ctrl+Alt+Escape is registered as a local emergency Stop before any grant is accepted. If the shortcut or event monitor cannot be registered, control remains disabled. Stop/expiry releases the app's references to frames, receipts and sequence state; it is not cryptographic RAM erasure. The current short native input packet cannot be recalled after submission.

## MCP tools

- `computer_status`: native availability and the caller workspace's locally enabled session ID.
- `computer_route`: deterministic API → specialized capability → UIA → vision advice, using caller-supplied availability. It does not invent unavailable APIs or run a second model.
- `computer_snapshot`: selected-window image plus optional bounded UIA control descriptions. `include_ui:false` uses the screenshot-first path.
- `computer_find_control`: unambiguous visible enabled control, selected by name, automation ID and/or role. Truncated searches cannot authorize a unique match.
- `computer_wait`: check-first window-event-assisted condition wait, with bounded 200 ms polling fallback. This is not a claim of pure UIA-event waiting.
- `computer_action`: one scoped click/move/type/key/scroll or find/wait/verify step, with a unique request ID.
- `computer_sequence`: up to eight bounded steps, with RAM-only progress and explicit `resume_from_step`. Execution checks a 20-second budget between steps; native OS calls are not forcibly preempted.
- `computer_stop`: revoke the caller's scoped session, including when paused. Only the local user can resume or start another session.

Use the session ID from `computer_status`. Example: `computer_snapshot({"session_id":"...","include_ui":true})`, then `computer_action({"session_id":"...","request_id":"edit-001","step":{"action":"click","selector":{"role":"Edit","automation_id":"101"}}})`.

Coordinates must reference a fresh `snapshot_id` and lie in that returned image. The executor maps them to physical desktop coordinates and rechecks target geometry, process and foreground state. Input consumes the snapshot; capture a new one before further coordinate input. UIA selectors are resolved again for each action. A target moving, losing focus or being covered stops input rather than selecting another window. Native control is foreground control, not a virtual/background desktop.

Sequences support find → click → type → wait → verify and explicit resume at the recorded next step. Submitted inputs are never automatically replayed after a network retry. Reusing a request ID with different arguments is rejected. An uncertain input outcome prevents automatic sequence resume; reobserve and resolve the uncertainty. `input_submitted` means Windows accepted the input packets, not that the application accomplished the task. Use a UIA/visual check to verify outcomes.

## Privacy and hard limits

All screenshots remain in RAM, including both preview modes. No screenshot files, caches, thumbnails, gallery, recordings, clipboard image copy or image log payloads are written. Unknown/save/destination arguments are rejected. The receiving MCP client may retain returned images, and the operating system may page RAM or collect crash dumps. Old files remain untouched.

One process-wide control permit prevents concurrent input and preview capture. A call that finds it taken waits up to 10 seconds, then fails with `COMPUTER_BUSY`; nothing is queued beyond that, and a waiting call is checked against the lease again before it acts, so a Stop while it waited refuses it. Status and the local preview never wait. Requests are bounded to 32 KiB, sequences to eight steps, text to 2048 UTF-8 bytes without control characters, waits to 15 seconds, and receipts to 256 per local session without eviction/replay. UIA traversal is bounded to 256 controls/depth 10 and checks a two-second budget between native calls. The native OS/UIA call itself can block; a transport timeout does not prove cancellation. A busy native call keeps the permit rather than allowing overlapping commands.

Password controls are masked in UIA metadata and denied keyboard input. The controller's own windows and known shell/administration/credential processes are denied as control targets. System/destructive hotkeys are not exposed. These are guardrails, not an operating-system sandbox: normal application controls can still submit messages, save changes or perform other sensitive actions. The agent must obey the user's no-deletion rule and obtain appropriate confirmation for sensitive operations. Screen pixels are not automatically secret-redacted; select a non-sensitive window and stay present.

No new upstream Codex OS sandbox, universal background automation, silent ChatGPT connector installation, or account-specific image-delivery verification is claimed. Existing assisted ChatGPT setup and fixed-hostname guidance are retained. Refresh the ChatGPT app's tools after installing this release.

## Chat agents: the Codex engine and the control bar

Since 0.8.99, snapshots and input from chat agents run through the installed Codex desktop app's `@oai/sky` Windows engine. No SendInput fallback exists for input.

- **A refused call is that call's error alone.** A stale element index or a parameter the engine rejects comes back as `CODEX_ACTION_REJECTED`, and control stays on. Only a closed or timed-out engine, physical Escape, a native policy stop for the current turn, or a window that is no longer the approved one ends the worker and stops control. Until #1156 every refusal stopped control, and the agent had to select its window again.
- **Which timeout ends control.** The engine's own timeout (its helper answers "timeout", or says it ran out of time on the window) is a refusal: the helper is still running, and control stays on. The SDK's own request timer is different. After 10 s it kills the helper, and the helper's exit ends the worker, so that reply is fatal (`CODEX_ENGINE_TIMEOUT`, control stops). Until this fix it said control stays on, and control stopped a moment later anyway.
- **Native policy stops end the turn.** If Codex says computer use has been stopped for this turn, the bridge returns fatal `CODEX_POLICY_STOPPED`, exits and discards queued calls. One observed case is Codex being unable to verify whether the current browser URL is allowed. Local app permission does not override that check. Do not request a new grant in the same turn, retry through another input engine, or disable the native URL policy. The native message is not forwarded.
- **The error names what kind of failure it was.** An engine error without its own code gets a fixed kind, which the agent's error shows in brackets: `CODEX_CAPTURE_FAILED`, `CODEX_ENGINE_TIMEOUT`, `CODEX_ACCESS_DENIED`, `CODEX_ELEMENT_INVALID` or `CODEX_ACCESSIBILITY_FAILED`, else `CODEX_ENGINE_FAILED`. The engine's own message never leaves the bridge, because it can carry window titles and paths. Before, every uncoded failure read `CODEX_ENGINE_FAILED`, so a failing screenshot looked like any other failure.
- **Codex hides its own windows.** The engine lists no ChatGPT or Codex window: ChatGPT.exe ships inside the Codex package. For those windows `computer_snapshot` falls back to the in-memory GDI capture plus UI Automation, and marks the result `input_available: false`. Clicks and typing return `CODEX_WINDOW_UNAVAILABLE` with outcome `not_sent`, and control stays on.
- **Switching windows moves control.** When `computer_select_window` names another window, the old control ends and control starts on the new window. Before, headless refused it with `CONTROL_ALREADY_ARMED`.
- **The control bar shows what happens.** A `computer_*` call appears on the bar as soon as it arrives. While it waits for the reviewer or the person, the bar reads "… · waiting for approval", and clicks pass through the bar only once the call may act. Listing and choosing windows also show.
- **Preview.** The bar shows a small copy of the frame the agent was given last: its own snapshot, or the one taken after each action. Click it, or ▾, to see it large above the history. Nothing is captured for the preview. Headless scales down the agent's in-memory frame into a JPEG (`GET /api/v1/computer/frame`, local UI token only) when the heartbeat reports a new snapshot. A frame that fails is not asked for again.
- **The app's icon.** The bar shows the controlled program's own icon left of its name, on the pill and on each history row. Headless's `/api/v1/computer/targets` gives each window's full program `path` (local UI only; `computer_list_windows` never gives it to the agent). Electron reads the icon once per program with `app.getFileIcon`, and the bar accepts only a PNG data URL.

## Permission prompts hold the call

An agent's call that needs the person (the per-app card from `computer_select_window`, a reviewer that leaves the call to the person, a command to confirm) **returns only once the person answered**, and its result says what they decided:

- **Allowed:** `computer_select_window`'s result has `permission`, e.g. "The user allowed Claude Code to use Notepad for this conversation." (or "from now on", or "was already allowed").
- **Declined:** the error has code `APPROVAL_DECLINED` and execution `not_started`, and tells the agent not to ask again or work around it.

The chat's MCP server keeps the agent's client waiting meanwhile. A `tools/call` still running after 2 s is answered as an event stream (MCP Streamable HTTP) when the client accepts one. It carries a keep-alive comment every 10 s, or `notifications/progress` naming what the call waits for ("Waiting for the person to allow Claude Code to use Notepad in the chat.") when the call came with a `progressToken`. The result ends the stream. A call that finishes sooner is answered as plain JSON, as before.

If the agent hangs up anyway (its own tool timeout), its screen call is abandoned:
- the card or review prompt is withdrawn;
- an answer that arrives too late starts no control the agent would never hear about.

Until #1156 the answer came only as one JSON body at the end. An agent's MCP client timed out while the person read the card ("computer_select_window … timed out"), and an Allow given later started control the model didn't know about.

## Teaching the model an app: computer_guide

`computer_guide {topic?, app?}` is the chat's guide to computer use. It reads no screen, so no reviewer or person is asked.

**Topics:**
- `workflow` (the default): the loop. List windows, select one (the call waits for the person), observe with `get_window_state {include_text: true}`, act by `element_index`, check every step, then `computer_stop`. Also the rules and error codes.
- `methods`: every `computer_action` method of Codex's window2 with its parameters: `get_window_state`, `click`, `set_value`, `type_text`, `press_key`, `scroll`, `drag`, `perform_secondary_action`, `activate_window` and `get_window`. Until #1156, `params` was undocumented and agents guessed.
- `locate`: finding a control, fastest first:
  1. The accessibility index.
  2. A UI Automation search (`computer_find_control`).
  3. Vision: pixels of the engine's own screenshot, with its `screenshotId`.
  4. `ocr_screen`.
- `browser`: the fastest route to a page's content:
  - Local pages: `preview_open` and `preview_read`.
  - Public pages: fetch the HTML.
  - The person's own browser: its accessibility tree, with address-bar, find and view-source shortcuts.
  - Vision only for canvas or video.
- `keys`: `press_key` names (`Control_L+a`, `Return`, `Page_Down`).

**App notes.** `app` adds what's known about a program. Built in: browsers, Notepad, File Explorer and file dialogs, VS Code, Word, Excel, PowerPoint, Outlook, Paint, Calculator and Settings.

**Your own notes.** Put a Markdown file per app or topic in the `computer-guides` folder of the app's data folder, next to `chat-agent-tools.json`: for example `chrome.md`, `notepad.md` or `browser.md`, named by the program without `.exe`.
- It's read on every call, up to 16 KB, so an edit applies to the next call.
- The app only reads that folder; it never writes there.

**Without asking.** When control starts, `computer_select_window`'s result includes `guide`: that app's notes (built in and yours), and the next step to take.

Computer-control frame capture uses a bounded in-memory Windows GDI surface with a physical-pixel DWM crop performed before resizing. A thread-local DPI context is restored after geometry, capture, and pointer-coordinate checks. The existing generic vision tools retain their separate capture backend.
