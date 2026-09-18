from pathlib import Path


path = Path("runtime-web/src/adapters/chatgpt-web/browser-worker.ts")
text = path.read_text(encoding="utf-8")
initial_old = (
    "  let personalizedCount = await runChatGptPersonalizationStep(() => personalized.count(), deadline, abortSignal);\n"
    "  let unpersonalizedCount = await runChatGptPersonalizationStep(() => unpersonalized.count(), deadline, abortSignal);\n"
)
initial_new = (
    "  // These labels describe one UI state and can be observed independently under the same deadline.\n"
    "  let [personalizedCount, unpersonalizedCount] = await Promise.all([\n"
    "    runChatGptPersonalizationStep(() => personalized.count(), deadline, abortSignal),\n"
    "    runChatGptPersonalizationStep(() => unpersonalized.count(), deadline, abortSignal),\n"
    "  ]);\n"
)
retry_old = (
    "    personalizedCount = await runChatGptPersonalizationStep(() => personalized.count(), deadline, abortSignal);\n"
    "    unpersonalizedCount = await runChatGptPersonalizationStep(() => unpersonalized.count(), deadline, abortSignal);\n"
)
retry_new = (
    "    [personalizedCount, unpersonalizedCount] = await Promise.all([\n"
    "      runChatGptPersonalizationStep(() => personalized.count(), deadline, abortSignal),\n"
    "      runChatGptPersonalizationStep(() => unpersonalized.count(), deadline, abortSignal),\n"
    "    ]);\n"
)

changed = False
for label, old, new in [
    ("initial personalization reads", initial_old, initial_new),
    ("retry personalization reads", retry_old, retry_new),
]:
    if new in text and old not in text:
        continue
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"{label}: expected one match, found {count}")
    text = text.replace(old, new, 1)
    changed = True

path.write_text(text, encoding="utf-8")
if not path.read_text(encoding="utf-8").endswith("\n"):
    raise SystemExit(f"{path}: missing final newline")

print(f"PERSONALIZATION_PARALLEL_READS_OK changed={str(changed).lower()}")
