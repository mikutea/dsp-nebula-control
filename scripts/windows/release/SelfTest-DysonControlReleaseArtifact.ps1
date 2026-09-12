[CmdletBinding()]
param([switch]$IncludeCurrentWorkspace)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
. (Join-Path $PSScriptRoot 'DysonReleasePackaging.Common.ps1')

$newArtifactScript = Join-Path $PSScriptRoot 'New-DysonControlReleaseArtifact.ps1'
$testArtifactScript = Join-Path $PSScriptRoot 'Test-DysonControlReleaseArtifact.ps1'
$deploymentScript = Join-Path $PSScriptRoot '..\deployment\Invoke-DysonControlDeployment.ps1'
$powerShellRunnerSource = Join-Path $PSScriptRoot '..\..\..\apps\api\src\providers\powershell-runner.ts'
$temporaryBase = [System.IO.Path]::GetFullPath([System.IO.Path]::GetTempPath()).TrimEnd('\', '/')
$testRoot = Join-Path $temporaryBase ('dcr-selftest-' + [guid]::NewGuid().ToString('N'))
$fixtureRoot = Join-Path $testRoot 'workspace'
$artifactA = Join-Path $testRoot 'artifact-a'
$artifactB = Join-Path $testRoot 'artifact-b'
$artifactForbidden = Join-Path $testRoot 'artifact-forbidden'
$artifactLog = Join-Path $testRoot 'artifact-log'
$artifactSecret = Join-Path $testRoot 'artifact-secret'
$artifactRedirected = Join-Path $testRoot 'artifact-redirected'
$artifactVersionMismatch = Join-Path $testRoot 'artifact-version-mismatch'
$junctionPath = $null

function Assert-ReleaseSelfTest {
    param([bool]$Condition, [string]$Message)
    if (-not $Condition) { throw "Release artifact self-test failed: $Message" }
}

function Write-FixtureText {
    param([string]$Path, [string]$Value)
    [System.IO.Directory]::CreateDirectory([System.IO.Path]::GetDirectoryName($Path)) | Out-Null
    [System.IO.File]::WriteAllText($Path, $Value, [System.Text.UTF8Encoding]::new($false))
}

function Copy-FixtureScript {
    param([string]$Source, [string]$Destination)
    [System.IO.Directory]::CreateDirectory([System.IO.Path]::GetDirectoryName($Destination)) | Out-Null
    [System.IO.File]::Copy($Source, $Destination, $false)
}

function Convert-LastJsonResult {
    param($Output)
    $lines = @(($Output | Out-String) -split "`r?`n" | Where-Object { -not [string]::IsNullOrWhiteSpace($_) })
    if ($lines.Count -eq 0) { throw 'A release self-test command returned no JSON.' }
    return $lines[$lines.Count - 1] | ConvertFrom-Json
}

function Invoke-PackagedSelfTest {
    param(
        [Parameter(Mandatory)][string]$Script,
        [switch]$SuppressInformation
    )

    $scriptFile = Get-Item -LiteralPath $Script -ErrorAction Stop
    if ($scriptFile.PSIsContainer) { throw 'A packaged self-test path resolved to a directory.' }
    $scriptDirectory = [IO.Path]::GetDirectoryName($scriptFile.FullName)
    Push-Location -LiteralPath $scriptDirectory
    try {
        if ($SuppressInformation) { return @(& $scriptFile.FullName 6>$null) }
        return @(& $scriptFile.FullName)
    }
    finally { Pop-Location }
}

[System.IO.Directory]::CreateDirectory($fixtureRoot) | Out-Null
try {
    $wrapperFixtureRoot = Join-Path $testRoot 'packaged-selftest-wrapper'
    $wrapperSuccessScript = Join-Path $wrapperFixtureRoot 'Success.ps1'
    $wrapperFailureScript = Join-Path $wrapperFixtureRoot 'Failure.ps1'
    Write-FixtureText -Path $wrapperSuccessScript -Value `
        "[ordered]@{ currentDirectory = (Get-Location).Path } | ConvertTo-Json -Compress`n"
    Write-FixtureText -Path $wrapperFailureScript -Value "throw 'packaged wrapper fixture failure'`n"
    $wrapperCallerLocation = (Get-Location).Path
    $wrapperSuccess = Convert-LastJsonResult -Output `
        (Invoke-PackagedSelfTest -Script $wrapperSuccessScript)
    Assert-ReleaseSelfTest -Condition (
        [string]::Equals(
            [IO.Path]::GetFullPath([string]$wrapperSuccess.currentDirectory),
            [IO.Path]::GetFullPath($wrapperFixtureRoot),
            [StringComparison]::OrdinalIgnoreCase
        ) -and (Get-Location).Path -ceq $wrapperCallerLocation
    ) -Message 'the packaged self-test wrapper did not use a local script directory and restore caller location'
    $wrapperFailurePropagated = $false
    try { Invoke-PackagedSelfTest -Script $wrapperFailureScript | Out-Null }
    catch { $wrapperFailurePropagated = $_.Exception.Message -ceq 'packaged wrapper fixture failure' }
    Assert-ReleaseSelfTest -Condition ($wrapperFailurePropagated -and
        (Get-Location).Path -ceq $wrapperCallerLocation) `
        -Message 'the packaged self-test wrapper swallowed a failure or did not restore caller location'

    Write-FixtureText -Path (Join-Path $fixtureRoot 'LICENSE') -Value "Fictional self-test license.`n"
    Write-FixtureText -Path (Join-Path $fixtureRoot '.env') -Value "DYSON_SESSION_SECRET=fictional-not-packaged`n"
    Write-FixtureText -Path (Join-Path $fixtureRoot 'apps\api\package.json') -Value @'
{"name":"@example/dyson-control-fixture","version":"1.2.3-fixture","private":true,"type":"module","main":"dist/index.js","dependencies":{},"devDependencies":{}}
'@
    Write-FixtureText -Path (Join-Path $fixtureRoot 'apps\api\package-lock.json') -Value @'
{"name":"@example/dyson-control-fixture","version":"1.2.3-fixture","lockfileVersion":3,"requires":true,"packages":{"":{"name":"@example/dyson-control-fixture","version":"1.2.3-fixture","dependencies":{},"devDependencies":{}}}}
'@
    Write-FixtureText -Path (Join-Path $fixtureRoot 'apps\api\dist\index.js') -Value "import './app.js'`n"
    Write-FixtureText -Path (Join-Path $fixtureRoot 'apps\api\dist\app.js') -Value "console.log('fictional runtime fixture')`n"
    Write-FixtureText -Path (Join-Path $fixtureRoot 'apps\api\dist\lifecycle\game-runtime-receipts.js') `
        -Value "export const fictionalGameRuntimeReceipts = true`n"
    foreach ($relative in $script:DysonArtifactRequiredApiUpdateRuntimeFiles) {
        Write-FixtureText -Path (Join-Path $fixtureRoot $relative.Replace('/', '\')) `
            -Value "export const fictionalUpdateRuntime = true // $relative`n"
    }
    foreach ($relative in $script:DysonArtifactRequiredApiHostnameWssRuntimeFiles) {
        Write-FixtureText -Path (Join-Path $fixtureRoot $relative.Replace('/', '\')) `
            -Value "export const fictionalHostnameWssRuntime = true // $relative`n"
    }
    foreach ($relative in $script:DysonArtifactRequiredApiObservabilityRuntimeFiles) {
        Write-FixtureText -Path (Join-Path $fixtureRoot $relative.Replace('/', '\')) `
            -Value "export const fictionalObservabilityRuntime = true // $relative`n"
    }
    foreach ($relative in $script:DysonArtifactRequiredApiObservabilitySourceFiles) {
        Write-FixtureText -Path (Join-Path $fixtureRoot $relative.Replace('/', '\')) `
            -Value "export const fictionalObservabilitySource = true // $relative`n"
    }
    Write-FixtureText -Path (Join-Path $fixtureRoot `
        'apps\api\dist\providers\powershell-runner.js') -Value @'
const allowedScriptPaths = {
  'New-NebulaPluginCutoverPlan.ps1': ['nebula-private-build', 'New-NebulaPluginCutoverPlan.ps1'],
  'Invoke-NebulaPluginCutover.ps1': ['nebula-private-build', 'Invoke-NebulaPluginCutover.ps1'],
  'Restore-NebulaPluginCutover.ps1': ['nebula-private-build', 'Restore-NebulaPluginCutover.ps1'],
  'Test-NebulaPluginCutover.ps1': ['nebula-private-build', 'Test-NebulaPluginCutover.ps1'],
  'Test-NebulaPluginRollback.ps1': ['nebula-private-build', 'Test-NebulaPluginRollback.ps1']
};
export { allowedScriptPaths };
'@
    Write-FixtureText -Path (Join-Path $fixtureRoot 'apps\api\dist\lifecycle\game-runtime-receipts.test.js') `
        -Value "throw new Error('runtime receipt tests must not ship')`n"
    Write-FixtureText -Path (Join-Path $fixtureRoot 'apps\api\dist\app.test.js') -Value "throw new Error('test file must not ship')`n"
    Write-FixtureText -Path (Join-Path $fixtureRoot 'apps\api\dist\cli\hash-password.js') -Value "throw new Error('development CLI must not ship')`n"
    Write-FixtureText -Path (Join-Path $fixtureRoot 'apps\api\src\cli\hash-password.test.ts') `
        -Value "// fictional repository-only interactive password hashing test sentinel`n"
    Write-FixtureText -Path (Join-Path $fixtureRoot 'apps\api\node_modules\dev-only\fixture.log') -Value "workspace node_modules must not ship`n"
    Write-FixtureText -Path (Join-Path $fixtureRoot 'apps\web\dist\index.html') -Value '<!doctype html><div id="root"></div>'
    Write-FixtureText -Path (Join-Path $fixtureRoot 'apps\web\dist\assets\index-fixture.js') -Value "console.log('fictional web fixture')`n"
    Write-FixtureText -Path (Join-Path $fixtureRoot 'apps\web\dist\assets\index-fixture.css') -Value "body{color:#fff}`n"
    Write-FixtureText -Path (Join-Path $fixtureRoot `
        'scripts\windows\qualification\Repository-Only-Qualification.ps1') `
        -Value "Write-Output 'fictional repository-only qualification fixture'`n"

    $topLevelScripts = @(
        'Get-DysonLifecyclePreflight.ps1', 'Get-DysonManagedPluginVersion.ps1',
        'Get-DysonStatus.ps1', 'Install-DysonRuntimeTasks.ps1',
        'Invoke-DysonScheduledTask.ps1', 'New-DysonSaveProtectionPoint.ps1', 'SelfTest-DysonRuntimeTasks.ps1', 'Start-DysonServer.ps1',
        'Stop-DysonServer.ps1', 'Test-DysonRuntimeState.ps1'
    )
    $releaseVerifierScripts = @(
        'DysonReleasePackaging.Common.ps1', 'Test-DysonControlReleaseArtifact.ps1'
    )
    $deploymentScripts = @(
        'DysonDeployment.Common.ps1', 'DysonDeployment.Configuration.ps1',
        'DysonNodeRuntime.Transaction.ps1',
        'DysonRebootAcceptance.Common.ps1',
        'Install-DysonControl.ps1', 'Install-DysonControlTask.ps1', 'Install-DysonNodeRuntime.ps1',
        'Invoke-DysonControlDeployment.ps1', 'New-DysonRebootAcceptanceCheckpoint.ps1',
        'Repair-DysonNodeRuntime.ps1',
        'Set-DysonGameBootstrapAccess.ps1',
        'Start-DysonControl.ps1', 'Test-DysonControlDeployment.ps1',
        'Test-DysonRebootAcceptanceResume.ps1', 'Uninstall-DysonControl.ps1'
    )
    $sessionScripts = @(
        'Configure-DysonInteractiveSession.ps1', 'Disable-DysonInteractiveSession.ps1',
        'DysonSession.Common.ps1', 'Test-DysonInteractiveSession.ps1'
    )
    $migrationScripts = @(
        'DysonGsManagerMigration.Common.ps1', 'Get-DysonGsManagerMigration.ps1',
        'New-DysonGsManagerSnapshot.ps1', 'Restore-DysonGsManagerSnapshot.ps1',
        'SelfTest-DysonGsManagerMigration.ps1', 'Test-DysonGsManagerSnapshot.ps1'
    )
    $gsManagerRemovalScriptPaths = @($script:DysonArtifactRequiredGsManagerRemovalScripts)
    $gsManagerRemovalScripts = @($gsManagerRemovalScriptPaths | ForEach-Object { [System.IO.Path]::GetFileName($_) })
    Assert-ReleaseSelfTest -Condition ($gsManagerRemovalScripts.Count -eq 5) `
        -Message 'the exact GSManager recoverable-removal allowlist did not contain five entries'
    $evidenceScripts = @(
        'DysonPrivateEvidence.Common.ps1', 'New-DysonAcceptanceEvidenceIndex.ps1',
        'New-DysonPrivateEvidenceBundle.ps1', 'SelfTest-DysonPrivateEvidenceBundle.ps1',
        'Test-DysonPrivateEvidenceBundle.ps1'
    )
    $hostMutationScriptPaths = @($script:DysonArtifactRequiredHostMutationLeaseScripts)
    $hostMutationScripts = @($hostMutationScriptPaths | ForEach-Object { [System.IO.Path]::GetFileName($_) })
    Assert-ReleaseSelfTest -Condition ($hostMutationScripts.Count -eq 3) `
        -Message 'the exact required host-mutation lease script allowlist did not contain three entries'
    $nebulaPluginTransactionPaths = @($script:DysonArtifactRequiredNebulaPluginTransactionFiles)
    $nebulaPluginRunnerPaths = @($script:DysonArtifactRequiredNebulaPluginTransactionRunnerFiles)
    Assert-ReleaseSelfTest -Condition ($nebulaPluginTransactionPaths.Count -eq 8 -and
        $nebulaPluginRunnerPaths.Count -eq 5 -and
        @($nebulaPluginTransactionPaths | Select-Object -Unique).Count -eq 8 -and
        @($nebulaPluginRunnerPaths | Where-Object {
            $_ -cnotin $nebulaPluginTransactionPaths
        }).Count -eq 0) `
        -Message 'the exact Nebula V3 whole-plugin-tree runtime allowlist was not five runners plus three shared contract files'
    $runtimeHostMutationSelectionPaths = @($script:DysonArtifactRequiredHostMutationScripts)
    Assert-ReleaseSelfTest -Condition ($runtimeHostMutationSelectionPaths.Count -eq 11 -and
        @($runtimeHostMutationSelectionPaths | Where-Object {
            $_ -cnotin @($hostMutationScriptPaths + $nebulaPluginTransactionPaths)
        }).Count -eq 0) `
        -Message 'the bounded artifact-builder selection did not exactly combine host-mutation and Nebula transaction runtime files'
    $gameBootstrapScriptPaths = @($script:DysonArtifactRequiredGameBootstrapScripts)
    $gameBootstrapScripts = @($gameBootstrapScriptPaths | ForEach-Object { [System.IO.Path]::GetFileName($_) })
    Assert-ReleaseSelfTest -Condition ($gameBootstrapScripts.Count -eq 5) `
        -Message 'the exact stable game bootstrap allowlist did not contain five entries'
    $cutoverScriptPaths = @($script:DysonArtifactRequiredCutoverScripts)
    $cutoverScripts = @($cutoverScriptPaths | ForEach-Object { [System.IO.Path]::GetFileName($_) })
    Assert-ReleaseSelfTest -Condition ($cutoverScripts.Count -eq 7) `
        -Message 'the exact cutover host allowlist did not contain seven entries'
    $cutoverBrokerScriptPaths = @($script:DysonArtifactRequiredCutoverBrokerScripts)
    $cutoverBrokerScripts = @($cutoverBrokerScriptPaths | ForEach-Object { [System.IO.Path]::GetFileName($_) })
    Assert-ReleaseSelfTest -Condition ($cutoverBrokerScripts.Count -eq 6) `
        -Message 'the exact cutover broker allowlist did not contain six entries'
    $lifecycleBrokerScriptPaths = @($script:DysonArtifactRequiredLifecycleBrokerScripts)
    $lifecycleBrokerScripts = @($lifecycleBrokerScriptPaths | ForEach-Object { [System.IO.Path]::GetFileName($_) })
    Assert-ReleaseSelfTest -Condition ($lifecycleBrokerScripts.Count -eq 6) `
        -Message 'the exact lifecycle broker allowlist did not contain six entries'
    $dataRecoveryScriptPaths = @($script:DysonArtifactRequiredDataRecoveryScripts)
    $dataRecoveryScripts = @($dataRecoveryScriptPaths | ForEach-Object { [System.IO.Path]::GetFileName($_) })
    Assert-ReleaseSelfTest -Condition ($dataRecoveryScripts.Count -eq 5) `
        -Message 'the exact DataRoot recovery allowlist did not contain five entries'
    $configurationFilePaths = @($script:DysonArtifactRequiredConfigurationFiles)
    Assert-ReleaseSelfTest -Condition ($configurationFilePaths.Count -eq 8 -and
        $configurationFilePaths -ccontains `
            'scripts/windows/configuration/SelfTest-DysonControlConfiguration.ps1' -and
        $configurationFilePaths -ccontains `
            'scripts/windows/configuration/New-DysonControlConfigurationSnapshot.ps1' -and
        $configurationFilePaths -ccontains `
            'scripts/windows/configuration/Restore-DysonControlConfiguration.ps1') `
        -Message 'the exact protected configuration allowlist did not contain its eight runtime, transaction, and self-test files'
    $networkFilePaths = @($script:DysonArtifactRequiredNetworkFiles)
    Assert-ReleaseSelfTest -Condition ($networkFilePaths.Count -eq 17) `
        -Message 'the exact Nebula network and hostname-WSS qualification allowlist did not contain seventeen entries'
    $hostnameWssQualificationPaths = @($script:DysonArtifactRequiredHostnameWssQualificationFiles)
    Assert-ReleaseSelfTest -Condition ($hostnameWssQualificationPaths.Count -eq 2) `
        -Message 'the exact hostname-WSS qualification protocol allowlist did not contain two entries'
    $qualificationOrchestrationV2Paths = @($script:DysonArtifactRequiredQualificationOrchestrationV2Files)
    Assert-ReleaseSelfTest -Condition ($qualificationOrchestrationV2Paths.Count -eq 8) `
        -Message 'the exact qualification orchestration V2 allowlist did not contain eight entries'
    $qualificationFrameworkPaths = @($script:DysonArtifactRequiredQualificationFrameworkFiles)
    Assert-ReleaseSelfTest -Condition ($qualificationFrameworkPaths.Count -eq 16) `
        -Message 'the exact qualification V1/V2 framework allowlist did not contain its sixteen-file dependency closure'
    $strictQualificationV2Paths = @($script:DysonArtifactRequiredStrictQualificationV2Files)
    Assert-ReleaseSelfTest -Condition ($strictQualificationV2Paths.Count -eq 39 -and
        @($strictQualificationV2Paths | Where-Object {
            $_ -cnotmatch '^scripts/windows/qualification/'
        }).Count -eq 0) `
        -Message 'the exact strict qualification V2 allowlist did not contain thirty-nine bounded entries'
    $qualificationRuntimePaths = @($script:DysonArtifactRequiredQualificationRuntimeFiles)
    Assert-ReleaseSelfTest -Condition ($qualificationRuntimePaths.Count -eq 65 -and
        @($qualificationOrchestrationV2Paths | Where-Object { $_ -cnotin $qualificationRuntimePaths }).Count -eq 0 -and
        @($qualificationFrameworkPaths | Where-Object { $_ -cnotin $qualificationRuntimePaths }).Count -eq 0 -and
        @($strictQualificationV2Paths | Where-Object { $_ -cnotin $qualificationRuntimePaths }).Count -eq 0) `
        -Message 'the aggregate qualification runtime allowlist did not contain the protocol, orchestration, and strict V2 packages'
    $observabilityRuntimePaths = @($script:DysonArtifactRequiredApiObservabilityRuntimeFiles)
    Assert-ReleaseSelfTest -Condition ($observabilityRuntimePaths.Count -eq 14) `
        -Message 'the exact compiled observability runtime allowlist did not contain fourteen entries'
    $hostnameWssSourcePaths = @($script:DysonArtifactRequiredNebulaHostnameWssSources)
    Assert-ReleaseSelfTest -Condition ($hostnameWssSourcePaths.Count -eq 2) `
        -Message 'the exact hostname-WSS public source contract allowlist did not contain two entries'
    $migrationDocs = @($script:DysonArtifactRequiredMigrationDocs)
    $gsManagerRemovalDocs = @($script:DysonArtifactRequiredGsManagerRemovalDocs)
    $recoveryDocs = @($script:DysonArtifactRequiredRecoveryDocs)
    $networkDocs = @($script:DysonArtifactRequiredNetworkDocs)
    $qualificationDocs = @($script:DysonArtifactRequiredQualificationDocs)
    Assert-ReleaseSelfTest -Condition ($networkDocs.Count -eq 1) `
        -Message 'the exact network connectivity documentation allowlist did not contain one entry'
    Assert-ReleaseSelfTest -Condition ($qualificationDocs.Count -eq 1 -and
        $qualificationDocs[0] -ceq 'docs/PRODUCTION-QUALIFICATION.md') `
        -Message 'the exact production qualification documentation allowlist did not contain its public guide'
    $repositoryRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..\..'))
    $bridgeScripts = @(
        'Build-DysonControlBridgeCandidate.ps1', 'DysonBridge.Common.ps1',
        'DysonBridge.Telemetry.ps1', 'Get-DysonBridgeSimulationTelemetry.ps1',
        'Install-DysonControlBridge.ps1', 'Test-DysonControlBridgeCandidate.ps1',
        'Test-DysonControlBridgeInstallation.ps1', 'Uninstall-DysonControlBridge.ps1'
    )
    $bridgeSourceFiles = @(
        'BridgeFileStore.cs', 'BridgeProtocol.cs', 'DysonControlBridge.csproj',
        'DysonControlBridgePlugin.cs', 'GameSaveAdapter.cs', 'LoadedSaveEvidencePublisher.cs',
        'NebulaNoticeRuntimeCompatibility.cs', 'PlayerNoticeProtocol.cs',
        'PlayerRosterPublisher.cs',
        'SimulationTelemetrySampler.cs',
        'README.md', 'dyson-control-bridge.cfg.example',
        'protocol-tests\DysonControlBridge.ProtocolTests.csproj', 'protocol-tests\Program.cs'
    )
    foreach ($name in $topLevelScripts) {
        Copy-FixtureScript -Source (Join-Path $PSScriptRoot "..\$name") `
            -Destination (Join-Path $fixtureRoot "scripts\windows\$name")
    }
    foreach ($relative in $runtimeHostMutationSelectionPaths) {
        Copy-FixtureScript -Source (Join-Path $repositoryRoot $relative.Replace('/', '\')) `
            -Destination (Join-Path $fixtureRoot $relative.Replace('/', '\'))
    }
    foreach ($relative in $gameBootstrapScriptPaths) {
        $name = [System.IO.Path]::GetFileName($relative)
        Copy-FixtureScript -Source (Join-Path $PSScriptRoot "..\bootstrap\$name") `
            -Destination (Join-Path $fixtureRoot $relative.Replace('/', '\'))
    }
    foreach ($relative in $cutoverScriptPaths) {
        $name = [System.IO.Path]::GetFileName($relative)
        Copy-FixtureScript -Source (Join-Path $PSScriptRoot "..\cutover\$name") `
            -Destination (Join-Path $fixtureRoot $relative.Replace('/', '\'))
    }
    foreach ($relative in $cutoverBrokerScriptPaths) {
        $name = [System.IO.Path]::GetFileName($relative)
        Copy-FixtureScript -Source (Join-Path $PSScriptRoot "..\cutover-broker\$name") `
            -Destination (Join-Path $fixtureRoot $relative.Replace('/', '\'))
    }
    foreach ($relative in $lifecycleBrokerScriptPaths) {
        $name = [System.IO.Path]::GetFileName($relative)
        Copy-FixtureScript -Source (Join-Path $PSScriptRoot "..\lifecycle-broker\$name") `
            -Destination (Join-Path $fixtureRoot $relative.Replace('/', '\'))
    }
    foreach ($relative in $dataRecoveryScriptPaths) {
        $name = [System.IO.Path]::GetFileName($relative)
        Copy-FixtureScript -Source (Join-Path $PSScriptRoot "..\data-recovery\$name") `
            -Destination (Join-Path $fixtureRoot $relative.Replace('/', '\'))
    }
    foreach ($relative in $configurationFilePaths) {
        Copy-FixtureScript -Source (Join-Path $repositoryRoot $relative.Replace('/', '\')) `
            -Destination (Join-Path $fixtureRoot $relative.Replace('/', '\'))
    }
    foreach ($relative in $networkFilePaths) {
        Copy-FixtureScript -Source (Join-Path $repositoryRoot $relative.Replace('/', '\')) `
            -Destination (Join-Path $fixtureRoot $relative.Replace('/', '\'))
    }
    foreach ($relative in @($qualificationRuntimePaths + $hostnameWssSourcePaths)) {
        Copy-FixtureScript -Source (Join-Path $repositoryRoot $relative.Replace('/', '\')) `
            -Destination (Join-Path $fixtureRoot $relative.Replace('/', '\'))
    }
    foreach ($name in $releaseVerifierScripts) {
        Copy-FixtureScript -Source (Join-Path $PSScriptRoot $name) `
            -Destination (Join-Path $fixtureRoot "scripts\windows\release\$name")
    }
    foreach ($name in $deploymentScripts) {
        Copy-FixtureScript -Source (Join-Path $PSScriptRoot "..\deployment\$name") `
            -Destination (Join-Path $fixtureRoot "scripts\windows\deployment\$name")
    }
    foreach ($name in $sessionScripts) {
        Copy-FixtureScript -Source (Join-Path $PSScriptRoot "..\session\$name") `
            -Destination (Join-Path $fixtureRoot "scripts\windows\session\$name")
    }
    foreach ($name in $migrationScripts) {
        Copy-FixtureScript -Source (Join-Path $PSScriptRoot "..\migration\$name") `
            -Destination (Join-Path $fixtureRoot "scripts\windows\migration\$name")
    }
    foreach ($relative in $gsManagerRemovalScriptPaths) {
        $name = [System.IO.Path]::GetFileName($relative)
        Copy-FixtureScript -Source (Join-Path $PSScriptRoot "..\migration\$name") `
            -Destination (Join-Path $fixtureRoot $relative.Replace('/', '\'))
    }
    foreach ($name in $evidenceScripts) {
        Copy-FixtureScript -Source (Join-Path $PSScriptRoot "..\evidence\$name") `
            -Destination (Join-Path $fixtureRoot "scripts\windows\evidence\$name")
    }
    foreach ($name in $bridgeScripts) {
        Copy-FixtureScript -Source (Join-Path $PSScriptRoot "..\bridge\$name") `
            -Destination (Join-Path $fixtureRoot "scripts\windows\bridge\$name")
    }
    foreach ($name in $bridgeSourceFiles) {
        Copy-FixtureScript -Source (Join-Path $PSScriptRoot "..\..\..\integrations\dyson-control-bridge\$name") `
            -Destination (Join-Path $fixtureRoot "integrations\dyson-control-bridge\$name")
    }
    foreach ($relative in @(
        $migrationDocs + $gsManagerRemovalDocs + $recoveryDocs + $networkDocs + $qualificationDocs
    )) {
        Copy-FixtureScript -Source (Join-Path $repositoryRoot $relative.Replace('/', '\')) `
            -Destination (Join-Path $fixtureRoot $relative.Replace('/', '\'))
    }

    $excludedNebulaPrivateSourcePaths = @(
        'scripts/windows/nebula-private-build/README.md',
        'scripts/windows/nebula-private-build/SelfTest-NebulaPrivateBuild.ps1',
        'scripts/windows/nebula-private-build/SelfTest-NebulaPluginTransaction.ps1',
        'scripts/windows/nebula-private-build/Get-NebulaPrivateBinaryMetadata.ps1',
        'scripts/windows/nebula-private-build/New-NebulaPrivateBuildPlan.ps1',
        'scripts/windows/nebula-private-build/New-NebulaPrivateCandidate.ps1',
        'scripts/windows/nebula-private-build/Test-NebulaPrivateCandidate.ps1',
        'scripts/windows/nebula-private-build/private-candidate.dll',
        'scripts/windows/nebula-private-build/private-candidate-evidence.json'
    )
    foreach ($relative in $excludedNebulaPrivateSourcePaths) {
        Write-FixtureText -Path (Join-Path $fixtureRoot $relative.Replace('/', '\')) `
            -Value "Fictional excluded private Nebula fixture: $relative`n"
    }

    $genericRepositoryOnlyApiPaths = @(
        'apps/api/dist/defensive/unlisted.fixture.js',
        'apps/api/dist/defensive/unlisted.fixtures.js'
    )
    $unlistedQualificationFixturePaths = @(
        'scripts/windows/qualification/private-evidence.json',
        'scripts/windows/qualification/.codex-temp/cache.json',
        'scripts/windows/qualification/runtime-cache.bin'
    )
    $repositoryOnlyFixturePaths = @(
        $script:DysonArtifactRepositoryOnlyPaths + $genericRepositoryOnlyApiPaths +
            $unlistedQualificationFixturePaths
    )
    foreach ($relative in $repositoryOnlyFixturePaths) {
        Assert-ReleaseSelfTest -Condition (Test-DysonArtifactRepositoryOnlyPath -RelativePath $relative) `
            -Message "the explicit repository-only policy did not recognize its fixture path: $relative"
        $fixturePath = Join-Path $fixtureRoot $relative.Replace('/', '\')
        if (-not (Test-Path -LiteralPath $fixturePath)) {
            Write-FixtureText -Path $fixturePath -Value "Fictional repository-only fixture: $relative`n"
        }
    }

    $previewOutput = & $newArtifactScript -RepositoryRoot $fixtureRoot -Version '1.2.3-fixture' `
        -OutputPath $artifactA -WhatIf 6>$null
    $preview = Convert-LastJsonResult -Output $previewOutput
    Assert-ReleaseSelfTest -Condition ($preview.state -eq 'preview' -and [bool]$preview.dryRun) -Message 'WhatIf did not return a dry-run plan'
    Assert-ReleaseSelfTest -Condition ([int]$preview.requiredApiLifecycleFiles -eq 1) `
        -Message 'WhatIf did not attest the required game-runtime receipt API file'
    Assert-ReleaseSelfTest -Condition ([int]$preview.requiredApiUpdateRuntimeFiles -eq `
        $script:DysonArtifactRequiredApiUpdateRuntimeFiles.Count) `
        -Message 'WhatIf did not attest the aggregate required compiled Windows runtime API insertion list'
    Assert-ReleaseSelfTest -Condition ([int]$preview.requiredApiHostnameWssRuntimeFiles -eq `
        $script:DysonArtifactRequiredApiHostnameWssRuntimeFiles.Count) `
        -Message 'WhatIf did not attest the exact compiled hostname-WSS client qualification API package'
    Assert-ReleaseSelfTest -Condition ([int]$preview.requiredApiObservabilityRuntimeFiles -eq `
        $observabilityRuntimePaths.Count) `
        -Message 'WhatIf did not attest the exact compiled observability runtime package'
    Assert-ReleaseSelfTest -Condition ([int]$preview.hostMutationLeaseScripts -eq `
        $runtimeHostMutationSelectionPaths.Count) `
        -Message 'WhatIf did not attest the bounded host-mutation and Nebula transaction runtime selection'
    Assert-ReleaseSelfTest -Condition ([int]$preview.bridgeSimulationTelemetryFiles -eq 3) `
        -Message 'WhatIf did not attest the exact Bridge simulation telemetry package'
    Assert-ReleaseSelfTest -Condition ([int]$preview.nebulaNetworkAssessmentFiles -eq 17 -and
        [int]$preview.hostnameWssQualificationProtocolFiles -eq 2 -and
        [int]$preview.qualificationOrchestrationV2Files -eq 8 -and
        [int]$preview.qualificationFrameworkFiles -eq 16 -and
        [int]$preview.strictQualificationV2Files -eq 39 -and
        [int]$preview.qualificationRuntimeFiles -eq 65 -and
        [int]$preview.hostnameWssSourceContractFiles -eq 2 -and
        [int]$preview.networkDocuments -eq 1 -and
        [int]$preview.qualificationDocuments -eq 1) `
        -Message 'WhatIf did not attest the exact Nebula network and strict qualification V2 package'
    Assert-ReleaseSelfTest -Condition (-not (Test-Path -LiteralPath $artifactA)) -Message 'WhatIf created the artifact output'

    $unexpectedObservabilitySource = Join-Path $fixtureRoot `
        'apps\api\src\observability\unreviewed-runtime.ts'
    Write-FixtureText -Path $unexpectedObservabilitySource `
        -Value "export const unreviewedObservabilitySource = true`n"
    $sourceDistDriftMessage = $null
    try {
        & $newArtifactScript -RepositoryRoot $fixtureRoot -Version '1.2.3-fixture' `
            -OutputPath $artifactA -WhatIf 6>$null | Out-Null
    }
    catch { $sourceDistDriftMessage = $_.Exception.Message }
    finally { Remove-Item -LiteralPath $unexpectedObservabilitySource -Force }
    Assert-ReleaseSelfTest -Condition ($sourceDistDriftMessage -ceq `
            'The observability production source tree and fixed dist package are inconsistent.') `
        -Message 'the builder accepted observability production source/dist drift'

    $createdA = Convert-LastJsonResult -Output (& $newArtifactScript -RepositoryRoot $fixtureRoot `
        -Version '1.2.3-fixture' -OutputPath $artifactA -Confirm:$false)
    $createdB = Convert-LastJsonResult -Output (& $newArtifactScript -RepositoryRoot $fixtureRoot `
        -Version '1.2.3-fixture' -OutputPath $artifactB -Confirm:$false)
    Assert-ReleaseSelfTest -Condition ($createdA.state -eq 'created' -and $createdB.state -eq 'created' -and
        [bool]$createdA.observabilityRuntimeApiPackaged -and
        [bool]$createdA.qualificationOrchestrationV2Packaged -and
        [bool]$createdA.bridgeFixedReferenceContractPackaged) `
        -Message 'artifact assembly did not complete or omitted a fixed package attestation'

    $verifiedA = Convert-LastJsonResult -Output (& $testArtifactScript -ArtifactPath $artifactA -ExpectedVersion '1.2.3-fixture')
    $verifiedB = Convert-LastJsonResult -Output (& $testArtifactScript -ArtifactPath $artifactB -ExpectedVersion '1.2.3-fixture')
    Assert-ReleaseSelfTest -Condition ([bool]$verifiedA.ready -and [bool]$verifiedB.ready) -Message 'artifact verification failed'
    Assert-ReleaseSelfTest -Condition ([bool]$verifiedA.publicBridgeSourcePackaged -and -not [bool]$verifiedA.privateBridgeBinariesPackaged) `
        -Message 'artifact verification did not attest the public-source/private-binary Bridge boundary'
    Assert-ReleaseSelfTest -Condition ([bool]$verifiedA.bridgeSimulationTelemetryPackaged) `
        -Message 'artifact verification did not attest the signed Bridge simulation telemetry package'
    Assert-ReleaseSelfTest -Condition ([bool]$verifiedA.bridgeFixedReferenceContractPackaged) `
        -Message 'artifact verification did not attest the fixed Bridge reference contract package'
    Assert-ReleaseSelfTest -Condition ([bool]$verifiedA.gameRuntimeReceiptApiPackaged) `
        -Message 'artifact verification did not attest the compiled game-runtime receipt API'
    Assert-ReleaseSelfTest -Condition ([bool]$verifiedA.hostnameWssClientQualificationApiPackaged -and
        [bool]$verifiedA.hostnameWssQualificationRuntimePackaged) `
        -Message 'artifact verification did not attest the compiled client and protected hostname-WSS qualification runtime'
    Assert-ReleaseSelfTest -Condition ([bool]$verifiedA.observabilityRuntimeApiPackaged -and
        [bool]$verifiedA.qualificationOrchestrationV2Packaged) `
        -Message 'artifact verification did not attest observability and qualification orchestration V2 runtimes'
    Assert-ReleaseSelfTest -Condition ([bool]$verifiedA.windowsUpdateRuntimeApiPackaged) `
        -Message 'artifact verification did not attest the compiled Windows update runtime API'
    Assert-ReleaseSelfTest -Condition ([bool]$verifiedA.nebulaPluginTransactionApiPackaged -and
        [bool]$verifiedA.nebulaPluginTransactionRuntimePackaged -and
        [int]$verifiedA.nebulaPluginTransactionRunnerMappingsRequired -eq 5 -and
        -not [bool]$verifiedA.privateNebulaCandidateBinariesPackaged) `
        -Message 'artifact verification did not attest the exact public Nebula V3 API/runtime and private-binary boundary'
    Assert-ReleaseSelfTest -Condition ([bool]$verifiedA.gsManagerParallelMigrationPackaged -and [bool]$verifiedA.migrationDocumentationPackaged) `
        -Message 'artifact verification did not attest the GSManager parallel-migration tools and documentation'
    Assert-ReleaseSelfTest -Condition ([bool]$verifiedA.gsManagerRecoverableRemovalPackaged -and
        [bool]$verifiedA.gsManagerRemovalDocumentationPackaged) `
        -Message 'artifact verification did not attest the GSManager recoverable-removal tools and documentation'
    Assert-ReleaseSelfTest -Condition ([bool]$verifiedA.privateAcceptanceEvidenceToolingPackaged) `
        -Message 'artifact verification did not attest the private acceptance evidence tooling'
    Assert-ReleaseSelfTest -Condition ([bool]$verifiedA.hostMutationLeaseToolingPackaged) `
        -Message 'artifact verification did not attest the host-mutation lease tooling'
    Assert-ReleaseSelfTest -Condition ([bool]$verifiedA.stableGameBootstrapPackaged) `
        -Message 'artifact verification did not attest the stable game bootstrap tooling'
    Assert-ReleaseSelfTest -Condition ([bool]$verifiedA.cutoverHostToolingPackaged) `
        -Message 'artifact verification did not attest the cutover host tooling'
    Assert-ReleaseSelfTest -Condition ([bool]$verifiedA.cutoverBrokerToolingPackaged) `
        -Message 'artifact verification did not attest the cutover broker tooling'
    Assert-ReleaseSelfTest -Condition ([bool]$verifiedA.lifecycleBrokerToolingPackaged) `
        -Message 'artifact verification did not attest the lifecycle broker tooling'
    Assert-ReleaseSelfTest -Condition ([bool]$verifiedA.dataRootRecoveryToolingPackaged -and
        [bool]$verifiedA.dataRootRecoveryDocumentationPackaged) `
        -Message 'artifact verification did not attest the DataRoot recovery tools and documentation'
    Assert-ReleaseSelfTest -Condition ([bool]$verifiedA.nebulaNetworkAssessmentPackaged -and
        [bool]$verifiedA.networkConnectivityDocumentationPackaged) `
        -Message 'artifact verification did not attest the Nebula network assessment tools and documentation'
    Assert-ReleaseSelfTest -Condition ([bool]$verifiedA.packageLockManifestVersionBound -and
        [bool]$verifiedA.coreWindowsRuntimeAllowlistVerified) `
        -Message 'artifact verification did not attest the package/lock/manifest version chain and core runtime allowlist'
    Assert-ReleaseSelfTest -Condition ($verifiedA.payloadSha256 -eq $verifiedB.payloadSha256) -Message 'identical inputs produced different payload hashes'
    $manifestA = [System.IO.File]::ReadAllText((Join-Path $artifactA 'artifact-manifest.json'), [System.Text.Encoding]::UTF8)
    $manifestB = [System.IO.File]::ReadAllText((Join-Path $artifactB 'artifact-manifest.json'), [System.Text.Encoding]::UTF8)
    Assert-ReleaseSelfTest -Condition ($manifestA -eq $manifestB) -Message 'identical inputs produced different manifests'

    $builderVersionMismatchMessage = $null
    try {
        & $newArtifactScript -RepositoryRoot $fixtureRoot -Version '1.2.3-drift' `
            -OutputPath $artifactVersionMismatch -WhatIf | Out-Null
    }
    catch { $builderVersionMismatchMessage = $_.Exception.Message }
    Assert-ReleaseSelfTest -Condition ($builderVersionMismatchMessage -eq `
            'The API package, lockfile, and requested release version are not exactly bound.') `
        -Message 'artifact builder accepted a version outside the package/lock binding'
    Assert-ReleaseSelfTest -Condition (-not (Test-Path -LiteralPath $artifactVersionMismatch)) `
        -Message 'a package/lock version mismatch created artifact output'

    $packageBindingPath = Join-Path $artifactB 'apps\api\package.json'
    $packageBindingBytes = [System.IO.File]::ReadAllBytes($packageBindingPath)
    try {
        $packageBindingText = [System.IO.File]::ReadAllText($packageBindingPath, [System.Text.Encoding]::UTF8)
        [System.IO.File]::WriteAllText(
            $packageBindingPath,
            $packageBindingText.Replace('1.2.3-fixture', '1.2.3-drift'),
            [System.Text.UTF8Encoding]::new($false)
        )
        $packageVersionDriftMessage = $null
        try { & $testArtifactScript -ArtifactPath $artifactB -ExpectedVersion '1.2.3-fixture' | Out-Null }
        catch { $packageVersionDriftMessage = $_.Exception.Message }
        Assert-ReleaseSelfTest -Condition ($packageVersionDriftMessage -eq `
                'The API package, lockfile, and requested release version are not exactly bound.') `
            -Message 'artifact verification accepted API package version drift'
    }
    finally { [System.IO.File]::WriteAllBytes($packageBindingPath, $packageBindingBytes) }

    $lockBindingPath = Join-Path $artifactB 'apps\api\package-lock.json'
    $lockBindingBytes = [System.IO.File]::ReadAllBytes($lockBindingPath)
    try {
        $lockBinding = Read-DysonArtifactBoundedJsonFile -Path $lockBindingPath `
            -Name 'fixture package-lock.json' -PreserveEmptyPropertyNames
        $lockBinding['version'] = '1.2.3-drift'
        [System.IO.File]::WriteAllText(
            $lockBindingPath,
            ($lockBinding | ConvertTo-Json -Depth 20 -Compress),
            [System.Text.UTF8Encoding]::new($false)
        )
        $lockVersionDriftMessage = $null
        try { & $testArtifactScript -ArtifactPath $artifactB -ExpectedVersion '1.2.3-fixture' | Out-Null }
        catch { $lockVersionDriftMessage = $_.Exception.Message }
        Assert-ReleaseSelfTest -Condition ($lockVersionDriftMessage -eq `
                'The API package, lockfile, and requested release version are not exactly bound.') `
            -Message 'artifact verification accepted top-level lockfile version drift'
    }
    finally { [System.IO.File]::WriteAllBytes($lockBindingPath, $lockBindingBytes) }

    try {
        $lockRootBinding = Read-DysonArtifactBoundedJsonFile -Path $lockBindingPath `
            -Name 'fixture package-lock.json' -PreserveEmptyPropertyNames
        $lockRootPackage = $lockRootBinding['packages']['']
        $lockRootPackage['version'] = '1.2.3-drift'
        [System.IO.File]::WriteAllText(
            $lockBindingPath,
            ($lockRootBinding | ConvertTo-Json -Depth 20 -Compress),
            [System.Text.UTF8Encoding]::new($false)
        )
        $lockRootVersionDriftMessage = $null
        try { & $testArtifactScript -ArtifactPath $artifactB -ExpectedVersion '1.2.3-fixture' | Out-Null }
        catch { $lockRootVersionDriftMessage = $_.Exception.Message }
        Assert-ReleaseSelfTest -Condition ($lockRootVersionDriftMessage -eq `
                'The API package, lockfile, and requested release version are not exactly bound.') `
            -Message 'artifact verification accepted root lockfile package version drift'
    }
    finally { [System.IO.File]::WriteAllBytes($lockBindingPath, $lockBindingBytes) }

    $expectedVersionMismatchMessage = $null
    try { & $testArtifactScript -ArtifactPath $artifactB -ExpectedVersion '1.2.3-drift' | Out-Null }
    catch { $expectedVersionMismatchMessage = $_.Exception.Message }
    Assert-ReleaseSelfTest -Condition ($expectedVersionMismatchMessage -eq `
            'The artifact version does not match the expected version.') `
        -Message 'artifact verification accepted deployment/package expected-version drift'

    $coreRequiredRepresentatives = @(
        $script:DysonArtifactRequiredTopLevelWindowsScripts[0],
        $script:DysonArtifactRequiredReleaseScripts[0],
        $script:DysonArtifactRequiredDeploymentScripts[0],
        $script:DysonArtifactRequiredSessionScripts[0]
    )
    $coreMissingCases = 0
    for ($coreIndex = 0; $coreIndex -lt $coreRequiredRepresentatives.Count; $coreIndex++) {
        $corePath = Join-Path $artifactB $coreRequiredRepresentatives[$coreIndex].Replace('/', '\')
        $coreBackup = Join-Path $testRoot ("required-core-$coreIndex.backup")
        [System.IO.File]::Move($corePath, $coreBackup)
        $coreMissingMessage = $null
        try { & $testArtifactScript -ArtifactPath $artifactB -ExpectedVersion '1.2.3-fixture' | Out-Null }
        catch { $coreMissingMessage = $_.Exception.Message }
        finally {
            if (Test-Path -LiteralPath $coreBackup -PathType Leaf) {
                [System.IO.File]::Move($coreBackup, $corePath)
            }
        }
        Assert-ReleaseSelfTest -Condition ($coreMissingMessage -eq `
                'The core Windows runtime delivery package is incomplete.') `
            -Message "missing core runtime category index $coreIndex did not fail through the exact gate"
        $coreMissingCases++
    }
    $unexpectedCorePath = Join-Path $artifactB 'scripts\windows\unreviewed\Unexpected-Core.ps1'
    Write-FixtureText -Path $unexpectedCorePath -Value "throw 'unexpected core runtime tool'`n"
    $coreExtraMessage = $null
    try { & $testArtifactScript -ArtifactPath $artifactB -ExpectedVersion '1.2.3-fixture' | Out-Null }
    catch { $coreExtraMessage = $_.Exception.Message }
    Assert-ReleaseSelfTest -Condition ($coreExtraMessage -eq `
            'The Windows runtime tools contain a path outside their exact allowlist: scripts/windows/unreviewed/Unexpected-Core.ps1') `
        -Message 'artifact verification accepted an unknown Windows runtime subtree'
    Remove-Item -LiteralPath $unexpectedCorePath -Force
    Assert-ReleaseSelfTest -Condition (-not (Test-Path -LiteralPath (Join-Path $artifactA 'apps\api\dist\app.test.js'))) -Message 'compiled tests entered the artifact'
    Assert-ReleaseSelfTest -Condition (Test-Path -LiteralPath (Join-Path $artifactA `
        'apps\api\dist\lifecycle\game-runtime-receipts.js') -PathType Leaf) `
        -Message 'the compiled game-runtime receipt API was omitted from the artifact'
    foreach ($relative in $script:DysonArtifactRequiredApiUpdateCoreRuntimeFiles) {
        Assert-ReleaseSelfTest -Condition (Test-Path -LiteralPath `
            (Join-Path $artifactA $relative.Replace('/', '\')) -PathType Leaf) `
            -Message "a required Windows update runtime API file was omitted from the artifact: $relative"
    }
    foreach ($relative in $script:DysonArtifactRequiredApiNebulaPluginTransactionFiles) {
        Assert-ReleaseSelfTest -Condition (Test-Path -LiteralPath `
            (Join-Path $artifactA $relative.Replace('/', '\')) -PathType Leaf) `
            -Message "a required Nebula V3 runtime API file was omitted from the artifact: $relative"
    }
    foreach ($relative in $observabilityRuntimePaths) {
        Assert-ReleaseSelfTest -Condition (Test-Path -LiteralPath `
            (Join-Path $artifactA $relative.Replace('/', '\')) -PathType Leaf) `
            -Message "a required observability runtime API file was omitted from the artifact: $relative"
    }
    foreach ($relative in $qualificationOrchestrationV2Paths) {
        Assert-ReleaseSelfTest -Condition (Test-Path -LiteralPath `
            (Join-Path $artifactA $relative.Replace('/', '\')) -PathType Leaf) `
            -Message "a required qualification orchestration V2 file was omitted from the artifact: $relative"
    }
    Assert-ReleaseSelfTest -Condition (-not (Test-Path -LiteralPath (Join-Path $artifactA `
        'apps\api\dist\lifecycle\game-runtime-receipts.test.js'))) `
        -Message 'the game-runtime receipt API test entered the artifact'
    foreach ($relative in $repositoryOnlyFixturePaths) {
        Assert-ReleaseSelfTest -Condition (-not (Test-Path -LiteralPath `
            (Join-Path $artifactA $relative.Replace('/', '\')))) `
            -Message "a repository-only path entered the artifact: $relative"
    }
    Assert-ReleaseSelfTest -Condition (-not (Test-Path -LiteralPath (Join-Path $artifactA 'apps\api\dist\cli'))) -Message 'development CLI entered the artifact'
    Assert-ReleaseSelfTest -Condition (-not (Test-Path -LiteralPath (Join-Path $artifactA 'apps\api\node_modules\dev-only'))) -Message 'workspace node_modules was copied'
    Assert-ReleaseSelfTest -Condition (-not (Test-Path -LiteralPath (Join-Path $artifactA '.env'))) -Message 'workspace .env entered the artifact'
    $packagedQualificationRoot = Join-Path $artifactA 'scripts\windows\qualification'
    $packagedQualificationFiles = @(Get-ChildItem -LiteralPath $packagedQualificationRoot `
        -File -Recurse -Force | ForEach-Object {
            Get-DysonArtifactRelativePath -Root $artifactA -File $_.FullName
        } | Sort-Object -CaseSensitive)
    $expectedPackagedQualificationFiles = @($qualificationRuntimePaths | Sort-Object -CaseSensitive)
    Assert-ReleaseSelfTest -Condition ([string]::Join("`n", $packagedQualificationFiles) -ceq
        [string]::Join("`n", $expectedPackagedQualificationFiles)) `
        -Message 'the runtime artifact did not contain exactly the required qualification runtime files'
    foreach ($relative in $qualificationDocs) {
        Assert-ReleaseSelfTest -Condition (Test-Path -LiteralPath `
            (Join-Path $artifactA $relative.Replace('/', '\')) -PathType Leaf) `
            -Message "the production qualification guide was omitted from the runtime artifact: $relative"
    }
    foreach ($name in $releaseVerifierScripts) {
        Assert-ReleaseSelfTest -Condition (Test-Path -LiteralPath (Join-Path $artifactA "scripts\windows\release\$name") -PathType Leaf) `
            -Message "self-contained release verifier script was omitted: $name"
    }
    $runnerSourceText = [System.IO.File]::ReadAllText($powerShellRunnerSource, [System.Text.Encoding]::UTF8)
    $runnerAllowlist = [regex]::Match(
        $runnerSourceText,
        'const\s+allowedScriptPaths\s*=\s*\{(?<body>.*?)\}\s+as\s+const\s+satisfies',
        [System.Text.RegularExpressions.RegexOptions]::Singleline
    )
    Assert-ReleaseSelfTest -Condition $runnerAllowlist.Success `
        -Message 'the complete PowerShell runner path allowlist could not be read'
    $runnerPathEntries = @(
        [regex]::Matches(
            $runnerAllowlist.Groups['body'].Value,
            "'(?<name>[A-Za-z0-9.-]+\.ps1)'\s*:\s*\[(?<segments>.*?)\]\s*,?",
            [System.Text.RegularExpressions.RegexOptions]::Singleline
        )
    )
    Assert-ReleaseSelfTest -Condition ($runnerPathEntries.Count -gt 0) `
        -Message 'the complete PowerShell runner path allowlist was empty'
    $runnerScriptPaths = @()
    foreach ($entry in $runnerPathEntries) {
        $name = $entry.Groups['name'].Value
        $segments = @(
            [regex]::Matches($entry.Groups['segments'].Value, "'(?<segment>[A-Za-z0-9.-]+)'") |
                ForEach-Object { $_.Groups['segment'].Value }
        )
        Assert-ReleaseSelfTest -Condition ($segments.Count -gt 0 -and $segments[$segments.Count - 1] -ceq $name) `
            -Message "the PowerShell runner path mapping is malformed: $name"
        $runnerScriptPaths += 'scripts/windows/' + [string]::Join('/', $segments)
    }
    Assert-ReleaseSelfTest -Condition (@($runnerScriptPaths | Select-Object -Unique).Count -eq $runnerScriptPaths.Count) `
        -Message 'the PowerShell runner path allowlist contains duplicate artifact targets'
    $expectedNebulaRunnerPaths = @($nebulaPluginRunnerPaths | Sort-Object -CaseSensitive)
    $actualNebulaRunnerPaths = @($runnerScriptPaths | Where-Object {
        $_.StartsWith('scripts/windows/nebula-private-build/', [System.StringComparison]::Ordinal)
    } | Sort-Object -CaseSensitive)
    Assert-ReleaseSelfTest -Condition ($actualNebulaRunnerPaths.Count -eq 5 -and
        [string]::Join("`n", $actualNebulaRunnerPaths) -ceq
            [string]::Join("`n", $expectedNebulaRunnerPaths)) `
        -Message 'the PowerShell runner did not expose exactly the five packaged Nebula V3 transaction mappings'
    $packagedPowerShellPaths = @(
        $script:DysonArtifactRequiredTopLevelWindowsScripts +
        $script:DysonArtifactRequiredReleaseScripts +
        $script:DysonArtifactRequiredDeploymentScripts +
        $script:DysonArtifactRequiredConfigurationFiles +
        $script:DysonArtifactRequiredSessionScripts +
        $script:DysonArtifactRequiredBridgeScripts +
        $script:DysonArtifactRequiredMigrationScripts +
        $script:DysonArtifactRequiredGsManagerRemovalScripts +
        $script:DysonArtifactRequiredEvidenceScripts +
        $script:DysonArtifactRequiredHostMutationScripts +
        $script:DysonArtifactRequiredGameBootstrapScripts +
        $script:DysonArtifactRequiredCutoverScripts +
        $script:DysonArtifactRequiredCutoverBrokerScripts +
        $script:DysonArtifactRequiredLifecycleBrokerScripts +
        $script:DysonArtifactRequiredDataRecoveryScripts +
        $script:DysonArtifactRequiredNetworkFiles +
        $script:DysonArtifactRequiredQualificationRuntimeFiles |
            Where-Object { $_.EndsWith('.ps1', [System.StringComparison]::OrdinalIgnoreCase) }
    )
    foreach ($runnerRelativePath in $runnerScriptPaths) {
        Assert-ReleaseSelfTest -Condition ($packagedPowerShellPaths -ccontains $runnerRelativePath) `
            -Message "the release packaging list drifted from the PowerShell runner path allowlist: $runnerRelativePath"
        Assert-ReleaseSelfTest -Condition (Test-Path -LiteralPath `
            (Join-Path $artifactA $runnerRelativePath.Replace('/', '\')) -PathType Leaf) `
            -Message "an allowlisted PowerShell runner script was omitted from the artifact: $runnerRelativePath"
    }
    foreach ($cutoverRunnerPath in @(
        'scripts/windows/cutover/Get-DysonCutoverEvidence.ps1',
        'scripts/windows/cutover-broker/Submit-DysonCutoverBrokerRequest.ps1'
    )) {
        Assert-ReleaseSelfTest -Condition ($runnerScriptPaths -ccontains $cutoverRunnerPath) `
            -Message "the complete PowerShell runner drift check omitted a cutover mapping: $cutoverRunnerPath"
    }
    foreach ($name in $sessionScripts) {
        Assert-ReleaseSelfTest -Condition (Test-Path -LiteralPath (Join-Path $artifactA "scripts\windows\session\$name") -PathType Leaf) `
            -Message "interactive-session runtime script was omitted: $name"
    }
    foreach ($name in $migrationScripts) {
        Assert-ReleaseSelfTest -Condition (Test-Path -LiteralPath (Join-Path $artifactA "scripts\windows\migration\$name") -PathType Leaf) `
            -Message "a GSManager migration script was omitted from the public artifact: $name"
    }
    foreach ($relative in $gsManagerRemovalScriptPaths) {
        Assert-ReleaseSelfTest -Condition (Test-Path -LiteralPath (Join-Path $artifactA $relative.Replace('/', '\')) -PathType Leaf) `
            -Message "a GSManager recoverable-removal script was omitted from the public artifact: $relative"
    }
    foreach ($name in $evidenceScripts) {
        Assert-ReleaseSelfTest -Condition (Test-Path -LiteralPath (Join-Path $artifactA "scripts\windows\evidence\$name") -PathType Leaf) `
            -Message "a private acceptance evidence tool was omitted from the public artifact: $name"
    }
    foreach ($relative in $hostMutationScriptPaths) {
        Assert-ReleaseSelfTest -Condition (Test-Path -LiteralPath (Join-Path $artifactA $relative.Replace('/', '\')) -PathType Leaf) `
            -Message "a required host-mutation lease script was omitted from the artifact: $relative"
    }
    foreach ($relative in $nebulaPluginTransactionPaths) {
        Assert-ReleaseSelfTest -Condition (Test-Path -LiteralPath (Join-Path $artifactA $relative.Replace('/', '\')) -PathType Leaf) `
            -Message "a required Nebula V3 whole-plugin-tree runtime file was omitted from the artifact: $relative"
    }
    foreach ($relative in $excludedNebulaPrivateSourcePaths) {
        Assert-ReleaseSelfTest -Condition (-not (Test-Path -LiteralPath `
            (Join-Path $artifactA $relative.Replace('/', '\')))) `
            -Message "an excluded private Nebula build/candidate/evidence file entered the public artifact: $relative"
    }
    foreach ($relative in $gameBootstrapScriptPaths) {
        Assert-ReleaseSelfTest -Condition (Test-Path -LiteralPath (Join-Path $artifactA $relative.Replace('/', '\')) -PathType Leaf) `
            -Message "a required stable game bootstrap script was omitted from the artifact: $relative"
    }
    foreach ($relative in $cutoverScriptPaths) {
        Assert-ReleaseSelfTest -Condition (Test-Path -LiteralPath (Join-Path $artifactA $relative.Replace('/', '\')) -PathType Leaf) `
            -Message "a required cutover host script was omitted from the artifact: $relative"
    }
    foreach ($relative in $cutoverBrokerScriptPaths) {
        Assert-ReleaseSelfTest -Condition (Test-Path -LiteralPath (Join-Path $artifactA $relative.Replace('/', '\')) -PathType Leaf) `
            -Message "a required cutover broker script was omitted from the artifact: $relative"
    }
    foreach ($relative in $lifecycleBrokerScriptPaths) {
        Assert-ReleaseSelfTest -Condition (Test-Path -LiteralPath (Join-Path $artifactA $relative.Replace('/', '\')) -PathType Leaf) `
            -Message "a required lifecycle broker script was omitted from the artifact: $relative"
    }
    foreach ($relative in $dataRecoveryScriptPaths) {
        Assert-ReleaseSelfTest -Condition (Test-Path -LiteralPath (Join-Path $artifactA $relative.Replace('/', '\')) -PathType Leaf) `
            -Message "a required DataRoot recovery script was omitted from the artifact: $relative"
    }
    foreach ($relative in $networkFilePaths) {
        Assert-ReleaseSelfTest -Condition (Test-Path -LiteralPath (Join-Path $artifactA $relative.Replace('/', '\')) -PathType Leaf) `
            -Message "a required Nebula network assessment file was omitted from the artifact: $relative"
    }
    foreach ($relative in $script:DysonArtifactRequiredApiHostnameWssRuntimeFiles) {
        Assert-ReleaseSelfTest -Condition (Test-Path -LiteralPath (Join-Path $artifactA $relative.Replace('/', '\')) -PathType Leaf) `
            -Message "a required compiled hostname-WSS client qualification API file was omitted from the artifact: $relative"
    }
    foreach ($relative in @($hostnameWssQualificationPaths + $hostnameWssSourcePaths)) {
        Assert-ReleaseSelfTest -Condition (Test-Path -LiteralPath (Join-Path $artifactA $relative.Replace('/', '\')) -PathType Leaf) `
            -Message "a required hostname-WSS qualification protocol or source-contract file was omitted from the artifact: $relative"
    }
    $packagedRuntimeTaskSelfTest = Convert-LastJsonResult -Output (Invoke-PackagedSelfTest `
        -Script (Join-Path $artifactA 'scripts\windows\SelfTest-DysonRuntimeTasks.ps1'))
    Assert-ReleaseSelfTest -Condition ($packagedRuntimeTaskSelfTest.protocol -eq 'DYSON_CONTROL_RUNTIME_TASK_SELFTEST_V2' -and
        $packagedRuntimeTaskSelfTest.state -eq 'passed' -and -not [bool]$packagedRuntimeTaskSelfTest.productionSchedulerTouched) `
        -Message 'the packaged runtime-task transaction did not pass its self-contained shadow-scheduler test'
    $packagedGameBootstrapSelfTest = Convert-LastJsonResult -Output (Invoke-PackagedSelfTest `
        -Script (Join-Path $artifactA 'scripts\windows\bootstrap\SelfTest-DysonGameLifecycleBootstrap.ps1'))
    Assert-ReleaseSelfTest -Condition ($packagedGameBootstrapSelfTest.protocol -eq 'DYSON_CONTROL_GAME_BOOTSTRAP_SELFTEST_V1' -and
        $packagedGameBootstrapSelfTest.state -eq 'passed' -and
        [bool]$packagedGameBootstrapSelfTest.publicReceiptsWerePathFree -and
        [bool]$packagedGameBootstrapSelfTest.unrelatedProcessPreserved) `
        -Message 'the packaged stable game bootstrap did not pass its self-contained shadow-runtime test'
    $packagedCutoverHostSelfTest = Convert-LastJsonResult -Output (Invoke-PackagedSelfTest `
        -Script (Join-Path $artifactA 'scripts\windows\cutover\SelfTest-DysonCutoverHost.ps1'))
    Assert-ReleaseSelfTest -Condition ($packagedCutoverHostSelfTest.protocol -ceq 'DYSON_CONTROL_CUTOVER_HOST_SELFTEST_V1' -and
        $packagedCutoverHostSelfTest.status -ceq 'passed' -and
        [int]$packagedCutoverHostSelfTest.testCount -ge 13 -and
        @($packagedCutoverHostSelfTest.tests).Count -eq [int]$packagedCutoverHostSelfTest.testCount) `
        -Message 'the packaged cutover host tools did not pass their self-contained shadow test'
    $packagedCutoverBrokerSelfTest = Convert-LastJsonResult -Output (Invoke-PackagedSelfTest `
        -Script (Join-Path $artifactA 'scripts\windows\cutover-broker\SelfTest-DysonCutoverBroker.ps1'))
    Assert-ReleaseSelfTest -Condition ($packagedCutoverBrokerSelfTest.protocol -ceq 'DYSON_CONTROL_CUTOVER_BROKER_SELFTEST_V1' -and
        [int]$packagedCutoverBrokerSelfTest.schemaVersion -eq 1 -and
        $packagedCutoverBrokerSelfTest.status -ceq 'passed' -and
        [int]$packagedCutoverBrokerSelfTest.count -ge 38 -and
        @($packagedCutoverBrokerSelfTest.tests).Count -eq [int]$packagedCutoverBrokerSelfTest.count) `
        -Message ('the packaged cutover broker did not pass its self-contained shadow test: ' +
            ($packagedCutoverBrokerSelfTest | ConvertTo-Json -Depth 8 -Compress))
    $packagedLifecycleBrokerSelfTest = Convert-LastJsonResult -Output (Invoke-PackagedSelfTest `
        -Script (Join-Path $artifactA 'scripts\windows\lifecycle-broker\SelfTest-DysonLifecycleBroker.ps1'))
    Assert-ReleaseSelfTest -Condition ($packagedLifecycleBrokerSelfTest.protocol -ceq `
            'DYSON_CONTROL_LIFECYCLE_BROKER_SELFTEST_V1' -and
        [int]$packagedLifecycleBrokerSelfTest.schemaVersion -eq 1 -and
        $packagedLifecycleBrokerSelfTest.status -ceq 'passed' -and
        [int]$packagedLifecycleBrokerSelfTest.passed -ge 46 -and
        [int]$packagedLifecycleBrokerSelfTest.failed -eq 0 -and
        @($packagedLifecycleBrokerSelfTest.failures).Count -eq 0 -and
        [string]$packagedLifecycleBrokerSelfTest.backend -ceq 'Shadow' -and
        -not [bool]$packagedLifecycleBrokerSelfTest.productionSchedulerTouched) `
        -Message 'the packaged lifecycle broker did not pass its self-contained shadow test'
    $packagedDataRecoverySelfTest = Convert-LastJsonResult -Output (Invoke-PackagedSelfTest `
        -Script (Join-Path $artifactA 'scripts\windows\data-recovery\SelfTest-DysonDataRootRecovery.ps1') `
        -SuppressInformation)
    Assert-ReleaseSelfTest -Condition ($packagedDataRecoverySelfTest.protocol -ceq `
            'DYSON_CONTROL_DATA_ROOT_RECOVERY_SELFTEST_V1' -and
        [int]$packagedDataRecoverySelfTest.schemaVersion -eq 1 -and
        $packagedDataRecoverySelfTest.status -ceq 'passed' -and
        [bool]$packagedDataRecoverySelfTest.shadowOnly -and
        -not [bool]$packagedDataRecoverySelfTest.productionMutation -and
        [bool]$packagedDataRecoverySelfTest.sqliteWalRejected -and
        [bool]$packagedDataRecoverySelfTest.sqliteShmRejected -and
        [bool]$packagedDataRecoverySelfTest.byteAclRollbackExact -and
        [bool]$packagedDataRecoverySelfTest.secretFreeOutput) `
        -Message 'the packaged DataRoot recovery tools did not pass their self-contained Shadow test'
    $packagedNetworkSelfTest = Convert-LastJsonResult -Output (Invoke-PackagedSelfTest `
        -Script (Join-Path $artifactA 'scripts\windows\network\SelfTest-DysonNebulaNetwork.ps1') `
        -SuppressInformation)
    Assert-ReleaseSelfTest -Condition ($packagedNetworkSelfTest.protocol -ceq `
            'DYSON_NEBULA_NETWORK_SHADOW_SELFTEST_V1' -and
        $packagedNetworkSelfTest.state -ceq 'passed' -and
        [int]$packagedNetworkSelfTest.assessmentSchemaVersion -eq 1 -and
        [int]$packagedNetworkSelfTest.assessmentScenarios -eq 2 -and
        [int]$packagedNetworkSelfTest.nativeDnsCalls -eq 0 -and
        [int]$packagedNetworkSelfTest.nativeTcpCalls -eq 0 -and
        [int]$packagedNetworkSelfTest.nativeWebSocketCalls -eq 0 -and
        [bool]$packagedNetworkSelfTest.remoteProbeGateValidated -and
        [bool]$packagedNetworkSelfTest.mutationPermanentlyDisabled -and
        [bool]$packagedNetworkSelfTest.outputPrivacyValidated -and
        -not [bool]$packagedNetworkSelfTest.productionChanged) `
        -Message 'the packaged Nebula network assessment did not pass its self-contained Shadow test'
    $packagedNetworkV2SelfTest = Convert-LastJsonResult -Output (Invoke-PackagedSelfTest `
        -Script (Join-Path $artifactA 'scripts\windows\network\SelfTest-DysonNebulaNetworkV2.ps1') `
        -SuppressInformation)
    Assert-ReleaseSelfTest -Condition ($packagedNetworkV2SelfTest.protocol -ceq `
            'DYSON_NEBULA_NETWORK_V2_SELFTEST_V1' -and
        $packagedNetworkV2SelfTest.state -ceq 'passed' -and
        [string]$packagedNetworkV2SelfTest.assessmentProtocol -ceq `
            'DYSON_NEBULA_NETWORK_ASSESSMENT_V2' -and
        [int]$packagedNetworkV2SelfTest.assessmentSchemaVersion -eq 2 -and
        [bool]$packagedNetworkV2SelfTest.schemaConsistencyGatesValidated -and
        -not [bool]$packagedNetworkV2SelfTest.productionChanged -and
        -not [bool]$packagedNetworkV2SelfTest.networkMutationImplemented) `
        -Message 'the packaged Nebula network V2 assessment did not pass its self-contained Shadow test'
    $packagedHostnameWssSelfTest = Convert-LastJsonResult -Output (Invoke-PackagedSelfTest `
        -Script (Join-Path $artifactA `
            'scripts\windows\network\SelfTest-DysonHostnameWssQualification.ps1') `
        -SuppressInformation)
    Assert-ReleaseSelfTest -Condition ($packagedHostnameWssSelfTest.protocol -ceq `
            'DYSON_NEBULA_HOSTNAME_WSS_QUALIFICATION_SELFTEST_V1' -and
        [int]$packagedHostnameWssSelfTest.schemaVersion -eq 1 -and
        $packagedHostnameWssSelfTest.status -ceq 'passed' -and
        [int]$packagedHostnameWssSelfTest.testCount -eq 20 -and
        [int]$packagedHostnameWssSelfTest.passedCount -eq 20 -and
        [string]$packagedHostnameWssSelfTest.exampleAuthorityOnly -ceq 'example.com' -and
        -not [bool]$packagedHostnameWssSelfTest.productionEvidenceTouched -and
        -not [bool]$packagedHostnameWssSelfTest.networkTouched -and
        -not [bool]$packagedHostnameWssSelfTest.productionChanged) `
        -Message 'the packaged protected hostname-WSS qualification chain did not pass its self-contained test'
    $packagedOrchestrationV2SelfTest = Convert-LastJsonResult -Output (Invoke-PackagedSelfTest `
        -Script (Join-Path $artifactA `
            'scripts\windows\qualification\Invoke-QualificationOrchestrationV2SelfTest.ps1') `
        -SuppressInformation)
    Assert-ReleaseSelfTest -Condition ($packagedOrchestrationV2SelfTest.protocol -ceq `
            'DYSON_QUALIFICATION_ORCHESTRATION_V2_SELFTEST' -and
        [int]$packagedOrchestrationV2SelfTest.schemaVersion -eq 2 -and
        $packagedOrchestrationV2SelfTest.result -ceq 'passed' -and
        [int]$packagedOrchestrationV2SelfTest.testCount -eq
            [int]$packagedOrchestrationV2SelfTest.passedCount -and
        @($packagedOrchestrationV2SelfTest.actionsCovered).Count -eq 11 -and
        -not [bool]$packagedOrchestrationV2SelfTest.productionBackendInvoked -and
        -not [bool]$packagedOrchestrationV2SelfTest.productionMutationImplemented -and
        -not [bool]$packagedOrchestrationV2SelfTest.productionChanged) `
        -Message 'the packaged qualification orchestration V2 runtime did not pass its self-contained protected-receipt test'
    Assert-ReleaseSelfTest -Condition (Test-Path -LiteralPath (Join-Path $artifactA `
            'scripts\windows\configuration\SelfTest-DysonControlConfiguration.ps1') -PathType Leaf) `
        -Message 'the protected configuration self-test was omitted from the public artifact'
    foreach ($runtimeDeliveryName in @(
        'DysonNodeRuntime.Transaction.ps1',
        'Install-DysonNodeRuntime.ps1',
        'Repair-DysonNodeRuntime.ps1'
    )) {
        Assert-ReleaseSelfTest -Condition (Test-Path -LiteralPath (Join-Path $artifactA `
                ('scripts\windows\deployment\' + $runtimeDeliveryName)) -PathType Leaf) `
            -Message "the protected Node runtime delivery chain omitted $runtimeDeliveryName"
    }
    $packagedGsManagerRemovalSelfTest = Convert-LastJsonResult -Output (Invoke-PackagedSelfTest `
        -Script (Join-Path $artifactA 'scripts\windows\migration\SelfTest-DysonGsManagerRemoval.ps1') `
        -SuppressInformation)
    Assert-ReleaseSelfTest -Condition ($packagedGsManagerRemovalSelfTest.protocol -ceq `
            'DYSON_GSMANAGER_REMOVAL_SELFTEST_V1' -and
        $packagedGsManagerRemovalSelfTest.status -ceq 'passed' -and
        [int]$packagedGsManagerRemovalSelfTest.testCount -ge 11 -and
        @($packagedGsManagerRemovalSelfTest.tests).Count -eq [int]$packagedGsManagerRemovalSelfTest.testCount) `
        -Message 'the packaged GSManager recoverable-removal tools did not pass their self-contained Shadow test'
    $packagedEvidenceSelfTest = Convert-LastJsonResult -Output (Invoke-PackagedSelfTest `
        -Script (Join-Path $artifactA 'scripts\windows\evidence\SelfTest-DysonPrivateEvidenceBundle.ps1'))
    Assert-ReleaseSelfTest -Condition ($packagedEvidenceSelfTest.protocol -eq 'DYSON_PRIVATE_ACCEPTANCE_EVIDENCE_SELFTEST_V1' -and
        $packagedEvidenceSelfTest.state -eq 'passed' -and -not [bool]$packagedEvidenceSelfTest.productionChanged) `
        -Message 'the packaged private acceptance evidence tools did not pass their self-contained self-test'
    foreach ($relative in $migrationDocs) {
        Assert-ReleaseSelfTest -Condition (Test-Path -LiteralPath (Join-Path $artifactA $relative.Replace('/', '\')) -PathType Leaf) `
            -Message "GSManager migration documentation was omitted from the public artifact: $relative"
    }
    foreach ($relative in $gsManagerRemovalDocs) {
        Assert-ReleaseSelfTest -Condition (Test-Path -LiteralPath (Join-Path $artifactA $relative.Replace('/', '\')) -PathType Leaf) `
            -Message "GSManager recoverable-removal documentation was omitted from the public artifact: $relative"
    }
    foreach ($relative in $recoveryDocs) {
        Assert-ReleaseSelfTest -Condition (Test-Path -LiteralPath (Join-Path $artifactA $relative.Replace('/', '\')) -PathType Leaf) `
            -Message "DataRoot recovery documentation was omitted from the public artifact: $relative"
    }
    foreach ($relative in $networkDocs) {
        Assert-ReleaseSelfTest -Condition (Test-Path -LiteralPath (Join-Path $artifactA $relative.Replace('/', '\')) -PathType Leaf) `
            -Message "network connectivity documentation was omitted from the public artifact: $relative"
    }
    foreach ($name in $bridgeScripts) {
        Assert-ReleaseSelfTest -Condition (Test-Path -LiteralPath (Join-Path $artifactA "scripts\windows\bridge\$name") -PathType Leaf) `
            -Message "a Bridge delivery script was omitted from the public artifact: $name"
    }
    foreach ($name in @($bridgeSourceFiles | Where-Object { $_ -notlike 'protocol-tests*' })) {
        Assert-ReleaseSelfTest -Condition (Test-Path -LiteralPath (Join-Path $artifactA "integrations\dyson-control-bridge\$name") -PathType Leaf) `
            -Message "a required public Bridge source file was omitted: $name"
    }
    Assert-ReleaseSelfTest -Condition ([bool](Assert-DysonArtifactBridgeFixedReferenceContract `
        -ProjectPath (Join-Path $artifactA `
            'integrations\dyson-control-bridge\DysonControlBridge.csproj') `
        -CommonScriptPath (Join-Path $artifactA `
            'scripts\windows\bridge\DysonBridge.Common.ps1'))) `
        -Message 'the packaged Bridge source/build contract did not preserve its fixed reference set'
    Assert-ReleaseSelfTest -Condition (-not (Test-Path -LiteralPath (Join-Path $artifactA 'integrations\dyson-control-bridge\protocol-tests'))) `
        -Message 'Bridge protocol-test build inputs entered the runtime artifact'
    $publicBridgeBinaries = @(Get-ChildItem -LiteralPath (Join-Path $artifactA 'integrations\dyson-control-bridge') -File -Recurse -Force |
        Where-Object { $_.Extension.ToLowerInvariant() -in @('.dll', '.pdb', '.exe') })
    Assert-ReleaseSelfTest -Condition ($publicBridgeBinaries.Count -eq 0) `
        -Message 'a compiled or proprietary assembly entered the public Bridge source package'
    Assert-ReleaseSelfTest -Condition (
        -not (Test-Path -LiteralPath (Join-Path $artifactA `
            'scripts\windows\bridge\SelfTest-DysonBridgeSimulationTelemetry.ps1')) -and
        -not (Test-Path -LiteralPath (Join-Path $artifactA `
            'scripts\windows\bridge\SelfTest-DysonControlBridge.ps1'))
    ) -Message 'a repository-only Bridge self-test entered the runtime artifact'

    $packagedTelemetrySelfTestRoot = Join-Path $testRoot 'packaged-bridge-telemetry-selftest'
    foreach ($name in @('DysonBridge.Telemetry.ps1', 'Get-DysonBridgeSimulationTelemetry.ps1')) {
        Copy-FixtureScript -Source (Join-Path $artifactA "scripts\windows\bridge\$name") `
            -Destination (Join-Path $packagedTelemetrySelfTestRoot $name)
    }
    Copy-FixtureScript -Source (Join-Path $PSScriptRoot `
        '..\bridge\SelfTest-DysonBridgeSimulationTelemetry.ps1') `
        -Destination (Join-Path $packagedTelemetrySelfTestRoot `
            'SelfTest-DysonBridgeSimulationTelemetry.ps1')
    $packagedTelemetrySelfTest = Convert-LastJsonResult -Output (Invoke-PackagedSelfTest `
        -Script (Join-Path $packagedTelemetrySelfTestRoot `
            'SelfTest-DysonBridgeSimulationTelemetry.ps1'))
    Assert-ReleaseSelfTest -Condition ($packagedTelemetrySelfTest.protocol -ceq `
            'DYSON_CONTROL_SIMULATION_TELEMETRY_SELFTEST_V1' -and
        $packagedTelemetrySelfTest.state -ceq 'passed' -and
        [bool]$packagedTelemetrySelfTest.powershell51Compatible -and
        [bool]$packagedTelemetrySelfTest.crossRuntimeVectors -and
        [bool]$packagedTelemetrySelfTest.productionWrapper -and
        [bool]$packagedTelemetrySelfTest.actualUpsAndTps -and
        [bool]$packagedTelemetrySelfTest.tamperRejected -and
        [bool]$packagedTelemetrySelfTest.replayRejected -and
        [bool]$packagedTelemetrySelfTest.staleRejected -and
        [bool]$packagedTelemetrySelfTest.sessionMismatchRejected -and
        [bool]$packagedTelemetrySelfTest.pidMismatchRejected -and
        [bool]$packagedTelemetrySelfTest.restartGenerationBound -and
        [int]$packagedTelemetrySelfTest.shadowCommandsInvoked -eq 0) `
        -Message 'the packaged Bridge simulation telemetry runtime did not pass its repository-only Shadow test'

    $requiredBridgeScript = Join-Path $artifactB 'scripts\windows\bridge\Test-DysonControlBridgeCandidate.ps1'
    $requiredBridgeScriptBackup = Join-Path $testRoot 'required-bridge-script.backup'
    [System.IO.File]::Move($requiredBridgeScript, $requiredBridgeScriptBackup)
    $bridgeMissingRejected = $false
    try { & $testArtifactScript -ArtifactPath $artifactB -ExpectedVersion '1.2.3-fixture' | Out-Null }
    catch { $bridgeMissingRejected = $true }
    Assert-ReleaseSelfTest -Condition $bridgeMissingRejected -Message 'an artifact missing a required Bridge delivery script was accepted'
    [System.IO.File]::Move($requiredBridgeScriptBackup, $requiredBridgeScript)

    $requiredLoadedSavePublisher = Join-Path $artifactB `
        'integrations\dyson-control-bridge\LoadedSaveEvidencePublisher.cs'
    $requiredLoadedSavePublisherBackup = Join-Path $testRoot `
        'required-loaded-save-evidence-publisher.backup'
    [System.IO.File]::Move($requiredLoadedSavePublisher, $requiredLoadedSavePublisherBackup)
    $loadedSavePublisherMissingMessage = $null
    try { & $testArtifactScript -ArtifactPath $artifactB -ExpectedVersion '1.2.3-fixture' | Out-Null }
    catch { $loadedSavePublisherMissingMessage = $_.Exception.Message }
    finally {
        if (Test-Path -LiteralPath $requiredLoadedSavePublisherBackup -PathType Leaf) {
            [System.IO.File]::Move($requiredLoadedSavePublisherBackup, $requiredLoadedSavePublisher)
        }
    }
    Assert-ReleaseSelfTest -Condition ($loadedSavePublisherMissingMessage -ceq `
            'The public Bridge source/build delivery package is incomplete.') `
        -Message 'a missing LoadedSaveEvidencePublisher.cs did not fail through the exact Bridge required-file gate'

    $bridgeContractManifestPath = Join-Path $artifactB 'artifact-manifest.json'
    $bridgeContractManifestBytes = [System.IO.File]::ReadAllBytes($bridgeContractManifestPath)
    $bridgeContractProjectPath = Join-Path $artifactB `
        'integrations\dyson-control-bridge\DysonControlBridge.csproj'
    $bridgeContractProjectBytes = [System.IO.File]::ReadAllBytes($bridgeContractProjectPath)
    try {
        $bridgeContractProjectText = [System.IO.File]::ReadAllText(
            $bridgeContractProjectPath,
            [System.Text.Encoding]::UTF8
        ).Replace(
            '<Reference Include="netstandard">',
            '<Reference Include="netstandard" Condition="''1'' == ''0''">'
        ).Replace(
            '</ItemGroup>',
            "<!-- <Reference Include=`"netstandard`"><HintPath>`$(DysonServerRoot)\DSPGAME_Data\Managed\netstandard.dll</HintPath><Private>false</Private></Reference> -->`n  </ItemGroup>"
        )
        [System.IO.File]::WriteAllText(
            $bridgeContractProjectPath,
            $bridgeContractProjectText,
            [System.Text.UTF8Encoding]::new($false)
        )
        [void](Write-DysonArtifactManifest -ArtifactRoot $artifactB -Version '1.2.3-fixture' `
            -DevDependenciesExcluded @())
        $bridgeConditionalDecoyRejected = $false
        try { & $testArtifactScript -ArtifactPath $artifactB -ExpectedVersion '1.2.3-fixture' | Out-Null }
        catch { $bridgeConditionalDecoyRejected = $true }
        Assert-ReleaseSelfTest -Condition $bridgeConditionalDecoyRejected `
            -Message 'a re-manifested conditional Bridge netstandard reference with a textual decoy was accepted'
    }
    finally {
        [System.IO.File]::WriteAllBytes($bridgeContractProjectPath, $bridgeContractProjectBytes)
        [System.IO.File]::WriteAllBytes($bridgeContractManifestPath, $bridgeContractManifestBytes)
    }

    $bridgeContractCommonPath = Join-Path $artifactB `
        'scripts\windows\bridge\DysonBridge.Common.ps1'
    $bridgeContractCommonBytes = [System.IO.File]::ReadAllBytes($bridgeContractCommonPath)
    try {
        $fixedNetstandardSpecification = `
            "name = 'netstandard.dll'; relativePath = 'DSPGAME_Data\Managed\netstandard.dll'"
        $bridgeContractCommonText = [System.IO.File]::ReadAllText(
            $bridgeContractCommonPath,
            [System.Text.Encoding]::UTF8
        ).Replace(
            $fixedNetstandardSpecification,
            "name = 'netstandard.dll'; relativePath = 'DSPGAME_Data\Managed\netstandard-missing.dll'"
        )
        $bridgeContractCommonText = "# $fixedNetstandardSpecification`n" + $bridgeContractCommonText
        [System.IO.File]::WriteAllText(
            $bridgeContractCommonPath,
            $bridgeContractCommonText,
            [System.Text.UTF8Encoding]::new($false)
        )
        [void](Write-DysonArtifactManifest -ArtifactRoot $artifactB -Version '1.2.3-fixture' `
            -DevDependenciesExcluded @())
        $bridgeCommentDecoyRejected = $false
        try { & $testArtifactScript -ArtifactPath $artifactB -ExpectedVersion '1.2.3-fixture' | Out-Null }
        catch { $bridgeCommentDecoyRejected = $true }
        Assert-ReleaseSelfTest -Condition $bridgeCommentDecoyRejected `
            -Message 'a re-manifested Bridge common-script reference drift hidden by a comment decoy was accepted'
    }
    finally {
        [System.IO.File]::WriteAllBytes($bridgeContractCommonPath, $bridgeContractCommonBytes)
        [System.IO.File]::WriteAllBytes($bridgeContractManifestPath, $bridgeContractManifestBytes)
    }

    $bridgeTelemetryRequiredPaths = @($script:DysonArtifactRequiredBridgeSimulationTelemetryFiles)
    $bridgeTelemetryMissingFileCases = 0
    for ($telemetryIndex = 0; $telemetryIndex -lt $bridgeTelemetryRequiredPaths.Count; $telemetryIndex++) {
        $requiredTelemetryPath = Join-Path $artifactB `
            $bridgeTelemetryRequiredPaths[$telemetryIndex].Replace('/', '\')
        $requiredTelemetryBackup = Join-Path $testRoot ("required-bridge-telemetry-$telemetryIndex.backup")
        [IO.File]::Move($requiredTelemetryPath, $requiredTelemetryBackup)
        $telemetryMissingMessage = $null
        try { & $testArtifactScript -ArtifactPath $artifactB -ExpectedVersion '1.2.3-fixture' | Out-Null }
        catch { $telemetryMissingMessage = $_.Exception.Message }
        finally {
            if (Test-Path -LiteralPath $requiredTelemetryBackup -PathType Leaf) {
                [IO.File]::Move($requiredTelemetryBackup, $requiredTelemetryPath)
            }
        }
        Assert-ReleaseSelfTest -Condition ($telemetryMissingMessage -ceq `
            'The public Bridge source/build delivery package is incomplete.') `
            -Message "removing required Bridge telemetry file index $telemetryIndex did not fail through the exact required-file gate"
        $bridgeTelemetryMissingFileCases++
    }
    Assert-ReleaseSelfTest -Condition ($bridgeTelemetryMissingFileCases -eq
        $script:DysonArtifactRequiredBridgeSimulationTelemetryFiles.Count) `
        -Message 'not every required Bridge simulation telemetry file was covered by a removal test'

    $unexpectedBridgeTelemetryPath = Join-Path $artifactB `
        'scripts\windows\bridge\Unexpected-Telemetry.ps1'
    Write-FixtureText -Path $unexpectedBridgeTelemetryPath `
        -Value "throw 'unexpected Bridge telemetry fixture'`n"
    $bridgeTelemetryExtraMessage = $null
    try { & $testArtifactScript -ArtifactPath $artifactB -ExpectedVersion '1.2.3-fixture' | Out-Null }
    catch { $bridgeTelemetryExtraMessage = $_.Exception.Message }
    Assert-ReleaseSelfTest -Condition ($bridgeTelemetryExtraMessage -ceq `
        'The Bridge delivery tools contain a path outside their exact allowlist: scripts/windows/bridge/Unexpected-Telemetry.ps1') `
        -Message 'an extra Bridge telemetry script did not fail through the exact allowlist gate'
    Remove-Item -LiteralPath $unexpectedBridgeTelemetryPath -Force

    Write-FixtureText -Path (Join-Path $artifactB 'integrations\dyson-control-bridge\unexpected.cs') -Value "namespace Fictional { }`n"
    $bridgeExtraRejected = $false
    try { & $testArtifactScript -ArtifactPath $artifactB -ExpectedVersion '1.2.3-fixture' | Out-Null }
    catch { $bridgeExtraRejected = $true }
    Assert-ReleaseSelfTest -Condition $bridgeExtraRejected -Message 'an extra public Bridge source file was accepted'
    Remove-Item -LiteralPath (Join-Path $artifactB 'integrations\dyson-control-bridge\unexpected.cs') -Force

    $requiredMigrationScript = Join-Path $artifactB 'scripts\windows\migration\Test-DysonGsManagerSnapshot.ps1'
    $requiredMigrationScriptBackup = Join-Path $testRoot 'required-migration-script.backup'
    [System.IO.File]::Move($requiredMigrationScript, $requiredMigrationScriptBackup)
    $migrationMissingRejected = $false
    try { & $testArtifactScript -ArtifactPath $artifactB -ExpectedVersion '1.2.3-fixture' | Out-Null }
    catch { $migrationMissingRejected = $true }
    Assert-ReleaseSelfTest -Condition $migrationMissingRejected -Message 'an artifact missing a required GSManager migration script was accepted'
    [System.IO.File]::Move($requiredMigrationScriptBackup, $requiredMigrationScript)

    Write-FixtureText -Path (Join-Path $artifactB 'scripts\windows\migration\Unexpected-Migration.ps1') -Value "throw 'unexpected migration tool'`n"
    $migrationExtraRejected = $false
    try { & $testArtifactScript -ArtifactPath $artifactB -ExpectedVersion '1.2.3-fixture' | Out-Null }
    catch { $migrationExtraRejected = $true }
    Assert-ReleaseSelfTest -Condition $migrationExtraRejected -Message 'an extra GSManager migration script was accepted'
    Remove-Item -LiteralPath (Join-Path $artifactB 'scripts\windows\migration\Unexpected-Migration.ps1') -Force

    $requiredRuntimeReceiptApi = Join-Path $artifactB 'apps\api\dist\lifecycle\game-runtime-receipts.js'
    $requiredRuntimeReceiptApiBackup = Join-Path $testRoot 'required-game-runtime-receipts.backup'
    [System.IO.File]::Move($requiredRuntimeReceiptApi, $requiredRuntimeReceiptApiBackup)
    $runtimeReceiptMissingMessage = $null
    try { & $testArtifactScript -ArtifactPath $artifactB -ExpectedVersion '1.2.3-fixture' | Out-Null }
    catch { $runtimeReceiptMissingMessage = $_.Exception.Message }
    finally {
        if (Test-Path -LiteralPath $requiredRuntimeReceiptApiBackup -PathType Leaf) {
            [System.IO.File]::Move($requiredRuntimeReceiptApiBackup, $requiredRuntimeReceiptApi)
        }
    }
    Assert-ReleaseSelfTest -Condition ($runtimeReceiptMissingMessage -eq `
            'The game-runtime receipt API delivery package is incomplete.') `
        -Message 'a missing compiled game-runtime receipt API did not fail through its exact required-file gate'

    $hostnameWssApiMissingFileCases = 0
    for ($hostnameWssApiIndex = 0; $hostnameWssApiIndex -lt
        $script:DysonArtifactRequiredApiHostnameWssRuntimeFiles.Count; $hostnameWssApiIndex++) {
        $requiredHostnameWssApiRelative = `
            $script:DysonArtifactRequiredApiHostnameWssRuntimeFiles[$hostnameWssApiIndex]
        $requiredHostnameWssApi = Join-Path $artifactB $requiredHostnameWssApiRelative.Replace('/', '\')
        $requiredHostnameWssApiBackup = Join-Path $testRoot `
            ("required-hostname-wss-api-$hostnameWssApiIndex.backup")
        [System.IO.File]::Move($requiredHostnameWssApi, $requiredHostnameWssApiBackup)
        $hostnameWssApiMissingMessage = $null
        try { & $testArtifactScript -ArtifactPath $artifactB -ExpectedVersion '1.2.3-fixture' | Out-Null }
        catch { $hostnameWssApiMissingMessage = $_.Exception.Message }
        finally {
            if (Test-Path -LiteralPath $requiredHostnameWssApiBackup -PathType Leaf) {
                [System.IO.File]::Move($requiredHostnameWssApiBackup, $requiredHostnameWssApi)
            }
        }
        Assert-ReleaseSelfTest -Condition ($hostnameWssApiMissingMessage -ceq `
                'The hostname-WSS client qualification API delivery package is incomplete.') `
            -Message "a missing hostname-WSS client qualification API did not fail through its exact required-file gate: $requiredHostnameWssApiRelative"
        $hostnameWssApiMissingFileCases++
    }
    Assert-ReleaseSelfTest -Condition ($hostnameWssApiMissingFileCases -eq `
        $script:DysonArtifactRequiredApiHostnameWssRuntimeFiles.Count) `
        -Message 'not every required hostname-WSS client qualification API file was covered by a removal test'

    $observabilityRuntimeMissingFileCases = 0
    for ($observabilityIndex = 0; $observabilityIndex -lt $observabilityRuntimePaths.Count;
        $observabilityIndex++) {
        $requiredObservabilityRelative = $observabilityRuntimePaths[$observabilityIndex]
        $requiredObservabilityPath = Join-Path $artifactB $requiredObservabilityRelative.Replace('/', '\')
        $requiredObservabilityBackup = Join-Path $testRoot `
            ("required-observability-$observabilityIndex.backup")
        [System.IO.File]::Move($requiredObservabilityPath, $requiredObservabilityBackup)
        $observabilityMissingMessage = $null
        try { & $testArtifactScript -ArtifactPath $artifactB -ExpectedVersion '1.2.3-fixture' | Out-Null }
        catch { $observabilityMissingMessage = $_.Exception.Message }
        finally {
            if (Test-Path -LiteralPath $requiredObservabilityBackup -PathType Leaf) {
                [System.IO.File]::Move($requiredObservabilityBackup, $requiredObservabilityPath)
            }
        }
        Assert-ReleaseSelfTest -Condition ($observabilityMissingMessage -ceq `
                'The observability runtime API delivery package is incomplete.') `
            -Message "a missing observability runtime API did not fail through its exact required-file gate: $requiredObservabilityRelative"
        $observabilityRuntimeMissingFileCases++
    }
    Assert-ReleaseSelfTest -Condition ($observabilityRuntimeMissingFileCases -eq $observabilityRuntimePaths.Count) `
        -Message 'not every required observability runtime API file was covered by a removal test'

    $unexpectedObservabilityRelative = 'apps/api/dist/observability/unreviewed-runtime.js'
    $unexpectedObservabilityPath = Join-Path $artifactB $unexpectedObservabilityRelative.Replace('/', '\')
    Write-FixtureText -Path $unexpectedObservabilityPath -Value "export const unreviewed = true`n"
    $observabilityExtraMessage = $null
    try { & $testArtifactScript -ArtifactPath $artifactB -ExpectedVersion '1.2.3-fixture' | Out-Null }
    catch { $observabilityExtraMessage = $_.Exception.Message }
    Assert-ReleaseSelfTest -Condition ($observabilityExtraMessage -ceq `
            "The observability runtime contains a path outside its exact allowlist: $unexpectedObservabilityRelative") `
        -Message 'an extra observability runtime file did not fail through the exact allowlist gate'
    Remove-Item -LiteralPath $unexpectedObservabilityPath -Force

    $observabilityTamperPath = Join-Path $artifactB 'apps\api\dist\observability\long-window.js'
    $observabilityTamperBytes = [System.IO.File]::ReadAllBytes($observabilityTamperPath)
    try {
        [System.IO.File]::AppendAllText($observabilityTamperPath, "tampered`n", [System.Text.UTF8Encoding]::new($false))
        $observabilityTamperRejected = $false
        try { & $testArtifactScript -ArtifactPath $artifactB -ExpectedVersion '1.2.3-fixture' | Out-Null }
        catch { $observabilityTamperRejected = $true }
        Assert-ReleaseSelfTest -Condition $observabilityTamperRejected `
            -Message 'observability runtime hash tampering was not rejected'
    }
    finally { [System.IO.File]::WriteAllBytes($observabilityTamperPath, $observabilityTamperBytes) }

    $artifactBManifestPath = Join-Path $artifactB 'artifact-manifest.json'
    $artifactBManifestBytes = [System.IO.File]::ReadAllBytes($artifactBManifestPath)
    $observabilityCanonicalPath = Join-Path $artifactB `
        'apps\api\dist\observability\long-window.js'
    $observabilityCaseTemporaryPath = Join-Path $artifactB `
        'apps\api\dist\observability\long-window.case-temporary'
    $observabilityWrongCasePath = Join-Path $artifactB `
        'apps\api\dist\observability\Long-Window.js'
    [System.IO.File]::Move($observabilityCanonicalPath, $observabilityCaseTemporaryPath)
    [System.IO.File]::Move($observabilityCaseTemporaryPath, $observabilityWrongCasePath)
    $observabilityCaseRemanifestMessage = $null
    try {
        [void](Write-DysonArtifactManifest -ArtifactRoot $artifactB -Version '1.2.3-fixture' `
            -DevDependenciesExcluded @())
    }
    catch { $observabilityCaseRemanifestMessage = $_.Exception.Message }
    finally {
        if (Test-Path -LiteralPath $observabilityWrongCasePath -PathType Leaf) {
            [System.IO.File]::Move($observabilityWrongCasePath, $observabilityCaseTemporaryPath)
            [System.IO.File]::Move($observabilityCaseTemporaryPath, $observabilityCanonicalPath)
        }
        [System.IO.File]::WriteAllBytes($artifactBManifestPath, $artifactBManifestBytes)
    }
    Assert-ReleaseSelfTest -Condition ($observabilityCaseRemanifestMessage -ceq `
            'The observability runtime contains a path outside its exact allowlist: apps/api/dist/observability/Long-Window.js') `
        -Message 'a case-drifted observability runtime could be re-manifested'

    $manifestWithSeparatorDrift = [System.IO.File]::ReadAllText(
        $artifactBManifestPath,
        [System.Text.Encoding]::UTF8
    ) | ConvertFrom-Json
    $separatorDriftEntry = @($manifestWithSeparatorDrift.files | Where-Object {
        [string]$_.path -ceq 'apps/api/dist/observability/long-window.js'
    })[0]
    $separatorDriftEntry.path = ([string]$separatorDriftEntry.path).Replace('/', '\')
    [System.IO.File]::WriteAllText(
        $artifactBManifestPath,
        ($manifestWithSeparatorDrift | ConvertTo-Json -Depth 12 -Compress),
        [System.Text.UTF8Encoding]::new($false)
    )
    $manifestSeparatorDriftMessage = $null
    try { & $testArtifactScript -ArtifactPath $artifactB -ExpectedVersion '1.2.3-fixture' | Out-Null }
    catch { $manifestSeparatorDriftMessage = $_.Exception.Message }
    finally { [System.IO.File]::WriteAllBytes($artifactBManifestPath, $artifactBManifestBytes) }
    Assert-ReleaseSelfTest -Condition ($manifestSeparatorDriftMessage -ceq `
            'The artifact file inventory is inconsistent.') `
        -Message 'a manifest entry using non-canonical path separators was accepted'

    $updateRuntimeMissingCases = 0
    for ($updateRuntimeIndex = 0; $updateRuntimeIndex -lt
        $script:DysonArtifactRequiredApiUpdateCoreRuntimeFiles.Count; $updateRuntimeIndex++) {
        $requiredUpdateRuntimeRelative = `
            $script:DysonArtifactRequiredApiUpdateCoreRuntimeFiles[$updateRuntimeIndex]
        $requiredUpdateRuntimeApi = Join-Path $artifactB `
            $requiredUpdateRuntimeRelative.Replace('/', '\')
        $requiredUpdateRuntimeBackup = Join-Path $testRoot `
            ("required-update-runtime-$updateRuntimeIndex.backup")
        [System.IO.File]::Move($requiredUpdateRuntimeApi, $requiredUpdateRuntimeBackup)
        $updateRuntimeMissingMessage = $null
        try { & $testArtifactScript -ArtifactPath $artifactB -ExpectedVersion '1.2.3-fixture' | Out-Null }
        catch { $updateRuntimeMissingMessage = $_.Exception.Message }
        finally {
            if (Test-Path -LiteralPath $requiredUpdateRuntimeBackup -PathType Leaf) {
                [System.IO.File]::Move($requiredUpdateRuntimeBackup, $requiredUpdateRuntimeApi)
            }
        }
        Assert-ReleaseSelfTest -Condition ($updateRuntimeMissingMessage -ceq `
                'The Windows update runtime API delivery package is incomplete.') `
            -Message "a missing Windows update runtime API did not fail through its exact required-file gate: $requiredUpdateRuntimeRelative"
        $updateRuntimeMissingCases++
    }
    Assert-ReleaseSelfTest -Condition ($updateRuntimeMissingCases -eq `
        $script:DysonArtifactRequiredApiUpdateCoreRuntimeFiles.Count) `
        -Message 'not every required Windows update runtime API file was covered by a removal test'

    $nebulaApiMissingFileCases = 0
    for ($nebulaApiIndex = 0; $nebulaApiIndex -lt
        $script:DysonArtifactRequiredApiNebulaPluginTransactionFiles.Count; $nebulaApiIndex++) {
        $requiredNebulaApiRelative = `
            $script:DysonArtifactRequiredApiNebulaPluginTransactionFiles[$nebulaApiIndex]
        $requiredNebulaApi = Join-Path $artifactB $requiredNebulaApiRelative.Replace('/', '\')
        $requiredNebulaApiBackup = Join-Path $testRoot `
            ("required-nebula-api-$nebulaApiIndex.backup")
        [System.IO.File]::Move($requiredNebulaApi, $requiredNebulaApiBackup)
        $nebulaApiMissingMessage = $null
        try { & $testArtifactScript -ArtifactPath $artifactB -ExpectedVersion '1.2.3-fixture' | Out-Null }
        catch { $nebulaApiMissingMessage = $_.Exception.Message }
        finally {
            if (Test-Path -LiteralPath $requiredNebulaApiBackup -PathType Leaf) {
                [System.IO.File]::Move($requiredNebulaApiBackup, $requiredNebulaApi)
            }
        }
        Assert-ReleaseSelfTest -Condition ($nebulaApiMissingMessage -ceq `
                'The Nebula V3 whole-plugin-tree API delivery package is incomplete.') `
            -Message "a missing Nebula V3 runtime API did not fail through its exact required-file gate: $requiredNebulaApiRelative"
        $nebulaApiMissingFileCases++
    }
    Assert-ReleaseSelfTest -Condition ($nebulaApiMissingFileCases -eq `
        $script:DysonArtifactRequiredApiNebulaPluginTransactionFiles.Count) `
        -Message 'not every required Nebula V3 runtime API file was covered by a removal test'

    $requiredEvidenceScript = Join-Path $artifactB 'scripts\windows\evidence\Test-DysonPrivateEvidenceBundle.ps1'
    $requiredEvidenceScriptBackup = Join-Path $testRoot 'required-evidence-script.backup'
    [System.IO.File]::Move($requiredEvidenceScript, $requiredEvidenceScriptBackup)
    $evidenceMissingRejected = $false
    try { & $testArtifactScript -ArtifactPath $artifactB -ExpectedVersion '1.2.3-fixture' | Out-Null }
    catch { $evidenceMissingRejected = $true }
    Assert-ReleaseSelfTest -Condition $evidenceMissingRejected -Message 'an artifact missing a required private evidence script was accepted'
    [System.IO.File]::Move($requiredEvidenceScriptBackup, $requiredEvidenceScript)

    Write-FixtureText -Path (Join-Path $artifactB 'scripts\windows\evidence\Unexpected-Evidence.ps1') -Value "throw 'unexpected evidence tool'`n"
    $evidenceExtraRejected = $false
    try { & $testArtifactScript -ArtifactPath $artifactB -ExpectedVersion '1.2.3-fixture' | Out-Null }
    catch { $evidenceExtraRejected = $true }
    Assert-ReleaseSelfTest -Condition $evidenceExtraRejected -Message 'an extra private acceptance evidence script was accepted'
    Remove-Item -LiteralPath (Join-Path $artifactB 'scripts\windows\evidence\Unexpected-Evidence.ps1') -Force

    $hostMutationMissingFileCases = 0
    for ($hostMutationIndex = 0; $hostMutationIndex -lt $hostMutationScriptPaths.Count; $hostMutationIndex++) {
        $requiredHostMutationPath = Join-Path $artifactB $hostMutationScriptPaths[$hostMutationIndex].Replace('/', '\')
        $requiredHostMutationBackup = Join-Path $testRoot ("required-host-mutation-$hostMutationIndex.backup")
        [System.IO.File]::Move($requiredHostMutationPath, $requiredHostMutationBackup)
        $hostMutationMissingMessage = $null
        try {
            & $testArtifactScript -ArtifactPath $artifactB -ExpectedVersion '1.2.3-fixture' | Out-Null
        }
        catch {
            $hostMutationMissingMessage = $_.Exception.Message
        }
        finally {
            if (Test-Path -LiteralPath $requiredHostMutationBackup -PathType Leaf) {
                [System.IO.File]::Move($requiredHostMutationBackup, $requiredHostMutationPath)
            }
        }
        Assert-ReleaseSelfTest -Condition ($hostMutationMissingMessage -eq 'The host-mutation lease delivery package is incomplete.') `
            -Message "removing required host-mutation lease script index $hostMutationIndex did not fail through the exact required-file gate"
        $hostMutationMissingFileCases++
    }
    Assert-ReleaseSelfTest -Condition ($hostMutationMissingFileCases -eq $hostMutationScriptPaths.Count) `
        -Message 'not every required host-mutation lease script was covered by a removal test'

    $unexpectedHostMutationPath = Join-Path $artifactB 'scripts\windows\Unexpected-DysonHostMutationLease.ps1'
    Write-FixtureText -Path $unexpectedHostMutationPath -Value "throw 'unexpected host-mutation lease tool'`n"
    $hostMutationExtraRejected = $false
    try { & $testArtifactScript -ArtifactPath $artifactB -ExpectedVersion '1.2.3-fixture' | Out-Null }
    catch { $hostMutationExtraRejected = $true }
    Assert-ReleaseSelfTest -Condition $hostMutationExtraRejected `
        -Message 'an extra host-mutation lease script outside the exact allowlist was accepted'
    Remove-Item -LiteralPath $unexpectedHostMutationPath -Force

    $nebulaRuntimeMissingFileCases = 0
    for ($nebulaRuntimeIndex = 0; $nebulaRuntimeIndex -lt
        $nebulaPluginTransactionPaths.Count; $nebulaRuntimeIndex++) {
        $requiredNebulaRuntimeRelative = $nebulaPluginTransactionPaths[$nebulaRuntimeIndex]
        $requiredNebulaRuntime = Join-Path $artifactB `
            $requiredNebulaRuntimeRelative.Replace('/', '\')
        $requiredNebulaRuntimeBackup = Join-Path $testRoot `
            ("required-nebula-runtime-$nebulaRuntimeIndex.backup")
        [System.IO.File]::Move($requiredNebulaRuntime, $requiredNebulaRuntimeBackup)
        $nebulaRuntimeMissingMessage = $null
        try { & $testArtifactScript -ArtifactPath $artifactB -ExpectedVersion '1.2.3-fixture' | Out-Null }
        catch { $nebulaRuntimeMissingMessage = $_.Exception.Message }
        finally {
            if (Test-Path -LiteralPath $requiredNebulaRuntimeBackup -PathType Leaf) {
                [System.IO.File]::Move($requiredNebulaRuntimeBackup, $requiredNebulaRuntime)
            }
        }
        Assert-ReleaseSelfTest -Condition ($nebulaRuntimeMissingMessage -ceq `
                'The Nebula V3 whole-plugin-tree runtime delivery package is incomplete.') `
            -Message "removing required Nebula runtime file index $nebulaRuntimeIndex did not fail through the exact required-file gate"
        $nebulaRuntimeMissingFileCases++
    }
    Assert-ReleaseSelfTest -Condition ($nebulaRuntimeMissingFileCases -eq `
        $nebulaPluginTransactionPaths.Count) `
        -Message 'not every required Nebula V3 whole-plugin-tree runtime file was covered by a removal test'

    $unexpectedNebulaRuntimeRelative = `
        'scripts/windows/nebula-private-build/README.runtime-extra.md'
    $unexpectedNebulaRuntimePath = Join-Path $artifactB `
        $unexpectedNebulaRuntimeRelative.Replace('/', '\')
    Write-FixtureText -Path $unexpectedNebulaRuntimePath `
        -Value "Fictional unreviewed Nebula runtime documentation.`n"
    $nebulaRuntimeExtraMessage = $null
    try { & $testArtifactScript -ArtifactPath $artifactB -ExpectedVersion '1.2.3-fixture' | Out-Null }
    catch { $nebulaRuntimeExtraMessage = $_.Exception.Message }
    Assert-ReleaseSelfTest -Condition ($nebulaRuntimeExtraMessage -ceq `
            "The Nebula V3 whole-plugin-tree runtime contains a path outside its exact allowlist: $unexpectedNebulaRuntimeRelative") `
        -Message 'an extra Nebula private-build source file did not fail through the exact subtree allowlist'
    Remove-Item -LiteralPath $unexpectedNebulaRuntimePath -Force

    $privateNebulaBinaryRelative = `
        'scripts/windows/nebula-private-build/private-candidate.dll'
    $privateNebulaBinaryPath = Join-Path $artifactB $privateNebulaBinaryRelative.Replace('/', '\')
    Write-FixtureText -Path $privateNebulaBinaryPath -Value 'fictional private binary sentinel'
    $privateNebulaBinaryMessage = $null
    try { & $testArtifactScript -ArtifactPath $artifactB -ExpectedVersion '1.2.3-fixture' | Out-Null }
    catch { $privateNebulaBinaryMessage = $_.Exception.Message }
    Assert-ReleaseSelfTest -Condition ($privateNebulaBinaryMessage -ceq `
            "The Nebula V3 whole-plugin-tree runtime contains a path outside its exact allowlist: $privateNebulaBinaryRelative") `
        -Message 'a private Nebula candidate binary was accepted by the public artifact verifier'
    Remove-Item -LiteralPath $privateNebulaBinaryPath -Force

    $nebulaRuntimeTamperPath = Join-Path $artifactB `
        'scripts\windows\nebula-private-build\NebulaPluginTransaction.Common.ps1'
    $nebulaRuntimeTamperBytes = [System.IO.File]::ReadAllBytes($nebulaRuntimeTamperPath)
    try {
        [System.IO.File]::AppendAllText($nebulaRuntimeTamperPath,
            "# fictional Nebula runtime tamper`n", [System.Text.UTF8Encoding]::new($false))
        $nebulaRuntimeTamperRejected = $false
        try { & $testArtifactScript -ArtifactPath $artifactB -ExpectedVersion '1.2.3-fixture' | Out-Null }
        catch { $nebulaRuntimeTamperRejected = $true }
        Assert-ReleaseSelfTest -Condition $nebulaRuntimeTamperRejected `
            -Message 'Nebula V3 transaction common-file hash tampering was not rejected'
    }
    finally { [System.IO.File]::WriteAllBytes($nebulaRuntimeTamperPath, $nebulaRuntimeTamperBytes) }

    $cutoverMissingFileCases = 0
    for ($cutoverIndex = 0; $cutoverIndex -lt $cutoverScriptPaths.Count; $cutoverIndex++) {
        $requiredCutoverPath = Join-Path $artifactB $cutoverScriptPaths[$cutoverIndex].Replace('/', '\')
        $requiredCutoverBackup = Join-Path $testRoot ("required-cutover-$cutoverIndex.backup")
        [System.IO.File]::Move($requiredCutoverPath, $requiredCutoverBackup)
        $cutoverMissingMessage = $null
        try {
            & $testArtifactScript -ArtifactPath $artifactB -ExpectedVersion '1.2.3-fixture' | Out-Null
        }
        catch {
            $cutoverMissingMessage = $_.Exception.Message
        }
        finally {
            if (Test-Path -LiteralPath $requiredCutoverBackup -PathType Leaf) {
                [System.IO.File]::Move($requiredCutoverBackup, $requiredCutoverPath)
            }
        }
        Assert-ReleaseSelfTest -Condition ($cutoverMissingMessage -eq 'The cutover host delivery package is incomplete.') `
            -Message "removing required cutover host script index $cutoverIndex did not fail through the exact required-file gate"
        $cutoverMissingFileCases++
    }
    Assert-ReleaseSelfTest -Condition ($cutoverMissingFileCases -eq $cutoverScriptPaths.Count) `
        -Message 'not every required cutover host script was covered by a removal test'

    $unexpectedCutoverPath = Join-Path $artifactB 'scripts\windows\cutover\Unexpected-Cutover.ps1'
    Write-FixtureText -Path $unexpectedCutoverPath -Value "throw 'unexpected cutover host tool'`n"
    $cutoverExtraRejected = $false
    try { & $testArtifactScript -ArtifactPath $artifactB -ExpectedVersion '1.2.3-fixture' | Out-Null }
    catch { $cutoverExtraRejected = $true }
    Assert-ReleaseSelfTest -Condition $cutoverExtraRejected `
        -Message 'an extra cutover host script outside the exact allowlist was accepted'
    Remove-Item -LiteralPath $unexpectedCutoverPath -Force

    $cutoverBrokerMissingFileCases = 0
    for ($brokerIndex = 0; $brokerIndex -lt $cutoverBrokerScriptPaths.Count; $brokerIndex++) {
        $requiredBrokerPath = Join-Path $artifactB $cutoverBrokerScriptPaths[$brokerIndex].Replace('/', '\')
        $requiredBrokerBackup = Join-Path $testRoot ("required-cutover-broker-$brokerIndex.backup")
        [System.IO.File]::Move($requiredBrokerPath, $requiredBrokerBackup)
        $brokerMissingMessage = $null
        try {
            & $testArtifactScript -ArtifactPath $artifactB -ExpectedVersion '1.2.3-fixture' | Out-Null
        }
        catch {
            $brokerMissingMessage = $_.Exception.Message
        }
        finally {
            if (Test-Path -LiteralPath $requiredBrokerBackup -PathType Leaf) {
                [System.IO.File]::Move($requiredBrokerBackup, $requiredBrokerPath)
            }
        }
        Assert-ReleaseSelfTest -Condition ($brokerMissingMessage -eq 'The cutover broker delivery package is incomplete.') `
            -Message "removing required cutover broker script index $brokerIndex did not fail through the exact required-file gate"
        $cutoverBrokerMissingFileCases++
    }
    Assert-ReleaseSelfTest -Condition ($cutoverBrokerMissingFileCases -eq $cutoverBrokerScriptPaths.Count) `
        -Message 'not every required cutover broker script was covered by a removal test'

    $unexpectedBrokerPath = Join-Path $artifactB 'scripts\windows\cutover-broker\Unexpected-CutoverBroker.ps1'
    Write-FixtureText -Path $unexpectedBrokerPath -Value "throw 'unexpected cutover broker tool'`n"
    $cutoverBrokerExtraRejected = $false
    try { & $testArtifactScript -ArtifactPath $artifactB -ExpectedVersion '1.2.3-fixture' | Out-Null }
    catch { $cutoverBrokerExtraRejected = $true }
    Assert-ReleaseSelfTest -Condition $cutoverBrokerExtraRejected `
        -Message 'an extra cutover broker script outside the exact allowlist was accepted'
    Remove-Item -LiteralPath $unexpectedBrokerPath -Force

    $lifecycleBrokerMissingFileCases = 0
    for ($brokerIndex = 0; $brokerIndex -lt $lifecycleBrokerScriptPaths.Count; $brokerIndex++) {
        $requiredBrokerPath = Join-Path $artifactB $lifecycleBrokerScriptPaths[$brokerIndex].Replace('/', '\')
        $requiredBrokerBackup = Join-Path $testRoot ("required-lifecycle-broker-$brokerIndex.backup")
        [System.IO.File]::Move($requiredBrokerPath, $requiredBrokerBackup)
        $brokerMissingMessage = $null
        try {
            & $testArtifactScript -ArtifactPath $artifactB -ExpectedVersion '1.2.3-fixture' | Out-Null
        }
        catch {
            $brokerMissingMessage = $_.Exception.Message
        }
        finally {
            if (Test-Path -LiteralPath $requiredBrokerBackup -PathType Leaf) {
                [System.IO.File]::Move($requiredBrokerBackup, $requiredBrokerPath)
            }
        }
        Assert-ReleaseSelfTest -Condition ($brokerMissingMessage -eq 'The lifecycle broker delivery package is incomplete.') `
            -Message "removing required lifecycle broker script index $brokerIndex did not fail through the exact required-file gate"
        $lifecycleBrokerMissingFileCases++
    }
    Assert-ReleaseSelfTest -Condition ($lifecycleBrokerMissingFileCases -eq $lifecycleBrokerScriptPaths.Count) `
        -Message 'not every required lifecycle broker script was covered by a removal test'

    $unexpectedLifecycleBrokerPath = Join-Path $artifactB `
        'scripts\windows\lifecycle-broker\Unexpected-LifecycleBroker.ps1'
    Write-FixtureText -Path $unexpectedLifecycleBrokerPath -Value "throw 'unexpected lifecycle broker tool'`n"
    $lifecycleBrokerExtraRejected = $false
    try { & $testArtifactScript -ArtifactPath $artifactB -ExpectedVersion '1.2.3-fixture' | Out-Null }
    catch { $lifecycleBrokerExtraRejected = $true }
    Assert-ReleaseSelfTest -Condition $lifecycleBrokerExtraRejected `
        -Message 'an extra lifecycle broker script outside the exact allowlist was accepted'
    Remove-Item -LiteralPath $unexpectedLifecycleBrokerPath -Force

    $lifecycleBrokerTamperPath = Join-Path $artifactB `
        'scripts\windows\lifecycle-broker\DysonLifecycleBroker.Common.ps1'
    $lifecycleBrokerOriginalBytes = [System.IO.File]::ReadAllBytes($lifecycleBrokerTamperPath)
    $lifecycleBrokerTamperRejected = $false
    try {
        [System.IO.File]::AppendAllText(
            $lifecycleBrokerTamperPath,
            "# lifecycle broker tamper fixture`n",
            [System.Text.UTF8Encoding]::new($false)
        )
        try { & $testArtifactScript -ArtifactPath $artifactB -ExpectedVersion '1.2.3-fixture' | Out-Null }
        catch { $lifecycleBrokerTamperRejected = $true }
    }
    finally {
        [System.IO.File]::WriteAllBytes($lifecycleBrokerTamperPath, $lifecycleBrokerOriginalBytes)
    }
    Assert-ReleaseSelfTest -Condition $lifecycleBrokerTamperRejected `
        -Message 'lifecycle broker hash tampering was not detected'

    $unexpectedQualificationPath = Join-Path $artifactB `
        'scripts\windows\qualification\Unexpected-Qualification.ps1'
    Write-FixtureText -Path $unexpectedQualificationPath `
        -Value "throw 'unexpected repository-only qualification tool'`n"
    $qualificationRuntimeMessage = $null
    try { & $testArtifactScript -ArtifactPath $artifactB -ExpectedVersion '1.2.3-fixture' | Out-Null }
    catch { $qualificationRuntimeMessage = $_.Exception.Message }
    Assert-ReleaseSelfTest -Condition ($qualificationRuntimeMessage -eq `
            'The repository-only production qualification harness cannot enter a runtime artifact: scripts/windows/qualification/Unexpected-Qualification.ps1') `
        -Message 'the runtime artifact verifier accepted repository-only production qualification tooling'
    Remove-Item -LiteralPath $unexpectedQualificationPath -Force

    foreach ($repositoryOnlySuffix in @('fixture', 'fixtures')) {
        $unexpectedRepositoryOnlyRelative = `
            "apps/api/dist/defensive/injected.$repositoryOnlySuffix.js"
        $unexpectedRepositoryOnlyPath = Join-Path $artifactB `
            $unexpectedRepositoryOnlyRelative.Replace('/', '\')
        Write-FixtureText -Path $unexpectedRepositoryOnlyPath `
            -Value "throw new Error('unexpected repository-only API fixture')`n"
        $repositoryOnlyRuntimeMessage = $null
        try { & $testArtifactScript -ArtifactPath $artifactB -ExpectedVersion '1.2.3-fixture' | Out-Null }
        catch { $repositoryOnlyRuntimeMessage = $_.Exception.Message }
        finally {
            if (Test-Path -LiteralPath $unexpectedRepositoryOnlyPath -PathType Leaf) {
                Remove-Item -LiteralPath $unexpectedRepositoryOnlyPath -Force
            }
        }
        Assert-ReleaseSelfTest -Condition ($repositoryOnlyRuntimeMessage -ceq `
                "A repository-only path entered the runtime artifact: $unexpectedRepositoryOnlyRelative") `
            -Message "the runtime artifact verifier accepted a generic .$repositoryOnlySuffix.js helper"
    }

    $dataRecoveryRequiredPaths = @($dataRecoveryScriptPaths + $recoveryDocs)
    $dataRecoveryMissingFileCases = 0
    for ($recoveryIndex = 0; $recoveryIndex -lt $dataRecoveryRequiredPaths.Count; $recoveryIndex++) {
        $requiredRecoveryPath = Join-Path $artifactB $dataRecoveryRequiredPaths[$recoveryIndex].Replace('/', '\')
        $requiredRecoveryBackup = Join-Path $testRoot ("required-data-recovery-$recoveryIndex.backup")
        [System.IO.File]::Move($requiredRecoveryPath, $requiredRecoveryBackup)
        $recoveryMissingMessage = $null
        try {
            & $testArtifactScript -ArtifactPath $artifactB -ExpectedVersion '1.2.3-fixture' | Out-Null
        }
        catch { $recoveryMissingMessage = $_.Exception.Message }
        finally {
            if (Test-Path -LiteralPath $requiredRecoveryBackup -PathType Leaf) {
                [System.IO.File]::Move($requiredRecoveryBackup, $requiredRecoveryPath)
            }
        }
        Assert-ReleaseSelfTest -Condition ($recoveryMissingMessage -eq 'The DataRoot recovery delivery package is incomplete.') `
            -Message "removing required DataRoot recovery file index $recoveryIndex did not fail through the exact required-file gate"
        $dataRecoveryMissingFileCases++
    }
    Assert-ReleaseSelfTest -Condition ($dataRecoveryMissingFileCases -eq $dataRecoveryRequiredPaths.Count) `
        -Message 'not every required DataRoot recovery file was covered by a removal test'

    $unexpectedDataRecoveryPath = Join-Path $artifactB `
        'scripts\windows\data-recovery\Unexpected-DataRecovery.ps1'
    Write-FixtureText -Path $unexpectedDataRecoveryPath -Value "throw 'unexpected DataRoot recovery tool'`n"
    $dataRecoveryExtraRejected = $false
    try { & $testArtifactScript -ArtifactPath $artifactB -ExpectedVersion '1.2.3-fixture' | Out-Null }
    catch { $dataRecoveryExtraRejected = $true }
    Assert-ReleaseSelfTest -Condition $dataRecoveryExtraRejected `
        -Message 'an extra DataRoot recovery script outside the exact allowlist was accepted'
    Remove-Item -LiteralPath $unexpectedDataRecoveryPath -Force

    $networkRequiredPaths = @($networkFilePaths + $networkDocs)
    $networkMissingFileCases = 0
    for ($networkIndex = 0; $networkIndex -lt $networkRequiredPaths.Count; $networkIndex++) {
        $requiredNetworkPath = Join-Path $artifactB $networkRequiredPaths[$networkIndex].Replace('/', '\')
        $requiredNetworkBackup = Join-Path $testRoot ("required-network-$networkIndex.backup")
        [System.IO.File]::Move($requiredNetworkPath, $requiredNetworkBackup)
        $networkMissingMessage = $null
        try {
            & $testArtifactScript -ArtifactPath $artifactB -ExpectedVersion '1.2.3-fixture' | Out-Null
        }
        catch { $networkMissingMessage = $_.Exception.Message }
        finally {
            if (Test-Path -LiteralPath $requiredNetworkBackup -PathType Leaf) {
                [System.IO.File]::Move($requiredNetworkBackup, $requiredNetworkPath)
            }
        }
        Assert-ReleaseSelfTest -Condition ($networkMissingMessage -eq `
                'The Nebula network assessment delivery package is incomplete.') `
            -Message "removing required network assessment file index $networkIndex did not fail through the exact required-file gate"
        $networkMissingFileCases++
    }
    Assert-ReleaseSelfTest -Condition ($networkMissingFileCases -eq $networkRequiredPaths.Count) `
        -Message 'not every required Nebula network assessment file was covered by a removal test'

    $hostnameWssRuntimeRequiredPaths = @($hostnameWssQualificationPaths + $hostnameWssSourcePaths)
    $hostnameWssRuntimeMissingFileCases = 0
    for ($hostnameWssIndex = 0; $hostnameWssIndex -lt $hostnameWssRuntimeRequiredPaths.Count;
        $hostnameWssIndex++) {
        $requiredHostnameWssRelative = $hostnameWssRuntimeRequiredPaths[$hostnameWssIndex]
        $requiredHostnameWssPath = Join-Path $artifactB $requiredHostnameWssRelative.Replace('/', '\')
        $requiredHostnameWssBackup = Join-Path $testRoot `
            ("required-hostname-wss-$hostnameWssIndex.backup")
        [System.IO.File]::Move($requiredHostnameWssPath, $requiredHostnameWssBackup)
        $hostnameWssMissingMessage = $null
        try {
            & $testArtifactScript -ArtifactPath $artifactB -ExpectedVersion '1.2.3-fixture' | Out-Null
        }
        catch { $hostnameWssMissingMessage = $_.Exception.Message }
        finally {
            if (Test-Path -LiteralPath $requiredHostnameWssBackup -PathType Leaf) {
                [System.IO.File]::Move($requiredHostnameWssBackup, $requiredHostnameWssPath)
            }
        }
        Assert-ReleaseSelfTest -Condition ($hostnameWssMissingMessage -ceq `
                'The qualification runtime or hostname-WSS source-contract delivery package is incomplete.') `
            -Message "removing required hostname-WSS file index $hostnameWssIndex did not fail through the exact required-file gate"
        $hostnameWssRuntimeMissingFileCases++
    }
    Assert-ReleaseSelfTest -Condition ($hostnameWssRuntimeMissingFileCases -eq `
        $hostnameWssRuntimeRequiredPaths.Count) `
        -Message 'not every required hostname-WSS source/protocol file was covered by a removal test'

    $qualificationOrchestrationMissingFileCases = 0
    for ($qualificationIndex = 0; $qualificationIndex -lt $qualificationOrchestrationV2Paths.Count;
        $qualificationIndex++) {
        $requiredQualificationRelative = $qualificationOrchestrationV2Paths[$qualificationIndex]
        $requiredQualificationPath = Join-Path $artifactB $requiredQualificationRelative.Replace('/', '\')
        $requiredQualificationBackup = Join-Path $testRoot `
            ("required-qualification-orchestration-$qualificationIndex.backup")
        [System.IO.File]::Move($requiredQualificationPath, $requiredQualificationBackup)
        $qualificationMissingMessage = $null
        try { & $testArtifactScript -ArtifactPath $artifactB -ExpectedVersion '1.2.3-fixture' | Out-Null }
        catch { $qualificationMissingMessage = $_.Exception.Message }
        finally {
            if (Test-Path -LiteralPath $requiredQualificationBackup -PathType Leaf) {
                [System.IO.File]::Move($requiredQualificationBackup, $requiredQualificationPath)
            }
        }
        Assert-ReleaseSelfTest -Condition ($qualificationMissingMessage -ceq `
                'The qualification runtime or hostname-WSS source-contract delivery package is incomplete.') `
            -Message "a missing qualification orchestration V2 file did not fail through its exact required-file gate: $requiredQualificationRelative"
        $qualificationOrchestrationMissingFileCases++
    }
    Assert-ReleaseSelfTest -Condition ($qualificationOrchestrationMissingFileCases -eq `
        $qualificationOrchestrationV2Paths.Count) `
        -Message 'not every required qualification orchestration V2 file was covered by a removal test'

    $qualificationFrameworkMissingFileCases = 0
    foreach ($requiredQualificationFrameworkRelative in $qualificationFrameworkPaths) {
        $requiredQualificationFrameworkPath = Join-Path $artifactB `
            $requiredQualificationFrameworkRelative.Replace('/', '\')
        $requiredQualificationFrameworkBackup = Join-Path $testRoot `
            ("required-qualification-framework-$qualificationFrameworkMissingFileCases.backup")
        [System.IO.File]::Move($requiredQualificationFrameworkPath, $requiredQualificationFrameworkBackup)
        $qualificationFrameworkMissingMessage = $null
        try { & $testArtifactScript -ArtifactPath $artifactB -ExpectedVersion '1.2.3-fixture' | Out-Null }
        catch { $qualificationFrameworkMissingMessage = $_.Exception.Message }
        finally {
            if (Test-Path -LiteralPath $requiredQualificationFrameworkBackup -PathType Leaf) {
                [System.IO.File]::Move($requiredQualificationFrameworkBackup, $requiredQualificationFrameworkPath)
            }
        }
        Assert-ReleaseSelfTest -Condition ($qualificationFrameworkMissingMessage -ceq `
                'The qualification runtime or hostname-WSS source-contract delivery package is incomplete.') `
            -Message "a qualification V1/V2 framework dependency was not required: $requiredQualificationFrameworkRelative"
        $qualificationFrameworkMissingFileCases++
    }

    foreach ($requiredStrictQualificationRelative in @(
        'scripts/windows/qualification/SelfTest-DysonSideBySideObservationV2.ps1',
        'scripts/windows/qualification/SelfTest-DysonQualificationPairedSaveLoadRecordV2.ps1',
        'scripts/windows/qualification/dyson-control-panel-observation-v2.schema.json',
        'scripts/windows/qualification/README.ExternalJoinObservationV2.md',
        'scripts/windows/qualification/Qualification.ReversibleCutover.ps1',
        'scripts/windows/qualification/dyson-post-gsmanager-removal-observation-v2.schema.json',
        'scripts/windows/qualification/SelfTest-DysonSoakObservationV2.ps1'
    )) {
        $requiredStrictQualificationPath = Join-Path $artifactB `
            $requiredStrictQualificationRelative.Replace('/', '\')
        $requiredStrictQualificationBackup = Join-Path $testRoot `
            ('required-strict-qualification-' + [guid]::NewGuid().ToString('N') + '.backup')
        [System.IO.File]::Move($requiredStrictQualificationPath, $requiredStrictQualificationBackup)
        $strictQualificationMissingMessage = $null
        try { & $testArtifactScript -ArtifactPath $artifactB -ExpectedVersion '1.2.3-fixture' | Out-Null }
        catch { $strictQualificationMissingMessage = $_.Exception.Message }
        finally {
            if (Test-Path -LiteralPath $requiredStrictQualificationBackup -PathType Leaf) {
                [System.IO.File]::Move($requiredStrictQualificationBackup, $requiredStrictQualificationPath)
            }
        }
        Assert-ReleaseSelfTest -Condition ($strictQualificationMissingMessage -ceq `
                'The qualification runtime or hostname-WSS source-contract delivery package is incomplete.') `
            -Message "a representative strict qualification V2 file was not required: $requiredStrictQualificationRelative"
    }

    $qualificationDocPath = Join-Path $artifactB $qualificationDocs[0].Replace('/', '\')
    $qualificationDocBackup = Join-Path $testRoot 'required-production-qualification-doc.backup'
    [System.IO.File]::Move($qualificationDocPath, $qualificationDocBackup)
    $qualificationDocMissingMessage = $null
    try { & $testArtifactScript -ArtifactPath $artifactB -ExpectedVersion '1.2.3-fixture' | Out-Null }
    catch { $qualificationDocMissingMessage = $_.Exception.Message }
    finally { [System.IO.File]::Move($qualificationDocBackup, $qualificationDocPath) }
    Assert-ReleaseSelfTest -Condition ($qualificationDocMissingMessage -ceq `
            'The qualification runtime or hostname-WSS source-contract delivery package is incomplete.') `
        -Message 'a release artifact missing the production qualification guide was accepted'

    $unexpectedQualificationRelative = 'scripts/windows/qualification/Unexpected-OrchestrationV2.ps1'
    $unexpectedQualificationPath = Join-Path $artifactB $unexpectedQualificationRelative.Replace('/', '\')
    Write-FixtureText -Path $unexpectedQualificationPath -Value "throw 'unexpected qualification runtime'`n"
    $qualificationExtraMessage = $null
    try { & $testArtifactScript -ArtifactPath $artifactB -ExpectedVersion '1.2.3-fixture' | Out-Null }
    catch { $qualificationExtraMessage = $_.Exception.Message }
    Assert-ReleaseSelfTest -Condition ($qualificationExtraMessage -ceq `
            "The repository-only production qualification harness cannot enter a runtime artifact: $unexpectedQualificationRelative") `
        -Message 'an extra qualification orchestration V2 file did not fail through the exact allowlist gate'
    Remove-Item -LiteralPath $unexpectedQualificationPath -Force

    $qualificationTamperPath = Join-Path $artifactB `
        'scripts\windows\qualification\fixtures\orchestration-adapter-contract.v2.json'
    $qualificationTamperBytes = [System.IO.File]::ReadAllBytes($qualificationTamperPath)
    try {
        [System.IO.File]::AppendAllText($qualificationTamperPath, "tampered`n", [System.Text.UTF8Encoding]::new($false))
        $qualificationTamperRejected = $false
        try { & $testArtifactScript -ArtifactPath $artifactB -ExpectedVersion '1.2.3-fixture' | Out-Null }
        catch { $qualificationTamperRejected = $true }
        Assert-ReleaseSelfTest -Condition $qualificationTamperRejected `
            -Message 'qualification orchestration V2 hash tampering was not rejected'
    }
    finally { [System.IO.File]::WriteAllBytes($qualificationTamperPath, $qualificationTamperBytes) }

    $qualificationCanonicalPath = Join-Path $artifactB `
        'scripts\windows\qualification\Qualification.OrchestrationV2.ps1'
    $qualificationCaseTemporaryPath = Join-Path $artifactB `
        'scripts\windows\qualification\qualification-orchestration.case-temporary'
    $qualificationWrongCasePath = Join-Path $artifactB `
        'scripts\windows\qualification\qualification.OrchestrationV2.ps1'
    [System.IO.File]::Move($qualificationCanonicalPath, $qualificationCaseTemporaryPath)
    [System.IO.File]::Move($qualificationCaseTemporaryPath, $qualificationWrongCasePath)
    $qualificationCaseRemanifestMessage = $null
    try {
        [void](Write-DysonArtifactManifest -ArtifactRoot $artifactB -Version '1.2.3-fixture' `
            -DevDependenciesExcluded @())
    }
    catch { $qualificationCaseRemanifestMessage = $_.Exception.Message }
    finally {
        if (Test-Path -LiteralPath $qualificationWrongCasePath -PathType Leaf) {
            [System.IO.File]::Move($qualificationWrongCasePath, $qualificationCaseTemporaryPath)
            [System.IO.File]::Move($qualificationCaseTemporaryPath, $qualificationCanonicalPath)
        }
        [System.IO.File]::WriteAllBytes($artifactBManifestPath, $artifactBManifestBytes)
    }
    Assert-ReleaseSelfTest -Condition ($qualificationCaseRemanifestMessage -ceq `
            'The qualification runtime contains a path outside its exact allowlist: scripts/windows/qualification/qualification.OrchestrationV2.ps1') `
        -Message 'a case-drifted qualification orchestration V2 runtime could be re-manifested'

    $unexpectedNetworkPath = Join-Path $artifactB 'scripts\windows\network\Unexpected-Network.ps1'
    Write-FixtureText -Path $unexpectedNetworkPath -Value "throw 'unexpected network assessment tool'`n"
    $networkExtraRejected = $false
    try { & $testArtifactScript -ArtifactPath $artifactB -ExpectedVersion '1.2.3-fixture' | Out-Null }
    catch { $networkExtraRejected = $true }
    Assert-ReleaseSelfTest -Condition $networkExtraRejected `
        -Message 'an extra Nebula network assessment file outside the exact allowlist was accepted'
    Remove-Item -LiteralPath $unexpectedNetworkPath -Force

    $gsManagerRemovalRequiredPaths = @($gsManagerRemovalScriptPaths + $gsManagerRemovalDocs)
    $gsManagerRemovalMissingFileCases = 0
    for ($removalIndex = 0; $removalIndex -lt $gsManagerRemovalRequiredPaths.Count; $removalIndex++) {
        $requiredRemovalPath = Join-Path $artifactB $gsManagerRemovalRequiredPaths[$removalIndex].Replace('/', '\')
        $requiredRemovalBackup = Join-Path $testRoot ("required-gsmanager-removal-$removalIndex.backup")
        [System.IO.File]::Move($requiredRemovalPath, $requiredRemovalBackup)
        $removalMissingMessage = $null
        try {
            & $testArtifactScript -ArtifactPath $artifactB -ExpectedVersion '1.2.3-fixture' | Out-Null
        }
        catch { $removalMissingMessage = $_.Exception.Message }
        finally {
            if (Test-Path -LiteralPath $requiredRemovalBackup -PathType Leaf) {
                [System.IO.File]::Move($requiredRemovalBackup, $requiredRemovalPath)
            }
        }
        Assert-ReleaseSelfTest -Condition ($removalMissingMessage -eq `
                'The GSManager recoverable-removal delivery package is incomplete.') `
            -Message "removing required GSManager recoverable-removal file index $removalIndex did not fail through the exact required-file gate"
        $gsManagerRemovalMissingFileCases++
    }
    Assert-ReleaseSelfTest -Condition ($gsManagerRemovalMissingFileCases -eq $gsManagerRemovalRequiredPaths.Count) `
        -Message 'not every required GSManager recoverable-removal file was covered by a removal test'

    $unexpectedGsManagerRemovalPath = Join-Path $artifactB `
        'scripts\windows\migration\Unexpected-GsManagerRemoval.ps1'
    Write-FixtureText -Path $unexpectedGsManagerRemovalPath -Value "throw 'unexpected GSManager removal tool'`n"
    $gsManagerRemovalExtraRejected = $false
    try { & $testArtifactScript -ArtifactPath $artifactB -ExpectedVersion '1.2.3-fixture' | Out-Null }
    catch { $gsManagerRemovalExtraRejected = $true }
    Assert-ReleaseSelfTest -Condition $gsManagerRemovalExtraRejected `
        -Message 'an extra GSManager recoverable-removal script outside the exact allowlist was accepted'
    Remove-Item -LiteralPath $unexpectedGsManagerRemovalPath -Force

    $installRoot = Join-Path $testRoot 'deployment-install'
    $dataRoot = Join-Path $testRoot 'deployment-data'
    $stage = Convert-LastJsonResult -Output (& $deploymentScript -Operation Stage -SourcePath $artifactA `
        -Version '1.2.3-fixture' -ExpectedArtifactPayloadSha256 ([string]$verifiedA.payloadSha256) `
        -InstallRoot $installRoot -DataRoot $dataRoot -Confirm:$false)
    Assert-ReleaseSelfTest -Condition ($stage.state -eq 'staged' -and
        [string]$stage.payloadSha256 -cmatch '^[0-9a-f]{64}$' -and
        [bool]$stage.artifactProvenanceBound -and -not [bool]$stage.sourceArtifactScriptsExecuted) `
        -Message 'the existing deployment transaction rejected the artifact or did not bind trusted provenance'

    $forbiddenSave = Join-Path $fixtureRoot 'apps\web\dist\fictional.server'
    Write-FixtureText -Path $forbiddenSave -Value 'fictional save metadata'
    $forbiddenRejected = $false
    try {
        & $newArtifactScript -RepositoryRoot $fixtureRoot -Version '1.2.3-fixture' `
            -OutputPath $artifactForbidden -Confirm:$false | Out-Null
    }
    catch { $forbiddenRejected = $true }
    Assert-ReleaseSelfTest -Condition $forbiddenRejected -Message 'a save-like file was accepted'
    Assert-ReleaseSelfTest -Condition (-not (Test-Path -LiteralPath $artifactForbidden)) -Message 'a rejected artifact was published'
    Remove-Item -LiteralPath $forbiddenSave -Force

    $forbiddenLog = Join-Path $fixtureRoot 'apps\web\dist\fictional.log'
    Write-FixtureText -Path $forbiddenLog -Value 'fictional log output'
    $logRejected = $false
    try {
        & $newArtifactScript -RepositoryRoot $fixtureRoot -Version '1.2.3-fixture' `
            -OutputPath $artifactLog -Confirm:$false | Out-Null
    }
    catch { $logRejected = $true }
    Assert-ReleaseSelfTest -Condition $logRejected -Message 'a log file was accepted'
    Assert-ReleaseSelfTest -Condition (-not (Test-Path -LiteralPath $artifactLog)) -Message 'a log-containing artifact was published'
    Remove-Item -LiteralPath $forbiddenLog -Force

    $forbiddenSecret = Join-Path $fixtureRoot 'apps\web\dist\fictional-secret.js'
    Write-FixtureText -Path $forbiddenSecret -Value "DYSON_SESSION_SECRET=fictional-not-a-real-secret`n"
    $sourceSecretRejected = $false
    try {
        & $newArtifactScript -RepositoryRoot $fixtureRoot -Version '1.2.3-fixture' `
            -OutputPath $artifactSecret -Confirm:$false | Out-Null
    }
    catch { $sourceSecretRejected = $true }
    Assert-ReleaseSelfTest -Condition $sourceSecretRejected -Message 'secret-like source content was accepted'
    Assert-ReleaseSelfTest -Condition (-not (Test-Path -LiteralPath $artifactSecret)) -Message 'a secret-containing artifact was published'
    Remove-Item -LiteralPath $forbiddenSecret -Force

    $junctionTarget = Join-Path $testRoot 'junction-target'
    [System.IO.Directory]::CreateDirectory($junctionTarget) | Out-Null
    $junctionPath = Join-Path $fixtureRoot 'apps\web\dist\redirected-assets'
    [void](New-Item -ItemType Junction -Path $junctionPath -Target $junctionTarget -ErrorAction Stop)
    $redirectRejected = $false
    try {
        & $newArtifactScript -RepositoryRoot $fixtureRoot -Version '1.2.3-fixture' `
            -OutputPath $artifactRedirected -Confirm:$false | Out-Null
    }
    catch { $redirectRejected = $true }
    Assert-ReleaseSelfTest -Condition $redirectRejected -Message 'a reparse-point source tree was accepted'
    Assert-ReleaseSelfTest -Condition (-not (Test-Path -LiteralPath $artifactRedirected)) -Message 'a redirected artifact was published'
    Remove-Item -LiteralPath $junctionPath -Force
    $junctionPath = $null

    [System.IO.File]::AppendAllText((Join-Path $artifactA 'apps\api\dist\app.js'), "tampered`n", [System.Text.UTF8Encoding]::new($false))
    $tamperRejected = $false
    try { & $testArtifactScript -ArtifactPath $artifactA -ExpectedVersion '1.2.3-fixture' | Out-Null }
    catch { $tamperRejected = $true }
    Assert-ReleaseSelfTest -Condition $tamperRejected -Message 'artifact tampering was not detected'

    Write-FixtureText -Path (Join-Path $artifactB 'apps\api\dist\.env') -Value "DYSON_SESSION_SECRET=fictional`n"
    $secretRejected = $false
    try { & $testArtifactScript -ArtifactPath $artifactB -ExpectedVersion '1.2.3-fixture' | Out-Null }
    catch { $secretRejected = $true }
    Assert-ReleaseSelfTest -Condition $secretRejected -Message 'an injected .env file was not rejected'

    $currentWorkspaceValidated = $false
    if ($IncludeCurrentWorkspace) {
        $currentRepository = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..\..'))
        $currentPackage = Read-DysonArtifactBoundedJsonFile `
            -Path (Join-Path $currentRepository 'apps\api\package.json') -Name 'apps/api/package.json'
        $currentVersion = [string]$currentPackage.version
        $currentArtifact = Join-Path $testRoot 'current-workspace-artifact'
        $currentArtifactRepeat = Join-Path $testRoot 'current-workspace-artifact-repeat'
        $currentCreated = Convert-LastJsonResult -Output (& $newArtifactScript -RepositoryRoot $currentRepository `
            -Version $currentVersion -OutputPath $currentArtifact -Confirm:$false)
        $currentRepeated = Convert-LastJsonResult -Output (& $newArtifactScript -RepositoryRoot $currentRepository `
            -Version $currentVersion -OutputPath $currentArtifactRepeat -Confirm:$false)
        $currentVerified = Convert-LastJsonResult -Output (& $testArtifactScript -ArtifactPath $currentArtifact `
            -ExpectedVersion $currentVersion)
        $currentRepeatedVerified = Convert-LastJsonResult -Output (& $testArtifactScript -ArtifactPath $currentArtifactRepeat `
            -ExpectedVersion $currentVersion)
        Assert-ReleaseSelfTest -Condition ($currentCreated.state -eq 'created' -and $currentRepeated.state -eq 'created' -and
            [bool]$currentVerified.ready -and [bool]$currentRepeatedVerified.ready) `
            -Message 'the current built workspace could not produce a valid release artifact'
        Assert-ReleaseSelfTest -Condition ($currentVerified.payloadSha256 -eq $currentRepeatedVerified.payloadSha256) `
            -Message 'the current built workspace did not reproduce its payload hash'
        $currentManifest = [System.IO.File]::ReadAllText((Join-Path $currentArtifact 'artifact-manifest.json'), [System.Text.Encoding]::UTF8)
        $currentRepeatedManifest = [System.IO.File]::ReadAllText((Join-Path $currentArtifactRepeat 'artifact-manifest.json'), [System.Text.Encoding]::UTF8)
        Assert-ReleaseSelfTest -Condition ($currentManifest -eq $currentRepeatedManifest) `
            -Message 'the current built workspace did not reproduce its manifest'
        $currentWorkspaceValidated = $true
    }

    [ordered]@{
        protocol = 'DYSON_CONTROL_RELEASE_ARTIFACT_SELFTEST_V1'
        state = 'passed'
        dryRunWasNonMutating = $true
        reproducibleManifest = $true
        reproduciblePayloadSha256 = $verifiedA.payloadSha256
        packageLockManifestVersionBound = $true
        packageLockVersionDriftRejected = $true
        lockRootVersionDriftRejected = $true
        expectedVersionDriftRejected = $true
        coreWindowsRuntimeAllowlistVerified = $true
        coreWindowsMissingCases = $coreMissingCases
        unknownWindowsRuntimeSubtreeRejected = $true
        compiledTestsExcluded = $true
        repositoryOnlyPathsExcluded = $true
        repositoryOnlyPathCases = $repositoryOnlyFixturePaths.Count
        repositoryOnlyApiFixturesRejected = $true
        developmentCliExcluded = $true
        workspaceNodeModulesExcluded = $true
        repositoryOnlyQualificationToolingExcluded = $true
        repositoryOnlyQualificationToolingRejected = $true
        productionDependenciesInstalledWithNpmCi = $true
        secretsLogsAndSavesRejected = $true
        reparsePointRejected = $true
        tamperDetected = $true
        selfContainedVerifierPackaged = $true
        publicBridgeSourcePackaged = $true
        bridgeSimulationTelemetryPackaged = $true
        bridgeFixedReferenceContractPackaged = $true
        bridgeFixedReferenceConditionalDecoyRejected = $true
        bridgeFixedReferenceCommentDecoyRejected = $true
        packagedBridgeSimulationTelemetrySelfTestPassed = $true
        bridgeSimulationTelemetryMissingFileCases = $bridgeTelemetryMissingFileCases
        bridgeSimulationTelemetryExtraFileRejected = $true
        repositoryBridgeSelfTestsExcluded = $true
        privateBridgeBinariesExcluded = $true
        gameRuntimeReceiptApiPackaged = $true
        gameRuntimeReceiptApiMissingFileRejected = $true
        hostnameWssClientQualificationApiPackaged = $true
        hostnameWssClientQualificationApiRequiredFiles = `
            $script:DysonArtifactRequiredApiHostnameWssRuntimeFiles.Count
        hostnameWssClientQualificationApiMissingFileCases = $hostnameWssApiMissingFileCases
        hostnameWssClientQualificationApiMissingFilesRejected = $true
        observabilityRuntimeApiPackaged = $true
        observabilityRuntimeApiRequiredFiles = $observabilityRuntimePaths.Count
        observabilityRuntimeApiMissingFileCases = $observabilityRuntimeMissingFileCases
        observabilityRuntimeApiMissingExtraAndTamperRejected = $true
        observabilitySourceDistDriftRejected = $true
        observabilityCaseDriftRemanifestRejected = $true
        manifestPathSeparatorDriftRejected = $true
        windowsUpdateRuntimeApiPackaged = $true
        updateRuntimeApiRequiredFiles = $script:DysonArtifactRequiredApiUpdateCoreRuntimeFiles.Count
        updateRuntimeApiMissingFileCases = $updateRuntimeMissingCases
        updateRuntimeApiMissingFilesRejected = $true
        nebulaPluginTransactionApiPackaged = $true
        nebulaPluginTransactionApiRequiredFiles = `
            $script:DysonArtifactRequiredApiNebulaPluginTransactionFiles.Count
        nebulaPluginTransactionApiMissingFileCases = $nebulaApiMissingFileCases
        nebulaPluginTransactionApiMissingFilesRejected = $true
        gsManagerParallelMigrationPackaged = $true
        migrationDocumentationPackaged = $true
        gsManagerRecoverableRemovalPackaged = $true
        gsManagerRemovalDocumentationPackaged = $true
        packagedGsManagerRemovalSelfTestPassed = $true
        gsManagerRemovalMissingFilesRejected = $true
        gsManagerRemovalMissingFileCases = $gsManagerRemovalMissingFileCases
        gsManagerRemovalExtraFileRejected = $true
        privateAcceptanceEvidenceToolingPackaged = $true
        hostMutationLeaseToolingPackaged = $true
        hostMutationMissingFilesRejected = $true
        hostMutationMissingFileCases = $hostMutationMissingFileCases
        hostMutationExtraFileRejected = $true
        nebulaPluginTransactionRuntimePackaged = $true
        nebulaPluginTransactionRuntimeRequiredFiles = $nebulaPluginTransactionPaths.Count
        nebulaPluginTransactionRunnerMappings = $actualNebulaRunnerPaths.Count
        nebulaPluginTransactionRunnerMappingsPackaged = $true
        nebulaPluginTransactionMissingFilesRejected = $true
        nebulaPluginTransactionMissingFileCases = $nebulaRuntimeMissingFileCases
        nebulaPluginTransactionExtraFileRejected = $true
        nebulaPluginTransactionTamperRejected = $true
        privateNebulaBuildCandidateEvidenceExcluded = $true
        privateNebulaExcludedSourceCases = $excludedNebulaPrivateSourcePaths.Count
        privateNebulaCandidateBinaryRejected = $true
        cutoverHostToolingPackaged = $true
        packagedCutoverHostSelfTestPassed = $true
        cutoverMissingFilesRejected = $true
        cutoverMissingFileCases = $cutoverMissingFileCases
        cutoverExtraFileRejected = $true
        cutoverBrokerToolingPackaged = $true
        packagedCutoverBrokerSelfTestPassed = $true
        cutoverBrokerMissingFilesRejected = $true
        cutoverBrokerMissingFileCases = $cutoverBrokerMissingFileCases
        cutoverBrokerExtraFileRejected = $true
        lifecycleBrokerToolingPackaged = $true
        packagedLifecycleBrokerSelfTestPassed = $true
        lifecycleBrokerMissingFilesRejected = $true
        lifecycleBrokerMissingFileCases = $lifecycleBrokerMissingFileCases
        lifecycleBrokerExtraFileRejected = $true
        lifecycleBrokerTamperRejected = $true
        dataRootRecoveryToolingPackaged = $true
        dataRootRecoveryDocumentationPackaged = $true
        packagedDataRootRecoverySelfTestPassed = $true
        dataRootRecoveryMissingFilesRejected = $true
        dataRootRecoveryMissingFileCases = $dataRecoveryMissingFileCases
        dataRootRecoveryExtraFileRejected = $true
        nebulaNetworkAssessmentPackaged = $true
        hostnameWssQualificationRuntimePackaged = $true
        qualificationOrchestrationV2Packaged = $true
        qualificationOrchestrationV2RequiredFiles = $qualificationOrchestrationV2Paths.Count
        qualificationOrchestrationV2MissingFileCases = $qualificationOrchestrationMissingFileCases
        qualificationOrchestrationV2MissingExtraAndTamperRejected = $true
        qualificationOrchestrationV2CaseDriftRemanifestRejected = $true
        packagedQualificationOrchestrationV2SelfTestPassed = $true
        qualificationFrameworkPackaged = $true
        qualificationFrameworkRequiredFiles = $qualificationFrameworkPaths.Count
        qualificationFrameworkMissingFileCases = $qualificationFrameworkMissingFileCases
        strictQualificationV2Packaged = $true
        strictQualificationV2RequiredFiles = $strictQualificationV2Paths.Count
        strictQualificationV2RepresentativeMissingFilesRejected = $true
        productionQualificationDocumentationPackaged = $true
        productionQualificationDocumentationMissingRejected = $true
        unlistedQualificationPrivateEvidenceAndCacheExcluded = $true
        networkConnectivityDocumentationPackaged = $true
        packagedNetworkSelfTestPassed = $true
        packagedNetworkV2SelfTestPassed = $true
        packagedHostnameWssQualificationSelfTestPassed = $true
        networkMissingFilesRejected = $true
        networkMissingFileCases = $networkMissingFileCases
        networkExtraFileRejected = $true
        hostnameWssRuntimeRequiredFiles = $hostnameWssRuntimeRequiredPaths.Count
        hostnameWssRuntimeMissingFileCases = $hostnameWssRuntimeMissingFileCases
        hostnameWssRuntimeMissingFilesRejected = $true
        packagedEvidenceSelfTestPassed = $true
        evidenceMissingFileRejected = $true
        evidenceExtraFileRejected = $true
        migrationMissingFileRejected = $true
        migrationExtraFileRejected = $true
        bridgeExtraFileRejected = $true
        bridgeMissingFileRejected = $true
        loadedSaveEvidencePublisherMissingFileRejected = $true
        powerShellRunnerAllowlistPackaged = $true
        powerShellRunnerMappedPaths = $runnerScriptPaths.Count
        powerShellRunnerCutoverMappingsPackaged = $true
        powerShellRunnerNebulaMappingsPackaged = $true
        existingDeploymentAcceptedArtifact = $true
        existingDeploymentBoundArtifactProvenance = $true
        currentWorkspaceValidated = $currentWorkspaceValidated
        productionChanged = $false
    } | ConvertTo-Json -Depth 6 -Compress
}
finally {
    if ($junctionPath -and (Test-Path -LiteralPath $junctionPath)) {
        $junctionItem = Get-Item -LiteralPath $junctionPath -Force -ErrorAction SilentlyContinue
        if ($junctionItem -and ($junctionItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint)) {
            Remove-Item -LiteralPath $junctionPath -Force -ErrorAction SilentlyContinue
        }
    }
    $testFull = [System.IO.Path]::GetFullPath($testRoot).TrimEnd('\', '/')
    $expectedPrefix = $temporaryBase + [System.IO.Path]::DirectorySeparatorChar + 'dcr-selftest-'
    if ($testFull.StartsWith($expectedPrefix, [System.StringComparison]::OrdinalIgnoreCase) -and
        (Test-Path -LiteralPath $testFull)) {
        Remove-Item -LiteralPath $testFull -Recurse -Force
    }
}
