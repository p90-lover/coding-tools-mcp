from __future__ import annotations

from pathlib import Path

WORKFLOW_PATH = Path(".github/workflows/codex-router-multiprovider-release-rc6.yml")
MATERIALIZER_PATH = Path("aiTemp/installer-upgrade/materialize_rc6_release.py")
TEST_PATH = Path("desktop-electron/tests/installer-upgrade-migration.test.cjs")

BROKEN_COMPILER = (
    "          Add-Type -TypeDefinition $source -Language CSharp "
    "-OutputAssembly $uninstaller -OutputType ConsoleApplication\n"
)
FIXED_COMPILER = r'''          $compilerCandidates = @(
            (Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'),
            (Join-Path $env:WINDIR 'Microsoft.NET\Framework\v4.0.30319\csc.exe')
          )
          $compiler = $compilerCandidates |
            Where-Object { Test-Path -LiteralPath $_ } |
            Select-Object -First 1
          if (-not $compiler) {
            throw 'The Windows .NET Framework C# compiler was not found'
          }
          $compileOutput = & $compiler \
            '/nologo' \
            '/target:exe' \
            '/platform:x64' \
            "/out:$uninstaller" \
            $sourcePath 2>&1
          $compileExitCode = $LASTEXITCODE
          @(
            "compiler=$compiler"
            "exit_code=$compileExitCode"
            $compileOutput
          ) | Set-Content -LiteralPath (Join-Path $root 'csc-output.txt')
          if ($compileExitCode -ne 0) {
            throw "Legacy fixture compiler failed with exit code $compileExitCode"
          }
          if (-not (Test-Path -LiteralPath $uninstaller)) {
            throw 'Legacy fixture compiler did not create uninstall.exe'
          }
'''

BROKEN_NULL_DELETE = '                      key?.DeleteSubKeyTree("Coding Tools MCP", false);\n'
FIXED_NULL_DELETE = r'''                      if (key != null)
                      {
                          key.DeleteSubKeyTree("Coding Tools MCP", false);
                      }
'''

TEST_ANCHOR = "  assert.match(workflow, /legacyUninstallerPreserved/);\n"
TEST_INSERT = r'''  assert.ok(
    workflow.includes("Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe"),
    "the Windows migration fixture must use the built-in Framework64 C# compiler",
  );
  assert.match(workflow, /\/target:exe/);
  assert.match(workflow, /\/platform:x64/);
  assert.match(workflow, /csc-output\.txt/);
  assert.doesNotMatch(
    workflow,
    /Add-Type[^\n]*OutputType\s+ConsoleApplication/,
  );
'''


def replace_once(path: Path, old: str, new: str, label: str) -> None:
    text = path.read_text(encoding="utf-8")
    if new in text:
        return
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"expected one {label} anchor in {path}, found {count}")
    path.write_text(text.replace(old, new, 1), encoding="utf-8")


for target in (WORKFLOW_PATH, MATERIALIZER_PATH):
    replace_once(target, BROKEN_COMPILER, FIXED_COMPILER, "broken Add-Type compiler")
    replace_once(target, BROKEN_NULL_DELETE, FIXED_NULL_DELETE, "C# null-conditional registry cleanup")

replace_once(TEST_PATH, TEST_ANCHOR, TEST_ANCHOR + TEST_INSERT, "fixture compiler test")

for target in (WORKFLOW_PATH, MATERIALIZER_PATH, TEST_PATH):
    text = target.read_text(encoding="utf-8")
    if "-OutputType ConsoleApplication" in text:
        raise SystemExit(f"unsupported Add-Type output mode remains in {target}")

print("RC6_FIXTURE_CSC_PATCH_OK")
