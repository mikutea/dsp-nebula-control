[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$ProjectRoot,
    [ValidateRange(10, 300)][int]$TimeoutSeconds = 150
)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$protocol = 'DYSON_CONTROL_GAME_BOOTSTRAP_V1'
$version = $null
$bindingId = $null
$context = $null
$stateLease = $null
$errorCode = 'BOOTSTRAP_STOP_FAILED'
try {
    $commonPath = [System.IO.Path]::Combine($PSScriptRoot, 'DysonGameLifecycleBootstrap.Common.ps1')
    $commonItem = [System.IO.FileInfo]::new($commonPath)
    $commonItem.Refresh()
    if (-not $commonItem.Exists -or ($commonItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint)) {
        throw 'bootstrap common unavailable'
    }
    . $commonItem.FullName
    $context = Get-DysonGameBootstrapContext -BootstrapRoot $PSScriptRoot
    $project = Get-DysonGameBootstrapProjectIdentity -ProjectRoot $ProjectRoot

    $errorCode = 'BOOTSTRAP_BINDING_INVALID'
    $stateLease = Enter-DysonGameBootstrapLock -Path $context.stateLockPath -TimeoutSeconds 10
    $binding = Read-DysonGameBootstrapBinding -Context $context
    if ($null -eq $binding) { throw 'binding required' }
    $bindingId = [string]$binding.bindingId
    $version = [string]$binding.version
    if ([string]$binding.projectRootSha256 -cne [string]$project.sha256 -or
        [string]$binding.dataRootIdentity -cne [string]$context.dataRootIdentity) {
        throw 'project binding mismatch'
    }
    $release = Resolve-DysonGameBootstrapBoundRelease -Context $context -Binding $binding

    $errorCode = 'BOOTSTRAP_EXPECTED_EXIT_WRITE_FAILED'
    $expectedExit = Write-DysonGameBootstrapExpectedExitRequested -Context $context -Binding $binding
    Assert-DysonGameBootstrapExpectedExitMatchesBinding `
        -ExpectedExit $expectedExit -Binding $binding -Context $context

    $errorCode = 'BOOTSTRAP_RELEASE_STOP_FAILED'
    [void](Invoke-DysonGameBootstrapReleaseScript `
        -ScriptPath $release.stopScriptPath `
        -Arguments @('-ProjectRoot', $project.projectRoot, '-TimeoutSeconds', [string]$TimeoutSeconds) `
        -WorkingDirectory $project.projectRoot)

    $errorCode = 'BOOTSTRAP_EXPECTED_EXIT_WRITE_FAILED'
    if ([string]$expectedExit.value.state -ceq 'requested') {
        $expectedExit = Complete-DysonGameBootstrapExpectedExit -Context $context -BindingId $bindingId
    }
    if ([string]$expectedExit.value.state -cne 'completed') {
        throw 'expected exit did not reach completed state'
    }

    $errorCode = 'BOOTSTRAP_BINDING_FINALIZE_FAILED'
    Remove-DysonGameBootstrapBinding -Context $context -BindingId $bindingId
    $stateLease.Dispose()
    $stateLease = $null
    [ordered]@{
        protocol = $protocol
        operation = 'stop'
        state = 'completed'
        outcome = 'stopped'
        version = $version
        bindingId = $bindingId
    } | ConvertTo-DysonGameBootstrapJsonLine
    exit 0
}
catch {
    [ordered]@{
        protocol = $protocol
        operation = 'stop'
        state = 'failed'
        errorCode = $errorCode
        version = $version
        bindingId = $bindingId
    } | Microsoft.PowerShell.Utility\ConvertTo-Json -Depth 4 -Compress
    exit 1
}
finally { if ($stateLease) { $stateLease.Dispose() } }
