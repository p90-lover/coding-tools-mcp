!include "LogicLib.nsh"
!include "x64.nsh"

!ifndef BUILD_UNINSTALLER
!define LEGACY_PRODUCT_NAME "Coding Tools MCP"
!define LEGACY_UNINSTALL_ROOT "Software\Microsoft\Windows\CurrentVersion\Uninstall"
!ifndef LEGACY_MSIEXEC
!define LEGACY_MSIEXEC "$SYSDIR\msiexec.exe"
!endif

Var LegacySubKey
Var LegacyRegistryKey
Var LegacyEnumIndex
Var LegacyDisplayName
Var LegacyWindowsInstaller
Var LegacySubKeyLength
Var LegacyUninstallCommand
Var LegacyInstallLocation
Var LegacyExpectedUninstall
Var LegacyExpectedUninstallPlain
Var LegacyFirstChar
Var LegacyLastChar
Var LegacyExitCode
Var LegacyWaitCount
Var LegacyRegistryAfter

!macro FailLegacyMigration DETAIL
  MessageBox MB_ICONSTOP|MB_OK "Coding Tools legacy uninstall failed: ${DETAIL}$\r$\n$\r$\nClose the old Coding Tools MCP application and run this installer again." /SD IDOK
  Abort
!macroend

!macro RemoveLegacyMsi ROOT VIEW
  StrLen $LegacySubKeyLength $LegacySubKey
  ${If} $LegacySubKeyLength != 38
    !insertmacro FailLegacyMigration "the legacy MSI product code has an invalid length"
  ${EndIf}
  StrCpy $LegacyFirstChar $LegacySubKey 1
  StrCpy $LegacyLastChar $LegacySubKey 1 -1
  ${If} $LegacyFirstChar != "{"
    !insertmacro FailLegacyMigration "the legacy MSI product code does not start with an opening brace"
  ${EndIf}
  ${If} $LegacyLastChar != "}"
    !insertmacro FailLegacyMigration "the legacy MSI product code does not end with a closing brace"
  ${EndIf}

  DetailPrint "Removing legacy Coding Tools MCP MSI before installing Coding Tools"
  ClearErrors
  ExecWait '"${LEGACY_MSIEXEC}" /x "$LegacySubKey" /qn /norestart' $LegacyExitCode
  ${If} ${Errors}
    !insertmacro FailLegacyMigration "the legacy MSI uninstaller could not be started"
  ${EndIf}
  ${If} $LegacyExitCode != 0
  ${AndIf} $LegacyExitCode != 3010
    !insertmacro FailLegacyMigration "legacy MSI uninstall failed with exit code $LegacyExitCode"
  ${EndIf}

  StrCpy $LegacyWaitCount 0
  legacy_msi_wait_${ROOT}_${VIEW}:
    Sleep 500
    ClearErrors
    ReadRegStr $LegacyRegistryAfter ${ROOT} "$LegacyRegistryKey" "DisplayName"
    ${If} ${Errors}
      Goto legacy_msi_done_${ROOT}_${VIEW}
    ${EndIf}
    IntOp $LegacyWaitCount $LegacyWaitCount + 1
    ${If} $LegacyWaitCount >= 60
      !insertmacro FailLegacyMigration "the legacy MSI installation did not finish removing itself"
    ${EndIf}
    Goto legacy_msi_wait_${ROOT}_${VIEW}

  legacy_msi_done_${ROOT}_${VIEW}:
    ${If} $LegacyExitCode == 3010
      DetailPrint "Legacy Coding Tools MCP MSI removal completed; Windows reported restart recommended"
    ${Else}
      DetailPrint "Legacy Coding Tools MCP MSI removal completed"
    ${EndIf}
!macroend

!macro RemoveLegacyNsis ROOT VIEW
  ClearErrors
  ReadRegStr $LegacyUninstallCommand ${ROOT} "$LegacyRegistryKey" "UninstallString"
  ${If} ${Errors}
    !insertmacro FailLegacyMigration "the registered uninstaller is missing"
  ${EndIf}

  ClearErrors
  ReadRegStr $LegacyInstallLocation ${ROOT} "$LegacyRegistryKey" "InstallLocation"
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
  StrCpy $LegacyExpectedUninstallPlain "$LegacyInstallLocation\uninstall.exe"
  ${If} $LegacyUninstallCommand != $LegacyExpectedUninstall
  ${AndIf} $LegacyUninstallCommand != $LegacyExpectedUninstallPlain
    !insertmacro FailLegacyMigration "the registered uninstaller does not match the legacy Coding Tools MCP installation"
  ${EndIf}

  ${Unless} ${FileExists} "$LegacyInstallLocation\uninstall.exe"
    !insertmacro FailLegacyMigration "the registered uninstaller file does not exist"
  ${EndUnless}

  DetailPrint "Removing legacy Coding Tools MCP NSIS install before installing Coding Tools"
  ClearErrors
  ExecWait '$LegacyUninstallCommand /S' $LegacyExitCode
  ${If} ${Errors}
    !insertmacro FailLegacyMigration "the legacy uninstaller could not be started"
  ${EndIf}
  ${If} $LegacyExitCode != 0
    !insertmacro FailLegacyMigration "the legacy uninstaller returned exit code $LegacyExitCode"
  ${EndIf}

  StrCpy $LegacyWaitCount 0
  legacy_nsis_wait_${ROOT}_${VIEW}:
    Sleep 500
    ClearErrors
    ReadRegStr $LegacyRegistryAfter ${ROOT} "$LegacyRegistryKey" "DisplayName"
    ${If} ${Errors}
      IfFileExists "$LegacyInstallLocation\uninstall.exe" 0 legacy_nsis_done_${ROOT}_${VIEW}
    ${EndIf}
    IntOp $LegacyWaitCount $LegacyWaitCount + 1
    ${If} $LegacyWaitCount >= 60
      !insertmacro FailLegacyMigration "the legacy NSIS installation did not finish removing itself"
    ${EndIf}
    Goto legacy_nsis_wait_${ROOT}_${VIEW}

  legacy_nsis_done_${ROOT}_${VIEW}:
    DetailPrint "Legacy Coding Tools MCP NSIS removal completed"
!macroend

!macro MigrateLegacyInstall ROOT VIEW
  SetRegView ${VIEW}
  StrCpy $LegacyEnumIndex 0

  legacy_scan_${ROOT}_${VIEW}:
    ClearErrors
    EnumRegKey $LegacySubKey ${ROOT} "${LEGACY_UNINSTALL_ROOT}" $LegacyEnumIndex
    ${If} ${Errors}
      Goto legacy_scan_done_${ROOT}_${VIEW}
    ${EndIf}
    ${If} $LegacySubKey == ""
      Goto legacy_scan_done_${ROOT}_${VIEW}
    ${EndIf}

    StrCpy $LegacyRegistryKey "${LEGACY_UNINSTALL_ROOT}\$LegacySubKey"
    ClearErrors
    ReadRegStr $LegacyDisplayName ${ROOT} "$LegacyRegistryKey" "DisplayName"
    ${Unless} ${Errors}
      ${If} $LegacyDisplayName == "${LEGACY_PRODUCT_NAME}"
        ClearErrors
        ReadRegDWORD $LegacyWindowsInstaller ${ROOT} "$LegacyRegistryKey" "WindowsInstaller"
        ${If} ${Errors}
          StrCpy $LegacyWindowsInstaller 0
        ${EndIf}

        ${If} $LegacyWindowsInstaller == 1
          !insertmacro RemoveLegacyMsi ${ROOT} ${VIEW}
        ${Else}
          !insertmacro RemoveLegacyNsis ${ROOT} ${VIEW}
        ${EndIf}

        StrCpy $LegacyEnumIndex 0
        Goto legacy_scan_${ROOT}_${VIEW}
      ${EndIf}
    ${EndUnless}

    IntOp $LegacyEnumIndex $LegacyEnumIndex + 1
    Goto legacy_scan_${ROOT}_${VIEW}

  legacy_scan_done_${ROOT}_${VIEW}:
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
!endif
