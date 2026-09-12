[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
. (Join-Path $PSScriptRoot 'DysonDeployment.Common.ps1')
. (Join-Path $PSScriptRoot '..\lifecycle-broker\DysonLifecycleBroker.Common.ps1')

function Assert-DeploymentStatusFixture {
    param([Parameter(Mandatory)][bool]$Condition, [Parameter(Mandatory)][string]$Message)
    if (-not $Condition) { throw "DEPLOYMENT_STATUS_SELFTEST_FAILED: $Message" }
}

function Test-DeploymentStatusRejected {
    param([Parameter(Mandatory)][scriptblock]$Operation)
    try { [void](& $Operation); return $false }
    catch { return $true }
}

function Get-ScheduledTask {
    [CmdletBinding()]
    param([string]$TaskName, [string]$TaskPath)

    $matches = @($script:deploymentStatusTasks)
    if ($PSBoundParameters.ContainsKey('TaskName')) {
        $matches = @($matches | Where-Object { [string]$_.TaskName -ceq $TaskName })
    }
    if ($PSBoundParameters.ContainsKey('TaskPath')) {
        $matches = @($matches | Where-Object { [string]$_.TaskPath -ceq $TaskPath })
    }
    return @($matches)
}

function Write-DeploymentStatusEnvironment {
    param(
        [Parameter(Mandatory)][bool]$Enabled,
        [Parameter(Mandatory)][string]$EnvironmentFile,
        [Parameter(Mandatory)][string]$ProfileFile,
        [Parameter(Mandatory)][string]$ProjectRoot,
        [Parameter(Mandatory)][string]$ApplicationData
    )

    $lines = @(
        'NODE_ENV=production',
        'DYSON_PROVIDER=windows',
        ('DYSON_LIFECYCLE_ENABLED=' + $(if ($Enabled) { 'true' } else { 'false' })),
        ('DYSON_LIFECYCLE_BROKER_PROFILE_FILE=' + $ProfileFile),
        ('DYSON_PROJECT_ROOT=' + $ProjectRoot),
        ('DYSON_DATA_DIR=' + $ApplicationData),
        'DYSON_RUNTIME_SERVICE_USER=EXAMPLE\DysonGame',
        'DYSON_GAME_PORT=8469'
    )
    [System.IO.File]::WriteAllText(
        $EnvironmentFile,
        ($lines -join "`n") + "`n",
        [System.Text.UTF8Encoding]::new($false)
    )
}

function Assert-DeploymentReadinessHttpBudget {
    Assert-DeploymentStatusFixture (-not (Test-DeploymentStatusRejected { $true })) `
        'the rejection helper mistook successful output for a rejected operation'
    Add-Type -TypeDefinition @'
using System;
using System.IO;
using System.Net;
using System.Net.Sockets;
using System.Text;
using System.Threading;
public sealed class DysonDeploymentReadinessFixture : IDisposable {
    readonly TcpListener listener = new TcpListener(IPAddress.Loopback, 0);
    readonly ManualResetEvent stopped = new ManualResetEvent(false);
    readonly Thread worker;
    readonly int delay;
    readonly string response;
    TcpClient current;
    public int Port { get; private set; }
    public int Requests;
    public DysonDeploymentReadinessFixture(int delayMilliseconds, string version, string body) {
        delay = delayMilliseconds;
        response = "HTTP/1.1 200 OK\r\nConnection: close\r\nContent-Type: application/json\r\n" +
            "X-Dyson-Control-Release: " + version + "\r\nContent-Length: " +
            Encoding.UTF8.GetByteCount(body) + "\r\n\r\n" + body;
        listener.Start(); Port = ((IPEndPoint)listener.LocalEndpoint).Port;
        worker = new Thread(Run); worker.IsBackground = true; worker.Start();
    }
    void Run() {
        while (!stopped.WaitOne(0)) {
            try {
                using (var client = listener.AcceptTcpClient()) {
                    current = client;
                    using (var stream = client.GetStream()) {
                        stream.ReadTimeout = 5000;
                        var reader = new StreamReader(stream, Encoding.ASCII, false, 1024, true);
                        string line;
                        while ((line = reader.ReadLine()) != null && line.Length != 0) {}
                        Interlocked.Increment(ref Requests);
                        if (stopped.WaitOne(delay)) return;
                        var bytes = Encoding.UTF8.GetBytes(response);
                        stream.Write(bytes, 0, bytes.Length); stream.Flush();
                    }
                }
            } catch { if (stopped.WaitOne(0)) return; }
            finally { current = null; }
        }
    }
    public void Dispose() {
        stopped.Set(); listener.Stop();
        var client = current; if (client != null) client.Close();
        worker.Join(2000);
    }
}
'@
    $validBody = '{"status":"ready","deploymentVersion":"1.0.0","checks":{"api":"pass","storage":"pass","lifecycleBroker":"pass"}}'
    $server = [DysonDeploymentReadinessFixture]::new(2500, '1.0.0', $validBody)
    try {
        $timer = [Diagnostics.Stopwatch]::StartNew()
        $healthy = Test-DysonLoopbackReadiness -ReadinessUri ('http://127.0.0.1:' + $server.Port + '/readyz') `
            -ExpectedVersion '1.0.0' -RequiredChecks lifecycleBroker -TimeoutSeconds 8
        Assert-DeploymentStatusFixture ($healthy -and $timer.ElapsedMilliseconds -ge 2400 -and
            $timer.ElapsedMilliseconds -lt 8000 -and $server.Requests -eq 1) `
            'a valid readiness response slower than two seconds was not accepted within its total budget'
    }
    finally { $server.Dispose() }
    $server = [DysonDeploymentReadinessFixture]::new(3500, '1.0.0', $validBody)
    try {
        $timer = [Diagnostics.Stopwatch]::StartNew()
        $rejected = Test-DeploymentStatusRejected {
            Test-DysonLoopbackReadiness -ReadinessUri ('http://127.0.0.1:' + $server.Port + '/readyz') `
                -ExpectedVersion '1.0.0' -RequiredChecks lifecycleBroker -TimeoutSeconds 1
        }
        # TimeoutSec has whole-second precision; allow bounded cancellation and
        # scheduler overhead, but never wait for the valid 3.5-second response.
        Assert-DeploymentStatusFixture ($rejected -and $server.Requests -ge 1 -and
            $timer.ElapsedMilliseconds -ge 900 -and $timer.ElapsedMilliseconds -lt 3000) `
            'readiness exceeded its overall failure budget or accepted a late response'
    }
    finally { $server.Dispose() }
    foreach ($invalid in @(
        @{ header = '1.0.1'; body = $validBody },
        @{ header = '1.0.0'; body = $validBody.Replace('"deploymentVersion":"1.0.0"', '"deploymentVersion":"1.0.1"') },
        @{ header = '1.0.0'; body = $validBody.Replace('"status":"ready"', '"status":"starting"') },
        @{ header = '1.0.0'; body = $validBody.Replace('"lifecycleBroker":"pass"', '"lifecycleBroker":"fail"') },
        @{ header = '1.0.0'; body = $validBody.Replace('"lifecycleBroker":"pass"', '"other":"pass"') }
    )) {
        $server = [DysonDeploymentReadinessFixture]::new(0, $invalid.header, $invalid.body)
        try {
            Assert-DeploymentStatusFixture (Test-DeploymentStatusRejected {
                Test-DysonLoopbackReadiness -ReadinessUri ('http://127.0.0.1:' + $server.Port + '/readyz') `
                    -ExpectedVersion '1.0.0' -RequiredChecks lifecycleBroker -TimeoutSeconds 1
            }) 'readiness accepted a wrong version, header, status or required check'
        }
        finally { $server.Dispose() }
    }
    & {
        # Model a client returning after a timeout boundary despite cancellation.
        function Invoke-WebRequest {
            param($Uri, [switch]$UseBasicParsing, [int]$TimeoutSec, $ErrorAction)
            Start-Sleep -Milliseconds 1200
            [pscustomobject]@{ StatusCode = 200; Content = $validBody; Headers = @{ 'X-Dyson-Control-Release' = '1.0.0' } }
        }
        Assert-DeploymentStatusFixture (Test-DeploymentStatusRejected {
            Test-DysonLoopbackReadiness -ReadinessUri 'http://127.0.0.1:1/readyz' `
                -ExpectedVersion '1.0.0' -TimeoutSeconds 1
        }) 'readiness accepted a response returned after its overall deadline'
    }
}

$temporaryBase = [System.IO.Path]::GetFullPath([System.IO.Path]::GetTempPath()).TrimEnd('\', '/')
$testRoot = Join-Path $temporaryBase ('dyson-deployment-status-selftest-' + [guid]::NewGuid().ToString('N'))
$installRoot = Join-Path $testRoot 'program-files\DysonControl'
$dataRoot = Join-Path $testRoot 'program-data\DysonControl'
$applicationData = Join-Path $dataRoot 'data'
$environmentFile = Join-Path $dataRoot 'config\dyson-control.env'
$releaseRoot = Join-Path $installRoot 'releases\1.0.0'
$windowsRoot = Join-Path $releaseRoot 'scripts\windows'
$brokerScriptRoot = Join-Path $windowsRoot 'lifecycle-broker'
$bootstrapRoot = Join-Path $installRoot 'bootstrap'
$brokerRoot = Join-Path $applicationData 'lifecycle-broker'
$profileFile = Join-Path $brokerRoot 'broker-profile.json'
$projectRoot = Join-Path $testRoot 'fictional-project'
$driftedProjectRoot = Join-Path $testRoot 'fictional-project-drifted'
$script:deploymentStatusTasks = @()

try {
    foreach ($directory in @(
        (Split-Path -Parent $environmentFile), $brokerScriptRoot, $bootstrapRoot,
        (Join-Path $brokerRoot 'requests'), (Join-Path $brokerRoot 'intents'),
        (Join-Path $brokerRoot 'receipts'), (Join-Path $projectRoot 'server'),
        (Join-Path $projectRoot 'run'), $driftedProjectRoot
    )) {
        [void][System.IO.Directory]::CreateDirectory($directory)
    }
    [System.IO.File]::WriteAllBytes((Join-Path $projectRoot 'server\DSPGAME.exe'), [byte[]]@(0))

    foreach ($name in @(
        'DysonLifecycleBroker.Common.ps1', 'DysonLifecycleBroker.TaskAcl.ps1',
        'Install-DysonLifecycleBrokerTask.ps1', 'Invoke-DysonLifecycleBrokerWorker.ps1',
        'Submit-DysonLifecycleBrokerRequest.ps1'
    )) {
        Copy-Item -LiteralPath (Join-Path $PSScriptRoot ('..\lifecycle-broker\' + $name)) `
            -Destination (Join-Path $brokerScriptRoot $name) -Force
    }
    Copy-Item -LiteralPath (Join-Path $PSScriptRoot '..\DysonHostMutationLease.Common.ps1') `
        -Destination (Join-Path $windowsRoot 'DysonHostMutationLease.Common.ps1') -Force
    foreach ($name in @('Start-DysonServer.ps1', 'Stop-DysonServer.ps1')) {
        Copy-Item -LiteralPath (Join-Path $PSScriptRoot ('..\bootstrap\' + $name)) `
            -Destination (Join-Path $bootstrapRoot $name) -Force
    }

    $powerShell = [System.IO.Path]::GetFullPath(
        (Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe')
    ).ToLowerInvariant()
    $controlTaskArguments = '-fixture-complete-control-task-contract'
    $validControlTask = [pscustomobject][ordered]@{
        TaskName = 'Dyson-Control-Plane'
        TaskPath = '\'
        State = 'Running'
        Actions = @([pscustomobject][ordered]@{
            Execute = $powerShell; Arguments = $controlTaskArguments; WorkingDirectory = ''
        })
        Principal = [pscustomobject][ordered]@{
            UserId = 'S-1-5-19'; LogonType = 'ServiceAccount'; RunLevel = 'Limited'
        }
        Triggers = @([pscustomobject][ordered]@{ Kind = 'AtStartup'; Enabled = $true })
        Settings = [pscustomobject][ordered]@{
            Enabled = $true; MultipleInstances = 'IgnoreNew'; RestartCount = 5
            RestartInterval = 'PT1M'; ExecutionTimeLimit = 'PT0S'; StartWhenAvailable = $true
        }
    }
    [void](Assert-DysonControlTaskContract -Task $validControlTask `
        -TaskName 'Dyson-Control-Plane' -ExpectedPowerShellExecutable $powerShell `
        -ExpectedArguments $controlTaskArguments -AllowedStates @('Running'))
    $controlTaskDrifts = @(
        { param($task) $task.Principal.UserId = 'S-1-5-18' },
        { param($task) $task.Principal.RunLevel = 'Highest' },
        { param($task) $task.Triggers[0].Kind = 'AtLogon' },
        { param($task) $task.Settings.Enabled = $false },
        { param($task) $task.Settings.MultipleInstances = 'Parallel' },
        { param($task) $task.Settings.RestartCount = 4 },
        { param($task) $task.Settings.RestartInterval = 'PT2M' },
        { param($task) $task.Settings.ExecutionTimeLimit = 'PT5M' },
        { param($task) $task.Settings.StartWhenAvailable = $false },
        { param($task) $task.State = 'Ready' }
    )
    foreach ($mutate in $controlTaskDrifts) {
        $driftedControlTask = ($validControlTask | ConvertTo-Json -Depth 8 -Compress) |
            ConvertFrom-Json -ErrorAction Stop
        & $mutate $driftedControlTask
        Assert-DeploymentStatusFixture -Condition (Test-DeploymentStatusRejected {
            [void](Assert-DysonControlTaskContract -Task $driftedControlTask `
                -TaskName 'Dyson-Control-Plane' -ExpectedPowerShellExecutable $powerShell `
                -ExpectedArguments $controlTaskArguments -AllowedStates @('Running'))
        }) -Message 'a drifted complete control-task contract was accepted'
    }
    $serverTask = [pscustomobject][ordered]@{
        TaskName = 'Dyson-Nebula-Server'
        TaskPath = '\'
        State = 'Ready'
        Actions = @([pscustomobject][ordered]@{
            Execute = $powerShell
            Arguments = '-NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "' +
                (Join-Path $bootstrapRoot 'Start-DysonServer.ps1') + '" -ProjectRoot "' +
                $projectRoot + '" -Ups 60'
            WorkingDirectory = ''
        })
        Principal = [pscustomobject][ordered]@{
            UserId = 'EXAMPLE\DysonGame'; LogonType = 'Interactive'; RunLevel = 'Limited'
        }
        Settings = [pscustomobject][ordered]@{
            Enabled = $true
            MultipleInstances = 'IgnoreNew'
            ExecutionTimeLimit = 'PT0S'
            RestartCount = 3
            RestartInterval = 'PT1M'
            StartWhenAvailable = $true
        }
        Triggers = @([pscustomobject][ordered]@{ UserId = 'EXAMPLE\DysonGame'; Delay = 'PT20S' })
    }
    $stopTask = [pscustomobject][ordered]@{
        TaskName = 'Dyson-Nebula-Stop'
        TaskPath = '\'
        State = 'Ready'
        Actions = @([pscustomobject][ordered]@{
            Execute = $powerShell
            Arguments = '-NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "' +
                (Join-Path $bootstrapRoot 'Stop-DysonServer.ps1') + '" -ProjectRoot "' +
                $projectRoot + '" -TimeoutSeconds 150'
            WorkingDirectory = ''
        })
        Principal = [pscustomobject][ordered]@{
            UserId = 'EXAMPLE\DysonGame'; LogonType = 'Interactive'; RunLevel = 'Limited'
        }
        Settings = [pscustomobject][ordered]@{
            Enabled = $true
            MultipleInstances = 'IgnoreNew'
            ExecutionTimeLimit = 'PT5M'
            RestartCount = 0
            RestartInterval = $null
            StartWhenAvailable = $false
        }
        Triggers = @()
    }
    $script:deploymentStatusTasks = @($serverTask, $stopTask)
    $provisional = [pscustomobject][ordered]@{
        protocol = 'DYSON_CONTROL_LIFECYCLE_BROKER_PROFILE_V1'
        schemaVersion = 1
        brokerRoot = $brokerRoot
        brokerScriptRoot = $brokerScriptRoot
        projectRoot = $projectRoot
        dataRoot = $applicationData
        installedWindowsRoot = $windowsRoot
        runtimeBootstrapRoot = $bootstrapRoot
        serviceUser = 'EXAMPLE\DysonGame'
        gamePort = 8469
        workerTaskName = 'Dyson-Control-Lifecycle-Broker'
        workerTaskPath = '\DysonControl\'
        serverTask = [pscustomobject][ordered]@{ name = 'Dyson-Nebula-Server'; path = '\'; descriptorHash = ('0' * 64) }
        stopTask = [pscustomobject][ordered]@{ name = 'Dyson-Nebula-Stop'; path = '\'; descriptorHash = ('0' * 64) }
        dependencyHashes = @()
        dispatchReadyTimeoutSeconds = 5
        createdAt = '2026-09-01T00:00:00.0000000+00:00'
    }
    $serverDescriptor = Get-DysonLifecycleBrokerTaskDescriptor -Profile $provisional -Kind server
    $stopDescriptor = Get-DysonLifecycleBrokerTaskDescriptor -Profile $provisional -Kind stop
    $provisional.serverTask.descriptorHash = Get-DysonLifecycleBrokerTaskDescriptorHash $serverDescriptor.descriptor
    $provisional.stopTask.descriptorHash = Get-DysonLifecycleBrokerTaskDescriptorHash $stopDescriptor.descriptor
    $dependencies = [System.Collections.Generic.List[object]]::new()
    foreach ($name in $script:DysonLifecycleBrokerDependencyNames) {
        $path = Get-DysonLifecycleBrokerExpectedDependencyPath -Profile $provisional -Name $name
        $dependencies.Add([pscustomobject][ordered]@{
            name = $name
            path = $path
            sha256 = Get-DysonLifecycleBrokerSha256File -LiteralPath $path
        })
    }
    $provisional.dependencyHashes = @($dependencies)
    $profile = ConvertTo-DysonLifecycleBrokerValidatedProfile -Raw $provisional
    [System.IO.File]::WriteAllText(
        $profileFile,
        (ConvertTo-DysonLifecycleBrokerJson $profile) + "`n",
        [System.Text.UTF8Encoding]::new($false)
    )
    $workerArguments = Get-DysonLifecycleBrokerTaskArguments -BrokerRoot $brokerRoot `
        -ProfileFile $profileFile -WorkerScript (Join-Path $brokerScriptRoot 'Invoke-DysonLifecycleBrokerWorker.ps1')
    $workerTask = [pscustomobject][ordered]@{
        TaskName = 'Dyson-Control-Lifecycle-Broker'
        TaskPath = '\DysonControl\'
        State = 'Ready'
        Actions = @([pscustomobject][ordered]@{
            Execute = $powerShell; Arguments = $workerArguments; WorkingDirectory = ''
        })
        Principal = [pscustomobject][ordered]@{
            UserId = 'SYSTEM'; LogonType = 'ServiceAccount'; RunLevel = 'Highest'
        }
        Settings = [pscustomobject][ordered]@{
            Enabled = $true; MultipleInstances = 'IgnoreNew'; ExecutionTimeLimit = 'PT5M'
        }
        Triggers = @()
        Description = 'Executes only profile-bound Dyson lifecycle capabilities; never launches Steam or DSP directly.'
    }
    $script:deploymentStatusTasks = @($serverTask, $stopTask, $workerTask)
    Write-DeploymentStatusEnvironment -Enabled $true -EnvironmentFile $environmentFile `
        -ProfileFile $profileFile -ProjectRoot $projectRoot -ApplicationData $applicationData
    $activeRelease = [pscustomobject][ordered]@{ releaseRoot = $releaseRoot }

    $ready = Get-DysonLifecycleBrokerStaticStatus -InstallRoot $installRoot -DataRoot $dataRoot `
        -ActiveRelease $activeRelease -EnvironmentFile $environmentFile
    Assert-DeploymentStatusFixture -Condition ([bool]$ready.ready -and [bool]$ready.consistent -and
        [bool]$ready.profileBound -and [bool]$ready.taskBound -and [bool]$ready.pendingClean) `
        -Message 'a fully bound active lifecycle broker was not reported ready'

    Write-DeploymentStatusEnvironment -Enabled $true -EnvironmentFile $environmentFile `
        -ProfileFile $profileFile -ProjectRoot $driftedProjectRoot -ApplicationData $applicationData
    Assert-DeploymentStatusFixture -Condition (Test-DeploymentStatusRejected {
        [void](Get-DysonLifecycleBrokerStaticStatus -InstallRoot $installRoot -DataRoot $dataRoot `
            -ActiveRelease $activeRelease -EnvironmentFile $environmentFile)
    }) -Message 'environment-to-profile project-root drift was accepted'
    Write-DeploymentStatusEnvironment -Enabled $true -EnvironmentFile $environmentFile `
        -ProfileFile $profileFile -ProjectRoot $projectRoot -ApplicationData $applicationData

    $pendingPath = Join-Path $brokerRoot 'requests\11111111-2222-4333-8444-555555555555.json'
    [System.IO.File]::WriteAllText($pendingPath, '{}', [System.Text.UTF8Encoding]::new($false))
    Assert-DeploymentStatusFixture -Condition (Test-DeploymentStatusRejected {
        [void](Get-DysonLifecycleBrokerStaticStatus -InstallRoot $installRoot -DataRoot $dataRoot `
            -ActiveRelease $activeRelease -EnvironmentFile $environmentFile)
    }) -Message 'an unfinished lifecycle broker request was accepted'
    Remove-Item -LiteralPath $pendingPath -Force

    $otherEnvironment = Join-Path $dataRoot 'config\other.env'
    Copy-Item -LiteralPath $environmentFile -Destination $otherEnvironment -Force
    Assert-DeploymentStatusFixture -Condition (Test-DeploymentStatusRejected {
        [void](Get-DysonLifecycleBrokerStaticStatus -InstallRoot $installRoot -DataRoot $dataRoot `
            -ActiveRelease $activeRelease -EnvironmentFile $otherEnvironment)
    }) -Message 'an environment file outside the fixed deployment path was accepted'

    Write-DeploymentStatusEnvironment -Enabled $false -EnvironmentFile $environmentFile `
        -ProfileFile $profileFile -ProjectRoot $projectRoot -ApplicationData $applicationData
    $script:deploymentStatusTasks = @()
    $disabledProfileResidual = Get-DysonLifecycleBrokerStaticStatus -InstallRoot $installRoot -DataRoot $dataRoot `
        -ActiveRelease $activeRelease -EnvironmentFile $environmentFile
    Assert-DeploymentStatusFixture -Condition (-not [bool]$disabledProfileResidual.consistent -and
        [string]$disabledProfileResidual.state -ceq 'disabled-residual') `
        -Message 'a disabled-but-residual fixed broker profile was treated as clean'
    Remove-Item -LiteralPath $profileFile -Force
    $disabledWorker = $workerTask.PSObject.Copy()
    $disabledWorker.State = 'Disabled'
    $disabledWorker.Settings = [pscustomobject][ordered]@{
        Enabled = $false; MultipleInstances = 'IgnoreNew'; ExecutionTimeLimit = 'PT5M'
    }
    $script:deploymentStatusTasks = @($disabledWorker)
    $disabledResidual = Get-DysonLifecycleBrokerStaticStatus -InstallRoot $installRoot -DataRoot $dataRoot `
        -ActiveRelease $activeRelease -EnvironmentFile $environmentFile
    Assert-DeploymentStatusFixture -Condition (-not [bool]$disabledResidual.consistent -and
        [string]$disabledResidual.state -ceq 'disabled-residual') `
        -Message 'a disabled-but-residual fixed broker task was treated as clean'

    $script:deploymentStatusTasks = @()
    $disabledClean = Get-DysonLifecycleBrokerStaticStatus -InstallRoot $installRoot -DataRoot $dataRoot `
        -ActiveRelease $activeRelease -EnvironmentFile $environmentFile
    Assert-DeploymentStatusFixture -Condition ([bool]$disabledClean.consistent -and
        -not [bool]$disabledClean.ready -and [string]$disabledClean.state -ceq 'disabled-clean') `
        -Message 'a disabled broker with only empty durable storage was not treated as clean'

    Assert-DeploymentReadinessHttpBudget

    [ordered]@{
        protocol = 'DYSON_CONTROL_DEPLOYMENT_STATUS_SELFTEST_V1'
        state = 'passed'
        activeReleaseProfileBindingValidated = $true
        environmentBindingDriftRejected = $true
        pendingRequestRejected = $true
        fixedEnvironmentPathRequired = $true
        disabledResidualProfileRejected = $true
        disabledResidualTaskRejected = $true
        disabledCleanStateValidated = $true
        controlTaskContractNegativeMatrixValidated = $true
        slowReadinessWithinBudgetValidated = $true
        readinessDeadlineAndResponseContractValidated = $true
        brokerStatusSubmitted = $false
        productionChanged = $false
    } | ConvertTo-Json -Depth 5 -Compress
}
finally {
    $testFull = [System.IO.Path]::GetFullPath($testRoot).TrimEnd('\', '/')
    $expectedPrefix = $temporaryBase + [System.IO.Path]::DirectorySeparatorChar +
        'dyson-deployment-status-selftest-'
    if ($testFull.StartsWith($expectedPrefix, [System.StringComparison]::OrdinalIgnoreCase) -and
        (Test-Path -LiteralPath $testFull)) {
        Remove-Item -LiteralPath $testFull -Recurse -Force
    }
}
