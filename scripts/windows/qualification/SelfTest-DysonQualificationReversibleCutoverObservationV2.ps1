[CmdletBinding()]
param()

Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
. (Join-Path $PSScriptRoot 'Qualification.ReversibleCutover.ps1')

function Write-SelfTestJson {
    param([Parameter(Mandatory)][string]$Path, [Parameter(Mandatory)]$Value)
    [IO.File]::WriteAllText($Path, (($Value | ConvertTo-Json -Depth 16) + "`n"), [Text.UTF8Encoding]::new($false))
}

function Copy-SelfTestObject {
    param([Parameter(Mandatory)]$Value)
    $text = $Value | ConvertTo-Json -Depth 16 -Compress
    $convert = Get-Command ConvertFrom-Json -ErrorAction Stop
    if ($convert.Parameters.ContainsKey('DateKind')) { return $text | ConvertFrom-Json -DateKind String }
    return $text | ConvertFrom-Json
}

function Assert-SelfTest {
    param([Parameter(Mandatory)][bool]$Condition, [Parameter(Mandatory)][string]$Message)
    if (-not $Condition) { throw $Message }
}

function Assert-SelfTestRejected {
    param([Parameter(Mandatory)][scriptblock]$Action, [Parameter(Mandatory)][string]$ExpectedCode, [Parameter(Mandatory)][string]$Name)
    $caught = $null
    try { & $Action | Out-Null }
    catch { $caught = Get-ReversibleCutoverErrorCode $_.Exception }
    if ($caught -cne $ExpectedCode) { throw ($Name + ' expected ' + $ExpectedCode + ', got ' + [string]$caught) }
    $script:tests.Add($Name)
}

function Invoke-SelfTestScript {
    param([Parameter(Mandatory)][string]$ScriptPath, [Parameter(Mandatory)][hashtable]$Arguments)
    $psi = [Diagnostics.ProcessStartInfo]::new()
    $psi.FileName = (Get-Process -Id $PID).Path
    $psi.UseShellExecute = $false
    $psi.RedirectStandardOutput = $true
    $psi.RedirectStandardError = $true
    $tokens = [Collections.Generic.List[string]]::new()
    foreach ($value in @('-NoLogo','-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',$ScriptPath)) {
        $tokens.Add('"' + ([string]$value).Replace('"', '\"') + '"')
    }
    foreach ($key in $Arguments.Keys) {
        $tokens.Add('"-' + $key + '"')
        $tokens.Add('"' + ([string]$Arguments[$key]).Replace('"', '\"') + '"')
    }
    $psi.Arguments = $tokens -join ' '
    $process = [Diagnostics.Process]::new(); $process.StartInfo = $psi
    [void]$process.Start(); $stdout = $process.StandardOutput.ReadToEnd(); $stderr = $process.StandardError.ReadToEnd(); $process.WaitForExit()
    return [pscustomobject]@{ exitCode=$process.ExitCode; stdout=$stdout.Trim(); stderr=$stderr.Trim() }
}

function New-SelfTestSwitchReceipt {
    param([Parameter(Mandatory)][string]$Phase)
    $toDyson = $Phase -ceq 'to-dyson-control'
    $capabilities = if ($toDyson) { @('DisablePreviousAuthority','StopPreviousRuntime','StartCandidateRuntime') } else { @('StopCandidateRuntime','EnablePreviousAuthority','StartPreviousRuntime') }
    $ids = if ($toDyson) {
        @('b1111111-1111-4111-8111-111111111111','b2222222-2222-4222-8222-222222222222','b3333333-3333-4333-8333-333333333333')
    } else {
        @('c1111111-1111-4111-8111-111111111111','c2222222-2222-4222-8222-222222222222','c3333333-3333-4333-8333-333333333333')
    }
    $actions = for ($i=0; $i -lt 3; $i++) {
        [pscustomobject][ordered]@{
            sequence=$i+1; capability=$capabilities[$i]
            brokerReceiptProtocol='DYSON_CONTROL_CUTOVER_BROKER_RECEIPT_V1'
            brokerReceiptSha256=$(if ($toDyson) { ([char](97+$i)).ToString() * 64 } else { ([char](100+$i)).ToString() * 64 })
            hostReceiptProtocol='DYSON_CONTROL_CUTOVER_ACTION_RECEIPT_V1'; requestId=$ids[$i]
            requestFingerprint=$(if ($toDyson) { 'a' * 64 } else { 'b' * 64 }); status='succeeded'
        }
    }
    return [pscustomobject][ordered]@{
        protocol='DYSON_REVERSIBLE_CUTOVER_SWITCH_RECEIPT_V2'; schemaVersion=2
        receiptId=$(if ($toDyson) { '77777777-7777-4777-8777-777777777777' } else { '99999999-9999-4999-8999-999999999999' })
        qualificationRunId=$script:runId; targetIdentity=$script:target; controlRelease=$script:release
        subjectCommit=$script:commit; runtimePayloadSha256=$script:payload; releaseManifestSha256=$script:manifestHash
        dataRootIdentity=$script:dataRoot; saveGenerationId=$script:generation; authorityInventoryRevision=$script:inventory
        phase=$Phase; fromAuthority=$(if ($toDyson) { 'gsmanager' } else { 'dyson-control' })
        toAuthority=$(if ($toDyson) { 'dyson-control' } else { 'gsmanager' }); state='succeeded'; persisted=$true
        actions=@($actions); startedAtUtc=$(if ($toDyson) { '2099-09-05T10:03:00Z' } else { '2099-09-05T10:06:00Z' })
        completedAtUtc=$(if ($toDyson) { '2099-09-05T10:04:00Z' } else { '2099-09-05T10:07:00Z' })
    }
}

function New-SelfTestHealth {
    param([Parameter(Mandatory)][ValidateSet('dyson-control','gsmanager')][string]$Authority)
    return [pscustomobject][ordered]@{
        protocol='DYSON_REVERSIBLE_CUTOVER_HEALTH_OBSERVATION_V2'; schemaVersion=2
        healthId=$(if ($Authority -ceq 'dyson-control') { '88888888-8888-4888-8888-888888888888' } else { 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' })
        qualificationRunId=$script:runId; targetIdentity=$script:target; controlRelease=$script:release
        subjectCommit=$script:commit; runtimePayloadSha256=$script:payload; releaseManifestSha256=$script:manifestHash
        dataRootIdentity=$script:dataRoot; saveGenerationId=$script:generation; authorityInventoryRevision=$script:inventory
        authority=$Authority
        management=[pscustomobject][ordered]@{ probeProtocol='DYSON_AUTHENTICATED_MANAGEMENT_PROBE_V2'; authenticated=$true; authorityExclusive=$true; controlPlaneState='healthy' }
        game=[pscustomobject][ordered]@{ probeProtocol='DYSON_NEBULA_GAME_PROTOCOL_HANDSHAKE_V2'; authenticatedHandshake=$true; sessionEstablished=$true; loadedSaveGenerationId=$script:generation; simulationProgressObserved=$true }
        observedAtUtc=$(if ($Authority -ceq 'dyson-control') { '2099-09-05T10:05:00Z' } else { '2099-09-05T10:08:00Z' })
    }
}

$projectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..\..'))
$dysonRoot = [IO.Path]::GetDirectoryName($projectRoot)
$tempRoot = [IO.Path]::GetFullPath((Join-Path $dysonRoot '.codex-temp'))
$fixtureRoot = Join-Path $tempRoot ('reversible-cutover-' + [guid]::NewGuid().ToString('N'))
if (-not $fixtureRoot.StartsWith($tempRoot + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) { throw 'Unsafe fixture root.' }
[IO.Directory]::CreateDirectory($fixtureRoot) | Out-Null

$script:tests = [Collections.Generic.List[string]]::new()
$script:runId = '11111111-1111-4111-8111-111111111111'
$script:target = 'sha256:' + ('1' * 64)
$script:dataRoot = 'sha256:' + ('2' * 64)
$script:generation = '22222222-2222-4222-8222-222222222222'
$script:release = '1.2.3-fixture'
$script:commit = '4' * 40
$script:payload = '3' * 64
$script:inventory = '5' * 64

try {
    $paths = @{
        release=Join-Path $fixtureRoot 'release.json'; window=Join-Path $fixtureRoot 'window.json'
        protection=Join-Path $fixtureRoot 'protection.json'; authority=Join-Path $fixtureRoot 'authority.json'
        toDyson=Join-Path $fixtureRoot 'to-dyson.json'; dysonHealth=Join-Path $fixtureRoot 'dyson-health.json'
        switchBack=Join-Path $fixtureRoot 'switch-back.json'; restoredHealth=Join-Path $fixtureRoot 'restored-health.json'
        audit=Join-Path $fixtureRoot 'audit.json'; dsv=Join-Path $fixtureRoot 'fictional-save.dsv'
        server=Join-Path $fixtureRoot 'fictional-save.server'; observation=Join-Path $fixtureRoot 'observation.json'
    }
    [IO.File]::WriteAllBytes($paths.dsv, [Text.Encoding]::UTF8.GetBytes('fictional-dsv-payload-v2'))
    [IO.File]::WriteAllBytes($paths.server, [Text.Encoding]::UTF8.GetBytes('fictional-server-payload-v2'))
    $pair = Get-ReversibleCutoverPairSnapshot $paths.dsv $paths.server
    $releaseManifest = [pscustomobject][ordered]@{
        protocol='DYSON_CONTROL_RUNTIME_RELEASE_MANIFEST_V2'; schemaVersion=2; qualificationRunId=$script:runId
        targetIdentity=$script:target; controlRelease=$script:release; subjectCommit=$script:commit
        runtimePayloadSha256=$script:payload; createdAtUtc='2099-09-05T09:50:00Z'
    }
    Write-SelfTestJson $paths.release $releaseManifest
    $script:manifestHash = Get-ReversibleCutoverSha256File $paths.release
    $window = [pscustomobject][ordered]@{
        protocol='DYSON_APPROVED_MAINTENANCE_WINDOW_V2'; schemaVersion=2
        approvalId='33333333-3333-4333-8333-333333333333'; windowId='44444444-4444-4444-8444-444444444444'
        qualificationRunId=$script:runId; targetIdentity=$script:target; controlRelease=$script:release
        subjectCommit=$script:commit; runtimePayloadSha256=$script:payload; releaseManifestSha256=$script:manifestHash
        startsAtUtc='2099-09-05T10:00:00Z'; endsAtUtc='2099-09-05T12:00:00Z'; approvedAtUtc='2099-09-05T09:55:00Z'; state='approved'
    }
    $protection = [pscustomobject][ordered]@{
        protocol='DYSON_CONTROL_PAIRED_SAVE_PROTECTION_POINT_V2'; schemaVersion=2
        protectionPointId='55555555-5555-4555-8555-555555555555'; qualificationRunId=$script:runId
        targetIdentity=$script:target; dataRootIdentity=$script:dataRoot; saveGenerationId=$script:generation
        dsvLength=$pair.dsvLength; dsvSha256=$pair.dsvSha256; serverLength=$pair.serverLength
        serverSha256=$pair.serverSha256; pairSha256=$pair.pairSha256
        createdAtUtc='2099-09-05T10:01:00Z'; expiresAtUtc='2099-09-05T12:00:00Z'
    }
    $authority = [pscustomobject][ordered]@{
        protocol='DYSON_REVERSIBLE_CUTOVER_GSMANAGER_AUTHORITY_SNAPSHOT_V2'; schemaVersion=2
        snapshotId='66666666-6666-4666-8666-666666666666'; qualificationRunId=$script:runId
        targetIdentity=$script:target; dataRootIdentity=$script:dataRoot; saveGenerationId=$script:generation
        authorityProfileProtocol='DYSON_GSMANAGER_AUTHORITY_PROFILE_V1'; authorityInventoryRevision=$script:inventory
        runtimeOwner='gsmanager'; capturedAtUtc='2099-09-05T10:02:00Z'
    }
    $toDyson = New-SelfTestSwitchReceipt 'to-dyson-control'
    $dysonHealth = New-SelfTestHealth 'dyson-control'
    $switchBack = New-SelfTestSwitchReceipt 'back-to-gsmanager'
    $restoredHealth = New-SelfTestHealth 'gsmanager'
    Write-SelfTestJson $paths.window $window; Write-SelfTestJson $paths.protection $protection
    Write-SelfTestJson $paths.authority $authority; Write-SelfTestJson $paths.toDyson $toDyson
    Write-SelfTestJson $paths.dysonHealth $dysonHealth; Write-SelfTestJson $paths.switchBack $switchBack
    Write-SelfTestJson $paths.restoredHealth $restoredHealth
    $auditHashes = @(
        (Get-ReversibleCutoverSha256File $paths.protection),(Get-ReversibleCutoverSha256File $paths.authority),
        (Get-ReversibleCutoverSha256File $paths.toDyson),(Get-ReversibleCutoverSha256File $paths.dysonHealth),
        (Get-ReversibleCutoverSha256File $paths.switchBack),(Get-ReversibleCutoverSha256File $paths.restoredHealth),$pair.pairSha256
    )
    $events = @('protection-point-verified','gsmanager-authority-captured','switched-to-dyson-control','dyson-control-health-verified','switched-back-to-gsmanager','gsmanager-health-verified','paired-save-integrity-verified')
    $authorities = @('gsmanager','gsmanager','dyson-control','dyson-control','transition','gsmanager','gsmanager')
    $times = @('2099-09-05T10:01:00Z','2099-09-05T10:02:00Z','2099-09-05T10:04:00Z','2099-09-05T10:05:00Z','2099-09-05T10:07:00Z','2099-09-05T10:08:00Z','2099-09-05T10:09:00Z')
    $entries = for($i=0;$i -lt 7;$i++){ [pscustomobject][ordered]@{ sequence=$i+1; event=$events[$i]; authority=$authorities[$i]; evidenceSha256=$auditHashes[$i]; observedAtUtc=$times[$i] } }
    $audit = [pscustomobject][ordered]@{
        protocol='DYSON_REVERSIBLE_CUTOVER_AUDIT_V2'; schemaVersion=2; qualificationRunId=$script:runId
        targetIdentity=$script:target; dataRootIdentity=$script:dataRoot; saveGenerationId=$script:generation; entries=@($entries)
    }
    Write-SelfTestJson $paths.audit $audit

    $base = @{
        MaintenanceWindowFile=$paths.window; ReleaseManifestFile=$paths.release; ProtectionPointFile=$paths.protection
        AuthoritySnapshotFile=$paths.authority; SwitchToDysonReceiptFile=$paths.toDyson; DysonHealthFile=$paths.dysonHealth
        SwitchBackReceiptFile=$paths.switchBack; RestoredHealthFile=$paths.restoredHealth; AuditFile=$paths.audit
        DsvPath=$paths.dsv; ServerPath=$paths.server; ExpectedApprovalId=$window.approvalId; ExpectedWindowId=$window.windowId
        ExpectedQualificationRunId=$script:runId; ExpectedTargetIdentity=$script:target; ExpectedControlRelease=$script:release
        ExpectedSubjectCommit=$script:commit; ExpectedRuntimePayloadSha256=$script:payload
        ExpectedReleaseManifestSha256=$script:manifestHash; ObservedAtUtc='2099-09-05T10:09:00Z'; ExpiresAtUtc='2099-09-05T11:00:00Z'
    }
    [void](New-ReversibleCutoverObservation @base)
    $createArgs = @{} + $base; $createArgs.OutputPath = $paths.observation
    $created = Invoke-SelfTestScript (Join-Path $PSScriptRoot 'New-DysonQualificationReversibleCutoverObservationV2.ps1') $createArgs
    Assert-SelfTest ($created.exitCode -eq 0 -and (Test-Path -LiteralPath $paths.observation)) ('create wrapper failed: ' + $created.stdout + ' ' + $created.stderr)
    $script:tests.Add('create-new-wrapper')
    $validateArgs = @{} + $base; $validateArgs.ObservationFile = $paths.observation
    $validated = Invoke-SelfTestScript (Join-Path $PSScriptRoot 'Test-DysonQualificationReversibleCutoverObservationV2.ps1') $validateArgs
    $validatedJson = $validated.stdout | ConvertFrom-Json
    Assert-SelfTest ($validated.exitCode -eq 0 -and $validatedJson.ok -eq $true -and $validatedJson.networkTouched -eq $false -and $validatedJson.productionChanged -eq $false) ('validator wrapper failed: ' + $validated.stdout + ' ' + $validated.stderr)
    $script:tests.Add('read-only-validator')

    $generic = [pscustomobject][ordered]@{ status='healthy'; httpStatus=200; tcpOpen=$true }
    Write-SelfTestJson $paths.dysonHealth $generic
    Assert-SelfTestRejected { New-ReversibleCutoverObservation @base } 'DYSON_REVERSIBLE_CUTOVER_OBSERVATION_INVALID' 'generic-http-tcp-status-rejected'
    Write-SelfTestJson $paths.dysonHealth $dysonHealth

    $mixedRun = Copy-SelfTestObject $restoredHealth; $mixedRun.qualificationRunId='dddddddd-dddd-4ddd-8ddd-dddddddddddd'; Write-SelfTestJson $paths.restoredHealth $mixedRun
    Assert-SelfTestRejected { New-ReversibleCutoverObservation @base } 'DYSON_REVERSIBLE_CUTOVER_BINDING_MISMATCH' 'cross-run-splice-rejected'
    Write-SelfTestJson $paths.restoredHealth $restoredHealth

    $mixedTarget = Copy-SelfTestObject $switchBack; $mixedTarget.targetIdentity='sha256:' + ('6'*64); Write-SelfTestJson $paths.switchBack $mixedTarget
    Assert-SelfTestRejected { New-ReversibleCutoverObservation @base } 'DYSON_REVERSIBLE_CUTOVER_BINDING_MISMATCH' 'cross-target-splice-rejected'
    Write-SelfTestJson $paths.switchBack $switchBack

    $mixedRelease = Copy-SelfTestObject $dysonHealth; $mixedRelease.controlRelease='9.9.9-fictional'; Write-SelfTestJson $paths.dysonHealth $mixedRelease
    Assert-SelfTestRejected { New-ReversibleCutoverObservation @base } 'DYSON_REVERSIBLE_CUTOVER_BINDING_MISMATCH' 'cross-release-splice-rejected'
    Write-SelfTestJson $paths.dysonHealth $dysonHealth

    $mixedSave = Copy-SelfTestObject $restoredHealth; $mixedSave.saveGenerationId='eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'; Write-SelfTestJson $paths.restoredHealth $mixedSave
    Assert-SelfTestRejected { New-ReversibleCutoverObservation @base } 'DYSON_REVERSIBLE_CUTOVER_SAVE_BINDING_MISMATCH' 'cross-save-generation-splice-rejected'
    Write-SelfTestJson $paths.restoredHealth $restoredHealth

    $mixedDataRoot = Copy-SelfTestObject $restoredHealth; $mixedDataRoot.dataRootIdentity='sha256:' + ('7'*64); Write-SelfTestJson $paths.restoredHealth $mixedDataRoot
    Assert-SelfTestRejected { New-ReversibleCutoverObservation @base } 'DYSON_REVERSIBLE_CUTOVER_SAVE_BINDING_MISMATCH' 'cross-data-root-splice-rejected'
    Write-SelfTestJson $paths.restoredHealth $restoredHealth

    $oneWay = Copy-SelfTestObject $switchBack; $oneWay.state='failed'; Write-SelfTestJson $paths.switchBack $oneWay
    Assert-SelfTestRejected { New-ReversibleCutoverObservation @base } 'DYSON_REVERSIBLE_CUTOVER_RECEIPT_INVALID' 'one-way-success-rejected'
    Write-SelfTestJson $paths.switchBack $switchBack

    $notPersisted = Copy-SelfTestObject $switchBack; $notPersisted.persisted=$false; Write-SelfTestJson $paths.switchBack $notPersisted
    Assert-SelfTestRejected { New-ReversibleCutoverObservation @base } 'DYSON_REVERSIBLE_CUTOVER_RECEIPT_INVALID' 'non-persisted-receipt-rejected'
    Write-SelfTestJson $paths.switchBack $switchBack

    $missingArgs = @{} + $base; $missingArgs.ServerPath=Join-Path $fixtureRoot 'missing.server'
    Assert-SelfTestRejected { New-ReversibleCutoverObservation @missingArgs } 'DYSON_REVERSIBLE_CUTOVER_SAVE_PAIR_INVALID' 'single-file-save-rejected'

    [IO.File]::AppendAllText($paths.server, 'drift', [Text.UTF8Encoding]::new($false))
    Assert-SelfTestRejected { New-ReversibleCutoverObservation @base } 'DYSON_REVERSIBLE_CUTOVER_NO_LOSS_INVALID' 'save-hash-drift-rejected'
    [IO.File]::WriteAllBytes($paths.server, [Text.Encoding]::UTF8.GetBytes('fictional-server-payload-v2'))

    $badAudit = Copy-SelfTestObject $audit; $badAudit.entries[4].sequence=4; Write-SelfTestJson $paths.audit $badAudit
    Assert-SelfTestRejected { New-ReversibleCutoverObservation @base } 'DYSON_REVERSIBLE_CUTOVER_AUDIT_INVALID' 'audit-sequence-rejected'
    Write-SelfTestJson $paths.audit $audit

    $badAuditTime = Copy-SelfTestObject $audit; $badAuditTime.entries[4].observedAtUtc='2099-09-05T10:04:30Z'; Write-SelfTestJson $paths.audit $badAuditTime
    Assert-SelfTestRejected { New-ReversibleCutoverObservation @base } 'DYSON_REVERSIBLE_CUTOVER_AUDIT_INVALID' 'audit-time-order-rejected'
    Write-SelfTestJson $paths.audit $audit

    $staleArgs = @{} + $base; $staleArgs.ExpiresAtUtc='2000-01-01T00:00:00Z'
    Assert-SelfTestRejected { New-ReversibleCutoverObservation @staleArgs } 'DYSON_REVERSIBLE_CUTOVER_TIME_ORDER_INVALID' 'expired-observation-rejected'

    $tampered = Read-ReversibleCutoverJson $paths.observation
    $tampered.release.controlRelease='9.9.9-fictional'
    $withoutDigest=[ordered]@{}; foreach($property in $tampered.PSObject.Properties){ if($property.Name -cne 'observationSha256'){ $withoutDigest[$property.Name]=$property.Value } }
    $tampered.observationSha256=Get-ReversibleCutoverSha256Text (([pscustomobject]$withoutDigest | ConvertTo-Json -Depth 12 -Compress))
    Write-SelfTestJson $paths.observation $tampered
    Assert-SelfTestRejected { Test-ReversibleCutoverObservation -ObservationFile $paths.observation -SourceArguments $base } 'DYSON_REVERSIBLE_CUTOVER_OBSERVATION_MISMATCH' 'recomputed-summary-tamper-rejected'

    [pscustomobject][ordered]@{
        ok=$true; protocol='DYSON_REVERSIBLE_CUTOVER_OBSERVATION_V2'; tests=@($script:tests); testCount=$script:tests.Count
        cut002='not-started'; networkTouched=$false; productionChanged=$false
    } | ConvertTo-Json -Depth 5 -Compress
    exit 0
}
catch {
    [pscustomobject][ordered]@{ ok=$false; error=[string]$_.Exception.Message; tests=@($script:tests); networkTouched=$false; productionChanged=$false } | ConvertTo-Json -Depth 5 -Compress
    exit 1
}
finally {
    if (Test-Path -LiteralPath $fixtureRoot) { Remove-Item -LiteralPath $fixtureRoot -Recurse -Force -ErrorAction SilentlyContinue }
}
