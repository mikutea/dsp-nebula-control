[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$commonPath = Join-Path $PSScriptRoot 'DysonSession.Common.ps1'
$commonItem = Get-Item -LiteralPath $commonPath -Force -ErrorAction Stop
if ($commonItem.PSIsContainer -or
    ($commonItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint)) {
    throw 'The fixed interactive-session helper is unavailable or redirected.'
}
. $commonItem.FullName

function Assert-Fixture {
    param(
        [Parameter(Mandatory)][bool]$Condition,
        [Parameter(Mandatory)][string]$Message
    )
    if (-not $Condition) { throw $Message }
}

function New-FixtureSecureString {
    param([Parameter(Mandatory)][string]$Text)
    $secure = [System.Security.SecureString]::new()
    foreach ($character in $Text.ToCharArray()) { $secure.AppendChar($character) }
    $secure.MakeReadOnly()
    return $secure
}

Add-DysonSessionNativeTypes
Assert-Fixture ([bool]('DysonControl.SessionNative' -as [type])) 'The native LSA helper did not compile.'
$lsaObjectFields = @(
    [DysonControl.SessionNative+LsaObjectAttributes].GetFields() |
        ForEach-Object { $_.Name }
)
Assert-Fixture (
    ($lsaObjectFields -join ',') -eq
    'Length,RootDirectory,ObjectName,Attributes,SecurityDescriptor,SecurityQualityOfService'
) 'The native LSA_OBJECT_ATTRIBUTES layout is incomplete.'

$testRoot = Join-Path ([System.IO.Path]::GetTempPath()) (
    'dyson-session-selftest-' + [guid]::NewGuid().ToString('N')
)
$backupRoot = Join-Path $testRoot 'backups'
$fixtureSecretText = 'fixture-' + [guid]::NewGuid().ToString('N')
$previousSecretText = 'previous-' + [guid]::NewGuid().ToString('N')
$fixtureSecure = New-FixtureSecureString -Text $fixtureSecretText
$previousSecure = New-FixtureSecureString -Text $previousSecretText
$nativeSecretMemory = New-DysonLsaStringMemory -Secret $fixtureSecure
try {
    $nativeSecretDescriptor = [System.Runtime.InteropServices.Marshal]::PtrToStructure(
        $nativeSecretMemory.Structure,
        [type][DysonControl.SessionNative+LsaUnicodeString]
    )
    Assert-Fixture (
        [int]$nativeSecretDescriptor.Length -eq ($fixtureSecure.Length * 2)
    ) 'The SecureString LSA descriptor length is invalid.'
    Assert-Fixture (
        $nativeSecretDescriptor.Buffer -ne [IntPtr]::Zero
    ) 'The SecureString LSA descriptor buffer is missing.'
}
finally {
    Remove-DysonLsaStringMemory -Memory $nativeSecretMemory
}
$credential = [System.Management.Automation.PSCredential]::new(
    'DYSON-FIXTURE\DysonService',
    $fixtureSecure
)
$registry = @{}
$registry['DefaultUserName'] = [pscustomobject]@{ Exists = $true; Kind = 'String'; Value = 'PreviousUser' }
$registry['DefaultDomainName'] = [pscustomobject]@{ Exists = $true; Kind = 'String'; Value = 'PREVIOUS-HOST' }
$registry['AutoAdminLogon'] = [pscustomobject]@{ Exists = $true; Kind = 'String'; Value = '0' }
$registry['AutoLogonCount'] = [pscustomobject]@{ Exists = $true; Kind = 'DWord'; Value = 7 }
$secrets = @{}
$secrets[$script:DysonDefaultPasswordSecretName] = $previousSecure.Copy()
$aclWrites = [System.Collections.Generic.List[string]]::new()
$credentialChecks = [System.Collections.Generic.List[int]]::new()
$taskChecks = [System.Collections.Generic.List[int]]::new()
$idCalls = [System.Collections.Generic.List[int]]::new()
$writeFailure = [pscustomobject]@{ Enabled = $false; Triggered = $false }

$getRegistry = {
    param([string]$Name)
    if (-not $registry.ContainsKey($Name)) {
        return [pscustomobject]@{ Exists = $false; Kind = $null; Value = $null }
    }
    $entry = $registry[$Name]
    return [pscustomobject]@{
        Exists = [bool]$entry.Exists
        Kind = $entry.Kind
        Value = $entry.Value
    }
}.GetNewClosure()
$setRegistry = {
    param([string]$Name, [string]$Kind, [object]$Value)
    if ($writeFailure.Enabled -and
        $Name -eq 'AutoAdminLogon' -and
        [string]$Value -eq '1') {
        $writeFailure.Triggered = $true
        throw 'Injected fixture registry failure.'
    }
    $registry[$Name] = [pscustomobject]@{ Exists = $true; Kind = $Kind; Value = $Value }
}.GetNewClosure()
$removeRegistry = {
    param([string]$Name)
    [void]$registry.Remove($Name)
}.GetNewClosure()
$getSecret = {
    param([string]$Name)
    if (-not $secrets.ContainsKey($Name)) { return $null }
    return $secrets[$Name].Copy()
}.GetNewClosure()
$setSecret = {
    param([string]$Name, [System.Security.SecureString]$Secret)
    if ($secrets.ContainsKey($Name)) { $secrets[$Name].Dispose() }
    $secrets[$Name] = $Secret.Copy()
}.GetNewClosure()
$removeSecret = {
    param([string]$Name)
    if ($secrets.ContainsKey($Name)) {
        $secrets[$Name].Dispose()
        [void]$secrets.Remove($Name)
    }
}.GetNewClosure()
$resolveAccount = {
    param([string]$Name)
    if ($Name -notin @('DysonService', 'DYSON-FIXTURE\DysonService')) {
        throw 'Fixture account mismatch.'
    }
    return [pscustomobject]@{
        LocalName = 'DysonService'
        Domain = 'DYSON-FIXTURE'
        CanonicalName = 'DYSON-FIXTURE\DysonService'
        Sid = 'S-1-5-21-111-222-333-1001'
    }
}.GetNewClosure()
$validateCredential = {
    param([object]$Account, [System.Security.SecureString]$Password)
    $credentialChecks.Add(1) | Out-Null
    return $Account.Sid -eq 'S-1-5-21-111-222-333-1001' -and $Password.Length -gt 0
}.GetNewClosure()
$validateTask = {
    param([object]$Account)
    $taskChecks.Add(1) | Out-Null
    return [pscustomobject]@{
        Ready = $Account.Sid -eq 'S-1-5-21-111-222-333-1001'
        Code = 'READY'
        ProjectRoot = 'C:\Fictional\Dyson'
    }
}.GetNewClosure()
$applyAcl = {
    param([string]$Path, [bool]$Directory)
    $aclWrites.Add(($Directory.ToString() + ':' + $Path)) | Out-Null
}.GetNewClosure()
$validateAcl = { param([string]$Path) return (Test-Path -LiteralPath $Path) }.GetNewClosure()
$newId = {
    $idCalls.Add(1) | Out-Null
    if ($idCalls.Count -eq 1) { return '11111111-2222-4333-8444-555555555555' }
    return [guid]::NewGuid().ToString('D')
}.GetNewClosure()
$context = [pscustomobject]@{
    Mode = 'fixture'
    Registry = [pscustomobject]@{
        GetValue = $getRegistry
        SetValue = $setRegistry
        RemoveValue = $removeRegistry
    }
    Lsa = [pscustomobject]@{
        GetSecret = $getSecret
        SetSecret = $setSecret
        RemoveSecret = $removeSecret
    }
    BackupRoot = $backupRoot
    ResolveAccount = $resolveAccount
    ValidateCredential = $validateCredential
    ValidateTask = $validateTask
    ValidatePolicy = { [pscustomobject]@{ Ready = $true; Code = 'READY' } }
    ProbeSession = {
        param([object]$Account)
        [pscustomobject]@{ Verifiable = $true; Present = $true; SessionCount = 1 }
    }
    ApplyAcl = $applyAcl
    ValidateAcl = $validateAcl
    Now = { '2026-08-30T00:00:00.0000000Z' }
    NewId = $newId
}

try {
    $preview = Invoke-DysonConfigureInteractiveSession -Credential $credential -Context $context -Apply $false
    Assert-Fixture ($preview.state -eq 'preview') 'Configure preview did not remain read-only.'
    Assert-Fixture (-not (Test-Path -LiteralPath $backupRoot)) 'Configure preview created a backup directory.'
    Assert-Fixture ([string]$registry['AutoAdminLogon'].Value -eq '0') 'Configure preview changed Winlogon flags.'
    Assert-Fixture ($secrets.Count -eq 1) 'Configure preview changed LSA fixture secrets.'

    $configured = Invoke-DysonConfigureInteractiveSession -Credential $credential -Context $context -Apply $true
    Assert-Fixture ($configured.state -eq 'configured') 'Configure did not report the configured state.'
    Assert-Fixture ([string]$registry['DefaultUserName'].Value -eq 'DysonService') 'The exact local user was not configured.'
    Assert-Fixture ([string]$registry['DefaultDomainName'].Value -eq 'DYSON-FIXTURE') 'The exact local domain was not configured.'
    Assert-Fixture ([string]$registry['AutoAdminLogon'].Value -eq '1') 'AutoAdminLogon was not enabled last.'
    Assert-Fixture ([string]$registry['ForceAutoLogon'].Value -eq '1') 'ForceAutoLogon was not enabled last.'
    Assert-Fixture (-not $registry.ContainsKey('AutoLogonCount')) 'The limiting AutoLogonCount was not removed.'
    Assert-Fixture (-not $registry.ContainsKey('DefaultPassword')) 'A plaintext registry password was created.'
    Assert-Fixture ($secrets.ContainsKey($script:DysonDefaultPasswordSecretName)) 'The LSA DefaultPassword secret is missing.'
    Assert-Fixture ($secrets.Count -eq 2) 'The current and rollback LSA secrets were not both retained.'
    Assert-Fixture ($aclWrites.Count -ge 2) 'The backup ACL tightening hook was not applied.'

    $activePath = Get-DysonActiveBackupPath -Context $context
    $activePayload = Get-Content -LiteralPath $activePath -Raw
    Assert-Fixture (-not $activePayload.Contains($fixtureSecretText)) 'The rollback metadata contains the current password.'
    Assert-Fixture (-not $activePayload.Contains($previousSecretText)) 'The rollback metadata contains the previous password.'

    $configuredAgain = Invoke-DysonConfigureInteractiveSession -Credential $credential -Context $context -Apply $true
    Assert-Fixture $configuredAgain.rollbackBackupReused 'Idempotent configure replaced the original rollback backup.'
    Assert-Fixture ($idCalls.Count -eq 1) 'Idempotent configure generated a second backup identity.'

    $tested = Get-DysonInteractiveSessionConfiguration -Context $context -Credential $credential
    Assert-Fixture ($tested.state -eq 'ready' -and $tested.ready) 'The configured fixture did not pass Test.'
    Assert-Fixture ($tested.interactiveLogonValidation -eq 'validated-now') 'Interactive credential validation was not recorded.'

    $disablePreview = Invoke-DysonDisableInteractiveSession -Context $context -Apply $false
    Assert-Fixture ($disablePreview.state -eq 'preview-disable') 'Disable preview did not remain read-only.'
    Assert-Fixture ([string]$registry['AutoAdminLogon'].Value -eq '1') 'Disable preview changed Winlogon flags.'

    $disabled = Invoke-DysonDisableInteractiveSession -Context $context -Apply $true
    Assert-Fixture ($disabled.state -eq 'disabled') 'Disable did not report a restored state.'
    Assert-Fixture ([string]$registry['DefaultUserName'].Value -eq 'PreviousUser') 'Disable did not restore DefaultUserName.'
    Assert-Fixture ([string]$registry['DefaultDomainName'].Value -eq 'PREVIOUS-HOST') 'Disable did not restore DefaultDomainName.'
    Assert-Fixture ([string]$registry['AutoAdminLogon'].Value -eq '0') 'Disable did not restore AutoAdminLogon.'
    Assert-Fixture (-not $registry.ContainsKey('ForceAutoLogon')) 'Disable did not restore the absent ForceAutoLogon value.'
    Assert-Fixture ([int]$registry['AutoLogonCount'].Value -eq 7) 'Disable did not restore AutoLogonCount.'
    Assert-Fixture (-not $registry.ContainsKey('DefaultPassword')) 'Disable wrote a plaintext registry password.'
    Assert-Fixture ($secrets.Count -eq 1) 'Disable left an LSA rollback secret behind.'
    Assert-Fixture (-not (Test-Path -LiteralPath $activePath)) 'Disable left an active rollback marker.'
    $archive = @(Get-ChildItem -LiteralPath $backupRoot -Filter 'restored-*.json' -File)
    Assert-Fixture ($archive.Count -eq 1) 'Disable did not archive exactly one rollback receipt.'
    $archivePayload = Get-Content -LiteralPath $archive[0].FullName -Raw
    Assert-Fixture (-not $archivePayload.Contains($fixtureSecretText)) 'The archived rollback receipt contains the current password.'
    Assert-Fixture (-not $archivePayload.Contains($previousSecretText)) 'The archived rollback receipt contains the previous password.'

    $disabledAgain = Invoke-DysonDisableInteractiveSession -Context $context -Apply $true
    Assert-Fixture ($disabledAgain.state -eq 'already-disabled') 'Disable is not idempotent.'

    $writeFailure.Enabled = $true
    $failedConfigureObserved = $false
    try {
        [void](Invoke-DysonConfigureInteractiveSession -Credential $credential -Context $context -Apply $true)
    }
    catch {
        $failedConfigureObserved = $true
    }
    finally {
        $writeFailure.Enabled = $false
    }
    Assert-Fixture ($failedConfigureObserved -and $writeFailure.Triggered) 'The injected configure failure was not observed.'
    Assert-Fixture ([string]$registry['DefaultUserName'].Value -eq 'PreviousUser') 'Configure failure did not restore DefaultUserName.'
    Assert-Fixture ([string]$registry['AutoAdminLogon'].Value -eq '0') 'Configure failure did not restore AutoAdminLogon.'
    Assert-Fixture (-not $registry.ContainsKey('ForceAutoLogon')) 'Configure failure did not restore the absent ForceAutoLogon value.'
    Assert-Fixture ($secrets.Count -eq 1) 'Configure failure left a current or rollback LSA secret behind.'
    Assert-Fixture (-not (Test-Path -LiteralPath $activePath)) 'Configure failure left an active rollback marker.'

    $publicScripts = @(
        'Configure-DysonInteractiveSession.ps1',
        'Test-DysonInteractiveSession.ps1',
        'Disable-DysonInteractiveSession.ps1',
        'DysonSession.Common.ps1'
    )
    $sourceText = ($publicScripts | ForEach-Object {
        Get-Content -LiteralPath (Join-Path $PSScriptRoot $_) -Raw
    }) -join [Environment]::NewLine
    foreach ($forbidden in @(
        ('Restart' + '-Computer'),
        ('Stop' + '-Computer'),
        ('shutdown' + '.exe'),
        ('logoff' + '.exe'),
        ('Start' + '-ScheduledTask'),
        ('Start' + '-Process'),
        ('Get' + 'Network' + 'Credential')
    )) {
        Assert-Fixture (-not $sourceText.Contains($forbidden)) "A forbidden runtime side effect or plaintext conversion was found: $forbidden"
    }
    Assert-Fixture ($sourceText.Contains('LsaStorePrivateData')) 'The native LSA private-data helper is missing.'
    Assert-Fixture ($sourceText.Contains('SecureStringToGlobalAllocUnicode')) 'SecureString native marshalling is missing.'
    Assert-Fixture ($sourceText.Contains('ZeroFreeGlobalAllocUnicode')) 'SecureString native zero-free cleanup is missing.'
    Assert-Fixture (-not ($sourceText -match 'Set-DysonRegistryValue[^\r\n]+DefaultPassword')) 'A registry DefaultPassword write was found.'
    Assert-Fixture ((Get-Content -LiteralPath (Join-Path $PSScriptRoot 'Configure-DysonInteractiveSession.ps1') -Raw).Contains('SupportsShouldProcess')) 'Configure does not support WhatIf.'
    Assert-Fixture ((Get-Content -LiteralPath (Join-Path $PSScriptRoot 'Disable-DysonInteractiveSession.ps1') -Raw).Contains('SupportsShouldProcess')) 'Disable does not support WhatIf.'

    $parameterContracts = [ordered]@{
        'Configure-DysonInteractiveSession.ps1' = @('Credential', 'RuntimeBootstrapRoot')
        'Test-DysonInteractiveSession.ps1' = @('Credential', 'RuntimeBootstrapRoot')
        'Disable-DysonInteractiveSession.ps1' = @()
    }
    foreach ($entry in $parameterContracts.GetEnumerator()) {
        $tokens = $null
        $parseErrors = $null
        $ast = [System.Management.Automation.Language.Parser]::ParseFile(
            (Join-Path $PSScriptRoot $entry.Key),
            [ref]$tokens,
            [ref]$parseErrors
        )
        Assert-Fixture ($parseErrors.Count -eq 0) "The public session script could not be parsed: $($entry.Key)"
        $actualParameters = @(
            $ast.ParamBlock.Parameters |
                ForEach-Object { [string]$_.Name.VariablePath.UserPath }
        )
        $expectedParameters = @($entry.Value)
        Assert-Fixture (
            $actualParameters.Count -eq $expectedParameters.Count -and
            @($expectedParameters | Where-Object { $_ -notin $actualParameters }).Count -eq 0
        ) "The public session script accepts an unexpected path, command, or executable parameter: $($entry.Key)"
    }

    $boundedOutput = @($preview, $configured, $configuredAgain, $tested, $disablePreview, $disabled, $disabledAgain) |
        ConvertTo-Json -Depth 10
    Assert-Fixture (-not $boundedOutput.Contains($fixtureSecretText)) 'A lifecycle result contains the current password.'
    Assert-Fixture (-not $boundedOutput.Contains($previousSecretText)) 'A lifecycle result contains the previous password.'
    Assert-Fixture ($credentialChecks.Count -ge 4) 'The exact interactive credential was not checked at every configure/test boundary.'
    Assert-Fixture ($taskChecks.Count -ge 4) 'The fixed server task was not checked at every configure/test boundary.'

    [ordered]@{
        protocol = 'DYSON_CONTROL_INTERACTIVE_SESSION_SELFTEST_V1'
        state = 'succeeded'
        configurePreviewReadOnly = $true
        configureIdempotent = $true
        disablePreviewReadOnly = $true
        disableIdempotent = $true
        configureFailureRollbackPassed = $true
        rollbackRestored = $true
        secretOutputScanPassed = $true
        forbiddenSideEffectScanPassed = $true
        publicParameterAllowlistPassed = $true
        backupAclHookValidated = $true
        nativeLsaStaticValidated = $true
        nativeLsaRuntimeValidated = $false
        realHostValidationRequired = $true
        credentialValidationCalls = $credentialChecks.Count
        taskValidationCalls = $taskChecks.Count
    } | ConvertTo-Json -Depth 5 -Compress
}
finally {
    foreach ($secret in @($secrets.Values)) { $secret.Dispose() }
    $fixtureSecure.Dispose()
    $previousSecure.Dispose()
    if (Test-Path -LiteralPath $testRoot) {
        Remove-Item -LiteralPath $testRoot -Recurse -Force
    }
}
