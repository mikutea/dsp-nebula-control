[CmdletBinding()]
param(
    [Parameter(Mandatory)]
    [string]$ProjectRoot,
    [Parameter(Mandatory)]
    [string]$AllowedScriptRoot,
    [Parameter(Mandatory)]
    [ValidateSet('save', 'graceful-stop', 'restart')]
    [string]$Action,
    [string]$ServerTaskName = 'Dyson-Nebula-Server',
    [string]$StopTaskName = 'Dyson-Nebula-Stop'
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
    try { return Get-ScheduledTask -TaskName $Name -ErrorAction Stop }
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

$resolvedProjectRoot = $null
try { $resolvedProjectRoot = (Resolve-Path -LiteralPath $ProjectRoot -ErrorAction Stop).ProviderPath }
catch { $resolvedProjectRoot = $null }

if ($resolvedProjectRoot) {
    Add-Check -Id 'project-root' -Status 'pass' -Message 'The configured project root is available.'
}
else {
    Add-Check -Id 'project-root' -Status 'block' -Message 'The configured project root is unavailable.' -Blocker 'project-root-unavailable'
}

$managedProcess = $null
$managedProcessVerified = $false
$pidVerified = $false
$processOwner = $null
$savePairReady = $false
$backupPairReady = $false
$backupValidationReason = 'missing-components'

if ($resolvedProjectRoot) {
    $expectedExecutable = Join-Path $resolvedProjectRoot 'server\DSPGAME.exe'
    $pidPath = Join-Path $resolvedProjectRoot 'run\dspgame.pid'
    $pidValue = 0
    if (Test-Path -LiteralPath $pidPath -PathType Leaf) {
        $pidText = (Get-Content -LiteralPath $pidPath -Raw).Trim()
        if ([int]::TryParse($pidText, [ref]$pidValue)) {
            $managedProcess = Get-Process -Id $pidValue -ErrorAction SilentlyContinue
            $pidVerified = $null -ne $managedProcess
        }
    }

    if ($managedProcess) {
        try {
            $managedProcessVerified = $managedProcess.Name -eq 'DSPGAME' -and
                [string]::Equals($managedProcess.Path, $expectedExecutable, [System.StringComparison]::OrdinalIgnoreCase)
        }
        catch { $managedProcessVerified = $false }
        $processOwner = Get-ProcessOwnerName -ProcessId $managedProcess.Id
    }

    $saveRoot = Join-Path $resolvedProjectRoot 'userdata\Save'
    $latestDsv = if (Test-Path -LiteralPath $saveRoot) {
        Get-ChildItem -LiteralPath $saveRoot -Filter '*.dsv' -File -ErrorAction SilentlyContinue |
            Sort-Object LastWriteTimeUtc -Descending | Select-Object -First 1
    } else { $null }
    $latestSidecar = if ($latestDsv) {
        Get-Item -LiteralPath (Join-Path $saveRoot ($latestDsv.BaseName + '.server')) -ErrorAction SilentlyContinue
    } else { $null }
    $savePairReady = [bool]($latestDsv -and $latestSidecar)

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

if ($managedProcessVerified) {
    Add-Check -Id 'managed-process' -Status 'pass' -Message 'The managed DSP process matches the configured executable.'
}
else {
    Add-Check -Id 'managed-process' -Status 'block' -Message 'The managed DSP process could not be verified.' -Blocker 'managed-process-unverified'
}

if ($pidVerified) {
    Add-Check -Id 'pid-file' -Status 'pass' -Message 'The managed PID file points to a running process.'
}
else {
    Add-Check -Id 'pid-file' -Status 'block' -Message 'The managed PID file is missing, invalid, or stale.' -Blocker 'pid-file-unverified'
}

if ($savePairReady) {
    Add-Check -Id 'save-pair' -Status 'pass' -Message 'A matching .dsv and .server save pair is present.'
}
else {
    Add-Check -Id 'save-pair' -Status 'block' -Message 'A matching .dsv and .server save pair is required.' -Blocker 'save-pair-incomplete'
}

if ($backupPairReady) {
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
$needsStopTask = $Action -in @('graceful-stop', 'restart')

if ($Action -eq 'restart') {
    if ($serverTask) { Add-Check -Id 'server-task' -Status 'pass' -Message 'The allowlisted server start task exists.' }
    else { Add-Check -Id 'server-task' -Status 'block' -Message 'The allowlisted server start task is missing.' -Blocker 'server-task-missing' }
}
else { Add-Check -Id 'server-task' -Status 'not-applicable' -Message 'The server start task is not used by this preview.' }

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
$receiptChannelReady = $false
if ($needsStopTask -and $stopTask) {
    $actionDefinition = @($stopTask.Actions | Select-Object -First 1)[0]
    if ($actionDefinition -and $actionDefinition.Execute -match '(?i)powershell\.exe$') {
        $fileMatch = [regex]::Match([string]$actionDefinition.Arguments, '(?i)(?:^|\s)-File\s+(?:"(?<path>[^"]+)"|(?<path>\S+))')
        if ($fileMatch.Success) {
            $actionScriptPath = $fileMatch.Groups['path'].Value
            $stopActionAllowlisted = Test-PathInsideRoot -Candidate $actionScriptPath -Root $AllowedScriptRoot
            if ($stopActionAllowlisted) {
                try {
                    $actionScriptText = Get-Content -LiteralPath $actionScriptPath -Raw -ErrorAction Stop
                    $receiptChannelReady = $actionScriptText -match 'DYSON_CONTROL_RECEIPT_V1'
                }
                catch { $receiptChannelReady = $false }
            }
        }
    }

    if ($stopActionAllowlisted) { Add-Check -Id 'stop-task-action' -Status 'pass' -Message 'The stop task uses an allowlisted local action script.' }
    else { Add-Check -Id 'stop-task-action' -Status 'block' -Message 'The stop task action is outside the allowlisted script root.' -Blocker 'stop-task-action-unallowlisted' }
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

if ($needsStopTask) {
    $taskLog = Get-WinEvent -ListLog 'Microsoft-Windows-TaskScheduler/Operational' -ErrorAction SilentlyContinue
    if ($taskLog -and $taskLog.IsEnabled) { Add-Check -Id 'task-history' -Status 'pass' -Message 'Task Scheduler operational history is enabled.' }
    else { Add-Check -Id 'task-history' -Status 'warning' -Message 'Task Scheduler history is disabled; durable receipts remain mandatory.' }

    if ($receiptChannelReady) { Add-Check -Id 'receipt-channel' -Status 'pass' -Message 'The stop adapter declares a durable lifecycle receipt.' }
    else { Add-Check -Id 'receipt-channel' -Status 'block' -Message 'A durable lifecycle receipt channel is not installed.' -Blocker 'receipt-channel-missing' }
}
else {
    Add-Check -Id 'task-history' -Status 'not-applicable' -Message 'Task history is not used by this preview.'
    Add-Check -Id 'receipt-channel' -Status 'not-applicable' -Message 'A stop receipt is not used by this preview.'
}

Add-Check -Id 'save-trigger' -Status 'block' -Message 'A separately verifiable save acknowledgement is not installed.' -Blocker 'save-trigger-unverified'
Add-Check -Id 'execution-lock' -Status 'block' -Message 'Lifecycle execution is disabled; this endpoint is dry-run only.' -Blocker 'execution-disabled'

$rollbackStrategy = 'no-op'
$rollbackReady = $true
$rollbackSummary = 'Dry-run mode changes no process or file.'
if ($Action -eq 'save') {
    $rollbackStrategy = 'paired-save-backup'
    $rollbackReady = $backupPairReady
    $rollbackSummary = 'A fresh paired-save backup is required before save activation.'
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
