[CmdletBinding(SupportsShouldProcess, ConfirmImpact = 'High')]
param(
    [string]$InstallRoot = (Join-Path $env:ProgramFiles 'DysonControl'),
    [string]$DataRoot = (Join-Path $env:ProgramData 'DysonControl'),
    [Parameter(Mandatory)][string]$RuntimeRoot,
    [Parameter(Mandatory)][string]$NodeExecutable,
    [Parameter(Mandatory)][ValidatePattern('^[0-9a-f]{64}$')][string]$ExpectedNodeSha256,
    [ValidatePattern('^[\p{L}\p{N}_. -]{1,128}$')][string]$TaskName = 'Dyson-Control-Plane',
    [ValidateSet('NT AUTHORITY\LOCAL SERVICE')]
    [string]$ServiceAccount = 'NT AUTHORITY\LOCAL SERVICE',
    [string]$EnvironmentFile,
    [ValidateRange(1, 120)][int]$LockTimeoutSeconds = 30,
    [Parameter(DontShow)][System.IO.FileStream]$ExistingDeploymentLock,
    [Parameter(DontShow)][switch]$SelfTestSkipAdministratorCheck,
    [Parameter(DontShow)][string]$SelfTestConfigurationShadowRoot
)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
. (Join-Path $PSScriptRoot 'DysonDeployment.Common.ps1')
. (Join-Path $PSScriptRoot 'DysonDeployment.Configuration.ps1')

$installFull = Assert-DysonSafeRoot -Path $InstallRoot -Name 'InstallRoot'
$dataFull = Assert-DysonSafeRoot -Path $DataRoot -Name 'DataRoot'
$bootstrapRoot = Join-Path $installFull 'bootstrap'
$launcherPath = Join-Path $bootstrapRoot 'Start-DysonControl.ps1'
$commonPath = Join-Path $bootstrapRoot 'DysonDeployment.Common.ps1'
foreach ($required in @($launcherPath, $commonPath)) {
    if (-not (Test-Path -LiteralPath $required -PathType Leaf)) { throw "Installed bootstrap file is missing: $required" }
}
$nodeProtection = Assert-DysonNodeRuntimeProtection -RuntimeRoot $RuntimeRoot `
    -NodeExecutable $NodeExecutable -ExpectedNodeSha256 $ExpectedNodeSha256 `
    -InstallRoot $installFull -DataRoot $dataFull
$runtimeFull = [string]$nodeProtection.runtimeRoot
$nodePath = [string]$nodeProtection.nodeExecutable
$active = Get-DysonActiveRelease -InstallRoot $installFull -DataRoot $dataFull
if (-not $active) { throw 'No Dyson Control release is active.' }
$fixedEnvironmentFile = Join-Path (Join-Path $dataFull 'config') 'dyson-control.env'
if (-not $EnvironmentFile) { $EnvironmentFile = $fixedEnvironmentFile }
$environmentFull = Get-DysonFullPath -Path $EnvironmentFile
if (-not [string]::Equals(
        $environmentFull,
        (Get-DysonFullPath -Path $fixedEnvironmentFile),
        [System.StringComparison]::OrdinalIgnoreCase
    )) {
    throw 'EnvironmentFile must be the fixed protected deployment configuration file.'
}
if (-not (Test-Path -LiteralPath $environmentFull -PathType Leaf)) {
    throw 'The production environment file must exist before the startup task is installed.'
}
foreach ($argumentPath in @($installFull, $dataFull, $runtimeFull, $nodePath, $environmentFull, $launcherPath)) {
    if ($argumentPath -match '["\r\n]') { throw 'Scheduled-task paths cannot contain quotes or line breaks.' }
}
if ($SelfTestSkipAdministratorCheck) {
    Assert-DysonDeploymentTaskSelfTestScope -InstallRoot $installFull -DataRoot $dataFull
}
$configurationModuleRoot = Get-DysonDeploymentConfigurationVerificationModuleRoot `
    -InstallRoot $installFull -DataRoot $dataFull `
    -SelfTestConfigurationShadowRoot $SelfTestConfigurationShadowRoot
$configurationEvidence = Invoke-DysonDeploymentConfigurationTest `
    -DataRoot $dataFull -ScriptRoot (Join-Path ([string]$active.releaseRoot) 'scripts\windows') `
    -RuntimeBootstrapRoot $bootstrapRoot -DeploymentVersion ([string]$active.pointer.version) `
    -ServiceAccount $ServiceAccount -ConfigurationModuleRoot $configurationModuleRoot

if (-not $PSCmdlet.ShouldProcess($TaskName, 'back up and install the fixed loopback Dyson Control startup task')) {
    [ordered]@{
        protocol = $script:DysonDeploymentProtocol
        state = 'preview'
        taskName = $TaskName
        serviceAccount = $ServiceAccount
        launcher = $launcherPath
        runtimeRootIdentity = [string]$nodeProtection.runtimeRootIdentity
        nodeExecutableSha256 = [string]$nodeProtection.nodeExecutableSha256
        nodeRuntimeProtected = $true
        nodeRuntimeWillBeVerified = $true
        configurationSha256 = [string]$configurationEvidence.configurationSha256
        configurationLength = [int64]$configurationEvidence.configurationLength
        configurationNamesSha256 = [string]$configurationEvidence.configurationNamesSha256
        configurationBindingsSha256 = [string]$configurationEvidence.configurationBindingsSha256
        configurationContractSha256 = [string]$configurationEvidence.configurationContractSha256
        configurationAclFingerprint = [string]$configurationEvidence.configurationAclFingerprint
        configurationParentAclFingerprint = [string]$configurationEvidence.configurationParentAclFingerprint
        gameTasksChanged = $false
    } | ConvertTo-DysonJsonLine
    exit 0
}

[void](Test-DysonNodeRuntime -RuntimeRoot $runtimeFull -NodeExecutable $nodePath `
    -ExpectedNodeSha256 $ExpectedNodeSha256 -InstallRoot $installFull -DataRoot $dataFull `
    -MinimumMajor $active.nodeMinimumMajor)
$configurationBeforeMutation = Invoke-DysonDeploymentConfigurationTest `
    -DataRoot $dataFull -ScriptRoot (Join-Path ([string]$active.releaseRoot) 'scripts\windows') `
    -RuntimeBootstrapRoot $bootstrapRoot -DeploymentVersion ([string]$active.pointer.version) `
    -ServiceAccount $ServiceAccount -ConfigurationModuleRoot $configurationModuleRoot
Assert-DysonDeploymentConfigurationEvidenceMatch `
    -Expected $configurationEvidence -Actual $configurationBeforeMutation

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
$configurationUnderLock = Invoke-DysonDeploymentConfigurationTest `
    -DataRoot $dataFull -ScriptRoot (Join-Path ([string]$active.releaseRoot) 'scripts\windows') `
    -RuntimeBootstrapRoot $bootstrapRoot -DeploymentVersion ([string]$active.pointer.version) `
    -ServiceAccount $ServiceAccount -ConfigurationModuleRoot $configurationModuleRoot
Assert-DysonDeploymentConfigurationEvidenceMatch `
    -Expected $configurationBeforeMutation -Actual $configurationUnderLock
$configurationBeforeMutation = $configurationUnderLock
$taskRollbackState = Get-DysonControlTaskRollbackState -TaskName $TaskName
Write-DysonDeploymentAudit -DataRoot $dataFull -Operation 'install-control-task' -Outcome 'started' -Code 'TASK_INSTALL_STARTED'
$backupId = (Get-Date).ToUniversalTime().ToString('yyyyMMdd-HHmmssfff') + '-' + [guid]::NewGuid().ToString('N').Substring(0, 8)
$backupPath = $null
$hadExistingTask = $false
$existingTaskWasRunning = $false
$existingTaskStopped = $false
$taskRegistrationAttempted = $false
try {
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
    $arguments = Get-DysonControlTaskActionArguments -LauncherPath $launcherPath `
        -InstallRoot $installFull -DataRoot $dataFull -RuntimeRoot $runtimeFull `
        -NodeExecutable $nodePath -ExpectedNodeSha256 $ExpectedNodeSha256 `
        -EnvironmentFile $environmentFull
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
    $installedContract = Assert-DysonControlTaskContract -Task $installed `
        -TaskName $TaskName -ExpectedPowerShellExecutable $powerShellExecutable `
        -ExpectedArguments $arguments -AllowedStates @('Ready', 'Running')
    if ($existingTaskWasRunning) {
        Start-ScheduledTask -InputObject $installed -ErrorAction Stop
        $runningTasks = @(Get-DysonScheduledTasksByExactName -TaskName $TaskName)
        if ($runningTasks.Count -ne 1) { throw 'The restarted control-plane task identity is not unique.' }
        $installedContract = Assert-DysonControlTaskContract -Task $runningTasks[0] `
            -TaskName $TaskName -ExpectedPowerShellExecutable $powerShellExecutable `
            -ExpectedArguments $arguments -AllowedStates @('Running')
    }
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
    taskContractIdentity = [string]$installedContract.taskIdentity
    loopbackForcedByLauncher = $true
    runtimeRootIdentity = [string]$nodeProtection.runtimeRootIdentity
    nodeExecutableSha256 = [string]$nodeProtection.nodeExecutableSha256
    nodeRuntimeProtected = $true
    configurationSha256 = [string]$configurationBeforeMutation.configurationSha256
    configurationLength = [int64]$configurationBeforeMutation.configurationLength
    configurationNamesSha256 = [string]$configurationBeforeMutation.configurationNamesSha256
    configurationBindingsSha256 = [string]$configurationBeforeMutation.configurationBindingsSha256
    configurationContractSha256 = [string]$configurationBeforeMutation.configurationContractSha256
    configurationAclFingerprint = [string]$configurationBeforeMutation.configurationAclFingerprint
    configurationParentAclFingerprint = [string]$configurationBeforeMutation.configurationParentAclFingerprint
    runtimeChanged = $false
    gameTasksChanged = $false
} | ConvertTo-DysonJsonLine
}
finally {
    if ($ownsDeploymentLock -and $deploymentLock) { $deploymentLock.Dispose() }
}
