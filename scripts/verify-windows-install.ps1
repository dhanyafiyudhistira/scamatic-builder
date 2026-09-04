[CmdletBinding()]
param(
  [string]$ServiceName = 'SCAMATICRuntime',
  [string]$BaseUri = 'http://127.0.0.1:3001',
  [string]$ProgramDataRoot = (Join-Path $env:ProgramData 'SCAMATIC'),
  [ValidateRange(1, 60)]
  [int]$TimeoutSeconds = 10,
  [switch]$RequireSignature,
  [string]$InstallerPath,
  [string]$ExpectedPublisherThumbprint,
  [switch]$Json
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$script:Results = New-Object 'System.Collections.Generic.List[object]'

function Add-CheckResult {
  param(
    [Parameter(Mandatory = $true)][string]$Name,
    [Parameter(Mandatory = $true)][ValidateSet('PASS', 'WARN', 'FAIL')][string]$Status,
    [Parameter(Mandatory = $true)][string]$Detail
  )

  $script:Results.Add([pscustomobject]@{
    name = $Name
    status = $Status
    detail = $Detail
  })
}

function Add-AuthenticodeCheck {
  param(
    [Parameter(Mandatory = $true)][string]$Name,
    [Parameter(Mandatory = $true)][string]$Path,
    [switch]$ProjectOwned
  )

  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
    Add-CheckResult $Name 'FAIL' "Executable is missing: '$Path'."
    return
  }

  try {
    $signature = Get-AuthenticodeSignature -LiteralPath $Path
    if ($signature.Status -ne 'Valid') {
      $status = if ($RequireSignature) { 'FAIL' } else { 'WARN' }
      Add-CheckResult $Name $status "Signature status is '$($signature.Status)' for '$Path'."
      return
    }

    if ($ProjectOwned -and $ExpectedPublisherThumbprint) {
      $actualThumbprint = StringOrEmpty $signature.SignerCertificate.Thumbprint
      $expectedThumbprint = ($ExpectedPublisherThumbprint -replace '\s', '').ToUpperInvariant()
      if ($actualThumbprint.ToUpperInvariant() -ne $expectedThumbprint) {
        Add-CheckResult $Name 'FAIL' "Signature is valid but does not match the approved publisher thumbprint."
        return
      }
    }

    Add-CheckResult $Name 'PASS' "Signature is valid ($($signature.SignerCertificate.Subject))."
  } catch {
    $status = if ($RequireSignature) { 'FAIL' } else { 'WARN' }
    Add-CheckResult $Name $status "Could not inspect signature: $($_.Exception.Message)"
  }
}

function StringOrEmpty {
  param($Value)
  if ($null -eq $Value) { return '' }
  return [string]$Value
}

function Resolve-IdentitySid {
  param([Parameter(Mandatory = $true)][string]$Identity)

  if ($Identity -match '^S-\d(?:-\d+)+$') {
    return $Identity
  }

  try {
    $account = New-Object System.Security.Principal.NTAccount($Identity)
    return $account.Translate([System.Security.Principal.SecurityIdentifier]).Value
  } catch {
    return $null
  }
}

function Test-AclPermission {
  param(
    [Parameter(Mandatory = $true)]$Acl,
    [Parameter(Mandatory = $true)][string[]]$IdentityCandidates,
    [Parameter(Mandatory = $true)][System.Security.AccessControl.FileSystemRights]$RequiredRights
  )

  $candidateSids = @($IdentityCandidates | ForEach-Object { Resolve-IdentitySid $_ } | Where-Object { $_ })
  foreach ($rule in $Acl.Access) {
    if ($rule.AccessControlType -ne [System.Security.AccessControl.AccessControlType]::Allow) {
      continue
    }

    $ruleIdentity = $rule.IdentityReference.Value
    $ruleSid = Resolve-IdentitySid $ruleIdentity
    if (($IdentityCandidates -notcontains $ruleIdentity) -and ($candidateSids -notcontains $ruleSid)) {
      continue
    }

    $granted = [int64]$rule.FileSystemRights
    $required = [int64]$RequiredRights
    if (($granted -band $required) -eq $required) {
      return $true
    }
  }

  return $false
}

function Get-ServiceExecutablePath {
  param([Parameter(Mandatory = $true)][string]$PathName)

  if ($PathName -match '^"([^"]+)"(?:\s|$)') {
    return $Matches[1]
  }
  if ($PathName -match '^([^\s]+)') {
    return $Matches[1]
  }
  return $null
}

function Get-HealthProbeFailureDetail {
  param(
    [Parameter(Mandatory = $true)]$ErrorRecord,
    [Parameter(Mandatory = $true)][string]$Path
  )

  $statusCode = $null
  $responseBody = $null
  $responseProperty = $ErrorRecord.Exception.PSObject.Properties['Response']
  $response = if ($null -ne $responseProperty) { $responseProperty.Value } else { $null }
  if ($null -ne $response) {
    try {
      if ($null -ne $response.PSObject.Properties['StatusCode']) {
        $statusCode = [int]$response.StatusCode
      }
      if ($null -ne $response.PSObject.Properties['Content'] -and $null -ne $response.Content) {
        $responseBody = $response.Content.ReadAsStringAsync().GetAwaiter().GetResult()
      } elseif ($null -ne $response.PSObject.Methods['GetResponseStream']) {
        $stream = $response.GetResponseStream()
        if ($null -ne $stream) {
          $reader = New-Object System.IO.StreamReader($stream)
          try {
            $responseBody = $reader.ReadToEnd()
          } finally {
            $reader.Dispose()
          }
        }
      }
    } catch {
      $responseBody = $null
    }
  }
  if (-not $responseBody -and $null -ne $ErrorRecord.ErrorDetails) {
    $responseBody = $ErrorRecord.ErrorDetails.Message
  }

  if ($responseBody) {
    try {
      $payload = $responseBody | ConvertFrom-Json
      $safeParts = New-Object 'System.Collections.Generic.List[string]'
      foreach ($field in @('status', 'code', 'checked', 'compatible', 'incompatible', 'rotationRequired')) {
        $property = $payload.PSObject.Properties[$field]
        if ($null -ne $property) {
          $safeParts.Add(('{0}={1}' -f $field, $property.Value))
        }
      }
      if ($safeParts.Count -gt 0) {
        $httpLabel = if ($null -ne $statusCode) { "HTTP $statusCode" } else { 'an error response' }
        return "GET $Path returned $httpLabel ($($safeParts -join ', '))."
      }
    } catch {
      # Never include an unrecognized response body because it may contain sensitive data.
    }
  }

  if ($null -ne $statusCode) {
    return "GET $Path returned HTTP $statusCode."
  }
  return "GET $Path failed: $($ErrorRecord.Exception.Message)"
}

function Test-DescendantProcess {
  param(
    [Parameter(Mandatory = $true)][uint32]$ProcessId,
    [Parameter(Mandatory = $true)][uint32]$ExpectedAncestorId,
    [Parameter(Mandatory = $true)][hashtable]$ParentByProcessId
  )

  $current = $ProcessId
  $visited = @{}
  while ($current -ne 0 -and -not $visited.ContainsKey($current)) {
    if ($current -eq $ExpectedAncestorId) {
      return $true
    }
    $visited[$current] = $true
    if (-not $ParentByProcessId.ContainsKey($current)) {
      break
    }
    $current = [uint32]$ParentByProcessId[$current]
  }
  return $false
}

if ($env:OS -ne 'Windows_NT') {
  Add-CheckResult 'Platform' 'FAIL' 'This verifier must run on Windows.'
} else {
  Add-CheckResult 'Platform' 'PASS' "Windows verification host detected."
}

$isAdministrator = $false
try {
  $identity = [System.Security.Principal.WindowsIdentity]::GetCurrent()
  $principal = New-Object System.Security.Principal.WindowsPrincipal($identity)
  $isAdministrator = $principal.IsInRole([System.Security.Principal.WindowsBuiltInRole]::Administrator)
} catch {
  Add-CheckResult 'Elevation' 'WARN' "Could not determine elevation: $($_.Exception.Message)"
}
if ($isAdministrator) {
  Add-CheckResult 'Elevation' 'PASS' 'Running elevated; all ACL checks are available.'
} else {
  Add-CheckResult 'Elevation' 'WARN' 'Run PowerShell as Administrator for authoritative ACL results.'
}

$service = $null
if ($env:OS -eq 'Windows_NT') {
  try {
    $escapedServiceName = $ServiceName.Replace("'", "''")
    $service = Get-CimInstance -ClassName Win32_Service -Filter "Name='$escapedServiceName'"
    if ($null -eq $service) {
      Add-CheckResult 'Windows service' 'FAIL' "Service '$ServiceName' is not installed."
    } else {
      Add-CheckResult 'Windows service' 'PASS' "Service '$ServiceName' is installed."
    }
  } catch {
    Add-CheckResult 'Windows service' 'FAIL' "Service query failed: $($_.Exception.Message)"
  }
}

$serviceRegistry = $null
$serviceExecutable = $null
$runtimeRoot = $null
if ($null -ne $service) {
  if ($service.State -eq 'Running') {
    Add-CheckResult 'Service state' 'PASS' "Service is running with PID $($service.ProcessId)."
  } else {
    Add-CheckResult 'Service state' 'FAIL' "Expected Running, found '$($service.State)'."
  }

  if ($service.StartMode -eq 'Auto') {
    Add-CheckResult 'Automatic start' 'PASS' 'Service start mode is Automatic.'
  } else {
    Add-CheckResult 'Automatic start' 'FAIL' "Expected Automatic, found '$($service.StartMode)'."
  }

  $expectedServiceAccount = "NT SERVICE\$ServiceName"
  if ($service.StartName -ieq $expectedServiceAccount) {
    Add-CheckResult 'Service account' 'PASS' "Service runs as '$expectedServiceAccount'."
  } else {
    Add-CheckResult 'Service account' 'FAIL' "Expected '$expectedServiceAccount', found '$($service.StartName)'."
  }

  $serviceExecutable = Get-ServiceExecutablePath $service.PathName
  $pathIsSafelyQuoted = $service.PathName -match '^"[^"]+"\s+service\s*$'
  if ($pathIsSafelyQuoted) {
    Add-CheckResult 'Service command' 'PASS' 'Executable path is quoted and uses the service entrypoint.'
  } else {
    Add-CheckResult 'Service command' 'FAIL' "Unexpected or unsafe service command: $($service.PathName)"
  }

  if ($serviceExecutable -and (Test-Path -LiteralPath $serviceExecutable -PathType Leaf)) {
    Add-CheckResult 'Service executable' 'PASS' "Runtime service executable exists at '$serviceExecutable'."
    $runtimeRoot = Join-Path (Split-Path -Parent $serviceExecutable) 'resources\runtime'

  } else {
    Add-CheckResult 'Service executable' 'FAIL' "Configured executable was not found: '$serviceExecutable'."
  }

  try {
    $serviceRegistryPath = "HKLM:\SYSTEM\CurrentControlSet\Services\$ServiceName"
    $serviceRegistry = Get-ItemProperty -LiteralPath $serviceRegistryPath

    if ($serviceRegistry.Start -eq 2 -and $serviceRegistry.DelayedAutoStart -eq 1) {
      Add-CheckResult 'Delayed auto-start' 'PASS' 'Automatic (Delayed Start) is enabled.'
    } else {
      Add-CheckResult 'Delayed auto-start' 'FAIL' "Expected Start=2 and DelayedAutoStart=1."
    }

    if ($serviceRegistry.ServiceSidType -eq 1) {
      Add-CheckResult 'Service SID' 'PASS' 'Per-service SID type is unrestricted.'
    } else {
      Add-CheckResult 'Service SID' 'FAIL' "Expected ServiceSidType=1, found '$($serviceRegistry.ServiceSidType)'."
    }

    $hasRecoveryActions = $null -ne $serviceRegistry.FailureActions -and $serviceRegistry.FailureActions.Length -gt 0
    $handlesNonCrashFailure = $serviceRegistry.FailureActionsOnNonCrashFailures -eq 1
    if ($hasRecoveryActions -and $handlesNonCrashFailure) {
      Add-CheckResult 'Recovery policy' 'PASS' 'Recovery actions cover crash and non-crash failures.'
    } else {
      Add-CheckResult 'Recovery policy' 'FAIL' 'Required service recovery policy is incomplete.'
    }
  } catch {
    Add-CheckResult 'Service registry' 'FAIL' "Could not inspect service policy: $($_.Exception.Message)"
  }
}

$installDirectory = if ($serviceExecutable) { Split-Path -Parent $serviceExecutable } else { $null }
$normalizedExpectedPublisherThumbprint = ($ExpectedPublisherThumbprint -replace '\s', '')
if ($RequireSignature -and -not $ExpectedPublisherThumbprint) {
  Add-CheckResult 'Publisher policy' 'FAIL' 'Release signature validation requires -ExpectedPublisherThumbprint for project-owned binaries.'
} elseif ($ExpectedPublisherThumbprint -and $normalizedExpectedPublisherThumbprint -notmatch '^[A-Fa-f0-9]{40,64}$') {
  Add-CheckResult 'Publisher policy' 'FAIL' 'Expected publisher thumbprint must contain 40–64 hexadecimal characters.'
} elseif ($ExpectedPublisherThumbprint) {
  Add-CheckResult 'Publisher policy' 'PASS' 'An approved publisher thumbprint was supplied for project-owned binaries.'
}

if ($serviceExecutable) {
  Add-AuthenticodeCheck 'Service signature' $serviceExecutable -ProjectOwned
}
if ($installDirectory) {
  Add-AuthenticodeCheck 'Desktop signature' (Join-Path $installDirectory 'scamatic-desktop.exe') -ProjectOwned
  Add-AuthenticodeCheck 'Uninstaller signature' (Join-Path $installDirectory 'uninstall.exe') -ProjectOwned
}
if ($runtimeRoot) {
  Add-AuthenticodeCheck 'Isaac signature' (Join-Path $runtimeRoot 'scamatic-data-plane.exe') -ProjectOwned
  Add-AuthenticodeCheck 'Node runtime signature' (Join-Path $runtimeRoot 'node.exe')
}
if ($InstallerPath) {
  Add-AuthenticodeCheck 'Installer signature' $InstallerPath -ProjectOwned
} elseif ($RequireSignature) {
  Add-CheckResult 'Installer signature' 'FAIL' 'Release signature validation requires -InstallerPath.'
} else {
  Add-CheckResult 'Installer signature' 'WARN' 'Installer was not inspected; provide -InstallerPath for release validation.'
}

$configFile = Join-Path $ProgramDataRoot 'runtime.env'
$logDirectory = Join-Path $ProgramDataRoot 'logs'
if (Test-Path -LiteralPath $configFile -PathType Leaf) {
  Add-CheckResult 'Runtime configuration' 'PASS' "Protected configuration exists at '$configFile'."

  try {
    $configAcl = Get-Acl -LiteralPath $configFile
    if ($configAcl.AreAccessRulesProtected) {
      Add-CheckResult 'Configuration inheritance' 'PASS' 'runtime.env does not inherit filesystem permissions.'
    } else {
      Add-CheckResult 'Configuration inheritance' 'FAIL' 'runtime.env still inherits filesystem permissions.'
    }

    $systemAccess = Test-AclPermission $configAcl @('NT AUTHORITY\SYSTEM', 'S-1-5-18') ([System.Security.AccessControl.FileSystemRights]::FullControl)
    $adminAccess = Test-AclPermission $configAcl @('BUILTIN\Administrators', 'S-1-5-32-544') ([System.Security.AccessControl.FileSystemRights]::FullControl)
    $serviceAccess = Test-AclPermission $configAcl @("NT SERVICE\$ServiceName") ([System.Security.AccessControl.FileSystemRights]::Read)
    if ($systemAccess -and $adminAccess -and $serviceAccess) {
      Add-CheckResult 'Configuration ACL' 'PASS' 'SYSTEM/Admins have full control and the service has read-only access.'
    } else {
      Add-CheckResult 'Configuration ACL' 'FAIL' "Expected ACL entries are incomplete (SYSTEM=$systemAccess, Admins=$adminAccess, ServiceRead=$serviceAccess)."
    }

    $forbiddenSids = @('S-1-1-0', 'S-1-5-11', 'S-1-5-32-545')
    $broadAllowRules = @($configAcl.Access | Where-Object {
      $_.AccessControlType -eq [System.Security.AccessControl.AccessControlType]::Allow -and
      $forbiddenSids -contains (Resolve-IdentitySid $_.IdentityReference.Value)
    })
    if ($broadAllowRules.Count -eq 0) {
      Add-CheckResult 'Configuration exposure' 'PASS' 'No allow rule grants runtime.env to Everyone, Users, or Authenticated Users.'
    } else {
      Add-CheckResult 'Configuration exposure' 'FAIL' 'runtime.env has a broad allow rule for a non-administrative identity.'
    }
  } catch {
    Add-CheckResult 'Configuration ACL' 'FAIL' "Could not inspect runtime.env ACL: $($_.Exception.Message)"
  }
} else {
  Add-CheckResult 'Runtime configuration' 'FAIL' "Configuration file is missing: '$configFile'."
}

if ($runtimeRoot -and (Test-Path -LiteralPath $runtimeRoot -PathType Container)) {
  $requiredRuntimeFiles = @(
    (Join-Path $runtimeRoot 'node.exe'),
    (Join-Path $runtimeRoot 'server\index.js'),
    (Join-Path $runtimeRoot 'scamatic-data-plane.exe')
  )
  $missingRuntimeFiles = @($requiredRuntimeFiles | Where-Object { -not (Test-Path -LiteralPath $_ -PathType Leaf) })
  if ($missingRuntimeFiles.Count -eq 0) {
    Add-CheckResult 'Runtime bundle' 'PASS' 'Node, Express entrypoint, and Isaac data-plane are present.'
  } else {
    Add-CheckResult 'Runtime bundle' 'FAIL' "Missing runtime files: $($missingRuntimeFiles -join ', ')"
  }

  try {
    $runtimeAcl = Get-Acl -LiteralPath $runtimeRoot
    $runtimeAccess = Test-AclPermission $runtimeAcl @("NT SERVICE\$ServiceName") ([System.Security.AccessControl.FileSystemRights]::ReadAndExecute)
    if ($runtimeAccess) {
      Add-CheckResult 'Runtime bundle ACL' 'PASS' 'The service account can read and execute the packaged runtime.'
    } else {
      Add-CheckResult 'Runtime bundle ACL' 'FAIL' 'The service account lacks read-and-execute access to the runtime bundle.'
    }
  } catch {
    Add-CheckResult 'Runtime bundle ACL' 'FAIL' "Could not inspect runtime ACL: $($_.Exception.Message)"
  }
} elseif ($null -ne $service) {
  Add-CheckResult 'Runtime bundle' 'FAIL' "Runtime directory is missing: '$runtimeRoot'."
}

if (Test-Path -LiteralPath $logDirectory -PathType Container) {
  try {
    $logAcl = Get-Acl -LiteralPath $logDirectory
    $logAccess = Test-AclPermission $logAcl @("NT SERVICE\$ServiceName") ([System.Security.AccessControl.FileSystemRights]::Modify)
    if ($logAccess) {
      Add-CheckResult 'Runtime log ACL' 'PASS' 'The service account can append runtime logs.'
    } else {
      Add-CheckResult 'Runtime log ACL' 'FAIL' 'The service account lacks modify access to the log directory.'
    }
  } catch {
    Add-CheckResult 'Runtime log ACL' 'FAIL' "Could not inspect log ACL: $($_.Exception.Message)"
  }
} else {
  Add-CheckResult 'Runtime log directory' 'FAIL' "Log directory is missing: '$logDirectory'."
}

if ($null -ne $service -and $service.State -eq 'Running') {
  try {
    $baseAddress = [uri]$BaseUri
    $port = $baseAddress.Port
    $listeners = @(Get-NetTCPConnection -State Listen -LocalPort $port)
    if ($listeners.Count -eq 0) {
      Add-CheckResult 'Loopback listener' 'FAIL' "No process is listening on port $port."
    } else {
      $publicListeners = @($listeners | Where-Object { $_.LocalAddress -notin @('127.0.0.1', '::1') })
      if ($publicListeners.Count -eq 0) {
        Add-CheckResult 'Loopback listener' 'PASS' "Port $port is bound only to a loopback address."
      } else {
        Add-CheckResult 'Loopback listener' 'FAIL' "Port $port has a non-loopback listener: $($publicListeners.LocalAddress -join ', ')."
      }

      $parentByProcessId = @{}
      Get-CimInstance Win32_Process | ForEach-Object {
        $parentByProcessId[[uint32]$_.ProcessId] = [uint32]$_.ParentProcessId
      }
      $unexpectedOwners = @($listeners | Where-Object {
        -not (Test-DescendantProcess ([uint32]$_.OwningProcess) ([uint32]$service.ProcessId) $parentByProcessId)
      })
      if ($unexpectedOwners.Count -eq 0) {
        Add-CheckResult 'Listener ownership' 'PASS' 'Every port listener belongs to the service process tree.'
      } else {
        Add-CheckResult 'Listener ownership' 'FAIL' "Unexpected listener PID(s): $($unexpectedOwners.OwningProcess -join ', ')."
      }
    }
  } catch {
    Add-CheckResult 'Loopback listener' 'FAIL' "Could not inspect port ownership: $($_.Exception.Message)"
  }
}

foreach ($probe in @(
  @{ Name = 'Data-plane readiness'; Path = '/health/data-plane/ready'; ExpectedCheck = 'readiness'; ExpectedStatus = 'ready' },
  @{ Name = 'Master-key compatibility'; Path = '/health/data-plane/key-compatibility'; ExpectedCheck = 'master-key-compatibility'; ExpectedStatus = $null }
)) {
  try {
    $uri = '{0}{1}' -f $BaseUri.TrimEnd('/'), $probe.Path
    $response = Invoke-WebRequest -Uri $uri -UseBasicParsing -TimeoutSec $TimeoutSeconds
    $payload = $response.Content | ConvertFrom-Json
    $valid = $response.StatusCode -eq 200 -and $payload.ok -eq $true -and $payload.check -eq $probe.ExpectedCheck
    if ($probe.ExpectedStatus) {
      $valid = $valid -and $payload.status -eq $probe.ExpectedStatus
    }
    if ($valid) {
      Add-CheckResult $probe.Name 'PASS' "GET $($probe.Path) returned a healthy response."
    } else {
      Add-CheckResult $probe.Name 'FAIL' "GET $($probe.Path) returned an unexpected health payload."
    }
  } catch {
    Add-CheckResult $probe.Name 'FAIL' (Get-HealthProbeFailureDetail $_ $probe.Path)
  }
}

$passed = @($script:Results | Where-Object status -eq 'PASS').Count
$warnings = @($script:Results | Where-Object status -eq 'WARN').Count
$failed = @($script:Results | Where-Object status -eq 'FAIL').Count
$resultItems = $script:Results.ToArray()
$summary = [pscustomobject]@{
  service = $ServiceName
  baseUri = $BaseUri
  checkedAt = [DateTimeOffset]::Now.ToString('o')
  passed = $passed
  warnings = $warnings
  failed = $failed
  rebootPolicyReady = $failed -eq 0
  results = $resultItems
}

if ($Json) {
  $summary | ConvertTo-Json -Depth 6
} else {
  Write-Output 'SCAMATIC Windows installation verification'
  Write-Output "Service: $ServiceName"
  Write-Output "Endpoint: $BaseUri"
  Write-Output ''
  foreach ($result in $script:Results) {
    Write-Output ('[{0}] {1}: {2}' -f $result.status, $result.name, $result.detail)
  }
  Write-Output ''
  Write-Output ("Summary: {0} passed, {1} warning(s), {2} failed." -f $passed, $warnings, $failed)
  if ($failed -eq 0) {
    Write-Output 'Service policy is ready for a reboot validation. Re-run this verifier after reboot.'
  }
}

if ($failed -gt 0) {
  exit 1
}
exit 0
