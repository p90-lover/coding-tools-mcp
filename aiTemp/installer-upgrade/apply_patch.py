from __future__ import annotations

import json
from pathlib import Path

OLD_VERSION = "0.7.0-rc.4"
NEW_VERSION = "0.7.0-rc.5"


def replace_once(path: str, old: str, new: str) -> None:
    target = Path(path)
    text = target.read_text(encoding="utf-8")
    if new in text:
        return
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"expected one release identity anchor in {path}, found {count}")
    target.write_text(text.replace(old, new, 1), encoding="utf-8")


manifest_path = Path("desktop-electron/package.json")
manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
if manifest.get("version") not in {OLD_VERSION, NEW_VERSION}:
    raise SystemExit(f"unexpected desktop version: {manifest.get('version')!r}")
manifest["version"] = NEW_VERSION
nsis = manifest.setdefault("build", {}).setdefault("nsis", {})
if nsis.get("guid") != "3cb2ea96-3319-55b8-95a5-7f180a5f3ed4":
    raise SystemExit("stable Electron NSIS GUID changed unexpectedly")
nsis["include"] = "build/installer.nsh"
nsis["deleteAppDataOnUninstall"] = False
manifest_path.write_text(json.dumps(manifest, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")

for path in (
    "desktop-electron/electron/product.cjs",
    "desktop-electron/scripts/prepare-package-resources.cjs",
    "desktop-electron/scripts/verify-package.cjs",
    "desktop-electron/tests/package-contents.test.cjs",
    "desktop-electron/tests/package-resource-preparation.test.cjs",
    "desktop-electron/tests/product-identity.test.cjs",
):
    replace_once(path, OLD_VERSION, NEW_VERSION)

installer = r'''!include "LogicLib.nsh"
!include "x64.nsh"

!define LEGACY_PRODUCT_NAME "Coding Tools MCP"
!define LEGACY_UNINSTALL_KEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\Coding Tools MCP"

Var LegacyDisplayName
Var LegacyUninstallCommand
Var LegacyInstallLocation
Var LegacyExpectedUninstall
Var LegacyFirstChar
Var LegacyLastChar
Var LegacyExitCode
Var LegacyWaitCount
Var LegacyRegistryAfter

!macro FailLegacyMigration DETAIL
  MessageBox MB_ICONSTOP|MB_OK "Coding Tools legacy uninstall failed: ${DETAIL}$\r$\n$\r$\nClose the old Coding Tools MCP application and run this installer again." /SD IDOK
  Abort
!macroend

!macro MigrateLegacyInstall ROOT VIEW
  SetRegView ${VIEW}
  ClearErrors
  ReadRegStr $LegacyDisplayName ${ROOT} "${LEGACY_UNINSTALL_KEY}" "DisplayName"
  ${Unless} ${Errors}
    ${If} $LegacyDisplayName == "${LEGACY_PRODUCT_NAME}"
      ClearErrors
      ReadRegStr $LegacyUninstallCommand ${ROOT} "${LEGACY_UNINSTALL_KEY}" "UninstallString"
      ${If} ${Errors}
        !insertmacro FailLegacyMigration "the registered uninstaller is missing"
      ${EndIf}

      ClearErrors
      ReadRegStr $LegacyInstallLocation ${ROOT} "${LEGACY_UNINSTALL_KEY}" "InstallLocation"
      ${If} ${Errors}
        !insertmacro FailLegacyMigration "the registered install location is missing"
      ${EndIf}

      StrCpy $LegacyFirstChar $LegacyInstallLocation 1
      StrCpy $LegacyLastChar $LegacyInstallLocation 1 -1
      ${If} $LegacyFirstChar == "$\""
      ${AndIf} $LegacyLastChar == "$\""
        StrCpy $LegacyInstallLocation $LegacyInstallLocation -1 1
      ${EndIf}

      ${If} $LegacyInstallLocation == ""
        !insertmacro FailLegacyMigration "the registered install location is empty"
      ${EndIf}

      StrCpy $LegacyExpectedUninstall "$\"$LegacyInstallLocation\uninstall.exe$\""
      ${If} $LegacyUninstallCommand != $LegacyExpectedUninstall
        !insertmacro FailLegacyMigration "the registered uninstaller does not match the legacy Coding Tools MCP installation"
      ${EndIf}

      ${Unless} ${FileExists} "$LegacyInstallLocation\uninstall.exe"
        !insertmacro FailLegacyMigration "the registered uninstaller file does not exist"
      ${EndUnless}

      DetailPrint "Removing legacy Coding Tools MCP before installing Coding Tools"
      ClearErrors
      ExecWait '$LegacyUninstallCommand /S' $LegacyExitCode
      ${If} ${Errors}
        !insertmacro FailLegacyMigration "the legacy uninstaller could not be started"
      ${EndIf}
      ${If} $LegacyExitCode != 0
        !insertmacro FailLegacyMigration "the legacy uninstaller returned exit code $LegacyExitCode"
      ${EndIf}

      StrCpy $LegacyWaitCount 0
      legacy_wait_${ROOT}_${VIEW}:
        Sleep 500
        ClearErrors
        ReadRegStr $LegacyRegistryAfter ${ROOT} "${LEGACY_UNINSTALL_KEY}" "DisplayName"
        ${If} ${Errors}
          IfFileExists "$LegacyInstallLocation\uninstall.exe" 0 legacy_done_${ROOT}_${VIEW}
        ${EndIf}
        IntOp $LegacyWaitCount $LegacyWaitCount + 1
        ${If} $LegacyWaitCount >= 60
          !insertmacro FailLegacyMigration "the legacy installation did not finish removing itself"
        ${EndIf}
        Goto legacy_wait_${ROOT}_${VIEW}

      legacy_done_${ROOT}_${VIEW}:
        DetailPrint "Legacy Coding Tools MCP removal completed"
    ${EndIf}
  ${EndIf}
!macroend

!macro customInit
  ${If} ${RunningX64}
    !insertmacro MigrateLegacyInstall HKCU 64
    !insertmacro MigrateLegacyInstall HKLM 64
  ${EndIf}
  !insertmacro MigrateLegacyInstall HKCU 32
  !insertmacro MigrateLegacyInstall HKLM 32
  ${If} ${RunningX64}
    SetRegView 64
  ${Else}
    SetRegView 32
  ${EndIf}
!macroend
'''

installer_path = Path("desktop-electron/build/installer.nsh")
installer_path.parent.mkdir(parents=True, exist_ok=True)
if installer_path.exists() and installer_path.read_text(encoding="utf-8") != installer:
    raise SystemExit("installer.nsh already exists with unexpected content")
installer_path.write_text(installer, encoding="utf-8")

print("INSTALLER_UPGRADE_MIGRATION_PATCH_OK")
