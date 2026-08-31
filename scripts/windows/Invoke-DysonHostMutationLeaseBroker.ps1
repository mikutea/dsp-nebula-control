[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$DataRoot,
    [Parameter(Mandatory)][string]$Owner,
    [Parameter(Mandatory)][string]$Operation,
    [Parameter(Mandatory)][string]$RequestId,
    [Parameter(Mandatory)][ValidateRange(1, 2147483647)][int]$OwnerPid,
    [ValidateRange(0, 120000)][int]$TimeoutMilliseconds = 30000,
    [string]$RecoveryPriorInstanceId,
    [string]$RecoveryPriorRecordDigest
)

Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = [System.Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$commonScript = Join-Path $PSScriptRoot 'DysonHostMutationLease.Common.ps1'

function Write-DysonHostMutationBrokerMessage {
    param([Parameter(Mandatory)]$Message)

    $text = $Message | ConvertTo-Json -Depth 3 -Compress
    if ([System.Text.UTF8Encoding]::new($false).GetByteCount($text) -gt 2048) {
        $text = '{"protocol":"DYSON_HOST_MUTATION_BROKER_V1","type":"error","code":"DYSON_HOST_MUTATION_LEASE_BROKER_PROTOCOL_FAILED","priorInstanceId":null,"priorRecordDigest":null,"priorState":null}'
    }
    [Console]::Out.WriteLine($text)
    [Console]::Out.Flush()
}

if (-not (Test-Path -LiteralPath $commonScript -PathType Leaf)) {
    Write-DysonHostMutationBrokerMessage -Message ([pscustomobject][ordered]@{
        protocol = 'DYSON_HOST_MUTATION_BROKER_V1'
        type = 'error'
        code = 'DYSON_HOST_MUTATION_LEASE_BROKER_UNAVAILABLE'
        priorInstanceId = $null
        priorRecordDigest = $null
        priorState = $null
    })
    exit 20
}

try { . $commonScript }
catch {
    Write-DysonHostMutationBrokerMessage -Message ([pscustomobject][ordered]@{
        protocol = 'DYSON_HOST_MUTATION_BROKER_V1'
        type = 'error'
        code = 'DYSON_HOST_MUTATION_LEASE_BROKER_UNAVAILABLE'
        priorInstanceId = $null
        priorRecordDigest = $null
        priorState = $null
    })
    exit 20
}

$lease = $null
try {
    $enterArguments = @{
        DataRoot = $DataRoot
        Owner = $Owner
        Operation = $Operation
        RequestId = $RequestId
        OwnerPid = $OwnerPid
        TimeoutMilliseconds = $TimeoutMilliseconds
    }
    if (-not [string]::IsNullOrWhiteSpace($RecoveryPriorInstanceId)) {
        $enterArguments.RecoveryPriorInstanceId = $RecoveryPriorInstanceId
        $enterArguments.RecoveryPriorRecordDigest = $RecoveryPriorRecordDigest
    }
    $lease = Enter-DysonHostMutationLease @enterArguments
}
catch {
    $code = 'DYSON_HOST_MUTATION_LEASE_ACQUIRE_FAILED'
    $priorInstanceId = $null
    $priorRecordDigest = $null
    $priorState = $null
    if ($_.Exception.Data.Contains('Code') -and
        ([string]$_.Exception.Data['Code'] -match '^DYSON_HOST_MUTATION_LEASE_[A-Z0-9_]+$')) {
        $code = [string]$_.Exception.Data['Code']
    }
    if ($_.Exception.Data.Contains('PriorInstanceId')) {
        $candidate = [string]$_.Exception.Data['PriorInstanceId']
        if ($candidate -match '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$') {
            $priorInstanceId = $candidate
        }
    }
    if ($_.Exception.Data.Contains('PriorRecordDigest')) {
        $candidate = [string]$_.Exception.Data['PriorRecordDigest']
        if ($candidate -match '^[0-9a-f]{64}$') { $priorRecordDigest = $candidate }
    }
    if ($_.Exception.Data.Contains('PriorState')) {
        $candidate = [string]$_.Exception.Data['PriorState']
        if ($candidate -match '^(active|abandoned|recovery-required)$') { $priorState = $candidate }
    }
    Write-DysonHostMutationBrokerMessage -Message ([pscustomobject][ordered]@{
        protocol = 'DYSON_HOST_MUTATION_BROKER_V1'
        type = 'error'
        code = $code
        priorInstanceId = $priorInstanceId
        priorRecordDigest = $priorRecordDigest
        priorState = $priorState
    })
    exit 20
}

Write-DysonHostMutationBrokerMessage -Message ([pscustomobject][ordered]@{
    protocol = 'DYSON_HOST_MUTATION_BROKER_V1'
    type = 'ready'
    dataRootIdentity = $lease.DataRootIdentity
    instanceId = $lease.InstanceId
    token = $lease.Token
})

$command = $null
try { $command = [Console]::In.ReadLine() }
catch { $command = $null }

if ($command -ceq 'RELEASE') {
    try {
        [void](Exit-DysonHostMutationLease -Lease $lease -State released)
        exit 0
    }
    catch {
        try { if ($lease.Active) { $lease.Stream.Dispose() } } catch {}
        exit 21
    }
}

# Explicit action failure and parent stdin EOF share the same fail-closed durable
# disposition. Neither is allowed to turn an uncertain mutation into a clean release.
try {
    [void](Exit-DysonHostMutationLease -Lease $lease -State abandoned)
    exit 22
}
catch {
    try { if ($lease.Active) { $lease.Stream.Dispose() } } catch {}
    exit 21
}
