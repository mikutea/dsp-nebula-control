[CmdletBinding(SupportsShouldProcess, ConfirmImpact = 'Medium')]
param(
    [Parameter(Mandatory)][string]$BootstrapRoot,
    [Parameter(Mandatory)][string]$GameServiceSid,
    [ValidatePattern('^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$')]
    [string]$RestoreSnapshotId,
    [ValidatePattern('^[0-9a-f]{64}$')][string]$ExpectedSnapshotSha256
)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
Set-StrictMode -Version 2.0
$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
if (-not ([Security.Principal.WindowsPrincipal]::new($identity)).IsInRole(
        [Security.Principal.WindowsBuiltInRole]::Administrator)) { throw 'GAME_ACCESS_REQUIRES_ADMINISTRATOR' }
$gameSid = [Security.Principal.SecurityIdentifier]::new($GameServiceSid)
if ($gameSid.Value -in @('S-1-5-18', 'S-1-5-19', 'S-1-5-32-544')) { throw 'GAME_ACCESS_REQUIRES_SEPARATE_GAME_USER' }
if (@(Get-Process DSPGAME -ErrorAction SilentlyContinue).Count -ne 0) { throw 'GAME_ACCESS_REQUIRES_STOPPED_GAME' }
. (Join-Path $PSScriptRoot 'DysonDeployment.Common.ps1')
. (Join-Path $BootstrapRoot 'DysonGameLifecycleBootstrap.Common.ps1')
$context = Get-DysonGameBootstrapContext -BootstrapRoot $BootstrapRoot
$stateRoot = [string]$context.stateRoot
$snapshotRoot = Join-Path $context.dataRoot 'game-access-snapshots'
if ($ExpectedSnapshotSha256 -and -not $RestoreSnapshotId) { throw 'GAME_ACCESS_RESTORE_ID_REQUIRED' }

function Get-AccessSnapshotHash([string]$Path) {
    $stream = [IO.File]::OpenRead($Path)
    $sha = [Security.Cryptography.SHA256]::Create()
    try { return ([BitConverter]::ToString($sha.ComputeHash($stream))).Replace('-', '').ToLowerInvariant() }
    finally { $sha.Dispose(); $stream.Dispose() }
}

function Get-AccessInventory {
    $items = @((Get-Item -LiteralPath $stateRoot -Force)) + @(Get-ChildItem -LiteralPath $stateRoot -Recurse -Force)
    if ($items.Count -gt 4096) { throw 'GAME_ACCESS_INVENTORY_LIMIT' }
    return @(foreach ($item in $items) {
        if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'GAME_ACCESS_REDIRECTED_STATE' }
        $relative = $item.FullName.Substring($stateRoot.Length).TrimStart('\')
        [ordered]@{ path=$relative; directory=[bool]$item.PSIsContainer; sddl=(Get-Acl -LiteralPath $item.FullName).Sddl }
    })
}

function Get-GameAccessAcl {
    $result = Get-Acl -LiteralPath $stateRoot
    $inheritance = [Security.AccessControl.InheritanceFlags]'ContainerInherit, ObjectInherit'
    $allowAccess = [Security.AccessControl.AccessControlType]::Allow
    $result.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($gameSid, [Security.AccessControl.FileSystemRights]::ReadAndExecute, $inheritance, [Security.AccessControl.PropagationFlags]::None, $allowAccess))
    $result.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($gameSid, [Security.AccessControl.FileSystemRights]'CreateFiles, CreateDirectories', [Security.AccessControl.InheritanceFlags]::None, [Security.AccessControl.PropagationFlags]::None, $allowAccess))
    $result.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new([Security.Principal.SecurityIdentifier]::new('S-1-3-0'), [Security.AccessControl.FileSystemRights]::Modify, $inheritance, [Security.AccessControl.PropagationFlags]::InheritOnly, $allowAccess))
    return $result
}

function Restore-AccessInventory($Entries) {
    # Validate every target before the first write so an unavailable later object
    # cannot leave an otherwise valid snapshot partially restored.
    $restorePlan = @(foreach ($entry in $Entries) {
        $target = if ([string]$entry.path -eq '') { $stateRoot } else { Join-Path $stateRoot ([string]$entry.path) }
        $target = [IO.Path]::GetFullPath($target)
        if ($target -ine $stateRoot -and -not $target.StartsWith($stateRoot + '\', [StringComparison]::OrdinalIgnoreCase)) {
            throw 'GAME_ACCESS_RESTORE_PATH_INVALID'
        }
        $item = Get-Item -LiteralPath $target -Force
        if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -or [bool]$item.PSIsContainer -ne [bool]$entry.directory) {
            throw 'GAME_ACCESS_RESTORE_TARGET_CHANGED'
        }
        $descriptor = [Security.AccessControl.RawSecurityDescriptor]::new([string]$entry.sddl)
        if ($null -eq $descriptor.DiscretionaryAcl) { throw 'GAME_ACCESS_RESTORE_DACL_MISSING' }
        [pscustomobject]@{ target=$target; entry=$entry; descriptor=$descriptor }
    })
    # Restoring a directory with the ordinary ACL API would propagate inheritance
    # again. Restore captured descriptors individually, without changing owners.
    if (-not ('DysonControl.GameAccessDacl' -as [type])) {
        Add-Type -TypeDefinition @'
using System.Runtime.InteropServices;
namespace DysonControl {
    public static class GameAccessDacl {
        [DllImport("advapi32.dll", CharSet=CharSet.Unicode, ExactSpelling=true, SetLastError=true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        public static extern bool SetFileSecurityW(string path, uint information, byte[] descriptor);
    }
}
'@
    }
    foreach ($planned in $restorePlan) {
        $entry = $planned.entry
        $target = $planned.target
        $descriptor = $planned.descriptor
        if ($descriptor.ControlFlags -band [Security.AccessControl.ControlFlags]::DiscretionaryAclAutoInherited) {
            $descriptor.SetFlags($descriptor.ControlFlags -bor [Security.AccessControl.ControlFlags]::DiscretionaryAclAutoInheritRequired)
        }
        $bytes = [byte[]]::new($descriptor.BinaryLength)
        $descriptor.GetBinaryForm($bytes, 0)
        if (-not [DysonControl.GameAccessDacl]::SetFileSecurityW($target, 4, $bytes)) { throw 'GAME_ACCESS_RESTORE_FAILED' }
        if ((Get-Acl -LiteralPath $target).Sddl -cne [string]$entry.sddl) { throw 'GAME_ACCESS_RESTORE_MISMATCH' }
    }
}

$before = @(Get-AccessInventory)
if ($RestoreSnapshotId) {
    if (-not $ExpectedSnapshotSha256) { throw 'GAME_ACCESS_RESTORE_HASH_REQUIRED' }
    $snapshotPath = Join-Path $snapshotRoot ($RestoreSnapshotId + '.json')
    [void](Assert-DysonDeploymentPlainPathChain -Path $snapshotRoot)
    $snapshotItem = Get-Item -LiteralPath $snapshotPath -Force
    if ($snapshotItem.PSIsContainer -or ($snapshotItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -or
        $snapshotItem.Length -gt 4MB -or
        (Get-AccessSnapshotHash $snapshotPath) -cne $ExpectedSnapshotSha256) { throw 'GAME_ACCESS_SNAPSHOT_INVALID' }
    $snapshot = [IO.File]::ReadAllText($snapshotPath, [Text.Encoding]::UTF8) | ConvertFrom-Json
    if ($snapshot.protocol -cne 'DYSON_GAME_ACCESS_SNAPSHOT_V1' -or $snapshot.id -cne $RestoreSnapshotId -or
        $snapshot.dataRootIdentity -cne $context.dataRootIdentity -or $snapshot.gameSid -cne $gameSid.Value -or
        (@($before.path | Sort-Object) -join '|') -cne (@($snapshot.entries.path | Sort-Object) -join '|')) { throw 'GAME_ACCESS_STATE_CHANGED' }
    if ($PSCmdlet.ShouldProcess('game bootstrap state', 'restore captured game-access permissions')) {
        try { Restore-AccessInventory $snapshot.entries }
        catch {
            $restoreError = $_
            try { Restore-AccessInventory $before }
            catch { throw 'GAME_ACCESS_RESTORE_COMPENSATION_FAILED' }
            throw $restoreError
        }
        $restoreState = 'restored'
    }
    else { $restoreState = 'preview' }
    [ordered]@{ protocol='DYSON_GAME_ACCESS_V1'; state=$restoreState; snapshotId=$RestoreSnapshotId; gameStarted=$false } | ConvertTo-Json -Compress
    return
}

$acl = Get-GameAccessAcl
$inherit = [Security.AccessControl.InheritanceFlags]'ContainerInherit, ObjectInherit'
$allow = [Security.AccessControl.AccessControlType]::Allow
if ($acl.GetSecurityDescriptorSddlForm([Security.AccessControl.AccessControlSections]'Owner, Group, Access') -ceq [string]$before[0].sddl) {
    [ordered]@{ protocol='DYSON_GAME_ACCESS_V1'; state='already-configured'; objects=$before.Count; gameStarted=$false } | ConvertTo-Json -Compress
    return
}
if (-not $PSCmdlet.ShouldProcess('game bootstrap state', 'grant game-account read and own-state creation access')) {
    [ordered]@{ protocol='DYSON_GAME_ACCESS_V1'; state='preview'; objects=$before.Count; activePointerWriteGrant=$false; gameStarted=$false } | ConvertTo-Json -Compress
    return
}
[void][IO.Directory]::CreateDirectory($snapshotRoot)
[void](Assert-DysonDeploymentPlainPathChain -Path $snapshotRoot)
$snapshotAcl = [Security.AccessControl.DirectorySecurity]::new()
$snapshotAcl.SetAccessRuleProtection($true, $false)
$snapshotAcl.SetOwner([Security.Principal.SecurityIdentifier]::new('S-1-5-32-544'))
foreach ($sid in @('S-1-5-18', 'S-1-5-32-544')) {
    $snapshotAcl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new([Security.Principal.SecurityIdentifier]::new($sid), [Security.AccessControl.FileSystemRights]::FullControl, $inherit, [Security.AccessControl.PropagationFlags]::None, $allow))
}
[IO.Directory]::SetAccessControl($snapshotRoot, $snapshotAcl)
$snapshotId = [guid]::NewGuid().ToString('D')
$snapshotPath = Join-Path $snapshotRoot ($snapshotId + '.json')
$snapshot = [ordered]@{ protocol='DYSON_GAME_ACCESS_SNAPSHOT_V1'; id=$snapshotId; createdAt=[datetime]::UtcNow.ToString('o'); installerSid=$identity.User.Value; dataRootIdentity=$context.dataRootIdentity; gameSid=$gameSid.Value; entries=$before }
$snapshotBytes = [Text.UTF8Encoding]::new($false).GetBytes(($snapshot | ConvertTo-Json -Depth 6 -Compress))
$snapshotStream = [IO.FileStream]::new($snapshotPath, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
try { $snapshotStream.Write($snapshotBytes, 0, $snapshotBytes.Length); $snapshotStream.Flush($true) }
finally { $snapshotStream.Dispose() }
try {
    [IO.Directory]::SetAccessControl($stateRoot, $acl)
    if ((Get-Acl -LiteralPath $stateRoot).Sddl -cne $acl.GetSecurityDescriptorSddlForm(
            [Security.AccessControl.AccessControlSections]'Owner, Group, Access')) { throw 'GAME_ACCESS_APPLY_MISMATCH' }
    $after = @(Get-AccessInventory)
    if (($before.path -join '|') -cne ($after.path -join '|')) { throw 'GAME_ACCESS_STATE_CHANGED' }
}
catch {
    $applyError = $_
    try { Restore-AccessInventory $before }
    catch { throw 'GAME_ACCESS_APPLY_COMPENSATION_FAILED' }
    throw $applyError
}
[ordered]@{ protocol='DYSON_GAME_ACCESS_V1'; state='applied'; snapshotId=$snapshotId; snapshotSha256=(Get-AccessSnapshotHash $snapshotPath); objects=$before.Count; gameStarted=$false } | ConvertTo-Json -Compress
