from __future__ import annotations

from pathlib import Path

OLD_VERSION = "0.7.0-rc.5"
NEW_VERSION = "0.7.0-rc.6"
OLD_SHORT = "rc.5"
NEW_SHORT = "rc.6"
OLD_TOKEN = "rc5"
NEW_TOKEN = "rc6"

IDENTITY_FILES = (
    "desktop-electron/package.json",
    "desktop-electron/electron/product.cjs",
    "desktop-electron/scripts/prepare-package-resources.cjs",
    "desktop-electron/scripts/verify-package.cjs",
    "desktop-electron/tests/package-contents.test.cjs",
    "desktop-electron/tests/package-resource-preparation.test.cjs",
    "desktop-electron/tests/product-identity.test.cjs",
)


def replace_identity(pathname: str) -> None:
    path = Path(pathname)
    text = path.read_text(encoding="utf-8")
    if OLD_VERSION in text:
        text = text.replace(OLD_VERSION, NEW_VERSION)
        path.write_text(text, encoding="utf-8")
        return
    if NEW_VERSION not in text:
        raise SystemExit(f"missing release identity in {pathname}")


for pathname in IDENTITY_FILES:
    replace_identity(pathname)

migration_test_path = Path("desktop-electron/tests/installer-upgrade-migration.test.cjs")
migration_test = migration_test_path.read_text(encoding="utf-8")
migration_test = migration_test.replace(OLD_VERSION, NEW_VERSION)
migration_test = migration_test.replace(r"0\.7\.0-rc\.5", r"0\.7\.0-rc\.6")
migration_test = migration_test.replace(OLD_SHORT, NEW_SHORT)
migration_test = migration_test.replace(
    "v0.7-installer-upgrade-migration.yml",
    "codex-router-multiprovider-release-rc6.yml",
)
migration_test_path.write_text(migration_test, encoding="utf-8")

source_workflow = Path(
    ".github/workflows/codex-router-multiprovider-release-rc5.yml"
).read_text(encoding="utf-8")
workflow = source_workflow.replace(OLD_VERSION, NEW_VERSION)
workflow = workflow.replace(OLD_SHORT, NEW_SHORT)
workflow = workflow.replace(OLD_TOKEN, NEW_TOKEN)

contract_anchor = "            desktop-electron/tests/product-identity.test.cjs \\\n"
if workflow.count(contract_anchor) != 1:
    raise SystemExit("rc.6 source-contract insertion anchor changed")
workflow = workflow.replace(
    contract_anchor,
    contract_anchor
    + "            desktop-electron/tests/installer-upgrade-migration.test.cjs \\\n",
    1,
)

migration_steps = r'''
      - name: Create a legacy Tauri uninstall fixture
        shell: pwsh
        run: |
          $ErrorActionPreference = 'Stop'
          $root = Join-Path $env:GITHUB_WORKSPACE 'aiTemp\installer-upgrade\legacy-uninstall-fixture'
          $trash = Join-Path $env:CODING_TOOLS_RETENTION_ROOT 'legacy-uninstall-fixture'
          $install = Join-Path $root 'Coding Tools MCP'
          $marker = Join-Path $root 'legacy-uninstaller-ran.txt'
          New-Item -ItemType Directory -Path $install -Force | Out-Null
          New-Item -ItemType Directory -Path $trash -Force | Out-Null
          Set-Content -LiteralPath (Join-Path $install 'legacy-app.bin') -Value 'legacy payload'
          $source = @'
          using System;
          using System.Diagnostics;
          using System.IO;
          using System.Reflection;
          using System.Text;
          using Microsoft.Win32;

          internal static class LegacyUninstallFixture
          {
              private static string PowerShellLiteral(string value)
              {
                  return "'" + value.Replace("'", "''") + "'";
              }

              public static int Main(string[] args)
              {
                  string marker = Environment.GetEnvironmentVariable("CODING_TOOLS_LEGACY_UNINSTALL_MARKER");
                  string install = Environment.GetEnvironmentVariable("CODING_TOOLS_LEGACY_INSTALL_LOCATION");
                  string trash = Environment.GetEnvironmentVariable("CODING_TOOLS_LEGACY_TRASH_DIR");
                  if (String.IsNullOrWhiteSpace(marker)
                      || String.IsNullOrWhiteSpace(install)
                      || String.IsNullOrWhiteSpace(trash)) return 41;

                  Directory.CreateDirectory(trash);
                  File.WriteAllText(marker, String.Join(" ", args));

                  string payload = Path.Combine(install, "legacy-app.bin");
                  string retainedPayload = Path.Combine(trash, "legacy-app.bin");
                  if (File.Exists(payload)) File.Move(payload, retainedPayload);

                  using (RegistryKey key = Registry.CurrentUser.OpenSubKey(
                      @"Software\Microsoft\Windows\CurrentVersion\Uninstall", true))
                  {
                      if (key != null)
                      {
                          key.DeleteSubKeyTree("Coding Tools MCP", false);
                      }
                  }

                  int processId = Process.GetCurrentProcess().Id;
                  string currentExecutable = Assembly.GetExecutingAssembly().Location;
                  string retainedUninstaller = Path.Combine(trash, "uninstall.exe");
                  string script = "$ErrorActionPreference='Stop'; Wait-Process -Id "
                      + processId
                      + "; Move-Item -LiteralPath "
                      + PowerShellLiteral(currentExecutable)
                      + " -Destination "
                      + PowerShellLiteral(retainedUninstaller);
                  string encodedScript = Convert.ToBase64String(Encoding.Unicode.GetBytes(script));
                  Process.Start(new ProcessStartInfo
                  {
                      FileName = "pwsh.exe",
                      Arguments = "-NoProfile -NonInteractive -EncodedCommand " + encodedScript,
                      CreateNoWindow = true,
                      UseShellExecute = false,
                  });
                  return 0;
              }
          }
          '@
          New-Item -ItemType Directory -Path $root -Force | Out-Null
          $sourcePath = Join-Path $root 'LegacyUninstallFixture.cs'
          $uninstaller = Join-Path $install 'uninstall.exe'
          Set-Content -LiteralPath $sourcePath -Value $source
          $compilerCandidates = @(
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

          $key = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\Coding Tools MCP'
          New-Item -Path $key -Force | Out-Null
          New-ItemProperty -Path $key -Name DisplayName -Value 'Coding Tools MCP' -PropertyType String -Force | Out-Null
          New-ItemProperty -Path $key -Name DisplayVersion -Value '0.4.11' -PropertyType String -Force | Out-Null
          New-ItemProperty -Path $key -Name InstallLocation -Value ('"' + $install + '"') -PropertyType String -Force | Out-Null
          New-ItemProperty -Path $key -Name UninstallString -Value ('"' + $uninstaller + '"') -PropertyType String -Force | Out-Null
          "LEGACY_FIXTURE_READY`ninstall=$install`nmarker=$marker`ntrash=$trash" |
            Set-Content -LiteralPath (Join-Path $root 'fixture.txt')

      - name: Verify legacy uninstall and rc.6 reinstall
        shell: pwsh
        run: |
          $ErrorActionPreference = 'Stop'
          $root = Join-Path $env:GITHUB_WORKSPACE 'aiTemp\installer-upgrade\legacy-uninstall-fixture'
          $trash = Join-Path $env:CODING_TOOLS_RETENTION_ROOT 'legacy-uninstall-fixture'
          $install = Join-Path $root 'Coding Tools MCP'
          $marker = Join-Path $root 'legacy-uninstaller-ran.txt'
          $env:CODING_TOOLS_LEGACY_UNINSTALL_MARKER = $marker
          $env:CODING_TOOLS_LEGACY_INSTALL_LOCATION = $install
          $env:CODING_TOOLS_LEGACY_TRASH_DIR = $trash
          $installer = Join-Path $env:GITHUB_WORKSPACE ('aiTemp\release-output\' + $env:WINDOWS_INSTALLER)
          $process = Start-Process -FilePath $installer -ArgumentList '/S', '/currentuser' -Wait -PassThru
          if ($process.ExitCode -ne 0) { throw "rc.6 installer failed with exit code $($process.ExitCode)" }
          if (-not (Test-Path -LiteralPath $marker)) { throw 'legacy uninstaller was not executed' }
          if (Test-Path -LiteralPath (Join-Path $install 'legacy-app.bin')) { throw 'legacy payload remains in the old installation' }
          if (Test-Path -LiteralPath (Join-Path $install 'uninstall.exe')) { throw 'legacy uninstaller remains in the old installation' }

          $preservedPayload = Join-Path $trash 'legacy-app.bin'
          $preservedUninstaller = Join-Path $trash 'uninstall.exe'
          if (-not (Test-Path -LiteralPath $preservedPayload)) { throw 'legacy payload was not preserved under aiTemp/Trash' }
          if (-not (Test-Path -LiteralPath $preservedUninstaller)) { throw 'legacy uninstaller was not preserved under aiTemp/Trash' }

          $legacyKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\Coding Tools MCP'
          if (Test-Path -LiteralPath $legacyKey) { throw 'legacy uninstall key remains after migration' }

          $currentKey = 'HKCU:\Software\3cb2ea96-3319-55b8-95a5-7f180a5f3ed4'
          $location = Get-ItemPropertyValue -Path $currentKey -Name InstallLocation
          $location = $location.Trim('"')
          $application = Join-Path $location 'Coding Tools.exe'
          if (-not (Test-Path -LiteralPath $application)) { throw "reinstalled application is missing: $application" }

          $evidence = [ordered]@{
            source = $env:SOURCE_SHA
            installer = $installer
            installerExitCode = $process.ExitCode
            legacyUninstallerRan = $true
            legacyRegistryRemoved = $true
            legacyPayloadPreserved = $true
            legacyUninstallerPreserved = $true
            preservedPayload = $preservedPayload
            preservedUninstaller = $preservedUninstaller
            currentInstallLocation = $location
            currentApplication = $application
          }
          $evidence | ConvertTo-Json -Depth 4 |
            Set-Content -LiteralPath (Join-Path $env:GITHUB_WORKSPACE 'aiTemp\evidence\installer-upgrade-migration.json')
          if (-not (Test-Path -LiteralPath (Join-Path $env:GITHUB_WORKSPACE 'aiTemp\evidence\installer-upgrade-migration.json'))) {
            throw 'installer migration evidence was not written'
          }
'''

upload_anchor = """      - uses: actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02
        with:
          name: coding-tools-0.7.0-rc.6-windows-x64-${{ github.sha }}
"""
if workflow.count(upload_anchor) != 1:
    raise SystemExit("rc.6 Windows migration insertion anchor changed")
workflow = workflow.replace(upload_anchor, migration_steps + "\n" + upload_anchor, 1)

validation_anchor = "            automated_gates: 'passed',\n"
if workflow.count(validation_anchor) != 1:
    raise SystemExit("rc.6 validation disclosure anchor changed")
workflow = workflow.replace(
    validation_anchor,
    validation_anchor + "            installer_upgrade_migration: 'passed',\n",
    1,
)

workflow_path = Path(
    ".github/workflows/codex-router-multiprovider-release-rc6.yml"
)
workflow_path.write_text(workflow, encoding="utf-8")

release_notes = """# Coding Tools v0.7.0-rc.6

## English

This installer-compatibility hotfix repairs upgrades from the historical Tauri-based **Coding Tools MCP** application to the current Electron-based **Coding Tools** desktop.

### Fixes

- Searches the exact legacy `Coding Tools MCP` uninstall registration in HKCU/HKLM and both Windows registry views.
- Validates the registered display name, install location, uninstall command, and `uninstall.exe` before executing anything.
- Runs the legacy uninstaller silently and synchronously, then waits for its registry entry and uninstaller file to disappear before installing the new application.
- Fails closed on missing or ambiguous metadata, launch failure, non-zero exit, or timeout.
- Preserves user application data and does not manually delete old application folders or registry keys.
- Keeps the stable Electron NSIS GUID so future Electron releases continue to upgrade normally.

### Release gate

The Windows release job creates a legacy Tauri uninstall fixture, runs the packaged rc.6 installer, verifies the old uninstall path completed, and confirms the new `Coding Tools.exe` installation before publication.

---

## 繁體中文

今次 installer 相容性 hotfix 修正由舊版 Tauri **Coding Tools MCP** 升級到目前 Electron **Coding Tools** 桌面程式時，安裝器搵唔到舊安裝、無法先移除再重新安裝嘅問題。

### 修正內容

- 會喺 HKCU／HKLM 同 Windows 32／64-bit registry view 尋找精確嘅 `Coding Tools MCP` 舊版解除安裝記錄。
- 執行之前會驗證顯示名稱、安裝路徑、解除安裝指令同 `uninstall.exe`。
- 以靜默及同步方式執行舊版解除安裝器，等舊 registry 記錄同解除安裝器檔案消失後，先安裝新版。
- 遇到資料缺失、記錄不一致、啟動失敗、非零 exit code 或逾時時會 fail closed。
- 保留使用者應用程式資料，亦唔會由新安裝器自行刪除舊程式資料夾或 registry key。
- 保留穩定 Electron NSIS GUID，確保之後 Electron 版本可以正常原位升級。

### Release gate

Windows release job 會建立真實格式嘅舊 Tauri 解除安裝 fixture，執行已打包 rc.6 installer，確認舊版解除安裝完成，再確認新版 `Coding Tools.exe` 已安裝，之後先可以發佈。
"""
Path("docs/releases/v0.7.0-rc.6.md").write_text(release_notes, encoding="utf-8")

print("RC6_INSTALLER_MIGRATION_RELEASE_MATERIALIZED")
