[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
. (Join-Path $PSScriptRoot 'DysonGameLifecycleBootstrap.Common.ps1')

$temporaryBase = [System.IO.Path]::GetFullPath([System.IO.Path]::GetTempPath()).TrimEnd('\', '/')
$testRoot = Join-Path $temporaryBase ('dyson-game-bootstrap-selftest-' + [guid]::NewGuid().ToString('N'))
$installRoot = Join-Path $testRoot 'install'
$bootstrapRoot = Join-Path $installRoot 'bootstrap'
$releasesRoot = Join-Path $installRoot 'releases'
$dataRoot = Join-Path $testRoot 'custom-deployment-data'
$poisonProgramData = Join-Path $testRoot 'unused-program-data'
$stateRoot = Join-Path $dataRoot 'state'
$layoutPath = Join-Path $bootstrapRoot 'bootstrap-layout.json'
$pointerPath = Join-Path $stateRoot 'active-release.json'
$bindingPath = Join-Path $stateRoot 'game-lifecycle-binding.json'
$expectedExitPath = Join-Path $stateRoot 'game-lifecycle-expected-exit.json'
$expectedExitPendingPath = Join-Path $stateRoot '.game-lifecycle-expected-exit.pending.json'
$expectedExitRecoveryPath = Join-Path $stateRoot '.game-lifecycle-expected-exit.recovery.json'
$expectedExitDiscardPath = Join-Path $stateRoot '.game-lifecycle-expected-exit.rollback-discard.json'
$expectedExitLegacyBackupPath = Join-Path $stateRoot '.backup-expected-exit-legacy.json'
$runtimeReceiptRoot = Join-Path $stateRoot 'game-runtime-receipts'
$projectRoot = Join-Path $testRoot 'fictional-project'
$serverRoot = Join-Path $projectRoot 'server'
$runRoot = Join-Path $projectRoot 'run'
$gameExecutable = Join-Path $serverRoot 'DSPGAME.exe'
$managedSignal = Join-Path $runRoot 'fixture-managed-stop.signal'
$foreignSignal = Join-Path $runRoot 'fixture-foreign-stop.signal'
$startDelaySignal = Join-Path $runRoot 'fixture-start-delay.signal'
$stopFailureSignal = Join-Path $runRoot 'fixture-stop-failure.signal'
$managedPidPath = Join-Path $runRoot 'dspgame.pid'
$eventsPath = Join-Path $runRoot 'fixture-events.log'
$outsideRelease = Join-Path $testRoot 'outside-release'
$redirectedRelease = Join-Path $releasesRoot '9.9.9'
$redirectCreated = $false
$outsideLayoutTarget = Join-Path $testRoot 'outside-layout-target'
$layoutRedirectCreated = $false
$children = [System.Collections.Generic.List[object]]::new()
$foreignProcess = $null
$bootstrapFailureSecurity = @{}

function Assert-BootstrapSelfTest {
    param([bool]$Condition, [string]$Message)
    if (-not $Condition) { throw "Game lifecycle bootstrap self-test failed: $Message" }
}

function Assert-BootstrapPidCleanupContract {
    $probePath = Join-Path $testRoot 'pid-cleanup-probe.pid'
    foreach ($name in @('Start-DysonServer.ps1', 'Stop-DysonServer.ps1')) {
        $source = [IO.File]::ReadAllText((Join-Path (Split-Path $PSScriptRoot -Parent) $name))
        $tokens = $null; $errors = $null
        $ast = [Management.Automation.Language.Parser]::ParseInput($source, [ref]$tokens, [ref]$errors)
        $definitions = @($ast.FindAll({ param($node)
            $node -is [Management.Automation.Language.FunctionDefinitionAst] -and
            $node.Name -ceq 'Remove-DysonExitedPidRecord'
        }, $false))
        Assert-BootstrapSelfTest ($errors.Count -eq 0 -and $definitions.Count -eq 1) 'PID cleanup helper could not be extracted'
        & {
            . ([scriptblock]::Create($definitions[0].Extent.Text))
            [IO.File]::WriteAllText($probePath, '4242')
            Remove-DysonExitedPidRecord -Path $probePath -ExpectedProcessId 4242
            Assert-BootstrapSelfTest (-not [IO.File]::Exists($probePath)) 'matching exited PID record was not removed'
            Remove-DysonExitedPidRecord -Path $probePath -ExpectedProcessId 4242
            [IO.File]::WriteAllText($probePath, '4343')
            Remove-DysonExitedPidRecord -Path $probePath -ExpectedProcessId 4242
            Assert-BootstrapSelfTest ([IO.File]::ReadAllText($probePath) -ceq '4343') 'a different PID record was removed'
            $locked = [IO.File]::Open($probePath, [IO.FileMode]::Open, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)
            try {
                $rejected = $false
                try { Remove-DysonExitedPidRecord -Path $probePath -ExpectedProcessId 4343 }
                catch { $rejected = $true }
                Assert-BootstrapSelfTest $rejected 'a non-absence IO error was hidden during PID cleanup'
            }
            finally { $locked.Dispose() }
            $rejected = $false
            try { Remove-DysonExitedPidRecord -Path $testRoot -ExpectedProcessId 4242 }
            catch { $rejected = $true }
            Assert-BootstrapSelfTest $rejected 'a directory/permission error was treated as an absent PID file'
            [IO.File]::Delete($probePath)
        }
    }
}

function Write-BootstrapSelfTestText {
    param([string]$Path, [string]$Value)
    [System.IO.Directory]::CreateDirectory([System.IO.Path]::GetDirectoryName($Path)) | Out-Null
    [System.IO.File]::WriteAllText($Path, $Value, [System.Text.UTF8Encoding]::new($false))
}

function ConvertTo-BootstrapSelfTestNativeArgument {
    param([string]$Value)
    if ($Value.IndexOf([char]0) -ge 0 -or $Value -match '["\r\n]') {
        throw 'The self-test attempted to pass an invalid native argument.'
    }
    return '"{0}"' -f $Value
}

function Start-BootstrapSelfTestChild {
    param(
        [Parameter(Mandatory)][string]$ScriptPath,
        [string[]]$Arguments = @()
    )

    $powerShellPath = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
    $allArguments = @(
        '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', $ScriptPath
    ) + $Arguments
    $startInfo = [System.Diagnostics.ProcessStartInfo]::new()
    $startInfo.FileName = $powerShellPath
    $startInfo.Arguments = [string]::Join(' ', @(
        $allArguments | ForEach-Object { ConvertTo-BootstrapSelfTestNativeArgument -Value ([string]$_) }
    ))
    $startInfo.WorkingDirectory = $projectRoot
    $startInfo.UseShellExecute = $false
    $startInfo.CreateNoWindow = $true
    $startInfo.RedirectStandardOutput = $true
    $startInfo.RedirectStandardError = $true
    $startInfo.EnvironmentVariables['ProgramData'] = $poisonProgramData
    $process = [System.Diagnostics.Process]::new()
    $process.StartInfo = $startInfo
    if (-not $process.Start()) { throw 'A bootstrap self-test child did not start.' }
    $child = [pscustomobject][ordered]@{
        process = $process
        stdoutTask = $process.StandardOutput.ReadToEndAsync()
        stderrTask = $process.StandardError.ReadToEndAsync()
    }
    $children.Add($child)
    return $child
}

function Complete-BootstrapSelfTestChild {
    param(
        [Parameter(Mandatory)]$Child,
        [ValidateRange(1, 60)][int]$TimeoutSeconds = 20
    )

    if (-not $Child.process.WaitForExit($TimeoutSeconds * 1000)) {
        try { $Child.process.Kill() } catch { }
        throw 'A bootstrap self-test child exceeded its deadline.'
    }
    $Child.process.WaitForExit()
    return [pscustomobject][ordered]@{
        exitCode = [int]$Child.process.ExitCode
        stdout = [string]$Child.stdoutTask.GetAwaiter().GetResult()
        stderr = [string]$Child.stderrTask.GetAwaiter().GetResult()
    }
}

function Stop-BootstrapSelfTestChildAbruptly {
    param(
        [Parameter(Mandatory)]$Child,
        [Parameter(Mandatory)][string]$Stage
    )

    $Child.process.Refresh()
    if ($Child.process.HasExited) {
        $earlyBinding = $null
        $earlyIntent = $null
        $earlyLease = Enter-DysonGameBootstrapLock `
            -Path $expectedExitContext.stateLockPath -TimeoutSeconds 10
        try {
            $earlyBinding = Read-DysonGameBootstrapBinding -Context $expectedExitContext
            $earlyIntent = Read-DysonGameBootstrapExpectedExit `
                -Context $expectedExitContext -AllowMissing
        }
        finally { $earlyLease.Dispose() }
        $earlyReceipts = @()
        if ($earlyBinding -and [System.IO.Directory]::Exists($runtimeReceiptRoot)) {
            foreach ($item in [System.IO.Directory]::EnumerateFiles($runtimeReceiptRoot, '*.json')) {
                try {
                    $earlyAttemptId = [System.IO.Path]::GetFileNameWithoutExtension($item)
                    $earlyReceipt = Get-BootstrapSelfTestRuntimeReceipt -AttemptId $earlyAttemptId
                    if ([string]$earlyReceipt.value.bindingId -ceq [string]$earlyBinding.bindingId) {
                        $earlyReceipts += $earlyReceipt.value
                    }
                }
                catch { }
            }
        }
        $earlyDiagnostic = [ordered]@{
            stage = $Stage
            exitCode = [int]$Child.process.ExitCode
            binding = $earlyBinding
            intent = if ($earlyIntent) { $earlyIntent.value } else { $null }
            pidExists = [System.IO.File]::Exists($managedPidPath)
            receipts = $earlyReceipts
        }
        throw ('Game lifecycle bootstrap self-test failed: the ' + $Stage +
            ' wrapper exited before abrupt termination [' +
            ($earlyDiagnostic | Microsoft.PowerShell.Utility\ConvertTo-Json -Depth 8 -Compress) + ']')
    }

    $processId = [int]$Child.process.Id
    $killError = $null
    try { $Child.process.Kill() }
    catch { $killError = $_.Exception }

    if ($killError) {
        $Child.process.Refresh()
        if (-not $Child.process.HasExited) {
            try {
                # Open a fresh process handle if the cached Process handle was
                # concurrently invalidated while the wrapper was being killed.
                Microsoft.PowerShell.Management\Stop-Process `
                    -Id $processId -Force -ErrorAction Stop
            }
            catch {
                throw ('Game lifecycle bootstrap self-test failed: the ' + $Stage +
                    ' wrapper could not be terminated; pid=' + [string]$processId +
                    ';killError=' + [string]$killError.GetType().FullName +
                    ';fallbackError=' + [string]$_.Exception.GetType().FullName +
                    ';binding=' + [string][System.IO.File]::Exists($bindingPath) +
                    ';expected=' + [string][System.IO.File]::Exists($expectedExitPath) +
                    ';managedPid=' + [string][System.IO.File]::Exists($managedPidPath))
            }
        }
    }

    if (-not $Child.process.WaitForExit(5000)) {
        throw ('Game lifecycle bootstrap self-test failed: the ' + $Stage +
            ' wrapper did not acknowledge abrupt termination; pid=' +
            [string]$processId + ';binding=' +
            [string][System.IO.File]::Exists($bindingPath) + ';expected=' +
            [string][System.IO.File]::Exists($expectedExitPath) + ';managedPid=' +
            [string][System.IO.File]::Exists($managedPidPath))
    }
    $Child.process.WaitForExit()
}

function Get-BootstrapSelfTestJson {
    param([Parameter(Mandatory)]$Result)

    $lines = @($Result.stdout -split "`r?`n" | Where-Object { -not [string]::IsNullOrWhiteSpace($_) })
    if ($lines.Count -ne 1) { throw 'A bootstrap command did not return exactly one JSON line.' }
    try { return $lines[0] | Microsoft.PowerShell.Utility\ConvertFrom-Json -ErrorAction Stop }
    catch { throw 'A bootstrap command returned malformed JSON.' }
}

function Get-BootstrapSelfTestPropertyValue {
    param(
        $Value,
        [Parameter(Mandatory)][string]$Name
    )

    if ($null -eq $Value) { return $null }
    $property = $Value.PSObject.Properties[$Name]
    if ($null -eq $property) { return $null }
    return $property.Value
}

function Assert-BootstrapSelfTestNoPathLeak {
    param([Parameter(Mandatory)]$Result, [string]$Message)

    $combined = [string]$Result.stdout + [string]$Result.stderr
    Assert-BootstrapSelfTest -Condition (
        -not $combined.Contains($testRoot) -and
        -not $combined.Contains($projectRoot) -and
        -not $combined.Contains($dataRoot) -and
        -not $combined.Contains($poisonProgramData)
    ) -Message $Message
}

function Invoke-BootstrapSelfTestCommand {
    param(
        [Parameter(Mandatory)][string]$ScriptPath,
        [string[]]$Arguments = @(),
        [ValidateRange(1, 60)][int]$TimeoutSeconds = 20
    )

    $child = Start-BootstrapSelfTestChild -ScriptPath $ScriptPath -Arguments $Arguments
    return Complete-BootstrapSelfTestChild -Child $child -TimeoutSeconds $TimeoutSeconds
}

function Wait-BootstrapSelfTestCondition {
    param(
        [Parameter(Mandatory)][scriptblock]$Condition,
        [Parameter(Mandatory)][string]$Message,
        [ValidateRange(1, 30)][int]$TimeoutSeconds = 10
    )

    $deadline = [System.DateTimeOffset]::UtcNow.AddSeconds($TimeoutSeconds)
    do {
        try { if (& $Condition) { return } } catch { }
        [System.Threading.Thread]::Sleep(50)
    } while ([System.DateTimeOffset]::UtcNow -lt $deadline)
    throw "Game lifecycle bootstrap self-test failed: $Message"
}

function Test-BootstrapSelfTestBindingVersion {
    param([string]$Version)

    if (-not [System.IO.File]::Exists($bindingPath)) { return $false }
    try {
        $binding = [System.IO.File]::ReadAllText($bindingPath, [System.Text.UTF8Encoding]::new($false, $true)) |
            Microsoft.PowerShell.Utility\ConvertFrom-Json -ErrorAction Stop
        return [string]$binding.version -ceq $Version
    }
    catch { return $false }
}

function Test-BootstrapSelfTestBindingHasTerminalReceipt {
    param([Parameter(Mandatory)][string]$BindingId)

    if (-not [System.IO.Directory]::Exists($runtimeReceiptRoot)) { return $false }
    foreach ($item in [System.IO.Directory]::EnumerateFiles($runtimeReceiptRoot, '*.json')) {
        $attemptId = [System.IO.Path]::GetFileNameWithoutExtension($item)
        if ($attemptId -notmatch '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$') {
            return $true
        }
        try {
            $receipt = Get-BootstrapSelfTestRuntimeReceipt -AttemptId $attemptId
            if ([string]$receipt.value.bindingId -ceq $BindingId) { return $true }
        }
        catch { return $true }
    }
    return $false
}

function Open-BootstrapSelfTestBindingObserver {
    param([Parameter(Mandatory)][string]$Path)

    # Publication polling must not prevent the wrapper from retiring its old
    # binding. ReadAllText uses FileShare.Read and races that deletion.
    $stream = [IO.FileStream]::new($Path, [IO.FileMode]::Open, [IO.FileAccess]::Read,
        [IO.FileShare]::ReadWrite -bor [IO.FileShare]::Delete)
    try { return [IO.StreamReader]::new($stream, [Text.UTF8Encoding]::new($false, $true)) }
    catch { $stream.Dispose(); throw }
}

function Test-BootstrapSelfTestPublishedLifecycle {
    param(
        [Parameter(Mandatory)][string]$Version,
        [Parameter(Mandatory)][int]$MinimumStartEvents
    )

    $publishedBinding = $null
    try {
        if ([System.IO.File]::Exists($bindingPath)) {
            $bindingObserver = Open-BootstrapSelfTestBindingObserver -Path $bindingPath
            try {
                $publishedBinding = $bindingObserver.ReadToEnd() |
                    Microsoft.PowerShell.Utility\ConvertFrom-Json -ErrorAction Stop
            }
            finally { $bindingObserver.Dispose() }
        }
    }
    catch { return $false }
    if ($null -eq $publishedBinding -or
        [string]$publishedBinding.version -cne $Version -or
        [string]$publishedBinding.bindingId -notmatch `
            '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' -or
        (Test-BootstrapSelfTestBindingHasTerminalReceipt `
            -BindingId ([string]$publishedBinding.bindingId)) -or
        [System.IO.File]::Exists($expectedExitPath) -or
        -not [System.IO.File]::Exists($managedPidPath) -or
        @(
            Get-BootstrapSelfTestEventLines |
                Where-Object { $_ -match ('^' + [regex]::Escape($Version) + '\|start\|') }
        ).Count -lt $MinimumStartEvents) {
        return $false
    }
    try {
        $rawPid = [System.IO.File]::ReadAllText($managedPidPath, [System.Text.Encoding]::ASCII).Trim()
        $managedPid = 0
        if ($rawPid -notmatch '^[1-9][0-9]{0,9}$' -or
            -not [int]::TryParse($rawPid, [ref]$managedPid) -or $managedPid -le 0) {
            return $false
        }
        $managed = $null
        try {
            $managed = [System.Diagnostics.Process]::GetProcessById($managedPid)
            $managed.Refresh()
            return -not $managed.HasExited -and [string]::Equals(
                [System.IO.Path]::GetFullPath($managed.MainModule.FileName),
                [System.IO.Path]::GetFullPath($gameExecutable),
                [System.StringComparison]::OrdinalIgnoreCase
            )
        }
        finally { if ($managed) { $managed.Dispose() } }
    }
    catch { return $false }
}

function Get-BootstrapSelfTestPublicationDiagnostic {
    param(
        [Parameter(Mandatory)]$Child,
        [Parameter(Mandatory)]$Context,
        [Parameter(Mandatory)][string]$Version,
        [Parameter(Mandatory)][int]$MinimumStartEvents
    )

    $bindingState = 'missing'
    $bindingId = $null
    $bindingVersion = $null
    try {
        $binding = Read-DysonGameBootstrapBinding -Context $Context
        if ($null -ne $binding) {
            $bindingState = 'valid'
            $bindingId = [string]$binding.bindingId
            $bindingVersion = [string]$binding.version
        }
    }
    catch { $bindingState = 'invalid' }

    $expectedExitState = 'missing'
    $expectedExitBindingMatches = $null
    try {
        $expectedExit = Read-DysonGameBootstrapExpectedExit -Context $Context -AllowMissing
        if ($null -ne $expectedExit) {
            $expectedExitState = [string]$expectedExit.value.state
            $expectedExitBindingMatches = -not [string]::IsNullOrEmpty($bindingId) -and
                [string]$expectedExit.value.bindingId -ceq $bindingId
        }
    }
    catch { $expectedExitState = 'invalid' }

    $pidState = 'missing'
    $managedPid = $null
    if ([System.IO.File]::Exists($managedPidPath)) {
        try {
            $rawPid = [System.IO.File]::ReadAllText(
                $managedPidPath,
                [System.Text.Encoding]::ASCII
            ).Trim()
            $parsedPid = 0
            if ($rawPid -notmatch '^[1-9][0-9]{0,9}$' -or
                -not [int]::TryParse($rawPid, [ref]$parsedPid) -or $parsedPid -le 0) {
                $pidState = 'invalid'
            }
            else {
                $managedPid = $parsedPid
                $managedProcess = $null
                try {
                    $managedProcess = [System.Diagnostics.Process]::GetProcessById($parsedPid)
                    $managedProcess.Refresh()
                    if ($managedProcess.HasExited) { $pidState = 'exited' }
                    elseif ([string]::Equals(
                        [System.IO.Path]::GetFullPath($managedProcess.MainModule.FileName),
                        [System.IO.Path]::GetFullPath($gameExecutable),
                        [System.StringComparison]::OrdinalIgnoreCase
                    )) { $pidState = 'live-expected-image' }
                    else { $pidState = 'live-foreign-image' }
                }
                catch [System.ArgumentException] { $pidState = 'exited' }
                catch { $pidState = 'identity-unavailable' }
                finally { if ($managedProcess) { $managedProcess.Dispose() } }
            }
        }
        catch { $pidState = 'unreadable' }
    }

    $receiptCount = 0
    $matchingReceiptCount = 0
    $receiptReadErrorCount = 0
    if ([System.IO.Directory]::Exists($runtimeReceiptRoot)) {
        foreach ($receiptPath in [System.IO.Directory]::EnumerateFiles($runtimeReceiptRoot, '*.json')) {
            $receiptCount++
            try {
                $receiptAttemptId = [System.IO.Path]::GetFileNameWithoutExtension($receiptPath)
                $receipt = Get-BootstrapSelfTestRuntimeReceipt -AttemptId $receiptAttemptId
                if (-not [string]::IsNullOrEmpty($bindingId) -and
                    [string]$receipt.value.bindingId -ceq $bindingId) {
                    $matchingReceiptCount++
                }
            }
            catch { $receiptReadErrorCount++ }
        }
    }

    $eventLines = @(Get-BootstrapSelfTestEventLines)
    $startEventCount = @($eventLines | Where-Object {
        $_ -match ('^' + [regex]::Escape($Version) + '\|start\|')
    }).Count
    $stateLockAvailable = $false
    $diagnosticLease = $null
    try {
        $diagnosticLease = Enter-DysonGameBootstrapLock `
            -Path $Context.stateLockPath -TimeoutSeconds 1
        $stateLockAvailable = $true
    }
    catch {
        if ([string]$_.Exception.Message -cne 'BOOTSTRAP_LOCK_BUSY') { throw }
    }
    finally { if ($diagnosticLease) { $diagnosticLease.Dispose() } }

    $Child.process.Refresh()
    return [ordered]@{
        wrapperExited = [bool]$Child.process.HasExited
        bindingState = $bindingState
        bindingVersion = $bindingVersion
        bindingId = $bindingId
        expectedExitState = $expectedExitState
        expectedExitBindingMatches = $expectedExitBindingMatches
        pidState = $pidState
        managedPid = $managedPid
        startEventCount = $startEventCount
        minimumStartEvents = $MinimumStartEvents
        totalEventCount = $eventLines.Count
        receiptCount = $receiptCount
        matchingReceiptCount = $matchingReceiptCount
        receiptReadErrorCount = $receiptReadErrorCount
        stateLockAvailable = $stateLockAvailable
    }
}

function Wait-BootstrapSelfTestPublishedLifecycle {
    param(
        [Parameter(Mandatory)]$Child,
        [Parameter(Mandatory)]$Context,
        [Parameter(Mandatory)][string]$Version,
        [Parameter(Mandatory)][int]$MinimumStartEvents,
        [Parameter(Mandatory)][string]$Message,
        [ValidateRange(1, 30)][int]$TimeoutSeconds = 20
    )

    $deadline = [System.DateTimeOffset]::UtcNow.AddSeconds($TimeoutSeconds)
    do {
        $Child.process.Refresh()
        if ($Child.process.HasExited) {
            throw ('Game lifecycle bootstrap self-test failed: ' + $Message +
                '; stable wrapper exited before acknowledged publication; exit=' +
                [string]$Child.process.ExitCode)
        }
        if (Test-BootstrapSelfTestPublishedLifecycle `
            -Version $Version -MinimumStartEvents $MinimumStartEvents) {
            $publicationLease = $null
            try {
                $publicationLease = Enter-DysonGameBootstrapLock `
                    -Path $Context.stateLockPath -TimeoutSeconds 1
            }
            catch {
                if ([string]$_.Exception.Message -cne 'BOOTSTRAP_LOCK_BUSY') { throw }
            }
            if ($publicationLease) {
                try {
                    # The stable wrapper owns this lock until it has independently
                    # validated the managed PID and recorded its publication time.
                    # Rechecking all state while owning the same lock is the
                    # acknowledgement; a raw PID file alone is not sufficient.
                    if (Test-BootstrapSelfTestPublishedLifecycle `
                        -Version $Version -MinimumStartEvents $MinimumStartEvents) {
                        return
                    }
                }
                finally { $publicationLease.Dispose() }
            }
        }
        [System.Threading.Thread]::Sleep(25)
    } while ([System.DateTimeOffset]::UtcNow -lt $deadline)
    $diagnostic = Get-BootstrapSelfTestPublicationDiagnostic `
        -Child $Child -Context $Context -Version $Version `
        -MinimumStartEvents $MinimumStartEvents
    throw ('Game lifecycle bootstrap self-test failed: ' + $Message + '; diagnostic=' +
        ($diagnostic | Microsoft.PowerShell.Utility\ConvertTo-Json -Depth 5 -Compress))
}

function Get-BootstrapSelfTestEventLines {
    if (-not [System.IO.File]::Exists($eventsPath)) { return @() }
    $stream = $null
    $reader = $null
    try {
        # The release fixture appends lifecycle events while the stable wrapper
        # is being observed. ReadAllLines opens with FileShare.Read, which is
        # incompatible with that already-open write handle on Windows and made
        # the publication probe timing-dependent.
        $stream = [System.IO.FileStream]::new(
            $eventsPath,
            [System.IO.FileMode]::Open,
            [System.IO.FileAccess]::Read,
            [System.IO.FileShare]::ReadWrite -bor [System.IO.FileShare]::Delete
        )
        $reader = [System.IO.StreamReader]::new(
            $stream,
            [System.Text.UTF8Encoding]::new($false, $true),
            $true,
            1024,
            $true
        )
        $text = $reader.ReadToEnd()
        if ([string]::IsNullOrEmpty($text)) { return @() }
        return @($text -split "`r?`n" | Where-Object { -not [string]::IsNullOrEmpty($_) })
    }
    finally {
        if ($reader) { $reader.Dispose() }
        if ($stream) { $stream.Dispose() }
    }
}

function Get-BootstrapSelfTestRuntimeReceipt {
    param([Parameter(Mandatory)][string]$AttemptId)

    $parsed = [guid]::Empty
    if (-not [guid]::TryParseExact($AttemptId, 'D', [ref]$parsed) -or
        $parsed.ToString('D').ToLowerInvariant() -cne $AttemptId) {
        throw 'Game lifecycle bootstrap self-test received a non-canonical attempt id.'
    }
    $path = Join-Path $runtimeReceiptRoot ($AttemptId + '.json')
    $record = Read-DysonGameBootstrapJsonFile -Path $path -MaximumBytes 8192
    $value = $record.value
    Assert-DysonGameBootstrapExactProperties -Value $value -Names @(
        'protocol', 'schemaVersion', 'attemptId', 'bindingId', 'version', 'outcome', 'errorCode',
        'restartExpected', 'startedAt', 'publishedAt', 'completedAt', 'projectRootSha256', 'dataRootIdentity'
    )
    return [pscustomobject][ordered]@{ value = $value; sha256 = [string]$record.sha256; path = $path }
}

function Write-BootstrapSelfTestExpectedExitArtifact {
    param(
        [Parameter(Mandatory)][string]$Path,
        [Parameter(Mandatory)]$Value,
        [string]$AclSddl
    )

    $bytes = ConvertTo-DysonGameBootstrapExpectedExitBytes -Value $Value
    [System.IO.File]::WriteAllBytes($Path, $bytes)
    if (-not [string]::IsNullOrEmpty($AclSddl)) {
        Set-DysonGameBootstrapExpectedExitSecurity -Path $Path -AclSddl $AclSddl
    }
}

function New-BootstrapSelfTestCompletedExpectedExit {
    param([Parameter(Mandatory)]$Requested)

    return [ordered]@{
        protocol = [string]$Requested.value.protocol
        schemaVersion = [int]$Requested.value.schemaVersion
        bindingId = [string]$Requested.value.bindingId
        version = [string]$Requested.value.version
        projectRootSha256 = [string]$Requested.value.projectRootSha256
        dataRootIdentity = [string]$Requested.value.dataRootIdentity
        state = 'completed'
        requestedAt = [string]$Requested.value.requestedAt
        completedAt = [System.DateTimeOffset]::UtcNow.AddMilliseconds(10).ToString('o')
    }
}

function Remove-BootstrapSelfTestExpectedExitState {
    foreach ($path in @(
        $expectedExitPath,
        $expectedExitPendingPath,
        $expectedExitRecoveryPath,
        $expectedExitDiscardPath,
        $expectedExitLegacyBackupPath
    )) {
        if ([System.IO.File]::Exists($path)) { [System.IO.File]::Delete($path) }
    }
}

function Assert-BootstrapSelfTestExpectedExitArtifactsClear {
    param([Parameter(Mandatory)][string]$Message)

    Assert-BootstrapSelfTest -Condition (-not (
        [System.IO.File]::Exists($expectedExitPendingPath) -or
        [System.IO.File]::Exists($expectedExitRecoveryPath) -or
        [System.IO.File]::Exists($expectedExitDiscardPath) -or
        [System.IO.File]::Exists($expectedExitLegacyBackupPath)
    )) -Message $Message
}

function New-BootstrapSelfTestRelease {
    param(
        [Parameter(Mandatory)][string]$ReleaseRoot,
        [Parameter(Mandatory)][string]$Version
    )

    [System.IO.Directory]::CreateDirectory((Join-Path $ReleaseRoot 'scripts\windows')) | Out-Null
    [System.IO.Directory]::CreateDirectory((Join-Path $ReleaseRoot 'apps\api\dist')) | Out-Null
    $startTemplate = @'
[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$ProjectRoot,
    [Parameter(Mandatory)][int]$Ups,
    [Parameter(Mandatory)][string]$ProcessPriority
)
$ErrorActionPreference = 'Stop'
$root = [System.IO.Path]::GetFullPath($ProjectRoot)
$run = Join-Path $root 'run'
$executable = [System.IO.Path]::GetFullPath((Join-Path $root 'server\DSPGAME.exe'))
$pidPath = Join-Path $run 'dspgame.pid'
$signal = Join-Path $run 'fixture-managed-stop.signal'
$delaySignal = Join-Path $run 'fixture-start-delay.signal'
$events = Join-Path $run 'fixture-events.log'
[System.IO.Directory]::CreateDirectory($run) | Out-Null
if ([System.IO.File]::Exists($pidPath)) { throw 'managed fixture already active' }
if ([System.IO.File]::Exists($delaySignal)) {
    [System.Threading.Thread]::Sleep(1500)
    [System.IO.File]::Delete($delaySignal)
}
[System.IO.File]::Delete($signal)
$startInfo = [System.Diagnostics.ProcessStartInfo]::new()
$startInfo.FileName = $executable
$startInfo.Arguments = '"' + $signal + '"'
$startInfo.WorkingDirectory = [System.IO.Path]::GetDirectoryName($executable)
$startInfo.UseShellExecute = $false
$startInfo.CreateNoWindow = $true
$process = [System.Diagnostics.Process]::new()
$process.StartInfo = $startInfo
try {
    if (-not $process.Start()) { throw 'managed fixture failed to start' }
    [System.IO.File]::WriteAllText($pidPath, [string]$process.Id, [System.Text.Encoding]::ASCII)
    [System.IO.File]::AppendAllText($events, '__VERSION__|start|' + $process.Id + [System.Environment]::NewLine, [System.Text.Encoding]::ASCII)
    $process.WaitForExit()
    if ($process.ExitCode -ne 0) { throw 'managed fixture failed' }
}
finally {
    try {
        if ([System.IO.File]::Exists($pidPath) -and
            [System.IO.File]::ReadAllText($pidPath).Trim() -eq [string]$process.Id) {
            [System.IO.File]::Delete($pidPath)
        }
    }
    catch { }
    $process.Dispose()
}
'@
    $stopTemplate = @'
[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$ProjectRoot,
    [Parameter(Mandatory)][int]$TimeoutSeconds
)
$ErrorActionPreference = 'Stop'
$root = [System.IO.Path]::GetFullPath($ProjectRoot)
$run = Join-Path $root 'run'
$executable = [System.IO.Path]::GetFullPath((Join-Path $root 'server\DSPGAME.exe'))
$pidPath = Join-Path $run 'dspgame.pid'
$signal = Join-Path $run 'fixture-managed-stop.signal'
$failureSignal = Join-Path $run 'fixture-stop-failure.signal'
$events = Join-Path $run 'fixture-events.log'
if ([System.IO.File]::Exists($failureSignal)) {
    [System.IO.File]::Delete($failureSignal)
    throw 'injected managed fixture stop failure'
}
if (-not [System.IO.File]::Exists($pidPath)) {
    [System.IO.File]::AppendAllText($events, '__VERSION__|stop-idle' + [System.Environment]::NewLine, [System.Text.Encoding]::ASCII)
    exit 0
}
$rawPid = $null
$readDeadline = [System.DateTimeOffset]::UtcNow.AddSeconds(2)
do {
    try { $rawPid = [System.IO.File]::ReadAllText($pidPath).Trim() }
    catch [System.IO.IOException] { [System.Threading.Thread]::Sleep(25) }
} while ($null -eq $rawPid -and [System.DateTimeOffset]::UtcNow -lt $readDeadline)
if ($null -eq $rawPid) { throw 'managed fixture pid unavailable' }
$parsedPid = 0
if (-not [int]::TryParse($rawPid, [ref]$parsedPid) -or $parsedPid -le 0) { throw 'managed fixture pid invalid' }
$process = [System.Diagnostics.Process]::GetProcessById($parsedPid)
try {
    $actual = [System.IO.Path]::GetFullPath($process.MainModule.FileName)
    if (-not [string]::Equals($actual, $executable, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw 'managed fixture identity mismatch'
    }
    [System.IO.File]::WriteAllText($signal, 'stop', [System.Text.Encoding]::ASCII)
    if (-not $process.WaitForExit($TimeoutSeconds * 1000)) { throw 'managed fixture stop timeout' }
}
finally { $process.Dispose() }
try {
    if ([System.IO.File]::Exists($pidPath) -and [System.IO.File]::ReadAllText($pidPath).Trim() -eq $rawPid) {
        [System.IO.File]::Delete($pidPath)
    }
}
catch [System.IO.IOException] { }
[System.IO.File]::AppendAllText($events, '__VERSION__|stop|' + $rawPid + [System.Environment]::NewLine, [System.Text.Encoding]::ASCII)
'@
    Write-BootstrapSelfTestText -Path (Join-Path $ReleaseRoot 'scripts\windows\Start-DysonServer.ps1') `
        -Value $startTemplate.Replace('__VERSION__', $Version)
    Write-BootstrapSelfTestText -Path (Join-Path $ReleaseRoot 'scripts\windows\Stop-DysonServer.ps1') `
        -Value $stopTemplate.Replace('__VERSION__', $Version)
    Write-BootstrapSelfTestText -Path (Join-Path $ReleaseRoot 'apps\api\dist\index.js') `
        -Value ('// fictional control entry point ' + $Version)

    $rootFull = [System.IO.Path]::GetFullPath($ReleaseRoot).TrimEnd('\', '/')
    $prefix = $rootFull + [System.IO.Path]::DirectorySeparatorChar
    $files = @(
        [System.IO.Directory]::EnumerateFiles($rootFull, '*', [System.IO.SearchOption]::AllDirectories) |
            ForEach-Object {
                $full = [System.IO.Path]::GetFullPath($_)
                $relative = $full.Substring($prefix.Length).Replace('\', '/')
                $item = [System.IO.FileInfo]::new($full)
                [ordered]@{
                    path = $relative
                    length = [int64]$item.Length
                    sha256 = Get-DysonGameBootstrapFileSha256 -Path $full
                }
            } |
            Sort-Object { $_.path }
    )
    $lines = @($files | ForEach-Object { '{0}|{1}|{2}' -f $_.path, $_.length, $_.sha256 })
    $payloadSha256 = Get-DysonGameBootstrapSha256Text -Value ([string]::Join("`n", $lines))
    $manifest = [ordered]@{
        protocol = 'DYSON_CONTROL_DEPLOYMENT_V1'
        version = $Version
        entryPoint = 'apps/api/dist/index.js'
        nodeMinimumMajor = 22
        createdAt = [System.DateTimeOffset]::UtcNow.ToString('o')
        payloadSha256 = $payloadSha256
        files = $files
    }
    Write-BootstrapSelfTestText -Path (Join-Path $ReleaseRoot 'release-manifest.json') `
        -Value ($manifest | Microsoft.PowerShell.Utility\ConvertTo-Json -Depth 12 -Compress)
    return [pscustomobject][ordered]@{
        version = $Version
        payloadSha256 = $payloadSha256
    }
}

function Set-BootstrapSelfTestActiveRelease {
    param([Parameter(Mandatory)]$Release)

    $pointer = [ordered]@{
        protocol = 'DYSON_CONTROL_DEPLOYMENT_V1'
        version = [string]$Release.version
        entryPoint = 'apps/api/dist/index.js'
        payloadSha256 = [string]$Release.payloadSha256
        activatedAt = [System.DateTimeOffset]::UtcNow.ToString('o')
    }
    Write-BootstrapSelfTestText -Path $pointerPath `
        -Value ($pointer | Microsoft.PowerShell.Utility\ConvertTo-Json -Depth 6 -Compress)
}

function Assert-BootstrapSelfTestResolverRejected {
    param([Parameter(Mandatory)][string]$Message)

    $result = Invoke-BootstrapSelfTestCommand -ScriptPath (Join-Path $bootstrapRoot 'Resolve-DysonGameLifecycleRelease.ps1')
    $receipt = Get-BootstrapSelfTestJson -Result $result
    Assert-BootstrapSelfTest -Condition (
        $result.exitCode -eq 1 -and
        [string]$receipt.protocol -ceq 'DYSON_CONTROL_GAME_BOOTSTRAP_V1' -and
        [string]$receipt.state -ceq 'failed' -and
        [string]$receipt.errorCode -ceq 'BOOTSTRAP_RESOLUTION_FAILED'
    ) -Message $Message
    Assert-BootstrapSelfTestNoPathLeak -Result $result -Message ($Message + ' and leaked a host path')
}

function Start-BootstrapSelfTestForeignGame {
    [System.IO.File]::Delete($foreignSignal)
    $startInfo = [System.Diagnostics.ProcessStartInfo]::new()
    $startInfo.FileName = $gameExecutable
    $startInfo.Arguments = '"' + $foreignSignal + '"'
    $startInfo.WorkingDirectory = $serverRoot
    $startInfo.UseShellExecute = $false
    $startInfo.CreateNoWindow = $true
    $process = [System.Diagnostics.Process]::new()
    $process.StartInfo = $startInfo
    if (-not $process.Start()) { throw 'The foreign process fixture did not start.' }
    return $process
}

try {
    [System.IO.Directory]::CreateDirectory($bootstrapRoot) | Out-Null
    [System.IO.Directory]::CreateDirectory($releasesRoot) | Out-Null
    [System.IO.Directory]::CreateDirectory($stateRoot) | Out-Null
    [System.IO.Directory]::CreateDirectory($poisonProgramData) | Out-Null
    [System.IO.Directory]::CreateDirectory($serverRoot) | Out-Null
    [System.IO.Directory]::CreateDirectory($runRoot) | Out-Null
    $eventProbeStream = $null
    try {
        $eventProbeStream = [System.IO.FileStream]::new(
            $eventsPath,
            [System.IO.FileMode]::CreateNew,
            [System.IO.FileAccess]::Write,
            [System.IO.FileShare]::Read
        )
        $eventProbeBytes = [System.Text.Encoding]::ASCII.GetBytes("shared-writer-probe`r`n")
        $eventProbeStream.Write($eventProbeBytes, 0, $eventProbeBytes.Length)
        $eventProbeStream.Flush($true)
        $eventProbeLines = @(Get-BootstrapSelfTestEventLines)
        Assert-BootstrapSelfTest -Condition (
            $eventProbeLines.Count -eq 1 -and [string]$eventProbeLines[0] -ceq 'shared-writer-probe'
        ) -Message 'the lifecycle event reader could not snapshot an active writer safely'
    }
    finally {
        if ($eventProbeStream) { $eventProbeStream.Dispose() }
        if ([System.IO.File]::Exists($eventsPath)) { [System.IO.File]::Delete($eventsPath) }
    }
    Assert-BootstrapPidCleanupContract
    # Hold the actual publication observer open across retirement and a new
    # publication at the same path. The old handle must not block either write.
    [IO.File]::WriteAllText($bindingPath, '{"generation":"old"}')
    $bindingObserver = Open-BootstrapSelfTestBindingObserver -Path $bindingPath
    try {
        [IO.File]::Delete($bindingPath)
        [IO.File]::WriteAllText($bindingPath, '{"generation":"new"}')
        Assert-BootstrapSelfTest -Condition (
            ($bindingObserver.ReadToEnd() | ConvertFrom-Json).generation -ceq 'old' -and
            ([IO.File]::ReadAllText($bindingPath) | ConvertFrom-Json).generation -ceq 'new'
        ) -Message 'binding observation blocked retirement or observed a different publication'
    }
    finally { $bindingObserver.Dispose(); [IO.File]::Delete($bindingPath) }
    [IO.File]::WriteAllText($bindingPath, '{"version":')
    try {
        Assert-BootstrapSelfTest -Condition (-not (Test-BootstrapSelfTestPublishedLifecycle `
            -Version '2.0.0' -MinimumStartEvents 0)) `
            -Message 'a partial binding JSON was accepted as a published lifecycle'
    }
    finally { [IO.File]::Delete($bindingPath) }
    foreach ($name in @(
        'DysonGameLifecycleBootstrap.Common.ps1',
        'Resolve-DysonGameLifecycleRelease.ps1',
        'Start-DysonServer.ps1',
        'Stop-DysonServer.ps1'
    )) {
        [System.IO.File]::Copy((Join-Path $PSScriptRoot $name), (Join-Path $bootstrapRoot $name), $false)
    }
    $layoutReceipt = Write-DysonGameBootstrapLayout -BootstrapRoot $bootstrapRoot -DataRoot $dataRoot
    $layoutReceiptJson = $layoutReceipt | Microsoft.PowerShell.Utility\ConvertTo-Json -Depth 6 -Compress
    Assert-BootstrapSelfTest -Condition (
        [string]$layoutReceipt.protocol -ceq 'DYSON_CONTROL_GAME_BOOTSTRAP_LAYOUT_V1' -and
        [string]$layoutReceipt.state -ceq 'written' -and
        [int]$layoutReceipt.schemaVersion -eq 1 -and
        [string]$layoutReceipt.dataRootIdentity -match '^[0-9a-f]{64}$' -and
        [string]$layoutReceipt.layoutSha256 -match '^[0-9a-f]{64}$' -and
        -not $layoutReceiptJson.Contains($testRoot)
    ) -Message 'the installer-facing layout helper did not return a path-free verified receipt'
    $duplicateLayoutRejected = $false
    try { [void](Write-DysonGameBootstrapLayout -BootstrapRoot $bootstrapRoot -DataRoot $dataRoot) }
    catch { $duplicateLayoutRejected = $true }
    Assert-BootstrapSelfTest -Condition $duplicateLayoutRejected `
        -Message 'the layout helper overwrote an existing bootstrap descriptor'
    $validLayoutText = [System.IO.File]::ReadAllText(
        $layoutPath,
        [System.Text.UTF8Encoding]::new($false, $true)
    )
    Assert-BootstrapSelfTest -Condition (-not [string]::Equals(
        $dataRoot,
        (Join-Path $poisonProgramData 'DysonControl'),
        [System.StringComparison]::OrdinalIgnoreCase
    )) -Message 'the self-test did not use a deployment-selected non-default data root'

    $gameSource = @'
using System;
using System.Diagnostics;
using System.IO;
using System.Threading;
public static class DysonGameBootstrapProcessFixture {
    public static int Main(string[] args) {
        if (args.Length != 1 || String.IsNullOrWhiteSpace(args[0])) return 64;
        var lifetime = Stopwatch.StartNew();
        Stopwatch publication = null;
        while (lifetime.ElapsedMilliseconds < 300000) {
            if (File.Exists(args[0])) {
                if (publication == null) publication = Stopwatch.StartNew();
                try {
                    // WriteAllText makes the path visible before its writer closes.
                    // A sharing error or empty/partial value is not a game crash
                    // or a completed stop signal.
                    var command = File.ReadAllText(args[0]).Trim();
                    if (String.Equals(command, "crash", StringComparison.Ordinal)) return 17;
                    if (String.Equals(command, "stop", StringComparison.Ordinal) ||
                        String.Equals(command, "cleanup", StringComparison.Ordinal)) return 0;
                } catch (IOException) { }
                if (publication.ElapsedMilliseconds >= 5000) return 65;
            }
            Thread.Sleep(25);
        }
        return 66;
    }
}
'@
    Add-Type -TypeDefinition $gameSource -Language CSharp -OutputAssembly $gameExecutable -OutputType ConsoleApplication
    $releaseA = New-BootstrapSelfTestRelease -ReleaseRoot (Join-Path $releasesRoot '1.0.0') -Version '1.0.0'
    $releaseB = New-BootstrapSelfTestRelease -ReleaseRoot (Join-Path $releasesRoot '2.0.0') -Version '2.0.0'
    Set-BootstrapSelfTestActiveRelease -Release $releaseA

    $expectedExitContext = Get-DysonGameBootstrapContext -BootstrapRoot $bootstrapRoot
    $expectedExitProject = Get-DysonGameBootstrapProjectIdentity -ProjectRoot $projectRoot
    $expectedExitRelease = Resolve-DysonGameBootstrapActiveRelease -Context $expectedExitContext
    $expectedExitBinding = New-DysonGameBootstrapBinding -Release $expectedExitRelease `
        -ProjectRootSha256 $expectedExitProject.sha256 `
        -DataRootIdentity $expectedExitContext.dataRootIdentity
    $expectedExitLease = Enter-DysonGameBootstrapLock `
        -Path $expectedExitContext.stateLockPath -TimeoutSeconds 10
    try {
        Remove-BootstrapSelfTestExpectedExitState

        $invalidBinding = [pscustomobject][ordered]@{
            bindingId = [string]$expectedExitBinding.bindingId
            version = 1
            projectRootSha256 = [string]$expectedExitBinding.projectRootSha256
            dataRootIdentity = [string]$expectedExitBinding.dataRootIdentity
        }
        $invalidBindingRejected = $false
        try {
            [void](Write-DysonGameBootstrapExpectedExitRequested `
                -Context $expectedExitContext -Binding $invalidBinding)
        }
        catch { $invalidBindingRejected = $true }
        Assert-BootstrapSelfTest -Condition (
            $invalidBindingRejected -and -not [System.IO.File]::Exists($expectedExitPath)
        ) -Message 'expected-exit binding type validation mutated state before rejecting input'

        $requested = Write-DysonGameBootstrapExpectedExitRequested `
            -Context $expectedExitContext -Binding $expectedExitBinding
        $requestedAgain = Write-DysonGameBootstrapExpectedExitRequested `
            -Context $expectedExitContext -Binding $expectedExitBinding
        Assert-BootstrapSelfTest -Condition (
            [string]$requested.value.state -ceq 'requested' -and
            [string]$requestedAgain.sha256 -ceq [string]$requested.sha256 -and
            (Test-DysonGameBootstrapExpectedExitSecurityEqual -Left $requestedAgain -Right $requested)
        ) -Message 'same-binding requested expected-exit publication was not idempotent'

        $driftedBinding = [pscustomobject][ordered]@{
            bindingId = [string]$expectedExitBinding.bindingId
            version = '1.0.0-drift'
            projectRootSha256 = [string]$expectedExitBinding.projectRootSha256
            dataRootIdentity = [string]$expectedExitBinding.dataRootIdentity
        }
        $bindingDriftRejected = $false
        try {
            [void](Write-DysonGameBootstrapExpectedExitRequested `
                -Context $expectedExitContext -Binding $driftedBinding)
        }
        catch { $bindingDriftRejected = $true }
        $afterBindingDrift = Read-DysonGameBootstrapExpectedExit -Context $expectedExitContext
        Assert-BootstrapSelfTest -Condition (
            $bindingDriftRejected -and
            [string]$afterBindingDrift.sha256 -ceq [string]$requested.sha256
        ) -Message 'same-id field drift replaced an existing requested expected-exit intent'

        $differentBinding = New-DysonGameBootstrapBinding -Release $expectedExitRelease `
            -ProjectRootSha256 $expectedExitProject.sha256 `
            -DataRootIdentity $expectedExitContext.dataRootIdentity
        $differentBindingRejected = $false
        try {
            [void](Write-DysonGameBootstrapExpectedExitRequested `
                -Context $expectedExitContext -Binding $differentBinding)
        }
        catch { $differentBindingRejected = $true }
        Assert-BootstrapSelfTest -Condition $differentBindingRejected `
            -Message 'a different binding reused another binding expected-exit intent'

        foreach ($faultPhase in @('after-pending-write', 'after-replace')) {
            $script:DysonGameBootstrapExpectedExitFaultHook = {
                param($Phase, $FaultContext)
                if ($Phase -ceq $faultPhase) { throw ('injected ' + $faultPhase) }
            }.GetNewClosure()
            $faultRejected = $false
            try {
                [void](Complete-DysonGameBootstrapExpectedExit `
                    -Context $expectedExitContext -BindingId ([string]$expectedExitBinding.bindingId))
            }
            catch { $faultRejected = [string]$_.Exception.Message -ceq 'BOOTSTRAP_EXPECTED_EXIT_WRITE_FAILED' }
            finally { $script:DysonGameBootstrapExpectedExitFaultHook = $null }
            $afterFault = Read-DysonGameBootstrapExpectedExit -Context $expectedExitContext
            Assert-BootstrapSelfTest -Condition (
                $faultRejected -and
                [string]$afterFault.value.state -ceq 'requested' -and
                [string]$afterFault.sha256 -ceq [string]$requested.sha256 -and
                (Test-DysonGameBootstrapExpectedExitSecurityEqual -Left $afterFault -Right $requested)
            ) -Message ($faultPhase + ' did not restore the exact requested bytes and ACL')
            Assert-BootstrapSelfTestExpectedExitArtifactsClear `
                -Message ($faultPhase + ' left a recovery artifact after verified rollback')
        }

        $script:DysonGameBootstrapExpectedExitFaultHook = {
            param($Phase, $FaultContext)
            if ($Phase -ceq 'after-replace') {
                $currentCompleted = Read-DysonGameBootstrapExpectedExitFile `
                    -Context $FaultContext -Path ([string]$FaultContext.expectedExitPath)
                $changed = [ordered]@{
                    protocol = [string]$currentCompleted.value.protocol
                    schemaVersion = [int]$currentCompleted.value.schemaVersion
                    bindingId = [string]$currentCompleted.value.bindingId
                    version = [string]$currentCompleted.value.version
                    projectRootSha256 = [string]$currentCompleted.value.projectRootSha256
                    dataRootIdentity = [string]$currentCompleted.value.dataRootIdentity
                    state = 'completed'
                    requestedAt = [string]$currentCompleted.value.requestedAt
                    completedAt = [System.DateTimeOffset]::UtcNow.AddSeconds(1).ToString('o')
                }
                Write-BootstrapSelfTestExpectedExitArtifact `
                    -Path ([string]$FaultContext.expectedExitPath) -Value $changed
            }
        }
        $byteDriftRejected = $false
        try {
            [void](Complete-DysonGameBootstrapExpectedExit `
                -Context $expectedExitContext -BindingId ([string]$expectedExitBinding.bindingId))
        }
        catch { $byteDriftRejected = $true }
        finally { $script:DysonGameBootstrapExpectedExitFaultHook = $null }
        $afterByteDrift = Read-DysonGameBootstrapExpectedExit -Context $expectedExitContext
        Assert-BootstrapSelfTest -Condition (
            $byteDriftRejected -and
            [string]$afterByteDrift.sha256 -ceq [string]$requested.sha256 -and
            (Test-DysonGameBootstrapExpectedExitSecurityEqual -Left $afterByteDrift -Right $requested)
        ) -Message 'post-replace byte drift was accepted or was not exactly rolled back'

        $script:DysonGameBootstrapExpectedExitFaultHook = {
            param($Phase, $FaultContext)
            if ($Phase -ceq 'after-replace') {
                [System.IO.File]::WriteAllText(
                    [string]$FaultContext.expectedExitPath,
                    '{not-json',
                    [System.Text.UTF8Encoding]::new($false)
                )
            }
        }
        $malformedReplacementRejected = $false
        try {
            [void](Complete-DysonGameBootstrapExpectedExit `
                -Context $expectedExitContext -BindingId ([string]$expectedExitBinding.bindingId))
        }
        catch { $malformedReplacementRejected = $true }
        finally { $script:DysonGameBootstrapExpectedExitFaultHook = $null }
        $afterMalformedReplacement = Read-DysonGameBootstrapExpectedExit -Context $expectedExitContext
        Assert-BootstrapSelfTest -Condition (
            $malformedReplacementRejected -and
            [string]$afterMalformedReplacement.sha256 -ceq [string]$requested.sha256 -and
            (Test-DysonGameBootstrapExpectedExitSecurityEqual -Left $afterMalformedReplacement -Right $requested)
        ) -Message 'a malformed post-replace target did not restore the exact durable old copy'
        Assert-BootstrapSelfTestExpectedExitArtifactsClear `
            -Message 'malformed replacement recovery left a recovery artifact'

        $script:DysonGameBootstrapExpectedExitFaultHook = {
            param($Phase, $FaultContext)
            if ($Phase -ceq 'after-replace') {
                $acl = Microsoft.PowerShell.Security\Get-Acl `
                    -LiteralPath ([string]$FaultContext.expectedExitPath) -ErrorAction Stop
                $acl.SetAccessRuleProtection(-not $acl.AreAccessRulesProtected, $true)
                Microsoft.PowerShell.Security\Set-Acl `
                    -LiteralPath ([string]$FaultContext.expectedExitPath) -AclObject $acl -ErrorAction Stop
            }
        }
        $aclDriftRejected = $false
        try {
            [void](Complete-DysonGameBootstrapExpectedExit `
                -Context $expectedExitContext -BindingId ([string]$expectedExitBinding.bindingId))
        }
        catch { $aclDriftRejected = $true }
        finally { $script:DysonGameBootstrapExpectedExitFaultHook = $null }
        $afterAclDrift = Read-DysonGameBootstrapExpectedExit -Context $expectedExitContext
        Assert-BootstrapSelfTest -Condition (
            $aclDriftRejected -and
            [string]$afterAclDrift.sha256 -ceq [string]$requested.sha256 -and
            (Test-DysonGameBootstrapExpectedExitSecurityEqual -Left $afterAclDrift -Right $requested)
        ) -Message ('post-replace DACL drift was accepted or was not exactly rolled back [' +
            'rejected=' + [string]$aclDriftRejected +
            ';sha=' + [string]([string]$afterAclDrift.sha256 -ceq [string]$requested.sha256) +
            ';security=' + [string](Test-DysonGameBootstrapExpectedExitSecurityEqual `
                -Left $afterAclDrift -Right $requested) + ']')

        $script:DysonGameBootstrapRollbackFaultPhases = [System.Collections.Generic.List[string]]::new()
        $script:DysonGameBootstrapExpectedExitFaultHook = {
            param($Phase, $FaultContext)
            $script:DysonGameBootstrapRollbackFaultPhases.Add([string]$Phase)
            if ($Phase -cin @('after-replace', 'after-rollback-replace')) {
                throw ('injected durable recovery interruption at ' + $Phase)
            }
        }
        $rollbackInterrupted = $false
        try {
            [void](Complete-DysonGameBootstrapExpectedExit `
                -Context $expectedExitContext -BindingId ([string]$expectedExitBinding.bindingId))
        }
        catch { $rollbackInterrupted = $true }
        finally { $script:DysonGameBootstrapExpectedExitFaultHook = $null }
        $rollbackFaultPhases = @($script:DysonGameBootstrapRollbackFaultPhases.ToArray())
        Assert-BootstrapSelfTest -Condition (
            $rollbackInterrupted -and
            $rollbackFaultPhases -ccontains 'after-replace' -and
            $rollbackFaultPhases -ccontains 'after-rollback-replace' -and
            [System.IO.File]::Exists($expectedExitPath) -and
            [System.IO.File]::Exists($expectedExitDiscardPath) -and
            -not [System.IO.File]::Exists($expectedExitRecoveryPath)
        ) -Message ('an interrupted rollback did not preserve one canonical old copy and one discard [' +
            'rejected=' + [string]$rollbackInterrupted +
            ';canonical=' + [string][System.IO.File]::Exists($expectedExitPath) +
            ';discard=' + [string][System.IO.File]::Exists($expectedExitDiscardPath) +
            ';recovery=' + [string][System.IO.File]::Exists($expectedExitRecoveryPath) +
            ';phases=' + [string]::Join(',', $rollbackFaultPhases) + ']')
        $afterInterruptedRollback = Read-DysonGameBootstrapExpectedExit -Context $expectedExitContext
        Assert-BootstrapSelfTest -Condition (
            [string]$afterInterruptedRollback.sha256 -ceq [string]$requested.sha256 -and
            (Test-DysonGameBootstrapExpectedExitSecurityEqual `
                -Left $afterInterruptedRollback -Right $requested) -and
            -not [System.IO.File]::Exists($expectedExitDiscardPath)
        ) -Message 'a subsequent locked read did not finish the interrupted exact rollback'

        [System.IO.File]::Move($expectedExitPath, $expectedExitPendingPath)
        $pendingRequestedRecovered = Read-DysonGameBootstrapExpectedExit -Context $expectedExitContext
        Assert-BootstrapSelfTest -Condition (
            [string]$pendingRequestedRecovered.sha256 -ceq [string]$requested.sha256 -and
            [System.IO.File]::Exists($expectedExitPath)
        ) -Message 'a requested pending publication was not reconciled to canonical state'

        $completedValue = New-BootstrapSelfTestCompletedExpectedExit -Requested $pendingRequestedRecovered
        Write-BootstrapSelfTestExpectedExitArtifact `
            -Path $expectedExitPendingPath -Value $completedValue `
            -AclSddl ([string]$pendingRequestedRecovered.aclSddl)
        $pendingCompletedRecovered = Read-DysonGameBootstrapExpectedExit -Context $expectedExitContext
        Assert-BootstrapSelfTest -Condition (
            [string]$pendingCompletedRecovered.sha256 -ceq [string]$requested.sha256 -and
            -not [System.IO.File]::Exists($expectedExitPendingPath)
        ) -Message 'a pre-replace completed pending artifact did not roll back to requested'

        Write-BootstrapSelfTestExpectedExitArtifact `
            -Path $expectedExitRecoveryPath -Value $pendingCompletedRecovered.value `
            -AclSddl ([string]$pendingCompletedRecovered.aclSddl)
        Write-BootstrapSelfTestExpectedExitArtifact `
            -Path $expectedExitPath -Value $completedValue `
            -AclSddl ([string]$pendingCompletedRecovered.aclSddl)
        $recoveryArtifactRecovered = Read-DysonGameBootstrapExpectedExit -Context $expectedExitContext
        Assert-BootstrapSelfTest -Condition (
            [string]$recoveryArtifactRecovered.sha256 -ceq [string]$requested.sha256 -and
            -not [System.IO.File]::Exists($expectedExitRecoveryPath)
        ) -Message 'a durable replace recovery artifact did not restore requested exactly'

        Write-BootstrapSelfTestExpectedExitArtifact `
            -Path $expectedExitDiscardPath -Value $completedValue `
            -AclSddl ([string]$recoveryArtifactRecovered.aclSddl)
        $discardArtifactRecovered = Read-DysonGameBootstrapExpectedExit -Context $expectedExitContext
        Assert-BootstrapSelfTest -Condition (
            [string]$discardArtifactRecovered.sha256 -ceq [string]$requested.sha256 -and
            -not [System.IO.File]::Exists($expectedExitDiscardPath)
        ) -Message 'a durable rollback discard was not reconciled after old-copy verification'

        Write-BootstrapSelfTestExpectedExitArtifact `
            -Path $expectedExitPendingPath -Value $completedValue `
            -AclSddl ([string]$discardArtifactRecovered.aclSddl)
        Write-BootstrapSelfTestExpectedExitArtifact `
            -Path $expectedExitRecoveryPath -Value $discardArtifactRecovered.value `
            -AclSddl ([string]$discardArtifactRecovered.aclSddl)
        $multipleArtifactsRejected = $false
        try { [void](Read-DysonGameBootstrapExpectedExit -Context $expectedExitContext) }
        catch { $multipleArtifactsRejected = $true }
        Assert-BootstrapSelfTest -Condition (
            $multipleArtifactsRejected -and
            [System.IO.File]::Exists($expectedExitPendingPath) -and
            [System.IO.File]::Exists($expectedExitRecoveryPath)
        ) -Message 'multiple expected-exit recovery artifacts did not fail closed and remain preserved'
        [System.IO.File]::Delete($expectedExitPendingPath)
        [System.IO.File]::Delete($expectedExitRecoveryPath)

        $differentRequestedValue = [ordered]@{
            protocol = $script:DysonGameExpectedExitProtocol
            schemaVersion = 1
            bindingId = [string]$differentBinding.bindingId
            version = [string]$differentBinding.version
            projectRootSha256 = [string]$differentBinding.projectRootSha256
            dataRootIdentity = [string]$differentBinding.dataRootIdentity
            state = 'requested'
            requestedAt = [string]$discardArtifactRecovered.value.requestedAt
            completedAt = $null
        }
        Write-BootstrapSelfTestExpectedExitArtifact `
            -Path $expectedExitRecoveryPath -Value $differentRequestedValue `
            -AclSddl ([string]$discardArtifactRecovered.aclSddl)
        Write-BootstrapSelfTestExpectedExitArtifact `
            -Path $expectedExitPath -Value $completedValue `
            -AclSddl ([string]$discardArtifactRecovered.aclSddl)
        $mismatchedRecoveryRejected = $false
        try { [void](Read-DysonGameBootstrapExpectedExit -Context $expectedExitContext) }
        catch { $mismatchedRecoveryRejected = $true }
        Assert-BootstrapSelfTest -Condition (
            $mismatchedRecoveryRejected -and
            [System.IO.File]::Exists($expectedExitPath) -and
            [System.IO.File]::Exists($expectedExitRecoveryPath)
        ) -Message 'a cross-binding recovery artifact mutated canonical expected-exit state'
        Remove-BootstrapSelfTestExpectedExitState

        Write-BootstrapSelfTestExpectedExitArtifact `
            -Path $expectedExitLegacyBackupPath -Value $discardArtifactRecovered.value
        $unknownArtifactRejected = $false
        try {
            [void](Read-DysonGameBootstrapExpectedExit -Context $expectedExitContext -AllowMissing)
        }
        catch { $unknownArtifactRejected = $true }
        Assert-BootstrapSelfTest -Condition (
            $unknownArtifactRejected -and [System.IO.File]::Exists($expectedExitLegacyBackupPath)
        ) -Message 'an unknown legacy expected-exit artifact was silently removed or accepted'
        Remove-BootstrapSelfTestExpectedExitState

        $validExpectedExitFields = [ordered]@{
            protocol = $script:DysonGameExpectedExitProtocol
            schemaVersion = 1
            bindingId = [string]$expectedExitBinding.bindingId
            version = [string]$expectedExitBinding.version
            projectRootSha256 = [string]$expectedExitBinding.projectRootSha256
            dataRootIdentity = [string]$expectedExitBinding.dataRootIdentity
            state = 'requested'
            requestedAt = [System.DateTimeOffset]::UtcNow.ToString('o')
            completedAt = $null
        }
        $invalidExpectedExitValues = @(
            [ordered]@{
                protocol = $validExpectedExitFields.protocol; schemaVersion = 1
                bindingId = $validExpectedExitFields.bindingId; version = 1
                projectRootSha256 = $validExpectedExitFields.projectRootSha256
                dataRootIdentity = $validExpectedExitFields.dataRootIdentity; state = 'requested'
                requestedAt = $validExpectedExitFields.requestedAt; completedAt = ''
            },
            [ordered]@{
                protocol = $validExpectedExitFields.protocol; schemaVersion = 1
                bindingId = 'AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA'; version = $validExpectedExitFields.version
                projectRootSha256 = $validExpectedExitFields.projectRootSha256
                dataRootIdentity = $validExpectedExitFields.dataRootIdentity; state = 'requested'
                requestedAt = $validExpectedExitFields.requestedAt; completedAt = $null
            },
            [ordered]@{
                protocol = $validExpectedExitFields.protocol; schemaVersion = 1
                bindingId = $validExpectedExitFields.bindingId; version = 'invalid version'
                projectRootSha256 = ('A' * 64)
                dataRootIdentity = $validExpectedExitFields.dataRootIdentity; state = 'requested'
                requestedAt = $validExpectedExitFields.requestedAt; completedAt = $null
            }
        )
        foreach ($invalidExpectedExitValue in $invalidExpectedExitValues) {
            Write-BootstrapSelfTestExpectedExitArtifact `
                -Path $expectedExitPath -Value $invalidExpectedExitValue
            $invalidExpectedExitRejected = $false
            try { [void](Read-DysonGameBootstrapExpectedExit -Context $expectedExitContext) }
            catch { $invalidExpectedExitRejected = $true }
            Assert-BootstrapSelfTest -Condition (
                $invalidExpectedExitRejected -and [System.IO.File]::Exists($expectedExitPath)
            ) -Message 'invalid GUID/version/hash/string/null expected-exit input was accepted or deleted'
            Remove-BootstrapSelfTestExpectedExitState
        }

        $finalRequested = Write-DysonGameBootstrapExpectedExitRequested `
            -Context $expectedExitContext -Binding $expectedExitBinding
        $script:DysonGameBootstrapExpectedExitFaultHook = {
            param($Phase, $FaultContext)
            if ($Phase -cne 'after-replace') { return }
            $original = [Security.AccessControl.RawSecurityDescriptor]::new($finalRequested.aclSddl)
            foreach ($kind in @('canonical', 'recovery')) {
                $paths = Get-DysonGameBootstrapExpectedExitPaths $FaultContext
                $record = Read-DysonGameBootstrapExpectedExitFile -Context $FaultContext -Path $paths.$kind
                $actual = [Security.AccessControl.RawSecurityDescriptor]::new($record.aclSddl)
                $bootstrapFailureSecurity[$kind] = [ordered]@{
                    ownerMatches = ($actual.Owner.Value -ceq $original.Owner.Value)
                    groupMatches = ($actual.Group.Value -ceq $original.Group.Value)
                    flags = @([int]$original.ControlFlags, [int]$actual.ControlFlags)
                    aclRevisions = @($original.DiscretionaryAcl.Revision, $actual.DiscretionaryAcl.Revision)
                    originalAces = @($original.DiscretionaryAcl | ForEach-Object { '{0}:{1}:{2}' -f $_.AceType,[int]$_.AceFlags,$_.AccessMask })
                    actualAces = @($actual.DiscretionaryAcl | ForEach-Object { '{0}:{1}:{2}' -f $_.AceType,[int]$_.AceFlags,$_.AccessMask })
                    securityMatches = (Test-DysonGameBootstrapExpectedExitSecurityEqual $record $finalRequested)
                }
            }
        }.GetNewClosure()
        try {
            $finalCompleted = Complete-DysonGameBootstrapExpectedExit `
                -Context $expectedExitContext -BindingId ([string]$expectedExitBinding.bindingId)
        }
        finally { $script:DysonGameBootstrapExpectedExitFaultHook = $null }
        $finalCompletedAgain = Complete-DysonGameBootstrapExpectedExit `
            -Context $expectedExitContext -BindingId ([string]$expectedExitBinding.bindingId)
        $completedWriteAgain = Write-DysonGameBootstrapExpectedExitRequested `
            -Context $expectedExitContext -Binding $expectedExitBinding
        Assert-BootstrapSelfTest -Condition (
            [string]$finalRequested.value.state -ceq 'requested' -and
            [string]$finalCompleted.value.state -ceq 'completed' -and
            [string]$finalCompletedAgain.sha256 -ceq [string]$finalCompleted.sha256 -and
            [string]$completedWriteAgain.sha256 -ceq [string]$finalCompleted.sha256
        ) -Message 'same-binding completed expected-exit continuation was not idempotent'
        [void](Remove-DysonGameBootstrapExpectedExit `
            -Context $expectedExitContext -BindingId ([string]$expectedExitBinding.bindingId) -RequireCompleted)
        Assert-BootstrapSelfTestExpectedExitArtifactsClear `
            -Message 'the expected-exit crash safety matrix left a recovery artifact'
        $expectedExitCrashSafetyMatrixValidated = $true
    }
    finally {
        $script:DysonGameBootstrapExpectedExitFaultHook = $null
        Remove-BootstrapSelfTestExpectedExitState
        $expectedExitLease.Dispose()
    }

    $resolverPath = Join-Path $bootstrapRoot 'Resolve-DysonGameLifecycleRelease.ps1'
    $stableStartPath = Join-Path $bootstrapRoot 'Start-DysonServer.ps1'
    $stableStopPath = Join-Path $bootstrapRoot 'Stop-DysonServer.ps1'
    $startArguments = @('-ProjectRoot', $projectRoot, '-Ups', '60', '-ProcessPriority', 'Normal')
    $stopArguments = @('-ProjectRoot', $projectRoot, '-TimeoutSeconds', '15')

    $resolvedAResult = Invoke-BootstrapSelfTestCommand -ScriptPath $resolverPath
    $resolvedA = Get-BootstrapSelfTestJson -Result $resolvedAResult
    Assert-BootstrapSelfTest -Condition ($resolvedAResult.exitCode -eq 0 -and
        [string]$resolvedA.state -ceq 'resolved' -and [string]$resolvedA.version -ceq '1.0.0') `
        -Message 'the initial stable resolver did not bind release A'
    Assert-BootstrapSelfTestNoPathLeak -Result $resolvedAResult -Message 'the resolver disclosed a host path'

    $startAChild = Start-BootstrapSelfTestChild -ScriptPath $stableStartPath -Arguments $startArguments
    Wait-BootstrapSelfTestPublishedLifecycle -Child $startAChild -Context $expectedExitContext `
        -Version '1.0.0' -MinimumStartEvents 1 `
        -Message 'release A did not publish its durable lifecycle binding'
    $boundA = [System.IO.File]::ReadAllText($bindingPath) |
        Microsoft.PowerShell.Utility\ConvertFrom-Json -ErrorAction Stop
    Assert-BootstrapSelfTest -Condition (
        [string]$boundA.dataRootIdentity -ceq [string]$layoutReceipt.dataRootIdentity
    ) -Message 'the lifecycle binding omitted the verified deployment data-root identity'
    Set-BootstrapSelfTestActiveRelease -Release $releaseB
    $stopAResult = Invoke-BootstrapSelfTestCommand -ScriptPath $stableStopPath -Arguments $stopArguments
    $stopA = Get-BootstrapSelfTestJson -Result $stopAResult
    Assert-BootstrapSelfTest -Condition ($stopAResult.exitCode -eq 0 -and
        [string]$stopA.state -ceq 'completed' -and [string]$stopA.version -ceq '1.0.0') `
        -Message ('stop followed the upgraded pointer instead of the bound release A [' +
            ($stopA | Microsoft.PowerShell.Utility\ConvertTo-Json -Depth 6 -Compress) +
            ';exit=' + [string]$stopAResult.exitCode + ']')
    Assert-BootstrapSelfTestNoPathLeak -Result $stopAResult -Message 'the release A stop receipt disclosed a host path'
    $startAResult = Complete-BootstrapSelfTestChild -Child $startAChild
    $startA = Get-BootstrapSelfTestJson -Result $startAResult
    Assert-BootstrapSelfTest -Condition ($startAResult.exitCode -eq 0 -and
        [string]$startA.state -ceq 'completed' -and [string]$startA.version -ceq '1.0.0') `
        -Message 'the release A start wrapper did not finalize after the bound stop'
    Assert-BootstrapSelfTestNoPathLeak -Result $startAResult -Message 'the release A start receipt disclosed a host path'

    Set-BootstrapSelfTestActiveRelease -Release $releaseA
    $crashedStartAChild = Start-BootstrapSelfTestChild -ScriptPath $stableStartPath -Arguments $startArguments
    Wait-BootstrapSelfTestPublishedLifecycle -Child $crashedStartAChild -Context $expectedExitContext `
        -Version '1.0.0' -MinimumStartEvents 2 `
        -Message 'the hard-exit fixture did not bind release A'
    Set-BootstrapSelfTestActiveRelease -Release $releaseB
    Stop-BootstrapSelfTestChildAbruptly -Child $crashedStartAChild -Stage 'hard-exit recovery'
    $restartBChild = Start-BootstrapSelfTestChild -ScriptPath $stableStartPath -Arguments $startArguments
    Wait-BootstrapSelfTestPublishedLifecycle -Child $restartBChild -Context $expectedExitContext `
        -Version '2.0.0' -MinimumStartEvents 1 `
        -Message 'a restarted wrapper did not recover release A and bind active release B'
    $eventsAfterRecovery = Get-BootstrapSelfTestEventLines
    Assert-BootstrapSelfTest -Condition (
        @($eventsAfterRecovery | Where-Object { $_ -match '^1\.0\.0\|stop\|' }).Count -ge 2
    ) -Message 'hard-exit recovery did not stop the previously bound release A'

    $foreignProcess = Start-BootstrapSelfTestForeignGame
    [System.Threading.Thread]::Sleep(200)
    Assert-BootstrapSelfTest -Condition (-not $foreignProcess.HasExited) `
        -Message 'the foreign DSPGAME fixture exited before stop isolation was exercised'
    $stopBResult = Invoke-BootstrapSelfTestCommand -ScriptPath $stableStopPath -Arguments $stopArguments
    $stopB = Get-BootstrapSelfTestJson -Result $stopBResult
    Assert-BootstrapSelfTest -Condition ($stopBResult.exitCode -eq 0 -and
        [string]$stopB.state -ceq 'completed' -and [string]$stopB.version -ceq '2.0.0') `
        -Message 'restart recovery did not stop the newly bound release B'
    Assert-BootstrapSelfTest -Condition (-not $foreignProcess.HasExited) `
        -Message 'the bound stop affected an unrelated DSPGAME process'
    Assert-BootstrapSelfTestNoPathLeak -Result $stopBResult -Message 'the release B stop receipt disclosed a host path'
    $restartBResult = Complete-BootstrapSelfTestChild -Child $restartBChild
    $restartB = Get-BootstrapSelfTestJson -Result $restartBResult
    Assert-BootstrapSelfTest -Condition ($restartBResult.exitCode -eq 0 -and
        [string]$restartB.state -ceq 'completed' -and [string]$restartB.version -ceq '2.0.0') `
        -Message ('the restarted release B wrapper did not finalize [exit=' +
            [string]$restartBResult.exitCode + ';result=' +
            ($restartB | Microsoft.PowerShell.Utility\ConvertTo-Json -Depth 6 -Compress) +
            ';binding=' + [string][System.IO.File]::Exists($bindingPath) +
            ';expected=' + [string][System.IO.File]::Exists($expectedExitPath) +
            ';pid=' + [string][System.IO.File]::Exists($managedPidPath) + ']')
    Assert-BootstrapSelfTestNoPathLeak -Result $restartBResult -Message 'the release B start receipt disclosed a host path'
    [System.IO.File]::WriteAllText($foreignSignal, 'stop', [System.Text.Encoding]::ASCII)
    Assert-BootstrapSelfTest -Condition ($foreignProcess.WaitForExit(5000)) `
        -Message 'the isolated foreign DSPGAME fixture did not exit on its own signal'
    $foreignProcess.Dispose()
    $foreignProcess = $null

    $crashBChild = Start-BootstrapSelfTestChild -ScriptPath $stableStartPath -Arguments $startArguments
    Wait-BootstrapSelfTestPublishedLifecycle -Child $crashBChild -Context $expectedExitContext `
        -Version '2.0.0' -MinimumStartEvents 2 `
        -Message 'release B did not reach its published state before the managed crash drill'
    if ($crashBChild.process.HasExited) {
        $earlyCrashResult = Complete-BootstrapSelfTestChild -Child $crashBChild
        throw ('the stable wrapper exited before the managed crash signal: exit=' +
            [string]$earlyCrashResult.exitCode + '; stdout=' + [string]$earlyCrashResult.stdout +
            '; stderr=' + [string]$earlyCrashResult.stderr)
    }
    [System.IO.File]::WriteAllText($managedSignal, 'crash', [System.Text.Encoding]::ASCII)
    $crashBResult = Complete-BootstrapSelfTestChild -Child $crashBChild
    $crashB = Get-BootstrapSelfTestJson -Result $crashBResult
    Assert-BootstrapSelfTest -Condition (
        $crashBResult.exitCode -eq 1 -and
        [string]$crashB.state -ceq 'failed' -and
        [string]$crashB.errorCode -ceq 'BOOTSTRAP_RELEASE_START_FAILED' -and
        [string]$crashB.runtimeOutcome -ceq 'abnormal-exit' -and
        [bool]$crashB.restartExpected -and
        [string]$crashB.attemptId -match '^[0-9a-f-]{36}$' -and
        [string]$crashB.receiptSha256 -match '^[0-9a-f]{64}$' -and
        (Test-BootstrapSelfTestBindingVersion -Version '2.0.0') -and
        -not [System.IO.File]::Exists($managedPidPath)
    ) -Message ('a non-zero managed game exit did not fail the task wrapper with restart evidence [' +
        ($crashB | Microsoft.PowerShell.Utility\ConvertTo-Json -Depth 6 -Compress) +
        ';exit=' + [string]$crashBResult.exitCode +
        ';binding=' + [string](Test-BootstrapSelfTestBindingVersion -Version '2.0.0') +
        ';pid=' + [string][System.IO.File]::Exists($managedPidPath) + ']')
    Assert-BootstrapSelfTestNoPathLeak -Result $crashBResult `
        -Message 'the managed crash result disclosed a host path'
    $crashReceipt = Get-BootstrapSelfTestRuntimeReceipt -AttemptId ([string]$crashB.attemptId)
    Assert-BootstrapSelfTest -Condition (
        [string]$crashReceipt.value.protocol -ceq 'DYSON_CONTROL_GAME_RUNTIME_RECEIPT_V1' -and
        [int]$crashReceipt.value.schemaVersion -eq 1 -and
        [string]$crashReceipt.value.attemptId -ceq [string]$crashB.attemptId -and
        [string]$crashReceipt.value.bindingId -ceq [string]$crashB.bindingId -and
        [string]$crashReceipt.value.version -ceq '2.0.0' -and
        [string]$crashReceipt.value.outcome -ceq 'abnormal-exit' -and
        [string]$crashReceipt.value.errorCode -ceq 'BOOTSTRAP_RELEASE_START_FAILED' -and
        [bool]$crashReceipt.value.restartExpected -and
        [string]$crashReceipt.value.projectRootSha256 -match '^[0-9a-f]{64}$' -and
        [string]$crashReceipt.value.dataRootIdentity -ceq [string]$layoutReceipt.dataRootIdentity -and
        [string]$crashReceipt.sha256 -ceq [string]$crashB.receiptSha256
    ) -Message 'the managed crash receipt was not durable, bound, and path-free'

    $postCrashRestartBChild = Start-BootstrapSelfTestChild -ScriptPath $stableStartPath -Arguments $startArguments
    try {
        Wait-BootstrapSelfTestPublishedLifecycle -Child $postCrashRestartBChild `
            -Context $expectedExitContext -Version '2.0.0' -MinimumStartEvents 3 `
            -Message 'the task-style retry did not reconcile the crashed binding and restart release B'
    }
    catch {
        if ($postCrashRestartBChild.process.HasExited) {
            $earlyPostCrashResult = Complete-BootstrapSelfTestChild -Child $postCrashRestartBChild
            throw ('the task-style retry exited before publication: exit=' +
                [string]$earlyPostCrashResult.exitCode + '; stdout=' +
                [string]$earlyPostCrashResult.stdout + '; stderr=' +
                [string]$earlyPostCrashResult.stderr + '; binding=' +
                [string][System.IO.File]::Exists($bindingPath) + '; expected=' +
                [string][System.IO.File]::Exists($expectedExitPath) + '; pid=' +
                [string][System.IO.File]::Exists($managedPidPath) + '; stopFault=' +
                [string][System.IO.File]::Exists($stopFailureSignal) + '; pending=' +
                [string][System.IO.File]::Exists($expectedExitPendingPath) + '; recovery=' +
                [string][System.IO.File]::Exists($expectedExitRecoveryPath) + '; discard=' +
                [string][System.IO.File]::Exists($expectedExitDiscardPath))
        }
        throw
    }
    $postCrashStop = Invoke-BootstrapSelfTestCommand -ScriptPath $stableStopPath -Arguments $stopArguments
    Assert-BootstrapSelfTest -Condition ($postCrashStop.exitCode -eq 0) `
        -Message 'the recovered release B process did not stop cleanly'
    Assert-BootstrapSelfTestNoPathLeak -Result $postCrashStop `
        -Message 'the recovered release B stop result disclosed a host path'
    $postCrashRestartBResult = Complete-BootstrapSelfTestChild -Child $postCrashRestartBChild
    $postCrashRestartB = Get-BootstrapSelfTestJson -Result $postCrashRestartBResult
    Assert-BootstrapSelfTest -Condition (
        $postCrashRestartBResult.exitCode -eq 0 -and
        [string]$postCrashRestartB.state -ceq 'completed' -and
        [string]$postCrashRestartB.runtimeOutcome -ceq 'clean-exit' -and
        [bool]$postCrashRestartB.receiptPersisted -and
        [string]$postCrashRestartB.receiptSha256 -match '^[0-9a-f]{64}$'
    ) -Message ('the recovered wrapper did not persist its clean terminal receipt [' +
        'receiptErrorCode=' + [string](Get-BootstrapSelfTestPropertyValue `
            -Value $postCrashRestartB -Name 'receiptErrorCode') + ';exit=' +
        [string]$postCrashRestartBResult.exitCode + ';result=' +
        ($postCrashRestartB | Microsoft.PowerShell.Utility\ConvertTo-Json -Depth 6 -Compress) + ']')
    Assert-BootstrapSelfTestNoPathLeak -Result $postCrashRestartBResult `
        -Message 'the recovered clean terminal result disclosed a host path'
    $postCrashReceipt = Get-BootstrapSelfTestRuntimeReceipt -AttemptId ([string]$postCrashRestartB.attemptId)
    Assert-BootstrapSelfTest -Condition (
        [string]$postCrashReceipt.value.outcome -ceq 'clean-exit' -and
        -not [bool]$postCrashReceipt.value.restartExpected -and
        $null -eq $postCrashReceipt.value.errorCode -and
        [string]$postCrashReceipt.sha256 -ceq [string]$postCrashRestartB.receiptSha256
    ) -Message 'the recovered clean-exit receipt is invalid'
    Assert-BootstrapSelfTest -Condition (-not [System.IO.File]::Exists($expectedExitPath)) `
        -Message 'a verified graceful stop left its completed expected-exit intent unconsumed'

    $unexpectedZeroBChild = Start-BootstrapSelfTestChild -ScriptPath $stableStartPath -Arguments $startArguments
    Wait-BootstrapSelfTestPublishedLifecycle -Child $unexpectedZeroBChild `
        -Context $expectedExitContext -Version '2.0.0' -MinimumStartEvents 4 `
        -Message 'release B did not reach its published state before the unexpected zero-exit drill'
    Assert-BootstrapSelfTest -Condition (-not $unexpectedZeroBChild.process.HasExited) `
        -Message 'the stable wrapper exited before the unexpected zero-exit signal'
    # Bypass the stable stop wrapper. The managed child returns zero, but no
    # completed expected-exit intent exists, so Task Scheduler must retry it.
    [System.IO.File]::WriteAllText($managedSignal, 'stop', [System.Text.Encoding]::ASCII)
    $unexpectedZeroResult = Complete-BootstrapSelfTestChild -Child $unexpectedZeroBChild
    $unexpectedZero = Get-BootstrapSelfTestJson -Result $unexpectedZeroResult
    Assert-BootstrapSelfTest -Condition (
        $unexpectedZeroResult.exitCode -eq 1 -and
        [string]$unexpectedZero.state -ceq 'failed' -and
        [string]$unexpectedZero.errorCode -ceq 'BOOTSTRAP_UNEXPECTED_CLEAN_EXIT' -and
        [string]$unexpectedZero.runtimeOutcome -ceq 'abnormal-exit' -and
        [bool]$unexpectedZero.restartExpected -and
        [string]$unexpectedZero.receiptSha256 -match '^[0-9a-f]{64}$' -and
        (Test-BootstrapSelfTestBindingVersion -Version '2.0.0') -and
        -not [System.IO.File]::Exists($managedPidPath) -and
        -not [System.IO.File]::Exists($expectedExitPath)
    ) -Message ('an unmanaged zero exit was accepted as an intentional stop [' +
        ($unexpectedZero | Microsoft.PowerShell.Utility\ConvertTo-Json -Depth 6 -Compress) +
        ';exit=' + [string]$unexpectedZeroResult.exitCode + ']')
    Assert-BootstrapSelfTestNoPathLeak -Result $unexpectedZeroResult `
        -Message 'the unexpected zero-exit result disclosed a host path'
    $unexpectedZeroReceipt = Get-BootstrapSelfTestRuntimeReceipt -AttemptId ([string]$unexpectedZero.attemptId)
    Assert-BootstrapSelfTest -Condition (
        [string]$unexpectedZeroReceipt.value.outcome -ceq 'abnormal-exit' -and
        [string]$unexpectedZeroReceipt.value.errorCode -ceq 'BOOTSTRAP_UNEXPECTED_CLEAN_EXIT' -and
        [bool]$unexpectedZeroReceipt.value.restartExpected -and
        [string]$unexpectedZeroReceipt.value.bindingId -ceq [string]$unexpectedZero.bindingId -and
        [string]$unexpectedZeroReceipt.sha256 -ceq [string]$unexpectedZero.receiptSha256
    ) -Message 'the unexpected zero-exit receipt was not durable and restartable'

    $postUnexpectedRestartBChild = Start-BootstrapSelfTestChild `
        -ScriptPath $stableStartPath -Arguments $startArguments
    Wait-BootstrapSelfTestPublishedLifecycle -Child $postUnexpectedRestartBChild `
        -Context $expectedExitContext -Version '2.0.0' -MinimumStartEvents 5 `
        -Message 'the task-style retry did not recover an unexpected zero exit'
    $postUnexpectedStop = Invoke-BootstrapSelfTestCommand `
        -ScriptPath $stableStopPath -Arguments $stopArguments
    Assert-BootstrapSelfTest -Condition ($postUnexpectedStop.exitCode -eq 0) `
        -Message 'the process recovered from an unexpected zero exit did not stop cleanly'
    Assert-BootstrapSelfTestNoPathLeak -Result $postUnexpectedStop `
        -Message 'the post-unexpected stop result disclosed a host path'
    $postUnexpectedRestartBResult = Complete-BootstrapSelfTestChild -Child $postUnexpectedRestartBChild
    $postUnexpectedRestartB = Get-BootstrapSelfTestJson -Result $postUnexpectedRestartBResult
    Assert-BootstrapSelfTest -Condition (
        $postUnexpectedRestartBResult.exitCode -eq 0 -and
        [string]$postUnexpectedRestartB.state -ceq 'completed' -and
        [string]$postUnexpectedRestartB.runtimeOutcome -ceq 'clean-exit' -and
        [bool]$postUnexpectedRestartB.receiptPersisted -and
        -not [System.IO.File]::Exists($bindingPath) -and
        -not [System.IO.File]::Exists($expectedExitPath)
    ) -Message ('the recovered expected-exit intent was not consumed exactly once [' +
        'exit=' + [string]$postUnexpectedRestartBResult.exitCode +
        ';state=' + [string]$postUnexpectedRestartB.state +
        ';outcome=' + [string]$postUnexpectedRestartB.runtimeOutcome +
        ';errorCode=' + [string](Get-BootstrapSelfTestPropertyValue -Value $postUnexpectedRestartB -Name 'errorCode') +
        ';receipt=' + [string]$postUnexpectedRestartB.receiptPersisted +
        ';bindingPresent=' + [string][IO.File]::Exists($bindingPath) +
        ';intentPresent=' + [string][IO.File]::Exists($expectedExitPath) + ']')
    Assert-BootstrapSelfTestNoPathLeak -Result $postUnexpectedRestartBResult `
        -Message 'the post-unexpected clean result disclosed a host path'

    $orphanContext = Get-DysonGameBootstrapContext -BootstrapRoot $bootstrapRoot
    $orphanProject = Get-DysonGameBootstrapProjectIdentity -ProjectRoot $projectRoot
    $orphanRelease = Resolve-DysonGameBootstrapActiveRelease -Context $orphanContext
    $requestedOrphanBinding = New-DysonGameBootstrapBinding -Release $orphanRelease `
        -ProjectRootSha256 $orphanProject.sha256 -DataRootIdentity $orphanContext.dataRootIdentity
    $orphanLease = Enter-DysonGameBootstrapLock -Path $orphanContext.stateLockPath -TimeoutSeconds 10
    try {
        [void](Write-DysonGameBootstrapExpectedExitRequested `
            -Context $orphanContext -Binding $requestedOrphanBinding)
    }
    finally { $orphanLease.Dispose() }
    $requestedOrphanStartResult = Invoke-BootstrapSelfTestCommand `
        -ScriptPath $stableStartPath -Arguments $startArguments
    $requestedOrphanStart = Get-BootstrapSelfTestJson -Result $requestedOrphanStartResult
    $orphanLease = Enter-DysonGameBootstrapLock -Path $orphanContext.stateLockPath -TimeoutSeconds 10
    try {
        $preservedRequestedOrphan = Read-DysonGameBootstrapExpectedExit -Context $orphanContext
        Assert-BootstrapSelfTest -Condition (
            $requestedOrphanStartResult.exitCode -eq 1 -and
            [string]$requestedOrphanStart.errorCode -ceq 'BOOTSTRAP_PREVIOUS_BINDING_RECOVERY_FAILED' -and
            [string]$preservedRequestedOrphan.value.state -ceq 'requested' -and
            [string]$preservedRequestedOrphan.value.bindingId -ceq [string]$requestedOrphanBinding.bindingId -and
            -not [System.IO.File]::Exists($bindingPath) -and
            -not [System.IO.File]::Exists($managedPidPath)
        ) -Message 'requested expected-exit state without a binding was cleaned or allowed to start'
        [void](Remove-DysonGameBootstrapExpectedExit `
            -Context $orphanContext -BindingId ([string]$requestedOrphanBinding.bindingId))
    }
    finally { $orphanLease.Dispose() }
    Assert-BootstrapSelfTestNoPathLeak -Result $requestedOrphanStartResult `
        -Message 'the requested orphan rejection disclosed a host path'

    $completedOrphanBinding = New-DysonGameBootstrapBinding -Release $orphanRelease `
        -ProjectRootSha256 $orphanProject.sha256 -DataRootIdentity $orphanContext.dataRootIdentity
    $orphanLease = Enter-DysonGameBootstrapLock -Path $orphanContext.stateLockPath -TimeoutSeconds 10
    try {
        [void](Write-DysonGameBootstrapExpectedExitRequested `
            -Context $orphanContext -Binding $completedOrphanBinding)
        [void](Complete-DysonGameBootstrapExpectedExit `
            -Context $orphanContext -BindingId ([string]$completedOrphanBinding.bindingId))
    }
    finally { $orphanLease.Dispose() }
    $completedOrphanStartBaseline = @(
        Get-BootstrapSelfTestEventLines | Where-Object { $_ -match '^2\.0\.0\|start\|' }
    ).Count
    $completedOrphanStartChild = Start-BootstrapSelfTestChild `
        -ScriptPath $stableStartPath -Arguments $startArguments
    Wait-BootstrapSelfTestPublishedLifecycle -Child $completedOrphanStartChild `
        -Context $expectedExitContext -Version '2.0.0' `
        -MinimumStartEvents ($completedOrphanStartBaseline + 1) `
        -Message 'completed expected-exit state without a binding was not cleaned before a new start'
    $completedOrphanStopResult = Invoke-BootstrapSelfTestCommand `
        -ScriptPath $stableStopPath -Arguments $stopArguments
    $completedOrphanStartResult = Complete-BootstrapSelfTestChild -Child $completedOrphanStartChild
    $completedOrphanStart = Get-BootstrapSelfTestJson -Result $completedOrphanStartResult
    $completedOrphanStop = Get-BootstrapSelfTestJson -Result $completedOrphanStopResult
    $completedOrphanSnapshotLease = Enter-DysonGameBootstrapLock `
        -Path $orphanContext.stateLockPath -TimeoutSeconds 10
    try {
        $completedOrphanBindingSnapshot = Read-DysonGameBootstrapBinding -Context $orphanContext
        $completedOrphanIntentSnapshot = Read-DysonGameBootstrapExpectedExit `
            -Context $orphanContext -AllowMissing
    }
    finally { $completedOrphanSnapshotLease.Dispose() }
    $completedOrphanPidRaw = $null
    $completedOrphanPidAlive = $false
    $completedOrphanPidExecutableMatched = $false
    if ([System.IO.File]::Exists($managedPidPath)) {
        try {
            $completedOrphanPidRaw = [System.IO.File]::ReadAllText($managedPidPath).Trim()
            $completedOrphanPid = 0
            if ([int]::TryParse($completedOrphanPidRaw, [ref]$completedOrphanPid) -and
                $completedOrphanPid -gt 0) {
                $completedOrphanProcess = $null
                try {
                    $completedOrphanProcess = [System.Diagnostics.Process]::GetProcessById($completedOrphanPid)
                    $completedOrphanPidAlive = -not $completedOrphanProcess.HasExited
                    $completedOrphanPidExecutableMatched = [string]::Equals(
                        [System.IO.Path]::GetFullPath($completedOrphanProcess.MainModule.FileName),
                        [System.IO.Path]::GetFullPath($gameExecutable),
                        [System.StringComparison]::OrdinalIgnoreCase
                    )
                }
                catch { }
                finally { if ($completedOrphanProcess) { $completedOrphanProcess.Dispose() } }
            }
        }
        catch { }
    }
    $completedOrphanReceiptSnapshot = $null
    $completedOrphanAttemptId = [string](Get-BootstrapSelfTestPropertyValue `
        -Value $completedOrphanStart -Name 'attemptId')
    if ($completedOrphanAttemptId -match '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$') {
        try {
            $completedOrphanReceiptSnapshot = Get-BootstrapSelfTestRuntimeReceipt `
                -AttemptId $completedOrphanAttemptId
        }
        catch { }
    }
    $completedOrphanDiagnostic = [ordered]@{
        stop = [ordered]@{
            exitCode = [int]$completedOrphanStopResult.exitCode
            state = Get-BootstrapSelfTestPropertyValue -Value $completedOrphanStop -Name 'state'
            errorCode = Get-BootstrapSelfTestPropertyValue -Value $completedOrphanStop -Name 'errorCode'
            bindingId = Get-BootstrapSelfTestPropertyValue -Value $completedOrphanStop -Name 'bindingId'
        }
        start = [ordered]@{
            exitCode = [int]$completedOrphanStartResult.exitCode
            state = Get-BootstrapSelfTestPropertyValue -Value $completedOrphanStart -Name 'state'
            errorCode = Get-BootstrapSelfTestPropertyValue -Value $completedOrphanStart -Name 'errorCode'
            runtimeOutcome = Get-BootstrapSelfTestPropertyValue -Value $completedOrphanStart -Name 'runtimeOutcome'
            attemptId = $completedOrphanAttemptId
            bindingId = Get-BootstrapSelfTestPropertyValue -Value $completedOrphanStart -Name 'bindingId'
            receiptSha256 = Get-BootstrapSelfTestPropertyValue -Value $completedOrphanStart -Name 'receiptSha256'
        }
        durable = [ordered]@{
            bindingPresent = $null -ne $completedOrphanBindingSnapshot
            bindingId = if ($null -ne $completedOrphanBindingSnapshot) {
                [string]$completedOrphanBindingSnapshot.bindingId
            }
            else { $null }
            intentPresent = $null -ne $completedOrphanIntentSnapshot
            intentState = if ($null -ne $completedOrphanIntentSnapshot) {
                [string]$completedOrphanIntentSnapshot.value.state
            }
            else { $null }
            intentBindingId = if ($null -ne $completedOrphanIntentSnapshot) {
                [string]$completedOrphanIntentSnapshot.value.bindingId
            }
            else { $null }
            pidFilePresent = [System.IO.File]::Exists($managedPidPath)
            pid = $completedOrphanPidRaw
            pidAlive = $completedOrphanPidAlive
            pidExecutableMatched = $completedOrphanPidExecutableMatched
        }
        receipt = [ordered]@{
            present = $null -ne $completedOrphanReceiptSnapshot
            outcome = if ($null -ne $completedOrphanReceiptSnapshot) {
                [string]$completedOrphanReceiptSnapshot.value.outcome
            }
            else { $null }
            errorCode = if ($null -ne $completedOrphanReceiptSnapshot) {
                $completedOrphanReceiptSnapshot.value.errorCode
            }
            else { $null }
            restartExpected = if ($null -ne $completedOrphanReceiptSnapshot) {
                [bool]$completedOrphanReceiptSnapshot.value.restartExpected
            }
            else { $null }
        }
        events = [ordered]@{
            starts = @(Get-BootstrapSelfTestEventLines | Where-Object { $_ -match '^2\.0\.0\|start\|' }).Count
            stops = @(Get-BootstrapSelfTestEventLines | Where-Object { $_ -match '^2\.0\.0\|stop\|' }).Count
        }
    }
    Assert-BootstrapSelfTest -Condition (
        $completedOrphanStopResult.exitCode -eq 0 -and
        $completedOrphanStartResult.exitCode -eq 0 -and
        [string]$completedOrphanStart.runtimeOutcome -ceq 'clean-exit' -and
        -not [System.IO.File]::Exists($bindingPath) -and
        -not [System.IO.File]::Exists($expectedExitPath)
    ) -Message ('completed orphan cleanup did not preserve the next managed lifecycle [' +
        ($completedOrphanDiagnostic | Microsoft.PowerShell.Utility\ConvertTo-Json -Depth 8 -Compress) + ']')

    $resumableStopStartBaseline = @(
        Get-BootstrapSelfTestEventLines | Where-Object { $_ -match '^2\.0\.0\|start\|' }
    ).Count
    $resumableStopChild = Start-BootstrapSelfTestChild `
        -ScriptPath $stableStartPath -Arguments $startArguments
    Wait-BootstrapSelfTestPublishedLifecycle -Child $resumableStopChild `
        -Context $expectedExitContext -Version '2.0.0' `
        -MinimumStartEvents ($resumableStopStartBaseline + 1) `
        -Message 'the resumable stop fixture did not publish its binding'
    [System.IO.File]::WriteAllText($stopFailureSignal, 'fail', [System.Text.Encoding]::ASCII)
    $failedStopResult = Invoke-BootstrapSelfTestCommand `
        -ScriptPath $stableStopPath -Arguments $stopArguments
    $failedStop = Get-BootstrapSelfTestJson -Result $failedStopResult
    $resumableLease = Enter-DysonGameBootstrapLock -Path $orphanContext.stateLockPath -TimeoutSeconds 10
    try {
        $failedStopBinding = Read-DysonGameBootstrapBinding -Context $orphanContext
        $failedStopIntent = Read-DysonGameBootstrapExpectedExit -Context $orphanContext
        Assert-DysonGameBootstrapExpectedExitMatchesBinding `
            -ExpectedExit $failedStopIntent -Binding $failedStopBinding -Context $orphanContext
        Assert-BootstrapSelfTest -Condition (
            $failedStopResult.exitCode -eq 1 -and
            [string]$failedStop.errorCode -ceq 'BOOTSTRAP_RELEASE_STOP_FAILED' -and
            [string]$failedStopIntent.value.state -ceq 'requested' -and
            [System.IO.File]::Exists($bindingPath) -and
            [System.IO.File]::Exists($managedPidPath)
        ) -Message 'a failed Stop removed its same-binding requested intent or durable binding'
    }
    finally { $resumableLease.Dispose() }
    Stop-BootstrapSelfTestChildAbruptly -Child $resumableStopChild -Stage 'resumable stop recovery'

    [System.IO.File]::WriteAllText($stopFailureSignal, 'fail-again', [System.Text.Encoding]::ASCII)
    $failedRecoveryStartResult = Invoke-BootstrapSelfTestCommand `
        -ScriptPath $stableStartPath -Arguments $startArguments
    $failedRecoveryStart = Get-BootstrapSelfTestJson -Result $failedRecoveryStartResult
    $resumableLease = Enter-DysonGameBootstrapLock -Path $orphanContext.stateLockPath -TimeoutSeconds 10
    try {
        $failedRecoveryBinding = Read-DysonGameBootstrapBinding -Context $orphanContext
        $failedRecoveryIntent = Read-DysonGameBootstrapExpectedExit -Context $orphanContext
        Assert-DysonGameBootstrapExpectedExitMatchesBinding `
            -ExpectedExit $failedRecoveryIntent -Binding $failedRecoveryBinding -Context $orphanContext
        Assert-BootstrapSelfTest -Condition (
            $failedRecoveryStartResult.exitCode -eq 1 -and
            [string]$failedRecoveryStart.errorCode -ceq 'BOOTSTRAP_PREVIOUS_BINDING_RECOVERY_FAILED' -and
            [string]$failedRecoveryIntent.value.state -ceq 'requested' -and
            [System.IO.File]::Exists($bindingPath) -and
            [System.IO.File]::Exists($managedPidPath)
        ) -Message 'Start deleted a previous binding or requested intent before its pinned stop succeeded'
    }
    finally { $resumableLease.Dispose() }
    Assert-BootstrapSelfTestNoPathLeak -Result $failedRecoveryStartResult `
        -Message 'the failed previous-stop recovery disclosed a host path'

    $recoveredResumableStartChild = Start-BootstrapSelfTestChild `
        -ScriptPath $stableStartPath -Arguments $startArguments
    Wait-BootstrapSelfTestPublishedLifecycle -Child $recoveredResumableStartChild `
        -Context $expectedExitContext -Version '2.0.0' `
        -MinimumStartEvents ($resumableStopStartBaseline + 2) `
        -Message 'same-binding requested intent did not resume after the injected stop failures'
    $recoveredResumableStopResult = Invoke-BootstrapSelfTestCommand `
        -ScriptPath $stableStopPath -Arguments $stopArguments
    $recoveredResumableStartResult = Complete-BootstrapSelfTestChild `
        -Child $recoveredResumableStartChild
    Assert-BootstrapSelfTest -Condition (
        $recoveredResumableStopResult.exitCode -eq 0 -and
        $recoveredResumableStartResult.exitCode -eq 0 -and
        -not [System.IO.File]::Exists($bindingPath) -and
        -not [System.IO.File]::Exists($expectedExitPath)
    ) -Message 'same-binding requested recovery did not finish a clean replacement lifecycle'

    $completedContinuationBaseline = @(
        Get-BootstrapSelfTestEventLines | Where-Object { $_ -match '^2\.0\.0\|start\|' }
    ).Count
    $completedContinuationChild = Start-BootstrapSelfTestChild `
        -ScriptPath $stableStartPath -Arguments $startArguments
    Wait-BootstrapSelfTestPublishedLifecycle -Child $completedContinuationChild `
        -Context $expectedExitContext -Version '2.0.0' `
        -MinimumStartEvents ($completedContinuationBaseline + 1) `
        -Message 'the completed Stop continuation fixture did not start'
    $completedContinuationLease = Enter-DysonGameBootstrapLock `
        -Path $orphanContext.stateLockPath -TimeoutSeconds 10
    try {
        $completedContinuationBinding = Read-DysonGameBootstrapBinding -Context $orphanContext
        [void](Write-DysonGameBootstrapExpectedExitRequested `
            -Context $orphanContext -Binding $completedContinuationBinding)
        [void](Complete-DysonGameBootstrapExpectedExit `
            -Context $orphanContext `
            -BindingId ([string]$completedContinuationBinding.bindingId))
    }
    finally { $completedContinuationLease.Dispose() }
    $completedContinuationStopResult = Invoke-BootstrapSelfTestCommand `
        -ScriptPath $stableStopPath -Arguments $stopArguments
    $completedContinuationStartResult = Complete-BootstrapSelfTestChild `
        -Child $completedContinuationChild
    Assert-BootstrapSelfTest -Condition (
        $completedContinuationStopResult.exitCode -eq 0 -and
        $completedContinuationStartResult.exitCode -eq 0 -and
        -not [System.IO.File]::Exists($bindingPath) -and
        -not [System.IO.File]::Exists($expectedExitPath)
    ) -Message 'Stop did not idempotently continue an existing completed same-binding intent'
    $expectedExitRealProcessRecoveryValidated = $true

    Write-BootstrapSelfTestText -Path $expectedExitPath -Value '{not-json'
    $tamperedExpectedExitResult = Invoke-BootstrapSelfTestCommand `
        -ScriptPath $stableStartPath -Arguments $startArguments
    $tamperedExpectedExit = Get-BootstrapSelfTestJson -Result $tamperedExpectedExitResult
    Assert-BootstrapSelfTest -Condition (
        $tamperedExpectedExitResult.exitCode -eq 1 -and
        [string]$tamperedExpectedExit.state -ceq 'failed' -and
        [string]$tamperedExpectedExit.errorCode -ceq 'BOOTSTRAP_PREVIOUS_BINDING_RECOVERY_FAILED' -and
        [string]$tamperedExpectedExit.runtimeOutcome -ceq 'startup-failure' -and
        -not [System.IO.File]::Exists($bindingPath) -and
        -not [System.IO.File]::Exists($managedPidPath)
    ) -Message 'a malformed expected-exit intent did not fail closed before start publication'
    Assert-BootstrapSelfTestNoPathLeak -Result $tamperedExpectedExitResult `
        -Message 'the malformed expected-exit result disclosed a host path'
    [System.IO.File]::Delete($expectedExitPath)

    $resolvedBResult = Invoke-BootstrapSelfTestCommand -ScriptPath $resolverPath
    $resolvedB = Get-BootstrapSelfTestJson -Result $resolvedBResult
    Assert-BootstrapSelfTest -Condition ($resolvedBResult.exitCode -eq 0 -and
        [string]$resolvedB.state -ceq 'resolved' -and [string]$resolvedB.version -ceq '2.0.0') `
        -Message 'a fresh resolver after restart did not select release B'
    Assert-BootstrapSelfTestNoPathLeak -Result $resolvedBResult -Message 'the restarted resolver disclosed a host path'

    [System.IO.File]::WriteAllText($startDelaySignal, 'delay', [System.Text.Encoding]::ASCII)
    $delayedStartBChild = Start-BootstrapSelfTestChild -ScriptPath $stableStartPath -Arguments $startArguments
    Wait-BootstrapSelfTestCondition -Condition {
        (Test-BootstrapSelfTestBindingVersion -Version '2.0.0') -and
        [System.IO.File]::Exists($startDelaySignal) -and
        -not [System.IO.File]::Exists($managedPidPath)
    } -Message 'the delayed start did not expose its pre-publication binding window'
    $concurrentStopTimer = [System.Diagnostics.Stopwatch]::StartNew()
    $concurrentStopBResult = Invoke-BootstrapSelfTestCommand `
        -ScriptPath $stableStopPath -Arguments $stopArguments -TimeoutSeconds 20
    $concurrentStopTimer.Stop()
    $concurrentStopB = Get-BootstrapSelfTestJson -Result $concurrentStopBResult
    Assert-BootstrapSelfTest -Condition ($concurrentStopBResult.exitCode -eq 0 -and
        [string]$concurrentStopB.state -ceq 'completed' -and [string]$concurrentStopB.version -ceq '2.0.0') `
        -Message 'a concurrent stop consumed the binding before delayed start publication'
    Assert-BootstrapSelfTest -Condition ($concurrentStopTimer.ElapsedMilliseconds -ge 900) `
        -Message 'a concurrent stop did not wait for start publication under the shared state lock'
    $delayedStartBResult = Complete-BootstrapSelfTestChild -Child $delayedStartBChild
    $delayedStartB = Get-BootstrapSelfTestJson -Result $delayedStartBResult
    Assert-BootstrapSelfTest -Condition ($delayedStartBResult.exitCode -eq 0 -and
        [string]$delayedStartB.state -ceq 'completed' -and [string]$delayedStartB.version -ceq '2.0.0') `
        -Message 'the delayed start did not finalize after its serialized stop'
    Assert-BootstrapSelfTestNoPathLeak -Result $concurrentStopBResult `
        -Message 'the concurrent stop receipt disclosed a host path'
    Assert-BootstrapSelfTestNoPathLeak -Result $delayedStartBResult `
        -Message 'the delayed start receipt disclosed a host path'

    [System.IO.File]::AppendAllText(
        (Join-Path $releasesRoot '2.0.0\scripts\windows\Start-DysonServer.ps1'),
        "`n# tampered",
        [System.Text.UTF8Encoding]::new($false)
    )
    Assert-BootstrapSelfTestResolverRejected -Message 'a damaged active release B was accepted'
    Set-BootstrapSelfTestActiveRelease -Release $releaseA
    $rollbackAResult = Invoke-BootstrapSelfTestCommand -ScriptPath $resolverPath
    $rollbackA = Get-BootstrapSelfTestJson -Result $rollbackAResult
    Assert-BootstrapSelfTest -Condition ($rollbackAResult.exitCode -eq 0 -and
        [string]$rollbackA.version -ceq '1.0.0') -Message 'failed release B did not permit an explicit pointer rollback to A'

    Write-BootstrapSelfTestText -Path $pointerPath -Value '{not-json'
    Assert-BootstrapSelfTestResolverRejected -Message 'malformed active state was accepted'
    Set-BootstrapSelfTestActiveRelease -Release $releaseA
    $pointerWithExtraField = [ordered]@{
        protocol = 'DYSON_CONTROL_DEPLOYMENT_V1'; version = '1.0.0'
        entryPoint = 'apps/api/dist/index.js'; payloadSha256 = [string]$releaseA.payloadSha256
        activatedAt = [System.DateTimeOffset]::UtcNow.ToString('o'); unexpected = $true
    }
    Write-BootstrapSelfTestText -Path $pointerPath `
        -Value ($pointerWithExtraField | Microsoft.PowerShell.Utility\ConvertTo-Json -Depth 6 -Compress)
    Assert-BootstrapSelfTestResolverRejected -Message 'active state with unknown fields was accepted'
    $escapedPointer = [ordered]@{
        protocol = 'DYSON_CONTROL_DEPLOYMENT_V1'; version = '..\outside-release'
        entryPoint = 'apps/api/dist/index.js'; payloadSha256 = ('0' * 64)
        activatedAt = [System.DateTimeOffset]::UtcNow.ToString('o')
    }
    Write-BootstrapSelfTestText -Path $pointerPath `
        -Value ($escapedPointer | Microsoft.PowerShell.Utility\ConvertTo-Json -Depth 6 -Compress)
    Assert-BootstrapSelfTestResolverRejected -Message 'an active version that escaped the releases root was accepted'
    $missingPointer = [ordered]@{
        protocol = 'DYSON_CONTROL_DEPLOYMENT_V1'; version = '3.0.0'
        entryPoint = 'apps/api/dist/index.js'; payloadSha256 = ('0' * 64)
        activatedAt = [System.DateTimeOffset]::UtcNow.ToString('o')
    }
    Write-BootstrapSelfTestText -Path $pointerPath `
        -Value ($missingPointer | Microsoft.PowerShell.Utility\ConvertTo-Json -Depth 6 -Compress)
    Assert-BootstrapSelfTestResolverRejected -Message 'an active version with no immutable release was accepted'
    [System.IO.File]::Delete($pointerPath)
    Assert-BootstrapSelfTestResolverRejected -Message 'missing active state was accepted'

    $outside = New-BootstrapSelfTestRelease -ReleaseRoot $outsideRelease -Version '9.9.9'
    [void](New-Item -ItemType Junction -Path $redirectedRelease -Target $outsideRelease -ErrorAction Stop)
    $redirectCreated = $true
    Set-BootstrapSelfTestActiveRelease -Release $outside
    Assert-BootstrapSelfTestResolverRejected -Message 'a redirected release directory was accepted'
    [System.IO.Directory]::Delete($redirectedRelease, $false)
    $redirectCreated = $false

    Set-BootstrapSelfTestActiveRelease -Release $releaseA
    [System.IO.File]::Delete($layoutPath)
    Assert-BootstrapSelfTestResolverRejected -Message 'a missing bootstrap layout was accepted'
    Write-BootstrapSelfTestText -Path $layoutPath -Value $validLayoutText

    $tamperedLayout = $validLayoutText | Microsoft.PowerShell.Utility\ConvertFrom-Json
    $tamperedLayout.dataRootIdentity = '0' * 64
    Write-BootstrapSelfTestText -Path $layoutPath `
        -Value ($tamperedLayout | Microsoft.PowerShell.Utility\ConvertTo-Json -Depth 6 -Compress)
    Assert-BootstrapSelfTestResolverRejected -Message 'a bootstrap layout with a false data-root identity was accepted'
    Write-BootstrapSelfTestText -Path $layoutPath -Value $validLayoutText

    $validLayout = $validLayoutText | Microsoft.PowerShell.Utility\ConvertFrom-Json
    $unknownLayout = [ordered]@{
        protocol = [string]$validLayout.protocol
        schemaVersion = [int]$validLayout.schemaVersion
        dataRoot = [string]$validLayout.dataRoot
        dataRootIdentity = [string]$validLayout.dataRootIdentity
        createdAt = [string]$validLayout.createdAt
        unexpected = $true
    }
    Write-BootstrapSelfTestText -Path $layoutPath `
        -Value ($unknownLayout | Microsoft.PowerShell.Utility\ConvertTo-Json -Depth 6 -Compress)
    Assert-BootstrapSelfTestResolverRejected -Message 'a bootstrap layout with an unknown field was accepted'
    Write-BootstrapSelfTestText -Path $layoutPath -Value $validLayoutText

    $relativeLayout = [ordered]@{
        protocol = [string]$validLayout.protocol
        schemaVersion = [int]$validLayout.schemaVersion
        dataRoot = 'relative-data-root'
        dataRootIdentity = [string]$validLayout.dataRootIdentity
        createdAt = [string]$validLayout.createdAt
    }
    Write-BootstrapSelfTestText -Path $layoutPath `
        -Value ($relativeLayout | Microsoft.PowerShell.Utility\ConvertTo-Json -Depth 6 -Compress)
    Assert-BootstrapSelfTestResolverRejected -Message 'a relative data root in the bootstrap layout was accepted'

    [System.IO.File]::Delete($layoutPath)
    [System.IO.Directory]::CreateDirectory($outsideLayoutTarget) | Out-Null
    [void](New-Item -ItemType Junction -Path $layoutPath -Target $outsideLayoutTarget -ErrorAction Stop)
    $layoutRedirectCreated = $true
    Assert-BootstrapSelfTestResolverRejected -Message 'a redirected bootstrap layout was accepted'
    [System.IO.Directory]::Delete($layoutPath, $false)
    $layoutRedirectCreated = $false
    Write-BootstrapSelfTestText -Path $layoutPath -Value $validLayoutText

    $finalEvents = Get-BootstrapSelfTestEventLines
    Assert-BootstrapSelfTest -Condition (
        @($finalEvents | Where-Object { $_ -match '^1\.0\.0\|start\|' }).Count -ge 2 -and
        @($finalEvents | Where-Object { $_ -match '^1\.0\.0\|stop\|' }).Count -ge 2 -and
        @($finalEvents | Where-Object { $_ -match '^2\.0\.0\|start\|' }).Count -eq 10 -and
        @($finalEvents | Where-Object { $_ -match '^2\.0\.0\|stop\|' }).Count -eq 8
    ) -Message 'the lifecycle event trace did not preserve exact release identity'
    Assert-BootstrapSelfTest -Condition (-not [System.IO.File]::Exists($bindingPath)) `
        -Message 'a completed lifecycle left a stale durable binding'
    Assert-BootstrapSelfTest -Condition (-not [System.IO.File]::Exists($expectedExitPath)) `
        -Message 'a completed lifecycle left a stale expected-exit intent'

    [ordered]@{
        protocol = 'DYSON_CONTROL_GAME_BOOTSTRAP_SELFTEST_V1'
        state = 'passed'
        productionSchedulerTouched = $false
        fixedBootstrapEntryValidated = $true
        deploymentSelectedDataRootValidated = $true
        layoutMissingTamperedUnknownRelativeAndRedirectedRejected = $true
        activeReleaseManifestAndInventoryValidated = $true
        upgradeStopStayedBoundToA = $true
        hardExitRecoveryStoppedAThenStartedB = $true
        managedNonZeroExitPersistedAndRecovered = $true
        unexpectedZeroExitPersistedAndRecovered = $true
        expectedExitIntentConsumed = $true
        expectedExitCrashSafetyMatrixValidated = $expectedExitCrashSafetyMatrixValidated
        expectedExitRealProcessRecoveryValidated = $expectedExitRealProcessRecoveryValidated
        malformedExpectedExitRejected = $true
        cleanExitReceiptPersisted = $true
        concurrentStartupStopSerialized = $true
        restartResolvedB = $true
        failedUpgradeRolledBackToA = $true
        corruptMissingEscapedAndRedirectedStateRejected = $true
        unrelatedProcessPreserved = $true
        publicReceiptsWerePathFree = $true
    } | Microsoft.PowerShell.Utility\ConvertTo-Json -Depth 6 -Compress
}
catch {
    $failure = $_
    $diagnostics = @($Error | Select-Object -First 8 | ForEach-Object {
        $message = [string]$_.Exception.Message
        [ordered]@{
            file = [IO.Path]::GetFileName([string]$_.InvocationInfo.ScriptName)
            line = $_.InvocationInfo.ScriptLineNumber
            type = $_.Exception.GetType().Name
            innerType = if ($_.Exception.InnerException) { $_.Exception.InnerException.GetType().Name } else { $null }
            code = if ($message -cmatch '^[A-Z][A-Z0-9_]+$' -or $message -cin @(
                'pending replacement verification failed', 'replacement verification failed',
                'restore verification failed', 'recovery removal verification failed'
            )) { $message } else { 'unclassified' }
        }
    })
    [ordered]@{protocol='DYSON_BOOTSTRAP_SELFTEST_DIAGNOSTIC_V1';errors=$diagnostics;security=$bootstrapFailureSecurity}|ConvertTo-Json -Depth 6 -Compress|Write-Output
    throw $failure
}
finally {
    $cleanupManagedProcess = $null
    $cleanupReleaseProcess = $null
    try {
        if ([System.IO.File]::Exists($managedPidPath)) {
            $cleanupRawPid = [System.IO.File]::ReadAllText(
                $managedPidPath,
                [System.Text.Encoding]::ASCII
            ).Trim()
            $cleanupPid = 0
            if ($cleanupRawPid -match '^[1-9][0-9]{0,9}$' -and
                [int]::TryParse($cleanupRawPid, [ref]$cleanupPid) -and $cleanupPid -gt 0) {
                $candidate = [System.Diagnostics.Process]::GetProcessById($cleanupPid)
                $candidate.Refresh()
                if (-not $candidate.HasExited -and [string]::Equals(
                    [System.IO.Path]::GetFullPath($candidate.MainModule.FileName),
                    [System.IO.Path]::GetFullPath($gameExecutable),
                    [System.StringComparison]::OrdinalIgnoreCase
                )) {
                    $cleanupManagedProcess = $candidate
                    $candidate = $null
                    $searcher = $null
                    $record = $null
                    try {
                        $searcher = [System.Management.ManagementObjectSearcher]::new(
                            'SELECT ProcessId, ParentProcessId, ExecutablePath, CommandLine FROM Win32_Process ' +
                            'WHERE ProcessId = ' + [string]$cleanupPid
                        )
                        $record = @($searcher.Get()) | Select-Object -First 1
                        if ($record -and [int]$record.ParentProcessId -gt 0) {
                            $parent = [System.Diagnostics.Process]::GetProcessById([int]$record.ParentProcessId)
                            $parent.Refresh()
                            $expectedPowerShell = Join-Path $env:SystemRoot `
                                'System32\WindowsPowerShell\v1.0\powershell.exe'
                            if (-not $parent.HasExited -and [string]::Equals(
                                [System.IO.Path]::GetFullPath($parent.MainModule.FileName),
                                [System.IO.Path]::GetFullPath($expectedPowerShell),
                                [System.StringComparison]::OrdinalIgnoreCase
                            ) -and [string]$record.CommandLine -like ('*' + $testRoot + '*')) {
                                $cleanupReleaseProcess = $parent
                                $parent = $null
                            }
                            if ($parent) { $parent.Dispose() }
                        }
                    }
                    catch { }
                    finally {
                        if ($searcher) { $searcher.Dispose() }
                        if ($record) { $record.Dispose() }
                    }
                }
                if ($candidate) { $candidate.Dispose() }
            }
        }
    }
    catch { }
    try { [System.IO.File]::WriteAllText($managedSignal, 'cleanup', [System.Text.Encoding]::ASCII) } catch { }
    try { [System.IO.File]::WriteAllText($foreignSignal, 'cleanup', [System.Text.Encoding]::ASCII) } catch { }
    try { [System.IO.File]::Delete($startDelaySignal) } catch { }
    try { [System.IO.File]::Delete($stopFailureSignal) } catch { }
    if ($cleanupManagedProcess) {
        try {
            if (-not $cleanupManagedProcess.HasExited -and
                -not $cleanupManagedProcess.WaitForExit(5000)) {
                $cleanupManagedProcess.Kill()
                [void]$cleanupManagedProcess.WaitForExit(5000)
            }
        }
        catch { }
        $cleanupManagedProcess.Dispose()
    }
    if ($cleanupReleaseProcess) {
        try {
            if (-not $cleanupReleaseProcess.HasExited -and
                -not $cleanupReleaseProcess.WaitForExit(5000)) {
                $cleanupReleaseProcess.Kill()
                [void]$cleanupReleaseProcess.WaitForExit(5000)
            }
        }
        catch { }
        $cleanupReleaseProcess.Dispose()
    }
    if ($foreignProcess) {
        try {
            if (-not $foreignProcess.HasExited -and -not $foreignProcess.WaitForExit(3000)) { $foreignProcess.Kill() }
        }
        catch { }
        $foreignProcess.Dispose()
    }
    foreach ($child in $children) {
        try {
            if (-not $child.process.HasExited -and -not $child.process.WaitForExit(3000)) { $child.process.Kill() }
        }
        catch { }
        try { $child.process.Dispose() } catch { }
    }
    if ($redirectCreated -and [System.IO.Directory]::Exists($redirectedRelease)) {
        try { [System.IO.Directory]::Delete($redirectedRelease, $false) } catch { }
    }
    if ($layoutRedirectCreated -and [System.IO.Directory]::Exists($layoutPath)) {
        try { [System.IO.Directory]::Delete($layoutPath, $false) } catch { }
    }
    $testRootFull = [System.IO.Path]::GetFullPath($testRoot).TrimEnd('\', '/')
    if ($testRootFull.StartsWith(
        $temporaryBase + [System.IO.Path]::DirectorySeparatorChar,
        [System.StringComparison]::OrdinalIgnoreCase
    ) -and [System.IO.Path]::GetFileName($testRootFull) -match '^dyson-game-bootstrap-selftest-[0-9a-f]{32}$' -and
        [System.IO.Directory]::Exists($testRootFull)) {
        try { [System.IO.Directory]::Delete($testRootFull, $true) } catch { }
    }
}
