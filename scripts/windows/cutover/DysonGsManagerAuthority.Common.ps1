Set-StrictMode -Version 2.0

$script:GsAuthorityTaskPath = '\'
$script:GsAuthorityPanelTask = 'Dyson-GSManager'
$script:GsAuthorityOldStartTask = 'Dyson-Nebula-Server'
$script:GsAuthorityOldStopTask = 'Dyson-Nebula-Stop'
$script:GsAuthorityNewStartTask = 'Dyson-GSManager-Server'
$script:GsAuthorityNewStopTask = 'Dyson-GSManager-Stop'
$script:GsAuthorityProtocol = 'DYSON_GSMANAGER_AUTHORITY_TRANSACTION_V1'
$script:GsAuthorityReceiptProtocol = 'DYSON_GSMANAGER_AUTHORITY_RECEIPT_V1'

function New-GsAuthorityError {
    param([Parameter(Mandatory)][string]$Code)
    $error = [InvalidOperationException]::new($Code)
    $error.Data['Code'] = $Code
    return $error
}

function Throw-GsAuthorityError {
    param([Parameter(Mandatory)][string]$Code)
    throw (New-GsAuthorityError $Code)
}

function Get-GsAuthorityErrorCode {
    param([Parameter(Mandatory)][Exception]$Exception)
    if ($Exception.Data.Contains('Code') -and
        [string]$Exception.Data['Code'] -match '^(?:DYSON_GSMANAGER_AUTHORITY|DYSON_HOST_MUTATION_LEASE)_[A-Z0-9_]+$') {
        return [string]$Exception.Data['Code']
    }
    return 'DYSON_GSMANAGER_AUTHORITY_FAILED'
}

function Get-GsAuthoritySha256Bytes {
    param([Parameter(Mandatory)][byte[]]$Bytes)
    $hasher = [Security.Cryptography.SHA256]::Create()
    try { return ([BitConverter]::ToString($hasher.ComputeHash($Bytes))).Replace('-', '').ToLowerInvariant() }
    finally { $hasher.Dispose() }
}

function Get-GsAuthoritySha256Text {
    param([Parameter(Mandatory)][AllowEmptyString()][string]$Text)
    return Get-GsAuthoritySha256Bytes ([Text.UTF8Encoding]::new($false).GetBytes($Text))
}

function ConvertTo-GsAuthorityJson {
    param([Parameter(Mandatory)]$Value)
    return ($Value | ConvertTo-Json -Depth 32 -Compress)
}

function Assert-GsAuthorityPlainDirectory {
    param([Parameter(Mandatory)][string]$Path, [switch]$Create)
    try {
        $full = [IO.Path]::GetFullPath($Path).TrimEnd('\', '/')
        if (-not [IO.Path]::IsPathRooted($full) -or [string]::IsNullOrWhiteSpace($full) -or
            $full -match '["\r\n]' -or $full -eq [IO.Path]::GetPathRoot($full).TrimEnd('\', '/')) {
            throw 'invalid'
        }
        if ($Create -and -not (Test-Path -LiteralPath $full)) { [void][IO.Directory]::CreateDirectory($full) }
        $item = Get-Item -LiteralPath $full -Force -ErrorAction Stop
        if (-not $item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'redirected' }
        $resolved = Resolve-DysonHostMutationLeaseCanonicalDirectory -Path $item.FullName
        if (-not [string]::Equals($resolved.TrimEnd('\', '/'), $item.FullName.TrimEnd('\', '/'), [StringComparison]::OrdinalIgnoreCase)) {
            throw 'identity changed'
        }
        return $resolved.TrimEnd('\', '/')
    }
    catch { Throw-GsAuthorityError 'DYSON_GSMANAGER_AUTHORITY_PATH_INVALID' }
}

function Assert-GsAuthorityPlainFile {
    param([Parameter(Mandatory)][string]$Path, [int64]$MaximumBytes = 2097152)
    try {
        $item = Get-Item -LiteralPath $Path -Force -ErrorAction Stop
        if ($item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -or
            $item.Length -lt 1 -or $item.Length -gt $MaximumBytes) { throw 'invalid' }
        $resolvedParent = Resolve-DysonHostMutationLeaseCanonicalDirectory -Path ([IO.Path]::GetDirectoryName($item.FullName))
        if (-not [string]::Equals($resolvedParent.TrimEnd('\', '/'), [IO.Path]::GetDirectoryName($item.FullName).TrimEnd('\', '/'), [StringComparison]::OrdinalIgnoreCase)) {
            throw 'redirected parent'
        }
        return $item.FullName
    }
    catch { Throw-GsAuthorityError 'DYSON_GSMANAGER_AUTHORITY_FILE_INVALID' }
}

function Write-GsAuthorityJsonNew {
    param([Parameter(Mandatory)][string]$Path, [Parameter(Mandatory)]$Value)
    Assert-GsAuthorityMutationScope
    $directory = Assert-GsAuthorityPlainDirectory ([IO.Path]::GetDirectoryName($Path)) -Create
    $temporary = Join-Path $directory ('.gs-authority-' + [guid]::NewGuid().ToString('N') + '.tmp')
    try {
        [IO.File]::WriteAllText($temporary, (ConvertTo-GsAuthorityJson $Value) + "`n", [Text.UTF8Encoding]::new($false))
        [IO.File]::Move($temporary, $Path)
    }
    catch { Throw-GsAuthorityError 'DYSON_GSMANAGER_AUTHORITY_DURABLE_WRITE_FAILED' }
    finally { if (Test-Path -LiteralPath $temporary -PathType Leaf) { Remove-Item -LiteralPath $temporary -Force -ErrorAction SilentlyContinue } }
    Assert-GsAuthorityMutationScope
}

function Read-GsAuthorityJson {
    param([Parameter(Mandatory)][string]$Path, [switch]$AllowMissing)
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
        if ($AllowMissing) { return $null }
        Throw-GsAuthorityError 'DYSON_GSMANAGER_AUTHORITY_EVIDENCE_MISSING'
    }
    try {
        [void](Assert-GsAuthorityPlainFile $Path)
        return Get-Content -LiteralPath $Path -Raw -Encoding UTF8 | ConvertFrom-Json -ErrorAction Stop
    }
    catch {
        if ($_.Exception.Data.Contains('Code')) { throw $_.Exception }
        Throw-GsAuthorityError 'DYSON_GSMANAGER_AUTHORITY_EVIDENCE_INVALID'
    }
}

function Write-GsAuthorityBytesAtomic {
    param([Parameter(Mandatory)][string]$Path, [Parameter(Mandatory)][byte[]]$Bytes)
    Assert-GsAuthorityMutationScope
    $directory = Assert-GsAuthorityPlainDirectory ([IO.Path]::GetDirectoryName($Path)) -Create
    $temporary = Join-Path $directory ('.gs-authority-' + [guid]::NewGuid().ToString('N') + '.tmp')
    $backup = Join-Path $directory ('.gs-authority-' + [guid]::NewGuid().ToString('N') + '.bak')
    try {
        [IO.File]::WriteAllBytes($temporary, $Bytes)
        if (Test-Path -LiteralPath $Path -PathType Leaf) {
            [IO.File]::Replace($temporary, $Path, $backup, $true)
            if (Test-Path -LiteralPath $backup -PathType Leaf) { Remove-Item -LiteralPath $backup -Force }
        }
        else { [IO.File]::Move($temporary, $Path) }
    }
    catch { Throw-GsAuthorityError 'DYSON_GSMANAGER_AUTHORITY_DURABLE_WRITE_FAILED' }
    finally {
        foreach ($candidate in @($temporary, $backup)) {
            if (Test-Path -LiteralPath $candidate -PathType Leaf) { Remove-Item -LiteralPath $candidate -Force -ErrorAction SilentlyContinue }
        }
    }
    Assert-GsAuthorityMutationScope
}

function Remove-GsAuthorityFile {
    param([Parameter(Mandatory)][string]$Path)
    Assert-GsAuthorityMutationScope
    if (Test-Path -LiteralPath $Path -PathType Leaf) { Remove-Item -LiteralPath $Path -Force }
    Assert-GsAuthorityMutationScope
}

function Assert-GsAuthorityMutationScope {
    if ($script:GsAuthorityBorrowedLease) {
        [void](Assert-DysonHostMutationLeaseBorrow -DataRoot $script:GsAuthorityDataRoot `
            -InstanceId $script:GsAuthorityLeaseInstanceId -Token $script:GsAuthorityLeaseToken)
        return
    }
    if ($null -eq $script:GsAuthorityOwnedLease -or -not [bool]$script:GsAuthorityOwnedLease.Active) {
        Throw-GsAuthorityError 'DYSON_GSMANAGER_AUTHORITY_LEASE_LOST'
    }
}

function Get-GsAuthorityShadowTasks {
    $path = Join-Path $script:GsAuthorityShadowRoot 'tasks.json'
    $state = Read-GsAuthorityJson $path
    if ([string]$state.protocol -cne 'DYSON_GSMANAGER_AUTHORITY_SHADOW_V1') {
        Throw-GsAuthorityError 'DYSON_GSMANAGER_AUTHORITY_SHADOW_INVALID'
    }
    return @($state.tasks)
}

function Set-GsAuthorityShadowTasks {
    param([Parameter(Mandatory)][object[]]$Tasks, [Parameter(Mandatory)][string]$WriteKind)
    Assert-GsAuthorityMutationScope
    $value = [pscustomobject][ordered]@{ protocol = 'DYSON_GSMANAGER_AUTHORITY_SHADOW_V1'; tasks = @($Tasks) }
    $path = Join-Path $script:GsAuthorityShadowRoot 'tasks.json'
    $bytes = [Text.UTF8Encoding]::new($false).GetBytes((ConvertTo-GsAuthorityJson $value) + "`n")
    Write-GsAuthorityBytesAtomic $path $bytes
    [IO.File]::AppendAllText((Join-Path $script:GsAuthorityShadowRoot 'writes.log'), $WriteKind + "`n", [Text.UTF8Encoding]::new($false))
    Assert-GsAuthorityMutationScope
}

function Get-GsAuthorityTaskMatches {
    param([Parameter(Mandatory)][string]$TaskName)
    if ($script:GsAuthorityBackend -ceq 'Shadow') {
        return @(Get-GsAuthorityShadowTasks | Where-Object {
            [string]::Equals([string]$_.taskName, $TaskName, [StringComparison]::OrdinalIgnoreCase)
        })
    }
    try {
        return @(Get-ScheduledTask -ErrorAction Stop | Where-Object {
            [string]::Equals([string]$_.TaskName, $TaskName, [StringComparison]::OrdinalIgnoreCase)
        })
    }
    catch { Throw-GsAuthorityError 'DYSON_GSMANAGER_AUTHORITY_SCHEDULER_UNAVAILABLE' }
}

function Get-GsAuthorityTaskImage {
    param([Parameter(Mandatory)][string]$TaskName, [switch]$AllowMissing)
    $matches = @(Get-GsAuthorityTaskMatches $TaskName)
    if ($matches.Count -eq 0) {
        if (-not $AllowMissing) { Throw-GsAuthorityError 'DYSON_GSMANAGER_AUTHORITY_TASK_MISSING' }
        return [pscustomobject][ordered]@{
            taskName = $TaskName; taskPath = $script:GsAuthorityTaskPath; present = $false
            xmlBase64 = $null; enabled = $false; running = $false; descriptor = $null
        }
    }
    if ($matches.Count -ne 1) { Throw-GsAuthorityError 'DYSON_GSMANAGER_AUTHORITY_TASK_AMBIGUOUS' }
    $task = $matches[0]
    $name = if ($script:GsAuthorityBackend -ceq 'Shadow') { [string]$task.taskName } else { [string]$task.TaskName }
    $path = if ($script:GsAuthorityBackend -ceq 'Shadow') { [string]$task.taskPath } else { [string]$task.TaskPath }
    if ($name -cne $TaskName -or $path -cne $script:GsAuthorityTaskPath) {
        Throw-GsAuthorityError 'DYSON_GSMANAGER_AUTHORITY_TASK_AMBIGUOUS'
    }
    if ($script:GsAuthorityBackend -ceq 'Shadow') {
        try { [void][Convert]::FromBase64String([string]$task.xmlBase64) }
        catch { Throw-GsAuthorityError 'DYSON_GSMANAGER_AUTHORITY_TASK_INVALID' }
        return [pscustomobject][ordered]@{
            taskName = $name; taskPath = $path; present = $true; xmlBase64 = [string]$task.xmlBase64
            enabled = [bool]$task.enabled; running = [bool]$task.running; descriptor = $task.descriptor
        }
    }
    try {
        $xml = [string](Export-ScheduledTask -TaskName $TaskName -TaskPath $script:GsAuthorityTaskPath -ErrorAction Stop)
        return [pscustomobject][ordered]@{
            taskName = $name; taskPath = $path; present = $true
            xmlBase64 = [Convert]::ToBase64String([Text.UTF8Encoding]::new($false).GetBytes($xml))
            enabled = [bool]$task.Settings.Enabled; running = ([string]$task.State -ceq 'Running'); descriptor = $null
        }
    }
    catch { Throw-GsAuthorityError 'DYSON_GSMANAGER_AUTHORITY_TASK_INVALID' }
}

function ConvertFrom-GsAuthorityTaskXml {
    param([Parameter(Mandatory)][string]$Xml)
    try {
        $document = [Xml.XmlDocument]::new()
        $document.PreserveWhitespace = $false
        $document.LoadXml($Xml)
        $manager = [Xml.XmlNamespaceManager]::new($document.NameTable)
        $manager.AddNamespace('t', $document.DocumentElement.NamespaceURI)
        return [pscustomobject]@{ Document = $document; NamespaceManager = $manager }
    }
    catch { Throw-GsAuthorityError 'DYSON_GSMANAGER_AUTHORITY_TASK_INVALID' }
}

function Get-GsAuthorityTaskDescriptor {
    param([Parameter(Mandatory)]$Image)
    if (-not [bool]$Image.present) { Throw-GsAuthorityError 'DYSON_GSMANAGER_AUTHORITY_TASK_MISSING' }
    if ($script:GsAuthorityBackend -ceq 'Shadow') { return $Image.descriptor }
    $xml = [Text.UTF8Encoding]::new($false).GetString([Convert]::FromBase64String([string]$Image.xmlBase64))
    $parsed = ConvertFrom-GsAuthorityTaskXml $xml
    $document = $parsed.Document
    $manager = $parsed.NamespaceManager
    $actions = @($document.SelectNodes('/t:Task/t:Actions/*', $manager))
    $exec = @($document.SelectNodes('/t:Task/t:Actions/t:Exec', $manager))
    $triggers = @($document.SelectNodes('/t:Task/t:Triggers/*', $manager))
    $principal = $document.SelectSingleNode('/t:Task/t:Principals/t:Principal', $manager)
    $settings = $document.SelectSingleNode('/t:Task/t:Settings', $manager)
    if ($actions.Count -ne 1 -or $exec.Count -ne 1 -or $null -eq $principal -or $null -eq $settings) {
        Throw-GsAuthorityError 'DYSON_GSMANAGER_AUTHORITY_TASK_INVALID'
    }
    return [pscustomobject][ordered]@{
        actionCount = $actions.Count; execute = [string]$exec[0].Command
        arguments = [string]$exec[0].Arguments; userId = [string]$principal.UserId
        logonType = [string]$principal.LogonType; runLevel = [string]$principal.RunLevel
        triggerCount = $triggers.Count; principalXml = [string]$principal.OuterXml
        settingsXml = [string]$settings.OuterXml
    }
}

function Assert-GsAuthorityLegacyTask {
    param(
        [Parameter(Mandatory)]$Image,
        [Parameter(Mandatory)][string]$ExpectedScript,
        [Parameter(Mandatory)][string]$ServiceUser
    )
    if (-not [bool]$Image.enabled -or [bool]$Image.running) {
        Throw-GsAuthorityError 'DYSON_GSMANAGER_AUTHORITY_TASK_STATE_INVALID'
    }
    $descriptor = Get-GsAuthorityTaskDescriptor $Image
    $expectedPowerShell = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
    if ([int]$descriptor.actionCount -ne 1 -or [int]$descriptor.triggerCount -ne 0 -or
        -not [string]::Equals([IO.Path]::GetFullPath([string]$descriptor.execute), [IO.Path]::GetFullPath($expectedPowerShell), [StringComparison]::OrdinalIgnoreCase) -or
        -not [string]::Equals([string]$descriptor.userId, $ServiceUser, [StringComparison]::OrdinalIgnoreCase) -or
        [string]$descriptor.logonType -notin @('Interactive', 'InteractiveToken') -or
        [string]$descriptor.runLevel -notin @('Limited', 'LeastPrivilege')) {
        Throw-GsAuthorityError 'DYSON_GSMANAGER_AUTHORITY_TASK_DEFINITION_MISMATCH'
    }
    $argumentMatch = [regex]::Match([string]$descriptor.arguments,
        '^(?<prefix>(?:(?:-NoLogo|-NoProfile|-NonInteractive|-ExecutionPolicy\s+Bypass)\s+)*)-File\s+"(?<path>[^"\r\n]+)"\s*$',
        [Text.RegularExpressions.RegexOptions]::IgnoreCase)
    if (-not $argumentMatch.Success -or
        -not [string]::Equals([IO.Path]::GetFullPath($argumentMatch.Groups['path'].Value), [IO.Path]::GetFullPath($ExpectedScript), [StringComparison]::OrdinalIgnoreCase)) {
        Throw-GsAuthorityError 'DYSON_GSMANAGER_AUTHORITY_TASK_DEFINITION_MISMATCH'
    }
    return [pscustomobject][ordered]@{
        descriptor = $descriptor
        argumentPrefix = [string]$argumentMatch.Groups['prefix'].Value
    }
}

function New-GsAuthorityTargetImage {
    param(
        [Parameter(Mandatory)]$SourceImage,
        [Parameter(Mandatory)][string]$TargetName,
        [Parameter(Mandatory)][string]$TargetScript,
        [Parameter(Mandatory)]$LegacyDefinition
    )
    $arguments = [string]$LegacyDefinition.argumentPrefix + '-File "' + $TargetScript + '"'
    if ($script:GsAuthorityBackend -ceq 'Shadow') {
        $source = $SourceImage.descriptor
        $descriptor = [pscustomobject][ordered]@{
            actionCount = 1; execute = [string]$source.execute; arguments = $arguments
            userId = [string]$source.userId; logonType = [string]$source.logonType
            runLevel = [string]$source.runLevel; triggerCount = 0
            principal = $source.principal; settings = $source.settings
        }
        $xml = '<Task><Name>' + $TargetName + '</Name><Digest>' +
            (Get-GsAuthoritySha256Text (ConvertTo-GsAuthorityJson $descriptor)) + '</Digest></Task>'
        return [pscustomobject][ordered]@{
            taskName = $TargetName; taskPath = $script:GsAuthorityTaskPath; present = $true
            xmlBase64 = [Convert]::ToBase64String([Text.UTF8Encoding]::new($false).GetBytes($xml))
            enabled = $true; running = $false; descriptor = $descriptor
        }
    }
    $xml = [Text.UTF8Encoding]::new($false).GetString([Convert]::FromBase64String([string]$SourceImage.xmlBase64))
    $parsed = ConvertFrom-GsAuthorityTaskXml $xml
    $exec = $parsed.Document.SelectSingleNode('/t:Task/t:Actions/t:Exec', $parsed.NamespaceManager)
    $triggers = $parsed.Document.SelectSingleNode('/t:Task/t:Triggers', $parsed.NamespaceManager)
    $exec.Arguments = $arguments
    while ($null -ne $triggers -and $triggers.HasChildNodes) { [void]$triggers.RemoveChild($triggers.FirstChild) }
    $targetXml = [string]$parsed.Document.OuterXml
    return [pscustomobject][ordered]@{
        taskName = $TargetName; taskPath = $script:GsAuthorityTaskPath; present = $true
        xmlBase64 = [Convert]::ToBase64String([Text.UTF8Encoding]::new($false).GetBytes($targetXml))
        enabled = $true; running = $false; descriptor = $null
    }
}

function Assert-GsAuthorityTargetTask {
    param(
        [Parameter(Mandatory)][string]$TaskName,
        [Parameter(Mandatory)][string]$TargetScript,
        [Parameter(Mandatory)]$LegacyDefinition,
        [Parameter(Mandatory)][string]$ServiceUser
    )
    $image = Get-GsAuthorityTaskImage $TaskName
    if (-not [bool]$image.enabled -or [bool]$image.running) {
        Throw-GsAuthorityError 'DYSON_GSMANAGER_AUTHORITY_TARGET_VERIFY_FAILED'
    }
    $actual = Get-GsAuthorityTaskDescriptor $image
    $expectedPowerShell = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
    if ([int]$actual.actionCount -ne 1 -or [int]$actual.triggerCount -ne 0 -or
        -not [string]::Equals([IO.Path]::GetFullPath([string]$actual.execute), [IO.Path]::GetFullPath($expectedPowerShell), [StringComparison]::OrdinalIgnoreCase) -or
        -not [string]::Equals([string]$actual.userId, $ServiceUser, [StringComparison]::OrdinalIgnoreCase) -or
        [string]$actual.logonType -notin @('Interactive', 'InteractiveToken') -or
        [string]$actual.runLevel -notin @('Limited', 'LeastPrivilege')) {
        Throw-GsAuthorityError 'DYSON_GSMANAGER_AUTHORITY_TARGET_VERIFY_FAILED'
    }
    $match = [regex]::Match([string]$actual.arguments,
        '^(?<prefix>(?:(?:-NoLogo|-NoProfile|-NonInteractive|-ExecutionPolicy\s+Bypass)\s+)*)-File\s+"(?<path>[^"\r\n]+)"\s*$',
        [Text.RegularExpressions.RegexOptions]::IgnoreCase)
    if (-not $match.Success -or [string]$match.Groups['prefix'].Value -cne [string]$LegacyDefinition.argumentPrefix -or
        -not [string]::Equals([IO.Path]::GetFullPath($match.Groups['path'].Value), [IO.Path]::GetFullPath($TargetScript), [StringComparison]::OrdinalIgnoreCase)) {
        Throw-GsAuthorityError 'DYSON_GSMANAGER_AUTHORITY_TARGET_VERIFY_FAILED'
    }
    if ($script:GsAuthorityBackend -ceq 'Shadow') {
        if ((ConvertTo-GsAuthorityJson $actual.principal) -cne (ConvertTo-GsAuthorityJson $LegacyDefinition.descriptor.principal) -or
            (ConvertTo-GsAuthorityJson $actual.settings) -cne (ConvertTo-GsAuthorityJson $LegacyDefinition.descriptor.settings)) {
            Throw-GsAuthorityError 'DYSON_GSMANAGER_AUTHORITY_TARGET_VERIFY_FAILED'
        }
    }
    elseif ([string]$actual.principalXml -cne [string]$LegacyDefinition.descriptor.principalXml -or
        [string]$actual.settingsXml -cne [string]$LegacyDefinition.descriptor.settingsXml) {
        Throw-GsAuthorityError 'DYSON_GSMANAGER_AUTHORITY_TARGET_VERIFY_FAILED'
    }
}

function Set-GsAuthorityTaskImage {
    param([Parameter(Mandatory)]$Image)
    Assert-GsAuthorityMutationScope
    $name = [string]$Image.taskName
    if ($name -notin @($script:GsAuthorityPanelTask, $script:GsAuthorityOldStartTask,
        $script:GsAuthorityOldStopTask, $script:GsAuthorityNewStartTask, $script:GsAuthorityNewStopTask)) {
        Throw-GsAuthorityError 'DYSON_GSMANAGER_AUTHORITY_TASK_INVALID'
    }
    if ($script:GsAuthorityBackend -ceq 'Shadow') {
        $tasks = @(Get-GsAuthorityShadowTasks | Where-Object {
            -not [string]::Equals([string]$_.taskName, $name, [StringComparison]::OrdinalIgnoreCase)
        })
        if ([bool]$Image.present) {
            $tasks += [pscustomobject][ordered]@{
                taskName = $name; taskPath = $script:GsAuthorityTaskPath; xmlBase64 = [string]$Image.xmlBase64
                enabled = [bool]$Image.enabled; running = [bool]$Image.running; descriptor = $Image.descriptor
            }
        }
        Set-GsAuthorityShadowTasks -Tasks $tasks -WriteKind ('task:' + $name)
        return
    }
    try {
        $current = @(Get-GsAuthorityTaskMatches $name)
        if ($current.Count -gt 1) { Throw-GsAuthorityError 'DYSON_GSMANAGER_AUTHORITY_TASK_AMBIGUOUS' }
        if ($current.Count -eq 1) {
            Stop-ScheduledTask -TaskName $name -TaskPath $script:GsAuthorityTaskPath -ErrorAction SilentlyContinue
            Unregister-ScheduledTask -TaskName $name -TaskPath $script:GsAuthorityTaskPath -Confirm:$false -ErrorAction Stop
        }
        if ([bool]$Image.present) {
            $xml = [Text.UTF8Encoding]::new($false).GetString([Convert]::FromBase64String([string]$Image.xmlBase64))
            Register-ScheduledTask -TaskName $name -TaskPath $script:GsAuthorityTaskPath -Xml $xml -Force -ErrorAction Stop | Out-Null
            if ([bool]$Image.enabled) { Enable-ScheduledTask -TaskName $name -TaskPath $script:GsAuthorityTaskPath -ErrorAction Stop | Out-Null }
            else { Disable-ScheduledTask -TaskName $name -TaskPath $script:GsAuthorityTaskPath -ErrorAction Stop | Out-Null }
        }
    }
    catch {
        if ($_.Exception.Data.Contains('Code')) { throw $_.Exception }
        Throw-GsAuthorityError 'DYSON_GSMANAGER_AUTHORITY_SCHEDULER_WRITE_FAILED'
    }
    Assert-GsAuthorityMutationScope
}

function Test-GsAuthorityTaskImageEqual {
    param([Parameter(Mandatory)]$Expected, [Parameter(Mandatory)]$Actual)
    if ([bool]$Expected.present -ne [bool]$Actual.present) { return $false }
    if (-not [bool]$Expected.present) { return $true }
    return [string]$Expected.taskName -ceq [string]$Actual.taskName -and
        [string]$Expected.taskPath -ceq [string]$Actual.taskPath -and
        [string]$Expected.xmlBase64 -ceq [string]$Actual.xmlBase64 -and
        [bool]$Expected.enabled -eq [bool]$Actual.enabled
}

function Set-GsAuthorityTaskRunning {
    param([Parameter(Mandatory)][string]$TaskName, [Parameter(Mandatory)][bool]$Running, [switch]$Restore)
    Assert-GsAuthorityMutationScope
    if ($script:GsAuthorityBackend -ceq 'Shadow') {
        if ($Running -and -not $Restore -and $env:DYSON_GSMANAGER_AUTHORITY_SELFTEST_FAIL_POINT -ceq 'PanelRestart') {
            Throw-GsAuthorityError 'DYSON_GSMANAGER_AUTHORITY_PANEL_RESTART_FAILED'
        }
        $image = Get-GsAuthorityTaskImage $TaskName
        $image.running = $Running
        Set-GsAuthorityTaskImage $image
        Assert-GsAuthorityMutationScope
        return
    }
    try {
        if ($Running) { Start-ScheduledTask -TaskName $TaskName -TaskPath $script:GsAuthorityTaskPath -ErrorAction Stop }
        else { Stop-ScheduledTask -TaskName $TaskName -TaskPath $script:GsAuthorityTaskPath -ErrorAction Stop }
        $deadline = [DateTime]::UtcNow.AddSeconds(30)
        do {
            Start-Sleep -Milliseconds 200
            $actual = Get-GsAuthorityTaskImage $TaskName
            if ([bool]$actual.running -eq $Running) { break }
        } while ([DateTime]::UtcNow -lt $deadline)
        if ([bool]$actual.running -ne $Running) { throw 'state mismatch' }
    }
    catch { Throw-GsAuthorityError $(if ($Running) { 'DYSON_GSMANAGER_AUTHORITY_PANEL_RESTART_FAILED' } else { 'DYSON_GSMANAGER_AUTHORITY_PANEL_STOP_FAILED' }) }
    Assert-GsAuthorityMutationScope
}

function Assert-GsAuthorityRuntimeQuiescent {
    if ($script:GsAuthorityBackend -ceq 'Shadow') {
        $runtime = Read-GsAuthorityJson (Join-Path $script:GsAuthorityShadowRoot 'runtime.json')
        if ([bool]$runtime.dspGameProcess) { Throw-GsAuthorityError 'DYSON_GSMANAGER_AUTHORITY_DSP_RUNNING' }
        if ([bool]$runtime.tcp8469) { Throw-GsAuthorityError 'DYSON_GSMANAGER_AUTHORITY_TCP_LISTENER_PRESENT' }
        if ([bool]$runtime.udp8469) { Throw-GsAuthorityError 'DYSON_GSMANAGER_AUTHORITY_UDP_LISTENER_PRESENT' }
        return
    }
    try {
        if (@(Get-Process -Name 'DSPGAME' -ErrorAction SilentlyContinue).Count -ne 0) {
            Throw-GsAuthorityError 'DYSON_GSMANAGER_AUTHORITY_DSP_RUNNING'
        }
        if (@(Get-NetTCPConnection -LocalPort 8469 -State Listen -ErrorAction SilentlyContinue).Count -ne 0) {
            Throw-GsAuthorityError 'DYSON_GSMANAGER_AUTHORITY_TCP_LISTENER_PRESENT'
        }
        if (@(Get-NetUDPEndpoint -LocalPort 8469 -ErrorAction SilentlyContinue).Count -ne 0) {
            Throw-GsAuthorityError 'DYSON_GSMANAGER_AUTHORITY_UDP_LISTENER_PRESENT'
        }
    }
    catch {
        if ($_.Exception.Data.Contains('Code')) { throw $_.Exception }
        Throw-GsAuthorityError 'DYSON_GSMANAGER_AUTHORITY_RUNTIME_PROBE_FAILED'
    }
}

function Get-GsAuthorityEnvUpdate {
    param([Parameter(Mandatory)][byte[]]$Bytes)
    try {
        $offset = 0
        $bom = $false
        if ($Bytes.Length -ge 3 -and $Bytes[0] -eq 0xEF -and $Bytes[1] -eq 0xBB -and $Bytes[2] -eq 0xBF) { $offset = 3; $bom = $true }
        $encoding = [Text.UTF8Encoding]::new($false, $true)
        $text = $encoding.GetString($Bytes, $offset, $Bytes.Length - $offset)
        if ($text.IndexOf([char]0) -ge 0) { throw 'nul' }
        $parts = [Text.RegularExpressions.Regex]::Split($text, '(\r\n|\n|\r)')
        $seen = [Collections.Generic.Dictionary[string, bool]]::new([StringComparer]::OrdinalIgnoreCase)
        for ($index = 0; $index -lt $parts.Length; $index += 2) {
            $line = [string]$parts[$index]
            if ($line -match '^\s*(?:#.*)?$') { continue }
            $match = [regex]::Match($line, '^([A-Za-z_][A-Za-z0-9_]*)=(.*)$')
            if (-not $match.Success) { Throw-GsAuthorityError 'DYSON_GSMANAGER_AUTHORITY_ENV_INVALID' }
            $key = [string]$match.Groups[1].Value
            if ($seen.ContainsKey($key)) { Throw-GsAuthorityError 'DYSON_GSMANAGER_AUTHORITY_ENV_DUPLICATE_KEY' }
            $seen[$key] = $true
            if ([string]::Equals($key, 'DYSON_SERVER_TASK', [StringComparison]::OrdinalIgnoreCase)) { $parts[$index] = 'DYSON_SERVER_TASK=' + $script:GsAuthorityNewStartTask }
            elseif ([string]::Equals($key, 'DYSON_STOP_TASK', [StringComparison]::OrdinalIgnoreCase)) { $parts[$index] = 'DYSON_STOP_TASK=' + $script:GsAuthorityNewStopTask }
        }
        $newline = "`r`n"
        if ($parts.Length -gt 1) { $newline = [string]$parts[1] }
        $rebuilt = [Text.StringBuilder]::new()
        for ($index = 0; $index -lt $parts.Length; $index++) { [void]$rebuilt.Append([string]$parts[$index]) }
        $updated = $rebuilt.ToString()
        foreach ($pair in @(
            @('DYSON_SERVER_TASK', $script:GsAuthorityNewStartTask),
            @('DYSON_STOP_TASK', $script:GsAuthorityNewStopTask)
        )) {
            if (-not $seen.ContainsKey($pair[0])) {
                if ($updated.Length -gt 0 -and -not ($updated.EndsWith("`n") -or $updated.EndsWith("`r"))) { $updated += $newline }
                $updated += $pair[0] + '=' + $pair[1] + $newline
            }
        }
        $payload = $encoding.GetBytes($updated)
        if ($bom) {
            $result = [byte[]]::new($payload.Length + 3)
            $result[0] = 0xEF; $result[1] = 0xBB; $result[2] = 0xBF
            [Array]::Copy($payload, 0, $result, 3, $payload.Length)
            $payload = $result
        }
        return [pscustomobject][ordered]@{ bytes = $payload; sha256 = Get-GsAuthoritySha256Bytes $payload }
    }
    catch {
        if ($_.Exception.Data.Contains('Code')) { throw $_.Exception }
        Throw-GsAuthorityError 'DYSON_GSMANAGER_AUTHORITY_ENV_INVALID'
    }
}

function Get-GsAuthorityFileImage {
    param([Parameter(Mandatory)][string]$Path)
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
        return [pscustomobject][ordered]@{ present = $false; bytesBase64 = $null; sha256 = $null }
    }
    [void](Assert-GsAuthorityPlainFile $Path)
    $bytes = [IO.File]::ReadAllBytes($Path)
    return [pscustomobject][ordered]@{
        present = $true; bytesBase64 = [Convert]::ToBase64String($bytes); sha256 = Get-GsAuthoritySha256Bytes $bytes
    }
}

function Restore-GsAuthorityFileImage {
    param([Parameter(Mandatory)]$Image, [Parameter(Mandatory)][string]$Path)
    if ([bool]$Image.present) { Write-GsAuthorityBytesAtomic $Path ([Convert]::FromBase64String([string]$Image.bytesBase64)) }
    else { Remove-GsAuthorityFile $Path }
    $actual = Get-GsAuthorityFileImage $Path
    if ([bool]$actual.present -ne [bool]$Image.present -or
        ([bool]$actual.present -and [string]$actual.sha256 -cne [string]$Image.sha256)) {
        Throw-GsAuthorityError 'DYSON_GSMANAGER_AUTHORITY_ROLLBACK_FAILED'
    }
}

function New-GsAuthorityDirectorySecurity {
    param(
        [Parameter(Mandatory)][string]$ServiceUser,
        [switch]$GrantServiceRead,
        [switch]$GrantLocalServiceRead
    )
    $security = [Security.AccessControl.DirectorySecurity]::new()
    $security.SetAccessRuleProtection($true, $false)
    $rules = @(
        [Security.AccessControl.FileSystemAccessRule]::new('SYSTEM', 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow'),
        [Security.AccessControl.FileSystemAccessRule]::new('BUILTIN\Administrators', 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow')
    )
    if ($GrantServiceRead) {
        $rules += [Security.AccessControl.FileSystemAccessRule]::new($ServiceUser, 'ReadAndExecute', 'ContainerInherit,ObjectInherit', 'None', 'Allow')
    }
    if ($GrantLocalServiceRead) {
        $rules += [Security.AccessControl.FileSystemAccessRule]::new('NT AUTHORITY\LOCAL SERVICE', 'ReadAndExecute', 'ContainerInherit,ObjectInherit', 'None', 'Allow')
    }
    foreach ($rule in $rules) { [void]$security.AddAccessRule($rule) }
    return $security
}

function Protect-GsAuthorityDirectory {
    param(
        [Parameter(Mandatory)][string]$Path,
        [Parameter(Mandatory)][string]$ServiceUser,
        [switch]$GrantServiceRead,
        [switch]$GrantLocalServiceRead
    )
    Assert-GsAuthorityMutationScope
    $resolved = Assert-GsAuthorityPlainDirectory $Path -Create
    if ($script:GsAuthorityBackend -ceq 'Shadow') {
        Assert-GsAuthorityMutationScope
        return $resolved
    }
    try {
        $security = New-GsAuthorityDirectorySecurity $ServiceUser `
            -GrantServiceRead:$GrantServiceRead -GrantLocalServiceRead:$GrantLocalServiceRead
        Set-Acl -LiteralPath $resolved -AclObject $security -ErrorAction Stop
    }
    catch { Throw-GsAuthorityError 'DYSON_GSMANAGER_AUTHORITY_PRIVATE_ROOT_FAILED' }
    Assert-GsAuthorityMutationScope
    return $resolved
}

function Protect-GsAuthorityProfileFile {
    param([Parameter(Mandatory)][string]$Path)
    Assert-GsAuthorityMutationScope
    [void](Assert-GsAuthorityPlainFile $Path 131072)
    if ($script:GsAuthorityBackend -ceq 'Shadow') {
        Assert-GsAuthorityMutationScope
        return
    }
    try {
        $security = [Security.AccessControl.FileSecurity]::new()
        $security.SetAccessRuleProtection($true, $false)
        foreach ($rule in @(
            [Security.AccessControl.FileSystemAccessRule]::new('SYSTEM', 'FullControl', 'None', 'None', 'Allow'),
            [Security.AccessControl.FileSystemAccessRule]::new('BUILTIN\Administrators', 'FullControl', 'None', 'None', 'Allow'),
            [Security.AccessControl.FileSystemAccessRule]::new('NT AUTHORITY\LOCAL SERVICE', 'ReadAndExecute', 'None', 'None', 'Allow')
        )) { [void]$security.AddAccessRule($rule) }
        Set-Acl -LiteralPath $Path -AclObject $security -ErrorAction Stop
        $verified = Get-Acl -LiteralPath $Path -ErrorAction Stop
        $localServiceReadable = @($verified.Access | Where-Object {
            [string]::Equals([string]$_.IdentityReference, 'NT AUTHORITY\LOCAL SERVICE', [StringComparison]::OrdinalIgnoreCase) -and
            [string]$_.AccessControlType -ceq 'Allow' -and
            (([int]$_.FileSystemRights -band [int][Security.AccessControl.FileSystemRights]::ReadAndExecute) -eq
                [int][Security.AccessControl.FileSystemRights]::ReadAndExecute)
        }).Count -eq 1
        if (-not [bool]$verified.AreAccessRulesProtected -or -not $localServiceReadable) { throw 'profile acl invalid' }
    }
    catch { Throw-GsAuthorityError 'DYSON_GSMANAGER_AUTHORITY_PROFILE_ACL_FAILED' }
    Assert-GsAuthorityMutationScope
}

function Get-GsAuthorityTaskDigest {
    param([Parameter(Mandatory)]$Image)
    $bounded = [ordered]@{
        taskName = [string]$Image.taskName; taskPath = [string]$Image.taskPath; present = [bool]$Image.present
        xmlSha256 = if ([bool]$Image.present) { Get-GsAuthoritySha256Bytes ([Convert]::FromBase64String([string]$Image.xmlBase64)) } else { $null }
        enabled = [bool]$Image.enabled; running = [bool]$Image.running
    }
    return Get-GsAuthoritySha256Text (ConvertTo-GsAuthorityJson $bounded)
}

function Get-GsAuthorityTerminalDigest {
    param([Parameter(Mandatory)][string]$EnvPath, [Parameter(Mandatory)][string]$StartCopy, [Parameter(Mandatory)][string]$StopCopy)
    $state = [ordered]@{
        panel = Get-GsAuthorityTaskDigest (Get-GsAuthorityTaskImage $script:GsAuthorityPanelTask)
        oldStart = Get-GsAuthorityTaskDigest (Get-GsAuthorityTaskImage $script:GsAuthorityOldStartTask)
        oldStop = Get-GsAuthorityTaskDigest (Get-GsAuthorityTaskImage $script:GsAuthorityOldStopTask)
        newStart = Get-GsAuthorityTaskDigest (Get-GsAuthorityTaskImage $script:GsAuthorityNewStartTask -AllowMissing)
        newStop = Get-GsAuthorityTaskDigest (Get-GsAuthorityTaskImage $script:GsAuthorityNewStopTask -AllowMissing)
        env = (Get-GsAuthorityFileImage $EnvPath).sha256
        startCopy = (Get-GsAuthorityFileImage $StartCopy).sha256
        stopCopy = (Get-GsAuthorityFileImage $StopCopy).sha256
        profile = (Get-GsAuthorityFileImage $script:GsAuthorityProfilePath).sha256
    }
    return Get-GsAuthoritySha256Text (ConvertTo-GsAuthorityJson $state)
}

function Restore-GsAuthorityPreimage {
    param([Parameter(Mandatory)]$Intent)
    $script:GsAuthorityRestoring = $true
    try {
        Restore-GsAuthorityFileImage $Intent.preimage.env $script:GsAuthorityEnvPath
        Restore-GsAuthorityFileImage $Intent.preimage.startCopy $script:GsAuthorityStartCopy
        Restore-GsAuthorityFileImage $Intent.preimage.stopCopy $script:GsAuthorityStopCopy
        Restore-GsAuthorityFileImage $Intent.preimage.profile $script:GsAuthorityProfilePath
        foreach ($property in @('oldStart', 'oldStop', 'newStart', 'newStop', 'panel')) {
            Set-GsAuthorityTaskImage $Intent.preimage.tasks.$property
        }
        if ([bool]$Intent.preimage.panelRunning) {
            Set-GsAuthorityTaskRunning $script:GsAuthorityPanelTask $true -Restore
        }
        else {
            $panel = Get-GsAuthorityTaskImage $script:GsAuthorityPanelTask
            if ([bool]$panel.running) { Set-GsAuthorityTaskRunning $script:GsAuthorityPanelTask $false -Restore }
        }
        foreach ($property in @('oldStart', 'oldStop', 'newStart', 'newStop', 'panel')) {
            $expected = $Intent.preimage.tasks.$property
            $actual = Get-GsAuthorityTaskImage ([string]$expected.taskName) -AllowMissing
            if (-not (Test-GsAuthorityTaskImageEqual $expected $actual)) {
                Throw-GsAuthorityError 'DYSON_GSMANAGER_AUTHORITY_ROLLBACK_FAILED'
            }
        }
        $panelNow = Get-GsAuthorityTaskImage $script:GsAuthorityPanelTask
        if ([bool]$panelNow.running -ne [bool]$Intent.preimage.panelRunning) {
            Throw-GsAuthorityError 'DYSON_GSMANAGER_AUTHORITY_ROLLBACK_FAILED'
        }
    }
    finally { $script:GsAuthorityRestoring = $false }
}

function Disable-GsAuthorityLegacyTask {
    param([Parameter(Mandatory)][string]$TaskName)
    $image = Get-GsAuthorityTaskImage $TaskName
    $image.enabled = $false
    Set-GsAuthorityTaskImage $image
    $actual = Get-GsAuthorityTaskImage $TaskName
    if ([bool]$actual.enabled) { Throw-GsAuthorityError 'DYSON_GSMANAGER_AUTHORITY_TASK_DISABLE_FAILED' }
}

function Remove-GsAuthorityIntent {
    if ($script:GsAuthorityBorrowedLease) { Assert-GsAuthorityMutationScope }
    if (Test-Path -LiteralPath $script:GsAuthorityIntentPath -PathType Leaf) {
        Remove-Item -LiteralPath $script:GsAuthorityIntentPath -Force
    }
    if ($script:GsAuthorityBorrowedLease) { Assert-GsAuthorityMutationScope }
}
