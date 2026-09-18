from pathlib import Path

source = Path(".github/workflows/codex-router-multiprovider-release-rc3.yml")
target = Path(".github/workflows/codex-router-multiprovider-release-rc4.yml")
text = source.read_text(encoding="utf-8")

replacements = [
    ("0.7.0-rc.3", "0.7.0-rc.4"),
    ("candidate rc.3", "candidate rc.4"),
    ("release-rc3.yml", "release-rc4.yml"),
    ("rc3-release", "rc4-release"),
    ("RELEASE_IDENTITY_RC3", "RELEASE_IDENTITY_RC4"),
]
for old, new in replacements:
    if old not in text:
        raise SystemExit(f"release workflow replacement anchor missing: {old}")
    text = text.replace(old, new)

anchor = """          grep -F '# fail 0' aiTemp/evidence/desktop-release-tests.txt
          TMPDIR=\"$PWD/aiTemp/tmp\" TMP=\"$PWD/aiTemp/tmp\" TEMP=\"$PWD/aiTemp/tmp\" \\
            bun run --cwd desktop-electron typecheck \\
"""
provider_contracts = """          grep -F '# fail 0' aiTemp/evidence/desktop-release-tests.txt
          node --test \\
            desktop-electron/tests/provider-center-account-wiring.test.cjs \\
            desktop-electron/tests/provider-execution-router.test.cjs \\
            desktop-electron/tests/execution-bridge-contract.test.cjs \\
            2>&1 | tee aiTemp/evidence/provider-hub-account-wiring-tests.txt
          grep -E '^# pass [1-9][0-9]*$' aiTemp/evidence/provider-hub-account-wiring-tests.txt
          grep -F '# fail 0' aiTemp/evidence/provider-hub-account-wiring-tests.txt
          TMPDIR=\"$PWD/aiTemp/tmp\" TMP=\"$PWD/aiTemp/tmp\" TEMP=\"$PWD/aiTemp/tmp\" \\
            bun run --cwd desktop-electron typecheck \\
"""
if anchor not in text:
    raise SystemExit("provider contract insertion anchor missing")
text = text.replace(anchor, provider_contracts, 1)

if "0.7.0-rc.3" in text or "release-rc3.yml" in text or "rc3-release" in text:
    raise SystemExit("stale rc.3 release identity remains in rc.4 workflow")
if "provider-center-account-wiring.test.cjs" not in text:
    raise SystemExit("Provider Center regression contract was not added")
if "docs/releases/v0.7.0-rc.4.md" not in text:
    raise SystemExit("rc.4 release notes path was not materialized")

target.write_text(text, encoding="utf-8")
print("CODEX_ROUTER_RC4_RELEASE_WORKFLOW_MATERIALIZED")
