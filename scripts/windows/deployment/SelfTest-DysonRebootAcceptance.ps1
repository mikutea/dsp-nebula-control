[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$commonPath = Join-Path $PSScriptRoot 'DysonRebootAcceptance.Common.ps1'
$commonItem = Get-Item -LiteralPath $commonPath -Force -ErrorAction Stop
if ($commonItem.PSIsContainer -or
    ($commonItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint)) {
    throw 'The fixed reboot-acceptance helper is unavailable or redirected.'
}
. $commonItem.FullName

function Assert-RebootAcceptanceFixture {
    param(
        [Parameter(Mandatory)][bool]$Condition,
        [Parameter(Mandatory)][string]$Message
    )
    if (-not $Condition) { throw "REBOOT_ACCEPTANCE_SELFTEST_FAILED: $Message" }
}

function New-FixtureIdentity {
    param([Parameter(Mandatory)][ValidatePattern('^[0-9a-f]$')][string]$Character)
    return 'sha256:' + [string]::new([char]$Character, 64)
}

function New-RebootAcceptanceFixtureContext {
    param(
        [Parameter(Mandatory)][string]$HostIdentity,
        [Parameter(Mandatory)][string]$BootIdentity,
        [Parameter(Mandatory)][string]$BootStartedAt,
        [Parameter(Mandatory)][string]$Now,
        [Parameter(Mandatory)][string]$ControlVersion,
        [Parameter(Mandatory)][string]$ControlPayloadSha256,
        [Parameter(Mandatory)][string]$ActivePointerSha256,
        [Parameter(Mandatory)][string]$ControlTaskIdentity,
        [Parameter(Mandatory)][string]$ProjectRootIdentity,
        [Parameter(Mandatory)][string]$AccountIdentity,
        [Parameter(Mandatory)][string]$CheckpointId,
        [Parameter(Mandatory)][hashtable]$AclState,
        [string]$ControlTaskLastRunAt,
        [string]$GameTaskLastRunAt
    )

    $controlRunAt = if ([string]::IsNullOrWhiteSpace($ControlTaskLastRunAt)) { $Now } else { $ControlTaskLastRunAt }
    $gameRunAt = if ([string]::IsNullOrWhiteSpace($GameTaskLastRunAt)) { $Now } else { $GameTaskLastRunAt }
    return [pscustomobject]@{
        Mode = 'fixture'
        GetHostIdentity = { $HostIdentity }.GetNewClosure()
        GetBootObservation = {
            param([string]$ObservedHostIdentity)
            if ([string]$ObservedHostIdentity -cne $HostIdentity) { throw 'Fixture host binding changed.' }
            [pscustomobject][ordered]@{ identity = $BootIdentity; startedAt = $BootStartedAt }
        }.GetNewClosure()
        GetControlObservation = {
            param([string]$TaskName)
            if ([string]::IsNullOrWhiteSpace($TaskName)) { throw 'Fixture task name missing.' }
            [pscustomobject][ordered]@{
                ready = $true
                version = $ControlVersion
                payloadSha256 = $ControlPayloadSha256
                activePointerSha256 = $ActivePointerSha256
                taskIdentity = $ControlTaskIdentity
                taskState = 'Running'
                taskLastRunAt = $controlRunAt
            }
        }.GetNewClosure()
        GetGameObservation = {
            param([int]$GamePort)
            if ($GamePort -ne 8469) { throw 'Fixture game-port binding changed.' }
            [pscustomobject][ordered]@{
                ready = $true
                projectRootIdentity = $ProjectRootIdentity
                accountIdentity = $AccountIdentity
                taskState = 'Running'
                taskLastRunAt = $gameRunAt
            }
        }.GetNewClosure()
        ApplyAcl = {
            param([string]$Path, [bool]$Directory)
            $AclState[[System.IO.Path]::GetFullPath($Path)] = $Directory
        }.GetNewClosure()
        ValidateAcl = {
            param([string]$Path)
            $AclState.ContainsKey([System.IO.Path]::GetFullPath($Path))
        }.GetNewClosure()
        Now = { $Now }.GetNewClosure()
        NewId = { $CheckpointId }.GetNewClosure()
    }
}

function Test-RebootAcceptanceRejected {
    param(
        [Parameter(Mandatory)][scriptblock]$Operation,
        [Parameter(Mandatory)][string]$ExpectedMessage
    )
    try { & $Operation; return $false }
    catch { return [string]$_.Exception.Message -eq $ExpectedMessage }
}

$temporaryBase = [System.IO.Path]::GetFullPath([System.IO.Path]::GetTempPath()).TrimEnd('\', '/')
$testRoot = Join-Path $temporaryBase ('dyson-reboot-acceptance-selftest-' + [guid]::NewGuid().ToString('N'))
$dataRoot = Join-Path $testRoot 'program-data\DysonControl'
$checkpointId = '11111111-2222-4333-8444-555555555555'
$hostA = New-FixtureIdentity -Character 'a'
$hostB = New-FixtureIdentity -Character 'b'
$bootA = New-FixtureIdentity -Character 'c'
$bootB = New-FixtureIdentity -Character 'd'
$payloadA = [string]::new([char]'1', 64)
$pointerA = [string]::new([char]'2', 64)
$taskA = New-FixtureIdentity -Character '3'
$projectA = New-FixtureIdentity -Character '4'
$accountA = New-FixtureIdentity -Character '5'
$aclState = @{}

try {
    [System.IO.Directory]::CreateDirectory($dataRoot) | Out-Null
    $baseline = New-RebootAcceptanceFixtureContext `
        -HostIdentity $hostA -BootIdentity $bootA `
        -BootStartedAt '2026-09-01T00:00:00.0000000+00:00' `
        -Now '2026-09-01T00:10:00.0000000+00:00' `
        -ControlVersion '1.0.0' -ControlPayloadSha256 $payloadA `
        -ActivePointerSha256 $pointerA -ControlTaskIdentity $taskA `
        -ProjectRootIdentity $projectA -AccountIdentity $accountA `
        -CheckpointId $checkpointId -AclState $aclState

    $preview = Invoke-DysonCreateRebootAcceptanceCheckpoint -DataRoot $dataRoot `
        -Context $baseline -TaskName 'Dyson-Control-Plane' -GamePort 8469 `
        -ValidityHours 24 -Apply $false
    Assert-RebootAcceptanceFixture -Condition ($preview.state -eq 'preview' -and
        -not [bool]$preview.realRebootObserved -and -not [bool]$preview.qualifyingProductionEvidence) `
        -Message 'the preview receipt overstated reboot or production evidence'
    Assert-RebootAcceptanceFixture -Condition (-not (Test-Path -LiteralPath (Join-Path $dataRoot 'acceptance'))) `
        -Message 'the checkpoint preview changed the temporary data root'

    $created = Invoke-DysonCreateRebootAcceptanceCheckpoint -DataRoot $dataRoot `
        -Context $baseline -TaskName 'Dyson-Control-Plane' -GamePort 8469 `
        -ValidityHours 24 -Apply $true
    Assert-RebootAcceptanceFixture -Condition ($created.state -eq 'checkpoint-created' -and
        [string]$created.checkpointId -ceq $checkpointId -and -not [bool]$created.rebootPerformed) `
        -Message 'the pre-reboot checkpoint was not created with bounded semantics'
    $checkpointPath = Get-DysonRebootAcceptanceCheckpointPath -DataRoot $dataRoot -CheckpointId $checkpointId
    $checkpointBeforeCollision = [System.IO.File]::ReadAllText($checkpointPath, [System.Text.Encoding]::UTF8)
    $checkpoint = Read-DysonRebootAcceptanceCheckpoint -DataRoot $dataRoot `
        -CheckpointId $checkpointId -Context $baseline
    Assert-RebootAcceptanceFixture -Condition ([string]$checkpoint.controlVersion -ceq '1.0.0' -and
        [string]$checkpoint.checkpointSha256 -cmatch '^[0-9a-f]{64}$') `
        -Message 'the immutable checkpoint did not round-trip through strict validation'
    Assert-RebootAcceptanceFixture -Condition ($aclState.Count -ge 2) `
        -Message 'the checkpoint directory and file ACL hooks were not applied'

    $collisionRejected = $false
    try {
        [void](Invoke-DysonCreateRebootAcceptanceCheckpoint -DataRoot $dataRoot `
            -Context $baseline -TaskName 'Dyson-Control-Plane' -GamePort 8469 `
            -ValidityHours 24 -Apply $true)
    }
    catch { $collisionRejected = $true }
    Assert-RebootAcceptanceFixture -Condition ($collisionRejected -and
        (Test-Path -LiteralPath $checkpointPath -PathType Leaf) -and
        [System.IO.File]::ReadAllText($checkpointPath, [System.Text.Encoding]::UTF8) -ceq $checkpointBeforeCollision) `
        -Message 'an ID collision overwrote or removed an immutable checkpoint'

    $replacementCheckpointId = '22222222-3333-4444-8555-666666666666'
    $replacementContext = New-RebootAcceptanceFixtureContext `
        -HostIdentity $hostA -BootIdentity $bootA `
        -BootStartedAt '2026-09-01T00:00:00.0000000+00:00' `
        -Now '2026-09-01T00:11:00.0000000+00:00' `
        -ControlVersion '1.0.0' -ControlPayloadSha256 $payloadA `
        -ActivePointerSha256 $pointerA -ControlTaskIdentity $taskA `
        -ProjectRootIdentity $projectA -AccountIdentity $accountA `
        -CheckpointId $replacementCheckpointId -AclState $aclState
    $normalApplyAcl = $replacementContext.ApplyAcl
    $replacementText = 'FICTIONAL_CONCURRENT_REPLACEMENT'
    $replacementContext.ApplyAcl = {
        param([string]$Path, [bool]$Directory)
        if ($Directory) {
            & $normalApplyAcl $Path $Directory
            return
        }
        [System.IO.File]::Delete($Path)
        [System.IO.File]::WriteAllText($Path, $replacementText, [System.Text.UTF8Encoding]::new($false))
        throw 'fictional ACL failure after pathname replacement'
    }.GetNewClosure()
    $replacementFailurePreserved = $false
    try {
        [void](Invoke-DysonCreateRebootAcceptanceCheckpoint -DataRoot $dataRoot `
            -Context $replacementContext -TaskName 'Dyson-Control-Plane' -GamePort 8469 `
            -ValidityHours 24 -Apply $true)
    }
    catch {
        $replacementPath = Get-DysonRebootAcceptanceCheckpointPath -DataRoot $dataRoot `
            -CheckpointId $replacementCheckpointId
        $replacementFailurePreserved = (Test-Path -LiteralPath $replacementPath -PathType Leaf) -and
            [System.IO.File]::ReadAllText($replacementPath, [System.Text.Encoding]::UTF8) -ceq $replacementText
    }
    Assert-RebootAcceptanceFixture -Condition $replacementFailurePreserved `
        -Message 'a write-verification failure deleted a same-path replacement'

    $sameBoot = New-RebootAcceptanceFixtureContext `
        -HostIdentity $hostA -BootIdentity $bootA `
        -BootStartedAt '2026-09-01T00:00:00.0000000+00:00' `
        -Now '2026-09-01T00:20:00.0000000+00:00' `
        -ControlVersion '1.0.0' -ControlPayloadSha256 $payloadA `
        -ActivePointerSha256 $pointerA -ControlTaskIdentity $taskA `
        -ProjectRootIdentity $projectA -AccountIdentity $accountA `
        -CheckpointId ([guid]::NewGuid().ToString('D')) -AclState $aclState
    Assert-RebootAcceptanceFixture -Condition (Test-RebootAcceptanceRejected -ExpectedMessage 'DYSON_REBOOT_NOT_OBSERVED' -Operation {
        [void](Invoke-DysonTestRebootAcceptanceResume -DataRoot $dataRoot `
            -CheckpointId $checkpointId -Context $sameBoot)
    }) -Message 'the same Windows boot was accepted as a reboot'

    $staleControlTask = New-RebootAcceptanceFixtureContext `
        -HostIdentity $hostA -BootIdentity $bootB `
        -BootStartedAt '2026-09-01T00:20:00.0000000+00:00' `
        -Now '2026-09-01T00:30:00.0000000+00:00' `
        -ControlVersion '1.0.0' -ControlPayloadSha256 $payloadA `
        -ActivePointerSha256 $pointerA -ControlTaskIdentity $taskA `
        -ProjectRootIdentity $projectA -AccountIdentity $accountA `
        -CheckpointId ([guid]::NewGuid().ToString('D')) -AclState $aclState `
        -ControlTaskLastRunAt '2026-09-01T00:09:00.0000000+00:00'
    Assert-RebootAcceptanceFixture -Condition (Test-RebootAcceptanceRejected `
        -ExpectedMessage 'DYSON_REBOOT_ACCEPTANCE_CONTROL_TASK_RUN_INVALID' -Operation {
            [void](Invoke-DysonTestRebootAcceptanceResume -DataRoot $dataRoot `
                -CheckpointId $checkpointId -Context $staleControlTask)
        }) -Message 'a control task that did not run in the new boot was accepted'

    $staleGameTask = New-RebootAcceptanceFixtureContext `
        -HostIdentity $hostA -BootIdentity $bootB `
        -BootStartedAt '2026-09-01T00:20:00.0000000+00:00' `
        -Now '2026-09-01T00:30:00.0000000+00:00' `
        -ControlVersion '1.0.0' -ControlPayloadSha256 $payloadA `
        -ActivePointerSha256 $pointerA -ControlTaskIdentity $taskA `
        -ProjectRootIdentity $projectA -AccountIdentity $accountA `
        -CheckpointId ([guid]::NewGuid().ToString('D')) -AclState $aclState `
        -GameTaskLastRunAt '2026-09-01T00:09:00.0000000+00:00'
    Assert-RebootAcceptanceFixture -Condition (Test-RebootAcceptanceRejected `
        -ExpectedMessage 'DYSON_REBOOT_ACCEPTANCE_GAME_TASK_RUN_INVALID' -Operation {
            [void](Invoke-DysonTestRebootAcceptanceResume -DataRoot $dataRoot `
                -CheckpointId $checkpointId -Context $staleGameTask)
        }) -Message 'a game task that did not run in the new boot was accepted'

    $changedHost = New-RebootAcceptanceFixtureContext `
        -HostIdentity $hostB -BootIdentity $bootB `
        -BootStartedAt '2026-09-01T00:20:00.0000000+00:00' `
        -Now '2026-09-01T00:30:00.0000000+00:00' `
        -ControlVersion '1.0.0' -ControlPayloadSha256 $payloadA `
        -ActivePointerSha256 $pointerA -ControlTaskIdentity $taskA `
        -ProjectRootIdentity $projectA -AccountIdentity $accountA `
        -CheckpointId ([guid]::NewGuid().ToString('D')) -AclState $aclState
    Assert-RebootAcceptanceFixture -Condition (Test-RebootAcceptanceRejected -ExpectedMessage 'DYSON_REBOOT_ACCEPTANCE_HOST_CHANGED' -Operation {
        [void](Invoke-DysonTestRebootAcceptanceResume -DataRoot $dataRoot `
            -CheckpointId $checkpointId -Context $changedHost)
    }) -Message 'a checkpoint was resumed on a different host identity'

    $controlDrift = New-RebootAcceptanceFixtureContext `
        -HostIdentity $hostA -BootIdentity $bootB `
        -BootStartedAt '2026-09-01T00:20:00.0000000+00:00' `
        -Now '2026-09-01T00:30:00.0000000+00:00' `
        -ControlVersion '1.0.1' -ControlPayloadSha256 ([string]::new([char]'6', 64)) `
        -ActivePointerSha256 $pointerA -ControlTaskIdentity $taskA `
        -ProjectRootIdentity $projectA -AccountIdentity $accountA `
        -CheckpointId ([guid]::NewGuid().ToString('D')) -AclState $aclState
    Assert-RebootAcceptanceFixture -Condition (Test-RebootAcceptanceRejected -ExpectedMessage 'DYSON_REBOOT_ACCEPTANCE_CONTROL_DRIFT' -Operation {
        [void](Invoke-DysonTestRebootAcceptanceResume -DataRoot $dataRoot `
            -CheckpointId $checkpointId -Context $controlDrift)
    }) -Message 'control-plane version or payload drift was accepted after reboot'

    $gameDrift = New-RebootAcceptanceFixtureContext `
        -HostIdentity $hostA -BootIdentity $bootB `
        -BootStartedAt '2026-09-01T00:20:00.0000000+00:00' `
        -Now '2026-09-01T00:30:00.0000000+00:00' `
        -ControlVersion '1.0.0' -ControlPayloadSha256 $payloadA `
        -ActivePointerSha256 $pointerA -ControlTaskIdentity $taskA `
        -ProjectRootIdentity (New-FixtureIdentity -Character '7') -AccountIdentity $accountA `
        -CheckpointId ([guid]::NewGuid().ToString('D')) -AclState $aclState
    Assert-RebootAcceptanceFixture -Condition (Test-RebootAcceptanceRejected -ExpectedMessage 'DYSON_REBOOT_ACCEPTANCE_GAME_DRIFT' -Operation {
        [void](Invoke-DysonTestRebootAcceptanceResume -DataRoot $dataRoot `
            -CheckpointId $checkpointId -Context $gameDrift)
    }) -Message 'game project/account drift was accepted after reboot'

    $expired = New-RebootAcceptanceFixtureContext `
        -HostIdentity $hostA -BootIdentity $bootB `
        -BootStartedAt '2026-09-01T00:20:00.0000000+00:00' `
        -Now '2026-09-02T01:00:00.0000000+00:00' `
        -ControlVersion '1.0.0' -ControlPayloadSha256 $payloadA `
        -ActivePointerSha256 $pointerA -ControlTaskIdentity $taskA `
        -ProjectRootIdentity $projectA -AccountIdentity $accountA `
        -CheckpointId ([guid]::NewGuid().ToString('D')) -AclState $aclState
    Assert-RebootAcceptanceFixture -Condition (Test-RebootAcceptanceRejected -ExpectedMessage 'DYSON_REBOOT_ACCEPTANCE_CHECKPOINT_EXPIRED' -Operation {
        [void](Invoke-DysonTestRebootAcceptanceResume -DataRoot $dataRoot `
            -CheckpointId $checkpointId -Context $expired)
    }) -Message 'an expired reboot checkpoint was accepted'

    $resumedContext = New-RebootAcceptanceFixtureContext `
        -HostIdentity $hostA -BootIdentity $bootB `
        -BootStartedAt '2026-09-01T00:20:00.0000000+00:00' `
        -Now '2026-09-01T00:30:00.0000000+00:00' `
        -ControlVersion '1.0.0' -ControlPayloadSha256 $payloadA `
        -ActivePointerSha256 $pointerA -ControlTaskIdentity $taskA `
        -ProjectRootIdentity $projectA -AccountIdentity $accountA `
        -CheckpointId ([guid]::NewGuid().ToString('D')) -AclState $aclState
    $resumed = Invoke-DysonTestRebootAcceptanceResume -DataRoot $dataRoot `
        -CheckpointId $checkpointId -Context $resumedContext
    Assert-RebootAcceptanceFixture -Condition ($resumed.state -eq 'fixture-resume-validated' -and
        [bool]$resumed.fixtureBootTransitionValidated -and -not [bool]$resumed.realRebootObserved -and
        [bool]$resumed.controlTaskExecutionInNewBootValidated -and
        [bool]$resumed.gameTaskExecutionInNewBootValidated -and
        -not [bool]$resumed.automaticTaskTriggerProven -and
        -not [bool]$resumed.unattendedStartupValidated -and
        -not [bool]$resumed.qualifyingProductionEvidence -and [bool]$resumed.requiresPrivateEvidenceBundle) `
        -Message 'the fixture resume result impersonated real reboot or production evidence'

    $tampered = $checkpointBeforeCollision | ConvertFrom-Json
    $tampered.controlVersion = '9.9.9'
    [System.IO.File]::WriteAllText(
        $checkpointPath,
        ($tampered | ConvertTo-Json -Depth 7 -Compress),
        [System.Text.UTF8Encoding]::new($false)
    )
    $tamperRejected = $false
    try {
        [void](Read-DysonRebootAcceptanceCheckpoint -DataRoot $dataRoot `
            -CheckpointId $checkpointId -Context $baseline)
    }
    catch { $tamperRejected = $true }
    Assert-RebootAcceptanceFixture -Condition $tamperRejected `
        -Message 'checkpoint content tampering was accepted'
    [System.IO.File]::WriteAllText($checkpointPath, $checkpointBeforeCollision, [System.Text.UTF8Encoding]::new($false))

    $redirectedIdRejected = $false
    try {
        [void](Get-DysonRebootAcceptanceCheckpointPath -DataRoot $dataRoot `
            -CheckpointId '..\fictional')
    }
    catch { $redirectedIdRejected = $true }
    Assert-RebootAcceptanceFixture -Condition $redirectedIdRejected `
        -Message 'a traversal-like checkpoint ID was accepted'

    $publicScripts = @(
        'DysonRebootAcceptance.Common.ps1',
        'New-DysonRebootAcceptanceCheckpoint.ps1',
        'Test-DysonRebootAcceptanceResume.ps1'
    )
    $publicSource = ($publicScripts | ForEach-Object {
        Get-Content -LiteralPath (Join-Path $PSScriptRoot $_) -Raw
    }) -join [Environment]::NewLine
    foreach ($forbidden in @(
        ('Restart' + '-Computer'), ('Stop' + '-Computer'), ('shutdown' + '.exe'),
        ('Register' + '-ScheduledTask'), ('Start' + '-ScheduledTask'), ('Stop' + '-ScheduledTask')
    )) {
        Assert-RebootAcceptanceFixture -Condition (-not $publicSource.Contains($forbidden)) `
            -Message "a reboot or Task Scheduler mutation appeared in a public acceptance script: $forbidden"
    }
    $parameterContracts = [ordered]@{
        'New-DysonRebootAcceptanceCheckpoint.ps1' = @(
            'InstallRoot', 'DataRoot', 'ReadinessUri', 'TaskName', 'GamePort', 'ValidityHours'
        )
        'Test-DysonRebootAcceptanceResume.ps1' = @(
            'InstallRoot', 'DataRoot', 'CheckpointId', 'ReadinessUri'
        )
    }
    foreach ($contract in $parameterContracts.GetEnumerator()) {
        $tokens = $null
        $errors = $null
        $ast = [System.Management.Automation.Language.Parser]::ParseFile(
            (Join-Path $PSScriptRoot $contract.Key),
            [ref]$tokens,
            [ref]$errors
        )
        Assert-RebootAcceptanceFixture -Condition ($errors.Count -eq 0) `
            -Message "a public reboot-acceptance script did not parse: $($contract.Key)"
        $actual = @($ast.ParamBlock.Parameters | ForEach-Object { [string]$_.Name.VariablePath.UserPath })
        $expected = @($contract.Value)
        Assert-RebootAcceptanceFixture -Condition ($actual.Count -eq $expected.Count -and
            @($expected | Where-Object { $_ -notin $actual }).Count -eq 0) `
            -Message "a public reboot-acceptance script exposed a fixture/injection parameter: $($contract.Key)"
    }

    [ordered]@{
        protocol = 'DYSON_CONTROL_REBOOT_ACCEPTANCE_SELFTEST_V1'
        state = 'passed'
        fictionalTemporaryRootOnly = $true
        previewWasNonMutating = $true
        immutableCheckpointValidated = $true
        checkpointCollisionPreservedOriginal = $true
        writeFailureReplacementPreserved = $true
        sameBootRejected = $true
        staleControlTaskRunRejected = $true
        staleGameTaskRunRejected = $true
        differentHostRejected = $true
        expiredCheckpointRejected = $true
        controlDriftRejected = $true
        gameDriftRejected = $true
        checkpointTamperRejected = $true
        traversalIdRejected = $true
        fixtureResumeValidated = $true
        realRebootObserved = $false
        nativeTaskSchedulerValidated = $false
        productionChanged = $false
        productionEvidenceCreated = $false
        realHostValidationRequired = $true
    } | ConvertTo-Json -Depth 6 -Compress
}
finally {
    $testFull = [System.IO.Path]::GetFullPath($testRoot).TrimEnd('\', '/')
    $expectedPrefix = $temporaryBase + [System.IO.Path]::DirectorySeparatorChar + 'dyson-reboot-acceptance-selftest-'
    if ($testFull.StartsWith($expectedPrefix, [System.StringComparison]::OrdinalIgnoreCase) -and
        (Test-Path -LiteralPath $testFull)) {
        Remove-Item -LiteralPath $testFull -Recurse -Force
    }
}
