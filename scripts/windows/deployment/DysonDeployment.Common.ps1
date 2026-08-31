Set-StrictMode -Version 2.0

$script:DysonPlatformSecurityModulePath = Join-Path $PSHOME 'Modules\Microsoft.PowerShell.Security\Microsoft.PowerShell.Security.psd1'
if (-not (Test-Path -LiteralPath $script:DysonPlatformSecurityModulePath -PathType Leaf)) {
    throw 'The platform security module required by Dyson Control deployment is unavailable.'
}
$script:DysonPlatformSecurityModules = @(Import-Module -Name $script:DysonPlatformSecurityModulePath -PassThru -ErrorAction Stop)
if ($script:DysonPlatformSecurityModules.Count -ne 1 -or
    -not [string]::Equals(
        [System.IO.Path]::GetFullPath([string]$script:DysonPlatformSecurityModules[0].Path),
        [System.IO.Path]::GetFullPath($script:DysonPlatformSecurityModulePath),
        [System.StringComparison]::OrdinalIgnoreCase
    ) -or
    -not $script:DysonPlatformSecurityModules[0].ExportedCommands.ContainsKey('Get-Acl') -or
    -not $script:DysonPlatformSecurityModules[0].ExportedCommands.ContainsKey('Set-Acl')) {
    throw 'The platform security module required by Dyson Control deployment has an invalid identity.'
}

$script:DysonDeploymentProtocol = 'DYSON_CONTROL_DEPLOYMENT_V1'
$script:DysonReleaseManifestName = 'release-manifest.json'
$script:DysonActivePointerName = 'active-release.json'
$script:DysonArtifactVerifierProtocol = 'DYSON_CONTROL_RELEASE_ARTIFACT_V1'
$script:DysonArtifactVerifierRelativePath = 'scripts\windows\release\Test-DysonControlReleaseArtifact.ps1'
$script:DysonArtifactVerifierCommonRelativePath = 'scripts\windows\release\DysonReleasePackaging.Common.ps1'
$script:DysonControlTaskPath = '\'

function Get-DysonFullPath {
    param([Parameter(Mandatory)][string]$Path)

    if ([string]::IsNullOrWhiteSpace($Path)) { throw 'A deployment path cannot be empty.' }
    if ([System.IO.Path]::IsPathRooted($Path)) { return [System.IO.Path]::GetFullPath($Path) }
    return [System.IO.Path]::GetFullPath((Join-Path (Get-Location).ProviderPath $Path))
}

function Assert-DysonVersion {
    param([Parameter(Mandatory)][string]$Version)

    if ($Version -notmatch '^[0-9A-Za-z][0-9A-Za-z._+-]{0,63}$') {
        throw 'The release version must contain only letters, numbers, dot, underscore, plus, or hyphen.'
    }
}

function Get-DysonNodeMinimumMajor {
    param([Parameter(Mandatory)]$Value)

    try { $major = [int]$Value }
    catch { throw 'The release Node.js runtime requirement is invalid.' }
    if ($major -lt 1 -or $major -gt 999) { throw 'The release Node.js runtime requirement is invalid.' }
    return $major
}

function Resolve-DysonNodeExecutablePath {
    param([Parameter(Mandatory)][string]$NodeExecutable)

    try {
        $resolved = (Resolve-Path -LiteralPath $NodeExecutable -ErrorAction Stop).ProviderPath
        $item = Get-Item -LiteralPath $resolved -Force -ErrorAction Stop
        if ($item.PSIsContainer -or ($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -or
            $item.Length -lt 1 -or $item.Length -gt 536870912) {
            throw 'invalid node executable'
        }
        return $item.FullName
    }
    catch { throw 'Node.js runtime verification failed.' }
}

function Test-DysonNodeRuntime {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][string]$NodeExecutable,
        [Parameter(Mandatory)]$MinimumMajor,
        [ValidateRange(100, 10000)][int]$TimeoutMilliseconds = 3000,
        [ValidateRange(32, 1024)][int]$MaximumOutputCharacters = 128
    )

    $nodePath = Resolve-DysonNodeExecutablePath -NodeExecutable $NodeExecutable
    $requiredMajor = Get-DysonNodeMinimumMajor -Value $MinimumMajor
    $process = $null
    try {
        $startInfo = [System.Diagnostics.ProcessStartInfo]::new()
        $startInfo.FileName = $nodePath
        $startInfo.Arguments = '--version'
        $startInfo.WorkingDirectory = [System.IO.Path]::GetTempPath()
        $startInfo.UseShellExecute = $false
        $startInfo.CreateNoWindow = $true
        $startInfo.RedirectStandardOutput = $true
        $startInfo.RedirectStandardError = $true
        [void]$startInfo.EnvironmentVariables.Remove('NODE_OPTIONS')
        [void]$startInfo.EnvironmentVariables.Remove('NODE_PATH')

        $process = [System.Diagnostics.Process]::new()
        $process.StartInfo = $startInfo
        if (-not $process.Start()) { throw 'node probe did not start' }
        $stdoutTask = $process.StandardOutput.ReadToEndAsync()
        $stderrTask = $process.StandardError.ReadToEndAsync()
        if (-not $process.WaitForExit($TimeoutMilliseconds)) {
            try { $process.Kill() } catch {}
            try { $process.WaitForExit() } catch {}
            throw 'node probe timed out'
        }
        $process.WaitForExit()
        $stdout = [string]$stdoutTask.GetAwaiter().GetResult()
        $stderr = [string]$stderrTask.GetAwaiter().GetResult()
        $exitCode = [int]$process.ExitCode
    }
    catch { throw 'Node.js runtime verification failed.' }
    finally {
        if ($process) { $process.Dispose() }
    }

    if ($stdout.Length -gt $MaximumOutputCharacters -or $stderr.Length -gt $MaximumOutputCharacters -or
        $exitCode -ne 0 -or $stderr.Length -ne 0 -or
        $stdout -notmatch '^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\r?\n?$') {
        throw 'Node.js runtime verification failed.'
    }
    try { $actualMajor = [int]$Matches[1] }
    catch { throw 'Node.js runtime verification failed.' }
    if ($actualMajor -lt $requiredMajor) { throw 'Node.js runtime verification failed.' }
    return [pscustomobject][ordered]@{
        version = $stdout.TrimEnd("`r", "`n")
        major = $actualMajor
        minimumMajor = $requiredMajor
    }
}

function Assert-DysonRelativePath {
    param(
        [Parameter(Mandatory)][string]$Path,
        [Parameter(Mandatory)][string]$Name
    )

    if ([string]::IsNullOrWhiteSpace($Path) -or [System.IO.Path]::IsPathRooted($Path) -or
        $Path -match '(^|[\\/])\.\.([\\/]|$)' -or $Path.IndexOf([char]0) -ge 0 -or $Path -match '["\r\n]') {
        throw "$Name must be a bounded relative path."
    }
}

function Test-DysonPathWithin {
    param(
        [Parameter(Mandatory)][string]$Candidate,
        [Parameter(Mandatory)][string]$Parent,
        [switch]$AllowEqual
    )

    $candidateFull = (Get-DysonFullPath -Path $Candidate).TrimEnd('\', '/')
    $parentFull = (Get-DysonFullPath -Path $Parent).TrimEnd('\', '/')
    if ($AllowEqual -and [string]::Equals($candidateFull, $parentFull, [System.StringComparison]::OrdinalIgnoreCase)) {
        return $true
    }
    $prefix = $parentFull + [System.IO.Path]::DirectorySeparatorChar
    return $candidateFull.StartsWith($prefix, [System.StringComparison]::OrdinalIgnoreCase)
}

function Assert-DysonSafeRoot {
    param(
        [Parameter(Mandatory)][string]$Path,
        [Parameter(Mandatory)][string]$Name
    )

    $fullPath = Get-DysonFullPath -Path $Path
    $root = [System.IO.Path]::GetPathRoot($fullPath)
    if ([string]::Equals($fullPath.TrimEnd('\', '/'), $root.TrimEnd('\', '/'), [System.StringComparison]::OrdinalIgnoreCase)) {
        throw "$Name cannot be a filesystem root."
    }
    return $fullPath
}

function Assert-DysonPlainDirectory {
    param([Parameter(Mandatory)][string]$Path)

    $item = Get-Item -LiteralPath $Path -Force -ErrorAction Stop
    if (-not $item.PSIsContainer -or ($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint)) {
        throw "Deployment directory is unavailable or redirected: $Path"
    }
    return $item.FullName
}

function New-DysonDirectory {
    param([Parameter(Mandatory)][string]$Path)

    [System.IO.Directory]::CreateDirectory($Path) | Out-Null
    return Assert-DysonPlainDirectory -Path $Path
}

function Test-DysonSourceArtifact {
    param(
        [Parameter(Mandatory)][string]$SourcePath,
        [Parameter(Mandatory)][string]$ExpectedVersion,
        [Parameter(Mandatory)][string]$ExpectedEntryPoint
    )

    Assert-DysonVersion -Version $ExpectedVersion
    Assert-DysonRelativePath -Path $ExpectedEntryPoint -Name 'EntryPointRelativePath'
    $source = Assert-DysonPlainDirectory -Path $SourcePath
    $normalizedEntryPoint = $ExpectedEntryPoint.Replace('\', '/')
    $verifierPath = Get-DysonFullPath -Path (Join-Path $source $script:DysonArtifactVerifierRelativePath)
    $verifierCommonPath = Get-DysonFullPath -Path (Join-Path $source $script:DysonArtifactVerifierCommonRelativePath)
    foreach ($requiredVerifierFile in @($verifierPath, $verifierCommonPath)) {
        if (-not (Test-DysonPathWithin -Candidate $requiredVerifierFile -Parent $source) -or
            -not (Test-Path -LiteralPath $requiredVerifierFile -PathType Leaf)) {
            throw 'The clean release artifact is missing its self-contained verifier.'
        }
        $verifierItem = Get-Item -LiteralPath $requiredVerifierFile -Force -ErrorAction Stop
        if ($verifierItem.PSIsContainer -or ($verifierItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint)) {
            throw 'The clean release artifact verifier is redirected or unavailable.'
        }
    }

    try {
        $verificationOutput = & $verifierPath -ArtifactPath $source -ExpectedVersion $ExpectedVersion
        $verificationLines = @(
            ($verificationOutput | Out-String) -split "`r?`n" |
                Where-Object { -not [string]::IsNullOrWhiteSpace($_) }
        )
        if ($verificationLines.Count -eq 0) { throw 'The artifact verifier returned no result.' }
        $verification = $verificationLines[$verificationLines.Count - 1] | ConvertFrom-Json
    }
    catch {
        throw 'The source release artifact failed its manifest verification.'
    }

    $nodeMinimumMajor = Get-DysonNodeMinimumMajor -Value $verification.nodeMinimumMajor
    if (-not [bool]$verification.ready -or
        -not [string]::Equals([string]$verification.protocol, $script:DysonArtifactVerifierProtocol, [System.StringComparison]::Ordinal) -or
        -not [string]::Equals([string]$verification.version, $ExpectedVersion, [System.StringComparison]::Ordinal) -or
        -not [string]::Equals([string]$verification.entryPoint, $normalizedEntryPoint, [System.StringComparison]::Ordinal) -or
        [string]$verification.payloadSha256 -notmatch '^[0-9a-f]{64}$' -or
        [int64]$verification.fileCount -lt 1 -or [int64]$verification.totalBytes -lt 1) {
        throw 'The source release artifact verification result is unsupported or inconsistent.'
    }

    return [pscustomobject][ordered]@{
        artifactRoot = $source
        protocol = [string]$verification.protocol
        version = [string]$verification.version
        entryPoint = [string]$verification.entryPoint
        nodeMinimumMajor = $nodeMinimumMajor
        payloadSha256 = [string]$verification.payloadSha256
        fileCount = [int]$verification.fileCount
        totalBytes = [int64]$verification.totalBytes
    }
}

function Get-DysonFileSha256 {
    param([Parameter(Mandatory)][string]$Path)

    $fullPath = Get-DysonFullPath -Path $Path
    $stream = [System.IO.File]::Open(
        $fullPath,
        [System.IO.FileMode]::Open,
        [System.IO.FileAccess]::Read,
        [System.IO.FileShare]::Read
    )
    $hasher = [System.Security.Cryptography.SHA256]::Create()
    try {
        return ([System.BitConverter]::ToString($hasher.ComputeHash($stream))).Replace('-', '').ToLowerInvariant()
    }
    finally {
        $hasher.Dispose()
        $stream.Dispose()
    }
}

function Get-DysonRelativeFilePath {
    param(
        [Parameter(Mandatory)][string]$Root,
        [Parameter(Mandatory)][string]$File
    )

    $rootFull = (Get-DysonFullPath -Path $Root).TrimEnd('\', '/')
    $fileFull = Get-DysonFullPath -Path $File
    if (-not (Test-DysonPathWithin -Candidate $fileFull -Parent $rootFull)) {
        throw 'A payload file escaped its release root.'
    }
    return $fileFull.Substring($rootFull.Length).TrimStart('\', '/').Replace('\', '/')
}

function Get-DysonPayloadInventory {
    param([Parameter(Mandatory)][string]$Root)

    $rootFull = Assert-DysonPlainDirectory -Path $Root
    $redirected = @(Get-ChildItem -LiteralPath $rootFull -Recurse -Force -ErrorAction Stop | Where-Object {
        $_.Attributes -band [System.IO.FileAttributes]::ReparsePoint
    })
    if ($redirected.Count -gt 0) { throw 'Release payloads cannot contain reparse points.' }

    $files = @(
        Get-ChildItem -LiteralPath $rootFull -Recurse -File -Force -ErrorAction Stop |
            Where-Object {
                (Get-DysonRelativeFilePath -Root $rootFull -File $_.FullName) -ne $script:DysonReleaseManifestName
            } |
            ForEach-Object {
                $relativePath = Get-DysonRelativeFilePath -Root $rootFull -File $_.FullName
                [ordered]@{
                    path = $relativePath
                    length = [int64]$_.Length
                    sha256 = Get-DysonFileSha256 -Path $_.FullName
                }
            } |
            Sort-Object { $_.path }
    )
    if ($files.Count -eq 0) { throw 'The release payload is empty.' }

    $lines = @($files | ForEach-Object { '{0}|{1}|{2}' -f $_.path, $_.length, $_.sha256 })
    $canonical = [string]::Join("`n", $lines)
    $bytes = [System.Text.UTF8Encoding]::new($false).GetBytes($canonical)
    $hasher = [System.Security.Cryptography.SHA256]::Create()
    try { $payloadHash = ([System.BitConverter]::ToString($hasher.ComputeHash($bytes))).Replace('-', '').ToLowerInvariant() }
    finally { $hasher.Dispose() }

    return [ordered]@{
        files = $files
        payloadSha256 = $payloadHash
    }
}

function Write-DysonJsonAtomic {
    param(
        [Parameter(Mandatory)][string]$Path,
        [Parameter(Mandatory)]$Value
    )

    $fullPath = Get-DysonFullPath -Path $Path
    $parent = New-DysonDirectory -Path ([System.IO.Path]::GetDirectoryName($fullPath))
    $temporaryPath = Join-Path $parent ('.partial-' + [guid]::NewGuid().ToString('N'))
    $replaceBackupPath = Join-Path $parent ('.replace-backup-' + [guid]::NewGuid().ToString('N'))
    $json = $Value | ConvertTo-Json -Depth 12 -Compress
    try {
        [System.IO.File]::WriteAllText($temporaryPath, $json, [System.Text.UTF8Encoding]::new($false))
        if (Test-Path -LiteralPath $fullPath -PathType Leaf) {
            [System.IO.File]::Replace($temporaryPath, $fullPath, $replaceBackupPath)
            Remove-Item -LiteralPath $replaceBackupPath -Force
        }
        else {
            [System.IO.File]::Move($temporaryPath, $fullPath)
        }
    }
    finally {
        if (Test-Path -LiteralPath $temporaryPath) { Remove-Item -LiteralPath $temporaryPath -Force }
        if (Test-Path -LiteralPath $replaceBackupPath) { Remove-Item -LiteralPath $replaceBackupPath -Force }
    }
}

function Read-DysonJsonFile {
    param([Parameter(Mandatory)][string]$Path)

    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { throw "Required deployment metadata is missing: $Path" }
    $item = Get-Item -LiteralPath $Path -Force -ErrorAction Stop
    if ($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) { throw 'Deployment metadata cannot be redirected.' }
    return [System.IO.File]::ReadAllText($item.FullName, [System.Text.Encoding]::UTF8) | ConvertFrom-Json
}

function Write-DysonDeploymentAudit {
    param(
        [Parameter(Mandatory)][string]$DataRoot,
        [Parameter(Mandatory)][string]$Operation,
        [Parameter(Mandatory)][string]$Outcome,
        [string]$Version,
        [string]$SnapshotId,
        [string]$Code = 'OK'
    )

    $auditRoot = New-DysonDirectory -Path (Join-Path $DataRoot 'audit')
    $auditPath = Join-Path $auditRoot 'deployment.jsonl'
    $record = [ordered]@{
        protocol = $script:DysonDeploymentProtocol
        writtenAt = (Get-Date).ToUniversalTime().ToString('o')
        operation = $Operation
        outcome = $Outcome
        version = if ($Version) { $Version } else { $null }
        snapshotId = if ($SnapshotId) { $SnapshotId } else { $null }
        code = $Code
    } | ConvertTo-Json -Depth 4 -Compress
    $stream = [System.IO.FileStream]::new(
        $auditPath,
        [System.IO.FileMode]::OpenOrCreate,
        [System.IO.FileAccess]::Write,
        [System.IO.FileShare]::Read
    )
    try {
        [void]$stream.Seek(0, [System.IO.SeekOrigin]::End)
        $bytes = [System.Text.UTF8Encoding]::new($false).GetBytes($record + "`r`n")
        $stream.Write($bytes, 0, $bytes.Length)
        $stream.Flush($true)
    }
    finally { $stream.Dispose() }
}

function Get-DysonDeploymentLockPath {
    param([Parameter(Mandatory)][string]$DataRoot)

    $dataFull = (Get-DysonFullPath -Path $DataRoot).TrimEnd('\', '/')
    $parent = [System.IO.Path]::GetDirectoryName($dataFull)
    if ([string]::IsNullOrWhiteSpace($parent) -or -not (Test-Path -LiteralPath $parent -PathType Container)) {
        throw 'The deployment data parent directory must exist before acquiring the deployment lock.'
    }
    $normalizedIdentity = $dataFull.ToUpperInvariant()
    $lockRoot = Join-Path $parent '.dyson-control-deployment-locks'
    return Join-Path $lockRoot ((Get-DysonTextSha256 -Value $normalizedIdentity) + '.lock')
}

function Enter-DysonDeploymentLock {
    param(
        [Parameter(Mandatory)][string]$DataRoot,
        [ValidateRange(1, 120)][int]$TimeoutSeconds = 30
    )

    $lockPath = Get-DysonDeploymentLockPath -DataRoot $DataRoot
    [void](New-DysonDirectory -Path ([System.IO.Path]::GetDirectoryName($lockPath)))
    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    do {
        try {
            return [System.IO.FileStream]::new(
                $lockPath,
                [System.IO.FileMode]::OpenOrCreate,
                [System.IO.FileAccess]::ReadWrite,
                [System.IO.FileShare]::None
            )
        }
        catch [System.IO.IOException] {
            if ((Get-Date) -ge $deadline) { throw 'Another deployment operation still owns the deployment lock.' }
            Start-Sleep -Milliseconds 200
        }
    } while ($true)
}

function Assert-DysonDeploymentLockLease {
    param(
        [Parameter(Mandatory)][System.IO.FileStream]$Lease,
        [Parameter(Mandatory)][string]$DataRoot
    )

    $expectedPath = Get-DysonFullPath -Path (Get-DysonDeploymentLockPath -DataRoot $DataRoot)
    try {
        $actualPath = Get-DysonFullPath -Path $Lease.Name
        if (-not $Lease.CanRead -or -not $Lease.CanWrite -or
            -not [string]::Equals($actualPath, $expectedPath, [System.StringComparison]::OrdinalIgnoreCase)) {
            throw 'invalid lease'
        }
        $probe = $null
        try {
            $probe = [System.IO.FileStream]::new(
                $expectedPath,
                [System.IO.FileMode]::Open,
                [System.IO.FileAccess]::ReadWrite,
                [System.IO.FileShare]::ReadWrite
            )
            throw 'lease is not exclusive'
        }
        catch [System.IO.IOException] { }
        finally { if ($probe) { $probe.Dispose() } }
    }
    catch { throw 'The supplied deployment lock lease is invalid.' }
}

function Get-DysonTextSha256 {
    param([Parameter(Mandatory)][AllowEmptyString()][string]$Value)

    $bytes = [System.Text.UTF8Encoding]::new($false).GetBytes($Value)
    $hasher = [System.Security.Cryptography.SHA256]::Create()
    try { return ([System.BitConverter]::ToString($hasher.ComputeHash($bytes))).Replace('-', '').ToLowerInvariant() }
    finally { $hasher.Dispose() }
}

function Assert-DysonDeploymentTaskSelfTestScope {
    param(
        [Parameter(Mandatory)][string]$InstallRoot,
        [Parameter(Mandatory)][string]$DataRoot
    )

    if ($env:DYSON_DEPLOYMENT_ALLOW_SELFTEST_TASKS -ne 'true') {
        throw 'The task-administrator bypass is reserved for the isolated deployment self-test.'
    }
    $temporaryRoot = [System.IO.Path]::GetFullPath([System.IO.Path]::GetTempPath()).TrimEnd('\', '/')
    $requiredPrefix = $temporaryRoot + [System.IO.Path]::DirectorySeparatorChar + 'dyson-control-deployment-selftest-'
    foreach ($path in @($InstallRoot, $DataRoot)) {
        $full = (Get-DysonFullPath -Path $path).TrimEnd('\', '/')
        if (-not $full.StartsWith($requiredPrefix, [System.StringComparison]::OrdinalIgnoreCase)) {
            throw 'The task-administrator bypass is outside the isolated deployment self-test root.'
        }
    }
}

function Get-DysonScheduledTasksByExactName {
    param([Parameter(Mandatory)][string]$TaskName)

    if ($TaskName -notmatch '^[\p{L}\p{N}_. -]{1,128}$') { throw 'The control-plane task name is invalid.' }
    try { $allTasks = @(Get-ScheduledTask -ErrorAction Stop) }
    catch { throw 'The Task Scheduler state could not be queried.' }
    $matches = @(
        foreach ($task in $allTasks) {
            if ($null -eq $task -or $task.PSObject.Properties.Name -notcontains 'TaskName') {
                throw 'The Task Scheduler returned an invalid task record.'
            }
            if ([string]::Equals(
                [string]$task.TaskName,
                $TaskName,
                [System.StringComparison]::OrdinalIgnoreCase
            )) { $task }
        }
    )
    return @($matches)
}

function Get-DysonControlTaskRollbackState {
    param([Parameter(Mandatory)][string]$TaskName)

    if ($TaskName -notmatch '^[\p{L}\p{N}_. -]{1,128}$') { throw 'The control-plane task name is invalid.' }
    $matches = @(Get-DysonScheduledTasksByExactName -TaskName $TaskName)
    if ($matches.Count -gt 1) { throw 'The control-plane task identity is ambiguous.' }
    if ($matches.Count -eq 0) {
        return [pscustomobject][ordered]@{
            taskName = $TaskName
            taskPath = $script:DysonControlTaskPath
            present = $false
            wasRunning = $false
            xml = $null
            xmlSha256 = $null
        }
    }

    if ($matches[0].PSObject.Properties.Name -notcontains 'TaskPath' -or
        -not [string]::Equals(
            [string]$matches[0].TaskPath,
            $script:DysonControlTaskPath,
            [System.StringComparison]::Ordinal
        )) {
        throw 'The control-plane task must use the fixed root task path.'
    }
    $xml = [string](Export-ScheduledTask -TaskName $TaskName -TaskPath $script:DysonControlTaskPath -ErrorAction Stop)
    if ([string]::IsNullOrWhiteSpace($xml) -or $xml.Length -gt 4MB) {
        throw 'The control-plane task definition is empty or exceeds its rollback bound.'
    }
    return [pscustomobject][ordered]@{
        taskName = $TaskName
        taskPath = $script:DysonControlTaskPath
        present = $true
        wasRunning = [string]::Equals($matches[0].State.ToString(), 'Running', [System.StringComparison]::OrdinalIgnoreCase)
        xml = $xml
        xmlSha256 = Get-DysonTextSha256 -Value $xml
    }
}

function Remove-DysonControlTaskForRollback {
    param([Parameter(Mandatory)][string]$TaskName)

    if ($TaskName -notmatch '^[\p{L}\p{N}_. -]{1,128}$') { throw 'The control-plane task name is invalid.' }
    $matches = @(Get-DysonScheduledTasksByExactName -TaskName $TaskName)
    if ($matches.Count -gt 1) { throw 'The control-plane task identity is ambiguous.' }
    if ($matches.Count -eq 1) {
        $task = $matches[0]
        if ($task.PSObject.Properties.Name -notcontains 'TaskPath' -or
            -not [string]::Equals(
                [string]$task.TaskPath,
                $script:DysonControlTaskPath,
                [System.StringComparison]::Ordinal
            )) {
            throw 'The control-plane task must use the fixed root task path.'
        }
        if ([string]::Equals($task.State.ToString(), 'Running', [System.StringComparison]::OrdinalIgnoreCase)) {
            Stop-ScheduledTask -InputObject $task -ErrorAction Stop
            $deadline = (Get-Date).AddSeconds(20)
            do {
                Start-Sleep -Milliseconds 250
                $matches = @(Get-DysonScheduledTasksByExactName -TaskName $TaskName)
                if ($matches.Count -gt 1) { throw 'The control-plane task identity became ambiguous.' }
            } while ($matches.Count -eq 1 -and
                [string]::Equals($matches[0].State.ToString(), 'Running', [System.StringComparison]::OrdinalIgnoreCase) -and
                (Get-Date) -lt $deadline)
            if ($matches.Count -eq 1 -and
                [string]::Equals($matches[0].State.ToString(), 'Running', [System.StringComparison]::OrdinalIgnoreCase)) {
                throw 'The replacement control-plane task did not stop before rollback.'
            }
        }
        Unregister-ScheduledTask -TaskName $TaskName -TaskPath $script:DysonControlTaskPath -Confirm:$false -ErrorAction Stop
    }
    if (@(Get-DysonScheduledTasksByExactName -TaskName $TaskName).Count -ne 0) {
        throw 'The replacement control-plane task could not be removed for rollback.'
    }
}

function Restore-DysonControlTaskRollbackState {
    param(
        [Parameter(Mandatory)]$State,
        [Parameter(Mandatory)][string]$TaskName
    )

    if ([string]$State.taskName -cne $TaskName -or
        [string]$State.taskPath -cne $script:DysonControlTaskPath -or $State.present -isnot [bool] -or
        $State.wasRunning -isnot [bool]) {
        throw 'The control-plane task rollback state is invalid.'
    }
    Remove-DysonControlTaskForRollback -TaskName $TaskName
    if (-not [bool]$State.present) {
        return [ordered]@{ taskRestored = $false; taskRemoved = $true; previousTaskWasRunning = $false }
    }
    if (-not ($State.xml -is [string]) -or [string]::IsNullOrWhiteSpace([string]$State.xml) -or
        ([string]$State.xml).Length -gt 4MB -or [string]$State.xmlSha256 -notmatch '^[0-9a-f]{64}$' -or
        (Get-DysonTextSha256 -Value ([string]$State.xml)) -cne [string]$State.xmlSha256) {
        throw 'The saved control-plane task rollback definition is invalid.'
    }

    Register-ScheduledTask -TaskName $TaskName -TaskPath $script:DysonControlTaskPath `
        -Xml ([string]$State.xml) -Force -ErrorAction Stop | Out-Null
    if ([bool]$State.wasRunning) {
        Start-ScheduledTask -TaskName $TaskName -TaskPath $script:DysonControlTaskPath -ErrorAction Stop
    }
    $startDeadline = (Get-Date).AddSeconds(20)
    do {
        $restored = @(Get-DysonScheduledTasksByExactName -TaskName $TaskName)
        if ($restored.Count -ne 1) { throw 'The previous control-plane task was not restored uniquely.' }
        if ($restored[0].PSObject.Properties.Name -notcontains 'TaskPath' -or
            [string]$restored[0].TaskPath -cne $script:DysonControlTaskPath) {
            throw 'The previous control-plane task was restored outside the fixed root task path.'
        }
        if (-not [bool]$State.wasRunning -or
            [string]::Equals($restored[0].State.ToString(), 'Running', [System.StringComparison]::OrdinalIgnoreCase)) {
            break
        }
        Start-Sleep -Milliseconds 250
    } while ((Get-Date) -lt $startDeadline)
    $restoredXml = [string](Export-ScheduledTask -TaskName $TaskName `
        -TaskPath $script:DysonControlTaskPath -ErrorAction Stop)
    if ((Get-DysonTextSha256 -Value $restoredXml) -cne [string]$State.xmlSha256) {
        throw 'The restored control-plane task definition does not match its rollback state.'
    }
    $restoredIsRunning = [string]::Equals(
        $restored[0].State.ToString(),
        'Running',
        [System.StringComparison]::OrdinalIgnoreCase
    )
    if ($restoredIsRunning -ne [bool]$State.wasRunning) {
        throw 'The restored control-plane task did not return to its previous execution state.'
    }
    return [ordered]@{
        taskRestored = $true
        taskRemoved = $false
        previousTaskWasRunning = [bool]$State.wasRunning
    }
}

function Copy-DysonPayload {
    param(
        [Parameter(Mandatory)][string]$Source,
        [Parameter(Mandatory)][string]$Destination
    )

    foreach ($item in @(Get-ChildItem -LiteralPath $Source -Force -ErrorAction Stop)) {
        if ($item.Name -eq $script:DysonReleaseManifestName) { continue }
        Copy-Item -LiteralPath $item.FullName -Destination $Destination -Recurse -Force -ErrorAction Stop
    }
}

function Test-DysonRelease {
    param(
        [Parameter(Mandatory)][string]$ReleaseRoot,
        [Parameter(Mandatory)][string]$ExpectedVersion,
        [Parameter(Mandatory)][string]$ExpectedEntryPoint
    )

    Assert-DysonVersion -Version $ExpectedVersion
    Assert-DysonRelativePath -Path $ExpectedEntryPoint -Name 'EntryPointRelativePath'
    $releaseFull = Assert-DysonPlainDirectory -Path $ReleaseRoot
    $manifestPath = Join-Path $releaseFull $script:DysonReleaseManifestName
    $manifest = Read-DysonJsonFile -Path $manifestPath
    $nodeMinimumMajor = Get-DysonNodeMinimumMajor -Value $manifest.nodeMinimumMajor
    if ($manifest.protocol -ne $script:DysonDeploymentProtocol -or $manifest.version -ne $ExpectedVersion -or
        $manifest.entryPoint -ne $ExpectedEntryPoint) {
        throw 'The staged release manifest does not match the requested release.'
    }
    $entryPoint = Get-DysonFullPath -Path (Join-Path $releaseFull $ExpectedEntryPoint)
    if (-not (Test-DysonPathWithin -Candidate $entryPoint -Parent $releaseFull) -or
        -not (Test-Path -LiteralPath $entryPoint -PathType Leaf)) {
        throw 'The staged control-plane entry point is missing.'
    }
    $inventory = Get-DysonPayloadInventory -Root $releaseFull
    if ($inventory.payloadSha256 -ne $manifest.payloadSha256) { throw 'The staged release payload hash does not match its manifest.' }
    $manifestFiles = @($manifest.files)
    if ($manifestFiles.Count -ne @($inventory.files).Count) { throw 'The staged release file inventory changed after staging.' }
    return [ordered]@{
        version = $ExpectedVersion
        entryPoint = $ExpectedEntryPoint
        nodeMinimumMajor = $nodeMinimumMajor
        payloadSha256 = $inventory.payloadSha256
        fileCount = @($inventory.files).Count
    }
}

function Invoke-DysonStageReleaseCore {
    param(
        [Parameter(Mandatory)][string]$SourcePath,
        [Parameter(Mandatory)][string]$Version,
        [Parameter(Mandatory)][string]$InstallRoot,
        [Parameter(Mandatory)][string]$EntryPointRelativePath,
        [Parameter(Mandatory)]$SourceArtifactVerification
    )

    Assert-DysonVersion -Version $Version
    Assert-DysonRelativePath -Path $EntryPointRelativePath -Name 'EntryPointRelativePath'
    $source = Assert-DysonPlainDirectory -Path $SourcePath
    $normalizedEntryPoint = $EntryPointRelativePath.Replace('\', '/')
    $sourceNodeMinimumMajor = Get-DysonNodeMinimumMajor -Value $SourceArtifactVerification.nodeMinimumMajor
    if (-not [string]::Equals((Get-DysonFullPath -Path ([string]$SourceArtifactVerification.artifactRoot)), $source, [System.StringComparison]::OrdinalIgnoreCase) -or
        -not [string]::Equals([string]$SourceArtifactVerification.version, $Version, [System.StringComparison]::Ordinal) -or
        -not [string]::Equals([string]$SourceArtifactVerification.entryPoint, $normalizedEntryPoint, [System.StringComparison]::Ordinal) -or
        [string]$SourceArtifactVerification.payloadSha256 -notmatch '^[0-9a-f]{64}$') {
        throw 'The source artifact verification receipt does not match the requested deployment.'
    }
    $sourceEntry = Get-DysonFullPath -Path (Join-Path $source $EntryPointRelativePath)
    if (-not (Test-DysonPathWithin -Candidate $sourceEntry -Parent $source) -or
        -not (Test-Path -LiteralPath $sourceEntry -PathType Leaf)) {
        throw 'The source payload does not contain the required control-plane entry point.'
    }
    $sourceInventory = Get-DysonPayloadInventory -Root $source
    $releasesRoot = New-DysonDirectory -Path (Join-Path $InstallRoot 'releases')
    $releaseRoot = Get-DysonFullPath -Path (Join-Path $releasesRoot $Version)
    if (-not (Test-DysonPathWithin -Candidate $releaseRoot -Parent $releasesRoot)) { throw 'The release version escaped the releases root.' }

    if (Test-Path -LiteralPath $releaseRoot) {
        $existing = Test-DysonRelease -ReleaseRoot $releaseRoot -ExpectedVersion $Version -ExpectedEntryPoint $EntryPointRelativePath
        if ($existing.payloadSha256 -ne $sourceInventory.payloadSha256 -or
            [int]$existing.nodeMinimumMajor -ne $sourceNodeMinimumMajor) {
            throw 'An immutable release with this version already exists with different content.'
        }
        return [ordered]@{
            state = 'already-staged'
            version = $Version
            payloadSha256 = $existing.payloadSha256
            fileCount = $existing.fileCount
        }
    }

    $stagingRoot = Join-Path $releasesRoot ('.staging-' + [guid]::NewGuid().ToString('N'))
    [System.IO.Directory]::CreateDirectory($stagingRoot) | Out-Null
    try {
        Copy-DysonPayload -Source $source -Destination $stagingRoot
        $stagedInventory = Get-DysonPayloadInventory -Root $stagingRoot
        if ($stagedInventory.payloadSha256 -ne $sourceInventory.payloadSha256) { throw 'The staged payload differs from its source.' }
        $stagedArtifactVerification = Test-DysonSourceArtifact -SourcePath $stagingRoot `
            -ExpectedVersion $Version -ExpectedEntryPoint $EntryPointRelativePath
        if (-not [string]::Equals(
            [string]$stagedArtifactVerification.payloadSha256,
            [string]$SourceArtifactVerification.payloadSha256,
            [System.StringComparison]::Ordinal
        ) -or [int]$stagedArtifactVerification.nodeMinimumMajor -ne $sourceNodeMinimumMajor) {
            throw 'The source artifact changed after its pre-deployment verification.'
        }
        $manifest = [ordered]@{
            protocol = $script:DysonDeploymentProtocol
            version = $Version
            entryPoint = $EntryPointRelativePath
            nodeMinimumMajor = $sourceNodeMinimumMajor
            createdAt = (Get-Date).ToUniversalTime().ToString('o')
            payloadSha256 = $stagedInventory.payloadSha256
            files = $stagedInventory.files
        }
        Write-DysonJsonAtomic -Path (Join-Path $stagingRoot $script:DysonReleaseManifestName) -Value $manifest
        [System.IO.Directory]::Move($stagingRoot, $releaseRoot)
    }
    finally {
        if (Test-Path -LiteralPath $stagingRoot) { Remove-Item -LiteralPath $stagingRoot -Recurse -Force }
    }
    $verified = Test-DysonRelease -ReleaseRoot $releaseRoot -ExpectedVersion $Version -ExpectedEntryPoint $EntryPointRelativePath
    return [ordered]@{
        state = 'staged'
        version = $Version
        payloadSha256 = $verified.payloadSha256
        fileCount = $verified.fileCount
    }
}

function Get-DysonActivePointerPath {
    param([Parameter(Mandatory)][string]$DataRoot)
    return Join-Path (Join-Path $DataRoot 'state') $script:DysonActivePointerName
}

function Get-DysonActiveRelease {
    param(
        [Parameter(Mandatory)][string]$InstallRoot,
        [Parameter(Mandatory)][string]$DataRoot
    )

    $pointerPath = Get-DysonActivePointerPath -DataRoot $DataRoot
    if (-not (Test-Path -LiteralPath $pointerPath -PathType Leaf)) { return $null }
    $pointer = Read-DysonJsonFile -Path $pointerPath
    if ($pointer.protocol -ne $script:DysonDeploymentProtocol) { throw 'The active release pointer protocol is unsupported.' }
    Assert-DysonVersion -Version ([string]$pointer.version)
    Assert-DysonRelativePath -Path ([string]$pointer.entryPoint) -Name 'Active entry point'
    $releaseRoot = Get-DysonFullPath -Path (Join-Path (Join-Path $InstallRoot 'releases') ([string]$pointer.version))
    $verified = Test-DysonRelease -ReleaseRoot $releaseRoot -ExpectedVersion ([string]$pointer.version) -ExpectedEntryPoint ([string]$pointer.entryPoint)
    if ($verified.payloadSha256 -ne [string]$pointer.payloadSha256) { throw 'The active pointer does not match its immutable release.' }
    return [ordered]@{
        pointer = $pointer
        pointerPath = $pointerPath
        releaseRoot = $releaseRoot
        entryPointPath = Get-DysonFullPath -Path (Join-Path $releaseRoot ([string]$pointer.entryPoint))
        nodeMinimumMajor = [int]$verified.nodeMinimumMajor
    }
}

function Invoke-DysonActivateCore {
    param(
        [Parameter(Mandatory)][string]$Version,
        [Parameter(Mandatory)][string]$InstallRoot,
        [Parameter(Mandatory)][string]$DataRoot,
        [Parameter(Mandatory)][string]$EntryPointRelativePath
    )

    $releaseRoot = Get-DysonFullPath -Path (Join-Path (Join-Path $InstallRoot 'releases') $Version)
    $verified = Test-DysonRelease -ReleaseRoot $releaseRoot -ExpectedVersion $Version -ExpectedEntryPoint $EntryPointRelativePath
    $pointer = [ordered]@{
        protocol = $script:DysonDeploymentProtocol
        version = $Version
        entryPoint = $EntryPointRelativePath
        payloadSha256 = $verified.payloadSha256
        activatedAt = (Get-Date).ToUniversalTime().ToString('o')
    }
    Write-DysonJsonAtomic -Path (Get-DysonActivePointerPath -DataRoot $DataRoot) -Value $pointer
    return $pointer
}

function Copy-DysonDirectoryContents {
    param(
        [Parameter(Mandatory)][string]$Source,
        [Parameter(Mandatory)][string]$Destination
    )

    $sourceFull = Assert-DysonPlainDirectory -Path $Source
    $redirected = @(Get-ChildItem -LiteralPath $sourceFull -Recurse -Force -ErrorAction Stop | Where-Object {
        $_.Attributes -band [System.IO.FileAttributes]::ReparsePoint
    })
    if ($redirected.Count -gt 0) { throw 'Deployment configuration cannot contain reparse points.' }
    [System.IO.Directory]::CreateDirectory($Destination) | Out-Null
    foreach ($item in @(Get-ChildItem -LiteralPath $sourceFull -Force -ErrorAction Stop)) {
        Copy-Item -LiteralPath $item.FullName -Destination $Destination -Recurse -Force -ErrorAction Stop
    }
}

function New-DysonDeploymentSnapshotCore {
    param(
        [Parameter(Mandatory)][string]$InstallRoot,
        [Parameter(Mandatory)][string]$DataRoot,
        [Parameter(Mandatory)][string]$Reason
    )

    $snapshotRoot = New-DysonDirectory -Path (Join-Path (Join-Path $DataRoot 'snapshots') 'deployments')
    $snapshotId = (Get-Date).ToUniversalTime().ToString('yyyyMMdd-HHmmssfff') + '-' + [guid]::NewGuid().ToString('N').Substring(0, 8)
    $finalPath = Join-Path $snapshotRoot $snapshotId
    $stagingPath = Join-Path $snapshotRoot ('.partial-' + [guid]::NewGuid().ToString('N'))
    [System.IO.Directory]::CreateDirectory($stagingPath) | Out-Null
    try {
        $activePointerPath = Get-DysonActivePointerPath -DataRoot $DataRoot
        $hadActivePointer = Test-Path -LiteralPath $activePointerPath -PathType Leaf
        $activeVersion = $null
        $activePointerSha256 = $null
        if ($hadActivePointer) {
            $active = Get-DysonActiveRelease -InstallRoot $InstallRoot -DataRoot $DataRoot
            $activeVersion = [string]$active.pointer.version
            Copy-Item -LiteralPath $activePointerPath -Destination (Join-Path $stagingPath $script:DysonActivePointerName) -Force
            $activePointerSha256 = Get-DysonFileSha256 -Path $activePointerPath
        }
        $configPath = Join-Path $DataRoot 'config'
        $configPresent = Test-Path -LiteralPath $configPath -PathType Container
        if ($configPresent) { Copy-DysonDirectoryContents -Source $configPath -Destination (Join-Path $stagingPath 'config') }
        $metadata = [ordered]@{
            protocol = $script:DysonDeploymentProtocol
            snapshotId = $snapshotId
            createdAt = (Get-Date).ToUniversalTime().ToString('o')
            reason = $Reason
            hadActivePointer = [bool]$hadActivePointer
            activeVersion = $activeVersion
            activePointerSha256 = $activePointerSha256
            configPresent = [bool]$configPresent
        }
        Write-DysonJsonAtomic -Path (Join-Path $stagingPath 'snapshot.json') -Value $metadata
        [System.IO.Directory]::Move($stagingPath, $finalPath)
    }
    finally {
        if (Test-Path -LiteralPath $stagingPath) { Remove-Item -LiteralPath $stagingPath -Recurse -Force }
    }
    return $metadata
}

function Get-DysonDeploymentSnapshot {
    param(
        [Parameter(Mandatory)][string]$DataRoot,
        [Parameter(Mandatory)][string]$SnapshotId
    )

    $snapshotRoot = Get-DysonFullPath -Path (Join-Path (Join-Path $DataRoot 'snapshots') 'deployments')
    if (-not (Test-Path -LiteralPath $snapshotRoot -PathType Container)) { throw 'No deployment snapshots are available.' }
    if ($SnapshotId -eq 'latest') {
        $candidates = @(Get-ChildItem -LiteralPath $snapshotRoot -Directory -Force -ErrorAction Stop |
            Where-Object { $_.Name -notlike '.partial-*' } |
            Sort-Object Name -Descending)
        if ($candidates.Count -eq 0) { throw 'No deployment snapshots are available.' }
        $snapshotPath = $candidates[0].FullName
    }
    else {
        if ($SnapshotId -notmatch '^\d{8}-\d{9}-[0-9a-f]{8}$') { throw 'The deployment snapshot ID is invalid.' }
        $snapshotPath = Get-DysonFullPath -Path (Join-Path $snapshotRoot $SnapshotId)
    }
    if (-not (Test-DysonPathWithin -Candidate $snapshotPath -Parent $snapshotRoot) -or
        -not (Test-Path -LiteralPath $snapshotPath -PathType Container)) { throw 'The requested deployment snapshot does not exist.' }
    $metadata = Read-DysonJsonFile -Path (Join-Path $snapshotPath 'snapshot.json')
    if ($metadata.protocol -ne $script:DysonDeploymentProtocol -or $metadata.snapshotId -ne (Split-Path -Leaf $snapshotPath)) {
        throw 'The deployment snapshot metadata is invalid.'
    }
    return [ordered]@{ path = $snapshotPath; metadata = $metadata }
}

function Restore-DysonDeploymentSnapshotCore {
    param(
        [Parameter(Mandatory)][string]$InstallRoot,
        [Parameter(Mandatory)][string]$DataRoot,
        [Parameter(Mandatory)][string]$SnapshotId
    )

    $snapshot = Get-DysonDeploymentSnapshot -DataRoot $DataRoot -SnapshotId $SnapshotId
    $metadata = $snapshot.metadata
    $configPath = Join-Path $DataRoot 'config'
    $savedConfigPath = Join-Path $snapshot.path 'config'
    $replacementPath = Join-Path $DataRoot ('.config-restore-' + [guid]::NewGuid().ToString('N'))
    $supersededPath = Join-Path $DataRoot ('.config-superseded-' + [guid]::NewGuid().ToString('N'))
    try {
        if ([bool]$metadata.configPresent) { Copy-DysonDirectoryContents -Source $savedConfigPath -Destination $replacementPath }
        if (Test-Path -LiteralPath $configPath -PathType Container) { [System.IO.Directory]::Move($configPath, $supersededPath) }
        if ([bool]$metadata.configPresent) { [System.IO.Directory]::Move($replacementPath, $configPath) }
        if (Test-Path -LiteralPath $supersededPath) { Remove-Item -LiteralPath $supersededPath -Recurse -Force }
    }
    catch {
        if ((Test-Path -LiteralPath $supersededPath) -and -not (Test-Path -LiteralPath $configPath)) {
            [System.IO.Directory]::Move($supersededPath, $configPath)
        }
        throw
    }
    finally {
        if (Test-Path -LiteralPath $replacementPath) { Remove-Item -LiteralPath $replacementPath -Recurse -Force }
    }

    $activePointerPath = Get-DysonActivePointerPath -DataRoot $DataRoot
    if ([bool]$metadata.hadActivePointer) {
        $savedPointer = Join-Path $snapshot.path $script:DysonActivePointerName
        $savedPointerHash = Get-DysonFileSha256 -Path $savedPointer
        if ($savedPointerHash -ne [string]$metadata.activePointerSha256) { throw 'The saved active pointer no longer matches its snapshot.' }
        $pointer = Read-DysonJsonFile -Path $savedPointer
        $releaseRoot = Join-Path (Join-Path $InstallRoot 'releases') ([string]$pointer.version)
        [void](Test-DysonRelease -ReleaseRoot $releaseRoot -ExpectedVersion ([string]$pointer.version) -ExpectedEntryPoint ([string]$pointer.entryPoint))
        Write-DysonJsonAtomic -Path $activePointerPath -Value $pointer
    }
    elseif (Test-Path -LiteralPath $activePointerPath) {
        Remove-Item -LiteralPath $activePointerPath -Force
    }
    return [ordered]@{
        snapshotId = [string]$metadata.snapshotId
        restoredVersion = if ([bool]$metadata.hadActivePointer) { [string]$metadata.activeVersion } else { $null }
        configRestored = [bool]$metadata.configPresent
    }
}

function Restart-DysonControlTask {
    param([Parameter(Mandatory)][string]$TaskName)

    if ($TaskName -notmatch '^[\p{L}\p{N}_. -]{1,128}$') { throw 'The control-plane task name is invalid.' }
    $tasks = @(Get-DysonScheduledTasksByExactName -TaskName $TaskName)
    if ($tasks.Count -ne 1) { throw 'The fixed control-plane task identity is not unique.' }
    $task = $tasks[0]
    if ($task.PSObject.Properties.Name -notcontains 'TaskPath' -or
        [string]$task.TaskPath -cne $script:DysonControlTaskPath -or
        $task.State.ToString() -eq 'Disabled') {
        throw 'The fixed control-plane task is unavailable.'
    }
    if ($task.State.ToString() -eq 'Running') {
        Stop-ScheduledTask -InputObject $task -ErrorAction Stop
        $deadline = (Get-Date).AddSeconds(20)
        do {
            Start-Sleep -Milliseconds 250
            $tasks = @(Get-DysonScheduledTasksByExactName -TaskName $TaskName)
            if ($tasks.Count -ne 1 -or $tasks[0].PSObject.Properties.Name -notcontains 'TaskPath' -or
                [string]$tasks[0].TaskPath -cne $script:DysonControlTaskPath) {
                throw 'The fixed control-plane task identity changed while restarting.'
            }
            $task = $tasks[0]
        } while ($task.State.ToString() -eq 'Running' -and (Get-Date) -lt $deadline)
        if ($task.State.ToString() -eq 'Running') { throw 'The control-plane task did not stop before the restart deadline.' }
    }
    Start-ScheduledTask -InputObject $task -ErrorAction Stop
}

function Test-DysonLoopbackReadiness {
    param(
        [Parameter(Mandatory)][uri]$ReadinessUri,
        [Parameter(Mandatory)][string]$ExpectedVersion,
        [ValidateRange(1, 300)][int]$TimeoutSeconds = 30
    )

    Assert-DysonVersion -Version $ExpectedVersion
    if ($ReadinessUri.Scheme -ne 'http' -or $ReadinessUri.AbsolutePath -ne '/readyz' -or
        $ReadinessUri.Host -notin @('127.0.0.1', 'localhost', '::1')) {
        throw 'ReadinessUri must be a loopback HTTP /readyz endpoint.'
    }
    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    do {
        try {
            $response = Invoke-WebRequest -Uri $ReadinessUri.AbsoluteUri -UseBasicParsing -TimeoutSec 2 -ErrorAction Stop
            if ([int]$response.StatusCode -ge 200 -and [int]$response.StatusCode -lt 300) {
                $readinessBody = ConvertFrom-Json -InputObject ([string]$response.Content) -ErrorAction Stop
                $reportedHeaderVersion = [string]$response.Headers['X-Dyson-Control-Release']
                $reportedBodyVersion = if ($readinessBody.PSObject.Properties['deploymentVersion']) {
                    [string]$readinessBody.deploymentVersion
                }
                else { $null }
                $checks = if ($readinessBody.PSObject.Properties['checks']) { $readinessBody.checks } else { $null }
                $checkValues = @(
                    if ($checks) { $checks.PSObject.Properties | ForEach-Object { [string]$_.Value } }
                )
                $checksValid = $checks -and $checkValues.Count -ge 3 -and
                    @($checkValues | Where-Object { $_ -notin @('pass', 'not-applicable') }).Count -eq 0
                if ([string]::Equals([string]$readinessBody.status, 'ready', [System.StringComparison]::Ordinal) -and
                    [string]::Equals($reportedHeaderVersion, $ExpectedVersion, [System.StringComparison]::Ordinal) -and
                    [string]::Equals($reportedBodyVersion, $ExpectedVersion, [System.StringComparison]::Ordinal) -and
                    $checksValid) {
                    return $true
                }
            }
        }
        catch { }
        if ((Get-Date) -lt $deadline) { Start-Sleep -Milliseconds 500 }
    } while ((Get-Date) -lt $deadline)
    throw 'The loopback control-plane readiness check did not prove the expected release before the deadline.'
}

function ConvertTo-DysonJsonLine {
    param([Parameter(Mandatory, ValueFromPipeline)]$Value)
    process { return ($Value | ConvertTo-Json -Depth 12 -Compress) }
}
