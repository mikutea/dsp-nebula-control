# Fixed production adapter implementations for qualification protocol v2.
# This file defines functions only. Nothing executes when it is loaded.

Set-StrictMode -Version 2.0

if ($null -eq (Get-Command Throw-DysonQualificationV2Error -ErrorAction SilentlyContinue)) {
    . (Join-Path $PSScriptRoot 'Qualification.ProtocolV2.ps1')
}

function Get-DysonQualificationV2ProductionHostIdentity {
    try {
        $machineGuid = [string](Get-ItemPropertyValue `
            -LiteralPath 'Registry::HKEY_LOCAL_MACHINE\SOFTWARE\Microsoft\Cryptography' `
            -Name MachineGuid -ErrorAction Stop)
        $parsed = [guid]::Empty
        if (-not [guid]::TryParse($machineGuid, [ref]$parsed) -or $parsed -eq [guid]::Empty) {
            throw 'invalid machine guid'
        }
        return Get-DysonQualificationV2Sha256 -Value ('windows-machine-guid-v2:' + $parsed.ToString('D').ToLowerInvariant())
    }
    catch { Throw-DysonQualificationV2Error -Code 'DYSON_QUALIFICATION_V2_HOST_IDENTITY_UNAVAILABLE' }
}

function Test-DysonQualificationV2ProductionHostIdentity {
    param([Parameter(Mandatory)][string]$ExpectedIdentity)
    return (Get-DysonQualificationV2ProductionHostIdentity) -ceq $ExpectedIdentity
}

function Assert-DysonQualificationV2ProductionHostIdentity {
    param([Parameter(Mandatory)][string]$ExpectedIdentity)
    if (-not (Test-DysonQualificationV2ProductionHostIdentity -ExpectedIdentity $ExpectedIdentity)) {
        Throw-DysonQualificationV2Error -Code 'DYSON_QUALIFICATION_V2_HOST_IDENTITY_MISMATCH'
    }
}

function Get-DysonQualificationV2FileSha256 {
    param([Parameter(Mandatory)][string]$Path)
    $stream = $null
    $sha = $null
    try {
        $item = Get-Item -LiteralPath $Path -Force -ErrorAction Stop
        if ($item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
            Throw-DysonQualificationV2Error -Code 'DYSON_QUALIFICATION_V2_TARGET_IDENTITY_INVALID'
        }
        $stream = New-Object IO.FileStream($item.FullName, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
        $sha = [Security.Cryptography.SHA256]::Create()
        return 'sha256:' + ([BitConverter]::ToString($sha.ComputeHash($stream)).Replace('-', '').ToLowerInvariant())
    }
    catch {
        if ((Get-DysonQualificationV2ErrorCode -Exception $_.Exception) -ceq 'DYSON_QUALIFICATION_V2_TARGET_IDENTITY_INVALID') { throw }
        Throw-DysonQualificationV2Error -Code 'DYSON_QUALIFICATION_V2_TARGET_IDENTITY_INVALID'
    }
    finally {
        if ($null -ne $sha) { $sha.Dispose() }
        if ($null -ne $stream) { $stream.Dispose() }
    }
}

function Read-DysonQualificationV2PidFile {
    param([Parameter(Mandatory)][string]$Path)
    try {
        $item = Get-Item -LiteralPath $Path -Force -ErrorAction Stop
        if ($item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -or
            $item.Length -lt 1 -or $item.Length -gt 32) { throw 'invalid pid file' }
        $text = [IO.File]::ReadAllText($item.FullName, [Text.Encoding]::UTF8).Trim()
        if ($text -cnotmatch '^[1-9][0-9]{0,9}$') { throw 'invalid pid' }
        $pidValue = [int64]$text
        if ($pidValue -lt 4 -or $pidValue -gt [int]::MaxValue) { throw 'invalid pid' }
        return [int]$pidValue
    }
    catch { Throw-DysonQualificationV2Error -Code 'DYSON_QUALIFICATION_V2_PID_FILE_INVALID' }
}

function Get-DysonQualificationV2ExactProcess {
    param(
        [Parameter(Mandatory)][int]$ProcessId,
        [Parameter(Mandatory)][string]$ExecutablePath,
        [Parameter(Mandatory)][string]$ExecutableSha256,
        [Parameter(Mandatory)][string]$CommandLineSha256,
        [switch]$AllowMissing
    )
    $process = Get-Process -Id $ProcessId -ErrorAction SilentlyContinue
    if ($null -eq $process) {
        if ($AllowMissing) { return $null }
        Throw-DysonQualificationV2Error -Code 'DYSON_QUALIFICATION_V2_EXACT_PROCESS_NOT_FOUND'
    }
    try { $observedPath = [IO.Path]::GetFullPath([string]$process.MainModule.FileName).TrimEnd('\') }
    catch { Throw-DysonQualificationV2Error -Code 'DYSON_QUALIFICATION_V2_EXACT_PROCESS_MISMATCH' }
    $expectedPath = [IO.Path]::GetFullPath($ExecutablePath).TrimEnd('\')
    if (-not $observedPath.Equals($expectedPath, [StringComparison]::OrdinalIgnoreCase) -or
        (Get-DysonQualificationV2FileSha256 -Path $expectedPath) -cne $ExecutableSha256) {
        Throw-DysonQualificationV2Error -Code 'DYSON_QUALIFICATION_V2_EXACT_PROCESS_MISMATCH'
    }
    try {
        $instances = @(Get-CimInstance -ClassName Win32_Process -Filter ('ProcessId = ' + [string]$ProcessId) `
            -ErrorAction Stop)
        if ($instances.Count -ne 1 -or [int]$instances[0].ProcessId -ne $ProcessId -or
            [string]::IsNullOrWhiteSpace([string]$instances[0].CommandLine) -or
            (Get-DysonQualificationV2Sha256 -Value ([string]$instances[0].CommandLine)) -cne $CommandLineSha256) {
            throw 'process command line mismatch'
        }
    }
    catch { Throw-DysonQualificationV2Error -Code 'DYSON_QUALIFICATION_V2_EXACT_PROCESS_MISMATCH' }
    return $process
}

function Test-DysonQualificationV2ReadinessFile {
    param(
        [Parameter(Mandatory)][string]$Path,
        [Parameter(Mandatory)]$Request,
        [Parameter(Mandatory)]$Configuration,
        [Parameter(Mandatory)]$Process,
        [Parameter(Mandatory)]$Intent,
        [datetimeoffset]$NowUtc = [datetimeoffset]::UtcNow
    )
    try {
        $item = Get-Item -LiteralPath $Path -Force -ErrorAction Stop
        if ($item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -or
            $item.Length -lt 1 -or $item.Length -gt 65536) { return $false }
        $readiness = [IO.File]::ReadAllText($item.FullName, [Text.Encoding]::UTF8) | ConvertFrom-Json -ErrorAction Stop
        Assert-DysonQualificationV2ExactProperties -Value $readiness -Names @(
            'protocol','schemaVersion','targetId','requestId','processId','processStartedAtUtc',
            'executableSha256','commandLineSha256','releaseSha256','runtimeSha256','sequence',
            'intentSha256','writtenAtUtc','readinessSha256'
        ) -Code 'DYSON_QUALIFICATION_V2_READINESS_INVALID'
        $processStarted = ConvertTo-DysonQualificationV2Utc -Value ([datetimeoffset]$Process.StartTime)
        $intentCreated = ConvertFrom-DysonQualificationV2Utc -Value ([string]$Intent.createdAtUtc) `
            -Code 'DYSON_QUALIFICATION_V2_READINESS_INVALID'
        $written = ConvertFrom-DysonQualificationV2Utc -Value ([string]$readiness.writtenAtUtc) `
            -Code 'DYSON_QUALIFICATION_V2_READINESS_INVALID'
        if ([string]$readiness.protocol -cne 'DYSON_QUALIFICATION_PROCESS_READINESS_V2' -or
            -not (Test-DysonQualificationV2Integer -Value $readiness.schemaVersion) -or
            [int]$readiness.schemaVersion -ne 2 -or
            [string]$readiness.targetId -cne [string]$Configuration.targetId -or
            [string]$readiness.requestId -cne [string]$Request.requestId -or
            -not (Test-DysonQualificationV2Integer -Value $readiness.processId) -or
            [int]$readiness.processId -ne [int]$Process.Id -or
            [string]$readiness.processStartedAtUtc -cne $processStarted -or
            [string]$readiness.executableSha256 -cne [string]$Configuration.executableSha256 -or
            [string]$readiness.commandLineSha256 -cne [string]$Configuration.commandLineSha256 -or
            [string]$readiness.releaseSha256 -cne [string]$Configuration.releaseSha256 -or
            [string]$readiness.runtimeSha256 -cne [string]$Configuration.runtimeSha256 -or
            -not (Test-DysonQualificationV2Integer -Value $readiness.sequence) -or
            [int64]$readiness.sequence -ne [int64]$Intent.sequence -or
            [string]$readiness.intentSha256 -cne [string]$Intent.intentSha256 -or
            $written -lt $intentCreated.AddSeconds(-5) -or $written -gt $NowUtc.AddMinutes(1) -or
            -not (Test-DysonQualificationV2Digest -Value ([string]$readiness.readinessSha256))) {
            return $false
        }
        $expected = Get-DysonQualificationV2ObjectDigest -Value (
            Get-DysonQualificationV2UnsignedValue -Value $readiness -DigestProperty 'readinessSha256'
        )
        return [string]$readiness.readinessSha256 -ceq $expected
    }
    catch { return $false }
}

function Get-DysonQualificationV2ExactScheduledTask {
    param(
        [Parameter(Mandatory)][string]$TaskIdentity,
        [Parameter(Mandatory)][string]$ExpectedSha256
    )
    try {
        $lastSeparator = $TaskIdentity.LastIndexOf('\')
        if ($lastSeparator -lt 0 -or $lastSeparator -ge ($TaskIdentity.Length - 1)) {
            throw 'invalid task identity'
        }
        $taskPath = $TaskIdentity.Substring(0, $lastSeparator + 1)
        $taskName = $TaskIdentity.Substring($lastSeparator + 1)
        $tasks = @(Get-ScheduledTask -TaskPath $taskPath -TaskName $taskName -ErrorAction Stop)
        if ($tasks.Count -ne 1 -or
            -not ([string]$tasks[0].TaskPath).Equals($taskPath, [StringComparison]::OrdinalIgnoreCase) -or
            -not ([string]$tasks[0].TaskName).Equals($taskName, [StringComparison]::OrdinalIgnoreCase)) {
            throw 'task identity mismatch'
        }
        $taskXml = [string](Export-ScheduledTask -TaskPath $taskPath -TaskName $taskName -ErrorAction Stop)
        if ((Get-DysonQualificationV2Sha256 -Value $taskXml) -cne $ExpectedSha256) {
            throw 'task definition mismatch'
        }
        return $tasks[0]
    }
    catch { Throw-DysonQualificationV2Error -Code 'DYSON_QUALIFICATION_V2_SCHEDULED_TASK_MISMATCH' }
}

function Start-DysonQualificationV2ExactScheduledTask {
    param(
        [Parameter(Mandatory)][string]$TaskIdentity,
        [Parameter(Mandatory)][string]$ExpectedSha256
    )
    $task = Get-DysonQualificationV2ExactScheduledTask `
        -TaskIdentity $TaskIdentity -ExpectedSha256 $ExpectedSha256
    Start-ScheduledTask -InputObject $task -ErrorAction Stop
}

function Wait-DysonQualificationV2ReplacementProcess {
    param(
        [Parameter(Mandatory)]$Request,
        [Parameter(Mandatory)]$Configuration,
        [Parameter(Mandatory)]$Intent,
        [Parameter(Mandatory)][int]$PreviousPid,
        [Parameter(Mandatory)][datetimeoffset]$DeadlineUtc
    )
    do {
        if ([datetimeoffset]::UtcNow -gt $DeadlineUtc) {
            Throw-DysonQualificationV2Error -Code 'DYSON_QUALIFICATION_V2_ACTION_TIMEOUT'
        }
        try { $currentPid = Read-DysonQualificationV2PidFile -Path ([string]$Configuration.pidFilePath) }
        catch { $currentPid = 0 }
        if ($currentPid -ge 4 -and $currentPid -ne $PreviousPid) {
            try {
                $process = Get-DysonQualificationV2ExactProcess -ProcessId $currentPid `
                    -ExecutablePath ([string]$Configuration.executablePath) `
                    -ExecutableSha256 ([string]$Configuration.executableSha256) `
                    -CommandLineSha256 ([string]$Configuration.commandLineSha256)
                if ($null -ne $process -and (Test-DysonQualificationV2ReadinessFile `
                    -Path ([string]$Configuration.readinessFilePath) -Request $Request `
                    -Configuration $Configuration -Process $process -Intent $Intent)) {
                    return $currentPid
                }
            }
            catch { }
        }
        Start-Sleep -Milliseconds 500
    } while ($true)
}

function Get-DysonQualificationV2Mapping {
    param([Parameter(Mandatory)]$Configuration, [switch]$AllowMissing)
    try {
        $mappings = @(Get-SmbGlobalMapping -LocalPath ([string]$Configuration.localPath) -ErrorAction Stop)
    }
    catch { Throw-DysonQualificationV2Error -Code 'DYSON_QUALIFICATION_V2_STORAGE_OBSERVATION_FAILED' }
    if ($mappings.Count -eq 0) {
        if ($AllowMissing) { return $null }
        Throw-DysonQualificationV2Error -Code 'DYSON_QUALIFICATION_V2_STORAGE_DEPENDENCY_NOT_FOUND'
    }
    if ($mappings.Count -ne 1 -or
        [string]$mappings[0].LocalPath -cne [string]$Configuration.localPath -or
        [string]$mappings[0].RemotePath -cne [string]$Configuration.remotePath) {
        Throw-DysonQualificationV2Error -Code 'DYSON_QUALIFICATION_V2_STORAGE_DEPENDENCY_MISMATCH'
    }
    return $mappings[0]
}

function Wait-DysonQualificationV2MappingRestored {
    param([Parameter(Mandatory)]$Configuration, [Parameter(Mandatory)][datetimeoffset]$DeadlineUtc)
    do {
        if ([datetimeoffset]::UtcNow -gt $DeadlineUtc) {
            Throw-DysonQualificationV2Error -Code 'DYSON_QUALIFICATION_V2_STORAGE_RECOVERY_DEADLINE_EXCEEDED'
        }
        $mapping = Get-DysonQualificationV2Mapping -Configuration $Configuration -AllowMissing
        if ($null -ne $mapping) { return $true }
        Start-Sleep -Milliseconds 500
    } while ($true)
}

function Assert-DysonQualificationV2PrivateEvidenceAcl {
    param([Parameter(Mandatory)][string]$Path)
    try {
        # Read through the framework API so the production verifier does not
        # depend on PowerShell module auto-loading in reduced service/npm
        # environments.
        $acl = ([IO.DirectoryInfo]::new($Path)).GetAccessControl()
        if (-not [bool]$acl.AreAccessRulesProtected) {
            throw 'private evidence ACL inheritance is enabled'
        }
        $currentSid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
        $approvedWriterSids = @(
            $currentSid,
            'S-1-5-18',
            'S-1-5-32-544'
        ) | Select-Object -Unique
        $ownerSid = $acl.GetOwner([Security.Principal.SecurityIdentifier]).Value
        if ($approvedWriterSids -cnotcontains $ownerSid) {
            throw 'private evidence owner is not approved'
        }
        $writeMask = [Security.AccessControl.FileSystemRights]::WriteData -bor
            [Security.AccessControl.FileSystemRights]::AppendData -bor
            [Security.AccessControl.FileSystemRights]::WriteExtendedAttributes -bor
            [Security.AccessControl.FileSystemRights]::WriteAttributes -bor
            [Security.AccessControl.FileSystemRights]::DeleteSubdirectoriesAndFiles -bor
            [Security.AccessControl.FileSystemRights]::Delete -bor
            [Security.AccessControl.FileSystemRights]::ChangePermissions -bor
            [Security.AccessControl.FileSystemRights]::TakeOwnership
        foreach ($rule in @($acl.Access)) {
            if ([bool]$rule.IsInherited) {
                throw 'private evidence contains an inherited access rule'
            }
            if ($rule.AccessControlType -ne [Security.AccessControl.AccessControlType]::Allow) { continue }
            $sid = $rule.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value
            if (($approvedWriterSids -cnotcontains $sid) -and
                ([int64]$rule.FileSystemRights -band [int64]$writeMask) -ne 0) {
                throw 'private evidence is writable by an unapproved principal'
            }
        }
        return $true
    }
    catch { Throw-DysonQualificationV2Error -Code 'DYSON_QUALIFICATION_V2_PROTECTION_EVIDENCE_INVALID' }
}

function Assert-DysonQualificationV2PrivateEvidenceArtifact {
    param(
        [Parameter(Mandatory)][string]$Path,
        [Parameter(Mandatory)][string]$ExpectedSha256,
        [Parameter(Mandatory)]$Profile
    )
    try {
        if (-not (Test-DysonQualificationV2LocalAbsolutePath -Value $Path) -or
            -not (Test-DysonQualificationV2Digest -Value $ExpectedSha256)) { throw 'invalid artifact reference' }
        $full = Assert-DysonQualificationV2ExistingLocalPathChain `
            -Path $Path -Code 'DYSON_QUALIFICATION_V2_PROTECTION_EVIDENCE_INVALID'
        $insideProtectedRoot = $false
        foreach ($protectedRoot in @($Profile.protectedRoots)) {
            if (Test-DysonQualificationV2PathWithin -Candidate $full -Parent ([string]$protectedRoot)) {
                $insideProtectedRoot = $true
                break
            }
        }
        if (-not $insideProtectedRoot -or (Get-DysonQualificationV2FileSha256 -Path $full) -cne $ExpectedSha256) {
            throw 'artifact identity mismatch'
        }
        return $full
    }
    catch {
        if ((Get-DysonQualificationV2ErrorCode -Exception $_.Exception) -ceq `
            'DYSON_QUALIFICATION_V2_PROTECTION_EVIDENCE_INVALID') { throw }
        Throw-DysonQualificationV2Error -Code 'DYSON_QUALIFICATION_V2_PROTECTION_EVIDENCE_INVALID'
    }
}

function Assert-DysonQualificationV2ProductionProtectionEvidence {
    param(
        [Parameter(Mandatory)]$Paths,
        [Parameter(Mandatory)]$Profile,
        [Parameter(Mandatory)]$Request,
        [Parameter(Mandatory)][datetimeoffset]$NowUtc,
        [switch]$AllowExpired
    )
    try {
        $directoryPath = Join-Path ([string]$Paths.store) 'private-protection-points'
        $directory = Get-Item -LiteralPath $directoryPath -Force -ErrorAction Stop
        if (-not $directory.PSIsContainer -or ($directory.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
            throw 'invalid private evidence directory'
        }
        [void](Assert-DysonQualificationV2PrivateEvidenceAcl -Path $directory.FullName)
        $recordPath = Join-Path $directory.FullName (
            [string]$Request.protectionPoint.protectionPointId + '.evidence.json'
        )
        $record = Read-DysonQualificationV2JsonFile -Path $recordPath -MaximumBytes 131072
        Assert-DysonQualificationV2ExactProperties -Value $record -Names @(
            'protocol','schemaVersion','protectionPointId','profileId','profileSha256','targetIdentity',
            'requestId','requestDigest','approvalId','action','actionTargetId','executionScope','previewSha256',
            'createdAtUtc','expiresAtUtc','saveDataPath','saveDataSha256','serverDataPath','serverDataSha256',
            'savePairSha256','evidencePath','evidenceSha256','recordSha256'
        ) -Code 'DYSON_QUALIFICATION_V2_PROTECTION_EVIDENCE_INVALID'
        $created = ConvertFrom-DysonQualificationV2Utc -Value ([string]$record.createdAtUtc) `
            -Code 'DYSON_QUALIFICATION_V2_PROTECTION_EVIDENCE_INVALID'
        $expires = ConvertFrom-DysonQualificationV2Utc -Value ([string]$record.expiresAtUtc) `
            -Code 'DYSON_QUALIFICATION_V2_PROTECTION_EVIDENCE_INVALID'
        if ([string]$record.protocol -cne 'DYSON_QUALIFICATION_PRIVATE_PROTECTION_EVIDENCE_V2' -or
            -not (Test-DysonQualificationV2Integer -Value $record.schemaVersion) -or [int]$record.schemaVersion -ne 2 -or
            [string]$record.protectionPointId -cne [string]$Request.protectionPoint.protectionPointId -or
            [string]$record.profileId -cne [string]$Profile.profileId -or
            [string]$record.profileSha256 -cne (Get-DysonQualificationV2ProfileDigest -Profile $Profile) -or
            [string]$record.targetIdentity -cne [string]$Profile.targetIdentity -or
            [string]$record.requestId -cne [string]$Request.requestId -or
            [string]$record.requestDigest -cne (Get-DysonQualificationV2RequestDigest -Request $Request) -or
            [string]$record.approvalId -cne [string]$Request.approvalId -or
            [string]$record.action -cne [string]$Request.action -or
            [string]$record.actionTargetId -cne [string]$Request.actionTargetId -or
            [string]$record.executionScope -cne 'production' -or
            [string]$record.previewSha256 -cne [string]$Request.previewSha256 -or
            [string]$record.createdAtUtc -cne [string]$Request.protectionPoint.createdAtUtc -or
            [string]$record.expiresAtUtc -cne [string]$Request.protectionPoint.expiresAtUtc -or
            $created -gt $NowUtc.AddMinutes(1) -or (-not $AllowExpired -and $expires -lt $NowUtc) -or
            -not (Test-DysonQualificationV2Digest -Value ([string]$record.recordSha256))) {
            throw 'private evidence binding mismatch'
        }
        $saveDataPath = Assert-DysonQualificationV2PrivateEvidenceArtifact -Path ([string]$record.saveDataPath) `
            -ExpectedSha256 ([string]$record.saveDataSha256) -Profile $Profile
        $serverDataPath = Assert-DysonQualificationV2PrivateEvidenceArtifact -Path ([string]$record.serverDataPath) `
            -ExpectedSha256 ([string]$record.serverDataSha256) -Profile $Profile
        $evidencePath = Assert-DysonQualificationV2PrivateEvidenceArtifact -Path ([string]$record.evidencePath) `
            -ExpectedSha256 ([string]$record.evidenceSha256) -Profile $Profile
        if ([IO.Path]::GetExtension($saveDataPath) -ine '.dsv' -or
            [IO.Path]::GetExtension($serverDataPath) -ine '.server' -or
            [IO.Path]::GetFileNameWithoutExtension($saveDataPath) -ine [IO.Path]::GetFileNameWithoutExtension($serverDataPath) -or
            $saveDataPath -ieq $serverDataPath -or $saveDataPath -ieq $evidencePath -or $serverDataPath -ieq $evidencePath) {
            throw 'private evidence artifacts are not an exact save pair plus independent evidence'
        }
        $pairDigest = Get-DysonQualificationV2ObjectDigest -Value ([pscustomobject][ordered]@{
            protocol = 'DYSON_QUALIFICATION_SAVE_PAIR_DIGEST_V2'
            saveDataSha256 = [string]$record.saveDataSha256
            serverDataSha256 = [string]$record.serverDataSha256
        })
        if ([string]$record.savePairSha256 -cne $pairDigest -or
            [string]$record.savePairSha256 -cne [string]$Request.protectionPoint.savePairSha256 -or
            [string]$record.evidenceSha256 -cne [string]$Request.protectionPoint.evidenceSha256) {
            throw 'private evidence digest mismatch'
        }
        $recordDigest = Get-DysonQualificationV2ObjectDigest -Value (
            Get-DysonQualificationV2UnsignedValue -Value $record -DigestProperty 'recordSha256'
        )
        if ([string]$record.recordSha256 -cne $recordDigest) { throw 'private evidence self digest mismatch' }
        return $true
    }
    catch {
        if ((Get-DysonQualificationV2ErrorCode -Exception $_.Exception) -ceq `
            'DYSON_QUALIFICATION_V2_PROTECTION_EVIDENCE_INVALID') { throw }
        Throw-DysonQualificationV2Error -Code 'DYSON_QUALIFICATION_V2_PROTECTION_EVIDENCE_INVALID'
    }
}

function Get-DysonQualificationV2DiskCapacity {
    param([Parameter(Mandatory)][string]$VolumeRoot)
    $drive = New-Object IO.DriveInfo($VolumeRoot.Substring(0, 1))
    if (-not $drive.IsReady -or $drive.DriveType -ne [IO.DriveType]::Fixed -or $drive.TotalSize -le 0) {
        Throw-DysonQualificationV2Error -Code 'DYSON_QUALIFICATION_V2_DISK_CAPACITY_UNAVAILABLE'
    }
    $used = [int64]$drive.TotalSize - [int64]$drive.AvailableFreeSpace
    $usedPercent = [decimal]$used * 100 / [decimal]$drive.TotalSize
    return [pscustomobject][ordered]@{
        totalBytes = [int64]$drive.TotalSize
        freeBytes = [int64]$drive.AvailableFreeSpace
        usedPercent = [decimal]$usedPercent
    }
}

function Get-DysonQualificationV2PressureFilePath {
    param([Parameter(Mandatory)]$Request, [Parameter(Mandatory)]$Configuration)
    return Join-Path ([string]$Configuration.directoryPath) ('pressure-' + [string]$Request.requestId + '.bin')
}

function Assert-DysonQualificationV2DisposableDirectory {
    param(
        [Parameter(Mandatory)]$Configuration,
        [AllowNull()][string]$AllowedPressureFile
    )
    try {
        $volumeRoot = [IO.Path]::GetFullPath([string]$Configuration.volumeRoot)
        $directoryPath = [IO.Path]::GetFullPath([string]$Configuration.directoryPath).TrimEnd('\')
        if (-not (Test-DysonQualificationV2PathWithin -Candidate $directoryPath -Parent $volumeRoot) -or
            -not ([IO.Path]::GetPathRoot($directoryPath)).Equals($volumeRoot, [StringComparison]::OrdinalIgnoreCase)) {
            throw 'directory volume mismatch'
        }
        $current = $volumeRoot
        $relative = $directoryPath.Substring($volumeRoot.Length).TrimStart('\')
        foreach ($part in @($relative -split '\\' | Where-Object { $_.Length -gt 0 })) {
            $current = Join-Path $current $part
            $component = Get-Item -LiteralPath $current -Force -ErrorAction Stop
            if ($component.Attributes -band [IO.FileAttributes]::ReparsePoint) {
                throw 'redirected directory component'
            }
        }
        $directory = Get-Item -LiteralPath $directoryPath -Force -ErrorAction Stop
        if (-not $directory.PSIsContainer -or
            ($directory.Attributes -band [IO.FileAttributes]::ReparsePoint) -or
            ($directory.Attributes -band [IO.FileAttributes]::Compressed)) {
            throw 'invalid directory'
        }
        $markerPath = Join-Path $directory.FullName '.dyson-qualification-disposable'
        $marker = Get-Item -LiteralPath $markerPath -Force -ErrorAction Stop
        if ($marker.PSIsContainer -or ($marker.Attributes -band [IO.FileAttributes]::ReparsePoint) -or
            $marker.Length -gt 128 -or
            [IO.File]::ReadAllText($marker.FullName, [Text.Encoding]::UTF8).Trim() -cne [string]$Configuration.markerValue) {
            throw 'invalid marker'
        }
        foreach ($child in @(Get-ChildItem -LiteralPath $directory.FullName -Force -ErrorAction Stop)) {
            if ($child.FullName -ceq $marker.FullName) { continue }
            if (-not [string]::IsNullOrEmpty($AllowedPressureFile) -and
                $child.FullName.Equals($AllowedPressureFile, [StringComparison]::OrdinalIgnoreCase) -and
                -not $child.PSIsContainer -and -not ($child.Attributes -band [IO.FileAttributes]::ReparsePoint)) { continue }
            Throw-DysonQualificationV2Error -Code 'DYSON_QUALIFICATION_V2_DISPOSABLE_DIRECTORY_NOT_EMPTY'
        }
        return $directory.FullName
    }
    catch {
        $observed = Get-DysonQualificationV2ErrorCode -Exception $_.Exception
        if ($observed -ceq 'DYSON_QUALIFICATION_V2_DISPOSABLE_DIRECTORY_NOT_EMPTY') { throw }
        Throw-DysonQualificationV2Error -Code 'DYSON_QUALIFICATION_V2_DISPOSABLE_DIRECTORY_INVALID'
    }
}

function Invoke-DysonQualificationV2ProductionInspect {
    param(
        [Parameter(Mandatory)]$Request,
        [Parameter(Mandatory)]$Configuration,
        [Parameter(Mandatory)]$Intent
    )
    switch ([string]$Request.action) {
        'control-plane-restart' {
            $expectedPid = [int]$Request.parameters.expectedPid
            $old = Get-DysonQualificationV2ExactProcess -ProcessId $expectedPid `
                -ExecutablePath ([string]$Configuration.executablePath) `
                -ExecutableSha256 ([string]$Configuration.executableSha256) `
                -CommandLineSha256 ([string]$Configuration.commandLineSha256) -AllowMissing
            if ($null -ne $old) { return [pscustomobject]@{ state = 'safe-terminal'; outcomeCode = 'ACTION_NOT_APPLIED_SAFE' } }
            try {
                $currentPid = Read-DysonQualificationV2PidFile -Path ([string]$Configuration.pidFilePath)
                $current = Get-DysonQualificationV2ExactProcess -ProcessId $currentPid `
                    -ExecutablePath ([string]$Configuration.executablePath) `
                    -ExecutableSha256 ([string]$Configuration.executableSha256) `
                    -CommandLineSha256 ([string]$Configuration.commandLineSha256)
                if ($null -ne $current -and $currentPid -ne $expectedPid -and
                    (Test-DysonQualificationV2ReadinessFile -Path ([string]$Configuration.readinessFilePath) `
                        -Request $Request -Configuration $Configuration -Process $current -Intent $Intent)) {
                    return [pscustomobject]@{ state = 'completed'; outcomeCode = 'CONTROL_PLANE_RESTART_VERIFIED' }
                }
            }
            catch { }
            return [pscustomobject]@{ state = 'needs-compensation'; outcomeCode = 'CONTROL_PLANE_RECOVERY_REQUIRED' }
        }
        'dsp-crash-recovery' {
            $expectedPid = [int]$Request.parameters.expectedPid
            $old = Get-DysonQualificationV2ExactProcess -ProcessId $expectedPid `
                -ExecutablePath ([string]$Configuration.executablePath) `
                -ExecutableSha256 ([string]$Configuration.executableSha256) `
                -CommandLineSha256 ([string]$Configuration.commandLineSha256) -AllowMissing
            if ($null -ne $old) { return [pscustomobject]@{ state = 'safe-terminal'; outcomeCode = 'ACTION_NOT_APPLIED_SAFE' } }
            try {
                $currentPid = Read-DysonQualificationV2PidFile -Path ([string]$Configuration.pidFilePath)
                $current = Get-DysonQualificationV2ExactProcess -ProcessId $currentPid `
                    -ExecutablePath ([string]$Configuration.executablePath) `
                    -ExecutableSha256 ([string]$Configuration.executableSha256) `
                    -CommandLineSha256 ([string]$Configuration.commandLineSha256)
                if ($null -ne $current -and $currentPid -ne $expectedPid -and
                    (Test-DysonQualificationV2ReadinessFile -Path ([string]$Configuration.readinessFilePath) `
                        -Request $Request -Configuration $Configuration -Process $current -Intent $Intent)) {
                    return [pscustomobject]@{ state = 'completed'; outcomeCode = 'DSP_CRASH_RECOVERY_VERIFIED' }
                }
            }
            catch { }
            return [pscustomobject]@{ state = 'needs-compensation'; outcomeCode = 'DSP_RECOVERY_REQUIRED' }
        }
        'storage-interruption' {
            $mapping = Get-DysonQualificationV2Mapping -Configuration $Configuration -AllowMissing
            if ($null -ne $mapping) { return [pscustomobject]@{ state = 'safe-terminal'; outcomeCode = 'STORAGE_AVAILABLE' } }
            return [pscustomobject]@{ state = 'needs-compensation'; outcomeCode = 'STORAGE_RECOVERY_REQUIRED' }
        }
        'disk-pressure' {
            $allocation = Get-DysonQualificationV2PressureFilePath -Request $Request -Configuration $Configuration
            [void](Assert-DysonQualificationV2DisposableDirectory -Configuration $Configuration -AllowedPressureFile $allocation)
            if (Test-Path -LiteralPath $allocation -PathType Leaf) {
                return [pscustomobject]@{ state = 'needs-compensation'; outcomeCode = 'DISK_PRESSURE_CLEANUP_REQUIRED' }
            }
            return [pscustomobject]@{ state = 'safe-terminal'; outcomeCode = 'DISK_PRESSURE_ABSENT' }
        }
    }
}

function Invoke-DysonQualificationV2ProductionCompensate {
    param(
        [Parameter(Mandatory)]$Request,
        [Parameter(Mandatory)]$Configuration,
        [Parameter(Mandatory)][datetimeoffset]$DeadlineUtc,
        [Parameter(Mandatory)]$Intent
    )
    try {
        switch ([string]$Request.action) {
            'control-plane-restart' {
                $old = Get-DysonQualificationV2ExactProcess `
                    -ProcessId ([int]$Request.parameters.expectedPid) `
                    -ExecutablePath ([string]$Configuration.executablePath) `
                    -ExecutableSha256 ([string]$Configuration.executableSha256) `
                    -CommandLineSha256 ([string]$Configuration.commandLineSha256) -AllowMissing
                if ($null -ne $old) {
                    return [pscustomobject]@{ success = $true; outcomeCode = 'CONTROL_PLANE_ACTION_NOT_APPLIED_SAFE' }
                }
                try { $currentPid = Read-DysonQualificationV2PidFile -Path ([string]$Configuration.pidFilePath) }
                catch {
                    if ((Get-DysonQualificationV2ErrorCode -Exception $_.Exception) -cne 'DYSON_QUALIFICATION_V2_PID_FILE_INVALID') { throw }
                    $currentPid = 0
                }
                if ($currentPid -ge 4 -and $currentPid -ne [int]$Request.parameters.expectedPid) {
                    $current = Get-DysonQualificationV2ExactProcess -ProcessId $currentPid `
                        -ExecutablePath ([string]$Configuration.executablePath) `
                        -ExecutableSha256 ([string]$Configuration.executableSha256) `
                        -CommandLineSha256 ([string]$Configuration.commandLineSha256) -AllowMissing
                    if ($null -ne $current) {
                        if (Test-DysonQualificationV2ReadinessFile `
                            -Path ([string]$Configuration.readinessFilePath) -Request $Request `
                            -Configuration $Configuration -Process $current -Intent $Intent) {
                            return [pscustomobject]@{ success = $true; outcomeCode = 'CONTROL_PLANE_COMPENSATION_VERIFIED' }
                        }
                        return [pscustomobject]@{ success = $false; outcomeCode = 'COMPENSATION_FAILED' }
                    }
                }
                Start-DysonQualificationV2ExactScheduledTask `
                    -TaskIdentity ([string]$Configuration.startTaskName) `
                    -ExpectedSha256 ([string]$Configuration.startTaskSha256)
                [void](Wait-DysonQualificationV2ReplacementProcess -Configuration $Configuration `
                    -Request $Request -Intent $Intent -PreviousPid ([int]$Request.parameters.expectedPid) `
                    -DeadlineUtc $DeadlineUtc)
                return [pscustomobject]@{ success = $true; outcomeCode = 'CONTROL_PLANE_COMPENSATION_VERIFIED' }
            }
            'dsp-crash-recovery' {
                $old = Get-DysonQualificationV2ExactProcess `
                    -ProcessId ([int]$Request.parameters.expectedPid) `
                    -ExecutablePath ([string]$Configuration.executablePath) `
                    -ExecutableSha256 ([string]$Configuration.executableSha256) `
                    -CommandLineSha256 ([string]$Configuration.commandLineSha256) -AllowMissing
                if ($null -ne $old) {
                    return [pscustomobject]@{ success = $true; outcomeCode = 'DSP_ACTION_NOT_APPLIED_SAFE' }
                }
                try { $currentPid = Read-DysonQualificationV2PidFile -Path ([string]$Configuration.pidFilePath) }
                catch {
                    if ((Get-DysonQualificationV2ErrorCode -Exception $_.Exception) -cne 'DYSON_QUALIFICATION_V2_PID_FILE_INVALID') { throw }
                    $currentPid = 0
                }
                if ($currentPid -ge 4 -and $currentPid -ne [int]$Request.parameters.expectedPid) {
                    $current = Get-DysonQualificationV2ExactProcess -ProcessId $currentPid `
                        -ExecutablePath ([string]$Configuration.executablePath) `
                        -ExecutableSha256 ([string]$Configuration.executableSha256) `
                        -CommandLineSha256 ([string]$Configuration.commandLineSha256) -AllowMissing
                    if ($null -ne $current) {
                        if (Test-DysonQualificationV2ReadinessFile `
                            -Path ([string]$Configuration.readinessFilePath) -Request $Request `
                            -Configuration $Configuration -Process $current -Intent $Intent) {
                            return [pscustomobject]@{ success = $true; outcomeCode = 'DSP_COMPENSATION_VERIFIED' }
                        }
                        return [pscustomobject]@{ success = $false; outcomeCode = 'COMPENSATION_FAILED' }
                    }
                }
                Start-DysonQualificationV2ExactScheduledTask `
                    -TaskIdentity ([string]$Configuration.startTaskName) `
                    -ExpectedSha256 ([string]$Configuration.startTaskSha256)
                [void](Wait-DysonQualificationV2ReplacementProcess -Configuration $Configuration `
                    -Request $Request -Intent $Intent -PreviousPid ([int]$Request.parameters.expectedPid) `
                    -DeadlineUtc $DeadlineUtc)
                return [pscustomobject]@{ success = $true; outcomeCode = 'DSP_COMPENSATION_VERIFIED' }
            }
            'storage-interruption' {
                try { $mapping = Get-DysonQualificationV2Mapping -Configuration $Configuration -AllowMissing }
                catch {
                    if ((Get-DysonQualificationV2ErrorCode -Exception $_.Exception) -ceq `
                        'DYSON_QUALIFICATION_V2_STORAGE_OBSERVATION_FAILED') {
                        return [pscustomobject]@{ success = $false; outcomeCode = 'STORAGE_OBSERVATION_FAILED' }
                    }
                    throw
                }
                if ($null -ne $mapping) {
                    return [pscustomobject]@{ success = $true; outcomeCode = 'STORAGE_COMPENSATION_VERIFIED' }
                }
                Start-DysonQualificationV2ExactScheduledTask `
                    -TaskIdentity ([string]$Configuration.restoreTaskName) `
                    -ExpectedSha256 ([string]$Configuration.restoreTaskSha256)
                try {
                    [void](Wait-DysonQualificationV2MappingRestored -Configuration $Configuration -DeadlineUtc $DeadlineUtc)
                }
                catch {
                    if ((Get-DysonQualificationV2ErrorCode -Exception $_.Exception) -ceq `
                        'DYSON_QUALIFICATION_V2_STORAGE_OBSERVATION_FAILED') {
                        return [pscustomobject]@{ success = $false; outcomeCode = 'STORAGE_OBSERVATION_FAILED' }
                    }
                    throw
                }
                return [pscustomobject]@{ success = $true; outcomeCode = 'STORAGE_COMPENSATION_VERIFIED' }
            }
            'disk-pressure' {
                $allocation = Get-DysonQualificationV2PressureFilePath -Request $Request -Configuration $Configuration
                [void](Assert-DysonQualificationV2DisposableDirectory -Configuration $Configuration -AllowedPressureFile $allocation)
                if (Test-Path -LiteralPath $allocation -PathType Leaf) { [IO.File]::Delete($allocation) }
                [void](Assert-DysonQualificationV2DisposableDirectory -Configuration $Configuration -AllowedPressureFile $null)
                $capacity = Get-DysonQualificationV2DiskCapacity -VolumeRoot ([string]$Configuration.volumeRoot)
                if ($capacity.freeBytes -lt [int64]$Configuration.minimumFreeBytes -or
                    $capacity.usedPercent -gt [decimal]$Configuration.maximumUsedPercent) {
                    Throw-DysonQualificationV2Error -Code 'DYSON_QUALIFICATION_V2_DISK_SAFETY_FLOOR_VIOLATED'
                }
                return [pscustomobject]@{ success = $true; outcomeCode = 'DISK_PRESSURE_COMPENSATION_VERIFIED' }
            }
        }
    }
    catch { return [pscustomobject]@{ success = $false; outcomeCode = 'COMPENSATION_FAILED' } }
}

function Invoke-DysonQualificationV2ProductionExecute {
    param(
        [Parameter(Mandatory)]$Request,
        [Parameter(Mandatory)]$Configuration,
        [Parameter(Mandatory)][datetimeoffset]$DeadlineUtc,
        [Parameter(Mandatory)]$Intent
    )
    switch ([string]$Request.action) {
        'control-plane-restart' {
            $expectedPid = [int]$Request.parameters.expectedPid
            if ((Read-DysonQualificationV2PidFile -Path ([string]$Configuration.pidFilePath)) -ne $expectedPid) {
                Throw-DysonQualificationV2Error -Code 'DYSON_QUALIFICATION_V2_PID_FILE_MISMATCH'
            }
            $exactProcess = Get-DysonQualificationV2ExactProcess -ProcessId $expectedPid `
                -ExecutablePath ([string]$Configuration.executablePath) `
                -ExecutableSha256 ([string]$Configuration.executableSha256) `
                -CommandLineSha256 ([string]$Configuration.commandLineSha256)
            if ([int]$exactProcess.Id -ne $expectedPid) {
                Throw-DysonQualificationV2Error -Code 'DYSON_QUALIFICATION_V2_EXACT_PROCESS_MISMATCH'
            }
            if ((Read-DysonQualificationV2PidFile -Path ([string]$Configuration.pidFilePath)) -ne $expectedPid) {
                Throw-DysonQualificationV2Error -Code 'DYSON_QUALIFICATION_V2_PID_FILE_MISMATCH'
            }
            Stop-Process -InputObject $exactProcess -Force -ErrorAction Stop
            Start-DysonQualificationV2ExactScheduledTask `
                -TaskIdentity ([string]$Configuration.startTaskName) `
                -ExpectedSha256 ([string]$Configuration.startTaskSha256)
            [void](Wait-DysonQualificationV2ReplacementProcess -Configuration $Configuration `
                -Request $Request -Intent $Intent -PreviousPid $expectedPid -DeadlineUtc $DeadlineUtc)
            return [pscustomobject]@{ success = $true; outcomeCode = 'CONTROL_PLANE_RESTART_VERIFIED' }
        }
        'dsp-crash-recovery' {
            $expectedPid = [int]$Request.parameters.expectedPid
            if ((Read-DysonQualificationV2PidFile -Path ([string]$Configuration.pidFilePath)) -ne $expectedPid) {
                Throw-DysonQualificationV2Error -Code 'DYSON_QUALIFICATION_V2_PID_FILE_MISMATCH'
            }
            $exactProcess = Get-DysonQualificationV2ExactProcess -ProcessId $expectedPid `
                -ExecutablePath ([string]$Configuration.executablePath) `
                -ExecutableSha256 ([string]$Configuration.executableSha256) `
                -CommandLineSha256 ([string]$Configuration.commandLineSha256)
            if ([int]$exactProcess.Id -ne $expectedPid) {
                Throw-DysonQualificationV2Error -Code 'DYSON_QUALIFICATION_V2_EXACT_PROCESS_MISMATCH'
            }
            if ((Read-DysonQualificationV2PidFile -Path ([string]$Configuration.pidFilePath)) -ne $expectedPid) {
                Throw-DysonQualificationV2Error -Code 'DYSON_QUALIFICATION_V2_PID_FILE_MISMATCH'
            }
            Stop-Process -InputObject $exactProcess -Force -ErrorAction Stop
            Start-DysonQualificationV2ExactScheduledTask `
                -TaskIdentity ([string]$Configuration.startTaskName) `
                -ExpectedSha256 ([string]$Configuration.startTaskSha256)
            [void](Wait-DysonQualificationV2ReplacementProcess -Configuration $Configuration `
                -Request $Request -Intent $Intent -PreviousPid $expectedPid -DeadlineUtc $DeadlineUtc)
            return [pscustomobject]@{ success = $true; outcomeCode = 'DSP_CRASH_RECOVERY_VERIFIED' }
        }
        'storage-interruption' {
            [void](Get-DysonQualificationV2Mapping -Configuration $Configuration)
            $restored = $false
            $removed = $false
            $recoveryFailureCode = $null
            $recoveryDeadline = $DeadlineUtc
            try {
                if ([datetimeoffset]::UtcNow.AddSeconds([int]$Configuration.maximumInterruptionSeconds) -gt $DeadlineUtc) {
                    Throw-DysonQualificationV2Error -Code 'DYSON_QUALIFICATION_V2_ACTION_TIMEOUT'
                }
                Remove-SmbGlobalMapping -LocalPath ([string]$Configuration.localPath) -Force -ErrorAction Stop
                $removed = $true
                $recoveryDeadline = [datetimeoffset]::UtcNow.AddSeconds(
                    [int]$Configuration.maximumInterruptionSeconds
                )
                if ($recoveryDeadline -gt $DeadlineUtc) { $recoveryDeadline = $DeadlineUtc }
                $stopwatch = [Diagnostics.Stopwatch]::StartNew()
                try {
                    while ($stopwatch.Elapsed.TotalSeconds -lt [int]$Request.parameters.durationSeconds) {
                        if ([datetimeoffset]::UtcNow -gt $DeadlineUtc) {
                            Throw-DysonQualificationV2Error -Code 'DYSON_QUALIFICATION_V2_STORAGE_RECOVERY_DEADLINE_EXCEEDED'
                        }
                        Start-Sleep -Milliseconds 200
                    }
                }
                finally { $stopwatch.Stop() }
            }
            finally {
                if (-not $removed) { $restored = $true }
                else {
                    try {
                        Start-DysonQualificationV2ExactScheduledTask `
                            -TaskIdentity ([string]$Configuration.restoreTaskName) `
                            -ExpectedSha256 ([string]$Configuration.restoreTaskSha256)
                        [void](Wait-DysonQualificationV2MappingRestored `
                            -Configuration $Configuration -DeadlineUtc $recoveryDeadline)
                        $restored = $true
                    }
                    catch {
                        $restored = $false
                        $recoveryFailureCode = Get-DysonQualificationV2ErrorCode -Exception $_.Exception
                    }
                }
            }
            if (-not $restored) {
                if ($recoveryFailureCode -ceq 'DYSON_QUALIFICATION_V2_STORAGE_OBSERVATION_FAILED') {
                    Throw-DysonQualificationV2Error -Code 'DYSON_QUALIFICATION_V2_STORAGE_OBSERVATION_FAILED'
                }
                Throw-DysonQualificationV2Error -Code 'DYSON_QUALIFICATION_V2_STORAGE_RECOVERY_DEADLINE_EXCEEDED'
            }
            return [pscustomobject]@{ success = $true; outcomeCode = 'STORAGE_INTERRUPTION_RECOVERED' }
        }
        'disk-pressure' {
            $allocation = Get-DysonQualificationV2PressureFilePath -Request $Request -Configuration $Configuration
            [void](Assert-DysonQualificationV2DisposableDirectory -Configuration $Configuration -AllowedPressureFile $null)
            $before = Get-DysonQualificationV2DiskCapacity -VolumeRoot ([string]$Configuration.volumeRoot)
            $plannedFree = [int64]$before.freeBytes - [int64]$Request.parameters.allocationBytes
            $plannedUsedPercent = ([decimal]([int64]$before.totalBytes - $plannedFree) * 100) / [decimal]$before.totalBytes
            if ($plannedFree -lt [int64]$Configuration.minimumFreeBytes -or
                $plannedUsedPercent -gt [decimal]$Configuration.maximumUsedPercent) {
                Throw-DysonQualificationV2Error -Code 'DYSON_QUALIFICATION_V2_DISK_SAFETY_FLOOR_VIOLATED'
            }
            $stream = $null
            $rng = $null
            try {
                $stream = New-Object IO.FileStream($allocation, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
                $rng = [Security.Cryptography.RandomNumberGenerator]::Create()
                $buffer = New-Object byte[] 1048576
                $remaining = [int64]$Request.parameters.allocationBytes
                while ($remaining -gt 0) {
                    if ([datetimeoffset]::UtcNow -gt $DeadlineUtc) {
                        Throw-DysonQualificationV2Error -Code 'DYSON_QUALIFICATION_V2_ACTION_TIMEOUT'
                    }
                    $count = [int][Math]::Min([int64]$buffer.Length, $remaining)
                    $rng.GetBytes($buffer)
                    $stream.Write($buffer, 0, $count)
                    $stream.Flush()
                    $remaining -= $count
                    $capacity = Get-DysonQualificationV2DiskCapacity -VolumeRoot ([string]$Configuration.volumeRoot)
                    if ($capacity.freeBytes -lt [int64]$Configuration.minimumFreeBytes -or
                        $capacity.usedPercent -gt [decimal]$Configuration.maximumUsedPercent) {
                        Throw-DysonQualificationV2Error -Code 'DYSON_QUALIFICATION_V2_DISK_SAFETY_FLOOR_VIOLATED'
                    }
                }
                $hold = [Diagnostics.Stopwatch]::StartNew()
                try {
                    while ($hold.Elapsed.TotalSeconds -lt [int]$Request.parameters.holdSeconds) {
                        if ([datetimeoffset]::UtcNow -gt $DeadlineUtc) {
                            Throw-DysonQualificationV2Error -Code 'DYSON_QUALIFICATION_V2_ACTION_TIMEOUT'
                        }
                        Start-Sleep -Milliseconds 200
                    }
                }
                finally { $hold.Stop() }
            }
            finally {
                if ($null -ne $rng) { $rng.Dispose() }
                if ($null -ne $stream) { $stream.Dispose() }
                if (Test-Path -LiteralPath $allocation -PathType Leaf) { [IO.File]::Delete($allocation) }
            }
            [void](Assert-DysonQualificationV2DisposableDirectory -Configuration $Configuration -AllowedPressureFile $null)
            return [pscustomobject]@{ success = $true; outcomeCode = 'DISK_PRESSURE_RELIEVED' }
        }
    }
}
