[CmdletBinding()]
param(
    [Parameter(Mandatory)]
    [string]$ProjectRoot,
    [ValidateRange(1, 65535)]
    [int]$GamePort = 8469,
    [ValidateRange(100, 5000)]
    [int]$CpuSampleMilliseconds = 500,
    [string]$ServerTaskName = 'Dyson-Nebula-Server',
    [string]$StopTaskName = 'Dyson-Nebula-Stop',
    [string]$StorageTaskName = 'Dyson-StorageMapping'
)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)

function Convert-ToIsoUtc {
    param([AllowNull()][datetime]$Value)
    if ($null -eq $Value -or $Value.Year -lt 2000) { return $null }
    return $Value.ToUniversalTime().ToString('o')
}

function Get-SafeProcess {
    param([Parameter(Mandatory)][string]$ExpectedPath)

    $expectedFullPath = [System.IO.Path]::GetFullPath($ExpectedPath)
    foreach ($candidate in @(Get-Process -Name 'DSPGAME' -ErrorAction SilentlyContinue)) {
        try {
            if ($candidate.Path -and [System.IO.Path]::GetFullPath($candidate.Path).Equals(
                $expectedFullPath,
                [System.StringComparison]::OrdinalIgnoreCase
            )) {
                return $candidate
            }
        }
        catch {
            # A protected or exiting process is not a valid managed instance.
        }
    }
    return $null
}

function Get-TaskSummary {
    param([Parameter(Mandatory)][string]$TaskName)

    try {
        $task = Get-ScheduledTask -TaskName $TaskName -ErrorAction Stop | Select-Object -First 1
        $info = Get-ScheduledTaskInfo -InputObject $task -ErrorAction Stop
        $state = $task.State.ToString().ToLowerInvariant()
        if ($state -notin @('running', 'ready', 'disabled', 'queued', 'unknown')) { $state = 'unknown' }
        return [ordered]@{
            state = $state
            lastResult = [long]$info.LastTaskResult
            lastRunAt = Convert-ToIsoUtc -Value $info.LastRunTime
        }
    }
    catch {
        return [ordered]@{ state = $null; lastResult = $null; lastRunAt = $null }
    }
}

function Get-LastMatchingValue {
    param(
        [Parameter(Mandatory)][AllowEmptyCollection()][string[]]$Lines,
        [Parameter(Mandatory)][string]$Pattern
    )

    for ($index = $Lines.Count - 1; $index -ge 0; $index--) {
        if ($Lines[$index] -match $Pattern) { return $Matches['value'] }
    }
    return $null
}

function Get-SafeSaveName {
    param([AllowNull()][string]$Candidate)
    if ([string]::IsNullOrWhiteSpace($Candidate)) { return $null }

    $name = $Candidate.Trim()
    if ($name.EndsWith('.dsv', [System.StringComparison]::OrdinalIgnoreCase)) {
        $name = $name.Substring(0, $name.Length - 4)
    }
    if ([string]::IsNullOrWhiteSpace($name)) { return $null }
    if ([System.IO.Path]::GetFileName($name) -ne $name) { return $null }
    if ($name.IndexOfAny([System.IO.Path]::GetInvalidFileNameChars()) -ge 0) { return $null }
    return $name
}

$resolvedProjectRoot = (Resolve-Path -LiteralPath $ProjectRoot -ErrorAction Stop).ProviderPath
$expectedExecutable = Join-Path $resolvedProjectRoot 'server\DSPGAME.exe'
$process = Get-SafeProcess -ExpectedPath $expectedExecutable

$processCoresUsed = $null
if ($process -and $null -ne $process.CPU) {
    $cpuStart = [double]$process.CPU
    $timer = [System.Diagnostics.Stopwatch]::StartNew()
    Start-Sleep -Milliseconds $CpuSampleMilliseconds
    $freshProcess = Get-Process -Id $process.Id -ErrorAction SilentlyContinue
    $timer.Stop()
    if ($freshProcess) {
        $process = $freshProcess
        if ($null -ne $freshProcess.CPU -and $timer.Elapsed.TotalSeconds -gt 0) {
            $processCoresUsed = [math]::Round(([double]$freshProcess.CPU - $cpuStart) / $timer.Elapsed.TotalSeconds, 2)
        }
    }
    else {
        $process = $null
    }
}

$targetUps = $null
if ($process) {
    try {
        $commandLine = (Get-CimInstance Win32_Process -Filter "ProcessId = $($process.Id)" -ErrorAction Stop).CommandLine
        if ($commandLine -match '(?:^|\s)"?-ups"?\s+"?(?<ups>\d+)"?(?:\s|$)') { $targetUps = [int]$Matches['ups'] }
    }
    catch {
        # Process state remains useful when command-line inspection is unavailable.
    }
}

$computerSystem = Get-CimInstance Win32_ComputerSystem -ErrorAction SilentlyContinue
$operatingSystem = Get-CimInstance Win32_OperatingSystem -ErrorAction SilentlyContinue
$logicalProcessors = if ($computerSystem -and [int]$computerSystem.NumberOfLogicalProcessors -gt 0) {
    [int]$computerSystem.NumberOfLogicalProcessors
} else { [Environment]::ProcessorCount }
$processorGroups = if ($logicalProcessors -gt 0) { [int][math]::Ceiling($logicalProcessors / 64.0) } else { $null }
$hostCpuValues = @(Get-CimInstance Win32_Processor -ErrorAction SilentlyContinue | ForEach-Object { $_.LoadPercentage } | Where-Object { $null -ne $_ })
$hostCpuPercent = if ($hostCpuValues.Count -gt 0) {
    [math]::Round((($hostCpuValues | Measure-Object -Average).Average), 1)
} else { $null }

$logPath = Join-Path $resolvedProjectRoot 'server\BepInEx\LogOutput.log'
$logLines = if (Test-Path -LiteralPath $logPath) {
    @(Get-Content -LiteralPath $logPath -Tail 5000 -ErrorAction SilentlyContinue)
} else { @() }
$dspVersion = Get-LastMatchingValue -Lines $logLines -Pattern 'Loading game version\s+(?<value>\d+(?:\.\d+){2,3})'
$nebulaVersion = Get-LastMatchingValue -Lines $logLines -Pattern 'Loading \[NebulaMultiplayerMod\s+(?<value>\d+(?:\.\d+){2,3})\]'
$bepInExVersion = Get-LastMatchingValue -Lines $logLines -Pattern 'BepInEx\s+(?<value>\d+(?:\.\d+){2,3})\s+-\s+DSPGAME'
$gameLoaded = if ($logLines.Count -gt 0) { [bool]($logLines -match '==== Game load completed ====') } else { $null }
$versionWarnings = @()
if ($logLines -match 'targets a wrong version of BepInEx') { $versionWarnings += 'mod-bepinex-target-mismatch' }
if ($false -eq $gameLoaded) { $versionWarnings += 'game-load-incomplete' }
$compatible = if ($null -eq $gameLoaded -or -not $dspVersion -or -not $nebulaVersion -or -not $bepInExVersion) {
    $null
} else {
    [bool]($gameLoaded -and $versionWarnings.Count -eq 0)
}

$activeSaveName = Get-SafeSaveName -Candidate (Get-LastMatchingValue -Lines $logLines -Pattern 'Starting dedicated server, loading save\s*:\s*(?<value>.+?)\s*$')
$saveRoot = Join-Path $resolvedProjectRoot 'userdata\Save'
$latestDsv = if (Test-Path -LiteralPath $saveRoot) {
    Get-ChildItem -LiteralPath $saveRoot -Filter '*.dsv' -File -ErrorAction SilentlyContinue |
        Sort-Object LastWriteTimeUtc -Descending | Select-Object -First 1
} else { $null }
if (-not $activeSaveName -and $latestDsv) { $activeSaveName = $latestDsv.BaseName }

$activeDsv = if ($activeSaveName) {
    Get-Item -LiteralPath (Join-Path $saveRoot ($activeSaveName + '.dsv')) -ErrorAction SilentlyContinue
} else { $null }
$activeSidecar = if ($activeSaveName) {
    Get-Item -LiteralPath (Join-Path $saveRoot ($activeSaveName + '.server')) -ErrorAction SilentlyContinue
} else { $null }
$saveLastWrite = @($activeDsv, $activeSidecar) | Where-Object { $null -ne $_ } |
    Sort-Object LastWriteTimeUtc -Descending | Select-Object -First 1

$backupRoot = Join-Path $resolvedProjectRoot 'backups\saves'
$latestBackup = if (Test-Path -LiteralPath $backupRoot) {
    Get-ChildItem -LiteralPath $backupRoot -Directory -ErrorAction SilentlyContinue |
        Sort-Object LastWriteTimeUtc -Descending | Select-Object -First 1
} else { $null }
$backupManifest = if ($latestBackup) {
    Get-Item -LiteralPath (Join-Path $latestBackup.FullName 'manifest.json') -ErrorAction SilentlyContinue
} else { $null }
$backupDsv = if ($latestBackup) {
    Get-ChildItem -LiteralPath $latestBackup.FullName -Filter '*.dsv' -File -ErrorAction SilentlyContinue | Select-Object -First 1
} else { $null }
$backupSidecar = if ($latestBackup -and $backupDsv) {
    Get-Item -LiteralPath (Join-Path $latestBackup.FullName ($backupDsv.BaseName + '.server')) -ErrorAction SilentlyContinue
} else { $null }

$gamePortListening = $false
try {
    $gamePortListening = [bool](Get-NetTCPConnection -State Listen -LocalPort $GamePort -ErrorAction Stop | Select-Object -First 1)
}
catch {
    $gamePortListening = $false
}

$globalMappingAvailable = $null
try {
    $projectDrive = [System.IO.Path]::GetPathRoot($resolvedProjectRoot).TrimEnd('\')
    if ($projectDrive -match '^[A-Za-z]:$') {
        $mapping = Get-SmbGlobalMapping -LocalPath $projectDrive -ErrorAction SilentlyContinue | Select-Object -First 1
        if ($mapping) { $globalMappingAvailable = [bool]($mapping.Status -eq 'OK') }
    }
}
catch {
    $globalMappingAvailable = $null
}

$startedAt = if ($process) {
    try { Convert-ToIsoUtc -Value $process.StartTime } catch { $null }
} else { $null }
$uptimeSeconds = if ($process -and $startedAt) {
    [long][math]::Max(0, ((Get-Date).ToUniversalTime() - ([datetime]$startedAt).ToUniversalTime()).TotalSeconds)
} else { $null }
$processPriority = if ($process) {
    try { $process.PriorityClass.ToString() } catch { $null }
} else { $null }

$status = [ordered]@{
    collectedAt = (Get-Date).ToUniversalTime().ToString('o')
    serverName = 'Dyson Sphere Program - Nebula'
    state = if ($process) { 'running' } else { 'stopped' }
    runtime = [ordered]@{
        targetUps = $targetUps
        onlinePlayers = $null
        maxPlayers = $null
        processId = if ($process) { [int]$process.Id } else { $null }
        processCoresUsed = $processCoresUsed
        workingSetGiB = if ($process) { [math]::Round($process.WorkingSet64 / 1GB, 2) } else { $null }
        privateMemoryGiB = if ($process) { [math]::Round($process.PrivateMemorySize64 / 1GB, 2) } else { $null }
        threadCount = if ($process) { [int]$process.Threads.Count } else { $null }
        priority = $processPriority
        startedAt = $startedAt
        uptimeSeconds = $uptimeSeconds
    }
    host = [ordered]@{
        logicalProcessors = $logicalProcessors
        processorGroups = $processorGroups
        cpuPercent = $hostCpuPercent
        memoryTotalGiB = if ($operatingSystem) { [math]::Round(([double]$operatingSystem.TotalVisibleMemorySize * 1KB) / 1GB, 2) } else { $null }
        memoryFreeGiB = if ($operatingSystem) { [math]::Round(([double]$operatingSystem.FreePhysicalMemory * 1KB) / 1GB, 2) } else { $null }
    }
    versions = [ordered]@{
        dsp = $dspVersion
        nebula = $nebulaVersion
        bepInEx = $bepInExVersion
        compatible = $compatible
        gameLoaded = $gameLoaded
        warnings = @($versionWarnings)
    }
    save = [ordered]@{
        name = $activeSaveName
        dsvPresent = [bool]$activeDsv
        serverPresent = [bool]$activeSidecar
        consistent = [bool]($activeDsv -and $activeSidecar)
        lastSavedAt = if ($saveLastWrite) { $saveLastWrite.LastWriteTimeUtc.ToString('o') } else { $null }
        dsvSizeMiB = if ($activeDsv) { [math]::Round($activeDsv.Length / 1MB, 2) } else { $null }
        serverSizeKiB = if ($activeSidecar) { [math]::Round($activeSidecar.Length / 1KB, 2) } else { $null }
        latestBackupAt = if ($latestBackup) { $latestBackup.LastWriteTimeUtc.ToString('o') } else { $null }
        backupManifestPresent = [bool]$backupManifest
        backupPairPresent = [bool]($backupDsv -and $backupSidecar)
    }
    automation = [ordered]@{
        serverTask = Get-TaskSummary -TaskName $ServerTaskName
        stopTask = Get-TaskSummary -TaskName $StopTaskName
        storageTask = Get-TaskSummary -TaskName $StorageTaskName
        projectRootAvailable = [bool](Test-Path -LiteralPath $resolvedProjectRoot)
        globalMappingAvailable = $globalMappingAvailable
    }
    connections = @(
        [ordered]@{
            id = 'game-port'; label = "Game port $GamePort"
            status = if ($gamePortListening) { 'healthy' } else { 'warning' }
            detail = if ($gamePortListening) { 'Local TCP listener is healthy' } else { 'Local TCP listener was not detected' }
        },
        [ordered]@{ id = 'public-wss'; label = 'Public WSS'; status = 'unknown'; detail = 'External probe is not configured' }
    )
    capabilities = [ordered]@{ refresh = $true; save = $false; gracefulStop = $false; restart = $false }
}

$status | ConvertTo-Json -Depth 8 -Compress
