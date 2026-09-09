[CmdletBinding()]
param([switch]$DeploymentIdentityUninstallOnly)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$deploymentScript = Join-Path $PSScriptRoot 'Invoke-DysonControlDeployment.ps1'
$installScript = Join-Path $PSScriptRoot 'Install-DysonControl.ps1'
$taskScript = Join-Path $PSScriptRoot 'Install-DysonControlTask.ps1'
$uninstallScript = Join-Path $PSScriptRoot 'Uninstall-DysonControl.ps1'
$statusScript = Join-Path $PSScriptRoot 'Test-DysonControlDeployment.ps1'
$artifactCommonScript = Join-Path $PSScriptRoot '..\release\DysonReleasePackaging.Common.ps1'
$artifactVerifierScript = Join-Path $PSScriptRoot '..\release\Test-DysonControlReleaseArtifact.ps1'
$deploymentCommonScript = Join-Path $PSScriptRoot 'DysonDeployment.Common.ps1'
$deploymentConfigurationScript = Join-Path $PSScriptRoot 'DysonDeployment.Configuration.ps1'
. $artifactCommonScript
. $deploymentCommonScript
. $deploymentConfigurationScript
$temporaryBase = [System.IO.Path]::GetFullPath([System.IO.Path]::GetTempPath()).TrimEnd('\', '/')
$testRoot = Join-Path $temporaryBase ('dyson-control-deployment-selftest-' + [guid]::NewGuid().ToString('N'))
$installRoot = Join-Path $testRoot 'program-files\DysonControl'
$dataRoot = Join-Path $testRoot 'program-data\DysonControl'
$readinessStopPath = Join-Path $testRoot 'stop-readiness-listener'
$readinessJob = $null
$readinessUri = $null
$brokerReadinessStopPath = Join-Path $testRoot 'stop-broker-readiness-listener'
$brokerReadinessJob = $null
$brokerReadinessUri = $null
$taskFixtureEnabled = $false

function Assert-SelfTest {
    param(
        [Parameter(Mandatory)][bool]$Condition,
        [Parameter(Mandatory)][string]$Message
    )
    if (-not $Condition) { throw "SELFTEST_FAILED: $Message" }
}

function Test-DysonBrokerProfileFileAclRestore {
    param([Parameter(Mandatory)][string]$Root)
    $errors=$null; $tokens=$null
    $ast=[Management.Automation.Language.Parser]::ParseFile($installScript,[ref]$tokens,[ref]$errors)
    Assert-SelfTest -Condition ($errors.Count -eq 0) -Message 'installer parse failed'
    foreach($name in @('Assert-DysonDeploymentPlainFile','Set-DysonLifecycleBrokerDeploymentFileBytesAtomic',
        'Restore-DysonLifecycleBrokerDeploymentPreimage','Set-DysonCutoverBrokerDeploymentFileBytesAtomic',
        'Restore-DysonCutoverBrokerDeploymentFileAcls')) {
        $definition=@($ast.FindAll({param($node)
            $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -ceq $name
        },$false))
        if($definition.Count -eq 1){ . ([scriptblock]::Create($definition[0].Extent.Text)) }
        elseif(-not (Get-Command $name -ErrorAction SilentlyContinue)){ throw 'profile ACL test dependency unavailable' }
    }
    $fixture=Join-Path $Root 'profile-file-acl'
    [void][IO.Directory]::CreateDirectory($fixture)
    $profile=Join-Path $fixture 'broker-profile.json'
    $intent=Join-Path $fixture 'broker-profile.sddl'
    $task=Join-Path $fixture 'broker-task.json'
    foreach($file in @($profile,$intent,$task)){[IO.File]::WriteAllText($file,'original fixture state')}
    $identity=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value
    $acl=Get-Acl -LiteralPath $profile
    $acl.SetSecurityDescriptorSddlForm(('D:P(A;;FA;;;{0})(A;;FR;;;LS)' -f $identity),
        [Security.AccessControl.AccessControlSections]::Access)
    Set-Acl -LiteralPath $profile -AclObject $acl
    $originalSddl=(Get-Acl -LiteralPath $profile).Sddl
    $state=[pscustomobject]@{
        profilePath=$profile; profileBytes=[IO.File]::ReadAllBytes($profile)
        profileFileSddl=$originalSddl; profileSddl='separate shadow policy intent'; directoryAcls=@()
        profileAclPath=$intent; profileAclBytes=[IO.File]::ReadAllBytes($intent)
        taskPath=$task; taskBytes=[IO.File]::ReadAllBytes($task)
    }
    $acl=Get-Acl -LiteralPath $profile
    $acl.SetSecurityDescriptorSddlForm(('D:P(A;;FA;;;{0})(A;;FRFX;;;LS)' -f $identity),
        [Security.AccessControl.AccessControlSections]::Access)
    Set-Acl -LiteralPath $profile -AclObject $acl
    [IO.File]::WriteAllText($profile,'replacement fixture state')
    Assert-SelfTest -Condition ((Get-Acl -LiteralPath $profile).Sddl -cne $originalSddl) `
        -Message 'profile ACL regression did not introduce an actual file ACL change'
    Restore-DysonLifecycleBrokerDeploymentPreimage -State $state -ShadowRoot $fixture
    Assert-SelfTest -Condition ((Get-Acl -LiteralPath $profile).Sddl -ceq $originalSddl -and
        [Convert]::ToBase64String([IO.File]::ReadAllBytes($profile)) -ceq
            [Convert]::ToBase64String($state.profileBytes)) `
        -Message 'shadow profile rollback did not restore the real file ACL independently of its policy intent'
    $binding=Join-Path $fixture 'broker-bundle.json'
    [IO.File]::WriteAllText($binding,'original bundle binding')
    $cutoverState=[pscustomobject]@{
        profilePath=$profile; profileBytes=[IO.File]::ReadAllBytes($profile); profileSddl=$originalSddl
        bindingPath=$binding; bindingBytes=[IO.File]::ReadAllBytes($binding)
        bindingSddl=(Get-Acl -LiteralPath $binding).Sddl; directoryAcls=@()
    }
    foreach($file in @($profile,$binding)) {
        $acl=Get-Acl -LiteralPath $file
        $acl.SetSecurityDescriptorSddlForm(('D:P(A;;FA;;;{0})(A;;FRFX;;;LS)' -f $identity),
            [Security.AccessControl.AccessControlSections]::Access)
        Set-Acl -LiteralPath $file -AclObject $acl
        [IO.File]::WriteAllText($file,'replacement cutover state')
    }
    Restore-DysonCutoverBrokerDeploymentFileAcls -State $cutoverState
    Assert-SelfTest -Condition ((Get-Acl -LiteralPath $profile).Sddl -ceq $cutoverState.profileSddl -and
        (Get-Acl -LiteralPath $binding).Sddl -ceq $cutoverState.bindingSddl -and
        [Convert]::ToBase64String([IO.File]::ReadAllBytes($profile)) -ceq
            [Convert]::ToBase64String($cutoverState.profileBytes) -and
        [Convert]::ToBase64String([IO.File]::ReadAllBytes($binding)) -ceq
            [Convert]::ToBase64String($cutoverState.bindingBytes)) `
        -Message 'parent cutover compensation did not restore profile and binding file bytes and exact ACLs'
    $uninstallAst=[Management.Automation.Language.Parser]::ParseFile($uninstallScript,[ref]$tokens,[ref]$errors)
    Assert-SelfTest -Condition ($errors.Count -eq 0) -Message 'uninstaller parse failed'
    foreach($name in @('Assert-DysonUninstallPlainFile','Set-DysonUninstallLifecycleFileBytesAtomic',
        'Set-DysonUninstallBrokerFileBytesAtomic','Restore-DysonUninstallLifecyclePreimageAclsAndTask',
        'Restore-DysonUninstallBrokerPreimageAclsAndTask')) {
        $definition=@($uninstallAst.FindAll({param($node)
            $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -ceq $name
        },$false))
        Assert-SelfTest -Condition ($definition.Count -eq 1) -Message 'uninstall ACL regression dependency unavailable'
        . ([scriptblock]::Create($definition[0].Extent.Text))
    }
    $directoryDescriptor=[Security.AccessControl.RawSecurityDescriptor]::new((Get-Acl -LiteralPath $fixture).Sddl)
    $autoInheritanceFlags=[int][Security.AccessControl.ControlFlags]::DiscretionaryAclAutoInherited -bor
        [int][Security.AccessControl.ControlFlags]::DiscretionaryAclAutoInheritRequired
    $directoryDescriptor.SetFlags([Security.AccessControl.ControlFlags](
        [int]$directoryDescriptor.ControlFlags -band (-bnot $autoInheritanceFlags)))
    $legacyDirectorySddl=$directoryDescriptor.GetSddlForm([Security.AccessControl.AccessControlSections]'Access,Owner,Group')
    Restore-DysonDeploymentDirectorySecurityPreimage -Path $fixture -Sddl $legacyDirectorySddl
    $history=Join-Path $fixture 'preserved-history.txt'
    [IO.File]::WriteAllText($history,'immutable history fixture')
    $historySddl=(Get-Acl -LiteralPath $history).Sddl
    $state.directoryAcls=@([pscustomobject]@{path=$fixture;sddl=$legacyDirectorySddl})
    $cutoverState.directoryAcls=$state.directoryAcls
    Restore-DysonUninstallLifecyclePreimageAclsAndTask -State $state -ShadowRoot $fixture
    Restore-DysonUninstallBrokerPreimageAclsAndTask -State $cutoverState -ShadowRoot $fixture
    Assert-SelfTest -Condition ((Get-Acl -LiteralPath $fixture).Sddl -ceq $legacyDirectorySddl -and
        (Get-Acl -LiteralPath $profile).Sddl -ceq $originalSddl -and
        (Get-Acl -LiteralPath $binding).Sddl -ceq $cutoverState.bindingSddl -and
        (Get-Acl -LiteralPath $history).Sddl -ceq $historySddl -and
        [IO.File]::ReadAllText($history) -ceq 'immutable history fixture') `
        -Message 'uninstall compensation changed a captured legacy directory descriptor or its durable descendants'
    $directoryRejected=$false
    try { Restore-DysonDeploymentFileSecurityPreimage -Path $fixture -Sddl $originalSddl }
    catch { $directoryRejected=$true }
    Assert-SelfTest -Condition $directoryRejected -Message 'file ACL restore accepted a directory target'
}

function Test-DysonDeploymentBrokerQuiescence {
    $errors=$null; $tokens=$null
    $ast=[Management.Automation.Language.Parser]::ParseFile($installScript,[ref]$tokens,[ref]$errors)
    Assert-SelfTest -Condition ($errors.Count -eq 0) -Message 'installer parse failed'
    foreach($name in @('Stop-DysonDeploymentControlTaskForBrokerUpgrade','Wait-DysonDeploymentBrokerWorkersIdle')) {
        $definition=@($ast.FindAll({param($node)
            $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -ceq $name
        },$false))
        Assert-SelfTest -Condition ($definition.Count -eq 1) -Message 'quiescence helper was not unique'
        . ([scriptblock]::Create($definition[0].Extent.Text))
    }
    $control=[pscustomobject]@{TaskName='Fixture-Control';TaskPath='\';State='Running'}
    $observed=[pscustomobject]@{stopCalls=0;workerSamples=0}
    function Get-DysonScheduledTasksByExactName { param($TaskName) return $control }
    function Export-ScheduledTask { [CmdletBinding()] param($TaskName,$TaskPath) return '<FixtureTask />' }
    function Stop-ScheduledTask {
        [CmdletBinding()] param($InputObject)
        Assert-SelfTest -Condition ($InputObject.TaskName -ceq 'Fixture-Control') -Message 'quiescence stopped a broker worker'
        $observed.stopCalls += 1; $control.State='Ready'
    }
    function Get-DysonLifecycleBrokerStaticWorkerTasks {
        $observed.workerSamples += 1
        [pscustomobject]@{State=$(if($observed.workerSamples -le 2){'Running'}else{'Ready'})}
    }
    function Get-DysonCutoverBrokerDeploymentTasks { return @() }
    function Start-Sleep { param($Milliseconds) }
    $before=[pscustomobject]@{present=$true;taskPath='\';xmlSha256=(Get-DysonTextSha256 '<FixtureTask />')}
    Stop-DysonDeploymentControlTaskForBrokerUpgrade -State $before -TaskName 'Fixture-Control'
    Wait-DysonDeploymentBrokerWorkersIdle
    Assert-SelfTest -Condition ($observed.stopCalls -eq 1 -and $observed.workerSamples -eq 4 -and
        $control.State -ceq 'Ready') -Message 'quiescence did not let the status worker finish before two idle observations'
}

function Test-DysonDeploymentPendingStatusPreflight {
    . (Join-Path $PSScriptRoot '..\lifecycle-broker\DysonLifecycleBroker.Common.ps1')
    $root = Join-Path $testRoot 'pending-status-preflight'
    $storage = [pscustomobject]@{
        requests = Join-Path $root 'requests'
        receipts = Join-Path $root 'receipts'
        intents = Join-Path $root 'intents'
    }
    foreach ($directory in @($storage.requests, $storage.receipts, $storage.intents)) {
        [void][IO.Directory]::CreateDirectory($directory)
    }
    $id = [guid]::NewGuid().ToString('D')
    $requestPath = Join-Path $storage.requests ($id + '.json')
    $request = New-DysonLifecycleBrokerRequest -BrokerRequestId $id -Capability LifecycleStatus `
        -ProfileHash ('a' * 64) -Input ([pscustomobject]@{})
    $statusJson = $request | ConvertTo-Json -Depth 6 -Compress
    [IO.File]::WriteAllText($requestPath, $statusJson)
    $rejected = $false
    try { Assert-DysonLifecycleBrokerStaticNoPendingWork -Storage $storage } catch { $rejected = $true }
    Assert-SelfTest $rejected 'Strict post-quiescence validation accepted an unfinished status request.'
    Assert-DysonLifecycleBrokerStaticNoPendingWork -Storage $storage -AllowPendingStatusRequests
    Assert-SelfTest ([IO.File]::ReadAllText($requestPath) -ceq $statusJson) 'Read-only preflight changed the pending request.'
    $dispatch = New-DysonLifecycleBrokerRequest -BrokerRequestId $id -Capability LifecycleDispatch `
        -ProfileHash ('a' * 64) -Input ([pscustomobject]@{operation='start';leaseInstanceId=[guid]::NewGuid().ToString('D');leaseToken=('x' * 43)})
    [IO.File]::WriteAllText($requestPath, ($dispatch | ConvertTo-Json -Depth 6 -Compress))
    $rejected = $false
    try { Assert-DysonLifecycleBrokerStaticNoPendingWork -Storage $storage -AllowPendingStatusRequests } catch { $rejected = $true }
    Assert-SelfTest $rejected 'Preflight accepted an unfinished mutating request.'
    $request.requestFingerprint = ('b' * 64)
    [IO.File]::WriteAllText($requestPath, ($request | ConvertTo-Json -Depth 6 -Compress))
    $rejected = $false
    try { Assert-DysonLifecycleBrokerStaticNoPendingWork -Storage $storage -AllowPendingStatusRequests } catch { $rejected = $true }
    Assert-SelfTest $rejected 'Preflight accepted a tampered status request.'
    [IO.File]::WriteAllText($requestPath, $statusJson)
    [IO.File]::WriteAllText((Join-Path $storage.intents ($id + '.json')), '{}')
    $rejected = $false
    try { Assert-DysonLifecycleBrokerStaticNoPendingWork -Storage $storage -AllowPendingStatusRequests } catch { $rejected = $true }
    Assert-SelfTest $rejected 'Preflight accepted an unfinished intent.'
}

function Test-DysonCutoverBrokerNativeTaskCollections {
    # Execute the production validator without executing the installer. Native
    # CIM tasks may expose scalar Actions and null Triggers rather than arrays.
    Set-StrictMode -Version Latest
    $parseErrors = $null
    $parseTokens = $null
    $ast = [Management.Automation.Language.Parser]::ParseFile($installScript,
        [ref]$parseTokens, [ref]$parseErrors)
    Assert-SelfTest -Condition ($parseErrors.Count -eq 0) -Message 'installer parse failed'
    $validator = @($ast.FindAll({ param($node)
        $node -is [Management.Automation.Language.FunctionDefinitionAst] -and
            $node.Name -ceq 'Assert-DysonCutoverBrokerDeploymentTask'
    }, $false))
    Assert-SelfTest -Condition ($validator.Count -eq 1) -Message 'native task validator was not unique'
    . ([scriptblock]::Create($validator[0].Extent.Text))
    function Get-DysonCutoverBrokerDeploymentTasks { return $nativeTasks }
    function Get-DysonCutoverBrokerTaskArguments { param($Profile) return '-fictional-fixed-arguments' }

    foreach ($scenario in @('null-triggers', 'empty-triggers', 'null-array-triggers',
        'missing-action', 'multiple-actions', 'unexpected-trigger', 'wrong-principal',
        'wrong-arguments', 'disabled', 'wrong-path', 'duplicate-task')) {
        $action = [pscustomobject]@{
            Execute = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
            Arguments = '-fictional-fixed-arguments'; WorkingDirectory = ''
        }
        $task = [pscustomobject]@{
            TaskPath = '\'; Actions = $action; Triggers = $null
            Principal = [pscustomobject]@{ UserId = 'S-1-5-18'; LogonType = 'ServiceAccount'; RunLevel = 'Highest' }
            Settings = [pscustomobject]@{ MultipleInstances = 'IgnoreNew'; ExecutionTimeLimit = 'PT10M'; Enabled = $true }
            Description = 'Fixed SYSTEM mutation broker for Dyson Control cutover operations.'
        }
        $nativeTasks = @($task)
        switch ($scenario) {
            'empty-triggers' { $task.Triggers = @() }
            'null-array-triggers' { $task.Triggers = @($null) }
            'missing-action' { $task.Actions = $null }
            'multiple-actions' { $task.Actions = @($action, $action) }
            'unexpected-trigger' { $task.Triggers = [pscustomobject]@{ Enabled = $true } }
            'wrong-principal' { $task.Principal.UserId = 'FictionalOtherUser' }
            'wrong-arguments' { $action.Arguments += ' -unexpected' }
            'disabled' { $task.Settings.Enabled = $false }
            'wrong-path' { $task.TaskPath = '\Other\' }
            'duplicate-task' { $nativeTasks = @($task, $task) }
        }
        $errorMessage = $null
        try { Assert-DysonCutoverBrokerDeploymentTask -Profile ([pscustomobject]@{}) }
        catch { $errorMessage = $_.Exception.Message }
        $shouldAccept = $scenario -in @('null-triggers', 'empty-triggers', 'null-array-triggers')
        Assert-SelfTest -Condition (($shouldAccept -and $null -eq $errorMessage) -or
            (-not $shouldAccept -and $errorMessage -ceq
                'The fixed cutover broker task is inconsistent with its active profile.')) `
            -Message ("native cutover task case {0} failed: {1}" -f $scenario, $errorMessage)
    }
}

function ConvertTo-DysonDeploymentSelfTestExtendedPath {
    param([Parameter(Mandatory)][string]$Path)

    $fullPath = [System.IO.Path]::GetFullPath($Path)
    if ($fullPath.StartsWith('\\?\', [System.StringComparison]::OrdinalIgnoreCase)) {
        return $fullPath
    }
    if ($fullPath.StartsWith('\\', [System.StringComparison]::Ordinal)) {
        return '\\?\' + 'UNC\' + $fullPath.Substring(2)
    }
    return '\\?\' + $fullPath
}

function ConvertFrom-DysonDeploymentSelfTestExtendedPath {
    param([Parameter(Mandatory)][string]$Path)

    if ($Path.StartsWith('\\?\UNC\', [System.StringComparison]::OrdinalIgnoreCase)) {
        return '\\' + $Path.Substring(8)
    }
    if ($Path.StartsWith('\\?\', [System.StringComparison]::OrdinalIgnoreCase)) {
        return $Path.Substring(4)
    }
    return $Path
}

function Remove-DysonControlDeploymentSelfTestRoot {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][string]$Root,
        [Parameter(Mandatory)][string]$TemporaryBase
    )

    $temporaryBaseFull = [System.IO.Path]::GetFullPath($TemporaryBase).TrimEnd('\', '/')
    $rootFull = [System.IO.Path]::GetFullPath($Root).TrimEnd('\', '/')
    $rootParent = [System.IO.Path]::GetDirectoryName($rootFull)
    $rootLeaf = [System.IO.Path]::GetFileName($rootFull)
    if ([string]::IsNullOrWhiteSpace($rootParent) -or
        -not [string]::Equals(
            $rootParent.TrimEnd('\', '/'),
            $temporaryBaseFull,
            [System.StringComparison]::OrdinalIgnoreCase
        ) -or
        $rootLeaf -cnotmatch '^dyson-control-deployment-selftest-[0-9a-f]{32}$') {
        throw 'SELFTEST_CLEANUP_SCOPE_REJECTED'
    }

    $extendedRoot = ConvertTo-DysonDeploymentSelfTestExtendedPath -Path $rootFull
    if (-not [System.IO.Directory]::Exists($extendedRoot)) {
        if ([System.IO.File]::Exists($extendedRoot)) {
            throw 'SELFTEST_CLEANUP_ROOT_TYPE_REJECTED'
        }
        return $false
    }
    $rootAttributes = [System.IO.File]::GetAttributes($extendedRoot)
    if (-not ($rootAttributes -band [System.IO.FileAttributes]::Directory)) {
        throw 'SELFTEST_CLEANUP_ROOT_TYPE_REJECTED'
    }
    if ($rootAttributes -band [System.IO.FileAttributes]::ReparsePoint) {
        throw 'SELFTEST_CLEANUP_ROOT_REDIRECTED'
    }

    # Keep recursive deletion behind the validated root gate. Extended-length .NET paths
    # avoid the Windows PowerShell 5.1 provider's MAX_PATH traversal, and reparse entries
    # are unlinked without traversing their targets.
    $removeEntry = $null
    $removeEntry = {
        param(
            [Parameter(Mandatory)][string]$ExtendedEntry,
            [switch]$ValidatedRoot
        )

        $attributes = [System.IO.File]::GetAttributes($ExtendedEntry)
        $isDirectory = [bool]($attributes -band [System.IO.FileAttributes]::Directory)
        if ($ValidatedRoot -and -not $isDirectory) {
            throw 'SELFTEST_CLEANUP_ROOT_TYPE_REJECTED'
        }
        if ($ValidatedRoot -and
            ($attributes -band [System.IO.FileAttributes]::ReparsePoint)) {
            throw 'SELFTEST_CLEANUP_ROOT_REDIRECTED'
        }
        if ($attributes -band [System.IO.FileAttributes]::ReparsePoint) {
            if ($isDirectory) {
                [System.IO.Directory]::Delete($ExtendedEntry, $false)
            }
            else {
                [System.IO.File]::Delete($ExtendedEntry)
            }
            return
        }
        if ($isDirectory) {
            $children = @([System.IO.Directory]::EnumerateFileSystemEntries($ExtendedEntry))
            foreach ($child in $children) { & $removeEntry -ExtendedEntry $child }
            $attributes = [System.IO.File]::GetAttributes($ExtendedEntry)
            if ($attributes -band [System.IO.FileAttributes]::ReadOnly) {
                $attributes = [System.IO.FileAttributes](
                    [int]$attributes -band (-bnot [int][System.IO.FileAttributes]::ReadOnly)
                )
                [System.IO.File]::SetAttributes($ExtendedEntry, $attributes)
            }
            [System.IO.Directory]::Delete($ExtendedEntry, $false)
            return
        }
        if ($attributes -band [System.IO.FileAttributes]::ReadOnly) {
            $attributes = [System.IO.FileAttributes](
                [int]$attributes -band (-bnot [int][System.IO.FileAttributes]::ReadOnly)
            )
            [System.IO.File]::SetAttributes($ExtendedEntry, $attributes)
        }
        [System.IO.File]::Delete($ExtendedEntry)
    }

    & $removeEntry -ExtendedEntry $extendedRoot -ValidatedRoot
    if ([System.IO.Directory]::Exists($extendedRoot) -or
        [System.IO.File]::Exists($extendedRoot)) {
        throw 'SELFTEST_CLEANUP_INCOMPLETE'
    }
    return $true
}

function Test-DysonControlDeploymentSelfTestCleanup {
    param([Parameter(Mandatory)][string]$OuterRoot)

    $cleanupBase = Join-Path $OuterRoot 'cleanup-regression'
    [void][System.IO.Directory]::CreateDirectory($cleanupBase)
    $externalTarget = Join-Path $OuterRoot 'cleanup-regression-external-target'
    [void][System.IO.Directory]::CreateDirectory($externalTarget)
    $externalMarker = Join-Path $externalTarget 'must-survive.bin'
    [System.IO.File]::WriteAllBytes($externalMarker, [byte[]]@(0, 1, 2, 255))

    $longRoot = Join-Path $cleanupBase `
        ('dyson-control-deployment-selftest-' + [guid]::NewGuid().ToString('N'))
    $longDirectory = $longRoot
    foreach ($index in 1..6) {
        $longDirectory = Join-Path $longDirectory `
            (('segment-{0}-' -f $index) + ('x' * 40))
    }
    $longFile = Join-Path $longDirectory 'read-only-marker.bin'
    Assert-SelfTest -Condition ($longFile.Length -gt 260) `
        -Message 'the final-cleanup regression fixture did not exceed MAX_PATH'
    $extendedLongDirectory = ConvertTo-DysonDeploymentSelfTestExtendedPath -Path $longDirectory
    $extendedLongFile = ConvertTo-DysonDeploymentSelfTestExtendedPath -Path $longFile
    [void][System.IO.Directory]::CreateDirectory($extendedLongDirectory)
    [System.IO.File]::WriteAllBytes($extendedLongFile, [byte[]]@(7, 8, 9, 0, 255))
    [System.IO.File]::SetAttributes($extendedLongFile, [System.IO.FileAttributes]::ReadOnly)
    $childRedirect = Join-Path $longRoot 'redirected-child'
    [void](New-Item -ItemType Junction -Path $childRedirect -Target $externalTarget -ErrorAction Stop)
    Assert-SelfTest -Condition (
        Remove-DysonControlDeploymentSelfTestRoot -Root $longRoot -TemporaryBase $cleanupBase
    ) -Message 'the extended-length final-cleanup fixture was not removed'
    Assert-SelfTest -Condition (
        -not [System.IO.Directory]::Exists(
            (ConvertTo-DysonDeploymentSelfTestExtendedPath -Path $longRoot)
        ) -and
        [System.IO.File]::Exists($externalMarker)
    ) -Message 'extended cleanup failed or traversed a redirected child'

    $nestedBase = Join-Path $cleanupBase 'nested'
    $nestedRoot = Join-Path $nestedBase `
        ('dyson-control-deployment-selftest-' + [guid]::NewGuid().ToString('N'))
    [void][System.IO.Directory]::CreateDirectory($nestedRoot)
    $nestedRejected = $false
    try {
        [void](Remove-DysonControlDeploymentSelfTestRoot `
            -Root $nestedRoot -TemporaryBase $cleanupBase)
    }
    catch { $nestedRejected = $_.Exception.Message -ceq 'SELFTEST_CLEANUP_SCOPE_REJECTED' }
    Assert-SelfTest -Condition ($nestedRejected -and [System.IO.Directory]::Exists($nestedRoot)) `
        -Message 'cleanup accepted or changed a root below a temporary-base grandchild'
    Assert-SelfTest -Condition (
        Remove-DysonControlDeploymentSelfTestRoot -Root $nestedRoot -TemporaryBase $nestedBase
    ) -Message 'the nested scope sentinel could not be removed through its exact parent'

    $samePrefixRoot = Join-Path $cleanupBase `
        (('dyson-control-deployment-selftest-' + [guid]::NewGuid().ToString('N')) + '-extra')
    [void][System.IO.Directory]::CreateDirectory($samePrefixRoot)
    $samePrefixRejected = $false
    try {
        [void](Remove-DysonControlDeploymentSelfTestRoot `
            -Root $samePrefixRoot -TemporaryBase $cleanupBase)
    }
    catch { $samePrefixRejected = $_.Exception.Message -ceq 'SELFTEST_CLEANUP_SCOPE_REJECTED' }
    Assert-SelfTest -Condition (
        $samePrefixRejected -and [System.IO.Directory]::Exists($samePrefixRoot)
    ) -Message 'cleanup accepted or changed a same-prefix directory with an invalid leaf name'

    $fileRoot = Join-Path $cleanupBase `
        ('dyson-control-deployment-selftest-' + [guid]::NewGuid().ToString('N'))
    [System.IO.File]::WriteAllBytes($fileRoot, [byte[]]@(4, 5, 6))
    $fileRejected = $false
    try {
        [void](Remove-DysonControlDeploymentSelfTestRoot `
            -Root $fileRoot -TemporaryBase $cleanupBase)
    }
    catch { $fileRejected = $_.Exception.Message -ceq 'SELFTEST_CLEANUP_ROOT_TYPE_REJECTED' }
    Assert-SelfTest -Condition ($fileRejected -and [System.IO.File]::Exists($fileRoot)) `
        -Message 'cleanup accepted or changed a file posing as a self-test root'

    $redirectedRoot = Join-Path $cleanupBase `
        ('dyson-control-deployment-selftest-' + [guid]::NewGuid().ToString('N'))
    [void](New-Item -ItemType Junction -Path $redirectedRoot -Target $externalTarget -ErrorAction Stop)
    $redirectedRejected = $false
    try {
        [void](Remove-DysonControlDeploymentSelfTestRoot `
            -Root $redirectedRoot -TemporaryBase $cleanupBase)
    }
    catch { $redirectedRejected = $_.Exception.Message -ceq 'SELFTEST_CLEANUP_ROOT_REDIRECTED' }
    $redirectedItem = Get-Item -LiteralPath $redirectedRoot -Force -ErrorAction Stop
    Assert-SelfTest -Condition (
        $redirectedRejected -and
        ($redirectedItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -and
        [System.IO.File]::Exists($externalMarker)
    ) -Message 'cleanup accepted a redirected root or changed its external target'
    [System.IO.Directory]::Delete($redirectedItem.FullName, $false)

    return [pscustomobject][ordered]@{
        longPathRemoved = $true
        directChildAndExactNameEnforced = $true
        rootTypeAndReparseEnforced = $true
        childReparseTargetPreserved = $true
    }
}

function Get-SelfTestTreeFingerprint {
    param([Parameter(Mandatory)][string]$Root)

    $rootFull = [IO.Path]::GetFullPath($Root).TrimEnd('\', '/')
    $rootIoPath = ConvertTo-DysonDeploymentSelfTestExtendedPath -Path $rootFull
    if (-not [System.IO.Directory]::Exists($rootIoPath) -and
        -not [System.IO.File]::Exists($rootIoPath)) { return '<missing>' }

    # The uninstall recovery fixtures deliberately exercise paths beyond MAX_PATH.
    # Enumerate through the extended-length .NET APIs so fingerprinting observes the
    # actual protected tree instead of depending on the Windows PowerShell provider.
    $pending = New-Object 'System.Collections.Generic.Stack[string]'
    $pending.Push($rootIoPath)
    $items = New-Object System.Collections.Generic.List[object]
    while ($pending.Count -gt 0) {
        $ioPath = $pending.Pop()
        $attributes = [System.IO.File]::GetAttributes($ioPath)
        $isDirectory = [bool]($attributes -band [System.IO.FileAttributes]::Directory)
        $fullName = ConvertFrom-DysonDeploymentSelfTestExtendedPath -Path $ioPath
        [void]$items.Add([pscustomobject]@{
            FullName = $fullName
            IoPath = $ioPath
            PSIsContainer = $isDirectory
            Length = if ($isDirectory) { [int64]0 } else { ([System.IO.FileInfo]::new($ioPath)).Length }
        })
        if ($isDirectory -and
            -not ($attributes -band [System.IO.FileAttributes]::ReparsePoint)) {
            foreach ($child in @([System.IO.Directory]::EnumerateFileSystemEntries($ioPath))) {
                $pending.Push($child)
            }
        }
    }
    $items = $items | Sort-Object -Property FullName
    $descriptor = @(
        foreach ($item in $items) {
            $fullName = [IO.Path]::GetFullPath($item.FullName)
            $relative = if ([string]::Equals(
                $fullName.TrimEnd('\', '/'), $rootFull, [StringComparison]::OrdinalIgnoreCase
            )) { '.' } else { $fullName.Substring($rootFull.Length + 1) }
            $ioPath = $item.IoPath
            $security = if ($item.PSIsContainer) {
                [System.IO.Directory]::GetAccessControl($ioPath)
            }
            else { [System.IO.File]::GetAccessControl($ioPath) }
            $sddl = $security.GetSecurityDescriptorSddlForm(
                [System.Security.AccessControl.AccessControlSections]'Access, Owner, Group'
            )
            if ($item.PSIsContainer) {
                'D|{0}|{1}' -f $relative, $sddl
            }
            else {
                'F|{0}|{1}|{2}|{3}' -f $relative, $item.Length,
                    (Get-DysonFileSha256 -Path $fullName),
                    $sddl
            }
        }
    )
    return Get-DysonTextSha256 -Value ([string]::Join("`n", $descriptor))
}

function New-DysonDeploymentConfigurationShadowModule {
    param([Parameter(Mandatory)][string]$Root)

    $shadowRoot = Join-Path $Root 'configuration-shadow'
    [System.IO.Directory]::CreateDirectory($shadowRoot) | Out-Null
    $utf8 = [System.Text.UTF8Encoding]::new($false)
    [System.IO.File]::WriteAllText(
        (Join-Path $shadowRoot '.dyson-configuration-selftest'),
        'isolated-fixture-only',
        $utf8
    )
    $common = @'
Set-StrictMode -Version 2.0

function Get-FixtureSha256Bytes {
    param([Parameter(Mandatory)][byte[]]$Bytes)
    $hasher = [System.Security.Cryptography.SHA256]::Create()
    try {
        return ([System.BitConverter]::ToString($hasher.ComputeHash($Bytes))).Replace('-', '').ToLowerInvariant()
    }
    finally { $hasher.Dispose() }
}

function Get-FixtureSha256Text {
    param([Parameter(Mandatory)][AllowEmptyString()][string]$Text)
    return Get-FixtureSha256Bytes ([System.Text.UTF8Encoding]::new($false).GetBytes($Text))
}

function Get-DysonConfigurationContract {
    param([Parameter(Mandatory)][string]$ContractPath)
    if (-not (Test-Path -LiteralPath $ContractPath -PathType Leaf)) {
        throw 'fixture configuration contract missing'
    }
    return [pscustomobject]@{
        maximumBytes = 65536
        sha256 = Get-FixtureSha256Text 'DYSON_CONTROL_ENVIRONMENT_CONTRACT_V1-fixture'
    }
}

function Read-DysonControlEnvironmentFile {
    param(
        [Parameter(Mandatory)][string]$Path,
        [Parameter(Mandatory)]$Contract,
        [Parameter(Mandatory)][hashtable]$ExpectedLauncherBindings,
        [switch]$SkipSourceAcl
    )
    $item = Get-Item -LiteralPath $Path -Force -ErrorAction Stop
    if ($item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -or
        $item.Length -lt 1 -or $item.Length -gt [int64]$Contract.maximumBytes) {
        throw 'fixture configuration file invalid'
    }
    $bytes = [IO.File]::ReadAllBytes($item.FullName)
    $text = [Text.UTF8Encoding]::new($false, $true).GetString($bytes)
    $values = @{}
    $names = [Collections.Generic.List[string]]::new()
    foreach ($line in @($text -split "`r?`n", -1)) {
        if ($line.Length -eq 0 -or $line.StartsWith('#')) { continue }
        $separator = $line.IndexOf('=')
        if ($separator -lt 1) { throw 'fixture configuration line invalid' }
        $name = $line.Substring(0, $separator)
        $value = $line.Substring($separator + 1)
        if (($name -cne 'NODE_ENV' -and $name -cnotmatch '^DYSON_[A-Z0-9_]{1,96}$') -or
            $values.ContainsKey($name)) { throw 'fixture configuration name invalid' }
        $values[$name] = $value
        $names.Add($name)
    }
    foreach ($name in @($ExpectedLauncherBindings.Keys)) {
        # This isolated shadow emulates the production verifier's launcher-owned binding result.
        # The real configuration module's executable tests cover strict source rejection.
        $values[[string]$name] = [string]$ExpectedLauncherBindings[$name]
    }
    if (-not $values.ContainsKey('DYSON_SESSION_SECRET') -or
        ([string]$values.DYSON_SESSION_SECRET).Length -lt 32) {
        throw 'fixture session secret invalid'
    }
    $bindingLines = @(
        'NODE_ENV=production', 'DYSON_HOST=127.0.0.1',
        ('DYSON_DATA_DIR=' + [string]$ExpectedLauncherBindings.DYSON_DATA_DIR),
        ('DYSON_SCRIPT_ROOT=' + [string]$ExpectedLauncherBindings.DYSON_SCRIPT_ROOT),
        ('DYSON_RUNTIME_BOOTSTRAP_ROOT=' + [string]$ExpectedLauncherBindings.DYSON_RUNTIME_BOOTSTRAP_ROOT),
        ('DYSON_DEPLOYMENT_VERSION=' + [string]$ExpectedLauncherBindings.DYSON_DEPLOYMENT_VERSION)
    )
    return [pscustomobject][ordered]@{
        sha256 = Get-FixtureSha256Bytes $bytes
        length = [int64]$bytes.Length
        names = @($names | Sort-Object)
        namesSha256 = Get-FixtureSha256Text ([string]::Join("`n", @($names | Sort-Object)))
        bindingsSha256 = Get-FixtureSha256Text ([string]::Join("`n", $bindingLines))
        contractSha256 = [string]$Contract.sha256
        privateBytes = $bytes
        privateValues = $values
    }
}

function Get-FixtureConfigurationEvidence {
    param(
        [Parameter(Mandatory)][string]$ConfigurationPath,
        [Parameter(Mandatory)][string]$DataRoot,
        [Parameter(Mandatory)][string]$ScriptRoot,
        [Parameter(Mandatory)][string]$RuntimeBootstrapRoot,
        [Parameter(Mandatory)][string]$DeploymentVersion
    )
    $configurationFull = [System.IO.Path]::GetFullPath($ConfigurationPath)
    $dataFull = [System.IO.Path]::GetFullPath($DataRoot)
    $scriptFull = [System.IO.Path]::GetFullPath($ScriptRoot)
    $bootstrapFull = [System.IO.Path]::GetFullPath($RuntimeBootstrapRoot)
    $bytes = [System.IO.File]::ReadAllBytes($configurationFull)
    if ($bytes.Length -lt 1 -or $bytes.Length -gt 65536) { throw 'fixture configuration size invalid' }
    $text = [System.Text.UTF8Encoding]::new($false, $true).GetString($bytes)
    $names = @(
        foreach ($line in ($text -split "`n")) {
            $trimmed = $line.Trim()
            if ($trimmed.Length -eq 0 -or $trimmed.StartsWith('#')) { continue }
            $separator = $line.IndexOf('=')
            if ($separator -lt 1) { throw 'fixture configuration line invalid' }
            $line.Substring(0, $separator).Trim()
        }
    ) | Sort-Object -CaseSensitive -Unique
    return [pscustomobject][ordered]@{
        configurationSha256 = Get-FixtureSha256Bytes $bytes
        configurationLength = [int64]$bytes.Length
        namesSha256 = Get-FixtureSha256Text ([string]::Join("`n", $names))
        bindingsSha256 = Get-FixtureSha256Text ([string]::Join("`n", @(
            'NODE_ENV=production', 'DYSON_HOST=127.0.0.1',
            ('DYSON_DATA_DIR=' + (Join-Path $dataFull 'data')),
            ('DYSON_SCRIPT_ROOT=' + $scriptFull),
            ('DYSON_RUNTIME_BOOTSTRAP_ROOT=' + $bootstrapFull),
            ('DYSON_DEPLOYMENT_VERSION=' + $DeploymentVersion)
        )))
        contractSha256 = Get-FixtureSha256Text 'DYSON_CONTROL_ENVIRONMENT_CONTRACT_V1-fixture'
        configurationAclFingerprint = Get-FixtureSha256Text ('fixture-config-acl|' + $configurationFull)
        parentAclFingerprint = Get-FixtureSha256Text ('fixture-parent-acl|' + $dataFull)
        completedTransactionCount = 1
    }
}
'@
    [System.IO.File]::WriteAllText(
        (Join-Path $shadowRoot 'DysonConfiguration.Common.ps1'), $common, $utf8
    )
    [System.IO.File]::WriteAllText(
        (Join-Path $shadowRoot 'dyson-control.environment-contract.json'),
        '{"protocol":"DYSON_CONTROL_ENVIRONMENT_CONTRACT_V1-fixture"}',
        $utf8
    )
    $sourceVerifier = @'
[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$ConfigurationSource,
    [Parameter(Mandatory)][string]$DataRoot,
    [Parameter(Mandatory)][string]$ScriptRoot,
    [Parameter(Mandatory)][string]$RuntimeBootstrapRoot,
    [Parameter(Mandatory)][string]$DeploymentVersion,
    [Parameter(Mandatory)][string]$ServiceAccount,
    [Parameter(Mandatory)][string]$ExistingScriptRoot,
    [Parameter(Mandatory)][string]$ExistingRuntimeBootstrapRoot,
    [Parameter(Mandatory)][string]$ExistingDeploymentVersion
)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'DysonConfiguration.Common.ps1')
if ($ServiceAccount -cne 'NT AUTHORITY\LOCAL SERVICE') { throw 'fixture service account invalid' }
$sourceFull = [System.IO.Path]::GetFullPath($ConfigurationSource)
$sourceItem = Get-Item -LiteralPath $sourceFull -Force -ErrorAction Stop
if ($sourceItem.PSIsContainer -or
    ($sourceItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -or
    $sourceItem.Length -lt 1 -or $sourceItem.Length -gt 65536) {
    throw 'fixture source invalid'
}
$target = Join-Path (Join-Path ([System.IO.Path]::GetFullPath($DataRoot)) 'config') 'dyson-control.env'
$sourceEvidence = Get-FixtureConfigurationEvidence -ConfigurationPath $sourceFull `
    -DataRoot $DataRoot -ScriptRoot $ScriptRoot `
    -RuntimeBootstrapRoot $RuntimeBootstrapRoot -DeploymentVersion $DeploymentVersion
$existing = $null
if (Test-Path -LiteralPath $target -PathType Leaf) {
    $targetEvidence = Get-FixtureConfigurationEvidence -ConfigurationPath $target `
        -DataRoot $DataRoot -ScriptRoot $ExistingScriptRoot `
        -RuntimeBootstrapRoot $ExistingRuntimeBootstrapRoot `
        -DeploymentVersion $ExistingDeploymentVersion
    if ([string]$targetEvidence.configurationSha256 -ceq [string]$sourceEvidence.configurationSha256 -and
        [int64]$targetEvidence.configurationLength -eq [int64]$sourceEvidence.configurationLength) {
        # The isolated fixture source omits launcher-owned lines. Overlay the candidate
        # bindings only for its byte-identical reuse path; replacement retains old bindings.
        $targetEvidence = Get-FixtureConfigurationEvidence -ConfigurationPath $target `
            -DataRoot $DataRoot -ScriptRoot $ScriptRoot `
            -RuntimeBootstrapRoot $RuntimeBootstrapRoot -DeploymentVersion $DeploymentVersion
    }
    $existing = $targetEvidence
}
[pscustomobject][ordered]@{
    protocol = 'DYSON_CONTROL_CONFIGURATION_SOURCE_SELFTEST_RESULT_V1'
    mutationPerformed = $false
    configurationPath = $target
    sourceSha256 = [string]$sourceEvidence.configurationSha256
    sourceLength = [int64]$sourceEvidence.configurationLength
    namesSha256 = [string]$sourceEvidence.namesSha256
    bindingsSha256 = [string]$sourceEvidence.bindingsSha256
    contractSha256 = [string]$sourceEvidence.contractSha256
    existing = $existing
    snapshot = $null
    restorePlan = $null
}
'@
    [System.IO.File]::WriteAllText(
        (Join-Path $shadowRoot 'Test-DysonControlConfigurationSource.ps1'),
        $sourceVerifier,
        $utf8
    )
    $installer = @'
[CmdletBinding(SupportsShouldProcess)]
param(
    [Parameter(Mandatory)][string]$ConfigurationSource,
    [Parameter(Mandatory)][string]$DataRoot,
    [Parameter(Mandatory)][string]$ScriptRoot,
    [Parameter(Mandatory)][string]$RuntimeBootstrapRoot,
    [Parameter(Mandatory)][string]$DeploymentVersion,
    [Parameter(Mandatory)][string]$ServiceAccount,
    [string]$ProtectedPreimageSnapshotPath
)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'DysonConfiguration.Common.ps1')
if ($ServiceAccount -cne 'NT AUTHORITY\LOCAL SERVICE') { throw 'fixture service account invalid' }
$sourceFull = [System.IO.Path]::GetFullPath($ConfigurationSource)
$target = Join-Path (Join-Path ([System.IO.Path]::GetFullPath($DataRoot)) 'config') 'dyson-control.env'
$sourceEvidence = Get-FixtureConfigurationEvidence -ConfigurationPath $sourceFull `
    -DataRoot $DataRoot -ScriptRoot $ScriptRoot `
    -RuntimeBootstrapRoot $RuntimeBootstrapRoot -DeploymentVersion $DeploymentVersion
$operation = 'create'
if (Test-Path -LiteralPath $target -PathType Leaf) {
    $existing = Get-FixtureConfigurationEvidence -ConfigurationPath $target `
        -DataRoot $DataRoot -ScriptRoot $ScriptRoot `
        -RuntimeBootstrapRoot $RuntimeBootstrapRoot -DeploymentVersion $DeploymentVersion
    if ([string]$existing.configurationSha256 -cne [string]$sourceEvidence.configurationSha256 -or
        [int64]$existing.configurationLength -ne [int64]$sourceEvidence.configurationLength) {
        if ([string]::IsNullOrWhiteSpace($ProtectedPreimageSnapshotPath)) {
            throw 'DYSON_CONFIGURATION_REPLACEMENT_REQUIRES_MATCHING_PROTECTED_SNAPSHOT'
        }
        $preimagePayload = Join-Path $ProtectedPreimageSnapshotPath 'dyson-control.env'
        if (-not (Test-Path -LiteralPath $preimagePayload -PathType Leaf) -or
            (Get-FixtureSha256Bytes ([System.IO.File]::ReadAllBytes($preimagePayload))) -cne
                [string]$existing.configurationSha256) {
            throw 'DYSON_CONFIGURATION_REPLACEMENT_REQUIRES_MATCHING_PROTECTED_SNAPSHOT'
        }
        [System.IO.File]::WriteAllBytes($target, [System.IO.File]::ReadAllBytes($sourceFull))
        $operation = 'replace'
    }
    else {
        $operation = 'reuse'
    }
}
else {
    [System.IO.Directory]::CreateDirectory([System.IO.Path]::GetDirectoryName($target)) | Out-Null
    [System.IO.File]::WriteAllBytes($target, [System.IO.File]::ReadAllBytes($sourceFull))
}
$evidence = Get-FixtureConfigurationEvidence -ConfigurationPath $target `
    -DataRoot $DataRoot -ScriptRoot $ScriptRoot `
    -RuntimeBootstrapRoot $RuntimeBootstrapRoot -DeploymentVersion $DeploymentVersion
[pscustomobject][ordered]@{
    protocol = 'DYSON_CONTROL_CONFIGURATION_INSTALL_RESULT_V1'
    mode = 'apply'
    state = 'completed'
    operation = $operation
    mutationPerformed = $true
    configurationSha256 = [string]$evidence.configurationSha256
    configurationLength = [int64]$evidence.configurationLength
    bindingsSha256 = [string]$evidence.bindingsSha256
    contractSha256 = [string]$evidence.contractSha256
    aclFingerprint = [string]$evidence.configurationAclFingerprint
    parentAclFingerprint = [string]$evidence.parentAclFingerprint
}
'@
    [System.IO.File]::WriteAllText(
        (Join-Path $shadowRoot 'Install-DysonControlConfiguration.ps1'),
        $installer,
        $utf8
    )
    $snapshotCreator = @'
[CmdletBinding(SupportsShouldProcess)]
param(
    [Parameter(Mandatory)][string]$DataRoot,
    [Parameter(Mandatory)][string]$ScriptRoot,
    [Parameter(Mandatory)][string]$RuntimeBootstrapRoot,
    [Parameter(Mandatory)][string]$DeploymentVersion,
    [Parameter(Mandatory)][string]$ServiceAccount
)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'DysonConfiguration.Common.ps1')
if ($ServiceAccount -cne 'NT AUTHORITY\LOCAL SERVICE') { throw 'fixture service account invalid' }
$dataFull = [System.IO.Path]::GetFullPath($DataRoot)
$target = Join-Path (Join-Path $dataFull 'config') 'dyson-control.env'
$evidence = Get-FixtureConfigurationEvidence -ConfigurationPath $target `
    -DataRoot $DataRoot -ScriptRoot $ScriptRoot `
    -RuntimeBootstrapRoot $RuntimeBootstrapRoot -DeploymentVersion $DeploymentVersion
$snapshotId = [guid]::NewGuid().ToString('D')
$snapshotPath = Join-Path (Join-Path $dataFull 'configuration-snapshots') $snapshotId
[System.IO.Directory]::CreateDirectory($snapshotPath) | Out-Null
[System.IO.File]::WriteAllBytes((Join-Path $snapshotPath 'dyson-control.env'),
    [System.IO.File]::ReadAllBytes($target))
$manifestSha256 = Get-FixtureSha256Text ('fixture-snapshot|' + $snapshotId + '|' +
    [string]$evidence.configurationSha256)
[System.IO.File]::WriteAllText((Join-Path $snapshotPath 'configuration-snapshot.json'),
    ('{"snapshotId":"' + $snapshotId + '","configurationSha256":"' +
        [string]$evidence.configurationSha256 + '"}'),
    [System.Text.UTF8Encoding]::new($false))
[System.IO.File]::WriteAllText((Join-Path $snapshotPath 'bindings-sha256.txt'),
    [string]$evidence.bindingsSha256, [System.Text.UTF8Encoding]::new($false))
[System.IO.File]::WriteAllText((Join-Path $snapshotPath 'contract-sha256.txt'),
    [string]$evidence.contractSha256, [System.Text.UTF8Encoding]::new($false))
[pscustomobject][ordered]@{
    protocol = 'DYSON_CONTROL_CONFIGURATION_SNAPSHOT_RESULT_V1'
    mode = 'apply'
    state = 'created'
    snapshotId = $snapshotId
    snapshotPath = $snapshotPath
    snapshotPathSha256 = Get-FixtureSha256Text $snapshotPath
    configurationSha256 = [string]$evidence.configurationSha256
    configurationLength = [int64]$evidence.configurationLength
    configurationAclFingerprint = [string]$evidence.configurationAclFingerprint
    manifestSha256 = $manifestSha256
    bindingsSha256 = [string]$evidence.bindingsSha256
    contractSha256 = [string]$evidence.contractSha256
    mutationPerformed = $true
}
'@
    [System.IO.File]::WriteAllText(
        (Join-Path $shadowRoot 'New-DysonControlConfigurationSnapshot.ps1'),
        $snapshotCreator,
        $utf8
    )
    $restore = @'
[CmdletBinding(SupportsShouldProcess)]
param(
    [Parameter(Mandatory)][string]$ProtectedSnapshotPath,
    [Parameter(Mandatory)][string]$CurrentProtectedSnapshotPath,
    [Parameter(Mandatory)][string]$DataRoot,
    [Parameter(Mandatory)][string]$ServiceAccount
)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'DysonConfiguration.Common.ps1')
if ($ServiceAccount -cne 'NT AUTHORITY\LOCAL SERVICE') { throw 'fixture service account invalid' }
$dataFull = [System.IO.Path]::GetFullPath($DataRoot)
$target = Join-Path (Join-Path $dataFull 'config') 'dyson-control.env'
$sourcePayload = Join-Path $ProtectedSnapshotPath 'dyson-control.env'
$currentPayload = Join-Path $CurrentProtectedSnapshotPath 'dyson-control.env'
foreach ($path in @($sourcePayload, $currentPayload, $target)) {
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { throw 'fixture snapshot invalid' }
}
$targetHash = Get-FixtureSha256Bytes ([System.IO.File]::ReadAllBytes($target))
$currentHash = Get-FixtureSha256Bytes ([System.IO.File]::ReadAllBytes($currentPayload))
if ($targetHash -cne $currentHash) { throw 'DYSON_CONFIGURATION_RESTORE_PREIMAGE_MISMATCH' }
$sourceBytes = [System.IO.File]::ReadAllBytes($sourcePayload)
[System.IO.File]::WriteAllBytes($target, $sourceBytes)
$sourceId = Split-Path $ProtectedSnapshotPath -Leaf
$currentId = Split-Path $CurrentProtectedSnapshotPath -Leaf
$configurationSha256 = Get-FixtureSha256Bytes $sourceBytes
$configurationLength = [int64]$sourceBytes.Length
$configurationAclFingerprint = Get-FixtureSha256Text ('fixture-config-acl|' + $target)
[pscustomobject][ordered]@{
    protocol = 'DYSON_CONTROL_CONFIGURATION_RESTORE_RESULT_V1'
    mode = 'apply'
    state = 'completed'
    operation = 'restore'
    transactionId = [guid]::NewGuid().ToString('D')
    sequence = 3
    sourceSnapshotId = $sourceId
    preimageSnapshotId = $currentId
    configurationSha256 = $configurationSha256
    configurationLength = $configurationLength
    configurationAclFingerprint = $configurationAclFingerprint
    bindingsSha256 = (Get-Content -LiteralPath (Join-Path $ProtectedSnapshotPath 'bindings-sha256.txt') -Raw).Trim()
    contractSha256 = (Get-Content -LiteralPath (Join-Path $ProtectedSnapshotPath 'contract-sha256.txt') -Raw).Trim()
    chainHeadSha256 = Get-FixtureSha256Text ('fixture-restore|' + $sourceId + '|' + $currentId)
    completedTransactionCount = 3
    mutationPerformed = $true
}
'@
    [System.IO.File]::WriteAllText(
        (Join-Path $shadowRoot 'Restore-DysonControlConfiguration.ps1'),
        $restore,
        $utf8
    )
    $verifier = @'
[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$DataRoot,
    [Parameter(Mandatory)][string]$ScriptRoot,
    [Parameter(Mandatory)][string]$RuntimeBootstrapRoot,
    [Parameter(Mandatory)][string]$DeploymentVersion,
    [Parameter(Mandatory)][string]$ServiceAccount,
    [switch]$RuntimeOnly
)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'DysonConfiguration.Common.ps1')
if ($ServiceAccount -cne 'NT AUTHORITY\LOCAL SERVICE') { throw 'fixture service account invalid' }
$target = Join-Path (Join-Path ([System.IO.Path]::GetFullPath($DataRoot)) 'config') 'dyson-control.env'
$evidence = Get-FixtureConfigurationEvidence -ConfigurationPath $target `
    -DataRoot $DataRoot -ScriptRoot $ScriptRoot `
    -RuntimeBootstrapRoot $RuntimeBootstrapRoot -DeploymentVersion $DeploymentVersion
[pscustomobject][ordered]@{
    protocol = if ($RuntimeOnly) {
        'DYSON_CONTROL_CONFIGURATION_RUNTIME_TEST_RESULT_V1'
    }
    else { 'DYSON_CONTROL_CONFIGURATION_TEST_RESULT_V1' }
    healthy = $true
    mutationPerformed = $false
    configurationSha256 = [string]$evidence.configurationSha256
    configurationLength = [int64]$evidence.configurationLength
    namesSha256 = [string]$evidence.namesSha256
    bindingsSha256 = [string]$evidence.bindingsSha256
    contractSha256 = [string]$evidence.contractSha256
    configurationAclFingerprint = [string]$evidence.configurationAclFingerprint
    parentAclFingerprint = [string]$evidence.parentAclFingerprint
    completedTransactionCount = [int]$evidence.completedTransactionCount
    snapshot = $null
    restorePlan = $null
}
'@
    [System.IO.File]::WriteAllText(
        (Join-Path $shadowRoot 'Test-DysonControlConfiguration.ps1'),
        $verifier,
        $utf8
    )
    return $shadowRoot
}

function New-FictionalPayload {
    param(
        [Parameter(Mandatory)][string]$Root,
        [Parameter(Mandatory)][string]$Version,
        [string]$ContentMarker,
        [string]$VerifierSentinelPath
    )
    if ([string]::IsNullOrWhiteSpace($ContentMarker)) { $ContentMarker = $Version }
    $apiRoot = Join-Path $Root 'apps\api\dist'
    $webRoot = Join-Path $Root 'apps\web\dist'
    [System.IO.Directory]::CreateDirectory($apiRoot) | Out-Null
    [System.IO.Directory]::CreateDirectory($webRoot) | Out-Null
    $entryPoint = @"
import fs from 'node:fs';
const output = process.env.DYSON_SELFTEST_OUTPUT;
if (output) {
  fs.writeFileSync(output, JSON.stringify({
    fixtureVersion: '$ContentMarker',
    host: process.env.DYSON_HOST,
    nodeEnv: process.env.NODE_ENV,
    dataDir: process.env.DYSON_DATA_DIR,
    scriptRoot: process.env.DYSON_SCRIPT_ROOT,
    runtimeBootstrapRoot: process.env.DYSON_RUNTIME_BOOTSTRAP_ROOT,
    deploymentVersion: process.env.DYSON_DEPLOYMENT_VERSION,
    unexpectedNodeRuntimeEvidence: Object.keys(process.env)
      .filter((name) => name.startsWith('DYSON_NODE_RUNTIME_')),
    nodeOptions: process.env.NODE_OPTIONS || null
  }));
}
console.log('fictional-dyson-control-$ContentMarker');
"@
    [System.IO.File]::WriteAllText((Join-Path $apiRoot 'index.js'), $entryPoint, [System.Text.UTF8Encoding]::new($false))
    [System.IO.File]::WriteAllText(
        (Join-Path $webRoot 'index.html'),
        "<!doctype html><title>Fictional $Version</title>`n",
        [System.Text.UTF8Encoding]::new($false)
    )
    $fixturePackage = [ordered]@{
        name = '@dyson-control/api-fixture'
        version = $Version
        private = $true
        type = 'module'
        main = 'dist/index.js'
    }
    $fixtureLock = [ordered]@{
        name = '@dyson-control/api-fixture'
        version = $Version
        lockfileVersion = 3
        requires = $true
        packages = [ordered]@{
            '' = [ordered]@{ name = '@dyson-control/api-fixture'; version = $Version }
        }
    }
    [System.IO.File]::WriteAllText(
        (Join-Path $Root 'apps\api\package.json'),
        ($fixturePackage | ConvertTo-Json -Depth 8 -Compress),
        [System.Text.UTF8Encoding]::new($false)
    )
    [System.IO.File]::WriteAllText(
        (Join-Path $Root 'apps\api\package-lock.json'),
        ($fixtureLock | ConvertTo-Json -Depth 8 -Compress),
        [System.Text.UTF8Encoding]::new($false)
    )
    $releaseVerifierRoot = Join-Path $Root 'scripts\windows\release'
    [System.IO.Directory]::CreateDirectory($releaseVerifierRoot) | Out-Null
    [System.IO.File]::Copy($artifactCommonScript, (Join-Path $releaseVerifierRoot 'DysonReleasePackaging.Common.ps1'), $false)
    [System.IO.File]::Copy($artifactVerifierScript, (Join-Path $releaseVerifierRoot 'Test-DysonControlReleaseArtifact.ps1'), $false)
    $repositoryRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..\..'))
    $requiredEvidenceScripts = @()
    if (Get-Variable -Name DysonArtifactRequiredEvidenceScripts -Scope Script -ErrorAction SilentlyContinue) {
        $requiredEvidenceScripts = @($script:DysonArtifactRequiredEvidenceScripts)
    }
    $requiredRuntimeTaskScripts = @(
        'scripts/windows/Install-DysonRuntimeTasks.ps1',
        'scripts/windows/SelfTest-DysonRuntimeTasks.ps1'
    )
    foreach ($relative in @(
        $script:DysonArtifactRequiredTopLevelWindowsScripts +
        $script:DysonArtifactRequiredReleaseScripts +
        $script:DysonArtifactRequiredDeploymentScripts +
        $script:DysonArtifactRequiredConfigurationFiles +
        $script:DysonArtifactRequiredSessionScripts +
        $script:DysonArtifactRequiredApiLifecycleFiles +
        $script:DysonArtifactRequiredBridgeSources +
        $script:DysonArtifactRequiredBridgeScripts +
        $script:DysonArtifactRequiredMigrationScripts +
        $script:DysonArtifactRequiredGsManagerRemovalScripts +
        $script:DysonArtifactRequiredMigrationDocs +
        $script:DysonArtifactRequiredGsManagerRemovalDocs +
        $script:DysonArtifactRequiredHostMutationScripts +
        $script:DysonArtifactRequiredGameBootstrapScripts +
        $script:DysonArtifactRequiredCutoverScripts +
        $script:DysonArtifactRequiredCutoverBrokerScripts +
        $script:DysonArtifactRequiredLifecycleBrokerScripts +
        $script:DysonArtifactRequiredDataRecoveryScripts +
        $script:DysonArtifactRequiredRecoveryDocs +
        $script:DysonArtifactRequiredNetworkFiles +
        $script:DysonArtifactRequiredNetworkDocs +
        $requiredRuntimeTaskScripts +
        $requiredEvidenceScripts
    )) {
        $source = Join-Path $repositoryRoot $relative.Replace('/', '\')
        $destination = Join-Path $Root $relative.Replace('/', '\')
        [System.IO.Directory]::CreateDirectory([System.IO.Path]::GetDirectoryName($destination)) | Out-Null
        [System.IO.File]::Copy($source, $destination, $true)
    }
    foreach ($deploymentName in @('DysonDeployment.Common.ps1', 'DysonDeployment.Configuration.ps1', 'Start-DysonControl.ps1')) {
        $source = Join-Path $PSScriptRoot $deploymentName
        $destination = Join-Path $Root ('scripts\windows\deployment\' + $deploymentName)
        [System.IO.Directory]::CreateDirectory([System.IO.Path]::GetDirectoryName($destination)) | Out-Null
        [System.IO.File]::Copy($source, $destination, $true)
    }
    if (-not [string]::IsNullOrWhiteSpace($VerifierSentinelPath)) {
        $sentinelLiteral = $VerifierSentinelPath.Replace("'", "''")
        $maliciousVerifier = @(
            'param([string]$ArtifactPath, [string]$ExpectedVersion)'
            "[IO.File]::WriteAllText('$sentinelLiteral', 'executed')"
            "throw 'A source-owned verifier must never execute.'"
        ) -join "`n"
        [System.IO.File]::WriteAllText(
            (Join-Path $releaseVerifierRoot 'Test-DysonControlReleaseArtifact.ps1'),
            $maliciousVerifier + "`n",
            [System.Text.UTF8Encoding]::new($false)
        )
    }
    [void](Write-DysonArtifactManifest -ArtifactRoot $Root -Version $Version -DevDependenciesExcluded @())
}

function Get-FictionalPayloadSha256 {
    param([Parameter(Mandatory)][string]$Root)

    $manifestPath = Join-Path $Root 'artifact-manifest.json'
    $manifest = [System.IO.File]::ReadAllText($manifestPath, [System.Text.Encoding]::UTF8) |
        ConvertFrom-Json -ErrorAction Stop
    if ([string]$manifest.payloadSha256 -cnotmatch '^[0-9a-f]{64}$') {
        throw 'The fictional source artifact payload digest is unavailable.'
    }
    return [string]$manifest.payloadSha256
}

function New-FictionalNodeFixtures {
    param([Parameter(Mandatory)][string]$Root)

    $runtimeContainer = Join-Path $Root 'fictional-node-runtime-container'
    $fixtureRoot = Join-Path $runtimeContainer 'node-current'
    [System.IO.Directory]::CreateDirectory($fixtureRoot) | Out-Null
    $compilerOutput = Join-Path $fixtureRoot 'fixture-template.exe'
    $source = @'
using System;
using System.IO;
using System.Threading;

public static class DysonNodeRuntimeFixture
{
    public static int Main(string[] args)
    {
        if (args.Length != 1 || args[0] != "--version") return 91;
        if (!String.IsNullOrEmpty(Environment.GetEnvironmentVariable("NODE_OPTIONS")) ||
            !String.IsNullOrEmpty(Environment.GetEnvironmentVariable("NODE_PATH"))) return 93;
        string name = Path.GetFileNameWithoutExtension(Environment.GetCommandLineArgs()[0]).ToLowerInvariant();
        if (name.Contains("preview-trap")) {
            string sentinel = Environment.GetEnvironmentVariable("DYSON_NODE_PROBE_SENTINEL");
            if (!String.IsNullOrEmpty(sentinel)) File.WriteAllText(sentinel, "executed");
            Console.WriteLine("v24.0.0");
            return 0;
        }
        if (name.Contains("node24")) { Console.WriteLine("v24.0.0"); return 0; }
        if (name.Contains("node23")) { Console.WriteLine("v23.99.0"); return 0; }
        if (name.Contains("fake")) { Console.WriteLine("not-a-node-version"); return 0; }
        if (name.Contains("prerelease")) { Console.WriteLine("v24.0.0-rc.1"); return 0; }
        if (name.Contains("leadingzero")) { Console.WriteLine("v024.0.0"); return 0; }
        if (name.Contains("huge")) { Console.Write(new String('x', 4096)); return 0; }
        if (name.Contains("stderr")) { Console.Error.WriteLine("private fixture detail"); Console.WriteLine("v24.0.0"); return 0; }
        if (name.Contains("nonzero")) { Console.WriteLine("v24.0.0"); return 7; }
        if (name.Contains("timeout")) { Thread.Sleep(10000); Console.WriteLine("v24.0.0"); return 0; }
        return 92;
    }
}
'@
    Add-Type -TypeDefinition $source -Language CSharp -OutputAssembly $compilerOutput -OutputType ConsoleApplication
    $fixtures = [ordered]@{}
    foreach ($name in @('node24', 'node23', 'fake', 'prerelease', 'leadingzero', 'huge', 'stderr', 'nonzero', 'timeout', 'preview-trap')) {
        $target = Join-Path $fixtureRoot ($name + '-fixture.exe')
        [System.IO.File]::Copy($compilerOutput, $target, $true)
        $fixtures[$name.Replace('-', '')] = $target
    }
    $nodeCommand = Get-Command node.exe -ErrorAction SilentlyContinue
    if (-not $nodeCommand) { $nodeCommand = Get-Command node -ErrorAction Stop }
    $actualNode = Join-Path $fixtureRoot 'actual-node.exe'
    [System.IO.File]::Copy([string]$nodeCommand.Source, $actualNode, $true)
    $fixtures['actualNode'] = $actualNode
    Set-DysonNodeRuntimeContainerProtectionAcl -RuntimeContainer $runtimeContainer `
        -RuntimeRoot $fixtureRoot -InstallRoot $installRoot -DataRoot $dataRoot `
        -AllowSelfTestAdministrator
    Set-DysonNodeRuntimeProtectionAcl -RuntimeRoot $fixtureRoot `
        -InstallRoot $installRoot -DataRoot $dataRoot -AllowSelfTestAdministrator
    $fixtures['runtimeRoot'] = $fixtureRoot
    $fixtures['sha256'] = Get-DysonFileSha256 -Path $fixtures['node24']
    $fixtures['actualSha256'] = Get-DysonFileSha256 -Path $actualNode
    return [pscustomobject]$fixtures
}

function Invoke-DeploymentIdentityUninstallSelfTest {
    param(
        [Parameter(Mandatory)][string]$Root,
        [Parameter(Mandatory)][string]$NodeExecutable
    )

    $utf8 = [System.Text.UTF8Encoding]::new($false)
    $payloadA = Join-Path $Root 'identity-payload-a'
    $payloadB = Join-Path $Root 'identity-payload-b'
    New-FictionalPayload -Root $payloadA -Version '7.0.0' -ContentMarker 'identity-a'
    New-FictionalPayload -Root $payloadB -Version '7.1.0' -ContentMarker 'identity-b'
    $configuration = Join-Path $Root 'fictional-identity-production.env'
    [System.IO.File]::WriteAllText(
        $configuration,
        (@(
            'NODE_ENV=production',
            'DYSON_HOST=203.0.113.77',
            'DYSON_PROVIDER=demo',
            'DYSON_ADMIN_PASSWORD_HASH=scrypt$fictional',
            'DYSON_SESSION_SECRET=fictional-identity-session-secret-at-least-32-characters'
        ) -join "`n") + "`n",
        $utf8
    )

    function New-IdentityInstallFixture {
        param(
            [Parameter(Mandatory)][string]$Name,
            [string]$Payload = $payloadA,
            [string]$Version = '7.0.0'
        )

        # The outer root is intentionally long in the VM integration gate. Keep
        # these per-scenario leaves compact so the copied, independently scoped
        # game-bootstrap module can exercise its atomic layout writer on Windows
        # PowerShell 5.1 without the fixture itself consuming MAX_PATH.
        $install = Join-Path $Root ("identity-$Name-i\DysonControl")
        $data = Join-Path $Root ("identity-$Name-d\DysonControl")
        [void][System.IO.Directory]::CreateDirectory([System.IO.Path]::GetDirectoryName($install))
        [void][System.IO.Directory]::CreateDirectory([System.IO.Path]::GetDirectoryName($data))
        $output = & $installScript -SourcePath $Payload -Version $Version `
            -ExpectedArtifactPayloadSha256 (Get-FictionalPayloadSha256 -Root $Payload) `
            -NodeExecutable $NodeExecutable -InstallRoot $install -DataRoot $data `
            -ConfigurationSource $configuration -Confirm:$false
        $receipt = ($output | Out-String).Trim() | ConvertFrom-Json -ErrorAction Stop
        Assert-SelfTest -Condition ([string]$receipt.state -ceq 'installed') `
            -Message "the $Name identity fixture was not installed"
        return [pscustomobject][ordered]@{ installRoot = $install; dataRoot = $data; receipt = $receipt }
    }

    function Invoke-IdentityUninstallRejected {
        param(
            [Parameter(Mandatory)]$Fixture,
            [hashtable]$AdditionalArguments = @{}
        )

        $arguments = @{
            InstallRoot = [string]$Fixture.installRoot
            DataRoot = [string]$Fixture.dataRoot
            SkipTaskRemoval = $true
            Confirm = $false
        }
        foreach ($key in $AdditionalArguments.Keys) { $arguments[$key] = $AdditionalArguments[$key] }
        try { & $uninstallScript @arguments | Out-Null; return $false }
        catch { return $true }
    }

    $normal = New-IdentityInstallFixture -Name 'normal'
    $normalIdentity = Get-DysonDeploymentIdentity -InstallRoot $normal.installRoot -DataRoot $normal.dataRoot
    $normalActive = Get-DysonActiveRelease -InstallRoot $normal.installRoot -DataRoot $normal.dataRoot
    Assert-SelfTest -Condition (
        [string]$normalIdentity.marker.deploymentId -match `
            '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' -and
        [bool]$normalActive.deploymentIdentityVerified -and
        [string]$normalActive.pointer.deploymentId -ceq [string]$normalIdentity.marker.deploymentId -and
        [string]$normalActive.pointer.deploymentIdentitySha256 -ceq [string]$normalIdentity.markerSha256
    ) -Message 'a normal install did not bind its active release to a persistent deployment identity'
    $freshProcessProbe = Join-Path $Root 'fresh-process-identity-probe.ps1'
    $freshProcessProbeSource = @'
[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$InstallRoot,
    [Parameter(Mandatory)][string]$DataRoot
)
$ErrorActionPreference = 'Stop'
. (Join-Path $InstallRoot 'bootstrap\DysonDeployment.Common.ps1')
$identity = Get-DysonDeploymentIdentity -InstallRoot $InstallRoot -DataRoot $DataRoot
$active = Get-DysonActiveRelease -InstallRoot $InstallRoot -DataRoot $DataRoot
if (-not [bool]$active.deploymentIdentityVerified -or
    [string]$active.pointer.deploymentId -cne [string]$identity.marker.deploymentId -or
    [string]$active.pointer.deploymentIdentitySha256 -cne [string]$identity.markerSha256) {
    throw 'The fresh process did not retain the explicit self-test deployment identity binding.'
}
'FRESH_PROCESS_IDENTITY_OK'
'@
    [System.IO.File]::WriteAllText($freshProcessProbe, $freshProcessProbeSource, $utf8)
    $freshProcessOutput = & (Join-Path $env:SystemRoot `
        'System32\WindowsPowerShell\v1.0\powershell.exe') `
        -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $freshProcessProbe `
        -InstallRoot $normal.installRoot -DataRoot $normal.dataRoot
    Assert-SelfTest -Condition ($LASTEXITCODE -eq 0 -and
        [string]::Join("`n", @($freshProcessOutput)) -ceq 'FRESH_PROCESS_IDENTITY_OK') `
        -Message 'a fresh Windows PowerShell process lost the explicit self-test identity scope'
    $initialDeploymentId = [string]$normalIdentity.marker.deploymentId
    $initialIdentityHash = [string]$normalIdentity.markerSha256
    $initialIdentityBytes = [System.IO.File]::ReadAllBytes([string]$normalIdentity.markerPath)

    $upgradeOutput = & $installScript -SourcePath $payloadB -Version '7.1.0' `
        -ExpectedArtifactPayloadSha256 (Get-FictionalPayloadSha256 -Root $payloadB) `
        -NodeExecutable $NodeExecutable -InstallRoot $normal.installRoot -DataRoot $normal.dataRoot `
        -ConfigurationSource $configuration -Confirm:$false
    $upgradeReceipt = ($upgradeOutput | Out-String).Trim() | ConvertFrom-Json -ErrorAction Stop
    $upgradedIdentity = Get-DysonDeploymentIdentity -InstallRoot $normal.installRoot -DataRoot $normal.dataRoot
    $upgradedActive = Get-DysonActiveRelease -InstallRoot $normal.installRoot -DataRoot $normal.dataRoot
    Assert-SelfTest -Condition (
        [string]$upgradeReceipt.state -ceq 'installed' -and
        [string]$upgradedActive.pointer.version -ceq '7.1.0' -and
        [string]$upgradedIdentity.marker.deploymentId -ceq $initialDeploymentId -and
        [string]$upgradedIdentity.markerSha256 -ceq $initialIdentityHash -and
        [Convert]::ToBase64String([System.IO.File]::ReadAllBytes([string]$upgradedIdentity.markerPath)) -ceq
            [Convert]::ToBase64String($initialIdentityBytes) -and
        [string]$upgradedActive.pointer.deploymentId -ceq $initialDeploymentId -and
        [string]$upgradedActive.pointer.deploymentIdentitySha256 -ceq $initialIdentityHash
    ) -Message 'a normal upgrade replaced or detached the persistent deployment identity'

    $normalDataSentinel = Join-Path $normal.dataRoot 'data\identity-user-state.bin'
    $normalDataBytes = [byte[]]@(0, 1, 2, 13, 10, 127, 128, 254, 255)
    [System.IO.File]::WriteAllBytes($normalDataSentinel, $normalDataBytes)
    $normalAdjacent = Join-Path ([System.IO.Path]::GetDirectoryName($normal.installRoot)) 'DysonControl-adjacent'
    $normalUnrelated = Join-Path $Root 'ordinary-unrelated-directory'
    [void][System.IO.Directory]::CreateDirectory($normalAdjacent)
    [void][System.IO.Directory]::CreateDirectory($normalUnrelated)
    [System.IO.File]::WriteAllBytes((Join-Path $normalAdjacent 'adjacent.bin'), [byte[]]@(9, 8, 7, 0, 255))
    [System.IO.File]::WriteAllBytes((Join-Path $normalUnrelated 'ordinary.bin'), [byte[]]@(6, 5, 4, 0, 254))
    $normalAdjacentBefore = Get-SelfTestTreeFingerprint $normalAdjacent
    $normalUnrelatedBefore = Get-SelfTestTreeFingerprint $normalUnrelated
    $activePointerBefore = [System.IO.File]::ReadAllBytes([string]$upgradedActive.pointerPath)
    $normalUninstallOutput = & $uninstallScript -InstallRoot $normal.installRoot `
        -DataRoot $normal.dataRoot -SkipTaskRemoval -Confirm:$false
    $normalUninstall = ($normalUninstallOutput | Out-String).Trim() | ConvertFrom-Json -ErrorAction Stop
    $movedIdentity = Read-DysonDeploymentIdentityMarker `
        -MarkerPath (Join-Path ([string]$normalUninstall.recoverableReleaseBackup) `
            $script:DysonDeploymentIdentityName) `
        -ExpectedInstallRoot $normal.installRoot -ExpectedDataRoot $normal.dataRoot
    Assert-SelfTest -Condition (
        [string]$normalUninstall.state -ceq 'uninstalled' -and
        [bool]$normalUninstall.dataPreserved -and
        -not [System.IO.Directory]::Exists(
            (ConvertTo-DysonDeploymentExtendedPath -Path $normal.installRoot)
        ) -and
        [System.IO.File]::Exists((ConvertTo-DysonDeploymentExtendedPath -Path `
            (Join-Path ([string]$normalUninstall.recoverableReleaseBackup) `
                'releases\7.0.0\release-manifest.json'))) -and
        [System.IO.File]::Exists((ConvertTo-DysonDeploymentExtendedPath -Path `
            (Join-Path ([string]$normalUninstall.recoverableReleaseBackup) `
                'releases\7.1.0\release-manifest.json'))) -and
        [string]$movedIdentity.marker.deploymentId -ceq $initialDeploymentId -and
        [string]$movedIdentity.markerSha256 -ceq $initialIdentityHash -and
        [Convert]::ToBase64String([System.IO.File]::ReadAllBytes(
            (ConvertTo-DysonDeploymentExtendedPath -Path `
                ([string]$normalUninstall.activePointerBackup)))) -ceq
            [Convert]::ToBase64String($activePointerBefore) -and
        [Convert]::ToBase64String([System.IO.File]::ReadAllBytes($normalDataSentinel)) -ceq
            [Convert]::ToBase64String($normalDataBytes) -and
        (Get-SelfTestTreeFingerprint $normalAdjacent) -ceq $normalAdjacentBefore -and
        (Get-SelfTestTreeFingerprint $normalUnrelated) -ceq $normalUnrelatedBefore
    ) -Message 'normal uninstall changed unrelated bytes or failed to retain recoverable identity/version/state'

    $wrongIdentity = New-IdentityInstallFixture -Name 'wrong-identity'
    $wrongMarkerPath = Get-DysonDeploymentIdentityMarkerPath -InstallRoot $wrongIdentity.installRoot
    $wrongMarker = [System.IO.File]::ReadAllText($wrongMarkerPath, $utf8) | ConvertFrom-Json -ErrorAction Stop
    $wrongMarker.deploymentId = [guid]::NewGuid().ToString('D').ToLowerInvariant()
    Write-DysonJsonAtomic -Path $wrongMarkerPath -Value $wrongMarker
    $wrongInstallBefore = Get-SelfTestTreeFingerprint $wrongIdentity.installRoot
    $wrongDataBefore = Get-SelfTestTreeFingerprint $wrongIdentity.dataRoot
    Assert-SelfTest -Condition (
        (Invoke-IdentityUninstallRejected -Fixture $wrongIdentity) -and
        (Get-SelfTestTreeFingerprint $wrongIdentity.installRoot) -ceq $wrongInstallBefore -and
        (Get-SelfTestTreeFingerprint $wrongIdentity.dataRoot) -ceq $wrongDataBefore
    ) -Message 'a wrong deployment identity was accepted or changed fixture bytes'

    $redirected = New-IdentityInstallFixture -Name 'redirected-entry'
    $redirectTarget = Join-Path $Root 'redirected-entry-target'
    $redirectEntry = Join-Path $redirected.installRoot 'ordinary-redirected-directory'
    [void][System.IO.Directory]::CreateDirectory($redirectTarget)
    [System.IO.File]::WriteAllBytes((Join-Path $redirectTarget 'must-not-change.bin'), [byte[]]@(1, 3, 3, 7, 0, 255))
    $redirectTargetBefore = Get-SelfTestTreeFingerprint $redirectTarget
    $redirectDataBefore = Get-SelfTestTreeFingerprint $redirected.dataRoot
    try {
        [void](New-Item -ItemType Junction -Path $redirectEntry -Target $redirectTarget -ErrorAction Stop)
        Assert-SelfTest -Condition (
            (Invoke-IdentityUninstallRejected -Fixture $redirected) -and
            (Get-SelfTestTreeFingerprint $redirectTarget) -ceq $redirectTargetBefore -and
            (Get-SelfTestTreeFingerprint $redirected.dataRoot) -ceq $redirectDataBefore
        ) -Message 'a redirected product-tree entry was accepted or changed fixture bytes'
    }
    finally {
        if (Test-Path -LiteralPath $redirectEntry) {
            $redirectItem = Get-Item -LiteralPath $redirectEntry -Force -ErrorAction Stop
            if (-not ($redirectItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint)) {
                throw 'SELFTEST_FAILED: the redirected-entry cleanup target stopped being a junction'
            }
            [System.IO.Directory]::Delete($redirectItem.FullName, $false)
        }
    }

    $identityDrift = New-IdentityInstallFixture -Name 'identity-drift'
    $identityDriftInstallBefore = Get-SelfTestTreeFingerprint $identityDrift.installRoot
    $identityDriftPointer = Get-DysonActivePointerPath -DataRoot $identityDrift.dataRoot
    $identityDriftOriginalPointer = [System.IO.File]::ReadAllBytes($identityDriftPointer)
    $identityDriftPointerValue = [System.IO.File]::ReadAllText($identityDriftPointer, $utf8) |
        ConvertFrom-Json -ErrorAction Stop
    $identityDriftPointerValue.deploymentId = '00000000-0000-4000-8000-000000000001'
    Write-DysonJsonAtomic -Path $identityDriftPointer -Value $identityDriftPointerValue
    $identityDriftExpectedData = Get-SelfTestTreeFingerprint $identityDrift.dataRoot
    [System.IO.File]::WriteAllBytes($identityDriftPointer, $identityDriftOriginalPointer)
    $identityDriftRejected = Invoke-IdentityUninstallRejected -Fixture $identityDrift `
        -AdditionalArguments @{
            SelfTestSkipAdministratorCheck = $true
            SelfTestBeforeDestructiveMutation = 'ActivePointerDeploymentId'
        }
    Assert-SelfTest -Condition (
        $identityDriftRejected -and
        (Get-SelfTestTreeFingerprint $identityDrift.installRoot) -ceq $identityDriftInstallBefore -and
        (Get-SelfTestTreeFingerprint $identityDrift.dataRoot) -ceq $identityDriftExpectedData
    ) -Message 'an execution-time identity change was not rejected before uninstall mutation'

    $pathDrift = New-IdentityInstallFixture -Name 'path-drift'
    $pathDriftInstallBefore = Get-SelfTestTreeFingerprint $pathDrift.installRoot
    $pathDriftDataBefore = Get-SelfTestTreeFingerprint $pathDrift.dataRoot
    $pathDriftRelocated = $pathDrift.installRoot + '.selftest-relocated'
    try {
        $pathDriftRejected = Invoke-IdentityUninstallRejected -Fixture $pathDrift `
            -AdditionalArguments @{
                SelfTestSkipAdministratorCheck = $true
                SelfTestBeforeDestructiveMutation = 'InstallRootJunction'
            }
        Assert-SelfTest -Condition (
            $pathDriftRejected -and
            (Get-SelfTestTreeFingerprint $pathDriftRelocated) -ceq $pathDriftInstallBefore -and
            (Get-SelfTestTreeFingerprint $pathDrift.dataRoot) -ceq $pathDriftDataBefore
        ) -Message 'an execution-time directory redirection was not rejected before uninstall mutation'
    }
    finally {
        if (Test-Path -LiteralPath $pathDrift.installRoot) {
            $pathDriftItem = Get-Item -LiteralPath $pathDrift.installRoot -Force -ErrorAction Stop
            if (-not ($pathDriftItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint)) {
                throw 'SELFTEST_FAILED: the path-drift cleanup target stopped being a junction'
            }
            [System.IO.Directory]::Delete($pathDriftItem.FullName, $false)
        }
        if (Test-Path -LiteralPath $pathDriftRelocated -PathType Container) {
            [System.IO.Directory]::Move($pathDriftRelocated, $pathDrift.installRoot)
        }
    }

    $removeData = New-IdentityInstallFixture -Name 'remove-data'
    $removeDataAdjacent = Join-Path ([System.IO.Path]::GetDirectoryName($removeData.installRoot)) `
        'DysonControl-adjacent'
    [void][System.IO.Directory]::CreateDirectory($removeDataAdjacent)
    [System.IO.File]::WriteAllBytes((Join-Path $removeDataAdjacent 'must-survive.bin'), [byte[]]@(2, 4, 6, 8, 0, 255))
    $removeDataAdjacentBefore = Get-SelfTestTreeFingerprint $removeDataAdjacent
    foreach ($invalidArguments in @(
        @{ RemoveData = $true },
        @{ RemoveData = $true; RemoveDataConfirmation = 'REMOVE_DYSON_CONTROL_DATA' },
        @{ RemoveDataConfirmation = 'PERMANENTLY_REMOVE_DYSON_CONTROL_DATA' }
    )) {
        $removeInstallBefore = Get-SelfTestTreeFingerprint $removeData.installRoot
        $removeDataBefore = Get-SelfTestTreeFingerprint $removeData.dataRoot
        Assert-SelfTest -Condition (
            (Invoke-IdentityUninstallRejected -Fixture $removeData -AdditionalArguments $invalidArguments) -and
            (Get-SelfTestTreeFingerprint $removeData.installRoot) -ceq $removeInstallBefore -and
            (Get-SelfTestTreeFingerprint $removeData.dataRoot) -ceq $removeDataBefore -and
            (Get-SelfTestTreeFingerprint $removeDataAdjacent) -ceq $removeDataAdjacentBefore
        ) -Message 'data cleanup did not require its separate exact confirmation without mutation'
    }
    $removeDataLongDirectory = Join-Path $removeData.dataRoot 'data\long-remove-data-fixture'
    $removeDataLongFile = Join-Path $removeDataLongDirectory `
        ('read-only-' + ('x' * 120) + '.bin')
    Assert-SelfTest -Condition ($removeDataLongFile.Length -gt 260 -and
        $removeDataLongDirectory.Length -lt 260) `
        -Message 'the RemoveData regression fixture did not isolate a long file beneath a provider-safe directory'
    $removeDataLongDirectoryExtended = ConvertTo-DysonDeploymentSelfTestExtendedPath `
        -Path $removeDataLongDirectory
    $removeDataLongFileExtended = ConvertTo-DysonDeploymentSelfTestExtendedPath `
        -Path $removeDataLongFile
    [void][System.IO.Directory]::CreateDirectory($removeDataLongDirectoryExtended)
    [System.IO.File]::WriteAllBytes($removeDataLongFileExtended, [byte[]]@(5, 10, 15, 0, 255))
    [System.IO.File]::SetAttributes($removeDataLongFileExtended, [System.IO.FileAttributes]::ReadOnly)
    $removeDataOutput = & $uninstallScript -InstallRoot $removeData.installRoot `
        -DataRoot $removeData.dataRoot -SkipTaskRemoval -RemoveData `
        -RemoveDataConfirmation 'PERMANENTLY_REMOVE_DYSON_CONTROL_DATA' -Confirm:$false
    $removeDataReceipt = ($removeDataOutput | Out-String).Trim() | ConvertFrom-Json -ErrorAction Stop
    Assert-SelfTest -Condition (
        [string]$removeDataReceipt.state -ceq 'uninstalled' -and
        -not [bool]$removeDataReceipt.dataPreserved -and
        -not (Test-Path -LiteralPath $removeData.installRoot) -and
        -not (Test-Path -LiteralPath $removeData.dataRoot) -and
        (Get-SelfTestTreeFingerprint $removeDataAdjacent) -ceq $removeDataAdjacentBefore
    ) -Message 'exactly confirmed data cleanup escaped its verified deployment roots'

    return [pscustomobject][ordered]@{
        protocol = 'DYSON_CONTROL_DEPLOYMENT_IDENTITY_UNINSTALL_SELFTEST_V1'
        state = 'passed'
        normalInstallIdentityBound = $true
        freshProcessIdentityBindingValidated = $true
        upgradeIdentityPersistent = $true
        normalUninstallRecoverable = $true
        unrelatedAndAdjacentBytesPreserved = $true
        wrongIdentityRejectedWithoutMutation = $true
        redirectedEntryRejectedWithoutMutation = $true
        executionIdentityDriftRejectedWithoutMutation = $true
        executionPathDriftRejectedWithoutMutation = $true
        removeDataExactConfirmationValidated = $true
        removeDataLongReadOnlyTreeValidated = $true
        productionChanged = $false
    }
}

function Assert-NodeRuntimeRejected {
    param(
        [Parameter(Mandatory)][string]$Executable,
        [Parameter(Mandatory)][string]$Message,
        [int]$TimeoutMilliseconds = 1000
    )

    $rejected = $false
    $failure = $null
    try {
        [void](Test-DysonNodeRuntime -RuntimeRoot $script:NodeRuntimeRoot `
            -NodeExecutable $Executable -ExpectedNodeSha256 $script:NodeRuntimeHash `
            -InstallRoot $installRoot -DataRoot $dataRoot -MinimumMajor 24 `
            -TimeoutMilliseconds $TimeoutMilliseconds -MaximumOutputCharacters 128)
    }
    catch {
        $rejected = $true
        $failure = $_.Exception.Message
    }
    Assert-SelfTest -Condition $rejected -Message $Message
    Assert-SelfTest -Condition (-not [string]::IsNullOrWhiteSpace($failure)) `
        -Message 'Node runtime rejection did not return a bounded failure'
}

function Assert-ArtifactStageRejected {
    param(
        [Parameter(Mandatory)][string]$Payload,
        [Parameter(Mandatory)][string]$Version,
        [Parameter(Mandatory)][string]$Message
    )
    $rejected = $false
    try {
        & $deploymentScript -Operation Stage -SourcePath $Payload -Version $Version `
            -ExpectedArtifactPayloadSha256 (Get-FictionalPayloadSha256 -Root $Payload) `
            -InstallRoot $installRoot -DataRoot $dataRoot -Confirm:$false | Out-Null
    }
    catch { $rejected = $true }
    Assert-SelfTest -Condition $rejected -Message $Message
    Assert-SelfTest -Condition (-not (Test-Path -LiteralPath (Join-Path $installRoot "releases\$Version"))) `
        -Message "a rejected artifact was staged as release $Version"
}

function Invoke-DeploymentJson {
    param([Parameter(Mandatory)][hashtable]$Arguments)
    if ([string]$Arguments.Operation -in @('Stage', 'Upgrade') -and
        -not $Arguments.ContainsKey('ExpectedArtifactPayloadSha256')) {
        $Arguments['ExpectedArtifactPayloadSha256'] = Get-FictionalPayloadSha256 `
            -Root ([string]$Arguments.SourcePath)
    }
    if (-not $Arguments.ContainsKey('RuntimeRoot')) { $Arguments['RuntimeRoot'] = $script:NodeRuntimeRoot }
    if (-not $Arguments.ContainsKey('NodeExecutable')) { $Arguments['NodeExecutable'] = $script:NodeRuntimeExecutable }
    if (-not $Arguments.ContainsKey('ExpectedNodeSha256')) {
        $Arguments['ExpectedNodeSha256'] = $script:NodeRuntimeHash
    }
    $output = & $deploymentScript @Arguments -Confirm:$false
    return ($output | Out-String).Trim() | ConvertFrom-Json
}

function Get-ActiveVersion {
    $pointerPath = Join-Path $dataRoot 'state\active-release.json'
    if (-not (Test-Path -LiteralPath $pointerPath -PathType Leaf)) { return $null }
    return [string](([System.IO.File]::ReadAllText($pointerPath, [System.Text.Encoding]::UTF8) | ConvertFrom-Json).version)
}

function Get-ActiveVersionAt {
    param([Parameter(Mandatory)][string]$DataRoot)
    $pointerPath = Join-Path $DataRoot 'state\active-release.json'
    if (-not (Test-Path -LiteralPath $pointerPath -PathType Leaf)) { return $null }
    return [string](([System.IO.File]::ReadAllText($pointerPath, [System.Text.Encoding]::UTF8) | ConvertFrom-Json).version)
}

function Enable-DysonTaskSchedulerFixture {
    $global:DysonDeploymentTaskFixture = @{}
    $global:DysonDeploymentTaskFixtureFailRemovalFor = $null
    $global:DysonDeploymentTaskFixtureCorruptRegistrationFor = $null
    $global:DysonDeploymentTaskFixtureFailUnregisterOnceFor = $null
    $global:DysonDeploymentTaskFixtureQueryFailure = $false
    $global:DysonDeploymentTaskFixtureStopCalls = New-Object System.Collections.Generic.List[string]
    $global:DysonDeploymentTaskFixtureStartCalls = New-Object System.Collections.Generic.List[string]
    $global:DysonDeploymentTaskFixtureUnregisterCalls = New-Object System.Collections.Generic.List[string]
    Set-Item -Path 'Function:\global:Get-ScheduledTask' -Value {
        [CmdletBinding()]
        param([string]$TaskName, [string]$TaskPath)
        if ($global:DysonDeploymentTaskFixtureQueryFailure) { throw 'fixture scheduler query failed' }
        $tasks = @(
            foreach ($value in @($global:DysonDeploymentTaskFixture.Values)) {
                foreach ($task in @($value)) {
                    if ($task.PSObject.Properties.Name -notcontains 'TaskName') {
                        $task | Add-Member -NotePropertyName TaskName -NotePropertyValue ([string]$task.FixtureTaskName)
                    }
                    $task
                }
            }
        )
        if ($PSBoundParameters.ContainsKey('TaskName')) {
            $tasks = @($tasks | Where-Object {
                [string]::Equals([string]$_.TaskName, $TaskName, [System.StringComparison]::OrdinalIgnoreCase)
            })
        }
        if ($PSBoundParameters.ContainsKey('TaskPath')) {
            $tasks = @($tasks | Where-Object {
                [string]::Equals([string]$_.TaskPath, $TaskPath, [System.StringComparison]::Ordinal)
            })
        }
        return $tasks
    }
    Set-Item -Path 'Function:\global:Export-ScheduledTask' -Value {
        [CmdletBinding()]
        param([Parameter(Mandatory)][string]$TaskName, [string]$TaskPath)
        if (-not $global:DysonDeploymentTaskFixture.ContainsKey($TaskName)) { throw 'fixture task missing' }
        $tasks = @($global:DysonDeploymentTaskFixture[$TaskName])
        if ($PSBoundParameters.ContainsKey('TaskPath')) {
            $tasks = @($tasks | Where-Object {
                [string]::Equals([string]$_.TaskPath, $TaskPath, [System.StringComparison]::Ordinal)
            })
        }
        if ($tasks.Count -ne 1) { throw 'fixture task identity is not unique' }
        return [string]$tasks[0].Xml
    }
    Set-Item -Path 'Function:\global:Stop-ScheduledTask' -Value {
        [CmdletBinding()]
        param([Parameter(Mandatory)]$InputObject)
        if ([string]$global:DysonDeploymentTaskFixtureFailRemovalFor -ceq [string]$InputObject.FixtureTaskName) {
            throw 'fixture refused to stop the replacement task'
        }
        $global:DysonDeploymentTaskFixtureStopCalls.Add([string]$InputObject.FixtureTaskName)
        $global:DysonDeploymentTaskFixture[[string]$InputObject.FixtureTaskName].State = 'Ready'
    }
    Set-Item -Path 'Function:\global:Start-ScheduledTask' -Value {
        [CmdletBinding(DefaultParameterSetName = 'ByName')]
        param(
            [Parameter(ParameterSetName = 'ByName')][string]$TaskName,
            [Parameter(ParameterSetName = 'ByName')][string]$TaskPath,
            [Parameter(ParameterSetName = 'ByObject')]$InputObject
        )
        if ($PSCmdlet.ParameterSetName -eq 'ByObject') {
            $global:DysonDeploymentTaskFixtureStartCalls.Add([string]$InputObject.FixtureTaskName)
            $InputObject.State = 'Running'
            return
        }
        if (-not $global:DysonDeploymentTaskFixture.ContainsKey($TaskName)) { throw 'fixture task missing' }
        $tasks = @($global:DysonDeploymentTaskFixture[$TaskName])
        if ($PSBoundParameters.ContainsKey('TaskPath')) {
            $tasks = @($tasks | Where-Object {
                [string]::Equals([string]$_.TaskPath, $TaskPath, [System.StringComparison]::Ordinal)
            })
        }
        if ($tasks.Count -ne 1) { throw 'fixture task identity is not unique' }
        $global:DysonDeploymentTaskFixtureStartCalls.Add([string]$tasks[0].FixtureTaskName)
        $tasks[0].State = 'Running'
    }
    Set-Item -Path 'Function:\global:Unregister-ScheduledTask' -Value {
        [CmdletBinding(SupportsShouldProcess)]
        param([Parameter(Mandatory)][string]$TaskName, [string]$TaskPath)
        $global:DysonDeploymentTaskFixtureUnregisterCalls.Add($TaskName)
        if ([string]$global:DysonDeploymentTaskFixtureFailUnregisterOnceFor -ceq $TaskName) {
            $global:DysonDeploymentTaskFixtureFailUnregisterOnceFor = $null
            throw 'fixture refused the first unregister attempt'
        }
        if (-not $global:DysonDeploymentTaskFixture.ContainsKey($TaskName)) { return }
        if (-not $PSBoundParameters.ContainsKey('TaskPath')) {
            [void]$global:DysonDeploymentTaskFixture.Remove($TaskName)
            return
        }
        $remaining = @(@($global:DysonDeploymentTaskFixture[$TaskName]) | Where-Object {
            -not [string]::Equals([string]$_.TaskPath, $TaskPath, [System.StringComparison]::Ordinal)
        })
        if ($remaining.Count -eq 0) { [void]$global:DysonDeploymentTaskFixture.Remove($TaskName) }
        elseif ($remaining.Count -eq 1) { $global:DysonDeploymentTaskFixture[$TaskName] = $remaining[0] }
        else { $global:DysonDeploymentTaskFixture[$TaskName] = $remaining }
    }
    Set-Item -Path 'Function:\global:New-ScheduledTaskAction' -Value {
        [CmdletBinding()]
        param([Parameter(Mandatory)][string]$Execute, [string]$Argument)
        return [pscustomobject]@{ Execute = $Execute; Arguments = $Argument; WorkingDirectory = '' }
    }
    Set-Item -Path 'Function:\global:New-ScheduledTaskTrigger' -Value {
        [CmdletBinding()]
        param([switch]$AtStartup)
        return [pscustomobject]@{ Kind = 'AtStartup'; Enabled = $true }
    }
    Set-Item -Path 'Function:\global:New-ScheduledTaskPrincipal' -Value {
        [CmdletBinding()]
        param([string]$UserId, [string]$LogonType, [string]$RunLevel)
        return [pscustomobject]@{ UserId = $UserId; LogonType = $LogonType; RunLevel = $RunLevel }
    }
    Set-Item -Path 'Function:\global:New-ScheduledTaskSettingsSet' -Value {
        [CmdletBinding()]
        param(
            [switch]$AllowStartIfOnBatteries,
            [switch]$DontStopIfGoingOnBatteries,
            [timespan]$ExecutionTimeLimit,
            [string]$MultipleInstances,
            [int]$RestartCount,
            [timespan]$RestartInterval,
            [switch]$StartWhenAvailable
        )
        return [pscustomobject]@{
            Enabled = $true
            MultipleInstances = $MultipleInstances
            RestartCount = $RestartCount
            RestartInterval = $RestartInterval
            ExecutionTimeLimit = $ExecutionTimeLimit
            StartWhenAvailable = [bool]$StartWhenAvailable
        }
    }
    Set-Item -Path 'Function:\global:Register-ScheduledTask' -Value {
        [CmdletBinding(DefaultParameterSetName = 'Definition')]
        param(
            [Parameter(Mandatory)][string]$TaskName,
            [string]$TaskPath = '\',
            [Parameter(ParameterSetName = 'Definition')]$Action,
            [Parameter(ParameterSetName = 'Definition')]$Trigger,
            [Parameter(ParameterSetName = 'Definition')]$Principal,
            [Parameter(ParameterSetName = 'Definition')]$Settings,
            [Parameter(ParameterSetName = 'Definition')][string]$Description,
            [Parameter(ParameterSetName = 'Xml', Mandatory)][string]$Xml,
            [switch]$Force
        )
        if ($PSCmdlet.ParameterSetName -eq 'Xml') {
            $task = [pscustomobject]@{
                FixtureTaskName = $TaskName
                TaskName = $TaskName
                TaskPath = $TaskPath
                State = 'Ready'
                Xml = $Xml
                Principal = [pscustomobject]@{ UserId = 'fixture-restored'; LogonType = 'Interactive'; RunLevel = 'Limited' }
                Actions = @()
                Triggers = @()
                Settings = [pscustomobject]@{ Enabled = $true }
            }
        }
        else {
            $xmlValue = '<Task><RegistrationInfo><Description>fixture replacement task</Description></RegistrationInfo></Task>'
            $registeredActions = if ([string]$global:DysonDeploymentTaskFixtureCorruptRegistrationFor -ceq $TaskName) {
                @()
            }
            else { @($Action) }
            $task = [pscustomobject]@{
                FixtureTaskName = $TaskName
                TaskName = $TaskName
                TaskPath = $TaskPath
                State = 'Ready'
                Xml = $xmlValue
                Principal = $Principal
                Actions = $registeredActions
                Triggers = @($Trigger)
                Settings = $Settings
            }
        }
        $global:DysonDeploymentTaskFixture[$TaskName] = $task
        return $task
    }
}

function Disable-DysonTaskSchedulerFixture {
    foreach ($name in @(
        'Get-ScheduledTask', 'Export-ScheduledTask', 'Stop-ScheduledTask', 'Start-ScheduledTask',
        'Unregister-ScheduledTask', 'New-ScheduledTaskAction', 'New-ScheduledTaskTrigger',
        'New-ScheduledTaskPrincipal', 'New-ScheduledTaskSettingsSet', 'Register-ScheduledTask'
    )) {
        Remove-Item -Path ('Function:\global:' + $name) -Force -ErrorAction SilentlyContinue
    }
    Remove-Variable -Name DysonDeploymentTaskFixture -Scope Global -ErrorAction SilentlyContinue
    Remove-Variable -Name DysonDeploymentTaskFixtureFailRemovalFor -Scope Global -ErrorAction SilentlyContinue
    Remove-Variable -Name DysonDeploymentTaskFixtureCorruptRegistrationFor -Scope Global -ErrorAction SilentlyContinue
    Remove-Variable -Name DysonDeploymentTaskFixtureFailUnregisterOnceFor -Scope Global -ErrorAction SilentlyContinue
    Remove-Variable -Name DysonDeploymentTaskFixtureQueryFailure -Scope Global -ErrorAction SilentlyContinue
    Remove-Variable -Name DysonDeploymentTaskFixtureStopCalls -Scope Global -ErrorAction SilentlyContinue
    Remove-Variable -Name DysonDeploymentTaskFixtureStartCalls -Scope Global -ErrorAction SilentlyContinue
    Remove-Variable -Name DysonDeploymentTaskFixtureUnregisterCalls -Scope Global -ErrorAction SilentlyContinue
}

function Assert-NoInstallPartials {
    param(
        [Parameter(Mandatory)][string]$InstallRoot,
        [Parameter(Mandatory)][string]$DataRoot,
        [Parameter(Mandatory)][string]$Message
    )
    $partials = @()
    if (Test-Path -LiteralPath $InstallRoot -PathType Container) {
        $partials += @(Get-ChildItem -LiteralPath $InstallRoot -Force -ErrorAction Stop | Where-Object {
            $_.Name -like '.bootstrap-*' -or $_.Name -like '.b-*' -or
            $_.Name -like '.bo-*' -or $_.Name -ceq '.b' -or
            $_.Name -ceq '.o' -or $_.Name -like '.staging-*'
        })
        $releaseRoot = Join-Path $InstallRoot 'releases'
        if (Test-Path -LiteralPath $releaseRoot -PathType Container) {
            $partials += @(Get-ChildItem -LiteralPath $releaseRoot -Force -ErrorAction Stop | Where-Object { $_.Name -like '.staging-*' })
        }
    }
    if (Test-Path -LiteralPath $DataRoot -PathType Container) {
        $partials += @(Get-ChildItem -LiteralPath $DataRoot -Force -ErrorAction Stop | Where-Object {
            $_.Name -like '.config-restore-*' -or $_.Name -like '.config-superseded-*'
        })
    }
    Assert-SelfTest -Condition ($partials.Count -eq 0) -Message $Message
}

function New-DeploymentBrokerAuthorityProfile {
    param(
        [Parameter(Mandatory)][string]$Project,
        [Parameter(Mandatory)][string]$Data,
        [Parameter(Mandatory)][string]$AuthorityRoot,
        [Parameter(Mandatory)][string]$BootstrapIdentityRoot,
        [Parameter(Mandatory)][string]$BootstrapHashSourceRoot,
        [Parameter(Mandatory)][string]$Transactions,
        [Parameter(Mandatory)][string]$ServiceUser,
        [Parameter(Mandatory)][int]$GamePort
    )

    $taskProfile = {
        param([string]$Name, [string]$Digest)
        [pscustomobject][ordered]@{
            taskName = $Name
            taskPath = '\'
            definitionSha256 = $Digest
            enabled = $true
        }
    }
    $core = [pscustomobject][ordered]@{
        protocol = 'DYSON_GSMANAGER_AUTHORITY_PROFILE_V1'
        schemaVersion = 1
        requestId = [guid]::NewGuid().ToString('D').ToLowerInvariant()
        requestFingerprint = ('1' * 64)
        projectRootIdentity = Get-CutoverHostPathIdentity $Project
        dataRootIdentity = Get-DysonHostMutationDataRootIdentity $Data
        authorityRootIdentity = Get-CutoverHostPathIdentity $AuthorityRoot
        runtimeBootstrapIdentity = Get-CutoverHostPathIdentity $BootstrapIdentityRoot
        runtimeBootstrapStartSha256 = Get-CutoverHostSha256File (Join-Path $BootstrapHashSourceRoot 'Start-DysonServer.ps1')
        runtimeBootstrapStopSha256 = Get-CutoverHostSha256File (Join-Path $BootstrapHashSourceRoot 'Stop-DysonServer.ps1')
        runtimeTaskTransactionRootIdentity = Get-CutoverHostPathIdentity $Transactions
        serviceUser = $ServiceUser
        gamePort = $GamePort
        previousAuthority = [pscustomobject][ordered]@{
            main = & $taskProfile 'Dyson-GSManager' ('2' * 64)
            start = & $taskProfile 'Dyson-GSManager-Server' ('3' * 64)
            stop = & $taskProfile 'Dyson-GSManager-Stop' ('4' * 64)
        }
        candidateAuthority = [pscustomobject][ordered]@{
            startTaskName = 'Dyson-Nebula-Server'
            stopTaskName = 'Dyson-Nebula-Stop'
            taskPath = '\'
            legacyPreimage = [pscustomobject][ordered]@{
                startDefinitionSha256 = ('5' * 64)
                stopDefinitionSha256 = ('6' * 64)
                expectedEnabledBeforeIsolation = $true
                expectedEnabledAfterIsolation = $false
            }
            expectedPreparedDisabled = [pscustomobject][ordered]@{
                startDescriptorSha256 = ('7' * 64)
                stopDescriptorSha256 = ('8' * 64)
            }
            expectedActive = [pscustomobject][ordered]@{
                startDescriptorSha256 = ('9' * 64)
                stopDescriptorSha256 = ('a' * 64)
            }
            allowedTransitions = @('legacy-preimage-disabled', 'prepared-disabled', 'active')
        }
        previousScriptBundleRevision = ('b' * 64)
    }
    $profile = [ordered]@{}
    foreach ($property in $core.PSObject.Properties) { $profile[$property.Name] = $property.Value }
    $profile['inventoryRevision'] = Get-CutoverHostSha256Text (ConvertTo-CutoverHostJson $core)
    return [pscustomobject]$profile
}

try {
    # Installers query fixed broker tasks even when this scenario installs no
    # tasks. Isolate the scheduler before the first installer call, including
    # the identity-only scenarios, so an installed host broker cannot leak into
    # an otherwise empty temporary deployment preimage.
    Enable-DysonTaskSchedulerFixture
    $taskFixtureEnabled = $true
    Test-DysonCutoverBrokerNativeTaskCollections
    Test-DysonDeploymentBrokerQuiescence
    Test-DysonDeploymentPendingStatusPreflight
    foreach ($brokerTaskName in @('Dyson-Control-Lifecycle-Broker', 'Dyson-Control-Cutover-Broker')) {
        Assert-SelfTest -Condition (@(Get-DysonScheduledTasksByExactName -TaskName $brokerTaskName).Count -eq 0) `
            -Message 'the initial deployment fixture did not isolate a fixed broker task query'
    }
    $unsupportedCandidateName = 'DysonControl-Candidate-Fixture-' + [guid]::NewGuid().ToString('N')
    $unsupportedInstallRoot = Join-Path $env:ProgramFiles $unsupportedCandidateName
    $unsupportedDataRoot = Join-Path $env:ProgramData $unsupportedCandidateName
    foreach ($previewOnly in @($true, $false)) {
        $unsupportedLayoutMessage = $null
        try {
            & $installScript -SourcePath (Join-Path $testRoot 'missing-artifact') -Version '0.1.0-rc.1' `
                -ExpectedArtifactPayloadSha256 ('a' * 64) -RuntimeRoot (Join-Path $testRoot 'missing-runtime') `
                -NodeExecutable (Join-Path $testRoot 'missing-runtime\node.exe') -ExpectedNodeSha256 ('b' * 64) `
                -ConfigurationSource (Join-Path $testRoot 'missing.env') `
                -InstallRoot $unsupportedInstallRoot -DataRoot $unsupportedDataRoot `
                -WhatIf:$previewOnly -Confirm:$false | Out-Null
        }
        catch { $unsupportedLayoutMessage = $_.Exception.Message }
        Assert-SelfTest -Condition (
            $unsupportedLayoutMessage -eq 'A destructive deployment root inside Program Files or ProgramData must use the canonical DysonControl directory.' -and
            -not (Test-Path -LiteralPath $unsupportedInstallRoot) -and
            -not (Test-Path -LiteralPath $unsupportedDataRoot)
        ) -Message 'installer did not reject an unsupported rollback layout before reading artifacts or creating roots'
    }
    [System.IO.Directory]::CreateDirectory($testRoot) | Out-Null
    Test-DysonBrokerProfileFileAclRestore -Root $testRoot
    $finalCleanupSelfTest = Test-DysonControlDeploymentSelfTestCleanup -OuterRoot $testRoot
    $ordinarySamePrefixRoot = Join-Path $env:USERPROFILE `
        ('dyson-control-deployment-selftest-' + [guid]::NewGuid().ToString('N'))
    $ordinarySamePrefixRejected = $false
    try {
        [void](Assert-DysonDeploymentDestructiveRootLayout `
            -InstallRoot (Join-Path $ordinarySamePrefixRoot 'program-files\DysonControl') `
            -DataRoot (Join-Path $ordinarySamePrefixRoot 'program-data\DysonControl'))
    }
    catch { $ordinarySamePrefixRejected = $true }
    Assert-SelfTest -Condition $ordinarySamePrefixRejected `
        -Message 'an ordinary same-prefix temporary directory bypassed destructive-root layout checks'

    $portableBase = Join-Path ([System.IO.Path]::GetPathRoot($temporaryBase)) `
        ('DysonControl-Portable-Fixture-' + [guid]::NewGuid().ToString('N'))
    $portableLayout = Assert-DysonDeploymentDestructiveRootLayout `
        -InstallRoot (Join-Path $portableBase 'install') `
        -DataRoot (Join-Path $portableBase 'data')
    Assert-SelfTest -Condition (
        [string]$portableLayout.installRootIdentity -like '*\INSTALL' -and
        [string]$portableLayout.dataRootIdentity -like '*\DATA'
    ) -Message 'an ordinary custom root outside managed Windows/user trees lost portability'

    [System.Environment]::SetEnvironmentVariable(
        'DYSON_DEPLOYMENT_ALLOW_SELFTEST_TASKS', 'true', 'Process'
    )
    Assert-DysonDeploymentTaskSelfTestScope -InstallRoot $installRoot -DataRoot $dataRoot
    [void](Assert-DysonDeploymentDestructiveRootLayout `
        -InstallRoot $installRoot -DataRoot $dataRoot)
    $nodeFixtures = New-FictionalNodeFixtures -Root $testRoot
    $script:NodeRuntimeRoot = [string]$nodeFixtures.runtimeRoot
    $script:NodeRuntimeExecutable = [string]$nodeFixtures.node24
    $script:NodeRuntimeHash = [string]$nodeFixtures.sha256
    $script:ConfigurationShadowRoot = New-DysonDeploymentConfigurationShadowModule -Root $testRoot
    foreach ($commandName in @(
        'Install-DysonControl.ps1', 'Install-DysonControlTask.ps1',
        'Invoke-DysonControlDeployment.ps1', 'Test-DysonControlDeployment.ps1',
        'Uninstall-DysonControl.ps1', 'Start-DysonControl.ps1'
    )) {
        $PSDefaultParameterValues[($commandName + ':RuntimeRoot')] = $script:NodeRuntimeRoot
        $PSDefaultParameterValues[($commandName + ':ExpectedNodeSha256')] = $script:NodeRuntimeHash
        $PSDefaultParameterValues[($commandName + ':SelfTestConfigurationShadowRoot')] = `
            $script:ConfigurationShadowRoot
    }
    $PSDefaultParameterValues['Install-DysonControl.ps1:SelfTestSkipAdministratorCheck'] = $true
    $PSDefaultParameterValues['Install-DysonControlTask.ps1:SelfTestSkipAdministratorCheck'] = $true
    $PSDefaultParameterValues['Uninstall-DysonControl.ps1:SelfTestSkipAdministratorCheck'] = $true
    $PSDefaultParameterValues['Invoke-DysonControlDeployment.ps1:NodeExecutable'] = $script:NodeRuntimeExecutable
    $PSDefaultParameterValues['Install-DysonControl.ps1:NodeExecutable'] = $script:NodeRuntimeExecutable
    $PSDefaultParameterValues['Test-DysonControlDeployment.ps1:NodeExecutable'] = $script:NodeRuntimeExecutable
    $PSDefaultParameterValues['Uninstall-DysonControl.ps1:NodeExecutable'] = $script:NodeRuntimeExecutable
    $deploymentIdentityUninstallResult = Invoke-DeploymentIdentityUninstallSelfTest `
        -Root $testRoot -NodeExecutable $nodeFixtures.node24
    if ($DeploymentIdentityUninstallOnly) {
        $deploymentIdentityUninstallResult | ConvertTo-Json -Depth 5 -Compress
        return
    }
    $previousNodeOptions = [System.Environment]::GetEnvironmentVariable('NODE_OPTIONS', 'Process')
    $previousNodePath = [System.Environment]::GetEnvironmentVariable('NODE_PATH', 'Process')
    [System.Environment]::SetEnvironmentVariable('NODE_OPTIONS', '--require=C:\private\fixture.js', 'Process')
    [System.Environment]::SetEnvironmentVariable('NODE_PATH', 'C:\private\fixture-modules', 'Process')
    try { $node24 = Test-DysonNodeRuntime -RuntimeRoot $script:NodeRuntimeRoot `
        -NodeExecutable $nodeFixtures.node24 -ExpectedNodeSha256 $script:NodeRuntimeHash `
        -InstallRoot $installRoot -DataRoot $dataRoot -MinimumMajor 24 }
    finally {
        [System.Environment]::SetEnvironmentVariable('NODE_OPTIONS', $previousNodeOptions, 'Process')
        [System.Environment]::SetEnvironmentVariable('NODE_PATH', $previousNodePath, 'Process')
    }
    Assert-SelfTest -Condition ($node24.version -eq 'v24.0.0' -and $node24.major -eq 24) `
        -Message 'the controlled Node 24 fixture was not accepted'
    Assert-NodeRuntimeRejected -Executable $nodeFixtures.node23 -Message 'the controlled Node 23 fixture was accepted'
    Assert-NodeRuntimeRejected -Executable $nodeFixtures.fake -Message 'a fake Node version was accepted'
    Assert-NodeRuntimeRejected -Executable $nodeFixtures.prerelease -Message 'a prerelease Node version was accepted'
    Assert-NodeRuntimeRejected -Executable $nodeFixtures.leadingzero -Message 'a noncanonical Node version was accepted'
    Assert-NodeRuntimeRejected -Executable $nodeFixtures.huge -Message 'oversized Node version output was accepted'
    Assert-NodeRuntimeRejected -Executable $nodeFixtures.stderr -Message 'Node version stderr output was accepted'
    Assert-NodeRuntimeRejected -Executable $nodeFixtures.nonzero -Message 'a nonzero Node version probe was accepted'
    Assert-NodeRuntimeRejected -Executable $nodeFixtures.timeout -TimeoutMilliseconds 250 `
        -Message 'a timed-out Node version probe was accepted'
    $payloadA = Join-Path $testRoot 'payload-a'
    $payloadAConflict = Join-Path $testRoot 'payload-a-conflict'
    $payloadB = Join-Path $testRoot 'payload-b'
    $payloadC = Join-Path $testRoot 'payload-c'
    $payloadLock = Join-Path $testRoot 'payload-lock'
    $payloadPreview = Join-Path $testRoot 'payload-preview'
    $payloadInstaller = Join-Path $testRoot 'payload-installer'
    $payloadInstallerReplacement = Join-Path $testRoot 'payload-installer-replacement'
    $payloadInstallerRollback = Join-Path $testRoot 'payload-installer-rollback'
    $payloadBrokerInstaller = Join-Path $testRoot 'payload-broker-installer'
    $payloadBrokerUpgrade = Join-Path $testRoot 'payload-broker-upgrade'
    $payloadLifecycleBrokerTampered = Join-Path $testRoot 'payload-lifecycle-broker-tampered'
    $payloadLifecycleBrokerMissing = Join-Path $testRoot 'payload-lifecycle-broker-missing'
    $payloadLifecycleBrokerExtra = Join-Path $testRoot 'payload-lifecycle-broker-extra'
    $payloadTampered = Join-Path $testRoot 'payload-tampered'
    $payloadMissing = Join-Path $testRoot 'payload-missing'
    $payloadExtra = Join-Path $testRoot 'payload-extra'
    $payloadVersionMismatch = Join-Path $testRoot 'payload-version-mismatch'
    $payloadNodeMinimumMismatch = Join-Path $testRoot 'payload-node-minimum-mismatch'
    $sourceVerifierSentinel = Join-Path $testRoot 'source-owned-verifier-executed.txt'
    $payloadSourceVerifierStage = Join-Path $testRoot 'payload-source-verifier-stage'
    $payloadSourceVerifierUpgrade = Join-Path $testRoot 'payload-source-verifier-upgrade'
    $payloadSourceVerifierInstall = Join-Path $testRoot 'payload-source-verifier-install'
    New-FictionalPayload -Root $payloadA -Version '1.0.0'
    New-FictionalPayload -Root $payloadAConflict -Version '1.0.0' -ContentMarker 'different-immutable-content'
    New-FictionalPayload -Root $payloadB -Version '1.1.0'
    New-FictionalPayload -Root $payloadC -Version '1.2.0'
    New-FictionalPayload -Root $payloadLock -Version '8.8.8-lock-test'
    New-FictionalPayload -Root $payloadPreview -Version '9.9.9-preview'
    New-FictionalPayload -Root $payloadInstaller -Version '2.0.0'
    New-FictionalPayload -Root $payloadInstallerReplacement -Version '2.1.0'
    New-FictionalPayload -Root $payloadInstallerRollback -Version '2.2.0'
    New-FictionalPayload -Root $payloadBrokerInstaller -Version '4.0.0'
    New-FictionalPayload -Root $payloadBrokerUpgrade -Version '4.1.0'
    New-FictionalPayload -Root $payloadLifecycleBrokerTampered -Version '4.2.0'
    New-FictionalPayload -Root $payloadLifecycleBrokerMissing -Version '4.2.1'
    New-FictionalPayload -Root $payloadLifecycleBrokerExtra -Version '4.2.2'
    New-FictionalPayload -Root $payloadTampered -Version '3.0.0'
    New-FictionalPayload -Root $payloadMissing -Version '3.0.1'
    New-FictionalPayload -Root $payloadExtra -Version '3.0.2'
    New-FictionalPayload -Root $payloadVersionMismatch -Version '3.0.3-Case'
    New-FictionalPayload -Root $payloadNodeMinimumMismatch -Version '3.0.5'
    New-FictionalPayload -Root $payloadSourceVerifierStage -Version '9.8.1-source-stage' `
        -VerifierSentinelPath $sourceVerifierSentinel
    New-FictionalPayload -Root $payloadSourceVerifierUpgrade -Version '9.8.2-source-upgrade' `
        -VerifierSentinelPath $sourceVerifierSentinel
    New-FictionalPayload -Root $payloadSourceVerifierInstall -Version '9.8.3-source-install' `
        -VerifierSentinelPath $sourceVerifierSentinel
    [System.IO.File]::AppendAllText(
        (Join-Path $payloadTampered 'apps\api\dist\index.js'),
        "// tampered after manifest`n",
        [System.Text.UTF8Encoding]::new($false)
    )
    [System.IO.File]::AppendAllText(
        (Join-Path $payloadLifecycleBrokerTampered `
            'scripts\windows\lifecycle-broker\DysonLifecycleBroker.Common.ps1'),
        "# tampered after manifest`n",
        [System.Text.UTF8Encoding]::new($false)
    )
    Remove-Item -LiteralPath (Join-Path $payloadLifecycleBrokerMissing `
        'scripts\windows\lifecycle-broker\SelfTest-DysonLifecycleBroker.ps1') -Force
    [System.IO.File]::WriteAllText(
        (Join-Path $payloadLifecycleBrokerExtra `
            'scripts\windows\lifecycle-broker\Unexpected-LifecycleBroker.ps1'),
        "throw 'unexpected lifecycle broker fixture'`n",
        [System.Text.UTF8Encoding]::new($false)
    )
    Remove-Item -LiteralPath (Join-Path $payloadMissing 'apps\web\dist\index.html') -Force
    [System.IO.File]::WriteAllText(
        (Join-Path $payloadExtra 'apps\web\dist\unexpected.js'),
        "console.log('unexpected artifact member')`n",
        [System.Text.UTF8Encoding]::new($false)
    )
    $nodeMinimumManifestPath = Join-Path $payloadNodeMinimumMismatch 'artifact-manifest.json'
    $nodeMinimumManifest = [System.IO.File]::ReadAllText($nodeMinimumManifestPath, [System.Text.Encoding]::UTF8) | ConvertFrom-Json
    $nodeMinimumManifest.nodeMinimumMajor = 23
    [System.IO.File]::WriteAllText(
        $nodeMinimumManifestPath,
        ($nodeMinimumManifest | ConvertTo-Json -Depth 12 -Compress),
        [System.Text.UTF8Encoding]::new($false)
    )
    [System.IO.Directory]::CreateDirectory((Join-Path $dataRoot 'config')) | Out-Null
    [System.IO.Directory]::CreateDirectory((Join-Path $dataRoot 'data')) | Out-Null
    [System.IO.File]::WriteAllText(
        (Join-Path $dataRoot 'config\dyson-control.env'),
        "NODE_ENV=production`nDYSON_HOST=127.0.0.1`nDYSON_LIFECYCLE_ENABLED=false`n",
        [System.Text.UTF8Encoding]::new($false)
    )
    [System.IO.File]::WriteAllText(
        (Join-Path $dataRoot 'data\persistent-sentinel.txt'),
        'must-survive-release-changes',
        [System.Text.UTF8Encoding]::new($false)
    )

    Assert-ArtifactStageRejected -Payload $payloadTampered -Version '3.0.0' `
        -Message 'a payload whose bytes no longer match the artifact manifest was accepted'
    Assert-ArtifactStageRejected -Payload $payloadMissing -Version '3.0.1' `
        -Message 'an artifact with a manifest-listed file missing was accepted'
    Assert-ArtifactStageRejected -Payload $payloadExtra -Version '3.0.2' `
        -Message 'an artifact with an extra file outside its manifest was accepted'
    Assert-ArtifactStageRejected -Payload $payloadVersionMismatch -Version '3.0.3-case' `
        -Message 'an artifact whose manifest version differs by case from the requested release was accepted'
    Assert-ArtifactStageRejected -Payload $payloadNodeMinimumMismatch -Version '3.0.5' `
        -Message 'an artifact with an unsupported Node minimum major was accepted'
    Assert-ArtifactStageRejected -Payload $payloadLifecycleBrokerTampered -Version '4.2.0' `
        -Message 'a hash-tampered lifecycle broker artifact was accepted'
    Assert-ArtifactStageRejected -Payload $payloadLifecycleBrokerMissing -Version '4.2.1' `
        -Message 'an artifact missing a lifecycle broker file was accepted'
    Assert-ArtifactStageRejected -Payload $payloadLifecycleBrokerExtra -Version '4.2.2' `
        -Message 'an artifact with an extra lifecycle broker file was accepted'

    $missingProvenanceRoot = Join-Path $testRoot 'missing-provenance-program-files\DysonControl'
    $missingProvenanceData = Join-Path $testRoot 'missing-provenance-program-data\DysonControl'
    $missingProvenanceRejected = $false
    try {
        & $deploymentScript -Operation Stage -SourcePath $payloadSourceVerifierStage `
            -Version '9.8.1-source-stage' -InstallRoot $missingProvenanceRoot `
            -DataRoot $missingProvenanceData -Confirm:$false | Out-Null
    }
    catch {
        $missingProvenanceRejected = $_.Exception.Message -ceq `
            'ExpectedArtifactPayloadSha256 is required for Stage.'
    }
    Assert-SelfTest -Condition ($missingProvenanceRejected -and
        -not (Test-Path -LiteralPath $missingProvenanceRoot) -and
        -not (Test-Path -LiteralPath $missingProvenanceData) -and
        -not (Test-Path -LiteralPath $sourceVerifierSentinel)) `
        -Message 'a Stage operation without independent artifact provenance did not fail before mutation'

    $mismatchedProvenanceRoot = Join-Path $testRoot 'mismatched-provenance-program-files\DysonControl'
    $mismatchedProvenanceData = Join-Path $testRoot 'mismatched-provenance-program-data\DysonControl'
    $mismatchedProvenanceRejected = $false
    try {
        & $deploymentScript -Operation Stage -SourcePath $payloadSourceVerifierStage `
            -Version '9.8.1-source-stage' `
            -ExpectedArtifactPayloadSha256 ([string]::new([char]'0', 64)) `
            -InstallRoot $mismatchedProvenanceRoot -DataRoot $mismatchedProvenanceData `
            -Confirm:$false | Out-Null
    }
    catch {
        $mismatchedProvenanceRejected = $_.Exception.Message -ceq `
            'The source release artifact payload does not match the independently verified provenance.'
    }
    Assert-SelfTest -Condition ($mismatchedProvenanceRejected -and
        -not (Test-Path -LiteralPath $mismatchedProvenanceRoot) -and
        -not (Test-Path -LiteralPath $mismatchedProvenanceData) -and
        -not (Test-Path -LiteralPath $sourceVerifierSentinel)) `
        -Message 'a mismatched artifact provenance digest did not fail before mutation'

    $sourceVerifierDeploymentRoot = Join-Path $testRoot 'source-verifier-program-files\DysonControl'
    $sourceVerifierDeploymentData = Join-Path $testRoot 'source-verifier-program-data\DysonControl'
    $sourceStageDigest = Get-FictionalPayloadSha256 -Root $payloadSourceVerifierStage
    $sourceStagePreviewOutput = & $deploymentScript -Operation Stage `
        -SourcePath $payloadSourceVerifierStage -Version '9.8.1-source-stage' `
        -ExpectedArtifactPayloadSha256 $sourceStageDigest -InstallRoot $sourceVerifierDeploymentRoot `
        -DataRoot $sourceVerifierDeploymentData -WhatIf 6>$null
    $sourceStagePreview = ($sourceStagePreviewOutput | Out-String).Trim() | ConvertFrom-Json
    Assert-SelfTest -Condition ([string]$sourceStagePreview.state -ceq 'preview' -and
        [bool]$sourceStagePreview.sourceValidated -and [bool]$sourceStagePreview.artifactProvenanceBound -and
        -not [bool]$sourceStagePreview.sourceArtifactScriptsExecuted -and
        -not (Test-Path -LiteralPath $sourceVerifierDeploymentRoot) -and
        -not (Test-Path -LiteralPath $sourceVerifierDeploymentData) -and
        -not (Test-Path -LiteralPath $sourceVerifierSentinel)) `
        -Message 'Stage WhatIf executed a source-owned verifier or mutated deployment state'
    $sourceStageResult = Invoke-DeploymentJson -Arguments @{
        Operation = 'Stage'; SourcePath = $payloadSourceVerifierStage
        Version = '9.8.1-source-stage'; InstallRoot = $sourceVerifierDeploymentRoot
        DataRoot = $sourceVerifierDeploymentData
    }
    Assert-SelfTest -Condition ([string]$sourceStageResult.state -ceq 'staged' -and
        [bool]$sourceStageResult.artifactProvenanceBound -and
        -not [bool]$sourceStageResult.sourceArtifactScriptsExecuted -and
        -not (Test-Path -LiteralPath $sourceVerifierSentinel)) `
        -Message 'normal Stage executed the source-owned verifier'

    $sourceUpgradeDigest = Get-FictionalPayloadSha256 -Root $payloadSourceVerifierUpgrade
    $sourceUpgradePreviewOutput = & $deploymentScript -Operation Upgrade `
        -SourcePath $payloadSourceVerifierUpgrade -Version '9.8.2-source-upgrade' `
        -ExpectedArtifactPayloadSha256 $sourceUpgradeDigest -InstallRoot $sourceVerifierDeploymentRoot `
        -DataRoot $sourceVerifierDeploymentData -WhatIf 6>$null
    $sourceUpgradePreview = ($sourceUpgradePreviewOutput | Out-String).Trim() | ConvertFrom-Json
    Assert-SelfTest -Condition ([string]$sourceUpgradePreview.state -ceq 'preview' -and
        [bool]$sourceUpgradePreview.artifactProvenanceBound -and
        -not [bool]$sourceUpgradePreview.sourceArtifactScriptsExecuted -and
        -not (Test-Path -LiteralPath (Join-Path $sourceVerifierDeploymentRoot `
            'releases\9.8.2-source-upgrade')) -and
        -not (Test-Path -LiteralPath $sourceVerifierSentinel)) `
        -Message 'Upgrade WhatIf executed a source-owned verifier or staged the candidate'
    $sourceUpgradeResult = Invoke-DeploymentJson -Arguments @{
        Operation = 'Upgrade'; SourcePath = $payloadSourceVerifierUpgrade
        Version = '9.8.2-source-upgrade'; InstallRoot = $sourceVerifierDeploymentRoot
        DataRoot = $sourceVerifierDeploymentData
    }
    Assert-SelfTest -Condition ([string]$sourceUpgradeResult.state -ceq 'upgraded' -and
        [bool]$sourceUpgradeResult.artifactProvenanceBound -and
        -not [bool]$sourceUpgradeResult.sourceArtifactScriptsExecuted -and
        (Get-ActiveVersionAt -DataRoot $sourceVerifierDeploymentData) -ceq '9.8.2-source-upgrade' -and
        -not (Test-Path -LiteralPath $sourceVerifierSentinel)) `
        -Message 'normal Upgrade executed the source-owned verifier or failed to activate'

    $sourceVerifierInstallRoot = Join-Path $testRoot 'source-verifier-install-program-files\DysonControl'
    $sourceVerifierInstallData = Join-Path $testRoot 'source-verifier-install-program-data\DysonControl'
    $sourceVerifierConfiguration = Join-Path $testRoot 'source-verifier-production.env'
    [System.IO.File]::WriteAllText(
        $sourceVerifierConfiguration,
        "NODE_ENV=production`nDYSON_HOST=127.0.0.1`nDYSON_PROVIDER=demo`nDYSON_ADMIN_PASSWORD_HASH=scrypt`$fictional`nDYSON_SESSION_SECRET=fictional-source-verifier-session-secret`n",
        [System.Text.UTF8Encoding]::new($false)
    )
    [void][System.IO.Directory]::CreateDirectory(
        [System.IO.Path]::GetDirectoryName($sourceVerifierInstallData)
    )
    $sourceInstallDigest = Get-FictionalPayloadSha256 -Root $payloadSourceVerifierInstall
    $sourceInstallPreviewOutput = & $installScript -SourcePath $payloadSourceVerifierInstall `
        -Version '9.8.3-source-install' -ExpectedArtifactPayloadSha256 $sourceInstallDigest `
        -NodeExecutable $nodeFixtures.previewtrap -InstallRoot $sourceVerifierInstallRoot `
        -DataRoot $sourceVerifierInstallData -ConfigurationSource $sourceVerifierConfiguration `
        -WhatIf 6>$null
    $sourceInstallPreview = ($sourceInstallPreviewOutput | Out-String).Trim() | ConvertFrom-Json
    Assert-SelfTest -Condition ([string]$sourceInstallPreview.state -ceq 'preview' -and
        [bool]$sourceInstallPreview.artifactProvenanceBound -and
        -not [bool]$sourceInstallPreview.sourceArtifactScriptsExecuted -and
        -not (Test-Path -LiteralPath $sourceVerifierInstallRoot) -and
        -not (Test-Path -LiteralPath $sourceVerifierInstallData) -and
        -not (Test-Path -LiteralPath $sourceVerifierSentinel)) `
        -Message 'Install WhatIf executed a source-owned verifier or mutated deployment state'
    $sourceInstallOutput = & $installScript -SourcePath $payloadSourceVerifierInstall `
        -Version '9.8.3-source-install' -ExpectedArtifactPayloadSha256 $sourceInstallDigest `
        -NodeExecutable $nodeFixtures.node24 -InstallRoot $sourceVerifierInstallRoot `
        -DataRoot $sourceVerifierInstallData -ConfigurationSource $sourceVerifierConfiguration `
        -Confirm:$false
    $sourceInstallResult = ($sourceInstallOutput | Out-String).Trim() | ConvertFrom-Json
    Assert-SelfTest -Condition ([string]$sourceInstallResult.state -ceq 'installed' -and
        [bool]$sourceInstallResult.artifactProvenanceBound -and
        -not [bool]$sourceInstallResult.sourceArtifactScriptsExecuted -and
        -not (Test-Path -LiteralPath $sourceVerifierSentinel)) `
        -Message 'normal Install executed the source-owned verifier'

    $stageA = Invoke-DeploymentJson -Arguments @{
        Operation = 'Stage'; SourcePath = $payloadA; Version = '1.0.0'; InstallRoot = $installRoot; DataRoot = $dataRoot
    }
    Assert-SelfTest -Condition ($stageA.state -eq 'staged') -Message 'release A was not staged'
    $stageAAgain = Invoke-DeploymentJson -Arguments @{
        Operation = 'Stage'; SourcePath = $payloadA; Version = '1.0.0'; InstallRoot = $installRoot; DataRoot = $dataRoot
    }
    Assert-SelfTest -Condition ($stageAAgain.state -eq 'already-staged') -Message 'staging was not idempotent'
    $immutableConflictObserved = $false
    try {
        & $deploymentScript -Operation Stage -SourcePath $payloadAConflict -Version '1.0.0' `
            -ExpectedArtifactPayloadSha256 (Get-FictionalPayloadSha256 -Root $payloadAConflict) `
            -InstallRoot $installRoot -DataRoot $dataRoot -Confirm:$false | Out-Null
    }
    catch { $immutableConflictObserved = $true }
    Assert-SelfTest -Condition $immutableConflictObserved -Message 'different content overwrote an immutable version'

    $exclusiveLockObserved = $false
    $heldLock = [System.IO.FileStream]::new(
        (Get-DysonDeploymentLockPath -DataRoot $dataRoot),
        [System.IO.FileMode]::OpenOrCreate,
        [System.IO.FileAccess]::ReadWrite,
        [System.IO.FileShare]::None
    )
    try {
        try {
            & $deploymentScript -Operation Stage -SourcePath $payloadLock -Version '8.8.8-lock-test' `
                -ExpectedArtifactPayloadSha256 (Get-FictionalPayloadSha256 -Root $payloadLock) `
                -InstallRoot $installRoot -DataRoot $dataRoot -LockTimeoutSeconds 1 -Confirm:$false | Out-Null
        }
        catch { $exclusiveLockObserved = $true }
    }
    finally { $heldLock.Dispose() }
    Assert-SelfTest -Condition $exclusiveLockObserved -Message 'the exclusive deployment lock did not reject a concurrent operation'
    Assert-SelfTest -Condition (-not (Test-Path -LiteralPath (Join-Path $installRoot 'releases\8.8.8-lock-test'))) -Message 'a lock-rejected release was staged'

    $invalidLockDataRoot = Join-Path $testRoot 'invalid-lock-data\DysonControl'
    [void][System.IO.Directory]::CreateDirectory(
        (ConvertTo-DysonDeploymentSelfTestExtendedPath -Path `
            ([System.IO.Path]::GetDirectoryName($invalidLockDataRoot)))
    )
    $invalidLockPath = Get-DysonDeploymentLockPath -DataRoot $invalidLockDataRoot
    [void][System.IO.Directory]::CreateDirectory(
        (ConvertTo-DysonDeploymentSelfTestExtendedPath -Path `
            ([System.IO.Path]::GetDirectoryName($invalidLockPath)))
    )
    [void][System.IO.Directory]::CreateDirectory(
        (ConvertTo-DysonDeploymentSelfTestExtendedPath -Path $invalidLockPath)
    )
    $invalidLockFailureClassified = $false
    try { [void](Enter-DysonDeploymentLock -DataRoot $invalidLockDataRoot -TimeoutSeconds 1) }
    catch {
        $invalidLockFailureClassified = $_.Exception.Message -ceq `
            'The deployment lock file could not be opened.'
    }
    finally {
        [System.IO.Directory]::Delete(
            (ConvertTo-DysonDeploymentSelfTestExtendedPath -Path $invalidLockPath),
            $false
        )
    }
    Assert-SelfTest -Condition $invalidLockFailureClassified `
        -Message 'a non-contention lock-path failure was misreported as an active deployment owner'

    $activateA = Invoke-DeploymentJson -Arguments @{
        Operation = 'Activate'; Version = '1.0.0'; InstallRoot = $installRoot; DataRoot = $dataRoot
    }
    Assert-SelfTest -Condition ($activateA.state -eq 'activated' -and (Get-ActiveVersion) -eq '1.0.0') -Message 'release A was not activated'

    $upgradeB = Invoke-DeploymentJson -Arguments @{
        Operation = 'Upgrade'; SourcePath = $payloadB; Version = '1.1.0'; InstallRoot = $installRoot; DataRoot = $dataRoot
    }
    Assert-SelfTest -Condition ($upgradeB.state -eq 'upgraded' -and (Get-ActiveVersion) -eq '1.1.0') -Message 'release B was not upgraded'
    $snapshotBeforeB = [string]$upgradeB.snapshotId

    [System.IO.File]::WriteAllText(
        (Join-Path $dataRoot 'config\dyson-control.env'),
        "NODE_ENV=production`nDYSON_HOST=127.0.0.1`nDYSON_PORT=13999`nDYSON_LIFECYCLE_ENABLED=false`n",
        [System.Text.UTF8Encoding]::new($false)
    )

    $listener = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, 0)
    $listener.Start()
    $readinessPort = ([System.Net.IPEndPoint]$listener.LocalEndpoint).Port
    $listener.Stop()
    $pointerForJob = Join-Path $dataRoot 'state\active-release.json'
    $readinessJob = Start-Job -ArgumentList $readinessPort, $pointerForJob, $readinessStopPath -ScriptBlock {
        param($Port, $PointerPath, $StopPath)
        $server = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, [int]$Port)
        $server.Start()
        try {
            while (-not (Test-Path -LiteralPath $StopPath)) {
                $client = $server.AcceptTcpClient()
                try {
                    $stream = $client.GetStream()
                    $reader = [System.IO.StreamReader]::new($stream, [System.Text.Encoding]::ASCII, $false, 1024, $true)
                    while (($line = $reader.ReadLine()) -ne $null -and $line.Length -gt 0) { }
                    $version = $null
                    try { $version = ([System.IO.File]::ReadAllText($PointerPath) | ConvertFrom-Json).version } catch { }
                    $status = if ($version -eq '1.1.0') { '200 OK' } else { '503 Service Unavailable' }
                    $body = if ($version -eq '1.1.0') {
                        '{"status":"ready","deploymentVersion":"1.1.0","checks":{"deploymentVersion":"pass","statusProvider":"pass","projectRoot":"pass","activationRecovery":"not-applicable"}}'
                    }
                    else {
                        '{"status":"not-ready","deploymentVersion":"1.2.0","checks":{"deploymentVersion":"pass","statusProvider":"fail","projectRoot":"pass","activationRecovery":"not-applicable"}}'
                    }
                    $bytes = [System.Text.Encoding]::UTF8.GetBytes($body)
                    $headers = "HTTP/1.1 $status`r`nContent-Type: application/json`r`nX-Dyson-Control-Release: $version`r`nContent-Length: $($bytes.Length)`r`nConnection: close`r`n`r`n"
                    $headerBytes = [System.Text.Encoding]::ASCII.GetBytes($headers)
                    $stream.Write($headerBytes, 0, $headerBytes.Length)
                    $stream.Write($bytes, 0, $bytes.Length)
                    $stream.Flush()
                }
                finally { $client.Dispose() }
            }
        }
        finally { $server.Stop() }
    }
    $readinessUri = [uri]("http://127.0.0.1:$readinessPort/readyz")
    $readyDeadline = (Get-Date).AddSeconds(10)
    do {
        try { $ready = (Invoke-WebRequest -Uri $readinessUri -UseBasicParsing -TimeoutSec 1).StatusCode -eq 200 }
        catch { $ready = $false }
        if (-not $ready) { Start-Sleep -Milliseconds 100 }
    } while (-not $ready -and (Get-Date) -lt $readyDeadline)
    Assert-SelfTest -Condition $ready -Message 'the fictional readiness endpoint did not start'

    $failedUpgradeObserved = $false
    try {
        & $deploymentScript -Operation Upgrade -SourcePath $payloadC -Version '1.2.0' `
            -ExpectedArtifactPayloadSha256 (Get-FictionalPayloadSha256 -Root $payloadC) `
            -InstallRoot $installRoot -DataRoot $dataRoot -ReadinessUri $readinessUri -ReadinessTimeoutSeconds 1 -Confirm:$false | Out-Null
    }
    catch { $failedUpgradeObserved = $true }
    Assert-SelfTest -Condition $failedUpgradeObserved -Message 'a failed readiness check did not fail the upgrade'
    Assert-SelfTest -Condition ((Get-ActiveVersion) -eq '1.1.0') -Message 'a failed upgrade did not restore release B'

    $rollback = Invoke-DeploymentJson -Arguments @{
        Operation = 'Rollback'; SnapshotId = $snapshotBeforeB; InstallRoot = $installRoot; DataRoot = $dataRoot
    }
    Assert-SelfTest -Condition ($rollback.state -eq 'rolled-back' -and (Get-ActiveVersion) -eq '1.0.0') -Message 'explicit rollback did not restore release A'
    $restoredConfig = [System.IO.File]::ReadAllText((Join-Path $dataRoot 'config\dyson-control.env'), [System.Text.Encoding]::UTF8)
    Assert-SelfTest -Condition ($restoredConfig -notmatch 'DYSON_PORT=13999') -Message 'rollback did not restore the pre-upgrade configuration snapshot'
    Assert-SelfTest -Condition (Test-Path -LiteralPath (Join-Path $dataRoot 'data\persistent-sentinel.txt') -PathType Leaf) -Message 'release operations changed persistent data'

    $preview = & $deploymentScript -Operation Stage -SourcePath $payloadPreview -Version '9.9.9-preview' `
        -ExpectedArtifactPayloadSha256 (Get-FictionalPayloadSha256 -Root $payloadPreview) `
        -InstallRoot $installRoot -DataRoot $dataRoot -WhatIf 6>$null | Out-String
    Assert-SelfTest -Condition (($preview | ConvertFrom-Json).state -eq 'preview') -Message 'WhatIf did not return a deployment preview'
    Assert-SelfTest -Condition (-not (Test-Path -LiteralPath (Join-Path $installRoot 'releases\9.9.9-preview'))) -Message 'WhatIf staged a release'

    $auditRecords = @(Get-Content -LiteralPath (Join-Path $dataRoot 'audit\deployment.jsonl') | ForEach-Object { $_ | ConvertFrom-Json })
    Assert-SelfTest -Condition ($auditRecords.Count -ge 10) -Message 'durable deployment audit records were not emitted'
    $rolledBackAuditCount = @($auditRecords | Where-Object { $_.code -eq 'UPGRADE_ROLLED_BACK' }).Count
    Assert-SelfTest -Condition ($rolledBackAuditCount -ge 1) -Message "failed-upgrade rollback was not audited (count=$rolledBackAuditCount)"

    $installerRoot = Join-Path $testRoot 'installer-program-files\DysonControl'
    $installerData = Join-Path $testRoot 'installer-program-data\DysonControl'
    [System.IO.Directory]::CreateDirectory([System.IO.Path]::GetDirectoryName($installerData)) | Out-Null
    $installerConfig = Join-Path $testRoot 'fictional-production.env'
    $launcherResultPath = Join-Path $installerData 'data\launcher-result.json'
    [System.IO.File]::WriteAllText(
        $installerConfig,
        "NODE_ENV=production`nDYSON_HOST=203.0.113.50`nDYSON_PROVIDER=demo`nDYSON_ADMIN_PASSWORD_HASH=scrypt`$fictional`nDYSON_SESSION_SECRET=fictional-session-secret-at-least-32-characters`nDYSON_SELFTEST_OUTPUT=$launcherResultPath`n",
        [System.Text.UTF8Encoding]::new($false)
    )
    $nodeCommand = Get-Command node.exe -ErrorAction SilentlyContinue
    if (-not $nodeCommand) { $nodeCommand = Get-Command node -ErrorAction Stop }
    $previewNodeSentinel = Join-Path $testRoot 'preview-node-was-executed'
    $previewInstallerRoot = Join-Path $testRoot 'preview-installer-program-files\DysonControl'
    $previewInstallerData = Join-Path $testRoot 'preview-installer-program-data\DysonControl'
    [System.Environment]::SetEnvironmentVariable('DYSON_NODE_PROBE_SENTINEL', $previewNodeSentinel, 'Process')
    try {
        $installPreviewOutput = & $installScript -SourcePath $payloadInstaller -Version '2.0.0' `
            -ExpectedArtifactPayloadSha256 (Get-FictionalPayloadSha256 -Root $payloadInstaller) `
            -NodeExecutable $nodeFixtures.previewtrap -InstallRoot $previewInstallerRoot `
            -DataRoot $previewInstallerData -ConfigurationSource $installerConfig -WhatIf 6>$null
    }
    finally { Remove-Item Env:DYSON_NODE_PROBE_SENTINEL -ErrorAction SilentlyContinue }
    $installPreview = ($installPreviewOutput | Out-String).Trim() | ConvertFrom-Json
    Assert-SelfTest -Condition ($installPreview.state -eq 'preview' -and [bool]$installPreview.persistentCutoverDataWillBeCreated) `
        -Message 'installer WhatIf did not return a complete persistent cutover-data preview'
    Assert-SelfTest -Condition (-not (Test-Path -LiteralPath $previewNodeSentinel)) `
        -Message 'installer WhatIf executed the supplied Node executable'
    Assert-SelfTest -Condition (-not (Test-Path -LiteralPath $previewInstallerRoot)) `
        -Message 'installer WhatIf mutated the install root'
    Assert-SelfTest -Condition (-not (Test-Path -LiteralPath $previewInstallerData)) `
        -Message 'installer WhatIf mutated the data root'

    $lowNodeInstallerRoot = Join-Path $testRoot 'low-node-installer-program-files\DysonControl'
    $lowNodeInstallerData = Join-Path $testRoot 'low-node-installer-program-data\DysonControl'
    $lowNodeInstallRejected = $false
    try {
        & $installScript -SourcePath $payloadInstaller -Version '2.0.0' -NodeExecutable $nodeFixtures.node23 `
            -ExpectedArtifactPayloadSha256 (Get-FictionalPayloadSha256 -Root $payloadInstaller) `
            -InstallRoot $lowNodeInstallerRoot -DataRoot $lowNodeInstallerData `
            -ConfigurationSource $installerConfig -Confirm:$false | Out-Null
    }
    catch { $lowNodeInstallRejected = $_.Exception.Message -eq 'Node.js runtime verification failed.' }
    Assert-SelfTest -Condition $lowNodeInstallRejected -Message 'the installer accepted Node 23'
    Assert-SelfTest -Condition (-not (Test-Path -LiteralPath $lowNodeInstallerRoot)) `
        -Message 'the rejected Node 23 installer mutated the install root'
    Assert-SelfTest -Condition (-not (Test-Path -LiteralPath $lowNodeInstallerData)) `
        -Message 'the rejected Node 23 installer mutated the data root'

    $invalidInstallerRoot = Join-Path $testRoot 'invalid-installer-program-files\DysonControl'
    $invalidInstallerData = Join-Path $testRoot 'invalid-installer-program-data\DysonControl'
    $invalidInstallRejected = $false
    try {
        & $installScript -SourcePath $payloadTampered -Version '3.0.0' -NodeExecutable $nodeCommand.Source `
            -ExpectedArtifactPayloadSha256 (Get-FictionalPayloadSha256 -Root $payloadTampered) `
            -InstallRoot $invalidInstallerRoot -DataRoot $invalidInstallerData `
            -ConfigurationSource $installerConfig -Confirm:$false | Out-Null
    }
    catch { $invalidInstallRejected = $true }
    Assert-SelfTest -Condition $invalidInstallRejected -Message 'the installer accepted a tampered clean artifact'
    Assert-SelfTest -Condition (-not (Test-Path -LiteralPath $invalidInstallerRoot)) `
        -Message 'a rejected installer artifact mutated the install root'
    Assert-SelfTest -Condition (-not (Test-Path -LiteralPath $invalidInstallerData)) `
        -Message 'a rejected installer artifact mutated the data root'

    $installerOutput = & $installScript -SourcePath $payloadInstaller -Version '2.0.0' -NodeExecutable $nodeFixtures.node24 `
        -ExpectedArtifactPayloadSha256 (Get-FictionalPayloadSha256 -Root $payloadInstaller) `
        -InstallRoot $installerRoot -DataRoot $installerData -ConfigurationSource $installerConfig -Confirm:$false
    $installerResult = ($installerOutput | Out-String).Trim() | ConvertFrom-Json
    Assert-SelfTest -Condition ($installerResult.state -eq 'installed' -and [bool]$installerResult.persistentCutoverDataReady) `
        -Message 'the reusable installer did not complete with persistent cutover data ready'
    $installedReleaseManifest = [System.IO.File]::ReadAllText(
        (Join-Path $installerRoot 'releases\2.0.0\release-manifest.json'),
        [System.Text.Encoding]::UTF8
    ) | ConvertFrom-Json
    Assert-SelfTest -Condition ([int]$installedReleaseManifest.nodeMinimumMajor -eq 24) `
        -Message 'the verified artifact Node minimum was not retained in the immutable release manifest'
    Assert-SelfTest -Condition (Test-Path -LiteralPath (Join-Path $installerData 'data\cutover') -PathType Container) `
        -Message 'the installer did not create the persistent cutover data directory'
    foreach ($cutoverRelative in $script:DysonArtifactRequiredCutoverScripts) {
        $installedCutoverPath = Join-Path $installerRoot `
            ("releases\2.0.0\" + $cutoverRelative.Replace('/', '\'))
        Assert-SelfTest -Condition ([System.IO.File]::Exists(
            (ConvertTo-DysonDeploymentSelfTestExtendedPath -Path $installedCutoverPath)
        )) `
            -Message "the installed immutable release omitted a cutover host script: $cutoverRelative"
    }
    foreach ($brokerRelative in $script:DysonArtifactRequiredCutoverBrokerScripts) {
        $installedCutoverBrokerPath = Join-Path $installerRoot `
            ("releases\2.0.0\" + $brokerRelative.Replace('/', '\'))
        Assert-SelfTest -Condition ([System.IO.File]::Exists(
            (ConvertTo-DysonDeploymentSelfTestExtendedPath -Path $installedCutoverBrokerPath)
        )) `
            -Message "the installed immutable release omitted a cutover broker script: $brokerRelative"
    }
    foreach ($brokerRelative in $script:DysonArtifactRequiredLifecycleBrokerScripts) {
        $installedLifecycleBrokerPath = Join-Path $installerRoot `
            ("releases\2.0.0\" + $brokerRelative.Replace('/', '\'))
        Assert-SelfTest -Condition ([System.IO.File]::Exists(
            (ConvertTo-DysonDeploymentSelfTestExtendedPath -Path $installedLifecycleBrokerPath)
        )) `
            -Message "the installed immutable release omitted a lifecycle broker script: $brokerRelative"
    }
    $installedLifecycleBrokerRoot = Join-Path $installerRoot 'releases\2.0.0\scripts\windows\lifecycle-broker'
    $installedLifecycleBrokerNames = @(Get-ChildItem -LiteralPath $installedLifecycleBrokerRoot -Force |
        ForEach-Object { $_.Name } | Sort-Object -CaseSensitive)
    $expectedLifecycleBrokerNames = @($script:DysonArtifactRequiredLifecycleBrokerScripts |
        ForEach-Object { Split-Path $_ -Leaf } | Sort-Object -CaseSensitive)
    Assert-SelfTest -Condition (($installedLifecycleBrokerNames -join '|') -ceq
        ($expectedLifecycleBrokerNames -join '|')) `
        -Message 'the installed immutable release did not retain the exact six-file lifecycle broker directory'
    Assert-SelfTest -Condition (-not [bool]$installerResult.cutoverBrokerTaskRequested -and
        -not [bool]$installerResult.cutoverBrokerTaskInstalled -and
        -not [bool]$installerResult.cutoverBrokerDataReady -and
        -not (Test-Path -LiteralPath (Join-Path $installerData 'data\cutover-broker'))) `
        -Message 'the default reusable install invoked or provisioned the cutover broker without its explicit switch'
    foreach ($bootstrapName in @(
        'DysonDeployment.Common.ps1',
        'DysonDeployment.Configuration.ps1',
        'Start-DysonControl.ps1',
        'DysonGameLifecycleBootstrap.Common.ps1',
        'Resolve-DysonGameLifecycleRelease.ps1',
        'Start-DysonServer.ps1',
        'Stop-DysonServer.ps1'
    )) {
        Assert-SelfTest -Condition (Test-Path -LiteralPath (Join-Path $installerRoot "bootstrap\$bootstrapName") -PathType Leaf) `
            -Message "the stable bootstrap file was not installed: $bootstrapName"
    }
    foreach ($configurationBootstrapName in @(
        'DysonConfiguration.Common.ps1',
        'Install-DysonControlConfiguration.ps1',
        'New-DysonControlConfigurationSnapshot.ps1',
        'Restore-DysonControlConfiguration.ps1',
        'Test-DysonControlConfiguration.ps1',
        'dyson-control.environment-contract.json'
    )) {
        Assert-SelfTest -Condition (Test-Path -LiteralPath (Join-Path $installerRoot `
            "bootstrap\configuration\$configurationBootstrapName") -PathType Leaf) `
            -Message "the protected configuration bootstrap file was not installed: $configurationBootstrapName"
    }
    $installedBootstrapLayoutPath = Join-Path $installerRoot 'bootstrap\bootstrap-layout.json'
    foreach ($launcherDependency in @('Start-DysonControl.ps1', 'DysonDeployment.Configuration.ps1')) {
        Assert-SelfTest -Condition (
            (Get-DysonFileSha256 -Path (Join-Path $installerRoot ('bootstrap\' + $launcherDependency))) -ceq
            (Get-DysonFileSha256 -Path (Join-Path $PSScriptRoot $launcherDependency))
        ) -Message 'the launcher and configuration adapter did not retain the current source contract'
    }
    Assert-SelfTest -Condition (Test-Path -LiteralPath $installedBootstrapLayoutPath -PathType Leaf) `
        -Message 'the installer did not persist the stable bootstrap layout descriptor'
    $installedBootstrapLayout = [System.IO.File]::ReadAllText(
        $installedBootstrapLayoutPath,
        [System.Text.UTF8Encoding]::new($false, $true)
    ) | ConvertFrom-Json
    Assert-SelfTest -Condition (
        [string]$installedBootstrapLayout.protocol -ceq 'DYSON_CONTROL_GAME_BOOTSTRAP_LAYOUT_V1' -and
        [int]$installedBootstrapLayout.schemaVersion -eq 1 -and
        [string]::Equals(
            [System.IO.Path]::GetFullPath([string]$installedBootstrapLayout.dataRoot).TrimEnd('\', '/'),
            [System.IO.Path]::GetFullPath($installerData).TrimEnd('\', '/'),
            [System.StringComparison]::OrdinalIgnoreCase
        ) -and
        [string]$installedBootstrapLayout.dataRootIdentity -match '^[0-9a-f]{64}$'
    ) -Message 'the stable bootstrap layout did not bind the installer-selected custom data root'
    $status = ((& $statusScript -InstallRoot $installerRoot -DataRoot $installerData) | Out-String).Trim() | ConvertFrom-Json
    Assert-SelfTest -Condition ([bool]$status.ready) -Message 'the installed temporary layout failed read-only validation'
    & powershell.exe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass `
        -File (Join-Path $installerRoot 'bootstrap\Start-DysonControl.ps1') `
        -InstallRoot $installerRoot `
        -DataRoot $installerData `
        -RuntimeRoot $script:NodeRuntimeRoot `
        -NodeExecutable $nodeFixtures.actualNode `
        -ExpectedNodeSha256 $nodeFixtures.actualSha256 `
        -SelfTestConfigurationShadowRoot $script:ConfigurationShadowRoot | Out-Null
    Assert-SelfTest -Condition ($LASTEXITCODE -eq 0 -and (Test-Path -LiteralPath $launcherResultPath -PathType Leaf)) -Message 'the fixed launcher did not run the active Node entry point'
    $launcherResult = [System.IO.File]::ReadAllText($launcherResultPath) | ConvertFrom-Json
    Assert-SelfTest -Condition ($launcherResult.host -eq '127.0.0.1') -Message 'the fixed launcher did not override a non-loopback configured host'
    Assert-SelfTest -Condition ($launcherResult.nodeEnv -eq 'production') -Message 'the fixed launcher did not force production mode'
    Assert-SelfTest -Condition ($launcherResult.dataDir -eq (Join-Path $installerData 'data')) -Message 'the fixed launcher did not bind persistent data to ProgramData'
    Assert-SelfTest -Condition ($launcherResult.runtimeBootstrapRoot -eq (Join-Path $installerRoot 'bootstrap')) -Message 'the fixed launcher did not bind lifecycle tasks to the stable bootstrap root'
    Assert-SelfTest -Condition ($launcherResult.deploymentVersion -eq '2.0.0') -Message 'the fixed launcher did not export the manifest-bound deployment version'
    Assert-SelfTest -Condition (@($launcherResult.unexpectedNodeRuntimeEvidence).Count -eq 0) `
        -Message 'the fixed launcher injected private Node runtime evidence as unknown DYSON_* application configuration'
    Assert-SelfTest -Condition ($null -eq $launcherResult.nodeOptions) -Message 'the fixed launcher inherited NODE_OPTIONS'

    $launcherBeforeRejectedNode = [System.IO.File]::ReadAllText($launcherResultPath, [System.Text.Encoding]::UTF8)
    $rejectedLauncherOutput = Join-Path $testRoot 'rejected-launcher.stdout.txt'
    $rejectedLauncherError = Join-Path $testRoot 'rejected-launcher.stderr.txt'
    $rejectedLauncherArguments = '-NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "{0}" -InstallRoot "{1}" -DataRoot "{2}" -RuntimeRoot "{3}" -NodeExecutable "{4}" -ExpectedNodeSha256 "{5}" -SelfTestConfigurationShadowRoot "{6}"' -f `
        (Join-Path $installerRoot 'bootstrap\Start-DysonControl.ps1'), $installerRoot, $installerData, `
        $script:NodeRuntimeRoot, $nodeFixtures.node23, $script:NodeRuntimeHash,
        $script:ConfigurationShadowRoot
    $rejectedLauncher = Start-Process -FilePath 'powershell.exe' -ArgumentList $rejectedLauncherArguments `
        -WindowStyle Hidden -Wait -PassThru -RedirectStandardOutput $rejectedLauncherOutput `
        -RedirectStandardError $rejectedLauncherError
    Assert-SelfTest -Condition ($rejectedLauncher.ExitCode -ne 0) -Message 'the fixed launcher accepted Node 23'
    Assert-SelfTest -Condition ([System.IO.File]::ReadAllText($launcherResultPath, [System.Text.Encoding]::UTF8) -eq $launcherBeforeRejectedNode) `
        -Message 'the rejected Node 23 launcher changed application output'

    [System.Environment]::SetEnvironmentVariable('DYSON_NODE_PROBE_SENTINEL', $previewNodeSentinel, 'Process')
    try {
        $taskPreviewOutput = & $taskScript -InstallRoot $installerRoot -DataRoot $installerData `
            -NodeExecutable $nodeFixtures.previewtrap -WhatIf 6>$null
    }
    finally { Remove-Item Env:DYSON_NODE_PROBE_SENTINEL -ErrorAction SilentlyContinue }
    $taskPreview = ($taskPreviewOutput | Out-String).Trim() | ConvertFrom-Json
    Assert-SelfTest -Condition ($taskPreview.state -eq 'preview' -and -not $taskPreview.gameTasksChanged) -Message 'scheduled-task WhatIf validation failed'
    Assert-SelfTest -Condition (-not (Test-Path -LiteralPath $previewNodeSentinel)) `
        -Message 'startup-task WhatIf executed the supplied Node executable'

    $taskAuditPath = Join-Path $installerData 'audit\deployment.jsonl'
    $taskAuditLength = (Get-Item -LiteralPath $taskAuditPath -ErrorAction Stop).Length
    $lowNodeTaskRejected = $false
    try {
        & $taskScript -InstallRoot $installerRoot -DataRoot $installerData `
            -NodeExecutable $nodeFixtures.node23 -Confirm:$false | Out-Null
    }
    catch { $lowNodeTaskRejected = $_.Exception.Message -eq 'Node.js runtime verification failed.' }
    Assert-SelfTest -Condition $lowNodeTaskRejected -Message 'startup-task installation accepted Node 23'
    Assert-SelfTest -Condition ((Get-Item -LiteralPath $taskAuditPath -ErrorAction Stop).Length -eq $taskAuditLength) `
        -Message 'rejected Node 23 startup-task installation changed deployment audit state'

    $installSuccessText = ($installerOutput | Out-String)
    Assert-SelfTest -Condition (-not $installSuccessText.Contains($installerRoot) -and
        -not $installSuccessText.Contains($installerData) -and
        $installSuccessText -notmatch '(?i)NT AUTHORITY|<Task') `
        -Message 'the successful installer receipt disclosed a path, account, or task XML'

    $taskRollbackExistingRoot = Join-Path $testRoot 'task-rollback-existing-program-files\DysonControl'
    $taskRollbackExistingData = Join-Path $testRoot 'task-rollback-existing-program-data\DysonControl'
    $taskRollbackNewRoot = Join-Path $testRoot 'task-rollback-new-program-files\DysonControl'
    $taskRollbackNewData = Join-Path $testRoot 'task-rollback-new-program-data\DysonControl'
    $taskRemovalFailureRoot = Join-Path $testRoot 'task-removal-failure-program-files\DysonControl'
    $taskRemovalFailureData = Join-Path $testRoot 'task-removal-failure-program-data\DysonControl'
    $wrapperLockRoot = Join-Path $testRoot 'wrapper-lock-program-files\DysonControl'
    $wrapperLockData = Join-Path $testRoot 'wrapper-lock-program-data\DysonControl'
    foreach ($roots in @(
        @($taskRollbackExistingRoot, $taskRollbackExistingData),
        @($taskRollbackNewRoot, $taskRollbackNewData),
        @($taskRemovalFailureRoot, $taskRemovalFailureData),
        @($wrapperLockRoot, $wrapperLockData)
    )) {
        [void](Invoke-DeploymentJson -Arguments @{
            Operation = 'Upgrade'; SourcePath = $payloadA; Version = '1.0.0'
            InstallRoot = $roots[0]; DataRoot = $roots[1]
        })
    }

    $closedListener = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, 0)
    $closedListener.Start()
    $closedPort = ([System.Net.IPEndPoint]$closedListener.LocalEndpoint).Port
    $closedListener.Stop()
    $closedReadinessUri = [uri]("http://127.0.0.1:$closedPort/readyz")

    $missingLifecycleBrokerTasks = @(Get-DysonLifecycleBrokerStaticWorkerTasks)
    Assert-SelfTest -Condition ($missingLifecycleBrokerTasks.Count -eq 0) `
        -Message 'an absent fixed lifecycle broker task was not represented as an empty exact-name query result'

    $replacementConfigurationB = Join-Path $testRoot 'fictional-production-b.env'
    $replacementConfigurationC = Join-Path $testRoot 'fictional-production-c.env'
    $configurationAText = [System.IO.File]::ReadAllText(
        $installerConfig,
        [System.Text.Encoding]::UTF8
    )
    [System.IO.File]::WriteAllText(
        $replacementConfigurationB,
        $configurationAText.Replace(
            'fictional-session-secret-at-least-32-characters',
            'fictional-session-secret-b-at-least-32-characters'
        ),
        [System.Text.UTF8Encoding]::new($false)
    )
    [System.IO.File]::WriteAllText(
        $replacementConfigurationC,
        $configurationAText.Replace(
            'fictional-session-secret-at-least-32-characters',
            'fictional-session-secret-c-at-least-32-characters'
        ),
        [System.Text.UTF8Encoding]::new($false)
    )
    $replacementBOutput = & $installScript -SourcePath $payloadInstallerReplacement -Version '2.1.0' `
        -ExpectedArtifactPayloadSha256 (Get-FictionalPayloadSha256 -Root $payloadInstallerReplacement) `
        -NodeExecutable $nodeFixtures.node24 -InstallRoot $installerRoot -DataRoot $installerData `
        -ConfigurationSource $replacementConfigurationB -Confirm:$false
    $replacementBReceipt = ($replacementBOutput | Out-String).Trim() |
        ConvertFrom-Json -ErrorAction Stop
    $installedConfigurationPath = Join-Path $installerData 'config\dyson-control.env'
    $replacementBBytes = [System.IO.File]::ReadAllBytes($installedConfigurationPath)
    Assert-SelfTest -Condition (
        [string]$replacementBReceipt.state -ceq 'installed' -and
        [bool]$replacementBReceipt.configurationReplaced -and
        [bool]$replacementBReceipt.configurationReplacementSupported -and
        [Convert]::ToBase64String($replacementBBytes) -ceq
            [Convert]::ToBase64String(
                [System.IO.File]::ReadAllBytes($replacementConfigurationB)
            )
    ) -Message 'the A-to-B protected configuration replacement did not complete through the deployment orchestrator'

    $replacementRollbackTaskName = 'Dyson-Control-Plane-SelfTest-Configuration-Rollback'
    $replacementRollbackRejected = $false
    $replacementRollbackError = $null
    try {
        & $installScript -SourcePath $payloadInstallerRollback -Version '2.2.0' `
            -ExpectedArtifactPayloadSha256 (Get-FictionalPayloadSha256 -Root $payloadInstallerRollback) `
            -NodeExecutable $nodeFixtures.node24 -InstallRoot $installerRoot -DataRoot $installerData `
            -ConfigurationSource $replacementConfigurationC -RegisterStartupTask -StartAfterInstall `
            -TaskName $replacementRollbackTaskName -ReadinessUri $closedReadinessUri `
            -ReadinessTimeoutSeconds 1 -Confirm:$false | Out-Null
    }
    catch {
        $replacementRollbackRejected = $true
        $replacementRollbackError = $_.Exception.Message
    }
    $replacementSnapshots = @(Get-ChildItem -LiteralPath (
            Join-Path $installerData 'configuration-snapshots'
        ) -Directory -Force -ErrorAction Stop)
    $replacementRollbackState = [ordered]@{
        rejected = $replacementRollbackRejected
        rollbackComplete = $replacementRollbackError -notmatch 'automatic rollback was incomplete'
        replacementTaskAbsent = -not $global:DysonDeploymentTaskFixture.ContainsKey(
            $replacementRollbackTaskName
        )
        activeVersion = Get-ActiveVersionAt -DataRoot $installerData
        exactConfigurationB = [Convert]::ToBase64String(
            [System.IO.File]::ReadAllBytes($installedConfigurationPath)
        ) -ceq [Convert]::ToBase64String($replacementBBytes)
        snapshotCount = $replacementSnapshots.Count
        error = $replacementRollbackError
    }
    Assert-SelfTest -Condition (
        [bool]$replacementRollbackState.rejected -and
        [bool]$replacementRollbackState.rollbackComplete -and
        [bool]$replacementRollbackState.replacementTaskAbsent -and
        [string]$replacementRollbackState.activeVersion -ceq '2.1.0' -and
        [bool]$replacementRollbackState.exactConfigurationB -and
        [int]$replacementRollbackState.snapshotCount -ge 3
    ) -Message ('the B-to-C readiness failure did not snapshot C and restore exact B: ' +
        ($replacementRollbackState | ConvertTo-Json -Compress))

    # Broker helpers are invoked by Windows PowerShell 5.1 from the immutable
    # release. Keep this nested fixture compact while the authorized test root
    # itself remains deliberately long and fully representative.
    $brokerInstallerRoot = Join-Path $testRoot 'i'
    $brokerInstallerData = Join-Path $testRoot 'd'
    $brokerApplicationData = Join-Path $brokerInstallerData 'data'
    $brokerProjectRoot = Join-Path $testRoot 'broker-fictional-project'
    $brokerAuthorityRoot = Join-Path $brokerApplicationData 'authority-inventory'
    $brokerAuthorityFile = Join-Path $brokerAuthorityRoot 'authority-profile.json'
    $brokerTransactionRoot = Join-Path $brokerApplicationData 'runtime-task-transactions'
    $brokerBootstrapRoot = Join-Path $brokerInstallerRoot 'bootstrap'
    $brokerShadowRoot = Join-Path $testRoot 'broker-shadow'
    $lifecycleShadowRoot = Join-Path $testRoot 'lifecycle-shadow'
    $brokerServiceUser = 'FictionalDysonService'
    $brokerGamePort = 8469
    foreach ($directory in @(
        $brokerApplicationData,
        $brokerProjectRoot,
        (Join-Path $brokerProjectRoot 'server'),
        $brokerAuthorityRoot,
        $brokerTransactionRoot,
        $brokerShadowRoot,
        $lifecycleShadowRoot
    )) { [System.IO.Directory]::CreateDirectory($directory) | Out-Null }
    [System.IO.File]::WriteAllText(
        (Join-Path $brokerProjectRoot 'server\DSPGAME.exe'),
        'fictional executable fixture',
        [System.Text.UTF8Encoding]::new($false)
    )
    [System.IO.File]::WriteAllText(
        (Join-Path $brokerShadowRoot '.dyson-cutover-broker-selftest'),
        'isolated deployment self-test',
        [System.Text.UTF8Encoding]::new($false)
    )
    [System.IO.File]::WriteAllText(
        (Join-Path $lifecycleShadowRoot '.dyson-lifecycle-broker-selftest'),
        'isolated deployment self-test',
        [System.Text.UTF8Encoding]::new($false)
    )
    $powerShellFixture = (Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe').ToLowerInvariant()
    $fixtureUserLeaf = $brokerServiceUser.ToLowerInvariant()
    $lifecycleServerDescriptor = [ordered]@{
        name = 'Dyson-Nebula-Server'; path = '\'; execute = $powerShellFixture
        arguments = '-NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "' +
            (Join-Path $brokerBootstrapRoot 'Start-DysonServer.ps1') + '" -ProjectRoot "' +
            $brokerProjectRoot + '" -Ups 60'
        workingDirectory = ''; userId = $brokerServiceUser; logonType = 'Interactive'; runLevel = 'Limited'
        enabled = $true; multipleInstances = 'IgnoreNew'
        executionTimeLimit = 'PT0S'; restartCount = 3; restartInterval = 'PT1M'; startWhenAvailable = $true
        trigger = [ordered]@{ count = 1; userId = $fixtureUserLeaf; delay = 'PT20S' }
    }
    $lifecycleStopDescriptor = [ordered]@{
        name = 'Dyson-Nebula-Stop'; path = '\'; execute = $powerShellFixture
        arguments = '-NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "' +
            (Join-Path $brokerBootstrapRoot 'Stop-DysonServer.ps1') + '" -ProjectRoot "' +
            $brokerProjectRoot + '" -TimeoutSeconds 150'
        workingDirectory = ''; userId = $brokerServiceUser; logonType = 'Interactive'; runLevel = 'Limited'
        enabled = $true; multipleInstances = 'IgnoreNew'
        executionTimeLimit = 'PT5M'; restartCount = 0; restartInterval = $null; startWhenAvailable = $false
        trigger = [ordered]@{ count = 0; userId = $null; delay = $null }
    }
    [System.IO.File]::WriteAllText(
        (Join-Path $lifecycleShadowRoot 'server-task.json'),
        ([ordered]@{ descriptor = $lifecycleServerDescriptor; state = 'Ready' } |
            ConvertTo-Json -Depth 10 -Compress) + "`n",
        [System.Text.UTF8Encoding]::new($false)
    )
    [System.IO.File]::WriteAllText(
        (Join-Path $lifecycleShadowRoot 'stop-task.json'),
        ([ordered]@{ descriptor = $lifecycleStopDescriptor; state = 'Ready' } |
            ConvertTo-Json -Depth 10 -Compress) + "`n",
        [System.Text.UTF8Encoding]::new($false)
    )

    $brokerReadinessListener = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, 0)
    $brokerReadinessListener.Start()
    $brokerReadinessPort = ([Net.IPEndPoint]$brokerReadinessListener.LocalEndpoint).Port
    $brokerReadinessListener.Stop()
    $brokerPointerForJob = Join-Path $brokerInstallerData 'state\active-release.json'
    $brokerReadinessJob = Start-Job `
        -ArgumentList $brokerReadinessPort, $brokerPointerForJob, $brokerReadinessStopPath -ScriptBlock {
        param($Port, $PointerPath, $StopPath)
        $server = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, [int]$Port)
        $server.Start()
        try {
            while (-not (Test-Path -LiteralPath $StopPath)) {
                $client = $server.AcceptTcpClient()
                try {
                    $stream = $client.GetStream()
                    $reader = [IO.StreamReader]::new($stream, [Text.Encoding]::ASCII, $false, 1024, $true)
                    while (($line = $reader.ReadLine()) -ne $null -and $line.Length -gt 0) { }
                    $version = $null
                    try { $version = ([IO.File]::ReadAllText($PointerPath) | ConvertFrom-Json).version } catch { }
                    $status = if ($version) { '200 OK' } else { '503 Service Unavailable' }
                    $body = if ($version) {
                        [ordered]@{
                            status = 'ready'; deploymentVersion = [string]$version
                            checks = [ordered]@{
                                deploymentVersion = 'pass'; statusProvider = 'pass'; projectRoot = 'pass'
                                lifecycleBroker = 'pass'; cutoverRecovery = 'pass'
                            }
                        } | ConvertTo-Json -Depth 5 -Compress
                    }
                    else { '{"status":"not-ready","checks":{"lifecycleBroker":"fail","cutoverRecovery":"fail"}}' }
                    $bytes = [Text.Encoding]::UTF8.GetBytes($body)
                    $headers = "HTTP/1.1 $status`r`nContent-Type: application/json`r`nX-Dyson-Control-Release: $version`r`nContent-Length: $($bytes.Length)`r`nConnection: close`r`n`r`n"
                    $headerBytes = [Text.Encoding]::ASCII.GetBytes($headers)
                    $stream.Write($headerBytes, 0, $headerBytes.Length)
                    $stream.Write($bytes, 0, $bytes.Length)
                    $stream.Flush()
                }
                finally { $client.Dispose() }
            }
        }
        finally { $server.Stop() }
    }
    $brokerReadinessUri = [uri]("http://127.0.0.1:$brokerReadinessPort/readyz")
    $brokerReadyDeadline = (Get-Date).AddSeconds(10)
    do {
        try { [void](Invoke-WebRequest -Uri $brokerReadinessUri -UseBasicParsing -TimeoutSec 1); $brokerReady = $true }
        catch { $brokerReady = $null -ne $_.Exception.Response }
        if (-not $brokerReady) { Start-Sleep -Milliseconds 100 }
    } while (-not $brokerReady -and (Get-Date) -lt $brokerReadyDeadline)
    Assert-SelfTest -Condition $brokerReady -Message 'the lifecycle/cutover readiness fixture did not start'
    $brokerFixtureScriptRoot = Join-Path $payloadBrokerInstaller 'scripts\windows'
    . (Join-Path $brokerFixtureScriptRoot 'DysonHostMutationLease.Common.ps1')
    . (Join-Path $brokerFixtureScriptRoot 'cutover\DysonCutoverHost.Common.ps1')
    $brokerAuthorityProfile = New-DeploymentBrokerAuthorityProfile `
        -Project $brokerProjectRoot `
        -Data $brokerApplicationData `
        -AuthorityRoot $brokerAuthorityRoot `
        -BootstrapIdentityRoot $brokerBootstrapRoot `
        -BootstrapHashSourceRoot (Join-Path $PSScriptRoot '..\bootstrap') `
        -Transactions $brokerTransactionRoot `
        -ServiceUser $brokerServiceUser `
        -GamePort $brokerGamePort
    $brokerInventoryRevision = [string]$brokerAuthorityProfile.inventoryRevision
    [System.IO.File]::WriteAllText(
        $brokerAuthorityFile,
        (ConvertTo-CutoverHostJson $brokerAuthorityProfile) + "`n",
        [System.Text.UTF8Encoding]::new($false)
    )
    $brokerConfiguration = Join-Path $testRoot 'fictional-cutover-broker.env'
    $brokerConfigurationLines = @(
        'NODE_ENV=production',
        'DYSON_HOST=127.0.0.1',
        'DYSON_PROVIDER=windows',
        'DYSON_LIFECYCLE_ENABLED=true',
        'DYSON_CUTOVER_ENABLED=true',
        'DYSON_CUTOVER_RECOVERY_ENABLED=true',
        ('DYSON_PROJECT_ROOT=' + $brokerProjectRoot),
        ('DYSON_DATA_DIR=' + $brokerApplicationData),
        ('DYSON_LIFECYCLE_BROKER_PROFILE_FILE=' + (Join-Path $brokerApplicationData `
            'lifecycle-broker\broker-profile.json')),
        ('DYSON_RUNTIME_BOOTSTRAP_ROOT=' + $brokerBootstrapRoot),
        ('DYSON_RUNTIME_SERVICE_USER=' + $brokerServiceUser),
        'DYSON_SERVER_TASK=Dyson-Nebula-Server',
        'DYSON_STOP_TASK=Dyson-Nebula-Stop',
        ('DYSON_CUTOVER_PROFILE_FILE=' + $brokerAuthorityFile),
        ('DYSON_CUTOVER_TASK_TRANSACTION_ROOT=' + $brokerTransactionRoot),
        ('DYSON_CUTOVER_SERVICE_USER=' + $brokerServiceUser),
        ('DYSON_GAME_PORT=' + $brokerGamePort)
    )
    [System.IO.File]::WriteAllText(
        $brokerConfiguration,
        ($brokerConfigurationLines -join "`n") + "`n",
        [System.Text.UTF8Encoding]::new($false)
    )
    $brokerInstallArguments = @{
        SourcePath = $payloadBrokerInstaller
        Version = '4.0.0'
        ExpectedArtifactPayloadSha256 = Get-FictionalPayloadSha256 -Root $payloadBrokerInstaller
        NodeExecutable = $nodeFixtures.node24
        InstallRoot = $brokerInstallerRoot
        DataRoot = $brokerInstallerData
        ConfigurationSource = $brokerConfiguration
        RegisterStartupTask = $true
        StartAfterInstall = $true
        TaskName = 'Dyson-Control-Plane-SelfTest-Brokers'
        ReadinessUri = $brokerReadinessUri
        ReadinessTimeoutSeconds = 5
        InstallLifecycleBrokerTask = $true
        ProjectRoot = $brokerProjectRoot
        RuntimeBootstrapRoot = $brokerBootstrapRoot
        ServiceUser = $brokerServiceUser
        GamePort = $brokerGamePort
        DispatchReadyTimeout = 5
        SelfTestShadow = $lifecycleShadowRoot
        InstallCutoverBrokerTask = $true
        CutoverProjectRoot = $brokerProjectRoot
        CutoverAuthorityProfileFile = $brokerAuthorityFile
        CutoverAuthorityInventoryRevision = $brokerInventoryRevision
        CutoverRuntimeTaskTransactionRoot = $brokerTransactionRoot
        CutoverServiceUser = $brokerServiceUser
        CutoverGamePort = $brokerGamePort
        CutoverRuntimeBootstrapRoot = $brokerBootstrapRoot
        SelfTestSkipAdministratorCheck = $true
        SelfTestCutoverBrokerShadowRoot = $brokerShadowRoot
    }

    $brokerParameterWithoutSwitchRoot = Join-Path $testRoot 'broker-parameter-without-switch-program-files\DysonControl'
    $brokerParameterWithoutSwitchData = Join-Path $testRoot 'broker-parameter-without-switch-program-data\DysonControl'
    $brokerParameterWithoutSwitchRejected = $false
    try {
        & $installScript -SourcePath $payloadBrokerInstaller -Version '4.0.0' -NodeExecutable $nodeFixtures.node24 `
            -ExpectedArtifactPayloadSha256 (Get-FictionalPayloadSha256 -Root $payloadBrokerInstaller) `
            -InstallRoot $brokerParameterWithoutSwitchRoot -DataRoot $brokerParameterWithoutSwitchData `
            -ConfigurationSource $brokerConfiguration -CutoverServiceUser $brokerServiceUser -Confirm:$false | Out-Null
    }
    catch {
        $brokerParameterWithoutSwitchRejected = $_.Exception.Message -eq `
            'Cutover broker installation parameters require -InstallCutoverBrokerTask.'
    }
    Assert-SelfTest -Condition ($brokerParameterWithoutSwitchRejected -and
        -not (Test-Path -LiteralPath $brokerParameterWithoutSwitchRoot) -and
        -not (Test-Path -LiteralPath $brokerParameterWithoutSwitchData)) `
        -Message 'cutover broker parameters without the explicit install switch mutated deployment state'

    $lifecycleParameterWithoutSwitchRoot = Join-Path $testRoot `
        'lifecycle-parameter-without-switch-program-files\DysonControl'
    $lifecycleParameterWithoutSwitchData = Join-Path $testRoot `
        'lifecycle-parameter-without-switch-program-data\DysonControl'
    $lifecycleParameterWithoutSwitchRejected = $false
    try {
        & $installScript -SourcePath $payloadBrokerInstaller -Version '4.0.0' `
            -ExpectedArtifactPayloadSha256 (Get-FictionalPayloadSha256 -Root $payloadBrokerInstaller) `
            -NodeExecutable $nodeFixtures.node24 -InstallRoot $lifecycleParameterWithoutSwitchRoot `
            -DataRoot $lifecycleParameterWithoutSwitchData -ConfigurationSource $brokerConfiguration `
            -ServiceUser $brokerServiceUser -Confirm:$false | Out-Null
    }
    catch {
        $lifecycleParameterWithoutSwitchRejected = $_.Exception.Message -eq `
            'Lifecycle broker installation parameters require -InstallLifecycleBrokerTask.'
    }
    Assert-SelfTest -Condition ($lifecycleParameterWithoutSwitchRejected -and
        -not (Test-Path -LiteralPath $lifecycleParameterWithoutSwitchRoot) -and
        -not (Test-Path -LiteralPath $lifecycleParameterWithoutSwitchData)) `
        -Message 'lifecycle parameters without the explicit install switch mutated deployment state'

    $mismatchedLifecycleConfiguration = Join-Path $testRoot 'fictional-mismatched-lifecycle-broker.env'
    [IO.File]::WriteAllText(
        $mismatchedLifecycleConfiguration,
        (($brokerConfigurationLines | ForEach-Object {
            if ($_ -like 'DYSON_LIFECYCLE_BROKER_PROFILE_FILE=*') {
                'DYSON_LIFECYCLE_BROKER_PROFILE_FILE=' + (Join-Path $testRoot 'wrong-profile.json')
            }
            else { $_ }
        }) -join "`n") + "`n",
        [Text.UTF8Encoding]::new($false)
    )
    $mismatchedLifecycleArguments = @{}
    foreach ($key in $brokerInstallArguments.Keys) {
        $mismatchedLifecycleArguments[$key] = $brokerInstallArguments[$key]
    }
    $mismatchedLifecycleArguments['ConfigurationSource'] = $mismatchedLifecycleConfiguration
    $mismatchedLifecycleRejected = $false
    try { & $installScript @mismatchedLifecycleArguments -Confirm:$false | Out-Null }
    catch { $mismatchedLifecycleRejected = $true }
    Assert-SelfTest -Condition ($mismatchedLifecycleRejected -and
        -not (Test-Path -LiteralPath $brokerInstallerRoot) -and
        -not (Test-Path -LiteralPath (Join-Path $brokerApplicationData 'lifecycle-broker'))) `
        -Message 'mismatched lifecycle environment binding was not rejected before deployment mutation'

    $disabledBrokerConfiguration = Join-Path $testRoot 'fictional-disabled-cutover-broker.env'
    [System.IO.File]::WriteAllText(
        $disabledBrokerConfiguration,
        (($brokerConfigurationLines | ForEach-Object {
            if ($_ -ceq 'DYSON_CUTOVER_RECOVERY_ENABLED=true') { 'DYSON_CUTOVER_RECOVERY_ENABLED=false' } else { $_ }
        }) -join "`n") + "`n",
        [System.Text.UTF8Encoding]::new($false)
    )
    $disabledBrokerInstallArguments = @{}
    foreach ($key in $brokerInstallArguments.Keys) { $disabledBrokerInstallArguments[$key] = $brokerInstallArguments[$key] }
    $disabledBrokerInstallArguments['ConfigurationSource'] = $disabledBrokerConfiguration
    $disabledBrokerRejected = $false
    try { & $installScript @disabledBrokerInstallArguments -Confirm:$false | Out-Null }
    catch {
        $disabledBrokerRejected = $_.Exception.Message -eq `
            'Cutover broker installation requires the Windows lifecycle, CUTOVER, and CUTOVER_RECOVERY configuration gates.'
    }
    Assert-SelfTest -Condition ($disabledBrokerRejected -and
        -not (Test-Path -LiteralPath $brokerInstallerRoot) -and
        -not (Test-Path -LiteralPath (Join-Path $brokerApplicationData 'cutover-broker')) -and
        -not (Test-Path -LiteralPath (Join-Path $brokerInstallerData 'state'))) `
        -Message 'disabled cutover recovery was not rejected before deployment or broker mutation'

    $brokerPreviewArguments = @{}
    foreach ($key in $brokerInstallArguments.Keys) { $brokerPreviewArguments[$key] = $brokerInstallArguments[$key] }
    $brokerPreviewArguments['NodeExecutable'] = $nodeFixtures.previewtrap
    [System.Environment]::SetEnvironmentVariable('DYSON_NODE_PROBE_SENTINEL', $previewNodeSentinel, 'Process')
    try { $brokerPreviewOutput = & $installScript @brokerPreviewArguments -WhatIf 6>$null }
    finally { Remove-Item Env:DYSON_NODE_PROBE_SENTINEL -ErrorAction SilentlyContinue }
    $brokerPreviewResult = ($brokerPreviewOutput | Out-String).Trim() | ConvertFrom-Json
    Assert-SelfTest -Condition ($brokerPreviewResult.state -eq 'preview' -and
        [bool]$brokerPreviewResult.lifecycleBrokerTaskRequested -and
        [bool]$brokerPreviewResult.lifecycleBrokerConfigurationValidated -and
        [bool]$brokerPreviewResult.cutoverBrokerTaskRequested -and
        [bool]$brokerPreviewResult.cutoverBrokerConfigurationValidated -and
        -not (Test-Path -LiteralPath $brokerInstallerRoot) -and
        -not (Test-Path -LiteralPath (Join-Path $brokerApplicationData 'cutover-broker')) -and
        -not (Test-Path -LiteralPath $previewNodeSentinel)) `
        -Message 'the complete cutover broker WhatIf path executed Node, installed a task, or mutated deployment state'
    $installSourceText = [IO.File]::ReadAllText($installScript, [Text.Encoding]::UTF8)
    $forwardOrderMarkers = @(
        '$deploymentOutput = & (Join-Path $PSScriptRoot ''Invoke-DysonControlDeployment.ps1'')',
        '$activeDeploymentSourceRoot = Assert-DysonPlainDirectory',
        '$configurationInstallEvidence = Invoke-DysonDeploymentConfigurationInstall',
        '$configurationEvidence = Invoke-DysonDeploymentConfigurationTest',
        '$taskInstallOutput = & (Join-Path $PSScriptRoot ''Install-DysonControlTask.ps1'')',
        '$candidateLifecycleBrokerReceipt = Invoke-DysonLifecycleBrokerDeploymentInstaller',
        '$cutoverBrokerOutput = & $cutoverBrokerInstaller @cutoverBrokerInstallArguments',
        'Start-ScheduledTask -TaskName $TaskName -TaskPath $script:DysonControlTaskPath',
        '-RequiredChecks $requiredReadinessChecks'
    )
    $previousForwardIndex = -1
    $forwardOrderValid = $true
    foreach ($marker in $forwardOrderMarkers) {
        $forwardIndex = $installSourceText.IndexOf(
            $marker, $previousForwardIndex + 1, [StringComparison]::Ordinal
        )
        if ($forwardIndex -le $previousForwardIndex) { $forwardOrderValid = $false; break }
        $previousForwardIndex = $forwardIndex
    }
    Assert-SelfTest -Condition $forwardOrderValid `
        -Message 'the installer forward order is not release, bootstrap, config, control task, lifecycle, cutover, start, readiness'
    $installPreflightLifecycleIndex = $installSourceText.IndexOf(
        '$lifecycleBrokerPreflightState = Get-DysonLifecycleBrokerDeploymentPreimage',
        [StringComparison]::Ordinal
    )
    $installPreflightCutoverIndex = $installSourceText.IndexOf(
        '$cutoverBrokerPreflightState = Get-DysonCutoverBrokerDeploymentPreimage',
        [StringComparison]::Ordinal
    )
    $installDataCreationIndex = $installSourceText.IndexOf(
        '[System.IO.Directory]::CreateDirectory($dataFull) | Out-Null',
        [StringComparison]::Ordinal
    )
    Assert-SelfTest -Condition ($installPreflightLifecycleIndex -ge 0 -and
        $installPreflightCutoverIndex -gt $installPreflightLifecycleIndex -and
        $installDataCreationIndex -gt $installPreflightCutoverIndex -and
        $installSourceText.Contains(
            'foreach ($key in $cutoverBrokerPreviousState.installArguments.Keys)'
        )) -Message 'broker preflight/data-root ordering or old-argument cutover rollback wiring is incomplete'
    $uninstallSourceText = [IO.File]::ReadAllText($uninstallScript, [Text.Encoding]::UTF8)
    $uninstallPreflightLifecycleIndex = $uninstallSourceText.IndexOf(
        '$lifecycleBrokerPreflightState = Get-DysonUninstallLifecycleBrokerState',
        [StringComparison]::Ordinal
    )
    $uninstallPreflightCutoverIndex = $uninstallSourceText.IndexOf(
        '$cutoverBrokerPreflightState = Get-DysonUninstallCutoverBrokerState',
        [StringComparison]::Ordinal
    )
    $uninstallDataCreationIndex = $uninstallSourceText.IndexOf(
        'if (-not (Test-Path -LiteralPath $dataFull)) { [void](New-DysonDirectory -Path $dataFull) }',
        [StringComparison]::Ordinal
    )
    Assert-SelfTest -Condition ($uninstallPreflightLifecycleIndex -ge 0 -and
        $uninstallPreflightCutoverIndex -gt $uninstallPreflightLifecycleIndex -and
        $uninstallDataCreationIndex -gt $uninstallPreflightCutoverIndex) `
        -Message 'uninstall broker preflight does not precede DataRoot creation'

    $firstInstallUpgradeInstallParent = [IO.Path]::GetDirectoryName($brokerInstallerRoot)
    $firstInstallUpgradeDataParent = [IO.Path]::GetDirectoryName($brokerInstallerData)
    $firstInstallUpgradeInstallBefore = Get-SelfTestTreeFingerprint $firstInstallUpgradeInstallParent
    $firstInstallUpgradeDataBefore = Get-SelfTestTreeFingerprint $firstInstallUpgradeDataParent
    $firstInstallUpgradeLifecycleShadowBefore = Get-SelfTestTreeFingerprint $lifecycleShadowRoot
    $firstInstallUpgradeCutoverShadowBefore = Get-SelfTestTreeFingerprint $brokerShadowRoot
    $firstInstallUpgradeStopCount = $global:DysonDeploymentTaskFixtureStopCalls.Count
    $firstInstallUpgradeStartCount = $global:DysonDeploymentTaskFixtureStartCalls.Count
    $firstInstallUpgradeUnregisterCount = $global:DysonDeploymentTaskFixtureUnregisterCalls.Count
    $lifecycleFirstInstallUpgradeRejected = $false
    $lifecycleFirstInstallUpgradeArguments = @{}
    foreach ($key in $brokerInstallArguments.Keys) {
        $lifecycleFirstInstallUpgradeArguments[$key] = $brokerInstallArguments[$key]
    }
    $lifecycleFirstInstallUpgradeArguments['UpgradeLifecycleBrokerExisting'] = $true
    try { & $installScript @lifecycleFirstInstallUpgradeArguments -Confirm:$false | Out-Null }
    catch {
        $lifecycleFirstInstallUpgradeRejected = $_.Exception.Message -ceq `
            'The lifecycle broker upgrade switch is invalid for a first installation.'
    }
    $cutoverFirstInstallUpgradeRejected = $false
    $cutoverFirstInstallUpgradeArguments = @{}
    foreach ($key in $brokerInstallArguments.Keys) {
        $cutoverFirstInstallUpgradeArguments[$key] = $brokerInstallArguments[$key]
    }
    $cutoverFirstInstallUpgradeArguments['UpgradeCutoverBrokerExisting'] = $true
    try { & $installScript @cutoverFirstInstallUpgradeArguments -Confirm:$false | Out-Null }
    catch {
        $cutoverFirstInstallUpgradeRejected = $_.Exception.Message -ceq `
            'The cutover broker upgrade switch is invalid for a first installation.'
    }
    Assert-SelfTest -Condition ($lifecycleFirstInstallUpgradeRejected -and
        $cutoverFirstInstallUpgradeRejected -and
        (Get-SelfTestTreeFingerprint $firstInstallUpgradeInstallParent) -ceq $firstInstallUpgradeInstallBefore -and
        (Get-SelfTestTreeFingerprint $firstInstallUpgradeDataParent) -ceq $firstInstallUpgradeDataBefore -and
        (Get-SelfTestTreeFingerprint $lifecycleShadowRoot) -ceq $firstInstallUpgradeLifecycleShadowBefore -and
        (Get-SelfTestTreeFingerprint $brokerShadowRoot) -ceq $firstInstallUpgradeCutoverShadowBefore -and
        $global:DysonDeploymentTaskFixtureStopCalls.Count -eq $firstInstallUpgradeStopCount -and
        $global:DysonDeploymentTaskFixtureStartCalls.Count -eq $firstInstallUpgradeStartCount -and
        $global:DysonDeploymentTaskFixtureUnregisterCalls.Count -eq $firstInstallUpgradeUnregisterCount) `
        -Message 'a first-install broker upgrade switch was not rejected before every persistent mutation'

    # The real child completes its task/profile transaction, then a fictional
    # receipt defect is injected in the artifact. The parent must reject it
    # without leaving a first-install broker behind or trusting its wrong path.
    $receiptFixtureInstaller = Join-Path $payloadBrokerInstaller 'scripts\windows\lifecycle-broker\Install-DysonLifecycleBrokerTask.ps1'
    $receiptFixtureManifest = Join-Path $payloadBrokerInstaller 'artifact-manifest.json'
    $receiptFixtureInstallerBytes = [IO.File]::ReadAllBytes($receiptFixtureInstaller)
    $receiptFixtureManifestBytes = [IO.File]::ReadAllBytes($receiptFixtureManifest)
    $receiptFixtureOriginalDigest = $brokerInstallArguments.ExpectedArtifactPayloadSha256
    $receiptFixtureOriginalText = [Text.Encoding]::UTF8.GetString($receiptFixtureInstallerBytes)
    $receiptFixtureMarker = Join-Path $lifecycleShadowRoot 'completed-child-with-invalid-receipt'
    $receiptFixturePattern = '(?m)(New-InstallerReceipt -Operation installed[^\r\n]*\|)'
    Assert-SelfTest ([regex]::Matches($receiptFixtureOriginalText, $receiptFixturePattern).Count -eq 1) `
        'the lifecycle receipt fixture did not identify exactly one successful first-install receipt'
    $receiptFixtureRelease = Join-Path $brokerInstallerRoot 'releases\4.0.0'
    Assert-SelfTest (-not (Test-Path -LiteralPath $receiptFixtureRelease)) `
        'the invalid-receipt fixture must own its initially absent staged release'
    foreach ($receiptFault in @('acl-intent', 'broker-root')) {
        $receiptFaultCompensated = $false
        try {
            $faultExpression = if ($receiptFault -ceq 'acl-intent') {
                '$_.aclIntent.requests = @($_.aclIntent.requests | Where-Object { $_ -cne ''CREATOR OWNER:Read+Delete (files only)'' });'
            }
            else { '$_.brokerRoot = ''C:\Fictional-Unrelated-Broker'';' }
            $faultPipeline = ' ForEach-Object { ' + $faultExpression +
                ' [IO.File]::WriteAllText((Join-Path $ShadowRoot ''completed-child-with-invalid-receipt''), ''completed''); $_ } |'
            $faultSource = [regex]::Replace($receiptFixtureOriginalText, $receiptFixturePattern,
                [Text.RegularExpressions.MatchEvaluator]{ param($match) $match.Value + $faultPipeline })
            [IO.File]::WriteAllText($receiptFixtureInstaller, $faultSource, [Text.UTF8Encoding]::new($false))
            [void](Write-DysonArtifactManifest -ArtifactRoot $payloadBrokerInstaller -Version '4.0.0' -DevDependenciesExcluded @())
            $brokerInstallArguments.ExpectedArtifactPayloadSha256 = Get-FictionalPayloadSha256 $payloadBrokerInstaller
            $receiptFaultRejected = $false
            $receiptFaultError = $null
            try { & $installScript @brokerInstallArguments -Confirm:$false | Out-Null }
            catch { $receiptFaultRejected = $true; $receiptFaultError = $_.Exception.Message }
            Assert-SelfTest -Condition ($receiptFaultRejected -and
                $receiptFaultError -match 'unsupported receipt' -and
                $receiptFaultError -notmatch 'automatic rollback was incomplete' -and
                (Test-Path -LiteralPath $receiptFixtureMarker -PathType Leaf) -and
                -not (Test-Path -LiteralPath (Join-Path $brokerApplicationData 'lifecycle-broker\broker-profile.json')) -and
                -not (Test-Path -LiteralPath (Join-Path $lifecycleShadowRoot 'broker-task.json')) -and
                -not (Test-Path -LiteralPath (Join-Path $lifecycleShadowRoot 'broker-profile.sddl')) -and
                -not (Test-Path -LiteralPath (Join-Path $brokerInstallerData 'config\dyson-control.env')) -and
                -not (Test-Path -LiteralPath (Join-Path $brokerInstallerRoot 'bootstrap')) -and
                $null -eq (Get-ActiveVersionAt -DataRoot $brokerInstallerData)) `
                -Message ('a successful child with an invalid ' + $receiptFault + ' receipt was not fully compensated: ' + $receiptFaultError)
            $receiptFaultCompensated = $true
        }
        finally {
            [IO.File]::WriteAllBytes($receiptFixtureInstaller, $receiptFixtureInstallerBytes)
            [IO.File]::WriteAllBytes($receiptFixtureManifest, $receiptFixtureManifestBytes)
            $brokerInstallArguments.ExpectedArtifactPayloadSha256 = $receiptFixtureOriginalDigest
            if (Test-Path -LiteralPath $receiptFixtureMarker) { [IO.File]::Delete($receiptFixtureMarker) }
            # Rollback intentionally retains staged immutable releases. Remove
            # only this successfully compensated, disposable altered fixture so
            # the next fixture can stage the same fictional version's own bytes.
            if ($receiptFaultCompensated -and (Test-Path -LiteralPath $receiptFixtureRelease)) {
                Remove-DysonDeploymentPlainTree -Path $receiptFixtureRelease `
                    -ExpectedParent (Join-Path $brokerInstallerRoot 'releases') -ExpectedLeafPattern '^4\.0\.0$'
            }
        }
    }

    $lifecycleInstallerControl = Join-Path $lifecycleShadowRoot 'installer-control.json'
    [IO.File]::WriteAllText(
        $lifecycleInstallerControl, '{"failStage":"after-profile-published"}',
        [Text.UTF8Encoding]::new($false)
    )
    $lifecycleFirstInstallFailureRejected = $false
    $lifecycleFirstInstallFailureError = $null
    try { & $installScript @brokerInstallArguments -Confirm:$false | Out-Null }
    catch {
        $lifecycleFirstInstallFailureRejected = $true
        $lifecycleFirstInstallFailureError = $_.Exception.Message
    }
    finally {
        [IO.File]::WriteAllText(
            $lifecycleInstallerControl, '{"failStage":"none"}',
            [Text.UTF8Encoding]::new($false)
        )
    }
    Assert-SelfTest -Condition ($lifecycleFirstInstallFailureRejected -and
        $null -eq (Get-ActiveVersionAt -DataRoot $brokerInstallerData) -and
        $lifecycleFirstInstallFailureError -notmatch 'automatic rollback was incomplete' -and
        -not (Test-Path -LiteralPath (Join-Path $brokerInstallerData `
            'config\dyson-control.env')) -and
        -not (Test-Path -LiteralPath (Join-Path $brokerInstallerRoot 'bootstrap')) -and
        -not (Test-Path -LiteralPath (Join-Path $brokerApplicationData `
            'lifecycle-broker\broker-profile.json')) -and
        -not (Test-Path -LiteralPath (Join-Path $lifecycleShadowRoot 'broker-task.json')) -and
        -not (Test-Path -LiteralPath (Join-Path $brokerApplicationData `
            'cutover-broker\broker-profile.json')) -and
        -not (Test-Path -LiteralPath (Join-Path $brokerShadowRoot 'task-intent.json'))) `
        -Message ('lifecycle first-install failure did not restore the absent release/configuration preimage while compensating broker state: ' +
            $lifecycleFirstInstallFailureError)

    $cutoverFirstInstallFailureRejected = $false
    $cutoverFirstInstallFailureError = $null
    try {
        [Environment]::SetEnvironmentVariable(
            'DYSON_CUTOVER_BROKER_SELFTEST_FAIL_STAGE', 'after-profile', 'Process'
        )
        & $installScript @brokerInstallArguments -Confirm:$false | Out-Null
    }
    catch {
        $cutoverFirstInstallFailureRejected = $true
        $cutoverFirstInstallFailureError = $_.Exception.Message
    }
    finally {
        [Environment]::SetEnvironmentVariable(
            'DYSON_CUTOVER_BROKER_SELFTEST_FAIL_STAGE', $null, 'Process'
        )
    }
    Assert-SelfTest -Condition ($cutoverFirstInstallFailureRejected -and
        $null -eq (Get-ActiveVersionAt -DataRoot $brokerInstallerData) -and
        $cutoverFirstInstallFailureError -notmatch 'automatic rollback was incomplete' -and
        -not (Test-Path -LiteralPath (Join-Path $brokerInstallerData `
            'config\dyson-control.env')) -and
        -not (Test-Path -LiteralPath (Join-Path $brokerInstallerRoot 'bootstrap')) -and
        -not (Test-Path -LiteralPath (Join-Path $brokerApplicationData `
            'lifecycle-broker\broker-profile.json')) -and
        -not (Test-Path -LiteralPath (Join-Path $lifecycleShadowRoot 'broker-task.json')) -and
        -not (Test-Path -LiteralPath (Join-Path $brokerApplicationData `
            'cutover-broker\broker-profile.json')) -and
        -not (Test-Path -LiteralPath (Join-Path $brokerShadowRoot 'task-intent.json'))) `
        -Message ('cutover first-install failure did not compensate the lifecycle broker and deployment release: ' +
            $cutoverFirstInstallFailureError)

    $brokerFirstInstallReadinessArguments = @{}
    foreach ($key in $brokerInstallArguments.Keys) {
        $brokerFirstInstallReadinessArguments[$key] = $brokerInstallArguments[$key]
    }
    $brokerReadinessTaskName = 'Dyson-Control-Plane-SelfTest-Broker-Readiness'
    $brokerFirstInstallReadinessArguments['RegisterStartupTask'] = $true
    $brokerFirstInstallReadinessArguments['StartAfterInstall'] = $true
    $brokerFirstInstallReadinessArguments['TaskName'] = $brokerReadinessTaskName
    $brokerFirstInstallReadinessArguments['ReadinessUri'] = $closedReadinessUri
    $brokerFirstInstallReadinessArguments['ReadinessTimeoutSeconds'] = 1
    $brokerFirstInstallStartCount = $global:DysonDeploymentTaskFixtureStartCalls.Count
    $authorityBeforeFirstInstallReadiness = [System.IO.File]::ReadAllBytes($brokerAuthorityFile)
    $brokerFirstInstallReadinessRejected = $false
    $brokerFirstInstallReadinessError = $null
    try { & $installScript @brokerFirstInstallReadinessArguments -Confirm:$false | Out-Null }
    catch {
        $brokerFirstInstallReadinessRejected = $true
        $brokerFirstInstallReadinessError = $_.Exception.Message
    }
    $brokerProfileAfterFirstInstallReadiness = Join-Path $brokerApplicationData `
        'cutover-broker\broker-profile.json'
    $brokerBindingAfterFirstInstallReadiness = Join-Path $brokerApplicationData `
        'cutover-broker\broker-bundle.json'
    $lifecycleProfileAfterFirstInstallReadiness = Join-Path $brokerApplicationData `
        'lifecycle-broker\broker-profile.json'
    $brokerFirstInstallReadinessChecks = [ordered]@{
        rejected = $brokerFirstInstallReadinessRejected
        startAttempted = $global:DysonDeploymentTaskFixtureStartCalls.Count -eq ($brokerFirstInstallStartCount + 1)
        controlTaskRemoved = -not $global:DysonDeploymentTaskFixture.ContainsKey($brokerReadinessTaskName)
        absentActivePointerRestored = $null -eq (Get-ActiveVersionAt -DataRoot $brokerInstallerData)
        absentConfigurationRestored = -not (Test-Path -LiteralPath (
            Join-Path $brokerInstallerData 'config\dyson-control.env'
        ))
        rollbackComplete = $brokerFirstInstallReadinessError -notmatch `
            'automatic rollback was incomplete'
        cutoverProfileRemoved = -not (Test-Path -LiteralPath $brokerProfileAfterFirstInstallReadiness)
        cutoverBindingRemoved = -not (Test-Path -LiteralPath $brokerBindingAfterFirstInstallReadiness)
        lifecycleProfileRemoved = -not (Test-Path -LiteralPath $lifecycleProfileAfterFirstInstallReadiness)
        lifecycleTaskRemoved = -not (Test-Path -LiteralPath (Join-Path $lifecycleShadowRoot 'broker-task.json'))
        lifecycleAclRemoved = -not (Test-Path -LiteralPath (Join-Path $lifecycleShadowRoot 'broker-profile.sddl'))
        cutoverTaskRemoved = -not (Test-Path -LiteralPath (Join-Path $brokerShadowRoot 'task-intent.json'))
        cutoverDirectoryAclRetained = Test-Path -LiteralPath `
            (Join-Path $brokerShadowRoot 'directory-acl-intent.json') -PathType Leaf
        cutoverReceiptDirectoryRetained = Test-Path -LiteralPath `
            (Join-Path $brokerApplicationData 'cutover-broker\installation-receipts') -PathType Container
        authorityPreserved = [Convert]::ToBase64String([System.IO.File]::ReadAllBytes($brokerAuthorityFile)) -ceq
            [Convert]::ToBase64String($authorityBeforeFirstInstallReadiness)
    }
    $brokerFirstInstallReadinessFailures = @(
        $brokerFirstInstallReadinessChecks.GetEnumerator() |
            Where-Object { -not [bool]$_.Value } |
            ForEach-Object { [string]$_.Key }
    )
    Assert-SelfTest -Condition ($brokerFirstInstallReadinessFailures.Count -eq 0) `
        -Message ('readiness failure after first broker install left active release, task/profile state, or changed authority data: ' +
            [string]::Join(',', $brokerFirstInstallReadinessFailures) + '; error=' +
            $brokerFirstInstallReadinessError)

    # Add the brokers to an existing read-only installation. Its old configuration
    # deliberately has no broker profile bindings; the new source supplies them.
    $readOnlyBrokerConfiguration = Join-Path $testRoot 'fictional-before-brokers.env'
    $readOnlyLines = @($brokerConfigurationLines | Where-Object { $_ -notmatch '^DYSON_(?:LIFECYCLE|CUTOVER)_' }) +
        @('DYSON_LIFECYCLE_ENABLED=false', 'DYSON_CUTOVER_ENABLED=false', 'DYSON_CUTOVER_RECOVERY_ENABLED=false')
    [IO.File]::WriteAllText($readOnlyBrokerConfiguration, ($readOnlyLines -join "`n") + "`n", [Text.UTF8Encoding]::new($false))
    $readOnlyInstallArguments = @{}
    foreach ($key in $brokerInstallArguments.Keys) {
        if ($key -notin @('InstallLifecycleBrokerTask', 'ProjectRoot', 'RuntimeBootstrapRoot', 'ServiceUser',
            'GamePort', 'DispatchReadyTimeout', 'SelfTestShadow', 'InstallCutoverBrokerTask',
            'CutoverProjectRoot', 'CutoverAuthorityProfileFile', 'CutoverAuthorityInventoryRevision',
            'CutoverRuntimeTaskTransactionRoot', 'CutoverServiceUser', 'CutoverGamePort',
            'CutoverRuntimeBootstrapRoot', 'SelfTestCutoverBrokerShadowRoot')) {
            $readOnlyInstallArguments[$key] = $brokerInstallArguments[$key]
        }
    }
    $readOnlyInstallArguments.ConfigurationSource = $readOnlyBrokerConfiguration
    $readOnlyInstallOutput = & $installScript @readOnlyInstallArguments -Confirm:$false
    $readOnlyInstallResult = ($readOnlyInstallOutput | Out-String).Trim() | ConvertFrom-Json
    Assert-SelfTest -Condition ($readOnlyInstallResult.state -eq 'installed' -and
        -not (Test-Path (Join-Path $brokerApplicationData 'lifecycle-broker\broker-profile.json')) -and
        -not (Test-Path (Join-Path $brokerApplicationData 'cutover-broker\broker-profile.json'))) `
        -Message 'read-only baseline unexpectedly installed broker profiles'
    $brokerInstallerOutput = & $installScript @brokerInstallArguments -Confirm:$false
    $brokerInstallerResult = ($brokerInstallerOutput | Out-String).Trim() | ConvertFrom-Json
    Assert-SelfTest -Condition ($brokerInstallerResult.state -eq 'installed' -and
        [bool]$brokerInstallerResult.lifecycleBrokerTaskRequested -and
        [bool]$brokerInstallerResult.lifecycleBrokerTaskInstalled -and
        [string]$brokerInstallerResult.lifecycleBrokerTaskName -ceq 'Dyson-Control-Lifecycle-Broker' -and
        [string]$brokerInstallerResult.lifecycleBrokerProfileHash -match '^[0-9a-f]{64}$' -and
        [string]$brokerInstallerResult.lifecycleBrokerOperation -ceq 'installed' -and
        -not [bool]$brokerInstallerResult.lifecycleBrokerReused -and
        -not [bool]$brokerInstallerResult.lifecycleBrokerUpgraded -and
        [bool]$brokerInstallerResult.cutoverBrokerTaskRequested -and
        [bool]$brokerInstallerResult.cutoverBrokerTaskInstalled -and
        [bool]$brokerInstallerResult.cutoverBrokerDataReady -and
        [string]$brokerInstallerResult.cutoverBrokerTaskName -ceq 'Dyson-Control-Cutover-Broker' -and
        [string]$brokerInstallerResult.cutoverBrokerRequestId -match '^[0-9a-f-]{36}$' -and
        [string]$brokerInstallerResult.cutoverBrokerProfileFingerprint -match '^[0-9a-f]{64}$' -and
        [string]$brokerInstallerResult.cutoverBrokerBundleSha256 -match '^[0-9a-f]{64}$' -and
        [string]$brokerInstallerResult.cutoverBrokerTaskSddlSha256 -match '^[0-9a-f]{64}$' -and
        -not [bool]$brokerInstallerResult.cutoverBrokerUpgraded) `
        -Message 'the explicitly enabled cutover broker install did not return a complete redacted receipt'
    . (Join-Path (Split-Path $PSScriptRoot -Parent) 'DysonHostMutationLease.Common.ps1')
    $busyHostLease = Enter-DysonHostMutationLease -DataRoot $brokerApplicationData `
        -Owner 'deployment-fixture' -Operation 'active-game-mutation' `
        -RequestId ([guid]::NewGuid().ToString('D')) -OwnerPid $PID -TimeoutMilliseconds 0
    $busyLeaseRoot = (Get-DysonHostMutationLeasePathInfo -DataRoot $brokerApplicationData).LockRoot
    function Get-BusyFixtureDataFingerprint {
        # The fixture intentionally owns an exclusive lease. Hash every other
        # deployment entry, plus the root ACL and complete entry-name inventory,
        # without attempting to reopen that exclusively locked lease file.
        $entries = @(Get-ChildItem -LiteralPath $brokerInstallerData -Force | Sort-Object Name)
        $parts = @((Get-Acl -LiteralPath $brokerInstallerData).Sddl, ($entries.Name -join '|'))
        foreach ($entry in $entries) {
            if ([string]::Equals($entry.FullName, $busyLeaseRoot, [StringComparison]::OrdinalIgnoreCase)) { continue }
            $parts += $entry.Name + '|' + (Get-SelfTestTreeFingerprint $entry.FullName)
        }
        return Get-DysonTextSha256 ($parts -join "`n")
    }
    try {
        $busyStopCount = $global:DysonDeploymentTaskFixtureStopCalls.Count
        $busyStartCount = $global:DysonDeploymentTaskFixtureStartCalls.Count
        $busyInstallBefore = Get-SelfTestTreeFingerprint $brokerInstallerRoot
        $busyDataBefore = Get-BusyFixtureDataFingerprint
        $busyLeaseMessage = $null
        try { & $installScript @brokerInstallArguments -Confirm:$false | Out-Null }
        catch { $busyLeaseMessage = $_.Exception.Message }
        Assert-SelfTest -Condition ($busyLeaseMessage -ceq 'DYSON_HOST_MUTATION_LEASE_BUSY' -and
            $global:DysonDeploymentTaskFixtureStopCalls.Count -eq $busyStopCount -and
            $global:DysonDeploymentTaskFixtureStartCalls.Count -eq $busyStartCount -and
            (Get-SelfTestTreeFingerprint $brokerInstallerRoot) -ceq $busyInstallBefore -and
            (Get-BusyFixtureDataFingerprint) -ceq $busyDataBefore) `
            -Message 'broker quiescence interrupted a host mutation or changed deployment state while its lease was busy'
    }
    finally { Exit-DysonHostMutationLease -Lease $busyHostLease | Out-Null }
    $installedBrokerScriptRoot = Join-Path $brokerInstallerRoot 'releases\4.0.0\scripts\windows\cutover-broker'
    $installedBrokerScriptNames = @(
        Get-ChildItem -LiteralPath $installedBrokerScriptRoot -File -Force -ErrorAction Stop |
            ForEach-Object { $_.Name } |
            Sort-Object
    )
    $expectedBrokerScriptNames = @(
        $script:DysonArtifactRequiredCutoverBrokerScripts |
            ForEach-Object { Split-Path $_ -Leaf } |
            Sort-Object
    )
    Assert-SelfTest -Condition (($installedBrokerScriptNames -join '|') -ceq ($expectedBrokerScriptNames -join '|')) `
        -Message 'the immutable installed release did not retain the exact six-file cutover broker directory'
    $installedBrokerProfilePath = Join-Path $brokerApplicationData 'cutover-broker\broker-profile.json'
    $installedBrokerProfile = [System.IO.File]::ReadAllText(
        $installedBrokerProfilePath,
        [System.Text.UTF8Encoding]::new($false, $true)
    ) | ConvertFrom-Json
    Assert-SelfTest -Condition (
        [string]::Equals(
            [System.IO.Path]::GetFullPath([string]$installedBrokerProfile.cutoverScriptRoot).TrimEnd('\', '/'),
            [System.IO.Path]::GetFullPath((Join-Path $brokerInstallerRoot 'releases\4.0.0\scripts\windows')).TrimEnd('\', '/'),
            [System.StringComparison]::OrdinalIgnoreCase
        ) -and
        [string]::Equals(
            [System.IO.Path]::GetFullPath([string]$installedBrokerProfile.brokerScriptRoot).TrimEnd('\', '/'),
            [System.IO.Path]::GetFullPath($installedBrokerScriptRoot).TrimEnd('\', '/'),
            [System.StringComparison]::OrdinalIgnoreCase
        ) -and
        [string]::Equals(
            [System.IO.Path]::GetFullPath([string]$installedBrokerProfile.runtimeBootstrapRoot).TrimEnd('\', '/'),
            [System.IO.Path]::GetFullPath($brokerBootstrapRoot).TrimEnd('\', '/'),
            [System.StringComparison]::OrdinalIgnoreCase
        )
    ) -Message 'the cutover broker profile was not bound to the activated immutable release and stable bootstrap'
    $installedLifecycleProfilePath = Join-Path $brokerApplicationData `
        'lifecycle-broker\broker-profile.json'
    $installedLifecycleProfile = [IO.File]::ReadAllText(
        $installedLifecycleProfilePath, [Text.UTF8Encoding]::new($false, $true)
    ) | ConvertFrom-Json
    $installedLifecycleScriptRoot = Join-Path $brokerInstallerRoot `
        'releases\4.0.0\scripts\windows\lifecycle-broker'
    $lifecycleTaskRecordPath = Join-Path $lifecycleShadowRoot 'broker-task.json'
    $lifecycleTaskRecord = [IO.File]::ReadAllText(
        $lifecycleTaskRecordPath, [Text.UTF8Encoding]::new($false, $true)
    ) | ConvertFrom-Json
    Assert-SelfTest -Condition (
        [string]::Equals(
            [IO.Path]::GetFullPath([string]$installedLifecycleProfile.brokerScriptRoot).TrimEnd('\', '/'),
            [IO.Path]::GetFullPath($installedLifecycleScriptRoot).TrimEnd('\', '/'),
            [StringComparison]::OrdinalIgnoreCase
        ) -and
        [string]::Equals(
            [IO.Path]::GetFullPath([string]$installedLifecycleProfile.installedWindowsRoot).TrimEnd('\', '/'),
            [IO.Path]::GetFullPath((Join-Path $brokerInstallerRoot `
                'releases\4.0.0\scripts\windows')).TrimEnd('\', '/'),
            [StringComparison]::OrdinalIgnoreCase
        ) -and
        [string]::Equals(
            [IO.Path]::GetFullPath([string]$installedLifecycleProfile.runtimeBootstrapRoot).TrimEnd('\', '/'),
            [IO.Path]::GetFullPath($brokerBootstrapRoot).TrimEnd('\', '/'),
            [StringComparison]::OrdinalIgnoreCase
        ) -and
        [string]$installedLifecycleProfile.workerTaskName -ceq 'Dyson-Control-Lifecycle-Broker' -and
        [string]$installedLifecycleProfile.workerTaskPath -ceq '\DysonControl\' -and
        [bool]$lifecycleTaskRecord.enabled -and
        [string]$lifecycleTaskRecord.sddl -ceq 'D:P(A;;GA;;;SY)(A;;GA;;;BA)(A;;GRGX;;;LS)'
    ) -Message 'the lifecycle broker profile/task was not bound to the active release, stable bootstrap, and fixed task'
    $directBrokerDeploymentRejected = $false
    try {
        & $deploymentScript -Operation Stage -SourcePath $payloadBrokerUpgrade -Version '4.1.0' `
            -ExpectedArtifactPayloadSha256 (Get-FictionalPayloadSha256 -Root $payloadBrokerUpgrade) `
            -InstallRoot $brokerInstallerRoot -DataRoot $brokerInstallerData -Confirm:$false | Out-Null
    }
    catch {
        $directBrokerDeploymentRejected = $_.Exception.Message -like `
            'Direct deployment operations are forbidden while a fixed broker profile exists*'
    }
    Assert-SelfTest -Condition ($directBrokerDeploymentRejected -and
        (Get-ActiveVersionAt -DataRoot $brokerInstallerData) -ceq '4.0.0') `
        -Message 'a direct deployment operation bypassed fixed broker profile orchestration'
    $brokerInstallationReceiptPath = Join-Path $brokerApplicationData `
        ("cutover-broker\installation-receipts\{0}.json" -f [string]$brokerInstallerResult.cutoverBrokerRequestId)
    $brokerInstallationReceipt = [System.IO.File]::ReadAllText(
        $brokerInstallationReceiptPath,
        [System.Text.UTF8Encoding]::new($false, $true)
    ) | ConvertFrom-Json
    Assert-SelfTest -Condition ([string]$brokerInstallationReceipt.protocol -ceq 'DYSON_CONTROL_CUTOVER_BROKER_INSTALL_RECEIPT_V1' -and
        [string]$brokerInstallationReceipt.requestId -ceq [string]$brokerInstallerResult.cutoverBrokerRequestId -and
        [string]$brokerInstallationReceipt.profileFingerprint -ceq [string]$brokerInstallerResult.cutoverBrokerProfileFingerprint -and
        [string]$brokerInstallationReceipt.brokerBundleSha256 -ceq [string]$brokerInstallerResult.cutoverBrokerBundleSha256 -and
        -not [bool]$brokerInstallationReceipt.upgraded -and
        [string]$brokerInstallationReceipt.status -ceq 'succeeded') `
        -Message 'the durable cutover broker installation receipt did not close over the deployment receipt'
    $brokerBundleBindingPath = Join-Path $brokerApplicationData 'cutover-broker\broker-bundle.json'
    $brokerBundleBinding = [System.IO.File]::ReadAllText(
        $brokerBundleBindingPath,
        [System.Text.UTF8Encoding]::new($false, $true)
    ) | ConvertFrom-Json
    Assert-SelfTest -Condition ([string]$brokerBundleBinding.protocol -ceq `
            'DYSON_CONTROL_CUTOVER_BROKER_BUNDLE_BINDING_V1' -and
        [string]$brokerBundleBinding.profileFingerprint -ceq [string]$brokerInstallerResult.cutoverBrokerProfileFingerprint -and
        [string]$brokerBundleBinding.brokerBundleSha256 -ceq [string]$brokerInstallerResult.cutoverBrokerBundleSha256) `
        -Message 'the durable six-file broker bundle binding did not close over the installed profile and receipt'
    $brokerTaskIntentPath = Join-Path $brokerShadowRoot 'task-intent.json'
    $brokerDirectoryAclIntentPath = Join-Path $brokerShadowRoot 'directory-acl-intent.json'
    $brokerTaskIntent = [System.IO.File]::ReadAllText($brokerTaskIntentPath, [System.Text.Encoding]::UTF8) | ConvertFrom-Json
    $brokerDirectoryAclIntentRaw = [System.IO.File]::ReadAllText(
        $brokerDirectoryAclIntentPath,
        [System.Text.Encoding]::UTF8
    ) | ConvertFrom-Json
    $brokerDirectoryAclIntent = @(foreach ($aclIntent in $brokerDirectoryAclIntentRaw) { $aclIntent })
    Assert-SelfTest -Condition ([string]$brokerTaskIntent.taskName -ceq 'Dyson-Control-Cutover-Broker' -and
        [string]$brokerTaskIntent.taskPath -ceq '\' -and
        [string]$brokerTaskIntent.principal -ceq 'S-1-5-18' -and
        [string]$brokerTaskIntent.runLevel -ceq 'Highest') `
        -Message 'the cutover broker shadow task identity was incomplete'
    Assert-SelfTest -Condition (([string]$brokerTaskIntent.arguments).IndexOf(
            (Join-Path $installedBrokerScriptRoot 'Invoke-DysonCutoverBrokerWorker.ps1'),
            [System.StringComparison]::OrdinalIgnoreCase
        ) -ge 0 -and ([string]$brokerTaskIntent.arguments).IndexOf(
            (Join-Path $brokerApplicationData 'cutover-broker\broker-profile.json'),
            [System.StringComparison]::OrdinalIgnoreCase
        ) -ge 0) -Message 'the cutover broker shadow task action was not fixed to the installed release and broker profile'
    $brokerRequestAclIntentCount = @($brokerDirectoryAclIntent | Where-Object {
        $_.kind -ceq 'requests' -and $_.localService -ceq 'modify'
    }).Count
    $brokerPrivateAclIntentCount = @($brokerDirectoryAclIntent | Where-Object {
        $_.kind -ceq 'private' -and $_.localService -ceq 'none'
    }).Count
    Assert-SelfTest -Condition ($brokerDirectoryAclIntent.Count -eq 4 -and
        $brokerRequestAclIntentCount -eq 1 -and $brokerPrivateAclIntentCount -eq 1) `
        -Message ("the cutover broker protected request/private channel ACL intent was incomplete (count={0}, requests={1}, private={2})" -f `
            $brokerDirectoryAclIntent.Count, $brokerRequestAclIntentCount, $brokerPrivateAclIntentCount)
    $brokerInstallReceiptText = ($brokerInstallerOutput | Out-String)
    Assert-SelfTest -Condition (-not $brokerInstallReceiptText.Contains($brokerInstallerRoot) -and
        -not $brokerInstallReceiptText.Contains($brokerInstallerData) -and
        -not $brokerInstallReceiptText.Contains($brokerServiceUser)) `
        -Message 'the cutover broker deployment receipt disclosed a path or service identity'

    # Initial installation above exercises the active pair. Qualify upgrades,
    # rollback, and uninstall while the candidate pair is prepared but disabled,
    # as it remains while the previous manager owns the running game.
    $preparedRuntimeTaskBytes = @{}
    foreach ($kind in @('server', 'stop')) {
        $runtimeTaskPath = Join-Path $lifecycleShadowRoot ($kind + '-task.json')
        $runtimeTaskRecord = [IO.File]::ReadAllText($runtimeTaskPath) | ConvertFrom-Json
        $runtimeTaskRecord.descriptor.enabled = $false
        $runtimeTaskRecord.state = 'Disabled'
        [IO.File]::WriteAllText($runtimeTaskPath,
            ($runtimeTaskRecord | ConvertTo-Json -Depth 10 -Compress) + "`n",
            [Text.UTF8Encoding]::new($false))
        $preparedRuntimeTaskBytes[$runtimeTaskPath] = [IO.File]::ReadAllBytes($runtimeTaskPath)
    }
    foreach ($invalidPair in @('mixed-enabled', 'descriptor-drift')) {
        $invalidTaskPath = Join-Path $lifecycleShadowRoot 'stop-task.json'
        $invalidTask = [IO.File]::ReadAllText($invalidTaskPath) | ConvertFrom-Json
        if ($invalidPair -ceq 'mixed-enabled') {
            $invalidTask.descriptor.enabled = $true
            $invalidTask.state = 'Ready'
        }
        else { $invalidTask.descriptor.arguments += ' -TimeoutSeconds 151' }
        [IO.File]::WriteAllText($invalidTaskPath,
            ($invalidTask | ConvertTo-Json -Depth 10 -Compress) + "`n",
            [Text.UTF8Encoding]::new($false))
        try {
            $invalidPairBefore = Get-SelfTestTreeFingerprint $testRoot
            foreach ($operation in @('install', 'uninstall')) {
                $invalidPairError = $null
                try {
                    if ($operation -ceq 'install') {
                        & $installScript @brokerInstallArguments -WhatIf 6>$null | Out-Null
                    }
                    else {
                        & $uninstallScript -InstallRoot $brokerInstallerRoot -DataRoot $brokerInstallerData `
                            -TaskName 'Dyson-Control-Plane-SelfTest-Brokers' -SelfTestSkipAdministratorCheck `
                            -SelfTestShadow $lifecycleShadowRoot `
                            -SelfTestCutoverBrokerShadowRoot $brokerShadowRoot -WhatIf 6>$null | Out-Null
                    }
                }
                catch { $invalidPairError = $_.Exception.Message }
                Assert-SelfTest -Condition ($invalidPairError -ceq 'DYSON_CONTROL_LIFECYCLE_BROKER_TASK_INVALID' -and
                    (Get-SelfTestTreeFingerprint $testRoot) -ceq $invalidPairBefore) `
                    -Message ("the {0} preimage accepted or mutated the {1} runtime task pair: {2}" -f `
                        $operation, $invalidPair, $invalidPairError)
            }
        }
        finally { [IO.File]::WriteAllBytes($invalidTaskPath, $preparedRuntimeTaskBytes[$invalidTaskPath]) }
    }

    $brokerProfileBeforeUpgrade = [System.IO.File]::ReadAllBytes($installedBrokerProfilePath)
    $brokerProfileAclBeforeUpgrade = (Get-Acl -LiteralPath $installedBrokerProfilePath).Sddl
    $brokerBundleBindingBeforeUpgrade = [System.IO.File]::ReadAllBytes($brokerBundleBindingPath)
    $brokerBundleBindingAclBeforeUpgrade = (Get-Acl -LiteralPath $brokerBundleBindingPath).Sddl
    $brokerBundleBindingBeforeUpgradeJson = [System.Text.UTF8Encoding]::new($false, $true).GetString(
        $brokerBundleBindingBeforeUpgrade
    ) | ConvertFrom-Json
    $brokerTaskIntentBeforeUpgrade = [System.IO.File]::ReadAllBytes($brokerTaskIntentPath)
    $brokerTaskIntentAclBeforeUpgrade = (Get-Acl -LiteralPath $brokerTaskIntentPath).Sddl
    $brokerDirectoryAclIntentBeforeUpgrade = [System.IO.File]::ReadAllBytes($brokerDirectoryAclIntentPath)
    $brokerDirectoryAclIntentFileAclBeforeUpgrade = (Get-Acl -LiteralPath $brokerDirectoryAclIntentPath).Sddl
    $brokerStorageAclsBeforeUpgrade = @{}
    foreach ($brokerStoragePath in @(
        (Join-Path $brokerApplicationData 'cutover-broker'),
        (Join-Path $brokerApplicationData 'cutover-broker\requests'),
        (Join-Path $brokerApplicationData 'cutover-broker\receipts'),
        (Join-Path $brokerApplicationData 'cutover-broker\intents'),
        (Join-Path $brokerApplicationData 'cutover-broker\work'),
        (Join-Path $brokerApplicationData 'cutover-broker\installation-receipts'),
        (Join-Path $brokerApplicationData 'cutover-broker\installation-transactions')
    )) {
        $brokerStorageAclsBeforeUpgrade[$brokerStoragePath] = (Get-Acl -LiteralPath $brokerStoragePath).Sddl
    }
    $lifecycleProfileBeforeUpgrade = [IO.File]::ReadAllBytes($installedLifecycleProfilePath)
    $lifecycleProfileFileAclBeforeUpgrade = (Get-Acl -LiteralPath $installedLifecycleProfilePath).Sddl
    $lifecycleProfileAclPath = Join-Path $lifecycleShadowRoot 'broker-profile.sddl'
    $lifecycleProfileAclBeforeUpgrade = [IO.File]::ReadAllBytes($lifecycleProfileAclPath)
    $lifecycleTaskBeforeUpgrade = [IO.File]::ReadAllBytes($lifecycleTaskRecordPath)
    $lifecycleStorageAclsBeforeUpgrade = @{}
    foreach ($lifecycleStoragePath in @(
        (Join-Path $brokerApplicationData 'lifecycle-broker'),
        (Join-Path $brokerApplicationData 'lifecycle-broker\requests'),
        (Join-Path $brokerApplicationData 'lifecycle-broker\intents'),
        (Join-Path $brokerApplicationData 'lifecycle-broker\receipts')
    )) {
        $lifecycleStorageAclsBeforeUpgrade[$lifecycleStoragePath] = `
            (Get-Acl -LiteralPath $lifecycleStoragePath).Sddl
    }
    $brokerControlTaskXmlBeforeUpgrade = [string]$global:DysonDeploymentTaskFixture[
        'Dyson-Control-Plane-SelfTest-Brokers'
    ].Xml
    $brokerInstallationReceiptRoot = Join-Path $brokerApplicationData 'cutover-broker\installation-receipts'
    $brokerInstallationTransactionRoot = Join-Path $brokerApplicationData 'cutover-broker\installation-transactions'
    $brokerReceiptNamesBeforeUpgrade = @(
        Get-ChildItem -LiteralPath $brokerInstallationReceiptRoot -File |
            ForEach-Object { $_.Name } |
            Sort-Object -CaseSensitive
    )
    $brokerUpgradeArguments = @{}
    foreach ($key in $brokerInstallArguments.Keys) { $brokerUpgradeArguments[$key] = $brokerInstallArguments[$key] }
    $brokerUpgradeArguments['SourcePath'] = $payloadBrokerUpgrade
    $brokerUpgradeArguments['Version'] = '4.1.0'
    $brokerUpgradeArguments['ExpectedArtifactPayloadSha256'] = Get-FictionalPayloadSha256 `
        -Root $payloadBrokerUpgrade

    $brokerUpgradePreflightInstallBefore = Get-SelfTestTreeFingerprint `
        ([IO.Path]::GetDirectoryName($brokerInstallerRoot))
    $brokerUpgradePreflightDataBefore = Get-SelfTestTreeFingerprint `
        ([IO.Path]::GetDirectoryName($brokerInstallerData))
    $brokerUpgradePreflightLifecycleShadowBefore = Get-SelfTestTreeFingerprint $lifecycleShadowRoot
    $brokerUpgradePreflightCutoverShadowBefore = Get-SelfTestTreeFingerprint $brokerShadowRoot
    $brokerUpgradePreflightStopCount = $global:DysonDeploymentTaskFixtureStopCalls.Count
    $brokerUpgradePreflightStartCount = $global:DysonDeploymentTaskFixtureStartCalls.Count
    $brokerUpgradePreflightUnregisterCount = $global:DysonDeploymentTaskFixtureUnregisterCalls.Count
    $brokerUnauthorizedUpgradeRejected = $false
    $brokerUnauthorizedUpgradeError = $null
    try { & $installScript @brokerUpgradeArguments -Confirm:$false | Out-Null }
    catch {
        $brokerUnauthorizedUpgradeRejected = $true
        $brokerUnauthorizedUpgradeError = $_.Exception.Message
    }
    $brokerUnauthorizedUpgradeActiveVersion = Get-ActiveVersionAt -DataRoot $brokerInstallerData
    $brokerUnauthorizedUpgradeState = [ordered]@{
        rejected = $brokerUnauthorizedUpgradeRejected
        error = $brokerUnauthorizedUpgradeError
        activeVersion = $brokerUnauthorizedUpgradeActiveVersion
        activeRestored = $brokerUnauthorizedUpgradeActiveVersion -ceq '4.0.0'
        profileRestored = [Convert]::ToBase64String(
            [System.IO.File]::ReadAllBytes($installedBrokerProfilePath)
        ) -ceq [Convert]::ToBase64String($brokerProfileBeforeUpgrade)
        bindingRestored = [Convert]::ToBase64String(
            [System.IO.File]::ReadAllBytes($brokerBundleBindingPath)
        ) -ceq [Convert]::ToBase64String($brokerBundleBindingBeforeUpgrade)
        taskRestored = [Convert]::ToBase64String(
            [System.IO.File]::ReadAllBytes($brokerTaskIntentPath)
        ) -ceq [Convert]::ToBase64String($brokerTaskIntentBeforeUpgrade)
        installTreeUnchanged = (Get-SelfTestTreeFingerprint `
            ([IO.Path]::GetDirectoryName($brokerInstallerRoot))) -ceq $brokerUpgradePreflightInstallBefore
        dataTreeUnchanged = (Get-SelfTestTreeFingerprint `
            ([IO.Path]::GetDirectoryName($brokerInstallerData))) -ceq $brokerUpgradePreflightDataBefore
        lifecycleShadowUnchanged = (Get-SelfTestTreeFingerprint $lifecycleShadowRoot) -ceq `
            $brokerUpgradePreflightLifecycleShadowBefore
        cutoverShadowUnchanged = (Get-SelfTestTreeFingerprint $brokerShadowRoot) -ceq `
            $brokerUpgradePreflightCutoverShadowBefore
        taskCallsUnchanged = $global:DysonDeploymentTaskFixtureStopCalls.Count -eq $brokerUpgradePreflightStopCount -and
            $global:DysonDeploymentTaskFixtureStartCalls.Count -eq $brokerUpgradePreflightStartCount -and
            $global:DysonDeploymentTaskFixtureUnregisterCalls.Count -eq $brokerUpgradePreflightUnregisterCount
        receiptsRestored = ($brokerReceiptNamesBeforeUpgrade -join '|') -ceq (@(
            Get-ChildItem -LiteralPath $brokerInstallationReceiptRoot -File |
                ForEach-Object { $_.Name } | Sort-Object -CaseSensitive
        ) -join '|')
    }
    Assert-SelfTest -Condition ($brokerUnauthorizedUpgradeRejected -and
        $brokerUnauthorizedUpgradeError -ceq `
            'A cross-release lifecycle broker deployment requires its explicit upgrade switch.' -and
        -not ($brokerUnauthorizedUpgradeState.Values -contains $false)) `
        -Message ('a cross-release broker upgrade without explicit upgrade authority changed state: ' +
            ($brokerUnauthorizedUpgradeState | ConvertTo-Json -Compress))

    $cutoverUnauthorizedUpgradeArguments = @{}
    foreach ($key in $brokerUpgradeArguments.Keys) {
        $cutoverUnauthorizedUpgradeArguments[$key] = $brokerUpgradeArguments[$key]
    }
    $cutoverUnauthorizedUpgradeArguments['UpgradeLifecycleBrokerExisting'] = $true
    $cutoverUnauthorizedUpgradeRejected = $false
    try { & $installScript @cutoverUnauthorizedUpgradeArguments -Confirm:$false | Out-Null }
    catch {
        $cutoverUnauthorizedUpgradeRejected = $_.Exception.Message -ceq `
            'A cross-release cutover broker deployment requires its explicit upgrade switch.'
    }
    Assert-SelfTest -Condition ($cutoverUnauthorizedUpgradeRejected -and
        (Get-SelfTestTreeFingerprint ([IO.Path]::GetDirectoryName($brokerInstallerRoot))) -ceq `
            $brokerUpgradePreflightInstallBefore -and
        (Get-SelfTestTreeFingerprint ([IO.Path]::GetDirectoryName($brokerInstallerData))) -ceq `
            $brokerUpgradePreflightDataBefore -and
        (Get-SelfTestTreeFingerprint $lifecycleShadowRoot) -ceq $brokerUpgradePreflightLifecycleShadowBefore -and
        (Get-SelfTestTreeFingerprint $brokerShadowRoot) -ceq $brokerUpgradePreflightCutoverShadowBefore -and
        $global:DysonDeploymentTaskFixtureStopCalls.Count -eq $brokerUpgradePreflightStopCount -and
        $global:DysonDeploymentTaskFixtureStartCalls.Count -eq $brokerUpgradePreflightStartCount -and
        $global:DysonDeploymentTaskFixtureUnregisterCalls.Count -eq $brokerUpgradePreflightUnregisterCount) `
        -Message 'a cross-release cutover upgrade without its explicit switch mutated deployment state'
    $brokerUpgradeArguments['UpgradeCutoverBrokerExisting'] = $true
    $brokerUpgradeArguments['UpgradeLifecycleBrokerExisting'] = $true
    $brokerInstallPendingPath = Join-Path $brokerApplicationData `
        'cutover-broker\requests\install-preflight-pending.json'
    [IO.File]::WriteAllText(
        $brokerInstallPendingPath, '{"fictionalPendingRequest":true}', [Text.UTF8Encoding]::new($false)
    )
    $brokerInstallPendingRejected = $false
    try { & $installScript @brokerUpgradeArguments -Confirm:$false | Out-Null }
    catch {
        $brokerInstallPendingRejected = $_.Exception.Message -ceq `
            'The cutover broker has pending request, intent, or work state.'
    }
    finally { Remove-Item -LiteralPath $brokerInstallPendingPath -Force -ErrorAction SilentlyContinue }
    Assert-SelfTest -Condition ($brokerInstallPendingRejected -and
        (Get-SelfTestTreeFingerprint ([IO.Path]::GetDirectoryName($brokerInstallerRoot))) -ceq `
            $brokerUpgradePreflightInstallBefore -and
        (Get-SelfTestTreeFingerprint ([IO.Path]::GetDirectoryName($brokerInstallerData))) -ceq `
            $brokerUpgradePreflightDataBefore -and
        $global:DysonDeploymentTaskFixtureStopCalls.Count -eq $brokerUpgradePreflightStopCount -and
        $global:DysonDeploymentTaskFixtureStartCalls.Count -eq $brokerUpgradePreflightStartCount -and
        $global:DysonDeploymentTaskFixtureUnregisterCalls.Count -eq $brokerUpgradePreflightUnregisterCount) `
        -Message 'pending cutover broker work was not rejected before release/config/control-task mutation'

    $brokerTaskIntentTamper = [Text.UTF8Encoding]::new($false, $true).GetString(
        $brokerTaskIntentBeforeUpgrade
    ) | ConvertFrom-Json
    $brokerTaskIntentTamper.enabled = $false
    [IO.File]::WriteAllText(
        $brokerTaskIntentPath,
        ($brokerTaskIntentTamper | ConvertTo-Json -Depth 12 -Compress) + "`n",
        [Text.UTF8Encoding]::new($false)
    )
    $brokerInstallTaskDriftRejected = $false
    try { & $installScript @brokerUpgradeArguments -Confirm:$false | Out-Null }
    catch {
        $brokerInstallTaskDriftRejected = $_.Exception.Message -ceq `
            'The cutover broker shadow task is inconsistent with its active profile.'
    }
    finally { [IO.File]::WriteAllBytes($brokerTaskIntentPath, $brokerTaskIntentBeforeUpgrade) }
    Assert-SelfTest -Condition ($brokerInstallTaskDriftRejected -and
        (Get-SelfTestTreeFingerprint ([IO.Path]::GetDirectoryName($brokerInstallerRoot))) -ceq `
            $brokerUpgradePreflightInstallBefore -and
        (Get-SelfTestTreeFingerprint ([IO.Path]::GetDirectoryName($brokerInstallerData))) -ceq `
            $brokerUpgradePreflightDataBefore -and
        $global:DysonDeploymentTaskFixtureStopCalls.Count -eq $brokerUpgradePreflightStopCount -and
        $global:DysonDeploymentTaskFixtureStartCalls.Count -eq $brokerUpgradePreflightStartCount -and
        $global:DysonDeploymentTaskFixtureUnregisterCalls.Count -eq $brokerUpgradePreflightUnregisterCount) `
        -Message 'cutover broker task/DACL drift was not rejected before deployment mutation'
    foreach ($brokerFailureStage in @(
        'after-snapshot', 'after-old-task-disabled', 'after-profile',
        'after-task', 'after-task-acl', 'before-receipt'
    )) {
        $brokerFailureArguments = @{}
        foreach ($key in $brokerUpgradeArguments.Keys) { $brokerFailureArguments[$key] = $brokerUpgradeArguments[$key] }
        $controlPlaneStartCountBeforeFailure = $global:DysonDeploymentTaskFixtureStartCalls.Count
        if ($brokerFailureStage -ceq 'after-snapshot') {
            $brokerFailureArguments['RegisterStartupTask'] = $true
            $brokerFailureArguments['StartAfterInstall'] = $true
            $brokerFailureArguments['ReadinessUri'] = $closedReadinessUri
            $brokerFailureArguments['ReadinessTimeoutSeconds'] = 1
        }
        $transactionsBeforeFailure = @(Get-ChildItem -LiteralPath $brokerInstallationTransactionRoot -Directory |
            ForEach-Object { $_.Name } | Sort-Object -CaseSensitive)
        $brokerUpgradeRejected = $false
        $brokerUpgradeFailureMessage = $null
        try {
            [System.Environment]::SetEnvironmentVariable(
                'DYSON_CUTOVER_BROKER_SELFTEST_FAIL_STAGE', $brokerFailureStage, 'Process'
            )
            & $installScript @brokerFailureArguments -Confirm:$false | Out-Null
        }
        catch {
            $brokerUpgradeRejected = $true
            $brokerUpgradeFailureMessage = $_.Exception.Message
        }
        finally {
            [System.Environment]::SetEnvironmentVariable(
                'DYSON_CUTOVER_BROKER_SELFTEST_FAIL_STAGE', $null, 'Process'
            )
        }
        $transactionsAfterFailure = @(Get-ChildItem -LiteralPath $brokerInstallationTransactionRoot -Directory |
            ForEach-Object { $_.Name } | Sort-Object -CaseSensitive)
        $newFailureTransactions = @($transactionsAfterFailure | Where-Object {
            $transactionsBeforeFailure -cnotcontains $_
        })
        $failedBrokerTransaction = if ($newFailureTransactions.Count -eq 1) {
            [System.IO.File]::ReadAllText(
                (Join-Path $brokerInstallationTransactionRoot `
                    ($newFailureTransactions[0] + '\transaction.json')),
                [System.Text.UTF8Encoding]::new($false, $true)
            ) | ConvertFrom-Json
        }
        else { $null }
        $brokerReceiptNamesAfterFailure = @(Get-ChildItem -LiteralPath $brokerInstallationReceiptRoot -File |
            ForEach-Object { $_.Name } | Sort-Object -CaseSensitive)
        $brokerRollbackChecks = [ordered]@{
            rejected = { $brokerUpgradeRejected }
            expectedFailureStage = { $brokerUpgradeFailureMessage -like "*at isolated self-test stage $brokerFailureStage*" }
            activeVersion = { (Get-ActiveVersionAt -DataRoot $brokerInstallerData) -ceq '4.0.0' }
            controlTaskPresent = { $global:DysonDeploymentTaskFixture.ContainsKey('Dyson-Control-Plane-SelfTest-Brokers') }
            controlTaskXml = { [string]$global:DysonDeploymentTaskFixture['Dyson-Control-Plane-SelfTest-Brokers'].Xml -ceq
                $brokerControlTaskXmlBeforeUpgrade }
            controlTaskRunning = { [string]$global:DysonDeploymentTaskFixture['Dyson-Control-Plane-SelfTest-Brokers'].State -ceq 'Running' }
            oneFailureTransaction = { $newFailureTransactions.Count -eq 1 }
            transactionRolledBack = { [string]$failedBrokerTransaction.state -ceq 'rolled-back' }
            cutoverProfileBytes = { [Convert]::ToBase64String([System.IO.File]::ReadAllBytes($installedBrokerProfilePath)) -ceq
                [Convert]::ToBase64String($brokerProfileBeforeUpgrade) }
            cutoverProfileAcl = { (Get-Acl -LiteralPath $installedBrokerProfilePath).Sddl -ceq $brokerProfileAclBeforeUpgrade }
            cutoverBindingBytes = { [Convert]::ToBase64String([System.IO.File]::ReadAllBytes($brokerBundleBindingPath)) -ceq
                [Convert]::ToBase64String($brokerBundleBindingBeforeUpgrade) }
            cutoverBindingAcl = { (Get-Acl -LiteralPath $brokerBundleBindingPath).Sddl -ceq $brokerBundleBindingAclBeforeUpgrade }
            cutoverTaskBytes = { [Convert]::ToBase64String([System.IO.File]::ReadAllBytes($brokerTaskIntentPath)) -ceq
                [Convert]::ToBase64String($brokerTaskIntentBeforeUpgrade) }
            cutoverTaskAcl = { (Get-Acl -LiteralPath $brokerTaskIntentPath).Sddl -ceq $brokerTaskIntentAclBeforeUpgrade }
            cutoverDirectoryIntentBytes = { [Convert]::ToBase64String([System.IO.File]::ReadAllBytes($brokerDirectoryAclIntentPath)) -ceq
                [Convert]::ToBase64String($brokerDirectoryAclIntentBeforeUpgrade) }
            cutoverDirectoryIntentAcl = { (Get-Acl -LiteralPath $brokerDirectoryAclIntentPath).Sddl -ceq `
                $brokerDirectoryAclIntentFileAclBeforeUpgrade }
            cutoverStorageAcls = { @($brokerStorageAclsBeforeUpgrade.Keys | Where-Object {
                (Get-Acl -LiteralPath $_).Sddl -cne $brokerStorageAclsBeforeUpgrade[$_]
            }).Count -eq 0 }
            lifecycleProfileBytes = { [Convert]::ToBase64String([IO.File]::ReadAllBytes($installedLifecycleProfilePath)) -ceq
                [Convert]::ToBase64String($lifecycleProfileBeforeUpgrade) }
            lifecycleProfileAcl = { (Get-Acl -LiteralPath $installedLifecycleProfilePath).Sddl -ceq `
                $lifecycleProfileFileAclBeforeUpgrade }
            lifecycleAclIntentBytes = { [Convert]::ToBase64String([IO.File]::ReadAllBytes($lifecycleProfileAclPath)) -ceq
                [Convert]::ToBase64String($lifecycleProfileAclBeforeUpgrade) }
            lifecycleTaskBytes = { [Convert]::ToBase64String([IO.File]::ReadAllBytes($lifecycleTaskRecordPath)) -ceq
                [Convert]::ToBase64String($lifecycleTaskBeforeUpgrade) }
            lifecycleStorageAcls = { @($lifecycleStorageAclsBeforeUpgrade.Keys | Where-Object {
                (Get-Acl -LiteralPath $_).Sddl -cne $lifecycleStorageAclsBeforeUpgrade[$_]
            }).Count -eq 0 }
            closedReceiptInventory = { ($brokerReceiptNamesAfterFailure -join '|') -ceq ($brokerReceiptNamesBeforeUpgrade -join '|') }
        }
        $brokerRollbackFailures = @(foreach ($check in $brokerRollbackChecks.GetEnumerator()) {
            try { if (-not (& $check.Value)) { $check.Key } }
            catch { $check.Key + '-check-error' }
        })
        Assert-SelfTest -Condition ($brokerRollbackFailures.Count -eq 0) `
            -Message ("cross-release broker rollback failed at {0} [{1}]: {2}" -f `
                $brokerFailureStage, ($brokerRollbackFailures -join ','), $brokerUpgradeFailureMessage)
        Assert-NoInstallPartials -InstallRoot $brokerInstallerRoot -DataRoot $brokerInstallerData `
            -Message "the broker rollback at $brokerFailureStage left installer partial directories"
        Assert-SelfTest -Condition (@($preparedRuntimeTaskBytes.Keys | Where-Object {
            [Convert]::ToBase64String([IO.File]::ReadAllBytes($_)) -cne
                [Convert]::ToBase64String($preparedRuntimeTaskBytes[$_])
        }).Count -eq 0) -Message 'broker upgrade rollback changed the prepared disabled runtime pair'
        if ($brokerFailureStage -ceq 'after-snapshot') {
            Assert-SelfTest -Condition ($global:DysonDeploymentTaskFixtureStartCalls.Count -eq
                ($controlPlaneStartCountBeforeFailure + 1) -and
                [string]$global:DysonDeploymentTaskFixtureStartCalls[
                    $global:DysonDeploymentTaskFixtureStartCalls.Count - 1
                ] -ceq 'Dyson-Control-Plane-SelfTest-Brokers') `
                -Message ('the failed broker upgrade did not perform exactly one rollback restart of the previous control task ' +
                    "(before=$controlPlaneStartCountBeforeFailure, after=$($global:DysonDeploymentTaskFixtureStartCalls.Count), " +
                    "calls=$([string]::Join('|', @($global:DysonDeploymentTaskFixtureStartCalls))))")
        }
    }

    $brokerUpgradeReadinessArguments = @{}
    foreach ($key in $brokerUpgradeArguments.Keys) {
        $brokerUpgradeReadinessArguments[$key] = $brokerUpgradeArguments[$key]
    }
    $brokerUpgradeReadinessTaskName = 'Dyson-Control-Plane-SelfTest-Broker-Upgrade-Readiness'
    $brokerUpgradeReadinessArguments['RegisterStartupTask'] = $true
    $brokerUpgradeReadinessArguments['StartAfterInstall'] = $true
    $brokerUpgradeReadinessArguments['TaskName'] = $brokerUpgradeReadinessTaskName
    $brokerUpgradeReadinessArguments['ReadinessUri'] = $closedReadinessUri
    $brokerUpgradeReadinessArguments['ReadinessTimeoutSeconds'] = 1
    $brokerUpgradeReadinessStartCount = $global:DysonDeploymentTaskFixtureStartCalls.Count
    $brokerUpgradeReadinessRejected = $false
    $brokerUpgradeReadinessError = $null
    try { & $installScript @brokerUpgradeReadinessArguments -Confirm:$false | Out-Null }
    catch {
        $brokerUpgradeReadinessRejected = $true
        $brokerUpgradeReadinessError = $_.Exception.Message
    }
    $bindingAfterUpgradeReadiness = [System.IO.File]::ReadAllText(
        $brokerBundleBindingPath, [System.Text.UTF8Encoding]::new($false, $true)
    ) | ConvertFrom-Json
    $brokerUpgradeReadinessState = [ordered]@{
        rejected = $brokerUpgradeReadinessRejected
        error = $brokerUpgradeReadinessError
        startCount = $global:DysonDeploymentTaskFixtureStartCalls.Count -eq ($brokerUpgradeReadinessStartCount + 1)
        controlTaskRemoved = -not $global:DysonDeploymentTaskFixture.ContainsKey($brokerUpgradeReadinessTaskName)
        activeRestored = (Get-ActiveVersionAt -DataRoot $brokerInstallerData) -ceq '4.0.0'
        profileRestored = [Convert]::ToBase64String(
            [System.IO.File]::ReadAllBytes($installedBrokerProfilePath)
        ) -ceq [Convert]::ToBase64String($brokerProfileBeforeUpgrade)
        profileAclRestored = (Get-Acl -LiteralPath $installedBrokerProfilePath).Sddl -ceq `
            $brokerProfileAclBeforeUpgrade
        bindingProfileRestored = [string]$bindingAfterUpgradeReadiness.profileFingerprint -ceq `
            [string]$brokerBundleBindingBeforeUpgradeJson.profileFingerprint
        bindingBundleRestored = [string]$bindingAfterUpgradeReadiness.brokerBundleSha256 -ceq `
            [string]$brokerBundleBindingBeforeUpgradeJson.brokerBundleSha256
        bindingBytesRestored = [Convert]::ToBase64String(
            [IO.File]::ReadAllBytes($brokerBundleBindingPath)
        ) -ceq [Convert]::ToBase64String($brokerBundleBindingBeforeUpgrade)
        bindingAclRestored = (Get-Acl -LiteralPath $brokerBundleBindingPath).Sddl -ceq `
            $brokerBundleBindingAclBeforeUpgrade
        taskRestored = [Convert]::ToBase64String(
            [System.IO.File]::ReadAllBytes($brokerTaskIntentPath)
        ) -ceq [Convert]::ToBase64String($brokerTaskIntentBeforeUpgrade)
        taskAclRestored = (Get-Acl -LiteralPath $brokerTaskIntentPath).Sddl -ceq `
            $brokerTaskIntentAclBeforeUpgrade
        directoryAclRestored = [Convert]::ToBase64String(
            [System.IO.File]::ReadAllBytes($brokerDirectoryAclIntentPath)
        ) -ceq [Convert]::ToBase64String($brokerDirectoryAclIntentBeforeUpgrade)
        directoryAclFileAclRestored = (Get-Acl -LiteralPath $brokerDirectoryAclIntentPath).Sddl -ceq `
            $brokerDirectoryAclIntentFileAclBeforeUpgrade
        storageAclsRestored = @($brokerStorageAclsBeforeUpgrade.Keys | Where-Object {
            (Get-Acl -LiteralPath $_).Sddl -cne $brokerStorageAclsBeforeUpgrade[$_]
        }).Count -eq 0
        lifecycleProfileRestored = [Convert]::ToBase64String(
            [IO.File]::ReadAllBytes($installedLifecycleProfilePath)
        ) -ceq [Convert]::ToBase64String($lifecycleProfileBeforeUpgrade)
        lifecycleProfileFileAclRestored = (Get-Acl -LiteralPath $installedLifecycleProfilePath).Sddl -ceq `
            $lifecycleProfileFileAclBeforeUpgrade
        lifecycleProfileAclRestored = [Convert]::ToBase64String(
            [IO.File]::ReadAllBytes($lifecycleProfileAclPath)
        ) -ceq [Convert]::ToBase64String($lifecycleProfileAclBeforeUpgrade)
        lifecycleTaskRestored = [Convert]::ToBase64String(
            [IO.File]::ReadAllBytes($lifecycleTaskRecordPath)
        ) -ceq [Convert]::ToBase64String($lifecycleTaskBeforeUpgrade)
        lifecycleStorageAclsRestored = @($lifecycleStorageAclsBeforeUpgrade.Keys | Where-Object {
            (Get-Acl -LiteralPath $_).Sddl -cne $lifecycleStorageAclsBeforeUpgrade[$_]
        }).Count -eq 0
    }
    Assert-SelfTest -Condition ($brokerUpgradeReadinessRejected -and
        -not ($brokerUpgradeReadinessState.Values -contains $false)) `
        -Message ('readiness failure after a committed broker upgrade did not restore preimage: ' +
            ($brokerUpgradeReadinessState | ConvertTo-Json -Compress))

    $brokerUpgradeOutput = & $installScript @brokerUpgradeArguments -Confirm:$false
    $brokerUpgradeResult = ($brokerUpgradeOutput | Out-String).Trim() | ConvertFrom-Json
    $upgradedBrokerScriptRoot = Join-Path $brokerInstallerRoot 'releases\4.1.0\scripts\windows\cutover-broker'
    $upgradedLifecycleScriptRoot = Join-Path $brokerInstallerRoot `
        'releases\4.1.0\scripts\windows\lifecycle-broker'
    $upgradedBrokerProfile = [System.IO.File]::ReadAllText(
        $installedBrokerProfilePath, [System.Text.UTF8Encoding]::new($false, $true)
    ) | ConvertFrom-Json
    $upgradedBrokerBinding = [System.IO.File]::ReadAllText(
        $brokerBundleBindingPath, [System.Text.UTF8Encoding]::new($false, $true)
    ) | ConvertFrom-Json
    $upgradedBrokerTaskIntent = [System.IO.File]::ReadAllText(
        $brokerTaskIntentPath, [System.Text.UTF8Encoding]::new($false, $true)
    ) | ConvertFrom-Json
    $committedBrokerTransactionPath = Join-Path $brokerInstallationTransactionRoot `
        ([string]$brokerUpgradeResult.cutoverBrokerRequestId + '\transaction.json')
    $committedBrokerTransaction = [System.IO.File]::ReadAllText(
        $committedBrokerTransactionPath, [System.Text.UTF8Encoding]::new($false, $true)
    ) | ConvertFrom-Json
    Assert-SelfTest -Condition ($brokerUpgradeResult.state -eq 'installed' -and
        (Get-ActiveVersionAt -DataRoot $brokerInstallerData) -ceq '4.1.0' -and
        [bool]$brokerUpgradeResult.lifecycleBrokerTaskInstalled -and
        [bool]$brokerUpgradeResult.lifecycleBrokerUpgraded -and
        -not [bool]$brokerUpgradeResult.lifecycleBrokerReused -and
        [string]::Equals(
            [IO.Path]::GetFullPath(
                [string](([IO.File]::ReadAllText($installedLifecycleProfilePath, `
                    [Text.UTF8Encoding]::new($false, $true)) | ConvertFrom-Json).brokerScriptRoot)
            ).TrimEnd('\', '/'),
            [IO.Path]::GetFullPath($upgradedLifecycleScriptRoot).TrimEnd('\', '/'),
            [StringComparison]::OrdinalIgnoreCase
        ) -and
        [bool]$brokerUpgradeResult.cutoverBrokerTaskInstalled -and
        [bool]$brokerUpgradeResult.cutoverBrokerUpgraded -and
        -not [bool]$brokerUpgradeResult.cutoverBrokerReused -and
        [string]$brokerUpgradeResult.cutoverBrokerBundleSha256 -match '^[0-9a-f]{64}$' -and
        [string]$upgradedBrokerProfile.profileFingerprint -ceq `
            [string]$brokerUpgradeResult.cutoverBrokerProfileFingerprint -and
        [string]$upgradedBrokerBinding.profileFingerprint -ceq `
            [string]$brokerUpgradeResult.cutoverBrokerProfileFingerprint -and
        [string]$upgradedBrokerBinding.brokerBundleSha256 -ceq `
            [string]$brokerUpgradeResult.cutoverBrokerBundleSha256 -and
        [string]$committedBrokerTransaction.state -ceq 'committed' -and
        [string]::Equals(
            [System.IO.Path]::GetFullPath([string]$upgradedBrokerProfile.brokerScriptRoot).TrimEnd('\', '/'),
            [System.IO.Path]::GetFullPath($upgradedBrokerScriptRoot).TrimEnd('\', '/'),
            [System.StringComparison]::OrdinalIgnoreCase
        ) -and
        ([string]$upgradedBrokerTaskIntent.arguments).IndexOf(
            (Join-Path $upgradedBrokerScriptRoot 'Invoke-DysonCutoverBrokerWorker.ps1'),
            [System.StringComparison]::OrdinalIgnoreCase
        ) -ge 0) `
        -Message 'the cross-release broker transaction did not commit the new active release/profile/bundle/task atomically'

    Assert-SelfTest -Condition (@($preparedRuntimeTaskBytes.Keys | Where-Object {
        [Convert]::ToBase64String([IO.File]::ReadAllBytes($_)) -cne
            [Convert]::ToBase64String($preparedRuntimeTaskBytes[$_])
    }).Count -eq 0) -Message 'broker upgrade activated or changed the prepared disabled runtime pair'
    $brokerProfileBeforeRepeat = [System.IO.File]::ReadAllBytes($installedBrokerProfilePath)
    $brokerProfileAclBeforeRepeat = (Get-Acl -LiteralPath $installedBrokerProfilePath).Sddl
    $brokerBindingBeforeRepeat = [System.IO.File]::ReadAllBytes($brokerBundleBindingPath)
    $brokerBindingAclBeforeRepeat = (Get-Acl -LiteralPath $brokerBundleBindingPath).Sddl
    $brokerTaskBeforeRepeat = [System.IO.File]::ReadAllBytes($brokerTaskIntentPath)
    $brokerTaskAclBeforeRepeat = (Get-Acl -LiteralPath $brokerTaskIntentPath).Sddl
    $brokerDirectoryAclBeforeRepeat = [IO.File]::ReadAllBytes($brokerDirectoryAclIntentPath)
    $brokerDirectoryAclFileAclBeforeRepeat = (Get-Acl -LiteralPath $brokerDirectoryAclIntentPath).Sddl
    $brokerStorageAclsBeforeRepeat = @{}
    foreach ($brokerStoragePath in $brokerStorageAclsBeforeUpgrade.Keys) {
        $brokerStorageAclsBeforeRepeat[$brokerStoragePath] = (Get-Acl -LiteralPath $brokerStoragePath).Sddl
    }
    $lifecycleProfileBeforeRepeat = [IO.File]::ReadAllBytes($installedLifecycleProfilePath)
    $lifecycleProfileFileAclBeforeRepeat = (Get-Acl -LiteralPath $installedLifecycleProfilePath).Sddl
    $lifecycleProfileAclBeforeRepeat = [IO.File]::ReadAllBytes($lifecycleProfileAclPath)
    $lifecycleTaskBeforeRepeat = [IO.File]::ReadAllBytes($lifecycleTaskRecordPath)
    $lifecycleStorageAclsBeforeRepeat = @{}
    foreach ($lifecycleStoragePath in $lifecycleStorageAclsBeforeUpgrade.Keys) {
        $lifecycleStorageAclsBeforeRepeat[$lifecycleStoragePath] = `
            (Get-Acl -LiteralPath $lifecycleStoragePath).Sddl
    }
    $brokerRepeatArguments = @{}
    foreach ($key in $brokerUpgradeArguments.Keys) { $brokerRepeatArguments[$key] = $brokerUpgradeArguments[$key] }
    [void]$brokerRepeatArguments.Remove('UpgradeCutoverBrokerExisting')
    [void]$brokerRepeatArguments.Remove('UpgradeLifecycleBrokerExisting')

    $sameReleaseUpgradeInstallBefore = Get-SelfTestTreeFingerprint `
        ([IO.Path]::GetDirectoryName($brokerInstallerRoot))
    $sameReleaseUpgradeDataBefore = Get-SelfTestTreeFingerprint `
        ([IO.Path]::GetDirectoryName($brokerInstallerData))
    $sameReleaseUpgradeLifecycleShadowBefore = Get-SelfTestTreeFingerprint $lifecycleShadowRoot
    $sameReleaseUpgradeCutoverShadowBefore = Get-SelfTestTreeFingerprint $brokerShadowRoot
    $sameReleaseUpgradeStopCount = $global:DysonDeploymentTaskFixtureStopCalls.Count
    $sameReleaseUpgradeStartCount = $global:DysonDeploymentTaskFixtureStartCalls.Count
    $sameReleaseUpgradeUnregisterCount = $global:DysonDeploymentTaskFixtureUnregisterCalls.Count
    $sameReleaseLifecycleUpgradeArguments = @{}
    foreach ($key in $brokerRepeatArguments.Keys) {
        $sameReleaseLifecycleUpgradeArguments[$key] = $brokerRepeatArguments[$key]
    }
    $sameReleaseLifecycleUpgradeArguments['UpgradeLifecycleBrokerExisting'] = $true
    $sameReleaseLifecycleUpgradeRejected = $false
    try { & $installScript @sameReleaseLifecycleUpgradeArguments -Confirm:$false | Out-Null }
    catch {
        $sameReleaseLifecycleUpgradeRejected = $_.Exception.Message -ceq `
            'The lifecycle broker upgrade switch is invalid for a same-release reuse.'
    }
    $sameReleaseCutoverUpgradeArguments = @{}
    foreach ($key in $brokerRepeatArguments.Keys) {
        $sameReleaseCutoverUpgradeArguments[$key] = $brokerRepeatArguments[$key]
    }
    $sameReleaseCutoverUpgradeArguments['UpgradeCutoverBrokerExisting'] = $true
    $sameReleaseCutoverUpgradeRejected = $false
    try { & $installScript @sameReleaseCutoverUpgradeArguments -Confirm:$false | Out-Null }
    catch {
        $sameReleaseCutoverUpgradeRejected = $_.Exception.Message -ceq `
            'The cutover broker upgrade switch is invalid for a same-release reuse.'
    }
    Assert-SelfTest -Condition ($sameReleaseLifecycleUpgradeRejected -and
        $sameReleaseCutoverUpgradeRejected -and
        (Get-SelfTestTreeFingerprint ([IO.Path]::GetDirectoryName($brokerInstallerRoot))) -ceq `
            $sameReleaseUpgradeInstallBefore -and
        (Get-SelfTestTreeFingerprint ([IO.Path]::GetDirectoryName($brokerInstallerData))) -ceq `
            $sameReleaseUpgradeDataBefore -and
        (Get-SelfTestTreeFingerprint $lifecycleShadowRoot) -ceq $sameReleaseUpgradeLifecycleShadowBefore -and
        (Get-SelfTestTreeFingerprint $brokerShadowRoot) -ceq $sameReleaseUpgradeCutoverShadowBefore -and
        $global:DysonDeploymentTaskFixtureStopCalls.Count -eq $sameReleaseUpgradeStopCount -and
        $global:DysonDeploymentTaskFixtureStartCalls.Count -eq $sameReleaseUpgradeStartCount -and
        $global:DysonDeploymentTaskFixtureUnregisterCalls.Count -eq $sameReleaseUpgradeUnregisterCount) `
        -Message 'an unnecessary same-release broker upgrade switch mutated deployment state'

    $brokerRepeatOutput = & $installScript @brokerRepeatArguments -Confirm:$false
    $brokerRepeatResult = ($brokerRepeatOutput | Out-String).Trim() | ConvertFrom-Json
    Assert-SelfTest -Condition ($brokerRepeatResult.state -eq 'installed' -and
        (Get-ActiveVersionAt -DataRoot $brokerInstallerData) -ceq '4.1.0' -and
        [bool]$brokerRepeatResult.lifecycleBrokerReused -and
        -not [bool]$brokerRepeatResult.lifecycleBrokerUpgraded -and
        [bool]$brokerRepeatResult.cutoverBrokerReused -and
        -not [bool]$brokerRepeatResult.cutoverBrokerUpgraded -and
        -not (Test-Path -LiteralPath (Join-Path $brokerInstallationTransactionRoot `
            [string]$brokerRepeatResult.cutoverBrokerRequestId)) -and
        [Convert]::ToBase64String([System.IO.File]::ReadAllBytes($installedBrokerProfilePath)) -ceq
            [Convert]::ToBase64String($brokerProfileBeforeRepeat) -and
        (Get-Acl -LiteralPath $installedBrokerProfilePath).Sddl -ceq $brokerProfileAclBeforeRepeat -and
        [Convert]::ToBase64String([System.IO.File]::ReadAllBytes($brokerBundleBindingPath)) -ceq
            [Convert]::ToBase64String($brokerBindingBeforeRepeat) -and
        (Get-Acl -LiteralPath $brokerBundleBindingPath).Sddl -ceq $brokerBindingAclBeforeRepeat -and
        [Convert]::ToBase64String([System.IO.File]::ReadAllBytes($brokerTaskIntentPath)) -ceq
            [Convert]::ToBase64String($brokerTaskBeforeRepeat) -and
        (Get-Acl -LiteralPath $brokerTaskIntentPath).Sddl -ceq $brokerTaskAclBeforeRepeat -and
        [Convert]::ToBase64String([IO.File]::ReadAllBytes($brokerDirectoryAclIntentPath)) -ceq
            [Convert]::ToBase64String($brokerDirectoryAclBeforeRepeat) -and
        (Get-Acl -LiteralPath $brokerDirectoryAclIntentPath).Sddl -ceq `
            $brokerDirectoryAclFileAclBeforeRepeat -and
        @($brokerStorageAclsBeforeRepeat.Keys | Where-Object {
            (Get-Acl -LiteralPath $_).Sddl -cne $brokerStorageAclsBeforeRepeat[$_]
        }).Count -eq 0 -and
        [Convert]::ToBase64String([IO.File]::ReadAllBytes($installedLifecycleProfilePath)) -ceq
            [Convert]::ToBase64String($lifecycleProfileBeforeRepeat) -and
        (Get-Acl -LiteralPath $installedLifecycleProfilePath).Sddl -ceq `
            $lifecycleProfileFileAclBeforeRepeat -and
        [Convert]::ToBase64String([IO.File]::ReadAllBytes($lifecycleProfileAclPath)) -ceq
            [Convert]::ToBase64String($lifecycleProfileAclBeforeRepeat) -and
        [Convert]::ToBase64String([IO.File]::ReadAllBytes($lifecycleTaskRecordPath)) -ceq
            [Convert]::ToBase64String($lifecycleTaskBeforeRepeat) -and
        @($lifecycleStorageAclsBeforeRepeat.Keys | Where-Object {
            (Get-Acl -LiteralPath $_).Sddl -cne $lifecycleStorageAclsBeforeRepeat[$_]
        }).Count -eq 0) `
        -Message 'a repeated same-release broker deployment was not idempotent'
    Assert-NoInstallPartials -InstallRoot $brokerInstallerRoot -DataRoot $brokerInstallerData `
        -Message 'the successful broker upgrade/repeat left installer partial directories'

    $brokerUninstallPointerPath = Join-Path $brokerInstallerData 'state\active-release.json'
    $brokerUninstallPointerBefore = [System.IO.File]::ReadAllBytes($brokerUninstallPointerPath)
    $brokerUninstallProfileBefore = [System.IO.File]::ReadAllBytes($installedBrokerProfilePath)
    $brokerUninstallProfileAclBefore = (Get-Acl -LiteralPath $installedBrokerProfilePath).Sddl
    $brokerUninstallBindingBefore = [System.IO.File]::ReadAllBytes($brokerBundleBindingPath)
    $brokerUninstallBindingAclBefore = (Get-Acl -LiteralPath $brokerBundleBindingPath).Sddl
    $brokerUninstallTaskBefore = [System.IO.File]::ReadAllBytes($brokerTaskIntentPath)
    $brokerUninstallDirectoryAclBefore = [System.IO.File]::ReadAllBytes($brokerDirectoryAclIntentPath)
    $lifecycleUninstallProfileBefore = [IO.File]::ReadAllBytes($installedLifecycleProfilePath)
    $lifecycleUninstallProfileAclBefore = [IO.File]::ReadAllBytes($lifecycleProfileAclPath)
    $lifecycleUninstallTaskBefore = [IO.File]::ReadAllBytes($lifecycleTaskRecordPath)
    $lifecycleAuditSentinel = Join-Path $brokerApplicationData `
        'lifecycle-broker\deployment-audit.keep'
    [IO.File]::WriteAllText(
        $lifecycleAuditSentinel, 'fictional lifecycle audit history',
        [Text.UTF8Encoding]::new($false)
    )
    $lifecycleAuditSentinelBefore = [IO.File]::ReadAllBytes($lifecycleAuditSentinel)
    $cutoverAuditSentinel = Join-Path $brokerApplicationData `
        'cutover-broker\receipts\deployment-audit.keep'
    [IO.File]::WriteAllText(
        $cutoverAuditSentinel, 'fictional cutover audit history', [Text.UTF8Encoding]::new($false)
    )
    $cutoverAuditSentinelBefore = [IO.File]::ReadAllBytes($cutoverAuditSentinel)
    $cutoverAuditSentinelAclBefore = (Get-Acl -LiteralPath $cutoverAuditSentinel).Sddl
    $brokerDurableReceiptsBefore = @(
        Get-ChildItem -LiteralPath $brokerInstallationReceiptRoot -File -ErrorAction Stop |
            ForEach-Object {
                [pscustomobject][ordered]@{
                    path = $_.FullName
                    bytes = [IO.File]::ReadAllBytes($_.FullName)
                    sddl = (Get-Acl -LiteralPath $_.FullName).Sddl
                }
            }
    )
    $brokerAuthorityBeforeUninstall = [System.IO.File]::ReadAllBytes($brokerAuthorityFile)
    $brokerGsManagerSentinelRoot = Join-Path $brokerApplicationData 'gsmanager'
    [System.IO.Directory]::CreateDirectory($brokerGsManagerSentinelRoot) | Out-Null
    $brokerGsManagerSentinel = Join-Path $brokerGsManagerSentinelRoot 'uninstall-preservation.txt'
    [System.IO.File]::WriteAllText(
        $brokerGsManagerSentinel,
        'fictional GSManager state must not be changed by control-plane uninstall',
        [System.Text.UTF8Encoding]::new($false)
    )
    $brokerGsManagerSentinelBefore = [System.IO.File]::ReadAllBytes($brokerGsManagerSentinel)

    $brokerUninstallPreviewOutput = & $uninstallScript -InstallRoot $brokerInstallerRoot `
        -DataRoot $brokerInstallerData -TaskName 'Dyson-Control-Plane-SelfTest-Brokers' `
        -SelfTestSkipAdministratorCheck -SelfTestShadow $lifecycleShadowRoot `
        -SelfTestCutoverBrokerShadowRoot $brokerShadowRoot -WhatIf 6>$null
    $brokerUninstallPreview = ($brokerUninstallPreviewOutput | Out-String).Trim() | ConvertFrom-Json
    Assert-SelfTest -Condition ($brokerUninstallPreview.state -ceq 'preview' -and
        [bool]$brokerUninstallPreview.lifecycleBrokerWillBeRemoved -and
        [bool]$brokerUninstallPreview.lifecycleBrokerHistoryWillBePreserved -and
        [bool]$brokerUninstallPreview.cutoverBrokerWillBeRemoved -and
        [bool]$brokerUninstallPreview.cutoverBrokerDurableReceiptsWillBePreserved -and
        (Get-ActiveVersionAt -DataRoot $brokerInstallerData) -ceq '4.1.0' -and
        [Convert]::ToBase64String([System.IO.File]::ReadAllBytes($installedBrokerProfilePath)) -ceq
            [Convert]::ToBase64String($brokerUninstallProfileBefore) -and
        [Convert]::ToBase64String([System.IO.File]::ReadAllBytes($brokerTaskIntentPath)) -ceq
            [Convert]::ToBase64String($brokerUninstallTaskBefore) -and
        [Convert]::ToBase64String([IO.File]::ReadAllBytes($installedLifecycleProfilePath)) -ceq
            [Convert]::ToBase64String($lifecycleUninstallProfileBefore) -and
        [Convert]::ToBase64String([IO.File]::ReadAllBytes($lifecycleTaskRecordPath)) -ceq
            [Convert]::ToBase64String($lifecycleUninstallTaskBefore)) `
        -Message 'broker-aware uninstall WhatIf mutated active/profile/task state'

    $lifecycleRemoveDataRejected = $false
    try {
        & $uninstallScript -InstallRoot $brokerInstallerRoot -DataRoot $brokerInstallerData `
            -TaskName 'Dyson-Control-Plane-SelfTest-Brokers' -RemoveData `
            -SelfTestSkipAdministratorCheck -SelfTestShadow $lifecycleShadowRoot `
            -SelfTestCutoverBrokerShadowRoot $brokerShadowRoot -Confirm:$false | Out-Null
    }
    catch { $lifecycleRemoveDataRejected = $true }
    Assert-SelfTest -Condition ($lifecycleRemoveDataRejected -and
        (Test-Path -LiteralPath $lifecycleAuditSentinel -PathType Leaf) -and
        $global:DysonDeploymentTaskFixture.ContainsKey('Dyson-Control-Plane-SelfTest-Brokers')) `
        -Message 'RemoveData did not fail closed over retained lifecycle history/audit before mutation'

    $lifecyclePendingPath = Join-Path $brokerApplicationData `
        'lifecycle-broker\requests\uninstall-pending.json'
    [IO.File]::WriteAllText(
        $lifecyclePendingPath, '{"fictionalPendingRequest":true}',
        [Text.UTF8Encoding]::new($false)
    )
    $lifecyclePendingUninstallRejected = $false
    try {
        & $uninstallScript -InstallRoot $brokerInstallerRoot -DataRoot $brokerInstallerData `
            -TaskName 'Dyson-Control-Plane-SelfTest-Brokers' -SelfTestSkipAdministratorCheck `
            -SelfTestShadow $lifecycleShadowRoot `
            -SelfTestCutoverBrokerShadowRoot $brokerShadowRoot -Confirm:$false | Out-Null
    }
    catch { $lifecyclePendingUninstallRejected = $true }
    finally { Remove-Item -LiteralPath $lifecyclePendingPath -Force -ErrorAction SilentlyContinue }
    Assert-SelfTest -Condition ($lifecyclePendingUninstallRejected -and
        $global:DysonDeploymentTaskFixture.ContainsKey('Dyson-Control-Plane-SelfTest-Brokers') -and
        [Convert]::ToBase64String([IO.File]::ReadAllBytes($installedLifecycleProfilePath)) -ceq
            [Convert]::ToBase64String($lifecycleUninstallProfileBefore) -and
        [Convert]::ToBase64String([IO.File]::ReadAllBytes($lifecycleTaskRecordPath)) -ceq
            [Convert]::ToBase64String($lifecycleUninstallTaskBefore)) `
        -Message 'pending lifecycle work did not fail closed before control-task or broker mutation'

    $tamperedLifecycleProfile = [Text.UTF8Encoding]::new($false, $true).GetString(
        $lifecycleUninstallProfileBefore
    ) | ConvertFrom-Json
    $tamperedLifecycleProfile.gamePort = $brokerGamePort + 1
    [IO.File]::WriteAllText(
        $installedLifecycleProfilePath,
        ($tamperedLifecycleProfile | ConvertTo-Json -Depth 12 -Compress) + "`n",
        [Text.UTF8Encoding]::new($false)
    )
    $lifecycleDriftUninstallRejected = $false
    try {
        & $uninstallScript -InstallRoot $brokerInstallerRoot -DataRoot $brokerInstallerData `
            -TaskName 'Dyson-Control-Plane-SelfTest-Brokers' -SelfTestSkipAdministratorCheck `
            -SelfTestShadow $lifecycleShadowRoot `
            -SelfTestCutoverBrokerShadowRoot $brokerShadowRoot -Confirm:$false | Out-Null
    }
    catch { $lifecycleDriftUninstallRejected = $true }
    finally { [IO.File]::WriteAllBytes($installedLifecycleProfilePath, $lifecycleUninstallProfileBefore) }
    Assert-SelfTest -Condition ($lifecycleDriftUninstallRejected -and
        $global:DysonDeploymentTaskFixture.ContainsKey('Dyson-Control-Plane-SelfTest-Brokers') -and
        [Convert]::ToBase64String([IO.File]::ReadAllBytes($lifecycleTaskRecordPath)) -ceq
            [Convert]::ToBase64String($lifecycleUninstallTaskBefore)) `
        -Message 'drifted lifecycle environment/profile binding did not fail closed before mutation'

    $brokerPendingPath = Join-Path $brokerApplicationData 'cutover-broker\requests\uninstall-pending.json'
    [System.IO.File]::WriteAllText(
        $brokerPendingPath,
        '{"fictionalPendingRequest":true}',
        [System.Text.UTF8Encoding]::new($false)
    )
    $brokerPendingControlTaskXml = [string]$global:DysonDeploymentTaskFixture[
        'Dyson-Control-Plane-SelfTest-Brokers'
    ].Xml
    $brokerPendingStopCount = $global:DysonDeploymentTaskFixtureStopCalls.Count
    $brokerPendingStartCount = $global:DysonDeploymentTaskFixtureStartCalls.Count
    $brokerPendingUnregisterCount = $global:DysonDeploymentTaskFixtureUnregisterCalls.Count
    $brokerPendingUninstallRejected = $false
    try {
        & $uninstallScript -InstallRoot $brokerInstallerRoot -DataRoot $brokerInstallerData `
            -TaskName 'Dyson-Control-Plane-SelfTest-Brokers' -SelfTestSkipAdministratorCheck `
            -SelfTestShadow $lifecycleShadowRoot `
            -SelfTestCutoverBrokerShadowRoot $brokerShadowRoot -Confirm:$false | Out-Null
    }
    catch { $brokerPendingUninstallRejected = $true }
    finally { Remove-Item -LiteralPath $brokerPendingPath -Force -ErrorAction SilentlyContinue }
    Assert-SelfTest -Condition ($brokerPendingUninstallRejected -and
        (Get-ActiveVersionAt -DataRoot $brokerInstallerData) -ceq '4.1.0' -and
        $global:DysonDeploymentTaskFixture.ContainsKey('Dyson-Control-Plane-SelfTest-Brokers') -and
        [string]$global:DysonDeploymentTaskFixture['Dyson-Control-Plane-SelfTest-Brokers'].Xml -ceq
            $brokerPendingControlTaskXml -and
        [string]$global:DysonDeploymentTaskFixture['Dyson-Control-Plane-SelfTest-Brokers'].State -ceq 'Running' -and
        $global:DysonDeploymentTaskFixtureStopCalls.Count -eq $brokerPendingStopCount -and
        $global:DysonDeploymentTaskFixtureStartCalls.Count -eq $brokerPendingStartCount -and
        $global:DysonDeploymentTaskFixtureUnregisterCalls.Count -eq $brokerPendingUnregisterCount -and
        [Convert]::ToBase64String([System.IO.File]::ReadAllBytes($installedBrokerProfilePath)) -ceq
            [Convert]::ToBase64String($brokerUninstallProfileBefore) -and
        [Convert]::ToBase64String([System.IO.File]::ReadAllBytes($brokerTaskIntentPath)) -ceq
            [Convert]::ToBase64String($brokerUninstallTaskBefore)) `
        -Message 'pending cutover work did not fail closed before control-plane uninstall mutation'

    $tamperedBrokerBinding = [System.Text.UTF8Encoding]::new($false, $true).GetString(
        $brokerUninstallBindingBefore
    ) | ConvertFrom-Json
    $tamperedBrokerBinding.brokerBundleSha256 = '0' * 64
    [System.IO.File]::WriteAllText(
        $brokerBundleBindingPath,
        ($tamperedBrokerBinding | ConvertTo-Json -Depth 8 -Compress) + "`n",
        [System.Text.UTF8Encoding]::new($false)
    )
    $brokerDriftUninstallRejected = $false
    try {
        & $uninstallScript -InstallRoot $brokerInstallerRoot -DataRoot $brokerInstallerData `
            -TaskName 'Dyson-Control-Plane-SelfTest-Brokers' -SelfTestSkipAdministratorCheck `
            -SelfTestShadow $lifecycleShadowRoot `
            -SelfTestCutoverBrokerShadowRoot $brokerShadowRoot -Confirm:$false | Out-Null
    }
    catch { $brokerDriftUninstallRejected = $true }
    finally { [System.IO.File]::WriteAllBytes($brokerBundleBindingPath, $brokerUninstallBindingBefore) }
    Assert-SelfTest -Condition ($brokerDriftUninstallRejected -and
        (Get-ActiveVersionAt -DataRoot $brokerInstallerData) -ceq '4.1.0' -and
        [Convert]::ToBase64String([System.IO.File]::ReadAllBytes($installedBrokerProfilePath)) -ceq
            [Convert]::ToBase64String($brokerUninstallProfileBefore) -and
        [Convert]::ToBase64String([System.IO.File]::ReadAllBytes($brokerTaskIntentPath)) -ceq
            [Convert]::ToBase64String($brokerUninstallTaskBefore)) `
        -Message 'drifted cutover broker binding did not fail closed before control-plane uninstall mutation'

    $brokerUninstallTaskName = 'Dyson-Control-Plane-SelfTest-Brokers'
    Assert-SelfTest -Condition $global:DysonDeploymentTaskFixture.ContainsKey($brokerUninstallTaskName) `
        -Message 'the deployed control-plane task was unavailable before broker-aware uninstall'
    $brokerUninstallTaskXml = [string]$global:DysonDeploymentTaskFixture[$brokerUninstallTaskName].Xml
    $postBrokerRemovalFailureMarker = Join-Path $lifecycleShadowRoot 'fail-after-broker-removal'
    [IO.File]::WriteAllText(
        $postBrokerRemovalFailureMarker, 'fixture', [Text.UTF8Encoding]::new($false)
    )
    $brokerPostRemovalFailureObserved = $false
    $brokerPostRemovalFailureError = $null
    try {
        & $uninstallScript -InstallRoot $brokerInstallerRoot -DataRoot $brokerInstallerData `
            -TaskName $brokerUninstallTaskName -SelfTestSkipAdministratorCheck `
            -SelfTestShadow $lifecycleShadowRoot `
            -SelfTestCutoverBrokerShadowRoot $brokerShadowRoot -Confirm:$false | Out-Null
    }
    catch {
        $brokerPostRemovalFailureObserved = $true
        $brokerPostRemovalFailureError = $_.Exception.Message
    }
    finally { Remove-Item -LiteralPath $postBrokerRemovalFailureMarker -Force -ErrorAction SilentlyContinue }
    Assert-SelfTest -Condition ($brokerPostRemovalFailureObserved -and
        $brokerPostRemovalFailureError -notmatch 'automatic rollback was incomplete' -and
        (Test-Path -LiteralPath $brokerInstallerRoot -PathType Container) -and
        (Get-ActiveVersionAt -DataRoot $brokerInstallerData) -ceq '4.1.0' -and
        [Convert]::ToBase64String([System.IO.File]::ReadAllBytes($brokerUninstallPointerPath)) -ceq
            [Convert]::ToBase64String($brokerUninstallPointerBefore) -and
        $global:DysonDeploymentTaskFixture.ContainsKey($brokerUninstallTaskName) -and
        $global:DysonDeploymentTaskFixture[$brokerUninstallTaskName].Xml -ceq $brokerUninstallTaskXml -and
        $global:DysonDeploymentTaskFixture[$brokerUninstallTaskName].State -ceq 'Running' -and
        [Convert]::ToBase64String([System.IO.File]::ReadAllBytes($installedBrokerProfilePath)) -ceq
            [Convert]::ToBase64String($brokerUninstallProfileBefore) -and
        (Get-Acl -LiteralPath $installedBrokerProfilePath).Sddl -ceq $brokerUninstallProfileAclBefore -and
        [Convert]::ToBase64String([System.IO.File]::ReadAllBytes($brokerBundleBindingPath)) -ceq
            [Convert]::ToBase64String($brokerUninstallBindingBefore) -and
        (Get-Acl -LiteralPath $brokerBundleBindingPath).Sddl -ceq $brokerUninstallBindingAclBefore -and
        [Convert]::ToBase64String([System.IO.File]::ReadAllBytes($brokerTaskIntentPath)) -ceq
            [Convert]::ToBase64String($brokerUninstallTaskBefore) -and
        [Convert]::ToBase64String([System.IO.File]::ReadAllBytes($brokerDirectoryAclIntentPath)) -ceq
            [Convert]::ToBase64String($brokerUninstallDirectoryAclBefore) -and
        [Convert]::ToBase64String([IO.File]::ReadAllBytes($installedLifecycleProfilePath)) -ceq
            [Convert]::ToBase64String($lifecycleUninstallProfileBefore) -and
        [Convert]::ToBase64String([IO.File]::ReadAllBytes($lifecycleProfileAclPath)) -ceq
            [Convert]::ToBase64String($lifecycleUninstallProfileAclBefore) -and
        [Convert]::ToBase64String([IO.File]::ReadAllBytes($lifecycleTaskRecordPath)) -ceq
            [Convert]::ToBase64String($lifecycleUninstallTaskBefore) -and
        [Convert]::ToBase64String([IO.File]::ReadAllBytes($lifecycleAuditSentinel)) -ceq
            [Convert]::ToBase64String($lifecycleAuditSentinelBefore) -and
        [Convert]::ToBase64String([IO.File]::ReadAllBytes($cutoverAuditSentinel)) -ceq
            [Convert]::ToBase64String($cutoverAuditSentinelBefore) -and
        (Get-Acl -LiteralPath $cutoverAuditSentinel).Sddl -ceq $cutoverAuditSentinelAclBefore -and
        @($brokerDurableReceiptsBefore | Where-Object {
            -not (Test-Path -LiteralPath $_.path -PathType Leaf) -or
            [Convert]::ToBase64String([IO.File]::ReadAllBytes($_.path)) -cne
                [Convert]::ToBase64String([byte[]]$_.bytes) -or
            (Get-Acl -LiteralPath $_.path).Sddl -cne [string]$_.sddl
        }).Count -eq 0) `
        -Message ('a failure after broker removal did not restore release/profile/task/DACL preimages: ' +
            $brokerPostRemovalFailureError)

    $brokerUninstallOutput = & $uninstallScript -InstallRoot $brokerInstallerRoot `
        -DataRoot $brokerInstallerData -TaskName $brokerUninstallTaskName `
        -SelfTestSkipAdministratorCheck -SelfTestShadow $lifecycleShadowRoot `
        -SelfTestCutoverBrokerShadowRoot $brokerShadowRoot `
        -Confirm:$false
    $brokerUninstallResult = ($brokerUninstallOutput | Out-String).Trim() | ConvertFrom-Json
    Assert-SelfTest -Condition (@($preparedRuntimeTaskBytes.Keys | Where-Object {
        [Convert]::ToBase64String([IO.File]::ReadAllBytes($_)) -cne
            [Convert]::ToBase64String($preparedRuntimeTaskBytes[$_])
    }).Count -eq 0) -Message 'broker uninstall changed the prepared disabled runtime pair'
    Assert-SelfTest -Condition ($brokerUninstallResult.state -ceq 'uninstalled' -and
        [bool]$brokerUninstallResult.taskRemoved -and
        [bool]$brokerUninstallResult.lifecycleBrokerRemoved -and
        [bool]$brokerUninstallResult.lifecycleBrokerHistoryPreserved -and
        [bool]$brokerUninstallResult.cutoverBrokerRemoved -and
        [bool]$brokerUninstallResult.cutoverBrokerDurableReceiptsPreserved -and
        -not (Test-Path -LiteralPath $brokerInstallerRoot) -and
        -not (Test-Path -LiteralPath $brokerUninstallPointerPath) -and
        -not (Test-Path -LiteralPath $installedBrokerProfilePath) -and
        -not (Test-Path -LiteralPath $brokerBundleBindingPath) -and
        -not (Test-Path -LiteralPath $brokerTaskIntentPath) -and
        -not (Test-Path -LiteralPath $installedLifecycleProfilePath) -and
        -not (Test-Path -LiteralPath $lifecycleTaskRecordPath) -and
        -not (Test-Path -LiteralPath $lifecycleProfileAclPath) -and
        -not $global:DysonDeploymentTaskFixture.ContainsKey($brokerUninstallTaskName) -and
        (Test-Path -LiteralPath ([string]$brokerUninstallResult.recoverableReleaseBackup) -PathType Container) -and
        (Test-Path -LiteralPath ([string]$brokerUninstallResult.activePointerBackup) -PathType Leaf) -and
        @($brokerDurableReceiptsBefore | Where-Object {
            -not (Test-Path -LiteralPath $_.path -PathType Leaf) -or
            [Convert]::ToBase64String([IO.File]::ReadAllBytes($_.path)) -cne
                [Convert]::ToBase64String([byte[]]$_.bytes) -or
            (Get-Acl -LiteralPath $_.path).Sddl -cne [string]$_.sddl
        }).Count -eq 0 -and
        [Convert]::ToBase64String([System.IO.File]::ReadAllBytes($brokerAuthorityFile)) -ceq
            [Convert]::ToBase64String($brokerAuthorityBeforeUninstall) -and
        [Convert]::ToBase64String([System.IO.File]::ReadAllBytes($brokerGsManagerSentinel)) -ceq
            [Convert]::ToBase64String($brokerGsManagerSentinelBefore) -and
        [Convert]::ToBase64String([IO.File]::ReadAllBytes($lifecycleAuditSentinel)) -ceq
            [Convert]::ToBase64String($lifecycleAuditSentinelBefore) -and
        [Convert]::ToBase64String([IO.File]::ReadAllBytes($cutoverAuditSentinel)) -ceq
            [Convert]::ToBase64String($cutoverAuditSentinelBefore) -and
        (Get-Acl -LiteralPath $cutoverAuditSentinel).Sddl -ceq $cutoverAuditSentinelAclBefore -and
        (Test-Path -LiteralPath (Join-Path $brokerApplicationData `
            'lifecycle-broker\requests') -PathType Container) -and
        (Test-Path -LiteralPath (Join-Path $brokerApplicationData `
            'lifecycle-broker\receipts') -PathType Container) -and
        (Test-Path -LiteralPath (Join-Path $brokerApplicationData `
            'lifecycle-broker\intents') -PathType Container)) `
        -Message 'successful broker-aware uninstall left fixed task/profile state or changed retained authority/GSManager data'

    $schedulerFailureTaskName = 'Dyson-Control-Plane-SelfTest-Scheduler-Failure'
    $schedulerFailureTaskXml = '<Task><RegistrationInfo><Description>fictional scheduler query failure preimage</Description></RegistrationInfo></Task>'
    $schedulerFailureTask = [pscustomobject]@{
        FixtureTaskName = $schedulerFailureTaskName
        TaskPath = '\'
        State = 'Running'
        Xml = $schedulerFailureTaskXml
        Principal = [pscustomobject]@{ UserId = 'fictional-scheduler-failure'; LogonType = 'Interactive'; RunLevel = 'Limited' }
        Actions = @()
        Settings = [pscustomobject]@{ Enabled = $true }
    }
    $global:DysonDeploymentTaskFixture[$schedulerFailureTaskName] = $schedulerFailureTask
    $schedulerFailureTaskAuditLength = (Get-Item -LiteralPath $taskAuditPath -ErrorAction Stop).Length
    $schedulerFailureTaskAcl = (Get-Acl -LiteralPath $installerData -ErrorAction Stop).Sddl
    $schedulerFailureTaskPointer = [System.IO.File]::ReadAllText(
        (Join-Path $installerData 'state\active-release.json'),
        [System.Text.Encoding]::UTF8
    )
    $schedulerFailureInstallRejected = $false
    $global:DysonDeploymentTaskFixtureQueryFailure = $true
    try {
        & $taskScript -InstallRoot $installerRoot -DataRoot $installerData -NodeExecutable $nodeFixtures.node24 `
            -TaskName $schedulerFailureTaskName -EnvironmentFile (Join-Path $installerData 'config\dyson-control.env') `
            -SelfTestSkipAdministratorCheck -Confirm:$false | Out-Null
    }
    catch { $schedulerFailureInstallRejected = $_.Exception.Message -eq 'The Task Scheduler state could not be queried.' }
    finally { $global:DysonDeploymentTaskFixtureQueryFailure = $false }
    Assert-SelfTest -Condition ($schedulerFailureInstallRejected -and
        $schedulerFailureTask.State -eq 'Running' -and $schedulerFailureTask.Xml -ceq $schedulerFailureTaskXml -and
        (Get-Item -LiteralPath $taskAuditPath -ErrorAction Stop).Length -eq $schedulerFailureTaskAuditLength -and
        (Get-Acl -LiteralPath $installerData -ErrorAction Stop).Sddl -eq $schedulerFailureTaskAcl -and
        [System.IO.File]::ReadAllText(
            (Join-Path $installerData 'state\active-release.json'),
            [System.Text.Encoding]::UTF8
        ) -ceq $schedulerFailureTaskPointer) `
        -Message 'task installation did not fail closed before mutation when Task Scheduler could not be queried'

    $wrapperConfigurationPath = Join-Path $wrapperLockData 'config\dyson-control.env'
    [void](Invoke-DysonDeploymentConfigurationInstall `
        -ConfigurationSource $installerConfig -DataRoot $wrapperLockData `
        -ScriptRoot (Join-Path $wrapperLockRoot 'releases\1.0.0\scripts\windows') `
        -RuntimeBootstrapRoot (Join-Path $wrapperLockRoot 'bootstrap') `
        -DeploymentVersion '1.0.0' -ServiceAccount 'NT AUTHORITY\LOCAL SERVICE' `
        -ConfigurationModuleRoot $script:ConfigurationShadowRoot)
    $wrapperConfigurationBefore = [System.IO.File]::ReadAllBytes($wrapperConfigurationPath)
    $schedulerFailureUninstallAuditPath = Join-Path $wrapperLockData 'audit\deployment.jsonl'
    $schedulerFailureUninstallAuditLength = (Get-Item -LiteralPath $schedulerFailureUninstallAuditPath -ErrorAction Stop).Length
    $schedulerFailureUninstallPointer = [System.IO.File]::ReadAllText(
        (Join-Path $wrapperLockData 'state\active-release.json'),
        [System.Text.Encoding]::UTF8
    )
    $schedulerFailureUninstallRejected = $false
    $global:DysonDeploymentTaskFixtureQueryFailure = $true
    try {
        & $uninstallScript -InstallRoot $wrapperLockRoot -DataRoot $wrapperLockData `
            -TaskName $schedulerFailureTaskName -SelfTestSkipAdministratorCheck -Confirm:$false | Out-Null
    }
    catch { $schedulerFailureUninstallRejected = $_.Exception.Message -eq 'The Task Scheduler state could not be queried.' }
    finally { $global:DysonDeploymentTaskFixtureQueryFailure = $false }
    Assert-SelfTest -Condition ($schedulerFailureUninstallRejected -and
        $schedulerFailureTask.State -eq 'Running' -and $schedulerFailureTask.Xml -ceq $schedulerFailureTaskXml -and
        (Test-Path -LiteralPath $wrapperLockRoot -PathType Container) -and
        (Get-Item -LiteralPath $schedulerFailureUninstallAuditPath -ErrorAction Stop).Length -eq $schedulerFailureUninstallAuditLength -and
        [System.IO.File]::ReadAllText(
            (Join-Path $wrapperLockData 'state\active-release.json'),
            [System.Text.Encoding]::UTF8
        ) -ceq $schedulerFailureUninstallPointer) `
        -Message 'uninstall did not fail closed before mutation when Task Scheduler could not be queried'
    [void]$global:DysonDeploymentTaskFixture.Remove($schedulerFailureTaskName)

    $restartNonRootTaskName = 'Dyson-Control-Plane-SelfTest-Restart-Non-Root'
    $restartNonRootTask = [pscustomobject]@{
        FixtureTaskName = $restartNonRootTaskName
        TaskPath = '\FictionalFolder\'
        State = 'Running'
        Xml = '<Task><RegistrationInfo><Description>fictional non-root restart task</Description></RegistrationInfo></Task>'
        Principal = [pscustomobject]@{ UserId = 'fictional-restart-non-root'; LogonType = 'Interactive'; RunLevel = 'Limited' }
        Actions = @()
        Settings = [pscustomobject]@{ Enabled = $true }
    }
    $global:DysonDeploymentTaskFixture[$restartNonRootTaskName] = $restartNonRootTask
    $restartNonRootStopCount = $global:DysonDeploymentTaskFixtureStopCalls.Count
    $restartNonRootStartCount = $global:DysonDeploymentTaskFixtureStartCalls.Count
    $restartNonRootRejected = $false
    $restartNonRootError = $null
    try { Restart-DysonControlTask -TaskName $restartNonRootTaskName }
    catch {
        $restartNonRootError = $_.Exception.Message
        $restartNonRootRejected = $restartNonRootError -eq 'The fixed control-plane task is unavailable.'
    }
    Assert-SelfTest -Condition ($restartNonRootRejected -and $restartNonRootTask.State -eq 'Running' -and
        $global:DysonDeploymentTaskFixtureStopCalls.Count -eq $restartNonRootStopCount -and
        $global:DysonDeploymentTaskFixtureStartCalls.Count -eq $restartNonRootStartCount) `
        -Message ('Restart-DysonControlTask touched a unique task outside the fixed root task path; error: ' + $restartNonRootError)
    [void]$global:DysonDeploymentTaskFixture.Remove($restartNonRootTaskName)

    $restartAmbiguousTaskName = 'Dyson-Control-Plane-SelfTest-Restart-Ambiguous'
    $restartAmbiguousRootTask = [pscustomobject]@{
        FixtureTaskName = $restartAmbiguousTaskName
        TaskPath = '\'
        State = 'Running'
        Xml = '<Task><RegistrationInfo><Description>fictional root restart task</Description></RegistrationInfo></Task>'
        Principal = [pscustomobject]@{ UserId = 'fictional-restart-root'; LogonType = 'Interactive'; RunLevel = 'Limited' }
        Actions = @()
        Settings = [pscustomobject]@{ Enabled = $true }
    }
    $restartAmbiguousNonRootTask = [pscustomobject]@{
        FixtureTaskName = $restartAmbiguousTaskName
        TaskPath = '\FictionalFolder\'
        State = 'Ready'
        Xml = '<Task><RegistrationInfo><Description>fictional duplicate restart task</Description></RegistrationInfo></Task>'
        Principal = [pscustomobject]@{ UserId = 'fictional-restart-duplicate'; LogonType = 'Interactive'; RunLevel = 'Limited' }
        Actions = @()
        Settings = [pscustomobject]@{ Enabled = $true }
    }
    $global:DysonDeploymentTaskFixture[$restartAmbiguousTaskName] = @(
        $restartAmbiguousRootTask,
        $restartAmbiguousNonRootTask
    )
    $restartAmbiguousStopCount = $global:DysonDeploymentTaskFixtureStopCalls.Count
    $restartAmbiguousStartCount = $global:DysonDeploymentTaskFixtureStartCalls.Count
    $restartAmbiguousRejected = $false
    try { Restart-DysonControlTask -TaskName $restartAmbiguousTaskName }
    catch { $restartAmbiguousRejected = $_.Exception.Message -eq 'The fixed control-plane task identity is not unique.' }
    Assert-SelfTest -Condition ($restartAmbiguousRejected -and
        $restartAmbiguousRootTask.State -eq 'Running' -and $restartAmbiguousNonRootTask.State -eq 'Ready' -and
        $global:DysonDeploymentTaskFixtureStopCalls.Count -eq $restartAmbiguousStopCount -and
        $global:DysonDeploymentTaskFixtureStartCalls.Count -eq $restartAmbiguousStartCount) `
        -Message 'Restart-DysonControlTask touched same-name root and non-root tasks before rejecting ambiguity'
    [void]$global:DysonDeploymentTaskFixture.Remove($restartAmbiguousTaskName)

    $taskRemovalProbeName = 'Dyson-Control-Plane-SelfTest-Removal-Probe'
    $global:DysonDeploymentTaskFixture[$taskRemovalProbeName] = [pscustomobject]@{
        FixtureTaskName = $taskRemovalProbeName
        TaskPath = '\'
        State = 'Running'
        Xml = '<Task><RegistrationInfo><Description>fictional removal probe</Description></RegistrationInfo></Task>'
        Principal = [pscustomobject]@{ UserId = 'fictional-probe'; LogonType = 'Interactive'; RunLevel = 'Limited' }
        Actions = @()
        Settings = [pscustomobject]@{ Enabled = $true }
    }
    try { Remove-DysonControlTaskForRollback -TaskName $taskRemovalProbeName }
    catch { throw ('SELFTEST_FAILED: the scheduled-task removal fixture could not exercise compensation: ' + $_.Exception.Message) }
    Assert-SelfTest -Condition (-not $global:DysonDeploymentTaskFixture.ContainsKey($taskRemovalProbeName)) `
        -Message 'the scheduled-task removal helper did not verify fixture removal'

    $ambiguousTaskName = 'Dyson-Control-Plane-SelfTest-Ambiguous'
    $global:DysonDeploymentTaskFixture[$ambiguousTaskName] = @(
        [pscustomobject]@{
            FixtureTaskName = $ambiguousTaskName
            TaskPath = '\'
            State = 'Ready'
            Xml = '<Task><RegistrationInfo><Description>fictional ambiguous task one</Description></RegistrationInfo></Task>'
            Principal = [pscustomobject]@{ UserId = 'fictional-one'; LogonType = 'Interactive'; RunLevel = 'Limited' }
            Actions = @()
            Settings = [pscustomobject]@{ Enabled = $true }
        },
        [pscustomobject]@{
            FixtureTaskName = $ambiguousTaskName
            TaskPath = '\FictionalFolder\'
            State = 'Ready'
            Xml = '<Task><RegistrationInfo><Description>fictional ambiguous task two</Description></RegistrationInfo></Task>'
            Principal = [pscustomobject]@{ UserId = 'fictional-two'; LogonType = 'Interactive'; RunLevel = 'Limited' }
            Actions = @()
            Settings = [pscustomobject]@{ Enabled = $true }
        }
    )
    $ambiguousAclBefore = (Get-Acl -LiteralPath $installerData -ErrorAction Stop).Sddl
    $ambiguousAuditLength = (Get-Item -LiteralPath $taskAuditPath -ErrorAction Stop).Length
    $ambiguousTaskRejected = $false
    try {
        & $taskScript -InstallRoot $installerRoot -DataRoot $installerData -NodeExecutable $nodeFixtures.node24 `
            -TaskName $ambiguousTaskName -EnvironmentFile (Join-Path $installerData 'config\dyson-control.env') `
            -SelfTestSkipAdministratorCheck -Confirm:$false | Out-Null
    }
    catch { $ambiguousTaskRejected = $_.Exception.Message -eq 'The control-plane task identity is ambiguous.' }
    Assert-SelfTest -Condition $ambiguousTaskRejected `
        -Message 'the direct task installer did not reject duplicate task names across task paths'
    Assert-SelfTest -Condition ((Get-Acl -LiteralPath $installerData -ErrorAction Stop).Sddl -eq $ambiguousAclBefore -and
        (Get-Item -LiteralPath $taskAuditPath -ErrorAction Stop).Length -eq $ambiguousAuditLength) `
        -Message 'the ambiguous direct task install changed ACL or audit state before rejecting the task identity'
    [void]$global:DysonDeploymentTaskFixture.Remove($ambiguousTaskName)

    $nonRootTaskName = 'Dyson-Control-Plane-SelfTest-Non-Root'
    $nonRootTask = [pscustomobject]@{
        FixtureTaskName = $nonRootTaskName
        TaskPath = '\FictionalFolder\'
        State = 'Ready'
        Xml = '<Task><RegistrationInfo><Description>fictional non-root task</Description></RegistrationInfo></Task>'
        Principal = [pscustomobject]@{ UserId = 'fictional-non-root'; LogonType = 'Interactive'; RunLevel = 'Limited' }
        Actions = @()
        Settings = [pscustomobject]@{ Enabled = $true }
    }
    $global:DysonDeploymentTaskFixture[$nonRootTaskName] = $nonRootTask
    $nonRootAclBefore = (Get-Acl -LiteralPath $installerData -ErrorAction Stop).Sddl
    $nonRootAuditLength = (Get-Item -LiteralPath $taskAuditPath -ErrorAction Stop).Length
    $nonRootTaskRejected = $false
    try {
        & $taskScript -InstallRoot $installerRoot -DataRoot $installerData -NodeExecutable $nodeFixtures.node24 `
            -TaskName $nonRootTaskName -EnvironmentFile (Join-Path $installerData 'config\dyson-control.env') `
            -SelfTestSkipAdministratorCheck -Confirm:$false | Out-Null
    }
    catch { $nonRootTaskRejected = $_.Exception.Message -eq 'The control-plane task must use the fixed root task path.' }
    Assert-SelfTest -Condition $nonRootTaskRejected `
        -Message 'the direct task installer accepted a unique same-name task outside the fixed root task path'
    Assert-SelfTest -Condition ($global:DysonDeploymentTaskFixture[$nonRootTaskName] -eq $nonRootTask -and
        $nonRootTask.State -eq 'Ready' -and $nonRootTask.TaskPath -ceq '\FictionalFolder\' -and
        (Get-Acl -LiteralPath $installerData -ErrorAction Stop).Sddl -eq $nonRootAclBefore -and
        (Get-Item -LiteralPath $taskAuditPath -ErrorAction Stop).Length -eq $nonRootAuditLength) `
        -Message 'rejecting a non-root task changed its identity, ACL, or audit state'
    [void]$global:DysonDeploymentTaskFixture.Remove($nonRootTaskName)

    $directFailureTaskName = 'Dyson-Control-Plane-SelfTest-Direct-Failure'
    $directFailureTaskXml = '<Task><RegistrationInfo><Description>fictional direct-install preimage</Description></RegistrationInfo></Task>'
    $global:DysonDeploymentTaskFixture[$directFailureTaskName] = [pscustomobject]@{
        FixtureTaskName = $directFailureTaskName
        TaskPath = '\'
        State = 'Ready'
        Xml = $directFailureTaskXml
        Principal = [pscustomobject]@{ UserId = 'fictional-direct'; LogonType = 'Interactive'; RunLevel = 'Limited' }
        Actions = @()
        Settings = [pscustomobject]@{ Enabled = $true }
    }
    $directFailureAclBefore = (Get-Acl -LiteralPath $installerData -ErrorAction Stop).Sddl
    $directFailureRuntimeFingerprintBefore = Get-SelfTestTreeFingerprint $script:NodeRuntimeRoot
    $directFailureRuntimeRootAclBefore = (Get-Acl -LiteralPath $script:NodeRuntimeRoot -ErrorAction Stop).Sddl
    $directFailureRuntimeNodeAclBefore = (Get-Acl -LiteralPath $script:NodeRuntimeExecutable -ErrorAction Stop).Sddl
    $global:DysonDeploymentTaskFixtureCorruptRegistrationFor = $directFailureTaskName
    $directTaskFailureObserved = $false
    $directTaskFailureError = $null
    try {
        & $taskScript -InstallRoot $installerRoot -DataRoot $installerData -NodeExecutable $nodeFixtures.node24 `
            -TaskName $directFailureTaskName -EnvironmentFile (Join-Path $installerData 'config\dyson-control.env') `
            -SelfTestSkipAdministratorCheck -Confirm:$false | Out-Null
    }
    catch {
        $directTaskFailureError = $_.Exception.Message
        $directTaskFailureObserved = $directTaskFailureError -eq `
            'The fixed control-plane startup task does not match its complete contract.'
    }
    finally { $global:DysonDeploymentTaskFixtureCorruptRegistrationFor = $null }
    Assert-SelfTest -Condition $directTaskFailureObserved `
        -Message ('the direct task installer did not preserve the fixed-definition failure after compensation; error: ' + $directTaskFailureError)
    Assert-SelfTest -Condition ($global:DysonDeploymentTaskFixture.ContainsKey($directFailureTaskName) -and
        $global:DysonDeploymentTaskFixture[$directFailureTaskName].Xml -ceq $directFailureTaskXml -and
        $global:DysonDeploymentTaskFixture[$directFailureTaskName].State -ne 'Running' -and
        (Get-Acl -LiteralPath $installerData -ErrorAction Stop).Sddl -eq $directFailureAclBefore -and
        (Get-SelfTestTreeFingerprint $script:NodeRuntimeRoot) -ceq $directFailureRuntimeFingerprintBefore -and
        (Get-Acl -LiteralPath $script:NodeRuntimeRoot -ErrorAction Stop).Sddl -ceq $directFailureRuntimeRootAclBefore -and
        (Get-Acl -LiteralPath $script:NodeRuntimeExecutable -ErrorAction Stop).Sddl -ceq $directFailureRuntimeNodeAclBefore) `
        -Message 'the direct task installer did not restore its task and ACL preimages after pre-receipt failure'

    $existingTaskName = 'Dyson-Control-Plane-SelfTest-Existing'
    $existingTaskXml = '<Task><RegistrationInfo><Description>fictional previous task</Description></RegistrationInfo></Task>'
    $global:DysonDeploymentTaskFixture[$existingTaskName] = [pscustomobject]@{
        FixtureTaskName = $existingTaskName
        TaskPath = '\'
        State = 'Running'
        Xml = $existingTaskXml
        Principal = [pscustomobject]@{ UserId = 'fictional-previous'; LogonType = 'Interactive'; RunLevel = 'Limited' }
        Actions = @()
        Settings = [pscustomobject]@{ Enabled = $true }
    }
    $existingPointerPath = Join-Path $taskRollbackExistingData 'state\active-release.json'
    $existingPointerBefore = [System.IO.File]::ReadAllText($existingPointerPath, [System.Text.Encoding]::UTF8)
    $existingAclBefore = (Get-Acl -LiteralPath $taskRollbackExistingData -ErrorAction Stop).Sddl
    $existingTaskRollbackObserved = $false
    $existingTaskRollbackError = $null
    try {
        & $installScript -SourcePath $payloadInstaller -Version '2.0.0' -NodeExecutable $nodeFixtures.node24 `
            -ExpectedArtifactPayloadSha256 (Get-FictionalPayloadSha256 -Root $payloadInstaller) `
            -InstallRoot $taskRollbackExistingRoot -DataRoot $taskRollbackExistingData `
            -ConfigurationSource $installerConfig -RegisterStartupTask -StartAfterInstall `
            -TaskName $existingTaskName -ReadinessUri $closedReadinessUri -ReadinessTimeoutSeconds 1 `
            -SelfTestSkipAdministratorCheck -Confirm:$false | Out-Null
    }
    catch {
        $existingTaskRollbackObserved = $true
        $existingTaskRollbackError = $_.Exception.Message
    }
    Assert-SelfTest -Condition $existingTaskRollbackObserved `
        -Message 'a post-task readiness failure did not fail the installer'
    Assert-SelfTest -Condition ($global:DysonDeploymentTaskFixture.ContainsKey($existingTaskName) -and
        $global:DysonDeploymentTaskFixture[$existingTaskName].Xml -ceq $existingTaskXml -and
        $global:DysonDeploymentTaskFixture[$existingTaskName].State -eq 'Running' -and
        $existingTaskRollbackError -notmatch 'automatic rollback was incomplete') `
        -Message ('a post-task readiness failure did not restore the exact previous task; installer error: ' + $existingTaskRollbackError)
    Assert-SelfTest -Condition ((Get-ActiveVersionAt -DataRoot $taskRollbackExistingData) -eq '1.0.0' -and
        -not (Test-Path -LiteralPath (Join-Path $taskRollbackExistingRoot 'bootstrap')) -and
        -not (Test-Path -LiteralPath (Join-Path $taskRollbackExistingData `
            'config\dyson-control.env')) -and
        [System.IO.File]::ReadAllText($existingPointerPath, [System.Text.Encoding]::UTF8) -ceq
            $existingPointerBefore -and
        (Get-Acl -LiteralPath $taskRollbackExistingData -ErrorAction Stop).Sddl -eq $existingAclBefore) `
        -Message 'the existing-task failure did not restore the exact release/configuration/ACL preimage'
    Assert-NoInstallPartials -InstallRoot $taskRollbackExistingRoot -DataRoot $taskRollbackExistingData `
        -Message 'the existing-task rollback left a partial deployment directory'

    $newTaskName = 'Dyson-Control-Plane-SelfTest-New'
    $newPointerPath = Join-Path $taskRollbackNewData 'state\active-release.json'
    $newPointerBefore = [System.IO.File]::ReadAllText($newPointerPath, [System.Text.Encoding]::UTF8)
    $newAclBefore = (Get-Acl -LiteralPath $taskRollbackNewData -ErrorAction Stop).Sddl
    $newTaskRollbackObserved = $false
    $newTaskRollbackError = $null
    try {
        & $installScript -SourcePath $payloadInstaller -Version '2.0.0' -NodeExecutable $nodeFixtures.node24 `
            -ExpectedArtifactPayloadSha256 (Get-FictionalPayloadSha256 -Root $payloadInstaller) `
            -InstallRoot $taskRollbackNewRoot -DataRoot $taskRollbackNewData `
            -ConfigurationSource $installerConfig -RegisterStartupTask -StartAfterInstall `
            -TaskName $newTaskName -ReadinessUri $closedReadinessUri -ReadinessTimeoutSeconds 1 `
            -SelfTestSkipAdministratorCheck -Confirm:$false | Out-Null
    }
    catch {
        $newTaskRollbackObserved = $true
        $newTaskRollbackError = $_.Exception.Message
    }
    Assert-SelfTest -Condition $newTaskRollbackObserved `
        -Message 'a post-new-task readiness failure did not fail the installer'
    Assert-SelfTest -Condition (-not $global:DysonDeploymentTaskFixture.ContainsKey($newTaskName) -and
        $newTaskRollbackError -notmatch 'automatic rollback was incomplete') `
        -Message 'a post-task readiness failure did not remove the newly created task and complete rollback'
    Assert-SelfTest -Condition ((Get-ActiveVersionAt -DataRoot $taskRollbackNewData) -eq '1.0.0' -and
        -not (Test-Path -LiteralPath (Join-Path $taskRollbackNewRoot 'bootstrap')) -and
        -not (Test-Path -LiteralPath (Join-Path $taskRollbackNewData `
            'config\dyson-control.env')) -and
        [System.IO.File]::ReadAllText($newPointerPath, [System.Text.Encoding]::UTF8) -ceq
            $newPointerBefore -and
        (Get-Acl -LiteralPath $taskRollbackNewData -ErrorAction Stop).Sddl -eq $newAclBefore) `
        -Message 'the new-task failure did not restore the exact release/configuration/ACL preimage'
    Assert-NoInstallPartials -InstallRoot $taskRollbackNewRoot -DataRoot $taskRollbackNewData `
        -Message 'the new-task rollback left a partial deployment directory'

    $removalFailureTaskName = 'Dyson-Control-Plane-SelfTest-Removal-Failure'
    $global:DysonDeploymentTaskFixtureFailRemovalFor = $removalFailureTaskName
    $removalFailureObserved = $false
    $removalFailureError = $null
    try {
        & $installScript -SourcePath $payloadInstaller -Version '2.0.0' -NodeExecutable $nodeFixtures.node24 `
            -ExpectedArtifactPayloadSha256 (Get-FictionalPayloadSha256 -Root $payloadInstaller) `
            -InstallRoot $taskRemovalFailureRoot -DataRoot $taskRemovalFailureData `
            -ConfigurationSource $installerConfig -RegisterStartupTask -StartAfterInstall `
            -TaskName $removalFailureTaskName -ReadinessUri $closedReadinessUri -ReadinessTimeoutSeconds 1 `
            -SelfTestSkipAdministratorCheck -Confirm:$false | Out-Null
    }
    catch {
        $removalFailureObserved = $true
        $removalFailureError = $_.Exception.Message
    }
    finally { $global:DysonDeploymentTaskFixtureFailRemovalFor = $null }
    Assert-SelfTest -Condition ($removalFailureObserved -and
        $removalFailureError -match 'replacement-task-stop-remove' -and
        $removalFailureError -match 'protected-configuration-first-install-restore-blocked-by-task' -and
        $removalFailureError -match 'bootstrap-configuration-blocked' -and
        $removalFailureError -match 'previous-task-restore-blocked') `
        -Message ('a replacement-task removal failure did not report every blocked compensation phase: ' +
            $removalFailureError)
    Assert-SelfTest -Condition ($global:DysonDeploymentTaskFixture.ContainsKey($removalFailureTaskName) -and
        $global:DysonDeploymentTaskFixture[$removalFailureTaskName].State -eq 'Running' -and
        $global:DysonDeploymentTaskFixture[$removalFailureTaskName].Xml -match 'fixture replacement task') `
        -Message 'a replacement-task removal failure did not retain the running replacement task'
    Assert-SelfTest -Condition ((Get-ActiveVersionAt -DataRoot $taskRemovalFailureData) -eq '2.0.0' -and
        (Test-Path -LiteralPath (Join-Path $taskRemovalFailureRoot 'releases\2.0.0') -PathType Container) -and
        (Test-Path -LiteralPath (Join-Path $taskRemovalFailureRoot 'bootstrap\Start-DysonControl.ps1') -PathType Leaf) -and
        (Test-Path -LiteralPath (Join-Path $taskRemovalFailureData 'config\dyson-control.env') -PathType Leaf)) `
        -Message 'a replacement-task removal failure destructively rolled back release, bootstrap, or configuration state'
    Assert-NoInstallPartials -InstallRoot $taskRemovalFailureRoot -DataRoot $taskRemovalFailureData `
        -Message 'the fail-safe task removal path left a partial deployment directory'

    $wrapperPointerPath = Join-Path $wrapperLockData 'state\active-release.json'
    $wrapperPointerBefore = [System.IO.File]::ReadAllText($wrapperPointerPath, [System.Text.Encoding]::UTF8)
    $wrapperLock = Enter-DysonDeploymentLock -DataRoot $wrapperLockData -TimeoutSeconds 1
    $wrapperLockRejected = $false
    try {
        try {
            & $installScript -SourcePath $payloadInstaller -Version '2.0.0' -NodeExecutable $nodeFixtures.node24 `
                -ExpectedArtifactPayloadSha256 (Get-FictionalPayloadSha256 -Root $payloadInstaller) `
                -InstallRoot $wrapperLockRoot -DataRoot $wrapperLockData -ConfigurationSource $installerConfig `
                -LockTimeoutSeconds 1 -Confirm:$false | Out-Null
        }
        catch { $wrapperLockRejected = $_.Exception.Message -eq 'Another deployment operation still owns the deployment lock.' }
    }
    finally { $wrapperLock.Dispose() }
    Assert-SelfTest -Condition $wrapperLockRejected -Message 'the outer installer transaction did not reject a concurrent owner'
    Assert-SelfTest -Condition ([System.IO.File]::ReadAllText($wrapperPointerPath, [System.Text.Encoding]::UTF8) -ceq $wrapperPointerBefore -and
        (Get-ActiveVersionAt -DataRoot $wrapperLockData) -eq '1.0.0') `
        -Message 'the lock-rejected wrapper changed the active release pointer'
    Assert-SelfTest -Condition (-not (Test-Path -LiteralPath (Join-Path $wrapperLockRoot 'releases\2.0.0')) -and
        (Test-Path -LiteralPath $wrapperConfigurationPath -PathType Leaf) -and
        [Convert]::ToBase64String([System.IO.File]::ReadAllBytes($wrapperConfigurationPath)) -ceq
            [Convert]::ToBase64String($wrapperConfigurationBefore)) `
        -Message 'the lock-rejected wrapper staged a release or changed protected configuration'
    Assert-NoInstallPartials -InstallRoot $wrapperLockRoot -DataRoot $wrapperLockData `
        -Message 'the lock-rejected wrapper left a partial deployment directory'

    $uninstallLockPointerBefore = [System.IO.File]::ReadAllText($wrapperPointerPath, [System.Text.Encoding]::UTF8)
    $uninstallLockAuditPath = Join-Path $wrapperLockData 'audit\deployment.jsonl'
    $uninstallLockAuditLengthBefore = (Get-Item -LiteralPath $uninstallLockAuditPath -ErrorAction Stop).Length
    $uninstallLock = Enter-DysonDeploymentLock -DataRoot $wrapperLockData -TimeoutSeconds 1
    $uninstallLockRejected = $false
    try {
        try {
            & $uninstallScript -InstallRoot $wrapperLockRoot -DataRoot $wrapperLockData `
                -SkipTaskRemoval -LockTimeoutSeconds 1 -Confirm:$false | Out-Null
        }
        catch { $uninstallLockRejected = $_.Exception.Message -eq 'Another deployment operation still owns the deployment lock.' }
    }
    finally { $uninstallLock.Dispose() }
    Assert-SelfTest -Condition $uninstallLockRejected `
        -Message 'the uninstaller did not reject a concurrent deployment-lock owner'
    Assert-SelfTest -Condition ((Test-Path -LiteralPath $wrapperLockRoot -PathType Container) -and
        [System.IO.File]::ReadAllText($wrapperPointerPath, [System.Text.Encoding]::UTF8) -ceq $uninstallLockPointerBefore -and
        (Get-Item -LiteralPath $uninstallLockAuditPath -ErrorAction Stop).Length -eq $uninstallLockAuditLengthBefore) `
        -Message 'the lock-rejected uninstaller changed install, pointer, or audit state'

    $uninstallRollbackTaskName = 'Dyson-Control-Plane-SelfTest-Uninstall-Rollback'
    $uninstallRollbackTaskXml = '<Task><RegistrationInfo><Description>fictional uninstall rollback preimage</Description></RegistrationInfo></Task>'
    $global:DysonDeploymentTaskFixture[$uninstallRollbackTaskName] = [pscustomobject]@{
        FixtureTaskName = $uninstallRollbackTaskName
        TaskPath = '\'
        State = 'Running'
        Xml = $uninstallRollbackTaskXml
        Principal = [pscustomobject]@{ UserId = 'fictional-uninstall-rollback'; LogonType = 'Interactive'; RunLevel = 'Limited' }
        Actions = @()
        Settings = [pscustomobject]@{ Enabled = $true }
    }
    $uninstallRollbackPointerPath = Join-Path $wrapperLockData 'state\active-release.json'
    $uninstallRollbackPointerBefore = [System.IO.File]::ReadAllText(
        $uninstallRollbackPointerPath,
        [System.Text.Encoding]::UTF8
    )

    $unregisterFailureStopCount = $global:DysonDeploymentTaskFixtureStopCalls.Count
    $unregisterFailureStartCount = $global:DysonDeploymentTaskFixtureStartCalls.Count
    $unregisterFailureUnregisterCount = $global:DysonDeploymentTaskFixtureUnregisterCalls.Count
    $global:DysonDeploymentTaskFixtureFailUnregisterOnceFor = $uninstallRollbackTaskName
    $unregisterFailureObserved = $false
    try {
        & $uninstallScript -InstallRoot $wrapperLockRoot -DataRoot $wrapperLockData `
            -TaskName $uninstallRollbackTaskName -SelfTestSkipAdministratorCheck -Confirm:$false | Out-Null
    }
    catch { $unregisterFailureObserved = $_.Exception.Message -eq 'fixture refused the first unregister attempt' }
    finally { $global:DysonDeploymentTaskFixtureFailUnregisterOnceFor = $null }
    Assert-SelfTest -Condition ($unregisterFailureObserved -and
        $global:DysonDeploymentTaskFixture.ContainsKey($uninstallRollbackTaskName) -and
        $global:DysonDeploymentTaskFixture[$uninstallRollbackTaskName].TaskPath -ceq '\' -and
        $global:DysonDeploymentTaskFixture[$uninstallRollbackTaskName].Xml -ceq $uninstallRollbackTaskXml -and
        $global:DysonDeploymentTaskFixture[$uninstallRollbackTaskName].State -eq 'Running') `
        -Message 'uninstall did not restore the root task XML and Running state after Stop succeeded and Unregister failed'
    Assert-SelfTest -Condition ($global:DysonDeploymentTaskFixtureStopCalls.Count -eq ($unregisterFailureStopCount + 1) -and
        $global:DysonDeploymentTaskFixtureStartCalls.Count -eq ($unregisterFailureStartCount + 1) -and
        $global:DysonDeploymentTaskFixtureUnregisterCalls.Count -eq ($unregisterFailureUnregisterCount + 2)) `
        -Message 'the unregister-failure fixture did not exercise stop, failed unregister, removal retry, and restart'
    Assert-SelfTest -Condition ((Test-Path -LiteralPath $wrapperLockRoot -PathType Container) -and
        [System.IO.File]::ReadAllText($uninstallRollbackPointerPath, [System.Text.Encoding]::UTF8) -ceq $uninstallRollbackPointerBefore -and
        (Get-ActiveVersionAt -DataRoot $wrapperLockData) -eq '1.0.0') `
        -Message 'an unregister failure changed the install root or active release pointer'

    $uninstallReleaseBackupBlocker = Join-Path $wrapperLockData 'snapshots\uninstall-releases'
    [System.IO.File]::WriteAllText(
        $uninstallReleaseBackupBlocker,
        'fictional file that blocks creation of the uninstall release-backup directory',
        [System.Text.UTF8Encoding]::new($false)
    )
    $postRemovalFailureStopCount = $global:DysonDeploymentTaskFixtureStopCalls.Count
    $postRemovalFailureStartCount = $global:DysonDeploymentTaskFixtureStartCalls.Count
    $postRemovalFailureUnregisterCount = $global:DysonDeploymentTaskFixtureUnregisterCalls.Count
    $postRemovalFailureObserved = $false
    try {
        & $uninstallScript -InstallRoot $wrapperLockRoot -DataRoot $wrapperLockData `
            -TaskName $uninstallRollbackTaskName -SelfTestSkipAdministratorCheck -Confirm:$false | Out-Null
    }
    catch { $postRemovalFailureObserved = $true }
    Assert-SelfTest -Condition ($postRemovalFailureObserved -and
        $global:DysonDeploymentTaskFixture.ContainsKey($uninstallRollbackTaskName) -and
        $global:DysonDeploymentTaskFixture[$uninstallRollbackTaskName].TaskPath -ceq '\' -and
        $global:DysonDeploymentTaskFixture[$uninstallRollbackTaskName].Xml -ceq $uninstallRollbackTaskXml -and
        $global:DysonDeploymentTaskFixture[$uninstallRollbackTaskName].State -eq 'Running') `
        -Message 'uninstall did not restore the root task XML and Running state after a post-removal failure'
    Assert-SelfTest -Condition ($global:DysonDeploymentTaskFixtureStopCalls.Count -eq ($postRemovalFailureStopCount + 1) -and
        $global:DysonDeploymentTaskFixtureStartCalls.Count -eq ($postRemovalFailureStartCount + 1) -and
        $global:DysonDeploymentTaskFixtureUnregisterCalls.Count -eq ($postRemovalFailureUnregisterCount + 1)) `
        -Message 'the post-removal failure fixture did not delete and then restore the root task'
    Assert-SelfTest -Condition ((Test-Path -LiteralPath $wrapperLockRoot -PathType Container) -and
        [System.IO.File]::ReadAllText($uninstallRollbackPointerPath, [System.Text.Encoding]::UTF8) -ceq $uninstallRollbackPointerBefore -and
        (Get-ActiveVersionAt -DataRoot $wrapperLockData) -eq '1.0.0' -and
        (Test-Path -LiteralPath $uninstallReleaseBackupBlocker -PathType Leaf)) `
        -Message 'a post-task-removal uninstall failure changed deployment state or consumed its failure fixture'

    $uninstallSuccessTaskName = 'Dyson-Control-Plane-SelfTest-Uninstall-Success'
    $uninstallSuccessTaskXml = '<Task><RegistrationInfo><Description>fictional successful uninstall task</Description></RegistrationInfo></Task>'
    $global:DysonDeploymentTaskFixture[$uninstallSuccessTaskName] = [pscustomobject]@{
        FixtureTaskName = $uninstallSuccessTaskName
        TaskPath = '\'
        State = 'Running'
        Xml = $uninstallSuccessTaskXml
        Principal = [pscustomobject]@{ UserId = 'fictional-uninstall-success'; LogonType = 'Interactive'; RunLevel = 'Limited' }
        Actions = @()
        Settings = [pscustomobject]@{ Enabled = $true }
    }
    $uninstallPersistentDataBefore = [System.IO.File]::ReadAllText(
        $launcherResultPath,
        [System.Text.Encoding]::UTF8
    )
    $uninstallActivePointerBefore = [System.IO.File]::ReadAllText(
        (Join-Path $installerData 'state\active-release.json'),
        [System.Text.Encoding]::UTF8
    )
    $uninstallOutput = & $uninstallScript -InstallRoot $installerRoot -DataRoot $installerData `
        -TaskName $uninstallSuccessTaskName -SelfTestSkipAdministratorCheck -Confirm:$false
    $uninstallResult = ($uninstallOutput | Out-String).Trim() | ConvertFrom-Json
    Assert-SelfTest -Condition ($uninstallResult.state -eq 'uninstalled' -and [bool]$uninstallResult.taskRemoved -and
        -not $global:DysonDeploymentTaskFixture.ContainsKey($uninstallSuccessTaskName)) `
        -Message 'the reusable uninstaller did not remove its fixed root task'
    Assert-SelfTest -Condition (-not (Test-Path -LiteralPath $installerRoot)) -Message 'uninstall left the active Program Files layout in place'
    Assert-SelfTest -Condition ((Test-Path -LiteralPath $installerData -PathType Container) -and
        (Test-Path -LiteralPath $launcherResultPath -PathType Leaf) -and
        [System.IO.File]::ReadAllText($launcherResultPath, [System.Text.Encoding]::UTF8) -ceq $uninstallPersistentDataBefore) `
        -Message 'uninstall did not preserve persistent user data byte-for-byte'
    $recoverableReleaseBackup = [string]$uninstallResult.recoverableReleaseBackup
    $recoverableReleaseManifest = Join-Path $recoverableReleaseBackup `
        'releases\2.0.0\release-manifest.json'
    $recoverableBootstrap = Join-Path $recoverableReleaseBackup `
        'bootstrap\Start-DysonControl.ps1'
    Assert-SelfTest -Condition (
        [System.IO.Directory]::Exists((ConvertTo-DysonDeploymentSelfTestExtendedPath `
            -Path $recoverableReleaseBackup)) -and
        [System.IO.File]::Exists((ConvertTo-DysonDeploymentSelfTestExtendedPath `
            -Path $recoverableReleaseManifest)) -and
        [System.IO.File]::Exists((ConvertTo-DysonDeploymentSelfTestExtendedPath `
            -Path $recoverableBootstrap))
    ) `
        -Message 'uninstall did not retain a structurally recoverable release backup'
    Assert-SelfTest -Condition (-not (Test-Path -LiteralPath (Join-Path $installerData 'state\active-release.json'))) -Message 'uninstall left a stale active-release pointer'
    Assert-SelfTest -Condition ((Test-Path -LiteralPath ([string]$uninstallResult.activePointerBackup) -PathType Leaf) -and
        [System.IO.File]::ReadAllText(
            [string]$uninstallResult.activePointerBackup,
            [System.Text.Encoding]::UTF8
        ) -ceq $uninstallActivePointerBefore) -Message 'uninstall did not retain the exact active pointer for rollback'
    Assert-SelfTest -Condition (Test-Path -LiteralPath ([string]$uninstallResult.taskDefinitionBackup) -PathType Leaf) `
        -Message 'uninstall did not retain the fixed root task definition for recovery'
    Assert-SelfTest -Condition ([System.IO.File]::ReadAllText(
        [string]$uninstallResult.taskDefinitionBackup,
        [System.Text.Encoding]::UTF8
    ) -ceq $uninstallSuccessTaskXml) -Message 'the recoverable task snapshot does not match the removed root task XML'

    [ordered]@{
        protocol = 'DYSON_CONTROL_DEPLOYMENT_SELFTEST_V1'
        state = 'passed'
        stagedIdempotently = $true
        immutableVersionConflictRejected = $true
        artifactManifestTamperRejected = $true
        artifactManifestMissingFileRejected = $true
        artifactManifestExtraFileRejected = $true
        artifactManifestVersionMismatchRejected = $true
        artifactNodeMinimumMismatchRejected = $true
        artifactProvenanceWasMandatoryAndExact = $true
        sourceArtifactVerifierWasNeverExecuted = $true
        stageUpgradeInstallSourceTrustBoundaryValidated = $true
        sourceArtifactWhatIfWasNonExecutingAndNonMutating = $true
        installerRejectedInvalidArtifactWithoutMutation = $true
        exclusiveDeploymentLockValidated = $true
        deploymentLockFailureClassificationValidated = $true
        activated = '1.0.0'
        upgraded = '1.1.0'
        failedUpgradeRolledBack = $true
        explicitRollback = '1.0.0'
        configSnapshotRestored = $true
        persistentDataPreserved = $true
        whatIfWasNonMutating = $true
        auditRecordCount = $auditRecords.Count
        reusableInstallValidated = $true
        configurationAToBReplacementValidated = $true
        configurationBToCReadinessRollbackRestoredB = $true
        configurationRollbackProtectedPostimageSnapshotValidated = $true
        persistentCutoverDataReady = $true
        cutoverHostScriptsInstalled = $true
        cutoverBrokerScriptsInstalled = $true
        lifecycleBrokerScriptsInstalled = $true
        lifecycleBrokerTamperMissingExtraRejected = $true
        lifecycleBrokerParametersRejectedWithoutSwitch = $true
        lifecycleBrokerEnvironmentMismatchRejectedBeforeMutation = $true
        brokerUpgradeIntentMatrixRejectedBeforeMutation = $true
        brokerPreflightValidatedBeforeDataRootCreation = $true
        lifecycleBrokerWhatIfOrderAndNonMutationValidated = $true
        lifecycleBrokerFirstInstallFailureCompensated = $true
        lifecycleBrokerReadinessFailureCompensated = $true
        lifecycleBrokerBoundToActivatedImmutableRelease = $true
        lifecycleBrokerCrossReleaseRollbackWasByteExact = $true
        lifecycleBrokerShadowRollbackRestoredActualProfileFileAcl = $true
        cutoverBrokerParentRestoredProfileAndBindingFileAcls = $true
        brokerUninstallCompensationPreservedLegacyDirectoryAclAndHistory = $true
        lifecycleBrokerPreparedDisabledUpgradeRollbackUninstallValidated = $true
        lifecycleBrokerPreparedMixedAndDriftRejected = $true
        lifecycleBrokerSameReleaseWasByteExact = $true
        lifecycleBrokerDirectDeploymentBypassRejected = $true
        lifecycleBrokerUninstallPendingAndDriftRejected = $true
        lifecycleBrokerUninstallFailureRestoredPreimage = $true
        lifecycleBrokerUninstallPreservedHistoryAndAudit = $true
        lifecycleBrokerRemoveDataRejectedHistory = $true
        cutoverBrokerDefaultWasNonInstalling = $true
        cutoverBrokerNativeTaskCollectionsValidated = $true
        brokerQuiescencePreservedWorkerAndWaitedForIdle = $true
        brokerQuiescenceRejectedActiveHostMutationWithoutStoppingPanel = $true
        cutoverBrokerDisabledConfigurationRejectedBeforeMutation = $true
        cutoverBrokerWhatIfWasNonMutating = $true
        cutoverBrokerTaskInstalledWithProtectedChannelReceipt = $true
        cutoverBrokerBoundToActivatedImmutableRelease = $true
        cutoverBrokerCrossReleaseUpgradeTransactional = $true
        cutoverBrokerUpgradeFaultsRolledBack = $true
        cutoverBrokerInstallPendingAndTaskDriftRejectedBeforeMutation = $true
        cutoverBrokerRollbackUsedCapturedOldArguments = $true
        cutoverBrokerSameReleaseIdempotent = $true
        cutoverBrokerReusedPreimageByteAclTaskExact = $true
        cutoverBrokerFailureDidNotStartControlPlane = $true
        cutoverBrokerUninstallWhatIfWasNonMutating = $true
        cutoverBrokerUninstallPendingAndDriftRejected = $true
        cutoverBrokerUninstallFailureRestoredPreimage = $true
        cutoverBrokerUninstallDurableBytesAclPreserved = $true
        cutoverBrokerUninstallRemovedFixedStateAndPreservedEvidence = $true
        readOnlyValidationPassed = $true
        administratorTaskWhatIfValidated = $true
        fixedLauncherLoopbackValidated = $true
        node24RuntimeAccepted = $true
        node23RuntimeRejected = $true
        fakeAndAbnormalNodeOutputsRejected = $true
        nodeProbeTimeoutRejected = $true
        nodePreviewWasNonExecuting = $true
        nodeRejectionWasNonMutating = $true
        taskReadinessFailureFailedClosedAfterProtectedConfig = $true
        taskReadinessFailureRemovedReplacementTask = $true
        taskReadinessFailureRetainedCoherentReleaseConfig = $true
        ambiguousTaskIdentityRejectedBeforeMutation = $true
        nonRootTaskIdentityRejectedBeforeMutation = $true
        schedulerQueryFailureRejectedBeforeMutation = $true
        restartRejectedNonRootWithoutMutation = $true
        restartRejectedAmbiguousWithoutMutation = $true
        directTaskFailureRestoredTaskAndAcl = $true
        directTaskFailurePreservedNodeRuntime = $true
        nodeRuntimeEvidenceNotInjectedAsDysonEnvironment = $true
        taskRemovalFailureBlockedDestructiveRollback = $true
        outerInstallLockValidated = $true
        uninstallLockValidated = $true
        failedInstallLeftNoPartialOrActiveDrift = $true
        successfulInstallReceiptWasRedacted = $true
        uninstallUnregisterFailureRestoredTask = $true
        uninstallPostRemovalFailureRestoredTask = $true
        uninstallRemovedRootTaskWithRecoveryAssets = $true
        uninstallPreservedData = $true
        uninstallWasRecoverable = $true
        samePrefixOrdinaryLayoutRejected = $true
        customRootPortabilityPreserved = $true
        deploymentIdentityUninstallIntegrityValidated = $true
        finalCleanupLongPathValidated = [bool]$finalCleanupSelfTest.longPathRemoved
        finalCleanupScopeValidated = [bool](
            $finalCleanupSelfTest.directChildAndExactNameEnforced -and
            $finalCleanupSelfTest.rootTypeAndReparseEnforced -and
            $finalCleanupSelfTest.childReparseTargetPreserved
        )
    } | ConvertTo-Json -Depth 5 -Compress
}
finally {
    if ($taskFixtureEnabled) { Disable-DysonTaskSchedulerFixture }
    foreach ($commandName in @(
        'Install-DysonControl.ps1', 'Install-DysonControlTask.ps1',
        'Invoke-DysonControlDeployment.ps1', 'Test-DysonControlDeployment.ps1',
        'Uninstall-DysonControl.ps1', 'Start-DysonControl.ps1'
    )) {
        $PSDefaultParameterValues.Remove($commandName + ':RuntimeRoot')
        $PSDefaultParameterValues.Remove($commandName + ':NodeExecutable')
        $PSDefaultParameterValues.Remove($commandName + ':ExpectedNodeSha256')
        $PSDefaultParameterValues.Remove($commandName + ':SelfTestConfigurationShadowRoot')
    }
    $PSDefaultParameterValues.Remove('Install-DysonControl.ps1:SelfTestSkipAdministratorCheck')
    $PSDefaultParameterValues.Remove('Install-DysonControlTask.ps1:SelfTestSkipAdministratorCheck')
    $PSDefaultParameterValues.Remove('Uninstall-DysonControl.ps1:SelfTestSkipAdministratorCheck')
    Remove-Item Env:DYSON_DEPLOYMENT_ALLOW_SELFTEST_TASKS -ErrorAction SilentlyContinue
    Remove-Item Env:DYSON_DEPLOYMENT_SELFTEST_ROOT_IDENTITY -ErrorAction SilentlyContinue
    Remove-Variable -Name DysonDeploymentAuthorizedSelfTestRoots -Scope Global `
        -ErrorAction SilentlyContinue
    if ($readinessJob) {
        [System.IO.File]::WriteAllText($readinessStopPath, 'stop')
        if ($readinessUri) {
            try { Invoke-WebRequest -Uri $readinessUri -UseBasicParsing -TimeoutSec 1 -ErrorAction SilentlyContinue | Out-Null } catch { }
        }
        Wait-Job -Job $readinessJob -Timeout 5 -ErrorAction SilentlyContinue | Out-Null
        if ($readinessJob.State -eq 'Running') { Stop-Job -Job $readinessJob -ErrorAction SilentlyContinue }
        Remove-Job -Job $readinessJob -Force -ErrorAction SilentlyContinue
    }
    if ($brokerReadinessJob) {
        [IO.File]::WriteAllText($brokerReadinessStopPath, 'stop')
        if ($brokerReadinessUri) {
            try {
                Invoke-WebRequest -Uri $brokerReadinessUri -UseBasicParsing -TimeoutSec 1 `
                    -ErrorAction SilentlyContinue | Out-Null
            }
            catch { }
        }
        Wait-Job -Job $brokerReadinessJob -Timeout 5 -ErrorAction SilentlyContinue | Out-Null
        if ($brokerReadinessJob.State -eq 'Running') {
            Stop-Job -Job $brokerReadinessJob -ErrorAction SilentlyContinue
        }
        Remove-Job -Job $brokerReadinessJob -Force -ErrorAction SilentlyContinue
    }
    [void](Remove-DysonControlDeploymentSelfTestRoot `
        -Root $testRoot -TemporaryBase $temporaryBase)
}
