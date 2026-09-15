[CmdletBinding()]
param()

Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
. (Join-Path $PSScriptRoot 'Qualification.PairedSaveLoad.ps1')

function Copy-PairedRecordSelfTestValue {
    param([Parameter(Mandatory)]$Value)
    $json = $Value | ConvertTo-Json -Depth 24 -Compress
    $command = Get-Command ConvertFrom-Json -ErrorAction Stop
    if ($command.Parameters.ContainsKey('DateKind')) { return $json | ConvertFrom-Json -DateKind String }
    return $json | ConvertFrom-Json
}

function Protect-PairedRecordSelfTestValue {
    param([Parameter(Mandatory)]$Value)
    $Value.observationSha256 = Get-DysonPairedSaveLoadObservationDigest $Value
    return $Value
}

function Assert-PairedRecordSelfTestRejected {
    param([Parameter(Mandatory)][scriptblock]$Action, [Parameter(Mandatory)][string]$Name)
    $rejected = $false
    try { & $Action | Out-Null }
    catch {
        $code = if ($_.Exception.Data.Contains('Code')) { [string]$_.Exception.Data['Code'] } else { [string]$_.Exception.Message }
        $rejected = $code -cmatch '^DYSON_QUALIFICATION_PAIRED_SAVE_LOAD_'
    }
    if (-not $rejected) { throw ('Expected rejection: ' + $Name) }
    $script:tests.Add($Name)
}

$script:tests = New-Object 'System.Collections.Generic.List[string]'
$runId = '11111111-1111-4111-8111-111111111111'
$observationId = '22222222-2222-4222-8222-222222222222'
$restoreOperationId = '33333333-3333-4333-8333-333333333333'
$rollbackOperationId = '44444444-4444-4444-8444-444444444444'
$sourceBundleId = '55555555-5555-4555-8555-555555555555'
$saveRequestId = '66666666-6666-4666-8666-666666666666'
$sessionId = '77777777-7777-4777-8777-777777777777'
$commit = '1' * 40
$release = 'v1.2.3-fixture'
$dataRoot = 'sha256:' + ('2' * 64)
$restoreSource = '3' * 64
$protectionSource = '4' * 64
$rollbackSource = '5' * 64
$dsvSha = '6' * 64
$serverSha = '7' * 64
$observed = [datetimeoffset]::Parse('2030-01-01T00:09:00Z')
$expires = [datetimeoffset]::Parse('2030-01-01T01:00:00Z')
$now = [datetimeoffset]::Parse('2030-01-01T00:10:00Z')
$saveStarted = [datetimeoffset]::Parse('2030-01-01T00:03:00Z').ToUnixTimeMilliseconds()
$saveFinished = [datetimeoffset]::Parse('2030-01-01T00:04:00Z').ToUnixTimeMilliseconds()
$loadedObserved = [datetimeoffset]::Parse('2030-01-01T00:05:00Z').ToUnixTimeMilliseconds()
$loadedWritten = [datetimeoffset]::Parse('2030-01-01T00:05:01Z').ToUnixTimeMilliseconds()
$dsvTicks = 640290530400000000L
$serverTicks = 640290530410000000L

$saveAcknowledgement = [pscustomobject][ordered]@{
    protocol='DYSON_CONTROL_RECEIPT_V2'; sourceSha256=('8'*64); requestId=$saveRequestId
    startedAtUnixMs=$saveStarted; finishedAtUnixMs=$saveFinished; saveTimeBefore=100L; saveTimeAfter=101L
    dsvBytes=4096L; dsvWriteTimeUtcTicks=$dsvTicks; serverBytes=2048L; serverWriteTimeUtcTicks=$serverTicks
    saveGenerationId=$null
}
$saveAcknowledgement.saveGenerationId = Get-DysonPairedSaveLoadGenerationId $saveAcknowledgement
$pair = [pscustomobject][ordered]@{
    protocol='DYSON_QUALIFICATION_PAIRED_SAVE_PAIR_V2'; saveName='_lastexit_'
    dsvLength=4096L; dsvWriteTimeUtcTicks=$dsvTicks; dsvSha256=$dsvSha
    serverLength=2048L; serverWriteTimeUtcTicks=$serverTicks; serverSha256=$serverSha; pairSha256=$null
}
$pair.pairSha256 = Get-DysonPairedSaveLoadTextSha256 (ConvertTo-DysonPairedSaveLoadCanonicalJson ([pscustomobject][ordered]@{
    protocol=$pair.protocol; saveName=$pair.saveName; dsvLength=$pair.dsvLength
    dsvWriteTimeUtcTicks=$pair.dsvWriteTimeUtcTicks; dsvSha256=$pair.dsvSha256
    serverLength=$pair.serverLength; serverWriteTimeUtcTicks=$pair.serverWriteTimeUtcTicks; serverSha256=$pair.serverSha256
}))
$record = [pscustomobject][ordered]@{
    protocol='DYSON_QUALIFICATION_PAIRED_SAVE_LOAD_OBSERVATION_V2'; schemaVersion=2
    observationId=$observationId; qualificationRunId=$runId; controlRelease=$release; subjectCommit=$commit
    restoreReceipt=[pscustomobject][ordered]@{
        protocol='DYSON_CONTROL_DATA_ROOT_RECOVERY_RECEIPT_V1'; schemaVersion=1; sourceSha256=$restoreSource
        operationId=$restoreOperationId; requestFingerprint=('9'*64); dataRootIdentity=$dataRoot; bundleId=$sourceBundleId
        manifestSha256=('a'*64); protectionManifestSha256=$protectionSource; completedAtUtc='2030-01-01T00:02:00.000Z'
    }
    protectionPoint=[pscustomobject][ordered]@{
        protocol='DYSON_CONTROL_DATA_ROOT_RECOVERY_BUNDLE_V1'; schemaVersion=1; sourceSha256=$protectionSource
        protectionPointId=$restoreOperationId; dataRootIdentity=$dataRoot; createdAtUtc='2030-01-01T00:01:00.000Z'
        inventorySha256=('b'*64); fileCount=2L; totalBytes=6144L
    }
    bridgeLoadedSave=[pscustomobject][ordered]@{
        protocol='DYSON_CONTROL_LOADED_SAVE_EVIDENCE_V1'; sourceSha256=('c'*64); sessionId=$sessionId
        pluginVersion='1.2.3-fixture'; processId=4242L
        processStartedAtUnixMs=[datetimeoffset]::Parse('2030-01-01T00:00:00Z').ToUnixTimeMilliseconds()
        bridgeStartedAtUnixMs=[datetimeoffset]::Parse('2030-01-01T00:00:01Z').ToUnixTimeMilliseconds()
        observationGeneration=17L; observedAtUnixMs=$loadedObserved; writtenAtUnixMs=$loadedWritten; saveName='_lastexit_'
        dsvBytes=4096L; dsvWriteTimeUtcTicks=$dsvTicks; dsvSha256=$dsvSha
        serverBytes=2048L; serverWriteTimeUtcTicks=$serverTicks; serverSha256=$serverSha
    }
    newSaveAcknowledgement=$saveAcknowledgement
    stableSavePair=$pair
    rollbackReceipt=[pscustomobject][ordered]@{
        protocol='DYSON_CONTROL_DATA_ROOT_RECOVERY_RECEIPT_V1'; schemaVersion=1; sourceSha256=$rollbackSource
        operationId=$rollbackOperationId; requestFingerprint=('d'*64); dataRootIdentity=$dataRoot; bundleId=$restoreOperationId
        manifestSha256=$protectionSource; protectionManifestSha256=('e'*64); completedAtUtc='2030-01-01T00:08:00.000Z'
    }
    observedAtUtc='2030-01-01T00:09:00.000Z'; expiresAtUtc='2030-01-01T01:00:00.000Z'; observationSha256=$null
}
$record = Protect-PairedRecordSelfTestValue $record
$baseArguments = @{
    ExpectedObservationId=$observationId; ExpectedQualificationRunId=$runId; ExpectedControlRelease=$release
    ExpectedSubjectCommit=$commit; ExpectedRestoreSourceSha256=('sha256:'+$restoreSource)
    ExpectedProtectionSourceSha256=('sha256:'+$protectionSource); ExpectedRollbackSourceSha256=('sha256:'+$rollbackSource)
    ExpectedObservationSha256=('sha256:'+$record.observationSha256); ExpectedObservedAtUtc=$observed
    ExpectedExpiresAtUtc=$expires; NowUtc=$now
}

try {
    $result = Assert-DysonQualificationPairedSaveLoadRecordV2 -Observation $record @baseArguments
    if (-not $result.valid -or $result.observationSha256 -cne $record.observationSha256 -or
        $result.stablePairSha256 -cne $pair.pairSha256) { throw 'Positive record validation failed.' }
    $script:tests.Add('valid-record')

    Assert-PairedRecordSelfTestRejected { Assert-DysonQualificationPairedSaveLoadRecordV2 -Observation ([pscustomobject]@{ status='verified' }) @baseArguments } 'generic-status-rejected'

    $changed = Copy-PairedRecordSelfTestValue $record; Add-Member -InputObject $changed.restoreReceipt -NotePropertyName status -NotePropertyValue verified
    $changed = Protect-PairedRecordSelfTestValue $changed
    Assert-PairedRecordSelfTestRejected { Assert-DysonQualificationPairedSaveLoadRecordV2 -Observation $changed @baseArguments } 'nested-extra-property-rejected'

    $changed = Copy-PairedRecordSelfTestValue $record; $changed.qualificationRunId='88888888-8888-4888-8888-888888888888'; $changed=Protect-PairedRecordSelfTestValue $changed
    Assert-PairedRecordSelfTestRejected { Assert-DysonQualificationPairedSaveLoadRecordV2 -Observation $changed @baseArguments } 'cross-run-rejected'

    $changed = Copy-PairedRecordSelfTestValue $record; $changed.controlRelease='v9.9.9-fixture'; $changed=Protect-PairedRecordSelfTestValue $changed
    Assert-PairedRecordSelfTestRejected { Assert-DysonQualificationPairedSaveLoadRecordV2 -Observation $changed @baseArguments } 'cross-release-rejected'

    $changed = Copy-PairedRecordSelfTestValue $record; $changed.subjectCommit='f'*40; $changed=Protect-PairedRecordSelfTestValue $changed
    Assert-PairedRecordSelfTestRejected { Assert-DysonQualificationPairedSaveLoadRecordV2 -Observation $changed @baseArguments } 'cross-commit-rejected'

    $changed = Copy-PairedRecordSelfTestValue $record; $changed.restoreReceipt.sourceSha256='0'*64; $changed=Protect-PairedRecordSelfTestValue $changed
    Assert-PairedRecordSelfTestRejected { Assert-DysonQualificationPairedSaveLoadRecordV2 -Observation $changed @baseArguments } 'restore-source-splice-rejected'

    $changed = Copy-PairedRecordSelfTestValue $record; $changed.rollbackReceipt.sourceSha256='0'*64; $changed=Protect-PairedRecordSelfTestValue $changed
    Assert-PairedRecordSelfTestRejected { Assert-DysonQualificationPairedSaveLoadRecordV2 -Observation $changed @baseArguments } 'rollback-source-splice-rejected'

    $changed = Copy-PairedRecordSelfTestValue $record; $changed.newSaveAcknowledgement.saveGenerationId='generation-v1:'+('0'*64); $changed=Protect-PairedRecordSelfTestValue $changed
    Assert-PairedRecordSelfTestRejected { Assert-DysonQualificationPairedSaveLoadRecordV2 -Observation $changed @baseArguments } 'save-generation-splice-rejected'

    $changed = Copy-PairedRecordSelfTestValue $record; $changed.stableSavePair.dsvSha256='0'*64
    $changed.stableSavePair.pairSha256=Get-DysonPairedSaveLoadTextSha256 (ConvertTo-DysonPairedSaveLoadCanonicalJson ([pscustomobject][ordered]@{
        protocol=$changed.stableSavePair.protocol; saveName=$changed.stableSavePair.saveName; dsvLength=$changed.stableSavePair.dsvLength
        dsvWriteTimeUtcTicks=$changed.stableSavePair.dsvWriteTimeUtcTicks; dsvSha256=$changed.stableSavePair.dsvSha256
        serverLength=$changed.stableSavePair.serverLength; serverWriteTimeUtcTicks=$changed.stableSavePair.serverWriteTimeUtcTicks; serverSha256=$changed.stableSavePair.serverSha256
    })); $changed=Protect-PairedRecordSelfTestValue $changed
    Assert-PairedRecordSelfTestRejected { Assert-DysonQualificationPairedSaveLoadRecordV2 -Observation $changed @baseArguments } 'save-pair-splice-rejected'

    $changed = Copy-PairedRecordSelfTestValue $record; $changed.rollbackReceipt.completedAtUtc='2030-01-01T00:04:30.000Z'; $changed=Protect-PairedRecordSelfTestValue $changed
    Assert-PairedRecordSelfTestRejected { Assert-DysonQualificationPairedSaveLoadRecordV2 -Observation $changed @baseArguments } 'time-order-rejected'

    $staleArguments=@{}+$baseArguments; $staleArguments.NowUtc=[datetimeoffset]::Parse('2030-01-01T01:00:00Z')
    Assert-PairedRecordSelfTestRejected { Assert-DysonQualificationPairedSaveLoadRecordV2 -Observation $record @staleArguments } 'expired-record-rejected'

    $changed=Copy-PairedRecordSelfTestValue $record; $changed.observationSha256='0'*64
    Assert-PairedRecordSelfTestRejected { Assert-DysonQualificationPairedSaveLoadRecordV2 -Observation $changed @baseArguments } 'self-digest-rejected'

    $changed=Copy-PairedRecordSelfTestValue $record; $changed.stableSavePair=[pscustomobject][ordered]@{ status='verified' }; $changed=Protect-PairedRecordSelfTestValue $changed
    Assert-PairedRecordSelfTestRejected { Assert-DysonQualificationPairedSaveLoadRecordV2 -Observation $changed @baseArguments } 'recomputed-status-only-rejected'

    $changed=Copy-PairedRecordSelfTestValue $record; $changed.observedAtUtc='2030-01-01T00:08:30.000Z'; $changed=Protect-PairedRecordSelfTestValue $changed
    $changedArguments=@{}+$baseArguments; $changedArguments.ExpectedObservationSha256='sha256:'+$changed.observationSha256
    Assert-PairedRecordSelfTestRejected { Assert-DysonQualificationPairedSaveLoadRecordV2 -Observation $changed @changedArguments } 'top-time-binding-rejected'

    [pscustomobject][ordered]@{
        ok=$true; protocol='DYSON_QUALIFICATION_PAIRED_SAVE_LOAD_OBSERVATION_V2'
        testCount=$script:tests.Count; tests=@($script:tests); networkTouched=$false; productionChanged=$false
    } | ConvertTo-Json -Depth 5 -Compress
    exit 0
}
catch {
    [pscustomobject][ordered]@{ ok=$false; error=[string]$_.Exception.Message; tests=@($script:tests); networkTouched=$false; productionChanged=$false } | ConvertTo-Json -Depth 5 -Compress
    exit 1
}
