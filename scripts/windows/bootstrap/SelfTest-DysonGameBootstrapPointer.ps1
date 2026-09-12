[CmdletBinding()]
param()
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'DysonGameLifecycleBootstrap.Common.ps1')
. (Join-Path (Split-Path $PSScriptRoot -Parent) 'deployment\DysonDeployment.Common.ps1')
$root = Join-Path ([IO.Path]::GetTempPath()) ('dyson-control-deployment-selftest-' + [guid]::NewGuid().ToString('N'))
$previousAllow = $env:DYSON_DEPLOYMENT_ALLOW_SELFTEST_TASKS
$previousRoot = $env:DYSON_DEPLOYMENT_SELFTEST_ROOT_IDENTITY
$env:DYSON_DEPLOYMENT_ALLOW_SELFTEST_TASKS = 'true'
$env:DYSON_DEPLOYMENT_SELFTEST_ROOT_IDENTITY = $root
$install = Join-Path $root 'install'
$data = Join-Path $root 'data'
$bootstrap = Join-Path $install 'bootstrap'
$release = Join-Path $install 'releases\1.0.0'
$passed = 0
function Write-FixtureJson($Path, $Value) {
    [IO.File]::WriteAllText($Path, ($Value | ConvertTo-Json -Depth 12 -Compress), [Text.UTF8Encoding]::new($false))
}
function Assert-Rejected($Pointer, $Message) {
    Write-FixtureJson $context.activePointerPath $Pointer
    $rejected = $false
    try { [void](Resolve-DysonGameBootstrapActiveRelease $context) } catch { $rejected = $true }
    if (-not $rejected) { throw $Message }
    $script:passed++
}
try {
    foreach ($path in @($bootstrap, $data, $release, (Join-Path $data 'state'))) { [void][IO.Directory]::CreateDirectory($path) }
    Copy-Item -LiteralPath (Join-Path (Split-Path $PSScriptRoot -Parent) 'deployment\DysonDeployment.Common.ps1') -Destination $bootstrap
    [void](Write-DysonGameBootstrapLayout -BootstrapRoot $bootstrap -DataRoot $data)
    $context = Get-DysonGameBootstrapContext -BootstrapRoot $bootstrap
    $files = @(foreach ($relative in @('apps/api/dist/index.js', 'scripts/windows/Start-DysonServer.ps1', 'scripts/windows/Stop-DysonServer.ps1')) {
        $path = Join-Path $release $relative
        [void][IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($path))
        [IO.File]::WriteAllText($path, "# fixture`n", [Text.UTF8Encoding]::new($false))
        [ordered]@{path=$relative;length=(Get-Item $path).Length;sha256=Get-DysonGameBootstrapFileSha256 $path}
    })
    $lines = @($files | ForEach-Object { '{0}|{1}|{2}' -f $_.path,$_.length,$_.sha256 })
    $hash = Get-DysonGameBootstrapSha256Text ([string]::Join("`n", $lines))
    $manifest = [ordered]@{protocol='DYSON_CONTROL_DEPLOYMENT_V1';version='1.0.0';entryPoint='apps/api/dist/index.js';nodeMinimumMajor=24;createdAt=[datetime]::UtcNow.ToString('o');payloadSha256=$hash;files=$files}
    $manifestPath = Join-Path $release 'release-manifest.json'
    Write-FixtureJson $manifestPath $manifest
    $pointer = [ordered]@{protocol='DYSON_CONTROL_DEPLOYMENT_V1';version='1.0.0';entryPoint=$manifest.entryPoint;payloadSha256=$hash;activatedAt=[datetime]::UtcNow.ToString('o')}
    Write-FixtureJson $context.activePointerPath $pointer
    [void](Resolve-DysonGameBootstrapActiveRelease $context);$passed++
    $identity = Initialize-DysonDeploymentIdentity -InstallRoot $install -DataRoot $data
    $pointer.deploymentId = $identity.marker.deploymentId
    $pointer.deploymentIdentitySha256 = $identity.markerSha256
    $manifest.entryPoint = 'apps\api\dist\index.js';$pointer.entryPoint = $manifest.entryPoint
    Write-FixtureJson $manifestPath $manifest
    Write-FixtureJson $context.activePointerPath $pointer
    [void](Resolve-DysonGameBootstrapActiveRelease $context);$passed++
    $pointer.deploymentId = [guid]::NewGuid().ToString('D')
    Assert-Rejected $pointer 'a different deployment identity was accepted'
    $pointer.deploymentId = $identity.marker.deploymentId
    $pointer.deploymentIdentitySha256 = '0' * 64
    Assert-Rejected $pointer 'a different identity digest was accepted'
    $pointer.Remove('deploymentIdentitySha256')
    Assert-Rejected $pointer 'an incomplete identity was accepted'
    $pointer.deploymentIdentitySha256 = $identity.markerSha256
    $pointer.unexpected = $true
    Assert-Rejected $pointer 'an unknown pointer field was accepted'
    $pointer.Remove('unexpected')
    [IO.File]::AppendAllText((Join-Path $release 'scripts/windows/Start-DysonServer.ps1'), '# tampered')
    Assert-Rejected $pointer 'a tampered release was accepted'
    [ordered]@{protocol='DYSON_GAME_BOOTSTRAP_POINTER_SELFTEST_V1';state='passed';passed=$passed;productionTouched=$false}|ConvertTo-Json -Compress
}
finally {
    $env:DYSON_DEPLOYMENT_ALLOW_SELFTEST_TASKS = $previousAllow
    $env:DYSON_DEPLOYMENT_SELFTEST_ROOT_IDENTITY = $previousRoot
    $full = [IO.Path]::GetFullPath($root)
    $temp = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\') + '\'
    if ($full.StartsWith($temp,[StringComparison]::OrdinalIgnoreCase) -and [IO.Path]::GetFileName($full) -match '^dyson-control-deployment-selftest-[a-f0-9]{32}$' -and (Test-Path -LiteralPath $full)) {
        Remove-Item -LiteralPath $full -Recurse -Force
    }
}
