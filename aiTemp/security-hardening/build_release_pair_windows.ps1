$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

function Assert-LastExitCode([string]$Label) {
    if ($LASTEXITCODE -ne 0) {
        throw "$Label failed with exit code $LASTEXITCODE"
    }
}

function Invoke-Checked([scriptblock]$Command, [string]$Label) {
    & $Command
    Assert-LastExitCode $Label
}

function Write-ChecksumManifest([string]$Directory, [string]$Pattern, [string]$ManifestName) {
    $files = @(Get-ChildItem -Path (Join-Path $Directory $Pattern) -File)
    if ($files.Count -lt 1) {
        throw "No release files matched $Pattern in $Directory"
    }
    $lines = foreach ($file in $files) {
        $hash = (Get-FileHash -Algorithm SHA256 $file.FullName).Hash.ToLowerInvariant()
        "$hash  $($file.Name)"
    }
    $lines | Set-Content -Encoding ascii (Join-Path $Directory $ManifestName)
}

$required = @("BASE_SHA", "SOURCE_SHA", "RC2_TREE", "PATCH_SHA256", "GITHUB_WORKSPACE")
foreach ($name in $required) {
    $value = [Environment]::GetEnvironmentVariable($name)
    if ([string]::IsNullOrWhiteSpace($value)) {
        throw "Missing required environment variable $name"
    }
}

$workspace = $env:GITHUB_WORKSPACE
$patchPath = Join-Path $workspace "aiTemp/security-hardening/final-verified/hardened-rc2.patch"
if (-not (Test-Path -LiteralPath $patchPath -PathType Leaf)) {
    throw "Verified RC2 patch is missing"
}
$actualPatch = (Get-FileHash -Algorithm SHA256 $patchPath).Hash.ToLowerInvariant()
if ($actualPatch -ne $env:PATCH_SHA256.ToLowerInvariant()) {
    throw "RC2 patch checksum mismatch"
}

$head = (git rev-parse HEAD).Trim()
Assert-LastExitCode "read checkout HEAD"
if ($head -ne $env:BASE_SHA) {
    throw "Windows checkout drifted from the pinned base SHA"
}

$rc1Worktree = Join-Path $workspace "aiTemp/rc1-source-windows"
Invoke-Checked { git worktree add --detach $rc1Worktree $env:SOURCE_SHA } "create RC1 worktree"

$originalTarget = $env:CARGO_TARGET_DIR
try {
    $env:CARGO_TARGET_DIR = Join-Path $workspace "aiTemp/cargo-target-final-windows/rc1"
    Push-Location $rc1Worktree
    try {
        New-Item -ItemType Directory -Force -Path "aiTemp/npm-cache" | Out-Null
        Invoke-Checked { npm ci --cache aiTemp/npm-cache } "install RC1 frontend dependencies"
        Invoke-Checked { npm run check } "check RC1 frontend"
        Invoke-Checked { node --test tests/*.test.mjs } "run RC1 Node tests"
        Push-Location "src-tauri"
        try {
            Invoke-Checked { cargo fmt --all -- --check } "check RC1 Rust formatting"
            Invoke-Checked { cargo test --locked } "run RC1 Rust tests"
            Invoke-Checked { cargo clippy --locked --all-targets -- -D warnings } "run RC1 strict Clippy"
        }
        finally {
            Pop-Location
        }
        Invoke-Checked { npm run tauri -- build --bundles nsis } "build RC1 NSIS installer"
    }
    finally {
        Pop-Location
    }

    $rc1Output = Join-Path $env:CARGO_TARGET_DIR "release/bundle/nsis"
    $rc1Assets = Join-Path $workspace "aiTemp/release-assets/rc1/windows"
    New-Item -ItemType Directory -Force -Path $rc1Assets | Out-Null
    $rc1Files = @(Get-ChildItem -Path (Join-Path $rc1Output "*.exe") -File)
    if ($rc1Files.Count -lt 1) {
        throw "RC1 Windows installer was not produced in the pinned target directory"
    }
    Copy-Item -LiteralPath $rc1Files.FullName -Destination $rc1Assets
    Write-ChecksumManifest $rc1Assets "*.exe" "SHA256SUMS-windows.txt"

    Set-Location $workspace
    Invoke-Checked { git apply --index --binary $patchPath } "apply exact RC2 patch"
    $indexedTree = (git write-tree).Trim()
    Assert-LastExitCode "write RC2 tree"
    if ($indexedTree -ne $env:RC2_TREE) {
        throw "Windows indexed RC2 tree does not match the Linux-prepared tree"
    }
    $deleted = git diff --cached --name-status | Select-String '^D'
    Assert-LastExitCode "inspect RC2 staged paths"
    if ($deleted) {
        throw "RC2 patch deletes a file"
    }

    $env:CARGO_TARGET_DIR = Join-Path $workspace "aiTemp/cargo-target-final-windows/rc2"
    New-Item -ItemType Directory -Force -Path "aiTemp/npm-cache" | Out-Null
    Invoke-Checked { npm ci --cache aiTemp/npm-cache } "install RC2 frontend dependencies"
    Invoke-Checked { npm run check } "check RC2 frontend"
    Invoke-Checked { node --test tests/*.test.mjs } "run RC2 Node tests"
    Push-Location "src-tauri"
    try {
        Invoke-Checked { cargo fmt --all -- --check } "check RC2 Rust formatting"
        Invoke-Checked { cargo test --locked } "run RC2 Rust tests"
        Invoke-Checked { cargo clippy --locked --all-targets -- -D warnings } "run RC2 strict Clippy"
    }
    finally {
        Pop-Location
    }
    Invoke-Checked { npm run tauri -- build --bundles nsis } "build RC2 NSIS installer"

    $rc2Output = Join-Path $env:CARGO_TARGET_DIR "release/bundle/nsis"
    $rc2Assets = Join-Path $workspace "aiTemp/release-assets/rc2/windows"
    New-Item -ItemType Directory -Force -Path $rc2Assets | Out-Null
    $rc2Files = @(Get-ChildItem -Path (Join-Path $rc2Output "*.exe") -File)
    if ($rc2Files.Count -lt 1) {
        throw "RC2 Windows installer was not produced in the pinned target directory"
    }
    Copy-Item -LiteralPath $rc2Files.FullName -Destination $rc2Assets
    Write-ChecksumManifest $rc2Assets "*.exe" "SHA256SUMS-windows.txt"
}
finally {
    $env:CARGO_TARGET_DIR = $originalTarget
}

Write-Host "Windows RC1 and exact-tree RC2 validation/build completed successfully"
