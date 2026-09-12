# Copyright (c) Dyson Control contributors.
# Strict, read-only side-by-side deployment observation protocol for PRD-001.

Set-StrictMode -Version 2.0

. (Join-Path $PSScriptRoot 'Qualification.ProtocolV2.ps1')

$script:DysonSideBySideV2Protocol = 'DYSON_QUALIFICATION_SIDE_BY_SIDE_OBSERVATION_V2'
$script:DysonSideBySideV2CaptureProtocol = 'DYSON_QUALIFICATION_SIDE_BY_SIDE_CAPTURE_V2'
$script:DysonSideBySideV2ExpectationProtocol = 'DYSON_QUALIFICATION_SIDE_BY_SIDE_EXPECTATION_V2'
$script:DysonSideBySideV2KeyProtocol = 'DYSON_QUALIFICATION_SIDE_BY_SIDE_KEY_V2'
$script:DysonSideBySideV2DeploymentReceiptProtocol = 'DYSON_CONTROL_CANDIDATE_DEPLOYMENT_RECEIPT_V2'
$script:DysonSideBySideV2HealthProtocol = 'DYSON_QUALIFICATION_SIDE_BY_SIDE_HEALTH_OBSERVATION_V2'
$script:DysonSideBySideV2RuntimeProtocol = 'DYSON_QUALIFICATION_SIDE_BY_SIDE_RUNTIME_IDENTITY_V2'
$script:DysonSideBySideV2SnapshotProtocol = 'DYSON_QUALIFICATION_GSMANAGER_SNAPSHOT_VERIFICATION_V2'
$script:DysonSideBySideV2AuthorityProtocol = 'DYSON_QUALIFICATION_SIDE_BY_SIDE_AUTHORITY_OBSERVATION_V2'
$script:DysonSideBySideV2RootIdentityProtocol = 'DYSON_QUALIFICATION_ROOT_IDENTITY_V2'
$script:DysonSideBySideV2SchemaVersion = 2
$script:DysonSideBySideV2MaximumAgeSeconds = 14400
$script:DysonSideBySideV2CheckCodes = @(
    'candidate-deployment-receipt-bound',
    'candidate-release-and-artifacts-bound',
    'candidate-ntfs-root-isolated',
    'candidate-health-read-only-verified',
    'candidate-runtime-identity-verified',
    'gsmanager-snapshot-recoverable',
    'gsmanager-authority-unchanged',
    'no-switch-intent-observed',
    'no-production-port-takeover-observed',
    'observation-window-current'
)

function New-DysonSideBySideV2Exception {
    param([Parameter(Mandatory)][string]$Code)
    $exception = New-Object System.InvalidOperationException($Code)
    $exception.Data['Code'] = $Code
    return $exception
}

function Throw-DysonSideBySideV2Error {
    param([Parameter(Mandatory)][string]$Code)
    throw (New-DysonSideBySideV2Exception -Code $Code)
}

function Get-DysonSideBySideV2ErrorCode {
    param([Parameter(Mandatory)][System.Exception]$Exception)
    if ($Exception.Data.Contains('Code')) { return [string]$Exception.Data['Code'] }
    if ([string]$Exception.Message -cmatch '^DYSON_QUALIFICATION_SIDE_BY_SIDE_V2_[A-Z0-9_]+$') {
        return [string]$Exception.Message
    }
    return 'DYSON_QUALIFICATION_SIDE_BY_SIDE_V2_UNEXPECTED_FAILURE'
}

function Assert-DysonSideBySideV2ExactProperties {
    param([Parameter(Mandatory)]$Value, [Parameter(Mandatory)][string[]]$Names, [Parameter(Mandatory)][string]$Code)
    try { Assert-DysonQualificationV2ExactProperties -Value $Value -Names $Names -Code $Code }
    catch { Throw-DysonSideBySideV2Error -Code $Code }
}

function Assert-DysonSideBySideV2JsonObjectKeysUnique {
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
                Throw-DysonSideBySideV2Error -Code 'DYSON_QUALIFICATION_SIDE_BY_SIDE_V2_DUPLICATE_JSON_KEY'
            }
        }
    }
    foreach ($child in @($Node.ChildNodes)) {
        if ($child.NodeType -eq [System.Xml.XmlNodeType]::Element) {
            Assert-DysonSideBySideV2JsonObjectKeysUnique -Node $child
        }
    }
}

function ConvertFrom-DysonSideBySideV2StrictJson {
    param([Parameter(Mandatory)][AllowEmptyString()][string]$Text, [Parameter(Mandatory)][string]$Code)
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
        Assert-DysonSideBySideV2JsonObjectKeysUnique -Node $document.DocumentElement
        if ((Get-Command ConvertFrom-Json -ErrorAction Stop).Parameters.ContainsKey('DateKind')) {
            return $Text | ConvertFrom-Json -DateKind String -ErrorAction Stop
        }
        return $Text | ConvertFrom-Json -ErrorAction Stop
    }
    catch {
        if ($_.Exception.Data.Contains('Code')) { throw }
        Throw-DysonSideBySideV2Error -Code $Code
    }
    finally {
        if ($null -ne $reader) { $reader.Dispose() }
        if ($null -ne $bytes) { [Array]::Clear($bytes, 0, $bytes.Length) }
    }
}

function Read-DysonSideBySideV2JsonFile {
    param([Parameter(Mandatory)][string]$Path, [int64]$MaximumBytes = 1048576)
    try {
        $full = [IO.Path]::GetFullPath($Path)
        $item = Get-Item -LiteralPath $full -Force -ErrorAction Stop
        if ($item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -or
            [int64]$item.Length -lt 2 -or [int64]$item.Length -gt $MaximumBytes) {
            Throw-DysonSideBySideV2Error -Code 'DYSON_QUALIFICATION_SIDE_BY_SIDE_V2_FILE_INVALID'
        }
        $text = [IO.File]::ReadAllText($item.FullName, [Text.UTF8Encoding]::new($false, $true))
        return ConvertFrom-DysonSideBySideV2StrictJson -Text $text `
            -Code 'DYSON_QUALIFICATION_SIDE_BY_SIDE_V2_JSON_INVALID'
    }
    catch {
        if ($_.Exception.Data.Contains('Code')) { throw }
        Throw-DysonSideBySideV2Error -Code 'DYSON_QUALIFICATION_SIDE_BY_SIDE_V2_FILE_INVALID'
    }
}

function Get-DysonSideBySideV2UnsignedValue {
    param([Parameter(Mandatory)]$Value, [Parameter(Mandatory)][string[]]$Excluded)
    $result = [ordered]@{}
    foreach ($property in @($Value.PSObject.Properties | Where-Object { $_.Name -cnotin $Excluded })) {
        $result[$property.Name] = $property.Value
    }
    return [pscustomobject]$result
}

function Test-DysonSideBySideV2Identifier {
    param([AllowNull()][string]$Value)
    return -not [string]::IsNullOrWhiteSpace($Value) -and $Value -cmatch '^[a-z0-9][a-z0-9.-]{2,63}$'
}

function Test-DysonSideBySideV2Commit {
    param([AllowNull()][string]$Value)
    return -not [string]::IsNullOrWhiteSpace($Value) -and $Value -cmatch '^[0-9a-f]{40}$'
}

function Test-DysonSideBySideV2AbsolutePath {
    param([AllowNull()][string]$Value, [switch]$LocalOnly)
    if ([string]::IsNullOrWhiteSpace($Value) -or $Value.Length -gt 240 -or $Value -match '[*?]' -or
        $Value -match '(^|\\)\.\.(\\|$)') { return $false }
    if ($LocalOnly) {
        if ($Value -cnotmatch '^[A-Z]:\\') { return $false }
    }
    elseif ($Value -cnotmatch '^(?:[A-Z]:\\|\\\\[A-Za-z0-9.-]+\\[^\\]+\\)') { return $false }
    try { return [IO.Path]::GetFullPath($Value).TrimEnd('\') -ceq $Value }
    catch { return $false }
}

function Test-DysonSideBySideV2PathWithin {
    param([Parameter(Mandatory)][string]$Candidate, [Parameter(Mandatory)][string]$Parent)
    try {
        $candidateFull = [IO.Path]::GetFullPath($Candidate).TrimEnd('\')
        $parentFull = [IO.Path]::GetFullPath($Parent).TrimEnd('\')
        if ($candidateFull.Equals($parentFull, [StringComparison]::OrdinalIgnoreCase)) { return $true }
        return $candidateFull.StartsWith($parentFull + '\', [StringComparison]::OrdinalIgnoreCase)
    }
    catch { return $false }
}

function Get-DysonSideBySideV2RootIdentityDigest {
    param([Parameter(Mandatory)]$Root)
    return Get-DysonQualificationV2ObjectDigest -Value ([pscustomobject][ordered]@{
        protocol = $script:DysonSideBySideV2RootIdentityProtocol
        canonicalPath = [string]$Root.canonicalPath
        fileSystem = [string]$Root.fileSystem
        driveType = [string]$Root.driveType
        volumeIdentitySha256 = [string]$Root.volumeIdentitySha256
    })
}

function Get-DysonSideBySideV2Hmac {
    param([Parameter(Mandatory)][byte[]]$Key, [Parameter(Mandatory)][string]$Text)
    $hmac = [Security.Cryptography.HMACSHA256]::new($Key)
    try {
        $bytes = [Text.UTF8Encoding]::new($false).GetBytes($Text)
        $digest = $hmac.ComputeHash($bytes)
        return 'sha256:' + ([BitConverter]::ToString($digest).Replace('-', '').ToLowerInvariant())
    }
    finally { $hmac.Dispose() }
}

function Test-DysonSideBySideV2FixedTimeEqual {
    param([Parameter(Mandatory)][string]$Left, [Parameter(Mandatory)][string]$Right)
    if ($Left.Length -ne $Right.Length) { return $false }
    $difference = 0
    for ($index = 0; $index -lt $Left.Length; $index++) {
        $difference = $difference -bor ([int][char]$Left[$index] -bxor [int][char]$Right[$index])
    }
    return $difference -eq 0
}

function Import-DysonSideBySideV2Key {
    param([Parameter(Mandatory)][string]$Path, [Parameter(Mandatory)][string]$ExpectedKeyId)
    $value = Read-DysonSideBySideV2JsonFile -Path $Path -MaximumBytes 4096
    Assert-DysonSideBySideV2ExactProperties -Value $value `
        -Names @('protocol','schemaVersion','keyId','keyBase64') `
        -Code 'DYSON_QUALIFICATION_SIDE_BY_SIDE_V2_KEY_INVALID'
    if ([string]$value.protocol -cne $script:DysonSideBySideV2KeyProtocol -or
        -not (Test-DysonQualificationV2Integer -Value $value.schemaVersion) -or [int]$value.schemaVersion -ne 2 -or
        [string]$value.keyId -cne $ExpectedKeyId -or -not (Test-DysonSideBySideV2Identifier -Value ([string]$value.keyId))) {
        Throw-DysonSideBySideV2Error -Code 'DYSON_QUALIFICATION_SIDE_BY_SIDE_V2_KEY_INVALID'
    }
    try { $key = [Convert]::FromBase64String([string]$value.keyBase64) }
    catch { Throw-DysonSideBySideV2Error -Code 'DYSON_QUALIFICATION_SIDE_BY_SIDE_V2_KEY_INVALID' }
    if ($key.Length -lt 32 -or $key.Length -gt 128) {
        if ($key.Length -gt 0) { [Array]::Clear($key, 0, $key.Length) }
        Throw-DysonSideBySideV2Error -Code 'DYSON_QUALIFICATION_SIDE_BY_SIDE_V2_KEY_INVALID'
    }
    return ,$key
}

function Assert-DysonSideBySideV2ArtifactHashes {
    param([Parameter(Mandatory)]$Value, [Parameter(Mandatory)][string]$Code)
    Assert-DysonSideBySideV2ExactProperties -Value $Value -Names @(
        'releasePackageSha256','artifactPayloadSha256','runtimePayloadSha256','manifestSha256'
    ) -Code $Code
    foreach ($name in @('releasePackageSha256','artifactPayloadSha256','runtimePayloadSha256','manifestSha256')) {
        if (-not (Test-DysonQualificationV2Digest -Value ([string]$Value.$name))) {
            Throw-DysonSideBySideV2Error -Code $Code
        }
    }
}

function Assert-DysonSideBySideV2Root {
    param([Parameter(Mandatory)]$Value, [Parameter(Mandatory)][string]$Code, [switch]$Candidate)
    Assert-DysonSideBySideV2ExactProperties -Value $Value -Names @(
        'canonicalPath','fileSystem','driveType','volumeIdentitySha256','rootIdentitySha256','reparseFree'
    ) -Code $Code
    if (-not (Test-DysonSideBySideV2AbsolutePath -Value ([string]$Value.canonicalPath) -LocalOnly:$Candidate) -or
        @('NTFS','SMB') -cnotcontains [string]$Value.fileSystem -or
        @('Fixed','Network') -cnotcontains [string]$Value.driveType -or
        -not (Test-DysonQualificationV2Digest -Value ([string]$Value.volumeIdentitySha256)) -or
        -not (Test-DysonQualificationV2Digest -Value ([string]$Value.rootIdentitySha256)) -or
        $Value.reparseFree -isnot [bool] -or -not [bool]$Value.reparseFree -or
        [string]$Value.rootIdentitySha256 -cne (Get-DysonSideBySideV2RootIdentityDigest -Root $Value)) {
        Throw-DysonSideBySideV2Error -Code $Code
    }
    if ($Candidate -and ([string]$Value.fileSystem -cne 'NTFS' -or [string]$Value.driveType -cne 'Fixed')) {
        Throw-DysonSideBySideV2Error -Code 'DYSON_QUALIFICATION_SIDE_BY_SIDE_V2_CANDIDATE_ROOT_NOT_LOCAL_NTFS'
    }
}

function Assert-DysonSideBySideV2DeploymentReceipt {
    param([Parameter(Mandatory)]$Value)
    $code = 'DYSON_QUALIFICATION_SIDE_BY_SIDE_V2_DEPLOYMENT_RECEIPT_INVALID'
    Assert-DysonSideBySideV2ExactProperties -Value $Value -Names @(
        'protocol','schemaVersion','receiptId','state','releaseId','subjectCommit','completedAtUtc',
        'artifactHashes','candidateRootIdentitySha256','receiptSha256'
    ) -Code $code
    Assert-DysonSideBySideV2ArtifactHashes -Value $Value.artifactHashes `
        -Code 'DYSON_QUALIFICATION_SIDE_BY_SIDE_V2_DEPLOYMENT_ARTIFACT_HASHES_INVALID'
    if ([string]$Value.protocol -cne $script:DysonSideBySideV2DeploymentReceiptProtocol -or
        -not (Test-DysonQualificationV2Integer -Value $Value.schemaVersion) -or [int]$Value.schemaVersion -ne 2 -or
        -not (Test-DysonQualificationV2Uuid -Value ([string]$Value.receiptId)) -or
        [string]$Value.state -cne 'installed' -or
        -not (Test-DysonSideBySideV2Identifier -Value ([string]$Value.releaseId)) -or
        -not (Test-DysonSideBySideV2Commit -Value ([string]$Value.subjectCommit)) -or
        -not (Test-DysonQualificationV2Digest -Value ([string]$Value.candidateRootIdentitySha256)) -or
        -not (Test-DysonQualificationV2Digest -Value ([string]$Value.receiptSha256))) {
        Throw-DysonSideBySideV2Error -Code $code
    }
    [void](ConvertFrom-DysonQualificationV2Utc -Value ([string]$Value.completedAtUtc) -Code $code)
    $expected = Get-DysonQualificationV2ObjectDigest -Value `
        (Get-DysonSideBySideV2UnsignedValue -Value $Value -Excluded @('receiptSha256'))
    if ([string]$Value.receiptSha256 -cne $expected) {
        Throw-DysonSideBySideV2Error -Code 'DYSON_QUALIFICATION_SIDE_BY_SIDE_V2_DEPLOYMENT_RECEIPT_DIGEST_INVALID'
    }
}

function Assert-DysonSideBySideV2Isolation {
    param([Parameter(Mandatory)]$Value, [Parameter(Mandatory)][datetimeoffset]$ObservedAt)
    $code = 'DYSON_QUALIFICATION_SIDE_BY_SIDE_V2_ISOLATION_INVALID'
    Assert-DysonSideBySideV2ExactProperties -Value $Value `
        -Names @('candidateRoot','productionDataRoot','gsManagerRoot','evaluatedAtUtc') -Code $code
    Assert-DysonSideBySideV2Root -Value $Value.candidateRoot -Code $code -Candidate
    Assert-DysonSideBySideV2Root -Value $Value.productionDataRoot -Code $code
    Assert-DysonSideBySideV2Root -Value $Value.gsManagerRoot -Code $code
    $roots = @($Value.candidateRoot, $Value.productionDataRoot, $Value.gsManagerRoot)
    if (@($roots | ForEach-Object { [string]$_.rootIdentitySha256 } | Select-Object -Unique).Count -ne 3) {
        Throw-DysonSideBySideV2Error -Code $code
    }
    foreach ($other in @($Value.productionDataRoot, $Value.gsManagerRoot)) {
        if ((Test-DysonSideBySideV2PathWithin -Candidate ([string]$Value.candidateRoot.canonicalPath) -Parent ([string]$other.canonicalPath)) -or
            (Test-DysonSideBySideV2PathWithin -Candidate ([string]$other.canonicalPath) -Parent ([string]$Value.candidateRoot.canonicalPath))) {
            Throw-DysonSideBySideV2Error -Code $code
        }
    }
    $evaluated = ConvertFrom-DysonQualificationV2Utc -Value ([string]$Value.evaluatedAtUtc) -Code $code
    if ([Math]::Abs(($evaluated - $ObservedAt).TotalSeconds) -gt 5) { Throw-DysonSideBySideV2Error -Code $code }
}

function Assert-DysonSideBySideV2Health {
    param([Parameter(Mandatory)]$Value, [Parameter(Mandatory)]$Capture, [Parameter(Mandatory)][datetimeoffset]$ObservedAt)
    $code = 'DYSON_QUALIFICATION_SIDE_BY_SIDE_V2_HEALTH_INVALID'
    Assert-DysonSideBySideV2ExactProperties -Value $Value -Names @(
        'protocol','schemaVersion','observerClass','probeClass','requestMethod','addressClass','mutationAttempted',
        'status','httpStatus','responseSha256','deploymentReceiptSha256','releaseId','subjectCommit',
        'runtimePayloadSha256','observedAtUtc'
    ) -Code $code
    if ([string]$Value.protocol -cne $script:DysonSideBySideV2HealthProtocol -or
        -not (Test-DysonQualificationV2Integer -Value $Value.schemaVersion) -or [int]$Value.schemaVersion -ne 2 -or
        [string]$Value.observerClass -cne 'independent-read-only-host-observer' -or
        [string]$Value.probeClass -cne 'loopback-readyz-read-only' -or [string]$Value.requestMethod -cne 'GET' -or
        [string]$Value.addressClass -cne 'loopback' -or $Value.mutationAttempted -isnot [bool] -or [bool]$Value.mutationAttempted -or
        [string]$Value.status -cne 'healthy' -or -not (Test-DysonQualificationV2Integer -Value $Value.httpStatus) -or
        [int]$Value.httpStatus -ne 200 -or -not (Test-DysonQualificationV2Digest -Value ([string]$Value.responseSha256)) -or
        [string]$Value.deploymentReceiptSha256 -cne [string]$Capture.deploymentReceipt.receiptSha256 -or
        [string]$Value.releaseId -cne [string]$Capture.deploymentReceipt.releaseId -or
        [string]$Value.subjectCommit -cne [string]$Capture.deploymentReceipt.subjectCommit -or
        [string]$Value.runtimePayloadSha256 -cne [string]$Capture.deploymentReceipt.artifactHashes.runtimePayloadSha256) {
        Throw-DysonSideBySideV2Error -Code $code
    }
    $healthObserved = ConvertFrom-DysonQualificationV2Utc -Value ([string]$Value.observedAtUtc) -Code $code
    if ([Math]::Abs(($healthObserved - $ObservedAt).TotalSeconds) -gt 5) { Throw-DysonSideBySideV2Error -Code $code }
}

function Assert-DysonSideBySideV2Runtime {
    param([Parameter(Mandatory)]$Value, [Parameter(Mandatory)]$Capture, [Parameter(Mandatory)][datetimeoffset]$ObservedAt)
    $code = 'DYSON_QUALIFICATION_SIDE_BY_SIDE_V2_RUNTIME_IDENTITY_INVALID'
    Assert-DysonSideBySideV2ExactProperties -Value $Value -Names @(
        'protocol','schemaVersion','observerClass','queryMode','mutationAttempted','pid','processStartTimeUtc',
        'observedAtUtc','candidateRootIdentitySha256','releaseId','subjectCommit','runtimePayloadSha256',
        'executableSha256','commandLineSha256','runtimeAssemblySha256','nebulaAssemblySha256',
        'bridgeAssemblySha256','identitySha256'
    ) -Code $code
    foreach ($name in @('candidateRootIdentitySha256','runtimePayloadSha256','executableSha256','commandLineSha256',
            'runtimeAssemblySha256','nebulaAssemblySha256','bridgeAssemblySha256','identitySha256')) {
        if (-not (Test-DysonQualificationV2Digest -Value ([string]$Value.$name))) { Throw-DysonSideBySideV2Error -Code $code }
    }
    if ([string]$Value.protocol -cne $script:DysonSideBySideV2RuntimeProtocol -or
        -not (Test-DysonQualificationV2Integer -Value $Value.schemaVersion) -or [int]$Value.schemaVersion -ne 2 -or
        [string]$Value.observerClass -cne 'independent-read-only-os-observer' -or [string]$Value.queryMode -cne 'read-only' -or
        $Value.mutationAttempted -isnot [bool] -or [bool]$Value.mutationAttempted -or
        -not (Test-DysonQualificationV2Integer -Value $Value.pid) -or [int64]$Value.pid -lt 1 -or
        [string]$Value.candidateRootIdentitySha256 -cne [string]$Capture.isolation.candidateRoot.rootIdentitySha256 -or
        [string]$Value.releaseId -cne [string]$Capture.deploymentReceipt.releaseId -or
        [string]$Value.subjectCommit -cne [string]$Capture.deploymentReceipt.subjectCommit -or
        [string]$Value.runtimePayloadSha256 -cne [string]$Capture.deploymentReceipt.artifactHashes.runtimePayloadSha256) {
        Throw-DysonSideBySideV2Error -Code $code
    }
    $started = ConvertFrom-DysonQualificationV2Utc -Value ([string]$Value.processStartTimeUtc) -Code $code
    $runtimeObserved = ConvertFrom-DysonQualificationV2Utc -Value ([string]$Value.observedAtUtc) -Code $code
    if ($started -gt $runtimeObserved -or [Math]::Abs(($runtimeObserved - $ObservedAt).TotalSeconds) -gt 5) {
        Throw-DysonSideBySideV2Error -Code $code
    }
    $expected = Get-DysonQualificationV2ObjectDigest -Value `
        (Get-DysonSideBySideV2UnsignedValue -Value $Value -Excluded @('identitySha256'))
    if ([string]$Value.identitySha256 -cne $expected) { Throw-DysonSideBySideV2Error -Code $code }
}

function Assert-DysonSideBySideV2Snapshot {
    param([Parameter(Mandatory)]$Value, [Parameter(Mandatory)][datetimeoffset]$ObservedAt)
    $code = 'DYSON_QUALIFICATION_SIDE_BY_SIDE_V2_GSMANAGER_SNAPSHOT_INVALID'
    Assert-DysonSideBySideV2ExactProperties -Value $Value -Names @(
        'protocol','schemaVersion','snapshotProtocol','snapshotId','snapshotManifestSha256','payloadSha256',
        'taskXmlSha256','securityInventorySha256','pairedSaveProtectionSha256','verificationMode',
        'mutationAttempted','recoverable','verifiedAtUtc','expiresAtUtc','verificationSha256'
    ) -Code $code
    foreach ($name in @('snapshotManifestSha256','payloadSha256','taskXmlSha256','securityInventorySha256',
            'pairedSaveProtectionSha256','verificationSha256')) {
        if (-not (Test-DysonQualificationV2Digest -Value ([string]$Value.$name))) { Throw-DysonSideBySideV2Error -Code $code }
    }
    if ([string]$Value.protocol -cne $script:DysonSideBySideV2SnapshotProtocol -or
        -not (Test-DysonQualificationV2Integer -Value $Value.schemaVersion) -or [int]$Value.schemaVersion -ne 2 -or
        [string]$Value.snapshotProtocol -cne 'DYSON_GSMANAGER_SNAPSHOT_V2' -or
        -not (Test-DysonQualificationV2Uuid -Value ([string]$Value.snapshotId)) -or
        [string]$Value.verificationMode -cne 'full-byte-acl-task-read-only' -or
        $Value.mutationAttempted -isnot [bool] -or [bool]$Value.mutationAttempted -or
        $Value.recoverable -isnot [bool] -or -not [bool]$Value.recoverable) {
        Throw-DysonSideBySideV2Error -Code $code
    }
    $verified = ConvertFrom-DysonQualificationV2Utc -Value ([string]$Value.verifiedAtUtc) -Code $code
    $expires = ConvertFrom-DysonQualificationV2Utc -Value ([string]$Value.expiresAtUtc) -Code $code
    if ($verified -gt $ObservedAt.AddMinutes(1) -or $verified -lt $ObservedAt.AddHours(-24) -or
        $expires -le $ObservedAt -or $expires -le $verified -or $expires -gt $verified.AddHours(24)) {
        Throw-DysonSideBySideV2Error -Code 'DYSON_QUALIFICATION_SIDE_BY_SIDE_V2_GSMANAGER_SNAPSHOT_STALE'
    }
    $expected = Get-DysonQualificationV2ObjectDigest -Value `
        (Get-DysonSideBySideV2UnsignedValue -Value $Value -Excluded @('verificationSha256'))
    if ([string]$Value.verificationSha256 -cne $expected) { Throw-DysonSideBySideV2Error -Code $code }
}

function Assert-DysonSideBySideV2Authority {
    param([Parameter(Mandatory)]$Value, [Parameter(Mandatory)]$Capture, [Parameter(Mandatory)][datetimeoffset]$ObservedAt)
    $code = 'DYSON_QUALIFICATION_SIDE_BY_SIDE_V2_AUTHORITY_INVALID'
    Assert-DysonSideBySideV2ExactProperties -Value $Value -Names @(
        'protocol','schemaVersion','observerClass','queryMode','mutationAttempted','observedAtUtc','authority',
        'authorityGeneration','switchIntentPresent','cutoverReceiptPresent','gsManagerTaskAvailable','gsManagerSnapshotId',
        'productionPort','productionPortOwner','candidatePort','candidateBindAddressClass','candidateOwnsProductionPort',
        'candidateProductionListenerCount','dualAuthorityDetected','observationSha256'
    ) -Code $code
    if ([string]$Value.protocol -cne $script:DysonSideBySideV2AuthorityProtocol -or
        -not (Test-DysonQualificationV2Integer -Value $Value.schemaVersion) -or [int]$Value.schemaVersion -ne 2 -or
        [string]$Value.observerClass -cne 'independent-read-only-host-observer' -or [string]$Value.queryMode -cne 'read-only' -or
        $Value.mutationAttempted -isnot [bool] -or [bool]$Value.mutationAttempted -or
        [string]$Value.authority -cne 'GSManager' -or -not (Test-DysonQualificationV2Integer -Value $Value.authorityGeneration) -or
        [int64]$Value.authorityGeneration -lt 1 -or $Value.switchIntentPresent -isnot [bool] -or [bool]$Value.switchIntentPresent -or
        $Value.cutoverReceiptPresent -isnot [bool] -or [bool]$Value.cutoverReceiptPresent -or
        $Value.gsManagerTaskAvailable -isnot [bool] -or -not [bool]$Value.gsManagerTaskAvailable -or
        [string]$Value.gsManagerSnapshotId -cne [string]$Capture.gsManagerSnapshot.snapshotId -or
        -not (Test-DysonQualificationV2Integer -Value $Value.productionPort) -or [int]$Value.productionPort -lt 1 -or [int]$Value.productionPort -gt 65535 -or
        [string]$Value.productionPortOwner -cne 'GSManager' -or
        -not (Test-DysonQualificationV2Integer -Value $Value.candidatePort) -or [int]$Value.candidatePort -lt 1 -or [int]$Value.candidatePort -gt 65535 -or
        [int]$Value.candidatePort -eq [int]$Value.productionPort -or [string]$Value.candidateBindAddressClass -cne 'loopback' -or
        $Value.candidateOwnsProductionPort -isnot [bool] -or [bool]$Value.candidateOwnsProductionPort -or
        -not (Test-DysonQualificationV2Integer -Value $Value.candidateProductionListenerCount) -or
        [int]$Value.candidateProductionListenerCount -ne 0 -or
        $Value.dualAuthorityDetected -isnot [bool] -or [bool]$Value.dualAuthorityDetected -or
        -not (Test-DysonQualificationV2Digest -Value ([string]$Value.observationSha256))) {
        Throw-DysonSideBySideV2Error -Code $code
    }
    $authorityObserved = ConvertFrom-DysonQualificationV2Utc -Value ([string]$Value.observedAtUtc) -Code $code
    if ([Math]::Abs(($authorityObserved - $ObservedAt).TotalSeconds) -gt 5) { Throw-DysonSideBySideV2Error -Code $code }
    $expected = Get-DysonQualificationV2ObjectDigest -Value `
        (Get-DysonSideBySideV2UnsignedValue -Value $Value -Excluded @('observationSha256'))
    if ([string]$Value.observationSha256 -cne $expected) { Throw-DysonSideBySideV2Error -Code $code }
}

function Assert-DysonSideBySideV2Window {
    param([Parameter(Mandatory)]$Value, [datetimeoffset]$NowUtc = [datetimeoffset]::UtcNow)
    $code = 'DYSON_QUALIFICATION_SIDE_BY_SIDE_V2_WINDOW_INVALID'
    Assert-DysonSideBySideV2ExactProperties -Value $Value `
        -Names @('startedAtUtc','observedAtUtc','expiresAtUtc','elapsedSeconds','clockClass') -Code $code
    if (-not (Test-DysonQualificationV2Integer -Value $Value.elapsedSeconds) -or
        [int64]$Value.elapsedSeconds -lt 1 -or [int64]$Value.elapsedSeconds -gt 7200 -or
        [string]$Value.clockClass -cne 'bounded-monotonic') { Throw-DysonSideBySideV2Error -Code $code }
    $started = ConvertFrom-DysonQualificationV2Utc -Value ([string]$Value.startedAtUtc) -Code $code
    $observed = ConvertFrom-DysonQualificationV2Utc -Value ([string]$Value.observedAtUtc) -Code $code
    $expires = ConvertFrom-DysonQualificationV2Utc -Value ([string]$Value.expiresAtUtc) -Code $code
    $actualElapsed = [Math]::Floor(($observed - $started).TotalSeconds)
    if ($observed -lt $started -or [Math]::Abs($actualElapsed - [int64]$Value.elapsedSeconds) -gt 5 -or
        $observed -gt $NowUtc.AddMinutes(1) -or $observed -lt $NowUtc.AddSeconds(-$script:DysonSideBySideV2MaximumAgeSeconds) -or
        $expires -le $observed -or $expires -gt $observed.AddSeconds($script:DysonSideBySideV2MaximumAgeSeconds) -or
        $expires -le $NowUtc) {
        Throw-DysonSideBySideV2Error -Code 'DYSON_QUALIFICATION_SIDE_BY_SIDE_V2_OBSERVATION_STALE'
    }
    return [pscustomobject][ordered]@{ started = $started; observed = $observed; expires = $expires }
}

function Assert-DysonSideBySideV2Expectation {
    param([Parameter(Mandatory)]$Value)
    $code = 'DYSON_QUALIFICATION_SIDE_BY_SIDE_V2_EXPECTATION_INVALID'
    Assert-DysonSideBySideV2ExactProperties -Value $Value -Names @(
        'protocol','schemaVersion','runId','actionTargetId','targetIdentity','releaseId','subjectCommit','artifactHashes',
        'deploymentReceiptSha256','candidateRootIdentitySha256','gsManagerSnapshotId','gsManagerSnapshotManifestSha256',
        'productionPort','candidatePort','keyId'
    ) -Code $code
    Assert-DysonSideBySideV2ArtifactHashes -Value $Value.artifactHashes -Code $code
    if ([string]$Value.protocol -cne $script:DysonSideBySideV2ExpectationProtocol -or
        -not (Test-DysonQualificationV2Integer -Value $Value.schemaVersion) -or [int]$Value.schemaVersion -ne 2 -or
        -not (Test-DysonQualificationV2Uuid -Value ([string]$Value.runId)) -or
        -not (Test-DysonSideBySideV2Identifier -Value ([string]$Value.actionTargetId)) -or
        -not (Test-DysonQualificationV2Digest -Value ([string]$Value.targetIdentity)) -or
        -not (Test-DysonSideBySideV2Identifier -Value ([string]$Value.releaseId)) -or
        -not (Test-DysonSideBySideV2Commit -Value ([string]$Value.subjectCommit)) -or
        -not (Test-DysonQualificationV2Digest -Value ([string]$Value.deploymentReceiptSha256)) -or
        -not (Test-DysonQualificationV2Digest -Value ([string]$Value.candidateRootIdentitySha256)) -or
        -not (Test-DysonQualificationV2Uuid -Value ([string]$Value.gsManagerSnapshotId)) -or
        -not (Test-DysonQualificationV2Digest -Value ([string]$Value.gsManagerSnapshotManifestSha256)) -or
        -not (Test-DysonQualificationV2Integer -Value $Value.productionPort) -or [int]$Value.productionPort -lt 1 -or [int]$Value.productionPort -gt 65535 -or
        -not (Test-DysonQualificationV2Integer -Value $Value.candidatePort) -or [int]$Value.candidatePort -lt 1 -or [int]$Value.candidatePort -gt 65535 -or
        [int]$Value.productionPort -eq [int]$Value.candidatePort -or
        -not (Test-DysonSideBySideV2Identifier -Value ([string]$Value.keyId))) {
        Throw-DysonSideBySideV2Error -Code $code
    }
    return $true
}

function Test-DysonSideBySideV2ExpectedBindings {
    param([Parameter(Mandatory)]$Value, [Parameter(Mandatory)]$Expectation)
    $artifactLeft = ConvertTo-DysonQualificationV2CanonicalJson -Value $Value.artifactHashes
    $artifactRight = ConvertTo-DysonQualificationV2CanonicalJson -Value $Expectation.artifactHashes
    return (
        [string]$Value.runId -ceq [string]$Expectation.runId -and
        [string]$Value.actionTargetId -ceq [string]$Expectation.actionTargetId -and
        [string]$Value.targetIdentity -ceq [string]$Expectation.targetIdentity -and
        [string]$Value.releaseId -ceq [string]$Expectation.releaseId -and
        [string]$Value.subjectCommit -ceq [string]$Expectation.subjectCommit -and
        $artifactLeft -ceq $artifactRight -and
        [string]$Value.deploymentReceiptSha256 -ceq [string]$Expectation.deploymentReceiptSha256 -and
        [string]$Value.candidateRootIdentitySha256 -ceq [string]$Expectation.candidateRootIdentitySha256 -and
        [string]$Value.gsManagerSnapshotId -ceq [string]$Expectation.gsManagerSnapshotId -and
        [string]$Value.gsManagerSnapshotManifestSha256 -ceq [string]$Expectation.gsManagerSnapshotManifestSha256 -and
        [int]$Value.productionPort -eq [int]$Expectation.productionPort -and
        [int]$Value.candidatePort -eq [int]$Expectation.candidatePort -and
        [string]$Value.keyId -ceq [string]$Expectation.keyId
    )
}

function Assert-DysonSideBySideV2Capture {
    param([Parameter(Mandatory)]$Capture, [Parameter(Mandatory)]$Expectation, [datetimeoffset]$NowUtc = [datetimeoffset]::UtcNow)
    $code = 'DYSON_QUALIFICATION_SIDE_BY_SIDE_V2_CAPTURE_INVALID'
    [void](Assert-DysonSideBySideV2Expectation -Value $Expectation)
    Assert-DysonSideBySideV2ExactProperties -Value $Capture -Names @(
        'protocol','schemaVersion','receiptId','runId','actionTargetId','targetIdentity','deploymentReceipt','isolation',
        'health','runtime','gsManagerSnapshot','authority','observationWindow','keyId'
    ) -Code $code
    if ([string]$Capture.protocol -cne $script:DysonSideBySideV2CaptureProtocol -or
        -not (Test-DysonQualificationV2Integer -Value $Capture.schemaVersion) -or [int]$Capture.schemaVersion -ne 2 -or
        -not (Test-DysonQualificationV2Uuid -Value ([string]$Capture.receiptId)) -or
        -not (Test-DysonQualificationV2Uuid -Value ([string]$Capture.runId)) -or
        -not (Test-DysonSideBySideV2Identifier -Value ([string]$Capture.actionTargetId)) -or
        -not (Test-DysonQualificationV2Digest -Value ([string]$Capture.targetIdentity)) -or
        -not (Test-DysonSideBySideV2Identifier -Value ([string]$Capture.keyId))) {
        Throw-DysonSideBySideV2Error -Code $code
    }
    Assert-DysonSideBySideV2DeploymentReceipt -Value $Capture.deploymentReceipt
    $window = Assert-DysonSideBySideV2Window -Value $Capture.observationWindow -NowUtc $NowUtc
    Assert-DysonSideBySideV2Isolation -Value $Capture.isolation -ObservedAt $window.observed
    Assert-DysonSideBySideV2Health -Value $Capture.health -Capture $Capture -ObservedAt $window.observed
    Assert-DysonSideBySideV2Runtime -Value $Capture.runtime -Capture $Capture -ObservedAt $window.observed
    Assert-DysonSideBySideV2Snapshot -Value $Capture.gsManagerSnapshot -ObservedAt $window.observed
    Assert-DysonSideBySideV2Authority -Value $Capture.authority -Capture $Capture -ObservedAt $window.observed
    $deploymentCompleted = ConvertFrom-DysonQualificationV2Utc `
        -Value ([string]$Capture.deploymentReceipt.completedAtUtc) -Code $code
    if ($deploymentCompleted -gt $window.observed -or
        [string]$Capture.deploymentReceipt.candidateRootIdentitySha256 -cne [string]$Capture.isolation.candidateRoot.rootIdentitySha256) {
        Throw-DysonSideBySideV2Error -Code $code
    }
    $binding = [pscustomobject][ordered]@{
        runId = [string]$Capture.runId
        actionTargetId = [string]$Capture.actionTargetId
        targetIdentity = [string]$Capture.targetIdentity
        releaseId = [string]$Capture.deploymentReceipt.releaseId
        subjectCommit = [string]$Capture.deploymentReceipt.subjectCommit
        artifactHashes = $Capture.deploymentReceipt.artifactHashes
        deploymentReceiptSha256 = [string]$Capture.deploymentReceipt.receiptSha256
        candidateRootIdentitySha256 = [string]$Capture.isolation.candidateRoot.rootIdentitySha256
        gsManagerSnapshotId = [string]$Capture.gsManagerSnapshot.snapshotId
        gsManagerSnapshotManifestSha256 = [string]$Capture.gsManagerSnapshot.snapshotManifestSha256
        productionPort = [int]$Capture.authority.productionPort
        candidatePort = [int]$Capture.authority.candidatePort
        keyId = [string]$Capture.keyId
    }
    if (-not (Test-DysonSideBySideV2ExpectedBindings -Value $binding -Expectation $Expectation)) {
        Throw-DysonSideBySideV2Error -Code 'DYSON_QUALIFICATION_SIDE_BY_SIDE_V2_EXPECTED_BINDING_MISMATCH'
    }
    return $true
}

function New-DysonSideBySideV2Observation {
    param(
        [Parameter(Mandatory)]$Capture,
        [Parameter(Mandatory)]$Expectation,
        [Parameter(Mandatory)][byte[]]$Key,
        [datetimeoffset]$NowUtc = [datetimeoffset]::UtcNow
    )
    [void](Assert-DysonSideBySideV2Capture -Capture $Capture -Expectation $Expectation -NowUtc $NowUtc)
    if ($Key.Length -lt 32 -or $Key.Length -gt 128) {
        Throw-DysonSideBySideV2Error -Code 'DYSON_QUALIFICATION_SIDE_BY_SIDE_V2_KEY_INVALID'
    }
    $unsigned = [pscustomobject][ordered]@{
        protocol = $script:DysonSideBySideV2Protocol
        schemaVersion = 2
        receiptId = [string]$Capture.receiptId
        runId = [string]$Capture.runId
        action = 'side-by-side-deployment'
        actionTargetId = [string]$Capture.actionTargetId
        targetIdentity = [string]$Capture.targetIdentity
        subjectCommit = [string]$Capture.deploymentReceipt.subjectCommit
        runtimePayloadSha256 = [string]$Capture.deploymentReceipt.artifactHashes.runtimePayloadSha256
        status = 'verified'
        deploymentReceipt = $Capture.deploymentReceipt
        isolation = $Capture.isolation
        health = $Capture.health
        runtime = $Capture.runtime
        gsManagerSnapshot = $Capture.gsManagerSnapshot
        authority = $Capture.authority
        observationWindow = $Capture.observationWindow
        checkCodes = @($script:DysonSideBySideV2CheckCodes)
    }
    $receiptSha256 = Get-DysonQualificationV2ObjectDigest -Value $unsigned
    $hmacPayload = ConvertTo-DysonQualificationV2CanonicalJson -Value ([pscustomobject][ordered]@{
        domain = 'DYSON_QUALIFICATION_SIDE_BY_SIDE_OBSERVATION_HMAC_V2'
        receiptSha256 = $receiptSha256
        keyId = [string]$Expectation.keyId
    })
    return [pscustomobject][ordered]@{
        protocol = $unsigned.protocol
        schemaVersion = $unsigned.schemaVersion
        receiptId = $unsigned.receiptId
        runId = $unsigned.runId
        action = $unsigned.action
        actionTargetId = $unsigned.actionTargetId
        targetIdentity = $unsigned.targetIdentity
        subjectCommit = $unsigned.subjectCommit
        runtimePayloadSha256 = $unsigned.runtimePayloadSha256
        status = $unsigned.status
        deploymentReceipt = $unsigned.deploymentReceipt
        isolation = $unsigned.isolation
        health = $unsigned.health
        runtime = $unsigned.runtime
        gsManagerSnapshot = $unsigned.gsManagerSnapshot
        authority = $unsigned.authority
        observationWindow = $unsigned.observationWindow
        checkCodes = $unsigned.checkCodes
        receiptSha256 = $receiptSha256
        protection = [pscustomobject][ordered]@{
            keyId = [string]$Expectation.keyId
            hmacSha256 = Get-DysonSideBySideV2Hmac -Key $Key -Text $hmacPayload
        }
    }
}

function Assert-DysonSideBySideV2Observation {
    param(
        [Parameter(Mandatory)]$Observation,
        [Parameter(Mandatory)]$Expectation,
        [Parameter(Mandatory)][byte[]]$Key,
        [datetimeoffset]$NowUtc = [datetimeoffset]::UtcNow
    )
    $code = 'DYSON_QUALIFICATION_SIDE_BY_SIDE_V2_OBSERVATION_INVALID'
    [void](Assert-DysonSideBySideV2Expectation -Value $Expectation)
    Assert-DysonSideBySideV2ExactProperties -Value $Observation -Names @(
        'protocol','schemaVersion','receiptId','runId','action','actionTargetId','targetIdentity','subjectCommit',
        'runtimePayloadSha256','status','deploymentReceipt','isolation','health','runtime','gsManagerSnapshot',
        'authority','observationWindow','checkCodes','receiptSha256','protection'
    ) -Code $code
    Assert-DysonSideBySideV2ExactProperties -Value $Observation.protection `
        -Names @('keyId','hmacSha256') -Code $code
    $actualCodes = @($Observation.checkCodes | ForEach-Object { [string]$_ })
    if ([string]$Observation.protocol -cne $script:DysonSideBySideV2Protocol -or
        -not (Test-DysonQualificationV2Integer -Value $Observation.schemaVersion) -or [int]$Observation.schemaVersion -ne 2 -or
        -not (Test-DysonQualificationV2Uuid -Value ([string]$Observation.receiptId)) -or
        -not (Test-DysonQualificationV2Uuid -Value ([string]$Observation.runId)) -or
        [string]$Observation.action -cne 'side-by-side-deployment' -or
        [string]$Observation.status -cne 'verified' -or
        -not (Test-DysonQualificationV2Digest -Value ([string]$Observation.receiptSha256)) -or
        -not (Test-DysonQualificationV2Digest -Value ([string]$Observation.protection.hmacSha256)) -or
        [string]$Observation.protection.keyId -cne [string]$Expectation.keyId -or
        $actualCodes.Count -ne $script:DysonSideBySideV2CheckCodes.Count -or
        ($actualCodes -join "`n") -cne ($script:DysonSideBySideV2CheckCodes -join "`n")) {
        Throw-DysonSideBySideV2Error -Code $code
    }
    $capture = [pscustomobject][ordered]@{
        protocol = $script:DysonSideBySideV2CaptureProtocol
        schemaVersion = 2
        receiptId = [string]$Observation.receiptId
        runId = [string]$Observation.runId
        actionTargetId = [string]$Observation.actionTargetId
        targetIdentity = [string]$Observation.targetIdentity
        deploymentReceipt = $Observation.deploymentReceipt
        isolation = $Observation.isolation
        health = $Observation.health
        runtime = $Observation.runtime
        gsManagerSnapshot = $Observation.gsManagerSnapshot
        authority = $Observation.authority
        observationWindow = $Observation.observationWindow
        keyId = [string]$Observation.protection.keyId
    }
    [void](Assert-DysonSideBySideV2Capture -Capture $capture -Expectation $Expectation -NowUtc $NowUtc)
    if ([string]$Observation.subjectCommit -cne [string]$Observation.deploymentReceipt.subjectCommit -or
        [string]$Observation.runtimePayloadSha256 -cne [string]$Observation.deploymentReceipt.artifactHashes.runtimePayloadSha256) {
        Throw-DysonSideBySideV2Error -Code $code
    }
    $unsigned = Get-DysonSideBySideV2UnsignedValue -Value $Observation -Excluded @('receiptSha256','protection')
    $expectedReceipt = Get-DysonQualificationV2ObjectDigest -Value $unsigned
    if ([string]$Observation.receiptSha256 -cne $expectedReceipt) {
        Throw-DysonSideBySideV2Error -Code 'DYSON_QUALIFICATION_SIDE_BY_SIDE_V2_RECEIPT_DIGEST_INVALID'
    }
    if ($Key.Length -lt 32 -or $Key.Length -gt 128) {
        Throw-DysonSideBySideV2Error -Code 'DYSON_QUALIFICATION_SIDE_BY_SIDE_V2_KEY_INVALID'
    }
    $payload = ConvertTo-DysonQualificationV2CanonicalJson -Value ([pscustomobject][ordered]@{
        domain = 'DYSON_QUALIFICATION_SIDE_BY_SIDE_OBSERVATION_HMAC_V2'
        receiptSha256 = $expectedReceipt
        keyId = [string]$Observation.protection.keyId
    })
    $expectedHmac = Get-DysonSideBySideV2Hmac -Key $Key -Text $payload
    if (-not (Test-DysonSideBySideV2FixedTimeEqual -Left ([string]$Observation.protection.hmacSha256) -Right $expectedHmac)) {
        Throw-DysonSideBySideV2Error -Code 'DYSON_QUALIFICATION_SIDE_BY_SIDE_V2_HMAC_INVALID'
    }
    return [pscustomobject][ordered]@{
        valid = $true
        protocol = [string]$Observation.protocol
        receiptId = [string]$Observation.receiptId
        runId = [string]$Observation.runId
        actionTargetId = [string]$Observation.actionTargetId
        releaseId = [string]$Observation.deploymentReceipt.releaseId
        subjectCommit = [string]$Observation.subjectCommit
        runtimePayloadSha256 = [string]$Observation.runtimePayloadSha256
        deploymentReceiptSha256 = [string]$Observation.deploymentReceipt.receiptSha256
        gsManagerSnapshotId = [string]$Observation.gsManagerSnapshot.snapshotId
        authority = [string]$Observation.authority.authority
        productionChanged = $false
        receiptSha256 = [string]$Observation.receiptSha256
        observedAtUtc = [string]$Observation.observationWindow.observedAtUtc
        expiresAtUtc = [string]$Observation.observationWindow.expiresAtUtc
    }
}

function Write-DysonSideBySideV2JsonCreateNew {
    param([Parameter(Mandatory)][string]$Path, [Parameter(Mandatory)]$Value)
    $full = [IO.Path]::GetFullPath($Path)
    $parent = Split-Path -Parent $full
    if (-not (Test-Path -LiteralPath $parent -PathType Container) -or (Test-Path -LiteralPath $full)) {
        Throw-DysonSideBySideV2Error -Code 'DYSON_QUALIFICATION_SIDE_BY_SIDE_V2_OUTPUT_INVALID'
    }
    $parentItem = Get-Item -LiteralPath $parent -Force -ErrorAction Stop
    if ($parentItem.Attributes -band [IO.FileAttributes]::ReparsePoint) {
        Throw-DysonSideBySideV2Error -Code 'DYSON_QUALIFICATION_SIDE_BY_SIDE_V2_OUTPUT_INVALID'
    }
    $temporary = Join-Path $parent ('.side-by-side-v2-' + [guid]::NewGuid().ToString('N') + '.tmp')
    $stream = $null
    try {
        $json = ConvertTo-Json -InputObject $Value -Depth 64
        $bytes = [Text.UTF8Encoding]::new($false).GetBytes($json + "`n")
        $stream = [IO.FileStream]::new($temporary, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
        $stream.Write($bytes, 0, $bytes.Length)
        $stream.Flush($true)
        $stream.Dispose()
        $stream = $null
        [IO.File]::Move($temporary, $full)
    }
    catch {
        if ($null -ne $stream) { $stream.Dispose(); $stream = $null }
        if (Test-Path -LiteralPath $temporary -PathType Leaf) { Remove-Item -LiteralPath $temporary -Force -ErrorAction SilentlyContinue }
        if ($_.Exception.Data.Contains('Code')) { throw }
        Throw-DysonSideBySideV2Error -Code 'DYSON_QUALIFICATION_SIDE_BY_SIDE_V2_OUTPUT_INVALID'
    }
    return $full
}
