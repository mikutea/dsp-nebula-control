$script:DysonNodeRuntimeIntentProtocol = 'DYSON_CONTROL_NODE_RUNTIME_INTENT_V2'
$script:DysonNodeRuntimeReceiptProtocol = 'DYSON_CONTROL_NODE_RUNTIME_RECEIPT_V2'
$script:DysonNodeRuntimeRecoveryProtocol = 'DYSON_CONTROL_NODE_RUNTIME_RECOVERY_V2'
$script:DysonNodeRuntimeCandidateProtocol = 'DYSON_CONTROL_NODE_RUNTIME_CANDIDATE_V1'
$script:DysonNodeRuntimeTransactionSchemaVersion = 2
$script:DysonNodeRuntimeCandidateMarkerName = '.dyson-node-runtime-candidate.json'

function Assert-DysonNodeRuntimeExactProperties {
    param(
        [Parameter(Mandatory)]$Value,
        [Parameter(Mandatory)][string[]]$Expected,
        [Parameter(Mandatory)][string]$Message
    )

    if ($null -eq $Value -or $null -eq $Value.PSObject) { throw $Message }
    $actual = @($Value.PSObject.Properties.Name | Sort-Object -CaseSensitive)
    $wanted = @($Expected | Sort-Object -CaseSensitive)
    if ($actual.Count -ne $wanted.Count) { throw $Message }
    for ($index = 0; $index -lt $wanted.Count; $index += 1) {
        if ([string]$actual[$index] -cne [string]$wanted[$index]) { throw $Message }
    }
}

function Assert-DysonNodeRuntimeOperationId {
    param([Parameter(Mandatory)][string]$OperationId)

    if ($OperationId -cnotmatch '^[0-9a-f]{32}$') {
        throw 'The Node.js runtime operation identifier is invalid.'
    }
    return $OperationId
}

function Get-DysonNodeRuntimePathIdentityDigest {
    param([Parameter(Mandatory)][string]$Path)

    return 'sha256:' + (Get-DysonTextSha256 -Value (Get-DysonDeploymentPathIdentity -Path $Path))
}

function Test-DysonNodeRuntimeFileExists {
    param([Parameter(Mandatory)][string]$Path)

    return [System.IO.File]::Exists((ConvertTo-DysonDeploymentExtendedPath -Path $Path))
}

function Test-DysonNodeRuntimeDirectoryExists {
    param([Parameter(Mandatory)][string]$Path)

    return [System.IO.Directory]::Exists((ConvertTo-DysonDeploymentExtendedPath -Path $Path))
}

function Get-DysonNodeRuntimeTransactionStorage {
    param([Parameter(Mandatory)][string]$RuntimeRoot)

    $runtimeFull = Assert-DysonSafeRoot -Path $RuntimeRoot -Name 'RuntimeRoot'
    $runtimeContainer = [System.IO.Path]::GetDirectoryName($runtimeFull.TrimEnd('\', '/'))
    if ([string]::IsNullOrWhiteSpace($runtimeContainer)) {
        throw 'RuntimeRoot must have a bounded direct parent container.'
    }
    $runtimeContainer = Assert-DysonSafeRoot -Path $runtimeContainer -Name 'RuntimeContainer'
    $transactionRoot = Join-Path $runtimeContainer '.dyson-node-runtime-transactions'
    return [pscustomobject][ordered]@{
        runtimeRoot = $runtimeFull
        runtimeContainer = $runtimeContainer
        transactionRoot = $transactionRoot
        intentsRoot = Join-Path $transactionRoot 'intents'
        receiptsRoot = Join-Path $transactionRoot 'receipts'
        recoveriesRoot = Join-Path $transactionRoot 'recoveries'
        leasePath = Join-Path $transactionRoot 'runtime-transaction.lock'
    }
}

function Get-DysonNodeRuntimeOperationPaths {
    param(
        [Parameter(Mandatory)]$Storage,
        [Parameter(Mandatory)][string]$OperationId
    )

    [void](Assert-DysonNodeRuntimeOperationId -OperationId $OperationId)
    return [pscustomobject][ordered]@{
        stageRoot = Join-Path ([string]$Storage.runtimeContainer) ('.dyson-node-stage-' + $OperationId)
        backupRoot = Join-Path ([string]$Storage.runtimeContainer) ('.dyson-node-backup-' + $OperationId)
        intentPath = Join-Path ([string]$Storage.intentsRoot) ($OperationId + '.json')
        receiptPath = Join-Path ([string]$Storage.receiptsRoot) ($OperationId + '.json')
        recoveryPath = Join-Path ([string]$Storage.recoveriesRoot) ($OperationId + '.json')
    }
}

function Set-DysonNodeRuntimeRecordProtectionAcl {
    param(
        [Parameter(Mandatory)][string]$Path,
        [Parameter(Mandatory)][string]$RuntimeRoot,
        [Parameter(Mandatory)][string]$InstallRoot,
        [Parameter(Mandatory)][string]$DataRoot,
        [switch]$AllowSelfTestAdministrator
    )

    $fullPath = Get-DysonFullPath -Path $Path
    $ioPath = ConvertTo-DysonDeploymentExtendedPath -Path $fullPath
    $attributes = [System.IO.File]::GetAttributes($ioPath)
    if (($attributes -band [System.IO.FileAttributes]::Directory) -or
        ($attributes -band [System.IO.FileAttributes]::ReparsePoint)) {
        throw 'A Node.js runtime transaction record is unavailable or redirected.'
    }
    $fixtureSid = Get-DysonNodeRuntimeSelfTestAdministratorSid -RuntimeRoot $RuntimeRoot `
        -InstallRoot $InstallRoot -DataRoot $DataRoot
    if ($AllowSelfTestAdministrator -and [string]::IsNullOrWhiteSpace($fixtureSid)) {
        throw 'The runtime-record ACL fixture exception is outside the authorized isolated self-test root.'
    }
    $ownerSid = if ($AllowSelfTestAdministrator) {
        [System.Security.Principal.SecurityIdentifier]::new($fixtureSid)
    }
    else { [System.Security.Principal.SecurityIdentifier]::new('S-1-5-32-544') }
    $systemSid = [System.Security.Principal.SecurityIdentifier]::new('S-1-5-18')
    $administratorsSid = [System.Security.Principal.SecurityIdentifier]::new('S-1-5-32-544')
    $localServiceSid = [System.Security.Principal.SecurityIdentifier]::new('S-1-5-19')
    $networkServiceSid = [System.Security.Principal.SecurityIdentifier]::new('S-1-5-20')
    $acl = [System.Security.AccessControl.FileSecurity]::new()
    $acl.SetAccessRuleProtection($true, $false)
    $acl.SetOwner($ownerSid)
    foreach ($principal in @($systemSid, $administratorsSid)) {
        $acl.AddAccessRule([System.Security.AccessControl.FileSystemAccessRule]::new(
            $principal,
            [System.Security.AccessControl.FileSystemRights]::FullControl,
            [System.Security.AccessControl.AccessControlType]::Allow
        ))
    }
    foreach ($serviceSid in @($localServiceSid, $networkServiceSid)) {
        $acl.AddAccessRule([System.Security.AccessControl.FileSystemAccessRule]::new(
            $serviceSid,
            [System.Security.AccessControl.FileSystemRights]::ReadAndExecute,
            [System.Security.AccessControl.AccessControlType]::Allow
        ))
    }
    if ($AllowSelfTestAdministrator -and
        -not [string]::Equals($fixtureSid, $administratorsSid.Value,
            [System.StringComparison]::OrdinalIgnoreCase)) {
        $acl.AddAccessRule([System.Security.AccessControl.FileSystemAccessRule]::new(
            [System.Security.Principal.SecurityIdentifier]::new($fixtureSid),
            [System.Security.AccessControl.FileSystemRights]::FullControl,
            [System.Security.AccessControl.AccessControlType]::Allow
        ))
    }
    [System.IO.File]::SetAccessControl($ioPath, $acl)
}

function Initialize-DysonNodeRuntimeTransactionStorage {
    param(
        [Parameter(Mandatory)]$Storage,
        [Parameter(Mandatory)][string]$InstallRoot,
        [Parameter(Mandatory)][string]$DataRoot,
        [switch]$AllowSelfTestAdministrator
    )

    foreach ($path in @(
        [string]$Storage.transactionRoot,
        [string]$Storage.intentsRoot,
        [string]$Storage.receiptsRoot,
        [string]$Storage.recoveriesRoot
    )) {
        if (-not (Test-DysonNodeRuntimeDirectoryExists -Path $path)) {
            [void][System.IO.Directory]::CreateDirectory(
                (ConvertTo-DysonDeploymentExtendedPath -Path $path)
            )
        }
    }
    if (-not (Test-DysonNodeRuntimeFileExists -Path ([string]$Storage.leasePath))) {
        $stream = [System.IO.File]::Open(
            (ConvertTo-DysonDeploymentExtendedPath -Path ([string]$Storage.leasePath)),
            [System.IO.FileMode]::CreateNew,
            [System.IO.FileAccess]::Write,
            [System.IO.FileShare]::None
        )
        try { $stream.Flush($true) } finally { $stream.Dispose() }
    }
    Set-DysonNodeRuntimeProtectionAcl -RuntimeRoot ([string]$Storage.transactionRoot) `
        -InstallRoot $InstallRoot -DataRoot $DataRoot `
        -AllowSelfTestAdministrator:$AllowSelfTestAdministrator
}

function Assert-DysonNodeRuntimeTransactionStorageProtection {
    param(
        [Parameter(Mandatory)]$Storage,
        [Parameter(Mandatory)][string]$InstallRoot,
        [Parameter(Mandatory)][string]$DataRoot
    )

    foreach ($path in @(
        [string]$Storage.transactionRoot,
        [string]$Storage.intentsRoot,
        [string]$Storage.receiptsRoot,
        [string]$Storage.recoveriesRoot
    )) {
        $item = Get-Item -LiteralPath $path -Force -ErrorAction Stop
        if (-not $item.PSIsContainer -or
            ($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint)) {
            throw 'The Node.js runtime transaction storage is unavailable or redirected.'
        }
        Assert-DysonNodeRuntimeAcl -Path $item.FullName `
            -RuntimeRoot ([string]$Storage.runtimeRoot) `
            -InstallRoot $InstallRoot -DataRoot $DataRoot
    }
    $leaseItem = Get-Item -LiteralPath ([string]$Storage.leasePath) -Force -ErrorAction Stop
    if ($leaseItem.PSIsContainer -or
        ($leaseItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint)) {
        throw 'The Node.js runtime transaction lease is unavailable or redirected.'
    }
    Assert-DysonNodeRuntimeAcl -Path $leaseItem.FullName `
        -RuntimeRoot ([string]$Storage.runtimeRoot) `
        -InstallRoot $InstallRoot -DataRoot $DataRoot
    foreach ($entry in @(Get-ChildItem -LiteralPath ([string]$Storage.transactionRoot) -Force -ErrorAction Stop)) {
        if ($entry.Name -cnotin @('intents', 'receipts', 'recoveries', 'runtime-transaction.lock')) {
            throw 'The Node.js runtime transaction storage contains an unsupported root entry.'
        }
    }
    return [pscustomobject][ordered]@{
        transactionRootIdentity = Get-DysonNodeRuntimePathIdentityDigest `
            -Path ([string]$Storage.transactionRoot)
        leaseIdentity = Get-DysonNodeRuntimePathIdentityDigest -Path ([string]$Storage.leasePath)
        protected = $true
    }
}

function Enter-DysonNodeRuntimeTransactionLease {
    param(
        [Parameter(Mandatory)]$Storage,
        [ValidateRange(1, 600)][int]$TimeoutSeconds = 120
    )

    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    do {
        try {
            return [System.IO.FileStream]::new(
                [string]$Storage.leasePath,
                [System.IO.FileMode]::Open,
                [System.IO.FileAccess]::ReadWrite,
                [System.IO.FileShare]::None,
                1,
                [System.IO.FileOptions]::WriteThrough
            )
        }
        catch [System.IO.IOException] {
            if ((Get-Date) -ge $deadline) {
                throw 'Timed out waiting for the exclusive Node.js runtime transaction lease.'
            }
            Start-Sleep -Milliseconds 100
        }
    } while ($true)
}

function Write-DysonNodeRuntimeTransactionRecordCreateNew {
    param(
        [Parameter(Mandatory)][string]$Path,
        [Parameter(Mandatory)]$Value,
        [Parameter(Mandatory)]$Storage,
        [Parameter(Mandatory)][string]$InstallRoot,
        [Parameter(Mandatory)][string]$DataRoot,
        [switch]$AllowSelfTestAdministrator
    )

    $fullPath = Get-DysonFullPath -Path $Path
    if (-not (Test-DysonPathWithin -Candidate $fullPath -Parent ([string]$Storage.transactionRoot))) {
        throw 'A Node.js runtime transaction record escaped its protected root.'
    }
    $ioPath = ConvertTo-DysonDeploymentExtendedPath -Path $fullPath
    if ([System.IO.File]::Exists($ioPath) -or [System.IO.Directory]::Exists($ioPath)) {
        throw 'A Node.js runtime transaction record already exists.'
    }
    $json = $Value | ConvertTo-Json -Depth 10 -Compress
    $bytes = [System.Text.UTF8Encoding]::new($false, $true).GetBytes($json)
    if ($bytes.Length -lt 2 -or $bytes.Length -gt 65536) {
        throw 'A Node.js runtime transaction record has an invalid size.'
    }
    $stream = [System.IO.File]::Open(
        $ioPath,
        [System.IO.FileMode]::CreateNew,
        [System.IO.FileAccess]::Write,
        [System.IO.FileShare]::None
    )
    try {
        $stream.Write($bytes, 0, $bytes.Length)
        $stream.Flush($true)
    }
    finally { $stream.Dispose() }
    Set-DysonNodeRuntimeRecordProtectionAcl -Path $fullPath `
        -RuntimeRoot ([string]$Storage.runtimeRoot) -InstallRoot $InstallRoot -DataRoot $DataRoot `
        -AllowSelfTestAdministrator:$AllowSelfTestAdministrator
}

function Read-DysonNodeRuntimeTransactionRecord {
    param(
        [Parameter(Mandatory)][string]$Path,
        [Parameter(Mandatory)]$Storage,
        [Parameter(Mandatory)][string]$InstallRoot,
        [Parameter(Mandatory)][string]$DataRoot
    )

    $fullPath = Get-DysonFullPath -Path $Path
    if (-not (Test-DysonPathWithin -Candidate $fullPath -Parent ([string]$Storage.transactionRoot))) {
        throw 'A Node.js runtime transaction record escaped its protected root.'
    }
    $ioPath = ConvertTo-DysonDeploymentExtendedPath -Path $fullPath
    $attributes = [System.IO.File]::GetAttributes($ioPath)
    $fileInfo = [System.IO.FileInfo]::new($ioPath)
    if (($attributes -band [System.IO.FileAttributes]::Directory) -or
        ($attributes -band [System.IO.FileAttributes]::ReparsePoint) -or
        $fileInfo.Length -lt 2 -or $fileInfo.Length -gt 65536) {
        throw 'A Node.js runtime transaction record is invalid.'
    }
    Assert-DysonNodeRuntimeAcl -Path $fullPath -RuntimeRoot ([string]$Storage.runtimeRoot) `
        -InstallRoot $InstallRoot -DataRoot $DataRoot
    $stream = [System.IO.File]::Open(
        $ioPath,
        [System.IO.FileMode]::Open,
        [System.IO.FileAccess]::Read,
        [System.IO.FileShare]::Read
    )
    try {
        $bytes = New-Object byte[] ([int]$stream.Length)
        $offset = 0
        while ($offset -lt $bytes.Length) {
            $read = $stream.Read($bytes, $offset, $bytes.Length - $offset)
            if ($read -le 0) { throw 'A Node.js runtime transaction record is truncated.' }
            $offset += $read
        }
        $text = [System.Text.UTF8Encoding]::new($false, $true).GetString($bytes)
        return $text | ConvertFrom-Json -ErrorAction Stop
    }
    catch { throw 'A Node.js runtime transaction record could not be parsed.' }
    finally { $stream.Dispose() }
}

function New-DysonNodeRuntimeIntentRecord {
    param(
        [Parameter(Mandatory)]$Storage,
        [Parameter(Mandatory)][string]$OperationId,
        [Parameter(Mandatory)][string]$NodeRelativePath,
        [Parameter(Mandatory)][string]$ArchiveSha256,
        [Parameter(Mandatory)][string]$CandidateNodeSha256,
        [Parameter(Mandatory)][bool]$PreviousRuntimePresent,
        [AllowNull()][string]$PreviousNodeSha256
    )

    [void](Assert-DysonNodeRuntimeOperationId -OperationId $OperationId)
    [void](Assert-DysonNodeRuntimeHash -ExpectedNodeSha256 $ArchiveSha256 -Name 'ArchiveSha256')
    [void](Assert-DysonNodeRuntimeHash -ExpectedNodeSha256 $CandidateNodeSha256 -Name 'CandidateNodeSha256')
    if ($PreviousRuntimePresent) {
        [void](Assert-DysonNodeRuntimeHash -ExpectedNodeSha256 $PreviousNodeSha256 `
            -Name 'PreviousNodeSha256')
    }
    elseif (-not [string]::IsNullOrWhiteSpace($PreviousNodeSha256)) {
        throw 'A previous Node.js hash cannot be recorded when no previous runtime exists.'
    }
    Assert-DysonRelativePath -Path $NodeRelativePath -Name 'NodeRelativePath'
    $paths = Get-DysonNodeRuntimeOperationPaths -Storage $Storage -OperationId $OperationId
    return [ordered]@{
        protocol = $script:DysonNodeRuntimeIntentProtocol
        schemaVersion = $script:DysonNodeRuntimeTransactionSchemaVersion
        state = 'prepared'
        operationId = $OperationId
        createdAt = (Get-Date).ToUniversalTime().ToString('o')
        runtimeRootIdentity = Get-DysonNodeRuntimePathIdentityDigest -Path ([string]$Storage.runtimeRoot)
        runtimeContainerIdentity = Get-DysonNodeRuntimePathIdentityDigest -Path ([string]$Storage.runtimeContainer)
        transactionRootIdentity = Get-DysonNodeRuntimePathIdentityDigest -Path ([string]$Storage.transactionRoot)
        stageRootIdentity = Get-DysonNodeRuntimePathIdentityDigest -Path ([string]$paths.stageRoot)
        backupRootIdentity = Get-DysonNodeRuntimePathIdentityDigest -Path ([string]$paths.backupRoot)
        nodeRelativePath = $NodeRelativePath.Replace('/', '\').TrimStart('\')
        archiveSha256 = $ArchiveSha256
        candidateNodeExecutableSha256 = $CandidateNodeSha256
        previousRuntimePresent = $PreviousRuntimePresent
        previousNodeExecutableSha256 = if ($PreviousRuntimePresent) { $PreviousNodeSha256 } else { $null }
        sameVolumeAtomicRename = $true
    }
}

function Assert-DysonNodeRuntimeIntentRecord {
    param(
        [Parameter(Mandatory)]$Intent,
        [Parameter(Mandatory)]$Storage
    )

    $message = 'The Node.js runtime transaction intent is invalid.'
    Assert-DysonNodeRuntimeExactProperties -Value $Intent -Expected @(
        'protocol', 'schemaVersion', 'state', 'operationId', 'createdAt',
        'runtimeRootIdentity', 'runtimeContainerIdentity', 'transactionRootIdentity',
        'stageRootIdentity', 'backupRootIdentity', 'nodeRelativePath', 'archiveSha256',
        'candidateNodeExecutableSha256', 'previousRuntimePresent',
        'previousNodeExecutableSha256', 'sameVolumeAtomicRename'
    ) -Message $message
    $operationId = Assert-DysonNodeRuntimeOperationId -OperationId ([string]$Intent.operationId)
    $paths = Get-DysonNodeRuntimeOperationPaths -Storage $Storage -OperationId $operationId
    if ([string]$Intent.protocol -cne $script:DysonNodeRuntimeIntentProtocol -or
        [int]$Intent.schemaVersion -ne $script:DysonNodeRuntimeTransactionSchemaVersion -or
        [string]$Intent.state -cne 'prepared' -or $Intent.previousRuntimePresent -isnot [bool] -or
        $Intent.sameVolumeAtomicRename -isnot [bool] -or -not [bool]$Intent.sameVolumeAtomicRename -or
        [string]$Intent.createdAt -notmatch '^\d{4}-\d{2}-\d{2}T' -or
        [string]$Intent.runtimeRootIdentity -cne (Get-DysonNodeRuntimePathIdentityDigest $Storage.runtimeRoot) -or
        [string]$Intent.runtimeContainerIdentity -cne (Get-DysonNodeRuntimePathIdentityDigest $Storage.runtimeContainer) -or
        [string]$Intent.transactionRootIdentity -cne (Get-DysonNodeRuntimePathIdentityDigest $Storage.transactionRoot) -or
        [string]$Intent.stageRootIdentity -cne (Get-DysonNodeRuntimePathIdentityDigest $paths.stageRoot) -or
        [string]$Intent.backupRootIdentity -cne (Get-DysonNodeRuntimePathIdentityDigest $paths.backupRoot)) {
        throw $message
    }
    Assert-DysonRelativePath -Path ([string]$Intent.nodeRelativePath) -Name 'NodeRelativePath'
    [void](Assert-DysonNodeRuntimeHash -ExpectedNodeSha256 ([string]$Intent.archiveSha256) -Name 'ArchiveSha256')
    [void](Assert-DysonNodeRuntimeHash -ExpectedNodeSha256 ([string]$Intent.candidateNodeExecutableSha256) `
        -Name 'CandidateNodeSha256')
    if ([bool]$Intent.previousRuntimePresent) {
        [void](Assert-DysonNodeRuntimeHash -ExpectedNodeSha256 ([string]$Intent.previousNodeExecutableSha256) `
            -Name 'PreviousNodeSha256')
    }
    elseif ($null -ne $Intent.previousNodeExecutableSha256) { throw $message }
    return $Intent
}

function New-DysonNodeRuntimeCandidateMarker {
    param(
        [Parameter(Mandatory)][string]$StageRoot,
        [Parameter(Mandatory)]$Intent
    )

    $marker = [ordered]@{
        protocol = $script:DysonNodeRuntimeCandidateProtocol
        schemaVersion = 1
        operationId = [string]$Intent.operationId
        runtimeRootIdentity = [string]$Intent.runtimeRootIdentity
        stageRootIdentity = [string]$Intent.stageRootIdentity
        nodeRelativePath = [string]$Intent.nodeRelativePath
        archiveSha256 = [string]$Intent.archiveSha256
        nodeExecutableSha256 = [string]$Intent.candidateNodeExecutableSha256
    }
    $path = Join-Path $StageRoot $script:DysonNodeRuntimeCandidateMarkerName
    $ioPath = ConvertTo-DysonDeploymentExtendedPath -Path $path
    if ([System.IO.File]::Exists($ioPath) -or [System.IO.Directory]::Exists($ioPath)) {
        throw 'The Node.js runtime candidate marker already exists.'
    }
    $json = $marker | ConvertTo-Json -Depth 4 -Compress
    $stream = [System.IO.File]::Open(
        $ioPath, [System.IO.FileMode]::CreateNew, [System.IO.FileAccess]::Write,
        [System.IO.FileShare]::None
    )
    try {
        $bytes = [System.Text.UTF8Encoding]::new($false, $true).GetBytes($json)
        $stream.Write($bytes, 0, $bytes.Length)
        $stream.Flush($true)
    }
    finally { $stream.Dispose() }
}

function Read-DysonNodeRuntimeCandidateMarker {
    param([Parameter(Mandatory)][string]$TreeRoot)

    $path = Join-Path $TreeRoot $script:DysonNodeRuntimeCandidateMarkerName
    $ioPath = ConvertTo-DysonDeploymentExtendedPath -Path $path
    if (-not [System.IO.File]::Exists($ioPath)) { return $null }
    $attributes = [System.IO.File]::GetAttributes($ioPath)
    $fileInfo = [System.IO.FileInfo]::new($ioPath)
    if (($attributes -band [System.IO.FileAttributes]::Directory) -or
        ($attributes -band [System.IO.FileAttributes]::ReparsePoint) -or
        $fileInfo.Length -lt 2 -or $fileInfo.Length -gt 8192) {
        throw 'The Node.js runtime candidate marker is invalid.'
    }
    try { $marker = [System.IO.File]::ReadAllText($ioPath, [System.Text.Encoding]::UTF8) | ConvertFrom-Json -ErrorAction Stop }
    catch { throw 'The Node.js runtime candidate marker is invalid.' }
    Assert-DysonNodeRuntimeExactProperties -Value $marker -Expected @(
        'protocol', 'schemaVersion', 'operationId', 'runtimeRootIdentity',
        'stageRootIdentity', 'nodeRelativePath', 'archiveSha256', 'nodeExecutableSha256'
    ) -Message 'The Node.js runtime candidate marker is invalid.'
    if ([string]$marker.protocol -cne $script:DysonNodeRuntimeCandidateProtocol -or
        [int]$marker.schemaVersion -ne 1) {
        throw 'The Node.js runtime candidate marker is invalid.'
    }
    [void](Assert-DysonNodeRuntimeOperationId -OperationId ([string]$marker.operationId))
    return $marker
}

function Test-DysonNodeRuntimeOwnedCandidate {
    param(
        [Parameter(Mandatory)][string]$TreeRoot,
        [Parameter(Mandatory)]$Intent
    )

    $marker = Read-DysonNodeRuntimeCandidateMarker -TreeRoot $TreeRoot
    if ($null -eq $marker) { return $false }
    return [string]$marker.operationId -ceq [string]$Intent.operationId
}

function Assert-DysonNodeRuntimeOwnedCandidate {
    param(
        [Parameter(Mandatory)][string]$TreeRoot,
        [Parameter(Mandatory)][ValidateSet('stage', 'runtime')][string]$Location,
        [Parameter(Mandatory)]$Intent,
        [Parameter(Mandatory)]$Storage,
        [Parameter(Mandatory)][string]$InstallRoot,
        [Parameter(Mandatory)][string]$DataRoot,
        [switch]$AllowIncompleteStage
    )

    $marker = Read-DysonNodeRuntimeCandidateMarker -TreeRoot $TreeRoot
    $expectedIdentity = if ($Location -eq 'stage') {
        [string]$Intent.stageRootIdentity
    }
    else { [string]$Intent.runtimeRootIdentity }
    if ($null -eq $marker -or [string]$marker.operationId -cne [string]$Intent.operationId -or
        [string]$marker.runtimeRootIdentity -cne [string]$Intent.runtimeRootIdentity -or
        [string]$marker.stageRootIdentity -cne [string]$Intent.stageRootIdentity -or
        [string]$marker.nodeRelativePath -cne [string]$Intent.nodeRelativePath -or
        [string]$marker.archiveSha256 -cne [string]$Intent.archiveSha256 -or
        [string]$marker.nodeExecutableSha256 -cne [string]$Intent.candidateNodeExecutableSha256 -or
        (Get-DysonNodeRuntimePathIdentityDigest -Path $TreeRoot) -cne $expectedIdentity) {
        throw 'A Node.js runtime candidate is not owned by the current operation.'
    }
    if ($AllowIncompleteStage) {
        if ($Location -cne 'stage') {
            throw 'Only an operation-owned staging tree may be incomplete.'
        }
        [void](Assert-DysonDeploymentPlainPathChain -Path $TreeRoot)
        $treeItem = Get-Item -LiteralPath $TreeRoot -Force -ErrorAction Stop
        if (-not $treeItem.PSIsContainer -or
            ($treeItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint)) {
            throw 'The operation-owned Node.js runtime staging tree is redirected.'
        }
        Assert-DysonNodeRuntimeAcl -Path $treeItem.FullName -RuntimeRoot $TreeRoot `
            -InstallRoot $InstallRoot -DataRoot $DataRoot
        $markerPath = Join-Path $TreeRoot $script:DysonNodeRuntimeCandidateMarkerName
        Assert-DysonNodeRuntimeAcl -Path $markerPath -RuntimeRoot $TreeRoot `
            -InstallRoot $InstallRoot -DataRoot $DataRoot
        foreach ($entry in @(Get-ChildItem -LiteralPath $TreeRoot -Force -Recurse -ErrorAction Stop)) {
            if ($entry.Attributes -band [System.IO.FileAttributes]::ReparsePoint) {
                throw 'The operation-owned Node.js runtime staging tree contains a redirected entry.'
            }
        }
        return [pscustomobject][ordered]@{
            runtimeRootIdentity = $expectedIdentity
            nodeExecutableSha256 = [string]$Intent.candidateNodeExecutableSha256
            protectedOperationMarker = $true
            complete = $false
        }
    }
    return Assert-DysonNodeRuntimeProtection -RuntimeRoot $TreeRoot `
        -NodeExecutable (Join-Path $TreeRoot ([string]$Intent.nodeRelativePath)) `
        -ExpectedNodeSha256 ([string]$Intent.candidateNodeExecutableSha256) `
        -InstallRoot $InstallRoot -DataRoot $DataRoot
}

function Assert-DysonNodeRuntimePreviousTree {
    param(
        [Parameter(Mandatory)][string]$TreeRoot,
        [Parameter(Mandatory)]$Intent,
        [Parameter(Mandatory)][string]$InstallRoot,
        [Parameter(Mandatory)][string]$DataRoot
    )

    if (-not [bool]$Intent.previousRuntimePresent) {
        throw 'The Node.js runtime transaction has no previous tree to verify.'
    }
    return Assert-DysonNodeRuntimeProtection -RuntimeRoot $TreeRoot `
        -NodeExecutable (Join-Path $TreeRoot ([string]$Intent.nodeRelativePath)) `
        -ExpectedNodeSha256 ([string]$Intent.previousNodeExecutableSha256) `
        -InstallRoot $InstallRoot -DataRoot $DataRoot
}

function Assert-DysonNodeRuntimeInstalledReceipt {
    param(
        [Parameter(Mandatory)]$Receipt,
        [Parameter(Mandatory)]$Intent
    )

    $message = 'The Node.js runtime completion receipt is invalid.'
    Assert-DysonNodeRuntimeExactProperties -Value $Receipt -Expected @(
        'protocol', 'schemaVersion', 'state', 'operationId', 'completedAt',
        'runtimeRootIdentity', 'archiveSha256', 'nodeExecutableSha256',
        'nodeRuntimeProtected', 'previousRuntimePresent', 'rollbackDefined',
        'sameVolumeAtomicRename'
    ) -Message $message
    if ([string]$Receipt.protocol -cne $script:DysonNodeRuntimeReceiptProtocol -or
        [int]$Receipt.schemaVersion -ne $script:DysonNodeRuntimeTransactionSchemaVersion -or
        [string]$Receipt.state -cne 'installed' -or
        [string]$Receipt.operationId -cne [string]$Intent.operationId -or
        [string]$Receipt.runtimeRootIdentity -cne [string]$Intent.runtimeRootIdentity -or
        [string]$Receipt.archiveSha256 -cne [string]$Intent.archiveSha256 -or
        [string]$Receipt.nodeExecutableSha256 -cne [string]$Intent.candidateNodeExecutableSha256 -or
        $Receipt.nodeRuntimeProtected -isnot [bool] -or -not [bool]$Receipt.nodeRuntimeProtected -or
        $Receipt.previousRuntimePresent -isnot [bool] -or
        [bool]$Receipt.previousRuntimePresent -ne [bool]$Intent.previousRuntimePresent -or
        $Receipt.rollbackDefined -isnot [bool] -or -not [bool]$Receipt.rollbackDefined -or
        $Receipt.sameVolumeAtomicRename -isnot [bool] -or -not [bool]$Receipt.sameVolumeAtomicRename) {
        throw $message
    }
    return $Receipt
}

function New-DysonNodeRuntimeRecoveryReceipt {
    param(
        [Parameter(Mandatory)]$Intent,
        [Parameter(Mandatory)][ValidateSet('recovered-restored', 'recovered-finalized')][string]$State,
        [Parameter(Mandatory)][bool]$RuntimePresent,
        [AllowNull()][AllowEmptyString()][string]$RuntimeNodeSha256,
        [Parameter(Mandatory)][bool]$StageRemoved,
        [Parameter(Mandatory)][bool]$BackupRemoved,
        [Parameter(Mandatory)][bool]$PreviousRuntimeRestored
    )

    if ($RuntimePresent) {
        [void](Assert-DysonNodeRuntimeHash -ExpectedNodeSha256 $RuntimeNodeSha256 `
            -Name 'RuntimeNodeSha256')
    }
    elseif (-not [string]::IsNullOrEmpty($RuntimeNodeSha256)) {
        throw 'A missing recovered runtime cannot carry a Node.js digest.'
    }
    return [ordered]@{
        protocol = $script:DysonNodeRuntimeRecoveryProtocol
        schemaVersion = $script:DysonNodeRuntimeTransactionSchemaVersion
        state = $State
        operationId = [string]$Intent.operationId
        recoveredAt = (Get-Date).ToUniversalTime().ToString('o')
        runtimeRootIdentity = [string]$Intent.runtimeRootIdentity
        candidateNodeExecutableSha256 = [string]$Intent.candidateNodeExecutableSha256
        previousRuntimePresent = [bool]$Intent.previousRuntimePresent
        previousNodeExecutableSha256 = if ([bool]$Intent.previousRuntimePresent) {
            [string]$Intent.previousNodeExecutableSha256
        }
        else { $null }
        runtimePresent = $RuntimePresent
        runtimeNodeExecutableSha256 = if ($RuntimePresent) { $RuntimeNodeSha256 } else { $null }
        stageRemoved = $StageRemoved
        backupRemoved = $BackupRemoved
        previousRuntimeRestored = $PreviousRuntimeRestored
        recoveryPerformed = $true
    }
}

function Assert-DysonNodeRuntimeRecoveryReceipt {
    param(
        [Parameter(Mandatory)]$Receipt,
        [Parameter(Mandatory)]$Intent
    )

    $message = 'The Node.js runtime recovery receipt is invalid.'
    Assert-DysonNodeRuntimeExactProperties -Value $Receipt -Expected @(
        'protocol', 'schemaVersion', 'state', 'operationId', 'recoveredAt',
        'runtimeRootIdentity', 'candidateNodeExecutableSha256', 'previousRuntimePresent',
        'previousNodeExecutableSha256', 'runtimePresent', 'runtimeNodeExecutableSha256',
        'stageRemoved', 'backupRemoved', 'previousRuntimeRestored', 'recoveryPerformed'
    ) -Message $message
    if ([string]$Receipt.protocol -cne $script:DysonNodeRuntimeRecoveryProtocol -or
        [int]$Receipt.schemaVersion -ne $script:DysonNodeRuntimeTransactionSchemaVersion -or
        [string]$Receipt.state -cnotin @('recovered-restored', 'recovered-finalized') -or
        [string]$Receipt.operationId -cne [string]$Intent.operationId -or
        [string]$Receipt.runtimeRootIdentity -cne [string]$Intent.runtimeRootIdentity -or
        [string]$Receipt.candidateNodeExecutableSha256 -cne [string]$Intent.candidateNodeExecutableSha256 -or
        $Receipt.previousRuntimePresent -isnot [bool] -or
        [bool]$Receipt.previousRuntimePresent -ne [bool]$Intent.previousRuntimePresent -or
        [string]$Receipt.previousNodeExecutableSha256 -cne [string]$Intent.previousNodeExecutableSha256 -or
        $Receipt.runtimePresent -isnot [bool] -or $Receipt.stageRemoved -isnot [bool] -or
        $Receipt.backupRemoved -isnot [bool] -or $Receipt.previousRuntimeRestored -isnot [bool] -or
        $Receipt.recoveryPerformed -isnot [bool] -or -not [bool]$Receipt.recoveryPerformed) {
        throw $message
    }
    if ([bool]$Receipt.runtimePresent) {
        [void](Assert-DysonNodeRuntimeHash -ExpectedNodeSha256 ([string]$Receipt.runtimeNodeExecutableSha256) `
            -Name 'RecoveredNodeSha256')
    }
    elseif ($null -ne $Receipt.runtimeNodeExecutableSha256) { throw $message }
    return $Receipt
}

function Remove-DysonNodeRuntimeOwnedCandidateTree {
    param(
        [Parameter(Mandatory)][string]$TreeRoot,
        [Parameter(Mandatory)][ValidateSet('stage', 'runtime')][string]$Location,
        [Parameter(Mandatory)]$Intent,
        [Parameter(Mandatory)]$Storage,
        [Parameter(Mandatory)][string]$InstallRoot,
        [Parameter(Mandatory)][string]$DataRoot
    )

    [void](Assert-DysonNodeRuntimeOwnedCandidate -TreeRoot $TreeRoot -Location $Location `
        -Intent $Intent -Storage $Storage -InstallRoot $InstallRoot -DataRoot $DataRoot `
        -AllowIncompleteStage:($Location -eq 'stage'))
    [System.IO.Directory]::Delete(
        (ConvertTo-DysonDeploymentExtendedPath -Path $TreeRoot),
        $true
    )
}

function Remove-DysonNodeRuntimeOwnedBackupTree {
    param(
        [Parameter(Mandatory)][string]$BackupRoot,
        [Parameter(Mandatory)]$Intent,
        [Parameter(Mandatory)][string]$InstallRoot,
        [Parameter(Mandatory)][string]$DataRoot
    )

    if ((Get-DysonNodeRuntimePathIdentityDigest -Path $BackupRoot) -cne [string]$Intent.backupRootIdentity) {
        throw 'The Node.js runtime backup path is not owned by the current operation.'
    }
    [void](Assert-DysonNodeRuntimePreviousTree -TreeRoot $BackupRoot -Intent $Intent `
        -InstallRoot $InstallRoot -DataRoot $DataRoot)
    [System.IO.Directory]::Delete(
        (ConvertTo-DysonDeploymentExtendedPath -Path $BackupRoot),
        $true
    )
}

function Invoke-DysonNodeRuntimeIntentRecovery {
    param(
        [Parameter(Mandatory)]$Intent,
        [Parameter(Mandatory)]$Storage,
        [Parameter(Mandatory)][string]$InstallRoot,
        [Parameter(Mandatory)][string]$DataRoot,
        [switch]$AllowSelfTestAdministrator
    )

    $paths = Get-DysonNodeRuntimeOperationPaths -Storage $Storage `
        -OperationId ([string]$Intent.operationId)
    $installedReceipt = $null
    if (Test-DysonNodeRuntimeFileExists -Path ([string]$paths.receiptPath)) {
        $installedReceipt = Read-DysonNodeRuntimeTransactionRecord -Path $paths.receiptPath `
            -Storage $Storage -InstallRoot $InstallRoot -DataRoot $DataRoot
        [void](Assert-DysonNodeRuntimeInstalledReceipt -Receipt $installedReceipt -Intent $Intent)
    }
    $recoveryReceipt = $null
    if (Test-DysonNodeRuntimeFileExists -Path ([string]$paths.recoveryPath)) {
        $recoveryReceipt = Read-DysonNodeRuntimeTransactionRecord -Path $paths.recoveryPath `
            -Storage $Storage -InstallRoot $InstallRoot -DataRoot $DataRoot
        [void](Assert-DysonNodeRuntimeRecoveryReceipt -Receipt $recoveryReceipt -Intent $Intent)
    }
    $stagePresent = Test-DysonNodeRuntimeDirectoryExists -Path ([string]$paths.stageRoot)
    $backupPresent = Test-DysonNodeRuntimeDirectoryExists -Path ([string]$paths.backupRoot)
    if ($null -ne $recoveryReceipt -and -not $stagePresent -and -not $backupPresent) {
        return [pscustomobject][ordered]@{
            operationId = [string]$Intent.operationId
            state = [string]$recoveryReceipt.state
            recovered = $false
            receipt = $recoveryReceipt
        }
    }
    if ($null -ne $installedReceipt) {
        if (-not (Test-DysonNodeRuntimeDirectoryExists -Path ([string]$Storage.runtimeRoot))) {
            throw 'A committed Node.js runtime transaction is missing its candidate runtime.'
        }
        [void](Assert-DysonNodeRuntimeOwnedCandidate -TreeRoot $Storage.runtimeRoot -Location runtime `
            -Intent $Intent -Storage $Storage -InstallRoot $InstallRoot -DataRoot $DataRoot)
        if ($stagePresent) {
            Remove-DysonNodeRuntimeOwnedCandidateTree -TreeRoot $paths.stageRoot -Location stage `
                -Intent $Intent -Storage $Storage -InstallRoot $InstallRoot -DataRoot $DataRoot
        }
        if ($backupPresent) {
            Remove-DysonNodeRuntimeOwnedBackupTree -BackupRoot $paths.backupRoot -Intent $Intent `
                -InstallRoot $InstallRoot -DataRoot $DataRoot
        }
        if ($null -eq $recoveryReceipt) {
            $recoveryReceipt = New-DysonNodeRuntimeRecoveryReceipt -Intent $Intent `
                -State recovered-finalized -RuntimePresent $true `
                -RuntimeNodeSha256 ([string]$Intent.candidateNodeExecutableSha256) `
                -StageRemoved $true -BackupRemoved $true -PreviousRuntimeRestored $false
            Write-DysonNodeRuntimeTransactionRecordCreateNew -Path $paths.recoveryPath `
                -Value $recoveryReceipt -Storage $Storage -InstallRoot $InstallRoot -DataRoot $DataRoot `
                -AllowSelfTestAdministrator:$AllowSelfTestAdministrator
        }
        return [pscustomobject][ordered]@{
            operationId = [string]$Intent.operationId
            state = 'recovered-finalized'
            recovered = $true
            receipt = $recoveryReceipt
        }
    }

    if ($stagePresent) {
        Remove-DysonNodeRuntimeOwnedCandidateTree -TreeRoot $paths.stageRoot -Location stage `
            -Intent $Intent -Storage $Storage -InstallRoot $InstallRoot -DataRoot $DataRoot
    }
    $runtimePresent = Test-DysonNodeRuntimeDirectoryExists -Path ([string]$Storage.runtimeRoot)
    if ($runtimePresent -and
        (Test-DysonNodeRuntimeOwnedCandidate -TreeRoot $Storage.runtimeRoot -Intent $Intent)) {
        Remove-DysonNodeRuntimeOwnedCandidateTree -TreeRoot $Storage.runtimeRoot -Location runtime `
            -Intent $Intent -Storage $Storage -InstallRoot $InstallRoot -DataRoot $DataRoot
        $runtimePresent = $false
    }
    elseif ($runtimePresent) {
        if (-not [bool]$Intent.previousRuntimePresent) {
            throw 'Recovery refused to remove or reinterpret an unowned Node.js RuntimeRoot.'
        }
        [void](Assert-DysonNodeRuntimePreviousTree -TreeRoot $Storage.runtimeRoot -Intent $Intent `
            -InstallRoot $InstallRoot -DataRoot $DataRoot)
    }
    $previousRestored = $false
    if ($backupPresent) {
        if ($runtimePresent) {
            throw 'Node.js runtime recovery found both a previous runtime and its operation backup.'
        }
        if ((Get-DysonNodeRuntimePathIdentityDigest -Path $paths.backupRoot) -cne
            [string]$Intent.backupRootIdentity) {
            throw 'The Node.js runtime backup path is not owned by the interrupted operation.'
        }
        [void](Assert-DysonNodeRuntimePreviousTree -TreeRoot $paths.backupRoot -Intent $Intent `
            -InstallRoot $InstallRoot -DataRoot $DataRoot)
        [System.IO.Directory]::Move([string]$paths.backupRoot, [string]$Storage.runtimeRoot)
        [void](Assert-DysonNodeRuntimePreviousTree -TreeRoot $Storage.runtimeRoot -Intent $Intent `
            -InstallRoot $InstallRoot -DataRoot $DataRoot)
        $runtimePresent = $true
        $previousRestored = $true
    }
    if ([bool]$Intent.previousRuntimePresent) {
        if (-not $runtimePresent) {
            throw 'Node.js runtime recovery could not restore the verified previous runtime.'
        }
        [void](Assert-DysonNodeRuntimePreviousTree -TreeRoot $Storage.runtimeRoot -Intent $Intent `
            -InstallRoot $InstallRoot -DataRoot $DataRoot)
        $runtimeHash = [string]$Intent.previousNodeExecutableSha256
    }
    else {
        if ($runtimePresent) {
            throw 'Node.js runtime recovery refused an unexpected RuntimeRoot.'
        }
        $runtimeHash = $null
    }
    if ($null -eq $recoveryReceipt) {
        $recoveryReceipt = New-DysonNodeRuntimeRecoveryReceipt -Intent $Intent `
            -State recovered-restored -RuntimePresent $runtimePresent -RuntimeNodeSha256 $runtimeHash `
            -StageRemoved $true -BackupRemoved $true -PreviousRuntimeRestored $previousRestored
        Write-DysonNodeRuntimeTransactionRecordCreateNew -Path $paths.recoveryPath `
            -Value $recoveryReceipt -Storage $Storage -InstallRoot $InstallRoot -DataRoot $DataRoot `
            -AllowSelfTestAdministrator:$AllowSelfTestAdministrator
    }
    return [pscustomobject][ordered]@{
        operationId = [string]$Intent.operationId
        state = 'recovered-restored'
        recovered = $true
        receipt = $recoveryReceipt
    }
}

function Invoke-DysonNodeRuntimeTransactionRecovery {
    param(
        [Parameter(Mandatory)]$Storage,
        [Parameter(Mandatory)][string]$InstallRoot,
        [Parameter(Mandatory)][string]$DataRoot,
        [switch]$AllowSelfTestAdministrator
    )

    foreach ($root in @($Storage.intentsRoot, $Storage.receiptsRoot, $Storage.recoveriesRoot)) {
        foreach ($entry in @(Get-ChildItem -LiteralPath $root -Force -ErrorAction Stop)) {
            if ($entry.PSIsContainer -or $entry.Name -cnotmatch '^[0-9a-f]{32}\.json$') {
                throw 'The Node.js runtime transaction store contains an unsupported entry.'
            }
        }
    }
    $intentFiles = @(Get-ChildItem -LiteralPath $Storage.intentsRoot -Filter '*.json' -File -Force `
        -ErrorAction Stop | Sort-Object Name)
    $intentIds = [System.Collections.Generic.HashSet[string]]::new(
        [System.StringComparer]::Ordinal
    )
    $results = [System.Collections.Generic.List[object]]::new()
    foreach ($file in $intentFiles) {
        $operationId = [System.IO.Path]::GetFileNameWithoutExtension($file.Name)
        [void](Assert-DysonNodeRuntimeOperationId -OperationId $operationId)
        [void]$intentIds.Add($operationId)
        $intent = Read-DysonNodeRuntimeTransactionRecord -Path $file.FullName -Storage $Storage `
            -InstallRoot $InstallRoot -DataRoot $DataRoot
        [void](Assert-DysonNodeRuntimeIntentRecord -Intent $intent -Storage $Storage)
        if ([string]$intent.operationId -cne $operationId) {
            throw 'A Node.js runtime intent filename does not match its operation identifier.'
        }
        $paths = Get-DysonNodeRuntimeOperationPaths -Storage $Storage -OperationId $operationId
        $hasReceipt = Test-DysonNodeRuntimeFileExists -Path $paths.receiptPath
        $hasRecovery = Test-DysonNodeRuntimeFileExists -Path $paths.recoveryPath
        $hasResidual = (Test-DysonNodeRuntimeDirectoryExists -Path $paths.stageRoot) -or
            (Test-DysonNodeRuntimeDirectoryExists -Path $paths.backupRoot)
        if (-not $hasReceipt -or $hasRecovery -or $hasResidual) {
            $results.Add((Invoke-DysonNodeRuntimeIntentRecovery -Intent $intent -Storage $Storage `
                -InstallRoot $InstallRoot -DataRoot $DataRoot `
                -AllowSelfTestAdministrator:$AllowSelfTestAdministrator))
        }
        else {
            $receipt = Read-DysonNodeRuntimeTransactionRecord -Path $paths.receiptPath `
                -Storage $Storage -InstallRoot $InstallRoot -DataRoot $DataRoot
            [void](Assert-DysonNodeRuntimeInstalledReceipt -Receipt $receipt -Intent $intent)
        }
    }
    foreach ($root in @($Storage.receiptsRoot, $Storage.recoveriesRoot)) {
        foreach ($file in @(Get-ChildItem -LiteralPath $root -Filter '*.json' -File -Force -ErrorAction Stop)) {
            $operationId = [System.IO.Path]::GetFileNameWithoutExtension($file.Name)
            if (-not $intentIds.Contains($operationId)) {
                throw 'The Node.js runtime transaction store contains an orphaned receipt.'
            }
        }
    }
    return @($results)
}
