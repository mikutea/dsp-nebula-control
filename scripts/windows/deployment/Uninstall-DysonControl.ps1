[CmdletBinding(SupportsShouldProcess, ConfirmImpact = 'High')]
param(
    [string]$InstallRoot = (Join-Path $env:ProgramFiles 'DysonControl'),
    [string]$DataRoot = (Join-Path $env:ProgramData 'DysonControl'),
    [ValidatePattern('^[\p{L}\p{N}_. -]{1,128}$')][string]$TaskName = 'Dyson-Control-Plane',
    [switch]$SkipTaskRemoval,
    [switch]$RemoveData,
    [ValidateRange(1, 120)][int]$LockTimeoutSeconds = 30,
    [Parameter(DontShow)][switch]$SelfTestSkipAdministratorCheck
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

if ($SelfTestSkipAdministratorCheck) {
    Assert-DysonDeploymentTaskSelfTestScope -InstallRoot $installFull -DataRoot $dataFull
}
if (-not $SkipTaskRemoval -and -not $SelfTestSkipAdministratorCheck) {
    $identity = [System.Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = [System.Security.Principal.WindowsPrincipal]::new($identity)
    if (-not $principal.IsInRole([System.Security.Principal.WindowsBuiltInRole]::Administrator)) {
        throw 'Administrator rights are required to remove the control-plane startup task.'
    }
}

$deploymentLock = Enter-DysonDeploymentLock -DataRoot $dataFull -TimeoutSeconds $LockTimeoutSeconds
try {
    $taskRollbackState = if ($SkipTaskRemoval) { $null } else { Get-DysonControlTaskRollbackState -TaskName $TaskName }
    if (-not (Test-Path -LiteralPath $dataFull)) { [void](New-DysonDirectory -Path $dataFull) }
    Write-DysonDeploymentAudit -DataRoot $dataFull -Operation 'uninstall' -Outcome 'started' -Code 'UNINSTALL_STARTED'

    $uninstallId = (Get-Date).ToUniversalTime().ToString('yyyyMMdd-HHmmssfff') + '-' + [guid]::NewGuid().ToString('N').Substring(0, 8)
    $taskBackupPath = $null
    $taskMutationAttempted = $false
    $taskRemoved = $false
    $releaseBackupPath = $null
    $activePointerPath = Get-DysonActivePointerPath -DataRoot $dataFull
    $activePointerBackupPath = $null
    try {
        if (-not $SkipTaskRemoval -and [bool]$taskRollbackState.present) {
            $taskBackupRoot = New-DysonDirectory -Path (Join-Path (Join-Path $dataFull 'snapshots') 'uninstall-tasks')
            $taskBackupPath = Join-Path $taskBackupRoot ($uninstallId + '.xml')
            [System.IO.File]::WriteAllText(
                $taskBackupPath,
                [string]$taskRollbackState.xml,
                [System.Text.UTF8Encoding]::new($false)
            )
            $taskMutationAttempted = $true
            Remove-DysonControlTaskForRollback -TaskName $TaskName
            $taskRemoved = $true
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
        $rollbackFailures = New-Object System.Collections.Generic.List[string]
        $deploymentStateRestored = $true
        try {
            if ($releaseBackupPath -and (Test-Path -LiteralPath $releaseBackupPath)) {
                if (Test-Path -LiteralPath $installFull) { throw 'The install root is occupied during uninstall rollback.' }
                [System.IO.Directory]::Move($releaseBackupPath, $installFull)
            }
            if ($activePointerBackupPath -and (Test-Path -LiteralPath $activePointerBackupPath -PathType Leaf)) {
                if (Test-Path -LiteralPath $activePointerPath -PathType Leaf) {
                    if ((Get-DysonFileSha256 -Path $activePointerPath) -cne
                        (Get-DysonFileSha256 -Path $activePointerBackupPath)) {
                        throw 'The active release pointer changed during uninstall rollback.'
                    }
                }
                else {
                    Copy-Item -LiteralPath $activePointerBackupPath -Destination $activePointerPath -Force -ErrorAction Stop
                }
            }
        }
        catch {
            $deploymentStateRestored = $false
            $rollbackFailures.Add('deployment-state')
        }

        if ($taskMutationAttempted -and [bool]$taskRollbackState.present) {
            if ($deploymentStateRestored) {
                try {
                    [void](Restore-DysonControlTaskRollbackState -State $taskRollbackState -TaskName $TaskName)
                }
                catch { $rollbackFailures.Add('control-task') }
            }
            else { $rollbackFailures.Add('control-task-blocked-by-deployment-state') }
        }

        if ($rollbackFailures.Count -eq 0) {
            try {
                Write-DysonDeploymentAudit -DataRoot $dataFull -Operation 'uninstall' -Outcome 'failed-rolled-back' -SnapshotId $uninstallId -Code 'UNINSTALL_ROLLED_BACK'
            }
            catch { $rollbackFailures.Add('rollback-audit') }
        }
        if ($rollbackFailures.Count -gt 0) {
            try {
                Write-DysonDeploymentAudit -DataRoot $dataFull -Operation 'uninstall' -Outcome 'failed-rollback-failed' -SnapshotId $uninstallId -Code 'UNINSTALL_ROLLBACK_FAILED'
            }
            catch { }
            throw ('Uninstall failed ({0}); automatic rollback was incomplete in: {1}.' -f
                $uninstallError.Exception.Message, [string]::Join(', ', @($rollbackFailures)))
        }
        throw $uninstallError
    }

    if ($RemoveData -and (Test-Path -LiteralPath $dataFull)) {
        try { Remove-Item -LiteralPath $dataFull -Recurse -Force -ErrorAction Stop }
        catch {
            if (Test-Path -LiteralPath $dataFull -PathType Container) {
                try {
                    Write-DysonDeploymentAudit -DataRoot $dataFull -Operation 'uninstall' -Outcome 'data-removal-incomplete' `
                        -SnapshotId $uninstallId -Code 'UNINSTALL_DATA_REMOVAL_INCOMPLETE'
                }
                catch { }
            }
            throw 'Dyson Control was uninstalled, but the explicitly requested data-root removal did not complete.'
        }
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
}
finally {
    if ($deploymentLock) { $deploymentLock.Dispose() }
}
