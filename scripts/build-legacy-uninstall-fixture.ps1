[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string] $SourcePath,

    [Parameter(Mandatory = $true)]
    [string] $OutputPath
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$repositoryRoot = Split-Path -Parent $PSScriptRoot
$buildRoot = Join-Path $repositoryRoot 'aiTemp\installer-upgrade\legacy-uninstall-fixture-build'
$projectRoot = Join-Path $buildRoot ([Guid]::NewGuid().ToString('N'))
$publishRoot = Join-Path $projectRoot 'publish'
$projectPath = Join-Path $projectRoot 'LegacyUninstallFixture.csproj'
$programPath = Join-Path $projectRoot 'Program.cs'
$publishedExecutable = Join-Path $publishRoot 'LegacyUninstallFixture.exe'
$evidencePath = Join-Path $projectRoot 'build-result.txt'

if (-not (Test-Path -LiteralPath $SourcePath -PathType Leaf)) {
    throw "Legacy fixture source was not found: $SourcePath"
}
if (Test-Path -LiteralPath $OutputPath) {
    throw "Legacy fixture output already exists: $OutputPath"
}

New-Item -ItemType Directory -Path $projectRoot -Force | Out-Null
New-Item -ItemType Directory -Path $publishRoot -Force | Out-Null
Copy-Item -LiteralPath $SourcePath -Destination $programPath

@'
<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <OutputType>Exe</OutputType>
    <TargetFramework>net8.0</TargetFramework>
    <RuntimeIdentifier>win-x64</RuntimeIdentifier>
    <SelfContained>false</SelfContained>
    <PublishSingleFile>true</PublishSingleFile>
    <UseAppHost>true</UseAppHost>
    <DebugType>none</DebugType>
    <DebugSymbols>false</DebugSymbols>
    <AssemblyName>LegacyUninstallFixture</AssemblyName>
    <RootNamespace>LegacyUninstallFixtureBuild</RootNamespace>
    <ImplicitUsings>disable</ImplicitUsings>
    <Nullable>disable</Nullable>
  </PropertyGroup>
</Project>
'@ | Set-Content -LiteralPath $projectPath -Encoding utf8

& dotnet publish $projectPath `
    --configuration Release `
    --runtime win-x64 `
    --self-contained false `
    -p:SelfContained=false `
    -p:PublishSingleFile=true `
    -p:UseAppHost=true `
    -p:DebugType=None `
    -p:DebugSymbols=false `
    --output $publishRoot
if ($LASTEXITCODE -ne 0) {
    throw "dotnet publish failed with exit code $LASTEXITCODE"
}

if (-not (Test-Path -LiteralPath $publishedExecutable -PathType Leaf)) {
    throw "Published fixture executable was not produced: $publishedExecutable"
}

$outputParent = Split-Path -Parent $OutputPath
if ([string]::IsNullOrWhiteSpace($outputParent)) {
    throw "Output path must include a parent directory: $OutputPath"
}
New-Item -ItemType Directory -Path $outputParent -Force | Out-Null
if (Test-Path -LiteralPath $OutputPath) {
    throw "Legacy fixture output appeared before publication: $OutputPath"
}
Copy-Item -LiteralPath $publishedExecutable -Destination $OutputPath

if (-not (Test-Path -LiteralPath $OutputPath -PathType Leaf)) {
    throw "Legacy fixture output was not copied: $OutputPath"
}

$hash = (Get-FileHash -Algorithm SHA256 -LiteralPath $OutputPath).Hash.ToLowerInvariant()
@(
    "source=$SourcePath"
    "project=$projectPath"
    "published=$publishedExecutable"
    "output=$OutputPath"
    "sha256=$hash"
) | Set-Content -LiteralPath $evidencePath -Encoding utf8

Write-Host "LEGACY_FIXTURE_BUILD_OK output=$OutputPath sha256=$hash evidence=$evidencePath"
