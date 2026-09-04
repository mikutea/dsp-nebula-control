[CmdletBinding()]
param(
    [string]$InstallRoot = (Join-Path $env:ProgramFiles 'DysonControl'),
    [string]$DataRoot = (Join-Path $env:ProgramData 'DysonControl'),
    [Parameter(Mandatory)][string]$RuntimeRoot,
    [Parameter(Mandatory)][string]$NodeExecutable,
    [Parameter(Mandatory)][ValidatePattern('^[0-9a-f]{64}$')][string]$ExpectedNodeSha256,
    [ValidatePattern('^[\p{L}\p{N}_. -]{1,128}$')][string]$TaskName = 'Dyson-Control-Plane',
    [switch]$IncludeTask,
    [uri]$ReadinessUri,
    [Parameter(DontShow)][string]$SelfTestConfigurationShadowRoot
)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
. (Join-Path $PSScriptRoot 'DysonDeployment.Common.ps1')
. (Join-Path $PSScriptRoot 'DysonDeployment.Configuration.ps1')

$installFull = Assert-DysonSafeRoot -Path $InstallRoot -Name 'InstallRoot'
$dataFull = Assert-DysonSafeRoot -Path $DataRoot -Name 'DataRoot'
$checks = New-Object System.Collections.Generic.List[object]
function Add-Check {
    param([string]$Code, [bool]$Passed, [string]$Summary)
    $checks.Add([ordered]@{ code = $Code; passed = $Passed; summary = $Summary })
}

Add-Check -Code 'INSTALL_ROOT' -Passed (Test-Path -LiteralPath $installFull -PathType Container) -Summary 'Versioned install root exists.'
Add-Check -Code 'DATA_ROOT' -Passed (Test-Path -LiteralPath $dataFull -PathType Container) -Summary 'Persistent data root exists.'
Add-Check -Code 'CUTOVER_DATA' -Passed (Test-Path -LiteralPath (Join-Path $dataFull 'data\cutover') -PathType Container) `
    -Summary 'The durable cutover journal and audit directory exists.'
$activeVersion = $null
$active = $null
try {
    $active = Get-DysonActiveRelease -InstallRoot $installFull -DataRoot $dataFull
    if ($active) {
        $activeVersion = [string]$active.pointer.version
        Add-Check -Code 'ACTIVE_RELEASE' -Passed $true -Summary 'The active pointer and immutable release manifest match.'
    }
    else { Add-Check -Code 'ACTIVE_RELEASE' -Passed $false -Summary 'No release is active.' }
}
catch { Add-Check -Code 'ACTIVE_RELEASE' -Passed $false -Summary 'The active release failed integrity validation.' }

$nodeProtection = $null
try {
    if (-not $active) { throw 'No active release is available for Node.js runtime validation.' }
    $nodeProtection = Test-DysonNodeRuntime -RuntimeRoot $RuntimeRoot `
        -NodeExecutable $NodeExecutable -ExpectedNodeSha256 $ExpectedNodeSha256 `
        -InstallRoot $installFull -DataRoot $dataFull -MinimumMajor $active.nodeMinimumMajor
    Add-Check -Code 'NODE_RUNTIME' -Passed $true `
        -Summary 'The independent Node.js runtime hash, path chain, ACL, and version are valid.'
}
catch {
    Add-Check -Code 'NODE_RUNTIME' -Passed $false `
        -Summary 'The independent Node.js runtime failed hash, path, ACL, or version validation.'
}

$configPath = Join-Path (Join-Path $dataFull 'config') 'dyson-control.env'
Add-Check -Code 'PRODUCTION_CONFIG' -Passed (Test-Path -LiteralPath $configPath -PathType Leaf) -Summary 'The local production environment file exists.'
$launcherPath = Join-Path (Join-Path $installFull 'bootstrap') 'Start-DysonControl.ps1'
Add-Check -Code 'FIXED_LAUNCHER' -Passed (Test-Path -LiteralPath $launcherPath -PathType Leaf) -Summary 'The stable loopback launcher exists.'
$configurationEvidence = $null
$configurationModuleRoot = $null
try {
    if (-not $active) { throw 'No active release is available for protected configuration validation.' }
    $configurationModuleRoot = Get-DysonDeploymentConfigurationVerificationModuleRoot `
        -InstallRoot $installFull -DataRoot $dataFull `
        -SelfTestConfigurationShadowRoot $SelfTestConfigurationShadowRoot
    $configurationEvidence = Invoke-DysonDeploymentConfigurationTest `
        -DataRoot $dataFull -ScriptRoot (Join-Path ([string]$active.releaseRoot) 'scripts\windows') `
        -RuntimeBootstrapRoot (Join-Path $installFull 'bootstrap') `
        -DeploymentVersion ([string]$active.pointer.version) `
        -ServiceAccount 'NT AUTHORITY\LOCAL SERVICE' -ConfigurationModuleRoot $configurationModuleRoot
    Add-Check -Code 'PROTECTED_CONFIGURATION' -Passed $true `
        -Summary 'The production configuration contract, bindings, transaction chain, and ACLs are valid.'
}
catch {
    Add-Check -Code 'PROTECTED_CONFIGURATION' -Passed $false `
        -Summary 'The production configuration failed contract, binding, transaction, or ACL validation.'
}

$qualifiedClientStoragePlan = $null
$qualifiedClientStorageStatus = $null
try {
    if (-not $configurationEvidence) { throw 'The protected configuration is not valid.' }
    $qualifiedClientEnvironment = Read-DysonDeploymentStatusEnvironmentFile -Path $configPath
    try {
        $qualifiedClientStoragePlan = Get-DysonQualifiedClientStoragePlan `
            -Configured $qualifiedClientEnvironment -DataRoot $dataFull
    }
    finally { $qualifiedClientEnvironment.Clear() }
    $qualifiedClientStorageStatus = Test-DysonQualifiedClientStorage `
        -Plan $qualifiedClientStoragePlan -ServiceAccount 'NT AUTHORITY\LOCAL SERVICE' `
        -AllowSelfTestAdministrator:($env:DYSON_DEPLOYMENT_ALLOW_SELFTEST_TASKS -ceq 'true')
    Add-Check -Code 'QUALIFIED_CLIENT_STORAGE' -Passed ([bool]$qualifiedClientStorageStatus.ready) `
        -Summary $(if ([bool]$qualifiedClientStorageStatus.configured) {
            'The qualified-client V2 fixed roots and ACLs are valid.'
        } else { 'Qualified-client V2 storage is not configured.' })
}
catch {
    Add-Check -Code 'QUALIFIED_CLIENT_STORAGE' -Passed $false `
        -Summary 'The qualified-client V2 environment binding, fixed roots, or ACLs are invalid.'
}

$lifecycleBrokerReady = $false
$lifecycleBrokerState = 'invalid'
try {
    if (-not $active) { throw 'No active release is available for lifecycle broker validation.' }
    $lifecycleBrokerStatus = Get-DysonLifecycleBrokerStaticStatus -InstallRoot $installFull -DataRoot $dataFull `
        -ActiveRelease $active -EnvironmentFile $configPath
    $lifecycleBrokerReady = [bool]$lifecycleBrokerStatus.ready
    $lifecycleBrokerState = [string]$lifecycleBrokerStatus.state
    Add-Check -Code 'LIFECYCLE_BROKER' -Passed ([bool]$lifecycleBrokerStatus.consistent) `
        -Summary ('The lifecycle broker static state is ' + $lifecycleBrokerState + '.')
}
catch {
    Add-Check -Code 'LIFECYCLE_BROKER' -Passed $false `
        -Summary 'The lifecycle broker profile, tasks, or pending state failed static validation.'
}

$taskState = 'not-checked'
if ($IncludeTask) {
    try {
        $tasks = @(Get-DysonScheduledTasksByExactName -TaskName $TaskName)
        if ($tasks.Count -ne 1) { throw 'The control-plane task identity is not unique.' }
        $task = $tasks[0]
        $taskState = $task.State.ToString().ToLowerInvariant()
        if (-not $nodeProtection) { throw 'The Node.js runtime is not valid.' }
        $launcherFull = Get-DysonFullPath -Path $launcherPath
        $environmentFull = Get-DysonFullPath -Path $configPath
        $expectedArguments = Get-DysonControlTaskActionArguments -LauncherPath $launcherFull `
            -InstallRoot $installFull -DataRoot $dataFull `
            -RuntimeRoot ([string]$nodeProtection.runtimeRoot) `
            -NodeExecutable ([string]$nodeProtection.nodeExecutable) `
            -ExpectedNodeSha256 $ExpectedNodeSha256 -EnvironmentFile $environmentFull
        $powerShellExecutable = Join-Path $env:SystemRoot `
            'System32\WindowsPowerShell\v1.0\powershell.exe'
        [void](Assert-DysonControlTaskContract -Task $task -TaskName $TaskName `
            -ExpectedPowerShellExecutable $powerShellExecutable `
            -ExpectedArguments $expectedArguments -AllowedStates @('Running'))
        Add-Check -Code 'CONTROL_TASK' -Passed $true `
            -Summary 'The fixed running control-plane startup task matches its complete contract.'
    }
    catch { Add-Check -Code 'CONTROL_TASK' -Passed $false -Summary 'The control-plane startup task is unavailable.' }
}

$readinessPassed = $null
if ($ReadinessUri) {
    try {
        if (-not $activeVersion) { throw 'No active release is available for version-bound readiness validation.' }
        if (-not $configurationEvidence) { throw 'The protected configuration is not valid.' }
        $readinessConfiguration = Invoke-DysonDeploymentConfigurationTest `
            -DataRoot $dataFull -ScriptRoot (Join-Path ([string]$active.releaseRoot) 'scripts\windows') `
            -RuntimeBootstrapRoot (Join-Path $installFull 'bootstrap') `
            -DeploymentVersion ([string]$active.pointer.version) `
            -ServiceAccount 'NT AUTHORITY\LOCAL SERVICE' -ConfigurationModuleRoot $configurationModuleRoot
        Assert-DysonDeploymentConfigurationEvidenceMatch `
            -Expected $configurationEvidence -Actual $readinessConfiguration
        $readinessRuntime = Assert-DysonNodeRuntimeProtection -RuntimeRoot $RuntimeRoot `
            -NodeExecutable $NodeExecutable -ExpectedNodeSha256 $ExpectedNodeSha256 `
            -InstallRoot $installFull -DataRoot $dataFull
        if (-not $nodeProtection -or
            [string]$readinessRuntime.nodeExecutableSha256 -cne [string]$nodeProtection.nodeExecutableSha256 -or
            [string]$readinessRuntime.runtimeRootIdentity -cne [string]$nodeProtection.runtimeRootIdentity) {
            throw 'The Node.js runtime identity changed before readiness validation.'
        }
        [void](Test-DysonLoopbackReadiness -ReadinessUri $ReadinessUri -ExpectedVersion $activeVersion `
            -RequiredChecks @('lifecycleBroker', 'cutoverRecovery') -TimeoutSeconds 2)
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
    lifecycleBrokerReady = $lifecycleBrokerReady
    lifecycleBrokerState = $lifecycleBrokerState
    readinessVerified = $readinessPassed
    runtimeRootIdentity = if ($nodeProtection) { [string]$nodeProtection.runtimeRootIdentity } else { $null }
    nodeExecutableSha256 = if ($nodeProtection) { [string]$nodeProtection.nodeExecutableSha256 } else { $ExpectedNodeSha256 }
    nodeRuntimeProtected = [bool]($nodeProtection)
    qualifiedClientStorageConfigured = [bool]($qualifiedClientStorageStatus -and
        [bool]$qualifiedClientStorageStatus.configured)
    qualifiedClientProfileEnabled = [bool]($qualifiedClientStorageStatus -and
        [bool]$qualifiedClientStorageStatus.enabled)
    qualifiedClientStorageReady = [bool]($qualifiedClientStorageStatus -and
        [bool]$qualifiedClientStorageStatus.ready)
    qualifiedClientStorageLayoutSha256 = if ($qualifiedClientStorageStatus) {
        [string]$qualifiedClientStorageStatus.layoutSha256
    } else { $null }
    qualifiedClientStorageDirectoryCount = if ($qualifiedClientStorageStatus) {
        [int]$qualifiedClientStorageStatus.directoryCount
    } else { 0 }
    configurationSha256 = if ($configurationEvidence) { [string]$configurationEvidence.configurationSha256 } else { $null }
    configurationLength = if ($configurationEvidence) { [int64]$configurationEvidence.configurationLength } else { $null }
    configurationNamesSha256 = if ($configurationEvidence) { [string]$configurationEvidence.configurationNamesSha256 } else { $null }
    configurationBindingsSha256 = if ($configurationEvidence) { [string]$configurationEvidence.configurationBindingsSha256 } else { $null }
    configurationContractSha256 = if ($configurationEvidence) { [string]$configurationEvidence.configurationContractSha256 } else { $null }
    configurationAclFingerprint = if ($configurationEvidence) { [string]$configurationEvidence.configurationAclFingerprint } else { $null }
    configurationParentAclFingerprint = if ($configurationEvidence) { [string]$configurationEvidence.configurationParentAclFingerprint } else { $null }
    checks = $checks
} | ConvertTo-Json -Depth 8 -Compress
