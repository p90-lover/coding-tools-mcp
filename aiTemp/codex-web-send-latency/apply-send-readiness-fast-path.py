from pathlib import Path


path = Path("runtime-web/src/adapters/chatgpt-web/browser-worker.ts")
text = path.read_text(encoding="utf-8")
old = (
    '    await sendButton.waitFor({ state: "visible", timeout: browserStageTimeouts.send });\n'
    '    await settleChatGptUi();\n'
    '    const sendEnableDeadline = Date.now() + CHATGPT_SEND_ENABLE_GRACE_MS;\n'
)
new = (
    '    await sendButton.waitFor({ state: "visible", timeout: browserStageTimeouts.send });\n'
    '    // Check readiness immediately; only back off when the control is still disabled.\n'
    '    const sendEnableDeadline = Date.now() + CHATGPT_SEND_ENABLE_GRACE_MS;\n'
)

if new in text and old not in text:
    changed = False
else:
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"send readiness anchor: expected one match, found {count}")
    path.write_text(text.replace(old, new, 1), encoding="utf-8")
    changed = True

if not path.read_text(encoding="utf-8").endswith("\n"):
    raise SystemExit(f"{path}: missing final newline")

print(f"SEND_READINESS_FAST_PATH_OK changed={str(changed).lower()}")
