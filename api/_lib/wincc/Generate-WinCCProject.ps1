#Requires -Version 5.1
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$TemplateArchive,
    [Parameter(Mandatory = $true)][string]$OutputDirectory,
    [string]$ApiDirectory = (Join-Path $env:ProgramFiles 'Siemens\Automation\Portal V21\PublicAPI\V21\net48')
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Invoke-TiaGeneric {
    param($Instance, [string]$Name, [type]$ArgumentType, [object[]]$Parameters = @())

    $methods = @($Instance.GetType().GetMethods() | Where-Object {
        $_.Name -eq $Name -and $_.IsGenericMethodDefinition -and
            $_.GetGenericArguments().Count -eq 1 -and $_.GetParameters().Count -eq $Parameters.Count -and
            ($Parameters.Count -eq 0 -or $_.GetParameters()[0].ParameterType -eq [string])
    })
    if ($methods.Count -eq 0 -and $Name -eq 'GetService') {
        $methods = @([Siemens.Engineering.IEngineeringServiceProvider].GetMethods() | Where-Object {
            $_.Name -eq 'GetService' -and $_.IsGenericMethodDefinition -and $_.GetParameters().Count -eq 0
        })
    }
    if ($methods.Count -ne 1) { throw "Could not locate the V21 Openness method $Name on $($Instance.GetType().FullName)." }
    return $methods[0].MakeGenericMethod($ArgumentType).Invoke($Instance, $Parameters)
}

function Find-UnifiedSoftware {
    param($DeviceItem)

    $container = Invoke-TiaGeneric $DeviceItem 'GetService' ([Siemens.Engineering.HW.Features.SoftwareContainer])
    if ($null -ne $container -and $container.Software -is [Siemens.Engineering.HmiUnified.HmiSoftware]) {
        $container.Software
    }
    foreach ($child in $DeviceItem.DeviceItems) { Find-UnifiedSoftware $child }
}

function Set-ItemBounds {
    param($Item, $Definition)

    $Item.Left = [int]$Definition.x
    $Item.Top = [int]$Definition.y
    $Item.Width = [uint32]$Definition.width
    $Item.Height = [uint32]$Definition.height
}

function Set-TiaEnum {
    param($Instance, [string]$Property, [string]$Value)

    $type = $Instance.GetType().GetProperty($Property).PropertyType
    $Instance.$Property = [Enum]::Parse($type, $Value, $false)
}

function Convert-WinccColor {
    param([string]$Hex)

    if ($Hex -notmatch '^#[0-9a-fA-F]{6}$') { throw "Invalid WinCC color $Hex." }
    return [Drawing.ColorTranslator]::FromHtml($Hex)
}

function Set-TemplateText {
    param($Text, [string]$Value, [string]$Color)

    if ($Text.Items.Count -eq 0) {
        $translation = [Siemens.Engineering.MultilingualTextItem]::new()
        $translation.Language = 'en-US'
        [void]$Text.Items.Add($translation)
    }
    $rgb = '#{0:X6}' -f ((Convert-WinccColor $Color).ToArgb() -band 0xFFFFFF)
    $body = [Net.WebUtility]::HtmlEncode($Value).Replace([string][char]10, '<br>')
    foreach ($translation in $Text.Items) {
        $translation.Text = '<body><p><span style="color:' + $rgb + '">' + $body + '</span></p></body>'
    }
}

if ($PSVersionTable.PSEdition -ne 'Desktop' -or -not [Environment]::Is64BitProcess) {
    throw 'Run this generator using 64-bit Windows PowerShell 5.1 (powershell.exe).'
}

$template = Get-Item -LiteralPath $TemplateArchive
if ($template.PSIsContainer -or $template.Extension -ne '.zap21') {
    throw 'Select a TIA Portal V21 project archive (.zap21).'
}
$output = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($OutputDirectory)
if (Test-Path -LiteralPath $output) { throw "Choose a new output folder. This path already exists: $output" }

$manifest = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'manifest.json') -Raw -Encoding UTF8 | ConvertFrom-Json
if ($manifest.format -ne 'scamatic-wincc-unified/v2' -or $manifest.tiaVersion -ne 21) {
    throw 'This generator requires a SCAMATIC WinCC Unified V21 manifest.'
}

$baseAssembly = Join-Path $ApiDirectory 'Siemens.Engineering.Base.dll'
$unifiedAssembly = Join-Path $ApiDirectory 'Siemens.Engineering.WinCCUnified.dll'
if (-not (Test-Path -LiteralPath $baseAssembly -PathType Leaf) -or
    -not (Test-Path -LiteralPath $unifiedAssembly -PathType Leaf)) {
    throw 'TIA Portal V21 Base and WinCC Unified Openness assemblies are required. Use -ApiDirectory for a custom installation.'
}
[void][Reflection.Assembly]::LoadFrom($baseAssembly)
$unified = [Reflection.Assembly]::LoadFrom($unifiedAssembly)
Add-Type -AssemblyName System.Drawing

$exports = $unified.GetExportedTypes()
$apiTypes = @{}
foreach ($typeName in @('HmiTextBox', 'HmiEllipse', 'HmiIOField', 'HmiButton', 'HmiGauge', 'HmiGraphicView')) {
    $matchingTypes = @($exports | Where-Object Name -eq $typeName)
    if ($matchingTypes.Count -ne 1) { throw "Could not resolve the V21 WinCC Unified type $typeName." }
    $apiTypes[$typeName] = $matchingTypes[0]
}

$portal = [Siemens.Engineering.TiaPortal]::new([Siemens.Engineering.TiaPortalMode]::WithoutUserInterface)
$project = $null
try {
    $outputFolder = New-Item -Path $output -ItemType Directory -ErrorAction Stop
    $project = $portal.Projects.Retrieve([IO.FileInfo]$template, $outputFolder)
    $hmiTargets = @(
        foreach ($device in $project.Devices) {
            foreach ($child in $device.DeviceItems) { Find-UnifiedSoftware $child }
        }
    )
    if ($hmiTargets.Count -ne 1) {
        throw 'Use a template archive with one WinCC Unified PC HMI device at the project root.'
    }
    $hmi = $hmiTargets[0]
    $definition = $manifest.screen
    if ($null -ne $hmi.Screens.Find([string]$definition.name)) {
        throw "The template already contains screen $($definition.name). Use a clean template."
    }

    $screen = $hmi.Screens.Create([string]$definition.name)
    $screen.Width = [uint32]$definition.width
    $screen.Height = [uint32]$definition.height
    $screen.BackColor = Convert-WinccColor $definition.background

    foreach ($item in $definition.items) {
        try {
            switch ($item.kind) {
                'text-label' {
                    $native = Invoke-TiaGeneric $screen.ScreenItems 'Create' $apiTypes.HmiTextBox @([string]$item.name)
                    $text = $native.Text
                    Set-TemplateText $text $item.text $item.color
                    $native.Text = $text
                }
                'indicator-lamp' {
                    $native = Invoke-TiaGeneric $screen.ScreenItems 'Create' $apiTypes.HmiEllipse @([string]$item.name)
                    $native.BackColor = Convert-WinccColor $item.color
                }
                'value-span' {
                    $native = Invoke-TiaGeneric $screen.ScreenItems 'Create' $apiTypes.HmiIOField @([string]$item.name)
                    Set-TiaEnum $native 'IOFieldType' 'Output'
                    $native.ForegroundColor = Convert-WinccColor $item.color
                    $native.BackColor = Convert-WinccColor $item.background
                    $native.ProcessValue = ([double]$item.value).ToString([Globalization.CultureInfo]::InvariantCulture)
                }
                'gauge' {
                    $native = Invoke-TiaGeneric $screen.ScreenItems 'Create' $apiTypes.HmiGauge @([string]$item.name)
                    $native.ProcessValue = ([double]$item.value).ToString([Globalization.CultureInfo]::InvariantCulture)
                }
                'control-button' {
                    $native = Invoke-TiaGeneric $screen.ScreenItems 'Create' $apiTypes.HmiButton @([string]$item.name)
                    $native.BackColor = Convert-WinccColor $item.color
                    Set-TemplateText $native.Text $item.text '#101418'
                }
                'industrial-graphic' {
                    $native = Invoke-TiaGeneric $screen.ScreenItems 'Create' $apiTypes.HmiGraphicView @([string]$item.name)
                    $native.Opacity = [single]$item.opacity
                    $native.RotationAngle = [int16]$item.rotation
                    Set-TiaEnum $native 'GraphicStretchMode' $(if ($item.stretch) { 'Fill' } else { 'Uniform' })
                    if ($null -ne $project.Graphics.Find([string]$item.graphicName)) {
                        $native.Graphic = [string]$item.graphicName
                    } else {
                        Write-Warning "Assign $($item.file) to Graphic view $($item.name)."
                    }
                }
                default { throw "Unsupported component $($item.kind)." }
            }
            Set-ItemBounds $native $item
        } catch {
            throw "Could not generate $($item.label) [$($item.name)]: $($_.Exception.Message)"
        }
    }

    $hmi.RuntimeSettings.StartScreen = [string]$definition.name
    $project.Save()
    Write-Output "Generated WinCC Unified V21 project in $($outputFolder.FullName)"
    foreach ($warning in $manifest.warnings) { Write-Warning $warning }
} finally {
    try {
        if ($null -ne $project) { $project.Close() }
    } finally {
        $portal.Dispose()
    }
}
