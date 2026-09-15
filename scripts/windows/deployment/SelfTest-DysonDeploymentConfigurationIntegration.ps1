[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
. (Join-Path $PSScriptRoot 'DysonDeployment.Common.ps1')
. (Join-Path $PSScriptRoot 'DysonDeployment.Configuration.ps1')

function Assert-ConfigurationIntegrationFixture {
    param([Parameter(Mandatory)][bool]$Condition, [Parameter(Mandatory)][string]$Message)
    if (-not $Condition) { throw "DEPLOYMENT_CONFIGURATION_INTEGRATION_SELFTEST_FAILED: $Message" }
}

function Read-FixtureSource {
    param([Parameter(Mandatory)][string]$RelativePath)
    return [System.IO.File]::ReadAllText(
        (Join-Path $PSScriptRoot $RelativePath),
        [System.Text.UTF8Encoding]::new($false, $true)
    )
}

function Assert-OrderedMarkers {
    param(
        [Parameter(Mandatory)][string]$Source,
        [Parameter(Mandatory)][string[]]$Markers,
        [Parameter(Mandatory)][string]$Name
    )
    $previous = -1
    foreach ($marker in $Markers) {
        $next = $Source.IndexOf($marker, $previous + 1, [System.StringComparison]::Ordinal)
        Assert-ConfigurationIntegrationFixture ($next -gt $previous) `
            "$Name did not retain the required order at marker: $marker"
        $previous = $next
    }
}

function New-QualifiedClientStorageFixtureConfiguration {
    param(
        [Parameter(Mandatory)][string]$DataRoot,
        [string]$Authority = 'example.com'
    )

    $base = Join-Path $DataRoot 'data\qualified-client'
    return @{
        DYSON_PROVIDER = 'windows'
        DYSON_QUALIFIED_CLIENT_PROFILE_ENABLED = 'true'
        DYSON_CLIENT_QUALIFICATION_EVIDENCE_ROOT = Join-Path $base 'evidence'
        DYSON_CLIENT_QUALIFICATION_BUILD_HARVEST_ROOT_A = Join-Path $base 'build-harvest-a'
        DYSON_CLIENT_QUALIFICATION_BUILD_HARVEST_ROOT_B = Join-Path $base 'build-harvest-b'
        DYSON_CLIENT_QUALIFICATION_KEY_RING_ROOT = Join-Path $base 'key-ring'
        DYSON_CLIENT_QUALIFICATION_REPLAY_ROOT = Join-Path $base 'replay'
        DYSON_QUALIFIED_CLIENT_ISSUE_ROOT = Join-Path $base 'issued'
        DYSON_CLIENT_QUALIFICATION_AUTHORITY = $Authority
    }
}

$temporaryBase = [System.IO.Path]::GetFullPath([System.IO.Path]::GetTempPath()).TrimEnd('\', '/')
$testRoot = Join-Path $temporaryBase ('dyson-control-deployment-selftest-' + [guid]::NewGuid().ToString('N'))
$dataRoot = Join-Path $testRoot 'program-data\DysonControl'
$installRoot = Join-Path $testRoot 'program-files\DysonControl'
$previousSelfTestGate = [System.Environment]::GetEnvironmentVariable(
    'DYSON_DEPLOYMENT_ALLOW_SELFTEST_TASKS', 'Process'
)

$testFailure = $null
try {
    [System.IO.Directory]::CreateDirectory($dataRoot) | Out-Null
    [System.IO.Directory]::CreateDirectory($installRoot) | Out-Null
    [System.Environment]::SetEnvironmentVariable(
        'DYSON_DEPLOYMENT_ALLOW_SELFTEST_TASKS', 'true', 'Process'
    )
    Assert-DysonDeploymentTaskSelfTestScope -InstallRoot $installRoot -DataRoot $dataRoot
    Set-DysonDeploymentProtectedDataRootAcl -DataRoot $dataRoot `
        -ServiceAccount 'NT AUTHORITY\LOCAL SERVICE' -AllowSelfTestAdministrator

    $acl = [System.IO.Directory]::GetAccessControl(
        $dataRoot,
        [System.Security.AccessControl.AccessControlSections]'Owner, Access'
    )
    Assert-ConfigurationIntegrationFixture ([bool]$acl.AreAccessRulesProtected) `
        'DataRoot did not receive a protected DACL'
    $serviceSid = 'S-1-5-19'
    $serviceRules = @($acl.GetAccessRules($true, $false,
        [System.Security.Principal.SecurityIdentifier]) | Where-Object {
            [string]$_.IdentityReference.Value -ceq $serviceSid -and
            $_.AccessControlType -eq [System.Security.AccessControl.AccessControlType]::Allow
        })
    $rootRules = @($serviceRules | Where-Object {
        $_.InheritanceFlags -eq [System.Security.AccessControl.InheritanceFlags]::None -and
        $_.PropagationFlags -eq [System.Security.AccessControl.PropagationFlags]::None
    })
    $inheritOnlyRules = @($serviceRules | Where-Object {
        ($_.InheritanceFlags -band [System.Security.AccessControl.InheritanceFlags]::ContainerInherit) -and
        ($_.InheritanceFlags -band [System.Security.AccessControl.InheritanceFlags]::ObjectInherit) -and
        ($_.PropagationFlags -band [System.Security.AccessControl.PropagationFlags]::InheritOnly)
    })
    Assert-ConfigurationIntegrationFixture ($rootRules.Count -eq 1 -and
        ($rootRules[0].FileSystemRights -band [System.Security.AccessControl.FileSystemRights]::ReadAndExecute) -and
        -not ($rootRules[0].FileSystemRights -band [System.Security.AccessControl.FileSystemRights]::Delete) -and
        -not ($rootRules[0].FileSystemRights -band [System.Security.AccessControl.FileSystemRights]::DeleteSubdirectoriesAndFiles) -and
        -not ($rootRules[0].FileSystemRights -band [System.Security.AccessControl.FileSystemRights]::ChangePermissions) -and
        -not ($rootRules[0].FileSystemRights -band [System.Security.AccessControl.FileSystemRights]::TakeOwnership)) `
        'Local Service received a destructive or non-RX DataRoot root rule'
    Assert-ConfigurationIntegrationFixture ($inheritOnlyRules.Count -eq 1 -and
        ($inheritOnlyRules[0].FileSystemRights -band [System.Security.AccessControl.FileSystemRights]::Modify)) `
        'ordinary data descendants did not receive the inherit-only Local Service Modify rule'
    $ordinaryDataDirectories = @(
        (Join-Path $dataRoot 'data'),
        (Join-Path $dataRoot 'logs')
    )
    foreach ($ordinaryDirectory in $ordinaryDataDirectories) {
        [void][System.IO.Directory]::CreateDirectory($ordinaryDirectory)
        $ordinaryAcl = [System.IO.Directory]::GetAccessControl(
            $ordinaryDirectory,
            [System.Security.AccessControl.AccessControlSections]'Owner, Access'
        )
        $ordinaryServiceRules = @($ordinaryAcl.GetAccessRules(
            $true, $true, [System.Security.Principal.SecurityIdentifier]
        ) | Where-Object {
            [string]$_.IdentityReference.Value -ceq $serviceSid -and
            $_.AccessControlType -eq [System.Security.AccessControl.AccessControlType]::Allow
        })
        $ordinaryRights = [int64]0
        foreach ($rule in $ordinaryServiceRules) {
            $ordinaryRights = $ordinaryRights -bor [int64]$rule.FileSystemRights
        }
        Assert-ConfigurationIntegrationFixture (
            -not [bool]$ordinaryAcl.AreAccessRulesProtected -and
            ($ordinaryRights -band [int64][System.Security.AccessControl.FileSystemRights]::Modify) -eq
                [int64][System.Security.AccessControl.FileSystemRights]::Modify -and
            ($ordinaryRights -band [int64][System.Security.AccessControl.FileSystemRights]::ChangePermissions) -eq 0 -and
            ($ordinaryRights -band [int64][System.Security.AccessControl.FileSystemRights]::TakeOwnership) -eq 0
        ) 'an ordinary DataRoot descendant did not inherit the intended Local Service Modify boundary'
    }

    $environmentContractPath = Join-Path $PSScriptRoot `
        '..\configuration\dyson-control.environment-contract.json'
    $environmentContract = [System.IO.File]::ReadAllText(
        $environmentContractPath,
        [System.Text.UTF8Encoding]::new($false, $true)
    ) | ConvertFrom-Json -ErrorAction Stop
    $qualifiedClientEnvironmentNames = @(
        'DYSON_QUALIFIED_CLIENT_PROFILE_ENABLED',
        'DYSON_CLIENT_QUALIFICATION_EVIDENCE_ROOT',
        'DYSON_CLIENT_QUALIFICATION_BUILD_HARVEST_ROOT_A',
        'DYSON_CLIENT_QUALIFICATION_BUILD_HARVEST_ROOT_B',
        'DYSON_CLIENT_QUALIFICATION_KEY_RING_ROOT',
        'DYSON_CLIENT_QUALIFICATION_REPLAY_ROOT',
        'DYSON_QUALIFIED_CLIENT_ISSUE_ROOT',
        'DYSON_CLIENT_QUALIFICATION_AUTHORITY'
    )
    foreach ($name in $qualifiedClientEnvironmentNames) {
        Assert-ConfigurationIntegrationFixture ([string]$name -cin @($environmentContract.dysonNames)) `
            "the protected environment contract does not admit $name"
    }

    $qualifiedDisabledPlan = Get-DysonQualifiedClientStoragePlan `
        -Configured @{ DYSON_QUALIFIED_CLIENT_PROFILE_ENABLED = 'false' } `
        -DataRoot $dataRoot
    Assert-ConfigurationIntegrationFixture (
        -not [bool]$qualifiedDisabledPlan.configured -and
        -not [bool]$qualifiedDisabledPlan.enabled -and
        @($qualifiedDisabledPlan.entries).Count -eq 0
    ) 'the disabled qualified-client gate without bindings did not remain a storage no-op'
    $qualifiedBoundDisabledConfiguration = New-QualifiedClientStorageFixtureConfiguration `
        -DataRoot $dataRoot
    $qualifiedBoundDisabledConfiguration['DYSON_QUALIFIED_CLIENT_PROFILE_ENABLED'] = 'false'
    $qualifiedBoundDisabledPlan = Get-DysonQualifiedClientStoragePlan `
        -Configured $qualifiedBoundDisabledConfiguration -DataRoot $dataRoot
    Assert-ConfigurationIntegrationFixture (
        [bool]$qualifiedBoundDisabledPlan.configured -and
        -not [bool]$qualifiedBoundDisabledPlan.enabled -and
        @($qualifiedBoundDisabledPlan.entries).Count -eq 14
    ) 'complete disabled bindings did not retain a pre-provisionable fixed storage plan'

    $qualifiedConfiguration = New-QualifiedClientStorageFixtureConfiguration -DataRoot $dataRoot
    $qualifiedPlan = Get-DysonQualifiedClientStoragePlan `
        -Configured $qualifiedConfiguration -DataRoot $dataRoot
    $qualifiedPreimage = Get-DysonQualifiedClientStoragePreimage `
        -Plan $qualifiedPlan -AllowSelfTestAdministrator
    $qualifiedApplied = $false
    try {
        $qualifiedInstall = Install-DysonQualifiedClientStorage `
            -Plan $qualifiedPlan -Preimage $qualifiedPreimage -AllowSelfTestAdministrator
        $qualifiedApplied = $true
        $qualifiedStatus = Test-DysonQualifiedClientStorage `
            -Plan $qualifiedPlan -AllowSelfTestAdministrator
        Assert-ConfigurationIntegrationFixture (
            [bool]$qualifiedInstall.ready -and [bool]$qualifiedStatus.ready -and
            [bool]$qualifiedStatus.enabled -and [int]$qualifiedStatus.directoryCount -eq 14 -and
            [string]$qualifiedStatus.layoutSha256 -cmatch '^[0-9a-f]{64}$'
        ) 'the qualified-client storage install did not produce the fixed ready layout'
        $qualifiedUpgradePreimage = Get-DysonQualifiedClientStoragePreimage `
            -Plan $qualifiedPlan -AllowSelfTestAdministrator
        $qualifiedUpgrade = Install-DysonQualifiedClientStorage `
            -Plan $qualifiedPlan -Preimage $qualifiedUpgradePreimage -AllowSelfTestAdministrator
        Assert-ConfigurationIntegrationFixture (
            [bool]$qualifiedUpgrade.ready -and
            [string]$qualifiedUpgrade.layoutSha256 -ceq [string]$qualifiedStatus.layoutSha256
        ) 'an identical qualified-client storage upgrade was not idempotent'
    }
    finally {
        if ($qualifiedApplied) {
            [void](Restore-DysonQualifiedClientStoragePreimage `
                -Plan $qualifiedPlan -Preimage $qualifiedPreimage)
        }
    }
    Assert-ConfigurationIntegrationFixture (-not (Test-Path -LiteralPath `
        (Join-Path $dataRoot 'data\qualified-client'))) `
        'qualified-client storage rollback did not remove its newly-created layout'

    # Explicitly deny WRITE_OWNER while retaining DACL management. Neither
    # removal preparation nor unchanged-owner restore may request that right.
    $accessOnlyRoot = Join-Path $testRoot 'acl-access-only'
    [void][IO.Directory]::CreateDirectory($accessOnlyRoot)
    $accessOnlySid = [Security.Principal.WindowsIdentity]::GetCurrent().User
    $denyOwner = [Security.AccessControl.FileSystemAccessRule]::new($accessOnlySid,
        [Security.AccessControl.FileSystemRights]::TakeOwnership,
        [Security.AccessControl.AccessControlType]::Deny)
    $accessOnlyAcl = Microsoft.PowerShell.Security\Get-Acl -LiteralPath $accessOnlyRoot
    [void]$accessOnlyAcl.AddAccessRule($denyOwner)
    Set-DysonQualifiedClientDirectorySecurity -Path $accessOnlyRoot -Security $accessOnlyAcl
    $accessOnlySddl = (Microsoft.PowerShell.Security\Get-Acl -LiteralPath $accessOnlyRoot).Sddl
    Set-DysonQualifiedClientStorageRemovalAcl -Path $accessOnlyRoot
    $accessOnlyAcl = Microsoft.PowerShell.Security\Get-Acl -LiteralPath $accessOnlyRoot
    [void]$accessOnlyAcl.AddAccessRule($denyOwner)
    Set-DysonQualifiedClientDirectorySecurity -Path $accessOnlyRoot -Security $accessOnlyAcl
    Restore-DysonDeploymentDirectorySecurityPreimage -Path $accessOnlyRoot -Sddl $accessOnlySddl
    Assert-ConfigurationIntegrationFixture ((Microsoft.PowerShell.Security\Get-Acl -LiteralPath $accessOnlyRoot).Sddl -ceq $accessOnlySddl) 'DACL-only rollback did not preserve the exact ownership preimage'

    $adoptionDataRoot = Join-Path $testRoot 'program-data\QualifiedClientAdoption'
    $adoptionContainer = Join-Path $adoptionDataRoot 'data\qualified-client'
    [void][System.IO.Directory]::CreateDirectory($adoptionContainer)
    $adoptionSddl = (Microsoft.PowerShell.Security\Get-Acl `
        -LiteralPath $adoptionContainer -ErrorAction Stop).Sddl
    $adoptionPlan = Get-DysonQualifiedClientStoragePlan `
        -Configured (New-QualifiedClientStorageFixtureConfiguration -DataRoot $adoptionDataRoot) `
        -DataRoot $adoptionDataRoot
    $adoptionPreimage = Get-DysonQualifiedClientStoragePreimage `
        -Plan $adoptionPlan -AllowSelfTestAdministrator
    $adoptionInstall = Install-DysonQualifiedClientStorage `
        -Plan $adoptionPlan -Preimage $adoptionPreimage -AllowSelfTestAdministrator
    Assert-ConfigurationIntegrationFixture ([bool]$adoptionInstall.ready) `
        'an empty pre-existing qualified-client container could not be adopted transactionally'
    [void](Restore-DysonQualifiedClientStoragePreimage `
        -Plan $adoptionPlan -Preimage $adoptionPreimage)
    Assert-ConfigurationIntegrationFixture (
        (Test-Path -LiteralPath $adoptionContainer -PathType Container) -and
        (Microsoft.PowerShell.Security\Get-Acl `
            -LiteralPath $adoptionContainer -ErrorAction Stop).Sddl -ceq $adoptionSddl -and
        @(Get-ChildItem -LiteralPath $adoptionContainer -Force -ErrorAction Stop).Count -eq 0
    ) 'qualified-client rollback did not restore an adopted empty container exactly'

    # Exercise legacy and protected descriptors explicitly; the TEMP parent's
    # inheritance model varies between CI, desktop Windows, and the server.
    foreach ($aclCase in @(
        @{ protected = $false; autoInherited = $false },
        @{ protected = $true; autoInherited = $false },
        @{ protected = $false; autoInherited = $true },
        @{ protected = $true; autoInherited = $true }
    )) {
        $protected = [bool]$aclCase.protected
        $aclFixture = Join-Path $testRoot ('acl-preimage-' + $protected + '-' + $aclCase.autoInherited)
        [void][System.IO.Directory]::CreateDirectory($aclFixture)
        $raw = [System.Security.AccessControl.RawSecurityDescriptor]::new(
            (Microsoft.PowerShell.Security\Get-Acl -LiteralPath $aclFixture).Sddl)
        $flags = $raw.ControlFlags -band (-bnot (
            [System.Security.AccessControl.ControlFlags]::DiscretionaryAclAutoInherited -bor
            [System.Security.AccessControl.ControlFlags]::DiscretionaryAclAutoInheritRequired -bor
            [System.Security.AccessControl.ControlFlags]::DiscretionaryAclProtected))
        if ($aclCase.autoInherited) { $flags = $flags -bor [System.Security.AccessControl.ControlFlags]::DiscretionaryAclAutoInherited }
        if ($protected) { $flags = $flags -bor [System.Security.AccessControl.ControlFlags]::DiscretionaryAclProtected }
        $raw.SetFlags($flags)
        $expectedSddl = $raw.GetSddlForm([System.Security.AccessControl.AccessControlSections]'Owner, Group, Access')
        Restore-DysonQualifiedClientEmptyDirectorySecurity -Path $aclFixture -Sddl $expectedSddl
        Set-DysonQualifiedClientStorageRemovalAcl -Path $aclFixture
        Restore-DysonQualifiedClientEmptyDirectorySecurity -Path $aclFixture -Sddl $expectedSddl
        Assert-ConfigurationIntegrationFixture (
            (Microsoft.PowerShell.Security\Get-Acl -LiteralPath $aclFixture).Sddl -ceq $expectedSddl
        ) 'ACL rollback changed the captured inheritance control bits'
        [System.IO.File]::WriteAllText((Join-Path $aclFixture 'arrived.txt'), 'fictional concurrent data')
        $populatedRejected = $false
        try { Restore-DysonQualifiedClientEmptyDirectorySecurity -Path $aclFixture -Sddl $expectedSddl }
        catch { $populatedRejected = $true }
        Assert-ConfigurationIntegrationFixture ($populatedRejected -and
            (Test-Path -LiteralPath (Join-Path $aclFixture 'arrived.txt')) -and
            (Microsoft.PowerShell.Security\Get-Acl -LiteralPath $aclFixture).Sddl -ceq $expectedSddl
        ) 'ACL rollback accepted a populated adopted directory or altered its preimage'
        $childDirectory = Join-Path $aclFixture 'managed-child'
        [void][System.IO.Directory]::CreateDirectory($childDirectory)
        Set-DysonQualifiedClientStorageRemovalAcl -Path $aclFixture
        $childSddl = (Microsoft.PowerShell.Security\Get-Acl -LiteralPath $childDirectory).Sddl
        Restore-DysonDeploymentDirectorySecurityPreimage -Path $aclFixture -Sddl $expectedSddl
        Assert-ConfigurationIntegrationFixture (
            (Microsoft.PowerShell.Security\Get-Acl -LiteralPath $aclFixture).Sddl -ceq $expectedSddl -and
            (Microsoft.PowerShell.Security\Get-Acl -LiteralPath $childDirectory).Sddl -ceq $childSddl -and
            [System.IO.File]::ReadAllText((Join-Path $aclFixture 'arrived.txt')) -ceq 'fictional concurrent data'
        ) 'managed directory rollback propagated ACL changes or altered descendant bytes'
    }

    $partialRejected = $false
    try {
        [void](Get-DysonQualifiedClientStoragePlan `
            -Configured @{ DYSON_QUALIFIED_CLIENT_PROFILE_ENABLED = 'true' } `
            -DataRoot $dataRoot)
    }
    catch { $partialRejected = $true }
    Assert-ConfigurationIntegrationFixture $partialRejected `
        'a partial qualified-client environment contract was accepted'

    $bindingsWithoutGate = New-QualifiedClientStorageFixtureConfiguration -DataRoot $dataRoot
    [void]$bindingsWithoutGate.Remove('DYSON_QUALIFIED_CLIENT_PROFILE_ENABLED')
    $bindingsWithoutGateRejected = $false
    try {
        [void](Get-DysonQualifiedClientStoragePlan `
            -Configured $bindingsWithoutGate -DataRoot $dataRoot)
    }
    catch { $bindingsWithoutGateRejected = $true }
    Assert-ConfigurationIntegrationFixture $bindingsWithoutGateRejected `
        'qualified-client bindings without an explicit feature gate were accepted'

    $invalidGateConfiguration = New-QualifiedClientStorageFixtureConfiguration -DataRoot $dataRoot
    $invalidGateConfiguration['DYSON_QUALIFIED_CLIENT_PROFILE_ENABLED'] = 'TRUE'
    $invalidGateRejected = $false
    try {
        [void](Get-DysonQualifiedClientStoragePlan `
            -Configured $invalidGateConfiguration -DataRoot $dataRoot)
    }
    catch { $invalidGateRejected = $true }
    Assert-ConfigurationIntegrationFixture $invalidGateRejected `
        'a non-canonical qualified-client feature gate was accepted'

    $wrongProviderConfiguration = New-QualifiedClientStorageFixtureConfiguration -DataRoot $dataRoot
    $wrongProviderConfiguration['DYSON_PROVIDER'] = 'demo'
    $wrongProviderRejected = $false
    try {
        [void](Get-DysonQualifiedClientStoragePlan `
            -Configured $wrongProviderConfiguration -DataRoot $dataRoot)
    }
    catch { $wrongProviderRejected = $true }
    Assert-ConfigurationIntegrationFixture $wrongProviderRejected `
        'qualified-client storage was accepted for a non-Windows provider'

    foreach ($invalidAuthority in @(
        '192.0.2.1',
        '2001:db8::1',
        'Example.com',
        'example.com.',
        'localhost',
        '-invalid.example',
        'invalid-.example'
    )) {
        $invalidAuthorityConfiguration = New-QualifiedClientStorageFixtureConfiguration `
            -DataRoot $dataRoot -Authority $invalidAuthority
        $invalidAuthorityRejected = $false
        try {
            [void](Get-DysonQualifiedClientStoragePlan `
                -Configured $invalidAuthorityConfiguration -DataRoot $dataRoot)
        }
        catch { $invalidAuthorityRejected = $true }
        Assert-ConfigurationIntegrationFixture $invalidAuthorityRejected `
            'a non-canonical or non-hostname qualified-client authority was accepted'
    }

    $escapedConfiguration = New-QualifiedClientStorageFixtureConfiguration -DataRoot $dataRoot
    $escapedConfiguration['DYSON_QUALIFIED_CLIENT_ISSUE_ROOT'] = Join-Path $dataRoot 'data\escaped-issued'
    $escapedRejected = $false
    try { [void](Get-DysonQualifiedClientStoragePlan -Configured $escapedConfiguration -DataRoot $dataRoot) }
    catch { $escapedRejected = $true }
    Assert-ConfigurationIntegrationFixture $escapedRejected `
        'a qualified-client storage root outside the fixed sibling layout was accepted'

    $unmanagedDataRoot = Join-Path $testRoot 'program-data\UnmanagedDysonControl'
    $unmanagedContainer = Join-Path $unmanagedDataRoot 'data\qualified-client'
    [void][System.IO.Directory]::CreateDirectory($unmanagedContainer)
    [System.IO.File]::WriteAllText(
        (Join-Path $unmanagedContainer 'unmanaged.fixture'),
        'fictional',
        [System.Text.UTF8Encoding]::new($false)
    )
    $unmanagedPlan = Get-DysonQualifiedClientStoragePlan `
        -Configured (New-QualifiedClientStorageFixtureConfiguration -DataRoot $unmanagedDataRoot) `
        -DataRoot $unmanagedDataRoot
    $unmanagedRejected = $false
    try {
        [void](Get-DysonQualifiedClientStoragePreimage `
            -Plan $unmanagedPlan -AllowSelfTestAdministrator)
    }
    catch { $unmanagedRejected = $true }
    Assert-ConfigurationIntegrationFixture $unmanagedRejected `
        'a populated qualified-client directory with an unmanaged ACL was adopted'

    $installSource = Read-FixtureSource 'Install-DysonControl.ps1'
    $taskSource = Read-FixtureSource 'Install-DysonControlTask.ps1'
    $startSource = Read-FixtureSource 'Start-DysonControl.ps1'
    $statusSource = Read-FixtureSource 'Test-DysonControlDeployment.ps1'
    $uninstallSource = Read-FixtureSource 'Uninstall-DysonControl.ps1'
    $rebootSource = Read-FixtureSource 'DysonRebootAcceptance.Common.ps1'
    Assert-OrderedMarkers -Name 'top-level installer' -Source $installSource -Markers @(
        '$configurationPreflight = Get-DysonDeploymentConfigurationPreflight',
        '$qualifiedClientStoragePreflight = Get-DysonQualifiedClientStoragePreimage',
        '$lifecycleBrokerPreflightState = Get-DysonLifecycleBrokerDeploymentPreimage',
        'if (-not $PSCmdlet.ShouldProcess',
        '$configurationBeforeMutation = Get-DysonDeploymentConfigurationPreflight',
        '$deploymentLock = Enter-DysonDeploymentLock',
        '$configurationUnderLock = Get-DysonDeploymentConfigurationPreflight',
        'Assert-DysonQualifiedClientStoragePreimageUnchanged',
        '$configurationPreimageSnapshot = New-DysonDeploymentConfigurationSnapshot',
        '$qualifiedClientStorageEvidence = Install-DysonQualifiedClientStorage',
        '$configurationInstallEvidence = Invoke-DysonDeploymentConfigurationInstall',
        '$taskInstallOutput = & (Join-Path $PSScriptRoot ''Install-DysonControlTask.ps1'')'
    )
    Assert-ConfigurationIntegrationFixture (
        $installSource.Contains('$configurationPostimageSnapshot = New-DysonDeploymentConfigurationSnapshot') -and
        $installSource.Contains('$configurationRestoreEvidence = Restore-DysonDeploymentConfigurationSnapshot') -and
        $installSource.Contains('Restore-DysonQualifiedClientStoragePreimage') -and
        $installSource.Contains('$rollbackFailures.Add(''qualified-client-storage'')') -and
        $installSource.Contains('deployment-state-blocked-by-protected-configuration') -and
        $installSource.Contains('configurationReplacementSupported = $true')
    ) 'the top-level deployment wrapper does not retain protected configuration and qualified-client rollback'
    Assert-OrderedMarkers -Name 'startup-task installer' -Source $taskSource -Markers @(
        '$configurationEvidence = Invoke-DysonDeploymentConfigurationTest',
        'if (-not $PSCmdlet.ShouldProcess',
        '$configurationBeforeMutation = Invoke-DysonDeploymentConfigurationTest',
        '$deploymentLock = Enter-DysonDeploymentLock',
        '$configurationUnderLock = Invoke-DysonDeploymentConfigurationTest',
        'Register-ScheduledTask'
    )
    Assert-ConfigurationIntegrationFixture (-not $taskSource.Contains('Set-Acl') -and
        -not $taskSource.Contains('$dataRule') -and
        -not $taskSource.Contains('NETWORK SERVICE') -and
        -not $taskSource.Contains("'SYSTEM'")) `
        'the startup-task installer still broadens DataRoot ACLs or accepts another service identity'
    Assert-OrderedMarkers -Name 'stable launcher' -Source $startSource -Markers @(
        '$configurationEvidence = Invoke-DysonDeploymentConfigurationTest',
        '$configurationBeforeRead = Invoke-DysonDeploymentConfigurationTest',
        '$configured = Read-DysonDeploymentConfigurationPrivateValues',
        '$qualifiedClientStorageStatus = Test-DysonQualifiedClientStorage',
        '$configurationAtLaunch = Invoke-DysonDeploymentConfigurationTest',
        '& $nodePath $active.entryPointPath'
    )
    Assert-ConfigurationIntegrationFixture (-not $startSource.Contains('ReadAllLines(') -and
        -not $startSource.Contains('ConvertFrom-Json') -and
        $startSource.Contains('$configured.Clear()')) `
        'the stable launcher retained a second configuration parser or serialized private values'
    Assert-ConfigurationIntegrationFixture ($statusSource.Contains("'PROTECTED_CONFIGURATION'") -and
        $statusSource.Contains('Assert-DysonDeploymentConfigurationEvidenceMatch') -and
        $statusSource.Contains("'QUALIFIED_CLIENT_STORAGE'")) `
        'deployment status does not fail closed on protected configuration drift'
    Assert-OrderedMarkers -Name 'uninstaller' -Source $uninstallSource -Markers @(
        '$configurationEvidence = Invoke-DysonDeploymentConfigurationTest',
        '$qualifiedClientStorageEvidence = Test-DysonQualifiedClientStorage',
        'if (-not $PSCmdlet.ShouldProcess',
        '$deploymentLock = Enter-DysonDeploymentLock',
        '$configurationUnderLock = Invoke-DysonDeploymentConfigurationTest',
        '$qualifiedClientStorageUnderLock = Test-DysonQualifiedClientStorage'
    )
    Assert-ConfigurationIntegrationFixture ($rebootSource.Contains(
            '$script:DysonRebootAcceptanceSchemaVersion = 3') -and
        $rebootSource.Contains('configurationParentAclFingerprint') -and
        $rebootSource.Contains('DYSON_REBOOT_ACCEPTANCE_CONTROL_DRIFT')) `
        'reboot checkpoint/resume does not bind protected configuration evidence'
    foreach ($source in @($startSource, $taskSource)) {
        Assert-ConfigurationIntegrationFixture (-not $source.Contains('DYSON_NODE_RUNTIME_SHA256') -and
            -not $source.Contains('DYSON_NODE_RUNTIME_ROOT_IDENTITY')) `
            'runtime evidence leaked into the child DYSON_* application environment'
    }

    [ordered]@{
        protocol = 'DYSON_CONTROL_DEPLOYMENT_CONFIGURATION_INTEGRATION_SELFTEST_V1'
        state = 'passed'
        unchangedOwnerDaclRestoreValidated = $true
        protectedDataRootAclValidated = $true
        serviceRootReadExecuteOnly = $true
        ordinaryDescendantModifyInheritanceValidated = $true
        ordinaryDataAndLogsEffectiveModifyValidated = $true
        qualifiedClientEnvironmentContractValidated = $true
        qualifiedClientDisabledNoOpValidated = $true
        qualifiedClientDisabledPreProvisioningValidated = $true
        qualifiedClientStorageTransactionValidated = $true
        qualifiedClientStorageUpgradeIdempotencyValidated = $true
        qualifiedClientStorageRollbackValidated = $true
        qualifiedClientStorageAdoptionRollbackValidated = $true
        qualifiedClientStorageNegativeCasesValidated = $true
        localServiceTokenE2EPendingElevatedVm = $true
        validationBeforeMutationOrderValidated = $true
        protectedConfigurationReplacementRollbackOrchestrationPresent = $true
        taskAclBroadeningAbsent = $true
        taskArgumentsContainNoSecretValues = $true
        launcherFailClosedValidationValidated = $true
        statusAndRebootEvidenceValidated = $true
        runtimeEvidenceNotInjectedAsDysonEnvironment = $true
        productionChanged = $false
    } | ConvertTo-Json -Depth 5 -Compress
}
catch {
    $testFailure = $_
    throw
}
finally {
    [System.Environment]::SetEnvironmentVariable(
        'DYSON_DEPLOYMENT_ALLOW_SELFTEST_TASKS', $previousSelfTestGate, 'Process'
    )
    Remove-Item Env:DYSON_DEPLOYMENT_SELFTEST_ROOT_IDENTITY -ErrorAction SilentlyContinue
    Remove-Variable -Name DysonDeploymentAuthorizedSelfTestRoots -Scope Global -ErrorAction SilentlyContinue
    $testFull = [System.IO.Path]::GetFullPath($testRoot).TrimEnd('\', '/')
    $requiredPrefix = $temporaryBase + [System.IO.Path]::DirectorySeparatorChar +
        'dyson-control-deployment-selftest-'
    if ($testFull.StartsWith($requiredPrefix, [System.StringComparison]::OrdinalIgnoreCase) -and
        (Test-Path -LiteralPath $testFull)) {
        try { [System.IO.Directory]::Delete($testFull, $true) }
        catch {
            if ($null -eq $testFailure) { throw }
            Write-Warning 'Fixture cleanup also failed; the original integration failure is preserved.'
        }
    }
}
