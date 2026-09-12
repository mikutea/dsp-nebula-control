Set-StrictMode -Version 2.0

$script:DysonPrivateEvidenceProtocol = 'DYSON_PRIVATE_ACCEPTANCE_EVIDENCE_V1'
$script:DysonPrivateEvidenceReferenceProtocol = 'DYSON_PRIVATE_ACCEPTANCE_EVIDENCE_REFERENCE_V1'
$script:DysonAcceptanceEvidenceIndexProtocol = 'DYSON_ACCEPTANCE_EVIDENCE_INDEX_V1'
$script:DysonPrivateEvidenceSchemaVersion = 1
$script:DysonPrivateEvidenceManifestName = 'manifest.json'
$script:DysonPrivateEvidenceMaximumFiles = 4096
$script:DysonPrivateEvidenceMaximumDirectories = 4096
$script:DysonPrivateEvidenceMaximumTotalBytes = [int64](512MB)
$script:DysonPrivateEvidenceMaximumSingleFileBytes = [int64](64MB)
$script:DysonPrivateEvidenceMaximumManifestBytes = [int64](16MB)
$script:DysonPrivateEvidenceKinds = @(
    'clean-host-run',
    'operator-run',
    'external-client-run',
    'soak-report',
    'backup-manifest',
    'rollback-drill',
    'private-proof'
)
$script:DysonPrivateEvidenceScopes = @(
    'dyson-side-by-side',
    'production',
    'external-client',
    'cutover'
)

function ConvertTo-DysonPrivateEvidenceJsonLine {
    [CmdletBinding()]
    param([Parameter(Mandatory, ValueFromPipeline)]$Value)

    process { return $Value | ConvertTo-Json -Depth 12 -Compress }
}

function Get-DysonPrivateEvidenceFullPath {
    param([Parameter(Mandatory)][string]$Path)

    if ([string]::IsNullOrWhiteSpace($Path)) { throw 'An evidence path cannot be empty.' }
    try {
        if ([System.IO.Path]::IsPathRooted($Path)) { return [System.IO.Path]::GetFullPath($Path) }
        return [System.IO.Path]::GetFullPath((Join-Path (Get-Location).ProviderPath $Path))
    }
    catch { throw 'An evidence path is invalid.' }
}

function Assert-DysonPrivateEvidenceSafeRoot {
    param(
        [Parameter(Mandatory)][string]$Path,
        [Parameter(Mandatory)][string]$Name
    )

    $full = Get-DysonPrivateEvidenceFullPath -Path $Path
    $root = [System.IO.Path]::GetPathRoot($full)
    if ([string]::Equals($full.TrimEnd('\', '/'), $root.TrimEnd('\', '/'), [System.StringComparison]::OrdinalIgnoreCase)) {
        throw "$Name cannot be a filesystem root."
    }
    return $full
}

function Assert-DysonPrivateEvidenceNoReparseAncestors {
    param([Parameter(Mandatory)][string]$Path)

    $current = Get-DysonPrivateEvidenceFullPath -Path $Path
    while (-not [string]::IsNullOrWhiteSpace($current)) {
        if (Test-Path -LiteralPath $current) {
            try { $item = Get-Item -LiteralPath $current -Force -ErrorAction Stop }
            catch { throw 'An evidence path could not be inspected.' }
            if ($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) {
                throw 'An evidence path is redirected.'
            }
        }
        $parent = [System.IO.Directory]::GetParent($current)
        if ($null -eq $parent) { break }
        $next = $parent.FullName
        if ([string]::Equals($next, $current, [System.StringComparison]::OrdinalIgnoreCase)) { break }
        $current = $next
    }
}

function Assert-DysonPrivateEvidencePlainDirectory {
    param([Parameter(Mandatory)][string]$Path)

    Assert-DysonPrivateEvidenceNoReparseAncestors -Path $Path
    try { $item = Get-Item -LiteralPath $Path -Force -ErrorAction Stop }
    catch { throw 'An evidence directory is unavailable or redirected.' }
    if (-not $item.PSIsContainer -or ($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint)) {
        throw 'An evidence directory is unavailable or redirected.'
    }
    return $item.FullName
}

function Assert-DysonPrivateEvidencePlainFile {
    param(
        [Parameter(Mandatory)][string]$Path,
        [int64]$MaximumBytes = $script:DysonPrivateEvidenceMaximumManifestBytes,
        [switch]$AllowEmpty
    )

    Assert-DysonPrivateEvidenceNoReparseAncestors -Path $Path
    try { $item = Get-Item -LiteralPath $Path -Force -ErrorAction Stop }
    catch { throw 'An evidence file is unavailable, redirected, or outside its size bound.' }
    $minimumBytes = if ($AllowEmpty) { [int64]0 } else { [int64]1 }
    if ($item.PSIsContainer -or ($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -or
        $item.Length -lt $minimumBytes -or $item.Length -gt $MaximumBytes) {
        throw 'An evidence file is unavailable, redirected, or outside its size bound.'
    }
    return $item
}

function Assert-DysonPrivateEvidenceDirectoryAcl {
    param([Parameter(Mandatory)][string]$Path)

    $directory = Assert-DysonPrivateEvidencePlainDirectory -Path $Path
    $aclStage = 'module-load'
    try {
        $securityModulePath = Join-Path $PSHOME 'Modules\Microsoft.PowerShell.Security\Microsoft.PowerShell.Security.psd1'
        if (-not (Test-Path -LiteralPath $securityModulePath -PathType Leaf)) {
            throw 'the platform security module is unavailable'
        }
        $loadedSecurityModules = @(Import-Module -Name $securityModulePath -PassThru -ErrorAction Stop)
        if ($loadedSecurityModules.Count -ne 1 -or
            -not [string]::Equals(
                [System.IO.Path]::GetFullPath([string]$loadedSecurityModules[0].Path),
                [System.IO.Path]::GetFullPath($securityModulePath),
                [System.StringComparison]::OrdinalIgnoreCase
            ) -or
            -not $loadedSecurityModules[0].ExportedCommands.ContainsKey('Get-Acl')) {
            throw 'the platform security module identity is invalid'
        }
        $aclStage = 'identity'
        $identity = [System.Security.Principal.WindowsIdentity]::GetCurrent()
        $sidMap = @{}
        foreach ($sid in @(
            $identity.User,
            (New-Object System.Security.Principal.SecurityIdentifier('S-1-5-18')),
            (New-Object System.Security.Principal.SecurityIdentifier('S-1-5-32-544'))
        )) { $sidMap[$sid.Value] = $sid }
        $allowedSids = @($sidMap.Keys)
        $inheritance = [System.Security.AccessControl.InheritanceFlags]'ContainerInherit, ObjectInherit'
        $propagation = [System.Security.AccessControl.PropagationFlags]::None

        $aclStage = 'read-back'
        $verified = Microsoft.PowerShell.Security\Get-Acl -LiteralPath $directory -ErrorAction Stop
        $aclStage = 'protection-check'
        if (-not $verified.AreAccessRulesProtected) { throw 'private ACL inheritance remained enabled' }
        $verifiedOwner = $verified.GetOwner([System.Security.Principal.SecurityIdentifier])
        if (-not [string]::Equals(
            $verifiedOwner.Value,
            $identity.User.Value,
            [System.StringComparison]::OrdinalIgnoreCase
        )) { throw 'private ACL owner is invalid' }
        $rules = @($verified.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier]))
        $aclStage = 'rule-count-check'
        if ($rules.Count -ne $allowedSids.Count) { throw 'private ACL contains an unexpected rule count' }
        $aclStage = 'rule-shape-check'
        $observedSids = @{}
        foreach ($rule in $rules) {
            if ($rule.IdentityReference.Value -notin $allowedSids -or
                $rule.IsInherited -or
                $rule.AccessControlType -ne [System.Security.AccessControl.AccessControlType]::Allow -or
                $rule.FileSystemRights -ne [System.Security.AccessControl.FileSystemRights]::FullControl -or
                $rule.InheritanceFlags -ne $inheritance -or
                $rule.PropagationFlags -ne $propagation -or
                $observedSids.ContainsKey($rule.IdentityReference.Value)) {
                throw 'private ACL contains an unexpected rule'
            }
            $observedSids[$rule.IdentityReference.Value] = $true
        }
        foreach ($allowedSid in $allowedSids) {
            if (-not $observedSids.ContainsKey($allowedSid)) {
                throw 'private ACL is missing an expected rule'
            }
        }
        return $directory
    }
    catch {
        $aclErrorType = $_.Exception.GetType().FullName
        $aclHResultValue = [System.BitConverter]::ToUInt32(
            [System.BitConverter]::GetBytes([int]$_.Exception.HResult),
            0
        )
        $aclHResult = ('0x{0:x8}' -f $aclHResultValue)
        throw "The private evidence directory ACL is invalid ($aclStage, $aclErrorType, $aclHResult)."
    }
}

function Protect-DysonPrivateEvidenceDirectory {
    param([Parameter(Mandatory)][string]$Path)

    $directory = Assert-DysonPrivateEvidencePlainDirectory -Path $Path
    $aclStage = 'identity'
    try {
        $aclStage = 'module-load'
        $securityModulePath = Join-Path $PSHOME 'Modules\Microsoft.PowerShell.Security\Microsoft.PowerShell.Security.psd1'
        if (-not (Test-Path -LiteralPath $securityModulePath -PathType Leaf)) {
            throw 'the platform security module is unavailable'
        }
        $loadedSecurityModules = @(Import-Module -Name $securityModulePath -PassThru -ErrorAction Stop)
        if ($loadedSecurityModules.Count -ne 1 -or
            -not [string]::Equals(
                [System.IO.Path]::GetFullPath([string]$loadedSecurityModules[0].Path),
                [System.IO.Path]::GetFullPath($securityModulePath),
                [System.StringComparison]::OrdinalIgnoreCase
            ) -or
            -not $loadedSecurityModules[0].ExportedCommands.ContainsKey('Set-Acl') -or
            -not $loadedSecurityModules[0].ExportedCommands.ContainsKey('Get-Acl')) {
            throw 'the platform security module identity is invalid'
        }
        $aclStage = 'identity'
        $identity = [System.Security.Principal.WindowsIdentity]::GetCurrent()
        $aclStage = 'construct'
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
        $aclStage = 'apply'
        Microsoft.PowerShell.Security\Set-Acl -LiteralPath $directory -AclObject $security -ErrorAction Stop
        $aclStage = 'read-back'
        [void](Assert-DysonPrivateEvidenceDirectoryAcl -Path $directory)
    }
    catch {
        $aclErrorType = $_.Exception.GetType().FullName
        $aclHResultValue = [System.BitConverter]::ToUInt32(
            [System.BitConverter]::GetBytes([int]$_.Exception.HResult),
            0
        )
        $aclHResult = ('0x{0:x8}' -f $aclHResultValue)
        throw "The private evidence directory ACL could not be established ($aclStage, $aclErrorType, $aclHResult)."
    }
}

function New-DysonPrivateEvidenceDirectory {
    param(
        [Parameter(Mandatory)][string]$Path,
        [switch]$Private
    )

    Assert-DysonPrivateEvidenceNoReparseAncestors -Path $Path
    [System.IO.Directory]::CreateDirectory((Get-DysonPrivateEvidenceFullPath -Path $Path)) | Out-Null
    $directory = Assert-DysonPrivateEvidencePlainDirectory -Path $Path
    if ($Private) { Protect-DysonPrivateEvidenceDirectory -Path $directory }
    return $directory
}

function Assert-DysonPrivateEvidenceIdentifier {
    param(
        [Parameter(Mandatory)][string]$Value,
        [Parameter(Mandatory)][string]$Name
    )

    if ($Value -cnotmatch '^[a-z0-9](?:[a-z0-9._-]{6,126}[a-z0-9])$' -or $Value.Contains('..')) {
        throw "$Name is outside the bounded opaque identifier grammar."
    }
    $windowsStem = $Value.Split('.')[0]
    if ($windowsStem -match '^(?i:con|prn|aux|nul|com[1-9]|lpt[1-9])$') {
        throw "$Name is outside the bounded opaque identifier grammar."
    }
    return $Value
}

function Assert-DysonPrivateEvidenceCommit {
    param([Parameter(Mandatory)][string]$Commit)

    if ($Commit -cnotmatch '^[0-9a-f]{40}$') { throw 'The evidence subject commit is invalid.' }
    return $Commit
}

function Assert-DysonPrivateEvidenceDigest {
    param(
        [Parameter(Mandatory)][string]$Digest,
        [Parameter(Mandatory)][string]$Name
    )

    if ($Digest -cnotmatch '^[0-9a-f]{64}$') { throw "$Name is invalid." }
    return $Digest
}

function Assert-DysonPrivateEvidenceKind {
    param([Parameter(Mandatory)][string]$Kind)

    if ($Kind -cnotin $script:DysonPrivateEvidenceKinds) { throw 'The private evidence kind is unsupported.' }
    return $Kind
}

function Assert-DysonPrivateEvidenceScope {
    param([Parameter(Mandatory)][string]$Scope)

    if ($Scope -cnotin $script:DysonPrivateEvidenceScopes) { throw 'The private evidence scope is unsupported.' }
    return $Scope
}

function ConvertTo-DysonPrivateEvidenceObservedAt {
    param([Parameter(Mandatory)][string]$ObservedAt)

    try {
        $parsed = [System.DateTimeOffset]::Parse(
            $ObservedAt,
            [System.Globalization.CultureInfo]::InvariantCulture,
            [System.Globalization.DateTimeStyles]::RoundtripKind
        )
    }
    catch { throw 'The private evidence observation time is invalid.' }
    return $parsed.ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ss.fffZ', [System.Globalization.CultureInfo]::InvariantCulture)
}

function Get-DysonPrivateEvidenceRequirementIds {
    param([Parameter(Mandatory)][string[]]$RequirementIds)

    if ($RequirementIds.Count -lt 1 -or $RequirementIds.Count -gt 64) {
        throw 'The private evidence requirement list is outside its count bound.'
    }
    $seen = @{}
    foreach ($requirementId in $RequirementIds) {
        if ($requirementId -cnotmatch '^[A-Z]{3}-[0-9]{3}$') {
            throw 'A private evidence requirement ID is invalid.'
        }
        if ($seen.ContainsKey($requirementId)) { throw 'The private evidence requirement list contains a duplicate.' }
        $seen[$requirementId] = $true
    }
    $canonical = [string[]]@($seen.Keys)
    [System.Array]::Sort($canonical, [System.StringComparer]::Ordinal)
    return ,$canonical
}

function Get-DysonPrivateEvidenceJsonInteger {
    param(
        [Parameter(Mandatory)]$Value,
        [Parameter(Mandatory)][int64]$Minimum,
        [Parameter(Mandatory)][int64]$Maximum,
        [Parameter(Mandatory)][string]$Name
    )

    if (($Value -isnot [int]) -and ($Value -isnot [long])) {
        throw "$Name must be a bounded JSON integer."
    }
    $number = [int64]$Value
    if ($number -lt $Minimum -or $number -gt $Maximum) {
        throw "$Name must be a bounded JSON integer."
    }
    return $number
}

function Assert-DysonPrivateEvidenceRelativePath {
    param([Parameter(Mandatory)][string]$Path)

    if ([string]::IsNullOrWhiteSpace($Path) -or $Path.Length -gt 512 -or $Path.StartsWith('/') -or
        $Path.Contains('\') -or $Path -match '[\x00-\x1f]' -or $Path -match '(^|/)\.\.?($|/)') {
        throw 'A private evidence payload path is invalid.'
    }
    $segments = @($Path.Split('/'))
    if ($segments.Count -lt 1 -or @($segments | Where-Object { [string]::IsNullOrWhiteSpace($_) }).Count -gt 0) {
        throw 'A private evidence payload path is invalid.'
    }
    return $Path
}

function Get-DysonPrivateEvidenceRelativePath {
    param(
        [Parameter(Mandatory)][string]$Root,
        [Parameter(Mandatory)][string]$File
    )

    $rootFull = (Get-DysonPrivateEvidenceFullPath -Path $Root).TrimEnd('\', '/') + [System.IO.Path]::DirectorySeparatorChar
    $fileFull = Get-DysonPrivateEvidenceFullPath -Path $File
    if (-not $fileFull.StartsWith($rootFull, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw 'A private evidence payload file escaped its root.'
    }
    return Assert-DysonPrivateEvidenceRelativePath -Path ($fileFull.Substring($rootFull.Length).Replace('\', '/'))
}

function Get-DysonPrivateEvidenceFileSha256 {
    param([Parameter(Mandatory)][string]$Path)

    $stream = [System.IO.File]::Open($Path, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::Read)
    $hasher = [System.Security.Cryptography.SHA256]::Create()
    try { return ([System.BitConverter]::ToString($hasher.ComputeHash($stream))).Replace('-', '').ToLowerInvariant() }
    finally {
        $hasher.Dispose()
        $stream.Dispose()
    }
}

function Get-DysonPrivateEvidenceTextSha256 {
    param([Parameter(Mandatory)][string]$Text)

    $hasher = [System.Security.Cryptography.SHA256]::Create()
    try {
        $bytes = [System.Text.UTF8Encoding]::new($false).GetBytes($Text)
        return ([System.BitConverter]::ToString($hasher.ComputeHash($bytes))).Replace('-', '').ToLowerInvariant()
    }
    finally { $hasher.Dispose() }
}

function Get-DysonPrivateEvidenceInventory {
    param([Parameter(Mandatory)][string]$Root)

    $rootFull = Assert-DysonPrivateEvidencePlainDirectory -Path $Root
    $pending = New-Object 'System.Collections.Generic.Stack[string]'
    $pending.Push($rootFull)
    $directories = 0
    $byPath = @{}
    $totalBytes = [int64]0
    while ($pending.Count -gt 0) {
        $directory = $pending.Pop()
        $directories++
        if ($directories -gt $script:DysonPrivateEvidenceMaximumDirectories) {
            throw 'The private evidence payload contains too many directories.'
        }
        foreach ($item in @(Get-ChildItem -LiteralPath $directory -Force -ErrorAction Stop)) {
            if ($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) {
                throw 'The private evidence payload contains a redirected entry.'
            }
            if ($item.PSIsContainer) {
                $pending.Push($item.FullName)
                continue
            }
            if ($byPath.Count -ge $script:DysonPrivateEvidenceMaximumFiles) {
                throw 'The private evidence payload contains too many files.'
            }
            if ($item.Length -lt 0 -or $item.Length -gt $script:DysonPrivateEvidenceMaximumSingleFileBytes) {
                throw 'A private evidence payload file exceeds its size bound.'
            }
            $relative = Get-DysonPrivateEvidenceRelativePath -Root $rootFull -File $item.FullName
            $key = $relative.ToLowerInvariant()
            if ($byPath.ContainsKey($key)) { throw 'The private evidence payload contains a case-colliding path.' }
            $totalBytes += [int64]$item.Length
            if ($totalBytes -gt $script:DysonPrivateEvidenceMaximumTotalBytes) {
                throw 'The private evidence payload exceeds its total size bound.'
            }
            $byPath[$key] = [ordered]@{
                path = $relative
                length = [int64]$item.Length
                sha256 = Get-DysonPrivateEvidenceFileSha256 -Path $item.FullName
            }
        }
    }
    if ($byPath.Count -lt 1) { throw 'The private evidence payload is empty.' }
    $paths = [string[]]@($byPath.Keys)
    [System.Array]::Sort($paths, [System.StringComparer]::Ordinal)
    $entries = @($paths | ForEach-Object { $byPath[$_] })
    $canonical = New-Object System.Text.StringBuilder
    foreach ($entry in $entries) {
        [void]$canonical.Append([string]$entry.path).Append("`n")
        [void]$canonical.Append(([int64]$entry.length).ToString([System.Globalization.CultureInfo]::InvariantCulture)).Append("`n")
        [void]$canonical.Append([string]$entry.sha256).Append("`n")
    }
    return [ordered]@{
        fileCount = [int]$entries.Count
        totalBytes = $totalBytes
        sha256 = Get-DysonPrivateEvidenceTextSha256 -Text $canonical.ToString()
        files = $entries
    }
}

function Assert-DysonPrivateEvidenceInventoriesEqual {
    param(
        [Parameter(Mandatory)]$Expected,
        [Parameter(Mandatory)]$Actual
    )

    if ([int]$Expected.fileCount -ne [int]$Actual.fileCount -or
        [int64]$Expected.totalBytes -ne [int64]$Actual.totalBytes -or
        -not [string]::Equals([string]$Expected.sha256, [string]$Actual.sha256, [System.StringComparison]::Ordinal)) {
        throw 'The private evidence payload inventory changed.'
    }
    for ($index = 0; $index -lt [int]$Expected.fileCount; $index++) {
        $left = $Expected.files[$index]
        $right = $Actual.files[$index]
        if (-not [string]::Equals([string]$left.path, [string]$right.path, [System.StringComparison]::Ordinal) -or
            [int64]$left.length -ne [int64]$right.length -or
            -not [string]::Equals([string]$left.sha256, [string]$right.sha256, [System.StringComparison]::Ordinal)) {
            throw 'The private evidence payload inventory changed.'
        }
    }
}

function Copy-DysonPrivateEvidencePayload {
    param(
        [Parameter(Mandatory)][string]$SourceRoot,
        [Parameter(Mandatory)][string]$DestinationRoot,
        [Parameter(Mandatory)]$Inventory
    )

    foreach ($entry in $Inventory.files) {
        $relativeWindows = ([string]$entry.path).Replace('/', '\')
        $source = Join-Path $SourceRoot $relativeWindows
        $destination = Join-Path $DestinationRoot $relativeWindows
        $parent = Split-Path -Parent $destination
        if (-not (Test-Path -LiteralPath $parent -PathType Container)) {
            [System.IO.Directory]::CreateDirectory($parent) | Out-Null
        }
        [System.IO.File]::Copy($source, $destination, $false)
    }
}

function Assert-DysonPrivateEvidenceExactProperties {
    param(
        [Parameter(Mandatory)]$Value,
        [Parameter(Mandatory)][string[]]$Expected,
        [Parameter(Mandatory)][string]$Name
    )

    if ($null -eq $Value -or $Value -is [string] -or $Value -is [System.Array]) {
        throw "$Name is invalid."
    }
    $actual = [string[]]@($Value.PSObject.Properties.Name)
    [System.Array]::Sort($actual, [System.StringComparer]::Ordinal)
    $wanted = [string[]]@($Expected)
    [System.Array]::Sort($wanted, [System.StringComparer]::Ordinal)
    if ([string]::Join("`n", $actual) -cne [string]::Join("`n", $wanted)) {
        throw "$Name has an unsupported schema."
    }
}

function Read-DysonPrivateEvidenceManifest {
    param([Parameter(Mandatory)][string]$EvidenceRoot)

    $root = Assert-DysonPrivateEvidencePlainDirectory -Path $EvidenceRoot
    $items = @(Get-ChildItem -LiteralPath $root -Force -ErrorAction Stop)
    $names = [string[]]@($items.Name)
    [System.Array]::Sort($names, [System.StringComparer]::Ordinal)
    if ([string]::Join("`n", $names) -cne "manifest.json`npayload") {
        throw 'The private evidence bundle root has an unexpected layout.'
    }
    $manifestPath = Join-Path $root $script:DysonPrivateEvidenceManifestName
    $manifestFile = Assert-DysonPrivateEvidencePlainFile -Path $manifestPath -MaximumBytes $script:DysonPrivateEvidenceMaximumManifestBytes
    try { $manifest = [System.IO.File]::ReadAllText($manifestFile.FullName, [System.Text.Encoding]::UTF8) | ConvertFrom-Json -ErrorAction Stop }
    catch { throw 'The private evidence manifest is invalid JSON.' }
    return [ordered]@{
        root = $root
        path = $manifestFile.FullName
        sha256 = Get-DysonPrivateEvidenceFileSha256 -Path $manifestFile.FullName
        manifest = $manifest
    }
}

function Test-DysonPrivateEvidenceBundleCore {
    param(
        [Parameter(Mandatory)][string]$EvidenceRoot,
        [Parameter(Mandatory)][string]$ExpectedEvidenceId,
        [string]$ExpectedManifestSha256,
        [string]$ExpectedSubjectCommit,
        [string]$ExpectedRuntimePayloadSha256
    )

    $normalizedEvidenceId = Assert-DysonPrivateEvidenceIdentifier -Value $ExpectedEvidenceId -Name 'EvidenceId'
    if ($ExpectedManifestSha256) {
        [void](Assert-DysonPrivateEvidenceDigest -Digest $ExpectedManifestSha256 -Name 'ExpectedManifestSha256')
    }
    if ($ExpectedSubjectCommit) { [void](Assert-DysonPrivateEvidenceCommit -Commit $ExpectedSubjectCommit) }
    if ($ExpectedRuntimePayloadSha256) {
        [void](Assert-DysonPrivateEvidenceDigest -Digest $ExpectedRuntimePayloadSha256 -Name 'ExpectedRuntimePayloadSha256')
    }
    $read = Read-DysonPrivateEvidenceManifest -EvidenceRoot $EvidenceRoot
    if ($ExpectedManifestSha256 -and -not [string]::Equals($read.sha256, $ExpectedManifestSha256, [System.StringComparison]::Ordinal)) {
        throw 'The private evidence manifest digest does not match the expected digest.'
    }
    $manifest = $read.manifest
    Assert-DysonPrivateEvidenceExactProperties -Value $manifest -Expected @(
        'protocol', 'schemaVersion', 'evidenceId', 'kind', 'scope', 'subjectCommit',
        'runtimePayloadSha256', 'opaqueId', 'observedAt', 'requirementIds', 'limits', 'payload'
    ) -Name 'The private evidence manifest'
    Assert-DysonPrivateEvidenceExactProperties -Value $manifest.limits -Expected @(
        'maximumFiles', 'maximumDirectories', 'maximumTotalBytes', 'maximumSingleFileBytes'
    ) -Name 'The private evidence limits'
    Assert-DysonPrivateEvidenceExactProperties -Value $manifest.payload -Expected @(
        'fileCount', 'totalBytes', 'sha256', 'files'
    ) -Name 'The private evidence payload summary'
    $schemaVersion = Get-DysonPrivateEvidenceJsonInteger -Value $manifest.schemaVersion -Minimum 1 -Maximum 1 `
        -Name 'The private evidence schema version'
    if ([string]$manifest.protocol -cne $script:DysonPrivateEvidenceProtocol -or
        $schemaVersion -ne $script:DysonPrivateEvidenceSchemaVersion -or
        [string]$manifest.evidenceId -cne $normalizedEvidenceId -or
        [string]$manifest.opaqueId -cne ('private:' + $normalizedEvidenceId)) {
        throw 'The private evidence manifest identity is invalid.'
    }
    [void](Assert-DysonPrivateEvidenceKind -Kind ([string]$manifest.kind))
    [void](Assert-DysonPrivateEvidenceScope -Scope ([string]$manifest.scope))
    [void](Assert-DysonPrivateEvidenceCommit -Commit ([string]$manifest.subjectCommit))
    [void](Assert-DysonPrivateEvidenceDigest -Digest ([string]$manifest.runtimePayloadSha256) -Name 'runtimePayloadSha256')
    [void](Assert-DysonPrivateEvidenceDigest -Digest ([string]$manifest.payload.sha256) -Name 'payload.sha256')
    if ($ExpectedSubjectCommit -and [string]$manifest.subjectCommit -cne $ExpectedSubjectCommit) {
        throw 'The private evidence subject commit does not match the expected commit.'
    }
    if ($ExpectedRuntimePayloadSha256 -and [string]$manifest.runtimePayloadSha256 -cne $ExpectedRuntimePayloadSha256) {
        throw 'The private evidence runtime payload does not match the expected payload.'
    }
    $observedAt = ConvertTo-DysonPrivateEvidenceObservedAt -ObservedAt ([string]$manifest.observedAt)
    if ([string]$manifest.observedAt -cne $observedAt) { throw 'The private evidence observation time is not canonical.' }
    if ($manifest.requirementIds -isnot [System.Array]) {
        throw 'The private evidence requirement list must be a JSON array.'
    }
    $requirements = Get-DysonPrivateEvidenceRequirementIds -RequirementIds ([string[]]@($manifest.requirementIds))
    if ([string]::Join("`n", $requirements) -cne [string]::Join("`n", [string[]]@($manifest.requirementIds))) {
        throw 'The private evidence requirement list is not canonical.'
    }
    $maximumFiles = Get-DysonPrivateEvidenceJsonInteger -Value $manifest.limits.maximumFiles -Minimum 1 `
        -Maximum $script:DysonPrivateEvidenceMaximumFiles -Name 'The private evidence maximum file count'
    $maximumDirectories = Get-DysonPrivateEvidenceJsonInteger -Value $manifest.limits.maximumDirectories -Minimum 1 `
        -Maximum $script:DysonPrivateEvidenceMaximumDirectories -Name 'The private evidence maximum directory count'
    $maximumTotalBytes = Get-DysonPrivateEvidenceJsonInteger -Value $manifest.limits.maximumTotalBytes -Minimum 1 `
        -Maximum $script:DysonPrivateEvidenceMaximumTotalBytes -Name 'The private evidence maximum total size'
    $maximumSingleFileBytes = Get-DysonPrivateEvidenceJsonInteger -Value $manifest.limits.maximumSingleFileBytes -Minimum 1 `
        -Maximum $script:DysonPrivateEvidenceMaximumSingleFileBytes -Name 'The private evidence maximum file size'
    if ($maximumFiles -ne $script:DysonPrivateEvidenceMaximumFiles -or
        $maximumDirectories -ne $script:DysonPrivateEvidenceMaximumDirectories -or
        $maximumTotalBytes -ne $script:DysonPrivateEvidenceMaximumTotalBytes -or
        $maximumSingleFileBytes -ne $script:DysonPrivateEvidenceMaximumSingleFileBytes) {
        throw 'The private evidence manifest limits are unsupported.'
    }
    if ($manifest.payload.files -isnot [System.Array]) {
        throw 'The private evidence manifest file list must be a JSON array.'
    }
    $manifestFiles = @($manifest.payload.files)
    $manifestFileCount = Get-DysonPrivateEvidenceJsonInteger -Value $manifest.payload.fileCount -Minimum 1 `
        -Maximum $script:DysonPrivateEvidenceMaximumFiles -Name 'The private evidence manifest file count'
    if ($manifestFiles.Count -lt 1 -or $manifestFiles.Count -gt $script:DysonPrivateEvidenceMaximumFiles -or
        $manifestFileCount -ne $manifestFiles.Count) {
        throw 'The private evidence manifest file count is invalid.'
    }
    $canonicalManifestFiles = @()
    $seenPaths = @{}
    foreach ($file in $manifestFiles) {
        Assert-DysonPrivateEvidenceExactProperties -Value $file -Expected @('path', 'length', 'sha256') -Name 'A private evidence file entry'
        $relative = Assert-DysonPrivateEvidenceRelativePath -Path ([string]$file.path)
        $key = $relative.ToLowerInvariant()
        if ($seenPaths.ContainsKey($key)) { throw 'The private evidence manifest contains a duplicate file path.' }
        $seenPaths[$key] = $true
        $length = Get-DysonPrivateEvidenceJsonInteger -Value $file.length -Minimum 0 `
            -Maximum $script:DysonPrivateEvidenceMaximumSingleFileBytes -Name 'A private evidence manifest file length'
        [void](Assert-DysonPrivateEvidenceDigest -Digest ([string]$file.sha256) -Name 'file.sha256')
        $canonicalManifestFiles += [ordered]@{ path = $relative; length = $length; sha256 = [string]$file.sha256 }
    }
    $manifestPaths = [string[]]@($canonicalManifestFiles | ForEach-Object { $_.path })
    $sortedManifestPaths = [string[]]@($manifestPaths)
    [System.Array]::Sort($sortedManifestPaths, [System.StringComparer]::Ordinal)
    if ([string]::Join("`n", $manifestPaths) -cne [string]::Join("`n", $sortedManifestPaths)) {
        throw 'The private evidence manifest file list is not canonical.'
    }
    $manifestTotalBytes = Get-DysonPrivateEvidenceJsonInteger -Value $manifest.payload.totalBytes -Minimum 0 `
        -Maximum $script:DysonPrivateEvidenceMaximumTotalBytes -Name 'The private evidence manifest total size'
    $expectedInventory = [ordered]@{
        fileCount = [int]$manifestFileCount
        totalBytes = $manifestTotalBytes
        sha256 = [string]$manifest.payload.sha256
        files = $canonicalManifestFiles
    }
    $payloadRoot = Join-Path $read.root 'payload'
    $actualInventory = Get-DysonPrivateEvidenceInventory -Root $payloadRoot
    Assert-DysonPrivateEvidenceInventoriesEqual -Expected $expectedInventory -Actual $actualInventory
    return [ordered]@{
        protocol = $script:DysonPrivateEvidenceReferenceProtocol
        ready = $true
        evidenceId = $normalizedEvidenceId
        kind = [string]$manifest.kind
        scope = [string]$manifest.scope
        subjectCommit = [string]$manifest.subjectCommit
        runtimePayloadSha256 = [string]$manifest.runtimePayloadSha256
        opaqueId = [string]$manifest.opaqueId
        sha256 = [string]$read.sha256
        observedAt = $observedAt
        requirementIds = $requirements
        fileCount = [int]$actualInventory.fileCount
        totalBytes = [int64]$actualInventory.totalBytes
        productionChanged = $false
    }
}

function Remove-DysonPrivateEvidencePartialTree {
    param(
        [Parameter(Mandatory)][string]$Path,
        [Parameter(Mandatory)][string]$Parent
    )

    $full = Get-DysonPrivateEvidenceFullPath -Path $Path
    $parentFull = (Get-DysonPrivateEvidenceFullPath -Path $Parent).TrimEnd('\', '/') + [System.IO.Path]::DirectorySeparatorChar
    if (-not $full.StartsWith($parentFull, [System.StringComparison]::OrdinalIgnoreCase) -or
        -not ([System.IO.Path]::GetFileName($full)).StartsWith('.partial-', [System.StringComparison]::Ordinal)) {
        throw 'Refusing to remove an unexpected evidence partial directory.'
    }
    if (Test-Path -LiteralPath $full) { Remove-Item -LiteralPath $full -Recurse -Force -ErrorAction Stop }
}
