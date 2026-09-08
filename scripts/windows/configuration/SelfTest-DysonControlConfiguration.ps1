[CmdletBinding()]
param(
    [switch]$RequireAclIntegration
)

Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'DysonConfiguration.Common.ps1')

$script:TestCount = 0
$script:SecretSentinel = 'fictional-' + 'configuration-sentinel-' + ('x' * 40)
$script:Utf8 = [System.Text.UTF8Encoding]::new($false, $true)

function Assert-SelfTest {
    param([bool]$Condition, [Parameter(Mandatory)][string]$Name)
    if (-not $Condition) { throw ('DYSON_CONFIGURATION_SELFTEST_FAILED_' + $Name) }
    $script:TestCount += 1
}

function Assert-SelfTestRejected {
    param(
        [Parameter(Mandatory)][scriptblock]$Action,
        [Parameter(Mandatory)][string]$Name,
        [string]$Expected = '*'
    )
    try { & $Action | Out-Null }
    catch {
        $message = [string]$_.Exception.Message
        if ($message.Contains($script:SecretSentinel)) {
            throw 'DYSON_CONFIGURATION_SELFTEST_SECRET_DISCLOSURE'
        }
        if ($Expected -ne '*' -and $message -notlike $Expected) {
            throw ('DYSON_CONFIGURATION_SELFTEST_WRONG_REJECTION_' + $Name)
        }
        $script:TestCount += 1
        return
    }
    throw ('DYSON_CONFIGURATION_SELFTEST_EXPECTED_REJECTION_' + $Name)
}

function ConvertTo-TestBytes {
    param([Parameter(Mandatory)][AllowEmptyString()][string]$Text)
    return $script:Utf8.GetBytes($Text)
}

function Wait-SelfTestFileLines {
    param(
        [Parameter(Mandatory)][string]$Path,
        [ValidateRange(1, 10)][int]$MinimumCount,
        [ValidateRange(1, 30)][int]$TimeoutSeconds = 10
    )

    $deadline = [datetime]::UtcNow.AddSeconds($TimeoutSeconds)
    do {
        if (Test-Path -LiteralPath $Path -PathType Leaf) {
            try {
                $lines = @([System.IO.File]::ReadAllLines($Path))
                if ($lines.Count -ge $MinimumCount) { return $lines }
            }
            catch [System.IO.IOException] { }
        }
        Start-Sleep -Milliseconds 20
    } while ([datetime]::UtcNow -lt $deadline)
    throw 'DYSON_CONFIGURATION_SELFTEST_WORKER_TIMEOUT'
}

function Get-SelfTestPowerShellAst {
    param([Parameter(Mandatory)][string]$Path)

    $tokens = $null
    $errors = $null
    $ast = [System.Management.Automation.Language.Parser]::ParseFile(
        (Get-Item -LiteralPath $Path -Force -ErrorAction Stop).FullName,
        [ref]$tokens, [ref]$errors
    )
    if (@($errors).Count -ne 0) { throw 'DYSON_CONFIGURATION_SELFTEST_AST_INVALID' }
    return $ast
}

function Test-SelfTestAstFunction {
    param(
        [Parameter(Mandatory)]$Ast,
        [Parameter(Mandatory)][string]$Name
    )
    return @($Ast.FindAll({
        param($node)
        $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and
            [string]$node.Name -ceq $Name
    }, $true)).Count -eq 1
}

function Test-SelfTestAstCommand {
    param(
        [Parameter(Mandatory)]$Ast,
        [Parameter(Mandatory)][string]$Name
    )
    return @($Ast.FindAll({
        param($node)
        $node -is [System.Management.Automation.Language.CommandAst] -and
            [string]$node.GetCommandName() -ceq $Name
    }, $true)).Count -gt 0
}

function Test-SelfTestAstParameter {
    param(
        [Parameter(Mandatory)]$Ast,
        [Parameter(Mandatory)][string]$Name
    )
    if ($null -eq $Ast.ParamBlock) { return $false }
    return @($Ast.ParamBlock.Parameters | Where-Object {
        [string]$_.Name.VariablePath.UserPath -ceq $Name
    }).Count -eq 1
}

function Test-SelfTestAstSupportsShouldProcess {
    param([Parameter(Mandatory)]$Ast)
    if ($null -eq $Ast.ParamBlock) { return $false }
    foreach ($attribute in @($Ast.ParamBlock.Attributes)) {
        if ([string]$attribute.TypeName.FullName -cne 'CmdletBinding') { continue }
        foreach ($argument in @($attribute.NamedArguments)) {
            if ([string]$argument.ArgumentName -ceq 'SupportsShouldProcess' -and
                [string]$argument.Argument.Extent.Text -ceq '$true') { return $true }
        }
    }
    return $false
}

function Test-SelfTestAstCommandLiteralArgument {
    param(
        [Parameter(Mandatory)]$Ast,
        [Parameter(Mandatory)][string]$CommandName,
        [Parameter(Mandatory)][string]$ParameterName,
        [Parameter(Mandatory)][string]$ExpectedValue
    )
    foreach ($command in @($Ast.FindAll({
                param($node)
                $node -is [System.Management.Automation.Language.CommandAst] -and
                    [string]$node.GetCommandName() -ceq $CommandName
            }, $true))) {
        $elements = @($command.CommandElements)
        for ($index = 0; $index -lt $elements.Count; $index += 1) {
            $element = $elements[$index]
            if ($element -isnot [System.Management.Automation.Language.CommandParameterAst] -or
                [string]$element.ParameterName -cne $ParameterName) { continue }
            $argument = $element.Argument
            if ($null -eq $argument -and $index + 1 -lt $elements.Count) {
                $argument = $elements[$index + 1]
            }
            if ($argument -is [System.Management.Automation.Language.StringConstantExpressionAst] -and
                [string]$argument.Value -ceq $ExpectedValue) { return $true }
        }
    }
    return $false
}

function Test-SelfTestAstCommandParameter {
    param(
        [Parameter(Mandatory)]$Ast,
        [Parameter(Mandatory)][string]$CommandName,
        [Parameter(Mandatory)][string]$ParameterName
    )
    foreach ($command in @($Ast.FindAll({
                param($node)
                $node -is [System.Management.Automation.Language.CommandAst] -and
                    [string]$node.GetCommandName() -ceq $CommandName
            }, $true))) {
        if (@($command.CommandElements | Where-Object {
                    $_ -is [System.Management.Automation.Language.CommandParameterAst] -and
                        [string]$_.ParameterName -ceq $ParameterName
                }).Count -gt 0) { return $true }
    }
    return $false
}

function Test-SelfTestAstStaticMemberInvocation {
    param(
        [Parameter(Mandatory)]$Ast,
        [Parameter(Mandatory)][string]$TypeName,
        [Parameter(Mandatory)][string]$MemberName
    )
    return @($Ast.FindAll({
        param($node)
        $node -is [System.Management.Automation.Language.InvokeMemberExpressionAst] -and
            [string]$node.Expression.Extent.Text -ceq ('[' + $TypeName + ']') -and
            [string]$node.Member.Value -ceq $MemberName
    }, $true)).Count -gt 0
}

function New-TestEnvironmentText {
    param([Parameter(Mandatory)][hashtable]$Bindings)
    return [string]::Join("`n", @(
        ('NODE_ENV=' + [string]$Bindings['NODE_ENV']),
        ('DYSON_HOST=' + [string]$Bindings['DYSON_HOST']),
        ('DYSON_DATA_DIR=' + [string]$Bindings['DYSON_DATA_DIR']),
        ('DYSON_SCRIPT_ROOT=' + [string]$Bindings['DYSON_SCRIPT_ROOT']),
        ('DYSON_RUNTIME_BOOTSTRAP_ROOT=' + [string]$Bindings['DYSON_RUNTIME_BOOTSTRAP_ROOT']),
        ('DYSON_DEPLOYMENT_VERSION=' + [string]$Bindings['DYSON_DEPLOYMENT_VERSION']),
        'DYSON_PROVIDER=windows',
        'DYSON_PORT=13010',
        'DYSON_PLAYER_NOTICE_MUTATIONS_ENABLED=false',
        'DYSON_ADMIN_PASSWORD_HASH=scrypt$16384$8$1$fictional$fixture',
        ('DYSON_SESSION_SECRET=' + $script:SecretSentinel)
    )) + "`n"
}

function New-TestFixture {
    param([Parameter(Mandatory)][string]$Name)

    $dataRoot = Join-Path $script:TestRoot $Name
    $dataDirectory = Join-Path $dataRoot 'data'
    [void][System.IO.Directory]::CreateDirectory($dataRoot)
    [void][System.IO.Directory]::CreateDirectory($dataDirectory)
    Set-SelfTestParentProtection -Path $dataRoot -ServiceSid $script:ServiceSid
    $bindings = @{
        NODE_ENV = 'production'
        DYSON_HOST = '127.0.0.1'
        DYSON_DATA_DIR = $dataDirectory
        DYSON_SCRIPT_ROOT = $script:ScriptRoot
        DYSON_RUNTIME_BOOTSTRAP_ROOT = $script:RuntimeRoot
        DYSON_DEPLOYMENT_VERSION = '0.0.0-selftest'
    }
    $bytes = ConvertTo-TestBytes (New-TestEnvironmentText $bindings)
    $source = Read-DysonControlEnvironmentBytes -Bytes $bytes -Contract $script:Contract `
        -ExpectedLauncherBindings $bindings
    $storage = Initialize-DysonConfigurationStorage -DataRoot $dataRoot `
        -ServiceSid $script:ServiceSid
    return [pscustomobject][ordered]@{
        dataRoot = $dataRoot
        bindings = $bindings
        bytes = $bytes
        source = $source
        storage = $storage
    }
}

function Set-SelfTestParentProtection {
    param(
        [Parameter(Mandatory)][string]$Path,
        [string]$ServiceSid
    )

    if (-not $script:AclIntegration) { return }
    $acl = [System.Security.AccessControl.DirectorySecurity]::new()
    $acl.SetAccessRuleProtection($true, $false)
    $acl.SetOwner([System.Security.Principal.SecurityIdentifier]::new('S-1-5-32-544'))
    $inheritance = [System.Security.AccessControl.InheritanceFlags]'ContainerInherit, ObjectInherit'
    foreach ($sid in @('S-1-5-18', 'S-1-5-32-544')) {
        $acl.AddAccessRule([System.Security.AccessControl.FileSystemAccessRule]::new(
            [System.Security.Principal.SecurityIdentifier]::new($sid),
            [System.Security.AccessControl.FileSystemRights]::FullControl,
            $inheritance,
            [System.Security.AccessControl.PropagationFlags]::None,
            [System.Security.AccessControl.AccessControlType]::Allow
        ))
    }
    if (-not [string]::IsNullOrWhiteSpace($ServiceSid)) {
        $acl.AddAccessRule([System.Security.AccessControl.FileSystemAccessRule]::new(
            [System.Security.Principal.SecurityIdentifier]::new($ServiceSid),
            [System.Security.AccessControl.FileSystemRights]::ReadAndExecute,
            $inheritance,
            [System.Security.AccessControl.PropagationFlags]::None,
            [System.Security.AccessControl.AccessControlType]::Allow
        ))
    }
    [System.IO.Directory]::SetAccessControl($Path, $acl)
}

function New-TestPendingIntent {
    param(
        [Parameter(Mandatory)]$Fixture,
        [ValidateSet('create', 'reuse')][string]$Operation = 'create'
    )

    $state = Get-DysonConfigurationTransactionState -Storage $Fixture.storage `
        -ServiceSid $script:ServiceSid -Contract $script:Contract `
        -ExpectedLauncherBindings $Fixture.bindings
    $preimage = if ($Operation -ceq 'reuse') {
        Get-DysonConfigurationFileEvidence -Path $Fixture.storage.configurationPath `
            -ServiceSid $script:ServiceSid
    } else { $null }
    $value = New-DysonConfigurationIntentValue -Storage $Fixture.storage `
        -Source $Fixture.source -Contract $script:Contract `
        -ExpectedLauncherBindings $Fixture.bindings -ServiceSid $script:ServiceSid `
        -Operation $Operation -SourceKind configuration-source `
        -SourcePathSha256 (Get-DysonConfigurationSha256Text `
            ('selftest-source|' + $Fixture.dataRoot.ToLowerInvariant())) `
        -Sequence ([int64]$state.nextSequence) `
        -PreviousReceiptSha256 ([string]$state.chainHeadSha256) -Preimage $preimage
    $path = Join-Path $Fixture.storage.intentsRoot (([string]$value.transactionId) + '.json')
    $write = Write-DysonConfigurationDurableJsonCreateNew -Path $path -Value $value
    return [pscustomobject][ordered]@{
        record = [pscustomobject]$value
        sha256 = [string]$write.sha256
        path = [string]$write.path
    }
}

function Write-TestReceipt {
    param(
        [Parameter(Mandatory)]$Fixture,
        [Parameter(Mandatory)]$IntentEntry,
        [ValidateSet('installed', 'reused', 'aborted')][string]$State = 'installed'
    )
    $value = New-DysonConfigurationReceiptValue -Intent $IntentEntry.record `
        -IntentSha256 ([string]$IntentEntry.sha256) -State $State
    $path = Join-Path $Fixture.storage.receiptsRoot `
        (([string]$IntentEntry.record.transactionId) + '.json')
    return Write-DysonConfigurationDurableJsonCreateNew -Path $path -Value $value
}

function Complete-TestCreate {
    param([Parameter(Mandatory)]$Fixture)

    $intent = New-TestPendingIntent $Fixture
    $temporaryPath = Join-Path $Fixture.storage.configRoot ([string]$intent.record.temporaryName)
    [void](Write-DysonConfigurationStagedFile -Path $temporaryPath -Bytes $Fixture.bytes `
        -ServiceSid $script:ServiceSid)
    [System.IO.File]::Move($temporaryPath, $Fixture.storage.configurationPath)
    [void](Write-TestReceipt -Fixture $Fixture -IntentEntry $intent)
    return $intent
}

function Complete-TestRuntimeCreate {
    param([Parameter(Mandatory)]$Fixture)
    return Invoke-DysonConfigurationMutationTransaction -Storage $Fixture.storage `
        -Source $Fixture.source -Contract $script:Contract `
        -ExpectedLauncherBindings $Fixture.bindings -ServiceSid $script:ServiceSid `
        -Operation create -SourceKind configuration-source `
        -SourcePathSha256 (Get-DysonConfigurationSha256Text 'fictional-runtime-source')
}

function New-TestSnapshot {
    param(
        [Parameter(Mandatory)]$Fixture,
        [Parameter(Mandatory)][string]$Name
    )

    $snapshot = New-DysonConfigurationProtectedSnapshot -Storage $Fixture.storage `
        -Contract $script:Contract -ExpectedLauncherBindings $Fixture.bindings `
        -ServiceSid $script:ServiceSid
    $manifestPath = Join-Path $snapshot.snapshotPath $script:DysonConfigurationSnapshotManifestName
    $manifest = (Read-DysonConfigurationPrivateJsonFile -Path $manifestPath).value
    return [pscustomobject][ordered]@{
        path = [string]$snapshot.snapshotPath
        payloadPath = [string]$snapshot.payloadPath
        manifestPath = $manifestPath
        manifest = $manifest
    }
}

function New-TestProfileSource {
    param(
        [Parameter(Mandatory)]$Fixture,
        [Parameter(Mandatory)][string]$Name,
        [Parameter(Mandatory)][string]$Version
    )

    $profileScriptRoot = Join-Path $script:TestRoot ('profiles\' + $Name + '\scripts\windows')
    [void][System.IO.Directory]::CreateDirectory($profileScriptRoot)
    $bindings = @{} + $Fixture.bindings
    $bindings['DYSON_SCRIPT_ROOT'] = $profileScriptRoot
    $bindings['DYSON_DEPLOYMENT_VERSION'] = $Version
    $bytes = ConvertTo-TestBytes (New-TestEnvironmentText $bindings)
    return [pscustomobject][ordered]@{
        bindings = $bindings
        bytes = $bytes
        source = Read-DysonControlEnvironmentBytes -Bytes $bytes -Contract $script:Contract `
            -ExpectedLauncherBindings $bindings
        pathSha256 = Get-DysonConfigurationSha256Text ('selftest-profile-source|' + $Name)
    }
}

function Get-TestSnapshotEvidence {
    param([Parameter(Mandatory)]$Fixture, [Parameter(Mandatory)]$Snapshot)
    return Read-DysonConfigurationSnapshotInternal -SnapshotPath $Snapshot.path `
        -Contract $script:Contract -ServiceSid $script:ServiceSid `
        -ExpectedDataRoot $Fixture.dataRoot
}

function New-TestRestoreCrashScenario {
    param([Parameter(Mandatory)][string]$Name)

    $fixture = New-TestFixture $Name
    [void](Complete-TestCreate $fixture)
    $snapshotAFixture = New-TestSnapshot -Fixture $fixture -Name ($Name + '-snapshot-a')
    $snapshotA = Get-TestSnapshotEvidence -Fixture $fixture -Snapshot $snapshotAFixture
    $profileB = New-TestProfileSource -Fixture $fixture -Name ($Name + '-profile-b') `
        -Version '0.0.1-restore-crash-b'
    [void](Invoke-DysonConfigurationMutationTransaction -Storage $fixture.storage `
        -Source $profileB.source -Contract $script:Contract `
        -ExpectedLauncherBindings $profileB.bindings -ServiceSid $script:ServiceSid `
        -Operation replace -SourceKind configuration-source `
        -SourcePathSha256 $profileB.pathSha256 -PreimageSnapshot $snapshotA)
    $snapshotBFixture = New-TestSnapshot -Fixture ([pscustomobject]@{
        storage = $fixture.storage
        bindings = $profileB.bindings
    }) -Name ($Name + '-snapshot-b')
    $snapshotB = Read-DysonConfigurationSnapshotInternal `
        -SnapshotPath $snapshotBFixture.path -Contract $script:Contract `
        -ServiceSid $script:ServiceSid -ExpectedDataRoot $fixture.dataRoot `
        -IncludePrivateBytes
    $profileC = New-TestProfileSource -Fixture $fixture -Name ($Name + '-profile-c') `
        -Version '0.0.2-restore-crash-c'
    [void](Invoke-DysonConfigurationMutationTransaction -Storage $fixture.storage `
        -Source $profileC.source -Contract $script:Contract `
        -ExpectedLauncherBindings $profileC.bindings -ServiceSid $script:ServiceSid `
        -Operation replace -SourceKind configuration-source `
        -SourcePathSha256 $profileC.pathSha256 -PreimageSnapshot $snapshotB)
    $snapshotCFixture = New-TestSnapshot -Fixture ([pscustomobject]@{
        storage = $fixture.storage
        bindings = $profileC.bindings
    }) -Name ($Name + '-snapshot-c')
    $snapshotC = Get-TestSnapshotEvidence -Fixture $fixture -Snapshot $snapshotCFixture
    $sourceB = [pscustomobject][ordered]@{
        sha256 = [string]$snapshotB.configurationSha256
        length = [int64]$snapshotB.configurationLength
        bindingsSha256 = [string]$snapshotB.bindingsSha256
        privateBytes = [byte[]]$snapshotB.privateBytes
    }
    return [pscustomobject][ordered]@{
        fixture = $fixture
        snapshotB = $snapshotB
        snapshotC = $snapshotC
        sourceB = $sourceB
    }
}

$tempBase = Assert-DysonConfigurationPlainDirectoryChain $env:TEMP
$script:TestRoot = Join-Path $tempBase ('DysonConfigurationSelfTest-' + [guid]::NewGuid().ToString('N'))
if (-not (Test-DysonConfigurationPathWithin -Candidate $script:TestRoot -Parent $tempBase)) {
    throw 'DYSON_CONFIGURATION_SELFTEST_TEMP_PATH_INVALID'
}
[void][System.IO.Directory]::CreateDirectory($script:TestRoot)

try {
    $script:Contract = Get-DysonConfigurationContract
    $repoRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..\..'))
    $apiConfigurationPath = Join-Path $repoRoot 'apps\api\src\config.ts'
    $apiConfigurationSource = [System.IO.File]::ReadAllText($apiConfigurationPath)
    $apiNames = @([regex]::Matches(
            $apiConfigurationSource, '(?m)^\s*(DYSON_[A-Z0-9_]+):\s'
        ) | ForEach-Object { $_.Groups[1].Value } | Sort-Object -Unique)
    $contractNames = @($script:Contract.dysonNames | Sort-Object)
    Assert-SelfTest ($apiNames.Count -eq $contractNames.Count -and
        $contractNames.Count -ge 1 -and $contractNames.Count -le 128) 'CONTRACT_COUNT'
    Assert-SelfTest (([string]::Join("`n", $apiNames)) -ceq
        ([string]::Join("`n", $contractNames))) 'CONTRACT_SOURCE_SYNC'
    foreach ($qualifiedClientName in @(
        'DYSON_QUALIFIED_CLIENT_PROFILE_ENABLED',
        'DYSON_CLIENT_QUALIFICATION_EVIDENCE_ROOT',
        'DYSON_CLIENT_QUALIFICATION_BUILD_HARVEST_ROOT_A',
        'DYSON_CLIENT_QUALIFICATION_BUILD_HARVEST_ROOT_B',
        'DYSON_CLIENT_QUALIFICATION_KEY_RING_ROOT',
        'DYSON_CLIENT_QUALIFICATION_REPLAY_ROOT',
        'DYSON_QUALIFIED_CLIENT_ISSUE_ROOT',
        'DYSON_CLIENT_QUALIFICATION_AUTHORITY'
    )) {
        Assert-SelfTest ($script:Contract.allowedNames.Contains($qualifiedClientName)) `
            ('QUALIFIED_CLIENT_CONTRACT_' + $qualifiedClientName)
    }
    Assert-SelfTest ($script:Contract.requiredProductionNames.Count -eq 4) 'REQUIRED_KEYS'
    Assert-SelfTest ($script:Contract.launcherOwnedNames.Count -eq 6) 'LAUNCHER_KEYS'
    Assert-SelfTest ($script:Contract.secretNames.Count -eq 6) 'SECRET_KEYS'

    $script:ScriptRoot = Join-Path $script:TestRoot 'release\scripts\windows'
    $script:RuntimeRoot = Join-Path $script:TestRoot 'install\bootstrap'
    [void][System.IO.Directory]::CreateDirectory($script:ScriptRoot)
    [void][System.IO.Directory]::CreateDirectory($script:RuntimeRoot)
    $parserDataRoot = Join-Path $script:TestRoot 'parser-data-root'
    $parserDataDirectory = Join-Path $parserDataRoot 'data'
    [void][System.IO.Directory]::CreateDirectory($parserDataDirectory)
    $parserBindings = @{
        NODE_ENV = 'production'
        DYSON_HOST = '127.0.0.1'
        DYSON_DATA_DIR = $parserDataDirectory
        DYSON_SCRIPT_ROOT = $script:ScriptRoot
        DYSON_RUNTIME_BOOTSTRAP_ROOT = $script:RuntimeRoot
        DYSON_DEPLOYMENT_VERSION = '0.0.0-selftest'
    }
    $validText = New-TestEnvironmentText $parserBindings
    $validBytes = ConvertTo-TestBytes $validText
    $parsed = Read-DysonControlEnvironmentBytes -Bytes $validBytes -Contract $script:Contract `
        -ExpectedLauncherBindings $parserBindings
    Assert-SelfTest ($parsed.length -eq $validBytes.Length) 'VALID_UTF8'
    Assert-SelfTest ($parsed.privateValues['DYSON_SESSION_SECRET'] -ceq $script:SecretSentinel) 'VALUE_EXACT'
    Assert-SelfTest (
        [string]$parsed.privateValues['DYSON_PLAYER_NOTICE_MUTATIONS_ENABLED'] -ceq 'false'
    ) 'PLAYER_NOTICE_MUTATIONS_EXPLICITLY_DISABLED'
    Assert-SelfTest (-not (($parsed | Select-Object -Property * -ExcludeProperty privateBytes, privateValues |
        ConvertTo-Json -Depth 4 -Compress).Contains($script:SecretSentinel))) 'PUBLIC_EVIDENCE_REDACTED'

    Assert-SelfTest (-not $parsed.privateValues.ContainsKey(
        'DYSON_NEBULA_PLUGIN_TRANSACTION_ENABLED'
    ) -and -not $parsed.privateValues.ContainsKey(
        'DYSON_NEBULA_PLUGIN_TRANSACTION_RECOVERY_ENABLED'
    ) -and -not (Get-DysonConfigurationStrictBoolean -Values $parsed.privateValues `
        -Name 'DYSON_NEBULA_PLUGIN_TRANSACTION_ENABLED') -and
        -not (Get-DysonConfigurationStrictBoolean -Values $parsed.privateValues `
            -Name 'DYSON_NEBULA_PLUGIN_TRANSACTION_RECOVERY_ENABLED')) `
        'NEBULA_PLUGIN_GATES_DEFAULT_DISABLED'
    $explicitlyDisabledText = $validText +
        "DYSON_NEBULA_PLUGIN_TRANSACTION_ENABLED=false`n" +
        "DYSON_NEBULA_PLUGIN_TRANSACTION_RECOVERY_ENABLED=false`n"
    $explicitlyDisabled = Read-DysonControlEnvironmentBytes `
        -Bytes (ConvertTo-TestBytes $explicitlyDisabledText) -Contract $script:Contract `
        -ExpectedLauncherBindings $parserBindings
    Assert-SelfTest (
        [string]$explicitlyDisabled.privateValues['DYSON_NEBULA_PLUGIN_TRANSACTION_ENABLED'] -ceq 'false' -and
        [string]$explicitlyDisabled.privateValues['DYSON_NEBULA_PLUGIN_TRANSACTION_RECOVERY_ENABLED'] -ceq 'false'
    ) 'NEBULA_PLUGIN_GATES_EXPLICITLY_DISABLED'

    $invalidBooleanIndex = 0
    foreach ($name in @(
            'DYSON_NEBULA_PLUGIN_TRANSACTION_ENABLED',
            'DYSON_NEBULA_PLUGIN_TRANSACTION_RECOVERY_ENABLED'
        )) {
        foreach ($invalidValue in @('TRUE', 'False', '1', '')) {
            $invalidBooleanIndex += 1
            $invalidBoolean = ConvertTo-TestBytes ($validText + $name + '=' + $invalidValue + "`n")
            Assert-SelfTestRejected { Read-DysonControlEnvironmentBytes -Bytes $invalidBoolean `
                -Contract $script:Contract -ExpectedLauncherBindings $parserBindings } `
                ('NEBULA_PLUGIN_BOOLEAN_STRICT_' + $invalidBooleanIndex)
        }
    }

    $nebulaProjectRoot = Join-Path $script:TestRoot 'nebula-project'
    $nebulaServerRoot = Join-Path $nebulaProjectRoot 'server'
    $nebulaJobBase = Join-Path $script:TestRoot 'nebula-jobs'
    [void][System.IO.Directory]::CreateDirectory($nebulaServerRoot)
    [void][System.IO.Directory]::CreateDirectory($nebulaJobBase)
    $nebulaRootText = $validText + ('DYSON_PROJECT_ROOT=' + $nebulaProjectRoot + "`n")
    $transactionEnabledText = $nebulaRootText +
        ('DYSON_NEBULA_PLUGIN_JOB_BASE=' + $nebulaJobBase + "`n") +
        "DYSON_NEBULA_PLUGIN_TRANSACTION_ENABLED=true`n" +
        "DYSON_NEBULA_PLUGIN_TRANSACTION_RECOVERY_ENABLED=false`n"
    $transactionEnabled = Read-DysonControlEnvironmentBytes `
        -Bytes (ConvertTo-TestBytes $transactionEnabledText) -Contract $script:Contract `
        -ExpectedLauncherBindings $parserBindings
    Assert-SelfTest (
        [string]$transactionEnabled.privateValues['DYSON_NEBULA_PLUGIN_TRANSACTION_ENABLED'] -ceq 'true' -and
        [string]$transactionEnabled.privateValues['DYSON_NEBULA_PLUGIN_JOB_BASE'] -ceq $nebulaJobBase
    ) 'NEBULA_PLUGIN_TRANSACTION_ENABLED_DISJOINT_ROOTS'

    $recoveryEnabledText = $nebulaRootText +
        ('DYSON_NEBULA_PLUGIN_JOB_BASE=' + $nebulaJobBase + "`n") +
        "DYSON_NEBULA_PLUGIN_TRANSACTION_ENABLED=false`n" +
        "DYSON_NEBULA_PLUGIN_TRANSACTION_RECOVERY_ENABLED=true`n"
    [void](Read-DysonControlEnvironmentBytes -Bytes (ConvertTo-TestBytes $recoveryEnabledText) `
        -Contract $script:Contract -ExpectedLauncherBindings $parserBindings)
    $script:TestCount += 1

    $configuredDisabledText = $nebulaRootText +
        ('DYSON_NEBULA_PLUGIN_JOB_BASE=' + $nebulaJobBase + "`n") +
        "DYSON_NEBULA_PLUGIN_TRANSACTION_ENABLED=false`n" +
        "DYSON_NEBULA_PLUGIN_TRANSACTION_RECOVERY_ENABLED=false`n"
    [void](Read-DysonControlEnvironmentBytes -Bytes (ConvertTo-TestBytes $configuredDisabledText) `
        -Contract $script:Contract -ExpectedLauncherBindings $parserBindings)
    $script:TestCount += 1

    $missingJobBase = ConvertTo-TestBytes ($nebulaRootText +
        "DYSON_NEBULA_PLUGIN_TRANSACTION_ENABLED=true`n")
    Assert-SelfTestRejected { Read-DysonControlEnvironmentBytes -Bytes $missingJobBase `
        -Contract $script:Contract -ExpectedLauncherBindings $parserBindings } `
        'NEBULA_PLUGIN_ENABLED_JOB_BASE_REQUIRED'
    $relativeJobBase = ConvertTo-TestBytes ($nebulaRootText +
        "DYSON_NEBULA_PLUGIN_JOB_BASE=.\\nebula-jobs`n" +
        "DYSON_NEBULA_PLUGIN_TRANSACTION_ENABLED=true`n")
    Assert-SelfTestRejected { Read-DysonControlEnvironmentBytes -Bytes $relativeJobBase `
        -Contract $script:Contract -ExpectedLauncherBindings $parserBindings } `
        'NEBULA_PLUGIN_ENABLED_JOB_BASE_ABSOLUTE'
    $disabledRelativeJobBase = ConvertTo-TestBytes ($validText +
        "DYSON_NEBULA_PLUGIN_JOB_BASE=.\\nebula-jobs`n" +
        "DYSON_NEBULA_PLUGIN_TRANSACTION_ENABLED=false`n" +
        "DYSON_NEBULA_PLUGIN_TRANSACTION_RECOVERY_ENABLED=false`n")
    Assert-SelfTestRejected { Read-DysonControlEnvironmentBytes -Bytes $disabledRelativeJobBase `
        -Contract $script:Contract -ExpectedLauncherBindings $parserBindings } `
        'NEBULA_PLUGIN_CONFIGURED_JOB_BASE_ABSOLUTE'
    $disabledMissingProjectRoot = ConvertTo-TestBytes ($validText +
        ('DYSON_NEBULA_PLUGIN_JOB_BASE=' + $nebulaJobBase + "`n") +
        "DYSON_NEBULA_PLUGIN_TRANSACTION_ENABLED=false`n" +
        "DYSON_NEBULA_PLUGIN_TRANSACTION_RECOVERY_ENABLED=false`n")
    Assert-SelfTestRejected { Read-DysonControlEnvironmentBytes -Bytes $disabledMissingProjectRoot `
        -Contract $script:Contract -ExpectedLauncherBindings $parserBindings } `
        'NEBULA_PLUGIN_CONFIGURED_DISABLED_ROOTS_REQUIRED'
    $missingProjectRoot = ConvertTo-TestBytes ($validText +
        ('DYSON_NEBULA_PLUGIN_JOB_BASE=' + $nebulaJobBase + "`n") +
        "DYSON_NEBULA_PLUGIN_TRANSACTION_ENABLED=true`n")
    Assert-SelfTestRejected { Read-DysonControlEnvironmentBytes -Bytes $missingProjectRoot `
        -Contract $script:Contract -ExpectedLauncherBindings $parserBindings } `
        'NEBULA_PLUGIN_ENABLED_PROJECT_ROOT_REQUIRED'
    $relativeProjectRoot = ConvertTo-TestBytes ($validText +
        "DYSON_PROJECT_ROOT=.\\nebula-project`n" +
        ('DYSON_NEBULA_PLUGIN_JOB_BASE=' + $nebulaJobBase + "`n") +
        "DYSON_NEBULA_PLUGIN_TRANSACTION_ENABLED=true`n")
    Assert-SelfTestRejected { Read-DysonControlEnvironmentBytes -Bytes $relativeProjectRoot `
        -Contract $script:Contract -ExpectedLauncherBindings $parserBindings } `
        'NEBULA_PLUGIN_ENABLED_PROJECT_ROOT_ABSOLUTE'
    $wrongProvider = ConvertTo-TestBytes (($transactionEnabledText).Replace(
        'DYSON_PROVIDER=windows', 'DYSON_PROVIDER=demo'
    ))
    Assert-SelfTestRejected { Read-DysonControlEnvironmentBytes -Bytes $wrongProvider `
        -Contract $script:Contract -ExpectedLauncherBindings $parserBindings } `
        'NEBULA_PLUGIN_ENABLED_WINDOWS_PROVIDER'

    $overlapCases = @(
        $nebulaProjectRoot,
        (Join-Path $nebulaServerRoot 'jobs'),
        $parserDataDirectory,
        (Join-Path $parserDataDirectory 'nebula-jobs'),
        $script:TestRoot
    )
    $overlapIndex = 0
    foreach ($overlapJobBase in $overlapCases) {
        $overlapIndex += 1
        $overlapText = $nebulaRootText +
            ('DYSON_NEBULA_PLUGIN_JOB_BASE=' + $overlapJobBase + "`n") +
            "DYSON_NEBULA_PLUGIN_TRANSACTION_ENABLED=true`n"
        Assert-SelfTestRejected { Read-DysonControlEnvironmentBytes `
            -Bytes (ConvertTo-TestBytes $overlapText) -Contract $script:Contract `
            -ExpectedLauncherBindings $parserBindings } `
            ('NEBULA_PLUGIN_JOB_BASE_DISJOINT_' + $overlapIndex)
    }

    $disabledOverlapText = $nebulaRootText +
        ('DYSON_NEBULA_PLUGIN_JOB_BASE=' + (Join-Path $nebulaServerRoot 'disabled-jobs') + "`n") +
        "DYSON_NEBULA_PLUGIN_TRANSACTION_ENABLED=false`n" +
        "DYSON_NEBULA_PLUGIN_TRANSACTION_RECOVERY_ENABLED=false`n"
    Assert-SelfTestRejected { Read-DysonControlEnvironmentBytes `
        -Bytes (ConvertTo-TestBytes $disabledOverlapText) -Contract $script:Contract `
        -ExpectedLauncherBindings $parserBindings } `
        'NEBULA_PLUGIN_CONFIGURED_DISABLED_JOB_BASE_DISJOINT'

    $filesystemRoot = [System.IO.Path]::GetPathRoot($nebulaJobBase)
    $rootJobBaseText = $nebulaRootText +
        ('DYSON_NEBULA_PLUGIN_JOB_BASE=' + $filesystemRoot + "`n") +
        "DYSON_NEBULA_PLUGIN_TRANSACTION_ENABLED=false`n" +
        "DYSON_NEBULA_PLUGIN_TRANSACTION_RECOVERY_ENABLED=false`n"
    Assert-SelfTestRejected { Read-DysonControlEnvironmentBytes `
        -Bytes (ConvertTo-TestBytes $rootJobBaseText) -Contract $script:Contract `
        -ExpectedLauncherBindings $parserBindings } 'NEBULA_PLUGIN_JOB_BASE_NON_ROOT'

    $rootDataBindings = @{} + $parserBindings
    $rootDataBindings['DYSON_DATA_DIR'] = [System.IO.Path]::GetPathRoot($parserDataDirectory)
    $rootDataText = (New-TestEnvironmentText $rootDataBindings) +
        ('DYSON_PROJECT_ROOT=' + $nebulaProjectRoot + "`n") +
        ('DYSON_NEBULA_PLUGIN_JOB_BASE=' + $nebulaJobBase + "`n") +
        "DYSON_NEBULA_PLUGIN_TRANSACTION_ENABLED=true`n"
    Assert-SelfTestRejected { Read-DysonControlEnvironmentBytes `
        -Bytes (ConvertTo-TestBytes $rootDataText) -Contract $script:Contract `
        -ExpectedLauncherBindings $rootDataBindings } 'NEBULA_PLUGIN_DATA_ROOT_NON_ROOT'

    $gameDataOverlapBindings = @{} + $parserBindings
    $gameDataOverlapBindings['DYSON_DATA_DIR'] = Join-Path $nebulaServerRoot 'data'
    $gameDataOverlapText = (New-TestEnvironmentText $gameDataOverlapBindings) +
        ('DYSON_PROJECT_ROOT=' + $nebulaProjectRoot + "`n") +
        ('DYSON_NEBULA_PLUGIN_JOB_BASE=' + $nebulaJobBase + "`n") +
        "DYSON_NEBULA_PLUGIN_TRANSACTION_ENABLED=true`n"
    Assert-SelfTestRejected { Read-DysonControlEnvironmentBytes `
        -Bytes (ConvertTo-TestBytes $gameDataOverlapText) -Contract $script:Contract `
        -ExpectedLauncherBindings $gameDataOverlapBindings } `
        'NEBULA_PLUGIN_GAME_DATA_ROOTS_DISJOINT'

    $crlf = ConvertTo-TestBytes ($validText.Replace("`n", "`r`n"))
    [void](Read-DysonControlEnvironmentBytes -Bytes $crlf -Contract $script:Contract `
        -ExpectedLauncherBindings $parserBindings)
    $script:TestCount += 1

    $bomBytes = [byte[]](@(0xEF, 0xBB, 0xBF) + @($validBytes))
    Assert-SelfTestRejected { Read-DysonControlEnvironmentBytes -Bytes $bomBytes `
        -Contract $script:Contract -ExpectedLauncherBindings $parserBindings } 'BOM'
    Assert-SelfTestRejected { Read-DysonControlEnvironmentBytes -Bytes ([byte[]](0xC3, 0x28)) `
        -Contract $script:Contract -ExpectedLauncherBindings $parserBindings } 'INVALID_UTF8'
    $replacement = ConvertTo-TestBytes ($validText + "#" + [char]0xFFFD + "`n")
    Assert-SelfTestRejected { Read-DysonControlEnvironmentBytes -Bytes $replacement `
        -Contract $script:Contract -ExpectedLauncherBindings $parserBindings } 'REPLACEMENT_CHARACTER'
    $duplicate = ConvertTo-TestBytes ($validText + 'DYSON_PORT=13011' + "`n")
    Assert-SelfTestRejected { Read-DysonControlEnvironmentBytes -Bytes $duplicate `
        -Contract $script:Contract -ExpectedLauncherBindings $parserBindings } 'DUPLICATE'
    $unknown = ConvertTo-TestBytes ($validText + 'DYSON_UNKNOWN_FIXTURE=true' + "`n")
    Assert-SelfTestRejected { Read-DysonControlEnvironmentBytes -Bytes $unknown `
        -Contract $script:Contract -ExpectedLauncherBindings $parserBindings } 'UNKNOWN'
    $whitespaceName = ConvertTo-TestBytes ($validText.Replace('DYSON_PORT=', ' DYSON_PORT='))
    Assert-SelfTestRejected { Read-DysonControlEnvironmentBytes -Bytes $whitespaceName `
        -Contract $script:Contract -ExpectedLauncherBindings $parserBindings } 'NAME_WHITESPACE'
    $bareCr = ConvertTo-TestBytes ($validText.Replace("`n", "`r"))
    Assert-SelfTestRejected { Read-DysonControlEnvironmentBytes -Bytes $bareCr `
        -Contract $script:Contract -ExpectedLauncherBindings $parserBindings } 'BARE_CR'
    $nul = [byte[]](@($validBytes) + @(0))
    Assert-SelfTestRejected { Read-DysonControlEnvironmentBytes -Bytes $nul `
        -Contract $script:Contract -ExpectedLauncherBindings $parserBindings } 'NUL'
    $unicodeLineSeparator = ConvertTo-TestBytes ($validText + '#' + [char]0x2028 + "`n")
    Assert-SelfTestRejected { Read-DysonControlEnvironmentBytes -Bytes $unicodeLineSeparator `
        -Contract $script:Contract -ExpectedLauncherBindings $parserBindings } 'UNICODE_LINE_SEPARATOR'
    $missingAdmin = ConvertTo-TestBytes (($validText -split "`n" |
        Where-Object { $_ -notlike 'DYSON_ADMIN_PASSWORD_HASH=*' }) -join "`n")
    Assert-SelfTestRejected { Read-DysonControlEnvironmentBytes -Bytes $missingAdmin `
        -Contract $script:Contract -ExpectedLauncherBindings $parserBindings } 'MISSING_REQUIRED'
    $wrongHost = ConvertTo-TestBytes ($validText.Replace('DYSON_HOST=127.0.0.1', 'DYSON_HOST=0.0.0.0'))
    Assert-SelfTestRejected { Read-DysonControlEnvironmentBytes -Bytes $wrongHost `
        -Contract $script:Contract -ExpectedLauncherBindings $parserBindings } 'NON_LOOPBACK'
    $shortSecret = ConvertTo-TestBytes ($validText.Replace($script:SecretSentinel, 'too-short'))
    Assert-SelfTestRejected { Read-DysonControlEnvironmentBytes -Bytes $shortSecret `
        -Contract $script:Contract -ExpectedLauncherBindings $parserBindings } 'SHORT_SECRET'
    $wrongBinding = ConvertTo-TestBytes ($validText.Replace(
        'DYSON_DEPLOYMENT_VERSION=0.0.0-selftest', 'DYSON_DEPLOYMENT_VERSION=0.0.1-other'
    ))
    Assert-SelfTestRejected { Read-DysonControlEnvironmentBytes -Bytes $wrongBinding `
        -Contract $script:Contract -ExpectedLauncherBindings $parserBindings } 'BINDING_MISMATCH'
    $incompleteBindings = @{} + $parserBindings
    $incompleteBindings.Remove('DYSON_SCRIPT_ROOT')
    Assert-SelfTestRejected { Read-DysonControlEnvironmentBytes -Bytes $validBytes `
        -Contract $script:Contract -ExpectedLauncherBindings $incompleteBindings } 'INCOMPLETE_BINDINGS'
    Assert-SelfTestRejected { Read-DysonControlEnvironmentBytes -Bytes ([byte[]]::new(65537)) `
        -Contract $script:Contract -ExpectedLauncherBindings $parserBindings } 'OVERSIZE'

    $sourcePath = Join-Path $script:TestRoot 'unprotected-source.env'
    [System.IO.File]::WriteAllBytes($sourcePath, $validBytes)
    [void](Assert-DysonConfigurationPlainFilePath $sourcePath)
    $script:TestCount += 1
    Assert-SelfTestRejected { Assert-DysonConfigurationPrivateSourceAcl $sourcePath } 'SOURCE_ACL'
    $currentUserSid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
    [void](Set-DysonConfigurationAcl -Path $sourcePath -Kind SourceFile `
        -SourceOwnerSid $currentUserSid)
    [void](Assert-DysonConfigurationPrivateSourceAcl $sourcePath)
    $script:TestCount += 1
    # Keep the UNC rejection portable: the repository itself may be copied to
    # a local NTFS release/test root.  Assert-DysonConfigurationLocalNtfsPath
    # rejects this syntactic UNC root before any filesystem or network access.
    $uncSourceFixture = [string]::Concat(
        [char]92, [char]92, 'fixture.invalid', [char]92, 'share', [char]92,
        $script:DysonConfigurationContractName
    )
    Assert-SelfTestRejected { Assert-DysonConfigurationPlainFilePath `
        $uncSourceFixture } 'UNC_SOURCE' '*LOCAL_NTFS_REQUIRED*'

    $junctionTarget = Join-Path $script:TestRoot 'junction-target'
    $junctionPath = Join-Path $script:TestRoot 'junction-source'
    [void][System.IO.Directory]::CreateDirectory($junctionTarget)
    [void](New-Item -ItemType Junction -Path $junctionPath -Target $junctionTarget -ErrorAction Stop)
    Assert-SelfTestRejected { Assert-DysonConfigurationPlainDirectoryChain $junctionPath } 'REPARSE_CHAIN'
    [System.IO.Directory]::Delete($junctionPath)

    $configFilePolicy = Get-DysonConfigurationAclPolicy -Kind ConfigFile -ServiceSid 'S-1-5-19'
    $configDirectoryPolicy = Get-DysonConfigurationAclPolicy -Kind ConfigDirectory -ServiceSid 'S-1-5-19'
    $privatePolicy = Get-DysonConfigurationAclPolicy -Kind PrivateFile
    $serviceFileRights = [int64][System.Security.AccessControl.FileSystemRights]::Read -bor `
        [int64][System.Security.AccessControl.FileSystemRights]::Synchronize
    $serviceDirectoryRights = [int64][System.Security.AccessControl.FileSystemRights]::ReadAndExecute -bor `
        [int64][System.Security.AccessControl.FileSystemRights]::Synchronize
    $writeMask = Get-DysonConfigurationWriteMask
    Assert-SelfTest ($configFilePolicy.ownerSid -ceq 'S-1-5-32-544') 'CONFIG_OWNER_ADMIN'
    Assert-SelfTest ($configFilePolicy.rules.Count -eq 3) 'CONFIG_FILE_EXACT_RULE_COUNT'
    Assert-SelfTest (@($configFilePolicy.rules | Where-Object {
        $_.sid -ceq 'S-1-5-19' -and $_.rights -eq $serviceFileRights -and
            ($_.rights -band $writeMask) -eq 0
    }).Count -eq 1) 'SERVICE_READ_ONLY'
    Assert-SelfTest ($configDirectoryPolicy.rules.Count -eq 3) 'CONFIG_DIRECTORY_EXACT_RULE_COUNT'
    Assert-SelfTest (@($configDirectoryPolicy.rules | Where-Object {
        $_.sid -ceq 'S-1-5-19' -and $_.rights -eq $serviceDirectoryRights -and
            ($_.rights -band $writeMask) -eq 0
    }).Count -eq 1) 'SERVICE_DIRECTORY_READ_EXECUTE_ONLY'
    Assert-SelfTest ($privatePolicy.rules.Count -eq 2) 'PRIVATE_NO_SERVICE_RULE'
    Assert-SelfTestRejected { Assert-DysonConfigurationParentAcl -Path $parserDataRoot `
        -ServiceSid 'S-1-5-19' } 'INHERITED_PARENT_ACL' '*PARENT_ACL_INVALID*'

    $identity = [System.Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = [System.Security.Principal.WindowsPrincipal]::new($identity)
    $aclIntegration = $principal.IsInRole(
        [System.Security.Principal.WindowsBuiltInRole]::Administrator
    )
    $script:AclIntegration = $aclIntegration
    if ($RequireAclIntegration -and -not $aclIntegration) {
        throw 'DYSON_CONFIGURATION_SELFTEST_REQUIRES_ELEVATION'
    }
    if (-not $aclIntegration) {
        # Self-test-only ACL seam. Production functions remain strict; the seam
        # permits transaction and crash-state coverage under a filtered token.
        function Set-DysonConfigurationAcl {
            param(
                [Parameter(Mandatory)][string]$Path,
                [Parameter(Mandatory)][string]$Kind,
                [string]$ServiceSid,
                [string]$SourceOwnerSid
            )
            $item = Get-Item -LiteralPath $Path -Force -ErrorAction Stop
            if (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint)) {
                throw 'DYSON_CONFIGURATION_ACL_INVALID'
            }
            $policy = Get-DysonConfigurationAclPolicy -Kind $Kind -ServiceSid $ServiceSid `
                -SourceOwnerSid $SourceOwnerSid
            return [pscustomobject][ordered]@{
                ownerSid = [string]$policy.ownerSid
                protected = $true
                fingerprint = [string]$policy.fingerprint
                kind = $Kind
            }
        }
        function Assert-DysonConfigurationAcl {
            param(
                [Parameter(Mandatory)][string]$Path,
                [Parameter(Mandatory)][string]$Kind,
                [string]$ServiceSid,
                [string]$SourceOwnerSid
            )
            return Set-DysonConfigurationAcl -Path $Path -Kind $Kind -ServiceSid $ServiceSid `
                -SourceOwnerSid $SourceOwnerSid
        }
        function Assert-DysonConfigurationParentAcl {
            param(
                [Parameter(Mandatory)][string]$Path,
                [string]$ServiceSid
            )
            $fullPath = Assert-DysonConfigurationPlainDirectoryChain $Path
            return [pscustomobject][ordered]@{
                ownerSid = 'S-1-5-32-544'
                protected = $true
                fingerprint = Get-DysonConfigurationSha256Text `
                    ('selftest-parent|' + $fullPath.ToLowerInvariant() + '|' + [string]$ServiceSid)
            }
        }
    }
    else {
        [void](Set-DysonConfigurationAcl -Path $sourcePath -Kind SourceFile `
            -SourceOwnerSid $identity.User.Value)
        [void](Assert-DysonConfigurationPrivateSourceAcl $sourcePath)
        $script:TestCount += 1
    }

    Set-SelfTestParentProtection -Path $script:TestRoot
    if ($aclIntegration) {
        Set-SelfTestParentProtection -Path $parserDataRoot -ServiceSid 'S-1-5-19'
        $whatIfResult = & (Join-Path $PSScriptRoot 'Install-DysonControlConfiguration.ps1') `
            -ConfigurationSource $sourcePath -DataRoot $parserDataRoot `
            -ScriptRoot $script:ScriptRoot -RuntimeBootstrapRoot $script:RuntimeRoot `
            -DeploymentVersion '0.0.0-selftest' -WhatIf
        Assert-SelfTest ($whatIfResult.mode -ceq 'what-if' -and
            -not $whatIfResult.mutationPerformed) 'INSTALL_WHAT_IF'
        Assert-SelfTest (-not (($whatIfResult | ConvertTo-Json -Compress).Contains(
            $script:SecretSentinel
        ))) 'INSTALL_WHAT_IF_REDACTED'
    }

    $script:ServiceSid = 'S-1-5-19'
    $longWriteBase = Join-Path $script:TestRoot 'long-durable-write'
    $longWriteParentLength = 225
    $longWriteSegmentLength = $longWriteParentLength - $longWriteBase.Length - 1
    Assert-SelfTest ($longWriteSegmentLength -ge 1 -and $longWriteSegmentLength -le 255) `
        'LONG_DURABLE_WRITE_FIXTURE_LENGTH'
    $longWriteParent = Join-Path $longWriteBase ('p' * $longWriteSegmentLength)
    [void][System.IO.Directory]::CreateDirectory($longWriteParent)
    [void](Set-DysonConfigurationAcl -Path $longWriteParent -Kind PrivateDirectory)
    $longWriteTarget = Join-Path $longWriteParent 'payload.json'
    $longWriterTemporaryLength = $longWriteParent.Length + 1 +
        ('.write-' + ('0' * 32) + '.tmp').Length
    Assert-SelfTest ($longWriteTarget.Length -lt 260 -and $longWriterTemporaryLength -ge 260) `
        'LONG_DURABLE_WRITE_FIXTURE_CROSSES_LEGACY_LIMIT'
    $longWriteBytes = ConvertTo-TestBytes '{"fixture":"long-durable-write"}'
    $longWriteEvidence = Write-DysonConfigurationDurableFileCreateNew `
        -Path $longWriteTarget -Bytes $longWriteBytes -Kind PrivateFile
    Assert-SelfTest ([string]$longWriteEvidence.path -ceq $longWriteTarget -and
        [string]$longWriteEvidence.sha256 -ceq
            (Get-DysonConfigurationSha256Bytes $longWriteBytes) -and
        [Convert]::ToBase64String([System.IO.File]::ReadAllBytes($longWriteTarget)) -ceq
            [Convert]::ToBase64String($longWriteBytes)) 'LONG_DURABLE_WRITE_EXTENDED_PATH'

    $beforeWrite = New-TestFixture 'before-write'
    $beforeState = Get-DysonConfigurationTransactionState -Storage $beforeWrite.storage `
        -ServiceSid $script:ServiceSid -Contract $script:Contract `
        -ExpectedLauncherBindings $beforeWrite.bindings
    Assert-SelfTest $beforeState.clean 'INTENT_BEFORE_WRITE'

    $lockWorkerPath = Join-Path $script:TestRoot 'configuration-lock-worker.ps1'
    $lockWorkerSource = @'
[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$CommonPath,
    [Parameter(Mandatory)][string]$DataRoot,
    [Parameter(Mandatory)][string]$EvidencePath,
    [Parameter(Mandatory)][string]$LeasePath,
    [ValidateRange(1, 10000)][int]$HoldMilliseconds
)
Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'
. $CommonPath
function Assert-DysonConfigurationAcl {
    param(
        [Parameter(Mandatory)][string]$Path,
        [Parameter(Mandatory)][string]$Kind,
        [string]$ServiceSid,
        [string]$SourceOwnerSid
    )
    $policy = Get-DysonConfigurationAclPolicy -Kind $Kind -ServiceSid $ServiceSid `
        -SourceOwnerSid $SourceOwnerSid
    return [pscustomobject][ordered]@{
        ownerSid = [string]$policy.ownerSid
        protected = $true
        fingerprint = [string]$policy.fingerprint
        kind = $Kind
    }
}
$storage = Get-DysonConfigurationStoragePaths -DataRoot $DataRoot
[System.IO.File]::WriteAllLines($EvidencePath,
    [string[]]@([datetime]::UtcNow.Ticks.ToString([Globalization.CultureInfo]::InvariantCulture)))
$lock = Enter-DysonConfigurationMutationLock -Storage $storage -TimeoutSeconds 10
try {
    [System.IO.File]::AppendAllText($EvidencePath,
        [datetime]::UtcNow.Ticks.ToString([Globalization.CultureInfo]::InvariantCulture) + "`n")
    $previousSequence = [int64]0
    if (Test-Path -LiteralPath $LeasePath -PathType Leaf) {
        $leaseText = [System.IO.File]::ReadAllText($LeasePath)
        if (-not [int64]::TryParse($leaseText,
                [Globalization.NumberStyles]::None,
                [Globalization.CultureInfo]::InvariantCulture,
                [ref]$previousSequence)) {
            throw 'DYSON_CONFIGURATION_SELFTEST_LEASE_INVALID'
        }
    }
    Start-Sleep -Milliseconds $HoldMilliseconds
    $nextSequence = $previousSequence + 1
    [System.IO.File]::WriteAllText($LeasePath,
        $nextSequence.ToString([Globalization.CultureInfo]::InvariantCulture))
    [System.IO.File]::AppendAllText($EvidencePath,
        $previousSequence.ToString([Globalization.CultureInfo]::InvariantCulture) + "`n" +
        $nextSequence.ToString([Globalization.CultureInfo]::InvariantCulture) + "`n")
    [System.IO.File]::AppendAllText($EvidencePath,
        [datetime]::UtcNow.Ticks.ToString([Globalization.CultureInfo]::InvariantCulture) + "`n")
}
finally { $lock.Dispose() }
'@
    [System.IO.File]::WriteAllText($lockWorkerPath, $lockWorkerSource,
        [System.Text.UTF8Encoding]::new($false, $true))
    $workerAPath = Join-Path $beforeWrite.dataRoot 'lock-worker-a.evidence'
    $workerBPath = Join-Path $beforeWrite.dataRoot 'lock-worker-b.evidence'
    $workerLeasePath = Join-Path $beforeWrite.dataRoot 'lock-worker.lease'
    $workerA = $null
    $workerB = $null
    try {
        $workerA = Start-Process -FilePath 'powershell.exe' -ArgumentList @(
            '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
            '-File', $lockWorkerPath, '-CommonPath',
            (Join-Path $PSScriptRoot 'DysonConfiguration.Common.ps1'),
            '-DataRoot', $beforeWrite.dataRoot, '-EvidencePath', $workerAPath,
            '-LeasePath', $workerLeasePath,
            '-HoldMilliseconds', '2500'
        ) -WorkingDirectory $env:TEMP -WindowStyle Hidden -PassThru
        [void](Wait-SelfTestFileLines -Path $workerAPath -MinimumCount 2)
        $workerB = Start-Process -FilePath 'powershell.exe' -ArgumentList @(
            '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
            '-File', $lockWorkerPath, '-CommonPath',
            (Join-Path $PSScriptRoot 'DysonConfiguration.Common.ps1'),
            '-DataRoot', $beforeWrite.dataRoot, '-EvidencePath', $workerBPath,
            '-LeasePath', $workerLeasePath,
            '-HoldMilliseconds', '50'
        ) -WorkingDirectory $env:TEMP -WindowStyle Hidden -PassThru
        [void](Wait-SelfTestFileLines -Path $workerBPath -MinimumCount 1)
        $workerA.Refresh()
        Assert-SelfTest (-not $workerA.HasExited) 'LOCK_SECOND_WRITER_ATTEMPTED_DURING_FIRST'
        if (-not $workerA.WaitForExit(15000) -or -not $workerB.WaitForExit(15000)) {
            throw 'DYSON_CONFIGURATION_SELFTEST_WORKER_TIMEOUT'
        }
        $workerALines = Wait-SelfTestFileLines -Path $workerAPath -MinimumCount 5
        $workerBLines = Wait-SelfTestFileLines -Path $workerBPath -MinimumCount 5
        Assert-SelfTest ($workerA.ExitCode -eq 0 -and $workerB.ExitCode -eq 0) `
            'LOCK_WRITERS_EXITED_CLEANLY'
        Assert-SelfTest ([int64]$workerALines[2] -eq 0 -and
            [int64]$workerALines[3] -eq 1 -and
            [int64]$workerBLines[2] -eq 1 -and
            [int64]$workerBLines[3] -eq 2 -and
            [System.IO.File]::ReadAllText($workerLeasePath) -ceq '2' -and
            [int64]$workerBLines[1] -ge [int64]$workerALines[4]) `
            'LOCK_TWO_WRITERS_LEASE_SEQUENCE_SERIALIZED'
    }
    finally {
        foreach ($worker in @($workerA, $workerB)) {
            if ($null -ne $worker) {
                $worker.Refresh()
                if (-not $worker.HasExited) { $worker.Kill(); [void]$worker.WaitForExit(5000) }
                $worker.Dispose()
            }
        }
    }

    $intentOnly = New-TestFixture 'intent-after-rename'
    $intentOnlyEntry = New-TestPendingIntent $intentOnly
    $intentPlan = Get-DysonConfigurationRecoveryPlan -Storage $intentOnly.storage `
        -ServiceSid $script:ServiceSid -Contract $script:Contract `
        -ExpectedLauncherBindings $intentOnly.bindings
    Assert-SelfTest ($intentPlan.state -ceq 'resume-write') 'INTENT_AFTER_RENAME_RECOVERY'
    $changedPendingBindings = @{} + $intentOnly.bindings
    $changedPendingBindings['DYSON_DEPLOYMENT_VERSION'] = '0.0.1-pending-mismatch'
    Assert-SelfTestRejected { Get-DysonConfigurationTransactionState -Storage $intentOnly.storage `
        -ServiceSid $script:ServiceSid -Contract $script:Contract `
        -ExpectedLauncherBindings $changedPendingBindings } 'PENDING_PROFILE_MISMATCH' `
        '*INTENT_BINDING_INVALID*'

    $midIntent = New-TestFixture 'intent-mid-write'
    $midIntentPath = Join-Path $midIntent.storage.intentsRoot `
        ('.write-' + [guid]::NewGuid().ToString('N') + '.tmp')
    [System.IO.File]::WriteAllBytes($midIntentPath, (ConvertTo-TestBytes '{"partial":'))
    [void](Set-DysonConfigurationAcl -Path $midIntentPath -Kind PrivateFile)
    $midIntentPlan = Get-DysonConfigurationRecoveryPlan -Storage $midIntent.storage `
        -ServiceSid $script:ServiceSid -Contract $script:Contract `
        -ExpectedLauncherBindings $midIntent.bindings
    Assert-SelfTest ($midIntentPlan.state -ceq 'blocked-orphan') 'INTENT_MID_WRITE_BLOCKED'

    $flushedIntent = New-TestFixture 'intent-after-flush'
    $flushedIntentValue = New-DysonConfigurationIntentValue -Storage $flushedIntent.storage `
        -Source $flushedIntent.source -Contract $script:Contract `
        -ExpectedLauncherBindings $flushedIntent.bindings -ServiceSid $script:ServiceSid `
        -Operation create -SourceKind configuration-source `
        -SourcePathSha256 (Get-DysonConfigurationSha256Text 'selftest-flushed-intent-source') `
        -Sequence 1
    $flushedIntentPath = Join-Path $flushedIntent.storage.intentsRoot `
        ('.write-' + [guid]::NewGuid().ToString('N') + '.tmp')
    $flushedIntentBytes = ConvertTo-TestBytes ((ConvertTo-DysonConfigurationJson $flushedIntentValue) + "`n")
    $flushedStream = [System.IO.FileStream]::new(
        $flushedIntentPath, [System.IO.FileMode]::CreateNew, [System.IO.FileAccess]::Write,
        [System.IO.FileShare]::None, 4096, [System.IO.FileOptions]::WriteThrough
    )
    try { $flushedStream.Write($flushedIntentBytes, 0, $flushedIntentBytes.Length); $flushedStream.Flush($true) }
    finally { $flushedStream.Dispose() }
    [void](Set-DysonConfigurationAcl -Path $flushedIntentPath -Kind PrivateFile)
    $flushedIntentPlan = Get-DysonConfigurationRecoveryPlan -Storage $flushedIntent.storage `
        -ServiceSid $script:ServiceSid -Contract $script:Contract `
        -ExpectedLauncherBindings $flushedIntent.bindings
    Assert-SelfTest ($flushedIntentPlan.state -ceq 'blocked-orphan') 'INTENT_AFTER_FLUSH_BLOCKED'

    $partialConfig = New-TestFixture 'config-mid-write'
    $partialIntent = New-TestPendingIntent $partialConfig
    $partialPath = Join-Path $partialConfig.storage.configRoot ([string]$partialIntent.record.temporaryName)
    [System.IO.File]::WriteAllBytes($partialPath, [byte[]]$partialConfig.bytes[0..15])
    [void](Set-DysonConfigurationAcl -Path $partialPath -Kind ConfigFile -ServiceSid $script:ServiceSid)
    $partialPlan = Get-DysonConfigurationRecoveryPlan -Storage $partialConfig.storage `
        -ServiceSid $script:ServiceSid -Contract $script:Contract `
        -ExpectedLauncherBindings $partialConfig.bindings
    Assert-SelfTest ($partialPlan.state -ceq 'abort-required') 'CONFIG_MID_WRITE_ABORT'
    [System.IO.File]::Delete($partialPath)
    [void](Write-TestReceipt -Fixture $partialConfig -IntentEntry $partialIntent -State aborted)
    $abortedState = Get-DysonConfigurationTransactionState -Storage $partialConfig.storage `
        -ServiceSid $script:ServiceSid -Contract $script:Contract `
        -ExpectedLauncherBindings $partialConfig.bindings
    Assert-SelfTest $abortedState.clean 'CONFIG_ABORT_RECEIPT'

    $flushedConfig = New-TestFixture 'config-after-flush'
    $flushedConfigIntent = New-TestPendingIntent $flushedConfig
    $flushedConfigPath = Join-Path $flushedConfig.storage.configRoot `
        ([string]$flushedConfigIntent.record.temporaryName)
    [void](Write-DysonConfigurationStagedFile -Path $flushedConfigPath `
        -Bytes $flushedConfig.bytes -ServiceSid $script:ServiceSid)
    $flushedConfigPlan = Get-DysonConfigurationRecoveryPlan -Storage $flushedConfig.storage `
        -ServiceSid $script:ServiceSid -Contract $script:Contract `
        -ExpectedLauncherBindings $flushedConfig.bindings
    Assert-SelfTest ($flushedConfigPlan.state -ceq 'finalize-create') 'CONFIG_AFTER_FLUSH_RECOVERY'
    [System.IO.File]::Move($flushedConfigPath, $flushedConfig.storage.configurationPath)
    $renamedConfigPlan = Get-DysonConfigurationRecoveryPlan -Storage $flushedConfig.storage `
        -ServiceSid $script:ServiceSid -Contract $script:Contract `
        -ExpectedLauncherBindings $flushedConfig.bindings
    Assert-SelfTest ($renamedConfigPlan.state -ceq 'finalize-receipt') 'CONFIG_AFTER_RENAME_RECOVERY'

    $midReceiptPath = Join-Path $flushedConfig.storage.receiptsRoot `
        ('.write-' + [guid]::NewGuid().ToString('N') + '.tmp')
    [System.IO.File]::WriteAllBytes($midReceiptPath, (ConvertTo-TestBytes '{"partial":'))
    [void](Set-DysonConfigurationAcl -Path $midReceiptPath -Kind PrivateFile)
    $midReceiptPlan = Get-DysonConfigurationRecoveryPlan -Storage $flushedConfig.storage `
        -ServiceSid $script:ServiceSid -Contract $script:Contract `
        -ExpectedLauncherBindings $flushedConfig.bindings
    Assert-SelfTest ($midReceiptPlan.state -ceq 'blocked-orphan') 'RECEIPT_MID_WRITE_BLOCKED'
    [System.IO.File]::Delete($midReceiptPath)

    $receiptValue = New-DysonConfigurationReceiptValue -Intent $flushedConfigIntent.record `
        -IntentSha256 ([string]$flushedConfigIntent.sha256) -State installed
    $flushedReceiptPath = Join-Path $flushedConfig.storage.receiptsRoot `
        ('.write-' + [guid]::NewGuid().ToString('N') + '.tmp')
    $flushedReceiptBytes = ConvertTo-TestBytes ((ConvertTo-DysonConfigurationJson $receiptValue) + "`n")
    [System.IO.File]::WriteAllBytes($flushedReceiptPath, $flushedReceiptBytes)
    [void](Set-DysonConfigurationAcl -Path $flushedReceiptPath -Kind PrivateFile)
    $flushedReceiptPlan = Get-DysonConfigurationRecoveryPlan -Storage $flushedConfig.storage `
        -ServiceSid $script:ServiceSid -Contract $script:Contract `
        -ExpectedLauncherBindings $flushedConfig.bindings
    Assert-SelfTest ($flushedReceiptPlan.state -ceq 'blocked-orphan') 'RECEIPT_AFTER_FLUSH_BLOCKED'
    [System.IO.File]::Delete($flushedReceiptPath)
    [void](Write-TestReceipt -Fixture $flushedConfig -IntentEntry $flushedConfigIntent)
    $completeState = Get-DysonConfigurationTransactionState -Storage $flushedConfig.storage `
        -ServiceSid $script:ServiceSid -Contract $script:Contract `
        -ExpectedLauncherBindings $flushedConfig.bindings
    Assert-SelfTest $completeState.clean 'RECEIPT_AFTER_RENAME_COMPLETE'

    $reuse = New-TestFixture 'reuse'
    [void](Complete-TestCreate $reuse)
    $reuseIntent = New-TestPendingIntent -Fixture $reuse -Operation reuse
    $reusePlan = Get-DysonConfigurationRecoveryPlan -Storage $reuse.storage `
        -ServiceSid $script:ServiceSid -Contract $script:Contract `
        -ExpectedLauncherBindings $reuse.bindings
    Assert-SelfTest ($reusePlan.state -ceq 'finalize-receipt') 'REUSE_RECOVERY'
    [void](Write-TestReceipt -Fixture $reuse -IntentEntry $reuseIntent -State reused)
    $reuseState = Get-DysonConfigurationTransactionState -Storage $reuse.storage `
        -ServiceSid $script:ServiceSid -Contract $script:Contract `
        -ExpectedLauncherBindings $reuse.bindings
    Assert-SelfTest $reuseState.clean 'REUSE_COMPLETE'
    $upgradedBindings = @{} + $reuse.bindings
    $upgradedBindings['DYSON_DEPLOYMENT_VERSION'] = '0.0.1-selftest-upgrade'
    $historicalState = Get-DysonConfigurationTransactionState -Storage $reuse.storage `
        -ServiceSid $script:ServiceSid -Contract $script:Contract `
        -ExpectedLauncherBindings $upgradedBindings
    Assert-SelfTest ($historicalState.clean -and
        [string]$historicalState.terminalBindingsSha256 -ceq
            (Get-DysonConfigurationExpectedBindingsHash `
                -ExpectedLauncherBindings $reuse.bindings -Contract $script:Contract)) `
        'HISTORICAL_RECEIPT_SELF_BOUND'

    $unreceipted = New-TestFixture 'unreceipted-valid-target'
    [void](Write-DysonConfigurationStagedFile -Path $unreceipted.storage.configurationPath `
        -Bytes $unreceipted.bytes -ServiceSid $script:ServiceSid)
    Assert-SelfTestRejected { Get-DysonConfigurationTransactionState `
        -Storage $unreceipted.storage -ServiceSid $script:ServiceSid `
        -Contract $script:Contract -ExpectedLauncherBindings $unreceipted.bindings } `
        'UNRECEIPTED_VALID_TARGET' '*UNRECEIPTED_TARGET*'

    $liveDrift = New-TestFixture 'completed-live-drift'
    [void](Complete-TestCreate $liveDrift)
    $liveDriftProfile = New-TestProfileSource -Fixture $liveDrift `
        -Name 'completed-live-drift-b' -Version '0.0.1-live-drift'
    [System.IO.File]::WriteAllBytes($liveDrift.storage.configurationPath,
        [byte[]]$liveDriftProfile.bytes)
    [void](Set-DysonConfigurationAcl -Path $liveDrift.storage.configurationPath `
        -Kind ConfigFile -ServiceSid $script:ServiceSid)
    $validDrift = Read-DysonControlEnvironmentFile `
        -Path $liveDrift.storage.configurationPath -Contract $script:Contract `
        -ExpectedLauncherBindings $liveDriftProfile.bindings -SkipSourceAcl
    Assert-SelfTest ([string]$validDrift.sha256 -ceq [string]$liveDriftProfile.source.sha256) `
        'LIVE_DRIFT_REMAINS_CONTRACT_VALID'
    Assert-SelfTestRejected { Get-DysonConfigurationTransactionState `
        -Storage $liveDrift.storage -ServiceSid $script:ServiceSid `
        -Contract $script:Contract -ExpectedLauncherBindings $liveDriftProfile.bindings } `
        'COMPLETED_LIVE_DRIFT_REJECTED' '*TERMINAL_TARGET_INVALID*'

    $contractDrift = New-TestFixture 'completed-contract-drift'
    [void](Complete-TestCreate $contractDrift)
    $hashDriftContract = [pscustomobject][ordered]@{
        path = [string]$script:Contract.path
        sha256 = '0' * 64
        maximumBytes = [int]$script:Contract.maximumBytes
        allowedNames = $script:Contract.allowedNames
        dysonNames = @($script:Contract.dysonNames)
        requiredProductionNames = @($script:Contract.requiredProductionNames)
        launcherOwnedNames = @($script:Contract.launcherOwnedNames)
        secretNames = @($script:Contract.secretNames)
    }
    Assert-SelfTestRejected { Get-DysonConfigurationTransactionState `
        -Storage $contractDrift.storage -ServiceSid $script:ServiceSid `
        -Contract $hashDriftContract -ExpectedLauncherBindings $contractDrift.bindings } `
        'COMPLETED_CONTRACT_HASH_DRIFT_REJECTED' '*INTENT_BINDING_INVALID*'
    $shapeDriftContract = [pscustomobject][ordered]@{
        path = [string]$script:Contract.path
        sha256 = [string]$script:Contract.sha256
        maximumBytes = [int]$script:Contract.maximumBytes
        allowedNames = $script:Contract.allowedNames
        dysonNames = @($script:Contract.dysonNames)
        requiredProductionNames = @($script:Contract.requiredProductionNames)
        launcherOwnedNames = @($script:Contract.launcherOwnedNames) + @('DYSON_PROVIDER')
        secretNames = @($script:Contract.secretNames)
    }
    Assert-SelfTestRejected { Get-DysonConfigurationTransactionState `
        -Storage $contractDrift.storage -ServiceSid $script:ServiceSid `
        -Contract $shapeDriftContract -ExpectedLauncherBindings $contractDrift.bindings } `
        'COMPLETED_CONTRACT_SHAPE_DRIFT_REJECTED' '*BINDINGS_INVALID*'

    $orphanReceipt = New-TestFixture 'orphan-receipt'
    $foreignIntent = New-TestPendingIntent (New-TestFixture 'foreign-intent')
    $foreignReceipt = New-DysonConfigurationReceiptValue -Intent $foreignIntent.record `
        -IntentSha256 ([string]$foreignIntent.sha256) -State installed
    $orphanReceiptPath = Join-Path $orphanReceipt.storage.receiptsRoot `
        (([string]$foreignIntent.record.transactionId) + '.json')
    [void](Write-DysonConfigurationDurableJsonCreateNew -Path $orphanReceiptPath -Value $foreignReceipt)
    Assert-SelfTestRejected { Get-DysonConfigurationTransactionState -Storage $orphanReceipt.storage `
        -ServiceSid $script:ServiceSid -Contract $script:Contract `
        -ExpectedLauncherBindings $orphanReceipt.bindings } 'ORPHAN_RECEIPT' '*RECEIPT_CHAIN_INVALID*'

    $badChain = New-TestFixture 'bad-receipt-chain'
    $badChainIntent = New-TestPendingIntent $badChain
    $badReceipt = New-DysonConfigurationReceiptValue -Intent $badChainIntent.record `
        -IntentSha256 ('0' * 64) -State installed
    $badReceiptPath = Join-Path $badChain.storage.receiptsRoot `
        (([string]$badChainIntent.record.transactionId) + '.json')
    [void](Write-DysonConfigurationDurableJsonCreateNew -Path $badReceiptPath -Value $badReceipt)
    Assert-SelfTestRejected { Get-DysonConfigurationTransactionState -Storage $badChain.storage `
        -ServiceSid $script:ServiceSid -Contract $script:Contract `
        -ExpectedLauncherBindings $badChain.bindings } 'BAD_RECEIPT_CHAIN' '*RECEIPT_CHAIN_INVALID*'

    $earlyReceipt = New-TestFixture 'early-receipt'
    $earlyReceiptIntent = New-TestPendingIntent $earlyReceipt
    $earlyReceiptValue = New-DysonConfigurationReceiptValue -Intent $earlyReceiptIntent.record `
        -IntentSha256 ([string]$earlyReceiptIntent.sha256) -State installed
    $earlyReceiptValue.completedAt = '2000-01-01T00:00:00.0000000Z'
    $earlyReceiptPath = Join-Path $earlyReceipt.storage.receiptsRoot `
        (([string]$earlyReceiptIntent.record.transactionId) + '.json')
    [void](Write-DysonConfigurationDurableJsonCreateNew -Path $earlyReceiptPath -Value $earlyReceiptValue)
    Assert-SelfTestRejected { Get-DysonConfigurationTransactionState -Storage $earlyReceipt.storage `
        -ServiceSid $script:ServiceSid -Contract $script:Contract `
        -ExpectedLauncherBindings $earlyReceipt.bindings } 'EARLY_RECEIPT' '*RECEIPT_CHAIN_INVALID*'

    $duplicateReceipt = New-TestFixture 'duplicate-receipt-json'
    $duplicateReceiptIntent = New-TestPendingIntent $duplicateReceipt
    $duplicateReceiptValue = New-DysonConfigurationReceiptValue -Intent $duplicateReceiptIntent.record `
        -IntentSha256 ([string]$duplicateReceiptIntent.sha256) -State installed
    $duplicateReceiptJson = ConvertTo-DysonConfigurationJson $duplicateReceiptValue
    $duplicateReceiptJson = $duplicateReceiptJson.Substring(0, $duplicateReceiptJson.Length - 1) +
        ',"state":"installed"}' + "`n"
    $duplicateReceiptPath = Join-Path $duplicateReceipt.storage.receiptsRoot `
        (([string]$duplicateReceiptIntent.record.transactionId) + '.json')
    [System.IO.File]::WriteAllBytes($duplicateReceiptPath, (ConvertTo-TestBytes $duplicateReceiptJson))
    [void](Set-DysonConfigurationAcl -Path $duplicateReceiptPath -Kind PrivateFile)
    Assert-SelfTestRejected { Get-DysonConfigurationTransactionState `
        -Storage $duplicateReceipt.storage -ServiceSid $script:ServiceSid `
        -Contract $script:Contract -ExpectedLauncherBindings $duplicateReceipt.bindings } `
        'DUPLICATE_RECEIPT_JSON' '*RECORD_INVALID*'

    $badIntent = New-TestFixture 'bad-intent-binding'
    $badIntentValue = New-DysonConfigurationIntentValue -Storage $badIntent.storage `
        -Source $badIntent.source -Contract $script:Contract `
        -ExpectedLauncherBindings $badIntent.bindings -ServiceSid $script:ServiceSid `
        -Operation create -SourceKind configuration-source `
        -SourcePathSha256 (Get-DysonConfigurationSha256Text 'selftest-bad-intent-source') `
        -Sequence 1
    $badIntentValue.contractSha256 = '0' * 64
    $badIntentPath = Join-Path $badIntent.storage.intentsRoot `
        (([string]$badIntentValue.transactionId) + '.json')
    [void](Write-DysonConfigurationDurableJsonCreateNew -Path $badIntentPath -Value $badIntentValue)
    Assert-SelfTestRejected { Get-DysonConfigurationTransactionState -Storage $badIntent.storage `
        -ServiceSid $script:ServiceSid -Contract $script:Contract `
        -ExpectedLauncherBindings $badIntent.bindings } 'BAD_INTENT_BINDING' '*INTENT_BINDING_INVALID*'

    $badIntentType = New-TestFixture 'bad-intent-type'
    $badIntentTypeValue = New-DysonConfigurationIntentValue -Storage $badIntentType.storage `
        -Source $badIntentType.source -Contract $script:Contract `
        -ExpectedLauncherBindings $badIntentType.bindings -ServiceSid $script:ServiceSid `
        -Operation create -SourceKind configuration-source `
        -SourcePathSha256 (Get-DysonConfigurationSha256Text 'selftest-bad-intent-type-source') `
        -Sequence 1
    $badIntentTypeValue.preimagePresent = 'false'
    $badIntentTypePath = Join-Path $badIntentType.storage.intentsRoot `
        (([string]$badIntentTypeValue.transactionId) + '.json')
    [void](Write-DysonConfigurationDurableJsonCreateNew -Path $badIntentTypePath -Value $badIntentTypeValue)
    Assert-SelfTestRejected { Get-DysonConfigurationTransactionState -Storage $badIntentType.storage `
        -ServiceSid $script:ServiceSid -Contract $script:Contract `
        -ExpectedLauncherBindings $badIntentType.bindings } 'BAD_INTENT_TYPE' '*RECORD_INVALID*'

    $unknownConfig = New-TestFixture 'unknown-config-entry'
    $unknownPath = Join-Path $unknownConfig.storage.configRoot 'unexpected.fixture'
    [System.IO.File]::WriteAllBytes($unknownPath, (ConvertTo-TestBytes 'fixture'))
    $unknownPlan = Get-DysonConfigurationRecoveryPlan -Storage $unknownConfig.storage `
        -ServiceSid $script:ServiceSid -Contract $script:Contract `
        -ExpectedLauncherBindings $unknownConfig.bindings
    Assert-SelfTest ($unknownPlan.state -ceq 'blocked-orphan') 'UNKNOWN_CONFIG_BLOCKED'

    $snapshotFixture = New-TestFixture 'snapshot-target'
    [void](Complete-TestCreate $snapshotFixture)
    $snapshot = New-TestSnapshot -Fixture $snapshotFixture -Name 'snapshot-valid'
    $snapshotEvidence = Assert-DysonConfigurationSnapshot -SnapshotPath $snapshot.path `
        -Contract $script:Contract -ExpectedLauncherBindings $snapshotFixture.bindings `
        -ServiceSid $script:ServiceSid -ExpectedDataRoot $snapshotFixture.dataRoot
    Assert-SelfTest $snapshotEvidence.valid 'SNAPSHOT_VALID'
    $restorePlan = Get-DysonConfigurationSnapshotRestorePlan -SnapshotPath $snapshot.path `
        -DataRoot $snapshotFixture.dataRoot -Contract $script:Contract `
        -ExpectedLauncherBindings $snapshotFixture.bindings -ServiceSid $script:ServiceSid
    Assert-SelfTest ($restorePlan.state -ceq 'plan-only' -and
        -not $restorePlan.mutationPerformed -and -not $restorePlan.wouldReplace) 'RESTORE_PLAN_ONLY'

    $tamperedPayload = New-TestSnapshot -Fixture $snapshotFixture -Name 'snapshot-tampered-payload'
    [System.IO.File]::WriteAllBytes($tamperedPayload.payloadPath, (ConvertTo-TestBytes 'tampered'))
    Assert-SelfTestRejected { Assert-DysonConfigurationSnapshot -SnapshotPath $tamperedPayload.path `
        -Contract $script:Contract -ExpectedLauncherBindings $snapshotFixture.bindings `
        -ServiceSid $script:ServiceSid } 'SNAPSHOT_PAYLOAD_TAMPER' '*SNAPSHOT_INVALID*'
    [System.IO.Directory]::Delete($tamperedPayload.path, $true)

    $extraSnapshot = New-TestSnapshot -Fixture $snapshotFixture -Name 'snapshot-extra-file'
    [System.IO.File]::WriteAllBytes((Join-Path $extraSnapshot.path 'extra.fixture'), (ConvertTo-TestBytes 'x'))
    Assert-SelfTestRejected { Assert-DysonConfigurationSnapshot -SnapshotPath $extraSnapshot.path `
        -Contract $script:Contract -ExpectedLauncherBindings $snapshotFixture.bindings `
        -ServiceSid $script:ServiceSid } 'SNAPSHOT_EXTRA_FILE' '*SNAPSHOT_INVALID*'
    [System.IO.Directory]::Delete($extraSnapshot.path, $true)

    $traversalSnapshot = New-TestSnapshot -Fixture $snapshotFixture -Name 'snapshot-traversal'
    $traversalSnapshot.manifest.files[0].relativePath = '..\outside.fixture'
    [System.IO.File]::WriteAllBytes($traversalSnapshot.manifestPath,
        (ConvertTo-TestBytes ((ConvertTo-DysonConfigurationJson $traversalSnapshot.manifest) + "`n")))
    Assert-SelfTestRejected { Assert-DysonConfigurationSnapshot -SnapshotPath $traversalSnapshot.path `
        -Contract $script:Contract -ExpectedLauncherBindings $snapshotFixture.bindings `
        -ServiceSid $script:ServiceSid } 'SNAPSHOT_TRAVERSAL' '*SNAPSHOT_INVALID*'
    [System.IO.Directory]::Delete($traversalSnapshot.path, $true)

    $wrongProfileBindings = @{} + $snapshotFixture.bindings
    $wrongProfileBindings['DYSON_DATA_DIR'] = Join-Path $script:TestRoot 'wrong-profile\data'
    Assert-SelfTestRejected { Get-DysonConfigurationSnapshotRestorePlan `
        -SnapshotPath $snapshot.path -DataRoot $snapshotFixture.dataRoot -Contract $script:Contract `
        -ExpectedLauncherBindings $wrongProfileBindings -ServiceSid $script:ServiceSid } `
        'SNAPSHOT_PROFILE_BINDING' '*PROFILE_BINDING_INVALID*'

    $invalidSourceFixture = New-TestFixture 'invalid-source-preflight'
    $invalidSource = [pscustomobject][ordered]@{
        sha256 = [string]$invalidSourceFixture.source.sha256
        length = [int64]$invalidSourceFixture.source.length
        bindingsSha256 = [string]$invalidSourceFixture.source.bindingsSha256
        privateBytes = ConvertTo-TestBytes 'invalid-source-bytes'
    }
    Assert-SelfTestRejected {
        Invoke-DysonConfigurationMutationTransaction -Storage $invalidSourceFixture.storage `
            -Source $invalidSource -Contract $script:Contract `
            -ExpectedLauncherBindings $invalidSourceFixture.bindings `
            -ServiceSid $script:ServiceSid -Operation create `
            -SourceKind configuration-source `
            -SourcePathSha256 (Get-DysonConfigurationSha256Text 'invalid-source-path')
    } 'INVALID_SOURCE_PREFLIGHT' '*SOURCE_INVALID*'
    $invalidSourceState = Get-DysonConfigurationTransactionState `
        -Storage $invalidSourceFixture.storage -ServiceSid $script:ServiceSid `
        -Contract $script:Contract `
        -ExpectedLauncherBindings $invalidSourceFixture.bindings
    Assert-SelfTest $invalidSourceState.clean 'INVALID_SOURCE_NO_MUTATION'

    $script:DysonConfigurationSelfTestFaultsEnabled = $true
    $replacementCrashMatrix = [ordered]@{
        'after-intent' = 'resume-write'
        'after-stage' = 'finalize-replace'
        'after-publish' = 'finalize-backup-cleanup'
        'before-receipt' = 'finalize-receipt'
    }
    foreach ($crashPoint in @($replacementCrashMatrix.Keys)) {
        $fixture = New-TestFixture ('replace-crash-' + $crashPoint)
        [void](Complete-TestRuntimeCreate $fixture)
        Assert-SelfTest (Test-Path -LiteralPath (
            Join-Path $fixture.storage.configRoot $script:DysonConfigurationRuntimeApprovalName
        )) ('RUNTIME_APPROVAL_PRESENT_' + $crashPoint.ToUpperInvariant().Replace('-', '_'))
        $preimageSnapshotFixture = New-TestSnapshot -Fixture $fixture `
            -Name ('preimage-' + $crashPoint)
        $preimageSnapshot = Get-TestSnapshotEvidence -Fixture $fixture `
            -Snapshot $preimageSnapshotFixture
        $profileB = New-TestProfileSource -Fixture $fixture `
            -Name ('profile-b-' + $crashPoint) -Version '0.0.1-selftest-b'
        Assert-SelfTestRejected {
            Invoke-DysonConfigurationMutationTransaction -Storage $fixture.storage `
                -Source $profileB.source -Contract $script:Contract `
                -ExpectedLauncherBindings $profileB.bindings -ServiceSid $script:ServiceSid `
                -Operation replace -SourceKind configuration-source `
                -SourcePathSha256 $profileB.pathSha256 `
                -PreimageSnapshot $preimageSnapshot -SelfTestCrashPoint $crashPoint
        } ('REPLACE_CRASH_' + $crashPoint.ToUpperInvariant().Replace('-', '_')) `
            '*SELFTEST_CRASH*'
        Assert-SelfTest (-not (Test-Path -LiteralPath (
            Join-Path $fixture.storage.configRoot $script:DysonConfigurationRuntimeApprovalName
        ))) ('RUNTIME_APPROVAL_REVOKED_' + $crashPoint.ToUpperInvariant().Replace('-', '_'))
        $plan = Get-DysonConfigurationRecoveryPlan -Storage $fixture.storage `
            -ServiceSid $script:ServiceSid -Contract $script:Contract `
            -ExpectedLauncherBindings $profileB.bindings `
            -ExpectedPreimageSnapshot $preimageSnapshot
        Assert-SelfTest ([string]$plan.state -ceq [string]$replacementCrashMatrix[$crashPoint]) `
            ('REPLACE_PLAN_' + $crashPoint.ToUpperInvariant().Replace('-', '_'))
        $recovered = Invoke-DysonConfigurationMutationTransaction -Storage $fixture.storage `
            -Source $profileB.source -Contract $script:Contract `
            -ExpectedLauncherBindings $profileB.bindings -ServiceSid $script:ServiceSid `
            -Operation replace -SourceKind configuration-source `
            -SourcePathSha256 $profileB.pathSha256 -PreimageSnapshot $preimageSnapshot
        $target = Get-DysonConfigurationFileEvidence -Path $fixture.storage.configurationPath `
            -ServiceSid $script:ServiceSid -IncludePrivateBytes
        $chain = Get-DysonConfigurationTransactionState -Storage $fixture.storage `
            -ServiceSid $script:ServiceSid -Contract $script:Contract `
            -ExpectedLauncherBindings $profileB.bindings
        Assert-SelfTest ([string]$recovered.state -ceq 'recovered' -and
            [string]$target.sha256 -ceq [string]$profileB.source.sha256 -and
            [int64]$target.length -eq [int64]$profileB.source.length -and
            (Get-DysonConfigurationSha256Bytes ([byte[]]$target.privateBytes)) -ceq
                (Get-DysonConfigurationSha256Bytes ([byte[]]$profileB.bytes)) -and
            [string]$target.aclFingerprint -ceq
                [string](Get-DysonConfigurationAclPolicy -Kind ConfigFile `
                    -ServiceSid $script:ServiceSid).fingerprint -and
            $chain.clean -and $chain.receipts.Count -eq 2 -and
            [string]$chain.chainHeadSha256 -ceq [string]$recovered.chainHeadSha256) `
            ('REPLACE_EXACT_RECOVERY_' + $crashPoint.ToUpperInvariant().Replace('-', '_'))
    }

    $restoreCrashMatrix = [ordered]@{
        'after-intent' = 'resume-write'
        'after-stage' = 'finalize-replace'
        'after-publish' = 'finalize-backup-cleanup'
        'before-receipt' = 'finalize-receipt'
    }
    foreach ($crashPoint in @($restoreCrashMatrix.Keys)) {
        $scenario = New-TestRestoreCrashScenario ('restore-crash-' + $crashPoint)
        Assert-SelfTestRejected {
            Invoke-DysonConfigurationMutationTransaction `
                -Storage $scenario.fixture.storage -Source $scenario.sourceB `
                -Contract $script:Contract `
                -ExpectedLauncherBindings ([hashtable]$scenario.snapshotB.privateBindings) `
                -ServiceSid $script:ServiceSid -Operation restore `
                -SourceKind protected-snapshot `
                -SourcePathSha256 ([string]$scenario.snapshotB.payloadPathSha256) `
                -PreimageSnapshot $scenario.snapshotC -SourceSnapshot $scenario.snapshotB `
                -SelfTestCrashPoint $crashPoint
        } ('RESTORE_CRASH_' + $crashPoint.ToUpperInvariant().Replace('-', '_')) `
            '*SELFTEST_CRASH*'
        $restorePlan = Get-DysonConfigurationRecoveryPlan `
            -Storage $scenario.fixture.storage -ServiceSid $script:ServiceSid `
            -Contract $script:Contract `
            -ExpectedLauncherBindings ([hashtable]$scenario.snapshotB.privateBindings) `
            -ExpectedPreimageSnapshot $scenario.snapshotC `
            -ExpectedSourceSnapshot $scenario.snapshotB
        Assert-SelfTest ([string]$restorePlan.state -ceq
            [string]$restoreCrashMatrix[$crashPoint]) `
            ('RESTORE_PLAN_' + $crashPoint.ToUpperInvariant().Replace('-', '_'))
        $restored = Invoke-DysonConfigurationMutationTransaction `
            -Storage $scenario.fixture.storage -Source $scenario.sourceB `
            -Contract $script:Contract `
            -ExpectedLauncherBindings ([hashtable]$scenario.snapshotB.privateBindings) `
            -ServiceSid $script:ServiceSid -Operation restore `
            -SourceKind protected-snapshot `
            -SourcePathSha256 ([string]$scenario.snapshotB.payloadPathSha256) `
            -PreimageSnapshot $scenario.snapshotC -SourceSnapshot $scenario.snapshotB
        $restoredTarget = Get-DysonConfigurationFileEvidence `
            -Path $scenario.fixture.storage.configurationPath `
            -ServiceSid $script:ServiceSid -IncludePrivateBytes
        $restoredChain = Get-DysonConfigurationTransactionState `
            -Storage $scenario.fixture.storage -ServiceSid $script:ServiceSid `
            -Contract $script:Contract `
            -ExpectedLauncherBindings ([hashtable]$scenario.snapshotB.privateBindings)
        Assert-SelfTest ([string]$restored.state -ceq 'recovered' -and
            [string]$restored.receiptState -ceq 'restored' -and
            [string]$restoredTarget.sha256 -ceq [string]$scenario.snapshotB.configurationSha256 -and
            [int64]$restoredTarget.length -eq [int64]$scenario.snapshotB.configurationLength -and
            (Get-DysonConfigurationSha256Bytes ([byte[]]$restoredTarget.privateBytes)) -ceq
                (Get-DysonConfigurationSha256Bytes ([byte[]]$scenario.snapshotB.privateBytes)) -and
            [string]$restoredTarget.aclFingerprint -ceq
                [string]$scenario.snapshotB.configurationAclFingerprint -and
            $restoredChain.clean -and $restoredChain.receipts.Count -eq 4 -and
            [string]$restoredChain.chainHeadSha256 -ceq [string]$restored.chainHeadSha256) `
            ('RESTORE_EXACT_RECOVERY_' + $crashPoint.ToUpperInvariant().Replace('-', '_'))
    }

    $badReplacementTemp = New-TestFixture 'replace-bad-temp'
    [void](Complete-TestCreate $badReplacementTemp)
    $badTempSnapshotFixture = New-TestSnapshot -Fixture $badReplacementTemp -Name 'bad-temp-preimage'
    $badTempSnapshot = Get-TestSnapshotEvidence -Fixture $badReplacementTemp `
        -Snapshot $badTempSnapshotFixture
    $badTempProfile = New-TestProfileSource -Fixture $badReplacementTemp `
        -Name 'bad-temp-b' -Version '0.0.1-bad-temp'
    Assert-SelfTestRejected {
        Invoke-DysonConfigurationMutationTransaction -Storage $badReplacementTemp.storage `
            -Source $badTempProfile.source -Contract $script:Contract `
            -ExpectedLauncherBindings $badTempProfile.bindings -ServiceSid $script:ServiceSid `
            -Operation replace -SourceKind configuration-source `
            -SourcePathSha256 $badTempProfile.pathSha256 `
            -PreimageSnapshot $badTempSnapshot -SelfTestCrashPoint after-intent
    } 'BAD_REPLACEMENT_TEMP_INTENT' '*SELFTEST_CRASH*'
    $badTempState = Get-DysonConfigurationTransactionState -Storage $badReplacementTemp.storage `
        -ServiceSid $script:ServiceSid -Contract $script:Contract `
        -ExpectedLauncherBindings $badTempProfile.bindings `
        -ExpectedPreimageSnapshot $badTempSnapshot
    $badTempPath = Join-Path $badReplacementTemp.storage.configRoot `
        ([string]$badTempState.pending[0].record.temporaryName)
    [System.IO.File]::WriteAllBytes($badTempPath, (ConvertTo-TestBytes 'corrupt-staged-config'))
    [void](Set-DysonConfigurationAcl -Path $badTempPath -Kind ConfigFile `
        -ServiceSid $script:ServiceSid)
    $badTempPlan = Get-DysonConfigurationRecoveryPlan -Storage $badReplacementTemp.storage `
        -ServiceSid $script:ServiceSid -Contract $script:Contract `
        -ExpectedLauncherBindings $badTempProfile.bindings `
        -ExpectedPreimageSnapshot $badTempSnapshot
    Assert-SelfTest ([string]$badTempPlan.state -ceq 'abort-required') `
        'BAD_REPLACEMENT_TEMP_BLOCKED'
    $abortedReplacement = Invoke-DysonConfigurationMutationTransaction `
        -Storage $badReplacementTemp.storage -Source $badTempProfile.source `
        -Contract $script:Contract -ExpectedLauncherBindings $badTempProfile.bindings `
        -ServiceSid $script:ServiceSid -Operation replace -SourceKind configuration-source `
        -SourcePathSha256 $badTempProfile.pathSha256 -PreimageSnapshot $badTempSnapshot `
        -RecoveryAction Abort
    $abortedTarget = Get-DysonConfigurationFileEvidence `
        -Path $badReplacementTemp.storage.configurationPath -ServiceSid $script:ServiceSid
    Assert-SelfTest ([string]$abortedReplacement.receiptState -ceq 'aborted' -and
        [string]$abortedTarget.sha256 -ceq [string]$badTempSnapshot.configurationSha256 -and
        [string]$abortedTarget.aclFingerprint -ceq
            [string]$badTempSnapshot.configurationAclFingerprint) 'BAD_REPLACEMENT_TEMP_ABORT_EXACT'

    $createAbort = New-TestFixture 'create-bad-temp-abort'
    $createAbortPathSha256 = Get-DysonConfigurationSha256Text 'selftest-create-abort-source'
    Assert-SelfTestRejected {
        Invoke-DysonConfigurationMutationTransaction -Storage $createAbort.storage `
            -Source $createAbort.source -Contract $script:Contract `
            -ExpectedLauncherBindings $createAbort.bindings -ServiceSid $script:ServiceSid `
            -Operation create -SourceKind configuration-source `
            -SourcePathSha256 $createAbortPathSha256 -SelfTestCrashPoint after-intent
    } 'CREATE_BAD_TEMP_INTENT' '*SELFTEST_CRASH*'
    $createAbortState = Get-DysonConfigurationTransactionState -Storage $createAbort.storage `
        -ServiceSid $script:ServiceSid -Contract $script:Contract `
        -ExpectedLauncherBindings $createAbort.bindings
    $createAbortTemp = Join-Path $createAbort.storage.configRoot `
        ([string]$createAbortState.pending[0].record.temporaryName)
    [System.IO.File]::WriteAllBytes($createAbortTemp, (ConvertTo-TestBytes 'corrupt-create-stage'))
    [void](Set-DysonConfigurationAcl -Path $createAbortTemp -Kind ConfigFile `
        -ServiceSid $script:ServiceSid)
    $createAbortResult = Invoke-DysonConfigurationMutationTransaction `
        -Storage $createAbort.storage -Source $createAbort.source -Contract $script:Contract `
        -ExpectedLauncherBindings $createAbort.bindings -ServiceSid $script:ServiceSid `
        -Operation create -SourceKind configuration-source `
        -SourcePathSha256 $createAbortPathSha256 -RecoveryAction Abort
    $createAbortFinal = Get-DysonConfigurationTransactionState -Storage $createAbort.storage `
        -ServiceSid $script:ServiceSid -Contract $script:Contract `
        -ExpectedLauncherBindings $createAbort.bindings
    Assert-SelfTest ([string]$createAbortResult.receiptState -ceq 'aborted' -and
        [int64]$createAbortResult.configurationLength -eq 0 -and
        [string]$createAbortResult.configurationSha256 -ceq
            (Get-DysonConfigurationSha256Bytes ([byte[]]::new(0))) -and
        -not (Test-Path -LiteralPath $createAbort.storage.configurationPath) -and
        $createAbortFinal.clean) 'CREATE_BAD_TEMP_ABORT_EXACT'

    $unsafeAbort = New-TestFixture 'replace-bad-temp-tampered-target'
    [void](Complete-TestCreate $unsafeAbort)
    $unsafeAbortSnapshotFixture = New-TestSnapshot -Fixture $unsafeAbort `
        -Name 'unsafe-abort-preimage'
    $unsafeAbortSnapshot = Get-TestSnapshotEvidence -Fixture $unsafeAbort `
        -Snapshot $unsafeAbortSnapshotFixture
    $unsafeAbortProfile = New-TestProfileSource -Fixture $unsafeAbort `
        -Name 'unsafe-abort-b' -Version '0.0.1-unsafe-abort'
    Assert-SelfTestRejected {
        Invoke-DysonConfigurationMutationTransaction -Storage $unsafeAbort.storage `
            -Source $unsafeAbortProfile.source -Contract $script:Contract `
            -ExpectedLauncherBindings $unsafeAbortProfile.bindings -ServiceSid $script:ServiceSid `
            -Operation replace -SourceKind configuration-source `
            -SourcePathSha256 $unsafeAbortProfile.pathSha256 `
            -PreimageSnapshot $unsafeAbortSnapshot -SelfTestCrashPoint after-intent
    } 'UNSAFE_ABORT_INTENT' '*SELFTEST_CRASH*'
    $unsafeAbortState = Get-DysonConfigurationTransactionState -Storage $unsafeAbort.storage `
        -ServiceSid $script:ServiceSid -Contract $script:Contract `
        -ExpectedLauncherBindings $unsafeAbortProfile.bindings `
        -ExpectedPreimageSnapshot $unsafeAbortSnapshot
    $unsafeAbortTemp = Join-Path $unsafeAbort.storage.configRoot `
        ([string]$unsafeAbortState.pending[0].record.temporaryName)
    [System.IO.File]::WriteAllBytes($unsafeAbortTemp, (ConvertTo-TestBytes 'corrupt-stage'))
    [void](Set-DysonConfigurationAcl -Path $unsafeAbortTemp -Kind ConfigFile `
        -ServiceSid $script:ServiceSid)
    [System.IO.File]::WriteAllBytes($unsafeAbort.storage.configurationPath,
        (ConvertTo-TestBytes 'tampered-live-target'))
    $unsafeAbortPlan = Get-DysonConfigurationRecoveryPlan -Storage $unsafeAbort.storage `
        -ServiceSid $script:ServiceSid -Contract $script:Contract `
        -ExpectedLauncherBindings $unsafeAbortProfile.bindings `
        -ExpectedPreimageSnapshot $unsafeAbortSnapshot
    Assert-SelfTest ([string]$unsafeAbortPlan.state -ceq 'blocked-target-mismatch') `
        'BAD_TEMP_TAMPERED_TARGET_BLOCKED'
    Assert-SelfTestRejected {
        Invoke-DysonConfigurationMutationTransaction -Storage $unsafeAbort.storage `
            -Source $unsafeAbortProfile.source -Contract $script:Contract `
            -ExpectedLauncherBindings $unsafeAbortProfile.bindings -ServiceSid $script:ServiceSid `
            -Operation replace -SourceKind configuration-source `
            -SourcePathSha256 $unsafeAbortProfile.pathSha256 `
            -PreimageSnapshot $unsafeAbortSnapshot -RecoveryAction Abort
    } 'BAD_TEMP_TAMPERED_TARGET_ABORT_REJECTED' '*RECOVERY_BLOCKED_TARGET_MISMATCH*'
    $unsafeAbortAfter = Get-DysonConfigurationTransactionState -Storage $unsafeAbort.storage `
        -ServiceSid $script:ServiceSid -Contract $script:Contract `
        -ExpectedLauncherBindings $unsafeAbortProfile.bindings `
        -ExpectedPreimageSnapshot $unsafeAbortSnapshot
    Assert-SelfTest ((Test-Path -LiteralPath $unsafeAbortTemp -PathType Leaf) -and
        $unsafeAbortAfter.pending.Count -eq 1 -and $unsafeAbortAfter.receipts.Count -eq 1) `
        'BAD_TEMP_TAMPERED_TARGET_PRESERVED'

    $roundTrip = New-TestFixture 'replace-restore-roundtrip'
    [void](Complete-TestCreate $roundTrip)
    $snapshotAFixture = New-TestSnapshot -Fixture $roundTrip -Name 'roundtrip-a'
    $snapshotA = Get-TestSnapshotEvidence -Fixture $roundTrip -Snapshot $snapshotAFixture
    $profileB = New-TestProfileSource -Fixture $roundTrip -Name 'roundtrip-b' `
        -Version '0.0.1-roundtrip-b'
    $replaceB = Invoke-DysonConfigurationMutationTransaction -Storage $roundTrip.storage `
        -Source $profileB.source -Contract $script:Contract `
        -ExpectedLauncherBindings $profileB.bindings -ServiceSid $script:ServiceSid `
        -Operation replace -SourceKind configuration-source `
        -SourcePathSha256 $profileB.pathSha256 -PreimageSnapshot $snapshotA
    $snapshotBFixture = New-TestSnapshot -Fixture ([pscustomobject]@{
        storage = $roundTrip.storage; bindings = $profileB.bindings
    }) -Name 'roundtrip-b-snapshot'
    $snapshotB = Read-DysonConfigurationSnapshotInternal -SnapshotPath $snapshotBFixture.path `
        -Contract $script:Contract -ServiceSid $script:ServiceSid `
        -ExpectedDataRoot $roundTrip.dataRoot -IncludePrivateBytes
    $profileC = New-TestProfileSource -Fixture $roundTrip -Name 'roundtrip-c' `
        -Version '0.0.2-roundtrip-c'
    $replaceC = Invoke-DysonConfigurationMutationTransaction -Storage $roundTrip.storage `
        -Source $profileC.source -Contract $script:Contract `
        -ExpectedLauncherBindings $profileC.bindings -ServiceSid $script:ServiceSid `
        -Operation replace -SourceKind configuration-source `
        -SourcePathSha256 $profileC.pathSha256 -PreimageSnapshot $snapshotB
    $snapshotCFixture = New-TestSnapshot -Fixture ([pscustomobject]@{
        storage = $roundTrip.storage; bindings = $profileC.bindings
    }) -Name 'roundtrip-c-snapshot'
    $snapshotC = Get-TestSnapshotEvidence -Fixture $roundTrip -Snapshot $snapshotCFixture
    $snapshotBSource = [pscustomobject][ordered]@{
        sha256 = [string]$snapshotB.configurationSha256
        length = [int64]$snapshotB.configurationLength
        bindingsSha256 = [string]$snapshotB.bindingsSha256
        privateBytes = [byte[]]$snapshotB.privateBytes
    }
    $restoreB = Invoke-DysonConfigurationMutationTransaction -Storage $roundTrip.storage `
        -Source $snapshotBSource -Contract $script:Contract `
        -ExpectedLauncherBindings ([hashtable]$snapshotB.privateBindings) `
        -ServiceSid $script:ServiceSid -Operation restore -SourceKind protected-snapshot `
        -SourcePathSha256 ([string]$snapshotB.payloadPathSha256) `
        -PreimageSnapshot $snapshotC -SourceSnapshot $snapshotB
    $restoredTarget = Get-DysonConfigurationFileEvidence -Path $roundTrip.storage.configurationPath `
        -ServiceSid $script:ServiceSid -IncludePrivateBytes
    $restoredChain = Get-DysonConfigurationTransactionState -Storage $roundTrip.storage `
        -ServiceSid $script:ServiceSid -Contract $script:Contract `
        -ExpectedLauncherBindings ([hashtable]$snapshotB.privateBindings)
    Assert-SelfTest ([string]$replaceB.receiptState -ceq 'replaced' -and
        [string]$replaceC.receiptState -ceq 'replaced' -and
        [string]$restoreB.receiptState -ceq 'restored' -and
        [string]$restoredTarget.sha256 -ceq [string]$snapshotB.configurationSha256 -and
        (Get-DysonConfigurationSha256Bytes ([byte[]]$restoredTarget.privateBytes)) -ceq
            (Get-DysonConfigurationSha256Bytes ([byte[]]$snapshotB.privateBytes)) -and
        [string]$restoredTarget.aclFingerprint -ceq
            [string]$snapshotB.configurationAclFingerprint -and
        $restoredChain.clean -and $restoredChain.receipts.Count -eq 4 -and
        [string]$restoredChain.chainHeadSha256 -ceq [string]$restoreB.chainHeadSha256) `
        'A_B_C_READINESS_ROLLBACK_B_EXACT'
    $publicRoundTrip = @($replaceB, $replaceC, $restoreB) | ConvertTo-Json -Depth 6 -Compress
    Assert-SelfTest (-not $publicRoundTrip.Contains($script:SecretSentinel)) `
        'REPLACEMENT_RESTORE_PUBLIC_EVIDENCE_REDACTED'
    $receiptText = [string]::Join("`n", @(Get-ChildItem `
        -LiteralPath $roundTrip.storage.receiptsRoot -File | Sort-Object Name | ForEach-Object {
            [System.IO.File]::ReadAllText($_.FullName)
        }))
    Assert-SelfTest (-not $receiptText.Contains($script:SecretSentinel)) `
        'RECEIPT_CHAIN_SECRET_FREE'

    $runtimeFixture = New-TestFixture 'runtime-approval'
    [void](Complete-TestRuntimeCreate $runtimeFixture)
    $runtimeParentAcl = Assert-DysonConfigurationParentAcl -Path $runtimeFixture.dataRoot -ServiceSid $script:ServiceSid
    $runtimeResult = Test-DysonConfigurationRuntimeApproval -Storage $runtimeFixture.storage `
        -Contract $script:Contract -ExpectedLauncherBindings $runtimeFixture.bindings `
        -ServiceSid $script:ServiceSid -ParentAcl $runtimeParentAcl
    Assert-SelfTest ($runtimeResult.healthy -and
        $runtimeResult.protocol -ceq 'DYSON_CONTROL_CONFIGURATION_RUNTIME_TEST_RESULT_V1') 'RUNTIME_APPROVAL_VALID'
    $runtimeApprovalPath = Join-Path $runtimeFixture.storage.configRoot $script:DysonConfigurationRuntimeApprovalName
    $runtimeApprovalText = [IO.File]::ReadAllText($runtimeApprovalPath)
    Assert-SelfTest (-not $runtimeApprovalText.Contains($script:SecretSentinel)) 'RUNTIME_APPROVAL_SECRET_FREE'
    $tamperedApproval = $runtimeApprovalText | ConvertFrom-Json
    $tamperedApproval.configurationSha256 = '0' * 64
    [IO.File]::WriteAllText($runtimeApprovalPath, ($tamperedApproval | ConvertTo-Json -Compress), $script:Utf8)
    Assert-SelfTestRejected {
        Test-DysonConfigurationRuntimeApproval -Storage $runtimeFixture.storage `
            -Contract $script:Contract -ExpectedLauncherBindings $runtimeFixture.bindings `
            -ServiceSid $script:ServiceSid -ParentAcl $runtimeParentAcl
    } 'RUNTIME_APPROVAL_MISMATCH_REJECTED' '*RUNTIME_APPROVAL_MISMATCH*'
    [IO.File]::Delete($runtimeApprovalPath)
    Assert-SelfTestRejected {
        Test-DysonConfigurationRuntimeApproval -Storage $runtimeFixture.storage `
            -Contract $script:Contract -ExpectedLauncherBindings $runtimeFixture.bindings `
            -ServiceSid $script:ServiceSid -ParentAcl $runtimeParentAcl
    } 'RUNTIME_APPROVAL_ABSENT_REJECTED'

    $installAst = Get-SelfTestPowerShellAst `
        (Join-Path $PSScriptRoot 'Install-DysonControlConfiguration.ps1')
    $commonAst = Get-SelfTestPowerShellAst `
        (Join-Path $PSScriptRoot 'DysonConfiguration.Common.ps1')
    $snapshotAst = Get-SelfTestPowerShellAst `
        (Join-Path $PSScriptRoot 'New-DysonControlConfigurationSnapshot.ps1')
    $restoreAst = Get-SelfTestPowerShellAst `
        (Join-Path $PSScriptRoot 'Restore-DysonControlConfiguration.ps1')
    $testAst = Get-SelfTestPowerShellAst `
        (Join-Path $PSScriptRoot 'Test-DysonControlConfiguration.ps1')
    Assert-SelfTest ((Test-SelfTestAstSupportsShouldProcess $installAst) -and
        (Test-SelfTestAstParameter -Ast $installAst -Name 'ProtectedPreimageSnapshotPath') -and
        (Test-SelfTestAstCommand -Ast $installAst `
            -Name 'Invoke-DysonConfigurationMutationTransaction')) `
        'INSTALL_PROTECTED_REPLACEMENT'
    Assert-SelfTest ((Test-SelfTestAstFunction -Ast $commonAst `
            -Name 'Write-DysonConfigurationDurableJsonCreateNew') -and
        (Test-SelfTestAstFunction -Ast $commonAst `
            -Name 'Write-DysonConfigurationStagedFile') -and
        (Test-SelfTestAstFunction -Ast $commonAst `
            -Name 'Write-DysonConfigurationTransactionReceipt')) 'INSTALL_DURABLE_CHAIN'
    Assert-SelfTest ((Test-SelfTestAstStaticMemberInvocation -Ast $commonAst `
            -TypeName 'System.IO.File' -MemberName 'Move') -and
        (Test-SelfTestAstStaticMemberInvocation -Ast $commonAst `
            -TypeName 'System.IO.File' -MemberName 'Replace') -and
        (Test-SelfTestAstFunction -Ast $commonAst `
            -Name 'Get-DysonConfigurationTransactionState')) `
        'ATOMIC_WRITE_CONTRACT'
    Assert-SelfTest ((Test-SelfTestAstSupportsShouldProcess $snapshotAst) -and
        (Test-SelfTestAstCommand -Ast $snapshotAst `
            -Name 'Enter-DysonConfigurationMutationLock') -and
        (Test-SelfTestAstCommand -Ast $snapshotAst `
            -Name 'New-DysonConfigurationProtectedSnapshot')) `
        'SNAPSHOT_EXECUTOR_WIRED'
    Assert-SelfTest ((Test-SelfTestAstSupportsShouldProcess $restoreAst) -and
        (Test-SelfTestAstParameter -Ast $restoreAst -Name 'ProtectedSnapshotPath') -and
        (Test-SelfTestAstParameter -Ast $restoreAst -Name 'CurrentProtectedSnapshotPath') -and
        (Test-SelfTestAstCommandLiteralArgument -Ast $restoreAst `
            -CommandName 'Invoke-DysonConfigurationMutationTransaction' `
            -ParameterName 'Operation' -ExpectedValue 'restore')) 'RESTORE_EXECUTOR_WIRED'
    Assert-SelfTest ((Test-SelfTestAstCommand -Ast $testAst `
            -Name 'Enter-DysonConfigurationMutationLock') -and
        (Test-SelfTestAstCommand -Ast $testAst `
            -Name 'Get-DysonConfigurationTransactionState') -and
        (Test-SelfTestAstCommandParameter -Ast $testAst `
            -CommandName 'Get-DysonConfigurationTransactionState' `
            -ParameterName 'LockHeld')) 'TEST_EXECUTOR_LOCKED_STATE_WIRED'

    $summary = [pscustomobject][ordered]@{
        protocol = 'DYSON_CONTROL_CONFIGURATION_SELFTEST_V1'
        passed = $true
        tests = $script:TestCount
        apiDysonKeyCount = $apiNames.Count
        contractSha256 = [string]$script:Contract.sha256
        aclIntegration = if ($aclIntegration) { 'real' } else { 'policy-and-selftest-seam' }
        secretDisclosure = $false
        productionMutation = $false
    }
    $serialized = $summary | ConvertTo-Json -Compress
    if ($serialized.Contains($script:SecretSentinel)) {
        throw 'DYSON_CONFIGURATION_SELFTEST_SECRET_DISCLOSURE'
    }
    $summary
}
finally {
    if (Test-Path -LiteralPath $script:TestRoot) {
        if (-not (Test-DysonConfigurationPathWithin -Candidate $script:TestRoot -Parent $tempBase)) {
            throw 'DYSON_CONFIGURATION_SELFTEST_CLEANUP_PATH_INVALID'
        }
        $extendedTestRoot = ConvertTo-DysonConfigurationExtendedPath $script:TestRoot
        $cleanupReparsePoints = @(Get-ChildItem -LiteralPath $extendedTestRoot -Force -Recurse |
            Where-Object { $_.Attributes -band [System.IO.FileAttributes]::ReparsePoint })
        if ($cleanupReparsePoints.Count -gt 0) {
            throw 'DYSON_CONFIGURATION_SELFTEST_CLEANUP_REPARSE_POINT'
        }
        [System.IO.Directory]::Delete($extendedTestRoot, $true)
    }
}
