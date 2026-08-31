[CmdletBinding(SupportsShouldProcess, ConfirmImpact = 'High')]
param(
    [Parameter(Mandatory)][string]$SourcePath,
    [Parameter(Mandatory)][string]$Version,
    [Parameter(Mandatory)][string]$NodeExecutable,
    [string]$InstallRoot = (Join-Path $env:ProgramFiles 'DysonControl'),
    [string]$DataRoot = (Join-Path $env:ProgramData 'DysonControl'),
    [string]$EntryPointRelativePath = 'apps\api\dist\index.js',
    [string]$ConfigurationSource,
    [switch]$RegisterStartupTask,
    [switch]$StartAfterInstall,
    [ValidatePattern('^[\p{L}\p{N}_. -]{1,128}$')][string]$TaskName = 'Dyson-Control-Plane',
    [ValidateSet('NT AUTHORITY\LOCAL SERVICE', 'NT AUTHORITY\NETWORK SERVICE', 'SYSTEM')]
    [string]$ServiceAccount = 'NT AUTHORITY\LOCAL SERVICE',
    [uri]$ReadinessUri,
    [ValidateRange(1, 300)][int]$ReadinessTimeoutSeconds = 30,
    [ValidateRange(1, 120)][int]$LockTimeoutSeconds = 30,
    [Parameter(DontShow)][switch]$SelfTestSkipAdministratorCheck
)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
. (Join-Path $PSScriptRoot 'DysonDeployment.Common.ps1')

$installFull = Assert-DysonSafeRoot -Path $InstallRoot -Name 'InstallRoot'
$dataFull = Assert-DysonSafeRoot -Path $DataRoot -Name 'DataRoot'
$sourceFull = Assert-DysonPlainDirectory -Path $SourcePath
$nodePath = Resolve-DysonNodeExecutablePath -NodeExecutable $NodeExecutable
Assert-DysonVersion -Version $Version
Assert-DysonRelativePath -Path $EntryPointRelativePath -Name 'EntryPointRelativePath'
$sourceArtifactVerification = Test-DysonSourceArtifact -SourcePath $sourceFull -ExpectedVersion $Version `
    -ExpectedEntryPoint $EntryPointRelativePath
if ($ConfigurationSource) {
    $configurationFull = (Resolve-Path -LiteralPath $ConfigurationSource -ErrorAction Stop).ProviderPath
    if (-not (Test-Path -LiteralPath $configurationFull -PathType Leaf)) { throw 'ConfigurationSource must be a file.' }
}
else { $configurationFull = $null }
$prospectiveConfigurationPath = Join-Path (Join-Path $dataFull 'config') 'dyson-control.env'
if ($RegisterStartupTask -and -not $configurationFull -and
    -not (Test-Path -LiteralPath $prospectiveConfigurationPath -PathType Leaf)) {
    throw 'RegisterStartupTask requires ConfigurationSource or an existing local dyson-control.env file.'
}
if ($StartAfterInstall -and -not $RegisterStartupTask) { throw 'StartAfterInstall requires RegisterStartupTask.' }
if ($StartAfterInstall -and -not $ReadinessUri) { throw 'StartAfterInstall requires a loopback ReadinessUri.' }
if ($ReadinessUri -and ($ReadinessUri.Scheme -ne 'http' -or $ReadinessUri.AbsolutePath -ne '/readyz' -or
    $ReadinessUri.Host -notin @('127.0.0.1', 'localhost', '::1'))) {
    throw 'ReadinessUri must be a loopback HTTP /readyz endpoint.'
}
if ($SelfTestSkipAdministratorCheck) {
    Assert-DysonDeploymentTaskSelfTestScope -InstallRoot $installFull -DataRoot $dataFull
}

if (-not $PSCmdlet.ShouldProcess("$installFull; $dataFull", "install and activate Dyson Control $Version")) {
    [ordered]@{
        protocol = $script:DysonDeploymentProtocol
        state = 'preview'
        version = $Version
        installRoot = $installFull
        dataRoot = $dataFull
        registerStartupTask = [bool]$RegisterStartupTask
        startAfterInstall = [bool]$StartAfterInstall
        existingConfigurationWillBePreserved = $true
        gameTasksChanged = $false
    } | ConvertTo-DysonJsonLine
    exit 0
}

[void](Test-DysonNodeRuntime -NodeExecutable $nodePath `
    -MinimumMajor $sourceArtifactVerification.nodeMinimumMajor)

if ($RegisterStartupTask -and -not $SelfTestSkipAdministratorCheck) {
    $identity = [System.Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = [System.Security.Principal.WindowsPrincipal]::new($identity)
    if (-not $principal.IsInRole([System.Security.Principal.WindowsBuiltInRole]::Administrator)) {
        throw 'Administrator rights are required when RegisterStartupTask is selected.'
    }
}

$deploymentLock = Enter-DysonDeploymentLock -DataRoot $dataFull -TimeoutSeconds $LockTimeoutSeconds
try {
    [void](New-DysonDirectory -Path $installFull)
    [void](New-DysonDirectory -Path $dataFull)
    foreach ($relative in @('config', 'data', 'logs', 'state', 'snapshots', 'audit')) {
        [void](New-DysonDirectory -Path (Join-Path $dataFull $relative))
    }
    Write-DysonDeploymentAudit -DataRoot $dataFull -Operation 'install' -Outcome 'started' -Version $Version -Code 'INSTALL_STARTED'

$configurationPath = Join-Path (Join-Path $dataFull 'config') 'dyson-control.env'
$configurationCreated = $false
$examplePath = Join-Path (Join-Path $dataFull 'config') 'dyson-control.env.example'
$bootstrapRoot = Join-Path $installFull 'bootstrap'
$bootstrapHadPrevious = Test-Path -LiteralPath $bootstrapRoot -PathType Container
$bootstrapBackup = $null
$newBootstrap = Join-Path $installFull ('.bootstrap-' + [guid]::NewGuid().ToString('N'))
$oldBootstrap = Join-Path $installFull ('.bootstrap-old-' + [guid]::NewGuid().ToString('N'))
$deploymentResult = $null
$taskRollbackState = $null
$taskRollbackPrepared = $false
$taskDataAclRollbackSddl = $null
try {
    if (-not (Test-Path -LiteralPath $configurationPath -PathType Leaf)) {
        if ($configurationFull) {
            Copy-Item -LiteralPath $configurationFull -Destination $configurationPath -Force -ErrorAction Stop
            $configurationCreated = $true
        }
        elseif (-not (Test-Path -LiteralPath $examplePath -PathType Leaf)) {
            $example = @(
                '# Copy this file to dyson-control.env and provide production-only secrets locally.'
                'NODE_ENV=production'
                'DYSON_HOST=127.0.0.1'
                'DYSON_PORT=13010'
                'DYSON_PROVIDER=demo'
                'DYSON_PUBLIC_ORIGIN=https://game.example.com'
                'DYSON_LIFECYCLE_ENABLED=false'
                '# DYSON_ADMIN_PASSWORD_HASH=scrypt$...'
                '# DYSON_SESSION_SECRET=at-least-32-random-characters'
            ) -join "`r`n"
            [System.IO.File]::WriteAllText($examplePath, $example + "`r`n", [System.Text.UTF8Encoding]::new($false))
        }
    }

    if ($bootstrapHadPrevious) {
        $bootstrapBackupCandidate = Join-Path (Join-Path (Join-Path $dataFull 'snapshots') 'bootstrap') ((Get-Date).ToUniversalTime().ToString('yyyyMMdd-HHmmssfff') + '-' + [guid]::NewGuid().ToString('N').Substring(0, 8))
        Copy-DysonDirectoryContents -Source $bootstrapRoot -Destination $bootstrapBackupCandidate
        $bootstrapBackup = $bootstrapBackupCandidate
    }
    [System.IO.Directory]::CreateDirectory($newBootstrap) | Out-Null
    foreach ($name in @('DysonDeployment.Common.ps1', 'Start-DysonControl.ps1')) {
        Copy-Item -LiteralPath (Join-Path $PSScriptRoot $name) -Destination (Join-Path $newBootstrap $name) -Force -ErrorAction Stop
    }
    if (Test-Path -LiteralPath $bootstrapRoot) { [System.IO.Directory]::Move($bootstrapRoot, $oldBootstrap) }
    [System.IO.Directory]::Move($newBootstrap, $bootstrapRoot)
    if (Test-Path -LiteralPath $oldBootstrap) { Remove-Item -LiteralPath $oldBootstrap -Recurse -Force }

    $deploymentOutput = & (Join-Path $PSScriptRoot 'Invoke-DysonControlDeployment.ps1') `
        -Operation Upgrade `
        -SourcePath $sourceFull `
        -Version $Version `
        -InstallRoot $installFull `
        -DataRoot $dataFull `
        -EntryPointRelativePath $EntryPointRelativePath `
        -ExistingDeploymentLock $deploymentLock `
        -Confirm:$false
    $deploymentResult = ($deploymentOutput | Out-String).Trim() | ConvertFrom-Json

    if ($RegisterStartupTask) {
        $taskRollbackState = Get-DysonControlTaskRollbackState -TaskName $TaskName
        $taskDataAclRollbackSddl = (Microsoft.PowerShell.Security\Get-Acl -LiteralPath $dataFull -ErrorAction Stop).Sddl
        $taskRollbackPrepared = $true
        $taskInstallOutput = & (Join-Path $PSScriptRoot 'Install-DysonControlTask.ps1') `
            -InstallRoot $installFull `
            -DataRoot $dataFull `
            -NodeExecutable $nodePath `
            -TaskName $TaskName `
            -ServiceAccount $ServiceAccount `
            -EnvironmentFile $configurationPath `
            -ExistingDeploymentLock $deploymentLock `
            -SelfTestSkipAdministratorCheck:$SelfTestSkipAdministratorCheck `
            -Confirm:$false
        $taskInstallLines = @(
            ($taskInstallOutput | Out-String) -split "`r?`n" |
                Where-Object { -not [string]::IsNullOrWhiteSpace($_) }
        )
        if ($taskInstallLines.Count -eq 0) { throw 'The control-plane task installer returned no receipt.' }
        $taskInstallReceipt = $taskInstallLines[$taskInstallLines.Count - 1] | ConvertFrom-Json -ErrorAction Stop
        if ([string]$taskInstallReceipt.protocol -cne $script:DysonDeploymentProtocol -or
            [string]$taskInstallReceipt.state -cne 'installed' -or
            [string]$taskInstallReceipt.taskName -cne $TaskName) {
            throw 'The control-plane task installer returned an unsupported receipt.'
        }
    }
    if ($StartAfterInstall) {
        Start-ScheduledTask -TaskName $TaskName -TaskPath $script:DysonControlTaskPath -ErrorAction Stop
        [void](Test-DysonLoopbackReadiness -ReadinessUri $ReadinessUri -ExpectedVersion $Version -TimeoutSeconds $ReadinessTimeoutSeconds)
    }
}
catch {
    $installError = $_
    $rollbackFailures = New-Object System.Collections.Generic.List[string]
    $replacementTaskRemoved = -not $taskRollbackPrepared
    if ($taskRollbackPrepared) {
        try {
            Remove-DysonControlTaskForRollback -TaskName $TaskName
            $replacementTaskRemoved = $true
        }
        catch { $rollbackFailures.Add('replacement-task-stop-remove') }
    }

    $deploymentStateRestored = -not [bool]($deploymentResult -and $deploymentResult.snapshotId)
    if ($replacementTaskRemoved) {
        try {
            if ($deploymentResult -and $deploymentResult.snapshotId) {
                & (Join-Path $PSScriptRoot 'Invoke-DysonControlDeployment.ps1') `
                    -Operation Rollback `
                    -SnapshotId ([string]$deploymentResult.snapshotId) `
                    -InstallRoot $installFull `
                    -DataRoot $dataFull `
                    -ExistingDeploymentLock $deploymentLock `
                    -Confirm:$false | Out-Null
            }
            $deploymentStateRestored = $true
        }
        catch { $rollbackFailures.Add('deployment-state') }
    }
    else { $rollbackFailures.Add('deployment-state-blocked-by-task') }

    $bootstrapConfigurationRestored = $false
    if ($replacementTaskRemoved -and $deploymentStateRestored) {
        try {
            if ($bootstrapBackup -and (Test-Path -LiteralPath $bootstrapBackup -PathType Container)) {
                if (Test-Path -LiteralPath $bootstrapRoot) { Remove-Item -LiteralPath $bootstrapRoot -Recurse -Force }
                Copy-DysonDirectoryContents -Source $bootstrapBackup -Destination $bootstrapRoot
            }
            elseif (-not $bootstrapHadPrevious -and (Test-Path -LiteralPath $bootstrapRoot)) {
                Remove-Item -LiteralPath $bootstrapRoot -Recurse -Force
            }
            if (Test-Path -LiteralPath $oldBootstrap) {
                if (-not (Test-Path -LiteralPath $bootstrapRoot)) { [System.IO.Directory]::Move($oldBootstrap, $bootstrapRoot) }
                else { Remove-Item -LiteralPath $oldBootstrap -Recurse -Force }
            }
            if (Test-Path -LiteralPath $newBootstrap) { Remove-Item -LiteralPath $newBootstrap -Recurse -Force }
            if ($configurationCreated -and (Test-Path -LiteralPath $configurationPath -PathType Leaf)) {
                Remove-Item -LiteralPath $configurationPath -Force
            }
            $bootstrapConfigurationRestored = $true
        }
        catch { $rollbackFailures.Add('bootstrap-configuration') }
    }
    else { $rollbackFailures.Add('bootstrap-configuration-blocked') }

    if ($taskRollbackPrepared -and $replacementTaskRemoved -and
        $deploymentStateRestored -and $bootstrapConfigurationRestored) {
        try {
            [void](Restore-DysonControlTaskRollbackState -State $taskRollbackState -TaskName $TaskName)
            $restoredDataAcl = Microsoft.PowerShell.Security\Get-Acl -LiteralPath $dataFull -ErrorAction Stop
            $restoredDataAcl.SetSecurityDescriptorSddlForm($taskDataAclRollbackSddl)
            Microsoft.PowerShell.Security\Set-Acl -LiteralPath $dataFull -AclObject $restoredDataAcl -ErrorAction Stop
            if ((Microsoft.PowerShell.Security\Get-Acl -LiteralPath $dataFull -ErrorAction Stop).Sddl -ne $taskDataAclRollbackSddl) {
                throw 'The deployment data ACL did not return to its pre-install state.'
            }
        }
        catch { $rollbackFailures.Add('previous-task-restore') }
    }
    elseif ($taskRollbackPrepared) { $rollbackFailures.Add('previous-task-restore-blocked') }
    if ($rollbackFailures.Count -eq 0) {
        try {
        Write-DysonDeploymentAudit -DataRoot $dataFull -Operation 'install' -Outcome 'failed-rolled-back' -Version $Version -SnapshotId $(
            if ($deploymentResult) { [string]$deploymentResult.snapshotId } else { $null }
        ) -Code 'INSTALL_ROLLED_BACK'
        }
        catch { $rollbackFailures.Add('rollback-audit') }
    }
    if ($rollbackFailures.Count -gt 0) {
        try {
            Write-DysonDeploymentAudit -DataRoot $dataFull -Operation 'install' -Outcome 'failed-rollback-failed' -Version $Version -Code 'INSTALL_ROLLBACK_FAILED'
        }
        catch { }
        throw ('Installation failed ({0}); automatic rollback was incomplete in: {1}.' -f
            $installError.Exception.Message, [string]::Join(', ', @($rollbackFailures)))
    }
    throw $installError
}

Write-DysonDeploymentAudit -DataRoot $dataFull -Operation 'install' -Outcome 'succeeded' -Version $Version -SnapshotId ([string]$deploymentResult.snapshotId) -Code 'INSTALL_SUCCEEDED'
[ordered]@{
    protocol = $script:DysonDeploymentProtocol
    state = 'installed'
    version = $Version
    deploymentSnapshotId = [string]$deploymentResult.snapshotId
    configurationCreated = $configurationCreated
    configurationReady = Test-Path -LiteralPath $configurationPath -PathType Leaf
    startupTaskInstalled = [bool]$RegisterStartupTask
    readinessVerified = [bool]$StartAfterInstall
    loopbackForcedByLauncher = $true
    persistentDataReady = Test-Path -LiteralPath (Join-Path $dataFull 'data') -PathType Container
    gameTasksChanged = $false
    } | ConvertTo-DysonJsonLine
}
finally {
    if ($deploymentLock) { $deploymentLock.Dispose() }
}
