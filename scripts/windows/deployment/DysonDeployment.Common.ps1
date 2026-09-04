Set-StrictMode -Version 2.0

$script:DysonPlatformSecurityModulePath = Join-Path $PSHOME 'Modules\Microsoft.PowerShell.Security\Microsoft.PowerShell.Security.psd1'
if (-not (Test-Path -LiteralPath $script:DysonPlatformSecurityModulePath -PathType Leaf)) {
    throw 'The platform security module required by Dyson Control deployment is unavailable.'
}
$script:DysonPlatformSecurityModules = @(Import-Module -Name $script:DysonPlatformSecurityModulePath -PassThru -ErrorAction Stop)
if ($script:DysonPlatformSecurityModules.Count -ne 1 -or
    -not [string]::Equals(
        [System.IO.Path]::GetFullPath([string]$script:DysonPlatformSecurityModules[0].Path),
        [System.IO.Path]::GetFullPath($script:DysonPlatformSecurityModulePath),
        [System.StringComparison]::OrdinalIgnoreCase
    ) -or
    -not $script:DysonPlatformSecurityModules[0].ExportedCommands.ContainsKey('Get-Acl') -or
    -not $script:DysonPlatformSecurityModules[0].ExportedCommands.ContainsKey('Set-Acl')) {
    throw 'The platform security module required by Dyson Control deployment has an invalid identity.'
}

$script:DysonDeploymentProtocol = 'DYSON_CONTROL_DEPLOYMENT_V1'
$script:DysonReleaseManifestName = 'release-manifest.json'
$script:DysonActivePointerName = 'active-release.json'
$script:DysonDeploymentIdentityProtocol = 'DYSON_CONTROL_DEPLOYMENT_IDENTITY_V1'
$script:DysonDeploymentIdentityName = 'deployment-identity.json'
$script:DysonArtifactVerifierProtocol = 'DYSON_CONTROL_RELEASE_ARTIFACT_V1'
$script:DysonArtifactManifestName = 'artifact-manifest.json'
$script:DysonArtifactMaximumFiles = 50000
$script:DysonArtifactMaximumBytes = [int64](2GB)
$script:DysonArtifactMaximumManifestBytes = [int64](32MB)
$script:DysonArtifactVerifierRelativePath = 'scripts\windows\release\Test-DysonControlReleaseArtifact.ps1'
$script:DysonArtifactVerifierCommonRelativePath = 'scripts\windows\release\DysonReleasePackaging.Common.ps1'
$script:DysonControlTaskPath = '\'
$script:DysonQualifiedClientStorageProtocol = 'DYSON_CONTROL_QUALIFIED_CLIENT_STORAGE_V1'
$script:DysonQualifiedClientEnvironmentNames = @(
    'DYSON_QUALIFIED_CLIENT_PROFILE_ENABLED',
    'DYSON_CLIENT_QUALIFICATION_EVIDENCE_ROOT',
    'DYSON_CLIENT_QUALIFICATION_BUILD_HARVEST_ROOT_A',
    'DYSON_CLIENT_QUALIFICATION_BUILD_HARVEST_ROOT_B',
    'DYSON_CLIENT_QUALIFICATION_KEY_RING_ROOT',
    'DYSON_CLIENT_QUALIFICATION_REPLAY_ROOT',
    'DYSON_QUALIFIED_CLIENT_ISSUE_ROOT',
    'DYSON_CLIENT_QUALIFICATION_AUTHORITY'
)

function Get-DysonFullPath {
    param([Parameter(Mandatory)][string]$Path)

    if ([string]::IsNullOrWhiteSpace($Path)) { throw 'A deployment path cannot be empty.' }
    if ([System.IO.Path]::IsPathRooted($Path)) { return [System.IO.Path]::GetFullPath($Path) }
    return [System.IO.Path]::GetFullPath((Join-Path (Get-Location).ProviderPath $Path))
}

function ConvertTo-DysonDeploymentExtendedPath {
    param([Parameter(Mandatory)][string]$Path)

    if ([string]::IsNullOrWhiteSpace($Path)) { throw 'A deployment path cannot be empty.' }
    if ($Path.StartsWith('\\?\', [System.StringComparison]::Ordinal)) { return $Path }
    $fullPath = Get-DysonFullPath -Path $Path
    if ($fullPath.StartsWith('\\', [System.StringComparison]::Ordinal)) {
        return '\\?\UNC\' + $fullPath.Substring(2)
    }
    return '\\?\' + $fullPath
}

function Assert-DysonVersion {
    param([Parameter(Mandatory)][string]$Version)

    if ($Version -notmatch '^[0-9A-Za-z][0-9A-Za-z._+-]{0,63}$') {
        throw 'The release version must contain only letters, numbers, dot, underscore, plus, or hyphen.'
    }
}

function Get-DysonNodeMinimumMajor {
    param([Parameter(Mandatory)]$Value)

    try { $major = [int]$Value }
    catch { throw 'The release Node.js runtime requirement is invalid.' }
    if ($major -lt 1 -or $major -gt 999) { throw 'The release Node.js runtime requirement is invalid.' }
    return $major
}

function Resolve-DysonNodeExecutablePath {
    param([Parameter(Mandatory)][string]$NodeExecutable)

    try {
        $resolved = (Resolve-Path -LiteralPath $NodeExecutable -ErrorAction Stop).ProviderPath
        $item = Get-Item -LiteralPath $resolved -Force -ErrorAction Stop
        if ($item.PSIsContainer -or ($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -or
            $item.Length -lt 1 -or $item.Length -gt 536870912) {
            throw 'invalid node executable'
        }
        return $item.FullName
    }
    catch { throw 'Node.js runtime verification failed.' }
}

function Assert-DysonNodeRuntimeHash {
    param(
        [Parameter(Mandatory)][string]$ExpectedNodeSha256,
        [Parameter(Mandatory)][string]$Name
    )

    if ($ExpectedNodeSha256 -cnotmatch '^[0-9a-f]{64}$') {
        throw "$Name must be a canonical lowercase SHA-256 digest."
    }
    return $ExpectedNodeSha256
}

function Get-DysonNodeRuntimeWriteMask {
    $rights = [System.Security.AccessControl.FileSystemRights]
    $mask = [int64]0
    foreach ($name in @(
        'WriteData', 'AppendData', 'WriteExtendedAttributes', 'WriteAttributes',
        'DeleteSubdirectoriesAndFiles', 'Delete', 'ChangePermissions', 'TakeOwnership'
    )) {
        $mask = $mask -bor [int64]$rights::$name
    }
    return $mask
}

function Get-DysonNodeRuntimeSelfTestAdministratorSid {
    param(
        [Parameter(Mandatory)][string]$RuntimeRoot,
        [Parameter(Mandatory)][string]$InstallRoot,
        [Parameter(Mandatory)][string]$DataRoot
    )

    if ($env:DYSON_DEPLOYMENT_ALLOW_SELFTEST_TASKS -cne 'true' -or
        [string]::IsNullOrWhiteSpace($env:DYSON_DEPLOYMENT_SELFTEST_ROOT_IDENTITY)) { return $null }
    $fixtureIdentity = (Get-DysonDeploymentPathIdentity `
        -Path $env:DYSON_DEPLOYMENT_SELFTEST_ROOT_IDENTITY).TrimEnd('\', '/')
    $temporaryIdentity = (Get-DysonDeploymentPathIdentity `
        -Path ([System.IO.Path]::GetTempPath())).TrimEnd('\', '/')
    if (-not (Test-DysonDeploymentIdentityPathWithin `
            -CandidateIdentity $fixtureIdentity -ParentIdentity $temporaryIdentity)) { return $null }
    $relative = $fixtureIdentity.Substring($temporaryIdentity.Length + 1)
    if ($relative -cnotmatch '^DYSON-CONTROL-DEPLOYMENT-SELFTEST-[0-9A-F]{32}$') { return $null }
    try { [void](Assert-DysonDeploymentPlainPathChain -Path $fixtureIdentity) }
    catch { return $null }
    $runtimeIdentity = Get-DysonDeploymentPathIdentity -Path $RuntimeRoot
    $installIdentity = Get-DysonDeploymentPathIdentity -Path $InstallRoot
    $dataIdentity = Get-DysonDeploymentPathIdentity -Path $DataRoot
    foreach ($identity in @($runtimeIdentity, $installIdentity, $dataIdentity)) {
        if (-not (Test-DysonDeploymentIdentityPathWithin `
                -CandidateIdentity $identity -ParentIdentity $fixtureIdentity)) { return $null }
    }
    return [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
}

function Assert-DysonNodeRuntimeAcl {
    param(
        [Parameter(Mandatory)][string]$Path,
        [Parameter(Mandatory)][string]$RuntimeRoot,
        [Parameter(Mandatory)][string]$InstallRoot,
        [Parameter(Mandatory)][string]$DataRoot
    )

    $ioPath = ConvertTo-DysonDeploymentExtendedPath -Path $Path
    $attributes = [System.IO.File]::GetAttributes($ioPath)
    if ($attributes -band [System.IO.FileAttributes]::ReparsePoint) {
        throw 'The Node.js runtime path contains a redirected entry.'
    }
    $acl = if ($attributes -band [System.IO.FileAttributes]::Directory) {
        [System.IO.Directory]::GetAccessControl($ioPath)
    }
    else { [System.IO.File]::GetAccessControl($ioPath) }
    if (-not $acl.AreAccessRulesProtected) {
        throw 'The Node.js runtime DACL must be protected from inherited access rules.'
    }
    $systemSid = 'S-1-5-18'
    $administratorsSid = 'S-1-5-32-544'
    $localServiceSid = 'S-1-5-19'
    $networkServiceSid = 'S-1-5-20'
    $fixtureAdministratorSid = Get-DysonNodeRuntimeSelfTestAdministratorSid `
        -RuntimeRoot $RuntimeRoot -InstallRoot $InstallRoot -DataRoot $DataRoot
    $allowedWriterSids = [System.Collections.Generic.HashSet[string]]::new(
        [System.StringComparer]::OrdinalIgnoreCase
    )
    [void]$allowedWriterSids.Add($systemSid)
    [void]$allowedWriterSids.Add($administratorsSid)
    if (-not [string]::IsNullOrWhiteSpace($fixtureAdministratorSid)) {
        [void]$allowedWriterSids.Add($fixtureAdministratorSid)
    }
    try { $ownerSid = $acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value }
    catch { throw 'The Node.js runtime owner could not be verified.' }
    if (-not $allowedWriterSids.Contains($ownerSid)) {
        throw 'The Node.js runtime owner is not SYSTEM or Administrators.'
    }

    $fullControl = [int64][System.Security.AccessControl.FileSystemRights]::FullControl
    $readAndExecute = [int64][System.Security.AccessControl.FileSystemRights]::ReadAndExecute
    $localServiceAllowed = $readAndExecute -bor `
        [int64][System.Security.AccessControl.FileSystemRights]::Synchronize
    $writeMask = Get-DysonNodeRuntimeWriteMask
    $allowBySid = @{}
    foreach ($rule in @($acl.GetAccessRules(
        $true, $true, [System.Security.Principal.SecurityIdentifier]
    ))) {
        $sid = [string]$rule.IdentityReference.Value
        $rights = [int64]$rule.FileSystemRights
        if ($rule.AccessControlType -eq [System.Security.AccessControl.AccessControlType]::Deny) {
            if ($sid -in @($systemSid, $administratorsSid, $localServiceSid, $networkServiceSid) -and
                $rights -ne 0) {
                throw 'The Node.js runtime DACL denies required platform access.'
            }
            continue
        }
        if (-not $allowBySid.ContainsKey($sid)) { $allowBySid[$sid] = [int64]0 }
        $allowBySid[$sid] = [int64]$allowBySid[$sid] -bor $rights
        if (($rights -band $writeMask) -ne 0 -and -not $allowedWriterSids.Contains($sid)) {
            throw 'The Node.js runtime grants write access to an untrusted identity.'
        }
        if ($sid -in @($localServiceSid, $networkServiceSid) -and
            (($rights -band $writeMask) -ne 0 -or ($rights -band (-bnot $localServiceAllowed)) -ne 0)) {
            throw 'The control-plane service identities must have read-and-execute access only to the Node.js runtime.'
        }
    }
    foreach ($requiredSid in @($systemSid, $administratorsSid)) {
        if (-not $allowBySid.ContainsKey($requiredSid) -or
            (([int64]$allowBySid[$requiredSid] -band $fullControl) -ne $fullControl)) {
            throw 'The Node.js runtime does not grant SYSTEM and Administrators FullControl.'
        }
    }
    foreach ($serviceSid in @($localServiceSid, $networkServiceSid)) {
        if (-not $allowBySid.ContainsKey($serviceSid) -or
            (([int64]$allowBySid[$serviceSid] -band $readAndExecute) -ne $readAndExecute) -or
            (([int64]$allowBySid[$serviceSid] -band $writeMask) -ne 0)) {
            throw 'The Node.js runtime does not grant the supported service identities read-and-execute access only.'
        }
    }
}

function Set-DysonNodeRuntimeProtectionAcl {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][string]$RuntimeRoot,
        [Parameter(Mandatory)][string]$InstallRoot,
        [Parameter(Mandatory)][string]$DataRoot,
        [switch]$AllowSelfTestAdministrator
    )

    $runtimeFull = Assert-DysonSafeRoot -Path $RuntimeRoot -Name 'RuntimeRoot'
    $fixtureSid = Get-DysonNodeRuntimeSelfTestAdministratorSid -RuntimeRoot $runtimeFull `
        -InstallRoot $InstallRoot -DataRoot $DataRoot
    if ($AllowSelfTestAdministrator -and [string]::IsNullOrWhiteSpace($fixtureSid)) {
        throw 'The runtime ACL fixture exception is outside the authorized isolated self-test root.'
    }
    $ownerSid = if ($AllowSelfTestAdministrator) {
        [System.Security.Principal.SecurityIdentifier]::new($fixtureSid)
    }
    else { [System.Security.Principal.SecurityIdentifier]::new('S-1-5-32-544') }
    $systemSid = [System.Security.Principal.SecurityIdentifier]::new('S-1-5-18')
    $administratorsSid = [System.Security.Principal.SecurityIdentifier]::new('S-1-5-32-544')
    $localServiceSid = [System.Security.Principal.SecurityIdentifier]::new('S-1-5-19')
    $networkServiceSid = [System.Security.Principal.SecurityIdentifier]::new('S-1-5-20')
    $fixturePrincipal = if ($AllowSelfTestAdministrator) {
        [System.Security.Principal.SecurityIdentifier]::new($fixtureSid)
    }
    else { $null }
    $items = @((Get-Item -LiteralPath $runtimeFull -Force -ErrorAction Stop)) +
        @(Get-ChildItem -LiteralPath $runtimeFull -Force -Recurse -ErrorAction Stop)
    foreach ($item in $items) {
        if ($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) {
            throw 'The Node.js runtime tree contains a redirected entry.'
        }
        $acl = if ($item.PSIsContainer) {
            [System.Security.AccessControl.DirectorySecurity]::new()
        }
        else { [System.Security.AccessControl.FileSecurity]::new() }
        $acl.SetAccessRuleProtection($true, $false)
        $acl.SetOwner($ownerSid)
        $inheritance = if ($item.PSIsContainer) {
            [System.Security.AccessControl.InheritanceFlags]'ContainerInherit, ObjectInherit'
        }
        else { [System.Security.AccessControl.InheritanceFlags]::None }
        foreach ($principal in @($systemSid, $administratorsSid)) {
            $acl.AddAccessRule([System.Security.AccessControl.FileSystemAccessRule]::new(
                $principal,
                [System.Security.AccessControl.FileSystemRights]::FullControl,
                $inheritance,
                [System.Security.AccessControl.PropagationFlags]::None,
                [System.Security.AccessControl.AccessControlType]::Allow
            ))
        }
        foreach ($serviceSid in @($localServiceSid, $networkServiceSid)) {
            $acl.AddAccessRule([System.Security.AccessControl.FileSystemAccessRule]::new(
                $serviceSid,
                [System.Security.AccessControl.FileSystemRights]::ReadAndExecute,
                $inheritance,
                [System.Security.AccessControl.PropagationFlags]::None,
                [System.Security.AccessControl.AccessControlType]::Allow
            ))
        }
        if ($fixturePrincipal -and
            -not [string]::Equals($fixturePrincipal.Value, $administratorsSid.Value,
                [System.StringComparison]::OrdinalIgnoreCase)) {
            $acl.AddAccessRule([System.Security.AccessControl.FileSystemAccessRule]::new(
                $fixturePrincipal,
                [System.Security.AccessControl.FileSystemRights]::FullControl,
                $inheritance,
                [System.Security.AccessControl.PropagationFlags]::None,
                [System.Security.AccessControl.AccessControlType]::Allow
            ))
        }
        $itemIoPath = ConvertTo-DysonDeploymentExtendedPath -Path $item.FullName
        if ($item.PSIsContainer) {
            [System.IO.Directory]::SetAccessControl($itemIoPath, $acl)
        }
        else { [System.IO.File]::SetAccessControl($itemIoPath, $acl) }
    }
}

function Set-DysonNodeRuntimeContainerProtectionAcl {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][string]$RuntimeContainer,
        [Parameter(Mandatory)][string]$RuntimeRoot,
        [Parameter(Mandatory)][string]$InstallRoot,
        [Parameter(Mandatory)][string]$DataRoot,
        [switch]$AllowSelfTestAdministrator
    )

    $containerFull = Assert-DysonSafeRoot -Path $RuntimeContainer -Name 'RuntimeContainer'
    $runtimeFull = Assert-DysonSafeRoot -Path $RuntimeRoot -Name 'RuntimeRoot'
    $expectedContainer = [System.IO.Path]::GetDirectoryName($runtimeFull.TrimEnd('\', '/'))
    if ([string]::IsNullOrWhiteSpace($expectedContainer) -or
        -not [string]::Equals(
            $containerFull.TrimEnd('\', '/'),
            $expectedContainer.TrimEnd('\', '/'),
            [System.StringComparison]::OrdinalIgnoreCase
        )) {
        throw 'RuntimeContainer must be the direct parent of RuntimeRoot.'
    }
    $item = Get-Item -LiteralPath $containerFull -Force -ErrorAction Stop
    if (-not $item.PSIsContainer -or
        ($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint)) {
        throw 'The Node.js runtime container is unavailable or redirected.'
    }
    $fixtureSid = Get-DysonNodeRuntimeSelfTestAdministratorSid -RuntimeRoot $runtimeFull `
        -InstallRoot $InstallRoot -DataRoot $DataRoot
    if ($AllowSelfTestAdministrator -and [string]::IsNullOrWhiteSpace($fixtureSid)) {
        throw 'The runtime-container ACL fixture exception is outside the authorized isolated self-test root.'
    }
    $ownerSid = if ($AllowSelfTestAdministrator) {
        [System.Security.Principal.SecurityIdentifier]::new($fixtureSid)
    }
    else { [System.Security.Principal.SecurityIdentifier]::new('S-1-5-32-544') }
    $systemSid = [System.Security.Principal.SecurityIdentifier]::new('S-1-5-18')
    $administratorsSid = [System.Security.Principal.SecurityIdentifier]::new('S-1-5-32-544')
    $localServiceSid = [System.Security.Principal.SecurityIdentifier]::new('S-1-5-19')
    $networkServiceSid = [System.Security.Principal.SecurityIdentifier]::new('S-1-5-20')
    $fixturePrincipal = if ($AllowSelfTestAdministrator) {
        [System.Security.Principal.SecurityIdentifier]::new($fixtureSid)
    }
    else { $null }
    $acl = [System.Security.AccessControl.DirectorySecurity]::new()
    $acl.SetAccessRuleProtection($true, $false)
    $acl.SetOwner($ownerSid)
    $inheritance = [System.Security.AccessControl.InheritanceFlags]'ContainerInherit, ObjectInherit'
    foreach ($principal in @($systemSid, $administratorsSid)) {
        $acl.AddAccessRule([System.Security.AccessControl.FileSystemAccessRule]::new(
            $principal,
            [System.Security.AccessControl.FileSystemRights]::FullControl,
            $inheritance,
            [System.Security.AccessControl.PropagationFlags]::None,
            [System.Security.AccessControl.AccessControlType]::Allow
        ))
    }
    foreach ($serviceSid in @($localServiceSid, $networkServiceSid)) {
        $acl.AddAccessRule([System.Security.AccessControl.FileSystemAccessRule]::new(
            $serviceSid,
            [System.Security.AccessControl.FileSystemRights]::ReadAndExecute,
            $inheritance,
            [System.Security.AccessControl.PropagationFlags]::None,
            [System.Security.AccessControl.AccessControlType]::Allow
        ))
    }
    if ($fixturePrincipal -and
        -not [string]::Equals(
            $fixturePrincipal.Value,
            $administratorsSid.Value,
            [System.StringComparison]::OrdinalIgnoreCase
        )) {
        $acl.AddAccessRule([System.Security.AccessControl.FileSystemAccessRule]::new(
            $fixturePrincipal,
            [System.Security.AccessControl.FileSystemRights]::FullControl,
            $inheritance,
            [System.Security.AccessControl.PropagationFlags]::None,
            [System.Security.AccessControl.AccessControlType]::Allow
        ))
    }
    [System.IO.Directory]::SetAccessControl($item.FullName, $acl)
}

function Assert-DysonNodeRuntimeContainerProtection {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][string]$RuntimeRoot,
        [Parameter(Mandatory)][string]$InstallRoot,
        [Parameter(Mandatory)][string]$DataRoot
    )

    $runtimeFull = Assert-DysonSafeRoot -Path $RuntimeRoot -Name 'RuntimeRoot'
    $installFull = Assert-DysonSafeRoot -Path $InstallRoot -Name 'InstallRoot'
    $dataFull = Assert-DysonSafeRoot -Path $DataRoot -Name 'DataRoot'
    $containerPath = [System.IO.Path]::GetDirectoryName($runtimeFull.TrimEnd('\', '/'))
    if ([string]::IsNullOrWhiteSpace($containerPath)) {
        throw 'RuntimeRoot must have a bounded direct parent container.'
    }
    $containerFull = Assert-DysonSafeRoot -Path $containerPath -Name 'RuntimeContainer'
    foreach ($otherRoot in @($installFull, $dataFull)) {
        if ((Test-DysonPathWithin -Candidate $containerFull -Parent $otherRoot -AllowEqual) -or
            (Test-DysonPathWithin -Candidate $otherRoot -Parent $containerFull -AllowEqual)) {
            throw 'RuntimeContainer must be a separate directory tree from InstallRoot and DataRoot.'
        }
    }
    [void](Assert-DysonDeploymentPlainPathChain -Path $containerFull)
    Assert-DysonNodeRuntimeAcl -Path $containerFull -RuntimeRoot $runtimeFull `
        -InstallRoot $installFull -DataRoot $dataFull
    return [pscustomobject][ordered]@{
        runtimeContainer = $containerFull
        runtimeContainerIdentity = 'sha256:' + (Get-DysonTextSha256 `
            -Value (Get-DysonDeploymentPathIdentity -Path $containerFull))
    }
}

function Assert-DysonNodeRuntimeProtection {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][string]$RuntimeRoot,
        [Parameter(Mandatory)][string]$NodeExecutable,
        [Parameter(Mandatory)][string]$ExpectedNodeSha256,
        [Parameter(Mandatory)][string]$InstallRoot,
        [Parameter(Mandatory)][string]$DataRoot
    )

    [void](Assert-DysonNodeRuntimeHash -ExpectedNodeSha256 $ExpectedNodeSha256 `
        -Name 'ExpectedNodeSha256')
    $runtimeFull = Assert-DysonSafeRoot -Path $RuntimeRoot -Name 'RuntimeRoot'
    $installFull = Assert-DysonSafeRoot -Path $InstallRoot -Name 'InstallRoot'
    $dataFull = Assert-DysonSafeRoot -Path $DataRoot -Name 'DataRoot'
    foreach ($otherRoot in @($installFull, $dataFull)) {
        if ((Test-DysonPathWithin -Candidate $runtimeFull -Parent $otherRoot -AllowEqual) -or
            (Test-DysonPathWithin -Candidate $otherRoot -Parent $runtimeFull -AllowEqual)) {
            throw 'RuntimeRoot must be a separate directory tree from InstallRoot and DataRoot.'
        }
    }
    $containerProtection = Assert-DysonNodeRuntimeContainerProtection -RuntimeRoot $runtimeFull `
        -InstallRoot $installFull -DataRoot $dataFull
    [void](Assert-DysonDeploymentPlainPathChain -Path $runtimeFull)
    $nodePath = Resolve-DysonNodeExecutablePath -NodeExecutable $NodeExecutable
    if (-not (Test-DysonPathWithin -Candidate $nodePath -Parent $runtimeFull)) {
        throw 'NodeExecutable must remain below the independent RuntimeRoot.'
    }
    $current = [System.IO.Path]::GetDirectoryName($nodePath).TrimEnd('\', '/')
    $runtimeBoundary = $runtimeFull.TrimEnd('\', '/')
    while ($true) {
        $directoryItem = Get-Item -LiteralPath $current -Force -ErrorAction Stop
        if (-not $directoryItem.PSIsContainer -or
            ($directoryItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint)) {
            throw 'The Node.js runtime path contains a redirected directory.'
        }
        Assert-DysonNodeRuntimeAcl -Path $directoryItem.FullName -RuntimeRoot $runtimeFull `
            -InstallRoot $installFull -DataRoot $dataFull
        if ([string]::Equals($current, $runtimeBoundary, [System.StringComparison]::OrdinalIgnoreCase)) { break }
        $parent = [System.IO.Path]::GetDirectoryName($current)
        if ([string]::IsNullOrWhiteSpace($parent) -or
            -not (Test-DysonPathWithin -Candidate $parent -Parent $runtimeBoundary -AllowEqual)) {
            throw 'The Node.js runtime path escaped RuntimeRoot.'
        }
        $current = $parent.TrimEnd('\', '/')
    }
    Assert-DysonNodeRuntimeAcl -Path $nodePath -RuntimeRoot $runtimeFull `
        -InstallRoot $installFull -DataRoot $dataFull
    $actualSha256 = Get-DysonFileSha256 -Path $nodePath
    if (-not [string]::Equals($actualSha256, $ExpectedNodeSha256,
            [System.StringComparison]::Ordinal)) {
        throw 'The Node.js runtime SHA-256 digest does not match ExpectedNodeSha256.'
    }
    $postHashItem = Get-Item -LiteralPath $nodePath -Force -ErrorAction Stop
    if ($postHashItem.PSIsContainer -or
        ($postHashItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -or
        -not [string]::Equals($postHashItem.FullName, $nodePath,
            [System.StringComparison]::OrdinalIgnoreCase)) {
        throw 'The Node.js runtime identity changed during verification.'
    }
    return [pscustomobject][ordered]@{
        runtimeRoot = $runtimeFull
        runtimeRootIdentity = 'sha256:' + (Get-DysonTextSha256 `
            -Value (Get-DysonDeploymentPathIdentity -Path $runtimeFull))
        runtimeContainerIdentity = [string]$containerProtection.runtimeContainerIdentity
        nodeExecutable = $nodePath
        nodeExecutableSha256 = $actualSha256
        protected = $true
    }
}

function Test-DysonNodeRuntime {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][string]$RuntimeRoot,
        [Parameter(Mandatory)][string]$NodeExecutable,
        [Parameter(Mandatory)][string]$ExpectedNodeSha256,
        [Parameter(Mandatory)][string]$InstallRoot,
        [Parameter(Mandatory)][string]$DataRoot,
        [Parameter(Mandatory)]$MinimumMajor,
        [ValidateRange(100, 10000)][int]$TimeoutMilliseconds = 3000,
        [ValidateRange(32, 1024)][int]$MaximumOutputCharacters = 128
    )

    $protection = Assert-DysonNodeRuntimeProtection -RuntimeRoot $RuntimeRoot `
        -NodeExecutable $NodeExecutable -ExpectedNodeSha256 $ExpectedNodeSha256 `
        -InstallRoot $InstallRoot -DataRoot $DataRoot
    $nodePath = [string]$protection.nodeExecutable
    $requiredMajor = Get-DysonNodeMinimumMajor -Value $MinimumMajor
    $process = $null
    try {
        $startInfo = [System.Diagnostics.ProcessStartInfo]::new()
        $startInfo.FileName = $nodePath
        $startInfo.Arguments = '--version'
        $startInfo.WorkingDirectory = [System.IO.Path]::GetTempPath()
        $startInfo.UseShellExecute = $false
        $startInfo.CreateNoWindow = $true
        $startInfo.RedirectStandardOutput = $true
        $startInfo.RedirectStandardError = $true
        [void]$startInfo.EnvironmentVariables.Remove('NODE_OPTIONS')
        [void]$startInfo.EnvironmentVariables.Remove('NODE_PATH')

        $process = [System.Diagnostics.Process]::new()
        $process.StartInfo = $startInfo
        if (-not $process.Start()) { throw 'node probe did not start' }
        $stdoutTask = $process.StandardOutput.ReadToEndAsync()
        $stderrTask = $process.StandardError.ReadToEndAsync()
        if (-not $process.WaitForExit($TimeoutMilliseconds)) {
            try { $process.Kill() } catch {}
            try { $process.WaitForExit() } catch {}
            throw 'node probe timed out'
        }
        $process.WaitForExit()
        $stdout = [string]$stdoutTask.GetAwaiter().GetResult()
        $stderr = [string]$stderrTask.GetAwaiter().GetResult()
        $exitCode = [int]$process.ExitCode
    }
    catch { throw 'Node.js runtime verification failed.' }
    finally {
        if ($process) { $process.Dispose() }
    }

    if ($stdout.Length -gt $MaximumOutputCharacters -or $stderr.Length -gt $MaximumOutputCharacters -or
        $exitCode -ne 0 -or $stderr.Length -ne 0 -or
        $stdout -notmatch '^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\r?\n?$') {
        throw 'Node.js runtime verification failed.'
    }
    try { $actualMajor = [int]$Matches[1] }
    catch { throw 'Node.js runtime verification failed.' }
    if ($actualMajor -lt $requiredMajor) { throw 'Node.js runtime verification failed.' }
    return [pscustomobject][ordered]@{
        version = $stdout.TrimEnd("`r", "`n")
        major = $actualMajor
        minimumMajor = $requiredMajor
        nodeExecutable = $nodePath
        runtimeRootIdentity = [string]$protection.runtimeRootIdentity
        nodeExecutableSha256 = [string]$protection.nodeExecutableSha256
        protected = $true
    }
}

function Assert-DysonRelativePath {
    param(
        [Parameter(Mandatory)][string]$Path,
        [Parameter(Mandatory)][string]$Name
    )

    if ([string]::IsNullOrWhiteSpace($Path) -or [System.IO.Path]::IsPathRooted($Path) -or
        $Path -match '(^|[\\/])\.\.([\\/]|$)' -or $Path.IndexOf([char]0) -ge 0 -or $Path -match '["\r\n]') {
        throw "$Name must be a bounded relative path."
    }
}

function Test-DysonPathWithin {
    param(
        [Parameter(Mandatory)][string]$Candidate,
        [Parameter(Mandatory)][string]$Parent,
        [switch]$AllowEqual
    )

    $candidateFull = (Get-DysonFullPath -Path $Candidate).TrimEnd('\', '/')
    $parentFull = (Get-DysonFullPath -Path $Parent).TrimEnd('\', '/')
    if ($AllowEqual -and [string]::Equals($candidateFull, $parentFull, [System.StringComparison]::OrdinalIgnoreCase)) {
        return $true
    }
    $prefix = $parentFull + [System.IO.Path]::DirectorySeparatorChar
    return $candidateFull.StartsWith($prefix, [System.StringComparison]::OrdinalIgnoreCase)
}

function Assert-DysonSafeRoot {
    param(
        [Parameter(Mandatory)][string]$Path,
        [Parameter(Mandatory)][string]$Name
    )

    $fullPath = Get-DysonFullPath -Path $Path
    $root = [System.IO.Path]::GetPathRoot($fullPath)
    if ([string]::Equals($fullPath.TrimEnd('\', '/'), $root.TrimEnd('\', '/'), [System.StringComparison]::OrdinalIgnoreCase)) {
        throw "$Name cannot be a filesystem root."
    }
    return $fullPath
}

function Get-DysonDeploymentPathIdentity {
    param([Parameter(Mandatory)][string]$Path)

    $fullPath = (Get-DysonFullPath -Path $Path).TrimEnd('\', '/')
    $pathRoot = [System.IO.Path]::GetPathRoot($fullPath)
    if ($pathRoot -match '^(?<drive>[A-Za-z]):[\\/]$') {
        $drive = Get-PSDrive -Name $Matches['drive'] -PSProvider FileSystem -ErrorAction SilentlyContinue
        if ($null -ne $drive) {
            $mappedRoot = if (-not [string]::IsNullOrWhiteSpace([string]$drive.DisplayRoot)) {
                [string]$drive.DisplayRoot
            }
            elseif (-not [string]::Equals(
                ([string]$drive.Root).TrimEnd('\', '/'),
                $pathRoot.TrimEnd('\', '/'),
                [System.StringComparison]::OrdinalIgnoreCase
            )) { [string]$drive.Root }
            else { $null }
            if (-not [string]::IsNullOrWhiteSpace($mappedRoot)) {
                $relative = $fullPath.Substring($pathRoot.Length).TrimStart('\', '/')
                $fullPath = (Get-DysonFullPath -Path $(
                    if ($relative.Length -eq 0) { $mappedRoot }
                    else { Join-Path $mappedRoot $relative }
                )).TrimEnd('\', '/')
            }
        }
    }
    return $fullPath.ToUpperInvariant()
}

function Test-DysonDeploymentIdentityPathWithin {
    param(
        [Parameter(Mandatory)][string]$CandidateIdentity,
        [Parameter(Mandatory)][string]$ParentIdentity,
        [switch]$AllowEqual
    )

    $candidate = $CandidateIdentity.TrimEnd('\', '/')
    $parent = $ParentIdentity.TrimEnd('\', '/')
    if ($AllowEqual -and [string]::Equals(
        $candidate, $parent, [System.StringComparison]::OrdinalIgnoreCase
    )) { return $true }
    return $candidate.StartsWith(
        $parent + [System.IO.Path]::DirectorySeparatorChar,
        [System.StringComparison]::OrdinalIgnoreCase
    )
}

function Test-DysonDeploymentAuthorizedSelfTestLayout {
    param(
        [Parameter(Mandatory)][string]$InstallIdentity,
        [Parameter(Mandatory)][string]$DataIdentity
    )

    if ($env:DYSON_DEPLOYMENT_ALLOW_SELFTEST_TASKS -cne 'true') { return $false }
    $authorizedRoots = New-Object System.Collections.Generic.List[string]
    $authorization = Get-Variable -Name DysonDeploymentAuthorizedSelfTestRoots `
        -Scope Global -ErrorAction SilentlyContinue
    if ($null -ne $authorization -and
        $authorization.Value -is [System.Collections.Generic.HashSet[string]]) {
        foreach ($fixtureRootIdentity in @($authorization.Value)) {
            $authorizedRoots.Add([string]$fixtureRootIdentity)
        }
    }
    if (-not [string]::IsNullOrWhiteSpace($env:DYSON_DEPLOYMENT_SELFTEST_ROOT_IDENTITY)) {
        try {
            $environmentRootIdentity = (Get-DysonDeploymentPathIdentity `
                -Path $env:DYSON_DEPLOYMENT_SELFTEST_ROOT_IDENTITY).TrimEnd('\', '/')
            $temporaryIdentity = (Get-DysonDeploymentPathIdentity `
                -Path ([System.IO.Path]::GetTempPath())).TrimEnd('\', '/')
            if (-not (Test-DysonDeploymentIdentityPathWithin `
                    -CandidateIdentity $environmentRootIdentity -ParentIdentity $temporaryIdentity)) {
                throw 'invalid self-test root'
            }
            $relative = $environmentRootIdentity.Substring($temporaryIdentity.Length + 1)
            if ($relative -cnotmatch '^DYSON-CONTROL-DEPLOYMENT-SELFTEST-[0-9A-F]{32}$') {
                throw 'invalid self-test root'
            }
            [void](Assert-DysonDeploymentPlainPathChain -Path $environmentRootIdentity)
            $authorizedRoots.Add($environmentRootIdentity)
        }
        catch { return $false }
    }
    foreach ($fixtureRootIdentity in @($authorizedRoots)) {
        if ((Test-DysonDeploymentIdentityPathWithin -CandidateIdentity $InstallIdentity `
                -ParentIdentity ([string]$fixtureRootIdentity)) -and
            (Test-DysonDeploymentIdentityPathWithin -CandidateIdentity $DataIdentity `
                -ParentIdentity ([string]$fixtureRootIdentity))) {
            return $true
        }
    }
    return $false
}

function Assert-DysonDeploymentDestructiveRootLayout {
    param(
        [Parameter(Mandatory)][string]$InstallRoot,
        [Parameter(Mandatory)][string]$DataRoot
    )

    $installFull = Assert-DysonSafeRoot -Path $InstallRoot -Name 'InstallRoot'
    $dataFull = Assert-DysonSafeRoot -Path $DataRoot -Name 'DataRoot'
    $installIdentity = Get-DysonDeploymentPathIdentity -Path $installFull
    $dataIdentity = Get-DysonDeploymentPathIdentity -Path $dataFull
    if ((Test-DysonDeploymentIdentityPathWithin -CandidateIdentity $installIdentity `
            -ParentIdentity $dataIdentity -AllowEqual) -or
        (Test-DysonDeploymentIdentityPathWithin -CandidateIdentity $dataIdentity `
            -ParentIdentity $installIdentity -AllowEqual)) {
        throw 'InstallRoot and DataRoot must be separate directory trees.'
    }

    $isolatedSelfTestLayout = Test-DysonDeploymentAuthorizedSelfTestLayout `
        -InstallIdentity $installIdentity -DataIdentity $dataIdentity
    if (-not $isolatedSelfTestLayout) {
        $protectedTrees = New-Object System.Collections.Generic.List[string]
        foreach ($candidate in @(
            $env:SystemRoot,
            $env:windir,
            $env:USERPROFILE,
            $env:PUBLIC,
            $(if ($env:USERPROFILE) { [System.IO.Path]::GetDirectoryName($env:USERPROFILE) } else { $null })
        )) {
            if (-not [string]::IsNullOrWhiteSpace([string]$candidate)) {
                try { $protectedTrees.Add((Get-DysonDeploymentPathIdentity -Path ([string]$candidate))) }
                catch { }
            }
        }
        foreach ($identity in @($installIdentity, $dataIdentity)) {
            foreach ($protectedTree in $protectedTrees) {
                if (Test-DysonDeploymentIdentityPathWithin -CandidateIdentity $identity `
                    -ParentIdentity $protectedTree -AllowEqual) {
                    throw 'A destructive deployment root cannot be inside a protected Windows or user directory.'
                }
            }
        }

        foreach ($managedRoot in @($env:ProgramFiles, ${env:ProgramFiles(x86)}, $env:ProgramData)) {
            if ([string]::IsNullOrWhiteSpace([string]$managedRoot)) { continue }
            $managedIdentity = Get-DysonDeploymentPathIdentity -Path ([string]$managedRoot)
            $canonicalIdentity = Get-DysonDeploymentPathIdentity `
                -Path (Join-Path ([string]$managedRoot) 'DysonControl')
            foreach ($identity in @($installIdentity, $dataIdentity)) {
                if ((Test-DysonDeploymentIdentityPathWithin -CandidateIdentity $identity `
                        -ParentIdentity $managedIdentity -AllowEqual) -and
                    -not [string]::Equals(
                        $identity, $canonicalIdentity, [System.StringComparison]::OrdinalIgnoreCase
                    )) {
                    throw 'A destructive deployment root inside Program Files or ProgramData must use the canonical DysonControl directory.'
                }
            }
        }
    }
    return [pscustomobject][ordered]@{
        installRoot = $installFull
        dataRoot = $dataFull
        installRootIdentity = $installIdentity
        dataRootIdentity = $dataIdentity
    }
}

function Assert-DysonDeploymentPlainPathChain {
    param([Parameter(Mandatory)][string]$Path)

    $fullPath = Get-DysonFullPath -Path $Path
    $target = Get-Item -LiteralPath $fullPath -Force -ErrorAction Stop
    if (-not $target.PSIsContainer -or
        ($target.Attributes -band [System.IO.FileAttributes]::ReparsePoint)) {
        throw 'A destructive deployment root is unavailable or redirected.'
    }
    $root = [System.IO.Path]::GetPathRoot($fullPath).TrimEnd('\', '/')
    $current = $target.FullName.TrimEnd('\', '/')
    while (-not [string]::Equals($current, $root, [System.StringComparison]::OrdinalIgnoreCase)) {
        $item = Get-Item -LiteralPath $current -Force -ErrorAction Stop
        if (-not $item.PSIsContainer -or
            ($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint)) {
            throw 'A destructive deployment path contains a redirected directory.'
        }
        $parent = [System.IO.Path]::GetDirectoryName($current)
        if ([string]::IsNullOrWhiteSpace($parent) -or
            [string]::Equals($parent, $current, [System.StringComparison]::OrdinalIgnoreCase)) { break }
        $current = $parent.TrimEnd('\', '/')
    }
    return $target.FullName
}

function Assert-DysonDeploymentPlainTree {
    param([Parameter(Mandatory)][string]$Path)

    $root = Assert-DysonDeploymentPlainPathChain -Path $Path
    $pending = New-Object 'System.Collections.Generic.Queue[string]'
    $pending.Enqueue((ConvertTo-DysonDeploymentExtendedPath -Path $root))
    while ($pending.Count -gt 0) {
        $directory = $pending.Dequeue()
        foreach ($entry in @([System.IO.Directory]::EnumerateFileSystemEntries($directory))) {
            $attributes = [System.IO.File]::GetAttributes($entry)
            if ($attributes -band [System.IO.FileAttributes]::ReparsePoint) {
                throw 'A destructive deployment tree contains a redirected entry.'
            }
            if ($attributes -band [System.IO.FileAttributes]::Directory) {
                $pending.Enqueue($entry)
            }
        }
    }
    return $root
}

function Get-DysonDeploymentIdentityMarkerPath {
    param([Parameter(Mandatory)][string]$InstallRoot)
    return Join-Path $InstallRoot $script:DysonDeploymentIdentityName
}

function Read-DysonDeploymentIdentityMarker {
    param(
        [Parameter(Mandatory)][string]$MarkerPath,
        [Parameter(Mandatory)][string]$ExpectedInstallRoot,
        [Parameter(Mandatory)][string]$ExpectedDataRoot
    )

    $message = 'The Dyson Control deployment identity marker is missing, redirected, or invalid.'
    try {
        $fullPath = Get-DysonFullPath -Path $MarkerPath
        $ioPath = ConvertTo-DysonDeploymentExtendedPath -Path $fullPath
        $attributes = [System.IO.File]::GetAttributes($ioPath)
        $fileInfo = [System.IO.FileInfo]::new($ioPath)
        if (($attributes -band [System.IO.FileAttributes]::Directory) -or
            ($attributes -band [System.IO.FileAttributes]::ReparsePoint) -or
            $fileInfo.Length -lt 1 -or $fileInfo.Length -gt 8192) { throw 'invalid marker file' }
        $raw = [System.IO.File]::ReadAllText(
            $ioPath, [System.Text.UTF8Encoding]::new($false, $true)
        ) | ConvertFrom-Json -ErrorAction Stop
        $actualNames = @($raw.PSObject.Properties.Name | Sort-Object)
        $expectedNames = @(
            'createdAt', 'dataRootIdentity', 'deploymentId', 'installRootIdentity',
            'protocol', 'schemaVersion'
        ) | Sort-Object
        if ($actualNames.Count -ne $expectedNames.Count) { throw 'invalid marker shape' }
        for ($index = 0; $index -lt $expectedNames.Count; $index += 1) {
            if ([string]$actualNames[$index] -cne [string]$expectedNames[$index]) {
                throw 'invalid marker shape'
            }
        }
        $parsedId = [guid]::Empty
        $parsedCreatedAt = [datetimeoffset]::MinValue
        $expectedInstallIdentity = Get-DysonDeploymentPathIdentity -Path $ExpectedInstallRoot
        $expectedDataIdentity = Get-DysonDeploymentPathIdentity -Path $ExpectedDataRoot
        if ([string]$raw.protocol -cne $script:DysonDeploymentIdentityProtocol -or
            [int]$raw.schemaVersion -ne 1 -or
            -not [guid]::TryParseExact([string]$raw.deploymentId, 'D', [ref]$parsedId) -or
            [string]$raw.deploymentId -cne $parsedId.ToString('D').ToLowerInvariant() -or
            -not [datetimeoffset]::TryParseExact(
                [string]$raw.createdAt, 'o', [Globalization.CultureInfo]::InvariantCulture,
                [Globalization.DateTimeStyles]::RoundtripKind, [ref]$parsedCreatedAt
            ) -or
            [string]$raw.installRootIdentity -cne $expectedInstallIdentity -or
            [string]$raw.dataRootIdentity -cne $expectedDataIdentity) {
            throw 'invalid marker binding'
        }
        return [pscustomobject][ordered]@{
            marker = $raw
            markerPath = $fullPath
            markerSha256 = Get-DysonFileSha256 -Path $fullPath
        }
    }
    catch { throw $message }
}

function Get-DysonDeploymentIdentity {
    param(
        [Parameter(Mandatory)][string]$InstallRoot,
        [Parameter(Mandatory)][string]$DataRoot
    )

    $layout = Assert-DysonDeploymentDestructiveRootLayout -InstallRoot $InstallRoot -DataRoot $DataRoot
    [void](Assert-DysonDeploymentPlainPathChain -Path ([string]$layout.installRoot))
    [void](Assert-DysonDeploymentPlainPathChain -Path ([string]$layout.dataRoot))
    return Read-DysonDeploymentIdentityMarker `
        -MarkerPath (Get-DysonDeploymentIdentityMarkerPath -InstallRoot ([string]$layout.installRoot)) `
        -ExpectedInstallRoot ([string]$layout.installRoot) -ExpectedDataRoot ([string]$layout.dataRoot)
}

function Initialize-DysonDeploymentIdentity {
    param(
        [Parameter(Mandatory)][string]$InstallRoot,
        [Parameter(Mandatory)][string]$DataRoot
    )

    $layout = Assert-DysonDeploymentDestructiveRootLayout -InstallRoot $InstallRoot -DataRoot $DataRoot
    [void](Assert-DysonDeploymentPlainPathChain -Path ([string]$layout.installRoot))
    [void](Assert-DysonDeploymentPlainPathChain -Path ([string]$layout.dataRoot))
    $markerPath = Get-DysonDeploymentIdentityMarkerPath -InstallRoot ([string]$layout.installRoot)
    if (Test-Path -LiteralPath $markerPath) {
        return Get-DysonDeploymentIdentity -InstallRoot ([string]$layout.installRoot) `
            -DataRoot ([string]$layout.dataRoot)
    }
    $marker = [ordered]@{
        protocol = $script:DysonDeploymentIdentityProtocol
        schemaVersion = 1
        deploymentId = [guid]::NewGuid().ToString('D').ToLowerInvariant()
        installRootIdentity = [string]$layout.installRootIdentity
        dataRootIdentity = [string]$layout.dataRootIdentity
        createdAt = (Get-Date).ToUniversalTime().ToString('o')
    }
    Write-DysonJsonAtomic -Path $markerPath -Value $marker
    return Get-DysonDeploymentIdentity -InstallRoot ([string]$layout.installRoot) `
        -DataRoot ([string]$layout.dataRoot)
}

function Assert-DysonPlainDirectory {
    param([Parameter(Mandatory)][string]$Path)

    $fullPath = Get-DysonFullPath -Path $Path
    $ioPath = ConvertTo-DysonDeploymentExtendedPath -Path $fullPath
    if (-not [System.IO.Directory]::Exists($ioPath)) {
        throw "Deployment directory is unavailable or redirected: $Path"
    }
    $attributes = [System.IO.File]::GetAttributes($ioPath)
    if (-not ($attributes -band [System.IO.FileAttributes]::Directory) -or
        ($attributes -band [System.IO.FileAttributes]::ReparsePoint)) {
        throw "Deployment directory is unavailable or redirected: $Path"
    }
    return $fullPath
}

function New-DysonDirectory {
    param([Parameter(Mandatory)][string]$Path)

    [System.IO.Directory]::CreateDirectory(
        (ConvertTo-DysonDeploymentExtendedPath -Path $Path)
    ) | Out-Null
    return Assert-DysonPlainDirectory -Path $Path
}

function Assert-DysonSourceArtifactExactProperties {
    param(
        [Parameter(Mandatory)]$Value,
        [Parameter(Mandatory)][string[]]$Expected,
        [Parameter(Mandatory)][string]$Name
    )

    if ($null -eq $Value) { throw "$Name is missing." }
    $actual = [string[]]@($Value.PSObject.Properties.Name)
    $expectedSorted = [string[]]@($Expected)
    [System.Array]::Sort($actual, [System.StringComparer]::Ordinal)
    [System.Array]::Sort($expectedSorted, [System.StringComparer]::Ordinal)
    if (-not [string]::Equals(
        [string]::Join("`n", $actual),
        [string]::Join("`n", $expectedSorted),
        [System.StringComparison]::Ordinal
    )) {
        throw "$Name contains missing or unknown fields."
    }
}

function Read-DysonSourceArtifactJsonFile {
    param(
        [Parameter(Mandatory)][string]$Path,
        [Parameter(Mandatory)][string]$Name,
        [ValidateRange(2, 33554432)][int64]$MaximumBytes = 16777216,
        [switch]$PreserveEmptyPropertyNames
    )

    try {
        $fullPath = Get-DysonFullPath -Path $Path
        $ioPath = ConvertTo-DysonDeploymentExtendedPath -Path $fullPath
        $attributes = [System.IO.File]::GetAttributes($ioPath)
        $fileInfo = [System.IO.FileInfo]::new($ioPath)
        if (($attributes -band [System.IO.FileAttributes]::Directory) -or
            ($attributes -band [System.IO.FileAttributes]::ReparsePoint) -or
            $fileInfo.Length -lt 2 -or $fileInfo.Length -gt $MaximumBytes) {
            throw 'invalid JSON file'
        }
        $json = [System.IO.File]::ReadAllText($ioPath, [System.Text.Encoding]::UTF8)
        if ($PreserveEmptyPropertyNames) {
            [void][System.Reflection.Assembly]::Load(
                'System.Web.Extensions, Version=4.0.0.0, Culture=neutral, PublicKeyToken=31bf3856ad364e35'
            )
            $serializer = New-Object System.Web.Script.Serialization.JavaScriptSerializer
            $serializer.MaxJsonLength = [int]$MaximumBytes
            $serializer.RecursionLimit = 64
            return $serializer.DeserializeObject($json)
        }
        return $json | ConvertFrom-Json -ErrorAction Stop
    }
    catch { throw "$Name is unavailable, redirected, oversized, or invalid JSON." }
}

function Get-DysonSourceArtifactPropertyValue {
    param(
        [Parameter(Mandatory)]$Value,
        [Parameter(Mandatory)][AllowEmptyString()][string]$Name
    )

    if ($null -eq $Value) { return $null }
    if ($Value -is [System.Collections.IDictionary]) {
        if ($Value.ContainsKey($Name)) { return $Value[$Name] }
        return $null
    }
    $property = $Value.PSObject.Properties[$Name]
    if ($null -eq $property) { return $null }
    return $property.Value
}

function Get-DysonSourceArtifactInventory {
    param([Parameter(Mandatory)][string]$Root)

    $rootFull = Assert-DysonPlainDirectory -Path $Root
    $byPath = [System.Collections.Generic.Dictionary[string, object]]::new(
        [System.StringComparer]::Ordinal
    )
    $totalBytesState = [pscustomobject]@{ value = [int64]0 }
    $rootIoPath = ConvertTo-DysonDeploymentExtendedPath -Path $rootFull
    $walkArtifact = $null
    $walkArtifact = {
        param([Parameter(Mandatory)][string]$DirectoryIoPath)

        foreach ($entryIoPath in @([System.IO.Directory]::EnumerateFileSystemEntries($DirectoryIoPath))) {
            $attributes = [System.IO.File]::GetAttributes($entryIoPath)
            if ($attributes -band [System.IO.FileAttributes]::ReparsePoint) {
                throw 'Release artifacts cannot contain reparse points.'
            }
            if ($attributes -band [System.IO.FileAttributes]::Directory) {
                & $walkArtifact -DirectoryIoPath $entryIoPath
                continue
            }
            $relativePath = $entryIoPath.Substring($rootIoPath.Length).TrimStart('\', '/').Replace('\', '/')
            if ([string]::Equals(
                $relativePath,
                $script:DysonArtifactManifestName,
                [System.StringComparison]::OrdinalIgnoreCase
            )) { continue }
            Assert-DysonRelativePath -Path $relativePath -Name 'Artifact file path'
            if ($relativePath -cne $relativePath.Replace('\', '/') -or $byPath.ContainsKey($relativePath)) {
                throw 'The source release artifact contains a duplicate or non-canonical path.'
            }
            $fileInfo = [System.IO.FileInfo]::new($entryIoPath)
            $totalBytesState.value = [int64]$totalBytesState.value + [int64]$fileInfo.Length
            if ([int64]$totalBytesState.value -gt $script:DysonArtifactMaximumBytes) {
                throw 'The source release artifact exceeds its size limit.'
            }
            $byPath[$relativePath] = [pscustomobject][ordered]@{
                path = $relativePath
                length = [int64]$fileInfo.Length
                sha256 = Get-DysonFileSha256 -Path $entryIoPath
            }
            if ($byPath.Count -gt $script:DysonArtifactMaximumFiles) {
                throw 'The source release artifact contains too many files.'
            }
        }
    }
    & $walkArtifact -DirectoryIoPath $rootIoPath
    if ($byPath.Count -eq 0) { throw 'The source release artifact is empty.' }

    $paths = [string[]]@($byPath.Keys)
    [System.Array]::Sort($paths, [System.StringComparer]::Ordinal)
    $files = @($paths | ForEach-Object { $byPath[$_] })
    $canonical = [string]::Join(
        "`n",
        @($files | ForEach-Object { '{0}|{1}|{2}' -f $_.path, $_.length, $_.sha256 })
    )
    $bytes = [System.Text.UTF8Encoding]::new($false).GetBytes($canonical)
    $hasher = [System.Security.Cryptography.SHA256]::Create()
    try {
        $payloadSha256 = ([System.BitConverter]::ToString($hasher.ComputeHash($bytes))).Replace('-', '').ToLowerInvariant()
    }
    finally { $hasher.Dispose() }

    return [pscustomobject][ordered]@{
        files = $files
        fileCount = [int]$files.Count
        totalBytes = [int64]$totalBytesState.value
        payloadSha256 = $payloadSha256
    }
}

function Test-DysonSourceArtifactPackageVersionBinding {
    param(
        [Parameter(Mandatory)][string]$ArtifactRoot,
        [Parameter(Mandatory)][string]$ExpectedVersion
    )

    $packagePath = Get-DysonFullPath -Path (Join-Path $ArtifactRoot 'apps\api\package.json')
    $lockPath = Get-DysonFullPath -Path (Join-Path $ArtifactRoot 'apps\api\package-lock.json')
    foreach ($candidate in @($packagePath, $lockPath)) {
        if (-not (Test-DysonPathWithin -Candidate $candidate -Parent $ArtifactRoot)) {
            throw 'The API package metadata escaped the source artifact root.'
        }
    }
    $package = Read-DysonSourceArtifactJsonFile -Path $packagePath -Name 'apps/api/package.json'
    $lock = Read-DysonSourceArtifactJsonFile -Path $lockPath -Name 'apps/api/package-lock.json' `
        -MaximumBytes $script:DysonArtifactMaximumManifestBytes -PreserveEmptyPropertyNames
    $packages = Get-DysonSourceArtifactPropertyValue -Value $lock -Name 'packages'
    $rootPackage = if ($null -ne $packages) {
        Get-DysonSourceArtifactPropertyValue -Value $packages -Name ''
    }
    else { $null }
    if ($null -eq $rootPackage) { throw 'The API lockfile is missing its root package binding.' }

    $packageName = Get-DysonSourceArtifactPropertyValue -Value $package -Name 'name'
    $packageVersion = Get-DysonSourceArtifactPropertyValue -Value $package -Name 'version'
    $packagePrivate = Get-DysonSourceArtifactPropertyValue -Value $package -Name 'private'
    $packageType = Get-DysonSourceArtifactPropertyValue -Value $package -Name 'type'
    $packageMain = Get-DysonSourceArtifactPropertyValue -Value $package -Name 'main'
    $lockName = Get-DysonSourceArtifactPropertyValue -Value $lock -Name 'name'
    $lockVersion = Get-DysonSourceArtifactPropertyValue -Value $lock -Name 'version'
    $lockfileVersion = Get-DysonSourceArtifactPropertyValue -Value $lock -Name 'lockfileVersion'
    $rootPackageName = Get-DysonSourceArtifactPropertyValue -Value $rootPackage -Name 'name'
    $rootPackageVersion = Get-DysonSourceArtifactPropertyValue -Value $rootPackage -Name 'version'
    if (-not ($packageName -is [string]) -or [string]::IsNullOrWhiteSpace($packageName) -or
        $packageName.Length -gt 214 -or -not ($packageVersion -is [string]) -or
        -not ($packagePrivate -is [bool]) -or -not [bool]$packagePrivate -or
        -not [string]::Equals([string]$packageType, 'module', [System.StringComparison]::Ordinal) -or
        -not [string]::Equals([string]$packageMain, 'dist/index.js', [System.StringComparison]::Ordinal) -or
        -not [string]::Equals([string]$lockName, [string]$packageName, [System.StringComparison]::Ordinal) -or
        -not [string]::Equals([string]$rootPackageName, [string]$packageName, [System.StringComparison]::Ordinal) -or
        $lockfileVersion -isnot [int] -or [int]$lockfileVersion -ne 3 -or
        -not [string]::Equals([string]$packageVersion, $ExpectedVersion, [System.StringComparison]::Ordinal) -or
        -not [string]::Equals([string]$lockVersion, $ExpectedVersion, [System.StringComparison]::Ordinal) -or
        -not [string]::Equals([string]$rootPackageVersion, $ExpectedVersion, [System.StringComparison]::Ordinal)) {
        throw 'The API package, lockfile, artifact manifest, and requested deployment version are not exactly bound.'
    }
    Assert-DysonVersion -Version ([string]$packageVersion)
}

function Test-DysonSourceArtifact {
    param(
        [Parameter(Mandatory)][string]$SourcePath,
        [Parameter(Mandatory)][string]$ExpectedVersion,
        [Parameter(Mandatory)][string]$ExpectedEntryPoint,
        [Parameter(Mandatory)][ValidatePattern('^[0-9a-f]{64}$')][string]$ExpectedPayloadSha256
    )

    Assert-DysonVersion -Version $ExpectedVersion
    Assert-DysonRelativePath -Path $ExpectedEntryPoint -Name 'EntryPointRelativePath'
    $source = Assert-DysonPlainDirectory -Path $SourcePath
    $normalizedEntryPoint = $ExpectedEntryPoint.Replace('\', '/')
    $verifierPath = Get-DysonFullPath -Path (Join-Path $source $script:DysonArtifactVerifierRelativePath)
    $verifierCommonPath = Get-DysonFullPath -Path (Join-Path $source $script:DysonArtifactVerifierCommonRelativePath)
    foreach ($requiredVerifierFile in @($verifierPath, $verifierCommonPath)) {
        $requiredVerifierIoPath = ConvertTo-DysonDeploymentExtendedPath -Path $requiredVerifierFile
        if (-not (Test-DysonPathWithin -Candidate $requiredVerifierFile -Parent $source) -or
            -not [System.IO.File]::Exists($requiredVerifierIoPath)) {
            throw 'The clean release artifact is missing its self-contained verifier.'
        }
        $verifierAttributes = [System.IO.File]::GetAttributes($requiredVerifierIoPath)
        if (($verifierAttributes -band [System.IO.FileAttributes]::Directory) -or
            ($verifierAttributes -band [System.IO.FileAttributes]::ReparsePoint)) {
            throw 'The clean release artifact verifier is redirected or unavailable.'
        }
    }

    $manifestPath = Get-DysonFullPath -Path (Join-Path $source $script:DysonArtifactManifestName)
    if (-not (Test-DysonPathWithin -Candidate $manifestPath -Parent $source)) {
        throw 'The artifact manifest escaped the source artifact root.'
    }
    $manifest = Read-DysonSourceArtifactJsonFile -Path $manifestPath -Name 'artifact-manifest.json' `
        -MaximumBytes $script:DysonArtifactMaximumManifestBytes
    Assert-DysonSourceArtifactExactProperties -Value $manifest -Expected @(
        'protocol', 'version', 'entryPoint', 'nodeMinimumMajor', 'dependencyInstall',
        'dependencyPruning', 'devDependenciesExcluded', 'payloadSha256', 'fileCount', 'totalBytes', 'files'
    ) -Name 'Artifact manifest'
    $nodeMinimumMajor = Get-DysonNodeMinimumMajor -Value $manifest.nodeMinimumMajor
    if (-not [string]::Equals([string]$manifest.protocol, $script:DysonArtifactVerifierProtocol, [System.StringComparison]::Ordinal) -or
        -not [string]::Equals([string]$manifest.version, $ExpectedVersion, [System.StringComparison]::Ordinal) -or
        -not [string]::Equals([string]$manifest.entryPoint, $normalizedEntryPoint, [System.StringComparison]::Ordinal) -or
        $nodeMinimumMajor -ne 24 -or
        -not [string]::Equals([string]$manifest.dependencyInstall, 'npm-ci-omit-dev-ignore-scripts', [System.StringComparison]::Ordinal) -or
        -not [string]::Equals([string]$manifest.dependencyPruning, 'non-runtime-package-content-v1', [System.StringComparison]::Ordinal)) {
        throw 'The source release artifact manifest contract is unsupported or inconsistent.'
    }
    Assert-DysonVersion -Version ([string]$manifest.version)
    [void](Test-DysonSourceArtifactPackageVersionBinding -ArtifactRoot $source -ExpectedVersion $ExpectedVersion)
    if (-not [string]::Equals(
        [string]$manifest.payloadSha256,
        $ExpectedPayloadSha256,
        [System.StringComparison]::Ordinal
    )) {
        throw 'The source release artifact payload does not match the independently verified provenance.'
    }

    $inventory = Get-DysonSourceArtifactInventory -Root $source
    if (-not [string]::Equals(
        [string]$inventory.payloadSha256,
        [string]$manifest.payloadSha256,
        [System.StringComparison]::Ordinal
    ) -or [int64]$manifest.fileCount -ne [int64]$inventory.fileCount -or
        [int64]$manifest.totalBytes -ne [int64]$inventory.totalBytes) {
        throw 'The source release artifact inventory no longer matches its manifest.'
    }
    $manifestFiles = @($manifest.files)
    if ($manifestFiles.Count -ne $inventory.fileCount) {
        throw 'The source release artifact manifest file count is inconsistent.'
    }
    for ($index = 0; $index -lt $manifestFiles.Count; $index++) {
        $expectedFile = $manifestFiles[$index]
        Assert-DysonSourceArtifactExactProperties -Value $expectedFile -Expected @('path', 'length', 'sha256') `
            -Name 'Artifact file entry'
        if (-not ($expectedFile.path -is [string]) -or
            [string]$expectedFile.path -cne ([string]$expectedFile.path).Replace('\', '/') -or
            [string]$expectedFile.path -ceq $script:DysonArtifactManifestName -or
            [string]$expectedFile.sha256 -notmatch '^[0-9a-f]{64}$') {
            throw 'The source release artifact manifest contains a non-canonical file entry.'
        }
        Assert-DysonRelativePath -Path ([string]$expectedFile.path) -Name 'Artifact file path'
        $actualFile = $inventory.files[$index]
        if (-not [string]::Equals([string]$expectedFile.path, [string]$actualFile.path, [System.StringComparison]::Ordinal) -or
            [int64]$expectedFile.length -ne [int64]$actualFile.length -or
            -not [string]::Equals([string]$expectedFile.sha256, [string]$actualFile.sha256, [System.StringComparison]::Ordinal)) {
            throw 'The source release artifact file inventory is inconsistent.'
        }
    }

    $excludedDependencies = [string[]]@($manifest.devDependenciesExcluded)
    if ($excludedDependencies.Count -gt 256) {
        throw 'The excluded development dependency list is too large.'
    }
    $excludedSet = @{}
    for ($dependencyIndex = 0; $dependencyIndex -lt $excludedDependencies.Count; $dependencyIndex++) {
        $dependency = [string]$excludedDependencies[$dependencyIndex]
        if ($dependency -notmatch '^(?:@[a-z0-9_.-]+/)?[a-z0-9_.-]+$' -or
            $excludedSet.ContainsKey($dependency) -or
            ($dependencyIndex -gt 0 -and [System.StringComparer]::Ordinal.Compare(
                $excludedDependencies[$dependencyIndex - 1], $dependency
            ) -ge 0)) {
            throw 'The excluded development dependency list is invalid, duplicated, or unsorted.'
        }
        $excludedSet[$dependency] = $true
        $dependencyPath = Get-DysonFullPath -Path (Join-Path (Join-Path $source 'apps\api\node_modules') `
            $dependency.Replace('/', '\'))
        $dependencyIoPath = ConvertTo-DysonDeploymentExtendedPath -Path $dependencyPath
        if (-not (Test-DysonPathWithin -Candidate $dependencyPath -Parent $source) -or
            [System.IO.File]::Exists($dependencyIoPath) -or
            [System.IO.Directory]::Exists($dependencyIoPath)) {
            throw "A development dependency entered the runtime artifact: $dependency"
        }
    }

    return [pscustomobject][ordered]@{
        artifactRoot = $source
        protocol = [string]$manifest.protocol
        version = [string]$manifest.version
        entryPoint = [string]$manifest.entryPoint
        nodeMinimumMajor = $nodeMinimumMajor
        payloadSha256 = [string]$inventory.payloadSha256
        fileCount = [int]$inventory.fileCount
        totalBytes = [int64]$inventory.totalBytes
        manifestValidated = $true
        provenancePayloadBound = $true
        sourceScriptsExecuted = $false
    }
}

function Get-DysonFileSha256 {
    param([Parameter(Mandatory)][string]$Path)

    $fullPath = Get-DysonFullPath -Path $Path
    $stream = [System.IO.File]::Open(
        (ConvertTo-DysonDeploymentExtendedPath -Path $fullPath),
        [System.IO.FileMode]::Open,
        [System.IO.FileAccess]::Read,
        [System.IO.FileShare]::Read
    )
    $hasher = [System.Security.Cryptography.SHA256]::Create()
    try {
        return ([System.BitConverter]::ToString($hasher.ComputeHash($stream))).Replace('-', '').ToLowerInvariant()
    }
    finally {
        $hasher.Dispose()
        $stream.Dispose()
    }
}

function Get-DysonRelativeFilePath {
    param(
        [Parameter(Mandatory)][string]$Root,
        [Parameter(Mandatory)][string]$File
    )

    $rootFull = (Get-DysonFullPath -Path $Root).TrimEnd('\', '/')
    $fileFull = Get-DysonFullPath -Path $File
    if (-not (Test-DysonPathWithin -Candidate $fileFull -Parent $rootFull)) {
        throw 'A payload file escaped its release root.'
    }
    return $fileFull.Substring($rootFull.Length).TrimStart('\', '/').Replace('\', '/')
}

function Get-DysonPayloadInventory {
    param([Parameter(Mandatory)][string]$Root)

    $rootFull = Assert-DysonPlainDirectory -Path $Root
    $rootIoPath = ConvertTo-DysonDeploymentExtendedPath -Path $rootFull
    $inventoryFiles = [System.Collections.Generic.List[object]]::new()
    $walkPayload = $null
    $walkPayload = {
        param([Parameter(Mandatory)][string]$DirectoryIoPath)

        foreach ($entryIoPath in @([System.IO.Directory]::EnumerateFileSystemEntries($DirectoryIoPath))) {
            $attributes = [System.IO.File]::GetAttributes($entryIoPath)
            if ($attributes -band [System.IO.FileAttributes]::ReparsePoint) {
                throw 'Release payloads cannot contain reparse points.'
            }
            if ($attributes -band [System.IO.FileAttributes]::Directory) {
                & $walkPayload -DirectoryIoPath $entryIoPath
                continue
            }
            $relativePath = $entryIoPath.Substring($rootIoPath.Length).TrimStart('\', '/').Replace('\', '/')
            if ([string]::IsNullOrWhiteSpace($relativePath)) {
                throw 'A payload file escaped its release root.'
            }
            if ($relativePath -ceq $script:DysonReleaseManifestName) { continue }
            $fileInfo = [System.IO.FileInfo]::new($entryIoPath)
            [void]$inventoryFiles.Add([ordered]@{
                path = $relativePath
                length = [int64]$fileInfo.Length
                sha256 = Get-DysonFileSha256 -Path $entryIoPath
            })
        }
    }
    & $walkPayload -DirectoryIoPath $rootIoPath
    $files = @($inventoryFiles | Sort-Object { $_.path })
    if ($files.Count -eq 0) { throw 'The release payload is empty.' }

    $lines = @($files | ForEach-Object { '{0}|{1}|{2}' -f $_.path, $_.length, $_.sha256 })
    $canonical = [string]::Join("`n", $lines)
    $bytes = [System.Text.UTF8Encoding]::new($false).GetBytes($canonical)
    $hasher = [System.Security.Cryptography.SHA256]::Create()
    try { $payloadHash = ([System.BitConverter]::ToString($hasher.ComputeHash($bytes))).Replace('-', '').ToLowerInvariant() }
    finally { $hasher.Dispose() }

    return [ordered]@{
        files = $files
        payloadSha256 = $payloadHash
    }
}

function Write-DysonJsonAtomic {
    param(
        [Parameter(Mandatory)][string]$Path,
        [Parameter(Mandatory)]$Value
    )

    $fullPath = Get-DysonFullPath -Path $Path
    $parent = New-DysonDirectory -Path ([System.IO.Path]::GetDirectoryName($fullPath))
    $temporaryPath = Join-Path $parent ('.partial-' + [guid]::NewGuid().ToString('N'))
    $replaceBackupPath = Join-Path $parent ('.replace-backup-' + [guid]::NewGuid().ToString('N'))
    $fullIoPath = ConvertTo-DysonDeploymentExtendedPath -Path $fullPath
    $temporaryIoPath = ConvertTo-DysonDeploymentExtendedPath -Path $temporaryPath
    $replaceBackupIoPath = ConvertTo-DysonDeploymentExtendedPath -Path $replaceBackupPath
    $json = $Value | ConvertTo-Json -Depth 12 -Compress
    try {
        [System.IO.File]::WriteAllText($temporaryIoPath, $json, [System.Text.UTF8Encoding]::new($false))
        if ([System.IO.File]::Exists($fullIoPath)) {
            [System.IO.File]::Replace($temporaryIoPath, $fullIoPath, $replaceBackupIoPath)
            [System.IO.File]::Delete($replaceBackupIoPath)
        }
        else {
            [System.IO.File]::Move($temporaryIoPath, $fullIoPath)
        }
    }
    finally {
        if ([System.IO.File]::Exists($temporaryIoPath)) { [System.IO.File]::Delete($temporaryIoPath) }
        if ([System.IO.File]::Exists($replaceBackupIoPath)) { [System.IO.File]::Delete($replaceBackupIoPath) }
    }
}

function Read-DysonJsonFile {
    param([Parameter(Mandatory)][string]$Path)

    $fullPath = Get-DysonFullPath -Path $Path
    $ioPath = ConvertTo-DysonDeploymentExtendedPath -Path $fullPath
    if (-not [System.IO.File]::Exists($ioPath)) { throw "Required deployment metadata is missing: $Path" }
    $attributes = [System.IO.File]::GetAttributes($ioPath)
    if (($attributes -band [System.IO.FileAttributes]::Directory) -or
        ($attributes -band [System.IO.FileAttributes]::ReparsePoint)) {
        throw 'Deployment metadata cannot be redirected.'
    }
    return [System.IO.File]::ReadAllText($ioPath, [System.Text.Encoding]::UTF8) | ConvertFrom-Json
}

function Write-DysonDeploymentAudit {
    param(
        [Parameter(Mandatory)][string]$DataRoot,
        [Parameter(Mandatory)][string]$Operation,
        [Parameter(Mandatory)][string]$Outcome,
        [string]$Version,
        [string]$SnapshotId,
        [string]$Code = 'OK'
    )

    $auditRoot = New-DysonDirectory -Path (Join-Path $DataRoot 'audit')
    $auditPath = Join-Path $auditRoot 'deployment.jsonl'
    $record = [ordered]@{
        protocol = $script:DysonDeploymentProtocol
        writtenAt = (Get-Date).ToUniversalTime().ToString('o')
        operation = $Operation
        outcome = $Outcome
        version = if ($Version) { $Version } else { $null }
        snapshotId = if ($SnapshotId) { $SnapshotId } else { $null }
        code = $Code
    } | ConvertTo-Json -Depth 4 -Compress
    $stream = [System.IO.FileStream]::new(
        (ConvertTo-DysonDeploymentExtendedPath -Path $auditPath),
        [System.IO.FileMode]::OpenOrCreate,
        [System.IO.FileAccess]::Write,
        [System.IO.FileShare]::Read
    )
    try {
        [void]$stream.Seek(0, [System.IO.SeekOrigin]::End)
        $bytes = [System.Text.UTF8Encoding]::new($false).GetBytes($record + "`r`n")
        $stream.Write($bytes, 0, $bytes.Length)
        $stream.Flush($true)
    }
    finally { $stream.Dispose() }
}

function Get-DysonDeploymentLockPath {
    param([Parameter(Mandatory)][string]$DataRoot)

    $dataFull = (Get-DysonFullPath -Path $DataRoot).TrimEnd('\', '/')
    $parent = [System.IO.Path]::GetDirectoryName($dataFull)
    if ([string]::IsNullOrWhiteSpace($parent) -or -not (Test-Path -LiteralPath $parent -PathType Container)) {
        throw 'The deployment data parent directory must exist before acquiring the deployment lock.'
    }
    $normalizedIdentity = Get-DysonDeploymentPathIdentity -Path $dataFull
    $lockRoot = Join-Path $parent '.dyson-control-deployment-locks'
    return Join-Path $lockRoot ((Get-DysonTextSha256 -Value $normalizedIdentity) + '.lock')
}

function Enter-DysonDeploymentLock {
    param(
        [Parameter(Mandatory)][string]$DataRoot,
        [ValidateRange(1, 120)][int]$TimeoutSeconds = 30
    )

    $lockPath = Get-DysonDeploymentLockPath -DataRoot $DataRoot
    [void](New-DysonDirectory -Path ([System.IO.Path]::GetDirectoryName($lockPath)))
    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    do {
        try {
            return [System.IO.FileStream]::new(
                (ConvertTo-DysonDeploymentExtendedPath -Path $lockPath),
                [System.IO.FileMode]::OpenOrCreate,
                [System.IO.FileAccess]::ReadWrite,
                [System.IO.FileShare]::None
            )
        }
        catch {
            $lockFailure = $_.Exception
            while ($null -ne $lockFailure.InnerException) {
                $lockFailure = $lockFailure.InnerException
            }
            $nativeError = [int]($lockFailure.HResult -band 0xFFFF)
            if ($nativeError -notin @(32, 33)) {
                throw 'The deployment lock file could not be opened.'
            }
            if ((Get-Date) -ge $deadline) { throw 'Another deployment operation still owns the deployment lock.' }
            Start-Sleep -Milliseconds 200
        }
    } while ($true)
}

function Assert-DysonDeploymentLockLease {
    param(
        [Parameter(Mandatory)][System.IO.FileStream]$Lease,
        [Parameter(Mandatory)][string]$DataRoot
    )

    $expectedPath = Get-DysonFullPath -Path (Get-DysonDeploymentLockPath -DataRoot $DataRoot)
    $expectedIoPath = ConvertTo-DysonDeploymentExtendedPath -Path $expectedPath
    try {
        $actualIoPath = ConvertTo-DysonDeploymentExtendedPath -Path $Lease.Name
        if (-not $Lease.CanRead -or -not $Lease.CanWrite -or
            -not [string]::Equals($actualIoPath, $expectedIoPath, [System.StringComparison]::OrdinalIgnoreCase)) {
            throw 'invalid lease'
        }
        $probe = $null
        try {
            $probe = [System.IO.FileStream]::new(
                $expectedIoPath,
                [System.IO.FileMode]::Open,
                [System.IO.FileAccess]::ReadWrite,
                [System.IO.FileShare]::ReadWrite
            )
            throw 'lease is not exclusive'
        }
        catch [System.IO.IOException] { }
        finally { if ($probe) { $probe.Dispose() } }
    }
    catch { throw 'The supplied deployment lock lease is invalid.' }
}

function Get-DysonTextSha256 {
    param([Parameter(Mandatory)][AllowEmptyString()][string]$Value)

    $bytes = [System.Text.UTF8Encoding]::new($false).GetBytes($Value)
    $hasher = [System.Security.Cryptography.SHA256]::Create()
    try { return ([System.BitConverter]::ToString($hasher.ComputeHash($bytes))).Replace('-', '').ToLowerInvariant() }
    finally { $hasher.Dispose() }
}

function Assert-DysonDeploymentTaskSelfTestScope {
    param(
        [Parameter(Mandatory)][string]$InstallRoot,
        [Parameter(Mandatory)][string]$DataRoot
    )

    if ($env:DYSON_DEPLOYMENT_ALLOW_SELFTEST_TASKS -ne 'true') {
        throw 'The task-administrator bypass is reserved for the isolated deployment self-test.'
    }
    $temporaryIdentity = (Get-DysonDeploymentPathIdentity `
        -Path ([System.IO.Path]::GetTempPath())).TrimEnd('\', '/')
    $fixtureRootIdentities = New-Object System.Collections.Generic.List[string]
    foreach ($path in @($InstallRoot, $DataRoot)) {
        $identity = (Get-DysonDeploymentPathIdentity -Path $path).TrimEnd('\', '/')
        if (-not (Test-DysonDeploymentIdentityPathWithin -CandidateIdentity $identity `
                -ParentIdentity $temporaryIdentity)) {
            throw 'The task-administrator bypass is outside the isolated deployment self-test root.'
        }
        $relative = $identity.Substring($temporaryIdentity.Length + 1)
        $fixtureLeaf = @($relative.Split([char[]]@('\', '/'), `
            [System.StringSplitOptions]::RemoveEmptyEntries))[0]
        if ([string]$fixtureLeaf -cnotmatch '^DYSON-CONTROL-DEPLOYMENT-SELFTEST-[0-9A-F]{32}$') {
            throw 'The task-administrator bypass is outside the isolated deployment self-test root.'
        }
        $fixtureRootIdentities.Add($temporaryIdentity +
            [System.IO.Path]::DirectorySeparatorChar + [string]$fixtureLeaf)
    }
    if ($fixtureRootIdentities.Count -ne 2 -or
        -not [string]::Equals(
            $fixtureRootIdentities[0], $fixtureRootIdentities[1],
            [System.StringComparison]::OrdinalIgnoreCase
        )) {
        throw 'The task-administrator bypass roots do not share one isolated deployment self-test fixture.'
    }
    [void](Assert-DysonDeploymentPlainPathChain -Path $fixtureRootIdentities[0])
    $authorization = Get-Variable -Name DysonDeploymentAuthorizedSelfTestRoots `
        -Scope Global -ErrorAction SilentlyContinue
    if ($null -eq $authorization -or
        $authorization.Value -isnot [System.Collections.Generic.HashSet[string]]) {
        $global:DysonDeploymentAuthorizedSelfTestRoots =
            [System.Collections.Generic.HashSet[string]]::new(
                [System.StringComparer]::OrdinalIgnoreCase
            )
    }
    [void]$global:DysonDeploymentAuthorizedSelfTestRoots.Add($fixtureRootIdentities[0])
    [System.Environment]::SetEnvironmentVariable(
        'DYSON_DEPLOYMENT_SELFTEST_ROOT_IDENTITY', $fixtureRootIdentities[0], 'Process'
    )
}

function Get-DysonScheduledTasksByExactName {
    param([Parameter(Mandatory)][string]$TaskName)

    if ($TaskName -notmatch '^[\p{L}\p{N}_. -]{1,128}$') { throw 'The control-plane task name is invalid.' }
    try { $allTasks = @(Get-ScheduledTask -ErrorAction Stop) }
    catch { throw 'The Task Scheduler state could not be queried.' }
    $matches = @(
        foreach ($task in $allTasks) {
            if ($null -eq $task -or $task.PSObject.Properties.Name -notcontains 'TaskName') {
                throw 'The Task Scheduler returned an invalid task record.'
            }
            if ([string]::Equals(
                [string]$task.TaskName,
                $TaskName,
                [System.StringComparison]::OrdinalIgnoreCase
            )) { $task }
        }
    )
    return @($matches)
}

function Get-DysonControlTaskActionArguments {
    param(
        [Parameter(Mandatory)][string]$LauncherPath,
        [Parameter(Mandatory)][string]$InstallRoot,
        [Parameter(Mandatory)][string]$DataRoot,
        [Parameter(Mandatory)][string]$RuntimeRoot,
        [Parameter(Mandatory)][string]$NodeExecutable,
        [Parameter(Mandatory)][string]$ExpectedNodeSha256,
        [Parameter(Mandatory)][string]$EnvironmentFile
    )

    [void](Assert-DysonNodeRuntimeHash -ExpectedNodeSha256 $ExpectedNodeSha256 `
        -Name 'ExpectedNodeSha256')
    $paths = @(
        (Get-DysonFullPath -Path $LauncherPath),
        (Get-DysonFullPath -Path $InstallRoot),
        (Get-DysonFullPath -Path $DataRoot),
        (Get-DysonFullPath -Path $RuntimeRoot),
        (Get-DysonFullPath -Path $NodeExecutable),
        (Get-DysonFullPath -Path $EnvironmentFile)
    )
    foreach ($path in $paths) {
        if ($path -match '["\r\n]') {
            throw 'A control-plane task path is not representable in its fixed action.'
        }
    }
    return '-NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "{0}" -InstallRoot "{1}" -DataRoot "{2}" -RuntimeRoot "{3}" -NodeExecutable "{4}" -ExpectedNodeSha256 "{5}" -EnvironmentFile "{6}"' -f
        $paths[0], $paths[1], $paths[2], $paths[3], $paths[4], $ExpectedNodeSha256, $paths[5]
}

function Test-DysonControlTaskLocalServiceIdentity {
    param([Parameter(Mandatory)][string]$UserId)

    if ([string]::IsNullOrWhiteSpace($UserId)) { return $false }
    if ($UserId -in @('S-1-5-19', 'LOCAL SERVICE', 'NT AUTHORITY\LOCAL SERVICE')) {
        return $true
    }
    try {
        $account = [System.Security.Principal.NTAccount]::new($UserId)
        $sid = $account.Translate([System.Security.Principal.SecurityIdentifier])
        return [string]$sid.Value -ceq 'S-1-5-19'
    }
    catch { return $false }
}

function Test-DysonControlTaskOneMinuteInterval {
    param($Value)

    if ($null -eq $Value) { return $false }
    if ($Value -is [timespan]) { return [timespan]$Value -eq [timespan]::FromMinutes(1) }
    $text = [string]$Value
    if ($text -ceq 'PT1M' -or $text -ceq '00:01:00') { return $true }
    try { return [System.Xml.XmlConvert]::ToTimeSpan($text) -eq [timespan]::FromMinutes(1) }
    catch { return $false }
}

function Test-DysonControlTaskZeroInterval {
    param($Value)

    if ($null -eq $Value) { return $false }
    if ($Value -is [timespan]) { return [timespan]$Value -eq [timespan]::Zero }
    $text = [string]$Value
    if ($text -ceq 'PT0S' -or $text -ceq '00:00:00') { return $true }
    try { return [System.Xml.XmlConvert]::ToTimeSpan($text) -eq [timespan]::Zero }
    catch { return $false }
}

function Assert-DysonControlTaskContract {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]$Task,
        [Parameter(Mandatory)][string]$TaskName,
        [Parameter(Mandatory)][string]$ExpectedPowerShellExecutable,
        [Parameter(Mandatory)][string]$ExpectedArguments,
        [string[]]$AllowedStates = @('Running')
    )

    if ($TaskName -notmatch '^[\p{L}\p{N}_. -]{1,128}$' -or
        $ExpectedArguments -match '[\r\n]' -or $AllowedStates.Count -lt 1) {
        throw 'The fixed control-plane task contract inputs are invalid.'
    }
    $allowedStateSet = [System.Collections.Generic.HashSet[string]]::new(
        [System.StringComparer]::Ordinal
    )
    foreach ($state in @($AllowedStates)) {
        if ([string]$state -cnotin @('Ready', 'Running')) {
            throw 'The fixed control-plane task contract contains an unsupported state.'
        }
        [void]$allowedStateSet.Add([string]$state)
    }
    $actions = @($Task.Actions | Where-Object { $null -ne $_ })
    $triggers = @($Task.Triggers | Where-Object { $null -ne $_ })
    $triggerClass = if ($triggers.Count -eq 1 -and
        $triggers[0].PSObject.Properties.Name -contains 'CimClass' -and
        $null -ne $triggers[0].CimClass) {
        [string]$triggers[0].CimClass.CimClassName
    }
    elseif ($triggers.Count -eq 1 -and $triggers[0].PSObject.Properties.Name -contains 'Kind') {
        [string]$triggers[0].Kind
    }
    else { '' }
    $triggerEnabled = $triggers.Count -eq 1 -and
        $triggers[0].PSObject.Properties.Name -contains 'Enabled' -and
        $triggers[0].Enabled -is [bool] -and [bool]$triggers[0].Enabled
    $stateText = [string]$Task.State.ToString()
    $settings = $Task.Settings
    $settingsValid = $null -ne $settings -and
        $settings.Enabled -is [bool] -and [bool]$settings.Enabled -and
        [string]$settings.MultipleInstances -ceq 'IgnoreNew' -and
        [int]$settings.RestartCount -eq 5 -and
        (Test-DysonControlTaskOneMinuteInterval -Value $settings.RestartInterval) -and
        (Test-DysonControlTaskZeroInterval -Value $settings.ExecutionTimeLimit) -and
        $settings.StartWhenAvailable -is [bool] -and [bool]$settings.StartWhenAvailable
    $expectedPowerShell = Get-DysonFullPath -Path $ExpectedPowerShellExecutable
    $actualPowerShell = if ($actions.Count -eq 1) {
        try {
            Get-DysonFullPath -Path ([Environment]::ExpandEnvironmentVariables([string]$actions[0].Execute))
        }
        catch { $null }
    }
    else { $null }
    $valid = $Task.PSObject.Properties.Name -contains 'TaskName' -and
        [string]$Task.TaskName -ceq $TaskName -and
        $Task.PSObject.Properties.Name -contains 'TaskPath' -and
        [string]$Task.TaskPath -ceq $script:DysonControlTaskPath -and
        $allowedStateSet.Contains($stateText) -and
        (Test-DysonControlTaskLocalServiceIdentity -UserId ([string]$Task.Principal.UserId)) -and
        [string]$Task.Principal.LogonType -ceq 'ServiceAccount' -and
        [string]$Task.Principal.RunLevel -ceq 'Limited' -and
        $actions.Count -eq 1 -and
        [string]::Equals($actualPowerShell, $expectedPowerShell, [System.StringComparison]::OrdinalIgnoreCase) -and
        [string]$actions[0].Arguments -ceq $ExpectedArguments -and
        [string]::IsNullOrEmpty([string]$actions[0].WorkingDirectory) -and
        $triggers.Count -eq 1 -and
        $triggerClass -in @('MSFT_TaskBootTrigger', 'TaskBootTrigger', 'AtStartup') -and
        $triggerEnabled -and $settingsValid
    if (-not $valid) {
        throw 'The fixed control-plane startup task does not match its complete contract.'
    }
    $identityText = [string]::Join('|', @(
        $TaskName,
        $script:DysonControlTaskPath,
        'S-1-5-19',
        'ServiceAccount',
        'Limited',
        $expectedPowerShell.ToLowerInvariant(),
        $ExpectedArguments,
        'TaskBootTrigger',
        'Enabled',
        'IgnoreNew',
        'RestartCount=5',
        'RestartInterval=PT1M',
        'ExecutionTimeLimit=PT0S',
        'StartWhenAvailable=true',
        $stateText
    ))
    return [pscustomobject][ordered]@{
        valid = $true
        state = $stateText
        taskIdentity = 'sha256:' + (Get-DysonTextSha256 -Value $identityText)
    }
}

function Get-DysonControlTaskRollbackState {
    param([Parameter(Mandatory)][string]$TaskName)

    if ($TaskName -notmatch '^[\p{L}\p{N}_. -]{1,128}$') { throw 'The control-plane task name is invalid.' }
    $matches = @(Get-DysonScheduledTasksByExactName -TaskName $TaskName)
    if ($matches.Count -gt 1) { throw 'The control-plane task identity is ambiguous.' }
    if ($matches.Count -eq 0) {
        return [pscustomobject][ordered]@{
            taskName = $TaskName
            taskPath = $script:DysonControlTaskPath
            present = $false
            wasRunning = $false
            xml = $null
            xmlSha256 = $null
        }
    }

    if ($matches[0].PSObject.Properties.Name -notcontains 'TaskPath' -or
        -not [string]::Equals(
            [string]$matches[0].TaskPath,
            $script:DysonControlTaskPath,
            [System.StringComparison]::Ordinal
        )) {
        throw 'The control-plane task must use the fixed root task path.'
    }
    $xml = [string](Export-ScheduledTask -TaskName $TaskName -TaskPath $script:DysonControlTaskPath -ErrorAction Stop)
    if ([string]::IsNullOrWhiteSpace($xml) -or $xml.Length -gt 4MB) {
        throw 'The control-plane task definition is empty or exceeds its rollback bound.'
    }
    return [pscustomobject][ordered]@{
        taskName = $TaskName
        taskPath = $script:DysonControlTaskPath
        present = $true
        wasRunning = [string]::Equals($matches[0].State.ToString(), 'Running', [System.StringComparison]::OrdinalIgnoreCase)
        xml = $xml
        xmlSha256 = Get-DysonTextSha256 -Value $xml
    }
}

function Remove-DysonControlTaskForRollback {
    param([Parameter(Mandatory)][string]$TaskName)

    if ($TaskName -notmatch '^[\p{L}\p{N}_. -]{1,128}$') { throw 'The control-plane task name is invalid.' }
    $matches = @(Get-DysonScheduledTasksByExactName -TaskName $TaskName)
    if ($matches.Count -gt 1) { throw 'The control-plane task identity is ambiguous.' }
    if ($matches.Count -eq 1) {
        $task = $matches[0]
        if ($task.PSObject.Properties.Name -notcontains 'TaskPath' -or
            -not [string]::Equals(
                [string]$task.TaskPath,
                $script:DysonControlTaskPath,
                [System.StringComparison]::Ordinal
            )) {
            throw 'The control-plane task must use the fixed root task path.'
        }
        if ([string]::Equals($task.State.ToString(), 'Running', [System.StringComparison]::OrdinalIgnoreCase)) {
            Stop-ScheduledTask -InputObject $task -ErrorAction Stop
            $deadline = (Get-Date).AddSeconds(20)
            do {
                Start-Sleep -Milliseconds 250
                $matches = @(Get-DysonScheduledTasksByExactName -TaskName $TaskName)
                if ($matches.Count -gt 1) { throw 'The control-plane task identity became ambiguous.' }
            } while ($matches.Count -eq 1 -and
                [string]::Equals($matches[0].State.ToString(), 'Running', [System.StringComparison]::OrdinalIgnoreCase) -and
                (Get-Date) -lt $deadline)
            if ($matches.Count -eq 1 -and
                [string]::Equals($matches[0].State.ToString(), 'Running', [System.StringComparison]::OrdinalIgnoreCase)) {
                throw 'The replacement control-plane task did not stop before rollback.'
            }
        }
        Unregister-ScheduledTask -TaskName $TaskName -TaskPath $script:DysonControlTaskPath -Confirm:$false -ErrorAction Stop
    }
    if (@(Get-DysonScheduledTasksByExactName -TaskName $TaskName).Count -ne 0) {
        throw 'The replacement control-plane task could not be removed for rollback.'
    }
}

function Restore-DysonControlTaskRollbackState {
    param(
        [Parameter(Mandatory)]$State,
        [Parameter(Mandatory)][string]$TaskName
    )

    if ([string]$State.taskName -cne $TaskName -or
        [string]$State.taskPath -cne $script:DysonControlTaskPath -or $State.present -isnot [bool] -or
        $State.wasRunning -isnot [bool]) {
        throw 'The control-plane task rollback state is invalid.'
    }
    Remove-DysonControlTaskForRollback -TaskName $TaskName
    if (-not [bool]$State.present) {
        return [ordered]@{ taskRestored = $false; taskRemoved = $true; previousTaskWasRunning = $false }
    }
    if (-not ($State.xml -is [string]) -or [string]::IsNullOrWhiteSpace([string]$State.xml) -or
        ([string]$State.xml).Length -gt 4MB -or [string]$State.xmlSha256 -notmatch '^[0-9a-f]{64}$' -or
        (Get-DysonTextSha256 -Value ([string]$State.xml)) -cne [string]$State.xmlSha256) {
        throw 'The saved control-plane task rollback definition is invalid.'
    }

    Register-ScheduledTask -TaskName $TaskName -TaskPath $script:DysonControlTaskPath `
        -Xml ([string]$State.xml) -Force -ErrorAction Stop | Out-Null
    if ([bool]$State.wasRunning) {
        Start-ScheduledTask -TaskName $TaskName -TaskPath $script:DysonControlTaskPath -ErrorAction Stop
    }
    $startDeadline = (Get-Date).AddSeconds(20)
    do {
        $restored = @(Get-DysonScheduledTasksByExactName -TaskName $TaskName)
        if ($restored.Count -ne 1) { throw 'The previous control-plane task was not restored uniquely.' }
        if ($restored[0].PSObject.Properties.Name -notcontains 'TaskPath' -or
            [string]$restored[0].TaskPath -cne $script:DysonControlTaskPath) {
            throw 'The previous control-plane task was restored outside the fixed root task path.'
        }
        if (-not [bool]$State.wasRunning -or
            [string]::Equals($restored[0].State.ToString(), 'Running', [System.StringComparison]::OrdinalIgnoreCase)) {
            break
        }
        Start-Sleep -Milliseconds 250
    } while ((Get-Date) -lt $startDeadline)
    $restoredXml = [string](Export-ScheduledTask -TaskName $TaskName `
        -TaskPath $script:DysonControlTaskPath -ErrorAction Stop)
    if ((Get-DysonTextSha256 -Value $restoredXml) -cne [string]$State.xmlSha256) {
        throw 'The restored control-plane task definition does not match its rollback state.'
    }
    $restoredIsRunning = [string]::Equals(
        $restored[0].State.ToString(),
        'Running',
        [System.StringComparison]::OrdinalIgnoreCase
    )
    if ($restoredIsRunning -ne [bool]$State.wasRunning) {
        throw 'The restored control-plane task did not return to its previous execution state.'
    }
    return [ordered]@{
        taskRestored = $true
        taskRemoved = $false
        previousTaskWasRunning = [bool]$State.wasRunning
    }
}

function Remove-DysonDeploymentPlainTree {
    param(
        [Parameter(Mandatory)][string]$Path,
        [Parameter(Mandatory)][string]$ExpectedParent,
        [Parameter(Mandatory)][string]$ExpectedLeafPattern
    )

    $fullPath = (Get-DysonFullPath -Path $Path).TrimEnd('\', '/')
    $parentFull = (Get-DysonFullPath -Path $ExpectedParent).TrimEnd('\', '/')
    $actualParent = [System.IO.Path]::GetDirectoryName($fullPath)
    $leaf = [System.IO.Path]::GetFileName($fullPath)
    if ([string]::IsNullOrWhiteSpace($actualParent) -or
        -not [string]::Equals($actualParent.TrimEnd('\', '/'), $parentFull,
            [System.StringComparison]::OrdinalIgnoreCase) -or
        $leaf -cnotmatch $ExpectedLeafPattern) {
        throw 'A deployment cleanup target escaped its exact bounded root.'
    }
    $ioPath = ConvertTo-DysonDeploymentExtendedPath -Path $fullPath
    if (-not [System.IO.Directory]::Exists($ioPath)) {
        if ([System.IO.File]::Exists($ioPath)) {
            throw 'A deployment cleanup target is not a directory.'
        }
        return
    }
    $assertPlainEntry = $null
    $assertPlainEntry = {
        param([Parameter(Mandatory)][string]$EntryIoPath)

        $attributes = [System.IO.File]::GetAttributes($EntryIoPath)
        if ($attributes -band [System.IO.FileAttributes]::ReparsePoint) {
            throw 'A deployment cleanup target contains a redirected entry.'
        }
        if ($attributes -band [System.IO.FileAttributes]::Directory) {
            foreach ($child in @([System.IO.Directory]::EnumerateFileSystemEntries($EntryIoPath))) {
                & $assertPlainEntry -EntryIoPath $child
            }
        }
    }
    & $assertPlainEntry -EntryIoPath $ioPath
    [System.IO.Directory]::Delete($ioPath, $true)
}

function Copy-DysonPayload {
    param(
        [Parameter(Mandatory)][string]$Source,
        [Parameter(Mandatory)][string]$Destination
    )

    $sourceFull = (Get-DysonFullPath -Path $Source).TrimEnd('\', '/')
    $destinationFull = (Get-DysonFullPath -Path $Destination).TrimEnd('\', '/')
    [void][System.IO.Directory]::CreateDirectory(
        (ConvertTo-DysonDeploymentExtendedPath -Path $destinationFull)
    )
    foreach ($item in @(Get-ChildItem -LiteralPath $sourceFull -Force -Recurse -ErrorAction Stop)) {
        if ($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) {
            throw 'Release payloads cannot contain reparse points.'
        }
        $relative = $item.FullName.Substring($sourceFull.Length).TrimStart('\', '/')
        if ([string]::IsNullOrWhiteSpace($relative)) { throw 'A release payload entry is invalid.' }
        if (-not $relative.Contains('\') -and
            [string]::Equals($item.Name, $script:DysonReleaseManifestName,
                [System.StringComparison]::Ordinal)) { continue }
        $target = Get-DysonFullPath -Path (Join-Path $destinationFull $relative)
        if (-not (Test-DysonPathWithin -Candidate $target -Parent $destinationFull)) {
            throw 'A release payload entry escaped its destination root.'
        }
        if ($item.PSIsContainer) {
            [void][System.IO.Directory]::CreateDirectory(
                (ConvertTo-DysonDeploymentExtendedPath -Path $target)
            )
            continue
        }
        [void][System.IO.Directory]::CreateDirectory(
            (ConvertTo-DysonDeploymentExtendedPath -Path ([System.IO.Path]::GetDirectoryName($target)))
        )
        [System.IO.File]::Copy(
            (ConvertTo-DysonDeploymentExtendedPath -Path $item.FullName),
            (ConvertTo-DysonDeploymentExtendedPath -Path $target),
            $true
        )
    }
}

function Test-DysonRelease {
    param(
        [Parameter(Mandatory)][string]$ReleaseRoot,
        [Parameter(Mandatory)][string]$ExpectedVersion,
        [Parameter(Mandatory)][string]$ExpectedEntryPoint
    )

    Assert-DysonVersion -Version $ExpectedVersion
    Assert-DysonRelativePath -Path $ExpectedEntryPoint -Name 'EntryPointRelativePath'
    $releaseFull = Assert-DysonPlainDirectory -Path $ReleaseRoot
    $manifestPath = Join-Path $releaseFull $script:DysonReleaseManifestName
    $manifest = Read-DysonJsonFile -Path $manifestPath
    $nodeMinimumMajor = Get-DysonNodeMinimumMajor -Value $manifest.nodeMinimumMajor
    if ($manifest.protocol -ne $script:DysonDeploymentProtocol -or $manifest.version -ne $ExpectedVersion -or
        $manifest.entryPoint -ne $ExpectedEntryPoint) {
        throw 'The staged release manifest does not match the requested release.'
    }
    $entryPoint = Get-DysonFullPath -Path (Join-Path $releaseFull $ExpectedEntryPoint)
    if (-not (Test-DysonPathWithin -Candidate $entryPoint -Parent $releaseFull) -or
        -not (Test-Path -LiteralPath $entryPoint -PathType Leaf)) {
        throw 'The staged control-plane entry point is missing.'
    }
    $inventory = Get-DysonPayloadInventory -Root $releaseFull
    if ($inventory.payloadSha256 -ne $manifest.payloadSha256) { throw 'The staged release payload hash does not match its manifest.' }
    $manifestFiles = @($manifest.files)
    if ($manifestFiles.Count -ne @($inventory.files).Count) { throw 'The staged release file inventory changed after staging.' }
    return [ordered]@{
        version = $ExpectedVersion
        entryPoint = $ExpectedEntryPoint
        nodeMinimumMajor = $nodeMinimumMajor
        payloadSha256 = $inventory.payloadSha256
        fileCount = @($inventory.files).Count
    }
}

function Invoke-DysonStageReleaseCore {
    param(
        [Parameter(Mandatory)][string]$SourcePath,
        [Parameter(Mandatory)][string]$Version,
        [Parameter(Mandatory)][string]$InstallRoot,
        [Parameter(Mandatory)][string]$EntryPointRelativePath,
        [Parameter(Mandatory)]$SourceArtifactVerification
    )

    Assert-DysonVersion -Version $Version
    Assert-DysonRelativePath -Path $EntryPointRelativePath -Name 'EntryPointRelativePath'
    $source = Assert-DysonPlainDirectory -Path $SourcePath
    $normalizedEntryPoint = $EntryPointRelativePath.Replace('\', '/')
    $sourceNodeMinimumMajor = Get-DysonNodeMinimumMajor -Value $SourceArtifactVerification.nodeMinimumMajor
    if (-not [string]::Equals((Get-DysonFullPath -Path ([string]$SourceArtifactVerification.artifactRoot)), $source, [System.StringComparison]::OrdinalIgnoreCase) -or
        -not [string]::Equals([string]$SourceArtifactVerification.version, $Version, [System.StringComparison]::Ordinal) -or
        -not [string]::Equals([string]$SourceArtifactVerification.entryPoint, $normalizedEntryPoint, [System.StringComparison]::Ordinal) -or
        [string]$SourceArtifactVerification.payloadSha256 -notmatch '^[0-9a-f]{64}$' -or
        -not [bool]$SourceArtifactVerification.manifestValidated -or
        -not [bool]$SourceArtifactVerification.provenancePayloadBound -or
        [bool]$SourceArtifactVerification.sourceScriptsExecuted) {
        throw 'The source artifact verification receipt does not match the requested deployment.'
    }
    $sourceEntry = Get-DysonFullPath -Path (Join-Path $source $EntryPointRelativePath)
    if (-not (Test-DysonPathWithin -Candidate $sourceEntry -Parent $source) -or
        -not (Test-Path -LiteralPath $sourceEntry -PathType Leaf)) {
        throw 'The source payload does not contain the required control-plane entry point.'
    }
    $sourceInventory = Get-DysonPayloadInventory -Root $source
    $releasesRoot = New-DysonDirectory -Path (Join-Path $InstallRoot 'releases')
    $releaseRoot = Get-DysonFullPath -Path (Join-Path $releasesRoot $Version)
    if (-not (Test-DysonPathWithin -Candidate $releaseRoot -Parent $releasesRoot)) { throw 'The release version escaped the releases root.' }

    if (Test-Path -LiteralPath $releaseRoot) {
        $existing = Test-DysonRelease -ReleaseRoot $releaseRoot -ExpectedVersion $Version -ExpectedEntryPoint $EntryPointRelativePath
        if ($existing.payloadSha256 -ne $sourceInventory.payloadSha256 -or
            [int]$existing.nodeMinimumMajor -ne $sourceNodeMinimumMajor) {
            throw 'An immutable release with this version already exists with different content.'
        }
        return [ordered]@{
            state = 'already-staged'
            version = $Version
            payloadSha256 = $existing.payloadSha256
            fileCount = $existing.fileCount
        }
    }

    $stagingRoot = Join-Path $releasesRoot ('.staging-' + [guid]::NewGuid().ToString('N'))
    [System.IO.Directory]::CreateDirectory(
        (ConvertTo-DysonDeploymentExtendedPath -Path $stagingRoot)
    ) | Out-Null
    try {
        Copy-DysonPayload -Source $source -Destination $stagingRoot
        $stagedInventory = Get-DysonPayloadInventory -Root $stagingRoot
        if ($stagedInventory.payloadSha256 -ne $sourceInventory.payloadSha256) { throw 'The staged payload differs from its source.' }
        $stagedArtifactVerification = Test-DysonSourceArtifact -SourcePath $stagingRoot `
            -ExpectedVersion $Version -ExpectedEntryPoint $EntryPointRelativePath `
            -ExpectedPayloadSha256 ([string]$SourceArtifactVerification.payloadSha256)
        if (-not [string]::Equals(
            [string]$stagedArtifactVerification.payloadSha256,
            [string]$SourceArtifactVerification.payloadSha256,
            [System.StringComparison]::Ordinal
        ) -or [int]$stagedArtifactVerification.nodeMinimumMajor -ne $sourceNodeMinimumMajor) {
            throw 'The source artifact changed after its pre-deployment verification.'
        }
        $manifest = [ordered]@{
            protocol = $script:DysonDeploymentProtocol
            version = $Version
            entryPoint = $EntryPointRelativePath
            nodeMinimumMajor = $sourceNodeMinimumMajor
            createdAt = (Get-Date).ToUniversalTime().ToString('o')
            payloadSha256 = $stagedInventory.payloadSha256
            files = $stagedInventory.files
        }
        Write-DysonJsonAtomic -Path (Join-Path $stagingRoot $script:DysonReleaseManifestName) -Value $manifest
        [System.IO.Directory]::Move($stagingRoot, $releaseRoot)
    }
    finally {
        Remove-DysonDeploymentPlainTree -Path $stagingRoot -ExpectedParent $releasesRoot `
            -ExpectedLeafPattern '^\.staging-[0-9a-f]{32}$'
    }
    $verified = Test-DysonRelease -ReleaseRoot $releaseRoot -ExpectedVersion $Version -ExpectedEntryPoint $EntryPointRelativePath
    return [ordered]@{
        state = 'staged'
        version = $Version
        payloadSha256 = $verified.payloadSha256
        fileCount = $verified.fileCount
    }
}

function Get-DysonActivePointerPath {
    param([Parameter(Mandatory)][string]$DataRoot)
    return Join-Path (Join-Path $DataRoot 'state') $script:DysonActivePointerName
}

function Get-DysonActiveRelease {
    param(
        [Parameter(Mandatory)][string]$InstallRoot,
        [Parameter(Mandatory)][string]$DataRoot
    )

    $pointerPath = Get-DysonActivePointerPath -DataRoot $DataRoot
    if (-not (Test-Path -LiteralPath $pointerPath -PathType Leaf)) { return $null }
    $pointer = Read-DysonJsonFile -Path $pointerPath
    if ($pointer.protocol -ne $script:DysonDeploymentProtocol) { throw 'The active release pointer protocol is unsupported.' }
    Assert-DysonVersion -Version ([string]$pointer.version)
    Assert-DysonRelativePath -Path ([string]$pointer.entryPoint) -Name 'Active entry point'
    $releaseRoot = Get-DysonFullPath -Path (Join-Path (Join-Path $InstallRoot 'releases') ([string]$pointer.version))
    $verified = Test-DysonRelease -ReleaseRoot $releaseRoot -ExpectedVersion ([string]$pointer.version) -ExpectedEntryPoint ([string]$pointer.entryPoint)
    if ($verified.payloadSha256 -ne [string]$pointer.payloadSha256) { throw 'The active pointer does not match its immutable release.' }
    $hasDeploymentId = $pointer.PSObject.Properties.Name -contains 'deploymentId'
    $hasIdentityHash = $pointer.PSObject.Properties.Name -contains 'deploymentIdentitySha256'
    $deploymentIdentity = $null
    if ($hasDeploymentId -ne $hasIdentityHash) {
        throw 'The active pointer has an incomplete deployment identity binding.'
    }
    if ($hasDeploymentId) {
        $deploymentIdentity = Get-DysonDeploymentIdentity -InstallRoot $InstallRoot -DataRoot $DataRoot
        if ([string]$pointer.deploymentId -cne [string]$deploymentIdentity.marker.deploymentId -or
            [string]$pointer.deploymentIdentitySha256 -cne [string]$deploymentIdentity.markerSha256) {
            throw 'The active pointer does not match the deployment identity marker.'
        }
    }
    return [ordered]@{
        pointer = $pointer
        pointerPath = $pointerPath
        releaseRoot = $releaseRoot
        entryPointPath = Get-DysonFullPath -Path (Join-Path $releaseRoot ([string]$pointer.entryPoint))
        nodeMinimumMajor = [int]$verified.nodeMinimumMajor
        deploymentIdentityVerified = [bool]$hasDeploymentId
        deploymentIdentity = $deploymentIdentity
    }
}

function Invoke-DysonActivateCore {
    param(
        [Parameter(Mandatory)][string]$Version,
        [Parameter(Mandatory)][string]$InstallRoot,
        [Parameter(Mandatory)][string]$DataRoot,
        [Parameter(Mandatory)][string]$EntryPointRelativePath
    )

    $releaseRoot = Get-DysonFullPath -Path (Join-Path (Join-Path $InstallRoot 'releases') $Version)
    $verified = Test-DysonRelease -ReleaseRoot $releaseRoot -ExpectedVersion $Version -ExpectedEntryPoint $EntryPointRelativePath
    $deploymentIdentity = Initialize-DysonDeploymentIdentity -InstallRoot $InstallRoot -DataRoot $DataRoot
    $pointer = [ordered]@{
        protocol = $script:DysonDeploymentProtocol
        version = $Version
        entryPoint = $EntryPointRelativePath
        payloadSha256 = $verified.payloadSha256
        deploymentId = [string]$deploymentIdentity.marker.deploymentId
        deploymentIdentitySha256 = [string]$deploymentIdentity.markerSha256
        activatedAt = (Get-Date).ToUniversalTime().ToString('o')
    }
    Write-DysonJsonAtomic -Path (Get-DysonActivePointerPath -DataRoot $DataRoot) -Value $pointer
    return $pointer
}

function Copy-DysonDirectoryContents {
    param(
        [Parameter(Mandatory)][string]$Source,
        [Parameter(Mandatory)][string]$Destination
    )

    $sourceFull = Assert-DysonPlainDirectory -Path $Source
    $destinationFull = (Get-DysonFullPath -Path $Destination).TrimEnd('\', '/')
    [void][System.IO.Directory]::CreateDirectory(
        (ConvertTo-DysonDeploymentExtendedPath -Path $destinationFull)
    )
    foreach ($item in @(Get-ChildItem -LiteralPath $sourceFull -Recurse -Force -ErrorAction Stop)) {
        if ($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) {
            throw 'Deployment configuration cannot contain reparse points.'
        }
        $relative = $item.FullName.Substring($sourceFull.Length).TrimStart('\', '/')
        if ([string]::IsNullOrWhiteSpace($relative)) {
            throw 'A deployment configuration entry is invalid.'
        }
        $target = Get-DysonFullPath -Path (Join-Path $destinationFull $relative)
        if (-not (Test-DysonPathWithin -Candidate $target -Parent $destinationFull)) {
            throw 'A deployment configuration entry escaped its destination root.'
        }
        if ($item.PSIsContainer) {
            [void][System.IO.Directory]::CreateDirectory(
                (ConvertTo-DysonDeploymentExtendedPath -Path $target)
            )
            continue
        }
        [void][System.IO.Directory]::CreateDirectory(
            (ConvertTo-DysonDeploymentExtendedPath -Path ([System.IO.Path]::GetDirectoryName($target)))
        )
        [System.IO.File]::Copy(
            (ConvertTo-DysonDeploymentExtendedPath -Path $item.FullName),
            (ConvertTo-DysonDeploymentExtendedPath -Path $target),
            $true
        )
    }
}

function New-DysonDeploymentSnapshotCore {
    param(
        [Parameter(Mandatory)][string]$InstallRoot,
        [Parameter(Mandatory)][string]$DataRoot,
        [Parameter(Mandatory)][string]$Reason
    )

    $snapshotRoot = New-DysonDirectory -Path (Join-Path (Join-Path $DataRoot 'snapshots') 'deployments')
    $snapshotId = (Get-Date).ToUniversalTime().ToString('yyyyMMdd-HHmmssfff') + '-' + [guid]::NewGuid().ToString('N').Substring(0, 8)
    $finalPath = Join-Path $snapshotRoot $snapshotId
    $stagingPath = Join-Path $snapshotRoot ('.partial-' + [guid]::NewGuid().ToString('N'))
    [System.IO.Directory]::CreateDirectory(
        (ConvertTo-DysonDeploymentExtendedPath -Path $stagingPath)
    ) | Out-Null
    try {
        $activePointerPath = Get-DysonActivePointerPath -DataRoot $DataRoot
        $hadActivePointer = [System.IO.File]::Exists(
            (ConvertTo-DysonDeploymentExtendedPath -Path $activePointerPath)
        )
        $activeVersion = $null
        $activePointerSha256 = $null
        if ($hadActivePointer) {
            $active = Get-DysonActiveRelease -InstallRoot $InstallRoot -DataRoot $DataRoot
            $activeVersion = [string]$active.pointer.version
            [System.IO.File]::Copy(
                (ConvertTo-DysonDeploymentExtendedPath -Path $activePointerPath),
                (ConvertTo-DysonDeploymentExtendedPath -Path `
                    (Join-Path $stagingPath $script:DysonActivePointerName)),
                $true
            )
            $activePointerSha256 = Get-DysonFileSha256 -Path $activePointerPath
        }
        $identityMarkerPath = Get-DysonDeploymentIdentityMarkerPath -InstallRoot $InstallRoot
        $hadDeploymentIdentity = [System.IO.File]::Exists(
            (ConvertTo-DysonDeploymentExtendedPath -Path $identityMarkerPath)
        )
        $deploymentIdentitySha256 = $null
        if ($hadDeploymentIdentity) {
            $identity = Get-DysonDeploymentIdentity -InstallRoot $InstallRoot -DataRoot $DataRoot
            [System.IO.File]::Copy(
                (ConvertTo-DysonDeploymentExtendedPath -Path $identityMarkerPath),
                (ConvertTo-DysonDeploymentExtendedPath -Path `
                    (Join-Path $stagingPath $script:DysonDeploymentIdentityName)),
                $true
            )
            $deploymentIdentitySha256 = [string]$identity.markerSha256
        }
        $configPath = Join-Path $DataRoot 'config'
        $configPresent = Test-Path -LiteralPath $configPath -PathType Container
        if ($configPresent) { Copy-DysonDirectoryContents -Source $configPath -Destination (Join-Path $stagingPath 'config') }
        $metadata = [ordered]@{
            protocol = $script:DysonDeploymentProtocol
            snapshotId = $snapshotId
            createdAt = (Get-Date).ToUniversalTime().ToString('o')
            reason = $Reason
            hadActivePointer = [bool]$hadActivePointer
            activeVersion = $activeVersion
            activePointerSha256 = $activePointerSha256
            hadDeploymentIdentity = [bool]$hadDeploymentIdentity
            deploymentIdentitySha256 = $deploymentIdentitySha256
            configPresent = [bool]$configPresent
        }
        Write-DysonJsonAtomic -Path (Join-Path $stagingPath 'snapshot.json') -Value $metadata
        [System.IO.Directory]::Move($stagingPath, $finalPath)
    }
    finally {
        Remove-DysonDeploymentPlainTree -Path $stagingPath -ExpectedParent $snapshotRoot `
            -ExpectedLeafPattern '^\.partial-[0-9a-f]{32}$'
    }
    return $metadata
}

function Get-DysonDeploymentSnapshot {
    param(
        [Parameter(Mandatory)][string]$DataRoot,
        [Parameter(Mandatory)][string]$SnapshotId
    )

    $snapshotRoot = Get-DysonFullPath -Path (Join-Path (Join-Path $DataRoot 'snapshots') 'deployments')
    if (-not (Test-Path -LiteralPath $snapshotRoot -PathType Container)) { throw 'No deployment snapshots are available.' }
    if ($SnapshotId -eq 'latest') {
        $candidates = @(Get-ChildItem -LiteralPath $snapshotRoot -Directory -Force -ErrorAction Stop |
            Where-Object { $_.Name -notlike '.partial-*' } |
            Sort-Object Name -Descending)
        if ($candidates.Count -eq 0) { throw 'No deployment snapshots are available.' }
        $snapshotPath = $candidates[0].FullName
    }
    else {
        if ($SnapshotId -notmatch '^\d{8}-\d{9}-[0-9a-f]{8}$') { throw 'The deployment snapshot ID is invalid.' }
        $snapshotPath = Get-DysonFullPath -Path (Join-Path $snapshotRoot $SnapshotId)
    }
    if (-not (Test-DysonPathWithin -Candidate $snapshotPath -Parent $snapshotRoot) -or
        -not (Test-Path -LiteralPath $snapshotPath -PathType Container)) { throw 'The requested deployment snapshot does not exist.' }
    $metadata = Read-DysonJsonFile -Path (Join-Path $snapshotPath 'snapshot.json')
    if ($metadata.protocol -ne $script:DysonDeploymentProtocol -or $metadata.snapshotId -ne (Split-Path -Leaf $snapshotPath)) {
        throw 'The deployment snapshot metadata is invalid.'
    }
    return [ordered]@{ path = $snapshotPath; metadata = $metadata }
}

function Restore-DysonDeploymentSnapshotCore {
    param(
        [Parameter(Mandatory)][string]$InstallRoot,
        [Parameter(Mandatory)][string]$DataRoot,
        [Parameter(Mandatory)][string]$SnapshotId,
        [switch]$PreserveProtectedConfiguration
    )

    $snapshot = Get-DysonDeploymentSnapshot -DataRoot $DataRoot -SnapshotId $SnapshotId
    $metadata = $snapshot.metadata
    $configPath = Join-Path $DataRoot 'config'
    $savedConfigPath = Join-Path $snapshot.path 'config'
    $replacementPath = Join-Path $DataRoot ('.config-restore-' + [guid]::NewGuid().ToString('N'))
    $supersededPath = Join-Path $DataRoot ('.config-superseded-' + [guid]::NewGuid().ToString('N'))
    if (-not $PreserveProtectedConfiguration) {
        try {
            if ([bool]$metadata.configPresent) { Copy-DysonDirectoryContents -Source $savedConfigPath -Destination $replacementPath }
            if (Test-Path -LiteralPath $configPath -PathType Container) { [System.IO.Directory]::Move($configPath, $supersededPath) }
            if ([bool]$metadata.configPresent) { [System.IO.Directory]::Move($replacementPath, $configPath) }
            Remove-DysonDeploymentPlainTree -Path $supersededPath -ExpectedParent $DataRoot `
                -ExpectedLeafPattern '^\.config-superseded-[0-9a-f]{32}$'
        }
        catch {
            if ((Test-Path -LiteralPath $supersededPath) -and -not (Test-Path -LiteralPath $configPath)) {
                [System.IO.Directory]::Move($supersededPath, $configPath)
            }
            throw
        }
        finally {
            Remove-DysonDeploymentPlainTree -Path $replacementPath -ExpectedParent $DataRoot `
                -ExpectedLeafPattern '^\.config-restore-[0-9a-f]{32}$'
        }
    }

    $identityMarkerPath = Get-DysonDeploymentIdentityMarkerPath -InstallRoot $InstallRoot
    $snapshotHadIdentity = $metadata.PSObject.Properties.Name -contains 'hadDeploymentIdentity' -and
        [bool]$metadata.hadDeploymentIdentity
    if ($snapshotHadIdentity) {
        $savedIdentityPath = Join-Path $snapshot.path $script:DysonDeploymentIdentityName
        $savedIdentity = Read-DysonDeploymentIdentityMarker -MarkerPath $savedIdentityPath `
            -ExpectedInstallRoot $InstallRoot -ExpectedDataRoot $DataRoot
        if ([string]$savedIdentity.markerSha256 -cne [string]$metadata.deploymentIdentitySha256) {
            throw 'The saved deployment identity no longer matches its snapshot.'
        }
        Write-DysonJsonAtomic -Path $identityMarkerPath -Value $savedIdentity.marker
        $restoredIdentity = Get-DysonDeploymentIdentity -InstallRoot $InstallRoot -DataRoot $DataRoot
        if ([string]$restoredIdentity.markerSha256 -cne [string]$metadata.deploymentIdentitySha256) {
            throw 'The deployment identity was not restored byte-for-byte.'
        }
    }
    elseif (Test-Path -LiteralPath $identityMarkerPath) {
        $identityItem = Get-Item -LiteralPath $identityMarkerPath -Force -ErrorAction Stop
        if ($identityItem.PSIsContainer -or
            ($identityItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint)) {
            throw 'The deployment identity rollback target is redirected or invalid.'
        }
        Remove-Item -LiteralPath $identityItem.FullName -Force -ErrorAction Stop
    }

    $activePointerPath = Get-DysonActivePointerPath -DataRoot $DataRoot
    if ([bool]$metadata.hadActivePointer) {
        $savedPointer = Join-Path $snapshot.path $script:DysonActivePointerName
        $savedPointerHash = Get-DysonFileSha256 -Path $savedPointer
        if ($savedPointerHash -ne [string]$metadata.activePointerSha256) { throw 'The saved active pointer no longer matches its snapshot.' }
        $pointer = Read-DysonJsonFile -Path $savedPointer
        $releaseRoot = Join-Path (Join-Path $InstallRoot 'releases') ([string]$pointer.version)
        [void](Test-DysonRelease -ReleaseRoot $releaseRoot -ExpectedVersion ([string]$pointer.version) -ExpectedEntryPoint ([string]$pointer.entryPoint))
        Write-DysonJsonAtomic -Path $activePointerPath -Value $pointer
    }
    elseif (Test-Path -LiteralPath $activePointerPath) {
        Remove-Item -LiteralPath $activePointerPath -Force
    }
    return [ordered]@{
        snapshotId = [string]$metadata.snapshotId
        restoredVersion = if ([bool]$metadata.hadActivePointer) { [string]$metadata.activeVersion } else { $null }
        configRestored = [bool](-not $PreserveProtectedConfiguration -and $metadata.configPresent)
    }
}

function Restart-DysonControlTask {
    param([Parameter(Mandatory)][string]$TaskName)

    if ($TaskName -notmatch '^[\p{L}\p{N}_. -]{1,128}$') { throw 'The control-plane task name is invalid.' }
    $tasks = @(Get-DysonScheduledTasksByExactName -TaskName $TaskName)
    if ($tasks.Count -ne 1) { throw 'The fixed control-plane task identity is not unique.' }
    $task = $tasks[0]
    if ($task.PSObject.Properties.Name -notcontains 'TaskPath' -or
        [string]$task.TaskPath -cne $script:DysonControlTaskPath -or
        $task.State.ToString() -eq 'Disabled') {
        throw 'The fixed control-plane task is unavailable.'
    }
    if ($task.State.ToString() -eq 'Running') {
        Stop-ScheduledTask -InputObject $task -ErrorAction Stop
        $deadline = (Get-Date).AddSeconds(20)
        do {
            Start-Sleep -Milliseconds 250
            $tasks = @(Get-DysonScheduledTasksByExactName -TaskName $TaskName)
            if ($tasks.Count -ne 1 -or $tasks[0].PSObject.Properties.Name -notcontains 'TaskPath' -or
                [string]$tasks[0].TaskPath -cne $script:DysonControlTaskPath) {
                throw 'The fixed control-plane task identity changed while restarting.'
            }
            $task = $tasks[0]
        } while ($task.State.ToString() -eq 'Running' -and (Get-Date) -lt $deadline)
        if ($task.State.ToString() -eq 'Running') { throw 'The control-plane task did not stop before the restart deadline.' }
    }
    Start-ScheduledTask -InputObject $task -ErrorAction Stop
}

function Test-DysonDeploymentPathEqual {
    param(
        [Parameter(Mandatory)][string]$Left,
        [Parameter(Mandatory)][string]$Right
    )

    try {
        return [string]::Equals(
            (Get-DysonFullPath -Path $Left).TrimEnd('\', '/'),
            (Get-DysonFullPath -Path $Right).TrimEnd('\', '/'),
            [System.StringComparison]::OrdinalIgnoreCase
        )
    }
    catch { return $false }
}

function Read-DysonDeploymentStatusEnvironmentFile {
    param([Parameter(Mandatory)][string]$Path)

    $item = Get-Item -LiteralPath $Path -Force -ErrorAction Stop
    if ($item.PSIsContainer -or ($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -or
        $item.Length -lt 1 -or $item.Length -gt 65536) {
        throw 'The production environment file is unavailable, redirected, empty, or too large.'
    }
    $configured = @{}
    foreach ($line in [System.IO.File]::ReadAllLines($item.FullName, [System.Text.Encoding]::UTF8)) {
        $trimmed = $line.Trim()
        if ($trimmed.Length -eq 0 -or $trimmed.StartsWith('#')) { continue }
        $separator = $line.IndexOf('=')
        if ($separator -lt 1) { throw 'The production environment file contains an invalid line.' }
        $name = $line.Substring(0, $separator).Trim()
        $value = $line.Substring($separator + 1)
        if ($name -ne 'NODE_ENV' -and $name -notmatch '^DYSON_[A-Z0-9_]{1,96}$') {
            throw 'The production environment file contains an unsupported variable.'
        }
        if ($configured.ContainsKey($name)) { throw 'The production environment file contains a duplicate variable.' }
        $configured[$name] = $value
    }
    return $configured
}

function Assert-DysonLifecycleBrokerStaticNoPendingWork {
    param([Parameter(Mandatory)]$Storage)

    if (@(Get-ChildItem -LiteralPath $Storage.intents -Force -ErrorAction Stop).Count -ne 0) {
        throw 'The lifecycle broker has an unfinished intent.'
    }
    $requestIds = @{}
    foreach ($file in @(Get-ChildItem -LiteralPath $Storage.requests -Force -ErrorAction Stop)) {
        if ($file.PSIsContainer -or $file.Extension -cne '.json') {
            throw 'The lifecycle broker request directory contains an unsupported entry.'
        }
        $id = ConvertTo-DysonLifecycleBrokerGuid ([string]$file.BaseName) `
            'DYSON_CONTROL_LIFECYCLE_BROKER_RECOVERY_REQUIRED'
        $paths = Get-DysonLifecycleBrokerRecordPaths -Storage $Storage -BrokerRequestId $id
        if (-not (Test-DysonLifecycleBrokerSamePath ([string]$file.FullName) ([string]$paths.request)) -or
            -not (Test-Path -LiteralPath $paths.receipt -PathType Leaf)) {
            throw 'The lifecycle broker has an unfinished request.'
        }
        $request = ConvertTo-DysonLifecycleBrokerValidatedRequest (
            Read-DysonLifecycleBrokerJson -Path $paths.request `
                -MaximumBytes $script:DysonLifecycleBrokerMaximumRequestBytes `
                -InvalidCode 'DYSON_CONTROL_LIFECYCLE_BROKER_REQUEST_INVALID'
        )
        $receipt = ConvertTo-DysonLifecycleBrokerValidatedReceipt (
            Read-DysonLifecycleBrokerJson -Path $paths.receipt `
                -MaximumBytes $script:DysonLifecycleBrokerMaximumReceiptBytes `
                -InvalidCode 'DYSON_CONTROL_LIFECYCLE_BROKER_RECEIPT_INVALID'
        )
        if ([string]$request.brokerRequestId -cne $id -or [string]$receipt.brokerRequestId -cne $id -or
            [string]$request.requestFingerprint -cne [string]$receipt.requestFingerprint -or
            [string]$request.capability -cne [string]$receipt.capability) {
            throw 'The lifecycle broker request and receipt do not form a closed pair.'
        }
        $requestIds[$id] = $true
    }
    foreach ($file in @(Get-ChildItem -LiteralPath $Storage.receipts -Force -ErrorAction Stop)) {
        if ($file.PSIsContainer -or $file.Extension -cne '.json') {
            throw 'The lifecycle broker receipt directory contains an unsupported entry.'
        }
        $id = ConvertTo-DysonLifecycleBrokerGuid ([string]$file.BaseName) `
            'DYSON_CONTROL_LIFECYCLE_BROKER_RECOVERY_REQUIRED'
        if (-not $requestIds.ContainsKey($id)) { throw 'The lifecycle broker has an orphaned receipt.' }
    }
}

function Assert-DysonLifecycleBrokerStaticWorkerTask {
    param(
        [Parameter(Mandatory)]$Task,
        [Parameter(Mandatory)]$Profile,
        [Parameter(Mandatory)][string]$ProfileFile
    )

    $actions = @($Task.Actions | Where-Object { $null -ne $_ })
    $triggers = @($Task.Triggers | Where-Object { $null -ne $_ })
    $expectedPowerShell = Get-DysonFullPath -Path (Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe')
    $expectedWorker = Join-Path ([string]$Profile.brokerScriptRoot) 'Invoke-DysonLifecycleBrokerWorker.ps1'
    $expectedArguments = Get-DysonLifecycleBrokerTaskArguments -BrokerRoot ([string]$Profile.brokerRoot) `
        -ProfileFile $ProfileFile -WorkerScript $expectedWorker
    $userId = [string]$Task.Principal.UserId
    $systemPrincipal = $userId -in @('SYSTEM', 'S-1-5-18', 'NT AUTHORITY\SYSTEM')
    $state = $Task.State.ToString()
    if ([string]$Task.TaskName -cne 'Dyson-Control-Lifecycle-Broker' -or
        [string]$Task.TaskPath -cne '\DysonControl\' -or $actions.Count -ne 1 -or $triggers.Count -ne 0 -or
        -not (Test-DysonDeploymentPathEqual -Left ([Environment]::ExpandEnvironmentVariables([string]$actions[0].Execute)) `
            -Right $expectedPowerShell) -or
        [string]$actions[0].Arguments -cne $expectedArguments -or
        -not [string]::IsNullOrWhiteSpace([string]$actions[0].WorkingDirectory) -or
        -not $systemPrincipal -or [string]$Task.Principal.LogonType -cne 'ServiceAccount' -or
        [string]$Task.Principal.RunLevel -cne 'Highest' -or
        [string]$Task.Settings.MultipleInstances -cne 'IgnoreNew' -or
        [string]$Task.Settings.ExecutionTimeLimit -cne 'PT5M' -or
        $Task.Settings.Enabled -isnot [bool] -or -not [bool]$Task.Settings.Enabled -or
        $state -cnotin @('Ready', 'Running', 'Queued') -or
        [string]$Task.Description -cne 'Executes only profile-bound Dyson lifecycle capabilities; never launches Steam or DSP directly.') {
        throw 'The fixed lifecycle broker worker task is inconsistent with its active profile.'
    }
}

function Get-DysonLifecycleBrokerStaticWorkerTasks {
    try {
        # Get-ScheduledTask reports an absent named task with different error
        # identifiers across supported Windows builds and language packs. An
        # unfiltered query followed by the existing exact-name validator keeps
        # real scheduler-query failures closed while making "not installed" a
        # stable empty result.
        return @(Get-DysonScheduledTasksByExactName `
            -TaskName 'Dyson-Control-Lifecycle-Broker')
    }
    catch {
        throw 'The fixed lifecycle broker task state could not be queried.'
    }
}

function Get-DysonLifecycleBrokerStaticStatus {
    param(
        [Parameter(Mandatory)][string]$InstallRoot,
        [Parameter(Mandatory)][string]$DataRoot,
        [Parameter(Mandatory)]$ActiveRelease,
        [Parameter(Mandatory)][string]$EnvironmentFile
    )

    $installFull = Assert-DysonSafeRoot -Path $InstallRoot -Name 'InstallRoot'
    $dataFull = Assert-DysonSafeRoot -Path $DataRoot -Name 'DataRoot'
    $releaseRoot = Assert-DysonPlainDirectory -Path ([string]$ActiveRelease.releaseRoot)
    $expectedEnvironmentFile = Get-DysonFullPath -Path (Join-Path $dataFull 'config\dyson-control.env')
    if (-not (Test-DysonDeploymentPathEqual -Left $EnvironmentFile -Right $expectedEnvironmentFile)) {
        throw 'The lifecycle broker status environment is outside the fixed deployment configuration path.'
    }
    $configured = Read-DysonDeploymentStatusEnvironmentFile -Path $EnvironmentFile
    $lifecycleGate = if ($configured.ContainsKey('DYSON_LIFECYCLE_ENABLED')) {
        [string]$configured['DYSON_LIFECYCLE_ENABLED']
    }
    else { 'false' }
    if ($lifecycleGate -cnotin @('true', 'false')) {
        throw 'The lifecycle configuration gate is invalid.'
    }

    $windowsRoot = Assert-DysonPlainDirectory -Path (Join-Path $releaseRoot 'scripts\windows')
    $brokerScriptRoot = Assert-DysonPlainDirectory -Path (Join-Path $windowsRoot 'lifecycle-broker')
    $brokerCommon = Join-Path $brokerScriptRoot 'DysonLifecycleBroker.Common.ps1'
    $brokerCommonItem = Get-Item -LiteralPath $brokerCommon -Force -ErrorAction Stop
    if ($brokerCommonItem.PSIsContainer -or
        ($brokerCommonItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint)) {
        throw 'The active lifecycle broker helper is unavailable or redirected.'
    }
    . $brokerCommonItem.FullName

    $expectedData = Get-DysonFullPath -Path (Join-Path $dataFull 'data')
    $expectedBrokerRoot = Get-DysonFullPath -Path (Join-Path $expectedData 'lifecycle-broker')
    $expectedProfileFile = Get-DysonFullPath -Path (Join-Path $expectedBrokerRoot 'broker-profile.json')
    $expectedBootstrap = Get-DysonFullPath -Path (Join-Path $installFull 'bootstrap')
    $profilePresent = Test-Path -LiteralPath $expectedProfileFile -PathType Leaf
    $brokerRootExists = Test-Path -LiteralPath $expectedBrokerRoot
    $brokerRootPresent = Test-Path -LiteralPath $expectedBrokerRoot -PathType Container
    $tasks = @(Get-DysonLifecycleBrokerStaticWorkerTasks)
    $pendingClean = -not $brokerRootExists -or $brokerRootPresent
    if ($brokerRootPresent) {
        $storage = Get-DysonLifecycleBrokerStorage -BrokerRoot $expectedBrokerRoot
        $allowedRootEntries = @('broker-profile.json', 'intents', 'receipts', 'requests')
        if (@(Get-ChildItem -LiteralPath $storage.root -Force -ErrorAction Stop |
                Where-Object {
                    $_.Name -cnotin $allowedRootEntries -or
                    ($_.Name -ceq 'broker-profile.json' -and $_.PSIsContainer)
                }).Count -ne 0) {
            $pendingClean = $false
        }
        try { Assert-DysonLifecycleBrokerStaticNoPendingWork -Storage $storage }
        catch { $pendingClean = $false }
    }

    $enabled = $lifecycleGate -ceq 'true'
    if (-not $enabled) {
        $residual = $profilePresent -or $tasks.Count -ne 0 -or -not $pendingClean
        return [pscustomobject][ordered]@{
            ready = $false
            consistent = -not $residual
            enabled = $false
            state = if ($residual) { 'disabled-residual' } else { 'disabled-clean' }
            profileBound = $false
            taskBound = $false
            pendingClean = [bool]$pendingClean
        }
    }

    foreach ($required in @(
        'DYSON_PROVIDER', 'DYSON_LIFECYCLE_BROKER_PROFILE_FILE', 'DYSON_PROJECT_ROOT',
        'DYSON_DATA_DIR', 'DYSON_RUNTIME_SERVICE_USER', 'DYSON_GAME_PORT'
    )) {
        if (-not $configured.ContainsKey($required) -or
            [string]::IsNullOrWhiteSpace([string]$configured[$required])) {
            throw 'The enabled lifecycle broker configuration is incomplete.'
        }
    }
    if ([string]$configured['DYSON_PROVIDER'] -cne 'windows' -or
        -not (Test-DysonDeploymentPathEqual -Left ([string]$configured['DYSON_LIFECYCLE_BROKER_PROFILE_FILE']) `
            -Right $expectedProfileFile) -or
        -not (Test-DysonDeploymentPathEqual -Left ([string]$configured['DYSON_DATA_DIR']) -Right $expectedData) -or
        [string]$configured['DYSON_GAME_PORT'] -cnotmatch '^[1-9][0-9]{0,4}$' -or
        [int]$configured['DYSON_GAME_PORT'] -gt 65535) {
        throw 'The enabled lifecycle broker configuration is not bound to the fixed deployment paths.'
    }
    if (-not $brokerRootPresent -or -not $profilePresent -or $tasks.Count -ne 1 -or -not $pendingClean) {
        throw 'The enabled lifecycle broker has missing, ambiguous, or pending fixed state.'
    }

    $profile = Read-DysonLifecycleBrokerProfile -ProfileFile $expectedProfileFile
    if (-not (Test-DysonLifecycleBrokerSamePath ([string]$profile.brokerRoot) $expectedBrokerRoot) -or
        -not (Test-DysonLifecycleBrokerSamePath ([string]$profile.brokerScriptRoot) $brokerScriptRoot) -or
        -not (Test-DysonLifecycleBrokerSamePath ([string]$profile.installedWindowsRoot) $windowsRoot) -or
        -not (Test-DysonLifecycleBrokerSamePath ([string]$profile.runtimeBootstrapRoot) $expectedBootstrap) -or
        -not (Test-DysonLifecycleBrokerSamePath ([string]$profile.projectRoot) ([string]$configured['DYSON_PROJECT_ROOT'])) -or
        -not (Test-DysonLifecycleBrokerSamePath ([string]$profile.dataRoot) $expectedData) -or
        [string]$profile.serviceUser -cne [string]$configured['DYSON_RUNTIME_SERVICE_USER'] -or
        [int]$profile.gamePort -ne [int]$configured['DYSON_GAME_PORT']) {
        throw 'The lifecycle broker profile is not bound to the active release and production environment.'
    }
    Assert-DysonLifecycleBrokerDependencies -Profile $profile
    [void](Assert-DysonLifecycleBrokerTaskPair -Profile $profile)
    Assert-DysonLifecycleBrokerStaticWorkerTask -Task $tasks[0] -Profile $profile -ProfileFile $expectedProfileFile
    return [pscustomobject][ordered]@{
        ready = $true
        consistent = $true
        enabled = $true
        state = 'ready'
        profileBound = $true
        taskBound = $true
        pendingClean = $true
    }
}

function Test-DysonLoopbackReadiness {
    param(
        [Parameter(Mandatory)][uri]$ReadinessUri,
        [Parameter(Mandatory)][string]$ExpectedVersion,
        [string[]]$RequiredChecks = @(),
        [ValidateRange(1, 300)][int]$TimeoutSeconds = 30
    )

    Assert-DysonVersion -Version $ExpectedVersion
    $requiredCheckNames = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::Ordinal)
    foreach ($requiredCheck in @($RequiredChecks)) {
        if ([string]::IsNullOrWhiteSpace($requiredCheck) -or
            $requiredCheck -cnotmatch '^[A-Za-z][A-Za-z0-9]{0,63}$' -or
            -not $requiredCheckNames.Add($requiredCheck)) {
            throw 'RequiredChecks contains an invalid or duplicate readiness check name.'
        }
    }
    if ($ReadinessUri.Scheme -ne 'http' -or $ReadinessUri.AbsolutePath -ne '/readyz' -or
        $ReadinessUri.Host -notin @('127.0.0.1', 'localhost', '::1')) {
        throw 'ReadinessUri must be a loopback HTTP /readyz endpoint.'
    }
    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    do {
        try {
            $response = Invoke-WebRequest -Uri $ReadinessUri.AbsoluteUri -UseBasicParsing -TimeoutSec 2 -ErrorAction Stop
            if ([int]$response.StatusCode -ge 200 -and [int]$response.StatusCode -lt 300) {
                $readinessBody = ConvertFrom-Json -InputObject ([string]$response.Content) -ErrorAction Stop
                $reportedHeaderVersion = [string]$response.Headers['X-Dyson-Control-Release']
                $reportedBodyVersion = if ($readinessBody.PSObject.Properties['deploymentVersion']) {
                    [string]$readinessBody.deploymentVersion
                }
                else { $null }
                $checks = if ($readinessBody.PSObject.Properties['checks']) { $readinessBody.checks } else { $null }
                $checkValues = @(
                    if ($checks) { $checks.PSObject.Properties | ForEach-Object { [string]$_.Value } }
                )
                $checksValid = $checks -and $checkValues.Count -ge 3 -and
                    @($checkValues | Where-Object { $_ -notin @('pass', 'not-applicable') }).Count -eq 0
                $requiredChecksValid = $null -ne $checks
                if ($requiredChecksValid) {
                    foreach ($requiredCheck in $requiredCheckNames) {
                        $requiredProperty = $checks.PSObject.Properties[$requiredCheck]
                        if ($null -eq $requiredProperty -or [string]$requiredProperty.Value -cne 'pass') {
                            $requiredChecksValid = $false
                            break
                        }
                    }
                }
                if ([string]::Equals([string]$readinessBody.status, 'ready', [System.StringComparison]::Ordinal) -and
                    [string]::Equals($reportedHeaderVersion, $ExpectedVersion, [System.StringComparison]::Ordinal) -and
                    [string]::Equals($reportedBodyVersion, $ExpectedVersion, [System.StringComparison]::Ordinal) -and
                    $checksValid -and $requiredChecksValid) {
                    return $true
                }
            }
        }
        catch { }
        if ((Get-Date) -lt $deadline) { Start-Sleep -Milliseconds 500 }
    } while ((Get-Date) -lt $deadline)
    throw 'The loopback control-plane readiness check did not prove the expected release before the deadline.'
}

function Assert-DysonQualifiedClientAuthority {
    param([Parameter(Mandatory)][string]$Authority)

    if ([string]::IsNullOrWhiteSpace($Authority) -or $Authority.Length -gt 253 -or
        $Authority.Trim() -cne $Authority -or $Authority.ToLowerInvariant() -cne $Authority -or
        $Authority.EndsWith('.', [System.StringComparison]::Ordinal) -or
        $Authority.IndexOf([char]0) -ge 0) {
        throw 'The qualified-client authority must be a canonical lowercase public DNS hostname.'
    }
    $parsedAddress = $null
    if ([System.Net.IPAddress]::TryParse($Authority, [ref]$parsedAddress)) {
        throw 'The qualified-client authority must not be an IP address literal.'
    }
    $labels = @($Authority.Split('.'))
    if ($labels.Count -lt 2) {
        throw 'The qualified-client authority must be a canonical lowercase public DNS hostname.'
    }
    foreach ($label in $labels) {
        if ($label.Length -lt 1 -or $label.Length -gt 63 -or
            $label -cnotmatch '^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$') {
            throw 'The qualified-client authority must be a canonical lowercase public DNS hostname.'
        }
    }
    return $Authority
}

function Get-DysonQualifiedClientStoragePlan {
    param(
        [Parameter(Mandatory)][hashtable]$Configured,
        [Parameter(Mandatory)][string]$DataRoot
    )

    $dataFull = Assert-DysonSafeRoot -Path $DataRoot -Name 'DataRoot'
    $enabledPresent = $Configured.ContainsKey('DYSON_QUALIFIED_CLIENT_PROFILE_ENABLED')
    $enabled = $false
    if ($enabledPresent) {
        $enabledValue = [string]$Configured['DYSON_QUALIFIED_CLIENT_PROFILE_ENABLED']
        if ($enabledValue -cnotin @('true', 'false')) {
            throw 'The qualified-client feature gate must be exactly true or false.'
        }
        $enabled = $enabledValue -ceq 'true'
    }
    $bindingNames = @($script:DysonQualifiedClientEnvironmentNames | Where-Object {
        $_ -cne 'DYSON_QUALIFIED_CLIENT_PROFILE_ENABLED'
    })
    $bindingPresent = @($bindingNames | Where-Object { $Configured.ContainsKey($_) }).Count -gt 0
    if (-not $enabled -and -not $bindingPresent) {
        return [pscustomobject][ordered]@{
            protocol = $script:DysonQualifiedClientStorageProtocol
            configured = $false
            enabled = $false
            layoutSha256 = $null
            authority = $null
            dataRoot = $dataFull
            entries = @()
        }
    }

    foreach ($name in $script:DysonQualifiedClientEnvironmentNames) {
        if (-not $Configured.ContainsKey($name) -or
            [string]::IsNullOrWhiteSpace([string]$Configured[$name])) {
            throw 'The qualified-client V2 environment contract is incomplete.'
        }
    }
    if (-not $Configured.ContainsKey('DYSON_PROVIDER') -or
        [string]$Configured['DYSON_PROVIDER'] -cne 'windows') {
        throw 'Qualified-client V2 storage requires the Windows provider.'
    }
    $authority = Assert-DysonQualifiedClientAuthority `
        -Authority ([string]$Configured['DYSON_CLIENT_QUALIFICATION_AUTHORITY'])
    $container = Join-Path $dataFull 'data\qualified-client'
    $rootBindings = @(
        [ordered]@{ variable = 'DYSON_CLIENT_QUALIFICATION_EVIDENCE_ROOT'; relative = 'evidence'; role = 'private' },
        [ordered]@{ variable = 'DYSON_CLIENT_QUALIFICATION_BUILD_HARVEST_ROOT_A'; relative = 'build-harvest-a'; role = 'read' },
        [ordered]@{ variable = 'DYSON_CLIENT_QUALIFICATION_BUILD_HARVEST_ROOT_B'; relative = 'build-harvest-b'; role = 'read' },
        [ordered]@{ variable = 'DYSON_CLIENT_QUALIFICATION_KEY_RING_ROOT'; relative = 'key-ring'; role = 'private' },
        [ordered]@{ variable = 'DYSON_CLIENT_QUALIFICATION_REPLAY_ROOT'; relative = 'replay'; role = 'private' },
        [ordered]@{ variable = 'DYSON_QUALIFIED_CLIENT_ISSUE_ROOT'; relative = 'issued'; role = 'write' }
    )
    $identities = [System.Collections.Generic.HashSet[string]]::new(
        [System.StringComparer]::OrdinalIgnoreCase
    )
    foreach ($binding in $rootBindings) {
        $configuredPath = [string]$Configured[[string]$binding.variable]
        if (-not [System.IO.Path]::IsPathRooted($configuredPath) -or
            $configuredPath.IndexOf([char]0) -ge 0 -or $configuredPath -match '["\r\n]') {
            throw 'Qualified-client storage roots must be absolute plain paths.'
        }
        $expectedPath = Join-Path $container ([string]$binding.relative)
        if (-not (Test-DysonDeploymentPathEqual -Left $configuredPath -Right $expectedPath)) {
            throw 'A qualified-client storage root does not match the fixed DataRoot layout.'
        }
        $identity = Get-DysonDeploymentPathIdentity -Path $configuredPath
        if (-not $identities.Add($identity)) {
            throw 'Qualified-client storage roots must be pairwise disjoint.'
        }
    }

    $entries = @(
        [pscustomobject][ordered]@{ name = 'container'; path = $container; role = 'read' },
        [pscustomobject][ordered]@{ name = 'evidence'; path = Join-Path $container 'evidence'; role = 'private' },
        [pscustomobject][ordered]@{ name = 'build-harvest-a'; path = Join-Path $container 'build-harvest-a'; role = 'read' },
        [pscustomobject][ordered]@{ name = 'build-harvest-b'; path = Join-Path $container 'build-harvest-b'; role = 'read' },
        [pscustomobject][ordered]@{ name = 'key-ring'; path = Join-Path $container 'key-ring'; role = 'private' },
        [pscustomobject][ordered]@{ name = 'replay'; path = Join-Path $container 'replay'; role = 'private' },
        [pscustomobject][ordered]@{ name = 'replay-acceptances'; path = Join-Path $container 'replay\acceptances'; role = 'private' },
        [pscustomobject][ordered]@{ name = 'replay-claims'; path = Join-Path $container 'replay\claims'; role = 'private' },
        [pscustomobject][ordered]@{ name = 'replay-receipt-claims'; path = Join-Path $container 'replay\claims\receipt-id'; role = 'private' },
        [pscustomobject][ordered]@{ name = 'replay-nonce-claims'; path = Join-Path $container 'replay\claims\nonce'; role = 'private' },
        [pscustomobject][ordered]@{ name = 'issued'; path = Join-Path $container 'issued'; role = 'write' },
        [pscustomobject][ordered]@{ name = 'issued-objects'; path = Join-Path $container 'issued\objects'; role = 'write' },
        [pscustomobject][ordered]@{ name = 'issued-by-qualification'; path = Join-Path $container 'issued\by-qualification'; role = 'write' },
        [pscustomobject][ordered]@{ name = 'issued-locks'; path = Join-Path $container 'issued\locks'; role = 'write' }
    )
    $digestLines = @(
        'protocol=' + $script:DysonQualifiedClientStorageProtocol,
        'enabled=' + $enabled.ToString().ToLowerInvariant(),
        'authority=' + $authority
    )
    foreach ($entry in $entries) {
        $digestLines += ([string]$entry.name + '|' + [string]$entry.role + '|' +
            (Get-DysonDeploymentPathIdentity -Path ([string]$entry.path)))
    }
    return [pscustomobject][ordered]@{
        protocol = $script:DysonQualifiedClientStorageProtocol
        configured = $true
        enabled = $enabled
        layoutSha256 = Get-DysonTextSha256 -Value ([string]::Join("`n", $digestLines))
        authority = $authority
        dataRoot = $dataFull
        entries = $entries
    }
}

function Get-DysonQualifiedClientStorageSelfTestSid {
    param(
        [Parameter(Mandatory)][string]$DataRoot,
        [switch]$AllowSelfTestAdministrator
    )

    if (-not $AllowSelfTestAdministrator) { return $null }
    if ($env:DYSON_DEPLOYMENT_ALLOW_SELFTEST_TASKS -cne 'true' -or
        [string]::IsNullOrWhiteSpace($env:DYSON_DEPLOYMENT_SELFTEST_ROOT_IDENTITY)) {
        throw 'The qualified-client ACL fixture exception is outside the authorized self-test.'
    }
    $fixtureIdentity = (Get-DysonDeploymentPathIdentity `
        -Path $env:DYSON_DEPLOYMENT_SELFTEST_ROOT_IDENTITY).TrimEnd('\', '/')
    $temporaryIdentity = (Get-DysonDeploymentPathIdentity `
        -Path ([System.IO.Path]::GetTempPath())).TrimEnd('\', '/')
    $dataIdentity = Get-DysonDeploymentPathIdentity -Path $DataRoot
    $relative = if (Test-DysonDeploymentIdentityPathWithin `
        -CandidateIdentity $fixtureIdentity -ParentIdentity $temporaryIdentity) {
        $fixtureIdentity.Substring($temporaryIdentity.Length + 1)
    }
    else { '' }
    if ($relative -cnotmatch '^DYSON-CONTROL-DEPLOYMENT-SELFTEST-[0-9A-F]{32}$' -or
        -not (Test-DysonDeploymentIdentityPathWithin -CandidateIdentity $dataIdentity `
            -ParentIdentity $fixtureIdentity)) {
        throw 'The qualified-client ACL fixture exception is outside the authorized self-test.'
    }
    [void](Assert-DysonDeploymentPlainPathChain -Path $fixtureIdentity)
    $dataDirectory = Assert-DysonPlainDirectory -Path $DataRoot
    return (Microsoft.PowerShell.Security\Get-Acl -LiteralPath $dataDirectory `
        -ErrorAction Stop).GetOwner([System.Security.Principal.SecurityIdentifier]).Value
}

function Get-DysonQualifiedClientStorageAclIntent {
    param(
        [Parameter(Mandatory)][ValidateSet('private', 'read', 'write')][string]$Role,
        [Parameter(Mandatory)][string]$DataRoot,
        [ValidateSet('NT AUTHORITY\LOCAL SERVICE')]
        [string]$ServiceAccount = 'NT AUTHORITY\LOCAL SERVICE',
        [switch]$AllowSelfTestAdministrator
    )

    if ($ServiceAccount -cne 'NT AUTHORITY\LOCAL SERVICE') {
        throw 'Qualified-client storage supports only the Local Service identity.'
    }
    $selfTestSid = Get-DysonQualifiedClientStorageSelfTestSid -DataRoot $DataRoot `
        -AllowSelfTestAdministrator:$AllowSelfTestAdministrator
    $serviceSid = if ($selfTestSid) { $selfTestSid } else { 'S-1-5-19' }
    $ownerSid = if ($Role -ceq 'private') { $serviceSid }
        elseif ($selfTestSid) { $selfTestSid }
        else { 'S-1-5-32-544' }
    $serviceRights = switch ($Role) {
        'private' { [System.Security.AccessControl.FileSystemRights]::FullControl }
        'read' {
            [System.Security.AccessControl.FileSystemRights]::ReadAndExecute -bor
                [System.Security.AccessControl.FileSystemRights]::Synchronize
        }
        'write' {
            [System.Security.AccessControl.FileSystemRights]::Modify -bor
                [System.Security.AccessControl.FileSystemRights]::Synchronize
        }
    }
    $rules = [ordered]@{
        'S-1-5-18' = [System.Security.AccessControl.FileSystemRights]::FullControl
        'S-1-5-32-544' = [System.Security.AccessControl.FileSystemRights]::FullControl
    }
    $rules[$serviceSid] = $serviceRights
    return [pscustomobject][ordered]@{
        ownerSid = $ownerSid
        rules = $rules
    }
}

function Set-DysonQualifiedClientStorageAcl {
    param(
        [Parameter(Mandatory)][string]$Path,
        [Parameter(Mandatory)][ValidateSet('private', 'read', 'write')][string]$Role,
        [Parameter(Mandatory)][string]$DataRoot,
        [ValidateSet('NT AUTHORITY\LOCAL SERVICE')]
        [string]$ServiceAccount = 'NT AUTHORITY\LOCAL SERVICE',
        [switch]$AllowSelfTestAdministrator
    )

    $directory = Assert-DysonPlainDirectory -Path $Path
    $intent = Get-DysonQualifiedClientStorageAclIntent -Role $Role -DataRoot $DataRoot `
        -ServiceAccount $ServiceAccount -AllowSelfTestAdministrator:$AllowSelfTestAdministrator
    $security = [System.Security.AccessControl.DirectorySecurity]::new()
    $security.SetAccessRuleProtection($true, $false)
    $security.SetOwner([System.Security.Principal.SecurityIdentifier]::new([string]$intent.ownerSid))
    $existingSecurity = Microsoft.PowerShell.Security\Get-Acl -LiteralPath $directory -ErrorAction Stop
    $security.SetGroup($existingSecurity.GetGroup([System.Security.Principal.SecurityIdentifier]))
    $inheritance = [System.Security.AccessControl.InheritanceFlags]'ContainerInherit, ObjectInherit'
    foreach ($sid in @($intent.rules.Keys)) {
        $security.AddAccessRule([System.Security.AccessControl.FileSystemAccessRule]::new(
            [System.Security.Principal.SecurityIdentifier]::new([string]$sid),
            [System.Security.AccessControl.FileSystemRights]$intent.rules[$sid],
            $inheritance,
            [System.Security.AccessControl.PropagationFlags]::None,
            [System.Security.AccessControl.AccessControlType]::Allow
        ))
    }
    Set-DysonQualifiedClientDirectorySecurity -Path $directory -Security $security
    [void](Assert-DysonQualifiedClientStorageAcl -Path $directory -Role $Role `
        -DataRoot $DataRoot -ServiceAccount $ServiceAccount `
        -AllowSelfTestAdministrator:$AllowSelfTestAdministrator)
}

function Set-DysonQualifiedClientDirectorySecurity {
    param(
        [Parameter(Mandatory)][string]$Path,
        [Parameter(Mandatory)][System.Security.AccessControl.DirectorySecurity]$Security
    )

    $directory = [System.IO.DirectoryInfo]::new((Assert-DysonPlainDirectory -Path $Path))
    $legacyMethod = @([System.IO.Directory].GetMethods() | Where-Object {
        $_.Name -ceq 'SetAccessControl' -and $_.IsStatic -and
        $_.GetParameters().Count -eq 2
    } | Select-Object -First 1)
    if ($legacyMethod.Count -eq 1) {
        [void]$legacyMethod[0].Invoke($null, @($directory.FullName, $Security))
        return
    }
    [System.IO.FileSystemAclExtensions]::SetAccessControl($directory, $Security)
}

function Assert-DysonQualifiedClientStorageAcl {
    param(
        [Parameter(Mandatory)][string]$Path,
        [Parameter(Mandatory)][ValidateSet('private', 'read', 'write')][string]$Role,
        [Parameter(Mandatory)][string]$DataRoot,
        [ValidateSet('NT AUTHORITY\LOCAL SERVICE')]
        [string]$ServiceAccount = 'NT AUTHORITY\LOCAL SERVICE',
        [switch]$AllowSelfTestAdministrator
    )

    $directory = Assert-DysonPlainDirectory -Path $Path
    $intent = Get-DysonQualifiedClientStorageAclIntent -Role $Role -DataRoot $DataRoot `
        -ServiceAccount $ServiceAccount -AllowSelfTestAdministrator:$AllowSelfTestAdministrator
    $security = Microsoft.PowerShell.Security\Get-Acl -LiteralPath $directory -ErrorAction Stop
    if (-not $security.AreAccessRulesProtected) {
        throw 'A qualified-client storage DACL still inherits access rules.'
    }
    $owner = $security.GetOwner([System.Security.Principal.SecurityIdentifier]).Value
    if (-not [string]::Equals($owner, [string]$intent.ownerSid,
            [System.StringComparison]::OrdinalIgnoreCase)) {
        throw 'A qualified-client storage directory has an unexpected owner.'
    }
    $rules = @($security.GetAccessRules(
        $true, $true, [System.Security.Principal.SecurityIdentifier]
    ))
    if ($rules.Count -ne $intent.rules.Count) {
        throw 'A qualified-client storage DACL has an unexpected rule count.'
    }
    $observed = @{}
    $inheritance = [System.Security.AccessControl.InheritanceFlags]'ContainerInherit, ObjectInherit'
    foreach ($rule in $rules) {
        $sid = [string]$rule.IdentityReference.Value
        if (-not $intent.rules.Contains($sid) -or $observed.ContainsKey($sid) -or
            $rule.IsInherited -or
            $rule.AccessControlType -ne [System.Security.AccessControl.AccessControlType]::Allow -or
            [int64]$rule.FileSystemRights -ne [int64]$intent.rules[$sid] -or
            $rule.InheritanceFlags -ne $inheritance -or
            $rule.PropagationFlags -ne [System.Security.AccessControl.PropagationFlags]::None) {
            throw 'A qualified-client storage DACL has an unexpected rule.'
        }
        $observed[$sid] = $true
    }
    foreach ($sid in @($intent.rules.Keys)) {
        if (-not $observed.ContainsKey([string]$sid)) {
            throw 'A qualified-client storage DACL is missing an expected rule.'
        }
    }
    return $directory
}

function Test-DysonQualifiedClientStorageAcl {
    param(
        [Parameter(Mandatory)][string]$Path,
        [Parameter(Mandatory)][ValidateSet('private', 'read', 'write')][string]$Role,
        [Parameter(Mandatory)][string]$DataRoot,
        [ValidateSet('NT AUTHORITY\LOCAL SERVICE')]
        [string]$ServiceAccount = 'NT AUTHORITY\LOCAL SERVICE',
        [switch]$AllowSelfTestAdministrator
    )

    try {
        [void](Assert-DysonQualifiedClientStorageAcl -Path $Path -Role $Role `
            -DataRoot $DataRoot -ServiceAccount $ServiceAccount `
            -AllowSelfTestAdministrator:$AllowSelfTestAdministrator)
        return $true
    }
    catch { return $false }
}

function Assert-DysonQualifiedClientStorageNearestAncestor {
    param([Parameter(Mandatory)][string]$Path)

    $candidate = Get-DysonFullPath -Path $Path
    while (-not (Test-Path -LiteralPath $candidate)) {
        $parent = [System.IO.Path]::GetDirectoryName($candidate.TrimEnd('\', '/'))
        if ([string]::IsNullOrWhiteSpace($parent) -or
            [string]::Equals($parent, $candidate, [System.StringComparison]::OrdinalIgnoreCase)) {
            throw 'A qualified-client storage path has no verifiable plain ancestor.'
        }
        $candidate = $parent
    }
    [void](Assert-DysonDeploymentPlainPathChain -Path $candidate)
}

function Get-DysonQualifiedClientStoragePreimage {
    param(
        [Parameter(Mandatory)]$Plan,
        [ValidateSet('NT AUTHORITY\LOCAL SERVICE')]
        [string]$ServiceAccount = 'NT AUTHORITY\LOCAL SERVICE',
        [switch]$AllowSelfTestAdministrator
    )

    if (-not [bool]$Plan.configured) {
        return [pscustomobject][ordered]@{
            protocol = $script:DysonQualifiedClientStorageProtocol
            configured = $false
            layoutSha256 = $null
            entries = @()
        }
    }
    if (Test-Path -LiteralPath ([string]@($Plan.entries)[0].path) -PathType Container) {
        [void](Assert-DysonDeploymentPlainTree -Path ([string]@($Plan.entries)[0].path))
    }
    $states = @(
        foreach ($entry in @($Plan.entries)) {
            $path = [string]$entry.path
            if ((Test-Path -LiteralPath $path) -and
                -not (Test-Path -LiteralPath $path -PathType Container)) {
                throw 'A qualified-client storage directory is occupied by a non-directory entry.'
            }
            $exists = Test-Path -LiteralPath $path -PathType Container
            $sddl = $null
            $aclReady = $false
            $directEntryCount = 0
            if ($exists) {
                [void](Assert-DysonPlainDirectory -Path $path)
                $sddl = (Microsoft.PowerShell.Security\Get-Acl -LiteralPath $path -ErrorAction Stop).Sddl
                $aclReady = Test-DysonQualifiedClientStorageAcl -Path $path `
                    -Role ([string]$entry.role) -DataRoot ([string]$Plan.dataRoot) `
                    -ServiceAccount $ServiceAccount `
                    -AllowSelfTestAdministrator:$AllowSelfTestAdministrator
                $directEntryCount = @(Get-ChildItem -LiteralPath $path -Force -ErrorAction Stop).Count
                if (-not $aclReady -and $directEntryCount -ne 0) {
                    throw 'A populated qualified-client directory has an unmanaged ACL and cannot be adopted automatically.'
                }
            }
            else {
                Assert-DysonQualifiedClientStorageNearestAncestor -Path $path
            }
            [pscustomobject][ordered]@{
                name = [string]$entry.name
                existed = [bool]$exists
                sddl = $sddl
                aclReady = [bool]$aclReady
                directEntryCount = [int]$directEntryCount
            }
        }
    )
    return [pscustomobject][ordered]@{
        protocol = $script:DysonQualifiedClientStorageProtocol
        configured = $true
        layoutSha256 = [string]$Plan.layoutSha256
        entries = $states
    }
}

function Assert-DysonQualifiedClientStoragePreimageUnchanged {
    param(
        [Parameter(Mandatory)]$Plan,
        [Parameter(Mandatory)]$Expected,
        [ValidateSet('NT AUTHORITY\LOCAL SERVICE')]
        [string]$ServiceAccount = 'NT AUTHORITY\LOCAL SERVICE',
        [switch]$AllowSelfTestAdministrator
    )

    $actual = Get-DysonQualifiedClientStoragePreimage -Plan $Plan `
        -ServiceAccount $ServiceAccount -AllowSelfTestAdministrator:$AllowSelfTestAdministrator
    if ([bool]$actual.configured -ne [bool]$Expected.configured -or
        [string]$actual.layoutSha256 -cne [string]$Expected.layoutSha256 -or
        @($actual.entries).Count -ne @($Expected.entries).Count) {
        throw 'The qualified-client storage preimage changed before mutation.'
    }
    for ($index = 0; $index -lt @($actual.entries).Count; $index += 1) {
        $before = @($Expected.entries)[$index]
        $after = @($actual.entries)[$index]
        if ([string]$before.name -cne [string]$after.name -or
            [bool]$before.existed -ne [bool]$after.existed -or
            [string]$before.sddl -cne [string]$after.sddl -or
            [bool]$before.aclReady -ne [bool]$after.aclReady -or
            (-not [bool]$before.aclReady -and
                [int]$before.directEntryCount -ne [int]$after.directEntryCount)) {
            throw 'The qualified-client storage preimage changed before mutation.'
        }
    }
    return $actual
}

function Set-DysonQualifiedClientStorageRemovalAcl {
    param([Parameter(Mandatory)][string]$Path)

    $directory = Assert-DysonPlainDirectory -Path $Path
    $existingSecurity = Microsoft.PowerShell.Security\Get-Acl -LiteralPath $directory -ErrorAction Stop
    $identity = $existingSecurity.GetOwner([System.Security.Principal.SecurityIdentifier])
    $security = [System.Security.AccessControl.DirectorySecurity]::new()
    $security.SetAccessRuleProtection($true, $false)
    $security.SetOwner($identity)
    $security.SetGroup($existingSecurity.GetGroup([System.Security.Principal.SecurityIdentifier]))
    $sidMap = @{}
    foreach ($sid in @(
        $identity,
        [System.Security.Principal.WindowsIdentity]::GetCurrent().User,
        [System.Security.Principal.SecurityIdentifier]::new('S-1-5-18'),
        [System.Security.Principal.SecurityIdentifier]::new('S-1-5-32-544')
    )) { $sidMap[$sid.Value] = $sid }
    foreach ($sid in @($sidMap.Values)) {
        $security.AddAccessRule([System.Security.AccessControl.FileSystemAccessRule]::new(
            $sid,
            [System.Security.AccessControl.FileSystemRights]::FullControl,
            [System.Security.AccessControl.InheritanceFlags]'ContainerInherit, ObjectInherit',
            [System.Security.AccessControl.PropagationFlags]::None,
            [System.Security.AccessControl.AccessControlType]::Allow
        ))
    }
    Set-DysonQualifiedClientDirectorySecurity -Path $directory -Security $security
}

function Restore-DysonQualifiedClientStoragePreimage {
    param(
        [Parameter(Mandatory)]$Plan,
        [Parameter(Mandatory)]$Preimage
    )

    if (-not [bool]$Plan.configured) {
        return [pscustomobject][ordered]@{
            protocol = $script:DysonQualifiedClientStorageProtocol
            configured = $false
            restored = $true
            layoutSha256 = $null
        }
    }
    $beforeByName = @{}
    foreach ($state in @($Preimage.entries)) { $beforeByName[[string]$state.name] = $state }
    $entries = @($Plan.entries)
    for ($index = $entries.Count - 1; $index -ge 0; $index -= 1) {
        $entry = $entries[$index]
        $state = $beforeByName[[string]$entry.name]
        if ($null -eq $state) { throw 'The qualified-client storage rollback preimage is incomplete.' }
        $path = [string]$entry.path
        if ([bool]$state.existed) {
            if (-not (Test-Path -LiteralPath $path -PathType Container)) {
                throw 'A qualified-client storage rollback target is missing.'
            }
            if (-not [bool]$state.aclReady) {
                $security = [System.Security.AccessControl.DirectorySecurity]::new()
                $security.SetSecurityDescriptorSddlForm([string]$state.sddl)
                Set-DysonQualifiedClientDirectorySecurity -Path $path -Security $security
            }
        }
        elseif (Test-Path -LiteralPath $path) {
            $directory = Assert-DysonPlainDirectory -Path $path
            if (@(Get-ChildItem -LiteralPath $directory -Force -ErrorAction Stop).Count -ne 0) {
                throw 'A newly-created qualified-client storage directory is no longer empty.'
            }
            Set-DysonQualifiedClientStorageRemovalAcl -Path $directory
            [System.IO.Directory]::Delete($directory, $false)
        }
    }
    foreach ($entry in @($Plan.entries)) {
        $state = $beforeByName[[string]$entry.name]
        $path = [string]$entry.path
        if ([bool]$state.existed) {
            if (-not (Test-Path -LiteralPath $path -PathType Container) -or
                (Microsoft.PowerShell.Security\Get-Acl -LiteralPath $path -ErrorAction Stop).Sddl -cne
                    [string]$state.sddl) {
                throw 'The qualified-client storage rollback did not restore its exact ACL preimage.'
            }
        }
        elseif (Test-Path -LiteralPath $path) {
            throw 'The qualified-client storage rollback did not remove a created directory.'
        }
    }
    return [pscustomobject][ordered]@{
        protocol = $script:DysonQualifiedClientStorageProtocol
        configured = $true
        restored = $true
        layoutSha256 = [string]$Plan.layoutSha256
    }
}

function Test-DysonQualifiedClientStorage {
    param(
        [Parameter(Mandatory)]$Plan,
        [ValidateSet('NT AUTHORITY\LOCAL SERVICE')]
        [string]$ServiceAccount = 'NT AUTHORITY\LOCAL SERVICE',
        [switch]$AllowSelfTestAdministrator
    )

    if (-not [bool]$Plan.configured) {
        return [pscustomobject][ordered]@{
            protocol = $script:DysonQualifiedClientStorageProtocol
            configured = $false
            enabled = $false
            ready = $true
            layoutSha256 = $null
            directoryCount = 0
        }
    }
    $entries = @($Plan.entries)
    if ($entries.Count -ne 14) { throw 'The qualified-client storage layout is incomplete.' }
    [void](Assert-DysonDeploymentPlainTree -Path ([string]$entries[0].path))
    foreach ($entry in $entries) {
        [void](Assert-DysonQualifiedClientStorageAcl -Path ([string]$entry.path) `
            -Role ([string]$entry.role) -DataRoot ([string]$Plan.dataRoot) `
            -ServiceAccount $ServiceAccount `
            -AllowSelfTestAdministrator:$AllowSelfTestAdministrator)
    }
    return [pscustomobject][ordered]@{
        protocol = $script:DysonQualifiedClientStorageProtocol
        configured = $true
        enabled = [bool]$Plan.enabled
        ready = $true
        layoutSha256 = [string]$Plan.layoutSha256
        directoryCount = [int]$entries.Count
    }
}

function Install-DysonQualifiedClientStorage {
    param(
        [Parameter(Mandatory)]$Plan,
        [Parameter(Mandatory)]$Preimage,
        [ValidateSet('NT AUTHORITY\LOCAL SERVICE')]
        [string]$ServiceAccount = 'NT AUTHORITY\LOCAL SERVICE',
        [switch]$AllowSelfTestAdministrator
    )

    if (-not [bool]$Plan.configured) {
        return Test-DysonQualifiedClientStorage -Plan $Plan -ServiceAccount $ServiceAccount `
            -AllowSelfTestAdministrator:$AllowSelfTestAdministrator
    }
    [void](Assert-DysonQualifiedClientStoragePreimageUnchanged -Plan $Plan `
        -Expected $Preimage -ServiceAccount $ServiceAccount `
        -AllowSelfTestAdministrator:$AllowSelfTestAdministrator)
    $preimageByName = @{}
    foreach ($state in @($Preimage.entries)) { $preimageByName[[string]$state.name] = $state }
    $stage = 'directory creation'
    try {
        foreach ($entry in @($Plan.entries)) {
            if (-not (Test-Path -LiteralPath ([string]$entry.path) -PathType Container)) {
                [System.IO.Directory]::CreateDirectory([string]$entry.path) | Out-Null
                [void](Assert-DysonPlainDirectory -Path ([string]$entry.path))
            }
        }
        [void](Assert-DysonDeploymentPlainTree -Path ([string]@($Plan.entries)[0].path))
        $stage = 'ACL protection'
        $entries = @($Plan.entries)
        for ($index = $entries.Count - 1; $index -ge 0; $index -= 1) {
            $entry = $entries[$index]
            $state = $preimageByName[[string]$entry.name]
            if ($null -eq $state) { throw 'The qualified-client storage preimage is incomplete.' }
            if (-not [bool]$state.aclReady) {
                Set-DysonQualifiedClientStorageAcl -Path ([string]$entry.path) `
                    -Role ([string]$entry.role) -DataRoot ([string]$Plan.dataRoot) `
                    -ServiceAccount $ServiceAccount `
                    -AllowSelfTestAdministrator:$AllowSelfTestAdministrator
            }
        }
        $stage = 'read-back verification'
        return Test-DysonQualifiedClientStorage -Plan $Plan -ServiceAccount $ServiceAccount `
            -AllowSelfTestAdministrator:$AllowSelfTestAdministrator
    }
    catch {
        try { [void](Restore-DysonQualifiedClientStoragePreimage -Plan $Plan -Preimage $Preimage) }
        catch { throw 'The qualified-client storage transaction failed and automatic rollback was incomplete.' }
        throw "The qualified-client storage transaction failed during $stage and restored its preimage."
    }
}

function ConvertTo-DysonJsonLine {
    param([Parameter(Mandatory, ValueFromPipeline)]$Value)
    process { return ($Value | ConvertTo-Json -Depth 12 -Compress) }
}
