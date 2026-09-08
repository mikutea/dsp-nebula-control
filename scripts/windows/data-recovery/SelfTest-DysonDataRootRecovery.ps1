[CmdletBinding()]
param()

Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'
$env:DYSON_DATA_ROOT_RECOVERY_SELFTEST = '1'
. (Join-Path $PSScriptRoot 'DysonDataRootRecovery.Common.ps1')

$newScript = Join-Path $PSScriptRoot 'New-DysonDataRootRecoveryBundle.ps1'
$testScript = Join-Path $PSScriptRoot 'Test-DysonDataRootRecoveryBundle.ps1'
$restoreScript = Join-Path $PSScriptRoot 'Restore-DysonDataRootRecoveryBundle.ps1'
$fixtureRoot = Join-Path ([System.IO.Path]::GetTempPath()) ('.dyson-data-root-recovery-selftest-' + [guid]::NewGuid().ToString('N'))
$shadowRoot = $fixtureRoot
$dataRoot = Join-Path $fixtureRoot 'data-root'
$recoveryRoot = Join-Path $fixtureRoot 'recovery-root'
$privateMarker = 'DYSON_' + 'RECOVERY_' + 'PRIVATE_' + 'MARKER_' + '7f2d' + '95b1'
$stage = 'fixture'

function Assert-SelfTest {
    param([Parameter(Mandatory)][bool]$Condition, [Parameter(Mandatory)][string]$Message)
    if (-not $Condition) { throw ('data recovery self-test: ' + $Message) }
}

function Write-SelfTestUtf8 {
    param([Parameter(Mandatory)][string]$Path, [Parameter(Mandatory)][AllowEmptyString()][string]$Value)
    $parent = Get-DysonDataRootRecoveryParentPath $Path
    if (-not (Test-DysonDataRootRecoveryDirectoryExists $parent)) {
        [void](New-DysonDataRootRecoveryPrivateDirectory $parent)
    }
    [System.IO.File]::WriteAllText(
        (ConvertTo-DysonDataRootRecoveryExtendedPath $Path),
        $Value,
        [System.Text.UTF8Encoding]::new($false)
    )
}

function Write-SelfTestTask {
    param([Parameter(Mandatory)][ValidateSet('Ready', 'Disabled', 'Running', 'Queued')][string]$State)
    $task = [pscustomobject][ordered]@{
        protocol = $script:DysonDataRootRecoveryShadowTaskProtocol
        schemaVersion = 1
        taskName = 'Dyson-Control-Plane'
        taskPath = '\'
        state = $State
        enabled = ($State -cne 'Disabled')
    }
    Write-SelfTestUtf8 (Join-Path $shadowRoot 'control-task.json') (ConvertTo-DysonDataRootRecoveryJson $task)
}

function Get-SelfTestJson {
    param([Parameter(Mandatory)]$Output)
    foreach ($item in @($Output | Select-Object -Last 10)) {
        $text = [string]$item
        if ($text.TrimStart().StartsWith('{')) {
            try { return ($text | ConvertFrom-Json) } catch {}
        }
    }
    throw 'data recovery self-test: JSON result missing'
}

function Assert-SelfTestFailure {
    param([Parameter(Mandatory)][scriptblock]$Action, [Parameter(Mandatory)][string]$ExpectedCode)
    $observed = $null
    try { [void](& $Action) }
    catch { $observed = Get-DysonDataRootRecoveryErrorCode $_.Exception }
    Assert-SelfTest ($observed -ceq $ExpectedCode) ('expected failure ' + $ExpectedCode + ', observed ' + [string]$observed)
}

function Invoke-SelfTestChildPowerShell {
    param(
        [Parameter(Mandatory)][string]$ScriptPath,
        [Parameter(Mandatory)][string[]]$Arguments
    )

    $quotedScript = "'" + $ScriptPath.Replace("'", "''") + "'"
    $commandArguments = @()
    foreach ($argument in $Arguments) {
        if ($argument -cmatch '^-[A-Za-z][A-Za-z0-9]*$') { $commandArguments += $argument }
        else { $commandArguments += ("'" + $argument.Replace("'", "''") + "'") }
    }
    $command = "`$ConfirmPreference = 'None'; & " + $quotedScript + ' ' + ($commandArguments -join ' ')
    $encodedCommand = [Convert]::ToBase64String([System.Text.Encoding]::Unicode.GetBytes($command))
    $nativeArguments = @(
        '-NoLogo',
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy', 'Bypass',
        '-EncodedCommand', $encodedCommand
    )
    $priorErrorActionPreference = $ErrorActionPreference
    try {
        $ErrorActionPreference = 'Continue'
        $output = @(& powershell.exe @nativeArguments 2>&1)
        $exitCode = [int]$LASTEXITCODE
    }
    finally { $ErrorActionPreference = $priorErrorActionPreference }
    return [pscustomobject][ordered]@{
        exitCode = $exitCode
        output = @($output)
        text = ($output | Out-String)
    }
}

function Set-SelfTestPrivateFileAcl {
    param([Parameter(Mandatory)][string]$Path)
    $identity = [System.Security.Principal.WindowsIdentity]::GetCurrent()
    $security = New-Object System.Security.AccessControl.FileSecurity
    $security.SetAccessRuleProtection($true, $false)
    $security.SetOwner($identity.User)
    $rule = New-Object System.Security.AccessControl.FileSystemAccessRule(
        $identity.User,
        [System.Security.AccessControl.FileSystemRights]::FullControl,
        [System.Security.AccessControl.AccessControlType]::Allow
    )
    [void]$security.AddAccessRule($rule)
    Microsoft.PowerShell.Security\Set-Acl `
        -LiteralPath (ConvertTo-DysonDataRootRecoveryExtendedPath $Path) `
        -AclObject $security -ErrorAction Stop
}

try {
    $expectedSecurityModulePath = [System.IO.Path]::GetFullPath((Join-Path $PSHOME `
        'Modules\Microsoft.PowerShell.Security\Microsoft.PowerShell.Security.psd1'))
    $boundSecurityModules = @(Get-Module Microsoft.PowerShell.Security | Where-Object {
        [System.IO.Path]::GetFullPath([string]$_.Path).Equals(
            $expectedSecurityModulePath,
            [System.StringComparison]::OrdinalIgnoreCase
        )
    })
    Assert-SelfTest ($boundSecurityModules.Count -eq 1) `
        'Microsoft.PowerShell.Security was not bound to the current engine module'

    [void][System.IO.Directory]::CreateDirectory(
        (ConvertTo-DysonDataRootRecoveryExtendedPath $fixtureRoot)
    )
    Write-SelfTestUtf8 (Join-Path $fixtureRoot '.dyson-data-root-recovery-shadow') 'shadow-only'
    Write-SelfTestTask Ready
    foreach ($relative in @('config', 'data', 'logs', 'state', 'snapshots', 'migration', 'audit', 'runtime-task-transactions', 'acceptance')) {
        [void][System.IO.Directory]::CreateDirectory((Join-Path $dataRoot $relative))
    }
    $secretSettingName = 'DYSON_' + 'SESSION_' + 'SECRET'
    Write-SelfTestUtf8 (Join-Path $dataRoot 'config\dyson-control.env') ("NODE_ENV=production`n" + $secretSettingName + '=' + $privateMarker + "`n")
    Write-SelfTestUtf8 (Join-Path $dataRoot 'data\control.sqlite') 'checkpointed-sqlite-fixture'
    Write-SelfTestUtf8 (Join-Path $dataRoot 'data\world.dsv') 'paired-save-data'
    Write-SelfTestUtf8 (Join-Path $dataRoot 'data\world.server') 'paired-server-data'
    Write-SelfTestUtf8 (Join-Path $dataRoot 'logs\control.log') ('private-log-' + $privateMarker)
    Write-SelfTestUtf8 (Join-Path $dataRoot 'state\active-release.json') '{"version":"selftest"}'
    foreach ($relative in @('data\Z-state.json', 'data\a-state.json', 'data\_state.json')) {
        Write-SelfTestUtf8 (Join-Path $dataRoot $relative) 'ordinal-order-fixture'
    }
    # Reproduce the legacy inheritance model seen on hosted Windows runners,
    # independently of the default ACLs on the machine running this test.
    $legacyAclDirectory = Join-Path $dataRoot 'data\legacy-acl'
    [void][System.IO.Directory]::CreateDirectory($legacyAclDirectory)
    $legacyAcl = Get-DysonDataRootRecoveryAclIntent $legacyAclDirectory
    $legacyDescriptor = [System.Security.AccessControl.RawSecurityDescriptor]::new([Convert]::FromBase64String($legacyAcl.binaryBase64), 0)
    $legacyDescriptor.SetFlags([System.Security.AccessControl.ControlFlags]([int]$legacyDescriptor.ControlFlags -band (-bnot 1024)))
    $legacyBytes = New-Object byte[] $legacyDescriptor.BinaryLength
    $legacyDescriptor.GetBinaryForm($legacyBytes, 0)
    Initialize-DysonDataRootRecoveryNativeAcl
    Assert-SelfTest ([Dyson.DataRootRecoveryNativeAcl]::SetFileSecurity($legacyAclDirectory, [uint32]7, $legacyBytes)) `
        'legacy ACL fixture could not be created'
    $legacyObserved = Get-DysonDataRootRecoveryAclIntent $legacyAclDirectory
    Assert-SelfTest ($legacyObserved.binaryBase64 -ceq [Convert]::ToBase64String($legacyBytes)) `
        'legacy ACL fixture did not retain its exact descriptor'
    Write-SelfTestUtf8 (Join-Path $legacyAclDirectory 'child.json') 'legacy-inheritance-child'
    # These directories are emitted by the current installer/configuration tools.
    # They must survive the same byte/ACL restore and rollback checks as the database.
    $installerStatePaths = @(
        '.dyson-control-deployment-locks\fixture.lock',
        'authority-inventory\fixture.json',
        'configuration-snapshots\fixture.json',
        'configuration-transactions\fixture.json',
        'game-access-snapshots\fixture.json',
        'private\fixture.json'
    )
    foreach ($relative in $installerStatePaths) {
        Write-SelfTestUtf8 (Join-Path $dataRoot $relative) ('installer-state-' + $privateMarker)
    }
    $longComponent = 'extended-length-' + ('x' * 144)
    $longRelativePath = Join-Path (Join-Path 'data' $longComponent) 'deep-state.json'
    $longPath = Join-Path $dataRoot $longRelativePath
    Assert-SelfTest ($longPath.Length -gt 260) 'extended-length fixture did not cross MAX_PATH'
    Write-SelfTestUtf8 $longPath 'extended-length-payload'
    $largePath = Join-Path $dataRoot 'data\large-control-state.bin'
    $largeStream = [System.IO.FileStream]::new(
        (ConvertTo-DysonDataRootRecoveryExtendedPath $largePath),
        [System.IO.FileMode]::CreateNew,
        [System.IO.FileAccess]::Write,
        [System.IO.FileShare]::None
    )
    try {
        $block = New-Object byte[] 1048576
        for ($i = 0; $i -lt $block.Length; $i++) { $block[$i] = [byte](($i * 31 + 17) % 251) }
        for ($i = 0; $i -lt 32; $i++) { $largeStream.Write($block, 0, $block.Length) }
        $largeStream.Flush($true)
    }
    finally { $largeStream.Dispose() }
    Assert-SelfTest ((Get-DysonDataRootRecoveryEntryInfo $largePath).Length -eq 33554432) `
        'large fixture was not created at 32 MiB'

    $commonArgs = @{
        DataRoot = $dataRoot
        RecoveryRoot = $recoveryRoot
        ControlTaskName = 'Dyson-Control-Plane'
        Backend = 'Shadow'
        ShadowRoot = $shadowRoot
    }

    $stage = 'preflight-negative-cases'
    $unknownRootFile = Join-Path $dataRoot 'unrecognized-installer-state.json'
    Write-SelfTestUtf8 $unknownRootFile 'must-not-be-silently-included'
    Assert-SelfTestFailure { & $newScript @commonArgs -BundleId ([guid]::NewGuid().ToString('D')) -WhatIf } 'DYSON_CONTROL_DATA_RECOVERY_TREE_INVALID'
    [System.IO.File]::Delete($unknownRootFile)
    # Fail closed before any bundle mutation when SQLite sidecars, incomplete save pairs,
    # reparse points, broker work, or a running control task are observed.
    $walPath = Join-Path $dataRoot 'data\control.sqlite-wal'
    Write-SelfTestUtf8 $walPath 'pending-wal'
    Assert-SelfTestFailure { & $newScript @commonArgs -BundleId ([guid]::NewGuid().ToString('D')) -WhatIf } 'DYSON_CONTROL_DATA_RECOVERY_SQLITE_NOT_CHECKPOINTED'
    [System.IO.File]::Delete($walPath)

    $shmPath = Join-Path $dataRoot 'data\control.sqlite-shm'
    Write-SelfTestUtf8 $shmPath 'pending-shm'
    Assert-SelfTestFailure { & $newScript @commonArgs -BundleId ([guid]::NewGuid().ToString('D')) -WhatIf } 'DYSON_CONTROL_DATA_RECOVERY_SQLITE_NOT_CHECKPOINTED'
    [System.IO.File]::Delete($shmPath)

    $unpaired = Join-Path $dataRoot 'data\unpaired.dsv'
    Write-SelfTestUtf8 $unpaired 'unpaired'
    Assert-SelfTestFailure { & $newScript @commonArgs -BundleId ([guid]::NewGuid().ToString('D')) -WhatIf } 'DYSON_CONTROL_DATA_RECOVERY_SAVE_PAIR_INVALID'
    [System.IO.File]::Delete($unpaired)

    $outside = Join-Path $fixtureRoot 'junction-target'
    [void][System.IO.Directory]::CreateDirectory($outside)
    Write-SelfTestUtf8 (Join-Path $outside 'escaped.txt') 'escaped'
    $junction = Join-Path $dataRoot 'logs\escape-link'
    [void](New-Item -ItemType Junction -Path $junction -Target $outside -ErrorAction Stop)
    Assert-SelfTestFailure { & $newScript @commonArgs -BundleId ([guid]::NewGuid().ToString('D')) -WhatIf } 'DYSON_CONTROL_DATA_RECOVERY_TREE_INVALID'
    [System.IO.Directory]::Delete($junction)

    $brokerRoot = Join-Path $dataRoot 'data\cutover-broker'
    foreach ($relative in @('requests', 'receipts', 'intents', 'work')) { [void][System.IO.Directory]::CreateDirectory((Join-Path $brokerRoot $relative)) }
    Write-SelfTestUtf8 (Join-Path $brokerRoot ('requests\' + [guid]::NewGuid().ToString('D') + '.json')) '{}'
    Assert-SelfTestFailure { & $newScript @commonArgs -BundleId ([guid]::NewGuid().ToString('D')) -WhatIf } 'DYSON_CONTROL_DATA_RECOVERY_PENDING_MUTATION'
    [System.IO.Directory]::Delete($brokerRoot, $true)

    $cutoverRoot = Join-Path $dataRoot 'data\cutover-broker'
    foreach ($relative in @('requests', 'receipts', 'intents', 'work')) {
        [void][System.IO.Directory]::CreateDirectory((Join-Path $cutoverRoot $relative))
    }
    $terminalId = [guid]::NewGuid().ToString('D')
    $terminalPath = Join-Path $cutoverRoot ('receipts\' + $terminalId + '.json')
    $closedRead = [ordered]@{
        protocol = 'DYSON_CONTROL_CUTOVER_BROKER_RECEIPT_V1'; schemaVersion = 1
        brokerRequestId = $terminalId; requestFingerprint = ('a' * 64)
        capability = 'CutoverEvidence'; requestId = [guid]::NewGuid().ToString('D')
        authorityInventoryRevision = ('b' * 64); state = 'failed'
        errorCode = 'DYSON_CONTROL_CUTOVER_BROKER_RECOVERY_REQUIRED'; childReceipt = $null
        createdAt = '2026-01-01T00:00:00.0000000Z'; completedAt = '2026-01-01T00:00:01.0000000Z'
    }
    Write-SelfTestUtf8 $terminalPath ($closedRead | ConvertTo-Json -Depth 8 -Compress)
    Assert-SelfTest ((Assert-DysonDataRootRecoveryBrokerHistoryClosed $cutoverRoot cutover) -eq 1) `
        'a terminal read-only receipt with a consumed request was rejected'
    $closedRead.capability = 'StartCandidateRuntime'
    Write-SelfTestUtf8 $terminalPath ($closedRead | ConvertTo-Json -Depth 8 -Compress)
    Assert-SelfTestFailure { Assert-DysonDataRootRecoveryBrokerHistoryClosed $cutoverRoot cutover } 'DYSON_CONTROL_DATA_RECOVERY_PENDING_MUTATION'
    $closedRead.capability = 'CutoverEvidence'; $closedRead.requestFingerprint = 'invalid'
    Write-SelfTestUtf8 $terminalPath ($closedRead | ConvertTo-Json -Depth 8 -Compress)
    Assert-SelfTestFailure { Assert-DysonDataRootRecoveryBrokerHistoryClosed $cutoverRoot cutover } 'DYSON_CONTROL_DATA_RECOVERY_PENDING_MUTATION'
    $closedRead.requestFingerprint = ('a' * 64)
    Write-SelfTestUtf8 $terminalPath ($closedRead | ConvertTo-Json -Depth 8 -Compress)
    $pendingPath = Join-Path $cutoverRoot ('intents\' + $terminalId + '.json')
    Write-SelfTestUtf8 $pendingPath '{}'
    Assert-SelfTestFailure { Assert-DysonDataRootRecoveryBrokerHistoryClosed $cutoverRoot cutover } 'DYSON_CONTROL_DATA_RECOVERY_PENDING_MUTATION'
    [System.IO.File]::Delete($pendingPath)
    $pendingPath = Join-Path $cutoverRoot ('requests\' + [guid]::NewGuid().ToString('D') + '.json')
    Write-SelfTestUtf8 $pendingPath '{}'
    Assert-SelfTestFailure { Assert-DysonDataRootRecoveryBrokerHistoryClosed $cutoverRoot cutover } 'DYSON_CONTROL_DATA_RECOVERY_PENDING_MUTATION'
    [System.IO.File]::Delete($pendingPath)

    Write-SelfTestTask Running
    Assert-SelfTestFailure { & $newScript @commonArgs -BundleId ([guid]::NewGuid().ToString('D')) -WhatIf } 'DYSON_CONTROL_DATA_RECOVERY_TASK_NOT_QUIESCED'
    Write-SelfTestTask Ready

    $stage = 'create-whatif'
    # WhatIf is a full read-only validation: it creates neither RecoveryRoot nor the
    # host mutation sidecar and never returns file contents or an input path.
    $bundleId = [guid]::NewGuid().ToString('D')
    $lockRoot = Join-Path $fixtureRoot '.dyson-control-deployment-locks'
    Assert-SelfTest (-not (Test-DysonDataRootRecoveryPathExists $recoveryRoot)) 'RecoveryRoot existed before WhatIf'
    Assert-SelfTest (-not (Test-DysonDataRootRecoveryPathExists $lockRoot)) 'host lock root existed before WhatIf'
    $previewOutput = @(& $newScript @commonArgs -BundleId $bundleId -WhatIf 6>&1)
    $preview = Get-SelfTestJson $previewOutput
    Assert-SelfTest ($preview.wouldMutate -and $preview.taskQuiesced -and -not $preview.pendingMutation) 'create WhatIf result is incomplete'
    Assert-SelfTest (-not (Test-DysonDataRootRecoveryPathExists $recoveryRoot)) 'create WhatIf wrote RecoveryRoot'
    Assert-SelfTest (-not (Test-DysonDataRootRecoveryPathExists $lockRoot)) 'create WhatIf wrote the host lease'
    $previewText = ($previewOutput | Out-String)
    Assert-SelfTest (-not $previewText.Contains($privateMarker) -and -not $previewText.Contains($dataRoot)) 'create WhatIf disclosed private material'
    $identityStem = ([string]$preview.dataRootIdentity).Substring(7)
    $intentFinalPath = Join-Path (Join-Path (Join-Path (Join-Path $recoveryRoot 'state') $identityStem) 'intents') `
        ($bundleId + '.json')
    $intentAtomicPartialLength = $intentFinalPath.Length + '.partial-'.Length + 32
    Assert-SelfTest ($intentAtomicPartialLength -gt 260) `
        'atomic intent temporary path did not cross MAX_PATH'

    $stage = 'create'
    $createOutput = @(& $newScript @commonArgs -BundleId $bundleId -Confirm:$false)
    $created = Get-SelfTestJson $createOutput
    Assert-SelfTest (-not $created.reused -and [string]$created.manifestSha256 -match '^[0-9a-f]{64}$' -and
        [int64]$created.totalBytes -ge 33554432) 'bundle creation result is invalid'
    Assert-SelfTest (-not (($createOutput | Out-String).Contains($privateMarker))) 'bundle creation output disclosed private content'

    $stage = 'create-replay'
    $replayCreate = Get-SelfTestJson @(& $newScript @commonArgs -BundleId $bundleId -Confirm:$false)
    Assert-SelfTest ($replayCreate.reused -and [string]$replayCreate.manifestSha256 -ceq [string]$created.manifestSha256) 'create receipt replay was not idempotent'

    $stage = 'independent-verify'
    $testOutput = @(& $testScript -RecoveryRoot $recoveryRoot -BundleId $bundleId -ExpectedManifestSha256 $created.manifestSha256)
    $verified = Get-SelfTestJson $testOutput
    Assert-SelfTest ($verified.valid -and $verified.fileCount -ge 7 -and $verified.totalBytes -ge 33554432) 'independent bundle verification failed'
    Assert-SelfTest (-not (($testOutput | Out-String).Contains($privateMarker))) 'bundle verification output disclosed private content'

    $bundleRoot = Join-Path (Join-Path $recoveryRoot 'bundles') $bundleId
    $manifestPath = Join-Path $bundleRoot 'manifest.json'
    $payloadConfig = Join-Path $bundleRoot 'payload\config\dyson-control.env'
    $manifestBytes = [System.IO.File]::ReadAllBytes($manifestPath)
    $payloadBytes = [System.IO.File]::ReadAllBytes($payloadConfig)

    $stage = 'extra-entry-tamper'
    Write-SelfTestUtf8 (Join-Path $bundleRoot 'unexpected.txt') 'extra'
    Assert-SelfTestFailure { & $testScript -RecoveryRoot $recoveryRoot -BundleId $bundleId -ExpectedManifestSha256 $created.manifestSha256 } 'DYSON_CONTROL_DATA_RECOVERY_BUNDLE_INVALID'
    [System.IO.File]::Delete((Join-Path $bundleRoot 'unexpected.txt'))

    $stage = 'payload-tamper'
    [System.IO.File]::WriteAllText($payloadConfig, 'tampered-payload', [System.Text.UTF8Encoding]::new($false))
    Assert-SelfTestFailure { & $testScript -RecoveryRoot $recoveryRoot -BundleId $bundleId -ExpectedManifestSha256 $created.manifestSha256 } 'DYSON_CONTROL_DATA_RECOVERY_BUNDLE_INVALID'
    [System.IO.File]::WriteAllBytes($payloadConfig, $payloadBytes)

    $stage = 'missing-entry-tamper'
    $missingPath = Join-Path $bundleRoot 'payload\logs\control.log'
    $missingBytes = [System.IO.File]::ReadAllBytes($missingPath)
    [System.IO.File]::Delete($missingPath)
    Assert-SelfTestFailure { & $testScript -RecoveryRoot $recoveryRoot -BundleId $bundleId -ExpectedManifestSha256 $created.manifestSha256 } 'DYSON_CONTROL_DATA_RECOVERY_BUNDLE_INVALID'
    [System.IO.File]::WriteAllBytes($missingPath, $missingBytes)

    $stage = 'manifest-tamper'
    $tamperedManifest = [byte[]]$manifestBytes.Clone()
    $tamperedManifest[$tamperedManifest.Length - 2] = $tamperedManifest[$tamperedManifest.Length - 2] -bxor 1
    [System.IO.File]::WriteAllBytes($manifestPath, $tamperedManifest)
    Assert-SelfTestFailure { & $testScript -RecoveryRoot $recoveryRoot -BundleId $bundleId -ExpectedManifestSha256 $created.manifestSha256 } 'DYSON_CONTROL_DATA_RECOVERY_BUNDLE_INVALID'
    [System.IO.File]::WriteAllBytes($manifestPath, $manifestBytes)
    [void](& $testScript -RecoveryRoot $recoveryRoot -BundleId $bundleId -ExpectedManifestSha256 $created.manifestSha256)

    $stage = 'restore-whatif'
    # Change both bytes and ACL after the bundle. WhatIf and missing confirmation must
    # not create a protection point or alter the current tree.
    $configPath = Join-Path $dataRoot 'config\dyson-control.env'
    Write-SelfTestUtf8 $configPath 'mutated-current-state'
    foreach ($relative in $installerStatePaths) {
        Write-SelfTestUtf8 (Join-Path $dataRoot $relative) 'mutated-installer-state'
    }
    Set-SelfTestPrivateFileAcl $configPath
    Write-SelfTestUtf8 (Join-Path $dataRoot 'data\post-bundle.txt') 'post-bundle'
    $beforeRestorePreview = Get-DysonDataRootRecoveryTreeInventory $dataRoot
    $restorePreviewId = [guid]::NewGuid().ToString('D')
    $restorePreviewOutput = @(& $restoreScript @commonArgs -BundleId $bundleId -ExpectedManifestSha256 $created.manifestSha256 `
        -OperationId $restorePreviewId -WhatIf 6>&1)
    $restorePreview = Get-SelfTestJson $restorePreviewOutput
    Assert-SelfTest ($restorePreview.protectionPointWouldBeCreated -and $restorePreview.wouldMutate) 'restore WhatIf result is incomplete'
    Assert-SelfTest (-not (Test-DysonDataRootRecoveryPathExists (Join-Path (Join-Path $recoveryRoot 'protection-points') $restorePreviewId))) 'restore WhatIf created a protection point'
    Assert-SelfTest ([string]$created.dataRootIdentity -ceq [string]$preview.dataRootIdentity) `
        'create changed the preflight DataRoot identity'
    Assert-SelfTest (-not (Test-DysonDataRootRecoveryPathExists (Join-Path (Join-Path (Join-Path $recoveryRoot 'state') $identityStem) ('receipts\' + $restorePreviewId + '.json')))) 'restore WhatIf wrote a receipt'
    $afterRestorePreview = Get-DysonDataRootRecoveryTreeInventory $dataRoot
    Assert-SelfTest ($beforeRestorePreview.inventorySha256 -ceq $afterRestorePreview.inventorySha256) 'restore WhatIf changed bytes or ACLs'
    Assert-SelfTest (-not (($restorePreviewOutput | Out-String).Contains($privateMarker)) -and
        -not (($restorePreviewOutput | Out-String).Contains($dataRoot))) 'restore WhatIf disclosed private material'

    $noConfirmationId = [guid]::NewGuid().ToString('D')
    Assert-SelfTestFailure { & $restoreScript @commonArgs -BundleId $bundleId -ExpectedManifestSha256 $created.manifestSha256 `
        -OperationId $noConfirmationId -Confirm:$false } 'DYSON_CONTROL_DATA_RECOVERY_CONFIRMATION_REQUIRED'
    Assert-SelfTest (-not (Test-DysonDataRootRecoveryPathExists (Join-Path (Join-Path $recoveryRoot 'protection-points') $noConfirmationId))) 'missing confirmation mutated recovery state'

    $stage = 'restore-success'
    $restoreId = [guid]::NewGuid().ToString('D')
    $restoreOutput = @(& $restoreScript @commonArgs -BundleId $bundleId -ExpectedManifestSha256 $created.manifestSha256 `
        -OperationId $restoreId -Confirmation RESTORE_DYSON_CONTROL_DATA_ROOT -Confirm:$false)
    $restored = Get-SelfTestJson $restoreOutput
    Assert-SelfTest (-not $restored.reused -and -not $restored.rolledBack -and
        [string]$restored.protectionManifestSha256 -match '^[0-9a-f]{64}$') 'successful restore result is invalid'
    $sourceBundle = Test-DysonDataRootRecoveryBundleCore $bundleRoot $created.manifestSha256 $created.dataRootIdentity recovery
    [void](Test-DysonDataRootRecoveryPayloadAgainstManifest $dataRoot $sourceBundle.manifest -VerifyAcl)
    foreach ($relative in $installerStatePaths) {
        Assert-SelfTest ([System.IO.File]::ReadAllText((Join-Path $dataRoot $relative)) -ceq ('installer-state-' + $privateMarker)) `
            'installer state was not restored from the verified bundle'
    }
    $protectionPath = Join-Path (Join-Path $recoveryRoot 'protection-points') $restoreId
    $protection = Test-DysonDataRootRecoveryBundleCore $protectionPath $restored.protectionManifestSha256 $created.dataRootIdentity protection-point
    Assert-SelfTest ($protection.manifest.inventorySha256 -ceq $beforeRestorePreview.inventorySha256) 'automatic protection point did not capture the overwritten tree'
    Assert-SelfTest (-not (($restoreOutput | Out-String).Contains($privateMarker))) 'restore output disclosed private content'

    $stage = 'restore-replay'
    $restoreReplay = Get-SelfTestJson @(& $restoreScript @commonArgs -BundleId $bundleId -ExpectedManifestSha256 $created.manifestSha256 `
        -OperationId $restoreId -Confirmation RESTORE_DYSON_CONTROL_DATA_ROOT -Confirm:$false)
    Assert-SelfTest ($restoreReplay.reused -and [string]$restoreReplay.protectionManifestSha256 -ceq [string]$restored.protectionManifestSha256) 'restore receipt replay was not idempotent'

    $stage = 'restore-failure-rollback'
    # A failure after the candidate became the visible DataRoot must restore the
    # exact prior directory, including its non-default file ACL.
    Write-SelfTestUtf8 $configPath 'pre-failure-byte-exact-state'
    Set-SelfTestPrivateFileAcl $configPath
    Write-SelfTestUtf8 (Join-Path $dataRoot 'data\rollback-sentinel.txt') 'rollback-sentinel'
    $beforeFailure = Get-DysonDataRootRecoveryTreeInventory $dataRoot
    $failureId = [guid]::NewGuid().ToString('D')
    $env:DYSON_DATA_ROOT_RECOVERY_SELFTEST_FAIL_POINT = 'AfterTargetPublished'
    Assert-SelfTestFailure { & $restoreScript @commonArgs -BundleId $bundleId -ExpectedManifestSha256 $created.manifestSha256 `
        -OperationId $failureId -Confirmation RESTORE_DYSON_CONTROL_DATA_ROOT -Confirm:$false } 'DYSON_CONTROL_DATA_RECOVERY_RESTORE_FAILED'
    $env:DYSON_DATA_ROOT_RECOVERY_SELFTEST_FAIL_POINT = $null
    $afterFailure = Get-DysonDataRootRecoveryTreeInventory $dataRoot
    Assert-SelfTest ($beforeFailure.inventorySha256 -ceq $afterFailure.inventorySha256 -and
        $beforeFailure.totalBytes -eq $afterFailure.totalBytes) 'failed restore did not roll back bytes and ACLs exactly'
    Assert-SelfTestFailure { & $restoreScript @commonArgs -BundleId $bundleId -ExpectedManifestSha256 $created.manifestSha256 `
        -OperationId $failureId -Confirmation RESTORE_DYSON_CONTROL_DATA_ROOT -Confirm:$false } 'DYSON_CONTROL_DATA_RECOVERY_RESTORE_FAILED'
    $afterFailedReplay = Get-DysonDataRootRecoveryTreeInventory $dataRoot
    Assert-SelfTest ($beforeFailure.inventorySha256 -ceq $afterFailedReplay.inventorySha256) 'failed operation receipt replay mutated DataRoot'

    $stage = 'terminal-receipt-reconciliation'
    $stateRoot = Join-Path (Join-Path $recoveryRoot 'state') $identityStem
    $terminalFaultPoints = @('AfterReceiptBeforeAudit', 'AfterReceiptBeforeIntentDelete')
    foreach ($terminalFaultPoint in $terminalFaultPoints) {
        # A unique preimage proves that a fault after the durable success receipt cannot
        # drive the restore catch path back to the superseded tree.
        Write-SelfTestUtf8 $configPath ('pre-terminal-fault-' + $terminalFaultPoint)
        Write-SelfTestUtf8 (Join-Path $dataRoot 'data\terminal-preimage.txt') $terminalFaultPoint
        $preTerminal = Get-DysonDataRootRecoveryTreeInventory $dataRoot
        $terminalId = [guid]::NewGuid().ToString('D')
        $childArguments = @(
            '-DataRoot', $dataRoot,
            '-RecoveryRoot', $recoveryRoot,
            '-BundleId', $bundleId,
            '-ExpectedManifestSha256', [string]$created.manifestSha256,
            '-OperationId', $terminalId,
            '-Confirmation', 'RESTORE_DYSON_CONTROL_DATA_ROOT',
            '-ControlTaskName', 'Dyson-Control-Plane',
            '-Backend', 'Shadow',
            '-ShadowRoot', $shadowRoot
        )
        try {
            $env:DYSON_DATA_ROOT_RECOVERY_SELFTEST_FAIL_POINT = $terminalFaultPoint
            $faultedChild = Invoke-SelfTestChildPowerShell -ScriptPath $restoreScript -Arguments $childArguments
        }
        finally { $env:DYSON_DATA_ROOT_RECOVERY_SELFTEST_FAIL_POINT = $null }
        Assert-SelfTest ($faultedChild.exitCode -ne 0 -and
            $faultedChild.text.Contains('DYSON_CONTROL_DATA_RECOVERY_RECOVERY_REQUIRED')) `
            ('terminal fault did not surface recovery-required: ' + $terminalFaultPoint)

        $terminalReceiptPath = Join-Path (Join-Path $stateRoot 'receipts') ($terminalId + '.json')
        $terminalIntentPath = Join-Path (Join-Path $stateRoot 'intents') ($terminalId + '.json')
        Assert-SelfTest ((Test-DysonDataRootRecoveryFileExists $terminalReceiptPath) -and
            (Test-DysonDataRootRecoveryFileExists $terminalIntentPath)) `
            ('terminal fault did not preserve receipt plus intent: ' + $terminalFaultPoint)
        $terminalReceipt = ConvertTo-DysonDataRootRecoveryValidatedReceipt `
            (Read-DysonDataRootRecoveryJson $terminalReceiptPath)
        Assert-SelfTest ([string]$terminalReceipt.outcome -ceq 'succeeded') `
            ('terminal fault receipt was not a success receipt: ' + $terminalFaultPoint)
        [void](Test-DysonDataRootRecoveryPayloadAgainstManifest $dataRoot $sourceBundle.manifest -VerifyAcl)
        $postTerminal = Get-DysonDataRootRecoveryTreeInventory $dataRoot
        Assert-SelfTest ($postTerminal.inventorySha256 -cne $preTerminal.inventorySha256) `
            ('terminal fault rolled back to its preimage: ' + $terminalFaultPoint)

        # A different operation cannot consume or bypass another operation's residual intent.
        $otherId = [guid]::NewGuid().ToString('D')
        Assert-SelfTestFailure { & $restoreScript @commonArgs -BundleId $bundleId `
            -ExpectedManifestSha256 $created.manifestSha256 -OperationId $otherId `
            -Confirmation RESTORE_DYSON_CONTROL_DATA_ROOT -Confirm:$false } `
            'DYSON_CONTROL_DATA_RECOVERY_RECOVERY_REQUIRED'

        # Clearing the injected fault and starting a fresh powershell.exe process exercises
        # restart replay.  It must reconcile audit/intent without republishing or rolling back.
        $replayedChild = Invoke-SelfTestChildPowerShell -ScriptPath $restoreScript -Arguments $childArguments
        Assert-SelfTest ($replayedChild.exitCode -eq 0) `
            ('terminal receipt restart replay failed: ' + $terminalFaultPoint)
        $replayedTerminal = Get-SelfTestJson $replayedChild.output
        Assert-SelfTest ($replayedTerminal.reused -and -not $replayedTerminal.rolledBack) `
            ('terminal receipt restart replay was not idempotent: ' + $terminalFaultPoint)
        Assert-SelfTest (-not (Test-DysonDataRootRecoveryPathExists $terminalIntentPath)) `
            ('terminal restart replay did not delete its matching intent: ' + $terminalFaultPoint)
        Assert-SelfTest (-not (Test-DysonDataRootRecoveryPathExists `
            (Join-Path (Split-Path -Parent $dataRoot) ('.dyson-data-superseded-' + $terminalId)))) `
            ('terminal restart replay left a superseded tree: ' + $terminalFaultPoint)
        $operationAudit = @([System.IO.File]::ReadLines(
            (ConvertTo-DysonDataRootRecoveryExtendedPath (Join-Path $stateRoot 'audit.jsonl')),
            [System.Text.UTF8Encoding]::new($false, $true)
        ) |
            ForEach-Object { $_ | ConvertFrom-Json } |
            Where-Object { [string]$_.operationId -ceq $terminalId })
        Assert-SelfTest ($operationAudit.Count -eq 1 -and
            [string]$operationAudit[0].requestFingerprint -ceq [string]$terminalReceipt.requestFingerprint) `
            ('terminal restart replay did not reconcile exactly one matching audit record: ' + $terminalFaultPoint)
        [void](Test-DysonDataRootRecoveryPayloadAgainstManifest $dataRoot $sourceBundle.manifest -VerifyAcl)
    }

    $stage = 'final-restore'
    $finalRestoreId = [guid]::NewGuid().ToString('D')
    [void](& $restoreScript @commonArgs -BundleId $bundleId -ExpectedManifestSha256 $created.manifestSha256 `
        -OperationId $finalRestoreId -Confirmation RESTORE_DYSON_CONTROL_DATA_ROOT -Confirm:$false)
    [void](Test-DysonDataRootRecoveryPayloadAgainstManifest $dataRoot $sourceBundle.manifest -VerifyAcl)

    $auditPath = Join-Path (Join-Path (Join-Path $recoveryRoot 'state') $identityStem) 'audit.jsonl'
    $auditRecords = @([System.IO.File]::ReadLines(
        (ConvertTo-DysonDataRootRecoveryExtendedPath $auditPath),
        [System.Text.UTF8Encoding]::new($false, $true)
    ) | ForEach-Object { $_ | ConvertFrom-Json })
    Assert-SelfTest ($auditRecords.Count -ge 4 -and @($auditRecords | Where-Object outcome -ceq 'failed').Count -ge 1) 'durable audit is incomplete'
    $publicText = (@($previewOutput) + @($createOutput) + @($testOutput) + @($restorePreviewOutput) + @($restoreOutput) | Out-String)
    Assert-SelfTest (-not $publicText.Contains($privateMarker)) 'public result streams contain the private marker'

    $stage = 'result'
    [pscustomobject][ordered]@{
        protocol = 'DYSON_CONTROL_DATA_ROOT_RECOVERY_SELFTEST_V1'
        schemaVersion = 1
        status = 'passed'
        shadowOnly = $true
        productionMutation = $false
        securityModuleBound = $true
        whatIfZeroMutation = $true
        largeFileBytes = 33554432
        extendedLengthPath = $longPath.Length
        atomicIntentPartialLength = $intentAtomicPartialLength
        extendedLengthIoVerified = $true
        sqliteSidecarRejected = $true
        sqliteWalRejected = $true
        sqliteShmRejected = $true
        savePairEnforced = $true
        reparseRejected = $true
        pendingMutationRejected = $true
        taskQuiescenceEnforced = $true
        bundleTamperRejected = $true
        missingAndExtraRejected = $true
        explicitConfirmationEnforced = $true
        protectionPointVerified = $true
        byteAclRollbackExact = $true
        legacyInheritancePreserved = $true
        idempotentReceipts = $true
        terminalReceiptNeverRolledBack = $true
        terminalRestartReplayReconciled = $true
        mismatchedResidualIntentRejected = $true
        terminalAuditExactlyOnce = $true
        secretFreeOutput = $true
    } | ConvertTo-Json -Depth 8 -Compress
}
catch {
    $code = Get-DysonDataRootRecoveryErrorCode $_.Exception
    throw ('data recovery self-test stage ' + $stage + ' failed: ' + $code + '; ' + $_.Exception.Message)
}
finally {
    $env:DYSON_DATA_ROOT_RECOVERY_SELFTEST_FAIL_POINT = $null
    $env:DYSON_DATA_ROOT_RECOVERY_SELFTEST = $null
    if ($env:DYSON_DATA_ROOT_RECOVERY_SELFTEST_KEEP -cne '1' -and
        (Test-DysonDataRootRecoveryDirectoryExists $fixtureRoot)) {
        Remove-DysonDataRootRecoveryKnownTree $fixtureRoot `
            (Get-DysonDataRootRecoveryParentPath $fixtureRoot) `
            '.dyson-data-root-recovery-selftest-'
    }
}
