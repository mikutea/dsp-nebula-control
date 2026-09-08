[CmdletBinding()]
param()

Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)

$installer = Join-Path $PSScriptRoot 'Install-DysonRuntimeTasks.ps1'
$leaseCommon = Join-Path $PSScriptRoot 'DysonHostMutationLease.Common.ps1'
. $leaseCommon
$temporaryBase = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\')
$testRoot = Join-Path $temporaryBase ('dyson-runtime-task-selftest-' + [guid]::NewGuid().ToString('N'))
$expectedTaskSddl = 'O:SYG:SYD:P(A;;GA;;;SY)(A;;GA;;;BA)(A;;GRGX;;;LS)'
$expectedCanonicalTaskSddl = 'O:SYG:SYD:P(A;;GA;;;SY)(A;;GA;;;BA)(A;;GXGR;;;LS)'
[void][IO.Directory]::CreateDirectory($testRoot)

function Assert-RuntimeTaskSelfTest {
    param([bool]$Condition, [string]$Message)
    if (-not $Condition) { throw "Runtime-task self-test failed: $Message" }
}

function Test-RuntimeTaskSelfTestFilePresent {
    param([Parameter(Mandatory)][string]$Path)

    for ($attempt = 0; $attempt -lt 4; $attempt++) {
        $stream = $null
        try {
            $share = [IO.FileShare]::ReadWrite -bor [IO.FileShare]::Delete
            $stream = [IO.File]::Open($Path, [IO.FileMode]::Open, [IO.FileAccess]::Read, $share)
            return $true
        }
        catch [IO.FileNotFoundException] {}
        catch [IO.DirectoryNotFoundException] {}
        finally { if ($null -ne $stream) { $stream.Dispose() } }
        if ($attempt -lt 3) { [Threading.Thread]::Sleep(50) }
    }
    return $false
}

function New-RuntimeTaskFixture {
    param([string]$Name)
    $root = Join-Path $testRoot $Name
    $fixture = [pscustomobject]@{
        Root = $root
        Project = Join-Path $root 'project'
        Data = Join-Path $root 'data'
        StableA = Join-Path $root 'stable-a'
        StableB = Join-Path $root 'stable-b'
        Transactions = Join-Path $root 'transactions'
        Shadow = Join-Path $root 'shadow'
    }
    foreach ($directory in @(
        $fixture.Project, $fixture.Data, $fixture.StableA, $fixture.StableB,
        $fixture.Transactions, $fixture.Shadow
    )) {
        [void][IO.Directory]::CreateDirectory($directory)
    }
    [IO.File]::WriteAllText((Join-Path $fixture.Shadow '.dyson-runtime-task-selftest'), "fixture`n")
    foreach ($stable in @($fixture.StableA, $fixture.StableB)) {
        [IO.File]::WriteAllText((Join-Path $stable 'Start-DysonServer.ps1'), "# fictional stable start`n")
        [IO.File]::WriteAllText((Join-Path $stable 'Stop-DysonServer.ps1'), "# fictional stable stop`n")
    }
    return $fixture
}

function Invoke-RuntimeTaskFixture {
    param(
        [Parameter(Mandatory)]$Fixture,
        [Parameter(Mandatory)][string]$StableRoot,
        [Parameter(Mandatory)][ValidateSet('PrepareDisabled', 'Activate')][string]$Mode,
        [Parameter(Mandatory)][string]$RequestId,
        [string]$FailPoint,
        [string]$DataRootOverride,
        [string]$LeaseInstanceId,
        [string]$LeaseToken,
        [string]$RestoreCompletedRequestId,
        [switch]$UseDerivedTransactionRoot,
        [switch]$Recover,
        [switch]$WhatIf
    )
    $dataRoot = if ([string]::IsNullOrWhiteSpace($DataRootOverride)) { $Fixture.Data } else { $DataRootOverride }
    $arguments = @(
        '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
        '-File', ('"' + $installer + '"'), '-ProjectRoot', ('"' + $Fixture.Project + '"'),
        '-DataRoot', ('"' + $dataRoot + '"'),
        '-InstalledScriptRoot', ('"' + $StableRoot + '"'), '-ServiceUser', 'FictionalServiceUser',
        '-Mode', $Mode, '-RequestId', $RequestId
    )
    if (-not $UseDerivedTransactionRoot) {
        $arguments += @('-TaskBackupRoot', ('"' + $Fixture.Transactions + '"'))
    }
    $arguments += @('-SchedulerBackend', 'Shadow', '-ShadowSchedulerRoot', ('"' + $Fixture.Shadow + '"'))
    if (-not [string]::IsNullOrWhiteSpace($LeaseInstanceId)) {
        $arguments += @('-LeaseInstanceId', $LeaseInstanceId)
    }
    if (-not [string]::IsNullOrWhiteSpace($LeaseToken)) {
        $arguments += @('-LeaseToken', $LeaseToken)
    }
    if ($Recover) { $arguments += '-Recover' }
    if ($RestoreCompletedRequestId) { $arguments += @('-RestoreCompletedRequestId', $RestoreCompletedRequestId) }
    if ($WhatIf) { $arguments += '-WhatIf' }
    $start = [Diagnostics.ProcessStartInfo]::new()
    $start.FileName = "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe"
    $start.Arguments = $arguments -join ' '
    $start.UseShellExecute = $false
    $start.RedirectStandardOutput = $true
    $start.RedirectStandardError = $true
    $start.CreateNoWindow = $true
    if (-not [string]::IsNullOrWhiteSpace($FailPoint)) {
        $start.EnvironmentVariables['DYSON_RUNTIME_TASK_SELFTEST_FAIL_POINT'] = $FailPoint
    }
    $start.EnvironmentVariables['DYSON_RUNTIME_TASK_SELFTEST'] = '1'
    $process = [Diagnostics.Process]::Start($start)
    $stdout = $process.StandardOutput.ReadToEnd()
    $stderr = $process.StandardError.ReadToEnd()
    $process.WaitForExit()
    return [pscustomobject]@{ ExitCode = $process.ExitCode; StdOut = $stdout; StdErr = $stderr }
}

function Get-ShadowPair {
    param([Parameter(Mandatory)]$Fixture)
    $start = Join-Path $Fixture.Shadow 'start-task.json'
    $stop = Join-Path $Fixture.Shadow 'stop-task.json'
    return [pscustomobject]@{
        Start = if (Test-RuntimeTaskSelfTestFilePresent $start) { [IO.File]::ReadAllText($start) } else { $null }
        Stop = if (Test-RuntimeTaskSelfTestFilePresent $stop) { [IO.File]::ReadAllText($stop) } else { $null }
    }
}

function Get-ShadowTask {
    param([Parameter(Mandatory)]$Fixture, [ValidateSet('start', 'stop')][string]$Kind)
    return (Get-Content -LiteralPath (Join-Path $Fixture.Shadow ($Kind + '-task.json')) -Raw | ConvertFrom-Json)
}

function Assert-OuterLeaseUnchanged {
    param([Parameter(Mandatory)]$Fixture, [Parameter(Mandatory)]$Lease, [Parameter(Mandatory)]$Before)
    $after = Get-DysonHostMutationLeaseStatus -DataRoot $Fixture.Data
    Assert-RuntimeTaskSelfTest ($after.state -ceq 'active' -and
        [string]$after.instanceId -ceq [string]$Lease.InstanceId -and
        [string]$after.recordDigest -ceq [string]$Before.recordDigest) `
        'a borrowed child changed or released the outer host-mutation lease'
}

try {
    $parseTokens = $null; $parseErrors = $null
    $installerAst = [Management.Automation.Language.Parser]::ParseFile($installer, [ref]$parseTokens, [ref]$parseErrors)
    foreach ($name in @('ConvertTo-RuntimeTaskCanonicalSddl', 'Test-RuntimeTaskSecurityDescriptorEqual', 'Test-RuntimeTaskUserEqual')) {
        $functionAst = $installerAst.Find({ param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -ceq $name }, $true)
        . ([scriptblock]::Create($functionAst.Extent.Text))
    }
    Assert-RuntimeTaskSelfTest (Test-RuntimeTaskSecurityDescriptorEqual `
        'O:SYG:SYD:(A;ID;GA;;;SY)' 'O:SYG:SYD:AI(A;ID;GA;;;SY)') 'native inheritance bookkeeping changed equality'
    Assert-RuntimeTaskSelfTest (-not (Test-RuntimeTaskSecurityDescriptorEqual `
        'O:SYG:SYD:P(A;;GA;;;SY)' 'O:SYG:SYD:(A;;GA;;;SY)')) 'task DACL protection drift was ignored'
    Assert-RuntimeTaskSelfTest (-not (Test-RuntimeTaskSecurityDescriptorEqual `
        'O:SYG:SYD:P(A;;GRGX;;;LS)' 'O:SYG:SYD:P(A;;GA;;;LS)')) 'task permission drift was ignored'
    Assert-RuntimeTaskSelfTest (Test-RuntimeTaskSecurityDescriptorEqual `
        'O:SYG:SYD:(A;ID;GA;;;SY)(A;;GR;;;BA)' 'O:SYG:SYD:AI(A;;GR;;;BA)(A;ID;GA;;;SY)') `
        'native allow-entry canonicalization changed effective grants'
    Assert-RuntimeTaskSelfTest (-not (Test-RuntimeTaskSecurityDescriptorEqual `
        'O:SYG:SYD:P(D;;GW;;;LS)(A;;GA;;;LS)' 'O:SYG:SYD:P(A;;GA;;;LS)(D;;GW;;;LS)')) `
        'deny/allow ordering was ignored'
    Assert-RuntimeTaskSelfTest (Test-RuntimeTaskSecurityDescriptorEqual $expectedTaskSddl `
        'O:SYG:SYD:PAI(A;;FA;;;SY)(A;;FA;;;BA)(A;;0x1200a9;;;LS)') `
        'native generic-to-file access mapping changed task permissions'
    $currentIdentity = [Security.Principal.WindowsIdentity]::GetCurrent()
    Assert-RuntimeTaskSelfTest (Test-RuntimeTaskUserEqual $currentIdentity.Name $currentIdentity.User.Value) `
        'qualified account and SID did not identify the same task user'
    Assert-RuntimeTaskSelfTest (-not (Test-RuntimeTaskUserEqual 'S-1-5-19' 'S-1-5-20')) `
        'different task users were treated as the same identity'

    $preview = New-RuntimeTaskFixture 'preview'
    Remove-Item -LiteralPath $preview.Transactions -Recurse -Force
    $previewResult = Invoke-RuntimeTaskFixture -Fixture $preview -StableRoot $preview.StableA `
        -Mode PrepareDisabled -RequestId ([guid]::NewGuid().ToString('D')) -WhatIf
    Assert-RuntimeTaskSelfTest ($previewResult.ExitCode -eq 0 -and
        -not (Test-Path -LiteralPath $preview.Transactions) -and
        -not (Test-RuntimeTaskSelfTestFilePresent (Join-Path $preview.Shadow 'start-task.json')) -and
        -not (Test-RuntimeTaskSelfTestFilePresent (Join-Path $preview.Shadow 'stop-task.json'))) `
        'WhatIf created transaction evidence or scheduler state'

    $derived = New-RuntimeTaskFixture 'derived-transaction-root'
    $derivedRequest = [guid]::NewGuid().ToString('D')
    $derivedTransactionRoot = Join-Path $derived.Root 'runtime-task-transactions'
    $derivedResult = Invoke-RuntimeTaskFixture -Fixture $derived -StableRoot $derived.StableA `
        -Mode PrepareDisabled -RequestId $derivedRequest -UseDerivedTransactionRoot
    Assert-RuntimeTaskSelfTest ($derivedResult.ExitCode -eq 0 -and
        (Test-RuntimeTaskSelfTestFilePresent (Join-Path $derivedTransactionRoot "receipts\$derivedRequest.json")) -and
        -not $derivedResult.StdOut.Contains($derived.Root)) `
        ('the default transaction root did not follow the selected custom data root: ' + $derivedResult.StdErr)

    $upgrade = New-RuntimeTaskFixture 'upgrade'
    $requestA = [guid]::NewGuid().ToString('D')
    $requestB = [guid]::NewGuid().ToString('D')
    $a = Invoke-RuntimeTaskFixture $upgrade $upgrade.StableA Activate $requestA
    Assert-RuntimeTaskSelfTest ($a.ExitCode -eq 0) ('initial A installation failed: ' + $a.StdErr)
    $b = Invoke-RuntimeTaskFixture $upgrade $upgrade.StableB Activate $requestB
    Assert-RuntimeTaskSelfTest ($b.ExitCode -eq 0) ('A to B upgrade failed: ' + $b.StdErr)
    $completedArchive = Get-Content -LiteralPath (Join-Path $upgrade.Transactions ('completed\' + $requestB + '.json')) -Raw | ConvertFrom-Json
    Assert-RuntimeTaskSelfTest ($completedArchive.previous.server.present -and $completedArchive.previous.stop.present -and
        [string]$completedArchive.previous.server.securityDescriptor -ceq $expectedCanonicalTaskSddl -and
        -not [string]::IsNullOrWhiteSpace([string]$completedArchive.previous.server.xmlBase64)) `
        'successful task replacement discarded its previous definitions or permissions'
    $startB = Get-ShadowTask $upgrade start
    $stopB = Get-ShadowTask $upgrade stop
    Assert-RuntimeTaskSelfTest ([string]$startB.descriptor.arguments -like ('*' + $upgrade.StableB + '*') -and
        [string]$stopB.descriptor.arguments -like ('*' + $upgrade.StableB + '*')) 'A to B actions did not use stable B'
    Assert-RuntimeTaskSelfTest (
        [string]$startB.descriptor.trigger -ceq 'AtLogOn' -and
        [string]$startB.descriptor.executionTimeLimit -ceq 'PT0S' -and
        [string]$startB.descriptor.multipleInstances -ceq 'IgnoreNew' -and
        [int]$startB.descriptor.restartCount -eq 3 -and
        [string]$startB.descriptor.restartInterval -ceq 'PT1M' -and
        [bool]$startB.descriptor.startWhenAvailable -and
        [int]$stopB.descriptor.restartCount -eq 0 -and
        $null -eq $stopB.descriptor.restartInterval -and
        -not [bool]$stopB.descriptor.startWhenAvailable
    ) 'the runtime task pair omitted the pinned bounded abnormal-exit recovery policy'
    Assert-RuntimeTaskSelfTest (
        [string]$startB.securityDescriptor -ceq $expectedCanonicalTaskSddl -and
        [string]$stopB.securityDescriptor -ceq $expectedCanonicalTaskSddl -and
        [string]$startB.descriptor.taskSecurityDescriptor -ceq $expectedTaskSddl -and
        [string]$stopB.descriptor.taskSecurityDescriptor -ceq $expectedTaskSddl -and
        $expectedTaskSddl -notmatch ';;;WD\)' -and $expectedTaskSddl -notmatch ';;;LS\).*GW' -and
        $expectedTaskSddl -match '\(A;;GRGX;;;LS\)') `
        'the runtime task DACL was not the exact protected SYSTEM/Admin full and LocalService read/execute contract'
    $writesBefore = @(Get-Content -LiteralPath (Join-Path $upgrade.Shadow 'writes.log')).Count
    $replay = Invoke-RuntimeTaskFixture $upgrade $upgrade.StableB Activate $requestB
    Assert-RuntimeTaskSelfTest ($replay.ExitCode -eq 0 -and $replay.StdOut -match '"reused":true') 'terminal replay failed'
    Assert-RuntimeTaskSelfTest (@(Get-Content -LiteralPath (Join-Path $upgrade.Shadow 'writes.log')).Count -eq $writesBefore) `
        'terminal replay wrote to the scheduler'

    $smbVisibility = New-RuntimeTaskFixture 'smb-terminal-visibility'
    $smbVisibilityRequests = @()
    for ($index = 0; $index -lt 6; $index++) {
        $visibilityRequest = [guid]::NewGuid().ToString('D')
        $smbVisibilityRequests += $visibilityRequest
        $visibilityStable = if (($index % 2) -eq 0) { $smbVisibility.StableA } else { $smbVisibility.StableB }
        $visibilityResult = Invoke-RuntimeTaskFixture $smbVisibility $visibilityStable Activate $visibilityRequest
        Assert-RuntimeTaskSelfTest ($visibilityResult.ExitCode -eq 0 -and
            $visibilityResult.StdOut -match '"status":"succeeded"') `
            ('rapid SMB terminal handoff was mistaken for an active intent: ' + $visibilityResult.StdErr)
        $visibilityReceipt = Get-Content -LiteralPath (Join-Path `
            (Join-Path $smbVisibility.Transactions 'receipts') ($visibilityRequest + '.json')) -Raw |
            ConvertFrom-Json
        Assert-RuntimeTaskSelfTest ([string]$visibilityReceipt.requestId -ceq $visibilityRequest -and
            [string]$visibilityReceipt.status -ceq 'succeeded') `
            'rapid SMB terminal handoff lost or rebound its terminal receipt'
    }
    Assert-RuntimeTaskSelfTest (
        -not (Test-RuntimeTaskSelfTestFilePresent (Join-Path $smbVisibility.Transactions 'active-intent.json')) -and
        @(Get-ChildItem -LiteralPath (Join-Path $smbVisibility.Transactions 'receipts') -File).Count -eq
            $smbVisibilityRequests.Count) `
        'rapid SMB terminal handoff left an actual active intent or omitted a receipt'

    $unboundIntent = New-RuntimeTaskFixture 'unbound-intent'
    $unboundIntentPath = Join-Path $unboundIntent.Transactions 'active-intent.json'
    $unboundIntentText = '{"protocol":"FICTIONAL_UNBOUND_RUNTIME_TASK_INTENT"}'
    [IO.File]::WriteAllText($unboundIntentPath, $unboundIntentText, [Text.UTF8Encoding]::new($false))
    $unboundIntentResult = Invoke-RuntimeTaskFixture $unboundIntent $unboundIntent.StableA Activate `
        ([guid]::NewGuid().ToString('D'))
    Assert-RuntimeTaskSelfTest ($unboundIntentResult.ExitCode -ne 0 -and
        [IO.File]::ReadAllText($unboundIntentPath) -ceq $unboundIntentText -and
        -not (Test-RuntimeTaskSelfTestFilePresent (Join-Path $unboundIntent.Shadow 'start-task.json')) -and
        -not (Test-RuntimeTaskSelfTestFilePresent (Join-Path $unboundIntent.Shadow 'stop-task.json'))) `
        'an unbound active intent was cleared or allowed to reach the scheduler'

    $aclDrift = New-RuntimeTaskFixture 'acl-drift'
    $aclDriftRequest = [guid]::NewGuid().ToString('D')
    $aclInstalled = Invoke-RuntimeTaskFixture $aclDrift $aclDrift.StableA Activate $aclDriftRequest
    Assert-RuntimeTaskSelfTest ($aclInstalled.ExitCode -eq 0) 'ACL drift fixture seed failed'
    $aclDriftPath = Join-Path $aclDrift.Shadow 'start-task.json'
    $aclDriftTask = Get-Content -LiteralPath $aclDriftPath -Raw | ConvertFrom-Json
    $aclDriftTask.securityDescriptor = 'O:SYG:SYD:P(A;;GA;;;SY)(A;;GA;;;BA)(A;;GA;;;LS)'
    [IO.File]::WriteAllText($aclDriftPath, ($aclDriftTask | ConvertTo-Json -Depth 16 -Compress), [Text.UTF8Encoding]::new($false))
    $aclDriftWrites = @(Get-Content -LiteralPath (Join-Path $aclDrift.Shadow 'writes.log')).Count
    $aclDriftReplay = Invoke-RuntimeTaskFixture $aclDrift $aclDrift.StableA Activate $aclDriftRequest
    Assert-RuntimeTaskSelfTest ($aclDriftReplay.ExitCode -ne 0 -and
        @(Get-Content -LiteralPath (Join-Path $aclDrift.Shadow 'writes.log')).Count -eq $aclDriftWrites) `
        'a terminal replay accepted LocalService full access or rewrote drifted scheduler state'

    $aclMissing = New-RuntimeTaskFixture 'acl-missing'
    $aclMissingRequest = [guid]::NewGuid().ToString('D')
    $aclMissingSeed = Invoke-RuntimeTaskFixture $aclMissing $aclMissing.StableA Activate $aclMissingRequest
    Assert-RuntimeTaskSelfTest ($aclMissingSeed.ExitCode -eq 0) 'missing ACL fixture seed failed'
    $aclMissingPath = Join-Path $aclMissing.Shadow 'stop-task.json'
    $aclMissingTask = Get-Content -LiteralPath $aclMissingPath -Raw | ConvertFrom-Json
    $withoutAcl = [ordered]@{
        protocol = [string]$aclMissingTask.protocol; taskName = [string]$aclMissingTask.taskName
        taskPath = [string]$aclMissingTask.taskPath; xmlBase64 = [string]$aclMissingTask.xmlBase64
        enabled = [bool]$aclMissingTask.enabled; descriptor = $aclMissingTask.descriptor
    }
    [IO.File]::WriteAllText($aclMissingPath, ($withoutAcl | ConvertTo-Json -Depth 16 -Compress), [Text.UTF8Encoding]::new($false))
    $aclMissingReplay = Invoke-RuntimeTaskFixture $aclMissing $aclMissing.StableA Activate $aclMissingRequest
    Assert-RuntimeTaskSelfTest ($aclMissingReplay.ExitCode -ne 0) `
        'a terminal replay accepted a task whose protected security descriptor was missing'

    $rollback = New-RuntimeTaskFixture 'rollback'
    $seed = Invoke-RuntimeTaskFixture $rollback $rollback.StableA Activate ([guid]::NewGuid().ToString('D'))
    Assert-RuntimeTaskSelfTest ($seed.ExitCode -eq 0) 'rollback fixture seed failed'
    $before = Get-ShadowPair $rollback
    $failed = Invoke-RuntimeTaskFixture $rollback $rollback.StableB Activate ([guid]::NewGuid().ToString('D')) SecondRegister
    $after = Get-ShadowPair $rollback
    Assert-RuntimeTaskSelfTest ($failed.ExitCode -ne 0 -and $before.Start -ceq $after.Start -and $before.Stop -ceq $after.Stop) `
        'second-task failure did not restore exact A'

    $empty = New-RuntimeTaskFixture 'empty'
    $firstFailure = Invoke-RuntimeTaskFixture $empty $empty.StableB Activate ([guid]::NewGuid().ToString('D')) SecondRegister
    Assert-RuntimeTaskSelfTest ($firstFailure.ExitCode -ne 0 -and
        -not (Test-RuntimeTaskSelfTestFilePresent (Join-Path $empty.Shadow 'start-task.json')) -and
        -not (Test-RuntimeTaskSelfTestFilePresent (Join-Path $empty.Shadow 'stop-task.json'))) 'first-install rollback was not empty'

    $states = New-RuntimeTaskFixture 'states'
    $prepared = Invoke-RuntimeTaskFixture $states $states.StableA PrepareDisabled ([guid]::NewGuid().ToString('D'))
    Assert-RuntimeTaskSelfTest ($prepared.ExitCode -eq 0 -and
        -not [bool](Get-ShadowTask $states start).enabled -and -not [bool](Get-ShadowTask $states stop).enabled) `
        'PrepareDisabled did not persist both tasks disabled'
    $activated = Invoke-RuntimeTaskFixture $states $states.StableA Activate ([guid]::NewGuid().ToString('D'))
    Assert-RuntimeTaskSelfTest ($activated.ExitCode -eq 0 -and
        [bool](Get-ShadowTask $states start).enabled -and [bool](Get-ShadowTask $states stop).enabled) `
        'Activate did not persist both tasks enabled'

    $crash = New-RuntimeTaskFixture 'crash'
    $crashSeed = Invoke-RuntimeTaskFixture $crash $crash.StableA Activate ([guid]::NewGuid().ToString('D'))
    Assert-RuntimeTaskSelfTest ($crashSeed.ExitCode -eq 0) 'crash fixture seed failed'
    $crashBefore = Get-ShadowPair $crash
    $crashRequest = [guid]::NewGuid().ToString('D')
    $hardExit = Invoke-RuntimeTaskFixture $crash $crash.StableB Activate $crashRequest HardExitAfterStartRegister
    Assert-RuntimeTaskSelfTest ($hardExit.ExitCode -eq 86 -and
        (Test-RuntimeTaskSelfTestFilePresent (Join-Path $crash.Transactions 'active-intent.json'))) 'hard exit evidence was not durable'
    $crashIntent = Get-Content -LiteralPath (Join-Path $crash.Transactions 'active-intent.json') -Raw | ConvertFrom-Json
    Assert-RuntimeTaskSelfTest (
        [string]$crashIntent.previous.server.securityDescriptor -ceq $expectedCanonicalTaskSddl -and
        [string]$crashIntent.previous.stop.securityDescriptor -ceq $expectedCanonicalTaskSddl) `
        'the crash-recovery snapshot did not durably preserve both prior task security descriptors'
    $recovered = Invoke-RuntimeTaskFixture -Fixture $crash -StableRoot $crash.StableB -Mode Activate `
        -RequestId $crashRequest -Recover
    $crashAfter = Get-ShadowPair $crash
    Assert-RuntimeTaskSelfTest ($recovered.ExitCode -eq 0 -and $recovered.StdOut -match '"status":"rolled-back"' -and
        $crashBefore.Start -ceq $crashAfter.Start -and $crashBefore.Stop -ceq $crashAfter.Stop -and
        -not (Test-RuntimeTaskSelfTestFilePresent (Join-Path $crash.Transactions 'active-intent.json'))) `
        ('explicit recovery failed: ' + $recovered.StdErr)

    $terminalCrash = New-RuntimeTaskFixture 'terminal-crash'
    $terminalRequest = [guid]::NewGuid().ToString('D')
    $afterReceipt = Invoke-RuntimeTaskFixture $terminalCrash $terminalCrash.StableB Activate `
        $terminalRequest HardExitAfterReceipt
    Assert-RuntimeTaskSelfTest ($afterReceipt.ExitCode -eq 87 -and
        (Test-RuntimeTaskSelfTestFilePresent (Join-Path $terminalCrash.Transactions 'active-intent.json')) -and
        (Test-RuntimeTaskSelfTestFilePresent (Join-Path (Join-Path $terminalCrash.Transactions 'receipts') ($terminalRequest + '.json')))) `
        'hard exit after terminal receipt did not retain the release handoff evidence'
    $terminalWrites = @(Get-Content -LiteralPath (Join-Path $terminalCrash.Shadow 'writes.log')).Count
    $ordinaryTerminalRetry = Invoke-RuntimeTaskFixture $terminalCrash $terminalCrash.StableB Activate $terminalRequest
    Assert-RuntimeTaskSelfTest ($ordinaryTerminalRetry.ExitCode -ne 0 -and
        @(Get-Content -LiteralPath (Join-Path $terminalCrash.Shadow 'writes.log')).Count -eq $terminalWrites -and
        (Test-RuntimeTaskSelfTestFilePresent (Join-Path $terminalCrash.Transactions 'active-intent.json'))) `
        'ordinary replay bypassed an unfinished terminal lease handoff'
    $terminalRecovered = Invoke-RuntimeTaskFixture -Fixture $terminalCrash -StableRoot $terminalCrash.StableB `
        -Mode Activate -RequestId $terminalRequest -Recover
    Assert-RuntimeTaskSelfTest ($terminalRecovered.ExitCode -eq 0 -and
        $terminalRecovered.StdOut -match '"status":"succeeded"' -and
        @(Get-Content -LiteralPath (Join-Path $terminalCrash.Shadow 'writes.log')).Count -eq $terminalWrites) `
        'terminal recovery repeated scheduler writes or failed to release the exact transaction'

    $borrowed = New-RuntimeTaskFixture 'borrowed-ordinary'
    $borrowedLease = $null
    try {
        $borrowedLease = Enter-DysonHostMutationLease -DataRoot $borrowed.Data -Owner 'runtime-task-selftest' `
            -Operation 'fictional-cutover' -RequestId ([guid]::NewGuid().ToString('D')) `
            -OwnerPid $PID -TimeoutMilliseconds 0
        $borrowedBefore = Get-DysonHostMutationLeaseStatus -DataRoot $borrowed.Data
        $borrowedApply = Invoke-RuntimeTaskFixture -Fixture $borrowed -StableRoot $borrowed.StableA `
            -Mode Activate -RequestId ([guid]::NewGuid().ToString('D')) `
            -LeaseInstanceId $borrowedLease.InstanceId -LeaseToken $borrowedLease.Token
        Assert-RuntimeTaskSelfTest ($borrowedApply.ExitCode -eq 0 -and
            [bool](Get-ShadowTask $borrowed start).enabled -and
            [bool](Get-ShadowTask $borrowed stop).enabled) `
            ('borrowed ordinary apply failed: ' + $borrowedApply.StdErr)
        Assert-OuterLeaseUnchanged $borrowed $borrowedLease $borrowedBefore
        $borrowedPairA = Get-ShadowPair $borrowed
        $borrowedFailureRequest = [guid]::NewGuid().ToString('D')
        $borrowedFailure = Invoke-RuntimeTaskFixture -Fixture $borrowed -StableRoot $borrowed.StableB `
            -Mode Activate -RequestId $borrowedFailureRequest -FailPoint SecondRegister `
            -LeaseInstanceId $borrowedLease.InstanceId -LeaseToken $borrowedLease.Token
        $borrowedPairAfterFailure = Get-ShadowPair $borrowed
        $borrowedFailureReceipt = Get-Content -LiteralPath (Join-Path `
            (Join-Path $borrowed.Transactions 'receipts') ($borrowedFailureRequest + '.json')) -Raw |
            ConvertFrom-Json
        Assert-RuntimeTaskSelfTest ($borrowedFailure.ExitCode -ne 0 -and
            [string]$borrowedFailureReceipt.status -ceq 'rolled-back' -and
            $borrowedPairA.Start -ceq $borrowedPairAfterFailure.Start -and
            $borrowedPairA.Stop -ceq $borrowedPairAfterFailure.Stop -and
            -not (Test-RuntimeTaskSelfTestFilePresent (Join-Path $borrowed.Transactions 'active-intent.json'))) `
            'borrowed ordinary failure did not durably prove the complete prior pair was restored'
        Assert-OuterLeaseUnchanged $borrowed $borrowedLease $borrowedBefore
    }
    finally {
        if ($null -ne $borrowedLease -and $borrowedLease.Active) {
            [void](Exit-DysonHostMutationLease -Lease $borrowedLease -State released)
        }
    }

    $invalidBorrow = New-RuntimeTaskFixture 'borrowed-invalid'
    $invalidLease = $null
    try {
        $invalidLease = Enter-DysonHostMutationLease -DataRoot $invalidBorrow.Data -Owner 'runtime-task-selftest' `
            -Operation 'fictional-cutover' -RequestId ([guid]::NewGuid().ToString('D')) `
            -OwnerPid $PID -TimeoutMilliseconds 0
        $invalidBefore = Get-DysonHostMutationLeaseStatus -DataRoot $invalidBorrow.Data
        $replacement = if ($invalidLease.Token[0] -ceq 'A') { 'B' } else { 'A' }
        $wrongToken = $replacement + $invalidLease.Token.Substring(1)
        $tokenRejected = Invoke-RuntimeTaskFixture -Fixture $invalidBorrow -StableRoot $invalidBorrow.StableA `
            -Mode Activate -RequestId ([guid]::NewGuid().ToString('D')) `
            -LeaseInstanceId $invalidLease.InstanceId -LeaseToken $wrongToken
        Assert-RuntimeTaskSelfTest ($tokenRejected.ExitCode -ne 0 -and
            -not (Test-RuntimeTaskSelfTestFilePresent (Join-Path $invalidBorrow.Shadow 'start-task.json')) -and
            -not (Test-RuntimeTaskSelfTestFilePresent (Join-Path $invalidBorrow.Shadow 'stop-task.json'))) `
            'a wrong borrowed token reached the scheduler'
        Assert-OuterLeaseUnchanged $invalidBorrow $invalidLease $invalidBefore

        $otherData = Join-Path $invalidBorrow.Root 'other-data'
        [void][IO.Directory]::CreateDirectory($otherData)
        $rootRejected = Invoke-RuntimeTaskFixture -Fixture $invalidBorrow -StableRoot $invalidBorrow.StableA `
            -Mode Activate -RequestId ([guid]::NewGuid().ToString('D')) -DataRootOverride $otherData `
            -LeaseInstanceId $invalidLease.InstanceId -LeaseToken $invalidLease.Token
        Assert-RuntimeTaskSelfTest ($rootRejected.ExitCode -ne 0 -and
            -not (Test-RuntimeTaskSelfTestFilePresent (Join-Path $invalidBorrow.Shadow 'start-task.json')) -and
            -not (Test-RuntimeTaskSelfTestFilePresent (Join-Path $invalidBorrow.Shadow 'stop-task.json'))) `
            'a borrowed lease for the wrong DataRoot reached the scheduler'
        Assert-OuterLeaseUnchanged $invalidBorrow $invalidLease $invalidBefore
    }
    finally {
        if ($null -ne $invalidLease -and $invalidLease.Active) {
            [void](Exit-DysonHostMutationLease -Lease $invalidLease -State released)
        }
    }

    $borrowedCrash = New-RuntimeTaskFixture 'borrowed-recovery'
    $borrowedCrashLease = $null
    try {
        $borrowedCrashLease = Enter-DysonHostMutationLease -DataRoot $borrowedCrash.Data `
            -Owner 'runtime-task-selftest' -Operation 'fictional-cutover' `
            -RequestId ([guid]::NewGuid().ToString('D')) -OwnerPid $PID -TimeoutMilliseconds 0
        $borrowedCrashBefore = Get-DysonHostMutationLeaseStatus -DataRoot $borrowedCrash.Data
        $borrowedSeed = Invoke-RuntimeTaskFixture -Fixture $borrowedCrash -StableRoot $borrowedCrash.StableA `
            -Mode Activate -RequestId ([guid]::NewGuid().ToString('D')) `
            -LeaseInstanceId $borrowedCrashLease.InstanceId -LeaseToken $borrowedCrashLease.Token
        Assert-RuntimeTaskSelfTest ($borrowedSeed.ExitCode -eq 0) `
            ('borrowed recovery fixture seed failed: ' + $borrowedSeed.StdErr)
        $borrowedPriorPair = Get-ShadowPair $borrowedCrash
        $borrowedCrashRequest = [guid]::NewGuid().ToString('D')
        $borrowedHardExit = Invoke-RuntimeTaskFixture -Fixture $borrowedCrash `
            -StableRoot $borrowedCrash.StableB -Mode Activate -RequestId $borrowedCrashRequest `
            -FailPoint HardExitAfterStartRegister -LeaseInstanceId $borrowedCrashLease.InstanceId `
            -LeaseToken $borrowedCrashLease.Token
        Assert-RuntimeTaskSelfTest ($borrowedHardExit.ExitCode -eq 86 -and
            (Test-RuntimeTaskSelfTestFilePresent (Join-Path $borrowedCrash.Transactions 'active-intent.json'))) `
            'borrowed hard exit did not retain recovery intent'
        Assert-OuterLeaseUnchanged $borrowedCrash $borrowedCrashLease $borrowedCrashBefore
        $borrowedRecovered = Invoke-RuntimeTaskFixture -Fixture $borrowedCrash `
            -StableRoot $borrowedCrash.StableB -Mode Activate -RequestId $borrowedCrashRequest -Recover `
            -LeaseInstanceId $borrowedCrashLease.InstanceId -LeaseToken $borrowedCrashLease.Token
        $borrowedRecoveredPair = Get-ShadowPair $borrowedCrash
        Assert-RuntimeTaskSelfTest ($borrowedRecovered.ExitCode -eq 0 -and
            $borrowedRecovered.StdOut -match '"status":"rolled-back"' -and
            $borrowedPriorPair.Start -ceq $borrowedRecoveredPair.Start -and
            $borrowedPriorPair.Stop -ceq $borrowedRecoveredPair.Stop -and
            -not (Test-RuntimeTaskSelfTestFilePresent (Join-Path $borrowedCrash.Transactions 'active-intent.json'))) `
            ('borrowed explicit rollback recovery failed: ' + $borrowedRecovered.StdErr)
        Assert-OuterLeaseUnchanged $borrowedCrash $borrowedCrashLease $borrowedCrashBefore
    }
    finally {
        if ($null -ne $borrowedCrashLease -and $borrowedCrashLease.Active) {
            [void](Exit-DysonHostMutationLease -Lease $borrowedCrashLease -State released)
        }
    }

    $borrowedTerminal = New-RuntimeTaskFixture 'borrowed-terminal-recovery'
    $borrowedTerminalLease = $null
    try {
        $borrowedTerminalLease = Enter-DysonHostMutationLease -DataRoot $borrowedTerminal.Data `
            -Owner 'runtime-task-selftest' -Operation 'fictional-cutover' `
            -RequestId ([guid]::NewGuid().ToString('D')) -OwnerPid $PID -TimeoutMilliseconds 0
        $borrowedTerminalBefore = Get-DysonHostMutationLeaseStatus -DataRoot $borrowedTerminal.Data
        $borrowedTerminalRequest = [guid]::NewGuid().ToString('D')
        $borrowedTerminalExit = Invoke-RuntimeTaskFixture -Fixture $borrowedTerminal `
            -StableRoot $borrowedTerminal.StableB -Mode Activate -RequestId $borrowedTerminalRequest `
            -FailPoint HardExitAfterReceipt -LeaseInstanceId $borrowedTerminalLease.InstanceId `
            -LeaseToken $borrowedTerminalLease.Token
        Assert-RuntimeTaskSelfTest ($borrowedTerminalExit.ExitCode -eq 87 -and
            (Test-RuntimeTaskSelfTestFilePresent (Join-Path $borrowedTerminal.Transactions 'active-intent.json'))) `
            'borrowed terminal hard exit did not retain handoff intent'
        Assert-OuterLeaseUnchanged $borrowedTerminal $borrowedTerminalLease $borrowedTerminalBefore
        $borrowedTerminalWrites = @(Get-Content -LiteralPath `
            (Join-Path $borrowedTerminal.Shadow 'writes.log')).Count
        $borrowedTerminalRecovered = Invoke-RuntimeTaskFixture -Fixture $borrowedTerminal `
            -StableRoot $borrowedTerminal.StableB -Mode Activate -RequestId $borrowedTerminalRequest -Recover `
            -LeaseInstanceId $borrowedTerminalLease.InstanceId -LeaseToken $borrowedTerminalLease.Token
        Assert-RuntimeTaskSelfTest ($borrowedTerminalRecovered.ExitCode -eq 0 -and
            $borrowedTerminalRecovered.StdOut -match '"status":"succeeded"' -and
            @(Get-Content -LiteralPath (Join-Path $borrowedTerminal.Shadow 'writes.log')).Count -eq
                $borrowedTerminalWrites -and
            -not (Test-RuntimeTaskSelfTestFilePresent (Join-Path $borrowedTerminal.Transactions 'active-intent.json'))) `
            ('borrowed terminal recovery repeated scheduler writes: ' + $borrowedTerminalRecovered.StdErr)
        Assert-OuterLeaseUnchanged $borrowedTerminal $borrowedTerminalLease $borrowedTerminalBefore
    }
    finally {
        if ($null -ne $borrowedTerminalLease -and $borrowedTerminalLease.Active) {
            [void](Exit-DysonHostMutationLease -Lease $borrowedTerminalLease -State released)
        }
    }

    $legacy = New-RuntimeTaskFixture 'inherited-legacy-acl'
    $legacySeed = Invoke-RuntimeTaskFixture $legacy $legacy.StableA Activate ([guid]::NewGuid().ToString('D'))
    Assert-RuntimeTaskSelfTest ($legacySeed.ExitCode -eq 0) 'legacy fixture seed failed'
    $legacySddl = 'O:SYG:SYD:(A;ID;GA;;;SY)(A;ID;GA;;;BA)'
    foreach ($kind in @('start', 'stop')) {
        $record = Get-ShadowTask $legacy $kind
        $record.securityDescriptor = $legacySddl
        [IO.File]::WriteAllText((Join-Path $legacy.Shadow ($kind + '-task.json')),
            ($record | ConvertTo-Json -Depth 16 -Compress), [Text.UTF8Encoding]::new($false))
    }
    $legacyBefore = Get-ShadowPair $legacy
    $legacyFailure = Invoke-RuntimeTaskFixture -Fixture $legacy -StableRoot $legacy.StableB `
        -Mode PrepareDisabled -RequestId ([guid]::NewGuid().ToString('D')) -FailPoint SecondRegister
    $legacyRestored = Get-ShadowPair $legacy
    Assert-RuntimeTaskSelfTest ($legacyFailure.ExitCode -ne 0 -and
        $legacyBefore.Start -ceq $legacyRestored.Start -and $legacyBefore.Stop -ceq $legacyRestored.Stop) `
        'failed migration did not restore inherited legacy task permissions exactly'
    $legacyUpgrade = Invoke-RuntimeTaskFixture $legacy $legacy.StableB PrepareDisabled ([guid]::NewGuid().ToString('D'))
    Assert-RuntimeTaskSelfTest ($legacyUpgrade.ExitCode -eq 0 -and
        (Get-ShadowTask $legacy start).securityDescriptor -ceq $expectedCanonicalTaskSddl -and
        (Get-ShadowTask $legacy stop).securityDescriptor -ceq $expectedCanonicalTaskSddl) `
        'legacy task migration did not install the fixed protected permissions'

    $badPreimage = New-RuntimeTaskFixture 'preimage-read-failure'
    $seed = Invoke-RuntimeTaskFixture $badPreimage $badPreimage.StableA Activate ([guid]::NewGuid().ToString('D'))
    Assert-RuntimeTaskSelfTest ($seed.ExitCode -eq 0) 'preimage failure fixture seed failed'
    $badPath = Join-Path $badPreimage.Shadow 'start-task.json'
    $validPreimage = [IO.File]::ReadAllText($badPath)
    $badRecord = $validPreimage | ConvertFrom-Json
    $badRecord.securityDescriptor = 'invalid'
    [IO.File]::WriteAllText($badPath, ($badRecord | ConvertTo-Json -Depth 16 -Compress), [Text.UTF8Encoding]::new($false))
    $readFailure = Invoke-RuntimeTaskFixture $badPreimage $badPreimage.StableB PrepareDisabled ([guid]::NewGuid().ToString('D'))
    Assert-RuntimeTaskSelfTest ($readFailure.ExitCode -ne 0 -and
        (Get-DysonHostMutationLeaseStatus -DataRoot $badPreimage.Data).state -ceq 'released' -and
        -not (Test-Path -LiteralPath (Join-Path $badPreimage.Transactions 'active-intent.json'))) `
        'a preimage read failure stranded the lease before any scheduler mutation'

    $completed = New-RuntimeTaskFixture 'completed-restore'
    $initial = Invoke-RuntimeTaskFixture $completed $completed.StableA Activate ([guid]::NewGuid().ToString('D'))
    Assert-RuntimeTaskSelfTest ($initial.ExitCode -eq 0) 'completed restore seed failed'
    $originalPair = Get-ShadowPair $completed
    $completedRequest = [guid]::NewGuid().ToString('D')
    $replacement = Invoke-RuntimeTaskFixture $completed $completed.StableB PrepareDisabled $completedRequest
    Assert-RuntimeTaskSelfTest ($replacement.ExitCode -eq 0) 'completed restore replacement failed'
    $replacementPair = Get-ShadowPair $completed
    $sourceArchivePath = Join-Path $completed.Transactions ('completed\' + $completedRequest + '.json')
    $sourceReceiptPath = Join-Path $completed.Transactions ('receipts\' + $completedRequest + '.json')
    $sourceArchiveBytes = [IO.File]::ReadAllText($sourceArchivePath)
    $sourceReceiptBytes = [IO.File]::ReadAllText($sourceReceiptPath)
    $restoreRequest = [guid]::NewGuid().ToString('D')
    $preview = Invoke-RuntimeTaskFixture $completed $completed.StableB PrepareDisabled $restoreRequest `
        -RestoreCompletedRequestId $completedRequest -WhatIf
    Assert-RuntimeTaskSelfTest ($preview.ExitCode -eq 0 -and
        (Get-ShadowPair $completed).Start -ceq $replacementPair.Start -and
        -not (Test-Path (Join-Path $completed.Transactions ('receipts\' + $restoreRequest + '.json')))) `
        'completed restoration preview mutated tasks or evidence'
    $sameId = Invoke-RuntimeTaskFixture $completed $completed.StableB PrepareDisabled $completedRequest `
        -RestoreCompletedRequestId $completedRequest
    Assert-RuntimeTaskSelfTest ($sameId.ExitCode -ne 0) 'completed restoration accepted its source request id'

    $driftPath = Join-Path $completed.Shadow 'stop-task.json'
    $driftRecord = Get-ShadowTask $completed stop
    $driftRecord.enabled = $true
    [IO.File]::WriteAllText($driftPath, ($driftRecord | ConvertTo-Json -Depth 16 -Compress))
    $writesBefore = @(Get-Content (Join-Path $completed.Shadow 'writes.log')).Count
    $drift = Invoke-RuntimeTaskFixture $completed $completed.StableB PrepareDisabled $restoreRequest `
        -RestoreCompletedRequestId $completedRequest
    Assert-RuntimeTaskSelfTest ($drift.ExitCode -ne 0 -and $drift.StdErr -match 'drifted' -and
        @(Get-Content (Join-Path $completed.Shadow 'writes.log')).Count -eq $writesBefore -and
        (Get-DysonHostMutationLeaseStatus -DataRoot $completed.Data).state -ceq 'released') `
        'completed restoration accepted drift, wrote tasks, or stranded its lease'
    [IO.File]::WriteAllText($driftPath, $replacementPair.Stop)

    $crashedRestoreRequest = [guid]::NewGuid().ToString('D')
    $crashedRestore = Invoke-RuntimeTaskFixture $completed $completed.StableB PrepareDisabled $crashedRestoreRequest `
        -RestoreCompletedRequestId $completedRequest -FailPoint HardExitAfterStartRegister
    Assert-RuntimeTaskSelfTest ($crashedRestore.ExitCode -eq 86 -and
        (Test-RuntimeTaskSelfTestFilePresent (Join-Path $completed.Transactions 'active-intent.json'))) `
        'interrupted completed restoration lost its durable intent'
    $recoveredRestore = Invoke-RuntimeTaskFixture $completed $completed.StableB PrepareDisabled $crashedRestoreRequest `
        -RestoreCompletedRequestId $completedRequest -Recover
    $recoveredPair = Get-ShadowPair $completed
    Assert-RuntimeTaskSelfTest ($recoveredRestore.ExitCode -eq 0 -and
        $recoveredRestore.StdOut -match '"status":"rolled-back"' -and
        $recoveredPair.Start -ceq $replacementPair.Start -and $recoveredPair.Stop -ceq $replacementPair.Stop -and
        -not (Test-RuntimeTaskSelfTestFilePresent (Join-Path $completed.Transactions 'active-intent.json'))) `
        ('interrupted completed restoration recovery failed: ' + $recoveredRestore.StdErr)

    $failedRestore = Invoke-RuntimeTaskFixture $completed $completed.StableB PrepareDisabled ([guid]::NewGuid().ToString('D')) `
        -RestoreCompletedRequestId $completedRequest -FailPoint SecondRegister
    $compensatedPair = Get-ShadowPair $completed
    Assert-RuntimeTaskSelfTest ($failedRestore.ExitCode -ne 0 -and
        $compensatedPair.Start -ceq $replacementPair.Start -and $compensatedPair.Stop -ceq $replacementPair.Stop -and
        (Get-DysonHostMutationLeaseStatus -DataRoot $completed.Data).state -ceq 'released') `
        'failed completed restoration did not compensate the full pre-restore pair'

    $restored = Invoke-RuntimeTaskFixture $completed $completed.StableB PrepareDisabled $restoreRequest `
        -RestoreCompletedRequestId $completedRequest
    $restoredPair = Get-ShadowPair $completed
    Assert-RuntimeTaskSelfTest ($restored.ExitCode -eq 0 -and $restored.StdOut -match '"status":"succeeded"' -and
        $restoredPair.Start -ceq $originalPair.Start -and $restoredPair.Stop -ceq $originalPair.Stop) `
        ('completed restoration did not restore XML, enabled state and ACL: ' + $restored.StdErr)
    Assert-RuntimeTaskSelfTest ([IO.File]::ReadAllText($sourceArchivePath) -ceq $sourceArchiveBytes -and
        [IO.File]::ReadAllText($sourceReceiptPath) -ceq $sourceReceiptBytes -and
        (Test-Path (Join-Path $completed.Transactions ('completed\' + $restoreRequest + '.json')))) `
        'completed restoration rewrote original evidence or omitted its own archive'
    $replayedRestore = Invoke-RuntimeTaskFixture $completed $completed.StableB PrepareDisabled $restoreRequest `
        -RestoreCompletedRequestId $completedRequest
    Assert-RuntimeTaskSelfTest ($replayedRestore.ExitCode -eq 0 -and $replayedRestore.StdOut -match '"reused":true') `
        'completed restoration replay was not idempotent'

    [ordered]@{
        protocol = 'DYSON_CONTROL_RUNTIME_TASK_SELFTEST_V2'; state = 'passed'; scheduler = 'shadow'
        productionSchedulerTouched = $false; cases = 41
    } | ConvertTo-Json -Compress
}
finally {
    $resolved = [IO.Path]::GetFullPath($testRoot)
    $prefix = $temporaryBase + [IO.Path]::DirectorySeparatorChar + 'dyson-runtime-task-selftest-'
    if ($resolved.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase) -and (Test-Path -LiteralPath $resolved)) {
        Remove-Item -LiteralPath $resolved -Recurse -Force -ErrorAction SilentlyContinue
    }
}
