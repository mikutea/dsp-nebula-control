[CmdletBinding(SupportsShouldProcess, ConfirmImpact = 'High')]
param(
    [string]$InstallRoot = (Join-Path $env:ProgramFiles 'DysonControl'),
    [string]$DataRoot = (Join-Path $env:ProgramData 'DysonControl'),
    [Parameter(Mandatory)][string]$NodeExecutable,
    [ValidatePattern('^[\p{L}\p{N}_. -]{1,128}$')][string]$TaskName = 'Dyson-Control-Plane',
    [ValidateSet('NT AUTHORITY\LOCAL SERVICE', 'NT AUTHORITY\NETWORK SERVICE', 'SYSTEM')]
    [string]$ServiceAccount = 'NT AUTHORITY\LOCAL SERVICE',
    [string]$EnvironmentFile,
    [ValidateRange(1, 120)][int]$LockTimeoutSeconds = 30,
    [Parameter(DontShow)][System.IO.FileStream]$ExistingDeploymentLock,
    [Parameter(DontShow)][switch]$SelfTestSkipAdministratorCheck
)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
. (Join-Path $PSScriptRoot 'DysonDeployment.Common.ps1')

$installFull = Assert-DysonSafeRoot -Path $InstallRoot -Name 'InstallRoot'
$dataFull = Assert-DysonSafeRoot -Path $DataRoot -Name 'DataRoot'
$bootstrapRoot = Join-Path $installFull 'bootstrap'
$launcherPath = Join-Path $bootstrapRoot 'Start-DysonControl.ps1'
$commonPath = Join-Path $bootstrapRoot 'DysonDeployment.Common.ps1'
foreach ($required in @($launcherPath, $commonPath)) {
    if (-not (Test-Path -LiteralPath $required -PathType Leaf)) { throw "Installed bootstrap file is missing: $required" }
}
$nodePath = Resolve-DysonNodeExecutablePath -NodeExecutable $NodeExecutable
$active = Get-DysonActiveRelease -InstallRoot $installFull -DataRoot $dataFull
if (-not $active) { throw 'No Dyson Control release is active.' }
if (-not $EnvironmentFile) { $EnvironmentFile = Join-Path (Join-Path $dataFull 'config') 'dyson-control.env' }
$environmentFull = Get-DysonFullPath -Path $EnvironmentFile
if (-not (Test-DysonPathWithin -Candidate $environmentFull -Parent (Join-Path $dataFull 'config'))) {
    throw 'EnvironmentFile must remain below the deployment config directory.'
}
if (-not (Test-Path -LiteralPath $environmentFull -PathType Leaf)) {
    throw 'The production environment file must exist before the startup task is installed.'
}
foreach ($argumentPath in @($installFull, $dataFull, $nodePath, $environmentFull, $launcherPath)) {
    if ($argumentPath -match '["\r\n]') { throw 'Scheduled-task paths cannot contain quotes or line breaks.' }
}
if ($SelfTestSkipAdministratorCheck) {
    Assert-DysonDeploymentTaskSelfTestScope -InstallRoot $installFull -DataRoot $dataFull
}

if (-not $PSCmdlet.ShouldProcess($TaskName, 'back up and install the fixed loopback Dyson Control startup task')) {
    [ordered]@{
        protocol = $script:DysonDeploymentProtocol
        state = 'preview'
        taskName = $TaskName
        serviceAccount = $ServiceAccount
        launcher = $launcherPath
        nodeRuntimeWillBeVerified = $true
        gameTasksChanged = $false
    } | ConvertTo-DysonJsonLine
    exit 0
}

[void](Test-DysonNodeRuntime -NodeExecutable $nodePath -MinimumMajor $active.nodeMinimumMajor)

if (-not $SelfTestSkipAdministratorCheck) {
    $identity = [System.Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = [System.Security.Principal.WindowsPrincipal]::new($identity)
    if (-not $principal.IsInRole([System.Security.Principal.WindowsBuiltInRole]::Administrator)) {
        throw 'Administrator rights are required to install the control-plane startup task.'
    }
}

$ownsDeploymentLock = $false
if ($ExistingDeploymentLock) {
    Assert-DysonDeploymentLockLease -Lease $ExistingDeploymentLock -DataRoot $dataFull
    $deploymentLock = $ExistingDeploymentLock
}
else {
    $deploymentLock = Enter-DysonDeploymentLock -DataRoot $dataFull -TimeoutSeconds $LockTimeoutSeconds
    $ownsDeploymentLock = $true
}
try {
$taskRollbackState = Get-DysonControlTaskRollbackState -TaskName $TaskName
[void](New-DysonDirectory -Path $dataFull)
Write-DysonDeploymentAudit -DataRoot $dataFull -Operation 'install-control-task' -Outcome 'started' -Code 'TASK_INSTALL_STARTED'
$originalDataAcl = Microsoft.PowerShell.Security\Get-Acl -LiteralPath $dataFull -ErrorAction Stop
$originalDataSddl = $originalDataAcl.Sddl
$backupId = (Get-Date).ToUniversalTime().ToString('yyyyMMdd-HHmmssfff') + '-' + [guid]::NewGuid().ToString('N').Substring(0, 8)
$backupPath = $null
$hadExistingTask = $false
$existingTaskWasRunning = $false
$existingTaskStopped = $false
$taskRegistrationAttempted = $false
try {
    $serviceSid = switch ($ServiceAccount) {
        'NT AUTHORITY\LOCAL SERVICE' { [System.Security.Principal.SecurityIdentifier]::new('S-1-5-19') }
        'NT AUTHORITY\NETWORK SERVICE' { [System.Security.Principal.SecurityIdentifier]::new('S-1-5-20') }
        'SYSTEM' { [System.Security.Principal.SecurityIdentifier]::new('S-1-5-18') }
    }
    $dataAcl = Microsoft.PowerShell.Security\Get-Acl -LiteralPath $dataFull -ErrorAction Stop
    $dataRule = [System.Security.AccessControl.FileSystemAccessRule]::new(
        $serviceSid,
        [System.Security.AccessControl.FileSystemRights]::Modify,
        [System.Security.AccessControl.InheritanceFlags]'ContainerInherit, ObjectInherit',
        [System.Security.AccessControl.PropagationFlags]::None,
        [System.Security.AccessControl.AccessControlType]::Allow
    )
    $dataAcl.SetAccessRule($dataRule)
    Microsoft.PowerShell.Security\Set-Acl -LiteralPath $dataFull -AclObject $dataAcl -ErrorAction Stop
    $backupRoot = New-DysonDirectory -Path (Join-Path (Join-Path $dataFull 'snapshots') 'tasks')
    $backupPath = Join-Path $backupRoot ($backupId + '.xml')

    $hadExistingTask = [bool]$taskRollbackState.present
    $existingTaskWasRunning = [bool]$taskRollbackState.wasRunning
    if ($hadExistingTask) {
        $existingTasks = @(Get-DysonScheduledTasksByExactName -TaskName $TaskName)
        if ($existingTasks.Count -ne 1) { throw 'The control-plane task identity changed after its rollback snapshot.' }
        $existingTask = $existingTasks[0]
        if ([string]$existingTask.TaskPath -cne $script:DysonControlTaskPath) {
            throw 'The control-plane task moved outside the fixed root task path.'
        }
        [System.IO.File]::WriteAllText($backupPath, [string]$taskRollbackState.xml, [System.Text.UTF8Encoding]::new($false))
        if ($existingTaskWasRunning) {
            Stop-ScheduledTask -InputObject $existingTask -ErrorAction Stop
            $existingTaskStopped = $true
            $stopDeadline = (Get-Date).AddSeconds(20)
            do {
                Start-Sleep -Milliseconds 250
                $existingTasks = @(Get-DysonScheduledTasksByExactName -TaskName $TaskName)
                if ($existingTasks.Count -ne 1) { throw 'The control-plane task identity changed while it was stopping.' }
                $existingTask = $existingTasks[0]
                if ([string]$existingTask.TaskPath -cne $script:DysonControlTaskPath) {
                    throw 'The control-plane task moved outside the fixed root task path while it was stopping.'
                }
            } while ($existingTask.State.ToString() -eq 'Running' -and (Get-Date) -lt $stopDeadline)
            if ($existingTask.State.ToString() -eq 'Running') { throw 'The existing control-plane task did not stop before replacement.' }
        }
    }

    $powerShellExecutable = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
    if (-not (Test-Path -LiteralPath $powerShellExecutable -PathType Leaf)) { throw 'Windows PowerShell is unavailable.' }
    $arguments = '-NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "{0}" -InstallRoot "{1}" -DataRoot "{2}" -NodeExecutable "{3}" -EnvironmentFile "{4}"' -f
        $launcherPath, $installFull, $dataFull, $nodePath, $environmentFull
    $action = New-ScheduledTaskAction -Execute $powerShellExecutable -Argument $arguments
    $trigger = New-ScheduledTaskTrigger -AtStartup
    $taskPrincipal = New-ScheduledTaskPrincipal -UserId $ServiceAccount -LogonType ServiceAccount -RunLevel Limited
    $settings = New-ScheduledTaskSettingsSet `
        -AllowStartIfOnBatteries `
        -DontStopIfGoingOnBatteries `
        -ExecutionTimeLimit ([TimeSpan]::Zero) `
        -MultipleInstances IgnoreNew `
        -RestartCount 5 `
        -RestartInterval (New-TimeSpan -Minutes 1) `
        -StartWhenAvailable

    $taskRegistrationAttempted = $true
    Register-ScheduledTask `
        -TaskName $TaskName `
        -TaskPath $script:DysonControlTaskPath `
        -Action $action `
        -Trigger $trigger `
        -Principal $taskPrincipal `
        -Settings $settings `
        -Description 'Runs the Dyson Control Node control plane on loopback. This task does not start or stop the game server.' `
        -Force | Out-Null
    $installedTasks = @(Get-DysonScheduledTasksByExactName -TaskName $TaskName)
    if ($installedTasks.Count -ne 1) { throw 'The installed control-plane task identity is not unique.' }
    $installed = $installedTasks[0]
    $installedActions = @($installed.Actions | Where-Object { $null -ne $_ })
    if ([string]$installed.TaskPath -cne $script:DysonControlTaskPath -or
        $installed.Principal.LogonType.ToString() -ne 'ServiceAccount' -or
        -not [string]::Equals($installed.Principal.UserId, $ServiceAccount, [System.StringComparison]::OrdinalIgnoreCase) -or
        $installedActions.Count -ne 1 -or
        -not [string]::Equals($installedActions[0].Execute, $powerShellExecutable, [System.StringComparison]::OrdinalIgnoreCase) -or
        $installedActions[0].Arguments -ne $arguments) {
        throw 'The installed control-plane task did not match its fixed definition.'
    }
    if ($existingTaskWasRunning) { Start-ScheduledTask -InputObject $installed -ErrorAction Stop }
}
catch {
    $installError = $_
    try {
        if ($taskRegistrationAttempted) {
            Remove-DysonControlTaskForRollback -TaskName $TaskName
            [void](Restore-DysonControlTaskRollbackState -State $taskRollbackState -TaskName $TaskName)
        }
        elseif ($existingTaskStopped -and $existingTaskWasRunning) {
            Start-ScheduledTask -TaskName $TaskName -TaskPath $script:DysonControlTaskPath -ErrorAction Stop
        }
        $restoredAcl = Microsoft.PowerShell.Security\Get-Acl -LiteralPath $dataFull -ErrorAction Stop
        $restoredAcl.SetSecurityDescriptorSddlForm($originalDataSddl)
        Microsoft.PowerShell.Security\Set-Acl -LiteralPath $dataFull -AclObject $restoredAcl -ErrorAction Stop
        Write-DysonDeploymentAudit -DataRoot $dataFull -Operation 'install-control-task' -Outcome 'failed-rolled-back' -SnapshotId $backupId -Code 'TASK_INSTALL_ROLLED_BACK'
    }
    catch {
        Write-DysonDeploymentAudit -DataRoot $dataFull -Operation 'install-control-task' -Outcome 'failed-rollback-failed' -SnapshotId $backupId -Code 'TASK_INSTALL_ROLLBACK_FAILED'
        throw 'Control-plane task installation failed and the previous task could not be restored.'
    }
    throw $installError
}

Write-DysonDeploymentAudit -DataRoot $dataFull -Operation 'install-control-task' -Outcome 'succeeded' -SnapshotId $(if ($hadExistingTask) { $backupId } else { $null }) -Code 'TASK_INSTALL_SUCCEEDED'
[ordered]@{
    protocol = $script:DysonDeploymentProtocol
    state = 'installed'
    taskName = $TaskName
    serviceAccountConfigured = $true
    previousTaskBackedUp = $hadExistingTask
    previousTaskWasRunning = $existingTaskWasRunning
    replacementTaskRestarted = $existingTaskWasRunning
    taskBackupId = if ($hadExistingTask) { $backupId } else { $null }
    loopbackForcedByLauncher = $true
    gameTasksChanged = $false
} | ConvertTo-DysonJsonLine
}
finally {
    if ($ownsDeploymentLock -and $deploymentLock) { $deploymentLock.Dispose() }
}
