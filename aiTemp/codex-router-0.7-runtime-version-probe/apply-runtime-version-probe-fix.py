from pathlib import Path


MAIN = Path("desktop-electron/electron/main.cjs")
RUNTIME_COMMAND = Path("desktop-electron/electron/runtime-command.cjs")
TEST = Path("desktop-electron/tests/runtime-version-probe.test.cjs")
TOOLING_WORKFLOW = Path(".github/workflows/codex-router-0.7-release-tooling-ci.yml")


def replace_count(
    text: str,
    old: str,
    new: str,
    expected: int,
    label: str,
) -> tuple[str, bool]:
    old_count = text.count(old)
    new_count = text.count(new)
    if old_count == 0 and new_count == expected:
        return text, False
    if old_count != expected:
        raise SystemExit(
            f"{label}: expected {expected} old anchors, found {old_count}; "
            f"new anchors={new_count}"
        )
    return text.replace(old, new), True


def replace_once(text: str, old: str, new: str, label: str) -> tuple[str, bool]:
    return replace_count(text, old, new, 1, label)


def write_if_changed(path: Path, text: str) -> bool:
    if not text.endswith("\n"):
        raise SystemExit(f"{path}: replacement must keep a final newline")
    current = path.read_text(encoding="utf-8") if path.exists() else None
    if current == text:
        return False
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")
    return True


changed_paths: list[str] = []

main_text = MAIN.read_text(encoding="utf-8")
main_text, changed = replace_once(
    main_text,
    'const { runtimeBundlePaths } = require("./runtime-command.cjs");\n',
    'const {\n  runtimeBundlePaths,\n  validateRuntimeVersionProbe,\n} = require("./runtime-command.cjs");\n',
    "main runtime-command import",
)
if changed:
    changed_paths.append(str(MAIN))
main_text, changed = replace_once(
    main_text,
    '''    if (versionResult.error) throw versionResult.error;
    if (versionResult.status !== 0 || versionResult.stdout.trim() !== app.getVersion()) {
      throw new Error(
        `Installed launcher runtime is not executable`
        + ` (status=${versionResult.status ?? "unknown"}, stdout=${JSON.stringify(versionResult.stdout.trim())},`
        + ` stderr=${JSON.stringify(versionResult.stderr.trim())})`,
      );
    }
''',
    '''    validateRuntimeVersionProbe(smokeRuntimeRoot, versionResult);
''',
    "main runtime version probe",
)
if changed and str(MAIN) not in changed_paths:
    changed_paths.append(str(MAIN))
if write_if_changed(MAIN, main_text) and str(MAIN) not in changed_paths:
    changed_paths.append(str(MAIN))

runtime_text = RUNTIME_COMMAND.read_text(encoding="utf-8")
runtime_helpers = r'''const RUNTIME_VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

function outputText(value) {
  if (typeof value === "string") return value.trim();
  if (Buffer.isBuffer(value)) return value.toString("utf8").trim();
  return "";
}

function runtimePackageVersion(runtimeRoot, fsImpl = fs) {
  if (typeof runtimeRoot !== "string" || !path.isAbsolute(runtimeRoot)) {
    throw new Error("Installed launcher runtime root must be an absolute path");
  }
  const manifestPath = path.join(runtimeRoot, "app", "package.json");
  let manifest;
  try {
    manifest = JSON.parse(fsImpl.readFileSync(manifestPath, "utf8"));
  } catch (error) {
    throw new Error(
      `Installed launcher runtime package manifest is invalid: ${manifestPath}: `
      + `${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (typeof manifest?.version !== "string" || !RUNTIME_VERSION_PATTERN.test(manifest.version)) {
    throw new Error(
      `Installed launcher runtime package version is invalid: ${JSON.stringify(manifest?.version)}`,
    );
  }
  return manifest.version;
}

function validateRuntimeVersionProbe(runtimeRoot, result, fsImpl = fs) {
  if (result?.error) throw result.error;
  const expectedVersion = runtimePackageVersion(runtimeRoot, fsImpl);
  const stdout = outputText(result?.stdout);
  const stderr = outputText(result?.stderr);
  if (result?.status !== 0 || stdout !== expectedVersion) {
    throw new Error(
      `Installed launcher runtime version probe failed`
      + ` (status=${result?.status ?? "unknown"}, expected=${JSON.stringify(expectedVersion)},`
      + ` stdout=${JSON.stringify(stdout)}, stderr=${JSON.stringify(stderr)})`,
    );
  }
  return expectedVersion;
}

'''
runtime_text, changed = replace_once(
    runtime_text,
    "module.exports = {\n",
    runtime_helpers + "module.exports = {\n",
    "runtime command helpers",
)
if changed:
    changed_paths.append(str(RUNTIME_COMMAND))
runtime_text, changed = replace_once(
    runtime_text,
    "  runtimeInvocation,\n};\n",
    "  runtimeInvocation,\n  runtimePackageVersion,\n  validateRuntimeVersionProbe,\n};\n",
    "runtime command exports",
)
if changed and str(RUNTIME_COMMAND) not in changed_paths:
    changed_paths.append(str(RUNTIME_COMMAND))
if write_if_changed(RUNTIME_COMMAND, runtime_text) and str(RUNTIME_COMMAND) not in changed_paths:
    changed_paths.append(str(RUNTIME_COMMAND))

test_text = r'''"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { validateRuntimeVersionProbe } = require("../electron/runtime-command.cjs");

function runtimeManifestFs(runtimeRoot, version) {
  return {
    readFileSync(filePath, encoding) {
      assert.equal(filePath, path.join(runtimeRoot, "app", "package.json"));
      assert.equal(encoding, "utf8");
      return JSON.stringify({ version });
    },
  };
}

test("packaged smoke accepts the runtime CLI own verified version", () => {
  const runtimeRoot = path.resolve("aiTemp", "runtime-version-probe-fixture");
  const version = validateRuntimeVersionProbe(
    runtimeRoot,
    { status: 0, stdout: "5.0.6\n", stderr: "" },
    runtimeManifestFs(runtimeRoot, "5.0.6"),
  );
  assert.equal(version, "5.0.6");
  assert.notEqual(version, "0.7.0-rc.1");
});

test("packaged smoke rejects a runtime CLI version that differs from its signed bundle metadata", () => {
  const runtimeRoot = path.resolve("aiTemp", "runtime-version-probe-mismatch");
  assert.throws(
    () => validateRuntimeVersionProbe(
      runtimeRoot,
      { status: 0, stdout: "5.0.5\n", stderr: "" },
      runtimeManifestFs(runtimeRoot, "5.0.6"),
    ),
    /expected="5\.0\.6".*stdout="5\.0\.5"/,
  );
});

test("main launcher delegates the executable probe without comparing CLI and desktop versions", () => {
  const source = fs.readFileSync(
    path.join(__dirname, "..", "electron", "main.cjs"),
    "utf8",
  );
  assert.match(source, /validateRuntimeVersionProbe\(smokeRuntimeRoot, versionResult\);/);
  assert.doesNotMatch(source, /versionResult\.stdout\.trim\(\) !== app\.getVersion\(\)/);
});
'''
if write_if_changed(TEST, test_text):
    changed_paths.append(str(TEST))

workflow_text = TOOLING_WORKFLOW.read_text(encoding="utf-8")
workflow_text, changed = replace_count(
    workflow_text,
    "      - desktop-electron/electron/profile.cjs\n",
    "      - desktop-electron/electron/profile.cjs\n      - desktop-electron/electron/runtime-command.cjs\n",
    2,
    "runtime command watched paths",
)
if changed:
    changed_paths.append(str(TOOLING_WORKFLOW))
workflow_text, changed = replace_count(
    workflow_text,
    "      - desktop-electron/tests/profile.test.cjs\n",
    "      - desktop-electron/tests/profile.test.cjs\n      - desktop-electron/tests/runtime-version-probe.test.cjs\n",
    2,
    "runtime probe watched paths",
)
if changed and str(TOOLING_WORKFLOW) not in changed_paths:
    changed_paths.append(str(TOOLING_WORKFLOW))
workflow_text, changed = replace_once(
    workflow_text,
    "          node --check desktop-electron/electron/profile.cjs\n",
    "          node --check desktop-electron/electron/profile.cjs\n          node --check desktop-electron/electron/runtime-command.cjs\n",
    "runtime command syntax check",
)
if changed and str(TOOLING_WORKFLOW) not in changed_paths:
    changed_paths.append(str(TOOLING_WORKFLOW))
workflow_text, changed = replace_once(
    workflow_text,
    "          node --check desktop-electron/tests/profile.test.cjs\n",
    "          node --check desktop-electron/tests/profile.test.cjs\n          node --check desktop-electron/tests/runtime-version-probe.test.cjs\n",
    "runtime probe test syntax check",
)
if changed and str(TOOLING_WORKFLOW) not in changed_paths:
    changed_paths.append(str(TOOLING_WORKFLOW))
profile_test_line = "            desktop-electron/tests/profile.test.cjs " + "\\" + "\n"
runtime_test_lines = (
    profile_test_line
    + "            desktop-electron/tests/runtime-version-probe.test.cjs "
    + "\\"
    + "\n"
)
workflow_text, changed = replace_once(
    workflow_text,
    profile_test_line,
    runtime_test_lines,
    "runtime probe focused test",
)
if changed and str(TOOLING_WORKFLOW) not in changed_paths:
    changed_paths.append(str(TOOLING_WORKFLOW))
if write_if_changed(TOOLING_WORKFLOW, workflow_text) and str(TOOLING_WORKFLOW) not in changed_paths:
    changed_paths.append(str(TOOLING_WORKFLOW))

print("RUNTIME_VERSION_PROBE_FIX_OK changed=" + ("true" if changed_paths else "false"))
for changed_path in changed_paths:
    print(changed_path)
