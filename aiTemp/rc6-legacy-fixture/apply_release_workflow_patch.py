from pathlib import Path

workflow = Path(".github/workflows/codex-router-multiprovider-release-rc6.yml")
text = workflow.read_text(encoding="utf-8")
start_marker = "      - name: Create a legacy Tauri uninstall fixture\n"
end_marker = "      - name: Verify legacy uninstall and rc.6 reinstall\n"

replacement = r'''      - name: Create a legacy Tauri uninstall fixture
        shell: pwsh
        run: |
          $ErrorActionPreference = 'Stop'
          $root = Join-Path $env:GITHUB_WORKSPACE 'aiTemp\installer-upgrade\legacy-uninstall-fixture'
          $trash = Join-Path $env:CODING_TOOLS_RETENTION_ROOT 'legacy-uninstall-fixture'
          $evidence = Join-Path $env:GITHUB_WORKSPACE 'aiTemp\evidence\legacy-uninstall-fixture.txt'
          & "$env:GITHUB_WORKSPACE\desktop-electron\scripts\create-legacy-uninstall-fixture.ps1" `
            -RootPath $root `
            -TrashPath $trash `
            | Tee-Object -FilePath $evidence
          if (-not (Test-Path -LiteralPath (Join-Path $root 'fixture.txt'))) {
            throw 'legacy uninstall fixture record is missing'
          }
          if (-not (Test-Path -LiteralPath (Join-Path $root 'Coding Tools MCP\uninstall.exe'))) {
            throw 'legacy uninstall fixture executable is missing'
          }

'''

if replacement in text:
    print("RC6_LEGACY_FIXTURE_WORKFLOW_ALREADY_PATCHED")
elif start_marker in text and end_marker in text:
    start = text.index(start_marker)
    end = text.index(end_marker, start)
    workflow.write_text(text[:start] + replacement + text[end:], encoding="utf-8")
    print("RC6_LEGACY_FIXTURE_WORKFLOW_PATCHED")
else:
    raise SystemExit("legacy uninstall fixture workflow anchors were not found")
