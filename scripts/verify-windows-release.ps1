[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [string]$InstallerPath,
  [Parameter(Mandatory = $true)]
  [string]$ExpectedPublisherThumbprint,
  [string]$ReleaseRoot,
  [string]$DesktopRuntimeRoot,
  [string]$TargetTriple = 'x86_64-pc-windows-msvc'
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$repositoryRoot = Split-Path -Parent $PSScriptRoot
if (-not $ReleaseRoot) {
  $ReleaseRoot = Join-Path $repositoryRoot 'target\release'
}
if (-not $DesktopRuntimeRoot) {
  $DesktopRuntimeRoot = Join-Path $repositoryRoot 'target\desktop-runtime'
}

$expectedThumbprint = ($ExpectedPublisherThumbprint -replace '\s', '').ToUpperInvariant()
if ($expectedThumbprint -notmatch '^[A-F0-9]{40,64}$') {
  throw 'ExpectedPublisherThumbprint must contain 40-64 hexadecimal characters.'
}

function Assert-AuthenticodeSignature {
  param(
    [Parameter(Mandatory = $true)][string]$Label,
    [Parameter(Mandatory = $true)][string]$Path,
    [switch]$ProjectOwned,
    [switch]$RequireTimestamp
  )

  $resolvedPath = Resolve-Path -LiteralPath $Path -ErrorAction Stop
  $signature = Get-AuthenticodeSignature -LiteralPath $resolvedPath.Path
  if ($signature.Status -ne 'Valid') {
    throw "${Label} is not validly signed (status=$($signature.Status)): '$($resolvedPath.Path)'."
  }
  if ($ProjectOwned) {
    $actualThumbprint = ([string]$signature.SignerCertificate.Thumbprint -replace '\s', '').ToUpperInvariant()
    if ($actualThumbprint -ne $expectedThumbprint) {
      throw "${Label} is signed by an unapproved publisher: '$($resolvedPath.Path)'."
    }
  }
  if ($RequireTimestamp -and $null -eq $signature.TimeStamperCertificate) {
    throw "${Label} has no trusted timestamp: '$($resolvedPath.Path)'."
  }
  Write-Output "[PASS] ${Label}: valid signature and approved release policy."
}

$installer = (Resolve-Path -LiteralPath $InstallerPath -ErrorAction Stop).Path
$projectArtifacts = @(
  @{ Label = 'Desktop executable'; Path = (Join-Path $ReleaseRoot 'scamatic-desktop.exe') },
  @{ Label = 'Packaged runtime service'; Path = (Join-Path $repositoryRoot "src-tauri\binaries\scamatic-runtime-service-$TargetTriple.exe") },
  @{ Label = 'Packaged Isaac data-plane'; Path = (Join-Path $DesktopRuntimeRoot 'scamatic-data-plane.exe') },
  @{ Label = 'NSIS installer'; Path = $installer }
)

Write-Output 'SCAMATIC Windows release signature gate'
foreach ($artifact in $projectArtifacts) {
  Assert-AuthenticodeSignature -Label $artifact.Label -Path $artifact.Path -ProjectOwned -RequireTimestamp
}
Assert-AuthenticodeSignature -Label 'Packaged Node runtime' -Path (Join-Path $DesktopRuntimeRoot 'node.exe')
Write-Output '[PASS] Release signature gate completed.'
