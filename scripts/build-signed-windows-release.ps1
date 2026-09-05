[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [string]$ExpectedPublisherThumbprint,
  [Parameter(Mandatory = $true)]
  [string]$TimestampUrl,
  [string]$SignToolPath
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

if ($env:OS -ne 'Windows_NT') {
  throw 'Signed Windows releases must be built on Windows.'
}

$repositoryRoot = Split-Path -Parent $PSScriptRoot
$expectedThumbprint = ($ExpectedPublisherThumbprint -replace '\s', '').ToUpperInvariant()
if ($expectedThumbprint -notmatch '^[A-F0-9]{40,64}$') {
  throw 'ExpectedPublisherThumbprint must contain 40-64 hexadecimal characters.'
}

$timestampUri = $null
if (-not [Uri]::TryCreate($TimestampUrl, [UriKind]::Absolute, [ref]$timestampUri) -or
    $timestampUri.Scheme -notin @('http', 'https')) {
  throw 'TimestampUrl must be an absolute HTTP or HTTPS URL supplied by the certificate authority.'
}

function Invoke-CheckedCommand {
  param(
    [Parameter(Mandatory = $true)][string]$FilePath,
    [Parameter(Mandatory = $true)][string[]]$ArgumentList,
    [Parameter(Mandatory = $true)][string]$Label
  )

  Write-Output "[RUN] $Label"
  & $FilePath @ArgumentList
  if ($LASTEXITCODE -ne 0) {
    throw "$Label failed with exit code $LASTEXITCODE."
  }
}

function Resolve-SigningCertificate {
  param([Parameter(Mandatory = $true)][string]$Thumbprint)

  $codeSigningOid = '1.3.6.1.5.5.7.3.3'
  $certificatePath = Join-Path 'Cert:\CurrentUser\My' $Thumbprint
  if (-not (Test-Path -LiteralPath $certificatePath)) {
    throw "Publisher certificate '$Thumbprint' was not found in CurrentUser\My."
  }

  $certificate = Get-Item -LiteralPath $certificatePath
  if (-not $certificate.HasPrivateKey) {
    throw "Publisher certificate '$Thumbprint' does not have an accessible private key."
  }
  if ($certificate.NotBefore.ToUniversalTime() -gt [DateTime]::UtcNow -or
      $certificate.NotAfter.ToUniversalTime() -le [DateTime]::UtcNow) {
    throw "Publisher certificate '$Thumbprint' is not currently valid."
  }
  $ekuOids = @($certificate.EnhancedKeyUsageList | ForEach-Object { $_.ObjectId.Value })
  if ($ekuOids -notcontains $codeSigningOid) {
    throw "Publisher certificate '$Thumbprint' is not authorized for code signing."
  }

  return $certificate
}

function Resolve-SignTool {
  param([string]$ConfiguredPath)

  if ($ConfiguredPath) {
    return (Resolve-Path -LiteralPath $ConfiguredPath -ErrorAction Stop).Path
  }

  $command = Get-Command 'signtool.exe' -ErrorAction SilentlyContinue
  if ($command) { return $command.Source }

  $kitRoots = @(
    (Join-Path ${env:ProgramFiles(x86)} 'Windows Kits\10\bin'),
    (Join-Path $env:ProgramFiles 'Windows Kits\10\bin')
  ) | Where-Object { $_ -and (Test-Path -LiteralPath $_) } | Select-Object -Unique

  $candidates = foreach ($kitRoot in $kitRoots) {
    Get-ChildItem -LiteralPath $kitRoot -Filter 'signtool.exe' -Recurse -File -ErrorAction SilentlyContinue |
      Where-Object { $_.DirectoryName -match '[\\/]x64$' }
  }
  $selected = $candidates | Sort-Object -Property FullName -Descending | Select-Object -First 1
  if (-not $selected) {
    throw 'signtool.exe was not found. Install the Windows SDK or pass -SignToolPath.'
  }
  return $selected.FullName
}

function Add-AuthenticodeSignature {
  param(
    [Parameter(Mandatory = $true)][string]$Path,
    [Parameter(Mandatory = $true)][string]$Label,
    [Parameter(Mandatory = $true)][string]$ToolPath,
    [Parameter(Mandatory = $true)][string]$Thumbprint,
    [Parameter(Mandatory = $true)][string]$Timestamp
  )

  $resolvedPath = (Resolve-Path -LiteralPath $Path -ErrorAction Stop).Path
  $arguments = @('sign', '/s', 'My', '/sha1', $Thumbprint, '/fd', 'sha256', '/tr', $Timestamp, '/td', 'sha256', '/v', $resolvedPath)
  Invoke-CheckedCommand -FilePath $ToolPath -ArgumentList $arguments -Label "Sign $Label"
}

function Set-JsonProperty {
  param(
    [Parameter(Mandatory = $true)][object]$Object,
    [Parameter(Mandatory = $true)][string]$Name,
    [Parameter(Mandatory = $true)][object]$Value
  )

  $Object | Add-Member -MemberType NoteProperty -Name $Name -Value $Value -Force
}

$signingCertificate = Resolve-SigningCertificate -Thumbprint $expectedThumbprint
$resolvedSignTool = Resolve-SignTool -ConfiguredPath $SignToolPath
$npmCommand = (Get-Command 'npm.cmd' -ErrorAction Stop).Source
$cargoCommand = (Get-Command 'cargo.exe' -ErrorAction Stop).Source
$tauriCommand = Join-Path $repositoryRoot 'node_modules\.bin\tauri.cmd'
if (-not (Test-Path -LiteralPath $tauriCommand)) {
  throw "Tauri CLI is missing at '$tauriCommand'; run npm ci first."
}

$serviceExecutable = Join-Path $repositoryRoot 'target\release\scamatic-runtime-service.exe'
$isaacExecutable = Join-Path $repositoryRoot 'target\release\scamatic-data-plane.exe'
$localConfigurationPath = Join-Path $repositoryRoot 'src-tauri\tauri.local.conf.json'
$generatedConfigurationPath = Join-Path $repositoryRoot 'target\tauri.signed-release.conf.json'
$installerDirectory = Join-Path $repositoryRoot 'target\release\bundle\nsis'
$buildStartedAt = [DateTime]::UtcNow
$locationPushed = $false

try {
  Push-Location $repositoryRoot
  $locationPushed = $true
  Invoke-CheckedCommand -FilePath $npmCommand -ArgumentList @('run', 'build') -Label 'Build frontend'
  Invoke-CheckedCommand -FilePath $cargoCommand -ArgumentList @('build', '--locked', '--release', '-p', 'scamatic-data-plane', '-p', 'scamatic-runtime-service') -Label 'Build Windows runtime binaries'

  Add-AuthenticodeSignature -Path $serviceExecutable -Label 'runtime service' -ToolPath $resolvedSignTool -Thumbprint $expectedThumbprint -Timestamp $TimestampUrl
  Add-AuthenticodeSignature -Path $isaacExecutable -Label 'Isaac data-plane' -ToolPath $resolvedSignTool -Thumbprint $expectedThumbprint -Timestamp $TimestampUrl

  Invoke-CheckedCommand -FilePath $npmCommand -ArgumentList @('run', 'desktop:prepare-runtime') -Label 'Stage signed runtime bundle'

  $releaseConfiguration = Get-Content -LiteralPath $localConfigurationPath -Raw | ConvertFrom-Json
  Set-JsonProperty -Object $releaseConfiguration.bundle.windows -Name 'certificateThumbprint' -Value $expectedThumbprint
  Set-JsonProperty -Object $releaseConfiguration.bundle.windows -Name 'digestAlgorithm' -Value 'sha256'
  Set-JsonProperty -Object $releaseConfiguration.bundle.windows -Name 'timestampUrl' -Value $TimestampUrl
  $configurationJson = $releaseConfiguration | ConvertTo-Json -Depth 20
  $utf8WithoutBom = New-Object System.Text.UTF8Encoding($false)
  [IO.File]::WriteAllText($generatedConfigurationPath, "$configurationJson`n", $utf8WithoutBom)

  Invoke-CheckedCommand -FilePath $tauriCommand -ArgumentList @(
    'build', '--ci', '--features', 'local-runtime', '--bundles', 'nsis', '--config', $generatedConfigurationPath
  ) -Label 'Build and sign Tauri Desktop and NSIS installer'

  $installers = @(Get-ChildItem -LiteralPath $installerDirectory -Filter '*-setup.exe' -File |
    Where-Object { $_.LastWriteTimeUtc -ge $buildStartedAt.AddSeconds(-2) })
  if ($installers.Count -ne 1) {
    throw "Expected exactly one freshly built NSIS installer, found $($installers.Count) in '$installerDirectory'."
  }
  $installerPath = $installers[0].FullName

  & (Join-Path $PSScriptRoot 'verify-windows-release.ps1') `
    -InstallerPath $installerPath `
    -ExpectedPublisherThumbprint $expectedThumbprint

  $installerHash = (Get-FileHash -LiteralPath $installerPath -Algorithm SHA256).Hash.ToLowerInvariant()
  $checksumPath = "$installerPath.sha256"
  [IO.File]::WriteAllText($checksumPath, "$installerHash  $($installers[0].Name)`n", $utf8WithoutBom)

  Write-Output "[PASS] Signed release is ready: $installerPath"
  Write-Output "[PASS] SHA-256 checksum: $checksumPath"
}
finally {
  if ($locationPushed) { Pop-Location }
  if (Test-Path -LiteralPath $generatedConfigurationPath) {
    Remove-Item -LiteralPath $generatedConfigurationPath -Force
  }
}
