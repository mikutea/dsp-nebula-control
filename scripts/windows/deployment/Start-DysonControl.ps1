[CmdletBinding()]
param(
    [string]$InstallRoot = (Join-Path $env:ProgramFiles 'DysonControl'),
    [string]$DataRoot = (Join-Path $env:ProgramData 'DysonControl'),
    [Parameter(Mandatory)][string]$RuntimeRoot,
    [Parameter(Mandatory)][string]$NodeExecutable,
    [Parameter(Mandatory)][ValidatePattern('^[0-9a-f]{64}$')][string]$ExpectedNodeSha256,
    [string]$EnvironmentFile,
    [Parameter(DontShow)][string]$SelfTestConfigurationShadowRoot
)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
. (Join-Path $PSScriptRoot 'DysonDeployment.Common.ps1')
. (Join-Path $PSScriptRoot 'DysonDeployment.Configuration.ps1')

$installFull = Assert-DysonSafeRoot -Path $InstallRoot -Name 'InstallRoot'
$dataFull = Assert-DysonSafeRoot -Path $DataRoot -Name 'DataRoot'
if (-not $EnvironmentFile) { $EnvironmentFile = Join-Path (Join-Path $dataFull 'config') 'dyson-control.env' }
$environmentPath = (Resolve-Path -LiteralPath $EnvironmentFile -ErrorAction Stop).ProviderPath
$fixedEnvironmentPath = Get-DysonFullPath -Path (Join-Path (Join-Path $dataFull 'config') 'dyson-control.env')
if (-not [string]::Equals(
        (Get-DysonFullPath -Path $environmentPath),
        $fixedEnvironmentPath,
        [System.StringComparison]::OrdinalIgnoreCase
    )) {
    throw 'The production environment file must be the fixed protected deployment configuration file.'
}
$environmentItem = Get-Item -LiteralPath $environmentPath -Force -ErrorAction Stop
if ($environmentItem.PSIsContainer -or ($environmentItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -or
    $environmentItem.Length -gt 65536) {
    throw 'The production environment file is unavailable, redirected, or too large.'
}
$active = Get-DysonActiveRelease -InstallRoot $installFull -DataRoot $dataFull
if (-not $active) { throw 'No Dyson Control release is active.' }
$configurationModuleRoot = Get-DysonDeploymentConfigurationVerificationModuleRoot `
    -InstallRoot $installFull -DataRoot $dataFull `
    -SelfTestConfigurationShadowRoot $SelfTestConfigurationShadowRoot
$configurationEvidence = Invoke-DysonDeploymentConfigurationTest -RuntimeOnly `
    -DataRoot $dataFull -ScriptRoot (Join-Path ([string]$active.releaseRoot) 'scripts\windows') `
    -RuntimeBootstrapRoot (Join-Path $installFull 'bootstrap') `
    -DeploymentVersion ([string]$active.pointer.version) `
    -ServiceAccount 'NT AUTHORITY\LOCAL SERVICE' -ConfigurationModuleRoot $configurationModuleRoot
$nodeRuntime = Test-DysonNodeRuntime -RuntimeRoot $RuntimeRoot -NodeExecutable $NodeExecutable `
    -ExpectedNodeSha256 $ExpectedNodeSha256 -InstallRoot $installFull -DataRoot $dataFull `
    -MinimumMajor $active.nodeMinimumMajor
$nodePath = [string]$nodeRuntime.nodeExecutable
$selfTestRuntimeAuthorization = [ordered]@{
    allow = [System.Environment]::GetEnvironmentVariable('DYSON_DEPLOYMENT_ALLOW_SELFTEST_TASKS', 'Process')
    root = [System.Environment]::GetEnvironmentVariable('DYSON_DEPLOYMENT_SELFTEST_ROOT_IDENTITY', 'Process')
}

$configurationBeforeRead = Invoke-DysonDeploymentConfigurationTest -RuntimeOnly `
    -DataRoot $dataFull -ScriptRoot (Join-Path ([string]$active.releaseRoot) 'scripts\windows') `
    -RuntimeBootstrapRoot (Join-Path $installFull 'bootstrap') `
    -DeploymentVersion ([string]$active.pointer.version) `
    -ServiceAccount 'NT AUTHORITY\LOCAL SERVICE' -ConfigurationModuleRoot $configurationModuleRoot
Assert-DysonDeploymentConfigurationEvidenceMatch `
    -Expected $configurationEvidence -Actual $configurationBeforeRead
$configured = Read-DysonDeploymentConfigurationPrivateValues `
    -ConfigurationPath $environmentPath -DataRoot $dataFull `
    -ScriptRoot (Join-Path ([string]$active.releaseRoot) 'scripts\windows') `
    -RuntimeBootstrapRoot (Join-Path $installFull 'bootstrap') `
    -DeploymentVersion ([string]$active.pointer.version) `
    -ExpectedEvidence $configurationBeforeRead `
    -ConfigurationModuleRoot $configurationModuleRoot
$qualifiedClientStoragePlan = Get-DysonQualifiedClientStoragePlan `
    -Configured $configured -DataRoot $dataFull
$qualifiedClientStorageStatus = Test-DysonQualifiedClientStorage `
    -Plan $qualifiedClientStoragePlan -ServiceAccount 'NT AUTHORITY\LOCAL SERVICE' `
    -AllowSelfTestAdministrator:([string]$selfTestRuntimeAuthorization.allow -ceq 'true')
if (-not [bool]$qualifiedClientStorageStatus.ready) {
    throw 'The qualified-client storage contract is not ready.'
}

foreach ($entry in @(Get-ChildItem Env: | Where-Object { $_.Name -eq 'NODE_ENV' -or $_.Name -like 'DYSON_*' })) {
    Remove-Item -LiteralPath ('Env:' + $entry.Name) -ErrorAction SilentlyContinue
}
Remove-Item Env:NODE_OPTIONS -ErrorAction SilentlyContinue
Remove-Item Env:NODE_PATH -ErrorAction SilentlyContinue
foreach ($name in $configured.Keys) { [System.Environment]::SetEnvironmentVariable($name, [string]$configured[$name], 'Process') }
$configured.Clear()

[System.Environment]::SetEnvironmentVariable('NODE_ENV', 'production', 'Process')
[System.Environment]::SetEnvironmentVariable('DYSON_HOST', '127.0.0.1', 'Process')
[System.Environment]::SetEnvironmentVariable('DYSON_DATA_DIR', (Join-Path $dataFull 'data'), 'Process')
[System.Environment]::SetEnvironmentVariable('DYSON_SCRIPT_ROOT', (Join-Path $active.releaseRoot 'scripts\windows'), 'Process')
[System.Environment]::SetEnvironmentVariable('DYSON_RUNTIME_BOOTSTRAP_ROOT', (Join-Path $installFull 'bootstrap'), 'Process')
[System.Environment]::SetEnvironmentVariable('DYSON_DEPLOYMENT_VERSION', ([string]$active.pointer.version), 'Process')

[void](New-DysonDirectory -Path (Join-Path $dataFull 'data'))
[void](New-DysonDirectory -Path (Join-Path $dataFull 'logs'))
Remove-Item Env:DYSON_DEPLOYMENT_ALLOW_SELFTEST_TASKS -ErrorAction SilentlyContinue
Remove-Item Env:DYSON_DEPLOYMENT_SELFTEST_ROOT_IDENTITY -ErrorAction SilentlyContinue
if ([string]$selfTestRuntimeAuthorization.allow -ceq 'true' -and
    -not [string]::IsNullOrWhiteSpace([string]$selfTestRuntimeAuthorization.root)) {
    [System.Environment]::SetEnvironmentVariable(
        'DYSON_DEPLOYMENT_ALLOW_SELFTEST_TASKS', 'true', 'Process'
    )
    [System.Environment]::SetEnvironmentVariable(
        'DYSON_DEPLOYMENT_SELFTEST_ROOT_IDENTITY',
        [string]$selfTestRuntimeAuthorization.root,
        'Process'
    )
}
try {
    $configurationAtLaunch = Invoke-DysonDeploymentConfigurationTest -RuntimeOnly `
        -DataRoot $dataFull -ScriptRoot (Join-Path ([string]$active.releaseRoot) 'scripts\windows') `
        -RuntimeBootstrapRoot (Join-Path $installFull 'bootstrap') `
        -DeploymentVersion ([string]$active.pointer.version) `
        -ServiceAccount 'NT AUTHORITY\LOCAL SERVICE' -ConfigurationModuleRoot $configurationModuleRoot
    Assert-DysonDeploymentConfigurationEvidenceMatch `
        -Expected $configurationBeforeRead -Actual $configurationAtLaunch
    $launchProtection = Assert-DysonNodeRuntimeProtection -RuntimeRoot $RuntimeRoot `
        -NodeExecutable $nodePath -ExpectedNodeSha256 $ExpectedNodeSha256 `
        -InstallRoot $installFull -DataRoot $dataFull
}
finally {
    Remove-Item Env:DYSON_DEPLOYMENT_ALLOW_SELFTEST_TASKS -ErrorAction SilentlyContinue
    Remove-Item Env:DYSON_DEPLOYMENT_SELFTEST_ROOT_IDENTITY -ErrorAction SilentlyContinue
}
$nodePath = [string]$launchProtection.nodeExecutable
Push-Location -LiteralPath $active.releaseRoot
try {
    & $nodePath $active.entryPointPath
    $exitCode = $LASTEXITCODE
}
finally { Pop-Location }
if ($null -eq $exitCode) { $exitCode = 1 }
exit [int]$exitCode
