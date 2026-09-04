Set-StrictMode -Version 2.0

$script:DysonDeploymentConfigurationInstallProtocol = 'DYSON_CONTROL_CONFIGURATION_INSTALL_RESULT_V1'
$script:DysonDeploymentConfigurationTestProtocol = 'DYSON_CONTROL_CONFIGURATION_TEST_RESULT_V1'
$script:DysonDeploymentConfigurationSnapshotProtocol = 'DYSON_CONTROL_CONFIGURATION_SNAPSHOT_RESULT_V1'
$script:DysonDeploymentConfigurationRestoreProtocol = 'DYSON_CONTROL_CONFIGURATION_RESTORE_RESULT_V1'
$script:DysonDeploymentConfigurationSourceSelfTestProtocol = `
    'DYSON_CONTROL_CONFIGURATION_SOURCE_SELFTEST_RESULT_V1'
$script:DysonDeploymentConfigurationServiceAccount = 'NT AUTHORITY\LOCAL SERVICE'
$script:DysonDeploymentConfigurationRuntimeFiles = @(
    'DysonConfiguration.Common.ps1',
    'Install-DysonControlConfiguration.ps1',
    'New-DysonControlConfigurationSnapshot.ps1',
    'Restore-DysonControlConfiguration.ps1',
    'Test-DysonControlConfiguration.ps1',
    'dyson-control.environment-contract.json'
)

function Resolve-DysonDeploymentConfigurationModuleRoot {
    param([Parameter(Mandatory)][string]$ModuleRoot)

    $root = Assert-DysonDeploymentPlainPathChain -Path $ModuleRoot
    foreach ($name in $script:DysonDeploymentConfigurationRuntimeFiles) {
        $path = Join-Path $root $name
        $item = Get-Item -LiteralPath $path -Force -ErrorAction Stop
        if ($item.PSIsContainer -or
            ($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -or
            $item.Length -lt 1 -or $item.Length -gt 1048576) {
            throw 'The fixed configuration module is unavailable, redirected, or oversized.'
        }
    }
    return $root
}

function Get-DysonDeploymentConfigurationModuleRoot {
    param([string]$ConfigurationModuleRoot)

    if ([string]::IsNullOrWhiteSpace($ConfigurationModuleRoot)) {
        $ConfigurationModuleRoot = Join-Path $PSScriptRoot '..\configuration'
    }
    return Resolve-DysonDeploymentConfigurationModuleRoot -ModuleRoot $ConfigurationModuleRoot
}

function Get-DysonDeploymentConfigurationVerificationModuleRoot {
    param(
        [Parameter(Mandatory)][string]$InstallRoot,
        [Parameter(Mandatory)][string]$DataRoot,
        [string]$SelfTestConfigurationShadowRoot
    )

    if ([string]::IsNullOrWhiteSpace($SelfTestConfigurationShadowRoot)) {
        return Resolve-DysonDeploymentConfigurationModuleRoot -ModuleRoot (
            Join-Path (Join-Path (Get-DysonFullPath -Path $InstallRoot) 'bootstrap') 'configuration'
        )
    }
    Assert-DysonDeploymentTaskSelfTestScope -InstallRoot $InstallRoot -DataRoot $DataRoot
    $shadowFull = Assert-DysonPlainDirectory -Path $SelfTestConfigurationShadowRoot
    $temporaryRoot = [System.IO.Path]::GetFullPath([System.IO.Path]::GetTempPath()).TrimEnd('\', '/')
    $requiredPrefix = $temporaryRoot + [System.IO.Path]::DirectorySeparatorChar + `
        'dyson-control-deployment-selftest-'
    if (-not $shadowFull.TrimEnd('\', '/').StartsWith(
            $requiredPrefix,
            [System.StringComparison]::OrdinalIgnoreCase
        ) -or -not (Test-Path -LiteralPath (Join-Path $shadowFull `
            '.dyson-configuration-selftest') -PathType Leaf)) {
        throw 'The configuration shadow module is outside the isolated deployment self-test root.'
    }
    return Resolve-DysonDeploymentConfigurationModuleRoot -ModuleRoot $shadowFull
}

function Get-DysonDeploymentConfigurationBindings {
    param(
        [Parameter(Mandatory)][string]$DataRoot,
        [Parameter(Mandatory)][string]$ScriptRoot,
        [Parameter(Mandatory)][string]$RuntimeBootstrapRoot,
        [Parameter(Mandatory)][string]$DeploymentVersion
    )

    return @{
        NODE_ENV = 'production'
        DYSON_HOST = '127.0.0.1'
        DYSON_DATA_DIR = Join-Path (Get-DysonFullPath -Path $DataRoot) 'data'
        DYSON_SCRIPT_ROOT = Get-DysonFullPath -Path $ScriptRoot
        DYSON_RUNTIME_BOOTSTRAP_ROOT = Get-DysonFullPath -Path $RuntimeBootstrapRoot
        DYSON_DEPLOYMENT_VERSION = $DeploymentVersion
    }
}

function Read-DysonDeploymentConfigurationPrivateValues {
    param(
        [Parameter(Mandatory)][string]$ConfigurationPath,
        [Parameter(Mandatory)][string]$DataRoot,
        [Parameter(Mandatory)][string]$ScriptRoot,
        [Parameter(Mandatory)][string]$RuntimeBootstrapRoot,
        [Parameter(Mandatory)][string]$DeploymentVersion,
        [Parameter(Mandatory)]$ExpectedEvidence,
        [string]$ConfigurationModuleRoot
    )

    $moduleRoot = Get-DysonDeploymentConfigurationModuleRoot `
        -ConfigurationModuleRoot $ConfigurationModuleRoot
    . (Join-Path $moduleRoot 'DysonConfiguration.Common.ps1')
    $contract = Get-DysonConfigurationContract -ContractPath (
        Join-Path $moduleRoot 'dyson-control.environment-contract.json'
    )
    $bindings = Get-DysonDeploymentConfigurationBindings -DataRoot $DataRoot `
        -ScriptRoot $ScriptRoot -RuntimeBootstrapRoot $RuntimeBootstrapRoot `
        -DeploymentVersion $DeploymentVersion
    $parsed = $null
    try {
        $parsed = Read-DysonControlEnvironmentFile -Path $ConfigurationPath `
            -Contract $contract -ExpectedLauncherBindings $bindings -SkipSourceAcl
        if ([string]$parsed.sha256 -cne [string]$ExpectedEvidence.configurationSha256 -or
            [int64]$parsed.length -ne [int64]$ExpectedEvidence.configurationLength -or
            [string]$parsed.namesSha256 -cne [string]$ExpectedEvidence.configurationNamesSha256 -or
            [string]$parsed.bindingsSha256 -cne [string]$ExpectedEvidence.configurationBindingsSha256 -or
            [string]$parsed.contractSha256 -cne [string]$ExpectedEvidence.configurationContractSha256) {
            throw 'The protected configuration changed between verification and its strict launcher parse.'
        }
        $privateValues = @{}
        foreach ($name in @($parsed.privateValues.Keys)) {
            $privateValues[[string]$name] = [string]$parsed.privateValues[$name]
        }
        return $privateValues
    }
    finally {
        if ($null -ne $parsed) {
            if ($null -ne $parsed.privateBytes) {
                [Array]::Clear($parsed.privateBytes, 0, $parsed.privateBytes.Length)
            }
            if ($null -ne $parsed.privateValues) { $parsed.privateValues.Clear() }
        }
    }
}

function Assert-DysonDeploymentConfigurationServiceAccount {
    param([Parameter(Mandatory)][string]$ServiceAccount)

    if (-not [string]::Equals(
            $ServiceAccount,
            $script:DysonDeploymentConfigurationServiceAccount,
            [System.StringComparison]::Ordinal
        )) {
        throw 'Protected configuration currently requires NT AUTHORITY\LOCAL SERVICE.'
    }
}

function ConvertTo-DysonDeploymentConfigurationEvidence {
    param(
        [Parameter(Mandatory)]$Result,
        [Parameter(Mandatory)][ValidateSet('install', 'test', 'preflight')][string]$Kind
    )

    $configurationSha256 = if ($Kind -eq 'preflight') {
        [string]$Result.configurationSha256
    }
    else { [string]$Result.configurationSha256 }
    $configurationLength = [int64]$Result.configurationLength
    $contractSha256 = [string]$Result.contractSha256
    $bindingsSha256 = [string]$Result.bindingsSha256
    $configurationAclFingerprint = if ($Kind -eq 'install') {
        [string]$Result.aclFingerprint
    }
    else { [string]$Result.configurationAclFingerprint }
    $parentAclFingerprint = [string]$Result.parentAclFingerprint
    foreach ($digest in @(
        $configurationSha256, $contractSha256, $bindingsSha256,
        $configurationAclFingerprint, $parentAclFingerprint
    )) {
        if ($digest -cnotmatch '^[0-9a-f]{64}$') {
            throw 'The configuration module returned invalid or incomplete integrity evidence.'
        }
    }
    if ($configurationLength -lt 1 -or $configurationLength -gt 65536) {
        throw 'The configuration module returned an invalid configuration length.'
    }
    $namesSha256 = if ($Kind -eq 'test') { [string]$Result.namesSha256 } else { $null }
    if ($Kind -eq 'test' -and $namesSha256 -cnotmatch '^[0-9a-f]{64}$') {
        throw 'The configuration module returned an invalid name-set digest.'
    }
    return [pscustomobject][ordered]@{
        configurationSha256 = $configurationSha256
        configurationLength = $configurationLength
        configurationNamesSha256 = $namesSha256
        configurationBindingsSha256 = $bindingsSha256
        configurationContractSha256 = $contractSha256
        configurationAclFingerprint = $configurationAclFingerprint
        configurationParentAclFingerprint = $parentAclFingerprint
        completedTransactionCount = if ($Kind -eq 'test') {
            [int]$Result.completedTransactionCount
        }
        else { $null }
    }
}

function Get-DysonDeploymentConfigurationPreflight {
    param(
        [Parameter(Mandatory)][string]$ConfigurationSource,
        [Parameter(Mandatory)][string]$DataRoot,
        [Parameter(Mandatory)][string]$ScriptRoot,
        [Parameter(Mandatory)][string]$RuntimeBootstrapRoot,
        [Parameter(Mandatory)][string]$DeploymentVersion,
        [Parameter(Mandatory)][string]$ServiceAccount,
        [string]$ExistingScriptRoot,
        [string]$ExistingRuntimeBootstrapRoot,
        [string]$ExistingDeploymentVersion,
        [string]$ConfigurationModuleRoot,
        [string]$SelfTestConfigurationShadowRoot,
        [switch]$AllowSelfTestAdministrator
    )

    Assert-DysonDeploymentConfigurationServiceAccount -ServiceAccount $ServiceAccount
    if ([string]::IsNullOrWhiteSpace($ExistingScriptRoot)) {
        $ExistingScriptRoot = $ScriptRoot
    }
    if ([string]::IsNullOrWhiteSpace($ExistingRuntimeBootstrapRoot)) {
        $ExistingRuntimeBootstrapRoot = $RuntimeBootstrapRoot
    }
    if ([string]::IsNullOrWhiteSpace($ExistingDeploymentVersion)) {
        $ExistingDeploymentVersion = $DeploymentVersion
    }
    if (-not [string]::IsNullOrWhiteSpace($SelfTestConfigurationShadowRoot)) {
        if (-not $AllowSelfTestAdministrator) {
            throw 'The configuration source shadow is reserved for the isolated deployment self-test.'
        }
        $moduleRoot = Get-DysonDeploymentConfigurationVerificationModuleRoot `
            -InstallRoot $DataRoot -DataRoot $DataRoot `
            -SelfTestConfigurationShadowRoot $SelfTestConfigurationShadowRoot
        $sourceVerifierPath = Join-Path $moduleRoot 'Test-DysonControlConfigurationSource.ps1'
        $sourceVerifier = Get-Item -LiteralPath $sourceVerifierPath -Force -ErrorAction Stop
        if ($sourceVerifier.PSIsContainer -or
            ($sourceVerifier.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -or
            $sourceVerifier.Length -lt 1 -or $sourceVerifier.Length -gt 1048576) {
            throw 'The isolated configuration source verifier is unavailable, redirected, or oversized.'
        }
        $output = @(& $sourceVerifier.FullName `
            -ConfigurationSource $ConfigurationSource -DataRoot $DataRoot `
            -ScriptRoot $ScriptRoot -RuntimeBootstrapRoot $RuntimeBootstrapRoot `
            -DeploymentVersion $DeploymentVersion -ServiceAccount $ServiceAccount `
            -ExistingScriptRoot $ExistingScriptRoot `
            -ExistingRuntimeBootstrapRoot $ExistingRuntimeBootstrapRoot `
            -ExistingDeploymentVersion $ExistingDeploymentVersion)
        if ($output.Count -lt 1) {
            throw 'The isolated configuration source verifier returned no result.'
        }
        $result = $output[$output.Count - 1]
        $expectedProperties = @(
            'protocol', 'mutationPerformed', 'configurationPath', 'sourceSha256',
            'sourceLength', 'namesSha256', 'bindingsSha256', 'contractSha256',
            'existing', 'snapshot', 'restorePlan'
        )
        $actualProperties = @($result.PSObject.Properties.Name | Sort-Object -CaseSensitive)
        if (($actualProperties -join '|') -cne
            (@($expectedProperties | Sort-Object -CaseSensitive) -join '|') -or
            [string]$result.protocol -cne $script:DysonDeploymentConfigurationSourceSelfTestProtocol -or
            $result.mutationPerformed -isnot [bool] -or [bool]$result.mutationPerformed -or
            $null -ne $result.snapshot -or $null -ne $result.restorePlan) {
            throw 'The isolated configuration source verifier returned an unsupported result.'
        }
        $sourceItem = Get-Item -LiteralPath $ConfigurationSource -Force -ErrorAction Stop
        $expectedConfigurationPath = Join-Path (Join-Path (Get-DysonFullPath -Path $DataRoot) `
            'config') 'dyson-control.env'
        if ($sourceItem.PSIsContainer -or
            ($sourceItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -or
            $sourceItem.Length -lt 1 -or $sourceItem.Length -gt 65536 -or
            [string]$result.sourceSha256 -cne (Get-DysonFileSha256 -Path $sourceItem.FullName) -or
            [int64]$result.sourceLength -ne [int64]$sourceItem.Length -or
            -not [string]::Equals(
                (Get-DysonFullPath -Path ([string]$result.configurationPath)),
                (Get-DysonFullPath -Path $expectedConfigurationPath),
                [System.StringComparison]::OrdinalIgnoreCase
            )) {
            throw 'The isolated configuration source verifier did not bind the exact fixture source and target.'
        }
        foreach ($digest in @(
            [string]$result.sourceSha256, [string]$result.namesSha256,
            [string]$result.bindingsSha256, [string]$result.contractSha256
        )) {
            if ($digest -cnotmatch '^[0-9a-f]{64}$') {
                throw 'The isolated configuration source verifier returned invalid integrity evidence.'
            }
        }
        if ($null -ne $result.existing) {
            $existingProperties = @($result.existing.PSObject.Properties.Name | Sort-Object -CaseSensitive)
            $expectedExistingProperties = @(
                'configurationSha256', 'configurationLength', 'namesSha256',
                'bindingsSha256', 'contractSha256', 'configurationAclFingerprint',
                'parentAclFingerprint', 'completedTransactionCount'
            )
            if (($existingProperties -join '|') -cne
                (@($expectedExistingProperties | Sort-Object -CaseSensitive) -join '|')) {
                throw 'The isolated configuration source verifier returned invalid existing evidence.'
            }
            [void](ConvertTo-DysonDeploymentConfigurationEvidence `
                -Result $result.existing -Kind preflight)
        }
        return [pscustomobject][ordered]@{
            moduleRoot = $moduleRoot
            configurationPath = $expectedConfigurationPath
            sourceSha256 = [string]$result.sourceSha256
            sourceLength = [int64]$result.sourceLength
            namesSha256 = [string]$result.namesSha256
            bindingsSha256 = [string]$result.bindingsSha256
            contractSha256 = [string]$result.contractSha256
            existing = $result.existing
        }
    }
    $moduleRoot = Get-DysonDeploymentConfigurationModuleRoot `
        -ConfigurationModuleRoot $ConfigurationModuleRoot
    . (Join-Path $moduleRoot 'DysonConfiguration.Common.ps1')
    $contract = Get-DysonConfigurationContract -ContractPath (
        Join-Path $moduleRoot 'dyson-control.environment-contract.json'
    )
    $bindings = Get-DysonDeploymentConfigurationBindings -DataRoot $DataRoot `
        -ScriptRoot $ScriptRoot -RuntimeBootstrapRoot $RuntimeBootstrapRoot `
        -DeploymentVersion $DeploymentVersion
    $existingBindings = Get-DysonDeploymentConfigurationBindings -DataRoot $DataRoot `
        -ScriptRoot $ExistingScriptRoot `
        -RuntimeBootstrapRoot $ExistingRuntimeBootstrapRoot `
        -DeploymentVersion $ExistingDeploymentVersion
    $source = Read-DysonControlEnvironmentFile -Path $ConfigurationSource `
        -Contract $contract -ExpectedLauncherBindings $bindings
    $existing = $null
    $dataFull = Get-DysonFullPath -Path $DataRoot
    if (Test-Path -LiteralPath $dataFull) {
        $dataFull = Assert-DysonConfigurationPlainDirectoryChain $dataFull
        $serviceSid = Resolve-DysonConfigurationServiceSid $ServiceAccount
        if ($AllowSelfTestAdministrator) {
            Assert-DysonDeploymentTaskSelfTestScope -InstallRoot $dataFull -DataRoot $dataFull
            $parentAcl = [pscustomobject]@{
                fingerprint = Get-DysonConfigurationSha256Text `
                    ((Get-Acl -LiteralPath $dataFull -ErrorAction Stop).Sddl)
            }
        }
        else {
            $parentAcl = Assert-DysonConfigurationParentAcl -Path $dataFull -ServiceSid $serviceSid
        }
        $storage = Get-DysonConfigurationStoragePaths -DataRoot $dataFull
        $configurationPresent = Test-Path -LiteralPath $storage.configurationPath -PathType Leaf
        $storagePresence = @(
            (Test-Path -LiteralPath $storage.configRoot -PathType Container),
            (Test-Path -LiteralPath $storage.transactionRoot -PathType Container),
            (Test-Path -LiteralPath $storage.intentsRoot -PathType Container),
            (Test-Path -LiteralPath $storage.receiptsRoot -PathType Container)
        )
        if ($configurationPresent) {
            if (-not $AllowSelfTestAdministrator -and
                @($storagePresence | Where-Object { -not $_ }).Count -ne 0) {
                throw 'DYSON_CONFIGURATION_PARTIAL_STORAGE_INVALID'
            }
            if (-not $AllowSelfTestAdministrator) {
                [void](Assert-DysonConfigurationAcl -Path $storage.configRoot `
                    -Kind ConfigDirectory -ServiceSid $serviceSid)
                foreach ($directory in @($storage.transactionRoot, $storage.intentsRoot, $storage.receiptsRoot)) {
                    [void](Assert-DysonConfigurationAcl -Path $directory -Kind PrivateDirectory)
                }
            }
            $installed = Read-DysonControlEnvironmentFile -Path $storage.configurationPath `
                -Contract $contract -ExpectedLauncherBindings $existingBindings -SkipSourceAcl
            if ($AllowSelfTestAdministrator) {
                $installedAcl = [pscustomobject]@{
                    fingerprint = Get-DysonConfigurationSha256Text `
                        ((Get-Acl -LiteralPath $storage.configurationPath -ErrorAction Stop).Sddl)
                }
                $transactionState = [pscustomobject]@{ clean = $true; receipts = @() }
            }
            else {
                $installedAcl = Assert-DysonConfigurationAcl -Path $storage.configurationPath `
                    -Kind ConfigFile -ServiceSid $serviceSid
                $transactionState = Get-DysonConfigurationTransactionState -Storage $storage `
                    -ServiceSid $serviceSid -Contract $contract `
                    -ExpectedLauncherBindings $existingBindings
                if (-not $transactionState.clean) { throw 'DYSON_CONFIGURATION_TRANSACTION_NOT_CLEAN' }
            }
            $existing = [pscustomobject][ordered]@{
                configurationSha256 = [string]$installed.sha256
                configurationLength = [int64]$installed.length
                namesSha256 = [string]$installed.namesSha256
                bindingsSha256 = [string]$installed.bindingsSha256
                contractSha256 = [string]$contract.sha256
                configurationAclFingerprint = [string]$installedAcl.fingerprint
                parentAclFingerprint = [string]$parentAcl.fingerprint
                completedTransactionCount = [int]$transactionState.receipts.Count
            }
        }
        elseif (-not $AllowSelfTestAdministrator -and
            @($storagePresence | Where-Object { $_ }).Count -ne 0) {
            throw 'DYSON_CONFIGURATION_EXISTING_PARTIAL_STORAGE_REQUIRES_RECOVERY'
        }
    }
    else {
        [void](Assert-DysonConfigurationLocalNtfsPath $dataFull)
        $ancestor = [System.IO.Path]::GetDirectoryName($dataFull)
        while (-not (Test-Path -LiteralPath $ancestor -PathType Container)) {
            $parent = [System.IO.Path]::GetDirectoryName($ancestor)
            if ([string]::IsNullOrWhiteSpace($parent) -or
                [string]::Equals($parent, $ancestor, [System.StringComparison]::OrdinalIgnoreCase)) {
                throw 'The configuration DataRoot has no bounded existing parent.'
            }
            $ancestor = $parent
        }
        [void](Assert-DysonConfigurationPlainDirectoryChain $ancestor)
    }
    return [pscustomobject][ordered]@{
        moduleRoot = $moduleRoot
        configurationPath = Join-Path (Join-Path $dataFull 'config') 'dyson-control.env'
        sourceSha256 = [string]$source.sha256
        sourceLength = [int64]$source.length
        namesSha256 = [string]$source.namesSha256
        bindingsSha256 = [string]$source.bindingsSha256
        contractSha256 = [string]$contract.sha256
        existing = $existing
    }
}

function Set-DysonDeploymentProtectedDataRootAcl {
    param(
        [Parameter(Mandatory)][string]$DataRoot,
        [Parameter(Mandatory)][string]$ServiceAccount,
        [switch]$AllowSelfTestAdministrator
    )

    Assert-DysonDeploymentConfigurationServiceAccount -ServiceAccount $ServiceAccount
    $dataFull = Assert-DysonDeploymentPlainPathChain -Path $DataRoot
    $systemSid = [System.Security.Principal.SecurityIdentifier]::new('S-1-5-18')
    $administratorsSid = [System.Security.Principal.SecurityIdentifier]::new('S-1-5-32-544')
    $serviceSid = [System.Security.Principal.SecurityIdentifier]::new('S-1-5-19')
    $fixtureSid = $null
    if ($AllowSelfTestAdministrator) {
        Assert-DysonDeploymentTaskSelfTestScope -InstallRoot $DataRoot -DataRoot $DataRoot
        $fixtureSid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
    }
    $acl = [System.Security.AccessControl.DirectorySecurity]::new()
    $acl.SetAccessRuleProtection($true, $false)
    $ownerSid = if ($fixtureSid) { $fixtureSid } else { $administratorsSid }
    $acl.SetOwner($ownerSid)
    $inheritance = [System.Security.AccessControl.InheritanceFlags]'ContainerInherit, ObjectInherit'
    foreach ($sid in @($systemSid, $administratorsSid)) {
        $acl.AddAccessRule([System.Security.AccessControl.FileSystemAccessRule]::new(
            $sid, [System.Security.AccessControl.FileSystemRights]::FullControl,
            $inheritance, [System.Security.AccessControl.PropagationFlags]::None,
            [System.Security.AccessControl.AccessControlType]::Allow
        ))
    }
    if ($fixtureSid -and -not [string]::Equals(
            $fixtureSid.Value, $administratorsSid.Value,
            [System.StringComparison]::OrdinalIgnoreCase
        )) {
        $acl.AddAccessRule([System.Security.AccessControl.FileSystemAccessRule]::new(
            $fixtureSid, [System.Security.AccessControl.FileSystemRights]::FullControl,
            $inheritance, [System.Security.AccessControl.PropagationFlags]::None,
            [System.Security.AccessControl.AccessControlType]::Allow
        ))
    }
    $acl.AddAccessRule([System.Security.AccessControl.FileSystemAccessRule]::new(
        $serviceSid, [System.Security.AccessControl.FileSystemRights]::ReadAndExecute,
        [System.Security.AccessControl.InheritanceFlags]::None,
        [System.Security.AccessControl.PropagationFlags]::None,
        [System.Security.AccessControl.AccessControlType]::Allow
    ))
    $acl.AddAccessRule([System.Security.AccessControl.FileSystemAccessRule]::new(
        $serviceSid, [System.Security.AccessControl.FileSystemRights]::Modify,
        $inheritance, [System.Security.AccessControl.PropagationFlags]::InheritOnly,
        [System.Security.AccessControl.AccessControlType]::Allow
    ))
    [System.IO.Directory]::SetAccessControl($dataFull, $acl)
}

function Invoke-DysonDeploymentConfigurationInstall {
    param(
        [Parameter(Mandatory)][string]$ConfigurationSource,
        [Parameter(Mandatory)][string]$DataRoot,
        [Parameter(Mandatory)][string]$ScriptRoot,
        [Parameter(Mandatory)][string]$RuntimeBootstrapRoot,
        [Parameter(Mandatory)][string]$DeploymentVersion,
        [Parameter(Mandatory)][string]$ServiceAccount,
        [string]$ProtectedPreimageSnapshotPath,
        [string]$ConfigurationModuleRoot
    )

    $moduleRoot = Get-DysonDeploymentConfigurationModuleRoot `
        -ConfigurationModuleRoot $ConfigurationModuleRoot
    $arguments = @{
        ConfigurationSource = $ConfigurationSource
        DataRoot = $DataRoot
        ScriptRoot = $ScriptRoot
        RuntimeBootstrapRoot = $RuntimeBootstrapRoot
        DeploymentVersion = $DeploymentVersion
        ServiceAccount = $ServiceAccount
        Confirm = $false
    }
    if (-not [string]::IsNullOrWhiteSpace($ProtectedPreimageSnapshotPath)) {
        $arguments['ProtectedPreimageSnapshotPath'] = $ProtectedPreimageSnapshotPath
    }
    $output = @(& (Join-Path $moduleRoot 'Install-DysonControlConfiguration.ps1') @arguments)
    if ($output.Count -lt 1) { throw 'The configuration installer returned no result.' }
    $result = $output[$output.Count - 1]
    if ([string]$result.protocol -cne $script:DysonDeploymentConfigurationInstallProtocol -or
        [string]$result.mode -cne 'apply' -or
        [string]$result.state -notin @('completed', 'recovered') -or
        [string]$result.operation -notin @('create', 'reuse', 'replace') -or
        $result.mutationPerformed -isnot [bool] -or -not [bool]$result.mutationPerformed) {
        throw 'The configuration installer returned an unsupported result.'
    }
    return ConvertTo-DysonDeploymentConfigurationEvidence -Result $result -Kind install
}

function New-DysonDeploymentConfigurationSnapshot {
    param(
        [Parameter(Mandatory)][string]$DataRoot,
        [Parameter(Mandatory)][string]$ScriptRoot,
        [Parameter(Mandatory)][string]$RuntimeBootstrapRoot,
        [Parameter(Mandatory)][string]$DeploymentVersion,
        [Parameter(Mandatory)][string]$ServiceAccount,
        [string]$ConfigurationModuleRoot
    )

    $moduleRoot = Get-DysonDeploymentConfigurationModuleRoot `
        -ConfigurationModuleRoot $ConfigurationModuleRoot
    $output = @(& (Join-Path $moduleRoot 'New-DysonControlConfigurationSnapshot.ps1') `
        -DataRoot $DataRoot -ScriptRoot $ScriptRoot `
        -RuntimeBootstrapRoot $RuntimeBootstrapRoot -DeploymentVersion $DeploymentVersion `
        -ServiceAccount $ServiceAccount -Confirm:$false)
    if ($output.Count -lt 1) { throw 'The configuration snapshot creator returned no result.' }
    $result = $output[$output.Count - 1]
    $expectedProperties = @(
        'protocol', 'mode', 'state', 'snapshotId', 'snapshotPath', 'snapshotPathSha256',
        'configurationSha256', 'configurationLength', 'configurationAclFingerprint',
        'manifestSha256', 'bindingsSha256', 'contractSha256', 'mutationPerformed'
    )
    $actualProperties = @($result.PSObject.Properties.Name | Sort-Object -CaseSensitive)
    if (($actualProperties -join '|') -cne
            (@($expectedProperties | Sort-Object -CaseSensitive) -join '|') -or
        [string]$result.protocol -cne $script:DysonDeploymentConfigurationSnapshotProtocol -or
        [string]$result.mode -cne 'apply' -or [string]$result.state -cne 'created' -or
        $result.mutationPerformed -isnot [bool] -or -not [bool]$result.mutationPerformed -or
        [string]$result.snapshotId -cnotmatch
            '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$') {
        throw 'The configuration snapshot creator returned an unsupported result.'
    }
    foreach ($digest in @(
            [string]$result.snapshotPathSha256, [string]$result.configurationSha256,
            [string]$result.configurationAclFingerprint, [string]$result.manifestSha256,
            [string]$result.bindingsSha256, [string]$result.contractSha256
        )) {
        if ($digest -cnotmatch '^[0-9a-f]{64}$') {
            throw 'The configuration snapshot creator returned invalid integrity evidence.'
        }
    }
    if ([int64]$result.configurationLength -lt 1 -or
        [int64]$result.configurationLength -gt 65536) {
        throw 'The configuration snapshot creator returned an invalid configuration length.'
    }
    $snapshotFull = Assert-DysonDeploymentPlainPathChain -Path ([string]$result.snapshotPath)
    $snapshotRoot = Join-Path (Join-Path (Get-DysonFullPath -Path $DataRoot) 'config') 'snapshots'
    if (-not (Test-DysonDeploymentSamePath `
            -Left ([System.IO.Path]::GetDirectoryName($snapshotFull)) -Right $snapshotRoot) -or
        [string]::Equals($snapshotFull, $snapshotRoot,
            [System.StringComparison]::OrdinalIgnoreCase)) {
        throw 'The configuration snapshot escaped its fixed protected snapshot root.'
    }
    return [pscustomobject][ordered]@{
        snapshotId = [string]$result.snapshotId
        snapshotPath = $snapshotFull
        snapshotPathSha256 = [string]$result.snapshotPathSha256
        configurationSha256 = [string]$result.configurationSha256
        configurationLength = [int64]$result.configurationLength
        configurationAclFingerprint = [string]$result.configurationAclFingerprint
        manifestSha256 = [string]$result.manifestSha256
        configurationBindingsSha256 = [string]$result.bindingsSha256
        configurationContractSha256 = [string]$result.contractSha256
    }
}

function Restore-DysonDeploymentConfigurationSnapshot {
    param(
        [Parameter(Mandatory)][string]$ProtectedSnapshotPath,
        [Parameter(Mandatory)][string]$CurrentProtectedSnapshotPath,
        [Parameter(Mandatory)][string]$DataRoot,
        [Parameter(Mandatory)][string]$ServiceAccount,
        [string]$ConfigurationModuleRoot
    )

    $moduleRoot = Get-DysonDeploymentConfigurationModuleRoot `
        -ConfigurationModuleRoot $ConfigurationModuleRoot
    $output = @(& (Join-Path $moduleRoot 'Restore-DysonControlConfiguration.ps1') `
        -ProtectedSnapshotPath $ProtectedSnapshotPath `
        -CurrentProtectedSnapshotPath $CurrentProtectedSnapshotPath `
        -DataRoot $DataRoot -ServiceAccount $ServiceAccount -Confirm:$false)
    if ($output.Count -lt 1) { throw 'The configuration restore executor returned no result.' }
    $result = $output[$output.Count - 1]
    $expectedProperties = @(
        'protocol', 'mode', 'state', 'operation', 'transactionId', 'sequence',
        'sourceSnapshotId', 'preimageSnapshotId', 'configurationSha256',
        'configurationLength', 'configurationAclFingerprint', 'bindingsSha256',
        'contractSha256', 'chainHeadSha256', 'completedTransactionCount',
        'mutationPerformed'
    )
    $actualProperties = @($result.PSObject.Properties.Name | Sort-Object -CaseSensitive)
    if (($actualProperties -join '|') -cne
            (@($expectedProperties | Sort-Object -CaseSensitive) -join '|') -or
        [string]$result.protocol -cne $script:DysonDeploymentConfigurationRestoreProtocol -or
        [string]$result.mode -cne 'apply' -or
        [string]$result.state -notin @('completed', 'recovered') -or
        [string]$result.operation -cne 'restore' -or
        $result.mutationPerformed -isnot [bool] -or -not [bool]$result.mutationPerformed) {
        throw 'The configuration restore executor returned an unsupported result.'
    }
    foreach ($digest in @(
            [string]$result.configurationSha256,
            [string]$result.configurationAclFingerprint,
            [string]$result.bindingsSha256, [string]$result.contractSha256,
            [string]$result.chainHeadSha256
        )) {
        if ($digest -cnotmatch '^[0-9a-f]{64}$') {
            throw 'The configuration restore executor returned invalid integrity evidence.'
        }
    }
    if ([int64]$result.configurationLength -lt 1 -or
        [int64]$result.configurationLength -gt 65536) {
        throw 'The configuration restore executor returned an invalid configuration length.'
    }
    return [pscustomobject][ordered]@{
        sourceSnapshotId = [string]$result.sourceSnapshotId
        preimageSnapshotId = [string]$result.preimageSnapshotId
        configurationSha256 = [string]$result.configurationSha256
        configurationLength = [int64]$result.configurationLength
        configurationAclFingerprint = [string]$result.configurationAclFingerprint
        configurationBindingsSha256 = [string]$result.bindingsSha256
        configurationContractSha256 = [string]$result.contractSha256
        chainHeadSha256 = [string]$result.chainHeadSha256
        completedTransactionCount = [int]$result.completedTransactionCount
    }
}

function Invoke-DysonDeploymentConfigurationTest {
    param(
        [Parameter(Mandatory)][string]$DataRoot,
        [Parameter(Mandatory)][string]$ScriptRoot,
        [Parameter(Mandatory)][string]$RuntimeBootstrapRoot,
        [Parameter(Mandatory)][string]$DeploymentVersion,
        [Parameter(Mandatory)][string]$ServiceAccount,
        [string]$ConfigurationModuleRoot
    )

    $moduleRoot = Get-DysonDeploymentConfigurationModuleRoot `
        -ConfigurationModuleRoot $ConfigurationModuleRoot
    $output = @(& (Join-Path $moduleRoot 'Test-DysonControlConfiguration.ps1') `
        -DataRoot $DataRoot -ScriptRoot $ScriptRoot `
        -RuntimeBootstrapRoot $RuntimeBootstrapRoot -DeploymentVersion $DeploymentVersion `
        -ServiceAccount $ServiceAccount)
    if ($output.Count -lt 1) { throw 'The configuration verifier returned no result.' }
    $result = $output[$output.Count - 1]
    if ([string]$result.protocol -cne $script:DysonDeploymentConfigurationTestProtocol -or
        $result.healthy -isnot [bool] -or -not [bool]$result.healthy -or
        $result.mutationPerformed -isnot [bool] -or [bool]$result.mutationPerformed -or
        $null -ne $result.snapshot -or $null -ne $result.restorePlan) {
        throw 'The configuration verifier returned an unsupported result.'
    }
    return ConvertTo-DysonDeploymentConfigurationEvidence -Result $result -Kind test
}

function Assert-DysonDeploymentConfigurationEvidenceMatch {
    param(
        [Parameter(Mandatory)]$Expected,
        [Parameter(Mandatory)]$Actual
    )

    foreach ($name in @(
        'configurationSha256', 'configurationLength', 'configurationBindingsSha256',
        'configurationContractSha256', 'configurationAclFingerprint',
        'configurationParentAclFingerprint'
    )) {
        if ([string]$Expected.$name -cne [string]$Actual.$name) {
            throw 'The protected configuration evidence changed during the deployment operation.'
        }
    }
}

function Assert-DysonDeploymentConfigurationPreflightUnchanged {
    param(
        [Parameter(Mandatory)]$Expected,
        [Parameter(Mandatory)]$Actual
    )

    foreach ($name in @(
        'configurationPath', 'sourceSha256', 'sourceLength', 'namesSha256',
        'bindingsSha256', 'contractSha256'
    )) {
        if ([string]$Expected.$name -cne [string]$Actual.$name) {
            throw 'The protected configuration source or binding changed after preflight.'
        }
    }
    if (($null -eq $Expected.existing) -ne ($null -eq $Actual.existing)) {
        throw 'The protected configuration target changed after preflight.'
    }
    if ($null -ne $Expected.existing) {
        $expectedEvidence = ConvertTo-DysonDeploymentConfigurationEvidence `
            -Result $Expected.existing -Kind preflight
        $actualEvidence = ConvertTo-DysonDeploymentConfigurationEvidence `
            -Result $Actual.existing -Kind preflight
        Assert-DysonDeploymentConfigurationEvidenceMatch -Expected $expectedEvidence -Actual $actualEvidence
    }
}
