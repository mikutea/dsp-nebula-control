Set-StrictMode -Version Latest

$script:DysonWinlogonRegistryPath = 'SOFTWARE\Microsoft\Windows NT\CurrentVersion\Winlogon'
$script:DysonDefaultPasswordSecretName = 'DefaultPassword'
$script:DysonServerTaskName = 'Dyson-Nebula-Server'
$script:DysonBackupProtocol = 'DYSON_CONTROL_SESSION_BACKUP_V1'
$script:DysonSessionProtocol = 'DYSON_CONTROL_INTERACTIVE_SESSION_V1'
$script:DysonManagedRegistryValueNames = @(
    'DefaultUserName',
    'DefaultDomainName',
    'AutoAdminLogon',
    'ForceAutoLogon',
    'AutoLogonCount'
)

function Assert-DysonSessionAdministrator {
    $identity = [System.Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = [System.Security.Principal.WindowsPrincipal]::new($identity)
    if (-not $principal.IsInRole([System.Security.Principal.WindowsBuiltInRole]::Administrator)) {
        throw 'Administrator rights are required to manage the Dyson interactive session.'
    }
}

function Add-DysonSessionNativeTypes {
    if ('DysonControl.SessionNative' -as [type]) { return }
    Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;

namespace DysonControl {
    public static class SessionNative {
        [StructLayout(LayoutKind.Sequential)]
        public struct LsaUnicodeString {
            public UInt16 Length;
            public UInt16 MaximumLength;
            public IntPtr Buffer;
        }

        [StructLayout(LayoutKind.Sequential)]
        public struct LsaObjectAttributes {
            public UInt32 Length;
            public IntPtr RootDirectory;
            public IntPtr ObjectName;
            public UInt32 Attributes;
            public IntPtr SecurityDescriptor;
            public IntPtr SecurityQualityOfService;
        }

        [DllImport("advapi32.dll", SetLastError = true)]
        public static extern UInt32 LsaOpenPolicy(
            IntPtr SystemName,
            ref LsaObjectAttributes ObjectAttributes,
            UInt32 DesiredAccess,
            out IntPtr PolicyHandle
        );

        [DllImport("advapi32.dll")]
        public static extern UInt32 LsaStorePrivateData(
            IntPtr PolicyHandle,
            IntPtr KeyName,
            IntPtr PrivateData
        );

        [DllImport("advapi32.dll")]
        public static extern UInt32 LsaRetrievePrivateData(
            IntPtr PolicyHandle,
            IntPtr KeyName,
            out IntPtr PrivateData
        );

        [DllImport("advapi32.dll")]
        public static extern UInt32 LsaNtStatusToWinError(UInt32 Status);

        [DllImport("advapi32.dll")]
        public static extern UInt32 LsaFreeMemory(IntPtr Buffer);

        [DllImport("advapi32.dll")]
        public static extern UInt32 LsaClose(IntPtr ObjectHandle);

        [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        public static extern bool LogonUser(
            string UserName,
            string Domain,
            IntPtr Password,
            int LogonType,
            int LogonProvider,
            out IntPtr Token
        );

        [DllImport("kernel32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        public static extern bool CloseHandle(IntPtr Handle);
    }
}
'@
}

function New-DysonLsaStringMemory {
    param(
        [Parameter(Mandatory, ParameterSetName = 'Text')][string]$Text,
        [Parameter(Mandatory, ParameterSetName = 'Secret')][System.Security.SecureString]$Secret
    )

    Add-DysonSessionNativeTypes
    $containsSecret = $PSCmdlet.ParameterSetName -eq 'Secret'
    if ($containsSecret) {
        $buffer = [System.Runtime.InteropServices.Marshal]::SecureStringToGlobalAllocUnicode($Secret)
        $characterLength = $Secret.Length
    }
    else {
        $buffer = [System.Runtime.InteropServices.Marshal]::StringToHGlobalUni($Text)
        $characterLength = $Text.Length
    }
    if ($characterLength -gt 32766) {
        if ($containsSecret) {
            [System.Runtime.InteropServices.Marshal]::ZeroFreeGlobalAllocUnicode($buffer)
        }
        else {
            [System.Runtime.InteropServices.Marshal]::FreeHGlobal($buffer)
        }
        throw 'The LSA private-data name or value is too long.'
    }

    $value = [DysonControl.SessionNative+LsaUnicodeString]::new()
    $value.Length = [uint16]($characterLength * 2)
    $value.MaximumLength = [uint16](($characterLength * 2) + 2)
    $value.Buffer = $buffer
    $structureSize = [System.Runtime.InteropServices.Marshal]::SizeOf(
        [type][DysonControl.SessionNative+LsaUnicodeString]
    )
    $structurePointer = [System.Runtime.InteropServices.Marshal]::AllocHGlobal($structureSize)
    [System.Runtime.InteropServices.Marshal]::StructureToPtr($value, $structurePointer, $false)
    return [pscustomobject]@{
        Buffer = $buffer
        Structure = $structurePointer
        ContainsSecret = $containsSecret
    }
}

function Remove-DysonLsaStringMemory {
    param([Parameter(Mandatory)][object]$Memory)
    if ($Memory.Structure -ne [IntPtr]::Zero) {
        [System.Runtime.InteropServices.Marshal]::DestroyStructure(
            $Memory.Structure,
            [type][DysonControl.SessionNative+LsaUnicodeString]
        )
        [System.Runtime.InteropServices.Marshal]::FreeHGlobal($Memory.Structure)
    }
    if ($Memory.Buffer -ne [IntPtr]::Zero) {
        if ($Memory.ContainsSecret) {
            [System.Runtime.InteropServices.Marshal]::ZeroFreeGlobalAllocUnicode($Memory.Buffer)
        }
        else {
            [System.Runtime.InteropServices.Marshal]::FreeHGlobal($Memory.Buffer)
        }
    }
}

function Open-DysonLsaPolicy {
    Add-DysonSessionNativeTypes
    $attributes = [DysonControl.SessionNative+LsaObjectAttributes]::new()
    $attributes.Length = [uint32][System.Runtime.InteropServices.Marshal]::SizeOf(
        [type][DysonControl.SessionNative+LsaObjectAttributes]
    )
    $handle = [IntPtr]::Zero
    $policyGetPrivateInformation = [uint32]0x00000004
    $policyCreateSecret = [uint32]0x00000020
    $status = [DysonControl.SessionNative]::LsaOpenPolicy(
        [IntPtr]::Zero,
        [ref]$attributes,
        ($policyGetPrivateInformation -bor $policyCreateSecret),
        [ref]$handle
    )
    if ($status -ne 0) {
        $win32 = [DysonControl.SessionNative]::LsaNtStatusToWinError($status)
        throw "LSA policy access failed with Windows error $win32."
    }
    return $handle
}

function Get-DysonNativeLsaSecret {
    param([Parameter(Mandatory)][ValidatePattern('^[A-Za-z0-9._/-]{1,192}$')][string]$Name)

    $policy = [IntPtr]::Zero
    $keyMemory = $null
    $privateData = [IntPtr]::Zero
    try {
        $policy = Open-DysonLsaPolicy
        $keyMemory = New-DysonLsaStringMemory -Text $Name
        $status = [DysonControl.SessionNative]::LsaRetrievePrivateData(
            $policy,
            $keyMemory.Structure,
            [ref]$privateData
        )
        if ($status -ne 0) {
            $win32 = [DysonControl.SessionNative]::LsaNtStatusToWinError($status)
            if ($win32 -eq 2) { return $null }
            throw "LSA private-data read failed with Windows error $win32."
        }
        $nativeValue = [System.Runtime.InteropServices.Marshal]::PtrToStructure(
            $privateData,
            [type][DysonControl.SessionNative+LsaUnicodeString]
        )
        $secure = [System.Security.SecureString]::new()
        for ($index = 0; $index -lt ([int]$nativeValue.Length / 2); $index += 1) {
            $secure.AppendChar([char][System.Runtime.InteropServices.Marshal]::ReadInt16(
                $nativeValue.Buffer,
                $index * 2
            ))
        }
        $secure.MakeReadOnly()
        return $secure
    }
    finally {
        if ($privateData -ne [IntPtr]::Zero) {
            [void][DysonControl.SessionNative]::LsaFreeMemory($privateData)
        }
        if ($keyMemory) { Remove-DysonLsaStringMemory -Memory $keyMemory }
        if ($policy -ne [IntPtr]::Zero) { [void][DysonControl.SessionNative]::LsaClose($policy) }
    }
}

function Set-DysonNativeLsaSecret {
    param(
        [Parameter(Mandatory)][ValidatePattern('^[A-Za-z0-9._/-]{1,192}$')][string]$Name,
        [Parameter(Mandatory)][System.Security.SecureString]$Secret
    )

    $policy = [IntPtr]::Zero
    $keyMemory = $null
    $secretMemory = $null
    try {
        $policy = Open-DysonLsaPolicy
        $keyMemory = New-DysonLsaStringMemory -Text $Name
        $secretMemory = New-DysonLsaStringMemory -Secret $Secret
        $status = [DysonControl.SessionNative]::LsaStorePrivateData(
            $policy,
            $keyMemory.Structure,
            $secretMemory.Structure
        )
        if ($status -ne 0) {
            $win32 = [DysonControl.SessionNative]::LsaNtStatusToWinError($status)
            throw "LSA private-data write failed with Windows error $win32."
        }
    }
    finally {
        if ($secretMemory) { Remove-DysonLsaStringMemory -Memory $secretMemory }
        if ($keyMemory) { Remove-DysonLsaStringMemory -Memory $keyMemory }
        if ($policy -ne [IntPtr]::Zero) { [void][DysonControl.SessionNative]::LsaClose($policy) }
    }
}

function Remove-DysonNativeLsaSecret {
    param([Parameter(Mandatory)][ValidatePattern('^[A-Za-z0-9._/-]{1,192}$')][string]$Name)

    $policy = [IntPtr]::Zero
    $keyMemory = $null
    try {
        $policy = Open-DysonLsaPolicy
        $keyMemory = New-DysonLsaStringMemory -Text $Name
        $status = [DysonControl.SessionNative]::LsaStorePrivateData(
            $policy,
            $keyMemory.Structure,
            [IntPtr]::Zero
        )
        if ($status -ne 0) {
            $win32 = [DysonControl.SessionNative]::LsaNtStatusToWinError($status)
            if ($win32 -ne 2) {
                throw "LSA private-data removal failed with Windows error $win32."
            }
        }
    }
    finally {
        if ($keyMemory) { Remove-DysonLsaStringMemory -Memory $keyMemory }
        if ($policy -ne [IntPtr]::Zero) { [void][DysonControl.SessionNative]::LsaClose($policy) }
    }
}

function Test-DysonNativeInteractiveCredential {
    param(
        [Parameter(Mandatory)][object]$Account,
        [Parameter(Mandatory)][System.Security.SecureString]$Password
    )

    Add-DysonSessionNativeTypes
    $passwordPointer = [IntPtr]::Zero
    $token = [IntPtr]::Zero
    try {
        $passwordPointer = [System.Runtime.InteropServices.Marshal]::SecureStringToGlobalAllocUnicode($Password)
        $valid = [DysonControl.SessionNative]::LogonUser(
            [string]$Account.LocalName,
            [string]$Account.Domain,
            $passwordPointer,
            2,
            0,
            [ref]$token
        )
        if (-not $valid) {
            $code = [System.Runtime.InteropServices.Marshal]::GetLastWin32Error()
            throw "The dedicated account could not perform an interactive local logon (Windows error $code)."
        }
        return $true
    }
    finally {
        if ($token -ne [IntPtr]::Zero) { [void][DysonControl.SessionNative]::CloseHandle($token) }
        if ($passwordPointer -ne [IntPtr]::Zero) {
            [System.Runtime.InteropServices.Marshal]::ZeroFreeGlobalAllocUnicode($passwordPointer)
        }
    }
}

function New-DysonNativeRegistryAdapter {
    $registryPath = $script:DysonWinlogonRegistryPath
    $getValue = {
        param([string]$Name)
        $key = [Microsoft.Win32.Registry]::LocalMachine.OpenSubKey($registryPath, $false)
        if (-not $key) {
            return [pscustomobject]@{ Exists = $false; Kind = $null; Value = $null }
        }
        try {
            if ($key.GetValueNames() -notcontains $Name) {
                return [pscustomobject]@{ Exists = $false; Kind = $null; Value = $null }
            }
            $value = $key.GetValue(
                $Name,
                $null,
                [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames
            )
            return [pscustomobject]@{
                Exists = $true
                Kind = $key.GetValueKind($Name).ToString()
                Value = $value
            }
        }
        finally { $key.Dispose() }
    }.GetNewClosure()
    $setValue = {
        param([string]$Name, [string]$Kind, [object]$Value)
        if ($Kind -notin @('String', 'ExpandString', 'DWord', 'QWord')) {
            throw 'The registry backup contains an unsupported value kind.'
        }
        $key = [Microsoft.Win32.Registry]::LocalMachine.CreateSubKey($registryPath, $true)
        try {
            $typedValue = $Value
            if ($Kind -eq 'DWord') { $typedValue = [int]$Value }
            if ($Kind -eq 'QWord') { $typedValue = [long]$Value }
            $key.SetValue($Name, $typedValue, [Microsoft.Win32.RegistryValueKind]::$Kind)
        }
        finally { $key.Dispose() }
    }.GetNewClosure()
    $removeValue = {
        param([string]$Name)
        $key = [Microsoft.Win32.Registry]::LocalMachine.CreateSubKey($registryPath, $true)
        try { $key.DeleteValue($Name, $false) }
        finally { $key.Dispose() }
    }.GetNewClosure()
    return [pscustomobject]@{
        GetValue = $getValue
        SetValue = $setValue
        RemoveValue = $removeValue
    }
}

function New-DysonNativeLsaAdapter {
    return [pscustomobject]@{
        GetSecret = { param([string]$Name) Get-DysonNativeLsaSecret -Name $Name }
        SetSecret = {
            param([string]$Name, [System.Security.SecureString]$Secret)
            Set-DysonNativeLsaSecret -Name $Name -Secret $Secret
        }
        RemoveSecret = { param([string]$Name) Remove-DysonNativeLsaSecret -Name $Name }
    }
}

function Resolve-DysonNativeLocalAccount {
    param([Parameter(Mandatory)][ValidatePattern('^[^"''\r\n@/]{1,128}$')][string]$UserName)

    $domain = $env:COMPUTERNAME
    $localName = $UserName
    if ($UserName -match '^(?<domain>[^\\]+)\\(?<name>[^\\]+)$') {
        $requestedDomain = $Matches['domain']
        $localName = $Matches['name']
        if ($requestedDomain -ne '.' -and
            -not [string]::Equals($requestedDomain, $domain, [System.StringComparison]::OrdinalIgnoreCase)) {
            throw 'The dedicated Dyson account must be a local account on this computer.'
        }
    }
    $localUser = Get-LocalUser -Name $localName -ErrorAction Stop
    if (-not $localUser.Enabled) { throw 'The dedicated Dyson account is disabled.' }
    if (-not $localUser.PasswordRequired) {
        throw 'The dedicated Dyson account must require a non-empty password.'
    }
    if ($null -ne $localUser.PasswordExpires -or $null -ne $localUser.AccountExpires) {
        throw 'The dedicated Dyson account password and account must not expire.'
    }
    $sid = [string]$localUser.SID.Value
    if ($sid -match '-(500|501)$') {
        throw 'A built-in Administrator or Guest account cannot be used as the dedicated Dyson service account.'
    }
    $canonical = "$domain\$localName"
    $translatedSid = ([System.Security.Principal.NTAccount]::new($canonical)).Translate(
        [System.Security.Principal.SecurityIdentifier]
    ).Value
    if (-not [string]::Equals($sid, $translatedSid, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw 'The dedicated local account identity could not be verified.'
    }
    return [pscustomobject]@{
        LocalName = [string]$localName
        Domain = [string]$domain
        CanonicalName = [string]$canonical
        Sid = [string]$sid
    }
}

function Resolve-DysonAccountSid {
    param([Parameter(Mandatory)][string]$AccountName)
    try {
        return ([System.Security.Principal.NTAccount]::new($AccountName)).Translate(
            [System.Security.Principal.SecurityIdentifier]
        ).Value
    }
    catch { return $null }
}

function Test-DysonNativeServerTask {
    param([Parameter(Mandatory)][object]$Account)

    try {
        $taskMatches = @(Get-ScheduledTask -TaskName $script:DysonServerTaskName -ErrorAction Stop)
        if ($taskMatches.Count -ne 1) { throw 'The fixed server task is missing or ambiguous.' }
        $task = $taskMatches[0]
        if ([string]$task.TaskPath -ne '\') { throw 'The fixed server task is outside the root task folder.' }
        if ($task.State.ToString() -eq 'Disabled') { throw 'The fixed server task is disabled.' }
        if ($task.Principal.LogonType.ToString() -ne 'Interactive') {
            throw 'The fixed server task is not configured for an interactive token.'
        }
        if ($task.Principal.RunLevel.ToString() -ne 'Limited') {
            throw 'The fixed server task must run with the limited dedicated account token.'
        }
        if ($task.Settings.MultipleInstances.ToString() -ne 'IgnoreNew') {
            throw 'The fixed server task must ignore duplicate start requests.'
        }
        $principalSid = Resolve-DysonAccountSid -AccountName ([string]$task.Principal.UserId)
        if (-not $principalSid -or
            -not [string]::Equals($principalSid, [string]$Account.Sid, [System.StringComparison]::OrdinalIgnoreCase)) {
            throw 'The fixed server task principal does not match the dedicated account.'
        }

        $triggers = @($task.Triggers)
        if ($triggers.Count -ne 1 -or
            [string]$triggers[0].CimClass.CimClassName -notmatch 'TaskLogonTrigger$') {
            throw 'The fixed server task must contain exactly one AtLogOn trigger.'
        }
        if (-not [bool]$triggers[0].Enabled) {
            throw 'The fixed server task AtLogOn trigger is disabled.'
        }
        $triggerSid = Resolve-DysonAccountSid -AccountName ([string]$triggers[0].UserId)
        if (-not $triggerSid -or
            -not [string]::Equals($triggerSid, [string]$Account.Sid, [System.StringComparison]::OrdinalIgnoreCase)) {
            throw 'The fixed server task AtLogOn trigger does not match the dedicated account.'
        }

        $actions = @($task.Actions)
        if ($actions.Count -ne 1) { throw 'The fixed server task must contain exactly one action.' }
        $expectedPowerShell = [System.IO.Path]::GetFullPath(
            (Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe')
        )
        $actualPowerShell = [System.IO.Path]::GetFullPath(
            [Environment]::ExpandEnvironmentVariables([string]$actions[0].Execute)
        )
        if (-not $actualPowerShell.Equals($expectedPowerShell, [System.StringComparison]::OrdinalIgnoreCase)) {
            throw 'The fixed server task executable is not allowlisted.'
        }
        $taskArguments = [string]$actions[0].Arguments
        if ($taskArguments -match '[\r\n\0]') { throw 'The fixed server task arguments are invalid.' }
        $argumentPattern = '(?i)^-NoLogo\s+-NoProfile\s+-NonInteractive\s+-ExecutionPolicy\s+Bypass\s+-File\s+"(?<script>[^"]+)"\s+-ProjectRoot\s+"(?<root>[^"]+)"\s+-Ups\s+(?<ups>\d{1,3})$'
        $definition = [regex]::Match($taskArguments, $argumentPattern)
        if (-not $definition.Success) { throw 'The fixed server task arguments are not allowlisted.' }
        $ups = [int]$definition.Groups['ups'].Value
        if ($ups -lt 5 -or $ups -gt 240) { throw 'The fixed server task UPS is outside the supported range.' }
        $expectedStartScript = (Resolve-Path -LiteralPath (
            Join-Path (Split-Path -Parent $PSScriptRoot) 'Start-DysonServer.ps1'
        ) -ErrorAction Stop).ProviderPath
        $actualStartScript = (Resolve-Path -LiteralPath $definition.Groups['script'].Value -ErrorAction Stop).ProviderPath
        $projectRoot = (Resolve-Path -LiteralPath $definition.Groups['root'].Value -ErrorAction Stop).ProviderPath
        if (-not [string]::Equals(
            $actualStartScript,
            $expectedStartScript,
            [System.StringComparison]::OrdinalIgnoreCase
        )) {
            throw 'The fixed server task does not invoke the installed Start-DysonServer script.'
        }
        foreach ($fixedFile in @(
            $expectedStartScript,
            (Join-Path $projectRoot 'server\DSPGAME.exe')
        )) {
            $item = Get-Item -LiteralPath $fixedFile -Force -ErrorAction Stop
            if ($item.PSIsContainer -or ($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint)) {
                throw 'A fixed server task dependency is unavailable or redirected.'
            }
        }
        return [pscustomobject]@{
            Ready = $true
            Code = 'READY'
            ProjectRoot = $projectRoot
        }
    }
    catch {
        return [pscustomobject]@{
            Ready = $false
            Code = 'SERVER_TASK_INVALID'
            Message = [string]$_.Exception.Message
            ProjectRoot = $null
        }
    }
}

function Test-DysonNativeAutoLogonPolicy {
    $policyPath = 'SOFTWARE\Microsoft\Windows\CurrentVersion\Policies\System'
    $key = [Microsoft.Win32.Registry]::LocalMachine.OpenSubKey($policyPath, $false)
    if (-not $key) {
        return [pscustomobject]@{ Ready = $true; Code = 'READY' }
    }
    try {
        foreach ($name in @('legalnoticecaption', 'legalnoticetext')) {
            $value = $key.GetValue($name, $null)
            if ($null -ne $value -and ([string]$value).Length -gt 0) {
                return [pscustomobject]@{
                    Ready = $false
                    Code = 'LEGAL_NOTICE_BLOCKS_AUTOLOGON'
                    Message = 'A local or Group Policy interactive-logon notice can block Windows automatic logon.'
                }
            }
        }
        return [pscustomobject]@{ Ready = $true; Code = 'READY' }
    }
    finally { $key.Dispose() }
}

function Get-DysonNativeInteractiveSessionProbe {
    param([Parameter(Mandatory)][object]$Account)
    try {
        $sessionIds = @(
            Get-Process -IncludeUserName -ErrorAction Stop |
                Where-Object {
                    $_.SessionId -gt 0 -and
                    [string]::Equals(
                        [string]$_.UserName,
                        [string]$Account.CanonicalName,
                        [System.StringComparison]::OrdinalIgnoreCase
                    )
                } |
                Select-Object -ExpandProperty SessionId -Unique
        )
        return [pscustomobject]@{
            Verifiable = $true
            Present = $sessionIds.Count -gt 0
            SessionCount = $sessionIds.Count
        }
    }
    catch {
        return [pscustomobject]@{
            Verifiable = $false
            Present = $false
            SessionCount = 0
        }
    }
}

function Set-DysonRestrictedBackupAcl {
    param(
        [Parameter(Mandatory)][string]$LiteralPath,
        [Parameter(Mandatory)][bool]$Directory
    )

    $systemSid = [System.Security.Principal.SecurityIdentifier]::new('S-1-5-18')
    $administratorsSid = [System.Security.Principal.SecurityIdentifier]::new('S-1-5-32-544')
    if ($Directory) {
        $security = [System.Security.AccessControl.DirectorySecurity]::new()
        $inheritance = [System.Security.AccessControl.InheritanceFlags]::ContainerInherit -bor
            [System.Security.AccessControl.InheritanceFlags]::ObjectInherit
    }
    else {
        $security = [System.Security.AccessControl.FileSecurity]::new()
        $inheritance = [System.Security.AccessControl.InheritanceFlags]::None
    }
    $security.SetOwner($administratorsSid)
    $security.SetAccessRuleProtection($true, $false)
    foreach ($sid in @($systemSid, $administratorsSid)) {
        $rule = [System.Security.AccessControl.FileSystemAccessRule]::new(
            $sid,
            [System.Security.AccessControl.FileSystemRights]::FullControl,
            $inheritance,
            [System.Security.AccessControl.PropagationFlags]::None,
            [System.Security.AccessControl.AccessControlType]::Allow
        )
        [void]$security.AddAccessRule($rule)
    }
    Set-Acl -LiteralPath $LiteralPath -AclObject $security
}

function Test-DysonRestrictedBackupAcl {
    param([Parameter(Mandatory)][string]$LiteralPath)
    try {
        $acl = Get-Acl -LiteralPath $LiteralPath -ErrorAction Stop
        if (-not $acl.AreAccessRulesProtected) { return $false }
        $allowedSids = @('S-1-5-18', 'S-1-5-32-544')
        $seen = @{}
        foreach ($rule in @($acl.Access)) {
            $sid = $rule.IdentityReference.Translate(
                [System.Security.Principal.SecurityIdentifier]
            ).Value
            if ($rule.AccessControlType -ne [System.Security.AccessControl.AccessControlType]::Allow -or
                $sid -notin $allowedSids) {
                return $false
            }
            $seen[$sid] = $true
        }
        return $seen.ContainsKey('S-1-5-18') -and $seen.ContainsKey('S-1-5-32-544')
    }
    catch { return $false }
}

function New-DysonNativeSessionContext {
    Add-DysonSessionNativeTypes
    $backupRoot = Join-Path (
        [Environment]::GetFolderPath([Environment+SpecialFolder]::CommonApplicationData)
    ) 'DysonControl\session-backups'
    return [pscustomobject]@{
        Mode = 'native'
        Registry = New-DysonNativeRegistryAdapter
        Lsa = New-DysonNativeLsaAdapter
        BackupRoot = $backupRoot
        ResolveAccount = { param([string]$Name) Resolve-DysonNativeLocalAccount -UserName $Name }
        ValidateCredential = {
            param([object]$Account, [System.Security.SecureString]$Password)
            Test-DysonNativeInteractiveCredential -Account $Account -Password $Password
        }
        ValidateTask = { param([object]$Account) Test-DysonNativeServerTask -Account $Account }
        ValidatePolicy = { Test-DysonNativeAutoLogonPolicy }
        ProbeSession = { param([object]$Account) Get-DysonNativeInteractiveSessionProbe -Account $Account }
        ApplyAcl = {
            param([string]$Path, [bool]$Directory)
            Set-DysonRestrictedBackupAcl -LiteralPath $Path -Directory $Directory
        }
        ValidateAcl = { param([string]$Path) Test-DysonRestrictedBackupAcl -LiteralPath $Path }
        Now = { (Get-Date).ToUniversalTime().ToString('o') }
        NewId = { [guid]::NewGuid().ToString('D') }
    }
}

function Get-DysonRegistryValue {
    param(
        [Parameter(Mandatory)][object]$Context,
        [Parameter(Mandatory)][ValidatePattern('^[A-Za-z][A-Za-z0-9]{0,63}$')][string]$Name
    )
    $operation = $Context.Registry.GetValue
    return & $operation $Name
}

function Set-DysonRegistryValue {
    param(
        [Parameter(Mandatory)][object]$Context,
        [Parameter(Mandatory)][ValidatePattern('^[A-Za-z][A-Za-z0-9]{0,63}$')][string]$Name,
        [Parameter(Mandatory)][ValidateSet('String', 'ExpandString', 'DWord', 'QWord')][string]$Kind,
        [Parameter(Mandatory)][AllowEmptyString()][object]$Value
    )
    $operation = $Context.Registry.SetValue
    & $operation $Name $Kind $Value
}

function Remove-DysonRegistryValue {
    param(
        [Parameter(Mandatory)][object]$Context,
        [Parameter(Mandatory)][ValidatePattern('^[A-Za-z][A-Za-z0-9]{0,63}$')][string]$Name
    )
    $operation = $Context.Registry.RemoveValue
    & $operation $Name
}

function Get-DysonLsaSecret {
    param(
        [Parameter(Mandatory)][object]$Context,
        [Parameter(Mandatory)][string]$Name
    )
    $operation = $Context.Lsa.GetSecret
    return & $operation $Name
}

function Set-DysonLsaSecret {
    param(
        [Parameter(Mandatory)][object]$Context,
        [Parameter(Mandatory)][string]$Name,
        [Parameter(Mandatory)][System.Security.SecureString]$Secret
    )
    $operation = $Context.Lsa.SetSecret
    & $operation $Name $Secret
}

function Remove-DysonLsaSecret {
    param(
        [Parameter(Mandatory)][object]$Context,
        [Parameter(Mandatory)][string]$Name
    )
    $operation = $Context.Lsa.RemoveSecret
    & $operation $Name
}

function Get-DysonSessionRegistrySnapshot {
    param([Parameter(Mandatory)][object]$Context)
    $snapshot = @()
    foreach ($name in $script:DysonManagedRegistryValueNames) {
        $entry = Get-DysonRegistryValue -Context $Context -Name $name
        if ($entry.Exists -and $entry.Kind -notin @('String', 'ExpandString', 'DWord', 'QWord')) {
            throw "The existing $name registry value uses an unsupported kind."
        }
        $snapshot += [ordered]@{
            name = $name
            exists = [bool]$entry.Exists
            kind = if ($entry.Exists) { [string]$entry.Kind } else { $null }
            value = if ($entry.Exists) { $entry.Value } else { $null }
        }
    }
    return @($snapshot)
}

function Test-DysonSessionRegistrySnapshot {
    param([Parameter(Mandatory)][object[]]$Snapshot)
    $requiredEntryProperties = @('name', 'exists', 'kind', 'value')
    $names = @($Snapshot | ForEach-Object { [string]$_.name })
    if ($names.Count -ne $script:DysonManagedRegistryValueNames.Count) { return $false }
    foreach ($requiredName in $script:DysonManagedRegistryValueNames) {
        if (@($names | Where-Object { $_ -eq $requiredName }).Count -ne 1) { return $false }
    }
    foreach ($entry in $Snapshot) {
        $entryProperties = if ($entry -is [System.Collections.IDictionary]) {
            @($entry.Keys | ForEach-Object { [string]$_ })
        }
        else {
            @($entry.PSObject.Properties | ForEach-Object { [string]$_.Name })
        }
        if ($entryProperties.Count -ne $requiredEntryProperties.Count -or
            @($requiredEntryProperties | Where-Object { $_ -notin $entryProperties }).Count -gt 0) {
            return $false
        }
        if ($entry.exists -isnot [bool]) { return $false }
        if ([bool]$entry.exists -and [string]$entry.kind -notin @('String', 'ExpandString', 'DWord', 'QWord')) {
            return $false
        }
        if (-not [bool]$entry.exists -and ($null -ne $entry.kind -or $null -ne $entry.value)) {
            return $false
        }
    }
    return $true
}

function Restore-DysonSessionRegistrySnapshot {
    param(
        [Parameter(Mandatory)][object]$Context,
        [Parameter(Mandatory)][object[]]$Snapshot
    )
    if (-not (Test-DysonSessionRegistrySnapshot -Snapshot $Snapshot)) {
        throw 'The session backup registry snapshot is incomplete or invalid.'
    }
    Set-DysonRegistryValue -Context $Context -Name 'AutoAdminLogon' -Kind 'String' -Value '0'
    Set-DysonRegistryValue -Context $Context -Name 'ForceAutoLogon' -Kind 'String' -Value '0'
    foreach ($entry in $Snapshot) {
        if ([bool]$entry.exists) {
            Set-DysonRegistryValue -Context $Context -Name ([string]$entry.name) -Kind ([string]$entry.kind) -Value $entry.value
        }
        else {
            Remove-DysonRegistryValue -Context $Context -Name ([string]$entry.name)
        }
    }
    Remove-DysonRegistryValue -Context $Context -Name 'DefaultPassword'
}

function Get-DysonActiveBackupPath {
    param([Parameter(Mandatory)][object]$Context)
    return Join-Path ([string]$Context.BackupRoot) 'active.json'
}

function Assert-DysonBackupMetadata {
    param([Parameter(Mandatory)][object]$Metadata)
    $requiredProperties = @(
        'protocol',
        'state',
        'backupId',
        'accountSid',
        'accountName',
        'createdAt',
        'interactiveLogonValidatedAt',
        'previousDefaultPasswordPresent',
        'backupSecretName',
        'registry'
    )
    $properties = if ($Metadata -is [System.Collections.IDictionary]) {
        @($Metadata.Keys | ForEach-Object { [string]$_ })
    }
    else {
        @($Metadata.PSObject.Properties | ForEach-Object { [string]$_.Name })
    }
    if ($properties.Count -ne $requiredProperties.Count -or
        @($requiredProperties | Where-Object { $_ -notin $properties }).Count -gt 0) {
        throw 'The interactive-session backup schema is invalid.'
    }
    if ([string]$Metadata.protocol -ne $script:DysonBackupProtocol) {
        throw 'The interactive-session backup protocol is invalid.'
    }
    if ([string]$Metadata.state -notin @('active', 'restoring-complete', 'restored')) {
        throw 'The interactive-session backup state is invalid.'
    }
    $backupId = [guid]::Empty
    if (-not [guid]::TryParseExact([string]$Metadata.backupId, 'D', [ref]$backupId)) {
        throw 'The interactive-session backup ID is invalid.'
    }
    if ([string]$Metadata.accountSid -notmatch '^S-1-5-21-(\d+-){3}\d+$' -or
        [string]$Metadata.accountName -match '[\r\n\0]' -or
        [string]::IsNullOrWhiteSpace([string]$Metadata.accountName)) {
        throw 'The interactive-session backup account identity is invalid.'
    }
    $expectedBackupSecretName = 'DysonControlAutoLogonBackup-' + $backupId.ToString('N')
    if (-not [string]::Equals(
        [string]$Metadata.backupSecretName,
        $expectedBackupSecretName,
        [System.StringComparison]::Ordinal
    )) {
        throw 'The interactive-session backup secret reference is invalid.'
    }
    if ($Metadata.previousDefaultPasswordPresent -isnot [bool]) {
        throw 'The interactive-session backup secret-presence flag is invalid.'
    }
    try {
        [void][datetimeoffset]::Parse([string]$Metadata.createdAt)
        [void][datetimeoffset]::Parse([string]$Metadata.interactiveLogonValidatedAt)
    }
    catch {
        throw 'The interactive-session backup timestamps are invalid.'
    }
    if (-not (Test-DysonSessionRegistrySnapshot -Snapshot @($Metadata.registry))) {
        throw 'The interactive-session backup registry snapshot is invalid.'
    }
}

function Read-DysonBackupMetadata {
    param([Parameter(Mandatory)][object]$Context)
    $path = Get-DysonActiveBackupPath -Context $Context
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { return $null }
    $validateAcl = $Context.ValidateAcl
    if (-not (& $validateAcl $path)) {
        throw 'The interactive-session backup ACL is not restricted to SYSTEM and Administrators.'
    }
    $item = Get-Item -LiteralPath $path -Force -ErrorAction Stop
    if ($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) {
        throw 'The interactive-session backup is redirected.'
    }
    $metadata = Get-Content -LiteralPath $path -Raw -ErrorAction Stop | ConvertFrom-Json -ErrorAction Stop
    Assert-DysonBackupMetadata -Metadata $metadata
    return $metadata
}

function Write-DysonBackupMetadata {
    param(
        [Parameter(Mandatory)][object]$Context,
        [Parameter(Mandatory)][object]$Metadata
    )
    Assert-DysonBackupMetadata -Metadata $Metadata
    $root = [string]$Context.BackupRoot
    [System.IO.Directory]::CreateDirectory($root) | Out-Null
    $rootItem = Get-Item -LiteralPath $root -Force -ErrorAction Stop
    if (-not $rootItem.PSIsContainer -or
        ($rootItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint)) {
        throw 'The fixed interactive-session backup root is unavailable or redirected.'
    }
    $applyAcl = $Context.ApplyAcl
    & $applyAcl $root $true
    $validateAcl = $Context.ValidateAcl
    if (-not (& $validateAcl $root)) {
        throw 'The fixed interactive-session backup root ACL could not be restricted.'
    }
    $path = Get-DysonActiveBackupPath -Context $Context
    $temporaryPath = Join-Path $root ('.partial-' + [guid]::NewGuid().ToString('N'))
    $replacementBackupPath = Join-Path $root ('.replaced-' + [guid]::NewGuid().ToString('N'))
    $payload = $Metadata | ConvertTo-Json -Depth 8
    try {
        [System.IO.File]::WriteAllText($temporaryPath, $payload, [System.Text.UTF8Encoding]::new($false))
        & $applyAcl $temporaryPath $false
        if (Test-Path -LiteralPath $path -PathType Leaf) {
            [System.IO.File]::Replace($temporaryPath, $path, $replacementBackupPath)
            if (Test-Path -LiteralPath $replacementBackupPath) {
                Remove-Item -LiteralPath $replacementBackupPath -Force
            }
        }
        else {
            [System.IO.File]::Move($temporaryPath, $path)
        }
        & $applyAcl $path $false
        if (-not (& $validateAcl $path)) {
            throw 'The interactive-session backup file ACL could not be restricted.'
        }
    }
    finally {
        if (Test-Path -LiteralPath $temporaryPath) {
            Remove-Item -LiteralPath $temporaryPath -Force
        }
        if (Test-Path -LiteralPath $replacementBackupPath) {
            Remove-Item -LiteralPath $replacementBackupPath -Force
        }
    }
}

function Remove-DysonActiveBackup {
    param([Parameter(Mandatory)][object]$Context)
    $path = Get-DysonActiveBackupPath -Context $Context
    if (Test-Path -LiteralPath $path -PathType Leaf) {
        Remove-Item -LiteralPath $path -Force
    }
}

function Move-DysonBackupToArchive {
    param(
        [Parameter(Mandatory)][object]$Context,
        [Parameter(Mandatory)][object]$Metadata
    )
    $path = Get-DysonActiveBackupPath -Context $Context
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { return }
    $archivePath = Join-Path ([string]$Context.BackupRoot) ('restored-' + ([guid]$Metadata.backupId).ToString('N') + '.json')
    if (Test-Path -LiteralPath $archivePath) {
        Remove-Item -LiteralPath $path -Force
        return
    }
    [System.IO.File]::Move($path, $archivePath)
    $applyAcl = $Context.ApplyAcl
    & $applyAcl $archivePath $false
}

function New-DysonSessionBackupMetadata {
    param(
        [Parameter(Mandatory)][object]$Context,
        [Parameter(Mandatory)][object]$Account,
        [Parameter(Mandatory)][object[]]$RegistrySnapshot,
        [Parameter(Mandatory)][bool]$PreviousSecretPresent,
        [Parameter(Mandatory)][string]$BackupId
    )
    $now = $Context.Now
    $timestamp = [string](& $now)
    return [ordered]@{
        protocol = $script:DysonBackupProtocol
        state = 'active'
        backupId = $BackupId
        accountSid = [string]$Account.Sid
        accountName = [string]$Account.CanonicalName
        createdAt = $timestamp
        interactiveLogonValidatedAt = $timestamp
        previousDefaultPasswordPresent = $PreviousSecretPresent
        backupSecretName = 'DysonControlAutoLogonBackup-' + ([guid]$BackupId).ToString('N')
        registry = @($RegistrySnapshot)
    }
}

function Test-DysonRegistryStringEquals {
    param(
        [Parameter(Mandatory)][object]$Context,
        [Parameter(Mandatory)][string]$Name,
        [Parameter(Mandatory)][string]$Expected
    )
    $value = Get-DysonRegistryValue -Context $Context -Name $Name
    return $value.Exists -and [string]::Equals([string]$value.Value, $Expected, [System.StringComparison]::OrdinalIgnoreCase)
}

function Assert-DysonNoPlaintextWinlogonPassword {
    param([Parameter(Mandatory)][object]$Context)
    $plainRegistrySecret = Get-DysonRegistryValue -Context $Context -Name 'DefaultPassword'
    if ($plainRegistrySecret.Exists) {
        throw 'A plaintext Winlogon DefaultPassword registry value exists; remove it before enabling the LSA-backed configuration.'
    }
}

function Restore-DysonLsaSecretState {
    param(
        [Parameter(Mandatory)][object]$Context,
        [Parameter(Mandatory)][AllowNull()][System.Security.SecureString]$Secret
    )
    if ($Secret) {
        Set-DysonLsaSecret -Context $Context -Name $script:DysonDefaultPasswordSecretName -Secret $Secret
    }
    else {
        Remove-DysonLsaSecret -Context $Context -Name $script:DysonDefaultPasswordSecretName
    }
}

function Invoke-DysonConfigureInteractiveSession {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][System.Management.Automation.PSCredential]$Credential,
        [Parameter(Mandatory)][object]$Context,
        [Parameter(Mandatory)][bool]$Apply
    )

    if ($Credential.Password.Length -lt 1) {
        throw 'The dedicated account password cannot be empty.'
    }
    $resolveAccount = $Context.ResolveAccount
    $account = & $resolveAccount $Credential.UserName
    $validateCredential = $Context.ValidateCredential
    if (-not (& $validateCredential $account $Credential.Password)) {
        throw 'The dedicated account did not pass interactive local-logon validation.'
    }
    $validateTask = $Context.ValidateTask
    $task = & $validateTask $account
    if (-not $task.Ready) { throw ([string]$task.Message) }
    $validatePolicy = $Context.ValidatePolicy
    $policy = & $validatePolicy
    if (-not $policy.Ready) { throw ([string]$policy.Message) }
    Assert-DysonNoPlaintextWinlogonPassword -Context $Context

    $metadata = Read-DysonBackupMetadata -Context $Context
    if ($metadata) {
        if ([string]$metadata.state -ne 'active') {
            throw 'A previous interactive-session disable operation requires cleanup before reconfiguration.'
        }
        if (-not [string]::Equals(
            [string]$metadata.accountSid,
            [string]$account.Sid,
            [System.StringComparison]::OrdinalIgnoreCase
        )) {
            throw 'An active interactive-session rollback belongs to a different account.'
        }
    }
    if (-not $Apply) {
        return [pscustomobject]@{
            protocol = $script:DysonSessionProtocol
            state = 'preview'
            account = [string]$account.CanonicalName
            interactiveLogonValidated = $true
            serverTaskValidated = $true
            credentialStorage = 'lsa-private-data'
            credentialProtectionBoundary = 'local-administrators-can-retrieve'
            wouldCreateRollbackBackup = -not [bool]$metadata
            rebootPerformed = $false
            logonPerformed = $false
            logoffPerformed = $false
            gameStarted = $false
        }
    }

    $transientRegistry = @(Get-DysonSessionRegistrySnapshot -Context $Context)
    $transientSecret = Get-DysonLsaSecret -Context $Context -Name $script:DysonDefaultPasswordSecretName
    $createdBackup = $false
    $createdBackupSecretName = $null
    try {
        if (-not $metadata) {
            $newId = $Context.NewId
            $backupId = [string](& $newId)
            $metadata = New-DysonSessionBackupMetadata -Context $Context -Account $account -RegistrySnapshot $transientRegistry -PreviousSecretPresent ([bool]$transientSecret) -BackupId $backupId
            $createdBackupSecretName = [string]$metadata.backupSecretName
            $createdBackup = $true
            if ($transientSecret) {
                Set-DysonLsaSecret -Context $Context -Name $createdBackupSecretName -Secret $transientSecret
            }
            Write-DysonBackupMetadata -Context $Context -Metadata $metadata
        }

        Set-DysonRegistryValue -Context $Context -Name 'AutoAdminLogon' -Kind 'String' -Value '0'
        Set-DysonRegistryValue -Context $Context -Name 'ForceAutoLogon' -Kind 'String' -Value '0'
        Set-DysonRegistryValue -Context $Context -Name 'DefaultUserName' -Kind 'String' -Value ([string]$account.LocalName)
        Set-DysonRegistryValue -Context $Context -Name 'DefaultDomainName' -Kind 'String' -Value ([string]$account.Domain)
        Remove-DysonRegistryValue -Context $Context -Name 'AutoLogonCount'
        Remove-DysonRegistryValue -Context $Context -Name 'DefaultPassword'
        Set-DysonLsaSecret -Context $Context -Name $script:DysonDefaultPasswordSecretName -Secret $Credential.Password
        Set-DysonRegistryValue -Context $Context -Name 'ForceAutoLogon' -Kind 'String' -Value '1'
        Set-DysonRegistryValue -Context $Context -Name 'AutoAdminLogon' -Kind 'String' -Value '1'

        $configuredSecret = Get-DysonLsaSecret -Context $Context -Name $script:DysonDefaultPasswordSecretName
        try {
            if (-not $configuredSecret -or
                -not (Test-DysonRegistryStringEquals -Context $Context -Name 'DefaultUserName' -Expected $account.LocalName) -or
                -not (Test-DysonRegistryStringEquals -Context $Context -Name 'DefaultDomainName' -Expected $account.Domain) -or
                -not (Test-DysonRegistryStringEquals -Context $Context -Name 'AutoAdminLogon' -Expected '1') -or
                -not (Test-DysonRegistryStringEquals -Context $Context -Name 'ForceAutoLogon' -Expected '1')) {
                throw 'The LSA-backed automatic interactive session did not pass post-write verification.'
            }
            Assert-DysonNoPlaintextWinlogonPassword -Context $Context
        }
        finally {
            if ($configuredSecret) { $configuredSecret.Dispose() }
        }
    }
    catch {
        $configurationError = $_
        try {
            Restore-DysonSessionRegistrySnapshot -Context $Context -Snapshot $transientRegistry
            Restore-DysonLsaSecretState -Context $Context -Secret $transientSecret
            if ($createdBackup) {
                if ($createdBackupSecretName) {
                    Remove-DysonLsaSecret -Context $Context -Name $createdBackupSecretName
                }
                Remove-DysonActiveBackup -Context $Context
            }
        }
        catch {
            throw 'Interactive-session configuration failed and automatic rollback also failed; manual recovery is required.'
        }
        throw $configurationError
    }
    finally {
        if ($transientSecret) { $transientSecret.Dispose() }
    }

    return [pscustomobject]@{
        protocol = $script:DysonSessionProtocol
        state = 'configured'
        account = [string]$account.CanonicalName
        interactiveLogonValidated = $true
        serverTaskValidated = $true
        credentialStorage = 'lsa-private-data'
        credentialProtectionBoundary = 'local-administrators-can-retrieve'
        rollbackBackupCreated = $createdBackup
        rollbackBackupReused = -not $createdBackup
        rebootPerformed = $false
        logonPerformed = $false
        logoffPerformed = $false
        activation = 'next-boot-or-explicit-user-logon'
        realBootValidationRequired = $true
        gameStarted = $false
    }
}

function Get-DysonInteractiveSessionConfiguration {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][object]$Context,
        [System.Management.Automation.PSCredential]$Credential
    )

    $metadata = Read-DysonBackupMetadata -Context $Context
    if (-not $metadata) {
        return [pscustomobject]@{
            protocol = $script:DysonSessionProtocol
            state = 'disabled'
            ready = $false
            checks = @([pscustomobject]@{ id = 'rollback-backup'; status = 'not-configured' })
            rebootPerformed = $false
            logonPerformed = $false
            logoffPerformed = $false
            gameStarted = $false
        }
    }

    $resolveAccount = $Context.ResolveAccount
    $account = & $resolveAccount ([string]$metadata.accountName)
    if (-not [string]::Equals(
        [string]$account.Sid,
        [string]$metadata.accountSid,
        [System.StringComparison]::OrdinalIgnoreCase
    )) {
        throw 'The configured interactive-session account no longer resolves to the backed-up SID.'
    }
    $taskValidator = $Context.ValidateTask
    $task = & $taskValidator $account
    $policyValidator = $Context.ValidatePolicy
    $policy = & $policyValidator
    $sessionProber = $Context.ProbeSession
    $sessionProbe = & $sessionProber $account
    $credentialStatus = 'validated-during-configure'
    if ($Credential) {
        $credentialAccount = & $resolveAccount $Credential.UserName
        if (-not [string]::Equals(
            [string]$credentialAccount.Sid,
            [string]$account.Sid,
            [System.StringComparison]::OrdinalIgnoreCase
        )) {
            throw 'The supplied test credential does not belong to the configured dedicated account.'
        }
        $validateCredential = $Context.ValidateCredential
        if (-not (& $validateCredential $account $Credential.Password)) {
            throw 'The dedicated account no longer passes interactive local-logon validation.'
        }
        $credentialStatus = 'validated-now'
    }

    $secret = Get-DysonLsaSecret -Context $Context -Name $script:DysonDefaultPasswordSecretName
    try {
        $plainRegistrySecret = Get-DysonRegistryValue -Context $Context -Name 'DefaultPassword'
        $checks = @(
            [pscustomobject]@{
                id = 'backup-state'
                status = if ([string]$metadata.state -eq 'active') { 'pass' } else { 'block' }
            },
            [pscustomobject]@{
                id = 'exact-account'
                status = if (
                    (Test-DysonRegistryStringEquals -Context $Context -Name 'DefaultUserName' -Expected $account.LocalName) -and
                    (Test-DysonRegistryStringEquals -Context $Context -Name 'DefaultDomainName' -Expected $account.Domain)
                ) { 'pass' } else { 'block' }
            },
            [pscustomobject]@{
                id = 'auto-logon-flags'
                status = if (
                    (Test-DysonRegistryStringEquals -Context $Context -Name 'AutoAdminLogon' -Expected '1') -and
                    (Test-DysonRegistryStringEquals -Context $Context -Name 'ForceAutoLogon' -Expected '1')
                ) { 'pass' } else { 'block' }
            },
            [pscustomobject]@{
                id = 'lsa-private-data'
                status = if ($secret -and -not $plainRegistrySecret.Exists) { 'pass' } else { 'block' }
            },
            [pscustomobject]@{
                id = 'interactive-local-logon'
                status = 'pass'
                evidence = $credentialStatus
            },
            [pscustomobject]@{
                id = 'server-task'
                status = if ($task.Ready) { 'pass' } else { 'block' }
            },
            [pscustomobject]@{
                id = 'autologon-policy'
                status = if ($policy.Ready) { 'pass' } else { 'block' }
            },
            [pscustomobject]@{
                id = 'interactive-session'
                status = if ($sessionProbe.Present) { 'pass' } else { 'warning' }
            }
        )
        $ready = @($checks | Where-Object { $_.status -eq 'block' }).Count -eq 0
        return [pscustomobject]@{
            protocol = $script:DysonSessionProtocol
            state = if ($ready) { 'ready' } else { 'blocked' }
            ready = $ready
            account = [string]$account.CanonicalName
            interactiveLogonValidation = $credentialStatus
            interactiveLogonValidatedAt = [string]$metadata.interactiveLogonValidatedAt
            credentialStorage = 'lsa-private-data'
            credentialProtectionBoundary = 'local-administrators-can-retrieve'
            interactiveSessionPresent = [bool]$sessionProbe.Present
            interactiveSessionEvidenceVerifiable = [bool]$sessionProbe.Verifiable
            checks = $checks
            rebootPerformed = $false
            logonPerformed = $false
            logoffPerformed = $false
            realBootValidationRequired = -not [bool]$sessionProbe.Present
            gameStarted = $false
        }
    }
    finally {
        if ($secret) { $secret.Dispose() }
    }
}

function Invoke-DysonDisableInteractiveSession {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][object]$Context,
        [Parameter(Mandatory)][bool]$Apply
    )

    $metadata = Read-DysonBackupMetadata -Context $Context
    if (-not $metadata) {
        return [pscustomobject]@{
            protocol = $script:DysonSessionProtocol
            state = 'already-disabled'
            rollbackRestored = $false
            rebootPerformed = $false
            logonPerformed = $false
            logoffPerformed = $false
            gameStarted = $false
        }
    }
    if (-not $Apply) {
        return [pscustomobject]@{
            protocol = $script:DysonSessionProtocol
            state = 'preview-disable'
            account = [string]$metadata.accountName
            rollbackAvailable = $true
            rebootPerformed = $false
            logonPerformed = $false
            logoffPerformed = $false
            gameStarted = $false
        }
    }

    if ([string]$metadata.state -eq 'active') {
        $currentRegistry = @(Get-DysonSessionRegistrySnapshot -Context $Context)
        $currentSecret = Get-DysonLsaSecret -Context $Context -Name $script:DysonDefaultPasswordSecretName
        $previousSecret = $null
        try {
            if ([bool]$metadata.previousDefaultPasswordPresent) {
                $previousSecret = Get-DysonLsaSecret -Context $Context -Name ([string]$metadata.backupSecretName)
                if (-not $previousSecret) {
                    throw 'The protected previous Winlogon secret is missing; rollback is blocked.'
                }
            }
            Restore-DysonLsaSecretState -Context $Context -Secret $previousSecret
            Restore-DysonSessionRegistrySnapshot -Context $Context -Snapshot @($metadata.registry)
            $metadata.state = 'restoring-complete'
            Write-DysonBackupMetadata -Context $Context -Metadata $metadata
        }
        catch {
            $disableError = $_
            try {
                Restore-DysonLsaSecretState -Context $Context -Secret $currentSecret
                Restore-DysonSessionRegistrySnapshot -Context $Context -Snapshot $currentRegistry
            }
            catch {
                throw 'Interactive-session disable failed and the configured state could not be restored.'
            }
            throw $disableError
        }
        finally {
            if ($previousSecret) { $previousSecret.Dispose() }
            if ($currentSecret) { $currentSecret.Dispose() }
        }
    }

    if ([string]$metadata.state -eq 'restoring-complete') {
        Remove-DysonLsaSecret -Context $Context -Name ([string]$metadata.backupSecretName)
        $metadata.state = 'restored'
        Write-DysonBackupMetadata -Context $Context -Metadata $metadata
    }
    if ([string]$metadata.state -eq 'restored') {
        Move-DysonBackupToArchive -Context $Context -Metadata $metadata
    }

    return [pscustomobject]@{
        protocol = $script:DysonSessionProtocol
        state = 'disabled'
        account = [string]$metadata.accountName
        rollbackRestored = $true
        lsaBackupSecretRemoved = $true
        rebootPerformed = $false
        logonPerformed = $false
        logoffPerformed = $false
        gameStarted = $false
    }
}
