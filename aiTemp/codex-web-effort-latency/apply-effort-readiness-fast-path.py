from pathlib import Path


path = Path("runtime-web/src/adapters/chatgpt-web/browser-worker.ts")
text = path.read_text(encoding="utf-8")
old = (
    "    } finally {\n"
    "      effortWaitAbort.abort();\n"
    "    }\n"
    "    await settleChatGptUi();\n"
    "    await throwIfChatGptRateLimitDialog(page);\n"
    "    await captureDiagnostic?.(\"effort-control-ready\");\n"
)
new = (
    "    } finally {\n"
    "      effortWaitAbort.abort();\n"
    "    }\n"
    "    // Activation owns ghost-state cleanup plus bounded click/pointer surface readiness.\n"
    "    // Avoid a fixed delay when the visible control is already interactive.\n"
    "    await throwIfChatGptRateLimitDialog(page);\n"
    "    await captureDiagnostic?.(\"effort-control-ready\");\n"
)

if new in text and old not in text:
    changed = False
else:
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"effort readiness anchor: expected one match, found {count}")
    path.write_text(text.replace(old, new, 1), encoding="utf-8")
    changed = True

if not path.read_text(encoding="utf-8").endswith("\n"):
    raise SystemExit(f"{path}: missing final newline")

print(f"EFFORT_READINESS_FAST_PATH_OK changed={str(changed).lower()}")
