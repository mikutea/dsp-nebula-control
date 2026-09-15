Set-StrictMode -Version 2.0

. (Join-Path $PSScriptRoot 'NebulaPrivateBuild.Common.ps1')
. (Join-Path $PSScriptRoot '..\DysonHostMutationLease.Common.ps1')

$script:NebulaPluginPlanProtocol = 'DYSON_NEBULA_PLUGIN_TRANSACTION_PLAN_V3'
$script:NebulaPluginIntentProtocol = 'DYSON_NEBULA_PLUGIN_TRANSACTION_INTENT_V3'
$script:NebulaPluginReceiptProtocol = 'DYSON_NEBULA_PLUGIN_TRANSACTION_RECEIPT_V3'
$script:NebulaPluginInventoryProtocol = 'DYSON_NEBULA_PLUGIN_TREE_INVENTORY_V1'
$script:NebulaPluginShadowEvidenceProtocol = 'DYSON_NEBULA_PLUGIN_SHADOW_EVIDENCE_V1'
$script:NebulaPluginDirectoryIdentityProtocol = 'DYSON_NEBULA_DIRECTORY_IDENTITY_V1'
$script:NebulaPluginParentBoundaryProtocol = 'DYSON_NEBULA_PARENT_BOUNDARY_V1'
$script:NebulaPluginZeroDigest = ('0' * 64)
$script:NebulaPluginMaximumJsonBytes = [int64](8MB)

function Throw-NebulaPluginError {
    param([Parameter(Mandatory)][string]$Code)
    Throw-NebulaPrivateError -Code $Code
}

function Assert-NebulaPluginRole {
    param([AllowNull()][string]$Role)
    if ($Role -cne 'Client' -and $Role -cne 'Server') {
        Throw-NebulaPluginError 'NEBULA_PLUGIN_TARGET_ROLE_INVALID'
    }
    return $Role
}

function Assert-NebulaPluginBackend {
    param([AllowNull()][string]$Backend)
    if ($Backend -cne 'Windows' -and $Backend -cne 'Shadow') {
        Throw-NebulaPluginError 'NEBULA_PLUGIN_BACKEND_INVALID'
    }
    return $Backend
}

function Get-NebulaPluginPathIdentity {
    param([Parameter(Mandatory)][string]$Path)
    $full = (Get-NebulaPrivateFullPath -Path $Path).TrimEnd('\').ToUpperInvariant()
    return 'sha256:' + (Get-NebulaPrivateObjectSha256 -Value $full)
}

function Initialize-NebulaPluginIdentityNativeMethods {
    if ('Dyson.NebulaPluginIdentityNative' -as [type]) { return }
    try {
        Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;

namespace Dyson {
    [StructLayout(LayoutKind.Sequential)]
    public struct NebulaPluginByHandleFileInformation {
        public uint FileAttributes;
        public System.Runtime.InteropServices.ComTypes.FILETIME CreationTime;
        public System.Runtime.InteropServices.ComTypes.FILETIME LastAccessTime;
        public System.Runtime.InteropServices.ComTypes.FILETIME LastWriteTime;
        public uint VolumeSerialNumber;
        public uint FileSizeHigh;
        public uint FileSizeLow;
        public uint NumberOfLinks;
        public uint FileIndexHigh;
        public uint FileIndexLow;
    }

    public static class NebulaPluginIdentityNative {
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        public static extern SafeFileHandle CreateFile(
            string fileName,
            uint desiredAccess,
            uint shareMode,
            IntPtr securityAttributes,
            uint creationDisposition,
            uint flagsAndAttributes,
            IntPtr templateFile);

        [DllImport("kernel32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        public static extern bool GetFileInformationByHandle(
            SafeFileHandle file,
            out NebulaPluginByHandleFileInformation information);
    }
}
'@ -ErrorAction Stop
    }
    catch { Throw-NebulaPluginError 'NEBULA_PLUGIN_DIRECTORY_IDENTITY_UNAVAILABLE' }
}

function Assert-NebulaPluginDirectoryIdentityValue {
    param([Parameter(Mandatory)]$Identity, [string]$Code = 'NEBULA_PLUGIN_DIRECTORY_IDENTITY_INVALID')
    Assert-NebulaPrivateExactProperties -Value $Identity -Names @(
        'protocol','schemaVersion','volumeSerialNumber','fileId','identityDigest'
    ) -Code $Code
    if ([string]$Identity.protocol -cne $script:NebulaPluginDirectoryIdentityProtocol -or
        [int]$Identity.schemaVersion -ne 1 -or [string]$Identity.volumeSerialNumber -notmatch '^[0-9a-f]{8}$' -or
        [string]$Identity.fileId -notmatch '^[0-9a-f]{16}$') {
        Throw-NebulaPluginError $Code
    }
    [void](Assert-NebulaPluginDocumentDigest -Value $Identity -DigestProperty 'identityDigest' -Code $Code)
    return $Identity
}

function Get-NebulaPluginDirectoryIdentity {
    param([Parameter(Mandatory)][string]$Path)
    $full = Get-NebulaPrivateFullPath -Path $Path
    if (-not (Test-Path -LiteralPath $full -PathType Container)) {
        Throw-NebulaPluginError 'NEBULA_PLUGIN_DIRECTORY_IDENTITY_MISSING'
    }
    Assert-NebulaPrivateNoReparseAncestors -Path $full
    Initialize-NebulaPluginIdentityNativeMethods
    $handle = $null
    try {
        $handle = [Dyson.NebulaPluginIdentityNative]::CreateFile(
            $full, [uint32]0, [uint32]7, [IntPtr]::Zero, [uint32]3, [uint32]0x02000000, [IntPtr]::Zero)
        if ($null -eq $handle -or $handle.IsInvalid) {
            Throw-NebulaPluginError 'NEBULA_PLUGIN_DIRECTORY_IDENTITY_UNAVAILABLE'
        }
        $information = New-Object Dyson.NebulaPluginByHandleFileInformation
        if (-not [Dyson.NebulaPluginIdentityNative]::GetFileInformationByHandle($handle, [ref]$information)) {
            Throw-NebulaPluginError 'NEBULA_PLUGIN_DIRECTORY_IDENTITY_UNAVAILABLE'
        }
        $core = [ordered]@{
            protocol = $script:NebulaPluginDirectoryIdentityProtocol
            schemaVersion = 1
            volumeSerialNumber = ('{0:x8}' -f [uint32]$information.VolumeSerialNumber)
            fileId = ('{0:x8}{1:x8}' -f [uint32]$information.FileIndexHigh, [uint32]$information.FileIndexLow)
        }
        $value = [ordered]@{}
        foreach ($key in $core.Keys) { $value[$key] = $core[$key] }
        $value.identityDigest = Get-NebulaPrivateObjectSha256 -Value $core
        return [pscustomobject]$value
    }
    finally { if ($null -ne $handle) { $handle.Dispose() } }
}

function Assert-NebulaPluginDirectoryIdentityMatches {
    param(
        [Parameter(Mandatory)]$Expected,
        [Parameter(Mandatory)][string]$Path,
        [string]$Code = 'NEBULA_PLUGIN_DIRECTORY_IDENTITY_CHANGED'
    )
    [void](Assert-NebulaPluginDirectoryIdentityValue -Identity $Expected -Code $Code)
    $actual = Get-NebulaPluginDirectoryIdentity -Path $Path
    if ([string]$Expected.identityDigest -cne [string]$actual.identityDigest -or
        [string]$Expected.volumeSerialNumber -cne [string]$actual.volumeSerialNumber -or
        [string]$Expected.fileId -cne [string]$actual.fileId) {
        Throw-NebulaPluginError $Code
    }
    return $actual
}

function Get-NebulaPluginParentBoundary {
    param([Parameter(Mandatory)][string]$Path)
    $identity = Get-NebulaPluginDirectoryIdentity -Path $Path
    try {
        $sections = [Security.AccessControl.AccessControlSections]::Access -bor
            [Security.AccessControl.AccessControlSections]::Owner -bor
            [Security.AccessControl.AccessControlSections]::Group
        $acl = [IO.Directory]::GetAccessControl((Get-NebulaPrivateFullPath -Path $Path), $sections)
        $dangerous = New-Object Collections.Generic.List[string]
        $ownerSid = [string]$acl.GetOwner([Security.Principal.SecurityIdentifier]).Value
        $currentSid = [string][Security.Principal.WindowsIdentity]::GetCurrent().User.Value
        $trustedDeleteChildSids = @('S-1-5-18','S-1-5-32-544',$ownerSid,$currentSid) | Sort-Object -Unique
        foreach ($rule in @($acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier]))) {
            $sid = [string]$rule.IdentityReference.Value
            if ($rule.AccessControlType -eq [Security.AccessControl.AccessControlType]::Allow -and
                $sid -cnotin $trustedDeleteChildSids -and
                (($rule.PropagationFlags -band [Security.AccessControl.PropagationFlags]::InheritOnly) -eq 0) -and
                (([int64]$rule.FileSystemRights -band [int64][Security.AccessControl.FileSystemRights]::DeleteSubdirectoriesAndFiles) -ne 0)) {
                $dangerous.Add($sid)
            }
        }
        $core = [ordered]@{
            protocol = $script:NebulaPluginParentBoundaryProtocol
            schemaVersion = 1
            directoryIdentity = $identity
            aclDigest = Get-NebulaPrivateObjectSha256 -Value $acl.GetSecurityDescriptorSddlForm($sections)
            daclProtected = [bool]$acl.AreAccessRulesProtected
            untrustedDeleteChildSids = @($dangerous | Sort-Object -Unique)
        }
        $value = [ordered]@{}
        foreach ($key in $core.Keys) { $value[$key] = $core[$key] }
        $value.boundaryDigest = Get-NebulaPrivateObjectSha256 -Value $core
        return [pscustomobject]$value
    }
    catch {
        if ((Get-NebulaPrivateErrorCode -Exception $_.Exception) -cne 'NEBULA_PRIVATE_UNEXPECTED_FAILURE') { throw }
        Throw-NebulaPluginError 'NEBULA_PLUGIN_PARENT_BOUNDARY_UNAVAILABLE'
    }
}

function Assert-NebulaPluginParentBoundaryValue {
    param([Parameter(Mandatory)]$Boundary, [string]$Code = 'NEBULA_PLUGIN_PARENT_BOUNDARY_INVALID')
    Assert-NebulaPrivateExactProperties -Value $Boundary -Names @(
        'protocol','schemaVersion','directoryIdentity','aclDigest','daclProtected','untrustedDeleteChildSids','boundaryDigest'
    ) -Code $Code
    if ([string]$Boundary.protocol -cne $script:NebulaPluginParentBoundaryProtocol -or
        [int]$Boundary.schemaVersion -ne 1 -or -not (Test-NebulaPrivateSha256 -Value ([string]$Boundary.aclDigest)) -or
        $Boundary.daclProtected -isnot [bool]) {
        Throw-NebulaPluginError $Code
    }
    foreach ($sid in @($Boundary.untrustedDeleteChildSids)) {
        if ([string]$sid -notmatch '^S-1-(?:[0-9]+-){1,14}[0-9]+$') { Throw-NebulaPluginError $Code }
    }
    [void](Assert-NebulaPluginDirectoryIdentityValue -Identity $Boundary.directoryIdentity -Code $Code)
    [void](Assert-NebulaPluginDocumentDigest -Value $Boundary -DigestProperty 'boundaryDigest' -Code $Code)
    return $Boundary
}

function Assert-NebulaPluginParentBoundarySafe {
    param([Parameter(Mandatory)]$Boundary)
    [void](Assert-NebulaPluginParentBoundaryValue -Boundary $Boundary)
    if (-not [bool]$Boundary.daclProtected) {
        Throw-NebulaPluginError 'NEBULA_PLUGIN_PARENT_DACL_NOT_PROTECTED'
    }
    if (@($Boundary.untrustedDeleteChildSids).Count -ne 0) {
        Throw-NebulaPluginError 'NEBULA_PLUGIN_PARENT_DELETE_CHILD_UNSAFE'
    }
    return $Boundary
}

function Assert-NebulaPluginParentBoundaryMatches {
    param([Parameter(Mandatory)]$Expected, [Parameter(Mandatory)][string]$Path)
    [void](Assert-NebulaPluginParentBoundarySafe -Boundary $Expected)
    $actual = Get-NebulaPluginParentBoundary -Path $Path
    [void](Assert-NebulaPluginParentBoundarySafe -Boundary $actual)
    if ([string]$Expected.boundaryDigest -cne [string]$actual.boundaryDigest) {
        Throw-NebulaPluginError 'NEBULA_PLUGIN_PARENT_BOUNDARY_CHANGED'
    }
    return $actual
}

function Assert-NebulaPluginShadowGameRoot {
    param([Parameter(Mandatory)][string]$GameRoot)
    $full = Get-NebulaPrivateFullPath -Path $GameRoot
    $temp = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\')
    if (-not (Test-NebulaPrivatePathWithin -Candidate $full -Parent $temp)) {
        Throw-NebulaPluginError 'NEBULA_PLUGIN_SHADOW_SCOPE_INVALID'
    }
    $relative = $full.Substring($temp.Length).TrimStart('\')
    $first = @($relative.Split('\'))[0]
    if (-not ($first.StartsWith('dyson-nebula-private-selftest-', [StringComparison]::Ordinal) -or
        $first.StartsWith('dyson-nebula-transaction-selftest-', [StringComparison]::Ordinal))) {
        Throw-NebulaPluginError 'NEBULA_PLUGIN_SHADOW_SCOPE_INVALID'
    }
    return $full
}

function Get-NebulaPluginLayout {
    param(
        [Parameter(Mandatory)][string]$GameRoot,
        [Parameter(Mandatory)][string]$RequestId,
        [Parameter(Mandatory)][ValidateSet('Windows','Shadow')][string]$Backend
    )
    if (-not (Test-NebulaPrivateUuid -Value $RequestId)) {
        Throw-NebulaPluginError 'NEBULA_PLUGIN_REQUEST_ID_INVALID'
    }
    $game = if ($Backend -ceq 'Shadow') {
        Assert-NebulaPluginShadowGameRoot -GameRoot $GameRoot
    }
    else { Get-NebulaPrivateFullPath -Path $GameRoot }
    if ([IO.Path]::GetFileName($game) -cne 'Dyson Sphere Program') {
        Throw-NebulaPluginError 'NEBULA_PLUGIN_GAME_ROOT_IDENTITY_INVALID'
    }
    if (-not (Test-Path -LiteralPath $game -PathType Container)) {
        Throw-NebulaPluginError 'NEBULA_PLUGIN_GAME_ROOT_MISSING'
    }
    $drive = New-Object IO.DriveInfo([IO.Path]::GetPathRoot($game))
    if ($drive.DriveType -ne [IO.DriveType]::Fixed -or
        -not [string]::Equals($drive.DriveFormat, 'NTFS', [StringComparison]::OrdinalIgnoreCase)) {
        Throw-NebulaPluginError 'NEBULA_PLUGIN_GAME_ROOT_NOT_FIXED_NTFS'
    }
    Assert-NebulaPrivateNoReparseAncestors -Path $game
    $bepInEx = Join-Path $game 'BepInEx'
    $plugins = Join-Path $bepInEx 'plugins'
    $stage = Join-Path $bepInEx ('.plugins.dyson-stage.' + $RequestId)
    $quarantine = Join-Path $bepInEx ('.plugins.dyson-quarantine.' + $RequestId)
    $state = Join-Path $bepInEx '.dyson-private-cutover'
    $intent = Join-Path $state ('requests\' + $RequestId + '.intent.json')
    $receipt = Join-Path $state ('receipts\' + $RequestId + '.receipt.json')
    $lock = Join-Path $state 'locks\whole-tree.lock'
    foreach ($path in @($bepInEx,$plugins,$stage,$quarantine,$state,$intent,$receipt,$lock)) {
        $full = Get-NebulaPrivateFullPath -Path $path
        if (-not (Test-NebulaPrivatePathWithin -Candidate $full -Parent $game) -or
            -not [IO.Path]::GetPathRoot($full).Equals([IO.Path]::GetPathRoot($game), [StringComparison]::OrdinalIgnoreCase)) {
            Throw-NebulaPluginError 'NEBULA_PLUGIN_TARGET_SCOPE_INVALID'
        }
        Assert-NebulaPrivateNoReparseAncestors -Path $full
    }
    if (-not (Test-Path -LiteralPath $bepInEx -PathType Container)) {
        Throw-NebulaPluginError 'NEBULA_PLUGIN_TARGET_TREE_MISSING'
    }
    return [pscustomobject][ordered]@{
        gameRoot = $game; bepInExRoot = $bepInEx; pluginsRoot = $plugins
        stageRoot = $stage; quarantineRoot = $quarantine; stateRoot = $state
        intentPath = $intent; receiptPath = $receipt; lockPath = $lock
    }
}

function Get-NebulaPluginTargetBinding {
    param(
        [Parameter(Mandatory)][string]$GameRoot,
        [Parameter(Mandatory)][ValidateSet('Client','Server')][string]$TargetRole
    )
    $gameFull = Get-NebulaPrivateFullPath -Path $GameRoot
    $pathIdentity = Get-NebulaPluginPathIdentity -Path $gameFull
    $gameDirectoryIdentity = Get-NebulaPluginDirectoryIdentity -Path $gameFull
    $bepInExDirectoryIdentity = Get-NebulaPluginDirectoryIdentity -Path (Join-Path $gameFull 'BepInEx')
    $physical = [ordered]@{
        gamePathIdentity = $pathIdentity
        gameDirectoryIdentityDigest = [string]$gameDirectoryIdentity.identityDigest
        bepInExDirectoryIdentityDigest = [string]$bepInExDirectoryIdentity.identityDigest
        gameDirectoryLeaf = 'Dyson Sphere Program'
        pluginTreeLeaf = 'plugins'
    }
    $physicalTargetDigest = Get-NebulaPrivateObjectSha256 -Value $physical
    $binding = [ordered]@{
        targetRole = $TargetRole
        gamePathIdentity = $pathIdentity
        physicalTargetDigest = $physicalTargetDigest
        gameDirectoryLeaf = 'Dyson Sphere Program'
        pluginTreeLeaf = 'plugins'
    }
    return [pscustomobject][ordered]@{
        value = [pscustomobject]$binding
        digest = Get-NebulaPrivateObjectSha256 -Value $binding
        physicalValue = [pscustomobject]$physical
        physicalTargetDigest = $physicalTargetDigest
        gameDirectoryIdentity = $gameDirectoryIdentity
        bepInExDirectoryIdentity = $bepInExDirectoryIdentity
    }
}

function Get-NebulaPluginAclSddl {
    param([Parameter(Mandatory)][string]$Path)
    try {
        $item = Get-Item -LiteralPath $Path -Force -ErrorAction Stop
        $sections = [Security.AccessControl.AccessControlSections]::Access -bor
            [Security.AccessControl.AccessControlSections]::Owner -bor
            [Security.AccessControl.AccessControlSections]::Group
        $acl = if ($item.PSIsContainer) {
            [IO.Directory]::GetAccessControl($item.FullName, $sections)
        }
        else { [IO.File]::GetAccessControl($item.FullName, $sections) }
        return $acl.GetSecurityDescriptorSddlForm($sections)
    }
    catch { Throw-NebulaPluginError 'NEBULA_PLUGIN_ACL_READ_FAILED' }
}

function Get-NebulaPluginTreeInventory {
    param(
        [Parameter(Mandatory)][string]$Root,
        [Parameter(Mandatory)][string]$TargetBindingDigest
    )
    if (-not (Test-NebulaPrivateSha256 -Value $TargetBindingDigest)) {
        Throw-NebulaPluginError 'NEBULA_PLUGIN_TARGET_BINDING_INVALID'
    }
    $rootFull = Get-NebulaPrivateFullPath -Path $Root
    $files = @(Get-NebulaPrivatePlainFiles -Root $rootFull)
    $directories = New-Object Collections.Generic.List[object]
    $queue = New-Object Collections.Generic.Queue[string]
    $queue.Enqueue($rootFull)
    while ($queue.Count -gt 0) {
        $directory = $queue.Dequeue()
        $relative = if ($directory.Equals($rootFull, [StringComparison]::OrdinalIgnoreCase)) {
            '.'
        }
        else { $directory.Substring($rootFull.Length).TrimStart('\').Replace('\','/') }
        $directories.Add([pscustomobject][ordered]@{
            path = $relative
            sddl = Get-NebulaPluginAclSddl -Path $directory
        })
        foreach ($child in @(Get-ChildItem -LiteralPath $directory -Force -Directory -ErrorAction Stop)) {
            if (($child.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
                Throw-NebulaPluginError 'NEBULA_PRIVATE_REPARSE_POINT_REJECTED'
            }
            $queue.Enqueue($child.FullName)
        }
    }
    $fileValues = @($files | ForEach-Object {
        [pscustomobject][ordered]@{
            path = [string]$_.path
            size = [int64]$_.size
            sha256 = [string]$_.sha256
            sddl = Get-NebulaPluginAclSddl -Path ([string]$_.fullPath)
        }
    })
    $directoryValues = @($directories | Sort-Object -Property path -CaseSensitive)
    $aclValues = @(
        $directoryValues | ForEach-Object { [pscustomobject][ordered]@{ kind='directory'; path=$_.path; sddl=$_.sddl } }
        $fileValues | ForEach-Object { [pscustomobject][ordered]@{ kind='file'; path=$_.path; sddl=$_.sddl } }
    )
    $core = [ordered]@{
        protocol = $script:NebulaPluginInventoryProtocol
        schemaVersion = 1
        targetBindingDigest = $TargetBindingDigest
        contentTreeSha256 = Get-NebulaPrivateTreeDigest -Records $files
        fileCount = [int]$files.Count
        aclDigest = Get-NebulaPrivateObjectSha256 -Value $aclValues
        directories = $directoryValues
        files = $fileValues
    }
    $value = [ordered]@{}
    foreach ($key in $core.Keys) { $value[$key] = $core[$key] }
    $value.inventoryDigest = Get-NebulaPrivateObjectSha256 -Value $core
    return [pscustomobject]$value
}

function Assert-NebulaPluginInventoryMatches {
    param(
        [Parameter(Mandatory)]$Expected,
        [Parameter(Mandatory)][string]$Root,
        [Parameter(Mandatory)][string]$TargetBindingDigest,
        [string]$MismatchCode = 'NEBULA_PLUGIN_TREE_INVENTORY_MISMATCH'
    )
    $actual = Get-NebulaPluginTreeInventory -Root $Root -TargetBindingDigest $TargetBindingDigest
    if ([string]$Expected.inventoryDigest -cne [string]$actual.inventoryDigest -or
        [string]$Expected.contentTreeSha256 -cne [string]$actual.contentTreeSha256 -or
        [string]$Expected.aclDigest -cne [string]$actual.aclDigest -or
        [int]$Expected.fileCount -ne [int]$actual.fileCount) {
        Throw-NebulaPluginError $MismatchCode
    }
    return $actual
}

function Assert-NebulaPluginInventoryValue {
    param([Parameter(Mandatory)]$Inventory, [string]$Code = 'NEBULA_PLUGIN_TREE_INVENTORY_INVALID')
    Assert-NebulaPrivateExactProperties -Value $Inventory -Names @(
        'protocol','schemaVersion','targetBindingDigest','contentTreeSha256','fileCount','aclDigest',
        'directories','files','inventoryDigest'
    ) -Code $Code
    if ([string]$Inventory.protocol -cne $script:NebulaPluginInventoryProtocol -or
        [int]$Inventory.schemaVersion -ne 1 -or
        -not (Test-NebulaPrivateSha256 -Value ([string]$Inventory.targetBindingDigest)) -or
        -not (Test-NebulaPrivateSha256 -Value ([string]$Inventory.contentTreeSha256)) -or
        -not (Test-NebulaPrivateSha256 -Value ([string]$Inventory.aclDigest)) -or
        [int]$Inventory.fileCount -lt 0 -or [int]$Inventory.fileCount -ne @($Inventory.files).Count -or
        @($Inventory.directories).Count -lt 1) {
        Throw-NebulaPluginError $Code
    }
    foreach ($directory in @($Inventory.directories)) {
        Assert-NebulaPrivateExactProperties -Value $directory -Names @('path','sddl') -Code $Code
        if ([string]::IsNullOrWhiteSpace([string]$directory.path) -or
            [string]::IsNullOrWhiteSpace([string]$directory.sddl)) { Throw-NebulaPluginError $Code }
    }
    foreach ($file in @($Inventory.files)) {
        Assert-NebulaPrivateExactProperties -Value $file -Names @('path','size','sha256','sddl') -Code $Code
        if ([string]::IsNullOrWhiteSpace([string]$file.path) -or [int64]$file.size -lt 0 -or
            -not (Test-NebulaPrivateSha256 -Value ([string]$file.sha256)) -or
            [string]::IsNullOrWhiteSpace([string]$file.sddl)) { Throw-NebulaPluginError $Code }
    }
    [void](Assert-NebulaPluginDocumentDigest -Value $Inventory -DigestProperty 'inventoryDigest' -Code $Code)
    return $Inventory
}

function Read-NebulaPluginJson {
    param([Parameter(Mandatory)][string]$Path)
    $full = Get-NebulaPrivateFullPath -Path $Path
    if (-not (Test-Path -LiteralPath $full -PathType Leaf)) {
        Throw-NebulaPluginError 'NEBULA_PLUGIN_EVIDENCE_MISSING'
    }
    $item = Get-Item -LiteralPath $full -Force
    if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0 -or
        $item.Length -le 0 -or $item.Length -gt $script:NebulaPluginMaximumJsonBytes) {
        Throw-NebulaPluginError 'NEBULA_PLUGIN_EVIDENCE_INVALID'
    }
    try { return Get-Content -LiteralPath $full -Raw -Encoding UTF8 | ConvertFrom-Json }
    catch { Throw-NebulaPluginError 'NEBULA_PLUGIN_EVIDENCE_INVALID' }
}

function Write-NebulaPluginJsonNew {
    param(
        [Parameter(Mandatory)][string]$Path,
        [Parameter(Mandatory)]$Value,
        [Parameter(Mandatory)][string]$AllowedRoot
    )
    $target = Get-NebulaPrivateFullPath -Path $Path
    $root = Get-NebulaPrivateFullPath -Path $AllowedRoot
    if (-not (Test-NebulaPrivatePathWithin -Candidate $target -Parent $root) -or
        $target.Equals($root, [StringComparison]::OrdinalIgnoreCase)) {
        Throw-NebulaPluginError 'NEBULA_PLUGIN_WRITE_SCOPE_INVALID'
    }
    $parent = [IO.Path]::GetDirectoryName($target)
    [IO.Directory]::CreateDirectory($parent) | Out-Null
    Assert-NebulaPrivateNoReparseAncestors -Path $parent
    if (Test-Path -LiteralPath $target) { Throw-NebulaPluginError 'NEBULA_PLUGIN_OUTPUT_ALREADY_EXISTS' }
    $temporary = $target + '.tmp.' + [guid]::NewGuid().ToString('N')
    $bytes = [Text.UTF8Encoding]::new($false).GetBytes((ConvertTo-NebulaPrivateCanonicalJson -Value $Value) + "`n")
    $stream = [IO.FileStream]::new($temporary, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write,
        [IO.FileShare]::None, 4096, [IO.FileOptions]::WriteThrough)
    try { $stream.Write($bytes, 0, $bytes.Length); $stream.Flush($true) }
    finally { $stream.Dispose() }
    try { [IO.File]::Move($temporary, $target) }
    finally { if (Test-Path -LiteralPath $temporary) { [IO.File]::Delete($temporary) } }
    return $target
}

function Get-NebulaPluginDocumentDigest {
    param([Parameter(Mandatory)]$Value, [Parameter(Mandatory)][string]$DigestProperty)
    $core = [ordered]@{}
    foreach ($property in $Value.PSObject.Properties) {
        if ([string]$property.Name -cne $DigestProperty) { $core[[string]$property.Name] = $property.Value }
    }
    return Get-NebulaPrivateObjectSha256 -Value $core
}

function Assert-NebulaPluginDocumentDigest {
    param(
        [Parameter(Mandatory)]$Value,
        [Parameter(Mandatory)][string]$DigestProperty,
        [Parameter(Mandatory)][string]$Code
    )
    $property = $Value.PSObject.Properties[$DigestProperty]
    if ($null -eq $property -or -not (Test-NebulaPrivateSha256 -Value ([string]$property.Value)) -or
        [string]$property.Value -cne (Get-NebulaPluginDocumentDigest -Value $Value -DigestProperty $DigestProperty)) {
        Throw-NebulaPluginError $Code
    }
    return [string]$property.Value
}

function Get-NebulaPluginVersionFromExe {
    param([Parameter(Mandatory)][string]$Path)
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
        Throw-NebulaPluginError 'NEBULA_PLUGIN_GAME_VERSION_EVIDENCE_MISSING'
    }
    $info = [Diagnostics.FileVersionInfo]::GetVersionInfo($Path)
    foreach ($value in @([string]$info.ProductVersion, [string]$info.FileVersion)) {
        if ($value -match '(?<!\d)(\d+\.\d+\.\d+\.\d+)(?!\d)') { return [string]$Matches[1] }
    }
    Throw-NebulaPluginError 'NEBULA_PLUGIN_GAME_VERSION_EVIDENCE_INVALID'
}

function Get-NebulaPluginAssemblyMvid {
    param([Parameter(Mandatory)][string]$Path)
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
        Throw-NebulaPluginError 'NEBULA_PLUGIN_GAME_MVID_EVIDENCE_MISSING'
    }
    try {
        $assembly = [Reflection.Assembly]::ReflectionOnlyLoadFrom($Path)
        return $assembly.ManifestModule.ModuleVersionId.ToString('D').ToLowerInvariant()
    }
    catch { Throw-NebulaPluginError 'NEBULA_PLUGIN_GAME_MVID_EVIDENCE_INVALID' }
}

function Read-NebulaPluginShadowEvidence {
    param(
        [Parameter(Mandatory)][string]$Path,
        [Parameter(Mandatory)][string]$GameRoot,
        [Parameter(Mandatory)][string]$TargetRole
    )
    $evidence = Read-NebulaPluginJson -Path $Path
    if ([string]$evidence.protocol -cne $script:NebulaPluginShadowEvidenceProtocol -or
        [int]$evidence.schemaVersion -ne 1 -or [string]$evidence.targetRole -cne $TargetRole -or
        [string]$evidence.gamePathIdentity -cne (Get-NebulaPluginPathIdentity -Path $GameRoot)) {
        Throw-NebulaPluginError 'NEBULA_PLUGIN_SHADOW_EVIDENCE_INVALID'
    }
    [void](Assert-NebulaPluginDocumentDigest -Value $evidence -DigestProperty 'evidenceDigest' `
        -Code 'NEBULA_PLUGIN_SHADOW_EVIDENCE_INVALID')
    return $evidence
}

function Get-NebulaPluginPreflightEvidence {
    param(
        [Parameter(Mandatory)][string]$GameRoot,
        [Parameter(Mandatory)][ValidateSet('Client','Server')][string]$TargetRole,
        [Parameter(Mandatory)][ValidateSet('Windows','Shadow')][string]$Backend,
        [string]$ShadowEvidencePath
    )
    if ($Backend -ceq 'Shadow') {
        if ([string]::IsNullOrWhiteSpace($ShadowEvidencePath)) {
            Throw-NebulaPluginError 'NEBULA_PLUGIN_SHADOW_EVIDENCE_MISSING'
        }
        $shadow = Read-NebulaPluginShadowEvidence -Path $ShadowEvidencePath -GameRoot $GameRoot -TargetRole $TargetRole
        $observed = [datetimeoffset]::MinValue
        $validUntil = [datetimeoffset]::MinValue
        if (-not [datetimeoffset]::TryParseExact([string]$shadow.observedUtc, 'o',
            [Globalization.CultureInfo]::InvariantCulture, [Globalization.DateTimeStyles]::RoundtripKind, [ref]$observed) -or
            -not [datetimeoffset]::TryParseExact([string]$shadow.validUntilUtc, 'o',
            [Globalization.CultureInfo]::InvariantCulture, [Globalization.DateTimeStyles]::RoundtripKind, [ref]$validUntil) -or
            $observed.Offset -ne [TimeSpan]::Zero -or $validUntil.Offset -ne [TimeSpan]::Zero -or
            $observed -gt [datetimeoffset]::UtcNow.AddMinutes(1) -or $validUntil -lt [datetimeoffset]::UtcNow) {
            Throw-NebulaPluginError 'NEBULA_PLUGIN_PREFLIGHT_EVIDENCE_STALE'
        }
        [int[]]$shadowProcessIds = @($shadow.matchingProcessIds | ForEach-Object { [int]$_ })
        $core = [ordered]@{
            targetRole = $TargetRole
            gamePathIdentity = [string]$shadow.gamePathIdentity
            observedUtc = [string]$shadow.observedUtc
            validUntilUtc = [string]$shadow.validUntilUtc
            gameVersion = [string]$shadow.gameVersion
            gameLibVersion = [string]$shadow.gameLibVersion
            assemblyCSharpMvid = [string]$shadow.assemblyCSharpMvid
            processEnumerationComplete = [bool]$shadow.processEnumerationComplete
            processesStopped = [bool]$shadow.processesStopped
            matchingProcessIds = $shadowProcessIds
        }
    }
    else {
        if (-not [string]::IsNullOrWhiteSpace($ShadowEvidencePath)) {
            Throw-NebulaPluginError 'NEBULA_PLUGIN_SHADOW_EVIDENCE_FORBIDDEN'
        }
        $now = [datetimeoffset]::UtcNow
        $matching = @()
        try {
            $processes = @(Get-CimInstance -ClassName Win32_Process -Filter "Name='DSPGAME.exe'" -ErrorAction Stop)
            foreach ($process in $processes) {
                $path = [string]$process.ExecutablePath
                if ([string]::IsNullOrWhiteSpace($path) -or
                    (Test-NebulaPrivatePathWithin -Candidate (Get-NebulaPrivateFullPath -Path $path) -Parent $GameRoot)) {
                    $matching += [int]$process.ProcessId
                }
            }
        }
        catch { Throw-NebulaPluginError 'NEBULA_PLUGIN_PROCESS_ENUMERATION_FAILED' }
        $core = [ordered]@{
            targetRole = $TargetRole
            gamePathIdentity = Get-NebulaPluginPathIdentity -Path $GameRoot
            observedUtc = $now.ToString('o')
            validUntilUtc = $now.AddMinutes(5).ToString('o')
            gameVersion = Get-NebulaPluginVersionFromExe -Path (Join-Path $GameRoot 'DSPGAME.exe')
            gameLibVersion = [string]$script:NebulaPrivateContract.game.gameLibVersion
            assemblyCSharpMvid = Get-NebulaPluginAssemblyMvid -Path (Join-Path $GameRoot 'DSPGAME_Data\Managed\Assembly-CSharp.dll')
            processEnumerationComplete = $true
            processesStopped = ($matching.Count -eq 0)
            matchingProcessIds = @($matching | Sort-Object -Unique)
        }
    }
    $digest = Get-NebulaPrivateObjectSha256 -Value $core
    $result = [ordered]@{}
    foreach ($key in $core.Keys) { $result[$key] = $core[$key] }
    $result.evidenceDigest = $digest
    return [pscustomobject]$result
}

function Assert-NebulaPluginPreflightCompatible {
    param([Parameter(Mandatory)]$Evidence)
    if ([string]$Evidence.gameVersion -cne [string]$script:NebulaPrivateContract.game.gameVersion -or
        [string]$Evidence.gameLibVersion -cne [string]$script:NebulaPrivateContract.game.gameLibVersion -or
        [string]$Evidence.assemblyCSharpMvid -cne [string]$script:NebulaPrivateContract.game.assemblyCSharpMvid) {
        Throw-NebulaPluginError 'NEBULA_PLUGIN_COMPATIBILITY_PREFLIGHT_FAILED'
    }
    if (-not [bool]$Evidence.processEnumerationComplete -or -not [bool]$Evidence.processesStopped -or
        @($Evidence.matchingProcessIds).Count -ne 0) {
        Throw-NebulaPluginError 'NEBULA_PLUGIN_PROCESS_STOP_PROOF_FAILED'
    }
    return $Evidence
}

function Assert-NebulaPluginTreeUnlocked {
    param([Parameter(Mandatory)][string]$Root)
    $rootFull = Get-NebulaPrivateFullPath -Path $Root
    if (-not (Test-Path -LiteralPath $rootFull -PathType Container)) {
        Throw-NebulaPluginError 'NEBULA_PLUGIN_TARGET_TREE_MISSING'
    }
    $queue = New-Object Collections.Generic.Queue[string]
    $queue.Enqueue($rootFull)
    while ($queue.Count -gt 0) {
        $directory = $queue.Dequeue()
        foreach ($item in @(Get-ChildItem -LiteralPath $directory -Force -ErrorAction Stop)) {
            if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
                Throw-NebulaPluginError 'NEBULA_PRIVATE_REPARSE_POINT_REJECTED'
            }
            if ($item.PSIsContainer) { $queue.Enqueue($item.FullName); continue }
            try {
                $stream = [IO.File]::Open($item.FullName, [IO.FileMode]::Open,
                    [IO.FileAccess]::Read, [IO.FileShare]::None)
                $stream.Dispose()
            }
            catch { Throw-NebulaPluginError 'NEBULA_PLUGIN_TARGET_TREE_LOCKED' }
        }
    }
}

function Copy-NebulaPluginCandidateToStage {
    param(
        [Parameter(Mandatory)][string]$CandidateRoot,
        [Parameter(Mandatory)][string]$StageRoot,
        [Parameter(Mandatory)][string]$TargetBindingDigest
    )
    if (Test-Path -LiteralPath $StageRoot) { Throw-NebulaPluginError 'NEBULA_PLUGIN_STAGE_ALREADY_EXISTS' }
    [IO.Directory]::CreateDirectory($StageRoot) | Out-Null
    try {
        foreach ($record in @(Get-NebulaPrivatePlainFiles -Root $CandidateRoot)) {
            $destination = Join-Path $StageRoot ([string]$record.path).Replace('/','\')
            $parent = [IO.Path]::GetDirectoryName($destination)
            [IO.Directory]::CreateDirectory($parent) | Out-Null
            Assert-NebulaPrivateNoReparseAncestors -Path $parent
            $input = [IO.File]::Open([string]$record.fullPath, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
            $output = [IO.FileStream]::new($destination, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write,
                [IO.FileShare]::None, 65536, [IO.FileOptions]::WriteThrough)
            try { $input.CopyTo($output); $output.Flush($true) }
            finally { $output.Dispose(); $input.Dispose() }
        }
        return Get-NebulaPluginTreeInventory -Root $StageRoot -TargetBindingDigest $TargetBindingDigest
    }
    catch { throw }
}

function Enter-NebulaPluginLock {
    param([Parameter(Mandatory)]$Layout)
    $parent = [IO.Path]::GetDirectoryName([string]$Layout.lockPath)
    [IO.Directory]::CreateDirectory($parent) | Out-Null
    Assert-NebulaPrivateNoReparseAncestors -Path $parent
    try {
        return [IO.File]::Open([string]$Layout.lockPath, [IO.FileMode]::OpenOrCreate,
            [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)
    }
    catch { Throw-NebulaPluginError 'NEBULA_PLUGIN_TRANSACTION_LOCKED' }
}

function Get-NebulaPluginReceiptCore {
    param([Parameter(Mandatory)]$Receipt)
    $core = [ordered]@{}
    foreach ($property in $Receipt.PSObject.Properties) {
        if ([string]$property.Name -cne 'receiptDigest') { $core[[string]$property.Name] = $property.Value }
    }
    return $core
}

function Assert-NebulaPluginReceipt {
    param([Parameter(Mandatory)]$Receipt)
    Assert-NebulaPrivateExactProperties -Value $Receipt -Names @(
        'protocol','schemaVersion','requestId','operation','status','targetRole','targetBindingDigest','physicalTargetDigest',
        'intentDigest','previousReceiptDigest','candidateManifestDigest','candidateTreeSha256',
        'preimageInventoryDigest','preimageTreeSha256','preimageAclDigest','candidateInventoryDigest',
        'candidateAclDigest','activeTreeSha256','bepInExBoundaryDigest','preimageDirectoryIdentityDigest',
        'candidateDirectoryIdentityDigest','quarantineRetained','candidateStageRetained','createdUtc','receiptDigest'
    ) -Code 'NEBULA_PLUGIN_RECEIPT_INVALID'
    if ([string]$Receipt.protocol -cne $script:NebulaPluginReceiptProtocol -or [int]$Receipt.schemaVersion -ne 3 -or
        -not (Test-NebulaPrivateUuid -Value ([string]$Receipt.requestId)) -or
        ([string]$Receipt.operation -cne 'apply' -and [string]$Receipt.operation -cne 'rollback') -or
        ([string]$Receipt.targetRole -cne 'Client' -and [string]$Receipt.targetRole -cne 'Server') -or
        -not (Test-NebulaPrivateSha256 -Value ([string]$Receipt.targetBindingDigest)) -or
        -not (Test-NebulaPrivateSha256 -Value ([string]$Receipt.physicalTargetDigest)) -or
        -not (Test-NebulaPrivateSha256 -Value ([string]$Receipt.intentDigest)) -or
        -not (Test-NebulaPrivateSha256 -Value ([string]$Receipt.previousReceiptDigest)) -or
        -not (Test-NebulaPrivateSha256 -Value ([string]$Receipt.candidateManifestDigest)) -or
        -not (Test-NebulaPrivateSha256 -Value ([string]$Receipt.candidateTreeSha256)) -or
        -not (Test-NebulaPrivateSha256 -Value ([string]$Receipt.preimageInventoryDigest)) -or
        -not (Test-NebulaPrivateSha256 -Value ([string]$Receipt.preimageTreeSha256)) -or
        -not (Test-NebulaPrivateSha256 -Value ([string]$Receipt.preimageAclDigest)) -or
        -not (Test-NebulaPrivateSha256 -Value ([string]$Receipt.candidateInventoryDigest)) -or
        -not (Test-NebulaPrivateSha256 -Value ([string]$Receipt.candidateAclDigest)) -or
        -not (Test-NebulaPrivateSha256 -Value ([string]$Receipt.activeTreeSha256)) -or
        -not (Test-NebulaPrivateSha256 -Value ([string]$Receipt.bepInExBoundaryDigest)) -or
        -not (Test-NebulaPrivateSha256 -Value ([string]$Receipt.preimageDirectoryIdentityDigest)) -or
        -not (Test-NebulaPrivateSha256 -Value ([string]$Receipt.candidateDirectoryIdentityDigest)) -or
        $Receipt.quarantineRetained -isnot [bool] -or $Receipt.candidateStageRetained -isnot [bool]) {
        Throw-NebulaPluginError 'NEBULA_PLUGIN_RECEIPT_INVALID'
    }
    [void](Assert-NebulaPluginDocumentDigest -Value $Receipt -DigestProperty 'receiptDigest' `
        -Code 'NEBULA_PLUGIN_RECEIPT_INVALID')
    if ([string]$Receipt.status -cnotin @('applied','rolled-back-automatic','rolled-back-recovery',
        'rolled-back-manual','rollback-failed-restored-candidate','rollback-recovery-restored-candidate')) {
        Throw-NebulaPluginError 'NEBULA_PLUGIN_RECEIPT_INVALID'
    }
    if (([string]$Receipt.operation -ceq 'apply' -and [string]$Receipt.status -cnotin @(
            'applied','rolled-back-automatic','rolled-back-recovery')) -or
        ([string]$Receipt.operation -ceq 'rollback' -and [string]$Receipt.status -cnotin @(
            'rolled-back-manual','rollback-failed-restored-candidate','rollback-recovery-restored-candidate'))) {
        Throw-NebulaPluginError 'NEBULA_PLUGIN_RECEIPT_INVALID'
    }
    $expectedQuarantine = [string]$Receipt.status -ceq 'applied' -or [string]$Receipt.status -like 'rollback-*-restored-candidate'
    $expectedStage = [string]$Receipt.status -cne 'applied' -and [string]$Receipt.status -notlike 'rollback-*-restored-candidate'
    if ([bool]$Receipt.quarantineRetained -ne $expectedQuarantine -or
        [bool]$Receipt.candidateStageRetained -ne $expectedStage) {
        Throw-NebulaPluginError 'NEBULA_PLUGIN_RECEIPT_INVALID'
    }
    $created = [datetimeoffset]::MinValue
    if (-not [datetimeoffset]::TryParseExact([string]$Receipt.createdUtc, 'o',
        [Globalization.CultureInfo]::InvariantCulture, [Globalization.DateTimeStyles]::RoundtripKind,
        [ref]$created) -or $created.Offset -ne [TimeSpan]::Zero) {
        Throw-NebulaPluginError 'NEBULA_PLUGIN_RECEIPT_INVALID'
    }
    return $Receipt
}

function Get-NebulaPluginReceiptChainHead {
    param(
        [Parameter(Mandatory)][string]$ReceiptsRoot,
        [Parameter(Mandatory)][string]$PhysicalTargetDigest
    )
    if (-not (Test-NebulaPrivateSha256 -Value $PhysicalTargetDigest)) {
        Throw-NebulaPluginError 'NEBULA_PLUGIN_PHYSICAL_TARGET_INVALID'
    }
    if (-not (Test-Path -LiteralPath $ReceiptsRoot -PathType Container)) { return $script:NebulaPluginZeroDigest }
    $map = @{}
    $referenced = @{}
    foreach ($file in @(Get-ChildItem -LiteralPath $ReceiptsRoot -Force -File -Filter '*.receipt.json')) {
        if (($file.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
            Throw-NebulaPluginError 'NEBULA_PRIVATE_REPARSE_POINT_REJECTED'
        }
        $receipt = Assert-NebulaPluginReceipt -Receipt (Read-NebulaPluginJson -Path $file.FullName)
        $expectedLeaf = [string]$receipt.requestId + '.receipt.json'
        if ([string]$file.Name -cne $expectedLeaf -or
            [string]$receipt.physicalTargetDigest -cne $PhysicalTargetDigest) {
            Throw-NebulaPluginError 'NEBULA_PLUGIN_RECEIPT_CHAIN_INVALID'
        }
        $digest = [string]$receipt.receiptDigest
        if ($map.ContainsKey($digest)) { Throw-NebulaPluginError 'NEBULA_PLUGIN_RECEIPT_CHAIN_INVALID' }
        $map[$digest] = $receipt
        $previous = [string]$receipt.previousReceiptDigest
        if ($previous -cne $script:NebulaPluginZeroDigest) {
            if ($referenced.ContainsKey($previous)) { Throw-NebulaPluginError 'NEBULA_PLUGIN_RECEIPT_CHAIN_INVALID' }
            $referenced[$previous] = $true
        }
    }
    if ($map.Count -eq 0) { return $script:NebulaPluginZeroDigest }
    foreach ($receipt in @($map.Values)) {
        $previous = [string]$receipt.previousReceiptDigest
        if ($previous -cne $script:NebulaPluginZeroDigest -and -not $map.ContainsKey($previous)) {
            Throw-NebulaPluginError 'NEBULA_PLUGIN_RECEIPT_CHAIN_INVALID'
        }
    }
    $heads = @($map.Keys | Where-Object { -not $referenced.ContainsKey([string]$_) })
    if ($heads.Count -ne 1) { Throw-NebulaPluginError 'NEBULA_PLUGIN_RECEIPT_CHAIN_INVALID' }
    $seen = @{}
    $cursor = [string]$heads[0]
    while ($cursor -cne $script:NebulaPluginZeroDigest) {
        if ($seen.ContainsKey($cursor) -or -not $map.ContainsKey($cursor)) {
            Throw-NebulaPluginError 'NEBULA_PLUGIN_RECEIPT_CHAIN_INVALID'
        }
        $seen[$cursor] = $true
        $cursor = [string]$map[$cursor].previousReceiptDigest
    }
    if ($seen.Count -ne $map.Count) { Throw-NebulaPluginError 'NEBULA_PLUGIN_RECEIPT_CHAIN_INVALID' }
    return [string]$heads[0]
}

function Assert-NebulaPluginReceiptMatchesIntent {
    param(
        [Parameter(Mandatory)]$Receipt,
        [Parameter(Mandatory)]$Intent,
        [string]$Code = 'NEBULA_PLUGIN_TERMINAL_BINDING_INVALID'
    )
    [void](Assert-NebulaPluginReceipt -Receipt $Receipt)
    if ([string]$Receipt.requestId -cne [string]$Intent.requestId -or
        [string]$Receipt.operation -cne [string]$Intent.operation -or
        [string]$Receipt.targetRole -cne [string]$Intent.targetRole -or
        [string]$Receipt.targetBindingDigest -cne [string]$Intent.targetBindingDigest -or
        [string]$Receipt.physicalTargetDigest -cne [string]$Intent.physicalTargetDigest -or
        [string]$Receipt.intentDigest -cne [string]$Intent.intentDigest -or
        [string]$Receipt.previousReceiptDigest -cne [string]$Intent.previousReceiptDigest -or
        [string]$Receipt.candidateManifestDigest -cne [string]$Intent.candidateManifestDigest -or
        [string]$Receipt.candidateTreeSha256 -cne [string]$Intent.candidateTreeSha256 -or
        [string]$Receipt.preimageInventoryDigest -cne [string]$Intent.preimageInventoryDigest -or
        [string]$Receipt.preimageTreeSha256 -cne [string]$Intent.preimageTreeSha256 -or
        [string]$Receipt.preimageAclDigest -cne [string]$Intent.preimageAclDigest -or
        [string]$Receipt.candidateInventoryDigest -cne [string]$Intent.stageInventory.inventoryDigest -or
        [string]$Receipt.candidateAclDigest -cne [string]$Intent.stageInventory.aclDigest -or
        [string]$Receipt.bepInExBoundaryDigest -cne [string]$Intent.bepInExBoundary.boundaryDigest -or
        [string]$Receipt.preimageDirectoryIdentityDigest -cne [string]$Intent.preimageDirectoryIdentity.identityDigest -or
        [string]$Receipt.candidateDirectoryIdentityDigest -cne [string]$Intent.candidateDirectoryIdentity.identityDigest) {
        Throw-NebulaPluginError $Code
    }
    return $Receipt
}

function Get-NebulaPluginRootTransactionState {
    param(
        [Parameter(Mandatory)]$Layout,
        [Parameter(Mandatory)][string]$PhysicalTargetDigest
    )
    $requestsRoot = Join-Path ([string]$Layout.stateRoot) 'requests'
    $receiptsRoot = Join-Path ([string]$Layout.stateRoot) 'receipts'
    $head = Get-NebulaPluginReceiptChainHead -ReceiptsRoot $receiptsRoot `
        -PhysicalTargetDigest $PhysicalTargetDigest
    $receiptByRequest = @{}
    if (Test-Path -LiteralPath $receiptsRoot -PathType Container) {
        foreach ($file in @(Get-ChildItem -LiteralPath $receiptsRoot -Force -File -Filter '*.receipt.json')) {
            $receipt = Assert-NebulaPluginReceipt -Receipt (Read-NebulaPluginJson -Path $file.FullName)
            if ([string]$receipt.physicalTargetDigest -cne $PhysicalTargetDigest -or
                [string]$file.Name -cne ([string]$receipt.requestId + '.receipt.json') -or
                $receiptByRequest.ContainsKey([string]$receipt.requestId)) {
                Throw-NebulaPluginError 'NEBULA_PLUGIN_RECEIPT_CHAIN_INVALID'
            }
            $receiptByRequest[[string]$receipt.requestId] = $receipt
        }
    }
    $intentByRequest = @{}
    $pending = New-Object Collections.Generic.List[string]
    if (Test-Path -LiteralPath $requestsRoot -PathType Container) {
        foreach ($file in @(Get-ChildItem -LiteralPath $requestsRoot -Force -File -Filter '*.intent.json')) {
            if (($file.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
                Throw-NebulaPluginError 'NEBULA_PRIVATE_REPARSE_POINT_REJECTED'
            }
            $intent = Read-NebulaPluginIntent -Path $file.FullName
            if ([string]$file.Name -cne ([string]$intent.requestId + '.intent.json') -or
                [string]$intent.physicalTargetDigest -cne $PhysicalTargetDigest -or
                $intentByRequest.ContainsKey([string]$intent.requestId)) {
                Throw-NebulaPluginError 'NEBULA_PLUGIN_ROOT_TRANSACTION_STATE_INVALID'
            }
            $intentByRequest[[string]$intent.requestId] = $intent
            if ($receiptByRequest.ContainsKey([string]$intent.requestId)) {
                [void](Assert-NebulaPluginReceiptMatchesIntent -Receipt $receiptByRequest[[string]$intent.requestId] `
                    -Intent $intent -Code 'NEBULA_PLUGIN_ROOT_TRANSACTION_STATE_INVALID')
            }
            else { $pending.Add([string]$intent.requestId) }
        }
    }
    foreach ($requestId in @($receiptByRequest.Keys)) {
        if (-not $intentByRequest.ContainsKey([string]$requestId)) {
            Throw-NebulaPluginError 'NEBULA_PLUGIN_ROOT_TRANSACTION_STATE_INVALID'
        }
    }
    return [pscustomobject][ordered]@{
        chainHead = $head
        pendingRequestIds = @($pending | Sort-Object -CaseSensitive)
        intents = $intentByRequest
        receipts = $receiptByRequest
    }
}

function Assert-NebulaPluginRootPendingIntentGate {
    param(
        [Parameter(Mandatory)]$Layout,
        [Parameter(Mandatory)][string]$PhysicalTargetDigest,
        [string]$AllowedPendingRequestId
    )
    $state = Get-NebulaPluginRootTransactionState -Layout $Layout -PhysicalTargetDigest $PhysicalTargetDigest
    $pending = @($state.pendingRequestIds)
    if ([string]::IsNullOrWhiteSpace($AllowedPendingRequestId)) {
        if ($pending.Count -ne 0) { Throw-NebulaPluginError 'NEBULA_PLUGIN_PENDING_RECOVERY_REQUIRED' }
    }
    elseif ($pending.Count -ne 1 -or [string]$pending[0] -cne $AllowedPendingRequestId) {
        Throw-NebulaPluginError 'NEBULA_PLUGIN_PENDING_RECOVERY_REQUIRED'
    }
    return $state
}

function Assert-NebulaPluginCurrentChainHead {
    param(
        [Parameter(Mandatory)]$Layout,
        [Parameter(Mandatory)][string]$PhysicalTargetDigest,
        [Parameter(Mandatory)][string]$ExpectedDigest
    )
    $actual = Get-NebulaPluginReceiptChainHead -ReceiptsRoot (Join-Path ([string]$Layout.stateRoot) 'receipts') `
        -PhysicalTargetDigest $PhysicalTargetDigest
    if ($actual -cne $ExpectedDigest) { Throw-NebulaPluginError 'NEBULA_PLUGIN_RECEIPT_CHAIN_CHANGED' }
    return $actual
}

function Assert-NebulaPluginCandidateForJob {
    param(
        [Parameter(Mandatory)][string]$JobRoot,
        [Parameter(Mandatory)][string]$CandidateManifestPath
    )
    $manifestPath = Assert-NebulaPrivateJobPath -Path $CandidateManifestPath -JobRoot $JobRoot
    $expected = Join-Path $JobRoot 'evidence\candidate-manifest.json'
    if (-not $manifestPath.Equals([IO.Path]::GetFullPath($expected), [StringComparison]::OrdinalIgnoreCase)) {
        Throw-NebulaPluginError 'NEBULA_PLUGIN_CANDIDATE_MANIFEST_PATH_INVALID'
    }
    $manifest = Read-NebulaPluginJson -Path $manifestPath
    $candidateRoot = Join-Path $JobRoot 'candidate'
    $result = Assert-NebulaPrivateCandidateManifest -Manifest $manifest -CandidateRoot $candidateRoot
    return [pscustomobject][ordered]@{ manifest=$manifest; result=$result; candidateRoot=$candidateRoot; manifestPath=$manifestPath }
}

function Assert-NebulaPluginMaintenanceWindow {
    param(
        [Parameter(Mandatory)][datetimeoffset]$StartUtc,
        [Parameter(Mandatory)][datetimeoffset]$EndUtc,
        [switch]$RequireCurrent
    )
    if ($StartUtc.Offset -ne [TimeSpan]::Zero -or $EndUtc.Offset -ne [TimeSpan]::Zero -or
        $EndUtc -le $StartUtc -or ($EndUtc - $StartUtc).TotalHours -gt 8) {
        Throw-NebulaPluginError 'NEBULA_PLUGIN_MAINTENANCE_WINDOW_INVALID'
    }
    if ($RequireCurrent -and ([datetimeoffset]::UtcNow -lt $StartUtc -or [datetimeoffset]::UtcNow -gt $EndUtc)) {
        Throw-NebulaPluginError 'NEBULA_PLUGIN_OUTSIDE_MAINTENANCE_WINDOW'
    }
}

function New-NebulaPluginBorrowedLeaseContext {
    param(
        [AllowNull()][string]$DataRoot,
        [AllowNull()][string]$InstanceId,
        [AllowNull()][string]$Token,
        [Parameter(Mandatory)][ValidateSet('mutation','recovery')][string]$ExpectedKind
    )
    if ([string]::IsNullOrWhiteSpace($DataRoot) -or [string]::IsNullOrWhiteSpace($InstanceId) -or
        [string]::IsNullOrWhiteSpace($Token)) {
        Throw-NebulaPluginError 'NEBULA_PLUGIN_HOST_MUTATION_LEASE_REQUIRED'
    }
    return [pscustomobject][ordered]@{
        dataRoot = $DataRoot
        instanceId = $InstanceId
        token = $Token
        expectedKind = $ExpectedKind
    }
}

function Assert-NebulaPluginBorrowedLeaseBoundary {
    param([Parameter(Mandatory)]$LeaseContext)
    $borrow = Assert-DysonHostMutationLeaseBorrow -DataRoot ([string]$LeaseContext.dataRoot) `
        -InstanceId ([string]$LeaseContext.instanceId) -Token ([string]$LeaseContext.token)
    if ([string]$borrow.state -cne 'active' -or
        [string]$borrow.leaseKind -cne [string]$LeaseContext.expectedKind) {
        Throw-NebulaPluginError 'NEBULA_PLUGIN_HOST_MUTATION_LEASE_KIND_INVALID'
    }
    return $borrow
}

function Assert-NebulaPluginBoundTree {
    param(
        [Parameter(Mandatory)][string]$Path,
        [Parameter(Mandatory)]$ExpectedInventory,
        [Parameter(Mandatory)]$ExpectedIdentity,
        [Parameter(Mandatory)][string]$TargetBindingDigest,
        [string]$MismatchCode = 'NEBULA_PLUGIN_BOUND_TREE_MISMATCH'
    )
    [void](Assert-NebulaPluginDirectoryIdentityMatches -Expected $ExpectedIdentity -Path $Path -Code $MismatchCode)
    return Assert-NebulaPluginInventoryMatches -Expected $ExpectedInventory -Root $Path `
        -TargetBindingDigest $TargetBindingDigest -MismatchCode $MismatchCode
}

function Test-NebulaPluginBoundTree {
    param(
        [Parameter(Mandatory)][string]$Path,
        [Parameter(Mandatory)]$ExpectedInventory,
        [Parameter(Mandatory)]$ExpectedIdentity,
        [Parameter(Mandatory)][string]$TargetBindingDigest
    )
    if (-not (Test-Path -LiteralPath $Path -PathType Container)) { return $false }
    try {
        [void](Assert-NebulaPluginBoundTree -Path $Path -ExpectedInventory $ExpectedInventory `
            -ExpectedIdentity $ExpectedIdentity -TargetBindingDigest $TargetBindingDigest)
        return $true
    }
    catch { return $false }
}

function Assert-NebulaPluginReceiptTerminalState {
    param(
        [Parameter(Mandatory)]$Receipt,
        [Parameter(Mandatory)]$Intent,
        [Parameter(Mandatory)]$PreimageInventory,
        [Parameter(Mandatory)][string]$ActiveRoot,
        [Parameter(Mandatory)][string]$CandidateStageRoot,
        [Parameter(Mandatory)][string]$PreimageQuarantineRoot,
        [Parameter(Mandatory)][string]$BepInExRoot,
        [string]$Code = 'NEBULA_PLUGIN_TERMINAL_STATE_INVALID'
    )
    [void](Assert-NebulaPluginReceiptMatchesIntent -Receipt $Receipt -Intent $Intent -Code $Code)
    [void](Assert-NebulaPluginParentBoundaryMatches -Expected $Intent.bepInExBoundary -Path $BepInExRoot)
    $binding = [string]$Intent.targetBindingDigest
    $candidateActive = [string]$Receipt.status -cin @(
        'applied','rollback-failed-restored-candidate','rollback-recovery-restored-candidate'
    )
    if ($candidateActive) {
        [void](Assert-NebulaPluginBoundTree -Path $ActiveRoot -ExpectedInventory $Intent.stageInventory `
            -ExpectedIdentity $Intent.candidateDirectoryIdentity -TargetBindingDigest $binding -MismatchCode $Code)
        [void](Assert-NebulaPluginBoundTree -Path $PreimageQuarantineRoot -ExpectedInventory $PreimageInventory `
            -ExpectedIdentity $Intent.preimageDirectoryIdentity -TargetBindingDigest $binding -MismatchCode $Code)
        if (Test-Path -LiteralPath $CandidateStageRoot) { Throw-NebulaPluginError $Code }
        if ([string]$Receipt.activeTreeSha256 -cne [string]$Intent.candidateTreeSha256) {
            Throw-NebulaPluginError $Code
        }
    }
    else {
        [void](Assert-NebulaPluginBoundTree -Path $ActiveRoot -ExpectedInventory $PreimageInventory `
            -ExpectedIdentity $Intent.preimageDirectoryIdentity -TargetBindingDigest $binding -MismatchCode $Code)
        [void](Assert-NebulaPluginBoundTree -Path $CandidateStageRoot -ExpectedInventory $Intent.stageInventory `
            -ExpectedIdentity $Intent.candidateDirectoryIdentity -TargetBindingDigest $binding -MismatchCode $Code)
        if (Test-Path -LiteralPath $PreimageQuarantineRoot) { Throw-NebulaPluginError $Code }
        if ([string]$Receipt.activeTreeSha256 -cne [string]$Intent.preimageTreeSha256) {
            Throw-NebulaPluginError $Code
        }
    }
    return $Receipt
}

function Read-NebulaPluginPlan {
    param(
        [Parameter(Mandatory)][string]$Path,
        [Parameter(Mandatory)][string]$JobRoot,
        [Parameter(Mandatory)][string]$RequestId,
        [Parameter(Mandatory)][string]$GameRoot,
        [Parameter(Mandatory)][string]$TargetRole,
        [Parameter(Mandatory)][string]$Backend
    )
    $planPath = Assert-NebulaPrivateJobPath -Path $Path -JobRoot $JobRoot
    $expectedPath = Join-Path $JobRoot 'evidence\plugin-cutover-plan.json'
    if (-not $planPath.Equals([IO.Path]::GetFullPath($expectedPath), [StringComparison]::OrdinalIgnoreCase)) {
        Throw-NebulaPluginError 'NEBULA_PLUGIN_PLAN_PATH_INVALID'
    }
    $plan = Read-NebulaPluginJson -Path $planPath
    Assert-NebulaPrivateExactProperties -Value $plan -Names @(
        'protocol','schemaVersion','requestId','defaultMode','executionEnabledByPlan','target','compatibility',
        'processStopProof','candidate','preimage','receiptChain','maintenanceWindow','transaction','recovery',
        'planDigest','confirmation'
    ) -Code 'NEBULA_PLUGIN_PLAN_INVALID'
    Assert-NebulaPrivateExactProperties -Value $plan.target -Names @(
        'targetRole','backend','gamePathIdentity','gameDirectoryIdentity','bepInExDirectoryIdentity',
        'physicalTargetDigest','targetBindingDigest','bepInExBoundary','gameDirectoryLeaf','pluginTreeLeaf'
    ) -Code 'NEBULA_PLUGIN_PLAN_INVALID'
    Assert-NebulaPrivateExactProperties -Value $plan.compatibility -Names @(
        'gameVersion','gameLibVersion','assemblyCSharpMvid'
    ) -Code 'NEBULA_PLUGIN_PLAN_INVALID'
    Assert-NebulaPrivateExactProperties -Value $plan.candidate -Names @(
        'manifestDigest','treeSha256','files','stockFilesExact','customFiles'
    ) -Code 'NEBULA_PLUGIN_PLAN_INVALID'
    Assert-NebulaPrivateExactProperties -Value $plan.preimage -Names @(
        'inventoryDigest','treeSha256','aclDigest','files','directoryIdentity'
    ) -Code 'NEBULA_PLUGIN_PLAN_INVALID'
    Assert-NebulaPrivateExactProperties -Value $plan.receiptChain -Names @('previousReceiptDigest') `
        -Code 'NEBULA_PLUGIN_PLAN_INVALID'
    Assert-NebulaPrivateExactProperties -Value $plan.maintenanceWindow -Names @(
        'startUtc','endUtc','requireCurrentTimeInsideWindowAtApply'
    ) -Code 'NEBULA_PLUGIN_PLAN_INVALID'
    Assert-NebulaPrivateExactProperties -Value $plan.processStopProof -Names @(
        'observedUtc','validUntilUtc','enumerationComplete','processesStopped','matchingProcessCount',
        'evidenceDigest','mandatoryLiveRecheckAtApply'
    ) -Code 'NEBULA_PLUGIN_PLAN_INVALID'
    Assert-NebulaPrivateExactProperties -Value $plan.transaction -Names @(
        'candidateSourcePathPersisted','targetAbsolutePathPersisted','sameVolumeStageAndQuarantineRequired',
        'exactInventoryHashAndAclRequired','stageVerifiedBeforeIntent',
        'stageRevalidatedAfterIntentImmediatelyBeforeRename','intentPersistedBeforeActiveTreeMutation',
        'processStopProofRequired','maintenanceWindowRequiredAtEveryMutationBoundary',
        'lockProbeRequiredImmediatelyBeforeSwap','rootWidePendingIntentGateRequired',
        'physicalReceiptChainRequired','operationOwnedDirectoryIdentityRequired',
        'protectedParentDeleteChildBoundaryRequired','borrowedHostMutationLeaseRequiredAtEveryBoundary',
        'quarantineRetainedAfterSuccess','deleteIsNeverAutomatic','orderedOperations'
    ) -Code 'NEBULA_PLUGIN_PLAN_INVALID'
    Assert-NebulaPrivateExactProperties -Value $plan.recovery -Names @(
        'defaultAction','failClosedOnAmbiguity','automaticDeletion','requiresCurrentReceiptChainHead',
        'requiresRecoveryLeaseAndFreshStopProof','states'
    ) -Code 'NEBULA_PLUGIN_PLAN_INVALID'
    $stateProperties = @('active','stage','quarantine','receipt','action')
    if (@($plan.recovery.states).Count -ne 5) {
        Throw-NebulaPluginError 'NEBULA_PLUGIN_PLAN_INVALID'
    }
    for ($stateIndex = 0; $stateIndex -lt 5; $stateIndex++) {
        Assert-NebulaPrivateExactProperties -Value @($plan.recovery.states)[$stateIndex] `
            -Names $stateProperties -Code 'NEBULA_PLUGIN_PLAN_INVALID'
    }
    Assert-NebulaPrivateExactProperties -Value $plan.confirmation -Names @('exactPhrase','granted') `
        -Code 'NEBULA_PLUGIN_PLAN_INVALID'
    if ([string]$plan.protocol -cne $script:NebulaPluginPlanProtocol -or [int]$plan.schemaVersion -ne 3 -or
        [string]$plan.requestId -cne $RequestId -or [string]$plan.target.targetRole -cne $TargetRole -or
        [string]$plan.target.backend -cne $Backend -or [string]$plan.defaultMode -cne 'dry-run' -or
        $plan.executionEnabledByPlan -isnot [bool] -or [bool]$plan.executionEnabledByPlan -or
        [string]$plan.target.gameDirectoryLeaf -cne 'Dyson Sphere Program' -or
        [string]$plan.target.pluginTreeLeaf -cne 'plugins' -or
        -not (Test-NebulaPrivateSha256 -Value ([string]$plan.target.physicalTargetDigest)) -or
        [int]$plan.candidate.files -ne 44 -or [int]$plan.candidate.stockFilesExact -ne 40 -or
        [int]$plan.candidate.customFiles -ne 4 -or
        -not (Test-NebulaPrivateSha256 -Value ([string]$plan.candidate.manifestDigest)) -or
        -not (Test-NebulaPrivateSha256 -Value ([string]$plan.candidate.treeSha256)) -or
        -not (Test-NebulaPrivateSha256 -Value ([string]$plan.preimage.inventoryDigest)) -or
        -not (Test-NebulaPrivateSha256 -Value ([string]$plan.preimage.treeSha256)) -or
        -not (Test-NebulaPrivateSha256 -Value ([string]$plan.preimage.aclDigest)) -or
        -not (Test-NebulaPrivateSha256 -Value ([string]$plan.receiptChain.previousReceiptDigest)) -or
        $plan.processStopProof.enumerationComplete -isnot [bool] -or
        $plan.processStopProof.processesStopped -isnot [bool] -or
        -not [bool]$plan.processStopProof.enumerationComplete -or -not [bool]$plan.processStopProof.processesStopped -or
        [int]$plan.processStopProof.matchingProcessCount -ne 0 -or
        -not (Test-NebulaPrivateSha256 -Value ([string]$plan.processStopProof.evidenceDigest)) -or
        $plan.processStopProof.mandatoryLiveRecheckAtApply -isnot [bool] -or
        -not [bool]$plan.processStopProof.mandatoryLiveRecheckAtApply -or
        $plan.maintenanceWindow.requireCurrentTimeInsideWindowAtApply -isnot [bool] -or
        -not [bool]$plan.maintenanceWindow.requireCurrentTimeInsideWindowAtApply) {
        Throw-NebulaPluginError 'NEBULA_PLUGIN_PLAN_INVALID'
    }
    [void](Assert-NebulaPluginDirectoryIdentityValue -Identity $plan.target.gameDirectoryIdentity `
        -Code 'NEBULA_PLUGIN_PLAN_INVALID')
    [void](Assert-NebulaPluginDirectoryIdentityValue -Identity $plan.target.bepInExDirectoryIdentity `
        -Code 'NEBULA_PLUGIN_PLAN_INVALID')
    [void](Assert-NebulaPluginDirectoryIdentityValue -Identity $plan.preimage.directoryIdentity `
        -Code 'NEBULA_PLUGIN_PLAN_INVALID')
    [void](Assert-NebulaPluginParentBoundarySafe -Boundary $plan.target.bepInExBoundary)
    $transactionFlags = @(
        'sameVolumeStageAndQuarantineRequired','exactInventoryHashAndAclRequired','stageVerifiedBeforeIntent',
        'stageRevalidatedAfterIntentImmediatelyBeforeRename','intentPersistedBeforeActiveTreeMutation',
        'processStopProofRequired','maintenanceWindowRequiredAtEveryMutationBoundary',
        'lockProbeRequiredImmediatelyBeforeSwap','rootWidePendingIntentGateRequired','physicalReceiptChainRequired',
        'operationOwnedDirectoryIdentityRequired','protectedParentDeleteChildBoundaryRequired',
        'borrowedHostMutationLeaseRequiredAtEveryBoundary','quarantineRetainedAfterSuccess','deleteIsNeverAutomatic'
    )
    if ($plan.transaction.candidateSourcePathPersisted -isnot [bool] -or
        [bool]$plan.transaction.candidateSourcePathPersisted -or
        $plan.transaction.targetAbsolutePathPersisted -isnot [bool] -or
        [bool]$plan.transaction.targetAbsolutePathPersisted) { Throw-NebulaPluginError 'NEBULA_PLUGIN_PLAN_INVALID' }
    foreach ($flag in $transactionFlags) {
        if ($plan.transaction.$flag -isnot [bool] -or -not [bool]$plan.transaction.$flag) {
            Throw-NebulaPluginError 'NEBULA_PLUGIN_PLAN_INVALID'
        }
    }
    $expectedOperations = @(
        'validate borrowed global host-mutation lease and physical root pending-intent gate',
        'live compatibility process-stop maintenance parent and preimage preflight',
        'copy exact qualified candidate into same-volume stage',
        'verify exact stage content ACL and operation-owned directory identity',
        'persist immutable intent with write-through semantics',
        'revalidate lease window stop proof parent active stage ACL content and identities',
        'atomically rename current tree to quarantine',
        'revalidate lease window stop proof parent and stage identity',
        'atomically rename candidate stage to active tree',
        'verify exact active quarantine inventories and operation-owned identities',
        'persist immutable receipt on the single physical-target chain'
    )
    if ((@($plan.transaction.orderedOperations) -join "`n") -cne ($expectedOperations -join "`n") -or
        [string]$plan.recovery.defaultAction -cne 'restore-preimage' -or
        $plan.recovery.failClosedOnAmbiguity -isnot [bool] -or -not [bool]$plan.recovery.failClosedOnAmbiguity -or
        $plan.recovery.automaticDeletion -isnot [bool] -or [bool]$plan.recovery.automaticDeletion -or
        $plan.recovery.requiresCurrentReceiptChainHead -isnot [bool] -or
        -not [bool]$plan.recovery.requiresCurrentReceiptChainHead -or
        $plan.recovery.requiresRecoveryLeaseAndFreshStopProof -isnot [bool] -or
        -not [bool]$plan.recovery.requiresRecoveryLeaseAndFreshStopProof) {
        Throw-NebulaPluginError 'NEBULA_PLUGIN_PLAN_INVALID'
    }
    $expectedRecoveryStates = @(
        [ordered]@{ active='preimage';stage='candidate';quarantine='absent';receipt='absent';action='record-rolled-back-with-stage-retained' },
        [ordered]@{ active='absent';stage='candidate';quarantine='preimage';receipt='absent';action='rename-quarantine-to-active' },
        [ordered]@{ active='candidate';stage='absent';quarantine='preimage';receipt='absent';action='rename-active-to-stage-then-quarantine-to-active' },
        [ordered]@{ active='candidate';stage='absent';quarantine='preimage';receipt='applied';action='verify-completed-only-when-current-head' },
        [ordered]@{ active='any-other';stage='any-other';quarantine='any-other';receipt='any';action='lock-and-require-manual-inspection' }
    )
    for ($stateIndex = 0; $stateIndex -lt $expectedRecoveryStates.Count; $stateIndex++) {
        if ((ConvertTo-NebulaPrivateCanonicalJson -Value @($plan.recovery.states)[$stateIndex]) -cne
            (ConvertTo-NebulaPrivateCanonicalJson -Value $expectedRecoveryStates[$stateIndex])) {
            Throw-NebulaPluginError 'NEBULA_PLUGIN_PLAN_INVALID'
        }
    }
    $binding = Get-NebulaPluginTargetBinding -GameRoot $GameRoot -TargetRole $TargetRole
    if ([string]$plan.target.gamePathIdentity -cne [string]$binding.value.gamePathIdentity -or
        [string]$plan.target.targetBindingDigest -cne [string]$binding.digest -or
        [string]$plan.target.physicalTargetDigest -cne [string]$binding.physicalTargetDigest -or
        [string]$plan.target.gameDirectoryIdentity.identityDigest -cne [string]$binding.gameDirectoryIdentity.identityDigest -or
        [string]$plan.target.bepInExDirectoryIdentity.identityDigest -cne [string]$binding.bepInExDirectoryIdentity.identityDigest -or
        [string]$plan.target.bepInExBoundary.directoryIdentity.identityDigest -cne
            [string]$binding.bepInExDirectoryIdentity.identityDigest) {
        Throw-NebulaPluginError 'NEBULA_PLUGIN_TARGET_BINDING_INVALID'
    }
    $windowStart = [datetimeoffset]::MinValue
    $windowEnd = [datetimeoffset]::MinValue
    if (-not [datetimeoffset]::TryParseExact([string]$plan.maintenanceWindow.startUtc, 'o',
        [Globalization.CultureInfo]::InvariantCulture, [Globalization.DateTimeStyles]::RoundtripKind,
        [ref]$windowStart) -or
        -not [datetimeoffset]::TryParseExact([string]$plan.maintenanceWindow.endUtc, 'o',
        [Globalization.CultureInfo]::InvariantCulture, [Globalization.DateTimeStyles]::RoundtripKind,
        [ref]$windowEnd)) { Throw-NebulaPluginError 'NEBULA_PLUGIN_PLAN_INVALID' }
    Assert-NebulaPluginMaintenanceWindow -StartUtc $windowStart -EndUtc $windowEnd
    $planCore = [ordered]@{}
    foreach ($property in $plan.PSObject.Properties) {
        if ([string]$property.Name -cne 'planDigest' -and [string]$property.Name -cne 'confirmation') {
            $planCore[[string]$property.Name] = $property.Value
        }
    }
    if (-not (Test-NebulaPrivateSha256 -Value ([string]$plan.planDigest)) -or
        [string]$plan.planDigest -cne (Get-NebulaPrivateObjectSha256 -Value $planCore)) {
        Throw-NebulaPluginError 'NEBULA_PLUGIN_PLAN_INVALID'
    }
    $phrase = 'CONFIRM NEBULA PLUGIN CUTOVER ' + $RequestId + ' ' + [string]$plan.planDigest
    if ([string]$plan.confirmation.exactPhrase -cne $phrase -or [bool]$plan.confirmation.granted) {
        Throw-NebulaPluginError 'NEBULA_PLUGIN_PLAN_INVALID'
    }
    return $plan
}

function Read-NebulaPluginIntent {
    param([Parameter(Mandatory)][string]$Path)
    $intent = Read-NebulaPluginJson -Path $Path
    $baseProperties = @(
        'protocol','schemaVersion','requestId','operation','targetRole','targetBindingDigest','physicalTargetDigest',
        'planDigest','candidateManifestDigest','candidateTreeSha256','preimageInventoryDigest','preimageTreeSha256',
        'preimageAclDigest','stageInventory','bepInExBoundary','preimageDirectoryIdentity',
        'candidateDirectoryIdentity','previousReceiptDigest','stageLeaf','quarantineLeaf',
        'candidateSourcePathPersisted','createdUtc','intentDigest'
    )
    if ([string]$intent.operation -ceq 'rollback') {
        $baseProperties = @($baseProperties + @('originalRequestId','originalReceiptDigest','previewDigest'))
    }
    Assert-NebulaPrivateExactProperties -Value $intent -Names $baseProperties -Code 'NEBULA_PLUGIN_INTENT_INVALID'
    if ([string]$intent.protocol -cne $script:NebulaPluginIntentProtocol -or [int]$intent.schemaVersion -ne 3 -or
        -not (Test-NebulaPrivateUuid -Value ([string]$intent.requestId)) -or
        ([string]$intent.operation -cne 'apply' -and [string]$intent.operation -cne 'rollback') -or
        ([string]$intent.targetRole -cne 'Client' -and [string]$intent.targetRole -cne 'Server') -or
        -not (Test-NebulaPrivateSha256 -Value ([string]$intent.targetBindingDigest)) -or
        -not (Test-NebulaPrivateSha256 -Value ([string]$intent.physicalTargetDigest)) -or
        -not (Test-NebulaPrivateSha256 -Value ([string]$intent.planDigest)) -or
        -not (Test-NebulaPrivateSha256 -Value ([string]$intent.candidateManifestDigest)) -or
        -not (Test-NebulaPrivateSha256 -Value ([string]$intent.candidateTreeSha256)) -or
        -not (Test-NebulaPrivateSha256 -Value ([string]$intent.preimageInventoryDigest)) -or
        -not (Test-NebulaPrivateSha256 -Value ([string]$intent.preimageTreeSha256)) -or
        -not (Test-NebulaPrivateSha256 -Value ([string]$intent.preimageAclDigest)) -or
        -not (Test-NebulaPrivateSha256 -Value ([string]$intent.previousReceiptDigest)) -or
        $intent.candidateSourcePathPersisted -isnot [bool] -or [bool]$intent.candidateSourcePathPersisted) {
        Throw-NebulaPluginError 'NEBULA_PLUGIN_INTENT_INVALID'
    }
    if ([string]$intent.operation -ceq 'rollback' -and
        (-not (Test-NebulaPrivateUuid -Value ([string]$intent.originalRequestId)) -or
         -not (Test-NebulaPrivateSha256 -Value ([string]$intent.originalReceiptDigest)) -or
         -not (Test-NebulaPrivateSha256 -Value ([string]$intent.previewDigest)))) {
        Throw-NebulaPluginError 'NEBULA_PLUGIN_INTENT_INVALID'
    }
    [void](Assert-NebulaPluginInventoryValue -Inventory $intent.stageInventory -Code 'NEBULA_PLUGIN_INTENT_INVALID')
    [void](Assert-NebulaPluginParentBoundarySafe -Boundary $intent.bepInExBoundary)
    [void](Assert-NebulaPluginDirectoryIdentityValue -Identity $intent.preimageDirectoryIdentity `
        -Code 'NEBULA_PLUGIN_INTENT_INVALID')
    [void](Assert-NebulaPluginDirectoryIdentityValue -Identity $intent.candidateDirectoryIdentity `
        -Code 'NEBULA_PLUGIN_INTENT_INVALID')
    $created = [datetimeoffset]::MinValue
    if (-not [datetimeoffset]::TryParseExact([string]$intent.createdUtc, 'o',
        [Globalization.CultureInfo]::InvariantCulture, [Globalization.DateTimeStyles]::RoundtripKind,
        [ref]$created) -or $created.Offset -ne [TimeSpan]::Zero -or
        [string]$intent.stageLeaf -cne ('.plugins.dyson-stage.' + [string]$intent.requestId) -or
        [string]$intent.quarantineLeaf -notmatch '^\.plugins\.dyson-quarantine\.[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$') {
        Throw-NebulaPluginError 'NEBULA_PLUGIN_INTENT_INVALID'
    }
    [void](Assert-NebulaPluginDocumentDigest -Value $intent -DigestProperty 'intentDigest' -Code 'NEBULA_PLUGIN_INTENT_INVALID')
    $serialized = ConvertTo-NebulaPrivateCanonicalJson -Value $intent
    if ($serialized -match '(?i)[A-Z]:\\|\\\\') { Throw-NebulaPluginError 'NEBULA_PLUGIN_INTENT_INVALID' }
    return $intent
}

function Assert-NebulaPluginApplyIntentContext {
    param(
        [Parameter(Mandatory)]$Intent,
        [Parameter(Mandatory)]$Plan,
        [Parameter(Mandatory)]$Preimage,
        [Parameter(Mandatory)]$Layout,
        [string]$Code = 'NEBULA_PLUGIN_TERMINAL_BINDING_INVALID'
    )
    [void](Assert-NebulaPluginInventoryValue -Inventory $Preimage -Code $Code)
    if ([string]$Intent.operation -cne 'apply' -or
        [string]$Intent.requestId -cne [string]$Plan.requestId -or
        [string]$Intent.targetRole -cne [string]$Plan.target.targetRole -or
        [string]$Intent.targetBindingDigest -cne [string]$Plan.target.targetBindingDigest -or
        [string]$Intent.physicalTargetDigest -cne [string]$Plan.target.physicalTargetDigest -or
        [string]$Intent.planDigest -cne [string]$Plan.planDigest -or
        [string]$Intent.candidateManifestDigest -cne [string]$Plan.candidate.manifestDigest -or
        [string]$Intent.candidateTreeSha256 -cne [string]$Plan.candidate.treeSha256 -or
        [string]$Intent.preimageInventoryDigest -cne [string]$Preimage.inventoryDigest -or
        [string]$Intent.preimageInventoryDigest -cne [string]$Plan.preimage.inventoryDigest -or
        [string]$Intent.preimageTreeSha256 -cne [string]$Preimage.contentTreeSha256 -or
        [string]$Intent.preimageTreeSha256 -cne [string]$Plan.preimage.treeSha256 -or
        [string]$Intent.preimageAclDigest -cne [string]$Preimage.aclDigest -or
        [string]$Intent.preimageAclDigest -cne [string]$Plan.preimage.aclDigest -or
        [string]$Intent.stageInventory.targetBindingDigest -cne [string]$Plan.target.targetBindingDigest -or
        [string]$Intent.stageInventory.contentTreeSha256 -cne [string]$Plan.candidate.treeSha256 -or
        [int]$Intent.stageInventory.fileCount -ne [int]$Plan.candidate.files -or
        [string]$Intent.bepInExBoundary.boundaryDigest -cne [string]$Plan.target.bepInExBoundary.boundaryDigest -or
        [string]$Intent.preimageDirectoryIdentity.identityDigest -cne
            [string]$Plan.preimage.directoryIdentity.identityDigest -or
        [string]$Intent.previousReceiptDigest -cne [string]$Plan.receiptChain.previousReceiptDigest -or
        [string]$Intent.stageLeaf -cne [IO.Path]::GetFileName([string]$Layout.stageRoot) -or
        [string]$Intent.quarantineLeaf -cne [IO.Path]::GetFileName([string]$Layout.quarantineRoot)) {
        Throw-NebulaPluginError $Code
    }
    return $Intent
}

function New-NebulaPluginReceiptValue {
    param(
        [Parameter(Mandatory)][string]$RequestId,
        [Parameter(Mandatory)][string]$Operation,
        [Parameter(Mandatory)][string]$Status,
        [Parameter(Mandatory)][string]$TargetRole,
        [Parameter(Mandatory)][string]$TargetBindingDigest,
        [Parameter(Mandatory)][string]$PhysicalTargetDigest,
        [Parameter(Mandatory)][string]$IntentDigest,
        [Parameter(Mandatory)][string]$PreviousReceiptDigest,
        [Parameter(Mandatory)][string]$CandidateManifestDigest,
        [Parameter(Mandatory)][string]$CandidateTreeSha256,
        [Parameter(Mandatory)][string]$PreimageInventoryDigest,
        [Parameter(Mandatory)][string]$PreimageTreeSha256,
        [Parameter(Mandatory)][string]$PreimageAclDigest,
        [Parameter(Mandatory)][string]$CandidateInventoryDigest,
        [Parameter(Mandatory)][string]$CandidateAclDigest,
        [Parameter(Mandatory)][string]$ActiveTreeSha256,
        [Parameter(Mandatory)][string]$BepInExBoundaryDigest,
        [Parameter(Mandatory)][string]$PreimageDirectoryIdentityDigest,
        [Parameter(Mandatory)][string]$CandidateDirectoryIdentityDigest
    )
    $core = [ordered]@{
        protocol = $script:NebulaPluginReceiptProtocol
        schemaVersion = 3
        requestId = $RequestId
        operation = $Operation
        status = $Status
        targetRole = $TargetRole
        targetBindingDigest = $TargetBindingDigest
        physicalTargetDigest = $PhysicalTargetDigest
        intentDigest = $IntentDigest
        previousReceiptDigest = $PreviousReceiptDigest
        candidateManifestDigest = $CandidateManifestDigest
        candidateTreeSha256 = $CandidateTreeSha256
        preimageInventoryDigest = $PreimageInventoryDigest
        preimageTreeSha256 = $PreimageTreeSha256
        preimageAclDigest = $PreimageAclDigest
        candidateInventoryDigest = $CandidateInventoryDigest
        candidateAclDigest = $CandidateAclDigest
        activeTreeSha256 = $ActiveTreeSha256
        bepInExBoundaryDigest = $BepInExBoundaryDigest
        preimageDirectoryIdentityDigest = $PreimageDirectoryIdentityDigest
        candidateDirectoryIdentityDigest = $CandidateDirectoryIdentityDigest
        quarantineRetained = ($Status -ceq 'applied' -or $Status -like 'rollback-*-restored-candidate')
        candidateStageRetained = ($Status -cne 'applied' -and $Status -notlike 'rollback-*-restored-candidate')
        createdUtc = [datetimeoffset]::UtcNow.ToString('o')
    }
    $value = [ordered]@{}
    foreach ($key in $core.Keys) { $value[$key] = $core[$key] }
    $value.receiptDigest = Get-NebulaPrivateObjectSha256 -Value $core
    return [pscustomobject]$value
}

function Test-NebulaPluginFault {
    param(
        [AllowNull()][string]$Configured,
        [Parameter(Mandatory)][string]$Point,
        [Parameter(Mandatory)][string]$Backend,
        [switch]$Crash
    )
    if ([string]::IsNullOrWhiteSpace($Configured) -or $Configured -cne $Point) { return }
    if ($Backend -cne 'Shadow') { Throw-NebulaPluginError 'NEBULA_PLUGIN_TEST_HOOK_FORBIDDEN' }
    if ($Crash) { Throw-NebulaPluginError 'NEBULA_PLUGIN_SIMULATED_CRASH' }
    Throw-NebulaPluginError 'NEBULA_PLUGIN_SIMULATED_FAILURE'
}

function Move-NebulaPluginDirectory {
    param([Parameter(Mandatory)][string]$Source, [Parameter(Mandatory)][string]$Destination)
    if (-not (Test-Path -LiteralPath $Source -PathType Container) -or (Test-Path -LiteralPath $Destination)) {
        Throw-NebulaPluginError 'NEBULA_PLUGIN_ATOMIC_MOVE_PRECONDITION_FAILED'
    }
    if (-not [IO.Path]::GetPathRoot($Source).Equals([IO.Path]::GetPathRoot($Destination), [StringComparison]::OrdinalIgnoreCase)) {
        Throw-NebulaPluginError 'NEBULA_PLUGIN_CROSS_VOLUME_MOVE_REJECTED'
    }
    [IO.Directory]::Move($Source, $Destination)
}
