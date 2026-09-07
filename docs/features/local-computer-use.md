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

One process-wide non-queuing control permit prevents concurrent input and preview capture. Requests are bounded to 32 KiB, sequences to eight steps, text to 2048 UTF-8 bytes without control characters, waits to 15 seconds, and receipts to 256 per local session without eviction/replay. UIA traversal is bounded to 256 controls/depth 10 and checks a two-second budget between native calls. The native OS/UIA call itself can block; a transport timeout does not prove cancellation. A busy native call keeps the permit rather than allowing overlapping commands.

Password controls are masked in UIA metadata and denied keyboard input. The controller's own windows and known shell/administration/credential processes are denied as control targets. System/destructive hotkeys are not exposed. These are guardrails, not an operating-system sandbox: normal application controls can still submit messages, save changes or perform other sensitive actions. The agent must obey the user's no-deletion rule and obtain appropriate confirmation for sensitive operations. Screen pixels are not automatically secret-redacted; select a non-sensitive window and stay present.

No new upstream Codex OS sandbox, universal background automation, silent ChatGPT connector installation, or account-specific image-delivery verification is claimed. Existing assisted ChatGPT setup and fixed-hostname guidance are retained. Refresh the ChatGPT app's tools after installing this release.
