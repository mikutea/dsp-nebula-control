[CmdletBinding()]
param([switch]$IncludeCurrentWorkspace)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)

$newArtifactScript = Join-Path $PSScriptRoot 'New-DysonControlReleaseArtifact.ps1'
$testArtifactScript = Join-Path $PSScriptRoot 'Test-DysonControlReleaseArtifact.ps1'
$deploymentScript = Join-Path $PSScriptRoot '..\deployment\Invoke-DysonControlDeployment.ps1'
$powerShellRunnerSource = Join-Path $PSScriptRoot '..\..\..\apps\api\src\providers\powershell-runner.ts'
$temporaryBase = [System.IO.Path]::GetFullPath([System.IO.Path]::GetTempPath()).TrimEnd('\', '/')
$testRoot = Join-Path $temporaryBase ('dyson-control-release-selftest-' + [guid]::NewGuid().ToString('N'))
$fixtureRoot = Join-Path $testRoot 'workspace'
$artifactA = Join-Path $testRoot 'artifact-a'
$artifactB = Join-Path $testRoot 'artifact-b'
$artifactForbidden = Join-Path $testRoot 'artifact-forbidden'
$artifactLog = Join-Path $testRoot 'artifact-log'
$artifactSecret = Join-Path $testRoot 'artifact-secret'
$artifactRedirected = Join-Path $testRoot 'artifact-redirected'
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

[System.IO.Directory]::CreateDirectory($fixtureRoot) | Out-Null
try {
    Write-FixtureText -Path (Join-Path $fixtureRoot 'LICENSE') -Value "Fictional self-test license.`n"
    Write-FixtureText -Path (Join-Path $fixtureRoot '.env') -Value "DYSON_SESSION_SECRET=fictional-not-packaged`n"
    Write-FixtureText -Path (Join-Path $fixtureRoot 'apps\api\package.json') -Value @'
{"name":"@example/dyson-control-fixture","version":"1.2.3","private":true,"type":"module","main":"dist/index.js","dependencies":{},"devDependencies":{}}
'@
    Write-FixtureText -Path (Join-Path $fixtureRoot 'apps\api\package-lock.json') -Value @'
{"name":"@example/dyson-control-fixture","version":"1.2.3","lockfileVersion":3,"requires":true,"packages":{"":{"name":"@example/dyson-control-fixture","version":"1.2.3","dependencies":{},"devDependencies":{}}}}
'@
    Write-FixtureText -Path (Join-Path $fixtureRoot 'apps\api\dist\index.js') -Value "import './app.js'`n"
    Write-FixtureText -Path (Join-Path $fixtureRoot 'apps\api\dist\app.js') -Value "console.log('fictional runtime fixture')`n"
    Write-FixtureText -Path (Join-Path $fixtureRoot 'apps\api\dist\app.test.js') -Value "throw new Error('test file must not ship')`n"
    Write-FixtureText -Path (Join-Path $fixtureRoot 'apps\api\dist\cli\hash-password.js') -Value "throw new Error('development CLI must not ship')`n"
    Write-FixtureText -Path (Join-Path $fixtureRoot 'apps\api\node_modules\dev-only\fixture.log') -Value "workspace node_modules must not ship`n"
    Write-FixtureText -Path (Join-Path $fixtureRoot 'apps\web\dist\index.html') -Value '<!doctype html><div id="root"></div>'
    Write-FixtureText -Path (Join-Path $fixtureRoot 'apps\web\dist\assets\index-fixture.js') -Value "console.log('fictional web fixture')`n"
    Write-FixtureText -Path (Join-Path $fixtureRoot 'apps\web\dist\assets\index-fixture.css') -Value "body{color:#fff}`n"

    $topLevelScripts = @(
        'Get-DysonLifecyclePreflight.ps1', 'Get-DysonManagedPluginVersion.ps1',
        'Get-DysonStatus.ps1', 'Install-DysonRuntimeTasks.ps1',
        'Invoke-DysonScheduledTask.ps1', 'New-DysonSaveProtectionPoint.ps1', 'Start-DysonServer.ps1',
        'Stop-DysonServer.ps1', 'Test-DysonRuntimeState.ps1'
    )
    $releaseVerifierScripts = @(
        'DysonReleasePackaging.Common.ps1', 'Test-DysonControlReleaseArtifact.ps1'
    )
    $deploymentScripts = @(
        'DysonDeployment.Common.ps1', 'Install-DysonControl.ps1', 'Install-DysonControlTask.ps1',
        'Invoke-DysonControlDeployment.ps1', 'Start-DysonControl.ps1',
        'Test-DysonControlDeployment.ps1', 'Uninstall-DysonControl.ps1'
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
    $migrationDocs = @('docs/GSM-EVALUATION.md', 'docs/WINDOWS-DEPLOYMENT-DRAFT.md')
    $bridgeScripts = @(
        'Build-DysonControlBridgeCandidate.ps1', 'DysonBridge.Common.ps1',
        'Install-DysonControlBridge.ps1', 'Test-DysonControlBridgeCandidate.ps1',
        'Test-DysonControlBridgeInstallation.ps1', 'Uninstall-DysonControlBridge.ps1'
    )
    $bridgeSourceFiles = @(
        'BridgeFileStore.cs', 'BridgeProtocol.cs', 'DysonControlBridge.csproj',
        'DysonControlBridgePlugin.cs', 'GameSaveAdapter.cs', 'PlayerRosterPublisher.cs',
        'README.md', 'dyson-control-bridge.cfg.example',
        'protocol-tests\DysonControlBridge.ProtocolTests.csproj', 'protocol-tests\Program.cs'
    )
    foreach ($name in $topLevelScripts) {
        Copy-FixtureScript -Source (Join-Path $PSScriptRoot "..\$name") `
            -Destination (Join-Path $fixtureRoot "scripts\windows\$name")
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
    foreach ($name in $bridgeScripts) {
        Copy-FixtureScript -Source (Join-Path $PSScriptRoot "..\bridge\$name") `
            -Destination (Join-Path $fixtureRoot "scripts\windows\bridge\$name")
    }
    foreach ($name in $bridgeSourceFiles) {
        Copy-FixtureScript -Source (Join-Path $PSScriptRoot "..\..\..\integrations\dyson-control-bridge\$name") `
            -Destination (Join-Path $fixtureRoot "integrations\dyson-control-bridge\$name")
    }
    $repositoryRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..\..'))
    foreach ($relative in $migrationDocs) {
        Copy-FixtureScript -Source (Join-Path $repositoryRoot $relative.Replace('/', '\')) `
            -Destination (Join-Path $fixtureRoot $relative.Replace('/', '\'))
    }

    $previewOutput = & $newArtifactScript -RepositoryRoot $fixtureRoot -Version '1.2.3-fixture' `
        -OutputPath $artifactA -WhatIf 6>$null
    $preview = Convert-LastJsonResult -Output $previewOutput
    Assert-ReleaseSelfTest -Condition ($preview.state -eq 'preview' -and [bool]$preview.dryRun) -Message 'WhatIf did not return a dry-run plan'
    Assert-ReleaseSelfTest -Condition (-not (Test-Path -LiteralPath $artifactA)) -Message 'WhatIf created the artifact output'

    $createdA = Convert-LastJsonResult -Output (& $newArtifactScript -RepositoryRoot $fixtureRoot `
        -Version '1.2.3-fixture' -OutputPath $artifactA -Confirm:$false)
    $createdB = Convert-LastJsonResult -Output (& $newArtifactScript -RepositoryRoot $fixtureRoot `
        -Version '1.2.3-fixture' -OutputPath $artifactB -Confirm:$false)
    Assert-ReleaseSelfTest -Condition ($createdA.state -eq 'created' -and $createdB.state -eq 'created') -Message 'artifact assembly did not complete'

    $verifiedA = Convert-LastJsonResult -Output (& $testArtifactScript -ArtifactPath $artifactA -ExpectedVersion '1.2.3-fixture')
    $verifiedB = Convert-LastJsonResult -Output (& $testArtifactScript -ArtifactPath $artifactB -ExpectedVersion '1.2.3-fixture')
    Assert-ReleaseSelfTest -Condition ([bool]$verifiedA.ready -and [bool]$verifiedB.ready) -Message 'artifact verification failed'
    Assert-ReleaseSelfTest -Condition ([bool]$verifiedA.publicBridgeSourcePackaged -and -not [bool]$verifiedA.privateBridgeBinariesPackaged) `
        -Message 'artifact verification did not attest the public-source/private-binary Bridge boundary'
    Assert-ReleaseSelfTest -Condition ([bool]$verifiedA.gsManagerParallelMigrationPackaged -and [bool]$verifiedA.migrationDocumentationPackaged) `
        -Message 'artifact verification did not attest the GSManager parallel-migration tools and documentation'
    Assert-ReleaseSelfTest -Condition ($verifiedA.payloadSha256 -eq $verifiedB.payloadSha256) -Message 'identical inputs produced different payload hashes'
    $manifestA = [System.IO.File]::ReadAllText((Join-Path $artifactA 'artifact-manifest.json'), [System.Text.Encoding]::UTF8)
    $manifestB = [System.IO.File]::ReadAllText((Join-Path $artifactB 'artifact-manifest.json'), [System.Text.Encoding]::UTF8)
    Assert-ReleaseSelfTest -Condition ($manifestA -eq $manifestB) -Message 'identical inputs produced different manifests'
    Assert-ReleaseSelfTest -Condition (-not (Test-Path -LiteralPath (Join-Path $artifactA 'apps\api\dist\app.test.js'))) -Message 'compiled tests entered the artifact'
    Assert-ReleaseSelfTest -Condition (-not (Test-Path -LiteralPath (Join-Path $artifactA 'apps\api\dist\cli'))) -Message 'development CLI entered the artifact'
    Assert-ReleaseSelfTest -Condition (-not (Test-Path -LiteralPath (Join-Path $artifactA 'apps\api\node_modules\dev-only'))) -Message 'workspace node_modules was copied'
    Assert-ReleaseSelfTest -Condition (-not (Test-Path -LiteralPath (Join-Path $artifactA '.env'))) -Message 'workspace .env entered the artifact'
    foreach ($name in $releaseVerifierScripts) {
        Assert-ReleaseSelfTest -Condition (Test-Path -LiteralPath (Join-Path $artifactA "scripts\windows\release\$name") -PathType Leaf) `
            -Message "self-contained release verifier script was omitted: $name"
    }
    $runnerSourceText = [System.IO.File]::ReadAllText($powerShellRunnerSource, [System.Text.Encoding]::UTF8)
    $runnerAllowlist = [regex]::Match(
        $runnerSourceText,
        'const\s+lifecycleScriptNames\s*=\s*\[(?<body>.*?)\]\s+as\s+const',
        [System.Text.RegularExpressions.RegexOptions]::Singleline
    )
    Assert-ReleaseSelfTest -Condition $runnerAllowlist.Success -Message 'the PowerShell runner script allowlist could not be read'
    $runnerScriptNames = @(
        [regex]::Matches($runnerAllowlist.Groups['body'].Value, "'(?<name>[A-Za-z0-9.-]+\.ps1)'") |
            ForEach-Object { $_.Groups['name'].Value }
    )
    Assert-ReleaseSelfTest -Condition ($runnerScriptNames.Count -gt 0) -Message 'the PowerShell runner script allowlist was empty'
    foreach ($name in $runnerScriptNames) {
        Assert-ReleaseSelfTest -Condition ($topLevelScripts -contains $name) `
            -Message "the release packaging list drifted from the PowerShell runner allowlist: $name"
        Assert-ReleaseSelfTest -Condition (Test-Path -LiteralPath (Join-Path $artifactA "scripts\windows\$name") -PathType Leaf) `
            -Message "an allowlisted PowerShell runner script was omitted from the artifact: $name"
    }
    foreach ($name in $sessionScripts) {
        Assert-ReleaseSelfTest -Condition (Test-Path -LiteralPath (Join-Path $artifactA "scripts\windows\session\$name") -PathType Leaf) `
            -Message "interactive-session runtime script was omitted: $name"
    }
    foreach ($name in $migrationScripts) {
        Assert-ReleaseSelfTest -Condition (Test-Path -LiteralPath (Join-Path $artifactA "scripts\windows\migration\$name") -PathType Leaf) `
            -Message "a GSManager migration script was omitted from the public artifact: $name"
    }
    foreach ($relative in $migrationDocs) {
        Assert-ReleaseSelfTest -Condition (Test-Path -LiteralPath (Join-Path $artifactA $relative.Replace('/', '\')) -PathType Leaf) `
            -Message "GSManager migration documentation was omitted from the public artifact: $relative"
    }
    foreach ($name in $bridgeScripts) {
        Assert-ReleaseSelfTest -Condition (Test-Path -LiteralPath (Join-Path $artifactA "scripts\windows\bridge\$name") -PathType Leaf) `
            -Message "a Bridge delivery script was omitted from the public artifact: $name"
    }
    foreach ($name in @($bridgeSourceFiles | Where-Object { $_ -notlike 'protocol-tests*' })) {
        Assert-ReleaseSelfTest -Condition (Test-Path -LiteralPath (Join-Path $artifactA "integrations\dyson-control-bridge\$name") -PathType Leaf) `
            -Message "a required public Bridge source file was omitted: $name"
    }
    Assert-ReleaseSelfTest -Condition (-not (Test-Path -LiteralPath (Join-Path $artifactA 'integrations\dyson-control-bridge\protocol-tests'))) `
        -Message 'Bridge protocol-test build inputs entered the runtime artifact'
    $publicBridgeBinaries = @(Get-ChildItem -LiteralPath (Join-Path $artifactA 'integrations\dyson-control-bridge') -File -Recurse -Force |
        Where-Object { $_.Extension.ToLowerInvariant() -in @('.dll', '.pdb', '.exe') })
    Assert-ReleaseSelfTest -Condition ($publicBridgeBinaries.Count -eq 0) `
        -Message 'a compiled or proprietary assembly entered the public Bridge source package'

    $requiredBridgeScript = Join-Path $artifactB 'scripts\windows\bridge\Test-DysonControlBridgeCandidate.ps1'
    $requiredBridgeScriptBackup = Join-Path $testRoot 'required-bridge-script.backup'
    [System.IO.File]::Move($requiredBridgeScript, $requiredBridgeScriptBackup)
    $bridgeMissingRejected = $false
    try { & $testArtifactScript -ArtifactPath $artifactB -ExpectedVersion '1.2.3-fixture' | Out-Null }
    catch { $bridgeMissingRejected = $true }
    Assert-ReleaseSelfTest -Condition $bridgeMissingRejected -Message 'an artifact missing a required Bridge delivery script was accepted'
    [System.IO.File]::Move($requiredBridgeScriptBackup, $requiredBridgeScript)

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

    $installRoot = Join-Path $testRoot 'deployment-install'
    $dataRoot = Join-Path $testRoot 'deployment-data'
    $stage = Convert-LastJsonResult -Output (& $deploymentScript -Operation Stage -SourcePath $artifactA `
        -Version '1.2.3-fixture' -InstallRoot $installRoot -DataRoot $dataRoot -Confirm:$false)
    Assert-ReleaseSelfTest -Condition ($stage.state -eq 'staged') -Message 'the existing deployment transaction rejected the artifact layout'

    $forbiddenSave = Join-Path $fixtureRoot 'apps\web\dist\fictional.server'
    Write-FixtureText -Path $forbiddenSave -Value 'fictional save metadata'
    $forbiddenRejected = $false
    try {
        & $newArtifactScript -RepositoryRoot $fixtureRoot -Version '1.2.3-forbidden' `
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
        & $newArtifactScript -RepositoryRoot $fixtureRoot -Version '1.2.3-log' `
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
        & $newArtifactScript -RepositoryRoot $fixtureRoot -Version '1.2.3-secret' `
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
        & $newArtifactScript -RepositoryRoot $fixtureRoot -Version '1.2.3-redirected' `
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
        $currentArtifact = Join-Path $testRoot 'current-workspace-artifact'
        $currentArtifactRepeat = Join-Path $testRoot 'current-workspace-artifact-repeat'
        $currentCreated = Convert-LastJsonResult -Output (& $newArtifactScript -RepositoryRoot $currentRepository `
            -Version '0.1.0-workspace-smoke' -OutputPath $currentArtifact -Confirm:$false)
        $currentRepeated = Convert-LastJsonResult -Output (& $newArtifactScript -RepositoryRoot $currentRepository `
            -Version '0.1.0-workspace-smoke' -OutputPath $currentArtifactRepeat -Confirm:$false)
        $currentVerified = Convert-LastJsonResult -Output (& $testArtifactScript -ArtifactPath $currentArtifact `
            -ExpectedVersion '0.1.0-workspace-smoke')
        $currentRepeatedVerified = Convert-LastJsonResult -Output (& $testArtifactScript -ArtifactPath $currentArtifactRepeat `
            -ExpectedVersion '0.1.0-workspace-smoke')
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
        compiledTestsExcluded = $true
        developmentCliExcluded = $true
        workspaceNodeModulesExcluded = $true
        productionDependenciesInstalledWithNpmCi = $true
        secretsLogsAndSavesRejected = $true
        reparsePointRejected = $true
        tamperDetected = $true
        selfContainedVerifierPackaged = $true
        publicBridgeSourcePackaged = $true
        privateBridgeBinariesExcluded = $true
        gsManagerParallelMigrationPackaged = $true
        migrationDocumentationPackaged = $true
        migrationMissingFileRejected = $true
        migrationExtraFileRejected = $true
        bridgeExtraFileRejected = $true
        bridgeMissingFileRejected = $true
        powerShellRunnerAllowlistPackaged = $true
        existingDeploymentAcceptedArtifact = $true
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
    $expectedPrefix = $temporaryBase + [System.IO.Path]::DirectorySeparatorChar + 'dyson-control-release-selftest-'
    if ($testFull.StartsWith($expectedPrefix, [System.StringComparison]::OrdinalIgnoreCase) -and
        (Test-Path -LiteralPath $testFull)) {
        Remove-Item -LiteralPath $testFull -Recurse -Force
    }
}
