[CmdletBinding(SupportsShouldProcess, ConfirmImpact = 'High')]
param(
    [Parameter(Mandatory)][string]$ProjectRoot,
    [Parameter(Mandatory)][string]$DataRoot,
    [Parameter(Mandatory)][string]$RuntimeBootstrapRoot,
    [Parameter(Mandatory)][string]$RuntimeTaskTransactionRoot,
    [Parameter(Mandatory)][ValidatePattern('^[^"\r\n]{1,128}$')][string]$ServiceUser,
    [Parameter(Mandatory)][ValidatePattern('^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$')][string]$RequestId,
    [switch]$Recover,
    # Explicit reconstruction input, never a claim of historical task backup.
    # Exactly legacy-server.xml and legacy-stop.xml; SHA256 of UTF8(serverHash:stopHash).
    [string]$PreparedLegacyTemplateRoot,
    [ValidatePattern('^[0-9a-f]{64}$')][string]$ExpectedLegacyTemplateSha256,
    [string]$LeaseInstanceId,
    [string]$LeaseToken,
    [ValidateSet('Windows', 'Shadow')][string]$Backend = 'Windows',
    [string]$ShadowRoot
)

Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)

$common = Join-Path $PSScriptRoot 'DysonGsManagerAuthority.Common.ps1'
$leaseCommon = Join-Path (Split-Path $PSScriptRoot -Parent) 'DysonHostMutationLease.Common.ps1'
if (-not (Test-Path -LiteralPath $common -PathType Leaf) -or
    -not (Test-Path -LiteralPath $leaseCommon -PathType Leaf)) {
    [ordered]@{ ok = $false; error = [ordered]@{ code = 'DYSON_GSMANAGER_AUTHORITY_DEPENDENCY_MISSING' } } |
        ConvertTo-Json -Compress
    exit 1
}
. $leaseCommon
. $common

function Write-GsAuthorityResult {
    param([Parameter(Mandatory)]$Value)
    $Value | ConvertTo-Json -Depth 8 -Compress
}

function New-GsAuthorityReceipt {
    param(
        [Parameter(Mandatory)]$Intent,
        [ValidateSet('succeeded', 'rolled-back')][string]$Status,
        [Parameter(Mandatory)][string]$TerminalDigest
    )
    $receipt = [ordered]@{
        protocol = $script:GsAuthorityReceiptProtocol
        schemaVersion = 1
        requestId = [string]$Intent.requestId
        requestFingerprint = [string]$Intent.requestFingerprint
        status = $Status
        terminalDigest = $TerminalDigest
        panelTask = $script:GsAuthorityPanelTask
        previousServerTask = $script:GsAuthorityNewStartTask
        previousStopTask = $script:GsAuthorityNewStopTask
        legacyPairDisabled = ($Status -ceq 'succeeded')
        envUpdated = ($Status -ceq 'succeeded')
        completedAt = [DateTime]::UtcNow.ToString('o')
        reused = $false
    }
    if ($script:GsAuthorityPreparedTemplates) {
        $receipt['authoritySource'] = 'reconstructed-template'
        $receipt['legacyTemplateSha256'] = $ExpectedLegacyTemplateSha256
    }
    return [pscustomobject]$receipt
}

function New-GsAuthorityProfile {
    param([Parameter(Mandatory)]$Intent)
    $taskProfile = {
        param([Parameter(Mandatory)]$Image)
        return [pscustomobject][ordered]@{
            taskName = [string]$Image.taskName
            taskPath = [string]$Image.taskPath
            definitionSha256 = Get-GsAuthoritySha256Bytes ([Convert]::FromBase64String([string]$Image.xmlBase64))
            enabled = [bool]$Image.enabled
        }
    }
    $panel = Get-GsAuthorityTaskImage $script:GsAuthorityPanelTask
    $previousStart = Get-GsAuthorityTaskImage $script:GsAuthorityNewStartTask
    $previousStop = Get-GsAuthorityTaskImage $script:GsAuthorityNewStopTask
    $candidateStart = Get-GsAuthorityTaskImage $script:GsAuthorityOldStartTask
    $candidateStop = Get-GsAuthorityTaskImage $script:GsAuthorityOldStopTask
    $preparedDescriptors = Get-GsAuthorityExpectedRuntimeDescriptors $false
    $activeDescriptors = Get-GsAuthorityExpectedRuntimeDescriptors $true
    $profileCore = [pscustomobject][ordered]@{
        protocol = 'DYSON_GSMANAGER_AUTHORITY_PROFILE_V1'
        schemaVersion = 1
        requestId = [string]$Intent.requestId
        requestFingerprint = [string]$Intent.requestFingerprint
        projectRootIdentity = 'sha256:' + (Get-GsAuthoritySha256Text $script:GsAuthorityProjectRoot.ToUpperInvariant())
        dataRootIdentity = $script:GsAuthorityDataRootIdentity
        authorityRootIdentity = 'sha256:' + (Get-GsAuthoritySha256Text ([IO.Path]::GetDirectoryName($script:GsAuthorityProfilePath).ToUpperInvariant()))
        runtimeBootstrapIdentity = 'sha256:' + (Get-GsAuthoritySha256Text $script:GsAuthorityRuntimeBootstrapRoot.ToUpperInvariant())
        runtimeBootstrapStartSha256 = $script:GsAuthorityRuntimeBootstrapStartSha256
        runtimeBootstrapStopSha256 = $script:GsAuthorityRuntimeBootstrapStopSha256
        runtimeTaskTransactionRootIdentity = 'sha256:' + (Get-GsAuthoritySha256Text $script:GsAuthorityRuntimeTaskTransactionRoot.ToUpperInvariant())
        serviceUser = $ServiceUser
        gamePort = 8469
        previousAuthority = [pscustomobject][ordered]@{
            main = & $taskProfile $panel
            start = & $taskProfile $previousStart
            stop = & $taskProfile $previousStop
        }
        candidateAuthority = [pscustomobject][ordered]@{
            startTaskName = $script:GsAuthorityOldStartTask
            stopTaskName = $script:GsAuthorityOldStopTask
            taskPath = $script:GsAuthorityTaskPath
            legacyPreimage = [pscustomobject][ordered]@{
                startDefinitionSha256 = (& $taskProfile $candidateStart).definitionSha256
                stopDefinitionSha256 = (& $taskProfile $candidateStop).definitionSha256
                expectedEnabledBeforeIsolation = -not $script:GsAuthorityPreparedTemplates
                expectedEnabledAfterIsolation = $false
            }
            expectedPreparedDisabled = [pscustomobject][ordered]@{
                startDescriptorSha256 = Get-GsAuthoritySha256Text (ConvertTo-GsAuthorityJson $preparedDescriptors.start)
                stopDescriptorSha256 = Get-GsAuthoritySha256Text (ConvertTo-GsAuthorityJson $preparedDescriptors.stop)
            }
            expectedActive = [pscustomobject][ordered]@{
                startDescriptorSha256 = Get-GsAuthoritySha256Text (ConvertTo-GsAuthorityJson $activeDescriptors.start)
                stopDescriptorSha256 = Get-GsAuthoritySha256Text (ConvertTo-GsAuthorityJson $activeDescriptors.stop)
            }
            allowedTransitions = @('legacy-preimage-disabled', 'prepared-disabled', 'active')
        }
        previousScriptBundleRevision = Get-GsAuthoritySha256Text ((Get-GsAuthorityFileImage $script:GsAuthorityStartCopy).sha256 + ':' + (Get-GsAuthorityFileImage $script:GsAuthorityStopCopy).sha256)
    }
    if ($script:GsAuthorityPreparedTemplates) {
        $profileCore | Add-Member -NotePropertyName authoritySource -NotePropertyValue 'reconstructed-template'
        $profileCore | Add-Member -NotePropertyName legacyTemplateSha256 -NotePropertyValue $ExpectedLegacyTemplateSha256
    }
    $revisionCore = [ordered]@{}
    foreach ($property in $profileCore.PSObject.Properties) { $revisionCore[$property.Name] = $property.Value }
    $profile = [ordered]@{}
    foreach ($property in $profileCore.PSObject.Properties) { $profile[$property.Name] = $property.Value }
    $profile['inventoryRevision'] = Get-GsAuthoritySha256Text (ConvertTo-GsAuthorityJson $revisionCore)
    return [pscustomobject]$profile
}

function Get-GsAuthorityExpectedRuntimeDescriptors {
    param([Parameter(Mandatory)][bool]$Enabled)
    $powerShell = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
    $startScript = Join-Path $script:GsAuthorityRuntimeBootstrapRoot 'Start-DysonServer.ps1'
    $stopScript = Join-Path $script:GsAuthorityRuntimeBootstrapRoot 'Stop-DysonServer.ps1'
    $startArguments = '-NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "{0}" -ProjectRoot "{1}" -Ups 60' -f $startScript, $script:GsAuthorityProjectRoot
    $stopArguments = '-NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "{0}" -ProjectRoot "{1}" -TimeoutSeconds 150' -f $stopScript, $script:GsAuthorityProjectRoot
    return [pscustomobject][ordered]@{
        start = [pscustomobject][ordered]@{
            taskName = $script:GsAuthorityOldStartTask; taskPath = '\'; execute = $powerShell
            arguments = $startArguments; userId = $ServiceUser; logonType = 'Interactive'; runLevel = 'Limited'
            trigger = 'AtLogOn'; triggerUserId = $ServiceUser; triggerDelay = 'PT20S'
            executionTimeLimit = 'PT0S'; multipleInstances = 'IgnoreNew'; restartCount = 3
            restartInterval = 'PT1M'; startWhenAvailable = $true; enabled = $Enabled
            taskSecurityDescriptor = 'O:SYG:SYD:P(A;;GA;;;SY)(A;;GA;;;BA)(A;;GRGX;;;LS)'
            description = 'Starts DSP, BepInEx, Nebula, and the Dyson Control bridge from the stable bootstrap root.'
        }
        stop = [pscustomobject][ordered]@{
            taskName = $script:GsAuthorityOldStopTask; taskPath = '\'; execute = $powerShell
            arguments = $stopArguments; userId = $ServiceUser; logonType = 'Interactive'; runLevel = 'Limited'
            trigger = 'None'; triggerUserId = $null; triggerDelay = $null; executionTimeLimit = 'PT5M'
            multipleInstances = 'IgnoreNew'; restartCount = 0; restartInterval = $null
            startWhenAvailable = $false; enabled = $Enabled
            taskSecurityDescriptor = 'O:SYG:SYD:P(A;;GA;;;SY)(A;;GA;;;BA)(A;;GRGX;;;LS)'
            description = 'Sends a graceful console stop to the exact managed DSP process; never force-kills on timeout.'
        }
    }
}

function Assert-GsAuthorityIntent {
    param([Parameter(Mandatory)]$Intent)
    if ([string]$Intent.protocol -cne $script:GsAuthorityProtocol -or
        [int]$Intent.schemaVersion -ne 1 -or
        [string]$Intent.requestId -cne $script:GsAuthorityRequestId -or
        [string]$Intent.requestFingerprint -cne $script:GsAuthorityRequestFingerprint -or
        [string]$Intent.dataRootIdentity -cne $script:GsAuthorityDataRootIdentity -or
        [string]$Intent.projectRootIdentity -cne $script:GsAuthorityProjectRoot.ToUpperInvariant() -or
        [string]$Intent.runtimeBootstrapIdentity -cne $script:GsAuthorityRuntimeBootstrapRoot.ToUpperInvariant() -or
        [string]$Intent.runtimeTaskTransactionRootIdentity -cne $script:GsAuthorityRuntimeTaskTransactionRoot.ToUpperInvariant() -or
        -not [string]::Equals([string]$Intent.serviceUser, $ServiceUser, [StringComparison]::OrdinalIgnoreCase) -or
        [string]$Intent.preimageDigest -notmatch '^[0-9a-f]{64}$' -or
        [string]$Intent.preimageDigest -cne (Get-GsAuthoritySha256Text (ConvertTo-GsAuthorityJson $Intent.preimage)) -or
        [string]$Intent.targetDigest -notmatch '^[0-9a-f]{64}$' -or
        [string]$Intent.targetDigest -cne (Get-GsAuthoritySha256Text (ConvertTo-GsAuthorityJson $Intent.target))) {
        Throw-GsAuthorityError 'DYSON_GSMANAGER_AUTHORITY_RECOVERY_MISMATCH'
    }
    foreach ($name in @('oldStart', 'oldStop', 'newStart', 'newStop', 'panel')) {
        $image = $Intent.preimage.tasks.$name
        if ($null -eq $image -or [string]$image.taskPath -cne '\') {
            Throw-GsAuthorityError 'DYSON_GSMANAGER_AUTHORITY_EVIDENCE_INVALID'
        }
        if ([bool]$image.present) {
            try { [void][Convert]::FromBase64String([string]$image.xmlBase64) }
            catch { Throw-GsAuthorityError 'DYSON_GSMANAGER_AUTHORITY_EVIDENCE_INVALID' }
        }
    }
    foreach ($name in @('env', 'startCopy', 'stopCopy', 'profile')) {
        $image = $Intent.preimage.$name
        if ([bool]$image.present) {
            try {
                $bytes = [Convert]::FromBase64String([string]$image.bytesBase64)
                if ((Get-GsAuthoritySha256Bytes $bytes) -cne [string]$image.sha256) { throw 'digest' }
            }
            catch { Throw-GsAuthorityError 'DYSON_GSMANAGER_AUTHORITY_EVIDENCE_INVALID' }
        }
    }
}

function Read-GsAuthorityValidatedReceipt {
    param([Parameter(Mandatory)]$Intent, [switch]$AllowMissing)
    $receipt = Read-GsAuthorityJson $script:GsAuthorityReceiptPath -AllowMissing:$AllowMissing
    if ($null -eq $receipt) { return $null }
    if ([string]$receipt.protocol -cne $script:GsAuthorityReceiptProtocol -or
        [int]$receipt.schemaVersion -ne 1 -or [string]$receipt.requestId -cne [string]$Intent.requestId -or
        [string]$receipt.requestFingerprint -cne [string]$Intent.requestFingerprint -or
        [string]$receipt.status -notin @('succeeded', 'rolled-back') -or
        [string]$receipt.terminalDigest -notmatch '^[0-9a-f]{64}$') {
        Throw-GsAuthorityError 'DYSON_GSMANAGER_AUTHORITY_RECEIPT_INVALID'
    }
    return $receipt
}

function Get-GsAuthorityCurrentPreflight {
    Assert-GsAuthorityRuntimeQuiescent
    $panel = Get-GsAuthorityTaskImage $script:GsAuthorityPanelTask
    if (-not [bool]$panel.enabled) { Throw-GsAuthorityError 'DYSON_GSMANAGER_AUTHORITY_PANEL_INVALID' }
    $oldStart = Get-GsAuthorityTaskImage $script:GsAuthorityOldStartTask
    $oldStop = Get-GsAuthorityTaskImage $script:GsAuthorityOldStopTask
    $sourceStart = $oldStart; $sourceStop = $oldStop
    if ($script:GsAuthorityPreparedTemplates) {
        $expected = Get-GsAuthorityExpectedRuntimeDescriptors $false
        Assert-GsAuthorityPreparedTask $oldStart $expected.start
        Assert-GsAuthorityPreparedTask $oldStop $expected.stop
        $sourceStart = ConvertTo-GsAuthorityTemplateImage $script:GsAuthorityTemplateBundle.server
        $sourceStop = ConvertTo-GsAuthorityTemplateImage $script:GsAuthorityTemplateBundle.stop
    }
    $startDefinition = Assert-GsAuthorityLegacyTask $sourceStart $script:GsAuthoritySourceStart $ServiceUser
    $stopDefinition = Assert-GsAuthorityLegacyTask $sourceStop $script:GsAuthoritySourceStop $ServiceUser
    $newStart = Get-GsAuthorityTaskImage $script:GsAuthorityNewStartTask -AllowMissing
    $newStop = Get-GsAuthorityTaskImage $script:GsAuthorityNewStopTask -AllowMissing
    if ([bool]$newStart.present -or [bool]$newStop.present) {
        Throw-GsAuthorityError 'DYSON_GSMANAGER_AUTHORITY_TARGET_ALREADY_PRESENT'
    }
    foreach ($privateTarget in @($script:GsAuthorityStartCopy, $script:GsAuthorityStopCopy, $script:GsAuthorityProfilePath)) {
        if (Test-Path -LiteralPath $privateTarget) {
            Throw-GsAuthorityError 'DYSON_GSMANAGER_AUTHORITY_TARGET_ALREADY_PRESENT'
        }
    }
    $envImage = Get-GsAuthorityFileImage $script:GsAuthorityEnvPath
    if (-not [bool]$envImage.present) { Throw-GsAuthorityError 'DYSON_GSMANAGER_AUTHORITY_ENV_INVALID' }
    $envBytes = [Convert]::FromBase64String([string]$envImage.bytesBase64)
    $envUpdate = Get-GsAuthorityEnvUpdate $envBytes
    return [pscustomobject][ordered]@{
        panel = $panel; oldStart = $oldStart; oldStop = $oldStop; newStart = $newStart; newStop = $newStop
        startDefinition = $startDefinition; stopDefinition = $stopDefinition; env = $envImage; envUpdate = $envUpdate
        sourceStart = $sourceStart; sourceStop = $sourceStop
    }
}

function Assert-GsAuthoritySuccessTerminal {
    param([Parameter(Mandatory)]$Intent, [Parameter(Mandatory)]$Receipt)
    Assert-GsAuthorityTargetTask $script:GsAuthorityNewStartTask $script:GsAuthorityStartCopy $Intent.target.startDefinition $ServiceUser
    Assert-GsAuthorityTargetTask $script:GsAuthorityNewStopTask $script:GsAuthorityStopCopy $Intent.target.stopDefinition $ServiceUser
    foreach ($name in @($script:GsAuthorityOldStartTask, $script:GsAuthorityOldStopTask)) {
        if ([bool](Get-GsAuthorityTaskImage $name).enabled) {
            Throw-GsAuthorityError 'DYSON_GSMANAGER_AUTHORITY_TERMINAL_INVALID'
        }
    }
    $env = Get-GsAuthorityFileImage $script:GsAuthorityEnvPath
    if ([string]$env.sha256 -cne [string]$Intent.target.envSha256 -or
        [string](Get-GsAuthorityFileImage $script:GsAuthorityStartCopy).sha256 -cne [string]$Intent.target.startSha256 -or
        [string](Get-GsAuthorityFileImage $script:GsAuthorityStopCopy).sha256 -cne [string]$Intent.target.stopSha256) {
        Throw-GsAuthorityError 'DYSON_GSMANAGER_AUTHORITY_TERMINAL_INVALID'
    }
    $panel = Get-GsAuthorityTaskImage $script:GsAuthorityPanelTask
    if ([bool]$panel.running -ne [bool]$Intent.preimage.panelRunning) {
        Throw-GsAuthorityError 'DYSON_GSMANAGER_AUTHORITY_TERMINAL_INVALID'
    }
    $digest = Get-GsAuthorityTerminalDigest $script:GsAuthorityEnvPath $script:GsAuthorityStartCopy $script:GsAuthorityStopCopy
    if ([string]$Receipt.terminalDigest -cne $digest) {
        Throw-GsAuthorityError 'DYSON_GSMANAGER_AUTHORITY_TERMINAL_INVALID'
    }
}

function Assert-GsAuthorityRolledBackTerminal {
    param([Parameter(Mandatory)]$Intent, [Parameter(Mandatory)]$Receipt)
    foreach ($name in @('oldStart', 'oldStop', 'newStart', 'newStop', 'panel')) {
        $expected = $Intent.preimage.tasks.$name
        $actual = Get-GsAuthorityTaskImage ([string]$expected.taskName) -AllowMissing
        if (-not (Test-GsAuthorityTaskImageEqual $expected $actual)) {
            Throw-GsAuthorityError 'DYSON_GSMANAGER_AUTHORITY_TERMINAL_INVALID'
        }
    }
    foreach ($binding in @(
        @($Intent.preimage.env, $script:GsAuthorityEnvPath),
        @($Intent.preimage.startCopy, $script:GsAuthorityStartCopy),
        @($Intent.preimage.stopCopy, $script:GsAuthorityStopCopy),
        @($Intent.preimage.profile, $script:GsAuthorityProfilePath)
    )) {
        $actual = Get-GsAuthorityFileImage ([string]$binding[1])
        if ([bool]$actual.present -ne [bool]$binding[0].present -or
            ([bool]$actual.present -and [string]$actual.sha256 -cne [string]$binding[0].sha256)) {
            Throw-GsAuthorityError 'DYSON_GSMANAGER_AUTHORITY_TERMINAL_INVALID'
        }
    }
    $panel = Get-GsAuthorityTaskImage $script:GsAuthorityPanelTask
    if ([bool]$panel.running -ne [bool]$Intent.preimage.panelRunning) {
        Throw-GsAuthorityError 'DYSON_GSMANAGER_AUTHORITY_TERMINAL_INVALID'
    }
    $digest = Get-GsAuthorityTerminalDigest $script:GsAuthorityEnvPath $script:GsAuthorityStartCopy $script:GsAuthorityStopCopy
    if ([string]$Receipt.terminalDigest -cne $digest) {
        Throw-GsAuthorityError 'DYSON_GSMANAGER_AUTHORITY_TERMINAL_INVALID'
    }
}

function Enter-GsAuthorityLease {
    param([switch]$Recovery, [AllowNull()]$TerminalReceipt)
    if ($script:GsAuthorityBorrowedLease) {
        Assert-GsAuthorityMutationScope
        return $false
    }
    if ($Recovery) {
        try {
            $candidate = Get-DysonHostMutationLeaseRecoveryCandidate -DataRoot $script:GsAuthorityDataRoot -TimeoutMilliseconds 0
        }
        catch {
            $leaseCode = Get-GsAuthorityErrorCode $_.Exception
            if ($leaseCode -ceq 'DYSON_HOST_MUTATION_LEASE_RECOVERY_NOT_REQUIRED' -and $null -ne $TerminalReceipt) {
                return $false
            }
            throw $_.Exception
        }
        if ([string]$candidate.priorOperation -cne 'gsmanager-authority-isolation' -or
            [string]$candidate.priorRequestId -cne $script:GsAuthorityRequestId) {
            Throw-GsAuthorityError 'DYSON_GSMANAGER_AUTHORITY_RECOVERY_MISMATCH'
        }
        $script:GsAuthorityOwnedLease = Enter-DysonHostMutationLease -DataRoot $script:GsAuthorityDataRoot `
            -Owner 'gsmanager-authority-isolator' -Operation 'gsmanager-authority-isolation' `
            -RequestId $script:GsAuthorityRequestId -OwnerPid $PID -TimeoutMilliseconds 0 `
            -RecoveryPriorInstanceId ([string]$candidate.priorInstanceId) `
            -RecoveryPriorRecordDigest ([string]$candidate.priorRecordDigest)
        return $true
    }
    $script:GsAuthorityOwnedLease = Enter-DysonHostMutationLease -DataRoot $script:GsAuthorityDataRoot `
        -Owner 'gsmanager-authority-isolator' -Operation 'gsmanager-authority-isolation' `
        -RequestId $script:GsAuthorityRequestId -OwnerPid $PID -TimeoutMilliseconds 0
    return $true
}

function Complete-GsAuthorityOwnedLease {
    param([ValidateSet('released', 'abandoned')][string]$State)
    if (-not $script:GsAuthorityBorrowedLease -and $null -ne $script:GsAuthorityOwnedLease -and
        [bool]$script:GsAuthorityOwnedLease.Active) {
        [void](Exit-DysonHostMutationLease -Lease $script:GsAuthorityOwnedLease -State $State)
    }
}

$script:GsAuthorityOwnedLease = $null
$script:GsAuthorityBorrowedLease = $false
$script:GsAuthorityRestoring = $false
$script:GsAuthorityPreparedTemplates = -not [string]::IsNullOrWhiteSpace($PreparedLegacyTemplateRoot)

try {
    if ($script:GsAuthorityPreparedTemplates -ne (-not [string]::IsNullOrWhiteSpace($ExpectedLegacyTemplateSha256))) {
        Throw-GsAuthorityError 'DYSON_GSMANAGER_AUTHORITY_TEMPLATE_ARGUMENT_INVALID'
    }
    $script:GsAuthorityBackend = $Backend
    $script:GsAuthorityProjectRoot = Assert-GsAuthorityPlainDirectory $ProjectRoot
    $dataInput = Assert-GsAuthorityPlainDirectory $DataRoot
    $dataInfo = Get-DysonHostMutationLeasePathInfo -DataRoot $dataInput
    $script:GsAuthorityDataRoot = [string]$dataInfo.CanonicalDataRoot
    $script:GsAuthorityDataRootIdentity = [string]$dataInfo.DataRootIdentity
    $script:GsAuthorityRequestId = $RequestId.ToLowerInvariant()
    $script:GsAuthorityRuntimeBootstrapRoot = Assert-GsAuthorityPlainDirectory $RuntimeBootstrapRoot
    $script:GsAuthorityRuntimeTaskTransactionRoot = Assert-GsAuthorityPlainDirectory $RuntimeTaskTransactionRoot
    $runtimeBootstrapStart = Assert-GsAuthorityPlainFile (Join-Path $script:GsAuthorityRuntimeBootstrapRoot 'Start-DysonServer.ps1')
    $runtimeBootstrapStop = Assert-GsAuthorityPlainFile (Join-Path $script:GsAuthorityRuntimeBootstrapRoot 'Stop-DysonServer.ps1')
    $script:GsAuthorityRuntimeBootstrapStartSha256 = Get-GsAuthoritySha256Bytes ([IO.File]::ReadAllBytes($runtimeBootstrapStart))
    $script:GsAuthorityRuntimeBootstrapStopSha256 = Get-GsAuthoritySha256Bytes ([IO.File]::ReadAllBytes($runtimeBootstrapStop))
    $script:GsAuthoritySourceStart = Assert-GsAuthorityPlainFile (Join-Path $script:GsAuthorityProjectRoot 'ops\start-dyson-server.ps1')
    $script:GsAuthoritySourceStop = Assert-GsAuthorityPlainFile (Join-Path $script:GsAuthorityProjectRoot 'ops\stop-dyson-server.ps1')
    $script:GsAuthorityEnvPath = Assert-GsAuthorityPlainFile (Join-Path $script:GsAuthorityProjectRoot 'manager\gsm3\.env') 1048576
    $startBytes = [IO.File]::ReadAllBytes($script:GsAuthoritySourceStart)
    $stopBytes = [IO.File]::ReadAllBytes($script:GsAuthoritySourceStop)
    $startSha256 = Get-GsAuthoritySha256Bytes $startBytes
    $stopSha256 = Get-GsAuthoritySha256Bytes $stopBytes

    $hasInstance = -not [string]::IsNullOrWhiteSpace($LeaseInstanceId)
    $hasToken = -not [string]::IsNullOrWhiteSpace($LeaseToken)
    if ($hasInstance -ne $hasToken) { Throw-GsAuthorityError 'DYSON_GSMANAGER_AUTHORITY_LEASE_BORROW_INVALID' }
    $script:GsAuthorityBorrowedLease = $hasInstance
    $script:GsAuthorityLeaseInstanceId = $LeaseInstanceId
    $script:GsAuthorityLeaseToken = $LeaseToken

    if ($Backend -ceq 'Windows') {
        $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
        $principal = [Security.Principal.WindowsPrincipal]::new($identity)
        if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
            Throw-GsAuthorityError 'DYSON_GSMANAGER_AUTHORITY_ADMIN_REQUIRED'
        }
    }
    else {
        if ($env:DYSON_GSMANAGER_AUTHORITY_SELFTEST -cne '1' -or [string]::IsNullOrWhiteSpace($ShadowRoot)) {
            Throw-GsAuthorityError 'DYSON_GSMANAGER_AUTHORITY_SHADOW_FORBIDDEN'
        }
        $script:GsAuthorityShadowRoot = Assert-GsAuthorityPlainDirectory $ShadowRoot
        if (-not (Test-Path -LiteralPath (Join-Path $script:GsAuthorityShadowRoot '.dyson-gsmanager-authority-selftest') -PathType Leaf)) {
            Throw-GsAuthorityError 'DYSON_GSMANAGER_AUTHORITY_SHADOW_FORBIDDEN'
        }
        $ConfirmPreference = 'None'
    }

    $authorityRootCandidate = Join-Path $script:GsAuthorityDataRoot 'private\gsmanager-authority'
    $transactionRootCandidate = Join-Path $script:GsAuthorityDataRoot 'private\gsmanager-authority-transactions'
    $profileRootCandidate = Join-Path $script:GsAuthorityDataRoot 'authority-inventory'
    $script:GsAuthorityStartCopy = Join-Path $authorityRootCandidate 'start-dyson-server.ps1'
    $script:GsAuthorityStopCopy = Join-Path $authorityRootCandidate 'stop-dyson-server.ps1'
    $script:GsAuthorityAuthorityRoot = $authorityRootCandidate
    $script:GsAuthorityProfilePath = Join-Path $profileRootCandidate 'authority-profile.json'
    $script:GsAuthorityIntentPath = Join-Path $transactionRootCandidate 'active-intent.json'
    $receiptsCandidate = Join-Path $transactionRootCandidate 'receipts'
    $script:GsAuthorityReceiptPath = Join-Path $receiptsCandidate ($script:GsAuthorityRequestId + '.json')
    $script:GsAuthorityTemplateArchivePath = Join-Path $receiptsCandidate ($script:GsAuthorityRequestId + '.legacy-templates.json')
    if ($script:GsAuthorityPreparedTemplates) {
        $script:GsAuthorityTemplateBundle = Read-GsAuthorityTemplateBundle $PreparedLegacyTemplateRoot $ExpectedLegacyTemplateSha256 `
            -ArchivePath $script:GsAuthorityTemplateArchivePath -UseArchive:($Recover -or (Test-Path -LiteralPath $script:GsAuthorityReceiptPath))
    }
    $binding = [ordered]@{
        requestId = $script:GsAuthorityRequestId
        projectRootIdentity = $script:GsAuthorityProjectRoot.ToUpperInvariant()
        dataRootIdentity = $script:GsAuthorityDataRootIdentity
        runtimeBootstrapIdentity = $script:GsAuthorityRuntimeBootstrapRoot.ToUpperInvariant()
        runtimeBootstrapStartSha256 = $script:GsAuthorityRuntimeBootstrapStartSha256
        runtimeBootstrapStopSha256 = $script:GsAuthorityRuntimeBootstrapStopSha256
        runtimeTaskTransactionRootIdentity = $script:GsAuthorityRuntimeTaskTransactionRoot.ToUpperInvariant()
        serviceUser = $ServiceUser.ToUpperInvariant()
        sourceStartSha256 = $startSha256
        sourceStopSha256 = $stopSha256
        panelTask = $script:GsAuthorityPanelTask
        oldTasks = @($script:GsAuthorityOldStartTask, $script:GsAuthorityOldStopTask)
        previousTasks = @($script:GsAuthorityNewStartTask, $script:GsAuthorityNewStopTask)
    }
    if ($script:GsAuthorityPreparedTemplates) {
        $binding['authoritySource'] = 'reconstructed-template'
        $binding['legacyTemplateSha256'] = $ExpectedLegacyTemplateSha256
    }
    $script:GsAuthorityRequestFingerprint = Get-GsAuthoritySha256Text (ConvertTo-GsAuthorityJson $binding)

    if ($script:GsAuthorityBorrowedLease) { Assert-GsAuthorityMutationScope }

    if ($Recover) {
        $intent = Read-GsAuthorityJson $script:GsAuthorityIntentPath
        Assert-GsAuthorityIntent $intent
        $terminal = Read-GsAuthorityValidatedReceipt $intent -AllowMissing
        $owns = Enter-GsAuthorityLease -Recovery -TerminalReceipt $terminal
        try {
            if ($null -ne $terminal) {
                if ([string]$terminal.status -ceq 'succeeded') { Assert-GsAuthoritySuccessTerminal $intent $terminal }
                else { Assert-GsAuthorityRolledBackTerminal $intent $terminal }
            }
            else {
                Restore-GsAuthorityPreimage $intent
                $digest = Get-GsAuthorityTerminalDigest $script:GsAuthorityEnvPath $script:GsAuthorityStartCopy $script:GsAuthorityStopCopy
                $terminal = New-GsAuthorityReceipt $intent 'rolled-back' $digest
                Write-GsAuthorityJsonNew $script:GsAuthorityReceiptPath $terminal
                Assert-GsAuthorityRolledBackTerminal $intent $terminal
            }
            if ($owns) { Complete-GsAuthorityOwnedLease released }
            Remove-GsAuthorityIntent
            $terminal.reused = $true
            Write-GsAuthorityResult $terminal
            exit 0
        }
        catch {
            if ($owns) { Complete-GsAuthorityOwnedLease abandoned }
            throw $_.Exception
        }
    }

    if (Test-Path -LiteralPath $script:GsAuthorityIntentPath -PathType Leaf) {
        Throw-GsAuthorityError 'DYSON_GSMANAGER_AUTHORITY_RECOVERY_REQUIRED'
    }

    $existing = Read-GsAuthorityJson $script:GsAuthorityReceiptPath -AllowMissing
    if ($null -ne $existing) {
        $owns = Enter-GsAuthorityLease
        try {
            $syntheticIntent = [pscustomobject][ordered]@{
                requestId = $script:GsAuthorityRequestId; requestFingerprint = $script:GsAuthorityRequestFingerprint
            }
            $existing = Read-GsAuthorityValidatedReceipt $syntheticIntent
            if ([string]$existing.status -cne 'succeeded') {
                Throw-GsAuthorityError 'DYSON_GSMANAGER_AUTHORITY_IDEMPOTENCY_CONFLICT'
            }
            $digest = Get-GsAuthorityTerminalDigest $script:GsAuthorityEnvPath $script:GsAuthorityStartCopy $script:GsAuthorityStopCopy
            if ([string]$existing.terminalDigest -cne $digest) {
                Throw-GsAuthorityError 'DYSON_GSMANAGER_AUTHORITY_IDEMPOTENCY_CONFLICT'
            }
            if ($owns) { Complete-GsAuthorityOwnedLease released }
            $existing.reused = $true
            Write-GsAuthorityResult $existing
            exit 0
        }
        catch {
            if ($owns) { Complete-GsAuthorityOwnedLease released }
            throw $_.Exception
        }
    }

    [void](Get-GsAuthorityCurrentPreflight)
    if (-not $PSCmdlet.ShouldProcess('fixed GSManager authority inventory', 'Isolate the legacy runtime task authority')) {
        Write-GsAuthorityResult ([ordered]@{
            protocol = $script:GsAuthorityProtocol; state = 'preview'; dryRun = $true
            requestId = $script:GsAuthorityRequestId; recovery = $false
            panelTask = $script:GsAuthorityPanelTask
            previousServerTask = $script:GsAuthorityNewStartTask
            previousStopTask = $script:GsAuthorityNewStopTask
        })
        exit 0
    }

    $owns = Enter-GsAuthorityLease
    $intent = $null
    $intentPersisted = $false
    $terminalPersisted = $false
    try {
        $preflight = Get-GsAuthorityCurrentPreflight
        $authorityRoot = Protect-GsAuthorityDirectory $authorityRootCandidate $ServiceUser `
            -GrantServiceRead -GrantLocalServiceRead
        $transactionRoot = Protect-GsAuthorityDirectory $transactionRootCandidate $ServiceUser
        [void](Protect-GsAuthorityDirectory $receiptsCandidate $ServiceUser)
        $profileRoot = Protect-GsAuthorityDirectory $profileRootCandidate $ServiceUser -GrantLocalServiceRead
        $script:GsAuthorityStartCopy = Join-Path $authorityRoot 'start-dyson-server.ps1'
        $script:GsAuthorityStopCopy = Join-Path $authorityRoot 'stop-dyson-server.ps1'
        $script:GsAuthorityAuthorityRoot = $authorityRoot
        $script:GsAuthorityProfilePath = Join-Path $profileRoot 'authority-profile.json'
        $script:GsAuthorityIntentPath = Join-Path $transactionRoot 'active-intent.json'
        $script:GsAuthorityReceiptPath = Join-Path $receiptsCandidate ($script:GsAuthorityRequestId + '.json')

        $preimage = [pscustomobject][ordered]@{
            tasks = [pscustomobject][ordered]@{
                oldStart = $preflight.oldStart; oldStop = $preflight.oldStop
                newStart = $preflight.newStart; newStop = $preflight.newStop; panel = $preflight.panel
            }
            panelRunning = [bool]$preflight.panel.running
            env = $preflight.env
            startCopy = Get-GsAuthorityFileImage $script:GsAuthorityStartCopy
            stopCopy = Get-GsAuthorityFileImage $script:GsAuthorityStopCopy
            profile = Get-GsAuthorityFileImage $script:GsAuthorityProfilePath
        }
        $targetStart = New-GsAuthorityTargetImage $preflight.sourceStart $script:GsAuthorityNewStartTask $script:GsAuthorityStartCopy $preflight.startDefinition
        $targetStop = New-GsAuthorityTargetImage $preflight.sourceStop $script:GsAuthorityNewStopTask $script:GsAuthorityStopCopy $preflight.stopDefinition
        $intentTarget = [pscustomobject][ordered]@{
            startSha256 = $startSha256; stopSha256 = $stopSha256; envSha256 = [string]$preflight.envUpdate.sha256
            startDefinition = $preflight.startDefinition; stopDefinition = $preflight.stopDefinition
        }
        if ($script:GsAuthorityPreparedTemplates) {
            $intentTarget | Add-Member -NotePropertyName authoritySource -NotePropertyValue 'reconstructed-template'
            $intentTarget | Add-Member -NotePropertyName legacyTemplates -NotePropertyValue $script:GsAuthorityTemplateBundle
        }
        $intent = [pscustomobject][ordered]@{
            protocol = $script:GsAuthorityProtocol; schemaVersion = 1
            requestId = $script:GsAuthorityRequestId; requestFingerprint = $script:GsAuthorityRequestFingerprint
            dataRootIdentity = $script:GsAuthorityDataRootIdentity
            projectRootIdentity = $script:GsAuthorityProjectRoot.ToUpperInvariant(); serviceUser = $ServiceUser
            runtimeBootstrapIdentity = $script:GsAuthorityRuntimeBootstrapRoot.ToUpperInvariant()
            runtimeTaskTransactionRootIdentity = $script:GsAuthorityRuntimeTaskTransactionRoot.ToUpperInvariant()
            preimageDigest = Get-GsAuthoritySha256Text (ConvertTo-GsAuthorityJson $preimage)
            preimage = $preimage
            targetDigest = Get-GsAuthoritySha256Text (ConvertTo-GsAuthorityJson $intentTarget)
            target = $intentTarget
            createdAt = [DateTime]::UtcNow.ToString('o')
        }
        Write-GsAuthorityJsonNew $script:GsAuthorityIntentPath $intent
        $intentPersisted = $true
        if ($Backend -ceq 'Shadow' -and $env:DYSON_GSMANAGER_AUTHORITY_SELFTEST_FAIL_POINT -ceq 'HardExitBeforeTemplateArchive') { [Environment]::Exit(94) }
        if ($script:GsAuthorityPreparedTemplates) {
            Write-GsAuthorityJsonNew $script:GsAuthorityTemplateArchivePath $script:GsAuthorityTemplateBundle
        }
        if ($Backend -ceq 'Shadow' -and $env:DYSON_GSMANAGER_AUTHORITY_SELFTEST_FAIL_POINT -ceq 'HardExitAfterIntent') { [Environment]::Exit(91) }

        if ([bool]$preflight.panel.running) { Set-GsAuthorityTaskRunning $script:GsAuthorityPanelTask $false }
        if ([bool](Get-GsAuthorityTaskImage $script:GsAuthorityPanelTask).running) {
            Throw-GsAuthorityError 'DYSON_GSMANAGER_AUTHORITY_PANEL_STOP_FAILED'
        }
        Assert-GsAuthorityRuntimeQuiescent

        Write-GsAuthorityBytesAtomic $script:GsAuthorityStartCopy $startBytes
        Write-GsAuthorityBytesAtomic $script:GsAuthorityStopCopy $stopBytes
        if ((Get-GsAuthorityFileImage $script:GsAuthorityStartCopy).sha256 -cne $startSha256 -or
            (Get-GsAuthorityFileImage $script:GsAuthorityStopCopy).sha256 -cne $stopSha256) {
            Throw-GsAuthorityError 'DYSON_GSMANAGER_AUTHORITY_COPY_VERIFY_FAILED'
        }

        Set-GsAuthorityTaskImage $targetStart
        if ($Backend -ceq 'Shadow' -and $env:DYSON_GSMANAGER_AUTHORITY_SELFTEST_FAIL_POINT -ceq 'SecondTaskRegister') {
            Throw-GsAuthorityError 'DYSON_GSMANAGER_AUTHORITY_SCHEDULER_WRITE_FAILED'
        }
        Set-GsAuthorityTaskImage $targetStop
        Assert-GsAuthorityTargetTask $script:GsAuthorityNewStartTask $script:GsAuthorityStartCopy $preflight.startDefinition $ServiceUser
        Assert-GsAuthorityTargetTask $script:GsAuthorityNewStopTask $script:GsAuthorityStopCopy $preflight.stopDefinition $ServiceUser

        if ($Backend -ceq 'Shadow' -and $env:DYSON_GSMANAGER_AUTHORITY_SELFTEST_FAIL_POINT -ceq 'EnvWrite') {
            Throw-GsAuthorityError 'DYSON_GSMANAGER_AUTHORITY_ENV_WRITE_FAILED'
        }
        Write-GsAuthorityBytesAtomic $script:GsAuthorityEnvPath $preflight.envUpdate.bytes
        if ((Get-GsAuthorityFileImage $script:GsAuthorityEnvPath).sha256 -cne [string]$preflight.envUpdate.sha256) {
            Throw-GsAuthorityError 'DYSON_GSMANAGER_AUTHORITY_ENV_WRITE_FAILED'
        }
        if ($Backend -ceq 'Shadow' -and $env:DYSON_GSMANAGER_AUTHORITY_SELFTEST_FAIL_POINT -ceq 'HardExitAfterEnv') { [Environment]::Exit(92) }

        if (-not $script:GsAuthorityPreparedTemplates) {
            Disable-GsAuthorityLegacyTask $script:GsAuthorityOldStartTask
            Disable-GsAuthorityLegacyTask $script:GsAuthorityOldStopTask
        }
        else {
            foreach ($name in @('oldStart', 'oldStop')) {
                $before = $intent.preimage.tasks.$name
                if (-not (Test-GsAuthorityTaskImageEqual $before (Get-GsAuthorityTaskImage $before.taskName))) {
                    Throw-GsAuthorityError 'DYSON_GSMANAGER_AUTHORITY_PREPARED_TASK_CHANGED'
                }
            }
        }
        if ([bool]$preflight.panel.running) { Set-GsAuthorityTaskRunning $script:GsAuthorityPanelTask $true }
        $panelAfter = Get-GsAuthorityTaskImage $script:GsAuthorityPanelTask
        if ([bool]$panelAfter.running -ne [bool]$preflight.panel.running) {
            Throw-GsAuthorityError 'DYSON_GSMANAGER_AUTHORITY_PANEL_RESTART_FAILED'
        }

        $profile = New-GsAuthorityProfile $intent
        Write-GsAuthorityBytesAtomic $script:GsAuthorityProfilePath `
            ([Text.UTF8Encoding]::new($false).GetBytes((ConvertTo-GsAuthorityJson $profile) + "`n"))
        Protect-GsAuthorityProfileFile $script:GsAuthorityProfilePath

        $terminalDigest = Get-GsAuthorityTerminalDigest $script:GsAuthorityEnvPath $script:GsAuthorityStartCopy $script:GsAuthorityStopCopy
        $receipt = New-GsAuthorityReceipt $intent 'succeeded' $terminalDigest
        Write-GsAuthorityJsonNew $script:GsAuthorityReceiptPath $receipt
        $terminalPersisted = $true
        if ($Backend -ceq 'Shadow' -and $env:DYSON_GSMANAGER_AUTHORITY_SELFTEST_FAIL_POINT -ceq 'HardExitAfterReceipt') { [Environment]::Exit(93) }
        Assert-GsAuthoritySuccessTerminal $intent $receipt
        if ($owns) { Complete-GsAuthorityOwnedLease released }
        Remove-GsAuthorityIntent
        Write-GsAuthorityResult $receipt
        exit 0
    }
    catch {
        $failure = $_.Exception
        if ($terminalPersisted) {
            if ($owns) { Complete-GsAuthorityOwnedLease abandoned }
            Throw-GsAuthorityError 'DYSON_GSMANAGER_AUTHORITY_RECOVERY_REQUIRED'
        }
        if ($intentPersisted -and $null -ne $intent) {
            try {
                Restore-GsAuthorityPreimage $intent
                $digest = Get-GsAuthorityTerminalDigest $script:GsAuthorityEnvPath $script:GsAuthorityStartCopy $script:GsAuthorityStopCopy
                $rolledBack = New-GsAuthorityReceipt $intent 'rolled-back' $digest
                Write-GsAuthorityJsonNew $script:GsAuthorityReceiptPath $rolledBack
                Assert-GsAuthorityRolledBackTerminal $intent $rolledBack
                if ($owns) { Complete-GsAuthorityOwnedLease released }
                Remove-GsAuthorityIntent
            }
            catch {
                if ($owns) { Complete-GsAuthorityOwnedLease abandoned }
                Throw-GsAuthorityError 'DYSON_GSMANAGER_AUTHORITY_RECOVERY_REQUIRED'
            }
            Throw-GsAuthorityError 'DYSON_GSMANAGER_AUTHORITY_FAILED_ROLLED_BACK'
        }
        if ($owns) { Complete-GsAuthorityOwnedLease released }
        throw $failure
    }
}
catch {
    $code = Get-GsAuthorityErrorCode $_.Exception
    Write-GsAuthorityResult ([ordered]@{ ok = $false; error = [ordered]@{ code = $code } })
    exit 1
}
