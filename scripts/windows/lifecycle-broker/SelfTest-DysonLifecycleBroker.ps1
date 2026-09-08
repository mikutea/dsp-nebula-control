[CmdletBinding()]
param()

Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$env:DYSON_LIFECYCLE_BROKER_SELFTEST = '1'
. (Join-Path $PSScriptRoot 'DysonLifecycleBroker.Common.ps1')
. (Join-Path $PSScriptRoot 'DysonLifecycleBroker.TaskAcl.ps1')

$script:passed = 0
$script:failed = 0
$script:failures = [Collections.Generic.List[string]]::new()
$script:stage = 'initialization'

function Assert-SelfTest {
    param([Parameter(Mandatory)][bool]$Condition, [Parameter(Mandatory)][string]$Name)
    if ($Condition) { $script:passed += 1; return }
    $script:failed += 1; $script:failures.Add($Name)
}

function Write-SelfTestJson {
    param([Parameter(Mandatory)][string]$Path, [Parameter(Mandatory)]$Value)
    [IO.File]::WriteAllText($Path, (($Value | ConvertTo-Json -Depth 24 -Compress) + "`n"), [Text.UTF8Encoding]::new($false))
}

function Invoke-SelfTestScript {
    param(
        [Parameter(Mandatory)][string]$Script,
        [Parameter(Mandatory)][string[]]$Arguments,
        [ValidateRange(5, 300)][int]$TimeoutSeconds = 120
    )
    if (-not (Test-Path -LiteralPath $Script -PathType Leaf)) { throw 'self-test script is missing' }
    $runspace = $null
    $pipeline = $null
    $asyncResult = $null
    $stopResult = $null
    $safeToDispose = $true
    try {
        # Bind only the fixed script and named arguments assembled by this
        # parameterless self-test. A hosted pipeline avoids console descendants
        # and still provides a precise, bounded invocation handle on WinPS 5.1.
        $runspace = [Management.Automation.Runspaces.RunspaceFactory]::CreateRunspace()
        $runspace.Open()
        $pipeline = [Management.Automation.PowerShell]::Create()
        $pipeline.Runspace = $runspace
        [void]$pipeline.AddCommand($Script)
        $index = 0
        while ($index -lt $Arguments.Count) {
            $token = [string]$Arguments[$index]
            $match = [regex]::Match($token, '^-(?<name>[A-Za-z][A-Za-z0-9]*)(?::\$(?<bool>true|false))?$')
            if (-not $match.Success) { throw 'invalid self-test parameter token' }
            $name = $match.Groups['name'].Value
            if ($match.Groups['bool'].Success) {
                [void]$pipeline.AddParameter($name, ($match.Groups['bool'].Value -ceq 'true'))
                $index += 1
                continue
            }
            $hasValue = $index + 1 -lt $Arguments.Count -and
                -not [regex]::IsMatch([string]$Arguments[$index + 1], '^-[A-Za-z][A-Za-z0-9]*(?::\$(?:true|false))?$')
            if ($hasValue) {
                [void]$pipeline.AddParameter($name, [string]$Arguments[$index + 1])
                $index += 2
            }
            else {
                [void]$pipeline.AddParameter($name)
                $index += 1
            }
        }
        $asyncResult = $pipeline.BeginInvoke()
        $waitMilliseconds = [int]($TimeoutSeconds * 1000)
        if (-not $asyncResult.AsyncWaitHandle.WaitOne($waitMilliseconds)) {
            $safeToDispose = $false
            try {
                $stopResult = $pipeline.BeginStop($null, $null)
                if ($stopResult.AsyncWaitHandle.WaitOne(5000)) {
                    try { $pipeline.EndStop($stopResult) }
                    catch { }
                    $safeToDispose = $true
                }
            }
            catch { }
            throw ('self-test child timed out: ' + [IO.Path]::GetFileName($Script))
        }
        $output = @($pipeline.EndInvoke($asyncResult))
        $childExitCode = $runspace.SessionStateProxy.PSVariable.GetValue('LASTEXITCODE')
        $out = @($output | ForEach-Object { [string]$_ }) -join [Environment]::NewLine
        $err = @($pipeline.Streams.Error | ForEach-Object { [string]$_ }) -join [Environment]::NewLine
        return [pscustomobject]@{
            exitCode = if ($null -eq $childExitCode) { if ($pipeline.HadErrors) { 1 } else { 0 } } else { [int]$childExitCode }
            stdout = $out.Trim()
            stderr = $err.Trim()
        }
    }
    finally {
        if ($null -ne $stopResult) { $stopResult.AsyncWaitHandle.Close() }
        if ($null -ne $asyncResult) { $asyncResult.AsyncWaitHandle.Close() }
        if ($null -ne $pipeline -and $safeToDispose) { $pipeline.Dispose() }
        if ($null -ne $runspace -and $safeToDispose) { $runspace.Dispose() }
    }
}

function ConvertFrom-SelfTestOutput {
    param([Parameter(Mandatory)][string]$Text)
    $lines = @($Text -split "`r?`n" | Where-Object { -not [string]::IsNullOrWhiteSpace($_) })
    if ($lines.Count -eq 0) { return $null }
    return ($lines[-1] | ConvertFrom-Json -ErrorAction Stop)
}

function Set-SelfTestRuntime {
    param(
        [ValidateSet('stopped', 'running', 'unknown')][string]$State,
        [ValidateSet('verified', 'missing', 'ambiguous')][string]$Session = 'verified',
        [ValidateSet('verified', 'missing', 'ambiguous')][string]$Steam = 'verified'
    )
    $sessions = @(switch ($Session) {
        'missing' { @() }
        'verified' { @([ordered]@{ id = 2; user = 'EXAMPLE\DysonGame'; state = 'active' }) }
        'ambiguous' { @([ordered]@{ id = 2; user = 'EXAMPLE\DysonGame'; state = 'active' }, [ordered]@{ id = 3; user = 'EXAMPLE\DysonGame'; state = 'disconnected' }) }
    })
    $steamRecords = @(switch ($Steam) {
        'missing' { @() }
        'verified' { @([ordered]@{ name = 'steam.exe'; pid = 100; path = 'C:\Program Files (x86)\Steam\steam.exe'; owner = 'EXAMPLE\DysonGame'; sessionId = 2 }) }
        'ambiguous' { @(
            [ordered]@{ name = 'steam.exe'; pid = 100; path = 'C:\Program Files (x86)\Steam\steam.exe'; owner = 'EXAMPLE\DysonGame'; sessionId = 2 },
            [ordered]@{ name = 'steam.exe'; pid = 101; path = 'C:\Program Files (x86)\Steam\steam.exe'; owner = 'EXAMPLE\DysonGame'; sessionId = 2 }
        ) }
    })
    $processes = @(); $listeners = @()
    $pidPath = Join-Path $script:project 'run\dspgame.pid'
    if (Test-Path -LiteralPath $pidPath) { Remove-Item -LiteralPath $pidPath -Force }
    if ($State -eq 'running') {
        $processes = @([ordered]@{
            name = 'DSPGAME.exe'; pid = 4242; path = (Join-Path $script:project 'server\DSPGAME.exe')
            owner = 'EXAMPLE\DysonGame'; sessionId = 2
        })
        $listeners = @([ordered]@{ port = 8469; pid = 4242 })
        [IO.File]::WriteAllText($pidPath, '4242', [Text.UTF8Encoding]::new($false))
    }
    elseif ($State -eq 'unknown') {
        $processes = @([ordered]@{
            name = 'DSPGAME.exe'; pid = 4242; path = (Join-Path $script:project 'server\OTHER.exe')
            owner = 'EXAMPLE\DysonGame'; sessionId = 2
        })
        $listeners = @([ordered]@{ port = 8469; pid = 9000 })
        [IO.File]::WriteAllText($pidPath, '4242', [Text.UTF8Encoding]::new($false))
    }
    Write-SelfTestJson (Join-Path $script:shadow 'runtime.json') ([ordered]@{
        sessions = $sessions; processes = $processes; listeners = $listeners; steam = $steamRecords
    })
}

function Set-SelfTestLease {
    param([bool]$Valid = $true, [int]$LoseAfterChecks = 0)
    Write-SelfTestJson (Join-Path $script:shadow 'lease.json') ([ordered]@{
        instanceId = $script:leaseId; token = $script:leaseBorrowFixture; valid = $Valid; loseAfterChecks = $LoseAfterChecks
    })
    $countPath = Join-Path $script:shadow 'lease-check-count.txt'
    if (Test-Path -LiteralPath $countPath) { Remove-Item -LiteralPath $countPath -Force }
}

function Invoke-SelfTestSubmit {
    param(
        [Parameter(Mandatory)][string]$Id,
        [Parameter(Mandatory)][string]$Capability,
        [string]$Action,
        [string]$Operation,
        [string]$Expected,
        [int]$TimeoutSeconds = 15,
        [switch]$WhatIf
    )
    $arguments = [Collections.Generic.List[string]]::new()
    foreach ($entry in @('-BrokerRoot', $script:broker, '-ProfileFile', $script:profileFile, '-BrokerRequestId', $Id,
        '-Capability', $Capability, '-TimeoutSeconds', [string]$TimeoutSeconds, '-Backend', 'Shadow', '-ShadowRoot', $script:shadow)) {
        $arguments.Add([string]$entry)
    }
    if ($Action) { $arguments.Add('-Action'); $arguments.Add($Action) }
    if ($Operation) {
        $arguments.Add('-Operation'); $arguments.Add($Operation)
        $arguments.Add('-DataRoot'); $arguments.Add($script:data)
        $arguments.Add('-LeaseInstanceId'); $arguments.Add($script:leaseId)
        $arguments.Add('-LeaseToken'); $arguments.Add($script:leaseBorrowFixture)
    }
    if ($Expected) { $arguments.Add('-Expected'); $arguments.Add($Expected) }
    if ($WhatIf) { $arguments.Add('-WhatIf') }
    return Invoke-SelfTestScript -Script $script:submit -Arguments @($arguments)
}

function Invoke-SelfTestInstall {
    param(
        [Parameter(Mandatory)][string]$Script,
        [Parameter(Mandatory)][string]$InstalledRoot,
        [Parameter(Mandatory)][string]$Broker,
        [Parameter(Mandatory)][string]$Data,
        [Parameter(Mandatory)][string]$Shadow,
        [string]$BootstrapRoot = $script:installed,
        [string]$Project = $script:project,
        [switch]$UpgradeExisting,
        [switch]$CompensateFirstInstall,
        [switch]$RemoveCurrent,
        [string]$ExpectedProfileHash,
        [switch]$WhatIf
    )
    $arguments = [Collections.Generic.List[string]]::new()
    foreach ($entry in @(
        '-BrokerRoot', $Broker, '-ProjectRoot', $Project, '-DataRoot', $Data,
        '-InstalledWindowsRoot', $InstalledRoot, '-RuntimeBootstrapRoot', $BootstrapRoot,
        '-ServiceUser', 'EXAMPLE\DysonGame', '-GamePort', '8469', '-DispatchReadyTimeoutSeconds', '5',
        '-Backend', 'Shadow', '-ShadowRoot', $Shadow
    )) { $arguments.Add([string]$entry) }
    if ($UpgradeExisting) { $arguments.Add('-UpgradeExisting') }
    if ($CompensateFirstInstall) { $arguments.Add('-CompensateFirstInstall') }
    if ($RemoveCurrent) { $arguments.Add('-RemoveCurrent') }
    if ($PSBoundParameters.ContainsKey('ExpectedProfileHash')) {
        $arguments.Add('-ExpectedProfileHash'); $arguments.Add($ExpectedProfileHash)
    }
    if ($WhatIf) { $arguments.Add('-WhatIf') }
    return Invoke-SelfTestScript -Script $Script -Arguments @($arguments)
}

function Set-SelfTestInstallerFailureStage {
    param([Parameter(Mandatory)][string]$Shadow, [Parameter(Mandatory)][string]$Stage)
    Write-SelfTestJson (Join-Path $Shadow 'installer-control.json') ([ordered]@{ failStage = $Stage })
}

function Test-SelfTestBytesEqual {
    param([Parameter(Mandatory)][byte[]]$Left, [Parameter(Mandatory)][byte[]]$Right)
    if ($Left.Length -ne $Right.Length) { return $false }
    for ($index = 0; $index -lt $Left.Length; $index += 1) {
        if ($Left[$index] -ne $Right[$index]) { return $false }
    }
    return $true
}

function Test-SelfTestFileBytesEqual {
    param([Parameter(Mandatory)][string]$Path, [Parameter(Mandatory)][byte[]]$Expected)
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return $false }
    try { return Test-SelfTestBytesEqual -Left $Expected -Right ([IO.File]::ReadAllBytes($Path)) }
    catch { return $false }
}

$script:root = Join-Path $env:TEMP ('dyson-lifecycle-broker-selftest-' + [guid]::NewGuid().ToString('N'))
$script:installed = Join-Path $script:root 'installed\scripts\windows'
$script:brokerScripts = Join-Path $script:installed 'lifecycle-broker'
$script:shadow = Join-Path $script:root 'shadow'
$script:project = Join-Path $script:root 'project'
$script:data = Join-Path $script:root 'data'
$script:broker = Join-Path $script:data 'lifecycle-broker'
$script:leaseId = [guid]::NewGuid().ToString('D').ToLowerInvariant()
$script:leaseBorrowFixture = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'

try {
    # Exercise the real status-only sampler with a retained process handle;
    # isolate runtime identity observations without starting a game or task.
    & {
        $tokens = $null; $errors = $null
        $ast = [Management.Automation.Language.Parser]::ParseFile(
            (Join-Path $PSScriptRoot 'Invoke-DysonLifecycleBrokerWorker.ps1'), [ref]$tokens, [ref]$errors)
        $definition = $ast.Find({ param($node)
            $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -ceq 'Get-WorkerProcessTelemetry'
        }, $false)
        . ([scriptblock]::Create($definition.Extent.Text))
        $Backend = 'Windows'
        $selfProcess = Get-Process -Id $PID
        $runtime = [pscustomobject]@{ lifecycleState = 'running_verified'; process = [pscustomobject]@{
            status = 'verified'; pid = $PID; sessionId = $selfProcess.SessionId; owner = 'fixture' } }
        function Test-WorkerProcessExecutable { return $true }
        function Get-WorkerLifecycleEvidence { return $runtime }
        $profile = [pscustomobject]@{ projectRoot = $env:TEMP }
        $sample = Get-WorkerProcessTelemetry $profile $runtime
        Assert-SelfTest ($null -ne $sample -and $sample.processId -eq $PID -and
            $sample.startedAtUnixMs -le $sample.sampledAtUnixMs -and $sample.threadCount -gt 0) 'status sampler returns bound real process measurements'
        function Get-WorkerLifecycleEvidence {
            return [pscustomobject]@{ lifecycleState = 'running_verified'; process = [pscustomobject]@{
                status = 'verified'; pid = 2147483647; sessionId = $runtime.process.sessionId; owner = 'fixture' } }
        }
        Assert-SelfTest ($null -eq (Get-WorkerProcessTelemetry $profile $runtime)) 'status sampler rejects changed process identity after sampling'
        function Test-WorkerProcessExecutable { throw 'fixture access denied' }
        Assert-SelfTest ($null -eq (Get-WorkerProcessTelemetry $profile $runtime)) 'status sampler retains unknown on process access failure'
        function Test-WorkerProcessExecutable { return $true }
        $generationProcess = [pscustomobject]@{
            Id = $PID; Handle = 1; StartTime = [datetime]::UtcNow.AddMinutes(-1)
            SessionId = $runtime.process.sessionId; HasExited = $false; Path = 'fixture.exe'
            TotalProcessorTime = [timespan]::FromSeconds(1)
        }
        $generationProcess | Add-Member ScriptMethod Refresh { $this.StartTime = $this.StartTime.AddSeconds(1) }
        $generationProcess | Add-Member ScriptMethod Dispose { }
        function Get-Process { return $generationProcess }
        Assert-SelfTest ($null -eq (Get-WorkerProcessTelemetry $profile $runtime)) 'status sampler rejects PID generation change during sampling'
        $selfProcess.Dispose()
    }
    foreach ($path in @(
        $script:brokerScripts, $script:broker, $script:shadow, $script:data,
        (Join-Path $script:project 'server'), (Join-Path $script:project 'run')
    )) { [void][IO.Directory]::CreateDirectory($path) }
    [IO.File]::WriteAllText((Join-Path $script:shadow '.dyson-lifecycle-broker-selftest'), 'fixture', [Text.UTF8Encoding]::new($false))
    [IO.File]::WriteAllBytes((Join-Path $script:project 'server\DSPGAME.exe'), [byte[]]@(0))
    [IO.File]::WriteAllBytes((Join-Path $script:project 'server\OTHER.exe'), [byte[]]@(0))
    foreach ($name in @(
        'DysonLifecycleBroker.Common.ps1', 'DysonLifecycleBroker.TaskAcl.ps1',
        'Install-DysonLifecycleBrokerTask.ps1', 'Invoke-DysonLifecycleBrokerWorker.ps1',
        'Submit-DysonLifecycleBrokerRequest.ps1', 'SelfTest-DysonLifecycleBroker.ps1'
    )) { Copy-Item -LiteralPath (Join-Path $PSScriptRoot $name) -Destination (Join-Path $script:brokerScripts $name) }
    $sourceWindows = Split-Path -Parent $PSScriptRoot
    foreach ($name in @('DysonHostMutationLease.Common.ps1', 'Start-DysonServer.ps1', 'Stop-DysonServer.ps1')) {
        Copy-Item -LiteralPath (Join-Path $sourceWindows $name) -Destination (Join-Path $script:installed $name)
    }
    $powerShell = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
    $serverDescriptor = [ordered]@{
        name = 'Dyson-Nebula-Server'; path = '\'; execute = $powerShell.ToLowerInvariant()
        arguments = '-NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "' + (Join-Path $script:installed 'Start-DysonServer.ps1') + '" -ProjectRoot "' + $script:project + '" -Ups 60'
        workingDirectory = ''; userId = 'dysonGame'; logonType = 'Interactive'; runLevel = 'Limited'
        enabled = $true; multipleInstances = 'IgnoreNew'
        executionTimeLimit = 'PT0S'; restartCount = 3; restartInterval = 'PT1M'; startWhenAvailable = $true
        trigger = [ordered]@{ count = 1; userId = 'dysongame'; delay = 'PT20S' }
    }
    $stopDescriptor = [ordered]@{
        name = 'Dyson-Nebula-Stop'; path = '\'; execute = $powerShell.ToLowerInvariant()
        arguments = '-NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "' + (Join-Path $script:installed 'Stop-DysonServer.ps1') + '" -ProjectRoot "' + $script:project + '" -TimeoutSeconds 150'
        workingDirectory = ''; userId = 'dysonGame'; logonType = 'Interactive'; runLevel = 'Limited'
        enabled = $true; multipleInstances = 'IgnoreNew'
        executionTimeLimit = 'PT5M'; restartCount = 0; restartInterval = $null; startWhenAvailable = $false
        trigger = [ordered]@{ count = 0; userId = $null; delay = $null }
    }
    Write-SelfTestJson (Join-Path $script:shadow 'server-task.json') ([ordered]@{ descriptor = $serverDescriptor; state = 'Ready' })
    Write-SelfTestJson (Join-Path $script:shadow 'stop-task.json') ([ordered]@{ descriptor = $stopDescriptor; state = 'Ready' })
    Write-SelfTestJson (Join-Path $script:shadow 'dispatch-control.json') ([ordered]@{ readyTimeout = $false })
    Set-SelfTestRuntime stopped
    Set-SelfTestLease
    $script:install = Join-Path $script:brokerScripts 'Install-DysonLifecycleBrokerTask.ps1'
    $script:submit = Join-Path $script:brokerScripts 'Submit-DysonLifecycleBrokerRequest.ps1'
    $serverDescriptor.enabled = $false
    $stopDescriptor.enabled = $false
    Write-SelfTestJson (Join-Path $script:shadow 'server-task.json') ([ordered]@{ descriptor = $serverDescriptor; state = 'Disabled' })
    Write-SelfTestJson (Join-Path $script:shadow 'stop-task.json') ([ordered]@{ descriptor = $stopDescriptor; state = 'Disabled' })
    $installRun = Invoke-SelfTestInstall -Script $script:install -InstalledRoot $script:installed `
        -Broker $script:broker -Data $script:data -Shadow $script:shadow
    $installEnvelope = ConvertFrom-SelfTestOutput $installRun.stdout
    Assert-SelfTest ($installRun.exitCode -eq 0 -and [string]$installEnvelope.protocol -ceq 'DYSON_CONTROL_LIFECYCLE_BROKER_INSTALL_RECEIPT_V1') `
        ('shadow install [' + $installRun.exitCode + ';' + [string]$installRun.stdout + ';' + [string]$installRun.stderr + ']')
    $script:profileFile = Join-Path $script:broker 'broker-profile.json'

    $script:stage = 'installer transaction'
    $profileBytes = [IO.File]::ReadAllBytes($script:profileFile)
    $initialProfile = Read-DysonLifecycleBrokerProfile $script:profileFile
    $preparedPair = Assert-DysonLifecycleBrokerTaskPair -Profile $initialProfile -Backend Shadow -ShadowRoot $script:shadow -AllowPreparedDisabled
    Assert-SelfTest ($preparedPair.preparedDisabled -and -not $preparedPair.server.descriptor.enabled) 'installation preserves prepared disabled state'
    $disabledRejected = $false
    try { [void](Assert-DysonLifecycleBrokerTaskPair -Profile $initialProfile -Backend Shadow -ShadowRoot $script:shadow) }
    catch { $disabledRejected = $true }
    Assert-SelfTest $disabledRejected 'runtime validation rejects prepared disabled tasks'
    $preparedStatus = Invoke-SelfTestSubmit -Id ([guid]::NewGuid().ToString('D')) -Capability LifecycleStatus
    $preparedStatusEnvelope = ConvertFrom-SelfTestOutput $preparedStatus.stdout
    Assert-SelfTest ($preparedStatus.exitCode -eq 0 -and $preparedStatusEnvelope.receipt.status -eq 'succeeded' -and
        $preparedStatusEnvelope.receipt.evidence.task.valid -and
        $preparedStatusEnvelope.receipt.evidence.task.server.state -eq 'Disabled' -and
        $preparedStatusEnvelope.receipt.evidence.lifecycleState -eq 'stopped_verified' -and
        -not $preparedStatusEnvelope.receipt.evidence.runtime.pidFile.present -and
        -not $preparedStatusEnvelope.receipt.evidence.runtime.pidFile.valid) 'read-only status observes prepared disabled tasks with no validated PID'
    $stopDescriptor.enabled = $true
    Write-SelfTestJson (Join-Path $script:shadow 'stop-task.json') ([ordered]@{ descriptor = $stopDescriptor; state = 'Ready' })
    $mixedInstall = Invoke-SelfTestInstall -Script $script:install -InstalledRoot $script:installed -Broker $script:broker -Data $script:data -Shadow $script:shadow
    Assert-SelfTest ($mixedInstall.exitCode -ne 0 -and (Test-SelfTestBytesEqual $profileBytes ([IO.File]::ReadAllBytes($script:profileFile)))) 'mixed enabled pair cannot reinstall broker'
    $stopDescriptor.enabled = $false
    Write-SelfTestJson (Join-Path $script:shadow 'stop-task.json') ([ordered]@{ descriptor = $stopDescriptor; state = 'Disabled' })
    Write-SelfTestJson (Join-Path $script:shadow 'server-task.json') ([ordered]@{ descriptor = $serverDescriptor; state = 'Running' })
    $runningRejected = $false
    try { [void](Assert-DysonLifecycleBrokerTaskPair -Profile $initialProfile -Backend Shadow -ShadowRoot $script:shadow -AllowPreparedDisabled) }
    catch { $runningRejected = $true }
    Assert-SelfTest $runningRejected 'prepared task with running state is rejected'
    $serverDescriptor.enabled = $true
    $stopDescriptor.enabled = $true
    Write-SelfTestJson (Join-Path $script:shadow 'server-task.json') ([ordered]@{ descriptor = $serverDescriptor; state = 'Ready' })
    Write-SelfTestJson (Join-Path $script:shadow 'stop-task.json') ([ordered]@{ descriptor = $stopDescriptor; state = 'Ready' })
    $activePair = Assert-DysonLifecycleBrokerTaskPair -Profile $initialProfile -Backend Shadow -ShadowRoot $script:shadow
    Assert-SelfTest (-not $activePair.preparedDisabled) 'activation matches the installed expected-active profile'
    $reinstall = Invoke-SelfTestInstall -Script $script:install -InstalledRoot $script:installed `
        -Broker $script:broker -Data $script:data -Shadow $script:shadow
    $reinstallEnvelope = ConvertFrom-SelfTestOutput $reinstall.stdout
    Assert-SelfTest ($reinstall.exitCode -eq 0 -and $reinstallEnvelope.operation -ceq 'reused' -and
        $reinstallEnvelope.reused -and [string]$reinstallEnvelope.profileCreatedAt -ceq [string]$initialProfile.createdAt -and
        (Test-SelfTestBytesEqual $profileBytes ([IO.File]::ReadAllBytes($script:profileFile)))) `
        'same release install is byte-exact idempotent'

    # A failed first install removes only artifacts created by that attempt and preserves its storage directories.
    $firstFailureData = Join-Path $script:root 'first-failure-data'
    $firstFailureBroker = Join-Path $firstFailureData 'lifecycle-broker'
    $firstFailureShadow = Join-Path $script:root 'first-failure-shadow'
    [void][IO.Directory]::CreateDirectory($firstFailureShadow)
    [IO.File]::WriteAllText((Join-Path $firstFailureShadow '.dyson-lifecycle-broker-selftest'), 'fixture', [Text.UTF8Encoding]::new($false))
    foreach ($name in @('server-task.json', 'stop-task.json', 'dispatch-control.json')) {
        Copy-Item -LiteralPath (Join-Path $script:shadow $name) -Destination (Join-Path $firstFailureShadow $name)
    }
    Set-SelfTestInstallerFailureStage -Shadow $firstFailureShadow -Stage 'after-task-registered'
    $firstFailure = Invoke-SelfTestInstall -Script $script:install -InstalledRoot $script:installed `
        -Broker $firstFailureBroker -Data $firstFailureData -Shadow $firstFailureShadow
    $firstFailureEnvelope = ConvertFrom-SelfTestOutput $firstFailure.stdout
    Assert-SelfTest ($firstFailure.exitCode -ne 0 -and
        $firstFailureEnvelope.error.code -ceq 'DYSON_CONTROL_LIFECYCLE_BROKER_INSTALL_FAILED' -and
        (Test-Path -LiteralPath (Join-Path $firstFailureBroker 'requests') -PathType Container) -and
        (Test-Path -LiteralPath (Join-Path $firstFailureBroker 'intents') -PathType Container) -and
        (Test-Path -LiteralPath (Join-Path $firstFailureBroker 'receipts') -PathType Container) -and
        -not (Test-Path -LiteralPath (Join-Path $firstFailureBroker 'broker-profile.json')) -and
        -not (Test-Path -LiteralPath (Join-Path $firstFailureShadow 'broker-task.json'))) `
        'failed first install cleans profile and task but preserves storage history'

    # Outer deployment compensation is deliberately limited to the exact first-install binding.
    $compensateData = Join-Path $script:root 'compensate-data'
    $compensateBroker = Join-Path $compensateData 'lifecycle-broker'
    $compensateShadow = Join-Path $script:root 'compensate-shadow'
    [void][IO.Directory]::CreateDirectory($compensateShadow)
    [IO.File]::WriteAllText((Join-Path $compensateShadow '.dyson-lifecycle-broker-selftest'), 'fixture', [Text.UTF8Encoding]::new($false))
    foreach ($name in @('server-task.json', 'stop-task.json', 'dispatch-control.json')) {
        Copy-Item -LiteralPath (Join-Path $script:shadow $name) -Destination (Join-Path $compensateShadow $name)
    }
    $compensateInstall = Invoke-SelfTestInstall -Script $script:install -InstalledRoot $script:installed `
        -Broker $compensateBroker -Data $compensateData -Shadow $compensateShadow
    $compensateInstallEnvelope = ConvertFrom-SelfTestOutput $compensateInstall.stdout
    Assert-SelfTest ($compensateInstall.exitCode -eq 0 -and $compensateInstallEnvelope.operation -ceq 'installed') `
        'compensation fixture first install'
    $compensateProfile = Join-Path $compensateBroker 'broker-profile.json'
    $compensateStorage = Get-DysonLifecycleBrokerStorage $compensateBroker
    $compensatePendingId = [guid]::NewGuid().ToString('D')
    $compensatePendingRequest = New-DysonLifecycleBrokerRequest -BrokerRequestId $compensatePendingId `
        -Capability LifecycleStatus -ProfileHash (Get-DysonLifecycleBrokerProfileHash $compensateProfile) `
        -Input ([pscustomobject][ordered]@{})
    $compensatePendingPaths = Get-DysonLifecycleBrokerRecordPaths $compensateStorage $compensatePendingId
    [void](Write-DysonLifecycleBrokerJsonNew $compensatePendingPaths.request $compensatePendingRequest `
        $script:DysonLifecycleBrokerMaximumRequestBytes)
    $blockedCompensation = Invoke-SelfTestInstall -Script $script:install -InstalledRoot $script:installed `
        -Broker $compensateBroker -Data $compensateData -Shadow $compensateShadow -CompensateFirstInstall
    $blockedCompensationEnvelope = ConvertFrom-SelfTestOutput $blockedCompensation.stdout
    Assert-SelfTest ($blockedCompensation.exitCode -ne 0 -and
        $blockedCompensationEnvelope.error.code -ceq 'DYSON_CONTROL_LIFECYCLE_BROKER_RECOVERY_REQUIRED' -and
        (Test-Path $compensateProfile) -and (Test-Path (Join-Path $compensateShadow 'broker-task.json'))) `
        'compensation rejects pending request'
    Remove-DysonLifecycleBrokerPlainFile $compensatePendingPaths.request

    $compensateTaskFile = Join-Path $compensateShadow 'broker-task.json'
    $compensateTaskBytes = [IO.File]::ReadAllBytes($compensateTaskFile)
    $compensateTaskRecord = Get-Content -Raw -LiteralPath $compensateTaskFile | ConvertFrom-Json
    $compensateTaskRecord.sddl = 'D:P(A;;GA;;;SY)(A;;GA;;;BA)'
    Write-SelfTestJson $compensateTaskFile $compensateTaskRecord
    $driftCompensation = Invoke-SelfTestInstall -Script $script:install -InstalledRoot $script:installed `
        -Broker $compensateBroker -Data $compensateData -Shadow $compensateShadow -CompensateFirstInstall
    $driftCompensationEnvelope = ConvertFrom-SelfTestOutput $driftCompensation.stdout
    Assert-SelfTest ($driftCompensation.exitCode -ne 0 -and
        $driftCompensationEnvelope.error.code -ceq 'DYSON_CONTROL_LIFECYCLE_BROKER_ACCESS_CONTROL_FAILED' -and
        (Test-Path $compensateProfile)) 'compensation rejects task DACL drift'
    [IO.File]::WriteAllBytes($compensateTaskFile, $compensateTaskBytes)

    $compensateProfileBytes = [IO.File]::ReadAllBytes($compensateProfile)
    $compensateAclFile = Join-Path $compensateShadow 'broker-profile.sddl'
    $compensateAclBytes = [IO.File]::ReadAllBytes($compensateAclFile)
    Set-SelfTestInstallerFailureStage -Shadow $compensateShadow -Stage 'after-profile-removed'
    $failedCompensation = Invoke-SelfTestInstall -Script $script:install -InstalledRoot $script:installed `
        -Broker $compensateBroker -Data $compensateData -Shadow $compensateShadow -CompensateFirstInstall
    $failedCompensationEnvelope = ConvertFrom-SelfTestOutput $failedCompensation.stdout
    Assert-SelfTest ($failedCompensation.exitCode -ne 0 -and
        $failedCompensationEnvelope.error.code -ceq 'DYSON_CONTROL_LIFECYCLE_BROKER_INSTALL_FAILED' -and
        (Test-SelfTestBytesEqual $compensateProfileBytes ([IO.File]::ReadAllBytes($compensateProfile))) -and
        (Test-SelfTestBytesEqual $compensateTaskBytes ([IO.File]::ReadAllBytes($compensateTaskFile))) -and
        (Test-SelfTestBytesEqual $compensateAclBytes ([IO.File]::ReadAllBytes($compensateAclFile)))) `
        'compensation failure restores exact profile task and DACL snapshot'
    Set-SelfTestInstallerFailureStage -Shadow $compensateShadow -Stage 'none'

    $terminalId = [guid]::NewGuid().ToString('D')
    $terminalRequest = New-DysonLifecycleBrokerRequest -BrokerRequestId $terminalId -Capability LifecycleStatus `
        -ProfileHash (Get-DysonLifecycleBrokerProfileHash $compensateProfile) -Input ([pscustomobject][ordered]@{})
    $terminalPaths = Get-DysonLifecycleBrokerRecordPaths $compensateStorage $terminalId
    [void](Write-DysonLifecycleBrokerJsonNew $terminalPaths.request $terminalRequest $script:DysonLifecycleBrokerMaximumRequestBytes)
    $terminalReceipt = New-DysonLifecycleBrokerReceipt -Request $terminalRequest -Status succeeded -ErrorCode $null `
        -Evidence ([pscustomobject][ordered]@{ lifecycleState = 'stopped_verified' })
    [void](Write-DysonLifecycleBrokerJsonNew $terminalPaths.receipt $terminalReceipt $script:DysonLifecycleBrokerMaximumReceiptBytes)
    $auditSentinel = Join-Path $compensateBroker 'deployment-audit.keep'
    $neighborSentinel = Join-Path $script:root 'game-steam-gsmanager.keep'
    [IO.File]::WriteAllText($auditSentinel, 'preserve', [Text.UTF8Encoding]::new($false))
    [IO.File]::WriteAllText($neighborSentinel, 'preserve', [Text.UTF8Encoding]::new($false))
    $compensation = Invoke-SelfTestInstall -Script $script:install -InstalledRoot $script:installed `
        -Broker $compensateBroker -Data $compensateData -Shadow $compensateShadow -CompensateFirstInstall
    $compensationEnvelope = ConvertFrom-SelfTestOutput $compensation.stdout
    Assert-SelfTest ($compensation.exitCode -eq 0 -and
        $compensationEnvelope.protocol -ceq 'DYSON_CONTROL_LIFECYCLE_BROKER_COMPENSATION_RECEIPT_V1' -and
        $compensationEnvelope.operation -ceq 'compensated-first-install' -and
        $compensationEnvelope.profileRemoved -and $compensationEnvelope.taskRemoved -and
        -not (Test-Path $compensateProfile) -and -not (Test-Path $compensateTaskFile) -and
        (Test-Path $terminalPaths.request) -and (Test-Path $terminalPaths.receipt) -and
        (Test-Path $auditSentinel) -and (Test-Path $neighborSentinel) -and
        (Test-Path (Join-Path $script:project 'server\DSPGAME.exe')) -and (Test-Path $script:profileFile)) `
        'compensation removes only fixed task and profile while preserving history and neighboring systems'

    # Explicit normal removal is a distinct, hash-bound, fail-closed operation. It consumes no deployment
    # compensation state and preserves every durable request/receipt plus audit and neighboring sentinels.
    $script:stage = 'normal removal contract'
    $removeData = Join-Path $script:root 'remove-data'
    $removeBroker = Join-Path $removeData 'lifecycle-broker'
    $removeShadow = Join-Path $script:root 'remove-shadow'
    [void][IO.Directory]::CreateDirectory($removeShadow)
    [IO.File]::WriteAllText((Join-Path $removeShadow '.dyson-lifecycle-broker-selftest'), 'fixture', [Text.UTF8Encoding]::new($false))
    foreach ($name in @('server-task.json', 'stop-task.json', 'dispatch-control.json')) {
        Copy-Item -LiteralPath (Join-Path $script:shadow $name) -Destination (Join-Path $removeShadow $name)
    }
    $removeInstall = Invoke-SelfTestInstall -Script $script:install -InstalledRoot $script:installed `
        -Broker $removeBroker -Data $removeData -Shadow $removeShadow
    $removeInstallEnvelope = ConvertFrom-SelfTestOutput $removeInstall.stdout
    Assert-SelfTest ($removeInstall.exitCode -eq 0 -and $removeInstallEnvelope.operation -ceq 'installed') `
        'normal removal fixture first install'

    $removeProfile = Join-Path $removeBroker 'broker-profile.json'
    $removeTask = Join-Path $removeShadow 'broker-task.json'
    $removeProfileAcl = Join-Path $removeShadow 'broker-profile.sddl'
    $removeStorage = Get-DysonLifecycleBrokerStorage $removeBroker
    $removeExpectedHash = Get-DysonLifecycleBrokerProfileHash $removeProfile
    $removeTerminalId = [guid]::NewGuid().ToString('D')
    $removeTerminalRequest = New-DysonLifecycleBrokerRequest -BrokerRequestId $removeTerminalId `
        -Capability LifecycleStatus -ProfileHash $removeExpectedHash -Input ([pscustomobject][ordered]@{})
    $removeTerminalPaths = Get-DysonLifecycleBrokerRecordPaths $removeStorage $removeTerminalId
    [void](Write-DysonLifecycleBrokerJsonNew $removeTerminalPaths.request $removeTerminalRequest `
        $script:DysonLifecycleBrokerMaximumRequestBytes)
    $removeTerminalReceipt = New-DysonLifecycleBrokerReceipt -Request $removeTerminalRequest -Status succeeded `
        -ErrorCode $null -Evidence ([pscustomobject][ordered]@{ lifecycleState = 'stopped_verified' })
    [void](Write-DysonLifecycleBrokerJsonNew $removeTerminalPaths.receipt $removeTerminalReceipt `
        $script:DysonLifecycleBrokerMaximumReceiptBytes)
    $removeAuditSentinel = Join-Path $removeBroker 'deployment-audit.keep'
    $removeBrokerSentinel = Join-Path $removeBroker 'operator-sentinel.keep'
    $removeNeighborSentinel = Join-Path $script:root 'normal-removal-neighbor.keep'
    [IO.File]::WriteAllText($removeAuditSentinel, 'audit-preserve', [Text.UTF8Encoding]::new($false))
    [IO.File]::WriteAllText($removeBrokerSentinel, 'broker-preserve', [Text.UTF8Encoding]::new($false))
    [IO.File]::WriteAllText($removeNeighborSentinel, 'neighbor-preserve', [Text.UTF8Encoding]::new($false))
    $removeProfileBytes = [IO.File]::ReadAllBytes($removeProfile)
    $removeTaskBytes = [IO.File]::ReadAllBytes($removeTask)
    $removeProfileAclBytes = [IO.File]::ReadAllBytes($removeProfileAcl)
    $removeRequestBytes = [IO.File]::ReadAllBytes($removeTerminalPaths.request)
    $removeReceiptBytes = [IO.File]::ReadAllBytes($removeTerminalPaths.receipt)
    $removeAuditBytes = [IO.File]::ReadAllBytes($removeAuditSentinel)
    $removeBrokerSentinelBytes = [IO.File]::ReadAllBytes($removeBrokerSentinel)
    $removeNeighborSentinelBytes = [IO.File]::ReadAllBytes($removeNeighborSentinel)

    $removeWhatIf = Invoke-SelfTestInstall -Script $script:install -InstalledRoot $script:installed `
        -Broker $removeBroker -Data $removeData -Shadow $removeShadow -RemoveCurrent `
        -ExpectedProfileHash $removeExpectedHash -WhatIf
    $removeWhatIfEnvelope = ConvertFrom-SelfTestOutput $removeWhatIf.stdout
    Assert-SelfTest ($removeWhatIf.exitCode -eq 0 -and
        $removeWhatIfEnvelope.protocol -ceq 'DYSON_CONTROL_LIFECYCLE_BROKER_REMOVAL_PREVIEW_V1' -and
        $removeWhatIfEnvelope.operation -ceq 'remove-current' -and $removeWhatIfEnvelope.dryRun -and
        [string]$removeWhatIfEnvelope.expectedProfileHash -ceq $removeExpectedHash -and
        (Test-SelfTestFileBytesEqual $removeProfile $removeProfileBytes) -and
        (Test-SelfTestFileBytesEqual $removeTask $removeTaskBytes) -and
        (Test-SelfTestFileBytesEqual $removeTerminalPaths.request $removeRequestBytes) -and
        (Test-SelfTestFileBytesEqual $removeTerminalPaths.receipt $removeReceiptBytes)) `
        'normal removal WhatIf is hash-bound and mutation-free'

    $removeMissingHash = Invoke-SelfTestInstall -Script $script:install -InstalledRoot $script:installed `
        -Broker $removeBroker -Data $removeData -Shadow $removeShadow -RemoveCurrent
    $removeMissingHashEnvelope = ConvertFrom-SelfTestOutput $removeMissingHash.stdout
    Assert-SelfTest ($removeMissingHash.exitCode -ne 0 -and
        $removeMissingHashEnvelope.error.code -ceq 'DYSON_CONTROL_LIFECYCLE_BROKER_INPUT_INVALID') `
        'normal removal requires ExpectedProfileHash'

    $removeUnexpectedHash = Invoke-SelfTestInstall -Script $script:install -InstalledRoot $script:installed `
        -Broker $removeBroker -Data $removeData -Shadow $removeShadow -ExpectedProfileHash $removeExpectedHash
    $removeUnexpectedHashEnvelope = ConvertFrom-SelfTestOutput $removeUnexpectedHash.stdout
    Assert-SelfTest ($removeUnexpectedHash.exitCode -ne 0 -and
        $removeUnexpectedHashEnvelope.error.code -ceq 'DYSON_CONTROL_LIFECYCLE_BROKER_INPUT_INVALID') `
        'ExpectedProfileHash is exclusive to normal removal'

    $removeUpgradeConflict = Invoke-SelfTestInstall -Script $script:install -InstalledRoot $script:installed `
        -Broker $removeBroker -Data $removeData -Shadow $removeShadow -RemoveCurrent `
        -ExpectedProfileHash $removeExpectedHash -UpgradeExisting
    $removeUpgradeConflictEnvelope = ConvertFrom-SelfTestOutput $removeUpgradeConflict.stdout
    Assert-SelfTest ($removeUpgradeConflict.exitCode -ne 0 -and
        $removeUpgradeConflictEnvelope.error.code -ceq 'DYSON_CONTROL_LIFECYCLE_BROKER_INPUT_INVALID') `
        'normal removal conflicts with UpgradeExisting'

    $removeCompensationConflict = Invoke-SelfTestInstall -Script $script:install -InstalledRoot $script:installed `
        -Broker $removeBroker -Data $removeData -Shadow $removeShadow -RemoveCurrent `
        -ExpectedProfileHash $removeExpectedHash -CompensateFirstInstall
    $removeCompensationConflictEnvelope = ConvertFrom-SelfTestOutput $removeCompensationConflict.stdout
    Assert-SelfTest ($removeCompensationConflict.exitCode -ne 0 -and
        $removeCompensationConflictEnvelope.error.code -ceq 'DYSON_CONTROL_LIFECYCLE_BROKER_INPUT_INVALID') `
        'normal removal conflicts with CompensateFirstInstall'

    $wrongRemoveHash = if ($removeExpectedHash -ceq ('0' * 64)) { '1' * 64 } else { '0' * 64 }
    $removeWrongHash = Invoke-SelfTestInstall -Script $script:install -InstalledRoot $script:installed `
        -Broker $removeBroker -Data $removeData -Shadow $removeShadow -RemoveCurrent `
        -ExpectedProfileHash $wrongRemoveHash
    $removeWrongHashEnvelope = ConvertFrom-SelfTestOutput $removeWrongHash.stdout
    Assert-SelfTest ($removeWrongHash.exitCode -ne 0 -and
        $removeWrongHashEnvelope.error.code -ceq 'DYSON_CONTROL_LIFECYCLE_BROKER_PROFILE_BINDING_MISMATCH' -and
        (Test-SelfTestFileBytesEqual $removeProfile $removeProfileBytes) -and
        (Test-SelfTestFileBytesEqual $removeTask $removeTaskBytes)) `
        'normal removal rejects a stale or mismatched expected profile hash'

    $removePendingId = [guid]::NewGuid().ToString('D')
    $removePendingRequest = New-DysonLifecycleBrokerRequest -BrokerRequestId $removePendingId `
        -Capability LifecycleStatus -ProfileHash $removeExpectedHash -Input ([pscustomobject][ordered]@{})
    $removePendingPaths = Get-DysonLifecycleBrokerRecordPaths $removeStorage $removePendingId
    [void](Write-DysonLifecycleBrokerJsonNew $removePendingPaths.request $removePendingRequest `
        $script:DysonLifecycleBrokerMaximumRequestBytes)
    $removePending = Invoke-SelfTestInstall -Script $script:install -InstalledRoot $script:installed `
        -Broker $removeBroker -Data $removeData -Shadow $removeShadow -RemoveCurrent `
        -ExpectedProfileHash $removeExpectedHash
    $removePendingEnvelope = ConvertFrom-SelfTestOutput $removePending.stdout
    Remove-DysonLifecycleBrokerPlainFile $removePendingPaths.request
    Assert-SelfTest ($removePending.exitCode -ne 0 -and
        $removePendingEnvelope.error.code -ceq 'DYSON_CONTROL_LIFECYCLE_BROKER_RECOVERY_REQUIRED' -and
        (Test-SelfTestFileBytesEqual $removeProfile $removeProfileBytes)) `
        'normal removal rejects a pending request'

    $removeIntentPath = Join-Path $removeStorage.intents (([guid]::NewGuid().ToString('D')) + '.json')
    Write-SelfTestJson $removeIntentPath ([ordered]@{ pending = $true })
    $removeIntent = Invoke-SelfTestInstall -Script $script:install -InstalledRoot $script:installed `
        -Broker $removeBroker -Data $removeData -Shadow $removeShadow -RemoveCurrent `
        -ExpectedProfileHash $removeExpectedHash
    $removeIntentEnvelope = ConvertFrom-SelfTestOutput $removeIntent.stdout
    Remove-DysonLifecycleBrokerPlainFile $removeIntentPath
    Assert-SelfTest ($removeIntent.exitCode -ne 0 -and
        $removeIntentEnvelope.error.code -ceq 'DYSON_CONTROL_LIFECYCLE_BROKER_RECOVERY_REQUIRED' -and
        (Test-SelfTestFileBytesEqual $removeTask $removeTaskBytes)) `
        'normal removal rejects every pending intent'

    $removeOrphanReceiptPath = Join-Path $removeStorage.receipts (([guid]::NewGuid().ToString('D')) + '.json')
    Write-SelfTestJson $removeOrphanReceiptPath ([ordered]@{ orphan = $true })
    $removeOrphan = Invoke-SelfTestInstall -Script $script:install -InstalledRoot $script:installed `
        -Broker $removeBroker -Data $removeData -Shadow $removeShadow -RemoveCurrent `
        -ExpectedProfileHash $removeExpectedHash
    $removeOrphanEnvelope = ConvertFrom-SelfTestOutput $removeOrphan.stdout
    Remove-DysonLifecycleBrokerPlainFile $removeOrphanReceiptPath
    Assert-SelfTest ($removeOrphan.exitCode -ne 0 -and
        $removeOrphanEnvelope.error.code -ceq 'DYSON_CONTROL_LIFECYCLE_BROKER_RECOVERY_REQUIRED' -and
        (Test-SelfTestFileBytesEqual $removeProfile $removeProfileBytes)) `
        'normal removal rejects an orphan receipt'

    $removeUnknownPath = Join-Path $removeStorage.requests 'unexpected.keep'
    [IO.File]::WriteAllText($removeUnknownPath, 'unknown', [Text.UTF8Encoding]::new($false))
    $removeUnknown = Invoke-SelfTestInstall -Script $script:install -InstalledRoot $script:installed `
        -Broker $removeBroker -Data $removeData -Shadow $removeShadow -RemoveCurrent `
        -ExpectedProfileHash $removeExpectedHash
    $removeUnknownEnvelope = ConvertFrom-SelfTestOutput $removeUnknown.stdout
    Remove-DysonLifecycleBrokerPlainFile $removeUnknownPath
    Assert-SelfTest ($removeUnknown.exitCode -ne 0 -and
        $removeUnknownEnvelope.error.code -ceq 'DYSON_CONTROL_LIFECYCLE_BROKER_RECOVERY_REQUIRED' -and
        (Test-SelfTestFileBytesEqual $removeTerminalPaths.request $removeRequestBytes)) `
        'normal removal fails closed on unknown storage state'

    $removeProfileRecord = Get-Content -Raw -LiteralPath $removeProfile | ConvertFrom-Json
    $removeProfileRecord.serviceUser = 'EXAMPLE\OtherUser'
    Write-SelfTestJson $removeProfile $removeProfileRecord
    $driftedRemoveProfileHash = Get-DysonLifecycleBrokerProfileHash $removeProfile
    $removeProfileDrift = Invoke-SelfTestInstall -Script $script:install -InstalledRoot $script:installed `
        -Broker $removeBroker -Data $removeData -Shadow $removeShadow -RemoveCurrent `
        -ExpectedProfileHash $driftedRemoveProfileHash
    [IO.File]::WriteAllBytes($removeProfile, $removeProfileBytes)
    $removeProfileDriftEnvelope = ConvertFrom-SelfTestOutput $removeProfileDrift.stdout
    Assert-SelfTest ($removeProfileDrift.exitCode -ne 0 -and
        $removeProfileDriftEnvelope.error.code -ceq 'DYSON_CONTROL_LIFECYCLE_BROKER_PROFILE_BINDING_MISMATCH' -and
        (Test-SelfTestFileBytesEqual $removeTask $removeTaskBytes)) `
        'normal removal rejects profile binding drift even when its current hash is acknowledged'

    $removeWorkerPath = Join-Path $script:brokerScripts 'Invoke-DysonLifecycleBrokerWorker.ps1'
    $removeWorkerBytes = [IO.File]::ReadAllBytes($removeWorkerPath)
    [IO.File]::AppendAllText($removeWorkerPath, "`n# removal dependency drift", [Text.UTF8Encoding]::new($false))
    $removeDependencyDrift = Invoke-SelfTestInstall -Script $script:install -InstalledRoot $script:installed `
        -Broker $removeBroker -Data $removeData -Shadow $removeShadow -RemoveCurrent `
        -ExpectedProfileHash $removeExpectedHash
    [IO.File]::WriteAllBytes($removeWorkerPath, $removeWorkerBytes)
    $removeDependencyDriftEnvelope = ConvertFrom-SelfTestOutput $removeDependencyDrift.stdout
    Assert-SelfTest ($removeDependencyDrift.exitCode -ne 0 -and
        $removeDependencyDriftEnvelope.error.code -ceq 'DYSON_CONTROL_LIFECYCLE_BROKER_HASH_DRIFT' -and
        (Test-SelfTestFileBytesEqual $removeProfile $removeProfileBytes)) `
        'normal removal rejects pinned dependency drift'

    [IO.File]::WriteAllText($removeProfileAcl, 'D:P(A;;GA;;;SY)(A;;GA;;;BA)', [Text.UTF8Encoding]::new($false))
    $removeProfileAclDrift = Invoke-SelfTestInstall -Script $script:install -InstalledRoot $script:installed `
        -Broker $removeBroker -Data $removeData -Shadow $removeShadow -RemoveCurrent `
        -ExpectedProfileHash $removeExpectedHash
    [IO.File]::WriteAllBytes($removeProfileAcl, $removeProfileAclBytes)
    $removeProfileAclDriftEnvelope = ConvertFrom-SelfTestOutput $removeProfileAclDrift.stdout
    Assert-SelfTest ($removeProfileAclDrift.exitCode -ne 0 -and
        $removeProfileAclDriftEnvelope.error.code -ceq 'DYSON_CONTROL_LIFECYCLE_BROKER_ACCESS_CONTROL_FAILED' -and
        (Test-SelfTestFileBytesEqual $removeProfile $removeProfileBytes)) `
        'normal removal rejects profile ACL drift'

    $removeTaskRecord = Get-Content -Raw -LiteralPath $removeTask | ConvertFrom-Json
    $removeTaskRecord.descriptor.description = 'drifted worker task'
    Write-SelfTestJson $removeTask $removeTaskRecord
    $removeTaskDrift = Invoke-SelfTestInstall -Script $script:install -InstalledRoot $script:installed `
        -Broker $removeBroker -Data $removeData -Shadow $removeShadow -RemoveCurrent `
        -ExpectedProfileHash $removeExpectedHash
    [IO.File]::WriteAllBytes($removeTask, $removeTaskBytes)
    $removeTaskDriftEnvelope = ConvertFrom-SelfTestOutput $removeTaskDrift.stdout
    Assert-SelfTest ($removeTaskDrift.exitCode -ne 0 -and
        $removeTaskDriftEnvelope.error.code -ceq 'DYSON_CONTROL_LIFECYCLE_BROKER_TASK_INVALID' -and
        (Test-SelfTestFileBytesEqual $removeProfile $removeProfileBytes)) `
        'normal removal rejects fixed worker task drift'

    $removeTaskAclRecord = Get-Content -Raw -LiteralPath $removeTask | ConvertFrom-Json
    $removeTaskAclRecord.sddl = 'D:P(A;;GA;;;SY)(A;;GA;;;BA)'
    Write-SelfTestJson $removeTask $removeTaskAclRecord
    $removeTaskAclDrift = Invoke-SelfTestInstall -Script $script:install -InstalledRoot $script:installed `
        -Broker $removeBroker -Data $removeData -Shadow $removeShadow -RemoveCurrent `
        -ExpectedProfileHash $removeExpectedHash
    [IO.File]::WriteAllBytes($removeTask, $removeTaskBytes)
    $removeTaskAclDriftEnvelope = ConvertFrom-SelfTestOutput $removeTaskAclDrift.stdout
    Assert-SelfTest ($removeTaskAclDrift.exitCode -ne 0 -and
        $removeTaskAclDriftEnvelope.error.code -ceq 'DYSON_CONTROL_LIFECYCLE_BROKER_ACCESS_CONTROL_FAILED' -and
        (Test-SelfTestFileBytesEqual $removeProfileAcl $removeProfileAclBytes)) `
        'normal removal rejects fixed worker task ACL drift'

    $removeServerTask = Join-Path $removeShadow 'server-task.json'
    $removeServerTaskBytes = [IO.File]::ReadAllBytes($removeServerTask)
    $removeServerTaskRecord = Get-Content -Raw -LiteralPath $removeServerTask | ConvertFrom-Json
    $removeServerTaskRecord.descriptor.name = 'Not-Dyson-Server'
    Write-SelfTestJson $removeServerTask $removeServerTaskRecord
    $removeRuntimeTaskDrift = Invoke-SelfTestInstall -Script $script:install -InstalledRoot $script:installed `
        -Broker $removeBroker -Data $removeData -Shadow $removeShadow -RemoveCurrent `
        -ExpectedProfileHash $removeExpectedHash
    [IO.File]::WriteAllBytes($removeServerTask, $removeServerTaskBytes)
    $removeRuntimeTaskDriftEnvelope = ConvertFrom-SelfTestOutput $removeRuntimeTaskDrift.stdout
    Assert-SelfTest ($removeRuntimeTaskDrift.exitCode -ne 0 -and
        $removeRuntimeTaskDriftEnvelope.error.code -ceq 'DYSON_CONTROL_LIFECYCLE_BROKER_TASK_INVALID' -and
        (Test-SelfTestFileBytesEqual $removeTask $removeTaskBytes)) `
        'normal removal rejects pinned runtime task drift'

    $removeRollbackStages = @(
        'after-candidate-validated', 'after-old-snapshot', 'after-task-disabled',
        'after-task-removed', 'after-profile-removed', 'after-final-verified'
    )
    foreach ($removeFailureStage in $removeRollbackStages) {
        Set-SelfTestInstallerFailureStage -Shadow $removeShadow -Stage $removeFailureStage
        $failedRemoval = Invoke-SelfTestInstall -Script $script:install -InstalledRoot $script:installed `
            -Broker $removeBroker -Data $removeData -Shadow $removeShadow -RemoveCurrent `
            -ExpectedProfileHash $removeExpectedHash
        $failedRemovalEnvelope = ConvertFrom-SelfTestOutput $failedRemoval.stdout
        Assert-SelfTest ($failedRemoval.exitCode -ne 0 -and
            $failedRemovalEnvelope.error.code -ceq 'DYSON_CONTROL_LIFECYCLE_BROKER_INSTALL_FAILED' -and
            (Test-SelfTestFileBytesEqual $removeProfile $removeProfileBytes) -and
            (Test-SelfTestFileBytesEqual $removeTask $removeTaskBytes) -and
            (Test-SelfTestFileBytesEqual $removeProfileAcl $removeProfileAclBytes) -and
            (Test-SelfTestFileBytesEqual $removeTerminalPaths.request $removeRequestBytes) -and
            (Test-SelfTestFileBytesEqual $removeTerminalPaths.receipt $removeReceiptBytes) -and
            (Test-SelfTestFileBytesEqual $removeAuditSentinel $removeAuditBytes) -and
            (Test-SelfTestFileBytesEqual $removeBrokerSentinel $removeBrokerSentinelBytes) -and
            (Test-SelfTestFileBytesEqual $removeNeighborSentinel $removeNeighborSentinelBytes)) `
            ('normal removal rollback restores exact snapshot at ' + $removeFailureStage)
    }
    Set-SelfTestInstallerFailureStage -Shadow $removeShadow -Stage 'none'

    $normalRemoval = Invoke-SelfTestInstall -Script $script:install -InstalledRoot $script:installed `
        -Broker $removeBroker -Data $removeData -Shadow $removeShadow -RemoveCurrent `
        -ExpectedProfileHash $removeExpectedHash
    $normalRemovalEnvelope = ConvertFrom-SelfTestOutput $normalRemoval.stdout
    $normalRemovalProperties = @(
        'protocol', 'schemaVersion', 'operation', 'brokerRoot', 'removedProfileHash', 'workerTaskName',
        'workerTaskPath', 'profileRemoved', 'taskRemoved', 'preservedRequestCount',
        'preservedReceiptCount', 'intentsEmpty', 'backend', 'removedAt'
    )
    $normalRemovalPropertyDelta = @(Compare-Object -ReferenceObject $normalRemovalProperties `
        -DifferenceObject @($normalRemovalEnvelope.PSObject.Properties.Name))
    Assert-SelfTest ($normalRemoval.exitCode -eq 0 -and
        $normalRemovalEnvelope.protocol -ceq 'DYSON_CONTROL_LIFECYCLE_BROKER_REMOVAL_RECEIPT_V1' -and
        [int]$normalRemovalEnvelope.schemaVersion -eq 1 -and $normalRemovalEnvelope.operation -ceq 'removed-current' -and
        [string]$normalRemovalEnvelope.removedProfileHash -ceq $removeExpectedHash -and
        $normalRemovalEnvelope.profileRemoved -and $normalRemovalEnvelope.taskRemoved -and
        [int]$normalRemovalEnvelope.preservedRequestCount -eq 1 -and
        [int]$normalRemovalEnvelope.preservedReceiptCount -eq 1 -and $normalRemovalEnvelope.intentsEmpty -and
        $normalRemovalEnvelope.backend -ceq 'Shadow' -and $normalRemovalPropertyDelta.Count -eq 0 -and
        $normalRemoval.stdout.Length -lt 4096 -and
        -not (Test-Path -LiteralPath $removeProfile) -and -not (Test-Path -LiteralPath $removeTask) -and
        -not (Test-Path -LiteralPath $removeProfileAcl) -and
        (Test-Path -LiteralPath $removeStorage.requests -PathType Container) -and
        (Test-Path -LiteralPath $removeStorage.receipts -PathType Container) -and
        (Test-Path -LiteralPath $removeStorage.intents -PathType Container) -and
        (Test-SelfTestFileBytesEqual $removeTerminalPaths.request $removeRequestBytes) -and
        (Test-SelfTestFileBytesEqual $removeTerminalPaths.receipt $removeReceiptBytes) -and
        (Test-SelfTestFileBytesEqual $removeAuditSentinel $removeAuditBytes) -and
        (Test-SelfTestFileBytesEqual $removeBrokerSentinel $removeBrokerSentinelBytes) -and
        (Test-SelfTestFileBytesEqual $removeNeighborSentinel $removeNeighborSentinelBytes) -and
        (Test-SelfTestFileBytesEqual $removeServerTask $removeServerTaskBytes) -and
        (Test-SelfTestFileBytesEqual $script:profileFile $profileBytes)) `
        'normal removal emits bounded receipt and preserves history audit sentinels runtime tasks and other installs'

    # Stage a second fictional release without modifying the first release's pinned dependencies.
    $candidateInstalled = Join-Path $script:root 'candidate-release\scripts\windows'
    $candidateBrokerScripts = Join-Path $candidateInstalled 'lifecycle-broker'
    [void][IO.Directory]::CreateDirectory($candidateBrokerScripts)
    foreach ($name in @(
        'DysonLifecycleBroker.Common.ps1', 'DysonLifecycleBroker.TaskAcl.ps1',
        'Install-DysonLifecycleBrokerTask.ps1', 'Invoke-DysonLifecycleBrokerWorker.ps1',
        'Submit-DysonLifecycleBrokerRequest.ps1', 'SelfTest-DysonLifecycleBroker.ps1'
    )) { Copy-Item -LiteralPath (Join-Path $script:brokerScripts $name) -Destination (Join-Path $candidateBrokerScripts $name) }
    Copy-Item -LiteralPath (Join-Path $script:installed 'DysonHostMutationLease.Common.ps1') `
        -Destination (Join-Path $candidateInstalled 'DysonHostMutationLease.Common.ps1')
    [IO.File]::AppendAllText((Join-Path $candidateBrokerScripts 'DysonLifecycleBroker.Common.ps1'),
        "`n# fictional cross-release candidate", [Text.UTF8Encoding]::new($false))
    $candidateInstall = Join-Path $candidateBrokerScripts 'Install-DysonLifecycleBrokerTask.ps1'

    $implicit = Invoke-SelfTestInstall -Script $candidateInstall -InstalledRoot $candidateInstalled `
        -Broker $script:broker -Data $script:data -Shadow $script:shadow
    $implicitEnvelope = ConvertFrom-SelfTestOutput $implicit.stdout
    Assert-SelfTest ($implicit.exitCode -ne 0 -and
        $implicitEnvelope.error.code -ceq 'DYSON_CONTROL_LIFECYCLE_BROKER_REQUEST_CONFLICT' -and
        (Test-SelfTestBytesEqual $profileBytes ([IO.File]::ReadAllBytes($script:profileFile)))) `
        'cross-release replacement requires UpgradeExisting'

    $storage = Get-DysonLifecycleBrokerStorage $script:broker
    $pendingId = [guid]::NewGuid().ToString('D')
    $pendingRequest = New-DysonLifecycleBrokerRequest -BrokerRequestId $pendingId -Capability LifecycleStatus `
        -ProfileHash (Get-DysonLifecycleBrokerProfileHash $script:profileFile) -Input ([pscustomobject][ordered]@{})
    $pendingPaths = Get-DysonLifecycleBrokerRecordPaths $storage $pendingId
    [void](Write-DysonLifecycleBrokerJsonNew $pendingPaths.request $pendingRequest $script:DysonLifecycleBrokerMaximumRequestBytes)
    $pendingUpgrade = Invoke-SelfTestInstall -Script $candidateInstall -InstalledRoot $candidateInstalled `
        -Broker $script:broker -Data $script:data -Shadow $script:shadow -UpgradeExisting
    $pendingEnvelope = ConvertFrom-SelfTestOutput $pendingUpgrade.stdout
    Assert-SelfTest ($pendingUpgrade.exitCode -ne 0 -and
        $pendingEnvelope.error.code -ceq 'DYSON_CONTROL_LIFECYCLE_BROKER_RECOVERY_REQUIRED' -and
        (Test-SelfTestBytesEqual $profileBytes ([IO.File]::ReadAllBytes($script:profileFile)))) `
        'upgrade rejects request without terminal receipt'
    Remove-DysonLifecycleBrokerPlainFile $pendingPaths.request

    $intentId = [guid]::NewGuid().ToString('D')
    $intentPath = Join-Path $storage.intents ($intentId + '.json')
    Write-SelfTestJson $intentPath ([ordered]@{ pending = $true })
    $intentUpgrade = Invoke-SelfTestInstall -Script $candidateInstall -InstalledRoot $candidateInstalled `
        -Broker $script:broker -Data $script:data -Shadow $script:shadow -UpgradeExisting
    $intentEnvelope = ConvertFrom-SelfTestOutput $intentUpgrade.stdout
    Assert-SelfTest ($intentUpgrade.exitCode -ne 0 -and
        $intentEnvelope.error.code -ceq 'DYSON_CONTROL_LIFECYCLE_BROKER_RECOVERY_REQUIRED' -and
        (Test-SelfTestBytesEqual $profileBytes ([IO.File]::ReadAllBytes($script:profileFile)))) `
        'upgrade rejects every pending intent'
    Remove-DysonLifecycleBrokerPlainFile $intentPath

    $shadowTaskFile = Join-Path $script:shadow 'broker-task.json'
    $shadowAclFile = Join-Path $script:shadow 'broker-profile.sddl'
    $taskBytes = [IO.File]::ReadAllBytes($shadowTaskFile)
    $aclBytes = [IO.File]::ReadAllBytes($shadowAclFile)
    $taskRecord = Get-Content -Raw -LiteralPath $shadowTaskFile | ConvertFrom-Json
    $taskRecord.sddl = 'D:P(A;;GA;;;SY)(A;;GA;;;BA)'
    Write-SelfTestJson $shadowTaskFile $taskRecord
    $tamperedAcl = Invoke-SelfTestInstall -Script $candidateInstall -InstalledRoot $candidateInstalled `
        -Broker $script:broker -Data $script:data -Shadow $script:shadow -UpgradeExisting
    $tamperedAclEnvelope = ConvertFrom-SelfTestOutput $tamperedAcl.stdout
    Assert-SelfTest ($tamperedAcl.exitCode -ne 0 -and
        $tamperedAclEnvelope.error.code -ceq 'DYSON_CONTROL_LIFECYCLE_BROKER_ACCESS_CONTROL_FAILED' -and
        (Test-SelfTestBytesEqual $profileBytes ([IO.File]::ReadAllBytes($script:profileFile))) ) `
        'upgrade rejects tampered old task DACL'
    [IO.File]::WriteAllBytes($shadowTaskFile, $taskBytes)

    $oldCommon = Join-Path $script:brokerScripts 'DysonLifecycleBroker.Common.ps1'
    $oldCommonBytes = [IO.File]::ReadAllBytes($oldCommon)
    [IO.File]::AppendAllText($oldCommon, "`n# tampered old release", [Text.UTF8Encoding]::new($false))
    $tamperedDependency = Invoke-SelfTestInstall -Script $candidateInstall -InstalledRoot $candidateInstalled `
        -Broker $script:broker -Data $script:data -Shadow $script:shadow -UpgradeExisting
    $tamperedDependencyEnvelope = ConvertFrom-SelfTestOutput $tamperedDependency.stdout
    Assert-SelfTest ($tamperedDependency.exitCode -ne 0 -and
        $tamperedDependencyEnvelope.error.code -ceq 'DYSON_CONTROL_LIFECYCLE_BROKER_HASH_DRIFT' -and
        (Test-SelfTestBytesEqual $profileBytes ([IO.File]::ReadAllBytes($script:profileFile)))) `
        'upgrade rejects tampered old dependency'
    [IO.File]::WriteAllBytes($oldCommon, $oldCommonBytes)

    $upgradeReparseTested = $false; $upgradeReparseRejected = $false
    try {
        $bootstrapLink = Join-Path $script:root 'upgrade-bootstrap-reparse'
        [void](New-Item -ItemType Junction -Path $bootstrapLink -Target $script:installed -ErrorAction Stop)
        $upgradeReparseTested = $true
        $reparseUpgrade = Invoke-SelfTestInstall -Script $candidateInstall -InstalledRoot $candidateInstalled `
            -Broker $script:broker -Data $script:data -Shadow $script:shadow -BootstrapRoot $bootstrapLink -UpgradeExisting
        $reparseEnvelope = ConvertFrom-SelfTestOutput $reparseUpgrade.stdout
        $upgradeReparseRejected = $reparseUpgrade.exitCode -ne 0 -and
            $reparseEnvelope.error.code -ceq 'DYSON_CONTROL_LIFECYCLE_BROKER_PATH_INVALID'
    }
    catch { }
    Assert-SelfTest ((-not $upgradeReparseTested) -or ($upgradeReparseRejected -and
        (Test-SelfTestBytesEqual $profileBytes ([IO.File]::ReadAllBytes($script:profileFile))))) `
        'upgrade rejects reparse-point candidate root'

    $rollbackStages = @(
        'after-old-snapshot', 'after-task-disabled', 'after-profile-published',
        'after-task-registered', 'after-task-acl', 'after-final-verified'
    )
    foreach ($failureStage in $rollbackStages) {
        Set-SelfTestInstallerFailureStage -Shadow $script:shadow -Stage $failureStage
        $failedUpgrade = Invoke-SelfTestInstall -Script $candidateInstall -InstalledRoot $candidateInstalled `
            -Broker $script:broker -Data $script:data -Shadow $script:shadow -UpgradeExisting
        $failedEnvelope = ConvertFrom-SelfTestOutput $failedUpgrade.stdout
        Assert-SelfTest ($failedUpgrade.exitCode -ne 0 -and
            $failedEnvelope.error.code -ceq 'DYSON_CONTROL_LIFECYCLE_BROKER_INSTALL_FAILED' -and
            (Test-SelfTestBytesEqual $profileBytes ([IO.File]::ReadAllBytes($script:profileFile)) ) -and
            (Test-SelfTestBytesEqual $taskBytes ([IO.File]::ReadAllBytes($shadowTaskFile)) ) -and
            (Test-SelfTestBytesEqual $aclBytes ([IO.File]::ReadAllBytes($shadowAclFile)) ) ) `
            ('upgrade rollback restores exact snapshot at ' + $failureStage)
    }
    Set-SelfTestInstallerFailureStage -Shadow $script:shadow -Stage 'none'
    $upgrade = Invoke-SelfTestInstall -Script $candidateInstall -InstalledRoot $candidateInstalled `
        -Broker $script:broker -Data $script:data -Shadow $script:shadow -UpgradeExisting
    $upgradeEnvelope = ConvertFrom-SelfTestOutput $upgrade.stdout
    $upgradedProfile = Read-DysonLifecycleBrokerProfile $script:profileFile
    $upgradedTask = Get-Content -Raw -LiteralPath $shadowTaskFile | ConvertFrom-Json
    Assert-SelfTest ($upgrade.exitCode -eq 0 -and $upgradeEnvelope.operation -ceq 'upgraded' -and $upgradeEnvelope.upgraded -and
        (Test-DysonLifecycleBrokerSamePath $upgradedProfile.brokerScriptRoot $candidateBrokerScripts) -and
        [string]$upgradedProfile.createdAt -cne [string]$initialProfile.createdAt -and [bool]$upgradedTask.enabled -and
        [string]$upgradedTask.sddl -ceq (Get-DysonLifecycleBrokerTaskSddl) -and
        [string]$upgradedTask.descriptor.arguments -match [regex]::Escape($candidateBrokerScripts)) `
        'explicit cross-release upgrade publishes candidate profile task and DACL'

    $upgradedBytes = [IO.File]::ReadAllBytes($script:profileFile)
    $candidateReplay = Invoke-SelfTestInstall -Script $candidateInstall -InstalledRoot $candidateInstalled `
        -Broker $script:broker -Data $script:data -Shadow $script:shadow
    $candidateReplayEnvelope = ConvertFrom-SelfTestOutput $candidateReplay.stdout
    Assert-SelfTest ($candidateReplay.exitCode -eq 0 -and $candidateReplayEnvelope.operation -ceq 'reused' -and
        [string]$candidateReplayEnvelope.profileCreatedAt -ceq [string]$upgradedProfile.createdAt -and
        (Test-SelfTestBytesEqual $upgradedBytes ([IO.File]::ReadAllBytes($script:profileFile)))) `
        'upgraded release replay preserves profile bytes and createdAt'
    $script:brokerScripts = $candidateBrokerScripts
    $script:install = $candidateInstall
    $script:submit = Join-Path $candidateBrokerScripts 'Submit-DysonLifecycleBrokerRequest.ps1'

    $script:stage = 'process executable aliases'
    $executableAliasRoot = Join-Path $script:root 'runtime-executable-alias'
    $differentExecutableRoot = Join-Path $script:root 'different-runtime-executable'
    [void][IO.Directory]::CreateDirectory($differentExecutableRoot)
    $differentExecutable = Join-Path $differentExecutableRoot 'DSPGAME.exe'
    [IO.File]::WriteAllBytes($differentExecutable, [IO.File]::ReadAllBytes((Join-Path $script:project 'server\DSPGAME.exe')))
    try {
        [void](New-Item -ItemType Junction -Path $executableAliasRoot -Target (Join-Path $script:project 'server') -ErrorAction Stop)
        Set-SelfTestRuntime running
        $runtimePath = Join-Path $script:shadow 'runtime.json'
        $aliasRuntime = [IO.File]::ReadAllText($runtimePath) | ConvertFrom-Json
        foreach ($case in @(
            @{ path = (Join-Path $executableAliasRoot 'DSPGAME.exe'); expected = 'running_verified'; name = 'final-path executable alias' },
            @{ path = $differentExecutable; expected = 'unknown_unverifiable'; name = 'distinct same-name same-content executable' },
            @{ path = (Join-Path $executableAliasRoot 'missing.exe'); expected = 'unknown_unverifiable'; name = 'unresolvable executable path' }
        )) {
            $aliasRuntime.processes[0].path = $case.path
            Write-SelfTestJson $runtimePath $aliasRuntime
            $aliasStatus = Invoke-SelfTestSubmit -Id ([guid]::NewGuid().ToString('D')) -Capability LifecycleStatus
            $aliasEnvelope = ConvertFrom-SelfTestOutput $aliasStatus.stdout
            Assert-SelfTest ($aliasStatus.exitCode -eq 0 -and $aliasEnvelope.receipt.status -ceq 'succeeded' -and
                $aliasEnvelope.receipt.evidence.lifecycleState -ceq $case.expected) `
                ('worker process binding: ' + $case.name)
        }
    }
    finally {
        Set-SelfTestRuntime stopped
        if (Test-Path -LiteralPath $executableAliasRoot) { [IO.Directory]::Delete($executableAliasRoot, $false) }
    }

    $preflightId = [guid]::NewGuid().ToString('D')
    $preflight = Invoke-SelfTestSubmit -Id $preflightId -Capability LifecyclePreflight -Action start
    $preflightEnvelope = ConvertFrom-SelfTestOutput $preflight.stdout
    Assert-SelfTest ($preflight.exitCode -eq 0 -and $preflightEnvelope.receipt.status -ceq 'succeeded' -and $preflightEnvelope.receipt.evidence.allowed) 'preflight capability'

    $statusId = [guid]::NewGuid().ToString('D')
    $status = Invoke-SelfTestSubmit -Id $statusId -Capability LifecycleStatus
    $statusEnvelope = ConvertFrom-SelfTestOutput $status.stdout
    Assert-SelfTest ($status.exitCode -eq 0 -and $statusEnvelope.receipt.evidence.lifecycleState -ceq 'stopped_verified') 'status stopped verified'

    $verifyId = [guid]::NewGuid().ToString('D')
    $verify = Invoke-SelfTestSubmit -Id $verifyId -Capability LifecycleVerify -Expected stopped
    $verifyEnvelope = ConvertFrom-SelfTestOutput $verify.stdout
    Assert-SelfTest ($verify.exitCode -eq 0 -and $verifyEnvelope.receipt.evidence.matched) 'verify capability'

    $script:stage = 'IgnoreNew durable retry'
    $recordTriggers = Join-Path $script:shadow '.dyson-lifecycle-broker-record-triggers'
    $ignoreNextTrigger = Join-Path $script:shadow '.dyson-lifecycle-broker-ignore-next-trigger'
    $triggerLog = Join-Path $script:shadow 'worker-trigger.log'
    [IO.File]::WriteAllText($recordTriggers, 'record', [Text.UTF8Encoding]::new($false))
    [IO.File]::WriteAllText($ignoreNextTrigger, 'ignore', [Text.UTF8Encoding]::new($false))
    $ignoreNewId = [guid]::NewGuid().ToString('D')
    $ignoreNewPaths = Get-DysonLifecycleBrokerRecordPaths (Get-DysonLifecycleBrokerStorage $script:broker) $ignoreNewId
    $ignoreNew = Invoke-SelfTestSubmit -Id $ignoreNewId -Capability LifecycleStatus -TimeoutSeconds 5
    $ignoreNewEnvelope = ConvertFrom-SelfTestOutput $ignoreNew.stdout
    $triggerCount = if (Test-Path -LiteralPath $triggerLog -PathType Leaf) { @(Get-Content -LiteralPath $triggerLog).Count } else { 0 }
    Assert-SelfTest ($ignoreNew.exitCode -eq 0 -and $null -ne $ignoreNewEnvelope -and
        $null -ne $ignoreNewEnvelope.PSObject.Properties['receipt'] -and
        $ignoreNewEnvelope.receipt.status -ceq 'succeeded' -and $triggerCount -eq 2 -and
        -not (Test-Path -LiteralPath $ignoreNextTrigger) -and
        (Test-Path -LiteralPath $ignoreNewPaths.request -PathType Leaf) -and
        (Test-Path -LiteralPath $ignoreNewPaths.receipt -PathType Leaf)) `
        'IgnoreNew trigger loss recovers the durable request with one bounded retry'
    Remove-DysonLifecycleBrokerPlainFile $recordTriggers

    $previewId = [guid]::NewGuid().ToString('D')
    $preview = Invoke-SelfTestSubmit -Id $previewId -Capability LifecycleDispatch -Operation start -WhatIf
    $previewEnvelope = ConvertFrom-SelfTestOutput $preview.stdout
    Assert-SelfTest ($preview.exitCode -eq 0 -and $previewEnvelope.dryRun -and -not (Test-Path (Join-Path $script:broker ('requests\' + $previewId + '.json')))) 'dispatch dry-run writes nothing'

    $dispatchLog = Join-Path $script:shadow 'dispatch.log'
    $dispatchId = [guid]::NewGuid().ToString('D')
    $dispatch = Invoke-SelfTestSubmit -Id $dispatchId -Capability LifecycleDispatch -Operation start
    $dispatchEnvelope = ConvertFrom-SelfTestOutput $dispatch.stdout
    Assert-SelfTest ($dispatch.exitCode -eq 0 -and $dispatchEnvelope.receipt.status -ceq 'succeeded' -and
        (Get-Content -Raw $dispatchLog).Trim() -ceq 'Dyson-Nebula-Server') 'dispatch fixed start task'
    $replay = Invoke-SelfTestSubmit -Id $dispatchId -Capability LifecycleDispatch -Operation start
    $replayEnvelope = ConvertFrom-SelfTestOutput $replay.stdout
    Assert-SelfTest ($replay.exitCode -eq 0 -and $replayEnvelope.reused -and
        @((Get-Content $dispatchLog)).Count -eq 1) 'exact replay is idempotent'
    $conflict = Invoke-SelfTestSubmit -Id $dispatchId -Capability LifecycleDispatch -Operation graceful-stop
    $conflictEnvelope = ConvertFrom-SelfTestOutput $conflict.stdout
    Assert-SelfTest ($conflict.exitCode -ne 0 -and $conflictEnvelope.error.code -ceq 'DYSON_CONTROL_LIFECYCLE_BROKER_REQUEST_CONFLICT') 'idempotency conflict'

    Set-SelfTestRuntime stopped -Session missing
    $missingSession = Invoke-SelfTestSubmit -Id ([guid]::NewGuid().ToString('D')) -Capability LifecyclePreflight -Action start
    $missingEnvelope = ConvertFrom-SelfTestOutput $missingSession.stdout
    Assert-SelfTest ('interactive_session_missing' -cin @($missingEnvelope.receipt.evidence.blockers)) `
        ('interactive session blocker [' + (@($missingEnvelope.receipt.evidence.blockers) -join ',') + ';' + [string]$missingEnvelope.receipt.errorCode + ']')
    Set-SelfTestRuntime stopped -Steam missing
    $missingSteam = Invoke-SelfTestSubmit -Id ([guid]::NewGuid().ToString('D')) -Capability LifecyclePreflight -Action start
    $steamEnvelope = ConvertFrom-SelfTestOutput $missingSteam.stdout
    Assert-SelfTest ('steam_session_missing' -cin @($steamEnvelope.receipt.evidence.blockers)) `
        ('Steam same-session blocker [' + (@($steamEnvelope.receipt.evidence.blockers) -join ',') + ';' + [string]$steamEnvelope.receipt.errorCode + ']')
    Set-SelfTestRuntime stopped -Session ambiguous
    $ambiguous = Invoke-SelfTestSubmit -Id ([guid]::NewGuid().ToString('D')) -Capability LifecyclePreflight -Action start
    $ambiguousEnvelope = ConvertFrom-SelfTestOutput $ambiguous.stdout
    Assert-SelfTest ('session_ambiguous' -cin @($ambiguousEnvelope.receipt.evidence.blockers)) `
        ('session ambiguous blocker [' + (@($ambiguousEnvelope.receipt.evidence.blockers) -join ',') + ';' + [string]$ambiguousEnvelope.receipt.errorCode + ']')
    Set-SelfTestRuntime unknown
    $unknown = Invoke-SelfTestSubmit -Id ([guid]::NewGuid().ToString('D')) -Capability LifecycleStatus
    $unknownEnvelope = ConvertFrom-SelfTestOutput $unknown.stdout
    Assert-SelfTest ($unknownEnvelope.receipt.evidence.lifecycleState -ceq 'unknown_unverifiable') 'process unknown is not stopped'

    $script:stage = 'lease loss'
    Set-SelfTestRuntime stopped
    Set-SelfTestLease -LoseAfterChecks 1
    if (Test-Path $dispatchLog) { Remove-Item $dispatchLog -Force }
    $leaseLoss = Invoke-SelfTestSubmit -Id ([guid]::NewGuid().ToString('D')) -Capability LifecycleDispatch -Operation start
    $leaseEnvelope = ConvertFrom-SelfTestOutput $leaseLoss.stdout
    Assert-SelfTest ($leaseEnvelope.receipt.status -ceq 'failed' -and
        $leaseEnvelope.receipt.errorCode -ceq 'DYSON_CONTROL_LIFECYCLE_BROKER_LEASE_INVALID' -and
        -not (Test-Path $dispatchLog)) 'lease loss prevents dispatch'
    Set-SelfTestLease

    $script:stage = 'ready timeout'
    Write-SelfTestJson (Join-Path $script:shadow 'dispatch-control.json') ([ordered]@{ readyTimeout = $true })
    $readyTimeout = Invoke-SelfTestSubmit -Id ([guid]::NewGuid().ToString('D')) -Capability LifecycleDispatch -Operation start -TimeoutSeconds 15
    $readyEnvelope = ConvertFrom-SelfTestOutput $readyTimeout.stdout
    Assert-SelfTest ($readyEnvelope.receipt.errorCode -ceq 'DYSON_CONTROL_LIFECYCLE_BROKER_READY_TIMEOUT') 'bounded Ready timeout'
    Write-SelfTestJson (Join-Path $script:shadow 'dispatch-control.json') ([ordered]@{ readyTimeout = $false })
    Write-SelfTestJson (Join-Path $script:shadow 'server-task.json') ([ordered]@{ descriptor = $serverDescriptor; state = 'Ready' })

    # A durable read-only intent is safe to replay; a dispatch intent is reconciled from authority evidence.
    $script:stage = 'intent recovery'
    . (Join-Path $script:brokerScripts 'DysonLifecycleBroker.Common.ps1')
    $profile = Read-DysonLifecycleBrokerProfile $script:profileFile
    $storage = Get-DysonLifecycleBrokerStorage $script:broker
    $intentId = [guid]::NewGuid().ToString('D')
    $intentRequest = New-DysonLifecycleBrokerRequest -BrokerRequestId $intentId -Capability LifecycleStatus `
        -ProfileHash (Get-DysonLifecycleBrokerProfileHash $script:profileFile) -Input ([pscustomobject][ordered]@{})
    $intentPaths = Get-DysonLifecycleBrokerRecordPaths $storage $intentId
    [void](Write-DysonLifecycleBrokerJsonNew $intentPaths.request $intentRequest $script:DysonLifecycleBrokerMaximumRequestBytes)
    [void](Write-DysonLifecycleBrokerJsonNew $intentPaths.intent ([ordered]@{
        protocol = $script:DysonLifecycleBrokerIntentProtocol; schemaVersion = 1; brokerRequestId = $intentId
        requestFingerprint = $intentRequest.requestFingerprint; capability = 'LifecycleStatus'; input = $intentRequest.input
        createdAt = (Get-Date).ToUniversalTime().ToString('o')
    }) $script:DysonLifecycleBrokerMaximumIntentBytes)
    $intentRun = Invoke-SelfTestSubmit -Id $intentId -Capability LifecycleStatus
    $intentEnvelope = ConvertFrom-SelfTestOutput $intentRun.stdout
    Assert-SelfTest ($intentRun.exitCode -eq 0 -and $intentEnvelope.receipt.status -ceq 'succeeded' -and -not (Test-Path $intentPaths.intent)) 'read-only intent interruption replay'

    Set-SelfTestRuntime running
    $recoverId = [guid]::NewGuid().ToString('D')
    $recoverRequest = New-DysonLifecycleBrokerRequest -BrokerRequestId $recoverId -Capability LifecycleDispatch `
        -ProfileHash (Get-DysonLifecycleBrokerProfileHash $script:profileFile) -Input ([pscustomobject][ordered]@{
            operation = 'start'; leaseInstanceId = $script:leaseId; leaseToken = $script:leaseBorrowFixture
        })
    $recoverPaths = Get-DysonLifecycleBrokerRecordPaths $storage $recoverId
    [void](Write-DysonLifecycleBrokerJsonNew $recoverPaths.request $recoverRequest $script:DysonLifecycleBrokerMaximumRequestBytes)
    [void](Write-DysonLifecycleBrokerJsonNew $recoverPaths.intent ([ordered]@{
        protocol = $script:DysonLifecycleBrokerIntentProtocol; schemaVersion = 1; brokerRequestId = $recoverId
        requestFingerprint = $recoverRequest.requestFingerprint; capability = 'LifecycleDispatch'; input = $recoverRequest.input
        createdAt = (Get-Date).ToUniversalTime().ToString('o')
    }) $script:DysonLifecycleBrokerMaximumIntentBytes)
    if (Test-Path $dispatchLog) { Remove-Item $dispatchLog -Force }
    $recovered = Invoke-SelfTestSubmit -Id $recoverId -Capability LifecycleDispatch -Operation start
    $recoveredEnvelope = ConvertFrom-SelfTestOutput $recovered.stdout
    Assert-SelfTest ($recoveredEnvelope.receipt.status -ceq 'succeeded' -and $recoveredEnvelope.receipt.evidence.recovered -and
        -not (Test-Path $dispatchLog)) 'dispatch intent crash reconciliation'

    $script:stage = 'ACL and source audit'
    $aclIntent = Get-DysonLifecycleBrokerAclIntent 'S-1-5-19'
    $taskAcl = Get-DysonLifecycleBrokerTaskAclIntent
    $nativeAcl = Assert-DysonLifecycleBrokerTaskAclIntent 'D:PAI(A;;FA;;;SY)(A;;FA;;;BA)(A;;0x1200a9;;;LS)'
    Assert-SelfTest (-not $nativeAcl.localServiceWrite) 'native mapped task rights retain the declared access'
    $extraRightsRejected = $false
    try { [void](Assert-DysonLifecycleBrokerTaskAclIntent 'D:P(A;;FA;;;SY)(A;;FA;;;BA)(A;;FA;;;LS)') }
    catch { $extraRightsRejected = $true }
    Assert-SelfTest $extraRightsRejected 'mapped task rights reject extra Local Service write access'
    Assert-SelfTest (($aclIntent.intents -join '|') -notmatch 'LocalService' -and $taskAcl.localServiceWrite -eq $false -and
        $taskAcl.localServiceDelete -eq $false) 'protected ACL intent'

    $submitSource = Get-Content -Raw $script:submit
    $sourceTokens = $null; $sourceErrors = $null
    $ast = [Management.Automation.Language.Parser]::ParseInput($submitSource, [ref]$sourceTokens, [ref]$sourceErrors)
    $paramNames = @($ast.ParamBlock.Parameters.Name.VariablePath.UserPath)
    $badParameterCount = (@('TaskName', 'TaskPath', 'ScriptPath', 'Command', 'Port', 'Sid') |
        Where-Object { $_ -cin $paramNames } | Measure-Object).Count
    Assert-SelfTest ($badParameterCount -eq 0) 'no arbitrary command/task/path/sid/port input'
    Assert-SelfTest ($submitSource -notmatch 'Invoke-Expression|\biex\b|\bcmd(?:\.exe)?\b') 'no arbitrary command execution'

    # Exact descriptor pinning rejects a fixed-task substitution before dispatch.
    $script:stage = 'fixed task selection'
    Set-SelfTestRuntime stopped
    $badDescriptor = [ordered]@{} + $serverDescriptor
    $badDescriptor.name = 'Not-Dyson-Server'
    Write-SelfTestJson (Join-Path $script:shadow 'server-task.json') ([ordered]@{ descriptor = $badDescriptor; state = 'Ready' })
    if (Test-Path $dispatchLog) { Remove-Item $dispatchLog -Force }
    $fixedTask = Invoke-SelfTestSubmit -Id ([guid]::NewGuid().ToString('D')) -Capability LifecycleDispatch -Operation start
    $fixedEnvelope = ConvertFrom-SelfTestOutput $fixedTask.stdout
    $fixedSelectionRejected = ($fixedEnvelope.receipt.status -ceq 'blocked' -and
        'task_definition_mismatch' -cin @($fixedEnvelope.receipt.evidence.blockers)) -or
        ($fixedEnvelope.receipt.status -ceq 'failed' -and
        $fixedEnvelope.receipt.errorCode -ceq 'DYSON_CONTROL_LIFECYCLE_BROKER_TASK_INVALID')
    Assert-SelfTest ($fixedSelectionRejected -and -not (Test-Path $dispatchLog)) 'fixed task selection only'
    Write-SelfTestJson (Join-Path $script:shadow 'server-task.json') ([ordered]@{ descriptor = $serverDescriptor; state = 'Ready' })

    $badRestartDescriptor = [ordered]@{} + $serverDescriptor
    $badRestartDescriptor.restartCount = 0
    Write-SelfTestJson (Join-Path $script:shadow 'server-task.json') ([ordered]@{ descriptor = $badRestartDescriptor; state = 'Ready' })
    if (Test-Path $dispatchLog) { Remove-Item $dispatchLog -Force }
    $restartDrift = Invoke-SelfTestSubmit -Id ([guid]::NewGuid().ToString('D')) -Capability LifecycleDispatch -Operation start
    $restartDriftEnvelope = ConvertFrom-SelfTestOutput $restartDrift.stdout
    $restartDriftRejected = ($restartDriftEnvelope.receipt.status -ceq 'blocked' -and
        'task_definition_mismatch' -cin @($restartDriftEnvelope.receipt.evidence.blockers)) -or
        ($restartDriftEnvelope.receipt.status -ceq 'failed' -and
        $restartDriftEnvelope.receipt.errorCode -ceq 'DYSON_CONTROL_LIFECYCLE_BROKER_TASK_INVALID')
    Assert-SelfTest ($restartDriftRejected -and -not (Test-Path $dispatchLog)) `
        'server task without the pinned bounded restart policy was accepted'
    Write-SelfTestJson (Join-Path $script:shadow 'server-task.json') ([ordered]@{ descriptor = $serverDescriptor; state = 'Ready' })

    $script:stage = 'status retention'
    $oldTimestamp = [datetimeoffset]::UtcNow.AddHours(-2).ToString('o')
    for ($index = 0; $index -lt 260; $index += 1) {
        $retentionId = [guid]::NewGuid().ToString('D')
        $retentionRequest = New-DysonLifecycleBrokerRequest -BrokerRequestId $retentionId -Capability LifecycleStatus `
            -ProfileHash (Get-DysonLifecycleBrokerProfileHash $script:profileFile) -Input ([pscustomobject][ordered]@{})
        $retentionRequest.requestedAt = $oldTimestamp
        $retentionPaths = Get-DysonLifecycleBrokerRecordPaths $storage $retentionId
        [void](Write-DysonLifecycleBrokerJsonNew $retentionPaths.request $retentionRequest $script:DysonLifecycleBrokerMaximumRequestBytes)
        $retentionReceipt = New-DysonLifecycleBrokerReceipt -Request $retentionRequest -Status succeeded -ErrorCode $null `
            -Evidence ([pscustomobject][ordered]@{ lifecycleState = 'stopped_verified' })
        $retentionReceipt.completedAt = $oldTimestamp
        [void](Write-DysonLifecycleBrokerJsonNew $retentionPaths.receipt $retentionReceipt $script:DysonLifecycleBrokerMaximumReceiptBytes)
    }
    $protectedId = [guid]::NewGuid().ToString('D')
    $protectedRequest = New-DysonLifecycleBrokerRequest -BrokerRequestId $protectedId -Capability LifecycleStatus `
        -ProfileHash (Get-DysonLifecycleBrokerProfileHash $script:profileFile) -Input ([pscustomobject][ordered]@{})
    $protectedRequest.requestedAt = $oldTimestamp
    $protectedPaths = Get-DysonLifecycleBrokerRecordPaths $storage $protectedId
    [void](Write-DysonLifecycleBrokerJsonNew $protectedPaths.request $protectedRequest $script:DysonLifecycleBrokerMaximumRequestBytes)
    $protectedReceipt = New-DysonLifecycleBrokerReceipt -Request $protectedRequest -Status succeeded -ErrorCode $null `
        -Evidence ([pscustomobject][ordered]@{ lifecycleState = 'stopped_verified' })
    $protectedReceipt.completedAt = $oldTimestamp
    [void](Write-DysonLifecycleBrokerJsonNew $protectedPaths.receipt $protectedReceipt $script:DysonLifecycleBrokerMaximumReceiptBytes)
    [void](Write-DysonLifecycleBrokerJsonNew $protectedPaths.intent ([ordered]@{
        protocol = $script:DysonLifecycleBrokerIntentProtocol; schemaVersion = 1; brokerRequestId = $protectedId
        requestFingerprint = $protectedRequest.requestFingerprint; capability = 'LifecycleStatus'; input = $protectedRequest.input
        createdAt = $oldTimestamp
    }) $script:DysonLifecycleBrokerMaximumIntentBytes)
    $workerRun = Invoke-SelfTestScript -Script (Join-Path $script:brokerScripts 'Invoke-DysonLifecycleBrokerWorker.ps1') -Arguments @(
        '-BrokerRoot', $script:broker, '-ProfileFile', $script:profileFile,
        '-Backend', 'Shadow', '-ShadowRoot', $script:shadow
    )
    $closedStatusCount = 0
    foreach ($file in @(Get-ChildItem $storage.receipts -File -Filter '*.json')) {
        $candidateReceipt = ConvertTo-DysonLifecycleBrokerValidatedReceipt (Read-DysonLifecycleBrokerJson -Path $file.FullName `
            -MaximumBytes $script:DysonLifecycleBrokerMaximumReceiptBytes -InvalidCode 'DYSON_CONTROL_LIFECYCLE_BROKER_RECEIPT_INVALID')
        $candidatePaths = Get-DysonLifecycleBrokerRecordPaths $storage $candidateReceipt.brokerRequestId
        if ($candidateReceipt.capability -ceq 'LifecycleStatus' -and -not (Test-Path $candidatePaths.intent)) { $closedStatusCount += 1 }
    }
    Assert-SelfTest ($workerRun.exitCode -eq 0 -and
        $closedStatusCount -le $script:DysonLifecycleBrokerMaximumClosedStatusRecords -and
        (Test-Path $protectedPaths.request) -and (Test-Path $protectedPaths.receipt) -and (Test-Path $protectedPaths.intent) -and
        (Test-Path (Join-Path $storage.receipts ($verifyId + '.json')))) 'bounded status-only retention preserves intent and non-status records'

    # A burst younger than the normal one-hour retention floor still converges at the absolute hard ceiling.
    $burstNewestPaths = $null
    for ($index = 0; $index -lt 1050; $index += 1) {
        $burstId = [guid]::NewGuid().ToString('D')
        $burstRequest = New-DysonLifecycleBrokerRequest -BrokerRequestId $burstId -Capability LifecycleStatus `
            -ProfileHash (Get-DysonLifecycleBrokerProfileHash $script:profileFile) -Input ([pscustomobject][ordered]@{})
        $burstPaths = Get-DysonLifecycleBrokerRecordPaths $storage $burstId
        [void](Write-DysonLifecycleBrokerJsonNew $burstPaths.request $burstRequest $script:DysonLifecycleBrokerMaximumRequestBytes)
        $burstReceipt = New-DysonLifecycleBrokerReceipt -Request $burstRequest -Status succeeded -ErrorCode $null `
            -Evidence ([pscustomobject][ordered]@{ lifecycleState = 'stopped_verified' })
        [void](Write-DysonLifecycleBrokerJsonNew $burstPaths.receipt $burstReceipt $script:DysonLifecycleBrokerMaximumReceiptBytes)
        $burstNewestPaths = $burstPaths
    }
    $burstWorker = Invoke-SelfTestScript -Script (Join-Path $script:brokerScripts 'Invoke-DysonLifecycleBrokerWorker.ps1') -Arguments @(
        '-BrokerRoot', $script:broker, '-ProfileFile', $script:profileFile,
        '-Backend', 'Shadow', '-ShadowRoot', $script:shadow
    )
    $burstClosedCount = 0
    foreach ($file in @(Get-ChildItem $storage.receipts -File -Filter '*.json')) {
        $candidateReceipt = ConvertTo-DysonLifecycleBrokerValidatedReceipt (Read-DysonLifecycleBrokerJson -Path $file.FullName `
            -MaximumBytes $script:DysonLifecycleBrokerMaximumReceiptBytes -InvalidCode 'DYSON_CONTROL_LIFECYCLE_BROKER_RECEIPT_INVALID')
        $candidatePaths = Get-DysonLifecycleBrokerRecordPaths $storage $candidateReceipt.brokerRequestId
        if ($candidateReceipt.capability -ceq 'LifecycleStatus' -and -not (Test-Path $candidatePaths.intent)) { $burstClosedCount += 1 }
    }
    Assert-SelfTest ($burstWorker.exitCode -eq 0 -and
        $burstClosedCount -le $script:DysonLifecycleBrokerMaximumClosedStatusHardRecords -and
        (Test-Path $burstNewestPaths.request) -and (Test-Path $burstNewestPaths.receipt) -and
        (Test-Path $protectedPaths.request) -and (Test-Path $protectedPaths.receipt) -and (Test-Path $protectedPaths.intent) -and
        (Test-Path (Join-Path $storage.receipts ($verifyId + '.json')))) `
        'fresh status burst converges at hard cap without deleting intent or non-status records'

    # Dependency drift is detected before a request can be accepted.
    $script:stage = 'hash drift and bounds'
    $startPath = Join-Path $script:installed 'Start-DysonServer.ps1'
    $startBytes = [IO.File]::ReadAllBytes($startPath)
    [IO.File]::AppendAllText($startPath, "`n# drift", [Text.UTF8Encoding]::new($false))
    $drift = Invoke-SelfTestSubmit -Id ([guid]::NewGuid().ToString('D')) -Capability LifecycleStatus
    $driftEnvelope = ConvertFrom-SelfTestOutput $drift.stdout
    Assert-SelfTest ($drift.exitCode -ne 0 -and $driftEnvelope.error.code -ceq 'DYSON_CONTROL_LIFECYCLE_BROKER_HASH_DRIFT') 'dependency hash drift'
    [IO.File]::WriteAllBytes($startPath, $startBytes)

    $oversize = 'x' * 70000
    [IO.File]::WriteAllText((Join-Path $script:shadow 'runtime.json'), $oversize, [Text.UTF8Encoding]::new($false))
    # The preceding hard-cap fixture leaves more than 1,000 closed records for
    # the worker's bounded retention pass. NTFS metadata validation can take
    # longer than the default 15-second request timeout even though the failed
    # receipt is published promptly, so give this combined bounds check a
    # bounded window that also covers retention.
    $sizeBound = Invoke-SelfTestSubmit -Id ([guid]::NewGuid().ToString('D')) -Capability LifecycleStatus -TimeoutSeconds 90
    $sizeEnvelope = ConvertFrom-SelfTestOutput $sizeBound.stdout
    Assert-SelfTest ($sizeBound.exitCode -eq 0 -and $null -ne $sizeEnvelope -and
        $null -ne $sizeEnvelope.PSObject.Properties['receipt'] -and
        $sizeEnvelope.receipt.status -ceq 'failed' -and
        $sizeEnvelope.receipt.errorCode -ceq 'DYSON_CONTROL_LIFECYCLE_BROKER_REQUEST_INVALID') `
        'runtime evidence size bound'

    $reparseTested = $false; $reparseRejected = $false
    try {
        $target = Join-Path $script:root 'reparse-target'; [void][IO.Directory]::CreateDirectory($target)
        $link = Join-Path $script:root 'reparse-link'; [void](New-Item -ItemType Junction -Path $link -Target $target -ErrorAction Stop)
        $reparseTested = $true
        try { [void](Assert-DysonLifecycleBrokerPlainDirectory $link) }
        catch { $reparseRejected = $true }
    }
    catch { }
    Assert-SelfTest ((-not $reparseTested) -or $reparseRejected) 'reparse path rejection'

    [ordered]@{
        protocol = 'DYSON_CONTROL_LIFECYCLE_BROKER_SELFTEST_V1'; schemaVersion = 1
        status = if ($script:failed -eq 0) { 'passed' } else { 'failed' }
        passed = $script:passed; failed = $script:failed; failures = @($script:failures)
        backend = 'Shadow'; productionSchedulerTouched = $false
    } | ConvertTo-Json -Depth 8 -Compress
    if ($script:failed -gt 0) { exit 1 }
    exit 0
}
catch {
    $unexpected = 'unexpected at ' + $script:stage
    [ordered]@{
        protocol = 'DYSON_CONTROL_LIFECYCLE_BROKER_SELFTEST_V1'; schemaVersion = 1; status = 'failed'
        passed = $script:passed; failed = ($script:failed + 1); failures = @($script:failures) + @($unexpected)
        backend = 'Shadow'; productionSchedulerTouched = $false
    } | ConvertTo-Json -Depth 8 -Compress
    exit 1
}
finally {
    if ($env:DYSON_LIFECYCLE_BROKER_SELFTEST_KEEP -cne '1' -and (Test-Path -LiteralPath $script:root)) {
        Remove-Item -LiteralPath $script:root -Recurse -Force -ErrorAction SilentlyContinue
    }
}
