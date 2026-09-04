[CmdletBinding(SupportsShouldProcess, ConfirmImpact = 'Medium')]
param(
    [Parameter(Mandatory)][string]$BrokerRoot,
    [Parameter(Mandatory)][string]$ProfileFile,
    [Parameter(Mandatory)][string]$BrokerRequestId,
    [Parameter(Mandatory)][ValidateSet('LifecyclePreflight', 'LifecycleDispatch', 'LifecycleVerify', 'LifecycleStatus')][string]$Capability,
    [ValidateSet('start', 'save', 'graceful-stop', 'restart')][string]$Action,
    [ValidateSet('start', 'graceful-stop', 'rollback-start')][string]$Operation,
    [ValidateSet('running', 'stopped')][string]$Expected,
    [string]$DataRoot,
    [string]$LeaseInstanceId,
    [string]$LeaseToken,
    [ValidateRange(5, 300)][int]$TimeoutSeconds = 60,
    [ValidateSet('Windows', 'Shadow')][string]$Backend = 'Windows',
    [string]$ShadowRoot
)

Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)

$commonPath = Join-Path $PSScriptRoot 'DysonLifecycleBroker.Common.ps1'
if (-not (Test-Path -LiteralPath $commonPath -PathType Leaf)) { throw 'DYSON_CONTROL_LIFECYCLE_BROKER_INTERNAL_ERROR' }
. $commonPath

function Get-SubmitInput {
    switch ($Capability) {
        'LifecyclePreflight' {
            if ([string]::IsNullOrWhiteSpace($Action) -or -not [string]::IsNullOrWhiteSpace($Operation) -or
                -not [string]::IsNullOrWhiteSpace($Expected) -or -not [string]::IsNullOrWhiteSpace($DataRoot) -or -not [string]::IsNullOrWhiteSpace($LeaseInstanceId) -or
                -not [string]::IsNullOrWhiteSpace($LeaseToken)) {
                Throw-DysonLifecycleBrokerError 'DYSON_CONTROL_LIFECYCLE_BROKER_CAPABILITY_INVALID'
            }
            return [pscustomobject][ordered]@{ action = $Action }
        }
        'LifecycleDispatch' {
            if ([string]::IsNullOrWhiteSpace($Operation) -or [string]::IsNullOrWhiteSpace($DataRoot) -or
                -not (Test-DysonLifecycleBrokerSamePath $DataRoot ([string]$profile.dataRoot)) -or
                [string]::IsNullOrWhiteSpace($LeaseInstanceId) -or
                [string]::IsNullOrWhiteSpace($LeaseToken) -or -not [string]::IsNullOrWhiteSpace($Action) -or
                -not [string]::IsNullOrWhiteSpace($Expected)) {
                Throw-DysonLifecycleBrokerError 'DYSON_CONTROL_LIFECYCLE_BROKER_CAPABILITY_INVALID'
            }
            return [pscustomobject][ordered]@{
                operation = $Operation
                leaseInstanceId = ConvertTo-DysonLifecycleBrokerGuid $LeaseInstanceId
                leaseToken = $LeaseToken
            }
        }
        'LifecycleVerify' {
            if ([string]::IsNullOrWhiteSpace($Expected) -or -not [string]::IsNullOrWhiteSpace($Action) -or
                -not [string]::IsNullOrWhiteSpace($Operation) -or -not [string]::IsNullOrWhiteSpace($DataRoot) -or -not [string]::IsNullOrWhiteSpace($LeaseInstanceId) -or
                -not [string]::IsNullOrWhiteSpace($LeaseToken)) {
                Throw-DysonLifecycleBrokerError 'DYSON_CONTROL_LIFECYCLE_BROKER_CAPABILITY_INVALID'
            }
            return [pscustomobject][ordered]@{ expected = $Expected }
        }
        'LifecycleStatus' {
            if (-not [string]::IsNullOrWhiteSpace($Expected) -or -not [string]::IsNullOrWhiteSpace($Action) -or
                -not [string]::IsNullOrWhiteSpace($Operation) -or -not [string]::IsNullOrWhiteSpace($DataRoot) -or -not [string]::IsNullOrWhiteSpace($LeaseInstanceId) -or
                -not [string]::IsNullOrWhiteSpace($LeaseToken)) {
                Throw-DysonLifecycleBrokerError 'DYSON_CONTROL_LIFECYCLE_BROKER_CAPABILITY_INVALID'
            }
            return [pscustomobject][ordered]@{}
        }
    }
}

function Assert-SubmitWindowsTask {
    param([Parameter(Mandatory)]$Profile)
    try { $matches = @(Get-ScheduledTask -TaskName ([string]$Profile.workerTaskName) -TaskPath ([string]$Profile.workerTaskPath) -ErrorAction Stop) }
    catch { Throw-DysonLifecycleBrokerError 'DYSON_CONTROL_LIFECYCLE_BROKER_TASK_INVALID' }
    if ($matches.Count -ne 1 -or $matches[0].Actions.Count -ne 1 -or
        [string]$matches[0].Principal.UserId -cne 'SYSTEM' -or [string]$matches[0].Principal.LogonType -cne 'ServiceAccount' -or
        [string]$matches[0].Principal.RunLevel -cne 'Highest' -or -not [bool]$matches[0].Settings.Enabled -or
        [string]$matches[0].Settings.MultipleInstances -cne 'IgnoreNew') {
        Throw-DysonLifecycleBrokerError 'DYSON_CONTROL_LIFECYCLE_BROKER_TASK_INVALID'
    }
    $expectedPowerShell = [IO.Path]::GetFullPath((Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'))
    $actualPowerShell = [IO.Path]::GetFullPath([Environment]::ExpandEnvironmentVariables([string]$matches[0].Actions[0].Execute))
    $worker = Join-Path ([string]$Profile.brokerScriptRoot) 'Invoke-DysonLifecycleBrokerWorker.ps1'
    $expectedArguments = Get-DysonLifecycleBrokerTaskArguments -BrokerRoot ([string]$Profile.brokerRoot) `
        -ProfileFile $ProfileFile -WorkerScript $worker
    if (-not $actualPowerShell.Equals($expectedPowerShell, [StringComparison]::OrdinalIgnoreCase) -or
        [string]$matches[0].Actions[0].Arguments -cne $expectedArguments -or
        -not [string]::IsNullOrWhiteSpace([string]$matches[0].Actions[0].WorkingDirectory)) {
        Throw-DysonLifecycleBrokerError 'DYSON_CONTROL_LIFECYCLE_BROKER_TASK_INVALID'
    }
}

function Invoke-SubmitShadowWorker {
    param(
        [Parameter(Mandatory)]$Profile,
        [Parameter(Mandatory)][ValidateRange(5, 300)][int]$WorkerTimeoutSeconds
    )
    if ($env:DYSON_LIFECYCLE_BROKER_SELFTEST -cne '1' -or [string]::IsNullOrWhiteSpace($ShadowRoot)) {
        Throw-DysonLifecycleBrokerError 'DYSON_CONTROL_LIFECYCLE_BROKER_SHADOW_FORBIDDEN'
    }
    $shadow = Assert-DysonLifecycleBrokerPlainDirectory $ShadowRoot
    if (-not (Test-Path -LiteralPath (Join-Path $shadow '.dyson-lifecycle-broker-selftest') -PathType Leaf)) {
        Throw-DysonLifecycleBrokerError 'DYSON_CONTROL_LIFECYCLE_BROKER_SHADOW_FORBIDDEN'
    }
    $recordTriggers = Join-Path $shadow '.dyson-lifecycle-broker-record-triggers'
    if (Test-Path -LiteralPath $recordTriggers -PathType Leaf) {
        [void](Assert-DysonLifecycleBrokerPlainFile -Path $recordTriggers -MaximumBytes 32 -AllowEmpty)
        $triggerLog = Join-Path $shadow 'worker-trigger.log'
        if (Test-Path -LiteralPath $triggerLog -PathType Leaf) {
            [void](Assert-DysonLifecycleBrokerPlainFile -Path $triggerLog -MaximumBytes 4096 -AllowEmpty)
        }
        [IO.File]::AppendAllText($triggerLog, "trigger`n", [Text.UTF8Encoding]::new($false))
    }
    $ignoreNextTrigger = Join-Path $shadow '.dyson-lifecycle-broker-ignore-next-trigger'
    if (Test-Path -LiteralPath $ignoreNextTrigger -PathType Leaf) {
        # Self-test-only model of Task Scheduler's IgnoreNew policy: the
        # request is already durable, but this trigger starts no new worker.
        Remove-DysonLifecycleBrokerPlainFile $ignoreNextTrigger
        return
    }
    $worker = Join-Path ([string]$Profile.brokerScriptRoot) 'Invoke-DysonLifecycleBrokerWorker.ps1'
    $runspace = $null
    $pipeline = $null
    $asyncResult = $null
    $timedOut = $false
    try {
        # Shadow is a self-test-only backend. Run the exact hash-pinned worker
        # in an isolated hosted pipeline so no nested console process can keep
        # inherited stdout handles alive after the worker has completed.
        $runspace = [Management.Automation.Runspaces.RunspaceFactory]::CreateRunspace()
        $runspace.Open()
        $pipeline = [Management.Automation.PowerShell]::Create()
        $pipeline.Runspace = $runspace
        [void]$pipeline.AddCommand($worker)
        [void]$pipeline.AddParameter('BrokerRoot', [string]$Profile.brokerRoot)
        [void]$pipeline.AddParameter('ProfileFile', [string]$ProfileFile)
        [void]$pipeline.AddParameter('Backend', 'Shadow')
        [void]$pipeline.AddParameter('ShadowRoot', [string]$shadow)
        $asyncResult = $pipeline.BeginInvoke()
        $waitMilliseconds = [int](($WorkerTimeoutSeconds + 5) * 1000)
        if (-not $asyncResult.AsyncWaitHandle.WaitOne($waitMilliseconds)) {
            # Do not synchronously Stop/Dispose a timed-out pipeline: either
            # can wait on the same blocked operation. The enclosing submit
            # process immediately exits through the fail-closed error path.
            $timedOut = $true
            Throw-DysonLifecycleBrokerError 'DYSON_CONTROL_LIFECYCLE_BROKER_TIMEOUT'
        }
        try { $workerOutput = @($pipeline.EndInvoke($asyncResult)) }
        catch { Throw-DysonLifecycleBrokerError 'DYSON_CONTROL_LIFECYCLE_BROKER_INTERNAL_ERROR' }
        $workerExitCode = $runspace.SessionStateProxy.PSVariable.GetValue('LASTEXITCODE')
        $workerStdout = @($workerOutput | ForEach-Object { [string]$_ }) -join [Environment]::NewLine
        $workerStderr = @($pipeline.Streams.Error | ForEach-Object { [string]$_ }) -join [Environment]::NewLine
        $outLength = [Text.Encoding]::UTF8.GetByteCount($workerStdout)
        $errLength = [Text.Encoding]::UTF8.GetByteCount($workerStderr)
        if ($outLength -gt $script:DysonLifecycleBrokerMaximumOutputBytes -or
            $errLength -gt $script:DysonLifecycleBrokerMaximumOutputBytes) {
            Throw-DysonLifecycleBrokerError 'DYSON_CONTROL_LIFECYCLE_BROKER_INTERNAL_ERROR'
        }
        if ($null -eq $workerExitCode -or [int]$workerExitCode -ne 0) {
            Throw-DysonLifecycleBrokerError 'DYSON_CONTROL_LIFECYCLE_BROKER_INTERNAL_ERROR'
        }
    }
    finally {
        if ($null -ne $asyncResult) { $asyncResult.AsyncWaitHandle.Close() }
        if ($null -ne $pipeline -and -not $timedOut) { $pipeline.Dispose() }
        if ($null -ne $runspace -and -not $timedOut) { $runspace.Dispose() }
    }
}

function Invoke-SubmitWorkerTrigger {
    param(
        [Parameter(Mandatory)]$Profile,
        [Parameter(Mandatory)][ValidateRange(5, 300)][int]$WorkerTimeoutSeconds,
        [switch]$Retry
    )
    if ($Backend -ceq 'Windows') {
        # Revalidate the fixed task on every attempt so a retry cannot widen the
        # trusted command surface after the initial descriptor check.
        Assert-SubmitWindowsTask $Profile
        try {
            Start-ScheduledTask -TaskName ([string]$Profile.workerTaskName) `
                -TaskPath ([string]$Profile.workerTaskPath) -ErrorAction Stop
        }
        catch {
            # A running IgnoreNew task may reject or absorb a concurrent start.
            # The durable request remains the source of truth, so bounded retry
            # attempts may wait for the active worker to exit. The initial
            # trigger still fails closed when the task cannot be started.
            if (-not $Retry) {
                Throw-DysonLifecycleBrokerError 'DYSON_CONTROL_LIFECYCLE_BROKER_TASK_TRIGGER_FAILED'
            }
        }
        return
    }
    Invoke-SubmitShadowWorker -Profile $Profile -WorkerTimeoutSeconds $WorkerTimeoutSeconds
}

try {
    $resolvedBrokerRoot = Assert-DysonLifecycleBrokerPlainDirectory $BrokerRoot
    $resolvedProfile = Assert-DysonLifecycleBrokerPlainFile -Path $ProfileFile -MaximumBytes $script:DysonLifecycleBrokerMaximumProfileBytes
    if (-not (Test-DysonLifecycleBrokerSamePath $resolvedProfile (Join-Path $resolvedBrokerRoot 'broker-profile.json'))) {
        Throw-DysonLifecycleBrokerError 'DYSON_CONTROL_LIFECYCLE_BROKER_PROFILE_BINDING_MISMATCH'
    }
    $profile = Read-DysonLifecycleBrokerProfile $resolvedProfile
    if (-not (Test-DysonLifecycleBrokerSamePath $profile.brokerRoot $resolvedBrokerRoot) -or
        -not (Test-DysonLifecycleBrokerSamePath $profile.brokerScriptRoot $PSScriptRoot)) {
        Throw-DysonLifecycleBrokerError 'DYSON_CONTROL_LIFECYCLE_BROKER_PROFILE_BINDING_MISMATCH'
    }
    Assert-DysonLifecycleBrokerDependencies $profile
    $input = Get-SubmitInput
    $request = New-DysonLifecycleBrokerRequest -BrokerRequestId $BrokerRequestId -Capability $Capability `
        -ProfileHash (Get-DysonLifecycleBrokerProfileHash $resolvedProfile) -Input $input
    $storage = Get-DysonLifecycleBrokerStorage -BrokerRoot $resolvedBrokerRoot
    $paths = Get-DysonLifecycleBrokerRecordPaths $storage $request.brokerRequestId
    $reused = $false
    if (Test-Path -LiteralPath $paths.request -PathType Leaf) {
        $existing = ConvertTo-DysonLifecycleBrokerValidatedRequest (Read-DysonLifecycleBrokerJson -Path $paths.request `
            -MaximumBytes $script:DysonLifecycleBrokerMaximumRequestBytes -InvalidCode 'DYSON_CONTROL_LIFECYCLE_BROKER_REQUEST_INVALID')
        if ([string]$existing.requestFingerprint -cne [string]$request.requestFingerprint) {
            Throw-DysonLifecycleBrokerError 'DYSON_CONTROL_LIFECYCLE_BROKER_REQUEST_CONFLICT'
        }
        $reused = $true
    }
    elseif ($Capability -ceq 'LifecycleDispatch' -and -not $PSCmdlet.ShouldProcess(
        ([string]$request.input.operation),
        'Submit the fixed lifecycle task dispatch request'
    )) {
        [ordered]@{
            protocol = 'DYSON_CONTROL_LIFECYCLE_BROKER_PREVIEW_V1'; schemaVersion = 1
            brokerRequestId = [string]$request.brokerRequestId; capability = $Capability
            operation = [string]$request.input.operation; dryRun = $true
        } | ConvertTo-Json -Compress
        exit 0
    }
    else {
        [void](Write-DysonLifecycleBrokerJsonNew -Path $paths.request -Value $request `
            -MaximumBytes $script:DysonLifecycleBrokerMaximumRequestBytes)
    }
    if (Test-Path -LiteralPath $paths.receipt -PathType Leaf) {
        $receipt = ConvertTo-DysonLifecycleBrokerValidatedReceipt (Read-DysonLifecycleBrokerJson -Path $paths.receipt `
            -MaximumBytes $script:DysonLifecycleBrokerMaximumReceiptBytes -InvalidCode 'DYSON_CONTROL_LIFECYCLE_BROKER_RECEIPT_INVALID')
        if ([string]$receipt.requestFingerprint -cne [string]$request.requestFingerprint) {
            Throw-DysonLifecycleBrokerError 'DYSON_CONTROL_LIFECYCLE_BROKER_REQUEST_CONFLICT'
        }
        ConvertTo-DysonLifecycleBrokerResultEnvelope -Receipt $receipt -Reused $true | ConvertTo-Json -Depth 24 -Compress
        exit 0
    }
    $deadline = [datetime]::UtcNow.AddSeconds($TimeoutSeconds)
    [void](Invoke-SubmitWorkerTrigger -Profile $profile -WorkerTimeoutSeconds $TimeoutSeconds)
    $nextTriggerAt = [datetime]::UtcNow.AddSeconds(2)
    do {
        if (Test-Path -LiteralPath $paths.receipt -PathType Leaf) {
            $receipt = ConvertTo-DysonLifecycleBrokerValidatedReceipt (Read-DysonLifecycleBrokerJson -Path $paths.receipt `
                -MaximumBytes $script:DysonLifecycleBrokerMaximumReceiptBytes -InvalidCode 'DYSON_CONTROL_LIFECYCLE_BROKER_RECEIPT_INVALID')
            if ([string]$receipt.requestFingerprint -cne [string]$request.requestFingerprint) {
                Throw-DysonLifecycleBrokerError 'DYSON_CONTROL_LIFECYCLE_BROKER_REQUEST_CONFLICT'
            }
            ConvertTo-DysonLifecycleBrokerResultEnvelope -Receipt $receipt -Reused $reused | ConvertTo-Json -Depth 24 -Compress
            exit 0
        }
        if ([datetime]::UtcNow -ge $nextTriggerAt) {
            [void](Invoke-SubmitWorkerTrigger -Profile $profile -WorkerTimeoutSeconds $TimeoutSeconds -Retry)
            $nextTriggerAt = [datetime]::UtcNow.AddSeconds(2)
        }
        Start-Sleep -Milliseconds 200
    } while ([datetime]::UtcNow -lt $deadline)
    Throw-DysonLifecycleBrokerError 'DYSON_CONTROL_LIFECYCLE_BROKER_TIMEOUT'
}
catch [Management.Automation.PipelineStoppedException] {
    Write-DysonLifecycleBrokerFailureEnvelope 'DYSON_CONTROL_LIFECYCLE_BROKER_CANCELLED'
    exit 1
}
catch {
    Write-DysonLifecycleBrokerFailureEnvelope (Get-DysonLifecycleBrokerErrorCode $_.Exception)
    exit 1
}
