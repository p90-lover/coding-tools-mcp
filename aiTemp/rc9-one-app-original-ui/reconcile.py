from __future__ import annotations

from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


def replace_once(path: Path, old: str, new: str, label: str) -> None:
    text = path.read_text(encoding="utf-8")
    if new in text:
        return
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"{label}: expected one anchor, found {count}")
    path.write_text(text.replace(old, new, 1), encoding="utf-8")


def main() -> None:
    main_path = ROOT / "desktop-electron" / "electron" / "main.cjs"
    replace_once(
        main_path,
        '''  handle("launcher:original-ui-open", (event, toolId, section) => {
    assertFocusedMainWindow(event, false);
''',
        '''  handle("launcher:original-ui-open", (event, toolId, section) => {
    assertFocusedMainWindow(event, true);
''',
        "original UI mutating open focus gate",
    )

    test_path = ROOT / "desktop-electron" / "tests" / "rc9-managed-cpa-runtime.test.cjs"
    replace_once(
        test_path,
        "assert.match(source, /disable-control-panel: true/);",
        "assert.match(source, /disable-control-panel: false/);",
        "managed CPA original control panel contract",
    )

    controller_path = ROOT / "desktop-electron" / "electron" / "original-ui.cjs"
    replace_once(
        controller_path,
        '''    openExternalTool,
    cpaManagementKey,
    copyCpaManagementKey,
''',
        '''    openExternalTool,
    copyCpaManagementKey,
''',
        "original UI private credential surface",
    )

    print("reconciled original CPA and Codex Router interfaces with the one-app managed runtime")


if __name__ == "__main__":
    main()
