from pathlib import Path


MAIN = Path("desktop-electron/electron/main.cjs")
RUNTIME_COMMAND = Path("desktop-electron/electron/runtime-command.cjs")
TEST = Path("desktop-electron/tests/runtime-version-probe.test.cjs")
TOOLING_WORKFLOW = Path(".github/workflows/codex-router-0.7-release-tooling-ci.yml")


def replace_once(text: str, old: str, new: str, label: str) -> tuple[str, bool]:
    if new in text and old not in text:
        return text, False
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"{label}: expected one anchor, found {count}")
    return text.replace(old, new, 1), True


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
    '''    if (versionResult.error) throw versionResult.error;\n    if (versionResult.status !== 0 || versionResult.stdout.trim() !== app.getVersion()) {\n      throw new Error(\n        `Installed launcher runtime is not executable`\n        + ` (status=${versionResult.status ?? "unknown"}, stdout=${JSON.stringify(versionResult.stdout.trim())},`\n        + ` stderr=${JSON.stringify(versionResult.stderr.trim())})`,\n      );\n    }\n''',
    '''    validateRuntimeVersionProbe(smokeRuntimeRoot, versionResult);\n''',
    "main runtime version probe",
)
if changed and str(MAIN) not in changed_paths:
    changed_paths.append(str(MAIN))
if write_if_changed(MAIN, main_text) and str(MAIN) not in changed_paths:
    changed_paths.append(str(MAIN))

runtime_text = RUNTIME_COMMAND.read_text(encoding="utf-8")
runtime_helpers = '''const RUNTIME_VERSION_PATTERN = /^\\d+\\.\\d+\\.\\d+(?:-[0-9A-Za-z.-]+)?(?:\\+[0-9A-Za-z.-]+)?$/;\n\nfunction outputText(value) {\n  if (typeof value === "string") return value.trim();\n  if (Buffer.isBuffer(value)) return value.toString("utf8").trim();\n  return "";\n}\n\nfunction runtimePackageVersion(runtimeRoot, fsImpl = fs) {\n  if (typeof runtimeRoot !== "string" || !path.isAbsolute(runtimeRoot)) {\n    throw new Error("Installed launcher runtime root must be an absolute path");\n  }\n  const manifestPath = path.join(runtimeRoot, "app", "package.json");\n  let manifest;\n  try {\n    manifest = JSON.parse(fsImpl.readFileSync(manifestPath, "utf8"));\n  } catch (error) {\n    throw new Error(\n      `Installed launcher runtime package manifest is invalid: ${manifestPath}: `\n      + `${error instanceof Error ? error.message : String(error)}`,\n    );\n  }\n  if (typeof manifest?.version !== "string" || !RUNTIME_VERSION_PATTERN.test(manifest.version)) {\n    throw new Error(\n      `Installed launcher runtime package version is invalid: ${JSON.stringify(manifest?.version)}`,\n    );\n  }\n  return manifest.version;\n}\n\nfunction validateRuntimeVersionProbe(runtimeRoot, result, fsImpl = fs) {\n  if (result?.error) throw result.error;\n  const expectedVersion = runtimePackageVersion(runtimeRoot, fsImpl);\n  const stdout = outputText(result?.stdout);\n  const stderr = outputText(result?.stderr);\n  if (result?.status !== 0 || stdout !== expectedVersion) {\n    throw new Error(\n      `Installed launcher runtime version probe failed`\n      + ` (status=${result?.status ?? "unknown"}, expected=${JSON.stringify(expectedVersion)},`\n      + ` stdout=${JSON.stringify(stdout)}, stderr=${JSON.stringify(stderr)})`,\n    );\n  }\n  return expectedVersion;\n}\n\n'''
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

test_text = '''"use strict";\n\nconst test = require("node:test");\nconst assert = require("node:assert/strict");\nconst fs = require("node:fs");\nconst path = require("node:path");\nconst { validateRuntimeVersionProbe } = require("../electron/runtime-command.cjs");\n\nfunction runtimeManifestFs(runtimeRoot, version) {\n  return {\n    readFileSync(filePath, encoding) {\n      assert.equal(filePath, path.join(runtimeRoot, "app", "package.json"));\n      assert.equal(encoding, "utf8");\n      return JSON.stringify({ version });\n    },\n  };\n}\n\ntest("packaged smoke accepts the runtime CLI own verified version", () => {\n  const runtimeRoot = path.resolve("aiTemp", "runtime-version-probe-fixture");\n  const version = validateRuntimeVersionProbe(\n    runtimeRoot,\n    { status: 0, stdout: "5.0.6\\n", stderr: "" },\n    runtimeManifestFs(runtimeRoot, "5.0.6"),\n  );\n  assert.equal(version, "5.0.6");\n  assert.notEqual(version, "0.7.0-rc.1");\n});\n\ntest("packaged smoke rejects a runtime CLI version that differs from its signed bundle metadata", () => {\n  const runtimeRoot = path.resolve("aiTemp", "runtime-version-probe-mismatch");\n  assert.throws(\n    () => validateRuntimeVersionProbe(\n      runtimeRoot,\n      { status: 0, stdout: "5.0.5\\n", stderr: "" },\n      runtimeManifestFs(runtimeRoot, "5.0.6"),\n    ),\n    /expected="5\\.0\\.6".*stdout="5\\.0\\.5"/,\n  );\n});\n\ntest("main launcher delegates the executable probe without comparing CLI and desktop versions", () => {\n  const source = fs.readFileSync(\n    path.join(__dirname, "..", "electron", "main.cjs"),\n    "utf8",\n  );\n  assert.match(source, /validateRuntimeVersionProbe\(smokeRuntimeRoot, versionResult\);/);\n  assert.doesNotMatch(source, /versionResult\\.stdout\\.trim\\(\\) !== app\\.getVersion\\(\\)/);\n});\n'''
if write_if_changed(TEST, test_text):
    changed_paths.append(str(TEST))

workflow_text = TOOLING_WORKFLOW.read_text(encoding="utf-8")
for anchor, replacement, label in [
    (
        "      - desktop-electron/electron/profile.cjs\n",
        "      - desktop-electron/electron/profile.cjs\n      - desktop-electron/electron/runtime-command.cjs\n",
        "push runtime command path",
    ),
    (
        "      - desktop-electron/tests/profile.test.cjs\n",
        "      - desktop-electron/tests/profile.test.cjs\n      - desktop-electron/tests/runtime-version-probe.test.cjs\n",
        "push runtime probe test path",
    ),
]:
    workflow_text, did_change = replace_once(workflow_text, anchor, replacement, label)
    if did_change and str(TOOLING_WORKFLOW) not in changed_paths:
        changed_paths.append(str(TOOLING_WORKFLOW))
# The same path anchors occur once in push and once in pull_request after the first replacement.
workflow_text, did_change = replace_once(
    workflow_text,
    "      - desktop-electron/electron/profile.cjs\n      - desktop-electron/electron/smoke-exit.cjs\n",
    "      - desktop-electron/electron/profile.cjs\n      - desktop-electron/electron/runtime-command.cjs\n      - desktop-electron/electron/smoke-exit.cjs\n",
    "pull request runtime command path",
)
if did_change and str(TOOLING_WORKFLOW) not in changed_paths:
    changed_paths.append(str(TOOLING_WORKFLOW))
workflow_text, did_change = replace_once(
    workflow_text,
    "      - desktop-electron/tests/profile.test.cjs\n      - docs/releases/v0.7.0-rc.1.md\n",
    "      - desktop-electron/tests/profile.test.cjs\n      - desktop-electron/tests/runtime-version-probe.test.cjs\n      - docs/releases/v0.7.0-rc.1.md\n",
    "pull request runtime probe test path",
)
if did_change and str(TOOLING_WORKFLOW) not in changed_paths:
    changed_paths.append(str(TOOLING_WORKFLOW))
workflow_text, did_change = replace_once(
    workflow_text,
    "          node --check desktop-electron/electron/profile.cjs\n",
    "          node --check desktop-electron/electron/profile.cjs\n          node --check desktop-electron/electron/runtime-command.cjs\n",
    "runtime command syntax check",
)
if did_change and str(TOOLING_WORKFLOW) not in changed_paths:
    changed_paths.append(str(TOOLING_WORKFLOW))
workflow_text, did_change = replace_once(
    workflow_text,
    "          node --check desktop-electron/tests/profile.test.cjs\n",
    "          node --check desktop-electron/tests/profile.test.cjs\n          node --check desktop-electron/tests/runtime-version-probe.test.cjs\n",
    "runtime probe test syntax check",
)
if did_change and str(TOOLING_WORKFLOW) not in changed_paths:
    changed_paths.append(str(TOOLING_WORKFLOW))
workflow_text, did_change = replace_once(
    workflow_text,
    "            desktop-electron/tests/profile.test.cjs \\\n",
    "            desktop-electron/tests/profile.test.cjs \\\n            desktop-electron/tests/runtime-version-probe.test.cjs \\\n",
    "runtime probe focused test",
)
if did_change and str(TOOLING_WORKFLOW) not in changed_paths:
    changed_paths.append(str(TOOLING_WORKFLOW))
if write_if_changed(TOOLING_WORKFLOW, workflow_text) and str(TOOLING_WORKFLOW) not in changed_paths:
    changed_paths.append(str(TOOLING_WORKFLOW))

print("RUNTIME_VERSION_PROBE_FIX_OK changed=" + ("true" if changed_paths else "false"))
for changed_path in changed_paths:
    print(changed_path)
