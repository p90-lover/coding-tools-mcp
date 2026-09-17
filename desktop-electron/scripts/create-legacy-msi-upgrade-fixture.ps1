[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string] $RootPath,

    [Parameter(Mandatory = $true)]
    [string] $TrashPath,

    [Parameter(Mandatory = $true)]
    [string] $InstallerIncludePath
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$productCode = '{11111111-2222-3333-4444-555555555555}'
$uninstallRoot = 'Software\Microsoft\Windows\CurrentVersion\Uninstall'
$registryPath = "$uninstallRoot\$productCode"
$marker = Join-Path $RootPath 'legacy-msiexec-ran.txt'
$payload = Join-Path $RootPath 'legacy-msi-payload.bin'
$retainedPayload = Join-Path $TrashPath 'legacy-msi-payload.bin'
$sourcePath = Join-Path $RootPath 'LegacyMsiExecFixture.cs'
$fakeMsiExec = Join-Path $RootPath 'legacy-msiexec.exe'
$harnessPath = Join-Path $RootPath 'legacy-msi-upgrade-harness.nsi'
$harnessExe = Join-Path $RootPath 'legacy-msi-upgrade-harness.exe'

New-Item -ItemType Directory -Path $RootPath -Force | Out-Null
New-Item -ItemType Directory -Path $TrashPath -Force | Out-Null
Set-Content -LiteralPath $payload -Value 'legacy MSI payload' -Encoding UTF8

$source = @'
using System;
using System.IO;
using Microsoft.Win32;

internal static class LegacyMsiExecFixture
{
    private const string ProductCode = "{11111111-2222-3333-4444-555555555555}";

    public static int Main(string[] args)
    {
        string marker = Environment.GetEnvironmentVariable("CODING_TOOLS_LEGACY_MSI_MARKER");
        string payload = Environment.GetEnvironmentVariable("CODING_TOOLS_LEGACY_MSI_PAYLOAD");
        string retainedPayload = Environment.GetEnvironmentVariable("CODING_TOOLS_LEGACY_MSI_RETAINED_PAYLOAD");
        if (String.IsNullOrWhiteSpace(marker)
            || String.IsNullOrWhiteSpace(payload)
            || String.IsNullOrWhiteSpace(retainedPayload)) return 41;

        string command = String.Join(" ", args);
        bool hasUninstall = Array.Exists(args, value => String.Equals(value, "/x", StringComparison.OrdinalIgnoreCase));
        bool hasProduct = Array.Exists(args, value => String.Equals(value, ProductCode, StringComparison.OrdinalIgnoreCase));
        bool hasQuiet = Array.Exists(args, value => String.Equals(value, "/qn", StringComparison.OrdinalIgnoreCase));
        bool hasNoRestart = Array.Exists(args, value => String.Equals(value, "/norestart", StringComparison.OrdinalIgnoreCase));
        if (!hasUninstall || !hasProduct || !hasQuiet || !hasNoRestart) {
            File.WriteAllText(marker, "INVALID_ARGUMENTS " + command);
            return 87;
        }

        Directory.CreateDirectory(Path.GetDirectoryName(retainedPayload));
        if (File.Exists(payload)) File.Move(payload, retainedPayload);

        using (RegistryKey baseKey = RegistryKey.OpenBaseKey(RegistryHive.CurrentUser, RegistryView.Registry64))
        using (RegistryKey uninstall = baseKey.OpenSubKey(
            @"Software\Microsoft\Windows\CurrentVersion\Uninstall", true))
        {
            if (uninstall == null) return 42;
            uninstall.DeleteSubKeyTree(ProductCode, false);
        }

        File.WriteAllText(marker, "LEGACY_MSIEXEC_RAN " + command);
        return 3010;
    }
}
'@
Set-Content -LiteralPath $sourcePath -Value $source -Encoding UTF8

$compilerCandidates = @(
    (Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'),
    (Join-Path $env:WINDIR 'Microsoft.NET\Framework\v4.0.30319\csc.exe')
)
$csc = $compilerCandidates | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
if ([String]::IsNullOrWhiteSpace($csc)) {
    throw "A .NET Framework csc.exe compiler was not found. Checked: $($compilerCandidates -join ', ')"
}
& $csc '/nologo' '/target:exe' '/optimize+' '/platform:x64' "/out:$fakeMsiExec" $sourcePath
if ($LASTEXITCODE -ne 0) {
    throw "csc.exe failed with exit code $LASTEXITCODE"
}
if (-not (Test-Path -LiteralPath $fakeMsiExec -PathType Leaf)) {
    throw "csc.exe returned success but did not create $fakeMsiExec"
}

$baseKey = [Microsoft.Win32.RegistryKey]::OpenBaseKey(
    [Microsoft.Win32.RegistryHive]::CurrentUser,
    [Microsoft.Win32.RegistryView]::Registry64
)
try {
    $legacyKey = $baseKey.CreateSubKey($registryPath, $true)
    try {
        $legacyKey.SetValue('DisplayName', 'Coding Tools MCP', [Microsoft.Win32.RegistryValueKind]::String)
        $legacyKey.SetValue('DisplayVersion', '0.4.11', [Microsoft.Win32.RegistryValueKind]::String)
        $legacyKey.SetValue('WindowsInstaller', 1, [Microsoft.Win32.RegistryValueKind]::DWord)
        $legacyKey.SetValue('UninstallString', "msiexec.exe /x $productCode", [Microsoft.Win32.RegistryValueKind]::String)
    }
    finally {
        $legacyKey.Dispose()
    }
}
finally {
    $baseKey.Dispose()
}

function Convert-ToNsisPath([string] $Value) {
    return $Value.Replace('$', '$$')
}

$fixtureExecutableNsis = Convert-ToNsisPath ([System.IO.Path]::GetFullPath($fakeMsiExec))
$installerIncludeNsis = Convert-ToNsisPath ([System.IO.Path]::GetFullPath($InstallerIncludePath))
$harnessExeNsis = Convert-ToNsisPath ([System.IO.Path]::GetFullPath($harnessExe))
$harness = @"
Unicode true
SilentInstall silent
RequestExecutionLevel user
Name "Coding Tools legacy MSI migration harness"
OutFile "$harnessExeNsis"
!define LEGACY_MSIEXEC "$fixtureExecutableNsis"
!include "$installerIncludeNsis"

Function .onInit
  !insertmacro customInit
  Quit
FunctionEnd

Section
SectionEnd
"@
Set-Content -LiteralPath $harnessPath -Value $harness -Encoding UTF8

$record = [ordered]@{
    productCode = $productCode
    registryPath = "HKCU64:\$registryPath"
    marker = $marker
    payload = $payload
    retainedPayload = $retainedPayload
    fakeMsiExec = $fakeMsiExec
    harnessPath = $harnessPath
    harnessExe = $harnessExe
    compiler = $csc
}
$record | ConvertTo-Json -Depth 3 | Set-Content -LiteralPath (Join-Path $RootPath 'fixture.json') -Encoding UTF8
$record | ConvertTo-Json -Depth 3
