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
$taskFixtureEnabled = $false

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
    $requiredEvidenceScripts = @()
    if (Get-Variable -Name DysonArtifactRequiredEvidenceScripts -Scope Script -ErrorAction SilentlyContinue) {
        $requiredEvidenceScripts = @($script:DysonArtifactRequiredEvidenceScripts)
    }
    foreach ($relative in @(
        $script:DysonArtifactRequiredBridgeSources +
        $script:DysonArtifactRequiredBridgeScripts +
        $script:DysonArtifactRequiredMigrationScripts +
        $script:DysonArtifactRequiredMigrationDocs +
        $requiredEvidenceScripts
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

function Get-ActiveVersionAt {
    param([Parameter(Mandatory)][string]$DataRoot)
    $pointerPath = Join-Path $DataRoot 'state\active-release.json'
    if (-not (Test-Path -LiteralPath $pointerPath -PathType Leaf)) { return $null }
    return [string](([System.IO.File]::ReadAllText($pointerPath, [System.Text.Encoding]::UTF8) | ConvertFrom-Json).version)
}

function Enable-DysonTaskSchedulerFixture {
    $global:DysonDeploymentTaskFixture = @{}
    $global:DysonDeploymentTaskFixtureFailRemovalFor = $null
    $global:DysonDeploymentTaskFixtureCorruptRegistrationFor = $null
    $global:DysonDeploymentTaskFixtureFailUnregisterOnceFor = $null
    $global:DysonDeploymentTaskFixtureQueryFailure = $false
    $global:DysonDeploymentTaskFixtureStopCalls = New-Object System.Collections.Generic.List[string]
    $global:DysonDeploymentTaskFixtureStartCalls = New-Object System.Collections.Generic.List[string]
    $global:DysonDeploymentTaskFixtureUnregisterCalls = New-Object System.Collections.Generic.List[string]
    Set-Item -Path 'Function:\global:Get-ScheduledTask' -Value {
        [CmdletBinding()]
        param([string]$TaskName, [string]$TaskPath)
        if ($global:DysonDeploymentTaskFixtureQueryFailure) { throw 'fixture scheduler query failed' }
        $tasks = @(
            foreach ($value in @($global:DysonDeploymentTaskFixture.Values)) {
                foreach ($task in @($value)) {
                    if ($task.PSObject.Properties.Name -notcontains 'TaskName') {
                        $task | Add-Member -NotePropertyName TaskName -NotePropertyValue ([string]$task.FixtureTaskName)
                    }
                    $task
                }
            }
        )
        if ($PSBoundParameters.ContainsKey('TaskName')) {
            $tasks = @($tasks | Where-Object {
                [string]::Equals([string]$_.TaskName, $TaskName, [System.StringComparison]::OrdinalIgnoreCase)
            })
        }
        if ($PSBoundParameters.ContainsKey('TaskPath')) {
            $tasks = @($tasks | Where-Object {
                [string]::Equals([string]$_.TaskPath, $TaskPath, [System.StringComparison]::Ordinal)
            })
        }
        return $tasks
    }
    Set-Item -Path 'Function:\global:Export-ScheduledTask' -Value {
        [CmdletBinding()]
        param([Parameter(Mandatory)][string]$TaskName, [string]$TaskPath)
        if (-not $global:DysonDeploymentTaskFixture.ContainsKey($TaskName)) { throw 'fixture task missing' }
        $tasks = @($global:DysonDeploymentTaskFixture[$TaskName])
        if ($PSBoundParameters.ContainsKey('TaskPath')) {
            $tasks = @($tasks | Where-Object {
                [string]::Equals([string]$_.TaskPath, $TaskPath, [System.StringComparison]::Ordinal)
            })
        }
        if ($tasks.Count -ne 1) { throw 'fixture task identity is not unique' }
        return [string]$tasks[0].Xml
    }
    Set-Item -Path 'Function:\global:Stop-ScheduledTask' -Value {
        [CmdletBinding()]
        param([Parameter(Mandatory)]$InputObject)
        if ([string]$global:DysonDeploymentTaskFixtureFailRemovalFor -ceq [string]$InputObject.FixtureTaskName) {
            throw 'fixture refused to stop the replacement task'
        }
        $global:DysonDeploymentTaskFixtureStopCalls.Add([string]$InputObject.FixtureTaskName)
        $global:DysonDeploymentTaskFixture[[string]$InputObject.FixtureTaskName].State = 'Ready'
    }
    Set-Item -Path 'Function:\global:Start-ScheduledTask' -Value {
        [CmdletBinding(DefaultParameterSetName = 'ByName')]
        param(
            [Parameter(ParameterSetName = 'ByName')][string]$TaskName,
            [Parameter(ParameterSetName = 'ByName')][string]$TaskPath,
            [Parameter(ParameterSetName = 'ByObject')]$InputObject
        )
        if ($PSCmdlet.ParameterSetName -eq 'ByObject') {
            $global:DysonDeploymentTaskFixtureStartCalls.Add([string]$InputObject.FixtureTaskName)
            $InputObject.State = 'Running'
            return
        }
        if (-not $global:DysonDeploymentTaskFixture.ContainsKey($TaskName)) { throw 'fixture task missing' }
        $tasks = @($global:DysonDeploymentTaskFixture[$TaskName])
        if ($PSBoundParameters.ContainsKey('TaskPath')) {
            $tasks = @($tasks | Where-Object {
                [string]::Equals([string]$_.TaskPath, $TaskPath, [System.StringComparison]::Ordinal)
            })
        }
        if ($tasks.Count -ne 1) { throw 'fixture task identity is not unique' }
        $global:DysonDeploymentTaskFixtureStartCalls.Add([string]$tasks[0].FixtureTaskName)
        $tasks[0].State = 'Running'
    }
    Set-Item -Path 'Function:\global:Unregister-ScheduledTask' -Value {
        [CmdletBinding(SupportsShouldProcess)]
        param([Parameter(Mandatory)][string]$TaskName, [string]$TaskPath)
        $global:DysonDeploymentTaskFixtureUnregisterCalls.Add($TaskName)
        if ([string]$global:DysonDeploymentTaskFixtureFailUnregisterOnceFor -ceq $TaskName) {
            $global:DysonDeploymentTaskFixtureFailUnregisterOnceFor = $null
            throw 'fixture refused the first unregister attempt'
        }
        if (-not $global:DysonDeploymentTaskFixture.ContainsKey($TaskName)) { return }
        if (-not $PSBoundParameters.ContainsKey('TaskPath')) {
            [void]$global:DysonDeploymentTaskFixture.Remove($TaskName)
            return
        }
        $remaining = @(@($global:DysonDeploymentTaskFixture[$TaskName]) | Where-Object {
            -not [string]::Equals([string]$_.TaskPath, $TaskPath, [System.StringComparison]::Ordinal)
        })
        if ($remaining.Count -eq 0) { [void]$global:DysonDeploymentTaskFixture.Remove($TaskName) }
        elseif ($remaining.Count -eq 1) { $global:DysonDeploymentTaskFixture[$TaskName] = $remaining[0] }
        else { $global:DysonDeploymentTaskFixture[$TaskName] = $remaining }
    }
    Set-Item -Path 'Function:\global:New-ScheduledTaskAction' -Value {
        [CmdletBinding()]
        param([Parameter(Mandatory)][string]$Execute, [string]$Argument)
        return [pscustomobject]@{ Execute = $Execute; Arguments = $Argument }
    }
    Set-Item -Path 'Function:\global:New-ScheduledTaskTrigger' -Value {
        [CmdletBinding()]
        param([switch]$AtStartup)
        return [pscustomobject]@{ Kind = 'AtStartup' }
    }
    Set-Item -Path 'Function:\global:New-ScheduledTaskPrincipal' -Value {
        [CmdletBinding()]
        param([string]$UserId, [string]$LogonType, [string]$RunLevel)
        return [pscustomobject]@{ UserId = $UserId; LogonType = $LogonType; RunLevel = $RunLevel }
    }
    Set-Item -Path 'Function:\global:New-ScheduledTaskSettingsSet' -Value {
        [CmdletBinding()]
        param(
            [switch]$AllowStartIfOnBatteries,
            [switch]$DontStopIfGoingOnBatteries,
            [timespan]$ExecutionTimeLimit,
            [string]$MultipleInstances,
            [int]$RestartCount,
            [timespan]$RestartInterval,
            [switch]$StartWhenAvailable
        )
        return [pscustomobject]@{ MultipleInstances = $MultipleInstances }
    }
    Set-Item -Path 'Function:\global:Register-ScheduledTask' -Value {
        [CmdletBinding(DefaultParameterSetName = 'Definition')]
        param(
            [Parameter(Mandatory)][string]$TaskName,
            [string]$TaskPath = '\',
            [Parameter(ParameterSetName = 'Definition')]$Action,
            [Parameter(ParameterSetName = 'Definition')]$Trigger,
            [Parameter(ParameterSetName = 'Definition')]$Principal,
            [Parameter(ParameterSetName = 'Definition')]$Settings,
            [Parameter(ParameterSetName = 'Definition')][string]$Description,
            [Parameter(ParameterSetName = 'Xml', Mandatory)][string]$Xml,
            [switch]$Force
        )
        if ($PSCmdlet.ParameterSetName -eq 'Xml') {
            $task = [pscustomobject]@{
                FixtureTaskName = $TaskName
                TaskName = $TaskName
                TaskPath = $TaskPath
                State = 'Ready'
                Xml = $Xml
                Principal = [pscustomobject]@{ UserId = 'fixture-restored'; LogonType = 'Interactive'; RunLevel = 'Limited' }
                Actions = @()
                Settings = [pscustomobject]@{ Enabled = $true }
            }
        }
        else {
            $xmlValue = '<Task><RegistrationInfo><Description>fixture replacement task</Description></RegistrationInfo></Task>'
            $registeredActions = if ([string]$global:DysonDeploymentTaskFixtureCorruptRegistrationFor -ceq $TaskName) {
                @()
            }
            else { @($Action) }
            $task = [pscustomobject]@{
                FixtureTaskName = $TaskName
                TaskName = $TaskName
                TaskPath = $TaskPath
                State = 'Ready'
                Xml = $xmlValue
                Principal = $Principal
                Actions = $registeredActions
                Settings = [pscustomobject]@{ Enabled = $true }
            }
        }
        $global:DysonDeploymentTaskFixture[$TaskName] = $task
        return $task
    }
}

function Disable-DysonTaskSchedulerFixture {
    foreach ($name in @(
        'Get-ScheduledTask', 'Export-ScheduledTask', 'Stop-ScheduledTask', 'Start-ScheduledTask',
        'Unregister-ScheduledTask', 'New-ScheduledTaskAction', 'New-ScheduledTaskTrigger',
        'New-ScheduledTaskPrincipal', 'New-ScheduledTaskSettingsSet', 'Register-ScheduledTask'
    )) {
        Remove-Item -Path ('Function:\global:' + $name) -Force -ErrorAction SilentlyContinue
    }
    Remove-Variable -Name DysonDeploymentTaskFixture -Scope Global -ErrorAction SilentlyContinue
    Remove-Variable -Name DysonDeploymentTaskFixtureFailRemovalFor -Scope Global -ErrorAction SilentlyContinue
    Remove-Variable -Name DysonDeploymentTaskFixtureCorruptRegistrationFor -Scope Global -ErrorAction SilentlyContinue
    Remove-Variable -Name DysonDeploymentTaskFixtureFailUnregisterOnceFor -Scope Global -ErrorAction SilentlyContinue
    Remove-Variable -Name DysonDeploymentTaskFixtureQueryFailure -Scope Global -ErrorAction SilentlyContinue
    Remove-Variable -Name DysonDeploymentTaskFixtureStopCalls -Scope Global -ErrorAction SilentlyContinue
    Remove-Variable -Name DysonDeploymentTaskFixtureStartCalls -Scope Global -ErrorAction SilentlyContinue
    Remove-Variable -Name DysonDeploymentTaskFixtureUnregisterCalls -Scope Global -ErrorAction SilentlyContinue
}

function Assert-NoInstallPartials {
    param(
        [Parameter(Mandatory)][string]$InstallRoot,
        [Parameter(Mandatory)][string]$DataRoot,
        [Parameter(Mandatory)][string]$Message
    )
    $partials = @()
    if (Test-Path -LiteralPath $InstallRoot -PathType Container) {
        $partials += @(Get-ChildItem -LiteralPath $InstallRoot -Force -ErrorAction Stop | Where-Object {
            $_.Name -like '.bootstrap-*' -or $_.Name -like '.staging-*'
        })
        $releaseRoot = Join-Path $InstallRoot 'releases'
        if (Test-Path -LiteralPath $releaseRoot -PathType Container) {
            $partials += @(Get-ChildItem -LiteralPath $releaseRoot -Force -ErrorAction Stop | Where-Object { $_.Name -like '.staging-*' })
        }
    }
    if (Test-Path -LiteralPath $DataRoot -PathType Container) {
        $partials += @(Get-ChildItem -LiteralPath $DataRoot -Force -ErrorAction Stop | Where-Object {
            $_.Name -like '.config-restore-*' -or $_.Name -like '.config-superseded-*'
        })
    }
    Assert-SelfTest -Condition ($partials.Count -eq 0) -Message $Message
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
        (Get-DysonDeploymentLockPath -DataRoot $dataRoot),
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
    [System.IO.Directory]::CreateDirectory([System.IO.Path]::GetDirectoryName($installerData)) | Out-Null
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

    $installSuccessText = ($installerOutput | Out-String)
    Assert-SelfTest -Condition (-not $installSuccessText.Contains($installerRoot) -and
        -not $installSuccessText.Contains($installerData) -and
        $installSuccessText -notmatch '(?i)NT AUTHORITY|<Task') `
        -Message 'the successful installer receipt disclosed a path, account, or task XML'

    $taskRollbackExistingRoot = Join-Path $testRoot 'task-rollback-existing-program-files\DysonControl'
    $taskRollbackExistingData = Join-Path $testRoot 'task-rollback-existing-program-data\DysonControl'
    $taskRollbackNewRoot = Join-Path $testRoot 'task-rollback-new-program-files\DysonControl'
    $taskRollbackNewData = Join-Path $testRoot 'task-rollback-new-program-data\DysonControl'
    $taskRemovalFailureRoot = Join-Path $testRoot 'task-removal-failure-program-files\DysonControl'
    $taskRemovalFailureData = Join-Path $testRoot 'task-removal-failure-program-data\DysonControl'
    $wrapperLockRoot = Join-Path $testRoot 'wrapper-lock-program-files\DysonControl'
    $wrapperLockData = Join-Path $testRoot 'wrapper-lock-program-data\DysonControl'
    foreach ($roots in @(
        @($taskRollbackExistingRoot, $taskRollbackExistingData),
        @($taskRollbackNewRoot, $taskRollbackNewData),
        @($taskRemovalFailureRoot, $taskRemovalFailureData),
        @($wrapperLockRoot, $wrapperLockData)
    )) {
        [void](Invoke-DeploymentJson -Arguments @{
            Operation = 'Upgrade'; SourcePath = $payloadA; Version = '1.0.0'
            InstallRoot = $roots[0]; DataRoot = $roots[1]
        })
    }

    $closedListener = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, 0)
    $closedListener.Start()
    $closedPort = ([System.Net.IPEndPoint]$closedListener.LocalEndpoint).Port
    $closedListener.Stop()
    $closedReadinessUri = [uri]("http://127.0.0.1:$closedPort/readyz")

    [System.Environment]::SetEnvironmentVariable('DYSON_DEPLOYMENT_ALLOW_SELFTEST_TASKS', 'true', 'Process')
    Enable-DysonTaskSchedulerFixture
    $taskFixtureEnabled = $true

    $schedulerFailureTaskName = 'Dyson-Control-Plane-SelfTest-Scheduler-Failure'
    $schedulerFailureTaskXml = '<Task><RegistrationInfo><Description>fictional scheduler query failure preimage</Description></RegistrationInfo></Task>'
    $schedulerFailureTask = [pscustomobject]@{
        FixtureTaskName = $schedulerFailureTaskName
        TaskPath = '\'
        State = 'Running'
        Xml = $schedulerFailureTaskXml
        Principal = [pscustomobject]@{ UserId = 'fictional-scheduler-failure'; LogonType = 'Interactive'; RunLevel = 'Limited' }
        Actions = @()
        Settings = [pscustomobject]@{ Enabled = $true }
    }
    $global:DysonDeploymentTaskFixture[$schedulerFailureTaskName] = $schedulerFailureTask
    $schedulerFailureTaskAuditLength = (Get-Item -LiteralPath $taskAuditPath -ErrorAction Stop).Length
    $schedulerFailureTaskAcl = (Get-Acl -LiteralPath $installerData -ErrorAction Stop).Sddl
    $schedulerFailureTaskPointer = [System.IO.File]::ReadAllText(
        (Join-Path $installerData 'state\active-release.json'),
        [System.Text.Encoding]::UTF8
    )
    $schedulerFailureInstallRejected = $false
    $global:DysonDeploymentTaskFixtureQueryFailure = $true
    try {
        & $taskScript -InstallRoot $installerRoot -DataRoot $installerData -NodeExecutable $nodeFixtures.node24 `
            -TaskName $schedulerFailureTaskName -EnvironmentFile (Join-Path $installerData 'config\dyson-control.env') `
            -SelfTestSkipAdministratorCheck -Confirm:$false | Out-Null
    }
    catch { $schedulerFailureInstallRejected = $_.Exception.Message -eq 'The Task Scheduler state could not be queried.' }
    finally { $global:DysonDeploymentTaskFixtureQueryFailure = $false }
    Assert-SelfTest -Condition ($schedulerFailureInstallRejected -and
        $schedulerFailureTask.State -eq 'Running' -and $schedulerFailureTask.Xml -ceq $schedulerFailureTaskXml -and
        (Get-Item -LiteralPath $taskAuditPath -ErrorAction Stop).Length -eq $schedulerFailureTaskAuditLength -and
        (Get-Acl -LiteralPath $installerData -ErrorAction Stop).Sddl -eq $schedulerFailureTaskAcl -and
        [System.IO.File]::ReadAllText(
            (Join-Path $installerData 'state\active-release.json'),
            [System.Text.Encoding]::UTF8
        ) -ceq $schedulerFailureTaskPointer) `
        -Message 'task installation did not fail closed before mutation when Task Scheduler could not be queried'

    $schedulerFailureUninstallAuditPath = Join-Path $wrapperLockData 'audit\deployment.jsonl'
    $schedulerFailureUninstallAuditLength = (Get-Item -LiteralPath $schedulerFailureUninstallAuditPath -ErrorAction Stop).Length
    $schedulerFailureUninstallPointer = [System.IO.File]::ReadAllText(
        (Join-Path $wrapperLockData 'state\active-release.json'),
        [System.Text.Encoding]::UTF8
    )
    $schedulerFailureUninstallRejected = $false
    $global:DysonDeploymentTaskFixtureQueryFailure = $true
    try {
        & $uninstallScript -InstallRoot $wrapperLockRoot -DataRoot $wrapperLockData `
            -TaskName $schedulerFailureTaskName -SelfTestSkipAdministratorCheck -Confirm:$false | Out-Null
    }
    catch { $schedulerFailureUninstallRejected = $_.Exception.Message -eq 'The Task Scheduler state could not be queried.' }
    finally { $global:DysonDeploymentTaskFixtureQueryFailure = $false }
    Assert-SelfTest -Condition ($schedulerFailureUninstallRejected -and
        $schedulerFailureTask.State -eq 'Running' -and $schedulerFailureTask.Xml -ceq $schedulerFailureTaskXml -and
        (Test-Path -LiteralPath $wrapperLockRoot -PathType Container) -and
        (Get-Item -LiteralPath $schedulerFailureUninstallAuditPath -ErrorAction Stop).Length -eq $schedulerFailureUninstallAuditLength -and
        [System.IO.File]::ReadAllText(
            (Join-Path $wrapperLockData 'state\active-release.json'),
            [System.Text.Encoding]::UTF8
        ) -ceq $schedulerFailureUninstallPointer) `
        -Message 'uninstall did not fail closed before mutation when Task Scheduler could not be queried'
    [void]$global:DysonDeploymentTaskFixture.Remove($schedulerFailureTaskName)

    $restartNonRootTaskName = 'Dyson-Control-Plane-SelfTest-Restart-Non-Root'
    $restartNonRootTask = [pscustomobject]@{
        FixtureTaskName = $restartNonRootTaskName
        TaskPath = '\FictionalFolder\'
        State = 'Running'
        Xml = '<Task><RegistrationInfo><Description>fictional non-root restart task</Description></RegistrationInfo></Task>'
        Principal = [pscustomobject]@{ UserId = 'fictional-restart-non-root'; LogonType = 'Interactive'; RunLevel = 'Limited' }
        Actions = @()
        Settings = [pscustomobject]@{ Enabled = $true }
    }
    $global:DysonDeploymentTaskFixture[$restartNonRootTaskName] = $restartNonRootTask
    $restartNonRootStopCount = $global:DysonDeploymentTaskFixtureStopCalls.Count
    $restartNonRootStartCount = $global:DysonDeploymentTaskFixtureStartCalls.Count
    $restartNonRootRejected = $false
    $restartNonRootError = $null
    try { Restart-DysonControlTask -TaskName $restartNonRootTaskName }
    catch {
        $restartNonRootError = $_.Exception.Message
        $restartNonRootRejected = $restartNonRootError -eq 'The fixed control-plane task is unavailable.'
    }
    Assert-SelfTest -Condition ($restartNonRootRejected -and $restartNonRootTask.State -eq 'Running' -and
        $global:DysonDeploymentTaskFixtureStopCalls.Count -eq $restartNonRootStopCount -and
        $global:DysonDeploymentTaskFixtureStartCalls.Count -eq $restartNonRootStartCount) `
        -Message ('Restart-DysonControlTask touched a unique task outside the fixed root task path; error: ' + $restartNonRootError)
    [void]$global:DysonDeploymentTaskFixture.Remove($restartNonRootTaskName)

    $restartAmbiguousTaskName = 'Dyson-Control-Plane-SelfTest-Restart-Ambiguous'
    $restartAmbiguousRootTask = [pscustomobject]@{
        FixtureTaskName = $restartAmbiguousTaskName
        TaskPath = '\'
        State = 'Running'
        Xml = '<Task><RegistrationInfo><Description>fictional root restart task</Description></RegistrationInfo></Task>'
        Principal = [pscustomobject]@{ UserId = 'fictional-restart-root'; LogonType = 'Interactive'; RunLevel = 'Limited' }
        Actions = @()
        Settings = [pscustomobject]@{ Enabled = $true }
    }
    $restartAmbiguousNonRootTask = [pscustomobject]@{
        FixtureTaskName = $restartAmbiguousTaskName
        TaskPath = '\FictionalFolder\'
        State = 'Ready'
        Xml = '<Task><RegistrationInfo><Description>fictional duplicate restart task</Description></RegistrationInfo></Task>'
        Principal = [pscustomobject]@{ UserId = 'fictional-restart-duplicate'; LogonType = 'Interactive'; RunLevel = 'Limited' }
        Actions = @()
        Settings = [pscustomobject]@{ Enabled = $true }
    }
    $global:DysonDeploymentTaskFixture[$restartAmbiguousTaskName] = @(
        $restartAmbiguousRootTask,
        $restartAmbiguousNonRootTask
    )
    $restartAmbiguousStopCount = $global:DysonDeploymentTaskFixtureStopCalls.Count
    $restartAmbiguousStartCount = $global:DysonDeploymentTaskFixtureStartCalls.Count
    $restartAmbiguousRejected = $false
    try { Restart-DysonControlTask -TaskName $restartAmbiguousTaskName }
    catch { $restartAmbiguousRejected = $_.Exception.Message -eq 'The fixed control-plane task identity is not unique.' }
    Assert-SelfTest -Condition ($restartAmbiguousRejected -and
        $restartAmbiguousRootTask.State -eq 'Running' -and $restartAmbiguousNonRootTask.State -eq 'Ready' -and
        $global:DysonDeploymentTaskFixtureStopCalls.Count -eq $restartAmbiguousStopCount -and
        $global:DysonDeploymentTaskFixtureStartCalls.Count -eq $restartAmbiguousStartCount) `
        -Message 'Restart-DysonControlTask touched same-name root and non-root tasks before rejecting ambiguity'
    [void]$global:DysonDeploymentTaskFixture.Remove($restartAmbiguousTaskName)

    $taskRemovalProbeName = 'Dyson-Control-Plane-SelfTest-Removal-Probe'
    $global:DysonDeploymentTaskFixture[$taskRemovalProbeName] = [pscustomobject]@{
        FixtureTaskName = $taskRemovalProbeName
        TaskPath = '\'
        State = 'Running'
        Xml = '<Task><RegistrationInfo><Description>fictional removal probe</Description></RegistrationInfo></Task>'
        Principal = [pscustomobject]@{ UserId = 'fictional-probe'; LogonType = 'Interactive'; RunLevel = 'Limited' }
        Actions = @()
        Settings = [pscustomobject]@{ Enabled = $true }
    }
    try { Remove-DysonControlTaskForRollback -TaskName $taskRemovalProbeName }
    catch { throw ('SELFTEST_FAILED: the scheduled-task removal fixture could not exercise compensation: ' + $_.Exception.Message) }
    Assert-SelfTest -Condition (-not $global:DysonDeploymentTaskFixture.ContainsKey($taskRemovalProbeName)) `
        -Message 'the scheduled-task removal helper did not verify fixture removal'

    $ambiguousTaskName = 'Dyson-Control-Plane-SelfTest-Ambiguous'
    $global:DysonDeploymentTaskFixture[$ambiguousTaskName] = @(
        [pscustomobject]@{
            FixtureTaskName = $ambiguousTaskName
            TaskPath = '\'
            State = 'Ready'
            Xml = '<Task><RegistrationInfo><Description>fictional ambiguous task one</Description></RegistrationInfo></Task>'
            Principal = [pscustomobject]@{ UserId = 'fictional-one'; LogonType = 'Interactive'; RunLevel = 'Limited' }
            Actions = @()
            Settings = [pscustomobject]@{ Enabled = $true }
        },
        [pscustomobject]@{
            FixtureTaskName = $ambiguousTaskName
            TaskPath = '\FictionalFolder\'
            State = 'Ready'
            Xml = '<Task><RegistrationInfo><Description>fictional ambiguous task two</Description></RegistrationInfo></Task>'
            Principal = [pscustomobject]@{ UserId = 'fictional-two'; LogonType = 'Interactive'; RunLevel = 'Limited' }
            Actions = @()
            Settings = [pscustomobject]@{ Enabled = $true }
        }
    )
    $ambiguousAclBefore = (Get-Acl -LiteralPath $installerData -ErrorAction Stop).Sddl
    $ambiguousAuditLength = (Get-Item -LiteralPath $taskAuditPath -ErrorAction Stop).Length
    $ambiguousTaskRejected = $false
    try {
        & $taskScript -InstallRoot $installerRoot -DataRoot $installerData -NodeExecutable $nodeFixtures.node24 `
            -TaskName $ambiguousTaskName -EnvironmentFile (Join-Path $installerData 'config\dyson-control.env') `
            -SelfTestSkipAdministratorCheck -Confirm:$false | Out-Null
    }
    catch { $ambiguousTaskRejected = $_.Exception.Message -eq 'The control-plane task identity is ambiguous.' }
    Assert-SelfTest -Condition $ambiguousTaskRejected `
        -Message 'the direct task installer did not reject duplicate task names across task paths'
    Assert-SelfTest -Condition ((Get-Acl -LiteralPath $installerData -ErrorAction Stop).Sddl -eq $ambiguousAclBefore -and
        (Get-Item -LiteralPath $taskAuditPath -ErrorAction Stop).Length -eq $ambiguousAuditLength) `
        -Message 'the ambiguous direct task install changed ACL or audit state before rejecting the task identity'
    [void]$global:DysonDeploymentTaskFixture.Remove($ambiguousTaskName)

    $nonRootTaskName = 'Dyson-Control-Plane-SelfTest-Non-Root'
    $nonRootTask = [pscustomobject]@{
        FixtureTaskName = $nonRootTaskName
        TaskPath = '\FictionalFolder\'
        State = 'Ready'
        Xml = '<Task><RegistrationInfo><Description>fictional non-root task</Description></RegistrationInfo></Task>'
        Principal = [pscustomobject]@{ UserId = 'fictional-non-root'; LogonType = 'Interactive'; RunLevel = 'Limited' }
        Actions = @()
        Settings = [pscustomobject]@{ Enabled = $true }
    }
    $global:DysonDeploymentTaskFixture[$nonRootTaskName] = $nonRootTask
    $nonRootAclBefore = (Get-Acl -LiteralPath $installerData -ErrorAction Stop).Sddl
    $nonRootAuditLength = (Get-Item -LiteralPath $taskAuditPath -ErrorAction Stop).Length
    $nonRootTaskRejected = $false
    try {
        & $taskScript -InstallRoot $installerRoot -DataRoot $installerData -NodeExecutable $nodeFixtures.node24 `
            -TaskName $nonRootTaskName -EnvironmentFile (Join-Path $installerData 'config\dyson-control.env') `
            -SelfTestSkipAdministratorCheck -Confirm:$false | Out-Null
    }
    catch { $nonRootTaskRejected = $_.Exception.Message -eq 'The control-plane task must use the fixed root task path.' }
    Assert-SelfTest -Condition $nonRootTaskRejected `
        -Message 'the direct task installer accepted a unique same-name task outside the fixed root task path'
    Assert-SelfTest -Condition ($global:DysonDeploymentTaskFixture[$nonRootTaskName] -eq $nonRootTask -and
        $nonRootTask.State -eq 'Ready' -and $nonRootTask.TaskPath -ceq '\FictionalFolder\' -and
        (Get-Acl -LiteralPath $installerData -ErrorAction Stop).Sddl -eq $nonRootAclBefore -and
        (Get-Item -LiteralPath $taskAuditPath -ErrorAction Stop).Length -eq $nonRootAuditLength) `
        -Message 'rejecting a non-root task changed its identity, ACL, or audit state'
    [void]$global:DysonDeploymentTaskFixture.Remove($nonRootTaskName)

    $directFailureTaskName = 'Dyson-Control-Plane-SelfTest-Direct-Failure'
    $directFailureTaskXml = '<Task><RegistrationInfo><Description>fictional direct-install preimage</Description></RegistrationInfo></Task>'
    $global:DysonDeploymentTaskFixture[$directFailureTaskName] = [pscustomobject]@{
        FixtureTaskName = $directFailureTaskName
        TaskPath = '\'
        State = 'Ready'
        Xml = $directFailureTaskXml
        Principal = [pscustomobject]@{ UserId = 'fictional-direct'; LogonType = 'Interactive'; RunLevel = 'Limited' }
        Actions = @()
        Settings = [pscustomobject]@{ Enabled = $true }
    }
    $directFailureAclBefore = (Get-Acl -LiteralPath $installerData -ErrorAction Stop).Sddl
    $global:DysonDeploymentTaskFixtureCorruptRegistrationFor = $directFailureTaskName
    $directTaskFailureObserved = $false
    $directTaskFailureError = $null
    try {
        & $taskScript -InstallRoot $installerRoot -DataRoot $installerData -NodeExecutable $nodeFixtures.node24 `
            -TaskName $directFailureTaskName -EnvironmentFile (Join-Path $installerData 'config\dyson-control.env') `
            -SelfTestSkipAdministratorCheck -Confirm:$false | Out-Null
    }
    catch {
        $directTaskFailureError = $_.Exception.Message
        $directTaskFailureObserved = $directTaskFailureError -eq 'The installed control-plane task did not match its fixed definition.'
    }
    finally { $global:DysonDeploymentTaskFixtureCorruptRegistrationFor = $null }
    Assert-SelfTest -Condition $directTaskFailureObserved `
        -Message ('the direct task installer did not preserve the fixed-definition failure after compensation; error: ' + $directTaskFailureError)
    Assert-SelfTest -Condition ($global:DysonDeploymentTaskFixture.ContainsKey($directFailureTaskName) -and
        $global:DysonDeploymentTaskFixture[$directFailureTaskName].Xml -ceq $directFailureTaskXml -and
        $global:DysonDeploymentTaskFixture[$directFailureTaskName].State -ne 'Running' -and
        (Get-Acl -LiteralPath $installerData -ErrorAction Stop).Sddl -eq $directFailureAclBefore) `
        -Message 'the direct task installer did not restore its task and ACL preimages after pre-receipt failure'

    $existingTaskName = 'Dyson-Control-Plane-SelfTest-Existing'
    $existingTaskXml = '<Task><RegistrationInfo><Description>fictional previous task</Description></RegistrationInfo></Task>'
    $global:DysonDeploymentTaskFixture[$existingTaskName] = [pscustomobject]@{
        FixtureTaskName = $existingTaskName
        TaskPath = '\'
        State = 'Running'
        Xml = $existingTaskXml
        Principal = [pscustomobject]@{ UserId = 'fictional-previous'; LogonType = 'Interactive'; RunLevel = 'Limited' }
        Actions = @()
        Settings = [pscustomobject]@{ Enabled = $true }
    }
    $existingPointerPath = Join-Path $taskRollbackExistingData 'state\active-release.json'
    $existingPointerBefore = [System.IO.File]::ReadAllText($existingPointerPath, [System.Text.Encoding]::UTF8)
    $existingAclBefore = (Get-Acl -LiteralPath $taskRollbackExistingData -ErrorAction Stop).Sddl
    $existingTaskRollbackObserved = $false
    $existingTaskRollbackError = $null
    try {
        & $installScript -SourcePath $payloadInstaller -Version '2.0.0' -NodeExecutable $nodeFixtures.node24 `
            -InstallRoot $taskRollbackExistingRoot -DataRoot $taskRollbackExistingData `
            -ConfigurationSource $installerConfig -RegisterStartupTask -StartAfterInstall `
            -TaskName $existingTaskName -ReadinessUri $closedReadinessUri -ReadinessTimeoutSeconds 1 `
            -SelfTestSkipAdministratorCheck -Confirm:$false | Out-Null
    }
    catch {
        $existingTaskRollbackObserved = $true
        $existingTaskRollbackError = $_.Exception.Message
    }
    Assert-SelfTest -Condition $existingTaskRollbackObserved `
        -Message 'a post-task readiness failure did not fail the installer'
    Assert-SelfTest -Condition ($global:DysonDeploymentTaskFixture.ContainsKey($existingTaskName) -and
        $global:DysonDeploymentTaskFixture[$existingTaskName].Xml -ceq $existingTaskXml -and
        $global:DysonDeploymentTaskFixture[$existingTaskName].State -eq 'Running') `
        -Message ('a post-task readiness failure did not restore the previous task definition and running state; installer error: ' + $existingTaskRollbackError)
    Assert-SelfTest -Condition ([System.IO.File]::ReadAllText($existingPointerPath, [System.Text.Encoding]::UTF8) -ceq $existingPointerBefore -and
        (Get-ActiveVersionAt -DataRoot $taskRollbackExistingData) -eq '1.0.0') `
        -Message 'the existing-task rollback changed the pre-install active release pointer'
    Assert-SelfTest -Condition ((Get-Acl -LiteralPath $taskRollbackExistingData -ErrorAction Stop).Sddl -eq $existingAclBefore) `
        -Message 'the existing-task rollback did not restore the deployment data ACL'
    Assert-SelfTest -Condition (-not (Test-Path -LiteralPath (Join-Path $taskRollbackExistingData 'config\dyson-control.env'))) `
        -Message 'the existing-task rollback retained configuration created by the failed wrapper'
    Assert-NoInstallPartials -InstallRoot $taskRollbackExistingRoot -DataRoot $taskRollbackExistingData `
        -Message 'the existing-task rollback left a partial deployment directory'

    $newTaskName = 'Dyson-Control-Plane-SelfTest-New'
    $newPointerPath = Join-Path $taskRollbackNewData 'state\active-release.json'
    $newPointerBefore = [System.IO.File]::ReadAllText($newPointerPath, [System.Text.Encoding]::UTF8)
    $newAclBefore = (Get-Acl -LiteralPath $taskRollbackNewData -ErrorAction Stop).Sddl
    $newTaskRollbackObserved = $false
    try {
        & $installScript -SourcePath $payloadInstaller -Version '2.0.0' -NodeExecutable $nodeFixtures.node24 `
            -InstallRoot $taskRollbackNewRoot -DataRoot $taskRollbackNewData `
            -ConfigurationSource $installerConfig -RegisterStartupTask -StartAfterInstall `
            -TaskName $newTaskName -ReadinessUri $closedReadinessUri -ReadinessTimeoutSeconds 1 `
            -SelfTestSkipAdministratorCheck -Confirm:$false | Out-Null
    }
    catch { $newTaskRollbackObserved = $true }
    Assert-SelfTest -Condition $newTaskRollbackObserved `
        -Message 'a post-new-task readiness failure did not fail the installer'
    Assert-SelfTest -Condition (-not $global:DysonDeploymentTaskFixture.ContainsKey($newTaskName)) `
        -Message 'a post-task readiness failure did not remove the newly created task'
    Assert-SelfTest -Condition ([System.IO.File]::ReadAllText($newPointerPath, [System.Text.Encoding]::UTF8) -ceq $newPointerBefore -and
        (Get-ActiveVersionAt -DataRoot $taskRollbackNewData) -eq '1.0.0') `
        -Message 'the new-task rollback changed the pre-install active release pointer'
    Assert-SelfTest -Condition ((Get-Acl -LiteralPath $taskRollbackNewData -ErrorAction Stop).Sddl -eq $newAclBefore) `
        -Message 'the new-task rollback did not restore the deployment data ACL'
    Assert-SelfTest -Condition (-not (Test-Path -LiteralPath (Join-Path $taskRollbackNewData 'config\dyson-control.env'))) `
        -Message 'the new-task rollback retained configuration created by the failed wrapper'
    Assert-NoInstallPartials -InstallRoot $taskRollbackNewRoot -DataRoot $taskRollbackNewData `
        -Message 'the new-task rollback left a partial deployment directory'

    $removalFailureTaskName = 'Dyson-Control-Plane-SelfTest-Removal-Failure'
    $global:DysonDeploymentTaskFixtureFailRemovalFor = $removalFailureTaskName
    $removalFailureObserved = $false
    $removalFailureError = $null
    try {
        & $installScript -SourcePath $payloadInstaller -Version '2.0.0' -NodeExecutable $nodeFixtures.node24 `
            -InstallRoot $taskRemovalFailureRoot -DataRoot $taskRemovalFailureData `
            -ConfigurationSource $installerConfig -RegisterStartupTask -StartAfterInstall `
            -TaskName $removalFailureTaskName -ReadinessUri $closedReadinessUri -ReadinessTimeoutSeconds 1 `
            -SelfTestSkipAdministratorCheck -Confirm:$false | Out-Null
    }
    catch {
        $removalFailureObserved = $true
        $removalFailureError = $_.Exception.Message
    }
    finally { $global:DysonDeploymentTaskFixtureFailRemovalFor = $null }
    Assert-SelfTest -Condition ($removalFailureObserved -and
        $removalFailureError -match 'replacement-task-stop-remove' -and
        $removalFailureError -match 'deployment-state-blocked-by-task' -and
        $removalFailureError -match 'bootstrap-configuration-blocked' -and
        $removalFailureError -match 'previous-task-restore-blocked') `
        -Message 'a replacement-task removal failure did not report every blocked compensation phase'
    Assert-SelfTest -Condition ($global:DysonDeploymentTaskFixture.ContainsKey($removalFailureTaskName) -and
        $global:DysonDeploymentTaskFixture[$removalFailureTaskName].State -eq 'Running' -and
        $global:DysonDeploymentTaskFixture[$removalFailureTaskName].Xml -match 'fixture replacement task') `
        -Message 'a replacement-task removal failure did not retain the running replacement task'
    Assert-SelfTest -Condition ((Get-ActiveVersionAt -DataRoot $taskRemovalFailureData) -eq '2.0.0' -and
        (Test-Path -LiteralPath (Join-Path $taskRemovalFailureRoot 'releases\2.0.0') -PathType Container) -and
        (Test-Path -LiteralPath (Join-Path $taskRemovalFailureRoot 'bootstrap\Start-DysonControl.ps1') -PathType Leaf) -and
        (Test-Path -LiteralPath (Join-Path $taskRemovalFailureData 'config\dyson-control.env') -PathType Leaf)) `
        -Message 'a replacement-task removal failure destructively rolled back release, bootstrap, or configuration state'
    Assert-NoInstallPartials -InstallRoot $taskRemovalFailureRoot -DataRoot $taskRemovalFailureData `
        -Message 'the fail-safe task removal path left a partial deployment directory'

    $wrapperPointerPath = Join-Path $wrapperLockData 'state\active-release.json'
    $wrapperPointerBefore = [System.IO.File]::ReadAllText($wrapperPointerPath, [System.Text.Encoding]::UTF8)
    $wrapperLock = Enter-DysonDeploymentLock -DataRoot $wrapperLockData -TimeoutSeconds 1
    $wrapperLockRejected = $false
    try {
        try {
            & $installScript -SourcePath $payloadInstaller -Version '2.0.0' -NodeExecutable $nodeFixtures.node24 `
                -InstallRoot $wrapperLockRoot -DataRoot $wrapperLockData -ConfigurationSource $installerConfig `
                -LockTimeoutSeconds 1 -Confirm:$false | Out-Null
        }
        catch { $wrapperLockRejected = $_.Exception.Message -eq 'Another deployment operation still owns the deployment lock.' }
    }
    finally { $wrapperLock.Dispose() }
    Assert-SelfTest -Condition $wrapperLockRejected -Message 'the outer installer transaction did not reject a concurrent owner'
    Assert-SelfTest -Condition ([System.IO.File]::ReadAllText($wrapperPointerPath, [System.Text.Encoding]::UTF8) -ceq $wrapperPointerBefore -and
        (Get-ActiveVersionAt -DataRoot $wrapperLockData) -eq '1.0.0') `
        -Message 'the lock-rejected wrapper changed the active release pointer'
    Assert-SelfTest -Condition (-not (Test-Path -LiteralPath (Join-Path $wrapperLockRoot 'releases\2.0.0')) -and
        -not (Test-Path -LiteralPath (Join-Path $wrapperLockData 'config\dyson-control.env'))) `
        -Message 'the lock-rejected wrapper staged a release or copied configuration'
    Assert-NoInstallPartials -InstallRoot $wrapperLockRoot -DataRoot $wrapperLockData `
        -Message 'the lock-rejected wrapper left a partial deployment directory'

    $uninstallLockPointerBefore = [System.IO.File]::ReadAllText($wrapperPointerPath, [System.Text.Encoding]::UTF8)
    $uninstallLockAuditPath = Join-Path $wrapperLockData 'audit\deployment.jsonl'
    $uninstallLockAuditLengthBefore = (Get-Item -LiteralPath $uninstallLockAuditPath -ErrorAction Stop).Length
    $uninstallLock = Enter-DysonDeploymentLock -DataRoot $wrapperLockData -TimeoutSeconds 1
    $uninstallLockRejected = $false
    try {
        try {
            & $uninstallScript -InstallRoot $wrapperLockRoot -DataRoot $wrapperLockData `
                -SkipTaskRemoval -LockTimeoutSeconds 1 -Confirm:$false | Out-Null
        }
        catch { $uninstallLockRejected = $_.Exception.Message -eq 'Another deployment operation still owns the deployment lock.' }
    }
    finally { $uninstallLock.Dispose() }
    Assert-SelfTest -Condition $uninstallLockRejected `
        -Message 'the uninstaller did not reject a concurrent deployment-lock owner'
    Assert-SelfTest -Condition ((Test-Path -LiteralPath $wrapperLockRoot -PathType Container) -and
        [System.IO.File]::ReadAllText($wrapperPointerPath, [System.Text.Encoding]::UTF8) -ceq $uninstallLockPointerBefore -and
        (Get-Item -LiteralPath $uninstallLockAuditPath -ErrorAction Stop).Length -eq $uninstallLockAuditLengthBefore) `
        -Message 'the lock-rejected uninstaller changed install, pointer, or audit state'

    $uninstallRollbackTaskName = 'Dyson-Control-Plane-SelfTest-Uninstall-Rollback'
    $uninstallRollbackTaskXml = '<Task><RegistrationInfo><Description>fictional uninstall rollback preimage</Description></RegistrationInfo></Task>'
    $global:DysonDeploymentTaskFixture[$uninstallRollbackTaskName] = [pscustomobject]@{
        FixtureTaskName = $uninstallRollbackTaskName
        TaskPath = '\'
        State = 'Running'
        Xml = $uninstallRollbackTaskXml
        Principal = [pscustomobject]@{ UserId = 'fictional-uninstall-rollback'; LogonType = 'Interactive'; RunLevel = 'Limited' }
        Actions = @()
        Settings = [pscustomobject]@{ Enabled = $true }
    }
    $uninstallRollbackPointerPath = Join-Path $wrapperLockData 'state\active-release.json'
    $uninstallRollbackPointerBefore = [System.IO.File]::ReadAllText(
        $uninstallRollbackPointerPath,
        [System.Text.Encoding]::UTF8
    )

    $unregisterFailureStopCount = $global:DysonDeploymentTaskFixtureStopCalls.Count
    $unregisterFailureStartCount = $global:DysonDeploymentTaskFixtureStartCalls.Count
    $unregisterFailureUnregisterCount = $global:DysonDeploymentTaskFixtureUnregisterCalls.Count
    $global:DysonDeploymentTaskFixtureFailUnregisterOnceFor = $uninstallRollbackTaskName
    $unregisterFailureObserved = $false
    try {
        & $uninstallScript -InstallRoot $wrapperLockRoot -DataRoot $wrapperLockData `
            -TaskName $uninstallRollbackTaskName -SelfTestSkipAdministratorCheck -Confirm:$false | Out-Null
    }
    catch { $unregisterFailureObserved = $_.Exception.Message -eq 'fixture refused the first unregister attempt' }
    finally { $global:DysonDeploymentTaskFixtureFailUnregisterOnceFor = $null }
    Assert-SelfTest -Condition ($unregisterFailureObserved -and
        $global:DysonDeploymentTaskFixture.ContainsKey($uninstallRollbackTaskName) -and
        $global:DysonDeploymentTaskFixture[$uninstallRollbackTaskName].TaskPath -ceq '\' -and
        $global:DysonDeploymentTaskFixture[$uninstallRollbackTaskName].Xml -ceq $uninstallRollbackTaskXml -and
        $global:DysonDeploymentTaskFixture[$uninstallRollbackTaskName].State -eq 'Running') `
        -Message 'uninstall did not restore the root task XML and Running state after Stop succeeded and Unregister failed'
    Assert-SelfTest -Condition ($global:DysonDeploymentTaskFixtureStopCalls.Count -eq ($unregisterFailureStopCount + 1) -and
        $global:DysonDeploymentTaskFixtureStartCalls.Count -eq ($unregisterFailureStartCount + 1) -and
        $global:DysonDeploymentTaskFixtureUnregisterCalls.Count -eq ($unregisterFailureUnregisterCount + 2)) `
        -Message 'the unregister-failure fixture did not exercise stop, failed unregister, removal retry, and restart'
    Assert-SelfTest -Condition ((Test-Path -LiteralPath $wrapperLockRoot -PathType Container) -and
        [System.IO.File]::ReadAllText($uninstallRollbackPointerPath, [System.Text.Encoding]::UTF8) -ceq $uninstallRollbackPointerBefore -and
        (Get-ActiveVersionAt -DataRoot $wrapperLockData) -eq '1.0.0') `
        -Message 'an unregister failure changed the install root or active release pointer'

    $uninstallReleaseBackupBlocker = Join-Path $wrapperLockData 'snapshots\uninstall-releases'
    [System.IO.File]::WriteAllText(
        $uninstallReleaseBackupBlocker,
        'fictional file that blocks creation of the uninstall release-backup directory',
        [System.Text.UTF8Encoding]::new($false)
    )
    $postRemovalFailureStopCount = $global:DysonDeploymentTaskFixtureStopCalls.Count
    $postRemovalFailureStartCount = $global:DysonDeploymentTaskFixtureStartCalls.Count
    $postRemovalFailureUnregisterCount = $global:DysonDeploymentTaskFixtureUnregisterCalls.Count
    $postRemovalFailureObserved = $false
    try {
        & $uninstallScript -InstallRoot $wrapperLockRoot -DataRoot $wrapperLockData `
            -TaskName $uninstallRollbackTaskName -SelfTestSkipAdministratorCheck -Confirm:$false | Out-Null
    }
    catch { $postRemovalFailureObserved = $true }
    Assert-SelfTest -Condition ($postRemovalFailureObserved -and
        $global:DysonDeploymentTaskFixture.ContainsKey($uninstallRollbackTaskName) -and
        $global:DysonDeploymentTaskFixture[$uninstallRollbackTaskName].TaskPath -ceq '\' -and
        $global:DysonDeploymentTaskFixture[$uninstallRollbackTaskName].Xml -ceq $uninstallRollbackTaskXml -and
        $global:DysonDeploymentTaskFixture[$uninstallRollbackTaskName].State -eq 'Running') `
        -Message 'uninstall did not restore the root task XML and Running state after a post-removal failure'
    Assert-SelfTest -Condition ($global:DysonDeploymentTaskFixtureStopCalls.Count -eq ($postRemovalFailureStopCount + 1) -and
        $global:DysonDeploymentTaskFixtureStartCalls.Count -eq ($postRemovalFailureStartCount + 1) -and
        $global:DysonDeploymentTaskFixtureUnregisterCalls.Count -eq ($postRemovalFailureUnregisterCount + 1)) `
        -Message 'the post-removal failure fixture did not delete and then restore the root task'
    Assert-SelfTest -Condition ((Test-Path -LiteralPath $wrapperLockRoot -PathType Container) -and
        [System.IO.File]::ReadAllText($uninstallRollbackPointerPath, [System.Text.Encoding]::UTF8) -ceq $uninstallRollbackPointerBefore -and
        (Get-ActiveVersionAt -DataRoot $wrapperLockData) -eq '1.0.0' -and
        (Test-Path -LiteralPath $uninstallReleaseBackupBlocker -PathType Leaf)) `
        -Message 'a post-task-removal uninstall failure changed deployment state or consumed its failure fixture'

    $uninstallSuccessTaskName = 'Dyson-Control-Plane-SelfTest-Uninstall-Success'
    $uninstallSuccessTaskXml = '<Task><RegistrationInfo><Description>fictional successful uninstall task</Description></RegistrationInfo></Task>'
    $global:DysonDeploymentTaskFixture[$uninstallSuccessTaskName] = [pscustomobject]@{
        FixtureTaskName = $uninstallSuccessTaskName
        TaskPath = '\'
        State = 'Running'
        Xml = $uninstallSuccessTaskXml
        Principal = [pscustomobject]@{ UserId = 'fictional-uninstall-success'; LogonType = 'Interactive'; RunLevel = 'Limited' }
        Actions = @()
        Settings = [pscustomobject]@{ Enabled = $true }
    }
    $uninstallPersistentDataBefore = [System.IO.File]::ReadAllText(
        $launcherResultPath,
        [System.Text.Encoding]::UTF8
    )
    $uninstallActivePointerBefore = [System.IO.File]::ReadAllText(
        (Join-Path $installerData 'state\active-release.json'),
        [System.Text.Encoding]::UTF8
    )
    $uninstallOutput = & $uninstallScript -InstallRoot $installerRoot -DataRoot $installerData `
        -TaskName $uninstallSuccessTaskName -SelfTestSkipAdministratorCheck -Confirm:$false
    $uninstallResult = ($uninstallOutput | Out-String).Trim() | ConvertFrom-Json
    Assert-SelfTest -Condition ($uninstallResult.state -eq 'uninstalled' -and [bool]$uninstallResult.taskRemoved -and
        -not $global:DysonDeploymentTaskFixture.ContainsKey($uninstallSuccessTaskName)) `
        -Message 'the reusable uninstaller did not remove its fixed root task'
    Assert-SelfTest -Condition (-not (Test-Path -LiteralPath $installerRoot)) -Message 'uninstall left the active Program Files layout in place'
    Assert-SelfTest -Condition ((Test-Path -LiteralPath $installerData -PathType Container) -and
        (Test-Path -LiteralPath $launcherResultPath -PathType Leaf) -and
        [System.IO.File]::ReadAllText($launcherResultPath, [System.Text.Encoding]::UTF8) -ceq $uninstallPersistentDataBefore) `
        -Message 'uninstall did not preserve persistent user data byte-for-byte'
    Assert-SelfTest -Condition ((Test-Path -LiteralPath ([string]$uninstallResult.recoverableReleaseBackup) -PathType Container) -and
        (Test-Path -LiteralPath (Join-Path ([string]$uninstallResult.recoverableReleaseBackup) 'releases\2.0.0\release-manifest.json') -PathType Leaf) -and
        (Test-Path -LiteralPath (Join-Path ([string]$uninstallResult.recoverableReleaseBackup) 'bootstrap\Start-DysonControl.ps1') -PathType Leaf)) `
        -Message 'uninstall did not retain a structurally recoverable release backup'
    Assert-SelfTest -Condition (-not (Test-Path -LiteralPath (Join-Path $installerData 'state\active-release.json'))) -Message 'uninstall left a stale active-release pointer'
    Assert-SelfTest -Condition ((Test-Path -LiteralPath ([string]$uninstallResult.activePointerBackup) -PathType Leaf) -and
        [System.IO.File]::ReadAllText(
            [string]$uninstallResult.activePointerBackup,
            [System.Text.Encoding]::UTF8
        ) -ceq $uninstallActivePointerBefore) -Message 'uninstall did not retain the exact active pointer for rollback'
    Assert-SelfTest -Condition (Test-Path -LiteralPath ([string]$uninstallResult.taskDefinitionBackup) -PathType Leaf) `
        -Message 'uninstall did not retain the fixed root task definition for recovery'
    Assert-SelfTest -Condition ([System.IO.File]::ReadAllText(
        [string]$uninstallResult.taskDefinitionBackup,
        [System.Text.Encoding]::UTF8
    ) -ceq $uninstallSuccessTaskXml) -Message 'the recoverable task snapshot does not match the removed root task XML'

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
        taskReadinessFailureRestoredPreviousTask = $true
        taskReadinessFailureRemovedNewTask = $true
        taskReadinessFailureRestoredAcl = $true
        ambiguousTaskIdentityRejectedBeforeMutation = $true
        nonRootTaskIdentityRejectedBeforeMutation = $true
        schedulerQueryFailureRejectedBeforeMutation = $true
        restartRejectedNonRootWithoutMutation = $true
        restartRejectedAmbiguousWithoutMutation = $true
        directTaskFailureRestoredTaskAndAcl = $true
        taskRemovalFailureBlockedDestructiveRollback = $true
        outerInstallLockValidated = $true
        uninstallLockValidated = $true
        failedInstallLeftNoPartialOrActiveDrift = $true
        successfulInstallReceiptWasRedacted = $true
        uninstallUnregisterFailureRestoredTask = $true
        uninstallPostRemovalFailureRestoredTask = $true
        uninstallRemovedRootTaskWithRecoveryAssets = $true
        uninstallPreservedData = $true
        uninstallWasRecoverable = $true
    } | ConvertTo-Json -Depth 5 -Compress
}
finally {
    if ($taskFixtureEnabled) { Disable-DysonTaskSchedulerFixture }
    Remove-Item Env:DYSON_DEPLOYMENT_ALLOW_SELFTEST_TASKS -ErrorAction SilentlyContinue
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
