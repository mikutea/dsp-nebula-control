Set-StrictMode -Version 2.0

$script:DysonGsRemovalProtocol = 'DYSON_GSMANAGER_REMOVAL_V1'
$script:DysonGsRemovalGuardProtocol = 'DYSON_GSMANAGER_REMOVAL_GUARD_V1'
$script:DysonGsRemovalAclProtocol = 'DYSON_GSMANAGER_REMOVAL_ACL_INVENTORY_V1'
$script:DysonGsRemovalIntentProtocol = 'DYSON_GSMANAGER_REMOVAL_TRANSACTION_V1'
$script:DysonGsRemovalReceiptProtocol = 'DYSON_GSMANAGER_REMOVAL_RECEIPT_V1'
$script:DysonGsRemovalRestoreReceiptProtocol = 'DYSON_GSMANAGER_REMOVAL_RESTORE_RECEIPT_V1'
$script:DysonGsRemovalAuditProtocol = 'DYSON_GSMANAGER_REMOVAL_AUDIT_V1'
$script:DysonGsRemovalInspectionProtocol = 'DYSON_GSMANAGER_REMOVAL_INSPECTION_V1'
$script:DysonGsRemovalShadowRuntimeProtocol = 'DYSON_GSMANAGER_REMOVAL_SHADOW_RUNTIME_V1'
$script:DysonGsRemovalShadowTaskSecurityProtocol = 'DYSON_GSMANAGER_REMOVAL_SHADOW_TASK_SECURITY_V1'
$script:DysonGsRemovalSchemaVersion = 1
$script:DysonGsRemovalRelativeRoot = 'migration\removals'
$script:DysonGsRemovalTaskPath = '\'
$script:DysonGsRemovalMaximumJsonBytes = [int64](16MB)
$script:DysonGsRemovalMaximumAclEntries = 100000

function New-DysonGsRemovalException {
    param([Parameter(Mandatory)][string]$Code)

    $exception = [System.InvalidOperationException]::new($Code)
    $exception.Data['Code'] = $Code
    return $exception
}

function Throw-DysonGsRemovalError {
    param([Parameter(Mandatory)][string]$Code)

    throw (New-DysonGsRemovalException -Code $Code)
}

function Get-DysonGsRemovalErrorCode {
    param([Parameter(Mandatory)][System.Exception]$Exception)

    if ($Exception.Data.Contains('Code')) {
        $code = [string]$Exception.Data['Code']
        if ($code -match '^(?:DYSON_GSMANAGER_REMOVAL|DYSON_HOST_MUTATION_LEASE)_[A-Z0-9_]+$') {
            return $code
        }
    }
    return 'DYSON_GSMANAGER_REMOVAL_FAILED'
}

function ConvertTo-DysonGsRemovalJson {
    param([Parameter(Mandatory)]$Value)

    return ($Value | ConvertTo-Json -Depth 32 -Compress)
}

function Get-DysonGsRemovalSha256Bytes {
    param([Parameter(Mandatory)][byte[]]$Bytes)

    $hasher = [System.Security.Cryptography.SHA256]::Create()
    try {
        return ([System.BitConverter]::ToString($hasher.ComputeHash($Bytes))).Replace('-', '').ToLowerInvariant()
    }
    finally { $hasher.Dispose() }
}

function Get-DysonGsRemovalSha256Text {
    param([Parameter(Mandatory)][AllowEmptyString()][string]$Text)

    return Get-DysonGsRemovalSha256Bytes -Bytes ([System.Text.UTF8Encoding]::new($false).GetBytes($Text))
}

function Test-DysonGsRemovalBytesEqual {
    param([Parameter(Mandatory)][byte[]]$Left, [Parameter(Mandatory)][byte[]]$Right)

    if ($Left.Length -ne $Right.Length) { return $false }
    $difference = 0
    for ($index = 0; $index -lt $Left.Length; $index++) {
        $difference = $difference -bor ([int]$Left[$index] -bxor [int]$Right[$index])
    }
    return $difference -eq 0
}

function Assert-DysonGsRemovalExactProperties {
    param(
        [Parameter(Mandatory)]$Value,
        [Parameter(Mandatory)][string[]]$Expected,
        [Parameter(Mandatory)][string]$Code
    )

    if ($null -eq $Value -or $Value -is [string] -or $Value -is [ValueType]) {
        Throw-DysonGsRemovalError $Code
    }
    $actual = @($Value.PSObject.Properties | ForEach-Object { $_.Name })
    if ($actual.Count -ne $Expected.Count) { Throw-DysonGsRemovalError $Code }
    for ($index = 0; $index -lt $Expected.Count; $index++) {
        if ([string]$actual[$index] -cne [string]$Expected[$index]) {
            Throw-DysonGsRemovalError $Code
        }
    }
}

function Assert-DysonGsRemovalGuid {
    param([AllowNull()]$Value, [Parameter(Mandatory)][string]$Code)

    $parsed = [guid]::Empty
    if ($Value -isnot [string] -or -not [guid]::TryParseExact([string]$Value, 'D', [ref]$parsed)) {
        Throw-DysonGsRemovalError $Code
    }
    return $parsed.ToString('D').ToLowerInvariant()
}

function Assert-DysonGsRemovalDigest {
    param([AllowNull()]$Value, [Parameter(Mandatory)][string]$Code)

    if ($Value -isnot [string] -or [string]$Value -cnotmatch '^[0-9a-f]{64}$') {
        Throw-DysonGsRemovalError $Code
    }
    return [string]$Value
}

function Assert-DysonGsRemovalTimestamp {
    param([AllowNull()]$Value, [Parameter(Mandatory)][string]$Code)

    if ($Value -isnot [string] -or [string]$Value -notmatch '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{7}Z$') {
        Throw-DysonGsRemovalError $Code
    }
    try {
        [void][DateTime]::ParseExact(
            [string]$Value,
            'o',
            [Globalization.CultureInfo]::InvariantCulture,
            [Globalization.DateTimeStyles]::RoundtripKind
        )
    }
    catch { Throw-DysonGsRemovalError $Code }
}

function Get-DysonGsRemovalPathIdentity {
    param([Parameter(Mandatory)][string]$Path)

    return 'sha256:' + (Get-DysonGsRemovalSha256Text -Text ((Get-DysonGsFullPath -Path $Path).TrimEnd('\', '/').ToUpperInvariant()))
}

function Assert-DysonGsRemovalPrivateDirectory {
    param([Parameter(Mandatory)][string]$Path)

    try {
        $directory = Assert-DysonGsPlainDirectory -Path $Path
        $identity = [System.Security.Principal.WindowsIdentity]::GetCurrent()
        $allowed = @{
            $identity.User.Value = $true
            'S-1-5-18' = $true
            'S-1-5-32-544' = $true
        }
        $security = Microsoft.PowerShell.Security\Get-Acl -LiteralPath $directory -ErrorAction Stop
        if (-not [bool]$security.AreAccessRulesProtected) { throw 'inheritance enabled' }
        $rules = @($security.GetAccessRules($true, $false, [System.Security.Principal.SecurityIdentifier]))
        if ($rules.Count -ne $allowed.Count) { throw 'unexpected rule count' }
        foreach ($rule in $rules) {
            if (-not $allowed.ContainsKey([string]$rule.IdentityReference.Value) -or
                $rule.AccessControlType -ne [System.Security.AccessControl.AccessControlType]::Allow -or
                ($rule.FileSystemRights -band [System.Security.AccessControl.FileSystemRights]::FullControl) -ne
                    [System.Security.AccessControl.FileSystemRights]::FullControl) {
                throw 'unexpected rule'
            }
        }
        return $directory
    }
    catch { Throw-DysonGsRemovalError 'DYSON_GSMANAGER_REMOVAL_GUARD_ACCESS_CONTROL_INVALID' }
}

function New-DysonGsRemovalPrivateDirectory {
    param([Parameter(Mandatory)][string]$Path)

    try {
        if (Test-Path -LiteralPath $Path) {
            return Assert-DysonGsRemovalPrivateDirectory -Path $Path
        }
        [void](New-DysonGsPlainDirectory -Path $Path -Private)
        return Assert-DysonGsRemovalPrivateDirectory -Path $Path
    }
    catch {
        if ($_.Exception.Data.Contains('Code')) { throw $_.Exception }
        Throw-DysonGsRemovalError 'DYSON_GSMANAGER_REMOVAL_GUARD_ACCESS_CONTROL_INVALID'
    }
}

function Get-DysonGsRemovalStorage {
    param([Parameter(Mandatory)][string]$DataRoot, [switch]$Create)

    try {
        $data = Assert-DysonGsPlainDirectory -Path $DataRoot
        $migration = Join-Path $data 'migration'
        if ($Create -and -not (Test-Path -LiteralPath $migration)) {
            [void](New-DysonGsPlainDirectory -Path $migration)
        }
        $migration = Assert-DysonGsPlainDirectory -Path $migration
        $root = Join-Path $data $script:DysonGsRemovalRelativeRoot
        if ($Create) { $root = New-DysonGsRemovalPrivateDirectory -Path $root }
        else { $root = Assert-DysonGsRemovalPrivateDirectory -Path $root }
        $guards = Join-Path $root 'guards'
        $receipts = Join-Path $root 'receipts'
        $restoreReceipts = Join-Path $root 'restore-receipts'
        $audit = Join-Path $root 'audit'
        foreach ($candidate in @($guards, $receipts, $restoreReceipts, $audit)) {
            if ($Create) { [void](New-DysonGsRemovalPrivateDirectory -Path $candidate) }
            else { [void](Assert-DysonGsRemovalPrivateDirectory -Path $candidate) }
        }
        return [pscustomobject][ordered]@{
            root = $root
            guardsRoot = $guards
            receiptsRoot = $receipts
            restoreReceiptsRoot = $restoreReceipts
            auditRoot = $audit
            activeIntent = Join-Path $root 'active-intent.json'
        }
    }
    catch {
        if ($_.Exception.Data.Contains('Code')) { throw $_.Exception }
        Throw-DysonGsRemovalError 'DYSON_GSMANAGER_REMOVAL_STORAGE_INVALID'
    }
}

function Get-DysonGsRemovalPaths {
    param(
        [Parameter(Mandatory)]$Storage,
        [Parameter(Mandatory)][string]$RemovalRequestId,
        [string]$RestoreRequestId
    )

    $removalId = Assert-DysonGsRemovalGuid $RemovalRequestId 'DYSON_GSMANAGER_REMOVAL_INPUT_INVALID'
    $result = [ordered]@{
        guard = Join-Path $Storage.guardsRoot $removalId
        receipt = Join-Path $Storage.receiptsRoot ($removalId + '.json')
        restoreReceipt = $null
    }
    if (-not [string]::IsNullOrWhiteSpace($RestoreRequestId)) {
        $restoreId = Assert-DysonGsRemovalGuid $RestoreRequestId 'DYSON_GSMANAGER_REMOVAL_INPUT_INVALID'
        $result.restoreReceipt = Join-Path $Storage.restoreReceiptsRoot ($restoreId + '.json')
    }
    return [pscustomobject]$result
}

function Get-DysonGsRemovalOsPath {
    param([Parameter(Mandatory)][string]$Path)

    # Keep all policy, containment, reparse, and ACL decisions on an ordinary
    # canonical path.  This conversion is deliberately the last step before a
    # Windows filesystem API call: callers must never be able to smuggle a
    # device namespace through the public removal surface.
    $separator = [string][System.IO.Path]::DirectorySeparatorChar
    $doubleSeparator = $separator + $separator
    $extendedPrefix = $doubleSeparator + '?' + $separator
    if ($Path -match '^[\\/]{2}[?.][\\/]') {
        throw 'A removal filesystem path cannot use a device namespace.'
    }
    $full = Get-DysonGsFullPath -Path $Path
    if ($full -match '^[\\/]{2}[?.][\\/]') {
        throw 'A removal filesystem path cannot use a device namespace.'
    }
    if ($full.StartsWith($doubleSeparator, [System.StringComparison]::Ordinal)) {
        return $extendedPrefix + 'UNC' + $separator + $full.Substring(2)
    }
    if ($full -match '^[A-Za-z]:\\') {
        return $extendedPrefix + $full
    }
    throw 'A removal filesystem path is not a local or UNC path.'
}

function Write-DysonGsRemovalBytesNew {
    param(
        [Parameter(Mandatory)][string]$Path,
        [Parameter(Mandatory)][byte[]]$Bytes,
        [int64]$MaximumBytes = [int64](16MB)
    )

    Assert-DysonGsRemovalLease
    if ($Bytes.Length -lt 1 -or $Bytes.Length -gt $MaximumBytes) {
        Throw-DysonGsRemovalError 'DYSON_GSMANAGER_REMOVAL_DURABLE_WRITE_FAILED'
    }
    [void](Get-DysonGsRemovalOsPath -Path $Path)
    $parent = Assert-DysonGsRemovalPrivateDirectory -Path ([IO.Path]::GetDirectoryName($Path))
    $target = Get-DysonGsFullPath -Path $Path
    if (-not (Test-DysonGsPathWithin -Candidate $target -Parent $parent) -or (Test-Path -LiteralPath $target)) {
        Throw-DysonGsRemovalError 'DYSON_GSMANAGER_REMOVAL_DURABLE_WRITE_FAILED'
    }
    $temporary = Join-Path $parent ('.dyson-gsm-removal-' + [guid]::NewGuid().ToString('N') + '.tmp')
    try {
        $temporaryOs = Get-DysonGsRemovalOsPath -Path $temporary
        $targetOs = Get-DysonGsRemovalOsPath -Path $target
        $stream = [IO.FileStream]::new(
            $temporaryOs,
            [IO.FileMode]::CreateNew,
            [IO.FileAccess]::Write,
            [IO.FileShare]::None,
            4096,
            [IO.FileOptions]::WriteThrough
        )
        try {
            $stream.Write($Bytes, 0, $Bytes.Length)
            $stream.Flush($true)
        }
        finally { $stream.Dispose() }
        [IO.File]::Move($temporaryOs, $targetOs)
    }
    catch { Throw-DysonGsRemovalError 'DYSON_GSMANAGER_REMOVAL_DURABLE_WRITE_FAILED' }
    finally {
        try {
            $temporaryOs = Get-DysonGsRemovalOsPath -Path $temporary
            if ([IO.File]::Exists($temporaryOs)) { [IO.File]::Delete($temporaryOs) }
        }
        catch { }
    }
    Assert-DysonGsRemovalLease
}

function Write-DysonGsRemovalJsonNew {
    param(
        [Parameter(Mandatory)][string]$Path,
        [Parameter(Mandatory)]$Value,
        [int64]$MaximumBytes = [int64](16MB)
    )

    $bytes = [Text.UTF8Encoding]::new($false).GetBytes((ConvertTo-DysonGsRemovalJson $Value) + "`n")
    Write-DysonGsRemovalBytesNew -Path $Path -Bytes $bytes -MaximumBytes $MaximumBytes
}

function Write-DysonGsRemovalJsonReplace {
    param(
        [Parameter(Mandatory)][string]$Path,
        [Parameter(Mandatory)]$Value,
        [int64]$MaximumBytes = [int64](16MB)
    )

    Assert-DysonGsRemovalLease
    $bytes = [Text.UTF8Encoding]::new($false).GetBytes((ConvertTo-DysonGsRemovalJson $Value) + "`n")
    if ($bytes.Length -lt 1 -or $bytes.Length -gt $MaximumBytes) {
        Throw-DysonGsRemovalError 'DYSON_GSMANAGER_REMOVAL_DURABLE_WRITE_FAILED'
    }
    [void](Get-DysonGsRemovalOsPath -Path $Path)
    $parent = Assert-DysonGsRemovalPrivateDirectory -Path ([IO.Path]::GetDirectoryName($Path))
    $target = Get-DysonGsFullPath -Path $Path
    if (-not (Test-DysonGsPathWithin -Candidate $target -Parent $parent)) {
        Throw-DysonGsRemovalError 'DYSON_GSMANAGER_REMOVAL_DURABLE_WRITE_FAILED'
    }
    $temporary = Join-Path $parent ('.dyson-gsm-removal-' + [guid]::NewGuid().ToString('N') + '.tmp')
    $backup = Join-Path $parent ('.dyson-gsm-removal-' + [guid]::NewGuid().ToString('N') + '.bak')
    try {
        $temporaryOs = Get-DysonGsRemovalOsPath -Path $temporary
        $targetOs = Get-DysonGsRemovalOsPath -Path $target
        $backupOs = Get-DysonGsRemovalOsPath -Path $backup
        $stream = [IO.FileStream]::new(
            $temporaryOs,
            [IO.FileMode]::CreateNew,
            [IO.FileAccess]::Write,
            [IO.FileShare]::None,
            4096,
            [IO.FileOptions]::WriteThrough
        )
        try {
            $stream.Write($bytes, 0, $bytes.Length)
            $stream.Flush($true)
        }
        finally { $stream.Dispose() }
        if ([IO.File]::Exists($targetOs)) {
            [IO.File]::Replace($temporaryOs, $targetOs, $backupOs, $true)
            if ([IO.File]::Exists($backupOs)) { [IO.File]::Delete($backupOs) }
        }
        else { [IO.File]::Move($temporaryOs, $targetOs) }
    }
    catch { Throw-DysonGsRemovalError 'DYSON_GSMANAGER_REMOVAL_DURABLE_WRITE_FAILED' }
    finally {
        foreach ($candidate in @($temporary, $backup)) {
            try {
                $candidateOs = Get-DysonGsRemovalOsPath -Path $candidate
                if ([IO.File]::Exists($candidateOs)) { [IO.File]::Delete($candidateOs) }
            }
            catch { }
        }
    }
    Assert-DysonGsRemovalLease
}

function Read-DysonGsRemovalJson {
    param(
        [Parameter(Mandatory)][string]$Path,
        [int64]$MaximumBytes = [int64](16MB),
        [switch]$AllowMissing
    )

    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
        if ($AllowMissing) { return $null }
        Throw-DysonGsRemovalError 'DYSON_GSMANAGER_REMOVAL_EVIDENCE_MISSING'
    }
    try {
        $item = Assert-DysonGsPlainFile -Path $Path -MaximumBytes $MaximumBytes
        $bytes = [IO.File]::ReadAllBytes($item.FullName)
        $text = [Text.UTF8Encoding]::new($false, $true).GetString($bytes)
        if ($text.IndexOf([char]0) -ge 0) { throw 'nul' }
        return ($text | ConvertFrom-Json -ErrorAction Stop)
    }
    catch {
        if ($_.Exception.Data.Contains('Code')) { throw $_.Exception }
        Throw-DysonGsRemovalError 'DYSON_GSMANAGER_REMOVAL_EVIDENCE_INVALID'
    }
}

function Remove-DysonGsRemovalOwnedFile {
    param([Parameter(Mandatory)][string]$Path, [Parameter(Mandatory)][string]$Parent)

    Assert-DysonGsRemovalLease
    if (-not (Test-Path -LiteralPath $Path)) { return }
    $parentFull = Assert-DysonGsRemovalPrivateDirectory -Path $Parent
    $pathFull = Get-DysonGsFullPath -Path $Path
    if (-not (Test-DysonGsPathWithin -Candidate $pathFull -Parent $parentFull)) {
        Throw-DysonGsRemovalError 'DYSON_GSMANAGER_REMOVAL_STORAGE_INVALID'
    }
    $item = Assert-DysonGsPlainFile -Path $pathFull -MaximumBytes $script:DysonGsRemovalMaximumJsonBytes
    Remove-Item -LiteralPath $item.FullName -Force -ErrorAction Stop
    Assert-DysonGsRemovalLease
}

function Assert-DysonGsRemovalLease {
    if ($null -eq $script:DysonGsRemovalLease -or -not [bool]$script:DysonGsRemovalLease.Active) {
        Throw-DysonGsRemovalError 'DYSON_GSMANAGER_REMOVAL_LEASE_LOST'
    }
    try {
        [void](Assert-DysonHostMutationLeaseBorrow -DataRoot $script:DysonGsRemovalDataRoot `
            -InstanceId ([string]$script:DysonGsRemovalLease.InstanceId) `
            -Token ([string]$script:DysonGsRemovalLease.Token))
    }
    catch {
        if ($_.Exception.Data.Contains('Code')) { throw $_.Exception }
        Throw-DysonGsRemovalError 'DYSON_GSMANAGER_REMOVAL_LEASE_LOST'
    }
}

function Set-DysonGsRemovalCutoverLeaseContext {
    Assert-DysonGsRemovalLease
    $script:CutoverHostLeaseInstanceId = [string]$script:DysonGsRemovalLease.InstanceId
    $script:CutoverHostLeaseToken = [string]$script:DysonGsRemovalLease.Token
    $script:CutoverHostMutationMode = $true
}

function Enter-DysonGsRemovalLease {
    param(
        [Parameter(Mandatory)][string]$Operation,
        [Parameter(Mandatory)][string]$RequestId,
        [switch]$Recover
    )

    if ($Operation -notin @('gsmanager-removal', 'gsmanager-removal-restore')) {
        Throw-DysonGsRemovalError 'DYSON_GSMANAGER_REMOVAL_INPUT_INVALID'
    }
    $owner = if ($Operation -ceq 'gsmanager-removal') { 'gsmanager-removal' } else { 'gsmanager-removal-restorer' }
    if ($Recover) {
        $candidate = Get-DysonHostMutationLeaseRecoveryCandidate -DataRoot $script:DysonGsRemovalDataRoot -TimeoutMilliseconds 0
        if ([string]$candidate.priorOperation -cne $Operation -or [string]$candidate.priorRequestId -cne $RequestId) {
            Throw-DysonGsRemovalError 'DYSON_GSMANAGER_REMOVAL_RECOVERY_MISMATCH'
        }
        $script:DysonGsRemovalLease = Enter-DysonHostMutationLease -DataRoot $script:DysonGsRemovalDataRoot `
            -Owner $owner -Operation $Operation -RequestId $RequestId -OwnerPid $PID -TimeoutMilliseconds 0 `
            -RecoveryPriorInstanceId ([string]$candidate.priorInstanceId) `
            -RecoveryPriorRecordDigest ([string]$candidate.priorRecordDigest)
    }
    else {
        $script:DysonGsRemovalLease = Enter-DysonHostMutationLease -DataRoot $script:DysonGsRemovalDataRoot `
            -Owner $owner -Operation $Operation -RequestId $RequestId -OwnerPid $PID -TimeoutMilliseconds 0
    }
    Set-DysonGsRemovalCutoverLeaseContext
    return $script:DysonGsRemovalLease
}

function Exit-DysonGsRemovalLease {
    param([ValidateSet('released', 'abandoned')][string]$State = 'released')

    if ($null -ne $script:DysonGsRemovalLease -and [bool]$script:DysonGsRemovalLease.Active) {
        [void](Exit-DysonHostMutationLease -Lease $script:DysonGsRemovalLease -State $State)
    }
    $script:CutoverHostMutationMode = $false
    $script:CutoverHostLeaseInstanceId = $null
    $script:CutoverHostLeaseToken = $null
}

function Enter-DysonGsRemovalTerminalReconciliationLease {
    param(
        [Parameter(Mandatory)][ValidateSet('gsmanager-removal', 'gsmanager-removal-restore')][string]$Operation,
        [Parameter(Mandatory)][string]$RequestId,
        [switch]$Recover
    )

    if ($Recover) {
        $status = Get-DysonHostMutationLeaseStatus -DataRoot $script:DysonGsRemovalDataRoot
        if ([string]$status.state -cin @('active', 'abandoned', 'recovery-required')) {
            return Enter-DysonGsRemovalLease -Operation $Operation -RequestId $RequestId -Recover
        }
    }
    return Enter-DysonGsRemovalLease -Operation $Operation -RequestId $RequestId
}

function Get-DysonGsRemovalSecurityDescriptorBytes {
    param([Parameter(Mandatory)][string]$Path)

    try {
        $security = Microsoft.PowerShell.Security\Get-Acl -LiteralPath $Path -ErrorAction Stop
        return [byte[]]$security.GetSecurityDescriptorBinaryForm()
    }
    catch { Throw-DysonGsRemovalError 'DYSON_GSMANAGER_REMOVAL_ACCESS_CONTROL_INVALID' }
}

function Set-DysonGsRemovalSecurityDescriptorBytes {
    param(
        [Parameter(Mandatory)][string]$Path,
        [Parameter(Mandatory)][byte[]]$Bytes,
        [Parameter(Mandatory)][bool]$Directory
    )

    Assert-DysonGsRemovalLease
    try {
        $sections = [Security.AccessControl.AccessControlSections]::Owner -bor
            [Security.AccessControl.AccessControlSections]::Group -bor
            [Security.AccessControl.AccessControlSections]::Access
        $security = if ($Directory) {
            [Security.AccessControl.DirectorySecurity]::new()
        }
        else { [Security.AccessControl.FileSecurity]::new() }
        $security.SetSecurityDescriptorBinaryForm($Bytes, $sections)
        Microsoft.PowerShell.Security\Set-Acl -LiteralPath $Path -AclObject $security -ErrorAction Stop
    }
    catch { Throw-DysonGsRemovalError 'DYSON_GSMANAGER_REMOVAL_ACCESS_CONTROL_RESTORE_FAILED' }
    Assert-DysonGsRemovalLease
}

function Get-DysonGsRemovalAclInventory {
    param([Parameter(Mandatory)][string]$Root)

    $rootFull = Assert-DysonGsPlainDirectory -Path $Root
    $entries = New-Object 'System.Collections.Generic.List[object]'
    $pending = New-Object 'System.Collections.Generic.Stack[string]'
    $pending.Push($rootFull)
    while ($pending.Count -gt 0) {
        $directory = $pending.Pop()
        $relative = if ([string]::Equals($directory, $rootFull, [StringComparison]::OrdinalIgnoreCase)) {
            '.'
        }
        else { Get-DysonGsRelativePath -Root $rootFull -Path $directory }
        $bytes = Get-DysonGsRemovalSecurityDescriptorBytes -Path $directory
        $entries.Add([pscustomobject][ordered]@{
            path = $relative
            kind = 'directory'
            securityDescriptorBase64 = [Convert]::ToBase64String($bytes)
            securityDescriptorSha256 = Get-DysonGsRemovalSha256Bytes $bytes
        })
        if ($entries.Count -gt $script:DysonGsRemovalMaximumAclEntries) {
            Throw-DysonGsRemovalError 'DYSON_GSMANAGER_REMOVAL_ACL_INVENTORY_TOO_LARGE'
        }
        foreach ($item in @(Get-ChildItem -LiteralPath $directory -Force -ErrorAction Stop)) {
            if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) {
                Throw-DysonGsRemovalError 'DYSON_GSMANAGER_REMOVAL_ROOT_INVALID'
            }
            if (-not (Test-DysonGsPathWithin -Candidate $item.FullName -Parent $rootFull)) {
                Throw-DysonGsRemovalError 'DYSON_GSMANAGER_REMOVAL_ROOT_INVALID'
            }
            if ($item.PSIsContainer) { $pending.Push($item.FullName); continue }
            if ($item -isnot [IO.FileInfo]) { Throw-DysonGsRemovalError 'DYSON_GSMANAGER_REMOVAL_ROOT_INVALID' }
            $fileBytes = Get-DysonGsRemovalSecurityDescriptorBytes -Path $item.FullName
            $entries.Add([pscustomobject][ordered]@{
                path = Get-DysonGsRelativePath -Root $rootFull -Path $item.FullName
                kind = 'file'
                securityDescriptorBase64 = [Convert]::ToBase64String($fileBytes)
                securityDescriptorSha256 = Get-DysonGsRemovalSha256Bytes $fileBytes
            })
            if ($entries.Count -gt $script:DysonGsRemovalMaximumAclEntries) {
                Throw-DysonGsRemovalError 'DYSON_GSMANAGER_REMOVAL_ACL_INVENTORY_TOO_LARGE'
            }
        }
    }
    $ordered = @($entries | Sort-Object -Property @{ Expression = { $_.path } }, @{ Expression = { $_.kind } } -CaseSensitive)
    $digestLines = @($ordered | ForEach-Object {
        '{0}|{1}|{2}|{3}' -f [string]$_.path, [string]$_.kind,
            [string]$_.securityDescriptorSha256, [string]$_.securityDescriptorBase64
    })
    return [pscustomobject][ordered]@{
        entries = $ordered
        entryCount = [int]$ordered.Count
        inventorySha256 = Get-DysonGsRemovalSha256Text ([string]::Join("`n", $digestLines))
    }
}

function Test-DysonGsRemovalAclInventoriesEqual {
    param([Parameter(Mandatory)]$Left, [Parameter(Mandatory)]$Right)

    $leftEntries = @($Left.entries)
    $rightEntries = @($Right.entries)
    if ($leftEntries.Count -ne $rightEntries.Count -or
        [string]$Left.inventorySha256 -cne [string]$Right.inventorySha256) { return $false }
    for ($index = 0; $index -lt $leftEntries.Count; $index++) {
        foreach ($field in @('path', 'kind', 'securityDescriptorSha256', 'securityDescriptorBase64')) {
            if ([string]$leftEntries[$index].$field -cne [string]$rightEntries[$index].$field) { return $false }
        }
    }
    return $true
}

function Restore-DysonGsRemovalAclInventory {
    param([Parameter(Mandatory)][string]$Root, [Parameter(Mandatory)]$Inventory)

    Assert-DysonGsRemovalLease
    $rootFull = Assert-DysonGsPlainDirectory -Path $Root
    $entries = @($Inventory.entries | Sort-Object -Property @{ Expression = {
        if ([string]$_.path -ceq '.') { 0 } else { ([string]$_.path -split '/').Count }
    } } -Descending)
    foreach ($entry in $entries) {
        $path = if ([string]$entry.path -ceq '.') { $rootFull } else {
            Join-Path $rootFull ([string]$entry.path).Replace('/', '\')
        }
        if (-not (Test-DysonGsPathWithin -Candidate $path -Parent $rootFull -AllowEqual)) {
            Throw-DysonGsRemovalError 'DYSON_GSMANAGER_REMOVAL_ACCESS_CONTROL_RESTORE_FAILED'
        }
        $isDirectory = [string]$entry.kind -ceq 'directory'
        if ($isDirectory) { [void](Assert-DysonGsPlainDirectory -Path $path) }
        else { [void](Assert-DysonGsPlainFile -Path $path -MaximumBytes $script:DysonGsHardMaximumSingleFileBytes) }
        $bytes = [Convert]::FromBase64String([string]$entry.securityDescriptorBase64)
        $currentBytes = Get-DysonGsRemovalSecurityDescriptorBytes -Path $path
        if (-not (Test-DysonGsRemovalBytesEqual $currentBytes $bytes)) {
            Set-DysonGsRemovalSecurityDescriptorBytes -Path $path -Bytes $bytes -Directory:$isDirectory
        }
    }
    $actual = Get-DysonGsRemovalAclInventory -Root $rootFull
    if (-not (Test-DysonGsRemovalAclInventoriesEqual -Left $Inventory -Right $actual)) {
        Throw-DysonGsRemovalError 'DYSON_GSMANAGER_REMOVAL_ACCESS_CONTROL_RESTORE_FAILED'
    }
}

function Write-DysonGsRemovalAclInventoryNew {
    param([Parameter(Mandatory)][string]$Path, [Parameter(Mandatory)]$Inventory)

    $value = [pscustomobject][ordered]@{
        protocol = $script:DysonGsRemovalAclProtocol
        schemaVersion = $script:DysonGsRemovalSchemaVersion
        entryCount = [int]$Inventory.entryCount
        inventorySha256 = [string]$Inventory.inventorySha256
        entries = @($Inventory.entries)
    }
    Write-DysonGsRemovalJsonNew -Path $Path -Value $value -MaximumBytes $script:DysonGsRemovalMaximumJsonBytes
}

function Read-DysonGsRemovalAclInventory {
    param([Parameter(Mandatory)][string]$Path)

    $code = 'DYSON_GSMANAGER_REMOVAL_ACL_INVENTORY_INVALID'
    $value = Read-DysonGsRemovalJson -Path $Path -MaximumBytes $script:DysonGsRemovalMaximumJsonBytes
    Assert-DysonGsRemovalExactProperties $value @('protocol', 'schemaVersion', 'entryCount', 'inventorySha256', 'entries') $code
    if ($value.protocol -isnot [string] -or [string]$value.protocol -cne $script:DysonGsRemovalAclProtocol -or
        ($value.schemaVersion -isnot [int] -and $value.schemaVersion -isnot [long]) -or [int64]$value.schemaVersion -ne 1 -or
        ($value.entryCount -isnot [int] -and $value.entryCount -isnot [long]) -or
        [int64]$value.entryCount -lt 1 -or [int64]$value.entryCount -gt $script:DysonGsRemovalMaximumAclEntries) {
        Throw-DysonGsRemovalError $code
    }
    $expectedDigest = Assert-DysonGsRemovalDigest $value.inventorySha256 $code
    $entries = @($value.entries)
    if ($entries.Count -ne [int]$value.entryCount) { Throw-DysonGsRemovalError $code }
    $validated = New-Object 'System.Collections.Generic.List[object]'
    $previousPath = $null
    foreach ($entry in $entries) {
        Assert-DysonGsRemovalExactProperties $entry @('path', 'kind', 'securityDescriptorBase64', 'securityDescriptorSha256') $code
        if ($entry.path -isnot [string] -or [string]::IsNullOrWhiteSpace([string]$entry.path) -or
            [string]$entry.kind -notin @('directory', 'file') -or
            $entry.securityDescriptorBase64 -isnot [string]) { Throw-DysonGsRemovalError $code }
        $relative = [string]$entry.path
        if ($relative -cne '.' -and ($relative -match '(^|/)\.\.?(/|$)' -or $relative -match '[:\x00-\x1f"<>|\\]' -or
            [IO.Path]::IsPathRooted($relative))) { Throw-DysonGsRemovalError $code }
        if ($null -ne $previousPath -and [StringComparer]::Ordinal.Compare($previousPath, $relative) -gt 0) {
            Throw-DysonGsRemovalError $code
        }
        try { $bytes = [Convert]::FromBase64String([string]$entry.securityDescriptorBase64) }
        catch { Throw-DysonGsRemovalError $code }
        if ($bytes.Length -lt 20 -or (Get-DysonGsRemovalSha256Bytes $bytes) -cne
            (Assert-DysonGsRemovalDigest $entry.securityDescriptorSha256 $code)) { Throw-DysonGsRemovalError $code }
        $validated.Add([pscustomobject][ordered]@{
            path = $relative
            kind = [string]$entry.kind
            securityDescriptorBase64 = [string]$entry.securityDescriptorBase64
            securityDescriptorSha256 = [string]$entry.securityDescriptorSha256
        })
        $previousPath = $relative
    }
    if (@($validated | Where-Object { [string]$_.path -ceq '.' -and [string]$_.kind -ceq 'directory' }).Count -ne 1) {
        Throw-DysonGsRemovalError $code
    }
    $digestLines = @($validated | ForEach-Object {
        '{0}|{1}|{2}|{3}' -f [string]$_.path, [string]$_.kind,
            [string]$_.securityDescriptorSha256, [string]$_.securityDescriptorBase64
    })
    $actualDigest = Get-DysonGsRemovalSha256Text ([string]::Join("`n", $digestLines))
    if ($actualDigest -cne $expectedDigest) { Throw-DysonGsRemovalError $code }
    return [pscustomobject][ordered]@{
        entries = [object[]]$validated.ToArray()
        entryCount = [int]$validated.Count
        inventorySha256 = $actualDigest
    }
}

function Get-DysonGsRemovalShadowTaskSecurityPath {
    return Join-Path $script:CutoverHostShadowRoot 'gsmanager-task-security.json'
}

function Get-DysonGsRemovalTaskSecurityBytes {
    param([Parameter(Mandatory)][string]$TaskName)

    if ($script:CutoverHostBackend -ceq 'Shadow') {
        $code = 'DYSON_GSMANAGER_REMOVAL_TASK_SECURITY_INVALID'
        $value = Read-DysonGsRemovalJson -Path (Get-DysonGsRemovalShadowTaskSecurityPath) -MaximumBytes 65536
        Assert-DysonGsRemovalExactProperties $value @('protocol', 'taskName', 'taskPath', 'securityDescriptorBase64') $code
        if ($value.protocol -isnot [string] -or [string]$value.protocol -cne $script:DysonGsRemovalShadowTaskSecurityProtocol -or
            $value.taskName -isnot [string] -or [string]$value.taskName -cne $TaskName -or
            $value.taskPath -isnot [string] -or [string]$value.taskPath -cne '\' -or
            $value.securityDescriptorBase64 -isnot [string]) { Throw-DysonGsRemovalError $code }
        try { $bytes = [Convert]::FromBase64String([string]$value.securityDescriptorBase64) }
        catch { Throw-DysonGsRemovalError $code }
        if ($bytes.Length -lt 20) { Throw-DysonGsRemovalError $code }
        return [byte[]]$bytes
    }
    try {
        $service = New-Object -ComObject 'Schedule.Service'
        $service.Connect()
        $folder = $service.GetFolder('\')
        $task = $folder.GetTask($TaskName)
        $sddl = [string]$task.GetSecurityDescriptor(0x7)
        if ([string]::IsNullOrWhiteSpace($sddl)) { throw 'empty task security' }
        $descriptor = [Security.AccessControl.CommonSecurityDescriptor]::new($false, $false, $sddl)
        $bytes = New-Object byte[] $descriptor.BinaryLength
        $descriptor.GetBinaryForm($bytes, 0)
        return [byte[]]$bytes
    }
    catch { Throw-DysonGsRemovalError 'DYSON_GSMANAGER_REMOVAL_TASK_SECURITY_INVALID' }
}

function Set-DysonGsRemovalShadowTaskSecurityBytes {
    param([Parameter(Mandatory)][string]$TaskName, [Parameter(Mandatory)][byte[]]$Bytes)

    Assert-DysonGsRemovalLease
    $value = [pscustomobject][ordered]@{
        protocol = $script:DysonGsRemovalShadowTaskSecurityProtocol
        taskName = $TaskName
        taskPath = '\'
        securityDescriptorBase64 = [Convert]::ToBase64String($Bytes)
    }
    $path = Get-DysonGsRemovalShadowTaskSecurityPath
    $temporary = $path + '.' + [guid]::NewGuid().ToString('N') + '.tmp'
    try {
        [IO.File]::WriteAllText($temporary, (ConvertTo-DysonGsRemovalJson $value) + "`n", [Text.UTF8Encoding]::new($false))
        if (Test-Path -LiteralPath $path -PathType Leaf) { [IO.File]::Delete($path) }
        [IO.File]::Move($temporary, $path)
        [IO.File]::AppendAllText((Join-Path $script:CutoverHostShadowRoot 'writes.log'), "task-security:$TaskName`n", [Text.UTF8Encoding]::new($false))
    }
    catch { Throw-DysonGsRemovalError 'DYSON_GSMANAGER_REMOVAL_TASK_SECURITY_RESTORE_FAILED' }
    finally { if (Test-Path -LiteralPath $temporary -PathType Leaf) { Remove-Item -LiteralPath $temporary -Force -ErrorAction SilentlyContinue } }
    Assert-DysonGsRemovalLease
}

function Get-DysonGsRemovalTaskCapture {
    param([Parameter(Mandatory)][string]$TaskName)

    $image = Get-CutoverHostTaskImage -TaskName $TaskName
    if (-not [bool]$image.present -or [bool]$image.enabled -or [bool]$image.running) {
        Throw-DysonGsRemovalError 'DYSON_GSMANAGER_REMOVAL_PREVIOUS_AUTHORITY_NOT_QUIESCED'
    }
    $xmlBytes = [Convert]::FromBase64String([string]$image.xmlBase64)
    if ($xmlBytes.Length -lt 1 -or $xmlBytes.Length -gt $script:DysonGsRemovalMaximumJsonBytes) {
        Throw-DysonGsRemovalError 'DYSON_GSMANAGER_REMOVAL_TASK_INVALID'
    }
    $securityBytes = Get-DysonGsRemovalTaskSecurityBytes -TaskName $TaskName
    return [pscustomobject][ordered]@{
        taskName = $TaskName
        taskPath = '\'
        xmlBytes = [byte[]]$xmlBytes
        xmlSha256 = Get-DysonGsRemovalSha256Bytes $xmlBytes
        enabled = $false
        running = $false
        securityBytes = [byte[]]$securityBytes
        securityDescriptorSha256 = Get-DysonGsRemovalSha256Bytes $securityBytes
    }
}

function Remove-DysonGsRemovalTask {
    param([Parameter(Mandatory)][string]$TaskName)

    Assert-DysonGsRemovalLease
    if ($script:CutoverHostBackend -ceq 'Shadow') {
        $state = Get-CutoverHostShadowState
        $matches = @($state.tasks | Where-Object { [string]$_.taskName -ceq $TaskName -and [string]$_.taskPath -ceq '\' })
        if ($matches.Count -ne 1 -or [bool]$matches[0].enabled -or [bool]$matches[0].running) {
            Throw-DysonGsRemovalError 'DYSON_GSMANAGER_REMOVAL_TASK_DRIFT'
        }
        $state.tasks = @($state.tasks | Where-Object { -not ([string]$_.taskName -ceq $TaskName -and [string]$_.taskPath -ceq '\') })
        Write-CutoverHostShadowState -State $state -WriteKind ('unregister:' + $TaskName)
        $securityPath = Get-DysonGsRemovalShadowTaskSecurityPath
        if (-not (Test-Path -LiteralPath $securityPath -PathType Leaf)) {
            Throw-DysonGsRemovalError 'DYSON_GSMANAGER_REMOVAL_TASK_SECURITY_INVALID'
        }
        [IO.File]::Delete($securityPath)
        [IO.File]::AppendAllText((Join-Path $script:CutoverHostShadowRoot 'writes.log'), "task-security-remove:$TaskName`n", [Text.UTF8Encoding]::new($false))
    }
    else {
        try { Unregister-ScheduledTask -TaskName $TaskName -TaskPath '\' -Confirm:$false -ErrorAction Stop }
        catch { Throw-DysonGsRemovalError 'DYSON_GSMANAGER_REMOVAL_TASK_UNREGISTER_FAILED' }
    }
    Assert-DysonGsRemovalLease
    if ([bool](Get-CutoverHostTaskImage -TaskName $TaskName -AllowMissing).present) {
        Throw-DysonGsRemovalError 'DYSON_GSMANAGER_REMOVAL_TASK_UNREGISTER_FAILED'
    }
}

function Restore-DysonGsRemovalTask {
    param([Parameter(Mandatory)]$Capture)

    Assert-DysonGsRemovalLease
    if ([bool](Get-CutoverHostTaskImage -TaskName ([string]$Capture.taskName) -AllowMissing).present) {
        Throw-DysonGsRemovalError 'DYSON_GSMANAGER_REMOVAL_TASK_RESTORE_COLLISION'
    }
    if ($script:CutoverHostBackend -ceq 'Shadow') {
        $state = Get-CutoverHostShadowState
        $descriptor = $null
        try {
            $profile = Assert-CutoverHostProfileRevision
            if ([string]$Capture.taskName -ceq $script:CutoverHostPreviousPanelTask) {
                $descriptor = [pscustomobject][ordered]@{
                    definitionSha256 = [string]$profile.previousAuthority.main.definitionSha256
                    enabled = $false
                }
            }
        }
        catch { $descriptor = $null }
        $state.tasks = @($state.tasks) + @([pscustomobject][ordered]@{
            taskName = [string]$Capture.taskName
            taskPath = '\'
            xmlBase64 = [Convert]::ToBase64String([byte[]]$Capture.xmlBytes)
            enabled = $false
            running = $false
            descriptor = $descriptor
        })
        Write-CutoverHostShadowState -State $state -WriteKind ('register:' + [string]$Capture.taskName)
        Set-DysonGsRemovalShadowTaskSecurityBytes -TaskName ([string]$Capture.taskName) -Bytes ([byte[]]$Capture.securityBytes)
    }
    else {
        try {
            $xml = [Text.UTF8Encoding]::new($false, $true).GetString([byte[]]$Capture.xmlBytes)
            Register-ScheduledTask -TaskName ([string]$Capture.taskName) -TaskPath '\' -Xml $xml -Force -ErrorAction Stop | Out-Null
            Disable-ScheduledTask -TaskName ([string]$Capture.taskName) -TaskPath '\' -ErrorAction Stop | Out-Null
            $service = New-Object -ComObject 'Schedule.Service'
            $service.Connect()
            $folder = $service.GetFolder('\')
            $task = $folder.GetTask([string]$Capture.taskName)
            $descriptor = [Security.AccessControl.CommonSecurityDescriptor]::new($false, $false, [byte[]]$Capture.securityBytes, 0)
            $task.SetSecurityDescriptor($descriptor.GetSddlForm([Security.AccessControl.AccessControlSections]::All), 0)
            try { Stop-ScheduledTask -TaskName ([string]$Capture.taskName) -TaskPath '\' -ErrorAction SilentlyContinue }
            catch { }
        }
        catch { Throw-DysonGsRemovalError 'DYSON_GSMANAGER_REMOVAL_TASK_RESTORE_FAILED' }
    }
    Assert-DysonGsRemovalLease
    $after = Get-CutoverHostTaskImage -TaskName ([string]$Capture.taskName)
    if (-not [bool]$after.present -or [bool]$after.enabled -or [bool]$after.running -or
        (Get-DysonGsRemovalSha256Bytes ([Convert]::FromBase64String([string]$after.xmlBase64))) -cne [string]$Capture.xmlSha256 -or
        -not (Test-DysonGsRemovalBytesEqual (Get-DysonGsRemovalTaskSecurityBytes ([string]$Capture.taskName)) ([byte[]]$Capture.securityBytes))) {
        Throw-DysonGsRemovalError 'DYSON_GSMANAGER_REMOVAL_TASK_RESTORE_FAILED'
    }
}

function Assert-DysonGsRemovalNoGsManagerActivity {
    param([Parameter(Mandatory)][string]$GsManagerRoot)

    $root = (Get-DysonGsFullPath $GsManagerRoot).TrimEnd('\', '/')
    $processes = @()
    $tcpOwners = @()
    $udpOwners = @()
    $ambiguous = $false
    if ($script:CutoverHostBackend -ceq 'Shadow') {
        $code = 'DYSON_GSMANAGER_REMOVAL_SHADOW_INVALID'
        $runtime = Read-DysonGsRemovalJson -Path (Join-Path $script:CutoverHostShadowRoot 'gsmanager-runtime.json') -MaximumBytes 1048576
        Assert-DysonGsRemovalExactProperties $runtime @('protocol', 'processes', 'tcpOwners', 'udpOwners') $code
        if ($runtime.protocol -isnot [string] -or [string]$runtime.protocol -cne $script:DysonGsRemovalShadowRuntimeProtocol) {
            Throw-DysonGsRemovalError $code
        }
        foreach ($process in @($runtime.processes)) {
            Assert-DysonGsRemovalExactProperties $process @('id', 'path', 'commandLine') $code
            if (($process.id -isnot [int] -and $process.id -isnot [long]) -or [int64]$process.id -le 0 -or
                $process.path -isnot [string] -or $process.commandLine -isnot [string]) { Throw-DysonGsRemovalError $code }
            $processes += [pscustomobject][ordered]@{ id = [int]$process.id; path = [string]$process.path; commandLine = [string]$process.commandLine }
        }
        foreach ($owner in @($runtime.tcpOwners)) {
            if (($owner -isnot [int] -and $owner -isnot [long]) -or [int64]$owner -le 0) { Throw-DysonGsRemovalError $code }
            $tcpOwners += [int]$owner
        }
        foreach ($owner in @($runtime.udpOwners)) {
            if (($owner -isnot [int] -and $owner -isnot [long]) -or [int64]$owner -le 0) { Throw-DysonGsRemovalError $code }
            $udpOwners += [int]$owner
        }
    }
    else {
        try {
            foreach ($process in @(Get-CimInstance -ClassName Win32_Process -ErrorAction Stop)) {
                $path = [string]$process.ExecutablePath
                $commandLine = [string]$process.CommandLine
                $name = [string]$process.Name
                $referencesRoot = -not [string]::IsNullOrWhiteSpace($commandLine) -and
                    $commandLine.IndexOf($root, [StringComparison]::OrdinalIgnoreCase) -ge 0
                $insideRoot = $false
                if (-not [string]::IsNullOrWhiteSpace($path)) {
                    try { $insideRoot = Test-DysonGsPathWithin -Candidate $path -Parent $root }
                    catch { $ambiguous = $true }
                }
                elseif ($name -match '(?i)^(?:GSManager|node)(?:\.exe)?$' -and $referencesRoot) { $ambiguous = $true }
                if ($insideRoot -or $referencesRoot) {
                    if ([int64]$process.ProcessId -le 0) { $ambiguous = $true; continue }
                    $processes += [pscustomobject][ordered]@{ id = [int]$process.ProcessId; path = $path; commandLine = $commandLine }
                }
            }
            $ids = @($processes | ForEach-Object { [int]$_.id })
            if ($ids.Count -gt 0) {
                $tcpOwners = @(Get-NetTCPConnection -ErrorAction Stop | Where-Object { $ids -contains [int]$_.OwningProcess } | ForEach-Object { [int]$_.OwningProcess })
                $udpOwners = @(Get-NetUDPEndpoint -ErrorAction Stop | Where-Object { $ids -contains [int]$_.OwningProcess } | ForEach-Object { [int]$_.OwningProcess })
            }
        }
        catch { Throw-DysonGsRemovalError 'DYSON_GSMANAGER_REMOVAL_RUNTIME_PROBE_FAILED' }
    }
    if ($ambiguous) { Throw-DysonGsRemovalError 'DYSON_GSMANAGER_REMOVAL_RUNTIME_UNKNOWN' }
    if ($processes.Count -gt 0 -or $tcpOwners.Count -gt 0 -or $udpOwners.Count -gt 0) {
        Throw-DysonGsRemovalError 'DYSON_GSMANAGER_REMOVAL_RUNTIME_ACTIVE'
    }
}

function Assert-DysonGsRemovalDirectoryEmpty {
    param([Parameter(Mandatory)][string]$Path, [Parameter(Mandatory)][string]$Code)

    $root = Assert-DysonGsPlainDirectory -Path $Path
    try {
        if (@(Get-ChildItem -LiteralPath $root -Force -ErrorAction Stop).Count -ne 0) {
            Throw-DysonGsRemovalError $Code
        }
    }
    catch {
        if ($_.Exception.Data.Contains('Code')) { throw $_.Exception }
        Throw-DysonGsRemovalError $Code
    }
}

function Assert-DysonGsRemovalNoPendingTransactions {
    param([Parameter(Mandatory)][string]$DataRoot, [Parameter(Mandatory)][string]$RuntimeTaskTransactionRoot)

    $broker = Assert-DysonGsPlainDirectory -Path (Join-Path $DataRoot 'cutover-broker')
    foreach ($name in @('requests', 'intents', 'work')) {
        Assert-DysonGsRemovalDirectoryEmpty -Path (Join-Path $broker $name) `
            -Code 'DYSON_GSMANAGER_REMOVAL_CUTOVER_PENDING'
    }
    $authorityTransactions = Assert-DysonGsPlainDirectory -Path (Join-Path $DataRoot 'private\gsmanager-authority-transactions')
    if (Test-Path -LiteralPath (Join-Path $authorityTransactions 'active-intent.json')) {
        Throw-DysonGsRemovalError 'DYSON_GSMANAGER_REMOVAL_AUTHORITY_PENDING'
    }
    $runtimeTransactions = Assert-DysonGsPlainDirectory -Path $RuntimeTaskTransactionRoot
    if (Test-Path -LiteralPath (Join-Path $runtimeTransactions 'active-intent.json')) {
        Throw-DysonGsRemovalError 'DYSON_GSMANAGER_REMOVAL_RUNTIME_TASK_PENDING'
    }
}

function Assert-DysonGsRemovalCandidateHealthy {
    param([Parameter(Mandatory)]$Profile, [switch]$PreviousAbsent, [switch]$CandidateQuiesced)

    $panel = Get-CutoverHostTaskImage -TaskName $script:CutoverHostPreviousPanelTask -AllowMissing
    $previousStart = Get-CutoverHostTaskImage -TaskName $script:CutoverHostPreviousStartTask
    $previousStop = Get-CutoverHostTaskImage -TaskName $script:CutoverHostPreviousStopTask
    $candidateStart = Get-CutoverHostTaskImage -TaskName $script:CutoverHostCandidateStartTask
    $candidateStop = Get-CutoverHostTaskImage -TaskName $script:CutoverHostCandidateStopTask
    if (-not (Test-CutoverHostPreviousTask $previousStart $Profile.previousAuthority.start) -or
        -not (Test-CutoverHostPreviousTask $previousStop $Profile.previousAuthority.stop) -or
        (Test-CutoverHostUnexpectedManagedTask)) {
        Throw-DysonGsRemovalError 'DYSON_GSMANAGER_REMOVAL_AUTHORITY_DRIFT'
    }
    if ($PreviousAbsent) {
        if ([bool]$panel.present) { Throw-DysonGsRemovalError 'DYSON_GSMANAGER_REMOVAL_PREVIOUS_AUTHORITY_PRESENT' }
    }
    else {
        if (-not (Test-CutoverHostPreviousTask $panel $Profile.previousAuthority.main -AllowDisabled) -or
            [bool]$panel.enabled -or [bool]$panel.running) {
            Throw-DysonGsRemovalError 'DYSON_GSMANAGER_REMOVAL_PREVIOUS_AUTHORITY_NOT_QUIESCED'
        }
    }
    $expected = Get-CutoverHostExpectedCandidateDescriptors (-not $CandidateQuiesced)
    if (-not (Test-CutoverHostCandidateTask $candidateStart $expected.start) -or
        -not (Test-CutoverHostCandidateTask $candidateStop $expected.stop) -or
        [bool]$candidateStart.running -or [bool]$candidateStop.running) {
        Throw-DysonGsRemovalError 'DYSON_GSMANAGER_REMOVAL_CANDIDATE_AUTHORITY_INVALID'
    }
    $runtime = Get-CutoverHostRuntimeObservation
    $owner = Read-CutoverHostRuntimeOwner
    if ($CandidateQuiesced) {
        if ([string]$runtime.kind -cne 'none' -or -not [bool]$runtime.portsClosed -or $null -ne $owner) {
            Throw-DysonGsRemovalError 'DYSON_GSMANAGER_REMOVAL_CANDIDATE_NOT_QUIESCED'
        }
    }
    else {
        if ([string]$runtime.kind -cne 'managed' -or -not [bool]$runtime.coherentPort -or
            $null -eq $owner -or -not [bool]$owner.valid -or [string]$owner.owner -cne 'candidate' -or
            [int]$owner.pid -ne [int]$runtime.pid) {
            Throw-DysonGsRemovalError 'DYSON_GSMANAGER_REMOVAL_CANDIDATE_NOT_HEALTHY'
        }
    }
}

function Get-DysonGsRemovalSnapshotVerification {
    param(
        [Parameter(Mandatory)]$Layout,
        [Parameter(Mandatory)][string]$DataRoot,
        [Parameter(Mandatory)][string]$SnapshotId,
        [Parameter(Mandatory)][string]$SnapshotManifestSha256,
        [Parameter(Mandatory)][string]$PairedSaveProtectionPointId,
        [Parameter(Mandatory)][string]$PairedSaveProtectionManifestSha256,
        [Parameter(Mandatory)][string]$TaskName,
        [Parameter(Mandatory)]$Profile,
        [switch]$GsManagerMayBeMissing
    )

    try {
        $snapshotRoot = Get-DysonGsSnapshotRoot -DataRoot $DataRoot -SnapshotId $SnapshotId
        $verification = Test-DysonGsSnapshotCore -SnapshotRoot $snapshotRoot -ExpectedSnapshotId $SnapshotId `
            -ExpectedManifestSha256 $SnapshotManifestSha256
        if ([string]$verification.manifest.projectBindingSha256 -cne (Get-DysonGsProjectBindingSha256 -ProjectRoot $Layout.projectRoot) -or
            [string]$verification.manifest.gsManagerRelativeRoot -cne [string]$Layout.gsManagerRelativeRoot -or
            [string]$verification.manifest.taskName -cne $TaskName -or
            -not [bool]$verification.manifest.task.present -or
            [string]$verification.manifest.task.xmlSha256 -cne [string]$Profile.previousAuthority.main.definitionSha256) {
            Throw-DysonGsRemovalError 'DYSON_GSMANAGER_REMOVAL_SNAPSHOT_BINDING_MISMATCH'
        }
        $protection = Test-DysonGsProtectionPointBinding -ProjectRoot $Layout.projectRoot `
            -ProtectionPointId $PairedSaveProtectionPointId `
            -ManifestSha256 $PairedSaveProtectionManifestSha256
        if ([string]$verification.manifest.pairedSaveProtection.id -cne [string]$protection.protectionPointId -or
            [string]$verification.manifest.pairedSaveProtection.manifestSha256 -cne [string]$protection.manifestSha256) {
            Throw-DysonGsRemovalError 'DYSON_GSMANAGER_REMOVAL_SAVE_PROTECTION_MISMATCH'
        }
        $limits = $verification.manifest.limits
        $snapshotEntries = @($verification.gsManagerInventory.entries | ForEach-Object {
            [pscustomobject][ordered]@{
                path = ([string]$_.path).Substring('gsmanager/'.Length)
                length = [int64]$_.length
                sha256 = [string]$_.sha256
            }
        })
        if (Test-Path -LiteralPath $Layout.gsManagerRoot -PathType Container) {
            $current = Get-DysonGsTreeInventory -Root $Layout.gsManagerRoot -MaximumFiles ([int]$limits.maximumFiles) `
                -MaximumTotalBytes ([int64]$limits.maximumTotalBytes) `
                -MaximumSingleFileBytes ([int64]$limits.maximumSingleFileBytes) -RejectSaveFiles
            if ($current.fileCount -ne [int]$verification.gsManagerInventory.fileCount -or
                $current.totalBytes -ne [int64]$verification.gsManagerInventory.totalBytes -or
                -not (Test-DysonGsEntryListsEqual -Left $current.entries -Right $snapshotEntries)) {
                Throw-DysonGsRemovalError 'DYSON_GSMANAGER_REMOVAL_ROOT_DRIFT'
            }
        }
        elseif ($GsManagerMayBeMissing) {
            $current = [pscustomobject][ordered]@{
                entries = $snapshotEntries
                fileCount = [int]$verification.gsManagerInventory.fileCount
                totalBytes = [int64]$verification.gsManagerInventory.totalBytes
                treeSha256 = Get-DysonGsEntriesDigest -Entries $snapshotEntries
            }
        }
        else {
            Throw-DysonGsRemovalError 'DYSON_GSMANAGER_REMOVAL_ROOT_MISSING'
        }
        return [pscustomobject][ordered]@{
            verification = $verification
            protection = $protection
            currentInventory = $current
        }
    }
    catch {
        if ($_.Exception.Data.Contains('Code')) { throw $_.Exception }
        Throw-DysonGsRemovalError 'DYSON_GSMANAGER_REMOVAL_SNAPSHOT_INVALID'
    }
}

function Initialize-DysonGsRemovalContext {
    param(
        [Parameter(Mandatory)][string]$ProjectRoot,
        [Parameter(Mandatory)][string]$GsManagerRoot,
        [Parameter(Mandatory)][string]$DataRoot,
        [Parameter(Mandatory)][string]$TaskName,
        [Parameter(Mandatory)][string]$ProfileFile,
        [Parameter(Mandatory)][string]$RuntimeBootstrapRoot,
        [Parameter(Mandatory)][string]$RuntimeTaskTransactionRoot,
        [Parameter(Mandatory)][string]$ServiceUser,
        [Parameter(Mandatory)][int]$GamePort,
        [Parameter(Mandatory)][string]$AuthorityInventoryRevision,
        [Parameter(Mandatory)][string]$RequestId,
        [ValidateSet('Windows', 'Shadow')][string]$Backend = 'Windows',
        [AllowNull()][string]$ShadowRoot,
        [switch]$GsManagerMayBeMissing
    )

    try {
        Assert-DysonGsTaskName -TaskName $TaskName
        $layout = Resolve-DysonGsLayout -ProjectRoot $ProjectRoot -GsManagerRoot $GsManagerRoot -DataRoot $DataRoot `
            -GsManagerMayBeMissing:$GsManagerMayBeMissing
        $script:DysonGsRemovalDataRoot = [string]$layout.dataRoot
        $script:DysonGsRemovalLease = $null
        Initialize-CutoverHostContext -ProjectRoot $layout.projectRoot -ProfileFile $ProfileFile `
            -RuntimeBootstrapRoot $RuntimeBootstrapRoot -RuntimeTaskTransactionRoot $RuntimeTaskTransactionRoot `
            -ServiceUser $ServiceUser -GamePort $GamePort -AuthorityInventoryRevision $AuthorityInventoryRevision `
            -RequestId $RequestId -Backend $Backend -ShadowRoot $ShadowRoot -DataRoot $layout.dataRoot
        $profile = Assert-CutoverHostProfileRevision
        if ([string]$profile.previousAuthority.main.taskName -cne $TaskName -or
            [string]$profile.inventoryRevision -cne $AuthorityInventoryRevision) {
            Throw-DysonGsRemovalError 'DYSON_GSMANAGER_REMOVAL_PROFILE_BINDING_MISMATCH'
        }
        if ($Backend -ceq 'Shadow') {
            if ($env:DYSON_GSMANAGER_REMOVAL_SELFTEST -cne '1' -or
                -not (Test-Path -LiteralPath (Join-Path $ShadowRoot '.dyson-gsmanager-removal-selftest') -PathType Leaf)) {
                Throw-DysonGsRemovalError 'DYSON_GSMANAGER_REMOVAL_SHADOW_FORBIDDEN'
            }
        }
        return [pscustomobject][ordered]@{ layout = $layout; profile = $profile }
    }
    catch {
        if ($_.Exception.Data.Contains('Code')) { throw $_.Exception }
        Throw-DysonGsRemovalError 'DYSON_GSMANAGER_REMOVAL_INPUT_INVALID'
    }
}

function Get-DysonGsRemovalRequestFingerprint {
    param(
        [ValidateSet('remove', 'restore')][string]$Operation,
        [Parameter(Mandatory)]$Layout,
        [Parameter(Mandatory)][string]$TaskName,
        [Parameter(Mandatory)][string]$SnapshotId,
        [Parameter(Mandatory)][string]$SnapshotManifestSha256,
        [Parameter(Mandatory)][string]$AuthorityInventoryRevision,
        [Parameter(Mandatory)][string]$PairedSaveProtectionPointId,
        [Parameter(Mandatory)][string]$PairedSaveProtectionManifestSha256,
        [string]$RemovalReceiptSha256
    )

    $binding = [ordered]@{
        protocol = $script:DysonGsRemovalProtocol
        operation = $Operation
        projectRootIdentity = Get-DysonGsRemovalPathIdentity $Layout.projectRoot
        dataRootIdentity = Get-DysonGsRemovalPathIdentity $Layout.dataRoot
        gsManagerRelativeRoot = [string]$Layout.gsManagerRelativeRoot
        taskName = $TaskName
        taskPath = '\'
        snapshotId = (Normalize-DysonGsSnapshotId $SnapshotId)
        snapshotManifestSha256 = Assert-DysonGsRemovalDigest $SnapshotManifestSha256 'DYSON_GSMANAGER_REMOVAL_INPUT_INVALID'
        authorityInventoryRevision = Assert-DysonGsRemovalDigest $AuthorityInventoryRevision 'DYSON_GSMANAGER_REMOVAL_INPUT_INVALID'
        pairedSaveProtectionPointId = $PairedSaveProtectionPointId
        pairedSaveProtectionManifestSha256 = Assert-DysonGsRemovalDigest $PairedSaveProtectionManifestSha256 'DYSON_GSMANAGER_REMOVAL_INPUT_INVALID'
        removalReceiptSha256 = if ($Operation -ceq 'restore') {
            Assert-DysonGsRemovalDigest $RemovalReceiptSha256 'DYSON_GSMANAGER_REMOVAL_INPUT_INVALID'
        } else { $null }
    }
    return Get-DysonGsRemovalSha256Text (ConvertTo-DysonGsRemovalJson $binding)
}

function New-DysonGsRemovalIntentValue {
    param(
        [ValidateSet('remove', 'restore')][string]$Operation,
        [Parameter(Mandatory)][string]$RequestId,
        [Parameter(Mandatory)][string]$RequestFingerprint,
        [Parameter(Mandatory)][string]$Phase,
        [Parameter(Mandatory)][string]$GuardId,
        [Parameter(Mandatory)][string]$SnapshotId,
        [Parameter(Mandatory)][string]$SnapshotManifestSha256,
        [Parameter(Mandatory)][string]$AuthorityInventoryRevision,
        [Parameter(Mandatory)][string]$TaskName,
        [Parameter(Mandatory)][string]$GsManagerRelativeRoot,
        [Parameter(Mandatory)][string]$RootTreeSha256,
        [Parameter(Mandatory)][string]$AclInventorySha256,
        [Parameter(Mandatory)][string]$TaskXmlSha256,
        [Parameter(Mandatory)][string]$TaskSecuritySha256,
        [string]$RemovalRequestId,
        [string]$RemovalReceiptSha256
    )

    return [pscustomobject][ordered]@{
        protocol = $script:DysonGsRemovalIntentProtocol
        schemaVersion = 1
        operation = $Operation
        requestId = $RequestId
        requestFingerprint = $RequestFingerprint
        phase = $Phase
        guardId = $GuardId
        createdAt = [DateTime]::UtcNow.ToString('o')
        snapshotId = $SnapshotId
        snapshotManifestSha256 = $SnapshotManifestSha256
        authorityInventoryRevision = $AuthorityInventoryRevision
        taskName = $TaskName
        taskPath = '\'
        gsManagerRelativeRoot = $GsManagerRelativeRoot
        rootTreeSha256 = $RootTreeSha256
        aclInventorySha256 = $AclInventorySha256
        taskXmlSha256 = $TaskXmlSha256
        taskSecuritySha256 = $TaskSecuritySha256
        removalRequestId = if ($Operation -ceq 'restore') { $RemovalRequestId } else { $null }
        removalReceiptSha256 = if ($Operation -ceq 'restore') { $RemovalReceiptSha256 } else { $null }
    }
}

function Read-DysonGsRemovalIntent {
    param([Parameter(Mandatory)][string]$Path)

    $code = 'DYSON_GSMANAGER_REMOVAL_INTENT_INVALID'
    $value = Read-DysonGsRemovalJson -Path $Path -MaximumBytes 65536
    Assert-DysonGsRemovalExactProperties $value @(
        'protocol', 'schemaVersion', 'operation', 'requestId', 'requestFingerprint', 'phase', 'guardId',
        'createdAt', 'snapshotId', 'snapshotManifestSha256', 'authorityInventoryRevision', 'taskName',
        'taskPath', 'gsManagerRelativeRoot', 'rootTreeSha256', 'aclInventorySha256', 'taskXmlSha256',
        'taskSecuritySha256', 'removalRequestId', 'removalReceiptSha256'
    ) $code
    if ($value.protocol -isnot [string] -or [string]$value.protocol -cne $script:DysonGsRemovalIntentProtocol -or
        ($value.schemaVersion -isnot [int] -and $value.schemaVersion -isnot [long]) -or [int64]$value.schemaVersion -ne 1 -or
        [string]$value.operation -notin @('remove', 'restore') -or $value.phase -isnot [string] -or
        [string]$value.phase -notin @('prepared', 'root-moved', 'task-unregistered', 'restore-root-moved', 'restore-task-registered')) {
        Throw-DysonGsRemovalError $code
    }
    foreach ($name in @('requestFingerprint', 'snapshotManifestSha256', 'authorityInventoryRevision', 'rootTreeSha256',
        'aclInventorySha256', 'taskXmlSha256', 'taskSecuritySha256')) {
        [void](Assert-DysonGsRemovalDigest $value.$name $code)
    }
    [void](Assert-DysonGsRemovalGuid $value.requestId $code)
    [void](Assert-DysonGsRemovalGuid $value.guardId $code)
    Assert-DysonGsRemovalTimestamp $value.createdAt $code
    if ($value.taskName -isnot [string] -or [string]$value.taskName -notmatch '^[^\\/\r\n]{1,238}$' -or
        $value.taskPath -isnot [string] -or [string]$value.taskPath -cne '\' -or
        $value.gsManagerRelativeRoot -isnot [string] -or [string]::IsNullOrWhiteSpace([string]$value.gsManagerRelativeRoot)) {
        Throw-DysonGsRemovalError $code
    }
    if ([string]$value.operation -ceq 'restore') {
        [void](Assert-DysonGsRemovalGuid $value.removalRequestId $code)
        [void](Assert-DysonGsRemovalDigest $value.removalReceiptSha256 $code)
    }
    elseif ($null -ne $value.removalRequestId -or $null -ne $value.removalReceiptSha256) { Throw-DysonGsRemovalError $code }
    return $value
}

function Set-DysonGsRemovalIntentPhase {
    param([Parameter(Mandatory)][string]$Path, [Parameter(Mandatory)]$Intent, [Parameter(Mandatory)][string]$Phase)

    $updated = New-DysonGsRemovalIntentValue -Operation ([string]$Intent.operation) `
        -RequestId ([string]$Intent.requestId) -RequestFingerprint ([string]$Intent.requestFingerprint) `
        -Phase $Phase -GuardId ([string]$Intent.guardId) -SnapshotId ([string]$Intent.snapshotId) `
        -SnapshotManifestSha256 ([string]$Intent.snapshotManifestSha256) `
        -AuthorityInventoryRevision ([string]$Intent.authorityInventoryRevision) -TaskName ([string]$Intent.taskName) `
        -GsManagerRelativeRoot ([string]$Intent.gsManagerRelativeRoot) -RootTreeSha256 ([string]$Intent.rootTreeSha256) `
        -AclInventorySha256 ([string]$Intent.aclInventorySha256) -TaskXmlSha256 ([string]$Intent.taskXmlSha256) `
        -TaskSecuritySha256 ([string]$Intent.taskSecuritySha256) -RemovalRequestId ([string]$Intent.removalRequestId) `
        -RemovalReceiptSha256 ([string]$Intent.removalReceiptSha256)
    $updated.createdAt = [string]$Intent.createdAt
    Write-DysonGsRemovalJsonReplace -Path $Path -Value $updated -MaximumBytes 65536
    return $updated
}

function New-DysonGsRemovalGuard {
    param(
        [Parameter(Mandatory)][string]$GuardRoot,
        [Parameter(Mandatory)][string]$GuardId,
        [Parameter(Mandatory)][string]$RemovalRequestId,
        [Parameter(Mandatory)]$Layout,
        [Parameter(Mandatory)]$Snapshot,
        [Parameter(Mandatory)]$AclInventory,
        [Parameter(Mandatory)]$TaskCapture,
        [Parameter(Mandatory)][string]$AuthorityInventoryRevision
    )

    Assert-DysonGsRemovalLease
    if (Test-Path -LiteralPath $GuardRoot) { Throw-DysonGsRemovalError 'DYSON_GSMANAGER_REMOVAL_GUARD_COLLISION' }
    $guard = New-DysonGsRemovalPrivateDirectory -Path $GuardRoot
    Write-DysonGsRemovalBytesNew -Path (Join-Path $guard 'task.xml') -Bytes ([byte[]]$TaskCapture.xmlBytes) `
        -MaximumBytes $script:DysonGsRemovalMaximumJsonBytes
    Write-DysonGsRemovalBytesNew -Path (Join-Path $guard 'task-security.bin') -Bytes ([byte[]]$TaskCapture.securityBytes) `
        -MaximumBytes 1048576
    Write-DysonGsRemovalAclInventoryNew -Path (Join-Path $guard 'tree-acls.json') -Inventory $AclInventory
    return [pscustomobject][ordered]@{
        guardRoot = $guard
        movedRoot = Join-Path $guard 'root'
        guardManifest = Join-Path $guard 'guard.json'
        guardId = $GuardId
        removalRequestId = $RemovalRequestId
        projectBindingSha256 = Get-DysonGsProjectBindingSha256 -ProjectRoot $Layout.projectRoot
        snapshotId = [string]$Snapshot.verification.manifest.snapshotId
        snapshotManifestSha256 = [string]$Snapshot.verification.manifestSha256
        authorityInventoryRevision = $AuthorityInventoryRevision
    }
}

function Write-DysonGsRemovalGuardManifestNew {
    param(
        [Parameter(Mandatory)]$Guard,
        [Parameter(Mandatory)]$Layout,
        [Parameter(Mandatory)]$Snapshot,
        [Parameter(Mandatory)]$AclInventory,
        [Parameter(Mandatory)]$TaskCapture
    )

    Assert-DysonGsRemovalLease
    $root = Get-DysonGsTreeInventory -Root $Guard.movedRoot `
        -MaximumFiles ([int]$Snapshot.verification.manifest.limits.maximumFiles) `
        -MaximumTotalBytes ([int64]$Snapshot.verification.manifest.limits.maximumTotalBytes) `
        -MaximumSingleFileBytes ([int64]$Snapshot.verification.manifest.limits.maximumSingleFileBytes) -RejectSaveFiles
    if (-not (Test-DysonGsEntryListsEqual -Left $root.entries -Right $Snapshot.currentInventory.entries) -or
        -not (Test-DysonGsRemovalAclInventoriesEqual $AclInventory (Get-DysonGsRemovalAclInventory $Guard.movedRoot))) {
        Throw-DysonGsRemovalError 'DYSON_GSMANAGER_REMOVAL_GUARD_VERIFY_FAILED'
    }
    $manifest = [pscustomobject][ordered]@{
        protocol = $script:DysonGsRemovalGuardProtocol
        schemaVersion = 1
        guardId = [string]$Guard.guardId
        removalRequestId = [string]$Guard.removalRequestId
        createdAt = [DateTime]::UtcNow.ToString('o')
        dataRootIdentity = Get-DysonGsRemovalPathIdentity $Layout.dataRoot
        projectBindingSha256 = [string]$Guard.projectBindingSha256
        gsManagerRelativeRoot = [string]$Layout.gsManagerRelativeRoot
        snapshotId = [string]$Guard.snapshotId
        snapshotManifestSha256 = [string]$Guard.snapshotManifestSha256
        authorityInventoryRevision = [string]$Guard.authorityInventoryRevision
        taskName = [string]$TaskCapture.taskName
        taskPath = '\'
        pairedSaveProtection = [pscustomobject][ordered]@{
            id = [string]$Snapshot.protection.protectionPointId
            manifestSha256 = [string]$Snapshot.protection.manifestSha256
        }
        limits = [pscustomobject][ordered]@{
            maximumFiles = [int]$Snapshot.verification.manifest.limits.maximumFiles
            maximumTotalBytes = [int64]$Snapshot.verification.manifest.limits.maximumTotalBytes
            maximumSingleFileBytes = [int64]$Snapshot.verification.manifest.limits.maximumSingleFileBytes
        }
        tree = [pscustomobject][ordered]@{
            fileCount = [int]$root.fileCount
            totalBytes = [int64]$root.totalBytes
            treeSha256 = [string]$root.treeSha256
            aclEntryCount = [int]$AclInventory.entryCount
            aclInventorySha256 = [string]$AclInventory.inventorySha256
        }
        task = [pscustomobject][ordered]@{
            xmlSha256 = [string]$TaskCapture.xmlSha256
            enabled = $false
            running = $false
            securityDescriptorSha256 = [string]$TaskCapture.securityDescriptorSha256
        }
    }
    Write-DysonGsRemovalJsonNew -Path $Guard.guardManifest -Value $manifest -MaximumBytes 65536
    return [pscustomobject][ordered]@{
        manifest = $manifest
        manifestSha256 = Get-DysonGsSha256 $Guard.guardManifest
    }
}

function Read-DysonGsRemovalGuardManifest {
    param(
        [Parameter(Mandatory)][string]$GuardRoot,
        [Parameter(Mandatory)][string]$ExpectedGuardId,
        [string]$ExpectedManifestSha256,
        [switch]$RootMayBeRestored
    )

    $code = 'DYSON_GSMANAGER_REMOVAL_GUARD_INVALID'
    $root = Assert-DysonGsRemovalPrivateDirectory -Path $GuardRoot
    $manifestPath = Join-Path $root 'guard.json'
    $actualManifestSha = Get-DysonGsSha256 (Assert-DysonGsPlainFile $manifestPath 65536)
    if ($ExpectedManifestSha256 -and $actualManifestSha -cne
        (Assert-DysonGsRemovalDigest $ExpectedManifestSha256 $code)) { Throw-DysonGsRemovalError $code }
    $manifest = Read-DysonGsRemovalJson -Path $manifestPath -MaximumBytes 65536
    Assert-DysonGsRemovalExactProperties $manifest @(
        'protocol', 'schemaVersion', 'guardId', 'removalRequestId', 'createdAt', 'dataRootIdentity',
        'projectBindingSha256', 'gsManagerRelativeRoot', 'snapshotId', 'snapshotManifestSha256',
        'authorityInventoryRevision', 'taskName', 'taskPath', 'pairedSaveProtection', 'limits', 'tree', 'task'
    ) $code
    Assert-DysonGsRemovalExactProperties $manifest.pairedSaveProtection @('id', 'manifestSha256') $code
    Assert-DysonGsRemovalExactProperties $manifest.limits @('maximumFiles', 'maximumTotalBytes', 'maximumSingleFileBytes') $code
    Assert-DysonGsRemovalExactProperties $manifest.tree @('fileCount', 'totalBytes', 'treeSha256', 'aclEntryCount', 'aclInventorySha256') $code
    Assert-DysonGsRemovalExactProperties $manifest.task @('xmlSha256', 'enabled', 'running', 'securityDescriptorSha256') $code
    if ($manifest.protocol -isnot [string] -or [string]$manifest.protocol -cne $script:DysonGsRemovalGuardProtocol -or
        ($manifest.schemaVersion -isnot [int] -and $manifest.schemaVersion -isnot [long]) -or [int64]$manifest.schemaVersion -ne 1 -or
        (Assert-DysonGsRemovalGuid $manifest.guardId $code) -cne (Assert-DysonGsRemovalGuid $ExpectedGuardId $code) -or
        $manifest.taskPath -isnot [string] -or [string]$manifest.taskPath -cne '\' -or
        $manifest.task.enabled -isnot [bool] -or [bool]$manifest.task.enabled -or
        $manifest.task.running -isnot [bool] -or [bool]$manifest.task.running) { Throw-DysonGsRemovalError $code }
    [void](Assert-DysonGsRemovalGuid $manifest.removalRequestId $code)
    Assert-DysonGsRemovalTimestamp $manifest.createdAt $code
    foreach ($field in @('projectBindingSha256', 'snapshotManifestSha256', 'authorityInventoryRevision')) {
        [void](Assert-DysonGsRemovalDigest $manifest.$field $code)
    }
    foreach ($field in @('treeSha256', 'aclInventorySha256')) { [void](Assert-DysonGsRemovalDigest $manifest.tree.$field $code) }
    foreach ($field in @('xmlSha256', 'securityDescriptorSha256')) { [void](Assert-DysonGsRemovalDigest $manifest.task.$field $code) }
    [void](Assert-DysonGsRemovalDigest $manifest.pairedSaveProtection.manifestSha256 $code)
    foreach ($field in @('maximumFiles', 'maximumTotalBytes', 'maximumSingleFileBytes')) {
        if (($manifest.limits.$field -isnot [int] -and $manifest.limits.$field -isnot [long]) -or [int64]$manifest.limits.$field -lt 1) {
            Throw-DysonGsRemovalError $code
        }
    }
    if (($manifest.tree.fileCount -isnot [int] -and $manifest.tree.fileCount -isnot [long]) -or [int64]$manifest.tree.fileCount -lt 0 -or
        ($manifest.tree.totalBytes -isnot [int] -and $manifest.tree.totalBytes -isnot [long]) -or [int64]$manifest.tree.totalBytes -lt 0 -or
        ($manifest.tree.aclEntryCount -isnot [int] -and $manifest.tree.aclEntryCount -isnot [long]) -or [int64]$manifest.tree.aclEntryCount -lt 1) {
        Throw-DysonGsRemovalError $code
    }
    $taskXml = [IO.File]::ReadAllBytes((Assert-DysonGsPlainFile (Join-Path $root 'task.xml') $script:DysonGsRemovalMaximumJsonBytes))
    $taskSecurity = [IO.File]::ReadAllBytes((Assert-DysonGsPlainFile (Join-Path $root 'task-security.bin') 1048576))
    if ((Get-DysonGsRemovalSha256Bytes $taskXml) -cne [string]$manifest.task.xmlSha256 -or
        (Get-DysonGsRemovalSha256Bytes $taskSecurity) -cne [string]$manifest.task.securityDescriptorSha256) {
        Throw-DysonGsRemovalError $code
    }
    $acl = Read-DysonGsRemovalAclInventory (Join-Path $root 'tree-acls.json')
    if ([int]$acl.entryCount -ne [int]$manifest.tree.aclEntryCount -or
        [string]$acl.inventorySha256 -cne [string]$manifest.tree.aclInventorySha256) { Throw-DysonGsRemovalError $code }
    $movedRoot = Join-Path $root 'root'
    $location = if (Test-Path -LiteralPath $movedRoot -PathType Container) { 'guard' } else { 'restored' }
    if ($location -ceq 'restored' -and -not $RootMayBeRestored) { Throw-DysonGsRemovalError $code }
    if ($location -ceq 'guard') {
        $tree = Get-DysonGsTreeInventory -Root $movedRoot -MaximumFiles ([int]$manifest.limits.maximumFiles) `
            -MaximumTotalBytes ([int64]$manifest.limits.maximumTotalBytes) `
            -MaximumSingleFileBytes ([int64]$manifest.limits.maximumSingleFileBytes) -RejectSaveFiles
        if ([int]$tree.fileCount -ne [int]$manifest.tree.fileCount -or [int64]$tree.totalBytes -ne [int64]$manifest.tree.totalBytes -or
            [string]$tree.treeSha256 -cne [string]$manifest.tree.treeSha256 -or
            -not (Test-DysonGsRemovalAclInventoriesEqual $acl (Get-DysonGsRemovalAclInventory $movedRoot))) {
            Throw-DysonGsRemovalError $code
        }
    }
    return [pscustomobject][ordered]@{
        guardRoot = $root
        movedRoot = $movedRoot
        manifestPath = $manifestPath
        manifestSha256 = $actualManifestSha
        manifest = $manifest
        aclInventory = $acl
        taskCapture = [pscustomobject][ordered]@{
            taskName = [string]$manifest.taskName
            taskPath = '\'
            xmlBytes = [byte[]]$taskXml
            xmlSha256 = [string]$manifest.task.xmlSha256
            enabled = $false
            running = $false
            securityBytes = [byte[]]$taskSecurity
            securityDescriptorSha256 = [string]$manifest.task.securityDescriptorSha256
        }
        location = $location
    }
}

function New-DysonGsRemovalReceiptValue {
    param(
        [Parameter(Mandatory)][string]$RequestId,
        [Parameter(Mandatory)][string]$RequestFingerprint,
        [ValidateSet('removed', 'rolled-back')][string]$Status,
        [Parameter(Mandatory)][string]$GuardId,
        [AllowNull()][string]$GuardManifestSha256,
        [Parameter(Mandatory)][string]$SnapshotId,
        [Parameter(Mandatory)][string]$SnapshotManifestSha256,
        [Parameter(Mandatory)][string]$AuthorityInventoryRevision,
        [Parameter(Mandatory)][string]$TerminalDigest
    )

    return [pscustomobject][ordered]@{
        protocol = $script:DysonGsRemovalReceiptProtocol
        schemaVersion = 1
        requestId = $RequestId
        requestFingerprint = $RequestFingerprint
        status = $Status
        guardId = $GuardId
        guardManifestSha256 = if ($Status -ceq 'removed') { $GuardManifestSha256 } else { $null }
        snapshotId = $SnapshotId
        snapshotManifestSha256 = $SnapshotManifestSha256
        authorityInventoryRevision = $AuthorityInventoryRevision
        terminalDigest = $TerminalDigest
        completedAt = [DateTime]::UtcNow.ToString('o')
    }
}

function Read-DysonGsRemovalReceipt {
    param([Parameter(Mandatory)][string]$Path, [string]$ExpectedSha256)

    $code = 'DYSON_GSMANAGER_REMOVAL_RECEIPT_INVALID'
    $item = Assert-DysonGsPlainFile -Path $Path -MaximumBytes 65536
    $sha = Get-DysonGsSha256 $item.FullName
    if ($ExpectedSha256 -and $sha -cne (Assert-DysonGsRemovalDigest $ExpectedSha256 $code)) { Throw-DysonGsRemovalError $code }
    $value = Read-DysonGsRemovalJson -Path $item.FullName -MaximumBytes 65536
    Assert-DysonGsRemovalExactProperties $value @(
        'protocol', 'schemaVersion', 'requestId', 'requestFingerprint', 'status', 'guardId',
        'guardManifestSha256', 'snapshotId', 'snapshotManifestSha256', 'authorityInventoryRevision',
        'terminalDigest', 'completedAt'
    ) $code
    if ($value.protocol -isnot [string] -or [string]$value.protocol -cne $script:DysonGsRemovalReceiptProtocol -or
        ($value.schemaVersion -isnot [int] -and $value.schemaVersion -isnot [long]) -or [int64]$value.schemaVersion -ne 1 -or
        [string]$value.status -notin @('removed', 'rolled-back')) { Throw-DysonGsRemovalError $code }
    [void](Assert-DysonGsRemovalGuid $value.requestId $code)
    [void](Assert-DysonGsRemovalGuid $value.guardId $code)
    foreach ($field in @('requestFingerprint', 'snapshotManifestSha256', 'authorityInventoryRevision', 'terminalDigest')) {
        [void](Assert-DysonGsRemovalDigest $value.$field $code)
    }
    if ([string]$value.status -ceq 'removed') { [void](Assert-DysonGsRemovalDigest $value.guardManifestSha256 $code) }
    elseif ($null -ne $value.guardManifestSha256) { Throw-DysonGsRemovalError $code }
    Assert-DysonGsRemovalTimestamp $value.completedAt $code
    return [pscustomobject][ordered]@{ value = $value; sha256 = $sha; path = $item.FullName }
}

function New-DysonGsRemovalRestoreReceiptValue {
    param(
        [Parameter(Mandatory)][string]$RestoreRequestId,
        [Parameter(Mandatory)][string]$RemovalRequestId,
        [Parameter(Mandatory)][string]$RequestFingerprint,
        [ValidateSet('restored-disabled', 'rolled-back')][string]$Status,
        [Parameter(Mandatory)][string]$RemovalReceiptSha256,
        [Parameter(Mandatory)][string]$GuardManifestSha256,
        [Parameter(Mandatory)][string]$TerminalDigest
    )

    return [pscustomobject][ordered]@{
        protocol = $script:DysonGsRemovalRestoreReceiptProtocol
        schemaVersion = 1
        restoreRequestId = $RestoreRequestId
        removalRequestId = $RemovalRequestId
        requestFingerprint = $RequestFingerprint
        status = $Status
        removalReceiptSha256 = $RemovalReceiptSha256
        guardManifestSha256 = $GuardManifestSha256
        terminalDigest = $TerminalDigest
        activationRequired = $true
        completedAt = [DateTime]::UtcNow.ToString('o')
    }
}

function Read-DysonGsRemovalRestoreReceipt {
    param([Parameter(Mandatory)][string]$Path, [string]$ExpectedSha256)

    $code = 'DYSON_GSMANAGER_REMOVAL_RESTORE_RECEIPT_INVALID'
    $item = Assert-DysonGsPlainFile -Path $Path -MaximumBytes 65536
    $sha = Get-DysonGsSha256 $item.FullName
    if ($ExpectedSha256 -and $sha -cne (Assert-DysonGsRemovalDigest $ExpectedSha256 $code)) { Throw-DysonGsRemovalError $code }
    $value = Read-DysonGsRemovalJson -Path $item.FullName -MaximumBytes 65536
    Assert-DysonGsRemovalExactProperties $value @(
        'protocol', 'schemaVersion', 'restoreRequestId', 'removalRequestId', 'requestFingerprint',
        'status', 'removalReceiptSha256', 'guardManifestSha256', 'terminalDigest', 'activationRequired', 'completedAt'
    ) $code
    if ($value.protocol -isnot [string] -or [string]$value.protocol -cne $script:DysonGsRemovalRestoreReceiptProtocol -or
        ($value.schemaVersion -isnot [int] -and $value.schemaVersion -isnot [long]) -or [int64]$value.schemaVersion -ne 1 -or
        [string]$value.status -notin @('restored-disabled', 'rolled-back') -or
        $value.activationRequired -isnot [bool] -or -not [bool]$value.activationRequired) {
        Throw-DysonGsRemovalError $code
    }
    [void](Assert-DysonGsRemovalGuid $value.restoreRequestId $code)
    [void](Assert-DysonGsRemovalGuid $value.removalRequestId $code)
    foreach ($field in @('requestFingerprint', 'removalReceiptSha256', 'guardManifestSha256', 'terminalDigest')) {
        [void](Assert-DysonGsRemovalDigest $value.$field $code)
    }
    Assert-DysonGsRemovalTimestamp $value.completedAt $code
    return [pscustomobject][ordered]@{ value = $value; sha256 = $sha; path = $item.FullName }
}

function Get-DysonGsRemovalTerminalDigest {
    param(
        [ValidateSet('removed', 'restored-disabled', 'rolled-back-remove', 'rolled-back-restore')][string]$State,
        [Parameter(Mandatory)][string]$RequestId,
        [Parameter(Mandatory)][string]$RootTreeSha256,
        [Parameter(Mandatory)][string]$AclInventorySha256,
        [Parameter(Mandatory)][string]$TaskXmlSha256,
        [Parameter(Mandatory)][string]$TaskSecuritySha256
    )

    return Get-DysonGsRemovalSha256Text (ConvertTo-DysonGsRemovalJson ([ordered]@{
        protocol = $script:DysonGsRemovalProtocol
        state = $State
        requestId = $RequestId
        rootTreeSha256 = $RootTreeSha256
        aclInventorySha256 = $AclInventorySha256
        taskXmlSha256 = $TaskXmlSha256
        taskSecuritySha256 = $TaskSecuritySha256
    }))
}

function Get-DysonGsRemovalPartialGuardCapture {
    param([Parameter(Mandatory)][string]$GuardRoot, [Parameter(Mandatory)]$Intent)

    $guard = Assert-DysonGsRemovalPrivateDirectory -Path $GuardRoot
    $xml = [IO.File]::ReadAllBytes((Assert-DysonGsPlainFile (Join-Path $guard 'task.xml') $script:DysonGsRemovalMaximumJsonBytes))
    $security = [IO.File]::ReadAllBytes((Assert-DysonGsPlainFile (Join-Path $guard 'task-security.bin') 1048576))
    $acl = Read-DysonGsRemovalAclInventory (Join-Path $guard 'tree-acls.json')
    if ((Get-DysonGsRemovalSha256Bytes $xml) -cne [string]$Intent.taskXmlSha256 -or
        (Get-DysonGsRemovalSha256Bytes $security) -cne [string]$Intent.taskSecuritySha256 -or
        [string]$acl.inventorySha256 -cne [string]$Intent.aclInventorySha256) {
        Throw-DysonGsRemovalError 'DYSON_GSMANAGER_REMOVAL_GUARD_INVALID'
    }
    return [pscustomobject][ordered]@{
        guardRoot = $guard
        movedRoot = Join-Path $guard 'root'
        aclInventory = $acl
        taskCapture = [pscustomobject][ordered]@{
            taskName = [string]$Intent.taskName; taskPath = '\'; xmlBytes = [byte[]]$xml
            xmlSha256 = [string]$Intent.taskXmlSha256; enabled = $false; running = $false
            securityBytes = [byte[]]$security; securityDescriptorSha256 = [string]$Intent.taskSecuritySha256
        }
    }
}

function Move-DysonGsRemovalRoot {
    param([Parameter(Mandatory)][string]$Source, [Parameter(Mandatory)][string]$Destination)

    Assert-DysonGsRemovalLease
    $source = Assert-DysonGsPlainDirectory -Path $Source
    $destination = Get-DysonGsFullPath -Path $Destination
    if (Test-Path -LiteralPath $destination) { Throw-DysonGsRemovalError 'DYSON_GSMANAGER_REMOVAL_MOVE_COLLISION' }
    $parent = Assert-DysonGsPlainDirectory -Path ([IO.Path]::GetDirectoryName($destination))
    if ([string]::Equals($source, $parent, [StringComparison]::OrdinalIgnoreCase) -or
        [string]::Compare([IO.Path]::GetPathRoot($source), [IO.Path]::GetPathRoot($destination), $true) -ne 0) {
        Throw-DysonGsRemovalError 'DYSON_GSMANAGER_REMOVAL_MOVE_NOT_ATOMIC'
    }
    try { [IO.Directory]::Move($source, $destination) }
    catch { Throw-DysonGsRemovalError 'DYSON_GSMANAGER_REMOVAL_MOVE_FAILED' }
    Assert-DysonGsRemovalLease
    if ((Test-Path -LiteralPath $source) -or -not (Test-Path -LiteralPath $destination -PathType Container)) {
        Throw-DysonGsRemovalError 'DYSON_GSMANAGER_REMOVAL_MOVE_FAILED'
    }
}

function Assert-DysonGsRemovalTaskMatchesCapture {
    param([Parameter(Mandatory)]$Capture, [switch]$AllowMissing)

    $image = Get-CutoverHostTaskImage -TaskName ([string]$Capture.taskName) -AllowMissing
    if (-not [bool]$image.present) {
        if ($AllowMissing) { return }
        Throw-DysonGsRemovalError 'DYSON_GSMANAGER_REMOVAL_TASK_DRIFT'
    }
    $xml = [Convert]::FromBase64String([string]$image.xmlBase64)
    $security = Get-DysonGsRemovalTaskSecurityBytes ([string]$Capture.taskName)
    if ([bool]$image.enabled -or [bool]$image.running -or
        (Get-DysonGsRemovalSha256Bytes $xml) -cne [string]$Capture.xmlSha256 -or
        -not (Test-DysonGsRemovalBytesEqual $security ([byte[]]$Capture.securityBytes))) {
        Throw-DysonGsRemovalError 'DYSON_GSMANAGER_REMOVAL_TASK_DRIFT'
    }
}

function Assert-DysonGsRemovalGuardBinding {
    param(
        [Parameter(Mandatory)]$Guard,
        [Parameter(Mandatory)]$Layout,
        [Parameter(Mandatory)]$Profile,
        [Parameter(Mandatory)][string]$SnapshotId,
        [Parameter(Mandatory)][string]$SnapshotManifestSha256,
        [Parameter(Mandatory)][string]$PairedSaveProtectionPointId,
        [Parameter(Mandatory)][string]$PairedSaveProtectionManifestSha256,
        [Parameter(Mandatory)][string]$TaskName
    )

    $manifest = $Guard.manifest
    if ([string]$manifest.dataRootIdentity -cne (Get-DysonGsRemovalPathIdentity $Layout.dataRoot) -or
        [string]$manifest.projectBindingSha256 -cne (Get-DysonGsProjectBindingSha256 -ProjectRoot $Layout.projectRoot) -or
        [string]$manifest.gsManagerRelativeRoot -cne [string]$Layout.gsManagerRelativeRoot -or
        [string]$manifest.snapshotId -cne (Normalize-DysonGsSnapshotId $SnapshotId) -or
        [string]$manifest.snapshotManifestSha256 -cne $SnapshotManifestSha256 -or
        [string]$manifest.authorityInventoryRevision -cne [string]$Profile.inventoryRevision -or
        [string]$manifest.taskName -cne $TaskName -or
        [string]$manifest.pairedSaveProtection.id -cne $PairedSaveProtectionPointId -or
        [string]$manifest.pairedSaveProtection.manifestSha256 -cne $PairedSaveProtectionManifestSha256) {
        Throw-DysonGsRemovalError 'DYSON_GSMANAGER_REMOVAL_GUARD_BINDING_MISMATCH'
    }
}

function Assert-DysonGsRemovalReceiptBinding {
    param(
        [Parameter(Mandatory)]$Receipt,
        [Parameter(Mandatory)][string]$RequestId,
        [Parameter(Mandatory)][string]$RequestFingerprint,
        [Parameter(Mandatory)][string]$SnapshotId,
        [Parameter(Mandatory)][string]$SnapshotManifestSha256,
        [Parameter(Mandatory)][string]$AuthorityInventoryRevision,
        [ValidateSet('removed', 'rolled-back')][string]$ExpectedStatus
    )

    $value = $Receipt.value
    if ([string]$value.requestId -cne $RequestId -or [string]$value.requestFingerprint -cne $RequestFingerprint -or
        [string]$value.snapshotId -cne (Normalize-DysonGsSnapshotId $SnapshotId) -or
        [string]$value.snapshotManifestSha256 -cne $SnapshotManifestSha256 -or
        [string]$value.authorityInventoryRevision -cne $AuthorityInventoryRevision -or
        [string]$value.status -cne $ExpectedStatus) {
        Throw-DysonGsRemovalError 'DYSON_GSMANAGER_REMOVAL_RECEIPT_BINDING_MISMATCH'
    }
}

function Assert-DysonGsRemovalRestoreReceiptBinding {
    param(
        [Parameter(Mandatory)]$Receipt,
        [Parameter(Mandatory)][string]$RestoreRequestId,
        [Parameter(Mandatory)][string]$RemovalRequestId,
        [Parameter(Mandatory)][string]$RequestFingerprint,
        [Parameter(Mandatory)][string]$RemovalReceiptSha256,
        [Parameter(Mandatory)][string]$GuardManifestSha256,
        [ValidateSet('restored-disabled', 'rolled-back')][string]$ExpectedStatus
    )

    $value = $Receipt.value
    if ([string]$value.restoreRequestId -cne $RestoreRequestId -or [string]$value.removalRequestId -cne $RemovalRequestId -or
        [string]$value.requestFingerprint -cne $RequestFingerprint -or [string]$value.status -cne $ExpectedStatus -or
        [string]$value.removalReceiptSha256 -cne $RemovalReceiptSha256 -or
        [string]$value.guardManifestSha256 -cne $GuardManifestSha256) {
        Throw-DysonGsRemovalError 'DYSON_GSMANAGER_REMOVAL_RESTORE_RECEIPT_BINDING_MISMATCH'
    }
}

function Assert-DysonGsRemovalIntentReceiptBinding {
    param([Parameter(Mandatory)]$Intent, [Parameter(Mandatory)]$Receipt)

    $value = $Receipt.value
    $state = if ([string]$value.status -ceq 'removed') { 'removed' } else { 'rolled-back-remove' }
    $expectedTerminal = Get-DysonGsRemovalTerminalDigest -State $state -RequestId ([string]$Intent.requestId) `
        -RootTreeSha256 ([string]$Intent.rootTreeSha256) `
        -AclInventorySha256 ([string]$Intent.aclInventorySha256) `
        -TaskXmlSha256 ([string]$Intent.taskXmlSha256) `
        -TaskSecuritySha256 ([string]$Intent.taskSecuritySha256)
    if ([string]$Intent.operation -cne 'remove' -or
        [string]$Intent.requestId -cne [string]$value.requestId -or
        [string]$Intent.requestFingerprint -cne [string]$value.requestFingerprint -or
        [string]$Intent.guardId -cne [string]$value.guardId -or
        [string]$Intent.snapshotId -cne [string]$value.snapshotId -or
        [string]$Intent.snapshotManifestSha256 -cne [string]$value.snapshotManifestSha256 -or
        [string]$Intent.authorityInventoryRevision -cne [string]$value.authorityInventoryRevision -or
        [string]$value.terminalDigest -cne $expectedTerminal -or
        ([string]$value.status -ceq 'removed' -and [string]$Intent.phase -cne 'task-unregistered')) {
        Throw-DysonGsRemovalError 'DYSON_GSMANAGER_REMOVAL_RECOVERY_MISMATCH'
    }
}

function Assert-DysonGsRemovalRestoreIntentReceiptBinding {
    param([Parameter(Mandatory)]$Intent, [Parameter(Mandatory)]$Receipt)

    $value = $Receipt.value
    $state = if ([string]$value.status -ceq 'restored-disabled') { 'restored-disabled' } else { 'rolled-back-restore' }
    $expectedTerminal = Get-DysonGsRemovalTerminalDigest -State $state -RequestId ([string]$Intent.requestId) `
        -RootTreeSha256 ([string]$Intent.rootTreeSha256) `
        -AclInventorySha256 ([string]$Intent.aclInventorySha256) `
        -TaskXmlSha256 ([string]$Intent.taskXmlSha256) `
        -TaskSecuritySha256 ([string]$Intent.taskSecuritySha256)
    if ([string]$Intent.operation -cne 'restore' -or
        [string]$Intent.requestId -cne [string]$value.restoreRequestId -or
        [string]$Intent.removalRequestId -cne [string]$value.removalRequestId -or
        [string]$Intent.requestFingerprint -cne [string]$value.requestFingerprint -or
        [string]$Intent.removalReceiptSha256 -cne [string]$value.removalReceiptSha256 -or
        [string]$value.terminalDigest -cne $expectedTerminal -or
        ([string]$value.status -ceq 'restored-disabled' -and [string]$Intent.phase -cne 'restore-task-registered')) {
        Throw-DysonGsRemovalError 'DYSON_GSMANAGER_REMOVAL_RECOVERY_MISMATCH'
    }
}

function Get-DysonGsRemovalAuditPath {
    param(
        [Parameter(Mandatory)]$Storage,
        [Parameter(Mandatory)][ValidateSet('remove', 'restore')][string]$Operation,
        [Parameter(Mandatory)][string]$RequestId
    )

    $id = Assert-DysonGsRemovalGuid $RequestId 'DYSON_GSMANAGER_REMOVAL_AUDIT_INVALID'
    return Join-Path $Storage.auditRoot ($Operation + '-' + $id + '.json')
}

function New-DysonGsRemovalAuditValue {
    param(
        [Parameter(Mandatory)][ValidateSet('remove', 'restore')][string]$Operation,
        [Parameter(Mandatory)]$Receipt
    )

    $value = $Receipt.value
    return [pscustomobject][ordered]@{
        protocol = $script:DysonGsRemovalAuditProtocol
        schemaVersion = 1
        operation = $Operation
        requestId = if ($Operation -ceq 'remove') { [string]$value.requestId } else { [string]$value.restoreRequestId }
        removalRequestId = if ($Operation -ceq 'remove') { $null } else { [string]$value.removalRequestId }
        requestFingerprint = [string]$value.requestFingerprint
        status = [string]$value.status
        receiptSha256 = [string]$Receipt.sha256
        terminalDigest = [string]$value.terminalDigest
        completedAt = [string]$value.completedAt
    }
}

function Read-DysonGsRemovalAudit {
    param([Parameter(Mandatory)][string]$Path)

    $code = 'DYSON_GSMANAGER_REMOVAL_AUDIT_INVALID'
    $value = Read-DysonGsRemovalJson -Path $Path -MaximumBytes 65536
    Assert-DysonGsRemovalExactProperties $value @(
        'protocol', 'schemaVersion', 'operation', 'requestId', 'removalRequestId',
        'requestFingerprint', 'status', 'receiptSha256', 'terminalDigest', 'completedAt'
    ) $code
    if ($value.protocol -isnot [string] -or [string]$value.protocol -cne $script:DysonGsRemovalAuditProtocol -or
        ($value.schemaVersion -isnot [int] -and $value.schemaVersion -isnot [long]) -or
        [int64]$value.schemaVersion -ne 1 -or $value.operation -isnot [string] -or
        [string]$value.operation -cnotin @('remove', 'restore') -or $value.status -isnot [string] -or
        ([string]$value.operation -ceq 'remove' -and [string]$value.status -cnotin @('removed', 'rolled-back')) -or
        ([string]$value.operation -ceq 'restore' -and [string]$value.status -cnotin @('restored-disabled', 'rolled-back'))) {
        Throw-DysonGsRemovalError $code
    }
    [void](Assert-DysonGsRemovalGuid $value.requestId $code)
    foreach ($name in @('requestFingerprint', 'receiptSha256', 'terminalDigest')) {
        [void](Assert-DysonGsRemovalDigest $value.$name $code)
    }
    if ([string]$value.operation -ceq 'restore') { [void](Assert-DysonGsRemovalGuid $value.removalRequestId $code) }
    elseif ($null -ne $value.removalRequestId) { Throw-DysonGsRemovalError $code }
    Assert-DysonGsRemovalTimestamp $value.completedAt $code
    return $value
}

function Assert-DysonGsRemovalAuditBinding {
    param(
        [Parameter(Mandatory)]$Storage,
        [Parameter(Mandatory)][ValidateSet('remove', 'restore')][string]$Operation,
        [Parameter(Mandatory)]$Receipt
    )

    $value = $Receipt.value
    $requestId = if ($Operation -ceq 'remove') { [string]$value.requestId } else { [string]$value.restoreRequestId }
    $path = Get-DysonGsRemovalAuditPath $Storage $Operation $requestId
    $actual = Read-DysonGsRemovalAudit $path
    $expected = New-DysonGsRemovalAuditValue $Operation $Receipt
    if ((ConvertTo-DysonGsRemovalJson $actual) -cne (ConvertTo-DysonGsRemovalJson $expected)) {
        Throw-DysonGsRemovalError 'DYSON_GSMANAGER_REMOVAL_AUDIT_CONFLICT'
    }
    return [pscustomobject][ordered]@{ path = $path; value = $actual }
}

function Ensure-DysonGsRemovalAudit {
    param(
        [Parameter(Mandatory)]$Storage,
        [Parameter(Mandatory)][ValidateSet('remove', 'restore')][string]$Operation,
        [Parameter(Mandatory)]$Receipt
    )

    Assert-DysonGsRemovalLease
    $value = $Receipt.value
    $requestId = if ($Operation -ceq 'remove') { [string]$value.requestId } else { [string]$value.restoreRequestId }
    $path = Get-DysonGsRemovalAuditPath $Storage $Operation $requestId
    if (-not (Test-Path -LiteralPath $path)) {
        Write-DysonGsRemovalJsonNew -Path $path -Value (New-DysonGsRemovalAuditValue $Operation $Receipt) `
            -MaximumBytes 65536
    }
    return Assert-DysonGsRemovalAuditBinding $Storage $Operation $Receipt
}

function Complete-DysonGsRemovalTerminal {
    param(
        [Parameter(Mandatory)]$Storage,
        [Parameter(Mandatory)][ValidateSet('remove', 'restore')][string]$Operation,
        [Parameter(Mandatory)]$Intent,
        [Parameter(Mandatory)]$Receipt
    )

    Assert-DysonGsRemovalLease
    if ($Operation -ceq 'remove') { Assert-DysonGsRemovalIntentReceiptBinding $Intent $Receipt }
    else { Assert-DysonGsRemovalRestoreIntentReceiptBinding $Intent $Receipt }
    Assert-DysonGsRemovalFaultPoint 'AfterReceiptBeforeAudit'
    [void](Ensure-DysonGsRemovalAudit $Storage $Operation $Receipt)
    Assert-DysonGsRemovalFaultPoint 'AfterReceiptBeforeIntentDelete'
    $currentIntent = Read-DysonGsRemovalIntent $Storage.activeIntent
    if ((ConvertTo-DysonGsRemovalJson $currentIntent) -cne (ConvertTo-DysonGsRemovalJson $Intent)) {
        Throw-DysonGsRemovalError 'DYSON_GSMANAGER_REMOVAL_RECOVERY_MISMATCH'
    }
    if ($Operation -ceq 'remove') { Assert-DysonGsRemovalIntentReceiptBinding $currentIntent $Receipt }
    else { Assert-DysonGsRemovalRestoreIntentReceiptBinding $currentIntent $Receipt }
    Remove-DysonGsRemovalOwnedFile -Path $Storage.activeIntent -Parent $Storage.root
}

function Assert-DysonGsRemovalNoOwnPending {
    param([Parameter(Mandatory)][string]$DataRoot, [switch]$AllowActive)

    $candidate = Join-Path $DataRoot $script:DysonGsRemovalRelativeRoot
    if (-not (Test-Path -LiteralPath $candidate)) { return $null }
    $storage = Get-DysonGsRemovalStorage -DataRoot $DataRoot
    if (-not $AllowActive -and (Test-Path -LiteralPath $storage.activeIntent)) {
        [void](Read-DysonGsRemovalIntent $storage.activeIntent)
        Throw-DysonGsRemovalError 'DYSON_GSMANAGER_REMOVAL_PENDING'
    }
    return $storage
}

function Assert-DysonGsRemovalSourceTreeMatchesGuard {
    param([Parameter(Mandatory)][string]$SourceRoot, [Parameter(Mandatory)]$Guard)

    $manifest = $Guard.manifest
    $tree = Get-DysonGsTreeInventory -Root $SourceRoot -MaximumFiles ([int]$manifest.limits.maximumFiles) `
        -MaximumTotalBytes ([int64]$manifest.limits.maximumTotalBytes) `
        -MaximumSingleFileBytes ([int64]$manifest.limits.maximumSingleFileBytes) -RejectSaveFiles
    if ([int]$tree.fileCount -ne [int]$manifest.tree.fileCount -or [int64]$tree.totalBytes -ne [int64]$manifest.tree.totalBytes -or
        [string]$tree.treeSha256 -cne [string]$manifest.tree.treeSha256 -or
        -not (Test-DysonGsRemovalAclInventoriesEqual $Guard.aclInventory (Get-DysonGsRemovalAclInventory $SourceRoot))) {
        Throw-DysonGsRemovalError 'DYSON_GSMANAGER_REMOVAL_RESTORED_TREE_INVALID'
    }
}

function Assert-DysonGsRemovalRemovedTerminal {
    param(
        [Parameter(Mandatory)]$Layout,
        [Parameter(Mandatory)]$Profile,
        [Parameter(Mandatory)]$Guard,
        [switch]$CandidateQuiesced
    )

    if ((Test-Path -LiteralPath $Layout.gsManagerRoot) -or
        [bool](Get-CutoverHostTaskImage -TaskName ([string]$Guard.manifest.taskName) -AllowMissing).present -or
        [string]$Guard.location -cne 'guard') {
        Throw-DysonGsRemovalError 'DYSON_GSMANAGER_REMOVAL_POSTCONDITION_FAILED'
    }
    Assert-DysonGsRemovalCandidateHealthy -Profile $Profile -PreviousAbsent -CandidateQuiesced:$CandidateQuiesced
    Assert-DysonGsRemovalNoGsManagerActivity -GsManagerRoot $Layout.gsManagerRoot
}

function Assert-DysonGsRemovalRestoredTerminal {
    param([Parameter(Mandatory)]$Layout, [Parameter(Mandatory)]$Profile, [Parameter(Mandatory)]$Guard)

    [void](Assert-DysonGsPlainDirectory $Layout.gsManagerRoot)
    Assert-DysonGsRemovalSourceTreeMatchesGuard -SourceRoot $Layout.gsManagerRoot -Guard $Guard
    Assert-DysonGsRemovalTaskMatchesCapture -Capture $Guard.taskCapture
    Assert-DysonGsRemovalCandidateHealthy -Profile $Profile -CandidateQuiesced
    Assert-DysonGsRemovalNoGsManagerActivity -GsManagerRoot $Layout.gsManagerRoot
}

function Assert-DysonGsRemovalFaultPoint {
    param([Parameter(Mandatory)][string]$Name)

    if ($script:CutoverHostBackend -ceq 'Shadow' -and
        $env:DYSON_GSMANAGER_REMOVAL_SELFTEST -ceq '1' -and
        $env:DYSON_GSMANAGER_REMOVAL_SELFTEST_FAIL_POINT -ceq $Name) {
        $exception = New-DysonGsRemovalException 'DYSON_GSMANAGER_REMOVAL_SELFTEST_FAILURE'
        if ($Name -cin @('AfterReceiptBeforeAudit', 'AfterReceiptBeforeIntentDelete')) {
            $exception.Data['TerminalCommitted'] = $true
            $exception.Data['FaultPoint'] = $Name
        }
        throw $exception
    }
}

function Get-DysonGsRemovalValidatedPreimage {
    param(
        [Parameter(Mandatory)]$Context,
        [Parameter(Mandatory)][string]$SnapshotId,
        [Parameter(Mandatory)][string]$SnapshotManifestSha256,
        [Parameter(Mandatory)][string]$PairedSaveProtectionPointId,
        [Parameter(Mandatory)][string]$PairedSaveProtectionManifestSha256,
        [Parameter(Mandatory)][string]$TaskName,
        [Parameter(Mandatory)][string]$RuntimeTaskTransactionRoot
    )

    if (-not [bool]$Context.layout.gsManagerExists) { Throw-DysonGsRemovalError 'DYSON_GSMANAGER_REMOVAL_ROOT_MISSING' }
    Assert-DysonGsRemovalNoPendingTransactions -DataRoot $Context.layout.dataRoot `
        -RuntimeTaskTransactionRoot $RuntimeTaskTransactionRoot
    [void](Assert-DysonGsRemovalNoOwnPending -DataRoot $Context.layout.dataRoot)
    Assert-DysonGsRemovalCandidateHealthy -Profile $Context.profile
    Assert-DysonGsRemovalNoGsManagerActivity -GsManagerRoot $Context.layout.gsManagerRoot
    $snapshot = Get-DysonGsRemovalSnapshotVerification -Layout $Context.layout -DataRoot $Context.layout.dataRoot `
        -SnapshotId $SnapshotId -SnapshotManifestSha256 $SnapshotManifestSha256 `
        -PairedSaveProtectionPointId $PairedSaveProtectionPointId `
        -PairedSaveProtectionManifestSha256 $PairedSaveProtectionManifestSha256 `
        -TaskName $TaskName -Profile $Context.profile
    $task = Get-DysonGsRemovalTaskCapture -TaskName $TaskName
    $image = Get-CutoverHostTaskImage -TaskName $TaskName
    if ((Get-CutoverHostTaskDefinitionSha256 $image -NormalizeSettingsEnabledTrue) -cne
        [string]$Context.profile.previousAuthority.main.definitionSha256) {
        Throw-DysonGsRemovalError 'DYSON_GSMANAGER_REMOVAL_TASK_DRIFT'
    }
    $acl = Get-DysonGsRemovalAclInventory -Root $Context.layout.gsManagerRoot
    return [pscustomobject][ordered]@{ snapshot = $snapshot; taskCapture = $task; aclInventory = $acl }
}

function Restore-DysonGsRemovalPreimageAfterFailure {
    param(
        [Parameter(Mandatory)]$Context,
        [Parameter(Mandatory)]$PartialGuard,
        [Parameter(Mandatory)]$Snapshot
    )

    Assert-DysonGsRemovalLease
    $sourcePresent = Test-Path -LiteralPath $Context.layout.gsManagerRoot -PathType Container
    $guardPresent = Test-Path -LiteralPath $PartialGuard.movedRoot -PathType Container
    if ($sourcePresent -and $guardPresent) { Throw-DysonGsRemovalError 'DYSON_GSMANAGER_REMOVAL_COMPENSATION_FAILED' }
    if ($guardPresent) {
        Move-DysonGsRemovalRoot -Source $PartialGuard.movedRoot -Destination $Context.layout.gsManagerRoot
        $sourcePresent = $true
    }
    if (-not $sourcePresent) { Throw-DysonGsRemovalError 'DYSON_GSMANAGER_REMOVAL_COMPENSATION_FAILED' }
    Restore-DysonGsRemovalAclInventory -Root $Context.layout.gsManagerRoot -Inventory $PartialGuard.aclInventory
    $current = Get-DysonGsTreeInventory -Root $Context.layout.gsManagerRoot `
        -MaximumFiles ([int]$Snapshot.verification.manifest.limits.maximumFiles) `
        -MaximumTotalBytes ([int64]$Snapshot.verification.manifest.limits.maximumTotalBytes) `
        -MaximumSingleFileBytes ([int64]$Snapshot.verification.manifest.limits.maximumSingleFileBytes) -RejectSaveFiles
    if ([string]$current.treeSha256 -cne [string]$Snapshot.currentInventory.treeSha256 -or
        -not (Test-DysonGsEntryListsEqual $current.entries $Snapshot.currentInventory.entries)) {
        Throw-DysonGsRemovalError 'DYSON_GSMANAGER_REMOVAL_COMPENSATION_FAILED'
    }
    $taskImage = Get-CutoverHostTaskImage -TaskName ([string]$PartialGuard.taskCapture.taskName) -AllowMissing
    if ([bool]$taskImage.present) {
        Assert-DysonGsRemovalTaskMatchesCapture -Capture $PartialGuard.taskCapture
    }
    else { Restore-DysonGsRemovalTask -Capture $PartialGuard.taskCapture }
    Assert-DysonGsRemovalCandidateHealthy -Profile $Context.profile
    Assert-DysonGsRemovalNoGsManagerActivity -GsManagerRoot $Context.layout.gsManagerRoot
}

function Restore-DysonGsRemovedStateAfterRestoreFailure {
    param([Parameter(Mandatory)]$Context, [Parameter(Mandatory)]$Guard)

    Assert-DysonGsRemovalLease
    $taskImage = Get-CutoverHostTaskImage -TaskName ([string]$Guard.taskCapture.taskName) -AllowMissing
    if ([bool]$taskImage.present) {
        Assert-DysonGsRemovalTaskMatchesCapture -Capture $Guard.taskCapture
        Remove-DysonGsRemovalTask -TaskName ([string]$Guard.taskCapture.taskName)
    }
    $sourcePresent = Test-Path -LiteralPath $Context.layout.gsManagerRoot -PathType Container
    $guardPresent = Test-Path -LiteralPath $Guard.movedRoot -PathType Container
    if ($sourcePresent -and $guardPresent) { Throw-DysonGsRemovalError 'DYSON_GSMANAGER_REMOVAL_COMPENSATION_FAILED' }
    if ($sourcePresent) { Move-DysonGsRemovalRoot -Source $Context.layout.gsManagerRoot -Destination $Guard.movedRoot }
    elseif (-not $guardPresent) { Throw-DysonGsRemovalError 'DYSON_GSMANAGER_REMOVAL_COMPENSATION_FAILED' }
    Restore-DysonGsRemovalAclInventory -Root $Guard.movedRoot -Inventory $Guard.aclInventory
    $verified = Read-DysonGsRemovalGuardManifest -GuardRoot $Guard.guardRoot `
        -ExpectedGuardId ([string]$Guard.manifest.guardId) -ExpectedManifestSha256 ([string]$Guard.manifestSha256)
    Assert-DysonGsRemovalRemovedTerminal -Layout $Context.layout -Profile $Context.profile -Guard $verified -CandidateQuiesced
}

function Invoke-DysonGsManagerRemovalCore {
    param(
        [Parameter(Mandatory)]$Context,
        [Parameter(Mandatory)][string]$RemovalRequestId,
        [Parameter(Mandatory)][string]$RequestFingerprint,
        [Parameter(Mandatory)][string]$SnapshotId,
        [Parameter(Mandatory)][string]$SnapshotManifestSha256,
        [Parameter(Mandatory)][string]$PairedSaveProtectionPointId,
        [Parameter(Mandatory)][string]$PairedSaveProtectionManifestSha256,
        [Parameter(Mandatory)][string]$TaskName,
        [Parameter(Mandatory)][string]$RuntimeTaskTransactionRoot,
        [switch]$Recover
    )

    $requestId = Assert-DysonGsRemovalGuid $RemovalRequestId 'DYSON_GSMANAGER_REMOVAL_INPUT_INVALID'
    $existingStorage = Assert-DysonGsRemovalNoOwnPending -DataRoot $Context.layout.dataRoot -AllowActive
    if ($null -ne $existingStorage) {
        $paths = Get-DysonGsRemovalPaths -Storage $existingStorage -RemovalRequestId $requestId
        if (Test-Path -LiteralPath $paths.receipt -PathType Leaf) {
            $receipt = Read-DysonGsRemovalReceipt $paths.receipt
            $expectedStatus = [string]$receipt.value.status
            Assert-DysonGsRemovalReceiptBinding -Receipt $receipt -RequestId $requestId `
                -RequestFingerprint $RequestFingerprint -SnapshotId $SnapshotId `
                -SnapshotManifestSha256 $SnapshotManifestSha256 `
                -AuthorityInventoryRevision ([string]$Context.profile.inventoryRevision) -ExpectedStatus $expectedStatus
            if ($expectedStatus -ceq 'removed') {
                $guard = Read-DysonGsRemovalGuardManifest -GuardRoot $paths.guard `
                    -ExpectedGuardId ([string]$receipt.value.guardId) `
                    -ExpectedManifestSha256 ([string]$receipt.value.guardManifestSha256)
                Assert-DysonGsRemovalGuardBinding -Guard $guard -Layout $Context.layout -Profile $Context.profile `
                    -SnapshotId $SnapshotId -SnapshotManifestSha256 $SnapshotManifestSha256 `
                    -PairedSaveProtectionPointId $PairedSaveProtectionPointId `
                    -PairedSaveProtectionManifestSha256 $PairedSaveProtectionManifestSha256 -TaskName $TaskName
                Assert-DysonGsRemovalRemovedTerminal -Layout $Context.layout -Profile $Context.profile -Guard $guard
            }
            $activeIntent = if (Test-Path -LiteralPath $existingStorage.activeIntent -PathType Leaf) {
                Read-DysonGsRemovalIntent $existingStorage.activeIntent
            }
            else { $null }
            if ($null -ne $activeIntent) {
                if ($expectedStatus -cne 'removed') {
                    Throw-DysonGsRemovalError 'DYSON_GSMANAGER_REMOVAL_RECOVERY_MISMATCH'
                }
                Assert-DysonGsRemovalIntentReceiptBinding $activeIntent $receipt
                [void](Enter-DysonGsRemovalTerminalReconciliationLease -Operation 'gsmanager-removal' `
                    -RequestId $requestId -Recover:$Recover)
                try {
                    $receipt = Read-DysonGsRemovalReceipt $paths.receipt -ExpectedSha256 ([string]$receipt.sha256)
                    Assert-DysonGsRemovalIntentReceiptBinding `
                        (Read-DysonGsRemovalIntent $existingStorage.activeIntent) $receipt
                    $guard = Read-DysonGsRemovalGuardManifest -GuardRoot $paths.guard `
                        -ExpectedGuardId ([string]$receipt.value.guardId) `
                        -ExpectedManifestSha256 ([string]$receipt.value.guardManifestSha256)
                    Assert-DysonGsRemovalRemovedTerminal -Layout $Context.layout -Profile $Context.profile -Guard $guard
                    Complete-DysonGsRemovalTerminal -Storage $existingStorage -Operation remove `
                        -Intent $activeIntent -Receipt $receipt
                }
                finally { Exit-DysonGsRemovalLease }
            }
            else { [void](Assert-DysonGsRemovalAuditBinding $existingStorage remove $receipt) }
            return [pscustomobject][ordered]@{
                protocol = $script:DysonGsRemovalProtocol; status = $expectedStatus; requestId = $requestId
                receiptSha256 = [string]$receipt.sha256; reused = $true
            }
        }
    }

    if ($Recover) {
        if ($null -eq $existingStorage -or -not (Test-Path -LiteralPath $existingStorage.activeIntent -PathType Leaf)) {
            Throw-DysonGsRemovalError 'DYSON_GSMANAGER_REMOVAL_RECOVERY_MISSING'
        }
        $intent = Read-DysonGsRemovalIntent $existingStorage.activeIntent
        if ([string]$intent.operation -cne 'remove' -or [string]$intent.requestId -cne $requestId -or
            [string]$intent.requestFingerprint -cne $RequestFingerprint) {
            Throw-DysonGsRemovalError 'DYSON_GSMANAGER_REMOVAL_RECOVERY_MISMATCH'
        }
        $paths = Get-DysonGsRemovalPaths -Storage $existingStorage -RemovalRequestId $requestId
        [void](Enter-DysonGsRemovalLease -Operation 'gsmanager-removal' -RequestId $requestId -Recover)
        try {
            $snapshot = Get-DysonGsRemovalSnapshotVerification -Layout $Context.layout -DataRoot $Context.layout.dataRoot `
                -SnapshotId $SnapshotId -SnapshotManifestSha256 $SnapshotManifestSha256 `
                -PairedSaveProtectionPointId $PairedSaveProtectionPointId `
                -PairedSaveProtectionManifestSha256 $PairedSaveProtectionManifestSha256 `
                -TaskName $TaskName -Profile $Context.profile -GsManagerMayBeMissing
            $partial = Get-DysonGsRemovalPartialGuardCapture -GuardRoot $paths.guard -Intent $intent
            Restore-DysonGsRemovalPreimageAfterFailure -Context $Context -PartialGuard $partial -Snapshot $snapshot
            $terminal = Get-DysonGsRemovalTerminalDigest -State 'rolled-back-remove' -RequestId $requestId `
                -RootTreeSha256 ([string]$intent.rootTreeSha256) -AclInventorySha256 ([string]$intent.aclInventorySha256) `
                -TaskXmlSha256 ([string]$intent.taskXmlSha256) -TaskSecuritySha256 ([string]$intent.taskSecuritySha256)
            $receiptValue = New-DysonGsRemovalReceiptValue -RequestId $requestId -RequestFingerprint $RequestFingerprint `
                -Status 'rolled-back' -GuardId ([string]$intent.guardId) -GuardManifestSha256 $null `
                -SnapshotId $SnapshotId -SnapshotManifestSha256 $SnapshotManifestSha256 `
                -AuthorityInventoryRevision ([string]$Context.profile.inventoryRevision) -TerminalDigest $terminal
            Write-DysonGsRemovalJsonNew -Path $paths.receipt -Value $receiptValue -MaximumBytes 65536
            $storedReceipt = Read-DysonGsRemovalReceipt $paths.receipt
            Complete-DysonGsRemovalTerminal -Storage $existingStorage -Operation remove `
                -Intent $intent -Receipt $storedReceipt
            return [pscustomobject][ordered]@{
                protocol = $script:DysonGsRemovalProtocol; status = 'rolled-back'; requestId = $requestId
                receiptSha256 = [string]$storedReceipt.sha256; reused = $false
            }
        }
        catch { Throw-DysonGsRemovalError 'DYSON_GSMANAGER_REMOVAL_COMPENSATION_FAILED' }
        finally { Exit-DysonGsRemovalLease }
    }

    $preimage = Get-DysonGsRemovalValidatedPreimage -Context $Context -SnapshotId $SnapshotId `
        -SnapshotManifestSha256 $SnapshotManifestSha256 -PairedSaveProtectionPointId $PairedSaveProtectionPointId `
        -PairedSaveProtectionManifestSha256 $PairedSaveProtectionManifestSha256 -TaskName $TaskName `
        -RuntimeTaskTransactionRoot $RuntimeTaskTransactionRoot
    [void](Enter-DysonGsRemovalLease -Operation 'gsmanager-removal' -RequestId $requestId)
    $intentWritten = $false
    $terminalReceiptPersisted = $false
    $storage = $null
    $paths = $null
    $intent = $null
    $partial = $null
    try {
        $preimage = Get-DysonGsRemovalValidatedPreimage -Context $Context -SnapshotId $SnapshotId `
            -SnapshotManifestSha256 $SnapshotManifestSha256 -PairedSaveProtectionPointId $PairedSaveProtectionPointId `
            -PairedSaveProtectionManifestSha256 $PairedSaveProtectionManifestSha256 -TaskName $TaskName `
            -RuntimeTaskTransactionRoot $RuntimeTaskTransactionRoot
        $storage = Get-DysonGsRemovalStorage -DataRoot $Context.layout.dataRoot -Create
        if (Test-Path -LiteralPath $storage.activeIntent) { Throw-DysonGsRemovalError 'DYSON_GSMANAGER_REMOVAL_PENDING' }
        $paths = Get-DysonGsRemovalPaths -Storage $storage -RemovalRequestId $requestId
        if ((Test-Path -LiteralPath $paths.guard) -or (Test-Path -LiteralPath $paths.receipt)) {
            Throw-DysonGsRemovalError 'DYSON_GSMANAGER_REMOVAL_REQUEST_COLLISION'
        }
        $guardId = [guid]::NewGuid().ToString('D').ToLowerInvariant()
        $guardSeed = New-DysonGsRemovalGuard -GuardRoot $paths.guard -GuardId $guardId -RemovalRequestId $requestId `
            -Layout $Context.layout -Snapshot $preimage.snapshot -AclInventory $preimage.aclInventory `
            -TaskCapture $preimage.taskCapture -AuthorityInventoryRevision ([string]$Context.profile.inventoryRevision)
        $partial = [pscustomobject][ordered]@{
            guardRoot = $guardSeed.guardRoot; movedRoot = $guardSeed.movedRoot
            aclInventory = $preimage.aclInventory; taskCapture = $preimage.taskCapture
        }
        $intent = New-DysonGsRemovalIntentValue -Operation remove -RequestId $requestId `
            -RequestFingerprint $RequestFingerprint -Phase prepared -GuardId $guardId -SnapshotId $SnapshotId `
            -SnapshotManifestSha256 $SnapshotManifestSha256 `
            -AuthorityInventoryRevision ([string]$Context.profile.inventoryRevision) -TaskName $TaskName `
            -GsManagerRelativeRoot ([string]$Context.layout.gsManagerRelativeRoot) `
            -RootTreeSha256 ([string]$preimage.snapshot.currentInventory.treeSha256) `
            -AclInventorySha256 ([string]$preimage.aclInventory.inventorySha256) `
            -TaskXmlSha256 ([string]$preimage.taskCapture.xmlSha256) `
            -TaskSecuritySha256 ([string]$preimage.taskCapture.securityDescriptorSha256)
        Write-DysonGsRemovalJsonNew -Path $storage.activeIntent -Value $intent -MaximumBytes 65536
        $intentWritten = $true
        Move-DysonGsRemovalRoot -Source $Context.layout.gsManagerRoot -Destination $guardSeed.movedRoot
        if (-not (Test-DysonGsRemovalAclInventoriesEqual $preimage.aclInventory (Get-DysonGsRemovalAclInventory $guardSeed.movedRoot))) {
            Throw-DysonGsRemovalError 'DYSON_GSMANAGER_REMOVAL_GUARD_VERIFY_FAILED'
        }
        $intent = Set-DysonGsRemovalIntentPhase -Path $storage.activeIntent -Intent $intent -Phase 'root-moved'
        Assert-DysonGsRemovalFaultPoint 'AfterTreeMove'
        Assert-DysonGsRemovalTaskMatchesCapture -Capture $preimage.taskCapture
        Remove-DysonGsRemovalTask -TaskName $TaskName
        $intent = Set-DysonGsRemovalIntentPhase -Path $storage.activeIntent -Intent $intent -Phase 'task-unregistered'
        Assert-DysonGsRemovalFaultPoint 'AfterTaskUnregister'
        $guardWritten = Write-DysonGsRemovalGuardManifestNew -Guard $guardSeed -Layout $Context.layout `
            -Snapshot $preimage.snapshot -AclInventory $preimage.aclInventory -TaskCapture $preimage.taskCapture
        $guard = Read-DysonGsRemovalGuardManifest -GuardRoot $paths.guard -ExpectedGuardId $guardId `
            -ExpectedManifestSha256 $guardWritten.manifestSha256
        Assert-DysonGsRemovalRemovedTerminal -Layout $Context.layout -Profile $Context.profile -Guard $guard
        $terminal = Get-DysonGsRemovalTerminalDigest -State removed -RequestId $requestId `
            -RootTreeSha256 ([string]$intent.rootTreeSha256) -AclInventorySha256 ([string]$intent.aclInventorySha256) `
            -TaskXmlSha256 ([string]$intent.taskXmlSha256) -TaskSecuritySha256 ([string]$intent.taskSecuritySha256)
        $receiptValue = New-DysonGsRemovalReceiptValue -RequestId $requestId -RequestFingerprint $RequestFingerprint `
            -Status removed -GuardId $guardId -GuardManifestSha256 ([string]$guard.manifestSha256) `
            -SnapshotId $SnapshotId -SnapshotManifestSha256 $SnapshotManifestSha256 `
            -AuthorityInventoryRevision ([string]$Context.profile.inventoryRevision) -TerminalDigest $terminal
        Write-DysonGsRemovalJsonNew -Path $paths.receipt -Value $receiptValue -MaximumBytes 65536
        $terminalReceiptPersisted = $true
        $storedReceipt = Read-DysonGsRemovalReceipt $paths.receipt
        Assert-DysonGsRemovalReceiptBinding -Receipt $storedReceipt -RequestId $requestId `
            -RequestFingerprint $RequestFingerprint -SnapshotId $SnapshotId `
            -SnapshotManifestSha256 $SnapshotManifestSha256 `
            -AuthorityInventoryRevision ([string]$Context.profile.inventoryRevision) -ExpectedStatus removed
        Complete-DysonGsRemovalTerminal -Storage $storage -Operation remove -Intent $intent -Receipt $storedReceipt
        return [pscustomobject][ordered]@{
            protocol = $script:DysonGsRemovalProtocol; status = 'removed'; requestId = $requestId
            receiptSha256 = [string]$storedReceipt.sha256; reused = $false
        }
    }
    catch {
        if ($terminalReceiptPersisted -or ($null -ne $paths -and (Test-Path -LiteralPath $paths.receipt -PathType Leaf))) {
            throw
        }
        if (-not $intentWritten) { throw }
        try {
            if ($null -eq $partial) { $partial = Get-DysonGsRemovalPartialGuardCapture -GuardRoot $paths.guard -Intent $intent }
            Restore-DysonGsRemovalPreimageAfterFailure -Context $Context -PartialGuard $partial -Snapshot $preimage.snapshot
            $terminal = Get-DysonGsRemovalTerminalDigest -State 'rolled-back-remove' -RequestId $requestId `
                -RootTreeSha256 ([string]$intent.rootTreeSha256) -AclInventorySha256 ([string]$intent.aclInventorySha256) `
                -TaskXmlSha256 ([string]$intent.taskXmlSha256) -TaskSecuritySha256 ([string]$intent.taskSecuritySha256)
            $receiptValue = New-DysonGsRemovalReceiptValue -RequestId $requestId -RequestFingerprint $RequestFingerprint `
                -Status rolled-back -GuardId ([string]$intent.guardId) -GuardManifestSha256 $null `
                -SnapshotId $SnapshotId -SnapshotManifestSha256 $SnapshotManifestSha256 `
                -AuthorityInventoryRevision ([string]$Context.profile.inventoryRevision) -TerminalDigest $terminal
            if (-not (Test-Path -LiteralPath $paths.receipt)) {
                Write-DysonGsRemovalJsonNew -Path $paths.receipt -Value $receiptValue -MaximumBytes 65536
            }
            $rolledBackReceipt = Read-DysonGsRemovalReceipt $paths.receipt
            Complete-DysonGsRemovalTerminal -Storage $storage -Operation remove `
                -Intent $intent -Receipt $rolledBackReceipt
        }
        catch { Throw-DysonGsRemovalError 'DYSON_GSMANAGER_REMOVAL_COMPENSATION_FAILED' }
        Throw-DysonGsRemovalError 'DYSON_GSMANAGER_REMOVAL_FAILED_ROLLED_BACK'
    }
    finally { Exit-DysonGsRemovalLease }
}

function Invoke-DysonGsManagerRemovalRestoreCore {
    param(
        [Parameter(Mandatory)]$Context,
        [Parameter(Mandatory)][string]$RemovalRequestId,
        [Parameter(Mandatory)][string]$RestoreRequestId,
        [Parameter(Mandatory)][string]$RemovalRequestFingerprint,
        [Parameter(Mandatory)][string]$RestoreRequestFingerprint,
        [Parameter(Mandatory)][string]$RemovalReceiptSha256,
        [Parameter(Mandatory)][string]$SnapshotId,
        [Parameter(Mandatory)][string]$SnapshotManifestSha256,
        [Parameter(Mandatory)][string]$PairedSaveProtectionPointId,
        [Parameter(Mandatory)][string]$PairedSaveProtectionManifestSha256,
        [Parameter(Mandatory)][string]$TaskName,
        [Parameter(Mandatory)][string]$RuntimeTaskTransactionRoot,
        [switch]$Recover
    )

    $removalId = Assert-DysonGsRemovalGuid $RemovalRequestId 'DYSON_GSMANAGER_REMOVAL_INPUT_INVALID'
    $restoreId = Assert-DysonGsRemovalGuid $RestoreRequestId 'DYSON_GSMANAGER_REMOVAL_INPUT_INVALID'
    $storage = Get-DysonGsRemovalStorage -DataRoot $Context.layout.dataRoot
    $paths = Get-DysonGsRemovalPaths -Storage $storage -RemovalRequestId $removalId -RestoreRequestId $restoreId
    $removalReceipt = Read-DysonGsRemovalReceipt -Path $paths.receipt -ExpectedSha256 $RemovalReceiptSha256
    Assert-DysonGsRemovalReceiptBinding -Receipt $removalReceipt -RequestId $removalId `
        -RequestFingerprint $RemovalRequestFingerprint -SnapshotId $SnapshotId `
        -SnapshotManifestSha256 $SnapshotManifestSha256 `
        -AuthorityInventoryRevision ([string]$Context.profile.inventoryRevision) -ExpectedStatus removed
    $guard = Read-DysonGsRemovalGuardManifest -GuardRoot $paths.guard `
        -ExpectedGuardId ([string]$removalReceipt.value.guardId) `
        -ExpectedManifestSha256 ([string]$removalReceipt.value.guardManifestSha256) -RootMayBeRestored
    Assert-DysonGsRemovalGuardBinding -Guard $guard -Layout $Context.layout -Profile $Context.profile `
        -SnapshotId $SnapshotId -SnapshotManifestSha256 $SnapshotManifestSha256 `
        -PairedSaveProtectionPointId $PairedSaveProtectionPointId `
        -PairedSaveProtectionManifestSha256 $PairedSaveProtectionManifestSha256 -TaskName $TaskName

    if (Test-Path -LiteralPath $paths.restoreReceipt -PathType Leaf) {
        $existing = Read-DysonGsRemovalRestoreReceipt $paths.restoreReceipt
        $expectedStatus = [string]$existing.value.status
        Assert-DysonGsRemovalRestoreReceiptBinding -Receipt $existing -RestoreRequestId $restoreId `
            -RemovalRequestId $removalId -RequestFingerprint $RestoreRequestFingerprint `
            -RemovalReceiptSha256 $RemovalReceiptSha256 -GuardManifestSha256 ([string]$guard.manifestSha256) `
            -ExpectedStatus $expectedStatus
        if ($expectedStatus -ceq 'restored-disabled') {
            Assert-DysonGsRemovalRestoredTerminal -Layout $Context.layout -Profile $Context.profile -Guard $guard
        }
        else {
            $removedGuard = Read-DysonGsRemovalGuardManifest -GuardRoot $paths.guard `
                -ExpectedGuardId ([string]$removalReceipt.value.guardId) `
                -ExpectedManifestSha256 ([string]$removalReceipt.value.guardManifestSha256)
            Assert-DysonGsRemovalRemovedTerminal -Layout $Context.layout -Profile $Context.profile -Guard $removedGuard -CandidateQuiesced
        }
        $activeIntent = if (Test-Path -LiteralPath $storage.activeIntent -PathType Leaf) {
            Read-DysonGsRemovalIntent $storage.activeIntent
        }
        else { $null }
        if ($null -ne $activeIntent) {
            if ($expectedStatus -cne 'restored-disabled') {
                Throw-DysonGsRemovalError 'DYSON_GSMANAGER_REMOVAL_RECOVERY_MISMATCH'
            }
            Assert-DysonGsRemovalRestoreIntentReceiptBinding $activeIntent $existing
            [void](Enter-DysonGsRemovalTerminalReconciliationLease -Operation 'gsmanager-removal-restore' `
                -RequestId $restoreId -Recover:$Recover)
            try {
                $existing = Read-DysonGsRemovalRestoreReceipt $paths.restoreReceipt `
                    -ExpectedSha256 ([string]$existing.sha256)
                Assert-DysonGsRemovalRestoreIntentReceiptBinding `
                    (Read-DysonGsRemovalIntent $storage.activeIntent) $existing
                $guard = Read-DysonGsRemovalGuardManifest -GuardRoot $paths.guard `
                    -ExpectedGuardId ([string]$removalReceipt.value.guardId) `
                    -ExpectedManifestSha256 ([string]$removalReceipt.value.guardManifestSha256) -RootMayBeRestored
                Assert-DysonGsRemovalRestoredTerminal -Layout $Context.layout -Profile $Context.profile -Guard $guard
                Complete-DysonGsRemovalTerminal -Storage $storage -Operation restore `
                    -Intent $activeIntent -Receipt $existing
            }
            finally { Exit-DysonGsRemovalLease }
        }
        else { [void](Assert-DysonGsRemovalAuditBinding $storage restore $existing) }
        return [pscustomobject][ordered]@{
            protocol = $script:DysonGsRemovalProtocol; status = $expectedStatus
            removalRequestId = $removalId; restoreRequestId = $restoreId
            receiptSha256 = [string]$existing.sha256; activationRequired = $true; reused = $true
        }
    }

    if ((Test-Path -LiteralPath $storage.activeIntent -PathType Leaf) -and -not $Recover) {
        [void](Read-DysonGsRemovalIntent $storage.activeIntent)
        Throw-DysonGsRemovalError 'DYSON_GSMANAGER_REMOVAL_PENDING'
    }

    if ($Recover) {
        if (-not (Test-Path -LiteralPath $storage.activeIntent -PathType Leaf)) {
            Throw-DysonGsRemovalError 'DYSON_GSMANAGER_REMOVAL_RECOVERY_MISSING'
        }
        $intent = Read-DysonGsRemovalIntent $storage.activeIntent
        if ([string]$intent.operation -cne 'restore' -or [string]$intent.requestId -cne $restoreId -or
            [string]$intent.removalRequestId -cne $removalId -or
            [string]$intent.requestFingerprint -cne $RestoreRequestFingerprint -or
            [string]$intent.removalReceiptSha256 -cne $RemovalReceiptSha256) {
            Throw-DysonGsRemovalError 'DYSON_GSMANAGER_REMOVAL_RECOVERY_MISMATCH'
        }
        [void](Enter-DysonGsRemovalLease -Operation 'gsmanager-removal-restore' -RequestId $restoreId -Recover)
        try {
            Restore-DysonGsRemovedStateAfterRestoreFailure -Context $Context -Guard $guard
            $terminal = Get-DysonGsRemovalTerminalDigest -State 'rolled-back-restore' -RequestId $restoreId `
                -RootTreeSha256 ([string]$intent.rootTreeSha256) -AclInventorySha256 ([string]$intent.aclInventorySha256) `
                -TaskXmlSha256 ([string]$intent.taskXmlSha256) -TaskSecuritySha256 ([string]$intent.taskSecuritySha256)
            $receiptValue = New-DysonGsRemovalRestoreReceiptValue -RestoreRequestId $restoreId `
                -RemovalRequestId $removalId -RequestFingerprint $RestoreRequestFingerprint -Status rolled-back `
                -RemovalReceiptSha256 $RemovalReceiptSha256 -GuardManifestSha256 ([string]$guard.manifestSha256) `
                -TerminalDigest $terminal
            Write-DysonGsRemovalJsonNew -Path $paths.restoreReceipt -Value $receiptValue -MaximumBytes 65536
            $storedReceipt = Read-DysonGsRemovalRestoreReceipt $paths.restoreReceipt
            Complete-DysonGsRemovalTerminal -Storage $storage -Operation restore `
                -Intent $intent -Receipt $storedReceipt
            return [pscustomobject][ordered]@{
                protocol = $script:DysonGsRemovalProtocol; status = 'rolled-back'
                removalRequestId = $removalId; restoreRequestId = $restoreId
                receiptSha256 = [string]$storedReceipt.sha256; activationRequired = $true; reused = $false
            }
        }
        catch { Throw-DysonGsRemovalError 'DYSON_GSMANAGER_REMOVAL_COMPENSATION_FAILED' }
        finally { Exit-DysonGsRemovalLease }
    }

    if ((Test-Path -LiteralPath $Context.layout.gsManagerRoot) -or
        [bool](Get-CutoverHostTaskImage -TaskName $TaskName -AllowMissing).present -or
        [string]$guard.location -cne 'guard') {
        Throw-DysonGsRemovalError 'DYSON_GSMANAGER_REMOVAL_RESTORE_PRECONDITION_FAILED'
    }
    Assert-DysonGsRemovalNoPendingTransactions -DataRoot $Context.layout.dataRoot `
        -RuntimeTaskTransactionRoot $RuntimeTaskTransactionRoot
    Assert-DysonGsRemovalCandidateHealthy -Profile $Context.profile -PreviousAbsent -CandidateQuiesced
    Assert-DysonGsRemovalNoGsManagerActivity -GsManagerRoot $Context.layout.gsManagerRoot
    [void](Get-DysonGsRemovalSnapshotVerification -Layout $Context.layout -DataRoot $Context.layout.dataRoot `
        -SnapshotId $SnapshotId -SnapshotManifestSha256 $SnapshotManifestSha256 `
        -PairedSaveProtectionPointId $PairedSaveProtectionPointId `
        -PairedSaveProtectionManifestSha256 $PairedSaveProtectionManifestSha256 `
        -TaskName $TaskName -Profile $Context.profile -GsManagerMayBeMissing)

    [void](Enter-DysonGsRemovalLease -Operation 'gsmanager-removal-restore' -RequestId $restoreId)
    $intentWritten = $false
    $terminalReceiptPersisted = $false
    $intent = $null
    try {
        $guard = Read-DysonGsRemovalGuardManifest -GuardRoot $paths.guard `
            -ExpectedGuardId ([string]$removalReceipt.value.guardId) `
            -ExpectedManifestSha256 ([string]$removalReceipt.value.guardManifestSha256)
        if ((Test-Path -LiteralPath $Context.layout.gsManagerRoot) -or
            [bool](Get-CutoverHostTaskImage -TaskName $TaskName -AllowMissing).present) {
            Throw-DysonGsRemovalError 'DYSON_GSMANAGER_REMOVAL_RESTORE_PRECONDITION_FAILED'
        }
        Assert-DysonGsRemovalNoPendingTransactions -DataRoot $Context.layout.dataRoot `
            -RuntimeTaskTransactionRoot $RuntimeTaskTransactionRoot
        Assert-DysonGsRemovalCandidateHealthy -Profile $Context.profile -PreviousAbsent -CandidateQuiesced
        Assert-DysonGsRemovalNoGsManagerActivity -GsManagerRoot $Context.layout.gsManagerRoot
        $intent = New-DysonGsRemovalIntentValue -Operation restore -RequestId $restoreId `
            -RequestFingerprint $RestoreRequestFingerprint -Phase prepared `
            -GuardId ([string]$guard.manifest.guardId) -SnapshotId $SnapshotId `
            -SnapshotManifestSha256 $SnapshotManifestSha256 `
            -AuthorityInventoryRevision ([string]$Context.profile.inventoryRevision) -TaskName $TaskName `
            -GsManagerRelativeRoot ([string]$Context.layout.gsManagerRelativeRoot) `
            -RootTreeSha256 ([string]$guard.manifest.tree.treeSha256) `
            -AclInventorySha256 ([string]$guard.manifest.tree.aclInventorySha256) `
            -TaskXmlSha256 ([string]$guard.manifest.task.xmlSha256) `
            -TaskSecuritySha256 ([string]$guard.manifest.task.securityDescriptorSha256) `
            -RemovalRequestId $removalId -RemovalReceiptSha256 $RemovalReceiptSha256
        Write-DysonGsRemovalJsonNew -Path $storage.activeIntent -Value $intent -MaximumBytes 65536
        $intentWritten = $true
        Move-DysonGsRemovalRoot -Source $guard.movedRoot -Destination $Context.layout.gsManagerRoot
        Restore-DysonGsRemovalAclInventory -Root $Context.layout.gsManagerRoot -Inventory $guard.aclInventory
        $intent = Set-DysonGsRemovalIntentPhase -Path $storage.activeIntent -Intent $intent -Phase 'restore-root-moved'
        Assert-DysonGsRemovalFaultPoint 'AfterRestoreTreeMove'
        Restore-DysonGsRemovalTask -Capture $guard.taskCapture
        $intent = Set-DysonGsRemovalIntentPhase -Path $storage.activeIntent -Intent $intent -Phase 'restore-task-registered'
        Assert-DysonGsRemovalFaultPoint 'AfterRestoreTaskRegister'
        Assert-DysonGsRemovalRestoredTerminal -Layout $Context.layout -Profile $Context.profile -Guard $guard
        $terminal = Get-DysonGsRemovalTerminalDigest -State 'restored-disabled' -RequestId $restoreId `
            -RootTreeSha256 ([string]$intent.rootTreeSha256) -AclInventorySha256 ([string]$intent.aclInventorySha256) `
            -TaskXmlSha256 ([string]$intent.taskXmlSha256) -TaskSecuritySha256 ([string]$intent.taskSecuritySha256)
        $receiptValue = New-DysonGsRemovalRestoreReceiptValue -RestoreRequestId $restoreId `
            -RemovalRequestId $removalId -RequestFingerprint $RestoreRequestFingerprint -Status 'restored-disabled' `
            -RemovalReceiptSha256 $RemovalReceiptSha256 -GuardManifestSha256 ([string]$guard.manifestSha256) `
            -TerminalDigest $terminal
        Write-DysonGsRemovalJsonNew -Path $paths.restoreReceipt -Value $receiptValue -MaximumBytes 65536
        $terminalReceiptPersisted = $true
        $storedReceipt = Read-DysonGsRemovalRestoreReceipt $paths.restoreReceipt
        Assert-DysonGsRemovalRestoreReceiptBinding -Receipt $storedReceipt -RestoreRequestId $restoreId `
            -RemovalRequestId $removalId -RequestFingerprint $RestoreRequestFingerprint `
            -RemovalReceiptSha256 $RemovalReceiptSha256 -GuardManifestSha256 ([string]$guard.manifestSha256) `
            -ExpectedStatus 'restored-disabled'
        Complete-DysonGsRemovalTerminal -Storage $storage -Operation restore -Intent $intent -Receipt $storedReceipt
        return [pscustomobject][ordered]@{
            protocol = $script:DysonGsRemovalProtocol; status = 'restored-disabled'
            removalRequestId = $removalId; restoreRequestId = $restoreId
            receiptSha256 = [string]$storedReceipt.sha256; activationRequired = $true; reused = $false
        }
    }
    catch {
        if ($terminalReceiptPersisted -or (Test-Path -LiteralPath $paths.restoreReceipt -PathType Leaf)) {
            throw
        }
        if (-not $intentWritten) { throw }
        try {
            Restore-DysonGsRemovedStateAfterRestoreFailure -Context $Context -Guard $guard
            $terminal = Get-DysonGsRemovalTerminalDigest -State 'rolled-back-restore' -RequestId $restoreId `
                -RootTreeSha256 ([string]$intent.rootTreeSha256) -AclInventorySha256 ([string]$intent.aclInventorySha256) `
                -TaskXmlSha256 ([string]$intent.taskXmlSha256) -TaskSecuritySha256 ([string]$intent.taskSecuritySha256)
            $receiptValue = New-DysonGsRemovalRestoreReceiptValue -RestoreRequestId $restoreId `
                -RemovalRequestId $removalId -RequestFingerprint $RestoreRequestFingerprint -Status rolled-back `
                -RemovalReceiptSha256 $RemovalReceiptSha256 -GuardManifestSha256 ([string]$guard.manifestSha256) `
                -TerminalDigest $terminal
            if (-not (Test-Path -LiteralPath $paths.restoreReceipt)) {
                Write-DysonGsRemovalJsonNew -Path $paths.restoreReceipt -Value $receiptValue -MaximumBytes 65536
            }
            $rolledBackReceipt = Read-DysonGsRemovalRestoreReceipt $paths.restoreReceipt
            Complete-DysonGsRemovalTerminal -Storage $storage -Operation restore `
                -Intent $intent -Receipt $rolledBackReceipt
        }
        catch { Throw-DysonGsRemovalError 'DYSON_GSMANAGER_REMOVAL_COMPENSATION_FAILED' }
        Throw-DysonGsRemovalError 'DYSON_GSMANAGER_REMOVAL_RESTORE_FAILED_ROLLED_BACK'
    }
    finally { Exit-DysonGsRemovalLease }
}
