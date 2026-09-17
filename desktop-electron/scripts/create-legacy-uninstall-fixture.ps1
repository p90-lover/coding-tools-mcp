[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string] $RootPath,

    [Parameter(Mandatory = $true)]
    [string] $TrashPath
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$install = Join-Path $RootPath 'Coding Tools MCP'
$marker = Join-Path $RootPath 'legacy-uninstaller-ran.txt'
$sourcePath = Join-Path $RootPath 'LegacyUninstallFixture.cs'
$uninstaller = Join-Path $install 'uninstall.exe'

New-Item -ItemType Directory -Path $RootPath -Force | Out-Null
New-Item -ItemType Directory -Path $install -Force | Out-Null
New-Item -ItemType Directory -Path $TrashPath -Force | Out-Null
Set-Content -LiteralPath (Join-Path $install 'legacy-app.bin') -Value 'legacy payload' -Encoding UTF8

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
            if (key != null) key.DeleteSubKeyTree("Coding Tools MCP", false);
        }

        int processId = Process.GetCurrentProcess().Id;
        string currentExecutable = Assembly.GetExecutingAssembly().Location;
        string retainedUninstaller = Path.Combine(trash, "uninstall.exe");
        string retentionLog = Path.Combine(trash, "legacy-uninstall-retention.log");
        string script = "$ErrorActionPreference='Stop'; "
            + "Wait-Process -Id " + processId + " -ErrorAction SilentlyContinue; "
            + "$deadline=(Get-Date).AddSeconds(60); "
            + "while ((Test-Path -LiteralPath " + PowerShellLiteral(currentExecutable)
            + ") -and (Get-Date) -lt $deadline) { "
            + "try { Move-Item -LiteralPath " + PowerShellLiteral(currentExecutable)
            + " -Destination " + PowerShellLiteral(retainedUninstaller)
            + " -Force; break } catch { Start-Sleep -Milliseconds 250 } }; "
            + "if (Test-Path -LiteralPath " + PowerShellLiteral(currentExecutable)
            + ") { throw 'legacy uninstaller could not be moved to retained storage' }; "
            + "Set-Content -LiteralPath " + PowerShellLiteral(retentionLog)
            + " -Value 'LEGACY_UNINSTALLER_RETAINED' -Encoding UTF8";
        string encodedScript = Convert.ToBase64String(Encoding.Unicode.GetBytes(script));
        string systemDirectory = Environment.GetFolderPath(Environment.SpecialFolder.System);
        string powershell = Path.Combine(
            systemDirectory,
            @"WindowsPowerShell\v1.0\powershell.exe");
        Process child = Process.Start(new ProcessStartInfo
        {
            FileName = powershell,
            Arguments = "-NoProfile -NonInteractive -WindowStyle Hidden -EncodedCommand " + encodedScript,
            CreateNoWindow = true,
            UseShellExecute = false,
        });
        if (child == null) return 42;
        return 0;
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

$compilerArguments = @(
    '/nologo',
    '/target:exe',
    '/optimize+',
    '/platform:anycpu',
    "/out:$uninstaller",
    $sourcePath
)
& $csc @compilerArguments
if ($LASTEXITCODE -ne 0) {
    throw "csc.exe failed with exit code $LASTEXITCODE"
}
if (-not (Test-Path -LiteralPath $uninstaller -PathType Leaf)) {
    throw "csc.exe returned success but did not create $uninstaller"
}

$key = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\Coding Tools MCP'
New-Item -Path $key -Force | Out-Null
New-ItemProperty -Path $key -Name DisplayName -Value 'Coding Tools MCP' -PropertyType String -Force | Out-Null
New-ItemProperty -Path $key -Name DisplayVersion -Value '0.4.11' -PropertyType String -Force | Out-Null
New-ItemProperty -Path $key -Name InstallLocation -Value ('"' + $install + '"') -PropertyType String -Force | Out-Null
New-ItemProperty -Path $key -Name UninstallString -Value ('"' + $uninstaller + '"') -PropertyType String -Force | Out-Null

$fixtureRecord = @(
    'LEGACY_FIXTURE_READY',
    "compiler=$csc",
    "install=$install",
    "marker=$marker",
    "trash=$TrashPath"
) -join "`n"
Set-Content -LiteralPath (Join-Path $RootPath 'fixture.txt') -Value $fixtureRecord -Encoding UTF8
Write-Output $fixtureRecord
