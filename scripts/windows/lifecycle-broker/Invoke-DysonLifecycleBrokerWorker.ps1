[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$BrokerRoot,
    [Parameter(Mandatory)][string]$ProfileFile,
    [ValidateSet('Windows', 'Shadow')][string]$Backend = 'Windows',
    [string]$ShadowRoot
)

Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)

$commonPath = Join-Path $PSScriptRoot 'DysonLifecycleBroker.Common.ps1'
if (-not (Test-Path -LiteralPath $commonPath -PathType Leaf)) { throw 'DYSON_CONTROL_LIFECYCLE_BROKER_INTERNAL_ERROR' }
. $commonPath

function Get-WorkerProcessTelemetry {
    param($Profile, $Runtime)
    if ($Backend -cne 'Windows' -or $Runtime.lifecycleState -cne 'running_verified' -or
        $Runtime.process.status -cne 'verified') { return $null }
    $process = $null
    try {
        $process = Get-Process -Id ([int]$Runtime.process.pid) -ErrorAction Stop
        [void]$process.Handle
        $started = [DateTimeOffset]::new($process.StartTime.ToUniversalTime()).ToUnixTimeMilliseconds()
        $expected = Join-Path ([string]$Profile.projectRoot) 'server\DSPGAME.exe'
        if ($process.HasExited -or $process.SessionId -ne $Runtime.process.sessionId -or
            -not (Test-WorkerProcessExecutable -Actual $process.Path -Expected $expected -Profile $Profile)) { return $null }
        $cpuBefore = $process.TotalProcessorTime.TotalSeconds
        $timer = [Diagnostics.Stopwatch]::StartNew()
        Start-Sleep -Milliseconds 500
        $process.Refresh()
        $elapsed = $timer.Elapsed.TotalSeconds
        if ($process.HasExited -or
            [DateTimeOffset]::new($process.StartTime.ToUniversalTime()).ToUnixTimeMilliseconds() -ne $started) { return $null }
        $cores = ($process.TotalProcessorTime.TotalSeconds - $cpuBefore) / $elapsed
        if ([double]::IsNaN($cores) -or [double]::IsInfinity($cores) -or $cores -lt 0) { return $null }
        $after = Get-WorkerLifecycleEvidence $Profile
        if ($after.lifecycleState -cne 'running_verified' -or $after.process.status -cne 'verified' -or
            $after.process.pid -ne $Runtime.process.pid -or $after.process.sessionId -ne $Runtime.process.sessionId -or
            $after.process.owner -cne $Runtime.process.owner -or $process.HasExited) { return $null }
        return [pscustomobject][ordered]@{
            processId = [int]$process.Id; startedAtUnixMs = [long]$started
            sampledAtUnixMs = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
            processCoresUsed = [math]::Round($cores, 3)
            workingSetGiB = [math]::Round($process.WorkingSet64 / 1GB, 3)
            privateMemoryGiB = [math]::Round($process.PrivateMemorySize64 / 1GB, 3)
            threadCount = [int]$process.Threads.Count
        }
    }
    catch { return $null }
    finally { if ($null -ne $process) { $process.Dispose() } }
}

function Get-WorkerLeafUser {
    param([AllowNull()][string]$User)
    if ([string]::IsNullOrWhiteSpace($User)) { return '' }
    return (($User -split '\\')[-1]).ToLowerInvariant()
}

function ConvertTo-WorkerBoundedRuntimeRecord {
    param([Parameter(Mandatory)]$Raw)
    Assert-DysonLifecycleBrokerExactProperties $Raw @('sessions', 'processes', 'listeners', 'steam') `
        'DYSON_CONTROL_LIFECYCLE_BROKER_REQUEST_INVALID'
    $sessions = @($Raw.sessions | Where-Object { $null -ne $_ })
    $processes = @($Raw.processes | Where-Object { $null -ne $_ })
    $listeners = @($Raw.listeners | Where-Object { $null -ne $_ })
    $steam = @($Raw.steam | Where-Object { $null -ne $_ })
    if ($sessions.Count -gt 16 -or $processes.Count -gt 16 -or $listeners.Count -gt 16 -or $steam.Count -gt 16) {
        Throw-DysonLifecycleBrokerError 'DYSON_CONTROL_LIFECYCLE_BROKER_REQUEST_INVALID'
    }
    foreach ($entry in $sessions) {
        Assert-DysonLifecycleBrokerExactProperties $entry @('id', 'user', 'state') 'DYSON_CONTROL_LIFECYCLE_BROKER_REQUEST_INVALID'
        if ([int]$entry.id -lt 0 -or [int]$entry.id -gt 65535 -or [string]$entry.user -notmatch '^[^"\r\n]{1,128}$' -or
            [string]$entry.state -cnotin @('active', 'disconnected')) {
            Throw-DysonLifecycleBrokerError 'DYSON_CONTROL_LIFECYCLE_BROKER_REQUEST_INVALID'
        }
    }
    foreach ($entry in @($processes + $steam)) {
        Assert-DysonLifecycleBrokerExactProperties $entry @('name', 'pid', 'path', 'owner', 'sessionId') 'DYSON_CONTROL_LIFECYCLE_BROKER_REQUEST_INVALID'
        if ([int]$entry.pid -lt 1 -or [int]$entry.sessionId -lt 0 -or [string]$entry.name -notmatch '^[A-Za-z0-9_.-]{1,64}$' -or
            [string]$entry.path -match '[\0\r\n"]' -or [string]$entry.path -eq '' -or [string]$entry.owner -notmatch '^[^"\r\n]{1,128}$') {
            Throw-DysonLifecycleBrokerError 'DYSON_CONTROL_LIFECYCLE_BROKER_REQUEST_INVALID'
        }
    }
    foreach ($entry in $listeners) {
        Assert-DysonLifecycleBrokerExactProperties $entry @('port', 'pid') 'DYSON_CONTROL_LIFECYCLE_BROKER_REQUEST_INVALID'
        if ([int]$entry.port -lt 1 -or [int]$entry.port -gt 65535 -or [int]$entry.pid -lt 1) {
            Throw-DysonLifecycleBrokerError 'DYSON_CONTROL_LIFECYCLE_BROKER_REQUEST_INVALID'
        }
    }
    return [pscustomobject][ordered]@{ sessions = $sessions; processes = $processes; listeners = $listeners; steam = $steam }
}

function Get-WorkerProcessOwner {
    param([Parameter(Mandatory)]$CimProcess)
    try {
        $owner = Invoke-CimMethod -InputObject $CimProcess -MethodName GetOwner -ErrorAction Stop
        if ([uint32]$owner.ReturnValue -ne 0 -or [string]::IsNullOrWhiteSpace([string]$owner.User)) { return $null }
        if ([string]::IsNullOrWhiteSpace([string]$owner.Domain)) { return [string]$owner.User }
        return ([string]$owner.Domain + '\' + [string]$owner.User)
    }
    catch { return $null }
}

function Get-WorkerRuntimeRecord {
    param([Parameter(Mandatory)]$Profile)
    if ($Backend -ceq 'Shadow') {
        $raw = Read-DysonLifecycleBrokerJson -Path (Join-Path $ShadowRoot 'runtime.json') -MaximumBytes 65536 `
            -InvalidCode 'DYSON_CONTROL_LIFECYCLE_BROKER_REQUEST_INVALID'
        return (ConvertTo-WorkerBoundedRuntimeRecord $raw)
    }
    try {
        $all = @(Get-CimInstance Win32_Process -ErrorAction Stop | Where-Object {
            [string]$_.Name -in @('DSPGAME.exe', 'steam.exe', 'explorer.exe')
        })
        if ($all.Count -gt 48) { throw 'too many candidate processes' }
        $processes = [Collections.Generic.List[object]]::new()
        $steam = [Collections.Generic.List[object]]::new()
        $sessions = [Collections.Generic.List[object]]::new()
        foreach ($candidate in $all) {
            $owner = Get-WorkerProcessOwner $candidate
            $record = [pscustomobject][ordered]@{
                name = [string]$candidate.Name
                pid = [int]$candidate.ProcessId
                path = if ([string]::IsNullOrWhiteSpace([string]$candidate.ExecutablePath)) { '<unavailable>' } else { [string]$candidate.ExecutablePath }
                owner = if ($null -eq $owner) { '<unavailable>' } else { $owner }
                sessionId = [int]$candidate.SessionId
            }
            if ([string]$candidate.Name -ceq 'DSPGAME.exe') { [void]$processes.Add($record) }
            elseif ([string]$candidate.Name -ceq 'steam.exe') { [void]$steam.Add($record) }
            # Server Core may run Steam/DSP in an interactive session without
            # explorer.exe. The same verified owner/session evidence applies.
            if ([int]$candidate.SessionId -gt 0 -and
                (Get-WorkerLeafUser $owner) -ceq (Get-WorkerLeafUser $Profile.serviceUser)) {
                [void]$sessions.Add([pscustomobject][ordered]@{
                    id = [int]$candidate.SessionId
                    user = $owner
                    state = 'active'
                })
            }
        }
        $uniqueSessions = @($sessions | Sort-Object id -Unique)
        # A missing filtered port is reported as an error by the native cmdlet.
        # Enumerate successfully first so an idle server has zero listeners.
        $listeners = @(Get-NetTCPConnection -ErrorAction Stop | Where-Object {
            [string]$_.State -eq 'Listen' -and [int]$_.LocalPort -eq [int]$Profile.gamePort
        } | ForEach-Object {
            [pscustomobject][ordered]@{ port = [int]$_.LocalPort; pid = [int]$_.OwningProcess }
        })
        return (ConvertTo-WorkerBoundedRuntimeRecord ([pscustomobject][ordered]@{
            sessions = $uniqueSessions; processes = @($processes); listeners = $listeners; steam = @($steam)
        }))
    }
    catch {
        return [pscustomobject][ordered]@{ sessions = @(); processes = @(); listeners = @(); steam = @(); queryFailed = $true }
    }
}

function Test-WorkerProcessExecutable {
    param([Parameter(Mandatory)][string]$Actual, [Parameter(Mandatory)][string]$Expected,
        [Parameter(Mandatory)]$Profile)
    if (Test-DysonLifecycleBrokerSamePath $Actual $Expected) { return $true }
    $actualStream = $null
    $expectedStream = $null
    try {
        if (-not [IO.Path]::IsPathRooted($Actual) -or -not [IO.Path]::IsPathRooted($Expected)) { return $false }
        # Resolve only executable aliases, through the already profile-pinned
        # lease dependency. General configuration/task path rules stay literal.
        $leasePath = Join-Path ([string]$Profile.installedWindowsRoot) 'DysonHostMutationLease.Common.ps1'
        $entry = @($Profile.dependencyHashes | Where-Object { [string]$_.name -ceq 'DysonHostMutationLease.Common.ps1' })
        if ($entry.Count -ne 1 -or (Get-DysonLifecycleBrokerSha256File $leasePath) -cne [string]$entry[0].sha256) {
            return $false
        }
        . $leasePath
        $share = [IO.FileShare]::ReadWrite -bor [IO.FileShare]::Delete
        $actualStream = [IO.File]::Open($Actual, [IO.FileMode]::Open, [IO.FileAccess]::Read, $share)
        $expectedStream = [IO.File]::Open($Expected, [IO.FileMode]::Open, [IO.FileAccess]::Read, $share)
        $actualFinal = Get-DysonHostMutationLeaseFinalPathFromHandle -Handle $actualStream.SafeFileHandle
        $expectedFinal = Get-DysonHostMutationLeaseFinalPathFromHandle -Handle $expectedStream.SafeFileHandle
        return -not [string]::IsNullOrWhiteSpace($actualFinal) -and
            -not [string]::IsNullOrWhiteSpace($expectedFinal) -and
            [string]::Equals($actualFinal, $expectedFinal, [StringComparison]::OrdinalIgnoreCase)
    }
    catch { return $false }
    finally {
        if ($null -ne $expectedStream) { $expectedStream.Dispose() }
        if ($null -ne $actualStream) { $actualStream.Dispose() }
    }
}

function Get-WorkerPidEvidence {
    param([Parameter(Mandatory)]$Profile)
    $path = Join-Path ([string]$Profile.projectRoot) 'run\dspgame.pid'
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { return [pscustomobject]@{ present = $false; pid = 0; valid = $false } }
    try {
        $resolved = Assert-DysonLifecycleBrokerPlainFile -Path $path -MaximumBytes 32
        $text = [IO.File]::ReadAllText($resolved, [Text.UTF8Encoding]::new($false)).Trim()
        $pidValue = 0
        $valid = [int]::TryParse($text, [ref]$pidValue) -and $pidValue -gt 0
        return [pscustomobject]@{ present = $true; pid = $pidValue; valid = $valid }
    }
    catch { return [pscustomobject]@{ present = $true; pid = 0; valid = $false } }
}

function Get-WorkerLifecycleEvidence {
    param([Parameter(Mandatory)]$Profile)
    $record = Get-WorkerRuntimeRecord $Profile
    $serviceLeaf = Get-WorkerLeafUser $Profile.serviceUser
    $sessions = @($record.sessions | Where-Object {
        [int]$_.id -gt 0 -and (Get-WorkerLeafUser ([string]$_.user)) -ceq $serviceLeaf
    })
    $sessionStatus = if ($sessions.Count -eq 0) { 'missing' } elseif ($sessions.Count -eq 1) { 'verified' } else { 'ambiguous' }
    $sessionId = if ($sessions.Count -eq 1) { [int]$sessions[0].id } else { $null }
    $expectedExecutable = [IO.Path]::GetFullPath((Join-Path ([string]$Profile.projectRoot) 'server\DSPGAME.exe'))
    $dsp = @($record.processes | Where-Object { [string]$_.name -ieq 'DSPGAME.exe' })
    $portListeners = @($record.listeners | Where-Object { [int]$_.port -eq [int]$Profile.gamePort })
    $pidEvidence = Get-WorkerPidEvidence $Profile
    $state = 'unknown_unverifiable'
    $processEvidence = [ordered]@{ status = 'unverifiable'; pid = $null; owner = $null; sessionId = $null }
    if ($record.PSObject.Properties.Name -contains 'queryFailed') {
        $state = 'unknown_unverifiable'
    }
    elseif ($dsp.Count -eq 0 -and $portListeners.Count -eq 0 -and -not $pidEvidence.present) {
        $state = 'stopped_verified'
        $processEvidence.status = 'absent'
    }
    elseif ($dsp.Count -eq 1) {
        $candidate = $dsp[0]
        $pathMatches = $false
        try { $pathMatches = Test-WorkerProcessExecutable -Actual ([string]$candidate.path) -Expected $expectedExecutable -Profile $Profile }
        catch { $pathMatches = $false }
        $ownerMatches = (Get-WorkerLeafUser ([string]$candidate.owner) -ceq $serviceLeaf)
        $sessionMatches = $sessionStatus -ceq 'verified' -and [int]$candidate.sessionId -eq [int]$sessionId
        $portMatches = $portListeners.Count -eq 1 -and [int]$portListeners[0].pid -eq [int]$candidate.pid
        $pidMatches = $pidEvidence.present -and $pidEvidence.valid -and [int]$pidEvidence.pid -eq [int]$candidate.pid
        if ($pathMatches -and $ownerMatches -and $sessionMatches -and $portMatches -and $pidMatches) {
            $state = 'running_verified'
            $processEvidence = [ordered]@{
                status = 'verified'; pid = [int]$candidate.pid
                owner = [string]$candidate.owner; sessionId = [int]$candidate.sessionId
            }
        }
    }
    $steamCandidates = @($record.steam | Where-Object {
        [string]$_.name -ieq 'steam.exe' -and (Get-WorkerLeafUser ([string]$_.owner)) -ceq $serviceLeaf
    })
    $steamSame = @(if ($sessionStatus -ceq 'verified') {
        @($steamCandidates | Where-Object { [int]$_.sessionId -eq [int]$sessionId })
    }
    else { @() })
    $steamStatus = if ($steamSame.Count -eq 1 -and $steamCandidates.Count -eq 1) { 'verified' } `
        elseif ($steamSame.Count -eq 0) { 'missing' } else { 'ambiguous' }
    return [pscustomobject][ordered]@{
        lifecycleState = $state
        session = [ordered]@{ status = $sessionStatus; id = $sessionId; count = [int]$sessions.Count }
        steam = [ordered]@{
            status = $steamStatus
            pid = if ($steamSame.Count -eq 1) { [int]$steamSame[0].pid } else { $null }
            sessionId = if ($steamSame.Count -eq 1) { [int]$steamSame[0].sessionId } else { $null }
        }
        process = $processEvidence
        port = [ordered]@{ port = [int]$Profile.gamePort; listenerCount = [int]$portListeners.Count }
        pidFile = [ordered]@{ present = [bool]$pidEvidence.present; valid = [bool]$pidEvidence.valid }
    }
}

function Get-WorkerTaskEvidence {
    param([Parameter(Mandatory)]$Profile, [switch]$AllowPreparedDisabled)
    try {
        $pair = Assert-DysonLifecycleBrokerTaskPair -Profile $Profile -Backend $Backend -ShadowRoot $ShadowRoot `
            -AllowPreparedDisabled:$AllowPreparedDisabled
        return [pscustomobject][ordered]@{
            valid = $true
            server = [ordered]@{ name = 'Dyson-Nebula-Server'; path = '\'; state = [string]$pair.server.state }
            stop = [ordered]@{ name = 'Dyson-Nebula-Stop'; path = '\'; state = [string]$pair.stop.state }
        }
    }
    catch {
        return [pscustomobject][ordered]@{
            valid = $false
            server = [ordered]@{ name = 'Dyson-Nebula-Server'; path = '\'; state = 'unknown' }
            stop = [ordered]@{ name = 'Dyson-Nebula-Stop'; path = '\'; state = 'unknown' }
        }
    }
}

function Get-WorkerPreflightEvidence {
    param([Parameter(Mandatory)]$Profile, [Parameter(Mandatory)][string]$Action)
    $task = Get-WorkerTaskEvidence $Profile
    $runtime = Get-WorkerLifecycleEvidence $Profile
    $blockers = [Collections.Generic.List[string]]::new()
    if (-not $task.valid) { [void]$blockers.Add('task_definition_mismatch') }
    if ([string]$runtime.session.status -ceq 'missing') { [void]$blockers.Add('interactive_session_missing') }
    elseif ([string]$runtime.session.status -ceq 'ambiguous') { [void]$blockers.Add('session_ambiguous') }
    if ($Action -cin @('start', 'restart')) {
        if ([string]$runtime.steam.status -ceq 'missing') { [void]$blockers.Add('steam_session_missing') }
        elseif ([string]$runtime.steam.status -ceq 'ambiguous') { [void]$blockers.Add('session_ambiguous') }
    }
    if ([string]$runtime.lifecycleState -ceq 'unknown_unverifiable') { [void]$blockers.Add('process_unverifiable') }
    elseif ($Action -ceq 'start' -and [string]$runtime.lifecycleState -ne 'stopped_verified') { [void]$blockers.Add('server_already_running') }
    elseif ($Action -cne 'start' -and [string]$runtime.lifecycleState -ne 'running_verified') { [void]$blockers.Add('server_not_running') }
    $boundedBlockers = @($blockers | Select-Object -Unique)
    return [pscustomobject][ordered]@{
        action = $Action
        allowed = ($boundedBlockers.Count -eq 0)
        blockers = $boundedBlockers
        task = $task
        runtime = $runtime
        dispatch = [ordered]@{ attempted = $false; taskName = $null }
    }
}

function Assert-WorkerLease {
    param([Parameter(Mandatory)]$Profile, [Parameter(Mandatory)]$Request)
    if ([string]$Request.capability -cne 'LifecycleDispatch') { return }
    if ($Backend -ceq 'Shadow') {
        $lease = Read-DysonLifecycleBrokerJson -Path (Join-Path $ShadowRoot 'lease.json') -MaximumBytes 4096 `
            -InvalidCode 'DYSON_CONTROL_LIFECYCLE_BROKER_LEASE_INVALID'
        Assert-DysonLifecycleBrokerExactProperties $lease @('instanceId', 'token', 'valid', 'loseAfterChecks') `
            'DYSON_CONTROL_LIFECYCLE_BROKER_LEASE_INVALID'
        $countPath = Join-Path $ShadowRoot 'lease-check-count.txt'
        $count = 0
        if (Test-Path -LiteralPath $countPath -PathType Leaf) { [void][int]::TryParse((Get-Content -Raw $countPath).Trim(), [ref]$count) }
        $count += 1
        [IO.File]::WriteAllText($countPath, [string]$count, [Text.UTF8Encoding]::new($false))
        if (-not [bool]$lease.valid -or ([int]$lease.loseAfterChecks -gt 0 -and $count -gt [int]$lease.loseAfterChecks) -or
            [string]$lease.instanceId -cne [string]$Request.input.leaseInstanceId -or
            [string]$lease.token -cne [string]$Request.input.leaseToken) {
            Throw-DysonLifecycleBrokerError 'DYSON_CONTROL_LIFECYCLE_BROKER_LEASE_INVALID'
        }
        return
    }
    $leasePath = Join-Path ([string]$Profile.installedWindowsRoot) 'DysonHostMutationLease.Common.ps1'
    $entry = @($Profile.dependencyHashes | Where-Object { [string]$_.name -ceq 'DysonHostMutationLease.Common.ps1' })
    if ($entry.Count -ne 1 -or (Get-DysonLifecycleBrokerSha256File $leasePath) -cne [string]$entry[0].sha256) {
        Throw-DysonLifecycleBrokerError 'DYSON_CONTROL_LIFECYCLE_BROKER_HASH_DRIFT'
    }
    . $leasePath
    try {
        [void](Assert-DysonHostMutationLeaseBorrow -DataRoot ([string]$Profile.dataRoot) `
            -InstanceId ([string]$Request.input.leaseInstanceId) -Token ([string]$Request.input.leaseToken))
    }
    catch { Throw-DysonLifecycleBrokerError 'DYSON_CONTROL_LIFECYCLE_BROKER_LEASE_INVALID' }
}

function Set-WorkerShadowTaskState {
    param([Parameter(Mandatory)][ValidateSet('server', 'stop')][string]$Kind, [Parameter(Mandatory)][string]$State)
    $path = Join-Path $ShadowRoot ($Kind + '-task.json')
    $raw = Read-DysonLifecycleBrokerJson -Path $path -MaximumBytes 32768 -InvalidCode 'DYSON_CONTROL_LIFECYCLE_BROKER_TASK_INVALID'
    $record = [ordered]@{ descriptor = $raw.descriptor; state = $State }
    Remove-DysonLifecycleBrokerPlainFile $path
    [void](Write-DysonLifecycleBrokerJsonNew -Path $path -Value $record -MaximumBytes 32768)
}

function Invoke-WorkerDispatch {
    param([Parameter(Mandatory)]$Profile, [Parameter(Mandatory)]$Request)
    Assert-DysonLifecycleBrokerDependencies $Profile
    Assert-WorkerLease $Profile $Request
    $taskPair = Assert-DysonLifecycleBrokerTaskPair -Profile $Profile -Backend $Backend -ShadowRoot $ShadowRoot
    $operation = [string]$Request.input.operation
    $kind = if ($operation -ceq 'graceful-stop') { 'stop' } else { 'server' }
    $taskName = if ($kind -ceq 'server') { 'Dyson-Nebula-Server' } else { 'Dyson-Nebula-Stop' }
    $preflightAction = if ($kind -ceq 'server') { 'start' } else { 'graceful-stop' }
    $preflight = Get-WorkerPreflightEvidence -Profile $Profile -Action $preflightAction
    if (-not $preflight.allowed) {
        return [pscustomobject][ordered]@{
            status = 'blocked'; errorCode = $null
            evidence = [pscustomobject][ordered]@{
                operation = $operation; dispatched = $false; blockers = @($preflight.blockers)
                taskName = $taskName; runtime = $preflight.runtime
            }
        }
    }
    Assert-DysonLifecycleBrokerDependencies $Profile
    Assert-WorkerLease $Profile $Request
    if ($Backend -ceq 'Shadow') {
        [IO.File]::AppendAllText((Join-Path $ShadowRoot 'dispatch.log'), $taskName + "`n", [Text.UTF8Encoding]::new($false))
        if ($kind -ceq 'server') { Set-WorkerShadowTaskState -Kind server -State Running }
        else { Set-WorkerShadowTaskState -Kind stop -State Running }
    }
    else {
        try { Start-ScheduledTask -TaskName $taskName -TaskPath '\' -ErrorAction Stop }
        catch { Throw-DysonLifecycleBrokerError 'DYSON_CONTROL_LIFECYCLE_BROKER_TASK_TRIGGER_FAILED' }
    }
    Assert-WorkerLease $Profile $Request
    $readyVerified = $true
    if ($kind -ceq 'server') {
        $deadline = [datetime]::UtcNow.AddSeconds([int]$Profile.dispatchReadyTimeoutSeconds)
        $readyVerified = $false
        do {
            if ($Backend -ceq 'Shadow') {
                $control = Read-DysonLifecycleBrokerJson -Path (Join-Path $ShadowRoot 'dispatch-control.json') -MaximumBytes 4096 `
                    -InvalidCode 'DYSON_CONTROL_LIFECYCLE_BROKER_REQUEST_INVALID'
                Assert-DysonLifecycleBrokerExactProperties $control @('readyTimeout') 'DYSON_CONTROL_LIFECYCLE_BROKER_REQUEST_INVALID'
                if (-not [bool]$control.readyTimeout) {
                    Set-WorkerShadowTaskState -Kind server -State Running
                    $readyVerified = $true
                }
            }
            else {
                $state = [string](Get-ScheduledTask -TaskName $taskName -TaskPath '\' -ErrorAction Stop).State
                # The pinned bootstrap remains active for the lifetime of the game.
                # Process and port readiness are verified separately after dispatch.
                if ($state -ceq 'Running') { $readyVerified = $true }
            }
            if (-not $readyVerified) { Start-Sleep -Milliseconds 200 }
        } while (-not $readyVerified -and [datetime]::UtcNow -lt $deadline)
        if (-not $readyVerified) { Throw-DysonLifecycleBrokerError 'DYSON_CONTROL_LIFECYCLE_BROKER_READY_TIMEOUT' }
    }
    Assert-WorkerLease $Profile $Request
    return [pscustomobject][ordered]@{
        status = 'succeeded'; errorCode = $null
        evidence = [pscustomobject][ordered]@{
            operation = $operation; dispatched = $true; blockers = @(); taskName = $taskName
            taskPath = '\'; readyVerified = $readyVerified
        }
    }
}

function ConvertTo-WorkerValidatedIntent {
    param([Parameter(Mandatory)]$Raw)
    Assert-DysonLifecycleBrokerExactProperties $Raw @(
        'protocol', 'schemaVersion', 'brokerRequestId', 'requestFingerprint', 'capability', 'input', 'createdAt'
    ) 'DYSON_CONTROL_LIFECYCLE_BROKER_RECOVERY_REQUIRED'
    if ([string]$Raw.protocol -cne $script:DysonLifecycleBrokerIntentProtocol -or [int]$Raw.schemaVersion -ne 1 -or
        [string]$Raw.requestFingerprint -cnotmatch '^[0-9a-f]{64}$' -or
        [string]$Raw.capability -cnotin $script:DysonLifecycleBrokerCapabilities) {
        Throw-DysonLifecycleBrokerError 'DYSON_CONTROL_LIFECYCLE_BROKER_RECOVERY_REQUIRED'
    }
    [void](ConvertTo-DysonLifecycleBrokerGuid ([string]$Raw.brokerRequestId) 'DYSON_CONTROL_LIFECYCLE_BROKER_RECOVERY_REQUIRED')
    Assert-DysonLifecycleBrokerTimestamp ([string]$Raw.createdAt) 'DYSON_CONTROL_LIFECYCLE_BROKER_RECOVERY_REQUIRED'
    return $Raw
}

function Write-WorkerReceipt {
    param([Parameter(Mandatory)]$Paths, [Parameter(Mandatory)]$Receipt)
    if (Test-Path -LiteralPath $Paths.receipt -PathType Leaf) {
        $existing = ConvertTo-DysonLifecycleBrokerValidatedReceipt (Read-DysonLifecycleBrokerJson -Path $Paths.receipt `
            -MaximumBytes $script:DysonLifecycleBrokerMaximumReceiptBytes -InvalidCode 'DYSON_CONTROL_LIFECYCLE_BROKER_RECEIPT_INVALID')
        if ([string]$existing.requestFingerprint -cne [string]$Receipt.requestFingerprint) {
            Throw-DysonLifecycleBrokerError 'DYSON_CONTROL_LIFECYCLE_BROKER_REQUEST_CONFLICT'
        }
        return $existing
    }
    [void](Write-DysonLifecycleBrokerJsonNew -Path $Paths.receipt -Value $Receipt `
        -MaximumBytes $script:DysonLifecycleBrokerMaximumReceiptBytes -ConflictCode 'DYSON_CONTROL_LIFECYCLE_BROKER_REQUEST_CONFLICT')
    return $Receipt
}

function Resolve-WorkerInterruptedIntent {
    param([Parameter(Mandatory)]$Profile, [Parameter(Mandatory)]$Request, [Parameter(Mandatory)]$Intent, [Parameter(Mandatory)]$Paths)
    if ([string]$Intent.requestFingerprint -cne [string]$Request.requestFingerprint -or
        [string]$Intent.capability -cne [string]$Request.capability) {
        Throw-DysonLifecycleBrokerError 'DYSON_CONTROL_LIFECYCLE_BROKER_RECOVERY_REQUIRED'
    }
    if ([string]$Request.capability -cne 'LifecycleDispatch') {
        Remove-DysonLifecycleBrokerPlainFile $Paths.intent
        return $null
    }
    $runtime = Get-WorkerLifecycleEvidence $Profile
    $expected = if ([string]$Request.input.operation -ceq 'graceful-stop') { 'stopped_verified' } else { 'running_verified' }
    if ([string]$runtime.lifecycleState -ceq $expected) {
        $receipt = New-DysonLifecycleBrokerReceipt -Request $Request -Status succeeded -ErrorCode $null -Evidence ([pscustomobject][ordered]@{
            operation = [string]$Request.input.operation; dispatched = $false; recovered = $true
            blockers = @(); runtime = $runtime
        })
        [void](Write-WorkerReceipt -Paths $Paths -Receipt $receipt)
        Remove-DysonLifecycleBrokerPlainFile $Paths.intent
        return $receipt
    }
    $receipt = New-DysonLifecycleBrokerReceipt -Request $Request -Status failed `
        -ErrorCode 'DYSON_CONTROL_LIFECYCLE_BROKER_RECOVERY_REQUIRED' -Evidence ([pscustomobject][ordered]@{
            operation = [string]$Request.input.operation; dispatched = $false; recovered = $false
            blockers = @('recovery_required'); runtime = $runtime
        })
    [void](Write-WorkerReceipt -Paths $Paths -Receipt $receipt)
    return $receipt
}

function Invoke-WorkerRequest {
    param([Parameter(Mandatory)]$Profile, [Parameter(Mandatory)]$Storage, [Parameter(Mandatory)][string]$RequestPath)
    $raw = Read-DysonLifecycleBrokerJson -Path $RequestPath -MaximumBytes $script:DysonLifecycleBrokerMaximumRequestBytes `
        -InvalidCode 'DYSON_CONTROL_LIFECYCLE_BROKER_REQUEST_INVALID'
    $request = ConvertTo-DysonLifecycleBrokerValidatedRequest $raw
    $paths = Get-DysonLifecycleBrokerRecordPaths $Storage $request.brokerRequestId
    if (-not (Test-DysonLifecycleBrokerSamePath $RequestPath $paths.request)) {
        Throw-DysonLifecycleBrokerError 'DYSON_CONTROL_LIFECYCLE_BROKER_REQUEST_INVALID'
    }
    Assert-DysonLifecycleBrokerRequestBinding -Request $request -Profile $Profile -ProfileFile $ProfileFile
    Assert-DysonLifecycleBrokerDependencies $Profile
    if (Test-Path -LiteralPath $paths.receipt -PathType Leaf) {
        $existing = ConvertTo-DysonLifecycleBrokerValidatedReceipt (Read-DysonLifecycleBrokerJson -Path $paths.receipt `
            -MaximumBytes $script:DysonLifecycleBrokerMaximumReceiptBytes -InvalidCode 'DYSON_CONTROL_LIFECYCLE_BROKER_RECEIPT_INVALID')
        if ([string]$existing.requestFingerprint -cne [string]$request.requestFingerprint) {
            Throw-DysonLifecycleBrokerError 'DYSON_CONTROL_LIFECYCLE_BROKER_REQUEST_CONFLICT'
        }
        return $existing
    }
    if (Test-Path -LiteralPath $paths.intent -PathType Leaf) {
        $intent = ConvertTo-WorkerValidatedIntent (Read-DysonLifecycleBrokerJson -Path $paths.intent `
            -MaximumBytes $script:DysonLifecycleBrokerMaximumIntentBytes -InvalidCode 'DYSON_CONTROL_LIFECYCLE_BROKER_RECOVERY_REQUIRED')
        $recovered = Resolve-WorkerInterruptedIntent -Profile $Profile -Request $request -Intent $intent -Paths $paths
        if ($null -ne $recovered) { return $recovered }
    }
    $intent = [ordered]@{
        protocol = $script:DysonLifecycleBrokerIntentProtocol; schemaVersion = 1
        brokerRequestId = [string]$request.brokerRequestId; requestFingerprint = [string]$request.requestFingerprint
        capability = [string]$request.capability; input = $request.input
        createdAt = (Get-Date).ToUniversalTime().ToString('o')
    }
    [void](Write-DysonLifecycleBrokerJsonNew -Path $paths.intent -Value $intent `
        -MaximumBytes $script:DysonLifecycleBrokerMaximumIntentBytes)
    try {
        switch ([string]$request.capability) {
            'LifecyclePreflight' {
                $evidence = Get-WorkerPreflightEvidence -Profile $Profile -Action ([string]$request.input.action)
                $outcome = [pscustomobject]@{ status = if ($evidence.allowed) { 'succeeded' } else { 'blocked' }; errorCode = $null; evidence = $evidence }
            }
            'LifecycleDispatch' { $outcome = Invoke-WorkerDispatch -Profile $Profile -Request $request }
            'LifecycleVerify' {
                $runtime = Get-WorkerLifecycleEvidence $Profile
                $target = if ([string]$request.input.expected -ceq 'running') { 'running_verified' } else { 'stopped_verified' }
                $matched = [string]$runtime.lifecycleState -ceq $target
                $blockers = @(if ([string]$runtime.lifecycleState -ceq 'unknown_unverifiable') { @('process_unverifiable') } `
                    elseif (-not $matched) { @('state_mismatch') } else { @() })
                $outcome = [pscustomobject]@{
                    status = if ($matched) { 'succeeded' } else { 'blocked' }; errorCode = $null
                    evidence = [pscustomobject][ordered]@{
                        expected = [string]$request.input.expected; matched = $matched; blockers = $blockers; runtime = $runtime
                    }
                }
            }
            'LifecycleStatus' {
                $task = Get-WorkerTaskEvidence $Profile -AllowPreparedDisabled
                $runtime = Get-WorkerLifecycleEvidence $Profile
                if (-not $task.valid) { $runtime.lifecycleState = 'unknown_unverifiable' }
                $outcome = [pscustomobject]@{
                    status = 'succeeded'; errorCode = $null
                    evidence = [pscustomobject][ordered]@{ lifecycleState = [string]$runtime.lifecycleState; task = $task; runtime = $runtime; processTelemetry = Get-WorkerProcessTelemetry $Profile $runtime }
                }
            }
        }
        $receipt = New-DysonLifecycleBrokerReceipt -Request $request -Status $outcome.status -ErrorCode $outcome.errorCode -Evidence $outcome.evidence
    }
    catch {
        $code = Get-DysonLifecycleBrokerErrorCode $_.Exception
        $receipt = New-DysonLifecycleBrokerReceipt -Request $request -Status failed -ErrorCode $code -Evidence ([pscustomobject][ordered]@{
            dispatched = $false; blockers = @($code.ToLowerInvariant())
        })
    }
    [void](Write-WorkerReceipt -Paths $paths -Receipt $receipt)
    Remove-DysonLifecycleBrokerPlainFile $paths.intent
    return $receipt
}

function Invoke-WorkerStatusRetention {
    param([Parameter(Mandatory)]$Storage)
    $closed = [Collections.Generic.List[object]]::new()
    foreach ($receiptFile in @(Get-ChildItem -LiteralPath $Storage.receipts -Filter '*.json' -File -ErrorAction Stop)) {
        try {
            $receipt = ConvertTo-DysonLifecycleBrokerValidatedReceipt (Read-DysonLifecycleBrokerJson -Path $receiptFile.FullName `
                -MaximumBytes $script:DysonLifecycleBrokerMaximumReceiptBytes -InvalidCode 'DYSON_CONTROL_LIFECYCLE_BROKER_RECEIPT_INVALID')
            if ([string]$receipt.capability -cne 'LifecycleStatus') { continue }
            $paths = Get-DysonLifecycleBrokerRecordPaths $Storage ([string]$receipt.brokerRequestId)
            if (Test-Path -LiteralPath $paths.intent -PathType Leaf) { continue }
            $request = ConvertTo-DysonLifecycleBrokerValidatedRequest (Read-DysonLifecycleBrokerJson -Path $paths.request `
                -MaximumBytes $script:DysonLifecycleBrokerMaximumRequestBytes -InvalidCode 'DYSON_CONTROL_LIFECYCLE_BROKER_REQUEST_INVALID')
            if ([string]$request.capability -cne 'LifecycleStatus' -or
                [string]$request.requestFingerprint -cne [string]$receipt.requestFingerprint) { continue }
            [void]$closed.Add([pscustomobject][ordered]@{
                completedAt = [datetimeoffset]::ParseExact(
                    [string]$receipt.completedAt,
                    'o',
                    [Globalization.CultureInfo]::InvariantCulture,
                    [Globalization.DateTimeStyles]::RoundtripKind
                )
                requestPath = $paths.request
                receiptPath = $paths.receipt
            })
        }
        catch { }
    }
    if ($closed.Count -le $script:DysonLifecycleBrokerMaximumClosedStatusRecords) { return 0 }
    $cutoff = [datetimeoffset]::UtcNow.AddSeconds(-$script:DysonLifecycleBrokerMinimumStatusRetentionSeconds)
    $removed = 0
    $ordered = @($closed | Sort-Object completedAt)
    foreach ($candidate in @($ordered | Where-Object { $_.completedAt -le $cutoff })) {
        if (($closed.Count - $removed) -le $script:DysonLifecycleBrokerMaximumClosedStatusRecords) { break }
        # Receipt-first means an interruption can only cause a safe re-observation, never a stale receipt replay.
        Remove-DysonLifecycleBrokerPlainFile $candidate.receiptPath
        Remove-DysonLifecycleBrokerPlainFile $candidate.requestPath
        $removed += 1
    }
    # Preserve the normal one-hour/256-record floor, but bound a burst of fresh status polling absolutely.
    # Every candidate was already validated as a closed, fingerprint-matched Status pair without an intent.
    if (($closed.Count - $removed) -gt $script:DysonLifecycleBrokerMaximumClosedStatusHardRecords) {
        foreach ($candidate in @($ordered | Select-Object -Skip $removed)) {
            if (($closed.Count - $removed) -le $script:DysonLifecycleBrokerMaximumClosedStatusHardRecords) { break }
            Remove-DysonLifecycleBrokerPlainFile $candidate.receiptPath
            Remove-DysonLifecycleBrokerPlainFile $candidate.requestPath
            $removed += 1
        }
    }
    return $removed
}

try {
    $resolvedBrokerRoot = Assert-DysonLifecycleBrokerPlainDirectory $BrokerRoot
    $resolvedProfileFile = Assert-DysonLifecycleBrokerPlainFile -Path $ProfileFile -MaximumBytes $script:DysonLifecycleBrokerMaximumProfileBytes
    if (-not (Test-DysonLifecycleBrokerSamePath $resolvedProfileFile (Join-Path $resolvedBrokerRoot 'broker-profile.json'))) {
        Throw-DysonLifecycleBrokerError 'DYSON_CONTROL_LIFECYCLE_BROKER_PROFILE_BINDING_MISMATCH'
    }
    if ($Backend -ceq 'Windows') {
        $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
        if (-not $identity.IsSystem) { Throw-DysonLifecycleBrokerError 'DYSON_CONTROL_LIFECYCLE_BROKER_PROFILE_BINDING_MISMATCH' }
    }
    else {
        if ($env:DYSON_LIFECYCLE_BROKER_SELFTEST -cne '1' -or [string]::IsNullOrWhiteSpace($ShadowRoot)) {
            Throw-DysonLifecycleBrokerError 'DYSON_CONTROL_LIFECYCLE_BROKER_SHADOW_FORBIDDEN'
        }
        $ShadowRoot = Assert-DysonLifecycleBrokerPlainDirectory $ShadowRoot
        if (-not (Test-Path -LiteralPath (Join-Path $ShadowRoot '.dyson-lifecycle-broker-selftest') -PathType Leaf)) {
            Throw-DysonLifecycleBrokerError 'DYSON_CONTROL_LIFECYCLE_BROKER_SHADOW_FORBIDDEN'
        }
    }
    $profile = Read-DysonLifecycleBrokerProfile $resolvedProfileFile
    if (-not (Test-DysonLifecycleBrokerSamePath $profile.brokerRoot $resolvedBrokerRoot) -or
        -not (Test-DysonLifecycleBrokerSamePath $profile.brokerScriptRoot $PSScriptRoot)) {
        Throw-DysonLifecycleBrokerError 'DYSON_CONTROL_LIFECYCLE_BROKER_PROFILE_BINDING_MISMATCH'
    }
    Assert-DysonLifecycleBrokerDependencies $profile
    $storage = Get-DysonLifecycleBrokerStorage -BrokerRoot $resolvedBrokerRoot
    $processed = 0
    foreach ($requestFile in @(Get-ChildItem -LiteralPath $storage.requests -Filter '*.json' -File -ErrorAction Stop | Sort-Object Name)) {
        $candidateId = [IO.Path]::GetFileNameWithoutExtension($requestFile.Name)
        try { $candidatePaths = Get-DysonLifecycleBrokerRecordPaths $storage $candidateId }
        catch { continue }
        if (Test-Path -LiteralPath $candidatePaths.receipt -PathType Leaf) { continue }
        try { [void](Invoke-WorkerRequest -Profile $profile -Storage $storage -RequestPath $requestFile.FullName) }
        catch { }
        $processed += 1
        if ($processed -ge 32) { break }
    }
    $statusRecordsRemoved = Invoke-WorkerStatusRetention -Storage $storage
    [ordered]@{
        protocol = 'DYSON_CONTROL_LIFECYCLE_BROKER_WORKER_V1'; schemaVersion = 1
        processed = $processed; statusRecordsRemoved = $statusRecordsRemoved
    } | ConvertTo-Json -Compress
    exit 0
}
catch {
    Write-DysonLifecycleBrokerFailureEnvelope (Get-DysonLifecycleBrokerErrorCode $_.Exception)
    exit 1
}
