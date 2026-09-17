from __future__ import annotations

from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
WORKFLOW = ROOT / ".github/workflows/codex-router-multiprovider-release-rc6.yml"


def replace_once(text: str, old: str, new: str) -> str:
    if new in text and old not in text:
        print(f"already applied: {old[:80]!r}")
        return text
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"expected one match, found {count}: {old[:140]!r}")
    return text.replace(old, new, 1)


source = WORKFLOW.read_text(encoding="utf-8")

source = replace_once(
    source,
    "  cancel-in-progress: false\n",
    "  cancel-in-progress: true\n",
)

source = replace_once(
    source,
    """            desktop-electron/tests/prepare-runtime.test.cjs \\
            2>&1 | tee aiTemp/evidence/desktop-release-tests.txt
""",
    """            desktop-electron/tests/prepare-runtime.test.cjs \\
            desktop-electron/tests/rc6-legacy-uninstall-fixture.test.cjs \\
            2>&1 | tee aiTemp/evidence/desktop-release-tests.txt
""",
)

source = replace_once(
    source,
    """          Add-Type -TypeDefinition $source -Language CSharp -OutputAssembly $uninstaller -OutputType ConsoleApplication
""",
    """          & \"$env:GITHUB_WORKSPACE\\scripts\\build-legacy-uninstall-fixture.ps1\" `
            -SourcePath $sourcePath `
            -OutputPath $uninstaller
""",
)

WORKFLOW.write_text(source, encoding="utf-8")
print(f"patched {WORKFLOW}")
