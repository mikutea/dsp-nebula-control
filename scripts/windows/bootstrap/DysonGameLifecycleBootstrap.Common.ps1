Set-StrictMode -Version 2.0

$script:DysonGameBootstrapProtocol = 'DYSON_CONTROL_GAME_BOOTSTRAP_V1'
$script:DysonDeploymentProtocol = 'DYSON_CONTROL_DEPLOYMENT_V1'
$script:DysonGameBindingProtocol = 'DYSON_CONTROL_GAME_BINDING_V1'
$script:DysonGameBootstrapLayoutProtocol = 'DYSON_CONTROL_GAME_BOOTSTRAP_LAYOUT_V1'
$script:DysonGameRuntimeReceiptProtocol = 'DYSON_CONTROL_GAME_RUNTIME_RECEIPT_V1'
$script:DysonGameExpectedExitProtocol = 'DYSON_CONTROL_GAME_EXPECTED_EXIT_V1'
$script:DysonReleaseManifestName = 'release-manifest.json'
$script:DysonActivePointerName = 'active-release.json'
$script:DysonGameBindingName = 'game-lifecycle-binding.json'
$script:DysonGameBootstrapLayoutName = 'bootstrap-layout.json'
$script:DysonGameRuntimeReceiptDirectoryName = 'game-runtime-receipts'
$script:DysonGameExpectedExitName = 'game-lifecycle-expected-exit.json'
$script:DysonGameExpectedExitPendingName = '.game-lifecycle-expected-exit.pending.json'
$script:DysonGameExpectedExitRecoveryName = '.game-lifecycle-expected-exit.recovery.json'
$script:DysonGameExpectedExitDiscardName = '.game-lifecycle-expected-exit.rollback-discard.json'
$script:DysonGameBootstrapExpectedExitFaultHook = $null
$script:DysonGameStartRelativePath = 'scripts/windows/Start-DysonServer.ps1'
$script:DysonGameStopRelativePath = 'scripts/windows/Stop-DysonServer.ps1'
$script:DysonMaximumPointerBytes = 4096
$script:DysonMaximumBindingBytes = 4096
$script:DysonMaximumLayoutBytes = 4096
$script:DysonMaximumRuntimeReceiptBytes = 8192
$script:DysonMaximumExpectedExitBytes = 4096
$script:DysonMaximumManifestBytes = 16MB
$script:DysonMaximumReleaseEntries = 20000
$script:DysonMaximumReleaseFileBytes = [int64](8GB)
$script:DysonMaximumReleaseBytes = [int64](64GB)

function ConvertTo-DysonGameBootstrapJsonLine {
    param([Parameter(Mandatory, ValueFromPipeline)]$Value)
    process { return ($Value | Microsoft.PowerShell.Utility\ConvertTo-Json -Depth 12 -Compress) }
}

function Get-DysonGameBootstrapFullPath {
    param([Parameter(Mandatory)][string]$Path)

    if ([string]::IsNullOrWhiteSpace($Path) -or $Path.IndexOf([char]0) -ge 0 -or $Path -match '[\r\n"]') {
        throw 'BOOTSTRAP_PATH_INVALID'
    }
    try { return [System.IO.Path]::GetFullPath($Path) }
    catch { throw 'BOOTSTRAP_PATH_INVALID' }
}

function Test-DysonGameBootstrapPathWithin {
    param(
        [Parameter(Mandatory)][string]$Candidate,
        [Parameter(Mandatory)][string]$Parent,
        [switch]$AllowEqual
    )

    $candidateFull = (Get-DysonGameBootstrapFullPath -Path $Candidate).TrimEnd('\', '/')
    $parentFull = (Get-DysonGameBootstrapFullPath -Path $Parent).TrimEnd('\', '/')
    if ($AllowEqual -and [string]::Equals(
        $candidateFull,
        $parentFull,
        [System.StringComparison]::OrdinalIgnoreCase
    )) { return $true }
    return $candidateFull.StartsWith(
        $parentFull + [System.IO.Path]::DirectorySeparatorChar,
        [System.StringComparison]::OrdinalIgnoreCase
    )
}

function Assert-DysonGameBootstrapPlainDirectory {
    param([Parameter(Mandatory)][string]$Path)

    $full = Get-DysonGameBootstrapFullPath -Path $Path
    try {
        $item = [System.IO.DirectoryInfo]::new($full)
        $item.Refresh()
        if (-not $item.Exists -or ($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint)) {
            throw 'invalid directory'
        }
        return $item.FullName
    }
    catch { throw 'BOOTSTRAP_DIRECTORY_INVALID' }
}

function Assert-DysonGameBootstrapPlainFile {
    param(
        [Parameter(Mandatory)][string]$Path,
        [Parameter(Mandatory)][int64]$MaximumBytes
    )

    $full = Get-DysonGameBootstrapFullPath -Path $Path
    try {
        $item = [System.IO.FileInfo]::new($full)
        $item.Refresh()
        if (-not $item.Exists -or ($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -or
            $item.Length -lt 1 -or $item.Length -gt $MaximumBytes) {
            throw 'invalid file'
        }
        return $item
    }
    catch { throw 'BOOTSTRAP_FILE_INVALID' }
}

function Assert-DysonGameBootstrapVersion {
    param([Parameter(Mandatory)][string]$Version)

    if ($Version -notmatch '^[0-9A-Za-z][0-9A-Za-z._+-]{0,63}$') {
        throw 'BOOTSTRAP_VERSION_INVALID'
    }
}

function Assert-DysonGameBootstrapRelativePath {
    param([Parameter(Mandatory)][string]$Path)

    if ([string]::IsNullOrWhiteSpace($Path) -or $Path.Length -gt 512 -or
        [System.IO.Path]::IsPathRooted($Path) -or $Path.IndexOf([char]0) -ge 0 -or
        $Path -match '["\r\n:]' -or $Path -match '(^|[\\/])\.\.([\\/]|$)' -or
        $Path -match '(^|[\\/])\.([\\/]|$)') {
        throw 'BOOTSTRAP_RELATIVE_PATH_INVALID'
    }
}

function Get-DysonGameBootstrapSha256Bytes {
    param([Parameter(Mandatory)][byte[]]$Bytes)

    $hasher = [System.Security.Cryptography.SHA256]::Create()
    try { return ([System.BitConverter]::ToString($hasher.ComputeHash($Bytes))).Replace('-', '').ToLowerInvariant() }
    finally { $hasher.Dispose() }
}

function Get-DysonGameBootstrapSha256Text {
    param([Parameter(Mandatory)][AllowEmptyString()][string]$Value)
    return Get-DysonGameBootstrapSha256Bytes -Bytes ([System.Text.UTF8Encoding]::new($false).GetBytes($Value))
}

function Get-DysonGameBootstrapPathIdentity {
    param([Parameter(Mandatory)][string]$Path)

    $full = Get-DysonGameBootstrapFullPath -Path $Path
    return Get-DysonGameBootstrapSha256Text -Value $full.ToUpperInvariant()
}

function Get-DysonGameBootstrapFileSha256 {
    param([Parameter(Mandatory)][string]$Path)

    $stream = $null
    $hasher = $null
    try {
        $stream = [System.IO.FileStream]::new(
            (Get-DysonGameBootstrapFullPath -Path $Path),
            [System.IO.FileMode]::Open,
            [System.IO.FileAccess]::Read,
            [System.IO.FileShare]::Read
        )
        $hasher = [System.Security.Cryptography.SHA256]::Create()
        return ([System.BitConverter]::ToString($hasher.ComputeHash($stream))).Replace('-', '').ToLowerInvariant()
    }
    catch { throw 'BOOTSTRAP_FILE_HASH_FAILED' }
    finally {
        if ($hasher) { $hasher.Dispose() }
        if ($stream) { $stream.Dispose() }
    }
}

function Read-DysonGameBootstrapJsonFile {
    param(
        [Parameter(Mandatory)][string]$Path,
        [Parameter(Mandatory)][int64]$MaximumBytes
    )

    $item = Assert-DysonGameBootstrapPlainFile -Path $Path -MaximumBytes $MaximumBytes
    $stream = $null
    try {
        $stream = [System.IO.FileStream]::new(
            $item.FullName,
            [System.IO.FileMode]::Open,
            [System.IO.FileAccess]::Read,
            [System.IO.FileShare]::Read
        )
        if ($stream.Length -lt 1 -or $stream.Length -gt $MaximumBytes) { throw 'invalid json size' }
        $bytes = [byte[]]::new([int]$stream.Length)
        $offset = 0
        while ($offset -lt $bytes.Length) {
            $read = $stream.Read($bytes, $offset, $bytes.Length - $offset)
            if ($read -le 0) { throw 'truncated json' }
            $offset += $read
        }
        $utf8 = [System.Text.UTF8Encoding]::new($false, $true)
        $text = $utf8.GetString($bytes)
        $value = Microsoft.PowerShell.Utility\ConvertFrom-Json -InputObject $text -ErrorAction Stop
        return [pscustomobject][ordered]@{
            value = $value
            sha256 = Get-DysonGameBootstrapSha256Bytes -Bytes $bytes
        }
    }
    catch { throw 'BOOTSTRAP_JSON_INVALID' }
    finally { if ($stream) { $stream.Dispose() } }
}

function Assert-DysonGameBootstrapExactProperties {
    param(
        [Parameter(Mandatory)]$Value,
        [Parameter(Mandatory)][string[]]$Names
    )

    if ($null -eq $Value -or $Value -is [System.Array] -or $Value -is [string]) {
        throw 'BOOTSTRAP_SCHEMA_INVALID'
    }
    $actual = @($Value.PSObject.Properties | ForEach-Object { [string]$_.Name })
    if ($actual.Count -ne $Names.Count) { throw 'BOOTSTRAP_SCHEMA_INVALID' }
    foreach ($name in $Names) {
        if ($actual -cnotcontains $name) { throw 'BOOTSTRAP_SCHEMA_INVALID' }
    }
}

function Assert-DysonGameBootstrapTimestamp {
    param([Parameter(Mandatory)][string]$Value)

    $parsed = [System.DateTimeOffset]::MinValue
    if ($Value.Length -gt 64 -or -not [System.DateTimeOffset]::TryParseExact(
        $Value,
        'o',
        [System.Globalization.CultureInfo]::InvariantCulture,
        [System.Globalization.DateTimeStyles]::RoundtripKind,
        [ref]$parsed
    )) { throw 'BOOTSTRAP_TIMESTAMP_INVALID' }
}

function Assert-DysonGameBootstrapHash {
    param([Parameter(Mandatory)][string]$Value)
    if ($Value -cnotmatch '^[0-9a-f]{64}$') { throw 'BOOTSTRAP_HASH_INVALID' }
}

function Test-DysonGameBootstrapJsonInteger {
    param($Value)
    return $Value -is [byte] -or $Value -is [int16] -or $Value -is [int32] -or $Value -is [int64]
}

function Read-DysonGameBootstrapLayout {
    param([Parameter(Mandatory)][string]$BootstrapRoot)

    $bootstrap = Assert-DysonGameBootstrapPlainDirectory -Path $BootstrapRoot
    $layoutPath = [System.IO.Path]::Combine($bootstrap, $script:DysonGameBootstrapLayoutName)
    $record = Read-DysonGameBootstrapJsonFile -Path $layoutPath -MaximumBytes $script:DysonMaximumLayoutBytes
    $layout = $record.value
    Assert-DysonGameBootstrapExactProperties -Value $layout -Names @(
        'protocol', 'schemaVersion', 'dataRoot', 'dataRootIdentity', 'createdAt'
    )
    if ($layout.protocol -isnot [string] -or
        [string]$layout.protocol -cne $script:DysonGameBootstrapLayoutProtocol -or
        -not (Test-DysonGameBootstrapJsonInteger -Value $layout.schemaVersion) -or
        [int64]$layout.schemaVersion -ne 1 -or
        $layout.dataRoot -isnot [string] -or
        $layout.dataRootIdentity -isnot [string] -or
        $layout.createdAt -isnot [string]) {
        throw 'BOOTSTRAP_LAYOUT_SCHEMA_INVALID'
    }
    $dataRootValue = [string]$layout.dataRoot
    if ($dataRootValue.Length -gt 1024 -or -not [System.IO.Path]::IsPathRooted($dataRootValue)) {
        throw 'BOOTSTRAP_LAYOUT_PATH_INVALID'
    }
    $dataRoot = Assert-DysonGameBootstrapPlainDirectory -Path $dataRootValue
    if (-not [string]::Equals(
        $dataRootValue,
        $dataRoot,
        [System.StringComparison]::OrdinalIgnoreCase
    )) { throw 'BOOTSTRAP_LAYOUT_PATH_INVALID' }
    Assert-DysonGameBootstrapHash -Value ([string]$layout.dataRootIdentity)
    $dataRootIdentity = Get-DysonGameBootstrapPathIdentity -Path $dataRoot
    if ($dataRootIdentity -cne [string]$layout.dataRootIdentity) {
        throw 'BOOTSTRAP_LAYOUT_IDENTITY_INVALID'
    }
    Assert-DysonGameBootstrapTimestamp -Value ([string]$layout.createdAt)
    return [pscustomobject][ordered]@{
        protocol = $script:DysonGameBootstrapLayoutProtocol
        schemaVersion = 1
        dataRoot = $dataRoot
        dataRootIdentity = $dataRootIdentity
        createdAt = [string]$layout.createdAt
        layoutSha256 = [string]$record.sha256
    }
}

function Write-DysonGameBootstrapLayout {
    param(
        [Parameter(Mandatory)][string]$BootstrapRoot,
        [Parameter(Mandatory)][string]$DataRoot
    )

    $bootstrap = Assert-DysonGameBootstrapPlainDirectory -Path $BootstrapRoot
    if (-not [System.IO.Path]::IsPathRooted($DataRoot) -or $DataRoot.Length -gt 1024) {
        throw 'BOOTSTRAP_LAYOUT_PATH_INVALID'
    }
    $data = Assert-DysonGameBootstrapPlainDirectory -Path $DataRoot
    $layoutPath = [System.IO.Path]::Combine($bootstrap, $script:DysonGameBootstrapLayoutName)
    if ([System.IO.File]::Exists($layoutPath) -or [System.IO.Directory]::Exists($layoutPath)) {
        throw 'BOOTSTRAP_LAYOUT_ALREADY_PRESENT'
    }
    $dataRootIdentity = Get-DysonGameBootstrapPathIdentity -Path $data
    $layout = [ordered]@{
        protocol = $script:DysonGameBootstrapLayoutProtocol
        schemaVersion = 1
        dataRoot = $data
        dataRootIdentity = $dataRootIdentity
        createdAt = [System.DateTimeOffset]::UtcNow.ToString('o')
    }
    $bytes = [System.Text.UTF8Encoding]::new($false).GetBytes(
        ($layout | Microsoft.PowerShell.Utility\ConvertTo-Json -Depth 6 -Compress)
    )
    if ($bytes.Length -lt 1 -or $bytes.Length -gt $script:DysonMaximumLayoutBytes) {
        throw 'BOOTSTRAP_LAYOUT_SCHEMA_INVALID'
    }
    $temporary = [System.IO.Path]::Combine(
        $bootstrap,
        '.partial-bootstrap-layout-' + [guid]::NewGuid().ToString('N')
    )
    $stream = $null
    try {
        $stream = [System.IO.FileStream]::new(
            $temporary,
            [System.IO.FileMode]::CreateNew,
            [System.IO.FileAccess]::Write,
            [System.IO.FileShare]::None
        )
        $stream.Write($bytes, 0, $bytes.Length)
        $stream.Flush($true)
        $stream.Dispose()
        $stream = $null
        [System.IO.File]::Move($temporary, $layoutPath)
    }
    catch { throw 'BOOTSTRAP_LAYOUT_WRITE_FAILED' }
    finally {
        if ($stream) { $stream.Dispose() }
        if ([System.IO.File]::Exists($temporary)) { [System.IO.File]::Delete($temporary) }
    }
    $persisted = Read-DysonGameBootstrapLayout -BootstrapRoot $bootstrap
    if (-not [string]::Equals(
        [string]$persisted.dataRoot,
        $data,
        [System.StringComparison]::OrdinalIgnoreCase
    ) -or [string]$persisted.dataRootIdentity -cne $dataRootIdentity) {
        throw 'BOOTSTRAP_LAYOUT_WRITE_FAILED'
    }
    return [pscustomobject][ordered]@{
        protocol = $script:DysonGameBootstrapLayoutProtocol
        state = 'written'
        schemaVersion = 1
        dataRootIdentity = $dataRootIdentity
        layoutSha256 = [string]$persisted.layoutSha256
    }
}

function Get-DysonGameBootstrapContext {
    param([Parameter(Mandatory)][string]$BootstrapRoot)

    $bootstrap = Assert-DysonGameBootstrapPlainDirectory -Path $BootstrapRoot
    if (-not [string]::Equals(
        [System.IO.Path]::GetFileName($bootstrap.TrimEnd('\', '/')),
        'bootstrap',
        [System.StringComparison]::OrdinalIgnoreCase
    )) { throw 'BOOTSTRAP_LOCATION_INVALID' }
    $layout = Read-DysonGameBootstrapLayout -BootstrapRoot $bootstrap
    $install = Assert-DysonGameBootstrapPlainDirectory -Path ([System.IO.Directory]::GetParent($bootstrap).FullName)
    $releases = Assert-DysonGameBootstrapPlainDirectory -Path ([System.IO.Path]::Combine($install, 'releases'))
    $data = [string]$layout.dataRoot
    $state = Assert-DysonGameBootstrapPlainDirectory -Path ([System.IO.Path]::Combine($data, 'state'))
    return [pscustomobject][ordered]@{
        bootstrapRoot = $bootstrap
        installRoot = $install
        releasesRoot = $releases
        dataRoot = $data
        dataRootIdentity = [string]$layout.dataRootIdentity
        layoutSha256 = [string]$layout.layoutSha256
        stateRoot = $state
        activePointerPath = [System.IO.Path]::Combine($state, $script:DysonActivePointerName)
        bindingPath = [System.IO.Path]::Combine($state, $script:DysonGameBindingName)
        runtimeReceiptRoot = [System.IO.Path]::Combine($state, $script:DysonGameRuntimeReceiptDirectoryName)
        expectedExitPath = [System.IO.Path]::Combine($state, $script:DysonGameExpectedExitName)
        expectedExitPendingPath = [System.IO.Path]::Combine($state, $script:DysonGameExpectedExitPendingName)
        expectedExitRecoveryPath = [System.IO.Path]::Combine($state, $script:DysonGameExpectedExitRecoveryName)
        expectedExitDiscardPath = [System.IO.Path]::Combine($state, $script:DysonGameExpectedExitDiscardName)
        stateLockPath = [System.IO.Path]::Combine($state, 'game-lifecycle-state.lock')
        startLockPath = [System.IO.Path]::Combine($state, 'game-lifecycle-start.lock')
    }
}

function Assert-DysonGameBootstrapCanonicalGuid {
    param([Parameter(Mandatory)][string]$Value)

    $parsed = [guid]::Empty
    if (-not [guid]::TryParseExact($Value, 'D', [ref]$parsed) -or
        $parsed.ToString('D').ToLowerInvariant() -cne $Value) {
        throw 'BOOTSTRAP_GUID_INVALID'
    }
}

function Get-DysonGameBootstrapRuntimeReceiptRoot {
    param([Parameter(Mandatory)]$Context)

    $candidate = Get-DysonGameBootstrapFullPath -Path ([string]$Context.runtimeReceiptRoot)
    if (-not (Test-DysonGameBootstrapPathWithin -Candidate $candidate -Parent $Context.stateRoot)) {
        throw 'BOOTSTRAP_RUNTIME_RECEIPT_ROOT_INVALID'
    }
    try {
        $item = [System.IO.DirectoryInfo]::new($candidate)
        $item.Refresh()
        if (-not $item.Exists) {
            [void][System.IO.Directory]::CreateDirectory($candidate)
            $item.Refresh()
        }
        if (-not $item.Exists -or ($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint)) {
            throw 'invalid runtime receipt directory'
        }
        return $item.FullName
    }
    catch { throw 'BOOTSTRAP_RUNTIME_RECEIPT_ROOT_INVALID' }
}

function Write-DysonGameBootstrapRuntimeReceipt {
    param(
        [Parameter(Mandatory)]$Context,
        [Parameter(Mandatory)][string]$AttemptId,
        [AllowNull()][string]$BindingId,
        [AllowNull()][string]$Version,
        [Parameter(Mandatory)][ValidateSet('clean-exit', 'abnormal-exit', 'startup-failure', 'finalization-failure')][string]$Outcome,
        [AllowNull()][string]$ErrorCode,
        [Parameter(Mandatory)][bool]$RestartExpected,
        [Parameter(Mandatory)][string]$StartedAt,
        [AllowNull()][string]$PublishedAt,
        [Parameter(Mandatory)][string]$CompletedAt,
        [AllowNull()][string]$ProjectRootSha256,
        [AllowNull()]$FinalSaveProof
    )

    # Windows PowerShell 5.1 coerces an explicitly bound `$null` string
    # argument to an empty string even when AllowNull is present. Normalize
    # only that exact representation; whitespace remains invalid input.
    $normalizedBindingId = if ($BindingId -ceq '') { $null } else { [string]$BindingId }
    $normalizedVersion = if ($Version -ceq '') { $null } else { [string]$Version }
    $normalizedErrorCode = if ($ErrorCode -ceq '') { $null } else { [string]$ErrorCode }
    $normalizedPublishedAt = if ($PublishedAt -ceq '') { $null } else { [string]$PublishedAt }
    $normalizedProjectRootSha256 = if ($ProjectRootSha256 -ceq '') { $null } else { [string]$ProjectRootSha256 }
    Assert-DysonGameBootstrapCanonicalGuid -Value $AttemptId
    if ($null -ne $normalizedBindingId) { Assert-DysonGameBootstrapCanonicalGuid -Value $normalizedBindingId }
    if ($null -ne $normalizedVersion) { Assert-DysonGameBootstrapVersion -Version $normalizedVersion }
    Assert-DysonGameBootstrapTimestamp -Value $StartedAt
    if ($null -ne $normalizedPublishedAt) { Assert-DysonGameBootstrapTimestamp -Value $normalizedPublishedAt }
    Assert-DysonGameBootstrapTimestamp -Value $CompletedAt
    if ($null -ne $normalizedProjectRootSha256) { Assert-DysonGameBootstrapHash -Value $normalizedProjectRootSha256 }
    if ($null -ne $normalizedErrorCode -and $normalizedErrorCode -cnotmatch '^BOOTSTRAP_[A-Z0-9_]{1,96}$') {
        throw 'BOOTSTRAP_RUNTIME_RECEIPT_SCHEMA_INVALID'
    }
    if (($Outcome -ceq 'clean-exit' -and ($null -ne $normalizedErrorCode -or $RestartExpected)) -or
        ($Outcome -cne 'clean-exit' -and ($null -eq $normalizedErrorCode -or -not $RestartExpected)) -or
        ($Outcome -cin @('abnormal-exit', 'finalization-failure') -and $null -eq $normalizedPublishedAt) -or
        ($Outcome -ceq 'startup-failure' -and $null -ne $normalizedPublishedAt)) {
        throw 'BOOTSTRAP_RUNTIME_RECEIPT_SCHEMA_INVALID'
    }
    $dataRootIdentity = [string]$Context.dataRootIdentity
    Assert-DysonGameBootstrapHash -Value $dataRootIdentity
    $receipt = [ordered]@{
        protocol = $script:DysonGameRuntimeReceiptProtocol
        schemaVersion = 1
        attemptId = $AttemptId
        bindingId = $normalizedBindingId
        version = $normalizedVersion
        outcome = $Outcome
        errorCode = $normalizedErrorCode
        restartExpected = $RestartExpected
        startedAt = $StartedAt
        publishedAt = $normalizedPublishedAt
        completedAt = $CompletedAt
        projectRootSha256 = $normalizedProjectRootSha256
        dataRootIdentity = $dataRootIdentity
    }
    if ($null -ne $FinalSaveProof) {
        $proofKeys = @('protocol', 'stopIntentSha256', 'capturedAt', 'saveName', 'dsvBytes', 'dsvSha256', 'serverBytes', 'serverSha256')
        $actualKeys = if ($FinalSaveProof -is [System.Collections.IDictionary]) { @($FinalSaveProof.Keys) }
            else { @($FinalSaveProof.PSObject.Properties.Name) }
        if (($actualKeys -join ',') -cne ($proofKeys -join ',') -or $Outcome -cne 'clean-exit' -or
            $null -eq $normalizedBindingId -or $null -eq $normalizedPublishedAt -or
            [string]$FinalSaveProof.protocol -cne 'DYSON_CONTROL_STOPPED_SAVE_PROOF_V1' -or
            [string]$FinalSaveProof.saveName -cne '_lastexit_') { throw 'BOOTSTRAP_FINAL_SAVE_PROOF_INVALID' }
        foreach ($field in @('stopIntentSha256', 'dsvSha256', 'serverSha256')) {
            Assert-DysonGameBootstrapHash -Value ([string]$FinalSaveProof.$field)
        }
        Assert-DysonGameBootstrapTimestamp -Value ([string]$FinalSaveProof.capturedAt)
        $captured = [datetimeoffset]::Parse([string]$FinalSaveProof.capturedAt)
        if ($captured -lt [datetimeoffset]::Parse($normalizedPublishedAt) -or
            $captured -gt [datetimeoffset]::Parse($CompletedAt)) { throw 'BOOTSTRAP_FINAL_SAVE_PROOF_INVALID' }
        foreach ($field in @('dsvBytes', 'serverBytes')) {
            if ($FinalSaveProof.$field -isnot [long] -and $FinalSaveProof.$field -isnot [int]) {
                throw 'BOOTSTRAP_FINAL_SAVE_PROOF_INVALID'
            }
            if ($FinalSaveProof.$field -lt 1 -or $FinalSaveProof.$field -gt 9007199254740991) {
                throw 'BOOTSTRAP_FINAL_SAVE_PROOF_INVALID'
            }
        }
        $receipt.finalSaveProof = $FinalSaveProof
    }
    $bytes = [System.Text.UTF8Encoding]::new($false).GetBytes(
        ($receipt | Microsoft.PowerShell.Utility\ConvertTo-Json -Depth 6 -Compress)
    )
    if ($bytes.Length -lt 2 -or $bytes.Length -gt $script:DysonMaximumRuntimeReceiptBytes) {
        throw 'BOOTSTRAP_RUNTIME_RECEIPT_SCHEMA_INVALID'
    }
    $root = Get-DysonGameBootstrapRuntimeReceiptRoot -Context $Context
    $path = [System.IO.Path]::Combine($root, $AttemptId + '.json')
    if ([System.IO.File]::Exists($path) -or [System.IO.Directory]::Exists($path)) {
        throw 'BOOTSTRAP_RUNTIME_RECEIPT_CONFLICT'
    }
    $temporary = [System.IO.Path]::Combine($root, '.partial-' + $AttemptId + '-' + [guid]::NewGuid().ToString('N'))
    $stream = $null
    $failureStage = 'TEMP_CREATE'
    try {
        $stream = [System.IO.FileStream]::new(
            $temporary,
            [System.IO.FileMode]::CreateNew,
            [System.IO.FileAccess]::Write,
            [System.IO.FileShare]::None
        )
        $failureStage = 'WRITE'
        $stream.Write($bytes, 0, $bytes.Length)
        $stream.Flush($true)
        $stream.Dispose()
        $stream = $null
        $failureStage = 'PUBLISH'
        [System.IO.File]::Move($temporary, $path)
    }
    catch {
        $baseException = $_.Exception.GetBaseException()
        $failureClass = if ($baseException -is [System.UnauthorizedAccessException]) { 'ACCESS_DENIED' }
            elseif ($baseException -is [System.IO.IOException]) {
                'IO_' + ('{0:X8}' -f ($baseException.HResult -band 0xffffffff))
            }
            else { 'FAILED' }
        throw ('BOOTSTRAP_RUNTIME_RECEIPT_' + $failureStage + '_' + $failureClass)
    }
    finally {
        if ($stream) { $stream.Dispose() }
        if ([System.IO.File]::Exists($temporary)) { [System.IO.File]::Delete($temporary) }
    }
    try {
        $persisted = Read-DysonGameBootstrapJsonFile -Path $path -MaximumBytes $script:DysonMaximumRuntimeReceiptBytes
    }
    catch { throw 'BOOTSTRAP_RUNTIME_RECEIPT_VERIFY_FAILED' }
    if ([string]$persisted.sha256 -cne (Get-DysonGameBootstrapSha256Bytes -Bytes $bytes)) {
        throw 'BOOTSTRAP_RUNTIME_RECEIPT_WRITE_FAILED'
    }
    return [pscustomobject][ordered]@{
        protocol = $script:DysonGameRuntimeReceiptProtocol
        state = 'persisted'
        attemptId = $AttemptId
        outcome = $Outcome
        receiptSha256 = [string]$persisted.sha256
    }
}

function Get-DysonGameBootstrapExpectedExitPaths {
    param([Parameter(Mandatory)]$Context)

    $stateRoot = Assert-DysonGameBootstrapPlainDirectory -Path ([string]$Context.stateRoot)
    $paths = [pscustomobject][ordered]@{
        canonical = [System.IO.Path]::Combine($stateRoot, $script:DysonGameExpectedExitName)
        pending = [System.IO.Path]::Combine($stateRoot, $script:DysonGameExpectedExitPendingName)
        recovery = [System.IO.Path]::Combine($stateRoot, $script:DysonGameExpectedExitRecoveryName)
        discard = [System.IO.Path]::Combine($stateRoot, $script:DysonGameExpectedExitDiscardName)
    }
    foreach ($name in @('canonical', 'pending', 'recovery', 'discard')) {
        $path = Get-DysonGameBootstrapFullPath -Path ([string]$paths.$name)
        if (-not (Test-DysonGameBootstrapPathWithin -Candidate $path -Parent $stateRoot)) {
            throw 'BOOTSTRAP_EXPECTED_EXIT_INVALID'
        }
        $paths.$name = $path
    }
    return $paths
}

function Invoke-DysonGameBootstrapExpectedExitFault {
    param(
        [Parameter(Mandatory)][string]$Phase,
        [Parameter(Mandatory)]$Context
    )

    if ($null -ne $script:DysonGameBootstrapExpectedExitFaultHook) {
        & $script:DysonGameBootstrapExpectedExitFaultHook $Phase $Context | Out-Null
    }
}

function Get-DysonGameBootstrapExpectedExitSecurity {
    param([Parameter(Mandatory)][string]$Path)

    try {
        $fullSections = [System.Security.AccessControl.AccessControlSections]::Owner -bor
            [System.Security.AccessControl.AccessControlSections]::Group -bor
            [System.Security.AccessControl.AccessControlSections]::Access
        $acl = [System.IO.File]::GetAccessControl($Path, $fullSections)
        return [pscustomobject][ordered]@{
            aclSddl = $acl.GetSecurityDescriptorSddlForm($fullSections)
            accessSddl = $acl.GetSecurityDescriptorSddlForm(
                [System.Security.AccessControl.AccessControlSections]::Access
            )
        }
    }
    catch { throw 'BOOTSTRAP_EXPECTED_EXIT_INVALID' }
}

function Test-DysonGameBootstrapExpectedExitSecurityEqual {
    param(
        [Parameter(Mandatory)]$Left,
        [Parameter(Mandatory)]$Right
    )

    try {
        # NTFS may toggle only SE_DACL_AUTO_INHERITED while preserving the
        # owner, primary group, protection bit, and every inherited ACE. Treat
        # that filesystem normalization as equivalent, but compare the actual
        # DACL binary so any permission or inheritance change still fails.
        $leftDescriptor = [System.Security.AccessControl.RawSecurityDescriptor]::new(
            [string]$Left.aclSddl
        )
        $rightDescriptor = [System.Security.AccessControl.RawSecurityDescriptor]::new(
            [string]$Right.aclSddl
        )
        if ($null -eq $leftDescriptor.Owner -or $null -eq $rightDescriptor.Owner -or
            [string]$leftDescriptor.Owner.Value -cne [string]$rightDescriptor.Owner.Value) {
            return $false
        }
        if ($null -eq $leftDescriptor.Group -or $null -eq $rightDescriptor.Group -or
            [string]$leftDescriptor.Group.Value -cne [string]$rightDescriptor.Group.Value) {
            return $false
        }
        $securityFlags = [System.Security.AccessControl.ControlFlags]::DiscretionaryAclPresent -bor
            [System.Security.AccessControl.ControlFlags]::DiscretionaryAclDefaulted -bor
            [System.Security.AccessControl.ControlFlags]::DiscretionaryAclProtected
        if (($leftDescriptor.ControlFlags -band $securityFlags) -ne
            ($rightDescriptor.ControlFlags -band $securityFlags)) { return $false }
        if (($null -eq $leftDescriptor.DiscretionaryAcl) -ne
            ($null -eq $rightDescriptor.DiscretionaryAcl)) { return $false }
        if ($null -ne $leftDescriptor.DiscretionaryAcl) {
            $leftBytes = [byte[]]::new($leftDescriptor.DiscretionaryAcl.BinaryLength)
            $rightBytes = [byte[]]::new($rightDescriptor.DiscretionaryAcl.BinaryLength)
            $leftDescriptor.DiscretionaryAcl.GetBinaryForm($leftBytes, 0)
            $rightDescriptor.DiscretionaryAcl.GetBinaryForm($rightBytes, 0)
            if ($leftBytes.Length -ne $rightBytes.Length) { return $false }
            for ($index = 0; $index -lt $leftBytes.Length; $index++) {
                if ($leftBytes[$index] -ne $rightBytes[$index]) { return $false }
            }
        }
        return $true
    }
    catch { return $false }
}

function Set-DysonGameBootstrapExpectedExitSecurity {
    param(
        [Parameter(Mandatory)][string]$Path,
        [Parameter(Mandatory)][string]$AclSddl
    )

    if ([string]::IsNullOrWhiteSpace($AclSddl) -or $AclSddl.Length -gt 16384) {
        throw 'BOOTSTRAP_EXPECTED_EXIT_INVALID'
    }
    try {
        $expectedDescriptor = [System.Security.AccessControl.RawSecurityDescriptor]::new($AclSddl)
        $currentSecurity = Get-DysonGameBootstrapExpectedExitSecurity -Path $Path
        $currentDescriptor = [System.Security.AccessControl.RawSecurityDescriptor]::new($currentSecurity.aclSddl)
        # An owning game account can update its DACL without WRITE_OWNER.
        # Do not request owner/group writes when their values are unchanged.
        $sections = [System.Security.AccessControl.AccessControlSections]::Access
        if ([string]$currentDescriptor.Owner.Value -cne [string]$expectedDescriptor.Owner.Value) {
            $sections = $sections -bor [System.Security.AccessControl.AccessControlSections]::Owner
        }
        if ([string]$currentDescriptor.Group.Value -cne [string]$expectedDescriptor.Group.Value) {
            $sections = $sections -bor [System.Security.AccessControl.AccessControlSections]::Group
        }
        $acl = [System.Security.AccessControl.FileSecurity]::new()
        $acl.SetSecurityDescriptorSddlForm($AclSddl, $sections)
        [System.IO.File]::SetAccessControl($Path, $acl)
        $persisted = Get-DysonGameBootstrapExpectedExitSecurity -Path $Path
        $expectedDescriptor = [System.Security.AccessControl.RawSecurityDescriptor]::new($AclSddl)
        $expected = [pscustomobject][ordered]@{
            aclSddl = $AclSddl
            accessSddl = $expectedDescriptor.GetSddlForm(
                [System.Security.AccessControl.AccessControlSections]::Access
            )
        }
        if (-not (Test-DysonGameBootstrapExpectedExitSecurityEqual -Left $persisted -Right $expected)) {
            throw 'security verification failed'
        }
    }
    catch { throw 'BOOTSTRAP_EXPECTED_EXIT_WRITE_FAILED' }
}

function Assert-DysonGameBootstrapExpectedExitBinding {
    param(
        [Parameter(Mandatory)]$Binding,
        [Parameter(Mandatory)]$Context
    )

    if ($null -eq $Binding -or $Binding -is [System.Array] -or $Binding -is [string]) {
        throw 'BOOTSTRAP_EXPECTED_EXIT_INVALID'
    }
    foreach ($name in @('bindingId', 'version', 'projectRootSha256', 'dataRootIdentity')) {
        $present = $false
        $propertyValue = $null
        if ($Binding -is [System.Collections.IDictionary]) {
            $present = $Binding.Contains($name)
            if ($present) { $propertyValue = $Binding[$name] }
        }
        else {
            $property = $Binding.PSObject.Properties[$name]
            $present = $null -ne $property
            if ($present) { $propertyValue = $property.Value }
        }
        if (-not $present -or $propertyValue -isnot [string]) {
            throw 'BOOTSTRAP_EXPECTED_EXIT_INVALID'
        }
    }
    Assert-DysonGameBootstrapCanonicalGuid -Value ([string]$Binding.bindingId)
    Assert-DysonGameBootstrapVersion -Version ([string]$Binding.version)
    Assert-DysonGameBootstrapHash -Value ([string]$Binding.projectRootSha256)
    Assert-DysonGameBootstrapHash -Value ([string]$Binding.dataRootIdentity)
    if ([string]$Binding.dataRootIdentity -cne [string]$Context.dataRootIdentity) {
        throw 'BOOTSTRAP_EXPECTED_EXIT_INVALID'
    }
}

function ConvertTo-DysonGameBootstrapExpectedExitBytes {
    param([Parameter(Mandatory)]$Value)

    $bytes = [System.Text.UTF8Encoding]::new($false).GetBytes(
        ($Value | Microsoft.PowerShell.Utility\ConvertTo-Json -Depth 6 -Compress)
    )
    if ($bytes.Length -lt 2 -or $bytes.Length -gt $script:DysonMaximumExpectedExitBytes) {
        throw 'BOOTSTRAP_EXPECTED_EXIT_INVALID'
    }
    return $bytes
}

function Assert-DysonGameBootstrapExpectedExitValue {
    param(
        [Parameter(Mandatory)]$Value,
        [Parameter(Mandatory)]$Context
    )

    $names = @(
        'protocol', 'schemaVersion', 'bindingId', 'version', 'projectRootSha256',
        'dataRootIdentity', 'state', 'requestedAt', 'completedAt'
    )
    Assert-DysonGameBootstrapExactProperties -Value $Value -Names $names
    $actualNames = @($Value.PSObject.Properties | ForEach-Object { [string]$_.Name })
    for ($index = 0; $index -lt $names.Count; $index += 1) {
        if ($actualNames[$index] -cne $names[$index]) { throw 'BOOTSTRAP_EXPECTED_EXIT_INVALID' }
    }
    foreach ($name in @(
        'protocol', 'bindingId', 'version', 'projectRootSha256',
        'dataRootIdentity', 'state', 'requestedAt'
    )) {
        if ($Value.PSObject.Properties[$name].Value -isnot [string]) {
            throw 'BOOTSTRAP_EXPECTED_EXIT_INVALID'
        }
    }
    if ([string]$Value.protocol -cne $script:DysonGameExpectedExitProtocol -or
        -not (Test-DysonGameBootstrapJsonInteger -Value $Value.schemaVersion) -or
        [int64]$Value.schemaVersion -ne 1 -or
        [string]$Value.state -cnotin @('requested', 'completed')) {
        throw 'BOOTSTRAP_EXPECTED_EXIT_INVALID'
    }
    Assert-DysonGameBootstrapCanonicalGuid -Value ([string]$Value.bindingId)
    Assert-DysonGameBootstrapVersion -Version ([string]$Value.version)
    Assert-DysonGameBootstrapHash -Value ([string]$Value.projectRootSha256)
    Assert-DysonGameBootstrapHash -Value ([string]$Value.dataRootIdentity)
    if ([string]$Value.dataRootIdentity -cne [string]$Context.dataRootIdentity) {
        throw 'BOOTSTRAP_EXPECTED_EXIT_INVALID'
    }
    Assert-DysonGameBootstrapTimestamp -Value ([string]$Value.requestedAt)
    if ([string]$Value.state -ceq 'requested') {
        if ($null -ne $Value.completedAt) { throw 'BOOTSTRAP_EXPECTED_EXIT_INVALID' }
    }
    else {
        if ($Value.completedAt -isnot [string]) { throw 'BOOTSTRAP_EXPECTED_EXIT_INVALID' }
        Assert-DysonGameBootstrapTimestamp -Value ([string]$Value.completedAt)
        $requested = [System.DateTimeOffset]::MinValue
        $completed = [System.DateTimeOffset]::MinValue
        $style = [System.Globalization.DateTimeStyles]::RoundtripKind
        $culture = [System.Globalization.CultureInfo]::InvariantCulture
        if (-not [System.DateTimeOffset]::TryParseExact(
            [string]$Value.requestedAt, 'o', $culture, $style, [ref]$requested
        ) -or -not [System.DateTimeOffset]::TryParseExact(
            [string]$Value.completedAt, 'o', $culture, $style, [ref]$completed
        ) -or $completed -lt $requested) {
            throw 'BOOTSTRAP_EXPECTED_EXIT_INVALID'
        }
    }
}

function Read-DysonGameBootstrapExpectedExitFile {
    param(
        [Parameter(Mandatory)]$Context,
        [Parameter(Mandatory)][string]$Path,
        [switch]$AllowMissing
    )

    $full = Get-DysonGameBootstrapFullPath -Path $Path
    if (-not (Test-DysonGameBootstrapPathWithin -Candidate $full -Parent $Context.stateRoot)) {
        throw 'BOOTSTRAP_EXPECTED_EXIT_INVALID'
    }
    $item = [System.IO.FileInfo]::new($full)
    $item.Refresh()
    if (-not $item.Exists) {
        if ([System.IO.Directory]::Exists($full)) { throw 'BOOTSTRAP_EXPECTED_EXIT_INVALID' }
        if ($AllowMissing) { return $null }
        throw 'BOOTSTRAP_EXPECTED_EXIT_MISSING'
    }
    try {
        $record = Read-DysonGameBootstrapJsonFile -Path $full `
            -MaximumBytes $script:DysonMaximumExpectedExitBytes
        Assert-DysonGameBootstrapExpectedExitValue -Value $record.value -Context $Context
        $canonicalBytes = ConvertTo-DysonGameBootstrapExpectedExitBytes -Value $record.value
        if ([string]$record.sha256 -cne (Get-DysonGameBootstrapSha256Bytes -Bytes $canonicalBytes)) {
            throw 'expected exit bytes are not canonical'
        }
        $security = Get-DysonGameBootstrapExpectedExitSecurity -Path $full
        return [pscustomobject][ordered]@{
            value = $record.value
            sha256 = [string]$record.sha256
            path = $full
            aclSddl = [string]$security.aclSddl
            accessSddl = [string]$security.accessSddl
        }
    }
    catch { throw 'BOOTSTRAP_EXPECTED_EXIT_INVALID' }
}

function Assert-DysonGameBootstrapExpectedExitTransition {
    param(
        [Parameter(Mandatory)]$Requested,
        [Parameter(Mandatory)]$Completed
    )

    if ([string]$Requested.value.state -cne 'requested' -or
        [string]$Completed.value.state -cne 'completed') {
        throw 'BOOTSTRAP_EXPECTED_EXIT_RECOVERY_REQUIRED'
    }
    foreach ($name in @(
        'protocol', 'schemaVersion', 'bindingId', 'version', 'projectRootSha256',
        'dataRootIdentity', 'requestedAt'
    )) {
        if ($Requested.value.$name -cne $Completed.value.$name) {
            throw 'BOOTSTRAP_EXPECTED_EXIT_RECOVERY_REQUIRED'
        }
    }
}

function Assert-DysonGameBootstrapExpectedExitMatchesBinding {
    param(
        [Parameter(Mandatory)]$ExpectedExit,
        [Parameter(Mandatory)]$Binding,
        [Parameter(Mandatory)]$Context
    )

    Assert-DysonGameBootstrapExpectedExitBinding -Binding $Binding -Context $Context
    foreach ($name in @('bindingId', 'version', 'projectRootSha256', 'dataRootIdentity')) {
        if ($ExpectedExit.value.$name -cne $Binding.$name) {
            throw 'BOOTSTRAP_EXPECTED_EXIT_CONFLICT'
        }
    }
}

function Get-DysonGameBootstrapExpectedExitArtifact {
    param([Parameter(Mandatory)]$Context)

    $paths = Get-DysonGameBootstrapExpectedExitPaths -Context $Context
    $stateRoot = Assert-DysonGameBootstrapPlainDirectory -Path ([string]$Context.stateRoot)
    $artifacts = [System.Collections.Generic.List[object]]::new()
    try { $entries = @([System.IO.DirectoryInfo]::new($stateRoot).GetFileSystemInfos()) }
    catch { throw 'BOOTSTRAP_EXPECTED_EXIT_RECOVERY_REQUIRED' }
    foreach ($entry in $entries) {
        if ($entry.Name.IndexOf('expected-exit', [System.StringComparison]::OrdinalIgnoreCase) -lt 0) {
            continue
        }
        $kind = switch -CaseSensitive ([string]$entry.Name) {
            $script:DysonGameExpectedExitName { 'canonical'; break }
            $script:DysonGameExpectedExitPendingName { 'pending'; break }
            $script:DysonGameExpectedExitRecoveryName { 'recovery'; break }
            $script:DysonGameExpectedExitDiscardName { 'discard'; break }
            default { $null }
        }
        if ($null -eq $kind) { throw 'BOOTSTRAP_EXPECTED_EXIT_RECOVERY_REQUIRED' }
        if ($entry -isnot [System.IO.FileInfo] -or
            ($entry.Attributes -band [System.IO.FileAttributes]::ReparsePoint)) {
            throw 'BOOTSTRAP_EXPECTED_EXIT_RECOVERY_REQUIRED'
        }
        if ($kind -cne 'canonical') {
            $artifacts.Add([pscustomobject][ordered]@{ kind = $kind; path = $entry.FullName })
        }
    }
    if ($artifacts.Count -gt 1) { throw 'BOOTSTRAP_EXPECTED_EXIT_RECOVERY_REQUIRED' }
    if ($artifacts.Count -eq 0) { return $null }
    return $artifacts[0]
}

function Write-DysonGameBootstrapExpectedExitFileCreateNew {
    param(
        [Parameter(Mandatory)]$Context,
        [Parameter(Mandatory)][string]$Path,
        [Parameter(Mandatory)][byte[]]$Bytes,
        [string]$AclSddl
    )

    $stream = $null
    try {
        $stream = [System.IO.FileStream]::new(
            $Path,
            [System.IO.FileMode]::CreateNew,
            [System.IO.FileAccess]::Write,
            [System.IO.FileShare]::None
        )
        $stream.Write($Bytes, 0, $Bytes.Length)
        $stream.Flush($true)
        $stream.Dispose()
        $stream = $null
        if (-not [string]::IsNullOrEmpty($AclSddl)) {
            Set-DysonGameBootstrapExpectedExitSecurity -Path $Path -AclSddl $AclSddl
        }
        return Read-DysonGameBootstrapExpectedExitFile -Context $Context -Path $Path
    }
    catch { throw 'BOOTSTRAP_EXPECTED_EXIT_WRITE_FAILED' }
    finally { if ($stream) { $stream.Dispose() } }
}

function Resolve-DysonGameBootstrapExpectedExitState {
    param([Parameter(Mandatory)]$Context)

    $paths = Get-DysonGameBootstrapExpectedExitPaths -Context $Context
    $artifact = Get-DysonGameBootstrapExpectedExitArtifact -Context $Context
    if ($null -eq $artifact) {
        return Read-DysonGameBootstrapExpectedExitFile `
            -Context $Context -Path $paths.canonical -AllowMissing
    }

    if ([string]$artifact.kind -ceq 'pending') {
        $canonical = Read-DysonGameBootstrapExpectedExitFile `
            -Context $Context -Path $paths.canonical -AllowMissing
        $pending = Read-DysonGameBootstrapExpectedExitFile -Context $Context -Path $paths.pending
        if ([string]$pending.value.state -ceq 'requested' -and $null -eq $canonical) {
            try { [System.IO.File]::Move($paths.pending, $paths.canonical) }
            catch { throw 'BOOTSTRAP_EXPECTED_EXIT_RECOVERY_REQUIRED' }
            $restored = Read-DysonGameBootstrapExpectedExitFile -Context $Context -Path $paths.canonical
            if ([string]$restored.sha256 -cne [string]$pending.sha256 -or
                -not (Test-DysonGameBootstrapExpectedExitSecurityEqual -Left $restored -Right $pending)) {
                throw 'BOOTSTRAP_EXPECTED_EXIT_RECOVERY_REQUIRED'
            }
            return $restored
        }
        if ([string]$pending.value.state -ceq 'completed' -and $null -ne $canonical) {
            Assert-DysonGameBootstrapExpectedExitTransition -Requested $canonical -Completed $pending
            if (-not (Test-DysonGameBootstrapExpectedExitSecurityEqual -Left $pending -Right $canonical)) {
                throw 'BOOTSTRAP_EXPECTED_EXIT_RECOVERY_REQUIRED'
            }
            try { [System.IO.File]::Delete($paths.pending) }
            catch { throw 'BOOTSTRAP_EXPECTED_EXIT_RECOVERY_REQUIRED' }
            if ([System.IO.File]::Exists($paths.pending) -or [System.IO.Directory]::Exists($paths.pending)) {
                throw 'BOOTSTRAP_EXPECTED_EXIT_RECOVERY_REQUIRED'
            }
            return $canonical
        }
        throw 'BOOTSTRAP_EXPECTED_EXIT_RECOVERY_REQUIRED'
    }

    if ([string]$artifact.kind -ceq 'recovery') {
        $recovery = Read-DysonGameBootstrapExpectedExitFile -Context $Context -Path $paths.recovery
        if ([string]$recovery.value.state -cne 'requested') {
            throw 'BOOTSTRAP_EXPECTED_EXIT_RECOVERY_REQUIRED'
        }
        $canonical = $null
        $canonicalWasInvalid = $false
        try {
            $canonical = Read-DysonGameBootstrapExpectedExitFile `
                -Context $Context -Path $paths.canonical -AllowMissing
        }
        catch {
            if (-not [System.IO.File]::Exists($paths.canonical)) { throw }
            $canonicalWasInvalid = $true
        }
        if ($null -eq $canonical) {
            if (-not $canonicalWasInvalid) {
                try { [System.IO.File]::Move($paths.recovery, $paths.canonical) }
                catch { throw 'BOOTSTRAP_EXPECTED_EXIT_RECOVERY_REQUIRED' }
                $restored = Read-DysonGameBootstrapExpectedExitFile `
                    -Context $Context -Path $paths.canonical
                if ([string]$restored.sha256 -cne [string]$recovery.sha256 -or
                    -not (Test-DysonGameBootstrapExpectedExitSecurityEqual -Left $restored -Right $recovery)) {
                    throw 'BOOTSTRAP_EXPECTED_EXIT_RECOVERY_REQUIRED'
                }
                return $restored
            }
        }
        if (-not $canonicalWasInvalid) {
            Assert-DysonGameBootstrapExpectedExitTransition -Requested $recovery -Completed $canonical
        }
        try {
            # File.Replace retains target security on Windows. Normalize the rejected
            # target to the old copy's DACL before the atomic rollback so a crash
            # immediately after Replace still leaves canonical bytes and ACL exact.
            $targetSecurity = Get-DysonGameBootstrapExpectedExitSecurity -Path $paths.canonical
            if (-not (Test-DysonGameBootstrapExpectedExitSecurityEqual -Left $targetSecurity -Right $recovery)) {
                Set-DysonGameBootstrapExpectedExitSecurity `
                    -Path $paths.canonical -AclSddl ([string]$recovery.aclSddl)
            }
            $preparedSecurity = Get-DysonGameBootstrapExpectedExitSecurity -Path $paths.canonical
            if (-not (Test-DysonGameBootstrapExpectedExitSecurityEqual -Left $preparedSecurity -Right $recovery)) {
                throw 'target ACL could not be prepared for exact rollback'
            }
            [System.IO.File]::Replace($paths.recovery, $paths.canonical, $paths.discard)
            Invoke-DysonGameBootstrapExpectedExitFault -Phase 'after-rollback-replace' -Context $Context
            $restored = Read-DysonGameBootstrapExpectedExitFile -Context $Context -Path $paths.canonical
            if ([string]$restored.sha256 -cne [string]$recovery.sha256 -or
                -not (Test-DysonGameBootstrapExpectedExitSecurityEqual -Left $restored -Right $recovery)) {
                throw 'rollback verification failed'
            }
            if ($canonicalWasInvalid) {
                $discardItem = [System.IO.FileInfo]::new($paths.discard)
                $discardItem.Refresh()
                if (-not $discardItem.Exists -or
                    ($discardItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -or
                    $discardItem.Length -gt $script:DysonMaximumExpectedExitBytes) {
                    throw 'invalid rollback discard'
                }
            }
            else {
                $discard = Read-DysonGameBootstrapExpectedExitFile -Context $Context -Path $paths.discard
                Assert-DysonGameBootstrapExpectedExitTransition -Requested $restored -Completed $discard
            }
            [System.IO.File]::Delete($paths.discard)
            if ([System.IO.File]::Exists($paths.discard) -or [System.IO.Directory]::Exists($paths.discard)) {
                throw 'rollback discard removal failed'
            }
            return $restored
        }
        catch { throw 'BOOTSTRAP_EXPECTED_EXIT_RECOVERY_REQUIRED' }
    }

    if ([string]$artifact.kind -ceq 'discard') {
        $canonical = Read-DysonGameBootstrapExpectedExitFile `
            -Context $Context -Path $paths.canonical -AllowMissing
        if ($null -eq $canonical -or [string]$canonical.value.state -cne 'requested') {
            throw 'BOOTSTRAP_EXPECTED_EXIT_RECOVERY_REQUIRED'
        }
        $discard = Read-DysonGameBootstrapExpectedExitFile -Context $Context -Path $paths.discard
        Assert-DysonGameBootstrapExpectedExitTransition -Requested $canonical -Completed $discard
        if (-not (Test-DysonGameBootstrapExpectedExitSecurityEqual -Left $discard -Right $canonical)) {
            throw 'BOOTSTRAP_EXPECTED_EXIT_RECOVERY_REQUIRED'
        }
        try { [System.IO.File]::Delete($paths.discard) }
        catch { throw 'BOOTSTRAP_EXPECTED_EXIT_RECOVERY_REQUIRED' }
        if ([System.IO.File]::Exists($paths.discard) -or [System.IO.Directory]::Exists($paths.discard)) {
            throw 'BOOTSTRAP_EXPECTED_EXIT_RECOVERY_REQUIRED'
        }
        return $canonical
    }
    throw 'BOOTSTRAP_EXPECTED_EXIT_RECOVERY_REQUIRED'
}

function Read-DysonGameBootstrapExpectedExit {
    param([Parameter(Mandatory)]$Context, [switch]$AllowMissing)

    $resolved = Resolve-DysonGameBootstrapExpectedExitState -Context $Context
    if ($null -eq $resolved -and -not $AllowMissing) { throw 'BOOTSTRAP_EXPECTED_EXIT_MISSING' }
    return $resolved
}

function Write-DysonGameBootstrapExpectedExitRequested {
    param(
        [Parameter(Mandatory)]$Context,
        [Parameter(Mandatory)]$Binding
    )

    Assert-DysonGameBootstrapExpectedExitBinding -Binding $Binding -Context $Context
    $current = Read-DysonGameBootstrapExpectedExit -Context $Context -AllowMissing
    if ($null -ne $current) {
        Assert-DysonGameBootstrapExpectedExitMatchesBinding `
            -ExpectedExit $current -Binding $Binding -Context $Context
        return $current
    }
    $value = [ordered]@{
        protocol = $script:DysonGameExpectedExitProtocol
        schemaVersion = 1
        bindingId = [string]$Binding.bindingId
        version = [string]$Binding.version
        projectRootSha256 = [string]$Binding.projectRootSha256
        dataRootIdentity = [string]$Binding.dataRootIdentity
        state = 'requested'
        requestedAt = [System.DateTimeOffset]::UtcNow.ToString('o')
        completedAt = $null
    }
    Assert-DysonGameBootstrapExpectedExitValue -Value ([pscustomobject]$value) -Context $Context
    $bytes = ConvertTo-DysonGameBootstrapExpectedExitBytes -Value $value
    $paths = Get-DysonGameBootstrapExpectedExitPaths -Context $Context
    try {
        $pending = Write-DysonGameBootstrapExpectedExitFileCreateNew `
            -Context $Context -Path $paths.pending -Bytes $bytes
        [System.IO.File]::Move($paths.pending, $paths.canonical)
        $persisted = Read-DysonGameBootstrapExpectedExitFile -Context $Context -Path $paths.canonical
        if ([string]$persisted.sha256 -cne [string]$pending.sha256 -or
            -not (Test-DysonGameBootstrapExpectedExitSecurityEqual -Left $persisted -Right $pending)) {
            throw 'requested publication verification failed'
        }
        return $persisted
    }
    catch { throw 'BOOTSTRAP_EXPECTED_EXIT_WRITE_FAILED' }
}

function Complete-DysonGameBootstrapExpectedExit {
    param(
        [Parameter(Mandatory)]$Context,
        [Parameter(Mandatory)][string]$BindingId
    )

    Assert-DysonGameBootstrapCanonicalGuid -Value $BindingId
    $current = Read-DysonGameBootstrapExpectedExit -Context $Context
    if ([string]$current.value.bindingId -cne $BindingId) {
        throw 'BOOTSTRAP_EXPECTED_EXIT_CONFLICT'
    }
    if ([string]$current.value.state -ceq 'completed') { return $current }
    if ([string]$current.value.state -cne 'requested') {
        throw 'BOOTSTRAP_EXPECTED_EXIT_CONFLICT'
    }
    $value = [ordered]@{
        protocol = $script:DysonGameExpectedExitProtocol
        schemaVersion = 1
        bindingId = [string]$current.value.bindingId
        version = [string]$current.value.version
        projectRootSha256 = [string]$current.value.projectRootSha256
        dataRootIdentity = [string]$current.value.dataRootIdentity
        state = 'completed'
        requestedAt = [string]$current.value.requestedAt
        completedAt = [System.DateTimeOffset]::UtcNow.ToString('o')
    }
    Assert-DysonGameBootstrapExpectedExitValue -Value ([pscustomobject]$value) -Context $Context
    $bytes = ConvertTo-DysonGameBootstrapExpectedExitBytes -Value $value
    $expectedSha256 = Get-DysonGameBootstrapSha256Bytes -Bytes $bytes
    $paths = Get-DysonGameBootstrapExpectedExitPaths -Context $Context
    try {
        $pending = Write-DysonGameBootstrapExpectedExitFileCreateNew `
            -Context $Context -Path $paths.pending -Bytes $bytes -AclSddl $current.aclSddl
        Assert-DysonGameBootstrapExpectedExitTransition -Requested $current -Completed $pending
        if ([string]$pending.sha256 -cne $expectedSha256 -or
            -not (Test-DysonGameBootstrapExpectedExitSecurityEqual -Left $pending -Right $current)) {
            throw 'pending replacement verification failed'
        }
        Invoke-DysonGameBootstrapExpectedExitFault -Phase 'after-pending-write' -Context $Context
        $targetBeforeReplace = Read-DysonGameBootstrapExpectedExitFile -Context $Context -Path $paths.canonical
        if ([string]$targetBeforeReplace.sha256 -cne [string]$current.sha256 -or
            -not (Test-DysonGameBootstrapExpectedExitSecurityEqual -Left $targetBeforeReplace -Right $current)) {
            throw 'replacement target changed'
        }
        # File.Replace can promote legacy inherited ACEs to explicit entries and
        # then append the parent's inherited ACEs. Normalize the verified target
        # descriptor first, as the rollback path already does. The existing
        # owner/group/protection/ACE comparison remains unchanged.
        Set-DysonGameBootstrapExpectedExitSecurity -Path $paths.canonical -AclSddl ([string]$current.aclSddl)
        [System.IO.File]::Replace($paths.pending, $paths.canonical, $paths.recovery)
        Invoke-DysonGameBootstrapExpectedExitFault -Phase 'after-replace' -Context $Context
        $persisted = Read-DysonGameBootstrapExpectedExitFile -Context $Context -Path $paths.canonical
        $recovery = Read-DysonGameBootstrapExpectedExitFile -Context $Context -Path $paths.recovery
        Assert-DysonGameBootstrapExpectedExitTransition -Requested $recovery -Completed $persisted
        if ([string]$persisted.sha256 -cne $expectedSha256 -or
            [string]$recovery.sha256 -cne [string]$current.sha256 -or
            -not (Test-DysonGameBootstrapExpectedExitSecurityEqual -Left $persisted -Right $current) -or
            -not (Test-DysonGameBootstrapExpectedExitSecurityEqual -Left $recovery -Right $current)) {
            throw 'replacement verification failed'
        }
        Invoke-DysonGameBootstrapExpectedExitFault -Phase 'after-replacement-validation' -Context $Context
        [System.IO.File]::Delete($paths.recovery)
        if ([System.IO.File]::Exists($paths.recovery) -or [System.IO.Directory]::Exists($paths.recovery)) {
            throw 'recovery removal verification failed'
        }
        return $persisted
    }
    catch {
        try {
            $restored = Resolve-DysonGameBootstrapExpectedExitState -Context $Context
            if ($null -eq $restored -or [string]$restored.value.state -cne 'requested' -or
                [string]$restored.sha256 -cne [string]$current.sha256 -or
                -not (Test-DysonGameBootstrapExpectedExitSecurityEqual -Left $restored -Right $current)) {
                throw 'restore verification failed'
            }
        }
        catch { throw 'BOOTSTRAP_EXPECTED_EXIT_WRITE_FAILED' }
        throw 'BOOTSTRAP_EXPECTED_EXIT_WRITE_FAILED'
    }
}

function Remove-DysonGameBootstrapExpectedExit {
    param(
        [Parameter(Mandatory)]$Context,
        [Parameter(Mandatory)][string]$BindingId,
        [switch]$RequireCompleted
    )

    Assert-DysonGameBootstrapCanonicalGuid -Value $BindingId
    $current = Read-DysonGameBootstrapExpectedExit -Context $Context -AllowMissing
    if ($null -eq $current) { return $false }
    if ([string]$current.value.bindingId -cne $BindingId -or
        ($RequireCompleted -and [string]$current.value.state -cne 'completed')) {
        throw 'BOOTSTRAP_EXPECTED_EXIT_CONFLICT'
    }
    [System.IO.File]::Delete([string]$current.path)
    if ([System.IO.File]::Exists([string]$current.path) -or
        [System.IO.Directory]::Exists([string]$current.path)) {
        throw 'BOOTSTRAP_EXPECTED_EXIT_WRITE_FAILED'
    }
    return $true
}

function Get-DysonGameBootstrapReleaseFiles {
    param([Parameter(Mandatory)][string]$ReleaseRoot)

    $root = Assert-DysonGameBootstrapPlainDirectory -Path $ReleaseRoot
    $prefix = $root.TrimEnd('\', '/') + [System.IO.Path]::DirectorySeparatorChar
    $files = [System.Collections.Generic.Dictionary[string, System.IO.FileInfo]]::new(
        [System.StringComparer]::OrdinalIgnoreCase
    )
    $pending = [System.Collections.Generic.Stack[System.IO.DirectoryInfo]]::new()
    $pending.Push([System.IO.DirectoryInfo]::new($root))
    $entryCount = 0
    while ($pending.Count -gt 0) {
        $directory = $pending.Pop()
        foreach ($entry in $directory.GetFileSystemInfos()) {
            $entryCount += 1
            if ($entryCount -gt $script:DysonMaximumReleaseEntries) { throw 'BOOTSTRAP_RELEASE_LIMIT_EXCEEDED' }
            if ($entry.Attributes -band [System.IO.FileAttributes]::ReparsePoint) {
                throw 'BOOTSTRAP_RELEASE_REDIRECTED'
            }
            $full = Get-DysonGameBootstrapFullPath -Path $entry.FullName
            if (-not (Test-DysonGameBootstrapPathWithin -Candidate $full -Parent $root)) {
                throw 'BOOTSTRAP_RELEASE_ESCAPE'
            }
            if ($entry -is [System.IO.DirectoryInfo]) {
                $pending.Push([System.IO.DirectoryInfo]$entry)
                continue
            }
            if ($entry -isnot [System.IO.FileInfo]) { throw 'BOOTSTRAP_RELEASE_ENTRY_INVALID' }
            $relative = $full.Substring($prefix.Length).Replace('\', '/')
            if ($relative -ceq $script:DysonReleaseManifestName) { continue }
            if ($files.ContainsKey($relative)) { throw 'BOOTSTRAP_RELEASE_DUPLICATE' }
            $files.Add($relative, [System.IO.FileInfo]$entry)
        }
    }
    return $files
}

function Resolve-DysonGameBootstrapReleaseVersion {
    param(
        [Parameter(Mandatory)]$Context,
        [Parameter(Mandatory)][string]$Version
    )

    Assert-DysonGameBootstrapVersion -Version $Version
    $releasePath = Get-DysonGameBootstrapFullPath -Path ([System.IO.Path]::Combine($Context.releasesRoot, $Version))
    if (-not (Test-DysonGameBootstrapPathWithin -Candidate $releasePath -Parent $Context.releasesRoot)) {
        throw 'BOOTSTRAP_RELEASE_ESCAPE'
    }
    $releaseRoot = Assert-DysonGameBootstrapPlainDirectory -Path $releasePath
    $manifestRecord = Read-DysonGameBootstrapJsonFile `
        -Path ([System.IO.Path]::Combine($releaseRoot, $script:DysonReleaseManifestName)) `
        -MaximumBytes $script:DysonMaximumManifestBytes
    $manifest = $manifestRecord.value
    Assert-DysonGameBootstrapExactProperties -Value $manifest -Names @(
        'protocol', 'version', 'entryPoint', 'nodeMinimumMajor', 'createdAt', 'payloadSha256', 'files'
    )
    if ([string]$manifest.protocol -cne $script:DysonDeploymentProtocol -or
        [string]$manifest.version -cne $Version) { throw 'BOOTSTRAP_MANIFEST_IDENTITY_INVALID' }
    Assert-DysonGameBootstrapRelativePath -Path ([string]$manifest.entryPoint)
    Assert-DysonGameBootstrapTimestamp -Value ([string]$manifest.createdAt)
    Assert-DysonGameBootstrapHash -Value ([string]$manifest.payloadSha256)
    if (-not (Test-DysonGameBootstrapJsonInteger -Value $manifest.nodeMinimumMajor) -or
        [int64]$manifest.nodeMinimumMajor -lt 1 -or [int64]$manifest.nodeMinimumMajor -gt 999) {
        throw 'BOOTSTRAP_MANIFEST_RUNTIME_INVALID'
    }

    $manifestFiles = @($manifest.files)
    if ($manifestFiles.Count -lt 1 -or $manifestFiles.Count -gt $script:DysonMaximumReleaseEntries) {
        throw 'BOOTSTRAP_MANIFEST_FILES_INVALID'
    }
    $actualFiles = Get-DysonGameBootstrapReleaseFiles -ReleaseRoot $releaseRoot
    if ($actualFiles.Count -ne $manifestFiles.Count) { throw 'BOOTSTRAP_RELEASE_INVENTORY_INVALID' }
    $seen = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::OrdinalIgnoreCase)
    $canonicalLines = [System.Collections.Generic.List[string]]::new()
    $totalBytes = [int64]0
    $startHash = $null
    $stopHash = $null
    $entryPointPresent = $false
    foreach ($file in $manifestFiles) {
        Assert-DysonGameBootstrapExactProperties -Value $file -Names @('path', 'length', 'sha256')
        $relative = [string]$file.path
        Assert-DysonGameBootstrapRelativePath -Path $relative
        if ($relative.Contains('\') -or $relative -ceq $script:DysonReleaseManifestName -or
            -not $seen.Add($relative)) { throw 'BOOTSTRAP_MANIFEST_FILES_INVALID' }
        if (-not (Test-DysonGameBootstrapJsonInteger -Value $file.length)) {
            throw 'BOOTSTRAP_MANIFEST_FILES_INVALID'
        }
        $length = [int64]$file.length
        if ($length -lt 0 -or $length -gt $script:DysonMaximumReleaseFileBytes) {
            throw 'BOOTSTRAP_MANIFEST_FILES_INVALID'
        }
        $totalBytes += $length
        if ($totalBytes -gt $script:DysonMaximumReleaseBytes) { throw 'BOOTSTRAP_RELEASE_LIMIT_EXCEEDED' }
        $hash = [string]$file.sha256
        Assert-DysonGameBootstrapHash -Value $hash
        if (-not $actualFiles.ContainsKey($relative)) { throw 'BOOTSTRAP_RELEASE_INVENTORY_INVALID' }
        $actual = $actualFiles[$relative]
        $actual.Refresh()
        if (-not $actual.Exists -or ($actual.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -or
            $actual.Length -ne $length -or (Get-DysonGameBootstrapFileSha256 -Path $actual.FullName) -cne $hash) {
            throw 'BOOTSTRAP_RELEASE_INVENTORY_INVALID'
        }
        $canonicalLines.Add(('{0}|{1}|{2}' -f $relative, $length, $hash))
        if ($relative -ceq ([string]$manifest.entryPoint).Replace('\', '/')) { $entryPointPresent = $true }
        if ($relative -ceq $script:DysonGameStartRelativePath) { $startHash = $hash }
        if ($relative -ceq $script:DysonGameStopRelativePath) { $stopHash = $hash }
    }
    $payload = Get-DysonGameBootstrapSha256Text -Value ([string]::Join("`n", @($canonicalLines)))
    if ($payload -cne [string]$manifest.payloadSha256 -or -not $entryPointPresent -or
        -not $startHash -or -not $stopHash) { throw 'BOOTSTRAP_RELEASE_INVENTORY_INVALID' }

    $startPath = Get-DysonGameBootstrapFullPath -Path ([System.IO.Path]::Combine(
        $releaseRoot,
        $script:DysonGameStartRelativePath.Replace('/', [System.IO.Path]::DirectorySeparatorChar)
    ))
    $stopPath = Get-DysonGameBootstrapFullPath -Path ([System.IO.Path]::Combine(
        $releaseRoot,
        $script:DysonGameStopRelativePath.Replace('/', [System.IO.Path]::DirectorySeparatorChar)
    ))
    [void](Assert-DysonGameBootstrapPlainFile -Path $startPath -MaximumBytes 4MB)
    [void](Assert-DysonGameBootstrapPlainFile -Path $stopPath -MaximumBytes 4MB)
    return [pscustomobject][ordered]@{
        version = $Version
        releaseRoot = $releaseRoot
        entryPoint = [string]$manifest.entryPoint
        payloadSha256 = $payload
        manifestSha256 = [string]$manifestRecord.sha256
        startScriptPath = $startPath
        stopScriptPath = $stopPath
        startScriptSha256 = $startHash
        stopScriptSha256 = $stopHash
    }
}

function Resolve-DysonGameBootstrapActiveRelease {
    param([Parameter(Mandatory)]$Context)

    $pointerRecord = Read-DysonGameBootstrapJsonFile `
        -Path $Context.activePointerPath -MaximumBytes $script:DysonMaximumPointerBytes
    $pointer = $pointerRecord.value
    $pointerNames = @('protocol', 'version', 'entryPoint', 'payloadSha256', 'activatedAt')
    $hasIdentity = $pointer.PSObject.Properties.Name -contains 'deploymentId'
    if ($hasIdentity) { $pointerNames += @('deploymentId', 'deploymentIdentitySha256') }
    Assert-DysonGameBootstrapExactProperties -Value $pointer -Names $pointerNames
    if ($hasIdentity) {
        $deploymentCommon = Assert-DysonGameBootstrapPlainFile -Path `
            ([IO.Path]::Combine($Context.bootstrapRoot, 'DysonDeployment.Common.ps1')) -MaximumBytes 4MB
        . $deploymentCommon.FullName
        $identity = Get-DysonDeploymentIdentity -InstallRoot $Context.installRoot -DataRoot $Context.dataRoot
        if ([string]$pointer.deploymentId -cne [string]$identity.marker.deploymentId -or
            [string]$pointer.deploymentIdentitySha256 -cne [string]$identity.markerSha256) {
            throw 'BOOTSTRAP_DEPLOYMENT_IDENTITY_MISMATCH'
        }
    }
    if ([string]$pointer.protocol -cne $script:DysonDeploymentProtocol) {
        throw 'BOOTSTRAP_POINTER_PROTOCOL_INVALID'
    }
    Assert-DysonGameBootstrapVersion -Version ([string]$pointer.version)
    Assert-DysonGameBootstrapRelativePath -Path ([string]$pointer.entryPoint)
    Assert-DysonGameBootstrapHash -Value ([string]$pointer.payloadSha256)
    Assert-DysonGameBootstrapTimestamp -Value ([string]$pointer.activatedAt)
    $release = Resolve-DysonGameBootstrapReleaseVersion -Context $Context -Version ([string]$pointer.version)
    if ($release.entryPoint -cne [string]$pointer.entryPoint -or
        $release.payloadSha256 -cne [string]$pointer.payloadSha256) {
        throw 'BOOTSTRAP_POINTER_RELEASE_MISMATCH'
    }
    $release | Add-Member -NotePropertyName pointerSha256 -NotePropertyValue ([string]$pointerRecord.sha256)
    return $release
}

function Get-DysonGameBootstrapProjectIdentity {
    param([Parameter(Mandatory)][string]$ProjectRoot)

    $root = Assert-DysonGameBootstrapPlainDirectory -Path $ProjectRoot
    $server = Assert-DysonGameBootstrapPlainDirectory -Path ([System.IO.Path]::Combine($root, 'server'))
    $executable = Get-DysonGameBootstrapFullPath -Path ([System.IO.Path]::Combine($server, 'DSPGAME.exe'))
    if (-not (Test-DysonGameBootstrapPathWithin -Candidate $executable -Parent $root)) {
        throw 'BOOTSTRAP_PROJECT_INVALID'
    }
    [void](Assert-DysonGameBootstrapPlainFile -Path $executable -MaximumBytes 4GB)
    return [pscustomobject][ordered]@{
        projectRoot = $root
        sha256 = Get-DysonGameBootstrapSha256Text -Value $root.ToUpperInvariant()
    }
}

function Assert-DysonGameBootstrapStartPublicationClear {
    param([Parameter(Mandatory)]$Project)

    $runPath = Get-DysonGameBootstrapFullPath -Path ([System.IO.Path]::Combine($Project.projectRoot, 'run'))
    if (-not (Test-DysonGameBootstrapPathWithin -Candidate $runPath -Parent $Project.projectRoot)) {
        throw 'BOOTSTRAP_PROJECT_INVALID'
    }
    $runItem = [System.IO.DirectoryInfo]::new($runPath)
    $runItem.Refresh()
    if ($runItem.Exists -and ($runItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint)) {
        throw 'BOOTSTRAP_PID_STATE_INVALID'
    }
    $pidPath = [System.IO.Path]::Combine($runPath, 'dspgame.pid')
    $pidItem = [System.IO.FileInfo]::new($pidPath)
    $pidItem.Refresh()
    if ($pidItem.Exists) { throw 'BOOTSTRAP_PID_STATE_INVALID' }
    return $pidPath
}

function Wait-DysonGameBootstrapStartPublication {
    param(
        [Parameter(Mandatory)]$Invocation,
        [Parameter(Mandatory)]$Project,
        [Parameter(Mandatory)][string]$PidPath,
        [ValidateRange(1, 30)][int]$TimeoutSeconds = 15
    )

    $expectedExecutable = Get-DysonGameBootstrapFullPath -Path (
        [System.IO.Path]::Combine($Project.projectRoot, 'server', 'DSPGAME.exe')
    )
    $deadline = [System.DateTimeOffset]::UtcNow.AddSeconds($TimeoutSeconds)
    $stablePid = $null
    $pidStateObserved = $false
    $identityUnavailable = $false
    do {
        $Invocation.process.Refresh()
        if ($Invocation.process.HasExited) { return $false }
        $pidItem = [System.IO.FileInfo]::new($PidPath)
        $pidItem.Refresh()
        if ($pidItem.Exists) {
            $pidStateObserved = $true
            if ($pidItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint -or
                $pidItem.Length -gt 16) {
                throw 'BOOTSTRAP_PID_STATE_INVALID'
            }
            if ($pidItem.Length -lt 1) {
                $stablePid = $null
                [System.Threading.Thread]::Sleep(25)
                continue
            }
            try { $rawPid = [System.IO.File]::ReadAllText($pidItem.FullName, [System.Text.Encoding]::ASCII).Trim() }
            catch [System.IO.IOException] {
                $stablePid = $null
                [System.Threading.Thread]::Sleep(25)
                continue
            }
            $processId = 0
            if ($rawPid -notmatch '^[1-9][0-9]{0,9}$' -or
                -not [int]::TryParse($rawPid, [ref]$processId) -or $processId -le 0) {
                $stablePid = $null
                [System.Threading.Thread]::Sleep(25)
                continue
            }
            $managed = $null
            try {
                $managed = [System.Diagnostics.Process]::GetProcessById($processId)
            }
            catch [System.ArgumentException] {
                $stablePid = $null
                [System.Threading.Thread]::Sleep(25)
                continue
            }
            catch {
                throw [System.InvalidOperationException]::new(
                    'BOOTSTRAP_PID_IDENTITY_INVALID',
                    $_.Exception
                )
            }
            try {
                $managed.Refresh()
                if ($managed.HasExited) {
                    $stablePid = $null
                    [System.Threading.Thread]::Sleep(25)
                    continue
                }
                try {
                    $actualExecutable = Get-DysonGameBootstrapFullPath -Path $managed.MainModule.FileName
                }
                catch [System.ComponentModel.Win32Exception] {
                    $identityUnavailable = $true
                    $stablePid = $null
                    [System.Threading.Thread]::Sleep(25)
                    continue
                }
                catch [System.InvalidOperationException] {
                    $identityUnavailable = $true
                    $stablePid = $null
                    [System.Threading.Thread]::Sleep(25)
                    continue
                }
                if (-not [string]::Equals(
                    $actualExecutable,
                    $expectedExecutable,
                    [System.StringComparison]::OrdinalIgnoreCase
                )) { throw 'BOOTSTRAP_PID_IDENTITY_INVALID' }
                $Invocation.process.Refresh()
                if ($Invocation.process.HasExited) { return $false }
                if ([string]$stablePid -ceq $rawPid) { return $true }
                $stablePid = $rawPid
            }
            finally { if ($managed) { $managed.Dispose() } }
        }
        [System.Threading.Thread]::Sleep(25)
    } while ([System.DateTimeOffset]::UtcNow -lt $deadline)
    if ($identityUnavailable) { throw 'BOOTSTRAP_PID_IDENTITY_INVALID' }
    if ($pidStateObserved) { throw 'BOOTSTRAP_PID_STATE_INVALID' }
    throw 'BOOTSTRAP_START_PUBLICATION_TIMEOUT'
}

function New-DysonGameBootstrapBinding {
    param(
        [Parameter(Mandatory)]$Release,
        [Parameter(Mandatory)][string]$ProjectRootSha256,
        [Parameter(Mandatory)][string]$DataRootIdentity
    )

    Assert-DysonGameBootstrapHash -Value $ProjectRootSha256
    Assert-DysonGameBootstrapHash -Value $DataRootIdentity
    return [ordered]@{
        protocol = $script:DysonGameBindingProtocol
        bindingId = [guid]::NewGuid().ToString('D').ToLowerInvariant()
        version = [string]$Release.version
        pointerSha256 = [string]$Release.pointerSha256
        manifestSha256 = [string]$Release.manifestSha256
        payloadSha256 = [string]$Release.payloadSha256
        startScriptSha256 = [string]$Release.startScriptSha256
        stopScriptSha256 = [string]$Release.stopScriptSha256
        projectRootSha256 = $ProjectRootSha256
        dataRootIdentity = $DataRootIdentity
        createdAt = [System.DateTimeOffset]::UtcNow.ToString('o')
    }
}

function Read-DysonGameBootstrapBinding {
    param([Parameter(Mandatory)]$Context)

    $item = [System.IO.FileInfo]::new([string]$Context.bindingPath)
    $item.Refresh()
    if (-not $item.Exists) { return $null }
    $record = Read-DysonGameBootstrapJsonFile `
        -Path $Context.bindingPath -MaximumBytes $script:DysonMaximumBindingBytes
    $binding = $record.value
    Assert-DysonGameBootstrapExactProperties -Value $binding -Names @(
        'protocol', 'bindingId', 'version', 'pointerSha256', 'manifestSha256', 'payloadSha256',
        'startScriptSha256', 'stopScriptSha256', 'projectRootSha256', 'dataRootIdentity', 'createdAt'
    )
    if ([string]$binding.protocol -cne $script:DysonGameBindingProtocol) {
        throw 'BOOTSTRAP_BINDING_INVALID'
    }
    $parsedId = [guid]::Empty
    if (-not [guid]::TryParseExact([string]$binding.bindingId, 'D', [ref]$parsedId) -or
        $parsedId.ToString('D').ToLowerInvariant() -cne [string]$binding.bindingId) {
        throw 'BOOTSTRAP_BINDING_INVALID'
    }
    Assert-DysonGameBootstrapVersion -Version ([string]$binding.version)
    foreach ($name in @(
        'pointerSha256', 'manifestSha256', 'payloadSha256', 'startScriptSha256',
        'stopScriptSha256', 'projectRootSha256', 'dataRootIdentity'
    )) { Assert-DysonGameBootstrapHash -Value ([string]$binding.$name) }
    Assert-DysonGameBootstrapTimestamp -Value ([string]$binding.createdAt)
    return $binding
}

function Resolve-DysonGameBootstrapBoundRelease {
    param(
        [Parameter(Mandatory)]$Context,
        [Parameter(Mandatory)]$Binding
    )

    $release = Resolve-DysonGameBootstrapReleaseVersion -Context $Context -Version ([string]$Binding.version)
    if ($release.manifestSha256 -cne [string]$Binding.manifestSha256 -or
        $release.payloadSha256 -cne [string]$Binding.payloadSha256 -or
        $release.startScriptSha256 -cne [string]$Binding.startScriptSha256 -or
        $release.stopScriptSha256 -cne [string]$Binding.stopScriptSha256) {
        throw 'BOOTSTRAP_BINDING_RELEASE_MISMATCH'
    }
    return $release
}

function Write-DysonGameBootstrapBinding {
    param(
        [Parameter(Mandatory)]$Context,
        [Parameter(Mandatory)]$Binding
    )

    if ($null -ne (Read-DysonGameBootstrapBinding -Context $Context)) {
        throw 'BOOTSTRAP_BINDING_ALREADY_PRESENT'
    }
    $json = $Binding | Microsoft.PowerShell.Utility\ConvertTo-Json -Depth 8 -Compress
    $bytes = [System.Text.UTF8Encoding]::new($false).GetBytes($json)
    if ($bytes.Length -gt $script:DysonMaximumBindingBytes) { throw 'BOOTSTRAP_BINDING_INVALID' }
    $temporary = [System.IO.Path]::Combine($Context.stateRoot, '.partial-game-binding-' + [guid]::NewGuid().ToString('N'))
    $stream = $null
    try {
        $stream = [System.IO.FileStream]::new(
            $temporary,
            [System.IO.FileMode]::CreateNew,
            [System.IO.FileAccess]::Write,
            [System.IO.FileShare]::None
        )
        $stream.Write($bytes, 0, $bytes.Length)
        $stream.Flush($true)
        $stream.Dispose()
        $stream = $null
        [System.IO.File]::Move($temporary, $Context.bindingPath)
    }
    catch { throw 'BOOTSTRAP_BINDING_WRITE_FAILED' }
    finally {
        if ($stream) { $stream.Dispose() }
        if ([System.IO.File]::Exists($temporary)) { [System.IO.File]::Delete($temporary) }
    }
}

function Remove-DysonGameBootstrapBinding {
    param(
        [Parameter(Mandatory)]$Context,
        [Parameter(Mandatory)][string]$BindingId
    )

    $current = Read-DysonGameBootstrapBinding -Context $Context
    if ($null -eq $current) { return }
    if ([string]$current.bindingId -cne $BindingId) { throw 'BOOTSTRAP_BINDING_CHANGED' }
    [System.IO.File]::Delete($Context.bindingPath)
}

function Enter-DysonGameBootstrapLock {
    param(
        [Parameter(Mandatory)][string]$Path,
        [ValidateRange(1, 30)][int]$TimeoutSeconds = 10
    )

    $deadline = [System.DateTimeOffset]::UtcNow.AddSeconds($TimeoutSeconds)
    do {
        try {
            $existing = [System.IO.FileInfo]::new($Path)
            $existing.Refresh()
            if ($existing.Exists -and ($existing.Attributes -band [System.IO.FileAttributes]::ReparsePoint)) {
                throw 'BOOTSTRAP_LOCK_INVALID'
            }
            return [System.IO.FileStream]::new(
                $Path,
                [System.IO.FileMode]::OpenOrCreate,
                [System.IO.FileAccess]::ReadWrite,
                [System.IO.FileShare]::None
            )
        }
        catch [System.IO.IOException] {
            if ([System.DateTimeOffset]::UtcNow -ge $deadline) { throw 'BOOTSTRAP_LOCK_BUSY' }
            [System.Threading.Thread]::Sleep(100)
        }
    } while ($true)
}

function Start-DysonGameBootstrapReleaseScriptProcess {
    param(
        [Parameter(Mandatory)][string]$ScriptPath,
        [Parameter(Mandatory)][string[]]$Arguments,
        [Parameter(Mandatory)][string]$WorkingDirectory
    )

    $systemRoot = Get-DysonGameBootstrapFullPath -Path ([string]$env:SystemRoot)
    $powerShellPath = Get-DysonGameBootstrapFullPath -Path ([System.IO.Path]::Combine(
        $systemRoot,
        'System32',
        'WindowsPowerShell',
        'v1.0',
        'powershell.exe'
    ))
    [void](Assert-DysonGameBootstrapPlainFile -Path $powerShellPath -MaximumBytes 512MB)
    [void](Assert-DysonGameBootstrapPlainFile -Path $ScriptPath -MaximumBytes 4MB)
    [void](Assert-DysonGameBootstrapPlainDirectory -Path $WorkingDirectory)
    $allArguments = @('-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', $ScriptPath) + $Arguments
    $quoted = foreach ($argument in $allArguments) {
        $text = [string]$argument
        if ($text.IndexOf([char]0) -ge 0 -or $text -match '["\r\n]') {
            throw 'BOOTSTRAP_ARGUMENT_INVALID'
        }
        '"{0}"' -f $text
    }
    $process = $null
    try {
        $startInfo = [System.Diagnostics.ProcessStartInfo]::new()
        $startInfo.FileName = $powerShellPath
        $startInfo.Arguments = [string]::Join(' ', $quoted)
        $startInfo.WorkingDirectory = $WorkingDirectory
        $startInfo.UseShellExecute = $false
        $startInfo.CreateNoWindow = $true
        $startInfo.RedirectStandardOutput = $true
        $startInfo.RedirectStandardError = $true
        $process = [System.Diagnostics.Process]::new()
        $process.StartInfo = $startInfo
        if (-not $process.Start()) { throw 'process did not start' }
        return [pscustomobject][ordered]@{
            process = $process
            stdoutTask = $process.StandardOutput.ReadToEndAsync()
            stderrTask = $process.StandardError.ReadToEndAsync()
        }
    }
    catch {
        if ($process) { $process.Dispose() }
        throw 'BOOTSTRAP_RELEASE_ACTION_FAILED'
    }
}

function Complete-DysonGameBootstrapReleaseScriptProcess {
    param([Parameter(Mandatory)]$Invocation)

    try {
        $Invocation.process.WaitForExit()
        $Invocation.process.WaitForExit()
        $stdout = [string]$Invocation.stdoutTask.GetAwaiter().GetResult()
        $stderr = [string]$Invocation.stderrTask.GetAwaiter().GetResult()
        if ($stdout.Length -gt 65536 -or $stderr.Length -gt 65536 -or
            $Invocation.process.ExitCode -ne 0) { throw 'release action failed' }
        return [int]$Invocation.process.ExitCode
    }
    catch { throw 'BOOTSTRAP_RELEASE_ACTION_FAILED' }
    finally { $Invocation.process.Dispose() }
}

function Invoke-DysonGameBootstrapReleaseScript {
    param(
        [Parameter(Mandatory)][string]$ScriptPath,
        [Parameter(Mandatory)][string[]]$Arguments,
        [Parameter(Mandatory)][string]$WorkingDirectory
    )

    $invocation = Start-DysonGameBootstrapReleaseScriptProcess `
        -ScriptPath $ScriptPath -Arguments $Arguments -WorkingDirectory $WorkingDirectory
    return Complete-DysonGameBootstrapReleaseScriptProcess -Invocation $invocation
}
