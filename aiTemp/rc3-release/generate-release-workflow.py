from __future__ import annotations

from pathlib import Path

SOURCE = Path(".github/workflows/codex-router-multiprovider-release-rc2.yml")
TARGET = Path("aiTemp/rc3-release/generated/codex-router-multiprovider-release-rc3.yml")

OLD_VERSION = "0.7.0-rc.2"
NEW_VERSION = "0.7.0-rc.3"
OLD_WORKFLOW = ".github/workflows/codex-router-multiprovider-release-rc2.yml"
NEW_WORKFLOW = ".github/workflows/codex-router-multiprovider-release-rc3.yml"
OLD_IDENTITY_PATCH = "aiTemp/rc2-release/apply-release-identity.py"
NEW_IDENTITY_PATCH = "aiTemp/rc3-release/apply-release-identity.py"
OLD_IDENTITY_MARKER = "CODEX_ROUTER_RELEASE_IDENTITY_RC2_PATCH_OK"
NEW_IDENTITY_MARKER = "CODEX_ROUTER_RELEASE_IDENTITY_RC3_PATCH_OK"


def require(text: str, needle: str, label: str) -> None:
    if needle not in text:
        raise SystemExit(f"missing {label}: {needle}")


def main() -> None:
    source = SOURCE.read_text(encoding="utf-8")
    for needle, label in [
        (OLD_VERSION, "release version"),
        (OLD_WORKFLOW, "validation workflow path"),
        (OLD_IDENTITY_PATCH, "release identity patch path"),
        (OLD_IDENTITY_MARKER, "release identity marker"),
        ("release/codex-router-multiprovider-0.7.0-rc.2", "release branch"),
        ("docs/releases/v0.7.0-rc.2.md", "release notes path"),
    ]:
        require(source, needle, label)

    generated = source.replace(OLD_VERSION, NEW_VERSION)
    generated = generated.replace(OLD_WORKFLOW, NEW_WORKFLOW)
    generated = generated.replace(OLD_IDENTITY_PATCH, NEW_IDENTITY_PATCH)
    generated = generated.replace(OLD_IDENTITY_MARKER, NEW_IDENTITY_MARKER)
    generated = generated.replace(
        "name: Codex Router multi-provider release candidate rc.2",
        "name: Codex Router multi-provider release candidate rc.3",
        1,
    )

    forbidden = [
        "release/codex-router-multiprovider-0.7.0-rc.2",
        "Coding.Tools_0.7.0-rc.2_windows_x64_setup.exe",
        "docs/releases/v0.7.0-rc.2.md",
        OLD_IDENTITY_PATCH,
        OLD_IDENTITY_MARKER,
    ]
    for needle in forbidden:
        if needle in generated:
            raise SystemExit(f"stale rc.2 release token remains: {needle}")

    required = [
        "release/codex-router-multiprovider-0.7.0-rc.3",
        "RELEASE_VERSION: '0.7.0-rc.3'",
        "RELEASE_TAG: v0.7.0-rc.3",
        "WINDOWS_INSTALLER: Coding.Tools_0.7.0-rc.3_windows_x64_setup.exe",
        NEW_WORKFLOW,
        NEW_IDENTITY_PATCH,
        NEW_IDENTITY_MARKER,
        "docs/releases/v0.7.0-rc.3.md",
    ]
    for needle in required:
        require(generated, needle, "generated rc.3 token")

    TARGET.parent.mkdir(parents=True, exist_ok=True)
    TARGET.write_text(generated, encoding="utf-8")
    print(f"RC3_RELEASE_WORKFLOW_GENERATED {TARGET}")


if __name__ == "__main__":
    main()
