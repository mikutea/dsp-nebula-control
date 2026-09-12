[CmdletBinding()]
param(
    [Parameter(Mandatory)]
    [string]$ProjectRoot,
    [Parameter(Mandatory)]
    [string]$AllowedScriptRoot,
    [string]$AllowedTaskScriptRoot,
    [Parameter(Mandatory)]
    [ValidateSet('start', 'save', 'graceful-stop', 'restart')]
    [string]$Action,
    [string]$ServerTaskName = 'Dyson-Nebula-Server',
    [string]$StopTaskName = 'Dyson-Nebula-Stop',
    [ValidateRange(1, 65535)][int]$GamePort = 8469
)

$ErrorActionPreference = 'Stop'
$checks = [System.Collections.Generic.List[object]]::new()
$blockers = [System.Collections.Generic.List[string]]::new()

function Add-Check {
    param(
        [Parameter(Mandatory)][string]$Id,
        [Parameter(Mandatory)][ValidateSet('pass', 'warning', 'block', 'not-applicable')][string]$Status,
        [Parameter(Mandatory)][string]$Message,
        [string]$Blocker
    )

    $checks.Add([ordered]@{ id = $Id; status = $Status; message = $Message })
    if ($Blocker -and -not $blockers.Contains($Blocker)) { $blockers.Add($Blocker) }
}

function Test-PathInsideRoot {
    param(
        [Parameter(Mandatory)][string]$Candidate,
        [Parameter(Mandatory)][string]$Root
    )

    try {
        $resolvedRoot = (Resolve-Path -LiteralPath $Root -ErrorAction Stop).ProviderPath.TrimEnd('\') + '\'
        $resolvedCandidate = (Resolve-Path -LiteralPath $Candidate -ErrorAction Stop).ProviderPath
        return $resolvedCandidate.StartsWith($resolvedRoot, [System.StringComparison]::OrdinalIgnoreCase)
    }
    catch { return $false }
}

function Get-TaskOrNull {
    param([Parameter(Mandatory)][string]$Name)
    try {
        $matches = @(Get-ScheduledTask -TaskName $Name -ErrorAction Stop)
        if ($matches.Count -eq 1) { return $matches[0] }
        return $null
    }
    catch { return $null }
}

function Get-ProcessOwnerName {
    param([Parameter(Mandatory)][int]$ProcessId)
    try {
        $cimProcess = Get-CimInstance Win32_Process -Filter "ProcessId=$ProcessId" -ErrorAction Stop
        $owner = Invoke-CimMethod -InputObject $cimProcess -MethodName GetOwner -ErrorAction Stop
        return [string]$owner.User
    }
    catch { return $null }
}

function Get-FileSha256Hex {
    param([Parameter(Mandatory)][string]$LiteralPath)
    $stream = [System.IO.File]::Open($LiteralPath, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::Read)
    $algorithm = [System.Security.Cryptography.SHA256]::Create()
    try { return ([System.BitConverter]::ToString($algorithm.ComputeHash($stream))).Replace('-', '') }
    finally {
        $algorithm.Dispose()
        $stream.Dispose()
    }
}

function Test-FixedTaskAction {
    param(
        [Parameter(Mandatory)][object]$Task,
        [Parameter(Mandatory)][string]$ExpectedScriptName,
        [Parameter(Mandatory)][string]$ExpectedProjectRoot,
        [Parameter(Mandatory)][string]$ScriptRoot
    )

    try {
        $actions = @($Task.Actions)
        if ($actions.Count -ne 1) { return $false }
        $actionDefinition = $actions[0]
        $expectedPowerShell = [System.IO.Path]::GetFullPath((Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'))
        $actualPowerShell = [System.IO.Path]::GetFullPath([Environment]::ExpandEnvironmentVariables([string]$actionDefinition.Execute))
        if (-not $actualPowerShell.Equals($expectedPowerShell, [System.StringComparison]::OrdinalIgnoreCase)) { return $false }

        $arguments = [string]$actionDefinition.Arguments
        if ($arguments -match '[\r\n\0]') { return $false }
        $argumentPattern = if ($ExpectedScriptName -eq 'Start-DysonServer.ps1') {
            '(?i)^-NoLogo\s+-NoProfile\s+-NonInteractive\s+-ExecutionPolicy\s+Bypass\s+-File\s+"(?<script>[^"]+)"\s+-ProjectRoot\s+"(?<root>[^"]+)"\s+-Ups\s+(?<bounded>\d{1,3})$'
        }
        else {
            '(?i)^-NoLogo\s+-NoProfile\s+-NonInteractive\s+-ExecutionPolicy\s+Bypass\s+-File\s+"(?<script>[^"]+)"\s+-ProjectRoot\s+"(?<root>[^"]+)"\s+-TimeoutSeconds\s+(?<bounded>\d{1,3})$'
        }
        $definitionMatch = [regex]::Match($arguments, $argumentPattern)
        if (-not $definitionMatch.Success) { return $false }
        $boundedValue = [int]$definitionMatch.Groups['bounded'].Value
        if ($ExpectedScriptName -eq 'Start-DysonServer.ps1' -and ($boundedValue -lt 5 -or $boundedValue -gt 240)) { return $false }
        if ($ExpectedScriptName -eq 'Stop-DysonServer.ps1' -and ($boundedValue -lt 10 -or $boundedValue -gt 300)) { return $false }

        $expectedScript = (Resolve-Path -LiteralPath (Join-Path $ScriptRoot $ExpectedScriptName) -ErrorAction Stop).ProviderPath
        $scriptItem = Get-Item -LiteralPath $expectedScript -Force -ErrorAction Stop
        if ($scriptItem.PSIsContainer -or ($scriptItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint)) { return $false }
        $actualScript = (Resolve-Path -LiteralPath $definitionMatch.Groups['script'].Value -ErrorAction Stop).ProviderPath
        $actualProjectRoot = (Resolve-Path -LiteralPath $definitionMatch.Groups['root'].Value -ErrorAction Stop).ProviderPath
        return [string]::Equals($actualScript, $expectedScript, [System.StringComparison]::OrdinalIgnoreCase) -and
            [string]::Equals($actualProjectRoot, $ExpectedProjectRoot, [System.StringComparison]::OrdinalIgnoreCase)
    }
    catch { return $false }
}

$resolvedProjectRoot = $null
try { $resolvedProjectRoot = (Resolve-Path -LiteralPath $ProjectRoot -ErrorAction Stop).ProviderPath }
catch { $resolvedProjectRoot = $null }
$resolvedTaskScriptRoot = $null
try {
    if ([string]::IsNullOrWhiteSpace($AllowedTaskScriptRoot)) {
        throw 'The stable runtime bootstrap root was not configured.'
    }
    $taskScriptRootItem = Get-Item -LiteralPath $AllowedTaskScriptRoot -Force -ErrorAction Stop
    if (-not $taskScriptRootItem.PSIsContainer -or
        ($taskScriptRootItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint)) {
        throw 'The stable runtime bootstrap root is unavailable or redirected.'
    }
    $resolvedTaskScriptRoot = $taskScriptRootItem.FullName
}
catch { $resolvedTaskScriptRoot = $null }

if ($resolvedProjectRoot) {
    Add-Check -Id 'project-root' -Status 'pass' -Message 'The configured project root is available.'
}
else {
    Add-Check -Id 'project-root' -Status 'block' -Message 'The configured project root is unavailable.' -Blocker 'project-root-unavailable'
}

$expectedExecutable = $null
$managedExecutableReady = $false
$managedProcesses = @()
$unverifiedDspProcessCount = 0
$managedProcess = $null
$pidPresent = $false
$pidVerified = $false
$processOwner = $null
$gamePortEvidenceReady = $false
$gamePortListening = $false
$gamePortOwnedByManaged = $false
$savePairReady = $false
$backupPairReady = $false
$backupValidationReason = 'missing-components'

if ($resolvedProjectRoot) {
    $expectedExecutable = [System.IO.Path]::GetFullPath((Join-Path $resolvedProjectRoot 'server\DSPGAME.exe'))
    try {
        $executableItem = Get-Item -LiteralPath $expectedExecutable -Force -ErrorAction Stop
        $managedExecutableReady = -not $executableItem.PSIsContainer -and
            -not ($executableItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint)
    }
    catch { $managedExecutableReady = $false }

    foreach ($candidate in @(Get-Process -Name 'DSPGAME' -ErrorAction SilentlyContinue)) {
        $verifiedManagedProcess = $false
        try {
            if ($candidate.Path -and [System.IO.Path]::GetFullPath($candidate.Path).Equals(
                $expectedExecutable,
                [System.StringComparison]::OrdinalIgnoreCase
            )) {
                $managedProcesses += $candidate
                $verifiedManagedProcess = $true
            }
        }
        catch { }
        if (-not $verifiedManagedProcess) { $unverifiedDspProcessCount += 1 }
    }
    if ($managedProcesses.Count -eq 1) {
        $managedProcess = $managedProcesses[0]
        $processOwner = Get-ProcessOwnerName -ProcessId $managedProcess.Id
    }

    $pidPath = Join-Path $resolvedProjectRoot 'run\dspgame.pid'
    $pidValue = 0
    if (Test-Path -LiteralPath $pidPath -PathType Leaf) {
        $pidPresent = $true
        $pidText = (Get-Content -LiteralPath $pidPath -Raw).Trim()
        if ([int]::TryParse($pidText, [ref]$pidValue)) {
            $pidProcess = Get-Process -Id $pidValue -ErrorAction SilentlyContinue
            if ($pidProcess) {
                try {
                    $pidVerified = $managedProcesses.Count -eq 1 -and
                        $pidProcess.Id -eq $managedProcess.Id -and
                        [System.IO.Path]::GetFullPath($pidProcess.Path).Equals(
                            $expectedExecutable,
                            [System.StringComparison]::OrdinalIgnoreCase
                        )
                }
                catch { $pidVerified = $false }
            }
        }
    }

    try {
        $listeners = @(Get-NetTCPConnection -State Listen -ErrorAction Stop | Where-Object { $_.LocalPort -eq $GamePort })
        $gamePortEvidenceReady = $true
        $gamePortListening = $listeners.Count -gt 0
        if ($managedProcesses.Count -eq 1 -and $gamePortListening) {
            $ownedListeners = @($listeners | Where-Object { [int]$_.OwningProcess -eq [int]$managedProcess.Id })
            $foreignListeners = @($listeners | Where-Object { [int]$_.OwningProcess -ne [int]$managedProcess.Id })
            $gamePortOwnedByManaged = $ownedListeners.Count -gt 0 -and $foreignListeners.Count -eq 0
        }
    }
    catch { $gamePortEvidenceReady = $false }

    $saveRoot = Join-Path $resolvedProjectRoot 'userdata\Save'
    $latestDsv = if (Test-Path -LiteralPath $saveRoot) {
        Get-ChildItem -LiteralPath $saveRoot -Filter '*.dsv' -File -ErrorAction SilentlyContinue |
            Sort-Object LastWriteTimeUtc -Descending | Select-Object -First 1
    } else { $null }
    $latestSidecar = if ($latestDsv) {
        Get-Item -LiteralPath (Join-Path $saveRoot ($latestDsv.BaseName + '.server')) -ErrorAction SilentlyContinue
    } else { $null }
    $savePairReady = [bool]($latestDsv -and $latestSidecar)

    if ($Action -ne 'start') {
    $backupRoot = Join-Path $resolvedProjectRoot 'backups\saves'
    $latestBackup = if (Test-Path -LiteralPath $backupRoot) {
        Get-ChildItem -LiteralPath $backupRoot -Directory -ErrorAction SilentlyContinue |
            Sort-Object LastWriteTimeUtc -Descending | Select-Object -First 1
    } else { $null }
    $backupDsv = if ($latestBackup) {
        Get-ChildItem -LiteralPath $latestBackup.FullName -Filter '*.dsv' -File -ErrorAction SilentlyContinue | Select-Object -First 1
    } else { $null }
    $backupSidecar = if ($latestBackup -and $backupDsv) {
        Get-Item -LiteralPath (Join-Path $latestBackup.FullName ($backupDsv.BaseName + '.server')) -ErrorAction SilentlyContinue
    } else { $null }
    $backupManifest = if ($latestBackup) {
        Get-Item -LiteralPath (Join-Path $latestBackup.FullName 'manifest.json') -ErrorAction SilentlyContinue
    } else { $null }
    if ($backupDsv -and $backupSidecar -and $backupManifest) {
        $backupValidationPhase = 'read'
        try {
            $manifest = Get-Content -LiteralPath $backupManifest.FullName -Raw -ErrorAction Stop | ConvertFrom-Json -ErrorAction Stop
            $backupValidationPhase = 'identity'
            $manifestFiles = @($manifest.files)
            $expectedFiles = @($backupDsv, $backupSidecar)
            $manifestSchemaVersion = [int]($manifest.schemaVersion)
            $manifestSaveName = [string]($manifest.saveName)
            $manifestValid = $manifestSchemaVersion -eq 1 -and
                [string]::Equals($manifestSaveName, $backupDsv.BaseName, [System.StringComparison]::Ordinal) -and
                $manifestFiles.Count -eq 2
            if (-not $manifestValid) { $backupValidationReason = 'manifest-identity' }
            foreach ($expectedFile in $expectedFiles) {
                $backupValidationPhase = 'entry'
                $entry = @($manifestFiles | Where-Object {
                    [string]::Equals([string]($_.name), $expectedFile.Name, [System.StringComparison]::Ordinal)
                })
                if ($entry.Count -ne 1) {
                    $manifestValid = $false
                    $backupValidationReason = 'manifest-entry'
                    break
                }
                $entryBytes = [int64]($entry[0].bytes)
                $entryHash = [string]($entry[0].sha256)
                if ($entryBytes -ne [int64]$expectedFile.Length -or $entryHash -notmatch '^[A-Fa-f0-9]{64}$') {
                    $manifestValid = $false
                    $backupValidationReason = 'manifest-metadata'
                    break
                }
                $backupValidationPhase = 'hash'
                $actualHash = Get-FileSha256Hex -LiteralPath $expectedFile.FullName
                $backupValidationPhase = 'hash-compare'
                if (-not [string]::Equals($entryHash, $actualHash, [System.StringComparison]::OrdinalIgnoreCase)) {
                    $manifestValid = $false
                    $backupValidationReason = 'hash-mismatch'
                    break
                }
            }
            $backupPairReady = [bool]$manifestValid
            if ($backupPairReady) { $backupValidationReason = 'verified' }
        }
        catch {
            $backupPairReady = $false
            $backupValidationReason = 'error-' + $backupValidationPhase
        }
    }
    }
}

if ($managedExecutableReady) {
    Add-Check -Id 'managed-executable' -Status 'pass' -Message 'The fixed managed DSP executable is available and not redirected.'
}
else {
    Add-Check -Id 'managed-executable' -Status 'block' -Message 'The fixed managed DSP executable is unavailable or redirected.' -Blocker 'managed-executable-unavailable'
}

if ($Action -eq 'start') {
    if ($unverifiedDspProcessCount -gt 0) {
        Add-Check -Id 'managed-process' -Status 'block' -Message 'A DSP process exists but its executable identity could not be verified.' -Blocker 'managed-process-unverified'
    }
    elseif ($managedProcesses.Count -eq 0) {
        Add-Check -Id 'managed-process' -Status 'pass' -Message 'No process using the fixed managed executable is running.'
    }
    else {
        Add-Check -Id 'managed-process' -Status 'block' -Message 'The managed DSP process is already running; a second instance will not be started.' -Blocker 'server-already-running'
    }

    if (-not $pidPresent) {
        Add-Check -Id 'pid-file' -Status 'pass' -Message 'No active managed PID file is present.'
    }
    elseif ($pidVerified) {
        Add-Check -Id 'pid-file' -Status 'block' -Message 'The managed PID file identifies an already-running server.' -Blocker 'server-already-running'
    }
    else {
        Add-Check -Id 'pid-file' -Status 'block' -Message 'The managed PID file is stale, malformed, or points to an unverified process.' -Blocker 'pid-file-unverified'
    }

    if (-not $gamePortEvidenceReady) {
        Add-Check -Id 'game-port' -Status 'block' -Message 'The game-port listener state could not be verified.' -Blocker 'game-port-unverified'
    }
    elseif ($gamePortListening) {
        Add-Check -Id 'game-port' -Status 'block' -Message 'The configured game port is already listening; startup is blocked.' -Blocker 'game-port-listening'
    }
    else {
        Add-Check -Id 'game-port' -Status 'pass' -Message 'The configured game port has no listener.'
    }
}
else {
    if ($managedProcesses.Count -eq 1 -and $unverifiedDspProcessCount -eq 0) {
        Add-Check -Id 'managed-process' -Status 'pass' -Message 'The managed DSP process matches the configured executable.'
    }
    else {
        Add-Check -Id 'managed-process' -Status 'block' -Message 'Exactly one managed DSP process could not be verified.' -Blocker 'managed-process-unverified'
    }

    if ($pidVerified) {
        Add-Check -Id 'pid-file' -Status 'pass' -Message 'The managed PID file points to the verified running process.'
    }
    else {
        Add-Check -Id 'pid-file' -Status 'block' -Message 'The managed PID file is missing, invalid, or stale.' -Blocker 'pid-file-unverified'
    }

    if ($gamePortEvidenceReady -and $gamePortListening -and $gamePortOwnedByManaged) {
        Add-Check -Id 'game-port' -Status 'pass' -Message 'The configured game port is owned by the managed DSP process.'
    }
    else {
        Add-Check -Id 'game-port' -Status 'block' -Message 'The configured game port is not exclusively owned by the managed DSP process.' -Blocker 'game-port-unverified'
    }
}

if ($savePairReady) {
    Add-Check -Id 'save-pair' -Status 'pass' -Message 'A matching .dsv and .server save pair is present.'
}
else {
    Add-Check -Id 'save-pair' -Status 'block' -Message 'A matching .dsv and .server save pair is required.' -Blocker 'save-pair-incomplete'
}

if ($Action -eq 'start') {
    Add-Check -Id 'backup-pair' -Status 'not-applicable' -Message 'Starting does not modify the current paired save.'
}
elseif ($backupPairReady) {
    Add-Check -Id 'backup-pair' -Status 'pass' -Message 'The latest paired backup matches its hash manifest.'
}
else {
    $backupFailureMessages = @{
        'missing-components' = 'The paired backup or its hash manifest is missing.'
        'manifest-identity' = 'The backup manifest schema or save identity is invalid.'
        'manifest-entry' = 'The backup manifest does not describe exactly the expected save pair.'
        'manifest-metadata' = 'The backup manifest contains invalid size or hash metadata.'
        'hash-mismatch' = 'The backup files do not match the recorded hashes.'
        'error-read' = 'The backup hash manifest could not be read.'
        'error-identity' = 'The backup manifest identity could not be validated.'
        'error-entry' = 'The backup manifest entries could not be validated.'
        'error-hash' = 'The backup file hashes could not be calculated.'
        'error-hash-compare' = 'The backup file hashes could not be compared.'
    }
    Add-Check -Id 'backup-pair' -Status 'block' -Message $backupFailureMessages[$backupValidationReason] -Blocker 'backup-pair-unverified'
}

$serverTask = Get-TaskOrNull -Name $ServerTaskName
$stopTask = Get-TaskOrNull -Name $StopTaskName
$needsStartTask = $Action -in @('start', 'restart')
$needsStopTask = $Action -in @('graceful-stop', 'restart')

if ($needsStartTask) {
    if (-not $serverTask) { Add-Check -Id 'server-task' -Status 'block' -Message 'The fixed server start task is missing.' -Blocker 'server-task-missing' }
    elseif ($serverTask.State.ToString() -eq 'Disabled') { Add-Check -Id 'server-task' -Status 'block' -Message 'The fixed server start task is disabled.' -Blocker 'server-task-disabled' }
    elseif ($Action -eq 'start' -and $serverTask.State.ToString() -ne 'Ready') { Add-Check -Id 'server-task' -Status 'block' -Message 'The fixed server start task is not ready while the runtime is stopped.' -Blocker 'server-task-not-ready' }
    else { Add-Check -Id 'server-task' -Status 'pass' -Message 'The fixed server start task exists and is enabled.' }
}
else { Add-Check -Id 'server-task' -Status 'not-applicable' -Message 'The server start task is not used by this preview.' }

if ($needsStartTask -and $serverTask) {
    $serverTaskUser = [string]$serverTask.Principal.UserId
    $serverTaskInteractive = $serverTask.Principal.LogonType.ToString() -eq 'Interactive'
    $serverPrincipalMatches = $serverTaskUser.Length -gt 0
    if ($Action -eq 'restart' -and $processOwner) {
        $serverPrincipalMatches = [string]::Equals(
            ($serverTaskUser -split '\\')[-1],
            $processOwner,
            [System.StringComparison]::OrdinalIgnoreCase
        )
    }
    if (-not $serverTaskInteractive) {
        Add-Check -Id 'server-task-principal' -Status 'block' -Message 'The server start task is not configured for an interactive session.' -Blocker 'server-task-not-interactive'
    }
    elseif (-not $serverPrincipalMatches) {
        Add-Check -Id 'server-task-principal' -Status 'block' -Message 'The server start task principal is missing or does not match the managed session.' -Blocker 'server-task-principal-mismatch'
    }
    else { Add-Check -Id 'server-task-principal' -Status 'pass' -Message 'The server start task uses the verified interactive principal.' }
}
else { Add-Check -Id 'server-task-principal' -Status 'not-applicable' -Message 'Start-task principal validation is not used by this preview.' }

if ($needsStartTask -and $serverTask -and $resolvedProjectRoot -and $resolvedTaskScriptRoot -and
    (Test-FixedTaskAction -Task $serverTask -ExpectedScriptName 'Start-DysonServer.ps1' -ExpectedProjectRoot $resolvedProjectRoot -ScriptRoot $resolvedTaskScriptRoot)) {
    Add-Check -Id 'server-task-action' -Status 'pass' -Message 'The server task invokes the exact allowlisted start script and project root.'
}
elseif ($needsStartTask) {
    Add-Check -Id 'server-task-action' -Status 'block' -Message 'The server task action does not match the fixed allowlisted start definition.' -Blocker 'server-task-action-unallowlisted'
}
else { Add-Check -Id 'server-task-action' -Status 'not-applicable' -Message 'Start-task action validation is not used by this preview.' }

if ($needsStopTask) {
    if ($stopTask) { Add-Check -Id 'stop-task' -Status 'pass' -Message 'The graceful-stop task exists.' }
    else { Add-Check -Id 'stop-task' -Status 'block' -Message 'The graceful-stop task is missing.' -Blocker 'stop-task-missing' }
}
else { Add-Check -Id 'stop-task' -Status 'not-applicable' -Message 'The graceful-stop task is not used by this preview.' }

$principalMatches = $false
$interactivePrincipal = $false
if ($needsStopTask -and $stopTask) {
    $taskPrincipal = ([string]$stopTask.Principal.UserId -split '\\')[-1]
    $principalMatches = $processOwner -and [string]::Equals($taskPrincipal, $processOwner, [System.StringComparison]::OrdinalIgnoreCase)
    $interactivePrincipal = $stopTask.Principal.LogonType.ToString() -eq 'Interactive'

    if (-not $interactivePrincipal) {
        Add-Check -Id 'stop-task-principal' -Status 'block' -Message 'The stop task is not configured for the game interactive session.' -Blocker 'stop-task-not-interactive'
    }
    elseif (-not $principalMatches) {
        Add-Check -Id 'stop-task-principal' -Status 'block' -Message 'The stop task principal does not match the game process owner.' -Blocker 'stop-task-principal-mismatch'
    }
    else { Add-Check -Id 'stop-task-principal' -Status 'pass' -Message 'The stop task principal matches the managed game session.' }
}
else { Add-Check -Id 'stop-task-principal' -Status 'not-applicable' -Message 'Stop-task principal validation is not used by this preview.' }

$stopActionAllowlisted = $false
if ($needsStopTask -and $stopTask) {
    $stopActionAllowlisted = $resolvedProjectRoot -and $resolvedTaskScriptRoot -and
        (Test-FixedTaskAction -Task $stopTask -ExpectedScriptName 'Stop-DysonServer.ps1' -ExpectedProjectRoot $resolvedProjectRoot -ScriptRoot $resolvedTaskScriptRoot)

    if ($stopActionAllowlisted) { Add-Check -Id 'stop-task-action' -Status 'pass' -Message 'The stop task invokes the exact allowlisted stop script and project root.' }
    else { Add-Check -Id 'stop-task-action' -Status 'block' -Message 'The stop task action does not match the fixed allowlisted stop definition.' -Blocker 'stop-task-action-unallowlisted' }
}
else { Add-Check -Id 'stop-task-action' -Status 'not-applicable' -Message 'Stop-task action validation is not used by this preview.' }

if ($needsStopTask -and $stopTask) {
    try {
        $stopInfo = Get-ScheduledTaskInfo -TaskName $StopTaskName -ErrorAction Stop
        if ([int]$stopInfo.LastTaskResult -eq 0) { Add-Check -Id 'stop-task-result' -Status 'pass' -Message 'The stop task last returned success.' }
        else { Add-Check -Id 'stop-task-result' -Status 'block' -Message 'The stop task last returned a non-zero result.' -Blocker 'stop-task-last-result-failed' }
    }
    catch { Add-Check -Id 'stop-task-result' -Status 'block' -Message 'The stop task result could not be read.' -Blocker 'stop-task-last-result-failed' }
}
else { Add-Check -Id 'stop-task-result' -Status 'not-applicable' -Message 'Stop-task result validation is not used by this preview.' }

$needsScheduledTask = $needsStartTask -or $needsStopTask
$receiptChannelReady = $false
if ($needsScheduledTask) {
    try {
        $receiptScript = (Resolve-Path -LiteralPath (Join-Path $AllowedScriptRoot 'Invoke-DysonScheduledTask.ps1') -ErrorAction Stop).ProviderPath
        $receiptItem = Get-Item -LiteralPath $receiptScript -Force -ErrorAction Stop
        $receiptText = Get-Content -LiteralPath $receiptScript -Raw -ErrorAction Stop
        $receiptChannelReady = -not $receiptItem.PSIsContainer -and
            -not ($receiptItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -and
            $receiptText -match 'DYSON_CONTROL_TASK_RECEIPT_V1'
    }
    catch { $receiptChannelReady = $false }

    $taskLog = Get-WinEvent -ListLog 'Microsoft-Windows-TaskScheduler/Operational' -ErrorAction SilentlyContinue
    if ($taskLog -and $taskLog.IsEnabled) { Add-Check -Id 'task-history' -Status 'pass' -Message 'Task Scheduler operational history is enabled.' }
    else { Add-Check -Id 'task-history' -Status 'warning' -Message 'Task Scheduler history is disabled; durable receipts remain mandatory.' }

    if ($receiptChannelReady) { Add-Check -Id 'receipt-channel' -Status 'pass' -Message 'The fixed task dispatcher declares a durable lifecycle receipt.' }
    else { Add-Check -Id 'receipt-channel' -Status 'block' -Message 'The fixed durable lifecycle receipt dispatcher is unavailable.' -Blocker 'receipt-channel-missing' }
}
else {
    Add-Check -Id 'task-history' -Status 'not-applicable' -Message 'Task history is not used by this preview.'
    Add-Check -Id 'receipt-channel' -Status 'not-applicable' -Message 'A scheduled-task receipt is not used by this preview.'
}

if ($Action -eq 'start') {
    Add-Check -Id 'save-trigger' -Status 'not-applicable' -Message 'Starting a stopped server does not request an in-game save.'
}
else {
    Add-Check -Id 'save-trigger' -Status 'block' -Message 'A separately verifiable save acknowledgement is not installed.' -Blocker 'save-trigger-unverified'
}
Add-Check -Id 'execution-lock' -Status 'block' -Message 'Lifecycle execution is disabled; this endpoint is dry-run only.' -Blocker 'execution-disabled'

$rollbackStrategy = 'no-op'
$rollbackReady = $true
$rollbackSummary = 'Dry-run mode changes no process or file.'
if ($Action -eq 'save') {
    $rollbackStrategy = 'paired-save-backup'
    $rollbackReady = $backupPairReady
    $rollbackSummary = 'A fresh paired-save backup is required before save activation.'
}
elseif ($Action -eq 'start') {
    $rollbackStrategy = 'no-op'
    $rollbackReady = $true
    $rollbackSummary = 'Start does not modify the installation or paired save; failed health verification requires runtime reconciliation, not an automatic stop.'
}
elseif ($Action -eq 'graceful-stop') {
    $rollbackStrategy = 'restart-from-same-save'
    $rollbackReady = $savePairReady
    $rollbackSummary = 'Rollback starts the same verified save pair without modifying it.'
}
elseif ($Action -eq 'restart') {
    $rollbackStrategy = 'paired-save-backup'
    $rollbackReady = $backupPairReady
    $rollbackSummary = 'Restart rollback requires a verified paired backup and manifest.'
}

[ordered]@{
    collectedAt = (Get-Date).ToUniversalTime().ToString('o')
    action = $Action
    mode = 'dry-run'
    allowed = $false
    executionEnabled = $false
    checks = @($checks)
    blockers = @($blockers)
    rollback = [ordered]@{
        strategy = $rollbackStrategy
        ready = [bool]$rollbackReady
        summary = $rollbackSummary
    }
} | ConvertTo-Json -Depth 7 -Compress
