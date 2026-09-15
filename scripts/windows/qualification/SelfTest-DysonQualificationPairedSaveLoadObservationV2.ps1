#requires -Version 5.1
[CmdletBinding()]
param(
    [string]$WorkspaceTempRoot
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'Qualification.PairedSaveLoad.ps1')

function Assert-PairedSaveLoadSelfTest {
    param([bool]$Condition, [Parameter(Mandatory)][string]$Message)
    if (-not $Condition) { throw "SAV-005 self-test failed: $Message" }
}

function Assert-PairedSaveLoadSelfTestFailure {
    param([Parameter(Mandatory)][scriptblock]$Action, [Parameter(Mandatory)][string]$ExpectedCode)
    $observed = $null
    try { & $Action }
    catch { $observed = [string]$_.Exception.Message }
    Assert-PairedSaveLoadSelfTest ($observed -ceq $ExpectedCode) "expected $ExpectedCode, observed $observed"
}

function Write-PairedSaveLoadSelfTestText {
    param([Parameter(Mandatory)][string]$Path, [Parameter(Mandatory)][string]$Text)
    [IO.File]::WriteAllText($Path, $Text, (New-Object Text.UTF8Encoding($false, $true)))
}

function Write-PairedSaveLoadSelfTestJson {
    param([Parameter(Mandatory)][string]$Path, [Parameter(Mandatory)]$Value)
    Write-PairedSaveLoadSelfTestText $Path ((ConvertTo-DysonPairedSaveLoadCanonicalJson $Value) + "`n")
}

function Write-PairedSaveLoadSelfTestWire {
    param([Parameter(Mandatory)][string]$Path, [Parameter(Mandatory)][System.Collections.IDictionary]$Fields)
    $lines = @($Fields.GetEnumerator() | ForEach-Object { [string]$_.Key + '=' + [string]$_.Value })
    Write-PairedSaveLoadSelfTestText $Path (($lines -join "`n") + "`n")
}

function New-PairedSaveLoadSelfTestRecoveryReceipt {
    param(
        [Parameter(Mandatory)][string]$OperationId,
        [Parameter(Mandatory)][string]$BundleId,
        [Parameter(Mandatory)][string]$ManifestSha256,
        [Parameter(Mandatory)][string]$ProtectionManifestSha256,
        [Parameter(Mandatory)][datetimeoffset]$CompletedAt
    )
    return [pscustomobject][ordered]@{
        protocol = 'DYSON_CONTROL_DATA_ROOT_RECOVERY_RECEIPT_V1'
        schemaVersion = 1
        recordKind = 'receipt'
        operation = 'restore'
        operationId = $OperationId
        requestFingerprint = ('a' * 64)
        dataRootIdentity = 'sha256:' + ('b' * 64)
        bundleId = $BundleId
        outcome = 'succeeded'
        manifestSha256 = $ManifestSha256
        protectionManifestSha256 = $ProtectionManifestSha256
        errorCode = $null
        completedAt = $CompletedAt.ToUniversalTime().ToString('o')
    }
}

$repositoryRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..\..'))
$requiredBase = [IO.Path]::GetFullPath((Join-Path (Split-Path -Parent $repositoryRoot) '.codex-temp')).TrimEnd('\')
if ([string]::IsNullOrWhiteSpace($WorkspaceTempRoot)) { $WorkspaceTempRoot = $requiredBase }
$base = [IO.Path]::GetFullPath($WorkspaceTempRoot).TrimEnd('\')
if ($base -cne $requiredBase) { throw 'SAV-005 self-test temp root must be the repository sibling .codex-temp directory' }
if (-not (Test-Path -LiteralPath $base -PathType Container)) {
    [void](New-Item -ItemType Directory -Path $base -Force)
}
$root = Join-Path $base ('paired-save-load-selftest-' + [guid]::NewGuid().ToString('N'))
[void](New-Item -ItemType Directory -Path $root)
$stage = 'setup'

try {
    $newScript = Join-Path $PSScriptRoot 'New-DysonQualificationPairedSaveLoadObservationV2.ps1'
    $testScript = Join-Path $PSScriptRoot 'Test-DysonQualificationPairedSaveLoadObservationV2.ps1'
    $restoreId = '11111111-1111-4111-8111-111111111111'
    $targetBundleId = '22222222-2222-4222-8222-222222222222'
    $rollbackId = '33333333-3333-4333-8333-333333333333'
    $observationId = '44444444-4444-4444-8444-444444444444'
    $runId = '55555555-5555-4555-8555-555555555555'
    $saveRequestId = '66666666-6666-4666-8666-666666666666'
    $sessionId = '77777777-7777-4777-8777-777777777777'
    $now = [datetimeoffset]::Parse('2030-01-01T00:02:05.000Z')
    $restoreCompleted = [datetimeoffset]::Parse('2030-01-01T00:00:00.000Z')
    $saveStartedUnixMs = [datetimeoffset]::Parse('2030-01-01T00:01:00.000Z').ToUnixTimeMilliseconds()
    $saveFinishedUnixMs = [datetimeoffset]::Parse('2030-01-01T00:01:02.000Z').ToUnixTimeMilliseconds()
    $loadedObservedUnixMs = [datetimeoffset]::Parse('2030-01-01T00:01:03.000Z').ToUnixTimeMilliseconds()
    $rollbackCompleted = [datetimeoffset]::Parse('2030-01-01T00:02:00.000Z')
    $expiry = $now.AddHours(1)

    $dsvPath = Join-Path $root '_lastexit_.dsv'
    $serverPath = Join-Path $root '_lastexit_.server'
    Write-PairedSaveLoadSelfTestText $dsvPath 'fictional restored DSP save generation SAV-005'
    Write-PairedSaveLoadSelfTestText $serverPath 'fictional restored Nebula sidecar generation SAV-005'
    $pairWriteTime = [datetime]::SpecifyKind([datetime]'2030-01-01T00:01:01.0000000', [DateTimeKind]::Utc)
    [IO.File]::SetLastWriteTimeUtc($dsvPath, $pairWriteTime)
    [IO.File]::SetLastWriteTimeUtc($serverPath, $pairWriteTime)
    $dsv = Get-Item -LiteralPath $dsvPath
    $server = Get-Item -LiteralPath $serverPath
    $dsvSha256 = Get-DysonPairedSaveLoadFileSha256 $dsvPath
    $serverSha256 = Get-DysonPairedSaveLoadFileSha256 $serverPath

    $acl = [pscustomobject][ordered]@{
        mode = 'exact-binary-security-descriptor'
        descriptorSha256 = ('c' * 64)
        binaryBase64 = 'RklDVElPTkFMX0FDTA=='
    }
    $protectionManifestPath = Join-Path $root 'protection-manifest.json'
    $protectionManifest = [pscustomobject][ordered]@{
        protocol = 'DYSON_CONTROL_DATA_ROOT_RECOVERY_BUNDLE_V1'
        schemaVersion = 1
        bundleId = $restoreId
        bundleKind = 'protection-point'
        dataRootIdentity = 'sha256:' + ('b' * 64)
        createdAt = '2029-12-31T23:59:59.000Z'
        fileCount = 2
        directoryCount = 1
        totalBytes = [int64]$dsv.Length + [int64]$server.Length
        inventorySha256 = ('d' * 64)
        entries = @(
            [pscustomobject][ordered]@{ relativePath='.'; type='directory'; length=0; sha256=('e' * 64); aclIntent=$acl },
            [pscustomobject][ordered]@{ relativePath='data\_lastexit_.dsv'; type='file'; length=[int64]$dsv.Length; sha256=$dsvSha256; aclIntent=$acl },
            [pscustomobject][ordered]@{ relativePath='data\_lastexit_.server'; type='file'; length=[int64]$server.Length; sha256=$serverSha256; aclIntent=$acl }
        )
    }
    Write-PairedSaveLoadSelfTestJson $protectionManifestPath $protectionManifest
    $protectionSha256 = Get-DysonPairedSaveLoadFileSha256 $protectionManifestPath

    $restoreReceiptPath = Join-Path $root 'restore-receipt.json'
    Write-PairedSaveLoadSelfTestJson $restoreReceiptPath (
        New-PairedSaveLoadSelfTestRecoveryReceipt `
            -OperationId $restoreId `
            -BundleId $targetBundleId `
            -ManifestSha256 ('f' * 64) `
            -ProtectionManifestSha256 $protectionSha256 `
            -CompletedAt $restoreCompleted
    )

    $bridgeSecretPath = Join-Path $root 'bridge-secret.txt'
    $bridgeSecret = 'fictional-SAV-005-bridge-secret-material-0001'
    Write-PairedSaveLoadSelfTestText $bridgeSecretPath $bridgeSecret
    $saveAcknowledgementPath = Join-Path $root 'save-acknowledgement.receipt'
    $saveFields = [ordered]@{
        protocol = 'DYSON_CONTROL_RECEIPT_V2'
        requestId = $saveRequestId
        action = 'save'
        state = 'succeeded'
        startedAtUnixMs = $saveStartedUnixMs
        finishedAtUnixMs = $saveFinishedUnixMs
        saveName = '_lastexit_'
        saveTimeBefore = '100'
        saveTimeAfter = '101'
        dsvBytes = [int64]$dsv.Length
        dsvWriteTimeUtcTicks = [int64]$dsv.LastWriteTimeUtc.Ticks
        serverBytes = [int64]$server.Length
        serverWriteTimeUtcTicks = [int64]$server.LastWriteTimeUtc.Ticks
        dsvChanged = 'true'
        serverChanged = 'true'
        errorCode = 'NONE'
        hmac = $null
    }
    $saveFields.hmac = Get-DysonPairedSaveLoadHmacSha256 -Secret $bridgeSecret `
        -Parts @($saveFields.Keys | Where-Object { $_ -cne 'hmac' } | ForEach-Object { [string]$saveFields[$_] })
    Write-PairedSaveLoadSelfTestWire $saveAcknowledgementPath $saveFields

    $loadedSaveEvidencePath = Join-Path $root 'loaded-save-evidence'
    $loadedFields = [ordered]@{
        protocol = 'DYSON_CONTROL_LOADED_SAVE_EVIDENCE_V1'
        sessionId = $sessionId
        pluginVersion = '0.1.0'
        processId = '4242'
        processStartedAtUnixMs = [datetimeoffset]::Parse('2029-12-31T23:59:00.000Z').ToUnixTimeMilliseconds()
        bridgeStartedAtUnixMs = [datetimeoffset]::Parse('2029-12-31T23:59:30.000Z').ToUnixTimeMilliseconds()
        observationGeneration = '9'
        observedAtUnixMs = $loadedObservedUnixMs
        writtenAtUnixMs = $loadedObservedUnixMs
        saveName = '_lastexit_'
        dsvBytes = [int64]$dsv.Length
        dsvWriteTimeUtcTicks = [int64]$dsv.LastWriteTimeUtc.Ticks
        dsvSha256 = $dsvSha256
        serverBytes = [int64]$server.Length
        serverWriteTimeUtcTicks = [int64]$server.LastWriteTimeUtc.Ticks
        serverSha256 = $serverSha256
        hmac = $null
    }
    $loadedFields.hmac = Get-DysonPairedSaveLoadHmacSha256 -Secret $bridgeSecret `
        -Parts @($loadedFields.Keys | Where-Object { $_ -cne 'hmac' } | ForEach-Object { [string]$loadedFields[$_] })
    Write-PairedSaveLoadSelfTestWire $loadedSaveEvidencePath $loadedFields

    $rollbackReceiptPath = Join-Path $root 'rollback-receipt.json'
    Write-PairedSaveLoadSelfTestJson $rollbackReceiptPath (
        New-PairedSaveLoadSelfTestRecoveryReceipt `
            -OperationId $rollbackId `
            -BundleId $restoreId `
            -ManifestSha256 $protectionSha256 `
            -ProtectionManifestSha256 ('3' * 64) `
            -CompletedAt $rollbackCompleted
    )

    $observationPath = Join-Path $root 'paired-save-load-observation.json'
    $common = @{
        RestoreReceiptPath = $restoreReceiptPath
        ProtectionPointManifestPath = $protectionManifestPath
        LoadedSaveEvidencePath = $loadedSaveEvidencePath
        SaveAcknowledgementPath = $saveAcknowledgementPath
        BridgeSecretPath = $bridgeSecretPath
        DsvPath = $dsvPath
        ServerPath = $serverPath
        RollbackReceiptPath = $rollbackReceiptPath
    }
    $testExpected = @{
        ExpectedQualificationRunId = $runId
        ExpectedControlRelease = 'v0.1.0-rc.1'
        ExpectedSubjectCommit = ('4' * 40)
    }

    $stage = 'positive-generation'
    [void](& $newScript @common `
        -ObservationId $observationId `
        -QualificationRunId $runId `
        -ControlRelease 'v0.1.0-rc.1' `
        -SubjectCommit ('4' * 40) `
        -ObservedAtUtc $now `
        -ExpiresAtUtc $expiry `
        -OutputPath $observationPath)
    $accepted = @(& $testScript @common @testExpected -ObservationPath $observationPath -NowUtc $now) | Select-Object -Last 1 | ConvertFrom-Json
    Assert-PairedSaveLoadSelfTest ([bool]$accepted.valid -and
        [string]$accepted.protocol -ceq 'DYSON_QUALIFICATION_PAIRED_SAVE_LOAD_OBSERVATION_V2') `
        'valid paired save load observation was rejected'

    $stage = 'stale-rejected'
    Assert-PairedSaveLoadSelfTestFailure {
        & $testScript @common @testExpected -ObservationPath $observationPath -NowUtc $expiry
    } 'DYSON_QUALIFICATION_PAIRED_SAVE_LOAD_STALE'

    $stage = 'release-commit-binding-rejected'
    $wrongExpected = @{
        ExpectedQualificationRunId = $runId
        ExpectedControlRelease = 'v0.1.0-rc.1'
        ExpectedSubjectCommit = ('5' * 40)
    }
    Assert-PairedSaveLoadSelfTestFailure {
        & $testScript @common @wrongExpected -ObservationPath $observationPath -NowUtc $now
    } 'DYSON_QUALIFICATION_PAIRED_SAVE_LOAD_BINDING_INVALID'

    $stage = 'mixed-generation-rejected'
    $mixedLoadedPath = Join-Path $root 'loaded-save-evidence-mixed'
    $mixedLoaded = [ordered]@{}
    foreach ($entry in $loadedFields.GetEnumerator()) { $mixedLoaded[$entry.Key] = $entry.Value }
    $mixedLoaded['serverBytes'] = [string]([int64]$server.Length + 1)
    $mixedLoaded['hmac'] = Get-DysonPairedSaveLoadHmacSha256 -Secret $bridgeSecret `
        -Parts @($mixedLoaded.Keys | Where-Object { $_ -cne 'hmac' } | ForEach-Object { [string]$mixedLoaded[$_] })
    Write-PairedSaveLoadSelfTestWire $mixedLoadedPath $mixedLoaded
    $mixed = @{}
    foreach ($entry in $common.GetEnumerator()) { $mixed[$entry.Key] = $entry.Value }
    $mixed.LoadedSaveEvidencePath = $mixedLoadedPath
    Assert-PairedSaveLoadSelfTestFailure {
        & $newScript @mixed `
            -ObservationId '88888888-8888-4888-8888-888888888888' `
            -QualificationRunId $runId `
            -ControlRelease 'v0.1.0-rc.1' `
            -SubjectCommit ('4' * 40) `
            -ObservedAtUtc $now `
            -ExpiresAtUtc $expiry `
            -OutputPath (Join-Path $root 'mixed.json')
    } 'DYSON_QUALIFICATION_PAIRED_SAVE_LOAD_GENERATION_MISMATCH'

    $stage = 'bridge-signature-tamper-rejected'
    $badSignaturePath = Join-Path $root 'loaded-save-evidence-bad-signature'
    $badSignature = [ordered]@{}
    foreach ($entry in $loadedFields.GetEnumerator()) { $badSignature[$entry.Key] = $entry.Value }
    $badSignature['hmac'] = ('0' * 64)
    Write-PairedSaveLoadSelfTestWire $badSignaturePath $badSignature
    $badSignatureArgs = @{}
    foreach ($entry in $common.GetEnumerator()) { $badSignatureArgs[$entry.Key] = $entry.Value }
    $badSignatureArgs.LoadedSaveEvidencePath = $badSignaturePath
    Assert-PairedSaveLoadSelfTestFailure {
        & $newScript @badSignatureArgs `
            -ObservationId 'abababab-abab-4bab-8bab-abababababab' `
            -QualificationRunId $runId `
            -ControlRelease 'v0.1.0-rc.1' `
            -SubjectCommit ('4' * 40) `
            -ObservedAtUtc $now `
            -ExpiresAtUtc $expiry `
            -OutputPath (Join-Path $root 'bad-signature.json')
    } 'DYSON_QUALIFICATION_PAIRED_SAVE_LOAD_BRIDGE_SIGNATURE_INVALID'

    $stage = 'single-file-rejected'
    $single = @{}
    foreach ($entry in $common.GetEnumerator()) { $single[$entry.Key] = $entry.Value }
    $single.ServerPath = $dsvPath
    Assert-PairedSaveLoadSelfTestFailure {
        & $newScript @single `
            -ObservationId '99999999-9999-4999-8999-999999999999' `
            -QualificationRunId $runId `
            -ControlRelease 'v0.1.0-rc.1' `
            -SubjectCommit ('4' * 40) `
            -ObservedAtUtc $now `
            -ExpiresAtUtc $expiry `
            -OutputPath (Join-Path $root 'single.json')
    } 'DYSON_QUALIFICATION_PAIRED_SAVE_LOAD_PAIR_INVALID'

    $stage = 'hash-drift-rejected'
    $originalDsv = [IO.File]::ReadAllText($dsvPath, (New-Object Text.UTF8Encoding($false, $true)))
    $originalDsvTime = $dsv.LastWriteTimeUtc
    Write-PairedSaveLoadSelfTestText $dsvPath ($originalDsv + '-tampered')
    Assert-PairedSaveLoadSelfTestFailure {
        & $testScript @common @testExpected -ObservationPath $observationPath -NowUtc $now
    } 'DYSON_QUALIFICATION_PAIRED_SAVE_LOAD_GENERATION_MISMATCH'
    Write-PairedSaveLoadSelfTestText $dsvPath $originalDsv
    [IO.File]::SetLastWriteTimeUtc($dsvPath, $originalDsvTime)

    $stage = 'rollback-binding-rejected'
    $badRollbackPath = Join-Path $root 'rollback-receipt-unbound.json'
    Write-PairedSaveLoadSelfTestJson $badRollbackPath (
        New-PairedSaveLoadSelfTestRecoveryReceipt `
            -OperationId $rollbackId `
            -BundleId $targetBundleId `
            -ManifestSha256 $protectionSha256 `
            -ProtectionManifestSha256 ('3' * 64) `
            -CompletedAt $rollbackCompleted
    )
    $badRollback = @{}
    foreach ($entry in $common.GetEnumerator()) { $badRollback[$entry.Key] = $entry.Value }
    $badRollback.RollbackReceiptPath = $badRollbackPath
    Assert-PairedSaveLoadSelfTestFailure {
        & $newScript @badRollback `
            -ObservationId 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' `
            -QualificationRunId $runId `
            -ControlRelease 'v0.1.0-rc.1' `
            -SubjectCommit ('4' * 40) `
            -ObservedAtUtc $now `
            -ExpiresAtUtc $expiry `
            -OutputPath (Join-Path $root 'bad-rollback.json')
    } 'DYSON_QUALIFICATION_PAIRED_SAVE_LOAD_RESTORE_BINDING_INVALID'

    $stage = 'generic-status-masquerade-rejected'
    $tampered = Read-DysonPairedSaveLoadJson $observationPath
    $tampered.bridgeLoadedSave = [pscustomobject][ordered]@{
        protocol = 'DYSON_QUALIFICATION_PAIRED_SAVE_LOAD_OBSERVATION_V2'
        status = 'healthy'
    }
    $tampered.observationSha256 = Get-DysonPairedSaveLoadObservationDigest $tampered
    $masqueradePath = Join-Path $root 'generic-status-masquerade.json'
    Write-DysonPairedSaveLoadJsonNew -Path $masqueradePath -Value $tampered | Out-Null
    Assert-PairedSaveLoadSelfTestFailure {
        & $testScript @common @testExpected -ObservationPath $masqueradePath -NowUtc $now
    } 'DYSON_QUALIFICATION_PAIRED_SAVE_LOAD_BINDING_INVALID'

    $stage = 'final-positive-recheck'
    $final = @(& $testScript @common @testExpected -ObservationPath $observationPath -NowUtc $now.AddMinutes(1)) |
        Select-Object -Last 1 | ConvertFrom-Json
    Assert-PairedSaveLoadSelfTest ([bool]$final.valid) 'valid observation failed after negative cases'

    [pscustomobject][ordered]@{
        protocol = 'DYSON_QUALIFICATION_PAIRED_SAVE_LOAD_SELF_TEST_V1'
        passed = $true
        positiveCases = 2
        negativeCases = 8
        productionTouched = $false
        tempRoot = $base
    } | ConvertTo-Json -Compress
}
catch {
    throw "SAV-005 self-test stage '$stage' failed: $($_.Exception.Message)"
}
finally {
    $rootFull = [IO.Path]::GetFullPath($root)
    if ($rootFull.StartsWith($base + '\', [StringComparison]::Ordinal) -and
        [IO.Path]::GetFileName($rootFull).StartsWith('paired-save-load-selftest-', [StringComparison]::Ordinal)) {
        Remove-Item -LiteralPath $rootFull -Recurse -Force -ErrorAction SilentlyContinue
    }
}
