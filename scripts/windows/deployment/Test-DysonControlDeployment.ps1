[CmdletBinding()]
param(
    [string]$InstallRoot = (Join-Path $env:ProgramFiles 'DysonControl'),
    [string]$DataRoot = (Join-Path $env:ProgramData 'DysonControl'),
    [ValidatePattern('^[\p{L}\p{N}_. -]{1,128}$')][string]$TaskName = 'Dyson-Control-Plane',
    [switch]$IncludeTask,
    [uri]$ReadinessUri
)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
. (Join-Path $PSScriptRoot 'DysonDeployment.Common.ps1')

$installFull = Assert-DysonSafeRoot -Path $InstallRoot -Name 'InstallRoot'
$dataFull = Assert-DysonSafeRoot -Path $DataRoot -Name 'DataRoot'
$checks = New-Object System.Collections.Generic.List[object]
function Add-Check {
    param([string]$Code, [bool]$Passed, [string]$Summary)
    $checks.Add([ordered]@{ code = $Code; passed = $Passed; summary = $Summary })
}

Add-Check -Code 'INSTALL_ROOT' -Passed (Test-Path -LiteralPath $installFull -PathType Container) -Summary 'Versioned install root exists.'
Add-Check -Code 'DATA_ROOT' -Passed (Test-Path -LiteralPath $dataFull -PathType Container) -Summary 'Persistent data root exists.'
$activeVersion = $null
try {
    $active = Get-DysonActiveRelease -InstallRoot $installFull -DataRoot $dataFull
    if ($active) {
        $activeVersion = [string]$active.pointer.version
        Add-Check -Code 'ACTIVE_RELEASE' -Passed $true -Summary 'The active pointer and immutable release manifest match.'
    }
    else { Add-Check -Code 'ACTIVE_RELEASE' -Passed $false -Summary 'No release is active.' }
}
catch { Add-Check -Code 'ACTIVE_RELEASE' -Passed $false -Summary 'The active release failed integrity validation.' }

$configPath = Join-Path (Join-Path $dataFull 'config') 'dyson-control.env'
Add-Check -Code 'PRODUCTION_CONFIG' -Passed (Test-Path -LiteralPath $configPath -PathType Leaf) -Summary 'The local production environment file exists.'
$launcherPath = Join-Path (Join-Path $installFull 'bootstrap') 'Start-DysonControl.ps1'
Add-Check -Code 'FIXED_LAUNCHER' -Passed (Test-Path -LiteralPath $launcherPath -PathType Leaf) -Summary 'The stable loopback launcher exists.'

$taskState = 'not-checked'
if ($IncludeTask) {
    try {
        $task = Get-ScheduledTask -TaskName $TaskName -ErrorAction Stop | Select-Object -First 1
        $taskState = $task.State.ToString().ToLowerInvariant()
        $taskValid = $task.Actions.Count -eq 1 -and $task.Actions[0].Arguments -like '*Start-DysonControl.ps1*' -and
            $task.Principal.LogonType.ToString() -eq 'ServiceAccount'
        Add-Check -Code 'CONTROL_TASK' -Passed $taskValid -Summary 'The fixed control-plane startup task has a service-account principal.'
    }
    catch { Add-Check -Code 'CONTROL_TASK' -Passed $false -Summary 'The control-plane startup task is unavailable.' }
}

$readinessPassed = $null
if ($ReadinessUri) {
    try {
        if (-not $activeVersion) { throw 'No active release is available for version-bound readiness validation.' }
        [void](Test-DysonLoopbackReadiness -ReadinessUri $ReadinessUri -ExpectedVersion $activeVersion -TimeoutSeconds 2)
        $readinessPassed = $true
        Add-Check -Code 'LOOPBACK_READINESS' -Passed $true -Summary 'The loopback /readyz endpoint proved deep application readiness.'
    }
    catch {
        $readinessPassed = $false
        Add-Check -Code 'LOOPBACK_READINESS' -Passed $false -Summary 'The loopback /readyz endpoint did not prove deep application readiness.'
    }
}

$failedChecks = @($checks | Where-Object { -not $_.passed }).Count
[ordered]@{
    protocol = 'DYSON_CONTROL_DEPLOYMENT_STATUS_V1'
    ready = $failedChecks -eq 0
    activeVersion = $activeVersion
    taskState = $taskState
    readinessVerified = $readinessPassed
    checks = $checks
} | ConvertTo-Json -Depth 8 -Compress
