[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$commonScript = Join-Path $PSScriptRoot 'DysonGsManagerMigration.Common.ps1'
$inspectScript = Join-Path $PSScriptRoot 'Get-DysonGsManagerMigration.ps1'
$snapshotScript = Join-Path $PSScriptRoot 'New-DysonGsManagerSnapshot.ps1'
$verifyScript = Join-Path $PSScriptRoot 'Test-DysonGsManagerSnapshot.ps1'
$restoreScript = Join-Path $PSScriptRoot 'Restore-DysonGsManagerSnapshot.ps1'
. $commonScript

$temporaryBase = [System.IO.Path]::GetFullPath([System.IO.Path]::GetTempPath()).TrimEnd('\', '/')
$testRoot = Join-Path $temporaryBase ('dyson-gsm-migration-selftest-' + [guid]::NewGuid().ToString('N'))
$projectRoot = Join-Path $testRoot 'fictional-project'
$gsManagerRoot = Join-Path $projectRoot 'tools\GSManager'
$dataRoot = Join-Path $testRoot 'fictional-program-data\DysonControl'
$taskName = 'Dyson-GSManager-Fixture'
$protectionRequestId = [guid]::NewGuid().ToString('D').ToLowerInvariant()
$protectionPointId = 'save:' + $protectionRequestId
$sensitiveMarker = 'FICTIONAL-SENSITIVE-GSM-TOKEN-DO-NOT-PRINT'
$junctions = New-Object 'System.Collections.Generic.List[string]'

function Assert-MigrationSelfTest {
    param([bool]$Condition, [string]$Message)
    if (-not $Condition) { throw "GSManager migration self-test failed: $Message" }
}

function Write-FixtureText {
    param([string]$Path, [string]$Value)
    [System.IO.Directory]::CreateDirectory([System.IO.Path]::GetDirectoryName($Path)) | Out-Null
    [System.IO.File]::WriteAllText($Path, $Value, [System.Text.UTF8Encoding]::new($false))
}

function Convert-LastMigrationJson {
    param($Output)
    $lines = @(($Output | Out-String) -split "`r?`n" | Where-Object { -not [string]::IsNullOrWhiteSpace($_) })
    if ($lines.Count -eq 0) { throw 'A migration self-test command returned no JSON.' }
    return $lines[$lines.Count - 1] | ConvertFrom-Json
}

function Test-MigrationRejected {
    param([scriptblock]$Command, [ref]$FailureMessage)
    try { & $Command | Out-Null; return $false }
    catch { $FailureMessage.Value = $_.Exception.Message; return $true }
}

function New-FixtureSnapshot {
    $result = Convert-LastMigrationJson -Output (& $snapshotScript -ProjectRoot $projectRoot -GsManagerRoot $gsManagerRoot `
        -DataRoot $dataRoot -TaskName $taskName -PairedSaveProtectionPointId $protectionPointId `
        -PairedSaveProtectionManifestSha256 $script:ProtectionDigest -Confirm:$false)
    Assert-MigrationSelfTest -Condition ($result.state -eq 'snapshotted' -and [bool]$result.snapshotPublished) `
        -Message 'a valid private snapshot was not atomically published'
    return $result
}

# These read-only fixture functions shadow Task Scheduler only inside this self-test.
# They guarantee that no real task is inspected or changed.
$global:DysonGsMigrationSelfTestTaskPresent = $false
$global:DysonGsMigrationSelfTestSensitiveMarker = $sensitiveMarker
function Get-ScheduledTask {
    [CmdletBinding()]
    param([string]$TaskName)
    if ($global:DysonGsMigrationSelfTestTaskPresent) {
        return [pscustomobject][ordered]@{
            State = 'Ready'
            Settings = [pscustomobject][ordered]@{ Enabled = $true }
        }
    }
    throw (New-Object System.Management.Automation.ItemNotFoundException('fictional task is absent'))
}
function Export-ScheduledTask {
    [CmdletBinding()]
    param([string]$TaskName)
    if ($global:DysonGsMigrationSelfTestTaskPresent) {
        return '<Task><Description>' + $global:DysonGsMigrationSelfTestSensitiveMarker + '</Description></Task>'
    }
    throw 'fixture export should not be called for an absent task'
}

try {
    [System.IO.Directory]::CreateDirectory($gsManagerRoot) | Out-Null
    [System.IO.Directory]::CreateDirectory((Join-Path $projectRoot 'server')) | Out-Null
    Write-FixtureText -Path (Join-Path $projectRoot 'server\DSPGAME.exe') -Value 'fictional game executable marker'
    Write-FixtureText -Path (Join-Path $gsManagerRoot 'config\settings.json') `
        -Value ('{"endpoint":"https://example.com","token":"' + $sensitiveMarker + '"}')
    Write-FixtureText -Path (Join-Path $gsManagerRoot 'bin\gsmanager-helper.exe') -Value 'fictional GSManager helper'

    $protectionRoot = Join-Path $projectRoot ('backups\saves\tx-' + $protectionRequestId)
    [System.IO.Directory]::CreateDirectory($protectionRoot) | Out-Null
    $saveName = 'fictional-paired-save'
    $protectionManifest = [ordered]@{
        protocol = 'DYSON_CONTROL_PROTECTION_V1'
        schemaVersion = 1
        requestId = $protectionRequestId
        createdAt = '2026-01-01T00:00:00.0000000Z'
        saveName = $saveName
        files = @(
            [ordered]@{ name = $saveName + '.dsv'; bytes = 17; sha256 = ('1' * 64) },
            [ordered]@{ name = $saveName + '.server'; bytes = 19; sha256 = ('2' * 64) }
        )
    }
    Write-DysonGsUtf8Json -Path (Join-Path $protectionRoot 'manifest.json') -Value $protectionManifest
    Write-FixtureText -Path (Join-Path $protectionRoot ($saveName + '.dsv')) -Value 'paired-dsv-untouched'
    Write-FixtureText -Path (Join-Path $protectionRoot ($saveName + '.server')) -Value 'paired-server-untouched'
    $script:ProtectionDigest = Get-DysonGsSha256 -Path (Join-Path $protectionRoot 'manifest.json')
    $saveDsvBefore = Get-DysonGsSha256 -Path (Join-Path $protectionRoot ($saveName + '.dsv'))
    $saveServerBefore = Get-DysonGsSha256 -Path (Join-Path $protectionRoot ($saveName + '.server'))

    $inspectRaw = & $inspectScript -ProjectRoot $projectRoot -GsManagerRoot $gsManagerRoot -TaskName $taskName
    $inspect = Convert-LastMigrationJson -Output $inspectRaw
    Assert-MigrationSelfTest -Condition ($inspect.state -eq 'inspected' -and [bool]$inspect.dryRun -and
        $inspect.fileCount -eq 2 -and -not [bool]$inspect.productionChanged) -Message 'Inspect was not a bounded no-write inventory'

    $whatIfRaw = & $snapshotScript -ProjectRoot $projectRoot -GsManagerRoot $gsManagerRoot -DataRoot $dataRoot `
        -TaskName $taskName -PairedSaveProtectionPointId $protectionPointId `
        -PairedSaveProtectionManifestSha256 $script:ProtectionDigest -WhatIf 6>$null
    $whatIf = Convert-LastMigrationJson -Output $whatIfRaw
    Assert-MigrationSelfTest -Condition ($whatIf.state -eq 'preview' -and [bool]$whatIf.dryRun -and
        -not [bool]$whatIf.snapshotPublished -and -not (Test-Path -LiteralPath $dataRoot)) `
        -Message 'Snapshot WhatIf wrote to DataRoot'

    $limitFailure = $null
    Assert-MigrationSelfTest -Condition (Test-MigrationRejected -FailureMessage ([ref]$limitFailure) -Command {
        & $snapshotScript -ProjectRoot $projectRoot -GsManagerRoot $gsManagerRoot -DataRoot $dataRoot -TaskName $taskName `
            -PairedSaveProtectionPointId $protectionPointId -PairedSaveProtectionManifestSha256 $script:ProtectionDigest `
            -MaximumFiles 1 -Confirm:$false
    }) -Message 'the file-count limit was not enforced'
    Assert-MigrationSelfTest -Condition (Test-MigrationRejected -FailureMessage ([ref]$limitFailure) -Command {
        & $snapshotScript -ProjectRoot $projectRoot -GsManagerRoot $gsManagerRoot -DataRoot $dataRoot -TaskName $taskName `
            -PairedSaveProtectionPointId $protectionPointId -PairedSaveProtectionManifestSha256 $script:ProtectionDigest `
            -MaximumTotalBytes 20 -MaximumSingleFileBytes 20 -Confirm:$false
    }) -Message 'the total-byte limit was not enforced'
    Assert-MigrationSelfTest -Condition (Test-MigrationRejected -FailureMessage ([ref]$limitFailure) -Command {
        & $snapshotScript -ProjectRoot $projectRoot -GsManagerRoot $gsManagerRoot -DataRoot $dataRoot -TaskName $taskName `
            -PairedSaveProtectionPointId $protectionPointId -PairedSaveProtectionManifestSha256 $script:ProtectionDigest `
            -MaximumTotalBytes 1024 -MaximumSingleFileBytes 4 -Confirm:$false
    }) -Message 'the single-file byte limit was not enforced'

    $forbiddenSave = Join-Path $gsManagerRoot 'config\must-not-copy.server'
    Write-FixtureText -Path $forbiddenSave -Value 'save-like fixture must survive rejection'
    $saveFailure = $null
    Assert-MigrationSelfTest -Condition (Test-MigrationRejected -FailureMessage ([ref]$saveFailure) -Command {
        & $snapshotScript -ProjectRoot $projectRoot -GsManagerRoot $gsManagerRoot -DataRoot $dataRoot -TaskName $taskName `
            -PairedSaveProtectionPointId $protectionPointId -PairedSaveProtectionManifestSha256 $script:ProtectionDigest -Confirm:$false
    }) -Message 'a .server file was accepted into a migration snapshot'
    Assert-MigrationSelfTest -Condition (Test-Path -LiteralPath $forbiddenSave -PathType Leaf) -Message 'a rejected save-like source file was deleted'
    Remove-Item -LiteralPath $forbiddenSave -Force

    $outsideRoot = Join-Path $testRoot 'junction-target'
    [System.IO.Directory]::CreateDirectory($outsideRoot) | Out-Null
    Write-FixtureText -Path (Join-Path $outsideRoot 'outside.txt') -Value 'outside fixture'
    $sourceJunction = Join-Path $gsManagerRoot 'redirected'
    New-Item -ItemType Junction -Path $sourceJunction -Target $outsideRoot -ErrorAction Stop | Out-Null
    $junctions.Add($sourceJunction)
    $reparseFailure = $null
    Assert-MigrationSelfTest -Condition (Test-MigrationRejected -FailureMessage ([ref]$reparseFailure) -Command {
        & $snapshotScript -ProjectRoot $projectRoot -GsManagerRoot $gsManagerRoot -DataRoot $dataRoot -TaskName $taskName `
            -PairedSaveProtectionPointId $protectionPointId -PairedSaveProtectionManifestSha256 $script:ProtectionDigest -Confirm:$false
    }) -Message 'a source reparse point was accepted'
    [System.IO.Directory]::Delete($sourceJunction, $false)
    [void]$junctions.Remove($sourceJunction)

    $tamperSnapshot = New-FixtureSnapshot
    $tamperPath = Join-Path (Get-DysonGsSnapshotRoot -DataRoot $dataRoot -SnapshotId $tamperSnapshot.snapshotId) 'gsmanager\config\settings.json'
    [System.IO.File]::AppendAllText($tamperPath, 'tampered', [System.Text.UTF8Encoding]::new($false))
    $tamperFailure = $null
    Assert-MigrationSelfTest -Condition (Test-MigrationRejected -FailureMessage ([ref]$tamperFailure) -Command {
        & $verifyScript -DataRoot $dataRoot -SnapshotId $tamperSnapshot.snapshotId `
            -ExpectedSnapshotManifestSha256 $tamperSnapshot.snapshotManifestSha256
    }) -Message 'payload tampering was not detected'

    $extraSnapshot = New-FixtureSnapshot
    $extraRoot = Get-DysonGsSnapshotRoot -DataRoot $dataRoot -SnapshotId $extraSnapshot.snapshotId
    Write-FixtureText -Path (Join-Path $extraRoot 'unexpected.txt') -Value 'unexpected snapshot payload'
    $extraFailure = $null
    Assert-MigrationSelfTest -Condition (Test-MigrationRejected -FailureMessage ([ref]$extraFailure) -Command {
        & $verifyScript -DataRoot $dataRoot -SnapshotId $extraSnapshot.snapshotId `
            -ExpectedSnapshotManifestSha256 $extraSnapshot.snapshotManifestSha256
    }) -Message 'an extra snapshot file was not rejected'

    $schemaSnapshot = New-FixtureSnapshot
    $schemaRoot = Get-DysonGsSnapshotRoot -DataRoot $dataRoot -SnapshotId $schemaSnapshot.snapshotId
    $schemaManifestPath = Join-Path $schemaRoot 'manifest.json'
    $schemaManifest = Read-DysonGsJsonBounded -Path $schemaManifestPath
    $schemaManifest | Add-Member -NotePropertyName unexpected -NotePropertyValue 'field'
    Write-DysonGsUtf8Json -Path $schemaManifestPath -Value $schemaManifest
    $schemaManifestDigest = Get-DysonGsSha256 -Path $schemaManifestPath
    $schemaFailure = $null
    Assert-MigrationSelfTest -Condition (Test-MigrationRejected -FailureMessage ([ref]$schemaFailure) -Command {
        & $verifyScript -DataRoot $dataRoot -SnapshotId $schemaSnapshot.snapshotId `
            -ExpectedSnapshotManifestSha256 $schemaManifestDigest
    }) -Message 'an unknown snapshot manifest field was accepted'

    $reparseSnapshot = New-FixtureSnapshot
    $reparseSnapshotRoot = Get-DysonGsSnapshotRoot -DataRoot $dataRoot -SnapshotId $reparseSnapshot.snapshotId
    $snapshotJunction = Join-Path $reparseSnapshotRoot 'gsmanager\redirected'
    New-Item -ItemType Junction -Path $snapshotJunction -Target $outsideRoot -ErrorAction Stop | Out-Null
    $junctions.Add($snapshotJunction)
    $snapshotReparseFailure = $null
    Assert-MigrationSelfTest -Condition (Test-MigrationRejected -FailureMessage ([ref]$snapshotReparseFailure) -Command {
        & $verifyScript -DataRoot $dataRoot -SnapshotId $reparseSnapshot.snapshotId `
            -ExpectedSnapshotManifestSha256 $reparseSnapshot.snapshotManifestSha256
    }) -Message 'a snapshot reparse point was accepted'
    [System.IO.Directory]::Delete($snapshotJunction, $false)
    [void]$junctions.Remove($snapshotJunction)

    $global:DysonGsMigrationSelfTestTaskPresent = $true
    $sensitiveTaskRaw = & $snapshotScript -ProjectRoot $projectRoot -GsManagerRoot $gsManagerRoot -DataRoot $dataRoot `
        -TaskName $taskName -PairedSaveProtectionPointId $protectionPointId `
        -PairedSaveProtectionManifestSha256 $script:ProtectionDigest -Confirm:$false
    $sensitiveTaskSnapshot = Convert-LastMigrationJson -Output $sensitiveTaskRaw
    $sensitiveTaskRoot = Get-DysonGsSnapshotRoot -DataRoot $dataRoot -SnapshotId $sensitiveTaskSnapshot.snapshotId
    $sensitiveTaskVerified = Test-DysonGsSnapshotCore -SnapshotRoot $sensitiveTaskRoot `
        -ExpectedSnapshotId $sensitiveTaskSnapshot.snapshotId -ExpectedManifestSha256 $sensitiveTaskSnapshot.snapshotManifestSha256
    Assert-MigrationSelfTest -Condition ([bool]$sensitiveTaskVerified.taskCapture.present -and
        ([string]$sensitiveTaskVerified.taskCapture.xml).Contains($sensitiveMarker) -and
        -not (($sensitiveTaskRaw | Out-String).Contains($sensitiveMarker))) `
        -Message 'private scheduled-task XML was not captured or leaked into output'
    $global:DysonGsMigrationSelfTestTaskPresent = $false

    $restoreSnapshot = New-FixtureSnapshot
    $verifiedPublicRaw = & $verifyScript -DataRoot $dataRoot -SnapshotId $restoreSnapshot.snapshotId `
        -ExpectedSnapshotManifestSha256 $restoreSnapshot.snapshotManifestSha256
    $verifiedPublic = Convert-LastMigrationJson -Output $verifiedPublicRaw
    Assert-MigrationSelfTest -Condition ($verifiedPublic.state -eq 'verified' -and [bool]$verifiedPublic.schemaStrict) `
        -Message 'a valid snapshot did not pass full verification'

    $allPublicOutput = (($inspectRaw | Out-String) + ($whatIfRaw | Out-String) + ($verifiedPublicRaw | Out-String))
    Assert-MigrationSelfTest -Condition (-not $allPublicOutput.Contains($sensitiveMarker) -and
        -not $allPublicOutput.Contains($testRoot) -and -not $allPublicOutput.Contains('DSPGAME.exe')) `
        -Message 'sensitive content, a path, or a command leaked into migration JSON'

    $originalHold = Join-Path $projectRoot 'tools\GSManager-original-fixture'
    [System.IO.Directory]::Move($gsManagerRoot, $originalHold)
    [System.IO.Directory]::CreateDirectory($gsManagerRoot) | Out-Null
    $restorePreviewRaw = & $restoreScript -ProjectRoot $projectRoot -GsManagerRoot $gsManagerRoot -DataRoot $dataRoot `
        -SnapshotId $restoreSnapshot.snapshotId -ExpectedSnapshotManifestSha256 $restoreSnapshot.snapshotManifestSha256 `
        -PairedSaveProtectionPointId $protectionPointId -PairedSaveProtectionManifestSha256 $script:ProtectionDigest `
        -TaskName $taskName -Confirmation 'RESTORE_GSMANAGER_SNAPSHOT' -WhatIf 6>$null
    $restorePreview = Convert-LastMigrationJson -Output $restorePreviewRaw
    Assert-MigrationSelfTest -Condition ($restorePreview.state -eq 'preview' -and [bool]$restorePreview.dryRun -and
        -not [bool]$restorePreview.restoreGuardPublished -and @(Get-ChildItem -LiteralPath $gsManagerRoot -Force).Count -eq 0) `
        -Message 'Restore WhatIf mutated the empty target'

    $layout = Resolve-DysonGsLayout -ProjectRoot $projectRoot -GsManagerRoot $gsManagerRoot -DataRoot $dataRoot
    $snapshotVerification = Test-DysonGsSnapshotCore -SnapshotRoot (Get-DysonGsSnapshotRoot -DataRoot $dataRoot `
        -SnapshotId $restoreSnapshot.snapshotId) -ExpectedSnapshotId $restoreSnapshot.snapshotId `
        -ExpectedManifestSha256 $restoreSnapshot.snapshotManifestSha256
    $currentTaskCapture = [pscustomobject][ordered]@{
        taskName = $taskName
        present = $true
        enabled = $true
        state = 'Ready'
        xml = '<Task><Description>' + $sensitiveMarker + '</Description></Task>'
    }
    $script:TaskApplyEvents = New-Object 'System.Collections.Generic.List[string]'
    $taskApply = {
        param($capture, $selectedTaskName)
        $captureStatus = if ([bool]$capture.present) { 'present' } else { 'absent' }
        $script:TaskApplyEvents.Add($captureStatus)
    }
    $coreResult = Invoke-DysonGsRestoreCore -Layout $layout -SnapshotVerification $snapshotVerification -DataRoot $dataRoot `
        -Disposition 'empty' -CurrentTaskCapture $currentTaskCapture -TaskApply $taskApply
    Assert-MigrationSelfTest -Condition ([bool]$coreResult.rootChanged -and $script:TaskApplyEvents.Count -eq 1 -and
        $script:TaskApplyEvents[0] -eq 'absent') -Message 'the restore core did not apply the exact captured task state'
    $restoredInventory = Get-DysonGsTreeInventory -Root $gsManagerRoot -RejectSaveFiles
    $expectedUnprefixed = @($snapshotVerification.gsManagerInventory.entries | ForEach-Object {
        [pscustomobject][ordered]@{ path = ([string]$_.path).Substring('gsmanager/'.Length); length = [int64]$_.length; sha256 = [string]$_.sha256 }
    })
    Assert-MigrationSelfTest -Condition (Test-DysonGsEntryListsEqual -Left $expectedUnprefixed -Right $restoredInventory.entries) `
        -Message 'the GSManager root did not restore byte-for-byte'
    $guardRoot = Join-Path (Join-Path $dataRoot $script:DysonGsGuardRelativeRoot) $coreResult.guardId
    $guardVerified = Test-DysonGsGuardCore -GuardRoot $guardRoot -GuardId $coreResult.guardId -Limits $snapshotVerification.manifest.limits
    Assert-MigrationSelfTest -Condition ([bool]$guardVerified.manifest.root.existed -and [bool]$guardVerified.taskCapture.present) `
        -Message 'the private restore guard did not capture root and task state'

    Write-FixtureText -Path (Join-Path $gsManagerRoot 'conflict.txt') -Value 'different target'
    $conflictLayout = Resolve-DysonGsLayout -ProjectRoot $projectRoot -GsManagerRoot $gsManagerRoot -DataRoot $dataRoot
    $conflictFailure = $null
    Assert-MigrationSelfTest -Condition (Test-MigrationRejected -FailureMessage ([ref]$conflictFailure) -Command {
        Get-DysonGsRestoreDisposition -Layout $conflictLayout -SnapshotVerification $snapshotVerification
    }) -Message 'restore accepted a non-empty different GSManager tree'
    Remove-Item -LiteralPath (Join-Path $gsManagerRoot 'conflict.txt') -Force

    $successfulRestoreHold = Join-Path $projectRoot 'tools\GSManager-restored-fixture'
    [System.IO.Directory]::Move($gsManagerRoot, $successfulRestoreHold)
    [System.IO.Directory]::CreateDirectory($gsManagerRoot) | Out-Null
    $failureLayout = Resolve-DysonGsLayout -ProjectRoot $projectRoot -GsManagerRoot $gsManagerRoot -DataRoot $dataRoot
    $script:TaskApplyCount = 0
    $failingTaskApply = {
        param($capture, $selectedTaskName)
        $script:TaskApplyCount++
        if ($script:TaskApplyCount -eq 1) { throw ('fixture task failure ' + $sensitiveMarker) }
    }
    $compensationFailure = $null
    Assert-MigrationSelfTest -Condition (Test-MigrationRejected -FailureMessage ([ref]$compensationFailure) -Command {
        Invoke-DysonGsRestoreCore -Layout $failureLayout -SnapshotVerification $snapshotVerification -DataRoot $dataRoot `
            -Disposition 'empty' -CurrentTaskCapture $currentTaskCapture -TaskApply $failingTaskApply
    }) -Message 'the injected task restore failure unexpectedly succeeded'
    Assert-MigrationSelfTest -Condition ($compensationFailure -eq 'GSManager restore failed and was compensated from its restore guard.' -and
        $script:TaskApplyCount -eq 2 -and (Test-Path -LiteralPath $gsManagerRoot -PathType Container) -and
        @(Get-ChildItem -LiteralPath $gsManagerRoot -Force).Count -eq 0) `
        -Message 'a restore failure did not compensate root and task from the guard'

    Assert-MigrationSelfTest -Condition ((Get-DysonGsSha256 -Path (Join-Path $protectionRoot ($saveName + '.dsv'))) -eq $saveDsvBefore -and
        (Get-DysonGsSha256 -Path (Join-Path $protectionRoot ($saveName + '.server'))) -eq $saveServerBefore -and
        (Test-Path -LiteralPath (Join-Path $originalHold 'config\settings.json') -PathType Leaf) -and
        (Test-Path -LiteralPath (Join-Path $successfulRestoreHold 'config\settings.json') -PathType Leaf) -and
        (Test-Path -LiteralPath (Join-Path $projectRoot 'server\DSPGAME.exe') -PathType Leaf)) `
        -Message 'the migration workflow deleted or changed GSM, game, or paired-save fixtures'
    $partialDirectories = @(Get-ChildItem -LiteralPath $dataRoot -Directory -Recurse -Force -ErrorAction Stop | Where-Object { $_.Name.StartsWith('.partial-') })
    Assert-MigrationSelfTest -Condition ($partialDirectories.Count -eq 0) -Message 'a failed operation left a partial snapshot or guard'

    [ordered]@{
        protocol = 'DYSON_GSMANAGER_MIGRATION_SELFTEST_V1'
        state = 'passed'
        inspectAndWhatIfNonMutating = $true
        snapshotAtomicAndPrivate = $true
        pairedSaveProtectionBound = $true
        pairedSaveFilesNeverSnapshotted = $true
        strictSchemaAndFullRehash = $true
        tamperExtraAndReparseRejected = $true
        fileCountTotalAndSingleFileLimitsEnforced = $true
        sensitiveOutputRedacted = $true
        restoreGuardVerified = $true
        restoreConflictRejected = $true
        restoreFailureCompensated = $true
        gsmGameAndSavesPreserved = $true
        taskOrGameStarted = $false
        productionChanged = $false
    } | ConvertTo-Json -Depth 5 -Compress
}
finally {
    Remove-Variable -Name 'DysonGsMigrationSelfTestTaskPresent' -Scope Global -ErrorAction SilentlyContinue
    Remove-Variable -Name 'DysonGsMigrationSelfTestSensitiveMarker' -Scope Global -ErrorAction SilentlyContinue
    foreach ($junction in @($junctions)) {
        if (Test-Path -LiteralPath $junction) {
            $item = Get-Item -LiteralPath $junction -Force -ErrorAction SilentlyContinue
            if ($item -and ($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint)) {
                try { [System.IO.Directory]::Delete($junction, $false) } catch {}
            }
        }
    }
    $testFull = [System.IO.Path]::GetFullPath($testRoot).TrimEnd('\', '/')
    $expectedPrefix = $temporaryBase + [System.IO.Path]::DirectorySeparatorChar + 'dyson-gsm-migration-selftest-'
    if ($testFull.StartsWith($expectedPrefix, [System.StringComparison]::OrdinalIgnoreCase) -and (Test-Path -LiteralPath $testFull)) {
        Remove-Item -LiteralPath $testFull -Recurse -Force
    }
}
