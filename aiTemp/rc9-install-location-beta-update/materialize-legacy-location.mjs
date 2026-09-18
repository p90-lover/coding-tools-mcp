import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const evidenceRoot = path.join(root, "aiTemp", "installer-location-beta-popup", "evidence");
fs.mkdirSync(evidenceRoot, { recursive: true });

function replaceOnce(relativePath, before, after, marker) {
  const filePath = path.join(root, relativePath);
  const source = fs.readFileSync(filePath, "utf8");
  if (source.includes(marker)) return false;
  const count = source.split(before).length - 1;
  if (count !== 1) {
    throw new Error(`${relativePath}: expected one replacement target, found ${count}`);
  }
  fs.writeFileSync(filePath, source.replace(before, after), "utf8");
  return true;
}

const changed = [];
const installerPath = "desktop-electron/build/installer.nsh";

const captureMacro = [
  "!macro CaptureLegacyInstallLocation ROOT",
  "  ClearErrors",
  '  ReadRegStr $LegacyInstallLocation ${ROOT} "$LegacyRegistryKey" "InstallLocation"',
  "  ${Unless} ${Errors}",
  "    StrCpy $LegacyFirstChar $LegacyInstallLocation 1",
  "    StrCpy $LegacyLastChar $LegacyInstallLocation 1 -1",
  '    ${If} $LegacyFirstChar == "$\\\""',
  '    ${AndIf} $LegacyLastChar == "$\\\""',
  "      StrCpy $LegacyInstallLocation $LegacyInstallLocation -1 1",
  "    ${EndIf}",
  '    ${If} $LegacyInstallLocation != ""',
  '      IfFileExists "$LegacyInstallLocation\\*.*" 0 +3',
  "        StrCpy $INSTDIR $LegacyInstallLocation",
  '        DetailPrint "Reusing legacy Coding Tools install location: $INSTDIR"',
  "    ${EndIf}",
  "  ${EndUnless}",
  "!macroend",
  "",
  "!macro RemoveLegacyMsi ROOT VIEW",
].join("\n");

if (replaceOnce(
  installerPath,
  "!macro RemoveLegacyMsi ROOT VIEW",
  captureMacro,
  "!macro CaptureLegacyInstallLocation ROOT",
)) changed.push(installerPath);

const migrationMatch = [
  '      ${If} $LegacyDisplayName == "${LEGACY_PRODUCT_NAME}"',
  "        ClearErrors",
  '        ReadRegDWORD $LegacyWindowsInstaller ${ROOT} "$LegacyRegistryKey" "WindowsInstaller"',
].join("\n");
const migrationReplacement = [
  '      ${If} $LegacyDisplayName == "${LEGACY_PRODUCT_NAME}"',
  "        !insertmacro CaptureLegacyInstallLocation ${ROOT}",
  "        ClearErrors",
  '        ReadRegDWORD $LegacyWindowsInstaller ${ROOT} "$LegacyRegistryKey" "WindowsInstaller"',
].join("\n");
if (replaceOnce(
  installerPath,
  migrationMatch,
  migrationReplacement,
  "!insertmacro CaptureLegacyInstallLocation ${ROOT}",
)) {
  if (!changed.includes(installerPath)) changed.push(installerPath);
}

const acceptancePath = "aiTemp/rc7-release/verify-windows-migration.ps1";
const acceptanceBefore = [
  "$currentKey = 'HKCU:\\Software\\3cb2ea96-3319-55b8-95a5-7f180a5f3ed4'",
  "$currentLocation = (Get-ItemPropertyValue -Path $currentKey -Name InstallLocation).Trim('\"')",
  "$currentApplication = Join-Path $currentLocation 'Coding Tools.exe'",
  "if (-not (Test-Path -LiteralPath $currentApplication -PathType Leaf)) { throw \"installed application is missing: $currentApplication\" }",
].join("\n");
const acceptanceAfter = [
  "$currentKey = 'HKCU:\\Software\\3cb2ea96-3319-55b8-95a5-7f180a5f3ed4'",
  "$currentLocation = (Get-ItemPropertyValue -Path $currentKey -Name InstallLocation).Trim('\"')",
  "$expectedLegacyLocation = [IO.Path]::GetFullPath($legacyInstall).TrimEnd('\\')",
  "$currentLocationNormalized = [IO.Path]::GetFullPath($currentLocation).TrimEnd('\\')",
  "if (-not [String]::Equals($currentLocationNormalized, $expectedLegacyLocation, [StringComparison]::OrdinalIgnoreCase)) {",
  "    throw \"current install location changed from legacy path: expected $expectedLegacyLocation, got $currentLocationNormalized\"",
  "}",
  "$currentApplication = Join-Path $currentLocation 'Coding Tools.exe'",
  "if (-not (Test-Path -LiteralPath $currentApplication -PathType Leaf)) { throw \"installed application is missing: $currentApplication\" }",
].join("\n");
if (replaceOnce(
  acceptancePath,
  acceptanceBefore,
  acceptanceAfter,
  "current install location changed from legacy path",
)) changed.push(acceptancePath);

if (replaceOnce(
  acceptancePath,
  "    legacyUninstallerPreserved = $true\n    currentInstallLocation = $currentLocation",
  "    legacyUninstallerPreserved = $true\n    legacyLocationReused = $true\n    currentInstallLocation = $currentLocation",
  "legacyLocationReused = $true",
)) {
  if (!changed.includes(acceptancePath)) changed.push(acceptancePath);
}

const receipt = {
  changed,
  noDeletion: true,
  generatedAt: new Date().toISOString(),
};
fs.writeFileSync(
  path.join(evidenceRoot, "legacy-location-materializer-receipt.json"),
  `${JSON.stringify(receipt, null, 2)}\n`,
  "utf8",
);
console.log(JSON.stringify(receipt));
