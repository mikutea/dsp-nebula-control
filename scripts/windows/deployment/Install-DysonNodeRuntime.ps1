[CmdletBinding(SupportsShouldProcess, ConfirmImpact = 'High')]
param(
    [Parameter(Mandatory)][string]$RuntimeArchive,
    [Parameter(Mandatory)][ValidatePattern('^[0-9a-f]{64}$')][string]$ExpectedArchiveSha256,
    [Parameter(Mandatory)][string]$RuntimeRoot,
    [Parameter(Mandatory)][string]$NodeRelativePath,
    [Parameter(Mandatory)][ValidatePattern('^[0-9a-f]{64}$')][string]$ExpectedNodeSha256,
    [string]$PreviousExpectedNodeSha256,
    [string]$InstallRoot = (Join-Path $env:ProgramFiles 'DysonControl'),
    [string]$DataRoot = (Join-Path $env:ProgramData 'DysonControl'),
    [ValidateRange(1, 600)][int]$LeaseTimeoutSeconds = 120,
    [Parameter(DontShow)][switch]$SelfTestAllowCurrentUserAsAdministrator,
    [Parameter(DontShow)][ValidateSet('AfterPreviousMoved', 'AfterCandidateActivated', 'BeforeReceipt')]
    [string]$SelfTestFailurePoint,
    [Parameter(DontShow)][ValidateSet('AfterIntent', 'AfterPreviousMoved', 'AfterCandidateActivated', 'AfterReceipt')]
    [string]$SelfTestPausePoint,
    [Parameter(DontShow)][string]$SelfTestPauseMarker
)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
. (Join-Path $PSScriptRoot 'DysonDeployment.Common.ps1')
. (Join-Path $PSScriptRoot 'DysonNodeRuntime.Transaction.ps1')

function Assert-DysonNodeRuntimeInstallerPath {
    param(
        [Parameter(Mandatory)][string]$Path,
        [Parameter(Mandatory)][bool]$Directory
    )

    $item = Get-Item -LiteralPath $Path -Force -ErrorAction Stop
    if ([bool]$item.PSIsContainer -ne $Directory -or
        ($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint)) {
        throw 'A Node.js runtime installation path is unavailable or redirected.'
    }
    $current = if ($Directory) { $item.FullName } else { [System.IO.Path]::GetDirectoryName($item.FullName) }
    $root = [System.IO.Path]::GetPathRoot($current).TrimEnd('\', '/')
    while (-not [string]::Equals($current.TrimEnd('\', '/'), $root,
            [System.StringComparison]::OrdinalIgnoreCase)) {
        $ancestor = Get-Item -LiteralPath $current -Force -ErrorAction Stop
        if (-not $ancestor.PSIsContainer -or
            ($ancestor.Attributes -band [System.IO.FileAttributes]::ReparsePoint)) {
            throw 'A Node.js runtime installation path contains a redirected ancestor.'
        }
        $parent = [System.IO.Path]::GetDirectoryName($current)
        if ([string]::IsNullOrWhiteSpace($parent) -or
            [string]::Equals($parent, $current, [System.StringComparison]::OrdinalIgnoreCase)) { break }
        $current = $parent
    }
    return $item.FullName
}

function Wait-DysonNodeRuntimeSelfTestPause {
    param(
        [Parameter(Mandatory)][string]$Point,
        [Parameter(Mandatory)][string]$InstallRoot,
        [Parameter(Mandatory)][string]$DataRoot
    )

    if ([string]::IsNullOrWhiteSpace($SelfTestPausePoint) -or
        [string]$SelfTestPausePoint -cne $Point) { return }
    if (-not $SelfTestAllowCurrentUserAsAdministrator -or
        [string]::IsNullOrWhiteSpace($SelfTestPauseMarker)) {
        throw 'The Node.js runtime pause seam is reserved for an isolated self-test.'
    }
    Assert-DysonDeploymentTaskSelfTestScope -InstallRoot $InstallRoot -DataRoot $DataRoot
    $fixtureRoot = Get-DysonFullPath -Path $env:DYSON_DEPLOYMENT_SELFTEST_ROOT_IDENTITY
    $markerFull = Get-DysonFullPath -Path $SelfTestPauseMarker
    $markerLeaf = [System.IO.Path]::GetFileName($markerFull)
    if (-not (Test-DysonPathWithin -Candidate $markerFull -Parent $fixtureRoot) -or
        $markerLeaf -cnotmatch '^dyson-node-pause-[a-z0-9-]{1,80}$') {
        throw 'The Node.js runtime pause seam escaped the isolated self-test root.'
    }
    $markerParent = [System.IO.Path]::GetDirectoryName($markerFull)
    [void](Assert-DysonDeploymentPlainPathChain -Path $markerParent)
    $readyPath = $markerFull + '.ready'
    $releasePath = $markerFull + '.release'
    $stream = [System.IO.File]::Open(
        $readyPath, [System.IO.FileMode]::CreateNew, [System.IO.FileAccess]::Write,
        [System.IO.FileShare]::Read
    )
    try {
        $bytes = [System.Text.UTF8Encoding]::new($false).GetBytes($Point)
        $stream.Write($bytes, 0, $bytes.Length)
        $stream.Flush($true)
    }
    finally { $stream.Dispose() }
    $deadline = (Get-Date).AddMinutes(3)
    while (-not (Test-Path -LiteralPath $releasePath -PathType Leaf)) {
        if ((Get-Date) -ge $deadline) { throw 'The Node.js runtime pause seam timed out.' }
        Start-Sleep -Milliseconds 100
    }
}

function Expand-DysonNodeRuntimeArchive {
    param(
        [Parameter(Mandatory)][System.IO.Stream]$ArchiveStream,
        [Parameter(Mandatory)][string]$DestinationRoot
    )

    Add-Type -AssemblyName System.IO.Compression -ErrorAction Stop
    $archive = [System.IO.Compression.ZipArchive]::new(
        $ArchiveStream,
        [System.IO.Compression.ZipArchiveMode]::Read,
        $true
    )
    try {
        if ($archive.Entries.Count -lt 1 -or $archive.Entries.Count -gt 10000) {
            throw 'The Node.js runtime ZIP has an invalid entry count.'
        }
        $seen = [System.Collections.Generic.HashSet[string]]::new(
            [System.StringComparer]::OrdinalIgnoreCase
        )
        $totalBytes = [int64]0
        foreach ($entry in $archive.Entries) {
            $relative = ([string]$entry.FullName).Replace('/', '\')
            if ([string]::IsNullOrWhiteSpace($relative) -or $relative.IndexOf([char]0) -ge 0 -or
                [System.IO.Path]::IsPathRooted($relative) -or $relative -match '(^|[\\])\.\.([\\]|$)' -or
                $relative -match '^[A-Za-z]:' -or -not $seen.Add($relative.TrimEnd('\'))) {
                throw 'The Node.js runtime ZIP contains an invalid or duplicate path.'
            }
            $unixType = (([int64]$entry.ExternalAttributes -shr 16) -band 0xF000)
            if ($unixType -eq 0xA000) {
                throw 'The Node.js runtime ZIP contains a symbolic link.'
            }
            $destination = Get-DysonFullPath -Path (Join-Path $DestinationRoot $relative)
            if (-not (Test-DysonPathWithin -Candidate $destination -Parent $DestinationRoot)) {
                throw 'The Node.js runtime ZIP entry escaped the staging root.'
            }
            $isDirectory = [string]::IsNullOrEmpty([string]$entry.Name)
            if ($isDirectory) {
                [void][System.IO.Directory]::CreateDirectory($destination)
                continue
            }
            if ([int64]$entry.Length -lt 0 -or [int64]$entry.Length -gt 536870912) {
                throw 'A Node.js runtime ZIP entry is too large.'
            }
            $totalBytes += [int64]$entry.Length
            if ($totalBytes -gt 1073741824) { throw 'The Node.js runtime ZIP expands beyond the allowed size.' }
            [void][System.IO.Directory]::CreateDirectory([System.IO.Path]::GetDirectoryName($destination))
            $input = $entry.Open()
            $output = [System.IO.File]::Open(
                $destination,
                [System.IO.FileMode]::CreateNew,
                [System.IO.FileAccess]::Write,
                [System.IO.FileShare]::None
            )
            try { $input.CopyTo($output) }
            finally { $output.Dispose(); $input.Dispose() }
            if ((Get-Item -LiteralPath $destination -Force -ErrorAction Stop).Length -ne [int64]$entry.Length) {
                throw 'A Node.js runtime ZIP entry did not extract to its declared length.'
            }
        }
    }
    finally { $archive.Dispose() }
}

[void](Assert-DysonNodeRuntimeHash -ExpectedNodeSha256 $ExpectedArchiveSha256 `
    -Name 'ExpectedArchiveSha256')
[void](Assert-DysonNodeRuntimeHash -ExpectedNodeSha256 $ExpectedNodeSha256 `
    -Name 'ExpectedNodeSha256')
if (-not [string]::IsNullOrWhiteSpace($PreviousExpectedNodeSha256)) {
    [void](Assert-DysonNodeRuntimeHash -ExpectedNodeSha256 $PreviousExpectedNodeSha256 `
        -Name 'PreviousExpectedNodeSha256')
}
Assert-DysonRelativePath -Path $NodeRelativePath -Name 'NodeRelativePath'
$nodeRelative = $NodeRelativePath.Replace('/', '\').TrimStart('\')
if ([string]::IsNullOrWhiteSpace($nodeRelative) -or $nodeRelative.EndsWith('\')) {
    throw 'NodeRelativePath must identify a file.'
}
$installFull = Assert-DysonSafeRoot -Path $InstallRoot -Name 'InstallRoot'
$dataFull = Assert-DysonSafeRoot -Path $DataRoot -Name 'DataRoot'
$runtimeFull = Assert-DysonSafeRoot -Path $RuntimeRoot -Name 'RuntimeRoot'
foreach ($otherRoot in @($installFull, $dataFull)) {
    if ((Test-DysonPathWithin -Candidate $runtimeFull -Parent $otherRoot -AllowEqual) -or
        (Test-DysonPathWithin -Candidate $otherRoot -Parent $runtimeFull -AllowEqual)) {
        throw 'RuntimeRoot must be a separate directory tree from InstallRoot and DataRoot.'
    }
}
$runtimeParent = [System.IO.Path]::GetDirectoryName($runtimeFull.TrimEnd('\', '/'))
if ([string]::IsNullOrWhiteSpace($runtimeParent)) {
    throw 'RuntimeRoot must have a bounded direct parent container.'
}
foreach ($otherRoot in @($installFull, $dataFull)) {
    if ((Test-DysonPathWithin -Candidate $runtimeParent -Parent $otherRoot -AllowEqual) -or
        (Test-DysonPathWithin -Candidate $otherRoot -Parent $runtimeParent -AllowEqual)) {
        throw 'RuntimeContainer must be a separate directory tree from InstallRoot and DataRoot.'
    }
}
$existingAncestor = $runtimeParent
while (-not (Test-Path -LiteralPath $existingAncestor -PathType Container)) {
    $nextAncestor = [System.IO.Path]::GetDirectoryName($existingAncestor)
    if ([string]::IsNullOrWhiteSpace($nextAncestor) -or
        [string]::Equals($nextAncestor, $existingAncestor, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw 'RuntimeContainer has no bounded existing parent.'
    }
    $existingAncestor = $nextAncestor
}
[void](Assert-DysonNodeRuntimeInstallerPath -Path $existingAncestor -Directory $true)
$archivePath = Assert-DysonNodeRuntimeInstallerPath -Path $RuntimeArchive -Directory $false
$archiveItem = Get-Item -LiteralPath $archivePath -Force -ErrorAction Stop
if ($archiveItem.Length -lt 1 -or $archiveItem.Length -gt 1073741824) {
    throw 'The Node.js runtime ZIP is empty or exceeds the allowed size.'
}

$archiveStream = [System.IO.File]::Open(
    $archivePath,
    [System.IO.FileMode]::Open,
    [System.IO.FileAccess]::Read,
    [System.IO.FileShare]::Read
)
$archiveHasher = [System.Security.Cryptography.SHA256]::Create()
try {
    $archiveSha256 = ([System.BitConverter]::ToString(
        $archiveHasher.ComputeHash($archiveStream)
    )).Replace('-', '').ToLowerInvariant()
    if (-not [string]::Equals($archiveSha256, $ExpectedArchiveSha256,
            [System.StringComparison]::Ordinal)) {
        throw 'The Node.js runtime ZIP SHA-256 digest does not match ExpectedArchiveSha256.'
    }
    $archiveStream.Position = 0

    if (-not $PSCmdlet.ShouldProcess(
            $runtimeFull,
            'install or replace the independently protected Node.js runtime under an exclusive transaction lease'
        )) {
        [ordered]@{
            protocol = $script:DysonNodeRuntimeReceiptProtocol
            schemaVersion = $script:DysonNodeRuntimeTransactionSchemaVersion
            state = 'preview'
            archiveSha256 = $archiveSha256
            nodeExecutableSha256 = $ExpectedNodeSha256
            previousRuntimePresent = $null
            priorRuntimeStateInspected = $false
            sameVolumeAtomicRename = $true
            runtimeRootIdentity = Get-DysonNodeRuntimePathIdentityDigest -Path $runtimeFull
            runtimeContainerIdentity = Get-DysonNodeRuntimePathIdentityDigest -Path $runtimeParent
            runtimeChanged = $false
        } | ConvertTo-DysonJsonLine
        exit 0
    }

    if ($SelfTestAllowCurrentUserAsAdministrator) {
        Assert-DysonDeploymentTaskSelfTestScope -InstallRoot $installFull -DataRoot $dataFull
    }
    elseif (-not ([System.Security.Principal.WindowsPrincipal]::new(
        [System.Security.Principal.WindowsIdentity]::GetCurrent()
    )).IsInRole([System.Security.Principal.WindowsBuiltInRole]::Administrator)) {
        throw 'Administrator rights are required to install the protected Node.js runtime.'
    }

    if (-not (Test-DysonNodeRuntimeDirectoryExists -Path $runtimeParent)) {
        [void][System.IO.Directory]::CreateDirectory(
            (ConvertTo-DysonDeploymentExtendedPath -Path $runtimeParent)
        )
        Set-DysonNodeRuntimeContainerProtectionAcl -RuntimeContainer $runtimeParent `
            -RuntimeRoot $runtimeFull -InstallRoot $installFull -DataRoot $dataFull `
            -AllowSelfTestAdministrator:$SelfTestAllowCurrentUserAsAdministrator
    }
    [void](Assert-DysonNodeRuntimeContainerProtection -RuntimeRoot $runtimeFull `
        -InstallRoot $installFull -DataRoot $dataFull)

    $storage = Get-DysonNodeRuntimeTransactionStorage -RuntimeRoot $runtimeFull
    if (-not (Test-DysonNodeRuntimeDirectoryExists -Path ([string]$storage.transactionRoot))) {
        Initialize-DysonNodeRuntimeTransactionStorage -Storage $storage `
            -InstallRoot $installFull -DataRoot $dataFull `
            -AllowSelfTestAdministrator:$SelfTestAllowCurrentUserAsAdministrator
    }
    [void](Assert-DysonNodeRuntimeTransactionStorageProtection -Storage $storage `
        -InstallRoot $installFull -DataRoot $dataFull)
    $lease = $null
    try {
        $lease = Enter-DysonNodeRuntimeTransactionLease -Storage $storage `
            -TimeoutSeconds $LeaseTimeoutSeconds
        if (-not $lease.CanRead -or -not $lease.CanWrite -or
            -not [string]::Equals(
                (Get-DysonFullPath -Path $lease.Name),
                (Get-DysonFullPath -Path ([string]$storage.leasePath)),
                [System.StringComparison]::OrdinalIgnoreCase
            )) {
            throw 'The exclusive Node.js runtime transaction lease is invalid.'
        }

        [void](Assert-DysonNodeRuntimeContainerProtection -RuntimeRoot $runtimeFull `
            -InstallRoot $installFull -DataRoot $dataFull)
        [void](Assert-DysonNodeRuntimeTransactionStorageProtection -Storage $storage `
            -InstallRoot $installFull -DataRoot $dataFull)

        # All reads of pending state and RuntimeRoot happen only after this exclusive lease is held.
        [void](Invoke-DysonNodeRuntimeTransactionRecovery -Storage $storage `
            -InstallRoot $installFull -DataRoot $dataFull `
            -AllowSelfTestAdministrator:$SelfTestAllowCurrentUserAsAdministrator)

        $previousPresent = Test-DysonNodeRuntimeDirectoryExists -Path $runtimeFull
        if ($previousPresent -and [string]::IsNullOrWhiteSpace($PreviousExpectedNodeSha256)) {
            throw 'PreviousExpectedNodeSha256 is required when RuntimeRoot already exists.'
        }
        if (-not $previousPresent -and -not [string]::IsNullOrWhiteSpace($PreviousExpectedNodeSha256)) {
            throw 'PreviousExpectedNodeSha256 is valid only when RuntimeRoot already exists.'
        }
        $previousProtection = if ($previousPresent) {
            Assert-DysonNodeRuntimeProtection -RuntimeRoot $runtimeFull `
                -NodeExecutable (Join-Path $runtimeFull $nodeRelative) `
                -ExpectedNodeSha256 $PreviousExpectedNodeSha256 `
                -InstallRoot $installFull -DataRoot $dataFull
        }
        else { $null }

        $operationId = [guid]::NewGuid().ToString('N')
        $paths = Get-DysonNodeRuntimeOperationPaths -Storage $storage -OperationId $operationId
        $intent = New-DysonNodeRuntimeIntentRecord -Storage $storage `
            -OperationId $operationId -NodeRelativePath $nodeRelative `
            -ArchiveSha256 $archiveSha256 -CandidateNodeSha256 $ExpectedNodeSha256 `
            -PreviousRuntimePresent $previousPresent `
            -PreviousNodeSha256 $(if ($previousProtection) {
                [string]$previousProtection.nodeExecutableSha256
            } else { $null })
        Write-DysonNodeRuntimeTransactionRecordCreateNew -Path $paths.intentPath `
            -Value $intent -Storage $storage -InstallRoot $installFull -DataRoot $dataFull `
            -AllowSelfTestAdministrator:$SelfTestAllowCurrentUserAsAdministrator
        Wait-DysonNodeRuntimeSelfTestPause -Point AfterIntent `
            -InstallRoot $installFull -DataRoot $dataFull

        try {
            [void][System.IO.Directory]::CreateDirectory([string]$paths.stageRoot)
            New-DysonNodeRuntimeCandidateMarker -StageRoot $paths.stageRoot -Intent $intent
            Set-DysonNodeRuntimeProtectionAcl -RuntimeRoot $paths.stageRoot `
                -InstallRoot $installFull -DataRoot $dataFull `
                -AllowSelfTestAdministrator:$SelfTestAllowCurrentUserAsAdministrator
            Expand-DysonNodeRuntimeArchive -ArchiveStream $archiveStream `
                -DestinationRoot $paths.stageRoot
            Set-DysonNodeRuntimeProtectionAcl -RuntimeRoot $paths.stageRoot `
                -InstallRoot $installFull -DataRoot $dataFull `
                -AllowSelfTestAdministrator:$SelfTestAllowCurrentUserAsAdministrator
            [void](Assert-DysonNodeRuntimeOwnedCandidate -TreeRoot $paths.stageRoot -Location stage `
                -Intent $intent -Storage $storage -InstallRoot $installFull -DataRoot $dataFull)

            if ($previousPresent) {
                [System.IO.Directory]::Move($runtimeFull, [string]$paths.backupRoot)
                Wait-DysonNodeRuntimeSelfTestPause -Point AfterPreviousMoved `
                    -InstallRoot $installFull -DataRoot $dataFull
                if ($SelfTestFailurePoint -eq 'AfterPreviousMoved') {
                    throw 'FICTIONAL_RUNTIME_INSTALL_FAILURE'
                }
            }
            [System.IO.Directory]::Move([string]$paths.stageRoot, $runtimeFull)
            Wait-DysonNodeRuntimeSelfTestPause -Point AfterCandidateActivated `
                -InstallRoot $installFull -DataRoot $dataFull
            if ($SelfTestFailurePoint -eq 'AfterCandidateActivated') {
                throw 'FICTIONAL_RUNTIME_INSTALL_FAILURE'
            }
            $installedProtection = Assert-DysonNodeRuntimeOwnedCandidate `
                -TreeRoot $runtimeFull -Location runtime -Intent $intent -Storage $storage `
                -InstallRoot $installFull -DataRoot $dataFull
            if ($SelfTestFailurePoint -eq 'BeforeReceipt') {
                throw 'FICTIONAL_RUNTIME_INSTALL_FAILURE'
            }
            $receipt = [ordered]@{
                protocol = $script:DysonNodeRuntimeReceiptProtocol
                schemaVersion = $script:DysonNodeRuntimeTransactionSchemaVersion
                state = 'installed'
                operationId = $operationId
                completedAt = (Get-Date).ToUniversalTime().ToString('o')
                runtimeRootIdentity = [string]$installedProtection.runtimeRootIdentity
                archiveSha256 = $archiveSha256
                nodeExecutableSha256 = [string]$installedProtection.nodeExecutableSha256
                nodeRuntimeProtected = $true
                previousRuntimePresent = $previousPresent
                rollbackDefined = $true
                sameVolumeAtomicRename = $true
            }
            [void](Assert-DysonNodeRuntimeInstalledReceipt -Receipt ([pscustomobject]$receipt) -Intent $intent)
            Write-DysonNodeRuntimeTransactionRecordCreateNew -Path $paths.receiptPath `
                -Value $receipt -Storage $storage -InstallRoot $installFull -DataRoot $dataFull `
                -AllowSelfTestAdministrator:$SelfTestAllowCurrentUserAsAdministrator
            Wait-DysonNodeRuntimeSelfTestPause -Point AfterReceipt `
                -InstallRoot $installFull -DataRoot $dataFull
            if ($previousPresent -and (Test-DysonNodeRuntimeDirectoryExists -Path $paths.backupRoot)) {
                Remove-DysonNodeRuntimeOwnedBackupTree -BackupRoot $paths.backupRoot `
                    -Intent $intent -InstallRoot $installFull -DataRoot $dataFull
            }
            $receipt | ConvertTo-DysonJsonLine
        }
        catch {
            $installError = $_
            $installedReceiptPresent = Test-DysonNodeRuntimeFileExists -Path $paths.receiptPath
            try {
                [void](Invoke-DysonNodeRuntimeIntentRecovery -Intent $intent -Storage $storage `
                    -InstallRoot $installFull -DataRoot $dataFull `
                    -AllowSelfTestAdministrator:$SelfTestAllowCurrentUserAsAdministrator)
            }
            catch {
                throw ('Node.js runtime installation failed ({0}); protected recovery also failed ({1}).' -f
                    $installError.Exception.Message, $_.Exception.Message)
            }
            if ($installedReceiptPresent) {
                $committed = Read-DysonNodeRuntimeTransactionRecord -Path $paths.receiptPath `
                    -Storage $storage -InstallRoot $installFull -DataRoot $dataFull
                [void](Assert-DysonNodeRuntimeInstalledReceipt -Receipt $committed -Intent $intent)
                $committed | ConvertTo-DysonJsonLine
                return
            }
            throw $installError
        }
    }
    finally { if ($lease) { $lease.Dispose() } }
}
finally {
    $archiveHasher.Dispose()
    $archiveStream.Dispose()
}
