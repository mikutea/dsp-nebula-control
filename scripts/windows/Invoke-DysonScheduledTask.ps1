[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$ProjectRoot,
    [Parameter(Mandatory)][ValidatePattern('^[0-9A-Fa-f-]{36}$')][string]$RequestId,
    [Parameter(Mandatory)][ValidateSet('graceful-stop', 'start', 'rollback-start')][string]$Operation,
    [Parameter(Mandatory)][ValidatePattern('^[\p{L}\p{N}_. -]{1,128}$')][string]$TaskName,
    [Parameter(Mandatory)][string]$AllowedTaskScriptRoot,
    [ValidateRange(1, 65535)][int]$GamePort = 8469,
    [ValidateRange(10, 300)][int]$TimeoutSeconds = 180
)

# DYSON_CONTROL_RECEIPT_V1: fixed scheduled-task dispatch with durable reconciliation receipt.
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$parsedRequestId = [guid]::Empty
if (-not [guid]::TryParseExact($RequestId, 'D', [ref]$parsedRequestId)) { throw 'The lifecycle request ID is invalid.' }
$normalizedRequestId = $parsedRequestId.ToString('D').ToLowerInvariant()
$resolvedProjectRoot = (Resolve-Path -LiteralPath $ProjectRoot -ErrorAction Stop).ProviderPath
$taskScriptRootItem = Get-Item -LiteralPath $AllowedTaskScriptRoot -Force -ErrorAction Stop
if (-not $taskScriptRootItem.PSIsContainer -or
    ($taskScriptRootItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint)) {
    throw 'The stable runtime bootstrap root is unavailable or redirected.'
}
$resolvedTaskScriptRoot = $taskScriptRootItem.FullName
$expectedExecutable = [System.IO.Path]::GetFullPath((Join-Path $resolvedProjectRoot 'server\DSPGAME.exe'))
$executableItem = Get-Item -LiteralPath $expectedExecutable -Force -ErrorAction Stop
if ($executableItem.PSIsContainer -or ($executableItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint)) {
    throw 'The fixed managed DSP executable is unavailable or redirected.'
}
$receiptRoot = Join-Path $resolvedProjectRoot 'run\control-receipts'
[System.IO.Directory]::CreateDirectory($receiptRoot) | Out-Null
$receiptDirectory = Get-Item -LiteralPath $receiptRoot -Force -ErrorAction Stop
if (-not $receiptDirectory.PSIsContainer -or ($receiptDirectory.Attributes -band [System.IO.FileAttributes]::ReparsePoint)) {
    throw 'The lifecycle receipt directory is unavailable or redirected.'
}
$receiptPath = Join-Path $receiptDirectory.FullName ($normalizedRequestId + '.' + $Operation + '.json')

function Get-ManagedProcesses {
    $result = @()
    foreach ($candidate in @(Get-Process -Name 'DSPGAME' -ErrorAction SilentlyContinue)) {
        $verifiedManagedProcess = $false
        try {
            if ($candidate.Path -and [System.IO.Path]::GetFullPath($candidate.Path).Equals(
                $expectedExecutable,
                [System.StringComparison]::OrdinalIgnoreCase
            )) {
                $result += $candidate
                $verifiedManagedProcess = $true
            }
        }
        catch { }
        if (-not $verifiedManagedProcess) {
            throw 'A DSP process is running outside the fixed managed executable.'
        }
    }
    return @($result)
}

function Get-GamePortState {
    param([object[]]$Managed)
    $listeners = @(Get-NetTCPConnection -State Listen -ErrorAction Stop | Where-Object { $_.LocalPort -eq $GamePort })
    $listening = $listeners.Count -gt 0
    $ownedByManaged = $false
    if ($Managed.Count -eq 1 -and $listening) {
        $owned = @($listeners | Where-Object { [int]$_.OwningProcess -eq [int]$Managed[0].Id })
        $foreign = @($listeners | Where-Object { [int]$_.OwningProcess -ne [int]$Managed[0].Id })
        $ownedByManaged = $owned.Count -gt 0 -and $foreign.Count -eq 0
    }
    return [pscustomobject]@{ Listening = [bool]$listening; OwnedByManaged = [bool]$ownedByManaged }
}

function Assert-FixedTaskDefinition {
    param([Parameter(Mandatory)][object]$Task)

    if ($Task.State.ToString() -eq 'Disabled') { throw 'The configured lifecycle task is disabled.' }
    if ($Task.Principal.LogonType.ToString() -ne 'Interactive' -or [string]::IsNullOrWhiteSpace([string]$Task.Principal.UserId)) {
        throw 'The configured lifecycle task does not use a fixed interactive principal.'
    }
    $actions = @($Task.Actions)
    if ($actions.Count -ne 1) { throw 'The configured lifecycle task must contain exactly one action.' }
    $action = $actions[0]
    $expectedPowerShell = [System.IO.Path]::GetFullPath((Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'))
    $actualPowerShell = [System.IO.Path]::GetFullPath([Environment]::ExpandEnvironmentVariables([string]$action.Execute))
    if (-not $actualPowerShell.Equals($expectedPowerShell, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw 'The configured lifecycle task executable is not allowlisted.'
    }

    $expectedScriptName = if ($Operation -eq 'graceful-stop') { 'Stop-DysonServer.ps1' } else { 'Start-DysonServer.ps1' }
    $arguments = [string]$action.Arguments
    if ($arguments -match '[\r\n\0]') { throw 'The configured lifecycle task arguments are invalid.' }
    $argumentPattern = if ($expectedScriptName -eq 'Start-DysonServer.ps1') {
        '(?i)^-NoLogo\s+-NoProfile\s+-NonInteractive\s+-ExecutionPolicy\s+Bypass\s+-File\s+"(?<script>[^"]+)"\s+-ProjectRoot\s+"(?<root>[^"]+)"\s+-Ups\s+(?<bounded>\d{1,3})$'
    }
    else {
        '(?i)^-NoLogo\s+-NoProfile\s+-NonInteractive\s+-ExecutionPolicy\s+Bypass\s+-File\s+"(?<script>[^"]+)"\s+-ProjectRoot\s+"(?<root>[^"]+)"\s+-TimeoutSeconds\s+(?<bounded>\d{1,3})$'
    }
    $definitionMatch = [regex]::Match($arguments, $argumentPattern)
    if (-not $definitionMatch.Success) { throw 'The configured lifecycle task arguments are not allowlisted.' }
    $boundedValue = [int]$definitionMatch.Groups['bounded'].Value
    if ($expectedScriptName -eq 'Start-DysonServer.ps1' -and ($boundedValue -lt 5 -or $boundedValue -gt 240)) {
        throw 'The configured server UPS is outside the fixed bounds.'
    }
    if ($expectedScriptName -eq 'Stop-DysonServer.ps1' -and ($boundedValue -lt 10 -or $boundedValue -gt 300)) {
        throw 'The configured stop timeout is outside the fixed bounds.'
    }
    $expectedScript = (Resolve-Path -LiteralPath (Join-Path $resolvedTaskScriptRoot $expectedScriptName) -ErrorAction Stop).ProviderPath
    $scriptItem = Get-Item -LiteralPath $expectedScript -Force -ErrorAction Stop
    if ($scriptItem.PSIsContainer -or ($scriptItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint)) {
        throw 'The fixed lifecycle action script is unavailable or redirected.'
    }
    $actualScript = (Resolve-Path -LiteralPath $definitionMatch.Groups['script'].Value -ErrorAction Stop).ProviderPath
    $actualProjectRoot = (Resolve-Path -LiteralPath $definitionMatch.Groups['root'].Value -ErrorAction Stop).ProviderPath
    if (-not [string]::Equals($actualScript, $expectedScript, [System.StringComparison]::OrdinalIgnoreCase) -or
        -not [string]::Equals($actualProjectRoot, $resolvedProjectRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw 'The configured lifecycle task action is outside the fixed allowlist.'
    }
}

function Write-Receipt {
    param(
        [Parameter(Mandatory)][ValidateSet('dispatching', 'succeeded', 'failed')][string]$State,
        [Parameter(Mandatory)][string]$Outcome,
        [Parameter(Mandatory)][bool]$ProcessVerified
    )
    $payload = [ordered]@{
        protocol = 'DYSON_CONTROL_TASK_RECEIPT_V1'
        requestId = $normalizedRequestId
        operation = $Operation
        state = $State
        outcome = $Outcome
        processVerified = $ProcessVerified
        writtenAt = (Get-Date).ToUniversalTime().ToString('o')
    } | ConvertTo-Json -Depth 4 -Compress
    $temporaryPath = Join-Path $receiptDirectory.FullName ('.partial-' + $normalizedRequestId + '-' + [guid]::NewGuid().ToString('N'))
    try {
        [System.IO.File]::WriteAllText($temporaryPath, $payload, [System.Text.UTF8Encoding]::new($false))
        if (Test-Path -LiteralPath $receiptPath) {
            $existing = Get-Item -LiteralPath $receiptPath -Force -ErrorAction Stop
            if ($existing.Attributes -band [System.IO.FileAttributes]::ReparsePoint) { throw 'The lifecycle receipt is redirected.' }
            [System.IO.File]::Replace($temporaryPath, $receiptPath, $null)
        }
        else { [System.IO.File]::Move($temporaryPath, $receiptPath) }
    }
    finally { if (Test-Path -LiteralPath $temporaryPath) { Remove-Item -LiteralPath $temporaryPath -Force } }
    return $payload
}

function Complete-IfAlreadyMatched {
    $managed = @(Get-ManagedProcesses)
    if ($managed.Count -gt 1) { throw 'More than one managed DSP process is running.' }
    $port = Get-GamePortState -Managed $managed
    if ($Operation -eq 'graceful-stop' -and $managed.Count -eq 0 -and -not $port.Listening) {
        return Write-Receipt -State 'succeeded' -Outcome 'already-stopped' -ProcessVerified $true
    }
    if ($Operation -in @('start', 'rollback-start') -and $managed.Count -eq 1 -and $port.OwnedByManaged) {
        return Write-Receipt -State 'succeeded' -Outcome 'already-running' -ProcessVerified $true
    }
    if ($Operation -in @('start', 'rollback-start') -and ($managed.Count -ne 0 -or $port.Listening)) {
        throw 'The managed runtime is neither fully stopped nor safely idempotent-running.'
    }
    return $null
}

$task = $null
if ($Operation -eq 'graceful-stop') {
    $already = Complete-IfAlreadyMatched
    if ($already) { $already; exit 0 }
}
$taskMatches = @(Get-ScheduledTask -TaskName $TaskName -ErrorAction Stop)
if ($taskMatches.Count -ne 1) { throw 'The configured lifecycle task is unavailable or ambiguous.' }
$task = $taskMatches[0]
Assert-FixedTaskDefinition -Task $task
if ($Operation -ne 'graceful-stop') {
    $already = Complete-IfAlreadyMatched
    if ($already) { $already; exit 0 }
    if ($task.State.ToString() -ne 'Ready') {
        throw 'The fixed server start task is not ready while the managed runtime is stopped.'
    }
}

Write-Receipt -State 'dispatching' -Outcome 'task-requested' -ProcessVerified $false | Out-Null
try {
    Start-ScheduledTask -InputObject $task -ErrorAction Stop
    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    do {
        Start-Sleep -Milliseconds 500
        $managed = @(Get-ManagedProcesses)
        if ($managed.Count -gt 1) { throw 'More than one managed DSP process is running.' }
        $port = Get-GamePortState -Managed $managed
        if ($Operation -eq 'graceful-stop' -and $managed.Count -eq 0 -and -not $port.Listening) {
            $taskInfo = Get-ScheduledTaskInfo -TaskName $TaskName -ErrorAction Stop
            if ([int64]$taskInfo.LastTaskResult -ne 0) { throw 'The graceful-stop task returned a non-zero result.' }
            Write-Receipt -State 'succeeded' -Outcome 'stopped' -ProcessVerified $true
            exit 0
        }
        if ($Operation -in @('start', 'rollback-start') -and $managed.Count -eq 1 -and $port.OwnedByManaged) {
            Write-Receipt -State 'succeeded' -Outcome 'started' -ProcessVerified $true
            exit 0
        }
    } while ((Get-Date) -lt $deadline)
    throw 'The lifecycle task did not reach its expected runtime state before the timeout.'
}
catch {
    Write-Receipt -State 'failed' -Outcome 'task-failed' -ProcessVerified $false | Out-Null
    throw
}
