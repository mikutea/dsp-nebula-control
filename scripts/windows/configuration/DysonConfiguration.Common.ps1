$script:DysonConfigurationContractProtocol = 'DYSON_CONTROL_ENVIRONMENT_CONTRACT_V1'
$script:DysonConfigurationIntentProtocol = 'DYSON_CONTROL_CONFIGURATION_INTENT_V2'
$script:DysonConfigurationReceiptProtocol = 'DYSON_CONTROL_CONFIGURATION_RECEIPT_V2'
$script:DysonConfigurationSnapshotProtocol = 'DYSON_CONTROL_CONFIGURATION_SNAPSHOT_V2'
$script:DysonConfigurationSchemaVersion = 2
$script:DysonConfigurationFileName = 'dyson-control.env'
$script:DysonConfigurationRuntimeApprovalName = 'dyson-control.runtime.json'
$script:DysonConfigurationContractName = 'dyson-control.environment-contract.json'
$script:DysonConfigurationSnapshotManifestName = 'configuration-snapshot.json'
$script:DysonConfigurationLockName = 'configuration.lock'
$script:DysonConfigurationSnapshotRootName = 'configuration-snapshots'
$script:DysonConfigurationSystemSid = 'S-1-5-18'
$script:DysonConfigurationAdministratorsSid = 'S-1-5-32-544'

function Get-DysonConfigurationFullPath {
    param([Parameter(Mandatory)][string]$Path)

    if ([string]::IsNullOrWhiteSpace($Path) -or $Path.IndexOf([char]0) -ge 0 -or
        $Path -match '[\r\n"]') {
        throw 'DYSON_CONFIGURATION_PATH_INVALID'
    }
    if ([System.IO.Path]::IsPathRooted($Path)) {
        return [System.IO.Path]::GetFullPath($Path)
    }
    return [System.IO.Path]::GetFullPath((Join-Path (Get-Location).ProviderPath $Path))
}

function ConvertTo-DysonConfigurationExtendedPath {
    param([Parameter(Mandatory)][string]$Path)

    if ($Path.StartsWith('\\?\', [System.StringComparison]::Ordinal)) {
        return $Path
    }
    $fullPath = Get-DysonConfigurationFullPath $Path
    if ($fullPath.StartsWith('\\?\', [System.StringComparison]::Ordinal)) {
        return $fullPath
    }
    if ($fullPath.StartsWith('\\', [System.StringComparison]::Ordinal)) {
        return '\\?\UNC\' + $fullPath.Substring(2)
    }
    return '\\?\' + $fullPath
}

function Test-DysonConfigurationPathWithin {
    param(
        [Parameter(Mandatory)][string]$Candidate,
        [Parameter(Mandatory)][string]$Parent,
        [switch]$AllowEqual
    )

    $candidateFull = (Get-DysonConfigurationFullPath $Candidate).TrimEnd('\', '/')
    $parentFull = (Get-DysonConfigurationFullPath $Parent).TrimEnd('\', '/')
    if ($AllowEqual -and [string]::Equals(
            $candidateFull, $parentFull, [System.StringComparison]::OrdinalIgnoreCase
        )) { return $true }
    return $candidateFull.StartsWith(
        $parentFull + [System.IO.Path]::DirectorySeparatorChar,
        [System.StringComparison]::OrdinalIgnoreCase
    )
}

function Test-DysonConfigurationFullyQualifiedWindowsPath {
    param([Parameter(Mandatory)][AllowEmptyString()][string]$Path)

    if ([string]::IsNullOrWhiteSpace($Path) -or $Path.IndexOf([char]0) -ge 0 -or
        $Path -match '[\r\n"]') {
        return $false
    }
    $hasDriveRoot = $Path -cmatch '^[A-Za-z]:[\\/]'
    $hasUncRoot = $Path -cmatch '^[\\/]{2}[^\\/]+[\\/][^\\/]+(?:[\\/]|$)'
    if (-not $hasDriveRoot -and -not $hasUncRoot) { return $false }
    try {
        [void][System.IO.Path]::GetFullPath($Path)
        return $true
    }
    catch { return $false }
}

function Test-DysonConfigurationAbsoluteNonRootWindowsPath {
    param([Parameter(Mandatory)][AllowEmptyString()][string]$Path)

    if (-not (Test-DysonConfigurationFullyQualifiedWindowsPath -Path $Path)) { return $false }
    try {
        $fullPath = [System.IO.Path]::GetFullPath($Path).TrimEnd('\', '/')
        $root = [System.IO.Path]::GetPathRoot($fullPath).TrimEnd('\', '/')
        return -not [string]::Equals(
            $fullPath, $root, [System.StringComparison]::OrdinalIgnoreCase
        )
    }
    catch { return $false }
}

function Test-DysonConfigurationPathsDisjoint {
    param(
        [Parameter(Mandatory)][string]$Left,
        [Parameter(Mandatory)][string]$Right
    )

    try {
        $leftFull = Get-DysonConfigurationFullPath $Left
        $rightFull = Get-DysonConfigurationFullPath $Right
        $leftComparable = $leftFull.TrimEnd('\', '/')
        $rightComparable = $rightFull.TrimEnd('\', '/')
        if ([string]::Equals(
                $leftComparable, $rightComparable, [System.StringComparison]::OrdinalIgnoreCase
            )) {
            return $false
        }
        $separator = [System.IO.Path]::DirectorySeparatorChar
        $leftPrefix = $leftComparable + $separator
        $rightPrefix = $rightComparable + $separator
        return -not $rightFull.StartsWith(
            $leftPrefix, [System.StringComparison]::OrdinalIgnoreCase
        ) -and -not $leftFull.StartsWith(
            $rightPrefix, [System.StringComparison]::OrdinalIgnoreCase
        )
    }
    catch { return $false }
}

function Get-DysonConfigurationStrictBoolean {
    param(
        [Parameter(Mandatory)][hashtable]$Values,
        [Parameter(Mandatory)][string]$Name
    )

    if (-not $Values.ContainsKey($Name)) { return $false }
    $value = [string]$Values[$Name]
    if ($value -cne 'true' -and $value -cne 'false') {
        throw 'DYSON_CONFIGURATION_CONTENT_INVALID'
    }
    return $value -ceq 'true'
}

function Assert-DysonConfigurationNebulaPluginEnvironment {
    param([Parameter(Mandatory)][hashtable]$Values)

    $transactionEnabled = Get-DysonConfigurationStrictBoolean -Values $Values `
        -Name 'DYSON_NEBULA_PLUGIN_TRANSACTION_ENABLED'
    $recoveryEnabled = Get-DysonConfigurationStrictBoolean -Values $Values `
        -Name 'DYSON_NEBULA_PLUGIN_TRANSACTION_RECOVERY_ENABLED'

    $jobBase = $null
    if ($Values.ContainsKey('DYSON_NEBULA_PLUGIN_JOB_BASE')) {
        $jobBase = [string]$Values['DYSON_NEBULA_PLUGIN_JOB_BASE']
        if (-not (Test-DysonConfigurationAbsoluteNonRootWindowsPath -Path $jobBase)) {
            throw 'DYSON_CONFIGURATION_CONTENT_INVALID'
        }
        $jobBase = Get-DysonConfigurationFullPath $jobBase
    }

    if ($null -eq $jobBase -and -not $transactionEnabled -and -not $recoveryEnabled) { return }
    if ([string]$Values['DYSON_PROVIDER'] -cne 'windows' -or
        [string]::IsNullOrWhiteSpace($jobBase)) {
        throw 'DYSON_CONFIGURATION_CONTENT_INVALID'
    }

    foreach ($name in @('DYSON_PROJECT_ROOT', 'DYSON_DATA_DIR', 'DYSON_SCRIPT_ROOT')) {
        if (-not $Values.ContainsKey($name) -or
            -not (Test-DysonConfigurationFullyQualifiedWindowsPath -Path ([string]$Values[$name]))) {
            throw 'DYSON_CONFIGURATION_CONTENT_INVALID'
        }
    }

    $projectRoot = Get-DysonConfigurationFullPath ([string]$Values['DYSON_PROJECT_ROOT'])
    $serverRoot = Get-DysonConfigurationFullPath (Join-Path $projectRoot 'server')
    $dataRoot = Get-DysonConfigurationFullPath ([string]$Values['DYSON_DATA_DIR'])
    if (-not (Test-DysonConfigurationAbsoluteNonRootWindowsPath -Path $serverRoot) -or
        -not (Test-DysonConfigurationAbsoluteNonRootWindowsPath -Path $dataRoot) -or
        -not (Test-DysonConfigurationPathsDisjoint -Left $serverRoot -Right $dataRoot)) {
        throw 'DYSON_CONFIGURATION_CONTENT_INVALID'
    }
    foreach ($deniedRoot in @($projectRoot, $serverRoot, $dataRoot)) {
        if (-not (Test-DysonConfigurationPathsDisjoint -Left $jobBase -Right $deniedRoot)) {
            throw 'DYSON_CONFIGURATION_CONTENT_INVALID'
        }
    }
}

function Get-DysonConfigurationSha256Bytes {
    param([Parameter(Mandatory)][AllowEmptyCollection()][byte[]]$Bytes)

    $algorithm = [System.Security.Cryptography.SHA256]::Create()
    try {
        return ([System.BitConverter]::ToString($algorithm.ComputeHash($Bytes))).Replace('-', '').ToLowerInvariant()
    }
    finally { $algorithm.Dispose() }
}

function Get-DysonConfigurationSha256Text {
    param([Parameter(Mandatory)][AllowEmptyString()][string]$Text)
    return Get-DysonConfigurationSha256Bytes ([System.Text.UTF8Encoding]::new($false, $true).GetBytes($Text))
}

function ConvertTo-DysonConfigurationJson {
    param([Parameter(Mandatory)]$Value)
    return ($Value | ConvertTo-Json -Depth 12 -Compress)
}

function Assert-DysonConfigurationExactProperties {
    param(
        [Parameter(Mandatory)]$Value,
        [Parameter(Mandatory)][string[]]$Expected
    )

    if ($null -eq $Value -or $null -eq $Value.PSObject) {
        throw 'DYSON_CONFIGURATION_RECORD_INVALID'
    }
    $actual = @($Value.PSObject.Properties.Name | Sort-Object)
    $wanted = @($Expected | Sort-Object)
    if ($actual.Count -ne $wanted.Count) { throw 'DYSON_CONFIGURATION_RECORD_INVALID' }
    for ($index = 0; $index -lt $wanted.Count; $index += 1) {
        if ([string]$actual[$index] -cne [string]$wanted[$index]) {
            throw 'DYSON_CONFIGURATION_RECORD_INVALID'
        }
    }
}

function Assert-DysonConfigurationCanonicalSha256 {
    param([Parameter(Mandatory)][string]$Value)
    if ($Value -cnotmatch '^[0-9a-f]{64}$') { throw 'DYSON_CONFIGURATION_RECORD_INVALID' }
    return $Value
}

function Assert-DysonConfigurationCanonicalGuid {
    param([Parameter(Mandatory)][string]$Value)

    $parsed = [guid]::Empty
    if (-not [guid]::TryParseExact($Value, 'D', [ref]$parsed) -or
        $Value -cne $parsed.ToString('D').ToLowerInvariant()) {
        throw 'DYSON_CONFIGURATION_RECORD_INVALID'
    }
    return $Value
}

function Assert-DysonConfigurationCanonicalTimestamp {
    param([Parameter(Mandatory)][string]$Value)

    $parsed = [datetimeoffset]::MinValue
    if (-not [datetimeoffset]::TryParseExact(
            $Value, 'o', [Globalization.CultureInfo]::InvariantCulture,
            [Globalization.DateTimeStyles]::RoundtripKind, [ref]$parsed
        )) {
        throw 'DYSON_CONFIGURATION_RECORD_INVALID'
    }
    if ($Value -cne $parsed.UtcDateTime.ToString('o')) {
        throw 'DYSON_CONFIGURATION_RECORD_INVALID'
    }
    return $Value
}

function Assert-DysonConfigurationLocalNtfsPath {
    param([Parameter(Mandatory)][string]$Path)

    $fullPath = Get-DysonConfigurationFullPath $Path
    $root = [System.IO.Path]::GetPathRoot($fullPath)
    if ($root -cnotmatch '^[A-Za-z]:\\$') {
        throw 'DYSON_CONFIGURATION_LOCAL_NTFS_REQUIRED'
    }
    try {
        $drive = [System.IO.DriveInfo]::new($root)
        if (-not $drive.IsReady -or
            $drive.DriveType -ne [System.IO.DriveType]::Fixed -or
            -not [string]::Equals($drive.DriveFormat, 'NTFS', [System.StringComparison]::OrdinalIgnoreCase)) {
            throw 'invalid volume'
        }
    }
    catch { throw 'DYSON_CONFIGURATION_LOCAL_NTFS_REQUIRED' }
    return $fullPath
}

function Assert-DysonConfigurationPlainDirectoryChain {
    param([Parameter(Mandatory)][string]$Path)

    $fullPath = Assert-DysonConfigurationLocalNtfsPath $Path
    $target = Get-Item -LiteralPath (ConvertTo-DysonConfigurationExtendedPath $fullPath) `
        -Force -ErrorAction Stop
    if (-not $target.PSIsContainer -or
        ($target.Attributes -band [System.IO.FileAttributes]::ReparsePoint)) {
        throw 'DYSON_CONFIGURATION_REDIRECTED_PATH'
    }
    $root = [System.IO.Path]::GetPathRoot($fullPath).TrimEnd('\', '/')
    $current = $fullPath.TrimEnd('\', '/')
    while (-not [string]::Equals($current, $root, [System.StringComparison]::OrdinalIgnoreCase)) {
        $item = Get-Item -LiteralPath (ConvertTo-DysonConfigurationExtendedPath $current) `
            -Force -ErrorAction Stop
        if (-not $item.PSIsContainer -or
            ($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint)) {
            throw 'DYSON_CONFIGURATION_REDIRECTED_PATH'
        }
        $parent = [System.IO.Path]::GetDirectoryName($current)
        if ([string]::IsNullOrWhiteSpace($parent) -or
            [string]::Equals($parent, $current, [System.StringComparison]::OrdinalIgnoreCase)) { break }
        $current = $parent.TrimEnd('\', '/')
    }
    return $fullPath
}

function Assert-DysonConfigurationPlainFilePath {
    param(
        [Parameter(Mandatory)][string]$Path,
        [int64]$MaximumBytes = 65536,
        [switch]$AllowEmpty
    )

    $fullPath = Assert-DysonConfigurationLocalNtfsPath $Path
    $item = Get-Item -LiteralPath (ConvertTo-DysonConfigurationExtendedPath $fullPath) `
        -Force -ErrorAction Stop
    if ($item.PSIsContainer -or
        ($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -or
        (-not $AllowEmpty -and $item.Length -lt 1) -or
        $item.Length -gt $MaximumBytes) {
        throw 'DYSON_CONFIGURATION_FILE_INVALID'
    }
    [void](Assert-DysonConfigurationPlainDirectoryChain ([System.IO.Path]::GetDirectoryName($fullPath)))
    return $fullPath
}

function Assert-DysonConfigurationModuleFilePath {
    param(
        [Parameter(Mandatory)][string]$Path,
        [int64]$MaximumBytes = 32768
    )

    # The shipped contract may be inspected from a read-only release share during
    # qualification. Configuration sources and destinations use the stricter
    # local-NTFS validator; this validator only protects the module asset itself.
    $fullPath = Get-DysonConfigurationFullPath $Path
    $item = Get-Item -LiteralPath $fullPath -Force -ErrorAction Stop
    if ($item.PSIsContainer -or
        ($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -or
        $item.Length -lt 1 -or $item.Length -gt $MaximumBytes) {
        throw 'DYSON_CONFIGURATION_CONTRACT_INVALID'
    }
    $root = [System.IO.Path]::GetPathRoot($item.FullName).TrimEnd('\', '/')
    $current = [System.IO.Path]::GetDirectoryName($item.FullName).TrimEnd('\', '/')
    while (-not [string]::Equals($current, $root, [System.StringComparison]::OrdinalIgnoreCase)) {
        $directory = Get-Item -LiteralPath $current -Force -ErrorAction Stop
        if (-not $directory.PSIsContainer -or
            ($directory.Attributes -band [System.IO.FileAttributes]::ReparsePoint)) {
            throw 'DYSON_CONFIGURATION_CONTRACT_INVALID'
        }
        $parent = [System.IO.Path]::GetDirectoryName($current)
        if ([string]::IsNullOrWhiteSpace($parent) -or
            [string]::Equals($parent, $current, [System.StringComparison]::OrdinalIgnoreCase)) { break }
        $current = $parent.TrimEnd('\', '/')
    }
    return $item.FullName
}

function Get-DysonConfigurationContract {
    param([string]$ContractPath = (Join-Path $PSScriptRoot $script:DysonConfigurationContractName))

    $contractFull = Assert-DysonConfigurationModuleFilePath -Path $ContractPath -MaximumBytes 32768
    $bytes = [System.IO.File]::ReadAllBytes($contractFull)
    try {
        $json = [System.Text.UTF8Encoding]::new($false, $true).GetString($bytes)
        $raw = $json | ConvertFrom-Json -ErrorAction Stop
    }
    catch { throw 'DYSON_CONFIGURATION_CONTRACT_INVALID' }
    Assert-DysonConfigurationExactProperties -Value $raw -Expected @(
        'protocol', 'schemaVersion', 'maximumBytes', 'bomPolicy', 'requiredProductionNames',
        'launcherOwnedNames', 'secretNames', 'dysonNames'
    )
    if ([string]$raw.protocol -cne $script:DysonConfigurationContractProtocol -or
        [int]$raw.schemaVersion -ne 1 -or [int]$raw.maximumBytes -ne 65536 -or
        [string]$raw.bomPolicy -cne 'forbidden') {
        throw 'DYSON_CONFIGURATION_CONTRACT_INVALID'
    }
    $dysonNames = @($raw.dysonNames | ForEach-Object { [string]$_ })
    if ($dysonNames.Count -lt 1 -or $dysonNames.Count -gt 128 -or
        @($dysonNames | Where-Object { $_ -cnotmatch '^DYSON_[A-Z0-9_]{1,96}$' }).Count -ne 0 -or
        @($dysonNames | Sort-Object -Unique).Count -ne $dysonNames.Count) {
        throw 'DYSON_CONFIGURATION_CONTRACT_INVALID'
    }
    $allowed = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::Ordinal)
    [void]$allowed.Add('NODE_ENV')
    foreach ($name in $dysonNames) { [void]$allowed.Add($name) }
    foreach ($propertyName in @('requiredProductionNames', 'launcherOwnedNames', 'secretNames')) {
        $values = @($raw.$propertyName | ForEach-Object { [string]$_ })
        if ($values.Count -eq 0 -or @($values | Sort-Object -Unique).Count -ne $values.Count) {
            throw 'DYSON_CONFIGURATION_CONTRACT_INVALID'
        }
        foreach ($name in $values) {
            if (-not $allowed.Contains($name)) { throw 'DYSON_CONFIGURATION_CONTRACT_INVALID' }
        }
    }
    return [pscustomobject][ordered]@{
        path = $contractFull
        sha256 = Get-DysonConfigurationSha256Bytes $bytes
        maximumBytes = 65536
        allowedNames = $allowed
        dysonNames = $dysonNames
        requiredProductionNames = @($raw.requiredProductionNames | ForEach-Object { [string]$_ })
        launcherOwnedNames = @($raw.launcherOwnedNames | ForEach-Object { [string]$_ })
        secretNames = @($raw.secretNames | ForEach-Object { [string]$_ })
    }
}

function Assert-DysonConfigurationExpectedBindings {
    param(
        [Parameter(Mandatory)]$Contract,
        [Parameter(Mandatory)][hashtable]$ExpectedLauncherBindings
    )

    $actual = @($ExpectedLauncherBindings.Keys | ForEach-Object { [string]$_ } | Sort-Object)
    $expected = @($Contract.launcherOwnedNames | ForEach-Object { [string]$_ } | Sort-Object)
    if ($actual.Count -ne $expected.Count) { throw 'DYSON_CONFIGURATION_BINDINGS_INVALID' }
    for ($index = 0; $index -lt $expected.Count; $index += 1) {
        if ([string]$actual[$index] -cne [string]$expected[$index] -or
            [string]::IsNullOrEmpty([string]$ExpectedLauncherBindings[$actual[$index]])) {
            throw 'DYSON_CONFIGURATION_BINDINGS_INVALID'
        }
    }
    if ([string]$ExpectedLauncherBindings['NODE_ENV'] -cne 'production' -or
        [string]$ExpectedLauncherBindings['DYSON_HOST'] -cne '127.0.0.1') {
        throw 'DYSON_CONFIGURATION_BINDINGS_INVALID'
    }
}

function Get-DysonConfigurationExpectedBindingsHash {
    param(
        [Parameter(Mandatory)][hashtable]$ExpectedLauncherBindings,
        $Contract
    )

    if ($null -ne $Contract) {
        Assert-DysonConfigurationExpectedBindings -Contract $Contract `
            -ExpectedLauncherBindings $ExpectedLauncherBindings
    }

    $lines = @($ExpectedLauncherBindings.Keys | Sort-Object | ForEach-Object {
        ([string]$_) + '=' + ([string]$ExpectedLauncherBindings[$_])
    })
    return Get-DysonConfigurationSha256Text ([string]::Join("`n", $lines))
}

function Read-DysonControlEnvironmentBytes {
    param(
        [Parameter(Mandatory)][byte[]]$Bytes,
        [Parameter(Mandatory)]$Contract,
        [Parameter(Mandatory)][hashtable]$ExpectedLauncherBindings
    )

    Assert-DysonConfigurationExpectedBindings -Contract $Contract `
        -ExpectedLauncherBindings $ExpectedLauncherBindings
    if ($Bytes.Length -lt 1 -or $Bytes.Length -gt [int]$Contract.maximumBytes) {
        throw 'DYSON_CONFIGURATION_CONTENT_INVALID'
    }
    if ($Bytes.Length -ge 3 -and $Bytes[0] -eq 0xEF -and $Bytes[1] -eq 0xBB -and $Bytes[2] -eq 0xBF) {
        throw 'DYSON_CONFIGURATION_CONTENT_INVALID'
    }
    try { $text = [System.Text.UTF8Encoding]::new($false, $true).GetString($Bytes) }
    catch { throw 'DYSON_CONFIGURATION_CONTENT_INVALID' }
    if ($text -match "`r(?!`n)") { throw 'DYSON_CONFIGURATION_CONTENT_INVALID' }
    foreach ($character in $text.ToCharArray()) {
        $code = [int][char]$character
        $category = [Globalization.CharUnicodeInfo]::GetUnicodeCategory($character)
        if (($category -eq [Globalization.UnicodeCategory]::Control -and
                $character -ne "`r" -and $character -ne "`n") -or
            $category -in @(
                [Globalization.UnicodeCategory]::LineSeparator,
                [Globalization.UnicodeCategory]::ParagraphSeparator
            ) -or $code -eq 0xFFFD) {
            throw 'DYSON_CONFIGURATION_CONTENT_INVALID'
        }
    }
    $values = @{}
    $names = [System.Collections.Generic.List[string]]::new()
    foreach ($line in @($text -split "`r?`n", -1)) {
        if ($line.Length -eq 0 -or $line.StartsWith('#')) { continue }
        $separator = $line.IndexOf('=')
        if ($separator -lt 1) { throw 'DYSON_CONFIGURATION_CONTENT_INVALID' }
        $name = $line.Substring(0, $separator)
        $value = $line.Substring($separator + 1)
        if (($name -cne 'NODE_ENV' -and $name -cnotmatch '^DYSON_[A-Z0-9_]{1,96}$') -or
            -not $Contract.allowedNames.Contains($name) -or $values.ContainsKey($name)) {
            throw 'DYSON_CONFIGURATION_CONTENT_INVALID'
        }
        $values[$name] = $value
        $names.Add($name)
    }
    foreach ($required in @($Contract.requiredProductionNames)) {
        if (-not $values.ContainsKey($required) -or [string]::IsNullOrEmpty([string]$values[$required])) {
            throw 'DYSON_CONFIGURATION_CONTENT_INVALID'
        }
    }
    if ([string]$values['NODE_ENV'] -cne 'production' -or
        [string]$values['DYSON_HOST'] -cne '127.0.0.1' -or
        ([string]$values['DYSON_SESSION_SECRET']).Length -lt 32) {
        throw 'DYSON_CONFIGURATION_CONTENT_INVALID'
    }
    if ($values.ContainsKey('DYSON_CONSOLE_CURSOR_SECRET') -and
        ([string]$values['DYSON_CONSOLE_CURSOR_SECRET']).Length -lt 32) {
        throw 'DYSON_CONFIGURATION_CONTENT_INVALID'
    }
    foreach ($name in @($ExpectedLauncherBindings.Keys)) {
        $bindingName = [string]$name
        if (-not $Contract.allowedNames.Contains($bindingName) -or
            $bindingName -cnotin @($Contract.launcherOwnedNames) -or
            -not $values.ContainsKey($bindingName) -or
            [string]$values[$bindingName] -cne [string]$ExpectedLauncherBindings[$bindingName]) {
            throw 'DYSON_CONFIGURATION_CONTENT_INVALID'
        }
    }
    Assert-DysonConfigurationNebulaPluginEnvironment -Values $values
    return [pscustomobject][ordered]@{
        sha256 = Get-DysonConfigurationSha256Bytes $Bytes
        length = [int64]$Bytes.Length
        names = @($names | Sort-Object)
        namesSha256 = Get-DysonConfigurationSha256Text ([string]::Join("`n", @($names | Sort-Object)))
        bindingsSha256 = Get-DysonConfigurationExpectedBindingsHash `
            -ExpectedLauncherBindings $ExpectedLauncherBindings -Contract $Contract
        contractSha256 = [string]$Contract.sha256
        privateBytes = $Bytes
        privateValues = $values
    }
}

function Get-DysonConfigurationPathBindingSha256 {
    param([Parameter(Mandatory)][string]$Path)

    $canonical = (Get-DysonConfigurationFullPath $Path).TrimEnd('\', '/').ToLowerInvariant()
    return Get-DysonConfigurationSha256Text $canonical
}

function Assert-DysonConfigurationDataRootBinding {
    param(
        [Parameter(Mandatory)][string]$DataRoot,
        [Parameter(Mandatory)][hashtable]$ExpectedLauncherBindings
    )

    $expectedDataDirectory = Get-DysonConfigurationFullPath (Join-Path $DataRoot 'data')
    $configuredDataDirectory = Get-DysonConfigurationFullPath `
        ([string]$ExpectedLauncherBindings['DYSON_DATA_DIR'])
    if (-not [string]::Equals(
            $expectedDataDirectory.TrimEnd('\', '/'),
            $configuredDataDirectory.TrimEnd('\', '/'),
            [System.StringComparison]::OrdinalIgnoreCase
        )) {
        throw 'DYSON_CONFIGURATION_PROFILE_BINDING_INVALID'
    }
}

function Read-DysonControlEnvironmentFile {
    param(
        [Parameter(Mandatory)][string]$Path,
        [Parameter(Mandatory)]$Contract,
        [Parameter(Mandatory)][hashtable]$ExpectedLauncherBindings,
        [switch]$SkipSourceAcl
    )

    $fullPath = Assert-DysonConfigurationPlainFilePath -Path $Path -MaximumBytes ([int64]$Contract.maximumBytes)
    $stream = [System.IO.FileStream]::new(
        $fullPath,
        [System.IO.FileMode]::Open,
        [System.IO.FileAccess]::Read,
        [System.IO.FileShare]::Read,
        4096,
        [System.IO.FileOptions]::SequentialScan
    )
    try {
        $revalidatedPath = Assert-DysonConfigurationPlainFilePath -Path $fullPath `
            -MaximumBytes ([int64]$Contract.maximumBytes)
        if (-not [string]::Equals(
                $revalidatedPath, $fullPath, [System.StringComparison]::OrdinalIgnoreCase
            )) {
            throw 'DYSON_CONFIGURATION_FILE_INVALID'
        }
        if (-not $SkipSourceAcl) {
            [void](Assert-DysonConfigurationPrivateSourceAcl -Path $fullPath)
        }
        if ($stream.Length -lt 1 -or $stream.Length -gt [int64]$Contract.maximumBytes) {
            throw 'DYSON_CONFIGURATION_CONTENT_INVALID'
        }
        $bytes = New-Object byte[] ([int]$stream.Length)
        $offset = 0
        while ($offset -lt $bytes.Length) {
            $read = $stream.Read($bytes, $offset, $bytes.Length - $offset)
            if ($read -le 0) { throw 'DYSON_CONFIGURATION_CONTENT_INVALID' }
            $offset += $read
        }
        if ($stream.Position -ne $stream.Length) { throw 'DYSON_CONFIGURATION_CONTENT_INVALID' }
        return Read-DysonControlEnvironmentBytes -Bytes $bytes -Contract $Contract `
            -ExpectedLauncherBindings $ExpectedLauncherBindings
    }
    finally { $stream.Dispose() }
}

function Resolve-DysonConfigurationServiceSid {
    param([Parameter(Mandatory)][string]$ServiceAccount)

    switch ($ServiceAccount) {
        'NT AUTHORITY\LOCAL SERVICE' { return 'S-1-5-19' }
        'NT AUTHORITY\NETWORK SERVICE' { return 'S-1-5-20' }
        'SYSTEM' { return $script:DysonConfigurationSystemSid }
        default { throw 'DYSON_CONFIGURATION_SERVICE_ACCOUNT_INVALID' }
    }
}

function Get-DysonConfigurationWriteMask {
    $rights = [System.Security.AccessControl.FileSystemRights]
    $mask = [int64]0
    foreach ($name in @(
        'WriteData', 'AppendData', 'WriteExtendedAttributes', 'WriteAttributes',
        'DeleteSubdirectoriesAndFiles', 'Delete', 'ChangePermissions', 'TakeOwnership'
    )) { $mask = $mask -bor [int64]$rights::$name }
    return $mask
}

function Get-DysonConfigurationReadMask {
    $rights = [System.Security.AccessControl.FileSystemRights]
    $mask = [int64]0
    foreach ($name in @('ReadData', 'ReadExtendedAttributes', 'ReadAttributes', 'ReadPermissions', 'ExecuteFile')) {
        $mask = $mask -bor [int64]$rights::$name
    }
    return $mask
}

function Get-DysonConfigurationAclPolicy {
    param(
        [Parameter(Mandatory)][ValidateSet(
            'ConfigDirectory', 'ConfigFile', 'PrivateDirectory', 'PrivateFile', 'SourceFile'
        )][string]$Kind,
        [string]$ServiceSid,
        [string]$SourceOwnerSid
    )

    $isDirectory = $Kind.EndsWith('Directory')
    $inheritance = if ($isDirectory) {
        [System.Security.AccessControl.InheritanceFlags]'ContainerInherit, ObjectInherit'
    }
    else { [System.Security.AccessControl.InheritanceFlags]::None }
    $rules = [System.Collections.Generic.List[object]]::new()
    foreach ($sid in @($script:DysonConfigurationSystemSid, $script:DysonConfigurationAdministratorsSid)) {
        $rules.Add([pscustomobject][ordered]@{
            sid = $sid
            rights = [int64][System.Security.AccessControl.FileSystemRights]::FullControl
            inheritance = [int]$inheritance
            propagation = [int][System.Security.AccessControl.PropagationFlags]::None
            type = [int][System.Security.AccessControl.AccessControlType]::Allow
        })
    }
    $ownerSid = $script:DysonConfigurationAdministratorsSid
    if ($Kind -eq 'SourceFile') {
        if ([string]::IsNullOrWhiteSpace($SourceOwnerSid)) { throw 'DYSON_CONFIGURATION_ACL_INVALID' }
        $ownerSid = $SourceOwnerSid
        if ($SourceOwnerSid -notin @($script:DysonConfigurationSystemSid, $script:DysonConfigurationAdministratorsSid)) {
            $rules.Add([pscustomobject][ordered]@{
                sid = $SourceOwnerSid
                rights = [int64][System.Security.AccessControl.FileSystemRights]::FullControl
                inheritance = 0
                propagation = 0
                type = [int][System.Security.AccessControl.AccessControlType]::Allow
            })
        }
    }
    elseif ($Kind -in @('ConfigDirectory', 'ConfigFile') -and
        -not [string]::Equals($ServiceSid, $script:DysonConfigurationSystemSid,
            [System.StringComparison]::OrdinalIgnoreCase)) {
        if ([string]::IsNullOrWhiteSpace($ServiceSid)) { throw 'DYSON_CONFIGURATION_ACL_INVALID' }
        # FileSystemAccessRule normalizes every Allow ACE by adding Synchronize.
        # Model that mandatory, non-mutating bit in the policy so a freshly
        # applied ACL has the same canonical rights mask when read back from
        # NTFS.  The service still receives no write, delete, permission-change,
        # or ownership rights.
        $serviceRights = [int64][System.Security.AccessControl.FileSystemRights]::Synchronize
        $serviceRights = $serviceRights -bor $(if ($Kind -eq 'ConfigDirectory') {
                [int64][System.Security.AccessControl.FileSystemRights]::ReadAndExecute
            }
            else { [int64][System.Security.AccessControl.FileSystemRights]::Read })
        $rules.Add([pscustomobject][ordered]@{
            sid = $ServiceSid
            rights = $serviceRights
            inheritance = [int]$inheritance
            propagation = 0
            type = [int][System.Security.AccessControl.AccessControlType]::Allow
        })
    }
    $canonicalRules = @($rules | Sort-Object sid, rights | ForEach-Object {
        '{0}:{1}:{2}:{3}:{4}' -f $_.sid, $_.type, $_.rights, $_.inheritance, $_.propagation
    })
    $canonical = 'owner={0};protected=true;rules={1}' -f $ownerSid, ([string]::Join('|', $canonicalRules))
    return [pscustomobject][ordered]@{
        kind = $Kind
        ownerSid = $ownerSid
        rules = @($rules)
        canonical = $canonical
        fingerprint = Get-DysonConfigurationSha256Text $canonical
    }
}

function Set-DysonConfigurationAcl {
    param(
        [Parameter(Mandatory)][string]$Path,
        [Parameter(Mandatory)][ValidateSet(
            'ConfigDirectory', 'ConfigFile', 'PrivateDirectory', 'PrivateFile', 'SourceFile'
        )][string]$Kind,
        [string]$ServiceSid,
        [string]$SourceOwnerSid
    )

    $policy = Get-DysonConfigurationAclPolicy -Kind $Kind -ServiceSid $ServiceSid `
        -SourceOwnerSid $SourceOwnerSid
    $ioPath = ConvertTo-DysonConfigurationExtendedPath $Path
    $item = Get-Item -LiteralPath $ioPath -Force -ErrorAction Stop
    if ($item.PSIsContainer -ne $Kind.EndsWith('Directory') -or
        ($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint)) {
        throw 'DYSON_CONFIGURATION_ACL_INVALID'
    }
    $acl = Get-Acl -LiteralPath $item.FullName -ErrorAction Stop
    $acl.SetAccessRuleProtection($true, $false)
    foreach ($rule in @($acl.GetAccessRules(
                $true, $false, [System.Security.Principal.SecurityIdentifier]
            ))) { [void]$acl.RemoveAccessRuleSpecific($rule) }
    $acl.SetOwner([System.Security.Principal.SecurityIdentifier]::new([string]$policy.ownerSid))
    foreach ($rule in @($policy.rules)) {
        $acl.AddAccessRule([System.Security.AccessControl.FileSystemAccessRule]::new(
            [System.Security.Principal.SecurityIdentifier]::new([string]$rule.sid),
            [System.Security.AccessControl.FileSystemRights]([int64]$rule.rights),
            [System.Security.AccessControl.InheritanceFlags]([int]$rule.inheritance),
            [System.Security.AccessControl.PropagationFlags]([int]$rule.propagation),
            [System.Security.AccessControl.AccessControlType]([int]$rule.type)
        ))
    }
    Set-Acl -LiteralPath $item.FullName -AclObject $acl -ErrorAction Stop
    return Assert-DysonConfigurationAcl -Path $item.FullName -Kind $Kind -ServiceSid $ServiceSid `
        -SourceOwnerSid $SourceOwnerSid
}

function Assert-DysonConfigurationAcl {
    param(
        [Parameter(Mandatory)][string]$Path,
        [Parameter(Mandatory)][ValidateSet(
            'ConfigDirectory', 'ConfigFile', 'PrivateDirectory', 'PrivateFile', 'SourceFile'
        )][string]$Kind,
        [string]$ServiceSid,
        [string]$SourceOwnerSid
    )

    $policy = Get-DysonConfigurationAclPolicy -Kind $Kind -ServiceSid $ServiceSid `
        -SourceOwnerSid $SourceOwnerSid
    $ioPath = ConvertTo-DysonConfigurationExtendedPath $Path
    $item = Get-Item -LiteralPath $ioPath -Force -ErrorAction Stop
    if ($item.PSIsContainer -ne $Kind.EndsWith('Directory') -or
        ($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint)) {
        throw 'DYSON_CONFIGURATION_ACL_INVALID'
    }
    $acl = Get-Acl -LiteralPath $item.FullName -ErrorAction Stop
    if (-not $acl.AreAccessRulesProtected) { throw 'DYSON_CONFIGURATION_ACL_INVALID' }
    try { $ownerSid = $acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value }
    catch { throw 'DYSON_CONFIGURATION_ACL_INVALID' }
    if ([string]$ownerSid -cne [string]$policy.ownerSid) { throw 'DYSON_CONFIGURATION_ACL_INVALID' }
    $actualRules = @($acl.GetAccessRules(
            $true, $true, [System.Security.Principal.SecurityIdentifier]
        ) | ForEach-Object {
            if ($_.IsInherited) { throw 'DYSON_CONFIGURATION_ACL_INVALID' }
            '{0}:{1}:{2}:{3}:{4}' -f $_.IdentityReference.Value, [int]$_.AccessControlType,
                [int64]$_.FileSystemRights, [int]$_.InheritanceFlags, [int]$_.PropagationFlags
        } | Sort-Object)
    $expectedRules = @($policy.rules | ForEach-Object {
            '{0}:{1}:{2}:{3}:{4}' -f $_.sid, $_.type, $_.rights, $_.inheritance, $_.propagation
        } | Sort-Object)
    if ($actualRules.Count -ne $expectedRules.Count) { throw 'DYSON_CONFIGURATION_ACL_INVALID' }
    for ($index = 0; $index -lt $expectedRules.Count; $index += 1) {
        if ([string]$actualRules[$index] -cne [string]$expectedRules[$index]) {
            throw 'DYSON_CONFIGURATION_ACL_INVALID'
        }
    }
    return [pscustomobject][ordered]@{
        ownerSid = $ownerSid
        protected = $true
        fingerprint = [string]$policy.fingerprint
        kind = $Kind
    }
}

function Assert-DysonConfigurationPrivateSourceAcl {
    param([Parameter(Mandatory)][string]$Path)

    $item = Get-Item -LiteralPath $Path -Force -ErrorAction Stop
    if ($item.PSIsContainer -or ($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint)) {
        throw 'DYSON_CONFIGURATION_SOURCE_ACL_INVALID'
    }
    $acl = Get-Acl -LiteralPath $item.FullName -ErrorAction Stop
    if (-not $acl.AreAccessRulesProtected) { throw 'DYSON_CONFIGURATION_SOURCE_ACL_INVALID' }
    $currentSid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
    try { $ownerSid = $acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value }
    catch { throw 'DYSON_CONFIGURATION_SOURCE_ACL_INVALID' }
    $trusted = @($script:DysonConfigurationSystemSid, $script:DysonConfigurationAdministratorsSid, $currentSid)
    if ($ownerSid -notin $trusted) { throw 'DYSON_CONFIGURATION_SOURCE_ACL_INVALID' }
    foreach ($rule in @($acl.GetAccessRules(
                $true, $true, [System.Security.Principal.SecurityIdentifier]
            ))) {
        if ($rule.IsInherited -or [string]$rule.IdentityReference.Value -notin $trusted -or
            $rule.AccessControlType -ne [System.Security.AccessControl.AccessControlType]::Allow) {
            throw 'DYSON_CONFIGURATION_SOURCE_ACL_INVALID'
        }
    }
    return [pscustomobject][ordered]@{ ownerSid = $ownerSid; protected = $true }
}

function Assert-DysonConfigurationParentAcl {
    param(
        [Parameter(Mandatory)][string]$Path,
        [string]$ServiceSid
    )

    $fullPath = Assert-DysonConfigurationPlainDirectoryChain $Path
    $acl = Get-Acl -LiteralPath $fullPath -ErrorAction Stop
    if (-not $acl.AreAccessRulesProtected) {
        throw 'DYSON_CONFIGURATION_PARENT_ACL_INVALID'
    }
    try { $ownerSid = $acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value }
    catch { throw 'DYSON_CONFIGURATION_PARENT_ACL_INVALID' }
    if ($ownerSid -notin @(
            $script:DysonConfigurationSystemSid, $script:DysonConfigurationAdministratorsSid
        )) {
        throw 'DYSON_CONFIGURATION_PARENT_ACL_INVALID'
    }
    $fullControl = [int64][System.Security.AccessControl.FileSystemRights]::FullControl
    $readAndExecute = [int64][System.Security.AccessControl.FileSystemRights]::ReadAndExecute
    $dangerousParentMask = [int64][System.Security.AccessControl.FileSystemRights]::DeleteSubdirectoriesAndFiles `
        -bor [int64][System.Security.AccessControl.FileSystemRights]::Delete `
        -bor [int64][System.Security.AccessControl.FileSystemRights]::ChangePermissions `
        -bor [int64][System.Security.AccessControl.FileSystemRights]::TakeOwnership
    $writeMask = Get-DysonConfigurationWriteMask
    $allowBySid = @{}
    $canonicalRules = [System.Collections.Generic.List[string]]::new()
    foreach ($rule in @($acl.GetAccessRules(
                $true, $true, [System.Security.Principal.SecurityIdentifier]
            ))) {
        if ($rule.IsInherited) { throw 'DYSON_CONFIGURATION_PARENT_ACL_INVALID' }
        $sid = [string]$rule.IdentityReference.Value
        $rights = [int64]$rule.FileSystemRights
        $canonicalRules.Add(('{0}:{1}:{2}:{3}:{4}' -f $sid,
            [int]$rule.AccessControlType, $rights, [int]$rule.InheritanceFlags,
            [int]$rule.PropagationFlags))
        $appliesToParent = ($rule.PropagationFlags -band
            [System.Security.AccessControl.PropagationFlags]::InheritOnly) -eq 0
        if ($rule.AccessControlType -eq [System.Security.AccessControl.AccessControlType]::Deny) {
            if ($rights -ne 0) {
                throw 'DYSON_CONFIGURATION_PARENT_ACL_INVALID'
            }
            continue
        }
        if (-not $appliesToParent) { continue }
        if (-not $allowBySid.ContainsKey($sid)) { $allowBySid[$sid] = [int64]0 }
        $allowBySid[$sid] = [int64]$allowBySid[$sid] -bor $rights
        if ($sid -in @($script:DysonConfigurationSystemSid, $script:DysonConfigurationAdministratorsSid)) {
            continue
        }
        if (-not [string]::IsNullOrWhiteSpace($ServiceSid) -and
            [string]::Equals($sid, $ServiceSid, [System.StringComparison]::OrdinalIgnoreCase)) {
            if (($rights -band $dangerousParentMask) -ne 0) {
                throw 'DYSON_CONFIGURATION_PARENT_ACL_INVALID'
            }
            continue
        }
        if (($rights -band $writeMask) -ne 0) {
            throw 'DYSON_CONFIGURATION_PARENT_ACL_INVALID'
        }
    }
    foreach ($trustedSid in @(
            $script:DysonConfigurationSystemSid, $script:DysonConfigurationAdministratorsSid
        )) {
        if (-not $allowBySid.ContainsKey($trustedSid) -or
            (([int64]$allowBySid[$trustedSid] -band $fullControl) -ne $fullControl)) {
            throw 'DYSON_CONFIGURATION_PARENT_ACL_INVALID'
        }
    }
    if (-not [string]::IsNullOrWhiteSpace($ServiceSid) -and
        (-not $allowBySid.ContainsKey($ServiceSid) -or
            (([int64]$allowBySid[$ServiceSid] -band $readAndExecute) -ne $readAndExecute) -or
            (([int64]$allowBySid[$ServiceSid] -band $dangerousParentMask) -ne 0))) {
        throw 'DYSON_CONFIGURATION_PARENT_ACL_INVALID'
    }
    $canonical = 'owner={0};protected=true;rules={1}' -f $ownerSid,
        ([string]::Join('|', @($canonicalRules | Sort-Object)))
    return [pscustomobject][ordered]@{
        ownerSid = $ownerSid
        protected = $true
        fingerprint = Get-DysonConfigurationSha256Text $canonical
    }
}

function Initialize-DysonConfigurationStorage {
    param(
        [Parameter(Mandatory)][string]$DataRoot,
        [Parameter(Mandatory)][string]$ServiceSid
    )

    $dataFull = Assert-DysonConfigurationPlainDirectoryChain $DataRoot
    $parentAcl = Assert-DysonConfigurationParentAcl -Path $dataFull -ServiceSid $ServiceSid
    $configRoot = Join-Path $dataFull 'config'
    $transactionRoot = Join-Path $dataFull 'configuration-transactions'
    $intentsRoot = Join-Path $transactionRoot 'intents'
    $receiptsRoot = Join-Path $transactionRoot 'receipts'
    $snapshotRoot = Join-Path $dataFull $script:DysonConfigurationSnapshotRootName
    $lockPath = Join-Path $transactionRoot $script:DysonConfigurationLockName
    if (-not (Test-Path -LiteralPath $configRoot)) {
        [System.IO.Directory]::CreateDirectory($configRoot) | Out-Null
        [void](Set-DysonConfigurationAcl -Path $configRoot -Kind ConfigDirectory -ServiceSid $ServiceSid)
    }
    else {
        [void](Assert-DysonConfigurationPlainDirectoryChain $configRoot)
        [void](Assert-DysonConfigurationAcl -Path $configRoot -Kind ConfigDirectory -ServiceSid $ServiceSid)
    }
    foreach ($directory in @($transactionRoot, $intentsRoot, $receiptsRoot, $snapshotRoot)) {
        if (-not (Test-Path -LiteralPath $directory)) {
            [System.IO.Directory]::CreateDirectory($directory) | Out-Null
            [void](Set-DysonConfigurationAcl -Path $directory -Kind PrivateDirectory)
        }
        else {
            [void](Assert-DysonConfigurationPlainDirectoryChain $directory)
            [void](Assert-DysonConfigurationAcl -Path $directory -Kind PrivateDirectory)
        }
    }
    if (-not (Test-Path -LiteralPath $lockPath)) {
        $lockBytes = [System.Text.UTF8Encoding]::new($false, $true).GetBytes(
            "DYSON_CONTROL_CONFIGURATION_LOCK_V1`n"
        )
        [void](Write-DysonConfigurationDurableFileCreateNew -Path $lockPath `
            -Bytes $lockBytes -Kind PrivateFile)
    }
    else {
        $lockFull = Assert-DysonConfigurationPlainFilePath -Path $lockPath -MaximumBytes 64
        [void](Assert-DysonConfigurationAcl -Path $lockFull -Kind PrivateFile)
        $lockText = [System.Text.UTF8Encoding]::new($false, $true).GetString(
            [System.IO.File]::ReadAllBytes($lockFull)
        )
        if ($lockText -cne "DYSON_CONTROL_CONFIGURATION_LOCK_V1`n") {
            throw 'DYSON_CONFIGURATION_LOCK_INVALID'
        }
    }
    return [pscustomobject][ordered]@{
        dataRoot = $dataFull
        configRoot = $configRoot
        configurationPath = Join-Path $configRoot $script:DysonConfigurationFileName
        transactionRoot = $transactionRoot
        intentsRoot = $intentsRoot
        receiptsRoot = $receiptsRoot
        snapshotRoot = $snapshotRoot
        lockPath = $lockPath
        parentAclFingerprint = [string]$parentAcl.fingerprint
    }
}

function Get-DysonConfigurationStoragePaths {
    param([Parameter(Mandatory)][string]$DataRoot)

    $dataFull = Assert-DysonConfigurationPlainDirectoryChain $DataRoot
    $configRoot = Join-Path $dataFull 'config'
    $transactionRoot = Join-Path $dataFull 'configuration-transactions'
    return [pscustomobject][ordered]@{
        dataRoot = $dataFull
        configRoot = $configRoot
        configurationPath = Join-Path $configRoot $script:DysonConfigurationFileName
        transactionRoot = $transactionRoot
        intentsRoot = Join-Path $transactionRoot 'intents'
        receiptsRoot = Join-Path $transactionRoot 'receipts'
        snapshotRoot = Join-Path $dataFull $script:DysonConfigurationSnapshotRootName
        lockPath = Join-Path $transactionRoot $script:DysonConfigurationLockName
    }
}

function Enter-DysonConfigurationMutationLock {
    param(
        [Parameter(Mandatory)]$Storage,
        [ValidateRange(1, 120)][int]$TimeoutSeconds = 30
    )

    $lockFull = Assert-DysonConfigurationPlainFilePath -Path $Storage.lockPath -MaximumBytes 64
    [void](Assert-DysonConfigurationAcl -Path $lockFull -Kind PrivateFile)
    $deadline = [datetime]::UtcNow.AddSeconds($TimeoutSeconds)
    do {
        try {
            $stream = [System.IO.FileStream]::new(
                $lockFull, [System.IO.FileMode]::Open, [System.IO.FileAccess]::ReadWrite,
                [System.IO.FileShare]::None, 64, [System.IO.FileOptions]::WriteThrough
            )
            $bytes = New-Object byte[] ([int]$stream.Length)
            $stream.Position = 0
            $read = $stream.Read($bytes, 0, $bytes.Length)
            if ($read -ne $bytes.Length -or
                [System.Text.UTF8Encoding]::new($false, $true).GetString($bytes) -cne
                    "DYSON_CONTROL_CONFIGURATION_LOCK_V1`n") {
                $stream.Dispose()
                throw 'DYSON_CONFIGURATION_LOCK_INVALID'
            }
            return $stream
        }
        catch [System.IO.IOException] {
            if ([datetime]::UtcNow -ge $deadline) {
                throw 'DYSON_CONFIGURATION_LOCK_TIMEOUT'
            }
            Start-Sleep -Milliseconds 100
        }
    } while ($true)
}

function Write-DysonConfigurationDurableFileCreateNew {
    param(
        [Parameter(Mandatory)][string]$Path,
        [Parameter(Mandatory)][byte[]]$Bytes,
        [Parameter(Mandatory)][ValidateSet('ConfigFile', 'PrivateFile')][string]$Kind,
        [string]$ServiceSid
    )

    $fullPath = Get-DysonConfigurationFullPath $Path
    $parent = Assert-DysonConfigurationPlainDirectoryChain ([System.IO.Path]::GetDirectoryName($fullPath))
    $fullIoPath = ConvertTo-DysonConfigurationExtendedPath $fullPath
    if ([System.IO.File]::Exists($fullIoPath) -or [System.IO.Directory]::Exists($fullIoPath)) {
        throw 'DYSON_CONFIGURATION_TARGET_EXISTS'
    }
    $temporaryPath = Join-Path $parent ('.write-' + [guid]::NewGuid().ToString('N') + '.tmp')
    $temporaryIoPath = ConvertTo-DysonConfigurationExtendedPath $temporaryPath
    $stream = $null
    try {
        $stream = [System.IO.FileStream]::new(
            $temporaryIoPath,
            [System.IO.FileMode]::CreateNew,
            [System.IO.FileAccess]::Write,
            [System.IO.FileShare]::None,
            4096,
            [System.IO.FileOptions]::WriteThrough
        )
        $stream.Write($Bytes, 0, $Bytes.Length)
        $stream.Flush($true)
        $stream.Dispose()
        $stream = $null
        [void](Set-DysonConfigurationAcl -Path $temporaryIoPath -Kind $Kind -ServiceSid $ServiceSid)
        $actualBytes = [System.IO.File]::ReadAllBytes($temporaryIoPath)
        if ((Get-DysonConfigurationSha256Bytes $actualBytes) -cne (Get-DysonConfigurationSha256Bytes $Bytes)) {
            throw 'DYSON_CONFIGURATION_DURABLE_WRITE_FAILED'
        }
        [System.IO.File]::Move($temporaryIoPath, $fullIoPath)
        [void](Assert-DysonConfigurationAcl -Path $fullIoPath -Kind $Kind -ServiceSid $ServiceSid)
        return [pscustomobject][ordered]@{
            path = $fullPath
            sha256 = Get-DysonConfigurationSha256Bytes $Bytes
            length = [int64]$Bytes.Length
        }
    }
    finally {
        if ($stream) { $stream.Dispose() }
        # A failed durable write is intentionally retained as an orphan. The next
        # operation must identify it and fail closed instead of guessing cleanup.
    }
}

function Write-DysonConfigurationDurableJsonCreateNew {
    param(
        [Parameter(Mandatory)][string]$Path,
        [Parameter(Mandatory)]$Value
    )

    $bytes = [System.Text.UTF8Encoding]::new($false, $true).GetBytes(
        (ConvertTo-DysonConfigurationJson $Value) + "`n"
    )
    return Write-DysonConfigurationDurableFileCreateNew -Path $Path -Bytes $bytes -Kind PrivateFile
}

function Write-DysonConfigurationStagedFile {
    param(
        [Parameter(Mandatory)][string]$Path,
        [Parameter(Mandatory)][byte[]]$Bytes,
        [Parameter(Mandatory)][string]$ServiceSid
    )

    $fullPath = Get-DysonConfigurationFullPath $Path
    $parent = Assert-DysonConfigurationPlainDirectoryChain ([System.IO.Path]::GetDirectoryName($fullPath))
    $fullIoPath = ConvertTo-DysonConfigurationExtendedPath $fullPath
    if ([System.IO.File]::Exists($fullIoPath) -or [System.IO.Directory]::Exists($fullIoPath)) {
        throw 'DYSON_CONFIGURATION_TARGET_EXISTS'
    }
    $stream = [System.IO.FileStream]::new(
        $fullIoPath, [System.IO.FileMode]::CreateNew, [System.IO.FileAccess]::Write,
        [System.IO.FileShare]::None, 4096, [System.IO.FileOptions]::WriteThrough
    )
    try {
        $stream.Write($Bytes, 0, $Bytes.Length)
        $stream.Flush($true)
    }
    finally { $stream.Dispose() }
    [void](Set-DysonConfigurationAcl -Path $fullIoPath -Kind ConfigFile -ServiceSid $ServiceSid)
    $actual = [System.IO.File]::ReadAllBytes($fullIoPath)
    if ((Get-DysonConfigurationSha256Bytes $actual) -cne (Get-DysonConfigurationSha256Bytes $Bytes)) {
        throw 'DYSON_CONFIGURATION_DURABLE_WRITE_FAILED'
    }
    return [pscustomobject][ordered]@{
        path = $fullPath
        sha256 = Get-DysonConfigurationSha256Bytes $Bytes
        length = [int64]$Bytes.Length
    }
}

function Get-DysonConfigurationFileEvidence {
    param(
        [Parameter(Mandatory)][string]$Path,
        [Parameter(Mandatory)][string]$ServiceSid,
        [switch]$IncludePrivateBytes
    )

    $fullPath = Assert-DysonConfigurationPlainFilePath -Path $Path -MaximumBytes 65536
    $stream = [System.IO.FileStream]::new(
        (ConvertTo-DysonConfigurationExtendedPath $fullPath),
        [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read,
        [System.IO.FileShare]::Read, 4096, [System.IO.FileOptions]::SequentialScan
    )
    try {
        if ($stream.Length -lt 1 -or $stream.Length -gt 65536) {
            throw 'DYSON_CONFIGURATION_FILE_INVALID'
        }
        $bytes = New-Object byte[] ([int]$stream.Length)
        $offset = 0
        while ($offset -lt $bytes.Length) {
            $read = $stream.Read($bytes, $offset, $bytes.Length - $offset)
            if ($read -le 0) { throw 'DYSON_CONFIGURATION_FILE_INVALID' }
            $offset += $read
        }
    }
    finally { $stream.Dispose() }
    $acl = Assert-DysonConfigurationAcl -Path $fullPath -Kind ConfigFile -ServiceSid $ServiceSid
    $result = [ordered]@{
        path = $fullPath
        pathSha256 = Get-DysonConfigurationPathBindingSha256 $fullPath
        sha256 = Get-DysonConfigurationSha256Bytes $bytes
        length = [int64]$bytes.Length
        aclFingerprint = [string]$acl.fingerprint
    }
    if ($IncludePrivateBytes) { $result.privateBytes = $bytes }
    return [pscustomobject]$result
}

function Invoke-DysonConfigurationAtomicPublish {
    param(
        [Parameter(Mandatory)][string]$StagedPath,
        [Parameter(Mandatory)][string]$TargetPath,
        [Parameter(Mandatory)][ValidateSet('create', 'replace')][string]$Mode,
        [Parameter(Mandatory)][string]$ServiceSid,
        [Parameter(Mandatory)][string]$ExpectedSha256,
        [Parameter(Mandatory)][int64]$ExpectedLength,
        [string]$BackupPath
    )

    $stagedFull = Assert-DysonConfigurationPlainFilePath -Path $StagedPath -MaximumBytes 65536
    $targetFull = Get-DysonConfigurationFullPath $TargetPath
    $stagedParent = Assert-DysonConfigurationPlainDirectoryChain `
        ([System.IO.Path]::GetDirectoryName($stagedFull))
    $targetParent = Assert-DysonConfigurationPlainDirectoryChain `
        ([System.IO.Path]::GetDirectoryName($targetFull))
    if (-not [string]::Equals(
            $stagedParent, $targetParent, [System.StringComparison]::OrdinalIgnoreCase
        )) {
        throw 'DYSON_CONFIGURATION_ATOMIC_VOLUME_INVALID'
    }
    $staged = Get-DysonConfigurationFileEvidence -Path $stagedFull -ServiceSid $ServiceSid
    if ([string]$staged.sha256 -cne $ExpectedSha256 -or
        [int64]$staged.length -ne $ExpectedLength) {
        throw 'DYSON_CONFIGURATION_STAGED_VERIFICATION_FAILED'
    }
    if ($Mode -ceq 'create') {
        if (Test-Path -LiteralPath $targetFull) { throw 'DYSON_CONFIGURATION_TARGET_EXISTS' }
        [System.IO.File]::Move($stagedFull, $targetFull)
    }
    else {
        [void](Assert-DysonConfigurationPlainFilePath -Path $targetFull -MaximumBytes 65536)
        if ([string]::IsNullOrWhiteSpace($BackupPath)) {
            throw 'DYSON_CONFIGURATION_ATOMIC_BACKUP_REQUIRED'
        }
        $backupFull = Get-DysonConfigurationFullPath $BackupPath
        if (-not [string]::Equals(
                ([System.IO.Path]::GetDirectoryName($backupFull)), $targetParent,
                [System.StringComparison]::OrdinalIgnoreCase
            ) -or (Test-Path -LiteralPath $backupFull)) {
            throw 'DYSON_CONFIGURATION_ATOMIC_BACKUP_INVALID'
        }
        [System.IO.File]::Replace($stagedFull, $targetFull, $backupFull, $false)
        [void](Assert-DysonConfigurationPlainFilePath -Path $backupFull -MaximumBytes 65536)
    }
    $published = Get-DysonConfigurationFileEvidence -Path $targetFull -ServiceSid $ServiceSid
    if ([string]$published.sha256 -cne $ExpectedSha256 -or
        [int64]$published.length -ne $ExpectedLength) {
        throw 'DYSON_CONFIGURATION_TARGET_VERIFICATION_FAILED'
    }
    return $published
}

function Read-DysonConfigurationPrivateJsonFile {
    param(
        [Parameter(Mandatory)][string]$Path,
        [int64]$MaximumBytes = 65536
    )

    $fullPath = Assert-DysonConfigurationPlainFilePath -Path $Path -MaximumBytes $MaximumBytes
    [void](Assert-DysonConfigurationAcl -Path $fullPath -Kind PrivateFile)
    $bytes = [System.IO.File]::ReadAllBytes(
        (ConvertTo-DysonConfigurationExtendedPath $fullPath)
    )
    try {
        $text = [System.Text.UTF8Encoding]::new($false, $true).GetString($bytes)
        if ($text.Length -gt 0 -and [int][char]$text[0] -eq 0xFEFF) { throw 'invalid BOM' }
        $value = $text | ConvertFrom-Json -ErrorAction Stop
        $canonicalBytes = [System.Text.UTF8Encoding]::new($false, $true).GetBytes(
            (ConvertTo-DysonConfigurationJson $value) + "`n"
        )
        if ($canonicalBytes.Length -ne $bytes.Length -or
            (Get-DysonConfigurationSha256Bytes $canonicalBytes) -cne
                (Get-DysonConfigurationSha256Bytes $bytes)) {
            throw 'non-canonical JSON'
        }
    }
    catch { throw 'DYSON_CONFIGURATION_RECORD_INVALID' }
    return [pscustomobject][ordered]@{
        path = $fullPath
        sha256 = Get-DysonConfigurationSha256Bytes $bytes
        value = $value
    }
}

# Transaction records use a linear receipt chain and bind replacement and
# restore operations to protected, self-describing preimage snapshots while
# preserving the strict parser and ACL primitives used by existing callers.

function ConvertTo-DysonConfigurationBindingRecord {
    param(
        [Parameter(Mandatory)]$Contract,
        [Parameter(Mandatory)][hashtable]$ExpectedLauncherBindings
    )

    Assert-DysonConfigurationExpectedBindings -Contract $Contract `
        -ExpectedLauncherBindings $ExpectedLauncherBindings
    $record = [ordered]@{}
    foreach ($name in @($Contract.launcherOwnedNames | Sort-Object)) {
        $record[[string]$name] = [string]$ExpectedLauncherBindings[[string]$name]
    }
    return $record
}

function ConvertFrom-DysonConfigurationBindingRecord {
    param(
        [Parameter(Mandatory)]$Contract,
        [Parameter(Mandatory)]$Record
    )

    Assert-DysonConfigurationExactProperties -Value $Record `
        -Expected @($Contract.launcherOwnedNames)
    $bindings = @{}
    foreach ($name in @($Contract.launcherOwnedNames)) {
        $property = $Record.PSObject.Properties[[string]$name]
        if ($null -eq $property -or $property.Value -isnot [string] -or
            [string]::IsNullOrEmpty([string]$property.Value)) {
            throw 'DYSON_CONFIGURATION_RECORD_INVALID'
        }
        $bindings[[string]$name] = [string]$property.Value
    }
    Assert-DysonConfigurationExpectedBindings -Contract $Contract `
        -ExpectedLauncherBindings $bindings
    return $bindings
}

function Assert-DysonConfigurationNullableSha256 {
    param($Value, [Parameter(Mandatory)][bool]$Required)
    if ($Required) {
        if ($Value -isnot [string]) { throw 'DYSON_CONFIGURATION_RECORD_INVALID' }
        [void](Assert-DysonConfigurationCanonicalSha256 ([string]$Value))
    }
    elseif ($null -ne $Value) { throw 'DYSON_CONFIGURATION_RECORD_INVALID' }
}

function Assert-DysonConfigurationNullableGuid {
    param($Value, [Parameter(Mandatory)][bool]$Required)
    if ($Required) {
        if ($Value -isnot [string]) { throw 'DYSON_CONFIGURATION_RECORD_INVALID' }
        [void](Assert-DysonConfigurationCanonicalGuid ([string]$Value))
    }
    elseif ($null -ne $Value) { throw 'DYSON_CONFIGURATION_RECORD_INVALID' }
}

function Assert-DysonConfigurationIntentRecord {
    param(
        [Parameter(Mandatory)]$Record,
        [Parameter(Mandatory)][string]$FileBaseName,
        [Parameter(Mandatory)]$Contract
    )

    Assert-DysonConfigurationExactProperties -Value $Record -Expected @(
        'protocol', 'schemaVersion', 'sequence', 'transactionId', 'createdAt', 'operation',
        'targetPathSha256', 'sourceKind', 'sourcePathSha256', 'sourceSha256',
        'sourceLength', 'contractSha256', 'expectedAclFingerprint',
        'parentAclFingerprint', 'serviceSid', 'bindingsSha256', 'launcherBindings',
        'preimagePresent', 'preimageSha256', 'preimageLength',
        'preimageAclFingerprint', 'preimageSnapshotId',
        'preimageSnapshotManifestSha256', 'preimageSnapshotPathSha256',
        'preimageBindingsSha256', 'sourceSnapshotId',
        'sourceSnapshotManifestSha256', 'sourceSnapshotPathSha256',
        'previousReceiptSha256', 'temporaryName', 'backupName'
    )
    [void](Assert-DysonConfigurationCanonicalGuid ([string]$Record.transactionId))
    [void](Assert-DysonConfigurationCanonicalTimestamp ([string]$Record.createdAt))
    foreach ($hash in @(
            $Record.targetPathSha256, $Record.sourcePathSha256, $Record.sourceSha256,
            $Record.contractSha256, $Record.expectedAclFingerprint,
            $Record.parentAclFingerprint, $Record.bindingsSha256
        )) { [void](Assert-DysonConfigurationCanonicalSha256 ([string]$hash)) }
    if ((-not ($Record.schemaVersion -is [int] -or $Record.schemaVersion -is [long])) -or
        (-not ($Record.sequence -is [int] -or $Record.sequence -is [long])) -or
        (-not ($Record.sourceLength -is [int] -or $Record.sourceLength -is [long])) -or
        $Record.preimagePresent -isnot [bool] -or
        [string]$Record.transactionId -cne $FileBaseName -or
        [string]$Record.protocol -cne $script:DysonConfigurationIntentProtocol -or
        [int]$Record.schemaVersion -ne $script:DysonConfigurationSchemaVersion -or
        [int64]$Record.sequence -lt 1 -or
        [string]$Record.operation -cnotin @('create', 'reuse', 'replace', 'restore') -or
        [string]$Record.sourceKind -cnotin @('configuration-source', 'protected-snapshot') -or
        [int64]$Record.sourceLength -lt 1 -or [int64]$Record.sourceLength -gt 65536 -or
        [string]$Record.serviceSid -cnotmatch '^S-1-[0-9-]+$' -or
        [string]$Record.temporaryName -cne
            ('.dyson-control.env.partial-' + [string]$Record.transactionId) -or
        [string]$Record.backupName -cne
            ('.dyson-control.env.preimage-' + [string]$Record.transactionId)) {
        throw 'DYSON_CONFIGURATION_RECORD_INVALID'
    }
    if ([int64]$Record.sequence -eq 1) {
        Assert-DysonConfigurationNullableSha256 -Value $Record.previousReceiptSha256 -Required $false
    }
    else {
        Assert-DysonConfigurationNullableSha256 -Value $Record.previousReceiptSha256 -Required $true
    }
    $bindings = ConvertFrom-DysonConfigurationBindingRecord -Contract $Contract `
        -Record $Record.launcherBindings
    if ([string]$Record.bindingsSha256 -cne
        (Get-DysonConfigurationExpectedBindingsHash -ExpectedLauncherBindings $bindings `
            -Contract $Contract)) {
        throw 'DYSON_CONFIGURATION_RECORD_INVALID'
    }
    $requiresPreimage = [string]$Record.operation -cne 'create'
    if ([bool]$Record.preimagePresent -ne $requiresPreimage) {
        throw 'DYSON_CONFIGURATION_RECORD_INVALID'
    }
    Assert-DysonConfigurationNullableSha256 -Value $Record.preimageSha256 `
        -Required $requiresPreimage
    Assert-DysonConfigurationNullableSha256 -Value $Record.preimageAclFingerprint `
        -Required $requiresPreimage
    Assert-DysonConfigurationNullableSha256 -Value $Record.preimageBindingsSha256 `
        -Required $requiresPreimage
    if ($requiresPreimage) {
        if ((-not ($Record.preimageLength -is [int] -or $Record.preimageLength -is [long])) -or
            [int64]$Record.preimageLength -lt 1 -or [int64]$Record.preimageLength -gt 65536) {
            throw 'DYSON_CONFIGURATION_RECORD_INVALID'
        }
    }
    elseif ($null -ne $Record.preimageLength) { throw 'DYSON_CONFIGURATION_RECORD_INVALID' }
    $requiresPreimageSnapshot = [string]$Record.operation -in @('replace', 'restore')
    foreach ($name in @(
        'preimageSnapshotManifestSha256', 'preimageSnapshotPathSha256'
    )) {
        Assert-DysonConfigurationNullableSha256 -Value $Record.$name `
            -Required $requiresPreimageSnapshot
    }
    Assert-DysonConfigurationNullableGuid -Value $Record.preimageSnapshotId `
        -Required $requiresPreimageSnapshot
    $requiresSourceSnapshot = [string]$Record.operation -ceq 'restore'
    foreach ($name in @('sourceSnapshotManifestSha256', 'sourceSnapshotPathSha256')) {
        Assert-DysonConfigurationNullableSha256 -Value $Record.$name `
            -Required $requiresSourceSnapshot
    }
    Assert-DysonConfigurationNullableGuid -Value $Record.sourceSnapshotId `
        -Required $requiresSourceSnapshot
    if ($requiresSourceSnapshot -ne ([string]$Record.sourceKind -ceq 'protected-snapshot')) {
        throw 'DYSON_CONFIGURATION_RECORD_INVALID'
    }
    if ([string]$Record.operation -ceq 'reuse' -and
        ([string]$Record.preimageSha256 -cne [string]$Record.sourceSha256 -or
            [int64]$Record.preimageLength -ne [int64]$Record.sourceLength -or
            [string]$Record.preimageBindingsSha256 -cne [string]$Record.bindingsSha256)) {
        throw 'DYSON_CONFIGURATION_RECORD_INVALID'
    }
    return [pscustomobject][ordered]@{ record = $Record; bindings = $bindings }
}

function New-DysonConfigurationIntentValue {
    param(
        [Parameter(Mandatory)]$Storage,
        [Parameter(Mandatory)]$Source,
        [Parameter(Mandatory)]$Contract,
        [Parameter(Mandatory)][hashtable]$ExpectedLauncherBindings,
        [Parameter(Mandatory)][string]$ServiceSid,
        [Parameter(Mandatory)][ValidateSet('create', 'reuse', 'replace', 'restore')]
        [string]$Operation,
        [Parameter(Mandatory)][ValidateSet('configuration-source', 'protected-snapshot')]
        [string]$SourceKind,
        [Parameter(Mandatory)][string]$SourcePathSha256,
        [Parameter(Mandatory)][int64]$Sequence,
        [string]$PreviousReceiptSha256,
        $Preimage,
        $PreimageSnapshot,
        $SourceSnapshot
    )

    Assert-DysonConfigurationExpectedBindings -Contract $Contract `
        -ExpectedLauncherBindings $ExpectedLauncherBindings
    [void](Assert-DysonConfigurationCanonicalSha256 $SourcePathSha256)
    if ($Sequence -lt 1 -or ($Sequence -eq 1 -and $PreviousReceiptSha256) -or
        ($Sequence -gt 1 -and $PreviousReceiptSha256 -cnotmatch '^[0-9a-f]{64}$')) {
        throw 'DYSON_CONFIGURATION_CHAIN_INVALID'
    }
    $preimageRequired = $Operation -cne 'create'
    if ($preimageRequired -ne ($null -ne $Preimage)) {
        throw 'DYSON_CONFIGURATION_PREIMAGE_INVALID'
    }
    $snapshotRequired = $Operation -in @('replace', 'restore')
    if ($snapshotRequired -ne ($null -ne $PreimageSnapshot)) {
        throw 'DYSON_CONFIGURATION_PREIMAGE_INVALID'
    }
    $sourceSnapshotRequired = $Operation -ceq 'restore'
    if ($sourceSnapshotRequired -ne ($null -ne $SourceSnapshot) -or
        $sourceSnapshotRequired -ne ($SourceKind -ceq 'protected-snapshot')) {
        throw 'DYSON_CONFIGURATION_SOURCE_SNAPSHOT_INVALID'
    }
    if ($preimageRequired -and $Operation -ceq 'reuse' -and
        ([string]$Preimage.sha256 -cne [string]$Source.sha256 -or
            [int64]$Preimage.length -ne [int64]$Source.length)) {
        throw 'DYSON_CONFIGURATION_PREIMAGE_INVALID'
    }
    if ($snapshotRequired -and
        ([string]$PreimageSnapshot.configurationSha256 -cne [string]$Preimage.sha256 -or
            [int64]$PreimageSnapshot.configurationLength -ne [int64]$Preimage.length -or
            [string]$PreimageSnapshot.configurationAclFingerprint -cne
                [string]$Preimage.aclFingerprint)) {
        throw 'DYSON_CONFIGURATION_PREIMAGE_INVALID'
    }
    if ($sourceSnapshotRequired -and
        ([string]$SourceSnapshot.configurationSha256 -cne [string]$Source.sha256 -or
            [int64]$SourceSnapshot.configurationLength -ne [int64]$Source.length)) {
        throw 'DYSON_CONFIGURATION_SOURCE_SNAPSHOT_INVALID'
    }
    $transactionId = [guid]::NewGuid().ToString('D').ToLowerInvariant()
    $aclPolicy = Get-DysonConfigurationAclPolicy -Kind ConfigFile -ServiceSid $ServiceSid
    $parentAcl = Assert-DysonConfigurationParentAcl -Path $Storage.dataRoot -ServiceSid $ServiceSid
    $bindingsSha256 = Get-DysonConfigurationExpectedBindingsHash `
        -ExpectedLauncherBindings $ExpectedLauncherBindings -Contract $Contract
    return [ordered]@{
        protocol = $script:DysonConfigurationIntentProtocol
        schemaVersion = $script:DysonConfigurationSchemaVersion
        sequence = [int64]$Sequence
        transactionId = $transactionId
        createdAt = (Get-Date).ToUniversalTime().ToString('o')
        operation = $Operation
        targetPathSha256 = Get-DysonConfigurationPathBindingSha256 $Storage.configurationPath
        sourceKind = $SourceKind
        sourcePathSha256 = $SourcePathSha256
        sourceSha256 = [string]$Source.sha256
        sourceLength = [int64]$Source.length
        contractSha256 = [string]$Contract.sha256
        expectedAclFingerprint = [string]$aclPolicy.fingerprint
        parentAclFingerprint = [string]$parentAcl.fingerprint
        serviceSid = $ServiceSid
        bindingsSha256 = $bindingsSha256
        launcherBindings = ConvertTo-DysonConfigurationBindingRecord -Contract $Contract `
            -ExpectedLauncherBindings $ExpectedLauncherBindings
        preimagePresent = $preimageRequired
        preimageSha256 = if ($preimageRequired) { [string]$Preimage.sha256 } else { $null }
        preimageLength = if ($preimageRequired) { [int64]$Preimage.length } else { $null }
        preimageAclFingerprint = if ($preimageRequired) {
            [string]$Preimage.aclFingerprint
        } else { $null }
        preimageSnapshotId = if ($snapshotRequired) {
            [string]$PreimageSnapshot.snapshotId
        } else { $null }
        preimageSnapshotManifestSha256 = if ($snapshotRequired) {
            [string]$PreimageSnapshot.manifestSha256
        } else { $null }
        preimageSnapshotPathSha256 = if ($snapshotRequired) {
            [string]$PreimageSnapshot.snapshotPathSha256
        } else { $null }
        preimageBindingsSha256 = if ($preimageRequired) {
            if ($snapshotRequired) { [string]$PreimageSnapshot.bindingsSha256 }
            else { $bindingsSha256 }
        } else { $null }
        sourceSnapshotId = if ($sourceSnapshotRequired) { [string]$SourceSnapshot.snapshotId } else { $null }
        sourceSnapshotManifestSha256 = if ($sourceSnapshotRequired) {
            [string]$SourceSnapshot.manifestSha256
        } else { $null }
        sourceSnapshotPathSha256 = if ($sourceSnapshotRequired) {
            [string]$SourceSnapshot.snapshotPathSha256
        } else { $null }
        previousReceiptSha256 = if ($Sequence -gt 1) { $PreviousReceiptSha256 } else { $null }
        temporaryName = '.dyson-control.env.partial-' + $transactionId
        backupName = '.dyson-control.env.preimage-' + $transactionId
    }
}

function Assert-DysonConfigurationReceiptRecord {
    param(
        [Parameter(Mandatory)]$Record,
        [Parameter(Mandatory)][string]$FileBaseName
    )

    Assert-DysonConfigurationExactProperties -Value $Record -Expected @(
        'protocol', 'schemaVersion', 'sequence', 'transactionId', 'intentSha256',
        'previousReceiptSha256', 'completedAt', 'state', 'targetSha256',
        'targetLength', 'targetAclFingerprint'
    )
    [void](Assert-DysonConfigurationCanonicalGuid ([string]$Record.transactionId))
    [void](Assert-DysonConfigurationCanonicalTimestamp ([string]$Record.completedAt))
    foreach ($hash in @($Record.intentSha256, $Record.targetSha256, $Record.targetAclFingerprint)) {
        [void](Assert-DysonConfigurationCanonicalSha256 ([string]$hash))
    }
    if ((-not ($Record.schemaVersion -is [int] -or $Record.schemaVersion -is [long])) -or
        (-not ($Record.sequence -is [int] -or $Record.sequence -is [long])) -or
        (-not ($Record.targetLength -is [int] -or $Record.targetLength -is [long])) -or
        [string]$Record.transactionId -cne $FileBaseName -or
        [string]$Record.protocol -cne $script:DysonConfigurationReceiptProtocol -or
        [int]$Record.schemaVersion -ne $script:DysonConfigurationSchemaVersion -or
        [int64]$Record.sequence -lt 1 -or
        [string]$Record.state -cnotin @('installed', 'reused', 'replaced', 'restored', 'aborted') -or
        [int64]$Record.targetLength -lt 0 -or [int64]$Record.targetLength -gt 65536) {
        throw 'DYSON_CONFIGURATION_RECORD_INVALID'
    }
    Assert-DysonConfigurationNullableSha256 -Value $Record.previousReceiptSha256 `
        -Required ([int64]$Record.sequence -gt 1)
    return $Record
}

function New-DysonConfigurationReceiptValue {
    param(
        [Parameter(Mandatory)]$Intent,
        [Parameter(Mandatory)][string]$IntentSha256,
        [Parameter(Mandatory)][ValidateSet('installed', 'reused', 'replaced', 'restored', 'aborted')]
        [string]$State
    )

    return [ordered]@{
        protocol = $script:DysonConfigurationReceiptProtocol
        schemaVersion = $script:DysonConfigurationSchemaVersion
        sequence = [int64]$Intent.sequence
        transactionId = [string]$Intent.transactionId
        intentSha256 = $IntentSha256
        previousReceiptSha256 = $Intent.previousReceiptSha256
        completedAt = (Get-Date).ToUniversalTime().ToString('o')
        state = $State
        targetSha256 = if ($State -ceq 'aborted') {
            if ([bool]$Intent.preimagePresent) { [string]$Intent.preimageSha256 }
            else { Get-DysonConfigurationSha256Bytes ([byte[]]::new(0)) }
        } else { [string]$Intent.sourceSha256 }
        targetLength = if ($State -ceq 'aborted') {
            if ([bool]$Intent.preimagePresent) { [int64]$Intent.preimageLength } else { 0 }
        } else { [int64]$Intent.sourceLength }
        targetAclFingerprint = if ($State -ceq 'aborted') {
            if ([bool]$Intent.preimagePresent) { [string]$Intent.preimageAclFingerprint }
            else { [string]$Intent.expectedAclFingerprint }
        } else { [string]$Intent.expectedAclFingerprint }
    }
}

function Test-DysonConfigurationSnapshotBindingMatch {
    param($Expected, $Actual, [switch]$IgnoreConfigurationAcl)
    if ($null -eq $Expected -or $null -eq $Actual) { return $false }
    $baseMatch = [string]$Expected.snapshotId -ceq [string]$Actual.snapshotId -and
        [string]$Expected.manifestSha256 -ceq [string]$Actual.manifestSha256 -and
        [string]$Expected.snapshotPathSha256 -ceq [string]$Actual.snapshotPathSha256 -and
        [string]$Expected.configurationSha256 -ceq [string]$Actual.configurationSha256 -and
        [int64]$Expected.configurationLength -eq [int64]$Actual.configurationLength -and
        [string]$Expected.bindingsSha256 -ceq [string]$Actual.bindingsSha256
    if (-not $baseMatch) { return $false }
    return $IgnoreConfigurationAcl -or
        [string]$Expected.configurationAclFingerprint -ceq
            [string]$Actual.configurationAclFingerprint
}

function Get-DysonConfigurationTransactionState {
    param(
        [Parameter(Mandatory)]$Storage,
        [Parameter(Mandatory)][string]$ServiceSid,
        [Parameter(Mandatory)]$Contract,
        [Parameter(Mandatory)][hashtable]$ExpectedLauncherBindings,
        $ExpectedPreimageSnapshot,
        $ExpectedSourceSnapshot,
        [switch]$LockHeld
    )

    if (-not $LockHeld) {
        $stateLock = Enter-DysonConfigurationMutationLock -Storage $Storage
        try {
            return Get-DysonConfigurationTransactionState -Storage $Storage `
                -ServiceSid $ServiceSid -Contract $Contract `
                -ExpectedLauncherBindings $ExpectedLauncherBindings `
                -ExpectedPreimageSnapshot $ExpectedPreimageSnapshot `
                -ExpectedSourceSnapshot $ExpectedSourceSnapshot -LockHeld
        }
        finally { $stateLock.Dispose() }
    }

    Assert-DysonConfigurationDataRootBinding -DataRoot $Storage.dataRoot `
        -ExpectedLauncherBindings $ExpectedLauncherBindings
    $parentAcl = Assert-DysonConfigurationParentAcl -Path $Storage.dataRoot -ServiceSid $ServiceSid
    foreach ($directory in @(
        $Storage.transactionRoot, $Storage.intentsRoot, $Storage.receiptsRoot, $Storage.snapshotRoot
    )) { [void](Assert-DysonConfigurationAcl -Path $directory -Kind PrivateDirectory) }
    $expectedTargetPathSha256 = Get-DysonConfigurationPathBindingSha256 `
        $Storage.configurationPath
    $expectedTargetAcl = Get-DysonConfigurationAclPolicy -Kind ConfigFile `
        -ServiceSid $ServiceSid
    $currentBindingsSha256 = Get-DysonConfigurationExpectedBindingsHash `
        -ExpectedLauncherBindings $ExpectedLauncherBindings -Contract $Contract
    $unknownTransactionEntries = @(Get-ChildItem -LiteralPath $Storage.transactionRoot -Force |
        Where-Object { $_.Name -notin @('intents', 'receipts', $script:DysonConfigurationLockName) })
    $writerOrphans = @()
    $intents = @{}
    $intentBySequence = @{}
    foreach ($item in @(Get-ChildItem -LiteralPath $Storage.intentsRoot -Force)) {
        if ($item.Name -like '.write-*.tmp') { $writerOrphans += $item; continue }
        if ($item.PSIsContainer -or $item.Name -cnotmatch '^(?<id>[0-9a-f-]{36})\.json$') {
            $unknownTransactionEntries += $item; continue
        }
        $recordFile = Read-DysonConfigurationPrivateJsonFile $item.FullName
        $validated = Assert-DysonConfigurationIntentRecord -Record $recordFile.value `
            -FileBaseName ([string]$Matches['id']) -Contract $Contract
        $entry = [pscustomobject][ordered]@{
            record = $validated.record
            bindings = $validated.bindings
            sha256 = [string]$recordFile.sha256
            path = [string]$recordFile.path
        }
        $sequenceKey = [string][int64]$entry.record.sequence
        if ($intentBySequence.ContainsKey($sequenceKey)) { throw 'DYSON_CONFIGURATION_CHAIN_INVALID' }
        $intents[[string]$entry.record.transactionId] = $entry
        $intentBySequence[$sequenceKey] = $entry
    }
    $receipts = @{}
    $receiptBySequence = @{}
    foreach ($item in @(Get-ChildItem -LiteralPath $Storage.receiptsRoot -Force)) {
        if ($item.Name -like '.write-*.tmp') { $writerOrphans += $item; continue }
        if ($item.PSIsContainer -or $item.Name -cnotmatch '^(?<id>[0-9a-f-]{36})\.json$') {
            $unknownTransactionEntries += $item; continue
        }
        $recordFile = Read-DysonConfigurationPrivateJsonFile $item.FullName
        $record = Assert-DysonConfigurationReceiptRecord -Record $recordFile.value `
            -FileBaseName ([string]$Matches['id'])
        $entry = [pscustomobject][ordered]@{
            record = $record; sha256 = [string]$recordFile.sha256; path = [string]$recordFile.path
        }
        $sequenceKey = [string][int64]$record.sequence
        if ($receiptBySequence.ContainsKey($sequenceKey)) { throw 'DYSON_CONFIGURATION_CHAIN_INVALID' }
        $receipts[[string]$record.transactionId] = $entry
        $receiptBySequence[$sequenceKey] = $entry
    }
    $pending = [System.Collections.Generic.List[object]]::new()
    $lastReceiptSha256 = $null
    $lastCompletedIntent = $null
    $lastCompletedReceipt = $null
    $intentCount = $intentBySequence.Count
    for ($sequence = 1; $sequence -le $intentCount; $sequence += 1) {
        $key = [string][int64]$sequence
        if (-not $intentBySequence.ContainsKey($key)) { throw 'DYSON_CONFIGURATION_CHAIN_INVALID' }
        $intent = $intentBySequence[$key]
        if ($sequence -eq 1) {
            if ($null -ne $intent.record.previousReceiptSha256) {
                throw 'DYSON_CONFIGURATION_CHAIN_INVALID'
            }
        }
        elseif ([string]$intent.record.previousReceiptSha256 -cne [string]$lastReceiptSha256) {
            throw 'DYSON_CONFIGURATION_CHAIN_INVALID'
        }
        $transactionId = [string]$intent.record.transactionId
        if ([string]$intent.record.targetPathSha256 -cne $expectedTargetPathSha256 -or
            [string]$intent.record.contractSha256 -cne [string]$Contract.sha256 -or
            [string]$intent.record.expectedAclFingerprint -cne
                [string]$expectedTargetAcl.fingerprint -or
            [string]$intent.record.parentAclFingerprint -cne [string]$parentAcl.fingerprint -or
            [string]$intent.record.serviceSid -cne $ServiceSid) {
            throw 'DYSON_CONFIGURATION_INTENT_BINDING_INVALID'
        }
        Assert-DysonConfigurationDataRootBinding -DataRoot $Storage.dataRoot `
            -ExpectedLauncherBindings ([hashtable]$intent.bindings)
        if ($receipts.ContainsKey($transactionId)) {
            $receipt = $receipts[$transactionId]
            if ([int64]$receipt.record.sequence -ne [int64]$intent.record.sequence -or
                [string]$receipt.record.intentSha256 -cne [string]$intent.sha256 -or
                [string]$receipt.record.previousReceiptSha256 -cne
                    [string]$intent.record.previousReceiptSha256) {
                throw 'DYSON_CONFIGURATION_RECEIPT_CHAIN_INVALID'
            }
            $expectedState = switch ([string]$intent.record.operation) {
                'create' { 'installed' }
                'reuse' { 'reused' }
                'replace' { 'replaced' }
                'restore' { 'restored' }
            }
            $aborted = [string]$receipt.record.state -ceq 'aborted'
            if (($aborted -and [string]$intent.record.operation -notin @('create', 'replace', 'restore')) -or
                (-not $aborted -and [string]$receipt.record.state -cne $expectedState)) {
                throw 'DYSON_CONFIGURATION_RECEIPT_CHAIN_INVALID'
            }
            $expectedSha = if ($aborted -and [bool]$intent.record.preimagePresent) {
                [string]$intent.record.preimageSha256
            }
                elseif ($aborted) { Get-DysonConfigurationSha256Bytes ([byte[]]::new(0)) }
                else { [string]$intent.record.sourceSha256 }
            $expectedLength = if ($aborted -and [bool]$intent.record.preimagePresent) {
                [int64]$intent.record.preimageLength
            }
                elseif ($aborted) { 0 }
                else { [int64]$intent.record.sourceLength }
            $expectedAcl = if ($aborted -and [bool]$intent.record.preimagePresent) {
                [string]$intent.record.preimageAclFingerprint
            }
                elseif ($aborted) { [string]$intent.record.expectedAclFingerprint }
                else { [string]$intent.record.expectedAclFingerprint }
            if ([string]$receipt.record.targetSha256 -cne $expectedSha -or
                [int64]$receipt.record.targetLength -ne $expectedLength -or
                [string]$receipt.record.targetAclFingerprint -cne $expectedAcl) {
                throw 'DYSON_CONFIGURATION_RECEIPT_CHAIN_INVALID'
            }
            $intentTime = [datetimeoffset]::ParseExact(
                [string]$intent.record.createdAt, 'o', [Globalization.CultureInfo]::InvariantCulture
            )
            $receiptTime = [datetimeoffset]::ParseExact(
                [string]$receipt.record.completedAt, 'o', [Globalization.CultureInfo]::InvariantCulture
            )
            if ($receiptTime -lt $intentTime) { throw 'DYSON_CONFIGURATION_RECEIPT_CHAIN_INVALID' }
            $lastReceiptSha256 = [string]$receipt.sha256
            $lastCompletedIntent = $intent
            $lastCompletedReceipt = $receipt
        }
        else {
            $pending.Add($intent)
            if ($sequence -ne $intentCount) { throw 'DYSON_CONFIGURATION_CHAIN_INVALID' }
        }
    }
    foreach ($transactionId in @($receipts.Keys)) {
        if (-not $intents.ContainsKey($transactionId)) {
            throw 'DYSON_CONFIGURATION_RECEIPT_CHAIN_INVALID'
        }
    }
    if ($pending.Count -eq 1) {
        $intent = $pending[0]
        if ([string]$intent.record.bindingsSha256 -cne $currentBindingsSha256) {
            throw 'DYSON_CONFIGURATION_INTENT_BINDING_INVALID'
        }
        if ([string]$intent.record.operation -in @('replace', 'restore')) {
            if (-not (Test-DysonConfigurationSnapshotBindingMatch `
                    -Expected $ExpectedPreimageSnapshot -Actual ([pscustomobject]@{
                        snapshotId = $intent.record.preimageSnapshotId
                        manifestSha256 = $intent.record.preimageSnapshotManifestSha256
                        snapshotPathSha256 = $intent.record.preimageSnapshotPathSha256
                        configurationSha256 = $intent.record.preimageSha256
                        configurationLength = $intent.record.preimageLength
                        configurationAclFingerprint = $intent.record.preimageAclFingerprint
                        bindingsSha256 = $intent.record.preimageBindingsSha256
                    }))) {
                throw 'DYSON_CONFIGURATION_PREIMAGE_SNAPSHOT_BINDING_INVALID'
            }
        }
        if ([string]$intent.record.operation -ceq 'restore') {
            if (-not (Test-DysonConfigurationSnapshotBindingMatch `
                    -Expected $ExpectedSourceSnapshot -Actual ([pscustomobject]@{
                        snapshotId = $intent.record.sourceSnapshotId
                        manifestSha256 = $intent.record.sourceSnapshotManifestSha256
                        snapshotPathSha256 = $intent.record.sourceSnapshotPathSha256
                        configurationSha256 = $intent.record.sourceSha256
                        configurationLength = $intent.record.sourceLength
                        configurationAclFingerprint = $intent.record.expectedAclFingerprint
                        bindingsSha256 = $intent.record.bindingsSha256
                    }) -IgnoreConfigurationAcl)) {
                throw 'DYSON_CONFIGURATION_SOURCE_SNAPSHOT_BINDING_INVALID'
            }
        }
    }
    $configurationTemps = @(Get-ChildItem -LiteralPath $Storage.configRoot -Force |
        Where-Object { $_.Name -like '.dyson-control.env.partial-*' })
    $configurationBackups = @(Get-ChildItem -LiteralPath $Storage.configRoot -Force |
        Where-Object { $_.Name -like '.dyson-control.env.preimage-*' })
    $unknownConfigEntries = @(Get-ChildItem -LiteralPath $Storage.configRoot -Force |
        Where-Object {
            $_.Name -cne $script:DysonConfigurationFileName -and
            $_.Name -cne $script:DysonConfigurationRuntimeApprovalName -and
            $_.Name -notlike '.dyson-control.env.partial-*' -and
            $_.Name -notlike '.dyson-control.env.preimage-*'
        })
    $baseClean = $pending.Count -eq 0 -and $writerOrphans.Count -eq 0 -and
        $configurationTemps.Count -eq 0 -and $configurationBackups.Count -eq 0 -and
        $unknownTransactionEntries.Count -eq 0 -and $unknownConfigEntries.Count -eq 0
    $terminalTargetPresent = $false
    $terminalTargetSha256 = $null
    $terminalTargetLength = $null
    $terminalTargetAclFingerprint = $null
    $terminalBindingsSha256 = $null
    $terminalReceiptState = $null
    $terminalSequence = $null
    if ($baseClean) {
        $targetPathExists = Test-Path -LiteralPath $Storage.configurationPath
        if ($null -eq $lastCompletedReceipt) {
            if ($targetPathExists) { throw 'DYSON_CONFIGURATION_UNRECEIPTED_TARGET' }
        }
        else {
            $terminalReceiptState = [string]$lastCompletedReceipt.record.state
            $terminalSequence = [int64]$lastCompletedReceipt.record.sequence
            $terminalTargetSha256 = [string]$lastCompletedReceipt.record.targetSha256
            $terminalTargetLength = [int64]$lastCompletedReceipt.record.targetLength
            $terminalTargetAclFingerprint = [string]$lastCompletedReceipt.record.targetAclFingerprint
            $terminalTargetExpected = -not (
                $terminalReceiptState -ceq 'aborted' -and
                -not [bool]$lastCompletedIntent.record.preimagePresent
            )
            $terminalBindings = $null
            if ($terminalReceiptState -ceq 'aborted') {
                if ([bool]$lastCompletedIntent.record.preimagePresent) {
                    $terminalSnapshotPath = Join-Path $Storage.snapshotRoot `
                        ([string]$lastCompletedIntent.record.preimageSnapshotId)
                    $terminalSnapshot = Read-DysonConfigurationSnapshotInternal `
                        -SnapshotPath $terminalSnapshotPath -Contract $Contract `
                        -ServiceSid $ServiceSid -ExpectedDataRoot $Storage.dataRoot
                    if (-not (Test-DysonConfigurationSnapshotBindingMatch `
                            -Expected ([pscustomobject]@{
                                snapshotId = $lastCompletedIntent.record.preimageSnapshotId
                                manifestSha256 = $lastCompletedIntent.record.preimageSnapshotManifestSha256
                                snapshotPathSha256 = $lastCompletedIntent.record.preimageSnapshotPathSha256
                                configurationSha256 = $lastCompletedIntent.record.preimageSha256
                                configurationLength = $lastCompletedIntent.record.preimageLength
                                configurationAclFingerprint = $lastCompletedIntent.record.preimageAclFingerprint
                                bindingsSha256 = $lastCompletedIntent.record.preimageBindingsSha256
                            }) -Actual $terminalSnapshot)) {
                        throw 'DYSON_CONFIGURATION_TERMINAL_SNAPSHOT_INVALID'
                    }
                    $terminalBindings = [hashtable]$terminalSnapshot.privateBindings
                    $terminalBindingsSha256 = [string]$lastCompletedIntent.record.preimageBindingsSha256
                }
            }
            else {
                $terminalBindings = [hashtable]$lastCompletedIntent.bindings
                $terminalBindingsSha256 = [string]$lastCompletedIntent.record.bindingsSha256
            }
            if ($terminalTargetExpected) {
                if (-not (Test-Path -LiteralPath $Storage.configurationPath -PathType Leaf) -or
                    $null -eq $terminalBindings) {
                    throw 'DYSON_CONFIGURATION_TERMINAL_TARGET_INVALID'
                }
                $terminalEvidence = $null
                $terminalEnvironment = $null
                try {
                    $terminalEvidence = Get-DysonConfigurationFileEvidence `
                        -Path $Storage.configurationPath -ServiceSid $ServiceSid -IncludePrivateBytes
                    $terminalEnvironment = Read-DysonControlEnvironmentBytes `
                        -Bytes ([byte[]]$terminalEvidence.privateBytes) -Contract $Contract `
                        -ExpectedLauncherBindings $terminalBindings
                    if ([string]$terminalEvidence.pathSha256 -cne $expectedTargetPathSha256 -or
                        [string]$terminalEvidence.sha256 -cne $terminalTargetSha256 -or
                        [int64]$terminalEvidence.length -ne $terminalTargetLength -or
                        [string]$terminalEvidence.aclFingerprint -cne $terminalTargetAclFingerprint -or
                        [string]$terminalEnvironment.sha256 -cne $terminalTargetSha256 -or
                        [int64]$terminalEnvironment.length -ne $terminalTargetLength -or
                        [string]$terminalEnvironment.bindingsSha256 -cne $terminalBindingsSha256 -or
                        [string]$terminalEnvironment.contractSha256 -cne [string]$Contract.sha256) {
                        throw 'DYSON_CONFIGURATION_TERMINAL_TARGET_INVALID'
                    }
                }
                catch {
                    if ([string]$_.Exception.Message -ceq
                        'DYSON_CONFIGURATION_TERMINAL_TARGET_INVALID') { throw }
                    throw 'DYSON_CONFIGURATION_TERMINAL_TARGET_INVALID'
                }
                finally {
                    if ($null -ne $terminalEvidence -and
                        $null -ne $terminalEvidence.PSObject.Properties['privateBytes']) {
                        [array]::Clear([byte[]]$terminalEvidence.privateBytes, 0,
                            ([byte[]]$terminalEvidence.privateBytes).Length)
                    }
                    $terminalEnvironment = $null
                }
                $terminalTargetPresent = $true
            }
            elseif ($targetPathExists) {
                throw 'DYSON_CONFIGURATION_TERMINAL_TARGET_INVALID'
            }
        }
    }
    return [pscustomobject][ordered]@{
        intents = $intents
        receipts = $receipts
        pending = @($pending)
        writerOrphans = @($writerOrphans)
        configurationTemps = @($configurationTemps)
        configurationBackups = @($configurationBackups)
        unknownTransactionEntries = @($unknownTransactionEntries)
        unknownConfigEntries = @($unknownConfigEntries)
        chainHeadSha256 = $lastReceiptSha256
        nextSequence = [int64]$intentCount + 1
        terminalTargetPresent = $terminalTargetPresent
        terminalTargetSha256 = $terminalTargetSha256
        terminalTargetLength = $terminalTargetLength
        terminalTargetAclFingerprint = $terminalTargetAclFingerprint
        terminalBindingsSha256 = $terminalBindingsSha256
        terminalContractSha256 = if ($null -ne $lastCompletedReceipt) {
            [string]$lastCompletedIntent.record.contractSha256
        } else { $null }
        terminalTargetPathSha256 = if ($null -ne $lastCompletedReceipt) {
            [string]$lastCompletedIntent.record.targetPathSha256
        } else { $null }
        terminalReceiptState = $terminalReceiptState
        terminalSequence = $terminalSequence
        clean = $baseClean
    }
}

function Get-DysonConfigurationRecoveryPlan {
    param(
        [Parameter(Mandatory)]$Storage,
        [Parameter(Mandatory)][string]$ServiceSid,
        [Parameter(Mandatory)]$Contract,
        [Parameter(Mandatory)][hashtable]$ExpectedLauncherBindings,
        $ExpectedPreimageSnapshot,
        $ExpectedSourceSnapshot,
        [switch]$LockHeld
    )

    $state = Get-DysonConfigurationTransactionState -Storage $Storage -ServiceSid $ServiceSid `
        -Contract $Contract -ExpectedLauncherBindings $ExpectedLauncherBindings `
        -ExpectedPreimageSnapshot $ExpectedPreimageSnapshot `
        -ExpectedSourceSnapshot $ExpectedSourceSnapshot -LockHeld:$LockHeld
    if ($state.writerOrphans.Count -gt 0 -or $state.unknownTransactionEntries.Count -gt 0 -or
        $state.unknownConfigEntries.Count -gt 0) {
        return [pscustomobject][ordered]@{ state = 'blocked-orphan'; transactionId = $null; automatic = $false }
    }
    if ($state.pending.Count -gt 1) {
        return [pscustomobject][ordered]@{ state = 'blocked-multiple-pending'; transactionId = $null; automatic = $false }
    }
    if ($state.pending.Count -eq 0) {
        if ($state.configurationTemps.Count -gt 0 -or $state.configurationBackups.Count -gt 0) {
            return [pscustomobject][ordered]@{ state = 'blocked-orphan'; transactionId = $null; automatic = $false }
        }
        return [pscustomobject][ordered]@{ state = 'clean'; transactionId = $null; automatic = $true }
    }
    $intent = $state.pending[0]
    $transactionId = [string]$intent.record.transactionId
    $expectedTemp = Join-Path $Storage.configRoot ([string]$intent.record.temporaryName)
    $expectedBackup = Join-Path $Storage.configRoot ([string]$intent.record.backupName)
    $otherTemps = @($state.configurationTemps | Where-Object {
        -not [string]::Equals($_.FullName, $expectedTemp, [System.StringComparison]::OrdinalIgnoreCase)
    })
    if ($otherTemps.Count -gt 0) {
        return [pscustomobject][ordered]@{ state = 'blocked-orphan'; transactionId = $transactionId; automatic = $false }
    }
    $otherBackups = @($state.configurationBackups | Where-Object {
        -not [string]::Equals($_.FullName, $expectedBackup, [System.StringComparison]::OrdinalIgnoreCase)
    })
    if ($otherBackups.Count -gt 0) {
        return [pscustomobject][ordered]@{ state = 'blocked-orphan'; transactionId = $transactionId; automatic = $false }
    }
    $target = $null
    if (Test-Path -LiteralPath $Storage.configurationPath) {
        if (-not (Test-Path -LiteralPath $Storage.configurationPath -PathType Leaf)) {
            return [pscustomobject][ordered]@{ state = 'blocked-target-mismatch'; transactionId = $transactionId; automatic = $false }
        }
        try { $target = Get-DysonConfigurationFileEvidence -Path $Storage.configurationPath -ServiceSid $ServiceSid }
        catch {
            return [pscustomobject][ordered]@{ state = 'blocked-target-mismatch'; transactionId = $transactionId; automatic = $false }
        }
    }
    $temp = $null
    $tempInvalid = $false
    $tempAbortEligible = $false
    if (Test-Path -LiteralPath $expectedTemp) {
        if (-not (Test-Path -LiteralPath $expectedTemp -PathType Leaf)) {
            $tempInvalid = $true
        }
        else {
            try {
                [void](Assert-DysonConfigurationPlainFilePath -Path $expectedTemp `
                    -MaximumBytes 65536 -AllowEmpty)
                $tempAbortEligible = $true
            }
            catch { $tempInvalid = $true }
            try { $temp = Get-DysonConfigurationFileEvidence -Path $expectedTemp -ServiceSid $ServiceSid }
            catch { $tempInvalid = $true }
            if ($null -ne $temp -and
                ([string]$temp.sha256 -cne [string]$intent.record.sourceSha256 -or
                    [int64]$temp.length -ne [int64]$intent.record.sourceLength -or
                    [string]$temp.aclFingerprint -cne [string]$intent.record.expectedAclFingerprint)) {
                $tempInvalid = $true
            }
        }
    }
    $backup = $null
    if (Test-Path -LiteralPath $expectedBackup) {
        if (-not (Test-Path -LiteralPath $expectedBackup -PathType Leaf)) {
            return [pscustomobject][ordered]@{ state = 'blocked-backup-mismatch'; transactionId = $transactionId; automatic = $false }
        }
        try { $backup = Get-DysonConfigurationFileEvidence -Path $expectedBackup -ServiceSid $ServiceSid }
        catch {
            return [pscustomobject][ordered]@{ state = 'blocked-backup-mismatch'; transactionId = $transactionId; automatic = $false }
        }
        if (-not [bool]$intent.record.preimagePresent -or
            [string]$backup.sha256 -cne [string]$intent.record.preimageSha256 -or
            [int64]$backup.length -ne [int64]$intent.record.preimageLength -or
            [string]$backup.aclFingerprint -cne [string]$intent.record.preimageAclFingerprint) {
            return [pscustomobject][ordered]@{ state = 'blocked-backup-mismatch'; transactionId = $transactionId; automatic = $false }
        }
    }
    $targetIsSource = $null -ne $target -and
        [string]$target.sha256 -ceq [string]$intent.record.sourceSha256 -and
        [int64]$target.length -eq [int64]$intent.record.sourceLength -and
        [string]$target.aclFingerprint -ceq [string]$intent.record.expectedAclFingerprint
    $targetIsPreimage = [bool]$intent.record.preimagePresent -and $null -ne $target -and
        [string]$target.sha256 -ceq [string]$intent.record.preimageSha256 -and
        [int64]$target.length -eq [int64]$intent.record.preimageLength -and
        [string]$target.aclFingerprint -ceq [string]$intent.record.preimageAclFingerprint
    if ($tempInvalid) {
        $safeAbort = $tempAbortEligible -and $null -eq $backup -and (
            ([string]$intent.record.operation -ceq 'create' -and $null -eq $target) -or
            ([string]$intent.record.operation -in @('replace', 'restore') -and $targetIsPreimage)
        )
        return [pscustomobject][ordered]@{
            state = if ($safeAbort) { 'abort-required' }
                elseif (-not $tempAbortEligible) { 'blocked-orphan' }
                else { 'blocked-target-mismatch' }
            transactionId = $transactionId
            automatic = $false
        }
    }
    switch ([string]$intent.record.operation) {
        'create' {
            if ($null -ne $backup) { $planState = 'blocked-backup-mismatch' }
            elseif ($targetIsSource -and $null -eq $temp) { $planState = 'finalize-receipt' }
            elseif ($null -eq $target -and $null -ne $temp) { $planState = 'finalize-create' }
            elseif ($null -eq $target -and $null -eq $temp) { $planState = 'resume-write' }
            else { $planState = 'blocked-target-mismatch' }
        }
        'reuse' {
            if ($null -ne $backup) { $planState = 'blocked-backup-mismatch' }
            elseif ($targetIsSource -and $null -eq $temp) { $planState = 'finalize-receipt' }
            else { $planState = 'blocked-target-mismatch' }
        }
        default {
            if ($targetIsSource -and $null -eq $temp -and $null -ne $backup) {
                $planState = 'finalize-backup-cleanup'
            }
            elseif ($targetIsSource -and $null -eq $temp -and $null -eq $backup) { $planState = 'finalize-receipt' }
            elseif ($targetIsPreimage -and $null -ne $temp) { $planState = 'finalize-replace' }
            elseif ($targetIsPreimage -and $null -eq $temp -and $null -eq $backup) { $planState = 'resume-write' }
            else { $planState = 'blocked-target-mismatch' }
        }
    }
    return [pscustomobject][ordered]@{
        state = $planState
        transactionId = $transactionId
        automatic = $planState -in @(
            'finalize-receipt', 'finalize-create', 'finalize-replace',
            'finalize-backup-cleanup', 'resume-write'
        )
    }
}

function Read-DysonConfigurationSnapshotInternal {
    param(
        [Parameter(Mandatory)][string]$SnapshotPath,
        [Parameter(Mandatory)]$Contract,
        [Parameter(Mandatory)][string]$ServiceSid,
        [string]$ExpectedDataRoot,
        [hashtable]$ExpectedLauncherBindings,
        [switch]$IncludePrivateBytes,
        [switch]$AllowStagingName
    )

    $snapshotFull = Assert-DysonConfigurationPlainDirectoryChain $SnapshotPath
    $snapshotParent = Assert-DysonConfigurationPlainDirectoryChain `
        ([System.IO.Path]::GetDirectoryName($snapshotFull))
    $parentAcl = Assert-DysonConfigurationAcl -Path $snapshotParent -Kind PrivateDirectory
    $snapshotAcl = Assert-DysonConfigurationAcl -Path $snapshotFull -Kind PrivateDirectory
    $manifestFile = Read-DysonConfigurationPrivateJsonFile `
        -Path (Join-Path $snapshotFull $script:DysonConfigurationSnapshotManifestName) `
        -MaximumBytes 65536
    $manifest = $manifestFile.value
    Assert-DysonConfigurationExactProperties -Value $manifest -Expected @(
        'protocol', 'schemaVersion', 'snapshotId', 'createdAt', 'contractSha256',
        'serviceSid', 'dataRootPathSha256', 'targetPathSha256', 'bindingsSha256',
        'launcherBindings', 'sourceConfigurationAclFingerprint',
        'parentAclFingerprint', 'directoryAclFingerprint', 'files'
    )
    [void](Assert-DysonConfigurationCanonicalGuid ([string]$manifest.snapshotId))
    [void](Assert-DysonConfigurationCanonicalTimestamp ([string]$manifest.createdAt))
    foreach ($hash in @(
        $manifest.contractSha256, $manifest.dataRootPathSha256, $manifest.targetPathSha256,
        $manifest.bindingsSha256, $manifest.parentAclFingerprint,
        $manifest.directoryAclFingerprint, $manifest.sourceConfigurationAclFingerprint
    )) { [void](Assert-DysonConfigurationCanonicalSha256 ([string]$hash)) }
    $expectedName = [string]$manifest.snapshotId
    if ($AllowStagingName) { $expectedName = '.snapshot-' + $expectedName + '.partial' }
    if ((-not ($manifest.schemaVersion -is [int] -or $manifest.schemaVersion -is [long])) -or
        [string]$manifest.protocol -cne $script:DysonConfigurationSnapshotProtocol -or
        [int]$manifest.schemaVersion -ne $script:DysonConfigurationSchemaVersion -or
        [string]$manifest.contractSha256 -cne [string]$Contract.sha256 -or
        [string]$manifest.serviceSid -cne $ServiceSid -or
        [string]$manifest.parentAclFingerprint -cne [string]$parentAcl.fingerprint -or
        [string]$manifest.directoryAclFingerprint -cne [string]$snapshotAcl.fingerprint -or
        [System.IO.Path]::GetFileName($snapshotFull) -cne $expectedName) {
        throw 'DYSON_CONFIGURATION_SNAPSHOT_INVALID'
    }
    $bindings = ConvertFrom-DysonConfigurationBindingRecord -Contract $Contract `
        -Record $manifest.launcherBindings
    $bindingsSha256 = Get-DysonConfigurationExpectedBindingsHash `
        -ExpectedLauncherBindings $bindings -Contract $Contract
    if ([string]$manifest.bindingsSha256 -cne $bindingsSha256) {
        throw 'DYSON_CONFIGURATION_SNAPSHOT_INVALID'
    }
    $expectedTargetAcl = Get-DysonConfigurationAclPolicy -Kind ConfigFile `
        -ServiceSid $ServiceSid
    if ([string]$manifest.sourceConfigurationAclFingerprint -cne
        [string]$expectedTargetAcl.fingerprint) {
        throw 'DYSON_CONFIGURATION_SNAPSHOT_INVALID'
    }
    Assert-DysonConfigurationDataRootBinding `
        -DataRoot ([string]$bindings['DYSON_DATA_DIR'] | Split-Path -Parent) `
        -ExpectedLauncherBindings $bindings
    if (-not [string]::IsNullOrWhiteSpace($ExpectedDataRoot)) {
        $dataFull = Assert-DysonConfigurationPlainDirectoryChain $ExpectedDataRoot
        if ([string]$manifest.dataRootPathSha256 -cne
                (Get-DysonConfigurationPathBindingSha256 $dataFull) -or
            [string]$manifest.targetPathSha256 -cne
                (Get-DysonConfigurationPathBindingSha256 `
                    (Join-Path (Join-Path $dataFull 'config') $script:DysonConfigurationFileName))) {
            throw 'DYSON_CONFIGURATION_SNAPSHOT_INVALID'
        }
    }
    if ($null -ne $ExpectedLauncherBindings -and
        $bindingsSha256 -cne (Get-DysonConfigurationExpectedBindingsHash `
            -ExpectedLauncherBindings $ExpectedLauncherBindings -Contract $Contract)) {
        throw 'DYSON_CONFIGURATION_SNAPSHOT_INVALID'
    }
    $inventory = @($manifest.files)
    if ($inventory.Count -ne 1) { throw 'DYSON_CONFIGURATION_SNAPSHOT_INVALID' }
    $fileRecord = $inventory[0]
    Assert-DysonConfigurationExactProperties -Value $fileRecord -Expected @(
        'relativePath', 'sha256', 'length', 'aclFingerprint'
    )
    foreach ($hash in @($fileRecord.sha256, $fileRecord.aclFingerprint)) {
        [void](Assert-DysonConfigurationCanonicalSha256 ([string]$hash))
    }
    if ((-not ($fileRecord.length -is [int] -or $fileRecord.length -is [long])) -or
        [string]$fileRecord.relativePath -cne $script:DysonConfigurationFileName -or
        [int64]$fileRecord.length -lt 1 -or [int64]$fileRecord.length -gt 65536) {
        throw 'DYSON_CONFIGURATION_SNAPSHOT_INVALID'
    }
    $actualEntries = @(Get-ChildItem -LiteralPath $snapshotFull -Force)
    if ($actualEntries.Count -ne 2 -or @($actualEntries | Where-Object {
            $_.Name -notin @(
                $script:DysonConfigurationSnapshotManifestName, $script:DysonConfigurationFileName
            )
        }).Count -ne 0) {
        throw 'DYSON_CONFIGURATION_SNAPSHOT_INVALID'
    }
    $payloadPath = Join-Path $snapshotFull $script:DysonConfigurationFileName
    $payloadFull = Assert-DysonConfigurationPlainFilePath -Path $payloadPath -MaximumBytes 65536
    $payloadAcl = Assert-DysonConfigurationAcl -Path $payloadFull -Kind PrivateFile
    $bytes = [System.IO.File]::ReadAllBytes(
        (ConvertTo-DysonConfigurationExtendedPath $payloadFull)
    )
    if ([string]$payloadAcl.fingerprint -cne [string]$fileRecord.aclFingerprint -or
        [int64]$bytes.Length -ne [int64]$fileRecord.length -or
        (Get-DysonConfigurationSha256Bytes $bytes) -cne [string]$fileRecord.sha256) {
        throw 'DYSON_CONFIGURATION_SNAPSHOT_INVALID'
    }
    $environment = Read-DysonControlEnvironmentBytes -Bytes $bytes -Contract $Contract `
        -ExpectedLauncherBindings $bindings
    $result = [ordered]@{
        valid = $true
        snapshotId = [string]$manifest.snapshotId
        snapshotPath = $snapshotFull
        snapshotPathSha256 = Get-DysonConfigurationPathBindingSha256 $snapshotFull
        payloadPath = $payloadFull
        payloadPathSha256 = Get-DysonConfigurationPathBindingSha256 $payloadFull
        configurationSha256 = [string]$environment.sha256
        configurationLength = [int64]$environment.length
        manifestSha256 = [string]$manifestFile.sha256
        directoryAclFingerprint = [string]$snapshotAcl.fingerprint
        parentAclFingerprint = [string]$parentAcl.fingerprint
        configurationAclFingerprint = [string]$manifest.sourceConfigurationAclFingerprint
        payloadAclFingerprint = [string]$payloadAcl.fingerprint
        bindingsSha256 = $bindingsSha256
        privateBindings = $bindings
    }
    if ($IncludePrivateBytes) { $result.privateBytes = $bytes }
    return [pscustomobject]$result
}

function Assert-DysonConfigurationSnapshot {
    param(
        [Parameter(Mandatory)][string]$SnapshotPath,
        [Parameter(Mandatory)]$Contract,
        [hashtable]$ExpectedLauncherBindings,
        [Parameter(Mandatory)][string]$ServiceSid,
        [string]$ExpectedDataRoot
    )

    $private = Read-DysonConfigurationSnapshotInternal -SnapshotPath $SnapshotPath `
        -Contract $Contract -ExpectedLauncherBindings $ExpectedLauncherBindings `
        -ServiceSid $ServiceSid -ExpectedDataRoot $ExpectedDataRoot
    return [pscustomobject][ordered]@{
        valid = $true
        snapshotId = [string]$private.snapshotId
        snapshotPathSha256 = [string]$private.snapshotPathSha256
        configurationSha256 = [string]$private.configurationSha256
        configurationLength = [int64]$private.configurationLength
        manifestSha256 = [string]$private.manifestSha256
        directoryAclFingerprint = [string]$private.directoryAclFingerprint
        parentAclFingerprint = [string]$private.parentAclFingerprint
        configurationAclFingerprint = [string]$private.configurationAclFingerprint
        bindingsSha256 = [string]$private.bindingsSha256
    }
}

function Assert-DysonConfigurationSnapshotInventory {
    param(
        [Parameter(Mandatory)]$Storage,
        [Parameter(Mandatory)]$Contract,
        [Parameter(Mandatory)][string]$ServiceSid
    )

    [void](Assert-DysonConfigurationAcl -Path $Storage.snapshotRoot -Kind PrivateDirectory)
    $count = 0
    foreach ($entry in @(Get-ChildItem -LiteralPath $Storage.snapshotRoot -Force)) {
        if (-not $entry.PSIsContainer -or $entry.Name -cnotmatch '^[0-9a-f-]{36}$') {
            throw 'DYSON_CONFIGURATION_SNAPSHOT_ORPHAN'
        }
        [void](Read-DysonConfigurationSnapshotInternal -SnapshotPath $entry.FullName `
            -Contract $Contract -ServiceSid $ServiceSid -ExpectedDataRoot $Storage.dataRoot)
        $count += 1
    }
    return $count
}

function New-DysonConfigurationProtectedSnapshot {
    param(
        [Parameter(Mandatory)]$Storage,
        [Parameter(Mandatory)]$Contract,
        [Parameter(Mandatory)][hashtable]$ExpectedLauncherBindings,
        [Parameter(Mandatory)][string]$ServiceSid,
        [string]$SnapshotId = ([guid]::NewGuid().ToString('D').ToLowerInvariant())
    )

    [void](Assert-DysonConfigurationCanonicalGuid $SnapshotId)
    [void](Assert-DysonConfigurationSnapshotInventory -Storage $Storage `
        -Contract $Contract -ServiceSid $ServiceSid)
    $configuration = Read-DysonControlEnvironmentFile -Path $Storage.configurationPath `
        -Contract $Contract -ExpectedLauncherBindings $ExpectedLauncherBindings -SkipSourceAcl
    $configurationAcl = Assert-DysonConfigurationAcl -Path $Storage.configurationPath `
        -Kind ConfigFile -ServiceSid $ServiceSid
    $partialPath = Join-Path $Storage.snapshotRoot ('.snapshot-' + $SnapshotId + '.partial')
    $finalPath = Join-Path $Storage.snapshotRoot $SnapshotId
    if ((Test-Path -LiteralPath $partialPath) -or (Test-Path -LiteralPath $finalPath)) {
        throw 'DYSON_CONFIGURATION_SNAPSHOT_TARGET_EXISTS'
    }
    [void][System.IO.Directory]::CreateDirectory($partialPath)
    [void](Set-DysonConfigurationAcl -Path $partialPath -Kind PrivateDirectory)
    $payload = Write-DysonConfigurationDurableFileCreateNew `
        -Path (Join-Path $partialPath $script:DysonConfigurationFileName) `
        -Bytes ([byte[]]$configuration.privateBytes) -Kind PrivateFile
    $payloadAcl = Assert-DysonConfigurationAcl -Path $payload.path -Kind PrivateFile
    $snapshotRootAcl = Assert-DysonConfigurationAcl -Path $Storage.snapshotRoot -Kind PrivateDirectory
    $snapshotAcl = Assert-DysonConfigurationAcl -Path $partialPath -Kind PrivateDirectory
    $manifest = [ordered]@{
        protocol = $script:DysonConfigurationSnapshotProtocol
        schemaVersion = $script:DysonConfigurationSchemaVersion
        snapshotId = $SnapshotId
        createdAt = (Get-Date).ToUniversalTime().ToString('o')
        contractSha256 = [string]$Contract.sha256
        serviceSid = $ServiceSid
        dataRootPathSha256 = Get-DysonConfigurationPathBindingSha256 $Storage.dataRoot
        targetPathSha256 = Get-DysonConfigurationPathBindingSha256 $Storage.configurationPath
        bindingsSha256 = Get-DysonConfigurationExpectedBindingsHash `
            -ExpectedLauncherBindings $ExpectedLauncherBindings -Contract $Contract
        launcherBindings = ConvertTo-DysonConfigurationBindingRecord -Contract $Contract `
            -ExpectedLauncherBindings $ExpectedLauncherBindings
        sourceConfigurationAclFingerprint = [string]$configurationAcl.fingerprint
        parentAclFingerprint = [string]$snapshotRootAcl.fingerprint
        directoryAclFingerprint = [string]$snapshotAcl.fingerprint
        files = @([ordered]@{
            relativePath = $script:DysonConfigurationFileName
            sha256 = [string]$payload.sha256
            length = [int64]$payload.length
            aclFingerprint = [string]$payloadAcl.fingerprint
        })
    }
    [void](Write-DysonConfigurationDurableJsonCreateNew `
        -Path (Join-Path $partialPath $script:DysonConfigurationSnapshotManifestName) `
        -Value $manifest)
    [void](Read-DysonConfigurationSnapshotInternal -SnapshotPath $partialPath `
        -Contract $Contract -ServiceSid $ServiceSid -ExpectedDataRoot $Storage.dataRoot `
        -ExpectedLauncherBindings $ExpectedLauncherBindings -AllowStagingName)
    [System.IO.Directory]::Move($partialPath, $finalPath)
    return Read-DysonConfigurationSnapshotInternal -SnapshotPath $finalPath `
        -Contract $Contract -ServiceSid $ServiceSid -ExpectedDataRoot $Storage.dataRoot `
        -ExpectedLauncherBindings $ExpectedLauncherBindings
}

function Get-DysonConfigurationSnapshotRestorePlan {
    param(
        [Parameter(Mandatory)][string]$SnapshotPath,
        [Parameter(Mandatory)][string]$DataRoot,
        [Parameter(Mandatory)]$Contract,
        [Parameter(Mandatory)][hashtable]$ExpectedLauncherBindings,
        [Parameter(Mandatory)][string]$ServiceSid
    )

    Assert-DysonConfigurationDataRootBinding -DataRoot $DataRoot `
        -ExpectedLauncherBindings $ExpectedLauncherBindings
    [void](Assert-DysonConfigurationParentAcl -Path $DataRoot -ServiceSid $ServiceSid)
    $snapshot = Read-DysonConfigurationSnapshotInternal -SnapshotPath $SnapshotPath `
        -Contract $Contract -ServiceSid $ServiceSid -ExpectedDataRoot $DataRoot
    $targetPath = Join-Path (Join-Path (Get-DysonConfigurationFullPath $DataRoot) 'config') `
        $script:DysonConfigurationFileName
    $target = $null
    if (Test-Path -LiteralPath $targetPath -PathType Leaf) {
        $target = Get-DysonConfigurationFileEvidence -Path $targetPath -ServiceSid $ServiceSid
    }
    return [pscustomobject][ordered]@{
        protocol = 'DYSON_CONTROL_CONFIGURATION_RESTORE_PLAN_V2'
        state = 'plan-only'
        snapshotId = [string]$snapshot.snapshotId
        snapshotConfigurationSha256 = [string]$snapshot.configurationSha256
        snapshotBindingsSha256 = [string]$snapshot.bindingsSha256
        targetPresent = $null -ne $target
        targetConfigurationSha256 = if ($target) { [string]$target.sha256 } else { $null }
        wouldReplace = $null -eq $target -or
            [string]$target.sha256 -cne [string]$snapshot.configurationSha256
        mutationPerformed = $false
    }
}

function Write-DysonConfigurationTransactionReceipt {
    param(
        [Parameter(Mandatory)]$Storage,
        [Parameter(Mandatory)]$IntentEntry,
        [Parameter(Mandatory)][string]$State
    )
    $value = New-DysonConfigurationReceiptValue -Intent $IntentEntry.record `
        -IntentSha256 ([string]$IntentEntry.sha256) -State $State
    return Write-DysonConfigurationDurableJsonCreateNew `
        -Path (Join-Path $Storage.receiptsRoot `
            (([string]$IntentEntry.record.transactionId) + '.json')) -Value $value
}

function Remove-DysonConfigurationVerifiedBackup {
    param(
        [Parameter(Mandatory)][string]$Path,
        [Parameter(Mandatory)]$Intent,
        [Parameter(Mandatory)][string]$ServiceSid
    )

    $backup = Get-DysonConfigurationFileEvidence -Path $Path -ServiceSid $ServiceSid
    if (-not [bool]$Intent.preimagePresent -or
        [string]$backup.sha256 -cne [string]$Intent.preimageSha256 -or
        [int64]$backup.length -ne [int64]$Intent.preimageLength -or
        [string]$backup.aclFingerprint -cne [string]$Intent.preimageAclFingerprint) {
        throw 'DYSON_CONFIGURATION_ATOMIC_BACKUP_MISMATCH'
    }
    [System.IO.File]::Delete($backup.path)
    if (Test-Path -LiteralPath $backup.path) {
        throw 'DYSON_CONFIGURATION_ATOMIC_BACKUP_DELETE_FAILED'
    }
}

function Invoke-DysonConfigurationMutationTransaction {
    param(
        [Parameter(Mandatory)]$Storage,
        [Parameter(Mandatory)]$Source,
        [Parameter(Mandatory)]$Contract,
        [Parameter(Mandatory)][hashtable]$ExpectedLauncherBindings,
        [Parameter(Mandatory)][string]$ServiceSid,
        [Parameter(Mandatory)][ValidateSet('create', 'reuse', 'replace', 'restore')]
        [string]$Operation,
        [Parameter(Mandatory)][ValidateSet('configuration-source', 'protected-snapshot')]
        [string]$SourceKind,
        [Parameter(Mandatory)][string]$SourcePathSha256,
        $PreimageSnapshot,
        $SourceSnapshot,
        [ValidateSet('Auto', 'Abort')][string]$RecoveryAction = 'Auto',
        [ValidateRange(1, 120)][int]$LockTimeoutSeconds = 30,
        [ValidateSet('', 'after-intent', 'after-stage', 'after-publish', 'before-receipt')]
        [string]$SelfTestCrashPoint = ''
    )

    $faultGate = Get-Variable -Name DysonConfigurationSelfTestFaultsEnabled `
        -Scope Script -ErrorAction SilentlyContinue
    if ($SelfTestCrashPoint -and ($null -eq $faultGate -or -not [bool]$faultGate.Value)) {
        throw 'DYSON_CONFIGURATION_SELFTEST_FAULT_DISABLED'
    }
    $requiresPreimageSnapshot = $Operation -in @('replace', 'restore')
    $requiresSourceSnapshot = $Operation -ceq 'restore'
    if ($requiresPreimageSnapshot -ne ($null -ne $PreimageSnapshot) -or
        $requiresSourceSnapshot -ne ($null -ne $SourceSnapshot) -or
        $requiresSourceSnapshot -ne ($SourceKind -ceq 'protected-snapshot')) {
        throw 'DYSON_CONFIGURATION_TRANSACTION_SNAPSHOT_ARGUMENT_INVALID'
    }
    if ($requiresSourceSnapshot -and
        ([string]$SourceSnapshot.snapshotId -ceq [string]$PreimageSnapshot.snapshotId -or
            [string]$SourceSnapshot.snapshotPathSha256 -ceq
                [string]$PreimageSnapshot.snapshotPathSha256)) {
        throw 'DYSON_CONFIGURATION_RESTORE_SNAPSHOTS_MUST_BE_DISTINCT'
    }
    try {
        foreach ($propertyName in @('sha256', 'length', 'bindingsSha256', 'privateBytes')) {
            if ($null -eq $Source.PSObject.Properties[$propertyName]) {
                throw 'missing source property'
            }
        }
        [void](Assert-DysonConfigurationCanonicalSha256 ([string]$Source.sha256))
        [void](Assert-DysonConfigurationCanonicalSha256 ([string]$Source.bindingsSha256))
        [void](Assert-DysonConfigurationCanonicalSha256 $SourcePathSha256)
        if ($Source.privateBytes -isnot [byte[]] -or
            (-not ($Source.length -is [int] -or $Source.length -is [long]))) {
            throw 'invalid source types'
        }
        $validatedSource = Read-DysonControlEnvironmentBytes `
            -Bytes ([byte[]]$Source.privateBytes) -Contract $Contract `
            -ExpectedLauncherBindings $ExpectedLauncherBindings
        if ([string]$validatedSource.sha256 -cne [string]$Source.sha256 -or
            [int64]$validatedSource.length -ne [int64]$Source.length -or
            [string]$validatedSource.bindingsSha256 -cne [string]$Source.bindingsSha256) {
            throw 'source evidence mismatch'
        }
    }
    catch { throw 'DYSON_CONFIGURATION_SOURCE_INVALID' }
    $lock = Enter-DysonConfigurationMutationLock -Storage $Storage `
        -TimeoutSeconds $LockTimeoutSeconds
    try {
        # Runtime readers cannot inspect the administrator-only journal. Revoke
        # its read-only approval before any intent or configuration publication.
        $approvalPath = Join-Path $Storage.configRoot $script:DysonConfigurationRuntimeApprovalName
        if (Test-Path -LiteralPath $approvalPath) {
            [void](Assert-DysonConfigurationPlainFilePath -Path $approvalPath -MaximumBytes 65536)
            [void](Assert-DysonConfigurationAcl -Path $approvalPath -Kind ConfigFile -ServiceSid $ServiceSid)
            [System.IO.File]::Delete((ConvertTo-DysonConfigurationExtendedPath $approvalPath))
        }
        if ($null -ne $PreimageSnapshot) {
            $refreshedPreimageSnapshot = Read-DysonConfigurationSnapshotInternal `
                -SnapshotPath ([string]$PreimageSnapshot.snapshotPath) -Contract $Contract `
                -ServiceSid $ServiceSid -ExpectedDataRoot $Storage.dataRoot
            if (-not (Test-DysonConfigurationSnapshotBindingMatch `
                    -Expected $PreimageSnapshot -Actual $refreshedPreimageSnapshot)) {
                throw 'DYSON_CONFIGURATION_PREIMAGE_SNAPSHOT_CHANGED'
            }
            $PreimageSnapshot = $refreshedPreimageSnapshot
        }
        if ($null -ne $SourceSnapshot) {
            $refreshedSourceSnapshot = Read-DysonConfigurationSnapshotInternal `
                -SnapshotPath ([string]$SourceSnapshot.snapshotPath) -Contract $Contract `
                -ServiceSid $ServiceSid -ExpectedDataRoot $Storage.dataRoot -IncludePrivateBytes
            if (-not (Test-DysonConfigurationSnapshotBindingMatch `
                    -Expected $SourceSnapshot -Actual $refreshedSourceSnapshot) -or
                [string]$refreshedSourceSnapshot.configurationSha256 -cne [string]$Source.sha256 -or
                [int64]$refreshedSourceSnapshot.configurationLength -ne [int64]$Source.length -or
                (Get-DysonConfigurationSha256Bytes ([byte[]]$Source.privateBytes)) -cne
                    [string]$refreshedSourceSnapshot.configurationSha256) {
                throw 'DYSON_CONFIGURATION_SOURCE_SNAPSHOT_CHANGED'
            }
            $SourceSnapshot = $refreshedSourceSnapshot
        }
        $state = Get-DysonConfigurationTransactionState -Storage $Storage `
            -ServiceSid $ServiceSid -Contract $Contract `
            -ExpectedLauncherBindings $ExpectedLauncherBindings `
            -ExpectedPreimageSnapshot $PreimageSnapshot -ExpectedSourceSnapshot $SourceSnapshot `
            -LockHeld
        $recovery = Get-DysonConfigurationRecoveryPlan -Storage $Storage `
            -ServiceSid $ServiceSid -Contract $Contract `
            -ExpectedLauncherBindings $ExpectedLauncherBindings `
            -ExpectedPreimageSnapshot $PreimageSnapshot -ExpectedSourceSnapshot $SourceSnapshot `
            -LockHeld
        $recovered = $false
        if ([string]$recovery.state -like 'blocked-*') {
            throw ('DYSON_CONFIGURATION_RECOVERY_' +
                ([string]$recovery.state).ToUpperInvariant().Replace('-', '_'))
        }
        if ([string]$recovery.state -ceq 'clean') {
            $target = $null
            if (Test-Path -LiteralPath $Storage.configurationPath -PathType Leaf) {
                $target = Get-DysonConfigurationFileEvidence -Path $Storage.configurationPath `
                    -ServiceSid $ServiceSid
            }
            switch ($Operation) {
                'create' {
                    if ($target) { throw 'DYSON_CONFIGURATION_TARGET_EXISTS' }
                    $preimage = $null
                }
                'reuse' {
                    if (-not $target -or [string]$target.sha256 -cne [string]$Source.sha256 -or
                        [int64]$target.length -ne [int64]$Source.length) {
                        throw 'DYSON_CONFIGURATION_PREIMAGE_INVALID'
                    }
                    $preimage = $target
                }
                default {
                    if (-not $target -or -not $PreimageSnapshot -or
                        [string]$target.sha256 -cne [string]$PreimageSnapshot.configurationSha256 -or
                        [int64]$target.length -ne [int64]$PreimageSnapshot.configurationLength -or
                        [string]$target.aclFingerprint -cne
                            [string]$PreimageSnapshot.configurationAclFingerprint) {
                        throw 'DYSON_CONFIGURATION_PREIMAGE_INVALID'
                    }
                    $preimage = $target
                }
            }
            $intentValue = New-DysonConfigurationIntentValue -Storage $Storage -Source $Source `
                -Contract $Contract -ExpectedLauncherBindings $ExpectedLauncherBindings `
                -ServiceSid $ServiceSid -Operation $Operation -SourceKind $SourceKind `
                -SourcePathSha256 $SourcePathSha256 -Sequence ([int64]$state.nextSequence) `
                -PreviousReceiptSha256 ([string]$state.chainHeadSha256) -Preimage $preimage `
                -PreimageSnapshot $PreimageSnapshot -SourceSnapshot $SourceSnapshot
            $intentWrite = Write-DysonConfigurationDurableJsonCreateNew `
                -Path (Join-Path $Storage.intentsRoot `
                    (([string]$intentValue.transactionId) + '.json')) -Value $intentValue
            $intentEntry = [pscustomobject][ordered]@{
                record = [pscustomobject]$intentValue
                sha256 = [string]$intentWrite.sha256
                path = [string]$intentWrite.path
            }
            if ($SelfTestCrashPoint -ceq 'after-intent') {
                throw 'DYSON_CONFIGURATION_SELFTEST_CRASH_AFTER_INTENT'
            }
            $recoveryState = if ($Operation -ceq 'reuse') { 'finalize-receipt' } else { 'resume-write' }
        }
        else {
            $recovered = $true
            $intentEntry = $state.pending[0]
            if ([string]$intentEntry.record.operation -cne $Operation -or
                [string]$intentEntry.record.sourceKind -cne $SourceKind -or
                [string]$intentEntry.record.sourcePathSha256 -cne $SourcePathSha256 -or
                [string]$intentEntry.record.sourceSha256 -cne [string]$Source.sha256 -or
                [int64]$intentEntry.record.sourceLength -ne [int64]$Source.length) {
                throw 'DYSON_CONFIGURATION_PENDING_SOURCE_MISMATCH'
            }
            $recoveryState = [string]$recovery.state
        }
        $temporaryPath = Join-Path $Storage.configRoot ([string]$intentEntry.record.temporaryName)
        $backupPath = Join-Path $Storage.configRoot ([string]$intentEntry.record.backupName)
        $receiptState = switch ($Operation) {
            'create' { 'installed' }
            'reuse' { 'reused' }
            'replace' { 'replaced' }
            'restore' { 'restored' }
        }
        switch ($recoveryState) {
            'resume-write' {
                [void](Write-DysonConfigurationStagedFile -Path $temporaryPath `
                    -Bytes ([byte[]]$Source.privateBytes) -ServiceSid $ServiceSid)
                if ($SelfTestCrashPoint -ceq 'after-stage') {
                    throw 'DYSON_CONFIGURATION_SELFTEST_CRASH_AFTER_STAGE'
                }
                $publishMode = if ($Operation -ceq 'create') { 'create' } else { 'replace' }
                $publishBackupPath = if ($publishMode -ceq 'replace') { $backupPath } else { $null }
                [void](Invoke-DysonConfigurationAtomicPublish -StagedPath $temporaryPath `
                    -TargetPath $Storage.configurationPath -Mode $publishMode `
                    -ServiceSid $ServiceSid -ExpectedSha256 ([string]$Source.sha256) `
                    -ExpectedLength ([int64]$Source.length) -BackupPath $publishBackupPath)
                if ($SelfTestCrashPoint -ceq 'after-publish') {
                    throw 'DYSON_CONFIGURATION_SELFTEST_CRASH_AFTER_PUBLISH'
                }
                if ($publishMode -ceq 'replace') {
                    Remove-DysonConfigurationVerifiedBackup -Path $backupPath `
                        -Intent $intentEntry.record -ServiceSid $ServiceSid
                }
                if ($SelfTestCrashPoint -ceq 'before-receipt') {
                    throw 'DYSON_CONFIGURATION_SELFTEST_CRASH_BEFORE_RECEIPT'
                }
                [void](Write-DysonConfigurationTransactionReceipt -Storage $Storage `
                    -IntentEntry $intentEntry -State $receiptState)
            }
            'finalize-create' {
                [void](Invoke-DysonConfigurationAtomicPublish -StagedPath $temporaryPath `
                    -TargetPath $Storage.configurationPath -Mode create -ServiceSid $ServiceSid `
                    -ExpectedSha256 ([string]$Source.sha256) `
                    -ExpectedLength ([int64]$Source.length))
                [void](Write-DysonConfigurationTransactionReceipt -Storage $Storage `
                    -IntentEntry $intentEntry -State $receiptState)
            }
            'finalize-replace' {
                [void](Invoke-DysonConfigurationAtomicPublish -StagedPath $temporaryPath `
                    -TargetPath $Storage.configurationPath -Mode replace -ServiceSid $ServiceSid `
                    -ExpectedSha256 ([string]$Source.sha256) `
                    -ExpectedLength ([int64]$Source.length) -BackupPath $backupPath)
                Remove-DysonConfigurationVerifiedBackup -Path $backupPath `
                    -Intent $intentEntry.record -ServiceSid $ServiceSid
                [void](Write-DysonConfigurationTransactionReceipt -Storage $Storage `
                    -IntentEntry $intentEntry -State $receiptState)
            }
            'finalize-backup-cleanup' {
                Remove-DysonConfigurationVerifiedBackup -Path $backupPath `
                    -Intent $intentEntry.record -ServiceSid $ServiceSid
                [void](Write-DysonConfigurationTransactionReceipt -Storage $Storage `
                    -IntentEntry $intentEntry -State $receiptState)
            }
            'finalize-receipt' {
                [void](Write-DysonConfigurationTransactionReceipt -Storage $Storage `
                    -IntentEntry $intentEntry -State $receiptState)
            }
            'abort-required' {
                if ($RecoveryAction -cne 'Abort') {
                    throw 'DYSON_CONFIGURATION_RECOVERY_ABORT_REQUIRED'
                }
                if (Test-Path -LiteralPath $backupPath) {
                    throw 'DYSON_CONFIGURATION_RECOVERY_ABORT_TARGET_INVALID'
                }
                if ($Operation -ceq 'create') {
                    if (Test-Path -LiteralPath $Storage.configurationPath) {
                        throw 'DYSON_CONFIGURATION_RECOVERY_ABORT_TARGET_INVALID'
                    }
                }
                else {
                    if (-not (Test-Path -LiteralPath $Storage.configurationPath -PathType Leaf)) {
                        throw 'DYSON_CONFIGURATION_RECOVERY_ABORT_TARGET_INVALID'
                    }
                    $abortTarget = Get-DysonConfigurationFileEvidence `
                        -Path $Storage.configurationPath -ServiceSid $ServiceSid
                    if (-not [bool]$intentEntry.record.preimagePresent -or
                        [string]$abortTarget.sha256 -cne [string]$intentEntry.record.preimageSha256 -or
                        [int64]$abortTarget.length -ne [int64]$intentEntry.record.preimageLength -or
                        [string]$abortTarget.aclFingerprint -cne
                            [string]$intentEntry.record.preimageAclFingerprint) {
                        throw 'DYSON_CONFIGURATION_RECOVERY_ABORT_TARGET_INVALID'
                    }
                }
                $abortTemporaryPath = Assert-DysonConfigurationPlainFilePath `
                    -Path $temporaryPath -MaximumBytes 65536 -AllowEmpty
                if (-not (Test-DysonConfigurationPathWithin -Candidate $abortTemporaryPath `
                        -Parent $Storage.configRoot) -or
                    -not [string]::Equals(
                        $abortTemporaryPath, (Get-DysonConfigurationFullPath $temporaryPath),
                        [System.StringComparison]::OrdinalIgnoreCase
                    )) {
                    throw 'DYSON_CONFIGURATION_RECOVERY_PATH_INVALID'
                }
                [System.IO.File]::Delete($abortTemporaryPath)
                if (Test-Path -LiteralPath $abortTemporaryPath) {
                    throw 'DYSON_CONFIGURATION_RECOVERY_ABORT_DELETE_FAILED'
                }
                if ($Operation -ceq 'create') {
                    if (Test-Path -LiteralPath $Storage.configurationPath) {
                        throw 'DYSON_CONFIGURATION_RECOVERY_ABORT_TARGET_INVALID'
                    }
                }
                else {
                    $abortTargetAfterDelete = Get-DysonConfigurationFileEvidence `
                        -Path $Storage.configurationPath -ServiceSid $ServiceSid
                    if ([string]$abortTargetAfterDelete.sha256 -cne
                            [string]$intentEntry.record.preimageSha256 -or
                        [int64]$abortTargetAfterDelete.length -ne
                            [int64]$intentEntry.record.preimageLength -or
                        [string]$abortTargetAfterDelete.aclFingerprint -cne
                            [string]$intentEntry.record.preimageAclFingerprint) {
                        throw 'DYSON_CONFIGURATION_RECOVERY_ABORT_TARGET_INVALID'
                    }
                }
                [void](Write-DysonConfigurationTransactionReceipt -Storage $Storage `
                    -IntentEntry $intentEntry -State aborted)
                $receiptState = 'aborted'
            }
            default { throw 'DYSON_CONFIGURATION_RECOVERY_STATE_INVALID' }
        }
        $finalState = Get-DysonConfigurationTransactionState -Storage $Storage `
            -ServiceSid $ServiceSid -Contract $Contract `
            -ExpectedLauncherBindings $ExpectedLauncherBindings -LockHeld
        if (-not $finalState.clean) { throw 'DYSON_CONFIGURATION_TRANSACTION_NOT_CLEAN' }
        $targetEvidence = $null
        if (Test-Path -LiteralPath $Storage.configurationPath -PathType Leaf) {
            $targetEvidence = Get-DysonConfigurationFileEvidence `
                -Path $Storage.configurationPath -ServiceSid $ServiceSid
        }
        if ($receiptState -cne 'aborted') {
            if ($null -eq $targetEvidence) {
                throw 'DYSON_CONFIGURATION_TARGET_VERIFICATION_FAILED'
            }
            $installed = Read-DysonControlEnvironmentFile -Path $Storage.configurationPath `
                -Contract $Contract -ExpectedLauncherBindings $ExpectedLauncherBindings -SkipSourceAcl
            if ([string]$installed.sha256 -cne [string]$Source.sha256 -or
                [int64]$installed.length -ne [int64]$Source.length) {
                throw 'DYSON_CONFIGURATION_TARGET_VERIFICATION_FAILED'
            }
        }
        elseif ([bool]$intentEntry.record.preimagePresent) {
            if ($null -eq $targetEvidence -or
                [string]$targetEvidence.sha256 -cne [string]$intentEntry.record.preimageSha256 -or
                [int64]$targetEvidence.length -ne [int64]$intentEntry.record.preimageLength -or
                [string]$targetEvidence.aclFingerprint -cne
                    [string]$intentEntry.record.preimageAclFingerprint) {
                throw 'DYSON_CONFIGURATION_RECOVERY_ABORT_TARGET_INVALID'
            }
        }
        elseif ($null -ne $targetEvidence -or (Test-Path -LiteralPath $Storage.configurationPath)) {
            throw 'DYSON_CONFIGURATION_RECOVERY_ABORT_TARGET_INVALID'
        }
        if ($null -ne $targetEvidence -and $receiptState -cne 'aborted') {
            Publish-DysonConfigurationRuntimeApproval -Storage $Storage -Contract $Contract `
                -ExpectedLauncherBindings $ExpectedLauncherBindings -ServiceSid $ServiceSid -TransactionState $finalState
        }
        if ($null -eq $targetEvidence) {
            $targetEvidence = [pscustomobject][ordered]@{
                sha256 = Get-DysonConfigurationSha256Bytes ([byte[]]::new(0))
                length = [int64]0
                aclFingerprint = [string]$intentEntry.record.expectedAclFingerprint
            }
        }
        return [pscustomobject][ordered]@{
            state = if ($receiptState -ceq 'aborted') { 'aborted' }
                elseif ($recovered) { 'recovered' } else { 'completed' }
            operation = $Operation
            receiptState = $receiptState
            transactionId = [string]$intentEntry.record.transactionId
            sequence = [int64]$intentEntry.record.sequence
            configurationSha256 = [string]$targetEvidence.sha256
            configurationLength = [int64]$targetEvidence.length
            configurationAclFingerprint = [string]$targetEvidence.aclFingerprint
            chainHeadSha256 = [string]$finalState.chainHeadSha256
            completedTransactionCount = [int]$finalState.receipts.Count
        }
    }
    finally { $lock.Dispose() }
}

function Publish-DysonConfigurationRuntimeApproval {
    param($Storage, $Contract, [hashtable]$ExpectedLauncherBindings, [string]$ServiceSid, $TransactionState)
    if (-not $TransactionState.clean -or $TransactionState.receipts.Count -lt 1) {
        throw 'DYSON_CONFIGURATION_TRANSACTION_NOT_CLEAN'
    }
    $configuration = Read-DysonControlEnvironmentFile -Path $Storage.configurationPath `
        -Contract $Contract -ExpectedLauncherBindings $ExpectedLauncherBindings -SkipSourceAcl
    try {
        $acl = Assert-DysonConfigurationAcl -Path $Storage.configurationPath -Kind ConfigFile -ServiceSid $ServiceSid
        $snapshotCount = Assert-DysonConfigurationSnapshotInventory -Storage $Storage -Contract $Contract -ServiceSid $ServiceSid
        $approval = [ordered]@{
            protocol = 'DYSON_CONTROL_CONFIGURATION_RUNTIME_APPROVAL_V1'
            configurationSha256 = [string]$configuration.sha256
            configurationLength = [int64]$configuration.length
            namesSha256 = [string]$configuration.namesSha256
            bindingsSha256 = [string]$configuration.bindingsSha256
            contractSha256 = [string]$Contract.sha256
            configurationAclFingerprint = [string]$acl.fingerprint
            configurationPathSha256 = Get-DysonConfigurationPathBindingSha256 $Storage.configurationPath
            serviceSid = $ServiceSid
            completedTransactionCount = [int]$TransactionState.receipts.Count
            transactionChainHeadSha256 = [string]$TransactionState.chainHeadSha256
            protectedSnapshotCount = [int]$snapshotCount
        }
        $bytes = [Text.UTF8Encoding]::new($false).GetBytes(($approval | ConvertTo-Json -Compress))
        [void](Write-DysonConfigurationStagedFile `
            -Path (Join-Path $Storage.configRoot $script:DysonConfigurationRuntimeApprovalName) `
            -Bytes $bytes -ServiceSid $ServiceSid)
    }
    finally {
        if ($configuration.privateBytes) { [Array]::Clear($configuration.privateBytes, 0, $configuration.privateBytes.Length) }
        if ($configuration.privateValues) { $configuration.privateValues.Clear() }
    }
}

function Test-DysonConfigurationRuntimeApproval {
    param($Storage, $Contract, [hashtable]$ExpectedLauncherBindings, [string]$ServiceSid, $ParentAcl)
    [void](Assert-DysonConfigurationAcl -Path $Storage.configRoot -Kind ConfigDirectory -ServiceSid $ServiceSid)
    $approvalPath = Join-Path $Storage.configRoot $script:DysonConfigurationRuntimeApprovalName
    [void](Assert-DysonConfigurationPlainFilePath -Path $approvalPath -MaximumBytes 65536)
    [void](Assert-DysonConfigurationAcl -Path $approvalPath -Kind ConfigFile -ServiceSid $ServiceSid)
    $bytes = [IO.File]::ReadAllBytes((ConvertTo-DysonConfigurationExtendedPath $approvalPath))
    try { $approval = [Text.UTF8Encoding]::new($false, $true).GetString($bytes) | ConvertFrom-Json }
    catch { throw 'DYSON_CONFIGURATION_RUNTIME_APPROVAL_INVALID' }
    Assert-DysonConfigurationExactProperties -Value $approval -Expected @(
        'protocol', 'configurationSha256', 'configurationLength', 'namesSha256', 'bindingsSha256',
        'contractSha256', 'configurationAclFingerprint', 'configurationPathSha256', 'serviceSid',
        'completedTransactionCount', 'transactionChainHeadSha256', 'protectedSnapshotCount'
    )
    foreach ($field in @('configurationLength', 'completedTransactionCount', 'protectedSnapshotCount')) {
        if ($approval.$field -isnot [int] -and $approval.$field -isnot [long]) {
            throw 'DYSON_CONFIGURATION_RUNTIME_APPROVAL_INVALID'
        }
    }
    $configuration = Read-DysonControlEnvironmentFile -Path $Storage.configurationPath `
        -Contract $Contract -ExpectedLauncherBindings $ExpectedLauncherBindings -SkipSourceAcl
    try {
        $acl = Assert-DysonConfigurationAcl -Path $Storage.configurationPath -Kind ConfigFile -ServiceSid $ServiceSid
        if ($approval.protocol -cne 'DYSON_CONTROL_CONFIGURATION_RUNTIME_APPROVAL_V1' -or
            $approval.serviceSid -cne $ServiceSid -or $approval.completedTransactionCount -lt 1 -or
            $approval.protectedSnapshotCount -lt 0 -or
            $approval.transactionChainHeadSha256 -cnotmatch '^[0-9a-f]{64}$' -or
            $approval.configurationSha256 -cne $configuration.sha256 -or
            $approval.configurationLength -ne $configuration.length -or
            $approval.namesSha256 -cne $configuration.namesSha256 -or
            $approval.bindingsSha256 -cne $configuration.bindingsSha256 -or
            $approval.contractSha256 -cne $Contract.sha256 -or
            $approval.configurationAclFingerprint -cne $acl.fingerprint -or
            $approval.configurationPathSha256 -cne (Get-DysonConfigurationPathBindingSha256 $Storage.configurationPath)) {
            throw 'DYSON_CONFIGURATION_RUNTIME_APPROVAL_MISMATCH'
        }
        $after = [IO.File]::ReadAllBytes((ConvertTo-DysonConfigurationExtendedPath $approvalPath))
        [void](Assert-DysonConfigurationAcl -Path $approvalPath -Kind ConfigFile -ServiceSid $ServiceSid)
        if ((Get-DysonConfigurationSha256Bytes $after) -cne (Get-DysonConfigurationSha256Bytes $bytes)) {
            throw 'DYSON_CONFIGURATION_RUNTIME_APPROVAL_CHANGED'
        }
        return [pscustomobject][ordered]@{
            protocol = 'DYSON_CONTROL_CONFIGURATION_RUNTIME_TEST_RESULT_V1'
            healthy = $true
            configurationSha256 = [string]$configuration.sha256
            configurationLength = [int64]$configuration.length
            namesSha256 = [string]$configuration.namesSha256
            bindingsSha256 = [string]$configuration.bindingsSha256
            contractSha256 = [string]$Contract.sha256
            configurationAclFingerprint = [string]$acl.fingerprint
            parentAclFingerprint = [string]$ParentAcl.fingerprint
            completedTransactionCount = [int]$approval.completedTransactionCount
            transactionChainHeadSha256 = [string]$approval.transactionChainHeadSha256
            protectedSnapshotCount = [int]$approval.protectedSnapshotCount
            snapshot = $null
            restorePlan = $null
            mutationPerformed = $false
        }
    }
    finally {
        if ($configuration.privateBytes) { [Array]::Clear($configuration.privateBytes, 0, $configuration.privateBytes.Length) }
        if ($configuration.privateValues) { $configuration.privateValues.Clear() }
    }
}
