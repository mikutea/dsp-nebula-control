# Durable executor for the fixed production qualification protocol v2.
# Preview is read-only. Execute remains fail-closed until every v2 gate passes.

Set-StrictMode -Version 2.0

. (Join-Path $PSScriptRoot 'Qualification.ProtocolV2.ps1')

$script:DysonQualificationV2StoreDirectory = 'qualification-v2'
$script:DysonQualificationV2ZeroDigest = 'sha256:' + ('0' * 64)

function Assert-DysonQualificationV2ExistingLocalPathChain {
    param([Parameter(Mandatory)][string]$Path, [Parameter(Mandatory)][string]$Code)
    try {
        $full = [IO.Path]::GetFullPath($Path).TrimEnd('\')
        $root = [IO.Path]::GetPathRoot($full)
        if ([string]::IsNullOrWhiteSpace($root)) { throw 'missing path root' }
        $current = $root
        $relative = $full.Substring($root.Length).TrimStart('\')
        foreach ($part in @($relative -split '\\' | Where-Object { $_.Length -gt 0 })) {
            $current = Join-Path $current $part
            $item = Get-Item -LiteralPath $current -Force -ErrorAction Stop
            if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) {
                throw 'redirected path component'
            }
        }
        return $full
    }
    catch { Throw-DysonQualificationV2Error -Code $Code }
}

function Read-DysonQualificationV2JsonFile {
    param([Parameter(Mandatory)][string]$Path, [Parameter(Mandatory)][int]$MaximumBytes)
    try {
        $item = Get-Item -LiteralPath $Path -Force -ErrorAction Stop
        if ($item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -or
            $item.Length -lt 2 -or $item.Length -gt $MaximumBytes) { throw 'invalid file' }
        return [IO.File]::ReadAllText($item.FullName, [Text.Encoding]::UTF8) | ConvertFrom-Json -ErrorAction Stop
    }
    catch { Throw-DysonQualificationV2Error -Code 'DYSON_QUALIFICATION_V2_PERSISTED_RECORD_INVALID' }
}

function Write-DysonQualificationV2JsonAtomicCreateNew {
    param(
        [Parameter(Mandatory)][string]$Path,
        [Parameter(Mandatory)]$Value,
        [Parameter(Mandatory)][ValidateSet('Intent','Receipt')][string]$RecordKind,
        [string]$Injection = 'None'
    )
    $beforeWrite = $RecordKind + 'BeforeWrite'
    $midWrite = $RecordKind + 'MidWrite'
    $afterFlush = $RecordKind + 'AfterFlushBeforeRename'
    $afterRename = $RecordKind + 'AfterRename'
    if ($Injection -ceq $beforeWrite) {
        Throw-DysonQualificationV2Error -Code 'DYSON_QUALIFICATION_V2_FAKE_PERSISTENCE_EXIT'
    }
    $parent = [IO.Path]::GetDirectoryName($Path)
    $leaf = [IO.Path]::GetFileName($Path)
    $expectedSuffix = if ($RecordKind -ceq 'Intent') { '.intent.json' } else { '.receipt.json' }
    if ($leaf -cnotmatch ('^[0-9a-f-]{36}' + [regex]::Escape($expectedSuffix) + '$')) {
        Throw-DysonQualificationV2Error -Code 'DYSON_QUALIFICATION_V2_PERSISTENCE_FAILED'
    }
    $temporaryMarker = if ($RecordKind -ceq 'Intent') { 'i' } else { 'r' }
    $temporary = Join-Path $parent ('.' + $temporaryMarker + '.atomic-' + [guid]::NewGuid().ToString('N') + '.tmp')
    $stream = $null
    try {
        $text = (ConvertTo-DysonQualificationV2CanonicalJson -Value $Value) + "`n"
        $bytes = [Text.UTF8Encoding]::new($false).GetBytes($text)
        $stream = New-Object IO.FileStream($temporary, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
        if ($Injection -ceq $midWrite) {
            $partialLength = [Math]::Max(1, [int][Math]::Floor($bytes.Length / 2))
            $stream.Write($bytes, 0, $partialLength)
            $stream.Flush($true)
            $stream.Dispose()
            $stream = $null
            Throw-DysonQualificationV2Error -Code 'DYSON_QUALIFICATION_V2_FAKE_PERSISTENCE_EXIT'
        }
        $stream.Write($bytes, 0, $bytes.Length)
        $stream.Flush($true)
        $stream.Dispose()
        $stream = $null
        if ($Injection -ceq $afterFlush) {
            Throw-DysonQualificationV2Error -Code 'DYSON_QUALIFICATION_V2_FAKE_PERSISTENCE_EXIT'
        }
        [IO.File]::Move($temporary, $Path)
        if ($Injection -ceq $afterRename) {
            Throw-DysonQualificationV2Error -Code 'DYSON_QUALIFICATION_V2_FAKE_PERSISTENCE_EXIT'
        }
    }
    catch {
        if ((Get-DysonQualificationV2ErrorCode -Exception $_.Exception) -ceq `
            'DYSON_QUALIFICATION_V2_FAKE_PERSISTENCE_EXIT') { throw }
        Throw-DysonQualificationV2Error -Code 'DYSON_QUALIFICATION_V2_PERSISTENCE_FAILED'
    }
    finally { if ($null -ne $stream) { $stream.Dispose() } }
}

function Assert-DysonQualificationV2NoOrphanedAtomicWrites {
    param([Parameter(Mandatory)]$Paths)
    foreach ($directory in @([string]$Paths.intents,[string]$Paths.receipts)) {
        foreach ($item in @(Get-ChildItem -LiteralPath $directory -Force -ErrorAction Stop)) {
            if (-not $item.PSIsContainer -and
                $item.Name -cmatch '^\.(?:[ir]|[0-9a-f-]{36}\.(?:intent|receipt)\.json)\.atomic-[0-9a-f]{32}\.tmp$') {
                Throw-DysonQualificationV2Error -Code 'DYSON_QUALIFICATION_V2_PERSISTENCE_RECOVERY_REQUIRED'
            }
        }
    }
    return $true
}

function Import-DysonQualificationV2ProductionProfile {
    param(
        [Parameter(Mandatory)][string]$Path,
        [datetimeoffset]$NowUtc = [datetimeoffset]::UtcNow,
        [switch]$AllowExpired
    )
    try {
        $full = Assert-DysonQualificationV2ExistingLocalPathChain `
            -Path $Path -Code 'DYSON_QUALIFICATION_V2_PROFILE_INVALID'
        $item = Get-Item -LiteralPath $full -Force -ErrorAction Stop
        if ($item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -or
            $item.Length -lt 2 -or $item.Length -gt 131072) { throw 'invalid profile' }
        $profile = [IO.File]::ReadAllText($item.FullName, [Text.Encoding]::UTF8) | ConvertFrom-Json -ErrorAction Stop
    }
    catch { Throw-DysonQualificationV2Error -Code 'DYSON_QUALIFICATION_V2_PROFILE_INVALID' }
    [void](Assert-DysonQualificationV2Profile -Profile $profile -NowUtc $NowUtc -AllowExpired:$AllowExpired)
    return $profile
}

function Get-DysonQualificationV2AdapterContract {
    param([Parameter(Mandatory)][string]$Action)
    if ($script:DysonQualificationV2Actions -cnotcontains $Action) {
        Throw-DysonQualificationV2Error -Code 'DYSON_QUALIFICATION_V2_ACTION_NOT_ALLOWLISTED'
    }
    try {
        $path = Join-Path $PSScriptRoot 'fixtures\adapter-contract.v2.json'
        $item = Get-Item -LiteralPath $path -Force -ErrorAction Stop
        if ($item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -or
            $item.Length -lt 2 -or $item.Length -gt 65536) { throw 'invalid contract' }
        $contract = [IO.File]::ReadAllText($item.FullName, [Text.Encoding]::UTF8) | ConvertFrom-Json -ErrorAction Stop
        Assert-DysonQualificationV2ExactProperties -Value $contract -Names @(
            'protocol','schemaVersion','productionExecutionImplemented','defaultProductionExecutionEnabled',
            'hostIdentityRule','confirmationBindsFullPreviewSha256','maximumPersistedResumeAgeDays',
            'maximumRenewedCompensationSeconds','actions'
        ) -Code 'DYSON_QUALIFICATION_V2_ADAPTER_CONTRACT_INVALID'
        if ([string]$contract.protocol -cne 'DYSON_QUALIFICATION_ADAPTER_CONTRACT_V2' -or
            -not (Test-DysonQualificationV2Integer -Value $contract.schemaVersion) -or
            [int]$contract.schemaVersion -ne 2 -or -not [bool]$contract.productionExecutionImplemented -or
            $contract.productionExecutionImplemented -isnot [bool] -or
            $contract.defaultProductionExecutionEnabled -isnot [bool] -or
            [bool]$contract.defaultProductionExecutionEnabled -or
            [string]$contract.hostIdentityRule -cne 'sha256-domain-separated-normalized-windows-machine-guid' -or
            $contract.confirmationBindsFullPreviewSha256 -isnot [bool] -or
            -not [bool]$contract.confirmationBindsFullPreviewSha256 -or
            -not (Test-DysonQualificationV2Integer -Value $contract.maximumPersistedResumeAgeDays) -or
            [int]$contract.maximumPersistedResumeAgeDays -ne 31 -or
            -not (Test-DysonQualificationV2Integer -Value $contract.maximumRenewedCompensationSeconds) -or
            [int]$contract.maximumRenewedCompensationSeconds -ne 300 -or
            @($contract.actions).Count -ne $script:DysonQualificationV2Actions.Count) { throw 'invalid contract' }
        $contractActions = @($contract.actions | ForEach-Object { [string]$_.action })
        foreach ($allowedAction in $script:DysonQualificationV2Actions) {
            if (@($contractActions | Where-Object { $_ -ceq $allowedAction }).Count -ne 1) {
                throw 'invalid contract'
            }
        }
        $matches = @($contract.actions | Where-Object { [string]$_.action -ceq $Action })
        if ($matches.Count -ne 1) { throw 'invalid contract' }
        return $matches[0]
    }
    catch { Throw-DysonQualificationV2Error -Code 'DYSON_QUALIFICATION_V2_ADAPTER_CONTRACT_INVALID' }
}

function Get-DysonQualificationV2StorePaths {
    param([Parameter(Mandatory)]$Profile, [switch]$Initialize)
    try {
        $stateRoot = Assert-DysonQualificationV2ExistingLocalPathChain `
            -Path ([string]$Profile.stateRoot) -Code 'DYSON_QUALIFICATION_V2_STATE_ROOT_INVALID'
        $rootItem = Get-Item -LiteralPath $stateRoot -Force -ErrorAction Stop
        if (-not $rootItem.PSIsContainer -or ($rootItem.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
            throw 'invalid state root'
        }
        $store = Join-Path $stateRoot $script:DysonQualificationV2StoreDirectory
        $intents = Join-Path $store 'intents'
        $receipts = Join-Path $store 'receipts'
        if ($Initialize) {
            foreach ($path in @($store,$intents,$receipts)) {
                if (-not (Test-Path -LiteralPath $path)) { [void][IO.Directory]::CreateDirectory($path) }
            }
        }
        foreach ($path in @($store,$intents,$receipts)) {
            if (Test-Path -LiteralPath $path) {
                $item = Get-Item -LiteralPath $path -Force -ErrorAction Stop
                if (-not $item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
                    throw 'redirected store'
                }
            }
            elseif (-not $Initialize) { continue }
            else { throw 'missing store' }
        }
        return [pscustomobject][ordered]@{
            stateRoot = $stateRoot
            store = $store
            intents = $intents
            receipts = $receipts
            lock = Join-Path $store '.execution.lock'
        }
    }
    catch { Throw-DysonQualificationV2Error -Code 'DYSON_QUALIFICATION_V2_STATE_ROOT_INVALID' }
}

function Get-DysonQualificationV2IntentPath {
    param([Parameter(Mandatory)]$Paths, [Parameter(Mandatory)][string]$RequestId)
    if (-not (Test-DysonQualificationV2Uuid -Value $RequestId)) {
        Throw-DysonQualificationV2Error -Code 'DYSON_QUALIFICATION_V2_REQUEST_INVALID'
    }
    return Join-Path $Paths.intents ($RequestId + '.intent.json')
}

function Get-DysonQualificationV2ReceiptPath {
    param([Parameter(Mandatory)]$Paths, [Parameter(Mandatory)][string]$RequestId)
    if (-not (Test-DysonQualificationV2Uuid -Value $RequestId)) {
        Throw-DysonQualificationV2Error -Code 'DYSON_QUALIFICATION_V2_REQUEST_INVALID'
    }
    return Join-Path $Paths.receipts ($RequestId + '.receipt.json')
}

function Get-DysonQualificationV2ReceiptChain {
    param([Parameter(Mandatory)]$Paths, [Parameter(Mandatory)]$Profile)
    if (-not (Test-Path -LiteralPath $Paths.receipts -PathType Container)) { return @() }
    $receipts = @()
    foreach ($item in @(Get-ChildItem -LiteralPath $Paths.receipts -Force -ErrorAction Stop)) {
        if ($item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -or
            $item.Name -cnotmatch '^[0-9a-f-]{36}\.receipt\.json$') {
            Throw-DysonQualificationV2Error -Code 'DYSON_QUALIFICATION_V2_RECEIPT_CHAIN_INVALID'
        }
        $receipt = Read-DysonQualificationV2JsonFile -Path $item.FullName -MaximumBytes 65536
        try { [void](Assert-DysonQualificationV2Receipt -Receipt $receipt) }
        catch { Throw-DysonQualificationV2Error -Code 'DYSON_QUALIFICATION_V2_RECEIPT_CHAIN_INVALID' }
        if ($item.Name -cne ([string]$receipt.requestId + '.receipt.json') -or
            [string]$receipt.profileId -cne [string]$Profile.profileId -or
            [string]$receipt.profileSha256 -cne (Get-DysonQualificationV2ProfileDigest -Profile $Profile)) {
            Throw-DysonQualificationV2Error -Code 'DYSON_QUALIFICATION_V2_RECEIPT_CHAIN_INVALID'
        }
        try {
            $intentPath = Get-DysonQualificationV2IntentPath -Paths $Paths -RequestId ([string]$receipt.requestId)
            if (-not (Test-Path -LiteralPath $intentPath -PathType Leaf)) { throw 'missing intent' }
            $intent = Read-DysonQualificationV2JsonFile -Path $intentPath -MaximumBytes 65536
            [void](Assert-DysonQualificationV2Intent -Intent $intent)
            if ([string]$intent.requestId -cne [string]$receipt.requestId -or
                [string]$intent.requestDigest -cne [string]$receipt.requestDigest -or
                [string]$intent.profileId -cne [string]$receipt.profileId -or
                [string]$intent.profileSha256 -cne [string]$receipt.profileSha256 -or
                [string]$intent.action -cne [string]$receipt.action -or
                [string]$intent.actionTargetId -cne [string]$receipt.actionTargetId -or
                [int64]$intent.sequence -ne [int64]$receipt.sequence -or
                [string]$intent.predecessorReceiptSha256 -cne [string]$receipt.predecessorReceiptSha256 -or
                [string]$intent.intentSha256 -cne [string]$receipt.intentSha256 -or
                [string]$intent.createdAtUtc -cne [string]$receipt.startedAtUtc) {
                throw 'intent receipt binding mismatch'
            }
        }
        catch { Throw-DysonQualificationV2Error -Code 'DYSON_QUALIFICATION_V2_RECEIPT_CHAIN_INVALID' }
        $receipts += ,$receipt
    }
    $receipts = @($receipts | Sort-Object -Property sequence)
    $previous = $script:DysonQualificationV2ZeroDigest
    $previousCompleted = [datetimeoffset]::MinValue
    $sequence = [int64]1
    $seen = @{}
    foreach ($receipt in $receipts) {
        $currentCompleted = ConvertFrom-DysonQualificationV2Utc `
            -Value ([string]$receipt.completedAtUtc) -Code 'DYSON_QUALIFICATION_V2_RECEIPT_CHAIN_INVALID'
        if ([int64]$receipt.sequence -ne $sequence -or
            [string]$receipt.predecessorReceiptSha256 -cne $previous -or
            $currentCompleted -lt $previousCompleted -or
            $seen.ContainsKey([string]$receipt.requestId)) {
            Throw-DysonQualificationV2Error -Code 'DYSON_QUALIFICATION_V2_RECEIPT_CHAIN_INVALID'
        }
        $seen[[string]$receipt.requestId] = $true
        $previous = [string]$receipt.receiptSha256
        $previousCompleted = $currentCompleted
        $sequence++
    }
    return $receipts
}

function Get-DysonQualificationV2PendingIntents {
    param(
        [Parameter(Mandatory)]$Paths,
        [Parameter(Mandatory)]$Profile,
        [Parameter(Mandatory)][AllowEmptyCollection()][object[]]$ReceiptChain
    )
    if (-not (Test-Path -LiteralPath $Paths.intents -PathType Container)) { return @() }
    $completedRequestIds = @{}
    foreach ($receipt in @($ReceiptChain)) {
        $completedRequestIds[[string]$receipt.requestId] = $true
    }
    $pending = @()
    foreach ($item in @(Get-ChildItem -LiteralPath $Paths.intents -Force -ErrorAction Stop)) {
        if ($item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -or
            $item.Name -cnotmatch '^[0-9a-f-]{36}\.intent\.json$') {
            Throw-DysonQualificationV2Error -Code 'DYSON_QUALIFICATION_V2_RECEIPT_CHAIN_INVALID'
        }
        try {
            $intent = Read-DysonQualificationV2JsonFile -Path $item.FullName -MaximumBytes 65536
            [void](Assert-DysonQualificationV2Intent -Intent $intent)
            if ($item.Name -cne ([string]$intent.requestId + '.intent.json') -or
                [string]$intent.profileId -cne [string]$Profile.profileId -or
                [string]$intent.profileSha256 -cne (Get-DysonQualificationV2ProfileDigest -Profile $Profile)) {
                throw 'intent identity mismatch'
            }
        }
        catch { Throw-DysonQualificationV2Error -Code 'DYSON_QUALIFICATION_V2_RECEIPT_CHAIN_INVALID' }
        if (-not $completedRequestIds.ContainsKey([string]$intent.requestId)) {
            $pending += ,$intent
        }
    }
    return $pending
}

function New-DysonQualificationV2Request {
    param(
        [Parameter(Mandatory)]$Profile,
        [Parameter(Mandatory)][string]$RequestId,
        [Parameter(Mandatory)][string]$ApprovalId,
        [Parameter(Mandatory)][string]$Action,
        [Parameter(Mandatory)][ValidateSet('preview','execute')][string]$Mode,
        [Parameter(Mandatory)][ValidateSet('production','fake')][string]$ExecutionScope,
        [Parameter(Mandatory)][datetimeoffset]$NowUtc,
        [Parameter(Mandatory)]$ProtectionPoint,
        [Parameter(Mandatory)]$Parameters,
        [string]$PredecessorReceiptSha256 = $script:DysonQualificationV2ZeroDigest,
        [AllowEmptyString()][string]$ConfirmationPhrase = ''
    )
    $configuration = Get-DysonQualificationV2ActionConfiguration -Profile $Profile -Action $Action
    $request = [pscustomobject][ordered]@{
        protocol = $script:DysonQualificationV2RequestProtocol
        schemaVersion = 2
        requestId = $RequestId
        approvalId = $ApprovalId
        profileId = [string]$Profile.profileId
        profileSha256 = Get-DysonQualificationV2ProfileDigest -Profile $Profile
        action = $Action
        actionTargetId = [string]$configuration.targetId
        mode = $Mode
        executionScope = $ExecutionScope
        targetIdentity = [string]$Profile.targetIdentity
        issuedAtUtc = ConvertTo-DysonQualificationV2Utc -Value $NowUtc
        maintenanceWindow = [pscustomobject][ordered]@{
            startAtUtc = ConvertTo-DysonQualificationV2Utc -Value $NowUtc.AddMinutes(-5)
            endAtUtc = ConvertTo-DysonQualificationV2Utc -Value $NowUtc.AddHours(1)
        }
        protectionPoint = $ProtectionPoint
        confirmationPhrase = $ConfirmationPhrase
        parameters = $Parameters
        predecessorReceiptSha256 = $PredecessorReceiptSha256
        previewSha256 = $null
    }
    $request.previewSha256 = Get-DysonQualificationV2PreviewDigest -Request $request
    return $request
}

function ConvertTo-DysonQualificationV2ExecuteRequest {
    param(
        [Parameter(Mandatory)]$PreviewRequest,
        [Parameter(Mandatory)]$Profile,
        [Parameter(Mandatory)][string]$ConfirmationPhrase,
        [datetimeoffset]$NowUtc = [datetimeoffset]::UtcNow
    )
    [void](Assert-DysonQualificationV2Request `
        -Request $PreviewRequest -Profile $Profile -NowUtc $NowUtc)
    if ([string]$PreviewRequest.mode -cne 'preview' -or
        -not [string]::IsNullOrEmpty([string]$PreviewRequest.confirmationPhrase)) {
        Throw-DysonQualificationV2Error -Code 'DYSON_QUALIFICATION_V2_PREVIEW_BINDING_INVALID'
    }
    $expected = Get-DysonQualificationV2ConfirmationPhrase `
        -ExecutionScope ([string]$PreviewRequest.executionScope) `
        -Action ([string]$PreviewRequest.action) -ProfileId ([string]$Profile.profileId) `
        -RequestId ([string]$PreviewRequest.requestId) `
        -PreviewSha256 ([string]$PreviewRequest.previewSha256)
    if ($ConfirmationPhrase -cne $expected) {
        Throw-DysonQualificationV2Error -Code 'DYSON_QUALIFICATION_V2_CONFIRMATION_INVALID'
    }
    $execute = ConvertTo-DysonQualificationV2CanonicalJson -Value $PreviewRequest | ConvertFrom-Json
    $execute.mode = 'execute'
    $execute.confirmationPhrase = $ConfirmationPhrase
    [void](Assert-DysonQualificationV2Request -Request $execute -Profile $Profile -NowUtc $NowUtc)
    return $execute
}

function New-DysonQualificationV2Intent {
    param(
        [Parameter(Mandatory)]$Request,
        [Parameter(Mandatory)]$Profile,
        [Parameter(Mandatory)][int64]$Sequence,
        [Parameter(Mandatory)][datetimeoffset]$NowUtc,
        [Parameter(Mandatory)][int]$TimeoutSeconds
    )
    $intent = [pscustomobject][ordered]@{
        protocol = $script:DysonQualificationV2IntentProtocol
        schemaVersion = 2
        requestId = [string]$Request.requestId
        requestDigest = Get-DysonQualificationV2RequestDigest -Request $Request
        profileId = [string]$Profile.profileId
        profileSha256 = Get-DysonQualificationV2ProfileDigest -Profile $Profile
        action = [string]$Request.action
        actionTargetId = [string]$Request.actionTargetId
        sequence = $Sequence
        predecessorReceiptSha256 = [string]$Request.predecessorReceiptSha256
        state = 'prepared'
        createdAtUtc = ConvertTo-DysonQualificationV2Utc -Value $NowUtc
        deadlineAtUtc = ConvertTo-DysonQualificationV2Utc -Value $NowUtc.AddSeconds($TimeoutSeconds)
        intentSha256 = $null
    }
    $intent.intentSha256 = Get-DysonQualificationV2ObjectDigest -Value (
        Get-DysonQualificationV2UnsignedValue -Value $intent -DigestProperty 'intentSha256'
    )
    [void](Assert-DysonQualificationV2Intent -Intent $intent)
    return $intent
}

function New-DysonQualificationV2Receipt {
    param(
        [Parameter(Mandatory)]$Intent,
        [Parameter(Mandatory)][ValidateSet('passed','compensated','recovery-required')][string]$Status,
        [Parameter(Mandatory)][string]$OutcomeCode,
        [Parameter(Mandatory)][bool]$CompensationAttempted,
        [Parameter(Mandatory)][ValidateSet('not-required','passed','failed')][string]$CompensationStatus,
        [Parameter(Mandatory)][ValidateSet('production','fake')][string]$ExecutionScope,
        [Parameter(Mandatory)][datetimeoffset]$CompletedAtUtc
    )
    $receipt = [pscustomobject][ordered]@{
        protocol = $script:DysonQualificationV2ReceiptProtocol
        schemaVersion = 2
        requestId = [string]$Intent.requestId
        requestDigest = [string]$Intent.requestDigest
        profileId = [string]$Intent.profileId
        profileSha256 = [string]$Intent.profileSha256
        action = [string]$Intent.action
        actionTargetId = [string]$Intent.actionTargetId
        sequence = [int64]$Intent.sequence
        predecessorReceiptSha256 = [string]$Intent.predecessorReceiptSha256
        intentSha256 = [string]$Intent.intentSha256
        status = $Status
        startedAtUtc = [string]$Intent.createdAtUtc
        completedAtUtc = ConvertTo-DysonQualificationV2Utc -Value $CompletedAtUtc
        outcomeCode = $OutcomeCode
        compensation = [pscustomobject][ordered]@{
            attempted = $CompensationAttempted
            status = $CompensationStatus
        }
        executionScope = $ExecutionScope
        productionChanged = ($ExecutionScope -ceq 'production')
        receiptSha256 = $null
    }
    $receipt.receiptSha256 = Get-DysonQualificationV2ObjectDigest -Value (
        Get-DysonQualificationV2UnsignedValue -Value $receipt -DigestProperty 'receiptSha256'
    )
    [void](Assert-DysonQualificationV2Receipt -Receipt $receipt)
    return $receipt
}

function Enter-DysonQualificationV2ExecutionLock {
    param([Parameter(Mandatory)]$Paths, [Parameter(Mandatory)][string]$RequestId)
    try {
        $stream = New-Object IO.FileStream($Paths.lock, [IO.FileMode]::OpenOrCreate,
            [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)
        $stream.SetLength(0)
        $bytes = [Text.UTF8Encoding]::new($false).GetBytes($RequestId + "`n")
        $stream.Write($bytes, 0, $bytes.Length)
        $stream.Flush($true)
        return $stream
    }
    catch { Throw-DysonQualificationV2Error -Code 'DYSON_QUALIFICATION_V2_EXECUTION_BUSY' }
}

function Invoke-DysonQualificationV2BackendInspect {
    param($Request,$Configuration,[string]$Backend,[string]$FakeRoot,$Intent)
    if ($Backend -ceq 'Production') {
        return Invoke-DysonQualificationV2ProductionInspect -Request $Request -Configuration $Configuration `
            -Intent $Intent
    }
    $intentCreatedAtUtc = ConvertFrom-DysonQualificationV2Utc -Value ([string]$Intent.createdAtUtc) `
        -Code 'DYSON_QUALIFICATION_V2_INTENT_INVALID'
    return Invoke-DysonQualificationV2FakeInspect -Request $Request -Configuration $Configuration `
        -FakeRoot $FakeRoot -IntentCreatedAtUtc $IntentCreatedAtUtc
}

function Invoke-DysonQualificationV2BackendExecute {
    param($Request,$Configuration,[string]$Backend,[string]$FakeRoot,[datetimeoffset]$DeadlineUtc,
        $Intent,[string]$Injection)
    if ($Backend -ceq 'Production') {
        return Invoke-DysonQualificationV2ProductionExecute -Request $Request -Configuration $Configuration `
            -DeadlineUtc $DeadlineUtc -Intent $Intent
    }
    $intentCreatedAtUtc = ConvertFrom-DysonQualificationV2Utc -Value ([string]$Intent.createdAtUtc) `
        -Code 'DYSON_QUALIFICATION_V2_INTENT_INVALID'
    return Invoke-DysonQualificationV2FakeExecute -Request $Request -Configuration $Configuration `
        -FakeRoot $FakeRoot -DeadlineUtc $DeadlineUtc -IntentCreatedAtUtc $IntentCreatedAtUtc -Injection $Injection
}

function Invoke-DysonQualificationV2BackendCompensate {
    param($Request,$Configuration,[string]$Backend,[string]$FakeRoot,[datetimeoffset]$DeadlineUtc,
        $Intent,[string]$Injection)
    if ($Backend -ceq 'Production') {
        return Invoke-DysonQualificationV2ProductionCompensate -Request $Request -Configuration $Configuration `
            -DeadlineUtc $DeadlineUtc -Intent $Intent
    }
    $intentCreatedAtUtc = ConvertFrom-DysonQualificationV2Utc -Value ([string]$Intent.createdAtUtc) `
        -Code 'DYSON_QUALIFICATION_V2_INTENT_INVALID'
    return Invoke-DysonQualificationV2FakeCompensate -Request $Request -Configuration $Configuration `
        -FakeRoot $FakeRoot -DeadlineUtc $DeadlineUtc -IntentCreatedAtUtc $IntentCreatedAtUtc -Injection $Injection
}

function Get-DysonQualificationV2CompletionTime {
    param(
        [Parameter(Mandatory)][ValidateSet('Production','Fake')][string]$Backend,
        [Parameter(Mandatory)][datetimeoffset]$FakeNowUtc
    )
    if ($Backend -ceq 'Production') { return [datetimeoffset]::UtcNow }
    return $FakeNowUtc.AddSeconds(1)
}

function Get-DysonQualificationV2CompensationDeadline {
    param(
        [Parameter(Mandatory)][ValidateSet('Production','Fake')][string]$Backend,
        [Parameter(Mandatory)][datetimeoffset]$EffectiveNowUtc,
        [Parameter(Mandatory)][datetimeoffset]$IntentDeadlineUtc,
        [Parameter(Mandatory)][int]$TimeoutSeconds
    )
    $current = if ($Backend -ceq 'Production') { [datetimeoffset]::UtcNow } else { $EffectiveNowUtc }
    if ($IntentDeadlineUtc -gt $current) { return $IntentDeadlineUtc }
    return $current.AddSeconds([Math]::Min($TimeoutSeconds, 300))
}

function Invoke-DysonQualificationActionV2 {
    [CmdletBinding(DefaultParameterSetName = 'Production')]
    param(
        [Parameter(Mandatory)]$Request,
        [Parameter(Mandatory)][ValidateSet('Production','Fake')][string]$Backend,
        [Parameter(Mandatory, ParameterSetName = 'Production')][string]$ProfilePath,
        [Parameter(Mandatory, ParameterSetName = 'Fake')]$Profile,
        [Parameter(Mandatory, ParameterSetName = 'Fake')][string]$FakeRoot,
        [switch]$Resume,
        [datetimeoffset]$NowUtc = [datetimeoffset]::UtcNow,
        [ValidateSet('None','HardExitAfterIntent','Timeout','EffectThenExit','CompensationFailure',
            'IntentBeforeWrite','IntentMidWrite','IntentAfterFlushBeforeRename','IntentAfterRename',
            'ReceiptBeforeWrite','ReceiptMidWrite','ReceiptAfterFlushBeforeRename','ReceiptAfterRename')]
        [string]$Injection = 'None'
    )
    $effectiveNow = if ($Backend -ceq 'Production') { [datetimeoffset]::UtcNow } else { $NowUtc }
    if ($Backend -ceq 'Production') {
        if ($Injection -cne 'None') { Throw-DysonQualificationV2Error -Code 'DYSON_QUALIFICATION_V2_INJECTION_FORBIDDEN' }
        $Profile = Import-DysonQualificationV2ProductionProfile -Path $ProfilePath `
            -NowUtc $effectiveNow -AllowExpired:$Resume
        . (Join-Path $PSScriptRoot 'Qualification.ProductionAdaptersV2.ps1')
    }
    else {
        [void](Assert-DysonQualificationV2Profile -Profile $Profile -NowUtc $effectiveNow -AllowExpired:$Resume)
        . (Join-Path $PSScriptRoot 'Qualification.FakeV2.ps1')
        $fakeFull = Assert-DysonQualificationV2FakeRoot -FakeRoot $FakeRoot -RequireMarker
        if (-not (Test-DysonQualificationV2PathWithin -Candidate ([string]$Profile.stateRoot) -Parent $fakeFull) -or
            -not (Test-DysonQualificationV2PathWithin -Candidate ([string]$Profile.actions.diskPressure.directoryPath) -Parent $fakeFull)) {
            Throw-DysonQualificationV2Error -Code 'DYSON_QUALIFICATION_V2_FAKE_ROOT_INVALID'
        }
        $fakeState = Read-DysonQualificationV2FakeState -FakeRoot $fakeFull
        if ([string]$fakeState.targetIdentity -cne [string]$Profile.targetIdentity) {
            Throw-DysonQualificationV2Error -Code 'DYSON_QUALIFICATION_V2_HOST_IDENTITY_MISMATCH'
        }
    }
    $configuration = Assert-DysonQualificationV2Request -Request $Request -Profile $Profile `
        -NowUtc $effectiveNow -Resume:$Resume
    $contract = Get-DysonQualificationV2AdapterContract -Action ([string]$Request.action)
    if ([string]$Request.mode -ceq 'preview') {
        return [pscustomobject][ordered]@{
            protocol = $script:DysonQualificationV2Protocol
            schemaVersion = 2
            requestId = [string]$Request.requestId
            action = [string]$Request.action
            mode = 'preview'
            status = 'preview'
            backend = $Backend.ToLowerInvariant()
            executed = $false
            productionChanged = $false
            profileMatched = $true
            targetMatched = if ($Backend -ceq 'Production') {
                Test-DysonQualificationV2ProductionHostIdentity -ExpectedIdentity ([string]$Profile.targetIdentity)
            }
            else { $true }
            previewSha256 = [string]$Request.previewSha256
            requiredConfirmationPhrase = Get-DysonQualificationV2ConfirmationPhrase `
                -ExecutionScope ([string]$Request.executionScope) -Action ([string]$Request.action) `
                -ProfileId ([string]$Profile.profileId) -RequestId ([string]$Request.requestId) `
                -PreviewSha256 ([string]$Request.previewSha256)
            adapter = $contract
        }
    }
    if (-not [bool]$Profile.enabled) {
        Throw-DysonQualificationV2Error -Code 'DYSON_QUALIFICATION_V2_PROFILE_DISABLED'
    }
    if ($Backend -ceq 'Production') {
        if ([string]$Request.executionScope -cne 'production' -or
            [Environment]::GetEnvironmentVariable($script:DysonQualificationV2ProductionEnvironmentName,
                [EnvironmentVariableTarget]::Process) -cne $script:DysonQualificationV2ProductionEnvironmentValue) {
            Throw-DysonQualificationV2Error -Code 'DYSON_QUALIFICATION_V2_PRODUCTION_EXECUTION_DISABLED'
        }
        Assert-DysonQualificationV2ProductionHostIdentity -ExpectedIdentity ([string]$Profile.targetIdentity)
    }
    else {
        if ([string]$Request.executionScope -cne 'fake' -or
            [Environment]::GetEnvironmentVariable($script:DysonQualificationV2FakeEnvironmentName,
                [EnvironmentVariableTarget]::Process) -cne $script:DysonQualificationV2FakeEnvironmentValue) {
            Throw-DysonQualificationV2Error -Code 'DYSON_QUALIFICATION_V2_FAKE_EXECUTION_DISABLED'
        }
    }
    $paths = Get-DysonQualificationV2StorePaths -Profile $Profile -Initialize
    $lock = Enter-DysonQualificationV2ExecutionLock -Paths $paths -RequestId ([string]$Request.requestId)
    try {
        [void](Assert-DysonQualificationV2NoOrphanedAtomicWrites -Paths $paths)
        if ($Backend -ceq 'Production') {
            [void](Assert-DysonQualificationV2ProductionProtectionEvidence -Paths $paths -Profile $Profile `
                -Request $Request -NowUtc $effectiveNow -AllowExpired:$Resume)
        }
        $requestDigest = Get-DysonQualificationV2RequestDigest -Request $Request
        $receiptPath = Get-DysonQualificationV2ReceiptPath -Paths $paths -RequestId ([string]$Request.requestId)
        $chain = @(Get-DysonQualificationV2ReceiptChain -Paths $paths -Profile $Profile)
        $pendingIntents = @(Get-DysonQualificationV2PendingIntents -Paths $paths -Profile $Profile `
            -ReceiptChain $chain)
        if ($pendingIntents.Count -gt 1 -or
            ($pendingIntents.Count -eq 1 -and
                [string]$pendingIntents[0].requestId -cne [string]$Request.requestId)) {
            Throw-DysonQualificationV2Error -Code 'DYSON_QUALIFICATION_V2_MANUAL_RECOVERY_REQUIRED'
        }
        if ($pendingIntents.Count -eq 1 -and -not $Resume) {
            Throw-DysonQualificationV2Error -Code 'DYSON_QUALIFICATION_V2_RESUME_REQUIRED'
        }
        if (Test-Path -LiteralPath $receiptPath -PathType Leaf) {
            $matches = @($chain | Where-Object { [string]$_.requestId -ceq [string]$Request.requestId })
            if ($matches.Count -ne 1) {
                Throw-DysonQualificationV2Error -Code 'DYSON_QUALIFICATION_V2_RECEIPT_CHAIN_INVALID'
            }
            $existing = $matches[0]
            $existingIntentPath = Get-DysonQualificationV2IntentPath -Paths $paths `
                -RequestId ([string]$Request.requestId)
            $existingIntent = Read-DysonQualificationV2JsonFile -Path $existingIntentPath -MaximumBytes 65536
            [void](Assert-DysonQualificationV2Intent -Intent $existingIntent)
            if ([string]$existing.requestDigest -cne $requestDigest -or
                [string]$existing.requestId -cne [string]$Request.requestId -or
                [string]$existing.profileId -cne [string]$Profile.profileId -or
                [string]$existing.profileSha256 -cne (Get-DysonQualificationV2ProfileDigest -Profile $Profile) -or
                [string]$existing.action -cne [string]$Request.action -or
                [string]$existing.actionTargetId -cne [string]$Request.actionTargetId -or
                [string]$existing.executionScope -cne [string]$Request.executionScope -or
                [string]$existing.predecessorReceiptSha256 -cne [string]$Request.predecessorReceiptSha256 -or
                [string]$existingIntent.requestDigest -cne $requestDigest -or
                [string]$existingIntent.requestId -cne [string]$Request.requestId -or
                [string]$existingIntent.profileId -cne [string]$Profile.profileId -or
                [string]$existingIntent.profileSha256 -cne (Get-DysonQualificationV2ProfileDigest -Profile $Profile) -or
                [string]$existingIntent.action -cne [string]$Request.action -or
                [string]$existingIntent.actionTargetId -cne [string]$Request.actionTargetId -or
                [string]$existingIntent.predecessorReceiptSha256 -cne [string]$Request.predecessorReceiptSha256 -or
                [int64]$existingIntent.sequence -ne [int64]$existing.sequence -or
                [string]$existingIntent.intentSha256 -cne [string]$existing.intentSha256) {
                Throw-DysonQualificationV2Error -Code 'DYSON_QUALIFICATION_V2_REQUEST_COLLISION'
            }
            return [pscustomobject][ordered]@{
                status = 'completed'
                reused = $true
                receipt = $existing
                productionChanged = [bool]$existing.productionChanged
            }
        }
        $head = if ($chain.Count -eq 0) { $script:DysonQualificationV2ZeroDigest } else { [string]$chain[-1].receiptSha256 }
        if ([string]$Request.predecessorReceiptSha256 -cne $head) {
            Throw-DysonQualificationV2Error -Code 'DYSON_QUALIFICATION_V2_PREDECESSOR_MISMATCH'
        }
        if ($chain.Count -gt 0 -and [string]$chain[-1].status -ceq 'recovery-required') {
            Throw-DysonQualificationV2Error -Code 'DYSON_QUALIFICATION_V2_MANUAL_RECOVERY_REQUIRED'
        }
        $intentPath = Get-DysonQualificationV2IntentPath -Paths $paths -RequestId ([string]$Request.requestId)
        $intent = $null
        if (Test-Path -LiteralPath $intentPath -PathType Leaf) {
            $intent = Read-DysonQualificationV2JsonFile -Path $intentPath -MaximumBytes 65536
            [void](Assert-DysonQualificationV2Intent -Intent $intent)
            if ([string]$intent.requestDigest -cne $requestDigest -or
                [string]$intent.requestId -cne [string]$Request.requestId -or
                [string]$intent.profileId -cne [string]$Profile.profileId -or
                [string]$intent.profileSha256 -cne (Get-DysonQualificationV2ProfileDigest -Profile $Profile) -or
                [string]$intent.action -cne [string]$Request.action -or
                [string]$intent.actionTargetId -cne [string]$Request.actionTargetId -or
                [string]$intent.predecessorReceiptSha256 -cne $head -or
                [int64]$intent.sequence -ne ($chain.Count + 1)) {
                Throw-DysonQualificationV2Error -Code 'DYSON_QUALIFICATION_V2_REQUEST_COLLISION'
            }
            if (-not $Resume) {
                Throw-DysonQualificationV2Error -Code 'DYSON_QUALIFICATION_V2_RESUME_REQUIRED'
            }
        }
        else {
            if ($Resume) { Throw-DysonQualificationV2Error -Code 'DYSON_QUALIFICATION_V2_INTENT_NOT_FOUND' }
            $intent = New-DysonQualificationV2Intent -Request $Request -Profile $Profile `
                -Sequence ($chain.Count + 1) -NowUtc $effectiveNow -TimeoutSeconds ([int]$configuration.timeoutSeconds)
            Write-DysonQualificationV2JsonAtomicCreateNew -Path $intentPath -Value $intent `
                -RecordKind Intent -Injection $Injection
            if ($Injection -ceq 'HardExitAfterIntent') {
                Throw-DysonQualificationV2Error -Code 'DYSON_QUALIFICATION_V2_FAKE_INTENT_EXIT'
            }
        }
        $intentCreated = ConvertFrom-DysonQualificationV2Utc -Value ([string]$intent.createdAtUtc) `
            -Code 'DYSON_QUALIFICATION_V2_INTENT_INVALID'
        $deadline = ConvertFrom-DysonQualificationV2Utc -Value ([string]$intent.deadlineAtUtc) `
            -Code 'DYSON_QUALIFICATION_V2_INTENT_INVALID'
        $backendInjection = if ($Injection -in @('Timeout','EffectThenExit','CompensationFailure')) {
            $Injection
        }
        else { 'None' }
        $receipt = $null
        if ($Resume) {
            $inspection = Invoke-DysonQualificationV2BackendInspect -Request $Request -Configuration $configuration `
                -Backend $Backend -FakeRoot $FakeRoot -Intent $intent
            if ([string]$inspection.state -ceq 'completed') {
                $receipt = New-DysonQualificationV2Receipt -Intent $intent -Status passed `
                    -OutcomeCode ([string]$inspection.outcomeCode) -CompensationAttempted $false `
                    -CompensationStatus not-required -ExecutionScope ([string]$Request.executionScope) `
                    -CompletedAtUtc (Get-DysonQualificationV2CompletionTime -Backend $Backend -FakeNowUtc $effectiveNow)
            }
            elseif ([string]$inspection.state -ceq 'safe-terminal') {
                $receipt = New-DysonQualificationV2Receipt -Intent $intent -Status compensated `
                    -OutcomeCode ([string]$inspection.outcomeCode) -CompensationAttempted $false `
                    -CompensationStatus not-required -ExecutionScope ([string]$Request.executionScope) `
                    -CompletedAtUtc (Get-DysonQualificationV2CompletionTime -Backend $Backend -FakeNowUtc $effectiveNow)
            }
            else {
                $compensationDeadline = Get-DysonQualificationV2CompensationDeadline `
                    -Backend $Backend -EffectiveNowUtc $effectiveNow -IntentDeadlineUtc $deadline `
                    -TimeoutSeconds ([int]$configuration.timeoutSeconds)
                $compensation = Invoke-DysonQualificationV2BackendCompensate -Request $Request `
                    -Configuration $configuration -Backend $Backend -FakeRoot $FakeRoot -DeadlineUtc $compensationDeadline `
                    -Intent $intent -Injection $backendInjection
                $receipt = New-DysonQualificationV2Receipt -Intent $intent `
                    -Status $(if ([bool]$compensation.success) { 'compensated' } else { 'recovery-required' }) `
                    -OutcomeCode ([string]$compensation.outcomeCode) -CompensationAttempted $true `
                    -CompensationStatus $(if ([bool]$compensation.success) { 'passed' } else { 'failed' }) `
                    -ExecutionScope ([string]$Request.executionScope) `
                    -CompletedAtUtc (Get-DysonQualificationV2CompletionTime -Backend $Backend -FakeNowUtc $effectiveNow)
            }
        }
        else {
            try {
                $effect = Invoke-DysonQualificationV2BackendExecute -Request $Request -Configuration $configuration `
                    -Backend $Backend -FakeRoot $FakeRoot -DeadlineUtc $deadline `
                    -Intent $intent -Injection $backendInjection
                $inspection = Invoke-DysonQualificationV2BackendInspect -Request $Request -Configuration $configuration `
                    -Backend $Backend -FakeRoot $FakeRoot -Intent $intent
                if (-not [bool]$effect.success -or [string]$inspection.state -ceq 'needs-compensation') {
                    Throw-DysonQualificationV2Error -Code 'DYSON_QUALIFICATION_V2_VERIFICATION_FAILED'
                }
                $receipt = New-DysonQualificationV2Receipt -Intent $intent -Status passed `
                    -OutcomeCode ([string]$effect.outcomeCode) -CompensationAttempted $false `
                    -CompensationStatus not-required -ExecutionScope ([string]$Request.executionScope) `
                    -CompletedAtUtc (Get-DysonQualificationV2CompletionTime -Backend $Backend -FakeNowUtc $effectiveNow)
            }
            catch {
                $failureCode = Get-DysonQualificationV2ErrorCode -Exception $_.Exception
                if ($Backend -ceq 'Fake' -and $failureCode -ceq 'DYSON_QUALIFICATION_V2_FAKE_EFFECT_EXIT') { throw }
                $compensationDeadline = Get-DysonQualificationV2CompensationDeadline `
                    -Backend $Backend -EffectiveNowUtc $effectiveNow -IntentDeadlineUtc $deadline `
                    -TimeoutSeconds ([int]$configuration.timeoutSeconds)
                $compensation = Invoke-DysonQualificationV2BackendCompensate -Request $Request `
                    -Configuration $configuration -Backend $Backend -FakeRoot $FakeRoot -DeadlineUtc $compensationDeadline `
                    -Intent $intent -Injection $backendInjection
                $receipt = New-DysonQualificationV2Receipt -Intent $intent `
                    -Status $(if ([bool]$compensation.success) { 'compensated' } else { 'recovery-required' }) `
                    -OutcomeCode ([string]$compensation.outcomeCode) -CompensationAttempted $true `
                    -CompensationStatus $(if ([bool]$compensation.success) { 'passed' } else { 'failed' }) `
                    -ExecutionScope ([string]$Request.executionScope) `
                    -CompletedAtUtc (Get-DysonQualificationV2CompletionTime -Backend $Backend -FakeNowUtc $effectiveNow)
            }
        }
        Write-DysonQualificationV2JsonAtomicCreateNew -Path $receiptPath -Value $receipt `
            -RecordKind Receipt -Injection $Injection
        return [pscustomobject][ordered]@{
            status = 'completed'
            reused = $false
            receipt = $receipt
            productionChanged = [bool]$receipt.productionChanged
        }
    }
    finally { if ($null -ne $lock) { $lock.Dispose() } }
}
