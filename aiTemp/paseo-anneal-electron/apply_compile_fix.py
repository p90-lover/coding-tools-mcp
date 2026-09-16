from __future__ import annotations

from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
TARGET = ROOT / "rust-core/coding-tools-headless/src/lib.rs"


def replace_once(text: str, old: str, new: str, label: str) -> str:
    count = text.count(old)
    if count == 0:
        if new in text:
            return text
        raise SystemExit(f"{label}: neither source nor replacement text was found")
    if count != 1:
        raise SystemExit(f"{label}: expected one source match, found {count}")
    return text.replace(old, new, 1)


source = TARGET.read_text(encoding="utf-8")
source = replace_once(
    source,
    "use coding_tools_core::{data::AppData, integrations, tools, CoreState};",
    "use coding_tools_core::{integrations, tools, CoreState};",
    "unused AppData import",
)
source = replace_once(
    source,
    '''#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct ExecutionProviderRequest {''',
    '''#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ExecutionProviderRequest {''',
    "unnecessary Debug requirement on provider settings",
)
TARGET.write_text(source, encoding="utf-8")
print("Applied focused headless execution bridge compile repair.")
