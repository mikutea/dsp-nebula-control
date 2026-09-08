Set-StrictMode -Version 2.0

$script:CutoverHostPreviousPanelTask = 'Dyson-GSManager'
$script:CutoverHostPreviousStartTask = 'Dyson-GSManager-Server'
$script:CutoverHostPreviousStopTask = 'Dyson-GSManager-Stop'
$script:CutoverHostCandidateStartTask = 'Dyson-Nebula-Server'
$script:CutoverHostCandidateStopTask = 'Dyson-Nebula-Stop'
$script:CutoverHostTaskPath = '\'
$script:CutoverHostEvidenceProtocol = 'DYSON_CONTROL_CUTOVER_EVIDENCE_V1'
$script:CutoverHostActionProtocol = 'DYSON_CONTROL_CUTOVER_ACTION_RECEIPT_V1'
$script:CutoverHostOwnerProtocol = 'DYSON_CONTROL_CUTOVER_RUNTIME_OWNER_V1'
$script:CutoverHostMaximumJsonBytes = 131072
$script:CutoverHostRuntimeTimeoutSeconds = 180
$script:CutoverHostWindowsRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$script:CutoverHostPreviousStopScriptSha256 = $null
$script:CutoverHostPreviousStopReconcileOnly = $false

function New-CutoverHostError {
    param([Parameter(Mandatory)][string]$Code)
    $error = [InvalidOperationException]::new($Code)
    $error.Data['Code'] = $Code
    return $error
}

function Throw-CutoverHostError {
    param([Parameter(Mandatory)][string]$Code)
    throw (New-CutoverHostError $Code)
}

function Get-CutoverHostErrorCode {
    param([Parameter(Mandatory)][Exception]$Exception)
    if ($Exception.Data.Contains('Code')) {
        $code = [string]$Exception.Data['Code']
        if ($code -match '^(?:DYSON_CONTROL_CUTOVER_HOST|DYSON_HOST_MUTATION_LEASE)_[A-Z0-9_]+$') {
            return $code
        }
    }
    return 'DYSON_CONTROL_CUTOVER_HOST_FAILED'
}

function ConvertTo-CutoverHostJson {
    param([Parameter(Mandatory)]$Value)
    return ($Value | ConvertTo-Json -Depth 32 -Compress)
}

function Get-CutoverHostSha256Bytes {
    param([Parameter(Mandatory)][byte[]]$Bytes)
    $hasher = [Security.Cryptography.SHA256]::Create()
    try { return ([BitConverter]::ToString($hasher.ComputeHash($Bytes))).Replace('-', '').ToLowerInvariant() }
    finally { $hasher.Dispose() }
}

function Get-CutoverHostSha256Text {
    param([Parameter(Mandatory)][AllowEmptyString()][string]$Text)
    return Get-CutoverHostSha256Bytes ([Text.UTF8Encoding]::new($false).GetBytes($Text))
}

function Get-CutoverHostSha256File {
    param([Parameter(Mandatory)][string]$Path)
    return Get-CutoverHostSha256Bytes ([IO.File]::ReadAllBytes($Path))
}

function Test-CutoverHostSamePath {
    param([Parameter(Mandatory)][string]$Left, [Parameter(Mandatory)][string]$Right)
    try {
        $leftFull = [IO.Path]::GetFullPath($Left).TrimEnd('\', '/')
        $rightFull = [IO.Path]::GetFullPath($Right).TrimEnd('\', '/')
        return [string]::Equals($leftFull, $rightFull, [StringComparison]::OrdinalIgnoreCase)
    }
    catch { return $false }
}

function Assert-CutoverHostPlainDirectory {
    param([Parameter(Mandatory)][string]$Path, [switch]$Create)
    try {
        if ([string]::IsNullOrWhiteSpace($Path) -or $Path -match '["\r\n]') { throw 'invalid' }
        $full = [IO.Path]::GetFullPath($Path).TrimEnd('\', '/')
        if (-not [IO.Path]::IsPathRooted($full) -or
            [string]::Equals($full, [IO.Path]::GetPathRoot($full).TrimEnd('\', '/'), [StringComparison]::OrdinalIgnoreCase)) {
            throw 'invalid'
        }
        if ($Create -and -not (Test-Path -LiteralPath $full)) { [void][IO.Directory]::CreateDirectory($full) }
        $item = Get-Item -LiteralPath $full -Force -ErrorAction Stop
        if (-not $item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'redirected' }
        $canonical = Resolve-DysonHostMutationLeaseCanonicalDirectory -Path $item.FullName
        if (-not (Test-CutoverHostSamePath $canonical $item.FullName)) { throw 'redirected' }
        return $canonical.TrimEnd('\', '/')
    }
    catch {
        if ($_.Exception.Data.Contains('Code')) { throw $_.Exception }
        Throw-CutoverHostError 'DYSON_CONTROL_CUTOVER_HOST_PATH_INVALID'
    }
}

function Assert-CutoverHostPlainFile {
    param([Parameter(Mandatory)][string]$Path, [int64]$MaximumBytes = 4194304)
    try {
        if ([string]::IsNullOrWhiteSpace($Path) -or $Path -match '["\r\n]') { throw 'invalid' }
        $item = Get-Item -LiteralPath ([IO.Path]::GetFullPath($Path)) -Force -ErrorAction Stop
        if ($item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -or
            $item.Length -lt 1 -or $item.Length -gt $MaximumBytes) { throw 'invalid' }
        $parent = [IO.Path]::GetDirectoryName($item.FullName)
        $canonicalParent = Resolve-DysonHostMutationLeaseCanonicalDirectory -Path $parent
        if (-not (Test-CutoverHostSamePath $canonicalParent $parent)) { throw 'redirected' }
        return $item.FullName
    }
    catch {
        if ($_.Exception.Data.Contains('Code')) { throw $_.Exception }
        Throw-CutoverHostError 'DYSON_CONTROL_CUTOVER_HOST_FILE_INVALID'
    }
}

function Assert-CutoverHostExactProperties {
    param([Parameter(Mandatory)]$Value, [Parameter(Mandatory)][string[]]$Names)
    if ($null -eq $Value -or $Value -is [string] -or $Value -is [ValueType]) {
        Throw-CutoverHostError 'DYSON_CONTROL_CUTOVER_HOST_PROFILE_INVALID'
    }
    $actual = @($Value.PSObject.Properties.Name)
    if ($actual.Count -ne $Names.Count) { Throw-CutoverHostError 'DYSON_CONTROL_CUTOVER_HOST_PROFILE_INVALID' }
    foreach ($name in $Names) {
        if ($actual -cnotcontains $name) { Throw-CutoverHostError 'DYSON_CONTROL_CUTOVER_HOST_PROFILE_INVALID' }
    }
}

function New-CutoverHostOwnerSecurity {
    param([Parameter(Mandatory)][bool]$Directory)
    $security = if ($Directory) {
        [Security.AccessControl.DirectorySecurity]::new()
    }
    else { [Security.AccessControl.FileSecurity]::new() }
    $security.SetAccessRuleProtection($true, $false)
    $inheritance = if ($Directory) {
        [Security.AccessControl.InheritanceFlags]::ContainerInherit -bor
            [Security.AccessControl.InheritanceFlags]::ObjectInherit
    }
    else { [Security.AccessControl.InheritanceFlags]::None }
    $allow = [Security.AccessControl.AccessControlType]::Allow
    foreach ($entry in @(
        @('S-1-5-18', [Security.AccessControl.FileSystemRights]::FullControl),
        @('S-1-5-32-544', [Security.AccessControl.FileSystemRights]::FullControl),
        @('S-1-5-19', [Security.AccessControl.FileSystemRights]::ReadAndExecute)
    )) {
        $sid = [Security.Principal.SecurityIdentifier]::new([string]$entry[0])
        $rule = [Security.AccessControl.FileSystemAccessRule]::new(
            $sid, [Security.AccessControl.FileSystemRights]$entry[1], $inheritance,
            [Security.AccessControl.PropagationFlags]::None, $allow)
        [void]$security.AddAccessRule($rule)
    }
    return $security
}

function Test-CutoverHostOwnerSecurity {
    param([Parameter(Mandatory)]$Security, [Parameter(Mandatory)][bool]$Directory)
    if (-not [bool]$Security.AreAccessRulesProtected) { return $false }
    $rules = @($Security.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier]))
    if ($rules.Count -ne 3) { return $false }
    $readOnly = [Security.AccessControl.FileSystemRights]::ReadAndExecute -bor
        [Security.AccessControl.FileSystemRights]::Synchronize
    $expected = @{
        'S-1-5-18' = [Security.AccessControl.FileSystemRights]::FullControl
        'S-1-5-32-544' = [Security.AccessControl.FileSystemRights]::FullControl
        'S-1-5-19' = $readOnly
    }
    $expectedInheritance = if ($Directory) {
        [Security.AccessControl.InheritanceFlags]::ContainerInherit -bor
            [Security.AccessControl.InheritanceFlags]::ObjectInherit
    }
    else { [Security.AccessControl.InheritanceFlags]::None }
    foreach ($rule in $rules) {
        $sid = [string]$rule.IdentityReference.Value
        if (-not $expected.ContainsKey($sid) -or
            $rule.AccessControlType -ne [Security.AccessControl.AccessControlType]::Allow -or
            [int]$rule.FileSystemRights -ne [int]$expected[$sid] -or
            $rule.InheritanceFlags -ne $expectedInheritance -or
            $rule.PropagationFlags -ne [Security.AccessControl.PropagationFlags]::None) {
            return $false
        }
        [void]$expected.Remove($sid)
    }
    return $expected.Count -eq 0
}

function Assert-CutoverHostOwnerAcl {
    if ($script:CutoverHostBackend -ceq 'Shadow') { return }
    try {
        $root = Assert-CutoverHostPlainDirectory $script:CutoverHostRuntimeOwnerRoot
        $directorySecurity = Microsoft.PowerShell.Security\Get-Acl -LiteralPath $root -ErrorAction Stop
        if (-not (Test-CutoverHostOwnerSecurity $directorySecurity $true)) { throw 'directory acl' }
        if (Test-Path -LiteralPath $script:CutoverHostRuntimeOwnerFile) {
            $file = Assert-CutoverHostPlainFile $script:CutoverHostRuntimeOwnerFile 16384
            $fileSecurity = Microsoft.PowerShell.Security\Get-Acl -LiteralPath $file -ErrorAction Stop
            if (-not (Test-CutoverHostOwnerSecurity $fileSecurity $false)) { throw 'file acl' }
        }
    }
    catch {
        if ($_.Exception.Data.Contains('Code')) { throw $_.Exception }
        Throw-CutoverHostError 'DYSON_CONTROL_CUTOVER_HOST_OWNER_ACL_INVALID'
    }
}

function Set-CutoverHostOwnerFileAcl {
    param([Parameter(Mandatory)][string]$Path)
    Assert-CutoverHostMutationLease
    if ($script:CutoverHostBackend -ceq 'Shadow') { return }
    try {
        $file = Assert-CutoverHostPlainFile $Path 16384
        $security = New-CutoverHostOwnerSecurity $false
        Microsoft.PowerShell.Security\Set-Acl -LiteralPath $file -AclObject $security -ErrorAction Stop
        $verified = Microsoft.PowerShell.Security\Get-Acl -LiteralPath $file -ErrorAction Stop
        if (-not (Test-CutoverHostOwnerSecurity $verified $false)) { throw 'file acl' }
    }
    catch {
        if ($_.Exception.Data.Contains('Code')) { throw $_.Exception }
        Throw-CutoverHostError 'DYSON_CONTROL_CUTOVER_HOST_OWNER_ACL_INVALID'
    }
    Assert-CutoverHostMutationLease
}

function Assert-CutoverHostSha256 {
    param([AllowNull()]$Value)
    if ($Value -isnot [string] -or [string]$Value -cnotmatch '^[0-9a-f]{64}$') {
        Throw-CutoverHostError 'DYSON_CONTROL_CUTOVER_HOST_PROFILE_INVALID'
    }
    return [string]$Value
}

function Assert-CutoverHostPathIdentity {
    param([AllowNull()]$Value)
    if ($Value -isnot [string] -or [string]$Value -cnotmatch '^sha256:[0-9a-f]{64}$') {
        Throw-CutoverHostError 'DYSON_CONTROL_CUTOVER_HOST_PROFILE_INVALID'
    }
    return [string]$Value
}

function Read-CutoverHostJsonFile {
    param([Parameter(Mandatory)][string]$Path, [int64]$MaximumBytes = 131072)
    $plain = Assert-CutoverHostPlainFile -Path $Path -MaximumBytes $MaximumBytes
    try {
        $bytes = [IO.File]::ReadAllBytes($plain)
        $encoding = [Text.UTF8Encoding]::new($false, $true)
        $text = $encoding.GetString($bytes)
        if ($text.IndexOf([char]0) -ge 0) { throw 'nul' }
        return ($text | ConvertFrom-Json -ErrorAction Stop)
    }
    catch {
        if ($_.Exception.Data.Contains('Code')) { throw $_.Exception }
        Throw-CutoverHostError 'DYSON_CONTROL_CUTOVER_HOST_JSON_INVALID'
    }
}

function Get-CutoverHostPathIdentity {
    param([Parameter(Mandatory)][string]$Path)
    return 'sha256:' + (Get-CutoverHostSha256Text ([IO.Path]::GetFullPath($Path).TrimEnd('\', '/').ToUpperInvariant()))
}

function ConvertTo-CutoverHostTaskProfile {
    param([Parameter(Mandatory)]$Value, [Parameter(Mandatory)][string]$ExpectedTaskName)
    Assert-CutoverHostExactProperties $Value @('taskName', 'taskPath', 'definitionSha256', 'enabled')
    if ($Value.taskName -isnot [string] -or [string]$Value.taskName -cne $ExpectedTaskName -or
        $Value.taskPath -isnot [string] -or [string]$Value.taskPath -cne '\' -or
        $Value.enabled -isnot [bool] -or -not [bool]$Value.enabled) {
        Throw-CutoverHostError 'DYSON_CONTROL_CUTOVER_HOST_PROFILE_INVALID'
    }
    return [pscustomobject][ordered]@{
        taskName = $ExpectedTaskName
        taskPath = '\'
        definitionSha256 = Assert-CutoverHostSha256 $Value.definitionSha256
        enabled = $true
    }
}

function ConvertTo-CutoverHostValidatedProfile {
    param([Parameter(Mandatory)]$Raw)
    $topNames = @(
        'protocol', 'schemaVersion', 'requestId', 'requestFingerprint', 'projectRootIdentity',
        'dataRootIdentity', 'authorityRootIdentity', 'runtimeBootstrapIdentity',
        'runtimeBootstrapStartSha256', 'runtimeBootstrapStopSha256',
        'runtimeTaskTransactionRootIdentity', 'serviceUser', 'gamePort', 'previousAuthority',
        'candidateAuthority', 'previousScriptBundleRevision', 'inventoryRevision'
    )
    $hasAuthoritySource = $null -ne $Raw.PSObject.Properties['authoritySource']
    $hasLegacyTemplate = $null -ne $Raw.PSObject.Properties['legacyTemplateSha256']
    if ($hasAuthoritySource -ne $hasLegacyTemplate) {
        Throw-CutoverHostError 'DYSON_CONTROL_CUTOVER_HOST_PROFILE_INVALID'
    }
    if ($hasAuthoritySource) {
        $topNames += @('authoritySource', 'legacyTemplateSha256')
        if ($Raw.authoritySource -isnot [string] -or
            [string]$Raw.authoritySource -cne 'reconstructed-template' -or
            $Raw.legacyTemplateSha256 -isnot [string] -or
            [string]$Raw.legacyTemplateSha256 -cnotmatch '^[0-9a-f]{64}$') {
            Throw-CutoverHostError 'DYSON_CONTROL_CUTOVER_HOST_PROFILE_INVALID'
        }
    }
    Assert-CutoverHostExactProperties $Raw $topNames
    $parsedId = [guid]::Empty
    if ($Raw.protocol -isnot [string] -or [string]$Raw.protocol -cne 'DYSON_GSMANAGER_AUTHORITY_PROFILE_V1' -or
        $Raw.schemaVersion -isnot [int] -and $Raw.schemaVersion -isnot [long] -or [int64]$Raw.schemaVersion -ne 1 -or
        $Raw.requestId -isnot [string] -or -not [guid]::TryParseExact([string]$Raw.requestId, 'D', [ref]$parsedId) -or
        $Raw.requestFingerprint -isnot [string] -or [string]$Raw.requestFingerprint -cnotmatch '^[0-9a-f]{64}$' -or
        $Raw.serviceUser -isnot [string] -or [string]$Raw.serviceUser -notmatch '^[^"\r\n]{3,128}$' -or
        ($Raw.gamePort -isnot [int] -and $Raw.gamePort -isnot [long]) -or [int64]$Raw.gamePort -lt 1 -or [int64]$Raw.gamePort -gt 65535) {
        Throw-CutoverHostError 'DYSON_CONTROL_CUTOVER_HOST_PROFILE_INVALID'
    }
    Assert-CutoverHostExactProperties $Raw.previousAuthority @('main', 'start', 'stop')
    Assert-CutoverHostExactProperties $Raw.candidateAuthority @(
        'startTaskName', 'stopTaskName', 'taskPath', 'legacyPreimage',
        'expectedPreparedDisabled', 'expectedActive', 'allowedTransitions'
    )
    Assert-CutoverHostExactProperties $Raw.candidateAuthority.legacyPreimage @(
        'startDefinitionSha256', 'stopDefinitionSha256',
        'expectedEnabledBeforeIsolation', 'expectedEnabledAfterIsolation'
    )
    Assert-CutoverHostExactProperties $Raw.candidateAuthority.expectedPreparedDisabled @(
        'startDescriptorSha256', 'stopDescriptorSha256'
    )
    Assert-CutoverHostExactProperties $Raw.candidateAuthority.expectedActive @(
        'startDescriptorSha256', 'stopDescriptorSha256'
    )
    $candidate = $Raw.candidateAuthority
    if ($candidate.startTaskName -isnot [string] -or [string]$candidate.startTaskName -cne $script:CutoverHostCandidateStartTask -or
        $candidate.stopTaskName -isnot [string] -or [string]$candidate.stopTaskName -cne $script:CutoverHostCandidateStopTask -or
        $candidate.taskPath -isnot [string] -or [string]$candidate.taskPath -cne '\' -or
        $candidate.legacyPreimage.expectedEnabledBeforeIsolation -isnot [bool] -or
        [bool]$candidate.legacyPreimage.expectedEnabledBeforeIsolation -ne (-not $hasAuthoritySource) -or
        $candidate.legacyPreimage.expectedEnabledAfterIsolation -isnot [bool] -or
        [bool]$candidate.legacyPreimage.expectedEnabledAfterIsolation) {
        Throw-CutoverHostError 'DYSON_CONTROL_CUTOVER_HOST_PROFILE_INVALID'
    }
    $transitions = @($candidate.allowedTransitions)
    if ($transitions.Count -ne 3 -or [string]$transitions[0] -cne 'legacy-preimage-disabled' -or
        [string]$transitions[1] -cne 'prepared-disabled' -or [string]$transitions[2] -cne 'active') {
        Throw-CutoverHostError 'DYSON_CONTROL_CUTOVER_HOST_PROFILE_INVALID'
    }
    $profile = [pscustomobject][ordered]@{
        protocol = 'DYSON_GSMANAGER_AUTHORITY_PROFILE_V1'
        schemaVersion = 1
        requestId = $parsedId.ToString('D').ToLowerInvariant()
        requestFingerprint = Assert-CutoverHostSha256 $Raw.requestFingerprint
        projectRootIdentity = Assert-CutoverHostPathIdentity $Raw.projectRootIdentity
        dataRootIdentity = Assert-CutoverHostPathIdentity $Raw.dataRootIdentity
        authorityRootIdentity = Assert-CutoverHostPathIdentity $Raw.authorityRootIdentity
        runtimeBootstrapIdentity = Assert-CutoverHostPathIdentity $Raw.runtimeBootstrapIdentity
        runtimeBootstrapStartSha256 = Assert-CutoverHostSha256 $Raw.runtimeBootstrapStartSha256
        runtimeBootstrapStopSha256 = Assert-CutoverHostSha256 $Raw.runtimeBootstrapStopSha256
        runtimeTaskTransactionRootIdentity = Assert-CutoverHostPathIdentity $Raw.runtimeTaskTransactionRootIdentity
        serviceUser = [string]$Raw.serviceUser
        gamePort = [int]$Raw.gamePort
        previousAuthority = [pscustomobject][ordered]@{
            main = ConvertTo-CutoverHostTaskProfile $Raw.previousAuthority.main $script:CutoverHostPreviousPanelTask
            start = ConvertTo-CutoverHostTaskProfile $Raw.previousAuthority.start $script:CutoverHostPreviousStartTask
            stop = ConvertTo-CutoverHostTaskProfile $Raw.previousAuthority.stop $script:CutoverHostPreviousStopTask
        }
        candidateAuthority = [pscustomobject][ordered]@{
            startTaskName = $script:CutoverHostCandidateStartTask
            stopTaskName = $script:CutoverHostCandidateStopTask
            taskPath = '\'
            legacyPreimage = [pscustomobject][ordered]@{
                startDefinitionSha256 = Assert-CutoverHostSha256 $candidate.legacyPreimage.startDefinitionSha256
                stopDefinitionSha256 = Assert-CutoverHostSha256 $candidate.legacyPreimage.stopDefinitionSha256
                expectedEnabledBeforeIsolation = [bool]$candidate.legacyPreimage.expectedEnabledBeforeIsolation
                expectedEnabledAfterIsolation = $false
            }
            expectedPreparedDisabled = [pscustomobject][ordered]@{
                startDescriptorSha256 = Assert-CutoverHostSha256 $candidate.expectedPreparedDisabled.startDescriptorSha256
                stopDescriptorSha256 = Assert-CutoverHostSha256 $candidate.expectedPreparedDisabled.stopDescriptorSha256
            }
            expectedActive = [pscustomobject][ordered]@{
                startDescriptorSha256 = Assert-CutoverHostSha256 $candidate.expectedActive.startDescriptorSha256
                stopDescriptorSha256 = Assert-CutoverHostSha256 $candidate.expectedActive.stopDescriptorSha256
            }
            allowedTransitions = @('legacy-preimage-disabled', 'prepared-disabled', 'active')
        }
        previousScriptBundleRevision = Assert-CutoverHostSha256 $Raw.previousScriptBundleRevision
    }
    if ($hasAuthoritySource) {
        $profile | Add-Member NoteProperty authoritySource ([string]$Raw.authoritySource)
        $profile | Add-Member NoteProperty legacyTemplateSha256 ([string]$Raw.legacyTemplateSha256)
    }
    $profile | Add-Member NoteProperty inventoryRevision (Assert-CutoverHostSha256 $Raw.inventoryRevision)
    $core = [ordered]@{}
    foreach ($property in $profile.PSObject.Properties) {
        if ($property.Name -cne 'inventoryRevision') { $core[$property.Name] = $property.Value }
    }
    if ((Get-CutoverHostSha256Text (ConvertTo-CutoverHostJson $core)) -cne [string]$profile.inventoryRevision) {
        Throw-CutoverHostError 'DYSON_CONTROL_CUTOVER_HOST_PROFILE_REVISION_INVALID'
    }
    return $profile
}

function Get-CutoverHostExpectedCandidateDescriptors {
    param([Parameter(Mandatory)][bool]$Enabled)
    $powerShell = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
    $startScript = Join-Path $script:CutoverHostRuntimeBootstrapRoot 'Start-DysonServer.ps1'
    $stopScript = Join-Path $script:CutoverHostRuntimeBootstrapRoot 'Stop-DysonServer.ps1'
    return [pscustomobject][ordered]@{
        start = [pscustomobject][ordered]@{
            taskName = $script:CutoverHostCandidateStartTask; taskPath = '\'; execute = $powerShell
            arguments = ('-NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "{0}" -ProjectRoot "{1}" -Ups 60' -f $startScript, $script:CutoverHostProjectRoot)
            userId = $script:CutoverHostServiceUser; logonType = 'Interactive'; runLevel = 'Limited'
            trigger = 'AtLogOn'; triggerUserId = $script:CutoverHostServiceUser; triggerDelay = 'PT20S'
            executionTimeLimit = 'PT0S'; multipleInstances = 'IgnoreNew'; restartCount = 3
            restartInterval = 'PT1M'; startWhenAvailable = $true; enabled = $Enabled
            taskSecurityDescriptor = 'O:SYG:SYD:P(A;;GA;;;SY)(A;;GA;;;BA)(A;;GRGX;;;LS)'
            description = 'Starts DSP, BepInEx, Nebula, and the Dyson Control bridge from the stable bootstrap root.'
        }
        stop = [pscustomobject][ordered]@{
            taskName = $script:CutoverHostCandidateStopTask; taskPath = '\'; execute = $powerShell
            arguments = ('-NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "{0}" -ProjectRoot "{1}" -TimeoutSeconds 150' -f $stopScript, $script:CutoverHostProjectRoot)
            userId = $script:CutoverHostServiceUser; logonType = 'Interactive'; runLevel = 'Limited'
            trigger = 'None'; triggerUserId = $null; triggerDelay = $null; executionTimeLimit = 'PT5M'
            multipleInstances = 'IgnoreNew'; restartCount = 0; restartInterval = $null
            startWhenAvailable = $false; enabled = $Enabled
            taskSecurityDescriptor = 'O:SYG:SYD:P(A;;GA;;;SY)(A;;GA;;;BA)(A;;GRGX;;;LS)'
            description = 'Sends a graceful console stop to the exact managed DSP process; never force-kills on timeout.'
        }
    }
}

function Read-CutoverHostProfile {
    $raw = Read-CutoverHostJsonFile -Path $script:CutoverHostProfileFile -MaximumBytes $script:CutoverHostMaximumJsonBytes
    $profile = ConvertTo-CutoverHostValidatedProfile $raw
    if ([string]$profile.inventoryRevision -cne $script:CutoverHostExpectedInventoryRevision -or
        [string]$profile.projectRootIdentity -cne (Get-CutoverHostPathIdentity $script:CutoverHostProjectRoot) -or
        [string]$profile.dataRootIdentity -cne $script:CutoverHostDataRootIdentity -or
        [string]$profile.authorityRootIdentity -cne (Get-CutoverHostPathIdentity ([IO.Path]::GetDirectoryName($script:CutoverHostProfileFile))) -or
        [string]$profile.runtimeBootstrapIdentity -cne (Get-CutoverHostPathIdentity $script:CutoverHostRuntimeBootstrapRoot) -or
        [string]$profile.runtimeTaskTransactionRootIdentity -cne (Get-CutoverHostPathIdentity $script:CutoverHostRuntimeTaskTransactionRoot) -or
        -not [string]::Equals([string]$profile.serviceUser, $script:CutoverHostServiceUser, [StringComparison]::OrdinalIgnoreCase) -or
        [int]$profile.gamePort -ne $script:CutoverHostGamePort) {
        Throw-CutoverHostError 'DYSON_CONTROL_CUTOVER_HOST_PROFILE_BINDING_MISMATCH'
    }
    $bootstrapStart = Assert-CutoverHostPlainFile (Join-Path $script:CutoverHostRuntimeBootstrapRoot 'Start-DysonServer.ps1')
    $bootstrapStop = Assert-CutoverHostPlainFile (Join-Path $script:CutoverHostRuntimeBootstrapRoot 'Stop-DysonServer.ps1')
    $previousStart = Assert-CutoverHostPlainFile (Join-Path $script:CutoverHostPreviousScriptRoot 'start-dyson-server.ps1')
    $previousStop = Assert-CutoverHostPlainFile (Join-Path $script:CutoverHostPreviousScriptRoot 'stop-dyson-server.ps1')
    $bundle = Get-CutoverHostSha256Text ((Get-CutoverHostSha256File $previousStart) + ':' + (Get-CutoverHostSha256File $previousStop))
    if ([string]$profile.runtimeBootstrapStartSha256 -cne (Get-CutoverHostSha256File $bootstrapStart) -or
        [string]$profile.runtimeBootstrapStopSha256 -cne (Get-CutoverHostSha256File $bootstrapStop) -or
        [string]$profile.previousScriptBundleRevision -cne $bundle) {
        Throw-CutoverHostError 'DYSON_CONTROL_CUTOVER_HOST_PROFILE_BINDING_MISMATCH'
    }
    $prepared = Get-CutoverHostExpectedCandidateDescriptors $false
    $active = Get-CutoverHostExpectedCandidateDescriptors $true
    if ([string]$profile.candidateAuthority.expectedPreparedDisabled.startDescriptorSha256 -cne (Get-CutoverHostSha256Text (ConvertTo-CutoverHostJson $prepared.start)) -or
        [string]$profile.candidateAuthority.expectedPreparedDisabled.stopDescriptorSha256 -cne (Get-CutoverHostSha256Text (ConvertTo-CutoverHostJson $prepared.stop)) -or
        [string]$profile.candidateAuthority.expectedActive.startDescriptorSha256 -cne (Get-CutoverHostSha256Text (ConvertTo-CutoverHostJson $active.start)) -or
        [string]$profile.candidateAuthority.expectedActive.stopDescriptorSha256 -cne (Get-CutoverHostSha256Text (ConvertTo-CutoverHostJson $active.stop))) {
        Throw-CutoverHostError 'DYSON_CONTROL_CUTOVER_HOST_PROFILE_BINDING_MISMATCH'
    }
    return $profile
}

function Assert-CutoverHostProfileRevision {
    $profile = Read-CutoverHostProfile
    if ([string]$profile.inventoryRevision -cne $script:CutoverHostExpectedInventoryRevision) {
        Throw-CutoverHostError 'DYSON_CONTROL_CUTOVER_HOST_PROFILE_REVISION_INVALID'
    }
    return $profile
}

function Get-CutoverHostShadowState {
    $state = Read-CutoverHostJsonFile (Join-Path $script:CutoverHostShadowRoot 'tasks.json')
    Assert-CutoverHostExactProperties $state @('protocol', 'tasks')
    if ($state.protocol -isnot [string] -or [string]$state.protocol -cne 'DYSON_CONTROL_CUTOVER_HOST_SHADOW_TASKS_V1') {
        Throw-CutoverHostError 'DYSON_CONTROL_CUTOVER_HOST_SHADOW_INVALID'
    }
    return $state
}

function Write-CutoverHostShadowState {
    param([Parameter(Mandatory)]$State, [Parameter(Mandatory)][string]$WriteKind)
    Assert-CutoverHostMutationLease
    $path = Join-Path $script:CutoverHostShadowRoot 'tasks.json'
    $temporary = $path + '.' + [guid]::NewGuid().ToString('N') + '.tmp'
    try {
        [IO.File]::WriteAllText($temporary, (ConvertTo-CutoverHostJson $State) + "`n", [Text.UTF8Encoding]::new($false))
        if (Test-Path -LiteralPath $path -PathType Leaf) { [IO.File]::Delete($path) }
        [IO.File]::Move($temporary, $path)
        [IO.File]::AppendAllText((Join-Path $script:CutoverHostShadowRoot 'writes.log'), $WriteKind + "`n", [Text.UTF8Encoding]::new($false))
    }
    catch {
        if ($_.Exception.Data.Contains('Code')) { throw $_.Exception }
        Throw-CutoverHostError 'DYSON_CONTROL_CUTOVER_HOST_SHADOW_WRITE_FAILED'
    }
    finally { if (Test-Path -LiteralPath $temporary -PathType Leaf) { Remove-Item -LiteralPath $temporary -Force -ErrorAction SilentlyContinue } }
    Assert-CutoverHostMutationLease
}

function Get-CutoverHostTaskImages {
    param([Parameter(Mandatory)][string]$TaskName)
    if ($script:CutoverHostBackend -ceq 'Shadow') {
        $state = Get-CutoverHostShadowState
        return @($state.tasks | Where-Object {
            $_.taskName -is [string] -and [string]::Equals([string]$_.taskName, $TaskName, [StringComparison]::OrdinalIgnoreCase)
        } | ForEach-Object {
            Assert-CutoverHostExactProperties $_ @('taskName', 'taskPath', 'xmlBase64', 'enabled', 'running', 'descriptor')
            try { [void][Convert]::FromBase64String([string]$_.xmlBase64) }
            catch { Throw-CutoverHostError 'DYSON_CONTROL_CUTOVER_HOST_TASK_INVALID' }
            [pscustomobject][ordered]@{
                taskName = [string]$_.taskName; taskPath = [string]$_.taskPath; present = $true
                xmlBase64 = [string]$_.xmlBase64; enabled = [bool]$_.enabled; running = [bool]$_.running
                descriptor = $_.descriptor; nativeTask = $null
            }
        })
    }
    try {
        return @(Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue | ForEach-Object {
            $task = $_
            $xml = [string](Export-ScheduledTask -TaskName ([string]$task.TaskName) -TaskPath ([string]$task.TaskPath) -ErrorAction Stop)
            [pscustomobject][ordered]@{
                taskName = [string]$task.TaskName; taskPath = [string]$task.TaskPath; present = $true
                xmlBase64 = [Convert]::ToBase64String([Text.UTF8Encoding]::new($false).GetBytes($xml))
                enabled = [bool]$task.Settings.Enabled; running = ([string]$task.State -ceq 'Running')
                descriptor = $null; nativeTask = $task
            }
        })
    }
    catch { Throw-CutoverHostError 'DYSON_CONTROL_CUTOVER_HOST_SCHEDULER_UNAVAILABLE' }
}

function Get-CutoverHostTaskImage {
    param([Parameter(Mandatory)][string]$TaskName, [switch]$AllowMissing)
    $matches = @(Get-CutoverHostTaskImages $TaskName)
    if ($matches.Count -eq 0) {
        if (-not $AllowMissing) { Throw-CutoverHostError 'DYSON_CONTROL_CUTOVER_HOST_TASK_MISSING' }
        return [pscustomobject][ordered]@{
            taskName = $TaskName; taskPath = '\'; present = $false; xmlBase64 = $null
            enabled = $false; running = $false; descriptor = $null; nativeTask = $null
        }
    }
    if ($matches.Count -ne 1 -or [string]$matches[0].taskName -cne $TaskName -or
        [string]$matches[0].taskPath -cne '\') {
        Throw-CutoverHostError 'DYSON_CONTROL_CUTOVER_HOST_TASK_AMBIGUOUS'
    }
    return $matches[0]
}

function Get-CutoverHostTaskDefinitionSha256 {
    param([Parameter(Mandatory)]$Image, [switch]$NormalizeSettingsEnabledTrue)
    if (-not [bool]$Image.present) { return $null }
    $bytes = [Convert]::FromBase64String([string]$Image.xmlBase64)
    if (-not $NormalizeSettingsEnabledTrue -or [bool]$Image.enabled -or $script:CutoverHostBackend -ceq 'Shadow') {
        return Get-CutoverHostSha256Bytes $bytes
    }
    try {
        $text = [Text.UTF8Encoding]::new($false, $true).GetString($bytes)
        $pattern = '(?is)(<Settings(?:\s[^>]*)?>.*?<Enabled>)(?:true|false)(</Enabled>)'
        $matches = [regex]::Matches($text, $pattern)
        if ($matches.Count -ne 1) { throw 'settings enabled ambiguous' }
        $normalized = [regex]::Replace($text, $pattern, '${1}true${2}', 1)
        return Get-CutoverHostSha256Text $normalized
    }
    catch { Throw-CutoverHostError 'DYSON_CONTROL_CUTOVER_HOST_TASK_INVALID' }
}

function Test-CutoverHostTaskUserEqual {
    param([string]$Actual, [string]$Expected)
    try {
        $sids = @(foreach ($value in @($Actual, $Expected)) {
            if ($value -match '^S-1-') { ([Security.Principal.SecurityIdentifier]::new($value)).Value }
            else { ([Security.Principal.NTAccount]::new($value)).Translate([Security.Principal.SecurityIdentifier]).Value }
        })
        return $sids[0] -ceq $sids[1]
    }
    catch { return $false }
}

function Test-CutoverHostCandidateTask {
    param([Parameter(Mandatory)]$Image, [Parameter(Mandatory)]$Expected)
    if (-not [bool]$Image.present -or [bool]$Image.enabled -ne [bool]$Expected.enabled) { return $false }
    if ($script:CutoverHostBackend -ceq 'Shadow') {
        if ($null -eq $Image.descriptor) { return $false }
        return (ConvertTo-CutoverHostJson $Image.descriptor) -ceq (ConvertTo-CutoverHostJson $Expected)
    }
    $task = $Image.nativeTask
    try {
        $actions = @($task.Actions | Where-Object { $null -ne $_ })
        $triggers = @($task.Triggers | Where-Object { $null -ne $_ })
        if ($actions.Count -ne 1 -or -not [string]::IsNullOrWhiteSpace([string]$actions[0].WorkingDirectory) -or
            -not (Test-CutoverHostSamePath ([Environment]::ExpandEnvironmentVariables([string]$actions[0].Execute)) ([string]$Expected.execute)) -or
            [string]$actions[0].Arguments -cne [string]$Expected.arguments -or
            -not (Test-CutoverHostTaskUserEqual ([string]$task.Principal.UserId) ([string]$Expected.userId)) -or
            [string]$task.Principal.LogonType -cne [string]$Expected.logonType -or
            [string]$task.Principal.RunLevel -cne [string]$Expected.runLevel -or
            [string]$task.Settings.MultipleInstances -cne [string]$Expected.multipleInstances -or
            [string]$task.Settings.ExecutionTimeLimit -cne [string]$Expected.executionTimeLimit -or
            [int]$task.Settings.RestartCount -ne [int]$Expected.restartCount -or
            [bool]$task.Settings.StartWhenAvailable -ne [bool]$Expected.startWhenAvailable -or
            [string]$task.Description -cne [string]$Expected.description) { return $false }
        $actualRestartInterval = if ([string]::IsNullOrWhiteSpace([string]$task.Settings.RestartInterval)) { $null } else { [string]$task.Settings.RestartInterval }
        if ($actualRestartInterval -ne $Expected.restartInterval) { return $false }
        if ([string]$Expected.trigger -ceq 'AtLogOn') {
            return $triggers.Count -eq 1 -and
                (Test-CutoverHostTaskUserEqual ([string]$triggers[0].UserId) ([string]$Expected.triggerUserId)) -and
                [string]$triggers[0].Delay -ceq [string]$Expected.triggerDelay
        }
        return $triggers.Count -eq 0
    }
    catch { return $false }
}

function Test-CutoverHostPreviousTask {
    param([Parameter(Mandatory)]$Image, [Parameter(Mandatory)]$ProfileTask, [switch]$AllowDisabled)
    if (-not [bool]$Image.present) { return $false }
    if (-not $AllowDisabled -and -not [bool]$Image.enabled) { return $false }
    $hash = Get-CutoverHostTaskDefinitionSha256 $Image -NormalizeSettingsEnabledTrue:$AllowDisabled
    return [string]$hash -ceq [string]$ProfileTask.definitionSha256
}

function Get-CutoverHostAuthorityObservation {
    param([Parameter(Mandatory)]$Profile)
    $panel = Get-CutoverHostTaskImage $script:CutoverHostPreviousPanelTask -AllowMissing
    $previousStart = Get-CutoverHostTaskImage $script:CutoverHostPreviousStartTask -AllowMissing
    $previousStop = Get-CutoverHostTaskImage $script:CutoverHostPreviousStopTask -AllowMissing
    $candidateStart = Get-CutoverHostTaskImage $script:CutoverHostCandidateStartTask -AllowMissing
    $candidateStop = Get-CutoverHostTaskImage $script:CutoverHostCandidateStopTask -AllowMissing

    $panelExact = Test-CutoverHostPreviousTask $panel $Profile.previousAuthority.main -AllowDisabled
    $previousStartExact = Test-CutoverHostPreviousTask $previousStart $Profile.previousAuthority.start
    $previousStopExact = Test-CutoverHostPreviousTask $previousStop $Profile.previousAuthority.stop
    $previousDefined = $panelExact -and $previousStartExact -and $previousStopExact
    $previousLive = $previousDefined -and [bool]$panel.enabled -and [bool]$panel.running

    $prepared = Get-CutoverHostExpectedCandidateDescriptors $false
    $active = Get-CutoverHostExpectedCandidateDescriptors $true
    $candidatePrepared = (Test-CutoverHostCandidateTask $candidateStart $prepared.start) -and
        (Test-CutoverHostCandidateTask $candidateStop $prepared.stop)
    $candidateActive = (Test-CutoverHostCandidateTask $candidateStart $active.start) -and
        (Test-CutoverHostCandidateTask $candidateStop $active.stop)
    $candidateStopTemporarilyEnabled = (Test-CutoverHostCandidateTask $candidateStart $prepared.start) -and
        (Test-CutoverHostCandidateTask $candidateStop $active.stop)
    # A prepared candidate may be the disabled preimage in reconstructed mode.
    # Its current descriptor identifies candidate authority, not historical code.
    $legacyExact = -not $candidatePrepared -and -not $candidateActive -and
        -not $candidateStopTemporarilyEnabled -and
        [bool]$candidateStart.present -and [bool]$candidateStop.present -and
        -not [bool]$candidateStart.enabled -and -not [bool]$candidateStop.enabled -and
        (Get-CutoverHostTaskDefinitionSha256 $candidateStart) -ceq [string]$Profile.candidateAuthority.legacyPreimage.startDefinitionSha256 -and
        (Get-CutoverHostTaskDefinitionSha256 $candidateStop) -ceq [string]$Profile.candidateAuthority.legacyPreimage.stopDefinitionSha256

    $structuralDrift = -not $previousDefined -or
        (-not $candidatePrepared -and -not $candidateActive -and -not $legacyExact -and -not $candidateStopTemporarilyEnabled)
    $unexpectedManagedTask = Test-CutoverHostUnexpectedManagedTask
    $transitionalPanelState = $previousDefined -and ([bool]$panel.enabled -ne [bool]$panel.running)
    return [pscustomobject][ordered]@{
        panel = $panel; previousStart = $previousStart; previousStop = $previousStop
        candidateStart = $candidateStart; candidateStop = $candidateStop
        previousDefined = [bool]$previousDefined; previousLive = [bool]$previousLive
        candidateDefined = [bool]($candidatePrepared -or $candidateActive)
        candidateActive = [bool]$candidateActive; candidatePrepared = [bool]$candidatePrepared
        candidateLegacy = [bool]$legacyExact; candidateStopTemporarilyEnabled = [bool]$candidateStopTemporarilyEnabled
        structuralDrift = [bool]$structuralDrift
        unexpectedAuthority = [bool]($structuralDrift -or $unexpectedManagedTask -or $transitionalPanelState -or ($previousLive -and $candidateActive))
    }
}

function Test-CutoverHostUnexpectedManagedTask {
    $fixed = @(
        $script:CutoverHostPreviousPanelTask, $script:CutoverHostPreviousStartTask,
        $script:CutoverHostPreviousStopTask, $script:CutoverHostCandidateStartTask,
        $script:CutoverHostCandidateStopTask
    )
    $managedScripts = @(
        (Join-Path $script:CutoverHostPreviousScriptRoot 'start-dyson-server.ps1'),
        (Join-Path $script:CutoverHostPreviousScriptRoot 'stop-dyson-server.ps1'),
        (Join-Path $script:CutoverHostRuntimeBootstrapRoot 'Start-DysonServer.ps1'),
        (Join-Path $script:CutoverHostRuntimeBootstrapRoot 'Stop-DysonServer.ps1')
    )
    try {
        $tasks = if ($script:CutoverHostBackend -ceq 'Shadow') {
            @((Get-CutoverHostShadowState).tasks)
        }
        else { @(Get-ScheduledTask -ErrorAction Stop) }
        foreach ($task in $tasks) {
            $name = if ($script:CutoverHostBackend -ceq 'Shadow') { [string]$task.taskName } else { [string]$task.TaskName }
            $path = if ($script:CutoverHostBackend -ceq 'Shadow') { [string]$task.taskPath } else { [string]$task.TaskPath }
            if ($path -ceq '\' -and $fixed -ccontains $name) { continue }
            $actions = if ($script:CutoverHostBackend -ceq 'Shadow') {
                if ($null -eq $task.descriptor) { @() } else { @([pscustomobject]@{ Execute = $task.descriptor.execute; Arguments = $task.descriptor.arguments }) }
            }
            else { @($task.Actions) }
            foreach ($action in $actions) {
                # Native task enumeration also returns COM-handler actions,
                # which have ClassId/Data rather than Execute/Arguments.
                if ($null -eq $action) { continue }
                $executeProperty = $action.PSObject.Properties['Execute']
                if ($null -eq $executeProperty -or
                    [string]::IsNullOrWhiteSpace([string]$executeProperty.Value)) { continue }
                $execute = [Environment]::ExpandEnvironmentVariables([string]$executeProperty.Value)
                if (Test-CutoverHostSamePath $execute $script:CutoverHostExpectedExecutable) { return $true }
                $argumentsProperty = $action.PSObject.Properties['Arguments']
                $arguments = if ($null -ne $argumentsProperty) { [string]$argumentsProperty.Value } else { '' }
                $match = [regex]::Match($arguments,
                    '(?i)(?:^|\s)-File(?:\s+|:)(?:"(?<double>[^"\r\n]+)"|''(?<single>[^''\r\n]+)''|(?<bare>[^\s"\r\n]+))')
                if ($match.Success) {
                    $taskScript = if ($match.Groups['double'].Success) { $match.Groups['double'].Value }
                        elseif ($match.Groups['single'].Success) { $match.Groups['single'].Value }
                        else { $match.Groups['bare'].Value }
                    $taskScript = [Environment]::ExpandEnvironmentVariables($taskScript)
                    foreach ($managedScript in $managedScripts) {
                        if (Test-CutoverHostSamePath $taskScript $managedScript) { return $true }
                    }
                }
            }
        }
        return $false
    }
    catch { Throw-CutoverHostError 'DYSON_CONTROL_CUTOVER_HOST_SCHEDULER_UNAVAILABLE' }
}

function Get-CutoverHostShadowRuntime {
    $runtime = Read-CutoverHostJsonFile (Join-Path $script:CutoverHostShadowRoot 'runtime.json')
    Assert-CutoverHostExactProperties $runtime @('protocol', 'dspProcesses', 'pidRecord', 'tcpOwners', 'udpOwners')
    if ($runtime.protocol -isnot [string] -or [string]$runtime.protocol -cne 'DYSON_CONTROL_CUTOVER_HOST_SHADOW_RUNTIME_V1') {
        Throw-CutoverHostError 'DYSON_CONTROL_CUTOVER_HOST_SHADOW_INVALID'
    }
    return $runtime
}

function Write-CutoverHostShadowRuntime {
    param([Parameter(Mandatory)]$Runtime, [Parameter(Mandatory)][string]$WriteKind)
    Assert-CutoverHostMutationLease
    $path = Join-Path $script:CutoverHostShadowRoot 'runtime.json'
    $temporary = $path + '.' + [guid]::NewGuid().ToString('N') + '.tmp'
    try {
        [IO.File]::WriteAllText($temporary, (ConvertTo-CutoverHostJson $Runtime) + "`n", [Text.UTF8Encoding]::new($false))
        [IO.File]::Delete($path)
        [IO.File]::Move($temporary, $path)
        [IO.File]::AppendAllText((Join-Path $script:CutoverHostShadowRoot 'writes.log'), $WriteKind + "`n", [Text.UTF8Encoding]::new($false))
    }
    catch {
        if ($_.Exception.Data.Contains('Code')) { throw $_.Exception }
        Throw-CutoverHostError 'DYSON_CONTROL_CUTOVER_HOST_SHADOW_WRITE_FAILED'
    }
    finally { if (Test-Path -LiteralPath $temporary -PathType Leaf) { Remove-Item -LiteralPath $temporary -Force -ErrorAction SilentlyContinue } }
    Assert-CutoverHostMutationLease
}

function Get-CutoverHostNativeRuntime {
    $processes = @()
    $unverified = $false
    try {
        foreach ($candidate in @(Get-Process -Name 'DSPGAME' -ErrorAction SilentlyContinue)) {
            try {
                $candidatePath = [IO.Path]::GetFullPath([string]$candidate.Path)
                $processes += [pscustomobject][ordered]@{ id = [int]$candidate.Id; path = $candidatePath }
            }
            catch { $unverified = $true }
        }
        $pidRecord = $null
        $pidInvalid = $false
        if (Test-Path -LiteralPath $script:CutoverHostPidFile) {
            try {
                $item = Get-Item -LiteralPath $script:CutoverHostPidFile -Force -ErrorAction Stop
                if ($item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -or
                    $item.Length -lt 1 -or $item.Length -gt 16) { throw 'pid invalid' }
                $raw = [IO.File]::ReadAllText($item.FullName, [Text.Encoding]::ASCII).Trim()
                $parsed = 0
                if (-not [int]::TryParse($raw, [ref]$parsed) -or $parsed -le 0) { throw 'pid invalid' }
                $pidRecord = $parsed
            }
            catch { $pidInvalid = $true }
        }
        # Filter only after a successful enumeration: the native cmdlets throw
        # not-found for an empty filtered query, which is normal while stopped.
        # Enumeration errors remain fatal rather than becoming false port closure.
        $tcpOwners = @(Get-NetTCPConnection -ErrorAction Stop | Where-Object {
            [int]$_.LocalPort -eq $script:CutoverHostGamePort -and [string]$_.State -ceq 'Listen'
        } | ForEach-Object { [int]$_.OwningProcess })
        $udpOwners = @(Get-NetUDPEndpoint -ErrorAction Stop | Where-Object {
            [int]$_.LocalPort -eq $script:CutoverHostGamePort
        } | ForEach-Object { [int]$_.OwningProcess })
        return [pscustomobject][ordered]@{
            processes = @($processes); unverifiedProcess = [bool]$unverified
            pidRecord = $pidRecord; pidInvalid = [bool]$pidInvalid
            tcpOwners = @($tcpOwners); udpOwners = @($udpOwners)
        }
    }
    catch { Throw-CutoverHostError 'DYSON_CONTROL_CUTOVER_HOST_RUNTIME_PROBE_FAILED' }
}

function Test-CutoverHostProcessExecutable {
    param([Parameter(Mandatory)][string]$Actual, [Parameter(Mandatory)][string]$Expected)
    if (Test-CutoverHostSamePath $Actual $Expected) { return $true }
    $actualStream = $null
    $expectedStream = $null
    try {
        if (-not [IO.Path]::IsPathRooted($Actual) -or -not [IO.Path]::IsPathRooted($Expected)) { return $false }
        $share = [IO.FileShare]::ReadWrite -bor [IO.FileShare]::Delete
        $actualStream = [IO.File]::Open($Actual, [IO.FileMode]::Open, [IO.FileAccess]::Read, $share)
        $expectedStream = [IO.File]::Open($Expected, [IO.FileMode]::Open, [IO.FileAccess]::Read, $share)
        $actualFinal = Get-DysonHostMutationLeaseFinalPathFromHandle -Handle $actualStream.SafeFileHandle
        $expectedFinal = Get-DysonHostMutationLeaseFinalPathFromHandle -Handle $expectedStream.SafeFileHandle
        return -not [string]::IsNullOrWhiteSpace($actualFinal) -and
            -not [string]::IsNullOrWhiteSpace($expectedFinal) -and
            [string]::Equals($actualFinal, $expectedFinal, [StringComparison]::OrdinalIgnoreCase)
    }
    catch { return $false }
    finally {
        if ($null -ne $expectedStream) { $expectedStream.Dispose() }
        if ($null -ne $actualStream) { $actualStream.Dispose() }
    }
}

function Get-CutoverHostRuntimeObservation {
    $native = if ($script:CutoverHostBackend -ceq 'Shadow') {
        $runtime = Get-CutoverHostShadowRuntime
        $processes = @()
        $invalid = $false
        foreach ($process in @($runtime.dspProcesses)) {
            try {
                Assert-CutoverHostExactProperties $process @('id', 'path')
                if (($process.id -isnot [int] -and $process.id -isnot [long]) -or [int64]$process.id -le 0 -or
                    $process.path -isnot [string]) { throw 'invalid process' }
                $processes += [pscustomobject][ordered]@{ id = [int]$process.id; path = [string]$process.path }
            }
            catch { $invalid = $true }
        }
        $pidRecord = $null
        $pidInvalid = $false
        if ($null -ne $runtime.pidRecord) {
            if (($runtime.pidRecord -isnot [int] -and $runtime.pidRecord -isnot [long]) -or [int64]$runtime.pidRecord -le 0) { $pidInvalid = $true }
            else { $pidRecord = [int]$runtime.pidRecord }
        }
        [pscustomobject][ordered]@{
            processes = @($processes); unverifiedProcess = [bool]$invalid
            pidRecord = $pidRecord; pidInvalid = [bool]$pidInvalid
            tcpOwners = @($runtime.tcpOwners); udpOwners = @($runtime.udpOwners)
        }
    }
    else { Get-CutoverHostNativeRuntime }

    $tcpOwners = @()
    $udpOwners = @()
    $ownersInvalid = $false
    foreach ($owner in @($native.tcpOwners)) {
        if (($owner -isnot [int] -and $owner -isnot [long]) -or [int64]$owner -lt 0) { $ownersInvalid = $true }
        else { $tcpOwners += [int]$owner }
    }
    foreach ($owner in @($native.udpOwners)) {
        if (($owner -isnot [int] -and $owner -isnot [long]) -or [int64]$owner -lt 0) { $ownersInvalid = $true }
        else { $udpOwners += [int]$owner }
    }
    $processes = @($native.processes)
    $noProcess = $processes.Count -eq 0 -and -not [bool]$native.unverifiedProcess -and -not [bool]$native.pidInvalid
    $portsClosed = $tcpOwners.Count -eq 0 -and $udpOwners.Count -eq 0
    if ($noProcess -and $portsClosed) {
        return [pscustomobject][ordered]@{ kind = 'none'; pid = $null; coherentPort = $false; portsClosed = $true }
    }
    if ($processes.Count -ne 1 -or [bool]$native.unverifiedProcess -or [bool]$native.pidInvalid -or $ownersInvalid -or
        $null -eq $native.pidRecord -or [int]$native.pidRecord -ne [int]$processes[0].id -or
        -not (Test-CutoverHostProcessExecutable ([string]$processes[0].path) $script:CutoverHostExpectedExecutable)) {
        return [pscustomobject][ordered]@{ kind = 'unknown'; pid = $null; coherentPort = $false; portsClosed = [bool]$portsClosed }
    }
    $processId = [int]$processes[0].id
    $tcpCoherent = $tcpOwners.Count -gt 0 -and @($tcpOwners | Where-Object { $_ -ne $processId }).Count -eq 0
    $udpCoherent = @($udpOwners | Where-Object { $_ -ne $processId }).Count -eq 0
    if (-not $tcpCoherent -or -not $udpCoherent) {
        return [pscustomobject][ordered]@{ kind = 'unknown'; pid = $processId; coherentPort = $false; portsClosed = [bool]$portsClosed }
    }
    return [pscustomobject][ordered]@{ kind = 'managed'; pid = $processId; coherentPort = $true; portsClosed = $false }
}

function Read-CutoverHostRuntimeOwner {
    if (-not (Test-Path -LiteralPath $script:CutoverHostRuntimeOwnerFile -PathType Leaf)) { return $null }
    try {
        Assert-CutoverHostOwnerAcl
        $owner = Read-CutoverHostJsonFile $script:CutoverHostRuntimeOwnerFile 16384
        Assert-CutoverHostExactProperties $owner @('protocol', 'schemaVersion', 'authorityInventoryRevision', 'owner', 'pid', 'processIdentity')
        if ($owner.protocol -isnot [string] -or [string]$owner.protocol -cne $script:CutoverHostOwnerProtocol -or
            ($owner.schemaVersion -isnot [int] -and $owner.schemaVersion -isnot [long]) -or [int64]$owner.schemaVersion -ne 1 -or
            $owner.authorityInventoryRevision -isnot [string] -or [string]$owner.authorityInventoryRevision -cne $script:CutoverHostExpectedInventoryRevision -or
            $owner.owner -isnot [string] -or [string]$owner.owner -notin @('previous', 'candidate') -or
            ($owner.pid -isnot [int] -and $owner.pid -isnot [long]) -or [int64]$owner.pid -le 0 -or
            $owner.processIdentity -isnot [string] -or [string]$owner.processIdentity -cne (Get-CutoverHostPathIdentity $script:CutoverHostExpectedExecutable)) {
            return [pscustomobject][ordered]@{ valid = $false; owner = $null; pid = $null }
        }
        return [pscustomobject][ordered]@{ valid = $true; owner = [string]$owner.owner; pid = [int]$owner.pid }
    }
    catch { return [pscustomobject][ordered]@{ valid = $false; owner = $null; pid = $null } }
}

function Write-CutoverHostRuntimeOwner {
    param([ValidateSet('previous', 'candidate')][string]$Owner, [Parameter(Mandatory)][int]$ProcessId)
    Assert-CutoverHostMutationLease
    Assert-CutoverHostOwnerAcl
    $root = Assert-CutoverHostPlainDirectory $script:CutoverHostRuntimeOwnerRoot
    $value = [pscustomobject][ordered]@{
        protocol = $script:CutoverHostOwnerProtocol; schemaVersion = 1
        authorityInventoryRevision = $script:CutoverHostExpectedInventoryRevision
        owner = $Owner; pid = $ProcessId
        processIdentity = Get-CutoverHostPathIdentity $script:CutoverHostExpectedExecutable
    }
    $temporary = Join-Path $root ('.runtime-owner-' + [guid]::NewGuid().ToString('N') + '.tmp')
    $backup = Join-Path $root ('.runtime-owner-' + [guid]::NewGuid().ToString('N') + '.bak')
    try {
        [IO.File]::WriteAllText($temporary, (ConvertTo-CutoverHostJson $value) + "`n", [Text.UTF8Encoding]::new($false))
        Set-CutoverHostOwnerFileAcl $temporary
        if (Test-Path -LiteralPath $script:CutoverHostRuntimeOwnerFile -PathType Leaf) {
            [IO.File]::Replace($temporary, $script:CutoverHostRuntimeOwnerFile, $backup, $true)
            if (Test-Path -LiteralPath $backup -PathType Leaf) { Remove-Item -LiteralPath $backup -Force }
        }
        else { [IO.File]::Move($temporary, $script:CutoverHostRuntimeOwnerFile) }
    }
    catch {
        if ($_.Exception.Data.Contains('Code')) { throw $_.Exception }
        Throw-CutoverHostError 'DYSON_CONTROL_CUTOVER_HOST_OWNER_WRITE_FAILED'
    }
    finally {
        foreach ($candidate in @($temporary, $backup)) {
            if (Test-Path -LiteralPath $candidate -PathType Leaf) { Remove-Item -LiteralPath $candidate -Force -ErrorAction SilentlyContinue }
        }
    }
    Assert-CutoverHostOwnerAcl
    Assert-CutoverHostMutationLease
}

function Remove-CutoverHostRuntimeOwner {
    Assert-CutoverHostMutationLease
    Assert-CutoverHostOwnerAcl
    if (Test-Path -LiteralPath $script:CutoverHostRuntimeOwnerFile -PathType Leaf) {
        try { Remove-Item -LiteralPath $script:CutoverHostRuntimeOwnerFile -Force -ErrorAction Stop }
        catch { Throw-CutoverHostError 'DYSON_CONTROL_CUTOVER_HOST_OWNER_WRITE_FAILED' }
    }
    Assert-CutoverHostOwnerAcl
    Assert-CutoverHostMutationLease
}

function Get-CutoverHostEvidence {
    $profile = Assert-CutoverHostProfileRevision
    $authority = Get-CutoverHostAuthorityObservation $profile
    $runtime = Get-CutoverHostRuntimeObservation
    $processState = 'unknown'
    $portState = 'unknown'
    $unexpected = [bool]$authority.unexpectedAuthority
    if ([string]$runtime.kind -ceq 'none') {
        $processState = 'none'; $portState = 'closed'
    }
    elseif ([string]$runtime.kind -ceq 'managed' -and [bool]$runtime.coherentPort) {
        $owner = $null
        $marker = Read-CutoverHostRuntimeOwner
        if ([bool]$authority.previousLive -and [bool]$authority.candidateActive) {
            $processState = 'both'; $portState = 'unknown'; $unexpected = $true
        }
        else {
            if ([bool]$authority.previousLive) { $owner = 'previous' }
            elseif ([bool]$authority.candidateActive) { $owner = 'candidate' }
            elseif ($null -ne $marker -and [bool]$marker.valid -and [int]$marker.pid -eq [int]$runtime.pid) { $owner = [string]$marker.owner }
            if ($null -ne $marker -and (-not [bool]$marker.valid -or [int]$marker.pid -ne [int]$runtime.pid -or
                ($null -ne $owner -and [string]$marker.owner -cne $owner))) {
                $owner = $null; $unexpected = $true
            }
            if ($owner -ceq 'previous') { $processState = 'previous-only'; $portState = 'previous' }
            elseif ($owner -ceq 'candidate') { $processState = 'candidate-only'; $portState = 'candidate' }
        }
    }
    return [pscustomobject][ordered]@{
        previousDefined = [bool]$authority.previousDefined
        previousEnabled = [bool]$authority.previousLive
        candidateDefined = [bool]$authority.candidateDefined
        candidateEnabled = [bool]$authority.candidateActive
        unexpectedAuthorityPresent = [bool]$unexpected
        processState = $processState
        portState = $portState
        previousHealthy = ($processState -ceq 'previous-only' -and $portState -ceq 'previous')
        candidateHealthy = ($processState -ceq 'candidate-only' -and $portState -ceq 'candidate')
    }
}

function Assert-CutoverHostMutationLease {
    if (-not [bool]$script:CutoverHostMutationMode -or
        [string]::IsNullOrWhiteSpace($script:CutoverHostLeaseInstanceId) -or
        [string]::IsNullOrWhiteSpace($script:CutoverHostLeaseToken)) {
        Throw-CutoverHostError 'DYSON_CONTROL_CUTOVER_HOST_LEASE_REQUIRED'
    }
    try {
        [void](Assert-DysonHostMutationLeaseBorrow -DataRoot $script:CutoverHostDataRoot `
            -InstanceId $script:CutoverHostLeaseInstanceId -Token $script:CutoverHostLeaseToken)
    }
    catch {
        if ($_.Exception.Data.Contains('Code')) { throw $_.Exception }
        Throw-CutoverHostError 'DYSON_CONTROL_CUTOVER_HOST_LEASE_LOST'
    }
}

function Assert-CutoverHostMutationBoundary {
    Assert-CutoverHostMutationLease
    Assert-CutoverHostOwnerAcl
    [void](Assert-CutoverHostProfileRevision)
    Assert-CutoverHostOwnerAcl
    Assert-CutoverHostMutationLease
}

function Set-CutoverHostShadowTaskState {
    param(
        [Parameter(Mandatory)][string]$TaskName,
        [AllowNull()]$Enabled,
        [AllowNull()]$Running,
        [Parameter(Mandatory)][string]$WriteKind
    )
    $state = Get-CutoverHostShadowState
    $matches = @($state.tasks | Where-Object { [string]$_.taskName -ceq $TaskName -and [string]$_.taskPath -ceq '\' })
    if ($matches.Count -ne 1) { Throw-CutoverHostError 'DYSON_CONTROL_CUTOVER_HOST_TASK_AMBIGUOUS' }
    if ($null -ne $Enabled) {
        $matches[0].enabled = [bool]$Enabled
        if ($null -ne $matches[0].descriptor) { $matches[0].descriptor.enabled = [bool]$Enabled }
    }
    if ($null -ne $Running) { $matches[0].running = [bool]$Running }
    Write-CutoverHostShadowState $state $WriteKind
}

function Set-CutoverHostTaskEnabled {
    param([Parameter(Mandatory)][string]$TaskName, [Parameter(Mandatory)][bool]$Enabled)
    Assert-CutoverHostMutationLease
    if ($script:CutoverHostBackend -ceq 'Shadow') {
        Set-CutoverHostShadowTaskState -TaskName $TaskName -Enabled $Enabled -Running $null -WriteKind ('enabled:' + $TaskName)
    }
    else {
        try {
            if ($Enabled) { Enable-ScheduledTask -TaskName $TaskName -TaskPath '\' -ErrorAction Stop | Out-Null }
            else { Disable-ScheduledTask -TaskName $TaskName -TaskPath '\' -ErrorAction Stop | Out-Null }
        }
        catch { Throw-CutoverHostError 'DYSON_CONTROL_CUTOVER_HOST_TASK_WRITE_FAILED' }
    }
    Assert-CutoverHostMutationLease
}

function Set-CutoverHostPanelRunning {
    param([Parameter(Mandatory)][bool]$Running)
    Assert-CutoverHostMutationLease
    if ($script:CutoverHostBackend -ceq 'Shadow') {
        Set-CutoverHostShadowTaskState -TaskName $script:CutoverHostPreviousPanelTask `
            -Enabled $null -Running $Running -WriteKind ('running:' + $script:CutoverHostPreviousPanelTask)
    }
    else {
        try {
            if ($Running) { Start-ScheduledTask -TaskName $script:CutoverHostPreviousPanelTask -TaskPath '\' -ErrorAction Stop }
            else { Stop-ScheduledTask -TaskName $script:CutoverHostPreviousPanelTask -TaskPath '\' -ErrorAction Stop }
        }
        catch { Throw-CutoverHostError 'DYSON_CONTROL_CUTOVER_HOST_TASK_WRITE_FAILED' }
    }
    Assert-CutoverHostMutationLease
    $deadline = [DateTime]::UtcNow.AddSeconds(30)
    do {
        Assert-CutoverHostMutationLease
        $image = Get-CutoverHostTaskImage $script:CutoverHostPreviousPanelTask
        if ([bool]$image.running -eq $Running) { return }
        Start-Sleep -Milliseconds 250
    } while ([DateTime]::UtcNow -lt $deadline)
    Throw-CutoverHostError 'DYSON_CONTROL_CUTOVER_HOST_TASK_TIMEOUT'
}

function Set-CutoverHostShadowRuntimeForStart {
    param([ValidateSet('previous', 'candidate')][string]$Owner)
    $processId = 4242
    $runtime = [pscustomobject][ordered]@{
        protocol = 'DYSON_CONTROL_CUTOVER_HOST_SHADOW_RUNTIME_V1'
        dspProcesses = @([pscustomobject][ordered]@{ id = $processId; path = $script:CutoverHostExpectedExecutable })
        pidRecord = $processId; tcpOwners = @($processId); udpOwners = @($processId)
    }
    if ($env:DYSON_CUTOVER_HOST_SELFTEST_FAIL_POINT -ceq 'AmbiguousPortsAfterStart') { $runtime.udpOwners = @(9999) }
    Write-CutoverHostShadowRuntime $runtime ('runtime-start:' + $Owner)
}

function Set-CutoverHostShadowRuntimeForStop {
    param([ValidateSet('previous', 'candidate')][string]$Owner)
    $runtime = [pscustomobject][ordered]@{
        protocol = 'DYSON_CONTROL_CUTOVER_HOST_SHADOW_RUNTIME_V1'
        dspProcesses = @(); pidRecord = $null; tcpOwners = @(); udpOwners = @()
    }
    Write-CutoverHostShadowRuntime $runtime ('runtime-stop:' + $Owner)
}

function Invoke-CutoverHostFixedRuntimeTask {
    param(
        [ValidateSet('previous', 'candidate')][string]$Owner,
        [ValidateSet('start', 'stop')][string]$Operation
    )
    $taskName = if ($Owner -ceq 'previous') {
        if ($Operation -ceq 'start') { $script:CutoverHostPreviousStartTask } else { $script:CutoverHostPreviousStopTask }
    }
    else {
        if ($Operation -ceq 'start') { $script:CutoverHostCandidateStartTask } else { $script:CutoverHostCandidateStopTask }
    }
    Assert-CutoverHostMutationLease
    if ($script:CutoverHostBackend -ceq 'Shadow') {
        Set-CutoverHostShadowTaskState -TaskName $taskName -Enabled $null -Running $true -WriteKind ('dispatch:' + $taskName)
        if ($Operation -ceq 'start') {
            Set-CutoverHostShadowRuntimeForStart $Owner
        }
        else {
            Set-CutoverHostShadowRuntimeForStop $Owner
            $startTask = if ($Owner -ceq 'previous') { $script:CutoverHostPreviousStartTask } else { $script:CutoverHostCandidateStartTask }
            Set-CutoverHostShadowTaskState -TaskName $startTask -Enabled $null -Running $false -WriteKind ('complete:' + $startTask)
            Set-CutoverHostShadowTaskState -TaskName $taskName -Enabled $null -Running $false -WriteKind ('complete:' + $taskName)
        }
    }
    else {
        try {
            $image = Get-CutoverHostTaskImage $taskName
            if (-not [bool]$image.running) { Start-ScheduledTask -TaskName $taskName -TaskPath '\' -ErrorAction Stop }
        }
        catch { Throw-CutoverHostError 'DYSON_CONTROL_CUTOVER_HOST_TASK_WRITE_FAILED' }
    }
    Assert-CutoverHostMutationLease
}

function Wait-CutoverHostRuntime {
    param([ValidateSet('running', 'stopped')][string]$Expected)
    $deadline = [DateTime]::UtcNow.AddSeconds($script:CutoverHostRuntimeTimeoutSeconds)
    do {
        Assert-CutoverHostMutationLease
        [void](Assert-CutoverHostProfileRevision)
        $runtime = Get-CutoverHostRuntimeObservation
        if ($Expected -ceq 'running' -and [string]$runtime.kind -ceq 'managed' -and [bool]$runtime.coherentPort) { return $runtime }
        if ($Expected -ceq 'stopped' -and [string]$runtime.kind -ceq 'none' -and [bool]$runtime.portsClosed) { return $runtime }
        if ([string]$runtime.kind -ceq 'unknown') { Throw-CutoverHostError 'DYSON_CONTROL_CUTOVER_HOST_RUNTIME_AMBIGUOUS' }
        Start-Sleep -Milliseconds 500
    } while ([DateTime]::UtcNow -lt $deadline)
    Throw-CutoverHostError 'DYSON_CONTROL_CUTOVER_HOST_RUNTIME_TIMEOUT'
}

function Wait-CutoverHostStopTaskTerminal {
    param([Parameter(Mandatory)][string]$TaskName)
    $deadline = [DateTime]::UtcNow.AddSeconds(30)
    do {
        Assert-CutoverHostMutationLease
        [void](Assert-CutoverHostProfileRevision)
        $image = Get-CutoverHostTaskImage $TaskName
        if (-not [bool]$image.running) {
            if ($script:CutoverHostBackend -ceq 'Shadow') { return }
            try {
                $info = Get-ScheduledTaskInfo -TaskName $TaskName -TaskPath '\' -ErrorAction Stop
            }
            catch { Throw-CutoverHostError 'DYSON_CONTROL_CUTOVER_HOST_SCHEDULER_UNAVAILABLE' }
            if ([int64]$info.LastTaskResult -ne 0) {
                Throw-CutoverHostError 'DYSON_CONTROL_CUTOVER_HOST_TASK_FAILED'
            }
            return
        }
        Start-Sleep -Milliseconds 250
    } while ([DateTime]::UtcNow -lt $deadline)
    Throw-CutoverHostError 'DYSON_CONTROL_CUTOVER_HOST_TASK_TIMEOUT'
}

function Write-CutoverPreviousStopRecord {
    param([string]$Path, $Value)
    $text = ConvertTo-CutoverHostJson $Value
    if (Test-Path -LiteralPath $Path) {
        if ((ConvertTo-CutoverHostJson (Read-CutoverHostJsonFile $Path)) -cne $text) {
            Throw-CutoverHostError 'DYSON_CONTROL_CUTOVER_HOST_STOP_RECORD_CONFLICT'
        }
        return
    }
    $temporary = $Path + '.partial-' + [guid]::NewGuid().ToString('N')
    try {
        $bytes = [Text.UTF8Encoding]::new($false).GetBytes($text + "`n")
        $stream = [IO.FileStream]::new($temporary, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
        try { $stream.Write($bytes, 0, $bytes.Length); $stream.Flush($true) } finally { $stream.Dispose() }
        [IO.File]::Move($temporary, $Path)
    }
    finally { if ([IO.File]::Exists($temporary)) { [IO.File]::Delete($temporary) } }
}

function Initialize-CutoverPreviousStopDirectory {
    param([string]$Path, [string]$GameSid, [switch]$Receipts)
    $existed = Test-Path -LiteralPath $Path
    $full = Assert-CutoverHostPlainDirectory -Path $Path -Create
    if ($script:CutoverHostBackend -ceq 'Shadow') { return $full }
    $security = [Security.AccessControl.DirectorySecurity]::new()
    $security.SetAccessRuleProtection($true, $false)
    $security.SetOwner([Security.Principal.SecurityIdentifier]::new('S-1-5-32-544'))
    foreach ($sid in @('S-1-5-18', 'S-1-5-32-544', $GameSid)) {
        $rights = if ($sid -ceq $GameSid) {
            if ($Receipts) { [Security.AccessControl.FileSystemRights]::Modify } else { [Security.AccessControl.FileSystemRights]::ReadAndExecute }
        } else { [Security.AccessControl.FileSystemRights]::FullControl }
        $security.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new(
            [Security.Principal.SecurityIdentifier]::new($sid), $rights,
            [Security.AccessControl.InheritanceFlags]'ContainerInherit, ObjectInherit',
            [Security.AccessControl.PropagationFlags]::None, [Security.AccessControl.AccessControlType]::Allow))
    }
    if (-not $existed) { Microsoft.PowerShell.Security\Set-Acl -LiteralPath $full -AclObject $security }
    $actual = Microsoft.PowerShell.Security\Get-Acl -LiteralPath $full
    $ruleKey = { '{0}:{1}:{2}:{3}:{4}:{5}' -f $_.IdentityReference.Value, [int]$_.AccessControlType,
        [int64]$_.FileSystemRights, [int]$_.InheritanceFlags, [int]$_.PropagationFlags, [bool]$_.IsInherited }
    $actualRules = @($actual.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier]) | ForEach-Object $ruleKey | Sort-Object)
    $expectedRules = @($security.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier]) | ForEach-Object $ruleKey | Sort-Object)
    if (-not $actual.AreAccessRulesProtected -or $actual.GetOwner([Security.Principal.SecurityIdentifier]).Value -cne 'S-1-5-32-544' -or
        ($actualRules -join '|') -cne ($expectedRules -join '|')) {
        Throw-CutoverHostError 'DYSON_CONTROL_CUTOVER_HOST_STOP_STORAGE_INVALID'
    }
    return $full
}

function Invoke-CutoverPreviousStopTaskCom {
    param($Intent, [scriptblock]$Operation)
    $service = $null; $folder = $null; $task = $null
    try {
        $service = New-Object -ComObject 'Schedule.Service'
        $service.Connect(); $folder = $service.GetFolder('\'); $task = $folder.GetTask([string]$Intent.taskName)
        & $Operation $task
    }
    finally {
        foreach ($value in @($task, $folder, $service)) {
            if ($null -ne $value -and [Runtime.InteropServices.Marshal]::IsComObject($value)) {
                [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($value)
            }
        }
    }
}

function Get-CutoverPreviousStopTask {
    param($Intent, [string]$Root, [switch]$RepairUnstartedAcl)
    if ($script:CutoverHostBackend -ceq 'Shadow') {
        $path = Join-Path $Root 'task-shadow.json'
        if (-not (Test-Path -LiteralPath $path)) { return $null }
        $task = Read-CutoverHostJsonFile $path
        Assert-CutoverHostExactProperties $task @('taskName','arguments','state','lastRunUtc','lastResult')
        if ([string]$task.arguments -cne [string]$Intent.arguments -or [string]$task.taskName -cne [string]$Intent.taskName) {
            Throw-CutoverHostError 'DYSON_CONTROL_CUTOVER_HOST_STOP_TASK_CONFLICT'
        }
        return $task
    }
    $matches = @(Get-ScheduledTask -ErrorAction Stop | Where-Object { $_.TaskName -ceq $Intent.taskName -and $_.TaskPath -ceq '\' })
    if ($matches.Count -eq 0) { return $null }
    if ($matches.Count -ne 1) { Throw-CutoverHostError 'DYSON_CONTROL_CUTOVER_HOST_STOP_TASK_CONFLICT' }
    $task = $matches[0]
    $actions = @($task.Actions | Where-Object { $null -ne $_ })
    $triggers = @($task.Triggers | Where-Object { $null -ne $_ })
    if ($actions.Count -ne 1 -or $triggers.Count -ne 0 -or $task.TaskPath -cne '\' -or
        $task.TaskName -cne $Intent.taskName -or -not (Test-CutoverHostSamePath $actions[0].Execute $Intent.execute) -or
        $actions[0].Arguments -cne $Intent.arguments -or -not [string]::IsNullOrWhiteSpace($actions[0].WorkingDirectory) -or
        -not (Test-CutoverHostTaskUserEqual $task.Principal.UserId $script:CutoverHostServiceUser) -or
        [string]$task.Principal.LogonType -cne 'Interactive' -or [string]$task.Principal.RunLevel -cne 'Limited' -or
        -not [bool]$task.Settings.Enabled -or [string]$task.Settings.MultipleInstances -cne 'IgnoreNew' -or
        [int]$task.Settings.RestartCount -ne 0 -or [string]$task.Settings.ExecutionTimeLimit -cne 'PT3M') {
        Throw-CutoverHostError 'DYSON_CONTROL_CUTOVER_HOST_STOP_TASK_CONFLICT'
    }
    if ($task.Description -cne ('Dyson Control bound previous stop ' + $Intent.requestId)) {
        Throw-CutoverHostError 'DYSON_CONTROL_CUTOVER_HOST_STOP_TASK_CONFLICT'
    }
    $info = Get-ScheduledTaskInfo -TaskName ([string]$Intent.taskName) -TaskPath '\' -ErrorAction Stop
    if ($RepairUnstartedAcl -and $info.LastRunTime.Year -lt 2000 -and [string]$task.State -ceq 'Ready') {
        Assert-CutoverHostMutationLease
        [void](Invoke-CutoverPreviousStopTaskCom $Intent { param($registered)
            $registered.SetSecurityDescriptor(('D:P(A;;GA;;;SY)(A;;GA;;;BA)(A;;GRGX;;;' + $Intent.gameSid + ')'), 0x10)
        })
    }
    [void](Invoke-CutoverPreviousStopTaskCom $Intent {
        param($registered)
        $acl = [Security.AccessControl.CommonSecurityDescriptor]::new($false, $false, [string]$registered.GetSecurityDescriptor(4))
        $expected = @{ 'S-1-5-18' = @(268435456, 0x1f01ff); 'S-1-5-32-544' = @(268435456, 0x1f01ff) }
        $expected[[string]$Intent.gameSid] = @(-1610612736, 0x1200a9)
        if (-not ($acl.ControlFlags -band [Security.AccessControl.ControlFlags]::DiscretionaryAclProtected) -or $acl.DiscretionaryAcl.Count -ne 3) { throw 'task DACL' }
        foreach ($ace in $acl.DiscretionaryAcl) {
            if ($ace.AceType -ne [Security.AccessControl.AceType]::AccessAllowed -or
                -not $expected.ContainsKey($ace.SecurityIdentifier.Value) -or $ace.AccessMask -notin $expected[$ace.SecurityIdentifier.Value]) { throw 'task DACL' }
            $expected.Remove($ace.SecurityIdentifier.Value)
        }
        if ($expected.Count -ne 0) { throw 'task DACL' }
    })
    return [pscustomobject]@{ state = [string]$task.State; lastRunUtc = $info.LastRunTime.ToUniversalTime().ToString('o'); lastResult = [int64]$info.LastTaskResult }
}

function Test-CutoverPreviousStopFault {
    param([string]$Point)
    if ($script:CutoverHostBackend -ceq 'Shadow' -and
        $env:DYSON_CUTOVER_HOST_SELFTEST_FAIL_POINT -ceq ('PreviousStop-' + $Point)) {
        Throw-CutoverHostError 'DYSON_CONTROL_CUTOVER_HOST_STOP_TEST_INTERRUPTED'
    }
}

function Close-CutoverPreviousStopFailure {
    param($Intent, [string]$Root, [string]$Fingerprint, [string]$Code)
    Assert-CutoverHostMutationLease
    $task = Get-CutoverPreviousStopTask $Intent $Root
    if ($null -eq $task) {
        $failurePath = Join-Path $Root 'failure.json'
        if (-not (Test-Path -LiteralPath $failurePath)) { return }
        $failure = Read-CutoverHostJsonFile $failurePath
        if ($failure.intentSha256 -cne $Fingerprint -or $failure.errorCode -cne $Code) { Throw-CutoverHostError 'DYSON_CONTROL_CUTOVER_HOST_STOP_RECORD_CONFLICT' }
        Write-CutoverPreviousStopRecord (Join-Path $Root 'completed.json') ([ordered]@{
            intentSha256 = $Fingerprint; status = 'failed'; taskRemoved = $true; errorCode = $Code
        })
        return
    }
    if ($task.state -cne 'Ready' -or
        [DateTimeOffset]::Parse($task.lastRunUtc) -lt [DateTimeOffset]::Parse($Intent.createdAtUtc)) { return }
    Write-CutoverPreviousStopRecord (Join-Path $Root 'failure.json') ([ordered]@{
        intentSha256 = $Fingerprint; errorCode = $Code; lastResult = $task.lastResult; lastRunUtc = $task.lastRunUtc
    })
    if ($script:CutoverHostBackend -ceq 'Shadow') { [IO.File]::Delete((Join-Path $Root 'task-shadow.json')) }
    else { Unregister-ScheduledTask -TaskName $Intent.taskName -TaskPath '\' -Confirm:$false -ErrorAction Stop }
    if ($null -ne (Get-CutoverPreviousStopTask $Intent $Root)) { Throw-CutoverHostError 'DYSON_CONTROL_CUTOVER_HOST_STOP_CLEANUP_FAILED' }
    Test-CutoverPreviousStopFault 'AfterFailedCleanup'
    Write-CutoverPreviousStopRecord (Join-Path $Root 'completed.json') ([ordered]@{
        intentSha256 = $Fingerprint; status = 'failed'; taskRemoved = $true; errorCode = $Code
    })
}

function Invoke-CutoverPreviousStopTransaction {
    Assert-CutoverHostMutationLease
    $stopHash = $script:CutoverHostPreviousStopScriptSha256
    if ($stopHash -cnotmatch '^[0-9a-f]{64}$') { Throw-CutoverHostError 'DYSON_CONTROL_CUTOVER_HOST_STOP_BINDING_REQUIRED' }
    $stopScript = Assert-CutoverHostPlainFile (Join-Path $script:CutoverHostWindowsRoot 'Stop-DysonServer.ps1')
    if ((Get-CutoverHostSha256File $stopScript) -cne $stopHash) { Throw-CutoverHostError 'DYSON_CONTROL_CUTOVER_HOST_STOP_SCRIPT_DRIFT' }
    $gameSid = if ($script:CutoverHostBackend -ceq 'Shadow') { 'S-1-5-21-42424242-42424242-42424242-1001' }
        else { ([Security.Principal.NTAccount]::new($script:CutoverHostServiceUser)).Translate([Security.Principal.SecurityIdentifier]).Value }
    $storageRoot = Initialize-CutoverPreviousStopDirectory -Path (Join-Path $script:CutoverHostRuntimeOwnerRoot 'previous-stop') -GameSid $gameSid
    foreach ($other in @(Get-ChildItem -LiteralPath $storageRoot -Directory -Force)) {
        if ($other.Name -cne $script:CutoverHostRequestId -and
            (Test-Path -LiteralPath (Join-Path $other.FullName 'intent.json')) -and
            -not (Test-Path -LiteralPath (Join-Path $other.FullName 'completed.json'))) {
            Throw-CutoverHostError 'DYSON_CONTROL_CUTOVER_HOST_STOP_RECOVERY_REQUIRED'
        }
    }
    $root = Initialize-CutoverPreviousStopDirectory -Path (Join-Path $storageRoot $script:CutoverHostRequestId) -GameSid $gameSid
    $receipts = Initialize-CutoverPreviousStopDirectory -Path (Join-Path $root 'receipts') -GameSid $gameSid -Receipts
    $intentPath = Join-Path $root 'intent.json'
    $receiptPath = Join-Path $receipts 'stop.json'
    $terminalPath = Join-Path $root 'terminal.json'
    $dispatchPath = Join-Path $root 'dispatch.json'
    $completedPath = Join-Path $root 'completed.json'
    $intent = $null
    if (Test-Path -LiteralPath $intentPath) {
        $intent = Read-CutoverHostJsonFile $intentPath
        Assert-CutoverHostExactProperties $intent @('protocol','requestId','authorityRevision','stopSha256','gameSid',
            'processId','processStartedAtUnixMs','taskName','execute','arguments','createdAtUtc')
        if ($intent.protocol -cne 'DYSON_CONTROL_PREVIOUS_STOP_INTENT_V1' -or
            $intent.requestId -cne $script:CutoverHostRequestId -or $intent.authorityRevision -cne $script:CutoverHostExpectedInventoryRevision -or
            $intent.stopSha256 -cne $stopHash -or $intent.gameSid -cne $gameSid -or
            $intent.taskName -cne ('Dyson-Cutover-Previous-Stop-' + $script:CutoverHostRequestId)) {
            Throw-CutoverHostError 'DYSON_CONTROL_CUTOVER_HOST_STOP_RECORD_CONFLICT'
        }
    }
    else {
        $runtime = Get-CutoverHostRuntimeObservation
        if ($runtime.kind -cne 'managed' -or -not $runtime.coherentPort) { Throw-CutoverHostError 'DYSON_CONTROL_CUTOVER_HOST_RUNTIME_AMBIGUOUS' }
        $started = if ($script:CutoverHostBackend -ceq 'Shadow') { 1788081000000L } else {
            $process = Get-Process -Id ([int]$runtime.pid) -ErrorAction Stop
            try { [void]$process.Handle; [DateTimeOffset]::new($process.StartTime.ToUniversalTime()).ToUnixTimeMilliseconds() }
            finally { $process.Dispose() }
        }
        $execute = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
        $arguments = '-NoLogo -NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File "{0}" -ProjectRoot "{1}" -TimeoutSeconds 150 -StopRequestId {2} -ExpectedProcessId {3} -ExpectedProcessStartedAtUnixMs {4} -ExpectedScriptSha256 {5} -ReceiptPath "{6}"' -f
            $stopScript, $script:CutoverHostProjectRoot, $script:CutoverHostRequestId, $runtime.pid, $started, $stopHash, $receiptPath
        $intent = [pscustomobject][ordered]@{
            protocol = 'DYSON_CONTROL_PREVIOUS_STOP_INTENT_V1'; requestId = $script:CutoverHostRequestId
            authorityRevision = $script:CutoverHostExpectedInventoryRevision; stopSha256 = $stopHash; gameSid = $gameSid
            processId = [int]$runtime.pid; processStartedAtUnixMs = [long]$started
            taskName = 'Dyson-Cutover-Previous-Stop-' + $script:CutoverHostRequestId
            execute = $execute; arguments = $arguments; createdAtUtc = [DateTimeOffset]::UtcNow.ToString('yyyy-MM-ddTHH:mm:ssZ')
        }
        if ($null -ne (Get-CutoverPreviousStopTask $intent $root)) { Throw-CutoverHostError 'DYSON_CONTROL_CUTOVER_HOST_STOP_TASK_CONFLICT' }
        Write-CutoverPreviousStopRecord $intentPath $intent
        Test-CutoverPreviousStopFault 'AfterIntent'
    }
    if (($intent.processId -isnot [int] -and $intent.processId -isnot [long]) -or $intent.processId -le 0 -or
        ($intent.processStartedAtUnixMs -isnot [int] -and $intent.processStartedAtUnixMs -isnot [long]) -or
        $intent.processStartedAtUnixMs -le 0) { Throw-CutoverHostError 'DYSON_CONTROL_CUTOVER_HOST_STOP_RECORD_CONFLICT' }
    $expectedArguments = '-NoLogo -NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File "{0}" -ProjectRoot "{1}" -TimeoutSeconds 150 -StopRequestId {2} -ExpectedProcessId {3} -ExpectedProcessStartedAtUnixMs {4} -ExpectedScriptSha256 {5} -ReceiptPath "{6}"' -f
        $stopScript, $script:CutoverHostProjectRoot, $script:CutoverHostRequestId, $intent.processId, $intent.processStartedAtUnixMs, $stopHash, $receiptPath
    if ($intent.execute -cne (Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe') -or
        $intent.arguments -cne $expectedArguments) { Throw-CutoverHostError 'DYSON_CONTROL_CUTOVER_HOST_STOP_RECORD_CONFLICT' }
    $fingerprint = Get-CutoverHostSha256Text (ConvertTo-CutoverHostJson $intent)
    $dispatched = Test-Path -LiteralPath $dispatchPath
    if ($dispatched) {
        $dispatch = Read-CutoverHostJsonFile $dispatchPath
        if ($dispatch.intentSha256 -cne $fingerprint) { Throw-CutoverHostError 'DYSON_CONTROL_CUTOVER_HOST_STOP_RECORD_CONFLICT' }
    }
    if (Test-Path -LiteralPath (Join-Path $root 'failure.json')) {
        $failure = Read-CutoverHostJsonFile (Join-Path $root 'failure.json')
        if ($failure.intentSha256 -cne $fingerprint -or $failure.errorCode -cnotin
            @('DYSON_CONTROL_CUTOVER_HOST_TASK_FAILED','DYSON_CONTROL_CUTOVER_HOST_STOP_RECEIPT_INVALID')) {
            Throw-CutoverHostError 'DYSON_CONTROL_CUTOVER_HOST_STOP_RECORD_CONFLICT'
        }
        Close-CutoverPreviousStopFailure $intent $root $fingerprint $failure.errorCode
        Throw-CutoverHostError $failure.errorCode
    }
    if (Test-Path -LiteralPath $completedPath) {
        $completed = Read-CutoverHostJsonFile $completedPath
        if ($completed.intentSha256 -cne $fingerprint -or
            $completed.taskRemoved -isnot [bool] -or -not $completed.taskRemoved -or
            $null -ne (Get-CutoverPreviousStopTask $intent $root)) { throw 'completed stop drift' }
        if ($completed.status -cne 'succeeded') { Throw-CutoverHostError 'DYSON_CONTROL_CUTOVER_HOST_TASK_FAILED' }
        $savedTerminal = Read-CutoverHostJsonFile $terminalPath
        if ($savedTerminal.intentSha256 -cne $fingerprint -or $savedTerminal.lastResult -ne 0 -or
            $savedTerminal.receiptSha256 -cne (Get-CutoverHostSha256File (Assert-CutoverHostPlainFile $receiptPath))) {
            Throw-CutoverHostError 'DYSON_CONTROL_CUTOVER_HOST_STOP_RECORD_CONFLICT'
        }
        $currentRuntime = Get-CutoverHostRuntimeObservation
        if ($currentRuntime.kind -cne 'none' -or -not $currentRuntime.portsClosed) { Throw-CutoverHostError 'DYSON_CONTROL_CUTOVER_HOST_STOP_RECORD_CONFLICT' }
        return
    }
    if (-not (Test-Path -LiteralPath $terminalPath)) {
        $task = Get-CutoverPreviousStopTask $intent $root -RepairUnstartedAcl
        if ($null -eq $task) {
            if ($dispatched) { Throw-CutoverHostError 'DYSON_CONTROL_CUTOVER_HOST_STOP_DISPATCH_UNCERTAIN' }
            Assert-CutoverHostMutationLease
            if ($script:CutoverHostBackend -ceq 'Shadow') {
                Write-CutoverPreviousStopRecord (Join-Path $root 'task-shadow.json') ([ordered]@{
                    taskName = $intent.taskName; arguments = $intent.arguments; state = 'Ready'; lastRunUtc = '1970-01-01T00:00:00Z'; lastResult = 0
                })
            }
            else {
                $action = New-ScheduledTaskAction -Execute $intent.execute -Argument $intent.arguments
                $principal = New-ScheduledTaskPrincipal -UserId $script:CutoverHostServiceUser -LogonType Interactive -RunLevel Limited
                $settings = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -ExecutionTimeLimit ([TimeSpan]::FromMinutes(3))
                Register-ScheduledTask -TaskName $intent.taskName -TaskPath '\' -Action $action -Principal $principal -Settings $settings `
                    -Description ('Dyson Control bound previous stop ' + $intent.requestId) -ErrorAction Stop | Out-Null
                [void](Invoke-CutoverPreviousStopTaskCom $intent { param($registered)
                    $registered.SetSecurityDescriptor(('D:P(A;;GA;;;SY)(A;;GA;;;BA)(A;;GRGX;;;' + $intent.gameSid + ')'), 0x10)
                })
            }
            Test-CutoverPreviousStopFault 'AfterTaskRegistered'
            $task = Get-CutoverPreviousStopTask $intent $root
        }
        if ([DateTimeOffset]::Parse($task.lastRunUtc) -lt [DateTimeOffset]::Parse($intent.createdAtUtc)) {
            if ($dispatched -and $task.state -notin @('Running','Queued')) {
                Throw-CutoverHostError 'DYSON_CONTROL_CUTOVER_HOST_STOP_DISPATCH_UNCERTAIN'
            }
            if (-not $dispatched) {
            if (Test-Path -LiteralPath $receiptPath) { Throw-CutoverHostError 'DYSON_CONTROL_CUTOVER_HOST_STOP_RECORD_CONFLICT' }
            Assert-CutoverHostMutationLease
            Write-CutoverPreviousStopRecord $dispatchPath ([ordered]@{
                intentSha256 = $fingerprint; requestedAtUtc = [DateTimeOffset]::UtcNow.ToString('o')
            })
            Test-CutoverPreviousStopFault 'AfterDispatchIntent'
            if ($script:CutoverHostBackend -ceq 'Shadow') {
                if ($env:DYSON_CUTOVER_HOST_SELFTEST_FAIL_POINT -ceq 'PreviousStop-Timeout') {
                    [IO.File]::Delete((Join-Path $root 'task-shadow.json'))
                    Write-CutoverPreviousStopRecord (Join-Path $root 'task-shadow.json') ([ordered]@{
                        taskName = $intent.taskName; arguments = $intent.arguments; state = 'Running'; lastRunUtc = [DateTimeOffset]::UtcNow.ToString('o'); lastResult = 267009
                    })
                }
                else {
                Set-CutoverHostShadowRuntimeForStop previous
                Set-CutoverHostShadowTaskState -TaskName $script:CutoverHostPreviousStartTask -Enabled $null -Running $false -WriteKind 'complete:previous-compatible-stop'
                Write-CutoverPreviousStopRecord $receiptPath ([ordered]@{
                    protocol = 'DYSON_CONTROL_BOUND_STOP_RECEIPT_V1'; schemaVersion = 1; requestId = $intent.requestId
                    expectedProcessId = $intent.processId; expectedProcessStartedAtUnixMs = $intent.processStartedAtUnixMs
                    scriptSha256 = $stopHash; status = 'succeeded'; errorCode = 'NONE'; signalSent = $true; processExited = $true
                    processExitCode = -1073741510; forcedKill = $false; completedAtUtc = [DateTimeOffset]::UtcNow.ToString('o')
                })
                [IO.File]::Delete((Join-Path $root 'task-shadow.json'))
                Write-CutoverPreviousStopRecord (Join-Path $root 'task-shadow.json') ([ordered]@{
                    taskName = $intent.taskName; arguments = $intent.arguments; state = 'Ready'; lastRunUtc = [DateTimeOffset]::UtcNow.ToString('o'); lastResult = 0
                })
                }
            }
            else { Start-ScheduledTask -TaskName $intent.taskName -TaskPath '\' -ErrorAction Stop }
            Test-CutoverPreviousStopFault 'AfterTaskStarted'
            }
        }
        $waitSeconds = if ($script:CutoverHostBackend -ceq 'Shadow' -and $env:DYSON_CUTOVER_HOST_SELFTEST_FAIL_POINT -ceq 'PreviousStop-Timeout') { 1 } else { $script:CutoverHostRuntimeTimeoutSeconds }
        $deadline = [DateTime]::UtcNow.AddSeconds($waitSeconds)
        do {
            Assert-CutoverHostMutationLease
            [void](Assert-CutoverHostProfileRevision)
            if ((Get-CutoverHostSha256File $stopScript) -cne $stopHash) { Throw-CutoverHostError 'DYSON_CONTROL_CUTOVER_HOST_STOP_SCRIPT_DRIFT' }
            $task = Get-CutoverPreviousStopTask $intent $root
            if ($null -eq $task) { Throw-CutoverHostError 'DYSON_CONTROL_CUTOVER_HOST_STOP_TASK_CONFLICT' }
            if ($task.state -ceq 'Ready' -and [DateTimeOffset]::Parse($task.lastRunUtc) -ge [DateTimeOffset]::Parse($intent.createdAtUtc)) {
                if ($task.lastResult -ne 0) {
                    Close-CutoverPreviousStopFailure $intent $root $fingerprint 'DYSON_CONTROL_CUTOVER_HOST_TASK_FAILED'
                    Throw-CutoverHostError 'DYSON_CONTROL_CUTOVER_HOST_TASK_FAILED'
                }
                break
            }
            Start-Sleep -Milliseconds 250
        } while ([DateTime]::UtcNow -lt $deadline)
        if ($task.state -cne 'Ready' -or [DateTimeOffset]::Parse($task.lastRunUtc) -lt [DateTimeOffset]::Parse($intent.createdAtUtc)) { Throw-CutoverHostError 'DYSON_CONTROL_CUTOVER_HOST_TASK_TIMEOUT' }
        try {
        $receipt = Read-CutoverHostJsonFile $receiptPath
        Assert-CutoverHostExactProperties $receipt @('protocol','schemaVersion','requestId','expectedProcessId',
            'expectedProcessStartedAtUnixMs','scriptSha256','status','errorCode','signalSent','processExited','processExitCode','forcedKill','completedAtUtc')
        if ($receipt.protocol -cne 'DYSON_CONTROL_BOUND_STOP_RECEIPT_V1' -or $receipt.schemaVersion -ne 1 -or
            $receipt.requestId -cne $intent.requestId -or $receipt.expectedProcessId -ne $intent.processId -or
            $receipt.expectedProcessStartedAtUnixMs -ne $intent.processStartedAtUnixMs -or $receipt.scriptSha256 -cne $stopHash -or
            $receipt.status -cne 'succeeded' -or $receipt.errorCode -cne 'NONE' -or
            ($receipt.expectedProcessId -isnot [int] -and $receipt.expectedProcessId -isnot [long]) -or
            ($receipt.expectedProcessStartedAtUnixMs -isnot [int] -and $receipt.expectedProcessStartedAtUnixMs -isnot [long]) -or
            ($receipt.processExitCode -isnot [int] -and $receipt.processExitCode -isnot [long]) -or
            $receipt.processExitCode -lt [int]::MinValue -or $receipt.processExitCode -gt [int]::MaxValue -or
            $receipt.signalSent -isnot [bool] -or -not $receipt.signalSent -or
            $receipt.processExited -isnot [bool] -or -not $receipt.processExited -or
            $receipt.forcedKill -isnot [bool] -or $receipt.forcedKill -or
            [DateTimeOffset]::Parse($receipt.completedAtUtc) -lt [DateTimeOffset]::Parse($intent.createdAtUtc) -or
            [DateTimeOffset]::Parse($receipt.completedAtUtc) -gt [DateTimeOffset]::UtcNow.AddSeconds(5)) {
            Throw-CutoverHostError 'DYSON_CONTROL_CUTOVER_HOST_STOP_RECEIPT_INVALID'
        }
        }
        catch {
            Close-CutoverPreviousStopFailure $intent $root $fingerprint 'DYSON_CONTROL_CUTOVER_HOST_STOP_RECEIPT_INVALID'
            Throw-CutoverHostError 'DYSON_CONTROL_CUTOVER_HOST_STOP_RECEIPT_INVALID'
        }
        [void](Wait-CutoverHostRuntime stopped)
        Write-CutoverPreviousStopRecord $terminalPath ([ordered]@{
            intentSha256 = $fingerprint; receiptSha256 = Get-CutoverHostSha256File $receiptPath
            lastRunUtc = $task.lastRunUtc; lastResult = 0
        })
        Test-CutoverPreviousStopFault 'AfterTerminal'
    }
    $terminal = Read-CutoverHostJsonFile $terminalPath
    Assert-CutoverHostExactProperties $terminal @('intentSha256','receiptSha256','lastRunUtc','lastResult')
    if ($terminal.intentSha256 -cne $fingerprint -or $terminal.lastResult -ne 0 -or
        $terminal.receiptSha256 -cne (Get-CutoverHostSha256File (Assert-CutoverHostPlainFile $receiptPath))) { Throw-CutoverHostError 'DYSON_CONTROL_CUTOVER_HOST_STOP_RECORD_CONFLICT' }
    [void](Wait-CutoverHostRuntime stopped)
    Assert-CutoverHostMutationLease
    Test-CutoverPreviousStopFault 'BeforeCleanup'
    $task = Get-CutoverPreviousStopTask $intent $root
    if ($null -ne $task) {
        if ($task.state -cne 'Ready' -or $task.lastResult -ne 0 -or $task.lastRunUtc -cne $terminal.lastRunUtc) {
            Throw-CutoverHostError 'DYSON_CONTROL_CUTOVER_HOST_STOP_TASK_CONFLICT'
        }
        if ($script:CutoverHostBackend -ceq 'Shadow') { [IO.File]::Delete((Join-Path $root 'task-shadow.json')) }
        else { Unregister-ScheduledTask -TaskName $intent.taskName -TaskPath '\' -Confirm:$false -ErrorAction Stop }
    }
    if ($null -ne (Get-CutoverPreviousStopTask $intent $root)) { Throw-CutoverHostError 'DYSON_CONTROL_CUTOVER_HOST_STOP_CLEANUP_FAILED' }
    Assert-CutoverHostMutationLease
    Test-CutoverPreviousStopFault 'AfterCleanup'
    Write-CutoverPreviousStopRecord $completedPath ([ordered]@{ intentSha256 = $fingerprint; status = 'succeeded'; taskRemoved = $true })
}

function Assert-CutoverPreviousStopClean {
    $storage = Join-Path $script:CutoverHostRuntimeOwnerRoot 'previous-stop'
    if (-not (Test-Path -LiteralPath $storage)) { return }
    [void](Assert-CutoverHostPlainDirectory $storage)
    $nativeTasks = if ($script:CutoverHostBackend -ceq 'Windows') { @(Get-ScheduledTask -ErrorAction Stop) } else { @() }
    foreach ($directory in @(Get-ChildItem -LiteralPath $storage -Directory -Force)) {
        if (-not (Test-Path -LiteralPath (Join-Path $directory.FullName 'intent.json'))) { continue }
        $completedPath = Join-Path $directory.FullName 'completed.json'
        if (-not (Test-Path -LiteralPath $completedPath)) { Throw-CutoverHostError 'DYSON_CONTROL_CUTOVER_HOST_STOP_RECOVERY_REQUIRED' }
        $completed = Read-CutoverHostJsonFile $completedPath
        if ($completed.taskRemoved -isnot [bool] -or -not $completed.taskRemoved -or
            $completed.status -cnotin @('succeeded','failed','cancelled') -or
            (Test-Path -LiteralPath (Join-Path $directory.FullName 'task-shadow.json')) -or
            @($nativeTasks | Where-Object { $_.TaskPath -ceq '\' -and $_.TaskName -ceq ('Dyson-Cutover-Previous-Stop-' + $directory.Name) }).Count -ne 0) {
            Throw-CutoverHostError 'DYSON_CONTROL_CUTOVER_HOST_STOP_RECOVERY_REQUIRED'
        }
    }
}

function Cancel-CutoverUnstartedPreviousStop {
    $storage = Join-Path $script:CutoverHostRuntimeOwnerRoot 'previous-stop'
    if (-not (Test-Path -LiteralPath $storage)) { return }
    foreach ($directory in @(Get-ChildItem -LiteralPath $storage -Directory -Force)) {
        $intentPath = Join-Path $directory.FullName 'intent.json'
        if (-not (Test-Path -LiteralPath $intentPath) -or (Test-Path -LiteralPath (Join-Path $directory.FullName 'completed.json'))) { continue }
        Assert-CutoverHostMutationLease
        $intent = Read-CutoverHostJsonFile $intentPath
        Assert-CutoverHostExactProperties $intent @('protocol','requestId','authorityRevision','stopSha256','gameSid',
            'processId','processStartedAtUnixMs','taskName','execute','arguments','createdAtUtc')
        $requestGuid = [guid]::Empty
        if (-not [guid]::TryParseExact($directory.Name, 'D', [ref]$requestGuid) -or $intent.requestId -cne $directory.Name -or
            $intent.taskName -cne ('Dyson-Cutover-Previous-Stop-' + $directory.Name) -or
            $intent.authorityRevision -cne $script:CutoverHostExpectedInventoryRevision -or
            $intent.stopSha256 -cne $script:CutoverHostPreviousStopScriptSha256) {
            Throw-CutoverHostError 'DYSON_CONTROL_CUTOVER_HOST_STOP_RECORD_CONFLICT'
        }
        $leaf = Assert-CutoverHostPlainFile (Join-Path $script:CutoverHostWindowsRoot 'Stop-DysonServer.ps1')
        $receiptPath = Join-Path $directory.FullName 'receipts\stop.json'
        $expectedArguments = '-NoLogo -NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File "{0}" -ProjectRoot "{1}" -TimeoutSeconds 150 -StopRequestId {2} -ExpectedProcessId {3} -ExpectedProcessStartedAtUnixMs {4} -ExpectedScriptSha256 {5} -ReceiptPath "{6}"' -f
            $leaf, $script:CutoverHostProjectRoot, $directory.Name, $intent.processId, $intent.processStartedAtUnixMs, $intent.stopSha256, $receiptPath
        if ((Get-CutoverHostSha256File $leaf) -cne $intent.stopSha256 -or $intent.arguments -cne $expectedArguments -or
            $intent.execute -cne (Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe')) {
            Throw-CutoverHostError 'DYSON_CONTROL_CUTOVER_HOST_STOP_RECORD_CONFLICT'
        }
        if ($intent.requestId -cne $script:CutoverHostRequestId) { Throw-CutoverHostError 'DYSON_CONTROL_CUTOVER_HOST_STOP_RECOVERY_REQUIRED' }
        $task = Get-CutoverPreviousStopTask $intent $directory.FullName -RepairUnstartedAcl
        if (Test-Path -LiteralPath (Join-Path $directory.FullName 'dispatch.json')) {
            # Reconcile only an already-dispatched transaction. This path cannot register
            # or start a task: dispatch uncertainty is rejected by the transaction reader.
            if ($null -ne $task -and ($task.state -cne 'Ready' -or
                [DateTimeOffset]::Parse($task.lastRunUtc) -lt [DateTimeOffset]::Parse($intent.createdAtUtc))) {
                Throw-CutoverHostError 'DYSON_CONTROL_CUTOVER_HOST_STOP_RECOVERY_REQUIRED'
            }
            try { Invoke-CutoverPreviousStopTransaction }
            catch {
                $completedPath = Join-Path $directory.FullName 'completed.json'
                if (-not (Test-Path -LiteralPath $completedPath)) { throw }
                $completed = Read-CutoverHostJsonFile $completedPath
                $fingerprint = Get-CutoverHostSha256Text (ConvertTo-CutoverHostJson $intent)
                if ($completed.intentSha256 -cne $fingerprint -or $completed.status -cne 'failed' -or
                    $completed.taskRemoved -isnot [bool] -or -not $completed.taskRemoved -or
                    $null -ne (Get-CutoverPreviousStopTask $intent $directory.FullName)) { throw }
                # The immutable failure remains a failure; only its cleanup completed.
            }
            continue
        }
        if ((Test-Path -LiteralPath (Join-Path $directory.FullName 'dispatch.json')) -or
            (Test-Path -LiteralPath (Join-Path $directory.FullName 'receipts\stop.json')) -or
            ($null -ne $task -and ($task.state -cne 'Ready' -or [DateTimeOffset]::Parse($task.lastRunUtc).Year -ge 2000))) {
            Throw-CutoverHostError 'DYSON_CONTROL_CUTOVER_HOST_STOP_RECOVERY_REQUIRED'
        }
        if ($null -ne $task) {
            if ($script:CutoverHostBackend -ceq 'Shadow') { [IO.File]::Delete((Join-Path $directory.FullName 'task-shadow.json')) }
            else { Unregister-ScheduledTask -TaskName $intent.taskName -TaskPath '\' -Confirm:$false -ErrorAction Stop }
        }
        if ($null -ne (Get-CutoverPreviousStopTask $intent $directory.FullName)) { Throw-CutoverHostError 'DYSON_CONTROL_CUTOVER_HOST_STOP_CLEANUP_FAILED' }
        Write-CutoverPreviousStopRecord (Join-Path $directory.FullName 'completed.json') ([ordered]@{
            intentSha256 = Get-CutoverHostSha256Text (ConvertTo-CutoverHostJson $intent); status = 'cancelled'; taskRemoved = $true
        })
    }
}

function Assert-CutoverHostNoStructuralDrift {
    param([Parameter(Mandatory)]$Authority, [switch]$AllowCandidateStopTransition)
    if ([bool]$Authority.structuralDrift -and
        (-not $AllowCandidateStopTransition -or -not [bool]$Authority.candidateStopTemporarilyEnabled)) {
        Throw-CutoverHostError 'DYSON_CONTROL_CUTOVER_HOST_AUTHORITY_DRIFT'
    }
}

function Test-CutoverHostStoppedEvidence {
    param([Parameter(Mandatory)]$Evidence)
    return [string]$Evidence.processState -ceq 'none' -and [string]$Evidence.portState -ceq 'closed'
}

function Invoke-CutoverHostDisablePreviousAuthority {
    $profile = Assert-CutoverHostProfileRevision
    $authority = Get-CutoverHostAuthorityObservation $profile
    Assert-CutoverHostNoStructuralDrift $authority
    if (-not [bool]$authority.candidatePrepared) { Throw-CutoverHostError 'DYSON_CONTROL_CUTOVER_HOST_ACTION_PRECONDITION_FAILED' }
    $evidence = Get-CutoverHostEvidence
    if ([string]$evidence.processState -ceq 'previous-only') {
        $runtime = Get-CutoverHostRuntimeObservation
        Write-CutoverHostRuntimeOwner previous ([int]$runtime.pid)
    }
    elseif ([string]$evidence.processState -cne 'none') { Throw-CutoverHostError 'DYSON_CONTROL_CUTOVER_HOST_ACTION_PRECONDITION_FAILED' }
    if ([bool]$authority.panel.running) { Set-CutoverHostPanelRunning $false }
    if ([bool](Get-CutoverHostTaskImage $script:CutoverHostPreviousPanelTask).enabled) {
        Set-CutoverHostTaskEnabled $script:CutoverHostPreviousPanelTask $false
    }
    if ($env:DYSON_CUTOVER_HOST_SELFTEST_FAIL_POINT -ceq 'LeaseLossAfterMutation') {
        Throw-CutoverHostError 'DYSON_CONTROL_CUTOVER_HOST_LEASE_LOST'
    }
    Assert-CutoverHostMutationBoundary
    $after = Get-CutoverHostEvidence
    if ([bool]$after.previousEnabled -or [bool]$after.candidateEnabled -or
        [string]$after.processState -notin @('none', 'previous-only') -or [bool]$after.unexpectedAuthorityPresent) {
        Throw-CutoverHostError 'DYSON_CONTROL_CUTOVER_HOST_ACTION_POSTCONDITION_FAILED'
    }
}

function Invoke-CutoverHostStopPreviousRuntime {
    $authority = Get-CutoverHostAuthorityObservation (Assert-CutoverHostProfileRevision)
    Assert-CutoverHostNoStructuralDrift $authority
    if ([bool]$authority.previousLive -or [bool]$authority.candidateActive -or -not [bool]$authority.candidatePrepared) {
        Throw-CutoverHostError 'DYSON_CONTROL_CUTOVER_HOST_ACTION_PRECONDITION_FAILED'
    }
    $before = Get-CutoverHostEvidence
    if ($script:CutoverHostPreviousStopReconcileOnly) {
        if ([string]$before.processState -notin @('none', 'previous-only')) { Throw-CutoverHostError 'DYSON_CONTROL_CUTOVER_HOST_ACTION_PRECONDITION_FAILED' }
        Cancel-CutoverUnstartedPreviousStop
        Assert-CutoverPreviousStopClean
        Assert-CutoverHostMutationBoundary
        $after = Get-CutoverHostEvidence
        if ([bool]$after.previousEnabled -or [bool]$after.candidateEnabled -or [bool]$after.unexpectedAuthorityPresent -or
            [string]$after.processState -notin @('none', 'previous-only')) { Throw-CutoverHostError 'DYSON_CONTROL_CUTOVER_HOST_ACTION_POSTCONDITION_FAILED' }
        return
    }
    if ([string]$before.processState -ceq 'previous-only') {
        Invoke-CutoverPreviousStopTransaction
    }
    elseif (Test-Path -LiteralPath (Join-Path $script:CutoverHostRuntimeOwnerRoot ('previous-stop\' + $script:CutoverHostRequestId + '\intent.json'))) {
        Invoke-CutoverPreviousStopTransaction
    }
    elseif (-not (Test-CutoverHostStoppedEvidence $before)) { Throw-CutoverHostError 'DYSON_CONTROL_CUTOVER_HOST_ACTION_PRECONDITION_FAILED' }
    Remove-CutoverHostRuntimeOwner
    Assert-CutoverHostMutationBoundary
    $after = Get-CutoverHostEvidence
    if (-not (Test-CutoverHostStoppedEvidence $after) -or [bool]$after.unexpectedAuthorityPresent) {
        Throw-CutoverHostError 'DYSON_CONTROL_CUTOVER_HOST_ACTION_POSTCONDITION_FAILED'
    }
}

function Invoke-CutoverHostEnablePreviousAuthority {
    $authority = Get-CutoverHostAuthorityObservation (Assert-CutoverHostProfileRevision)
    Assert-CutoverHostNoStructuralDrift $authority
    if ([bool]$authority.candidateActive -or -not [bool]$authority.candidatePrepared -or
        (-not [bool]$authority.panel.enabled -and [bool]$authority.panel.running)) {
        Throw-CutoverHostError 'DYSON_CONTROL_CUTOVER_HOST_ACTION_PRECONDITION_FAILED'
    }
    $before = Get-CutoverHostEvidence
    if ([string]$before.processState -notin @('none', 'previous-only')) {
        Throw-CutoverHostError 'DYSON_CONTROL_CUTOVER_HOST_ACTION_PRECONDITION_FAILED'
    }
    Cancel-CutoverUnstartedPreviousStop
    Assert-CutoverPreviousStopClean
    if (-not [bool]$authority.panel.enabled) { Set-CutoverHostTaskEnabled $script:CutoverHostPreviousPanelTask $true }
    if (-not [bool](Get-CutoverHostTaskImage $script:CutoverHostPreviousPanelTask).running) { Set-CutoverHostPanelRunning $true }
    Assert-CutoverHostMutationBoundary
    $after = Get-CutoverHostEvidence
    if (-not [bool]$after.previousEnabled -or [bool]$after.candidateEnabled -or
        [string]$after.processState -notin @('none', 'previous-only') -or [bool]$after.unexpectedAuthorityPresent) {
        Throw-CutoverHostError 'DYSON_CONTROL_CUTOVER_HOST_ACTION_POSTCONDITION_FAILED'
    }
}

function Invoke-CutoverHostStartRuntime {
    param([ValidateSet('previous', 'candidate')][string]$Owner)
    $authority = Get-CutoverHostAuthorityObservation (Assert-CutoverHostProfileRevision)
    Assert-CutoverHostNoStructuralDrift $authority
    Assert-CutoverPreviousStopClean
    if ($Owner -ceq 'previous') {
        if (-not [bool]$authority.previousLive -or [bool]$authority.candidateActive -or -not [bool]$authority.candidatePrepared) {
            Throw-CutoverHostError 'DYSON_CONTROL_CUTOVER_HOST_ACTION_PRECONDITION_FAILED'
        }
    }
    elseif (-not [bool]$authority.candidateActive -or [bool]$authority.previousLive) {
        Throw-CutoverHostError 'DYSON_CONTROL_CUTOVER_HOST_ACTION_PRECONDITION_FAILED'
    }
    $before = Get-CutoverHostEvidence
    $desiredState = if ($Owner -ceq 'previous') { 'previous-only' } else { 'candidate-only' }
    if ([string]$before.processState -ceq 'none') {
        Invoke-CutoverHostFixedRuntimeTask $Owner start
        $runtime = Wait-CutoverHostRuntime running
        Write-CutoverHostRuntimeOwner $Owner ([int]$runtime.pid)
    }
    elseif ([string]$before.processState -ceq $desiredState) {
        $runtime = Get-CutoverHostRuntimeObservation
        Write-CutoverHostRuntimeOwner $Owner ([int]$runtime.pid)
    }
    else { Throw-CutoverHostError 'DYSON_CONTROL_CUTOVER_HOST_ACTION_PRECONDITION_FAILED' }
    Assert-CutoverHostMutationBoundary
    $after = Get-CutoverHostEvidence
    if ([string]$after.processState -cne $desiredState -or
        [string]$after.portState -cne $Owner -or [bool]$after.unexpectedAuthorityPresent) {
        Throw-CutoverHostError 'DYSON_CONTROL_CUTOVER_HOST_ACTION_POSTCONDITION_FAILED'
    }
}

function Invoke-CutoverHostStopCandidateRuntime {
    $authority = Get-CutoverHostAuthorityObservation (Assert-CutoverHostProfileRevision)
    Assert-CutoverHostNoStructuralDrift $authority -AllowCandidateStopTransition
    if ([bool]$authority.previousLive -or [bool]$authority.candidateActive -or
        (-not [bool]$authority.candidatePrepared -and -not [bool]$authority.candidateStopTemporarilyEnabled)) {
        Throw-CutoverHostError 'DYSON_CONTROL_CUTOVER_HOST_ACTION_PRECONDITION_FAILED'
    }
    $before = Get-CutoverHostEvidence
    if ([string]$before.processState -ceq 'candidate-only') {
        if (-not [bool](Get-CutoverHostTaskImage $script:CutoverHostCandidateStopTask).enabled) {
            Set-CutoverHostTaskEnabled $script:CutoverHostCandidateStopTask $true
        }
        try {
            Invoke-CutoverHostFixedRuntimeTask candidate stop
            [void](Wait-CutoverHostRuntime stopped)
            Wait-CutoverHostStopTaskTerminal $script:CutoverHostCandidateStopTask
        }
        finally {
            Assert-CutoverHostMutationLease
            $stopImage = Get-CutoverHostTaskImage $script:CutoverHostCandidateStopTask
            if ([bool]$stopImage.enabled) { Set-CutoverHostTaskEnabled $script:CutoverHostCandidateStopTask $false }
        }
    }
    elseif (-not (Test-CutoverHostStoppedEvidence $before)) { Throw-CutoverHostError 'DYSON_CONTROL_CUTOVER_HOST_ACTION_PRECONDITION_FAILED' }
    elseif ([bool](Get-CutoverHostTaskImage $script:CutoverHostCandidateStopTask).enabled) {
        Set-CutoverHostTaskEnabled $script:CutoverHostCandidateStopTask $false
    }
    Remove-CutoverHostRuntimeOwner
    Assert-CutoverHostMutationBoundary
    $after = Get-CutoverHostEvidence
    if (-not (Test-CutoverHostStoppedEvidence $after) -or [bool]$after.unexpectedAuthorityPresent -or [bool]$after.candidateEnabled) {
        Throw-CutoverHostError 'DYSON_CONTROL_CUTOVER_HOST_ACTION_POSTCONDITION_FAILED'
    }
}

function Invoke-CutoverHostFixedAction {
    param([Parameter(Mandatory)][string]$Action)
    if ($Action -notin @(
        'DisablePreviousAuthority', 'StopPreviousRuntime', 'EnablePreviousAuthority',
        'StartPreviousRuntime', 'StartCandidateRuntime', 'StopCandidateRuntime'
    )) { Throw-CutoverHostError 'DYSON_CONTROL_CUTOVER_HOST_ACTION_INVALID' }
    Assert-CutoverHostMutationBoundary
    if ($env:DYSON_CUTOVER_HOST_SELFTEST_FAIL_POINT -ceq 'BeforeMutation') {
        Throw-CutoverHostError 'DYSON_CONTROL_CUTOVER_HOST_SELFTEST_FAILURE'
    }
    switch ($Action) {
        'DisablePreviousAuthority' { Invoke-CutoverHostDisablePreviousAuthority }
        'StopPreviousRuntime' { Invoke-CutoverHostStopPreviousRuntime }
        'EnablePreviousAuthority' { Invoke-CutoverHostEnablePreviousAuthority }
        'StartPreviousRuntime' { Invoke-CutoverHostStartRuntime previous }
        'StartCandidateRuntime' { Invoke-CutoverHostStartRuntime candidate }
        'StopCandidateRuntime' { Invoke-CutoverHostStopCandidateRuntime }
    }
    Assert-CutoverHostMutationBoundary
}

function Initialize-CutoverHostContext {
    param(
        [Parameter(Mandatory)][string]$ProjectRoot,
        [Parameter(Mandatory)][string]$ProfileFile,
        [Parameter(Mandatory)][string]$RuntimeBootstrapRoot,
        [Parameter(Mandatory)][string]$RuntimeTaskTransactionRoot,
        [Parameter(Mandatory)][string]$ServiceUser,
        [Parameter(Mandatory)][int]$GamePort,
        [Parameter(Mandatory)][string]$AuthorityInventoryRevision,
        [Parameter(Mandatory)][string]$RequestId,
        [ValidateSet('Windows', 'Shadow')][string]$Backend = 'Windows',
        [AllowNull()][string]$ShadowRoot,
        [AllowNull()][string]$DataRoot,
        [AllowNull()][string]$LeaseInstanceId,
        [AllowNull()][string]$LeaseToken
    )
    $parsedId = [guid]::Empty
    if (-not [guid]::TryParseExact($RequestId, 'D', [ref]$parsedId) -or
        $AuthorityInventoryRevision -cnotmatch '^[0-9a-f]{64}$' -or
        $ServiceUser -notmatch '^[^"\r\n]{3,128}$' -or $GamePort -lt 1 -or $GamePort -gt 65535) {
        Throw-CutoverHostError 'DYSON_CONTROL_CUTOVER_HOST_INPUT_INVALID'
    }
    $script:CutoverHostBackend = $Backend
    $script:CutoverHostRequestId = $parsedId.ToString('D').ToLowerInvariant()
    $script:CutoverHostExpectedInventoryRevision = $AuthorityInventoryRevision
    $script:CutoverHostServiceUser = $ServiceUser
    $script:CutoverHostGamePort = $GamePort
    $script:CutoverHostProjectRoot = Assert-CutoverHostPlainDirectory $ProjectRoot
    $script:CutoverHostRuntimeBootstrapRoot = Assert-CutoverHostPlainDirectory $RuntimeBootstrapRoot
    $script:CutoverHostRuntimeTaskTransactionRoot = Assert-CutoverHostPlainDirectory $RuntimeTaskTransactionRoot
    $profile = Assert-CutoverHostPlainFile $ProfileFile $script:CutoverHostMaximumJsonBytes
    $profileRoot = [IO.Path]::GetDirectoryName($profile)
    if ([IO.Path]::GetFileName($profile) -cne 'authority-profile.json' -or
        [IO.Path]::GetFileName($profileRoot) -cne 'authority-inventory') {
        Throw-CutoverHostError 'DYSON_CONTROL_CUTOVER_HOST_PROFILE_BINDING_MISMATCH'
    }
    $derivedDataRoot = Assert-CutoverHostPlainDirectory ([IO.Path]::GetDirectoryName($profileRoot))
    if (-not [string]::IsNullOrWhiteSpace($DataRoot)) {
        $suppliedDataRoot = Assert-CutoverHostPlainDirectory $DataRoot
        if (-not (Test-CutoverHostSamePath $suppliedDataRoot $derivedDataRoot)) {
            Throw-CutoverHostError 'DYSON_CONTROL_CUTOVER_HOST_PROFILE_BINDING_MISMATCH'
        }
    }
    $dataInfo = Get-DysonHostMutationLeasePathInfo -DataRoot $derivedDataRoot
    $script:CutoverHostDataRoot = [string]$dataInfo.CanonicalDataRoot
    $script:CutoverHostDataRootIdentity = [string]$dataInfo.DataRootIdentity
    $script:CutoverHostProfileFile = $profile
    $script:CutoverHostPreviousScriptRoot = Assert-CutoverHostPlainDirectory (Join-Path $script:CutoverHostDataRoot 'private\gsmanager-authority')
    $script:CutoverHostExpectedExecutable = Assert-CutoverHostPlainFile (Join-Path $script:CutoverHostProjectRoot 'server\DSPGAME.exe') 8589934592
    $script:CutoverHostPidFile = Join-Path $script:CutoverHostProjectRoot 'run\dspgame.pid'
    $script:CutoverHostRuntimeOwnerRoot = $profileRoot
    $script:CutoverHostRuntimeOwnerFile = Join-Path $script:CutoverHostRuntimeOwnerRoot 'runtime-owner.json'
    $script:CutoverHostLeaseInstanceId = $LeaseInstanceId
    $script:CutoverHostLeaseToken = $LeaseToken
    $script:CutoverHostMutationMode = -not [string]::IsNullOrWhiteSpace($LeaseInstanceId) -or -not [string]::IsNullOrWhiteSpace($LeaseToken)
    if (([string]::IsNullOrWhiteSpace($LeaseInstanceId)) -ne ([string]::IsNullOrWhiteSpace($LeaseToken))) {
        Throw-CutoverHostError 'DYSON_CONTROL_CUTOVER_HOST_LEASE_REQUIRED'
    }
    if ($Backend -ceq 'Shadow') {
        if ($env:DYSON_CUTOVER_HOST_SELFTEST -cne '1' -or [string]::IsNullOrWhiteSpace($ShadowRoot)) {
            Throw-CutoverHostError 'DYSON_CONTROL_CUTOVER_HOST_SHADOW_FORBIDDEN'
        }
        $script:CutoverHostShadowRoot = Assert-CutoverHostPlainDirectory $ShadowRoot
        if (-not (Test-Path -LiteralPath (Join-Path $script:CutoverHostShadowRoot '.dyson-cutover-host-selftest') -PathType Leaf)) {
            Throw-CutoverHostError 'DYSON_CONTROL_CUTOVER_HOST_SHADOW_FORBIDDEN'
        }
    }
    else {
        $script:CutoverHostShadowRoot = $null
        if ([bool]$script:CutoverHostMutationMode) {
            $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
            $principal = [Security.Principal.WindowsPrincipal]::new($identity)
            if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
                Throw-CutoverHostError 'DYSON_CONTROL_CUTOVER_HOST_ADMIN_REQUIRED'
            }
        }
    }
    Assert-CutoverHostOwnerAcl
    [void](Assert-CutoverHostProfileRevision)
    if ([bool]$script:CutoverHostMutationMode) { Assert-CutoverHostMutationLease }
}
