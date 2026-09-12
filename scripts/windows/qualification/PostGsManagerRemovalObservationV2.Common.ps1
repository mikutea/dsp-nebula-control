# Copyright (c) Dyson Control contributors.
# Strict, read-only post-GSManager-removal acceptance observation v2.

Set-StrictMode -Version 2.0
if ($null -eq (Get-Command -Name Get-DysonQualificationV2ObjectDigest -ErrorAction SilentlyContinue)) { . (Join-Path $PSScriptRoot 'Qualification.ProtocolV2.ps1') }

$script:DysonPostRemovalV2Protocol = 'DYSON_POST_GSMANAGER_REMOVAL_OBSERVATION_V2'
$script:DysonPostRemovalV2InputProtocol = 'DYSON_POST_GSMANAGER_REMOVAL_OBSERVATION_INPUT_V2'
$script:DysonPostRemovalV2MaximumBytes = [int64](2MB)

function New-DysonPostRemovalV2Exception {
    param([Parameter(Mandatory)][string]$Code)
    $exception = New-Object System.InvalidOperationException($Code)
    $exception.Data['Code'] = $Code
    return $exception
}
function Throw-DysonPostRemovalV2Error { param([Parameter(Mandatory)][string]$Code) throw (New-DysonPostRemovalV2Exception -Code $Code) }
function Get-DysonPostRemovalV2ErrorCode {
    param([Parameter(Mandatory)][System.Exception]$Exception)
    if ($Exception.Data.Contains('Code')) { return [string]$Exception.Data['Code'] }
    if ([string]$Exception.Message -cmatch '(DYSON_POST_GSMANAGER_REMOVAL_OBSERVATION_V2_[A-Z0-9_]+)') { return [string]$Matches[1] }
    return 'DYSON_POST_GSMANAGER_REMOVAL_OBSERVATION_V2_UNEXPECTED_FAILURE'
}
function Assert-DysonPostRemovalV2Exact {
    param([Parameter(Mandatory)]$Value,[Parameter(Mandatory)][string[]]$Names,[Parameter(Mandatory)][string]$Code)
    try { Assert-DysonQualificationV2ExactProperties -Value $Value -Names $Names -Code $Code }
    catch { Throw-DysonPostRemovalV2Error -Code $Code }
}
function Test-DysonPostRemovalV2Integer {
    param([AllowNull()]$Value,[int64]$Minimum,[int64]$Maximum)
    if (-not (Test-DysonQualificationV2Integer -Value $Value)) { return $false }
    return [int64]$Value -ge $Minimum -and [int64]$Value -le $Maximum
}
function Test-DysonPostRemovalV2Hostname {
    param([AllowNull()][string]$Value)
    return -not [string]::IsNullOrWhiteSpace($Value) -and $Value.Length -le 253 -and $Value -ceq $Value.ToLowerInvariant() -and $Value -cmatch '^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$'
}
function ConvertFrom-DysonPostRemovalV2Utc {
    param([Parameter(Mandatory)][string]$Value,[Parameter(Mandatory)][string]$Code)
    try { return ConvertFrom-DysonQualificationV2Utc -Value $Value -Code $Code }
    catch { Throw-DysonPostRemovalV2Error -Code $Code }
}
function Get-DysonPostRemovalV2UnsignedValue {
    param([Parameter(Mandatory)]$Value,[Parameter(Mandatory)][string]$ExcludedName)
    $result = [ordered]@{}
    foreach ($property in @($Value.PSObject.Properties | Where-Object { [string]$_.Name -cne $ExcludedName } | Sort-Object -Property Name -CaseSensitive)) { $result[[string]$property.Name] = $property.Value }
    return [pscustomobject]$result
}
function Get-DysonPostRemovalV2Digest {
    param([Parameter(Mandatory)]$Observation)
    return Get-DysonQualificationV2ObjectDigest -Value (Get-DysonPostRemovalV2UnsignedValue -Value $Observation -ExcludedName 'observationSha256')
}
function Get-DysonPostRemovalV2InventoryDigest {
    param([Parameter(Mandatory)]$Inventory)
    return Get-DysonQualificationV2ObjectDigest -Value (Get-DysonPostRemovalV2UnsignedValue -Value $Inventory -ExcludedName 'inventorySha256')
}
function Get-DysonPostRemovalV2SubjectBindingDigest {
    param([Parameter(Mandatory)]$Value)
    return Get-DysonQualificationV2ObjectDigest -Value ([ordered]@{
        domain = 'DYSON_POST_GSMANAGER_REMOVAL_OBSERVATION_V2_SUBJECT'
        runId = [string]$Value.runId
        targetIdentity = [string]$Value.targetIdentity
        releaseVersion = [string]$Value.releaseIdentity.releaseVersion
        subjectCommit = [string]$Value.releaseIdentity.subjectCommit
        runtimePayloadSha256 = [string]$Value.releaseIdentity.runtimePayloadSha256
        releaseManifestSha256 = [string]$Value.releaseIdentity.releaseManifestSha256
    })
}
function Copy-DysonPostRemovalV2Value {
    param([Parameter(Mandatory)]$Value)
    return (ConvertTo-DysonQualificationV2CanonicalJson -Value $Value) | ConvertFrom-Json
}
function Add-DysonPostRemovalV2SubjectBinding {
    param([Parameter(Mandatory)]$Value,[Parameter(Mandatory)][string]$SubjectBindingSha256)
    $copy = Copy-DysonPostRemovalV2Value -Value $Value
    $copy | Add-Member -NotePropertyName subjectBindingSha256 -NotePropertyValue $SubjectBindingSha256
    return $copy
}

function Assert-DysonPostRemovalV2Input {
    param([Parameter(Mandatory)]$InputValue)
    $code = 'DYSON_POST_GSMANAGER_REMOVAL_OBSERVATION_V2_INPUT_INVALID'
    Assert-DysonPostRemovalV2Exact -Value $InputValue -Names @('protocol','schemaVersion','observationId','runId','targetIdentity','releaseIdentity','cutoverObservation','removalReceipt','observationWindow','inventory','management','game','reboot','save','recoveryPackage','deliverables','observedAtUtc','expiresAtUtc') -Code $code
    if ([string]$InputValue.protocol -cne $script:DysonPostRemovalV2InputProtocol -or -not (Test-DysonPostRemovalV2Integer -Value $InputValue.schemaVersion -Minimum 2 -Maximum 2)) { Throw-DysonPostRemovalV2Error -Code $code }
}

function New-DysonPostGsManagerRemovalObservationV2 {
    param([Parameter(Mandatory)]$InputValue)
    Assert-DysonPostRemovalV2Input -InputValue $InputValue
    $subjectBindingSha256 = Get-DysonPostRemovalV2SubjectBindingDigest -Value $InputValue
    $inventory = Add-DysonPostRemovalV2SubjectBinding -Value $InputValue.inventory -SubjectBindingSha256 $subjectBindingSha256
    $inventory | Add-Member -NotePropertyName inventorySha256 -NotePropertyValue $null
    $inventory.inventorySha256 = Get-DysonPostRemovalV2InventoryDigest -Inventory $inventory
    $observation = [pscustomobject][ordered]@{
        protocol = $script:DysonPostRemovalV2Protocol
        schemaVersion = 2
        observationId = [string]$InputValue.observationId
        runId = [string]$InputValue.runId
        targetIdentity = [string]$InputValue.targetIdentity
        releaseIdentity = $InputValue.releaseIdentity
        subjectBindingSha256 = $subjectBindingSha256
        cutoverObservation = Add-DysonPostRemovalV2SubjectBinding -Value $InputValue.cutoverObservation -SubjectBindingSha256 $subjectBindingSha256
        removalReceipt = Add-DysonPostRemovalV2SubjectBinding -Value $InputValue.removalReceipt -SubjectBindingSha256 $subjectBindingSha256
        observationWindow = Add-DysonPostRemovalV2SubjectBinding -Value $InputValue.observationWindow -SubjectBindingSha256 $subjectBindingSha256
        inventory = $inventory
        management = Add-DysonPostRemovalV2SubjectBinding -Value $InputValue.management -SubjectBindingSha256 $subjectBindingSha256
        game = Add-DysonPostRemovalV2SubjectBinding -Value $InputValue.game -SubjectBindingSha256 $subjectBindingSha256
        reboot = Add-DysonPostRemovalV2SubjectBinding -Value $InputValue.reboot -SubjectBindingSha256 $subjectBindingSha256
        save = Add-DysonPostRemovalV2SubjectBinding -Value $InputValue.save -SubjectBindingSha256 $subjectBindingSha256
        recoveryPackage = Add-DysonPostRemovalV2SubjectBinding -Value $InputValue.recoveryPackage -SubjectBindingSha256 $subjectBindingSha256
        deliverables = Add-DysonPostRemovalV2SubjectBinding -Value $InputValue.deliverables -SubjectBindingSha256 $subjectBindingSha256
        observedAtUtc = [string]$InputValue.observedAtUtc
        expiresAtUtc = [string]$InputValue.expiresAtUtc
        observationSha256 = $null
    }
    $observation.observationSha256 = Get-DysonPostRemovalV2Digest -Observation $observation
    return $observation
}

function Assert-DysonPostRemovalV2BoundGroup {
    param([Parameter(Mandatory)]$Value,[Parameter(Mandatory)][string]$ExpectedSubjectBindingSha256,[Parameter(Mandatory)][string]$Code)
    if ([string]$Value.subjectBindingSha256 -cne $ExpectedSubjectBindingSha256) { Throw-DysonPostRemovalV2Error -Code $Code }
}
function Assert-DysonPostRemovalV2WindowTime {
    param([Parameter(Mandatory)][string]$Value,[Parameter(Mandatory)][datetimeoffset]$Started,[Parameter(Mandatory)][datetimeoffset]$Completed,[Parameter(Mandatory)][string]$Code)
    $time = ConvertFrom-DysonPostRemovalV2Utc -Value $Value -Code $Code
    if ($time -lt $Started -or $time -gt $Completed) { Throw-DysonPostRemovalV2Error -Code $Code }
    return $time
}

function Assert-DysonPostGsManagerRemovalObservationV2 {
    param(
        [Parameter(Mandatory)]$Observation,
        [AllowNull()][string]$ExpectedObservationId,
        [AllowNull()][string]$ExpectedRunId,
        [AllowNull()][string]$ExpectedTargetIdentity,
        [AllowNull()][string]$ExpectedReleaseVersion,
        [AllowNull()][string]$ExpectedSubjectCommit,
        [AllowNull()][string]$ExpectedRuntimePayloadSha256,
        [AllowNull()][string]$ExpectedReleaseManifestSha256,
        [datetimeoffset]$NowUtc = [datetimeoffset]::UtcNow
    )
    $code = 'DYSON_POST_GSMANAGER_REMOVAL_OBSERVATION_V2_INVALID'
    Assert-DysonPostRemovalV2Exact -Value $Observation -Names @('protocol','schemaVersion','observationId','runId','targetIdentity','releaseIdentity','subjectBindingSha256','cutoverObservation','removalReceipt','observationWindow','inventory','management','game','reboot','save','recoveryPackage','deliverables','observedAtUtc','expiresAtUtc','observationSha256') -Code $code
    if ([string]$Observation.protocol -cne $script:DysonPostRemovalV2Protocol -or -not (Test-DysonPostRemovalV2Integer -Value $Observation.schemaVersion -Minimum 2 -Maximum 2) -or
        -not (Test-DysonQualificationV2Uuid -Value ([string]$Observation.observationId)) -or -not (Test-DysonQualificationV2Uuid -Value ([string]$Observation.runId)) -or
        [string]::IsNullOrWhiteSpace([string]$Observation.targetIdentity) -or -not (Test-DysonQualificationV2Digest -Value ([string]$Observation.subjectBindingSha256)) -or
        -not (Test-DysonQualificationV2Digest -Value ([string]$Observation.observationSha256))) { Throw-DysonPostRemovalV2Error -Code $code }

    Assert-DysonPostRemovalV2Exact -Value $Observation.releaseIdentity -Names @('releaseVersion','subjectCommit','runtimePayloadSha256','releaseManifestSha256','releaseChecksumsSha256') -Code $code
    $release = $Observation.releaseIdentity
    if ([string]$release.releaseVersion -cnotmatch '^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$' -or [string]$release.subjectCommit -cnotmatch '^[0-9a-f]{40}$') { Throw-DysonPostRemovalV2Error -Code 'DYSON_POST_GSMANAGER_REMOVAL_OBSERVATION_V2_RELEASE_INVALID' }
    foreach ($name in @('runtimePayloadSha256','releaseManifestSha256','releaseChecksumsSha256')) { if (-not (Test-DysonQualificationV2Digest -Value ([string]$release.$name))) { Throw-DysonPostRemovalV2Error -Code 'DYSON_POST_GSMANAGER_REMOVAL_OBSERVATION_V2_RELEASE_INVALID' } }
    $subjectBinding = Get-DysonPostRemovalV2SubjectBindingDigest -Value $Observation
    if ([string]$Observation.subjectBindingSha256 -cne $subjectBinding) { Throw-DysonPostRemovalV2Error -Code 'DYSON_POST_GSMANAGER_REMOVAL_OBSERVATION_V2_SUBJECT_INVALID' }
    foreach ($binding in @(
        @($ExpectedObservationId,[string]$Observation.observationId),@($ExpectedRunId,[string]$Observation.runId),@($ExpectedTargetIdentity,[string]$Observation.targetIdentity),
        @($ExpectedReleaseVersion,[string]$release.releaseVersion),@($ExpectedSubjectCommit,[string]$release.subjectCommit),@($ExpectedRuntimePayloadSha256,[string]$release.runtimePayloadSha256),
        @($ExpectedReleaseManifestSha256,[string]$release.releaseManifestSha256))) {
        if (-not [string]::IsNullOrWhiteSpace([string]$binding[0]) -and [string]$binding[0] -cne [string]$binding[1]) { Throw-DysonPostRemovalV2Error -Code 'DYSON_POST_GSMANAGER_REMOVAL_OBSERVATION_V2_BINDING_INVALID' }
    }

    Assert-DysonPostRemovalV2Exact -Value $Observation.cutoverObservation -Names @('observationId','observationSha256','qualified','observedAtUtc','subjectBindingSha256') -Code $code
    $cutover = $Observation.cutoverObservation
    Assert-DysonPostRemovalV2BoundGroup -Value $cutover -ExpectedSubjectBindingSha256 $subjectBinding -Code 'DYSON_POST_GSMANAGER_REMOVAL_OBSERVATION_V2_CUTOVER_INVALID'
    if (-not (Test-DysonQualificationV2Uuid -Value ([string]$cutover.observationId)) -or -not (Test-DysonQualificationV2Digest -Value ([string]$cutover.observationSha256)) -or $cutover.qualified -isnot [bool] -or -not [bool]$cutover.qualified) { Throw-DysonPostRemovalV2Error -Code 'DYSON_POST_GSMANAGER_REMOVAL_OBSERVATION_V2_CUTOVER_INVALID' }

    Assert-DysonPostRemovalV2Exact -Value $Observation.removalReceipt -Names @('receiptId','receiptSha256','outcome','completedAtUtc','subjectBindingSha256') -Code $code
    $removal = $Observation.removalReceipt
    Assert-DysonPostRemovalV2BoundGroup -Value $removal -ExpectedSubjectBindingSha256 $subjectBinding -Code 'DYSON_POST_GSMANAGER_REMOVAL_OBSERVATION_V2_REMOVAL_INVALID'
    if (-not (Test-DysonQualificationV2Uuid -Value ([string]$removal.receiptId)) -or -not (Test-DysonQualificationV2Digest -Value ([string]$removal.receiptSha256)) -or [string]$removal.outcome -cne 'removed') { Throw-DysonPostRemovalV2Error -Code 'DYSON_POST_GSMANAGER_REMOVAL_OBSERVATION_V2_REMOVAL_INVALID' }

    Assert-DysonPostRemovalV2Exact -Value $Observation.observationWindow -Names @('windowId','observerClass','independent','startedAtUtc','completedAtUtc','elapsedMonotonicSeconds','subjectBindingSha256') -Code $code
    $window = $Observation.observationWindow
    Assert-DysonPostRemovalV2BoundGroup -Value $window -ExpectedSubjectBindingSha256 $subjectBinding -Code 'DYSON_POST_GSMANAGER_REMOVAL_OBSERVATION_V2_WINDOW_INVALID'
    $started = ConvertFrom-DysonPostRemovalV2Utc -Value ([string]$window.startedAtUtc) -Code 'DYSON_POST_GSMANAGER_REMOVAL_OBSERVATION_V2_WINDOW_INVALID'
    $completed = ConvertFrom-DysonPostRemovalV2Utc -Value ([string]$window.completedAtUtc) -Code 'DYSON_POST_GSMANAGER_REMOVAL_OBSERVATION_V2_WINDOW_INVALID'
    if (-not (Test-DysonQualificationV2Uuid -Value ([string]$window.windowId)) -or [string]$window.observerClass -cne 'independent-operator' -or $window.independent -isnot [bool] -or -not [bool]$window.independent -or
        -not (Test-DysonPostRemovalV2Integer -Value $window.elapsedMonotonicSeconds -Minimum 3600 -Maximum 604800) -or $completed -le $started -or
        [Math]::Abs(($completed-$started).TotalSeconds-[int64]$window.elapsedMonotonicSeconds) -gt 5) { Throw-DysonPostRemovalV2Error -Code 'DYSON_POST_GSMANAGER_REMOVAL_OBSERVATION_V2_WINDOW_INVALID' }
    $cutoverAt = ConvertFrom-DysonPostRemovalV2Utc -Value ([string]$cutover.observedAtUtc) -Code 'DYSON_POST_GSMANAGER_REMOVAL_OBSERVATION_V2_TIMING_INVALID'
    $removedAt = ConvertFrom-DysonPostRemovalV2Utc -Value ([string]$removal.completedAtUtc) -Code 'DYSON_POST_GSMANAGER_REMOVAL_OBSERVATION_V2_TIMING_INVALID'
    if ($cutoverAt -gt $removedAt -or $removedAt -gt $started) { Throw-DysonPostRemovalV2Error -Code 'DYSON_POST_GSMANAGER_REMOVAL_OBSERVATION_V2_TIMING_INVALID' }

    Assert-DysonPostRemovalV2Exact -Value $Observation.inventory -Names @('installationCount','scheduledTaskCount','serviceCount','listeningPortCount','processCount','scannedAtUtc','subjectBindingSha256','inventorySha256') -Code $code
    $inventory = $Observation.inventory
    Assert-DysonPostRemovalV2BoundGroup -Value $inventory -ExpectedSubjectBindingSha256 $subjectBinding -Code 'DYSON_POST_GSMANAGER_REMOVAL_OBSERVATION_V2_INVENTORY_INVALID'
    foreach ($name in @('installationCount','scheduledTaskCount','serviceCount','listeningPortCount','processCount')) { if (-not (Test-DysonPostRemovalV2Integer -Value $inventory.$name -Minimum 0 -Maximum 0)) { Throw-DysonPostRemovalV2Error -Code 'DYSON_POST_GSMANAGER_REMOVAL_OBSERVATION_V2_RESIDUAL_AUTHORITY' } }
    if ([string]$inventory.inventorySha256 -cne (Get-DysonPostRemovalV2InventoryDigest -Inventory $inventory)) { Throw-DysonPostRemovalV2Error -Code 'DYSON_POST_GSMANAGER_REMOVAL_OBSERVATION_V2_DIGEST_INVALID' }
    $inventoryAt = Assert-DysonPostRemovalV2WindowTime -Value ([string]$inventory.scannedAtUtc) -Started $started -Completed $completed -Code 'DYSON_POST_GSMANAGER_REMOVAL_OBSERVATION_V2_TIMING_INVALID'

    Assert-DysonPostRemovalV2Exact -Value $Observation.management -Names @('panelOriginAddress','panelOriginPort','loopbackOnly','publicHost','externalTlsVerified','authenticatedPanelVerified','tlsReceiptSha256','authenticatedPanelReceiptSha256','observedAtUtc','subjectBindingSha256') -Code $code
    $management = $Observation.management
    Assert-DysonPostRemovalV2BoundGroup -Value $management -ExpectedSubjectBindingSha256 $subjectBinding -Code 'DYSON_POST_GSMANAGER_REMOVAL_OBSERVATION_V2_MANAGEMENT_INVALID'
    if (@('127.0.0.1','::1') -cnotcontains [string]$management.panelOriginAddress -or -not (Test-DysonPostRemovalV2Integer -Value $management.panelOriginPort -Minimum 1 -Maximum 65535) -or
        $management.loopbackOnly -isnot [bool] -or -not [bool]$management.loopbackOnly -or -not (Test-DysonPostRemovalV2Hostname -Value ([string]$management.publicHost)) -or
        $management.externalTlsVerified -isnot [bool] -or -not [bool]$management.externalTlsVerified -or $management.authenticatedPanelVerified -isnot [bool] -or -not [bool]$management.authenticatedPanelVerified -or
        -not (Test-DysonQualificationV2Digest -Value ([string]$management.tlsReceiptSha256)) -or -not (Test-DysonQualificationV2Digest -Value ([string]$management.authenticatedPanelReceiptSha256))) { Throw-DysonPostRemovalV2Error -Code 'DYSON_POST_GSMANAGER_REMOVAL_OBSERVATION_V2_MANAGEMENT_INVALID' }
    $managementAt = Assert-DysonPostRemovalV2WindowTime -Value ([string]$management.observedAtUtc) -Started $started -Completed $completed -Code 'DYSON_POST_GSMANAGER_REMOVAL_OBSERVATION_V2_TIMING_INVALID'

    Assert-DysonPostRemovalV2Exact -Value $Observation.game -Names @('publicHost','protocol','serverAuthoritativeJoin','serverAuthoritativeReconnect','reachabilityOnly','joinReceiptSha256','reconnectReceiptSha256','worldBindingSha256','savePairSha256','observedAtUtc','subjectBindingSha256') -Code $code
    $game = $Observation.game
    Assert-DysonPostRemovalV2BoundGroup -Value $game -ExpectedSubjectBindingSha256 $subjectBinding -Code 'DYSON_POST_GSMANAGER_REMOVAL_OBSERVATION_V2_GAME_INVALID'
    if (-not (Test-DysonPostRemovalV2Hostname -Value ([string]$game.publicHost)) -or [string]$game.protocol -cne 'nebula' -or
        $game.serverAuthoritativeJoin -isnot [bool] -or -not [bool]$game.serverAuthoritativeJoin -or $game.serverAuthoritativeReconnect -isnot [bool] -or -not [bool]$game.serverAuthoritativeReconnect -or
        $game.reachabilityOnly -isnot [bool] -or [bool]$game.reachabilityOnly) { Throw-DysonPostRemovalV2Error -Code 'DYSON_POST_GSMANAGER_REMOVAL_OBSERVATION_V2_GAME_INVALID' }
    foreach ($name in @('joinReceiptSha256','reconnectReceiptSha256','worldBindingSha256','savePairSha256')) { if (-not (Test-DysonQualificationV2Digest -Value ([string]$game.$name))) { Throw-DysonPostRemovalV2Error -Code 'DYSON_POST_GSMANAGER_REMOVAL_OBSERVATION_V2_GAME_INVALID' } }
    $gameAt = Assert-DysonPostRemovalV2WindowTime -Value ([string]$game.observedAtUtc) -Started $started -Completed $completed -Code 'DYSON_POST_GSMANAGER_REMOVAL_OBSERVATION_V2_TIMING_INVALID'

    Assert-DysonPostRemovalV2Exact -Value $Observation.reboot -Names @('checkpointSha256','resumeReceiptSha256','newBootObserved','runtimeRecovered','savePairSha256','observedAtUtc','subjectBindingSha256') -Code $code
    $reboot = $Observation.reboot
    Assert-DysonPostRemovalV2BoundGroup -Value $reboot -ExpectedSubjectBindingSha256 $subjectBinding -Code 'DYSON_POST_GSMANAGER_REMOVAL_OBSERVATION_V2_REBOOT_INVALID'
    if ($reboot.newBootObserved -isnot [bool] -or -not [bool]$reboot.newBootObserved -or $reboot.runtimeRecovered -isnot [bool] -or -not [bool]$reboot.runtimeRecovered) { Throw-DysonPostRemovalV2Error -Code 'DYSON_POST_GSMANAGER_REMOVAL_OBSERVATION_V2_REBOOT_INVALID' }
    foreach ($name in @('checkpointSha256','resumeReceiptSha256','savePairSha256')) { if (-not (Test-DysonQualificationV2Digest -Value ([string]$reboot.$name))) { Throw-DysonPostRemovalV2Error -Code 'DYSON_POST_GSMANAGER_REMOVAL_OBSERVATION_V2_REBOOT_INVALID' } }
    $rebootAt = Assert-DysonPostRemovalV2WindowTime -Value ([string]$reboot.observedAtUtc) -Started $started -Completed $completed -Code 'DYSON_POST_GSMANAGER_REMOVAL_OBSERVATION_V2_TIMING_INVALID'

    Assert-DysonPostRemovalV2Exact -Value $Observation.save -Names @('saveReceiptSha256','savePairSha256','saveManifestSha256','worldBindingSha256','pairedFilesIntact','observedAtUtc','subjectBindingSha256') -Code $code
    $save = $Observation.save
    Assert-DysonPostRemovalV2BoundGroup -Value $save -ExpectedSubjectBindingSha256 $subjectBinding -Code 'DYSON_POST_GSMANAGER_REMOVAL_OBSERVATION_V2_SAVE_INVALID'
    if ($save.pairedFilesIntact -isnot [bool] -or -not [bool]$save.pairedFilesIntact) { Throw-DysonPostRemovalV2Error -Code 'DYSON_POST_GSMANAGER_REMOVAL_OBSERVATION_V2_SAVE_INVALID' }
    foreach ($name in @('saveReceiptSha256','savePairSha256','saveManifestSha256','worldBindingSha256')) { if (-not (Test-DysonQualificationV2Digest -Value ([string]$save.$name))) { Throw-DysonPostRemovalV2Error -Code 'DYSON_POST_GSMANAGER_REMOVAL_OBSERVATION_V2_SAVE_INVALID' } }
    if ([string]$game.worldBindingSha256 -cne [string]$save.worldBindingSha256 -or [string]$game.savePairSha256 -cne [string]$save.savePairSha256 -or [string]$reboot.savePairSha256 -cne [string]$save.savePairSha256) { Throw-DysonPostRemovalV2Error -Code 'DYSON_POST_GSMANAGER_REMOVAL_OBSERVATION_V2_SAVE_INVALID' }
    $saveAt = Assert-DysonPostRemovalV2WindowTime -Value ([string]$save.observedAtUtc) -Started $started -Completed $completed -Code 'DYSON_POST_GSMANAGER_REMOVAL_OBSERVATION_V2_TIMING_INVALID'

    Assert-DysonPostRemovalV2Exact -Value $Observation.recoveryPackage -Names @('bundleManifestSha256','verificationReceiptSha256','verified','activationRequired','activated','savePairSha256','observedAtUtc','subjectBindingSha256') -Code $code
    $recovery = $Observation.recoveryPackage
    Assert-DysonPostRemovalV2BoundGroup -Value $recovery -ExpectedSubjectBindingSha256 $subjectBinding -Code 'DYSON_POST_GSMANAGER_REMOVAL_OBSERVATION_V2_RECOVERY_INVALID'
    if ($recovery.verified -isnot [bool] -or -not [bool]$recovery.verified -or $recovery.activationRequired -isnot [bool] -or -not [bool]$recovery.activationRequired -or
        $recovery.activated -isnot [bool] -or [bool]$recovery.activated -or [string]$recovery.savePairSha256 -cne [string]$save.savePairSha256) { Throw-DysonPostRemovalV2Error -Code 'DYSON_POST_GSMANAGER_REMOVAL_OBSERVATION_V2_RECOVERY_INVALID' }
    foreach ($name in @('bundleManifestSha256','verificationReceiptSha256','savePairSha256')) { if (-not (Test-DysonQualificationV2Digest -Value ([string]$recovery.$name))) { Throw-DysonPostRemovalV2Error -Code 'DYSON_POST_GSMANAGER_REMOVAL_OBSERVATION_V2_RECOVERY_INVALID' } }
    $recoveryAt = Assert-DysonPostRemovalV2WindowTime -Value ([string]$recovery.observedAtUtc) -Started $started -Completed $completed -Code 'DYSON_POST_GSMANAGER_REMOVAL_OBSERVATION_V2_TIMING_INVALID'

    Assert-DysonPostRemovalV2Exact -Value $Observation.deliverables -Names @('evidenceIndexSha256','runbookSha256','knownLimitationsSha256','releaseChecksumsSha256','checksumsVerified','observedAtUtc','subjectBindingSha256') -Code $code
    $deliverables = $Observation.deliverables
    Assert-DysonPostRemovalV2BoundGroup -Value $deliverables -ExpectedSubjectBindingSha256 $subjectBinding -Code 'DYSON_POST_GSMANAGER_REMOVAL_OBSERVATION_V2_DELIVERABLES_INVALID'
    foreach ($name in @('evidenceIndexSha256','runbookSha256','knownLimitationsSha256','releaseChecksumsSha256')) { if (-not (Test-DysonQualificationV2Digest -Value ([string]$deliverables.$name))) { Throw-DysonPostRemovalV2Error -Code 'DYSON_POST_GSMANAGER_REMOVAL_OBSERVATION_V2_DELIVERABLES_INVALID' } }
    if ($deliverables.checksumsVerified -isnot [bool] -or -not [bool]$deliverables.checksumsVerified -or [string]$deliverables.releaseChecksumsSha256 -cne [string]$release.releaseChecksumsSha256) { Throw-DysonPostRemovalV2Error -Code 'DYSON_POST_GSMANAGER_REMOVAL_OBSERVATION_V2_DELIVERABLES_INVALID' }
    $deliverablesAt = Assert-DysonPostRemovalV2WindowTime -Value ([string]$deliverables.observedAtUtc) -Started $started -Completed $completed -Code 'DYSON_POST_GSMANAGER_REMOVAL_OBSERVATION_V2_TIMING_INVALID'
    $orderedEvidenceTimes = @($inventoryAt,$managementAt,$gameAt,$rebootAt,$saveAt,$recoveryAt,$deliverablesAt)
    for ($index = 1; $index -lt $orderedEvidenceTimes.Count; $index++) {
        if ($orderedEvidenceTimes[$index] -le $orderedEvidenceTimes[$index - 1]) { Throw-DysonPostRemovalV2Error -Code 'DYSON_POST_GSMANAGER_REMOVAL_OBSERVATION_V2_TIMING_INVALID' }
    }

    $observed = ConvertFrom-DysonPostRemovalV2Utc -Value ([string]$Observation.observedAtUtc) -Code $code
    $expires = ConvertFrom-DysonPostRemovalV2Utc -Value ([string]$Observation.expiresAtUtc) -Code $code
    if ([Math]::Abs(($observed-$completed).TotalSeconds) -gt 1 -or $observed -gt $NowUtc.AddMinutes(1) -or $expires -le $observed -or $expires -gt $observed.AddHours(1) -or $NowUtc -ge $expires) { Throw-DysonPostRemovalV2Error -Code 'DYSON_POST_GSMANAGER_REMOVAL_OBSERVATION_V2_STALE' }
    if ([string]$Observation.observationSha256 -cne (Get-DysonPostRemovalV2Digest -Observation $Observation)) { Throw-DysonPostRemovalV2Error -Code 'DYSON_POST_GSMANAGER_REMOVAL_OBSERVATION_V2_DIGEST_INVALID' }
    return [pscustomobject][ordered]@{ protocol=$script:DysonPostRemovalV2Protocol;observationId=[string]$Observation.observationId;runId=[string]$Observation.runId;targetIdentity=[string]$Observation.targetIdentity;releaseVersion=[string]$release.releaseVersion;subjectBindingSha256=$subjectBinding;observedAtUtc=[string]$Observation.observedAtUtc;expiresAtUtc=[string]$Observation.expiresAtUtc;observationSha256=[string]$Observation.observationSha256;qualified=$true }
}

function Assert-DysonPostRemovalV2JsonKeysUnique {
    param([Parameter(Mandatory)][System.Xml.XmlNode]$Node)
    if ($Node.NodeType -ne [System.Xml.XmlNodeType]::Element) { return }
    $typeAttribute = $Node.Attributes['type']
    if ($null -ne $typeAttribute -and [string]$typeAttribute.Value -ceq 'object') {
        $names = New-Object 'System.Collections.Generic.HashSet[string]' ([StringComparer]::Ordinal)
        foreach ($child in @($Node.ChildNodes | Where-Object { $_.NodeType -eq [System.Xml.XmlNodeType]::Element })) {
            $itemAttribute = $child.Attributes['item']; $name = if ($child.LocalName -ceq 'item' -and $child.NamespaceURI -ceq 'item' -and $null -ne $itemAttribute) { [string]$itemAttribute.Value } else { [string]$child.LocalName }
            if (-not $names.Add($name)) { Throw-DysonPostRemovalV2Error -Code 'DYSON_POST_GSMANAGER_REMOVAL_OBSERVATION_V2_DUPLICATE_JSON_KEY' }
        }
    }
    foreach ($child in @($Node.ChildNodes)) { if ($child.NodeType -eq [System.Xml.XmlNodeType]::Element) { Assert-DysonPostRemovalV2JsonKeysUnique -Node $child } }
}
function ConvertFrom-DysonPostRemovalV2StrictJson {
    param([Parameter(Mandatory)][AllowEmptyString()][string]$Text)
    $bytes=$null;$reader=$null
    try {
        Add-Type -AssemblyName System.Runtime.Serialization -ErrorAction Stop; $bytes=(New-Object System.Text.UTF8Encoding -ArgumentList $false,$true).GetBytes($Text)
        $quotas=New-Object System.Xml.XmlDictionaryReaderQuotas;$quotas.MaxDepth=64;$quotas.MaxStringContentLength=[Math]::Max(1024,$bytes.Length);$quotas.MaxArrayLength=[Math]::Max(1024,$bytes.Length);$quotas.MaxBytesPerRead=[Math]::Min([Math]::Max(4096,$bytes.Length),2097152);$quotas.MaxNameTableCharCount=[Math]::Max(16384,$bytes.Length)
        $reader=[System.Runtime.Serialization.Json.JsonReaderWriterFactory]::CreateJsonReader($bytes,$quotas);$document=New-Object System.Xml.XmlDocument;$document.PreserveWhitespace=$false;$document.Load($reader);Assert-DysonPostRemovalV2JsonKeysUnique -Node $document.DocumentElement
        return $Text | ConvertFrom-Json -ErrorAction Stop
    } catch { if ($_.Exception.Data.Contains('Code')) { throw };Throw-DysonPostRemovalV2Error -Code 'DYSON_POST_GSMANAGER_REMOVAL_OBSERVATION_V2_JSON_INVALID' } finally { if($null-ne $reader){$reader.Close()};if($null-ne $bytes){[Array]::Clear($bytes,0,$bytes.Length)} }
}
function Read-DysonPostRemovalV2JsonFile {
    param([Parameter(Mandatory)][string]$Path)
    $bytes=$null
    try { $item=Get-Item -LiteralPath $Path -Force -ErrorAction Stop;if($item.PSIsContainer -or ($item.Attributes-band[IO.FileAttributes]::ReparsePoint) -or [int64]$item.Length-le 0 -or [int64]$item.Length-gt $script:DysonPostRemovalV2MaximumBytes){throw 'invalid file'};$bytes=[IO.File]::ReadAllBytes($item.FullName);if($bytes.Length-ge 3 -and $bytes[0]-eq 0xef -and $bytes[1]-eq 0xbb -and $bytes[2]-eq 0xbf){throw 'bom'};$text=(New-Object System.Text.UTF8Encoding -ArgumentList $false,$true).GetString($bytes);return ConvertFrom-DysonPostRemovalV2StrictJson -Text $text } catch { if($_.Exception.Data.Contains('Code')){throw};Throw-DysonPostRemovalV2Error -Code 'DYSON_POST_GSMANAGER_REMOVAL_OBSERVATION_V2_FILE_INVALID' } finally { if($null-ne $bytes){[Array]::Clear($bytes,0,$bytes.Length)} }
}
