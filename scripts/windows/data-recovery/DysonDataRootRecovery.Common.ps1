Set-StrictMode -Version 2.0

$script:DysonDataRootRecoveryBundleProtocol = 'DYSON_CONTROL_DATA_ROOT_RECOVERY_BUNDLE_V1'
$script:DysonDataRootRecoveryReceiptProtocol = 'DYSON_CONTROL_DATA_ROOT_RECOVERY_RECEIPT_V1'
$script:DysonDataRootRecoveryAuditProtocol = 'DYSON_CONTROL_DATA_ROOT_RECOVERY_AUDIT_V1'
$script:DysonDataRootRecoveryShadowTaskProtocol = 'DYSON_CONTROL_DATA_ROOT_RECOVERY_SHADOW_TASK_V1'
$script:DysonDataRootRecoverySchemaVersion = 1
$script:DysonDataRootRecoveryMaximumManifestBytes = 16777216
$script:DysonDataRootRecoveryMaximumRecordBytes = 262144
$script:DysonDataRootRecoveryMaximumEntryCount = 100000
$script:DysonDataRootRecoveryMaximumTotalBytes = 1099511627776
$script:DysonDataRootRecoveryDirectoryDigest = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'
$script:DysonDataRootRecoveryAllowedTopLevel = @(
    '.dyson-control-deployment-locks',
    'acceptance',
    'audit',
    'authority-inventory',
    'config',
    'configuration-snapshots',
    'configuration-transactions',
    'data',
    'game-access-snapshots',
    'logs',
    'migration',
    'private',
    'runtime-task-transactions',
    'snapshots',
    'state'
)
$script:DysonDataRootRecoveryErrorCodes = @(
    'DYSON_CONTROL_DATA_RECOVERY_INPUT_INVALID',
    'DYSON_CONTROL_DATA_RECOVERY_PATH_INVALID',
    'DYSON_CONTROL_DATA_RECOVERY_STORAGE_INVALID',
    'DYSON_CONTROL_DATA_RECOVERY_TASK_NOT_QUIESCED',
    'DYSON_CONTROL_DATA_RECOVERY_PENDING_MUTATION',
    'DYSON_CONTROL_DATA_RECOVERY_SQLITE_NOT_CHECKPOINTED',
    'DYSON_CONTROL_DATA_RECOVERY_SAVE_PAIR_INVALID',
    'DYSON_CONTROL_DATA_RECOVERY_TREE_INVALID',
    'DYSON_CONTROL_DATA_RECOVERY_SOURCE_CHANGED',
    'DYSON_CONTROL_DATA_RECOVERY_BUNDLE_INVALID',
    'DYSON_CONTROL_DATA_RECOVERY_BUNDLE_CONFLICT',
    'DYSON_CONTROL_DATA_RECOVERY_CONFIRMATION_REQUIRED',
    'DYSON_CONTROL_DATA_RECOVERY_RECOVERY_REQUIRED',
    'DYSON_CONTROL_DATA_RECOVERY_RESTORE_FAILED',
    'DYSON_CONTROL_DATA_RECOVERY_ROLLBACK_FAILED',
    'DYSON_CONTROL_DATA_RECOVERY_ACCESS_CONTROL_FAILED',
    'DYSON_CONTROL_DATA_RECOVERY_SHADOW_FORBIDDEN',
    'DYSON_CONTROL_DATA_RECOVERY_INTERNAL_ERROR'
)

$script:DysonDataRootRecoveryCommonRoot = Split-Path -Parent $PSScriptRoot
$script:DysonDataRootRecoveryLeaseCommon = Join-Path $script:DysonDataRootRecoveryCommonRoot 'DysonHostMutationLease.Common.ps1'
if (-not (Test-Path -LiteralPath $script:DysonDataRootRecoveryLeaseCommon -PathType Leaf)) {
    throw 'DYSON_CONTROL_DATA_RECOVERY_INTERNAL_ERROR'
}
. $script:DysonDataRootRecoveryLeaseCommon

function New-DysonDataRootRecoveryException {
    param([Parameter(Mandatory)][string]$Code)

    if ($Code -cnotin $script:DysonDataRootRecoveryErrorCodes) {
        $Code = 'DYSON_CONTROL_DATA_RECOVERY_INTERNAL_ERROR'
    }
    $exception = [System.InvalidOperationException]::new($Code)
    $exception.Data['Code'] = $Code
    return $exception
}

function Throw-DysonDataRootRecoveryError {
    param([Parameter(Mandatory)][string]$Code)
    throw (New-DysonDataRootRecoveryException -Code $Code)
}

# A Windows PowerShell child launched through npm/cmd can inherit PowerShell 7's
# PSModulePath. Bind the security cmdlets to this engine's trusted in-box module
# instead of allowing module auto-loading to select an incompatible higher version.
$script:DysonDataRootRecoverySecurityModulePath = Join-Path $PSHOME `
    'Modules\Microsoft.PowerShell.Security\Microsoft.PowerShell.Security.psd1'
try {
    if (-not [System.IO.File]::Exists($script:DysonDataRootRecoverySecurityModulePath)) {
        Throw-DysonDataRootRecoveryError 'DYSON_CONTROL_DATA_RECOVERY_ACCESS_CONTROL_FAILED'
    }
    $securityModules = @(Import-Module -Name $script:DysonDataRootRecoverySecurityModulePath -PassThru -ErrorAction Stop)
    $expectedSecurityModulePath = [System.IO.Path]::GetFullPath($script:DysonDataRootRecoverySecurityModulePath)
    $matchingSecurityModules = @($securityModules | Where-Object {
        [System.IO.Path]::GetFullPath([string]$_.Path).Equals(
            $expectedSecurityModulePath,
            [System.StringComparison]::OrdinalIgnoreCase
        )
    })
    if ($matchingSecurityModules.Count -ne 1) {
        Throw-DysonDataRootRecoveryError 'DYSON_CONTROL_DATA_RECOVERY_ACCESS_CONTROL_FAILED'
    }
}
catch {
    if ($_.Exception.Data.Contains('Code')) { throw }
    Throw-DysonDataRootRecoveryError 'DYSON_CONTROL_DATA_RECOVERY_ACCESS_CONTROL_FAILED'
}

function Throw-DysonDataRootRecoveryTerminalReconciliationRequired {
    param([string]$FaultPoint)

    $exception = New-DysonDataRootRecoveryException -Code 'DYSON_CONTROL_DATA_RECOVERY_RECOVERY_REQUIRED'
    $exception.Data['TerminalCommitted'] = $true
    if (-not [string]::IsNullOrWhiteSpace($FaultPoint)) {
        $exception.Data['FaultPoint'] = $FaultPoint
    }
    throw $exception
}

function Get-DysonDataRootRecoveryErrorCode {
    param([Parameter(Mandatory)][System.Exception]$Exception)

    $candidate = $Exception
    while ($null -ne $candidate) {
        if ($candidate.Data.Contains('Code')) {
            $code = [string]$candidate.Data['Code']
            if ($code -cin $script:DysonDataRootRecoveryErrorCodes) { return $code }
            if ($code -like 'DYSON_HOST_MUTATION_LEASE_*') {
                if ($code -in @('DYSON_HOST_MUTATION_LEASE_BUSY', 'DYSON_HOST_MUTATION_LEASE_RECOVERY_REQUIRED')) {
                    return 'DYSON_CONTROL_DATA_RECOVERY_PENDING_MUTATION'
                }
                return 'DYSON_CONTROL_DATA_RECOVERY_STORAGE_INVALID'
            }
        }
        if ([string]$candidate.Message -cin $script:DysonDataRootRecoveryErrorCodes) {
            return [string]$candidate.Message
        }
        $candidate = $candidate.InnerException
    }
    return 'DYSON_CONTROL_DATA_RECOVERY_INTERNAL_ERROR'
}

function ConvertTo-DysonDataRootRecoveryJson {
    param([Parameter(Mandatory)]$Value, [ValidateRange(2, 32)][int]$Depth = 16)
    return ($Value | ConvertTo-Json -Depth $Depth -Compress)
}

function Get-DysonDataRootRecoveryTextSha256 {
    param([Parameter(Mandatory)][AllowEmptyString()][string]$Value)

    $sha = [System.Security.Cryptography.SHA256]::Create()
    try {
        $bytes = [System.Text.UTF8Encoding]::new($false).GetBytes($Value)
        return ([System.BitConverter]::ToString($sha.ComputeHash($bytes))).Replace('-', '').ToLowerInvariant()
    }
    finally { $sha.Dispose() }
}

function Get-DysonDataRootRecoveryFileSha256 {
    param([Parameter(Mandatory)][string]$Path)

    $stream = $null
    $sha = $null
    try {
        $item = Assert-DysonDataRootRecoveryPlainFile -Path $Path -MaximumBytes ([int64]::MaxValue) -AllowEmpty
        $stream = [System.IO.FileStream]::new(
            (ConvertTo-DysonDataRootRecoveryExtendedPath $item.FullName),
            [System.IO.FileMode]::Open,
            [System.IO.FileAccess]::Read,
            [System.IO.FileShare]::Read
        )
        $sha = [System.Security.Cryptography.SHA256]::Create()
        return ([System.BitConverter]::ToString($sha.ComputeHash($stream))).Replace('-', '').ToLowerInvariant()
    }
    catch {
        if ($_.Exception.Data.Contains('Code')) { throw }
        Throw-DysonDataRootRecoveryError 'DYSON_CONTROL_DATA_RECOVERY_STORAGE_INVALID'
    }
    finally {
        if ($null -ne $sha) { $sha.Dispose() }
        if ($null -ne $stream) { $stream.Dispose() }
    }
}

function Get-DysonDataRootRecoveryFullPath {
    param([Parameter(Mandatory)][string]$Path)

    try {
        if ([string]::IsNullOrWhiteSpace($Path) -or -not [System.IO.Path]::IsPathRooted($Path)) {
            Throw-DysonDataRootRecoveryError 'DYSON_CONTROL_DATA_RECOVERY_PATH_INVALID'
        }
        $full = [System.IO.Path]::GetFullPath($Path)
        $root = [System.IO.Path]::GetPathRoot($full)
        if ([string]::IsNullOrWhiteSpace($root) -or
            [string]::Equals($full.TrimEnd('\', '/'), $root.TrimEnd('\', '/'), [System.StringComparison]::OrdinalIgnoreCase)) {
            Throw-DysonDataRootRecoveryError 'DYSON_CONTROL_DATA_RECOVERY_PATH_INVALID'
        }
        return $full.TrimEnd('\', '/')
    }
    catch {
        if ($_.Exception.Data.Contains('Code')) { throw }
        Throw-DysonDataRootRecoveryError 'DYSON_CONTROL_DATA_RECOVERY_PATH_INVALID'
    }
}

function ConvertTo-DysonDataRootRecoveryExtendedPath {
    param([Parameter(Mandatory)][string]$Path)

    try {
        if ([string]::IsNullOrWhiteSpace($Path) -or -not [System.IO.Path]::IsPathRooted($Path)) {
            Throw-DysonDataRootRecoveryError 'DYSON_CONTROL_DATA_RECOVERY_PATH_INVALID'
        }
        $full = [System.IO.Path]::GetFullPath($Path)
        $separator = [System.IO.Path]::DirectorySeparatorChar
        $doubleSeparator = [string]::Concat($separator, $separator)
        $extendedPrefix = [string]::Concat($doubleSeparator, '?', $separator)
        $devicePrefix = [string]::Concat($doubleSeparator, '.', $separator)
        if ($full.StartsWith($extendedPrefix, [System.StringComparison]::OrdinalIgnoreCase) -or
            $full.StartsWith($devicePrefix, [System.StringComparison]::OrdinalIgnoreCase)) {
            Throw-DysonDataRootRecoveryError 'DYSON_CONTROL_DATA_RECOVERY_PATH_INVALID'
        }
        if ($full.StartsWith($doubleSeparator, [System.StringComparison]::Ordinal)) {
            return [string]::Concat($extendedPrefix, 'UNC', $separator, $full.Substring(2))
        }
        return [string]::Concat($extendedPrefix, $full)
    }
    catch {
        if ($_.Exception.Data.Contains('Code')) { throw }
        Throw-DysonDataRootRecoveryError 'DYSON_CONTROL_DATA_RECOVERY_PATH_INVALID'
    }
}

function ConvertFrom-DysonDataRootRecoveryExtendedPath {
    param([Parameter(Mandatory)][string]$Path)

    $separator = [System.IO.Path]::DirectorySeparatorChar
    $doubleSeparator = [string]::Concat($separator, $separator)
    $extendedPrefix = [string]::Concat($doubleSeparator, '?', $separator)
    $extendedUncPrefix = [string]::Concat($extendedPrefix, 'UNC', $separator)
    if ($Path.StartsWith($extendedUncPrefix, [System.StringComparison]::OrdinalIgnoreCase)) {
        return [string]::Concat($doubleSeparator, $Path.Substring($extendedUncPrefix.Length))
    }
    if ($Path.StartsWith($extendedPrefix, [System.StringComparison]::OrdinalIgnoreCase)) {
        return $Path.Substring($extendedPrefix.Length)
    }
    return $Path
}

function Get-DysonDataRootRecoveryParentPath {
    param([Parameter(Mandatory)][string]$Path)

    try {
        $native = ConvertTo-DysonDataRootRecoveryExtendedPath $Path
        $parentNative = [System.IO.Path]::GetDirectoryName($native.TrimEnd('\', '/'))
        if ([string]::IsNullOrWhiteSpace($parentNative)) {
            Throw-DysonDataRootRecoveryError 'DYSON_CONTROL_DATA_RECOVERY_PATH_INVALID'
        }
        return ConvertFrom-DysonDataRootRecoveryExtendedPath $parentNative
    }
    catch {
        if ($_.Exception.Data.Contains('Code')) { throw }
        Throw-DysonDataRootRecoveryError 'DYSON_CONTROL_DATA_RECOVERY_PATH_INVALID'
    }
}

function Test-DysonDataRootRecoveryFileExists {
    param([Parameter(Mandatory)][string]$Path)
    return [System.IO.File]::Exists((ConvertTo-DysonDataRootRecoveryExtendedPath $Path))
}

function Test-DysonDataRootRecoveryDirectoryExists {
    param([Parameter(Mandatory)][string]$Path)
    return [System.IO.Directory]::Exists((ConvertTo-DysonDataRootRecoveryExtendedPath $Path))
}

function Test-DysonDataRootRecoveryPathExists {
    param([Parameter(Mandatory)][string]$Path)
    return (Test-DysonDataRootRecoveryFileExists $Path) -or
        (Test-DysonDataRootRecoveryDirectoryExists $Path)
}

function Get-DysonDataRootRecoveryEntryInfo {
    param([Parameter(Mandatory)][string]$Path)

    $full = [System.IO.Path]::GetFullPath($Path)
    $native = ConvertTo-DysonDataRootRecoveryExtendedPath $full
    $attributes = [System.IO.File]::GetAttributes($native)
    $isDirectory = ($attributes -band [System.IO.FileAttributes]::Directory) -ne 0
    $length = if ($isDirectory) { 0L } else { [int64]([System.IO.FileInfo]::new($native).Length) }
    return [pscustomobject][ordered]@{
        FullName = $full.TrimEnd('\', '/')
        Name = [System.IO.Path]::GetFileName($full.TrimEnd('\', '/'))
        PSIsContainer = $isDirectory
        Attributes = $attributes
        Length = $length
    }
}

function Get-DysonDataRootRecoveryChildItems {
    param([Parameter(Mandatory)][string]$Path)

    try {
        $full = Get-DysonDataRootRecoveryFullPath $Path
        $items = New-Object System.Collections.ArrayList
        foreach ($nativeChild in [System.IO.Directory]::GetFileSystemEntries(
            (ConvertTo-DysonDataRootRecoveryExtendedPath $full)
        )) {
            $child = ConvertFrom-DysonDataRootRecoveryExtendedPath $nativeChild
            [void]$items.Add((Get-DysonDataRootRecoveryEntryInfo $child))
        }
        return @($items)
    }
    catch {
        if ($_.Exception.Data.Contains('Code')) { throw }
        Throw-DysonDataRootRecoveryError 'DYSON_CONTROL_DATA_RECOVERY_STORAGE_INVALID'
    }
}

function Test-DysonDataRootRecoverySamePath {
    param([Parameter(Mandatory)][string]$Left, [Parameter(Mandatory)][string]$Right)
    return [string]::Equals(
        (Get-DysonDataRootRecoveryFullPath $Left),
        (Get-DysonDataRootRecoveryFullPath $Right),
        [System.StringComparison]::OrdinalIgnoreCase
    )
}

function Test-DysonDataRootRecoveryPathWithin {
    param([Parameter(Mandatory)][string]$Candidate, [Parameter(Mandatory)][string]$Parent)

    $candidateFull = Get-DysonDataRootRecoveryFullPath $Candidate
    $parentFull = Get-DysonDataRootRecoveryFullPath $Parent
    if (Test-DysonDataRootRecoverySamePath $candidateFull $parentFull) { return $true }
    return $candidateFull.StartsWith(
        ($parentFull + [System.IO.Path]::DirectorySeparatorChar),
        [System.StringComparison]::OrdinalIgnoreCase
    )
}

function Assert-DysonDataRootRecoveryNoReparseAncestors {
    param([Parameter(Mandatory)][string]$Path, [switch]$AllowMissingLeaf)

    $full = Get-DysonDataRootRecoveryFullPath $Path
    $pathRoot = [System.IO.Path]::GetPathRoot($full)
    $cursor = $full
    if ($AllowMissingLeaf -and -not (Test-DysonDataRootRecoveryPathExists $cursor)) {
        $cursor = Get-DysonDataRootRecoveryParentPath $cursor
    }
    while (-not [string]::IsNullOrWhiteSpace($cursor) -and -not (Test-DysonDataRootRecoveryPathExists $cursor)) {
        if ([string]::Equals($cursor.TrimEnd('\', '/'), $pathRoot.TrimEnd('\', '/'), [System.StringComparison]::OrdinalIgnoreCase)) {
            break
        }
        $next = Get-DysonDataRootRecoveryParentPath $cursor
        if ([string]::Equals($next, $cursor, [System.StringComparison]::OrdinalIgnoreCase)) { break }
        $cursor = $next
    }
    while (-not [string]::IsNullOrWhiteSpace($cursor)) {
        try { $item = Get-DysonDataRootRecoveryEntryInfo $cursor }
        catch { Throw-DysonDataRootRecoveryError 'DYSON_CONTROL_DATA_RECOVERY_PATH_INVALID' }
        if (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
            Throw-DysonDataRootRecoveryError 'DYSON_CONTROL_DATA_RECOVERY_PATH_INVALID'
        }
        if ([string]::Equals($cursor.TrimEnd('\', '/'), $pathRoot.TrimEnd('\', '/'), [System.StringComparison]::OrdinalIgnoreCase)) {
            break
        }
        $parent = Get-DysonDataRootRecoveryParentPath $cursor
        if ([string]::IsNullOrWhiteSpace($parent) -or
            [string]::Equals($parent, $cursor, [System.StringComparison]::OrdinalIgnoreCase)) { break }
        $cursor = $parent
    }
    return $full
}

function Assert-DysonDataRootRecoveryPlainDirectory {
    param([Parameter(Mandatory)][string]$Path, [switch]$AllowMissing)

    $full = Assert-DysonDataRootRecoveryNoReparseAncestors -Path $Path -AllowMissingLeaf:$AllowMissing
    if (-not (Test-DysonDataRootRecoveryPathExists $full)) {
        if ($AllowMissing) { return $full }
        Throw-DysonDataRootRecoveryError 'DYSON_CONTROL_DATA_RECOVERY_STORAGE_INVALID'
    }
    try { $item = Get-DysonDataRootRecoveryEntryInfo $full }
    catch { Throw-DysonDataRootRecoveryError 'DYSON_CONTROL_DATA_RECOVERY_STORAGE_INVALID' }
    if (-not $item.PSIsContainer -or ($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint)) {
        Throw-DysonDataRootRecoveryError 'DYSON_CONTROL_DATA_RECOVERY_STORAGE_INVALID'
    }
    return $item.FullName
}

function Assert-DysonDataRootRecoveryPlainFile {
    param(
        [Parameter(Mandatory)][string]$Path,
        [int64]$MaximumBytes = $script:DysonDataRootRecoveryMaximumRecordBytes,
        [switch]$AllowEmpty
    )

    [void](Assert-DysonDataRootRecoveryNoReparseAncestors -Path $Path)
    try { $item = Get-DysonDataRootRecoveryEntryInfo $Path }
    catch { Throw-DysonDataRootRecoveryError 'DYSON_CONTROL_DATA_RECOVERY_STORAGE_INVALID' }
    $minimum = if ($AllowEmpty) { 0L } else { 1L }
    if ($item.PSIsContainer -or ($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -or
        [int64]$item.Length -lt $minimum -or [int64]$item.Length -gt $MaximumBytes) {
        Throw-DysonDataRootRecoveryError 'DYSON_CONTROL_DATA_RECOVERY_STORAGE_INVALID'
    }
    return $item
}

function Assert-DysonDataRootRecoveryGuid {
    param([Parameter(Mandatory)][string]$Value)
    $parsed = [guid]::Empty
    if (-not [guid]::TryParseExact($Value, 'D', [ref]$parsed)) {
        Throw-DysonDataRootRecoveryError 'DYSON_CONTROL_DATA_RECOVERY_INPUT_INVALID'
    }
    return $parsed.ToString('D').ToLowerInvariant()
}

function Assert-DysonDataRootRecoveryDigest {
    param([Parameter(Mandatory)][string]$Value)
    if ($Value -cnotmatch '^[0-9a-f]{64}$') {
        Throw-DysonDataRootRecoveryError 'DYSON_CONTROL_DATA_RECOVERY_INPUT_INVALID'
    }
    return $Value
}

function Assert-DysonDataRootRecoveryIdentity {
    param([Parameter(Mandatory)][string]$Value)
    if ($Value -cnotmatch '^sha256:[0-9a-f]{64}$') {
        Throw-DysonDataRootRecoveryError 'DYSON_CONTROL_DATA_RECOVERY_INPUT_INVALID'
    }
    return $Value
}

function Get-DysonDataRootRecoveryIdentityStem {
    param([Parameter(Mandatory)][string]$Value)
    $identity = Assert-DysonDataRootRecoveryIdentity $Value
    return $identity.Substring(7)
}

function Assert-DysonDataRootRecoveryExactProperties {
    param([Parameter(Mandatory)]$Value, [Parameter(Mandatory)][string[]]$Names, [string]$Code = 'DYSON_CONTROL_DATA_RECOVERY_BUNDLE_INVALID')

    if ($null -eq $Value) { Throw-DysonDataRootRecoveryError $Code }
    $actual = @($Value.PSObject.Properties.Name)
    if ($actual.Count -ne $Names.Count) { Throw-DysonDataRootRecoveryError $Code }
    foreach ($name in $Names) {
        if ($actual -cnotcontains $name) { Throw-DysonDataRootRecoveryError $Code }
    }
}

function Get-DysonDataRootRecoveryAclIntent {
    param([Parameter(Mandatory)][string]$Path)

    try {
        $full = Assert-DysonDataRootRecoveryNoReparseAncestors $Path
        $acl = Microsoft.PowerShell.Security\Get-Acl `
            -LiteralPath (ConvertTo-DysonDataRootRecoveryExtendedPath $full) -ErrorAction Stop
        $binary = $acl.GetSecurityDescriptorBinaryForm()
        $base64 = [Convert]::ToBase64String($binary)
        return [pscustomobject][ordered]@{
            mode = 'exact-binary-security-descriptor'
            descriptorSha256 = Get-DysonDataRootRecoveryTextSha256 $base64
            binaryBase64 = $base64
        }
    }
    catch {
        if ($_.Exception.Data.Contains('Code')) { throw }
        Throw-DysonDataRootRecoveryError 'DYSON_CONTROL_DATA_RECOVERY_ACCESS_CONTROL_FAILED'
    }
}

function ConvertTo-DysonDataRootRecoveryValidatedAclIntent {
    param([Parameter(Mandatory)]$Raw)

    Assert-DysonDataRootRecoveryExactProperties $Raw @('mode', 'descriptorSha256', 'binaryBase64')
    if ($Raw.mode -isnot [string] -or [string]$Raw.mode -cne 'exact-binary-security-descriptor' -or
        $Raw.descriptorSha256 -isnot [string] -or [string]$Raw.descriptorSha256 -cnotmatch '^[0-9a-f]{64}$' -or
        $Raw.binaryBase64 -isnot [string] -or [string]$Raw.binaryBase64 -notmatch '^[A-Za-z0-9+/]+={0,2}$' -or
        ([string]$Raw.binaryBase64).Length -gt 262144 -or
        (Get-DysonDataRootRecoveryTextSha256 ([string]$Raw.binaryBase64)) -cne [string]$Raw.descriptorSha256) {
        Throw-DysonDataRootRecoveryError 'DYSON_CONTROL_DATA_RECOVERY_BUNDLE_INVALID'
    }
    try {
        $binary = [Convert]::FromBase64String([string]$Raw.binaryBase64)
        if ($binary.Length -lt 20 -or $binary.Length -gt 65536) { throw 'descriptor size' }
        $descriptor = [System.Security.AccessControl.RawSecurityDescriptor]::new($binary, 0)
        if ($null -eq $descriptor.Owner -or $null -eq $descriptor.DiscretionaryAcl) { throw 'descriptor shape' }
    }
    catch { Throw-DysonDataRootRecoveryError 'DYSON_CONTROL_DATA_RECOVERY_BUNDLE_INVALID' }
    return [pscustomobject][ordered]@{
        mode = 'exact-binary-security-descriptor'
        descriptorSha256 = [string]$Raw.descriptorSha256
        binaryBase64 = [string]$Raw.binaryBase64
    }
}

function Set-DysonDataRootRecoveryAclIntent {
    param([Parameter(Mandatory)][string]$Path, [Parameter(Mandatory)]$AclIntent, [Parameter(Mandatory)][ValidateSet('file', 'directory')][string]$Type)

    $intent = ConvertTo-DysonDataRootRecoveryValidatedAclIntent $AclIntent
    try {
        $binary = [Convert]::FromBase64String($intent.binaryBase64)
        if ($Type -ceq 'directory') {
            $security = New-Object System.Security.AccessControl.DirectorySecurity
            $security.SetSecurityDescriptorBinaryForm($binary)
            Microsoft.PowerShell.Security\Set-Acl `
                -LiteralPath (ConvertTo-DysonDataRootRecoveryExtendedPath $Path) `
                -AclObject $security -ErrorAction Stop
        }
        else {
            $security = New-Object System.Security.AccessControl.FileSecurity
            $security.SetSecurityDescriptorBinaryForm($binary)
            Microsoft.PowerShell.Security\Set-Acl `
                -LiteralPath (ConvertTo-DysonDataRootRecoveryExtendedPath $Path) `
                -AclObject $security -ErrorAction Stop
        }
    }
    catch { Throw-DysonDataRootRecoveryError 'DYSON_CONTROL_DATA_RECOVERY_ACCESS_CONTROL_FAILED' }
    $observed = Get-DysonDataRootRecoveryAclIntent $Path
    if ($observed.descriptorSha256 -cne $intent.descriptorSha256 -or
        $observed.binaryBase64 -cne $intent.binaryBase64) {
        Throw-DysonDataRootRecoveryError 'DYSON_CONTROL_DATA_RECOVERY_ACCESS_CONTROL_FAILED'
    }
}

function Protect-DysonDataRootRecoveryDirectory {
    param([Parameter(Mandatory)][string]$Path)

    try {
        $directory = Assert-DysonDataRootRecoveryPlainDirectory $Path
        $identity = [System.Security.Principal.WindowsIdentity]::GetCurrent()
        $nativeDirectory = ConvertTo-DysonDataRootRecoveryExtendedPath $directory
        $existing = Microsoft.PowerShell.Security\Get-Acl -LiteralPath $nativeDirectory -ErrorAction Stop
        $allowedSidValues = @(
            $identity.User.Value,
            'S-1-5-18',
            'S-1-5-32-544'
        )
        $existingRules = @($existing.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier]))
        $existingOwner = $existing.GetOwner([System.Security.Principal.SecurityIdentifier])
        $inheritance = [System.Security.AccessControl.InheritanceFlags]'ContainerInherit, ObjectInherit'
        $propagation = [System.Security.AccessControl.PropagationFlags]::None
        $allow = [System.Security.AccessControl.AccessControlType]::Allow
        $fullControl = [System.Security.AccessControl.FileSystemRights]::FullControl
        $alreadyPrivate = $existing.AreAccessRulesProtected -and
            [string]::Equals($existingOwner.Value, $identity.User.Value, [System.StringComparison]::OrdinalIgnoreCase) -and
            $existingRules.Count -eq $allowedSidValues.Count
        if ($alreadyPrivate) {
            $observed = @{}
            foreach ($rule in $existingRules) {
                if ($rule.IsInherited -or $rule.IdentityReference.Value -notin $allowedSidValues -or
                    $rule.AccessControlType -ne $allow -or $rule.FileSystemRights -ne $fullControl -or
                    $rule.InheritanceFlags -ne $inheritance -or $rule.PropagationFlags -ne $propagation -or
                    $observed.ContainsKey($rule.IdentityReference.Value)) {
                    $alreadyPrivate = $false
                    break
                }
                $observed[$rule.IdentityReference.Value] = $true
            }
        }
        if ($alreadyPrivate) { return }
        $security = New-Object System.Security.AccessControl.DirectorySecurity
        $security.SetAccessRuleProtection($true, $false)
        $security.SetOwner($identity.User)
        $sids = @(
            $identity.User,
            (New-Object System.Security.Principal.SecurityIdentifier('S-1-5-18')),
            (New-Object System.Security.Principal.SecurityIdentifier('S-1-5-32-544'))
        )
        foreach ($sid in $sids) {
            $rule = New-Object System.Security.AccessControl.FileSystemAccessRule(
                $sid, $fullControl, $inheritance, $propagation, $allow
            )
            [void]$security.AddAccessRule($rule)
        }
        Microsoft.PowerShell.Security\Set-Acl -LiteralPath $nativeDirectory -AclObject $security -ErrorAction Stop
    }
    catch {
        if ($_.Exception.Data.Contains('Code')) { throw }
        Throw-DysonDataRootRecoveryError 'DYSON_CONTROL_DATA_RECOVERY_ACCESS_CONTROL_FAILED'
    }
}

function New-DysonDataRootRecoveryPrivateDirectory {
    param([Parameter(Mandatory)][string]$Path, [switch]$Protect)

    [void](Assert-DysonDataRootRecoveryNoReparseAncestors -Path $Path -AllowMissingLeaf)
    try {
        [void][System.IO.Directory]::CreateDirectory(
            (ConvertTo-DysonDataRootRecoveryExtendedPath (Get-DysonDataRootRecoveryFullPath $Path))
        )
    }
    catch { Throw-DysonDataRootRecoveryError 'DYSON_CONTROL_DATA_RECOVERY_STORAGE_INVALID' }
    $directory = Assert-DysonDataRootRecoveryPlainDirectory $Path
    if ($Protect) { Protect-DysonDataRootRecoveryDirectory $directory }
    return $directory
}

function Assert-DysonDataRootRecoveryRoots {
    param(
        [Parameter(Mandatory)][string]$DataRoot,
        [Parameter(Mandatory)][string]$RecoveryRoot,
        [Parameter(Mandatory)][ValidateSet('Windows', 'Shadow')][string]$Backend,
        [string]$ShadowRoot
    )

    $dataFull = Assert-DysonDataRootRecoveryPlainDirectory $DataRoot
    $recoveryFull = Assert-DysonDataRootRecoveryPlainDirectory $RecoveryRoot -AllowMissing
    if ((Test-DysonDataRootRecoveryPathWithin $dataFull $recoveryFull) -or
        (Test-DysonDataRootRecoveryPathWithin $recoveryFull $dataFull)) {
        Throw-DysonDataRootRecoveryError 'DYSON_CONTROL_DATA_RECOVERY_PATH_INVALID'
    }
    if ($Backend -ceq 'Shadow') {
        if ($env:DYSON_DATA_ROOT_RECOVERY_SELFTEST -cne '1' -or [string]::IsNullOrWhiteSpace($ShadowRoot)) {
            Throw-DysonDataRootRecoveryError 'DYSON_CONTROL_DATA_RECOVERY_SHADOW_FORBIDDEN'
        }
        $shadowFull = Assert-DysonDataRootRecoveryPlainDirectory $ShadowRoot
        if (-not (Test-DysonDataRootRecoveryFileExists (Join-Path $shadowFull '.dyson-data-root-recovery-shadow')) -or
            -not (Test-DysonDataRootRecoveryPathWithin $dataFull $shadowFull) -or
            -not (Test-DysonDataRootRecoveryPathWithin $recoveryFull $shadowFull)) {
            Throw-DysonDataRootRecoveryError 'DYSON_CONTROL_DATA_RECOVERY_SHADOW_FORBIDDEN'
        }
    }
    return [pscustomobject][ordered]@{ dataRoot = $dataFull; recoveryRoot = $recoveryFull }
}

function Assert-DysonDataRootRecoveryTaskQuiesced {
    param(
        [Parameter(Mandatory)][string]$TaskName,
        [Parameter(Mandatory)][ValidateSet('Windows', 'Shadow')][string]$Backend,
        [string]$ShadowRoot
    )

    if ($TaskName -cnotmatch '^[A-Za-z0-9][A-Za-z0-9._ -]{0,127}$') {
        Throw-DysonDataRootRecoveryError 'DYSON_CONTROL_DATA_RECOVERY_INPUT_INVALID'
    }
    try {
        if ($Backend -ceq 'Shadow') {
            $taskPath = Join-Path (Get-DysonDataRootRecoveryFullPath $ShadowRoot) 'control-task.json'
            $item = Assert-DysonDataRootRecoveryPlainFile $taskPath
            $raw = [System.IO.File]::ReadAllText(
                (ConvertTo-DysonDataRootRecoveryExtendedPath $item.FullName),
                [System.Text.UTF8Encoding]::new($false)
            ) | ConvertFrom-Json
            Assert-DysonDataRootRecoveryExactProperties $raw @('protocol', 'schemaVersion', 'taskName', 'taskPath', 'state', 'enabled') 'DYSON_CONTROL_DATA_RECOVERY_TASK_NOT_QUIESCED'
            if ($raw.protocol -isnot [string] -or [string]$raw.protocol -cne $script:DysonDataRootRecoveryShadowTaskProtocol -or
                [int64]$raw.schemaVersion -ne 1 -or $raw.taskName -isnot [string] -or
                -not [string]::Equals([string]$raw.taskName, $TaskName, [System.StringComparison]::Ordinal) -or
                $raw.taskPath -isnot [string] -or [string]$raw.taskPath -cne '\' -or
                $raw.state -isnot [string] -or [string]$raw.state -cnotin @('Ready', 'Disabled') -or
                $raw.enabled -isnot [bool]) {
                Throw-DysonDataRootRecoveryError 'DYSON_CONTROL_DATA_RECOVERY_TASK_NOT_QUIESCED'
            }
            return [pscustomobject][ordered]@{ taskName = $TaskName; state = [string]$raw.state; quiesced = $true }
        }
        $tasks = @(Get-ScheduledTask -TaskName $TaskName -TaskPath '\' -ErrorAction Stop)
        if ($tasks.Count -ne 1 -or [string]$tasks[0].TaskName -cne $TaskName -or
            [string]$tasks[0].TaskPath -cne '\' -or [string]$tasks[0].State -notin @('Ready', 'Disabled')) {
            Throw-DysonDataRootRecoveryError 'DYSON_CONTROL_DATA_RECOVERY_TASK_NOT_QUIESCED'
        }
        return [pscustomobject][ordered]@{ taskName = $TaskName; state = [string]$tasks[0].State; quiesced = $true }
    }
    catch {
        if ($_.Exception.Data.Contains('Code')) { throw }
        Throw-DysonDataRootRecoveryError 'DYSON_CONTROL_DATA_RECOVERY_TASK_NOT_QUIESCED'
    }
}

function Read-DysonDataRootRecoveryJson {
    param([Parameter(Mandatory)][string]$Path, [int64]$MaximumBytes = $script:DysonDataRootRecoveryMaximumRecordBytes, [string]$Code = 'DYSON_CONTROL_DATA_RECOVERY_STORAGE_INVALID')

    try {
        $item = Assert-DysonDataRootRecoveryPlainFile -Path $Path -MaximumBytes $MaximumBytes
        $text = [System.IO.File]::ReadAllText(
            (ConvertTo-DysonDataRootRecoveryExtendedPath $item.FullName),
            [System.Text.UTF8Encoding]::new($false)
        )
        if ([System.Text.UTF8Encoding]::new($false).GetByteCount($text) -ne $item.Length) { Throw-DysonDataRootRecoveryError $Code }
        return ($text | ConvertFrom-Json)
    }
    catch {
        if ($_.Exception.Data.Contains('Code')) {
            if ([string]$_.Exception.Data['Code'] -eq $Code) { throw }
        }
        Throw-DysonDataRootRecoveryError $Code
    }
}

function Write-DysonDataRootRecoveryJsonNew {
    param([Parameter(Mandatory)][string]$Path, [Parameter(Mandatory)]$Value, [int64]$MaximumBytes = $script:DysonDataRootRecoveryMaximumRecordBytes)

    $full = Get-DysonDataRootRecoveryFullPath $Path
    if (Test-DysonDataRootRecoveryPathExists $full) { Throw-DysonDataRootRecoveryError 'DYSON_CONTROL_DATA_RECOVERY_BUNDLE_CONFLICT' }
    $parent = New-DysonDataRootRecoveryPrivateDirectory (Get-DysonDataRootRecoveryParentPath $full)
    $json = ConvertTo-DysonDataRootRecoveryJson $Value
    $bytes = [System.Text.UTF8Encoding]::new($false).GetBytes($json)
    if ($bytes.Length -lt 2 -or $bytes.Length -gt $MaximumBytes) { Throw-DysonDataRootRecoveryError 'DYSON_CONTROL_DATA_RECOVERY_STORAGE_INVALID' }
    $partial = $full + '.partial-' + [guid]::NewGuid().ToString('N')
    [void](Assert-DysonDataRootRecoveryNoReparseAncestors -Path $partial -AllowMissingLeaf)
    if (Test-DysonDataRootRecoveryPathExists $partial) {
        Throw-DysonDataRootRecoveryError 'DYSON_CONTROL_DATA_RECOVERY_STORAGE_INVALID'
    }
    try {
        $stream = [System.IO.FileStream]::new(
            (ConvertTo-DysonDataRootRecoveryExtendedPath $partial),
            [System.IO.FileMode]::CreateNew,
            [System.IO.FileAccess]::Write,
            [System.IO.FileShare]::None,
            4096,
            [System.IO.FileOptions]::WriteThrough
        )
        try {
            $stream.Write($bytes, 0, $bytes.Length)
            $stream.Flush($true)
        }
        finally { $stream.Dispose() }
        $partialItem = Assert-DysonDataRootRecoveryPlainFile $partial $MaximumBytes
        if ([int64]$partialItem.Length -ne [int64]$bytes.Length -or
            (Test-DysonDataRootRecoveryPathExists $full)) {
            Throw-DysonDataRootRecoveryError 'DYSON_CONTROL_DATA_RECOVERY_STORAGE_INVALID'
        }
        [void](Assert-DysonDataRootRecoveryNoReparseAncestors -Path $full -AllowMissingLeaf)
        [System.IO.File]::Move(
            (ConvertTo-DysonDataRootRecoveryExtendedPath $partial),
            (ConvertTo-DysonDataRootRecoveryExtendedPath $full)
        )
        $published = Assert-DysonDataRootRecoveryPlainFile $full $MaximumBytes
        if ([int64]$published.Length -ne [int64]$bytes.Length) {
            Throw-DysonDataRootRecoveryError 'DYSON_CONTROL_DATA_RECOVERY_STORAGE_INVALID'
        }
    }
    catch {
        if (Test-DysonDataRootRecoveryFileExists $partial) {
            try { [System.IO.File]::Delete((ConvertTo-DysonDataRootRecoveryExtendedPath $partial)) } catch {}
        }
        Throw-DysonDataRootRecoveryError 'DYSON_CONTROL_DATA_RECOVERY_STORAGE_INVALID'
    }
    return $full
}

function Assert-DysonDataRootRecoveryBrokerHistoryClosed {
    param(
        [Parameter(Mandatory)][string]$BrokerRoot,
        [Parameter(Mandatory)][ValidateSet('lifecycle', 'cutover')][string]$Kind
    )

    if (-not (Test-DysonDataRootRecoveryPathExists $BrokerRoot)) { return 0 }
    $root = Assert-DysonDataRootRecoveryPlainDirectory $BrokerRoot
    $requestsPath = Join-Path $root 'requests'
    $receiptsPath = Join-Path $root 'receipts'
    $intentsPath = Join-Path $root 'intents'
    foreach ($required in @($requestsPath, $receiptsPath, $intentsPath)) {
        [void](Assert-DysonDataRootRecoveryPlainDirectory $required)
    }
    $workPath = if ($Kind -ceq 'cutover') { Join-Path $root 'work' } else { $null }
    if ($null -ne $workPath) { [void](Assert-DysonDataRootRecoveryPlainDirectory $workPath) }
    if (@(Get-DysonDataRootRecoveryChildItems $intentsPath).Count -ne 0 -or
        ($null -ne $workPath -and @(Get-DysonDataRootRecoveryChildItems $workPath).Count -ne 0)) {
        Throw-DysonDataRootRecoveryError 'DYSON_CONTROL_DATA_RECOVERY_PENDING_MUTATION'
    }

    $requests = @(Get-DysonDataRootRecoveryChildItems $requestsPath)
    $receipts = @(Get-DysonDataRootRecoveryChildItems $receiptsPath)
    $requestMap = @{}
    $receiptMap = @{}
    foreach ($item in $requests) {
        if ($item.PSIsContainer -or ($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -or
            $item.Name -cnotmatch '^(?<id>[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.json$') {
            Throw-DysonDataRootRecoveryError 'DYSON_CONTROL_DATA_RECOVERY_PENDING_MUTATION'
        }
        $requestMap[$Matches.id] = $item.FullName
    }
    foreach ($item in $receipts) {
        if ($item.PSIsContainer -or ($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -or
            $item.Name -cnotmatch '^(?<id>[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.json$') {
            Throw-DysonDataRootRecoveryError 'DYSON_CONTROL_DATA_RECOVERY_PENDING_MUTATION'
        }
        $receiptMap[$Matches.id] = $item.FullName
    }
    if ($Kind -ceq 'cutover') {
        # The worker removes requests after persisting terminal receipts. Validate
        # the retained history using its authoritative protocol, not file counts.
        $brokerCommon = Join-Path $script:DysonDataRootRecoveryCommonRoot 'cutover-broker\DysonCutoverBroker.Common.ps1'
        try {
            . $brokerCommon
            foreach ($id in $receiptMap.Keys) {
                $terminal = ConvertTo-DysonCutoverBrokerValidatedReceipt (Read-DysonDataRootRecoveryJson $receiptMap[$id])
                if ([string]$terminal.brokerRequestId -cne $id) { throw 'receipt identity mismatch' }
                # A failed read-only observation cannot leave a host mutation to
                # recover. Failed mutating operations still require reconciliation.
                if ($terminal.state -ceq 'failed' -and $terminal.capability -cne 'CutoverEvidence') {
                    throw 'failed mutation requires reconciliation'
                }
            }
        }
        catch { Throw-DysonDataRootRecoveryError 'DYSON_CONTROL_DATA_RECOVERY_PENDING_MUTATION' }
    }
    if ($Kind -ceq 'lifecycle' -and $requestMap.Count -ne $receiptMap.Count) {
        Throw-DysonDataRootRecoveryError 'DYSON_CONTROL_DATA_RECOVERY_PENDING_MUTATION'
    }
    foreach ($id in $requestMap.Keys) {
        if (-not $receiptMap.ContainsKey($id)) { Throw-DysonDataRootRecoveryError 'DYSON_CONTROL_DATA_RECOVERY_PENDING_MUTATION' }
        $request = Read-DysonDataRootRecoveryJson $requestMap[$id]
        $receipt = Read-DysonDataRootRecoveryJson $receiptMap[$id]
        $requestProtocol = if ($Kind -ceq 'lifecycle') { 'DYSON_CONTROL_LIFECYCLE_BROKER_REQUEST_V1' } else { 'DYSON_CONTROL_CUTOVER_BROKER_REQUEST_V1' }
        $receiptProtocol = if ($Kind -ceq 'lifecycle') { 'DYSON_CONTROL_LIFECYCLE_BROKER_RECEIPT_V1' } else { 'DYSON_CONTROL_CUTOVER_BROKER_RECEIPT_V1' }
        if ($request.protocol -isnot [string] -or [string]$request.protocol -cne $requestProtocol -or
            [int64]$request.schemaVersion -ne 1 -or [string]$request.brokerRequestId -cne $id -or
            $request.requestFingerprint -isnot [string] -or [string]$request.requestFingerprint -cnotmatch '^[0-9a-f]{64}$' -or
            $request.capability -isnot [string] -or [string]::IsNullOrWhiteSpace([string]$request.capability) -or
            $receipt.protocol -isnot [string] -or [string]$receipt.protocol -cne $receiptProtocol -or
            [int64]$receipt.schemaVersion -ne 1 -or [string]$receipt.brokerRequestId -cne $id -or
            [string]$receipt.requestFingerprint -cne [string]$request.requestFingerprint -or
            [string]$receipt.capability -cne [string]$request.capability) {
            Throw-DysonDataRootRecoveryError 'DYSON_CONTROL_DATA_RECOVERY_PENDING_MUTATION'
        }
        if (($Kind -ceq 'lifecycle' -and [string]$receipt.status -cnotin @('succeeded', 'blocked', 'failed')) -or
            ($Kind -ceq 'cutover' -and [string]$receipt.state -cnotin @('succeeded', 'failed'))) {
            Throw-DysonDataRootRecoveryError 'DYSON_CONTROL_DATA_RECOVERY_PENDING_MUTATION'
        }
    }
    return $receiptMap.Count
}

function Assert-DysonDataRootRecoveryNoPendingMutations {
    param(
        [Parameter(Mandatory)][string]$DataRoot,
        [Parameter(Mandatory)][string]$RecoveryRoot,
        [string]$DataRootIdentity,
        [string]$AllowedTerminalOperationId
    )

    $lifecycleCount = Assert-DysonDataRootRecoveryBrokerHistoryClosed (Join-Path $DataRoot 'data\lifecycle-broker') lifecycle
    $cutoverCount = Assert-DysonDataRootRecoveryBrokerHistoryClosed (Join-Path $DataRoot 'data\cutover-broker') cutover
    if (-not [string]::IsNullOrWhiteSpace($DataRootIdentity) -and
        (Test-DysonDataRootRecoveryDirectoryExists $RecoveryRoot)) {
        $stateRoot = Join-Path (Join-Path $RecoveryRoot 'state') (Get-DysonDataRootRecoveryIdentityStem $DataRootIdentity)
        $intents = Join-Path $stateRoot 'intents'
        if (Test-DysonDataRootRecoveryPathExists $intents) {
            [void](Assert-DysonDataRootRecoveryPlainDirectory $intents)
            $intentItems = @(Get-DysonDataRootRecoveryChildItems $intents)
            if ($intentItems.Count -ne 0) {
                if ([string]::IsNullOrWhiteSpace($AllowedTerminalOperationId) -or $intentItems.Count -ne 1) {
                    Throw-DysonDataRootRecoveryError 'DYSON_CONTROL_DATA_RECOVERY_RECOVERY_REQUIRED'
                }
                $allowedId = Assert-DysonDataRootRecoveryGuid $AllowedTerminalOperationId
                $intentItem = $intentItems[0]
                if ($intentItem.PSIsContainer -or
                    ($intentItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -or
                    $intentItem.Name -cne ($allowedId + '.json')) {
                    Throw-DysonDataRootRecoveryError 'DYSON_CONTROL_DATA_RECOVERY_RECOVERY_REQUIRED'
                }
                $receiptPath = Join-Path (Join-Path $stateRoot 'receipts') ($allowedId + '.json')
                if (-not (Test-DysonDataRootRecoveryFileExists $receiptPath)) {
                    Throw-DysonDataRootRecoveryError 'DYSON_CONTROL_DATA_RECOVERY_RECOVERY_REQUIRED'
                }
                $intent = ConvertTo-DysonDataRootRecoveryValidatedIntent `
                    (Read-DysonDataRootRecoveryJson $intentItem.FullName $script:DysonDataRootRecoveryMaximumRecordBytes `
                        'DYSON_CONTROL_DATA_RECOVERY_RECOVERY_REQUIRED')
                $receipt = ConvertTo-DysonDataRootRecoveryValidatedReceipt `
                    (Read-DysonDataRootRecoveryJson $receiptPath $script:DysonDataRootRecoveryMaximumRecordBytes `
                        'DYSON_CONTROL_DATA_RECOVERY_RECOVERY_REQUIRED')
                Assert-DysonDataRootRecoveryIntentReceiptBinding $intent $receipt
                if ([string]$intent.operationId -cne $allowedId -or
                    [string]$intent.dataRootIdentity -cne $DataRootIdentity) {
                    Throw-DysonDataRootRecoveryError 'DYSON_CONTROL_DATA_RECOVERY_RECOVERY_REQUIRED'
                }
            }
        }
    }
    return [pscustomobject][ordered]@{
        lifecycleTerminalCount = $lifecycleCount
        cutoverTerminalCount = $cutoverCount
        pending = $false
    }
}

function Get-DysonDataRootRecoveryRelativePath {
    param([Parameter(Mandatory)][string]$Root, [Parameter(Mandatory)][string]$Path)

    $rootFull = Get-DysonDataRootRecoveryFullPath $Root
    $pathFull = Get-DysonDataRootRecoveryFullPath $Path
    if (Test-DysonDataRootRecoverySamePath $rootFull $pathFull) { return '.' }
    $prefix = $rootFull + [System.IO.Path]::DirectorySeparatorChar
    if (-not $pathFull.StartsWith($prefix, [System.StringComparison]::OrdinalIgnoreCase)) {
        Throw-DysonDataRootRecoveryError 'DYSON_CONTROL_DATA_RECOVERY_TREE_INVALID'
    }
    $relative = $pathFull.Substring($prefix.Length).Replace([System.IO.Path]::AltDirectorySeparatorChar, [System.IO.Path]::DirectorySeparatorChar)
    if ([string]::IsNullOrWhiteSpace($relative) -or $relative.Length -gt 2048 -or
        $relative.Contains('..') -or $relative.IndexOfAny([char[]]@("`r", "`n", [char]0)) -ge 0 -or
        [System.IO.Path]::IsPathRooted($relative)) {
        Throw-DysonDataRootRecoveryError 'DYSON_CONTROL_DATA_RECOVERY_TREE_INVALID'
    }
    return $relative
}

function Get-DysonDataRootRecoveryTreeInventory {
    param([Parameter(Mandatory)][string]$DataRoot)

    $root = Assert-DysonDataRootRecoveryPlainDirectory $DataRoot
    $queue = New-Object System.Collections.Generic.Queue[string]
    $queue.Enqueue($root)
    $entries = New-Object System.Collections.ArrayList
    $totalBytes = 0L
    $fileCount = 0
    $directoryCount = 0
    $saveStems = @{}
    while ($queue.Count -gt 0) {
        $current = $queue.Dequeue()
        $relative = Get-DysonDataRootRecoveryRelativePath $root $current
        if ($relative -ne '.') {
            $top = $relative.Split([System.IO.Path]::DirectorySeparatorChar)[0]
            if ($top -cnotin $script:DysonDataRootRecoveryAllowedTopLevel) {
                Throw-DysonDataRootRecoveryError 'DYSON_CONTROL_DATA_RECOVERY_TREE_INVALID'
            }
        }
        $acl = Get-DysonDataRootRecoveryAclIntent $current
        [void]$entries.Add([pscustomobject][ordered]@{
            relativePath = $relative
            type = 'directory'
            length = 0L
            sha256 = $script:DysonDataRootRecoveryDirectoryDigest
            aclIntent = $acl
        })
        $directoryCount++
        $children = @(Get-DysonDataRootRecoveryChildItems $current | Sort-Object -Property Name)
        foreach ($child in $children) {
            if (($child.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
                Throw-DysonDataRootRecoveryError 'DYSON_CONTROL_DATA_RECOVERY_TREE_INVALID'
            }
            $childRelative = Get-DysonDataRootRecoveryRelativePath $root $child.FullName
            $top = $childRelative.Split([System.IO.Path]::DirectorySeparatorChar)[0]
            if ($top -cnotin $script:DysonDataRootRecoveryAllowedTopLevel) {
                Throw-DysonDataRootRecoveryError 'DYSON_CONTROL_DATA_RECOVERY_TREE_INVALID'
            }
            if ($child.PSIsContainer) {
                $queue.Enqueue($child.FullName)
                continue
            }
            if ($child.Name -match '(?i)(?:-wal|-shm)$') {
                Throw-DysonDataRootRecoveryError 'DYSON_CONTROL_DATA_RECOVERY_SQLITE_NOT_CHECKPOINTED'
            }
            $extension = [System.IO.Path]::GetExtension($child.Name).ToLowerInvariant()
            if ($extension -in @('.dsv', '.server')) {
                $stem = $childRelative.Substring(0, $childRelative.Length - $extension.Length).ToLowerInvariant()
                if (-not $saveStems.ContainsKey($stem)) { $saveStems[$stem] = @{} }
                $saveStems[$stem][$extension] = $true
            }
            $length = [int64]$child.Length
            if ($length -lt 0 -or $length -gt $script:DysonDataRootRecoveryMaximumTotalBytes -or
                $totalBytes -gt ($script:DysonDataRootRecoveryMaximumTotalBytes - $length)) {
                Throw-DysonDataRootRecoveryError 'DYSON_CONTROL_DATA_RECOVERY_TREE_INVALID'
            }
            $digest = Get-DysonDataRootRecoveryFileSha256 $child.FullName
            $acl = Get-DysonDataRootRecoveryAclIntent $child.FullName
            [void]$entries.Add([pscustomobject][ordered]@{
                relativePath = $childRelative
                type = 'file'
                length = $length
                sha256 = $digest
                aclIntent = $acl
            })
            $fileCount++
            $totalBytes += $length
            if ($entries.Count -gt $script:DysonDataRootRecoveryMaximumEntryCount) {
                Throw-DysonDataRootRecoveryError 'DYSON_CONTROL_DATA_RECOVERY_TREE_INVALID'
            }
        }
    }
    foreach ($stem in $saveStems.Keys) {
        if (-not $saveStems[$stem].ContainsKey('.dsv') -or -not $saveStems[$stem].ContainsKey('.server')) {
            Throw-DysonDataRootRecoveryError 'DYSON_CONTROL_DATA_RECOVERY_SAVE_PAIR_INVALID'
        }
    }
    $sorted = [object[]]@($entries)
    $ordinalEntryComparer = [System.Collections.Generic.Comparer[object]]::Create(
        [System.Comparison[object]]{
            param($left, $right)
            return [System.StringComparer]::Ordinal.Compare([string]$left.relativePath, [string]$right.relativePath)
        }
    )
    [System.Array]::Sort($sorted, $ordinalEntryComparer)
    $inventoryJson = ConvertTo-DysonDataRootRecoveryJson ([pscustomobject][ordered]@{ entries = $sorted })
    return [pscustomobject][ordered]@{
        entries = $sorted
        fileCount = $fileCount
        directoryCount = $directoryCount
        totalBytes = $totalBytes
        inventorySha256 = Get-DysonDataRootRecoveryTextSha256 $inventoryJson
    }
}

function Copy-DysonDataRootRecoveryFile {
    param([Parameter(Mandatory)][string]$Source, [Parameter(Mandatory)][string]$Destination, [Parameter(Mandatory)][int64]$ExpectedLength, [Parameter(Mandatory)][string]$ExpectedSha256)

    $sourceStream = $null
    $destinationStream = $null
    $sha = $null
    try {
        $sourceItem = Assert-DysonDataRootRecoveryPlainFile $Source ([int64]::MaxValue) -AllowEmpty
        $parent = Get-DysonDataRootRecoveryParentPath $Destination
        if (-not (Test-DysonDataRootRecoveryDirectoryExists $parent)) {
            [void](New-DysonDataRootRecoveryPrivateDirectory $parent)
        }
        [void](Assert-DysonDataRootRecoveryNoReparseAncestors -Path $Destination -AllowMissingLeaf)
        if (Test-DysonDataRootRecoveryPathExists $Destination) {
            Throw-DysonDataRootRecoveryError 'DYSON_CONTROL_DATA_RECOVERY_STORAGE_INVALID'
        }
        $sourceStream = [System.IO.FileStream]::new(
            (ConvertTo-DysonDataRootRecoveryExtendedPath $sourceItem.FullName),
            [System.IO.FileMode]::Open,
            [System.IO.FileAccess]::Read,
            [System.IO.FileShare]::Read
        )
        if ($sourceStream.Length -ne $ExpectedLength) { Throw-DysonDataRootRecoveryError 'DYSON_CONTROL_DATA_RECOVERY_SOURCE_CHANGED' }
        $destinationStream = [System.IO.FileStream]::new(
            (ConvertTo-DysonDataRootRecoveryExtendedPath $Destination),
            [System.IO.FileMode]::CreateNew,
            [System.IO.FileAccess]::Write,
            [System.IO.FileShare]::None
        )
        $sha = [System.Security.Cryptography.SHA256]::Create()
        $buffer = New-Object byte[] 1048576
        $readTotal = 0L
        while (($read = $sourceStream.Read($buffer, 0, $buffer.Length)) -gt 0) {
            $destinationStream.Write($buffer, 0, $read)
            [void]$sha.TransformBlock($buffer, 0, $read, $null, 0)
            $readTotal += $read
        }
        [void]$sha.TransformFinalBlock((New-Object byte[] 0), 0, 0)
        $destinationStream.Flush($true)
        $observed = ([System.BitConverter]::ToString($sha.Hash)).Replace('-', '').ToLowerInvariant()
        if ($readTotal -ne $ExpectedLength -or $observed -cne $ExpectedSha256) {
            Throw-DysonDataRootRecoveryError 'DYSON_CONTROL_DATA_RECOVERY_SOURCE_CHANGED'
        }
        $destinationStream.Dispose()
        $destinationStream = $null
        $destinationItem = Assert-DysonDataRootRecoveryPlainFile $Destination ([int64]::MaxValue) -AllowEmpty
        if ([int64]$destinationItem.Length -ne $ExpectedLength) {
            Throw-DysonDataRootRecoveryError 'DYSON_CONTROL_DATA_RECOVERY_STORAGE_INVALID'
        }
    }
    catch {
        if ($_.Exception.Data.Contains('Code')) { throw }
        Throw-DysonDataRootRecoveryError 'DYSON_CONTROL_DATA_RECOVERY_STORAGE_INVALID'
    }
    finally {
        if ($null -ne $sha) { $sha.Dispose() }
        if ($null -ne $destinationStream) { $destinationStream.Dispose() }
        if ($null -ne $sourceStream) { $sourceStream.Dispose() }
    }
}

function Copy-DysonDataRootRecoveryPayload {
    param([Parameter(Mandatory)][string]$SourceRoot, [Parameter(Mandatory)][string]$PayloadRoot, [Parameter(Mandatory)]$Inventory)

    [void](New-DysonDataRootRecoveryPrivateDirectory $PayloadRoot)
    foreach ($entry in @($Inventory.entries | Where-Object { $_.type -ceq 'directory' -and $_.relativePath -cne '.' } | Sort-Object { $_.relativePath.Length })) {
        [void](New-DysonDataRootRecoveryPrivateDirectory (Join-Path $PayloadRoot $entry.relativePath))
    }
    foreach ($entry in @($Inventory.entries | Where-Object { $_.type -ceq 'file' })) {
        $source = Join-Path $SourceRoot $entry.relativePath
        $destination = Join-Path $PayloadRoot $entry.relativePath
        Copy-DysonDataRootRecoveryFile $source $destination ([int64]$entry.length) ([string]$entry.sha256)
    }
}

function ConvertTo-DysonDataRootRecoveryValidatedManifest {
    param([Parameter(Mandatory)]$Raw)

    Assert-DysonDataRootRecoveryExactProperties $Raw @(
        'protocol', 'schemaVersion', 'bundleId', 'bundleKind', 'dataRootIdentity', 'createdAt',
        'fileCount', 'directoryCount', 'totalBytes', 'inventorySha256', 'entries'
    )
    if ($Raw.protocol -isnot [string] -or [string]$Raw.protocol -cne $script:DysonDataRootRecoveryBundleProtocol -or
        (($Raw.schemaVersion -isnot [int]) -and ($Raw.schemaVersion -isnot [long])) -or [int64]$Raw.schemaVersion -ne 1 -or
        $Raw.bundleKind -isnot [string] -or [string]$Raw.bundleKind -cnotin @('recovery', 'protection-point') -or
        $Raw.dataRootIdentity -isnot [string] -or [string]$Raw.dataRootIdentity -cnotmatch '^sha256:[0-9a-f]{64}$' -or
        $Raw.inventorySha256 -isnot [string] -or [string]$Raw.inventorySha256 -cnotmatch '^[0-9a-f]{64}$' -or
        $Raw.entries -isnot [System.Array]) {
        Throw-DysonDataRootRecoveryError 'DYSON_CONTROL_DATA_RECOVERY_BUNDLE_INVALID'
    }
    $bundleId = Assert-DysonDataRootRecoveryGuid ([string]$Raw.bundleId)
    try {
        $created = [System.DateTimeOffset]::Parse([string]$Raw.createdAt, [Globalization.CultureInfo]::InvariantCulture, [Globalization.DateTimeStyles]::RoundtripKind)
        if ([string]::IsNullOrWhiteSpace([string]$Raw.createdAt)) { throw 'timestamp' }
    }
    catch { Throw-DysonDataRootRecoveryError 'DYSON_CONTROL_DATA_RECOVERY_BUNDLE_INVALID' }
    foreach ($number in @($Raw.fileCount, $Raw.directoryCount, $Raw.totalBytes)) {
        if (($number -isnot [int]) -and ($number -isnot [long])) { Throw-DysonDataRootRecoveryError 'DYSON_CONTROL_DATA_RECOVERY_BUNDLE_INVALID' }
    }
    if ([int64]$Raw.fileCount -lt 0 -or [int64]$Raw.directoryCount -lt 1 -or
        [int64]$Raw.totalBytes -lt 0 -or [int64]$Raw.totalBytes -gt $script:DysonDataRootRecoveryMaximumTotalBytes -or
        $Raw.entries.Count -ne ([int64]$Raw.fileCount + [int64]$Raw.directoryCount) -or
        $Raw.entries.Count -gt $script:DysonDataRootRecoveryMaximumEntryCount) {
        Throw-DysonDataRootRecoveryError 'DYSON_CONTROL_DATA_RECOVERY_BUNDLE_INVALID'
    }
    $entries = New-Object System.Collections.ArrayList
    $seen = @{}
    $observedFiles = 0L
    $observedDirectories = 0L
    $observedBytes = 0L
    $previous = $null
    foreach ($rawEntry in @($Raw.entries)) {
        Assert-DysonDataRootRecoveryExactProperties $rawEntry @('relativePath', 'type', 'length', 'sha256', 'aclIntent')
        if ($rawEntry.relativePath -isnot [string] -or $rawEntry.type -isnot [string] -or
            [string]$rawEntry.type -cnotin @('file', 'directory') -or
            (($rawEntry.length -isnot [int]) -and ($rawEntry.length -isnot [long])) -or
            [int64]$rawEntry.length -lt 0 -or $rawEntry.sha256 -isnot [string] -or
            [string]$rawEntry.sha256 -cnotmatch '^[0-9a-f]{64}$') {
            Throw-DysonDataRootRecoveryError 'DYSON_CONTROL_DATA_RECOVERY_BUNDLE_INVALID'
        }
        $relative = [string]$rawEntry.relativePath
        if ($relative -cne '.') {
            if ([string]::IsNullOrWhiteSpace($relative) -or $relative.Length -gt 2048 -or
                [System.IO.Path]::IsPathRooted($relative) -or $relative.Contains('..') -or
                $relative.IndexOfAny([char[]]@("`r", "`n", [char]0)) -ge 0 -or
                $relative.Contains([System.IO.Path]::AltDirectorySeparatorChar)) {
                Throw-DysonDataRootRecoveryError 'DYSON_CONTROL_DATA_RECOVERY_BUNDLE_INVALID'
            }
            $top = $relative.Split([System.IO.Path]::DirectorySeparatorChar)[0]
            if ($top -cnotin $script:DysonDataRootRecoveryAllowedTopLevel) {
                Throw-DysonDataRootRecoveryError 'DYSON_CONTROL_DATA_RECOVERY_BUNDLE_INVALID'
            }
        }
        if ($seen.ContainsKey($relative.ToLowerInvariant()) -or
            ($null -ne $previous -and [System.StringComparer]::Ordinal.Compare($previous, $relative) -gt 0)) {
            Throw-DysonDataRootRecoveryError 'DYSON_CONTROL_DATA_RECOVERY_BUNDLE_INVALID'
        }
        $seen[$relative.ToLowerInvariant()] = $true
        $previous = $relative
        $acl = ConvertTo-DysonDataRootRecoveryValidatedAclIntent $rawEntry.aclIntent
        if ([string]$rawEntry.type -ceq 'directory') {
            if ([int64]$rawEntry.length -ne 0 -or [string]$rawEntry.sha256 -cne $script:DysonDataRootRecoveryDirectoryDigest) {
                Throw-DysonDataRootRecoveryError 'DYSON_CONTROL_DATA_RECOVERY_BUNDLE_INVALID'
            }
            $observedDirectories++
        }
        else {
            $observedFiles++
            if ($observedBytes -gt ($script:DysonDataRootRecoveryMaximumTotalBytes - [int64]$rawEntry.length)) {
                Throw-DysonDataRootRecoveryError 'DYSON_CONTROL_DATA_RECOVERY_BUNDLE_INVALID'
            }
            $observedBytes += [int64]$rawEntry.length
        }
        [void]$entries.Add([pscustomobject][ordered]@{
            relativePath = $relative
            type = [string]$rawEntry.type
            length = [int64]$rawEntry.length
            sha256 = [string]$rawEntry.sha256
            aclIntent = $acl
        })
    }
    if (-not $seen.ContainsKey('.') -or $observedFiles -ne [int64]$Raw.fileCount -or
        $observedDirectories -ne [int64]$Raw.directoryCount -or $observedBytes -ne [int64]$Raw.totalBytes) {
        Throw-DysonDataRootRecoveryError 'DYSON_CONTROL_DATA_RECOVERY_BUNDLE_INVALID'
    }
    $inventoryJson = ConvertTo-DysonDataRootRecoveryJson ([pscustomobject][ordered]@{ entries = @($entries) })
    if ((Get-DysonDataRootRecoveryTextSha256 $inventoryJson) -cne [string]$Raw.inventorySha256) {
        Throw-DysonDataRootRecoveryError 'DYSON_CONTROL_DATA_RECOVERY_BUNDLE_INVALID'
    }
    return [pscustomobject][ordered]@{
        protocol = $script:DysonDataRootRecoveryBundleProtocol
        schemaVersion = 1
        bundleId = $bundleId
        bundleKind = [string]$Raw.bundleKind
        dataRootIdentity = [string]$Raw.dataRootIdentity
        createdAt = $created.ToUniversalTime().ToString('o')
        fileCount = [int64]$Raw.fileCount
        directoryCount = [int64]$Raw.directoryCount
        totalBytes = [int64]$Raw.totalBytes
        inventorySha256 = [string]$Raw.inventorySha256
        entries = @($entries)
    }
}

function Test-DysonDataRootRecoveryPayloadAgainstManifest {
    param([Parameter(Mandatory)][string]$PayloadRoot, [Parameter(Mandatory)]$Manifest, [switch]$VerifyAcl)

    $root = Assert-DysonDataRootRecoveryPlainDirectory $PayloadRoot
    $expected = @{}
    foreach ($entry in @($Manifest.entries)) { $expected[[string]$entry.relativePath] = $entry }
    $observed = Get-DysonDataRootRecoveryTreeInventory $root
    if ($observed.fileCount -ne $Manifest.fileCount -or $observed.directoryCount -ne $Manifest.directoryCount -or
        $observed.totalBytes -ne $Manifest.totalBytes) {
        Throw-DysonDataRootRecoveryError 'DYSON_CONTROL_DATA_RECOVERY_BUNDLE_INVALID'
    }
    foreach ($entry in @($observed.entries)) {
        if (-not $expected.ContainsKey([string]$entry.relativePath)) { Throw-DysonDataRootRecoveryError 'DYSON_CONTROL_DATA_RECOVERY_BUNDLE_INVALID' }
        $wanted = $expected[[string]$entry.relativePath]
        if ([string]$entry.type -cne [string]$wanted.type -or [int64]$entry.length -ne [int64]$wanted.length -or
            [string]$entry.sha256 -cne [string]$wanted.sha256) {
            Throw-DysonDataRootRecoveryError 'DYSON_CONTROL_DATA_RECOVERY_BUNDLE_INVALID'
        }
        if ($VerifyAcl -and ([string]$entry.aclIntent.descriptorSha256 -cne [string]$wanted.aclIntent.descriptorSha256 -or
            [string]$entry.aclIntent.binaryBase64 -cne [string]$wanted.aclIntent.binaryBase64)) {
            Throw-DysonDataRootRecoveryError 'DYSON_CONTROL_DATA_RECOVERY_ACCESS_CONTROL_FAILED'
        }
    }
    return [pscustomobject][ordered]@{
        valid = $true
        fileCount = [int64]$Manifest.fileCount
        directoryCount = [int64]$Manifest.directoryCount
        totalBytes = [int64]$Manifest.totalBytes
    }
}

function Test-DysonDataRootRecoveryBundleCore {
    param(
        [Parameter(Mandatory)][string]$BundlePath,
        [Parameter(Mandatory)][string]$ExpectedManifestSha256,
        [string]$ExpectedDataRootIdentity,
        [ValidateSet('recovery', 'protection-point')][string]$ExpectedBundleKind = 'recovery'
    )

    $expectedHash = Assert-DysonDataRootRecoveryDigest $ExpectedManifestSha256
    $bundle = Assert-DysonDataRootRecoveryPlainDirectory $BundlePath
    $children = @(Get-DysonDataRootRecoveryChildItems $bundle)
    if ($children.Count -ne 2 -or @($children | Where-Object Name -ceq 'manifest.json').Count -ne 1 -or
        @($children | Where-Object Name -ceq 'payload').Count -ne 1) {
        Throw-DysonDataRootRecoveryError 'DYSON_CONTROL_DATA_RECOVERY_BUNDLE_INVALID'
    }
    $manifestPath = Join-Path $bundle 'manifest.json'
    if ((Get-DysonDataRootRecoveryFileSha256 $manifestPath) -cne $expectedHash) {
        Throw-DysonDataRootRecoveryError 'DYSON_CONTROL_DATA_RECOVERY_BUNDLE_INVALID'
    }
    $manifest = ConvertTo-DysonDataRootRecoveryValidatedManifest (Read-DysonDataRootRecoveryJson $manifestPath $script:DysonDataRootRecoveryMaximumManifestBytes 'DYSON_CONTROL_DATA_RECOVERY_BUNDLE_INVALID')
    if ($manifest.bundleKind -cne $ExpectedBundleKind -or
        (-not [string]::IsNullOrWhiteSpace($ExpectedDataRootIdentity) -and
        [string]$manifest.dataRootIdentity -cne (Assert-DysonDataRootRecoveryIdentity $ExpectedDataRootIdentity))) {
        Throw-DysonDataRootRecoveryError 'DYSON_CONTROL_DATA_RECOVERY_BUNDLE_INVALID'
    }
    [void](Test-DysonDataRootRecoveryPayloadAgainstManifest (Join-Path $bundle 'payload') $manifest)
    return [pscustomobject][ordered]@{
        valid = $true
        manifestSha256 = $expectedHash
        manifest = $manifest
        bundlePath = $bundle
    }
}

function New-DysonDataRootRecoveryManifest {
    param(
        [Parameter(Mandatory)][string]$BundleId,
        [Parameter(Mandatory)][ValidateSet('recovery', 'protection-point')][string]$BundleKind,
        [Parameter(Mandatory)][string]$DataRootIdentity,
        [Parameter(Mandatory)]$Inventory
    )

    return [pscustomobject][ordered]@{
        protocol = $script:DysonDataRootRecoveryBundleProtocol
        schemaVersion = 1
        bundleId = Assert-DysonDataRootRecoveryGuid $BundleId
        bundleKind = $BundleKind
        dataRootIdentity = Assert-DysonDataRootRecoveryIdentity $DataRootIdentity
        createdAt = (Get-Date).ToUniversalTime().ToString('o')
        fileCount = [int64]$Inventory.fileCount
        directoryCount = [int64]$Inventory.directoryCount
        totalBytes = [int64]$Inventory.totalBytes
        inventorySha256 = [string]$Inventory.inventorySha256
        entries = @($Inventory.entries)
    }
}

function Move-DysonDataRootRecoveryDirectory {
    param([Parameter(Mandatory)][string]$Source, [Parameter(Mandatory)][string]$Destination)

    $sourceFull = Assert-DysonDataRootRecoveryPlainDirectory $Source
    $destinationFull = Assert-DysonDataRootRecoveryNoReparseAncestors `
        -Path $Destination -AllowMissingLeaf
    if (Test-DysonDataRootRecoveryPathExists $destinationFull) {
        Throw-DysonDataRootRecoveryError 'DYSON_CONTROL_DATA_RECOVERY_STORAGE_INVALID'
    }
    try {
        [System.IO.Directory]::Move(
            (ConvertTo-DysonDataRootRecoveryExtendedPath $sourceFull),
            (ConvertTo-DysonDataRootRecoveryExtendedPath $destinationFull)
        )
    }
    catch {
        if ($_.Exception.Data.Contains('Code')) { throw }
        Throw-DysonDataRootRecoveryError 'DYSON_CONTROL_DATA_RECOVERY_STORAGE_INVALID'
    }
    if ((Test-DysonDataRootRecoveryPathExists $sourceFull) -or
        -not (Test-DysonDataRootRecoveryDirectoryExists $destinationFull)) {
        Throw-DysonDataRootRecoveryError 'DYSON_CONTROL_DATA_RECOVERY_STORAGE_INVALID'
    }
    [void](Assert-DysonDataRootRecoveryPlainDirectory $destinationFull)
    return $destinationFull
}

function Remove-DysonDataRootRecoveryKnownTree {
    param([Parameter(Mandatory)][string]$Path, [Parameter(Mandatory)][string]$Parent, [Parameter(Mandatory)][string]$LeafPrefix)

    if (-not (Test-DysonDataRootRecoveryPathExists $Path)) { return }
    $full = Assert-DysonDataRootRecoveryPlainDirectory $Path
    $parentFull = Assert-DysonDataRootRecoveryPlainDirectory $Parent
    if (-not (Test-DysonDataRootRecoveryPathWithin $full $parentFull) -or
        (Test-DysonDataRootRecoverySamePath $full $parentFull) -or
        -not ([System.IO.Path]::GetFileName($full)).StartsWith($LeafPrefix, [System.StringComparison]::Ordinal)) {
        Throw-DysonDataRootRecoveryError 'DYSON_CONTROL_DATA_RECOVERY_PATH_INVALID'
    }
    try {
        $files = New-Object System.Collections.ArrayList
        $directories = New-Object System.Collections.ArrayList
        $queue = New-Object System.Collections.Generic.Queue[string]
        $queue.Enqueue($full)
        while ($queue.Count -gt 0) {
            $current = $queue.Dequeue()
            $currentItem = Get-DysonDataRootRecoveryEntryInfo $current
            if (-not $currentItem.PSIsContainer -or
                ($currentItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
                Throw-DysonDataRootRecoveryError 'DYSON_CONTROL_DATA_RECOVERY_PATH_INVALID'
            }
            [void]$directories.Add($currentItem.FullName)
            foreach ($child in @(Get-DysonDataRootRecoveryChildItems $current)) {
                if (($child.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
                    Throw-DysonDataRootRecoveryError 'DYSON_CONTROL_DATA_RECOVERY_PATH_INVALID'
                }
                if ($child.PSIsContainer) { $queue.Enqueue($child.FullName) }
                else { [void]$files.Add($child.FullName) }
            }
        }
        foreach ($file in @($files)) {
            $item = Get-DysonDataRootRecoveryEntryInfo $file
            if ($item.PSIsContainer -or
                ($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
                Throw-DysonDataRootRecoveryError 'DYSON_CONTROL_DATA_RECOVERY_PATH_INVALID'
            }
            $nativeFile = ConvertTo-DysonDataRootRecoveryExtendedPath $item.FullName
            if (($item.Attributes -band [System.IO.FileAttributes]::ReadOnly) -ne 0) {
                [System.IO.File]::SetAttributes($nativeFile, [System.IO.FileAttributes]::Normal)
            }
            [System.IO.File]::Delete($nativeFile)
        }
        foreach ($directory in @($directories | Sort-Object { $_.Length } -Descending)) {
            $item = Get-DysonDataRootRecoveryEntryInfo $directory
            if (-not $item.PSIsContainer -or
                ($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
                Throw-DysonDataRootRecoveryError 'DYSON_CONTROL_DATA_RECOVERY_PATH_INVALID'
            }
            $nativeDirectory = ConvertTo-DysonDataRootRecoveryExtendedPath $item.FullName
            if (($item.Attributes -band [System.IO.FileAttributes]::ReadOnly) -ne 0) {
                [System.IO.File]::SetAttributes($nativeDirectory, [System.IO.FileAttributes]::Normal)
            }
            [System.IO.Directory]::Delete($nativeDirectory, $false)
        }
        if (Test-DysonDataRootRecoveryPathExists $full) {
            Throw-DysonDataRootRecoveryError 'DYSON_CONTROL_DATA_RECOVERY_STORAGE_INVALID'
        }
    }
    catch {
        if ($_.Exception.Data.Contains('Code')) { throw }
        Throw-DysonDataRootRecoveryError 'DYSON_CONTROL_DATA_RECOVERY_STORAGE_INVALID'
    }
}

function New-DysonDataRootRecoveryBundleAtPath {
    param(
        [Parameter(Mandatory)][string]$DataRoot,
        [Parameter(Mandatory)][string]$BundlePath,
        [Parameter(Mandatory)][string]$BundleId,
        [Parameter(Mandatory)][ValidateSet('recovery', 'protection-point')][string]$BundleKind,
        [Parameter(Mandatory)][string]$DataRootIdentity
    )

    $parent = New-DysonDataRootRecoveryPrivateDirectory (Get-DysonDataRootRecoveryParentPath $BundlePath)
    if (Test-DysonDataRootRecoveryPathExists $BundlePath) { Throw-DysonDataRootRecoveryError 'DYSON_CONTROL_DATA_RECOVERY_BUNDLE_CONFLICT' }
    $bundleLeaf = [System.IO.Path]::GetFileName((Get-DysonDataRootRecoveryFullPath $BundlePath))
    $partial = Join-Path $parent ($bundleLeaf + '.partial-' + [guid]::NewGuid().ToString('N'))
    try {
        [void](New-DysonDataRootRecoveryPrivateDirectory $partial -Protect)
        $before = Get-DysonDataRootRecoveryTreeInventory $DataRoot
        $payload = Join-Path $partial 'payload'
        Copy-DysonDataRootRecoveryPayload $DataRoot $payload $before
        $after = Get-DysonDataRootRecoveryTreeInventory $DataRoot
        if ($before.inventorySha256 -cne $after.inventorySha256 -or $before.fileCount -ne $after.fileCount -or
            $before.directoryCount -ne $after.directoryCount -or $before.totalBytes -ne $after.totalBytes) {
            Throw-DysonDataRootRecoveryError 'DYSON_CONTROL_DATA_RECOVERY_SOURCE_CHANGED'
        }
        $manifest = New-DysonDataRootRecoveryManifest $BundleId $BundleKind $DataRootIdentity $before
        $manifestPath = Write-DysonDataRootRecoveryJsonNew (Join-Path $partial 'manifest.json') $manifest $script:DysonDataRootRecoveryMaximumManifestBytes
        $manifestHash = Get-DysonDataRootRecoveryFileSha256 $manifestPath
        [void](Test-DysonDataRootRecoveryBundleCore $partial $manifestHash $DataRootIdentity $BundleKind)
        [void](Assert-DysonDataRootRecoveryNoReparseAncestors -Path $BundlePath -AllowMissingLeaf)
        if (Test-DysonDataRootRecoveryPathExists $BundlePath) {
            Throw-DysonDataRootRecoveryError 'DYSON_CONTROL_DATA_RECOVERY_BUNDLE_CONFLICT'
        }
        [System.IO.Directory]::Move(
            (ConvertTo-DysonDataRootRecoveryExtendedPath $partial),
            (ConvertTo-DysonDataRootRecoveryExtendedPath $BundlePath)
        )
        $published = Test-DysonDataRootRecoveryBundleCore $BundlePath $manifestHash $DataRootIdentity $BundleKind
        return [pscustomobject][ordered]@{
            bundlePath = $BundlePath
            bundleId = [string]$published.manifest.bundleId
            manifestSha256 = $manifestHash
            inventorySha256 = [string]$published.manifest.inventorySha256
            fileCount = [int64]$published.manifest.fileCount
            directoryCount = [int64]$published.manifest.directoryCount
            totalBytes = [int64]$published.manifest.totalBytes
        }
    }
    catch {
        if (Test-DysonDataRootRecoveryDirectoryExists $partial) {
            try { Remove-DysonDataRootRecoveryKnownTree $partial $parent ($bundleLeaf + '.partial-') } catch {}
        }
        if ($_.Exception.Data.Contains('Code')) { throw }
        Throw-DysonDataRootRecoveryError 'DYSON_CONTROL_DATA_RECOVERY_STORAGE_INVALID'
    }
}

function Initialize-DysonDataRootRecoveryState {
    param([Parameter(Mandatory)][string]$RecoveryRoot, [Parameter(Mandatory)][string]$DataRootIdentity)

    $root = New-DysonDataRootRecoveryPrivateDirectory $RecoveryRoot -Protect
    foreach ($name in @('bundles', 'protection-points', 'state')) {
        [void](New-DysonDataRootRecoveryPrivateDirectory (Join-Path $root $name))
    }
    $stateRoot = New-DysonDataRootRecoveryPrivateDirectory `
        (Join-Path (Join-Path $root 'state') (Get-DysonDataRootRecoveryIdentityStem $DataRootIdentity)) -Protect
    $intents = New-DysonDataRootRecoveryPrivateDirectory (Join-Path $stateRoot 'intents')
    $receipts = New-DysonDataRootRecoveryPrivateDirectory (Join-Path $stateRoot 'receipts')
    return [pscustomobject][ordered]@{
        recoveryRoot = $root
        stateRoot = $stateRoot
        intents = $intents
        receipts = $receipts
        audit = Join-Path $stateRoot 'audit.jsonl'
        bundles = Join-Path $root 'bundles'
        protectionPoints = Join-Path $root 'protection-points'
    }
}

function Get-DysonDataRootRecoveryRecordPaths {
    param([Parameter(Mandatory)]$State, [Parameter(Mandatory)][string]$OperationId)
    $id = Assert-DysonDataRootRecoveryGuid $OperationId
    return [pscustomobject][ordered]@{
        intent = Join-Path $State.intents ($id + '.json')
        receipt = Join-Path $State.receipts ($id + '.json')
    }
}

function Get-DysonDataRootRecoveryRequestFingerprint {
    param([Parameter(Mandatory)][string]$Operation, [Parameter(Mandatory)][string]$OperationId, [Parameter(Mandatory)][string]$DataRootIdentity, [Parameter(Mandatory)][string]$BundleId, [string]$ExpectedManifestSha256)
    $binding = [pscustomobject][ordered]@{
        protocol = $script:DysonDataRootRecoveryReceiptProtocol
        schemaVersion = 1
        operation = $Operation
        operationId = $OperationId
        dataRootIdentity = $DataRootIdentity
        bundleId = $BundleId
        expectedManifestSha256 = if ([string]::IsNullOrWhiteSpace($ExpectedManifestSha256)) { $null } else { $ExpectedManifestSha256 }
    }
    return Get-DysonDataRootRecoveryTextSha256 (ConvertTo-DysonDataRootRecoveryJson $binding)
}

function New-DysonDataRootRecoveryIntent {
    param([Parameter(Mandatory)][string]$Operation, [Parameter(Mandatory)][string]$OperationId, [Parameter(Mandatory)][string]$RequestFingerprint, [Parameter(Mandatory)][string]$DataRootIdentity, [Parameter(Mandatory)][string]$BundleId)
    return [pscustomobject][ordered]@{
        protocol = $script:DysonDataRootRecoveryReceiptProtocol
        schemaVersion = 1
        recordKind = 'intent'
        operation = $Operation
        operationId = $OperationId
        requestFingerprint = $RequestFingerprint
        dataRootIdentity = $DataRootIdentity
        bundleId = $BundleId
        createdAt = (Get-Date).ToUniversalTime().ToString('o')
    }
}

function New-DysonDataRootRecoveryReceipt {
    param(
        [Parameter(Mandatory)][string]$Operation,
        [Parameter(Mandatory)][string]$OperationId,
        [Parameter(Mandatory)][string]$RequestFingerprint,
        [Parameter(Mandatory)][string]$DataRootIdentity,
        [Parameter(Mandatory)][string]$BundleId,
        [Parameter(Mandatory)][ValidateSet('succeeded', 'failed')][string]$Outcome,
        [string]$ManifestSha256,
        [string]$ProtectionManifestSha256,
        [string]$ErrorCode
    )
    return [pscustomobject][ordered]@{
        protocol = $script:DysonDataRootRecoveryReceiptProtocol
        schemaVersion = 1
        recordKind = 'receipt'
        operation = $Operation
        operationId = $OperationId
        requestFingerprint = $RequestFingerprint
        dataRootIdentity = $DataRootIdentity
        bundleId = $BundleId
        outcome = $Outcome
        manifestSha256 = if ([string]::IsNullOrWhiteSpace($ManifestSha256)) { $null } else { $ManifestSha256 }
        protectionManifestSha256 = if ([string]::IsNullOrWhiteSpace($ProtectionManifestSha256)) { $null } else { $ProtectionManifestSha256 }
        errorCode = if ([string]::IsNullOrWhiteSpace($ErrorCode)) { $null } else { $ErrorCode }
        completedAt = (Get-Date).ToUniversalTime().ToString('o')
    }
}

function ConvertTo-DysonDataRootRecoveryValidatedIntent {
    param([Parameter(Mandatory)]$Raw)

    Assert-DysonDataRootRecoveryExactProperties $Raw @(
        'protocol', 'schemaVersion', 'recordKind', 'operation', 'operationId', 'requestFingerprint',
        'dataRootIdentity', 'bundleId', 'createdAt'
    ) 'DYSON_CONTROL_DATA_RECOVERY_RECOVERY_REQUIRED'
    if ($Raw.protocol -isnot [string] -or [string]$Raw.protocol -cne $script:DysonDataRootRecoveryReceiptProtocol -or
        (($Raw.schemaVersion -isnot [int]) -and ($Raw.schemaVersion -isnot [long])) -or [int64]$Raw.schemaVersion -ne 1 -or
        $Raw.recordKind -isnot [string] -or [string]$Raw.recordKind -cne 'intent' -or
        $Raw.operation -isnot [string] -or [string]$Raw.operation -cnotin @('create-bundle', 'restore') -or
        $Raw.operationId -isnot [string] -or [string]$Raw.operationId -cnotmatch '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' -or
        $Raw.requestFingerprint -isnot [string] -or [string]$Raw.requestFingerprint -cnotmatch '^[0-9a-f]{64}$' -or
        $Raw.dataRootIdentity -isnot [string] -or [string]$Raw.dataRootIdentity -cnotmatch '^sha256:[0-9a-f]{64}$' -or
        $Raw.bundleId -isnot [string] -or [string]$Raw.bundleId -cnotmatch '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' -or
        $Raw.createdAt -isnot [string]) {
        Throw-DysonDataRootRecoveryError 'DYSON_CONTROL_DATA_RECOVERY_RECOVERY_REQUIRED'
    }
    $parsedOperationId = [guid]::Empty
    $parsedBundleId = [guid]::Empty
    if (-not [guid]::TryParseExact([string]$Raw.operationId, 'D', [ref]$parsedOperationId) -or
        -not [guid]::TryParseExact([string]$Raw.bundleId, 'D', [ref]$parsedBundleId)) {
        Throw-DysonDataRootRecoveryError 'DYSON_CONTROL_DATA_RECOVERY_RECOVERY_REQUIRED'
    }
    try {
        [void][System.DateTimeOffset]::Parse(
            [string]$Raw.createdAt,
            [Globalization.CultureInfo]::InvariantCulture,
            [Globalization.DateTimeStyles]::RoundtripKind
        )
    }
    catch { Throw-DysonDataRootRecoveryError 'DYSON_CONTROL_DATA_RECOVERY_RECOVERY_REQUIRED' }
    return [pscustomobject][ordered]@{
        protocol = $script:DysonDataRootRecoveryReceiptProtocol
        schemaVersion = 1
        recordKind = 'intent'
        operation = [string]$Raw.operation
        operationId = $parsedOperationId.ToString('D').ToLowerInvariant()
        requestFingerprint = [string]$Raw.requestFingerprint
        dataRootIdentity = [string]$Raw.dataRootIdentity
        bundleId = $parsedBundleId.ToString('D').ToLowerInvariant()
        createdAt = [string]$Raw.createdAt
    }
}

function ConvertTo-DysonDataRootRecoveryValidatedReceipt {
    param([Parameter(Mandatory)]$Raw)
    Assert-DysonDataRootRecoveryExactProperties $Raw @(
        'protocol', 'schemaVersion', 'recordKind', 'operation', 'operationId', 'requestFingerprint',
        'dataRootIdentity', 'bundleId', 'outcome', 'manifestSha256', 'protectionManifestSha256',
        'errorCode', 'completedAt'
    ) 'DYSON_CONTROL_DATA_RECOVERY_RECOVERY_REQUIRED'
    if ($Raw.protocol -isnot [string] -or [string]$Raw.protocol -cne $script:DysonDataRootRecoveryReceiptProtocol -or
        (($Raw.schemaVersion -isnot [int]) -and ($Raw.schemaVersion -isnot [long])) -or [int64]$Raw.schemaVersion -ne 1 -or
        $Raw.recordKind -isnot [string] -or [string]$Raw.recordKind -cne 'receipt' -or
        $Raw.operation -isnot [string] -or [string]$Raw.operation -cnotin @('create-bundle', 'restore') -or
        $Raw.operationId -isnot [string] -or [string]$Raw.operationId -cnotmatch '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' -or
        $Raw.requestFingerprint -isnot [string] -or [string]$Raw.requestFingerprint -cnotmatch '^[0-9a-f]{64}$' -or
        $Raw.dataRootIdentity -isnot [string] -or [string]$Raw.dataRootIdentity -cnotmatch '^sha256:[0-9a-f]{64}$' -or
        $Raw.bundleId -isnot [string] -or [string]$Raw.bundleId -cnotmatch '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' -or
        $Raw.outcome -isnot [string] -or [string]$Raw.outcome -cnotin @('succeeded', 'failed') -or
        $Raw.completedAt -isnot [string]) {
        Throw-DysonDataRootRecoveryError 'DYSON_CONTROL_DATA_RECOVERY_RECOVERY_REQUIRED'
    }
    $parsedOperationId = [guid]::Empty
    $parsedBundleId = [guid]::Empty
    if (-not [guid]::TryParseExact([string]$Raw.operationId, 'D', [ref]$parsedOperationId) -or
        -not [guid]::TryParseExact([string]$Raw.bundleId, 'D', [ref]$parsedBundleId)) {
        Throw-DysonDataRootRecoveryError 'DYSON_CONTROL_DATA_RECOVERY_RECOVERY_REQUIRED'
    }
    $operationId = $parsedOperationId.ToString('D').ToLowerInvariant()
    $bundleId = $parsedBundleId.ToString('D').ToLowerInvariant()
    if ([string]$Raw.outcome -ceq 'succeeded') {
        if ([string]$Raw.manifestSha256 -cnotmatch '^[0-9a-f]{64}$' -or $null -ne $Raw.errorCode) {
            Throw-DysonDataRootRecoveryError 'DYSON_CONTROL_DATA_RECOVERY_RECOVERY_REQUIRED'
        }
        if (([string]$Raw.operation -ceq 'restore' -and [string]$Raw.protectionManifestSha256 -cnotmatch '^[0-9a-f]{64}$') -or
            ([string]$Raw.operation -ceq 'create-bundle' -and $null -ne $Raw.protectionManifestSha256)) {
            Throw-DysonDataRootRecoveryError 'DYSON_CONTROL_DATA_RECOVERY_RECOVERY_REQUIRED'
        }
    }
    elseif ($Raw.errorCode -isnot [string] -or [string]$Raw.errorCode -cnotin $script:DysonDataRootRecoveryErrorCodes -or
        $null -ne $Raw.manifestSha256 -or $null -ne $Raw.protectionManifestSha256) {
        Throw-DysonDataRootRecoveryError 'DYSON_CONTROL_DATA_RECOVERY_RECOVERY_REQUIRED'
    }
    try { [void][System.DateTimeOffset]::Parse([string]$Raw.completedAt, [Globalization.CultureInfo]::InvariantCulture, [Globalization.DateTimeStyles]::RoundtripKind) }
    catch { Throw-DysonDataRootRecoveryError 'DYSON_CONTROL_DATA_RECOVERY_RECOVERY_REQUIRED' }
    return [pscustomobject][ordered]@{
        protocol = $script:DysonDataRootRecoveryReceiptProtocol
        schemaVersion = 1
        recordKind = 'receipt'
        operation = [string]$Raw.operation
        operationId = $operationId
        requestFingerprint = [string]$Raw.requestFingerprint
        dataRootIdentity = [string]$Raw.dataRootIdentity
        bundleId = $bundleId
        outcome = [string]$Raw.outcome
        manifestSha256 = $Raw.manifestSha256
        protectionManifestSha256 = $Raw.protectionManifestSha256
        errorCode = $Raw.errorCode
        completedAt = [string]$Raw.completedAt
    }
}

function Assert-DysonDataRootRecoveryIntentReceiptBinding {
    param([Parameter(Mandatory)]$Intent, [Parameter(Mandatory)]$Receipt)

    foreach ($name in @('operation', 'operationId', 'requestFingerprint', 'dataRootIdentity', 'bundleId')) {
        if ([string]$Intent.$name -cne [string]$Receipt.$name) {
            Throw-DysonDataRootRecoveryError 'DYSON_CONTROL_DATA_RECOVERY_RECOVERY_REQUIRED'
        }
    }
}

function Assert-DysonDataRootRecoveryReceiptsEqual {
    param([Parameter(Mandatory)]$Left, [Parameter(Mandatory)]$Right)

    if ((ConvertTo-DysonDataRootRecoveryJson $Left) -cne (ConvertTo-DysonDataRootRecoveryJson $Right)) {
        Throw-DysonDataRootRecoveryError 'DYSON_CONTROL_DATA_RECOVERY_RECOVERY_REQUIRED'
    }
}

function ConvertTo-DysonDataRootRecoveryValidatedAuditRecord {
    param([Parameter(Mandatory)]$Raw)

    Assert-DysonDataRootRecoveryExactProperties $Raw @(
        'protocol', 'schemaVersion', 'operation', 'operationId', 'requestFingerprint',
        'dataRootIdentity', 'bundleId', 'outcome', 'manifestSha256', 'protectionManifestSha256',
        'errorCode', 'completedAt'
    ) 'DYSON_CONTROL_DATA_RECOVERY_RECOVERY_REQUIRED'
    if ($Raw.protocol -isnot [string] -or [string]$Raw.protocol -cne $script:DysonDataRootRecoveryAuditProtocol -or
        (($Raw.schemaVersion -isnot [int]) -and ($Raw.schemaVersion -isnot [long])) -or [int64]$Raw.schemaVersion -ne 1) {
        Throw-DysonDataRootRecoveryError 'DYSON_CONTROL_DATA_RECOVERY_RECOVERY_REQUIRED'
    }
    $asReceipt = [pscustomobject][ordered]@{
        protocol = $script:DysonDataRootRecoveryReceiptProtocol
        schemaVersion = 1
        recordKind = 'receipt'
        operation = $Raw.operation
        operationId = $Raw.operationId
        requestFingerprint = $Raw.requestFingerprint
        dataRootIdentity = $Raw.dataRootIdentity
        bundleId = $Raw.bundleId
        outcome = $Raw.outcome
        manifestSha256 = $Raw.manifestSha256
        protectionManifestSha256 = $Raw.protectionManifestSha256
        errorCode = $Raw.errorCode
        completedAt = $Raw.completedAt
    }
    return ConvertTo-DysonDataRootRecoveryValidatedReceipt $asReceipt
}

function Assert-DysonDataRootRecoveryTerminalFaultPoint {
    param(
        [Parameter(Mandatory)][ValidateSet('AfterReceiptBeforeAudit', 'AfterReceiptBeforeIntentDelete')][string]$Point,
        [switch]$EnableSelfTestFaults
    )

    if ($EnableSelfTestFaults -and $env:DYSON_DATA_ROOT_RECOVERY_SELFTEST -ceq '1' -and
        $env:DYSON_DATA_ROOT_RECOVERY_SELFTEST_FAIL_POINT -ceq $Point) {
        Throw-DysonDataRootRecoveryTerminalReconciliationRequired -FaultPoint $Point
    }
}

function Write-DysonDataRootRecoveryAudit {
    param([Parameter(Mandatory)]$State, [Parameter(Mandatory)]$Receipt)

    $record = [pscustomobject][ordered]@{
        protocol = $script:DysonDataRootRecoveryAuditProtocol
        schemaVersion = 1
        operation = [string]$Receipt.operation
        operationId = [string]$Receipt.operationId
        requestFingerprint = [string]$Receipt.requestFingerprint
        dataRootIdentity = [string]$Receipt.dataRootIdentity
        bundleId = [string]$Receipt.bundleId
        outcome = [string]$Receipt.outcome
        manifestSha256 = $Receipt.manifestSha256
        protectionManifestSha256 = $Receipt.protectionManifestSha256
        errorCode = $Receipt.errorCode
        completedAt = [string]$Receipt.completedAt
    }
    $line = ConvertTo-DysonDataRootRecoveryJson $record
    $partial = $State.audit + '.partial-' + [guid]::NewGuid().ToString('N')
    $backup = $State.audit + '.previous'
    [void](Assert-DysonDataRootRecoveryNoReparseAncestors -Path $partial -AllowMissingLeaf)
    [void](Assert-DysonDataRootRecoveryNoReparseAncestors -Path $backup -AllowMissingLeaf)
    try {
        if (Test-DysonDataRootRecoveryPathExists $backup) {
            Throw-DysonDataRootRecoveryError 'DYSON_CONTROL_DATA_RECOVERY_RECOVERY_REQUIRED'
        }
        $prefix = if (Test-DysonDataRootRecoveryFileExists $State.audit) {
            [void](Assert-DysonDataRootRecoveryPlainFile $State.audit 536870912 -AllowEmpty)
            [System.IO.File]::ReadAllBytes((ConvertTo-DysonDataRootRecoveryExtendedPath $State.audit))
        }
        else { New-Object byte[] 0 }
        $suffix = [System.Text.UTF8Encoding]::new($false).GetBytes($line + [Environment]::NewLine)
        if ([int64]$prefix.Length + [int64]$suffix.Length -gt 536870912) {
            Throw-DysonDataRootRecoveryError 'DYSON_CONTROL_DATA_RECOVERY_STORAGE_INVALID'
        }
        $stream = [System.IO.FileStream]::new(
            (ConvertTo-DysonDataRootRecoveryExtendedPath $partial),
            [System.IO.FileMode]::CreateNew,
            [System.IO.FileAccess]::Write,
            [System.IO.FileShare]::None,
            4096,
            [System.IO.FileOptions]::WriteThrough
        )
        try {
            if ($prefix.Length -gt 0) { $stream.Write($prefix, 0, $prefix.Length) }
            $stream.Write($suffix, 0, $suffix.Length)
            $stream.Flush($true)
        }
        finally { $stream.Dispose() }
        [void](Assert-DysonDataRootRecoveryPlainFile $partial 536870912 -AllowEmpty)
        if (Test-DysonDataRootRecoveryFileExists $State.audit) {
            [System.IO.File]::Replace(
                (ConvertTo-DysonDataRootRecoveryExtendedPath $partial),
                (ConvertTo-DysonDataRootRecoveryExtendedPath $State.audit),
                (ConvertTo-DysonDataRootRecoveryExtendedPath $backup),
                $true
            )
            [System.IO.File]::Delete((ConvertTo-DysonDataRootRecoveryExtendedPath $backup))
        }
        else {
            if (Test-DysonDataRootRecoveryPathExists $State.audit) {
                Throw-DysonDataRootRecoveryError 'DYSON_CONTROL_DATA_RECOVERY_RECOVERY_REQUIRED'
            }
            [System.IO.File]::Move(
                (ConvertTo-DysonDataRootRecoveryExtendedPath $partial),
                (ConvertTo-DysonDataRootRecoveryExtendedPath $State.audit)
            )
        }
        [void](Assert-DysonDataRootRecoveryPlainFile $State.audit 536870912 -AllowEmpty)
    }
    catch {
        if (Test-DysonDataRootRecoveryFileExists $partial) {
            try { [System.IO.File]::Delete((ConvertTo-DysonDataRootRecoveryExtendedPath $partial)) } catch {}
        }
        if ($_.Exception.Data.Contains('Code')) { throw }
        Throw-DysonDataRootRecoveryError 'DYSON_CONTROL_DATA_RECOVERY_STORAGE_INVALID'
    }
}

function Complete-DysonDataRootRecoveryOperation {
    param(
        [Parameter(Mandatory)]$State,
        [Parameter(Mandatory)]$Paths,
        [Parameter(Mandatory)]$Receipt,
        [scriptblock]$BeforeIntentDelete,
        [switch]$EnableSelfTestFaults
    )

    # The receipt is the commit record.  Everything after its durable creation is
    # idempotent reconciliation and must never cause the data mutation to roll back.
    $candidate = ConvertTo-DysonDataRootRecoveryValidatedReceipt $Receipt
    if (Test-DysonDataRootRecoveryPathExists $Paths.receipt) {
        if (-not (Test-DysonDataRootRecoveryFileExists $Paths.receipt)) {
            Throw-DysonDataRootRecoveryError 'DYSON_CONTROL_DATA_RECOVERY_RECOVERY_REQUIRED'
        }
        $durableReceipt = ConvertTo-DysonDataRootRecoveryValidatedReceipt `
            (Read-DysonDataRootRecoveryJson $Paths.receipt $script:DysonDataRootRecoveryMaximumRecordBytes `
                'DYSON_CONTROL_DATA_RECOVERY_RECOVERY_REQUIRED')
        Assert-DysonDataRootRecoveryReceiptsEqual $durableReceipt $candidate
    }
    else {
        [void](Write-DysonDataRootRecoveryJsonNew $Paths.receipt $candidate)
        $durableReceipt = ConvertTo-DysonDataRootRecoveryValidatedReceipt `
            (Read-DysonDataRootRecoveryJson $Paths.receipt $script:DysonDataRootRecoveryMaximumRecordBytes `
                'DYSON_CONTROL_DATA_RECOVERY_RECOVERY_REQUIRED')
        Assert-DysonDataRootRecoveryReceiptsEqual $durableReceipt $candidate
    }

    try {
        $intentWasPresent = Test-DysonDataRootRecoveryPathExists $Paths.intent
        if ($intentWasPresent) {
            if (-not (Test-DysonDataRootRecoveryFileExists $Paths.intent)) {
                Throw-DysonDataRootRecoveryError 'DYSON_CONTROL_DATA_RECOVERY_RECOVERY_REQUIRED'
            }
            $intent = ConvertTo-DysonDataRootRecoveryValidatedIntent `
                (Read-DysonDataRootRecoveryJson $Paths.intent $script:DysonDataRootRecoveryMaximumRecordBytes `
                    'DYSON_CONTROL_DATA_RECOVERY_RECOVERY_REQUIRED')
            Assert-DysonDataRootRecoveryIntentReceiptBinding $intent $durableReceipt
        }

        Assert-DysonDataRootRecoveryTerminalFaultPoint AfterReceiptBeforeAudit `
            -EnableSelfTestFaults:$EnableSelfTestFaults

        $auditExists = $false
        if (Test-DysonDataRootRecoveryPathExists $State.audit) {
            if (-not (Test-DysonDataRootRecoveryFileExists $State.audit)) {
                Throw-DysonDataRootRecoveryError 'DYSON_CONTROL_DATA_RECOVERY_RECOVERY_REQUIRED'
            }
            $seenOperationIds = @{}
            $reader = $null
            try {
                $reader = [System.IO.StreamReader]::new(
                    (ConvertTo-DysonDataRootRecoveryExtendedPath $State.audit),
                    [System.Text.UTF8Encoding]::new($false, $true),
                    $true
                )
                while (-not $reader.EndOfStream) {
                    $line = $reader.ReadLine()
                    if ([string]::IsNullOrWhiteSpace($line) -or
                        [System.Text.UTF8Encoding]::new($false).GetByteCount([string]$line) -gt $script:DysonDataRootRecoveryMaximumRecordBytes) {
                        Throw-DysonDataRootRecoveryError 'DYSON_CONTROL_DATA_RECOVERY_RECOVERY_REQUIRED'
                    }
                    $record = ConvertTo-DysonDataRootRecoveryValidatedAuditRecord ($line | ConvertFrom-Json)
                    if ($seenOperationIds.ContainsKey([string]$record.operationId)) {
                        Throw-DysonDataRootRecoveryError 'DYSON_CONTROL_DATA_RECOVERY_RECOVERY_REQUIRED'
                    }
                    $seenOperationIds[[string]$record.operationId] = $true
                    if ([string]$record.operationId -ceq [string]$durableReceipt.operationId) {
                        Assert-DysonDataRootRecoveryReceiptsEqual $record $durableReceipt
                        $auditExists = $true
                    }
                }
            }
            catch {
                if ($_.Exception.Data.Contains('Code')) { throw }
                Throw-DysonDataRootRecoveryError 'DYSON_CONTROL_DATA_RECOVERY_RECOVERY_REQUIRED'
            }
            finally {
                if ($null -ne $reader) { $reader.Dispose() }
            }
        }
        if (-not $auditExists) { Write-DysonDataRootRecoveryAudit $State $durableReceipt }

        $auditBackup = $State.audit + '.previous'
        if (Test-DysonDataRootRecoveryPathExists $auditBackup) {
            [void](Assert-DysonDataRootRecoveryPlainFile $auditBackup 536870912 -AllowEmpty)
            try {
                [System.IO.File]::Delete((ConvertTo-DysonDataRootRecoveryExtendedPath $auditBackup))
            }
            catch { Throw-DysonDataRootRecoveryError 'DYSON_CONTROL_DATA_RECOVERY_RECOVERY_REQUIRED' }
        }

        if ($null -ne $BeforeIntentDelete) { [void](& $BeforeIntentDelete $durableReceipt) }

        Assert-DysonDataRootRecoveryTerminalFaultPoint AfterReceiptBeforeIntentDelete `
            -EnableSelfTestFaults:$EnableSelfTestFaults

        if ($intentWasPresent) {
            if (-not (Test-DysonDataRootRecoveryFileExists $Paths.intent)) {
                Throw-DysonDataRootRecoveryError 'DYSON_CONTROL_DATA_RECOVERY_RECOVERY_REQUIRED'
            }
            $finalIntent = ConvertTo-DysonDataRootRecoveryValidatedIntent `
                (Read-DysonDataRootRecoveryJson $Paths.intent $script:DysonDataRootRecoveryMaximumRecordBytes `
                    'DYSON_CONTROL_DATA_RECOVERY_RECOVERY_REQUIRED')
            Assert-DysonDataRootRecoveryIntentReceiptBinding $finalIntent $durableReceipt
            if ((ConvertTo-DysonDataRootRecoveryJson $finalIntent) -cne
                (ConvertTo-DysonDataRootRecoveryJson $intent)) {
                Throw-DysonDataRootRecoveryError 'DYSON_CONTROL_DATA_RECOVERY_RECOVERY_REQUIRED'
            }
            try {
                [System.IO.File]::Delete((ConvertTo-DysonDataRootRecoveryExtendedPath $Paths.intent))
            }
            catch { Throw-DysonDataRootRecoveryError 'DYSON_CONTROL_DATA_RECOVERY_RECOVERY_REQUIRED' }
            if (Test-DysonDataRootRecoveryPathExists $Paths.intent) {
                Throw-DysonDataRootRecoveryError 'DYSON_CONTROL_DATA_RECOVERY_RECOVERY_REQUIRED'
            }
        }
    }
    catch {
        if ($_.Exception.Data.Contains('TerminalCommitted')) { throw }
        Throw-DysonDataRootRecoveryTerminalReconciliationRequired
    }
    return $durableReceipt
}

function Assert-DysonDataRootRecoveryLeaseAvailable {
    param([Parameter(Mandatory)][string]$DataRoot)
    try { $status = Get-DysonHostMutationLeaseStatus $DataRoot }
    catch { Throw-DysonDataRootRecoveryError (Get-DysonDataRootRecoveryErrorCode $_.Exception) }
    if ([string]$status.state -cnotin @('empty', 'released')) {
        Throw-DysonDataRootRecoveryError 'DYSON_CONTROL_DATA_RECOVERY_PENDING_MUTATION'
    }
    return $status
}

function Enter-DysonDataRootRecoveryLease {
    param([Parameter(Mandatory)][string]$DataRoot, [Parameter(Mandatory)][string]$Operation, [Parameter(Mandatory)][string]$OperationId)
    try {
        return Enter-DysonHostMutationLease -DataRoot $DataRoot -Owner 'data-root-recovery' -Operation $Operation `
            -RequestId $OperationId -OwnerPid $PID -TimeoutMilliseconds 30000
    }
    catch { Throw-DysonDataRootRecoveryError (Get-DysonDataRootRecoveryErrorCode $_.Exception) }
}

function Exit-DysonDataRootRecoveryLease {
    param([Parameter(Mandatory)]$Lease, [ValidateSet('released', 'abandoned')][string]$State = 'released')
    try { [void](Exit-DysonHostMutationLease $Lease $State) }
    catch { Throw-DysonDataRootRecoveryError 'DYSON_CONTROL_DATA_RECOVERY_STORAGE_INVALID' }
}

function Assert-DysonDataRootRecoveryPreflight {
    param(
        [Parameter(Mandatory)][string]$DataRoot,
        [Parameter(Mandatory)][string]$RecoveryRoot,
        [Parameter(Mandatory)][string]$ControlTaskName,
        [Parameter(Mandatory)][ValidateSet('Windows', 'Shadow')][string]$Backend,
        [string]$ShadowRoot,
        [string]$AllowedTerminalOperationId,
        [switch]$SkipLeaseAvailability
    )

    $roots = Assert-DysonDataRootRecoveryRoots $DataRoot $RecoveryRoot $Backend $ShadowRoot
    $leaseStatus = if ($SkipLeaseAvailability) { $null } else { Assert-DysonDataRootRecoveryLeaseAvailable $roots.dataRoot }
    $identity = if ($null -ne $leaseStatus) { [string]$leaseStatus.dataRootIdentity } else {
        [string](Get-DysonHostMutationLeasePathInfo $roots.dataRoot).DataRootIdentity
    }
    $task = Assert-DysonDataRootRecoveryTaskQuiesced $ControlTaskName $Backend $ShadowRoot
    $pending = Assert-DysonDataRootRecoveryNoPendingMutations $roots.dataRoot $roots.recoveryRoot $identity `
        $AllowedTerminalOperationId
    [void](Get-DysonDataRootRecoveryTreeInventory $roots.dataRoot)
    return [pscustomobject][ordered]@{
        dataRoot = $roots.dataRoot
        recoveryRoot = $roots.recoveryRoot
        dataRootIdentity = $identity
        task = $task
        pending = $pending
    }
}

function Apply-DysonDataRootRecoveryManifestAcl {
    param([Parameter(Mandatory)][string]$Root, [Parameter(Mandatory)]$Manifest)

    $rootEntry = @($Manifest.entries | Where-Object { $_.relativePath -ceq '.' -and $_.type -ceq 'directory' })
    if ($rootEntry.Count -ne 1) { Throw-DysonDataRootRecoveryError 'DYSON_CONTROL_DATA_RECOVERY_BUNDLE_INVALID' }
    Set-DysonDataRootRecoveryAclIntent $Root $rootEntry[0].aclIntent directory
    foreach ($entry in @($Manifest.entries | Where-Object { $_.type -ceq 'directory' -and $_.relativePath -cne '.' } | Sort-Object { $_.relativePath.Length })) {
        Set-DysonDataRootRecoveryAclIntent (Join-Path $Root $entry.relativePath) $entry.aclIntent directory
    }
    foreach ($entry in @($Manifest.entries | Where-Object { $_.type -ceq 'file' })) {
        Set-DysonDataRootRecoveryAclIntent (Join-Path $Root $entry.relativePath) $entry.aclIntent file
    }
}

function New-DysonDataRootRecoveryRestoreStage {
    param([Parameter(Mandatory)]$Bundle, [Parameter(Mandatory)][string]$StagePath)

    [void](New-DysonDataRootRecoveryPrivateDirectory $StagePath)
    Copy-DysonDataRootRecoveryPayload (Join-Path $Bundle.bundlePath 'payload') $StagePath ([pscustomobject][ordered]@{
        entries = @($Bundle.manifest.entries)
    })
    if ($env:DYSON_DATA_ROOT_RECOVERY_SELFTEST_FAIL_POINT -ceq 'DuringStageCopy') {
        Throw-DysonDataRootRecoveryError 'DYSON_CONTROL_DATA_RECOVERY_RESTORE_FAILED'
    }
    Apply-DysonDataRootRecoveryManifestAcl $StagePath $Bundle.manifest
    [void](Test-DysonDataRootRecoveryPayloadAgainstManifest $StagePath $Bundle.manifest -VerifyAcl)
}

function Get-DysonDataRootRecoveryExistingReceipt {
    param(
        [Parameter(Mandatory)]$State,
        [Parameter(Mandatory)]$Paths,
        [Parameter(Mandatory)][string]$Operation,
        [Parameter(Mandatory)][string]$OperationId,
        [Parameter(Mandatory)][string]$RequestFingerprint,
        [Parameter(Mandatory)][string]$DataRootIdentity,
        [Parameter(Mandatory)][string]$BundleId
    )

    if (-not (Test-DysonDataRootRecoveryFileExists $Paths.receipt)) {
        if (Test-DysonDataRootRecoveryPathExists $Paths.intent) {
            Throw-DysonDataRootRecoveryError 'DYSON_CONTROL_DATA_RECOVERY_RECOVERY_REQUIRED'
        }
        return $null
    }
    $receipt = ConvertTo-DysonDataRootRecoveryValidatedReceipt (Read-DysonDataRootRecoveryJson $Paths.receipt)
    if ([string]$receipt.operation -cne $Operation -or [string]$receipt.operationId -cne $OperationId -or
        [string]$receipt.requestFingerprint -cne $RequestFingerprint -or
        [string]$receipt.dataRootIdentity -cne $DataRootIdentity -or [string]$receipt.bundleId -cne $BundleId) {
        Throw-DysonDataRootRecoveryError 'DYSON_CONTROL_DATA_RECOVERY_RECOVERY_REQUIRED'
    }
    return $receipt
}

function Invoke-DysonDataRootRecoveryBundleCreation {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][string]$DataRoot,
        [Parameter(Mandatory)][string]$RecoveryRoot,
        [Parameter(Mandatory)][string]$BundleId,
        [Parameter(Mandatory)][string]$ControlTaskName,
        [Parameter(Mandatory)][ValidateSet('Windows', 'Shadow')][string]$Backend,
        [string]$ShadowRoot,
        [switch]$Preview
    )

    $normalizedId = Assert-DysonDataRootRecoveryGuid $BundleId
    $preflight = Assert-DysonDataRootRecoveryPreflight $DataRoot $RecoveryRoot $ControlTaskName $Backend $ShadowRoot `
        $normalizedId
    if ($Preview) {
        return [pscustomobject][ordered]@{
            protocol = $script:DysonDataRootRecoveryReceiptProtocol
            schemaVersion = 1
            operation = 'create-bundle'
            operationId = $normalizedId
            bundleId = $normalizedId
            dataRootIdentity = [string]$preflight.dataRootIdentity
            wouldMutate = $true
            taskQuiesced = $true
            pendingMutation = $false
        }
    }

    $lease = $null
    $state = $null
    $paths = $null
    $requestFingerprint = Get-DysonDataRootRecoveryRequestFingerprint 'create-bundle' $normalizedId $preflight.dataRootIdentity $normalizedId $null
    try {
        $lease = Enter-DysonDataRootRecoveryLease $preflight.dataRoot 'data-recovery-create' $normalizedId
        $locked = Assert-DysonDataRootRecoveryPreflight $preflight.dataRoot $preflight.recoveryRoot $ControlTaskName $Backend `
            $ShadowRoot $normalizedId -SkipLeaseAvailability
        if ([string]$locked.dataRootIdentity -cne [string]$lease.DataRootIdentity) {
            Throw-DysonDataRootRecoveryError 'DYSON_CONTROL_DATA_RECOVERY_STORAGE_INVALID'
        }
        $state = Initialize-DysonDataRootRecoveryState $locked.recoveryRoot $locked.dataRootIdentity
        $paths = Get-DysonDataRootRecoveryRecordPaths $state $normalizedId
        $existing = Get-DysonDataRootRecoveryExistingReceipt $state $paths 'create-bundle' $normalizedId `
            $requestFingerprint $locked.dataRootIdentity $normalizedId
        if ($null -ne $existing) {
            if ([string]$existing.outcome -cne 'succeeded') { Throw-DysonDataRootRecoveryError ([string]$existing.errorCode) }
            $bundlePath = Join-Path $state.bundles $normalizedId
            $verified = Test-DysonDataRootRecoveryBundleCore $bundlePath ([string]$existing.manifestSha256) $locked.dataRootIdentity recovery
            [void](Complete-DysonDataRootRecoveryOperation $state $paths $existing `
                -EnableSelfTestFaults:($Backend -ceq 'Shadow'))
            return [pscustomobject][ordered]@{
                protocol = $script:DysonDataRootRecoveryReceiptProtocol
                schemaVersion = 1
                operation = 'create-bundle'
                operationId = $normalizedId
                bundleId = $normalizedId
                dataRootIdentity = $locked.dataRootIdentity
                manifestSha256 = [string]$existing.manifestSha256
                inventorySha256 = [string]$verified.manifest.inventorySha256
                fileCount = [int64]$verified.manifest.fileCount
                directoryCount = [int64]$verified.manifest.directoryCount
                totalBytes = [int64]$verified.manifest.totalBytes
                reused = $true
            }
        }
        $intent = New-DysonDataRootRecoveryIntent 'create-bundle' $normalizedId $requestFingerprint $locked.dataRootIdentity $normalizedId
        [void](Write-DysonDataRootRecoveryJsonNew $paths.intent $intent)
        $bundlePath = Join-Path $state.bundles $normalizedId
        $created = New-DysonDataRootRecoveryBundleAtPath $locked.dataRoot $bundlePath $normalizedId recovery $locked.dataRootIdentity
        $receipt = New-DysonDataRootRecoveryReceipt 'create-bundle' $normalizedId $requestFingerprint $locked.dataRootIdentity $normalizedId succeeded $created.manifestSha256 $null $null
        [void](Complete-DysonDataRootRecoveryOperation $state $paths $receipt `
            -EnableSelfTestFaults:($Backend -ceq 'Shadow'))
        return [pscustomobject][ordered]@{
            protocol = $script:DysonDataRootRecoveryReceiptProtocol
            schemaVersion = 1
            operation = 'create-bundle'
            operationId = $normalizedId
            bundleId = $normalizedId
            dataRootIdentity = $locked.dataRootIdentity
            manifestSha256 = [string]$created.manifestSha256
            inventorySha256 = [string]$created.inventorySha256
            fileCount = [int64]$created.fileCount
            directoryCount = [int64]$created.directoryCount
            totalBytes = [int64]$created.totalBytes
            reused = $false
        }
    }
    catch {
        $code = Get-DysonDataRootRecoveryErrorCode $_.Exception
        if ($null -ne $state -and $null -ne $paths -and
            (Test-DysonDataRootRecoveryFileExists $paths.intent) -and
            -not (Test-DysonDataRootRecoveryPathExists $paths.receipt)) {
            try {
                $failure = New-DysonDataRootRecoveryReceipt 'create-bundle' $normalizedId $requestFingerprint $preflight.dataRootIdentity $normalizedId failed $null $null $code
                Complete-DysonDataRootRecoveryOperation $state $paths $failure
            }
            catch {}
        }
        Throw-DysonDataRootRecoveryError $code
    }
    finally {
        if ($null -ne $lease -and $lease.Active) {
            try { Exit-DysonDataRootRecoveryLease $lease released } catch {}
        }
    }
}

function Invoke-DysonDataRootRecoveryRestore {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][string]$DataRoot,
        [Parameter(Mandatory)][string]$RecoveryRoot,
        [Parameter(Mandatory)][string]$BundleId,
        [Parameter(Mandatory)][string]$ExpectedManifestSha256,
        [Parameter(Mandatory)][string]$OperationId,
        [Parameter(Mandatory)][string]$ControlTaskName,
        [Parameter(Mandatory)][ValidateSet('Windows', 'Shadow')][string]$Backend,
        [string]$ShadowRoot,
        [switch]$Preview
    )

    $normalizedBundleId = Assert-DysonDataRootRecoveryGuid $BundleId
    $normalizedOperationId = Assert-DysonDataRootRecoveryGuid $OperationId
    $manifestHash = Assert-DysonDataRootRecoveryDigest $ExpectedManifestSha256
    $preflight = Assert-DysonDataRootRecoveryPreflight $DataRoot $RecoveryRoot $ControlTaskName $Backend $ShadowRoot `
        $normalizedOperationId
    $bundlePath = Join-Path (Join-Path $preflight.recoveryRoot 'bundles') $normalizedBundleId
    $bundle = Test-DysonDataRootRecoveryBundleCore $bundlePath $manifestHash $preflight.dataRootIdentity recovery
    if ([string]$bundle.manifest.bundleId -cne $normalizedBundleId) {
        Throw-DysonDataRootRecoveryError 'DYSON_CONTROL_DATA_RECOVERY_BUNDLE_INVALID'
    }
    if ($Preview) {
        return [pscustomobject][ordered]@{
            protocol = $script:DysonDataRootRecoveryReceiptProtocol
            schemaVersion = 1
            operation = 'restore'
            operationId = $normalizedOperationId
            bundleId = $normalizedBundleId
            dataRootIdentity = [string]$preflight.dataRootIdentity
            manifestSha256 = $manifestHash
            fileCount = [int64]$bundle.manifest.fileCount
            directoryCount = [int64]$bundle.manifest.directoryCount
            totalBytes = [int64]$bundle.manifest.totalBytes
            wouldMutate = $true
            protectionPointWouldBeCreated = $true
            taskQuiesced = $true
            pendingMutation = $false
        }
    }

    $lease = $null
    $state = $null
    $paths = $null
    $oldMoved = $false
    $targetPublished = $false
    $committed = $false
    $protection = $null
    $dataParent = Get-DysonDataRootRecoveryParentPath $preflight.dataRoot
    $stagePath = Join-Path $dataParent ('.dyson-data-restore-stage-' + $normalizedOperationId)
    $supersededPath = Join-Path $dataParent ('.dyson-data-superseded-' + $normalizedOperationId)
    $failedPath = Join-Path $dataParent ('.dyson-data-failed-' + $normalizedOperationId)
    $requestFingerprint = Get-DysonDataRootRecoveryRequestFingerprint 'restore' $normalizedOperationId $preflight.dataRootIdentity $normalizedBundleId $manifestHash
    try {
        $lease = Enter-DysonDataRootRecoveryLease $preflight.dataRoot 'data-recovery-restore' $normalizedOperationId
        $locked = Assert-DysonDataRootRecoveryPreflight $preflight.dataRoot $preflight.recoveryRoot $ControlTaskName $Backend `
            $ShadowRoot $normalizedOperationId -SkipLeaseAvailability
        if ([string]$locked.dataRootIdentity -cne [string]$lease.DataRootIdentity) {
            Throw-DysonDataRootRecoveryError 'DYSON_CONTROL_DATA_RECOVERY_STORAGE_INVALID'
        }
        $bundle = Test-DysonDataRootRecoveryBundleCore $bundlePath $manifestHash $locked.dataRootIdentity recovery
        $state = Initialize-DysonDataRootRecoveryState $locked.recoveryRoot $locked.dataRootIdentity
        $paths = Get-DysonDataRootRecoveryRecordPaths $state $normalizedOperationId
        $terminalCleanup = {
            param($StoredReceipt)
            if (Test-DysonDataRootRecoveryDirectoryExists $supersededPath) {
                Remove-DysonDataRootRecoveryKnownTree $supersededPath $dataParent '.dyson-data-superseded-'
            }
            foreach ($unexpectedTerminalPath in @($stagePath, $failedPath)) {
                if (Test-DysonDataRootRecoveryPathExists $unexpectedTerminalPath) {
                    Throw-DysonDataRootRecoveryError 'DYSON_CONTROL_DATA_RECOVERY_RECOVERY_REQUIRED'
                }
            }
        }
        $existing = Get-DysonDataRootRecoveryExistingReceipt $state $paths restore $normalizedOperationId `
            $requestFingerprint $locked.dataRootIdentity $normalizedBundleId
        if ($null -ne $existing) {
            if ([string]$existing.outcome -cne 'succeeded') { Throw-DysonDataRootRecoveryError ([string]$existing.errorCode) }
            $committed = $true
            [void](Test-DysonDataRootRecoveryPayloadAgainstManifest $locked.dataRoot $bundle.manifest -VerifyAcl)
            $storedProtectionPath = Join-Path $state.protectionPoints $normalizedOperationId
            [void](Test-DysonDataRootRecoveryBundleCore $storedProtectionPath `
                ([string]$existing.protectionManifestSha256) $locked.dataRootIdentity protection-point)
            [void](Complete-DysonDataRootRecoveryOperation $state $paths $existing `
                -BeforeIntentDelete $terminalCleanup -EnableSelfTestFaults:($Backend -ceq 'Shadow'))
            return [pscustomobject][ordered]@{
                protocol = $script:DysonDataRootRecoveryReceiptProtocol
                schemaVersion = 1
                operation = 'restore'
                operationId = $normalizedOperationId
                bundleId = $normalizedBundleId
                dataRootIdentity = $locked.dataRootIdentity
                manifestSha256 = $manifestHash
                protectionManifestSha256 = [string]$existing.protectionManifestSha256
                reused = $true
                rolledBack = $false
            }
        }
        foreach ($path in @($stagePath, $supersededPath, $failedPath)) {
            if (Test-DysonDataRootRecoveryPathExists $path) {
                Throw-DysonDataRootRecoveryError 'DYSON_CONTROL_DATA_RECOVERY_RECOVERY_REQUIRED'
            }
        }
        $intent = New-DysonDataRootRecoveryIntent restore $normalizedOperationId $requestFingerprint $locked.dataRootIdentity $normalizedBundleId
        [void](Write-DysonDataRootRecoveryJsonNew $paths.intent $intent)
        $protectionPath = Join-Path $state.protectionPoints $normalizedOperationId
        $protection = New-DysonDataRootRecoveryBundleAtPath $locked.dataRoot $protectionPath $normalizedOperationId protection-point $locked.dataRootIdentity
        if ($Backend -ceq 'Shadow' -and $env:DYSON_DATA_ROOT_RECOVERY_SELFTEST_FAIL_POINT -ceq 'AfterProtectionPoint') {
            Throw-DysonDataRootRecoveryError 'DYSON_CONTROL_DATA_RECOVERY_RESTORE_FAILED'
        }
        New-DysonDataRootRecoveryRestoreStage $bundle $stagePath
        [void](Move-DysonDataRootRecoveryDirectory $locked.dataRoot $supersededPath)
        $oldMoved = $true
        if ($Backend -ceq 'Shadow' -and $env:DYSON_DATA_ROOT_RECOVERY_SELFTEST_FAIL_POINT -ceq 'AfterSourceRename') {
            Throw-DysonDataRootRecoveryError 'DYSON_CONTROL_DATA_RECOVERY_RESTORE_FAILED'
        }
        [void](Move-DysonDataRootRecoveryDirectory $stagePath $locked.dataRoot)
        $targetPublished = $true
        if ($Backend -ceq 'Shadow' -and $env:DYSON_DATA_ROOT_RECOVERY_SELFTEST_FAIL_POINT -ceq 'AfterTargetPublished') {
            Throw-DysonDataRootRecoveryError 'DYSON_CONTROL_DATA_RECOVERY_RESTORE_FAILED'
        }
        [void](Test-DysonDataRootRecoveryPayloadAgainstManifest $locked.dataRoot $bundle.manifest -VerifyAcl)
        $receipt = New-DysonDataRootRecoveryReceipt restore $normalizedOperationId $requestFingerprint $locked.dataRootIdentity $normalizedBundleId succeeded $manifestHash $protection.manifestSha256 $null
        try {
            [void](Complete-DysonDataRootRecoveryOperation $state $paths $receipt `
                -BeforeIntentDelete $terminalCleanup -EnableSelfTestFaults:($Backend -ceq 'Shadow'))
            $committed = $true
        }
        catch {
            if ($_.Exception.Data.Contains('TerminalCommitted')) { $committed = $true }
            throw
        }
        return [pscustomobject][ordered]@{
            protocol = $script:DysonDataRootRecoveryReceiptProtocol
            schemaVersion = 1
            operation = 'restore'
            operationId = $normalizedOperationId
            bundleId = $normalizedBundleId
            dataRootIdentity = $locked.dataRootIdentity
            manifestSha256 = $manifestHash
            protectionManifestSha256 = [string]$protection.manifestSha256
            reused = $false
            rolledBack = $false
        }
    }
    catch {
        $code = Get-DysonDataRootRecoveryErrorCode $_.Exception
        $rollbackFailed = $false
        if (-not $committed) {
            try {
                if ($oldMoved) {
                    if (Test-DysonDataRootRecoveryDirectoryExists $preflight.dataRoot) {
                        [void](Move-DysonDataRootRecoveryDirectory $preflight.dataRoot $failedPath)
                    }
                    if (-not (Test-DysonDataRootRecoveryDirectoryExists $supersededPath)) {
                        throw 'superseded missing'
                    }
                    [void](Move-DysonDataRootRecoveryDirectory $supersededPath $preflight.dataRoot)
                    if ($null -eq $protection) { throw 'protection missing' }
                    $guard = Test-DysonDataRootRecoveryBundleCore $protection.bundlePath $protection.manifestSha256 $preflight.dataRootIdentity protection-point
                    [void](Test-DysonDataRootRecoveryPayloadAgainstManifest $preflight.dataRoot $guard.manifest -VerifyAcl)
                }
                if (Test-DysonDataRootRecoveryDirectoryExists $stagePath) {
                    Remove-DysonDataRootRecoveryKnownTree $stagePath $dataParent '.dyson-data-restore-stage-'
                }
                if (Test-DysonDataRootRecoveryDirectoryExists $failedPath) {
                    Remove-DysonDataRootRecoveryKnownTree $failedPath $dataParent '.dyson-data-failed-'
                }
            }
            catch { $rollbackFailed = $true }
        }
        if ($rollbackFailed) {
            if ($null -ne $lease -and $lease.Active) {
                try { Exit-DysonDataRootRecoveryLease $lease abandoned } catch {}
            }
            Throw-DysonDataRootRecoveryError 'DYSON_CONTROL_DATA_RECOVERY_ROLLBACK_FAILED'
        }
        if ($null -ne $state -and $null -ne $paths -and
            (Test-DysonDataRootRecoveryFileExists $paths.intent) -and
            -not (Test-DysonDataRootRecoveryPathExists $paths.receipt)) {
            try {
                $failure = New-DysonDataRootRecoveryReceipt restore $normalizedOperationId $requestFingerprint $preflight.dataRootIdentity $normalizedBundleId failed $null $null $code
                Complete-DysonDataRootRecoveryOperation $state $paths $failure
            }
            catch {}
        }
        Throw-DysonDataRootRecoveryError $code
    }
    finally {
        if ($null -ne $lease -and $lease.Active) {
            try { Exit-DysonDataRootRecoveryLease $lease released } catch {}
        }
    }
}
