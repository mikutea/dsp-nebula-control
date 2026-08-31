[CmdletBinding(SupportsShouldProcess, ConfirmImpact = 'High')]
param(
    [Parameter(Mandatory)][string]$ProjectRoot,
    [Parameter(Mandatory)][string]$InstalledScriptRoot,
    [Parameter(Mandatory)][ValidatePattern('^[^"\r\n]{1,128}$')][string]$ServiceUser,
    [ValidatePattern('^[\p{L}\p{N}_. -]{1,128}$')][string]$ServerTaskName = 'Dyson-Nebula-Server',
    [ValidatePattern('^[\p{L}\p{N}_. -]{1,128}$')][string]$StopTaskName = 'Dyson-Nebula-Stop',
    [ValidateRange(5, 240)][int]$Ups = 60,
    [string]$TaskBackupRoot = "$env:ProgramData\DysonControl\task-backups"
)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$identity = [System.Security.Principal.WindowsIdentity]::GetCurrent()
$currentPrincipal = [System.Security.Principal.WindowsPrincipal]::new($identity)
if (-not $currentPrincipal.IsInRole([System.Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw 'Administrator rights are required to install the Dyson runtime tasks.'
}

$resolvedProjectRoot = (Resolve-Path -LiteralPath $ProjectRoot -ErrorAction Stop).ProviderPath
$resolvedScriptRoot = (Resolve-Path -LiteralPath $InstalledScriptRoot -ErrorAction Stop).ProviderPath
if ($resolvedProjectRoot -match '"' -or $resolvedScriptRoot -match '"') {
    throw 'The configured runtime paths cannot contain double quotes.'
}
$startScript = Join-Path $resolvedScriptRoot 'Start-DysonServer.ps1'
$stopScript = Join-Path $resolvedScriptRoot 'Stop-DysonServer.ps1'
foreach ($script in @($startScript, $stopScript)) {
    $item = Get-Item -LiteralPath $script -Force -ErrorAction Stop
    if ($item.PSIsContainer -or ($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint)) {
        throw 'A fixed runtime action script is unavailable or redirected.'
    }
}

$powerShellExe = "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe"
if (-not (Test-Path -LiteralPath $powerShellExe -PathType Leaf)) { throw 'Windows PowerShell is unavailable.' }
$timestamp = (Get-Date).ToUniversalTime().ToString('yyyyMMdd-HHmmss')
$backupDirectory = Join-Path $TaskBackupRoot $timestamp

function Backup-TaskIfPresent {
    param([Parameter(Mandatory)][string]$TaskName)
    $task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue | Select-Object -First 1
    if (-not $task) { return $false }
    [System.IO.Directory]::CreateDirectory($backupDirectory) | Out-Null
    $xml = Export-ScheduledTask -TaskName $TaskName -ErrorAction Stop
    $safeName = $TaskName -replace '[^\p{L}\p{N}_.-]', '_'
    [System.IO.File]::WriteAllText(
        (Join-Path $backupDirectory ($safeName + '.xml')),
        $xml,
        [System.Text.UTF8Encoding]::new($false)
    )
    return $true
}

if (-not $PSCmdlet.ShouldProcess(
    "$ServerTaskName and $StopTaskName",
    'Back up any existing tasks and install the fixed Dyson runtime tasks'
)) {
    [ordered]@{
        protocol = 'DYSON_CONTROL_TASK_INSTALL_V1'
        state = 'preview'
        serverTask = $ServerTaskName
        stopTask = $StopTaskName
    } | ConvertTo-Json -Compress
    exit 0
}

$serverBackedUp = Backup-TaskIfPresent -TaskName $ServerTaskName
$stopBackedUp = Backup-TaskIfPresent -TaskName $StopTaskName
$taskPrincipal = New-ScheduledTaskPrincipal -UserId $ServiceUser -LogonType Interactive -RunLevel Limited
$startAction = New-ScheduledTaskAction -Execute $powerShellExe -Argument (
    '-NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "{0}" -ProjectRoot "{1}" -Ups {2}' -f
    $startScript, $resolvedProjectRoot, $Ups
)
$startTrigger = New-ScheduledTaskTrigger -AtLogOn -User $ServiceUser
$startTrigger.Delay = 'PT20S'
$startSettings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -ExecutionTimeLimit ([TimeSpan]::Zero) `
    -MultipleInstances IgnoreNew `
    -RestartCount 3 `
    -RestartInterval (New-TimeSpan -Minutes 1) `
    -StartWhenAvailable
$stopAction = New-ScheduledTaskAction -Execute $powerShellExe -Argument (
    '-NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "{0}" -ProjectRoot "{1}" -TimeoutSeconds 150' -f
    $stopScript, $resolvedProjectRoot
)
$stopSettings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -ExecutionTimeLimit (New-TimeSpan -Minutes 5) `
    -MultipleInstances IgnoreNew

Register-ScheduledTask `
    -TaskName $ServerTaskName `
    -Action $startAction `
    -Trigger $startTrigger `
    -Principal $taskPrincipal `
    -Settings $startSettings `
    -Description 'Starts DSP, BepInEx, Nebula, and the Dyson Control bridge in the managed interactive session.' `
    -Force | Out-Null
Register-ScheduledTask `
    -TaskName $StopTaskName `
    -Action $stopAction `
    -Principal $taskPrincipal `
    -Settings $stopSettings `
    -Description 'Sends a graceful console stop to the exact managed DSP process; never force-kills on timeout.' `
    -Force | Out-Null

$installedServer = Get-ScheduledTask -TaskName $ServerTaskName -ErrorAction Stop
$installedStop = Get-ScheduledTask -TaskName $StopTaskName -ErrorAction Stop
if ($installedServer.Principal.LogonType.ToString() -ne 'Interactive' -or
    $installedStop.Principal.LogonType.ToString() -ne 'Interactive' -or
    -not [string]::Equals($installedServer.Principal.UserId, $ServiceUser, [System.StringComparison]::OrdinalIgnoreCase) -or
    -not [string]::Equals($installedStop.Principal.UserId, $ServiceUser, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw 'The installed runtime task principals did not pass verification.'
}

[ordered]@{
    protocol = 'DYSON_CONTROL_TASK_INSTALL_V1'
    state = 'installed'
    serverTask = $ServerTaskName
    stopTask = $StopTaskName
    existingServerTaskBackedUp = [bool]$serverBackedUp
    existingStopTaskBackedUp = [bool]$stopBackedUp
    backupCreated = [bool]($serverBackedUp -or $stopBackedUp)
} | ConvertTo-Json -Depth 4 -Compress
