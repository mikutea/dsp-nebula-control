Set-StrictMode -Version 2.0

$script:DysonGsMigrationProtocol = 'DYSON_GSMANAGER_MIGRATION_V1'
$script:DysonGsSnapshotProtocol = 'DYSON_GSMANAGER_SNAPSHOT_V1'
$script:DysonGsGuardProtocol = 'DYSON_GSMANAGER_RESTORE_GUARD_V1'
$script:DysonGsSchemaVersion = 1
$script:DysonGsHardMaximumFiles = 50000
$script:DysonGsHardMaximumTotalBytes = [int64](8GB)
$script:DysonGsHardMaximumSingleFileBytes = [int64](2GB)
$script:DysonGsSnapshotRelativeRoot = 'migration\snapshots'
$script:DysonGsGuardRelativeRoot = 'migration\restore-guards'

function ConvertTo-DysonGsJsonLine {
    [CmdletBinding()]
    param([Parameter(Mandatory, ValueFromPipeline)]$Value)

    process { return $Value | ConvertTo-Json -Depth 16 -Compress }
}

function Get-DysonGsFullPath {
    param([Parameter(Mandatory)][string]$Path)

    if ([string]::IsNullOrWhiteSpace($Path) -or $Path.IndexOf([char]0) -ge 0) {
        throw 'A migration path is invalid.'
    }
    if ([System.IO.Path]::IsPathRooted($Path)) { return [System.IO.Path]::GetFullPath($Path) }
    return [System.IO.Path]::GetFullPath((Join-Path (Get-Location).ProviderPath $Path))
}

function Test-DysonGsPathWithin {
    param(
        [Parameter(Mandatory)][string]$Candidate,
        [Parameter(Mandatory)][string]$Parent,
        [switch]$AllowEqual
    )

    $candidateFull = (Get-DysonGsFullPath -Path $Candidate).TrimEnd('\', '/')
    $parentFull = (Get-DysonGsFullPath -Path $Parent).TrimEnd('\', '/')
    if ($AllowEqual -and [string]::Equals($candidateFull, $parentFull, [System.StringComparison]::OrdinalIgnoreCase)) {
        return $true
    }
    return $candidateFull.StartsWith(
        $parentFull + [System.IO.Path]::DirectorySeparatorChar,
        [System.StringComparison]::OrdinalIgnoreCase
    )
}

function Assert-DysonGsSafeNonRootPath {
    param(
        [Parameter(Mandatory)][string]$Path,
        [Parameter(Mandatory)][string]$Name
    )

    $full = Get-DysonGsFullPath -Path $Path
    $root = [System.IO.Path]::GetPathRoot($full)
    if ([string]::Equals($full.TrimEnd('\', '/'), $root.TrimEnd('\', '/'), [System.StringComparison]::OrdinalIgnoreCase)) {
        throw "$Name cannot be a filesystem root."
    }
    return $full
}

function Assert-DysonGsNoReparseAncestors {
    param([Parameter(Mandatory)][string]$Path)

    $current = Get-DysonGsFullPath -Path $Path
    while (-not [string]::IsNullOrWhiteSpace($current)) {
        if (Test-Path -LiteralPath $current) {
            $item = Get-Item -LiteralPath $current -Force -ErrorAction Stop
            if ($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) {
                throw 'A migration path is redirected.'
            }
        }
        $parent = [System.IO.Directory]::GetParent($current)
        if ($null -eq $parent) { break }
        $next = $parent.FullName
        if ([string]::Equals($next, $current, [System.StringComparison]::OrdinalIgnoreCase)) { break }
        $current = $next
    }
}

function Assert-DysonGsPlainDirectory {
    param([Parameter(Mandatory)][string]$Path)

    Assert-DysonGsNoReparseAncestors -Path $Path
    $item = Get-Item -LiteralPath $Path -Force -ErrorAction Stop
    if (-not $item.PSIsContainer -or ($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint)) {
        throw 'A migration directory is unavailable or redirected.'
    }
    return $item.FullName
}

function Assert-DysonGsPlainFile {
    param(
        [Parameter(Mandatory)][string]$Path,
        [int64]$MaximumBytes = [int64](16MB)
    )

    Assert-DysonGsNoReparseAncestors -Path $Path
    $item = Get-Item -LiteralPath $Path -Force -ErrorAction Stop
    if ($item.PSIsContainer -or ($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -or
        $item.Length -lt 1 -or $item.Length -gt $MaximumBytes) {
        throw 'A migration file is unavailable, redirected, or outside its size bound.'
    }
    return $item
}

function New-DysonGsPlainDirectory {
    param(
        [Parameter(Mandatory)][string]$Path,
        [switch]$Private
    )

    Assert-DysonGsNoReparseAncestors -Path $Path
    [System.IO.Directory]::CreateDirectory((Get-DysonGsFullPath -Path $Path)) | Out-Null
    $directory = Assert-DysonGsPlainDirectory -Path $Path
    if ($Private) { Protect-DysonGsPrivateDirectory -Path $directory }
    return $directory
}

function Protect-DysonGsPrivateDirectory {
    param([Parameter(Mandatory)][string]$Path)

    $directory = Assert-DysonGsPlainDirectory -Path $Path
    try {
        $identity = [System.Security.Principal.WindowsIdentity]::GetCurrent()
        $security = New-Object System.Security.AccessControl.DirectorySecurity
        $security.SetAccessRuleProtection($true, $false)
        $security.SetOwner($identity.User)
        $inheritance = [System.Security.AccessControl.InheritanceFlags]'ContainerInherit, ObjectInherit'
        $propagation = [System.Security.AccessControl.PropagationFlags]::None
        $allow = [System.Security.AccessControl.AccessControlType]::Allow
        $fullControl = [System.Security.AccessControl.FileSystemRights]::FullControl
        $sidMap = @{}
        foreach ($sid in @(
            $identity.User,
            (New-Object System.Security.Principal.SecurityIdentifier('S-1-5-18')),
            (New-Object System.Security.Principal.SecurityIdentifier('S-1-5-32-544'))
        )) { $sidMap[$sid.Value] = $sid }
        foreach ($sid in @($sidMap.Values)) {
            $rule = New-Object System.Security.AccessControl.FileSystemAccessRule(
                $sid, $fullControl, $inheritance, $propagation, $allow
            )
            [void]$security.AddAccessRule($rule)
        }
        Set-Acl -LiteralPath $directory -AclObject $security -ErrorAction Stop
        $verified = Get-Acl -LiteralPath $directory -ErrorAction Stop
        if (-not $verified.AreAccessRulesProtected) { throw 'private ACL inheritance remained enabled' }
        $allowedSids = @($sidMap.Keys)
        $rules = @($verified.GetAccessRules($true, $false, [System.Security.Principal.SecurityIdentifier]))
        if ($rules.Count -ne $allowedSids.Count) { throw 'private ACL contains an unexpected rule count' }
        foreach ($rule in $rules) {
            if ($rule.IdentityReference.Value -notin $allowedSids -or
                $rule.AccessControlType -ne [System.Security.AccessControl.AccessControlType]::Allow -or
                ($rule.FileSystemRights -band [System.Security.AccessControl.FileSystemRights]::FullControl) -ne
                    [System.Security.AccessControl.FileSystemRights]::FullControl) {
                throw 'private ACL contains an unexpected rule'
            }
        }
    }
    catch { throw 'The private migration directory ACL could not be established.' }
}

function Assert-DysonGsTaskName {
    param([Parameter(Mandatory)][string]$TaskName)

    if ([string]::IsNullOrWhiteSpace($TaskName) -or $TaskName.Length -gt 64 -or
        $TaskName -notmatch '^[A-Za-z0-9][A-Za-z0-9_. -]*$') {
        throw 'The scheduled-task name is outside the bounded task-name grammar.'
    }
}

function Assert-DysonGsLimits {
    param(
        [Parameter(Mandatory)][int]$MaximumFiles,
        [Parameter(Mandatory)][int64]$MaximumTotalBytes,
        [Parameter(Mandatory)][int64]$MaximumSingleFileBytes
    )

    if ($MaximumFiles -lt 1 -or $MaximumFiles -gt $script:DysonGsHardMaximumFiles -or
        $MaximumTotalBytes -lt 1 -or $MaximumTotalBytes -gt $script:DysonGsHardMaximumTotalBytes -or
        $MaximumSingleFileBytes -lt 1 -or $MaximumSingleFileBytes -gt $script:DysonGsHardMaximumSingleFileBytes -or
        $MaximumSingleFileBytes -gt $MaximumTotalBytes) {
        throw 'The migration inventory limits are invalid.'
    }
}

function Resolve-DysonGsLayout {
    param(
        [Parameter(Mandatory)][string]$ProjectRoot,
        [Parameter(Mandatory)][string]$GsManagerRoot,
        [string]$DataRoot,
        [switch]$GsManagerMayBeMissing,
        [switch]$DataRootMayBeMissing
    )

    $project = Assert-DysonGsSafeNonRootPath -Path $ProjectRoot -Name 'ProjectRoot'
    $project = Assert-DysonGsPlainDirectory -Path $project
    $gsm = Assert-DysonGsSafeNonRootPath -Path $GsManagerRoot -Name 'GsManagerRoot'
    if (-not (Test-DysonGsPathWithin -Candidate $gsm -Parent $project)) {
        throw 'GsManagerRoot must be a strict child of ProjectRoot.'
    }
    Assert-DysonGsNoReparseAncestors -Path $gsm
    $gsmExists = Test-Path -LiteralPath $gsm
    if ($gsmExists) { $gsm = Assert-DysonGsPlainDirectory -Path $gsm }
    elseif (-not $GsManagerMayBeMissing) { throw 'GsManagerRoot does not exist.' }
    else {
        $parent = [System.IO.Path]::GetDirectoryName($gsm)
        if ([string]::IsNullOrWhiteSpace($parent) -or -not (Test-DysonGsPathWithin -Candidate $parent -Parent $project -AllowEqual)) {
            throw 'GsManagerRoot has no bounded existing parent.'
        }
        [void](Assert-DysonGsPlainDirectory -Path $parent)
    }

    $relative = $gsm.Substring($project.TrimEnd('\', '/').Length).TrimStart('\', '/').Replace('\', '/')
    if ([string]::IsNullOrWhiteSpace($relative) -or $relative -match '(^|/)\.\.(/|$)') {
        throw 'GsManagerRoot cannot be represented as a bounded project-relative path.'
    }

    $resolvedData = $null
    if (-not [string]::IsNullOrWhiteSpace($DataRoot)) {
        $resolvedData = Assert-DysonGsSafeNonRootPath -Path $DataRoot -Name 'DataRoot'
        Assert-DysonGsNoReparseAncestors -Path $resolvedData
        if (Test-Path -LiteralPath $resolvedData) { $resolvedData = Assert-DysonGsPlainDirectory -Path $resolvedData }
        elseif (-not $DataRootMayBeMissing) { throw 'DataRoot does not exist.' }
        $migrationRoot = Join-Path $resolvedData 'migration'
        if ((Test-DysonGsPathWithin -Candidate $migrationRoot -Parent $gsm -AllowEqual) -or
            (Test-DysonGsPathWithin -Candidate $gsm -Parent $migrationRoot -AllowEqual)) {
            throw 'GsManagerRoot cannot overlap the fixed migration data tree.'
        }
    }

    return [pscustomobject][ordered]@{
        projectRoot = $project
        gsManagerRoot = $gsm
        gsManagerExists = [bool]$gsmExists
        gsManagerRelativeRoot = $relative
        dataRoot = $resolvedData
    }
}

function Get-DysonGsSha256 {
    param([Parameter(Mandatory)][string]$Path)

    $item = Get-Item -LiteralPath $Path -Force -ErrorAction Stop
    if ($item.PSIsContainer -or ($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint)) {
        throw 'A migration file changed type while it was being hashed.'
    }
    $stream = [System.IO.File]::Open($item.FullName, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::Read)
    $hasher = [System.Security.Cryptography.SHA256]::Create()
    try { return ([System.BitConverter]::ToString($hasher.ComputeHash($stream))).Replace('-', '').ToLowerInvariant() }
    finally { $hasher.Dispose(); $stream.Dispose() }
}

function Get-DysonGsTextSha256 {
    param([Parameter(Mandatory)][AllowEmptyString()][string]$Value)

    $bytes = [System.Text.UTF8Encoding]::new($false).GetBytes($Value)
    $hasher = [System.Security.Cryptography.SHA256]::Create()
    try { return ([System.BitConverter]::ToString($hasher.ComputeHash($bytes))).Replace('-', '').ToLowerInvariant() }
    finally { $hasher.Dispose() }
}

function Get-DysonGsRelativePath {
    param(
        [Parameter(Mandatory)][string]$Root,
        [Parameter(Mandatory)][string]$Path
    )

    $rootFull = (Get-DysonGsFullPath -Path $Root).TrimEnd('\', '/')
    $pathFull = Get-DysonGsFullPath -Path $Path
    if (-not (Test-DysonGsPathWithin -Candidate $pathFull -Parent $rootFull)) {
        throw 'A migration inventory item escaped its root.'
    }
    $relative = $pathFull.Substring($rootFull.Length).TrimStart('\', '/').Replace('\', '/')
    if ([string]::IsNullOrWhiteSpace($relative) -or [System.IO.Path]::IsPathRooted($relative) -or
        $relative -match '(^|/)\.\.?(/|$)' -or $relative -match '[:\x00-\x1f"<>|]') {
        throw 'A migration inventory path is invalid.'
    }
    return $relative
}

function Get-DysonGsEntriesDigest {
    param([Parameter(Mandatory)]$Entries)

    $lines = @($Entries | ForEach-Object { '{0}|{1}|{2}' -f [string]$_.path, [int64]$_.length, [string]$_.sha256 })
    return Get-DysonGsTextSha256 -Value ([string]::Join("`n", $lines))
}

function Get-DysonGsTreeInventory {
    param(
        [Parameter(Mandatory)][string]$Root,
        [int]$MaximumFiles = 10000,
        [int64]$MaximumTotalBytes = [int64](2GB),
        [int64]$MaximumSingleFileBytes = [int64](512MB),
        [string]$PathPrefix = '',
        [string[]]$ExcludeRelativePath = @(),
        [switch]$RejectSaveFiles
    )

    Assert-DysonGsLimits -MaximumFiles $MaximumFiles -MaximumTotalBytes $MaximumTotalBytes `
        -MaximumSingleFileBytes $MaximumSingleFileBytes
    $rootFull = Assert-DysonGsPlainDirectory -Path $Root
    $excluded = @{}
    foreach ($excludedPath in @($ExcludeRelativePath)) { $excluded[$excludedPath.Replace('\', '/')] = $true }
    $pending = New-Object 'System.Collections.Generic.Stack[string]'
    $entries = New-Object 'System.Collections.Generic.List[object]'
    $pending.Push($rootFull)
    $totalBytes = [int64]0
    while ($pending.Count -gt 0) {
        $directory = $pending.Pop()
        foreach ($item in @(Get-ChildItem -LiteralPath $directory -Force -ErrorAction Stop)) {
            if ($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) {
                throw 'Migration source and snapshot trees cannot contain reparse points.'
            }
            if (-not (Test-DysonGsPathWithin -Candidate $item.FullName -Parent $rootFull)) {
                throw 'A migration tree item escaped its root.'
            }
            if ($item.PSIsContainer) { $pending.Push($item.FullName); continue }
            if (-not ($item -is [System.IO.FileInfo])) { throw 'A migration tree contains an unsupported filesystem entry.' }
            $relative = Get-DysonGsRelativePath -Root $rootFull -Path $item.FullName
            if ($excluded.ContainsKey($relative)) { continue }
            if ($RejectSaveFiles -and $item.Extension.ToLowerInvariant() -in @('.dsv', '.server')) {
                throw 'Save-pair files are forbidden in GSManager migration snapshots.'
            }
            if ($item.Length -gt $MaximumSingleFileBytes) { throw 'A migration file exceeds the single-file size limit.' }
            if ($entries.Count + 1 -gt $MaximumFiles) { throw 'The migration tree exceeds the file-count limit.' }
            $totalBytes += [int64]$item.Length
            if ($totalBytes -gt $MaximumTotalBytes) { throw 'The migration tree exceeds the total-byte limit.' }
            $entryPath = if ([string]::IsNullOrWhiteSpace($PathPrefix)) { $relative } else { $PathPrefix.TrimEnd('/') + '/' + $relative }
            $entries.Add([pscustomobject][ordered]@{
                path = $entryPath
                length = [int64]$item.Length
                sha256 = Get-DysonGsSha256 -Path $item.FullName
            })
        }
    }
    $ordered = @($entries | Sort-Object -Property @{ Expression = { $_.path } } -CaseSensitive)
    return [pscustomobject][ordered]@{
        entries = $ordered
        fileCount = [int]$ordered.Count
        totalBytes = [int64]$totalBytes
        treeSha256 = Get-DysonGsEntriesDigest -Entries $ordered
    }
}

function Test-DysonGsEntryListsEqual {
    param([Parameter(Mandatory)]$Left, [Parameter(Mandatory)]$Right)

    $leftEntries = @($Left)
    $rightEntries = @($Right)
    if ($leftEntries.Count -ne $rightEntries.Count) { return $false }
    for ($index = 0; $index -lt $leftEntries.Count; $index++) {
        if (-not [string]::Equals([string]$leftEntries[$index].path, [string]$rightEntries[$index].path, [System.StringComparison]::Ordinal) -or
            [int64]$leftEntries[$index].length -ne [int64]$rightEntries[$index].length -or
            -not [string]::Equals([string]$leftEntries[$index].sha256, [string]$rightEntries[$index].sha256, [System.StringComparison]::Ordinal)) {
            return $false
        }
    }
    return $true
}

function Copy-DysonGsInventory {
    param(
        [Parameter(Mandatory)][string]$SourceRoot,
        [Parameter(Mandatory)][string]$DestinationRoot,
        [Parameter(Mandatory)]$Inventory
    )

    $source = Assert-DysonGsPlainDirectory -Path $SourceRoot
    $destination = Assert-DysonGsPlainDirectory -Path $DestinationRoot
    foreach ($entry in @($Inventory.entries)) {
        $relative = [string]$entry.path
        $sourcePath = Get-DysonGsFullPath -Path (Join-Path $source $relative.Replace('/', '\'))
        $destinationPath = Get-DysonGsFullPath -Path (Join-Path $destination $relative.Replace('/', '\'))
        if (-not (Test-DysonGsPathWithin -Candidate $sourcePath -Parent $source) -or
            -not (Test-DysonGsPathWithin -Candidate $destinationPath -Parent $destination)) {
            throw 'A migration copy path escaped its bounded tree.'
        }
        $sourceItem = Get-Item -LiteralPath $sourcePath -Force -ErrorAction Stop
        if ($sourceItem.PSIsContainer -or ($sourceItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -or
            $sourceItem.Extension.ToLowerInvariant() -in @('.dsv', '.server')) {
            throw 'A migration source file changed type or became forbidden during copy.'
        }
        [void](New-DysonGsPlainDirectory -Path ([System.IO.Path]::GetDirectoryName($destinationPath)))
        [System.IO.File]::Copy($sourceItem.FullName, $destinationPath, $false)
    }
}

function Write-DysonGsUtf8Json {
    param(
        [Parameter(Mandatory)][string]$Path,
        [Parameter(Mandatory)]$Value
    )

    $json = $Value | ConvertTo-Json -Depth 16 -Compress
    [System.IO.File]::WriteAllText((Get-DysonGsFullPath -Path $Path), $json, [System.Text.UTF8Encoding]::new($false))
}

function Read-DysonGsJsonBounded {
    param(
        [Parameter(Mandatory)][string]$Path,
        [int64]$MaximumBytes = [int64](16MB)
    )

    $item = Assert-DysonGsPlainFile -Path $Path -MaximumBytes $MaximumBytes
    try { return [System.IO.File]::ReadAllText($item.FullName, [System.Text.Encoding]::UTF8) | ConvertFrom-Json -ErrorAction Stop }
    catch { throw 'Private migration metadata is malformed.' }
}

function Assert-DysonGsExactProperties {
    param(
        [Parameter(Mandatory)]$Value,
        [Parameter(Mandatory)][string[]]$Expected,
        [Parameter(Mandatory)][string]$Name
    )

    if ($null -eq $Value) { throw "$Name is missing or malformed." }
    $actual = [string[]]@($Value.PSObject.Properties | ForEach-Object { $_.Name })
    $expectedSorted = [string[]]@($Expected)
    [System.Array]::Sort($actual, [System.StringComparer]::Ordinal)
    [System.Array]::Sort($expectedSorted, [System.StringComparer]::Ordinal)
    if ([string]::Join("`n", $actual) -cne [string]::Join("`n", $expectedSorted)) {
        throw "$Name contains missing or unknown fields."
    }
}

function Assert-DysonGsJsonString {
    param(
        [Parameter(Mandatory)]$Value,
        [Parameter(Mandatory)][string]$Name
    )
    if (-not ($Value -is [string])) { throw "$Name has an invalid JSON type." }
}

function Assert-DysonGsJsonBoolean {
    param(
        [Parameter(Mandatory)]$Value,
        [Parameter(Mandatory)][string]$Name
    )
    if (-not ($Value -is [bool])) { throw "$Name has an invalid JSON type." }
}

function Assert-DysonGsJsonInteger {
    param(
        [Parameter(Mandatory)]$Value,
        [Parameter(Mandatory)][string]$Name,
        [int64]$Minimum = [int64]::MinValue,
        [int64]$Maximum = [int64]::MaxValue
    )
    $integerTypes = @([byte], [sbyte], [int16], [uint16], [int32], [uint32], [int64])
    $isInteger = $false
    foreach ($type in $integerTypes) { if ($Value -is $type) { $isInteger = $true; break } }
    if (-not $isInteger -or [int64]$Value -lt $Minimum -or [int64]$Value -gt $Maximum) {
        throw "$Name has an invalid JSON integer value."
    }
}

function Get-DysonGsProjectBindingSha256 {
    param([Parameter(Mandatory)][string]$ProjectRoot)

    $normalized = (Get-DysonGsFullPath -Path $ProjectRoot).TrimEnd('\', '/').ToUpperInvariant()
    return Get-DysonGsTextSha256 -Value $normalized
}

function Normalize-DysonGsSnapshotId {
    param([Parameter(Mandatory)][string]$SnapshotId)

    $parsed = [guid]::Empty
    if (-not [guid]::TryParseExact($SnapshotId, 'D', [ref]$parsed)) { throw 'The migration snapshot ID is invalid.' }
    return $parsed.ToString('D').ToLowerInvariant()
}

function Normalize-DysonGsDigest {
    param(
        [Parameter(Mandatory)][string]$Digest,
        [Parameter(Mandatory)][string]$Name
    )

    if ($Digest -notmatch '^[0-9A-Fa-f]{64}$') { throw "$Name is invalid." }
    return $Digest.ToLowerInvariant()
}

function Test-DysonGsProtectionPointBinding {
    param(
        [Parameter(Mandatory)][string]$ProjectRoot,
        [Parameter(Mandatory)][string]$ProtectionPointId,
        [Parameter(Mandatory)][string]$ManifestSha256
    )

    if ($ProtectionPointId -notmatch '^save:(?<id>[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12})$') {
        throw 'The paired-save protection-point ID is invalid.'
    }
    $requestId = Normalize-DysonGsSnapshotId -SnapshotId $Matches['id']
    $normalizedId = 'save:' + $requestId
    $digest = Normalize-DysonGsDigest -Digest $ManifestSha256 -Name 'The paired-save protection manifest digest'
    $project = Assert-DysonGsPlainDirectory -Path $ProjectRoot
    $protectionRoot = Join-Path $project ('backups\saves\tx-' + $requestId)
    if (-not (Test-DysonGsPathWithin -Candidate $protectionRoot -Parent $project)) {
        throw 'The paired-save protection point escaped ProjectRoot.'
    }
    [void](Assert-DysonGsPlainDirectory -Path $protectionRoot)
    $manifestPath = Join-Path $protectionRoot 'manifest.json'
    $manifestItem = Assert-DysonGsPlainFile -Path $manifestPath -MaximumBytes 16384
    if ((Get-DysonGsSha256 -Path $manifestItem.FullName) -cne $digest) {
        throw 'The paired-save protection manifest digest does not match.'
    }
    $manifest = Read-DysonGsJsonBounded -Path $manifestItem.FullName -MaximumBytes 16384
    Assert-DysonGsExactProperties -Value $manifest -Expected @('protocol', 'schemaVersion', 'requestId', 'createdAt', 'saveName', 'files') `
        -Name 'Paired-save protection manifest'
    Assert-DysonGsJsonString -Value $manifest.protocol -Name 'Paired-save protection protocol'
    Assert-DysonGsJsonInteger -Value $manifest.schemaVersion -Name 'Paired-save protection schema version' -Minimum 1 -Maximum 1
    Assert-DysonGsJsonString -Value $manifest.requestId -Name 'Paired-save protection request ID'
    Assert-DysonGsJsonString -Value $manifest.createdAt -Name 'Paired-save protection creation time'
    Assert-DysonGsJsonString -Value $manifest.saveName -Name 'Paired-save protection save name'
    if ([string]$manifest.protocol -cne 'DYSON_CONTROL_PROTECTION_V1' -or [int]$manifest.schemaVersion -ne 1 -or
        [string]$manifest.requestId -cne $requestId -or [string]::IsNullOrWhiteSpace([string]$manifest.saveName)) {
        throw 'The paired-save protection manifest identity is invalid.'
    }
    $files = @($manifest.files)
    if ($files.Count -ne 2) { throw 'The paired-save protection manifest is not a complete pair.' }
    $extensions = @{}
    foreach ($file in $files) {
        Assert-DysonGsExactProperties -Value $file -Expected @('name', 'bytes', 'sha256') -Name 'Paired-save protection file entry'
        $name = [string]$file.name
        Assert-DysonGsJsonString -Value $file.name -Name 'Paired-save protection file name'
        Assert-DysonGsJsonInteger -Value $file.bytes -Name 'Paired-save protection file length' -Minimum 0
        Assert-DysonGsJsonString -Value $file.sha256 -Name 'Paired-save protection file digest'
        $extension = [System.IO.Path]::GetExtension($name).ToLowerInvariant()
        if ($extension -notin @('.dsv', '.server') -or $extensions.ContainsKey($extension) -or
            -not [string]::Equals($name, ([string]$manifest.saveName + $extension), [System.StringComparison]::Ordinal) -or
            [int64]$file.bytes -lt 0 -or [string]$file.sha256 -notmatch '^[0-9a-f]{64}$') {
            throw 'The paired-save protection manifest is not a valid pair.'
        }
        $extensions[$extension] = $true
    }
    return [pscustomobject][ordered]@{ protectionPointId = $normalizedId; manifestSha256 = $digest }
}

function Test-DysonGsTaskNotFoundError {
    param([Parameter(Mandatory)]$ErrorRecord)

    return $ErrorRecord.CategoryInfo.Category -eq [System.Management.Automation.ErrorCategory]::ObjectNotFound -or
        $ErrorRecord.Exception -is [System.Management.Automation.ItemNotFoundException] -or
        [string]$ErrorRecord.FullyQualifiedErrorId -match 'NoMatchingMSFT_ScheduledTask|HRESULT 0x80070002'
}

function Get-DysonGsTaskCapture {
    param(
        [Parameter(Mandatory)][string]$TaskName,
        [switch]$IncludeXml
    )

    Assert-DysonGsTaskName -TaskName $TaskName
    $requiredCommands = @('Get-ScheduledTask')
    if ($IncludeXml) { $requiredCommands += 'Export-ScheduledTask' }
    foreach ($commandName in $requiredCommands) {
        if (-not (Get-Command -Name $commandName -ErrorAction SilentlyContinue)) {
            throw 'Task Scheduler inspection is unavailable.'
        }
    }
    try { $task = Get-ScheduledTask -TaskName $TaskName -ErrorAction Stop }
    catch {
        if (Test-DysonGsTaskNotFoundError -ErrorRecord $_) {
            return [pscustomobject][ordered]@{ taskName = $TaskName; present = $false; enabled = $false; state = 'Absent'; xml = $null }
        }
        throw 'The scheduled task could not be inspected.'
    }
    if ($null -eq $task -or @($task).Count -ne 1) { throw 'The scheduled task identity is ambiguous.' }
    $xml = $null
    if ($IncludeXml) {
        try { $xml = [string](Export-ScheduledTask -TaskName $TaskName -ErrorAction Stop) }
        catch { throw 'The scheduled task XML could not be captured.' }
        if ([string]::IsNullOrWhiteSpace($xml) -or $xml.Length -gt 4MB) { throw 'The scheduled task XML is empty or exceeds its bound.' }
    }
    $enabled = $true
    try { if ($null -ne $task.Settings -and $null -ne $task.Settings.Enabled) { $enabled = [bool]$task.Settings.Enabled } }
    catch { throw 'The scheduled task enabled state could not be inspected.' }
    $state = [string]$task.State
    if ([string]::IsNullOrWhiteSpace($state) -or $state.Length -gt 32 -or $state -match '[\r\n]') {
        throw 'The scheduled task state is invalid.'
    }
    return [pscustomobject][ordered]@{ taskName = $TaskName; present = $true; enabled = $enabled; state = $state; xml = $xml }
}

function Write-DysonGsTaskCapture {
    param(
        [Parameter(Mandatory)]$Capture,
        [Parameter(Mandatory)][string]$Directory
    )

    $taskRoot = New-DysonGsPlainDirectory -Path $Directory
    Write-DysonGsUtf8Json -Path (Join-Path $taskRoot 'state.json') -Value ([ordered]@{
        taskName = [string]$Capture.taskName
        present = [bool]$Capture.present
        enabled = [bool]$Capture.enabled
        state = [string]$Capture.state
    })
    if ([bool]$Capture.present) {
        [System.IO.File]::WriteAllText((Join-Path $taskRoot 'task.xml'), [string]$Capture.xml, [System.Text.Encoding]::Unicode)
    }
}

function Read-DysonGsTaskCapture {
    param([Parameter(Mandatory)][string]$Directory)

    $taskRoot = Assert-DysonGsPlainDirectory -Path $Directory
    $state = Read-DysonGsJsonBounded -Path (Join-Path $taskRoot 'state.json') -MaximumBytes 8192
    Assert-DysonGsExactProperties -Value $state -Expected @('taskName', 'present', 'enabled', 'state') -Name 'Task snapshot state'
    Assert-DysonGsTaskName -TaskName ([string]$state.taskName)
    Assert-DysonGsJsonString -Value $state.taskName -Name 'Task snapshot name'
    Assert-DysonGsJsonBoolean -Value $state.present -Name 'Task snapshot presence'
    Assert-DysonGsJsonBoolean -Value $state.enabled -Name 'Task snapshot enabled state'
    Assert-DysonGsJsonString -Value $state.state -Name 'Task snapshot runtime state'
    if ([string]::IsNullOrWhiteSpace([string]$state.state) -or ([string]$state.state).Length -gt 32 -or [string]$state.state -match '[\r\n]') {
        throw 'Task snapshot state is invalid.'
    }
    $xmlPath = Join-Path $taskRoot 'task.xml'
    $xml = $null
    if ([bool]$state.present) {
        $xmlItem = Assert-DysonGsPlainFile -Path $xmlPath -MaximumBytes (4MB)
        $xml = [System.IO.File]::ReadAllText($xmlItem.FullName)
        if ([string]::IsNullOrWhiteSpace($xml)) { throw 'Task snapshot XML is empty.' }
    }
    elseif (Test-Path -LiteralPath $xmlPath) { throw 'An absent task snapshot unexpectedly contains task XML.' }
    return [pscustomobject][ordered]@{
        taskName = [string]$state.taskName
        present = [bool]$state.present
        enabled = [bool]$state.enabled
        state = [string]$state.state
        xml = $xml
    }
}

function Set-DysonGsTaskCapture {
    param(
        [Parameter(Mandatory)]$Capture,
        [Parameter(Mandatory)][string]$TaskName
    )

    Assert-DysonGsTaskName -TaskName $TaskName
    if (-not [string]::Equals([string]$Capture.taskName, $TaskName, [System.StringComparison]::Ordinal)) {
        throw 'The task snapshot is bound to a different task name.'
    }
    foreach ($commandName in @('Register-ScheduledTask', 'Unregister-ScheduledTask', 'Enable-ScheduledTask', 'Disable-ScheduledTask')) {
        if (-not (Get-Command -Name $commandName -ErrorAction SilentlyContinue)) { throw 'Task Scheduler restore is unavailable.' }
    }
    if (-not [bool]$Capture.present) {
        try { Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction Stop | Out-Null }
        catch { if (-not (Test-DysonGsTaskNotFoundError -ErrorRecord $_)) { throw 'The scheduled task could not be restored to absent.' } }
        return
    }
    try {
        Register-ScheduledTask -TaskName $TaskName -Xml ([string]$Capture.xml) -Force -ErrorAction Stop | Out-Null
        if ([bool]$Capture.enabled) { Enable-ScheduledTask -TaskName $TaskName -ErrorAction Stop | Out-Null }
        else { Disable-ScheduledTask -TaskName $TaskName -ErrorAction Stop | Out-Null }
    }
    catch { throw 'The scheduled task could not be restored from its private snapshot.' }
}

function Test-DysonGsTaskCapturesEqual {
    param(
        [Parameter(Mandatory)]$Left,
        [Parameter(Mandatory)]$Right
    )

    if (-not [string]::Equals([string]$Left.taskName, [string]$Right.taskName, [System.StringComparison]::Ordinal) -or
        [bool]$Left.present -ne [bool]$Right.present -or [bool]$Left.enabled -ne [bool]$Right.enabled -or
        -not [string]::Equals([string]$Left.state, [string]$Right.state, [System.StringComparison]::Ordinal)) {
        return $false
    }
    if (-not [bool]$Left.present) { return $true }
    return (Get-DysonGsTextSha256 -Value ([string]$Left.xml)) -ceq
        (Get-DysonGsTextSha256 -Value ([string]$Right.xml))
}

function Get-DysonGsSnapshotRoot {
    param(
        [Parameter(Mandatory)][string]$DataRoot,
        [Parameter(Mandatory)][string]$SnapshotId
    )

    $id = Normalize-DysonGsSnapshotId -SnapshotId $SnapshotId
    $data = Assert-DysonGsSafeNonRootPath -Path $DataRoot -Name 'DataRoot'
    $root = Join-Path (Join-Path $data $script:DysonGsSnapshotRelativeRoot) $id
    if (-not (Test-DysonGsPathWithin -Candidate $root -Parent $data)) { throw 'The snapshot path escaped DataRoot.' }
    return $root
}

function Get-DysonGsPayloadInventory {
    param(
        [Parameter(Mandatory)][string]$Root,
        [Parameter(Mandatory)][int]$MaximumFiles,
        [Parameter(Mandatory)][int64]$MaximumTotalBytes,
        [Parameter(Mandatory)][int64]$MaximumSingleFileBytes,
        [string[]]$ExcludeRelativePath = @()
    )

    return Get-DysonGsTreeInventory -Root $Root -MaximumFiles $MaximumFiles -MaximumTotalBytes $MaximumTotalBytes `
        -MaximumSingleFileBytes $MaximumSingleFileBytes -ExcludeRelativePath $ExcludeRelativePath -RejectSaveFiles
}

function Test-DysonGsSnapshotCore {
    param(
        [Parameter(Mandatory)][string]$SnapshotRoot,
        [Parameter(Mandatory)][string]$ExpectedSnapshotId,
        [string]$ExpectedManifestSha256
    )

    $snapshot = Assert-DysonGsPlainDirectory -Path $SnapshotRoot
    $id = Normalize-DysonGsSnapshotId -SnapshotId $ExpectedSnapshotId
    $manifestPath = Join-Path $snapshot 'manifest.json'
    $manifestItem = Assert-DysonGsPlainFile -Path $manifestPath -MaximumBytes (16MB)
    $manifestSha256 = Get-DysonGsSha256 -Path $manifestItem.FullName
    if ($ExpectedManifestSha256 -and $manifestSha256 -cne (Normalize-DysonGsDigest -Digest $ExpectedManifestSha256 -Name 'The snapshot manifest digest')) {
        throw 'The migration snapshot manifest digest does not match.'
    }
    $manifest = Read-DysonGsJsonBounded -Path $manifestItem.FullName -MaximumBytes (16MB)
    Assert-DysonGsExactProperties -Value $manifest -Expected @(
        'protocol', 'schemaVersion', 'snapshotId', 'createdAt', 'projectBindingSha256', 'gsManagerRelativeRoot',
        'taskName', 'pairedSaveProtection', 'limits', 'gsManager', 'task', 'payloadSha256', 'fileCount', 'totalBytes', 'files'
    ) -Name 'GSManager migration snapshot manifest'
    Assert-DysonGsExactProperties -Value $manifest.pairedSaveProtection -Expected @('id', 'manifestSha256') -Name 'Protection binding'
    Assert-DysonGsExactProperties -Value $manifest.limits -Expected @('maximumFiles', 'maximumTotalBytes', 'maximumSingleFileBytes') -Name 'Snapshot limits'
    Assert-DysonGsExactProperties -Value $manifest.gsManager -Expected @('fileCount', 'totalBytes', 'treeSha256') -Name 'GSManager tree summary'
    Assert-DysonGsExactProperties -Value $manifest.task -Expected @('present', 'enabled', 'state') -Name 'Task summary'
    Assert-DysonGsJsonString -Value $manifest.protocol -Name 'Snapshot protocol'
    Assert-DysonGsJsonInteger -Value $manifest.schemaVersion -Name 'Snapshot schema version' -Minimum 1 -Maximum 1
    foreach ($stringField in @('snapshotId', 'createdAt', 'projectBindingSha256', 'gsManagerRelativeRoot', 'taskName', 'payloadSha256')) {
        Assert-DysonGsJsonString -Value $manifest.$stringField -Name "Snapshot $stringField"
    }
    Assert-DysonGsJsonString -Value $manifest.pairedSaveProtection.id -Name 'Snapshot protection-point ID'
    Assert-DysonGsJsonString -Value $manifest.pairedSaveProtection.manifestSha256 -Name 'Snapshot protection manifest digest'
    Assert-DysonGsJsonInteger -Value $manifest.limits.maximumFiles -Name 'Snapshot maximum file count' -Minimum 1 -Maximum $script:DysonGsHardMaximumFiles
    Assert-DysonGsJsonInteger -Value $manifest.limits.maximumTotalBytes -Name 'Snapshot maximum total bytes' -Minimum 1 -Maximum $script:DysonGsHardMaximumTotalBytes
    Assert-DysonGsJsonInteger -Value $manifest.limits.maximumSingleFileBytes -Name 'Snapshot maximum single-file bytes' -Minimum 1 -Maximum $script:DysonGsHardMaximumSingleFileBytes
    Assert-DysonGsJsonInteger -Value $manifest.gsManager.fileCount -Name 'Snapshot GSManager file count' -Minimum 0 -Maximum $script:DysonGsHardMaximumFiles
    Assert-DysonGsJsonInteger -Value $manifest.gsManager.totalBytes -Name 'Snapshot GSManager total bytes' -Minimum 0 -Maximum $script:DysonGsHardMaximumTotalBytes
    Assert-DysonGsJsonString -Value $manifest.gsManager.treeSha256 -Name 'Snapshot GSManager tree digest'
    Assert-DysonGsJsonBoolean -Value $manifest.task.present -Name 'Snapshot task presence'
    Assert-DysonGsJsonBoolean -Value $manifest.task.enabled -Name 'Snapshot task enabled state'
    Assert-DysonGsJsonString -Value $manifest.task.state -Name 'Snapshot task runtime state'
    Assert-DysonGsJsonInteger -Value $manifest.fileCount -Name 'Snapshot payload file count' -Minimum 1 -Maximum $script:DysonGsHardMaximumFiles
    Assert-DysonGsJsonInteger -Value $manifest.totalBytes -Name 'Snapshot payload total bytes' -Minimum 1 -Maximum $script:DysonGsHardMaximumTotalBytes
    if ([string]$manifest.protocol -cne $script:DysonGsSnapshotProtocol -or [int]$manifest.schemaVersion -ne $script:DysonGsSchemaVersion -or
        [string]$manifest.snapshotId -cne $id -or [string]$manifest.projectBindingSha256 -notmatch '^[0-9a-f]{64}$' -or
        [string]::IsNullOrWhiteSpace([string]$manifest.gsManagerRelativeRoot) -or
        [string]$manifest.gsManagerRelativeRoot -match '(^|/)\.\.(/|$)' -or [string]$manifest.gsManagerRelativeRoot -match '[:\x00-\x1f"<>|]') {
        throw 'The GSManager migration snapshot identity is invalid.'
    }
    Assert-DysonGsTaskName -TaskName ([string]$manifest.taskName)
    $maximumFiles = [int]$manifest.limits.maximumFiles
    $maximumTotalBytes = [int64]$manifest.limits.maximumTotalBytes
    $maximumSingleFileBytes = [int64]$manifest.limits.maximumSingleFileBytes
    Assert-DysonGsLimits -MaximumFiles $maximumFiles -MaximumTotalBytes $maximumTotalBytes -MaximumSingleFileBytes $maximumSingleFileBytes
    if ([int]$manifest.fileCount -lt 1 -or [int]$manifest.fileCount -gt $maximumFiles -or
        [int64]$manifest.totalBytes -lt 1 -or [int64]$manifest.totalBytes -gt $maximumTotalBytes -or
        [string]$manifest.payloadSha256 -notmatch '^[0-9a-f]{64}$' -or
        [string]$manifest.gsManager.treeSha256 -notmatch '^[0-9a-f]{64}$' -or
        [string]$manifest.pairedSaveProtection.id -notmatch '^save:[0-9a-f-]{36}$' -or
        [string]$manifest.pairedSaveProtection.manifestSha256 -notmatch '^[0-9a-f]{64}$') {
        throw 'The GSManager migration snapshot summary is invalid.'
    }
    $manifestFiles = @($manifest.files)
    if ($manifestFiles.Count -ne [int]$manifest.fileCount) { throw 'The snapshot manifest file count is inconsistent.' }
    $previousPath = $null
    foreach ($file in $manifestFiles) {
        Assert-DysonGsExactProperties -Value $file -Expected @('path', 'length', 'sha256') -Name 'Snapshot file entry'
        $path = [string]$file.path
        Assert-DysonGsJsonString -Value $file.path -Name 'Snapshot file path'
        Assert-DysonGsJsonInteger -Value $file.length -Name 'Snapshot file length' -Minimum 0 -Maximum $maximumSingleFileBytes
        Assert-DysonGsJsonString -Value $file.sha256 -Name 'Snapshot file digest'
        if ([string]::IsNullOrWhiteSpace($path) -or $path -eq 'manifest.json' -or
            -not ($path.StartsWith('gsmanager/', [System.StringComparison]::Ordinal) -or $path -in @('task/state.json', 'task/task.xml')) -or
            $path -match '(^|/)\.\.?(/|$)' -or $path -match '[:\x00-\x1f"<>|]' -or
            [System.IO.Path]::GetExtension($path).ToLowerInvariant() -in @('.dsv', '.server') -or
            [int64]$file.length -lt 0 -or [int64]$file.length -gt $maximumSingleFileBytes -or
            [string]$file.sha256 -notmatch '^[0-9a-f]{64}$' -or
            ($null -ne $previousPath -and [System.StringComparer]::Ordinal.Compare($previousPath, $path) -ge 0)) {
            throw 'The snapshot file inventory is invalid or noncanonical.'
        }
        $previousPath = $path
    }
    $payload = Get-DysonGsPayloadInventory -Root $snapshot -MaximumFiles $maximumFiles -MaximumTotalBytes $maximumTotalBytes `
        -MaximumSingleFileBytes $maximumSingleFileBytes -ExcludeRelativePath @('manifest.json')
    if (-not (Test-DysonGsEntryListsEqual -Left $manifestFiles -Right $payload.entries) -or
        $payload.treeSha256 -cne [string]$manifest.payloadSha256 -or $payload.fileCount -ne [int]$manifest.fileCount -or
        $payload.totalBytes -ne [int64]$manifest.totalBytes) {
        throw 'The migration snapshot payload does not match its manifest.'
    }
    $gsmRoot = Join-Path $snapshot 'gsmanager'
    $gsm = Get-DysonGsTreeInventory -Root $gsmRoot -MaximumFiles $maximumFiles -MaximumTotalBytes $maximumTotalBytes `
        -MaximumSingleFileBytes $maximumSingleFileBytes -PathPrefix 'gsmanager' -RejectSaveFiles
    if ($gsm.fileCount -ne [int]$manifest.gsManager.fileCount -or $gsm.totalBytes -ne [int64]$manifest.gsManager.totalBytes -or
        $gsm.treeSha256 -cne [string]$manifest.gsManager.treeSha256) {
        throw 'The GSManager file tree does not match its snapshot summary.'
    }
    $taskCapture = Read-DysonGsTaskCapture -Directory (Join-Path $snapshot 'task')
    if (-not [string]::Equals([string]$taskCapture.taskName, [string]$manifest.taskName, [System.StringComparison]::Ordinal) -or
        [bool]$taskCapture.present -ne [bool]$manifest.task.present -or
        [bool]$taskCapture.enabled -ne [bool]$manifest.task.enabled -or
        -not [string]::Equals([string]$taskCapture.state, [string]$manifest.task.state, [System.StringComparison]::Ordinal)) {
        throw 'The scheduled task snapshot does not match its manifest summary.'
    }
    return [pscustomobject][ordered]@{
        snapshotRoot = $snapshot
        manifest = $manifest
        manifestSha256 = $manifestSha256
        gsManagerInventory = $gsm
        taskCapture = $taskCapture
    }
}

function Remove-DysonGsOwnedTree {
    param(
        [Parameter(Mandatory)][string]$Path,
        [Parameter(Mandatory)][string]$Parent,
        [Parameter(Mandatory)][string]$RequiredPrefix
    )

    if (-not (Test-Path -LiteralPath $Path)) { return }
    $full = Get-DysonGsFullPath -Path $Path
    $parentFull = Assert-DysonGsPlainDirectory -Path $Parent
    if (-not (Test-DysonGsPathWithin -Candidate $full -Parent $parentFull) -or
        -not [System.IO.Path]::GetFileName($full).StartsWith($RequiredPrefix, [System.StringComparison]::Ordinal)) {
        throw 'Refusing to remove an unexpected migration work directory.'
    }
    $item = Get-Item -LiteralPath $full -Force -ErrorAction Stop
    if (-not $item.PSIsContainer -or ($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint)) {
        throw 'Refusing to remove a redirected migration work directory.'
    }
    Remove-Item -LiteralPath $item.FullName -Recurse -Force
}

function Test-DysonGsAdministrator {
    try {
        $identity = [System.Security.Principal.WindowsIdentity]::GetCurrent()
        $principal = New-Object System.Security.Principal.WindowsPrincipal($identity)
        return $principal.IsInRole([System.Security.Principal.WindowsBuiltInRole]::Administrator)
    }
    catch { return $false }
}

function Assert-DysonGsExactProcessStopped {
    param([Parameter(Mandatory)][string]$ProjectRoot)

    $project = Assert-DysonGsPlainDirectory -Path $ProjectRoot
    $expected = Get-DysonGsFullPath -Path (Join-Path $project 'server\DSPGAME.exe')
    foreach ($candidate in @(Get-Process -Name 'DSPGAME' -ErrorAction SilentlyContinue)) {
        try { $actual = Get-DysonGsFullPath -Path ([string]$candidate.Path) }
        catch { throw 'The DSP process set is ambiguous; restore requires it to be stopped.' }
        if ([string]::Equals($actual, $expected, [System.StringComparison]::OrdinalIgnoreCase)) {
            throw 'The exact managed DSP process must be stopped before restore.'
        }
        throw 'The DSP process set is ambiguous; restore requires it to be stopped.'
    }
}

function Assert-DysonGsControlTaskStopped {
    param([Parameter(Mandatory)][string]$TaskName)

    $capture = Get-DysonGsTaskCapture -TaskName $TaskName
    if (-not [bool]$capture.present) { throw 'The Dyson Control task must exist and be stopped before restore.' }
    if ([string]::Equals([string]$capture.state, 'Running', [System.StringComparison]::OrdinalIgnoreCase)) {
        throw 'The Dyson Control task must be stopped before restore.'
    }
}

function Assert-DysonGsManagerTaskStopped {
    param([Parameter(Mandatory)]$Capture)

    if ([bool]$Capture.present -and [string]::Equals([string]$Capture.state, 'Running', [System.StringComparison]::OrdinalIgnoreCase)) {
        throw 'The GSManager task must not be running during restore.'
    }
}

function Get-DysonGsRestoreDisposition {
    param(
        [Parameter(Mandatory)]$Layout,
        [Parameter(Mandatory)]$SnapshotVerification
    )

    if (-not [bool]$Layout.gsManagerExists) { return 'absent' }
    $limits = $SnapshotVerification.manifest.limits
    $current = Get-DysonGsTreeInventory -Root $Layout.gsManagerRoot -MaximumFiles ([int]$limits.maximumFiles) `
        -MaximumTotalBytes ([int64]$limits.maximumTotalBytes) -MaximumSingleFileBytes ([int64]$limits.maximumSingleFileBytes) -RejectSaveFiles
    if ($current.fileCount -eq 0) { return 'empty' }
    $snapshot = $SnapshotVerification.gsManagerInventory
    $snapshotWithoutPrefix = @($snapshot.entries | ForEach-Object {
        [pscustomobject][ordered]@{ path = ([string]$_.path).Substring('gsmanager/'.Length); length = [int64]$_.length; sha256 = [string]$_.sha256 }
    })
    if ($current.fileCount -eq $snapshot.fileCount -and $current.totalBytes -eq $snapshot.totalBytes -and
        (Test-DysonGsEntryListsEqual -Left $current.entries -Right $snapshotWithoutPrefix)) {
        return 'already-matches'
    }
    throw 'Restore refuses to overwrite a non-empty different GSManager tree.'
}

function Write-DysonGsGuardManifest {
    param(
        [Parameter(Mandatory)][string]$GuardRoot,
        [Parameter(Mandatory)][string]$GuardId,
        [Parameter(Mandatory)]$RootInventory,
        [Parameter(Mandatory)][bool]$RootExisted,
        [Parameter(Mandatory)]$TaskCapture,
        [Parameter(Mandatory)]$Limits
    )

    $payload = Get-DysonGsPayloadInventory -Root $GuardRoot -MaximumFiles ([int]$Limits.maximumFiles) `
        -MaximumTotalBytes ([int64]$Limits.maximumTotalBytes) -MaximumSingleFileBytes ([int64]$Limits.maximumSingleFileBytes) `
        -ExcludeRelativePath @('guard.json')
    $manifest = [ordered]@{
        protocol = $script:DysonGsGuardProtocol
        schemaVersion = $script:DysonGsSchemaVersion
        guardId = $GuardId
        createdAt = (Get-Date).ToUniversalTime().ToString('o')
        root = [ordered]@{ existed = $RootExisted; fileCount = [int]$RootInventory.fileCount; totalBytes = [int64]$RootInventory.totalBytes; treeSha256 = [string]$RootInventory.treeSha256 }
        task = [ordered]@{ taskName = [string]$TaskCapture.taskName; present = [bool]$TaskCapture.present; enabled = [bool]$TaskCapture.enabled; state = [string]$TaskCapture.state }
        payloadSha256 = $payload.treeSha256
        fileCount = $payload.fileCount
        totalBytes = $payload.totalBytes
        files = $payload.entries
    }
    Write-DysonGsUtf8Json -Path (Join-Path $GuardRoot 'guard.json') -Value $manifest
    return $manifest
}

function Test-DysonGsGuardCore {
    param(
        [Parameter(Mandatory)][string]$GuardRoot,
        [Parameter(Mandatory)][string]$GuardId,
        [Parameter(Mandatory)]$Limits
    )

    $root = Assert-DysonGsPlainDirectory -Path $GuardRoot
    $manifest = Read-DysonGsJsonBounded -Path (Join-Path $root 'guard.json') -MaximumBytes (16MB)
    Assert-DysonGsExactProperties -Value $manifest -Expected @('protocol', 'schemaVersion', 'guardId', 'createdAt', 'root', 'task', 'payloadSha256', 'fileCount', 'totalBytes', 'files') -Name 'Restore guard manifest'
    Assert-DysonGsExactProperties -Value $manifest.root -Expected @('existed', 'fileCount', 'totalBytes', 'treeSha256') -Name 'Restore guard root summary'
    Assert-DysonGsExactProperties -Value $manifest.task -Expected @('taskName', 'present', 'enabled', 'state') -Name 'Restore guard task summary'
    if ([string]$manifest.protocol -cne $script:DysonGsGuardProtocol -or [int]$manifest.schemaVersion -ne $script:DysonGsSchemaVersion -or
        [string]$manifest.guardId -cne $GuardId -or [string]$manifest.payloadSha256 -notmatch '^[0-9a-f]{64}$' -or
        [string]$manifest.root.treeSha256 -notmatch '^[0-9a-f]{64}$') { throw 'The restore guard identity is invalid.' }
    Assert-DysonGsTaskName -TaskName ([string]$manifest.task.taskName)
    if ([int]$manifest.fileCount -lt 1 -or [int]$manifest.fileCount -gt [int]$Limits.maximumFiles -or
        [int64]$manifest.totalBytes -lt 1 -or [int64]$manifest.totalBytes -gt [int64]$Limits.maximumTotalBytes -or
        [int]$manifest.root.fileCount -lt 0 -or [int]$manifest.root.fileCount -gt [int]$Limits.maximumFiles -or
        [int64]$manifest.root.totalBytes -lt 0 -or [int64]$manifest.root.totalBytes -gt [int64]$Limits.maximumTotalBytes) {
        throw 'The restore guard summary exceeds its snapshot limits.'
    }
    $guardFiles = @($manifest.files)
    if ($guardFiles.Count -ne [int]$manifest.fileCount) { throw 'The restore guard file count is inconsistent.' }
    $previousPath = $null
    foreach ($file in $guardFiles) {
        Assert-DysonGsExactProperties -Value $file -Expected @('path', 'length', 'sha256') -Name 'Restore guard file entry'
        $path = [string]$file.path
        if ([string]::IsNullOrWhiteSpace($path) -or
            -not ($path.StartsWith('root/', [System.StringComparison]::Ordinal) -or $path -in @('task/state.json', 'task/task.xml')) -or
            $path -match '(^|/)\.\.?(/|$)' -or $path -match '[:\x00-\x1f"<>|]' -or
            [System.IO.Path]::GetExtension($path).ToLowerInvariant() -in @('.dsv', '.server') -or
            [int64]$file.length -lt 0 -or [int64]$file.length -gt [int64]$Limits.maximumSingleFileBytes -or
            [string]$file.sha256 -notmatch '^[0-9a-f]{64}$' -or
            ($null -ne $previousPath -and [System.StringComparer]::Ordinal.Compare($previousPath, $path) -ge 0)) {
            throw 'The restore guard file inventory is invalid or noncanonical.'
        }
        $previousPath = $path
    }
    $payload = Get-DysonGsPayloadInventory -Root $root -MaximumFiles ([int]$Limits.maximumFiles) `
        -MaximumTotalBytes ([int64]$Limits.maximumTotalBytes) -MaximumSingleFileBytes ([int64]$Limits.maximumSingleFileBytes) `
        -ExcludeRelativePath @('guard.json')
    if ($payload.fileCount -ne [int]$manifest.fileCount -or $payload.totalBytes -ne [int64]$manifest.totalBytes -or
        $payload.treeSha256 -cne [string]$manifest.payloadSha256 -or
        -not (Test-DysonGsEntryListsEqual -Left $guardFiles -Right $payload.entries)) {
        throw 'The restore guard payload does not match its manifest.'
    }
    $rootInventory = Get-DysonGsTreeInventory -Root (Join-Path $root 'root') -MaximumFiles ([int]$Limits.maximumFiles) `
        -MaximumTotalBytes ([int64]$Limits.maximumTotalBytes) -MaximumSingleFileBytes ([int64]$Limits.maximumSingleFileBytes) -RejectSaveFiles
    if ($rootInventory.fileCount -ne [int]$manifest.root.fileCount -or
        $rootInventory.totalBytes -ne [int64]$manifest.root.totalBytes -or
        $rootInventory.treeSha256 -cne [string]$manifest.root.treeSha256 -or
        (-not [bool]$manifest.root.existed -and $rootInventory.fileCount -ne 0)) {
        throw 'The restore guard root does not match its manifest summary.'
    }
    $task = Read-DysonGsTaskCapture -Directory (Join-Path $root 'task')
    if (-not [string]::Equals([string]$task.taskName, [string]$manifest.task.taskName, [System.StringComparison]::Ordinal) -or
        [bool]$task.present -ne [bool]$manifest.task.present -or [bool]$task.enabled -ne [bool]$manifest.task.enabled -or
        -not [string]::Equals([string]$task.state, [string]$manifest.task.state, [System.StringComparison]::Ordinal)) {
        throw 'The restore guard task does not match its manifest summary.'
    }
    return [pscustomobject][ordered]@{ root = $root; manifest = $manifest; taskCapture = $task }
}

function New-DysonGsRestoreGuard {
    param(
        [Parameter(Mandatory)][string]$DataRoot,
        [Parameter(Mandatory)]$Layout,
        [Parameter(Mandatory)]$CurrentTaskCapture,
        [Parameter(Mandatory)]$Limits
    )

    $data = New-DysonGsPlainDirectory -Path $DataRoot
    $guardParent = New-DysonGsPlainDirectory -Path (Join-Path $data $script:DysonGsGuardRelativeRoot)
    $guardId = [guid]::NewGuid().ToString('D').ToLowerInvariant()
    $stage = Join-Path $guardParent ('.partial-' + $guardId)
    $final = Join-Path $guardParent $guardId
    $published = $false
    try {
        [void](New-DysonGsPlainDirectory -Path $stage -Private)
        [void](New-DysonGsPlainDirectory -Path (Join-Path $stage 'root'))
        $inventory = [pscustomobject][ordered]@{ entries = @(); fileCount = 0; totalBytes = [int64]0; treeSha256 = Get-DysonGsEntriesDigest -Entries @() }
        if ([bool]$Layout.gsManagerExists) {
            $inventory = Get-DysonGsTreeInventory -Root $Layout.gsManagerRoot -MaximumFiles ([int]$Limits.maximumFiles) `
                -MaximumTotalBytes ([int64]$Limits.maximumTotalBytes) -MaximumSingleFileBytes ([int64]$Limits.maximumSingleFileBytes) -RejectSaveFiles
            Copy-DysonGsInventory -SourceRoot $Layout.gsManagerRoot -DestinationRoot (Join-Path $stage 'root') -Inventory $inventory
        }
        Write-DysonGsTaskCapture -Capture $CurrentTaskCapture -Directory (Join-Path $stage 'task')
        [void](Write-DysonGsGuardManifest -GuardRoot $stage -GuardId $guardId -RootInventory $inventory `
            -RootExisted ([bool]$Layout.gsManagerExists) -TaskCapture $CurrentTaskCapture -Limits $Limits)
        [void](Test-DysonGsGuardCore -GuardRoot $stage -GuardId $guardId -Limits $Limits)
        [System.IO.Directory]::Move($stage, $final)
        $published = $true
        $verified = Test-DysonGsGuardCore -GuardRoot $final -GuardId $guardId -Limits $Limits
        return [pscustomobject][ordered]@{ guardId = $guardId; guardRoot = $final; verification = $verified }
    }
    finally {
        if (-not $published -and (Test-Path -LiteralPath $stage)) {
            Remove-DysonGsOwnedTree -Path $stage -Parent $guardParent -RequiredPrefix '.partial-'
        }
    }
}

function Restore-DysonGsRootFromGuard {
    param(
        [Parameter(Mandatory)]$Layout,
        [Parameter(Mandatory)]$GuardVerification,
        [Parameter(Mandatory)]$Limits
    )

    $target = $Layout.gsManagerRoot
    $parent = Assert-DysonGsPlainDirectory -Path ([System.IO.Path]::GetDirectoryName($target))
    $rollbackStage = Join-Path $parent ('.dyson-gsm-guard-' + [guid]::NewGuid().ToString('N'))
    if (Test-Path -LiteralPath $target) {
        $current = Get-Item -LiteralPath $target -Force -ErrorAction Stop
        if (-not $current.PSIsContainer -or ($current.Attributes -band [System.IO.FileAttributes]::ReparsePoint)) { throw 'Restore compensation found an unsafe target.' }
        Remove-Item -LiteralPath $current.FullName -Recurse -Force
    }
    if ([bool]$GuardVerification.manifest.root.existed) {
        [void](New-DysonGsPlainDirectory -Path $rollbackStage)
        $guardInventory = Get-DysonGsTreeInventory -Root (Join-Path $GuardVerification.root 'root') `
            -MaximumFiles ([int]$Limits.maximumFiles) -MaximumTotalBytes ([int64]$Limits.maximumTotalBytes) `
            -MaximumSingleFileBytes ([int64]$Limits.maximumSingleFileBytes) -RejectSaveFiles
        Copy-DysonGsInventory -SourceRoot (Join-Path $GuardVerification.root 'root') -DestinationRoot $rollbackStage -Inventory $guardInventory
        [System.IO.Directory]::Move($rollbackStage, $target)
    }
}

function Invoke-DysonGsRestoreCore {
    param(
        [Parameter(Mandatory)]$Layout,
        [Parameter(Mandatory)]$SnapshotVerification,
        [Parameter(Mandatory)][string]$DataRoot,
        [Parameter(Mandatory)][string]$Disposition,
        [Parameter(Mandatory)]$CurrentTaskCapture,
        [scriptblock]$TaskApply,
        [scriptblock]$PreMutationCheck
    )

    if ($Disposition -notin @('absent', 'empty', 'already-matches')) { throw 'The restore disposition is invalid.' }
    $limits = $SnapshotVerification.manifest.limits
    $guard = New-DysonGsRestoreGuard -DataRoot $DataRoot -Layout $Layout -CurrentTaskCapture $CurrentTaskCapture -Limits $limits
    $parent = Assert-DysonGsPlainDirectory -Path ([System.IO.Path]::GetDirectoryName($Layout.gsManagerRoot))
    $restoreStage = Join-Path $parent ('.dyson-gsm-restore-' + [guid]::NewGuid().ToString('N'))
    $rootChanged = $false
    $rootMutationStarted = $false
    $taskApplyAttempted = $false
    $applyTask = $TaskApply
    if ($null -eq $applyTask) {
        $applyTask = { param($capture, $taskName) Set-DysonGsTaskCapture -Capture $capture -TaskName $taskName }
    }
    try {
        if ($null -ne $PreMutationCheck) { & $PreMutationCheck $CurrentTaskCapture | Out-Null }
        if ($Disposition -ne 'already-matches') {
            [void](New-DysonGsPlainDirectory -Path $restoreStage)
            $copyInventory = [pscustomobject][ordered]@{
                entries = @($SnapshotVerification.gsManagerInventory.entries | ForEach-Object {
                    [pscustomobject][ordered]@{ path = ([string]$_.path).Substring('gsmanager/'.Length); length = [int64]$_.length; sha256 = [string]$_.sha256 }
                })
                fileCount = [int]$SnapshotVerification.gsManagerInventory.fileCount
                totalBytes = [int64]$SnapshotVerification.gsManagerInventory.totalBytes
            }
            Copy-DysonGsInventory -SourceRoot (Join-Path $SnapshotVerification.snapshotRoot 'gsmanager') -DestinationRoot $restoreStage -Inventory $copyInventory
            $stageInventory = Get-DysonGsTreeInventory -Root $restoreStage -MaximumFiles ([int]$limits.maximumFiles) `
                -MaximumTotalBytes ([int64]$limits.maximumTotalBytes) -MaximumSingleFileBytes ([int64]$limits.maximumSingleFileBytes) -RejectSaveFiles
            if (-not (Test-DysonGsEntryListsEqual -Left $copyInventory.entries -Right $stageInventory.entries)) {
                throw 'The staged GSManager restore tree failed verification.'
            }
            if (Test-Path -LiteralPath $Layout.gsManagerRoot) {
                $targetItem = Get-Item -LiteralPath $Layout.gsManagerRoot -Force -ErrorAction Stop
                if (-not $targetItem.PSIsContainer -or ($targetItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint)) {
                    throw 'Restore target changed into an unsafe filesystem entry.'
                }
                $existing = @(Get-ChildItem -LiteralPath $Layout.gsManagerRoot -Force -ErrorAction Stop)
                if ($existing.Count -ne 0) { throw 'Restore target changed after its conflict check.' }
                $rootMutationStarted = $true
                Remove-Item -LiteralPath $Layout.gsManagerRoot -Force
            }
            else { $rootMutationStarted = $true }
            [System.IO.Directory]::Move($restoreStage, $Layout.gsManagerRoot)
            $rootChanged = $true
        }
        $taskApplyAttempted = $true
        & $applyTask $SnapshotVerification.taskCapture ([string]$SnapshotVerification.manifest.taskName) | Out-Null
        return [pscustomobject][ordered]@{ guardId = $guard.guardId; rootChanged = $rootChanged }
    }
    catch {
        if (-not $rootMutationStarted -and -not $taskApplyAttempted) {
            throw 'GSManager restore stopped at its pre-mutation gate; the guard is retained and no target change occurred.'
        }
        $compensated = $true
        if ($taskApplyAttempted) {
            try { & $applyTask $guard.verification.taskCapture ([string]$guard.verification.taskCapture.taskName) | Out-Null }
            catch { $compensated = $false }
        }
        try {
            if ($rootMutationStarted) { Restore-DysonGsRootFromGuard -Layout $Layout -GuardVerification $guard.verification -Limits $limits }
        }
        catch { $compensated = $false }
        if (Test-Path -LiteralPath $restoreStage) {
            try { Remove-DysonGsOwnedTree -Path $restoreStage -Parent $parent -RequiredPrefix '.dyson-gsm-restore-' }
            catch { $compensated = $false }
        }
        if ($compensated) { throw 'GSManager restore failed and was compensated from its restore guard.' }
        throw 'GSManager restore failed and restore-guard compensation also failed.'
    }
    finally {
        if (Test-Path -LiteralPath $restoreStage) {
            Remove-DysonGsOwnedTree -Path $restoreStage -Parent $parent -RequiredPrefix '.dyson-gsm-restore-'
        }
    }
}
