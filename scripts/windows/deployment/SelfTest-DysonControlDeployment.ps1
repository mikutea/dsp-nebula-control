[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$deploymentScript = Join-Path $PSScriptRoot 'Invoke-DysonControlDeployment.ps1'
$installScript = Join-Path $PSScriptRoot 'Install-DysonControl.ps1'
$taskScript = Join-Path $PSScriptRoot 'Install-DysonControlTask.ps1'
$uninstallScript = Join-Path $PSScriptRoot 'Uninstall-DysonControl.ps1'
$statusScript = Join-Path $PSScriptRoot 'Test-DysonControlDeployment.ps1'
$artifactCommonScript = Join-Path $PSScriptRoot '..\release\DysonReleasePackaging.Common.ps1'
$artifactVerifierScript = Join-Path $PSScriptRoot '..\release\Test-DysonControlReleaseArtifact.ps1'
$deploymentCommonScript = Join-Path $PSScriptRoot 'DysonDeployment.Common.ps1'
. $artifactCommonScript
. $deploymentCommonScript
$temporaryBase = [System.IO.Path]::GetFullPath([System.IO.Path]::GetTempPath()).TrimEnd('\', '/')
$testRoot = Join-Path $temporaryBase ('dyson-control-deployment-selftest-' + [guid]::NewGuid().ToString('N'))
$installRoot = Join-Path $testRoot 'program-files\DysonControl'
$dataRoot = Join-Path $testRoot 'program-data\DysonControl'
$readinessStopPath = Join-Path $testRoot 'stop-readiness-listener'
$readinessJob = $null
$readinessUri = $null

function Assert-SelfTest {
    param(
        [Parameter(Mandatory)][bool]$Condition,
        [Parameter(Mandatory)][string]$Message
    )
    if (-not $Condition) { throw "SELFTEST_FAILED: $Message" }
}

function New-FictionalPayload {
    param(
        [Parameter(Mandatory)][string]$Root,
        [Parameter(Mandatory)][string]$Version,
        [string]$ContentMarker
    )
    if ([string]::IsNullOrWhiteSpace($ContentMarker)) { $ContentMarker = $Version }
    $apiRoot = Join-Path $Root 'apps\api\dist'
    $webRoot = Join-Path $Root 'apps\web\dist'
    [System.IO.Directory]::CreateDirectory($apiRoot) | Out-Null
    [System.IO.Directory]::CreateDirectory($webRoot) | Out-Null
    $entryPoint = @"
const fs = require('node:fs');
const output = process.env.DYSON_SELFTEST_OUTPUT;
if (output) {
  fs.writeFileSync(output, JSON.stringify({
    fixtureVersion: '$ContentMarker',
    host: process.env.DYSON_HOST,
    nodeEnv: process.env.NODE_ENV,
    dataDir: process.env.DYSON_DATA_DIR,
    scriptRoot: process.env.DYSON_SCRIPT_ROOT,
    deploymentVersion: process.env.DYSON_DEPLOYMENT_VERSION,
    nodeOptions: process.env.NODE_OPTIONS || null
  }));
}
console.log('fictional-dyson-control-$ContentMarker');
"@
    [System.IO.File]::WriteAllText((Join-Path $apiRoot 'index.js'), $entryPoint, [System.Text.UTF8Encoding]::new($false))
    [System.IO.File]::WriteAllText(
        (Join-Path $webRoot 'index.html'),
        "<!doctype html><title>Fictional $Version</title>`n",
        [System.Text.UTF8Encoding]::new($false)
    )
    $releaseVerifierRoot = Join-Path $Root 'scripts\windows\release'
    [System.IO.Directory]::CreateDirectory($releaseVerifierRoot) | Out-Null
    [System.IO.File]::Copy($artifactCommonScript, (Join-Path $releaseVerifierRoot 'DysonReleasePackaging.Common.ps1'), $false)
    [System.IO.File]::Copy($artifactVerifierScript, (Join-Path $releaseVerifierRoot 'Test-DysonControlReleaseArtifact.ps1'), $false)
    $repositoryRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..\..'))
    foreach ($relative in @(
        $script:DysonArtifactRequiredBridgeSources +
        $script:DysonArtifactRequiredBridgeScripts +
        $script:DysonArtifactRequiredMigrationScripts +
        $script:DysonArtifactRequiredMigrationDocs
    )) {
        $source = Join-Path $repositoryRoot $relative.Replace('/', '\')
        $destination = Join-Path $Root $relative.Replace('/', '\')
        [System.IO.Directory]::CreateDirectory([System.IO.Path]::GetDirectoryName($destination)) | Out-Null
        [System.IO.File]::Copy($source, $destination, $false)
    }
    [void](Write-DysonArtifactManifest -ArtifactRoot $Root -Version $Version -DevDependenciesExcluded @())
}

function New-FictionalNodeFixtures {
    param([Parameter(Mandatory)][string]$Root)

    $fixtureRoot = Join-Path $Root 'fictional-node-runtimes'
    [System.IO.Directory]::CreateDirectory($fixtureRoot) | Out-Null
    $compilerOutput = Join-Path $fixtureRoot 'fixture-template.exe'
    $source = @'
using System;
using System.IO;
using System.Threading;

public static class DysonNodeRuntimeFixture
{
    public static int Main(string[] args)
    {
        if (args.Length != 1 || args[0] != "--version") return 91;
        if (!String.IsNullOrEmpty(Environment.GetEnvironmentVariable("NODE_OPTIONS")) ||
            !String.IsNullOrEmpty(Environment.GetEnvironmentVariable("NODE_PATH"))) return 93;
        string name = Path.GetFileNameWithoutExtension(Environment.GetCommandLineArgs()[0]).ToLowerInvariant();
        if (name.Contains("preview-trap")) {
            string sentinel = Environment.GetEnvironmentVariable("DYSON_NODE_PROBE_SENTINEL");
            if (!String.IsNullOrEmpty(sentinel)) File.WriteAllText(sentinel, "executed");
            Console.WriteLine("v24.0.0");
            return 0;
        }
        if (name.Contains("node24")) { Console.WriteLine("v24.0.0"); return 0; }
        if (name.Contains("node23")) { Console.WriteLine("v23.99.0"); return 0; }
        if (name.Contains("fake")) { Console.WriteLine("not-a-node-version"); return 0; }
        if (name.Contains("prerelease")) { Console.WriteLine("v24.0.0-rc.1"); return 0; }
        if (name.Contains("leadingzero")) { Console.WriteLine("v024.0.0"); return 0; }
        if (name.Contains("huge")) { Console.Write(new String('x', 4096)); return 0; }
        if (name.Contains("stderr")) { Console.Error.WriteLine("private fixture detail"); Console.WriteLine("v24.0.0"); return 0; }
        if (name.Contains("nonzero")) { Console.WriteLine("v24.0.0"); return 7; }
        if (name.Contains("timeout")) { Thread.Sleep(10000); Console.WriteLine("v24.0.0"); return 0; }
        return 92;
    }
}
'@
    Add-Type -TypeDefinition $source -Language CSharp -OutputAssembly $compilerOutput -OutputType ConsoleApplication
    $fixtures = [ordered]@{}
    foreach ($name in @('node24', 'node23', 'fake', 'prerelease', 'leadingzero', 'huge', 'stderr', 'nonzero', 'timeout', 'preview-trap')) {
        $target = Join-Path $fixtureRoot ($name + '-fixture.exe')
        [System.IO.File]::Copy($compilerOutput, $target, $true)
        $fixtures[$name.Replace('-', '')] = $target
    }
    return [pscustomobject]$fixtures
}

function Assert-NodeRuntimeRejected {
    param(
        [Parameter(Mandatory)][string]$Executable,
        [Parameter(Mandatory)][string]$Message,
        [int]$TimeoutMilliseconds = 1000
    )

    $rejected = $false
    $failure = $null
    try {
        [void](Test-DysonNodeRuntime -NodeExecutable $Executable -MinimumMajor 24 `
            -TimeoutMilliseconds $TimeoutMilliseconds -MaximumOutputCharacters 128)
    }
    catch {
        $rejected = $true
        $failure = $_.Exception.Message
    }
    Assert-SelfTest -Condition $rejected -Message $Message
    Assert-SelfTest -Condition ($failure -eq 'Node.js runtime verification failed.') `
        -Message 'Node runtime failure reflected an executable path or untrusted process output'
}

function Assert-ArtifactStageRejected {
    param(
        [Parameter(Mandatory)][string]$Payload,
        [Parameter(Mandatory)][string]$Version,
        [Parameter(Mandatory)][string]$Message
    )
    $rejected = $false
    try {
        & $deploymentScript -Operation Stage -SourcePath $Payload -Version $Version `
            -InstallRoot $installRoot -DataRoot $dataRoot -Confirm:$false | Out-Null
    }
    catch { $rejected = $true }
    Assert-SelfTest -Condition $rejected -Message $Message
    Assert-SelfTest -Condition (-not (Test-Path -LiteralPath (Join-Path $installRoot "releases\$Version"))) `
        -Message "a rejected artifact was staged as release $Version"
}

function Invoke-DeploymentJson {
    param([Parameter(Mandatory)][hashtable]$Arguments)
    $output = & $deploymentScript @Arguments -Confirm:$false
    return ($output | Out-String).Trim() | ConvertFrom-Json
}

function Get-ActiveVersion {
    $pointerPath = Join-Path $dataRoot 'state\active-release.json'
    if (-not (Test-Path -LiteralPath $pointerPath -PathType Leaf)) { return $null }
    return [string](([System.IO.File]::ReadAllText($pointerPath, [System.Text.Encoding]::UTF8) | ConvertFrom-Json).version)
}

try {
    [System.IO.Directory]::CreateDirectory($testRoot) | Out-Null
    $nodeFixtures = New-FictionalNodeFixtures -Root $testRoot
    $previousNodeOptions = [System.Environment]::GetEnvironmentVariable('NODE_OPTIONS', 'Process')
    $previousNodePath = [System.Environment]::GetEnvironmentVariable('NODE_PATH', 'Process')
    [System.Environment]::SetEnvironmentVariable('NODE_OPTIONS', '--require=C:\private\fixture.js', 'Process')
    [System.Environment]::SetEnvironmentVariable('NODE_PATH', 'C:\private\fixture-modules', 'Process')
    try { $node24 = Test-DysonNodeRuntime -NodeExecutable $nodeFixtures.node24 -MinimumMajor 24 }
    finally {
        [System.Environment]::SetEnvironmentVariable('NODE_OPTIONS', $previousNodeOptions, 'Process')
        [System.Environment]::SetEnvironmentVariable('NODE_PATH', $previousNodePath, 'Process')
    }
    Assert-SelfTest -Condition ($node24.version -eq 'v24.0.0' -and $node24.major -eq 24) `
        -Message 'the controlled Node 24 fixture was not accepted'
    Assert-NodeRuntimeRejected -Executable $nodeFixtures.node23 -Message 'the controlled Node 23 fixture was accepted'
    Assert-NodeRuntimeRejected -Executable $nodeFixtures.fake -Message 'a fake Node version was accepted'
    Assert-NodeRuntimeRejected -Executable $nodeFixtures.prerelease -Message 'a prerelease Node version was accepted'
    Assert-NodeRuntimeRejected -Executable $nodeFixtures.leadingzero -Message 'a noncanonical Node version was accepted'
    Assert-NodeRuntimeRejected -Executable $nodeFixtures.huge -Message 'oversized Node version output was accepted'
    Assert-NodeRuntimeRejected -Executable $nodeFixtures.stderr -Message 'Node version stderr output was accepted'
    Assert-NodeRuntimeRejected -Executable $nodeFixtures.nonzero -Message 'a nonzero Node version probe was accepted'
    Assert-NodeRuntimeRejected -Executable $nodeFixtures.timeout -TimeoutMilliseconds 250 `
        -Message 'a timed-out Node version probe was accepted'
    $payloadA = Join-Path $testRoot 'payload-a'
    $payloadAConflict = Join-Path $testRoot 'payload-a-conflict'
    $payloadB = Join-Path $testRoot 'payload-b'
    $payloadC = Join-Path $testRoot 'payload-c'
    $payloadLock = Join-Path $testRoot 'payload-lock'
    $payloadPreview = Join-Path $testRoot 'payload-preview'
    $payloadInstaller = Join-Path $testRoot 'payload-installer'
    $payloadTampered = Join-Path $testRoot 'payload-tampered'
    $payloadMissing = Join-Path $testRoot 'payload-missing'
    $payloadExtra = Join-Path $testRoot 'payload-extra'
    $payloadVersionMismatch = Join-Path $testRoot 'payload-version-mismatch'
    $payloadNodeMinimumMismatch = Join-Path $testRoot 'payload-node-minimum-mismatch'
    New-FictionalPayload -Root $payloadA -Version '1.0.0'
    New-FictionalPayload -Root $payloadAConflict -Version '1.0.0' -ContentMarker 'different-immutable-content'
    New-FictionalPayload -Root $payloadB -Version '1.1.0'
    New-FictionalPayload -Root $payloadC -Version '1.2.0'
    New-FictionalPayload -Root $payloadLock -Version '8.8.8-lock-test'
    New-FictionalPayload -Root $payloadPreview -Version '9.9.9-preview'
    New-FictionalPayload -Root $payloadInstaller -Version '2.0.0'
    New-FictionalPayload -Root $payloadTampered -Version '3.0.0'
    New-FictionalPayload -Root $payloadMissing -Version '3.0.1'
    New-FictionalPayload -Root $payloadExtra -Version '3.0.2'
    New-FictionalPayload -Root $payloadVersionMismatch -Version '3.0.3-Case'
    New-FictionalPayload -Root $payloadNodeMinimumMismatch -Version '3.0.5'
    [System.IO.File]::AppendAllText(
        (Join-Path $payloadTampered 'apps\api\dist\index.js'),
        "// tampered after manifest`n",
        [System.Text.UTF8Encoding]::new($false)
    )
    Remove-Item -LiteralPath (Join-Path $payloadMissing 'apps\web\dist\index.html') -Force
    [System.IO.File]::WriteAllText(
        (Join-Path $payloadExtra 'apps\web\dist\unexpected.js'),
        "console.log('unexpected artifact member')`n",
        [System.Text.UTF8Encoding]::new($false)
    )
    $nodeMinimumManifestPath = Join-Path $payloadNodeMinimumMismatch 'artifact-manifest.json'
    $nodeMinimumManifest = [System.IO.File]::ReadAllText($nodeMinimumManifestPath, [System.Text.Encoding]::UTF8) | ConvertFrom-Json
    $nodeMinimumManifest.nodeMinimumMajor = 23
    [System.IO.File]::WriteAllText(
        $nodeMinimumManifestPath,
        ($nodeMinimumManifest | ConvertTo-Json -Depth 12 -Compress),
        [System.Text.UTF8Encoding]::new($false)
    )
    [System.IO.Directory]::CreateDirectory((Join-Path $dataRoot 'config')) | Out-Null
    [System.IO.Directory]::CreateDirectory((Join-Path $dataRoot 'data')) | Out-Null
    [System.IO.File]::WriteAllText(
        (Join-Path $dataRoot 'config\dyson-control.env'),
        "NODE_ENV=production`nDYSON_HOST=127.0.0.1`nDYSON_LIFECYCLE_ENABLED=false`n",
        [System.Text.UTF8Encoding]::new($false)
    )
    [System.IO.File]::WriteAllText(
        (Join-Path $dataRoot 'data\persistent-sentinel.txt'),
        'must-survive-release-changes',
        [System.Text.UTF8Encoding]::new($false)
    )

    Assert-ArtifactStageRejected -Payload $payloadTampered -Version '3.0.0' `
        -Message 'a payload whose bytes no longer match the artifact manifest was accepted'
    Assert-ArtifactStageRejected -Payload $payloadMissing -Version '3.0.1' `
        -Message 'an artifact with a manifest-listed file missing was accepted'
    Assert-ArtifactStageRejected -Payload $payloadExtra -Version '3.0.2' `
        -Message 'an artifact with an extra file outside its manifest was accepted'
    Assert-ArtifactStageRejected -Payload $payloadVersionMismatch -Version '3.0.3-case' `
        -Message 'an artifact whose manifest version differs by case from the requested release was accepted'
    Assert-ArtifactStageRejected -Payload $payloadNodeMinimumMismatch -Version '3.0.5' `
        -Message 'an artifact with an unsupported Node minimum major was accepted'

    $stageA = Invoke-DeploymentJson -Arguments @{
        Operation = 'Stage'; SourcePath = $payloadA; Version = '1.0.0'; InstallRoot = $installRoot; DataRoot = $dataRoot
    }
    Assert-SelfTest -Condition ($stageA.state -eq 'staged') -Message 'release A was not staged'
    $stageAAgain = Invoke-DeploymentJson -Arguments @{
        Operation = 'Stage'; SourcePath = $payloadA; Version = '1.0.0'; InstallRoot = $installRoot; DataRoot = $dataRoot
    }
    Assert-SelfTest -Condition ($stageAAgain.state -eq 'already-staged') -Message 'staging was not idempotent'
    $immutableConflictObserved = $false
    try {
        & $deploymentScript -Operation Stage -SourcePath $payloadAConflict -Version '1.0.0' `
            -InstallRoot $installRoot -DataRoot $dataRoot -Confirm:$false | Out-Null
    }
    catch { $immutableConflictObserved = $true }
    Assert-SelfTest -Condition $immutableConflictObserved -Message 'different content overwrote an immutable version'

    $exclusiveLockObserved = $false
    $heldLock = [System.IO.FileStream]::new(
        (Join-Path $dataRoot 'state\deployment.lock'),
        [System.IO.FileMode]::OpenOrCreate,
        [System.IO.FileAccess]::ReadWrite,
        [System.IO.FileShare]::None
    )
    try {
        try {
            & $deploymentScript -Operation Stage -SourcePath $payloadLock -Version '8.8.8-lock-test' `
                -InstallRoot $installRoot -DataRoot $dataRoot -LockTimeoutSeconds 1 -Confirm:$false | Out-Null
        }
        catch { $exclusiveLockObserved = $true }
    }
    finally { $heldLock.Dispose() }
    Assert-SelfTest -Condition $exclusiveLockObserved -Message 'the exclusive deployment lock did not reject a concurrent operation'
    Assert-SelfTest -Condition (-not (Test-Path -LiteralPath (Join-Path $installRoot 'releases\8.8.8-lock-test'))) -Message 'a lock-rejected release was staged'

    $activateA = Invoke-DeploymentJson -Arguments @{
        Operation = 'Activate'; Version = '1.0.0'; InstallRoot = $installRoot; DataRoot = $dataRoot
    }
    Assert-SelfTest -Condition ($activateA.state -eq 'activated' -and (Get-ActiveVersion) -eq '1.0.0') -Message 'release A was not activated'

    $upgradeB = Invoke-DeploymentJson -Arguments @{
        Operation = 'Upgrade'; SourcePath = $payloadB; Version = '1.1.0'; InstallRoot = $installRoot; DataRoot = $dataRoot
    }
    Assert-SelfTest -Condition ($upgradeB.state -eq 'upgraded' -and (Get-ActiveVersion) -eq '1.1.0') -Message 'release B was not upgraded'
    $snapshotBeforeB = [string]$upgradeB.snapshotId

    [System.IO.File]::WriteAllText(
        (Join-Path $dataRoot 'config\dyson-control.env'),
        "NODE_ENV=production`nDYSON_HOST=127.0.0.1`nDYSON_PORT=13999`nDYSON_LIFECYCLE_ENABLED=false`n",
        [System.Text.UTF8Encoding]::new($false)
    )

    $listener = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, 0)
    $listener.Start()
    $readinessPort = ([System.Net.IPEndPoint]$listener.LocalEndpoint).Port
    $listener.Stop()
    $pointerForJob = Join-Path $dataRoot 'state\active-release.json'
    $readinessJob = Start-Job -ArgumentList $readinessPort, $pointerForJob, $readinessStopPath -ScriptBlock {
        param($Port, $PointerPath, $StopPath)
        $server = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, [int]$Port)
        $server.Start()
        try {
            while (-not (Test-Path -LiteralPath $StopPath)) {
                $client = $server.AcceptTcpClient()
                try {
                    $stream = $client.GetStream()
                    $reader = [System.IO.StreamReader]::new($stream, [System.Text.Encoding]::ASCII, $false, 1024, $true)
                    while (($line = $reader.ReadLine()) -ne $null -and $line.Length -gt 0) { }
                    $version = $null
                    try { $version = ([System.IO.File]::ReadAllText($PointerPath) | ConvertFrom-Json).version } catch { }
                    $status = if ($version -eq '1.1.0') { '200 OK' } else { '503 Service Unavailable' }
                    $body = if ($version -eq '1.1.0') {
                        '{"status":"ready","deploymentVersion":"1.1.0","checks":{"deploymentVersion":"pass","statusProvider":"pass","projectRoot":"pass","activationRecovery":"not-applicable"}}'
                    }
                    else {
                        '{"status":"not-ready","deploymentVersion":"1.2.0","checks":{"deploymentVersion":"pass","statusProvider":"fail","projectRoot":"pass","activationRecovery":"not-applicable"}}'
                    }
                    $bytes = [System.Text.Encoding]::UTF8.GetBytes($body)
                    $headers = "HTTP/1.1 $status`r`nContent-Type: application/json`r`nX-Dyson-Control-Release: $version`r`nContent-Length: $($bytes.Length)`r`nConnection: close`r`n`r`n"
                    $headerBytes = [System.Text.Encoding]::ASCII.GetBytes($headers)
                    $stream.Write($headerBytes, 0, $headerBytes.Length)
                    $stream.Write($bytes, 0, $bytes.Length)
                    $stream.Flush()
                }
                finally { $client.Dispose() }
            }
        }
        finally { $server.Stop() }
    }
    $readinessUri = [uri]("http://127.0.0.1:$readinessPort/readyz")
    $readyDeadline = (Get-Date).AddSeconds(10)
    do {
        try { $ready = (Invoke-WebRequest -Uri $readinessUri -UseBasicParsing -TimeoutSec 1).StatusCode -eq 200 }
        catch { $ready = $false }
        if (-not $ready) { Start-Sleep -Milliseconds 100 }
    } while (-not $ready -and (Get-Date) -lt $readyDeadline)
    Assert-SelfTest -Condition $ready -Message 'the fictional readiness endpoint did not start'

    $failedUpgradeObserved = $false
    try {
        & $deploymentScript -Operation Upgrade -SourcePath $payloadC -Version '1.2.0' `
            -InstallRoot $installRoot -DataRoot $dataRoot -ReadinessUri $readinessUri -ReadinessTimeoutSeconds 1 -Confirm:$false | Out-Null
    }
    catch { $failedUpgradeObserved = $true }
    Assert-SelfTest -Condition $failedUpgradeObserved -Message 'a failed readiness check did not fail the upgrade'
    Assert-SelfTest -Condition ((Get-ActiveVersion) -eq '1.1.0') -Message 'a failed upgrade did not restore release B'

    $rollback = Invoke-DeploymentJson -Arguments @{
        Operation = 'Rollback'; SnapshotId = $snapshotBeforeB; InstallRoot = $installRoot; DataRoot = $dataRoot
    }
    Assert-SelfTest -Condition ($rollback.state -eq 'rolled-back' -and (Get-ActiveVersion) -eq '1.0.0') -Message 'explicit rollback did not restore release A'
    $restoredConfig = [System.IO.File]::ReadAllText((Join-Path $dataRoot 'config\dyson-control.env'), [System.Text.Encoding]::UTF8)
    Assert-SelfTest -Condition ($restoredConfig -notmatch 'DYSON_PORT=13999') -Message 'rollback did not restore the pre-upgrade configuration snapshot'
    Assert-SelfTest -Condition (Test-Path -LiteralPath (Join-Path $dataRoot 'data\persistent-sentinel.txt') -PathType Leaf) -Message 'release operations changed persistent data'

    $preview = & $deploymentScript -Operation Stage -SourcePath $payloadPreview -Version '9.9.9-preview' `
        -InstallRoot $installRoot -DataRoot $dataRoot -WhatIf 6>$null | Out-String
    Assert-SelfTest -Condition (($preview | ConvertFrom-Json).state -eq 'preview') -Message 'WhatIf did not return a deployment preview'
    Assert-SelfTest -Condition (-not (Test-Path -LiteralPath (Join-Path $installRoot 'releases\9.9.9-preview'))) -Message 'WhatIf staged a release'

    $auditRecords = @(Get-Content -LiteralPath (Join-Path $dataRoot 'audit\deployment.jsonl') | ForEach-Object { $_ | ConvertFrom-Json })
    Assert-SelfTest -Condition ($auditRecords.Count -ge 10) -Message 'durable deployment audit records were not emitted'
    $rolledBackAuditCount = @($auditRecords | Where-Object { $_.code -eq 'UPGRADE_ROLLED_BACK' }).Count
    Assert-SelfTest -Condition ($rolledBackAuditCount -ge 1) -Message "failed-upgrade rollback was not audited (count=$rolledBackAuditCount)"

    $installerRoot = Join-Path $testRoot 'installer-program-files\DysonControl'
    $installerData = Join-Path $testRoot 'installer-program-data\DysonControl'
    $installerConfig = Join-Path $testRoot 'fictional-production.env'
    $launcherResultPath = Join-Path $installerData 'data\launcher-result.json'
    [System.IO.File]::WriteAllText(
        $installerConfig,
        "NODE_ENV=production`nDYSON_HOST=203.0.113.50`nDYSON_PROVIDER=demo`nDYSON_ADMIN_PASSWORD_HASH=scrypt`$fictional`nDYSON_SESSION_SECRET=fictional-session-secret-at-least-32-characters`nDYSON_SELFTEST_OUTPUT=$launcherResultPath`n",
        [System.Text.UTF8Encoding]::new($false)
    )
    $nodeCommand = Get-Command node.exe -ErrorAction SilentlyContinue
    if (-not $nodeCommand) { $nodeCommand = Get-Command node -ErrorAction Stop }
    $previewNodeSentinel = Join-Path $testRoot 'preview-node-was-executed'
    $previewInstallerRoot = Join-Path $testRoot 'preview-installer-program-files\DysonControl'
    $previewInstallerData = Join-Path $testRoot 'preview-installer-program-data\DysonControl'
    [System.Environment]::SetEnvironmentVariable('DYSON_NODE_PROBE_SENTINEL', $previewNodeSentinel, 'Process')
    try {
        $installPreviewOutput = & $installScript -SourcePath $payloadInstaller -Version '2.0.0' `
            -NodeExecutable $nodeFixtures.previewtrap -InstallRoot $previewInstallerRoot `
            -DataRoot $previewInstallerData -ConfigurationSource $installerConfig -WhatIf 6>$null
    }
    finally { Remove-Item Env:DYSON_NODE_PROBE_SENTINEL -ErrorAction SilentlyContinue }
    $installPreview = ($installPreviewOutput | Out-String).Trim() | ConvertFrom-Json
    Assert-SelfTest -Condition ($installPreview.state -eq 'preview') -Message 'installer WhatIf did not return a preview'
    Assert-SelfTest -Condition (-not (Test-Path -LiteralPath $previewNodeSentinel)) `
        -Message 'installer WhatIf executed the supplied Node executable'
    Assert-SelfTest -Condition (-not (Test-Path -LiteralPath $previewInstallerRoot)) `
        -Message 'installer WhatIf mutated the install root'
    Assert-SelfTest -Condition (-not (Test-Path -LiteralPath $previewInstallerData)) `
        -Message 'installer WhatIf mutated the data root'

    $lowNodeInstallerRoot = Join-Path $testRoot 'low-node-installer-program-files\DysonControl'
    $lowNodeInstallerData = Join-Path $testRoot 'low-node-installer-program-data\DysonControl'
    $lowNodeInstallRejected = $false
    try {
        & $installScript -SourcePath $payloadInstaller -Version '2.0.0' -NodeExecutable $nodeFixtures.node23 `
            -InstallRoot $lowNodeInstallerRoot -DataRoot $lowNodeInstallerData `
            -ConfigurationSource $installerConfig -Confirm:$false | Out-Null
    }
    catch { $lowNodeInstallRejected = $_.Exception.Message -eq 'Node.js runtime verification failed.' }
    Assert-SelfTest -Condition $lowNodeInstallRejected -Message 'the installer accepted Node 23'
    Assert-SelfTest -Condition (-not (Test-Path -LiteralPath $lowNodeInstallerRoot)) `
        -Message 'the rejected Node 23 installer mutated the install root'
    Assert-SelfTest -Condition (-not (Test-Path -LiteralPath $lowNodeInstallerData)) `
        -Message 'the rejected Node 23 installer mutated the data root'

    $invalidInstallerRoot = Join-Path $testRoot 'invalid-installer-program-files\DysonControl'
    $invalidInstallerData = Join-Path $testRoot 'invalid-installer-program-data\DysonControl'
    $invalidInstallRejected = $false
    try {
        & $installScript -SourcePath $payloadTampered -Version '3.0.0' -NodeExecutable $nodeCommand.Source `
            -InstallRoot $invalidInstallerRoot -DataRoot $invalidInstallerData `
            -ConfigurationSource $installerConfig -Confirm:$false | Out-Null
    }
    catch { $invalidInstallRejected = $true }
    Assert-SelfTest -Condition $invalidInstallRejected -Message 'the installer accepted a tampered clean artifact'
    Assert-SelfTest -Condition (-not (Test-Path -LiteralPath $invalidInstallerRoot)) `
        -Message 'a rejected installer artifact mutated the install root'
    Assert-SelfTest -Condition (-not (Test-Path -LiteralPath $invalidInstallerData)) `
        -Message 'a rejected installer artifact mutated the data root'

    $installerOutput = & $installScript -SourcePath $payloadInstaller -Version '2.0.0' -NodeExecutable $nodeFixtures.node24 `
        -InstallRoot $installerRoot -DataRoot $installerData -ConfigurationSource $installerConfig -Confirm:$false
    $installerResult = ($installerOutput | Out-String).Trim() | ConvertFrom-Json
    Assert-SelfTest -Condition ($installerResult.state -eq 'installed') -Message 'the reusable installer did not complete'
    $installedReleaseManifest = [System.IO.File]::ReadAllText(
        (Join-Path $installerRoot 'releases\2.0.0\release-manifest.json'),
        [System.Text.Encoding]::UTF8
    ) | ConvertFrom-Json
    Assert-SelfTest -Condition ([int]$installedReleaseManifest.nodeMinimumMajor -eq 24) `
        -Message 'the verified artifact Node minimum was not retained in the immutable release manifest'
    Assert-SelfTest -Condition (Test-Path -LiteralPath (Join-Path $installerRoot 'bootstrap\Start-DysonControl.ps1') -PathType Leaf) -Message 'the stable launcher was not installed'
    $status = ((& $statusScript -InstallRoot $installerRoot -DataRoot $installerData) | Out-String).Trim() | ConvertFrom-Json
    Assert-SelfTest -Condition ([bool]$status.ready) -Message 'the installed temporary layout failed read-only validation'
    & powershell.exe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass `
        -File (Join-Path $installerRoot 'bootstrap\Start-DysonControl.ps1') `
        -InstallRoot $installerRoot `
        -DataRoot $installerData `
        -NodeExecutable $nodeCommand.Source | Out-Null
    Assert-SelfTest -Condition ($LASTEXITCODE -eq 0 -and (Test-Path -LiteralPath $launcherResultPath -PathType Leaf)) -Message 'the fixed launcher did not run the active Node entry point'
    $launcherResult = [System.IO.File]::ReadAllText($launcherResultPath) | ConvertFrom-Json
    Assert-SelfTest -Condition ($launcherResult.host -eq '127.0.0.1') -Message 'the fixed launcher did not override a non-loopback configured host'
    Assert-SelfTest -Condition ($launcherResult.nodeEnv -eq 'production') -Message 'the fixed launcher did not force production mode'
    Assert-SelfTest -Condition ($launcherResult.dataDir -eq (Join-Path $installerData 'data')) -Message 'the fixed launcher did not bind persistent data to ProgramData'
    Assert-SelfTest -Condition ($launcherResult.deploymentVersion -eq '2.0.0') -Message 'the fixed launcher did not export the manifest-bound deployment version'
    Assert-SelfTest -Condition ($null -eq $launcherResult.nodeOptions) -Message 'the fixed launcher inherited NODE_OPTIONS'

    $launcherBeforeRejectedNode = [System.IO.File]::ReadAllText($launcherResultPath, [System.Text.Encoding]::UTF8)
    $rejectedLauncherOutput = Join-Path $testRoot 'rejected-launcher.stdout.txt'
    $rejectedLauncherError = Join-Path $testRoot 'rejected-launcher.stderr.txt'
    $rejectedLauncherArguments = '-NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "{0}" -InstallRoot "{1}" -DataRoot "{2}" -NodeExecutable "{3}"' -f `
        (Join-Path $installerRoot 'bootstrap\Start-DysonControl.ps1'), $installerRoot, $installerData, $nodeFixtures.node23
    $rejectedLauncher = Start-Process -FilePath 'powershell.exe' -ArgumentList $rejectedLauncherArguments `
        -WindowStyle Hidden -Wait -PassThru -RedirectStandardOutput $rejectedLauncherOutput `
        -RedirectStandardError $rejectedLauncherError
    Assert-SelfTest -Condition ($rejectedLauncher.ExitCode -ne 0) -Message 'the fixed launcher accepted Node 23'
    Assert-SelfTest -Condition ([System.IO.File]::ReadAllText($launcherResultPath, [System.Text.Encoding]::UTF8) -eq $launcherBeforeRejectedNode) `
        -Message 'the rejected Node 23 launcher changed application output'

    [System.Environment]::SetEnvironmentVariable('DYSON_NODE_PROBE_SENTINEL', $previewNodeSentinel, 'Process')
    try {
        $taskPreviewOutput = & $taskScript -InstallRoot $installerRoot -DataRoot $installerData `
            -NodeExecutable $nodeFixtures.previewtrap -WhatIf 6>$null
    }
    finally { Remove-Item Env:DYSON_NODE_PROBE_SENTINEL -ErrorAction SilentlyContinue }
    $taskPreview = ($taskPreviewOutput | Out-String).Trim() | ConvertFrom-Json
    Assert-SelfTest -Condition ($taskPreview.state -eq 'preview' -and -not $taskPreview.gameTasksChanged) -Message 'scheduled-task WhatIf validation failed'
    Assert-SelfTest -Condition (-not (Test-Path -LiteralPath $previewNodeSentinel)) `
        -Message 'startup-task WhatIf executed the supplied Node executable'

    $taskAuditPath = Join-Path $installerData 'audit\deployment.jsonl'
    $taskAuditLength = (Get-Item -LiteralPath $taskAuditPath -ErrorAction Stop).Length
    $lowNodeTaskRejected = $false
    try {
        & $taskScript -InstallRoot $installerRoot -DataRoot $installerData `
            -NodeExecutable $nodeFixtures.node23 -Confirm:$false | Out-Null
    }
    catch { $lowNodeTaskRejected = $_.Exception.Message -eq 'Node.js runtime verification failed.' }
    Assert-SelfTest -Condition $lowNodeTaskRejected -Message 'startup-task installation accepted Node 23'
    Assert-SelfTest -Condition ((Get-Item -LiteralPath $taskAuditPath -ErrorAction Stop).Length -eq $taskAuditLength) `
        -Message 'rejected Node 23 startup-task installation changed deployment audit state'
    $uninstallOutput = & $uninstallScript -InstallRoot $installerRoot -DataRoot $installerData -SkipTaskRemoval -Confirm:$false
    $uninstallResult = ($uninstallOutput | Out-String).Trim() | ConvertFrom-Json
    Assert-SelfTest -Condition ($uninstallResult.state -eq 'uninstalled') -Message 'the reusable uninstaller did not complete'
    Assert-SelfTest -Condition (-not (Test-Path -LiteralPath $installerRoot)) -Message 'uninstall left the active Program Files layout in place'
    Assert-SelfTest -Condition (Test-Path -LiteralPath $installerData -PathType Container) -Message 'uninstall did not preserve user data by default'
    Assert-SelfTest -Condition (Test-Path -LiteralPath ([string]$uninstallResult.recoverableReleaseBackup) -PathType Container) -Message 'uninstall did not retain a recoverable release backup'
    Assert-SelfTest -Condition (-not (Test-Path -LiteralPath (Join-Path $installerData 'state\active-release.json'))) -Message 'uninstall left a stale active-release pointer'
    Assert-SelfTest -Condition (Test-Path -LiteralPath ([string]$uninstallResult.activePointerBackup) -PathType Leaf) -Message 'uninstall did not retain the active pointer for rollback'

    [ordered]@{
        protocol = 'DYSON_CONTROL_DEPLOYMENT_SELFTEST_V1'
        state = 'passed'
        stagedIdempotently = $true
        immutableVersionConflictRejected = $true
        artifactManifestTamperRejected = $true
        artifactManifestMissingFileRejected = $true
        artifactManifestExtraFileRejected = $true
        artifactManifestVersionMismatchRejected = $true
        artifactNodeMinimumMismatchRejected = $true
        installerRejectedInvalidArtifactWithoutMutation = $true
        exclusiveDeploymentLockValidated = $true
        activated = '1.0.0'
        upgraded = '1.1.0'
        failedUpgradeRolledBack = $true
        explicitRollback = '1.0.0'
        configSnapshotRestored = $true
        persistentDataPreserved = $true
        whatIfWasNonMutating = $true
        auditRecordCount = $auditRecords.Count
        reusableInstallValidated = $true
        readOnlyValidationPassed = $true
        administratorTaskWhatIfValidated = $true
        fixedLauncherLoopbackValidated = $true
        node24RuntimeAccepted = $true
        node23RuntimeRejected = $true
        fakeAndAbnormalNodeOutputsRejected = $true
        nodeProbeTimeoutRejected = $true
        nodePreviewWasNonExecuting = $true
        nodeRejectionWasNonMutating = $true
        uninstallPreservedData = $true
        uninstallWasRecoverable = $true
    } | ConvertTo-Json -Depth 5 -Compress
}
finally {
    if ($readinessJob) {
        [System.IO.File]::WriteAllText($readinessStopPath, 'stop')
        if ($readinessUri) {
            try { Invoke-WebRequest -Uri $readinessUri -UseBasicParsing -TimeoutSec 1 -ErrorAction SilentlyContinue | Out-Null } catch { }
        }
        Wait-Job -Job $readinessJob -Timeout 5 -ErrorAction SilentlyContinue | Out-Null
        if ($readinessJob.State -eq 'Running') { Stop-Job -Job $readinessJob -ErrorAction SilentlyContinue }
        Remove-Job -Job $readinessJob -Force -ErrorAction SilentlyContinue
    }
    $testFull = [System.IO.Path]::GetFullPath($testRoot).TrimEnd('\', '/')
    $expectedPrefix = $temporaryBase + [System.IO.Path]::DirectorySeparatorChar + 'dyson-control-deployment-selftest-'
    if ($testFull.StartsWith($expectedPrefix, [System.StringComparison]::OrdinalIgnoreCase) -and
        (Test-Path -LiteralPath $testFull)) {
        Remove-Item -LiteralPath $testFull -Recurse -Force
    }
}
