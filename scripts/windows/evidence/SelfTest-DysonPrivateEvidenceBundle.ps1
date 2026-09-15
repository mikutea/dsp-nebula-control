[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
. (Join-Path $PSScriptRoot 'DysonPrivateEvidence.Common.ps1')

$temporaryBase = [System.IO.Path]::GetFullPath([System.IO.Path]::GetTempPath()).TrimEnd('\', '/')
$testRoot = Join-Path $temporaryBase ('dyson-private-evidence-selftest-' + [guid]::NewGuid().ToString('N'))
$dataRoot = Join-Path $testRoot 'private-data-root'
$stagingParent = Join-Path $dataRoot 'acceptance\staging'
$runId = 'run-selftest-0001'
$previewEvidenceId = 'evidence-preview-0001'
$evidenceId = 'evidence-selftest-0001'
$subjectCommit = 'a' * 40
$runtimePayloadSha256 = 'c' * 64
$observedAt = '2026-08-31T00:00:00.000Z'
$requirementIds = @('SEC-001', 'PRD-005')
$privateFileName = 'private-player-account.log'
$privateNestedFileName = 'private-endpoint.txt'
$privateContentMarker = 'PRIVATE_PLAYER_CONTENT_MARKER_7f4a'
$privateEndpointMarker = 'private-host.invalid:8469'
$newScript = Join-Path $PSScriptRoot 'New-DysonPrivateEvidenceBundle.ps1'
$testScript = Join-Path $PSScriptRoot 'Test-DysonPrivateEvidenceBundle.ps1'
$indexScript = Join-Path $PSScriptRoot 'New-DysonAcceptanceEvidenceIndex.ps1'
$junctionPath = Join-Path $stagingParent 'run-reparse-0001'
$junctionCreated = $false
$result = $null
$failureMessage = $null
$currentStage = 'initialization'

function Assert-EvidenceSelfTest {
    param([bool]$Condition, [string]$Message)

    if (-not $Condition) { throw ('Private evidence self-test failed: ' + $Message) }
}

function Assert-EvidenceRejected {
    param([scriptblock]$Action, [string]$Message)

    $rejected = $false
    try { & $Action | Out-Null }
    catch { $rejected = $true }
    Assert-EvidenceSelfTest -Condition $rejected -Message $Message
}

function Assert-EvidenceFailureOutputPrivate {
    param(
        [scriptblock]$Action,
        [string]$Message,
        [string]$ExpectedErrorMessage
    )

    $records = New-Object 'System.Collections.Generic.List[object]'
    $errorRecord = $null
    $rejected = $false
    try {
        & $Action *>&1 | ForEach-Object { [void]$records.Add($_) }
    }
    catch {
        $rejected = $true
        $errorRecord = $_
        [void]$records.Add($_)
    }
    Assert-EvidenceSelfTest -Condition $rejected -Message $Message
    if (-not [string]::IsNullOrWhiteSpace($ExpectedErrorMessage)) {
        Assert-EvidenceSelfTest -Condition (
            $null -ne $errorRecord -and
            [string]$errorRecord.Exception.Message -ceq $ExpectedErrorMessage
        ) -Message ($Message + ' with an unexpected public error')
    }
    $fullRecordText = @(
        ($records | Out-String),
        ($errorRecord | Format-List * -Force | Out-String),
        ($errorRecord.Exception | Format-List * -Force | Out-String),
        ($errorRecord.InvocationInfo | Format-List * -Force | Out-String),
        [string]$errorRecord.ScriptStackTrace,
        [string]$errorRecord.CategoryInfo,
        [string]$errorRecord.FullyQualifiedErrorId,
        [string]$errorRecord.TargetObject
    ) -join "`n"
    Assert-PublicEvidenceOutput -Text $fullRecordText -Message ($Message + ' and disclosed private data') `
        -IgnoreInvocationIdentity
}

function Get-LastEvidenceJson {
    param($Output, [string]$Message)

    $lines = @(($Output | Out-String) -split "`r?`n" | Where-Object { -not [string]::IsNullOrWhiteSpace($_) })
    Assert-EvidenceSelfTest -Condition ($lines.Count -gt 0) -Message $Message
    try { return $lines[$lines.Count - 1] | ConvertFrom-Json -ErrorAction Stop }
    catch { throw ('Private evidence self-test failed: ' + $Message) }
}

function Assert-ExactEvidenceProperties {
    param($Value, [string[]]$Expected, [string]$Message)

    $actual = [string[]]@($Value.PSObject.Properties.Name)
    $wanted = [string[]]@($Expected)
    [System.Array]::Sort($actual, [System.StringComparer]::Ordinal)
    [System.Array]::Sort($wanted, [System.StringComparer]::Ordinal)
    Assert-EvidenceSelfTest -Condition ([string]::Join("`n", $actual) -ceq [string]::Join("`n", $wanted)) -Message $Message
}

function Assert-PublicEvidenceOutput {
    param([string]$Text, [string]$Message, [switch]$IgnoreInvocationIdentity)

    $needles = @($testRoot, $privateFileName, $privateNestedFileName, $privateContentMarker, $privateEndpointMarker)
    if (-not $IgnoreInvocationIdentity) {
        if (-not [string]::IsNullOrWhiteSpace($env:USERNAME)) { $needles += [string]$env:USERNAME }
        try {
            $currentSid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
            if (-not [string]::IsNullOrWhiteSpace($currentSid)) { $needles += $currentSid }
        }
        catch { }
    }
    foreach ($needle in $needles) {
        if (-not [string]::IsNullOrWhiteSpace($needle) -and
            $Text.IndexOf($needle, [System.StringComparison]::OrdinalIgnoreCase) -ge 0) {
            throw ('Private evidence self-test failed: ' + $Message)
        }
    }
}

function Get-EvidenceTreeFingerprint {
    param([string]$Root)

    $builder = New-Object System.Text.StringBuilder
    foreach ($item in @(Get-ChildItem -LiteralPath $Root -Force -Recurse | Sort-Object FullName)) {
        $relative = $item.FullName.Substring($Root.TrimEnd('\', '/').Length).TrimStart('\', '/').Replace('\', '/')
        [void]$builder.Append($relative).Append('|').Append([bool]$item.PSIsContainer).Append('|')
        if (-not $item.PSIsContainer) {
            [void]$builder.Append([int64]$item.Length).Append('|').Append((Get-DysonPrivateEvidenceFileSha256 -Path $item.FullName))
        }
        [void]$builder.Append("`n")
    }
    return Get-DysonPrivateEvidenceTextSha256 -Text $builder.ToString()
}

function Write-EvidenceJsonFile {
    param([string]$Path, $Value)

    $json = $Value | ConvertTo-Json -Depth 12
    [System.IO.File]::WriteAllText($Path, $json + "`r`n", [System.Text.UTF8Encoding]::new($false))
}

try {
    $currentStage = 'fixture-create'
    [void](New-DysonPrivateEvidenceDirectory -Path $stagingParent -Private)
    $stagingRoot = Join-Path $stagingParent $runId
    $nestedRoot = Join-Path $stagingRoot 'nested'
    [void](New-DysonPrivateEvidenceDirectory -Path $stagingRoot -Private)
    [System.IO.Directory]::CreateDirectory($nestedRoot) | Out-Null
    [System.IO.File]::WriteAllText(
        (Join-Path $stagingRoot $privateFileName),
        $privateContentMarker,
        [System.Text.UTF8Encoding]::new($false)
    )
    [System.IO.File]::WriteAllText(
        (Join-Path $nestedRoot $privateNestedFileName),
        $privateEndpointMarker,
        [System.Text.UTF8Encoding]::new($false)
    )
    [void](Assert-DysonPrivateEvidenceDirectoryAcl -Path $stagingRoot)

    $currentStage = 'staging-privacy-contract'
    $wideRunId = 'run-wide-acl-0001'
    $wideStagingRoot = Join-Path $stagingParent $wideRunId
    [System.IO.Directory]::CreateDirectory($wideStagingRoot) | Out-Null
    [System.IO.File]::WriteAllText(
        (Join-Path $wideStagingRoot $privateFileName),
        $privateContentMarker,
        [System.Text.UTF8Encoding]::new($false)
    )
    Assert-EvidenceFailureOutputPrivate -Action {
        & $newScript -DataRoot $dataRoot -RunId $wideRunId -EvidenceId 'evidence-wide-acl-0001' `
            -Kind 'operator-run' -Scope 'production' -SubjectCommit $subjectCommit `
            -RuntimePayloadSha256 $runtimePayloadSha256 -RequirementIds @('SEC-001') `
            -ObservedAt $observedAt -WhatIf
    } -Message 'bundle preview accepted a staging directory without an exact private ACL'

    $lockedRunId = 'run-locked-file-0001'
    $lockedStagingRoot = Join-Path $stagingParent $lockedRunId
    [void](New-DysonPrivateEvidenceDirectory -Path $lockedStagingRoot -Private)
    $lockedFilePath = Join-Path $lockedStagingRoot $privateFileName
    [System.IO.File]::WriteAllText($lockedFilePath, $privateContentMarker, [System.Text.UTF8Encoding]::new($false))
    $lockedStream = [System.IO.FileStream]::new(
        $lockedFilePath,
        [System.IO.FileMode]::Open,
        [System.IO.FileAccess]::ReadWrite,
        [System.IO.FileShare]::None
    )
    try {
        Assert-EvidenceFailureOutputPrivate -Action {
            & $newScript -DataRoot $dataRoot -RunId $lockedRunId -EvidenceId 'evidence-locked-file-0001' `
                -Kind 'operator-run' -Scope 'production' -SubjectCommit $subjectCommit `
                -RuntimePayloadSha256 $runtimePayloadSha256 -RequirementIds @('SEC-001') `
                -ObservedAt $observedAt -WhatIf
        } -Message 'bundle preview accepted a payload file that could not be read'
    }
    finally { $lockedStream.Dispose() }

    $currentStage = 'identifier-contract'
    $singleRequirement = Get-DysonPrivateEvidenceRequirementIds -RequirementIds @('SEC-001')
    $singleRequirementJson = [ordered]@{ requirementIds = $singleRequirement } | ConvertTo-Json -Compress
    $singleRequirementRoundTrip = $singleRequirementJson | ConvertFrom-Json
    Assert-EvidenceSelfTest -Condition ($singleRequirement -is [System.Array] -and $singleRequirement.Count -eq 1 -and
        $singleRequirementRoundTrip.requirementIds -is [System.Array] -and
        @($singleRequirementRoundTrip.requirementIds).Count -eq 1) `
        -Message 'a single requirement ID did not remain a JSON array'
    Assert-EvidenceRejected -Action {
        & $newScript -DataRoot $dataRoot -RunId $runId -EvidenceId 'evidence:ads-0001' -Kind 'operator-run' `
            -Scope 'production' -SubjectCommit $subjectCommit -RuntimePayloadSha256 $runtimePayloadSha256 `
            -RequirementIds @('SEC-001') -ObservedAt $observedAt -WhatIf
    } -Message 'an ADS-capable evidence ID was accepted'
    Assert-EvidenceRejected -Action {
        & $newScript -DataRoot $dataRoot -RunId 'run:ads-0001' -EvidenceId 'evidence-safe-0001' -Kind 'operator-run' `
            -Scope 'production' -SubjectCommit $subjectCommit -RuntimePayloadSha256 $runtimePayloadSha256 `
            -RequirementIds @('SEC-001') -ObservedAt $observedAt -WhatIf
    } -Message 'an ADS-capable run ID was accepted'
    foreach ($unsafeIdentifier in @('evidence-trailing.', 'evidence..double', 'con.fixture')) {
        Assert-EvidenceRejected -Action {
            [void](Assert-DysonPrivateEvidenceIdentifier -Value $unsafeIdentifier -Name 'EvidenceId')
        } -Message 'a non-portable public evidence identifier was accepted'
    }

    $currentStage = 'bundle-preview'
    $beforePreview = Get-EvidenceTreeFingerprint -Root $dataRoot
    $previewOutput = @(& $newScript -DataRoot $dataRoot -RunId $runId -EvidenceId $previewEvidenceId `
        -Kind 'operator-run' -Scope 'production' -SubjectCommit $subjectCommit `
        -RuntimePayloadSha256 $runtimePayloadSha256 -RequirementIds $requirementIds `
        -ObservedAt $observedAt -WhatIf 6>&1)
    $previewText = $previewOutput | Out-String
    $preview = Get-LastEvidenceJson -Output $previewOutput -Message 'bundle WhatIf returned no valid JSON'
    $afterPreview = Get-EvidenceTreeFingerprint -Root $dataRoot
    Assert-EvidenceSelfTest -Condition ($preview.state -eq 'preview' -and $beforePreview -eq $afterPreview -and
        -not (Test-Path -LiteralPath (Join-Path (Join-Path $dataRoot 'acceptance\evidence') $previewEvidenceId))) `
        -Message 'bundle WhatIf changed the filesystem'
    Assert-PublicEvidenceOutput -Text $previewText -Message 'bundle WhatIf output disclosed private data'

    $currentStage = 'bundle-publish'
    $publishedOutput = @(& $newScript -DataRoot $dataRoot -RunId $runId -EvidenceId $evidenceId `
        -Kind 'operator-run' -Scope 'production' -SubjectCommit $subjectCommit `
        -RuntimePayloadSha256 $runtimePayloadSha256 -RequirementIds $requirementIds `
        -ObservedAt $observedAt -Confirm:$false 6>&1)
    $publishedText = $publishedOutput | Out-String
    $published = Get-LastEvidenceJson -Output $publishedOutput -Message 'bundle creation returned no valid JSON'
    Assert-EvidenceSelfTest -Condition ($published.state -eq 'published' -and [bool]$published.ready -and
        [string]$published.evidenceId -ceq $evidenceId -and [string]$published.sha256 -cmatch '^[0-9a-f]{64}$') `
        -Message 'bundle creation did not publish a verified bundle'
    Assert-PublicEvidenceOutput -Text $publishedText -Message 'bundle creation output disclosed private data'

    $currentStage = 'bundle-verify'
    $manifestSha256 = [string]$published.sha256
    $verifiedOutput = @(& $testScript -DataRoot $dataRoot -EvidenceId $evidenceId `
        -ExpectedManifestSha256 $manifestSha256 -ExpectedSubjectCommit $subjectCommit `
        -ExpectedRuntimePayloadSha256 $runtimePayloadSha256 6>&1)
    $verifiedText = $verifiedOutput | Out-String
    $verified = Get-LastEvidenceJson -Output $verifiedOutput -Message 'bundle verification returned no valid JSON'
    Assert-EvidenceSelfTest -Condition ([bool]$verified.ready -and [string]$verified.sha256 -ceq $manifestSha256) `
        -Message 'the published bundle did not verify'
    Assert-PublicEvidenceOutput -Text $verifiedText -Message 'bundle verification output disclosed private data'

    $evidenceParent = Join-Path $dataRoot 'acceptance\evidence'
    $bundleRoot = Join-Path $evidenceParent $evidenceId
    $manifestPath = Join-Path $bundleRoot 'manifest.json'
    $payloadRoot = Join-Path $bundleRoot 'payload'
    $backupRoot = Join-Path $testRoot 'known-good-bundle'
    Copy-Item -LiteralPath $bundleRoot -Destination $backupRoot -Recurse -Force

    $currentStage = 'verifier-io-failure-privacy'
    $lockedPublishedPayloadPath = Join-Path $payloadRoot $privateFileName
    $lockedVerifierStream = [System.IO.FileStream]::new(
        $lockedPublishedPayloadPath,
        [System.IO.FileMode]::Open,
        [System.IO.FileAccess]::ReadWrite,
        [System.IO.FileShare]::None
    )
    try {
        Assert-EvidenceFailureOutputPrivate -Action {
            & $testScript -DataRoot $dataRoot -EvidenceId $evidenceId `
                -ExpectedManifestSha256 $manifestSha256 -ExpectedSubjectCommit $subjectCommit `
                -ExpectedRuntimePayloadSha256 $runtimePayloadSha256
        } -Message 'bundle verification exposed a bottom-level payload read failure' `
            -ExpectedErrorMessage "Private evidence verification failed at the fixed stage 'bundle-verification'."
    }
    finally { $lockedVerifierStream.Dispose() }

    $currentStage = 'bundle-negative-cases'
    Assert-EvidenceRejected -Action {
        & $newScript -DataRoot $dataRoot -RunId $runId -EvidenceId $evidenceId -Kind 'operator-run' `
            -Scope 'production' -SubjectCommit $subjectCommit -RuntimePayloadSha256 $runtimePayloadSha256 `
            -RequirementIds $requirementIds -ObservedAt $observedAt -Confirm:$false
    } -Message 'bundle creation overwrote an existing publication'

    Assert-EvidenceRejected -Action {
        & $testScript -DataRoot $dataRoot -EvidenceId $evidenceId -ExpectedManifestSha256 ('d' * 64)
    } -Message 'bundle verification accepted the wrong manifest digest'
    Assert-EvidenceRejected -Action {
        & $testScript -DataRoot $dataRoot -EvidenceId $evidenceId -ExpectedManifestSha256 $manifestSha256 `
            -ExpectedSubjectCommit ('b' * 40)
    } -Message 'bundle verification accepted the wrong subject commit'
    Assert-EvidenceRejected -Action {
        & $testScript -DataRoot $dataRoot -EvidenceId $evidenceId -ExpectedManifestSha256 $manifestSha256 `
            -ExpectedRuntimePayloadSha256 ('e' * 64)
    } -Message 'bundle verification accepted the wrong runtime payload digest'

    function Restore-KnownGoodEvidenceBundle {
        if (Test-Path -LiteralPath $bundleRoot) { Remove-Item -LiteralPath $bundleRoot -Recurse -Force }
        Copy-Item -LiteralPath $backupRoot -Destination $bundleRoot -Recurse -Force
    }

    [System.IO.File]::AppendAllText((Join-Path $payloadRoot $privateFileName), 'tamper', [System.Text.UTF8Encoding]::new($false))
    Assert-EvidenceRejected -Action {
        & $testScript -DataRoot $dataRoot -EvidenceId $evidenceId -ExpectedManifestSha256 $manifestSha256
    } -Message 'bundle verification accepted a tampered payload file'
    Restore-KnownGoodEvidenceBundle

    [System.IO.File]::WriteAllText((Join-Path $payloadRoot 'unexpected-extra.txt'), 'extra', [System.Text.UTF8Encoding]::new($false))
    Assert-EvidenceRejected -Action {
        & $testScript -DataRoot $dataRoot -EvidenceId $evidenceId -ExpectedManifestSha256 $manifestSha256
    } -Message 'bundle verification accepted an extra payload file'
    Restore-KnownGoodEvidenceBundle

    [System.IO.File]::Delete((Join-Path $payloadRoot $privateFileName))
    Assert-EvidenceRejected -Action {
        & $testScript -DataRoot $dataRoot -EvidenceId $evidenceId -ExpectedManifestSha256 $manifestSha256
    } -Message 'bundle verification accepted a missing payload file'
    Restore-KnownGoodEvidenceBundle

    $manifest = [System.IO.File]::ReadAllText($manifestPath, [System.Text.Encoding]::UTF8) | ConvertFrom-Json
    $manifest | Add-Member -NotePropertyName 'unexpectedField' -NotePropertyValue 'fixed-fixture'
    Write-EvidenceJsonFile -Path $manifestPath -Value $manifest
    $mutatedManifestSha256 = Get-DysonPrivateEvidenceFileSha256 -Path $manifestPath
    Assert-EvidenceRejected -Action {
        & $testScript -DataRoot $dataRoot -EvidenceId $evidenceId -ExpectedManifestSha256 $mutatedManifestSha256
    } -Message 'bundle verification accepted an unknown manifest field'
    Restore-KnownGoodEvidenceBundle

    $manifest = [System.IO.File]::ReadAllText($manifestPath, [System.Text.Encoding]::UTF8) | ConvertFrom-Json
    $manifest.requirementIds = @('SEC-001', 'invalid-requirement')
    Write-EvidenceJsonFile -Path $manifestPath -Value $manifest
    $mutatedManifestSha256 = Get-DysonPrivateEvidenceFileSha256 -Path $manifestPath
    Assert-EvidenceRejected -Action {
        & $testScript -DataRoot $dataRoot -EvidenceId $evidenceId -ExpectedManifestSha256 $mutatedManifestSha256
    } -Message 'bundle verification accepted an invalid requirement ID'
    Restore-KnownGoodEvidenceBundle

    $manifest = [System.IO.File]::ReadAllText($manifestPath, [System.Text.Encoding]::UTF8) | ConvertFrom-Json
    $manifest.requirementIds = @('SEC-001', 'SEC-001')
    Write-EvidenceJsonFile -Path $manifestPath -Value $manifest
    $mutatedManifestSha256 = Get-DysonPrivateEvidenceFileSha256 -Path $manifestPath
    Assert-EvidenceRejected -Action {
        & $testScript -DataRoot $dataRoot -EvidenceId $evidenceId -ExpectedManifestSha256 $mutatedManifestSha256
    } -Message 'bundle verification accepted duplicate requirement IDs'
    Restore-KnownGoodEvidenceBundle

    $manifest = [System.IO.File]::ReadAllText($manifestPath, [System.Text.Encoding]::UTF8) | ConvertFrom-Json
    $manifest.schemaVersion = '1'
    Write-EvidenceJsonFile -Path $manifestPath -Value $manifest
    $mutatedManifestSha256 = Get-DysonPrivateEvidenceFileSha256 -Path $manifestPath
    Assert-EvidenceRejected -Action {
        & $testScript -DataRoot $dataRoot -EvidenceId $evidenceId -ExpectedManifestSha256 $mutatedManifestSha256
    } -Message 'bundle verification accepted a string schema version'
    Restore-KnownGoodEvidenceBundle

    $manifest = [System.IO.File]::ReadAllText($manifestPath, [System.Text.Encoding]::UTF8) | ConvertFrom-Json
    $manifest.payload.files[0].length = 1.5
    Write-EvidenceJsonFile -Path $manifestPath -Value $manifest
    $mutatedManifestSha256 = Get-DysonPrivateEvidenceFileSha256 -Path $manifestPath
    Assert-EvidenceRejected -Action {
        & $testScript -DataRoot $dataRoot -EvidenceId $evidenceId -ExpectedManifestSha256 $mutatedManifestSha256
    } -Message 'bundle verification accepted a fractional file length'
    Restore-KnownGoodEvidenceBundle

    $currentStage = 'index-contract'
    $indexParent = Join-Path $testRoot 'repository-safe-output'
    [System.IO.Directory]::CreateDirectory($indexParent) | Out-Null
    $indexPath = Join-Path $indexParent 'evidence-index.json'
    $indexPreviewOutput = @(& $indexScript -DataRoot $dataRoot -EvidenceId $evidenceId `
        -ExpectedManifestSha256 $manifestSha256 -ExpectedSubjectCommit $subjectCommit `
        -ExpectedRuntimePayloadSha256 $runtimePayloadSha256 -OutputPath $indexPath -WhatIf 6>&1)
    $indexPreviewText = $indexPreviewOutput | Out-String
    $indexPreview = Get-LastEvidenceJson -Output $indexPreviewOutput -Message 'index WhatIf returned no valid JSON'
    Assert-EvidenceSelfTest -Condition ($indexPreview.state -eq 'preview' -and -not (Test-Path -LiteralPath $indexPath)) `
        -Message 'index WhatIf changed the filesystem'
    Assert-PublicEvidenceOutput -Text $indexPreviewText -Message 'index WhatIf output disclosed private data'

    $indexCreatedOutput = @(& $indexScript -DataRoot $dataRoot -EvidenceId $evidenceId `
        -ExpectedManifestSha256 $manifestSha256 -ExpectedSubjectCommit $subjectCommit `
        -ExpectedRuntimePayloadSha256 $runtimePayloadSha256 -OutputPath $indexPath -Confirm:$false 6>&1)
    $indexCreatedText = $indexCreatedOutput | Out-String
    $indexCreated = Get-LastEvidenceJson -Output $indexCreatedOutput -Message 'index creation returned no valid JSON'
    Assert-EvidenceSelfTest -Condition ($indexCreated.state -eq 'created' -and (Test-Path -LiteralPath $indexPath -PathType Leaf)) `
        -Message 'index creation did not create its output'
    Assert-PublicEvidenceOutput -Text $indexCreatedText -Message 'index creation output disclosed private data'
    $index = [System.IO.File]::ReadAllText($indexPath, [System.Text.Encoding]::UTF8) | ConvertFrom-Json
    Assert-ExactEvidenceProperties -Value $index -Expected @('protocol', 'schemaVersion', 'evidence') `
        -Message 'the index root schema is not exact'
    Assert-ExactEvidenceProperties -Value $index.evidence -Expected @(
        'evidenceId', 'kind', 'scope', 'subjectCommit', 'runtimePayloadSha256',
        'opaqueId', 'sha256', 'observedAt', 'requirementIds'
    ) -Message 'the index evidence schema is not exact'
    Assert-EvidenceSelfTest -Condition ([string]$index.protocol -ceq 'DYSON_ACCEPTANCE_EVIDENCE_INDEX_V1' -and
        [int]$index.schemaVersion -eq 1 -and
        [string]::Join("`n", [string[]]@($index.evidence.requirementIds)) -ceq "PRD-005`nSEC-001") `
        -Message 'the index identity or canonical requirement IDs are invalid'
    $indexText = [System.IO.File]::ReadAllText($indexPath, [System.Text.Encoding]::UTF8)
    Assert-PublicEvidenceOutput -Text $indexText -Message 'the repository-safe index disclosed private data'
    Assert-EvidenceRejected -Action {
        & $indexScript -DataRoot $dataRoot -EvidenceId $evidenceId -ExpectedManifestSha256 $manifestSha256 `
            -OutputPath $indexPath -Confirm:$false
    } -Message 'index creation overwrote an existing output'

    $currentStage = 'index-io-failure-privacy'
    $indexIoParent = Join-Path $testRoot 'repository-safe-io-failure'
    [System.IO.Directory]::CreateDirectory($indexIoParent) | Out-Null
    $indexIoPath = Join-Path $indexIoParent $privateNestedFileName
    $indexIoAcl = Get-Acl -LiteralPath $indexIoParent -ErrorAction Stop
    $accessSections = [System.Security.AccessControl.AccessControlSections]::Access
    $indexIoAccessSddl = $indexIoAcl.GetSecurityDescriptorSddlForm($accessSections)
    $currentUserSid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
    $denyCreateFileRule = [System.Security.AccessControl.FileSystemAccessRule]::new(
        $currentUserSid,
        [System.Security.AccessControl.FileSystemRights]::CreateFiles,
        [System.Security.AccessControl.InheritanceFlags]::None,
        [System.Security.AccessControl.PropagationFlags]::None,
        [System.Security.AccessControl.AccessControlType]::Deny
    )
    try {
        [void]$indexIoAcl.AddAccessRule($denyCreateFileRule)
        Set-Acl -LiteralPath $indexIoParent -AclObject $indexIoAcl -ErrorAction Stop
        Assert-EvidenceFailureOutputPrivate -Action {
            & $indexScript -DataRoot $dataRoot -EvidenceId $evidenceId `
                -ExpectedManifestSha256 $manifestSha256 -ExpectedSubjectCommit $subjectCommit `
                -ExpectedRuntimePayloadSha256 $runtimePayloadSha256 -OutputPath $indexIoPath -Confirm:$false
        } -Message 'index creation exposed a bottom-level output write failure' `
            -ExpectedErrorMessage "Acceptance evidence index creation failed at the fixed stage 'index-write'."
        Assert-EvidenceSelfTest -Condition (-not (Test-Path -LiteralPath $indexIoPath)) `
            -Message 'index write failure left its requested output behind'
    }
    finally {
        $restoreIndexIoAcl = Get-Acl -LiteralPath $indexIoParent -ErrorAction Stop
        $restoreIndexIoAcl.SetSecurityDescriptorSddlForm($indexIoAccessSddl, $accessSections)
        Set-Acl -LiteralPath $indexIoParent -AclObject $restoreIndexIoAcl -ErrorAction Stop
    }

    $currentStage = 'reparse-contract'
    $reparseTested = $false
    $reparseTarget = Join-Path $testRoot 'reparse-source-target'
    [System.IO.Directory]::CreateDirectory($reparseTarget) | Out-Null
    [System.IO.File]::WriteAllText((Join-Path $reparseTarget 'fixture.txt'), 'fixture', [System.Text.UTF8Encoding]::new($false))
    try {
        [void](New-Item -ItemType Junction -Path $junctionPath -Target $reparseTarget -ErrorAction Stop)
        $junctionCreated = $true
        $reparseTested = $true
        Assert-EvidenceRejected -Action {
            & $newScript -DataRoot $dataRoot -RunId 'run-reparse-0001' -EvidenceId 'evidence-reparse-0001' `
                -Kind 'operator-run' -Scope 'production' -SubjectCommit $subjectCommit `
                -RuntimePayloadSha256 $runtimePayloadSha256 -RequirementIds @('SEC-001') `
                -ObservedAt $observedAt -Confirm:$false
        } -Message 'bundle creation accepted a redirected staging source'
    }
    catch {
        if ($_.Exception.Message.StartsWith('Private evidence self-test failed:', [System.StringComparison]::Ordinal)) { throw }
    }
    finally {
        if ($junctionCreated -and (Test-Path -LiteralPath $junctionPath)) {
            [System.IO.Directory]::Delete($junctionPath, $false)
            $junctionCreated = $false
        }
    }

    $currentStage = 'partial-cleanup-check'
    $partials = @(Get-ChildItem -LiteralPath $testRoot -Force -Recurse -ErrorAction Stop |
        Where-Object { $_.Name.StartsWith('.partial-', [System.StringComparison]::Ordinal) })
    Assert-EvidenceSelfTest -Condition ($partials.Count -eq 0) -Message 'a bounded partial artifact remained after testing'

    $result = [ordered]@{
        protocol = 'DYSON_PRIVATE_ACCEPTANCE_EVIDENCE_SELFTEST_V1'
        state = 'passed'
        bundleWhatIfWasNonMutating = $true
        bundleCreationAndVerificationValidated = $true
        publicOutputPrivacyValidated = $true
        stagingAclValidatedBeforeInventory = $true
        failureOutputPrivacyValidated = $true
        tamperExtraMissingAndSchemaDriftRejected = $true
        bindingAndRequirementDriftRejected = $true
        overwriteRefused = $true
        repositorySafeIndexValidated = $true
        redirectedSourceTestedWhenSupported = $reparseTested
        partialArtifactsAbsent = $true
        productionChanged = $false
    }
}
catch {
    if ($_.Exception.Message.StartsWith('Private evidence self-test failed:', [System.StringComparison]::Ordinal)) {
        $failureMessage = $_.Exception.Message
    }
    else { $failureMessage = "Private evidence self-test failed at the fixed stage '$currentStage'." }
}
finally {
    try {
        if ($junctionCreated -and (Test-Path -LiteralPath $junctionPath)) {
            [System.IO.Directory]::Delete($junctionPath, $false)
        }
        $testFull = [System.IO.Path]::GetFullPath($testRoot).TrimEnd('\', '/')
        $expectedPrefix = $temporaryBase + [System.IO.Path]::DirectorySeparatorChar + 'dyson-private-evidence-selftest-'
        if ($testFull.StartsWith($expectedPrefix, [System.StringComparison]::OrdinalIgnoreCase) -and
            (Test-Path -LiteralPath $testFull)) {
            Remove-Item -LiteralPath $testFull -Recurse -Force -ErrorAction Stop
        }
    }
    catch { $failureMessage = 'Private evidence self-test failed: the isolated temporary root could not be removed' }
}

if ($failureMessage) { throw $failureMessage }
$result | ConvertTo-DysonPrivateEvidenceJsonLine
