[CmdletBinding(SupportsShouldProcess, ConfirmImpact = 'High')]
param(
    [string]$InstallRoot = (Join-Path $env:ProgramFiles 'DysonControl'),
    [string]$DataRoot = (Join-Path $env:ProgramData 'DysonControl'),
    [ValidatePattern('^[\p{L}\p{N}_. -]{1,128}$')][string]$TaskName = 'Dyson-Control-Plane',
    [switch]$SkipTaskRemoval,
    [switch]$RemoveData
)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
. (Join-Path $PSScriptRoot 'DysonDeployment.Common.ps1')

$installFull = Assert-DysonSafeRoot -Path $InstallRoot -Name 'InstallRoot'
$dataFull = Assert-DysonSafeRoot -Path $DataRoot -Name 'DataRoot'
if (-not $PSCmdlet.ShouldProcess("$installFull; task $TaskName", $(
    if ($RemoveData) { 'uninstall Dyson Control and permanently remove its data root' }
    else { 'uninstall Dyson Control while preserving its data root' }
))) {
    [ordered]@{
        protocol = $script:DysonDeploymentProtocol
        state = 'preview'
        installRootWillBeRemoved = $true
        taskWillBeRemoved = -not [bool]$SkipTaskRemoval
        dataWillBePreserved = -not [bool]$RemoveData
        gameTasksChanged = $false
    } | ConvertTo-DysonJsonLine
    exit 0
}

if (-not $SkipTaskRemoval) {
    $identity = [System.Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = [System.Security.Principal.WindowsPrincipal]::new($identity)
    if (-not $principal.IsInRole([System.Security.Principal.WindowsBuiltInRole]::Administrator)) {
        throw 'Administrator rights are required to remove the control-plane startup task.'
    }
}
if (-not (Test-Path -LiteralPath $dataFull)) { [void](New-DysonDirectory -Path $dataFull) }
Write-DysonDeploymentAudit -DataRoot $dataFull -Operation 'uninstall' -Outcome 'started' -Code 'UNINSTALL_STARTED'

$uninstallId = (Get-Date).ToUniversalTime().ToString('yyyyMMdd-HHmmssfff') + '-' + [guid]::NewGuid().ToString('N').Substring(0, 8)
$taskBackupPath = $null
$taskRemoved = $false
$releaseBackupPath = $null
$activePointerPath = Get-DysonActivePointerPath -DataRoot $dataFull
$activePointerBackupPath = $null
try {
    if (-not $SkipTaskRemoval) {
        $task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue | Select-Object -First 1
        if ($task) {
            $taskBackupRoot = New-DysonDirectory -Path (Join-Path (Join-Path $dataFull 'snapshots') 'uninstall-tasks')
            $taskBackupPath = Join-Path $taskBackupRoot ($uninstallId + '.xml')
            [System.IO.File]::WriteAllText(
                $taskBackupPath,
                (Export-ScheduledTask -TaskName $TaskName -ErrorAction Stop),
                [System.Text.UTF8Encoding]::new($false)
            )
            if ($task.State.ToString() -eq 'Running') {
                Stop-ScheduledTask -InputObject $task -ErrorAction Stop
                $stopDeadline = (Get-Date).AddSeconds(20)
                do {
                    Start-Sleep -Milliseconds 250
                    $task = Get-ScheduledTask -TaskName $TaskName -ErrorAction Stop | Select-Object -First 1
                } while ($task.State.ToString() -eq 'Running' -and (Get-Date) -lt $stopDeadline)
                if ($task.State.ToString() -eq 'Running') { throw 'The control-plane task did not stop before the uninstall deadline.' }
            }
            Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction Stop
            $taskRemoved = $true
        }
    }
    if (Test-Path -LiteralPath $installFull -PathType Container) {
        $releaseBackupRoot = New-DysonDirectory -Path (Join-Path (Join-Path $dataFull 'snapshots') 'uninstall-releases')
        $releaseBackupPath = Join-Path $releaseBackupRoot $uninstallId
        if (Test-Path -LiteralPath $releaseBackupPath) { throw 'The recoverable uninstall target already exists.' }
        [System.IO.Directory]::Move($installFull, $releaseBackupPath)
    }
    if (Test-Path -LiteralPath $activePointerPath -PathType Leaf) {
        $stateBackupRoot = New-DysonDirectory -Path (Join-Path (Join-Path $dataFull 'snapshots') 'uninstall-state')
        $activePointerBackupPath = Join-Path $stateBackupRoot ($uninstallId + '.active-release.json')
        Copy-Item -LiteralPath $activePointerPath -Destination $activePointerBackupPath -Force -ErrorAction Stop
        Remove-Item -LiteralPath $activePointerPath -Force -ErrorAction Stop
    }
    Write-DysonDeploymentAudit -DataRoot $dataFull -Operation 'uninstall' -Outcome 'succeeded' -SnapshotId $uninstallId -Code 'UNINSTALL_SUCCEEDED'
}
catch {
    $uninstallError = $_
    try {
        if ($releaseBackupPath -and (Test-Path -LiteralPath $releaseBackupPath) -and -not (Test-Path -LiteralPath $installFull)) {
            [System.IO.Directory]::Move($releaseBackupPath, $installFull)
        }
        if ($activePointerBackupPath -and (Test-Path -LiteralPath $activePointerBackupPath) -and
            -not (Test-Path -LiteralPath $activePointerPath)) {
            Copy-Item -LiteralPath $activePointerBackupPath -Destination $activePointerPath -Force -ErrorAction Stop
        }
        if ($taskRemoved -and $taskBackupPath) {
            Register-ScheduledTask -TaskName $TaskName -Xml ([System.IO.File]::ReadAllText($taskBackupPath)) -Force | Out-Null
        }
        Write-DysonDeploymentAudit -DataRoot $dataFull -Operation 'uninstall' -Outcome 'failed-rolled-back' -SnapshotId $uninstallId -Code 'UNINSTALL_ROLLED_BACK'
    }
    catch {
        Write-DysonDeploymentAudit -DataRoot $dataFull -Operation 'uninstall' -Outcome 'failed-rollback-failed' -SnapshotId $uninstallId -Code 'UNINSTALL_ROLLBACK_FAILED'
        throw ('Uninstall failed ({0}); automatic rollback also failed ({1}).' -f $uninstallError.Exception.Message, $_.Exception.Message)
    }
    throw $uninstallError
}

if ($RemoveData -and (Test-Path -LiteralPath $dataFull)) {
    Remove-Item -LiteralPath $dataFull -Recurse -Force
}
[ordered]@{
    protocol = $script:DysonDeploymentProtocol
    state = 'uninstalled'
    taskRemoved = $taskRemoved
    dataPreserved = -not [bool]$RemoveData
    recoverableReleaseBackup = if (-not $RemoveData -and $releaseBackupPath) { $releaseBackupPath } else { $null }
    activePointerBackup = if (-not $RemoveData -and $activePointerBackupPath) { $activePointerBackupPath } else { $null }
    taskDefinitionBackup = if (-not $RemoveData) { $taskBackupPath } else { $null }
    gameTasksChanged = $false
} | ConvertTo-DysonJsonLine
