Set-StrictMode -Version 2.0

$script:DysonHostMutationLeaseProtocol = 'DYSON_HOST_MUTATION_LEASE_V1'
$script:DysonHostMutationLeaseSchemaVersion = 1
$script:DysonHostMutationLeaseMaximumRecordBytes = 4096
$script:DysonHostMutationLeaseRecordProperties = @(
    'protocol',
    'schemaVersion',
    'dataRootIdentity',
    'owner',
    'operation',
    'requestId',
    'host',
    'bootId',
    'pid',
    'ownerPid',
    'processStartedAt',
    'instanceId',
    'tokenSha256',
    'leaseKind',
    'state',
    'acquiredAt',
    'updatedAt',
    'recoveryOfInstanceId',
    'recoveryOfRecordDigest'
)

function New-DysonHostMutationLeaseException {
    param(
        [Parameter(Mandatory)][string]$Code,
        [string]$PriorInstanceId,
        [string]$PriorRecordDigest,
        [string]$PriorState
    )

    $exception = [System.InvalidOperationException]::new($Code)
    $exception.Data['Code'] = $Code
    if (-not [string]::IsNullOrWhiteSpace($PriorInstanceId)) {
        $exception.Data['PriorInstanceId'] = $PriorInstanceId
    }
    if (-not [string]::IsNullOrWhiteSpace($PriorRecordDigest)) {
        $exception.Data['PriorRecordDigest'] = $PriorRecordDigest
    }
    if (-not [string]::IsNullOrWhiteSpace($PriorState)) {
        $exception.Data['PriorState'] = $PriorState
    }
    return $exception
}

function Test-DysonHostMutationLeaseException {
    param([Parameter(Mandatory)][System.Exception]$Exception)

    return $Exception.Data.Contains('Code') -and
        ([string]$Exception.Data['Code'] -match '^DYSON_HOST_MUTATION_LEASE_[A-Z0-9_]+$')
}

function Throw-DysonHostMutationLeaseError {
    param(
        [Parameter(Mandatory)][string]$Code,
        [string]$PriorInstanceId,
        [string]$PriorRecordDigest,
        [string]$PriorState
    )

    throw (New-DysonHostMutationLeaseException -Code $Code -PriorInstanceId $PriorInstanceId `
        -PriorRecordDigest $PriorRecordDigest -PriorState $PriorState)
}

function Initialize-DysonHostMutationLeaseNativeMethods {
    if ($null -ne ('DysonHostMutationLeaseNativeMethodsV1' -as [type])) { return }
    try {
        Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Text;
using Microsoft.Win32.SafeHandles;

public static class DysonHostMutationLeaseNativeMethodsV1
{
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    public static extern SafeFileHandle CreateFile(
        string fileName,
        UInt32 desiredAccess,
        UInt32 shareMode,
        IntPtr securityAttributes,
        UInt32 creationDisposition,
        UInt32 flagsAndAttributes,
        IntPtr templateFile);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    public static extern UInt32 GetFinalPathNameByHandle(
        SafeFileHandle fileHandle,
        StringBuilder filePath,
        UInt32 filePathLength,
        UInt32 flags);

}
'@ -Language CSharp -ErrorAction Stop
    }
    catch {
        Throw-DysonHostMutationLeaseError -Code 'DYSON_HOST_MUTATION_LEASE_PLATFORM_UNAVAILABLE'
    }
}

function ConvertFrom-DysonHostMutationLeaseExtendedPath {
    param([Parameter(Mandatory)][string]$Path)

    if ($Path.StartsWith('\\?\UNC\', [System.StringComparison]::OrdinalIgnoreCase)) {
        return '\\' + $Path.Substring(8)
    }
    if ($Path.StartsWith('\\?\', [System.StringComparison]::OrdinalIgnoreCase)) {
        return $Path.Substring(4)
    }
    return $Path
}

function Get-DysonHostMutationLeaseFinalPathFromHandle {
    param([Parameter(Mandatory)][Microsoft.Win32.SafeHandles.SafeFileHandle]$Handle)

    try {
        Initialize-DysonHostMutationLeaseNativeMethods
        if ($null -eq $Handle -or $Handle.IsInvalid -or $Handle.IsClosed) { throw 'invalid handle' }
        $buffer = [System.Text.StringBuilder]::new(32768)
        $length = [DysonHostMutationLeaseNativeMethodsV1]::GetFinalPathNameByHandle(
            $Handle,
            $buffer,
            [uint32]$buffer.Capacity,
            [uint32]0
        )
        if ($length -lt 1 -or $length -ge $buffer.Capacity) { throw 'final path unavailable' }
        return [System.IO.Path]::GetFullPath(
            (ConvertFrom-DysonHostMutationLeaseExtendedPath -Path $buffer.ToString())
        )
    }
    catch {
        if (Test-DysonHostMutationLeaseException -Exception $_.Exception) { throw $_.Exception }
        Throw-DysonHostMutationLeaseError -Code 'DYSON_HOST_MUTATION_LEASE_PATH_IDENTITY_INVALID'
    }
}

function Get-DysonHostMutationLeaseFinalDirectoryPath {
    param([Parameter(Mandatory)][string]$Path)

    $handle = $null
    try {
        Initialize-DysonHostMutationLeaseNativeMethods
        $handle = [DysonHostMutationLeaseNativeMethodsV1]::CreateFile(
            $Path,
            [uint32]0,
            [uint32]7,
            [IntPtr]::Zero,
            [uint32]3,
            [uint32]0x02000000,
            [IntPtr]::Zero
        )
        if ($null -eq $handle -or $handle.IsInvalid) { throw 'directory handle unavailable' }
        return Get-DysonHostMutationLeaseFinalPathFromHandle -Handle $handle
    }
    catch {
        if (Test-DysonHostMutationLeaseException -Exception $_.Exception) { throw $_.Exception }
        Throw-DysonHostMutationLeaseError -Code 'DYSON_HOST_MUTATION_LEASE_PATH_IDENTITY_INVALID'
    }
    finally { if ($null -ne $handle) { $handle.Dispose() } }
}

function Resolve-DysonHostMutationLeaseCanonicalDirectory {
    param(
        [Parameter(Mandatory)][string]$Path,
        [switch]$AllowMissingLeaf
    )

    try {
        $fullPath = [System.IO.Path]::GetFullPath($Path).TrimEnd('\', '/')
        $root = [System.IO.Path]::GetPathRoot($fullPath)
        if ([string]::IsNullOrWhiteSpace($root)) { throw 'path root unavailable' }
        $current = $root
        $relative = $fullPath.Substring($root.Length).TrimStart('\', '/')
        $segments = @($relative -split '[\\/]' | Where-Object { $_.Length -gt 0 })
        $missingLeaf = $false
        for ($index = 0; $index -lt $segments.Count; $index++) {
            $current = Join-Path $current $segments[$index]
            if (-not (Test-Path -LiteralPath $current)) {
                if ($AllowMissingLeaf -and $index -eq ($segments.Count - 1)) {
                    $missingLeaf = $true
                    break
                }
                throw 'path component unavailable'
            }
            $item = Get-Item -LiteralPath $current -Force -ErrorAction Stop
            if (-not $item.PSIsContainer -or
                ($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint)) {
                throw 'path component redirected'
            }
        }
        if ($missingLeaf) {
            $inputParent = [System.IO.Path]::GetDirectoryName($fullPath)
            $leaf = [System.IO.Path]::GetFileName($fullPath)
            if ([string]::IsNullOrWhiteSpace($inputParent) -or [string]::IsNullOrWhiteSpace($leaf)) {
                throw 'missing leaf identity unavailable'
            }
            $finalParent = (Get-DysonHostMutationLeaseFinalDirectoryPath -Path $inputParent).TrimEnd('\', '/')
            return [System.IO.Path]::GetFullPath((Join-Path $finalParent $leaf))
        }
        return (Get-DysonHostMutationLeaseFinalDirectoryPath -Path $fullPath).TrimEnd('\', '/')
    }
    catch {
        if (Test-DysonHostMutationLeaseException -Exception $_.Exception) { throw $_.Exception }
        Throw-DysonHostMutationLeaseError -Code 'DYSON_HOST_MUTATION_LEASE_PATH_IDENTITY_INVALID'
    }
}

function Assert-DysonHostMutationLeasePlainLockFile {
    param(
        [Parameter(Mandatory)][string]$Path,
        [switch]$AllowMissing
    )

    try {
        if (-not (Test-Path -LiteralPath $Path)) {
            if ($AllowMissing) { return }
            throw 'lock file unavailable'
        }
        $item = Get-Item -LiteralPath $Path -Force -ErrorAction Stop
        if ($item.PSIsContainer -or
            ($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint)) {
            throw 'lock file redirected'
        }
    }
    catch {
        Throw-DysonHostMutationLeaseError -Code 'DYSON_HOST_MUTATION_LEASE_PATH_IDENTITY_INVALID'
    }
}

function Assert-DysonHostMutationLeaseStreamPath {
    param(
        [Parameter(Mandatory)][System.IO.FileStream]$Stream,
        [Parameter(Mandatory)][string]$ExpectedPath
    )

    try {
        Assert-DysonHostMutationLeasePlainLockFile -Path $ExpectedPath
        $actualPath = Get-DysonHostMutationLeaseFinalPathFromHandle -Handle $Stream.SafeFileHandle
        $expectedFullPath = [System.IO.Path]::GetFullPath($ExpectedPath)
        if (-not [string]::Equals(
            $actualPath,
            $expectedFullPath,
            [System.StringComparison]::OrdinalIgnoreCase
        )) {
            throw 'lock handle path mismatch'
        }
    }
    catch {
        if (Test-DysonHostMutationLeaseException -Exception $_.Exception) { throw $_.Exception }
        Throw-DysonHostMutationLeaseError -Code 'DYSON_HOST_MUTATION_LEASE_PATH_IDENTITY_INVALID'
    }
}

function Get-DysonHostMutationLeaseTextSha256 {
    param([Parameter(Mandatory)][AllowEmptyString()][string]$Value)

    $bytes = [System.Text.UTF8Encoding]::new($false).GetBytes($Value)
    $hasher = [System.Security.Cryptography.SHA256]::Create()
    try {
        return ([System.BitConverter]::ToString($hasher.ComputeHash($bytes))).Replace('-', '').ToLowerInvariant()
    }
    finally { $hasher.Dispose() }
}

function Test-DysonHostMutationLeaseFixedText {
    param(
        [Parameter(Mandatory)][string]$Left,
        [Parameter(Mandatory)][string]$Right
    )

    if ($Left.Length -ne $Right.Length) { return $false }
    $difference = 0
    for ($index = 0; $index -lt $Left.Length; $index++) {
        $difference = $difference -bor ([int][char]$Left[$index] -bxor [int][char]$Right[$index])
    }
    return $difference -eq 0
}

function Get-DysonHostMutationLeaseFullPath {
    param([Parameter(Mandatory)][string]$Path)

    try {
        if ([string]::IsNullOrWhiteSpace($Path) -or $Path.Length -gt 32767 -or
            $Path.IndexOf([char]0) -ge 0 -or $Path -match '[\r\n]' -or
            -not [System.IO.Path]::IsPathRooted($Path)) {
            throw 'invalid path'
        }
        return [System.IO.Path]::GetFullPath($Path)
    }
    catch {
        Throw-DysonHostMutationLeaseError -Code 'DYSON_HOST_MUTATION_LEASE_DATA_ROOT_INVALID'
    }
}

function Get-DysonHostMutationLeasePathInfo {
    param([Parameter(Mandatory)][string]$DataRoot)

    try {
        $dataFull = (Get-DysonHostMutationLeaseFullPath -Path $DataRoot).TrimEnd('\', '/')
        $parent = [System.IO.Path]::GetDirectoryName($dataFull)
        if ([string]::IsNullOrWhiteSpace($parent) -or
            -not (Test-Path -LiteralPath $parent -PathType Container)) {
            throw 'invalid data parent'
        }
        $canonicalParent = Resolve-DysonHostMutationLeaseCanonicalDirectory -Path $parent
        $canonicalDataRoot = Resolve-DysonHostMutationLeaseCanonicalDirectory `
            -Path $dataFull -AllowMissingLeaf
        $canonicalDataParent = [System.IO.Path]::GetDirectoryName($canonicalDataRoot)
        if (-not [string]::Equals(
            $canonicalParent.TrimEnd('\', '/'),
            $canonicalDataParent.TrimEnd('\', '/'),
            [System.StringComparison]::OrdinalIgnoreCase
        )) {
            throw 'data root parent identity changed'
        }
        $normalizedIdentity = $canonicalDataRoot.TrimEnd('\', '/').ToUpperInvariant()
        $identityDigest = Get-DysonHostMutationLeaseTextSha256 -Value $normalizedIdentity
        $lockRoot = Join-Path $canonicalDataParent '.dyson-control-deployment-locks'
        return [pscustomobject][ordered]@{
            DataRootIdentity = 'sha256:' + $identityDigest
            CanonicalDataRoot = $canonicalDataRoot
            LockRoot = $lockRoot
            LockPath = Join-Path $lockRoot ($identityDigest + '.lock')
        }
    }
    catch {
        if (Test-DysonHostMutationLeaseException -Exception $_.Exception) {
            if ($_.Exception.Data['Code'] -eq 'DYSON_HOST_MUTATION_LEASE_PATH_IDENTITY_INVALID') {
                Throw-DysonHostMutationLeaseError -Code 'DYSON_HOST_MUTATION_LEASE_DATA_ROOT_INVALID'
            }
            throw $_.Exception
        }
        Throw-DysonHostMutationLeaseError -Code 'DYSON_HOST_MUTATION_LEASE_DATA_ROOT_INVALID'
    }
}

function Get-DysonHostMutationLeasePath {
    param([Parameter(Mandatory)][string]$DataRoot)

    return (Get-DysonHostMutationLeasePathInfo -DataRoot $DataRoot).LockPath
}

function Get-DysonHostMutationDataRootIdentity {
    param([Parameter(Mandatory)][string]$DataRoot)

    return (Get-DysonHostMutationLeasePathInfo -DataRoot $DataRoot).DataRootIdentity
}

function Initialize-DysonHostMutationLeaseRoot {
    param([Parameter(Mandatory)]$PathInfo)

    try {
        if (-not (Test-Path -LiteralPath $PathInfo.LockRoot)) {
            [void][System.IO.Directory]::CreateDirectory($PathInfo.LockRoot)
        }
        $item = Get-Item -LiteralPath $PathInfo.LockRoot -Force -ErrorAction Stop
        if (-not $item.PSIsContainer -or
            ($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint)) {
            throw 'invalid lock root'
        }
        $canonicalLockRoot = Resolve-DysonHostMutationLeaseCanonicalDirectory -Path $PathInfo.LockRoot
        if (-not [string]::Equals(
            $canonicalLockRoot.TrimEnd('\', '/'),
            ([string]$PathInfo.LockRoot).TrimEnd('\', '/'),
            [System.StringComparison]::OrdinalIgnoreCase
        )) {
            throw 'lock root identity changed'
        }
    }
    catch {
        Throw-DysonHostMutationLeaseError -Code 'DYSON_HOST_MUTATION_LEASE_STORAGE_UNAVAILABLE'
    }
}

function Assert-DysonHostMutationLeaseBoundedText {
    param(
        [AllowNull()]$Value,
        [Parameter(Mandatory)][string]$Pattern
    )

    if ($Value -isnot [string] -or ([string]$Value) -notmatch $Pattern) {
        Throw-DysonHostMutationLeaseError -Code 'DYSON_HOST_MUTATION_LEASE_RECORD_INVALID'
    }
}

function Assert-DysonHostMutationLeaseTimestamp {
    param([AllowNull()]$Value)

    Assert-DysonHostMutationLeaseBoundedText -Value $Value `
        -Pattern '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{7}Z$'
    try {
        [void][System.DateTime]::ParseExact(
            [string]$Value,
            'o',
            [System.Globalization.CultureInfo]::InvariantCulture,
            [System.Globalization.DateTimeStyles]::RoundtripKind
        )
    }
    catch {
        Throw-DysonHostMutationLeaseError -Code 'DYSON_HOST_MUTATION_LEASE_RECORD_INVALID'
    }
}

function Assert-DysonHostMutationLeaseRecord {
    param([Parameter(Mandatory)]$Record)

    $actualProperties = @($Record.PSObject.Properties | ForEach-Object { $_.Name })
    if ($actualProperties.Count -ne $script:DysonHostMutationLeaseRecordProperties.Count) {
        Throw-DysonHostMutationLeaseError -Code 'DYSON_HOST_MUTATION_LEASE_RECORD_INVALID'
    }
    for ($index = 0; $index -lt $script:DysonHostMutationLeaseRecordProperties.Count; $index++) {
        if (-not [string]::Equals(
            [string]$actualProperties[$index],
            [string]$script:DysonHostMutationLeaseRecordProperties[$index],
            [System.StringComparison]::Ordinal
        )) {
            Throw-DysonHostMutationLeaseError -Code 'DYSON_HOST_MUTATION_LEASE_RECORD_INVALID'
        }
    }

    Assert-DysonHostMutationLeaseBoundedText -Value $Record.protocol `
        -Pattern '^DYSON_HOST_MUTATION_LEASE_V1$'
    if (($Record.schemaVersion -isnot [int]) -and ($Record.schemaVersion -isnot [long])) {
        Throw-DysonHostMutationLeaseError -Code 'DYSON_HOST_MUTATION_LEASE_RECORD_INVALID'
    }
    if ([int64]$Record.schemaVersion -ne $script:DysonHostMutationLeaseSchemaVersion) {
        Throw-DysonHostMutationLeaseError -Code 'DYSON_HOST_MUTATION_LEASE_RECORD_INVALID'
    }
    Assert-DysonHostMutationLeaseBoundedText -Value $Record.dataRootIdentity `
        -Pattern '^sha256:[0-9a-f]{64}$'
    Assert-DysonHostMutationLeaseBoundedText -Value $Record.owner `
        -Pattern '^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$'
    Assert-DysonHostMutationLeaseBoundedText -Value $Record.operation `
        -Pattern '^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$'
    Assert-DysonHostMutationLeaseBoundedText -Value $Record.requestId `
        -Pattern '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
    Assert-DysonHostMutationLeaseBoundedText -Value $Record.host `
        -Pattern '^sha256:[0-9a-f]{64}$'
    Assert-DysonHostMutationLeaseBoundedText -Value $Record.bootId `
        -Pattern '^sha256:[0-9a-f]{64}$'
    foreach ($property in @('pid', 'ownerPid')) {
        $number = $Record.$property
        if (($number -isnot [int]) -and ($number -isnot [long])) {
            Throw-DysonHostMutationLeaseError -Code 'DYSON_HOST_MUTATION_LEASE_RECORD_INVALID'
        }
        if ([int64]$number -lt 1 -or [int64]$number -gt [int]::MaxValue) {
            Throw-DysonHostMutationLeaseError -Code 'DYSON_HOST_MUTATION_LEASE_RECORD_INVALID'
        }
    }
    Assert-DysonHostMutationLeaseTimestamp -Value $Record.processStartedAt
    Assert-DysonHostMutationLeaseBoundedText -Value $Record.instanceId `
        -Pattern '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    Assert-DysonHostMutationLeaseBoundedText -Value $Record.tokenSha256 `
        -Pattern '^[0-9a-f]{64}$'
    Assert-DysonHostMutationLeaseBoundedText -Value $Record.leaseKind `
        -Pattern '^(mutation|recovery)$'
    Assert-DysonHostMutationLeaseBoundedText -Value $Record.state `
        -Pattern '^(active|released|abandoned|recovery-required)$'
    Assert-DysonHostMutationLeaseTimestamp -Value $Record.acquiredAt
    Assert-DysonHostMutationLeaseTimestamp -Value $Record.updatedAt

    if ($Record.leaseKind -eq 'mutation') {
        if ($null -ne $Record.recoveryOfInstanceId -or $null -ne $Record.recoveryOfRecordDigest) {
            Throw-DysonHostMutationLeaseError -Code 'DYSON_HOST_MUTATION_LEASE_RECORD_INVALID'
        }
    }
    else {
        Assert-DysonHostMutationLeaseBoundedText -Value $Record.recoveryOfInstanceId `
            -Pattern '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
        Assert-DysonHostMutationLeaseBoundedText -Value $Record.recoveryOfRecordDigest `
            -Pattern '^[0-9a-f]{64}$'
    }
}

function ConvertTo-DysonHostMutationLeaseRecordText {
    param([Parameter(Mandatory)]$Record)

    Assert-DysonHostMutationLeaseRecord -Record $Record
    try {
        $text = $Record | ConvertTo-Json -Depth 3 -Compress
        $byteCount = [System.Text.UTF8Encoding]::new($false).GetByteCount($text)
        if ($byteCount -lt 2 -or $byteCount -gt $script:DysonHostMutationLeaseMaximumRecordBytes) {
            throw 'invalid record length'
        }
        return $text
    }
    catch {
        if (Test-DysonHostMutationLeaseException -Exception $_.Exception) { throw $_.Exception }
        Throw-DysonHostMutationLeaseError -Code 'DYSON_HOST_MUTATION_LEASE_RECORD_INVALID'
    }
}

function Read-DysonHostMutationLeaseRecordFromStream {
    param(
        [Parameter(Mandatory)][System.IO.FileStream]$Stream,
        [switch]$AllowEmpty
    )

    try {
        if (-not $Stream.CanRead) { throw 'stream is not readable' }
        $length = [int64]$Stream.Length
        if ($length -eq 0 -and $AllowEmpty) { return $null }
        if ($length -lt 2 -or $length -gt $script:DysonHostMutationLeaseMaximumRecordBytes) {
            throw 'invalid record length'
        }
        [void]$Stream.Seek(0, [System.IO.SeekOrigin]::Begin)
        $bytes = [byte[]]::new([int]$length)
        $offset = 0
        while ($offset -lt $bytes.Length) {
            $read = $Stream.Read($bytes, $offset, $bytes.Length - $offset)
            if ($read -lt 1) { throw 'short record read' }
            $offset += $read
        }
        $text = [System.Text.UTF8Encoding]::new($false, $true).GetString($bytes)
        $record = $text | ConvertFrom-Json -ErrorAction Stop
        Assert-DysonHostMutationLeaseRecord -Record $record
        $canonical = ConvertTo-DysonHostMutationLeaseRecordText -Record $record
        if (-not [string]::Equals($text, $canonical, [System.StringComparison]::Ordinal)) {
            throw 'noncanonical record'
        }
        return [pscustomobject][ordered]@{
            Record = $record
            Text = $text
            Digest = Get-DysonHostMutationLeaseTextSha256 -Value $text
        }
    }
    catch {
        if (Test-DysonHostMutationLeaseException -Exception $_.Exception) { throw $_.Exception }
        Throw-DysonHostMutationLeaseError -Code 'DYSON_HOST_MUTATION_LEASE_RECORD_INVALID'
    }
}

function Write-DysonHostMutationLeaseRecordToStream {
    param(
        [Parameter(Mandatory)][System.IO.FileStream]$Stream,
        [Parameter(Mandatory)]$Record
    )

    try {
        if (-not $Stream.CanWrite) { throw 'stream is not writable' }
        $text = ConvertTo-DysonHostMutationLeaseRecordText -Record $Record
        $bytes = [System.Text.UTF8Encoding]::new($false).GetBytes($text)
        [void]$Stream.Seek(0, [System.IO.SeekOrigin]::Begin)
        $Stream.SetLength(0)
        $Stream.Write($bytes, 0, $bytes.Length)
        $Stream.Flush($true)
        return [pscustomobject][ordered]@{
            Record = $Record
            Text = $text
            Digest = Get-DysonHostMutationLeaseTextSha256 -Value $text
        }
    }
    catch {
        if (Test-DysonHostMutationLeaseException -Exception $_.Exception) { throw $_.Exception }
        Throw-DysonHostMutationLeaseError -Code 'DYSON_HOST_MUTATION_LEASE_RECORD_WRITE_FAILED'
    }
}

function Get-DysonHostMutationLeaseHostIdentity {
    try {
        $machineName = [System.Environment]::MachineName
        if ([string]::IsNullOrWhiteSpace($machineName)) { throw 'host unavailable' }
        return 'sha256:' + (Get-DysonHostMutationLeaseTextSha256 -Value $machineName.ToUpperInvariant())
    }
    catch {
        Throw-DysonHostMutationLeaseError -Code 'DYSON_HOST_MUTATION_LEASE_HOST_IDENTITY_UNAVAILABLE'
    }
}

function Get-DysonHostMutationLeaseBootIdentity {
    param([Parameter(Mandatory)][string]$HostIdentity)

    try {
        $boot = $null
        try {
            $systemProcess = [System.Diagnostics.Process]::GetProcessById(4)
            try {
                if ($null -ne $systemProcess.StartTime) {
                    $boot = $systemProcess.StartTime.ToUniversalTime().ToString('o')
                }
            }
            finally { $systemProcess.Dispose() }
        }
        catch { $boot = $null }
        if ([string]::IsNullOrWhiteSpace($boot)) {
            $operatingSystem = Get-CimInstance -ClassName Win32_OperatingSystem -ErrorAction Stop
            $boot = ([System.DateTime]$operatingSystem.LastBootUpTime).ToUniversalTime().ToString('o')
        }
        if ([string]::IsNullOrWhiteSpace($boot)) { throw 'boot unavailable' }
        return 'sha256:' + (Get-DysonHostMutationLeaseTextSha256 -Value ($HostIdentity + '|' + $boot))
    }
    catch {
        Throw-DysonHostMutationLeaseError -Code 'DYSON_HOST_MUTATION_LEASE_HOST_IDENTITY_UNAVAILABLE'
    }
}

function New-DysonHostMutationLeaseToken {
    $bytes = [byte[]]::new(32)
    $generator = [System.Security.Cryptography.RandomNumberGenerator]::Create()
    try { $generator.GetBytes($bytes) }
    finally { $generator.Dispose() }
    return [Convert]::ToBase64String($bytes).TrimEnd('=').Replace('+', '-').Replace('/', '_')
}

function New-DysonHostMutationLeaseRecord {
    param(
        [Parameter(Mandatory)][string]$DataRootIdentity,
        [Parameter(Mandatory)][string]$Owner,
        [Parameter(Mandatory)][string]$Operation,
        [Parameter(Mandatory)][string]$RequestId,
        [Parameter(Mandatory)][int]$OwnerPid,
        [Parameter(Mandatory)][string]$Token,
        [ValidateSet('mutation', 'recovery')][string]$LeaseKind = 'mutation',
        [string]$RecoveryOfInstanceId,
        [string]$RecoveryOfRecordDigest
    )

    try {
        $hostIdentity = Get-DysonHostMutationLeaseHostIdentity
        $bootIdentity = Get-DysonHostMutationLeaseBootIdentity -HostIdentity $hostIdentity
        $process = [System.Diagnostics.Process]::GetCurrentProcess()
        try { $processStartedAt = $process.StartTime.ToUniversalTime().ToString('o') }
        finally { $process.Dispose() }
        $now = (Get-Date).ToUniversalTime().ToString('o')
        $record = [pscustomobject][ordered]@{
            protocol = $script:DysonHostMutationLeaseProtocol
            schemaVersion = $script:DysonHostMutationLeaseSchemaVersion
            dataRootIdentity = $DataRootIdentity
            owner = $Owner
            operation = $Operation
            requestId = $RequestId
            host = $hostIdentity
            bootId = $bootIdentity
            pid = [int]$PID
            ownerPid = $OwnerPid
            processStartedAt = $processStartedAt
            instanceId = [guid]::NewGuid().ToString('D').ToLowerInvariant()
            tokenSha256 = Get-DysonHostMutationLeaseTextSha256 -Value $Token
            leaseKind = $LeaseKind
            state = 'active'
            acquiredAt = $now
            updatedAt = $now
            recoveryOfInstanceId = if ($LeaseKind -eq 'recovery') { $RecoveryOfInstanceId } else { $null }
            recoveryOfRecordDigest = if ($LeaseKind -eq 'recovery') { $RecoveryOfRecordDigest } else { $null }
        }
        Assert-DysonHostMutationLeaseRecord -Record $record
        return $record
    }
    catch {
        if (Test-DysonHostMutationLeaseException -Exception $_.Exception) { throw $_.Exception }
        Throw-DysonHostMutationLeaseError -Code 'DYSON_HOST_MUTATION_LEASE_ACQUIRE_FAILED'
    }
}

function Copy-DysonHostMutationLeaseRecordWithState {
    param(
        [Parameter(Mandatory)]$Record,
        [ValidateSet('released', 'abandoned', 'recovery-required')][string]$State
    )

    return [pscustomobject][ordered]@{
        protocol = $Record.protocol
        schemaVersion = $Record.schemaVersion
        dataRootIdentity = $Record.dataRootIdentity
        owner = $Record.owner
        operation = $Record.operation
        requestId = $Record.requestId
        host = $Record.host
        bootId = $Record.bootId
        pid = $Record.pid
        ownerPid = $Record.ownerPid
        processStartedAt = $Record.processStartedAt
        instanceId = $Record.instanceId
        tokenSha256 = $Record.tokenSha256
        leaseKind = $Record.leaseKind
        state = $State
        acquiredAt = $Record.acquiredAt
        updatedAt = (Get-Date).ToUniversalTime().ToString('o')
        recoveryOfInstanceId = $Record.recoveryOfInstanceId
        recoveryOfRecordDigest = $Record.recoveryOfRecordDigest
    }
}

function Test-DysonHostMutationLeaseSharingViolation {
    param([Parameter(Mandatory)][System.IO.IOException]$Exception)

    return (($Exception.HResult -band 0xFFFF) -eq 32)
}

function Test-DysonHostMutationLeaseRecoveryBinding {
    param(
        [Parameter(Mandatory)]$Envelope,
        [string]$RecoveryPriorInstanceId,
        [string]$RecoveryPriorRecordDigest
    )

    if ([string]::IsNullOrWhiteSpace($RecoveryPriorInstanceId) -or
        [string]::IsNullOrWhiteSpace($RecoveryPriorRecordDigest)) {
        return $false
    }
    return (Test-DysonHostMutationLeaseFixedText -Left ([string]$Envelope.Record.instanceId) `
        -Right $RecoveryPriorInstanceId) -and
        (Test-DysonHostMutationLeaseFixedText -Left ([string]$Envelope.Digest) `
        -Right $RecoveryPriorRecordDigest)
}

function Enter-DysonHostMutationLease {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][string]$DataRoot,
        [Parameter(Mandatory)][string]$Owner,
        [Parameter(Mandatory)][string]$Operation,
        [Parameter(Mandatory)][string]$RequestId,
        [Parameter(Mandatory)][ValidateRange(1, 2147483647)][int]$OwnerPid,
        [ValidateRange(0, 120000)][int]$TimeoutMilliseconds = 30000,
        [string]$RecoveryPriorInstanceId,
        [string]$RecoveryPriorRecordDigest
    )

    $stream = $null
    try {
        if ($Owner -notmatch '^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$' -or
            $Operation -notmatch '^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$' -or
            $RequestId -notmatch '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$') {
            Throw-DysonHostMutationLeaseError -Code 'DYSON_HOST_MUTATION_LEASE_ARGUMENT_INVALID'
        }
        $hasRecoveryInstance = -not [string]::IsNullOrWhiteSpace($RecoveryPriorInstanceId)
        $hasRecoveryDigest = -not [string]::IsNullOrWhiteSpace($RecoveryPriorRecordDigest)
        if ($hasRecoveryInstance -ne $hasRecoveryDigest -or
            ($hasRecoveryInstance -and $RecoveryPriorInstanceId -notmatch '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$') -or
            ($hasRecoveryDigest -and $RecoveryPriorRecordDigest -notmatch '^[0-9a-f]{64}$')) {
            Throw-DysonHostMutationLeaseError -Code 'DYSON_HOST_MUTATION_LEASE_RECOVERY_BINDING_INVALID'
        }

        $pathInfo = Get-DysonHostMutationLeasePathInfo -DataRoot $DataRoot
        Initialize-DysonHostMutationLeaseRoot -PathInfo $pathInfo
        Assert-DysonHostMutationLeasePlainLockFile -Path $pathInfo.LockPath -AllowMissing
        $stopwatch = [System.Diagnostics.Stopwatch]::StartNew()
        while ($null -eq $stream) {
            try {
                $stream = [System.IO.FileStream]::new(
                    $pathInfo.LockPath,
                    [System.IO.FileMode]::OpenOrCreate,
                    [System.IO.FileAccess]::ReadWrite,
                    [System.IO.FileShare]::Read
                )
                Assert-DysonHostMutationLeaseStreamPath -Stream $stream -ExpectedPath $pathInfo.LockPath
            }
            catch [System.IO.IOException] {
                if (-not (Test-DysonHostMutationLeaseSharingViolation -Exception $_.Exception)) {
                    Throw-DysonHostMutationLeaseError -Code 'DYSON_HOST_MUTATION_LEASE_STORAGE_UNAVAILABLE'
                }
                if ($stopwatch.ElapsedMilliseconds -ge $TimeoutMilliseconds) {
                    Throw-DysonHostMutationLeaseError -Code 'DYSON_HOST_MUTATION_LEASE_BUSY'
                }
                Start-Sleep -Milliseconds 25
            }
        }
        $stopwatch.Stop()

        $prior = Read-DysonHostMutationLeaseRecordFromStream -Stream $stream -AllowEmpty
        $isRecovery = $hasRecoveryInstance
        if ($null -ne $prior) {
            if (-not [string]::Equals(
                [string]$prior.Record.dataRootIdentity,
                [string]$pathInfo.DataRootIdentity,
                [System.StringComparison]::Ordinal
            )) {
                Throw-DysonHostMutationLeaseError -Code 'DYSON_HOST_MUTATION_LEASE_RECORD_INVALID'
            }

            if ($prior.Record.state -eq 'released') {
                if ($isRecovery) {
                    Throw-DysonHostMutationLeaseError -Code 'DYSON_HOST_MUTATION_LEASE_RECOVERY_NOT_REQUIRED'
                }
            }
            elseif ($prior.Record.state -in @('active', 'abandoned', 'recovery-required')) {
                if (-not $isRecovery) {
                    if ($prior.Record.state -eq 'active') {
                        $recoveryRequiredRecord = Copy-DysonHostMutationLeaseRecordWithState `
                            -Record $prior.Record -State 'recovery-required'
                        $prior = Write-DysonHostMutationLeaseRecordToStream -Stream $stream `
                            -Record $recoveryRequiredRecord
                    }
                    Throw-DysonHostMutationLeaseError -Code 'DYSON_HOST_MUTATION_LEASE_RECOVERY_REQUIRED' `
                        -PriorInstanceId ([string]$prior.Record.instanceId) `
                        -PriorRecordDigest ([string]$prior.Digest) `
                        -PriorState ([string]$prior.Record.state)
                }
                if (-not (Test-DysonHostMutationLeaseRecoveryBinding -Envelope $prior `
                    -RecoveryPriorInstanceId $RecoveryPriorInstanceId `
                    -RecoveryPriorRecordDigest $RecoveryPriorRecordDigest)) {
                    Throw-DysonHostMutationLeaseError -Code 'DYSON_HOST_MUTATION_LEASE_RECOVERY_BINDING_INVALID'
                }
            }
            else {
                Throw-DysonHostMutationLeaseError -Code 'DYSON_HOST_MUTATION_LEASE_RECORD_INVALID'
            }
        }
        elseif ($isRecovery) {
            Throw-DysonHostMutationLeaseError -Code 'DYSON_HOST_MUTATION_LEASE_RECOVERY_NOT_REQUIRED'
        }

        $token = New-DysonHostMutationLeaseToken
        $leaseKind = if ($isRecovery) { 'recovery' } else { 'mutation' }
        $record = New-DysonHostMutationLeaseRecord -DataRootIdentity $pathInfo.DataRootIdentity `
            -Owner $Owner -Operation $Operation -RequestId $RequestId -OwnerPid $OwnerPid `
            -Token $token -LeaseKind $leaseKind -RecoveryOfInstanceId $RecoveryPriorInstanceId `
            -RecoveryOfRecordDigest $RecoveryPriorRecordDigest
        [void](Write-DysonHostMutationLeaseRecordToStream -Stream $stream -Record $record)
        return [pscustomobject][ordered]@{
            PSTypeName = 'Dyson.HostMutationLease'
            Stream = $stream
            DataRootIdentity = $pathInfo.DataRootIdentity
            InstanceId = $record.instanceId
            Token = $token
            Record = $record
            Active = $true
        }
    }
    catch {
        if ($null -ne $stream) { $stream.Dispose() }
        if (Test-DysonHostMutationLeaseException -Exception $_.Exception) { throw $_.Exception }
        Throw-DysonHostMutationLeaseError -Code 'DYSON_HOST_MUTATION_LEASE_ACQUIRE_FAILED'
    }
}

function Exit-DysonHostMutationLease {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]$Lease,
        [ValidateSet('released', 'abandoned')][string]$State = 'released'
    )

    $stream = $null
    try {
        if ($null -eq $Lease -or $Lease.PSObject.Properties.Name -notcontains 'Stream' -or
            $Lease.PSObject.Properties.Name -notcontains 'Active' -or -not $Lease.Active) {
            Throw-DysonHostMutationLeaseError -Code 'DYSON_HOST_MUTATION_LEASE_SCOPE_INACTIVE'
        }
        $stream = $Lease.Stream
        if ($stream -isnot [System.IO.FileStream] -or -not $stream.CanRead -or -not $stream.CanWrite) {
            Throw-DysonHostMutationLeaseError -Code 'DYSON_HOST_MUTATION_LEASE_SCOPE_INVALID'
        }
        Assert-DysonHostMutationLeaseStreamPath -Stream $stream -ExpectedPath $stream.Name
        $current = Read-DysonHostMutationLeaseRecordFromStream -Stream $stream
        if ($current.Record.state -ne 'active' -or
            -not (Test-DysonHostMutationLeaseFixedText -Left ([string]$current.Record.instanceId) `
                -Right ([string]$Lease.InstanceId)) -or
            -not (Test-DysonHostMutationLeaseFixedText -Left ([string]$current.Record.tokenSha256) `
                -Right (Get-DysonHostMutationLeaseTextSha256 -Value ([string]$Lease.Token)))) {
            Throw-DysonHostMutationLeaseError -Code 'DYSON_HOST_MUTATION_LEASE_SCOPE_INVALID'
        }
        $finalRecord = Copy-DysonHostMutationLeaseRecordWithState -Record $current.Record -State $State
        [void](Write-DysonHostMutationLeaseRecordToStream -Stream $stream -Record $finalRecord)
        $Lease.Record = $finalRecord
        $Lease.Active = $false
        $Lease.Token = $null
        $stream.Dispose()
        $stream = $null
        return $finalRecord
    }
    catch {
        if ($null -ne $stream) {
            try { $stream.Dispose() } catch {}
        }
        if ($null -ne $Lease -and $Lease.PSObject.Properties.Name -contains 'Active') {
            $Lease.Active = $false
        }
        if ($null -ne $Lease -and $Lease.PSObject.Properties.Name -contains 'Token') {
            $Lease.Token = $null
        }
        if (Test-DysonHostMutationLeaseException -Exception $_.Exception) { throw $_.Exception }
        Throw-DysonHostMutationLeaseError -Code 'DYSON_HOST_MUTATION_LEASE_RELEASE_FAILED'
    }
}

function Get-DysonHostMutationLeaseStatus {
    [CmdletBinding()]
    param([Parameter(Mandatory)][string]$DataRoot)

    $stream = $null
    try {
        $pathInfo = Get-DysonHostMutationLeasePathInfo -DataRoot $DataRoot
        if (-not (Test-Path -LiteralPath $pathInfo.LockPath -PathType Leaf)) {
            return [pscustomobject][ordered]@{
                state = 'empty'
                dataRootIdentity = $pathInfo.DataRootIdentity
                instanceId = $null
                recordDigest = $null
                leaseKind = $null
            }
        }
        Assert-DysonHostMutationLeasePlainLockFile -Path $pathInfo.LockPath
        $stream = [System.IO.FileStream]::new(
            $pathInfo.LockPath,
            [System.IO.FileMode]::Open,
            [System.IO.FileAccess]::Read,
            [System.IO.FileShare]::ReadWrite
        )
        Assert-DysonHostMutationLeaseStreamPath -Stream $stream -ExpectedPath $pathInfo.LockPath
        $envelope = Read-DysonHostMutationLeaseRecordFromStream -Stream $stream
        if (-not [string]::Equals(
            [string]$envelope.Record.dataRootIdentity,
            [string]$pathInfo.DataRootIdentity,
            [System.StringComparison]::Ordinal
        )) {
            Throw-DysonHostMutationLeaseError -Code 'DYSON_HOST_MUTATION_LEASE_RECORD_INVALID'
        }
        return [pscustomobject][ordered]@{
            state = $envelope.Record.state
            dataRootIdentity = $envelope.Record.dataRootIdentity
            instanceId = $envelope.Record.instanceId
            recordDigest = $envelope.Digest
            leaseKind = $envelope.Record.leaseKind
        }
    }
    catch [System.IO.IOException] {
        if (Test-DysonHostMutationLeaseSharingViolation -Exception $_.Exception) {
            Throw-DysonHostMutationLeaseError -Code 'DYSON_HOST_MUTATION_LEASE_BUSY'
        }
        Throw-DysonHostMutationLeaseError -Code 'DYSON_HOST_MUTATION_LEASE_STATUS_FAILED'
    }
    catch {
        if (Test-DysonHostMutationLeaseException -Exception $_.Exception) { throw $_.Exception }
        Throw-DysonHostMutationLeaseError -Code 'DYSON_HOST_MUTATION_LEASE_STATUS_FAILED'
    }
    finally { if ($null -ne $stream) { $stream.Dispose() } }
}

function Assert-DysonHostMutationLeaseBorrow {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][string]$DataRoot,
        [Parameter(Mandatory)][string]$InstanceId,
        [Parameter(Mandatory)][string]$Token
    )

    $readStream = $null
    $writeProbe = $null
    try {
        if ($InstanceId -notmatch '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' -or
            $Token -notmatch '^[A-Za-z0-9_-]{43}$') {
            Throw-DysonHostMutationLeaseError -Code 'DYSON_HOST_MUTATION_LEASE_BORROW_INVALID'
        }
        $pathInfo = Get-DysonHostMutationLeasePathInfo -DataRoot $DataRoot
        Assert-DysonHostMutationLeasePlainLockFile -Path $pathInfo.LockPath
        $readStream = [System.IO.FileStream]::new(
            $pathInfo.LockPath,
            [System.IO.FileMode]::Open,
            [System.IO.FileAccess]::Read,
            [System.IO.FileShare]::ReadWrite
        )
        Assert-DysonHostMutationLeaseStreamPath -Stream $readStream -ExpectedPath $pathInfo.LockPath
        $before = Read-DysonHostMutationLeaseRecordFromStream -Stream $readStream
        $expectedTokenDigest = Get-DysonHostMutationLeaseTextSha256 -Value $Token
        if ($before.Record.state -ne 'active' -or
            -not (Test-DysonHostMutationLeaseFixedText -Left ([string]$before.Record.dataRootIdentity) `
                -Right ([string]$pathInfo.DataRootIdentity)) -or
            -not (Test-DysonHostMutationLeaseFixedText -Left ([string]$before.Record.instanceId) `
                -Right $InstanceId) -or
            -not (Test-DysonHostMutationLeaseFixedText -Left ([string]$before.Record.tokenSha256) `
                -Right $expectedTokenDigest)) {
            Throw-DysonHostMutationLeaseError -Code 'DYSON_HOST_MUTATION_LEASE_BORROW_INVALID'
        }

        $sharingViolationObserved = $false
        try {
            $writeProbe = [System.IO.FileStream]::new(
                $pathInfo.LockPath,
                [System.IO.FileMode]::Open,
                [System.IO.FileAccess]::ReadWrite,
                [System.IO.FileShare]::Read
            )
        }
        catch [System.IO.IOException] {
            if (Test-DysonHostMutationLeaseSharingViolation -Exception $_.Exception) {
                $sharingViolationObserved = $true
            }
            else { throw }
        }
        finally {
            if ($null -ne $writeProbe) { $writeProbe.Dispose() }
            $writeProbe = $null
        }
        if (-not $sharingViolationObserved) {
            Throw-DysonHostMutationLeaseError -Code 'DYSON_HOST_MUTATION_LEASE_BORROW_INVALID'
        }

        $after = Read-DysonHostMutationLeaseRecordFromStream -Stream $readStream
        if (-not (Test-DysonHostMutationLeaseFixedText -Left ([string]$before.Digest) `
            -Right ([string]$after.Digest))) {
            Throw-DysonHostMutationLeaseError -Code 'DYSON_HOST_MUTATION_LEASE_BORROW_INVALID'
        }
        return [pscustomobject][ordered]@{
            protocol = $script:DysonHostMutationLeaseProtocol
            dataRootIdentity = $after.Record.dataRootIdentity
            instanceId = $after.Record.instanceId
            recordDigest = $after.Digest
            leaseKind = $after.Record.leaseKind
            state = $after.Record.state
        }
    }
    catch {
        if (Test-DysonHostMutationLeaseException -Exception $_.Exception) {
            if ($_.Exception.Data['Code'] -eq 'DYSON_HOST_MUTATION_LEASE_BORROW_INVALID') {
                throw $_.Exception
            }
        }
        Throw-DysonHostMutationLeaseError -Code 'DYSON_HOST_MUTATION_LEASE_BORROW_INVALID'
    }
    finally {
        if ($null -ne $writeProbe) { $writeProbe.Dispose() }
        if ($null -ne $readStream) { $readStream.Dispose() }
    }
}
