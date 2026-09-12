[CmdletBinding(SupportsShouldProcess, ConfirmImpact = 'Medium')]
param(
    [Parameter(Mandatory)][string]$EvidenceId,
    [Parameter(Mandatory)][string]$ExpectedManifestSha256,
    [Parameter(Mandatory)][string]$OutputPath,
    [string]$ExpectedSubjectCommit,
    [string]$ExpectedRuntimePayloadSha256,
    [string]$DataRoot = (Join-Path $env:ProgramData 'DysonControl')
)

$ErrorActionPreference = 'Stop'
$indexStage = 'initialization'
try {
    [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
    . (Join-Path $PSScriptRoot 'DysonPrivateEvidence.Common.ps1')

    $indexStage = 'input-validation'
    $normalizedEvidenceId = Assert-DysonPrivateEvidenceIdentifier -Value $EvidenceId -Name 'EvidenceId'
    $dataFull = Assert-DysonPrivateEvidenceSafeRoot -Path $DataRoot -Name 'DataRoot'
    Assert-DysonPrivateEvidenceNoReparseAncestors -Path $dataFull
    $evidenceRoot = Join-Path (Join-Path (Join-Path $dataFull 'acceptance') 'evidence') $normalizedEvidenceId

    $indexStage = 'bundle-verification'
    $verified = Test-DysonPrivateEvidenceBundleCore -EvidenceRoot $evidenceRoot -ExpectedEvidenceId $normalizedEvidenceId `
        -ExpectedManifestSha256 $ExpectedManifestSha256 -ExpectedSubjectCommit $ExpectedSubjectCommit `
        -ExpectedRuntimePayloadSha256 $ExpectedRuntimePayloadSha256

    $indexStage = 'output-validation'
    $outputFull = Assert-DysonPrivateEvidenceSafeRoot -Path $OutputPath -Name 'OutputPath'
    Assert-DysonPrivateEvidenceNoReparseAncestors -Path $outputFull
    if (Test-Path -LiteralPath $outputFull) { throw 'The acceptance evidence index output already exists.' }
    $outputParent = Split-Path -Parent $outputFull
    if (-not (Test-Path -LiteralPath $outputParent -PathType Container)) {
        throw 'The acceptance evidence index parent directory does not exist.'
    }
    [void](Assert-DysonPrivateEvidencePlainDirectory -Path $outputParent)

    $index = [ordered]@{
        protocol = $script:DysonAcceptanceEvidenceIndexProtocol
        schemaVersion = 1
        evidence = [ordered]@{
            evidenceId = $verified.evidenceId
            kind = $verified.kind
            scope = $verified.scope
            subjectCommit = $verified.subjectCommit
            runtimePayloadSha256 = $verified.runtimePayloadSha256
            opaqueId = $verified.opaqueId
            sha256 = $verified.sha256
            observedAt = $verified.observedAt
            requirementIds = $verified.requirementIds
        }
    }

    $indexStage = 'action-authorization'
    if (-not $PSCmdlet.ShouldProcess($normalizedEvidenceId, 'write a repository-safe acceptance evidence index')) {
        $indexStage = 'preview-serialization'
        [ordered]@{
            protocol = $script:DysonAcceptanceEvidenceIndexProtocol
            state = 'preview'
            evidenceId = $normalizedEvidenceId
            requirementCount = @($verified.requirementIds).Count
            productionChanged = $false
        } | ConvertTo-DysonPrivateEvidenceJsonLine
        return
    }

    $partial = Join-Path $outputParent ('.partial-evidence-index-' + [guid]::NewGuid().ToString('N') + '.json')
    $publishedByThisRun = $false
    try {
        $indexStage = 'index-write'
        $json = $index | ConvertTo-Json -Depth 8
        $bytes = [System.Text.UTF8Encoding]::new($false).GetBytes($json + "`r`n")
        $stream = [System.IO.FileStream]::new(
            $partial,
            [System.IO.FileMode]::CreateNew,
            [System.IO.FileAccess]::Write,
            [System.IO.FileShare]::None
        )
        try {
            $stream.Write($bytes, 0, $bytes.Length)
            $stream.Flush($true)
        }
        finally { $stream.Dispose() }

        $indexStage = 'index-publish'
        [System.IO.File]::Move($partial, $outputFull)
        $publishedByThisRun = $true
        $indexStage = 'index-digest'
        $indexSha256 = Get-DysonPrivateEvidenceFileSha256 -Path $outputFull
        $indexStage = 'result-serialization'
        [ordered]@{
            protocol = $script:DysonAcceptanceEvidenceIndexProtocol
            state = 'created'
            evidenceId = $normalizedEvidenceId
            requirementCount = @($verified.requirementIds).Count
            indexSha256 = $indexSha256
            productionChanged = $false
        } | ConvertTo-DysonPrivateEvidenceJsonLine
    }
    catch {
        $failedStage = $indexStage
        $indexStage = 'partial-cleanup'
        if (Test-Path -LiteralPath $partial) {
            Remove-Item -LiteralPath $partial -Force -ErrorAction Stop
        }
        if ($publishedByThisRun -and (Test-Path -LiteralPath $outputFull -PathType Leaf)) {
            Remove-Item -LiteralPath $outputFull -Force -ErrorAction Stop
        }
        $indexStage = $failedStage
        throw
    }
}
catch {
    throw "Acceptance evidence index creation failed at the fixed stage '$indexStage'."
}
