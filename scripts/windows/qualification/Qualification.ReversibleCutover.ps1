Set-StrictMode -Version 2.0

$script:ReversibleCutoverProtocol = 'DYSON_REVERSIBLE_CUTOVER_OBSERVATION_V2'
$script:ReversibleCutoverSchemaVersion = 2
$script:ReversibleCutoverMaximumJsonBytes = 1048576

function Throw-ReversibleCutoverError {
    param([Parameter(Mandatory)][string]$Code)
    $exception = [InvalidOperationException]::new($Code)
    $exception.Data['Code'] = $Code
    throw $exception
}

function Get-ReversibleCutoverErrorCode {
    param([Parameter(Mandatory)][Exception]$Exception)
    if ($Exception.Data.Contains('Code')) { return [string]$Exception.Data['Code'] }
    return 'DYSON_REVERSIBLE_CUTOVER_OBSERVATION_INVALID'
}

function Assert-ReversibleCutoverExactProperties {
    param([Parameter(Mandatory)]$Value, [Parameter(Mandatory)][string[]]$Names)
    if ($null -eq $Value -or $Value -isnot [psobject]) {
        Throw-ReversibleCutoverError 'DYSON_REVERSIBLE_CUTOVER_OBSERVATION_INVALID'
    }
    $actual = @($Value.PSObject.Properties.Name)
    if ($actual.Count -ne $Names.Count) {
        Throw-ReversibleCutoverError 'DYSON_REVERSIBLE_CUTOVER_OBSERVATION_INVALID'
    }
    foreach ($name in $Names) {
        if ($actual -cnotcontains $name) {
            Throw-ReversibleCutoverError 'DYSON_REVERSIBLE_CUTOVER_OBSERVATION_INVALID'
        }
    }
}

function Assert-ReversibleCutoverString {
    param([AllowNull()]$Value, [Parameter(Mandatory)][string]$Pattern)
    if ($Value -isnot [string] -or [string]$Value -cnotmatch $Pattern) {
        Throw-ReversibleCutoverError 'DYSON_REVERSIBLE_CUTOVER_OBSERVATION_INVALID'
    }
    return [string]$Value
}

function Assert-ReversibleCutoverGuid {
    param([AllowNull()]$Value)
    $text = Assert-ReversibleCutoverString $Value '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    $parsed = [guid]::Empty
    if (-not [guid]::TryParseExact($text, 'D', [ref]$parsed)) {
        Throw-ReversibleCutoverError 'DYSON_REVERSIBLE_CUTOVER_OBSERVATION_INVALID'
    }
    return $parsed.ToString('D').ToLowerInvariant()
}

function Assert-ReversibleCutoverSha256 {
    param([AllowNull()]$Value)
    return Assert-ReversibleCutoverString $Value '^[0-9a-f]{64}$'
}

function Assert-ReversibleCutoverPathIdentity {
    param([AllowNull()]$Value)
    return Assert-ReversibleCutoverString $Value '^sha256:[0-9a-f]{64}$'
}

function Assert-ReversibleCutoverCommit {
    param([AllowNull()]$Value)
    return Assert-ReversibleCutoverString $Value '^[0-9a-f]{40}$'
}

function Test-ReversibleCutoverInteger {
    param([AllowNull()]$Value)
    return $Value -is [int] -or $Value -is [long]
}

function Assert-ReversibleCutoverTimestamp {
    param([AllowNull()]$Value)
    $text = Assert-ReversibleCutoverString $Value '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,7})?Z$'
    $parsed = [DateTimeOffset]::MinValue
    if (-not [DateTimeOffset]::TryParse($text, [Globalization.CultureInfo]::InvariantCulture,
            [Globalization.DateTimeStyles]::AssumeUniversal, [ref]$parsed)) {
        Throw-ReversibleCutoverError 'DYSON_REVERSIBLE_CUTOVER_OBSERVATION_INVALID'
    }
    return $parsed.ToUniversalTime()
}

function Get-ReversibleCutoverSha256Bytes {
    param([Parameter(Mandatory)][byte[]]$Bytes)
    $hash = [Security.Cryptography.SHA256]::Create()
    try { return ([BitConverter]::ToString($hash.ComputeHash($Bytes))).Replace('-', '').ToLowerInvariant() }
    finally { $hash.Dispose() }
}

function Get-ReversibleCutoverSha256Text {
    param([Parameter(Mandatory)][string]$Text)
    return Get-ReversibleCutoverSha256Bytes ([Text.Encoding]::UTF8.GetBytes($Text))
}

function Get-ReversibleCutoverSha256File {
    param([Parameter(Mandatory)][string]$Path)
    try {
        $item = Get-Item -LiteralPath $Path -Force -ErrorAction Stop
        if (-not $item.PSIsContainer -and -not ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
            $stream = [IO.File]::Open($item.FullName, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
            try {
                $hash = [Security.Cryptography.SHA256]::Create()
                try { return ([BitConverter]::ToString($hash.ComputeHash($stream))).Replace('-', '').ToLowerInvariant() }
                finally { $hash.Dispose() }
            }
            finally { $stream.Dispose() }
        }
    }
    catch { }
    Throw-ReversibleCutoverError 'DYSON_REVERSIBLE_CUTOVER_SOURCE_INVALID'
}

function Read-ReversibleCutoverJson {
    param([Parameter(Mandatory)][string]$Path)
    try {
        $item = Get-Item -LiteralPath $Path -Force -ErrorAction Stop
        if ($item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -or
            $item.Length -lt 2 -or $item.Length -gt $script:ReversibleCutoverMaximumJsonBytes) { throw 'file' }
        $text = [IO.File]::ReadAllText($item.FullName, [Text.UTF8Encoding]::new($false, $true))
        $convert = Get-Command ConvertFrom-Json -ErrorAction Stop
        if ($convert.Parameters.ContainsKey('DateKind')) {
            return $text | ConvertFrom-Json -DateKind String -ErrorAction Stop
        }
        return $text | ConvertFrom-Json -ErrorAction Stop
    }
    catch { Throw-ReversibleCutoverError 'DYSON_REVERSIBLE_CUTOVER_SOURCE_INVALID' }
}

function Get-ReversibleCutoverPairSnapshot {
    param([Parameter(Mandatory)][string]$DsvPath, [Parameter(Mandatory)][string]$ServerPath)
    try {
        $dsv = Get-Item -LiteralPath $DsvPath -Force -ErrorAction Stop
        $server = Get-Item -LiteralPath $ServerPath -Force -ErrorAction Stop
        if ($dsv.PSIsContainer -or $server.PSIsContainer -or
            ($dsv.Attributes -band [IO.FileAttributes]::ReparsePoint) -or
            ($server.Attributes -band [IO.FileAttributes]::ReparsePoint) -or
            $dsv.Length -le 0 -or $server.Length -le 0 -or
            [IO.Path]::GetExtension($dsv.Name) -cne '.dsv' -or
            [IO.Path]::GetExtension($server.Name) -cne '.server' -or
            [IO.Path]::GetFileNameWithoutExtension($dsv.Name) -cne [IO.Path]::GetFileNameWithoutExtension($server.Name)) {
            throw 'pair'
        }
        $dsvHash = Get-ReversibleCutoverSha256File $dsv.FullName
        $serverHash = Get-ReversibleCutoverSha256File $server.FullName
        $pairHash = Get-ReversibleCutoverSha256Text ('DYSON_PAIRED_SAVE_V2|' + $dsv.Length + '|' + $dsvHash + '|' + $server.Length + '|' + $serverHash)
        return [pscustomobject][ordered]@{
            dsvLength = [int64]$dsv.Length
            dsvSha256 = $dsvHash
            serverLength = [int64]$server.Length
            serverSha256 = $serverHash
            pairSha256 = $pairHash
        }
    }
    catch {
        if ($_.Exception.Data.Contains('Code')) { throw $_.Exception }
        Throw-ReversibleCutoverError 'DYSON_REVERSIBLE_CUTOVER_SAVE_PAIR_INVALID'
    }
}

function ConvertTo-ReversibleCutoverMaintenanceWindow {
    param([Parameter(Mandatory)]$Raw)
    Assert-ReversibleCutoverExactProperties $Raw @(
        'protocol','schemaVersion','approvalId','windowId','qualificationRunId','targetIdentity',
        'controlRelease','subjectCommit','runtimePayloadSha256','releaseManifestSha256',
        'startsAtUtc','endsAtUtc','approvedAtUtc','state'
    )
    if ([string]$Raw.protocol -cne 'DYSON_APPROVED_MAINTENANCE_WINDOW_V2' -or [int64]$Raw.schemaVersion -ne 2 -or
        [string]$Raw.state -cne 'approved') { Throw-ReversibleCutoverError 'DYSON_REVERSIBLE_CUTOVER_WINDOW_INVALID' }
    $approved = Assert-ReversibleCutoverTimestamp $Raw.approvedAtUtc
    $starts = Assert-ReversibleCutoverTimestamp $Raw.startsAtUtc
    $ends = Assert-ReversibleCutoverTimestamp $Raw.endsAtUtc
    if ($approved -gt $starts -or $starts -ge $ends -or ($ends - $starts).TotalHours -gt 8) {
        Throw-ReversibleCutoverError 'DYSON_REVERSIBLE_CUTOVER_WINDOW_INVALID'
    }
    return [pscustomobject][ordered]@{
        protocol = 'DYSON_APPROVED_MAINTENANCE_WINDOW_V2'; schemaVersion = 2
        approvalId = Assert-ReversibleCutoverGuid $Raw.approvalId
        windowId = Assert-ReversibleCutoverGuid $Raw.windowId
        qualificationRunId = Assert-ReversibleCutoverGuid $Raw.qualificationRunId
        targetIdentity = Assert-ReversibleCutoverPathIdentity $Raw.targetIdentity
        controlRelease = Assert-ReversibleCutoverString $Raw.controlRelease '^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9a-z.-]+)?$'
        subjectCommit = Assert-ReversibleCutoverCommit $Raw.subjectCommit
        runtimePayloadSha256 = Assert-ReversibleCutoverSha256 $Raw.runtimePayloadSha256
        releaseManifestSha256 = Assert-ReversibleCutoverSha256 $Raw.releaseManifestSha256
        startsAtUtc = [string]$Raw.startsAtUtc; endsAtUtc = [string]$Raw.endsAtUtc
        approvedAtUtc = [string]$Raw.approvedAtUtc; state = 'approved'
    }
}

function ConvertTo-ReversibleCutoverReleaseManifest {
    param([Parameter(Mandatory)]$Raw)
    Assert-ReversibleCutoverExactProperties $Raw @('protocol','schemaVersion','qualificationRunId','targetIdentity','controlRelease','subjectCommit','runtimePayloadSha256','createdAtUtc')
    if ([string]$Raw.protocol -cne 'DYSON_CONTROL_RUNTIME_RELEASE_MANIFEST_V2' -or [int64]$Raw.schemaVersion -ne 2) {
        Throw-ReversibleCutoverError 'DYSON_REVERSIBLE_CUTOVER_RELEASE_INVALID'
    }
    [void](Assert-ReversibleCutoverTimestamp $Raw.createdAtUtc)
    return [pscustomobject][ordered]@{
        protocol='DYSON_CONTROL_RUNTIME_RELEASE_MANIFEST_V2'; schemaVersion=2
        qualificationRunId=Assert-ReversibleCutoverGuid $Raw.qualificationRunId
        targetIdentity=Assert-ReversibleCutoverPathIdentity $Raw.targetIdentity
        controlRelease=Assert-ReversibleCutoverString $Raw.controlRelease '^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9a-z.-]+)?$'
        subjectCommit=Assert-ReversibleCutoverCommit $Raw.subjectCommit
        runtimePayloadSha256=Assert-ReversibleCutoverSha256 $Raw.runtimePayloadSha256
        createdAtUtc=[string]$Raw.createdAtUtc
    }
}

function ConvertTo-ReversibleCutoverProtectionPoint {
    param([Parameter(Mandatory)]$Raw)
    Assert-ReversibleCutoverExactProperties $Raw @(
        'protocol','schemaVersion','protectionPointId','qualificationRunId','targetIdentity','dataRootIdentity',
        'saveGenerationId','dsvLength','dsvSha256','serverLength','serverSha256','pairSha256','createdAtUtc','expiresAtUtc'
    )
    if ([string]$Raw.protocol -cne 'DYSON_CONTROL_PAIRED_SAVE_PROTECTION_POINT_V2' -or [int64]$Raw.schemaVersion -ne 2 -or
        $Raw.dsvLength -isnot [long] -and $Raw.dsvLength -isnot [int] -or
        $Raw.serverLength -isnot [long] -and $Raw.serverLength -isnot [int] -or
        [int64]$Raw.dsvLength -le 0 -or [int64]$Raw.serverLength -le 0) {
        Throw-ReversibleCutoverError 'DYSON_REVERSIBLE_CUTOVER_PROTECTION_INVALID'
    }
    $created = Assert-ReversibleCutoverTimestamp $Raw.createdAtUtc
    $expires = Assert-ReversibleCutoverTimestamp $Raw.expiresAtUtc
    if ($created -ge $expires) { Throw-ReversibleCutoverError 'DYSON_REVERSIBLE_CUTOVER_PROTECTION_INVALID' }
    $dsvSha = Assert-ReversibleCutoverSha256 $Raw.dsvSha256
    $serverSha = Assert-ReversibleCutoverSha256 $Raw.serverSha256
    $pairSha = Assert-ReversibleCutoverSha256 $Raw.pairSha256
    $expectedPair = Get-ReversibleCutoverSha256Text ('DYSON_PAIRED_SAVE_V2|' + [int64]$Raw.dsvLength + '|' + $dsvSha + '|' + [int64]$Raw.serverLength + '|' + $serverSha)
    if ($pairSha -cne $expectedPair) { Throw-ReversibleCutoverError 'DYSON_REVERSIBLE_CUTOVER_PROTECTION_INVALID' }
    return [pscustomobject][ordered]@{
        protocol='DYSON_CONTROL_PAIRED_SAVE_PROTECTION_POINT_V2'; schemaVersion=2
        protectionPointId=Assert-ReversibleCutoverGuid $Raw.protectionPointId
        qualificationRunId=Assert-ReversibleCutoverGuid $Raw.qualificationRunId
        targetIdentity=Assert-ReversibleCutoverPathIdentity $Raw.targetIdentity
        dataRootIdentity=Assert-ReversibleCutoverPathIdentity $Raw.dataRootIdentity
        saveGenerationId=Assert-ReversibleCutoverGuid $Raw.saveGenerationId
        dsvLength=[int64]$Raw.dsvLength; dsvSha256=$dsvSha
        serverLength=[int64]$Raw.serverLength; serverSha256=$serverSha; pairSha256=$pairSha
        createdAtUtc=[string]$Raw.createdAtUtc; expiresAtUtc=[string]$Raw.expiresAtUtc
    }
}

function ConvertTo-ReversibleCutoverAuthoritySnapshot {
    param([Parameter(Mandatory)]$Raw)
    Assert-ReversibleCutoverExactProperties $Raw @(
        'protocol','schemaVersion','snapshotId','qualificationRunId','targetIdentity','dataRootIdentity',
        'saveGenerationId','authorityProfileProtocol','authorityInventoryRevision','runtimeOwner','capturedAtUtc'
    )
    if ([string]$Raw.protocol -cne 'DYSON_REVERSIBLE_CUTOVER_GSMANAGER_AUTHORITY_SNAPSHOT_V2' -or
        [int64]$Raw.schemaVersion -ne 2 -or
        [string]$Raw.authorityProfileProtocol -cne 'DYSON_GSMANAGER_AUTHORITY_PROFILE_V1' -or
        [string]$Raw.runtimeOwner -cne 'gsmanager') {
        Throw-ReversibleCutoverError 'DYSON_REVERSIBLE_CUTOVER_AUTHORITY_INVALID'
    }
    [void](Assert-ReversibleCutoverTimestamp $Raw.capturedAtUtc)
    return [pscustomobject][ordered]@{
        protocol='DYSON_REVERSIBLE_CUTOVER_GSMANAGER_AUTHORITY_SNAPSHOT_V2'; schemaVersion=2
        snapshotId=Assert-ReversibleCutoverGuid $Raw.snapshotId
        qualificationRunId=Assert-ReversibleCutoverGuid $Raw.qualificationRunId
        targetIdentity=Assert-ReversibleCutoverPathIdentity $Raw.targetIdentity
        dataRootIdentity=Assert-ReversibleCutoverPathIdentity $Raw.dataRootIdentity
        saveGenerationId=Assert-ReversibleCutoverGuid $Raw.saveGenerationId
        authorityProfileProtocol='DYSON_GSMANAGER_AUTHORITY_PROFILE_V1'
        authorityInventoryRevision=Assert-ReversibleCutoverSha256 $Raw.authorityInventoryRevision
        runtimeOwner='gsmanager'; capturedAtUtc=[string]$Raw.capturedAtUtc
    }
}

function ConvertTo-ReversibleCutoverSwitchReceipt {
    param([Parameter(Mandatory)]$Raw, [Parameter(Mandatory)][ValidateSet('to-dyson-control','back-to-gsmanager')][string]$ExpectedPhase)
    Assert-ReversibleCutoverExactProperties $Raw @(
        'protocol','schemaVersion','receiptId','qualificationRunId','targetIdentity','controlRelease','subjectCommit',
        'runtimePayloadSha256','releaseManifestSha256','dataRootIdentity','saveGenerationId','authorityInventoryRevision',
        'phase','fromAuthority','toAuthority','state','persisted','actions','startedAtUtc','completedAtUtc'
    )
    if ([string]$Raw.protocol -cne 'DYSON_REVERSIBLE_CUTOVER_SWITCH_RECEIPT_V2' -or [int64]$Raw.schemaVersion -ne 2 -or
        [string]$Raw.phase -cne $ExpectedPhase -or [string]$Raw.state -cne 'succeeded' -or $Raw.persisted -isnot [bool] -or -not [bool]$Raw.persisted) {
        Throw-ReversibleCutoverError 'DYSON_REVERSIBLE_CUTOVER_RECEIPT_INVALID'
    }
    $from = if ($ExpectedPhase -ceq 'to-dyson-control') { 'gsmanager' } else { 'dyson-control' }
    $to = if ($ExpectedPhase -ceq 'to-dyson-control') { 'dyson-control' } else { 'gsmanager' }
    if ([string]$Raw.fromAuthority -cne $from -or [string]$Raw.toAuthority -cne $to) {
        Throw-ReversibleCutoverError 'DYSON_REVERSIBLE_CUTOVER_RECEIPT_INVALID'
    }
    $started = Assert-ReversibleCutoverTimestamp $Raw.startedAtUtc
    $completed = Assert-ReversibleCutoverTimestamp $Raw.completedAtUtc
    if ($started -ge $completed) { Throw-ReversibleCutoverError 'DYSON_REVERSIBLE_CUTOVER_RECEIPT_INVALID' }
    $expectedCapabilities = if ($ExpectedPhase -ceq 'to-dyson-control') {
        @('DisablePreviousAuthority','StopPreviousRuntime','StartCandidateRuntime')
    } else { @('StopCandidateRuntime','EnablePreviousAuthority','StartPreviousRuntime') }
    $actions = @($Raw.actions)
    if ($actions.Count -ne 3) { Throw-ReversibleCutoverError 'DYSON_REVERSIBLE_CUTOVER_RECEIPT_INVALID' }
    $normalized = [Collections.Generic.List[object]]::new()
    for ($i = 0; $i -lt 3; $i++) {
        $action = $actions[$i]
        Assert-ReversibleCutoverExactProperties $action @('sequence','capability','brokerReceiptProtocol','brokerReceiptSha256','hostReceiptProtocol','requestId','requestFingerprint','status')
        if (($action.sequence -isnot [int] -and $action.sequence -isnot [long]) -or [int64]$action.sequence -ne ($i + 1) -or
            [string]$action.capability -cne $expectedCapabilities[$i] -or
            [string]$action.brokerReceiptProtocol -cne 'DYSON_CONTROL_CUTOVER_BROKER_RECEIPT_V1' -or
            [string]$action.hostReceiptProtocol -cne 'DYSON_CONTROL_CUTOVER_ACTION_RECEIPT_V1' -or
            [string]$action.status -cne 'succeeded') {
            Throw-ReversibleCutoverError 'DYSON_REVERSIBLE_CUTOVER_RECEIPT_INVALID'
        }
        $normalized.Add([pscustomobject][ordered]@{
            sequence=[int]$action.sequence; capability=[string]$action.capability
            brokerReceiptProtocol='DYSON_CONTROL_CUTOVER_BROKER_RECEIPT_V1'
            brokerReceiptSha256=Assert-ReversibleCutoverSha256 $action.brokerReceiptSha256
            hostReceiptProtocol='DYSON_CONTROL_CUTOVER_ACTION_RECEIPT_V1'
            requestId=Assert-ReversibleCutoverGuid $action.requestId
            requestFingerprint=Assert-ReversibleCutoverSha256 $action.requestFingerprint
            status='succeeded'
        })
    }
    return [pscustomobject][ordered]@{
        protocol='DYSON_REVERSIBLE_CUTOVER_SWITCH_RECEIPT_V2'; schemaVersion=2
        receiptId=Assert-ReversibleCutoverGuid $Raw.receiptId
        qualificationRunId=Assert-ReversibleCutoverGuid $Raw.qualificationRunId
        targetIdentity=Assert-ReversibleCutoverPathIdentity $Raw.targetIdentity
        controlRelease=Assert-ReversibleCutoverString $Raw.controlRelease '^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9a-z.-]+)?$'
        subjectCommit=Assert-ReversibleCutoverCommit $Raw.subjectCommit
        runtimePayloadSha256=Assert-ReversibleCutoverSha256 $Raw.runtimePayloadSha256
        releaseManifestSha256=Assert-ReversibleCutoverSha256 $Raw.releaseManifestSha256
        dataRootIdentity=Assert-ReversibleCutoverPathIdentity $Raw.dataRootIdentity
        saveGenerationId=Assert-ReversibleCutoverGuid $Raw.saveGenerationId
        authorityInventoryRevision=Assert-ReversibleCutoverSha256 $Raw.authorityInventoryRevision
        phase=$ExpectedPhase; fromAuthority=$from; toAuthority=$to; state='succeeded'; persisted=$true
        actions=@($normalized); startedAtUtc=[string]$Raw.startedAtUtc; completedAtUtc=[string]$Raw.completedAtUtc
    }
}

function ConvertTo-ReversibleCutoverHealth {
    param([Parameter(Mandatory)]$Raw, [Parameter(Mandatory)][ValidateSet('dyson-control','gsmanager')][string]$ExpectedAuthority)
    Assert-ReversibleCutoverExactProperties $Raw @(
        'protocol','schemaVersion','healthId','qualificationRunId','targetIdentity','controlRelease','subjectCommit',
        'runtimePayloadSha256','releaseManifestSha256','dataRootIdentity','saveGenerationId','authorityInventoryRevision',
        'authority','management','game','observedAtUtc'
    )
    Assert-ReversibleCutoverExactProperties $Raw.management @('probeProtocol','authenticated','authorityExclusive','controlPlaneState')
    Assert-ReversibleCutoverExactProperties $Raw.game @('probeProtocol','authenticatedHandshake','sessionEstablished','loadedSaveGenerationId','simulationProgressObserved')
    if ([string]$Raw.protocol -cne 'DYSON_REVERSIBLE_CUTOVER_HEALTH_OBSERVATION_V2' -or [int64]$Raw.schemaVersion -ne 2 -or
        [string]$Raw.authority -cne $ExpectedAuthority -or
        [string]$Raw.management.probeProtocol -cne 'DYSON_AUTHENTICATED_MANAGEMENT_PROBE_V2' -or
        $Raw.management.authenticated -isnot [bool] -or -not [bool]$Raw.management.authenticated -or
        $Raw.management.authorityExclusive -isnot [bool] -or -not [bool]$Raw.management.authorityExclusive -or
        [string]$Raw.management.controlPlaneState -cne 'healthy' -or
        [string]$Raw.game.probeProtocol -cne 'DYSON_NEBULA_GAME_PROTOCOL_HANDSHAKE_V2' -or
        $Raw.game.authenticatedHandshake -isnot [bool] -or -not [bool]$Raw.game.authenticatedHandshake -or
        $Raw.game.sessionEstablished -isnot [bool] -or -not [bool]$Raw.game.sessionEstablished -or
        $Raw.game.simulationProgressObserved -isnot [bool] -or -not [bool]$Raw.game.simulationProgressObserved) {
        Throw-ReversibleCutoverError 'DYSON_REVERSIBLE_CUTOVER_HEALTH_INVALID'
    }
    [void](Assert-ReversibleCutoverTimestamp $Raw.observedAtUtc)
    return [pscustomobject][ordered]@{
        protocol='DYSON_REVERSIBLE_CUTOVER_HEALTH_OBSERVATION_V2'; schemaVersion=2
        healthId=Assert-ReversibleCutoverGuid $Raw.healthId
        qualificationRunId=Assert-ReversibleCutoverGuid $Raw.qualificationRunId
        targetIdentity=Assert-ReversibleCutoverPathIdentity $Raw.targetIdentity
        controlRelease=Assert-ReversibleCutoverString $Raw.controlRelease '^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9a-z.-]+)?$'
        subjectCommit=Assert-ReversibleCutoverCommit $Raw.subjectCommit
        runtimePayloadSha256=Assert-ReversibleCutoverSha256 $Raw.runtimePayloadSha256
        releaseManifestSha256=Assert-ReversibleCutoverSha256 $Raw.releaseManifestSha256
        dataRootIdentity=Assert-ReversibleCutoverPathIdentity $Raw.dataRootIdentity
        saveGenerationId=Assert-ReversibleCutoverGuid $Raw.saveGenerationId
        authorityInventoryRevision=Assert-ReversibleCutoverSha256 $Raw.authorityInventoryRevision
        authority=$ExpectedAuthority
        management=[pscustomobject][ordered]@{ probeProtocol='DYSON_AUTHENTICATED_MANAGEMENT_PROBE_V2'; authenticated=$true; authorityExclusive=$true; controlPlaneState='healthy' }
        game=[pscustomobject][ordered]@{
            probeProtocol='DYSON_NEBULA_GAME_PROTOCOL_HANDSHAKE_V2'; authenticatedHandshake=$true; sessionEstablished=$true
            loadedSaveGenerationId=Assert-ReversibleCutoverGuid $Raw.game.loadedSaveGenerationId; simulationProgressObserved=$true
        }
        observedAtUtc=[string]$Raw.observedAtUtc
    }
}

function ConvertTo-ReversibleCutoverAudit {
    param([Parameter(Mandatory)]$Raw)
    Assert-ReversibleCutoverExactProperties $Raw @('protocol','schemaVersion','qualificationRunId','targetIdentity','dataRootIdentity','saveGenerationId','entries')
    if ([string]$Raw.protocol -cne 'DYSON_REVERSIBLE_CUTOVER_AUDIT_V2' -or [int64]$Raw.schemaVersion -ne 2) {
        Throw-ReversibleCutoverError 'DYSON_REVERSIBLE_CUTOVER_AUDIT_INVALID'
    }
    $expectedEvents = @('protection-point-verified','gsmanager-authority-captured','switched-to-dyson-control','dyson-control-health-verified','switched-back-to-gsmanager','gsmanager-health-verified','paired-save-integrity-verified')
    $entries = @($Raw.entries)
    if ($entries.Count -ne 7) { Throw-ReversibleCutoverError 'DYSON_REVERSIBLE_CUTOVER_AUDIT_INVALID' }
    $normalized = [Collections.Generic.List[object]]::new()
    $previousTime = [DateTimeOffset]::MinValue
    for ($i=0; $i -lt 7; $i++) {
        $entry = $entries[$i]
        Assert-ReversibleCutoverExactProperties $entry @('sequence','event','authority','evidenceSha256','observedAtUtc')
        $authority = if ($i -in @(0,1,5,6)) { 'gsmanager' } elseif ($i -in @(2,3)) { 'dyson-control' } else { 'transition' }
        $time = Assert-ReversibleCutoverTimestamp $entry.observedAtUtc
        if (($entry.sequence -isnot [int] -and $entry.sequence -isnot [long]) -or [int64]$entry.sequence -ne ($i+1) -or
            [string]$entry.event -cne $expectedEvents[$i] -or [string]$entry.authority -cne $authority -or $time -le $previousTime) {
            Throw-ReversibleCutoverError 'DYSON_REVERSIBLE_CUTOVER_AUDIT_INVALID'
        }
        $previousTime = $time
        $normalized.Add([pscustomobject][ordered]@{
            sequence=[int]$entry.sequence; event=[string]$entry.event; authority=$authority
            evidenceSha256=Assert-ReversibleCutoverSha256 $entry.evidenceSha256; observedAtUtc=[string]$entry.observedAtUtc
        })
    }
    return [pscustomobject][ordered]@{
        protocol='DYSON_REVERSIBLE_CUTOVER_AUDIT_V2'; schemaVersion=2
        qualificationRunId=Assert-ReversibleCutoverGuid $Raw.qualificationRunId
        targetIdentity=Assert-ReversibleCutoverPathIdentity $Raw.targetIdentity
        dataRootIdentity=Assert-ReversibleCutoverPathIdentity $Raw.dataRootIdentity
        saveGenerationId=Assert-ReversibleCutoverGuid $Raw.saveGenerationId
        entries=@($normalized)
    }
}

function ConvertTo-ReversibleCutoverExpectedRawSha256 {
    param([Parameter(Mandatory)][string]$Value)
    if ($Value -cmatch '^sha256:([0-9a-f]{64})$') { return [string]$Matches[1] }
    return Assert-ReversibleCutoverSha256 $Value
}

function ConvertTo-ReversibleCutoverExpectedTimestamp {
    param([Parameter(Mandatory)]$Value)
    if ($Value -is [datetimeoffset]) { return ([datetimeoffset]$Value).ToUniversalTime() }
    if ($Value -is [datetime]) { return ([datetimeoffset]([datetime]$Value)).ToUniversalTime() }
    return Assert-ReversibleCutoverTimestamp $Value
}

function ConvertTo-ReversibleCutoverCanonicalValue {
    param([AllowNull()]$Value)
    if ($null -eq $Value) { return $null }
    if ($Value -is [string] -or $Value -is [bool] -or
        $Value -is [byte] -or $Value -is [sbyte] -or $Value -is [int16] -or
        $Value -is [uint16] -or $Value -is [int32] -or $Value -is [uint32] -or
        $Value -is [int64] -or $Value -is [uint64] -or $Value -is [decimal] -or $Value -is [double]) {
        return $Value
    }
    if ($Value -is [Collections.IDictionary]) {
        $map = [ordered]@{}
        foreach ($key in @($Value.Keys | ForEach-Object { [string]$_ } | Sort-Object -CaseSensitive)) {
            $map[$key] = ConvertTo-ReversibleCutoverCanonicalValue $Value[$key]
        }
        return [pscustomobject]$map
    }
    if ($Value -is [Collections.IEnumerable]) {
        return @($Value | ForEach-Object { ConvertTo-ReversibleCutoverCanonicalValue $_ })
    }
    $object = [ordered]@{}
    foreach ($property in @($Value.PSObject.Properties | Sort-Object -Property Name -CaseSensitive)) {
        $object[[string]$property.Name] = ConvertTo-ReversibleCutoverCanonicalValue $property.Value
    }
    return [pscustomobject]$object
}

function ConvertTo-ReversibleCutoverCanonicalJson {
    param([Parameter(Mandatory)]$Value)
    return (ConvertTo-ReversibleCutoverCanonicalValue $Value) | ConvertTo-Json -Depth 16 -Compress
}

function Get-ReversibleCutoverObservationBody {
    param([Parameter(Mandatory)]$Observation)
    return [pscustomobject][ordered]@{
        protocol = $Observation.protocol
        schemaVersion = $Observation.schemaVersion
        qualificationRunId = $Observation.qualificationRunId
        targetIdentity = $Observation.targetIdentity
        maintenanceWindow = $Observation.maintenanceWindow
        release = $Observation.release
        dataRootIdentity = $Observation.dataRootIdentity
        saveGenerationId = $Observation.saveGenerationId
        protectionPoint = $Observation.protectionPoint
        gsManagerAuthority = $Observation.gsManagerAuthority
        switchToDysonControl = $Observation.switchToDysonControl
        dysonControlHealth = $Observation.dysonControlHealth
        switchBackToGsManager = $Observation.switchBackToGsManager
        restoredGsManagerHealth = $Observation.restoredGsManagerHealth
        restoredSavePair = $Observation.restoredSavePair
        bidirectionalNoLoss = $Observation.bidirectionalNoLoss
        audit = $Observation.audit
        collectorEffects = $Observation.collectorEffects
        observedAtUtc = $Observation.observedAtUtc
        expiresAtUtc = $Observation.expiresAtUtc
    }
}

function Get-ReversibleCutoverObservationDigest {
    param([Parameter(Mandatory)]$Observation)
    return Get-ReversibleCutoverSha256Text (ConvertTo-ReversibleCutoverCanonicalJson `
        (Get-ReversibleCutoverObservationBody $Observation))
}

function Assert-ReversibleCutoverObservationRecordV2 {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]$Observation,
        [Parameter(Mandatory)][string]$ExpectedWindowId,
        [Parameter(Mandatory)][string]$ExpectedApprovalId,
        [Parameter(Mandatory)][string]$ExpectedQualificationRunId,
        [Parameter(Mandatory)][string]$ExpectedTargetIdentity,
        [Parameter(Mandatory)][string]$ExpectedControlRelease,
        [Parameter(Mandatory)][string]$ExpectedSubjectCommit,
        [Parameter(Mandatory)][string]$ExpectedRuntimePayloadSha256,
        [Parameter(Mandatory)][string]$ExpectedReleaseManifestSha256,
        [Parameter(Mandatory)][string]$ExpectedDataRootIdentity,
        [Parameter(Mandatory)][string]$ExpectedSaveGenerationId,
        [Parameter(Mandatory)][string]$ExpectedAuthorityInventoryRevision,
        [Parameter(Mandatory)][string]$ExpectedSwitchToReceiptId,
        [Parameter(Mandatory)][string]$ExpectedSwitchToSourceSha256,
        [Parameter(Mandatory)][string]$ExpectedSwitchBackReceiptId,
        [Parameter(Mandatory)][string]$ExpectedSwitchBackSourceSha256,
        [Parameter(Mandatory)][string]$ExpectedProtectionSourceSha256,
        [Parameter(Mandatory)][string]$ExpectedObservationSha256,
        [Parameter(Mandatory)]$ExpectedObservedAtUtc,
        [Parameter(Mandatory)]$ExpectedExpiresAtUtc,
        [datetimeoffset]$NowUtc = [datetimeoffset]::UtcNow
    )
    $code = 'DYSON_REVERSIBLE_CUTOVER_RECORD_INVALID'
    try {
        Assert-ReversibleCutoverExactProperties $Observation @(
            'protocol','schemaVersion','qualificationRunId','targetIdentity','maintenanceWindow','release',
            'dataRootIdentity','saveGenerationId','protectionPoint','gsManagerAuthority','switchToDysonControl',
            'dysonControlHealth','switchBackToGsManager','restoredGsManagerHealth','restoredSavePair',
            'bidirectionalNoLoss','audit','collectorEffects','observedAtUtc','expiresAtUtc','observationSha256'
        )
        Assert-ReversibleCutoverExactProperties $Observation.maintenanceWindow @(
            'protocol','approvalId','windowId','startsAtUtc','endsAtUtc','sourceSha256'
        )
        Assert-ReversibleCutoverExactProperties $Observation.release @(
            'controlRelease','subjectCommit','runtimePayloadSha256','releaseManifestSha256'
        )
        Assert-ReversibleCutoverExactProperties $Observation.protectionPoint @(
            'protocol','protectionPointId','pairSha256','createdAtUtc','expiresAtUtc','sourceSha256'
        )
        Assert-ReversibleCutoverExactProperties $Observation.gsManagerAuthority @(
            'protocol','snapshotId','inventoryRevision','runtimeOwner','capturedAtUtc','sourceSha256'
        )
        foreach ($switch in @($Observation.switchToDysonControl,$Observation.switchBackToGsManager)) {
            Assert-ReversibleCutoverExactProperties $switch @(
                'protocol','receiptId','state','persisted','actionCount','completedAtUtc','sourceSha256'
            )
        }
        foreach ($health in @($Observation.dysonControlHealth,$Observation.restoredGsManagerHealth)) {
            Assert-ReversibleCutoverExactProperties $health @(
                'protocol','healthId','authority','authenticatedManagement','gameProtocolHandshake',
                'simulationProgressObserved','observedAtUtc','sourceSha256'
            )
        }
        Assert-ReversibleCutoverExactProperties $Observation.restoredSavePair @(
            'dsvLength','dsvSha256','serverLength','serverSha256','pairSha256'
        )
        Assert-ReversibleCutoverExactProperties $Observation.bidirectionalNoLoss @(
            'protocol','forwardSwitchProved','reverseSwitchProved','generationPreserved','pairPreserved',
            'beforePairSha256','afterPairSha256'
        )
        Assert-ReversibleCutoverExactProperties $Observation.audit @(
            'protocol','firstSequence','lastSequence','entryCount','sourceSha256','terminalEvidenceSha256'
        )
        Assert-ReversibleCutoverExactProperties $Observation.collectorEffects @('networkTouched','productionChanged')

        $expectedRuntime = ConvertTo-ReversibleCutoverExpectedRawSha256 $ExpectedRuntimePayloadSha256
        $expectedManifest = ConvertTo-ReversibleCutoverExpectedRawSha256 $ExpectedReleaseManifestSha256
        $expectedInventory = ConvertTo-ReversibleCutoverExpectedRawSha256 $ExpectedAuthorityInventoryRevision
        $expectedToSource = ConvertTo-ReversibleCutoverExpectedRawSha256 $ExpectedSwitchToSourceSha256
        $expectedBackSource = ConvertTo-ReversibleCutoverExpectedRawSha256 $ExpectedSwitchBackSourceSha256
        $expectedProtectionSource = ConvertTo-ReversibleCutoverExpectedRawSha256 $ExpectedProtectionSourceSha256
        $expectedObservation = ConvertTo-ReversibleCutoverExpectedRawSha256 $ExpectedObservationSha256
        $observed = Assert-ReversibleCutoverTimestamp $Observation.observedAtUtc
        $expires = Assert-ReversibleCutoverTimestamp $Observation.expiresAtUtc
        $expectedObserved = ConvertTo-ReversibleCutoverExpectedTimestamp $ExpectedObservedAtUtc
        $expectedExpires = ConvertTo-ReversibleCutoverExpectedTimestamp $ExpectedExpiresAtUtc
        $windowStart = Assert-ReversibleCutoverTimestamp $Observation.maintenanceWindow.startsAtUtc
        $windowEnd = Assert-ReversibleCutoverTimestamp $Observation.maintenanceWindow.endsAtUtc
        $protectionCreated = Assert-ReversibleCutoverTimestamp $Observation.protectionPoint.createdAtUtc
        $protectionExpires = Assert-ReversibleCutoverTimestamp $Observation.protectionPoint.expiresAtUtc
        $authorityCaptured = Assert-ReversibleCutoverTimestamp $Observation.gsManagerAuthority.capturedAtUtc
        $toCompleted = Assert-ReversibleCutoverTimestamp $Observation.switchToDysonControl.completedAtUtc
        $dysonObserved = Assert-ReversibleCutoverTimestamp $Observation.dysonControlHealth.observedAtUtc
        $backCompleted = Assert-ReversibleCutoverTimestamp $Observation.switchBackToGsManager.completedAtUtc
        $restoredObserved = Assert-ReversibleCutoverTimestamp $Observation.restoredGsManagerHealth.observedAtUtc

        if ([string]$Observation.protocol -cne $script:ReversibleCutoverProtocol -or
            -not (Test-ReversibleCutoverInteger $Observation.schemaVersion) -or
            [int64]$Observation.schemaVersion -ne 2 -or
            (Assert-ReversibleCutoverGuid ([string]$Observation.qualificationRunId)) -cne
                (Assert-ReversibleCutoverGuid $ExpectedQualificationRunId) -or
            (Assert-ReversibleCutoverPathIdentity ([string]$Observation.targetIdentity)) -cne
                (Assert-ReversibleCutoverPathIdentity $ExpectedTargetIdentity) -or
            [string]$Observation.maintenanceWindow.protocol -cne 'DYSON_APPROVED_MAINTENANCE_WINDOW_V2' -or
            (Assert-ReversibleCutoverGuid ([string]$Observation.maintenanceWindow.approvalId)) -cne
                (Assert-ReversibleCutoverGuid $ExpectedApprovalId) -or
            (Assert-ReversibleCutoverGuid ([string]$Observation.maintenanceWindow.windowId)) -cne
                (Assert-ReversibleCutoverGuid $ExpectedWindowId) -or
            -not (Assert-ReversibleCutoverSha256 ([string]$Observation.maintenanceWindow.sourceSha256)) -or
            [string]$Observation.release.controlRelease -cne
                (Assert-ReversibleCutoverString $ExpectedControlRelease '^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9a-z.-]+)?$') -or
            (Assert-ReversibleCutoverCommit ([string]$Observation.release.subjectCommit)) -cne
                (Assert-ReversibleCutoverCommit $ExpectedSubjectCommit) -or
            (Assert-ReversibleCutoverSha256 ([string]$Observation.release.runtimePayloadSha256)) -cne $expectedRuntime -or
            (Assert-ReversibleCutoverSha256 ([string]$Observation.release.releaseManifestSha256)) -cne $expectedManifest -or
            (Assert-ReversibleCutoverPathIdentity ([string]$Observation.dataRootIdentity)) -cne
                (Assert-ReversibleCutoverPathIdentity $ExpectedDataRootIdentity) -or
            (Assert-ReversibleCutoverGuid ([string]$Observation.saveGenerationId)) -cne
                (Assert-ReversibleCutoverGuid $ExpectedSaveGenerationId)) {
            Throw-ReversibleCutoverError $code
        }

        if ([string]$Observation.protectionPoint.protocol -cne 'DYSON_CONTROL_PAIRED_SAVE_PROTECTION_POINT_V2' -or
            -not (Assert-ReversibleCutoverGuid ([string]$Observation.protectionPoint.protectionPointId)) -or
            (Assert-ReversibleCutoverSha256 ([string]$Observation.protectionPoint.sourceSha256)) -cne $expectedProtectionSource -or
            [string]$Observation.gsManagerAuthority.protocol -cne 'DYSON_GSMANAGER_AUTHORITY_PROFILE_V1' -or
            [string]$Observation.gsManagerAuthority.runtimeOwner -cne 'gsmanager' -or
            -not (Assert-ReversibleCutoverGuid ([string]$Observation.gsManagerAuthority.snapshotId)) -or
            (Assert-ReversibleCutoverSha256 ([string]$Observation.gsManagerAuthority.inventoryRevision)) -cne $expectedInventory -or
            -not (Assert-ReversibleCutoverSha256 ([string]$Observation.gsManagerAuthority.sourceSha256)) -or
            [string]$Observation.switchToDysonControl.protocol -cne 'DYSON_REVERSIBLE_CUTOVER_SWITCH_RECEIPT_V2' -or
            (Assert-ReversibleCutoverGuid ([string]$Observation.switchToDysonControl.receiptId)) -cne
                (Assert-ReversibleCutoverGuid $ExpectedSwitchToReceiptId) -or
            [string]$Observation.switchToDysonControl.state -cne 'succeeded' -or
            $Observation.switchToDysonControl.persisted -isnot [bool] -or -not [bool]$Observation.switchToDysonControl.persisted -or
            -not (Test-ReversibleCutoverInteger $Observation.switchToDysonControl.actionCount) -or
            [int64]$Observation.switchToDysonControl.actionCount -ne 3 -or
            (Assert-ReversibleCutoverSha256 ([string]$Observation.switchToDysonControl.sourceSha256)) -cne $expectedToSource -or
            [string]$Observation.switchBackToGsManager.protocol -cne 'DYSON_REVERSIBLE_CUTOVER_SWITCH_RECEIPT_V2' -or
            (Assert-ReversibleCutoverGuid ([string]$Observation.switchBackToGsManager.receiptId)) -cne
                (Assert-ReversibleCutoverGuid $ExpectedSwitchBackReceiptId) -or
            [string]$Observation.switchBackToGsManager.state -cne 'succeeded' -or
            $Observation.switchBackToGsManager.persisted -isnot [bool] -or -not [bool]$Observation.switchBackToGsManager.persisted -or
            -not (Test-ReversibleCutoverInteger $Observation.switchBackToGsManager.actionCount) -or
            [int64]$Observation.switchBackToGsManager.actionCount -ne 3 -or
            (Assert-ReversibleCutoverSha256 ([string]$Observation.switchBackToGsManager.sourceSha256)) -cne $expectedBackSource) {
            Throw-ReversibleCutoverError $code
        }

        foreach ($healthBinding in @(
                [pscustomobject]@{ value=$Observation.dysonControlHealth; authority='dyson-control' },
                [pscustomobject]@{ value=$Observation.restoredGsManagerHealth; authority='gsmanager' })) {
            $health = $healthBinding.value
            if ([string]$health.protocol -cne 'DYSON_REVERSIBLE_CUTOVER_HEALTH_OBSERVATION_V2' -or
                -not (Assert-ReversibleCutoverGuid ([string]$health.healthId)) -or
                [string]$health.authority -cne [string]$healthBinding.authority -or
                $health.authenticatedManagement -isnot [bool] -or -not [bool]$health.authenticatedManagement -or
                $health.gameProtocolHandshake -isnot [bool] -or -not [bool]$health.gameProtocolHandshake -or
                $health.simulationProgressObserved -isnot [bool] -or -not [bool]$health.simulationProgressObserved -or
                -not (Assert-ReversibleCutoverSha256 ([string]$health.sourceSha256))) {
                Throw-ReversibleCutoverError $code
            }
        }

        if (-not (Test-ReversibleCutoverInteger $Observation.restoredSavePair.dsvLength) -or
            -not (Test-ReversibleCutoverInteger $Observation.restoredSavePair.serverLength) -or
            [int64]$Observation.restoredSavePair.dsvLength -le 0 -or [int64]$Observation.restoredSavePair.serverLength -le 0) {
            Throw-ReversibleCutoverError $code
        }
        $dsvSha = Assert-ReversibleCutoverSha256 ([string]$Observation.restoredSavePair.dsvSha256)
        $serverSha = Assert-ReversibleCutoverSha256 ([string]$Observation.restoredSavePair.serverSha256)
        $pairSha = Assert-ReversibleCutoverSha256 ([string]$Observation.restoredSavePair.pairSha256)
        $calculatedPair = Get-ReversibleCutoverSha256Text ('DYSON_PAIRED_SAVE_V2|' +
            [int64]$Observation.restoredSavePair.dsvLength + '|' + $dsvSha + '|' +
            [int64]$Observation.restoredSavePair.serverLength + '|' + $serverSha)
        if ($pairSha -cne $calculatedPair -or
            (Assert-ReversibleCutoverSha256 ([string]$Observation.protectionPoint.pairSha256)) -cne $pairSha -or
            [string]$Observation.bidirectionalNoLoss.protocol -cne 'DYSON_REVERSIBLE_CUTOVER_NO_LOSS_PROOF_V2' -or
            $Observation.bidirectionalNoLoss.forwardSwitchProved -isnot [bool] -or -not [bool]$Observation.bidirectionalNoLoss.forwardSwitchProved -or
            $Observation.bidirectionalNoLoss.reverseSwitchProved -isnot [bool] -or -not [bool]$Observation.bidirectionalNoLoss.reverseSwitchProved -or
            $Observation.bidirectionalNoLoss.generationPreserved -isnot [bool] -or -not [bool]$Observation.bidirectionalNoLoss.generationPreserved -or
            $Observation.bidirectionalNoLoss.pairPreserved -isnot [bool] -or -not [bool]$Observation.bidirectionalNoLoss.pairPreserved -or
            (Assert-ReversibleCutoverSha256 ([string]$Observation.bidirectionalNoLoss.beforePairSha256)) -cne $pairSha -or
            (Assert-ReversibleCutoverSha256 ([string]$Observation.bidirectionalNoLoss.afterPairSha256)) -cne $pairSha) {
            Throw-ReversibleCutoverError $code
        }

        if ([string]$Observation.audit.protocol -cne 'DYSON_REVERSIBLE_CUTOVER_AUDIT_V2' -or
            -not (Test-ReversibleCutoverInteger $Observation.audit.firstSequence) -or
            -not (Test-ReversibleCutoverInteger $Observation.audit.lastSequence) -or
            -not (Test-ReversibleCutoverInteger $Observation.audit.entryCount) -or
            [int64]$Observation.audit.firstSequence -ne 1 -or [int64]$Observation.audit.lastSequence -ne 7 -or
            [int64]$Observation.audit.entryCount -ne 7 -or
            -not (Assert-ReversibleCutoverSha256 ([string]$Observation.audit.sourceSha256)) -or
            (Assert-ReversibleCutoverSha256 ([string]$Observation.audit.terminalEvidenceSha256)) -cne $pairSha -or
            $Observation.collectorEffects.networkTouched -isnot [bool] -or [bool]$Observation.collectorEffects.networkTouched -or
            $Observation.collectorEffects.productionChanged -isnot [bool] -or [bool]$Observation.collectorEffects.productionChanged) {
            Throw-ReversibleCutoverError $code
        }

        if ($windowStart -ge $windowEnd -or ($windowEnd - $windowStart).TotalHours -gt 8 -or
            $protectionCreated -lt $windowStart -or $protectionCreated -gt $authorityCaptured -or
            $authorityCaptured -gt $toCompleted -or $toCompleted -gt $dysonObserved -or
            $dysonObserved -gt $backCompleted -or $backCompleted -gt $restoredObserved -or
            $restoredObserved -gt $observed -or $observed -gt $windowEnd -or
            $protectionExpires -lt $observed -or $expires -le $observed -or $expires -gt $windowEnd -or
            ($expires - $observed).TotalHours -gt 4 -or $expires -le $NowUtc -or $protectionExpires -le $NowUtc -or
            $observed -ne $expectedObserved -or $expires -ne $expectedExpires) {
            Throw-ReversibleCutoverError $code
        }
        $actualDigest = Get-ReversibleCutoverObservationDigest $Observation
        if ((Assert-ReversibleCutoverSha256 ([string]$Observation.observationSha256)) -cne $actualDigest -or
            $actualDigest -cne $expectedObservation) {
            Throw-ReversibleCutoverError $code
        }
        return [pscustomobject][ordered]@{
            valid = $true
            observationSha256 = $actualDigest
            protectionPointSha256 = [string]$Observation.protectionPoint.sourceSha256
            switchBackReceiptSha256 = [string]$Observation.switchBackToGsManager.sourceSha256
            auditSampleCount = 7
            auditMaximumGapSeconds = [int64]([Math]::Ceiling([Math]::Max(
                ($authorityCaptured - $protectionCreated).TotalSeconds,
                [Math]::Max(($toCompleted - $authorityCaptured).TotalSeconds,
                [Math]::Max(($dysonObserved - $toCompleted).TotalSeconds,
                [Math]::Max(($backCompleted - $dysonObserved).TotalSeconds,
                [Math]::Max(($restoredObserved - $backCompleted).TotalSeconds,
                    ($observed - $restoredObserved).TotalSeconds)))))))
            startedAtUtc = $protectionCreated
            completedAtUtc = $observed
        }
    }
    catch {
        if ($_.Exception.Data.Contains('Code') -and [string]$_.Exception.Data['Code'] -ceq $code) { throw }
        Throw-ReversibleCutoverError $code
    }
}

function New-ReversibleCutoverObservation {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][string]$MaintenanceWindowFile,
        [Parameter(Mandatory)][string]$ReleaseManifestFile,
        [Parameter(Mandatory)][string]$ProtectionPointFile,
        [Parameter(Mandatory)][string]$AuthoritySnapshotFile,
        [Parameter(Mandatory)][string]$SwitchToDysonReceiptFile,
        [Parameter(Mandatory)][string]$DysonHealthFile,
        [Parameter(Mandatory)][string]$SwitchBackReceiptFile,
        [Parameter(Mandatory)][string]$RestoredHealthFile,
        [Parameter(Mandatory)][string]$AuditFile,
        [Parameter(Mandatory)][string]$DsvPath,
        [Parameter(Mandatory)][string]$ServerPath,
        [Parameter(Mandatory)][string]$ExpectedApprovalId,
        [Parameter(Mandatory)][string]$ExpectedWindowId,
        [Parameter(Mandatory)][string]$ExpectedQualificationRunId,
        [Parameter(Mandatory)][string]$ExpectedTargetIdentity,
        [Parameter(Mandatory)][string]$ExpectedControlRelease,
        [Parameter(Mandatory)][string]$ExpectedSubjectCommit,
        [Parameter(Mandatory)][string]$ExpectedRuntimePayloadSha256,
        [Parameter(Mandatory)][string]$ExpectedReleaseManifestSha256,
        [Parameter(Mandatory)][string]$ObservedAtUtc,
        [Parameter(Mandatory)][string]$ExpiresAtUtc
    )
    $window = ConvertTo-ReversibleCutoverMaintenanceWindow (Read-ReversibleCutoverJson $MaintenanceWindowFile)
    $release = ConvertTo-ReversibleCutoverReleaseManifest (Read-ReversibleCutoverJson $ReleaseManifestFile)
    $protection = ConvertTo-ReversibleCutoverProtectionPoint (Read-ReversibleCutoverJson $ProtectionPointFile)
    $authority = ConvertTo-ReversibleCutoverAuthoritySnapshot (Read-ReversibleCutoverJson $AuthoritySnapshotFile)
    $toDyson = ConvertTo-ReversibleCutoverSwitchReceipt (Read-ReversibleCutoverJson $SwitchToDysonReceiptFile) 'to-dyson-control'
    $dysonHealth = ConvertTo-ReversibleCutoverHealth (Read-ReversibleCutoverJson $DysonHealthFile) 'dyson-control'
    $switchBack = ConvertTo-ReversibleCutoverSwitchReceipt (Read-ReversibleCutoverJson $SwitchBackReceiptFile) 'back-to-gsmanager'
    $restoredHealth = ConvertTo-ReversibleCutoverHealth (Read-ReversibleCutoverJson $RestoredHealthFile) 'gsmanager'
    $audit = ConvertTo-ReversibleCutoverAudit (Read-ReversibleCutoverJson $AuditFile)
    $pair = Get-ReversibleCutoverPairSnapshot -DsvPath $DsvPath -ServerPath $ServerPath

    $expected = [pscustomobject][ordered]@{
        approvalId=Assert-ReversibleCutoverGuid $ExpectedApprovalId
        windowId=Assert-ReversibleCutoverGuid $ExpectedWindowId
        qualificationRunId=Assert-ReversibleCutoverGuid $ExpectedQualificationRunId
        targetIdentity=Assert-ReversibleCutoverPathIdentity $ExpectedTargetIdentity
        controlRelease=Assert-ReversibleCutoverString $ExpectedControlRelease '^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9a-z.-]+)?$'
        subjectCommit=Assert-ReversibleCutoverCommit $ExpectedSubjectCommit
        runtimePayloadSha256=Assert-ReversibleCutoverSha256 $ExpectedRuntimePayloadSha256
        releaseManifestSha256=Assert-ReversibleCutoverSha256 $ExpectedReleaseManifestSha256
    }
    $releaseFileSha = Get-ReversibleCutoverSha256File $ReleaseManifestFile
    if ($window.approvalId -cne $expected.approvalId -or $window.windowId -cne $expected.windowId -or
        $window.qualificationRunId -cne $expected.qualificationRunId -or $window.targetIdentity -cne $expected.targetIdentity -or
        $window.controlRelease -cne $expected.controlRelease -or $window.subjectCommit -cne $expected.subjectCommit -or
        $window.runtimePayloadSha256 -cne $expected.runtimePayloadSha256 -or
        $window.releaseManifestSha256 -cne $expected.releaseManifestSha256 -or
        $releaseFileSha -cne $expected.releaseManifestSha256) {
        Throw-ReversibleCutoverError 'DYSON_REVERSIBLE_CUTOVER_EXTERNAL_BINDING_MISMATCH'
    }
    $bindingObjects = @($release,$protection,$authority,$toDyson,$dysonHealth,$switchBack,$restoredHealth,$audit)
    foreach ($item in $bindingObjects) {
        if ($item.qualificationRunId -cne $expected.qualificationRunId -or $item.targetIdentity -cne $expected.targetIdentity) {
            Throw-ReversibleCutoverError 'DYSON_REVERSIBLE_CUTOVER_BINDING_MISMATCH'
        }
    }
    if ($release.controlRelease -cne $expected.controlRelease -or $release.subjectCommit -cne $expected.subjectCommit -or
        $release.runtimePayloadSha256 -cne $expected.runtimePayloadSha256) {
        Throw-ReversibleCutoverError 'DYSON_REVERSIBLE_CUTOVER_BINDING_MISMATCH'
    }
    foreach ($item in @($toDyson,$dysonHealth,$switchBack,$restoredHealth)) {
        if ($item.controlRelease -cne $expected.controlRelease -or $item.subjectCommit -cne $expected.subjectCommit -or
            $item.runtimePayloadSha256 -cne $expected.runtimePayloadSha256 -or
            $item.releaseManifestSha256 -cne $expected.releaseManifestSha256) {
            Throw-ReversibleCutoverError 'DYSON_REVERSIBLE_CUTOVER_BINDING_MISMATCH'
        }
    }
    $dataRoot = $protection.dataRootIdentity
    $generation = $protection.saveGenerationId
    $inventory = $authority.authorityInventoryRevision
    foreach ($item in @($authority,$toDyson,$dysonHealth,$switchBack,$restoredHealth,$audit)) {
        if ($item.dataRootIdentity -cne $dataRoot -or $item.saveGenerationId -cne $generation) {
            Throw-ReversibleCutoverError 'DYSON_REVERSIBLE_CUTOVER_SAVE_BINDING_MISMATCH'
        }
    }
    foreach ($item in @($toDyson,$dysonHealth,$switchBack,$restoredHealth)) {
        if ($item.authorityInventoryRevision -cne $inventory) {
            Throw-ReversibleCutoverError 'DYSON_REVERSIBLE_CUTOVER_AUTHORITY_INVALID'
        }
    }
    if ($dysonHealth.game.loadedSaveGenerationId -cne $generation -or
        $restoredHealth.game.loadedSaveGenerationId -cne $generation -or
        $pair.dsvLength -ne $protection.dsvLength -or $pair.dsvSha256 -cne $protection.dsvSha256 -or
        $pair.serverLength -ne $protection.serverLength -or $pair.serverSha256 -cne $protection.serverSha256 -or
        $pair.pairSha256 -cne $protection.pairSha256) {
        Throw-ReversibleCutoverError 'DYSON_REVERSIBLE_CUTOVER_NO_LOSS_INVALID'
    }

    $sourceHashes = [ordered]@{
        maintenanceWindow=Get-ReversibleCutoverSha256File $MaintenanceWindowFile
        releaseManifest=$releaseFileSha
        protectionPoint=Get-ReversibleCutoverSha256File $ProtectionPointFile
        authoritySnapshot=Get-ReversibleCutoverSha256File $AuthoritySnapshotFile
        switchToDysonReceipt=Get-ReversibleCutoverSha256File $SwitchToDysonReceiptFile
        dysonHealth=Get-ReversibleCutoverSha256File $DysonHealthFile
        switchBackReceipt=Get-ReversibleCutoverSha256File $SwitchBackReceiptFile
        restoredHealth=Get-ReversibleCutoverSha256File $RestoredHealthFile
        audit=Get-ReversibleCutoverSha256File $AuditFile
    }
    $expectedAuditHashes = @(
        $sourceHashes.protectionPoint,$sourceHashes.authoritySnapshot,$sourceHashes.switchToDysonReceipt,
        $sourceHashes.dysonHealth,$sourceHashes.switchBackReceipt,$sourceHashes.restoredHealth,$pair.pairSha256
    )
    for ($i=0; $i -lt 7; $i++) {
        if ($audit.entries[$i].evidenceSha256 -cne $expectedAuditHashes[$i]) {
            Throw-ReversibleCutoverError 'DYSON_REVERSIBLE_CUTOVER_AUDIT_INVALID'
        }
    }

    $windowStart = Assert-ReversibleCutoverTimestamp $window.startsAtUtc
    $windowEnd = Assert-ReversibleCutoverTimestamp $window.endsAtUtc
    $protectionCreated = Assert-ReversibleCutoverTimestamp $protection.createdAtUtc
    $protectionExpiry = Assert-ReversibleCutoverTimestamp $protection.expiresAtUtc
    $authorityTime = Assert-ReversibleCutoverTimestamp $authority.capturedAtUtc
    $toStart = Assert-ReversibleCutoverTimestamp $toDyson.startedAtUtc
    $toEnd = Assert-ReversibleCutoverTimestamp $toDyson.completedAtUtc
    $dysonTime = Assert-ReversibleCutoverTimestamp $dysonHealth.observedAtUtc
    $backStart = Assert-ReversibleCutoverTimestamp $switchBack.startedAtUtc
    $backEnd = Assert-ReversibleCutoverTimestamp $switchBack.completedAtUtc
    $restoredTime = Assert-ReversibleCutoverTimestamp $restoredHealth.observedAtUtc
    $observed = Assert-ReversibleCutoverTimestamp $ObservedAtUtc
    $expires = Assert-ReversibleCutoverTimestamp $ExpiresAtUtc
    if ($protectionCreated -lt $windowStart -or $authorityTime -lt $windowStart -or $toStart -lt $windowStart -or
        $protectionCreated -gt $authorityTime -or $authorityTime -gt $toStart -or $toEnd -gt $dysonTime -or
        $dysonTime -gt $backStart -or $backEnd -gt $restoredTime -or $restoredTime -gt $observed -or
        $observed -gt $windowEnd -or $protectionExpiry -lt $observed -or $expires -le $observed -or
        $expires -gt $windowEnd -or ($expires - $observed).TotalHours -gt 4 -or
        $expires -le [DateTimeOffset]::UtcNow -or $protectionExpiry -le [DateTimeOffset]::UtcNow) {
        Throw-ReversibleCutoverError 'DYSON_REVERSIBLE_CUTOVER_TIME_ORDER_INVALID'
    }
    $sourceTimes = @($protection.createdAtUtc,$authority.capturedAtUtc,$toDyson.completedAtUtc,$dysonHealth.observedAtUtc,$switchBack.completedAtUtc,$restoredHealth.observedAtUtc,$ObservedAtUtc)
    for ($i=0; $i -lt 7; $i++) {
        if ($audit.entries[$i].observedAtUtc -cne $sourceTimes[$i]) {
            Throw-ReversibleCutoverError 'DYSON_REVERSIBLE_CUTOVER_AUDIT_INVALID'
        }
    }

    $body = [pscustomobject][ordered]@{
        protocol=$script:ReversibleCutoverProtocol; schemaVersion=2
        qualificationRunId=$expected.qualificationRunId; targetIdentity=$expected.targetIdentity
        maintenanceWindow=[pscustomobject][ordered]@{
            protocol=$window.protocol; approvalId=$window.approvalId; windowId=$window.windowId
            startsAtUtc=$window.startsAtUtc; endsAtUtc=$window.endsAtUtc; sourceSha256=$sourceHashes.maintenanceWindow
        }
        release=[pscustomobject][ordered]@{
            controlRelease=$expected.controlRelease; subjectCommit=$expected.subjectCommit
            runtimePayloadSha256=$expected.runtimePayloadSha256; releaseManifestSha256=$expected.releaseManifestSha256
        }
        dataRootIdentity=$dataRoot; saveGenerationId=$generation
        protectionPoint=[pscustomobject][ordered]@{
            protocol=$protection.protocol; protectionPointId=$protection.protectionPointId; pairSha256=$protection.pairSha256
            createdAtUtc=$protection.createdAtUtc; expiresAtUtc=$protection.expiresAtUtc; sourceSha256=$sourceHashes.protectionPoint
        }
        gsManagerAuthority=[pscustomobject][ordered]@{
            protocol=$authority.authorityProfileProtocol; snapshotId=$authority.snapshotId
            inventoryRevision=$inventory; runtimeOwner='gsmanager'; capturedAtUtc=$authority.capturedAtUtc
            sourceSha256=$sourceHashes.authoritySnapshot
        }
        switchToDysonControl=[pscustomobject][ordered]@{
            protocol=$toDyson.protocol; receiptId=$toDyson.receiptId; state='succeeded'; persisted=$true
            actionCount=3; completedAtUtc=$toDyson.completedAtUtc; sourceSha256=$sourceHashes.switchToDysonReceipt
        }
        dysonControlHealth=[pscustomobject][ordered]@{
            protocol=$dysonHealth.protocol; healthId=$dysonHealth.healthId; authority='dyson-control'
            authenticatedManagement=$true; gameProtocolHandshake=$true; simulationProgressObserved=$true
            observedAtUtc=$dysonHealth.observedAtUtc; sourceSha256=$sourceHashes.dysonHealth
        }
        switchBackToGsManager=[pscustomobject][ordered]@{
            protocol=$switchBack.protocol; receiptId=$switchBack.receiptId; state='succeeded'; persisted=$true
            actionCount=3; completedAtUtc=$switchBack.completedAtUtc; sourceSha256=$sourceHashes.switchBackReceipt
        }
        restoredGsManagerHealth=[pscustomobject][ordered]@{
            protocol=$restoredHealth.protocol; healthId=$restoredHealth.healthId; authority='gsmanager'
            authenticatedManagement=$true; gameProtocolHandshake=$true; simulationProgressObserved=$true
            observedAtUtc=$restoredHealth.observedAtUtc; sourceSha256=$sourceHashes.restoredHealth
        }
        restoredSavePair=$pair
        bidirectionalNoLoss=[pscustomobject][ordered]@{
            protocol='DYSON_REVERSIBLE_CUTOVER_NO_LOSS_PROOF_V2'; forwardSwitchProved=$true
            reverseSwitchProved=$true; generationPreserved=$true; pairPreserved=$true
            beforePairSha256=$protection.pairSha256; afterPairSha256=$pair.pairSha256
        }
        audit=[pscustomobject][ordered]@{
            protocol=$audit.protocol; firstSequence=1; lastSequence=7; entryCount=7
            sourceSha256=$sourceHashes.audit; terminalEvidenceSha256=$audit.entries[6].evidenceSha256
        }
        collectorEffects=[pscustomobject][ordered]@{ networkTouched=$false; productionChanged=$false }
        observedAtUtc=[string]$ObservedAtUtc; expiresAtUtc=[string]$ExpiresAtUtc
    }
    $digest = Get-ReversibleCutoverObservationDigest $body
    $result = [ordered]@{}
    foreach ($property in $body.PSObject.Properties) { $result[$property.Name] = $property.Value }
    $result['observationSha256'] = $digest
    return [pscustomobject]$result
}

function Test-ReversibleCutoverObservation {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][string]$ObservationFile,
        [Parameter(Mandatory)][hashtable]$SourceArguments
    )
    $actual = Read-ReversibleCutoverJson $ObservationFile
    $expected = New-ReversibleCutoverObservation @SourceArguments
    $actualJson = $actual | ConvertTo-Json -Depth 12 -Compress
    $expectedJson = $expected | ConvertTo-Json -Depth 12 -Compress
    if ($actualJson -cne $expectedJson) {
        Throw-ReversibleCutoverError 'DYSON_REVERSIBLE_CUTOVER_OBSERVATION_MISMATCH'
    }
    return $expected
}
