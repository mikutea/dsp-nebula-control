# Copyright (c) Dyson Control contributors.
# Production-capable qualification protocol v2. Loading this file is read-only.

Set-StrictMode -Version 2.0

$script:DysonQualificationV2Protocol = 'DYSON_PRODUCTION_QUALIFICATION_V2'
$script:DysonQualificationV2SchemaVersion = 2
$script:DysonQualificationV2RequestProtocol = 'DYSON_QUALIFICATION_ACTION_REQUEST_V2'
$script:DysonQualificationV2ProfileProtocol = 'DYSON_QUALIFICATION_PRODUCTION_PROFILE_V2'
$script:DysonQualificationV2ProtectionProtocol = 'DYSON_QUALIFICATION_PROTECTION_POINT_V2'
$script:DysonQualificationV2IntentProtocol = 'DYSON_QUALIFICATION_ACTION_INTENT_V2'
$script:DysonQualificationV2ReceiptProtocol = 'DYSON_QUALIFICATION_ACTION_RECEIPT_V2'
$script:DysonQualificationV2ProductionEnvironmentName = 'DYSON_QUALIFICATION_PRODUCTION_V2'
$script:DysonQualificationV2ProductionEnvironmentValue = 'ALLOW_FIXED_PRODUCTION_ADAPTERS_V2'
$script:DysonQualificationV2FakeEnvironmentName = 'DYSON_QUALIFICATION_FAKE_V2'
$script:DysonQualificationV2FakeEnvironmentValue = 'FIXTURE_ONLY_V2'
$script:DysonQualificationV2Actions = @(
    'control-plane-restart',
    'dsp-crash-recovery',
    'storage-interruption',
    'disk-pressure'
)

function New-DysonQualificationV2Exception {
    param([Parameter(Mandatory)][string]$Code)
    $exception = New-Object System.InvalidOperationException($Code)
    $exception.Data['Code'] = $Code
    return $exception
}

function Throw-DysonQualificationV2Error {
    param([Parameter(Mandatory)][string]$Code)
    throw (New-DysonQualificationV2Exception -Code $Code)
}

function Get-DysonQualificationV2ErrorCode {
    param([Parameter(Mandatory)][System.Exception]$Exception)
    if ($Exception.Data.Contains('Code')) { return [string]$Exception.Data['Code'] }
    if ([string]$Exception.Message -cmatch '^DYSON_QUALIFICATION_V2_[A-Z0-9_]+$') {
        return [string]$Exception.Message
    }
    return 'DYSON_QUALIFICATION_V2_UNEXPECTED_FAILURE'
}

function Test-DysonQualificationV2Uuid {
    param([AllowNull()][string]$Value)
    if ([string]::IsNullOrWhiteSpace($Value)) { return $false }
    $parsed = [guid]::Empty
    if (-not [guid]::TryParseExact($Value, 'D', [ref]$parsed)) { return $false }
    return $parsed.ToString('D').ToLowerInvariant() -ceq $Value
}

function Test-DysonQualificationV2Digest {
    param([AllowNull()][string]$Value)
    return -not [string]::IsNullOrWhiteSpace($Value) -and $Value -cmatch '^sha256:[0-9a-f]{64}$'
}

function Test-DysonQualificationV2Integer {
    param([AllowNull()]$Value)
    return $Value -is [byte] -or $Value -is [sbyte] -or
        $Value -is [int16] -or $Value -is [uint16] -or
        $Value -is [int32] -or $Value -is [uint32] -or
        $Value -is [int64] -or $Value -is [uint64]
}

function ConvertTo-DysonQualificationV2CanonicalValue {
    param([AllowNull()]$Value)
    if ($null -eq $Value) { return $null }
    if ($Value -is [string] -or $Value -is [bool] -or
        $Value -is [byte] -or $Value -is [int16] -or $Value -is [int32] -or
        $Value -is [int64] -or $Value -is [uint16] -or $Value -is [uint32] -or
        $Value -is [uint64] -or $Value -is [decimal] -or $Value -is [double]) {
        return $Value
    }
    if ($Value -is [datetime] -or $Value -is [datetimeoffset] -or $Value -is [guid]) {
        return [string]$Value
    }
    if ($Value -is [System.Collections.IDictionary]) {
        $ordered = [ordered]@{}
        foreach ($key in @($Value.Keys | ForEach-Object { [string]$_ } | Sort-Object -CaseSensitive)) {
            $ordered[$key] = ConvertTo-DysonQualificationV2CanonicalValue -Value $Value[$key]
        }
        return [pscustomobject]$ordered
    }
    if ($Value -is [System.Collections.IEnumerable]) {
        $items = @()
        foreach ($item in $Value) {
            $items += ,(ConvertTo-DysonQualificationV2CanonicalValue -Value $item)
        }
        return ,$items
    }
    $properties = @($Value.PSObject.Properties | Where-Object { $_.MemberType -match 'Property' } |
        Sort-Object -Property Name -CaseSensitive)
    if ($properties.Count -eq 0) {
        if ($Value -is [pscustomobject]) { return [pscustomobject][ordered]@{} }
        return [string]$Value
    }
    $result = [ordered]@{}
    foreach ($property in $properties) {
        $result[$property.Name] = ConvertTo-DysonQualificationV2CanonicalValue -Value $property.Value
    }
    return [pscustomobject]$result
}

function ConvertTo-DysonQualificationV2CanonicalJson {
    param([Parameter(Mandatory)][AllowEmptyCollection()]$Value)
    return ConvertTo-Json -InputObject (ConvertTo-DysonQualificationV2CanonicalValue -Value $Value) -Depth 64 -Compress
}

function Get-DysonQualificationV2Sha256 {
    param([Parameter(Mandatory)][AllowEmptyString()][string]$Value)
    $sha = [System.Security.Cryptography.SHA256]::Create()
    try {
        $bytes = [System.Text.UTF8Encoding]::new($false).GetBytes($Value)
        $digest = $sha.ComputeHash($bytes)
        return 'sha256:' + ([System.BitConverter]::ToString($digest).Replace('-', '').ToLowerInvariant())
    }
    finally { $sha.Dispose() }
}

function Get-DysonQualificationV2ObjectDigest {
    param([Parameter(Mandatory)]$Value)
    return Get-DysonQualificationV2Sha256 -Value (ConvertTo-DysonQualificationV2CanonicalJson -Value $Value)
}

function ConvertFrom-DysonQualificationV2Utc {
    param([Parameter(Mandatory)][string]$Value, [Parameter(Mandatory)][string]$Code)
    if ($Value -cnotmatch '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$') {
        Throw-DysonQualificationV2Error -Code $Code
    }
    $parsed = [datetimeoffset]::MinValue
    $valid = [datetimeoffset]::TryParseExact(
        $Value,
        'yyyy-MM-ddTHH:mm:ss.fffZ',
        [Globalization.CultureInfo]::InvariantCulture,
        [Globalization.DateTimeStyles]::AssumeUniversal,
        [ref]$parsed
    )
    if (-not $valid) { Throw-DysonQualificationV2Error -Code $Code }
    return $parsed.ToUniversalTime()
}

function ConvertTo-DysonQualificationV2Utc {
    param([Parameter(Mandatory)][datetimeoffset]$Value)
    return $Value.ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ss.fffZ', [Globalization.CultureInfo]::InvariantCulture)
}

function Assert-DysonQualificationV2ExactProperties {
    param(
        [Parameter(Mandatory)]$Value,
        [Parameter(Mandatory)][string[]]$Names,
        [Parameter(Mandatory)][string]$Code
    )
    if ($null -eq $Value) { Throw-DysonQualificationV2Error -Code $Code }
    $actual = @($Value.PSObject.Properties | ForEach-Object { [string]$_.Name })
    if ($actual.Count -ne $Names.Count) { Throw-DysonQualificationV2Error -Code $Code }
    foreach ($name in $Names) {
        if ($actual -cnotcontains $name) { Throw-DysonQualificationV2Error -Code $Code }
    }
}

function Test-DysonQualificationV2LocalAbsolutePath {
    param([AllowNull()][string]$Value)
    if ([string]::IsNullOrWhiteSpace($Value) -or $Value.Length -gt 240 -or
        $Value -notmatch '^[A-Za-z]:\\' -or $Value -match '[*?]' -or
        $Value -match '(^|\\)\.\.(\\|$)') { return $false }
    try { return [IO.Path]::GetFullPath($Value) -ceq $Value.TrimEnd('\') }
    catch { return $false }
}

function Test-DysonQualificationV2PathWithin {
    param([Parameter(Mandatory)][string]$Candidate, [Parameter(Mandatory)][string]$Parent)
    $candidateFull = [IO.Path]::GetFullPath($Candidate).TrimEnd('\')
    $parentFull = [IO.Path]::GetFullPath($Parent).TrimEnd('\')
    if ($candidateFull.Equals($parentFull, [StringComparison]::OrdinalIgnoreCase)) { return $true }
    return $candidateFull.StartsWith($parentFull + '\', [StringComparison]::OrdinalIgnoreCase)
}

function Get-DysonQualificationV2ProfileDigest {
    param([Parameter(Mandatory)]$Profile)
    return Get-DysonQualificationV2ObjectDigest -Value $Profile
}

function Assert-DysonQualificationV2Profile {
    param(
        [Parameter(Mandatory)]$Profile,
        [datetimeoffset]$NowUtc = [datetimeoffset]::UtcNow,
        [switch]$AllowExpired
    )
    $code = 'DYSON_QUALIFICATION_V2_PROFILE_INVALID'
    Assert-DysonQualificationV2ExactProperties -Value $Profile -Names @(
        'protocol','schemaVersion','profileId','profileLabel','enabled','targetIdentity',
        'expiresAtUtc','stateRoot','protectedRoots','actions'
    ) -Code $code
    if ([string]$Profile.protocol -cne $script:DysonQualificationV2ProfileProtocol -or
        -not (Test-DysonQualificationV2Integer -Value $Profile.schemaVersion) -or
        [int]$Profile.schemaVersion -ne 2 -or
        -not (Test-DysonQualificationV2Uuid -Value ([string]$Profile.profileId)) -or
        [string]$Profile.profileLabel -cnotmatch '^[a-z0-9][a-z0-9-]{2,63}$' -or
        $Profile.enabled -isnot [bool] -or
        -not (Test-DysonQualificationV2Digest -Value ([string]$Profile.targetIdentity)) -or
        -not (Test-DysonQualificationV2LocalAbsolutePath -Value ([string]$Profile.stateRoot))) {
        Throw-DysonQualificationV2Error -Code $code
    }
    $expiry = ConvertFrom-DysonQualificationV2Utc -Value ([string]$Profile.expiresAtUtc) -Code $code
    if ((-not $AllowExpired -and ($expiry -le $NowUtc.AddMinutes(-1) -or $expiry -gt $NowUtc.AddDays(31))) -or
        ($AllowExpired -and ($expiry -lt $NowUtc.AddDays(-31) -or $expiry -gt $NowUtc.AddDays(31)))) {
        Throw-DysonQualificationV2Error -Code $code
    }
    if ($Profile.protectedRoots -is [string] -or @($Profile.protectedRoots).Count -lt 5 -or
        @($Profile.protectedRoots).Count -gt 16) { Throw-DysonQualificationV2Error -Code $code }
    $protected = @()
    foreach ($root in @($Profile.protectedRoots)) {
        if (-not (Test-DysonQualificationV2LocalAbsolutePath -Value ([string]$root))) {
            Throw-DysonQualificationV2Error -Code $code
        }
        $normalized = [IO.Path]::GetFullPath([string]$root).TrimEnd('\')
        if ($protected -icontains $normalized) { Throw-DysonQualificationV2Error -Code $code }
        $protected += $normalized
    }
    Assert-DysonQualificationV2ExactProperties -Value $Profile.actions -Names @(
        'controlPlaneRestart','dspCrashRecovery','storageInterruption','diskPressure'
    ) -Code $code
    $processNames = @(
        'enabled','targetId','executablePath','executableSha256','commandLineSha256',
        'releaseSha256','runtimeSha256','pidFilePath','startTaskName','startTaskSha256',
        'readinessFilePath','timeoutSeconds'
    )
    foreach ($name in @('controlPlaneRestart','dspCrashRecovery')) {
        $action = $Profile.actions.$name
        Assert-DysonQualificationV2ExactProperties -Value $action -Names $processNames -Code $code
        if ($action.enabled -isnot [bool] -or
            [string]$action.targetId -cnotmatch '^[a-z0-9][a-z0-9-]{2,63}$' -or
            -not (Test-DysonQualificationV2LocalAbsolutePath -Value ([string]$action.executablePath)) -or
            -not (Test-DysonQualificationV2Digest -Value ([string]$action.executableSha256)) -or
            -not (Test-DysonQualificationV2Digest -Value ([string]$action.commandLineSha256)) -or
            -not (Test-DysonQualificationV2Digest -Value ([string]$action.releaseSha256)) -or
            -not (Test-DysonQualificationV2Digest -Value ([string]$action.runtimeSha256)) -or
            -not (Test-DysonQualificationV2LocalAbsolutePath -Value ([string]$action.pidFilePath)) -or
            -not (Test-DysonQualificationV2LocalAbsolutePath -Value ([string]$action.readinessFilePath)) -or
            [string]$action.startTaskName -cnotmatch '^\\[A-Za-z0-9_. -]+(?:\\[A-Za-z0-9_. -]+)*$' -or
            -not (Test-DysonQualificationV2Digest -Value ([string]$action.startTaskSha256)) -or
            -not (Test-DysonQualificationV2Integer -Value $action.timeoutSeconds) -or
            [int]$action.timeoutSeconds -lt 30 -or [int]$action.timeoutSeconds -gt 900) {
            Throw-DysonQualificationV2Error -Code $code
        }
    }
    $control = $Profile.actions.controlPlaneRestart
    $dsp = $Profile.actions.dspCrashRecovery
    foreach ($property in @('targetId','executablePath','pidFilePath','startTaskName','readinessFilePath')) {
        if ([string]$control.$property -ieq [string]$dsp.$property) {
            Throw-DysonQualificationV2Error -Code 'DYSON_QUALIFICATION_V2_PROCESS_TARGETS_OVERLAP'
        }
    }
    $processPaths = @(
        [string]$control.executablePath,
        [string]$control.pidFilePath,
        [string]$control.readinessFilePath,
        [string]$dsp.executablePath,
        [string]$dsp.pidFilePath,
        [string]$dsp.readinessFilePath
    )
    if (@($processPaths | Sort-Object -Unique).Count -ne $processPaths.Count) {
        Throw-DysonQualificationV2Error -Code 'DYSON_QUALIFICATION_V2_PROCESS_TARGETS_OVERLAP'
    }
    $storage = $Profile.actions.storageInterruption
    Assert-DysonQualificationV2ExactProperties -Value $storage -Names @(
        'enabled','targetId','dependencyKind','localPath','remotePath','restoreTaskName','restoreTaskSha256',
        'maximumInterruptionSeconds','timeoutSeconds'
    ) -Code $code
    if ($storage.enabled -isnot [bool] -or
        [string]$storage.targetId -cnotmatch '^[a-z0-9][a-z0-9-]{2,63}$' -or
        [string]$storage.dependencyKind -cne 'smb-global-mapping' -or
        [string]$storage.localPath -cnotmatch '^[A-Z]:$' -or
        [string]$storage.remotePath -cnotmatch '^\\\\[A-Za-z0-9.-]+\\[A-Za-z0-9$_. -]+$' -or
        [string]$storage.restoreTaskName -cnotmatch '^\\[A-Za-z0-9_. -]+(?:\\[A-Za-z0-9_. -]+)*$' -or
        -not (Test-DysonQualificationV2Digest -Value ([string]$storage.restoreTaskSha256)) -or
        -not (Test-DysonQualificationV2Integer -Value $storage.maximumInterruptionSeconds) -or
        -not (Test-DysonQualificationV2Integer -Value $storage.timeoutSeconds) -or
        [int]$storage.maximumInterruptionSeconds -lt 10 -or
        [int]$storage.maximumInterruptionSeconds -gt 300 -or
        [int]$storage.timeoutSeconds -lt ([int]$storage.maximumInterruptionSeconds + 30) -or
        [int]$storage.timeoutSeconds -gt 900) {
        Throw-DysonQualificationV2Error -Code $code
    }
    $taskIdentities = @(
        [string]$control.startTaskName,
        [string]$dsp.startTaskName,
        [string]$storage.restoreTaskName
    )
    if (@($taskIdentities | Sort-Object -Unique).Count -ne $taskIdentities.Count) {
        Throw-DysonQualificationV2Error -Code 'DYSON_QUALIFICATION_V2_PROCESS_TARGETS_OVERLAP'
    }
    $disk = $Profile.actions.diskPressure
    Assert-DysonQualificationV2ExactProperties -Value $disk -Names @(
        'enabled','targetId','directoryPath','volumeRoot','markerValue','maximumAllocationBytes',
        'minimumFreeBytes','maximumUsedPercent','maximumHoldSeconds','timeoutSeconds'
    ) -Code $code
    if ($disk.enabled -isnot [bool] -or
        [string]$disk.targetId -cnotmatch '^[a-z0-9][a-z0-9-]{2,63}$' -or
        -not (Test-DysonQualificationV2LocalAbsolutePath -Value ([string]$disk.directoryPath)) -or
        [string]$disk.volumeRoot -cnotmatch '^[A-Z]:\\$' -or
        [string]$disk.markerValue -cne 'DYSON_QUALIFICATION_DISPOSABLE_V2' -or
        -not (Test-DysonQualificationV2Integer -Value $disk.maximumAllocationBytes) -or
        -not (Test-DysonQualificationV2Integer -Value $disk.minimumFreeBytes) -or
        -not (Test-DysonQualificationV2Integer -Value $disk.maximumUsedPercent) -or
        -not (Test-DysonQualificationV2Integer -Value $disk.maximumHoldSeconds) -or
        -not (Test-DysonQualificationV2Integer -Value $disk.timeoutSeconds) -or
        [int64]$disk.maximumAllocationBytes -lt 1048576 -or
        [int64]$disk.maximumAllocationBytes -gt 68719476736 -or
        [int64]$disk.minimumFreeBytes -lt 10737418240 -or
        [int]$disk.maximumUsedPercent -lt 1 -or [int]$disk.maximumUsedPercent -gt 85 -or
        [int]$disk.maximumHoldSeconds -lt 0 -or [int]$disk.maximumHoldSeconds -gt 300 -or
        [int]$disk.timeoutSeconds -lt 30 -or [int]$disk.timeoutSeconds -gt 900) {
        Throw-DysonQualificationV2Error -Code $code
    }
    if (-not (Test-DysonQualificationV2PathWithin -Candidate ([string]$disk.directoryPath) -Parent ([string]$disk.volumeRoot))) {
        Throw-DysonQualificationV2Error -Code $code
    }
    foreach ($root in $protected) {
        if ((Test-DysonQualificationV2PathWithin -Candidate ([string]$disk.directoryPath) -Parent $root) -or
            (Test-DysonQualificationV2PathWithin -Candidate $root -Parent ([string]$disk.directoryPath))) {
            Throw-DysonQualificationV2Error -Code 'DYSON_QUALIFICATION_V2_DISK_TARGET_PROTECTED'
        }
    }
    if ((Test-DysonQualificationV2PathWithin -Candidate ([string]$Profile.stateRoot) -Parent ([string]$disk.directoryPath)) -or
        (Test-DysonQualificationV2PathWithin -Candidate ([string]$disk.directoryPath) -Parent ([string]$Profile.stateRoot))) {
        Throw-DysonQualificationV2Error -Code 'DYSON_QUALIFICATION_V2_DISK_TARGET_PROTECTED'
    }
    $targetIds = @($control.targetId,$dsp.targetId,$storage.targetId,$disk.targetId)
    if (@($targetIds | Sort-Object -Unique).Count -ne $targetIds.Count) {
        Throw-DysonQualificationV2Error -Code 'DYSON_QUALIFICATION_V2_TARGET_ID_DUPLICATE'
    }
    return $true
}

function Get-DysonQualificationV2ActionConfiguration {
    param([Parameter(Mandatory)]$Profile, [Parameter(Mandatory)][string]$Action)
    switch ($Action) {
        'control-plane-restart' { return $Profile.actions.controlPlaneRestart }
        'dsp-crash-recovery' { return $Profile.actions.dspCrashRecovery }
        'storage-interruption' { return $Profile.actions.storageInterruption }
        'disk-pressure' { return $Profile.actions.diskPressure }
        default { Throw-DysonQualificationV2Error -Code 'DYSON_QUALIFICATION_V2_ACTION_NOT_ALLOWLISTED' }
    }
}

function Get-DysonQualificationV2ConfirmationPhrase {
    param(
        [Parameter(Mandatory)][ValidateSet('production','fake')][string]$ExecutionScope,
        [Parameter(Mandatory)][string]$Action,
        [Parameter(Mandatory)][string]$ProfileId,
        [Parameter(Mandatory)][string]$RequestId,
        [Parameter(Mandatory)][string]$PreviewSha256
    )
    if (-not (Test-DysonQualificationV2Digest -Value $PreviewSha256)) {
        Throw-DysonQualificationV2Error -Code 'DYSON_QUALIFICATION_V2_PREVIEW_BINDING_INVALID'
    }
    $scopeWord = if ($ExecutionScope -ceq 'production') { 'PRODUCTION' } else { 'FAKE' }
    return 'EXECUTE DYSON QUALIFICATION ' + $scopeWord + ' V2 ' +
        $Action.ToUpperInvariant() + ' ' + $ProfileId + ' ' + $RequestId + ' ' + $PreviewSha256
}

function Assert-DysonQualificationV2ProtectionPoint {
    param(
        [Parameter(Mandatory)]$ProtectionPoint,
        [Parameter(Mandatory)][string]$ExpectedTargetIdentity,
        [Parameter(Mandatory)][datetimeoffset]$NowUtc,
        [switch]$AllowExpired
    )
    $code = 'DYSON_QUALIFICATION_V2_PROTECTION_POINT_INVALID'
    Assert-DysonQualificationV2ExactProperties -Value $ProtectionPoint -Names @(
        'protocol','schemaVersion','protectionPointId','targetIdentity','createdAtUtc',
        'expiresAtUtc','savePairSha256','evidenceSha256'
    ) -Code $code
    if ([string]$ProtectionPoint.protocol -cne $script:DysonQualificationV2ProtectionProtocol -or
        -not (Test-DysonQualificationV2Integer -Value $ProtectionPoint.schemaVersion) -or
        [int]$ProtectionPoint.schemaVersion -ne 2 -or
        -not (Test-DysonQualificationV2Uuid -Value ([string]$ProtectionPoint.protectionPointId)) -or
        [string]$ProtectionPoint.targetIdentity -cne $ExpectedTargetIdentity -or
        -not (Test-DysonQualificationV2Digest -Value ([string]$ProtectionPoint.savePairSha256)) -or
        -not (Test-DysonQualificationV2Digest -Value ([string]$ProtectionPoint.evidenceSha256))) {
        Throw-DysonQualificationV2Error -Code $code
    }
    $created = ConvertFrom-DysonQualificationV2Utc -Value ([string]$ProtectionPoint.createdAtUtc) -Code $code
    $expires = ConvertFrom-DysonQualificationV2Utc -Value ([string]$ProtectionPoint.expiresAtUtc) -Code $code
    if ($expires -le $created -or $expires -gt $created.AddHours(2) -or
        (-not $AllowExpired -and ($created -gt $NowUtc.AddMinutes(1) -or
            $created -lt $NowUtc.AddMinutes(-30) -or $expires -le $NowUtc)) -or
        ($AllowExpired -and ($created -gt $NowUtc.AddMinutes(1) -or $created -lt $NowUtc.AddDays(-31)))) {
        Throw-DysonQualificationV2Error -Code 'DYSON_QUALIFICATION_V2_PROTECTION_POINT_STALE'
    }
    return $true
}

function Assert-DysonQualificationV2ActionParameters {
    param([Parameter(Mandatory)]$Request, [Parameter(Mandatory)]$ActionConfiguration)
    $code = 'DYSON_QUALIFICATION_V2_ACTION_BOUNDS_INVALID'
    switch ([string]$Request.action) {
        'control-plane-restart' {
            Assert-DysonQualificationV2ExactProperties -Value $Request.parameters -Names @('expectedPid') -Code $code
            if (-not (Test-DysonQualificationV2Integer -Value $Request.parameters.expectedPid) -or
                [int64]$Request.parameters.expectedPid -lt 4 -or
                [int64]$Request.parameters.expectedPid -gt [int]::MaxValue) { Throw-DysonQualificationV2Error -Code $code }
        }
        'dsp-crash-recovery' {
            Assert-DysonQualificationV2ExactProperties -Value $Request.parameters -Names @('expectedPid') -Code $code
            if (-not (Test-DysonQualificationV2Integer -Value $Request.parameters.expectedPid) -or
                [int64]$Request.parameters.expectedPid -lt 4 -or
                [int64]$Request.parameters.expectedPid -gt [int]::MaxValue) { Throw-DysonQualificationV2Error -Code $code }
        }
        'storage-interruption' {
            Assert-DysonQualificationV2ExactProperties -Value $Request.parameters -Names @('durationSeconds') -Code $code
            if (-not (Test-DysonQualificationV2Integer -Value $Request.parameters.durationSeconds) -or
                [int]$Request.parameters.durationSeconds -lt 1 -or
                [int]$Request.parameters.durationSeconds -gt ([int]$ActionConfiguration.maximumInterruptionSeconds - 5)) {
                Throw-DysonQualificationV2Error -Code $code
            }
        }
        'disk-pressure' {
            Assert-DysonQualificationV2ExactProperties -Value $Request.parameters -Names @('allocationBytes','holdSeconds') -Code $code
            if (-not (Test-DysonQualificationV2Integer -Value $Request.parameters.allocationBytes) -or
                -not (Test-DysonQualificationV2Integer -Value $Request.parameters.holdSeconds) -or
                [int64]$Request.parameters.allocationBytes -lt 1048576 -or
                [int64]$Request.parameters.allocationBytes -gt [int64]$ActionConfiguration.maximumAllocationBytes -or
                [int]$Request.parameters.holdSeconds -lt 0 -or
                [int]$Request.parameters.holdSeconds -gt [int]$ActionConfiguration.maximumHoldSeconds) {
                Throw-DysonQualificationV2Error -Code $code
            }
        }
        default { Throw-DysonQualificationV2Error -Code 'DYSON_QUALIFICATION_V2_ACTION_NOT_ALLOWLISTED' }
    }
}

function Get-DysonQualificationV2PreviewDigest {
    param([Parameter(Mandatory)]$Request)
    return Get-DysonQualificationV2ObjectDigest -Value ([pscustomobject][ordered]@{
        protocol = 'DYSON_QUALIFICATION_PREVIEW_BINDING_V2'
        requestId = [string]$Request.requestId
        approvalId = [string]$Request.approvalId
        profileId = [string]$Request.profileId
        profileSha256 = [string]$Request.profileSha256
        action = [string]$Request.action
        actionTargetId = [string]$Request.actionTargetId
        executionScope = [string]$Request.executionScope
        targetIdentity = [string]$Request.targetIdentity
        maintenanceWindow = $Request.maintenanceWindow
        protectionPoint = $Request.protectionPoint
        parameters = $Request.parameters
        predecessorReceiptSha256 = [string]$Request.predecessorReceiptSha256
    })
}

function Assert-DysonQualificationV2Request {
    param(
        [Parameter(Mandatory)]$Request,
        [Parameter(Mandatory)]$Profile,
        [Parameter(Mandatory)][datetimeoffset]$NowUtc,
        [switch]$Resume
    )
    $code = 'DYSON_QUALIFICATION_V2_REQUEST_INVALID'
    Assert-DysonQualificationV2ExactProperties -Value $Request -Names @(
        'protocol','schemaVersion','requestId','approvalId','profileId','profileSha256','action',
        'actionTargetId','mode','executionScope','targetIdentity','issuedAtUtc','maintenanceWindow',
        'protectionPoint','confirmationPhrase','parameters','predecessorReceiptSha256','previewSha256'
    ) -Code $code
    if ([string]$Request.protocol -cne $script:DysonQualificationV2RequestProtocol -or
        -not (Test-DysonQualificationV2Integer -Value $Request.schemaVersion) -or
        [int]$Request.schemaVersion -ne 2 -or
        -not (Test-DysonQualificationV2Uuid -Value ([string]$Request.requestId)) -or
        -not (Test-DysonQualificationV2Uuid -Value ([string]$Request.approvalId)) -or
        [string]$Request.profileId -cne [string]$Profile.profileId -or
        [string]$Request.profileSha256 -cne (Get-DysonQualificationV2ProfileDigest -Profile $Profile) -or
        $script:DysonQualificationV2Actions -cnotcontains [string]$Request.action -or
        @('preview','execute') -cnotcontains [string]$Request.mode -or
        @('production','fake') -cnotcontains [string]$Request.executionScope -or
        [string]$Request.targetIdentity -cne [string]$Profile.targetIdentity -or
        -not (Test-DysonQualificationV2Digest -Value ([string]$Request.predecessorReceiptSha256)) -or
        -not (Test-DysonQualificationV2Digest -Value ([string]$Request.previewSha256))) {
        Throw-DysonQualificationV2Error -Code $code
    }
    $configuration = Get-DysonQualificationV2ActionConfiguration -Profile $Profile -Action ([string]$Request.action)
    if ([string]$Request.actionTargetId -cne [string]$configuration.targetId) {
        Throw-DysonQualificationV2Error -Code 'DYSON_QUALIFICATION_V2_TARGET_MISMATCH'
    }
    if ([string]$Request.mode -ceq 'execute' -and -not [bool]$configuration.enabled) {
        Throw-DysonQualificationV2Error -Code 'DYSON_QUALIFICATION_V2_ACTION_DISABLED'
    }
    Assert-DysonQualificationV2ActionParameters -Request $Request -ActionConfiguration $configuration
    if ([string]$Request.previewSha256 -cne (Get-DysonQualificationV2PreviewDigest -Request $Request)) {
        Throw-DysonQualificationV2Error -Code 'DYSON_QUALIFICATION_V2_PREVIEW_BINDING_INVALID'
    }
    $issued = ConvertFrom-DysonQualificationV2Utc -Value ([string]$Request.issuedAtUtc) -Code $code
    if ((-not $Resume -and ($issued -lt $NowUtc.AddMinutes(-15) -or $issued -gt $NowUtc.AddMinutes(1))) -or
        ($Resume -and ($issued -lt $NowUtc.AddDays(-31) -or $issued -gt $NowUtc.AddMinutes(1)))) {
        Throw-DysonQualificationV2Error -Code 'DYSON_QUALIFICATION_V2_REQUEST_STALE'
    }
    Assert-DysonQualificationV2ExactProperties -Value $Request.maintenanceWindow -Names @('startAtUtc','endAtUtc') -Code $code
    $start = ConvertFrom-DysonQualificationV2Utc -Value ([string]$Request.maintenanceWindow.startAtUtc) -Code $code
    $end = ConvertFrom-DysonQualificationV2Utc -Value ([string]$Request.maintenanceWindow.endAtUtc) -Code $code
    if ($end -le $start -or $end -gt $start.AddHours(4) -or $issued -lt $start -or $issued -gt $end -or
        (-not $Resume -and ($NowUtc -lt $start -or $NowUtc -gt $end))) {
        Throw-DysonQualificationV2Error -Code 'DYSON_QUALIFICATION_V2_MAINTENANCE_WINDOW_INVALID'
    }
    [void](Assert-DysonQualificationV2ProtectionPoint -ProtectionPoint $Request.protectionPoint `
        -ExpectedTargetIdentity ([string]$Profile.targetIdentity) -NowUtc $NowUtc -AllowExpired:$Resume)
    if ([string]$Request.mode -ceq 'execute') {
        $expected = Get-DysonQualificationV2ConfirmationPhrase -ExecutionScope ([string]$Request.executionScope) `
            -Action ([string]$Request.action) -ProfileId ([string]$Profile.profileId) `
            -RequestId ([string]$Request.requestId) -PreviewSha256 ([string]$Request.previewSha256)
        if ([string]$Request.confirmationPhrase -cne $expected) {
            Throw-DysonQualificationV2Error -Code 'DYSON_QUALIFICATION_V2_CONFIRMATION_INVALID'
        }
    }
    elseif (-not [string]::IsNullOrEmpty([string]$Request.confirmationPhrase)) {
        Throw-DysonQualificationV2Error -Code $code
    }
    return $configuration
}

function Get-DysonQualificationV2RequestDigest {
    param([Parameter(Mandatory)]$Request)
    return Get-DysonQualificationV2ObjectDigest -Value $Request
}

function Get-DysonQualificationV2UnsignedValue {
    param([Parameter(Mandatory)]$Value, [Parameter(Mandatory)][string]$DigestProperty)
    $unsigned = [ordered]@{}
    foreach ($property in @($Value.PSObject.Properties | Where-Object { $_.Name -cne $DigestProperty } |
        Sort-Object -Property Name -CaseSensitive)) {
        $unsigned[$property.Name] = $property.Value
    }
    return [pscustomobject]$unsigned
}

function Assert-DysonQualificationV2Intent {
    param([Parameter(Mandatory)]$Intent)
    $code = 'DYSON_QUALIFICATION_V2_INTENT_INVALID'
    Assert-DysonQualificationV2ExactProperties -Value $Intent -Names @(
        'protocol','schemaVersion','requestId','requestDigest','profileId','profileSha256','action',
        'actionTargetId','sequence','predecessorReceiptSha256','state','createdAtUtc','deadlineAtUtc','intentSha256'
    ) -Code $code
    if ([string]$Intent.protocol -cne $script:DysonQualificationV2IntentProtocol -or
        -not (Test-DysonQualificationV2Integer -Value $Intent.schemaVersion) -or
        [int]$Intent.schemaVersion -ne 2 -or
        -not (Test-DysonQualificationV2Uuid -Value ([string]$Intent.requestId)) -or
        -not (Test-DysonQualificationV2Digest -Value ([string]$Intent.requestDigest)) -or
        -not (Test-DysonQualificationV2Uuid -Value ([string]$Intent.profileId)) -or
        -not (Test-DysonQualificationV2Digest -Value ([string]$Intent.profileSha256)) -or
        $script:DysonQualificationV2Actions -cnotcontains [string]$Intent.action -or
        [string]$Intent.actionTargetId -cnotmatch '^[a-z0-9][a-z0-9-]{2,63}$' -or
        -not (Test-DysonQualificationV2Integer -Value $Intent.sequence) -or
        [int64]$Intent.sequence -lt 1 -or
        -not (Test-DysonQualificationV2Digest -Value ([string]$Intent.predecessorReceiptSha256)) -or
        [string]$Intent.state -cne 'prepared' -or
        -not (Test-DysonQualificationV2Digest -Value ([string]$Intent.intentSha256))) {
        Throw-DysonQualificationV2Error -Code $code
    }
    $created = ConvertFrom-DysonQualificationV2Utc -Value ([string]$Intent.createdAtUtc) -Code $code
    $deadline = ConvertFrom-DysonQualificationV2Utc -Value ([string]$Intent.deadlineAtUtc) -Code $code
    if ($deadline -le $created -or $deadline -gt $created.AddMinutes(15)) {
        Throw-DysonQualificationV2Error -Code $code
    }
    $expected = Get-DysonQualificationV2ObjectDigest -Value (Get-DysonQualificationV2UnsignedValue -Value $Intent -DigestProperty 'intentSha256')
    if ([string]$Intent.intentSha256 -cne $expected) { Throw-DysonQualificationV2Error -Code $code }
    return $true
}

function Assert-DysonQualificationV2Receipt {
    param([Parameter(Mandatory)]$Receipt)
    $code = 'DYSON_QUALIFICATION_V2_RECEIPT_INVALID'
    Assert-DysonQualificationV2ExactProperties -Value $Receipt -Names @(
        'protocol','schemaVersion','requestId','requestDigest','profileId','profileSha256','action',
        'actionTargetId','sequence','predecessorReceiptSha256','intentSha256','status','startedAtUtc',
        'completedAtUtc','outcomeCode','compensation','executionScope','productionChanged','receiptSha256'
    ) -Code $code
    if ([string]$Receipt.protocol -cne $script:DysonQualificationV2ReceiptProtocol -or
        -not (Test-DysonQualificationV2Integer -Value $Receipt.schemaVersion) -or
        [int]$Receipt.schemaVersion -ne 2 -or
        -not (Test-DysonQualificationV2Uuid -Value ([string]$Receipt.requestId)) -or
        -not (Test-DysonQualificationV2Digest -Value ([string]$Receipt.requestDigest)) -or
        -not (Test-DysonQualificationV2Uuid -Value ([string]$Receipt.profileId)) -or
        -not (Test-DysonQualificationV2Digest -Value ([string]$Receipt.profileSha256)) -or
        $script:DysonQualificationV2Actions -cnotcontains [string]$Receipt.action -or
        [string]$Receipt.actionTargetId -cnotmatch '^[a-z0-9][a-z0-9-]{2,63}$' -or
        -not (Test-DysonQualificationV2Integer -Value $Receipt.sequence) -or
        [int64]$Receipt.sequence -lt 1 -or
        -not (Test-DysonQualificationV2Digest -Value ([string]$Receipt.predecessorReceiptSha256)) -or
        -not (Test-DysonQualificationV2Digest -Value ([string]$Receipt.intentSha256)) -or
        @('passed','compensated','recovery-required') -cnotcontains [string]$Receipt.status -or
        [string]$Receipt.outcomeCode -cnotmatch '^[A-Z0-9_]{3,96}$' -or
        @('production','fake') -cnotcontains [string]$Receipt.executionScope -or
        -not (Test-DysonQualificationV2Digest -Value ([string]$Receipt.receiptSha256))) {
        Throw-DysonQualificationV2Error -Code $code
    }
    Assert-DysonQualificationV2ExactProperties -Value $Receipt.compensation -Names @('attempted','status') -Code $code
    if ($Receipt.compensation.attempted -isnot [bool] -or
        $Receipt.productionChanged -isnot [bool] -or
        @('not-required','passed','failed') -cnotcontains [string]$Receipt.compensation.status -or
        ([bool]$Receipt.compensation.attempted -ne ([string]$Receipt.compensation.status -cne 'not-required')) -or
        ([string]$Receipt.executionScope -ceq 'production' -and -not [bool]$Receipt.productionChanged) -or
        ([string]$Receipt.executionScope -ceq 'fake' -and [bool]$Receipt.productionChanged)) {
        Throw-DysonQualificationV2Error -Code $code
    }
    $started = ConvertFrom-DysonQualificationV2Utc -Value ([string]$Receipt.startedAtUtc) -Code $code
    $completed = ConvertFrom-DysonQualificationV2Utc -Value ([string]$Receipt.completedAtUtc) -Code $code
    if ($completed -lt $started -or $completed -gt $started.AddDays(32)) {
        Throw-DysonQualificationV2Error -Code $code
    }
    $expected = Get-DysonQualificationV2ObjectDigest -Value (Get-DysonQualificationV2UnsignedValue -Value $Receipt -DigestProperty 'receiptSha256')
    if ([string]$Receipt.receiptSha256 -cne $expected) { Throw-DysonQualificationV2Error -Code $code }
    return $true
}
