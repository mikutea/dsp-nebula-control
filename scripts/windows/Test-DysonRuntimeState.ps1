[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$ProjectRoot,
    [Parameter(Mandatory)][ValidateSet('running', 'stopped')][string]$Expected,
    [ValidateRange(1, 65535)][int]$GamePort = 8469
)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$resolvedProjectRoot = (Resolve-Path -LiteralPath $ProjectRoot -ErrorAction Stop).ProviderPath
$expectedExecutable = [System.IO.Path]::GetFullPath((Join-Path $resolvedProjectRoot 'server\DSPGAME.exe'))
$managed = @()
$unverifiedDspProcessCount = 0
foreach ($candidate in @(Get-Process -Name 'DSPGAME' -ErrorAction SilentlyContinue)) {
    $verifiedManagedProcess = $false
    try {
        if ($candidate.Path -and [System.IO.Path]::GetFullPath($candidate.Path).Equals(
            $expectedExecutable,
            [System.StringComparison]::OrdinalIgnoreCase
        )) {
            $managed += $candidate
            $verifiedManagedProcess = $true
        }
    }
    catch { }
    if (-not $verifiedManagedProcess) { $unverifiedDspProcessCount += 1 }
}
if ($managed.Count -gt 1 -or $unverifiedDspProcessCount -gt 0) {
    throw 'The DSP process set is ambiguous or contains a process outside the fixed managed executable.'
}

try {
    $listeners = @(Get-NetTCPConnection -State Listen -ErrorAction Stop | Where-Object { $_.LocalPort -eq $GamePort })
}
catch { throw 'The game-port listener state could not be verified.' }
$gamePortListening = $listeners.Count -gt 0
$gamePortOwnedByManaged = $false
if ($managed.Count -eq 1 -and $gamePortListening) {
    $ownedListeners = @($listeners | Where-Object { [int]$_.OwningProcess -eq [int]$managed[0].Id })
    $foreignListeners = @($listeners | Where-Object { [int]$_.OwningProcess -ne [int]$managed[0].Id })
    $gamePortOwnedByManaged = $ownedListeners.Count -gt 0 -and $foreignListeners.Count -eq 0
}

if ($Expected -eq 'running') {
    if ($managed.Count -ne 1 -or -not $gamePortOwnedByManaged) {
        throw 'The managed DSP runtime has not reached the running state.'
    }
}
elseif ($managed.Count -ne 0 -or $gamePortListening) {
    throw 'The managed DSP runtime has not reached the stopped state.'
}

[ordered]@{
    protocol = 'DYSON_CONTROL_RUNTIME_V1'
    expected = $Expected
    state = 'matched'
    processVerified = $true
    gamePortListening = [bool]$gamePortListening
} | ConvertTo-Json -Depth 4 -Compress
