[CmdletBinding()]
param()

Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$commonScript = Join-Path $PSScriptRoot 'DysonHostMutationLease.Common.ps1'
$brokerScript = Join-Path $PSScriptRoot 'Invoke-DysonHostMutationLeaseBroker.ps1'
$deploymentCommonScript = Join-Path $PSScriptRoot 'deployment\DysonDeployment.Common.ps1'
. $commonScript
. $deploymentCommonScript

if ($null -eq ('DysonHostMutationLeaseSelfTestNativeMethodsV1' -as [type])) {
    Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;

public static class DysonHostMutationLeaseSelfTestNativeMethodsV1
{
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool DefineDosDevice(
        UInt32 flags,
        string deviceName,
        string targetPath);
}
'@ -Language CSharp -ErrorAction Stop
}

$powershellCommand = @(Get-Command powershell.exe -CommandType Application -ErrorAction Stop | Select-Object -First 1)
if ($powershellCommand.Count -ne 1 -or [string]::IsNullOrWhiteSpace([string]$powershellCommand[0].Path)) {
    throw 'SELFTEST_FAILED: Windows PowerShell 5.1 is unavailable'
}
$powershellExecutable = [string]$powershellCommand[0].Path
$temporaryBase = [System.IO.Path]::GetFullPath([System.IO.Path]::GetTempPath()).TrimEnd('\', '/')
$testRoot = Join-Path $temporaryBase ('dyson-host-mutation-lease-selftest-' + [guid]::NewGuid().ToString('N'))
$createdProcesses = New-Object System.Collections.Generic.List[System.Diagnostics.Process]
$substituteDrive = $null
$substituteTarget = $null

function Assert-LeaseSelfTest {
    param(
        [Parameter(Mandatory)][bool]$Condition,
        [Parameter(Mandatory)][string]$Message
    )
    if (-not $Condition) { throw "SELFTEST_FAILED: $Message" }
}

function ConvertTo-LeaseSelfTestNativeArgument {
    param([Parameter(Mandatory)][AllowEmptyString()][string]$Value)

    if ($Value.IndexOf([char]0) -ge 0 -or $Value -match '[\r\n"]') {
        throw 'SELFTEST_FAILED: invalid native fixture argument'
    }
    if ($Value -notmatch '\s') { return $Value }
    return '"' + $Value + '"'
}

function New-LeaseSelfTestDataRoot {
    param([Parameter(Mandatory)][string]$Name)

    $root = Join-Path $testRoot $Name
    [void][System.IO.Directory]::CreateDirectory($root)
    return $root
}

function Start-LeaseSelfTestBroker {
    param(
        [Parameter(Mandatory)][string]$DataRoot,
        [Parameter(Mandatory)][string]$RequestId
    )

    $arguments = @(
        '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
        '-File', $brokerScript,
        '-DataRoot', $DataRoot,
        '-Owner', 'selftest',
        '-Operation', 'lease-test',
        '-RequestId', $RequestId,
        '-OwnerPid', [string]$PID,
        '-TimeoutMilliseconds', '1000'
    )
    $startInfo = [System.Diagnostics.ProcessStartInfo]::new()
    $startInfo.FileName = $powershellExecutable
    $startInfo.Arguments = (($arguments | ForEach-Object {
        ConvertTo-LeaseSelfTestNativeArgument -Value ([string]$_
        )
    }) -join ' ')
    $startInfo.WorkingDirectory = [System.IO.Path]::GetTempPath()
    $startInfo.UseShellExecute = $false
    $startInfo.CreateNoWindow = $true
    $startInfo.RedirectStandardInput = $true
    $startInfo.RedirectStandardOutput = $true
    $startInfo.RedirectStandardError = $true

    $process = [System.Diagnostics.Process]::new()
    $process.StartInfo = $startInfo
    if (-not $process.Start()) { throw 'SELFTEST_FAILED: broker did not start' }
    $createdProcesses.Add($process)
    $lineTask = $process.StandardOutput.ReadLineAsync()
    if (-not $lineTask.Wait(10000)) {
        try { $process.Kill() } catch {}
        throw 'SELFTEST_FAILED: broker readiness timed out'
    }
    $line = [string]$lineTask.GetAwaiter().GetResult()
    Assert-LeaseSelfTest -Condition ($line.Length -gt 0 -and $line.Length -le 2048) `
        -Message 'broker readiness output was not bounded'
    try { $message = $line | ConvertFrom-Json -ErrorAction Stop }
    catch { throw 'SELFTEST_FAILED: broker readiness output was invalid' }
    Assert-LeaseSelfTest -Condition ($message.protocol -ceq 'DYSON_HOST_MUTATION_BROKER_V1' -and
        $message.type -ceq 'ready' -and
        [string]$message.dataRootIdentity -match '^sha256:[0-9a-f]{64}$' -and
        [string]$message.instanceId -match '^[0-9a-f-]{36}$' -and
        [string]$message.token -match '^[A-Za-z0-9_-]{43}$') `
        -Message 'broker did not return the exact ready contract'
    return [pscustomobject][ordered]@{ Process = $process; Message = $message }
}

function Complete-LeaseSelfTestBroker {
    param(
        [Parameter(Mandatory)]$Broker,
        [Parameter(Mandatory)][int]$ExpectedExitCode,
        [switch]$SkipOutputCheck
    )

    $process = $Broker.Process
    if (-not $process.WaitForExit(10000)) {
        try { $process.Kill() } catch {}
        throw 'SELFTEST_FAILED: broker exit timed out'
    }
    $process.WaitForExit()
    Assert-LeaseSelfTest -Condition ($process.ExitCode -eq $ExpectedExitCode) `
        -Message 'broker returned an unexpected stable exit code'
    if (-not $SkipOutputCheck) {
        $remainingOutput = $process.StandardOutput.ReadToEnd()
        $errorOutput = $process.StandardError.ReadToEnd()
        Assert-LeaseSelfTest -Condition ($remainingOutput.Length -eq 0 -and $errorOutput.Length -eq 0) `
            -Message 'broker emitted unbounded or private terminal output'
    }
}

function Assert-LeaseFailure {
    param(
        [Parameter(Mandatory)][scriptblock]$Action,
        [Parameter(Mandatory)][string]$Code,
        [Parameter(Mandatory)][string]$Message
    )

    $failure = $null
    try { & $Action | Out-Null }
    catch { $failure = $_.Exception }
    Assert-LeaseSelfTest -Condition ($null -ne $failure) -Message $Message
    Assert-LeaseSelfTest -Condition ($failure.Message -ceq $Code -and
        $failure.Data.Contains('Code') -and $failure.Data['Code'] -ceq $Code) `
        -Message 'lease failure was unstable or disclosed context'
    return $failure
}

try {
    [void][System.IO.Directory]::CreateDirectory($testRoot)

    # Direct PS-to-PS holder, contender, and read/probe/read borrow behavior.
    $directRoot = New-LeaseSelfTestDataRoot -Name 'direct'
    $wrongRoot = New-LeaseSelfTestDataRoot -Name 'wrong-root'
    Assert-LeaseSelfTest -Condition ([string]::Equals(
        (Get-DysonHostMutationLeasePath -DataRoot $directRoot),
        (Get-DysonDeploymentLockPath -DataRoot $directRoot),
        [System.StringComparison]::OrdinalIgnoreCase
    )) -Message 'host lease did not reuse the deployment sidecar identity'
    $directLease = Enter-DysonHostMutationLease -DataRoot $directRoot -Owner selftest `
        -Operation direct -RequestId direct-request -OwnerPid $PID -TimeoutMilliseconds 0
    try {
        [void](Assert-LeaseFailure -Code 'DYSON_HOST_MUTATION_LEASE_BUSY' `
            -Message 'a second PS holder crossed the live lease' -Action {
                Enter-DysonHostMutationLease -DataRoot $directRoot -Owner contender `
                    -Operation direct -RequestId contender-request -OwnerPid $PID -TimeoutMilliseconds 0
            })
        $borrow = Assert-DysonHostMutationLeaseBorrow -DataRoot $directRoot `
            -InstanceId $directLease.InstanceId -Token $directLease.Token
        Assert-LeaseSelfTest -Condition ($borrow.state -ceq 'active' -and
            $borrow.instanceId -ceq $directLease.InstanceId) `
            -Message 'a valid PS borrower was rejected'

        $wrongTokenPrefix = if ($directLease.Token[0] -ceq 'A') { 'B' } else { 'A' }
        $wrongToken = $wrongTokenPrefix + $directLease.Token.Substring(1)
        [void](Assert-LeaseFailure -Code 'DYSON_HOST_MUTATION_LEASE_BORROW_INVALID' `
            -Message 'a wrong token was accepted' -Action {
                Assert-DysonHostMutationLeaseBorrow -DataRoot $directRoot `
                    -InstanceId $directLease.InstanceId -Token $wrongToken
            })
        [void](Assert-LeaseFailure -Code 'DYSON_HOST_MUTATION_LEASE_BORROW_INVALID' `
            -Message 'a wrong instance was accepted' -Action {
                Assert-DysonHostMutationLeaseBorrow -DataRoot $directRoot `
                    -InstanceId '00000000-0000-0000-0000-000000000000' -Token $directLease.Token
            })
        [void](Assert-LeaseFailure -Code 'DYSON_HOST_MUTATION_LEASE_BORROW_INVALID' `
            -Message 'a wrong DataRoot was accepted' -Action {
                Assert-DysonHostMutationLeaseBorrow -DataRoot $wrongRoot `
                    -InstanceId $directLease.InstanceId -Token $directLease.Token
            })
    }
    finally {
        if ($directLease.Active) { [void](Exit-DysonHostMutationLease -Lease $directLease) }
    }
    Assert-LeaseSelfTest -Condition ((Get-DysonHostMutationLeaseStatus -DataRoot $directRoot).state -ceq 'released') `
        -Message 'direct PS release did not persist a clean record'

    # A DOS drive alias resolves to the same physical identity and lock as its
    # canonical path; it cannot create an independent holder.
    $aliasBacking = Join-Path $testRoot 'drive-alias-backing'
    $physicalAliasRoot = Join-Path $aliasBacking 'data'
    [void][System.IO.Directory]::CreateDirectory($physicalAliasRoot)
    $driveName = @('R', 'S', 'T', 'U', 'V', 'W') | Where-Object {
        -not [System.IO.Directory]::Exists($_ + ':\')
    } | Select-Object -First 1
    Assert-LeaseSelfTest -Condition (-not [string]::IsNullOrWhiteSpace([string]$driveName)) `
        -Message 'a bounded drive-alias fixture was unavailable'
    $substituteDrive = [string]$driveName + ':'
    $substituteTarget = '\??\' + $aliasBacking
    $driveCreated = [DysonHostMutationLeaseSelfTestNativeMethodsV1]::DefineDosDevice(
        [uint32]1,
        $substituteDrive,
        $substituteTarget
    )
    Assert-LeaseSelfTest -Condition ($driveCreated -and
        [System.IO.Directory]::Exists($substituteDrive + '\')) `
        -Message 'the drive-alias fixture could not be established'
    $mappedAliasRoot = $substituteDrive + '\data'
    Assert-LeaseSelfTest -Condition ((Get-DysonHostMutationDataRootIdentity -DataRoot $physicalAliasRoot) -ceq
        (Get-DysonHostMutationDataRootIdentity -DataRoot $mappedAliasRoot)) `
        -Message 'a mapped drive and physical path produced different lease identities'
    Assert-LeaseSelfTest -Condition ([string]::Equals(
        (Get-DysonHostMutationLeasePath -DataRoot $physicalAliasRoot),
        (Get-DysonHostMutationLeasePath -DataRoot $mappedAliasRoot),
        [System.StringComparison]::OrdinalIgnoreCase
    )) -Message 'a mapped drive and physical path produced different lock paths'
    $aliasLease = Enter-DysonHostMutationLease -DataRoot $physicalAliasRoot -Owner selftest `
        -Operation alias -RequestId alias-request -OwnerPid $PID -TimeoutMilliseconds 0
    try {
        [void](Assert-LeaseFailure -Code 'DYSON_HOST_MUTATION_LEASE_BUSY' `
            -Message 'a mapped alias acquired a second physical-root lease' -Action {
                Enter-DysonHostMutationLease -DataRoot $mappedAliasRoot -Owner selftest `
                    -Operation alias -RequestId alias-contender -OwnerPid $PID -TimeoutMilliseconds 0
            })
        [void](Assert-DysonHostMutationLeaseBorrow -DataRoot $mappedAliasRoot `
            -InstanceId $aliasLease.InstanceId -Token $aliasLease.Token)
    }
    finally {
        if ($aliasLease.Active) { [void](Exit-DysonHostMutationLease -Lease $aliasLease) }
        $driveRemoved = [DysonHostMutationLeaseSelfTestNativeMethodsV1]::DefineDosDevice(
            [uint32]7,
            $substituteDrive,
            $substituteTarget
        )
        Assert-LeaseSelfTest -Condition $driveRemoved `
            -Message 'the drive-alias fixture could not be removed'
        $substituteDrive = $null
        $substituteTarget = $null
    }

    # Directory aliases and a reparse object occupying the exact lock leaf are
    # rejected before a holder can create or follow another physical lock.
    $reparseTarget = New-LeaseSelfTestDataRoot -Name 'reparse-target'
    $reparseAlias = Join-Path $testRoot 'reparse-data-alias'
    [void](New-Item -ItemType Junction -Path $reparseAlias -Target $reparseTarget -ErrorAction Stop)
    [void](Assert-LeaseFailure -Code 'DYSON_HOST_MUTATION_LEASE_DATA_ROOT_INVALID' `
        -Message 'a DataRoot reparse alias was accepted' -Action {
            Enter-DysonHostMutationLease -DataRoot $reparseAlias -Owner selftest `
                -Operation reparse -RequestId reparse-request -OwnerPid $PID -TimeoutMilliseconds 0
        })

    $lockReparseRoot = New-LeaseSelfTestDataRoot -Name 'lock-reparse-root'
    $lockReparsePath = Get-DysonHostMutationLeasePath -DataRoot $lockReparseRoot
    [void][System.IO.Directory]::CreateDirectory([System.IO.Path]::GetDirectoryName($lockReparsePath))
    $lockReparseTarget = New-LeaseSelfTestDataRoot -Name 'lock-reparse-target'
    [void](New-Item -ItemType Junction -Path $lockReparsePath -Target $lockReparseTarget -ErrorAction Stop)
    [void](Assert-LeaseFailure -Code 'DYSON_HOST_MUTATION_LEASE_PATH_IDENTITY_INVALID' `
        -Message 'a reparse object at the lock-file leaf was followed' -Action {
            Enter-DysonHostMutationLease -DataRoot $lockReparseRoot -Owner selftest `
                -Operation reparse -RequestId lock-reparse-request -OwnerPid $PID -TimeoutMilliseconds 0
        })

    # A malformed record is never silently replaced, even by a recovery request.
    $corruptRoot = New-LeaseSelfTestDataRoot -Name 'corrupt'
    $corruptLease = Enter-DysonHostMutationLease -DataRoot $corruptRoot -Owner selftest `
        -Operation corrupt -RequestId corrupt-request -OwnerPid $PID -TimeoutMilliseconds 0
    [void](Exit-DysonHostMutationLease -Lease $corruptLease)
    $corruptPath = Get-DysonHostMutationLeasePath -DataRoot $corruptRoot
    [System.IO.File]::WriteAllText($corruptPath, '{"unexpected":true}', [System.Text.UTF8Encoding]::new($false))
    [void](Assert-LeaseFailure -Code 'DYSON_HOST_MUTATION_LEASE_RECORD_INVALID' `
        -Message 'a corrupt lease record was overwritten' -Action {
            Enter-DysonHostMutationLease -DataRoot $corruptRoot -Owner selftest `
                -Operation corrupt -RequestId corrupt-retry -OwnerPid $PID -TimeoutMilliseconds 0
        })
    $oversizedRoot = New-LeaseSelfTestDataRoot -Name 'oversized-record'
    $oversizedPath = Get-DysonHostMutationLeasePath -DataRoot $oversizedRoot
    [void][System.IO.Directory]::CreateDirectory([System.IO.Path]::GetDirectoryName($oversizedPath))
    [System.IO.File]::WriteAllText($oversizedPath, ('x' * 4097), [System.Text.UTF8Encoding]::new($false))
    [void](Assert-LeaseFailure -Code 'DYSON_HOST_MUTATION_LEASE_RECORD_INVALID' `
        -Message 'an oversized lease record was overwritten or parsed' -Action {
            Enter-DysonHostMutationLease -DataRoot $oversizedRoot -Owner selftest `
                -Operation corrupt -RequestId oversized-retry -OwnerPid $PID -TimeoutMilliseconds 0
        })

    # Normal broker release is clean and leaves no terminal details behind.
    $normalRoot = New-LeaseSelfTestDataRoot -Name 'normal-broker'
    $normalBroker = Start-LeaseSelfTestBroker -DataRoot $normalRoot -RequestId normal-request
    $normalBroker.Process.StandardInput.WriteLine('RELEASE')
    $normalBroker.Process.StandardInput.Flush()
    $normalBroker.Process.StandardInput.Close()
    Complete-LeaseSelfTestBroker -Broker $normalBroker -ExpectedExitCode 0
    Assert-LeaseSelfTest -Condition ((Get-DysonHostMutationLeaseStatus -DataRoot $normalRoot).state -ceq 'released') `
        -Message 'normal broker release was not clean'

    # EOF is explicitly abandoned and needs an exact, digest-bound recovery lease.
    $eofRoot = New-LeaseSelfTestDataRoot -Name 'eof-broker'
    $eofBroker = Start-LeaseSelfTestBroker -DataRoot $eofRoot -RequestId eof-request
    $eofBroker.Process.StandardInput.Close()
    Complete-LeaseSelfTestBroker -Broker $eofBroker -ExpectedExitCode 22
    $eofStatus = Get-DysonHostMutationLeaseStatus -DataRoot $eofRoot
    Assert-LeaseSelfTest -Condition ($eofStatus.state -ceq 'abandoned') `
        -Message 'stdin EOF was not recorded as abandoned'
    [void](Assert-LeaseFailure -Code 'DYSON_HOST_MUTATION_LEASE_RECOVERY_REQUIRED' `
        -Message 'ordinary mutation crossed an abandoned record' -Action {
            Enter-DysonHostMutationLease -DataRoot $eofRoot -Owner selftest `
                -Operation eof -RequestId eof-retry -OwnerPid $PID -TimeoutMilliseconds 0
        })
    $eofRecovery = Enter-DysonHostMutationLease -DataRoot $eofRoot -Owner selftest `
        -Operation eof-recovery -RequestId eof-recovery -OwnerPid $PID -TimeoutMilliseconds 0 `
        -RecoveryPriorInstanceId $eofStatus.instanceId -RecoveryPriorRecordDigest $eofStatus.recordDigest
    Assert-LeaseSelfTest -Condition ($eofRecovery.Record.leaseKind -ceq 'recovery') `
        -Message 'exact abandoned-record recovery was not identified'
    [void](Exit-DysonHostMutationLease -Lease $eofRecovery)

    # A hard-killed broker leaves active evidence. The first ordinary attempt seals it
    # as recovery-required; wrong binding fails and the exact current digest succeeds.
    $killRoot = New-LeaseSelfTestDataRoot -Name 'killed-broker'
    $killBroker = Start-LeaseSelfTestBroker -DataRoot $killRoot -RequestId kill-request
    $killBroker.Process.Kill()
    Complete-LeaseSelfTestBroker -Broker $killBroker -ExpectedExitCode -1 -SkipOutputCheck
    $killedStatus = Get-DysonHostMutationLeaseStatus -DataRoot $killRoot
    Assert-LeaseSelfTest -Condition ($killedStatus.state -ceq 'active') `
        -Message 'hard-kill evidence was not retained'
    $recoveryFailure = Assert-LeaseFailure -Code 'DYSON_HOST_MUTATION_LEASE_RECOVERY_REQUIRED' `
        -Message 'ordinary mutation crossed a hard-crash record' -Action {
            Enter-DysonHostMutationLease -DataRoot $killRoot -Owner selftest `
                -Operation kill -RequestId kill-retry -OwnerPid $PID -TimeoutMilliseconds 0
        }
    Assert-LeaseSelfTest -Condition ($recoveryFailure.Data['PriorInstanceId'] -ceq $killedStatus.instanceId -and
        [string]$recoveryFailure.Data['PriorRecordDigest'] -match '^[0-9a-f]{64}$') `
        -Message 'recovery-required error omitted its safe binding identity'
    $recoveryStatus = Get-DysonHostMutationLeaseStatus -DataRoot $killRoot
    Assert-LeaseSelfTest -Condition ($recoveryStatus.state -ceq 'recovery-required') `
        -Message 'hard-crash record was not sealed recovery-required'
    $wrongRecoveryPrefix = if ($recoveryStatus.recordDigest[0] -ceq '0') { '1' } else { '0' }
    $wrongRecoveryDigest = $wrongRecoveryPrefix + $recoveryStatus.recordDigest.Substring(1)
    [void](Assert-LeaseFailure -Code 'DYSON_HOST_MUTATION_LEASE_RECOVERY_BINDING_INVALID' `
        -Message 'a wrong recovery digest was accepted' -Action {
            Enter-DysonHostMutationLease -DataRoot $killRoot -Owner selftest `
                -Operation kill-recovery -RequestId kill-wrong -OwnerPid $PID -TimeoutMilliseconds 0 `
                -RecoveryPriorInstanceId $recoveryStatus.instanceId `
                -RecoveryPriorRecordDigest $wrongRecoveryDigest
        })
    $killRecovery = Enter-DysonHostMutationLease -DataRoot $killRoot -Owner selftest `
        -Operation kill-recovery -RequestId kill-recovery -OwnerPid $PID -TimeoutMilliseconds 0 `
        -RecoveryPriorInstanceId $recoveryStatus.instanceId `
        -RecoveryPriorRecordDigest $recoveryStatus.recordDigest
    Assert-LeaseSelfTest -Condition ($killRecovery.Record.recoveryOfInstanceId -ceq $recoveryStatus.instanceId -and
        $killRecovery.Record.recoveryOfRecordDigest -ceq $recoveryStatus.recordDigest) `
        -Message 'recovery lease did not bind the exact prior record'
    [void](Exit-DysonHostMutationLease -Lease $killRecovery)

    [pscustomobject][ordered]@{
        protocol = 'DYSON_HOST_MUTATION_LEASE_SELFTEST_V1'
        state = 'passed'
        windowsPowerShell = '5.1'
        cases = 21
    } | ConvertTo-Json -Compress
}
finally {
    if ($null -ne $substituteDrive) {
        try {
            [void][DysonHostMutationLeaseSelfTestNativeMethodsV1]::DefineDosDevice(
                [uint32]7,
                $substituteDrive,
                $substituteTarget
            )
        }
        catch {}
        $substituteDrive = $null
        $substituteTarget = $null
    }
    foreach ($process in $createdProcesses) {
        try { if (-not $process.HasExited) { $process.Kill() } } catch {}
        try { $process.Dispose() } catch {}
    }
    $resolvedRoot = [System.IO.Path]::GetFullPath($testRoot)
    $requiredPrefix = $temporaryBase + [System.IO.Path]::DirectorySeparatorChar + 'dyson-host-mutation-lease-selftest-'
    if ($resolvedRoot.StartsWith($requiredPrefix, [System.StringComparison]::OrdinalIgnoreCase) -and
        (Test-Path -LiteralPath $resolvedRoot)) {
        Remove-Item -LiteralPath $resolvedRoot -Recurse -Force -ErrorAction SilentlyContinue
    }
}
