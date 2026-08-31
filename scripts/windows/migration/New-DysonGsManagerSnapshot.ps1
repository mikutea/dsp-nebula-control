[CmdletBinding(SupportsShouldProcess, ConfirmImpact = 'Medium')]
param(
    [Parameter(Mandatory)][string]$ProjectRoot,
    [Parameter(Mandatory)][string]$GsManagerRoot,
    [Parameter(Mandatory)][string]$DataRoot,
    [Parameter(Mandatory)][string]$PairedSaveProtectionPointId,
    [Parameter(Mandatory)][string]$PairedSaveProtectionManifestSha256,
    [string]$TaskName = 'Dyson-GSManager',
    [ValidateRange(1, 50000)][int]$MaximumFiles = 10000,
    [ValidateRange(1, 8589934592)][int64]$MaximumTotalBytes = [int64](2GB),
    [ValidateRange(1, 2147483648)][int64]$MaximumSingleFileBytes = [int64](512MB)
)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
. (Join-Path $PSScriptRoot 'DysonGsManagerMigration.Common.ps1')

Assert-DysonGsTaskName -TaskName $TaskName
Assert-DysonGsLimits -MaximumFiles $MaximumFiles -MaximumTotalBytes $MaximumTotalBytes -MaximumSingleFileBytes $MaximumSingleFileBytes
$layout = Resolve-DysonGsLayout -ProjectRoot $ProjectRoot -GsManagerRoot $GsManagerRoot -DataRoot $DataRoot -DataRootMayBeMissing
$sourceBefore = Get-DysonGsTreeInventory -Root $layout.gsManagerRoot -MaximumFiles $MaximumFiles `
    -MaximumTotalBytes $MaximumTotalBytes -MaximumSingleFileBytes $MaximumSingleFileBytes -RejectSaveFiles
$protection = Test-DysonGsProtectionPointBinding -ProjectRoot $layout.projectRoot `
    -ProtectionPointId $PairedSaveProtectionPointId -ManifestSha256 $PairedSaveProtectionManifestSha256
$task = Get-DysonGsTaskCapture -TaskName $TaskName -IncludeXml
$snapshotId = [guid]::NewGuid().ToString('D').ToLowerInvariant()
$preview = [ordered]@{
    protocol = $script:DysonGsMigrationProtocol
    state = 'preview'
    dryRun = $true
    snapshotId = $snapshotId
    fileCount = $sourceBefore.fileCount
    totalBytes = $sourceBefore.totalBytes
    treeSha256 = $sourceBefore.treeSha256
    taskStatus = if ([bool]$task.present) { 'capturable' } else { 'absent' }
    pairedSaveProtectionPointId = $protection.protectionPointId
    pairedSaveProtectionManifestSha256 = $protection.manifestSha256
    snapshotPublished = $false
    saveFilesAccepted = $false
    productionChanged = $false
}
if ($WhatIfPreference -or -not $PSCmdlet.ShouldProcess($snapshotId, 'publish a private GSManager migration snapshot')) {
    $preview | ConvertTo-DysonGsJsonLine
    exit 0
}

$data = New-DysonGsPlainDirectory -Path $layout.dataRoot
$snapshotParent = New-DysonGsPlainDirectory -Path (Join-Path $data $script:DysonGsSnapshotRelativeRoot)
$stage = Join-Path $snapshotParent ('.partial-' + $snapshotId)
$final = Join-Path $snapshotParent $snapshotId
if ((Test-Path -LiteralPath $stage) -or (Test-Path -LiteralPath $final)) { throw 'The migration snapshot publication target already exists.' }
$published = $false
try {
    [void](New-DysonGsPlainDirectory -Path $stage -Private)
    [void](New-DysonGsPlainDirectory -Path (Join-Path $stage 'gsmanager'))
    Copy-DysonGsInventory -SourceRoot $layout.gsManagerRoot -DestinationRoot (Join-Path $stage 'gsmanager') -Inventory $sourceBefore
    $sourceAfter = Get-DysonGsTreeInventory -Root $layout.gsManagerRoot -MaximumFiles $MaximumFiles `
        -MaximumTotalBytes $MaximumTotalBytes -MaximumSingleFileBytes $MaximumSingleFileBytes -RejectSaveFiles
    if (-not (Test-DysonGsEntryListsEqual -Left $sourceBefore.entries -Right $sourceAfter.entries)) {
        throw 'The GSManager source tree changed while it was being snapshotted.'
    }
    $taskAfter = Get-DysonGsTaskCapture -TaskName $TaskName -IncludeXml
    if (-not (Test-DysonGsTaskCapturesEqual -Left $task -Right $taskAfter)) {
        throw 'The GSManager scheduled task changed while it was being snapshotted.'
    }
    $copied = Get-DysonGsTreeInventory -Root (Join-Path $stage 'gsmanager') -MaximumFiles $MaximumFiles `
        -MaximumTotalBytes $MaximumTotalBytes -MaximumSingleFileBytes $MaximumSingleFileBytes -PathPrefix 'gsmanager' -RejectSaveFiles
    $expectedCopied = @($sourceBefore.entries | ForEach-Object {
        [pscustomobject][ordered]@{ path = 'gsmanager/' + [string]$_.path; length = [int64]$_.length; sha256 = [string]$_.sha256 }
    })
    if (-not (Test-DysonGsEntryListsEqual -Left $expectedCopied -Right $copied.entries)) {
        throw 'The copied GSManager snapshot tree failed verification.'
    }
    Write-DysonGsTaskCapture -Capture $task -Directory (Join-Path $stage 'task')
    $payload = Get-DysonGsPayloadInventory -Root $stage -MaximumFiles $MaximumFiles -MaximumTotalBytes $MaximumTotalBytes `
        -MaximumSingleFileBytes $MaximumSingleFileBytes -ExcludeRelativePath @('manifest.json')
    $manifest = [ordered]@{
        protocol = $script:DysonGsSnapshotProtocol
        schemaVersion = $script:DysonGsSchemaVersion
        snapshotId = $snapshotId
        createdAt = (Get-Date).ToUniversalTime().ToString('o')
        projectBindingSha256 = Get-DysonGsProjectBindingSha256 -ProjectRoot $layout.projectRoot
        gsManagerRelativeRoot = $layout.gsManagerRelativeRoot
        taskName = $TaskName
        pairedSaveProtection = [ordered]@{ id = $protection.protectionPointId; manifestSha256 = $protection.manifestSha256 }
        limits = [ordered]@{ maximumFiles = $MaximumFiles; maximumTotalBytes = $MaximumTotalBytes; maximumSingleFileBytes = $MaximumSingleFileBytes }
        gsManager = [ordered]@{ fileCount = $copied.fileCount; totalBytes = $copied.totalBytes; treeSha256 = $copied.treeSha256 }
        task = [ordered]@{
            taskPath = [string]$task.taskPath
            present = [bool]$task.present
            enabled = [bool]$task.enabled
            state = [string]$task.state
            xmlSha256 = if ([bool]$task.present) { [string]$task.xmlSha256 } else { $null }
        }
        payloadSha256 = $payload.treeSha256
        fileCount = $payload.fileCount
        totalBytes = $payload.totalBytes
        files = $payload.entries
    }
    Write-DysonGsUtf8Json -Path (Join-Path $stage 'manifest.json') -Value $manifest
    $stageManifestSha256 = Get-DysonGsSha256 -Path (Join-Path $stage 'manifest.json')
    [void](Test-DysonGsSnapshotCore -SnapshotRoot $stage -ExpectedSnapshotId $snapshotId -ExpectedManifestSha256 $stageManifestSha256)
    [System.IO.Directory]::Move($stage, $final)
    $published = $true
    $verified = Test-DysonGsSnapshotCore -SnapshotRoot $final -ExpectedSnapshotId $snapshotId -ExpectedManifestSha256 $stageManifestSha256
    [ordered]@{
        protocol = $script:DysonGsMigrationProtocol
        state = 'snapshotted'
        dryRun = $false
        snapshotId = $snapshotId
        snapshotManifestSha256 = $verified.manifestSha256
        fileCount = $verified.gsManagerInventory.fileCount
        totalBytes = $verified.gsManagerInventory.totalBytes
        treeSha256 = $verified.gsManagerInventory.treeSha256
        taskStatus = if ([bool]$verified.taskCapture.present) { 'captured' } else { 'absent' }
        pairedSaveProtectionPointId = $protection.protectionPointId
        pairedSaveProtectionManifestSha256 = $protection.manifestSha256
        snapshotPublished = $true
        saveFilesAccepted = $false
        productionChanged = $false
    } | ConvertTo-DysonGsJsonLine
}
finally {
    if (-not $published -and (Test-Path -LiteralPath $stage)) {
        Remove-DysonGsOwnedTree -Path $stage -Parent $snapshotParent -RequiredPrefix '.partial-'
    }
}
