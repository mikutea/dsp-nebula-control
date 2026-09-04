# Copyright (c) Dyson Control contributors.
# Protected receipt ingestion for production qualification orchestration v2.
# Loading this file is read-only. It never invokes a production mutation.

Set-StrictMode -Version 2.0

. (Join-Path $PSScriptRoot 'Qualification.ProtocolV2.ps1')
. (Join-Path $PSScriptRoot 'Qualification.Protocol.ps1')
. (Join-Path $PSScriptRoot 'PanelObservationV2.Common.ps1')
. (Join-Path $PSScriptRoot 'Qualification.SideBySideV2.ps1')
. (Join-Path $PSScriptRoot 'ExternalJoinObservationV2.Common.ps1')
. (Join-Path $PSScriptRoot 'Qualification.PairedSaveLoad.ps1')
. (Join-Path $PSScriptRoot 'Qualification.ReversibleCutover.ps1')
. (Join-Path $PSScriptRoot 'PostGsManagerRemovalObservationV2.Common.ps1')
. (Join-Path $PSScriptRoot 'SoakObservationV2.Common.ps1')
. (Join-Path (Split-Path $PSScriptRoot -Parent) 'evidence\DysonPrivateEvidence.Common.ps1')

$script:DysonOrchestrationV2Protocol = 'DYSON_QUALIFICATION_ORCHESTRATION_V2'
$script:DysonOrchestrationV2ProfileProtocol = 'DYSON_QUALIFICATION_ORCHESTRATION_PROFILE_V2'
$script:DysonOrchestrationV2RequestProtocol = 'DYSON_QUALIFICATION_ORCHESTRATION_REQUEST_V2'
$script:DysonOrchestrationV2EvidenceProtocol = 'DYSON_QUALIFICATION_CONTROLLED_EVIDENCE_V2'
$script:DysonOrchestrationV2IntentProtocol = 'DYSON_QUALIFICATION_ORCHESTRATION_INTENT_V2'
$script:DysonOrchestrationV2ReceiptProtocol = 'DYSON_QUALIFICATION_ORCHESTRATION_RECEIPT_V2'
$script:DysonOrchestrationV2KeyRingProtocol = 'DYSON_QUALIFICATION_ORCHESTRATION_KEYRING_V2'
$script:DysonOrchestrationV2SchemaVersion = 2
$script:DysonOrchestrationV2StoreDirectory = 'qualification-orchestration-v2'
$script:DysonOrchestrationV2ZeroDigest = 'sha256:' + ('0' * 64)
$script:DysonOrchestrationV2ProductionGateName = 'DYSON_QUALIFICATION_ORCHESTRATION_V2'
$script:DysonOrchestrationV2ProductionGateValue = 'ALLOW_PROTECTED_RECEIPT_ADAPTERS_V2'
$script:DysonOrchestrationV2FixtureGateName = 'DYSON_QUALIFICATION_ORCHESTRATION_FIXTURE_V2'
$script:DysonOrchestrationV2FixtureGateValue = 'FIXTURE_ONLY_PROTECTED_RECEIPTS_V2'
$script:DysonOrchestrationV2Actions = @(
    'paired-save-restore',
    'windows-reboot-recovery',
    'update-rollback',
    'side-by-side-deployment',
    'gsmanager-recoverable-switch',
    'gsmanager-removal',
    'six-hour-soak',
    'seventy-two-hour-soak',
    'authenticated-panel',
    'game-protocol-path',
    'external-client-e2e'
)

function New-DysonOrchestrationV2Exception {
    param([Parameter(Mandatory)][string]$Code)
    $exception = New-Object System.InvalidOperationException($Code)
    $exception.Data['Code'] = $Code
    return $exception
}

function Throw-DysonOrchestrationV2Error {
    param([Parameter(Mandatory)][string]$Code)
    throw (New-DysonOrchestrationV2Exception -Code $Code)
}

function Get-DysonOrchestrationV2ErrorCode {
    param([Parameter(Mandatory)][System.Exception]$Exception)
    if ($Exception.Data.Contains('Code')) { return [string]$Exception.Data['Code'] }
    if ([string]$Exception.Message -cmatch '^DYSON_QUALIFICATION_ORCHESTRATION_V2_[A-Z0-9_]+$') {
        return [string]$Exception.Message
    }
    return 'DYSON_QUALIFICATION_ORCHESTRATION_V2_UNEXPECTED_FAILURE'
}

function Assert-DysonOrchestrationV2JsonObjectKeysUnique {
    param([Parameter(Mandatory)][System.Xml.XmlNode]$Node)
    if ($Node.NodeType -ne [System.Xml.XmlNodeType]::Element) { return }
    $typeAttribute = $Node.Attributes['type']
    if ($null -ne $typeAttribute -and [string]$typeAttribute.Value -ceq 'object') {
        $names = New-Object 'System.Collections.Generic.HashSet[string]' ([StringComparer]::Ordinal)
        foreach ($child in @($Node.ChildNodes | Where-Object { $_.NodeType -eq [System.Xml.XmlNodeType]::Element })) {
            $itemAttribute = $child.Attributes['item']
            $name = if ($child.LocalName -ceq 'item' -and $child.NamespaceURI -ceq 'item' -and $null -ne $itemAttribute) {
                [string]$itemAttribute.Value
            }
            else { [string]$child.LocalName }
            if (-not $names.Add($name)) {
                Throw-DysonOrchestrationV2Error -Code 'DYSON_QUALIFICATION_ORCHESTRATION_V2_DUPLICATE_JSON_KEY'
            }
        }
    }
    foreach ($child in @($Node.ChildNodes)) {
        if ($child.NodeType -eq [System.Xml.XmlNodeType]::Element) {
            Assert-DysonOrchestrationV2JsonObjectKeysUnique -Node $child
        }
    }
}

function ConvertFrom-DysonOrchestrationV2StrictJson {
    param(
        [Parameter(Mandatory)][AllowEmptyString()][string]$Text,
        [Parameter(Mandatory)][string]$Code
    )
    $bytes = $null
    $reader = $null
    try {
        Add-Type -AssemblyName System.Runtime.Serialization -ErrorAction Stop
        $bytes = [Text.UTF8Encoding]::new($false, $true).GetBytes($Text)
        $quotas = New-Object System.Xml.XmlDictionaryReaderQuotas
        $quotas.MaxDepth = 64
        $quotas.MaxStringContentLength = [Math]::Max(1024, $bytes.Length)
        $quotas.MaxArrayLength = [Math]::Max(1024, $bytes.Length)
        $quotas.MaxBytesPerRead = [Math]::Min([Math]::Max(4096, $bytes.Length), 1048576)
        $quotas.MaxNameTableCharCount = [Math]::Max(16384, $bytes.Length)
        $reader = [System.Runtime.Serialization.Json.JsonReaderWriterFactory]::CreateJsonReader($bytes, $quotas)
        $document = New-Object System.Xml.XmlDocument
        $document.PreserveWhitespace = $false
        $document.Load($reader)
        Assert-DysonOrchestrationV2JsonObjectKeysUnique -Node $document.DocumentElement
        return $Text | ConvertFrom-Json -ErrorAction Stop
    }
    catch {
        if ($_.Exception.Data.Contains('Code')) { throw }
        Throw-DysonOrchestrationV2Error -Code $Code
    }
    finally {
        if ($null -ne $reader) { $reader.Close() }
        if ($null -ne $bytes) { [Array]::Clear($bytes, 0, $bytes.Length) }
    }
}

function Get-DysonOrchestrationV2UnsignedValue {
    param([Parameter(Mandatory)]$Value, [Parameter(Mandatory)][string[]]$Excluded)
    $unsigned = [ordered]@{}
    foreach ($property in @($Value.PSObject.Properties |
            Where-Object { $Excluded -cnotcontains [string]$_.Name } |
            Sort-Object -Property Name -CaseSensitive)) {
        $unsigned[$property.Name] = $property.Value
    }
    return [pscustomobject]$unsigned
}

function Get-DysonOrchestrationV2SubjectBindingDigest {
    param([Parameter(Mandatory)]$Evidence)
    return Get-DysonQualificationV2ObjectDigest -Value ([pscustomobject][ordered]@{
        protocol = 'DYSON_QUALIFICATION_ORCHESTRATION_SUBJECT_BINDING_V2'
        evidenceId = [string]$Evidence.evidenceId
        requestId = [string]$Evidence.requestId
        approvalId = [string]$Evidence.approvalId
        runId = [string]$Evidence.runId
        profileId = [string]$Evidence.profileId
        profileSha256 = [string]$Evidence.profileSha256
        action = [string]$Evidence.action
        actionTargetId = [string]$Evidence.actionTargetId
        targetIdentity = [string]$Evidence.targetIdentity
        subjectCommit = [string]$Evidence.subjectCommit
        runtimePayloadSha256 = [string]$Evidence.runtimePayloadSha256
        adapterId = [string]$Evidence.adapterId
        verifierId = [string]$Evidence.verifierId
        nonce = [string]$Evidence.nonce
    })
}

function Test-DysonOrchestrationV2Identifier {
    param([AllowNull()][string]$Value)
    if ([string]::IsNullOrWhiteSpace($Value) -or
        $Value -cnotmatch '^[a-z0-9](?:[a-z0-9._-]{6,126}[a-z0-9])$' -or $Value.Contains('..')) {
        return $false
    }
    return $Value.Split('.')[0] -cnotmatch '^(?i:con|prn|aux|nul|com[1-9]|lpt[1-9])$'
}

function Test-DysonOrchestrationV2Commit {
    param([AllowNull()][string]$Value)
    return -not [string]::IsNullOrWhiteSpace($Value) -and $Value -cmatch '^[0-9a-f]{40}$'
}

function Test-DysonOrchestrationV2Hmac {
    param([AllowNull()][string]$Value)
    return -not [string]::IsNullOrWhiteSpace($Value) -and $Value -cmatch '^sha256:[0-9a-f]{64}$'
}

function Test-DysonOrchestrationV2FixedTimeEqual {
    param([Parameter(Mandatory)][string]$Left, [Parameter(Mandatory)][string]$Right)
    $leftBytes = [Text.Encoding]::ASCII.GetBytes($Left)
    $rightBytes = [Text.Encoding]::ASCII.GetBytes($Right)
    try {
        $difference = $leftBytes.Length -bxor $rightBytes.Length
        $maximum = [Math]::Max($leftBytes.Length, $rightBytes.Length)
        for ($index = 0; $index -lt $maximum; $index++) {
            $leftByte = if ($index -lt $leftBytes.Length) { $leftBytes[$index] } else { 0 }
            $rightByte = if ($index -lt $rightBytes.Length) { $rightBytes[$index] } else { 0 }
            $difference = $difference -bor ($leftByte -bxor $rightByte)
        }
        return $difference -eq 0
    }
    finally {
        [Array]::Clear($leftBytes, 0, $leftBytes.Length)
        [Array]::Clear($rightBytes, 0, $rightBytes.Length)
    }
}

function Get-DysonOrchestrationV2HmacValue {
    param([Parameter(Mandatory)][byte[]]$Key, [Parameter(Mandatory)][string]$Text)
    $hmac = New-Object System.Security.Cryptography.HMACSHA256
    $hmac.Key = $Key
    $bytes = [Text.UTF8Encoding]::new($false).GetBytes($Text)
    try {
        return 'sha256:' + ([BitConverter]::ToString($hmac.ComputeHash($bytes)).Replace('-', '').ToLowerInvariant())
    }
    finally {
        [Array]::Clear($bytes, 0, $bytes.Length)
        $hmac.Dispose()
    }
}

function Get-DysonOrchestrationV2Contract {
    $code = 'DYSON_QUALIFICATION_ORCHESTRATION_V2_CONTRACT_INVALID'
    try {
        $path = Join-Path $PSScriptRoot 'fixtures\orchestration-adapter-contract.v2.json'
        $item = Assert-DysonPrivateEvidencePlainFile -Path $path -MaximumBytes 131072
        $contract = ConvertFrom-DysonOrchestrationV2StrictJson `
            -Text ([IO.File]::ReadAllText($item.FullName, [Text.Encoding]::UTF8)) -Code $code
        Assert-DysonQualificationV2ExactProperties -Value $contract -Names @(
            'protocol','schemaVersion','productionMutationImplemented','defaultEnabled','environmentGateName',
            'environmentGateValue','fixtureGateName','fixtureGateValue','maximumResumeAgeSeconds','actions'
        ) -Code $code
        if ([string]$contract.protocol -cne 'DYSON_QUALIFICATION_ORCHESTRATION_ADAPTER_CONTRACT_V2' -or
            -not (Test-DysonQualificationV2Integer -Value $contract.schemaVersion) -or [int]$contract.schemaVersion -ne 2 -or
            $contract.productionMutationImplemented -isnot [bool] -or [bool]$contract.productionMutationImplemented -or
            $contract.defaultEnabled -isnot [bool] -or [bool]$contract.defaultEnabled -or
            [string]$contract.environmentGateName -cne $script:DysonOrchestrationV2ProductionGateName -or
            [string]$contract.environmentGateValue -cne $script:DysonOrchestrationV2ProductionGateValue -or
            [string]$contract.fixtureGateName -cne $script:DysonOrchestrationV2FixtureGateName -or
            [string]$contract.fixtureGateValue -cne $script:DysonOrchestrationV2FixtureGateValue -or
            -not (Test-DysonQualificationV2Integer -Value $contract.maximumResumeAgeSeconds) -or
            [int]$contract.maximumResumeAgeSeconds -ne 86400 -or @($contract.actions).Count -ne $script:DysonOrchestrationV2Actions.Count) {
            throw 'invalid contract'
        }
        $keys = @{}
        $actionKeys = @{}
        foreach ($entry in @($contract.actions)) {
            Assert-DysonQualificationV2ExactProperties -Value $entry -Names @(
                'action','actionKey','adapterId','verifierId','keyId','maximumEvidenceAgeSeconds','timeoutSeconds',
                'minimumElapsedSeconds','maximumElapsedSeconds','minimumSampleCount','maximumSampleGapSeconds',
                'requiresProtectionPoint','rollbackRole','artifacts','requiredCheckCodes'
            ) -Code $code
            if ($script:DysonOrchestrationV2Actions -cnotcontains [string]$entry.action -or
                [string]$entry.actionKey -cnotmatch '^[a-z][A-Za-z0-9]{7,63}$' -or
                -not (Test-DysonOrchestrationV2Identifier -Value ([string]$entry.adapterId)) -or
                -not (Test-DysonOrchestrationV2Identifier -Value ([string]$entry.verifierId)) -or
                -not (Test-DysonOrchestrationV2Identifier -Value ([string]$entry.keyId)) -or
                $keys.ContainsKey([string]$entry.keyId) -or $actionKeys.ContainsKey([string]$entry.actionKey) -or
                -not (Test-DysonQualificationV2Integer -Value $entry.maximumEvidenceAgeSeconds) -or
                -not (Test-DysonQualificationV2Integer -Value $entry.timeoutSeconds) -or
                -not (Test-DysonQualificationV2Integer -Value $entry.minimumElapsedSeconds) -or
                -not (Test-DysonQualificationV2Integer -Value $entry.maximumElapsedSeconds) -or
                -not (Test-DysonQualificationV2Integer -Value $entry.minimumSampleCount) -or
                -not (Test-DysonQualificationV2Integer -Value $entry.maximumSampleGapSeconds) -or
                [int64]$entry.maximumEvidenceAgeSeconds -lt 60 -or [int64]$entry.maximumEvidenceAgeSeconds -gt 86400 -or
                [int64]$entry.timeoutSeconds -lt 60 -or [int64]$entry.timeoutSeconds -gt 345600 -or
                [int64]$entry.minimumElapsedSeconds -lt 1 -or
                [int64]$entry.maximumElapsedSeconds -lt [int64]$entry.minimumElapsedSeconds -or
                [int64]$entry.maximumElapsedSeconds -gt [int64]$entry.timeoutSeconds -or
                [int64]$entry.minimumSampleCount -lt 1 -or [int64]$entry.minimumSampleCount -gt 100000 -or
                [int64]$entry.maximumSampleGapSeconds -lt 0 -or [int64]$entry.maximumSampleGapSeconds -gt 3600 -or
                $entry.requiresProtectionPoint -isnot [bool] -or @($entry.artifacts).Count -lt 1 -or
                @($entry.artifacts).Count -gt 8 -or @($entry.requiredCheckCodes).Count -lt 1 -or
                @($entry.requiredCheckCodes).Count -gt 16) { throw 'invalid contract' }
            $keys[[string]$entry.keyId] = $true
            $actionKeys[[string]$entry.actionKey] = $true
            $roles = @{}
            foreach ($artifact in @($entry.artifacts)) {
                Assert-DysonQualificationV2ExactProperties -Value $artifact -Names @('role','protocol','schemaVersion') -Code $code
                if (-not (Test-DysonOrchestrationV2Identifier -Value ([string]$artifact.role)) -or
                    [string]::IsNullOrWhiteSpace([string]$artifact.protocol) -or [string]$artifact.protocol.Length -gt 96 -or
                    -not (Test-DysonQualificationV2Integer -Value $artifact.schemaVersion) -or
                    [int]$artifact.schemaVersion -lt 0 -or [int]$artifact.schemaVersion -gt 16 -or
                    $roles.ContainsKey([string]$artifact.role)) { throw 'invalid contract' }
                $roles[[string]$artifact.role] = $true
            }
            if ($null -ne $entry.rollbackRole -and
                ($entry.rollbackRole -isnot [string] -or -not $roles.ContainsKey([string]$entry.rollbackRole))) {
                throw 'invalid contract'
            }
            $codes = @($entry.requiredCheckCodes | ForEach-Object { [string]$_ })
            if (@($codes | Sort-Object -Unique).Count -ne $codes.Count -or
                (@($codes | Sort-Object) -join "`n") -cne ($codes -join "`n") -or
                @($codes | Where-Object { $_ -cnotmatch '^[a-z0-9][a-z0-9-]{2,95}$' }).Count -gt 0) {
                throw 'invalid contract'
            }
        }
        foreach ($action in $script:DysonOrchestrationV2Actions) {
            if (@($contract.actions | Where-Object { [string]$_.action -ceq $action }).Count -ne 1) {
                throw 'invalid contract'
            }
        }
        return $contract
    }
    catch {
        if ((Get-DysonOrchestrationV2ErrorCode -Exception $_.Exception) -ceq $code) { throw }
        Throw-DysonOrchestrationV2Error -Code $code
    }
}

function Get-DysonOrchestrationV2ActionContract {
    param([Parameter(Mandatory)][string]$Action)
    if ($script:DysonOrchestrationV2Actions -cnotcontains $Action) {
        Throw-DysonOrchestrationV2Error -Code 'DYSON_QUALIFICATION_ORCHESTRATION_V2_ACTION_NOT_ALLOWLISTED'
    }
    $matches = @((Get-DysonOrchestrationV2Contract).actions | Where-Object { [string]$_.action -ceq $Action })
    if ($matches.Count -ne 1) {
        Throw-DysonOrchestrationV2Error -Code 'DYSON_QUALIFICATION_ORCHESTRATION_V2_CONTRACT_INVALID'
    }
    return $matches[0]
}

function Assert-DysonOrchestrationV2Profile {
    param([Parameter(Mandatory)]$Profile, [datetimeoffset]$NowUtc = [datetimeoffset]::UtcNow, [switch]$AllowExpired)
    $code = 'DYSON_QUALIFICATION_ORCHESTRATION_V2_PROFILE_INVALID'
    Assert-DysonQualificationV2ExactProperties -Value $Profile -Names @(
        'protocol','schemaVersion','profileId','profileLabel','enabled','targetIdentity','subjectCommit',
        'runtimePayloadSha256','expiresAtUtc','stateRoot','evidenceRoot','adapters'
    ) -Code $code
    if ([string]$Profile.protocol -cne $script:DysonOrchestrationV2ProfileProtocol -or
        -not (Test-DysonQualificationV2Integer -Value $Profile.schemaVersion) -or [int]$Profile.schemaVersion -ne 2 -or
        -not (Test-DysonQualificationV2Uuid -Value ([string]$Profile.profileId)) -or
        [string]$Profile.profileLabel -cnotmatch '^[a-z0-9][a-z0-9-]{2,63}$' -or
        $Profile.enabled -isnot [bool] -or
        -not (Test-DysonQualificationV2Digest -Value ([string]$Profile.targetIdentity)) -or
        -not (Test-DysonOrchestrationV2Commit -Value ([string]$Profile.subjectCommit)) -or
        -not (Test-DysonQualificationV2Digest -Value ([string]$Profile.runtimePayloadSha256)) -or
        -not (Test-DysonQualificationV2LocalAbsolutePath -Value ([string]$Profile.stateRoot)) -or
        -not (Test-DysonQualificationV2LocalAbsolutePath -Value ([string]$Profile.evidenceRoot))) {
        Throw-DysonOrchestrationV2Error -Code $code
    }
    $stateRoot = [IO.Path]::GetFullPath([string]$Profile.stateRoot).TrimEnd('\')
    $evidenceRoot = [IO.Path]::GetFullPath([string]$Profile.evidenceRoot).TrimEnd('\')
    if ((Test-DysonQualificationV2PathWithin -Candidate $stateRoot -Parent $evidenceRoot) -or
        (Test-DysonQualificationV2PathWithin -Candidate $evidenceRoot -Parent $stateRoot)) {
        Throw-DysonOrchestrationV2Error -Code 'DYSON_QUALIFICATION_ORCHESTRATION_V2_ROOTS_OVERLAP'
    }
    $expires = ConvertFrom-DysonQualificationV2Utc -Value ([string]$Profile.expiresAtUtc) -Code $code
    if ((-not $AllowExpired -and ($expires -le $NowUtc.AddMinutes(-1) -or $expires -gt $NowUtc.AddDays(31))) -or
        ($AllowExpired -and ($expires -lt $NowUtc.AddDays(-1) -or $expires -gt $NowUtc.AddDays(31)))) {
        Throw-DysonOrchestrationV2Error -Code $code
    }
    $contract = Get-DysonOrchestrationV2Contract
    $expectedKeys = @($contract.actions | ForEach-Object { [string]$_.actionKey })
    Assert-DysonQualificationV2ExactProperties -Value $Profile.adapters -Names $expectedKeys -Code $code
    $targetIds = @{}
    foreach ($entry in @($contract.actions)) {
        $adapter = $Profile.adapters.([string]$entry.actionKey)
        Assert-DysonQualificationV2ExactProperties -Value $adapter -Names @(
            'enabled','actionTargetId','adapterId','verifierId','keyId'
        ) -Code $code
        if ($adapter.enabled -isnot [bool] -or
            -not (Test-DysonOrchestrationV2Identifier -Value ([string]$adapter.actionTargetId)) -or
            [string]$adapter.adapterId -cne [string]$entry.adapterId -or
            [string]$adapter.verifierId -cne [string]$entry.verifierId -or
            [string]$adapter.keyId -cne [string]$entry.keyId -or
            $targetIds.ContainsKey([string]$adapter.actionTargetId)) {
            Throw-DysonOrchestrationV2Error -Code $code
        }
        $targetIds[[string]$adapter.actionTargetId] = $true
    }
    return $true
}

function Get-DysonOrchestrationV2ProfileDigest {
    param([Parameter(Mandatory)]$Profile)
    return Get-DysonQualificationV2ObjectDigest -Value $Profile
}

function Get-DysonOrchestrationV2ActionConfiguration {
    param([Parameter(Mandatory)]$Profile, [Parameter(Mandatory)][string]$Action)
    $contract = Get-DysonOrchestrationV2ActionContract -Action $Action
    return $Profile.adapters.([string]$contract.actionKey)
}

function Get-DysonOrchestrationV2PreviewDigest {
    param([Parameter(Mandatory)]$Request)
    return Get-DysonQualificationV2ObjectDigest -Value ([pscustomobject][ordered]@{
        protocol = 'DYSON_QUALIFICATION_ORCHESTRATION_PREVIEW_BINDING_V2'
        requestId = [string]$Request.requestId
        approvalId = [string]$Request.approvalId
        runId = [string]$Request.runId
        profileId = [string]$Request.profileId
        profileSha256 = [string]$Request.profileSha256
        action = [string]$Request.action
        actionTargetId = [string]$Request.actionTargetId
        executionScope = [string]$Request.executionScope
        targetIdentity = [string]$Request.targetIdentity
        subjectCommit = [string]$Request.subjectCommit
        runtimePayloadSha256 = [string]$Request.runtimePayloadSha256
        issuedAtUtc = [string]$Request.issuedAtUtc
        deadlineAtUtc = [string]$Request.deadlineAtUtc
        evidenceRelativePath = [string]$Request.evidenceRelativePath
        evidenceFileSha256 = [string]$Request.evidenceFileSha256
        predecessorReceiptSha256 = [string]$Request.predecessorReceiptSha256
    })
}

function Get-DysonOrchestrationV2ConfirmationPhrase {
    param(
        [Parameter(Mandatory)][ValidateSet('production','fixture')][string]$ExecutionScope,
        [Parameter(Mandatory)][string]$Action,
        [Parameter(Mandatory)][string]$ProfileId,
        [Parameter(Mandatory)][string]$RunId,
        [Parameter(Mandatory)][string]$RequestId,
        [Parameter(Mandatory)][string]$PreviewSha256
    )
    if (-not (Test-DysonQualificationV2Digest -Value $PreviewSha256)) {
        Throw-DysonOrchestrationV2Error -Code 'DYSON_QUALIFICATION_ORCHESTRATION_V2_PREVIEW_BINDING_INVALID'
    }
    return 'CONSUME DYSON QUALIFICATION ORCHESTRATION ' + $ExecutionScope.ToUpperInvariant() + ' V2 ' +
        $Action.ToUpperInvariant() + ' ' + $ProfileId + ' ' + $RunId + ' ' + $RequestId + ' ' + $PreviewSha256
}

function Assert-DysonOrchestrationV2Request {
    param(
        [Parameter(Mandatory)]$Request,
        [Parameter(Mandatory)]$Profile,
        [datetimeoffset]$NowUtc = [datetimeoffset]::UtcNow,
        [switch]$Resume
    )
    $code = 'DYSON_QUALIFICATION_ORCHESTRATION_V2_REQUEST_INVALID'
    Assert-DysonQualificationV2ExactProperties -Value $Request -Names @(
        'protocol','schemaVersion','requestId','approvalId','runId','profileId','profileSha256','action',
        'actionTargetId','mode','executionScope','targetIdentity','subjectCommit','runtimePayloadSha256',
        'issuedAtUtc','deadlineAtUtc','evidenceRelativePath','evidenceFileSha256','predecessorReceiptSha256',
        'confirmationPhrase','previewSha256'
    ) -Code $code
    if ([string]$Request.protocol -cne $script:DysonOrchestrationV2RequestProtocol -or
        -not (Test-DysonQualificationV2Integer -Value $Request.schemaVersion) -or [int]$Request.schemaVersion -ne 2 -or
        -not (Test-DysonQualificationV2Uuid -Value ([string]$Request.requestId)) -or
        -not (Test-DysonQualificationV2Uuid -Value ([string]$Request.approvalId)) -or
        -not (Test-DysonQualificationV2Uuid -Value ([string]$Request.runId)) -or
        [string]$Request.profileId -cne [string]$Profile.profileId -or
        [string]$Request.profileSha256 -cne (Get-DysonOrchestrationV2ProfileDigest -Profile $Profile) -or
        $script:DysonOrchestrationV2Actions -cnotcontains [string]$Request.action -or
        @('preview','consume') -cnotcontains [string]$Request.mode -or
        @('production','fixture') -cnotcontains [string]$Request.executionScope -or
        [string]$Request.targetIdentity -cne [string]$Profile.targetIdentity -or
        [string]$Request.subjectCommit -cne [string]$Profile.subjectCommit -or
        [string]$Request.runtimePayloadSha256 -cne [string]$Profile.runtimePayloadSha256 -or
        -not (Test-DysonQualificationV2Digest -Value ([string]$Request.evidenceFileSha256)) -or
        -not (Test-DysonQualificationV2Digest -Value ([string]$Request.predecessorReceiptSha256)) -or
        -not (Test-DysonQualificationV2Digest -Value ([string]$Request.previewSha256))) {
        Throw-DysonOrchestrationV2Error -Code $code
    }
    try { [void](Assert-DysonPrivateEvidenceRelativePath -Path ([string]$Request.evidenceRelativePath)) }
    catch { Throw-DysonOrchestrationV2Error -Code 'DYSON_QUALIFICATION_ORCHESTRATION_V2_EVIDENCE_PATH_INVALID' }
    $configuration = Get-DysonOrchestrationV2ActionConfiguration -Profile $Profile -Action ([string]$Request.action)
    if ([string]$Request.actionTargetId -cne [string]$configuration.actionTargetId) {
        Throw-DysonOrchestrationV2Error -Code 'DYSON_QUALIFICATION_ORCHESTRATION_V2_TARGET_MISMATCH'
    }
    if ([string]$Request.previewSha256 -cne (Get-DysonOrchestrationV2PreviewDigest -Request $Request)) {
        Throw-DysonOrchestrationV2Error -Code 'DYSON_QUALIFICATION_ORCHESTRATION_V2_PREVIEW_BINDING_INVALID'
    }
    $issued = ConvertFrom-DysonQualificationV2Utc -Value ([string]$Request.issuedAtUtc) -Code $code
    $deadline = ConvertFrom-DysonQualificationV2Utc -Value ([string]$Request.deadlineAtUtc) -Code $code
    $actionContract = Get-DysonOrchestrationV2ActionContract -Action ([string]$Request.action)
    $ingestionTimeoutSeconds = [Math]::Min(900, [int]$actionContract.timeoutSeconds)
    if ($deadline -le $issued -or $deadline -gt $issued.AddSeconds($ingestionTimeoutSeconds) -or
        $issued -gt $NowUtc.AddMinutes(1) -or
        (-not $Resume -and ($issued -lt $NowUtc.AddMinutes(-15) -or $NowUtc -gt $deadline)) -or
        ($Resume -and $issued -lt $NowUtc.AddSeconds(-86400))) {
        Throw-DysonOrchestrationV2Error -Code 'DYSON_QUALIFICATION_ORCHESTRATION_V2_REQUEST_STALE'
    }
    if ([string]$Request.mode -ceq 'consume') {
        $expected = Get-DysonOrchestrationV2ConfirmationPhrase -ExecutionScope ([string]$Request.executionScope) `
            -Action ([string]$Request.action) -ProfileId ([string]$Request.profileId) -RunId ([string]$Request.runId) `
            -RequestId ([string]$Request.requestId) -PreviewSha256 ([string]$Request.previewSha256)
        if ([string]$Request.confirmationPhrase -cne $expected) {
            Throw-DysonOrchestrationV2Error -Code 'DYSON_QUALIFICATION_ORCHESTRATION_V2_CONFIRMATION_INVALID'
        }
    }
    elseif (-not [string]::IsNullOrEmpty([string]$Request.confirmationPhrase)) {
        Throw-DysonOrchestrationV2Error -Code $code
    }
    return $configuration
}

function Get-DysonOrchestrationV2EvidenceFile {
    param([Parameter(Mandatory)][string]$Root, [Parameter(Mandatory)][string]$RelativePath, [int64]$MaximumBytes = 16777216)
    try {
        $safeRoot = Assert-DysonPrivateEvidenceSafeRoot -Path $Root -Name 'EvidenceRoot'
        [void](Assert-DysonPrivateEvidencePlainDirectory -Path $safeRoot)
        $relative = Assert-DysonPrivateEvidenceRelativePath -Path $RelativePath
        $candidate = [IO.Path]::GetFullPath((Join-Path $safeRoot ($relative.Replace('/', '\'))))
        $prefix = $safeRoot.TrimEnd('\','/') + [IO.Path]::DirectorySeparatorChar
        if (-not $candidate.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)) { throw 'escaped root' }
        return Assert-DysonPrivateEvidencePlainFile -Path $candidate -MaximumBytes $MaximumBytes
    }
    catch { Throw-DysonOrchestrationV2Error -Code 'DYSON_QUALIFICATION_ORCHESTRATION_V2_EVIDENCE_PATH_INVALID' }
}

function Get-DysonOrchestrationV2FileDigest {
    param([Parameter(Mandatory)][string]$Path)
    return 'sha256:' + (Get-DysonPrivateEvidenceFileSha256 -Path $Path)
}

function Read-DysonOrchestrationV2BoundJsonFile {
    param(
        [Parameter(Mandatory)][string]$Path,
        [Parameter(Mandatory)][int64]$MaximumBytes,
        [string]$ExpectedSha256
    )
    $stream = $null
    $sha = $null
    $bytes = $null
    try {
        $item = Assert-DysonPrivateEvidencePlainFile -Path $Path -MaximumBytes $MaximumBytes
        $stream = New-Object IO.FileStream($item.FullName, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
        if ($stream.Length -lt 2 -or $stream.Length -gt $MaximumBytes -or $stream.Length -gt [int]::MaxValue) {
            throw 'invalid length'
        }
        $bytes = New-Object 'byte[]' ([int]$stream.Length)
        $offset = 0
        while ($offset -lt $bytes.Length) {
            $read = $stream.Read($bytes, $offset, $bytes.Length - $offset)
            if ($read -le 0) { throw 'short read' }
            $offset += $read
        }
        if ($stream.ReadByte() -ne -1) { throw 'file changed during read' }
        $sha = [Security.Cryptography.SHA256]::Create()
        $digest = 'sha256:' + ([BitConverter]::ToString($sha.ComputeHash($bytes)).Replace('-', '').ToLowerInvariant())
        if (-not [string]::IsNullOrWhiteSpace($ExpectedSha256) -and $digest -cne $ExpectedSha256) {
            Throw-DysonOrchestrationV2Error -Code 'DYSON_QUALIFICATION_ORCHESTRATION_V2_ARTIFACT_HASH_MISMATCH'
        }
        $text = [Text.UTF8Encoding]::new($false, $true).GetString($bytes)
        $value = ConvertFrom-DysonOrchestrationV2StrictJson -Text $text `
            -Code 'DYSON_QUALIFICATION_ORCHESTRATION_V2_SOURCE_INVALID'
        return [pscustomobject][ordered]@{ value = $value; sha256 = $digest }
    }
    catch {
        if ($_.Exception.Data.Contains('Code')) { throw }
        Throw-DysonOrchestrationV2Error -Code 'DYSON_QUALIFICATION_ORCHESTRATION_V2_SOURCE_INVALID'
    }
    finally {
        if ($null -ne $bytes) { [Array]::Clear($bytes, 0, $bytes.Length) }
        if ($null -ne $sha) { $sha.Dispose() }
        if ($null -ne $stream) { $stream.Dispose() }
    }
}

function Get-DysonOrchestrationV2ArtifactProtocol {
    param([Parameter(Mandatory)]$Value)
    foreach ($name in @('protocol','format')) {
        $property = $Value.PSObject.Properties[$name]
        if ($null -ne $property -and $property.Value -is [string]) { return [string]$property.Value }
    }
    return $null
}

function Get-DysonOrchestrationV2ArtifactId {
    param([Parameter(Mandatory)]$Value)
    foreach ($name in @('receiptId','observationId','requestId','operationId','checkpointId','qualificationId','restoreRequestId')) {
        $property = $Value.PSObject.Properties[$name]
        if ($null -ne $property -and $property.Value -is [string] -and
            (Test-DysonQualificationV2Uuid -Value ([string]$property.Value))) { return [string]$property.Value }
    }
    return $null
}

function Get-DysonOrchestrationV2ArtifactDigest {
    param([Parameter(Mandatory)]$Value)
    foreach ($name in @('receiptSha256','observationSha256','documentSha256','checkpointSha256')) {
        $property = $Value.PSObject.Properties[$name]
        if ($null -ne $property -and $property.Value -is [string]) {
            $digest = [string]$property.Value
            if ($digest -cmatch '^[0-9a-f]{64}$') { return 'sha256:' + $digest }
            if (Test-DysonQualificationV2Digest -Value $digest) { return $digest }
        }
    }
    return $null
}

function Assert-DysonOrchestrationV2ControlledObservation {
    param(
        [Parameter(Mandatory)]$Value,
        [Parameter(Mandatory)]$Artifact,
        [Parameter(Mandatory)]$Evidence
    )
    $code = 'DYSON_QUALIFICATION_ORCHESTRATION_V2_SOURCE_INVALID'
    Assert-DysonQualificationV2ExactProperties -Value $Value -Names @(
        'protocol','schemaVersion','receiptId','runId','action','actionTargetId','targetIdentity','subjectCommit',
        'runtimePayloadSha256','status','observedAtUtc','receiptSha256'
    ) -Code $code
    if ([string]$Value.protocol -cne [string]$Artifact.protocol -or
        [int]$Value.schemaVersion -ne [int]$Artifact.schemaVersion -or
        [string]$Value.receiptId -cne [string]$Artifact.receiptId -or
        [string]$Value.runId -cne [string]$Evidence.runId -or
        [string]$Value.action -cne [string]$Evidence.action -or
        [string]$Value.actionTargetId -cne [string]$Evidence.actionTargetId -or
        [string]$Value.targetIdentity -cne [string]$Evidence.targetIdentity -or
        [string]$Value.subjectCommit -cne [string]$Evidence.subjectCommit -or
        [string]$Value.runtimePayloadSha256 -cne [string]$Evidence.runtimePayloadSha256 -or
        [string]$Value.status -cne 'verified' -or
        -not (Test-DysonQualificationV2Digest -Value ([string]$Value.receiptSha256))) {
        Throw-DysonOrchestrationV2Error -Code $code
    }
    $sourceObserved = ConvertFrom-DysonQualificationV2Utc -Value ([string]$Value.observedAtUtc) -Code $code
    $evidenceObserved = ConvertFrom-DysonQualificationV2Utc -Value ([string]$Evidence.observedAtUtc) -Code $code
    if ([Math]::Abs(($sourceObserved - $evidenceObserved).TotalSeconds) -gt 5) {
        Throw-DysonOrchestrationV2Error -Code $code
    }
    $expected = Get-DysonQualificationV2ObjectDigest -Value `
        (Get-DysonOrchestrationV2UnsignedValue -Value $Value -Excluded @('receiptSha256'))
    if ([string]$Value.receiptSha256 -cne $expected -or [string]$Artifact.receiptSha256 -cne $expected) {
        Throw-DysonOrchestrationV2Error -Code $code
    }
}

function Assert-DysonOrchestrationV2ArtifactSemantics {
    param(
        [Parameter(Mandatory)]$Artifact,
        [Parameter(Mandatory)]$Value,
        [Parameter(Mandatory)]$Evidence,
        [Parameter(Mandatory)][datetimeoffset]$NowUtc,
        [Parameter(Mandatory)][scriptblock]$KeyResolver,
        [Parameter(Mandatory)][string]$ExpectedKeyId
    )
    $role = [string]$Artifact.role
    $code = 'DYSON_QUALIFICATION_ORCHESTRATION_V2_SOURCE_INVALID'
    if ($role -ceq 'panel-observation') {
        try {
            [void](Assert-DysonControlPanelObservationV2 -Observation $Value -ExpectedReceiptId ([string]$Artifact.receiptId) -ExpectedRunId ([string]$Evidence.runId) -ExpectedActionTargetId ([string]$Evidence.actionTargetId) -ExpectedTargetIdentity ([string]$Evidence.targetIdentity) -ExpectedSubjectCommit ([string]$Evidence.subjectCommit) -ExpectedRuntimePayloadSha256 ([string]$Evidence.runtimePayloadSha256) -NowUtc $NowUtc)
            $sourceObserved = ConvertFrom-DysonQualificationV2Utc -Value ([string]$Value.observedAtUtc) -Code $code
            $sourceExpires = ConvertFrom-DysonQualificationV2Utc -Value ([string]$Value.expiresAtUtc) -Code $code
            $evidenceObserved = ConvertFrom-DysonQualificationV2Utc -Value ([string]$Evidence.observedAtUtc) -Code $code
            $evidenceExpires = ConvertFrom-DysonQualificationV2Utc -Value ([string]$Evidence.expiresAtUtc) -Code $code
            if ([Math]::Abs(($sourceObserved - $evidenceObserved).TotalSeconds) -gt 5 -or
                [Math]::Abs(($sourceExpires - $evidenceExpires).TotalSeconds) -gt 5) {
                Throw-DysonOrchestrationV2Error -Code $code
            }
        }
        catch {
            if ($_.Exception.Data.Contains('Code') -and
                [string]$_.Exception.Data['Code'] -ceq $code) { throw }
            Throw-DysonOrchestrationV2Error -Code $code
        }
        return
    }
    if ($role -ceq 'candidate-isolation-observation') {
        $key = $null
        try {
            $expectation = [pscustomobject][ordered]@{
                protocol = 'DYSON_QUALIFICATION_SIDE_BY_SIDE_EXPECTATION_V2'
                schemaVersion = 2
                runId = [string]$Evidence.runId
                actionTargetId = [string]$Evidence.actionTargetId
                targetIdentity = [string]$Evidence.targetIdentity
                releaseId = [string]$Value.deploymentReceipt.releaseId
                subjectCommit = [string]$Evidence.subjectCommit
                artifactHashes = $Value.deploymentReceipt.artifactHashes
                deploymentReceiptSha256 = [string]$Value.deploymentReceipt.receiptSha256
                candidateRootIdentitySha256 = [string]$Value.isolation.candidateRoot.rootIdentitySha256
                gsManagerSnapshotId = [string]$Value.gsManagerSnapshot.snapshotId
                gsManagerSnapshotManifestSha256 = [string]$Value.gsManagerSnapshot.snapshotManifestSha256
                productionPort = [int]$Value.authority.productionPort
                candidatePort = [int]$Value.authority.candidatePort
                keyId = $ExpectedKeyId
            }
            $key = [byte[]](& $KeyResolver $ExpectedKeyId)
            [void](Assert-DysonSideBySideV2Observation -Observation $Value -Expectation $expectation `
                -Key $key -NowUtc $NowUtc)
            if ([string]$Value.receiptId -cne [string]$Artifact.receiptId -or
                [string]$Value.subjectCommit -cne [string]$Evidence.subjectCommit -or
                [string]$Value.runtimePayloadSha256 -cne [string]$Evidence.runtimePayloadSha256 -or
                [string]$Value.protection.keyId -cne $ExpectedKeyId) {
                Throw-DysonOrchestrationV2Error -Code $code
            }
            $sourceObserved = ConvertFrom-DysonQualificationV2Utc `
                -Value ([string]$Value.observationWindow.observedAtUtc) -Code $code
            $sourceExpires = ConvertFrom-DysonQualificationV2Utc `
                -Value ([string]$Value.observationWindow.expiresAtUtc) -Code $code
            $evidenceObserved = ConvertFrom-DysonQualificationV2Utc `
                -Value ([string]$Evidence.observedAtUtc) -Code $code
            $evidenceExpires = ConvertFrom-DysonQualificationV2Utc `
                -Value ([string]$Evidence.expiresAtUtc) -Code $code
            if ([Math]::Abs(($sourceObserved - $evidenceObserved).TotalSeconds) -gt 5 -or
                [Math]::Abs(($sourceExpires - $evidenceExpires).TotalSeconds) -gt 5) {
                Throw-DysonOrchestrationV2Error -Code $code
            }
        }
        catch {
            if ($_.Exception.Data.Contains('Code') -and
                [string]$_.Exception.Data['Code'] -ceq $code) { throw }
            Throw-DysonOrchestrationV2Error -Code $code
        }
        finally { if ($null -ne $key) { [Array]::Clear($key, 0, $key.Length) } }
        return
    }
    if ($role -ceq 'external-join-observation') {
        try {
            [void](Assert-DysonExternalJoinObservationV2 -Observation $Value `
                -ExpectedObservationId ([string]$Artifact.receiptId) `
                -ExpectedRunId ([string]$Evidence.runId) `
                -ExpectedSubjectCommit ([string]$Evidence.subjectCommit) `
                -ExpectedRuntimePayloadSha256 ([string]$Evidence.runtimePayloadSha256) `
                -ExpectedReleaseManifestSha256 ([string]$Value.releaseIdentity.releaseManifestSha256) `
                -ExpectedPublicHost ([string]$Value.publicEndpoint.publicHost) `
                -ExpectedClientPseudonym ([string]$Value.client.clientPseudonym) `
                -ExpectedSaveReceiptSha256 ([string]$Value.saveBinding.saveReceiptSha256) `
                -ExpectedSavePairSha256 ([string]$Value.saveBinding.savePairSha256) `
                -NowUtc $NowUtc)
            $sourceObserved = ConvertFrom-DysonQualificationV2Utc `
                -Value ([string]$Value.observedAtUtc) -Code $code
            $sourceExpires = ConvertFrom-DysonQualificationV2Utc `
                -Value ([string]$Value.expiresAtUtc) -Code $code
            $evidenceObserved = ConvertFrom-DysonQualificationV2Utc `
                -Value ([string]$Evidence.observedAtUtc) -Code $code
            $evidenceExpires = ConvertFrom-DysonQualificationV2Utc `
                -Value ([string]$Evidence.expiresAtUtc) -Code $code
            if ([Math]::Abs(($sourceObserved - $evidenceObserved).TotalSeconds) -gt 5 -or
                [Math]::Abs(($sourceExpires - $evidenceExpires).TotalSeconds) -gt 5) {
                Throw-DysonOrchestrationV2Error -Code $code
            }
        }
        catch {
            if ($_.Exception.Data.Contains('Code') -and
                [string]$_.Exception.Data['Code'] -ceq $code) { throw }
            Throw-DysonOrchestrationV2Error -Code $code
        }
        return
    }
    if ($role -ceq 'post-removal-observation') {
        try {
            $removalArtifacts = @($Evidence.artifacts | Where-Object { [string]$_.role -ceq 'removal-receipt' })
            if ($removalArtifacts.Count -ne 1) { Throw-DysonOrchestrationV2Error -Code $code }
            $removalArtifact = $removalArtifacts[0]
            [void](Assert-DysonPostGsManagerRemovalObservationV2 -Observation $Value `
                -ExpectedObservationId ([string]$Artifact.receiptId) `
                -ExpectedRunId ([string]$Evidence.runId) `
                -ExpectedTargetIdentity ([string]$Evidence.targetIdentity) `
                -ExpectedReleaseVersion ([string]$Value.releaseIdentity.releaseVersion) `
                -ExpectedSubjectCommit ([string]$Evidence.subjectCommit) `
                -ExpectedRuntimePayloadSha256 ([string]$Evidence.runtimePayloadSha256) `
                -ExpectedReleaseManifestSha256 ([string]$Value.releaseIdentity.releaseManifestSha256) `
                -NowUtc $NowUtc)
            if ([string]$Value.removalReceipt.receiptId -cne [string]$removalArtifact.receiptId -or
                [string]$Value.removalReceipt.receiptSha256 -cne [string]$removalArtifact.receiptSha256) {
                Throw-DysonOrchestrationV2Error -Code $code
            }
            $sourceObserved = ConvertFrom-DysonQualificationV2Utc -Value ([string]$Value.observedAtUtc) -Code $code
            $sourceExpires = ConvertFrom-DysonQualificationV2Utc -Value ([string]$Value.expiresAtUtc) -Code $code
            $sourceStarted = ConvertFrom-DysonQualificationV2Utc -Value ([string]$Value.observationWindow.startedAtUtc) -Code $code
            $sourceCompleted = ConvertFrom-DysonQualificationV2Utc -Value ([string]$Value.observationWindow.completedAtUtc) -Code $code
            $evidenceObserved = ConvertFrom-DysonQualificationV2Utc -Value ([string]$Evidence.observedAtUtc) -Code $code
            $evidenceExpires = ConvertFrom-DysonQualificationV2Utc -Value ([string]$Evidence.expiresAtUtc) -Code $code
            $evidenceStarted = ConvertFrom-DysonQualificationV2Utc -Value ([string]$Evidence.assertions.startedAtUtc) -Code $code
            $evidenceCompleted = ConvertFrom-DysonQualificationV2Utc -Value ([string]$Evidence.assertions.completedAtUtc) -Code $code
            $sampleTimes = @(
                $Value.inventory.scannedAtUtc,$Value.management.observedAtUtc,$Value.game.observedAtUtc,
                $Value.reboot.observedAtUtc,$Value.save.observedAtUtc,$Value.recoveryPackage.observedAtUtc,
                $Value.deliverables.observedAtUtc
            ) | ForEach-Object { ConvertFrom-DysonQualificationV2Utc -Value ([string]$_) -Code $code }
            $maximumGap = [int64]0
            for ($sampleIndex = 1; $sampleIndex -lt $sampleTimes.Count; $sampleIndex++) {
                $gap = [int64][Math]::Ceiling(($sampleTimes[$sampleIndex] - $sampleTimes[$sampleIndex - 1]).TotalSeconds)
                if ($gap -gt $maximumGap) { $maximumGap = $gap }
            }
            if ([Math]::Abs(($sourceObserved - $evidenceObserved).TotalSeconds) -gt 5 -or
                [Math]::Abs(($sourceExpires - $evidenceExpires).TotalSeconds) -gt 5 -or
                [Math]::Abs(($sourceStarted - $evidenceStarted).TotalSeconds) -gt 5 -or
                [Math]::Abs(($sourceCompleted - $evidenceCompleted).TotalSeconds) -gt 5 -or
                [int64]$Value.observationWindow.elapsedMonotonicSeconds -ne [int64]$Evidence.assertions.elapsedMonotonicSeconds -or
                [int64]$Evidence.assertions.sampleCount -ne $sampleTimes.Count -or
                [int64]$Evidence.assertions.maximumSampleGapSeconds -ne $maximumGap) {
                Throw-DysonOrchestrationV2Error -Code $code
            }
        }
        catch {
            if ($_.Exception.Data.Contains('Code') -and [string]$_.Exception.Data['Code'] -ceq $code) { throw }
            Throw-DysonOrchestrationV2Error -Code $code
        }
        return
    }
    if ($role -ceq 'soak-observation') {
        try {
            $expectedKind = switch -CaseSensitive ([string]$Evidence.action) {
                'six-hour-soak' { 'six-hour' }
                'seventy-two-hour-soak' { 'seventy-two-hour' }
                default { Throw-DysonOrchestrationV2Error -Code $code }
            }
            [void](Assert-DysonSoakObservationV2 -Observation $Value `
                -ExpectedObservationId ([string]$Artifact.receiptId) `
                -ExpectedKind $expectedKind `
                -ExpectedRunId ([string]$Evidence.runId) `
                -ExpectedTargetIdentity ([string]$Evidence.targetIdentity) `
                -ExpectedReleaseVersion ([string]$Value.releaseIdentity.releaseVersion) `
                -ExpectedSubjectCommit ([string]$Evidence.subjectCommit) `
                -ExpectedRuntimePayloadSha256 ([string]$Evidence.runtimePayloadSha256) `
                -ExpectedReleaseManifestSha256 ([string]$Value.releaseIdentity.releaseManifestSha256) `
                -ExpectedWorkloadProfileSha256 ([string]$Value.workloadProfile.profileSha256) `
                -ExpectedSavePairSha256 ([string]$Value.saveBaseline.savePairSha256) `
                -NowUtc $NowUtc)
            $sourceObserved = ConvertFrom-DysonQualificationV2Utc -Value ([string]$Value.observedAtUtc) -Code $code
            $sourceExpires = ConvertFrom-DysonQualificationV2Utc -Value ([string]$Value.expiresAtUtc) -Code $code
            $sourceStarted = ConvertFrom-DysonQualificationV2Utc -Value ([string]$Value.observationWindow.startedAtUtc) -Code $code
            $sourceCompleted = ConvertFrom-DysonQualificationV2Utc -Value ([string]$Value.observationWindow.completedAtUtc) -Code $code
            $evidenceObserved = ConvertFrom-DysonQualificationV2Utc -Value ([string]$Evidence.observedAtUtc) -Code $code
            $evidenceExpires = ConvertFrom-DysonQualificationV2Utc -Value ([string]$Evidence.expiresAtUtc) -Code $code
            $evidenceStarted = ConvertFrom-DysonQualificationV2Utc -Value ([string]$Evidence.assertions.startedAtUtc) -Code $code
            $evidenceCompleted = ConvertFrom-DysonQualificationV2Utc -Value ([string]$Evidence.assertions.completedAtUtc) -Code $code
            if ([Math]::Abs(($sourceObserved - $evidenceObserved).TotalSeconds) -gt 1 -or
                [Math]::Abs(($sourceExpires - $evidenceExpires).TotalSeconds) -gt 1 -or
                [Math]::Abs(($sourceStarted - $evidenceStarted).TotalSeconds) -gt 1 -or
                [Math]::Abs(($sourceCompleted - $evidenceCompleted).TotalSeconds) -gt 1 -or
                [int64]$Value.observationWindow.elapsedMonotonicSeconds -ne [int64]$Evidence.assertions.elapsedMonotonicSeconds -or
                [int64]$Value.telemetry.sampleCount -ne [int64]$Evidence.assertions.sampleCount -or
                [int64]$Value.telemetry.maximumGapSeconds -ne [int64]$Evidence.assertions.maximumSampleGapSeconds -or
                [string]$Value.externalSession.initialJoinReceiptSha256 -cne [string]$Evidence.assertions.initialJoinReceiptSha256 -or
                [string]$Value.externalSession.reconnectReceiptSha256 -cne [string]$Evidence.assertions.reconnectReceiptSha256 -or
                [string]$Value.observationSha256 -cne [string]$Evidence.assertions.terminalReceiptSha256) {
                Throw-DysonOrchestrationV2Error -Code $code
            }
        }
        catch {
            if ($_.Exception.Data.Contains('Code') -and [string]$_.Exception.Data['Code'] -ceq $code) { throw }
            Throw-DysonOrchestrationV2Error -Code $code
        }
        return
    }
    if ($role -ceq 'restored-world-observation') {
        if ([string]$Evidence.action -cne 'paired-save-restore') {
            Throw-DysonOrchestrationV2Error -Code $code
        }
        # Cross-artifact validation is deferred until all three paired-restore artifacts are bound.
        return
    }
    if ($role -ceq 'reversible-cutover-observation') {
        if ([string]$Evidence.action -cne 'gsmanager-recoverable-switch') {
            Throw-DysonOrchestrationV2Error -Code $code
        }
        # The strict record is checked after both directional switch receipts are loaded.
        return
    }
    if ($role -ceq 'reboot-resume-observation') {
        Assert-DysonOrchestrationV2ControlledObservation -Value $Value -Artifact $Artifact -Evidence $Evidence
        return
    }
    if ($role -in @('restore-receipt','restore-rollback-receipt')) {
        Assert-DysonQualificationV2ExactProperties -Value $Value -Names @(
            'protocol','schemaVersion','recordKind','operation','operationId','requestFingerprint',
            'dataRootIdentity','bundleId','outcome','manifestSha256','protectionManifestSha256','errorCode','completedAt'
        ) -Code $code
        if ([string]$Value.recordKind -cne 'receipt' -or [string]$Value.operation -cne 'restore' -or
            [string]$Value.outcome -cne 'succeeded' -or $null -ne $Value.errorCode -or
            -not (Test-DysonQualificationV2Uuid -Value ([string]$Value.operationId)) -or
            -not (Test-DysonQualificationV2Uuid -Value ([string]$Value.bundleId)) -or
            [string]$Value.requestFingerprint -cnotmatch '^[0-9a-f]{64}$' -or
            [string]$Value.dataRootIdentity -cnotmatch '^sha256:[0-9a-f]{64}$' -or
            [string]$Value.manifestSha256 -cnotmatch '^[0-9a-f]{64}$' -or
            [string]$Value.protectionManifestSha256 -cnotmatch '^[0-9a-f]{64}$') {
            Throw-DysonOrchestrationV2Error -Code $code
        }
        [void](ConvertFrom-DysonQualificationV2Utc -Value ([string]$Value.completedAt) -Code $code)
    }
    elseif ($role -ceq 'update-rollback-receipt') {
        if ([string]$Value.status -cne 'rolled-back' -or $Value.rollbackVerified -isnot [bool] -or
            -not [bool]$Value.rollbackVerified -or $Value.recoveryRequired -isnot [bool] -or
            [bool]$Value.recoveryRequired) { Throw-DysonOrchestrationV2Error -Code $code }
    }
    elseif ($role -in @('cutover-receipt','cutover-rollback-receipt')) {
        try {
            $phase = if ($role -ceq 'cutover-receipt') { 'to-dyson-control' } else { 'back-to-gsmanager' }
            [void](ConvertTo-ReversibleCutoverSwitchReceipt -Raw $Value -ExpectedPhase $phase)
        }
        catch { Throw-DysonOrchestrationV2Error -Code 'DYSON_QUALIFICATION_ORCHESTRATION_V2_REVERSIBLE_CUTOVER_INVALID' }
    }
    elseif ($role -ceq 'removal-receipt') {
        if ([string]$Value.status -cne 'removed') { Throw-DysonOrchestrationV2Error -Code $code }
    }
    elseif ($role -ceq 'removal-restore-receipt') {
        if ([string]$Value.status -cnotin @('restored-disabled','rolled-back') -or
            $Value.activationRequired -isnot [bool] -or -not [bool]$Value.activationRequired) {
            Throw-DysonOrchestrationV2Error -Code $code
        }
    }
    elseif ($role -ceq 'reboot-checkpoint') {
        if ([string]$Value.state -cne 'pre-reboot-checkpoint') { Throw-DysonOrchestrationV2Error -Code $code }
    }
}

function Assert-DysonOrchestrationV2Evidence {
    param(
        [Parameter(Mandatory)]$Evidence,
        [Parameter(Mandatory)]$Request,
        [Parameter(Mandatory)]$Profile,
        [Parameter(Mandatory)][scriptblock]$KeyResolver,
        [datetimeoffset]$NowUtc = [datetimeoffset]::UtcNow
    )
    $code = 'DYSON_QUALIFICATION_ORCHESTRATION_V2_EVIDENCE_INVALID'
    Assert-DysonQualificationV2ExactProperties -Value $Evidence -Names @(
        'protocol','schemaVersion','evidenceId','runId','requestId','approvalId','profileId','profileSha256',
        'action','actionTargetId','targetIdentity','subjectCommit','runtimePayloadSha256','adapterId','verifierId',
        'nonce','observedAtUtc','expiresAtUtc','artifacts','assertions','evidenceSha256','protection'
    ) -Code $code
    $actionContract = Get-DysonOrchestrationV2ActionContract -Action ([string]$Request.action)
    $configuration = Get-DysonOrchestrationV2ActionConfiguration -Profile $Profile -Action ([string]$Request.action)
    if ([string]$Evidence.protocol -cne $script:DysonOrchestrationV2EvidenceProtocol -or
        -not (Test-DysonQualificationV2Integer -Value $Evidence.schemaVersion) -or [int]$Evidence.schemaVersion -ne 2 -or
        -not (Test-DysonQualificationV2Uuid -Value ([string]$Evidence.evidenceId)) -or
        [string]$Evidence.runId -cne [string]$Request.runId -or
        [string]$Evidence.requestId -cne [string]$Request.requestId -or
        [string]$Evidence.approvalId -cne [string]$Request.approvalId -or
        [string]$Evidence.profileId -cne [string]$Profile.profileId -or
        [string]$Evidence.profileSha256 -cne [string]$Request.profileSha256 -or
        [string]$Evidence.action -cne [string]$Request.action -or
        [string]$Evidence.actionTargetId -cne [string]$Request.actionTargetId -or
        [string]$Evidence.targetIdentity -cne [string]$Request.targetIdentity -or
        [string]$Evidence.subjectCommit -cne [string]$Request.subjectCommit -or
        [string]$Evidence.runtimePayloadSha256 -cne [string]$Request.runtimePayloadSha256 -or
        [string]$Evidence.adapterId -cne [string]$configuration.adapterId -or
        [string]$Evidence.verifierId -cne [string]$configuration.verifierId -or
        -not (Test-DysonQualificationV2Uuid -Value ([string]$Evidence.nonce)) -or
        -not (Test-DysonQualificationV2Digest -Value ([string]$Evidence.evidenceSha256))) {
        Throw-DysonOrchestrationV2Error -Code $code
    }
    $observed = ConvertFrom-DysonQualificationV2Utc -Value ([string]$Evidence.observedAtUtc) -Code $code
    $expires = ConvertFrom-DysonQualificationV2Utc -Value ([string]$Evidence.expiresAtUtc) -Code $code
    if ($observed -gt $NowUtc.AddMinutes(1) -or $observed -lt $NowUtc.AddSeconds(-[int]$actionContract.maximumEvidenceAgeSeconds) -or
        $expires -le $observed -or $expires -gt $observed.AddSeconds([int]$actionContract.maximumEvidenceAgeSeconds) -or
        $expires -le $NowUtc) {
        Throw-DysonOrchestrationV2Error -Code 'DYSON_QUALIFICATION_ORCHESTRATION_V2_EVIDENCE_STALE'
    }
    Assert-DysonQualificationV2ExactProperties -Value $Evidence.assertions -Names @(
        'status','checkCodes','startedAtUtc','completedAtUtc','clockClass','elapsedMonotonicSeconds',
        'sampleCount','maximumSampleGapSeconds','protectionPointSha256','rollbackReceiptSha256',
        'subjectBindingSha256','initialJoinReceiptSha256','reconnectReceiptSha256','terminalReceiptSha256'
    ) -Code $code
    if ($Evidence.artifacts -is [string] -or -not ($Evidence.artifacts -is [System.Collections.IEnumerable]) -or
        $Evidence.assertions.checkCodes -is [string] -or
        -not ($Evidence.assertions.checkCodes -is [System.Collections.IEnumerable]) -or
        [string]$Evidence.assertions.status -cne 'verified' -or
        @('bounded-monotonic','real-monotonic') -cnotcontains [string]$Evidence.assertions.clockClass -or
        -not (Test-DysonQualificationV2Integer -Value $Evidence.assertions.elapsedMonotonicSeconds) -or
        -not (Test-DysonQualificationV2Integer -Value $Evidence.assertions.sampleCount) -or
        -not (Test-DysonQualificationV2Integer -Value $Evidence.assertions.maximumSampleGapSeconds)) {
        Throw-DysonOrchestrationV2Error -Code $code
    }
    foreach ($digestName in @('protectionPointSha256','rollbackReceiptSha256','subjectBindingSha256',
            'initialJoinReceiptSha256','reconnectReceiptSha256','terminalReceiptSha256')) {
        if (-not (Test-DysonQualificationV2Digest -Value ([string]$Evidence.assertions.$digestName))) {
            Throw-DysonOrchestrationV2Error -Code $code
        }
    }
    $started = ConvertFrom-DysonQualificationV2Utc -Value ([string]$Evidence.assertions.startedAtUtc) -Code $code
    $completed = ConvertFrom-DysonQualificationV2Utc -Value ([string]$Evidence.assertions.completedAtUtc) -Code $code
    $elapsed = [int64]$Evidence.assertions.elapsedMonotonicSeconds
    $utcElapsed = [Math]::Floor(($completed - $started).TotalSeconds)
    if ($completed -lt $started -or [Math]::Abs($utcElapsed - $elapsed) -gt 5 -or
        [Math]::Abs(($observed - $completed).TotalSeconds) -gt 5 -or
        $elapsed -lt [int64]$actionContract.minimumElapsedSeconds -or
        $elapsed -gt [int64]$actionContract.maximumElapsedSeconds -or
        [int64]$Evidence.assertions.sampleCount -lt [int64]$actionContract.minimumSampleCount -or
        [int64]$Evidence.assertions.maximumSampleGapSeconds -gt [int64]$actionContract.maximumSampleGapSeconds) {
        Throw-DysonOrchestrationV2Error -Code 'DYSON_QUALIFICATION_ORCHESTRATION_V2_EVIDENCE_BOUNDS_INVALID'
    }
    $isSoak = [string]$Evidence.action -in @('six-hour-soak','seventy-two-hour-soak')
    if (($isSoak -and [string]$Evidence.assertions.clockClass -cne 'real-monotonic') -or
        (-not $isSoak -and [string]$Evidence.assertions.clockClass -cne 'bounded-monotonic')) {
        Throw-DysonOrchestrationV2Error -Code 'DYSON_QUALIFICATION_ORCHESTRATION_V2_CLOCK_CLASS_INVALID'
    }
    $expectedSubjectBinding = Get-DysonOrchestrationV2SubjectBindingDigest -Evidence $Evidence
    if ([string]$Evidence.assertions.subjectBindingSha256 -cne $expectedSubjectBinding) {
        Throw-DysonOrchestrationV2Error -Code 'DYSON_QUALIFICATION_ORCHESTRATION_V2_SUBJECT_BINDING_INVALID'
    }
    $actualCodes = @($Evidence.assertions.checkCodes | ForEach-Object { [string]$_ })
    $expectedCodes = @($actionContract.requiredCheckCodes | ForEach-Object { [string]$_ })
    if ($actualCodes.Count -ne $expectedCodes.Count -or ($actualCodes -join "`n") -cne ($expectedCodes -join "`n")) {
        Throw-DysonOrchestrationV2Error -Code 'DYSON_QUALIFICATION_ORCHESTRATION_V2_CHECK_SET_INVALID'
    }
    if ([bool]$actionContract.requiresProtectionPoint) {
        if ([string]$Evidence.assertions.protectionPointSha256 -ceq $script:DysonOrchestrationV2ZeroDigest) {
            Throw-DysonOrchestrationV2Error -Code 'DYSON_QUALIFICATION_ORCHESTRATION_V2_PROTECTION_REQUIRED'
        }
    }
    elseif ([string]$Evidence.assertions.protectionPointSha256 -cne $script:DysonOrchestrationV2ZeroDigest) {
        Throw-DysonOrchestrationV2Error -Code $code
    }
    if (@($Evidence.artifacts).Count -ne @($actionContract.artifacts).Count) {
        Throw-DysonOrchestrationV2Error -Code 'DYSON_QUALIFICATION_ORCHESTRATION_V2_ARTIFACT_SET_INVALID'
    }
    $artifactRoles = @{}
    $artifactPaths = @{}
    $artifactIds = @{}
    $externalObservation = $null
    $pairedObservation = $null
    $pairedObservationArtifact = $null
    $reversibleCutoverObservation = $null
    $reversibleCutoverArtifact = $null
    $postRemovalObservation = $null
    $soakObservation = $null
    $artifactFileDigests = @{}
    $artifactValues = @{}
    $rollbackDigest = $script:DysonOrchestrationV2ZeroDigest
    for ($index = 0; $index -lt @($actionContract.artifacts).Count; $index++) {
        $expectedArtifact = $actionContract.artifacts[$index]
        $artifact = $Evidence.artifacts[$index]
        Assert-DysonQualificationV2ExactProperties -Value $artifact -Names @(
            'role','relativePath','fileSha256','protocol','schemaVersion','receiptId','receiptSha256'
        ) -Code $code
        if ([string]$artifact.role -cne [string]$expectedArtifact.role -or
            [string]$artifact.protocol -cne [string]$expectedArtifact.protocol -or
            -not (Test-DysonQualificationV2Integer -Value $artifact.schemaVersion) -or
            [int]$artifact.schemaVersion -ne [int]$expectedArtifact.schemaVersion -or
            -not (Test-DysonQualificationV2Uuid -Value ([string]$artifact.receiptId)) -or
            -not (Test-DysonQualificationV2Digest -Value ([string]$artifact.fileSha256)) -or
            -not (Test-DysonQualificationV2Digest -Value ([string]$artifact.receiptSha256)) -or
            $artifactRoles.ContainsKey([string]$artifact.role) -or $artifactPaths.ContainsKey([string]$artifact.relativePath) -or
            $artifactIds.ContainsKey([string]$artifact.receiptId)) {
            Throw-DysonOrchestrationV2Error -Code 'DYSON_QUALIFICATION_ORCHESTRATION_V2_ARTIFACT_SET_INVALID'
        }
        $artifactRoles[[string]$artifact.role] = $true
        $artifactPaths[[string]$artifact.relativePath] = $true
        $artifactIds[[string]$artifact.receiptId] = $true
        $file = Get-DysonOrchestrationV2EvidenceFile -Root ([string]$Profile.evidenceRoot) `
            -RelativePath ([string]$artifact.relativePath)
        $boundArtifact = Read-DysonOrchestrationV2BoundJsonFile -Path $file.FullName -MaximumBytes 16777216 `
            -ExpectedSha256 ([string]$artifact.fileSha256)
        $fileDigest = [string]$boundArtifact.sha256
        $value = $boundArtifact.value
        if ([string]$artifact.role -match 'external-transcript$') {
            $receipts = @($value)
            $result = Test-DysonExternalClientTranscript -Receipts $receipts -NowUtc $NowUtc -MaximumTotalSeconds 2400
            $runIds = @($receipts | ForEach-Object { [string]$_.runId } | Select-Object -Unique)
            $failedStatuses = @()
            for ($receiptIndex = 0; $receiptIndex -lt $receipts.Count; $receiptIndex++) {
                $expectedStatus = if ($receiptIndex -eq 10) { 'passed' } else { 'observed' }
                if ([string]$receipts[$receiptIndex].status -cne $expectedStatus) {
                    $failedStatuses += ,[string]$receipts[$receiptIndex].status
                }
            }
            if (-not [bool]$result.valid -or @($receipts).Count -ne 11 -or
                $runIds.Count -ne 1 -or $failedStatuses.Count -ne 0 -or
                [string]$artifact.receiptId -cne [string]$receipts[10].receiptId -or
                [string]$artifact.receiptSha256 -cne ('sha256:' + [string]$receipts[10].receiptSha256)) {
                Throw-DysonOrchestrationV2Error -Code 'DYSON_QUALIFICATION_ORCHESTRATION_V2_EXTERNAL_TRANSCRIPT_INVALID'
            }
        }
        else {
            $actualProtocol = Get-DysonOrchestrationV2ArtifactProtocol -Value $value
            if ([string]$actualProtocol -cne [string]$artifact.protocol) {
                Throw-DysonOrchestrationV2Error -Code 'DYSON_QUALIFICATION_ORCHESTRATION_V2_SOURCE_INVALID'
            }
            $schemaProperty = $value.PSObject.Properties['schemaVersion']
            if ([int]$artifact.schemaVersion -eq 0) {
                if ($null -ne $schemaProperty) { Throw-DysonOrchestrationV2Error -Code 'DYSON_QUALIFICATION_ORCHESTRATION_V2_SOURCE_INVALID' }
            }
            elseif ($null -eq $schemaProperty -or -not (Test-DysonQualificationV2Integer -Value $schemaProperty.Value) -or
                [int]$schemaProperty.Value -ne [int]$artifact.schemaVersion) {
                Throw-DysonOrchestrationV2Error -Code 'DYSON_QUALIFICATION_ORCHESTRATION_V2_SOURCE_INVALID'
            }
            $actualId = Get-DysonOrchestrationV2ArtifactId -Value $value
            if ($null -ne $actualId -and [string]$actualId -cne [string]$artifact.receiptId) {
                Throw-DysonOrchestrationV2Error -Code 'DYSON_QUALIFICATION_ORCHESTRATION_V2_SOURCE_INVALID'
            }
            $actualDigest = Get-DysonOrchestrationV2ArtifactDigest -Value $value
            if ($null -ne $actualDigest) {
                if ([string]$actualDigest -cne [string]$artifact.receiptSha256) {
                    Throw-DysonOrchestrationV2Error -Code 'DYSON_QUALIFICATION_ORCHESTRATION_V2_SOURCE_INVALID'
                }
            }
            elseif ([string]$artifact.receiptSha256 -cne $fileDigest) {
                Throw-DysonOrchestrationV2Error -Code 'DYSON_QUALIFICATION_ORCHESTRATION_V2_SOURCE_INVALID'
            }
            Assert-DysonOrchestrationV2ArtifactSemantics -Artifact $artifact -Value $value -Evidence $Evidence `
                -NowUtc $NowUtc -KeyResolver $KeyResolver -ExpectedKeyId ([string]$configuration.keyId)
            if ([string]$artifact.role -ceq 'external-join-observation') { $externalObservation = $value }
            if ([string]$artifact.role -ceq 'post-removal-observation') { $postRemovalObservation = $value }
            if ([string]$artifact.role -ceq 'soak-observation') { $soakObservation = $value }
            if ([string]$artifact.role -ceq 'restored-world-observation') {
                $pairedObservation = $value
                $pairedObservationArtifact = $artifact
            }
            if ([string]$artifact.role -ceq 'reversible-cutover-observation') {
                $reversibleCutoverObservation = $value
                $reversibleCutoverArtifact = $artifact
            }
        }
        $artifactFileDigests[[string]$artifact.role] = $fileDigest
        $artifactValues[[string]$artifact.role] = $value
        if ($null -ne $actionContract.rollbackRole -and
            [string]$artifact.role -ceq [string]$actionContract.rollbackRole) {
            $rollbackDigest = [string]$artifact.receiptSha256
        }
    }
    if ([string]$Evidence.assertions.rollbackReceiptSha256 -cne $rollbackDigest) {
        Throw-DysonOrchestrationV2Error -Code 'DYSON_QUALIFICATION_ORCHESTRATION_V2_ROLLBACK_BINDING_INVALID'
    }
    if ([string]$Evidence.action -ceq 'paired-save-restore') {
        if ($null -eq $pairedObservation -or $null -eq $pairedObservationArtifact -or
            -not $artifactFileDigests.ContainsKey('restore-receipt') -or
            -not $artifactFileDigests.ContainsKey('restore-rollback-receipt')) {
            Throw-DysonOrchestrationV2Error -Code 'DYSON_QUALIFICATION_ORCHESTRATION_V2_PAIRED_SAVE_INVALID'
        }
        try {
            $pairedResult = Assert-DysonQualificationPairedSaveLoadRecordV2 `
                -Observation $pairedObservation `
                -ExpectedObservationId ([string]$pairedObservationArtifact.receiptId) `
                -ExpectedQualificationRunId ([string]$Evidence.runId) `
                -ExpectedControlRelease ([string]$pairedObservation.controlRelease) `
                -ExpectedSubjectCommit ([string]$Evidence.subjectCommit) `
                -ExpectedRestoreSourceSha256 ([string]$artifactFileDigests['restore-receipt']) `
                -ExpectedProtectionSourceSha256 ([string]$Evidence.assertions.protectionPointSha256) `
                -ExpectedRollbackSourceSha256 ([string]$artifactFileDigests['restore-rollback-receipt']) `
                -ExpectedObservationSha256 ([string]$pairedObservationArtifact.receiptSha256) `
                -ExpectedObservedAtUtc $observed -ExpectedExpiresAtUtc $expires -NowUtc $NowUtc
            $sourceRestore = $artifactValues['restore-receipt']
            $sourceRollback = $artifactValues['restore-rollback-receipt']
            foreach ($binding in @(
                    [pscustomobject]@{ embedded=$pairedObservation.restoreReceipt; source=$sourceRestore },
                    [pscustomobject]@{ embedded=$pairedObservation.rollbackReceipt; source=$sourceRollback })) {
                $embedded = $binding.embedded; $source = $binding.source
                if ([string]$embedded.protocol -cne [string]$source.protocol -or
                    [int64]$embedded.schemaVersion -ne [int64]$source.schemaVersion -or
                    [string]$embedded.operationId -cne [string]$source.operationId -or
                    [string]$embedded.requestFingerprint -cne [string]$source.requestFingerprint -or
                    [string]$embedded.dataRootIdentity -cne [string]$source.dataRootIdentity -or
                    [string]$embedded.bundleId -cne [string]$source.bundleId -or
                    [string]$embedded.manifestSha256 -cne [string]$source.manifestSha256 -or
                    [string]$embedded.protectionManifestSha256 -cne [string]$source.protectionManifestSha256 -or
                    (ConvertFrom-DysonQualificationV2Utc -Value ([string]$embedded.completedAtUtc) -Code $code) -ne
                        (ConvertFrom-DysonQualificationV2Utc -Value ([string]$source.completedAt) -Code $code)) {
                    Throw-DysonOrchestrationV2Error -Code 'DYSON_QUALIFICATION_ORCHESTRATION_V2_PAIRED_SAVE_INVALID'
                }
            }
            if ([string]$pairedResult.protectionPointSha256 -cne
                    (ConvertTo-DysonPairedSaveLoadExpectedRawDigest ([string]$Evidence.assertions.protectionPointSha256)) -or
                [string]$pairedResult.rollbackReceiptSha256 -cne
                    (ConvertTo-DysonPairedSaveLoadExpectedRawDigest ([string]$Evidence.assertions.rollbackReceiptSha256))) {
                Throw-DysonOrchestrationV2Error -Code 'DYSON_QUALIFICATION_ORCHESTRATION_V2_PAIRED_SAVE_INVALID'
            }
        }
        catch { Throw-DysonOrchestrationV2Error -Code 'DYSON_QUALIFICATION_ORCHESTRATION_V2_PAIRED_SAVE_INVALID' }
    }
    if ([string]$Evidence.action -ceq 'gsmanager-recoverable-switch') {
        $reversibleCode = 'DYSON_QUALIFICATION_ORCHESTRATION_V2_REVERSIBLE_CUTOVER_INVALID'
        if ($null -eq $reversibleCutoverObservation -or $null -eq $reversibleCutoverArtifact -or
            -not $artifactValues.ContainsKey('cutover-receipt') -or
            -not $artifactValues.ContainsKey('cutover-rollback-receipt')) {
            Throw-DysonOrchestrationV2Error -Code $reversibleCode
        }
        try {
            $switchTo = ConvertTo-ReversibleCutoverSwitchReceipt `
                -Raw $artifactValues['cutover-receipt'] -ExpectedPhase 'to-dyson-control'
            $switchBack = ConvertTo-ReversibleCutoverSwitchReceipt `
                -Raw $artifactValues['cutover-rollback-receipt'] -ExpectedPhase 'back-to-gsmanager'
            foreach ($bindingName in @(
                    'qualificationRunId','targetIdentity','controlRelease','subjectCommit','runtimePayloadSha256',
                    'releaseManifestSha256','dataRootIdentity','saveGenerationId','authorityInventoryRevision')) {
                if ([string]$switchBack.$bindingName -cne [string]$switchTo.$bindingName) {
                    Throw-DysonOrchestrationV2Error -Code $reversibleCode
                }
            }
            $reversibleResult = Assert-ReversibleCutoverObservationRecordV2 `
                -Observation $reversibleCutoverObservation `
                -ExpectedWindowId ([string]$reversibleCutoverArtifact.receiptId) `
                -ExpectedApprovalId ([string]$Evidence.approvalId) `
                -ExpectedQualificationRunId ([string]$Evidence.runId) `
                -ExpectedTargetIdentity ([string]$Evidence.targetIdentity) `
                -ExpectedControlRelease ([string]$switchTo.controlRelease) `
                -ExpectedSubjectCommit ([string]$Evidence.subjectCommit) `
                -ExpectedRuntimePayloadSha256 ([string]$Evidence.runtimePayloadSha256) `
                -ExpectedReleaseManifestSha256 ([string]$switchTo.releaseManifestSha256) `
                -ExpectedDataRootIdentity ([string]$switchTo.dataRootIdentity) `
                -ExpectedSaveGenerationId ([string]$switchTo.saveGenerationId) `
                -ExpectedAuthorityInventoryRevision ([string]$switchTo.authorityInventoryRevision) `
                -ExpectedSwitchToReceiptId ([string]$switchTo.receiptId) `
                -ExpectedSwitchToSourceSha256 ([string]$artifactFileDigests['cutover-receipt']) `
                -ExpectedSwitchBackReceiptId ([string]$switchBack.receiptId) `
                -ExpectedSwitchBackSourceSha256 ([string]$artifactFileDigests['cutover-rollback-receipt']) `
                -ExpectedProtectionSourceSha256 ([string]$Evidence.assertions.protectionPointSha256) `
                -ExpectedObservationSha256 ([string]$reversibleCutoverArtifact.receiptSha256) `
                -ExpectedObservedAtUtc $observed -ExpectedExpiresAtUtc $expires -NowUtc $NowUtc
            if ((ConvertTo-ReversibleCutoverExpectedRawSha256 ([string]$Evidence.assertions.rollbackReceiptSha256)) -cne
                    [string]$reversibleResult.switchBackReceiptSha256 -or
                [Math]::Abs(((ConvertFrom-DysonQualificationV2Utc -Value ([string]$Evidence.assertions.startedAtUtc) -Code $code) -
                    [datetimeoffset]$reversibleResult.startedAtUtc).TotalSeconds) -gt 5 -or
                [Math]::Abs(((ConvertFrom-DysonQualificationV2Utc -Value ([string]$Evidence.assertions.completedAtUtc) -Code $code) -
                    [datetimeoffset]$reversibleResult.completedAtUtc).TotalSeconds) -gt 5 -or
                [int64]$Evidence.assertions.sampleCount -ne [int64]$reversibleResult.auditSampleCount -or
                [int64]$Evidence.assertions.maximumSampleGapSeconds -ne [int64]$reversibleResult.auditMaximumGapSeconds) {
                Throw-DysonOrchestrationV2Error -Code $reversibleCode
            }
        }
        catch { Throw-DysonOrchestrationV2Error -Code $reversibleCode }
    }
    if ([string]$Evidence.action -ceq 'external-client-e2e') {
        if ($null -eq $externalObservation) {
            Throw-DysonOrchestrationV2Error -Code 'DYSON_QUALIFICATION_ORCHESTRATION_V2_EXTERNAL_BINDING_INVALID'
        }
        $externalStarted = ConvertFrom-DysonQualificationV2Utc `
            -Value ([string]$externalObservation.events[0].observedAtUtc) -Code $code
        $externalCompleted = ConvertFrom-DysonQualificationV2Utc `
            -Value ([string]$externalObservation.observedAtUtc) -Code $code
        $maximumObservedGap = [int64]0
        for ($eventIndex = 1; $eventIndex -lt @($externalObservation.events).Count; $eventIndex++) {
            $previousEventAt = ConvertFrom-DysonQualificationV2Utc `
                -Value ([string]$externalObservation.events[$eventIndex - 1].observedAtUtc) -Code $code
            $eventAt = ConvertFrom-DysonQualificationV2Utc `
                -Value ([string]$externalObservation.events[$eventIndex].observedAtUtc) -Code $code
            $gap = [int64][Math]::Ceiling(($eventAt - $previousEventAt).TotalSeconds)
            if ($gap -gt $maximumObservedGap) { $maximumObservedGap = $gap }
        }
        if ([Math]::Abs(($externalStarted - $started).TotalSeconds) -gt 5 -or
            [Math]::Abs(($externalCompleted - $completed).TotalSeconds) -gt 5 -or
            [int64]$Evidence.assertions.sampleCount -ne @($externalObservation.events).Count -or
            [int64]$Evidence.assertions.maximumSampleGapSeconds -ne $maximumObservedGap -or
            [string]$Evidence.assertions.initialJoinReceiptSha256 -cne ([string]$externalObservation.events[5].evidence.joinReceiptSha256) -or
            [string]$Evidence.assertions.reconnectReceiptSha256 -cne ([string]$externalObservation.events[11].evidence.rejoinReceiptSha256) -or
            [string]$Evidence.assertions.terminalReceiptSha256 -cne ([string]$externalObservation.observationSha256)) {
            Throw-DysonOrchestrationV2Error -Code 'DYSON_QUALIFICATION_ORCHESTRATION_V2_EXTERNAL_BINDING_INVALID'
        }
    }
    elseif ([string]$Evidence.action -ceq 'paired-save-restore') {
        if ([string]$Evidence.assertions.initialJoinReceiptSha256 -cne $script:DysonOrchestrationV2ZeroDigest -or
            [string]$Evidence.assertions.reconnectReceiptSha256 -cne $script:DysonOrchestrationV2ZeroDigest -or
            [string]$Evidence.assertions.terminalReceiptSha256 -cne ('sha256:' + [string]$pairedObservation.observationSha256)) {
            Throw-DysonOrchestrationV2Error -Code 'DYSON_QUALIFICATION_ORCHESTRATION_V2_PAIRED_SAVE_INVALID'
        }
    }
    elseif ([string]$Evidence.action -ceq 'gsmanager-recoverable-switch') {
        if ([string]$Evidence.assertions.initialJoinReceiptSha256 -cne $script:DysonOrchestrationV2ZeroDigest -or
            [string]$Evidence.assertions.reconnectReceiptSha256 -cne $script:DysonOrchestrationV2ZeroDigest -or
            [string]$Evidence.assertions.terminalReceiptSha256 -cne
                ('sha256:' + [string]$reversibleCutoverObservation.observationSha256)) {
            Throw-DysonOrchestrationV2Error -Code 'DYSON_QUALIFICATION_ORCHESTRATION_V2_REVERSIBLE_CUTOVER_INVALID'
        }
    }
    elseif ([string]$Evidence.action -ceq 'gsmanager-removal') {
        if ($null -eq $postRemovalObservation -or
            [string]$Evidence.assertions.initialJoinReceiptSha256 -cne ([string]$postRemovalObservation.game.joinReceiptSha256) -or
            [string]$Evidence.assertions.reconnectReceiptSha256 -cne ([string]$postRemovalObservation.game.reconnectReceiptSha256) -or
            [string]$Evidence.assertions.terminalReceiptSha256 -cne ([string]$postRemovalObservation.observationSha256)) {
            Throw-DysonOrchestrationV2Error -Code 'DYSON_QUALIFICATION_ORCHESTRATION_V2_SOURCE_INVALID'
        }
    }
    elseif ([string]$Evidence.action -in @('six-hour-soak','seventy-two-hour-soak')) {
        if ($null -eq $soakObservation -or
            [string]$Evidence.assertions.initialJoinReceiptSha256 -cne [string]$soakObservation.externalSession.initialJoinReceiptSha256 -or
            [string]$Evidence.assertions.reconnectReceiptSha256 -cne [string]$soakObservation.externalSession.reconnectReceiptSha256 -or
            [string]$Evidence.assertions.terminalReceiptSha256 -cne [string]$soakObservation.observationSha256) {
            Throw-DysonOrchestrationV2Error -Code 'DYSON_QUALIFICATION_ORCHESTRATION_V2_SOURCE_INVALID'
        }
    }
    elseif ([string]$Evidence.assertions.initialJoinReceiptSha256 -cne $script:DysonOrchestrationV2ZeroDigest -or
        [string]$Evidence.assertions.reconnectReceiptSha256 -cne $script:DysonOrchestrationV2ZeroDigest -or
        [string]$Evidence.assertions.terminalReceiptSha256 -cne $script:DysonOrchestrationV2ZeroDigest) {
        Throw-DysonOrchestrationV2Error -Code $code
    }
    Assert-DysonQualificationV2ExactProperties -Value $Evidence.protection -Names @('keyId','hmacSha256') -Code $code
    if ([string]$Evidence.protection.keyId -cne [string]$configuration.keyId -or
        -not (Test-DysonOrchestrationV2Hmac -Value ([string]$Evidence.protection.hmacSha256))) {
        Throw-DysonOrchestrationV2Error -Code 'DYSON_QUALIFICATION_ORCHESTRATION_V2_PROTECTION_INVALID'
    }
    $unsigned = Get-DysonOrchestrationV2UnsignedValue -Value $Evidence -Excluded @('evidenceSha256','protection')
    $expectedEvidenceDigest = Get-DysonQualificationV2ObjectDigest -Value $unsigned
    if ([string]$Evidence.evidenceSha256 -cne $expectedEvidenceDigest) {
        Throw-DysonOrchestrationV2Error -Code 'DYSON_QUALIFICATION_ORCHESTRATION_V2_EVIDENCE_DIGEST_INVALID'
    }
    $key = $null
    try {
        $key = [byte[]](& $KeyResolver ([string]$Evidence.protection.keyId))
        if ($null -eq $key -or $key.Length -lt 32 -or $key.Length -gt 128) {
            Throw-DysonOrchestrationV2Error -Code 'DYSON_QUALIFICATION_ORCHESTRATION_V2_KEY_INVALID'
        }
        $payload = ConvertTo-DysonQualificationV2CanonicalJson -Value ([pscustomobject][ordered]@{
            domain = 'DYSON_QUALIFICATION_CONTROLLED_EVIDENCE_HMAC_V2'
            evidenceSha256 = [string]$Evidence.evidenceSha256
            keyId = [string]$Evidence.protection.keyId
        })
        $expectedHmac = Get-DysonOrchestrationV2HmacValue -Key $key -Text $payload
        if (-not (Test-DysonOrchestrationV2FixedTimeEqual -Left ([string]$Evidence.protection.hmacSha256) -Right $expectedHmac)) {
            Throw-DysonOrchestrationV2Error -Code 'DYSON_QUALIFICATION_ORCHESTRATION_V2_HMAC_INVALID'
        }
    }
    finally { if ($null -ne $key) { [Array]::Clear($key, 0, $key.Length) } }
    return [pscustomobject][ordered]@{
        evidenceId = [string]$Evidence.evidenceId
        evidenceSha256 = [string]$Evidence.evidenceSha256
        nonce = [string]$Evidence.nonce
        sourceBundleSha256 = Get-DysonQualificationV2ObjectDigest -Value @($Evidence.artifacts)
        observedAtUtc = [string]$Evidence.observedAtUtc
        expiresAtUtc = [string]$Evidence.expiresAtUtc
    }
}

function Read-DysonOrchestrationV2JsonFile {
    param([Parameter(Mandatory)][string]$Path, [int64]$MaximumBytes = 1048576)
    try {
        $item = Assert-DysonPrivateEvidencePlainFile -Path $Path -MaximumBytes $MaximumBytes
        return ConvertFrom-DysonOrchestrationV2StrictJson `
            -Text ([IO.File]::ReadAllText($item.FullName, [Text.Encoding]::UTF8)) `
            -Code 'DYSON_QUALIFICATION_ORCHESTRATION_V2_RECORD_INVALID'
    }
    catch { Throw-DysonOrchestrationV2Error -Code 'DYSON_QUALIFICATION_ORCHESTRATION_V2_RECORD_INVALID' }
}

function Import-DysonOrchestrationV2Profile {
    param([Parameter(Mandatory)][string]$Path, [datetimeoffset]$NowUtc = [datetimeoffset]::UtcNow, [switch]$AllowExpired)
    $profile = Read-DysonOrchestrationV2JsonFile -Path $Path -MaximumBytes 262144
    [void](Assert-DysonOrchestrationV2Profile -Profile $profile -NowUtc $NowUtc -AllowExpired:$AllowExpired)
    return $profile
}

function Import-DysonOrchestrationV2Request {
    param([Parameter(Mandatory)][string]$Path)
    return Read-DysonOrchestrationV2JsonFile -Path $Path -MaximumBytes 131072
}

function Get-DysonOrchestrationV2StorePaths {
    param([Parameter(Mandatory)]$Profile, [switch]$Initialize)
    try {
        $stateRoot = Assert-DysonPrivateEvidenceSafeRoot -Path ([string]$Profile.stateRoot) -Name 'StateRoot'
        [void](Assert-DysonPrivateEvidencePlainDirectory -Path $stateRoot)
        $store = Join-Path $stateRoot $script:DysonOrchestrationV2StoreDirectory
        $intents = Join-Path $store 'intents'
        $receipts = Join-Path $store 'receipts'
        if ($Initialize) {
            foreach ($path in @($store,$intents,$receipts)) {
                Assert-DysonPrivateEvidenceNoReparseAncestors -Path $path
                if (-not (Test-Path -LiteralPath $path)) { [void][IO.Directory]::CreateDirectory($path) }
                [void](Assert-DysonPrivateEvidencePlainDirectory -Path $path)
            }
        }
        return [pscustomobject][ordered]@{
            root = $store
            intents = $intents
            receipts = $receipts
            lock = Join-Path $store 'orchestration.lock'
        }
    }
    catch { Throw-DysonOrchestrationV2Error -Code 'DYSON_QUALIFICATION_ORCHESTRATION_V2_STATE_ROOT_INVALID' }
}

function Write-DysonOrchestrationV2AtomicCreateNew {
    param(
        [Parameter(Mandatory)][string]$Path,
        [Parameter(Mandatory)]$Value,
        [Parameter(Mandatory)][ValidateSet('intent','receipt')][string]$Kind,
        [ValidateSet('None','BeforeWrite','AfterFlushBeforeRename','AfterRename')][string]$Injection = 'None'
    )
    $parent = [IO.Path]::GetDirectoryName($Path)
    $temporary = Join-Path $parent ('.' + $Kind + '.atomic-' + [guid]::NewGuid().ToString('N') + '.tmp')
    $stream = $null
    try {
        if ($Injection -ceq 'BeforeWrite') { Throw-DysonOrchestrationV2Error -Code 'DYSON_QUALIFICATION_ORCHESTRATION_V2_TEST_EXIT' }
        $bytes = [Text.UTF8Encoding]::new($false).GetBytes((ConvertTo-DysonQualificationV2CanonicalJson -Value $Value) + "`n")
        $stream = New-Object IO.FileStream($temporary, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
        $stream.Write($bytes, 0, $bytes.Length)
        $stream.Flush($true)
        $stream.Dispose(); $stream = $null
        if ($Injection -ceq 'AfterFlushBeforeRename') { Throw-DysonOrchestrationV2Error -Code 'DYSON_QUALIFICATION_ORCHESTRATION_V2_TEST_EXIT' }
        [IO.File]::Move($temporary, $Path)
        if ($Injection -ceq 'AfterRename') { Throw-DysonOrchestrationV2Error -Code 'DYSON_QUALIFICATION_ORCHESTRATION_V2_TEST_EXIT' }
    }
    catch {
        if ((Get-DysonOrchestrationV2ErrorCode -Exception $_.Exception) -ceq 'DYSON_QUALIFICATION_ORCHESTRATION_V2_TEST_EXIT') { throw }
        Throw-DysonOrchestrationV2Error -Code 'DYSON_QUALIFICATION_ORCHESTRATION_V2_PERSISTENCE_FAILED'
    }
    finally { if ($null -ne $stream) { $stream.Dispose() } }
}

function Assert-DysonOrchestrationV2Intent {
    param([Parameter(Mandatory)]$Intent)
    $code = 'DYSON_QUALIFICATION_ORCHESTRATION_V2_INTENT_INVALID'
    Assert-DysonQualificationV2ExactProperties -Value $Intent -Names @(
        'protocol','schemaVersion','requestId','requestSha256','approvalId','runId','profileId','profileSha256',
        'action','actionTargetId','targetIdentity','evidenceId','evidenceSha256','evidenceFileSha256','nonce',
        'sourceBundleSha256','sequence','predecessorReceiptSha256','state','createdAtUtc','deadlineAtUtc','intentSha256'
    ) -Code $code
    if ([string]$Intent.protocol -cne $script:DysonOrchestrationV2IntentProtocol -or
        [int]$Intent.schemaVersion -ne 2 -or
        -not (Test-DysonQualificationV2Uuid -Value ([string]$Intent.requestId)) -or
        -not (Test-DysonQualificationV2Digest -Value ([string]$Intent.requestSha256)) -or
        -not (Test-DysonQualificationV2Uuid -Value ([string]$Intent.approvalId)) -or
        -not (Test-DysonQualificationV2Uuid -Value ([string]$Intent.runId)) -or
        -not (Test-DysonQualificationV2Uuid -Value ([string]$Intent.profileId)) -or
        -not (Test-DysonQualificationV2Digest -Value ([string]$Intent.profileSha256)) -or
        $script:DysonOrchestrationV2Actions -cnotcontains [string]$Intent.action -or
        -not (Test-DysonOrchestrationV2Identifier -Value ([string]$Intent.actionTargetId)) -or
        -not (Test-DysonQualificationV2Digest -Value ([string]$Intent.targetIdentity)) -or
        -not (Test-DysonQualificationV2Uuid -Value ([string]$Intent.evidenceId)) -or
        -not (Test-DysonQualificationV2Digest -Value ([string]$Intent.evidenceSha256)) -or
        -not (Test-DysonQualificationV2Digest -Value ([string]$Intent.evidenceFileSha256)) -or
        -not (Test-DysonQualificationV2Uuid -Value ([string]$Intent.nonce)) -or
        -not (Test-DysonQualificationV2Digest -Value ([string]$Intent.sourceBundleSha256)) -or
        -not (Test-DysonQualificationV2Integer -Value $Intent.sequence) -or [int64]$Intent.sequence -lt 1 -or
        -not (Test-DysonQualificationV2Digest -Value ([string]$Intent.predecessorReceiptSha256)) -or
        [string]$Intent.state -cne 'validated' -or
        -not (Test-DysonQualificationV2Digest -Value ([string]$Intent.intentSha256))) {
        Throw-DysonOrchestrationV2Error -Code $code
    }
    $created = ConvertFrom-DysonQualificationV2Utc -Value ([string]$Intent.createdAtUtc) -Code $code
    $deadline = ConvertFrom-DysonQualificationV2Utc -Value ([string]$Intent.deadlineAtUtc) -Code $code
    if ($deadline -le $created -or $deadline -gt $created.AddDays(4)) { Throw-DysonOrchestrationV2Error -Code $code }
    $expected = Get-DysonQualificationV2ObjectDigest -Value `
        (Get-DysonOrchestrationV2UnsignedValue -Value $Intent -Excluded @('intentSha256'))
    if ([string]$Intent.intentSha256 -cne $expected) { Throw-DysonOrchestrationV2Error -Code $code }
    return $true
}

function Assert-DysonOrchestrationV2Receipt {
    param([Parameter(Mandatory)]$Receipt)
    $code = 'DYSON_QUALIFICATION_ORCHESTRATION_V2_RECEIPT_INVALID'
    Assert-DysonQualificationV2ExactProperties -Value $Receipt -Names @(
        'protocol','schemaVersion','receiptId','requestId','requestSha256','approvalId','runId','profileId',
        'profileSha256','action','actionTargetId','targetIdentity','subjectCommit','runtimePayloadSha256',
        'evidenceId','evidenceSha256','evidenceFileSha256','nonce','sourceBundleSha256','sequence',
        'predecessorReceiptSha256','intentSha256','status','outcomeCode','observedAtUtc','expiresAtUtc',
        'recordedAtUtc','executionScope','productionChanged','receiptSha256'
    ) -Code $code
    foreach ($uuidName in @('receiptId','requestId','approvalId','runId','profileId','evidenceId','nonce')) {
        if (-not (Test-DysonQualificationV2Uuid -Value ([string]$Receipt.$uuidName))) {
            Throw-DysonOrchestrationV2Error -Code $code
        }
    }
    foreach ($digestName in @('requestSha256','profileSha256','targetIdentity','runtimePayloadSha256','evidenceSha256',
            'evidenceFileSha256','sourceBundleSha256','predecessorReceiptSha256','intentSha256','receiptSha256')) {
        if (-not (Test-DysonQualificationV2Digest -Value ([string]$Receipt.$digestName))) {
            Throw-DysonOrchestrationV2Error -Code $code
        }
    }
    if ([string]$Receipt.protocol -cne $script:DysonOrchestrationV2ReceiptProtocol -or [int]$Receipt.schemaVersion -ne 2 -or
        $script:DysonOrchestrationV2Actions -cnotcontains [string]$Receipt.action -or
        -not (Test-DysonOrchestrationV2Identifier -Value ([string]$Receipt.actionTargetId)) -or
        -not (Test-DysonOrchestrationV2Commit -Value ([string]$Receipt.subjectCommit)) -or
        -not (Test-DysonQualificationV2Integer -Value $Receipt.sequence) -or [int64]$Receipt.sequence -lt 1 -or
        [string]$Receipt.status -cne 'qualified' -or [string]$Receipt.outcomeCode -cne 'PROTECTED_EVIDENCE_ACCEPTED' -or
        @('production','fixture') -cnotcontains [string]$Receipt.executionScope -or
        $Receipt.productionChanged -isnot [bool] -or [bool]$Receipt.productionChanged) {
        Throw-DysonOrchestrationV2Error -Code $code
    }
    $observed = ConvertFrom-DysonQualificationV2Utc -Value ([string]$Receipt.observedAtUtc) -Code $code
    $expires = ConvertFrom-DysonQualificationV2Utc -Value ([string]$Receipt.expiresAtUtc) -Code $code
    $recorded = ConvertFrom-DysonQualificationV2Utc -Value ([string]$Receipt.recordedAtUtc) -Code $code
    if ($expires -le $observed -or $recorded -lt $observed -or $recorded -gt $expires) {
        Throw-DysonOrchestrationV2Error -Code $code
    }
    $expected = Get-DysonQualificationV2ObjectDigest -Value `
        (Get-DysonOrchestrationV2UnsignedValue -Value $Receipt -Excluded @('receiptSha256'))
    if ([string]$Receipt.receiptSha256 -cne $expected) { Throw-DysonOrchestrationV2Error -Code $code }
    return $true
}

function Get-DysonOrchestrationV2State {
    param([Parameter(Mandatory)]$Paths)
    foreach ($directory in @([string]$Paths.intents,[string]$Paths.receipts)) {
        $expectedSuffix = if ($directory -ceq [string]$Paths.intents) { 'intent' } else { 'receipt' }
        foreach ($item in @(Get-ChildItem -LiteralPath $directory -Force -ErrorAction Stop)) {
            if ($item.PSIsContainer -or $item.Name -notmatch ('^[0-9a-f-]{36}\.' + $expectedSuffix + '\.json$')) {
                Throw-DysonOrchestrationV2Error -Code 'DYSON_QUALIFICATION_ORCHESTRATION_V2_RECOVERY_REQUIRED'
            }
        }
    }
    foreach ($item in @(Get-ChildItem -LiteralPath $Paths.root -Force -File -ErrorAction Stop)) {
        if ($item.Name -cne 'orchestration.lock') {
            Throw-DysonOrchestrationV2Error -Code 'DYSON_QUALIFICATION_ORCHESTRATION_V2_RECOVERY_REQUIRED'
        }
    }
    $intents = @{}
    foreach ($item in @(Get-ChildItem -LiteralPath $Paths.intents -Filter '*.intent.json' -File -Force)) {
        $intent = Read-DysonOrchestrationV2JsonFile -Path $item.FullName -MaximumBytes 131072
        [void](Assert-DysonOrchestrationV2Intent -Intent $intent)
        if ($item.Name -cne ([string]$intent.requestId + '.intent.json') -or $intents.ContainsKey([string]$intent.requestId)) {
            Throw-DysonOrchestrationV2Error -Code 'DYSON_QUALIFICATION_ORCHESTRATION_V2_RECOVERY_REQUIRED'
        }
        $intents[[string]$intent.requestId] = $intent
    }
    $receipts = @()
    foreach ($item in @(Get-ChildItem -LiteralPath $Paths.receipts -Filter '*.receipt.json' -File -Force)) {
        $receipt = Read-DysonOrchestrationV2JsonFile -Path $item.FullName -MaximumBytes 131072
        [void](Assert-DysonOrchestrationV2Receipt -Receipt $receipt)
        if ($item.Name -cne ([string]$receipt.requestId + '.receipt.json')) {
            Throw-DysonOrchestrationV2Error -Code 'DYSON_QUALIFICATION_ORCHESTRATION_V2_RECOVERY_REQUIRED'
        }
        $receipts += ,$receipt
    }
    $receipts = @($receipts | Sort-Object -Property @{ Expression = { [int64]$_.sequence } })
    $predecessor = $script:DysonOrchestrationV2ZeroDigest
    $seenReceiptIds = @{}
    $seenEvidenceIds = @{}
    $seenNonces = @{}
    for ($index = 0; $index -lt $receipts.Count; $index++) {
        $receipt = $receipts[$index]
        if ([int64]$receipt.sequence -ne ($index + 1) -or [string]$receipt.predecessorReceiptSha256 -cne $predecessor -or
            $seenReceiptIds.ContainsKey([string]$receipt.receiptId) -or
            $seenEvidenceIds.ContainsKey([string]$receipt.evidenceId) -or $seenNonces.ContainsKey([string]$receipt.nonce) -or
            -not $intents.ContainsKey([string]$receipt.requestId)) {
            Throw-DysonOrchestrationV2Error -Code 'DYSON_QUALIFICATION_ORCHESTRATION_V2_CHAIN_INVALID'
        }
        $intent = $intents[[string]$receipt.requestId]
        if ([string]$intent.intentSha256 -cne [string]$receipt.intentSha256 -or
            [string]$intent.requestSha256 -cne [string]$receipt.requestSha256 -or
            [int64]$intent.sequence -ne [int64]$receipt.sequence -or
            [string]$intent.predecessorReceiptSha256 -cne [string]$receipt.predecessorReceiptSha256 -or
            [string]$intent.evidenceId -cne [string]$receipt.evidenceId -or
            [string]$intent.nonce -cne [string]$receipt.nonce) {
            Throw-DysonOrchestrationV2Error -Code 'DYSON_QUALIFICATION_ORCHESTRATION_V2_CHAIN_INVALID'
        }
        $seenReceiptIds[[string]$receipt.receiptId] = $true
        $seenEvidenceIds[[string]$receipt.evidenceId] = $true
        $seenNonces[[string]$receipt.nonce] = $true
        $predecessor = [string]$receipt.receiptSha256
    }
    $orphans = @($intents.Keys | Where-Object {
        $requestId = [string]$_
        @($receipts | Where-Object { [string]$_.requestId -ceq $requestId }).Count -eq 0
    })
    if ($orphans.Count -gt 1) {
        Throw-DysonOrchestrationV2Error -Code 'DYSON_QUALIFICATION_ORCHESTRATION_V2_RECOVERY_REQUIRED'
    }
    return [pscustomobject][ordered]@{
        intents = $intents
        receipts = $receipts
        orphanRequestIds = $orphans
        predecessorReceiptSha256 = $predecessor
    }
}

function Assert-DysonOrchestrationV2ProductionRoots {
    param([Parameter(Mandatory)]$Profile)
    foreach ($path in @([string]$Profile.stateRoot,[string]$Profile.evidenceRoot)) {
        try {
            $drive = New-Object IO.DriveInfo([IO.Path]::GetPathRoot($path))
            if ($drive.DriveType -ne [IO.DriveType]::Fixed) { throw 'not fixed' }
            [void](Assert-DysonPrivateEvidenceDirectoryAcl -Path $path)
        }
        catch { Throw-DysonOrchestrationV2Error -Code 'DYSON_QUALIFICATION_ORCHESTRATION_V2_PROTECTED_ROOT_INVALID' }
    }
}

function Assert-DysonOrchestrationV2ExecutionGate {
    param([Parameter(Mandatory)]$Profile, [Parameter(Mandatory)]$Request)
    $configuration = Get-DysonOrchestrationV2ActionConfiguration -Profile $Profile -Action ([string]$Request.action)
    if (-not [bool]$Profile.enabled -or -not [bool]$configuration.enabled) {
        Throw-DysonOrchestrationV2Error -Code 'DYSON_QUALIFICATION_ORCHESTRATION_V2_DISABLED'
    }
    if ([string]$Request.executionScope -ceq 'production') {
        if ([Environment]::GetEnvironmentVariable($script:DysonOrchestrationV2ProductionGateName, [EnvironmentVariableTarget]::Process) -cne
            $script:DysonOrchestrationV2ProductionGateValue) {
            Throw-DysonOrchestrationV2Error -Code 'DYSON_QUALIFICATION_ORCHESTRATION_V2_PRODUCTION_GATE_CLOSED'
        }
        Assert-DysonOrchestrationV2ProductionRoots -Profile $Profile
    }
    else {
        if ([Environment]::GetEnvironmentVariable($script:DysonOrchestrationV2FixtureGateName, [EnvironmentVariableTarget]::Process) -cne
            $script:DysonOrchestrationV2FixtureGateValue) {
            Throw-DysonOrchestrationV2Error -Code 'DYSON_QUALIFICATION_ORCHESTRATION_V2_FIXTURE_GATE_CLOSED'
        }
        $temporary = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\','/') + [IO.Path]::DirectorySeparatorChar
        foreach ($path in @([string]$Profile.stateRoot,[string]$Profile.evidenceRoot)) {
            $full = [IO.Path]::GetFullPath($path).TrimEnd('\','/')
            if (-not $full.StartsWith($temporary + 'dyson-qualification-orchestration-v2-selftest-', [StringComparison]::OrdinalIgnoreCase)) {
                Throw-DysonOrchestrationV2Error -Code 'DYSON_QUALIFICATION_ORCHESTRATION_V2_FIXTURE_ROOT_INVALID'
            }
        }
    }
}

function Invoke-DysonQualificationOrchestrationV2 {
    [CmdletBinding(SupportsShouldProcess = $true, ConfirmImpact = 'Medium')]
    param(
        [Parameter(Mandatory)]$Profile,
        [Parameter(Mandatory)]$Request,
        [Parameter(Mandatory)][scriptblock]$KeyResolver,
        [datetimeoffset]$NowUtc = [datetimeoffset]::UtcNow,
        [switch]$Resume,
        [Parameter(DontShow)][ValidateSet('None','IntentAfterRename','ReceiptAfterRename')][string]$Injection = 'None'
    )
    [void](Assert-DysonOrchestrationV2Profile -Profile $Profile -NowUtc $NowUtc -AllowExpired:$Resume)
    [void](Assert-DysonOrchestrationV2Request -Request $Request -Profile $Profile -NowUtc $NowUtc -Resume:$Resume)
    if ([string]$Request.executionScope -ceq 'production') {
        Assert-DysonOrchestrationV2ProductionRoots -Profile $Profile
    }
    $evidenceFile = Get-DysonOrchestrationV2EvidenceFile -Root ([string]$Profile.evidenceRoot) `
        -RelativePath ([string]$Request.evidenceRelativePath) -MaximumBytes 1048576
    $boundEvidence = Read-DysonOrchestrationV2BoundJsonFile -Path $evidenceFile.FullName -MaximumBytes 1048576 `
        -ExpectedSha256 ([string]$Request.evidenceFileSha256)
    $evidenceFileDigest = [string]$boundEvidence.sha256
    $evidence = $boundEvidence.value
    $verified = Assert-DysonOrchestrationV2Evidence -Evidence $evidence -Request $Request -Profile $Profile `
        -KeyResolver $KeyResolver -NowUtc $NowUtc
    $confirmation = Get-DysonOrchestrationV2ConfirmationPhrase -ExecutionScope ([string]$Request.executionScope) `
        -Action ([string]$Request.action) -ProfileId ([string]$Request.profileId) -RunId ([string]$Request.runId) `
        -RequestId ([string]$Request.requestId) -PreviewSha256 ([string]$Request.previewSha256)
    $isPreview = [string]$Request.mode -ceq 'preview'
    $shouldPersist = $false
    if (-not $isPreview) {
        $shouldPersist = $PSCmdlet.ShouldProcess(
            ('qualification-state/' + [string]$Request.requestId),
            ('Persist qualified receipt for ' + [string]$Request.action)
        )
    }
    if ($isPreview -or -not $shouldPersist) {
        return [pscustomobject][ordered]@{
            protocol = $script:DysonOrchestrationV2Protocol
            schemaVersion = 2
            requestId = [string]$Request.requestId
            runId = [string]$Request.runId
            action = [string]$Request.action
            profileId = [string]$Request.profileId
            profileSha256 = [string]$Request.profileSha256
            evidenceId = [string]$verified.evidenceId
            evidenceSha256 = [string]$verified.evidenceSha256
            previewSha256 = [string]$Request.previewSha256
            decision = if ($isPreview) { 'preview-valid' } else { 'what-if' }
            confirmationPhrase = $confirmation
            qualificationStateChanged = $false
            productionChanged = $false
        }
    }
    Assert-DysonOrchestrationV2ExecutionGate -Profile $Profile -Request $Request
    $paths = Get-DysonOrchestrationV2StorePaths -Profile $Profile -Initialize
    $lock = $null
    try {
        $lock = New-Object IO.FileStream($paths.lock, [IO.FileMode]::OpenOrCreate, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)
        $state = Get-DysonOrchestrationV2State -Paths $paths
        $requestSha256 = Get-DysonQualificationV2ObjectDigest -Value $Request
        $existingReceipts = @($state.receipts | Where-Object { [string]$_.requestId -ceq [string]$Request.requestId })
        if ($existingReceipts.Count -gt 0) {
            if ($existingReceipts.Count -ne 1 -or [string]$existingReceipts[0].requestSha256 -cne $requestSha256) {
                Throw-DysonOrchestrationV2Error -Code 'DYSON_QUALIFICATION_ORCHESTRATION_V2_REQUEST_COLLISION'
            }
            return [pscustomobject][ordered]@{
                protocol = $script:DysonOrchestrationV2Protocol
                schemaVersion = 2
                requestId = [string]$Request.requestId
                runId = [string]$Request.runId
                action = [string]$Request.action
                decision = 'qualified'
                reused = $true
                qualificationStateChanged = $false
                productionChanged = $false
                receipt = $existingReceipts[0]
            }
        }
        if (@($state.receipts | Where-Object {
                [string]$_.evidenceId -ceq [string]$verified.evidenceId -or [string]$_.nonce -ceq [string]$verified.nonce
            }).Count -gt 0) {
            Throw-DysonOrchestrationV2Error -Code 'DYSON_QUALIFICATION_ORCHESTRATION_V2_EVIDENCE_REPLAY'
        }
        if (@($state.orphanRequestIds).Count -eq 1 -and [string]$state.orphanRequestIds[0] -cne [string]$Request.requestId) {
            Throw-DysonOrchestrationV2Error -Code 'DYSON_QUALIFICATION_ORCHESTRATION_V2_RECOVERY_REQUIRED'
        }
        $intentPath = Join-Path $paths.intents ([string]$Request.requestId + '.intent.json')
        $receiptPath = Join-Path $paths.receipts ([string]$Request.requestId + '.receipt.json')
        $intent = $null
        if ($state.intents.ContainsKey([string]$Request.requestId)) {
            if (-not $Resume) { Throw-DysonOrchestrationV2Error -Code 'DYSON_QUALIFICATION_ORCHESTRATION_V2_RESUME_REQUIRED' }
            $intent = $state.intents[[string]$Request.requestId]
            if ([string]$intent.requestSha256 -cne $requestSha256 -or
                [string]$intent.evidenceSha256 -cne [string]$verified.evidenceSha256 -or
                [string]$intent.sourceBundleSha256 -cne [string]$verified.sourceBundleSha256) {
                Throw-DysonOrchestrationV2Error -Code 'DYSON_QUALIFICATION_ORCHESTRATION_V2_REQUEST_COLLISION'
            }
        }
        else {
            if ($Resume) { Throw-DysonOrchestrationV2Error -Code 'DYSON_QUALIFICATION_ORCHESTRATION_V2_RESUME_NOT_REQUIRED' }
            if ([string]$Request.predecessorReceiptSha256 -cne [string]$state.predecessorReceiptSha256) {
                Throw-DysonOrchestrationV2Error -Code 'DYSON_QUALIFICATION_ORCHESTRATION_V2_PREDECESSOR_INVALID'
            }
            $intent = [pscustomobject][ordered]@{
                protocol = $script:DysonOrchestrationV2IntentProtocol
                schemaVersion = 2
                requestId = [string]$Request.requestId
                requestSha256 = $requestSha256
                approvalId = [string]$Request.approvalId
                runId = [string]$Request.runId
                profileId = [string]$Request.profileId
                profileSha256 = [string]$Request.profileSha256
                action = [string]$Request.action
                actionTargetId = [string]$Request.actionTargetId
                targetIdentity = [string]$Request.targetIdentity
                evidenceId = [string]$verified.evidenceId
                evidenceSha256 = [string]$verified.evidenceSha256
                evidenceFileSha256 = $evidenceFileDigest
                nonce = [string]$verified.nonce
                sourceBundleSha256 = [string]$verified.sourceBundleSha256
                sequence = @($state.receipts).Count + 1
                predecessorReceiptSha256 = [string]$state.predecessorReceiptSha256
                state = 'validated'
                createdAtUtc = ConvertTo-DysonQualificationV2Utc -Value $NowUtc
                deadlineAtUtc = [string]$Request.deadlineAtUtc
                intentSha256 = $null
            }
            $intent.intentSha256 = Get-DysonQualificationV2ObjectDigest -Value `
                (Get-DysonOrchestrationV2UnsignedValue -Value $intent -Excluded @('intentSha256'))
            [void](Assert-DysonOrchestrationV2Intent -Intent $intent)
            Write-DysonOrchestrationV2AtomicCreateNew -Path $intentPath -Value $intent -Kind intent `
                -Injection $(if ($Injection -ceq 'IntentAfterRename') { 'AfterRename' } else { 'None' })
        }
        $receipt = [pscustomobject][ordered]@{
            protocol = $script:DysonOrchestrationV2ReceiptProtocol
            schemaVersion = 2
            receiptId = [guid]::NewGuid().ToString('D').ToLowerInvariant()
            requestId = [string]$Request.requestId
            requestSha256 = $requestSha256
            approvalId = [string]$Request.approvalId
            runId = [string]$Request.runId
            profileId = [string]$Request.profileId
            profileSha256 = [string]$Request.profileSha256
            action = [string]$Request.action
            actionTargetId = [string]$Request.actionTargetId
            targetIdentity = [string]$Request.targetIdentity
            subjectCommit = [string]$Request.subjectCommit
            runtimePayloadSha256 = [string]$Request.runtimePayloadSha256
            evidenceId = [string]$verified.evidenceId
            evidenceSha256 = [string]$verified.evidenceSha256
            evidenceFileSha256 = $evidenceFileDigest
            nonce = [string]$verified.nonce
            sourceBundleSha256 = [string]$verified.sourceBundleSha256
            sequence = [int64]$intent.sequence
            predecessorReceiptSha256 = [string]$intent.predecessorReceiptSha256
            intentSha256 = [string]$intent.intentSha256
            status = 'qualified'
            outcomeCode = 'PROTECTED_EVIDENCE_ACCEPTED'
            observedAtUtc = [string]$verified.observedAtUtc
            expiresAtUtc = [string]$verified.expiresAtUtc
            recordedAtUtc = ConvertTo-DysonQualificationV2Utc -Value $NowUtc
            executionScope = [string]$Request.executionScope
            productionChanged = $false
            receiptSha256 = $null
        }
        $receipt.receiptSha256 = Get-DysonQualificationV2ObjectDigest -Value `
            (Get-DysonOrchestrationV2UnsignedValue -Value $receipt -Excluded @('receiptSha256'))
        [void](Assert-DysonOrchestrationV2Receipt -Receipt $receipt)
        Write-DysonOrchestrationV2AtomicCreateNew -Path $receiptPath -Value $receipt -Kind receipt `
            -Injection $(if ($Injection -ceq 'ReceiptAfterRename') { 'AfterRename' } else { 'None' })
        return [pscustomobject][ordered]@{
            protocol = $script:DysonOrchestrationV2Protocol
            schemaVersion = 2
            requestId = [string]$Request.requestId
            runId = [string]$Request.runId
            action = [string]$Request.action
            decision = 'qualified'
            reused = $false
            qualificationStateChanged = $true
            productionChanged = $false
            receipt = $receipt
        }
    }
    finally { if ($null -ne $lock) { $lock.Dispose() } }
}
