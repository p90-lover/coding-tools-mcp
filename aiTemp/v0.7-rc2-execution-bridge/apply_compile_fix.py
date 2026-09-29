from __future__ import annotations

from pathlib import Path

SOURCE = Path("rust-core/coding-tools-headless/src/lib.rs")

REPAIRS = (
    (
        "use coding_tools_core::{data::AppData, integrations, tools, CoreState};",
        "use coding_tools_core::{integrations, tools, CoreState};",
    ),
    (
        "#[derive(Debug, Deserialize)]\n#[serde(deny_unknown_fields)]\nstruct ExecutionProviderRequest {",
        "#[derive(Deserialize)]\n#[serde(deny_unknown_fields)]\nstruct ExecutionProviderRequest {",
    ),
)


def main() -> None:
    source = SOURCE.read_text(encoding="utf-8")
    changed = False

    for before, after in REPAIRS:
        if before in source:
            source = source.replace(before, after, 1)
            changed = True
        elif after not in source:
            raise SystemExit(f"expected execution-bridge source pattern is missing: {before!r}")

    if changed:
        SOURCE.write_text(source, encoding="utf-8")
        print("Applied the deterministic execution-bridge compile repair.")
    else:
        print("Execution-bridge compile repair is already applied.")


if __name__ == "__main__":
    main()
