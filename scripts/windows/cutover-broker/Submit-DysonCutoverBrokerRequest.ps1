[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$BrokerRoot,
    [Parameter(Mandatory)][string]$BrokerProfileFile,
    [Parameter(Mandatory)][string]$BrokerRequestId,
    [Parameter(Mandatory)][string]$Capability,
    [Parameter(Mandatory)][string]$RequestId,
    [Parameter(Mandatory)][string]$AuthorityInventoryRevision,
    [Parameter(Mandatory)][string]$ProjectRoot,
    [Parameter(Mandatory)][string]$DataRoot,
    [Parameter(Mandatory)][string]$AuthorityProfileFile,
    [Parameter(Mandatory)][string]$CutoverScriptRoot,
    [Parameter(Mandatory)][string]$RuntimeBootstrapRoot,
    [Parameter(Mandatory)][string]$RuntimeTaskTransactionRoot,
    [Parameter(Mandatory)][string]$ServiceUser,
    [Parameter(Mandatory)][int]$GamePort,
    [string]$LeaseInstanceId = '',
    [string]$LeaseToken = '',
    [ValidateSet('PrepareDisabled', 'Activate')][string]$CandidateMode,
    [switch]$CandidateRecover,
    [switch]$PreviousStopReconcileOnly,
    [ValidateRange(10, 300)][int]$TimeoutSeconds = 120,
    [ValidateSet('Windows', 'Shadow')][string]$SchedulerBackend = 'Windows',
    [string]$ShadowRoot
)

Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)

function Start-SubmitBoundBrokerTask {
    param([Parameter(Mandatory)]$Profile, [switch]$OnlyIfIdle)
        try {
            $matches = @(Get-ScheduledTask -TaskName $profile.taskName -TaskPath $profile.taskPath -ErrorAction Stop)
            if ($matches.Count -ne 1) { throw 'task count' }
            $task = $matches[0]
            if ([string]$task.TaskName -cne $profile.taskName -or [string]$task.TaskPath -cne $profile.taskPath -or
                [string]$task.Principal.UserId -notin @('SYSTEM', 'NT AUTHORITY\SYSTEM', 'S-1-5-18') -or
                [string]$task.Principal.LogonType -cne 'ServiceAccount' -or
                [string]$task.Principal.RunLevel -cne 'Highest' -or
                [string]$task.State -ceq 'Disabled') {
                throw 'task principal'
            }
            $actions = @($task.Actions)
            $expectedPowerShell = [IO.Path]::GetFullPath((Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'))
            if ($actions.Count -ne 1 -or
                -not [string]::Equals(
                    [IO.Path]::GetFullPath([Environment]::ExpandEnvironmentVariables([string]$actions[0].Execute)),
                    $expectedPowerShell,
                    [StringComparison]::OrdinalIgnoreCase
                ) -or [string]$actions[0].Arguments -cne (Get-DysonCutoverBrokerTaskArguments $profile)) {
                throw 'task action'
            }
        }
        catch { Throw-DysonCutoverBrokerError 'DYSON_CONTROL_CUTOVER_BROKER_TASK_INVALID' }
        if ($OnlyIfIdle -and [string]$task.State -in @('Running','Queued')) { return }
        try { Start-ScheduledTask -TaskName $profile.taskName -TaskPath $profile.taskPath -ErrorAction Stop }
        catch { Throw-DysonCutoverBrokerError 'DYSON_CONTROL_CUTOVER_BROKER_TASK_TRIGGER_FAILED' }
}

try {
    $commonPath = Join-Path $PSScriptRoot 'DysonCutoverBroker.Common.ps1'
    if (-not (Test-Path -LiteralPath $commonPath -PathType Leaf)) { throw 'common missing' }
    . $commonPath

    $profile = Read-DysonCutoverBrokerProfile -BrokerRoot $BrokerRoot -BrokerProfileFile $BrokerProfileFile
    $expectedSubmit = Join-Path $profile.brokerScriptRoot 'Submit-DysonCutoverBrokerRequest.ps1'
    if (-not (Test-DysonCutoverBrokerSamePath $PSCommandPath $expectedSubmit) -or
        (Get-DysonCutoverBrokerSha256File $PSCommandPath) -cne $profile.submitScriptSha256) {
        Throw-DysonCutoverBrokerError 'DYSON_CONTROL_CUTOVER_BROKER_PROFILE_BINDING_MISMATCH'
    }
    if ($Capability -notin $script:DysonCutoverBrokerCapabilities) {
        Throw-DysonCutoverBrokerError 'DYSON_CONTROL_CUTOVER_BROKER_CAPABILITY_INVALID'
    }
    if ($Capability -ceq 'CandidateTaskTransaction') {
        if ([string]::IsNullOrWhiteSpace($CandidateMode)) {
            Throw-DysonCutoverBrokerError 'DYSON_CONTROL_CUTOVER_BROKER_INPUT_INVALID'
        }
    }
    elseif (-not [string]::IsNullOrWhiteSpace($CandidateMode) -or $CandidateRecover) {
        Throw-DysonCutoverBrokerError 'DYSON_CONTROL_CUTOVER_BROKER_INPUT_INVALID'
    }

    $candidateModeValue = if ([string]::IsNullOrWhiteSpace($CandidateMode)) { $null } else { [string]$CandidateMode }
    $request = New-DysonCutoverBrokerRequest `
        -BrokerRequestId $BrokerRequestId -Capability $Capability -RequestId $RequestId `
        -AuthorityInventoryRevision $AuthorityInventoryRevision -ProjectRoot $ProjectRoot `
        -DataRoot $DataRoot -AuthorityProfileFile $AuthorityProfileFile `
        -CutoverScriptRoot $CutoverScriptRoot -RuntimeBootstrapRoot $RuntimeBootstrapRoot `
        -RuntimeTaskTransactionRoot $RuntimeTaskTransactionRoot -ServiceUser $ServiceUser `
        -GamePort $GamePort -LeaseInstanceId $LeaseInstanceId -LeaseToken $LeaseToken `
        -CandidateMode $candidateModeValue -CandidateRecover ([bool]$CandidateRecover) -PreviousStopReconcileOnly ([bool]$PreviousStopReconcileOnly)
    Assert-DysonCutoverBrokerRequestBinding -Request $request -Profile $profile

    $storage = Get-DysonCutoverBrokerStorage $profile.brokerRoot
    $paths = Get-DysonCutoverBrokerRecordPaths -Storage $storage -BrokerRequestId $request.brokerRequestId
    $reused = $false
    $existingReceipt = Read-DysonCutoverBrokerJson -Path $paths.receipt `
        -MaximumBytes $script:DysonCutoverBrokerMaximumReceiptBytes -AllowMissing `
        -InvalidCode 'DYSON_CONTROL_CUTOVER_BROKER_RECEIPT_INVALID'
    if ($null -ne $existingReceipt) {
        $receipt = ConvertTo-DysonCutoverBrokerValidatedReceipt $existingReceipt
        if ([string]$receipt.requestFingerprint -cne [string]$request.requestFingerprint) {
            Throw-DysonCutoverBrokerError 'DYSON_CONTROL_CUTOVER_BROKER_REQUEST_CONFLICT'
        }
        (ConvertTo-DysonCutoverBrokerResultEnvelope -Receipt $receipt -Reused $true) |
            ConvertTo-Json -Depth 32 -Compress
        exit 0
    }

    $existingRequest = Read-DysonCutoverBrokerJson -Path $paths.request `
        -MaximumBytes $script:DysonCutoverBrokerMaximumRequestBytes -AllowMissing `
        -InvalidCode 'DYSON_CONTROL_CUTOVER_BROKER_REQUEST_INVALID'
    if ($null -ne $existingRequest) {
        $validatedExisting = ConvertTo-DysonCutoverBrokerValidatedRequest $existingRequest
        if ([string]$validatedExisting.requestFingerprint -cne [string]$request.requestFingerprint) {
            Throw-DysonCutoverBrokerError 'DYSON_CONTROL_CUTOVER_BROKER_REQUEST_CONFLICT'
        }
        $reused = $true
    }
    else {
        Write-DysonCutoverBrokerJsonNew -Path $paths.request -Value $request `
            -MaximumBytes $script:DysonCutoverBrokerMaximumRequestBytes
    }

    if ($SchedulerBackend -ceq 'Shadow') {
        if ($env:DYSON_CUTOVER_BROKER_SELFTEST -cne '1' -or [string]::IsNullOrWhiteSpace($ShadowRoot)) {
            Throw-DysonCutoverBrokerError 'DYSON_CONTROL_CUTOVER_BROKER_SHADOW_FORBIDDEN'
        }
        $shadow = Assert-DysonCutoverBrokerPlainDirectory $ShadowRoot
        if (-not (Test-Path -LiteralPath (Join-Path $shadow '.dyson-cutover-broker-selftest') -PathType Leaf)) {
            Throw-DysonCutoverBrokerError 'DYSON_CONTROL_CUTOVER_BROKER_SHADOW_FORBIDDEN'
        }
        $worker = Join-Path $profile.brokerScriptRoot 'Invoke-DysonCutoverBrokerWorker.ps1'
        $powerShell = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
        & $powerShell -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $worker `
            -BrokerRoot $profile.brokerRoot -BrokerProfileFile $storage.profileFile `
            -SchedulerBackend Shadow -ShadowRoot $shadow -OnceBrokerRequestId $request.brokerRequestId | Out-Null
    }
    else { Start-SubmitBoundBrokerTask -Profile $profile }

    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    $nextReadWake = [DateTime]::UtcNow.AddSeconds(1)
    do {
        $rawReceipt = Read-DysonCutoverBrokerJson -Path $paths.receipt `
            -MaximumBytes $script:DysonCutoverBrokerMaximumReceiptBytes -AllowMissing `
            -InvalidCode 'DYSON_CONTROL_CUTOVER_BROKER_RECEIPT_INVALID'
        if ($null -ne $rawReceipt) {
            $receipt = ConvertTo-DysonCutoverBrokerValidatedReceipt $rawReceipt
            if ([string]$receipt.requestFingerprint -cne [string]$request.requestFingerprint) {
                Throw-DysonCutoverBrokerError 'DYSON_CONTROL_CUTOVER_BROKER_REQUEST_CONFLICT'
            }
            (ConvertTo-DysonCutoverBrokerResultEnvelope -Receipt $receipt -Reused $reused) |
                ConvertTo-Json -Depth 32 -Compress
            exit 0
        }
        if ($Capability -ceq 'CutoverEvidence' -and $SchedulerBackend -ceq 'Windows' -and [DateTime]::UtcNow -ge $nextReadWake) {
            # IgnoreNew can lose the initial wake while the preceding worker exits.
            # Recheck the fixed task and wake only once it is idle; never replay a mutation.
            Start-SubmitBoundBrokerTask -Profile $profile -OnlyIfIdle
            $nextReadWake = [DateTime]::UtcNow.AddSeconds(1)
        }
        Start-Sleep -Milliseconds 100
    } while ((Get-Date) -lt $deadline)
    Throw-DysonCutoverBrokerError 'DYSON_CONTROL_CUTOVER_BROKER_TIMEOUT'
}
catch [System.Management.Automation.PipelineStoppedException] {
    Write-DysonCutoverBrokerFailureEnvelope 'DYSON_CONTROL_CUTOVER_BROKER_CANCELLED'
    exit 1
}
catch {
    $code = 'DYSON_CONTROL_CUTOVER_BROKER_INTERNAL_ERROR'
    if (Get-Command -Name Get-DysonCutoverBrokerErrorCode -ErrorAction SilentlyContinue) {
        $code = Get-DysonCutoverBrokerErrorCode $_.Exception
    }
    Write-DysonCutoverBrokerFailureEnvelope $code
    exit 1
}
