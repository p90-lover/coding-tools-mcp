[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string] $InstallerPath,

    [Parameter(Mandatory = $true)]
    [string] $TrashRoot,

    [Parameter(Mandatory = $true)]
    [string] $EvidenceRoot
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$workspace = $env:GITHUB_WORKSPACE
if ([String]::IsNullOrWhiteSpace($workspace)) { throw 'GITHUB_WORKSPACE is required' }
if (-not (Test-Path -LiteralPath $InstallerPath -PathType Leaf)) { throw "installer is missing: $InstallerPath" }
New-Item -ItemType Directory -Path $TrashRoot -Force | Out-Null
New-Item -ItemType Directory -Path $EvidenceRoot -Force | Out-Null

# PowerShell's process-tree wait includes descendants. electron-builder
# runAfterFinish launches Coding Tools.exe, which would keep the gate blocked
# until the GUI/tray app exits. WaitForExit(ms) waits for the installer PID
# only. Smoke already installed once; leftover Coding Tools.exe then blocks
# the upgrade installer.
$installerTimeoutMilliseconds = 45 * 60 * 1000
$harnessTimeoutMilliseconds = 10 * 60 * 1000

function Stop-CodingToolsLeftovers {
    param([int[]] $KeepProcessIds = @())
    $keep = @{}
    foreach ($id in $KeepProcessIds) { $keep[$id] = $true }
    Get-CimInstance -ClassName Win32_Process -ErrorAction SilentlyContinue |
        Where-Object {
            $_.ProcessId -and
            -not $keep.ContainsKey([int]$_.ProcessId) -and
            (
                $_.Name -eq 'Coding Tools.exe' -or
                $_.Name -like 'Coding.Tools_*setup.exe' -or
                ($_.CommandLine -and (
                    $_.CommandLine -like '*Coding Tools.exe*' -or
                    $_.CommandLine -like '*Coding.Tools_*setup*'
                ))
            )
        } |
        ForEach-Object {
            Write-Host "Stopping leftover $($_.Name) pid=$($_.ProcessId)"
            Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
        }
}

function Invoke-BoundedSilentProcess {
    param(
        [Parameter(Mandatory = $true)]
        [string] $FilePath,
        [Parameter(Mandatory = $true)]
        [string[]] $ArgumentList,
        [Parameter(Mandatory = $true)]
        [int] $TimeoutMilliseconds,
        [Parameter(Mandatory = $true)]
        [string] $Label
    )
    Stop-CodingToolsLeftovers
    $snapshotName = ($Label -replace '[^A-Za-z0-9]+', '-').ToLowerInvariant()
    Get-CimInstance -ClassName Win32_Process -ErrorAction SilentlyContinue |
        Select-Object ProcessId, Name, CommandLine |
        ConvertTo-Json -Depth 3 |
        Set-Content -LiteralPath (Join-Path $EvidenceRoot "process-snapshot-$snapshotName.json") -Encoding UTF8
    Write-Host "Starting $Label (timeout ${TimeoutMilliseconds}ms, process-only wait)"
    $process = Start-Process -FilePath $FilePath -ArgumentList $ArgumentList -PassThru
    if ($null -eq $process) { throw "$Label did not start" }
    $exited = $process.WaitForExit($TimeoutMilliseconds)
    if (-not $exited) {
        Write-Host "$Label still running after timeout; stopping installer and leftovers"
        Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue
        Stop-CodingToolsLeftovers
        throw "$Label timed out after $TimeoutMilliseconds ms"
    }
    [void]$process.WaitForExit()
    Stop-CodingToolsLeftovers -KeepProcessIds @($process.Id)
    return $process
}

$legacyRoot = Join-Path $workspace 'aiTemp\installer-upgrade\legacy-uninstall-fixture'
$legacyTrash = Join-Path $TrashRoot 'legacy-uninstall-fixture'
& (Join-Path $workspace 'desktop-electron\scripts\create-legacy-uninstall-fixture.ps1') `
    -RootPath $legacyRoot `
    -TrashPath $legacyTrash `
    | Tee-Object -FilePath (Join-Path $EvidenceRoot 'legacy-uninstall-fixture.txt')

$legacyInstall = Join-Path $legacyRoot 'Coding Tools MCP'
$legacyMarker = Join-Path $legacyRoot 'legacy-uninstaller-ran.txt'
$env:CODING_TOOLS_LEGACY_UNINSTALL_MARKER = $legacyMarker
$env:CODING_TOOLS_LEGACY_INSTALL_LOCATION = $legacyInstall
$env:CODING_TOOLS_LEGACY_TRASH_DIR = $legacyTrash
$installProcess = Invoke-BoundedSilentProcess `
    -FilePath $InstallerPath `
    -ArgumentList @('/S', '/currentuser') `
    -TimeoutMilliseconds $installerTimeoutMilliseconds `
    -Label 'rc.11 installer'
if ($installProcess.ExitCode -ne 0) { throw "rc.11 installer failed with exit code $($installProcess.ExitCode)" }
if (-not (Test-Path -LiteralPath $legacyMarker)) { throw 'legacy NSIS uninstaller was not executed' }
if (Test-Path -LiteralPath (Join-Path $legacyInstall 'legacy-app.bin')) { throw 'legacy payload remains in the old installation' }
if (-not (Test-Path -LiteralPath (Join-Path $legacyTrash 'legacy-app.bin'))) { throw 'legacy payload was not retained' }
if (-not (Test-Path -LiteralPath (Join-Path $legacyTrash 'uninstall.exe'))) { throw 'legacy uninstaller was not retained' }
if (Test-Path -LiteralPath 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\Coding Tools MCP') {
    throw 'legacy NSIS registration remains after migration'
}

$currentKey = 'HKCU:\Software\3cb2ea96-3319-55b8-95a5-7f180a5f3ed4'
$currentLocation = (Get-ItemPropertyValue -Path $currentKey -Name InstallLocation).Trim('"')
$currentApplication = Join-Path $currentLocation 'Coding Tools.exe'
if (-not (Test-Path -LiteralPath $currentApplication -PathType Leaf)) { throw "installed application is missing: $currentApplication" }

[ordered]@{
    sourceSha = $env:SOURCE_SHA
    installer = $InstallerPath
    installerExitCode = $installProcess.ExitCode
    legacyUninstallerRan = $true
    legacyRegistryRemoved = $true
    legacyPayloadPreserved = $true
    legacyUninstallerPreserved = $true
    currentInstallLocation = $currentLocation
    currentApplication = $currentApplication
} | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath (Join-Path $EvidenceRoot 'installer-upgrade-migration.json') -Encoding UTF8

choco install nsis --no-progress -y | Tee-Object -FilePath (Join-Path $EvidenceRoot 'nsis-install.txt')
if ($LASTEXITCODE -ne 0) { throw "NSIS installation failed with exit code $LASTEXITCODE" }

$msiRoot = Join-Path $workspace 'aiTemp\legacy-msi-upgrade\fixture'
$msiTrash = Join-Path $TrashRoot 'legacy-msi-upgrade'
$installerInclude = Join-Path $workspace 'desktop-electron\build\installer.nsh'
& (Join-Path $workspace 'desktop-electron\scripts\create-legacy-msi-upgrade-fixture.ps1') `
    -RootPath $msiRoot `
    -TrashPath $msiTrash `
    -InstallerIncludePath $installerInclude `
    | Tee-Object -FilePath (Join-Path $EvidenceRoot 'legacy-msi-fixture.txt')

$searchRoots = @(
    (Join-Path ${env:ProgramFiles(x86)} 'NSIS'),
    (Join-Path $env:ProgramFiles 'NSIS'),
    (Join-Path $env:ChocolateyInstall 'bin')
) | Where-Object { -not [String]::IsNullOrWhiteSpace($_) -and (Test-Path -LiteralPath $_) }
$makensis = $searchRoots |
    ForEach-Object { Get-ChildItem -LiteralPath $_ -Filter 'makensis.exe' -File -Recurse -ErrorAction SilentlyContinue } |
    Select-Object -First 1
if ($null -eq $makensis) { throw 'makensis.exe was not found after installing NSIS' }
$harnessSource = Join-Path $msiRoot 'legacy-msi-upgrade-harness.nsi'
& $makensis.FullName '/V4' $harnessSource | Tee-Object -FilePath (Join-Path $EvidenceRoot 'legacy-msi-makensis.txt')
if ($LASTEXITCODE -ne 0) { throw "makensis.exe failed with exit code $LASTEXITCODE" }

$msiMarker = Join-Path $msiRoot 'legacy-msiexec-ran.txt'
$msiPayload = Join-Path $msiRoot 'legacy-msi-payload.bin'
$retainedMsiPayload = Join-Path $msiTrash 'legacy-msi-payload.bin'
$env:CODING_TOOLS_LEGACY_MSI_MARKER = $msiMarker
$env:CODING_TOOLS_LEGACY_MSI_PAYLOAD = $msiPayload
$env:CODING_TOOLS_LEGACY_MSI_RETAINED_PAYLOAD = $retainedMsiPayload
$harness = Join-Path $msiRoot 'legacy-msi-upgrade-harness.exe'
$msiProcess = Invoke-BoundedSilentProcess `
    -FilePath $harness `
    -ArgumentList @('/S') `
    -TimeoutMilliseconds $harnessTimeoutMilliseconds `
    -Label 'rc.11 MSI migration harness'
$markerText = if (Test-Path -LiteralPath $msiMarker) { Get-Content -LiteralPath $msiMarker -Raw } else { '<missing>' }

$baseKey = [Microsoft.Win32.RegistryKey]::OpenBaseKey(
    [Microsoft.Win32.RegistryHive]::CurrentUser,
    [Microsoft.Win32.RegistryView]::Registry64
)
try {
    $remaining = $baseKey.OpenSubKey('Software\Microsoft\Windows\CurrentVersion\Uninstall\{11111111-2222-3333-4444-555555555555}')
    $registryRemaining = $null -ne $remaining
    if ($null -ne $remaining) { $remaining.Dispose() }
}
finally {
    $baseKey.Dispose()
}

if ($msiProcess.ExitCode -ne 0) { throw "MSI migration harness failed with exit code $($msiProcess.ExitCode)" }
if ($markerText -notmatch 'LEGACY_MSIEXEC_RAN' -or $markerText -notmatch '/x' -or $markerText -notmatch '/qn' -or $markerText -notmatch '/norestart') {
    throw "legacy MSI invocation is incomplete: $markerText"
}
if (Test-Path -LiteralPath $msiPayload) { throw 'legacy MSI payload remains in the old location' }
if (-not (Test-Path -LiteralPath $retainedMsiPayload)) { throw 'legacy MSI payload was not retained' }
if ($registryRemaining) { throw 'legacy MSI registration remains after migration' }

[ordered]@{
    sourceSha = $env:SOURCE_SHA
    harnessExitCode = $msiProcess.ExitCode
    marker = $markerText.Trim()
    oldPayloadExists = Test-Path -LiteralPath $msiPayload
    retainedPayloadExists = Test-Path -LiteralPath $retainedMsiPayload
    registryRemaining = $registryRemaining
} | ConvertTo-Json -Depth 3 | Set-Content -LiteralPath (Join-Path $EvidenceRoot 'legacy-msi-production-macro.json') -Encoding UTF8

Write-Output 'RC10_WINDOWS_MIGRATION_ACCEPTANCE_OK'
