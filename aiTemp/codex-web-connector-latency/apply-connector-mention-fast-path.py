from pathlib import Path


path = Path("runtime-web/src/adapters/chatgpt-web/browser-worker.ts")
text = path.read_text(encoding="utf-8")
old = (
    '        await composer.focus({ signal: abortSignal, timeout: CHATGPT_CONNECTOR_ACTION_TIMEOUT_MS });\n'
    '        await withBrowserTurnAbort(settleChatGptUi(), abortSignal);\n'
    '        await composer.pressSequentially(CHATGPT_CONNECTOR_MENTION_QUERY, {\n'
)
new = (
    '        await composer.focus({ signal: abortSignal, timeout: CHATGPT_CONNECTOR_ACTION_TIMEOUT_MS });\n'
    '        // The focused composer plus the exact bounded menu wait own readiness here.\n'
    '        // Avoid a fixed delay when the mention trigger is already accepted.\n'
    '        await composer.pressSequentially(CHATGPT_CONNECTOR_MENTION_QUERY, {\n'
)

if new in text and old not in text:
    changed = False
else:
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"connector mention anchor: expected one match, found {count}")
    path.write_text(text.replace(old, new, 1), encoding="utf-8")
    changed = True

if not path.read_text(encoding="utf-8").endswith("\n"):
    raise SystemExit(f"{path}: missing final newline")

print(f"CONNECTOR_MENTION_FAST_PATH_OK changed={str(changed).lower()}")
