# Copyright (c) Dyson Control contributors.
# Positive and adversarial fixture matrix for the PRD-001 observation protocol.

[CmdletBinding()]
param(
    [AllowNull()][string]$TempRoot,
    [switch]$KeepArtifacts
)

Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'

. (Join-Path $PSScriptRoot 'Qualification.SideBySideV2.ps1')

function Assert-SideBySideSelfTest {
    param([Parameter(Mandatory)][bool]$Condition, [Parameter(Mandatory)][string]$Message)
    if (-not $Condition) { throw $Message }
}

function Copy-SideBySideSelfTestValue {
    param([Parameter(Mandatory)]$Value)
    $json = $Value | ConvertTo-Json -Depth 64 -Compress
    if ((Get-Command ConvertFrom-Json).Parameters.ContainsKey('DateKind')) {
        return ($json | ConvertFrom-Json -DateKind String)
    }
    return ($json | ConvertFrom-Json)
}

function Get-SideBySideSelfTestFileSha256 {
    param([Parameter(Mandatory)][string]$Path)
    $bytes = $null
    $algorithm = $null
    try {
        $bytes = [IO.File]::ReadAllBytes($Path)
        $algorithm = [Security.Cryptography.SHA256]::Create()
        return ([BitConverter]::ToString($algorithm.ComputeHash($bytes))).Replace('-', '').ToLowerInvariant()
    }
    finally {
        if ($null -ne $algorithm) { $algorithm.Dispose() }
        if ($null -ne $bytes) { [Array]::Clear($bytes, 0, $bytes.Length) }
    }
}

function Seal-SideBySideSelfTestObservation {
    param([Parameter(Mandatory)]$Observation, [Parameter(Mandatory)][byte[]]$Key)
    $unsigned = Get-DysonSideBySideV2UnsignedValue -Value $Observation -Excluded @('receiptSha256','protection')
    $Observation.receiptSha256 = Get-DysonQualificationV2ObjectDigest -Value $unsigned
    $payload = ConvertTo-DysonQualificationV2CanonicalJson -Value ([pscustomobject][ordered]@{
        domain = 'DYSON_QUALIFICATION_SIDE_BY_SIDE_OBSERVATION_HMAC_V2'
        receiptSha256 = [string]$Observation.receiptSha256
        keyId = [string]$Observation.protection.keyId
    })
    $Observation.protection.hmacSha256 = Get-DysonSideBySideV2Hmac -Key $Key -Text $payload
}

function Assert-SideBySideSelfTestRejects {
    param(
        [Parameter(Mandatory)]$Observation,
        [Parameter(Mandatory)]$Expectation,
        [Parameter(Mandatory)][byte[]]$Key,
        [Parameter(Mandatory)][datetimeoffset]$NowUtc,
        [Parameter(Mandatory)][string]$ExpectedCode,
        [Parameter(Mandatory)][string]$Name
    )
    try {
        [void](Assert-DysonSideBySideV2Observation -Observation $Observation -Expectation $Expectation -Key $Key -NowUtc $NowUtc)
    }
    catch {
        $actual = Get-DysonSideBySideV2ErrorCode -Exception $_.Exception
        Assert-SideBySideSelfTest -Condition ($actual -ceq $ExpectedCode) `
            -Message ("{0} returned {1}, expected {2}." -f $Name, $actual, $ExpectedCode)
        return
    }
    throw ("{0} unexpectedly passed." -f $Name)
}

function Invoke-SideBySideSelfTestChild {
    param([Parameter(Mandatory)][string]$Script, [Parameter(Mandatory)][string[]]$Arguments)
    $shell = (Get-Process -Id $PID -ErrorAction Stop).Path
    $priorErrorActionPreference = $ErrorActionPreference
    try {
        $ErrorActionPreference = 'Continue'
        $output = @(& $shell -NoLogo -NoProfile -ExecutionPolicy Bypass -File $Script @Arguments 2>&1 |
            ForEach-Object { [string]$_ })
    }
    finally { $ErrorActionPreference = $priorErrorActionPreference }
    return [pscustomobject][ordered]@{ exitCode = [int]$LASTEXITCODE; output = $output }
}

$approvedTemp = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..\..\..\.codex-temp')).TrimEnd('\')
if ([string]::IsNullOrWhiteSpace($TempRoot)) { $TempRoot = $approvedTemp }
$tempFull = [IO.Path]::GetFullPath($TempRoot).TrimEnd('\')
if (-not ($tempFull.Equals($approvedTemp, [StringComparison]::OrdinalIgnoreCase) -or
    $tempFull.StartsWith($approvedTemp + '\', [StringComparison]::OrdinalIgnoreCase))) {
    throw 'Self-test TempRoot must remain below the workspace-owned .codex-temp directory.'
}
[void](New-Item -ItemType Directory -Path $tempFull -Force)
$testRoot = Join-Path $tempFull ('qualification-side-by-side-v2-' + [guid]::NewGuid().ToString('N'))
[void](New-Item -ItemType Directory -Path $testRoot)

$key = [byte[]](1..32)
$now = [datetimeoffset]::ParseExact('2030-01-02T03:04:30.000Z', 'yyyy-MM-ddTHH:mm:ss.fffZ',
    [Globalization.CultureInfo]::InvariantCulture, [Globalization.DateTimeStyles]::AssumeUniversal)
$started = $now.AddSeconds(-30)
$observed = $now.AddSeconds(-1)
$expires = $now.AddHours(1)
$verified = $now.AddMinutes(-10)
$snapshotExpires = $now.AddHours(2)

try {
    $candidateRoot = [pscustomobject][ordered]@{
        canonicalPath = 'D:\ExampleDyson\Candidate'
        fileSystem = 'NTFS'
        driveType = 'Fixed'
        volumeIdentitySha256 = 'sha256:' + ('1' * 64)
        rootIdentitySha256 = ''
        reparseFree = $true
    }
    $candidateRoot.rootIdentitySha256 = Get-DysonSideBySideV2RootIdentityDigest -Root $candidateRoot
    $productionRoot = [pscustomobject][ordered]@{
        canonicalPath = 'E:\ExampleDyson\Production'
        fileSystem = 'NTFS'
        driveType = 'Fixed'
        volumeIdentitySha256 = 'sha256:' + ('2' * 64)
        rootIdentitySha256 = ''
        reparseFree = $true
    }
    $productionRoot.rootIdentitySha256 = Get-DysonSideBySideV2RootIdentityDigest -Root $productionRoot
    $gsManagerRoot = [pscustomobject][ordered]@{
        canonicalPath = 'E:\ExampleGsManager'
        fileSystem = 'NTFS'
        driveType = 'Fixed'
        volumeIdentitySha256 = 'sha256:' + ('2' * 64)
        rootIdentitySha256 = ''
        reparseFree = $true
    }
    $gsManagerRoot.rootIdentitySha256 = Get-DysonSideBySideV2RootIdentityDigest -Root $gsManagerRoot

    $artifactHashes = [pscustomobject][ordered]@{
        releasePackageSha256 = 'sha256:' + ('3' * 64)
        artifactPayloadSha256 = 'sha256:' + ('4' * 64)
        runtimePayloadSha256 = 'sha256:' + ('5' * 64)
        manifestSha256 = 'sha256:' + ('6' * 64)
    }
    $deployment = [pscustomobject][ordered]@{
        protocol = 'DYSON_CONTROL_CANDIDATE_DEPLOYMENT_RECEIPT_V2'
        schemaVersion = 2
        receiptId = '11111111-1111-4111-8111-111111111111'
        state = 'installed'
        releaseId = 'example-release-1.2.3'
        subjectCommit = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
        completedAtUtc = ConvertTo-DysonQualificationV2Utc -Value $started.AddSeconds(-5)
        artifactHashes = $artifactHashes
        candidateRootIdentitySha256 = [string]$candidateRoot.rootIdentitySha256
        receiptSha256 = ''
    }
    $deployment.receiptSha256 = Get-DysonQualificationV2ObjectDigest -Value `
        (Get-DysonSideBySideV2UnsignedValue -Value $deployment -Excluded @('receiptSha256'))

    $runtime = [pscustomobject][ordered]@{
        protocol = 'DYSON_QUALIFICATION_SIDE_BY_SIDE_RUNTIME_IDENTITY_V2'
        schemaVersion = 2
        observerClass = 'independent-read-only-os-observer'
        queryMode = 'read-only'
        mutationAttempted = $false
        pid = 4242
        processStartTimeUtc = ConvertTo-DysonQualificationV2Utc -Value $started.AddMinutes(-1)
        observedAtUtc = ConvertTo-DysonQualificationV2Utc -Value $observed
        candidateRootIdentitySha256 = [string]$candidateRoot.rootIdentitySha256
        releaseId = [string]$deployment.releaseId
        subjectCommit = [string]$deployment.subjectCommit
        runtimePayloadSha256 = [string]$artifactHashes.runtimePayloadSha256
        executableSha256 = 'sha256:' + ('7' * 64)
        commandLineSha256 = 'sha256:' + ('8' * 64)
        runtimeAssemblySha256 = 'sha256:' + ('9' * 64)
        nebulaAssemblySha256 = 'sha256:' + ('a' * 64)
        bridgeAssemblySha256 = 'sha256:' + ('b' * 64)
        identitySha256 = ''
    }
    $runtime.identitySha256 = Get-DysonQualificationV2ObjectDigest -Value `
        (Get-DysonSideBySideV2UnsignedValue -Value $runtime -Excluded @('identitySha256'))

    $snapshot = [pscustomobject][ordered]@{
        protocol = 'DYSON_QUALIFICATION_GSMANAGER_SNAPSHOT_VERIFICATION_V2'
        schemaVersion = 2
        snapshotProtocol = 'DYSON_GSMANAGER_SNAPSHOT_V2'
        snapshotId = '22222222-2222-4222-8222-222222222222'
        snapshotManifestSha256 = 'sha256:' + ('c' * 64)
        payloadSha256 = 'sha256:' + ('d' * 64)
        taskXmlSha256 = 'sha256:' + ('e' * 64)
        securityInventorySha256 = 'sha256:' + ('f' * 64)
        pairedSaveProtectionSha256 = 'sha256:' + ('0' * 63) + '1'
        verificationMode = 'full-byte-acl-task-read-only'
        mutationAttempted = $false
        recoverable = $true
        verifiedAtUtc = ConvertTo-DysonQualificationV2Utc -Value $verified
        expiresAtUtc = ConvertTo-DysonQualificationV2Utc -Value $snapshotExpires
        verificationSha256 = ''
    }
    $snapshot.verificationSha256 = Get-DysonQualificationV2ObjectDigest -Value `
        (Get-DysonSideBySideV2UnsignedValue -Value $snapshot -Excluded @('verificationSha256'))

    $authority = [pscustomobject][ordered]@{
        protocol = 'DYSON_QUALIFICATION_SIDE_BY_SIDE_AUTHORITY_OBSERVATION_V2'
        schemaVersion = 2
        observerClass = 'independent-read-only-host-observer'
        queryMode = 'read-only'
        mutationAttempted = $false
        observedAtUtc = ConvertTo-DysonQualificationV2Utc -Value $observed
        authority = 'GSManager'
        authorityGeneration = 17
        switchIntentPresent = $false
        cutoverReceiptPresent = $false
        gsManagerTaskAvailable = $true
        gsManagerSnapshotId = [string]$snapshot.snapshotId
        productionPort = 8469
        productionPortOwner = 'GSManager'
        candidatePort = 13010
        candidateBindAddressClass = 'loopback'
        candidateOwnsProductionPort = $false
        candidateProductionListenerCount = 0
        dualAuthorityDetected = $false
        observationSha256 = ''
    }
    $authority.observationSha256 = Get-DysonQualificationV2ObjectDigest -Value `
        (Get-DysonSideBySideV2UnsignedValue -Value $authority -Excluded @('observationSha256'))

    $capture = [pscustomobject][ordered]@{
        protocol = 'DYSON_QUALIFICATION_SIDE_BY_SIDE_CAPTURE_V2'
        schemaVersion = 2
        receiptId = '33333333-3333-4333-8333-333333333333'
        runId = '44444444-4444-4444-8444-444444444444'
        actionTargetId = 'example-side-by-side-target'
        targetIdentity = 'sha256:' + ('1a' * 32)
        deploymentReceipt = $deployment
        isolation = [pscustomobject][ordered]@{
            candidateRoot = $candidateRoot
            productionDataRoot = $productionRoot
            gsManagerRoot = $gsManagerRoot
            evaluatedAtUtc = ConvertTo-DysonQualificationV2Utc -Value $observed
        }
        health = [pscustomobject][ordered]@{
            protocol = 'DYSON_QUALIFICATION_SIDE_BY_SIDE_HEALTH_OBSERVATION_V2'
            schemaVersion = 2
            observerClass = 'independent-read-only-host-observer'
            probeClass = 'loopback-readyz-read-only'
            requestMethod = 'GET'
            addressClass = 'loopback'
            mutationAttempted = $false
            status = 'healthy'
            httpStatus = 200
            responseSha256 = 'sha256:' + ('2a' * 32)
            deploymentReceiptSha256 = [string]$deployment.receiptSha256
            releaseId = [string]$deployment.releaseId
            subjectCommit = [string]$deployment.subjectCommit
            runtimePayloadSha256 = [string]$artifactHashes.runtimePayloadSha256
            observedAtUtc = ConvertTo-DysonQualificationV2Utc -Value $observed
        }
        runtime = $runtime
        gsManagerSnapshot = $snapshot
        authority = $authority
        observationWindow = [pscustomobject][ordered]@{
            startedAtUtc = ConvertTo-DysonQualificationV2Utc -Value $started
            observedAtUtc = ConvertTo-DysonQualificationV2Utc -Value $observed
            expiresAtUtc = ConvertTo-DysonQualificationV2Utc -Value $expires
            elapsedSeconds = 29
            clockClass = 'bounded-monotonic'
        }
        keyId = 'example-side-by-side-key-v2'
    }
    $expectation = [pscustomobject][ordered]@{
        protocol = 'DYSON_QUALIFICATION_SIDE_BY_SIDE_EXPECTATION_V2'
        schemaVersion = 2
        runId = [string]$capture.runId
        actionTargetId = [string]$capture.actionTargetId
        targetIdentity = [string]$capture.targetIdentity
        releaseId = [string]$deployment.releaseId
        subjectCommit = [string]$deployment.subjectCommit
        artifactHashes = $artifactHashes
        deploymentReceiptSha256 = [string]$deployment.receiptSha256
        candidateRootIdentitySha256 = [string]$candidateRoot.rootIdentitySha256
        gsManagerSnapshotId = [string]$snapshot.snapshotId
        gsManagerSnapshotManifestSha256 = [string]$snapshot.snapshotManifestSha256
        productionPort = [int]$authority.productionPort
        candidatePort = [int]$authority.candidatePort
        keyId = [string]$capture.keyId
    }
    $keyRecord = [pscustomobject][ordered]@{
        protocol = 'DYSON_QUALIFICATION_SIDE_BY_SIDE_KEY_V2'
        schemaVersion = 2
        keyId = [string]$capture.keyId
        keyBase64 = [Convert]::ToBase64String($key)
    }

    $capturePath = Join-Path $testRoot 'capture.json'
    $expectationPath = Join-Path $testRoot 'expectation.json'
    $keyPath = Join-Path $testRoot 'key.json'
    $observationPath = Join-Path $testRoot 'observation.json'
    [void](Write-DysonSideBySideV2JsonCreateNew -Path $capturePath -Value $capture)
    [void](Write-DysonSideBySideV2JsonCreateNew -Path $expectationPath -Value $expectation)
    [void](Write-DysonSideBySideV2JsonCreateNew -Path $keyPath -Value $keyRecord)

    $generator = Join-Path $PSScriptRoot 'New-DysonSideBySideObservationV2.ps1'
    $verifier = Join-Path $PSScriptRoot 'Test-DysonSideBySideObservationV2.ps1'
    $generated = Invoke-SideBySideSelfTestChild -Script $generator -Arguments @(
        '-CapturePath', $capturePath, '-ExpectationPath', $expectationPath, '-KeyPath', $keyPath,
        '-OutputPath', $observationPath, '-NowUtc', (ConvertTo-DysonQualificationV2Utc -Value $now)
    )
    Assert-SideBySideSelfTest -Condition ($generated.exitCode -eq 0) `
        -Message ('Generator failed: ' + ($generated.output -join ' | '))
    $verifiedCli = Invoke-SideBySideSelfTestChild -Script $verifier -Arguments @(
        '-ObservationPath', $observationPath, '-ExpectationPath', $expectationPath, '-KeyPath', $keyPath,
        '-NowUtc', (ConvertTo-DysonQualificationV2Utc -Value $now)
    )
    Assert-SideBySideSelfTest -Condition ($verifiedCli.exitCode -eq 0) `
        -Message ('Verifier failed: ' + ($verifiedCli.output -join ' | '))
    $beforeReplaySha256 = Get-SideBySideSelfTestFileSha256 -Path $observationPath
    $replayedGeneration = Invoke-SideBySideSelfTestChild -Script $generator -Arguments @(
        '-CapturePath', $capturePath, '-ExpectationPath', $expectationPath, '-KeyPath', $keyPath,
        '-OutputPath', $observationPath, '-NowUtc', (ConvertTo-DysonQualificationV2Utc -Value $now)
    )
    $afterReplaySha256 = Get-SideBySideSelfTestFileSha256 -Path $observationPath
    Assert-SideBySideSelfTest -Condition ($replayedGeneration.exitCode -eq 1 -and
        $beforeReplaySha256 -ceq $afterReplaySha256) `
        -Message ('Create-new replay did not fail closed without changing the observation: exit={0}; unchanged={1}; output={2}' -f
            $replayedGeneration.exitCode, ($beforeReplaySha256 -ceq $afterReplaySha256),
            ($replayedGeneration.output -join ' | '))
    $observation = Read-DysonSideBySideV2JsonFile -Path $observationPath
    $result = Assert-DysonSideBySideV2Observation -Observation $observation -Expectation $expectation -Key $key -NowUtc $now
    Assert-SideBySideSelfTest -Condition ([bool]$result.valid -and -not [bool]$result.productionChanged -and
        [string]$result.authority -ceq 'GSManager') -Message 'Positive observation result was not canonical.'

    $statusOnly = [pscustomobject][ordered]@{ status = 'verified' }
    Assert-SideBySideSelfTestRejects -Observation $statusOnly -Expectation $expectation -Key $key -NowUtc $now `
        -ExpectedCode 'DYSON_QUALIFICATION_SIDE_BY_SIDE_V2_OBSERVATION_INVALID' -Name 'status-only forgery'

    $artifactTamper = Copy-SideBySideSelfTestValue -Value $observation
    $artifactTamper.deploymentReceipt.artifactHashes.artifactPayloadSha256 = 'sha256:' + ('ab' * 32)
    $artifactTamper.deploymentReceipt.receiptSha256 = Get-DysonQualificationV2ObjectDigest -Value `
        (Get-DysonSideBySideV2UnsignedValue -Value $artifactTamper.deploymentReceipt -Excluded @('receiptSha256'))
    $artifactTamper.health.deploymentReceiptSha256 = [string]$artifactTamper.deploymentReceipt.receiptSha256
    Seal-SideBySideSelfTestObservation -Observation $artifactTamper -Key $key
    Assert-SideBySideSelfTestRejects -Observation $artifactTamper -Expectation $expectation -Key $key -NowUtc $now `
        -ExpectedCode 'DYSON_QUALIFICATION_SIDE_BY_SIDE_V2_EXPECTED_BINDING_MISMATCH' -Name 're-sealed artifact tamper'

    $rootTamper = Copy-SideBySideSelfTestValue -Value $observation
    $rootTamper.isolation.candidateRoot.fileSystem = 'SMB'
    $rootTamper.isolation.candidateRoot.rootIdentitySha256 = Get-DysonSideBySideV2RootIdentityDigest -Root $rootTamper.isolation.candidateRoot
    $rootTamper.deploymentReceipt.candidateRootIdentitySha256 = [string]$rootTamper.isolation.candidateRoot.rootIdentitySha256
    $rootTamper.deploymentReceipt.receiptSha256 = Get-DysonQualificationV2ObjectDigest -Value `
        (Get-DysonSideBySideV2UnsignedValue -Value $rootTamper.deploymentReceipt -Excluded @('receiptSha256'))
    $rootTamper.health.deploymentReceiptSha256 = [string]$rootTamper.deploymentReceipt.receiptSha256
    $rootTamper.runtime.candidateRootIdentitySha256 = [string]$rootTamper.isolation.candidateRoot.rootIdentitySha256
    $rootTamper.runtime.identitySha256 = Get-DysonQualificationV2ObjectDigest -Value `
        (Get-DysonSideBySideV2UnsignedValue -Value $rootTamper.runtime -Excluded @('identitySha256'))
    Seal-SideBySideSelfTestObservation -Observation $rootTamper -Key $key
    Assert-SideBySideSelfTestRejects -Observation $rootTamper -Expectation $expectation -Key $key -NowUtc $now `
        -ExpectedCode 'DYSON_QUALIFICATION_SIDE_BY_SIDE_V2_CANDIDATE_ROOT_NOT_LOCAL_NTFS' -Name 're-sealed non-NTFS root tamper'

    $healthTamper = Copy-SideBySideSelfTestValue -Value $observation
    $healthTamper.health.mutationAttempted = $true
    Seal-SideBySideSelfTestObservation -Observation $healthTamper -Key $key
    Assert-SideBySideSelfTestRejects -Observation $healthTamper -Expectation $expectation -Key $key -NowUtc $now `
        -ExpectedCode 'DYSON_QUALIFICATION_SIDE_BY_SIDE_V2_HEALTH_INVALID' -Name 're-sealed mutating health probe'

    $runtimeTamper = Copy-SideBySideSelfTestValue -Value $observation
    $runtimeTamper.runtime.subjectCommit = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
    $runtimeTamper.runtime.identitySha256 = Get-DysonQualificationV2ObjectDigest -Value `
        (Get-DysonSideBySideV2UnsignedValue -Value $runtimeTamper.runtime -Excluded @('identitySha256'))
    Seal-SideBySideSelfTestObservation -Observation $runtimeTamper -Key $key
    Assert-SideBySideSelfTestRejects -Observation $runtimeTamper -Expectation $expectation -Key $key -NowUtc $now `
        -ExpectedCode 'DYSON_QUALIFICATION_SIDE_BY_SIDE_V2_RUNTIME_IDENTITY_INVALID' -Name 're-sealed runtime identity tamper'

    $snapshotTamper = Copy-SideBySideSelfTestValue -Value $observation
    $snapshotTamper.gsManagerSnapshot.recoverable = $false
    $snapshotTamper.gsManagerSnapshot.verificationSha256 = Get-DysonQualificationV2ObjectDigest -Value `
        (Get-DysonSideBySideV2UnsignedValue -Value $snapshotTamper.gsManagerSnapshot -Excluded @('verificationSha256'))
    Seal-SideBySideSelfTestObservation -Observation $snapshotTamper -Key $key
    Assert-SideBySideSelfTestRejects -Observation $snapshotTamper -Expectation $expectation -Key $key -NowUtc $now `
        -ExpectedCode 'DYSON_QUALIFICATION_SIDE_BY_SIDE_V2_GSMANAGER_SNAPSHOT_INVALID' -Name 're-sealed unrecoverable snapshot'

    foreach ($authorityCase in @(
        [pscustomobject]@{ name = 'authority switched'; property = 'authority'; value = 'DysonControl' },
        [pscustomobject]@{ name = 'switch intent'; property = 'switchIntentPresent'; value = $true },
        [pscustomobject]@{ name = 'production port takeover'; property = 'candidateOwnsProductionPort'; value = $true },
        [pscustomobject]@{ name = 'dual authority'; property = 'dualAuthorityDetected'; value = $true }
    )) {
        $authorityTamper = Copy-SideBySideSelfTestValue -Value $observation
        $authorityTamper.authority.([string]$authorityCase.property) = $authorityCase.value
        $authorityTamper.authority.observationSha256 = Get-DysonQualificationV2ObjectDigest -Value `
            (Get-DysonSideBySideV2UnsignedValue -Value $authorityTamper.authority -Excluded @('observationSha256'))
        Seal-SideBySideSelfTestObservation -Observation $authorityTamper -Key $key
        Assert-SideBySideSelfTestRejects -Observation $authorityTamper -Expectation $expectation -Key $key -NowUtc $now `
            -ExpectedCode 'DYSON_QUALIFICATION_SIDE_BY_SIDE_V2_AUTHORITY_INVALID' -Name ('re-sealed ' + $authorityCase.name)
    }

    $digestTamper = Copy-SideBySideSelfTestValue -Value $observation
    $digestTamper.receiptSha256 = 'sha256:' + ('0' * 64)
    Assert-SideBySideSelfTestRejects -Observation $digestTamper -Expectation $expectation -Key $key -NowUtc $now `
        -ExpectedCode 'DYSON_QUALIFICATION_SIDE_BY_SIDE_V2_RECEIPT_DIGEST_INVALID' -Name 'receipt digest tamper'

    $hmacTamper = Copy-SideBySideSelfTestValue -Value $observation
    $hmacTamper.protection.hmacSha256 = 'sha256:' + ('0' * 64)
    Assert-SideBySideSelfTestRejects -Observation $hmacTamper -Expectation $expectation -Key $key -NowUtc $now `
        -ExpectedCode 'DYSON_QUALIFICATION_SIDE_BY_SIDE_V2_HMAC_INVALID' -Name 'HMAC tamper'

    Assert-SideBySideSelfTestRejects -Observation $observation -Expectation $expectation -Key $key -NowUtc $expires.AddSeconds(1) `
        -ExpectedCode 'DYSON_QUALIFICATION_SIDE_BY_SIDE_V2_OBSERVATION_STALE' -Name 'expired observation'

    $duplicatePath = Join-Path $testRoot 'duplicate.json'
    [IO.File]::WriteAllText($duplicatePath, '{"protocol":"x","protocol":"y"}', [Text.UTF8Encoding]::new($false))
    try { [void](Read-DysonSideBySideV2JsonFile -Path $duplicatePath); throw 'Duplicate JSON key unexpectedly passed.' }
    catch {
        $duplicateCode = Get-DysonSideBySideV2ErrorCode -Exception $_.Exception
        Assert-SideBySideSelfTest -Condition ($duplicateCode -ceq 'DYSON_QUALIFICATION_SIDE_BY_SIDE_V2_DUPLICATE_JSON_KEY') `
            -Message ('Duplicate JSON key returned ' + $duplicateCode)
    }

    [pscustomobject][ordered]@{
        protocol = 'DYSON_QUALIFICATION_SIDE_BY_SIDE_SELFTEST_V2'
        status = 'passed'
        positiveCases = 3
        adversarialCases = 15
        productionChanged = $false
        fixtureDataClass = 'fictional-rfc5737-example-only'
    } | ConvertTo-Json -Compress
}
finally {
    if ($null -ne $key) { [Array]::Clear($key, 0, $key.Length) }
    $resolvedTest = [IO.Path]::GetFullPath($testRoot).TrimEnd('\')
    if (-not $KeepArtifacts -and
        $resolvedTest.StartsWith($approvedTemp + '\qualification-side-by-side-v2-', [StringComparison]::OrdinalIgnoreCase) -and
        (Test-Path -LiteralPath $resolvedTest -PathType Container)) {
        Remove-Item -LiteralPath $resolvedTest -Recurse -Force -ErrorAction SilentlyContinue
    }
}
