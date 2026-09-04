[CmdletBinding(SupportsShouldProcess = $true, ConfirmImpact = 'Medium')]
param(
    [Parameter(Mandatory)][string]$ProjectRoot,
    [Parameter(Mandatory)][ValidatePattern('^[0-9A-Fa-f-]{36}$')][string]$RequestId,
    [ValidatePattern('^[^\\/:*?"<>|]{1,120}$')][string]$SaveName = '_lastexit_',
    [ValidateRange(1, 5)][int]$SnapshotAttempts = 3
)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$protocol = 'DYSON_CONTROL_PROTECTION_V1'
$parsedRequestId = [guid]::Empty
if (-not [guid]::TryParseExact($RequestId, 'D', [ref]$parsedRequestId)) {
    throw 'The lifecycle request ID is invalid.'
}
$normalizedRequestId = $parsedRequestId.ToString('D').ToLowerInvariant()

function Assert-NormalDirectory {
    param([Parameter(Mandatory)][string]$LiteralPath)
    $item = Get-Item -LiteralPath $LiteralPath -Force -ErrorAction Stop
    if (-not $item.PSIsContainer -or ($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint)) {
        throw 'A lifecycle directory is unavailable or redirected.'
    }
    return $item.FullName
}

function Assert-NormalFile {
    param([Parameter(Mandatory)][string]$LiteralPath)
    $item = Get-Item -LiteralPath $LiteralPath -Force -ErrorAction Stop
    if ($item.PSIsContainer -or ($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint)) {
        throw 'A lifecycle save file is unavailable or redirected.'
    }
    return $item
}

function Get-FileEvidence {
    param([Parameter(Mandatory)][string]$LiteralPath)
    $item = Assert-NormalFile -LiteralPath $LiteralPath
    $stream = [System.IO.File]::Open(
        $item.FullName,
        [System.IO.FileMode]::Open,
        [System.IO.FileAccess]::Read,
        [System.IO.FileShare]::Read
    )
    $algorithm = [System.Security.Cryptography.SHA256]::Create()
    try {
        $hash = ([System.BitConverter]::ToString($algorithm.ComputeHash($stream))).Replace('-', '').ToLowerInvariant()
    }
    finally {
        $algorithm.Dispose()
        $stream.Dispose()
    }
    return [ordered]@{ bytes = [int64]$item.Length; sha256 = $hash }
}

function Test-EqualEvidence {
    param([Parameter(Mandatory)]$Left, [Parameter(Mandatory)]$Right)
    return [int64]$Left.bytes -eq [int64]$Right.bytes -and
        [string]::Equals([string]$Left.sha256, [string]$Right.sha256, [System.StringComparison]::OrdinalIgnoreCase)
}

function Get-StableSourcePairEvidence {
    param(
        [Parameter(Mandatory)][string]$DsvPath,
        [Parameter(Mandatory)][string]$ServerPath,
        [Parameter(Mandatory)][int]$Attempts
    )

    for ($attempt = 1; $attempt -le $Attempts; $attempt++) {
        $beforeDsv = Get-FileEvidence -LiteralPath $DsvPath
        $beforeServer = Get-FileEvidence -LiteralPath $ServerPath
        $afterDsv = Get-FileEvidence -LiteralPath $DsvPath
        $afterServer = Get-FileEvidence -LiteralPath $ServerPath
        if (
            (Test-EqualEvidence -Left $beforeDsv -Right $afterDsv) -and
            (Test-EqualEvidence -Left $beforeServer -Right $afterServer)
        ) {
            return [ordered]@{ dsv = $afterDsv; server = $afterServer }
        }
        if ($attempt -lt $Attempts) { Start-Sleep -Milliseconds 250 }
    }
    throw 'The paired save changed while its protection point was being previewed.'
}

function Write-ProtectionReceipt {
    param(
        [Parameter(Mandatory)][ValidateSet('preview', 'succeeded', 'cancelled')][string]$State,
        [Parameter(Mandatory)][bool]$DryRun,
        [Parameter(Mandatory)][bool]$MutationPerformed,
        [Parameter(Mandatory)][bool]$ManifestVerified,
        [Parameter(Mandatory)][bool]$Reused,
        [Parameter(Mandatory)][int64]$DsvBytes,
        [Parameter(Mandatory)][int64]$ServerBytes,
        [bool]$WouldCreate = $false,
        [bool]$WouldRemoveStaleStaging = $false
    )

    $receipt = [ordered]@{
        protocol = $protocol
        schemaVersion = 1
        requestId = $normalizedRequestId
        state = $State
        dryRun = $DryRun
        mutationPerformed = $MutationPerformed
        protectionPointId = 'save:' + $normalizedRequestId
        sourcePairVerified = $true
        dsvBytes = $DsvBytes
        serverBytes = $ServerBytes
        manifestVerified = $ManifestVerified
        reused = $Reused
    }
    if ($State -ceq 'preview') {
        $receipt['wouldCreate'] = $WouldCreate
        $receipt['wouldRemoveStaleStaging'] = $WouldRemoveStaleStaging
    }
    $receipt | ConvertTo-Json -Depth 5 -Compress
}

function Read-VerifiedProtectionPoint {
    param([Parameter(Mandatory)][string]$DirectoryPath)
    Assert-NormalDirectory -LiteralPath $DirectoryPath | Out-Null
    $manifestPath = Join-Path $DirectoryPath 'manifest.json'
    $manifestItem = Assert-NormalFile -LiteralPath $manifestPath
    if ($manifestItem.Length -le 0 -or $manifestItem.Length -gt 16384) { throw 'The protection manifest size is invalid.' }
    $manifest = Get-Content -LiteralPath $manifestPath -Raw -ErrorAction Stop | ConvertFrom-Json -ErrorAction Stop
    if (
        [string]$manifest.protocol -ne $protocol -or [int]$manifest.schemaVersion -ne 1 -or
        [string]$manifest.requestId -ne $normalizedRequestId -or [string]$manifest.saveName -ne $SaveName
    ) {
        throw 'The protection manifest identity is invalid.'
    }
    $files = @($manifest.files)
    if ($files.Count -ne 2) { throw 'The protection manifest pair is incomplete.' }
    $result = @{}
    foreach ($extension in @('.dsv', '.server')) {
        $name = $SaveName + $extension
        $entries = @($files | Where-Object { [string]$_.name -ceq $name })
        if ($entries.Count -ne 1) { throw 'The protection manifest file identity is invalid.' }
        $evidence = Get-FileEvidence -LiteralPath (Join-Path $DirectoryPath $name)
        if ([int64]$entries[0].bytes -ne [int64]$evidence.bytes -or
            -not [string]::Equals([string]$entries[0].sha256, [string]$evidence.sha256, [System.StringComparison]::OrdinalIgnoreCase)) {
            throw 'The protection point does not match its manifest.'
        }
        $result[$extension] = $evidence
    }
    return $result
}

$resolvedProjectRoot = (Resolve-Path -LiteralPath $ProjectRoot -ErrorAction Stop).ProviderPath
Assert-NormalDirectory -LiteralPath $resolvedProjectRoot | Out-Null
$backupRoot = Join-Path $resolvedProjectRoot 'backups\saves'
$backupRootExists = Test-Path -LiteralPath $backupRoot
if ($backupRootExists) {
    $backupRoot = Assert-NormalDirectory -LiteralPath $backupRoot
}
else {
    $backupRoot = [System.IO.Path]::GetFullPath($backupRoot)
}
$finalRoot = Join-Path $backupRoot ('tx-' + $normalizedRequestId)
$stagingRoot = Join-Path $backupRoot ('.staging-' + $normalizedRequestId)

if (Test-Path -LiteralPath $finalRoot) {
    $verified = Read-VerifiedProtectionPoint -DirectoryPath $finalRoot
    Write-ProtectionReceipt -State $(if ($WhatIfPreference) { 'preview' } else { 'succeeded' }) `
        -DryRun ([bool]$WhatIfPreference) -MutationPerformed $false -ManifestVerified $true -Reused $true `
        -DsvBytes ([int64]$verified['.dsv'].bytes) -ServerBytes ([int64]$verified['.server'].bytes) `
        -WouldCreate $false -WouldRemoveStaleStaging $false
    exit 0
}

$saveRoot = Join-Path $resolvedProjectRoot 'userdata\Save'
Assert-NormalDirectory -LiteralPath $saveRoot | Out-Null
$sourceDsv = Join-Path $saveRoot ($SaveName + '.dsv')
$sourceServer = Join-Path $saveRoot ($SaveName + '.server')
Assert-NormalFile -LiteralPath $sourceDsv | Out-Null
Assert-NormalFile -LiteralPath $sourceServer | Out-Null
$sourceEvidence = Get-StableSourcePairEvidence -DsvPath $sourceDsv -ServerPath $sourceServer `
    -Attempts $SnapshotAttempts

$staleStagingPresent = $false
if (Test-Path -LiteralPath $stagingRoot) {
    $stagingItem = Get-Item -LiteralPath $stagingRoot -Force -ErrorAction Stop
    $expectedParent = [System.IO.Path]::GetFullPath($backupRoot).TrimEnd('\') + '\'
    $actualStaging = [System.IO.Path]::GetFullPath($stagingItem.FullName)
    if (-not $actualStaging.StartsWith($expectedParent, [System.StringComparison]::OrdinalIgnoreCase) -or
        $stagingItem.Name -cne ('.staging-' + $normalizedRequestId) -or
        -not $stagingItem.PSIsContainer -or
        ($stagingItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint)) {
        throw 'The stale staging directory identity is invalid.'
    }
    $staleStagingPresent = $true
}

if ($WhatIfPreference) {
    Write-ProtectionReceipt -State 'preview' -DryRun $true -MutationPerformed $false `
        -ManifestVerified $false -Reused $false -DsvBytes ([int64]$sourceEvidence.dsv.bytes) `
        -ServerBytes ([int64]$sourceEvidence.server.bytes) -WouldCreate $true `
        -WouldRemoveStaleStaging $staleStagingPresent
    exit 0
}

$shouldCreate = $PSCmdlet.ShouldProcess(
    ('save:' + $normalizedRequestId),
    'Create or replace the staged paired-save protection point'
)
if (-not $shouldCreate) {
    Write-ProtectionReceipt -State 'cancelled' -DryRun $false -MutationPerformed $false `
        -ManifestVerified $false -Reused $false -DsvBytes ([int64]$sourceEvidence.dsv.bytes) `
        -ServerBytes ([int64]$sourceEvidence.server.bytes)
    exit 0
}

if (-not $backupRootExists) {
    [System.IO.Directory]::CreateDirectory($backupRoot) | Out-Null
    $backupRoot = Assert-NormalDirectory -LiteralPath $backupRoot
}

if ($staleStagingPresent) {
    Remove-Item -LiteralPath $stagingItem.FullName -Recurse -Force
}
[System.IO.Directory]::CreateDirectory($stagingRoot) | Out-Null
Assert-NormalDirectory -LiteralPath $stagingRoot | Out-Null

$stable = $false
$dsvEvidence = $null
$serverEvidence = $null
try {
    for ($attempt = 1; $attempt -le $SnapshotAttempts; $attempt++) {
        $beforeDsv = Get-FileEvidence -LiteralPath $sourceDsv
        $beforeServer = Get-FileEvidence -LiteralPath $sourceServer
        [System.IO.File]::Copy($sourceDsv, (Join-Path $stagingRoot ($SaveName + '.dsv')), $true)
        [System.IO.File]::Copy($sourceServer, (Join-Path $stagingRoot ($SaveName + '.server')), $true)
        $afterDsv = Get-FileEvidence -LiteralPath $sourceDsv
        $afterServer = Get-FileEvidence -LiteralPath $sourceServer
        $copiedDsv = Get-FileEvidence -LiteralPath (Join-Path $stagingRoot ($SaveName + '.dsv'))
        $copiedServer = Get-FileEvidence -LiteralPath (Join-Path $stagingRoot ($SaveName + '.server'))
        if (
            (Test-EqualEvidence -Left $beforeDsv -Right $afterDsv) -and
            (Test-EqualEvidence -Left $beforeServer -Right $afterServer) -and
            (Test-EqualEvidence -Left $afterDsv -Right $copiedDsv) -and
            (Test-EqualEvidence -Left $afterServer -Right $copiedServer)
        ) {
            $dsvEvidence = $copiedDsv
            $serverEvidence = $copiedServer
            $stable = $true
            break
        }
        Start-Sleep -Milliseconds 250
    }
    if (-not $stable) { throw 'The paired save changed while its protection point was being created.' }

    $manifest = [ordered]@{
        protocol = $protocol
        schemaVersion = 1
        requestId = $normalizedRequestId
        createdAt = (Get-Date).ToUniversalTime().ToString('o')
        saveName = $SaveName
        files = @(
            [ordered]@{ name = $SaveName + '.dsv'; bytes = [int64]$dsvEvidence.bytes; sha256 = [string]$dsvEvidence.sha256 },
            [ordered]@{ name = $SaveName + '.server'; bytes = [int64]$serverEvidence.bytes; sha256 = [string]$serverEvidence.sha256 }
        )
    }
    $temporaryManifest = Join-Path $stagingRoot '.partial-manifest.json'
    $manifestPath = Join-Path $stagingRoot 'manifest.json'
    [System.IO.File]::WriteAllText(
        $temporaryManifest,
        ($manifest | ConvertTo-Json -Depth 6 -Compress),
        [System.Text.UTF8Encoding]::new($false)
    )
    [System.IO.File]::Move($temporaryManifest, $manifestPath)
    Read-VerifiedProtectionPoint -DirectoryPath $stagingRoot | Out-Null
    [System.IO.Directory]::Move($stagingRoot, $finalRoot)
}
catch {
    if (Test-Path -LiteralPath $stagingRoot) { Remove-Item -LiteralPath $stagingRoot -Recurse -Force }
    throw
}

$verified = Read-VerifiedProtectionPoint -DirectoryPath $finalRoot
Write-ProtectionReceipt -State 'succeeded' -DryRun $false -MutationPerformed $true `
    -ManifestVerified $true -Reused $false -DsvBytes ([int64]$verified['.dsv'].bytes) `
    -ServerBytes ([int64]$verified['.server'].bytes)
