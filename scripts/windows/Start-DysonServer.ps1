[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$ProjectRoot,
    [ValidateRange(5, 240)][int]$Ups = 60,
    [ValidateSet('Normal', 'AboveNormal')][string]$ProcessPriority = 'AboveNormal'
)

$ErrorActionPreference = 'Stop'
function Remove-DysonExitedPidRecord {
    param([string]$Path, [int]$ExpectedProcessId)
    try { $recordedPid = [IO.File]::ReadAllText($Path).Trim() }
    catch [IO.FileNotFoundException] { return }
    if ($recordedPid -eq [string]$ExpectedProcessId) {
        # The stop helper may have removed the same record after our read.
        [IO.File]::Delete($Path)
    }
}
$resolvedProjectRoot = (Resolve-Path -LiteralPath $ProjectRoot -ErrorAction Stop).ProviderPath
$serverRoot = Join-Path $resolvedProjectRoot 'server'
$executable = [System.IO.Path]::GetFullPath((Join-Path $serverRoot 'DSPGAME.exe'))
$executableItem = Get-Item -LiteralPath $executable -Force -ErrorAction Stop
if ($executableItem.PSIsContainer -or ($executableItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint)) {
    throw 'The managed DSP executable is unavailable or redirected.'
}

$existing = @()
$unverifiedDspProcessCount = 0
foreach ($candidate in @(Get-Process -Name 'DSPGAME' -ErrorAction SilentlyContinue)) {
    $verifiedManagedProcess = $false
    try {
        if ($candidate.Path -and [System.IO.Path]::GetFullPath($candidate.Path).Equals(
            $executable,
            [System.StringComparison]::OrdinalIgnoreCase
        )) {
            $existing += $candidate
            $verifiedManagedProcess = $true
        }
    }
    catch { }
    if (-not $verifiedManagedProcess) { $unverifiedDspProcessCount += 1 }
}
if ($existing.Count -gt 0) { throw 'The managed DSP process is already running.' }
if ($unverifiedDspProcessCount -gt 0) { throw 'A DSP process is already running outside the fixed managed executable.' }

$currentSession = [System.Diagnostics.Process]::GetCurrentProcess().SessionId
$steam = Get-Process -Name 'steam' -ErrorAction SilentlyContinue |
    Where-Object { $_.SessionId -eq $currentSession } |
    Select-Object -First 1
if (-not $steam) { throw 'Steam Offline is not running in the managed interactive session.' }

$runRoot = Join-Path $resolvedProjectRoot 'run'
$logRoot = Join-Path $resolvedProjectRoot 'logs'
[System.IO.Directory]::CreateDirectory($runRoot) | Out-Null
[System.IO.Directory]::CreateDirectory($logRoot) | Out-Null
$pidPath = Join-Path $runRoot 'dspgame.pid'
$logPath = Join-Path $logRoot 'DSP-headless.log'
$arguments = @(
    '-batchmode', '-nographics', '-nebula-server', '-ups', [string]$Ups,
    '-logFile', $logPath, '-load-latest'
)
$quotedArguments = foreach ($argument in $arguments) {
    if ([string]$argument -match '"') { throw 'A managed DSP argument contains an unsupported quote.' }
    '"{0}"' -f [string]$argument
}

$startInfo = [System.Diagnostics.ProcessStartInfo]::new()
$startInfo.FileName = $executable
$startInfo.Arguments = $quotedArguments -join ' '
$startInfo.WorkingDirectory = $serverRoot
$startInfo.UseShellExecute = $false
$startInfo.CreateNoWindow = $true
$process = [System.Diagnostics.Process]::Start($startInfo)
if (-not $process) { throw 'The managed DSP process did not return a process handle.' }

try {
    try {
        $process.PriorityClass = [System.Diagnostics.ProcessPriorityClass]::$ProcessPriority
        $process.Refresh()
    }
    catch {
        if (-not $process.HasExited) { $process.Kill(); $process.WaitForExit() }
        throw 'The managed DSP process priority could not be applied.'
    }
    [System.IO.File]::WriteAllText($pidPath, [string]$process.Id, [System.Text.Encoding]::ASCII)
    $process.WaitForExit()
    if ($process.ExitCode -ne 0) { throw 'The managed DSP process exited with a non-zero result.' }
}
finally {
    $process.Refresh()
    if ($process.HasExited) {
        Remove-DysonExitedPidRecord -Path $pidPath -ExpectedProcessId $process.Id
    }
}
