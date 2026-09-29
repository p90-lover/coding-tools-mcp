from pathlib import Path

TARGET = Path("desktop-electron/electron/main.cjs")

OLD_IMPORT = 'const { terminateLauncherSmoke } = require("./smoke-exit.cjs");'
NEW_IMPORT = 'const { assertLauncherRuntimeVersion, terminateLauncherSmoke } = require("./smoke-exit.cjs");'

OLD_CHECK = '''    if (versionResult.error) throw versionResult.error;
    if (versionResult.status !== 0 || versionResult.stdout.trim() !== app.getVersion()) {
      throw new Error(
        `Installed launcher runtime is not executable`
        + ` (status=${versionResult.status ?? "unknown"}, stdout=${JSON.stringify(versionResult.stdout.trim())},`
        + ` stderr=${JSON.stringify(versionResult.stderr.trim())})`,
      );
    }
'''
NEW_CHECK = '''    assertLauncherRuntimeVersion({
      runtimeRoot: smokeRuntimeRoot,
      result: versionResult,
    });
'''


def replace_once(source: str, old: str, new: str, label: str) -> tuple[str, bool]:
    old_count = source.count(old)
    if old_count == 1:
        return source.replace(old, new, 1), True
    if old_count == 0 and source.count(new) == 1:
        return source, False
    raise SystemExit(
        f"RUNTIME_VERSION_PATCH_REFUSED:{label}:old={old_count}:new={source.count(new)}"
    )


def main() -> None:
    source = TARGET.read_text(encoding="utf-8")
    source, import_changed = replace_once(source, OLD_IMPORT, NEW_IMPORT, "import")
    source, check_changed = replace_once(source, OLD_CHECK, NEW_CHECK, "check")
    if import_changed or check_changed:
        TARGET.write_text(source, encoding="utf-8", newline="\n")
        print("RUNTIME_VERSION_PATCH_APPLIED")
    else:
        print("RUNTIME_VERSION_PATCH_ALREADY_APPLIED")


if __name__ == "__main__":
    main()
