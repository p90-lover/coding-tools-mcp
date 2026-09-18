from __future__ import annotations

from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
SOURCE = ROOT / "aiTemp/rc7-commandcode/apply_commandcode.py"
OUTPUT = ROOT / "aiTemp/rc7-provider-updater-sync/apply_commandcode_current_base.py"

text = SOURCE.read_text(encoding="utf-8")
legacy_signature = "async function inspectAntigravitySession(account, { baselineAuthNames = new Set() } = {}) {"
current_signature_anchor = "async function inspectAntigravitySession("

count = text.count(legacy_signature)
if count == 2:
    text = text.replace(legacy_signature, current_signature_anchor)
elif current_signature_anchor not in text:
    raise SystemExit(
        "The retained CommandCode materializer does not contain the expected Antigravity inspection anchor"
    )

OUTPUT.parent.mkdir(parents=True, exist_ok=True)
OUTPUT.write_text(text, encoding="utf-8")
print("RC7_CURRENT_BASE_COMMANDCODE_PATCH_PREPARED")
