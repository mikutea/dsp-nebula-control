[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$ProjectRoot,
    [ValidateRange(10, 300)][int]$TimeoutSeconds = 150
)

# DYSON_CONTROL_RECEIPT_V1: this fixed action is dispatched and reconciled by Invoke-DysonScheduledTask.ps1.
$ErrorActionPreference = 'Stop'
$resolvedProjectRoot = (Resolve-Path -LiteralPath $ProjectRoot -ErrorAction Stop).ProviderPath
$expectedExecutable = [System.IO.Path]::GetFullPath((Join-Path $resolvedProjectRoot 'server\DSPGAME.exe'))
$pidPath = Join-Path $resolvedProjectRoot 'run\dspgame.pid'

if (-not (Test-Path -LiteralPath $pidPath -PathType Leaf)) {
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
$process = Get-Process -Id $processId -ErrorAction SilentlyContinue
if (-not $process) {
    Remove-Item -LiteralPath $pidPath -Force
    exit 0
}
try {
    if (-not $process.Path -or -not [System.IO.Path]::GetFullPath($process.Path).Equals(
        $expectedExecutable,
        [System.StringComparison]::OrdinalIgnoreCase
    )) { throw 'The managed PID does not identify the configured DSP executable.' }
}
catch { throw 'The managed DSP process identity could not be verified.' }

if (-not ('DysonControlConsoleSignal.NativeMethods' -as [type])) {
    Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Threading;

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

        public static int SendCtrlC(uint processId)
        {
            FreeConsole();
            if (!AttachConsole(processId)) return Marshal.GetLastWin32Error();
            try
            {
                SetConsoleCtrlHandler(IntPtr.Zero, true);
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

$signalResult = [DysonControlConsoleSignal.NativeMethods]::SendCtrlC([uint32]$processId)
if ($signalResult -ne 0) { throw 'The managed DSP process did not accept the graceful stop signal.' }
if (-not $process.WaitForExit($TimeoutSeconds * 1000)) {
    throw 'The managed DSP process did not stop before the graceful timeout and was not force-killed.'
}
if (Test-Path -LiteralPath $pidPath -PathType Leaf) {
    $recordedPid = (Get-Content -LiteralPath $pidPath -Raw).Trim()
    if ($recordedPid -eq [string]$processId) { Remove-Item -LiteralPath $pidPath -Force }
}
