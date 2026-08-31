[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$EvidenceId,
    [Parameter(Mandatory)][string]$ExpectedManifestSha256,
    [string]$ExpectedSubjectCommit,
    [string]$ExpectedRuntimePayloadSha256,
    [string]$DataRoot = (Join-Path $env:ProgramData 'DysonControl')
)

$ErrorActionPreference = 'Stop'
$verificationStage = 'initialization'
try {
    [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
    . (Join-Path $PSScriptRoot 'DysonPrivateEvidence.Common.ps1')

    $verificationStage = 'input-validation'
    $normalizedEvidenceId = Assert-DysonPrivateEvidenceIdentifier -Value $EvidenceId -Name 'EvidenceId'
    $dataFull = Assert-DysonPrivateEvidenceSafeRoot -Path $DataRoot -Name 'DataRoot'
    Assert-DysonPrivateEvidenceNoReparseAncestors -Path $dataFull
    $evidenceRoot = Join-Path (Join-Path (Join-Path $dataFull 'acceptance') 'evidence') $normalizedEvidenceId

    $verificationStage = 'bundle-verification'
    $verified = Test-DysonPrivateEvidenceBundleCore -EvidenceRoot $evidenceRoot -ExpectedEvidenceId $normalizedEvidenceId `
        -ExpectedManifestSha256 $ExpectedManifestSha256 -ExpectedSubjectCommit $ExpectedSubjectCommit `
        -ExpectedRuntimePayloadSha256 $ExpectedRuntimePayloadSha256

    $verificationStage = 'result-serialization'
    [ordered]@{
        protocol = $verified.protocol
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
    throw "Private evidence verification failed at the fixed stage '$verificationStage'."
}
