Set-StrictMode -Version 2.0

$script:DysonLifecycleBrokerProfileProtocol = 'DYSON_CONTROL_LIFECYCLE_BROKER_PROFILE_V1'
$script:DysonLifecycleBrokerRequestProtocol = 'DYSON_CONTROL_LIFECYCLE_BROKER_REQUEST_V1'
$script:DysonLifecycleBrokerIntentProtocol = 'DYSON_CONTROL_LIFECYCLE_BROKER_INTENT_V1'
$script:DysonLifecycleBrokerReceiptProtocol = 'DYSON_CONTROL_LIFECYCLE_BROKER_RECEIPT_V1'
$script:DysonLifecycleBrokerResultProtocol = 'DYSON_CONTROL_LIFECYCLE_BROKER_RESULT_V1'
$script:DysonLifecycleBrokerSchemaVersion = 1
$script:DysonLifecycleBrokerMaximumProfileBytes = 131072
$script:DysonLifecycleBrokerMaximumRequestBytes = 32768
$script:DysonLifecycleBrokerMaximumIntentBytes = 32768
$script:DysonLifecycleBrokerMaximumReceiptBytes = 131072
$script:DysonLifecycleBrokerMaximumOutputBytes = 131072
$script:DysonLifecycleBrokerMaximumClosedStatusRecords = 256
$script:DysonLifecycleBrokerMaximumClosedStatusHardRecords = 1024
$script:DysonLifecycleBrokerMinimumStatusRetentionSeconds = 3600
$script:DysonLifecycleBrokerCapabilities = @(
    'LifecyclePreflight',
    'LifecycleDispatch',
    'LifecycleVerify',
    'LifecycleStatus'
)
$script:DysonLifecycleBrokerActions = @('start', 'save', 'graceful-stop', 'restart')
$script:DysonLifecycleBrokerOperations = @('start', 'graceful-stop', 'rollback-start')
$script:DysonLifecycleBrokerExpectedStates = @('running', 'stopped')
$script:DysonLifecycleBrokerDependencyNames = @(
    'DysonLifecycleBroker.Common.ps1',
    'DysonLifecycleBroker.TaskAcl.ps1',
    'Install-DysonLifecycleBrokerTask.ps1',
    'Invoke-DysonLifecycleBrokerWorker.ps1',
    'Submit-DysonLifecycleBrokerRequest.ps1',
    'DysonHostMutationLease.Common.ps1',
    'Start-DysonServer.ps1',
    'Stop-DysonServer.ps1'
)
$script:DysonLifecycleBrokerErrorCodes = @(
    'DYSON_CONTROL_LIFECYCLE_BROKER_INPUT_INVALID',
    'DYSON_CONTROL_LIFECYCLE_BROKER_PROFILE_INVALID',
    'DYSON_CONTROL_LIFECYCLE_BROKER_PROFILE_BINDING_MISMATCH',
    'DYSON_CONTROL_LIFECYCLE_BROKER_PATH_INVALID',
    'DYSON_CONTROL_LIFECYCLE_BROKER_HASH_DRIFT',
    'DYSON_CONTROL_LIFECYCLE_BROKER_REQUEST_INVALID',
    'DYSON_CONTROL_LIFECYCLE_BROKER_REQUEST_CONFLICT',
    'DYSON_CONTROL_LIFECYCLE_BROKER_RECEIPT_INVALID',
    'DYSON_CONTROL_LIFECYCLE_BROKER_STORAGE_UNAVAILABLE',
    'DYSON_CONTROL_LIFECYCLE_BROKER_TASK_INVALID',
    'DYSON_CONTROL_LIFECYCLE_BROKER_TASK_TRIGGER_FAILED',
    'DYSON_CONTROL_LIFECYCLE_BROKER_READY_TIMEOUT',
    'DYSON_CONTROL_LIFECYCLE_BROKER_TIMEOUT',
    'DYSON_CONTROL_LIFECYCLE_BROKER_CANCELLED',
    'DYSON_CONTROL_LIFECYCLE_BROKER_LEASE_INVALID',
    'DYSON_CONTROL_LIFECYCLE_BROKER_CAPABILITY_INVALID',
    'DYSON_CONTROL_LIFECYCLE_BROKER_RECOVERY_REQUIRED',
    'DYSON_CONTROL_LIFECYCLE_BROKER_ACCESS_CONTROL_FAILED',
    'DYSON_CONTROL_LIFECYCLE_BROKER_INSTALL_FAILED',
    'DYSON_CONTROL_LIFECYCLE_BROKER_SHADOW_FORBIDDEN',
    'DYSON_CONTROL_LIFECYCLE_BROKER_INTERNAL_ERROR'
)

function New-DysonLifecycleBrokerException {
    param([Parameter(Mandatory)][string]$Code)
    if ($Code -cnotin $script:DysonLifecycleBrokerErrorCodes) {
        $Code = 'DYSON_CONTROL_LIFECYCLE_BROKER_INTERNAL_ERROR'
    }
    $exception = [InvalidOperationException]::new($Code)
    $exception.Data['Code'] = $Code
    return $exception
}

function Throw-DysonLifecycleBrokerError {
    param([Parameter(Mandatory)][string]$Code)
    throw (New-DysonLifecycleBrokerException -Code $Code)
}

function Get-DysonLifecycleBrokerErrorCode {
    param([Parameter(Mandatory)][Exception]$Exception)
    if ($Exception.Data.Contains('Code')) {
        $candidate = [string]$Exception.Data['Code']
        if ($candidate -cin $script:DysonLifecycleBrokerErrorCodes) { return $candidate }
    }
    return 'DYSON_CONTROL_LIFECYCLE_BROKER_INTERNAL_ERROR'
}

function Write-DysonLifecycleBrokerFailureEnvelope {
    param([string]$Code = 'DYSON_CONTROL_LIFECYCLE_BROKER_INTERNAL_ERROR')
    if ($Code -cnotin $script:DysonLifecycleBrokerErrorCodes) {
        $Code = 'DYSON_CONTROL_LIFECYCLE_BROKER_INTERNAL_ERROR'
    }
    [ordered]@{ error = [ordered]@{ code = $Code } } | ConvertTo-Json -Compress
}

function Get-DysonLifecycleBrokerSha256Text {
    param([Parameter(Mandatory)][AllowEmptyString()][string]$Text)
    $algorithm = [Security.Cryptography.SHA256]::Create()
    try {
        $bytes = [Text.UTF8Encoding]::new($false).GetBytes($Text)
        return ([BitConverter]::ToString($algorithm.ComputeHash($bytes))).Replace('-', '').ToLowerInvariant()
    }
    finally { $algorithm.Dispose() }
}

function Get-DysonLifecycleBrokerSha256File {
    param([Parameter(Mandatory)][string]$LiteralPath)
    $resolved = Assert-DysonLifecycleBrokerPlainFile -Path $LiteralPath -MaximumBytes 4194304
    $stream = [IO.File]::Open($resolved, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
    $algorithm = [Security.Cryptography.SHA256]::Create()
    try { return ([BitConverter]::ToString($algorithm.ComputeHash($stream))).Replace('-', '').ToLowerInvariant() }
    finally { $algorithm.Dispose(); $stream.Dispose() }
}

function ConvertTo-DysonLifecycleBrokerJson {
    param([Parameter(Mandatory)]$Value)
    return ($Value | ConvertTo-Json -Depth 24 -Compress)
}

function Assert-DysonLifecycleBrokerExactProperties {
    param(
        [Parameter(Mandatory)]$Value,
        [Parameter(Mandatory)][AllowEmptyCollection()][string[]]$Names,
        [string]$ErrorCode = 'DYSON_CONTROL_LIFECYCLE_BROKER_REQUEST_INVALID'
    )
    if ($null -eq $Value) { Throw-DysonLifecycleBrokerError $ErrorCode }
    $actual = @($Value.PSObject.Properties | ForEach-Object { $_.Name } | Where-Object { $null -ne $_ })
    if ($actual.Count -ne $Names.Count) { Throw-DysonLifecycleBrokerError $ErrorCode }
    foreach ($name in $Names) {
        if ($name -cnotin $actual) { Throw-DysonLifecycleBrokerError $ErrorCode }
    }
}

function ConvertTo-DysonLifecycleBrokerGuid {
    param(
        [Parameter(Mandatory)][string]$Value,
        [string]$ErrorCode = 'DYSON_CONTROL_LIFECYCLE_BROKER_INPUT_INVALID'
    )
    $parsed = [guid]::Empty
    if (-not [guid]::TryParseExact($Value, 'D', [ref]$parsed) -or $parsed -eq [guid]::Empty) {
        Throw-DysonLifecycleBrokerError $ErrorCode
    }
    return $parsed.ToString('D').ToLowerInvariant()
}

function Assert-DysonLifecycleBrokerTimestamp {
    param([Parameter(Mandatory)][string]$Value, [string]$ErrorCode = 'DYSON_CONTROL_LIFECYCLE_BROKER_REQUEST_INVALID')
    if ($Value.Length -lt 20 -or $Value.Length -gt 40) { Throw-DysonLifecycleBrokerError $ErrorCode }
    $parsed = [datetimeoffset]::MinValue
    if (-not [datetimeoffset]::TryParseExact(
        $Value,
        'o',
        [Globalization.CultureInfo]::InvariantCulture,
        [Globalization.DateTimeStyles]::RoundtripKind,
        [ref]$parsed
    )) { Throw-DysonLifecycleBrokerError $ErrorCode }
}

function Get-DysonLifecycleBrokerFullPath {
    param([Parameter(Mandatory)][string]$Path)
    if ([string]::IsNullOrWhiteSpace($Path) -or $Path.Length -gt 1024 -or $Path -match '[\0\r\n"]') {
        Throw-DysonLifecycleBrokerError 'DYSON_CONTROL_LIFECYCLE_BROKER_PATH_INVALID'
    }
    try {
        $full = [IO.Path]::GetFullPath($Path).TrimEnd('\', '/')
        if (-not [IO.Path]::IsPathRooted($full) -or [string]::IsNullOrWhiteSpace($full)) {
            Throw-DysonLifecycleBrokerError 'DYSON_CONTROL_LIFECYCLE_BROKER_PATH_INVALID'
        }
        return $full
    }
    catch {
        if ($_.Exception.Data.Contains('Code')) { throw }
        Throw-DysonLifecycleBrokerError 'DYSON_CONTROL_LIFECYCLE_BROKER_PATH_INVALID'
    }
}

function Assert-DysonLifecycleBrokerNoReparsePath {
    param([Parameter(Mandatory)][string]$Path, [switch]$AllowMissingLeaf)
    $full = Get-DysonLifecycleBrokerFullPath $Path
    $root = [IO.Path]::GetPathRoot($full)
    if ([string]::IsNullOrWhiteSpace($root)) { Throw-DysonLifecycleBrokerError 'DYSON_CONTROL_LIFECYCLE_BROKER_PATH_INVALID' }
    $relative = $full.Substring($root.Length).TrimStart('\', '/')
    $cursor = $root.TrimEnd('\', '/')
    if ([string]::IsNullOrWhiteSpace($cursor)) { $cursor = $root }
    $parts = @($relative -split '[\\/]' | Where-Object { $_.Length -gt 0 })
    for ($index = 0; $index -lt $parts.Count; $index += 1) {
        $cursor = Join-Path $cursor $parts[$index]
        if (-not (Test-Path -LiteralPath $cursor)) {
            if ($AllowMissingLeaf -and $index -eq ($parts.Count - 1)) { return $full }
            Throw-DysonLifecycleBrokerError 'DYSON_CONTROL_LIFECYCLE_BROKER_PATH_INVALID'
        }
        $item = Get-Item -LiteralPath $cursor -Force -ErrorAction Stop
        if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) {
            Throw-DysonLifecycleBrokerError 'DYSON_CONTROL_LIFECYCLE_BROKER_PATH_INVALID'
        }
    }
    return $full
}

function Assert-DysonLifecycleBrokerPlainDirectory {
    param([Parameter(Mandatory)][string]$Path, [switch]$Create)
    $full = Get-DysonLifecycleBrokerFullPath $Path
    if ($Create -and -not (Test-Path -LiteralPath $full)) {
        try { [void][IO.Directory]::CreateDirectory($full) }
        catch { Throw-DysonLifecycleBrokerError 'DYSON_CONTROL_LIFECYCLE_BROKER_STORAGE_UNAVAILABLE' }
    }
    [void](Assert-DysonLifecycleBrokerNoReparsePath $full)
    try { $item = Get-Item -LiteralPath $full -Force -ErrorAction Stop }
    catch { Throw-DysonLifecycleBrokerError 'DYSON_CONTROL_LIFECYCLE_BROKER_PATH_INVALID' }
    if (-not $item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
        Throw-DysonLifecycleBrokerError 'DYSON_CONTROL_LIFECYCLE_BROKER_PATH_INVALID'
    }
    return $item.FullName.TrimEnd('\', '/')
}

function Assert-DysonLifecycleBrokerPlainFile {
    param(
        [Parameter(Mandatory)][string]$Path,
        [int64]$MaximumBytes = 1048576,
        [switch]$AllowEmpty
    )
    $full = Assert-DysonLifecycleBrokerNoReparsePath $Path
    try { $item = Get-Item -LiteralPath $full -Force -ErrorAction Stop }
    catch { Throw-DysonLifecycleBrokerError 'DYSON_CONTROL_LIFECYCLE_BROKER_PATH_INVALID' }
    if ($item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -or
        $item.Length -gt $MaximumBytes -or (-not $AllowEmpty -and $item.Length -lt 2)) {
        Throw-DysonLifecycleBrokerError 'DYSON_CONTROL_LIFECYCLE_BROKER_PATH_INVALID'
    }
    return $item.FullName
}

function Test-DysonLifecycleBrokerSamePath {
    param([Parameter(Mandatory)][string]$Left, [Parameter(Mandatory)][string]$Right)
    try {
        return [string]::Equals(
            (Get-DysonLifecycleBrokerFullPath $Left),
            (Get-DysonLifecycleBrokerFullPath $Right),
            [StringComparison]::OrdinalIgnoreCase
        )
    }
    catch { return $false }
}

function Read-DysonLifecycleBrokerJson {
    param(
        [Parameter(Mandatory)][string]$Path,
        [int64]$MaximumBytes,
        [string]$InvalidCode,
        [switch]$AllowMissing
    )
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
        if ($AllowMissing) { return $null }
        Throw-DysonLifecycleBrokerError $InvalidCode
    }
    try {
        $resolved = Assert-DysonLifecycleBrokerPlainFile -Path $Path -MaximumBytes $MaximumBytes
        $text = [IO.File]::ReadAllText($resolved, [Text.UTF8Encoding]::new($false))
        if ((Get-Command ConvertFrom-Json).Parameters.ContainsKey('DateKind')) {
            return ($text | ConvertFrom-Json -DateKind String -ErrorAction Stop)
        }
        return ($text | ConvertFrom-Json -ErrorAction Stop)
    }
    catch {
        if ($_.Exception.Data.Contains('Code') -and [string]$_.Exception.Data['Code'] -ceq $InvalidCode) { throw }
        Throw-DysonLifecycleBrokerError $InvalidCode
    }
}

function Write-DysonLifecycleBrokerJsonNew {
    param(
        [Parameter(Mandatory)][string]$Path,
        [Parameter(Mandatory)]$Value,
        [int64]$MaximumBytes,
        [string]$ConflictCode = 'DYSON_CONTROL_LIFECYCLE_BROKER_REQUEST_CONFLICT'
    )
    $full = Assert-DysonLifecycleBrokerNoReparsePath -Path $Path -AllowMissingLeaf
    $directory = Assert-DysonLifecycleBrokerPlainDirectory -Path ([IO.Path]::GetDirectoryName($full)) -Create
    $json = (ConvertTo-DysonLifecycleBrokerJson $Value) + "`n"
    $bytes = [Text.UTF8Encoding]::new($false).GetBytes($json)
    if ($bytes.Length -gt $MaximumBytes) { Throw-DysonLifecycleBrokerError 'DYSON_CONTROL_LIFECYCLE_BROKER_STORAGE_UNAVAILABLE' }
    $temporary = Join-Path $directory ('.lifecycle-' + [guid]::NewGuid().ToString('N') + '.tmp')
    try {
        [IO.File]::WriteAllBytes($temporary, $bytes)
        if (Test-Path -LiteralPath $full) { Throw-DysonLifecycleBrokerError $ConflictCode }
        [IO.File]::Move($temporary, $full)
    }
    catch {
        if ($_.Exception.Data.Contains('Code')) { throw }
        if (Test-Path -LiteralPath $full) { Throw-DysonLifecycleBrokerError $ConflictCode }
        Throw-DysonLifecycleBrokerError 'DYSON_CONTROL_LIFECYCLE_BROKER_STORAGE_UNAVAILABLE'
    }
    finally {
        if (Test-Path -LiteralPath $temporary -PathType Leaf) {
            # Remove-Item -Force may request WriteAttributes. The publisher has
            # delete access to its own temporary file, not content-write access.
            try { [IO.File]::Delete($temporary) } catch { }
        }
    }
    return $full
}

function Remove-DysonLifecycleBrokerPlainFile {
    param([Parameter(Mandatory)][string]$Path)
    if (-not (Test-Path -LiteralPath $Path)) { return }
    [void](Assert-DysonLifecycleBrokerPlainFile -Path $Path -MaximumBytes 2097152 -AllowEmpty)
    try { Remove-Item -LiteralPath $Path -Force -ErrorAction Stop }
    catch { Throw-DysonLifecycleBrokerError 'DYSON_CONTROL_LIFECYCLE_BROKER_STORAGE_UNAVAILABLE' }
}

function Get-DysonLifecycleBrokerStorage {
    param([Parameter(Mandatory)][string]$BrokerRoot, [switch]$Create)
    $root = Assert-DysonLifecycleBrokerPlainDirectory -Path $BrokerRoot -Create:$Create
    $requests = Assert-DysonLifecycleBrokerPlainDirectory -Path (Join-Path $root 'requests') -Create:$Create
    $intents = Assert-DysonLifecycleBrokerPlainDirectory -Path (Join-Path $root 'intents') -Create:$Create
    $receipts = Assert-DysonLifecycleBrokerPlainDirectory -Path (Join-Path $root 'receipts') -Create:$Create
    return [pscustomobject][ordered]@{ root = $root; requests = $requests; intents = $intents; receipts = $receipts }
}

function Get-DysonLifecycleBrokerRecordPaths {
    param([Parameter(Mandatory)]$Storage, [Parameter(Mandatory)][string]$BrokerRequestId)
    $id = ConvertTo-DysonLifecycleBrokerGuid $BrokerRequestId 'DYSON_CONTROL_LIFECYCLE_BROKER_REQUEST_INVALID'
    return [pscustomobject][ordered]@{
        request = Join-Path $Storage.requests ($id + '.json')
        intent = Join-Path $Storage.intents ($id + '.json')
        receipt = Join-Path $Storage.receipts ($id + '.json')
    }
}

function Get-DysonLifecycleBrokerExpectedDependencyPath {
    param([Parameter(Mandatory)]$Profile, [Parameter(Mandatory)][string]$Name)
    if ($Name -cin @(
        'DysonLifecycleBroker.Common.ps1',
        'DysonLifecycleBroker.TaskAcl.ps1',
        'Install-DysonLifecycleBrokerTask.ps1',
        'Invoke-DysonLifecycleBrokerWorker.ps1',
        'Submit-DysonLifecycleBrokerRequest.ps1'
    )) { return (Join-Path ([string]$Profile.brokerScriptRoot) $Name) }
    if ($Name -ceq 'DysonHostMutationLease.Common.ps1') { return (Join-Path ([string]$Profile.installedWindowsRoot) $Name) }
    if ($Name -cin @('Start-DysonServer.ps1', 'Stop-DysonServer.ps1')) {
        return (Join-Path ([string]$Profile.runtimeBootstrapRoot) $Name)
    }
    Throw-DysonLifecycleBrokerError 'DYSON_CONTROL_LIFECYCLE_BROKER_PROFILE_INVALID'
}

function ConvertTo-DysonLifecycleBrokerValidatedProfile {
    param([Parameter(Mandatory)]$Raw)
    try {
        Assert-DysonLifecycleBrokerExactProperties $Raw @(
            'protocol', 'schemaVersion', 'brokerRoot', 'brokerScriptRoot', 'projectRoot', 'dataRoot',
            'installedWindowsRoot', 'runtimeBootstrapRoot', 'serviceUser', 'gamePort',
            'workerTaskName', 'workerTaskPath', 'serverTask', 'stopTask', 'dependencyHashes',
            'dispatchReadyTimeoutSeconds', 'createdAt'
        ) 'DYSON_CONTROL_LIFECYCLE_BROKER_PROFILE_INVALID'
        if ($Raw.protocol -isnot [string] -or [string]$Raw.protocol -cne $script:DysonLifecycleBrokerProfileProtocol -or
            (($Raw.schemaVersion -isnot [int]) -and ($Raw.schemaVersion -isnot [long])) -or
            [int64]$Raw.schemaVersion -ne 1) {
            Throw-DysonLifecycleBrokerError 'DYSON_CONTROL_LIFECYCLE_BROKER_PROFILE_INVALID'
        }
        $profile = [pscustomobject][ordered]@{
            protocol = $script:DysonLifecycleBrokerProfileProtocol
            schemaVersion = 1
            brokerRoot = Assert-DysonLifecycleBrokerPlainDirectory ([string]$Raw.brokerRoot)
            brokerScriptRoot = Assert-DysonLifecycleBrokerPlainDirectory ([string]$Raw.brokerScriptRoot)
            projectRoot = Assert-DysonLifecycleBrokerPlainDirectory ([string]$Raw.projectRoot)
            dataRoot = Assert-DysonLifecycleBrokerPlainDirectory ([string]$Raw.dataRoot)
            installedWindowsRoot = Assert-DysonLifecycleBrokerPlainDirectory ([string]$Raw.installedWindowsRoot)
            runtimeBootstrapRoot = Assert-DysonLifecycleBrokerPlainDirectory ([string]$Raw.runtimeBootstrapRoot)
            serviceUser = [string]$Raw.serviceUser
            gamePort = [int]$Raw.gamePort
            workerTaskName = [string]$Raw.workerTaskName
            workerTaskPath = [string]$Raw.workerTaskPath
            serverTask = $Raw.serverTask
            stopTask = $Raw.stopTask
            dependencyHashes = @($Raw.dependencyHashes)
            dispatchReadyTimeoutSeconds = [int]$Raw.dispatchReadyTimeoutSeconds
            createdAt = [string]$Raw.createdAt
        }
        if ($profile.serviceUser -notmatch '^[^"\r\n]{1,128}$' -or $profile.gamePort -lt 1 -or $profile.gamePort -gt 65535 -or
            $profile.workerTaskName -cne 'Dyson-Control-Lifecycle-Broker' -or
            $profile.workerTaskPath -cne '\DysonControl\' -or
            $profile.dispatchReadyTimeoutSeconds -lt 5 -or $profile.dispatchReadyTimeoutSeconds -gt 60) {
            Throw-DysonLifecycleBrokerError 'DYSON_CONTROL_LIFECYCLE_BROKER_PROFILE_INVALID'
        }
        Assert-DysonLifecycleBrokerTimestamp $profile.createdAt 'DYSON_CONTROL_LIFECYCLE_BROKER_PROFILE_INVALID'
        foreach ($pair in @(
            @($profile.serverTask, 'Dyson-Nebula-Server'),
            @($profile.stopTask, 'Dyson-Nebula-Stop')
        )) {
            $task = $pair[0]
            Assert-DysonLifecycleBrokerExactProperties $task @('name', 'path', 'descriptorHash') 'DYSON_CONTROL_LIFECYCLE_BROKER_PROFILE_INVALID'
            if ([string]$task.name -cne [string]$pair[1] -or [string]$task.path -cne '\' -or
                [string]$task.descriptorHash -cnotmatch '^[0-9a-f]{64}$') {
                Throw-DysonLifecycleBrokerError 'DYSON_CONTROL_LIFECYCLE_BROKER_PROFILE_INVALID'
            }
        }
        if ($profile.dependencyHashes.Count -ne $script:DysonLifecycleBrokerDependencyNames.Count) {
            Throw-DysonLifecycleBrokerError 'DYSON_CONTROL_LIFECYCLE_BROKER_PROFILE_INVALID'
        }
        $seen = @{}
        foreach ($entry in $profile.dependencyHashes) {
            Assert-DysonLifecycleBrokerExactProperties $entry @('name', 'path', 'sha256') 'DYSON_CONTROL_LIFECYCLE_BROKER_PROFILE_INVALID'
            $name = [string]$entry.name
            if ($name -cnotin $script:DysonLifecycleBrokerDependencyNames -or $seen.ContainsKey($name) -or
                [string]$entry.sha256 -cnotmatch '^[0-9a-f]{64}$' -or
                -not (Test-DysonLifecycleBrokerSamePath ([string]$entry.path) (Get-DysonLifecycleBrokerExpectedDependencyPath $profile $name))) {
                Throw-DysonLifecycleBrokerError 'DYSON_CONTROL_LIFECYCLE_BROKER_PROFILE_INVALID'
            }
            $seen[$name] = $true
        }
        return $profile
    }
    catch {
        if ($_.Exception.Data.Contains('Code') -and
            [string]$_.Exception.Data['Code'] -ceq 'DYSON_CONTROL_LIFECYCLE_BROKER_PROFILE_INVALID') { throw }
        Throw-DysonLifecycleBrokerError 'DYSON_CONTROL_LIFECYCLE_BROKER_PROFILE_INVALID'
    }
}

function Read-DysonLifecycleBrokerProfile {
    param([Parameter(Mandatory)][string]$ProfileFile)
    $raw = Read-DysonLifecycleBrokerJson -Path $ProfileFile -MaximumBytes $script:DysonLifecycleBrokerMaximumProfileBytes `
        -InvalidCode 'DYSON_CONTROL_LIFECYCLE_BROKER_PROFILE_INVALID'
    return (ConvertTo-DysonLifecycleBrokerValidatedProfile $raw)
}

function Assert-DysonLifecycleBrokerDependencies {
    param([Parameter(Mandatory)]$Profile)
    foreach ($entry in @($Profile.dependencyHashes)) {
        $expectedPath = Get-DysonLifecycleBrokerExpectedDependencyPath $Profile ([string]$entry.name)
        try { $actual = Get-DysonLifecycleBrokerSha256File $expectedPath }
        catch { Throw-DysonLifecycleBrokerError 'DYSON_CONTROL_LIFECYCLE_BROKER_HASH_DRIFT' }
        if ($actual -cne [string]$entry.sha256) { Throw-DysonLifecycleBrokerError 'DYSON_CONTROL_LIFECYCLE_BROKER_HASH_DRIFT' }
    }
}

function Get-DysonLifecycleBrokerProfileHash {
    param([Parameter(Mandatory)][string]$ProfileFile)
    return (Get-DysonLifecycleBrokerSha256File $ProfileFile)
}

function Get-DysonLifecycleBrokerRequestFingerprint {
    param([Parameter(Mandatory)]$Request)
    $binding = [ordered]@{
        protocol = $script:DysonLifecycleBrokerRequestProtocol
        schemaVersion = 1
        brokerRequestId = [string]$Request.brokerRequestId
        capability = [string]$Request.capability
        profileHash = [string]$Request.profileHash
        input = $Request.input
    }
    return (Get-DysonLifecycleBrokerSha256Text (ConvertTo-DysonLifecycleBrokerJson $binding))
}

function ConvertTo-DysonLifecycleBrokerValidatedRequest {
    param([Parameter(Mandatory)]$Raw)
    try {
        Assert-DysonLifecycleBrokerExactProperties $Raw @(
            'protocol', 'schemaVersion', 'brokerRequestId', 'capability', 'profileHash',
            'requestFingerprint', 'input', 'requestedAt'
        ) 'DYSON_CONTROL_LIFECYCLE_BROKER_REQUEST_INVALID'
        if ($Raw.protocol -isnot [string] -or [string]$Raw.protocol -cne $script:DysonLifecycleBrokerRequestProtocol -or
            (($Raw.schemaVersion -isnot [int]) -and ($Raw.schemaVersion -isnot [long])) -or [int64]$Raw.schemaVersion -ne 1 -or
            [string]$Raw.capability -cnotin $script:DysonLifecycleBrokerCapabilities -or
            [string]$Raw.profileHash -cnotmatch '^[0-9a-f]{64}$' -or [string]$Raw.requestFingerprint -cnotmatch '^[0-9a-f]{64}$') {
            Throw-DysonLifecycleBrokerError 'DYSON_CONTROL_LIFECYCLE_BROKER_REQUEST_INVALID'
        }
        $capability = [string]$Raw.capability
        switch ($capability) {
            'LifecyclePreflight' {
                Assert-DysonLifecycleBrokerExactProperties $Raw.input @('action') 'DYSON_CONTROL_LIFECYCLE_BROKER_REQUEST_INVALID'
                if ([string]$Raw.input.action -cnotin $script:DysonLifecycleBrokerActions) { Throw-DysonLifecycleBrokerError 'DYSON_CONTROL_LIFECYCLE_BROKER_CAPABILITY_INVALID' }
                $input = [pscustomobject][ordered]@{ action = [string]$Raw.input.action }
            }
            'LifecycleDispatch' {
                Assert-DysonLifecycleBrokerExactProperties $Raw.input @('operation', 'leaseInstanceId', 'leaseToken') 'DYSON_CONTROL_LIFECYCLE_BROKER_REQUEST_INVALID'
                if ([string]$Raw.input.operation -cnotin $script:DysonLifecycleBrokerOperations -or
                    [string]$Raw.input.leaseToken -cnotmatch '^[A-Za-z0-9_-]{43}$') {
                    Throw-DysonLifecycleBrokerError 'DYSON_CONTROL_LIFECYCLE_BROKER_CAPABILITY_INVALID'
                }
                $input = [pscustomobject][ordered]@{
                    operation = [string]$Raw.input.operation
                    leaseInstanceId = ConvertTo-DysonLifecycleBrokerGuid ([string]$Raw.input.leaseInstanceId) 'DYSON_CONTROL_LIFECYCLE_BROKER_REQUEST_INVALID'
                    leaseToken = [string]$Raw.input.leaseToken
                }
            }
            'LifecycleVerify' {
                Assert-DysonLifecycleBrokerExactProperties $Raw.input @('expected') 'DYSON_CONTROL_LIFECYCLE_BROKER_REQUEST_INVALID'
                if ([string]$Raw.input.expected -cnotin $script:DysonLifecycleBrokerExpectedStates) { Throw-DysonLifecycleBrokerError 'DYSON_CONTROL_LIFECYCLE_BROKER_CAPABILITY_INVALID' }
                $input = [pscustomobject][ordered]@{ expected = [string]$Raw.input.expected }
            }
            'LifecycleStatus' {
                Assert-DysonLifecycleBrokerExactProperties -Value $Raw.input -Names ([string[]]@()) `
                    -ErrorCode 'DYSON_CONTROL_LIFECYCLE_BROKER_REQUEST_INVALID'
                $input = [pscustomobject][ordered]@{}
            }
        }
        Assert-DysonLifecycleBrokerTimestamp ([string]$Raw.requestedAt) 'DYSON_CONTROL_LIFECYCLE_BROKER_REQUEST_INVALID'
        $request = [pscustomobject][ordered]@{
            protocol = $script:DysonLifecycleBrokerRequestProtocol
            schemaVersion = 1
            brokerRequestId = ConvertTo-DysonLifecycleBrokerGuid ([string]$Raw.brokerRequestId) 'DYSON_CONTROL_LIFECYCLE_BROKER_REQUEST_INVALID'
            capability = $capability
            profileHash = [string]$Raw.profileHash
            requestFingerprint = [string]$Raw.requestFingerprint
            input = $input
            requestedAt = [string]$Raw.requestedAt
        }
        if ((Get-DysonLifecycleBrokerRequestFingerprint $request) -cne $request.requestFingerprint) {
            Throw-DysonLifecycleBrokerError 'DYSON_CONTROL_LIFECYCLE_BROKER_REQUEST_INVALID'
        }
        return $request
    }
    catch {
        if ($_.Exception.Data.Contains('Code')) { throw }
        Throw-DysonLifecycleBrokerError 'DYSON_CONTROL_LIFECYCLE_BROKER_REQUEST_INVALID'
    }
}

function New-DysonLifecycleBrokerRequest {
    param(
        [Parameter(Mandatory)][string]$BrokerRequestId,
        [Parameter(Mandatory)][string]$Capability,
        [Parameter(Mandatory)][string]$ProfileHash,
        [Parameter(Mandatory)][Alias('Input')]$RequestInput
    )
    $normalizedInput = if ($Capability -ceq 'LifecycleStatus') { [pscustomobject][ordered]@{} } else { $RequestInput }
    $request = [pscustomobject][ordered]@{
        protocol = $script:DysonLifecycleBrokerRequestProtocol
        schemaVersion = 1
        brokerRequestId = ConvertTo-DysonLifecycleBrokerGuid $BrokerRequestId
        capability = $Capability
        profileHash = $ProfileHash
        requestFingerprint = ('0' * 64)
        input = $normalizedInput
        requestedAt = (Get-Date).ToUniversalTime().ToString('o')
    }
    $request.requestFingerprint = Get-DysonLifecycleBrokerRequestFingerprint $request
    return (ConvertTo-DysonLifecycleBrokerValidatedRequest $request)
}

function Assert-DysonLifecycleBrokerRequestBinding {
    param([Parameter(Mandatory)]$Request, [Parameter(Mandatory)]$Profile, [Parameter(Mandatory)][string]$ProfileFile)
    if (-not (Test-DysonLifecycleBrokerSamePath $Profile.brokerRoot (Split-Path -Parent $ProfileFile)) -or
        [string]$Request.profileHash -cne (Get-DysonLifecycleBrokerProfileHash $ProfileFile)) {
        Throw-DysonLifecycleBrokerError 'DYSON_CONTROL_LIFECYCLE_BROKER_PROFILE_BINDING_MISMATCH'
    }
}

function ConvertTo-DysonLifecycleBrokerValidatedReceipt {
    param([Parameter(Mandatory)]$Raw)
    try {
        Assert-DysonLifecycleBrokerExactProperties $Raw @(
            'protocol', 'schemaVersion', 'brokerRequestId', 'requestFingerprint', 'capability',
            'status', 'errorCode', 'evidence', 'createdAt', 'completedAt', 'reused'
        ) 'DYSON_CONTROL_LIFECYCLE_BROKER_RECEIPT_INVALID'
        if ($Raw.protocol -isnot [string] -or [string]$Raw.protocol -cne $script:DysonLifecycleBrokerReceiptProtocol -or
            (($Raw.schemaVersion -isnot [int]) -and ($Raw.schemaVersion -isnot [long])) -or [int64]$Raw.schemaVersion -ne 1 -or
            [string]$Raw.requestFingerprint -cnotmatch '^[0-9a-f]{64}$' -or
            [string]$Raw.capability -cnotin $script:DysonLifecycleBrokerCapabilities -or
            [string]$Raw.status -cnotin @('succeeded', 'blocked', 'failed') -or
            (-not [string]::IsNullOrEmpty([string]$Raw.errorCode) -and [string]$Raw.errorCode -cnotin $script:DysonLifecycleBrokerErrorCodes) -or
            $Raw.reused -isnot [bool]) {
            Throw-DysonLifecycleBrokerError 'DYSON_CONTROL_LIFECYCLE_BROKER_RECEIPT_INVALID'
        }
        [void](ConvertTo-DysonLifecycleBrokerGuid ([string]$Raw.brokerRequestId) 'DYSON_CONTROL_LIFECYCLE_BROKER_RECEIPT_INVALID')
        Assert-DysonLifecycleBrokerTimestamp ([string]$Raw.createdAt) 'DYSON_CONTROL_LIFECYCLE_BROKER_RECEIPT_INVALID'
        Assert-DysonLifecycleBrokerTimestamp ([string]$Raw.completedAt) 'DYSON_CONTROL_LIFECYCLE_BROKER_RECEIPT_INVALID'
        if ([Text.UTF8Encoding]::new($false).GetByteCount((ConvertTo-DysonLifecycleBrokerJson $Raw.evidence)) -gt 65536) {
            Throw-DysonLifecycleBrokerError 'DYSON_CONTROL_LIFECYCLE_BROKER_RECEIPT_INVALID'
        }
        return [pscustomobject][ordered]@{
            protocol = $script:DysonLifecycleBrokerReceiptProtocol
            schemaVersion = 1
            brokerRequestId = [string]$Raw.brokerRequestId
            requestFingerprint = [string]$Raw.requestFingerprint
            capability = [string]$Raw.capability
            status = [string]$Raw.status
            errorCode = if ([string]::IsNullOrEmpty([string]$Raw.errorCode)) { $null } else { [string]$Raw.errorCode }
            evidence = $Raw.evidence
            createdAt = [string]$Raw.createdAt
            completedAt = [string]$Raw.completedAt
            reused = [bool]$Raw.reused
        }
    }
    catch {
        if ($_.Exception.Data.Contains('Code')) { throw }
        Throw-DysonLifecycleBrokerError 'DYSON_CONTROL_LIFECYCLE_BROKER_RECEIPT_INVALID'
    }
}

function New-DysonLifecycleBrokerReceipt {
    param(
        [Parameter(Mandatory)]$Request,
        [Parameter(Mandatory)][ValidateSet('succeeded', 'blocked', 'failed')][string]$Status,
        [AllowNull()][AllowEmptyString()][string]$ErrorCode,
        [AllowNull()]$Evidence
    )
    $now = (Get-Date).ToUniversalTime().ToString('o')
    return (ConvertTo-DysonLifecycleBrokerValidatedReceipt ([pscustomobject][ordered]@{
        protocol = $script:DysonLifecycleBrokerReceiptProtocol
        schemaVersion = 1
        brokerRequestId = [string]$Request.brokerRequestId
        requestFingerprint = [string]$Request.requestFingerprint
        capability = [string]$Request.capability
        status = $Status
        errorCode = $ErrorCode
        evidence = $Evidence
        createdAt = [string]$Request.requestedAt
        completedAt = $now
        reused = $false
    }))
}

function ConvertTo-DysonLifecycleBrokerResultEnvelope {
    param([Parameter(Mandatory)]$Receipt, [bool]$Reused)
    return [pscustomobject][ordered]@{
        protocol = $script:DysonLifecycleBrokerResultProtocol
        schemaVersion = 1
        brokerRequestId = [string]$Receipt.brokerRequestId
        capability = [string]$Receipt.capability
        reused = $Reused
        receipt = $Receipt
    }
}

function Get-DysonLifecycleBrokerTaskArguments {
    param([Parameter(Mandatory)][string]$BrokerRoot, [Parameter(Mandatory)][string]$ProfileFile, [Parameter(Mandatory)][string]$WorkerScript)
    foreach ($value in @($BrokerRoot, $ProfileFile, $WorkerScript)) {
        if ($value -match '["\r\n]') { Throw-DysonLifecycleBrokerError 'DYSON_CONTROL_LIFECYCLE_BROKER_INPUT_INVALID' }
    }
    return '-NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "{0}" -BrokerRoot "{1}" -ProfileFile "{2}" -Backend Windows' -f `
        $WorkerScript, $BrokerRoot, $ProfileFile
}

function Get-DysonLifecycleBrokerAclIntent {
    param([Parameter(Mandatory)][string]$LocalServiceSid)
    return [pscustomobject][ordered]@{
        root = @('SYSTEM:FullControl', 'BUILTIN\\Administrators:FullControl', "${LocalServiceSid}:ReadAndExecute")
        requests = @('SYSTEM:FullControl', 'BUILTIN\\Administrators:FullControl', "${LocalServiceSid}:CreateFiles+AppendData+ListDirectory+ReadAttributes+Synchronize", 'CREATOR OWNER:Read+Delete (files only)')
        intents = @('SYSTEM:FullControl', 'BUILTIN\\Administrators:FullControl')
        receipts = @('SYSTEM:FullControl', 'BUILTIN\\Administrators:FullControl', "${LocalServiceSid}:ReadAndExecute")
        profile = @('SYSTEM:FullControl', 'BUILTIN\\Administrators:FullControl', "${LocalServiceSid}:Read")
        task = @('SYSTEM:FullControl', 'BUILTIN\\Administrators:FullControl', "${LocalServiceSid}:Read+Execute")
    }
}

function ConvertTo-DysonLifecycleBrokerTaskDescriptor {
    param(
        [Parameter(Mandatory)]$Task,
        [Parameter(Mandatory)][ValidateSet('server', 'stop')][string]$Kind,
        [Parameter(Mandatory)]$Profile,
        [switch]$AllowPreparedDisabled
    )
    try {
        $expectedName = if ($Kind -ceq 'server') { 'Dyson-Nebula-Server' } else { 'Dyson-Nebula-Stop' }
        $actions = @($Task.Actions | Where-Object { $null -ne $_ })
        if ([string]$Task.TaskName -cne $expectedName -or [string]$Task.TaskPath -cne '\' -or $actions.Count -ne 1) {
            Throw-DysonLifecycleBrokerError 'DYSON_CONTROL_LIFECYCLE_BROKER_TASK_INVALID'
        }
        $action = $actions[0]
        $expectedPowerShell = [IO.Path]::GetFullPath((Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'))
        $actualPowerShell = [IO.Path]::GetFullPath([Environment]::ExpandEnvironmentVariables([string]$action.Execute))
        if (-not [string]::Equals($actualPowerShell, $expectedPowerShell, [StringComparison]::OrdinalIgnoreCase) -or
            -not [string]::IsNullOrWhiteSpace([string]$action.WorkingDirectory)) {
            Throw-DysonLifecycleBrokerError 'DYSON_CONTROL_LIFECYCLE_BROKER_TASK_INVALID'
        }
        $arguments = [string]$action.Arguments
        if ($arguments -match '[\0\r\n]' -or $arguments.Length -gt 2048) {
            Throw-DysonLifecycleBrokerError 'DYSON_CONTROL_LIFECYCLE_BROKER_TASK_INVALID'
        }
        $pattern = if ($Kind -ceq 'server') {
            '(?i)^-NoLogo\s+-NoProfile\s+-NonInteractive\s+-ExecutionPolicy\s+Bypass\s+-File\s+"(?<script>[^"]+)"\s+-ProjectRoot\s+"(?<root>[^"]+)"\s+-Ups\s+(?<bounded>\d{1,3})$'
        }
        else {
            '(?i)^-NoLogo\s+-NoProfile\s+-NonInteractive\s+-ExecutionPolicy\s+Bypass\s+-File\s+"(?<script>[^"]+)"\s+-ProjectRoot\s+"(?<root>[^"]+)"\s+-TimeoutSeconds\s+(?<bounded>\d{1,3})$'
        }
        $match = [regex]::Match($arguments, $pattern)
        if (-not $match.Success) { Throw-DysonLifecycleBrokerError 'DYSON_CONTROL_LIFECYCLE_BROKER_TASK_INVALID' }
        $expectedScript = Join-Path ([string]$Profile.runtimeBootstrapRoot) $(
            if ($Kind -ceq 'server') { 'Start-DysonServer.ps1' } else { 'Stop-DysonServer.ps1' }
        )
        $actualScript = Assert-DysonLifecycleBrokerPlainFile $match.Groups['script'].Value
        $actualRoot = Assert-DysonLifecycleBrokerPlainDirectory $match.Groups['root'].Value
        $bounded = [int]$match.Groups['bounded'].Value
        if (-not (Test-DysonLifecycleBrokerSamePath $actualScript $expectedScript) -or
            -not (Test-DysonLifecycleBrokerSamePath $actualRoot ([string]$Profile.projectRoot)) -or
            ($Kind -ceq 'server' -and ($bounded -lt 5 -or $bounded -gt 240)) -or
            ($Kind -ceq 'stop' -and $bounded -ne 150)) {
            Throw-DysonLifecycleBrokerError 'DYSON_CONTROL_LIFECYCLE_BROKER_TASK_INVALID'
        }
        $principalLeaf = ([string]$Task.Principal.UserId -split '\\')[-1]
        $expectedLeaf = ([string]$Profile.serviceUser -split '\\')[-1]
        $executionTimeLimit = [string]$Task.Settings.ExecutionTimeLimit
        $restartCount = [int]$Task.Settings.RestartCount
        $restartInterval = if ([string]::IsNullOrWhiteSpace([string]$Task.Settings.RestartInterval)) {
            $null
        }
        else { [string]$Task.Settings.RestartInterval }
        $startWhenAvailable = [bool]$Task.Settings.StartWhenAvailable
        if (-not (Test-DysonLifecycleBrokerTaskUserEqual ([string]$Task.Principal.UserId) ([string]$Profile.serviceUser)) -or
            [string]$Task.Principal.LogonType -cne 'Interactive' -or [string]$Task.Principal.RunLevel -cne 'Limited' -or
            [string]$Task.Settings.MultipleInstances -cne 'IgnoreNew' -or
            (-not $AllowPreparedDisabled -and -not [bool]$Task.Settings.Enabled)) {
            Throw-DysonLifecycleBrokerError 'DYSON_CONTROL_LIFECYCLE_BROKER_TASK_INVALID'
        }
        if (($Kind -ceq 'server' -and ($executionTimeLimit -cne 'PT0S' -or $restartCount -ne 3 -or
            $restartInterval -cne 'PT1M' -or -not $startWhenAvailable)) -or
            ($Kind -ceq 'stop' -and ($executionTimeLimit -cne 'PT5M' -or $restartCount -ne 0 -or
            $null -ne $restartInterval -or $startWhenAvailable))) {
            Throw-DysonLifecycleBrokerError 'DYSON_CONTROL_LIFECYCLE_BROKER_TASK_INVALID'
        }
        $triggers = @($Task.Triggers | Where-Object { $null -ne $_ })
        $trigger = if ($Kind -ceq 'server') {
            if ($triggers.Count -ne 1) { Throw-DysonLifecycleBrokerError 'DYSON_CONTROL_LIFECYCLE_BROKER_TASK_INVALID' }
            [ordered]@{
                count = 1
                userId = $expectedLeaf.ToLowerInvariant()
                delay = [string]$triggers[0].Delay
            }
        }
        else {
            if ($triggers.Count -ne 0) { Throw-DysonLifecycleBrokerError 'DYSON_CONTROL_LIFECYCLE_BROKER_TASK_INVALID' }
            [ordered]@{ count = 0; userId = $null; delay = $null }
        }
        if ($Kind -ceq 'server' -and
            (-not (Test-DysonLifecycleBrokerTaskUserEqual ([string]$triggers[0].UserId) ([string]$Profile.serviceUser)) -or
            [string]$trigger.delay -cne 'PT20S')) {
            Throw-DysonLifecycleBrokerError 'DYSON_CONTROL_LIFECYCLE_BROKER_TASK_INVALID'
        }
        return [pscustomobject][ordered]@{
            name = $expectedName
            path = '\'
            execute = $actualPowerShell.ToLowerInvariant()
            arguments = $arguments
            workingDirectory = ''
            userId = $expectedLeaf.ToLowerInvariant()
            logonType = 'Interactive'
            runLevel = 'Limited'
            enabled = [bool]$Task.Settings.Enabled
            multipleInstances = 'IgnoreNew'
            executionTimeLimit = $executionTimeLimit
            restartCount = $restartCount
            restartInterval = $restartInterval
            startWhenAvailable = $startWhenAvailable
            trigger = $trigger
        }
    }
    catch {
        if ($_.Exception.Data.Contains('Code')) { throw }
        Throw-DysonLifecycleBrokerError 'DYSON_CONTROL_LIFECYCLE_BROKER_TASK_INVALID'
    }
}

function Test-DysonLifecycleBrokerTaskUserEqual {
    param([string]$Actual, [string]$Expected)
    if (-not [string]::IsNullOrWhiteSpace($Actual) -and
        [string]::Equals($Actual, $Expected, [StringComparison]::OrdinalIgnoreCase)) { return $true }
    try {
        $sids = @(foreach ($value in @($Actual, $Expected)) {
            if ($value -match '^S-1-') { ([Security.Principal.SecurityIdentifier]::new($value)).Value }
            else { ([Security.Principal.NTAccount]::new($value)).Translate([Security.Principal.SecurityIdentifier]).Value }
        })
        return $sids[0] -ceq $sids[1]
    }
    catch { return $false }
}

function Get-DysonLifecycleBrokerTaskDescriptor {
    param(
        [Parameter(Mandatory)]$Profile,
        [Parameter(Mandatory)][ValidateSet('server', 'stop')][string]$Kind,
        [ValidateSet('Windows', 'Shadow')][string]$Backend = 'Windows',
        [string]$ShadowRoot,
        [switch]$AllowPreparedDisabled
    )
    if ($Backend -ceq 'Shadow') {
        if ($env:DYSON_LIFECYCLE_BROKER_SELFTEST -cne '1' -or [string]::IsNullOrWhiteSpace($ShadowRoot)) {
            Throw-DysonLifecycleBrokerError 'DYSON_CONTROL_LIFECYCLE_BROKER_SHADOW_FORBIDDEN'
        }
        $root = Assert-DysonLifecycleBrokerPlainDirectory $ShadowRoot
        if (-not (Test-Path -LiteralPath (Join-Path $root '.dyson-lifecycle-broker-selftest') -PathType Leaf)) {
            Throw-DysonLifecycleBrokerError 'DYSON_CONTROL_LIFECYCLE_BROKER_SHADOW_FORBIDDEN'
        }
        $raw = Read-DysonLifecycleBrokerJson -Path (Join-Path $root ($Kind + '-task.json')) -MaximumBytes 32768 `
            -InvalidCode 'DYSON_CONTROL_LIFECYCLE_BROKER_TASK_INVALID'
        Assert-DysonLifecycleBrokerExactProperties $raw @('descriptor', 'state') 'DYSON_CONTROL_LIFECYCLE_BROKER_TASK_INVALID'
        $descriptor = $raw.descriptor
        Assert-DysonLifecycleBrokerExactProperties $descriptor @(
            'name', 'path', 'execute', 'arguments', 'workingDirectory', 'userId', 'logonType',
            'runLevel', 'enabled', 'multipleInstances', 'executionTimeLimit', 'restartCount',
            'restartInterval', 'startWhenAvailable', 'trigger'
        ) 'DYSON_CONTROL_LIFECYCLE_BROKER_TASK_INVALID'
        if ($descriptor.enabled -isnot [bool] -or
            (-not $AllowPreparedDisabled -and -not [bool]$descriptor.enabled)) {
            Throw-DysonLifecycleBrokerError 'DYSON_CONTROL_LIFECYCLE_BROKER_TASK_INVALID'
        }
        if (($Kind -ceq 'server' -and ([string]$descriptor.executionTimeLimit -cne 'PT0S' -or
            [int]$descriptor.restartCount -ne 3 -or [string]$descriptor.restartInterval -cne 'PT1M' -or
            -not [bool]$descriptor.startWhenAvailable)) -or
            ($Kind -ceq 'stop' -and ([string]$descriptor.executionTimeLimit -cne 'PT5M' -or
            [int]$descriptor.restartCount -ne 0 -or $null -ne $descriptor.restartInterval -or
            [bool]$descriptor.startWhenAvailable))) {
            Throw-DysonLifecycleBrokerError 'DYSON_CONTROL_LIFECYCLE_BROKER_TASK_INVALID'
        }
        return [pscustomobject][ordered]@{ descriptor = $descriptor; state = [string]$raw.state }
    }
    $name = if ($Kind -ceq 'server') { 'Dyson-Nebula-Server' } else { 'Dyson-Nebula-Stop' }
    try { $matches = @(Get-ScheduledTask -TaskName $name -TaskPath '\' -ErrorAction Stop) }
    catch { Throw-DysonLifecycleBrokerError 'DYSON_CONTROL_LIFECYCLE_BROKER_TASK_INVALID' }
    if ($matches.Count -ne 1) { Throw-DysonLifecycleBrokerError 'DYSON_CONTROL_LIFECYCLE_BROKER_TASK_INVALID' }
    $descriptor = ConvertTo-DysonLifecycleBrokerTaskDescriptor -Task $matches[0] -Kind $Kind -Profile $Profile `
        -AllowPreparedDisabled:$AllowPreparedDisabled
    return [pscustomobject][ordered]@{ descriptor = $descriptor; state = [string]$matches[0].State }
}

function Get-DysonLifecycleBrokerExpectedActiveDescriptorHash {
    param([Parameter(Mandatory)]$Descriptor)
    # Installation pins the definition expected after cutover activation without
    # changing the observed descriptor or enabling either scheduled task.
    $expected = [ordered]@{}
    foreach ($property in $Descriptor.PSObject.Properties) { $expected[$property.Name] = $property.Value }
    $expected.enabled = $true
    return Get-DysonLifecycleBrokerTaskDescriptorHash ([pscustomobject]$expected)
}

function Get-DysonLifecycleBrokerValidatedTaskPair {
    param([Parameter(Mandatory)]$Profile,
        [ValidateSet('Windows', 'Shadow')][string]$Backend = 'Windows',
        [string]$ShadowRoot, [switch]$AllowPreparedDisabled)
    $server = Get-DysonLifecycleBrokerTaskDescriptor -Profile $Profile -Kind server -Backend $Backend `
        -ShadowRoot $ShadowRoot -AllowPreparedDisabled:$AllowPreparedDisabled
    $stop = Get-DysonLifecycleBrokerTaskDescriptor -Profile $Profile -Kind stop -Backend $Backend `
        -ShadowRoot $ShadowRoot -AllowPreparedDisabled:$AllowPreparedDisabled
    $prepared = -not [bool]$server.descriptor.enabled
    if ([bool]$server.descriptor.enabled -ne [bool]$stop.descriptor.enabled -or
        ($prepared -and (-not $AllowPreparedDisabled -or
            [string]$server.state -cne 'Disabled' -or
            [string]$stop.state -cne 'Disabled'))) {
        Throw-DysonLifecycleBrokerError 'DYSON_CONTROL_LIFECYCLE_BROKER_TASK_INVALID'
    }
    return [pscustomobject][ordered]@{ server = $server; stop = $stop; preparedDisabled = $prepared }
}

function Get-DysonLifecycleBrokerTaskDescriptorHash {
    param([Parameter(Mandatory)]$Descriptor)
    return (Get-DysonLifecycleBrokerSha256Text (ConvertTo-DysonLifecycleBrokerJson $Descriptor))
}

function Assert-DysonLifecycleBrokerTaskPair {
    param(
        [Parameter(Mandatory)]$Profile,
        [ValidateSet('Windows', 'Shadow')][string]$Backend = 'Windows',
        [string]$ShadowRoot,
        [switch]$AllowPreparedDisabled
    )
    $pair = Get-DysonLifecycleBrokerValidatedTaskPair -Profile $Profile -Backend $Backend `
        -ShadowRoot $ShadowRoot -AllowPreparedDisabled:$AllowPreparedDisabled
    if ((Get-DysonLifecycleBrokerExpectedActiveDescriptorHash $pair.server.descriptor) -cne [string]$Profile.serverTask.descriptorHash -or
        (Get-DysonLifecycleBrokerExpectedActiveDescriptorHash $pair.stop.descriptor) -cne [string]$Profile.stopTask.descriptorHash) {
        Throw-DysonLifecycleBrokerError 'DYSON_CONTROL_LIFECYCLE_BROKER_TASK_INVALID'
    }
    return $pair
}
