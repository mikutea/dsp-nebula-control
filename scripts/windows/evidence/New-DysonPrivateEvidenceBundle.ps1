[CmdletBinding(SupportsShouldProcess, ConfirmImpact = 'High')]
param(
    [Parameter(Mandatory)][string]$RunId,
    [Parameter(Mandatory)][string]$EvidenceId,
    [Parameter(Mandatory)][string]$Kind,
    [Parameter(Mandatory)][string]$Scope,
    [Parameter(Mandatory)][string]$SubjectCommit,
    [Parameter(Mandatory)][string]$RuntimePayloadSha256,
    [Parameter(Mandatory)][string[]]$RequirementIds,
    [string]$ObservedAt = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ss.fffZ'),
    [string]$DataRoot = (Join-Path $env:ProgramData 'DysonControl')
)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
. (Join-Path $PSScriptRoot 'DysonPrivateEvidence.Common.ps1')

$publicationStage = 'input-validation'
try {
$normalizedRunId = Assert-DysonPrivateEvidenceIdentifier -Value $RunId -Name 'RunId'
$normalizedEvidenceId = Assert-DysonPrivateEvidenceIdentifier -Value $EvidenceId -Name 'EvidenceId'
$normalizedKind = Assert-DysonPrivateEvidenceKind -Kind $Kind
$normalizedScope = Assert-DysonPrivateEvidenceScope -Scope $Scope
$normalizedCommit = Assert-DysonPrivateEvidenceCommit -Commit $SubjectCommit
$normalizedRuntimePayload = Assert-DysonPrivateEvidenceDigest -Digest $RuntimePayloadSha256 -Name 'RuntimePayloadSha256'
$normalizedRequirements = Get-DysonPrivateEvidenceRequirementIds -RequirementIds $RequirementIds
$normalizedObservedAt = ConvertTo-DysonPrivateEvidenceObservedAt -ObservedAt $ObservedAt
$dataFull = Assert-DysonPrivateEvidenceSafeRoot -Path $DataRoot -Name 'DataRoot'
Assert-DysonPrivateEvidenceNoReparseAncestors -Path $dataFull
$stagingRoot = Join-Path (Join-Path (Join-Path $dataFull 'acceptance') 'staging') $normalizedRunId
$stagingFull = Assert-DysonPrivateEvidencePlainDirectory -Path $stagingRoot
$publicationStage = 'staging-acl-validation'
[void](Assert-DysonPrivateEvidenceDirectoryAcl -Path $stagingFull)
$evidenceParent = Join-Path (Join-Path $dataFull 'acceptance') 'evidence'
$evidenceFull = Join-Path $evidenceParent $normalizedEvidenceId
Assert-DysonPrivateEvidenceNoReparseAncestors -Path $evidenceParent
if (Test-Path -LiteralPath $evidenceFull) { throw 'The private evidence publication target already exists.' }

$publicationStage = 'staging-inventory'
$sourceInventory = Get-DysonPrivateEvidenceInventory -Root $stagingFull
$preview = [ordered]@{
    protocol = $script:DysonPrivateEvidenceReferenceProtocol
    state = 'preview'
    evidenceId = $normalizedEvidenceId
    kind = $normalizedKind
    scope = $normalizedScope
    subjectCommit = $normalizedCommit
    runtimePayloadSha256 = $normalizedRuntimePayload
    opaqueId = 'private:' + $normalizedEvidenceId
    observedAt = $normalizedObservedAt
    requirementIds = $normalizedRequirements
    fileCount = [int]$sourceInventory.fileCount
    totalBytes = [int64]$sourceInventory.totalBytes
    productionChanged = $false
}
if (-not $PSCmdlet.ShouldProcess($normalizedEvidenceId, 'publish a private acceptance evidence bundle')) {
    $preview | ConvertTo-DysonPrivateEvidenceJsonLine
    return
}

$publicationStage = 'private-target-preparation'
$acceptanceRoot = New-DysonPrivateEvidenceDirectory -Path (Join-Path $dataFull 'acceptance') -Private
[void](New-DysonPrivateEvidenceDirectory -Path $evidenceParent -Private)
$partial = Join-Path $evidenceParent ('.partial-' + $normalizedEvidenceId + '-' + [guid]::NewGuid().ToString('N'))
if (Test-Path -LiteralPath $partial) { throw 'The private evidence staging target already exists.' }

try {
    $publicationStage = 'payload-copy'
    $partialFull = New-DysonPrivateEvidenceDirectory -Path $partial -Private
    $payloadRoot = New-DysonPrivateEvidenceDirectory -Path (Join-Path $partialFull 'payload')
    Copy-DysonPrivateEvidencePayload -SourceRoot $stagingFull -DestinationRoot $payloadRoot -Inventory $sourceInventory
    $copiedInventory = Get-DysonPrivateEvidenceInventory -Root $payloadRoot
    Assert-DysonPrivateEvidenceInventoriesEqual -Expected $sourceInventory -Actual $copiedInventory
    $sourceAfterCopy = Get-DysonPrivateEvidenceInventory -Root $stagingFull
    Assert-DysonPrivateEvidenceInventoriesEqual -Expected $sourceInventory -Actual $sourceAfterCopy

    $publicationStage = 'manifest-write'
    $manifest = [ordered]@{
        protocol = $script:DysonPrivateEvidenceProtocol
        schemaVersion = $script:DysonPrivateEvidenceSchemaVersion
        evidenceId = $normalizedEvidenceId
        kind = $normalizedKind
        scope = $normalizedScope
        subjectCommit = $normalizedCommit
        runtimePayloadSha256 = $normalizedRuntimePayload
        opaqueId = 'private:' + $normalizedEvidenceId
        observedAt = $normalizedObservedAt
        requirementIds = $normalizedRequirements
        limits = [ordered]@{
            maximumFiles = $script:DysonPrivateEvidenceMaximumFiles
            maximumDirectories = $script:DysonPrivateEvidenceMaximumDirectories
            maximumTotalBytes = $script:DysonPrivateEvidenceMaximumTotalBytes
            maximumSingleFileBytes = $script:DysonPrivateEvidenceMaximumSingleFileBytes
        }
        payload = $copiedInventory
    }
    $manifestPath = Join-Path $partialFull $script:DysonPrivateEvidenceManifestName
    $manifestJson = $manifest | ConvertTo-Json -Depth 12
    [System.IO.File]::WriteAllText($manifestPath, $manifestJson + "`r`n", [System.Text.UTF8Encoding]::new($false))
    $manifestSha256 = Get-DysonPrivateEvidenceFileSha256 -Path $manifestPath
    $publicationStage = 'partial-verification'
    [void](Test-DysonPrivateEvidenceBundleCore -EvidenceRoot $partialFull -ExpectedEvidenceId $normalizedEvidenceId `
        -ExpectedManifestSha256 $manifestSha256 -ExpectedSubjectCommit $normalizedCommit `
        -ExpectedRuntimePayloadSha256 $normalizedRuntimePayload)
    $publicationStage = 'immutable-publish'
    [System.IO.Directory]::Move($partialFull, $evidenceFull)
    $publicationStage = 'published-verification'
    $verified = Test-DysonPrivateEvidenceBundleCore -EvidenceRoot $evidenceFull -ExpectedEvidenceId $normalizedEvidenceId `
        -ExpectedManifestSha256 $manifestSha256 -ExpectedSubjectCommit $normalizedCommit `
        -ExpectedRuntimePayloadSha256 $normalizedRuntimePayload
    [ordered]@{
        protocol = $verified.protocol
        state = 'published'
        ready = $true
        evidenceId = $verified.evidenceId
        kind = $verified.kind
        scope = $verified.scope
        subjectCommit = $verified.subjectCommit
        runtimePayloadSha256 = $verified.runtimePayloadSha256
        opaqueId = $verified.opaqueId
        sha256 = $verified.sha256
        observedAt = $verified.observedAt
        requirementIds = $verified.requirementIds
        fileCount = $verified.fileCount
        totalBytes = $verified.totalBytes
        productionChanged = $false
    } | ConvertTo-DysonPrivateEvidenceJsonLine
}
catch {
    $failure = $_
    try {
        if (Test-Path -LiteralPath $partial) {
            Remove-DysonPrivateEvidencePartialTree -Path $partial -Parent $evidenceParent
        }
    }
    catch { throw 'Private evidence publication failed and its bounded partial directory could not be removed.' }
    throw $failure
}
}
catch {
    throw "Private evidence publication failed at the fixed stage '$publicationStage'."
}
