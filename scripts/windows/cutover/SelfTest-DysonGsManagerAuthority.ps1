[CmdletBinding()]
param()

Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)

$subject = Join-Path $PSScriptRoot 'Initialize-DysonGsManagerAuthority.ps1'
$authorityCommon = Join-Path $PSScriptRoot 'DysonGsManagerAuthority.Common.ps1'
$leaseCommon = Join-Path (Split-Path $PSScriptRoot -Parent) 'DysonHostMutationLease.Common.ps1'
. $leaseCommon
. $authorityCommon
$powerShellExe = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
$serviceUser = '.\DysonServer'
$scratch = Join-Path ([IO.Path]::GetTempPath()) ('dyson-gs-authority-' + [guid]::NewGuid().ToString('N'))

function Assert-SelfTest {
    param([Parameter(Mandatory)][bool]$Condition, [Parameter(Mandatory)][string]$Message)
    if (-not $Condition) { throw $Message }
}

function Assert-SelfTestAuthorityAclModel {
    $aclServiceUser = [Security.Principal.WindowsIdentity]::GetCurrent().Name
    $security = New-GsAuthorityDirectorySecurity $aclServiceUser -GrantServiceRead -GrantLocalServiceRead
    Assert-SelfTest ([bool]$security.AreAccessRulesProtected) 'Authority ACL inheritance was not disabled.'
    $rules = @($security.GetAccessRules($true, $false, [Security.Principal.NTAccount]))
    Assert-SelfTest ($rules.Count -eq 4) 'Authority ACL did not contain the exact four principals.'
    $readOnlyRights = [Security.AccessControl.FileSystemRights]::ReadAndExecute -bor
        [Security.AccessControl.FileSystemRights]::Synchronize
    $expected = [ordered]@{
        'NT AUTHORITY\SYSTEM' = [Security.AccessControl.FileSystemRights]::FullControl
        'BUILTIN\Administrators' = [Security.AccessControl.FileSystemRights]::FullControl
        $aclServiceUser = $readOnlyRights
        'NT AUTHORITY\LOCAL SERVICE' = $readOnlyRights
    }
    foreach ($entry in $expected.GetEnumerator()) {
        $match = @($rules | Where-Object {
            [string]::Equals([string]$_.IdentityReference, [string]$entry.Key, [StringComparison]::OrdinalIgnoreCase)
        })
        Assert-SelfTest ($match.Count -eq 1) ('Authority ACL principal mismatch: ' + $entry.Key)
        Assert-SelfTest ([string]$match[0].AccessControlType -ceq 'Allow' -and
            [int]$match[0].FileSystemRights -eq [int]$entry.Value -and
            [string]$match[0].InheritanceFlags -ceq 'ContainerInherit, ObjectInherit' -and
            [string]$match[0].PropagationFlags -ceq 'None') ('Authority ACL rights mismatch: ' + $entry.Key)
    }
    $writeMask = [Security.AccessControl.FileSystemRights]::Write -bor
        [Security.AccessControl.FileSystemRights]::Delete -bor
        [Security.AccessControl.FileSystemRights]::DeleteSubdirectoriesAndFiles -bor
        [Security.AccessControl.FileSystemRights]::ChangePermissions -bor
        [Security.AccessControl.FileSystemRights]::TakeOwnership
    $writers = @($rules | Where-Object { ([int]$_.FileSystemRights -band [int]$writeMask) -ne 0 })
    Assert-SelfTest ($writers.Count -eq 2 -and
        @($writers | Where-Object { [string]$_.IdentityReference -in @('NT AUTHORITY\SYSTEM', 'BUILTIN\Administrators') }).Count -eq 2) `
        'Authority ACL granted generalized write authority.'

    $tokens = $null
    $parseErrors = $null
    $ast = [Management.Automation.Language.Parser]::ParseFile($subject, [ref]$tokens, [ref]$parseErrors)
    Assert-SelfTest ($parseErrors.Count -eq 0) 'Authority initializer did not parse.'
    $calls = @($ast.FindAll({
        param($node)
        $node -is [Management.Automation.Language.CommandAst] -and
            $node.GetCommandName() -ceq 'Protect-GsAuthorityDirectory' -and
            $node.Extent.Text.Contains('$authorityRootCandidate')
    }, $true))
    Assert-SelfTest ($calls.Count -eq 1) 'Authority private-root ACL call was ambiguous.'
    $parameters = @($calls[0].CommandElements | Where-Object {
        $_ -is [Management.Automation.Language.CommandParameterAst]
    } | ForEach-Object { $_.ParameterName })
    Assert-SelfTest ($parameters -ccontains 'GrantServiceRead' -and $parameters -ccontains 'GrantLocalServiceRead') `
        'Authority private-root ACL omitted a required read-only principal.'
}

function Write-SelfTestText {
    param([Parameter(Mandatory)][string]$Path, [Parameter(Mandatory)][AllowEmptyString()][string]$Text)
    $parent = [IO.Path]::GetDirectoryName($Path)
    if (-not (Test-Path -LiteralPath $parent)) { [void][IO.Directory]::CreateDirectory($parent) }
    [IO.File]::WriteAllText($Path, $Text, [Text.UTF8Encoding]::new($false))
}

function Write-SelfTestJson {
    param([Parameter(Mandatory)][string]$Path, [Parameter(Mandatory)]$Value)
    Write-SelfTestText $Path (($Value | ConvertTo-Json -Depth 32 -Compress) + "`n")
}

function New-SelfTestTask {
    param(
        [Parameter(Mandatory)][string]$Name,
        [Parameter(Mandatory)]$Descriptor,
        [bool]$Enabled = $true,
        [bool]$Running = $false
    )
    $xml = '<Task><Name>' + $Name + '</Name><Fixture>' +
        [Convert]::ToBase64String([Text.UTF8Encoding]::new($false).GetBytes(($Descriptor | ConvertTo-Json -Depth 16 -Compress))) +
        '</Fixture></Task>'
    return [pscustomobject][ordered]@{
        taskName = $Name; taskPath = '\'
        xmlBase64 = [Convert]::ToBase64String([Text.UTF8Encoding]::new($false).GetBytes($xml))
        enabled = $Enabled; running = $Running; descriptor = $Descriptor
    }
}

function New-SelfTestLegacyDescriptor {
    param([Parameter(Mandatory)][string]$ScriptPath)
    return [pscustomobject][ordered]@{
        actionCount = 1
        execute = $powerShellExe
        arguments = '-NoLogo -NoProfile -ExecutionPolicy Bypass -File "' + $ScriptPath + '"'
        userId = $serviceUser
        logonType = 'Interactive'
        runLevel = 'Limited'
        triggerCount = 0
        principal = [pscustomobject][ordered]@{ userId = $serviceUser; logonType = 'Interactive'; runLevel = 'Limited' }
        settings = [pscustomobject][ordered]@{ multipleInstances = 'IgnoreNew'; executionTimeLimit = 'PT0S' }
    }
}

function New-SelfTestFixture {
    param([Parameter(Mandatory)][string]$Name, [bool]$PanelRunning = $true)
    $root = Join-Path $scratch $Name
    $project = Join-Path $root 'project'
    $data = Join-Path $root 'data'
    $bootstrap = Join-Path $root 'bootstrap'
    $runtimeTransactions = Join-Path $root 'runtime-task-transactions'
    $shadow = Join-Path $root 'shadow'
    foreach ($directory in @($project, $data, $bootstrap, $runtimeTransactions, $shadow)) {
        [void][IO.Directory]::CreateDirectory($directory)
    }
    $sourceStart = Join-Path $project 'ops\start-dyson-server.ps1'
    $sourceStop = Join-Path $project 'ops\stop-dyson-server.ps1'
    $envPath = Join-Path $project 'manager\gsm3\.env'
    Write-SelfTestText $sourceStart "'legacy start'`n"
    Write-SelfTestText $sourceStop "'legacy stop'`n"
    Write-SelfTestText $envPath "KEEP=value`r`nDYSON_SERVER_TASK=Dyson-Nebula-Server`r`nDYSON_STOP_TASK=Dyson-Nebula-Stop`r`n"
    Write-SelfTestText (Join-Path $bootstrap 'Start-DysonServer.ps1') "'bootstrap start'`n"
    Write-SelfTestText (Join-Path $bootstrap 'Stop-DysonServer.ps1') "'bootstrap stop'`n"
    Write-SelfTestText (Join-Path $shadow '.dyson-gsmanager-authority-selftest') "fixture`n"
    Write-SelfTestText (Join-Path $shadow 'writes.log') ''
    $panelDescriptor = [pscustomobject][ordered]@{
        actionCount = 1; execute = $powerShellExe; arguments = '-NoProfile -Command "panel"'
        userId = 'SYSTEM'; logonType = 'ServiceAccount'; runLevel = 'Limited'; triggerCount = 1
        principal = [pscustomobject]@{ userId = 'SYSTEM' }; settings = [pscustomobject]@{ enabled = $true }
    }
    $tasks = @(
        New-SelfTestTask 'Dyson-GSManager' $panelDescriptor $true $PanelRunning
        New-SelfTestTask 'Dyson-Nebula-Server' (New-SelfTestLegacyDescriptor $sourceStart) $true $false
        New-SelfTestTask 'Dyson-Nebula-Stop' (New-SelfTestLegacyDescriptor $sourceStop) $true $false
    )
    Write-SelfTestJson (Join-Path $shadow 'tasks.json') ([ordered]@{
        protocol = 'DYSON_GSMANAGER_AUTHORITY_SHADOW_V1'; tasks = $tasks
    })
    Write-SelfTestJson (Join-Path $shadow 'runtime.json') ([ordered]@{
        dspGameProcess = $false; tcp8469 = $false; udp8469 = $false
    })
    return [pscustomobject][ordered]@{
        Root = $root; Project = $project; Data = $data; Bootstrap = $bootstrap
        RuntimeTransactions = $runtimeTransactions; Shadow = $shadow; EnvPath = $envPath
        OriginalEnv = [IO.File]::ReadAllBytes($envPath); OriginalTasks = [IO.File]::ReadAllBytes((Join-Path $shadow 'tasks.json'))
    }
}

function Quote-SelfTestPowerShellLiteral {
    param([Parameter(Mandatory)][string]$Value)
    return "'" + $Value.Replace("'", "''") + "'"
}

function Invoke-SelfTestSubject {
    param(
        [Parameter(Mandatory)]$Fixture,
        [Parameter(Mandatory)][string]$RequestId,
        [switch]$Recover,
        [switch]$WhatIf,
        [string]$FailPoint,
        [string]$LeaseInstanceId,
        [string]$LeaseToken,
        [string]$DataRootOverride
    )
    $effectiveData = if ([string]::IsNullOrWhiteSpace($DataRootOverride)) { $Fixture.Data } else { $DataRootOverride }
    $parts = @(
        '&', (Quote-SelfTestPowerShellLiteral $subject),
        '-ProjectRoot', (Quote-SelfTestPowerShellLiteral $Fixture.Project),
        '-DataRoot', (Quote-SelfTestPowerShellLiteral $effectiveData),
        '-RuntimeBootstrapRoot', (Quote-SelfTestPowerShellLiteral $Fixture.Bootstrap),
        '-RuntimeTaskTransactionRoot', (Quote-SelfTestPowerShellLiteral $Fixture.RuntimeTransactions),
        '-ServiceUser', (Quote-SelfTestPowerShellLiteral $serviceUser),
        '-RequestId', (Quote-SelfTestPowerShellLiteral $RequestId),
        '-Backend', 'Shadow', '-ShadowRoot', (Quote-SelfTestPowerShellLiteral $Fixture.Shadow),
        '-Confirm:$false'
    )
    if ($Recover) { $parts += '-Recover' }
    if ($WhatIf) { $parts += '-WhatIf' }
    if (-not [string]::IsNullOrWhiteSpace($LeaseInstanceId)) {
        $parts += @('-LeaseInstanceId', (Quote-SelfTestPowerShellLiteral $LeaseInstanceId))
    }
    if (-not [string]::IsNullOrWhiteSpace($LeaseToken)) {
        $parts += @('-LeaseToken', (Quote-SelfTestPowerShellLiteral $LeaseToken))
    }
    $command = $parts -join ' '
    $encoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($command))
    $start = [Diagnostics.ProcessStartInfo]::new()
    $start.FileName = $powerShellExe
    $start.Arguments = '-NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand ' + $encoded
    $start.UseShellExecute = $false
    $start.CreateNoWindow = $true
    $start.RedirectStandardOutput = $true
    $start.RedirectStandardError = $true
    $start.EnvironmentVariables['DYSON_GSMANAGER_AUTHORITY_SELFTEST'] = '1'
    if (-not [string]::IsNullOrWhiteSpace($FailPoint)) {
        $start.EnvironmentVariables['DYSON_GSMANAGER_AUTHORITY_SELFTEST_FAIL_POINT'] = $FailPoint
    }
    $process = [Diagnostics.Process]::new()
    $process.StartInfo = $start
    [void]$process.Start()
    $stdout = $process.StandardOutput.ReadToEnd()
    $stderr = $process.StandardError.ReadToEnd()
    $process.WaitForExit()
    $json = $null
    $lines = @($stdout -split '\r?\n' | Where-Object { -not [string]::IsNullOrWhiteSpace($_) })
    if ($lines.Count -gt 0) {
        try { $json = $lines[-1] | ConvertFrom-Json -ErrorAction Stop }
        catch {}
    }
    return [pscustomobject]@{ ExitCode = $process.ExitCode; Stdout = $stdout; Stderr = $stderr; Json = $json }
}

function Invoke-SelfTestRuntimeInstaller {
    param(
        [Parameter(Mandatory)]$Fixture,
        [Parameter(Mandatory)][ValidateSet('PrepareDisabled', 'Activate')][string]$Mode,
        [Parameter(Mandatory)][string]$RequestId,
        [Parameter(Mandatory)][string]$SchedulerRoot
    )
    if (-not (Test-Path -LiteralPath $SchedulerRoot)) { [void][IO.Directory]::CreateDirectory($SchedulerRoot) }
    Write-SelfTestText (Join-Path $SchedulerRoot '.dyson-runtime-task-selftest') "fixture`n"
    $installer = Join-Path (Split-Path $PSScriptRoot -Parent) 'Install-DysonRuntimeTasks.ps1'
    $parts = @(
        '&', (Quote-SelfTestPowerShellLiteral $installer),
        '-ProjectRoot', (Quote-SelfTestPowerShellLiteral $Fixture.Project),
        '-DataRoot', (Quote-SelfTestPowerShellLiteral $Fixture.Data),
        '-InstalledScriptRoot', (Quote-SelfTestPowerShellLiteral $Fixture.Bootstrap),
        '-ServiceUser', (Quote-SelfTestPowerShellLiteral $serviceUser),
        '-Mode', $Mode, '-RequestId', (Quote-SelfTestPowerShellLiteral $RequestId),
        '-TaskBackupRoot', (Quote-SelfTestPowerShellLiteral $Fixture.RuntimeTransactions),
        '-SchedulerBackend', 'Shadow', '-ShadowSchedulerRoot', (Quote-SelfTestPowerShellLiteral $SchedulerRoot),
        '-Confirm:$false'
    )
    $encoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes(($parts -join ' ')))
    $start = [Diagnostics.ProcessStartInfo]::new()
    $start.FileName = $powerShellExe
    $start.Arguments = '-NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand ' + $encoded
    $start.UseShellExecute = $false; $start.CreateNoWindow = $true
    $start.RedirectStandardOutput = $true; $start.RedirectStandardError = $true
    $start.EnvironmentVariables['DYSON_RUNTIME_TASK_SELFTEST'] = '1'
    $process = [Diagnostics.Process]::new(); $process.StartInfo = $start; [void]$process.Start()
    $stdout = $process.StandardOutput.ReadToEnd(); $stderr = $process.StandardError.ReadToEnd(); $process.WaitForExit()
    return [pscustomobject]@{ ExitCode = $process.ExitCode; Stdout = $stdout; Stderr = $stderr }
}

function Get-SelfTestDescriptorSha256 {
    param([Parameter(Mandatory)]$Descriptor)
    $json = $Descriptor | ConvertTo-Json -Depth 16 -Compress
    $bytes = [Text.UTF8Encoding]::new($false).GetBytes($json)
    $hasher = [Security.Cryptography.SHA256]::Create()
    try { return ([BitConverter]::ToString($hasher.ComputeHash($bytes))).Replace('-', '').ToLowerInvariant() }
    finally { $hasher.Dispose() }
}

function Assert-SelfTestCode {
    param([Parameter(Mandatory)]$Result, [Parameter(Mandatory)][string]$Code)
    Assert-SelfTest ($Result.ExitCode -ne 0) ('Expected failure code ' + $Code + ', process succeeded.')
    Assert-SelfTest ($null -ne $Result.Json) ('Missing JSON error for ' + $Code + '. stderr=' + $Result.Stderr)
    Assert-SelfTest ([string]$Result.Json.error.code -ceq $Code) ('Expected ' + $Code + ', got ' + [string]$Result.Json.error.code)
    Assert-SelfTest (-not (($Result.Stdout + $Result.Stderr) -match [regex]::Escape($Result.Json.error.code + '\'))) 'Failure output leaked a path.'
}

function Get-SelfTestTasks {
    param([Parameter(Mandatory)]$Fixture)
    return @((Get-Content -LiteralPath (Join-Path $Fixture.Shadow 'tasks.json') -Raw | ConvertFrom-Json).tasks)
}

function Get-SelfTestTask {
    param([Parameter(Mandatory)]$Fixture, [Parameter(Mandatory)][string]$Name)
    return @(Get-SelfTestTasks $Fixture | Where-Object { [string]$_.taskName -ceq $Name })[0]
}

function Assert-SelfTestLivePreimage {
    param([Parameter(Mandatory)]$Fixture)
    Assert-SelfTest ([Convert]::ToBase64String([IO.File]::ReadAllBytes($Fixture.EnvPath)) -ceq [Convert]::ToBase64String($Fixture.OriginalEnv)) 'Environment preimage was not restored.'
    $original = @(([Text.UTF8Encoding]::new($false).GetString($Fixture.OriginalTasks) | ConvertFrom-Json).tasks)
    $actual = @(Get-SelfTestTasks $Fixture)
    Assert-SelfTest ($original.Count -eq $actual.Count) 'Task preimage count was not restored.'
    foreach ($expected in $original) {
        $match = @($actual | Where-Object { [string]$_.taskName -ceq [string]$expected.taskName -and [string]$_.taskPath -ceq [string]$expected.taskPath })
        Assert-SelfTest ($match.Count -eq 1 -and [string]$match[0].xmlBase64 -ceq [string]$expected.xmlBase64 -and
            [bool]$match[0].enabled -eq [bool]$expected.enabled -and [bool]$match[0].running -eq [bool]$expected.running) 'Task preimage was not restored.'
    }
    Assert-SelfTest (-not (Test-Path -LiteralPath (Join-Path $Fixture.Data 'private\gsmanager-authority\start-dyson-server.ps1'))) 'Authority start copy survived rollback.'
    Assert-SelfTest (-not (Test-Path -LiteralPath (Join-Path $Fixture.Data 'authority-inventory\authority-profile.json'))) 'Authority profile survived rollback.'
}

try {
    Assert-SelfTestAuthorityAclModel
    [void][IO.Directory]::CreateDirectory($scratch)

    $whatIfFixture = New-SelfTestFixture 'whatif'
    $whatIfRequest = [guid]::NewGuid().ToString('D')
    $whatIf = Invoke-SelfTestSubject $whatIfFixture $whatIfRequest -WhatIf
    Assert-SelfTest ($whatIf.ExitCode -eq 0 -and [bool]$whatIf.Json.dryRun) 'WhatIf did not return a preview.'
    Assert-SelfTestLivePreimage $whatIfFixture
    Assert-SelfTest ((Get-Item (Join-Path $whatIfFixture.Shadow 'writes.log')).Length -eq 0) 'WhatIf wrote through the shadow scheduler.'

    $successFixture = New-SelfTestFixture 'success'
    $successRequest = [guid]::NewGuid().ToString('D')
    $success = Invoke-SelfTestSubject $successFixture $successRequest
    Assert-SelfTest ($success.ExitCode -eq 0 -and [string]$success.Json.status -ceq 'succeeded') ('Success failed: ' + $success.Stdout + $success.Stderr)
    Assert-SelfTest (-not [bool](Get-SelfTestTask $successFixture 'Dyson-Nebula-Server').enabled) 'Legacy start task was not disabled.'
    Assert-SelfTest (-not [bool](Get-SelfTestTask $successFixture 'Dyson-Nebula-Stop').enabled) 'Legacy stop task was not disabled.'
    Assert-SelfTest ([bool](Get-SelfTestTask $successFixture 'Dyson-GSManager-Server').enabled) 'Previous start task was not enabled.'
    Assert-SelfTest ([bool](Get-SelfTestTask $successFixture 'Dyson-GSManager-Stop').enabled) 'Previous stop task was not enabled.'
    $updatedEnv = [IO.File]::ReadAllText($successFixture.EnvPath, [Text.UTF8Encoding]::new($false))
    Assert-SelfTest ($updatedEnv -match '(?m)^KEEP=value\r?$') 'Unrelated env content changed.'
    Assert-SelfTest ($updatedEnv -match '(?m)^DYSON_SERVER_TASK=Dyson-GSManager-Server\r?$') 'Server task env was not updated.'
    Assert-SelfTest ($updatedEnv -match '(?m)^DYSON_STOP_TASK=Dyson-GSManager-Stop\r?$') 'Stop task env was not updated.'
    $profilePath = Join-Path $successFixture.Data 'authority-inventory\authority-profile.json'
    $profile = Get-Content -LiteralPath $profilePath -Raw | ConvertFrom-Json
    Assert-SelfTest ([string]$profile.protocol -ceq 'DYSON_GSMANAGER_AUTHORITY_PROFILE_V1') 'Authority profile is missing.'
    Assert-SelfTest ([string]$profile.inventoryRevision -match '^[0-9a-f]{64}$') 'Inventory revision is invalid.'
    Assert-SelfTest ($profile.candidateAuthority.allowedTransitions.Count -eq 3) 'Allowed transition set is incomplete.'
    $node = @(Get-Command -Name node -CommandType Application -ErrorAction Stop)[0].Path
    $nodeRevision = & $node -e "const fs=require('fs'),c=require('crypto'),p=JSON.parse(fs.readFileSync(process.argv[1],'utf8')),r=p.inventoryRevision;delete p.inventoryRevision;process.stdout.write(c.createHash('sha256').update(JSON.stringify(p),'utf8').digest('hex'))" $profilePath
    Assert-SelfTest ($LASTEXITCODE -eq 0 -and [string]$nodeRevision -ceq [string]$profile.inventoryRevision) 'PowerShell and Node inventory revision bytes differ.'
    $repositoryRoot = Split-Path (Split-Path (Split-Path $PSScriptRoot -Parent) -Parent) -Parent
    $apiRoot = Join-Path $repositoryRoot 'apps\api'
    $tsxCli = Join-Path $apiRoot 'node_modules\tsx\dist\cli.mjs'
    $priorProfileOptions = $env:DYSON_GS_AUTHORITY_PROFILE_SELFTEST_OPTIONS
    try {
        $env:DYSON_GS_AUTHORITY_PROFILE_SELFTEST_OPTIONS = ([ordered]@{
            profileFile = $profilePath; projectRoot = $successFixture.Project; dataRoot = $successFixture.Data
            runtimeBootstrapRoot = $successFixture.Bootstrap
            runtimeTaskTransactionRoot = $successFixture.RuntimeTransactions
            serviceUser = $serviceUser; gamePort = 8469
        } | ConvertTo-Json -Compress)
        Push-Location $apiRoot
        try {
            $profileReaderOutput = & $node $tsxCli -e "import {readCutoverAuthorityProfile} from './src/cutover/profile.ts';readCutoverAuthorityProfile(JSON.parse(process.env.DYSON_GS_AUTHORITY_PROFILE_SELFTEST_OPTIONS));process.stdout.write('profile-ok')" 2>&1
            $profileReaderExit = $LASTEXITCODE
        }
        finally { Pop-Location }
        Assert-SelfTest ($profileReaderExit -eq 0 -and [string]$profileReaderOutput -match 'profile-ok') ('The API authority profile reader rejected the generated profile: ' + [string]$profileReaderOutput)
    }
    finally { $env:DYSON_GS_AUTHORITY_PROFILE_SELFTEST_OPTIONS = $priorProfileOptions }
    $runtimeShadow = Join-Path $successFixture.Root 'runtime-scheduler-shadow'
    $prepared = Invoke-SelfTestRuntimeInstaller $successFixture 'PrepareDisabled' ([guid]::NewGuid().ToString('D')) $runtimeShadow
    Assert-SelfTest ($prepared.ExitCode -eq 0) ('Runtime PrepareDisabled fixture failed: ' + $prepared.Stdout + $prepared.Stderr)
    $preparedStart = Get-Content (Join-Path $runtimeShadow 'start-task.json') -Raw | ConvertFrom-Json
    $preparedStop = Get-Content (Join-Path $runtimeShadow 'stop-task.json') -Raw | ConvertFrom-Json
    Assert-SelfTest ((Get-SelfTestDescriptorSha256 $preparedStart.descriptor) -ceq [string]$profile.candidateAuthority.expectedPreparedDisabled.startDescriptorSha256) 'PreparedDisabled start descriptor digest differs from Install-DysonRuntimeTasks.'
    Assert-SelfTest ((Get-SelfTestDescriptorSha256 $preparedStop.descriptor) -ceq [string]$profile.candidateAuthority.expectedPreparedDisabled.stopDescriptorSha256) 'PreparedDisabled stop descriptor digest differs from Install-DysonRuntimeTasks.'
    $active = Invoke-SelfTestRuntimeInstaller $successFixture 'Activate' ([guid]::NewGuid().ToString('D')) $runtimeShadow
    Assert-SelfTest ($active.ExitCode -eq 0) ('Runtime Activate fixture failed: ' + $active.Stdout + $active.Stderr)
    $activeStart = Get-Content (Join-Path $runtimeShadow 'start-task.json') -Raw | ConvertFrom-Json
    $activeStop = Get-Content (Join-Path $runtimeShadow 'stop-task.json') -Raw | ConvertFrom-Json
    Assert-SelfTest ((Get-SelfTestDescriptorSha256 $activeStart.descriptor) -ceq [string]$profile.candidateAuthority.expectedActive.startDescriptorSha256) 'Active start descriptor digest differs from Install-DysonRuntimeTasks.'
    Assert-SelfTest ((Get-SelfTestDescriptorSha256 $activeStop.descriptor) -ceq [string]$profile.candidateAuthority.expectedActive.stopDescriptorSha256) 'Active stop descriptor digest differs from Install-DysonRuntimeTasks.'
    $profileAfterRuntimeTransitions = Get-Content -LiteralPath $profilePath -Raw | ConvertFrom-Json
    Assert-SelfTest ([string]$profileAfterRuntimeTransitions.inventoryRevision -ceq [string]$profile.inventoryRevision) 'Inventory revision changed across candidate transitions.'
    $replay = Invoke-SelfTestSubject $successFixture $successRequest
    Assert-SelfTest ($replay.ExitCode -eq 0 -and [bool]$replay.Json.reused) 'Successful replay was not idempotent.'

    foreach ($failureCase in @(
        @('second-task', 'SecondTaskRegister'),
        @('env-write', 'EnvWrite'),
        @('panel-restart', 'PanelRestart')
    )) {
        $fixture = New-SelfTestFixture $failureCase[0]
        $result = Invoke-SelfTestSubject $fixture ([guid]::NewGuid().ToString('D')) -FailPoint $failureCase[1]
        Assert-SelfTestCode $result 'DYSON_GSMANAGER_AUTHORITY_FAILED_ROLLED_BACK'
        Assert-SelfTestLivePreimage $fixture
    }

    $hardFixture = New-SelfTestFixture 'hard-exit'
    $hardRequest = [guid]::NewGuid().ToString('D')
    $hard = Invoke-SelfTestSubject $hardFixture $hardRequest -FailPoint 'HardExitAfterEnv'
    Assert-SelfTest ($hard.ExitCode -eq 92) 'Hard-exit fail point did not terminate at the intended boundary.'
    $blocked = Invoke-SelfTestSubject $hardFixture $hardRequest
    Assert-SelfTestCode $blocked 'DYSON_GSMANAGER_AUTHORITY_RECOVERY_REQUIRED'
    $recovered = Invoke-SelfTestSubject $hardFixture $hardRequest -Recover
    Assert-SelfTest ($recovered.ExitCode -eq 0 -and [string]$recovered.Json.status -ceq 'rolled-back') ('Standalone recovery failed: ' + $recovered.Stdout + $recovered.Stderr)
    Assert-SelfTestLivePreimage $hardFixture

    $terminalFixture = New-SelfTestFixture 'hard-exit-terminal'
    $terminalRequest = [guid]::NewGuid().ToString('D')
    $terminalHard = Invoke-SelfTestSubject $terminalFixture $terminalRequest -FailPoint 'HardExitAfterReceipt'
    Assert-SelfTest ($terminalHard.ExitCode -eq 93) 'Terminal hard-exit fail point did not occur.'
    $writesBeforeTerminalRecovery = [IO.File]::ReadAllText((Join-Path $terminalFixture.Shadow 'writes.log'))
    $terminalRecovered = Invoke-SelfTestSubject $terminalFixture $terminalRequest -Recover
    Assert-SelfTest ($terminalRecovered.ExitCode -eq 0 -and [string]$terminalRecovered.Json.status -ceq 'succeeded' -and [bool]$terminalRecovered.Json.reused) 'Terminal recovery did not replay the durable success receipt.'
    Assert-SelfTest ([IO.File]::ReadAllText((Join-Path $terminalFixture.Shadow 'writes.log')) -ceq $writesBeforeTerminalRecovery) 'Terminal receipt recovery repeated scheduler writes.'
    Assert-SelfTest (-not (Test-Path -LiteralPath (Join-Path $terminalFixture.Data 'private\gsmanager-authority-transactions\active-intent.json'))) 'Terminal recovery did not clear the intent.'

    $borrowFixture = New-SelfTestFixture 'borrow'
    $borrowRequest = [guid]::NewGuid().ToString('D')
    $outer = Enter-DysonHostMutationLease -DataRoot $borrowFixture.Data -Owner 'gs-authority-selftest' `
        -Operation 'cutover-parent' -RequestId $borrowRequest -OwnerPid $PID -TimeoutMilliseconds 0
    try {
        $borrowed = Invoke-SelfTestSubject $borrowFixture $borrowRequest `
            -LeaseInstanceId $outer.InstanceId -LeaseToken $outer.Token
        Assert-SelfTest ($borrowed.ExitCode -eq 0) ('Borrowed mutation failed: ' + $borrowed.Stdout + $borrowed.Stderr)
        Assert-SelfTest ([bool]$outer.Active) 'Child released the outer lease object.'
        $status = Get-DysonHostMutationLeaseStatus -DataRoot $borrowFixture.Data
        Assert-SelfTest ([string]$status.state -ceq 'active' -and [string]$status.instanceId -ceq [string]$outer.InstanceId) 'Child changed the outer lease record.'
    }
    finally { if ($outer.Active) { [void](Exit-DysonHostMutationLease $outer released) } }

    $borrowRecoveryFixture = New-SelfTestFixture 'borrow-recovery'
    $borrowRecoveryRequest = [guid]::NewGuid().ToString('D')
    $outerRecovery = Enter-DysonHostMutationLease -DataRoot $borrowRecoveryFixture.Data -Owner 'gs-authority-selftest' `
        -Operation 'cutover-parent' -RequestId $borrowRecoveryRequest -OwnerPid $PID -TimeoutMilliseconds 0
    try {
        $borrowHard = Invoke-SelfTestSubject $borrowRecoveryFixture $borrowRecoveryRequest -FailPoint 'HardExitAfterEnv' `
            -LeaseInstanceId $outerRecovery.InstanceId -LeaseToken $outerRecovery.Token
        Assert-SelfTest ($borrowHard.ExitCode -eq 92) 'Borrowed hard exit did not occur.'
        $borrowRecovered = Invoke-SelfTestSubject $borrowRecoveryFixture $borrowRecoveryRequest -Recover `
            -LeaseInstanceId $outerRecovery.InstanceId -LeaseToken $outerRecovery.Token
        Assert-SelfTest ($borrowRecovered.ExitCode -eq 0 -and [string]$borrowRecovered.Json.status -ceq 'rolled-back') 'Borrowed recovery failed.'
        Assert-SelfTest ([bool]$outerRecovery.Active) 'Borrowed recovery released the outer lease.'
        Assert-SelfTestLivePreimage $borrowRecoveryFixture
    }
    finally { if ($outerRecovery.Active) { [void](Exit-DysonHostMutationLease $outerRecovery released) } }

    foreach ($invalidBorrow in @('token', 'root')) {
        $fixture = New-SelfTestFixture ('wrong-' + $invalidBorrow)
        $request = [guid]::NewGuid().ToString('D')
        $lease = Enter-DysonHostMutationLease -DataRoot $fixture.Data -Owner 'gs-authority-selftest' `
            -Operation 'cutover-parent' -RequestId $request -OwnerPid $PID -TimeoutMilliseconds 0
        try {
            if ($invalidBorrow -ceq 'token') {
                $result = Invoke-SelfTestSubject $fixture $request -LeaseInstanceId $lease.InstanceId `
                    -LeaseToken ('A' * 43)
            }
            else {
                $wrongRoot = Join-Path $fixture.Root 'wrong-data'
                [void][IO.Directory]::CreateDirectory($wrongRoot)
                $result = Invoke-SelfTestSubject $fixture $request -LeaseInstanceId $lease.InstanceId `
                    -LeaseToken $lease.Token -DataRootOverride $wrongRoot
            }
            Assert-SelfTestCode $result 'DYSON_HOST_MUTATION_LEASE_BORROW_INVALID'
            Assert-SelfTestLivePreimage $fixture
        }
        finally { if ($lease.Active) { [void](Exit-DysonHostMutationLease $lease released) } }
    }

    foreach ($block in @(
        @('process', 'dspGameProcess', 'DYSON_GSMANAGER_AUTHORITY_DSP_RUNNING'),
        @('tcp', 'tcp8469', 'DYSON_GSMANAGER_AUTHORITY_TCP_LISTENER_PRESENT'),
        @('udp', 'udp8469', 'DYSON_GSMANAGER_AUTHORITY_UDP_LISTENER_PRESENT')
    )) {
        $fixture = New-SelfTestFixture ('blocked-' + $block[0])
        $runtimePath = Join-Path $fixture.Shadow 'runtime.json'
        $runtime = Get-Content $runtimePath -Raw | ConvertFrom-Json
        $runtime.($block[1]) = $true
        Write-SelfTestJson $runtimePath $runtime
        $result = Invoke-SelfTestSubject $fixture ([guid]::NewGuid().ToString('D'))
        Assert-SelfTestCode $result $block[2]
        Assert-SelfTestLivePreimage $fixture
        Assert-SelfTest ((Get-Item (Join-Path $fixture.Shadow 'writes.log')).Length -eq 0) 'Blocked preflight wrote scheduler state.'
    }

    foreach ($invalid in @('disabled', 'extra', 'mismatch')) {
        $fixture = New-SelfTestFixture ('invalid-' + $invalid)
        $taskPath = Join-Path $fixture.Shadow 'tasks.json'
        $state = Get-Content $taskPath -Raw | ConvertFrom-Json
        $startTask = @($state.tasks | Where-Object { $_.taskName -ceq 'Dyson-Nebula-Server' })[0]
        if ($invalid -ceq 'disabled') { $startTask.enabled = $false }
        elseif ($invalid -ceq 'extra') { $startTask.descriptor.actionCount = 2 }
        else { $startTask.descriptor.arguments = '-NoProfile -File "C:\\wrong.ps1"' }
        Write-SelfTestJson $taskPath $state
        $fixture.OriginalTasks = [IO.File]::ReadAllBytes($taskPath)
        $expected = if ($invalid -ceq 'disabled') { 'DYSON_GSMANAGER_AUTHORITY_TASK_STATE_INVALID' } else { 'DYSON_GSMANAGER_AUTHORITY_TASK_DEFINITION_MISMATCH' }
        $result = Invoke-SelfTestSubject $fixture ([guid]::NewGuid().ToString('D'))
        Assert-SelfTestCode $result $expected
        Assert-SelfTestLivePreimage $fixture
    }

    $targetPresentFixture = New-SelfTestFixture 'target-present'
    $targetStatePath = Join-Path $targetPresentFixture.Shadow 'tasks.json'
    $targetState = Get-Content $targetStatePath -Raw | ConvertFrom-Json
    $targetState.tasks += New-SelfTestTask 'Dyson-GSManager-Server' `
        (New-SelfTestLegacyDescriptor (Join-Path $targetPresentFixture.Project 'ops\start-dyson-server.ps1')) $true $false
    Write-SelfTestJson $targetStatePath $targetState
    $targetPresentFixture.OriginalTasks = [IO.File]::ReadAllBytes($targetStatePath)
    $targetPresent = Invoke-SelfTestSubject $targetPresentFixture ([guid]::NewGuid().ToString('D'))
    Assert-SelfTestCode $targetPresent 'DYSON_GSMANAGER_AUTHORITY_TARGET_ALREADY_PRESENT'
    Assert-SelfTestLivePreimage $targetPresentFixture

    foreach ($envCase in @('duplicate', 'illegal')) {
        $fixture = New-SelfTestFixture ('env-' + $envCase)
        if ($envCase -ceq 'duplicate') {
            Write-SelfTestText $fixture.EnvPath "DUP=1`nDUP=2`n"
            $expected = 'DYSON_GSMANAGER_AUTHORITY_ENV_DUPLICATE_KEY'
        }
        else {
            Write-SelfTestText $fixture.EnvPath "NOT A KEY`n"
            $expected = 'DYSON_GSMANAGER_AUTHORITY_ENV_INVALID'
        }
        $fixture.OriginalEnv = [IO.File]::ReadAllBytes($fixture.EnvPath)
        $result = Invoke-SelfTestSubject $fixture ([guid]::NewGuid().ToString('D'))
        Assert-SelfTestCode $result $expected
        Assert-SelfTestLivePreimage $fixture
    }

    Write-Output 'Dyson GSManager authority isolation self-test passed.'
}
finally {
    if (Test-Path -LiteralPath $scratch) { Remove-Item -LiteralPath $scratch -Recurse -Force -ErrorAction SilentlyContinue }
}
