[CmdletBinding(DefaultParameterSetName = 'Normal')]
param(
    [Parameter(Mandatory)][string]$ProjectRoot,
    [ValidateRange(10, 300)][int]$TimeoutSeconds = 150,
    [Parameter(Mandatory, ParameterSetName = 'Bound')][guid]$StopRequestId,
    [Parameter(Mandatory, ParameterSetName = 'Bound')][ValidateRange(1,2147483647)][int]$ExpectedProcessId,
    [Parameter(Mandatory, ParameterSetName = 'Bound')][ValidateRange(1,9223372036854775807)][long]$ExpectedProcessStartedAtUnixMs,
    [Parameter(Mandatory, ParameterSetName = 'Bound')][ValidatePattern('^[0-9a-f]{64}$')][string]$ExpectedScriptSha256,
    [Parameter(Mandatory, ParameterSetName = 'Bound')][string]$ReceiptPath
)

# DYSON_CONTROL_RECEIPT_V1: this fixed action is dispatched and reconciled by Invoke-DysonScheduledTask.ps1.
$ErrorActionPreference = 'Stop'
$boundStop = $PSCmdlet.ParameterSetName -ceq 'Bound'
$stopReceiptReady = $false
$stopError = 'DYSON_CONTROL_BOUND_STOP_INPUT_INVALID'
$process = $null
$stopReceipt = [ordered]@{
    protocol = 'DYSON_CONTROL_BOUND_STOP_RECEIPT_V1'; schemaVersion = 1
    requestId = if ($boundStop) { $StopRequestId.ToString('D').ToLowerInvariant() } else { $null }
    expectedProcessId = $ExpectedProcessId; expectedProcessStartedAtUnixMs = $ExpectedProcessStartedAtUnixMs
    scriptSha256 = $ExpectedScriptSha256; status = 'running'; errorCode = 'NONE'
    signalSent = $false; processExited = $false; processExitCode = $null; forcedKill = $false
    completedAtUtc = $null
}
function Write-DysonBoundStopReceipt {
    $temporary = $ReceiptPath + '.partial-' + [guid]::NewGuid().ToString('N')
    $backup = $ReceiptPath + '.superseded-' + [guid]::NewGuid().ToString('N')
    try {
        $bytes = [Text.UTF8Encoding]::new($false).GetBytes(($stopReceipt | ConvertTo-Json -Compress) + "`n")
        $stream = [IO.FileStream]::new($temporary, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
        try { $stream.Write($bytes, 0, $bytes.Length); $stream.Flush($true) } finally { $stream.Dispose() }
        if ([IO.File]::Exists($ReceiptPath)) { [IO.File]::Replace($temporary, $ReceiptPath, $backup) }
        else { [IO.File]::Move($temporary, $ReceiptPath) }
    }
    finally {
        if ([IO.File]::Exists($temporary)) { [IO.File]::Delete($temporary) }
        if ([IO.File]::Exists($backup)) { [IO.File]::Delete($backup) }
    }
}
function Remove-DysonExitedPidRecord {
    param([string]$Path, [int]$ExpectedProcessId)
    try { $recordedPid = [IO.File]::ReadAllText($Path).Trim() }
    catch [IO.FileNotFoundException] { return }
    if ($recordedPid -eq [string]$ExpectedProcessId) {
        # File.Delete is idempotent when the start wrapper already removed it.
        # Other IO/permission failures remain visible to the caller.
        [IO.File]::Delete($Path)
    }
}
try {
if ($boundStop) {
    if (-not [IO.Path]::IsPathRooted($ReceiptPath) -or (Test-Path -LiteralPath $ReceiptPath)) { throw 'Bound stop receipt must be new.' }
    $parent = Get-Item -LiteralPath ([IO.Path]::GetDirectoryName($ReceiptPath)) -Force
    if (-not $parent.PSIsContainer -or ($parent.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'Invalid receipt parent.' }
    $hash = [Security.Cryptography.SHA256]::Create()
    try { $actual = ([BitConverter]::ToString($hash.ComputeHash([IO.File]::ReadAllBytes($PSCommandPath)))).Replace('-', '').ToLowerInvariant() }
    finally { $hash.Dispose() }
    if ($actual -cne $ExpectedScriptSha256) { throw 'Bound stop script changed.' }
    Write-DysonBoundStopReceipt
    $stopReceiptReady = $true
}
$resolvedProjectRoot = (Resolve-Path -LiteralPath $ProjectRoot -ErrorAction Stop).ProviderPath
$expectedExecutable = [System.IO.Path]::GetFullPath((Join-Path $resolvedProjectRoot 'server\DSPGAME.exe'))
$pidPath = Join-Path $resolvedProjectRoot 'run\dspgame.pid'

if (-not (Test-Path -LiteralPath $pidPath -PathType Leaf)) {
    if ($boundStop) { $stopError = 'DYSON_CONTROL_BOUND_STOP_PID_MISMATCH'; throw 'Bound PID record unavailable.' }
    $managedWithoutPid = @()
    foreach ($candidate in @(Get-Process -Name 'DSPGAME' -ErrorAction SilentlyContinue)) {
        try {
            if ($candidate.Path -and [System.IO.Path]::GetFullPath($candidate.Path).Equals(
                $expectedExecutable,
                [System.StringComparison]::OrdinalIgnoreCase
            )) { $managedWithoutPid += $candidate }
        }
        catch { }
    }
    if ($managedWithoutPid.Count -gt 0) { throw 'The managed DSP process is running without its PID record.' }
    exit 0
}

$pidText = (Get-Content -LiteralPath $pidPath -Raw).Trim()
$processId = 0
if (-not [int]::TryParse($pidText, [ref]$processId) -or $processId -le 0) { throw 'The managed PID record is invalid.' }
if ($boundStop -and $processId -ne $ExpectedProcessId) { $stopError = 'DYSON_CONTROL_BOUND_STOP_PID_MISMATCH'; throw 'Bound PID mismatch.' }
$process = Get-Process -Id $processId -ErrorAction SilentlyContinue
if (-not $process) {
    if ($boundStop) { $stopError = 'DYSON_CONTROL_BOUND_STOP_PROCESS_MISSING'; throw 'Bound process unavailable.' }
    Remove-DysonExitedPidRecord -Path $pidPath -ExpectedProcessId $processId
    exit 0
}
try {
    # Get-Process does not retain a process handle automatically. Hold the
    # verified generation through signaling/waiting even if it exits quickly.
    [void]$process.Handle
    if ($boundStop -and [DateTimeOffset]::new($process.StartTime.ToUniversalTime()).ToUnixTimeMilliseconds() -ne $ExpectedProcessStartedAtUnixMs) {
        $stopError = 'DYSON_CONTROL_BOUND_STOP_GENERATION_MISMATCH'; throw 'Bound generation mismatch.'
    }
    if (-not $boundStop -and (-not $process.Path -or -not [System.IO.Path]::GetFullPath($process.Path).Equals(
        $expectedExecutable,
        [System.StringComparison]::OrdinalIgnoreCase
    ))) { throw 'The managed PID does not identify the configured DSP executable.' }
}
catch { throw 'The managed DSP process identity could not be verified.' }

if (-not ('DysonControlConsoleSignal.NativeMethods' -as [type])) {
    Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Threading;
using System.Text;
using Microsoft.Win32.SafeHandles;

namespace DysonControlConsoleSignal
{
    public static class NativeMethods
    {
        private const uint CtrlCEvent = 0;

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool FreeConsole();

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool AttachConsole(uint processId);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool GenerateConsoleCtrlEvent(uint controlEvent, uint processGroupId);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool SetConsoleCtrlHandler(IntPtr handlerRoutine, bool add);
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        private static extern uint GetFinalPathNameByHandle(SafeFileHandle handle, StringBuilder buffer, uint length, uint flags);
        public static string FinalPath(SafeFileHandle handle) {
            var buffer = new StringBuilder(32768);
            var count = GetFinalPathNameByHandle(handle, buffer, (uint)buffer.Capacity, 0);
            if (count == 0 || count >= buffer.Capacity) throw new InvalidOperationException("Final path unavailable.");
            return buffer.ToString();
        }

        public static int SendCtrlC(uint processId)
        {
            FreeConsole();
            if (!AttachConsole(processId)) return Marshal.GetLastWin32Error();
            try
            {
                if (!SetConsoleCtrlHandler(IntPtr.Zero, true)) return Marshal.GetLastWin32Error();
                if (!GenerateConsoleCtrlEvent(CtrlCEvent, 0)) return Marshal.GetLastWin32Error();
                Thread.Sleep(250);
                return 0;
            }
            finally
            {
                FreeConsole();
                SetConsoleCtrlHandler(IntPtr.Zero, false);
            }
        }
    }
}
'@
}

if ($boundStop) {
    $stopError = 'DYSON_CONTROL_BOUND_STOP_IDENTITY_MISMATCH'
    if ($process.ProcessName -cne 'DSPGAME' -or -not $process.Path) { throw 'Bound executable mismatch.' }
    $left = $null; $right = $null
    try {
        $share = [IO.FileShare]::ReadWrite -bor [IO.FileShare]::Delete
        $left = [IO.File]::Open($process.Path, [IO.FileMode]::Open, [IO.FileAccess]::Read, $share)
        $right = [IO.File]::Open($expectedExecutable, [IO.FileMode]::Open, [IO.FileAccess]::Read, $share)
        if (-not [string]::Equals([DysonControlConsoleSignal.NativeMethods]::FinalPath($left.SafeFileHandle),
            [DysonControlConsoleSignal.NativeMethods]::FinalPath($right.SafeFileHandle), [StringComparison]::OrdinalIgnoreCase)) { throw 'Bound executable mismatch.' }
    }
    finally { if ($right) { $right.Dispose() }; if ($left) { $left.Dispose() } }
}
$stopError = 'DYSON_CONTROL_BOUND_STOP_SIGNAL_FAILED'
$signalResult = [DysonControlConsoleSignal.NativeMethods]::SendCtrlC([uint32]$processId)
if ($signalResult -ne 0) { throw 'The managed DSP process did not accept the graceful stop signal.' }
$stopReceipt.signalSent = $true
if ($boundStop) { Write-DysonBoundStopReceipt }
$stopError = 'DYSON_CONTROL_BOUND_STOP_TIMEOUT'
if (-not $process.WaitForExit($TimeoutSeconds * 1000)) {
    throw 'The managed DSP process did not stop before the graceful timeout and was not force-killed.'
}
$stopReceipt.processExited = $true
$stopReceipt.processExitCode = $process.ExitCode
$stopError = 'DYSON_CONTROL_BOUND_STOP_PID_CLEANUP_FAILED'
Remove-DysonExitedPidRecord -Path $pidPath -ExpectedProcessId $processId
if ($boundStop) {
    $stopReceipt.status = 'succeeded'
    $stopReceipt.completedAtUtc = [DateTimeOffset]::UtcNow.ToString('o')
    Write-DysonBoundStopReceipt
}
}
catch {
    if (-not $boundStop) { throw }
    $stopReceipt.status = 'failed'; $stopReceipt.errorCode = $stopError
    $stopReceipt.completedAtUtc = [DateTimeOffset]::UtcNow.ToString('o')
    if ($stopReceiptReady) { try { Write-DysonBoundStopReceipt } catch { } }
    exit 1
}
finally { if ($null -ne $process) { $process.Dispose() } }
if ($boundStop) { exit 0 }
