Set-StrictMode -Version 2.0

. (Join-Path $PSScriptRoot 'DysonDeployment.Common.ps1')
. (Join-Path $PSScriptRoot '..\DysonHostMutationLease.Common.ps1')
. (Join-Path $PSScriptRoot '..\session\DysonSession.Common.ps1')

$script:DysonRebootAcceptanceProtocol = 'DYSON_CONTROL_REBOOT_ACCEPTANCE_V1'
$script:DysonRebootAcceptanceSchemaVersion = 1
$script:DysonRebootAcceptanceCheckpointState = 'awaiting-reboot'
$script:DysonRebootAcceptanceCheckpointDirectory = 'acceptance\reboot-checkpoints'

function Assert-DysonRebootAcceptanceExactProperties {
    param(
        [Parameter(Mandatory)]$Value,
        [Parameter(Mandatory)][string[]]$Expected,
        [Parameter(Mandatory)][string]$Name
    )

    $actual = if ($Value -is [System.Collections.IDictionary]) {
        [string[]]@($Value.Keys | ForEach-Object { [string]$_ })
    }
    else {
        [string[]]@($Value.PSObject.Properties | ForEach-Object { [string]$_.Name })
    }
    [System.Array]::Sort($actual, [System.StringComparer]::Ordinal)
    $expectedSorted = [string[]]@($Expected)
    [System.Array]::Sort($expectedSorted, [System.StringComparer]::Ordinal)
    if (-not [string]::Equals(
        [string]::Join("`n", $actual),
        [string]::Join("`n", $expectedSorted),
        [System.StringComparison]::Ordinal
    )) {
        throw "$Name contains missing or unknown fields."
    }
}

function Assert-DysonRebootAcceptanceCheckpointId {
    param([Parameter(Mandatory)][string]$CheckpointId)

    $parsed = [guid]::Empty
    if (-not [guid]::TryParseExact($CheckpointId, 'D', [ref]$parsed) -or
        -not [string]::Equals($CheckpointId, $parsed.ToString('D'), [System.StringComparison]::Ordinal)) {
        throw 'The reboot-acceptance checkpoint ID is invalid.'
    }
    return $CheckpointId
}

function ConvertTo-DysonRebootAcceptanceTimestamp {
    param(
        [Parameter(Mandatory)][string]$Value,
        [Parameter(Mandatory)][string]$Name
    )

    $parsed = [datetimeoffset]::MinValue
    if (-not [datetimeoffset]::TryParseExact(
        $Value,
        'o',
        [System.Globalization.CultureInfo]::InvariantCulture,
        [System.Globalization.DateTimeStyles]::RoundtripKind,
        [ref]$parsed
    )) {
        throw "$Name is invalid."
    }
    $canonical = $parsed.ToUniversalTime().ToString('o', [System.Globalization.CultureInfo]::InvariantCulture)
    if (-not [string]::Equals($Value, $canonical, [System.StringComparison]::Ordinal)) {
        throw "$Name is not canonical UTC."
    }
    return $parsed.ToUniversalTime()
}

function Assert-DysonRebootAcceptanceHash {
    param(
        [Parameter(Mandatory)][string]$Value,
        [Parameter(Mandatory)][string]$Name
    )
    if ($Value -cnotmatch '^[0-9a-f]{64}$') { throw "$Name is invalid." }
}

function Assert-DysonRebootAcceptanceIdentity {
    param(
        [Parameter(Mandatory)][string]$Value,
        [Parameter(Mandatory)][string]$Name
    )
    if ($Value -cnotmatch '^sha256:[0-9a-f]{64}$') { throw "$Name is invalid." }
}

function Get-DysonRebootAcceptanceCheckpointBody {
    param([Parameter(Mandatory)]$Record)

    return [ordered]@{
        protocol = [string]$Record.protocol
        schemaVersion = [int]$Record.schemaVersion
        state = [string]$Record.state
        checkpointId = [string]$Record.checkpointId
        createdAt = [string]$Record.createdAt
        expiresAt = [string]$Record.expiresAt
        hostIdentity = [string]$Record.hostIdentity
        bootIdentityBefore = [string]$Record.bootIdentityBefore
        bootStartedAtBefore = [string]$Record.bootStartedAtBefore
        controlTaskName = [string]$Record.controlTaskName
        controlVersion = [string]$Record.controlVersion
        controlPayloadSha256 = [string]$Record.controlPayloadSha256
        activePointerSha256 = [string]$Record.activePointerSha256
        controlTaskIdentity = [string]$Record.controlTaskIdentity
        controlTaskLastRunAtBefore = [string]$Record.controlTaskLastRunAtBefore
        gamePort = [int]$Record.gamePort
        projectRootIdentity = [string]$Record.projectRootIdentity
        accountIdentity = [string]$Record.accountIdentity
        gameTaskLastRunAtBefore = [string]$Record.gameTaskLastRunAtBefore
    }
}

function Get-DysonRebootAcceptanceCheckpointDigest {
    param([Parameter(Mandatory)]$Record)

    $body = Get-DysonRebootAcceptanceCheckpointBody -Record $Record
    $canonical = $body | ConvertTo-Json -Depth 6 -Compress
    return Get-DysonTextSha256 -Value $canonical
}

function ConvertTo-DysonRebootAcceptanceCheckpointText {
    param([Parameter(Mandatory)]$Record)

    $body = Get-DysonRebootAcceptanceCheckpointBody -Record $Record
    $complete = [ordered]@{}
    foreach ($entry in $body.GetEnumerator()) { $complete[$entry.Key] = $entry.Value }
    $complete['checkpointSha256'] = [string]$Record.checkpointSha256
    return $complete | ConvertTo-Json -Depth 6 -Compress
}

function Assert-DysonRebootAcceptanceCheckpoint {
    param([Parameter(Mandatory)]$Record)

    Assert-DysonRebootAcceptanceExactProperties -Value $Record -Name 'Reboot-acceptance checkpoint' -Expected @(
        'protocol', 'schemaVersion', 'state', 'checkpointId', 'createdAt', 'expiresAt',
        'hostIdentity', 'bootIdentityBefore', 'bootStartedAtBefore', 'controlTaskName',
        'controlVersion', 'controlPayloadSha256', 'activePointerSha256', 'controlTaskIdentity',
        'controlTaskLastRunAtBefore', 'gamePort', 'projectRootIdentity', 'accountIdentity',
        'gameTaskLastRunAtBefore', 'checkpointSha256'
    )
    if ([string]$Record.protocol -cne $script:DysonRebootAcceptanceProtocol -or
        [int]$Record.schemaVersion -ne $script:DysonRebootAcceptanceSchemaVersion -or
        [string]$Record.state -cne $script:DysonRebootAcceptanceCheckpointState) {
        throw 'The reboot-acceptance checkpoint protocol, version, or state is unsupported.'
    }
    [void](Assert-DysonRebootAcceptanceCheckpointId -CheckpointId ([string]$Record.checkpointId))
    $createdAt = ConvertTo-DysonRebootAcceptanceTimestamp -Value ([string]$Record.createdAt) -Name 'Checkpoint createdAt'
    $expiresAt = ConvertTo-DysonRebootAcceptanceTimestamp -Value ([string]$Record.expiresAt) -Name 'Checkpoint expiresAt'
    $bootStartedAtBefore = ConvertTo-DysonRebootAcceptanceTimestamp `
        -Value ([string]$Record.bootStartedAtBefore) -Name 'Checkpoint bootStartedAtBefore'
    $controlTaskLastRunAtBefore = ConvertTo-DysonRebootAcceptanceTimestamp `
        -Value ([string]$Record.controlTaskLastRunAtBefore) -Name 'Checkpoint control task last run'
    $gameTaskLastRunAtBefore = ConvertTo-DysonRebootAcceptanceTimestamp `
        -Value ([string]$Record.gameTaskLastRunAtBefore) -Name 'Checkpoint game task last run'
    if ($expiresAt -le $createdAt -or $createdAt -lt $bootStartedAtBefore) {
        throw 'The reboot-acceptance checkpoint time window is invalid.'
    }
    if ($controlTaskLastRunAtBefore -lt $bootStartedAtBefore -or
        $controlTaskLastRunAtBefore -gt $createdAt -or
        $gameTaskLastRunAtBefore -lt $bootStartedAtBefore -or
        $gameTaskLastRunAtBefore -gt $createdAt) {
        throw 'The reboot-acceptance baseline task run window is invalid.'
    }
    Assert-DysonRebootAcceptanceIdentity -Value ([string]$Record.hostIdentity) -Name 'Checkpoint host identity'
    Assert-DysonRebootAcceptanceIdentity -Value ([string]$Record.bootIdentityBefore) -Name 'Checkpoint boot identity'
    if ([string]$Record.controlTaskName -notmatch '^[\p{L}\p{N}_. -]{1,128}$') {
        throw 'The reboot-acceptance control task name is invalid.'
    }
    Assert-DysonVersion -Version ([string]$Record.controlVersion)
    foreach ($digestName in @('controlPayloadSha256', 'activePointerSha256', 'checkpointSha256')) {
        Assert-DysonRebootAcceptanceHash -Value ([string]$Record.$digestName) -Name "Checkpoint $digestName"
    }
    foreach ($identityName in @('controlTaskIdentity', 'projectRootIdentity', 'accountIdentity')) {
        Assert-DysonRebootAcceptanceIdentity -Value ([string]$Record.$identityName) -Name "Checkpoint $identityName"
    }
    if ([int]$Record.gamePort -lt 1 -or [int]$Record.gamePort -gt 65535) {
        throw 'The reboot-acceptance game port is invalid.'
    }
    $expectedDigest = Get-DysonRebootAcceptanceCheckpointDigest -Record $Record
    if (-not [string]::Equals(
        [string]$Record.checkpointSha256,
        $expectedDigest,
        [System.StringComparison]::Ordinal
    )) {
        throw 'The reboot-acceptance checkpoint digest is invalid.'
    }
}

function Get-DysonRebootAcceptanceCheckpointRoot {
    param([Parameter(Mandatory)][string]$DataRoot)

    $dataFull = Assert-DysonSafeRoot -Path $DataRoot -Name 'DataRoot'
    $root = Get-DysonFullPath -Path (Join-Path $dataFull $script:DysonRebootAcceptanceCheckpointDirectory)
    if (-not (Test-DysonPathWithin -Candidate $root -Parent $dataFull)) {
        throw 'The reboot-acceptance checkpoint root escaped DataRoot.'
    }
    return $root
}

function Get-DysonRebootAcceptanceCheckpointPath {
    param(
        [Parameter(Mandatory)][string]$DataRoot,
        [Parameter(Mandatory)][string]$CheckpointId
    )

    [void](Assert-DysonRebootAcceptanceCheckpointId -CheckpointId $CheckpointId)
    $root = Get-DysonRebootAcceptanceCheckpointRoot -DataRoot $DataRoot
    $path = Get-DysonFullPath -Path (Join-Path $root ($CheckpointId + '.json'))
    if (-not (Test-DysonPathWithin -Candidate $path -Parent $root)) {
        throw 'The reboot-acceptance checkpoint path escaped its fixed root.'
    }
    return $path
}

function Initialize-DysonRebootAcceptanceCheckpointRoot {
    param(
        [Parameter(Mandatory)][string]$DataRoot,
        [Parameter(Mandatory)]$Context
    )

    $dataFull = Assert-DysonSafeRoot -Path $DataRoot -Name 'DataRoot'
    [void](Assert-DysonPlainDirectory -Path $dataFull)
    $acceptanceRoot = Get-DysonFullPath -Path (Join-Path $dataFull 'acceptance')
    $checkpointRoot = Get-DysonRebootAcceptanceCheckpointRoot -DataRoot $dataFull
    [System.IO.Directory]::CreateDirectory($acceptanceRoot) | Out-Null
    [void](Assert-DysonPlainDirectory -Path $acceptanceRoot)
    [System.IO.Directory]::CreateDirectory($checkpointRoot) | Out-Null
    [void](Assert-DysonPlainDirectory -Path $checkpointRoot)
    $applyAcl = $Context.ApplyAcl
    $validateAcl = $Context.ValidateAcl
    & $applyAcl $checkpointRoot $true
    if (-not (& $validateAcl $checkpointRoot)) {
        throw 'The reboot-acceptance checkpoint root ACL could not be restricted.'
    }
    return $checkpointRoot
}

function Write-DysonRebootAcceptanceCheckpoint {
    param(
        [Parameter(Mandatory)][string]$DataRoot,
        [Parameter(Mandatory)]$Record,
        [Parameter(Mandatory)]$Context
    )

    Assert-DysonRebootAcceptanceCheckpoint -Record $Record
    $root = Initialize-DysonRebootAcceptanceCheckpointRoot -DataRoot $DataRoot -Context $Context
    $path = Get-DysonRebootAcceptanceCheckpointPath -DataRoot $DataRoot -CheckpointId ([string]$Record.checkpointId)
    $text = ConvertTo-DysonRebootAcceptanceCheckpointText -Record $Record
    $bytes = [System.Text.UTF8Encoding]::new($false).GetBytes($text)
    $stream = $null
    try {
        $stream = [System.IO.FileStream]::new(
            $path,
            [System.IO.FileMode]::CreateNew,
            [System.IO.FileAccess]::Write,
            [System.IO.FileShare]::None
        )
        $stream.Write($bytes, 0, $bytes.Length)
        $stream.Flush($true)
    }
    catch {
        if ($stream) { $stream.Dispose(); $stream = $null }
        # Do not remove by pathname after the creation handle is lost. A
        # concurrent replacement cannot be proven to belong to this attempt;
        # preserving the path is the fail-closed maintenance outcome.
        throw 'The reboot-acceptance checkpoint could not be created immutably.'
    }
    finally { if ($stream) { $stream.Dispose() } }

    $applyAcl = $Context.ApplyAcl
    $validateAcl = $Context.ValidateAcl
    try {
        & $applyAcl $path $false
        if (-not (& $validateAcl $path)) {
            throw 'checkpoint ACL invalid'
        }
        $written = Read-DysonRebootAcceptanceCheckpoint -DataRoot $DataRoot `
            -CheckpointId ([string]$Record.checkpointId) -Context $Context
        if (-not [string]::Equals(
            [string]$written.checkpointSha256,
            [string]$Record.checkpointSha256,
            [System.StringComparison]::Ordinal
        )) {
            throw 'checkpoint verification mismatch'
        }
    }
    catch {
        # Post-write verification deliberately preserves the pathname. Once
        # the creation handle is closed, deleting by name could remove a file
        # installed by another maintenance participant.
        throw 'The reboot-acceptance checkpoint failed post-write verification.'
    }
    return $path
}

function Read-DysonRebootAcceptanceCheckpoint {
    param(
        [Parameter(Mandatory)][string]$DataRoot,
        [Parameter(Mandatory)][string]$CheckpointId,
        [Parameter(Mandatory)]$Context
    )

    $root = Get-DysonRebootAcceptanceCheckpointRoot -DataRoot $DataRoot
    $path = Get-DysonRebootAcceptanceCheckpointPath -DataRoot $DataRoot -CheckpointId $CheckpointId
    foreach ($required in @($root, $path)) {
        if (-not (Test-Path -LiteralPath $required)) {
            throw 'The reboot-acceptance checkpoint is unavailable.'
        }
        $item = Get-Item -LiteralPath $required -Force -ErrorAction Stop
        if ($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) {
            throw 'The reboot-acceptance checkpoint is redirected.'
        }
        $validateAcl = $Context.ValidateAcl
        if (-not (& $validateAcl $required)) {
            throw 'The reboot-acceptance checkpoint ACL is not restricted.'
        }
    }
    $file = Get-Item -LiteralPath $path -Force -ErrorAction Stop
    if ($file.PSIsContainer -or $file.Length -lt 1 -or $file.Length -gt 32768) {
        throw 'The reboot-acceptance checkpoint is empty or exceeds its size bound.'
    }
    $raw = [System.IO.File]::ReadAllText($file.FullName, [System.Text.Encoding]::UTF8)
    try { $record = $raw | ConvertFrom-Json -ErrorAction Stop }
    catch { throw 'The reboot-acceptance checkpoint is invalid JSON.' }
    Assert-DysonRebootAcceptanceCheckpoint -Record $record
    if ([string]$record.checkpointId -cne $CheckpointId -or
        -not [string]::Equals(
            $raw,
            (ConvertTo-DysonRebootAcceptanceCheckpointText -Record $record),
            [System.StringComparison]::Ordinal
        )) {
        throw 'The reboot-acceptance checkpoint is noncanonical or misbound.'
    }
    return $record
}

function Assert-DysonRebootAcceptanceBootObservation {
    param([Parameter(Mandatory)]$Observation)

    Assert-DysonRebootAcceptanceExactProperties -Value $Observation -Name 'Boot observation' `
        -Expected @('identity', 'startedAt')
    Assert-DysonRebootAcceptanceIdentity -Value ([string]$Observation.identity) -Name 'Boot observation identity'
    [void](ConvertTo-DysonRebootAcceptanceTimestamp -Value ([string]$Observation.startedAt) -Name 'Boot observation startedAt')
}

function Assert-DysonRebootAcceptanceControlObservation {
    param([Parameter(Mandatory)]$Observation)

    Assert-DysonRebootAcceptanceExactProperties -Value $Observation -Name 'Control observation' `
        -Expected @(
            'ready', 'version', 'payloadSha256', 'activePointerSha256', 'taskIdentity',
            'taskState', 'taskLastRunAt'
        )
    if ($Observation.ready -isnot [bool] -or -not [bool]$Observation.ready -or
        [string]$Observation.taskState -cne 'Running') {
        throw 'The control-plane deployment is not ready for reboot acceptance.'
    }
    Assert-DysonVersion -Version ([string]$Observation.version)
    Assert-DysonRebootAcceptanceHash -Value ([string]$Observation.payloadSha256) -Name 'Control payload digest'
    Assert-DysonRebootAcceptanceHash -Value ([string]$Observation.activePointerSha256) -Name 'Active pointer digest'
    Assert-DysonRebootAcceptanceIdentity -Value ([string]$Observation.taskIdentity) -Name 'Control task identity'
    [void](ConvertTo-DysonRebootAcceptanceTimestamp `
        -Value ([string]$Observation.taskLastRunAt) -Name 'Control task last run')
}

function Assert-DysonRebootAcceptanceGameObservation {
    param([Parameter(Mandatory)]$Observation)

    Assert-DysonRebootAcceptanceExactProperties -Value $Observation -Name 'Game observation' `
        -Expected @('ready', 'projectRootIdentity', 'accountIdentity', 'taskState', 'taskLastRunAt')
    if ($Observation.ready -isnot [bool] -or -not [bool]$Observation.ready -or
        [string]$Observation.taskState -cne 'Running') {
        throw 'The game runtime is not ready for reboot acceptance.'
    }
    Assert-DysonRebootAcceptanceIdentity -Value ([string]$Observation.projectRootIdentity) -Name 'Project-root identity'
    Assert-DysonRebootAcceptanceIdentity -Value ([string]$Observation.accountIdentity) -Name 'Interactive account identity'
    [void](ConvertTo-DysonRebootAcceptanceTimestamp `
        -Value ([string]$Observation.taskLastRunAt) -Name 'Game task last run')
}

function New-DysonRebootAcceptanceCheckpointRecord {
    param(
        [Parameter(Mandatory)]$Context,
        [Parameter(Mandatory)][string]$TaskName,
        [Parameter(Mandatory)][int]$GamePort,
        [ValidateRange(1, 72)][int]$ValidityHours = 24
    )

    if ($TaskName -notmatch '^[\p{L}\p{N}_. -]{1,128}$') {
        throw 'The reboot-acceptance control task name is invalid.'
    }
    if ($GamePort -lt 1 -or $GamePort -gt 65535) {
        throw 'The reboot-acceptance game port is invalid.'
    }
    $getHostIdentity = $Context.GetHostIdentity
    $hostIdentity = [string](& $getHostIdentity)
    Assert-DysonRebootAcceptanceIdentity -Value $hostIdentity -Name 'Current host identity'
    $getBootObservation = $Context.GetBootObservation
    $boot = & $getBootObservation $hostIdentity
    Assert-DysonRebootAcceptanceBootObservation -Observation $boot
    $getControlObservation = $Context.GetControlObservation
    $control = & $getControlObservation $TaskName
    Assert-DysonRebootAcceptanceControlObservation -Observation $control
    $getGameObservation = $Context.GetGameObservation
    $game = & $getGameObservation $GamePort
    Assert-DysonRebootAcceptanceGameObservation -Observation $game
    $nowOperation = $Context.Now
    $nowText = [string](& $nowOperation)
    $now = ConvertTo-DysonRebootAcceptanceTimestamp -Value $nowText -Name 'Current acceptance time'
    $bootStartedAt = ConvertTo-DysonRebootAcceptanceTimestamp -Value ([string]$boot.startedAt) -Name 'Current boot start'
    if ($now -lt $bootStartedAt) { throw 'The current boot time is later than the acceptance clock.' }
    $controlTaskLastRunAt = ConvertTo-DysonRebootAcceptanceTimestamp `
        -Value ([string]$control.taskLastRunAt) -Name 'Control task last run'
    $gameTaskLastRunAt = ConvertTo-DysonRebootAcceptanceTimestamp `
        -Value ([string]$game.taskLastRunAt) -Name 'Game task last run'
    if ($controlTaskLastRunAt -lt $bootStartedAt -or $controlTaskLastRunAt -gt $now -or
        $gameTaskLastRunAt -lt $bootStartedAt -or $gameTaskLastRunAt -gt $now) {
        throw 'The current task run evidence is outside the active boot window.'
    }
    $newId = $Context.NewId
    $checkpointId = [string](& $newId)
    [void](Assert-DysonRebootAcceptanceCheckpointId -CheckpointId $checkpointId)
    $record = [ordered]@{
        protocol = $script:DysonRebootAcceptanceProtocol
        schemaVersion = $script:DysonRebootAcceptanceSchemaVersion
        state = $script:DysonRebootAcceptanceCheckpointState
        checkpointId = $checkpointId
        createdAt = $now.ToString('o', [System.Globalization.CultureInfo]::InvariantCulture)
        expiresAt = $now.AddHours($ValidityHours).ToString('o', [System.Globalization.CultureInfo]::InvariantCulture)
        hostIdentity = $hostIdentity
        bootIdentityBefore = [string]$boot.identity
        bootStartedAtBefore = [string]$boot.startedAt
        controlTaskName = $TaskName
        controlVersion = [string]$control.version
        controlPayloadSha256 = [string]$control.payloadSha256
        activePointerSha256 = [string]$control.activePointerSha256
        controlTaskIdentity = [string]$control.taskIdentity
        controlTaskLastRunAtBefore = [string]$control.taskLastRunAt
        gamePort = $GamePort
        projectRootIdentity = [string]$game.projectRootIdentity
        accountIdentity = [string]$game.accountIdentity
        gameTaskLastRunAtBefore = [string]$game.taskLastRunAt
        checkpointSha256 = $null
    }
    $record.checkpointSha256 = Get-DysonRebootAcceptanceCheckpointDigest -Record $record
    Assert-DysonRebootAcceptanceCheckpoint -Record $record
    return $record
}

function Invoke-DysonCreateRebootAcceptanceCheckpoint {
    param(
        [Parameter(Mandatory)][string]$DataRoot,
        [Parameter(Mandatory)]$Context,
        [Parameter(Mandatory)][string]$TaskName,
        [Parameter(Mandatory)][int]$GamePort,
        [ValidateRange(1, 72)][int]$ValidityHours = 24,
        [Parameter(Mandatory)][bool]$Apply
    )

    $record = New-DysonRebootAcceptanceCheckpointRecord -Context $Context -TaskName $TaskName `
        -GamePort $GamePort -ValidityHours $ValidityHours
    if (-not $Apply) {
        return [pscustomobject][ordered]@{
            protocol = $script:DysonRebootAcceptanceProtocol
            state = 'preview'
            wouldCreateCheckpoint = $true
            baselineControlVersion = [string]$record.controlVersion
            gamePort = [int]$record.gamePort
            rebootPerformed = $false
            realRebootObserved = $false
            automaticTaskTriggerProven = $false
            unattendedStartupValidated = $false
            qualifyingProductionEvidence = $false
        }
    }
    [void](Write-DysonRebootAcceptanceCheckpoint -DataRoot $DataRoot -Record $record -Context $Context)
    return [pscustomobject][ordered]@{
        protocol = $script:DysonRebootAcceptanceProtocol
        state = 'checkpoint-created'
        checkpointId = [string]$record.checkpointId
        baselineControlVersion = [string]$record.controlVersion
        gamePort = [int]$record.gamePort
        expiresAt = [string]$record.expiresAt
        rebootPerformed = $false
        realRebootObserved = $false
        automaticTaskTriggerProven = $false
        unattendedStartupValidated = $false
        qualifyingProductionEvidence = $false
    }
}

function Invoke-DysonTestRebootAcceptanceResume {
    param(
        [Parameter(Mandatory)][string]$DataRoot,
        [Parameter(Mandatory)][string]$CheckpointId,
        [Parameter(Mandatory)]$Context
    )

    $record = Read-DysonRebootAcceptanceCheckpoint -DataRoot $DataRoot `
        -CheckpointId $CheckpointId -Context $Context
    $nowOperation = $Context.Now
    $now = ConvertTo-DysonRebootAcceptanceTimestamp -Value ([string](& $nowOperation)) -Name 'Current acceptance time'
    $expiresAt = ConvertTo-DysonRebootAcceptanceTimestamp -Value ([string]$record.expiresAt) -Name 'Checkpoint expiresAt'
    if ($now -gt $expiresAt) { throw 'DYSON_REBOOT_ACCEPTANCE_CHECKPOINT_EXPIRED' }

    $getHostIdentity = $Context.GetHostIdentity
    $hostIdentity = [string](& $getHostIdentity)
    if (-not [string]::Equals($hostIdentity, [string]$record.hostIdentity, [System.StringComparison]::Ordinal)) {
        throw 'DYSON_REBOOT_ACCEPTANCE_HOST_CHANGED'
    }
    $getBootObservation = $Context.GetBootObservation
    $boot = & $getBootObservation $hostIdentity
    Assert-DysonRebootAcceptanceBootObservation -Observation $boot
    if ([string]::Equals([string]$boot.identity, [string]$record.bootIdentityBefore, [System.StringComparison]::Ordinal)) {
        throw 'DYSON_REBOOT_NOT_OBSERVED'
    }
    $currentBootStartedAt = ConvertTo-DysonRebootAcceptanceTimestamp `
        -Value ([string]$boot.startedAt) -Name 'Current boot start'
    $createdAt = ConvertTo-DysonRebootAcceptanceTimestamp -Value ([string]$record.createdAt) -Name 'Checkpoint createdAt'
    if ($currentBootStartedAt -le $createdAt -or $currentBootStartedAt -gt $now) {
        throw 'DYSON_REBOOT_ACCEPTANCE_BOOT_SEQUENCE_INVALID'
    }

    $getControlObservation = $Context.GetControlObservation
    $control = & $getControlObservation ([string]$record.controlTaskName)
    Assert-DysonRebootAcceptanceControlObservation -Observation $control
    if ([string]$control.version -cne [string]$record.controlVersion -or
        [string]$control.payloadSha256 -cne [string]$record.controlPayloadSha256 -or
        [string]$control.activePointerSha256 -cne [string]$record.activePointerSha256 -or
        [string]$control.taskIdentity -cne [string]$record.controlTaskIdentity) {
        throw 'DYSON_REBOOT_ACCEPTANCE_CONTROL_DRIFT'
    }
    $controlTaskLastRunAt = ConvertTo-DysonRebootAcceptanceTimestamp `
        -Value ([string]$control.taskLastRunAt) -Name 'Control task last run'
    $controlTaskLastRunAtBefore = ConvertTo-DysonRebootAcceptanceTimestamp `
        -Value ([string]$record.controlTaskLastRunAtBefore) -Name 'Checkpoint control task last run'
    if ($controlTaskLastRunAt -le $controlTaskLastRunAtBefore -or
        $controlTaskLastRunAt -le $createdAt -or $controlTaskLastRunAt -lt $currentBootStartedAt -or
        $controlTaskLastRunAt -gt $now) {
        throw 'DYSON_REBOOT_ACCEPTANCE_CONTROL_TASK_RUN_INVALID'
    }

    $getGameObservation = $Context.GetGameObservation
    $game = & $getGameObservation ([int]$record.gamePort)
    Assert-DysonRebootAcceptanceGameObservation -Observation $game
    if ([string]$game.projectRootIdentity -cne [string]$record.projectRootIdentity -or
        [string]$game.accountIdentity -cne [string]$record.accountIdentity) {
        throw 'DYSON_REBOOT_ACCEPTANCE_GAME_DRIFT'
    }
    $gameTaskLastRunAt = ConvertTo-DysonRebootAcceptanceTimestamp `
        -Value ([string]$game.taskLastRunAt) -Name 'Game task last run'
    $gameTaskLastRunAtBefore = ConvertTo-DysonRebootAcceptanceTimestamp `
        -Value ([string]$record.gameTaskLastRunAtBefore) -Name 'Checkpoint game task last run'
    if ($gameTaskLastRunAt -le $gameTaskLastRunAtBefore -or
        $gameTaskLastRunAt -le $createdAt -or $gameTaskLastRunAt -lt $currentBootStartedAt -or
        $gameTaskLastRunAt -gt $now) {
        throw 'DYSON_REBOOT_ACCEPTANCE_GAME_TASK_RUN_INVALID'
    }

    $native = [string]::Equals([string]$Context.Mode, 'native', [System.StringComparison]::Ordinal)
    return [pscustomobject][ordered]@{
        protocol = $script:DysonRebootAcceptanceProtocol
        state = if ($native) { 'post-reboot-runtime-observed' } else { 'fixture-resume-validated' }
        checkpointId = [string]$record.checkpointId
        controlVersion = [string]$record.controlVersion
        controlTaskDefinitionValidated = $true
        controlTaskExecutionInNewBootValidated = $true
        loopbackReadinessValidated = $true
        interactiveSessionValidated = $true
        gameRuntimeValidated = $true
        gameTaskExecutionInNewBootValidated = $true
        duplicateGameProcessRejectedByRuntimeProbe = $true
        realRebootObserved = $native
        fixtureBootTransitionValidated = -not $native
        automaticTaskTriggerProven = $false
        unattendedStartupValidated = $false
        qualifyingProductionEvidence = $false
        requiresPrivateEvidenceBundle = $true
    }
}

function Get-DysonRebootAcceptanceNativeBootObservation {
    param([Parameter(Mandatory)][string]$HostIdentity)

    Assert-DysonRebootAcceptanceIdentity -Value $HostIdentity -Name 'Current host identity'
    $startedAt = $null
    try {
        $systemProcess = [System.Diagnostics.Process]::GetProcessById(4)
        try { $startedAt = ([datetimeoffset]$systemProcess.StartTime.ToUniversalTime()).ToString('o') }
        finally { $systemProcess.Dispose() }
    }
    catch { $startedAt = $null }
    if ([string]::IsNullOrWhiteSpace($startedAt)) {
        $operatingSystem = Get-CimInstance -ClassName Win32_OperatingSystem -ErrorAction Stop
        $startedAt = ([datetimeoffset]([datetime]$operatingSystem.LastBootUpTime).ToUniversalTime()).ToString('o')
    }
    $canonicalStartedAt = (ConvertTo-DysonRebootAcceptanceTimestamp -Value $startedAt -Name 'Current boot start').ToString('o')
    return [pscustomobject][ordered]@{
        identity = 'sha256:' + (Get-DysonHostMutationLeaseTextSha256 -Value ($HostIdentity + '|' + $canonicalStartedAt))
        startedAt = $canonicalStartedAt
    }
}

function Get-DysonRebootAcceptanceNativeControlObservation {
    param(
        [Parameter(Mandatory)][string]$InstallRoot,
        [Parameter(Mandatory)][string]$DataRoot,
        [Parameter(Mandatory)][uri]$ReadinessUri,
        [Parameter(Mandatory)][string]$TaskName
    )

    $active = Get-DysonActiveRelease -InstallRoot $InstallRoot -DataRoot $DataRoot
    if (-not $active) { throw 'No Dyson Control release is active.' }
    $tasks = @(Get-DysonScheduledTasksByExactName -TaskName $TaskName)
    if ($tasks.Count -ne 1) { throw 'The control-plane task identity is not unique.' }
    $task = $tasks[0]
    $taskInfo = Get-ScheduledTaskInfo -InputObject $task -ErrorAction Stop
    $actions = @($task.Actions | Where-Object { $null -ne $_ })
    $triggers = @($task.Triggers | Where-Object { $null -ne $_ })
    $powerShellExecutable = [System.IO.Path]::GetFullPath(
        (Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe')
    )
    $launcherPath = [System.IO.Path]::GetFullPath((Join-Path $InstallRoot 'bootstrap\Start-DysonControl.ps1'))
    $argumentPattern = '(?i)^-NoLogo\s+-NoProfile\s+-NonInteractive\s+-ExecutionPolicy\s+Bypass\s+-File\s+"(?<launcher>[^"]+)"\s+-InstallRoot\s+"(?<install>[^"]+)"\s+-DataRoot\s+"(?<data>[^"]+)"\s+-NodeExecutable\s+"(?<node>[^"]+)"\s+-EnvironmentFile\s+"(?<environment>[^"]+)"$'
    $definition = if ($actions.Count -eq 1) { [regex]::Match([string]$actions[0].Arguments, $argumentPattern) } else { $null }
    $triggerClass = if ($triggers.Count -eq 1 -and $triggers[0].PSObject.Properties.Name -contains 'CimClass') {
        [string]$triggers[0].CimClass.CimClassName
    }
    else { '' }
    $taskValid = $task.PSObject.Properties.Name -contains 'TaskPath' -and
        [string]$task.TaskPath -ceq $script:DysonControlTaskPath -and
        [string]::Equals($task.State.ToString(), 'Running', [System.StringComparison]::Ordinal) -and
        $task.Principal.LogonType.ToString() -eq 'ServiceAccount' -and
        $actions.Count -eq 1 -and $definition -and $definition.Success -and
        [System.IO.Path]::GetFullPath([Environment]::ExpandEnvironmentVariables([string]$actions[0].Execute)).Equals(
            $powerShellExecutable,
            [System.StringComparison]::OrdinalIgnoreCase
        ) -and
        [System.IO.Path]::GetFullPath($definition.Groups['launcher'].Value).Equals($launcherPath, [System.StringComparison]::OrdinalIgnoreCase) -and
        [System.IO.Path]::GetFullPath($definition.Groups['install'].Value).Equals([System.IO.Path]::GetFullPath($InstallRoot), [System.StringComparison]::OrdinalIgnoreCase) -and
        [System.IO.Path]::GetFullPath($definition.Groups['data'].Value).Equals([System.IO.Path]::GetFullPath($DataRoot), [System.StringComparison]::OrdinalIgnoreCase) -and
        $triggers.Count -eq 1 -and $triggerClass -match 'TaskBootTrigger$' -and
        $task.Settings.MultipleInstances.ToString() -eq 'IgnoreNew' -and
        [int]$task.Settings.RestartCount -ge 1
    if (-not $taskValid) { throw 'The fixed control-plane startup task failed reboot-acceptance validation.' }
    $taskLastRunAt = ([datetimeoffset]([datetime]$taskInfo.LastRunTime)).ToUniversalTime().ToString(
        'o',
        [System.Globalization.CultureInfo]::InvariantCulture
    )
    [void](ConvertTo-DysonRebootAcceptanceTimestamp -Value $taskLastRunAt -Name 'Control task last run')
    foreach ($path in @(
        $definition.Groups['node'].Value,
        $definition.Groups['environment'].Value,
        $definition.Groups['launcher'].Value
    )) {
        $item = Get-Item -LiteralPath $path -Force -ErrorAction Stop
        if ($item.PSIsContainer -or ($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint)) {
            throw 'A control-plane startup dependency is unavailable or redirected.'
        }
    }
    [void](Test-DysonLoopbackReadiness -ReadinessUri $ReadinessUri `
        -ExpectedVersion ([string]$active.pointer.version) -TimeoutSeconds 10)
    $taskIdentityText = [string]::Join('|', @(
        $TaskName,
        [string]$task.TaskPath,
        ([string]$task.Principal.UserId).ToUpperInvariant(),
        [string]$actions[0].Execute,
        [string]$actions[0].Arguments,
        $triggerClass,
        $task.Settings.MultipleInstances.ToString(),
        [string]$task.Settings.RestartCount
    ))
    return [pscustomobject][ordered]@{
        ready = $true
        version = [string]$active.pointer.version
        payloadSha256 = [string]$active.pointer.payloadSha256
        activePointerSha256 = Get-DysonFileSha256 -Path ([string]$active.pointerPath)
        taskIdentity = 'sha256:' + (Get-DysonTextSha256 -Value $taskIdentityText)
        taskState = 'Running'
        taskLastRunAt = $taskLastRunAt
    }
}

function Get-DysonRebootAcceptanceNativeGameObservation {
    param([Parameter(Mandatory)][int]$GamePort)

    $sessionContext = New-DysonNativeSessionContext
    $metadata = Read-DysonBackupMetadata -Context $sessionContext
    if (-not $metadata) { throw 'The dedicated interactive session is not configured.' }
    $resolveAccount = $sessionContext.ResolveAccount
    $account = & $resolveAccount ([string]$metadata.accountName)
    $validateTask = $sessionContext.ValidateTask
    $task = & $validateTask $account
    if (-not $task.Ready) { throw 'The fixed game startup task failed reboot-acceptance validation.' }
    $nativeTasks = @(Get-ScheduledTask -TaskName $script:DysonServerTaskName -ErrorAction Stop)
    if ($nativeTasks.Count -ne 1 -or
        -not [string]::Equals($nativeTasks[0].State.ToString(), 'Running', [System.StringComparison]::Ordinal)) {
        throw 'The fixed game startup task is not running in the current boot.'
    }
    $taskInfo = Get-ScheduledTaskInfo -InputObject $nativeTasks[0] -ErrorAction Stop
    $taskLastRunAt = ([datetimeoffset]([datetime]$taskInfo.LastRunTime)).ToUniversalTime().ToString(
        'o',
        [System.Globalization.CultureInfo]::InvariantCulture
    )
    [void](ConvertTo-DysonRebootAcceptanceTimestamp -Value $taskLastRunAt -Name 'Game task last run')
    $session = Get-DysonInteractiveSessionConfiguration -Context $sessionContext
    if (-not [bool]$session.ready -or -not [bool]$session.interactiveSessionEvidenceVerifiable -or
        -not [bool]$session.interactiveSessionPresent) {
        throw 'The dedicated non-Session-0 interactive session is not present or verifiable.'
    }
    $runtimeScript = Get-DysonFullPath -Path (Join-Path $PSScriptRoot '..\Test-DysonRuntimeState.ps1')
    $runtimeItem = Get-Item -LiteralPath $runtimeScript -Force -ErrorAction Stop
    if ($runtimeItem.PSIsContainer -or ($runtimeItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint)) {
        throw 'The fixed game runtime verifier is unavailable or redirected.'
    }
    $runtimeOutput = & $runtimeItem.FullName -ProjectRoot ([string]$task.ProjectRoot) `
        -Expected running -GamePort $GamePort
    $runtimeLines = @(
        ($runtimeOutput | Out-String) -split "`r?`n" |
            Where-Object { -not [string]::IsNullOrWhiteSpace($_) }
    )
    if ($runtimeLines.Count -eq 0) { throw 'The fixed game runtime verifier returned no receipt.' }
    $runtime = $runtimeLines[$runtimeLines.Count - 1] | ConvertFrom-Json -ErrorAction Stop
    if ([string]$runtime.protocol -cne 'DYSON_CONTROL_RUNTIME_V1' -or
        [string]$runtime.expected -cne 'running' -or [string]$runtime.state -cne 'matched' -or
        $runtime.processVerified -isnot [bool] -or -not [bool]$runtime.processVerified -or
        $runtime.gamePortListening -isnot [bool] -or -not [bool]$runtime.gamePortListening) {
        throw 'The game runtime verifier returned an unsupported receipt.'
    }
    $projectRoot = [System.IO.Path]::GetFullPath([string]$task.ProjectRoot).TrimEnd('\', '/')
    return [pscustomobject][ordered]@{
        ready = $true
        projectRootIdentity = 'sha256:' + (Get-DysonTextSha256 -Value $projectRoot.ToUpperInvariant())
        accountIdentity = 'sha256:' + (Get-DysonTextSha256 -Value (([string]$account.Sid).ToUpperInvariant()))
        taskState = 'Running'
        taskLastRunAt = $taskLastRunAt
    }
}

function New-DysonNativeRebootAcceptanceContext {
    param(
        [Parameter(Mandatory)][string]$InstallRoot,
        [Parameter(Mandatory)][string]$DataRoot,
        [Parameter(Mandatory)][uri]$ReadinessUri
    )

    $installFull = Assert-DysonSafeRoot -Path $InstallRoot -Name 'InstallRoot'
    $dataFull = Assert-DysonSafeRoot -Path $DataRoot -Name 'DataRoot'
    if ($ReadinessUri.Scheme -ne 'http' -or $ReadinessUri.AbsolutePath -ne '/readyz' -or
        $ReadinessUri.Host -notin @('127.0.0.1', 'localhost', '::1')) {
        throw 'ReadinessUri must be a loopback HTTP /readyz endpoint.'
    }
    $readiness = $ReadinessUri
    return [pscustomobject]@{
        Mode = 'native'
        GetHostIdentity = { Get-DysonHostMutationLeaseHostIdentity }
        GetBootObservation = {
            param([string]$HostIdentity)
            Get-DysonRebootAcceptanceNativeBootObservation -HostIdentity $HostIdentity
        }
        GetControlObservation = {
            param([string]$TaskName)
            Get-DysonRebootAcceptanceNativeControlObservation -InstallRoot $installFull `
                -DataRoot $dataFull -ReadinessUri $readiness -TaskName $TaskName
        }.GetNewClosure()
        GetGameObservation = {
            param([int]$GamePort)
            Get-DysonRebootAcceptanceNativeGameObservation -GamePort $GamePort
        }
        ApplyAcl = {
            param([string]$Path, [bool]$Directory)
            Set-DysonRestrictedBackupAcl -LiteralPath $Path -Directory $Directory
        }
        ValidateAcl = {
            param([string]$Path)
            Test-DysonRestrictedBackupAcl -LiteralPath $Path
        }
        Now = { (Get-Date).ToUniversalTime().ToString('o') }
        NewId = { [guid]::NewGuid().ToString('D').ToLowerInvariant() }
    }
}
