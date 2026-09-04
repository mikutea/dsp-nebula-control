[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$BrokerRoot,
    [Parameter(Mandatory)][string]$BrokerProfileFile,
    [ValidateSet('Windows', 'Shadow')][string]$SchedulerBackend = 'Windows',
    [string]$ShadowRoot,
    [string]$OnceBrokerRequestId
)

Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)

function ConvertTo-WorkerCommandLineArgument {
    param([Parameter(Mandatory)][AllowEmptyString()][string]$Value)

    if ($Value.IndexOf([char]0) -ge 0 -or $Value -match '[\r\n"]') {
        Throw-DysonCutoverBrokerError 'DYSON_CONTROL_CUTOVER_BROKER_INPUT_INVALID'
    }
    if ($Value -notmatch '[\s]') { return $Value }
    return '"' + $Value + '"'
}

function Invoke-WorkerBoundedChild {
    param(
        [Parameter(Mandatory)][string]$ScriptPath,
        [Parameter(Mandatory)][string[]]$ChildArguments,
        [Parameter(Mandatory)][string]$WorkRoot,
        [ValidateRange(10, 600)][int]$TimeoutSeconds = 300
    )

    $scriptFile = Assert-DysonCutoverBrokerPlainFile $ScriptPath 2097152
    $work = Assert-DysonCutoverBrokerPlainDirectory $WorkRoot
    $powerShell = [IO.Path]::GetFullPath((Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'))
    [void](Assert-DysonCutoverBrokerPlainFile $powerShell 2097152)
    $nonce = [guid]::NewGuid().ToString('N')
    $stdoutPath = Join-Path $work ($nonce + '.stdout')
    $stderrPath = Join-Path $work ($nonce + '.stderr')
    $process = $null
    try {
        $tokens = @('-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', $scriptFile) + $ChildArguments
        $commandLine = (@($tokens | ForEach-Object { ConvertTo-WorkerCommandLineArgument ([string]$_) }) -join ' ')
        $process = Start-Process -FilePath $powerShell -ArgumentList $commandLine -NoNewWindow -PassThru `
            -RedirectStandardOutput $stdoutPath -RedirectStandardError $stderrPath -ErrorAction Stop
        $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
        while (-not $process.HasExited) {
            foreach ($outputPath in @($stdoutPath, $stderrPath)) {
                if (Test-Path -LiteralPath $outputPath -PathType Leaf) {
                    $length = (Get-Item -LiteralPath $outputPath -Force -ErrorAction Stop).Length
                    if ($length -gt $script:DysonCutoverBrokerMaximumChildOutputBytes) {
                        try { Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue } catch {}
                        Throw-DysonCutoverBrokerError 'DYSON_CONTROL_CUTOVER_BROKER_CHILD_OUTPUT_LIMIT'
                    }
                }
            }
            if ((Get-Date) -ge $deadline) {
                try { Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue } catch {}
                Throw-DysonCutoverBrokerError 'DYSON_CONTROL_CUTOVER_BROKER_RECOVERY_REQUIRED'
            }
            Start-Sleep -Milliseconds 25
            $process.Refresh()
        }
        $process.WaitForExit()
        foreach ($outputPath in @($stdoutPath, $stderrPath)) {
            $item = Get-Item -LiteralPath $outputPath -Force -ErrorAction Stop
            if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint -or
                $item.Length -gt $script:DysonCutoverBrokerMaximumChildOutputBytes) {
                Throw-DysonCutoverBrokerError 'DYSON_CONTROL_CUTOVER_BROKER_CHILD_OUTPUT_LIMIT'
            }
        }
        $stdoutBytes = [IO.File]::ReadAllBytes($stdoutPath)
        $stderrBytes = [IO.File]::ReadAllBytes($stderrPath)
        $stdout = [Text.UTF8Encoding]::new($false, $true).GetString($stdoutBytes).Trim()
        $stderr = [Text.UTF8Encoding]::new($false, $true).GetString($stderrBytes).Trim()
        if ($process.ExitCode -ne 0) {
            Throw-DysonCutoverBrokerError 'DYSON_CONTROL_CUTOVER_BROKER_CHILD_FAILED'
        }
        if ([string]::IsNullOrWhiteSpace($stdout) -or -not [string]::IsNullOrWhiteSpace($stderr)) {
            Throw-DysonCutoverBrokerError 'DYSON_CONTROL_CUTOVER_BROKER_CHILD_OUTPUT_INVALID'
        }
        try { return $stdout | ConvertFrom-Json -ErrorAction Stop }
        catch { Throw-DysonCutoverBrokerError 'DYSON_CONTROL_CUTOVER_BROKER_CHILD_OUTPUT_INVALID' }
    }
    catch {
        if ($_.Exception.Data.Contains('Code')) { throw $_.Exception }
        Throw-DysonCutoverBrokerError 'DYSON_CONTROL_CUTOVER_BROKER_CHILD_FAILED'
    }
    finally {
        if ($null -ne $process) { $process.Dispose() }
        foreach ($path in @($stdoutPath, $stderrPath)) {
            if (Test-Path -LiteralPath $path -PathType Leaf) {
                Remove-Item -LiteralPath $path -Force -ErrorAction SilentlyContinue
            }
        }
    }
}

function Assert-WorkerProductionBinding {
    param([Parameter(Mandatory)]$Request)

    try {
        $leaseCommon = Join-Path $Request.cutoverScriptRoot 'DysonHostMutationLease.Common.ps1'
        $hostCommon = Join-Path $Request.cutoverScriptRoot 'cutover\DysonCutoverHost.Common.ps1'
        [void](Assert-DysonCutoverBrokerPlainFile $leaseCommon 2097152)
        [void](Assert-DysonCutoverBrokerPlainFile $hostCommon 2097152)
        . $leaseCommon
        . $hostCommon
        Initialize-CutoverHostContext -ProjectRoot $Request.projectRoot `
            -ProfileFile $Request.authorityProfileFile `
            -RuntimeBootstrapRoot $Request.runtimeBootstrapRoot `
            -RuntimeTaskTransactionRoot $Request.runtimeTaskTransactionRoot `
            -ServiceUser $Request.serviceUser -GamePort $Request.gamePort `
            -AuthorityInventoryRevision $Request.authorityInventoryRevision `
            -RequestId $Request.requestId -Backend Windows -DataRoot $Request.dataRoot `
            -LeaseInstanceId $Request.leaseInstanceId -LeaseToken $Request.leaseToken
    }
    catch { Throw-DysonCutoverBrokerError 'DYSON_CONTROL_CUTOVER_BROKER_PROFILE_BINDING_MISMATCH' }
}

function Assert-WorkerChildReceipt {
    param(
        [Parameter(Mandatory)]$Request,
        [Parameter(Mandatory)]$ChildReceipt
    )

    try {
        if ($Request.capability -ceq 'CandidateTaskTransaction') {
            Assert-DysonCutoverBrokerExactProperties $ChildReceipt @(
                'protocol', 'schemaVersion', 'requestId', 'requestFingerprint', 'status', 'mode',
                'serverTask', 'stopTask', 'terminalPairDigest', 'completedAt', 'reused'
            )
            if ($ChildReceipt.protocol -isnot [string] -or
                [string]$ChildReceipt.protocol -cne 'DYSON_CONTROL_RUNTIME_TASK_RECEIPT_V2' -or
                (($ChildReceipt.schemaVersion -isnot [int]) -and ($ChildReceipt.schemaVersion -isnot [long])) -or
                [int64]$ChildReceipt.schemaVersion -ne 2 -or
                $ChildReceipt.requestId -isnot [string] -or [string]$ChildReceipt.requestId -cne $Request.requestId -or
                $ChildReceipt.requestFingerprint -isnot [string] -or [string]$ChildReceipt.requestFingerprint -cnotmatch '^[0-9a-f]{64}$' -or
                $ChildReceipt.status -isnot [string] -or [string]$ChildReceipt.status -notin @('succeeded', 'rolled-back') -or
                $ChildReceipt.mode -isnot [string] -or [string]$ChildReceipt.mode -cne [string]$Request.candidateMode -or
                $ChildReceipt.serverTask -isnot [string] -or [string]$ChildReceipt.serverTask -cne 'Dyson-Nebula-Server' -or
                $ChildReceipt.stopTask -isnot [string] -or [string]$ChildReceipt.stopTask -cne 'Dyson-Nebula-Stop' -or
                $ChildReceipt.terminalPairDigest -isnot [string] -or [string]$ChildReceipt.terminalPairDigest -cnotmatch '^[0-9a-f]{64}$' -or
                $ChildReceipt.reused -isnot [bool]) {
                throw 'candidate receipt'
            }
            Assert-DysonCutoverBrokerTimestamp $ChildReceipt.completedAt 'DYSON_CONTROL_CUTOVER_BROKER_CHILD_OUTPUT_INVALID'
        }
        else {
            Assert-DysonCutoverBrokerExactProperties $ChildReceipt @(
                'protocol', 'schemaVersion', 'requestId', 'authorityInventoryRevision', 'action', 'status'
            )
            if ($ChildReceipt.protocol -isnot [string] -or
                [string]$ChildReceipt.protocol -cne 'DYSON_CONTROL_CUTOVER_ACTION_RECEIPT_V1' -or
                (($ChildReceipt.schemaVersion -isnot [int]) -and ($ChildReceipt.schemaVersion -isnot [long])) -or
                [int64]$ChildReceipt.schemaVersion -ne 1 -or
                $ChildReceipt.requestId -isnot [string] -or [string]$ChildReceipt.requestId -cne $Request.requestId -or
                $ChildReceipt.authorityInventoryRevision -isnot [string] -or
                [string]$ChildReceipt.authorityInventoryRevision -cne $Request.authorityInventoryRevision -or
                $ChildReceipt.action -isnot [string] -or [string]$ChildReceipt.action -cne $Request.capability -or
                $ChildReceipt.status -isnot [string] -or [string]$ChildReceipt.status -cne 'succeeded') {
                throw 'action receipt'
            }
        }
        return $ChildReceipt
    }
    catch {
        if ($_.Exception.Data.Contains('Code') -and
            [string]$_.Exception.Data['Code'] -eq 'DYSON_CONTROL_CUTOVER_BROKER_CHILD_OUTPUT_INVALID') {
            throw $_.Exception
        }
        Throw-DysonCutoverBrokerError 'DYSON_CONTROL_CUTOVER_BROKER_CHILD_OUTPUT_INVALID'
    }
}

function Invoke-WorkerShadowDispatch {
    param(
        [Parameter(Mandatory)]$Request,
        [Parameter(Mandatory)][string]$ShadowRoot
    )

    $mode = [string]$env:DYSON_CUTOVER_BROKER_SELFTEST_CHILD_MODE
    if ([string]::IsNullOrWhiteSpace($mode)) { $mode = 'success' }
    $dispatchRecord = [pscustomobject][ordered]@{
        brokerRequestId = $Request.brokerRequestId
        capability = $Request.capability
        requestId = $Request.requestId
        projectRoot = $Request.projectRoot
        dataRoot = $Request.dataRoot
        authorityProfileFile = $Request.authorityProfileFile
        cutoverScriptRoot = $Request.cutoverScriptRoot
        runtimeBootstrapRoot = $Request.runtimeBootstrapRoot
        runtimeTaskTransactionRoot = $Request.runtimeTaskTransactionRoot
        serviceUser = $Request.serviceUser
        gamePort = $Request.gamePort
        candidateMode = $Request.candidateMode
        candidateRecover = $Request.candidateRecover
    }
    [IO.File]::AppendAllText(
        (Join-Path $ShadowRoot 'dispatch.log'),
        (ConvertTo-DysonCutoverBrokerJson $dispatchRecord) + "`n",
        [Text.UTF8Encoding]::new($false)
    )
    $rolledBackReplay = $false
    if ($mode -ceq 'candidate-rollback-replay') {
        if ($Request.capability -cne 'CandidateTaskTransaction' -or [bool]$Request.candidateRecover) {
            Throw-DysonCutoverBrokerError 'DYSON_CONTROL_CUTOVER_BROKER_CHILD_OUTPUT_INVALID'
        }
        $counterPath = Join-Path $ShadowRoot ($Request.brokerRequestId + '.candidate-replay-count')
        $count = 0
        if (Test-Path -LiteralPath $counterPath -PathType Leaf) {
            $count = [int](Get-Content -LiteralPath $counterPath -Raw -ErrorAction Stop)
        }
        $count++
        [IO.File]::WriteAllText($counterPath, [string]$count, [Text.UTF8Encoding]::new($false))
        if ($count -eq 1) {
            Throw-DysonCutoverBrokerError 'DYSON_CONTROL_CUTOVER_BROKER_CHILD_FAILED'
        }
        if ($count -ne 2) {
            Throw-DysonCutoverBrokerError 'DYSON_CONTROL_CUTOVER_BROKER_CHILD_OUTPUT_INVALID'
        }
        $rolledBackReplay = $true
    }
    elseif ($mode -ceq 'candidate-recover-failure') {
        if ($Request.capability -cne 'CandidateTaskTransaction' -or -not [bool]$Request.candidateRecover) {
            Throw-DysonCutoverBrokerError 'DYSON_CONTROL_CUTOVER_BROKER_CHILD_OUTPUT_INVALID'
        }
        Throw-DysonCutoverBrokerError 'DYSON_CONTROL_CUTOVER_BROKER_CHILD_FAILED'
    }
    if ($mode -ceq 'failure') {
        Throw-DysonCutoverBrokerError 'DYSON_CONTROL_CUTOVER_BROKER_CHILD_FAILED'
    }
    if ($mode -ceq 'oversize') {
        Throw-DysonCutoverBrokerError 'DYSON_CONTROL_CUTOVER_BROKER_CHILD_OUTPUT_LIMIT'
    }
    if ($mode -notin @('success', 'candidate-rollback-replay')) {
        Throw-DysonCutoverBrokerError 'DYSON_CONTROL_CUTOVER_BROKER_CHILD_OUTPUT_INVALID'
    }
    if ($Request.capability -ceq 'CandidateTaskTransaction') {
        return [pscustomobject][ordered]@{
            protocol = 'DYSON_CONTROL_RUNTIME_TASK_RECEIPT_V2'
            schemaVersion = 2
            requestId = $Request.requestId
            requestFingerprint = ('a' * 64)
            status = $(if ($Request.candidateRecover -or $rolledBackReplay) { 'rolled-back' } else { 'succeeded' })
            mode = $Request.candidateMode
            serverTask = 'Dyson-Nebula-Server'
            stopTask = 'Dyson-Nebula-Stop'
            terminalPairDigest = ('b' * 64)
            completedAt = (Get-Date).ToUniversalTime().ToString('o')
            reused = $false
        }
    }
    return [pscustomobject][ordered]@{
        protocol = 'DYSON_CONTROL_CUTOVER_ACTION_RECEIPT_V1'
        schemaVersion = 1
        requestId = $Request.requestId
        authorityInventoryRevision = $Request.authorityInventoryRevision
        action = $Request.capability
        status = 'succeeded'
    }
}

function Invoke-WorkerWindowsDispatch {
    param(
        [Parameter(Mandatory)]$Request,
        [Parameter(Mandatory)]$Profile,
        [Parameter(Mandatory)]$Storage
    )

    if ($Request.capability -ceq 'CandidateTaskTransaction') {
        $scriptPath = Join-Path $Profile.cutoverScriptRoot 'Install-DysonRuntimeTasks.ps1'
        $arguments = @(
            '-ProjectRoot', $Request.projectRoot,
            '-DataRoot', $Request.dataRoot,
            '-InstalledScriptRoot', $Request.runtimeBootstrapRoot,
            '-ServiceUser', $Request.serviceUser,
            '-Mode', $Request.candidateMode,
            '-RequestId', $Request.requestId,
            '-ServerTaskName', 'Dyson-Nebula-Server',
            '-StopTaskName', 'Dyson-Nebula-Stop',
            '-Ups', '60',
            '-TaskBackupRoot', $Request.runtimeTaskTransactionRoot,
            '-SchedulerBackend', 'Windows',
            '-LeaseInstanceId', $Request.leaseInstanceId,
            '-LeaseToken', $Request.leaseToken,
            '-Confirm:$false'
        )
        if ($Request.candidateRecover) { $arguments += '-Recover' }
    }
    else {
        $scriptPath = Join-Path $Profile.cutoverScriptRoot 'cutover\Invoke-DysonCutoverAction.ps1'
        $arguments = @(
            '-ProjectRoot', $Request.projectRoot,
            '-ProfileFile', $Request.authorityProfileFile,
            '-RuntimeBootstrapRoot', $Request.runtimeBootstrapRoot,
            '-RuntimeTaskTransactionRoot', $Request.runtimeTaskTransactionRoot,
            '-ServiceUser', $Request.serviceUser,
            '-GamePort', ([string]$Request.gamePort),
            '-AuthorityInventoryRevision', $Request.authorityInventoryRevision,
            '-RequestId', $Request.requestId,
            '-Action', $Request.capability,
            '-DataRoot', $Request.dataRoot,
            '-LeaseInstanceId', $Request.leaseInstanceId,
            '-LeaseToken', $Request.leaseToken,
            '-Confirm:$false'
        )
    }
    return Invoke-WorkerBoundedChild -ScriptPath $scriptPath -ChildArguments $arguments -WorkRoot $Storage.workRoot
}

function ConvertTo-WorkerValidatedIntent {
    param([Parameter(Mandatory)]$Raw)

    try {
        Assert-DysonCutoverBrokerExactProperties $Raw @(
            'protocol', 'schemaVersion', 'brokerRequestId', 'requestFingerprint', 'capability',
            'requestId', 'authorityInventoryRevision', 'state', 'createdAt'
        )
        if ($Raw.protocol -isnot [string] -or [string]$Raw.protocol -cne $script:DysonCutoverBrokerIntentProtocol -or
            (($Raw.schemaVersion -isnot [int]) -and ($Raw.schemaVersion -isnot [long])) -or
            [int64]$Raw.schemaVersion -ne 1 -or
            $Raw.requestFingerprint -isnot [string] -or [string]$Raw.requestFingerprint -cnotmatch '^[0-9a-f]{64}$' -or
            $Raw.capability -isnot [string] -or [string]$Raw.capability -notin $script:DysonCutoverBrokerCapabilities -or
            $Raw.authorityInventoryRevision -isnot [string] -or [string]$Raw.authorityInventoryRevision -cnotmatch '^[0-9a-f]{64}$' -or
            $Raw.state -isnot [string] -or [string]$Raw.state -cne 'dispatching') {
            throw 'intent'
        }
        Assert-DysonCutoverBrokerTimestamp $Raw.createdAt
        [void](ConvertTo-DysonCutoverBrokerGuid $Raw.brokerRequestId 'DYSON_CONTROL_CUTOVER_BROKER_REQUEST_INVALID')
        [void](ConvertTo-DysonCutoverBrokerGuid $Raw.requestId 'DYSON_CONTROL_CUTOVER_BROKER_REQUEST_INVALID')
        return $Raw
    }
    catch { Throw-DysonCutoverBrokerError 'DYSON_CONTROL_CUTOVER_BROKER_RECOVERY_REQUIRED' }
}

function Write-WorkerTerminalReceipt {
    param(
        [Parameter(Mandatory)]$Request,
        [Parameter(Mandatory)]$Paths,
        [Parameter(Mandatory)][ValidateSet('succeeded', 'failed')][string]$State,
        [AllowNull()]$ErrorCode,
        [AllowNull()]$ChildReceipt
    )

    $receipt = New-DysonCutoverBrokerReceipt -Request $Request -State $State `
        -ErrorCode $ErrorCode -ChildReceipt $ChildReceipt
    try {
        Write-DysonCutoverBrokerJsonNew -Path $Paths.receipt -Value $receipt `
            -MaximumBytes $script:DysonCutoverBrokerMaximumReceiptBytes
        return $receipt
    }
    catch {
        $raw = Read-DysonCutoverBrokerJson -Path $Paths.receipt `
            -MaximumBytes $script:DysonCutoverBrokerMaximumReceiptBytes -AllowMissing `
            -InvalidCode 'DYSON_CONTROL_CUTOVER_BROKER_RECEIPT_INVALID'
        if ($null -eq $raw) { throw $_.Exception }
        $existing = ConvertTo-DysonCutoverBrokerValidatedReceipt $raw
        if ([string]$existing.requestFingerprint -cne [string]$Request.requestFingerprint) {
            Throw-DysonCutoverBrokerError 'DYSON_CONTROL_CUTOVER_BROKER_REQUEST_CONFLICT'
        }
        return $existing
    }
}

function Invoke-WorkerRequest {
    param(
        [Parameter(Mandatory)][string]$RequestPath,
        [Parameter(Mandatory)]$Profile,
        [Parameter(Mandatory)]$Storage,
        [Parameter(Mandatory)][string]$Backend,
        [AllowNull()][string]$Shadow
    )

    $request = $null
    $paths = $null
    $intentPersisted = $false
    $writeStage = {
        param([string]$Stage)
        if ($Backend -ceq 'Shadow' -and -not [string]::IsNullOrWhiteSpace($Shadow)) {
            [IO.File]::AppendAllText((Join-Path $Shadow 'worker-stage.log'),
                ($Stage + ':' + [IO.Path]::GetFileNameWithoutExtension($RequestPath) + "`n"),
                [Text.UTF8Encoding]::new($false))
        }
    }
    try {
        $fileName = [IO.Path]::GetFileNameWithoutExtension($RequestPath)
        $fileId = ConvertTo-DysonCutoverBrokerGuid $fileName 'DYSON_CONTROL_CUTOVER_BROKER_REQUEST_INVALID'
        $raw = Read-DysonCutoverBrokerJson -Path $RequestPath `
            -MaximumBytes $script:DysonCutoverBrokerMaximumRequestBytes `
            -InvalidCode 'DYSON_CONTROL_CUTOVER_BROKER_REQUEST_INVALID'
        $request = ConvertTo-DysonCutoverBrokerValidatedRequest $raw
        if ([string]$request.brokerRequestId -cne $fileId) {
            Throw-DysonCutoverBrokerError 'DYSON_CONTROL_CUTOVER_BROKER_REQUEST_INVALID'
        }
        $paths = Get-DysonCutoverBrokerRecordPaths -Storage $Storage -BrokerRequestId $request.brokerRequestId
        $rawReceipt = Read-DysonCutoverBrokerJson -Path $paths.receipt `
            -MaximumBytes $script:DysonCutoverBrokerMaximumReceiptBytes -AllowMissing `
            -InvalidCode 'DYSON_CONTROL_CUTOVER_BROKER_RECEIPT_INVALID'
        if ($null -ne $rawReceipt) {
            $receipt = ConvertTo-DysonCutoverBrokerValidatedReceipt $rawReceipt
            if ([string]$receipt.requestFingerprint -cne [string]$request.requestFingerprint) {
                Throw-DysonCutoverBrokerError 'DYSON_CONTROL_CUTOVER_BROKER_REQUEST_CONFLICT'
            }
            Remove-DysonCutoverBrokerPlainFile $paths.request
            return $receipt
        }
        Assert-DysonCutoverBrokerRequestBinding -Request $request -Profile $Profile
        & $writeStage 'binding-validated'

        $rawIntent = Read-DysonCutoverBrokerJson -Path $paths.intent `
            -MaximumBytes $script:DysonCutoverBrokerMaximumRequestBytes -AllowMissing `
            -InvalidCode 'DYSON_CONTROL_CUTOVER_BROKER_RECOVERY_REQUIRED'
        if ($null -ne $rawIntent) {
            $intent = ConvertTo-WorkerValidatedIntent $rawIntent
            if ([string]$intent.brokerRequestId -cne [string]$request.brokerRequestId -or
                [string]$intent.requestFingerprint -cne [string]$request.requestFingerprint) {
                Throw-DysonCutoverBrokerError 'DYSON_CONTROL_CUTOVER_BROKER_REQUEST_CONFLICT'
            }
            return Write-WorkerTerminalReceipt -Request $request -Paths $paths -State failed `
                -ErrorCode 'DYSON_CONTROL_CUTOVER_BROKER_RECOVERY_REQUIRED' -ChildReceipt $null
        }

        Assert-DysonCutoverBrokerLease $request
        & $writeStage 'lease-before-binding'
        if ($Backend -ceq 'Windows') { Assert-WorkerProductionBinding $request }
        Assert-DysonCutoverBrokerLease $request
        & $writeStage 'lease-before-intent'
        $intent = [pscustomobject][ordered]@{
            protocol = $script:DysonCutoverBrokerIntentProtocol
            schemaVersion = 1
            brokerRequestId = $request.brokerRequestId
            requestFingerprint = $request.requestFingerprint
            capability = $request.capability
            requestId = $request.requestId
            authorityInventoryRevision = $request.authorityInventoryRevision
            state = 'dispatching'
            createdAt = (Get-Date).ToUniversalTime().ToString('o')
        }
        Write-DysonCutoverBrokerJsonNew -Path $paths.intent -Value $intent `
            -MaximumBytes $script:DysonCutoverBrokerMaximumRequestBytes
        $intentPersisted = $true
        & $writeStage 'intent-persisted'
        Assert-DysonCutoverBrokerLease $request
        & $writeStage 'lease-before-dispatch'
        $dispatch = {
            if ($Backend -ceq 'Shadow') {
                return Invoke-WorkerShadowDispatch -Request $request -ShadowRoot $Shadow
            }
            return Invoke-WorkerWindowsDispatch -Request $request -Profile $Profile -Storage $Storage
        }
        $ordinaryCandidateReceiptReplay = $false
        try { $child = & $dispatch }
        catch {
            $firstCode = Get-DysonCutoverBrokerErrorCode $_.Exception
            if ($request.capability -cne 'CandidateTaskTransaction' -or
                [bool]$request.candidateRecover -or
                $firstCode -cne 'DYSON_CONTROL_CUTOVER_BROKER_CHILD_FAILED') {
                throw $_.Exception
            }
            # Install-DysonRuntimeTasks deliberately exits non-zero after a complete rollback.
            # One byte-equivalent ordinary replay is allowed solely to recover its durable rolled-back receipt.
            Assert-DysonCutoverBrokerLease $request
            & $writeStage 'lease-before-replay'
            $ordinaryCandidateReceiptReplay = $true
            $child = & $dispatch
        }
        & $writeStage 'child-returned'
        Assert-DysonCutoverBrokerLease $request
        & $writeStage 'lease-after-child'
        if ($ordinaryCandidateReceiptReplay -and
            ($null -eq $child.PSObject.Properties['status'] -or [string]$child.status -cne 'rolled-back')) {
            Throw-DysonCutoverBrokerError 'DYSON_CONTROL_CUTOVER_BROKER_CHILD_OUTPUT_INVALID'
        }
        $validatedChild = Assert-WorkerChildReceipt -Request $request -ChildReceipt $child
        & $writeStage 'child-validated'
        Assert-DysonCutoverBrokerLease $request
        $receipt = Write-WorkerTerminalReceipt -Request $request -Paths $paths -State succeeded `
            -ErrorCode $null -ChildReceipt $validatedChild
        & $writeStage 'receipt-persisted'
        Remove-DysonCutoverBrokerPlainFile $paths.intent
        Remove-DysonCutoverBrokerPlainFile $paths.request
        return $receipt
    }
    catch {
        if ($null -eq $request -or $null -eq $paths) { throw $_.Exception }
        $code = Get-DysonCutoverBrokerErrorCode $_.Exception
        & $writeStage ('failed-' + $code)
        if ($intentPersisted -or (Test-Path -LiteralPath $paths.intent -PathType Leaf)) {
            $code = 'DYSON_CONTROL_CUTOVER_BROKER_RECOVERY_REQUIRED'
        }
        $receipt = Write-WorkerTerminalReceipt -Request $request -Paths $paths -State failed `
            -ErrorCode $code -ChildReceipt $null
        if (Test-Path -LiteralPath $paths.intent -PathType Leaf) {
            try { Remove-DysonCutoverBrokerPlainFile $paths.intent } catch {}
        }
        if (Test-Path -LiteralPath $paths.request -PathType Leaf) {
            try { Remove-DysonCutoverBrokerPlainFile $paths.request } catch {}
        }
        return $receipt
    }
}

try {
    $commonPath = Join-Path $PSScriptRoot 'DysonCutoverBroker.Common.ps1'
    if (-not (Test-Path -LiteralPath $commonPath -PathType Leaf)) { throw 'common missing' }
    . $commonPath
    $profile = Read-DysonCutoverBrokerProfile -BrokerRoot $BrokerRoot -BrokerProfileFile $BrokerProfileFile
    $expectedWorker = Join-Path $profile.brokerScriptRoot 'Invoke-DysonCutoverBrokerWorker.ps1'
    if (-not (Test-DysonCutoverBrokerSamePath $PSCommandPath $expectedWorker) -or
        (Get-DysonCutoverBrokerSha256File $PSCommandPath) -cne $profile.workerScriptSha256) {
        Throw-DysonCutoverBrokerError 'DYSON_CONTROL_CUTOVER_BROKER_PROFILE_BINDING_MISMATCH'
    }
    $storage = Get-DysonCutoverBrokerStorage $profile.brokerRoot
    $shadow = $null
    if ($SchedulerBackend -ceq 'Shadow') {
        if ($env:DYSON_CUTOVER_BROKER_SELFTEST -cne '1' -or [string]::IsNullOrWhiteSpace($ShadowRoot)) {
            Throw-DysonCutoverBrokerError 'DYSON_CONTROL_CUTOVER_BROKER_SHADOW_FORBIDDEN'
        }
        $shadow = Assert-DysonCutoverBrokerPlainDirectory $ShadowRoot
        if (-not (Test-Path -LiteralPath (Join-Path $shadow '.dyson-cutover-broker-selftest') -PathType Leaf)) {
            Throw-DysonCutoverBrokerError 'DYSON_CONTROL_CUTOVER_BROKER_SHADOW_FORBIDDEN'
        }
    }
    else {
        if (-not [string]::IsNullOrWhiteSpace($OnceBrokerRequestId)) {
            Throw-DysonCutoverBrokerError 'DYSON_CONTROL_CUTOVER_BROKER_INPUT_INVALID'
        }
        $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
        if (-not $identity.IsSystem) {
            Throw-DysonCutoverBrokerError 'DYSON_CONTROL_CUTOVER_BROKER_TASK_INVALID'
        }
    }

    if (-not [string]::IsNullOrWhiteSpace($OnceBrokerRequestId)) {
        $once = ConvertTo-DysonCutoverBrokerGuid $OnceBrokerRequestId
        $requestFiles = @(Join-Path $storage.requestsRoot ($once + '.json'))
    }
    else {
        $requestFiles = @(Get-ChildItem -LiteralPath $storage.requestsRoot -Filter '*.json' -File -Force -ErrorAction Stop |
            Sort-Object Name | Select-Object -First $script:DysonCutoverBrokerMaximumPendingRequests |
            ForEach-Object {
                if ($_.Attributes -band [IO.FileAttributes]::ReparsePoint) {
                    Throw-DysonCutoverBrokerError 'DYSON_CONTROL_CUTOVER_BROKER_REQUEST_INVALID'
                }
                $_.FullName
            })
    }
    $processed = 0
    $failed = 0
    foreach ($requestFile in $requestFiles) {
        if (-not (Test-Path -LiteralPath $requestFile -PathType Leaf)) { continue }
        try {
            $terminal = Invoke-WorkerRequest -RequestPath $requestFile -Profile $profile `
                -Storage $storage -Backend $SchedulerBackend -Shadow $shadow
            $processed++
            if ([string]$terminal.state -cne 'succeeded') { $failed++ }
        }
        catch { $failed++ }
    }
    [pscustomobject][ordered]@{
        protocol = 'DYSON_CONTROL_CUTOVER_BROKER_WORKER_V1'
        schemaVersion = 1
        processed = $processed
        failed = $failed
    } | ConvertTo-Json -Compress
    if ($failed -gt 0) { exit 1 }
    exit 0
}
catch {
    $code = 'DYSON_CONTROL_CUTOVER_BROKER_INTERNAL_ERROR'
    if (Get-Command -Name Get-DysonCutoverBrokerErrorCode -ErrorAction SilentlyContinue) {
        $code = Get-DysonCutoverBrokerErrorCode $_.Exception
    }
    Write-DysonCutoverBrokerFailureEnvelope $code
    exit 1
}
