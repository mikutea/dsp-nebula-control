[CmdletBinding()]
param()

Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)

$migrationRoot = $PSScriptRoot
$windowsRoot = Split-Path $migrationRoot -Parent
$removeScript = Join-Path $migrationRoot 'Remove-DysonGsManagerInstallation.ps1'
$restoreScript = Join-Path $migrationRoot 'Restore-DysonGsManagerRemoval.ps1'
$inspectScript = Join-Path $migrationRoot 'Test-DysonGsManagerRemoval.ps1'
$migrationCommon = Join-Path $migrationRoot 'DysonGsManagerMigration.Common.ps1'
$removalCommon = Join-Path $migrationRoot 'DysonGsManagerRemoval.Common.ps1'
$cutoverCommon = Join-Path $windowsRoot 'cutover\DysonCutoverHost.Common.ps1'
$leaseCommon = Join-Path $windowsRoot 'DysonHostMutationLease.Common.ps1'
$powershell = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
$testRoot = Join-Path ([IO.Path]::GetTempPath()) ('r-' + [guid]::NewGuid().ToString('N'))
$tests = [Collections.Generic.List[string]]::new()

function Assert-SelfTest {
    param([Parameter(Mandatory)][bool]$Condition, [Parameter(Mandatory)][string]$Message)
    if (-not $Condition) { throw ('SELFTEST_FAILED: ' + $Message) }
}

function Write-SelfTestText {
    param([Parameter(Mandatory)][string]$Path, [Parameter(Mandatory)][AllowEmptyString()][string]$Text)
    [IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($Path)) | Out-Null
    [IO.File]::WriteAllText($Path, $Text, [Text.UTF8Encoding]::new($false))
}

function Write-SelfTestJson {
    param([Parameter(Mandatory)][string]$Path, [Parameter(Mandatory)]$Value)
    Write-SelfTestText $Path (($Value | ConvertTo-Json -Depth 32 -Compress) + "`n")
}

function ConvertTo-SelfTestNativeArgument {
    param([Parameter(Mandatory)][AllowEmptyString()][string]$Value)
    if ($Value -notmatch '[\s"]') { return $Value }
    return '"' + ($Value -replace '(\\*)"', '$1$1\"' -replace '(\\+)$', '$1$1') + '"'
}

function Invoke-SelfTestChild {
    param([Parameter(Mandatory)][string]$Script, [Parameter(Mandatory)][string[]]$Arguments)
    $native = @('-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', $Script) + $Arguments
    $info = [Diagnostics.ProcessStartInfo]::new()
    $info.FileName = $powershell
    $info.Arguments = (($native | ForEach-Object { ConvertTo-SelfTestNativeArgument ([string]$_) }) -join ' ')
    $info.WorkingDirectory = $testRoot
    $info.UseShellExecute = $false
    $info.CreateNoWindow = $true
    $info.RedirectStandardOutput = $true
    $info.RedirectStandardError = $true
    $process = [Diagnostics.Process]::new()
    $process.StartInfo = $info
    if (-not $process.Start()) { throw 'SELFTEST_FAILED: child did not start' }
    try {
        $stdout = $process.StandardOutput.ReadToEndAsync()
        $stderr = $process.StandardError.ReadToEndAsync()
        if (-not $process.WaitForExit(45000)) {
            try { $process.Kill() } catch { }
            throw 'SELFTEST_FAILED: child timed out'
        }
        $process.WaitForExit()
        return [pscustomobject][ordered]@{
            exitCode = [int]$process.ExitCode
            stdout = [string]$stdout.GetAwaiter().GetResult()
            stderr = [string]$stderr.GetAwaiter().GetResult()
        }
    }
    finally { $process.Dispose() }
}

function Assert-SelfTestNoLeak {
    param([Parameter(Mandatory)]$Result)
    $combined = [string]$Result.stdout + [string]$Result.stderr
    Assert-SelfTest (-not $combined.Contains($testRoot)) 'child output leaked fixture root'
    Assert-SelfTest (-not $combined.Contains('fictional-project')) 'child output leaked a fixture segment'
    Assert-SelfTest ([Text.Encoding]::UTF8.GetByteCount($combined) -le 65536) 'child output exceeded bound'
}

function Assert-SelfTestFailure {
    param([Parameter(Mandatory)]$Result, [Parameter(Mandatory)][string]$Code)
    Assert-SelfTest ($Result.exitCode -ne 0) ('expected failure was successful: ' + $Code)
    Assert-SelfTestNoLeak $Result
    Assert-SelfTest ([string]$Result.stdout -eq '') 'failure emitted stdout'
    Assert-SelfTest (([string]$Result.stderr).Trim() -ceq $Code) `
        ('unexpected failure code: ' + ([string]$Result.stderr).Trim() + ' expected ' + $Code)
}

function Assert-SelfTestSuccess {
    param([Parameter(Mandatory)]$Result, [Parameter(Mandatory)][string]$Status)
    Assert-SelfTest ($Result.exitCode -eq 0) ('success command failed: ' + ([string]$Result.stderr).Trim())
    Assert-SelfTestNoLeak $Result
    Assert-SelfTest ([string]$Result.stderr -eq '') 'success emitted stderr'
    try { $value = [string]$Result.stdout | ConvertFrom-Json -ErrorAction Stop }
    catch { throw 'SELFTEST_FAILED: success emitted invalid JSON' }
    Assert-SelfTest ([string]$value.status -ceq $Status) ('unexpected success status: ' + [string]$value.status)
    return $value
}

function New-SelfTestCandidateDescriptors {
    param([Parameter(Mandatory)][bool]$Enabled, [Parameter(Mandatory)]$Fixture)
    $powerShellPath = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
    return [pscustomobject][ordered]@{
        start = [pscustomobject][ordered]@{
            taskName = 'Dyson-Nebula-Server'; taskPath = '\'; execute = $powerShellPath
            arguments = ('-NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "{0}" -ProjectRoot "{1}" -Ups 60' -f (Join-Path $Fixture.bootstrapRoot 'Start-DysonServer.ps1'), $Fixture.projectRoot)
            userId = $Fixture.serviceUser; logonType = 'Interactive'; runLevel = 'Limited'
            trigger = 'AtLogOn'; triggerUserId = $Fixture.serviceUser; triggerDelay = 'PT20S'
            executionTimeLimit = 'PT0S'; multipleInstances = 'IgnoreNew'; restartCount = 3
            restartInterval = 'PT1M'; startWhenAvailable = $true; enabled = $Enabled
            taskSecurityDescriptor = 'O:SYG:SYD:P(A;;GA;;;SY)(A;;GA;;;BA)(A;;GRGX;;;LS)'
            description = 'Starts DSP, BepInEx, Nebula, and the Dyson Control bridge from the stable bootstrap root.'
        }
        stop = [pscustomobject][ordered]@{
            taskName = 'Dyson-Nebula-Stop'; taskPath = '\'; execute = $powerShellPath
            arguments = ('-NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "{0}" -ProjectRoot "{1}" -TimeoutSeconds 150' -f (Join-Path $Fixture.bootstrapRoot 'Stop-DysonServer.ps1'), $Fixture.projectRoot)
            userId = $Fixture.serviceUser; logonType = 'Interactive'; runLevel = 'Limited'
            trigger = 'None'; triggerUserId = $null; triggerDelay = $null; executionTimeLimit = 'PT5M'
            multipleInstances = 'IgnoreNew'; restartCount = 0; restartInterval = $null
            startWhenAvailable = $false; enabled = $Enabled
            taskSecurityDescriptor = 'O:SYG:SYD:P(A;;GA;;;SY)(A;;GA;;;BA)(A;;GRGX;;;LS)'
            description = 'Sends a graceful console stop to the exact managed DSP process; never force-kills on timeout.'
        }
    }
}

function New-SelfTestTask {
    param([string]$Name, [string]$Xml, [bool]$Enabled, [bool]$Running, [AllowNull()]$Descriptor)
    return [pscustomobject][ordered]@{
        taskName = $Name; taskPath = '\'
        xmlBase64 = [Convert]::ToBase64String([Text.UTF8Encoding]::new($false).GetBytes($Xml))
        enabled = $Enabled; running = $Running; descriptor = $Descriptor
    }
}

function Read-SelfTestTasks {
    param([Parameter(Mandatory)]$Fixture)
    return (Get-Content -LiteralPath (Join-Path $Fixture.shadowRoot 'tasks.json') -Raw -Encoding UTF8 | ConvertFrom-Json)
}

function Write-SelfTestTasks {
    param([Parameter(Mandatory)]$Fixture, [Parameter(Mandatory)][object[]]$Tasks)
    Write-SelfTestJson (Join-Path $Fixture.shadowRoot 'tasks.json') `
        ([pscustomobject][ordered]@{ protocol = 'DYSON_CONTROL_CUTOVER_HOST_SHADOW_TASKS_V1'; tasks = @($Tasks) })
}

function Set-SelfTestCandidateState {
    param([Parameter(Mandatory)]$Fixture, [ValidateSet('active', 'prepared')][string]$State)
    $tasks = Read-SelfTestTasks $Fixture
    $expected = New-SelfTestCandidateDescriptors -Enabled:($State -ceq 'active') -Fixture $Fixture
    foreach ($pair in @(@('Dyson-Nebula-Server', $expected.start), @('Dyson-Nebula-Stop', $expected.stop))) {
        $task = @($tasks.tasks | Where-Object { [string]$_.taskName -ceq [string]$pair[0] })[0]
        $task.enabled = ($State -ceq 'active')
        $task.descriptor = $pair[1]
    }
    Write-SelfTestTasks -Fixture $Fixture -Tasks @($tasks.tasks)
}

function Write-SelfTestCutoverRuntime {
    param([Parameter(Mandatory)]$Fixture, [ValidateSet('candidate', 'stopped', 'unknown')][string]$State)
    $processes = @(); $processId = $null; $tcp = @(); $udp = @()
    if ($State -ne 'stopped') {
        $processes = @([pscustomobject][ordered]@{ id = 4242; path = (Join-Path $Fixture.projectRoot 'server\DSPGAME.exe') })
        $processId = 4242; $tcp = @(4242); $udp = @(4242)
    }
    if ($State -ceq 'unknown') { $udp = @(9999) }
    Write-SelfTestJson (Join-Path $Fixture.shadowRoot 'runtime.json') ([pscustomobject][ordered]@{
        protocol = 'DYSON_CONTROL_CUTOVER_HOST_SHADOW_RUNTIME_V1'
        dspProcesses = $processes; pidRecord = $processId; tcpOwners = $tcp; udpOwners = $udp
    })
    $ownerFile = Join-Path $Fixture.profileRoot 'runtime-owner.json'
    if ($State -ceq 'candidate') {
        Write-SelfTestJson $ownerFile ([pscustomobject][ordered]@{
            protocol = 'DYSON_CONTROL_CUTOVER_RUNTIME_OWNER_V1'; schemaVersion = 1
            authorityInventoryRevision = $Fixture.inventoryRevision; owner = 'candidate'; pid = 4242
            processIdentity = Get-CutoverHostPathIdentity (Join-Path $Fixture.projectRoot 'server\DSPGAME.exe')
        })
    }
    elseif (Test-Path -LiteralPath $ownerFile -PathType Leaf) { Remove-Item -LiteralPath $ownerFile -Force }
}

function Write-SelfTestGsRuntime {
    param([Parameter(Mandatory)]$Fixture, [switch]$Active)
    [object[]]$processes = @()
    [int[]]$tcpOwners = @()
    if ($Active) {
        $processes = @([pscustomobject][ordered]@{ id = 5151; path = (Join-Path $Fixture.gsManagerRoot 'gsmanager.exe'); commandLine = 'fictional' })
        $tcpOwners = @(5151)
    }
    Write-SelfTestJson (Join-Path $Fixture.shadowRoot 'gsmanager-runtime.json') ([pscustomobject][ordered]@{
        protocol = 'DYSON_GSMANAGER_REMOVAL_SHADOW_RUNTIME_V1'
        processes = [object[]]$processes; tcpOwners = [int[]]$tcpOwners; udpOwners = [int[]]@()
    })
}

function New-SelfTestProtection {
    param([Parameter(Mandatory)]$Fixture)
    $id = [guid]::NewGuid().ToString('D').ToLowerInvariant()
    $root = Join-Path $Fixture.projectRoot ('backups\saves\tx-' + $id)
    [IO.Directory]::CreateDirectory($root) | Out-Null
    Write-SelfTestText (Join-Path $root 'FictionalSave.dsv') 'paired-save-primary'
    Write-SelfTestText (Join-Path $root 'FictionalSave.server') 'paired-save-server'
    $manifest = [ordered]@{
        protocol = 'DYSON_CONTROL_PROTECTION_V1'; schemaVersion = 1; requestId = $id
        createdAt = [DateTime]::UtcNow.ToString('o'); saveName = 'FictionalSave'
        files = @(
            [ordered]@{ name = 'FictionalSave.dsv'; bytes = 19; sha256 = Get-DysonGsSha256 (Join-Path $root 'FictionalSave.dsv') },
            [ordered]@{ name = 'FictionalSave.server'; bytes = 18; sha256 = Get-DysonGsSha256 (Join-Path $root 'FictionalSave.server') }
        )
    }
    Write-SelfTestJson (Join-Path $root 'manifest.json') $manifest
    $Fixture.protectionPointId = 'save:' + $id
    $Fixture.protectionManifestSha256 = Get-DysonGsSha256 (Join-Path $root 'manifest.json')
}

function New-SelfTestProfile {
    param([Parameter(Mandatory)]$Fixture)
    $tasks = (Read-SelfTestTasks $Fixture).tasks
    $taskProfile = {
        param([string]$Name)
        $task = @($tasks | Where-Object { [string]$_.taskName -ceq $Name })[0]
        [pscustomobject][ordered]@{
            taskName = $Name; taskPath = '\'
            definitionSha256 = Get-CutoverHostSha256Bytes ([Convert]::FromBase64String([string]$task.xmlBase64))
            enabled = $true
        }
    }
    $prepared = New-SelfTestCandidateDescriptors -Enabled:$false -Fixture $Fixture
    $active = New-SelfTestCandidateDescriptors -Enabled:$true -Fixture $Fixture
    $dataInfo = Get-DysonHostMutationLeasePathInfo -DataRoot $Fixture.dataRoot
    $core = [pscustomobject][ordered]@{
        protocol = 'DYSON_GSMANAGER_AUTHORITY_PROFILE_V1'; schemaVersion = 1
        requestId = [guid]::NewGuid().ToString('D').ToLowerInvariant(); requestFingerprint = ('1' * 64)
        projectRootIdentity = Get-CutoverHostPathIdentity $Fixture.projectRoot
        dataRootIdentity = [string]$dataInfo.DataRootIdentity
        authorityRootIdentity = Get-CutoverHostPathIdentity $Fixture.profileRoot
        runtimeBootstrapIdentity = Get-CutoverHostPathIdentity $Fixture.bootstrapRoot
        runtimeBootstrapStartSha256 = Get-CutoverHostSha256File (Join-Path $Fixture.bootstrapRoot 'Start-DysonServer.ps1')
        runtimeBootstrapStopSha256 = Get-CutoverHostSha256File (Join-Path $Fixture.bootstrapRoot 'Stop-DysonServer.ps1')
        runtimeTaskTransactionRootIdentity = Get-CutoverHostPathIdentity $Fixture.transactionRoot
        serviceUser = $Fixture.serviceUser; gamePort = $Fixture.gamePort
        previousAuthority = [pscustomobject][ordered]@{
            main = & $taskProfile 'Dyson-GSManager'; start = & $taskProfile 'Dyson-GSManager-Server'; stop = & $taskProfile 'Dyson-GSManager-Stop'
        }
        candidateAuthority = [pscustomobject][ordered]@{
            startTaskName = 'Dyson-Nebula-Server'; stopTaskName = 'Dyson-Nebula-Stop'; taskPath = '\'
            legacyPreimage = [pscustomobject][ordered]@{
                startDefinitionSha256 = (& $taskProfile 'Dyson-Nebula-Server').definitionSha256
                stopDefinitionSha256 = (& $taskProfile 'Dyson-Nebula-Stop').definitionSha256
                expectedEnabledBeforeIsolation = $true; expectedEnabledAfterIsolation = $false
            }
            expectedPreparedDisabled = [pscustomobject][ordered]@{
                startDescriptorSha256 = Get-CutoverHostSha256Text (ConvertTo-CutoverHostJson $prepared.start)
                stopDescriptorSha256 = Get-CutoverHostSha256Text (ConvertTo-CutoverHostJson $prepared.stop)
            }
            expectedActive = [pscustomobject][ordered]@{
                startDescriptorSha256 = Get-CutoverHostSha256Text (ConvertTo-CutoverHostJson $active.start)
                stopDescriptorSha256 = Get-CutoverHostSha256Text (ConvertTo-CutoverHostJson $active.stop)
            }
            allowedTransitions = @('legacy-preimage-disabled', 'prepared-disabled', 'active')
        }
        previousScriptBundleRevision = Get-CutoverHostSha256Text (
            (Get-CutoverHostSha256File (Join-Path $Fixture.previousRoot 'start-dyson-server.ps1')) + ':' +
            (Get-CutoverHostSha256File (Join-Path $Fixture.previousRoot 'stop-dyson-server.ps1'))
        )
    }
    $profile = [ordered]@{}
    foreach ($property in $core.PSObject.Properties) { $profile[$property.Name] = $property.Value }
    $profile.inventoryRevision = Get-CutoverHostSha256Text (ConvertTo-CutoverHostJson $core)
    $Fixture.inventoryRevision = [string]$profile.inventoryRevision
    Write-SelfTestJson $Fixture.profileFile $profile
}

function New-SelfTestSnapshot {
    param([Parameter(Mandatory)]$Fixture, [Parameter(Mandatory)][string]$PanelXml)
    $previousSelfTest = [string]$env:DYSON_GSMANAGER_MIGRATION_SELFTEST
    $previousShadowRoot = [string]$env:DYSON_GSMANAGER_MIGRATION_SHADOW_ROOT
    $previousShadowMapVariable = Get-Variable -Name DysonGsMigrationShadowSecurity -Scope Global -ErrorAction SilentlyContinue
    $previousShadowMap = if ($null -ne $previousShadowMapVariable) { $global:DysonGsMigrationShadowSecurity } else { $null }
    Write-SelfTestText (Join-Path $Fixture.root $script:DysonGsShadowSentinel) 'fixture'
    $env:DYSON_GSMANAGER_MIGRATION_SELFTEST = '1'
    $env:DYSON_GSMANAGER_MIGRATION_SHADOW_ROOT = $Fixture.root
    $global:DysonGsMigrationShadowSecurity = @{}
    try {
        $rootSddl = ConvertTo-DysonGsCanonicalSecurityDescriptorSddl `
            'O:SYG:BAD:P(A;OICI;FA;;;SY)(A;OICI;GRGX;;;BU)'
        $fileSddl = ConvertTo-DysonGsCanonicalSecurityDescriptorSddl `
            'O:SYG:BAD:AI(A;;FA;;;SY)(A;ID;GR;;;BU)'
        Set-DysonGsFileSystemSecurityDescriptor -Path $Fixture.gsManagerRoot -SecurityDescriptorSddl $rootSddl
        Set-DysonGsFileSystemSecurityDescriptor -Path (Join-Path $Fixture.gsManagerRoot 'gsmanager.exe') `
            -SecurityDescriptorSddl $fileSddl
        $id = [guid]::NewGuid().ToString('D').ToLowerInvariant()
        $snapshotRoot = Get-DysonGsSnapshotRoot -DataRoot $Fixture.dataRoot -SnapshotId $id
        [void](New-DysonGsPlainDirectory -Path $snapshotRoot -Private)
        $source = Get-DysonGsTreeInventory -Root $Fixture.gsManagerRoot -MaximumFiles 1000 `
            -MaximumTotalBytes 104857600 -MaximumSingleFileBytes 10485760 -RejectSaveFiles
        $sourceSecurity = Get-DysonGsFileSystemSecurityInventory -Root $Fixture.gsManagerRoot -MaximumEntries 2001
        Assert-DysonGsSecurityInventoryMatchesByteInventory -SecurityInventory $sourceSecurity -ByteInventory $source
        $copyRoot = New-DysonGsPlainDirectory -Path (Join-Path $snapshotRoot 'gsmanager')
        Copy-DysonGsInventory -SourceRoot $Fixture.gsManagerRoot -DestinationRoot $copyRoot -Inventory $source `
            -SecurityInventory $sourceSecurity
        Write-DysonGsFileSystemSecurityInventory -Path (Join-Path $snapshotRoot 'filesystem-security.json') `
            -Inventory $sourceSecurity
        $taskSddl = ConvertTo-DysonGsCanonicalSecurityDescriptorSddl `
            'O:SYG:BAD:P(A;;0x1f01ff;;;SY)(A;;GR;;;BU)'
        $taskCapture = [pscustomobject][ordered]@{
            taskName = 'Dyson-GSManager'; taskPath = '\'; present = $true; enabled = $false
            state = 'Ready'; xmlSha256 = Get-DysonGsTextSha256 $PanelXml; xml = $PanelXml
            securityDescriptorSddl = $taskSddl
            securityDescriptorSha256 = Get-DysonGsTextSha256 $taskSddl
        }
        Write-DysonGsTaskCapture -Capture $taskCapture -Directory (Join-Path $snapshotRoot 'task')
        $copied = Get-DysonGsTreeInventory -Root $copyRoot -MaximumFiles 1000 -MaximumTotalBytes 104857600 `
            -MaximumSingleFileBytes 10485760 -PathPrefix 'gsmanager' -RejectSaveFiles
        $payload = Get-DysonGsPayloadInventory -Root $snapshotRoot -MaximumFiles 1000 -MaximumTotalBytes 104857600 `
            -MaximumSingleFileBytes 10485760 -ExcludeRelativePath @('manifest.json')
        $manifest = [ordered]@{
            protocol = $script:DysonGsSnapshotProtocol; schemaVersion = $script:DysonGsSchemaVersion; snapshotId = $id
            createdAt = [DateTime]::UtcNow.ToString('o')
            projectBindingSha256 = Get-DysonGsProjectBindingSha256 $Fixture.projectRoot
            gsManagerRelativeRoot = 'tools/GSManager'; taskName = 'Dyson-GSManager'
            pairedSaveProtection = [ordered]@{ id = $Fixture.protectionPointId; manifestSha256 = $Fixture.protectionManifestSha256 }
            limits = [ordered]@{ maximumFiles = 1000; maximumTotalBytes = [int64]104857600; maximumSingleFileBytes = [int64]10485760 }
            gsManager = [ordered]@{
                fileCount = $copied.fileCount; totalBytes = $copied.totalBytes; treeSha256 = $copied.treeSha256
                securityEntryCount = $sourceSecurity.entryCount; directoryCount = $sourceSecurity.directoryCount
                securityInventorySha256 = $sourceSecurity.inventorySha256
            }
            task = [ordered]@{
                taskPath = '\'; present = $true; enabled = $false; state = 'Ready'; xmlSha256 = $taskCapture.xmlSha256
                securityDescriptorSha256 = $taskCapture.securityDescriptorSha256
            }
            payloadSha256 = $payload.treeSha256; fileCount = $payload.fileCount; totalBytes = $payload.totalBytes; files = $payload.entries
        }
        Write-DysonGsUtf8Json -Path (Join-Path $snapshotRoot 'manifest.json') -Value $manifest
        $Fixture.snapshotId = $id
        $Fixture.snapshotManifestSha256 = Get-DysonGsSha256 (Join-Path $snapshotRoot 'manifest.json')
        [void](Test-DysonGsSnapshotCore -SnapshotRoot $snapshotRoot -ExpectedSnapshotId $id `
            -ExpectedManifestSha256 $Fixture.snapshotManifestSha256)
    }
    finally {
        $env:DYSON_GSMANAGER_MIGRATION_SELFTEST = if ([string]::IsNullOrEmpty($previousSelfTest)) { $null } else { $previousSelfTest }
        $env:DYSON_GSMANAGER_MIGRATION_SHADOW_ROOT = if ([string]::IsNullOrEmpty($previousShadowRoot)) { $null } else { $previousShadowRoot }
        if ($null -ne $previousShadowMapVariable) { $global:DysonGsMigrationShadowSecurity = $previousShadowMap }
        else { Remove-Variable -Name DysonGsMigrationShadowSecurity -Scope Global -ErrorAction SilentlyContinue }
    }
}

function New-SelfTestFixture {
    $root = Join-Path $testRoot ([guid]::NewGuid().ToString('N'))
    $fixture = [pscustomobject][ordered]@{
        root = $root; projectRoot = Join-Path $root 'fictional-project'; dataRoot = Join-Path $root 'fictional-data'
        gsManagerRoot = Join-Path $root 'fictional-project\tools\GSManager'
        profileRoot = Join-Path $root 'fictional-data\authority-inventory'
        profileFile = Join-Path $root 'fictional-data\authority-inventory\authority-profile.json'
        previousRoot = Join-Path $root 'fictional-data\private\gsmanager-authority'
        bootstrapRoot = Join-Path $root 'runtime-bootstrap'; transactionRoot = Join-Path $root 'runtime-task-transactions'
        shadowRoot = Join-Path $root 'shadow'; serviceUser = '.\FictionalService'; gamePort = 18469
        inventoryRevision = $null; protectionPointId = $null; protectionManifestSha256 = $null
        snapshotId = $null; snapshotManifestSha256 = $null
    }
    foreach ($dir in @(
        (Join-Path $fixture.projectRoot 'server'), (Join-Path $fixture.projectRoot 'run'), $fixture.gsManagerRoot,
        $fixture.profileRoot, $fixture.previousRoot, $fixture.bootstrapRoot, $fixture.transactionRoot, $fixture.shadowRoot,
        (Join-Path $fixture.dataRoot 'cutover-broker\requests'), (Join-Path $fixture.dataRoot 'cutover-broker\intents'),
        (Join-Path $fixture.dataRoot 'cutover-broker\work'),
        (Join-Path $fixture.dataRoot 'private\gsmanager-authority-transactions')
    )) { [IO.Directory]::CreateDirectory($dir) | Out-Null }
    Write-SelfTestText (Join-Path $fixture.projectRoot 'server\DSPGAME.exe') 'fictional-dsp'
    Write-SelfTestText (Join-Path $fixture.gsManagerRoot 'gsmanager.exe') 'fixture-manager-binary'
    Write-SelfTestText (Join-Path $fixture.gsManagerRoot 'config\panel.json') '{"fictional":true}'
    Write-SelfTestText (Join-Path $fixture.previousRoot 'start-dyson-server.ps1') 'previous-start'
    Write-SelfTestText (Join-Path $fixture.previousRoot 'stop-dyson-server.ps1') 'previous-stop'
    Write-SelfTestText (Join-Path $fixture.bootstrapRoot 'Start-DysonServer.ps1') 'candidate-start'
    Write-SelfTestText (Join-Path $fixture.bootstrapRoot 'Stop-DysonServer.ps1') 'candidate-stop'
    Write-SelfTestText (Join-Path $fixture.shadowRoot '.dyson-cutover-host-selftest') 'fixture'
    Write-SelfTestText (Join-Path $fixture.shadowRoot '.dyson-gsmanager-removal-selftest') 'fixture'
    Write-SelfTestText (Join-Path $fixture.shadowRoot 'writes.log') ''
    $panelXml = '<Task><Panel>fixed-disabled</Panel></Task>'
    $active = New-SelfTestCandidateDescriptors -Enabled:$true -Fixture $fixture
    $tasks = @(
        (New-SelfTestTask 'Dyson-GSManager' $panelXml $false $false $null),
        (New-SelfTestTask 'Dyson-GSManager-Server' '<Task><PreviousStart>fixed</PreviousStart></Task>' $true $false $null),
        (New-SelfTestTask 'Dyson-GSManager-Stop' '<Task><PreviousStop>fixed</PreviousStop></Task>' $true $false $null),
        (New-SelfTestTask 'Dyson-Nebula-Server' '<Task><CandidateStart>fixed</CandidateStart></Task>' $true $false $active.start),
        (New-SelfTestTask 'Dyson-Nebula-Stop' '<Task><CandidateStop>fixed</CandidateStop></Task>' $true $false $active.stop)
    )
    Write-SelfTestTasks -Fixture $fixture -Tasks $tasks
    $security = [Security.AccessControl.RawSecurityDescriptor]::new(
        (ConvertTo-DysonGsCanonicalSecurityDescriptorSddl 'O:SYG:BAD:P(A;;0x1f01ff;;;SY)(A;;GR;;;BU)')
    )
    $securityBytes = New-Object byte[] $security.BinaryLength
    $security.GetBinaryForm($securityBytes, 0)
    Write-SelfTestJson (Join-Path $fixture.shadowRoot 'gsmanager-task-security.json') ([pscustomobject][ordered]@{
        protocol = 'DYSON_GSMANAGER_REMOVAL_SHADOW_TASK_SECURITY_V1'; taskName = 'Dyson-GSManager'; taskPath = '\'
        securityDescriptorBase64 = [Convert]::ToBase64String($securityBytes)
    })
    Write-SelfTestGsRuntime -Fixture $fixture
    New-SelfTestProtection -Fixture $fixture
    New-SelfTestProfile -Fixture $fixture
    Write-SelfTestCutoverRuntime -Fixture $fixture -State candidate
    New-SelfTestSnapshot -Fixture $fixture -PanelXml $panelXml
    return $fixture
}

function Test-SelfTestDurableWriteLongPath {
    param([Parameter(Mandatory)]$Fixture)

    # The final evidence path remains below the legacy Win32 limit so ordinary
    # validation and ACL checks stay on a normal path. The generated CreateNew
    # temporary and Replace backup exceed it, matching a deeply nested release
    # run without making unrelated snapshot setup depend on long-path support.
    $prefix = Join-Path $Fixture.dataRoot 'durable-write-long-'
    $paddingLength = 210 - $prefix.Length
    Assert-SelfTest ($paddingLength -gt 0) 'long-path durable-write fixture prefix was unexpectedly long'
    $parent = $prefix + ('x' * $paddingLength)
    $target = Join-Path $parent 'entry.json'
    $temporary = Join-Path $parent ('.dyson-gsm-removal-' + ('0' * 32) + '.tmp')
    $backup = Join-Path $parent ('.dyson-gsm-removal-' + ('0' * 32) + '.bak')
    Assert-SelfTest ($target.Length -lt 260 -and $temporary.Length -gt 260 -and $backup.Length -gt 260) `
        'long-path durable-write fixture did not straddle the legacy limit'

    $previousDataRootVariable = Get-Variable -Name DysonGsRemovalDataRoot -Scope Script -ErrorAction SilentlyContinue
    $previousLeaseVariable = Get-Variable -Name DysonGsRemovalLease -Scope Script -ErrorAction SilentlyContinue
    $previousDataRoot = if ($null -ne $previousDataRootVariable) { $previousDataRootVariable.Value } else { $null }
    $previousLease = if ($null -ne $previousLeaseVariable) { $previousLeaseVariable.Value } else { $null }
    $created = $false
    try {
        [void](New-DysonGsRemovalPrivateDirectory -Path $parent)
        $created = $true
        $script:DysonGsRemovalDataRoot = [string]$Fixture.dataRoot
        $script:DysonGsRemovalLease = $null
        [void](Enter-DysonGsRemovalLease -Operation 'gsmanager-removal' -RequestId ([guid]::NewGuid().ToString('D')))
        Write-DysonGsRemovalJsonNew -Path $target -Value ([ordered]@{ value = 'before' }) -MaximumBytes 65536
        Write-DysonGsRemovalJsonReplace -Path $target -Value ([ordered]@{ value = 'after' }) -MaximumBytes 65536
        $written = Read-DysonGsRemovalJson -Path $target -MaximumBytes 65536
        Assert-SelfTest ([string]$written.value -ceq 'after') 'long-path durable-write did not atomically replace evidence'
        Assert-SelfTest (-not (Test-Path -LiteralPath $temporary) -and -not (Test-Path -LiteralPath $backup)) `
            'long-path durable-write leaked a temporary or backup file'

        $deviceRejected = $false
        try { [void](Get-DysonGsRemovalOsPath -Path ('\\?\' + $target)) }
        catch { $deviceRejected = $true }
        Assert-SelfTest $deviceRejected 'long-path durable-write accepted a caller device namespace'
    }
    finally {
        Exit-DysonGsRemovalLease
        if ($null -ne $previousLeaseVariable) { $script:DysonGsRemovalLease = $previousLease }
        else { Remove-Variable -Name DysonGsRemovalLease -Scope Script -ErrorAction SilentlyContinue }
        if ($null -ne $previousDataRootVariable) { $script:DysonGsRemovalDataRoot = $previousDataRoot }
        else { Remove-Variable -Name DysonGsRemovalDataRoot -Scope Script -ErrorAction SilentlyContinue }
        if ($created -and (Test-Path -LiteralPath $parent)) {
            Remove-Item -LiteralPath $parent -Force -Recurse -ErrorAction Stop
        }
    }
}

function Get-SelfTestRemoveArguments {
    param([Parameter(Mandatory)]$Fixture, [Parameter(Mandatory)][string]$RequestId, [switch]$WhatIf)
    $arguments = @(
        '-ProjectRoot', $Fixture.projectRoot, '-GsManagerRoot', $Fixture.gsManagerRoot, '-DataRoot', $Fixture.dataRoot,
        '-SnapshotId', $Fixture.snapshotId, '-SnapshotManifestSha256', $Fixture.snapshotManifestSha256,
        '-PairedSaveProtectionPointId', $Fixture.protectionPointId,
        '-PairedSaveProtectionManifestSha256', $Fixture.protectionManifestSha256,
        '-TaskName', 'Dyson-GSManager', '-ProfileFile', $Fixture.profileFile,
        '-RuntimeBootstrapRoot', $Fixture.bootstrapRoot, '-RuntimeTaskTransactionRoot', $Fixture.transactionRoot,
        '-ServiceUser', $Fixture.serviceUser, '-GamePort', [string]$Fixture.gamePort,
        '-AuthorityInventoryRevision', $Fixture.inventoryRevision, '-RequestId', $RequestId,
        '-Backend', 'Shadow', '-ShadowRoot', $Fixture.shadowRoot
    )
    if ($WhatIf) { $arguments += '-WhatIf' }
    else { $arguments += @('-ConfirmationToken', 'REMOVE_GSMANAGER_INSTALLATION') }
    return $arguments
}

function Get-SelfTestRestoreArguments {
    param(
        [Parameter(Mandatory)]$Fixture, [Parameter(Mandatory)][string]$RemovalRequestId,
        [Parameter(Mandatory)][string]$RemovalReceiptSha256, [Parameter(Mandatory)][string]$RestoreRequestId,
        [switch]$WhatIf
    )
    $arguments = @(
        '-ProjectRoot', $Fixture.projectRoot, '-GsManagerRoot', $Fixture.gsManagerRoot, '-DataRoot', $Fixture.dataRoot,
        '-SnapshotId', $Fixture.snapshotId, '-SnapshotManifestSha256', $Fixture.snapshotManifestSha256,
        '-PairedSaveProtectionPointId', $Fixture.protectionPointId,
        '-PairedSaveProtectionManifestSha256', $Fixture.protectionManifestSha256,
        '-TaskName', 'Dyson-GSManager', '-ProfileFile', $Fixture.profileFile,
        '-RuntimeBootstrapRoot', $Fixture.bootstrapRoot, '-RuntimeTaskTransactionRoot', $Fixture.transactionRoot,
        '-ServiceUser', $Fixture.serviceUser, '-GamePort', [string]$Fixture.gamePort,
        '-AuthorityInventoryRevision', $Fixture.inventoryRevision, '-RemovalRequestId', $RemovalRequestId,
        '-RemovalReceiptSha256', $RemovalReceiptSha256, '-RestoreRequestId', $RestoreRequestId,
        '-Backend', 'Shadow', '-ShadowRoot', $Fixture.shadowRoot
    )
    if ($WhatIf) { $arguments += '-WhatIf' }
    else { $arguments += @('-ConfirmationToken', 'RESTORE_GSMANAGER_REMOVAL') }
    return $arguments
}

function Get-SelfTestInspectionArguments {
    param(
        [Parameter(Mandatory)]$Fixture, [Parameter(Mandatory)][string]$RemovalRequestId,
        [Parameter(Mandatory)][string]$RemovalReceiptSha256, [string]$RestoreRequestId, [string]$RestoreReceiptSha256
    )
    $arguments = @(
        '-ProjectRoot', $Fixture.projectRoot, '-GsManagerRoot', $Fixture.gsManagerRoot, '-DataRoot', $Fixture.dataRoot,
        '-SnapshotId', $Fixture.snapshotId, '-SnapshotManifestSha256', $Fixture.snapshotManifestSha256,
        '-PairedSaveProtectionPointId', $Fixture.protectionPointId,
        '-PairedSaveProtectionManifestSha256', $Fixture.protectionManifestSha256,
        '-TaskName', 'Dyson-GSManager', '-ProfileFile', $Fixture.profileFile,
        '-RuntimeBootstrapRoot', $Fixture.bootstrapRoot, '-RuntimeTaskTransactionRoot', $Fixture.transactionRoot,
        '-ServiceUser', $Fixture.serviceUser, '-GamePort', [string]$Fixture.gamePort,
        '-AuthorityInventoryRevision', $Fixture.inventoryRevision, '-RemovalRequestId', $RemovalRequestId,
        '-RemovalReceiptSha256', $RemovalReceiptSha256, '-Backend', 'Shadow', '-ShadowRoot', $Fixture.shadowRoot
    )
    if ($RestoreRequestId) { $arguments += @('-RestoreRequestId', $RestoreRequestId, '-RestoreReceiptSha256', $RestoreReceiptSha256) }
    return $arguments
}

function Assert-SelfTestPreimageExact {
    param([Parameter(Mandatory)]$Fixture, [Parameter(Mandatory)]$Tree, [Parameter(Mandatory)]$Acl, [Parameter(Mandatory)][string]$TaskXml, [Parameter(Mandatory)][byte[]]$TaskSecurity)
    $current = Get-DysonGsTreeInventory -Root $Fixture.gsManagerRoot -MaximumFiles 1000 `
        -MaximumTotalBytes 104857600 -MaximumSingleFileBytes 10485760 -RejectSaveFiles
    Assert-SelfTest (Test-DysonGsEntryListsEqual $Tree.entries $current.entries) 'compensation changed tree bytes'
    Assert-SelfTest (Test-DysonGsRemovalAclInventoriesEqual $Acl (Get-DysonGsRemovalAclInventory $Fixture.gsManagerRoot)) `
        'compensation changed tree ACL bytes'
    $state = Read-SelfTestTasks $Fixture
    $task = @($state.tasks | Where-Object { [string]$_.taskName -ceq 'Dyson-GSManager' })
    Assert-SelfTest ($task.Count -eq 1 -and -not [bool]$task[0].enabled -and -not [bool]$task[0].running -and
        [string]$task[0].xmlBase64 -ceq $TaskXml) 'compensation changed task XML/state'
    $securityState = Get-Content -LiteralPath (Join-Path $Fixture.shadowRoot 'gsmanager-task-security.json') -Raw -Encoding UTF8 | ConvertFrom-Json
    Assert-SelfTest (Test-DysonGsRemovalBytesEqual ([Convert]::FromBase64String([string]$securityState.securityDescriptorBase64)) $TaskSecurity) `
        'compensation changed task security descriptor bytes'
}

try {
    foreach ($dependency in @($removeScript, $restoreScript, $inspectScript, $migrationCommon, $removalCommon, $cutoverCommon, $leaseCommon, $powershell)) {
        if (-not (Test-Path -LiteralPath $dependency -PathType Leaf)) { throw 'SELFTEST_FAILED: dependency missing' }
    }
    [IO.Directory]::CreateDirectory($testRoot) | Out-Null
    . $leaseCommon
    . $migrationCommon
    . $cutoverCommon
    . $removalCommon
    $env:DYSON_CUTOVER_HOST_SELFTEST = '1'
    $env:DYSON_GSMANAGER_REMOVAL_SELFTEST = '1'
    $fixture = New-SelfTestFixture

    Test-SelfTestDurableWriteLongPath -Fixture $fixture
    $tests.Add('durable-write-extended-path-over-260')

    $previewId = [guid]::NewGuid().ToString('D')
    $beforePreview = Get-DysonGsTreeInventory -Root $fixture.root -MaximumFiles 5000 -MaximumTotalBytes 209715200 `
        -MaximumSingleFileBytes 104857600
    $preview = Assert-SelfTestSuccess (Invoke-SelfTestChild $removeScript (Get-SelfTestRemoveArguments $fixture $previewId -WhatIf)) 'preview'
    $afterPreview = Get-DysonGsTreeInventory -Root $fixture.root -MaximumFiles 5000 -MaximumTotalBytes 209715200 `
        -MaximumSingleFileBytes 104857600
    Assert-SelfTest (Test-DysonGsEntryListsEqual $beforePreview.entries $afterPreview.entries) 'WhatIf wrote fixture state'
    Assert-SelfTest ([bool]$preview.dryRun -and -not [bool]$preview.productionChanged) 'WhatIf receipt changed'
    $tests.Add('remove-whatif-zero-write')

    $badConfirmArgs = Get-SelfTestRemoveArguments $fixture ([guid]::NewGuid().ToString('D'))
    $tokenIndex = [Array]::IndexOf($badConfirmArgs, '-ConfirmationToken') + 1
    $badConfirmArgs[$tokenIndex] = 'WRONG'
    Assert-SelfTestFailure (Invoke-SelfTestChild $removeScript $badConfirmArgs) 'DYSON_GSMANAGER_REMOVAL_CONFIRMATION_REQUIRED'
    $badHashArgs = Get-SelfTestRemoveArguments $fixture ([guid]::NewGuid().ToString('D')) -WhatIf
    $hashIndex = [Array]::IndexOf($badHashArgs, '-SnapshotManifestSha256') + 1
    $badHashArgs[$hashIndex] = ('f' * 64)
    Assert-SelfTestFailure (Invoke-SelfTestChild $removeScript $badHashArgs) 'DYSON_GSMANAGER_REMOVAL_SNAPSHOT_INVALID'
    $tests.Add('confirmation-and-snapshot-hash')

    $pending = Join-Path $fixture.dataRoot 'cutover-broker\requests\pending.json'
    Write-SelfTestText $pending '{}'
    Assert-SelfTestFailure (Invoke-SelfTestChild $removeScript (Get-SelfTestRemoveArguments $fixture ([guid]::NewGuid().ToString('D')) -WhatIf)) `
        'DYSON_GSMANAGER_REMOVAL_CUTOVER_PENDING'
    Remove-Item -LiteralPath $pending -Force
    $authorityIntent = Join-Path $fixture.dataRoot 'private\gsmanager-authority-transactions\active-intent.json'
    Write-SelfTestText $authorityIntent '{}'
    Assert-SelfTestFailure (Invoke-SelfTestChild $removeScript (Get-SelfTestRemoveArguments $fixture ([guid]::NewGuid().ToString('D')) -WhatIf)) `
        'DYSON_GSMANAGER_REMOVAL_AUTHORITY_PENDING'
    Remove-Item -LiteralPath $authorityIntent -Force
    $runtimeIntent = Join-Path $fixture.transactionRoot 'active-intent.json'
    Write-SelfTestText $runtimeIntent '{}'
    Assert-SelfTestFailure (Invoke-SelfTestChild $removeScript (Get-SelfTestRemoveArguments $fixture ([guid]::NewGuid().ToString('D')) -WhatIf)) `
        'DYSON_GSMANAGER_REMOVAL_RUNTIME_TASK_PENDING'
    Remove-Item -LiteralPath $runtimeIntent -Force
    $tests.Add('pending-transactions-fail-closed')

    Set-SelfTestCandidateState $fixture prepared
    Assert-SelfTestFailure (Invoke-SelfTestChild $removeScript (Get-SelfTestRemoveArguments $fixture ([guid]::NewGuid().ToString('D')) -WhatIf)) `
        'DYSON_GSMANAGER_REMOVAL_CANDIDATE_AUTHORITY_INVALID'
    Set-SelfTestCandidateState $fixture active
    $rogueState = Read-SelfTestTasks $fixture
    $rogueState.tasks += New-SelfTestTask 'Fictional-Rogue' '<Task>rogue</Task>' $true $false ([pscustomobject]@{
        execute = $powershell; arguments = ('-File "{0}"' -f (Join-Path $fixture.bootstrapRoot 'Start-DysonServer.ps1'))
    })
    Write-SelfTestTasks -Fixture $fixture -Tasks @($rogueState.tasks)
    Assert-SelfTestFailure (Invoke-SelfTestChild $removeScript (Get-SelfTestRemoveArguments $fixture ([guid]::NewGuid().ToString('D')) -WhatIf)) `
        'DYSON_GSMANAGER_REMOVAL_AUTHORITY_DRIFT'
    $rogueState.tasks = @($rogueState.tasks | Where-Object { [string]$_.taskName -cne 'Fictional-Rogue' })
    Write-SelfTestTasks -Fixture $fixture -Tasks @($rogueState.tasks)
    Write-SelfTestGsRuntime -Fixture $fixture -Active
    Assert-SelfTestFailure (Invoke-SelfTestChild $removeScript (Get-SelfTestRemoveArguments $fixture ([guid]::NewGuid().ToString('D')) -WhatIf)) `
        'DYSON_GSMANAGER_REMOVAL_RUNTIME_ACTIVE'
    Write-SelfTestGsRuntime -Fixture $fixture
    $tests.Add('authority-and-process-fail-closed')

    $taskState = Read-SelfTestTasks $fixture
    $panel = @($taskState.tasks | Where-Object { [string]$_.taskName -ceq 'Dyson-GSManager' })[0]
    $panel.xmlBase64 = [Convert]::ToBase64String([Text.UTF8Encoding]::new($false).GetBytes('<Task>drift</Task>'))
    Write-SelfTestTasks -Fixture $fixture -Tasks @($taskState.tasks)
    Assert-SelfTestFailure (Invoke-SelfTestChild $removeScript (Get-SelfTestRemoveArguments $fixture ([guid]::NewGuid().ToString('D')) -WhatIf)) `
        'DYSON_GSMANAGER_REMOVAL_PREVIOUS_AUTHORITY_NOT_QUIESCED'
    $panel.xmlBase64 = [Convert]::ToBase64String([Text.UTF8Encoding]::new($false).GetBytes('<Task><Panel>fixed-disabled</Panel></Task>'))
    Write-SelfTestTasks -Fixture $fixture -Tasks @($taskState.tasks)
    $drift = Join-Path $fixture.gsManagerRoot 'drift.bin'
    Write-SelfTestText $drift 'drift'
    Assert-SelfTestFailure (Invoke-SelfTestChild $removeScript (Get-SelfTestRemoveArguments $fixture ([guid]::NewGuid().ToString('D')) -WhatIf)) `
        'DYSON_GSMANAGER_REMOVAL_ROOT_DRIFT'
    Remove-Item -LiteralPath $drift -Force
    $tests.Add('task-and-root-drift')

    $baselineTree = Get-DysonGsTreeInventory -Root $fixture.gsManagerRoot -MaximumFiles 1000 `
        -MaximumTotalBytes 104857600 -MaximumSingleFileBytes 10485760 -RejectSaveFiles
    $baselineAcl = Get-DysonGsRemovalAclInventory $fixture.gsManagerRoot
    $baselineTask = @((Read-SelfTestTasks $fixture).tasks | Where-Object { [string]$_.taskName -ceq 'Dyson-GSManager' })[0]
    $baselineTaskSecurityState = Get-Content -LiteralPath (Join-Path $fixture.shadowRoot 'gsmanager-task-security.json') -Raw -Encoding UTF8 | ConvertFrom-Json
    $baselineTaskSecurity = [Convert]::FromBase64String([string]$baselineTaskSecurityState.securityDescriptorBase64)
    foreach ($fault in @('AfterTreeMove', 'AfterTaskUnregister')) {
        $env:DYSON_GSMANAGER_REMOVAL_SELFTEST_FAIL_POINT = $fault
        $faultId = [guid]::NewGuid().ToString('D')
        Assert-SelfTestFailure (Invoke-SelfTestChild $removeScript (Get-SelfTestRemoveArguments $fixture $faultId)) `
            'DYSON_GSMANAGER_REMOVAL_FAILED_ROLLED_BACK'
        $env:DYSON_GSMANAGER_REMOVAL_SELFTEST_FAIL_POINT = $null
        Assert-SelfTestPreimageExact -Fixture $fixture -Tree $baselineTree -Acl $baselineAcl `
            -TaskXml ([string]$baselineTask.xmlBase64) -TaskSecurity $baselineTaskSecurity
    }
    $tests.Add('remove-fault-exact-compensation')

    foreach ($terminalFault in @('AfterReceiptBeforeAudit', 'AfterReceiptBeforeIntentDelete')) {
        $terminalRemovalId = [guid]::NewGuid().ToString('D')
        try {
            $env:DYSON_GSMANAGER_REMOVAL_SELFTEST_FAIL_POINT = $terminalFault
            Assert-SelfTestFailure (Invoke-SelfTestChild $removeScript `
                (Get-SelfTestRemoveArguments $fixture $terminalRemovalId)) `
                'DYSON_GSMANAGER_REMOVAL_SELFTEST_FAILURE'
        }
        finally { $env:DYSON_GSMANAGER_REMOVAL_SELFTEST_FAIL_POINT = $null }

        $removalStorageRoot = Join-Path $fixture.dataRoot 'migration\removals'
        $terminalReceiptPath = Join-Path $removalStorageRoot ('receipts\' + $terminalRemovalId + '.json')
        $terminalIntentPath = Join-Path $removalStorageRoot 'active-intent.json'
        $terminalAuditPath = Join-Path $removalStorageRoot ('audit\remove-' + $terminalRemovalId + '.json')
        Assert-SelfTest ((Test-Path -LiteralPath $terminalReceiptPath -PathType Leaf) -and
            (Test-Path -LiteralPath $terminalIntentPath -PathType Leaf)) `
            ('remove terminal fault did not preserve receipt plus intent: ' + $terminalFault)
        Assert-SelfTest ((Test-Path -LiteralPath $terminalAuditPath -PathType Leaf) -eq
            ($terminalFault -ceq 'AfterReceiptBeforeIntentDelete')) `
            ('remove terminal fault audit position was wrong: ' + $terminalFault)
        Assert-SelfTest (-not (Test-Path -LiteralPath $fixture.gsManagerRoot) -and
            @((Read-SelfTestTasks $fixture).tasks | Where-Object { [string]$_.taskName -ceq 'Dyson-GSManager' }).Count -eq 0) `
            ('remove terminal fault compensated a committed removal: ' + $terminalFault)
        Assert-SelfTest ([string](Get-DysonHostMutationLeaseStatus $fixture.dataRoot).state -ceq 'released') `
            ('remove terminal fault did not release its exception-path lease: ' + $terminalFault)

        $terminalReceiptSha = Get-DysonGsSha256 $terminalReceiptPath
        $intentBytes = [IO.File]::ReadAllBytes($terminalIntentPath)
        $mismatchedIntent = Get-Content -LiteralPath $terminalIntentPath -Raw -Encoding UTF8 | ConvertFrom-Json
        $mismatchedIntent.requestFingerprint = ('0' * 64)
        Write-SelfTestJson $terminalIntentPath $mismatchedIntent
        Assert-SelfTestFailure (Invoke-SelfTestChild $removeScript `
            (Get-SelfTestRemoveArguments $fixture $terminalRemovalId)) `
            'DYSON_GSMANAGER_REMOVAL_RECOVERY_MISMATCH'
        Assert-SelfTest ((Test-Path -LiteralPath $terminalIntentPath -PathType Leaf) -and
            (Get-DysonGsSha256 $terminalReceiptPath) -ceq $terminalReceiptSha) `
            ('remove mismatch changed terminal evidence: ' + $terminalFault)
        [IO.File]::WriteAllBytes($terminalIntentPath, $intentBytes)

        $writesBeforeReplay = [IO.File]::ReadAllText((Join-Path $fixture.shadowRoot 'writes.log'))
        $terminalRemoved = Assert-SelfTestSuccess (Invoke-SelfTestChild $removeScript `
            (Get-SelfTestRemoveArguments $fixture $terminalRemovalId)) 'removed'
        Assert-SelfTest ([bool]$terminalRemoved.reused -and
            [string]$terminalRemoved.receiptSha256 -ceq $terminalReceiptSha) `
            ('remove terminal replay did not reuse its durable receipt: ' + $terminalFault)
        Assert-SelfTest (-not (Test-Path -LiteralPath $terminalIntentPath) -and
            (Test-Path -LiteralPath $terminalAuditPath -PathType Leaf)) `
            ('remove terminal replay did not reconcile audit and intent: ' + $terminalFault)
        $terminalAudit = Get-Content -LiteralPath $terminalAuditPath -Raw -Encoding UTF8 | ConvertFrom-Json
        Assert-SelfTest ([string]$terminalAudit.receiptSha256 -ceq $terminalReceiptSha -and
            [string]$terminalAudit.operation -ceq 'remove') `
            ('remove terminal replay audit did not bind the receipt: ' + $terminalFault)
        Assert-SelfTest ([IO.File]::ReadAllText((Join-Path $fixture.shadowRoot 'writes.log')) -ceq $writesBeforeReplay) `
            ('remove terminal replay repeated a task mutation: ' + $terminalFault)

        Set-SelfTestCandidateState $fixture prepared
        Write-SelfTestCutoverRuntime -Fixture $fixture -State stopped
        $terminalRestoreId = [guid]::NewGuid().ToString('D')
        [void](Assert-SelfTestSuccess (Invoke-SelfTestChild $restoreScript `
            (Get-SelfTestRestoreArguments $fixture $terminalRemovalId $terminalReceiptSha $terminalRestoreId)) `
            'restored-disabled')
        Assert-SelfTestPreimageExact -Fixture $fixture -Tree $baselineTree -Acl $baselineAcl `
            -TaskXml ([string]$baselineTask.xmlBase64) -TaskSecurity $baselineTaskSecurity
        Set-SelfTestCandidateState $fixture active
        Write-SelfTestCutoverRuntime -Fixture $fixture -State candidate
        Write-SelfTestGsRuntime -Fixture $fixture
    }
    $tests.Add('remove-terminal-receipt-restart-reconciliation')

    $removalId = [guid]::NewGuid().ToString('D')
    $removed = Assert-SelfTestSuccess (Invoke-SelfTestChild $removeScript (Get-SelfTestRemoveArguments $fixture $removalId)) 'removed'
    Assert-SelfTest (-not (Test-Path -LiteralPath $fixture.gsManagerRoot) -and
        @((Read-SelfTestTasks $fixture).tasks | Where-Object { [string]$_.taskName -ceq 'Dyson-GSManager' }).Count -eq 0) `
        'successful removal retained previous installation'
    $removedAgain = Assert-SelfTestSuccess (Invoke-SelfTestChild $removeScript (Get-SelfTestRemoveArguments $fixture $removalId)) 'removed'
    Assert-SelfTest ([bool]$removedAgain.reused) 'successful removal was not idempotent'
    $inspection = Assert-SelfTestSuccess (Invoke-SelfTestChild $inspectScript `
        (Get-SelfTestInspectionArguments $fixture $removalId ([string]$removed.receiptSha256))) 'removed'
    Assert-SelfTest ([bool]$inspection.verified) 'removal inspector did not verify terminal state'
    $tests.Add('remove-success-inspection-idempotency')

    $receiptPath = Join-Path $fixture.dataRoot ('migration\removals\receipts\' + $removalId + '.json')
    $receiptValue = Get-Content -LiteralPath $receiptPath -Raw -Encoding UTF8 | ConvertFrom-Json
    $guardFile = Join-Path $fixture.dataRoot ('migration\removals\guards\' + $removalId + '\root\gsmanager.exe')
    $guardBytes = [IO.File]::ReadAllBytes($guardFile)
    [IO.File]::WriteAllBytes($guardFile, [Text.UTF8Encoding]::new($false).GetBytes('tampered'))
    Assert-SelfTestFailure (Invoke-SelfTestChild $inspectScript `
        (Get-SelfTestInspectionArguments $fixture $removalId ([string]$removed.receiptSha256))) `
        'DYSON_GSMANAGER_REMOVAL_GUARD_INVALID'
    [IO.File]::WriteAllBytes($guardFile, $guardBytes)
    $tests.Add('guard-tamper-detected')

    $activeRestoreId = [guid]::NewGuid().ToString('D')
    Assert-SelfTestFailure (Invoke-SelfTestChild $restoreScript `
        (Get-SelfTestRestoreArguments $fixture $removalId ([string]$removed.receiptSha256) $activeRestoreId -WhatIf)) `
        'DYSON_GSMANAGER_REMOVAL_CANDIDATE_AUTHORITY_INVALID'
    Set-SelfTestCandidateState $fixture prepared
    Write-SelfTestCutoverRuntime -Fixture $fixture -State stopped
    Write-SelfTestGsRuntime -Fixture $fixture
    $restorePreviewBefore = Get-DysonGsTreeInventory -Root $fixture.root -MaximumFiles 10000 -MaximumTotalBytes 314572800 `
        -MaximumSingleFileBytes 104857600
    $restorePreviewId = [guid]::NewGuid().ToString('D')
    [void](Assert-SelfTestSuccess (Invoke-SelfTestChild $restoreScript `
        (Get-SelfTestRestoreArguments $fixture $removalId ([string]$removed.receiptSha256) $restorePreviewId -WhatIf)) 'restore-preview')
    $restorePreviewAfter = Get-DysonGsTreeInventory -Root $fixture.root -MaximumFiles 10000 -MaximumTotalBytes 314572800 `
        -MaximumSingleFileBytes 104857600
    Assert-SelfTest (Test-DysonGsEntryListsEqual $restorePreviewBefore.entries $restorePreviewAfter.entries) 'restore WhatIf wrote state'
    $tests.Add('restore-preconditions-and-whatif')

    foreach ($fault in @('AfterRestoreTreeMove', 'AfterRestoreTaskRegister')) {
        $env:DYSON_GSMANAGER_REMOVAL_SELFTEST_FAIL_POINT = $fault
        $faultRestoreId = [guid]::NewGuid().ToString('D')
        Assert-SelfTestFailure (Invoke-SelfTestChild $restoreScript `
            (Get-SelfTestRestoreArguments $fixture $removalId ([string]$removed.receiptSha256) $faultRestoreId)) `
            'DYSON_GSMANAGER_REMOVAL_RESTORE_FAILED_ROLLED_BACK'
        $env:DYSON_GSMANAGER_REMOVAL_SELFTEST_FAIL_POINT = $null
        Assert-SelfTest (-not (Test-Path -LiteralPath $fixture.gsManagerRoot) -and
            @((Read-SelfTestTasks $fixture).tasks | Where-Object { [string]$_.taskName -ceq 'Dyson-GSManager' }).Count -eq 0) `
            'restore compensation exposed previous authority'
        [void](Assert-SelfTestSuccess (Invoke-SelfTestChild $inspectScript `
            (Get-SelfTestInspectionArguments $fixture $removalId ([string]$removed.receiptSha256))) 'removed')
    }
    $tests.Add('restore-fault-exact-compensation')

    foreach ($terminalFault in @('AfterReceiptBeforeAudit', 'AfterReceiptBeforeIntentDelete')) {
        $terminalRestoreId = [guid]::NewGuid().ToString('D')
        try {
            $env:DYSON_GSMANAGER_REMOVAL_SELFTEST_FAIL_POINT = $terminalFault
            Assert-SelfTestFailure (Invoke-SelfTestChild $restoreScript `
                (Get-SelfTestRestoreArguments $fixture $removalId ([string]$removed.receiptSha256) $terminalRestoreId)) `
                'DYSON_GSMANAGER_REMOVAL_SELFTEST_FAILURE'
        }
        finally { $env:DYSON_GSMANAGER_REMOVAL_SELFTEST_FAIL_POINT = $null }

        $removalStorageRoot = Join-Path $fixture.dataRoot 'migration\removals'
        $terminalRestoreReceiptPath = Join-Path $removalStorageRoot ('restore-receipts\' + $terminalRestoreId + '.json')
        $terminalIntentPath = Join-Path $removalStorageRoot 'active-intent.json'
        $terminalAuditPath = Join-Path $removalStorageRoot ('audit\restore-' + $terminalRestoreId + '.json')
        Assert-SelfTest ((Test-Path -LiteralPath $terminalRestoreReceiptPath -PathType Leaf) -and
            (Test-Path -LiteralPath $terminalIntentPath -PathType Leaf)) `
            ('restore terminal fault did not preserve receipt plus intent: ' + $terminalFault)
        Assert-SelfTest ((Test-Path -LiteralPath $terminalAuditPath -PathType Leaf) -eq
            ($terminalFault -ceq 'AfterReceiptBeforeIntentDelete')) `
            ('restore terminal fault audit position was wrong: ' + $terminalFault)
        Assert-SelfTestPreimageExact -Fixture $fixture -Tree $baselineTree -Acl $baselineAcl `
            -TaskXml ([string]$baselineTask.xmlBase64) -TaskSecurity $baselineTaskSecurity
        Assert-SelfTest ([string](Get-DysonHostMutationLeaseStatus $fixture.dataRoot).state -ceq 'released') `
            ('restore terminal fault did not release its exception-path lease: ' + $terminalFault)

        $terminalRestoreReceiptSha = Get-DysonGsSha256 $terminalRestoreReceiptPath
        $intentBytes = [IO.File]::ReadAllBytes($terminalIntentPath)
        $mismatchedIntent = Get-Content -LiteralPath $terminalIntentPath -Raw -Encoding UTF8 | ConvertFrom-Json
        $mismatchedIntent.requestFingerprint = ('0' * 64)
        Write-SelfTestJson $terminalIntentPath $mismatchedIntent
        Assert-SelfTestFailure (Invoke-SelfTestChild $restoreScript `
            (Get-SelfTestRestoreArguments $fixture $removalId ([string]$removed.receiptSha256) $terminalRestoreId)) `
            'DYSON_GSMANAGER_REMOVAL_RECOVERY_MISMATCH'
        Assert-SelfTest ((Test-Path -LiteralPath $terminalIntentPath -PathType Leaf) -and
            (Get-DysonGsSha256 $terminalRestoreReceiptPath) -ceq $terminalRestoreReceiptSha) `
            ('restore mismatch changed terminal evidence: ' + $terminalFault)
        [IO.File]::WriteAllBytes($terminalIntentPath, $intentBytes)

        $writesBeforeReplay = [IO.File]::ReadAllText((Join-Path $fixture.shadowRoot 'writes.log'))
        $terminalRestored = Assert-SelfTestSuccess (Invoke-SelfTestChild $restoreScript `
            (Get-SelfTestRestoreArguments $fixture $removalId ([string]$removed.receiptSha256) $terminalRestoreId)) `
            'restored-disabled'
        Assert-SelfTest ([bool]$terminalRestored.reused -and
            [string]$terminalRestored.receiptSha256 -ceq $terminalRestoreReceiptSha) `
            ('restore terminal replay did not reuse its durable receipt: ' + $terminalFault)
        Assert-SelfTest (-not (Test-Path -LiteralPath $terminalIntentPath) -and
            (Test-Path -LiteralPath $terminalAuditPath -PathType Leaf)) `
            ('restore terminal replay did not reconcile audit and intent: ' + $terminalFault)
        $terminalAudit = Get-Content -LiteralPath $terminalAuditPath -Raw -Encoding UTF8 | ConvertFrom-Json
        Assert-SelfTest ([string]$terminalAudit.receiptSha256 -ceq $terminalRestoreReceiptSha -and
            [string]$terminalAudit.operation -ceq 'restore') `
            ('restore terminal replay audit did not bind the receipt: ' + $terminalFault)
        Assert-SelfTest ([IO.File]::ReadAllText((Join-Path $fixture.shadowRoot 'writes.log')) -ceq $writesBeforeReplay) `
            ('restore terminal replay repeated a task mutation: ' + $terminalFault)
        Assert-SelfTestPreimageExact -Fixture $fixture -Tree $baselineTree -Acl $baselineAcl `
            -TaskXml ([string]$baselineTask.xmlBase64) -TaskSecurity $baselineTaskSecurity

        # Publish a fresh removed terminal for the next restore-fault iteration (and,
        # after the final iteration, for the ordinary clean restore below).
        Set-SelfTestCandidateState $fixture active
        Write-SelfTestCutoverRuntime -Fixture $fixture -State candidate
        Write-SelfTestGsRuntime -Fixture $fixture
        $removalId = [guid]::NewGuid().ToString('D')
        $removed = Assert-SelfTestSuccess (Invoke-SelfTestChild $removeScript `
            (Get-SelfTestRemoveArguments $fixture $removalId)) 'removed'
        Set-SelfTestCandidateState $fixture prepared
        Write-SelfTestCutoverRuntime -Fixture $fixture -State stopped
        Write-SelfTestGsRuntime -Fixture $fixture
    }
    $tests.Add('restore-terminal-receipt-restart-reconciliation')

    $restoreId = [guid]::NewGuid().ToString('D')
    $restored = Assert-SelfTestSuccess (Invoke-SelfTestChild $restoreScript `
        (Get-SelfTestRestoreArguments $fixture $removalId ([string]$removed.receiptSha256) $restoreId)) 'restored-disabled'
    Assert-SelfTest ([bool]$restored.activationRequired) 'restore implied activation'
    $restoredAgain = Assert-SelfTestSuccess (Invoke-SelfTestChild $restoreScript `
        (Get-SelfTestRestoreArguments $fixture $removalId ([string]$removed.receiptSha256) $restoreId)) 'restored-disabled'
    Assert-SelfTest ([bool]$restoredAgain.reused) 'restore was not idempotent'
    Assert-SelfTestPreimageExact -Fixture $fixture -Tree $baselineTree -Acl $baselineAcl `
        -TaskXml ([string]$baselineTask.xmlBase64) -TaskSecurity $baselineTaskSecurity
    $restoredInspection = Assert-SelfTestSuccess (Invoke-SelfTestChild $inspectScript `
        (Get-SelfTestInspectionArguments $fixture $removalId ([string]$removed.receiptSha256) $restoreId ([string]$restored.receiptSha256))) `
        'restored-disabled'
    Assert-SelfTest ([bool]$restoredInspection.activationRequired -and [bool]$restoredInspection.verified) `
        'restored inspection did not require coordinator activation'
    $tests.Add('restore-disabled-success-inspection-idempotency')

    [pscustomobject][ordered]@{
        protocol = 'DYSON_GSMANAGER_REMOVAL_SELFTEST_V1'
        status = 'passed'
        tests = @($tests)
        testCount = $tests.Count
    } | ConvertTo-Json -Depth 6 -Compress
}
finally {
    $env:DYSON_GSMANAGER_REMOVAL_SELFTEST_FAIL_POINT = $null
    $env:DYSON_GSMANAGER_REMOVAL_SELFTEST = $null
    $env:DYSON_CUTOVER_HOST_SELFTEST = $null
    if (Test-Path -LiteralPath $testRoot) {
        Remove-Item -LiteralPath $testRoot -Recurse -Force -ErrorAction SilentlyContinue
    }
}
