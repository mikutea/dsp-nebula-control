[CmdletBinding()]
param()

Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)

if ($PSVersionTable.PSVersion.Major -ne 5 -or [string]$PSVersionTable.PSEdition -cne 'Desktop') {
    throw 'DYSON_QUALIFICATION_V2_SELFTEST_REQUIRES_WINDOWS_POWERSHELL_5_1'
}

$executorPath = Join-Path $PSScriptRoot 'Qualification.ExecutorV2.ps1'
$protocolPath = Join-Path $PSScriptRoot 'Qualification.ProtocolV2.ps1'
$adapterPath = Join-Path $PSScriptRoot 'Qualification.ProductionAdaptersV2.ps1'
$fakePath = Join-Path $PSScriptRoot 'Qualification.FakeV2.ps1'
$requestSchemaPath = Join-Path $PSScriptRoot 'qualification-action-request.v2.schema.json'
. $executorPath
. $fakePath
. $adapterPath

$testRoot = Join-Path ([IO.Path]::GetTempPath()) ('dyson-qualification-v2-selftest-' + [guid]::NewGuid().ToString('N'))
$targetIdentity = 'sha256:' + ('a' * 64)
$now = [datetimeoffset]::UtcNow
$oldFakeEnvironment = [Environment]::GetEnvironmentVariable(
    $script:DysonQualificationV2FakeEnvironmentName,
    [EnvironmentVariableTarget]::Process
)
$oldProductionEnvironment = [Environment]::GetEnvironmentVariable(
    $script:DysonQualificationV2ProductionEnvironmentName,
    [EnvironmentVariableTarget]::Process
)
$tests = New-Object 'System.Collections.Generic.List[object]'
$stage = 'initialize'
$head = $script:DysonQualificationV2ZeroDigest

function Assert-QualificationV2SelfTest {
    param([Parameter(Mandatory)][bool]$Condition, [Parameter(Mandatory)][string]$Message)
    if (-not $Condition) { throw ('DYSON_QUALIFICATION_V2_SELFTEST_FAILED: ' + $Message) }
}

function Add-QualificationV2SelfTestResult {
    param([Parameter(Mandatory)][string]$Name)
    $tests.Add([pscustomobject][ordered]@{ name = $Name; status = 'passed' }) | Out-Null
}

function Assert-QualificationV2Code {
    param([Parameter(Mandatory)][scriptblock]$Operation, [Parameter(Mandatory)][string]$ExpectedCode)
    $observed = $null
    try { & $Operation | Out-Null }
    catch { $observed = Get-DysonQualificationV2ErrorCode -Exception $_.Exception }
    Assert-QualificationV2SelfTest -Condition ($observed -ceq $ExpectedCode) `
        -Message ('expected ' + $ExpectedCode + ', observed ' + [string]$observed)
}

function Copy-QualificationV2SelfTestValue {
    param([Parameter(Mandatory)]$Value)
    return ConvertTo-DysonQualificationV2CanonicalJson -Value $Value | ConvertFrom-Json
}

function New-QualificationV2SelfTestProfile {
    param([Parameter(Mandatory)][string]$Root)
    $volumeRoot = [IO.Path]::GetPathRoot($Root)
    return [pscustomobject][ordered]@{
        protocol = $script:DysonQualificationV2ProfileProtocol
        schemaVersion = 2
        profileId = '11111111-2222-4333-8444-555555555555'
        profileLabel = 'qualification-fixture'
        enabled = $true
        targetIdentity = $targetIdentity
        expiresAtUtc = ConvertTo-DysonQualificationV2Utc -Value $now.AddDays(2)
        stateRoot = (Join-Path $Root 'state')
        protectedRoots = @(
            (Join-Path $Root 'protected-system'),
            (Join-Path $Root 'protected-app'),
            (Join-Path $Root 'protected-data'),
            (Join-Path $Root 'protected-save'),
            (Join-Path $Root 'protected-backup')
        )
        actions = [pscustomobject][ordered]@{
            controlPlaneRestart = [pscustomobject][ordered]@{
                enabled = $true
                targetId = 'control-plane-primary'
                executablePath = (Join-Path $Root 'control.exe')
                executableSha256 = 'sha256:' + ('b' * 64)
                commandLineSha256 = 'sha256:' + ('1' * 64)
                releaseSha256 = 'sha256:' + ('2' * 64)
                runtimeSha256 = 'sha256:' + ('3' * 64)
                pidFilePath = (Join-Path $Root 'control.pid')
                startTaskName = '\DysonFixture\Control'
                startTaskSha256 = 'sha256:' + ('d' * 64)
                readinessFilePath = (Join-Path $Root 'control.ready')
                timeoutSeconds = 60
            }
            dspCrashRecovery = [pscustomobject][ordered]@{
                enabled = $true
                targetId = 'dsp-primary'
                executablePath = (Join-Path $Root 'game.exe')
                executableSha256 = 'sha256:' + ('c' * 64)
                commandLineSha256 = 'sha256:' + ('4' * 64)
                releaseSha256 = 'sha256:' + ('5' * 64)
                runtimeSha256 = 'sha256:' + ('6' * 64)
                pidFilePath = (Join-Path $Root 'game.pid')
                startTaskName = '\DysonFixture\GameRecovery'
                startTaskSha256 = 'sha256:' + ('e' * 64)
                readinessFilePath = (Join-Path $Root 'game.ready')
                timeoutSeconds = 60
            }
            storageInterruption = [pscustomobject][ordered]@{
                enabled = $true
                targetId = 'qualified-storage'
                dependencyKind = 'smb-global-mapping'
                localPath = 'Q:'
                remotePath = ([string]::Concat('\','\','storage.example.com','\','qualified'))
                restoreTaskName = '\DysonFixture\StorageRecovery'
                restoreTaskSha256 = 'sha256:' + ('f' * 64)
                maximumInterruptionSeconds = 10
                timeoutSeconds = 60
            }
            diskPressure = [pscustomobject][ordered]@{
                enabled = $true
                targetId = 'qualification-disposable'
                directoryPath = (Join-Path $Root 'disposable')
                volumeRoot = $volumeRoot
                markerValue = 'DYSON_QUALIFICATION_DISPOSABLE_V2'
                maximumAllocationBytes = 2097152
                minimumFreeBytes = 10737418240
                maximumUsedPercent = 85
                maximumHoldSeconds = 5
                timeoutSeconds = 60
            }
        }
    }
}

function New-QualificationV2SelfTestRequest {
    param(
        [Parameter(Mandatory)]$Profile,
        [Parameter(Mandatory)][string]$Action,
        [Parameter(Mandatory)][ValidateSet('preview','execute')][string]$Mode,
        [Parameter(Mandatory)][ValidateSet('production','fake')][string]$Scope,
        [Parameter(Mandatory)]$Parameters,
        [string]$Predecessor = $head
    )
    $previewRequest = New-DysonQualificationV2Request -Profile $Profile `
        -RequestId ([guid]::NewGuid().ToString('D')) -ApprovalId ([guid]::NewGuid().ToString('D')) `
        -Action $Action -Mode preview -ExecutionScope $Scope -NowUtc $now `
        -ProtectionPoint $script:protectionPoint -Parameters $Parameters `
        -PredecessorReceiptSha256 $Predecessor
    if ($Mode -ceq 'preview') { return $previewRequest }
    $confirmation = Get-DysonQualificationV2ConfirmationPhrase -ExecutionScope $Scope `
        -Action $Action -ProfileId ([string]$Profile.profileId) `
        -RequestId ([string]$previewRequest.requestId) -PreviewSha256 ([string]$previewRequest.previewSha256)
    return ConvertTo-DysonQualificationV2ExecuteRequest -PreviewRequest $previewRequest `
        -Profile $Profile -ConfirmationPhrase $confirmation -NowUtc $now
}

function Invoke-QualificationV2Fake {
    param(
        [Parameter(Mandatory)]$Request,
        [switch]$Resume,
        [ValidateSet('None','HardExitAfterIntent','Timeout','EffectThenExit','CompensationFailure',
            'IntentBeforeWrite','IntentMidWrite','IntentAfterFlushBeforeRename','IntentAfterRename',
            'ReceiptBeforeWrite','ReceiptMidWrite','ReceiptAfterFlushBeforeRename','ReceiptAfterRename')]
        [string]$Injection = 'None'
    )
    return Invoke-DysonQualificationActionV2 -Request $Request -Backend Fake -Profile $script:profile `
        -FakeRoot $testRoot -Resume:$Resume -NowUtc $now -Injection $Injection
}

function Complete-QualificationV2Receipt {
    param([Parameter(Mandatory)]$Result)
    $script:head = [string]$Result.receipt.receiptSha256
    return $Result
}

function New-QualificationV2IsolatedContext {
    param([Parameter(Mandatory)][string]$Name)
    $root = Join-Path $testRoot $Name
    [void][IO.Directory]::CreateDirectory($root)
    [void](Initialize-DysonQualificationV2FakeFixture -FakeRoot $root -TargetIdentity $targetIdentity)
    $contextProfile = New-QualificationV2SelfTestProfile -Root $root
    [void](Assert-DysonQualificationV2Profile -Profile $contextProfile -NowUtc $now)
    $contextProtection = New-DysonQualificationV2FixtureProtectionPoint -Profile $contextProfile `
        -ProtectionPointId ([guid]::NewGuid().ToString('D')) -NowUtc $now
    return [pscustomobject]@{
        root = $root
        profile = $contextProfile
        protectionPoint = $contextProtection
        head = $script:DysonQualificationV2ZeroDigest
    }
}

function New-QualificationV2ContextRequest {
    param(
        [Parameter(Mandatory)]$Context,
        [Parameter(Mandatory)][string]$Action,
        [Parameter(Mandatory)]$Parameters,
        [string]$Predecessor = $script:DysonQualificationV2ZeroDigest,
        [ValidateSet('fake','production')][string]$Scope = 'fake'
    )
    $previewRequest = New-DysonQualificationV2Request -Profile $Context.profile `
        -RequestId ([guid]::NewGuid().ToString('D')) -ApprovalId ([guid]::NewGuid().ToString('D')) `
        -Action $Action -Mode preview -ExecutionScope $Scope -NowUtc $now `
        -ProtectionPoint $Context.protectionPoint -Parameters $Parameters `
        -PredecessorReceiptSha256 $Predecessor
    $confirmation = Get-DysonQualificationV2ConfirmationPhrase -ExecutionScope $Scope -Action $Action `
        -ProfileId ([string]$Context.profile.profileId) -RequestId ([string]$previewRequest.requestId) `
        -PreviewSha256 ([string]$previewRequest.previewSha256)
    return ConvertTo-DysonQualificationV2ExecuteRequest -PreviewRequest $previewRequest `
        -Profile $Context.profile -ConfirmationPhrase $confirmation -NowUtc $now
}

function Invoke-QualificationV2Context {
    param(
        [Parameter(Mandatory)]$Context,
        [Parameter(Mandatory)]$Request,
        [switch]$Resume,
        [string]$Injection = 'None'
    )
    return Invoke-DysonQualificationActionV2 -Request $Request -Backend Fake -Profile $Context.profile `
        -FakeRoot $Context.root -Resume:$Resume -NowUtc $now -Injection $Injection
}

try {
    [void][IO.Directory]::CreateDirectory($testRoot)
    [void](Initialize-DysonQualificationV2FakeFixture -FakeRoot $testRoot -TargetIdentity $targetIdentity)
    $script:profile = New-QualificationV2SelfTestProfile -Root $testRoot
    [void](Assert-DysonQualificationV2Profile -Profile $profile -NowUtc $now)
    $script:protectionPoint = New-DysonQualificationV2FixtureProtectionPoint -Profile $profile `
        -ProtectionPointId '22222222-3333-4444-8555-666666666666' -NowUtc $now

    $stage = 'v2-parser-and-contract'
    foreach ($path in @($protocolPath,$executorPath,$adapterPath,$fakePath)) {
        $tokens = $null
        $parseErrors = $null
        [void][Management.Automation.Language.Parser]::ParseFile($path, [ref]$tokens, [ref]$parseErrors)
        Assert-QualificationV2SelfTest -Condition (@($parseErrors).Count -eq 0) `
            -Message ('v2 script did not parse: ' + [IO.Path]::GetFileName($path))
    }
    foreach ($action in $script:DysonQualificationV2Actions) {
        $contract = Get-DysonQualificationV2AdapterContract -Action $action
        Assert-QualificationV2SelfTest -Condition (-not [string]::IsNullOrWhiteSpace([string]$contract.adapterId)) `
            -Message ('adapter contract missing: ' + $action)
    }
    $requestSchema = [IO.File]::ReadAllText($requestSchemaPath, [Text.Encoding]::UTF8) | ConvertFrom-Json -ErrorAction Stop
    Assert-QualificationV2SelfTest -Condition (
        [string]$requestSchema.properties.protocol.const -ceq $script:DysonQualificationV2RequestProtocol -and
        [bool]$requestSchema.additionalProperties -eq $false -and
        @($requestSchema.properties.action.enum).Count -eq 4
    ) -Message 'v2 public request schema drifted from the runtime protocol'
    Add-QualificationV2SelfTestResult $stage

    $stage = 'preview-read-only-and-bound'
    $fakeStatePath = Get-DysonQualificationV2FakeStatePath -FakeRoot $testRoot
    $beforePreview = [IO.File]::ReadAllBytes($fakeStatePath)
    $previewRequest = New-QualificationV2SelfTestRequest -Profile $profile -Action 'control-plane-restart' `
        -Mode preview -Scope fake -Parameters ([pscustomobject][ordered]@{ expectedPid = 4101 })
    $preview = Invoke-QualificationV2Fake -Request $previewRequest
    $afterPreview = [IO.File]::ReadAllBytes($fakeStatePath)
    Assert-QualificationV2SelfTest -Condition ($preview.status -ceq 'preview' -and
        [string]$preview.previewSha256 -ceq [string]$previewRequest.previewSha256 -and
        -not $preview.executed -and -not $preview.productionChanged -and
        [Linq.Enumerable]::SequenceEqual($beforePreview, $afterPreview) -and
        -not (Test-Path -LiteralPath (Join-Path $profile.stateRoot 'qualification-v2'))) `
        -Message 'preview mutated state or did not bind its fingerprint'
    Add-QualificationV2SelfTestResult $stage

    $stage = 'execution-default-disabled'
    $executeDisabled = New-QualificationV2SelfTestRequest -Profile $profile -Action 'control-plane-restart' `
        -Mode execute -Scope fake -Parameters ([pscustomobject][ordered]@{ expectedPid = 4101 })
    [Environment]::SetEnvironmentVariable($script:DysonQualificationV2FakeEnvironmentName, $null,
        [EnvironmentVariableTarget]::Process)
    Assert-QualificationV2Code -Operation { Invoke-QualificationV2Fake -Request $executeDisabled } `
        -ExpectedCode 'DYSON_QUALIFICATION_V2_FAKE_EXECUTION_DISABLED'
    Add-QualificationV2SelfTestResult $stage

    $stage = 'production-default-disabled'
    $productionRequest = New-QualificationV2SelfTestRequest -Profile $profile -Action 'control-plane-restart' `
        -Mode execute -Scope production -Parameters ([pscustomobject][ordered]@{ expectedPid = 4101 })
    $profilePath = Join-Path $testRoot 'production-profile.json'
    Write-DysonQualificationV2FakeText -Path $profilePath `
        -Text ((ConvertTo-DysonQualificationV2CanonicalJson -Value $profile) + "`n") -CreateNew
    [Environment]::SetEnvironmentVariable($script:DysonQualificationV2ProductionEnvironmentName, $null,
        [EnvironmentVariableTarget]::Process)
    Assert-QualificationV2Code -Operation {
        Invoke-DysonQualificationActionV2 -Request $productionRequest -Backend Production -ProfilePath $profilePath
    } -ExpectedCode 'DYSON_QUALIFICATION_V2_PRODUCTION_EXECUTION_DISABLED'
    Add-QualificationV2SelfTestResult $stage

    $stage = 'production-process-command-line-bound'
    $identityExecutable = Join-Path $testRoot 'identity-fixture.exe'
    Write-DysonQualificationV2FakeText -Path $identityExecutable -Text "fixture executable`n" -CreateNew
    $identityExecutableSha = Get-DysonQualificationV2FileSha256 -Path $identityExecutable
    $identityCommandLine = 'node.exe C:\Example\Dyson\controlled-entry.js --service'
    $identityCommandLineSha = Get-DysonQualificationV2Sha256 -Value $identityCommandLine
    $originalGetProcessFunction = Get-Item -LiteralPath Function:\Get-Process -ErrorAction SilentlyContinue
    $originalGetCimFunction = Get-Item -LiteralPath Function:\Get-CimInstance -ErrorAction SilentlyContinue
    try {
        $script:identityFixtureExecutable = $identityExecutable
        $script:identityFixtureCommandLine = $identityCommandLine
        Set-Item -LiteralPath Function:\Get-Process -Value {
            [CmdletBinding()] param([int]$Id)
            return [pscustomobject]@{
                Id = $Id
                MainModule = [pscustomobject]@{ FileName = $script:identityFixtureExecutable }
                StartTime = [datetime]::UtcNow.AddMinutes(-1)
            }
        }
        Set-Item -LiteralPath Function:\Get-CimInstance -Value {
            [CmdletBinding()] param([string]$ClassName,[string]$Filter)
            return [pscustomobject]@{ ProcessId = 6201; CommandLine = $script:identityFixtureCommandLine }
        }
        $identityProcess = Get-DysonQualificationV2ExactProcess -ProcessId 6201 `
            -ExecutablePath $identityExecutable -ExecutableSha256 $identityExecutableSha `
            -CommandLineSha256 $identityCommandLineSha
        Assert-QualificationV2SelfTest -Condition ([int]$identityProcess.Id -eq 6201) `
            -Message 'controlled command-line identity did not accept its exact instance'
        Assert-QualificationV2Code -Operation {
            Get-DysonQualificationV2ExactProcess -ProcessId 6201 -ExecutablePath $identityExecutable `
                -ExecutableSha256 $identityExecutableSha -CommandLineSha256 ('sha256:' + ('9' * 64))
        } -ExpectedCode 'DYSON_QUALIFICATION_V2_EXACT_PROCESS_MISMATCH'
    }
    finally {
        if ($null -ne $originalGetProcessFunction) {
            Set-Item -LiteralPath Function:\Get-Process -Value $originalGetProcessFunction.ScriptBlock
        }
        else { Remove-Item -LiteralPath Function:\Get-Process -ErrorAction SilentlyContinue }
        if ($null -ne $originalGetCimFunction) {
            Set-Item -LiteralPath Function:\Get-CimInstance -Value $originalGetCimFunction.ScriptBlock
        }
        else { Remove-Item -LiteralPath Function:\Get-CimInstance -ErrorAction SilentlyContinue }
    }
    Add-QualificationV2SelfTestResult $stage

    $stage = 'production-pid-file-double-check-before-stop'
    $originalReadPid = (Get-Item -LiteralPath Function:\Read-DysonQualificationV2PidFile).ScriptBlock
    $originalExactProcess = (Get-Item -LiteralPath Function:\Get-DysonQualificationV2ExactProcess).ScriptBlock
    $originalStopProcessFunction = Get-Item -LiteralPath Function:\Stop-Process -ErrorAction SilentlyContinue
    try {
        $script:pidFixtureReads = New-Object 'System.Collections.Generic.Queue[int]'
        $script:pidFixtureProcessLookups = 0
        $script:pidFixtureStops = 0
        Set-Item -LiteralPath Function:\Read-DysonQualificationV2PidFile -Value {
            param([string]$Path)
            return $script:pidFixtureReads.Dequeue()
        }
        Set-Item -LiteralPath Function:\Get-DysonQualificationV2ExactProcess -Value {
            param([int]$ProcessId,[string]$ExecutablePath,[string]$ExecutableSha256,[string]$CommandLineSha256,[switch]$AllowMissing)
            $script:pidFixtureProcessLookups++
            return [pscustomobject]@{ Id = $ProcessId }
        }
        Set-Item -LiteralPath Function:\Stop-Process -Value {
            [CmdletBinding()] param($InputObject,[switch]$Force)
            $script:pidFixtureStops++
        }
        foreach ($pidAction in @('control-plane-restart','dsp-crash-recovery')) {
            $script:pidFixtureReads.Clear()
            $script:pidFixtureReads.Enqueue(999999)
            $pidRequest = [pscustomobject]@{
                action = $pidAction
                parameters = [pscustomobject]@{ expectedPid = 6201 }
            }
            $pidConfiguration = if ($pidAction -ceq 'control-plane-restart') {
                $profile.actions.controlPlaneRestart
            }
            else { $profile.actions.dspCrashRecovery }
            Assert-QualificationV2Code -Operation {
                Invoke-DysonQualificationV2ProductionExecute -Request $pidRequest `
                    -Configuration $pidConfiguration -DeadlineUtc $now.AddMinutes(1) -Intent ([pscustomobject]@{})
            } -ExpectedCode 'DYSON_QUALIFICATION_V2_PID_FILE_MISMATCH'
        }
        Assert-QualificationV2SelfTest -Condition ($script:pidFixtureProcessLookups -eq 0 -and $script:pidFixtureStops -eq 0) `
            -Message 'PID-file mismatch reached process capture or Stop-Process'
        $script:pidFixtureReads.Enqueue(6201)
        $script:pidFixtureReads.Enqueue(999999)
        $toctouRequest = [pscustomobject]@{
            action = 'control-plane-restart'
            parameters = [pscustomobject]@{ expectedPid = 6201 }
        }
        Assert-QualificationV2Code -Operation {
            Invoke-DysonQualificationV2ProductionExecute -Request $toctouRequest `
                -Configuration $profile.actions.controlPlaneRestart -DeadlineUtc $now.AddMinutes(1) `
                -Intent ([pscustomobject]@{})
        } -ExpectedCode 'DYSON_QUALIFICATION_V2_PID_FILE_MISMATCH'
        Assert-QualificationV2SelfTest -Condition ($script:pidFixtureProcessLookups -eq 1 -and $script:pidFixtureStops -eq 0) `
            -Message 'PID-file drift between capture and Stop-Process was not rejected'
    }
    finally {
        Set-Item -LiteralPath Function:\Read-DysonQualificationV2PidFile -Value $originalReadPid
        Set-Item -LiteralPath Function:\Get-DysonQualificationV2ExactProcess -Value $originalExactProcess
        if ($null -ne $originalStopProcessFunction) {
            Set-Item -LiteralPath Function:\Stop-Process -Value $originalStopProcessFunction.ScriptBlock
        }
        else { Remove-Item -LiteralPath Function:\Stop-Process -ErrorAction SilentlyContinue }
    }
    Add-QualificationV2SelfTestResult $stage

    $stage = 'production-readiness-content-bound'
    $readinessContext = New-QualificationV2IsolatedContext -Name 'readiness-content'
    $readinessRequest = New-QualificationV2ContextRequest -Context $readinessContext `
        -Action 'control-plane-restart' -Parameters ([pscustomobject][ordered]@{ expectedPid = 4101 })
    $readinessIntent = New-DysonQualificationV2Intent -Request $readinessRequest `
        -Profile $readinessContext.profile -Sequence 1 -NowUtc $now -TimeoutSeconds 60
    $readinessConfiguration = $readinessContext.profile.actions.controlPlaneRestart
    $readinessProcess = [pscustomobject]@{ Id = 6301; StartTime = $now.AddSeconds(-2).UtcDateTime }
    $readinessPath = [string]$readinessConfiguration.readinessFilePath
    $readinessRecord = [pscustomobject][ordered]@{
        protocol = 'DYSON_QUALIFICATION_PROCESS_READINESS_V2'
        schemaVersion = 2
        targetId = [string]$readinessConfiguration.targetId
        requestId = [string]$readinessRequest.requestId
        processId = [int]$readinessProcess.Id
        processStartedAtUtc = ConvertTo-DysonQualificationV2Utc -Value ([datetimeoffset]$readinessProcess.StartTime)
        executableSha256 = [string]$readinessConfiguration.executableSha256
        commandLineSha256 = [string]$readinessConfiguration.commandLineSha256
        releaseSha256 = [string]$readinessConfiguration.releaseSha256
        runtimeSha256 = [string]$readinessConfiguration.runtimeSha256
        sequence = [int64]$readinessIntent.sequence
        intentSha256 = [string]$readinessIntent.intentSha256
        writtenAtUtc = ConvertTo-DysonQualificationV2Utc -Value $now
        readinessSha256 = $null
    }
    $readinessRecord.readinessSha256 = Get-DysonQualificationV2ObjectDigest -Value (
        Get-DysonQualificationV2UnsignedValue -Value $readinessRecord -DigestProperty 'readinessSha256'
    )
    Write-DysonQualificationV2FakeText -Path $readinessPath `
        -Text ((ConvertTo-DysonQualificationV2CanonicalJson -Value $readinessRecord) + "`n")
    Assert-QualificationV2SelfTest -Condition (Test-DysonQualificationV2ReadinessFile -Path $readinessPath `
        -Request $readinessRequest -Configuration $readinessConfiguration -Process $readinessProcess `
        -Intent $readinessIntent -NowUtc $now) -Message 'strict readiness receipt rejected exact content'
    Write-DysonQualificationV2FakeText -Path $readinessPath -Text "unrelated readiness text`n"
    Assert-QualificationV2SelfTest -Condition (-not (Test-DysonQualificationV2ReadinessFile -Path $readinessPath `
        -Request $readinessRequest -Configuration $readinessConfiguration -Process $readinessProcess `
        -Intent $readinessIntent -NowUtc $now)) -Message 'unbound readiness text was accepted'
    $readinessRecord.releaseSha256 = 'sha256:' + ('7' * 64)
    $readinessRecord.readinessSha256 = Get-DysonQualificationV2ObjectDigest -Value (
        Get-DysonQualificationV2UnsignedValue -Value $readinessRecord -DigestProperty 'readinessSha256'
    )
    Write-DysonQualificationV2FakeText -Path $readinessPath `
        -Text ((ConvertTo-DysonQualificationV2CanonicalJson -Value $readinessRecord) + "`n")
    Assert-QualificationV2SelfTest -Condition (-not (Test-DysonQualificationV2ReadinessFile -Path $readinessPath `
        -Request $readinessRequest -Configuration $readinessConfiguration -Process $readinessProcess `
        -Intent $readinessIntent -NowUtc $now)) -Message 'self-valid readiness with wrong release identity was accepted'
    Add-QualificationV2SelfTestResult $stage

    $stage = 'production-smb-observation-fails-closed'
    $originalSmbFunction = Get-Item -LiteralPath Function:\Get-SmbGlobalMapping -ErrorAction SilentlyContinue
    $originalStartExactTask = (Get-Item -LiteralPath Function:\Start-DysonQualificationV2ExactScheduledTask).ScriptBlock
    try {
        $script:smbFixtureMode = 'throw'
        $script:smbFixtureQueries = 0
        $script:smbFixtureRestoreStarts = 0
        Set-Item -LiteralPath Function:\Get-SmbGlobalMapping -Value {
            [CmdletBinding()] param([string]$LocalPath)
            $script:smbFixtureQueries++
            switch ($script:smbFixtureMode) {
                'throw' { throw 'fixture provider failure' }
                'missing' { return }
                'missing-then-throw' {
                    if ($script:smbFixtureQueries -eq 1) { return }
                    throw 'fixture provider failure while polling'
                }
                'mismatch' {
                    return [pscustomobject]@{
                        LocalPath = $LocalPath
                        RemotePath = [string]::Concat('\','\','invalid.example','\','wrong')
                    }
                }
            }
        }
        Set-Item -LiteralPath Function:\Start-DysonQualificationV2ExactScheduledTask -Value {
            param([string]$TaskIdentity,[string]$ExpectedSha256)
            $script:smbFixtureRestoreStarts++
        }
        $smbConfiguration = $profile.actions.storageInterruption
        $smbRequest = [pscustomobject]@{
            action = 'storage-interruption'
            parameters = [pscustomobject]@{ durationSeconds = 1 }
        }
        Assert-QualificationV2Code -Operation {
            Get-DysonQualificationV2Mapping -Configuration $smbConfiguration -AllowMissing
        } -ExpectedCode 'DYSON_QUALIFICATION_V2_STORAGE_OBSERVATION_FAILED'
        Assert-QualificationV2Code -Operation {
            # This stage runs well after the deterministic fixture timestamp was
            # captured.  A deadline derived from that timestamp can already be
            # expired on a real Windows host and would test deadline handling
            # instead of the intended provider-observation failure.
            Wait-DysonQualificationV2MappingRestored -Configuration $smbConfiguration `
                -DeadlineUtc ([datetimeoffset]::UtcNow.AddSeconds(5))
        } -ExpectedCode 'DYSON_QUALIFICATION_V2_STORAGE_OBSERVATION_FAILED'
        Assert-QualificationV2Code -Operation {
            Invoke-DysonQualificationV2ProductionInspect -Request $smbRequest `
                -Configuration $smbConfiguration -Intent ([pscustomobject]@{})
        } -ExpectedCode 'DYSON_QUALIFICATION_V2_STORAGE_OBSERVATION_FAILED'
        $smbCompensation = Invoke-DysonQualificationV2ProductionCompensate -Request $smbRequest `
            -Configuration $smbConfiguration -DeadlineUtc ([datetimeoffset]::UtcNow.AddSeconds(5)) `
            -Intent ([pscustomobject]@{})
        Assert-QualificationV2SelfTest -Condition (-not [bool]$smbCompensation.success -and
            [string]$smbCompensation.outcomeCode -ceq 'STORAGE_OBSERVATION_FAILED' -and
            $script:smbFixtureRestoreStarts -eq 0) `
            -Message 'SMB observation failure started recovery or reported success'
        $script:smbFixtureMode = 'missing-then-throw'
        $script:smbFixtureQueries = 0
        $pollFailureCompensation = Invoke-DysonQualificationV2ProductionCompensate -Request $smbRequest `
            -Configuration $smbConfiguration -DeadlineUtc ([datetimeoffset]::UtcNow.AddSeconds(5)) `
            -Intent ([pscustomobject]@{})
        Assert-QualificationV2SelfTest -Condition (-not [bool]$pollFailureCompensation.success -and
            [string]$pollFailureCompensation.outcomeCode -ceq 'STORAGE_OBSERVATION_FAILED' -and
            $script:smbFixtureRestoreStarts -eq 1) `
            -Message 'SMB poll failure was reported as successful or lost its observation classification'
        $script:smbFixtureMode = 'missing'
        $script:smbFixtureQueries = 0
        $missingMapping = Get-DysonQualificationV2Mapping -Configuration $smbConfiguration -AllowMissing
        Assert-QualificationV2SelfTest -Condition ($null -eq $missingMapping) `
            -Message 'successful zero-result SMB query was not distinguished from provider failure'
        $script:smbFixtureMode = 'mismatch'
        Assert-QualificationV2Code -Operation {
            Get-DysonQualificationV2Mapping -Configuration $smbConfiguration -AllowMissing
        } -ExpectedCode 'DYSON_QUALIFICATION_V2_STORAGE_DEPENDENCY_MISMATCH'
    }
    finally {
        if ($null -ne $originalSmbFunction) {
            Set-Item -LiteralPath Function:\Get-SmbGlobalMapping -Value $originalSmbFunction.ScriptBlock
        }
        else { Remove-Item -LiteralPath Function:\Get-SmbGlobalMapping -ErrorAction SilentlyContinue }
        Set-Item -LiteralPath Function:\Start-DysonQualificationV2ExactScheduledTask -Value $originalStartExactTask
    }
    Add-QualificationV2SelfTestResult $stage

    $stage = 'production-protection-evidence-is-private-and-exact'
    $protectionContext = New-QualificationV2IsolatedContext -Name 'private-protection'
    $protectionPaths = Get-DysonQualificationV2StorePaths -Profile $protectionContext.profile -Initialize
    $privateEvidenceDirectory = Join-Path $protectionPaths.store 'private-protection-points'
    [void][IO.Directory]::CreateDirectory($privateEvidenceDirectory)
    $privateEvidenceApprovedSids = @(
        [Security.Principal.WindowsIdentity]::GetCurrent().User,
        (New-Object Security.Principal.SecurityIdentifier('S-1-5-18')),
        (New-Object Security.Principal.SecurityIdentifier('S-1-5-32-544'))
    )
    $newPrivateEvidenceAcl = {
        $strictAcl = New-Object Security.AccessControl.DirectorySecurity
        $strictAcl.SetAccessRuleProtection($true, $false)
        foreach ($principalSid in $privateEvidenceApprovedSids) {
            $accessRule = New-Object Security.AccessControl.FileSystemAccessRule(
                $principalSid,
                [Security.AccessControl.FileSystemRights]::FullControl,
                ([Security.AccessControl.InheritanceFlags]::ContainerInherit -bor
                    [Security.AccessControl.InheritanceFlags]::ObjectInherit),
                [Security.AccessControl.PropagationFlags]::None,
                [Security.AccessControl.AccessControlType]::Allow
            )
            [void]$strictAcl.AddAccessRule($accessRule)
        }
        return $strictAcl
    }
    $privateEvidenceAcl = & $newPrivateEvidenceAcl
    # Use the .NET ACL API so this fixture remains independent of PowerShell's
    # module auto-loading state (npm-launched Windows PowerShell can have a
    # deliberately reduced PSModulePath).
    ([IO.DirectoryInfo]::new($privateEvidenceDirectory)).SetAccessControl($privateEvidenceAcl)
    $saveDataPath = Join-Path ([string]$protectionContext.profile.protectedRoots[3]) 'qualification-fixture.dsv'
    $serverDataPath = Join-Path ([string]$protectionContext.profile.protectedRoots[3]) 'qualification-fixture.server'
    $attestationPath = Join-Path ([string]$protectionContext.profile.protectedRoots[4]) 'qualification-attestation.json'
    Write-DysonQualificationV2FakeText -Path $saveDataPath -Text "fixture save data`n" -CreateNew
    Write-DysonQualificationV2FakeText -Path $serverDataPath -Text "fixture server data`n" -CreateNew
    Write-DysonQualificationV2FakeText -Path $attestationPath -Text "{`"fixture`":true}`n" -CreateNew
    $saveDataSha = Get-DysonQualificationV2FileSha256 -Path $saveDataPath
    $serverDataSha = Get-DysonQualificationV2FileSha256 -Path $serverDataPath
    $attestationSha = Get-DysonQualificationV2FileSha256 -Path $attestationPath
    $pairSha = Get-DysonQualificationV2ObjectDigest -Value ([pscustomobject][ordered]@{
        protocol = 'DYSON_QUALIFICATION_SAVE_PAIR_DIGEST_V2'
        saveDataSha256 = $saveDataSha
        serverDataSha256 = $serverDataSha
    })
    $privateProtectionPointId = [guid]::NewGuid().ToString('D')
    $protectionContext.protectionPoint = [pscustomobject][ordered]@{
        protocol = $script:DysonQualificationV2ProtectionProtocol
        schemaVersion = 2
        protectionPointId = $privateProtectionPointId
        targetIdentity = [string]$protectionContext.profile.targetIdentity
        createdAtUtc = ConvertTo-DysonQualificationV2Utc -Value $now
        expiresAtUtc = ConvertTo-DysonQualificationV2Utc -Value $now.AddMinutes(20)
        savePairSha256 = $pairSha
        evidenceSha256 = $attestationSha
    }
    $privateEvidenceRequest = New-QualificationV2ContextRequest -Context $protectionContext `
        -Action 'control-plane-restart' -Parameters ([pscustomobject][ordered]@{ expectedPid = 4101 }) `
        -Scope production
    $privateEvidenceRecord = [pscustomobject][ordered]@{
        protocol = 'DYSON_QUALIFICATION_PRIVATE_PROTECTION_EVIDENCE_V2'
        schemaVersion = 2
        protectionPointId = $privateProtectionPointId
        profileId = [string]$protectionContext.profile.profileId
        profileSha256 = Get-DysonQualificationV2ProfileDigest -Profile $protectionContext.profile
        targetIdentity = [string]$protectionContext.profile.targetIdentity
        requestId = [string]$privateEvidenceRequest.requestId
        requestDigest = Get-DysonQualificationV2RequestDigest -Request $privateEvidenceRequest
        approvalId = [string]$privateEvidenceRequest.approvalId
        action = [string]$privateEvidenceRequest.action
        actionTargetId = [string]$privateEvidenceRequest.actionTargetId
        executionScope = 'production'
        previewSha256 = [string]$privateEvidenceRequest.previewSha256
        createdAtUtc = [string]$privateEvidenceRequest.protectionPoint.createdAtUtc
        expiresAtUtc = [string]$privateEvidenceRequest.protectionPoint.expiresAtUtc
        saveDataPath = $saveDataPath
        saveDataSha256 = $saveDataSha
        serverDataPath = $serverDataPath
        serverDataSha256 = $serverDataSha
        savePairSha256 = $pairSha
        evidencePath = $attestationPath
        evidenceSha256 = $attestationSha
        recordSha256 = $null
    }
    $privateEvidenceRecord.recordSha256 = Get-DysonQualificationV2ObjectDigest -Value (
        Get-DysonQualificationV2UnsignedValue -Value $privateEvidenceRecord -DigestProperty 'recordSha256'
    )
    $privateEvidenceRecordPath = Join-Path $privateEvidenceDirectory ($privateProtectionPointId + '.evidence.json')
    Write-DysonQualificationV2FakeText -Path $privateEvidenceRecordPath `
        -Text ((ConvertTo-DysonQualificationV2CanonicalJson -Value $privateEvidenceRecord) + "`n") -CreateNew
    $stage = 'p4-acl'
    [void](Assert-DysonQualificationV2PrivateEvidenceAcl -Path $privateEvidenceDirectory)
    $unapprovedSid = New-Object Security.Principal.SecurityIdentifier(
        'S-1-5-21-111111111-222222222-333333333-1001'
    )
    $unapprovedWriteRule = New-Object Security.AccessControl.FileSystemAccessRule(
        $unapprovedSid,
        [Security.AccessControl.FileSystemRights]::FullControl,
        ([Security.AccessControl.InheritanceFlags]::ContainerInherit -bor
            [Security.AccessControl.InheritanceFlags]::ObjectInherit),
        [Security.AccessControl.PropagationFlags]::None,
        [Security.AccessControl.AccessControlType]::Allow
    )
    $aclWithUnapprovedWriter = ([IO.DirectoryInfo]::new($privateEvidenceDirectory)).GetAccessControl()
    [void]$aclWithUnapprovedWriter.AddAccessRule($unapprovedWriteRule)
    ([IO.DirectoryInfo]::new($privateEvidenceDirectory)).SetAccessControl($aclWithUnapprovedWriter)
    Assert-QualificationV2Code -Operation {
        Assert-DysonQualificationV2PrivateEvidenceAcl -Path $privateEvidenceDirectory
    } -ExpectedCode 'DYSON_QUALIFICATION_V2_PROTECTION_EVIDENCE_INVALID'
    $restoredPrivateEvidenceAcl = & $newPrivateEvidenceAcl
    ([IO.DirectoryInfo]::new($privateEvidenceDirectory)).SetAccessControl($restoredPrivateEvidenceAcl)
    $unapprovedReadRule = New-Object Security.AccessControl.FileSystemAccessRule(
        $unapprovedSid,
        [Security.AccessControl.FileSystemRights]::ReadAndExecute,
        ([Security.AccessControl.InheritanceFlags]::ContainerInherit -bor
            [Security.AccessControl.InheritanceFlags]::ObjectInherit),
        [Security.AccessControl.PropagationFlags]::None,
        [Security.AccessControl.AccessControlType]::Allow
    )
    $aclWithUnapprovedReader = ([IO.DirectoryInfo]::new($privateEvidenceDirectory)).GetAccessControl()
    [void]$aclWithUnapprovedReader.AddAccessRule($unapprovedReadRule)
    ([IO.DirectoryInfo]::new($privateEvidenceDirectory)).SetAccessControl($aclWithUnapprovedReader)
    [void](Assert-DysonQualificationV2PrivateEvidenceAcl -Path $privateEvidenceDirectory)
    $restoredPrivateEvidenceAcl = & $newPrivateEvidenceAcl
    ([IO.DirectoryInfo]::new($privateEvidenceDirectory)).SetAccessControl($restoredPrivateEvidenceAcl)
    $unprotectedEvidenceAcl = ([IO.DirectoryInfo]::new($privateEvidenceDirectory)).GetAccessControl()
    $unprotectedEvidenceAcl.SetAccessRuleProtection($false, $true)
    ([IO.DirectoryInfo]::new($privateEvidenceDirectory)).SetAccessControl($unprotectedEvidenceAcl)
    Assert-QualificationV2Code -Operation {
        Assert-DysonQualificationV2PrivateEvidenceAcl -Path $privateEvidenceDirectory
    } -ExpectedCode 'DYSON_QUALIFICATION_V2_PROTECTION_EVIDENCE_INVALID'
    $restoredPrivateEvidenceAcl = & $newPrivateEvidenceAcl
    ([IO.DirectoryInfo]::new($privateEvidenceDirectory)).SetAccessControl($restoredPrivateEvidenceAcl)
    [void](Assert-DysonQualificationV2PrivateEvidenceAcl -Path $privateEvidenceDirectory)
    $stage = 'p4-artifact'
    [void](Assert-DysonQualificationV2PrivateEvidenceArtifact -Path $saveDataPath `
        -ExpectedSha256 $saveDataSha -Profile $protectionContext.profile)
    [void](Assert-DysonQualificationV2PrivateEvidenceArtifact -Path $serverDataPath `
        -ExpectedSha256 $serverDataSha -Profile $protectionContext.profile)
    [void](Assert-DysonQualificationV2PrivateEvidenceArtifact -Path $attestationPath `
        -ExpectedSha256 $attestationSha -Profile $protectionContext.profile)
    $stage = 'p4-valid'
    Assert-QualificationV2SelfTest -Condition (Assert-DysonQualificationV2ProductionProtectionEvidence `
        -Paths $protectionPaths -Profile $protectionContext.profile -Request $privateEvidenceRequest -NowUtc $now) `
        -Message 'exact private protection evidence was rejected'
    $productionExecutorSource = [IO.File]::ReadAllText($executorPath, [Text.Encoding]::UTF8)
    $fakeExecutorSource = [IO.File]::ReadAllText($fakePath, [Text.Encoding]::UTF8)
    Assert-QualificationV2SelfTest -Condition (
        -not $productionExecutorSource.Contains('function New-DysonQualificationV2FixtureProtectionPoint') -and
        $fakeExecutorSource.Contains('function New-DysonQualificationV2FixtureProtectionPoint')
    ) -Message 'fixture protection constructor escaped the fake-only boundary'
    $tamperedEvidenceRecord = Copy-QualificationV2SelfTestValue -Value $privateEvidenceRecord
    $tamperedEvidenceRecord.requestDigest = $script:DysonQualificationV2ZeroDigest
    $tamperedEvidenceRecord.recordSha256 = Get-DysonQualificationV2ObjectDigest -Value (
        Get-DysonQualificationV2UnsignedValue -Value $tamperedEvidenceRecord -DigestProperty 'recordSha256'
    )
    Write-DysonQualificationV2FakeText -Path $privateEvidenceRecordPath `
        -Text ((ConvertTo-DysonQualificationV2CanonicalJson -Value $tamperedEvidenceRecord) + "`n")
    $stage = 'p4-tamper'
    Assert-QualificationV2Code -Operation {
        Assert-DysonQualificationV2ProductionProtectionEvidence -Paths $protectionPaths `
            -Profile $protectionContext.profile -Request $privateEvidenceRequest -NowUtc $now
    } -ExpectedCode 'DYSON_QUALIFICATION_V2_PROTECTION_EVIDENCE_INVALID'
    Write-DysonQualificationV2FakeText -Path $privateEvidenceRecordPath `
        -Text ((ConvertTo-DysonQualificationV2CanonicalJson -Value $privateEvidenceRecord) + "`n")
    [IO.File]::Delete($attestationPath)
    $stage = 'p4-missing'
    Assert-QualificationV2Code -Operation {
        Assert-DysonQualificationV2ProductionProtectionEvidence -Paths $protectionPaths `
            -Profile $protectionContext.profile -Request $privateEvidenceRequest -NowUtc $now
    } -ExpectedCode 'DYSON_QUALIFICATION_V2_PROTECTION_EVIDENCE_INVALID'
    $stage = 'production-protection-evidence-is-private-and-exact'
    Add-QualificationV2SelfTestResult $stage

    [Environment]::SetEnvironmentVariable(
        $script:DysonQualificationV2FakeEnvironmentName,
        $script:DysonQualificationV2FakeEnvironmentValue,
        [EnvironmentVariableTarget]::Process
    )

    $stage = 'strict-request-and-confirmation'
    $unconfirmed = New-DysonQualificationV2Request -Profile $profile `
        -RequestId ([guid]::NewGuid().ToString('D')) -ApprovalId ([guid]::NewGuid().ToString('D')) `
        -Action 'control-plane-restart' -Mode execute -ExecutionScope fake -NowUtc $now `
        -ProtectionPoint $protectionPoint -Parameters ([pscustomobject][ordered]@{ expectedPid = 4101 })
    Assert-QualificationV2Code -Operation { Invoke-QualificationV2Fake -Request $unconfirmed } `
        -ExpectedCode 'DYSON_QUALIFICATION_V2_CONFIRMATION_INVALID'
    $wrongConfirmation = Copy-QualificationV2SelfTestValue -Value $executeDisabled
    $wrongConfirmation.confirmationPhrase = 'EXECUTE DYSON QUALIFICATION SHADOW CONTROL-PLANE-RESTART'
    Assert-QualificationV2Code -Operation { Invoke-QualificationV2Fake -Request $wrongConfirmation } `
        -ExpectedCode 'DYSON_QUALIFICATION_V2_CONFIRMATION_INVALID'
    $wrongPreviewBinding = Copy-QualificationV2SelfTestValue -Value $executeDisabled
    $wrongPreviewBinding.parameters.expectedPid = 4102
    Assert-QualificationV2Code -Operation { Invoke-QualificationV2Fake -Request $wrongPreviewBinding } `
        -ExpectedCode 'DYSON_QUALIFICATION_V2_PREVIEW_BINDING_INVALID'
    $extraField = Copy-QualificationV2SelfTestValue -Value $executeDisabled
    $extraField.parameters | Add-Member -NotePropertyName command -NotePropertyValue 'anything'
    $extraField.previewSha256 = Get-DysonQualificationV2PreviewDigest -Request $extraField
    Assert-QualificationV2Code -Operation { Invoke-QualificationV2Fake -Request $extraField } `
        -ExpectedCode 'DYSON_QUALIFICATION_V2_ACTION_BOUNDS_INVALID'
    Add-QualificationV2SelfTestResult $stage

    $stage = 'control-plane-exact-target'
    $controlRequest = New-QualificationV2SelfTestRequest -Profile $profile -Action 'control-plane-restart' `
        -Mode execute -Scope fake -Parameters ([pscustomobject][ordered]@{ expectedPid = 4101 })
    $beforeControl = Read-DysonQualificationV2FakeState -FakeRoot $testRoot
    $control = Complete-QualificationV2Receipt -Result (Invoke-QualificationV2Fake -Request $controlRequest)
    $afterControl = Read-DysonQualificationV2FakeState -FakeRoot $testRoot
    Assert-QualificationV2SelfTest -Condition ([string]$control.receipt.status -ceq 'passed' -and
        [int]$afterControl.controlPid -ne [int]$beforeControl.controlPid -and
        [int]$afterControl.dspPid -eq [int]$beforeControl.dspPid -and
        [int]$afterControl.otherProcessGeneration -eq [int]$beforeControl.otherProcessGeneration) `
        -Message 'control-plane adapter changed an unapproved process'
    Add-QualificationV2SelfTestResult $stage

    $stage = 'idempotent-replay-and-collision'
    $controlReplay = Invoke-QualificationV2Fake -Request $controlRequest
    $afterReplay = Read-DysonQualificationV2FakeState -FakeRoot $testRoot
    Assert-QualificationV2SelfTest -Condition ($controlReplay.reused -and
        [int]$afterReplay.actionCounts.controlPlaneRestart -eq 1) `
        -Message 'exact replay repeated control-plane mutation'
    $collision = Copy-QualificationV2SelfTestValue -Value $controlRequest
    $collision.parameters.expectedPid = 9999
    $collision.previewSha256 = Get-DysonQualificationV2PreviewDigest -Request $collision
    $collision.confirmationPhrase = Get-DysonQualificationV2ConfirmationPhrase -ExecutionScope fake `
        -Action 'control-plane-restart' -ProfileId ([string]$profile.profileId) `
        -RequestId ([string]$collision.requestId) -PreviewSha256 ([string]$collision.previewSha256)
    Assert-QualificationV2Code -Operation { Invoke-QualificationV2Fake -Request $collision } `
        -ExpectedCode 'DYSON_QUALIFICATION_V2_REQUEST_COLLISION'
    Add-QualificationV2SelfTestResult $stage

    $stage = 'receipt-replay-rejects-orphan-receipt'
    $orphanContext = New-QualificationV2IsolatedContext -Name 'orphan-receipt'
    $orphanRequest = New-QualificationV2ContextRequest -Context $orphanContext `
        -Action 'control-plane-restart' -Parameters ([pscustomobject][ordered]@{ expectedPid = 4101 })
    $orphanResult = Invoke-QualificationV2Context -Context $orphanContext -Request $orphanRequest
    $orphanPaths = Get-DysonQualificationV2StorePaths -Profile $orphanContext.profile
    $orphanIntentPath = Get-DysonQualificationV2IntentPath -Paths $orphanPaths `
        -RequestId ([string]$orphanRequest.requestId)
    [IO.File]::Delete($orphanIntentPath)
    Assert-QualificationV2Code -Operation {
        Invoke-QualificationV2Context -Context $orphanContext -Request $orphanRequest
    } -ExpectedCode 'DYSON_QUALIFICATION_V2_RECEIPT_CHAIN_INVALID'
    Add-QualificationV2SelfTestResult $stage

    $stage = 'receipt-replay-rejects-bad-predecessor'
    $predecessorContext = New-QualificationV2IsolatedContext -Name 'bad-predecessor'
    $firstPredecessorRequest = New-QualificationV2ContextRequest -Context $predecessorContext `
        -Action 'control-plane-restart' -Parameters ([pscustomobject][ordered]@{ expectedPid = 4101 })
    $firstPredecessorResult = Invoke-QualificationV2Context -Context $predecessorContext `
        -Request $firstPredecessorRequest
    $predecessorState = Read-DysonQualificationV2FakeState -FakeRoot $predecessorContext.root
    $secondPredecessorRequest = New-QualificationV2ContextRequest -Context $predecessorContext `
        -Action 'dsp-crash-recovery' -Parameters ([pscustomobject][ordered]@{ expectedPid = [int]$predecessorState.dspPid }) `
        -Predecessor ([string]$firstPredecessorResult.receipt.receiptSha256)
    [void](Invoke-QualificationV2Context -Context $predecessorContext -Request $secondPredecessorRequest)
    $predecessorPaths = Get-DysonQualificationV2StorePaths -Profile $predecessorContext.profile
    $secondReceiptPath = Get-DysonQualificationV2ReceiptPath -Paths $predecessorPaths `
        -RequestId ([string]$secondPredecessorRequest.requestId)
    $badPredecessorReceipt = [IO.File]::ReadAllText($secondReceiptPath, [Text.Encoding]::UTF8) | ConvertFrom-Json
    $badPredecessorReceipt.predecessorReceiptSha256 = $script:DysonQualificationV2ZeroDigest
    $badPredecessorReceipt.receiptSha256 = Get-DysonQualificationV2ObjectDigest -Value (
        Get-DysonQualificationV2UnsignedValue -Value $badPredecessorReceipt -DigestProperty 'receiptSha256'
    )
    Write-DysonQualificationV2FakeText -Path $secondReceiptPath `
        -Text ((ConvertTo-DysonQualificationV2CanonicalJson -Value $badPredecessorReceipt) + "`n")
    Assert-QualificationV2Code -Operation {
        Invoke-QualificationV2Context -Context $predecessorContext -Request $secondPredecessorRequest
    } -ExpectedCode 'DYSON_QUALIFICATION_V2_RECEIPT_CHAIN_INVALID'
    Add-QualificationV2SelfTestResult $stage

    $stage = 'receipt-replay-rejects-intent-sha-mismatch'
    $intentBindingContext = New-QualificationV2IsolatedContext -Name 'intent-binding'
    $intentBindingRequest = New-QualificationV2ContextRequest -Context $intentBindingContext `
        -Action 'control-plane-restart' -Parameters ([pscustomobject][ordered]@{ expectedPid = 4101 })
    [void](Invoke-QualificationV2Context -Context $intentBindingContext -Request $intentBindingRequest)
    $intentBindingPaths = Get-DysonQualificationV2StorePaths -Profile $intentBindingContext.profile
    $intentBindingPath = Get-DysonQualificationV2IntentPath -Paths $intentBindingPaths `
        -RequestId ([string]$intentBindingRequest.requestId)
    $badBoundIntent = [IO.File]::ReadAllText($intentBindingPath, [Text.Encoding]::UTF8) | ConvertFrom-Json
    $badBoundIntent.actionTargetId = 'fixture-other-target'
    $badBoundIntent.intentSha256 = Get-DysonQualificationV2ObjectDigest -Value (
        Get-DysonQualificationV2UnsignedValue -Value $badBoundIntent -DigestProperty 'intentSha256'
    )
    Write-DysonQualificationV2FakeText -Path $intentBindingPath `
        -Text ((ConvertTo-DysonQualificationV2CanonicalJson -Value $badBoundIntent) + "`n")
    Assert-QualificationV2Code -Operation {
        Invoke-QualificationV2Context -Context $intentBindingContext -Request $intentBindingRequest
    } -ExpectedCode 'DYSON_QUALIFICATION_V2_RECEIPT_CHAIN_INVALID'
    Add-QualificationV2SelfTestResult $stage

    $stage = 'dsp-exact-pid-only'
    $dspBefore = Read-DysonQualificationV2FakeState -FakeRoot $testRoot
    $dspRequest = New-QualificationV2SelfTestRequest -Profile $profile -Action 'dsp-crash-recovery' `
        -Mode execute -Scope fake -Parameters ([pscustomobject][ordered]@{ expectedPid = [int]$dspBefore.dspPid })
    $dsp = Complete-QualificationV2Receipt -Result (Invoke-QualificationV2Fake -Request $dspRequest)
    $dspAfter = Read-DysonQualificationV2FakeState -FakeRoot $testRoot
    Assert-QualificationV2SelfTest -Condition ([string]$dsp.receipt.status -ceq 'passed' -and
        [int]$dspAfter.dspPid -ne [int]$dspBefore.dspPid -and
        [int]$dspAfter.controlPid -eq [int]$dspBefore.controlPid -and
        [int]$dspAfter.otherProcessGeneration -eq [int]$dspBefore.otherProcessGeneration) `
        -Message 'DSP adapter did not remain bound to the exact PID'
    Add-QualificationV2SelfTestResult $stage

    $stage = 'storage-bounded-auto-recovery'
    $storageRequest = New-QualificationV2SelfTestRequest -Profile $profile -Action 'storage-interruption' `
        -Mode execute -Scope fake -Parameters ([pscustomobject][ordered]@{ durationSeconds = 2 })
    $storage = Complete-QualificationV2Receipt -Result (Invoke-QualificationV2Fake -Request $storageRequest)
    $storageState = Read-DysonQualificationV2FakeState -FakeRoot $testRoot
    Assert-QualificationV2SelfTest -Condition ([string]$storage.receipt.status -ceq 'passed' -and
        [bool]$storageState.storageAvailable -and [int]$storageState.networkMutationCount -eq 0 -and
        [int]$storageState.saveMutationCount -eq 0) `
        -Message 'storage adapter did not restore only its fixed dependency'
    Add-QualificationV2SelfTestResult $stage

    $stage = 'disk-pressure-exact-cleanup'
    $diskRequest = New-QualificationV2SelfTestRequest -Profile $profile -Action 'disk-pressure' `
        -Mode execute -Scope fake -Parameters ([pscustomobject][ordered]@{ allocationBytes = 1048576; holdSeconds = 1 })
    $disk = Complete-QualificationV2Receipt -Result (Invoke-QualificationV2Fake -Request $diskRequest)
    $diskState = Read-DysonQualificationV2FakeState -FakeRoot $testRoot
    Assert-QualificationV2SelfTest -Condition ([string]$disk.receipt.status -ceq 'passed' -and
        -not [bool]$diskState.pressureFilePresent -and [int]$diskState.otherVolumeGeneration -eq 1 -and
        [int]$diskState.broadPathMutationCount -eq 0 -and [int]$diskState.saveMutationCount -eq 0) `
        -Message 'disk adapter did not clean only its exact disposable allocation'
    Add-QualificationV2SelfTestResult $stage

    $stage = 'hard-exit-intent-resume-without-replay'
    $hardState = Read-DysonQualificationV2FakeState -FakeRoot $testRoot
    $hardRequest = New-QualificationV2SelfTestRequest -Profile $profile -Action 'control-plane-restart' `
        -Mode execute -Scope fake -Parameters ([pscustomobject][ordered]@{ expectedPid = [int]$hardState.controlPid })
    Assert-QualificationV2Code -Operation {
        Invoke-QualificationV2Fake -Request $hardRequest -Injection HardExitAfterIntent
    } -ExpectedCode 'DYSON_QUALIFICATION_V2_FAKE_INTENT_EXIT'
    Assert-QualificationV2Code -Operation { Invoke-QualificationV2Fake -Request $hardRequest } `
        -ExpectedCode 'DYSON_QUALIFICATION_V2_RESUME_REQUIRED'
    $hardPaths = Get-DysonQualificationV2StorePaths -Profile $profile
    $hardIntentPath = Get-DysonQualificationV2IntentPath -Paths $hardPaths -RequestId ([string]$hardRequest.requestId)
    $hardIntentText = [IO.File]::ReadAllText($hardIntentPath, [Text.Encoding]::UTF8)
    $tamperedIntent = $hardIntentText | ConvertFrom-Json
    $tamperedIntent.actionTargetId = 'dsp-primary'
    $tamperedIntent.intentSha256 = Get-DysonQualificationV2ObjectDigest -Value (
        Get-DysonQualificationV2UnsignedValue -Value $tamperedIntent -DigestProperty 'intentSha256'
    )
    Write-DysonQualificationV2FakeText -Path $hardIntentPath `
        -Text ((ConvertTo-DysonQualificationV2CanonicalJson -Value $tamperedIntent) + "`n")
    Assert-QualificationV2Code -Operation { Invoke-QualificationV2Fake -Request $hardRequest -Resume } `
        -ExpectedCode 'DYSON_QUALIFICATION_V2_REQUEST_COLLISION'
    Write-DysonQualificationV2FakeText -Path $hardIntentPath -Text $hardIntentText
    $hardResume = Complete-QualificationV2Receipt -Result (Invoke-QualificationV2Fake -Request $hardRequest -Resume)
    $hardAfter = Read-DysonQualificationV2FakeState -FakeRoot $testRoot
    Assert-QualificationV2SelfTest -Condition ([string]$hardResume.receipt.status -ceq 'compensated' -and
        [int]$hardAfter.controlPid -eq [int]$hardState.controlPid -and
        [int]$hardAfter.actionCounts.controlPlaneRestart -eq 1) `
        -Message 'resume replayed an action after intent-only interruption'
    Add-QualificationV2SelfTestResult $stage

    $stage = 'effect-exit-inspection-resume'
    $effectState = Read-DysonQualificationV2FakeState -FakeRoot $testRoot
    $effectRequest = New-QualificationV2SelfTestRequest -Profile $profile -Action 'dsp-crash-recovery' `
        -Mode execute -Scope fake -Parameters ([pscustomobject][ordered]@{ expectedPid = [int]$effectState.dspPid })
    Assert-QualificationV2Code -Operation {
        Invoke-QualificationV2Fake -Request $effectRequest -Injection EffectThenExit
    } -ExpectedCode 'DYSON_QUALIFICATION_V2_FAKE_EFFECT_EXIT'
    $effectResume = Complete-QualificationV2Receipt -Result (Invoke-QualificationV2Fake -Request $effectRequest -Resume)
    $effectAfter = Read-DysonQualificationV2FakeState -FakeRoot $testRoot
    Assert-QualificationV2SelfTest -Condition ([string]$effectResume.receipt.status -ceq 'passed' -and
        [int]$effectAfter.actionCounts.dspCrashRecovery -eq 2) `
        -Message 'inspection resume did not recognize the already completed exact DSP action'
    Add-QualificationV2SelfTestResult $stage

    $stage = 'global-orphan-intent-blocks-different-request'
    $globalOrphanContext = New-QualificationV2IsolatedContext -Name 'global-orphan-intent'
    $globalOrphanInitial = Read-DysonQualificationV2FakeState -FakeRoot $globalOrphanContext.root
    $globalOrphanRequest = New-QualificationV2ContextRequest -Context $globalOrphanContext `
        -Action 'control-plane-restart' `
        -Parameters ([pscustomobject][ordered]@{ expectedPid = [int]$globalOrphanInitial.controlPid })
    Assert-QualificationV2Code -Operation {
        Invoke-QualificationV2Context -Context $globalOrphanContext -Request $globalOrphanRequest `
            -Injection EffectThenExit
    } -ExpectedCode 'DYSON_QUALIFICATION_V2_FAKE_EFFECT_EXIT'
    $globalOrphanAfterFirst = Read-DysonQualificationV2FakeState -FakeRoot $globalOrphanContext.root
    $differentRequest = New-QualificationV2ContextRequest -Context $globalOrphanContext `
        -Action 'dsp-crash-recovery' `
        -Parameters ([pscustomobject][ordered]@{ expectedPid = [int]$globalOrphanAfterFirst.dspPid })
    Assert-QualificationV2Code -Operation {
        Invoke-QualificationV2Context -Context $globalOrphanContext -Request $differentRequest
    } -ExpectedCode 'DYSON_QUALIFICATION_V2_MANUAL_RECOVERY_REQUIRED'
    $globalOrphanAfterBlocked = Read-DysonQualificationV2FakeState -FakeRoot $globalOrphanContext.root
    Assert-QualificationV2SelfTest -Condition (
        [int]$globalOrphanAfterBlocked.actionCounts.controlPlaneRestart -eq 1 -and
        [int]$globalOrphanAfterBlocked.actionCounts.dspCrashRecovery -eq 0
    ) -Message 'a different request executed while an orphan intent required recovery'
    $globalOrphanResume = Invoke-QualificationV2Context -Context $globalOrphanContext `
        -Request $globalOrphanRequest -Resume
    Assert-QualificationV2SelfTest -Condition (
        [string]$globalOrphanResume.receipt.status -ceq 'passed'
    ) -Message 'the exact orphan intent could not be resumed after blocking a different request'
    Add-QualificationV2SelfTestResult $stage

    $stage = 'interrupted-storage-compensation'
    $storageExit = New-QualificationV2SelfTestRequest -Profile $profile -Action 'storage-interruption' `
        -Mode execute -Scope fake -Parameters ([pscustomobject][ordered]@{ durationSeconds = 2 })
    Assert-QualificationV2Code -Operation {
        Invoke-QualificationV2Fake -Request $storageExit -Injection EffectThenExit
    } -ExpectedCode 'DYSON_QUALIFICATION_V2_FAKE_EFFECT_EXIT'
    $storageResume = Complete-QualificationV2Receipt -Result (Invoke-QualificationV2Fake -Request $storageExit -Resume)
    $storageRecovered = Read-DysonQualificationV2FakeState -FakeRoot $testRoot
    Assert-QualificationV2SelfTest -Condition ([string]$storageResume.receipt.status -ceq 'compensated' -and
        [bool]$storageRecovered.storageAvailable -and [int]$storageRecovered.actionCounts.storageInterruption -eq 2) `
        -Message 'storage interruption did not auto-compensate without replay'
    Add-QualificationV2SelfTestResult $stage

    $stage = 'interrupted-disk-exact-compensation'
    $diskExit = New-QualificationV2SelfTestRequest -Profile $profile -Action 'disk-pressure' `
        -Mode execute -Scope fake -Parameters ([pscustomobject][ordered]@{ allocationBytes = 1048576; holdSeconds = 1 })
    Assert-QualificationV2Code -Operation {
        Invoke-QualificationV2Fake -Request $diskExit -Injection EffectThenExit
    } -ExpectedCode 'DYSON_QUALIFICATION_V2_FAKE_EFFECT_EXIT'
    $diskResume = Complete-QualificationV2Receipt -Result (Invoke-QualificationV2Fake -Request $diskExit -Resume)
    $diskRecovered = Read-DysonQualificationV2FakeState -FakeRoot $testRoot
    Assert-QualificationV2SelfTest -Condition ([string]$diskResume.receipt.status -ceq 'compensated' -and
        -not [bool]$diskRecovered.pressureFilePresent -and [int]$diskRecovered.otherVolumeGeneration -eq 1) `
        -Message 'disk compensation escaped the exact request allocation'
    Add-QualificationV2SelfTestResult $stage

    $stage = 'timeout-compensation'
    $timeoutState = Read-DysonQualificationV2FakeState -FakeRoot $testRoot
    $timeoutRequest = New-QualificationV2SelfTestRequest -Profile $profile -Action 'control-plane-restart' `
        -Mode execute -Scope fake -Parameters ([pscustomobject][ordered]@{ expectedPid = [int]$timeoutState.controlPid })
    $timeoutResult = Complete-QualificationV2Receipt -Result (
        Invoke-QualificationV2Fake -Request $timeoutRequest -Injection Timeout
    )
    Assert-QualificationV2SelfTest -Condition ([string]$timeoutResult.receipt.status -ceq 'compensated' -and
        [string]$timeoutResult.receipt.compensation.status -ceq 'passed') `
        -Message 'timeout did not enter bounded compensation'
    Add-QualificationV2SelfTestResult $stage

    $stage = 'recovery-required-latch'
    $failureState = Read-DysonQualificationV2FakeState -FakeRoot $testRoot
    $failureRequest = New-QualificationV2SelfTestRequest -Profile $profile -Action 'dsp-crash-recovery' `
        -Mode execute -Scope fake -Parameters ([pscustomobject][ordered]@{ expectedPid = [int]$failureState.dspPid })
    $failure = Complete-QualificationV2Receipt -Result (
        Invoke-QualificationV2Fake -Request $failureRequest -Injection CompensationFailure
    )
    Assert-QualificationV2SelfTest -Condition ([string]$failure.receipt.status -ceq 'recovery-required' -and
        [string]$failure.receipt.compensation.status -ceq 'failed') `
        -Message 'failed compensation did not latch recovery-required'
    $blockedState = Read-DysonQualificationV2FakeState -FakeRoot $testRoot
    $blockedRequest = New-QualificationV2SelfTestRequest -Profile $profile -Action 'control-plane-restart' `
        -Mode execute -Scope fake -Parameters ([pscustomobject][ordered]@{ expectedPid = [int]$blockedState.controlPid })
    Assert-QualificationV2Code -Operation { Invoke-QualificationV2Fake -Request $blockedRequest } `
        -ExpectedCode 'DYSON_QUALIFICATION_V2_MANUAL_RECOVERY_REQUIRED'
    $failureReplay = Invoke-QualificationV2Fake -Request $failureRequest
    Assert-QualificationV2SelfTest -Condition ($failureReplay.reused -and
        [string]$failureReplay.receipt.status -ceq 'recovery-required') `
        -Message 'recovery latch blocked immutable terminal replay'
    Add-QualificationV2SelfTestResult $stage

    $stage = 'bounds-and-broad-targets-rejected'
    $badStorage = New-QualificationV2SelfTestRequest -Profile $profile -Action 'storage-interruption' `
        -Mode preview -Scope fake -Parameters ([pscustomobject][ordered]@{ durationSeconds = 6 })
    Assert-QualificationV2Code -Operation { Invoke-QualificationV2Fake -Request $badStorage } `
        -ExpectedCode 'DYSON_QUALIFICATION_V2_ACTION_BOUNDS_INVALID'
    $badDisk = New-QualificationV2SelfTestRequest -Profile $profile -Action 'disk-pressure' `
        -Mode preview -Scope fake -Parameters ([pscustomobject][ordered]@{ allocationBytes = 3145728; holdSeconds = 1 })
    Assert-QualificationV2Code -Operation { Invoke-QualificationV2Fake -Request $badDisk } `
        -ExpectedCode 'DYSON_QUALIFICATION_V2_ACTION_BOUNDS_INVALID'
    $protectedProfile = Copy-QualificationV2SelfTestValue -Value $profile
    $protectedProfile.actions.diskPressure.directoryPath = [string]$protectedProfile.protectedRoots[2]
    Assert-QualificationV2Code -Operation {
        Assert-DysonQualificationV2Profile -Profile $protectedProfile -NowUtc $now
    } -ExpectedCode 'DYSON_QUALIFICATION_V2_DISK_TARGET_PROTECTED'
    $wildcardProfile = Copy-QualificationV2SelfTestValue -Value $profile
    $wildcardProfile.actions.storageInterruption.remotePath = [string]::Concat('\','\','invalid.example','\','*')
    Assert-QualificationV2Code -Operation {
        Assert-DysonQualificationV2Profile -Profile $wildcardProfile -NowUtc $now
    } -ExpectedCode 'DYSON_QUALIFICATION_V2_PROFILE_INVALID'
    $stringPid = New-QualificationV2SelfTestRequest -Profile $profile -Action 'control-plane-restart' `
        -Mode preview -Scope fake -Parameters ([pscustomobject][ordered]@{ expectedPid = '4101' })
    Assert-QualificationV2Code -Operation { Invoke-QualificationV2Fake -Request $stringPid } `
        -ExpectedCode 'DYSON_QUALIFICATION_V2_ACTION_BOUNDS_INVALID'
    $overlapProfile = Copy-QualificationV2SelfTestValue -Value $profile
    $overlapProfile.actions.dspCrashRecovery.executablePath = [string]$overlapProfile.actions.controlPlaneRestart.executablePath
    Assert-QualificationV2Code -Operation {
        Assert-DysonQualificationV2Profile -Profile $overlapProfile -NowUtc $now
    } -ExpectedCode 'DYSON_QUALIFICATION_V2_PROCESS_TARGETS_OVERLAP'
    Add-QualificationV2SelfTestResult $stage

    $stage = 'late-resume-uses-persisted-intent-without-replay'
    $lateRoot = Join-Path $testRoot 'late-resume'
    [void][IO.Directory]::CreateDirectory($lateRoot)
    [void](Initialize-DysonQualificationV2FakeFixture -FakeRoot $lateRoot -TargetIdentity $targetIdentity)
    $lateProfile = New-QualificationV2SelfTestProfile -Root $lateRoot
    $lateProtection = New-DysonQualificationV2FixtureProtectionPoint -Profile $lateProfile `
        -ProtectionPointId '33333333-4444-4555-8666-777777777777' -NowUtc $now
    $latePreviewRequest = New-DysonQualificationV2Request -Profile $lateProfile `
        -RequestId ([guid]::NewGuid().ToString('D')) -ApprovalId ([guid]::NewGuid().ToString('D')) `
        -Action 'control-plane-restart' -Mode preview -ExecutionScope fake -NowUtc $now `
        -ProtectionPoint $lateProtection -Parameters ([pscustomobject][ordered]@{ expectedPid = 4101 }) `
        -PredecessorReceiptSha256 $script:DysonQualificationV2ZeroDigest
    $lateConfirmation = Get-DysonQualificationV2ConfirmationPhrase -ExecutionScope fake `
        -Action 'control-plane-restart' -ProfileId ([string]$lateProfile.profileId) `
        -RequestId ([string]$latePreviewRequest.requestId) `
        -PreviewSha256 ([string]$latePreviewRequest.previewSha256)
    $lateRequest = ConvertTo-DysonQualificationV2ExecuteRequest -PreviewRequest $latePreviewRequest `
        -Profile $lateProfile -ConfirmationPhrase $lateConfirmation -NowUtc $now
    Assert-QualificationV2Code -Operation {
        Invoke-DysonQualificationActionV2 -Request $lateRequest -Backend Fake -Profile $lateProfile `
            -FakeRoot $lateRoot -NowUtc $now -Injection HardExitAfterIntent
    } -ExpectedCode 'DYSON_QUALIFICATION_V2_FAKE_INTENT_EXIT'
    $lateResult = Invoke-DysonQualificationActionV2 -Request $lateRequest -Backend Fake -Profile $lateProfile `
        -FakeRoot $lateRoot -Resume -NowUtc $now.AddHours(2)
    $lateState = Read-DysonQualificationV2FakeState -FakeRoot $lateRoot
    Assert-QualificationV2SelfTest -Condition (
        [string]$lateResult.receipt.status -ceq 'compensated' -and
        [int]$lateState.actionCounts.controlPlaneRestart -eq 0 -and
        [int]$lateState.otherProcessGeneration -eq 1 -and
        [int]$lateState.networkMutationCount -eq 0 -and
        [int]$lateState.saveMutationCount -eq 0
    ) -Message 'late resume rejected its persisted authorization or replayed the original action'
    Add-QualificationV2SelfTestResult $stage

    foreach ($atomicCase in @(
        [pscustomobject]@{ injection = 'IntentBeforeWrite'; orphan = $false; final = $false; resume = $false; expectedActions = 1 },
        [pscustomobject]@{ injection = 'IntentMidWrite'; orphan = $true; final = $false; resume = $false; expectedActions = 1 },
        [pscustomobject]@{ injection = 'IntentAfterFlushBeforeRename'; orphan = $true; final = $false; resume = $false; expectedActions = 1 },
        [pscustomobject]@{ injection = 'IntentAfterRename'; orphan = $false; final = $true; resume = $true; expectedActions = 0 },
        [pscustomobject]@{ injection = 'ReceiptBeforeWrite'; orphan = $false; final = $false; resume = $true; expectedActions = 1 },
        [pscustomobject]@{ injection = 'ReceiptMidWrite'; orphan = $true; final = $false; resume = $true; expectedActions = 1 },
        [pscustomobject]@{ injection = 'ReceiptAfterFlushBeforeRename'; orphan = $true; final = $false; resume = $true; expectedActions = 1 },
        [pscustomobject]@{ injection = 'ReceiptAfterRename'; orphan = $false; final = $true; resume = $false; expectedActions = 1 }
    )) {
        $stage = 'atomic-' + ([string]$atomicCase.injection).ToLowerInvariant()
        $atomicContext = New-QualificationV2IsolatedContext -Name $stage
        $atomicRequest = New-QualificationV2ContextRequest -Context $atomicContext `
            -Action 'control-plane-restart' -Parameters ([pscustomobject][ordered]@{ expectedPid = 4101 })
        Assert-QualificationV2Code -Operation {
            Invoke-QualificationV2Context -Context $atomicContext -Request $atomicRequest `
                -Injection ([string]$atomicCase.injection)
        } -ExpectedCode 'DYSON_QUALIFICATION_V2_FAKE_PERSISTENCE_EXIT'
        $atomicPaths = Get-DysonQualificationV2StorePaths -Profile $atomicContext.profile
        $atomicIntentPath = Get-DysonQualificationV2IntentPath -Paths $atomicPaths `
            -RequestId ([string]$atomicRequest.requestId)
        $atomicReceiptPath = Get-DysonQualificationV2ReceiptPath -Paths $atomicPaths `
            -RequestId ([string]$atomicRequest.requestId)
        $atomicFinalPath = if ([string]$atomicCase.injection -clike 'Intent*') {
            $atomicIntentPath
        }
        else { $atomicReceiptPath }
        Assert-QualificationV2SelfTest -Condition (
            (Test-Path -LiteralPath $atomicFinalPath -PathType Leaf) -eq [bool]$atomicCase.final
        ) -Message ('atomic final-file publication boundary was wrong for ' + [string]$atomicCase.injection)
        $atomicTemps = @(
            Get-ChildItem -LiteralPath $atomicPaths.intents,$atomicPaths.receipts -Force -File |
                Where-Object { $_.Name -cmatch '^\..+\.atomic-[0-9a-f]{32}\.tmp$' }
        )
        Assert-QualificationV2SelfTest -Condition ($atomicTemps.Count -eq $(if ([bool]$atomicCase.orphan) { 1 } else { 0 })) `
            -Message ('orphan temporary-file classification was wrong for ' + [string]$atomicCase.injection)
        if ([bool]$atomicCase.orphan) {
            Assert-QualificationV2Code -Operation {
                Invoke-QualificationV2Context -Context $atomicContext -Request $atomicRequest `
                    -Resume:$([bool]$atomicCase.resume)
            } -ExpectedCode 'DYSON_QUALIFICATION_V2_PERSISTENCE_RECOVERY_REQUIRED'
            [IO.File]::Delete($atomicTemps[0].FullName)
        }
        elseif ([string]$atomicCase.injection -ceq 'ReceiptBeforeWrite') {
            Assert-QualificationV2Code -Operation {
                Invoke-QualificationV2Context -Context $atomicContext -Request $atomicRequest
            } -ExpectedCode 'DYSON_QUALIFICATION_V2_RESUME_REQUIRED'
        }
        elseif ([string]$atomicCase.injection -ceq 'IntentAfterRename') {
            Assert-QualificationV2Code -Operation {
                Invoke-QualificationV2Context -Context $atomicContext -Request $atomicRequest
            } -ExpectedCode 'DYSON_QUALIFICATION_V2_RESUME_REQUIRED'
        }
        $atomicRecovered = Invoke-QualificationV2Context -Context $atomicContext -Request $atomicRequest `
            -Resume:$([bool]$atomicCase.resume)
        $atomicState = Read-DysonQualificationV2FakeState -FakeRoot $atomicContext.root
        $remainingAtomicTemps = @(
            Get-ChildItem -LiteralPath $atomicPaths.intents,$atomicPaths.receipts -Force -File |
                Where-Object { $_.Name -cmatch '^\..+\.atomic-[0-9a-f]{32}\.tmp$' }
        )
        Assert-QualificationV2SelfTest -Condition (
            [string]$atomicRecovered.status -ceq 'completed' -and
            [int]$atomicState.actionCounts.controlPlaneRestart -eq [int]$atomicCase.expectedActions -and
            $remainingAtomicTemps.Count -eq 0
        ) -Message ('atomic write recovery replayed or lost state for ' + [string]$atomicCase.injection)
        Add-QualificationV2SelfTestResult $stage
    }

    $stage = 'no-arbitrary-command-surface'
    $source = [IO.File]::ReadAllText($protocolPath, [Text.Encoding]::UTF8) + "`n" +
        [IO.File]::ReadAllText($executorPath, [Text.Encoding]::UTF8) + "`n" +
        [IO.File]::ReadAllText($adapterPath, [Text.Encoding]::UTF8)
    foreach ($forbidden in @(
        'Invoke-Expression','ScriptBlock]','cmd.exe','Stop-Process -Name','Get-Process -Name',
        'Remove-Item -Recurse','Restart-Computer','Stop-Computer','Invoke-WebRequest','Invoke-RestMethod'
    )) {
        Assert-QualificationV2SelfTest -Condition (-not $source.Contains($forbidden)) `
            -Message ('v2 implementation contains arbitrary or out-of-scope primitive: ' + $forbidden)
    }
    Add-QualificationV2SelfTestResult $stage

    $stage = 'isolated-side-effect-proof'
    $finalState = Read-DysonQualificationV2FakeState -FakeRoot $testRoot
    Assert-QualificationV2SelfTest -Condition ([int]$finalState.otherProcessGeneration -eq 1 -and
        [int]$finalState.otherVolumeGeneration -eq 1 -and [int]$finalState.networkMutationCount -eq 0 -and
        [int]$finalState.saveMutationCount -eq 0 -and [int]$finalState.broadPathMutationCount -eq 0) `
        -Message 'fake matrix recorded an unrelated process, volume, network, save, or broad-path side effect'
    Add-QualificationV2SelfTestResult $stage

    $result = [pscustomobject][ordered]@{
        protocol = 'DYSON_QUALIFICATION_V2_SELFTEST'
        schemaVersion = 2
        status = 'passed'
        runtime = 'Windows PowerShell 5.1'
        testCount = $tests.Count
        passedCount = $tests.Count
        tests = @($tests | ForEach-Object { $_ })
        actionsCovered = @($script:DysonQualificationV2Actions)
        productionBackendInvoked = $false
        productionProcessTouched = $false
        productionStorageTouched = $false
        productionDiskTouched = $false
        networkTouched = $false
        productionSaveTouched = $false
        productionChanged = $false
    }
}
catch {
    throw ('DYSON_QUALIFICATION_V2_SELFTEST_STAGE_FAILED: stage=' + $stage + '; code=' +
        [string](Get-DysonQualificationV2ErrorCode -Exception $_.Exception) +
        '; line=' + [string]$_.InvocationInfo.ScriptLineNumber +
        '; detail=' + [string]$_.Exception.Message +
        '; stack=' + ([string]$_.ScriptStackTrace -replace '[\r\n]+', ' <- '))
}
finally {
    [Environment]::SetEnvironmentVariable(
        $script:DysonQualificationV2FakeEnvironmentName,
        $oldFakeEnvironment,
        [EnvironmentVariableTarget]::Process
    )
    [Environment]::SetEnvironmentVariable(
        $script:DysonQualificationV2ProductionEnvironmentName,
        $oldProductionEnvironment,
        [EnvironmentVariableTarget]::Process
    )
    if (Test-Path -LiteralPath $testRoot -PathType Container) {
        $full = [IO.Path]::GetFullPath($testRoot).TrimEnd('\', '/')
        $temporary = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\', '/')
        $prefix = $temporary + [IO.Path]::DirectorySeparatorChar + 'dyson-qualification-v2-selftest-'
        if (-not $full.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)) {
            throw 'DYSON_QUALIFICATION_V2_SELFTEST_CLEANUP_TARGET_INVALID'
        }
        [IO.Directory]::Delete($full, $true)
    }
}

$result | ConvertTo-Json -Depth 16 -Compress
