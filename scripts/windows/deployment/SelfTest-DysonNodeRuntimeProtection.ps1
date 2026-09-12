[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
. (Join-Path $PSScriptRoot 'DysonDeployment.Common.ps1')
. (Join-Path $PSScriptRoot 'DysonNodeRuntime.Transaction.ps1')

function Assert-NodeRuntimeSelfTest {
    param([Parameter(Mandatory)][bool]$Condition, [Parameter(Mandatory)][string]$Message)
    if (-not $Condition) { throw "NODE_RUNTIME_SELFTEST_FAILED: $Message" }
}

function Test-NodeRuntimeSelfTestRejected {
    param([Parameter(Mandatory)][scriptblock]$Operation)
    try { & $Operation | Out-Null; return $false }
    catch { return $true }
}

function Copy-ProtectedNodeRuntimeFixture {
    param(
        [Parameter(Mandatory)][string]$SourceNode,
        [Parameter(Mandatory)][string]$DestinationRoot
    )
    $nodePath = Join-Path $DestinationRoot 'bin\node.exe'
    [void][System.IO.Directory]::CreateDirectory([System.IO.Path]::GetDirectoryName($nodePath))
    [System.IO.File]::Copy($SourceNode, $nodePath, $true)
    Set-DysonNodeRuntimeProtectionAcl -RuntimeRoot $DestinationRoot `
        -InstallRoot $script:fixtureInstallRoot -DataRoot $script:fixtureDataRoot `
        -AllowSelfTestAdministrator
    return $nodePath
}

function Add-NodeRuntimeFixtureAllowRule {
    param(
        [Parameter(Mandatory)][string]$Path,
        [Parameter(Mandatory)][string]$Sid,
        [Parameter(Mandatory)][System.Security.AccessControl.FileSystemRights]$Rights
    )
    $acl = Microsoft.PowerShell.Security\Get-Acl -LiteralPath $Path -ErrorAction Stop
    $acl.AddAccessRule([System.Security.AccessControl.FileSystemAccessRule]::new(
        [System.Security.Principal.SecurityIdentifier]::new($Sid),
        $Rights,
        [System.Security.AccessControl.AccessControlType]::Allow
    ))
    $item = Get-Item -LiteralPath $Path -Force -ErrorAction Stop
    if ($item.PSIsContainer) {
        [System.IO.Directory]::SetAccessControl($item.FullName, $acl)
    }
    else { [System.IO.File]::SetAccessControl($item.FullName, $acl) }
}

function New-NodeRuntimeFixtureArchive {
    param(
        [Parameter(Mandatory)][string]$SourceNode,
        [Parameter(Mandatory)][string]$ArchivePath
    )
    Add-Type -AssemblyName System.IO.Compression -ErrorAction Stop
    Add-Type -AssemblyName System.IO.Compression.FileSystem -ErrorAction Stop
    $archive = [System.IO.Compression.ZipFile]::Open(
        $ArchivePath,
        [System.IO.Compression.ZipArchiveMode]::Create
    )
    try {
        [void][System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile(
            $archive,
            $SourceNode,
            'bin/node.exe',
            [System.IO.Compression.CompressionLevel]::Optimal
        )
    }
    finally { $archive.Dispose() }
}

function ConvertTo-NodeRuntimeSelfTestCommandLine {
    param([Parameter(Mandatory)][string[]]$Arguments)

    return [string]::Join(' ', @($Arguments | ForEach-Object {
        if ($_ -match '["\s]') { '"' + $_.Replace('"', '\"') + '"' }
        else { $_ }
    }))
}

function Start-NodeRuntimeInstallerChild {
    param(
        [Parameter(Mandatory)][string]$Archive,
        [Parameter(Mandatory)][string]$ArchiveSha256,
        [Parameter(Mandatory)][string]$RuntimeRoot,
        [Parameter(Mandatory)][string]$NodeSha256,
        [string]$PreviousNodeSha256,
        [string]$PausePoint,
        [string]$PauseMarker,
        [Parameter(Mandatory)][string]$OutputPath,
        [Parameter(Mandatory)][string]$ErrorPath
    )

    $quote = {
        param([string]$Value)
        return "'" + $Value.Replace("'", "''") + "'"
    }
    $command = [System.Collections.Generic.List[string]]::new()
    $command.Add('& ' + (& $quote (Join-Path $PSScriptRoot 'Install-DysonNodeRuntime.ps1')))
    foreach ($argument in @(
        @('-RuntimeArchive', $Archive), @('-ExpectedArchiveSha256', $ArchiveSha256),
        @('-RuntimeRoot', $RuntimeRoot), @('-NodeRelativePath', 'bin\node.exe'),
        @('-ExpectedNodeSha256', $NodeSha256), @('-InstallRoot', $script:fixtureInstallRoot),
        @('-DataRoot', $script:fixtureDataRoot), @('-LeaseTimeoutSeconds', '60')
    )) {
        $command.Add(([string]$argument[0]) + ' ' + (& $quote ([string]$argument[1])))
    }
    $command.Add('-SelfTestAllowCurrentUserAsAdministrator')
    if (-not [string]::IsNullOrWhiteSpace($PreviousNodeSha256)) {
        $command.Add('-PreviousExpectedNodeSha256 ' + (& $quote $PreviousNodeSha256))
    }
    if (-not [string]::IsNullOrWhiteSpace($PausePoint)) {
        $command.Add('-SelfTestPausePoint ' + (& $quote $PausePoint))
        $command.Add('-SelfTestPauseMarker ' + (& $quote $PauseMarker))
    }
    $command.Add('-Confirm:$false')
    $encodedCommand = [Convert]::ToBase64String(
        [System.Text.Encoding]::Unicode.GetBytes([string]::Join(' ', $command))
    )
    $startInfo = [System.Diagnostics.ProcessStartInfo]::new()
    $startInfo.FileName = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
    $startInfo.Arguments = '-NoLogo -NoProfile -ExecutionPolicy Bypass -EncodedCommand ' + $encodedCommand
    $startInfo.UseShellExecute = $false
    $startInfo.CreateNoWindow = $true
    $startInfo.RedirectStandardOutput = $true
    $startInfo.RedirectStandardError = $true
    $process = [System.Diagnostics.Process]::new()
    $process.StartInfo = $startInfo
    if (-not $process.Start()) { throw 'NODE_RUNTIME_SELFTEST_FAILED: child installer did not start' }
    $process | Add-Member -NotePropertyName SelfTestOutputPath -NotePropertyValue $OutputPath
    $process | Add-Member -NotePropertyName SelfTestErrorPath -NotePropertyValue $ErrorPath
    return $process
}

function Complete-NodeRuntimeSelfTestChild {
    param(
        [Parameter(Mandatory)][System.Diagnostics.Process]$Process,
        [ValidateRange(1, 120)][int]$TimeoutSeconds = 60
    )

    if (-not $Process.WaitForExit($TimeoutSeconds * 1000)) {
        try { $Process.Kill() } catch { }
        throw 'NODE_RUNTIME_SELFTEST_FAILED: child installer timed out'
    }
    $stdout = $Process.StandardOutput.ReadToEnd()
    $stderr = $Process.StandardError.ReadToEnd()
    [System.IO.File]::WriteAllText(
        [string]$Process.SelfTestOutputPath, $stdout, [System.Text.UTF8Encoding]::new($false)
    )
    [System.IO.File]::WriteAllText(
        [string]$Process.SelfTestErrorPath, $stderr, [System.Text.UTF8Encoding]::new($false)
    )
    return [pscustomobject][ordered]@{
        exitCode = [int]$Process.ExitCode
        stdout = $stdout
        stderr = $stderr
    }
}

function Wait-NodeRuntimeSelfTestPauseReady {
    param(
        [Parameter(Mandatory)][System.Diagnostics.Process]$Process,
        [Parameter(Mandatory)][string]$PauseMarker,
        [ValidateRange(1, 60)][int]$TimeoutSeconds = 30
    )

    $readyPath = $PauseMarker + '.ready'
    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    while (-not (Test-Path -LiteralPath $readyPath -PathType Leaf)) {
        if ($Process.HasExited) {
            $stderr = $Process.StandardError.ReadToEnd()
            throw "NODE_RUNTIME_SELFTEST_FAILED: child exited before pause: $stderr"
        }
        if ((Get-Date) -ge $deadline) {
            throw 'NODE_RUNTIME_SELFTEST_FAILED: child did not reach its pause boundary'
        }
        Start-Sleep -Milliseconds 100
    }
}

function Install-NodeRuntimeSelfTestBaseline {
    param(
        [Parameter(Mandatory)][string]$RuntimeRoot,
        [Parameter(Mandatory)][string]$Archive,
        [Parameter(Mandatory)][string]$ArchiveSha256,
        [Parameter(Mandatory)][string]$NodeSha256
    )

    & (Join-Path $PSScriptRoot 'Install-DysonNodeRuntime.ps1') `
        -RuntimeArchive $Archive -ExpectedArchiveSha256 $ArchiveSha256 `
        -RuntimeRoot $RuntimeRoot -NodeRelativePath 'bin\node.exe' `
        -ExpectedNodeSha256 $NodeSha256 -InstallRoot $script:fixtureInstallRoot `
        -DataRoot $script:fixtureDataRoot -SelfTestAllowCurrentUserAsAdministrator `
        -Confirm:$false | Out-Null
}

$temporaryBase = [System.IO.Path]::GetFullPath([System.IO.Path]::GetTempPath()).TrimEnd('\', '/')
$testRoot = Join-Path $temporaryBase ('dyson-control-deployment-selftest-' + [guid]::NewGuid().ToString('N'))
$script:fixtureInstallRoot = Join-Path $testRoot 'program-files\DysonControl'
$script:fixtureDataRoot = Join-Path $testRoot 'program-data\DysonControl'
$runtimeRoot = Join-Path $testRoot 'runtime\node-current'
$archivePath = Join-Path $testRoot 'node-runtime.zip'
$junctionPath = $null
$childProcesses = [System.Collections.Generic.List[System.Diagnostics.Process]]::new()

try {
    foreach ($directory in @(
        $testRoot,
        [System.IO.Path]::GetDirectoryName($script:fixtureInstallRoot),
        [System.IO.Path]::GetDirectoryName($script:fixtureDataRoot),
        $script:fixtureInstallRoot,
        $script:fixtureDataRoot
    )) { [void][System.IO.Directory]::CreateDirectory($directory) }
    [System.Environment]::SetEnvironmentVariable(
        'DYSON_DEPLOYMENT_ALLOW_SELFTEST_TASKS', 'true', 'Process'
    )
    Assert-DysonDeploymentTaskSelfTestScope `
        -InstallRoot $script:fixtureInstallRoot -DataRoot $script:fixtureDataRoot

    $nodeCommand = Get-Command node.exe -ErrorAction SilentlyContinue
    if (-not $nodeCommand) { $nodeCommand = Get-Command node -ErrorAction Stop }
    $sourceNode = [System.IO.Path]::GetFullPath([string]$nodeCommand.Source)
    $sourceNodeSha256 = Get-DysonFileSha256 -Path $sourceNode
    New-NodeRuntimeFixtureArchive -SourceNode $sourceNode -ArchivePath $archivePath
    $archiveSha256 = Get-DysonFileSha256 -Path $archivePath

    $preview = & (Join-Path $PSScriptRoot 'Install-DysonNodeRuntime.ps1') `
        -RuntimeArchive $archivePath -ExpectedArchiveSha256 $archiveSha256 `
        -RuntimeRoot $runtimeRoot -NodeRelativePath 'bin\node.exe' `
        -ExpectedNodeSha256 $sourceNodeSha256 -InstallRoot $script:fixtureInstallRoot `
        -DataRoot $script:fixtureDataRoot -WhatIf 6>$null
    $previewReceipt = ($preview | Out-String).Trim() | ConvertFrom-Json -ErrorAction Stop
    Assert-NodeRuntimeSelfTest -Condition (
        [string]$previewReceipt.state -ceq 'preview' -and
        -not (Test-Path -LiteralPath $runtimeRoot)
    ) -Message 'runtime installer WhatIf mutated the fixture'

    $installOutput = & (Join-Path $PSScriptRoot 'Install-DysonNodeRuntime.ps1') `
        -RuntimeArchive $archivePath -ExpectedArchiveSha256 $archiveSha256 `
        -RuntimeRoot $runtimeRoot -NodeRelativePath 'bin\node.exe' `
        -ExpectedNodeSha256 $sourceNodeSha256 -InstallRoot $script:fixtureInstallRoot `
        -DataRoot $script:fixtureDataRoot -SelfTestAllowCurrentUserAsAdministrator -Confirm:$false
    $installReceipt = ($installOutput | Out-String).Trim() | ConvertFrom-Json -ErrorAction Stop
    $nodePath = Join-Path $runtimeRoot 'bin\node.exe'
    $minimumMajor = [int](([string](& $sourceNode '--version')).Trim().Split('.')[0].TrimStart('v'))
    $validRuntime = Test-DysonNodeRuntime -RuntimeRoot $runtimeRoot -NodeExecutable $nodePath `
        -ExpectedNodeSha256 $sourceNodeSha256 -InstallRoot $script:fixtureInstallRoot `
        -DataRoot $script:fixtureDataRoot -MinimumMajor $minimumMajor
    Assert-NodeRuntimeSelfTest -Condition (
        [string]$installReceipt.state -ceq 'installed' -and
        [bool]$installReceipt.nodeRuntimeProtected -and
        [string]$validRuntime.nodeExecutableSha256 -ceq $sourceNodeSha256
    ) -Message 'a valid isolated runtime fixture was not installed and accepted'

    $underDataRoot = Join-Path $script:fixtureDataRoot 'forbidden-runtime'
    $underDataNode = Copy-ProtectedNodeRuntimeFixture -SourceNode $sourceNode -DestinationRoot $underDataRoot
    Assert-NodeRuntimeSelfTest -Condition (Test-NodeRuntimeSelfTestRejected {
        Assert-DysonNodeRuntimeProtection -RuntimeRoot $underDataRoot -NodeExecutable $underDataNode `
            -ExpectedNodeSha256 $sourceNodeSha256 -InstallRoot $script:fixtureInstallRoot `
            -DataRoot $script:fixtureDataRoot
    }) -Message 'a Node executable below DataRoot was accepted'

    Assert-NodeRuntimeSelfTest -Condition (Test-NodeRuntimeSelfTestRejected {
        Assert-DysonNodeRuntimeProtection -RuntimeRoot $runtimeRoot -NodeExecutable $nodePath `
            -ExpectedNodeSha256 ([string]::new([char]'0', 64)) `
            -InstallRoot $script:fixtureInstallRoot -DataRoot $script:fixtureDataRoot
    }) -Message 'an incorrect expected Node digest was accepted'

    $changedRoot = Join-Path $testRoot 'runtime\same-version-changed-bytes'
    $changedNode = Copy-ProtectedNodeRuntimeFixture -SourceNode $sourceNode -DestinationRoot $changedRoot
    $append = [System.IO.File]::Open(
        $changedNode, [System.IO.FileMode]::Append, [System.IO.FileAccess]::Write,
        [System.IO.FileShare]::None
    )
    try { $append.WriteByte(0) } finally { $append.Dispose() }
    Set-DysonNodeRuntimeProtectionAcl -RuntimeRoot $changedRoot `
        -InstallRoot $script:fixtureInstallRoot -DataRoot $script:fixtureDataRoot `
        -AllowSelfTestAdministrator
    Assert-NodeRuntimeSelfTest -Condition (Test-NodeRuntimeSelfTestRejected {
        Assert-DysonNodeRuntimeProtection -RuntimeRoot $changedRoot -NodeExecutable $changedNode `
            -ExpectedNodeSha256 $sourceNodeSha256 -InstallRoot $script:fixtureInstallRoot `
            -DataRoot $script:fixtureDataRoot
    }) -Message 'a same-version runtime with changed bytes was accepted'

    $writableRoot = Join-Path $testRoot 'runtime\writable-ancestor'
    $writableNode = Copy-ProtectedNodeRuntimeFixture -SourceNode $sourceNode -DestinationRoot $writableRoot
    Add-NodeRuntimeFixtureAllowRule -Path (Split-Path -Parent $writableNode) -Sid 'S-1-1-0' `
        -Rights ([System.Security.AccessControl.FileSystemRights]::WriteData)
    Assert-NodeRuntimeSelfTest -Condition (Test-NodeRuntimeSelfTestRejected {
        Assert-DysonNodeRuntimeProtection -RuntimeRoot $writableRoot -NodeExecutable $writableNode `
            -ExpectedNodeSha256 $sourceNodeSha256 -InstallRoot $script:fixtureInstallRoot `
            -DataRoot $script:fixtureDataRoot
    }) -Message 'a runtime with a broadly writable Node ancestor was accepted'

    $localServiceWriteRoot = Join-Path $testRoot 'runtime\local-service-write'
    $localServiceWriteNode = Copy-ProtectedNodeRuntimeFixture `
        -SourceNode $sourceNode -DestinationRoot $localServiceWriteRoot
    Add-NodeRuntimeFixtureAllowRule -Path $localServiceWriteNode -Sid 'S-1-5-19' `
        -Rights ([System.Security.AccessControl.FileSystemRights]::WriteData)
    Assert-NodeRuntimeSelfTest -Condition (Test-NodeRuntimeSelfTestRejected {
        Assert-DysonNodeRuntimeProtection -RuntimeRoot $localServiceWriteRoot `
            -NodeExecutable $localServiceWriteNode -ExpectedNodeSha256 $sourceNodeSha256 `
            -InstallRoot $script:fixtureInstallRoot -DataRoot $script:fixtureDataRoot
    }) -Message 'LOCAL SERVICE write access to Node was accepted'

    $networkServiceWriteRoot = Join-Path $testRoot 'runtime\network-service-write'
    $networkServiceWriteNode = Copy-ProtectedNodeRuntimeFixture `
        -SourceNode $sourceNode -DestinationRoot $networkServiceWriteRoot
    Add-NodeRuntimeFixtureAllowRule -Path $networkServiceWriteNode -Sid 'S-1-5-20' `
        -Rights ([System.Security.AccessControl.FileSystemRights]::WriteData)
    Assert-NodeRuntimeSelfTest -Condition (Test-NodeRuntimeSelfTestRejected {
        Assert-DysonNodeRuntimeProtection -RuntimeRoot $networkServiceWriteRoot `
            -NodeExecutable $networkServiceWriteNode -ExpectedNodeSha256 $sourceNodeSha256 `
            -InstallRoot $script:fixtureInstallRoot -DataRoot $script:fixtureDataRoot
    }) -Message 'NETWORK SERVICE write access to Node was accepted'

    $unsafeContainer = Join-Path $testRoot 'unsafe-runtime-container'
    $unsafeParentRoot = Join-Path $unsafeContainer 'node-current'
    [void][System.IO.Directory]::CreateDirectory($unsafeContainer)
    Set-DysonNodeRuntimeContainerProtectionAcl -RuntimeContainer $unsafeContainer `
        -RuntimeRoot $unsafeParentRoot -InstallRoot $script:fixtureInstallRoot `
        -DataRoot $script:fixtureDataRoot -AllowSelfTestAdministrator
    $unsafeParentNode = Copy-ProtectedNodeRuntimeFixture -SourceNode $sourceNode `
        -DestinationRoot $unsafeParentRoot
    Add-NodeRuntimeFixtureAllowRule -Path $unsafeContainer -Sid 'S-1-1-0' `
        -Rights ([System.Security.AccessControl.FileSystemRights]::DeleteSubdirectoriesAndFiles)
    Assert-NodeRuntimeSelfTest -Condition (Test-NodeRuntimeSelfTestRejected {
        Assert-DysonNodeRuntimeProtection -RuntimeRoot $unsafeParentRoot `
            -NodeExecutable $unsafeParentNode -ExpectedNodeSha256 $sourceNodeSha256 `
            -InstallRoot $script:fixtureInstallRoot -DataRoot $script:fixtureDataRoot
    }) -Message 'a runtime below a broadly deletable direct parent container was accepted'

    $unsafeServiceContainer = Join-Path $testRoot 'unsafe-service-runtime-container'
    $unsafeServiceRoot = Join-Path $unsafeServiceContainer 'node-current'
    [void][System.IO.Directory]::CreateDirectory($unsafeServiceContainer)
    Set-DysonNodeRuntimeContainerProtectionAcl -RuntimeContainer $unsafeServiceContainer `
        -RuntimeRoot $unsafeServiceRoot -InstallRoot $script:fixtureInstallRoot `
        -DataRoot $script:fixtureDataRoot -AllowSelfTestAdministrator
    $unsafeServiceNode = Copy-ProtectedNodeRuntimeFixture -SourceNode $sourceNode `
        -DestinationRoot $unsafeServiceRoot
    Add-NodeRuntimeFixtureAllowRule -Path $unsafeServiceContainer -Sid 'S-1-5-19' `
        -Rights ([System.Security.AccessControl.FileSystemRights]::Delete)
    Assert-NodeRuntimeSelfTest -Condition (Test-NodeRuntimeSelfTestRejected {
        Assert-DysonNodeRuntimeProtection -RuntimeRoot $unsafeServiceRoot `
            -NodeExecutable $unsafeServiceNode -ExpectedNodeSha256 $sourceNodeSha256 `
            -InstallRoot $script:fixtureInstallRoot -DataRoot $script:fixtureDataRoot
    }) -Message 'a runtime below a service-deletable direct parent container was accepted'

    $junctionTarget = Join-Path $testRoot 'runtime\junction-target'
    $junctionTargetNode = Copy-ProtectedNodeRuntimeFixture -SourceNode $sourceNode `
        -DestinationRoot $junctionTarget
    $junctionParent = Join-Path $testRoot 'runtime\junction-parent'
    [void][System.IO.Directory]::CreateDirectory($junctionParent)
    $junctionPath = Join-Path $junctionParent 'redirected-runtime'
    [void](New-Item -ItemType Junction -Path $junctionPath -Target $junctionTarget -ErrorAction Stop)
    Assert-NodeRuntimeSelfTest -Condition (Test-NodeRuntimeSelfTestRejected {
        Assert-DysonNodeRuntimeProtection -RuntimeRoot $junctionPath `
            -NodeExecutable (Join-Path $junctionPath 'bin\node.exe') `
            -ExpectedNodeSha256 $sourceNodeSha256 -InstallRoot $script:fixtureInstallRoot `
            -DataRoot $script:fixtureDataRoot
    }) -Message 'a reparse-point RuntimeRoot was accepted'
    [System.IO.Directory]::Delete($junctionPath, $false)
    $junctionPath = $null

    $runtimeRootSddlBefore = (Microsoft.PowerShell.Security\Get-Acl -LiteralPath $runtimeRoot).Sddl
    $runtimeNodeSddlBefore = (Microsoft.PowerShell.Security\Get-Acl -LiteralPath $nodePath).Sddl
    $runtimeHashBefore = Get-DysonFileSha256 -Path $nodePath
    Add-NodeRuntimeFixtureAllowRule -Path $script:fixtureDataRoot -Sid 'S-1-1-0' `
        -Rights ([System.Security.AccessControl.FileSystemRights]::FullControl)
    [void](Assert-DysonNodeRuntimeProtection -RuntimeRoot $runtimeRoot -NodeExecutable $nodePath `
        -ExpectedNodeSha256 $sourceNodeSha256 -InstallRoot $script:fixtureInstallRoot `
        -DataRoot $script:fixtureDataRoot)
    Assert-NodeRuntimeSelfTest -Condition (
        (Microsoft.PowerShell.Security\Get-Acl -LiteralPath $runtimeRoot).Sddl -ceq $runtimeRootSddlBefore -and
        (Microsoft.PowerShell.Security\Get-Acl -LiteralPath $nodePath).Sddl -ceq $runtimeNodeSddlBefore -and
        (Get-DysonFileSha256 -Path $nodePath) -ceq $runtimeHashBefore
    ) -Message 'a DataRoot ACL change affected the independent runtime tree'

    $replacementNode = Join-Path $testRoot 'replacement-node.exe'
    [System.IO.File]::Copy($sourceNode, $replacementNode, $true)
    $replacementStream = [System.IO.File]::Open(
        $replacementNode, [System.IO.FileMode]::Append, [System.IO.FileAccess]::Write,
        [System.IO.FileShare]::None
    )
    try { $replacementStream.WriteByte(1) } finally { $replacementStream.Dispose() }
    $replacementHash = Get-DysonFileSha256 -Path $replacementNode
    $replacementArchive = Join-Path $testRoot 'replacement-node-runtime.zip'
    New-NodeRuntimeFixtureArchive -SourceNode $replacementNode -ArchivePath $replacementArchive
    $replacementArchiveHash = Get-DysonFileSha256 -Path $replacementArchive
    $rollbackObserved = $false
    try {
        & (Join-Path $PSScriptRoot 'Install-DysonNodeRuntime.ps1') `
            -RuntimeArchive $replacementArchive -ExpectedArchiveSha256 $replacementArchiveHash `
            -RuntimeRoot $runtimeRoot -NodeRelativePath 'bin\node.exe' `
            -ExpectedNodeSha256 $replacementHash -PreviousExpectedNodeSha256 $sourceNodeSha256 `
            -InstallRoot $script:fixtureInstallRoot -DataRoot $script:fixtureDataRoot `
            -SelfTestAllowCurrentUserAsAdministrator `
            -SelfTestFailurePoint AfterCandidateActivated -Confirm:$false | Out-Null
    }
    catch { $rollbackObserved = [string]$_.Exception.Message -eq 'FICTIONAL_RUNTIME_INSTALL_FAILURE' }
    Assert-NodeRuntimeSelfTest -Condition (
        $rollbackObserved -and
        (Get-DysonFileSha256 -Path $nodePath) -ceq $runtimeHashBefore -and
        (Microsoft.PowerShell.Security\Get-Acl -LiteralPath $runtimeRoot).Sddl -ceq $runtimeRootSddlBefore -and
        (Microsoft.PowerShell.Security\Get-Acl -LiteralPath $nodePath).Sddl -ceq $runtimeNodeSddlBefore
    ) -Message 'a failed runtime replacement did not restore the exact previous runtime'

    $concurrencyRuntimeRoot = Join-Path $testRoot 'concurrency\runtime-container\node-current'
    $concurrencyPause = Join-Path $testRoot 'dyson-node-pause-concurrency-first'
    $concurrencyFirst = Start-NodeRuntimeInstallerChild `
        -Archive $archivePath -ArchiveSha256 $archiveSha256 `
        -RuntimeRoot $concurrencyRuntimeRoot -NodeSha256 $sourceNodeSha256 `
        -PausePoint AfterIntent -PauseMarker $concurrencyPause `
        -OutputPath (Join-Path $testRoot 'concurrency-first.out') `
        -ErrorPath (Join-Path $testRoot 'concurrency-first.err')
    $childProcesses.Add($concurrencyFirst)
    Wait-NodeRuntimeSelfTestPauseReady -Process $concurrencyFirst -PauseMarker $concurrencyPause
    $concurrencySecond = Start-NodeRuntimeInstallerChild `
        -Archive $archivePath -ArchiveSha256 $archiveSha256 `
        -RuntimeRoot $concurrencyRuntimeRoot -NodeSha256 $sourceNodeSha256 `
        -OutputPath (Join-Path $testRoot 'concurrency-second.out') `
        -ErrorPath (Join-Path $testRoot 'concurrency-second.err')
    $childProcesses.Add($concurrencySecond)
    Start-Sleep -Milliseconds 600
    Assert-NodeRuntimeSelfTest -Condition (-not $concurrencySecond.HasExited) `
        -Message 'a concurrent installer did not wait for the exclusive transaction lease'
    [System.IO.File]::WriteAllText(
        ($concurrencyPause + '.release'), 'release', [System.Text.UTF8Encoding]::new($false)
    )
    $concurrencyFirstResult = Complete-NodeRuntimeSelfTestChild -Process $concurrencyFirst
    $concurrencySecondResult = Complete-NodeRuntimeSelfTestChild -Process $concurrencySecond
    $concurrencyNode = Join-Path $concurrencyRuntimeRoot 'bin\node.exe'
    [void](Assert-DysonNodeRuntimeProtection -RuntimeRoot $concurrencyRuntimeRoot `
        -NodeExecutable $concurrencyNode -ExpectedNodeSha256 $sourceNodeSha256 `
        -InstallRoot $script:fixtureInstallRoot -DataRoot $script:fixtureDataRoot)
    Assert-NodeRuntimeSelfTest -Condition (
        $concurrencyFirstResult.exitCode -eq 0 -and
        $concurrencySecondResult.exitCode -ne 0 -and
        $concurrencySecondResult.stderr -match 'PreviousExpectedNodeSha256 is required' -and
        (Get-DysonFileSha256 -Path $concurrencyNode) -ceq $sourceNodeSha256
    ) -Message 'concurrent initial installers could overwrite or remove another operation runtime'

    $crashExpectations = [ordered]@{
        AfterIntent = $sourceNodeSha256
        AfterPreviousMoved = $sourceNodeSha256
        AfterCandidateActivated = $sourceNodeSha256
        AfterReceipt = $replacementHash
    }
    $crashRecoveryStates = @{}
    foreach ($pausePoint in $crashExpectations.Keys) {
        $slug = ([string]$pausePoint).ToLowerInvariant()
        $crashRuntimeRoot = Join-Path $testRoot `
            (('crash-' + $slug) + '\runtime-container\node-current')
        Install-NodeRuntimeSelfTestBaseline -RuntimeRoot $crashRuntimeRoot `
            -Archive $archivePath -ArchiveSha256 $archiveSha256 -NodeSha256 $sourceNodeSha256
        $pauseMarker = Join-Path $testRoot ('dyson-node-pause-crash-' + $slug)
        $child = Start-NodeRuntimeInstallerChild `
            -Archive $replacementArchive -ArchiveSha256 $replacementArchiveHash `
            -RuntimeRoot $crashRuntimeRoot -NodeSha256 $replacementHash `
            -PreviousNodeSha256 $sourceNodeSha256 -PausePoint $pausePoint `
            -PauseMarker $pauseMarker `
            -OutputPath (Join-Path $testRoot ('crash-' + $slug + '.out')) `
            -ErrorPath (Join-Path $testRoot ('crash-' + $slug + '.err'))
        $childProcesses.Add($child)
        Wait-NodeRuntimeSelfTestPauseReady -Process $child -PauseMarker $pauseMarker
        Stop-Process -Id $child.Id -Force -ErrorAction Stop
        $killedResult = Complete-NodeRuntimeSelfTestChild -Process $child
        Assert-NodeRuntimeSelfTest -Condition ($killedResult.exitCode -ne 0) `
            -Message "the $pausePoint crash child did not terminate"

        $repairOutput = & (Join-Path $PSScriptRoot 'Repair-DysonNodeRuntime.ps1') `
            -RuntimeRoot $crashRuntimeRoot -InstallRoot $script:fixtureInstallRoot `
            -DataRoot $script:fixtureDataRoot -SelfTestAllowCurrentUserAsAdministrator `
            -Confirm:$false
        $repairReceipt = ($repairOutput | Out-String).Trim() | ConvertFrom-Json -ErrorAction Stop
        $expectedCrashHash = [string]$crashExpectations[$pausePoint]
        $crashNode = Join-Path $crashRuntimeRoot 'bin\node.exe'
        [void](Assert-DysonNodeRuntimeProtection -RuntimeRoot $crashRuntimeRoot `
            -NodeExecutable $crashNode -ExpectedNodeSha256 $expectedCrashHash `
            -InstallRoot $script:fixtureInstallRoot -DataRoot $script:fixtureDataRoot)
        $transactionStorage = Get-DysonNodeRuntimeTransactionStorage -RuntimeRoot $crashRuntimeRoot
        $operationResidue = @(Get-ChildItem -LiteralPath $transactionStorage.runtimeContainer -Force |
            Where-Object { $_.Name -match '^\.dyson-node-(stage|backup)-[0-9a-f]{32}$' })
        $recoveryText = $repairReceipt.recoveries | ConvertTo-Json -Depth 10 -Compress
        Assert-NodeRuntimeSelfTest -Condition (
            [string]$repairReceipt.state -ceq 'completed' -and
            [int]$repairReceipt.recoveryCount -eq 1 -and
            $operationResidue.Count -eq 0 -and
            (Get-DysonFileSha256 -Path $crashNode) -ceq $expectedCrashHash -and
            $recoveryText -notlike ('*' + $testRoot + '*') -and
            $recoveryText -notmatch 'stageRoot|backupRoot|runtimeContainer'
        ) -Message "the $pausePoint crash boundary was not safely recovered with redacted evidence"
        $crashRecoveryStates[$pausePoint] = [string]$repairReceipt.recoveries[0].state
    }

    [ordered]@{
        protocol = 'DYSON_CONTROL_NODE_RUNTIME_SELFTEST_V1'
        state = 'passed'
        legitimateFixtureAccepted = $true
        dataRootRuntimeRejected = $true
        changedBytesRejected = $true
        wrongHashRejected = $true
        writableAncestorRejected = $true
        reparsePointRejected = $true
        localServiceWriteRejected = $true
        networkServiceWriteRejected = $true
        runtimeContainerBoundaryRejected = $true
        dataRootAclIndependent = $true
        sameVolumeTransactionRollbackValidated = $true
        exclusiveLeaseConcurrencyValidated = $true
        operationOwnedRollbackValidated = $true
        crashAfterIntentRecovered = $crashRecoveryStates.AfterIntent -ceq 'recovered-restored'
        crashAfterPreviousMovedRecovered = $crashRecoveryStates.AfterPreviousMoved -ceq 'recovered-restored'
        crashAfterCandidateActivatedRecovered = $crashRecoveryStates.AfterCandidateActivated -ceq 'recovered-restored'
        crashAfterReceiptFinalized = $crashRecoveryStates.AfterReceipt -ceq 'recovered-finalized'
        productionChanged = $false
    } | ConvertTo-Json -Depth 5 -Compress
}
finally {
    foreach ($childProcess in @($childProcesses)) {
        if ($childProcess -and -not $childProcess.HasExited) {
            try { $childProcess.Kill() } catch { }
        }
        if ($childProcess) { try { $childProcess.Dispose() } catch { } }
    }
    if ($junctionPath -and (Test-Path -LiteralPath $junctionPath)) {
        try { [System.IO.Directory]::Delete($junctionPath, $false) } catch { }
    }
    Remove-Item Env:DYSON_DEPLOYMENT_ALLOW_SELFTEST_TASKS -ErrorAction SilentlyContinue
    Remove-Item Env:DYSON_DEPLOYMENT_SELFTEST_ROOT_IDENTITY -ErrorAction SilentlyContinue
    Remove-Variable -Name DysonDeploymentAuthorizedSelfTestRoots -Scope Global `
        -ErrorAction SilentlyContinue
    $testFull = [System.IO.Path]::GetFullPath($testRoot).TrimEnd('\', '/')
    $expectedPrefix = $temporaryBase + [System.IO.Path]::DirectorySeparatorChar +
        'dyson-control-deployment-selftest-'
    if ($testFull.StartsWith($expectedPrefix, [System.StringComparison]::OrdinalIgnoreCase) -and
        (Test-Path -LiteralPath $testFull)) {
        $cleanupEntries = @((Get-Item -LiteralPath $testFull -Force -ErrorAction Stop)) +
            @(Get-ChildItem -LiteralPath $testFull -Force -Recurse -ErrorAction Stop)
        if (@($cleanupEntries | Where-Object {
            $_.Attributes -band [System.IO.FileAttributes]::ReparsePoint
        }).Count -ne 0) {
            throw 'The isolated Node.js runtime self-test root contains a redirected cleanup entry.'
        }
        [System.IO.Directory]::Delete(
            (ConvertTo-DysonDeploymentExtendedPath -Path $testFull),
            $true
        )
    }
}
