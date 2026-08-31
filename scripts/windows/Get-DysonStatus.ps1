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

function Get-HostCpuTelemetry {
    param([AllowNull()][Nullable[int]]$ExpectedLogicalProcessors)

    try {
        $instances = @(Get-CimInstance -ClassName Win32_PerfFormattedData_PerfOS_Processor -ErrorAction Stop)
        $totalInstance = $instances | Where-Object { [string]$_.Name -eq '_Total' } | Select-Object -First 1
        $totalPercent = $null
        if ($totalInstance -and $null -ne $totalInstance.PercentProcessorTime) {
            $candidateTotal = [double]$totalInstance.PercentProcessorTime
            if (-not [double]::IsNaN($candidateTotal) -and -not [double]::IsInfinity($candidateTotal) -and
                $candidateTotal -ge 0 -and $candidateTotal -le 100) {
                $totalPercent = [math]::Round($candidateTotal, 1)
            }
        }

        $parsedCores = @()
        foreach ($instance in $instances) {
            $instanceName = [string]$instance.Name
            if ($instanceName -eq '_Total') { continue }

            $group = 0
            $processor = -1
            if ($instanceName -match '^(?<processor>\d+)$') {
                $processor = [int]$Matches['processor']
            }
            elseif ($instanceName -match '^(?<group>\d+),(?<processor>\d+)$') {
                $group = [int]$Matches['group']
                $processor = [int]$Matches['processor']
            }
            else {
                continue
            }

            if ($null -eq $instance.PercentProcessorTime) { continue }
            $percent = [double]$instance.PercentProcessorTime
            if ([double]::IsNaN($percent) -or [double]::IsInfinity($percent) -or $percent -lt 0 -or $percent -gt 100) {
                continue
            }
            $parsedCores += [pscustomobject]@{
                group = $group
                processor = $processor
                percent = [math]::Round($percent, 1)
            }
        }

        $parsedCores = @($parsedCores | Sort-Object group, processor)
        $expectedCount = if ($null -ne $ExpectedLogicalProcessors -and $ExpectedLogicalProcessors.Value -gt 0) {
            $ExpectedLogicalProcessors.Value
        } else {
            $parsedCores.Count
        }
        if ($expectedCount -le 0 -or $parsedCores.Count -ne $expectedCount) {
            return [ordered]@{
                totalPercent = $totalPercent
                coreSamples = $null
                unavailableReason = 'inconsistent-sample'
            }
        }

        $samples = @()
        for ($index = 0; $index -lt $parsedCores.Count; $index++) {
            $samples += [ordered]@{ index = $index; percent = [double]$parsedCores[$index].percent }
        }
        return [ordered]@{
            totalPercent = $totalPercent
            coreSamples = @($samples)
            unavailableReason = $null
        }
    }
    catch {
        return [ordered]@{
            totalPercent = $null
            coreSamples = $null
            unavailableReason = 'cim-unavailable'
        }
    }
}

function Get-VolumeTelemetry {
    param([Parameter(Mandatory)][string]$Path)

    try {
        $fullPath = [System.IO.Path]::GetFullPath($Path)
        $pathRoot = [System.IO.Path]::GetPathRoot($fullPath)
        if ([string]::IsNullOrWhiteSpace($pathRoot)) { throw 'Volume root is unavailable.' }

        $totalBytes = $null
        $availableBytes = $null
        $driveId = $pathRoot.TrimEnd([char]'\')
        if ($driveId -match '^[A-Za-z]:$') {
            $escapedDriveId = $driveId.Replace("'", "''")
            $logicalDisk = Get-CimInstance -ClassName Win32_LogicalDisk -Filter "DeviceID = '$escapedDriveId'" -ErrorAction Stop |
                Select-Object -First 1
            if ($logicalDisk -and $null -ne $logicalDisk.Size -and $null -ne $logicalDisk.FreeSpace) {
                $totalBytes = [long]$logicalDisk.Size
                $availableBytes = [long]$logicalDisk.FreeSpace
            }
        }
        if ($null -eq $totalBytes -or $null -eq $availableBytes) {
            $driveInfo = [System.IO.DriveInfo]::new($pathRoot)
            if (-not $driveInfo.IsReady) { throw 'Volume is not ready.' }
            $totalBytes = [long]$driveInfo.TotalSize
            $availableBytes = [long]$driveInfo.AvailableFreeSpace
        }

        if ($totalBytes -le 0 -or $availableBytes -lt 0 -or $availableBytes -gt $totalBytes -or
            $totalBytes -gt 9007199254740991 -or $availableBytes -gt 9007199254740991) {
            return [ordered]@{
                totalBytes = $null
                availableBytes = $null
                usedPercent = $null
                unavailableReason = 'inconsistent-sample'
            }
        }
        return [ordered]@{
            totalBytes = $totalBytes
            availableBytes = $availableBytes
            usedPercent = [math]::Round((($totalBytes - $availableBytes) / [double]$totalBytes) * 100, 2)
            unavailableReason = $null
        }
    }
    catch {
        return [ordered]@{
            totalBytes = $null
            availableBytes = $null
            usedPercent = $null
            unavailableReason = 'volume-unavailable'
        }
    }
}

function Get-NetworkCounterSnapshot {
    try {
        $interfaces = @(
            [System.Net.NetworkInformation.NetworkInterface]::GetAllNetworkInterfaces() |
                Where-Object {
                    $_.NetworkInterfaceType -ne [System.Net.NetworkInformation.NetworkInterfaceType]::Loopback -and
                    $_.OperationalStatus -eq [System.Net.NetworkInformation.OperationalStatus]::Up
                }
        )
        if ($interfaces.Count -eq 0) {
            return [ordered]@{ counters = $null; unavailableReason = 'no-eligible-network-interface' }
        }

        $counters = @{}
        foreach ($interface in $interfaces) {
            $identity = [string]$interface.Id
            if ([string]::IsNullOrWhiteSpace($identity) -or $counters.ContainsKey($identity)) {
                return [ordered]@{ counters = $null; unavailableReason = 'inconsistent-sample' }
            }
            $statistics = $interface.GetIPStatistics()
            $received = [long]$statistics.BytesReceived
            $sent = [long]$statistics.BytesSent
            if ($received -lt 0 -or $sent -lt 0) {
                return [ordered]@{ counters = $null; unavailableReason = 'inconsistent-sample' }
            }
            # Interface identities are used only to match two in-process samples.
            # They are never copied into the JSON result.
            $counters[$identity] = [ordered]@{ received = $received; sent = $sent }
        }
        return [ordered]@{ counters = $counters; unavailableReason = $null }
    }
    catch {
        return [ordered]@{ counters = $null; unavailableReason = 'network-counters-unavailable' }
    }
}

function Get-NetworkRateTelemetry {
    param(
        [Parameter(Mandatory)]$Before,
        [Parameter(Mandatory)]$After,
        [Parameter(Mandatory)][double]$ElapsedSeconds
    )

    if ($Before.unavailableReason) {
        return [ordered]@{
            receiveBytesPerSecond = $null
            sendBytesPerSecond = $null
            sampledInterfaceCount = $null
            unavailableReason = [string]$Before.unavailableReason
        }
    }
    if ($After.unavailableReason) {
        return [ordered]@{
            receiveBytesPerSecond = $null
            sendBytesPerSecond = $null
            sampledInterfaceCount = $null
            unavailableReason = [string]$After.unavailableReason
        }
    }
    if ($ElapsedSeconds -le 0 -or $Before.counters.Count -le 0 -or
        $Before.counters.Count -ne $After.counters.Count) {
        return [ordered]@{
            receiveBytesPerSecond = $null
            sendBytesPerSecond = $null
            sampledInterfaceCount = $null
            unavailableReason = 'inconsistent-sample'
        }
    }

    [long]$receivedDelta = 0
    [long]$sentDelta = 0
    foreach ($identity in $Before.counters.Keys) {
        if (-not $After.counters.ContainsKey($identity)) {
            return [ordered]@{
                receiveBytesPerSecond = $null
                sendBytesPerSecond = $null
                sampledInterfaceCount = $null
                unavailableReason = 'inconsistent-sample'
            }
        }
        $received = [long]$After.counters[$identity].received - [long]$Before.counters[$identity].received
        $sent = [long]$After.counters[$identity].sent - [long]$Before.counters[$identity].sent
        if ($received -lt 0 -or $sent -lt 0) {
            return [ordered]@{
                receiveBytesPerSecond = $null
                sendBytesPerSecond = $null
                sampledInterfaceCount = $null
                unavailableReason = 'inconsistent-sample'
            }
        }
        $receivedDelta += $received
        $sentDelta += $sent
    }

    $receiveRate = [math]::Round($receivedDelta / $ElapsedSeconds, 0)
    $sendRate = [math]::Round($sentDelta / $ElapsedSeconds, 0)
    if ([double]::IsNaN($receiveRate) -or [double]::IsInfinity($receiveRate) -or
        [double]::IsNaN($sendRate) -or [double]::IsInfinity($sendRate) -or
        $receiveRate -lt 0 -or $sendRate -lt 0 -or
        $receiveRate -gt 9007199254740991 -or $sendRate -gt 9007199254740991) {
        return [ordered]@{
            receiveBytesPerSecond = $null
            sendBytesPerSecond = $null
            sampledInterfaceCount = $null
            unavailableReason = 'inconsistent-sample'
        }
    }
    return [ordered]@{
        receiveBytesPerSecond = [long]$receiveRate
        sendBytesPerSecond = [long]$sendRate
        sampledInterfaceCount = [int]$Before.counters.Count
        unavailableReason = $null
    }
}

$resolvedProjectRoot = (Resolve-Path -LiteralPath $ProjectRoot -ErrorAction Stop).ProviderPath
$expectedExecutable = Join-Path $resolvedProjectRoot 'server\DSPGAME.exe'
$process = Get-SafeProcess -ExpectedPath $expectedExecutable

$computerSystem = Get-CimInstance Win32_ComputerSystem -ErrorAction SilentlyContinue
$operatingSystem = Get-CimInstance Win32_OperatingSystem -ErrorAction SilentlyContinue
$logicalProcessors = if ($computerSystem -and [int]$computerSystem.NumberOfLogicalProcessors -gt 0) {
    [int]$computerSystem.NumberOfLogicalProcessors
} else { [Environment]::ProcessorCount }
$processorGroups = if ($logicalProcessors -gt 0) { [int][math]::Ceiling($logicalProcessors / 64.0) } else { $null }

$cpuStart = if ($process -and $null -ne $process.CPU) { [double]$process.CPU } else { $null }
$networkBefore = Get-NetworkCounterSnapshot
$sampleTimer = [System.Diagnostics.Stopwatch]::StartNew()
Start-Sleep -Milliseconds $CpuSampleMilliseconds
$freshProcess = if ($process) { Get-Process -Id $process.Id -ErrorAction SilentlyContinue } else { $null }
$networkAfter = Get-NetworkCounterSnapshot
$sampleTimer.Stop()
$networkTelemetry = Get-NetworkRateTelemetry -Before $networkBefore -After $networkAfter -ElapsedSeconds $sampleTimer.Elapsed.TotalSeconds

$processCoresUsed = $null
if ($process) {
    if ($freshProcess) {
        $process = $freshProcess
        if ($null -ne $cpuStart -and $null -ne $freshProcess.CPU -and $sampleTimer.Elapsed.TotalSeconds -gt 0) {
            $candidateCoresUsed = ([double]$freshProcess.CPU - $cpuStart) / $sampleTimer.Elapsed.TotalSeconds
            if (-not [double]::IsNaN($candidateCoresUsed) -and -not [double]::IsInfinity($candidateCoresUsed) -and
                $candidateCoresUsed -ge 0 -and $candidateCoresUsed -le $logicalProcessors) {
                $processCoresUsed = [math]::Round($candidateCoresUsed, 2)
            }
        }
    } else {
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

$hostCpuTelemetry = Get-HostCpuTelemetry -ExpectedLogicalProcessors $logicalProcessors
$hostCpuPercent = $hostCpuTelemetry.totalPercent
if ($null -eq $hostCpuPercent) {
    $hostCpuValues = @(Get-CimInstance Win32_Processor -ErrorAction SilentlyContinue |
        ForEach-Object { $_.LoadPercentage } | Where-Object { $null -ne $_ })
    $hostCpuPercent = if ($hostCpuValues.Count -gt 0) {
        [math]::Round((($hostCpuValues | Measure-Object -Average).Average), 1)
    } else { $null }
}

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
$projectVolumeTelemetry = Get-VolumeTelemetry -Path $resolvedProjectRoot
$saveVolumeTelemetry = Get-VolumeTelemetry -Path $saveRoot
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
        cpuCores = [ordered]@{
            samples = $hostCpuTelemetry.coreSamples
            unavailableReason = $hostCpuTelemetry.unavailableReason
        }
        projectVolume = $projectVolumeTelemetry
        saveVolume = $saveVolumeTelemetry
        network = $networkTelemetry
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
    capabilities = [ordered]@{ refresh = $true; start = $false; save = $false; gracefulStop = $false; restart = $false }
}

$status | ConvertTo-Json -Depth 8 -Compress
