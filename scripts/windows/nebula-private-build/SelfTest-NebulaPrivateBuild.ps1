[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2.0
. (Join-Path $PSScriptRoot 'NebulaPrivateBuild.Common.ps1')

$script:Passed = 0
$script:Failed = 0
$script:Results = New-Object Collections.Generic.List[object]

function Add-SelfTestResult {
    param([string]$Name, [bool]$Passed, [string]$Detail)
    if ($Passed) { $script:Passed++ } else { $script:Failed++ }
    $script:Results.Add([pscustomobject][ordered]@{ name = $Name; passed = $Passed; detail = $Detail })
}

function Test-Case {
    param([Parameter(Mandatory)][string]$Name, [Parameter(Mandatory)][scriptblock]$Body)
    try { & $Body; Add-SelfTestResult -Name $Name -Passed $true -Detail 'ok' }
    catch {
        $detail = Get-NebulaPrivateErrorCode -Exception $_.Exception
        if ($detail -ceq 'NEBULA_PRIVATE_UNEXPECTED_FAILURE') {
            $detail = if ($_.Exception.Message.Length -le 160 -and $_.Exception.Message -notmatch '[\\/:]') {
                $_.Exception.Message
            } else { $_.Exception.GetType().Name }
        }
        Add-SelfTestResult -Name $Name -Passed $false -Detail $detail
    }
}

function Assert-True {
    param([bool]$Condition, [string]$Code = 'SELFTEST_ASSERTION_FAILED')
    if (-not $Condition) { throw $Code }
}

function Get-NestedTransactionFailureCode {
    param([Parameter(Mandatory)]$Failure)
    # Preserve the failing case even when its diagnostic contains a local path
    # or a long child-process error. Only fixed-format identifiers leave here.
    $name = [string]$Failure.name
    if ($name -cnotmatch '^[a-z0-9][a-z0-9-]{0,95}$') { $name = 'unknown-case' }
    $code = 'NEBULA_PRIVATE_NESTED_CASE_' + $name.ToUpperInvariant().Replace('-', '_')
    $childCode = [regex]::Match([string]$Failure.detail,
        '(?<![A-Z0-9_])(?:NEBULA_PRIVATE|NEBULA_PLUGIN)_[A-Z0-9_]{1,96}(?![A-Z0-9_])')
    if ($childCode.Success) { $code += '__' + $childCode.Value }
    return $code
}

function Assert-ThrowsCode {
    param([Parameter(Mandatory)][scriptblock]$Body, [Parameter(Mandatory)][string]$Code)
    try { & $Body; throw ('SELFTEST_EXPECTED_ERROR_NOT_THROWN_' + $Code) }
    catch {
        $actual = Get-NebulaPrivateErrorCode -Exception $_.Exception
        if ($actual -cne $Code) { throw ('SELFTEST_WRONG_ERROR_' + $actual + '_EXPECTED_' + $Code) }
    }
}

function Write-FixtureBytes {
    param([string]$Path, [byte[]]$Bytes)
    $parent = [IO.Path]::GetDirectoryName($Path)
    [IO.Directory]::CreateDirectory($parent) | Out-Null
    [IO.File]::WriteAllBytes($Path, $Bytes)
}

function Write-FixtureText {
    param([string]$Path, [string]$Text)
    Write-FixtureBytes -Path $Path -Bytes ([Text.UTF8Encoding]::new($false).GetBytes($Text))
}

function Copy-FixtureTree {
    param([string]$SourceRoot, [string]$DestinationRoot)
    foreach ($record in Get-NebulaPrivatePlainFiles -Root $SourceRoot) {
        $destination = Join-Path $DestinationRoot ([string]$record.path).Replace('/', '\')
        Write-FixtureBytes -Path $destination -Bytes ([IO.File]::ReadAllBytes([string]$record.fullPath))
    }
}

function New-FixtureMetadata {
    param([string]$HarvestRoot, [string]$NetworkProductVersion = '0.9.22.2',
        [string]$WebSocketVersion = '1.0.2.31281', [string]$WebSocketPublicKeyToken = '5660b08a1845a91e')
    $artifacts = @()
    foreach ($relative in $script:NebulaPrivateCustomFiles) {
        $path = Join-Path $HarvestRoot $relative.Replace('/', '\')
        $artifacts += [pscustomobject][ordered]@{
            path = $relative
            kind = if ($relative -like '*.dll') { 'managed-dll' } else { 'portable-pdb' }
            size = [int64](Get-Item -LiteralPath $path).Length
            sha256 = Get-NebulaPrivateFileSha256 -Path $path
        }
    }
    $baseReferences = @(
        [pscustomobject][ordered]@{ name = 'NebulaAPI'; version = '2.1.0.0'; publicKeyToken = 'none' },
        [pscustomobject][ordered]@{ name = 'NebulaModel'; version = '0.9.22.0'; publicKeyToken = 'none' },
        [pscustomobject][ordered]@{ name = 'NebulaWorld'; version = '0.9.22.0'; publicKeyToken = 'none' }
    )
    $networkReferences = @($baseReferences + @(
        [pscustomobject][ordered]@{ name = 'Open.Nat'; version = '1.0.0.0'; publicKeyToken = 'f22a6a4582336c76' },
        [pscustomobject][ordered]@{ name = 'websocket-sharp'; version = $WebSocketVersion; publicKeyToken = $WebSocketPublicKeyToken }
    ))
    $patcherReferences = @($baseReferences + @(
        [pscustomobject][ordered]@{ name = 'NebulaNetwork'; version = '0.9.22.0'; publicKeyToken = 'none' }
    ))
    $assemblies = @(
        [pscustomobject][ordered]@{
            path = 'nebula-NebulaMultiplayerMod/NebulaNetwork.dll'
            name = 'NebulaNetwork'
            assemblyVersion = '0.9.22.0'
            fileVersion = '0.9.22.2'
            productVersion = $NetworkProductVersion
            publicKeyToken = 'none'
            mvid = '11111111-1111-4111-8111-111111111111'
            references = $networkReferences
            debug = [pscustomobject][ordered]@{
                pdbPath = 'nebula-NebulaMultiplayerMod/NebulaNetwork.pdb'
                codeViewGuid = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
                codeViewAge = 1
                codeViewTimestamp = '12345678'
                pdbIdGuid = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
                pdbIdStamp = '12345678'
                codeViewPath = 'NebulaNetwork.pdb'
            }
        },
        [pscustomobject][ordered]@{
            path = 'nebula-NebulaMultiplayerMod/NebulaPatcher.dll'
            name = 'NebulaPatcher'
            assemblyVersion = '0.9.22.0'
            fileVersion = '0.9.22.2'
            productVersion = '0.9.22.2'
            publicKeyToken = 'none'
            mvid = '22222222-2222-4222-8222-222222222222'
            references = $patcherReferences
            debug = [pscustomobject][ordered]@{
                pdbPath = 'nebula-NebulaMultiplayerMod/NebulaPatcher.pdb'
                codeViewGuid = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
                codeViewAge = 1
                codeViewTimestamp = '90abcdef'
                pdbIdGuid = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
                pdbIdStamp = '90abcdef'
                codeViewPath = '/_/src/NebulaPatcher.pdb'
            }
        }
    )
    return [pscustomobject][ordered]@{
        protocol = $script:NebulaPrivateMetadataProtocol
        schemaVersion = 1
        source = [pscustomobject][ordered]@{
            upstreamCommit = [string]$script:NebulaPrivateContract.upstream.commit
            websocketSubmoduleCommit = [string]$script:NebulaPrivateContract.upstream.websocketSubmoduleCommit
            sourceContractSha256 = [string]$script:NebulaPrivateContract.sourcePatch.contractSha256
            patchSha256 = [string]$script:NebulaPrivateContract.sourcePatch.patchSha256
            patchedFiles = @($script:NebulaPrivateContract.sourcePatch.patchedFiles)
        }
        game = [pscustomobject][ordered]@{
            gameLibPackage = [string]$script:NebulaPrivateContract.game.gameLibPackage
            gameLibVersion = [string]$script:NebulaPrivateContract.game.gameLibVersion
            gameVersion = [string]$script:NebulaPrivateContract.game.gameVersion
            assemblyCSharpMvid = [string]$script:NebulaPrivateContract.game.assemblyCSharpMvid
        }
        build = [pscustomobject][ordered]@{
            configuration = 'Release'
            buildPlanDigest = ('d' * 64)
            inputFingerprintSha256 = Get-NebulaPrivateExpectedBuildInputFingerprint
            stockReferences = @($script:NebulaPrivateContract.candidate.buildStockReferences | ForEach-Object {
                [pscustomobject][ordered]@{
                    project = [string]$_.project
                    archivePath = [string]$_.archivePath
                    sourceArchiveSha256 = [string]$_.sourceArchiveSha256
                    outputFileName = [string]$_.outputFileName
                    size = [int64]$_.size
                    sha256 = [string]$_.sha256
                    assemblyIdentity = [pscustomobject][ordered]@{
                        name = [string]$_.assemblyIdentity.name
                        version = [string]$_.assemblyIdentity.version
                        culture = [string]$_.assemblyIdentity.culture
                        publicKeyToken = [string]$_.assemblyIdentity.publicKeyToken
                        mvid = [string]$_.assemblyIdentity.mvid
                    }
                }
            })
            noAutoResponse = $true
            buildProjectReferences = $false
            restoreRecursive = $false
            directoryBuildTargetsIsolated = $true
            outputsIsolated = $true
            nugetIsolated = $true
            tempIsolated = $true
            pathMapTarget = '/_/src'
            pathMapIntermediateTarget = '/_/obj'
            pathMapOutputTarget = '/_/out'
        }
        artifacts = $artifacts
        assemblies = $assemblies
        publicHygieneFindings = @()
    }
}

function New-FixtureZip {
    param([string]$Path, [Collections.IDictionary]$Entries)
    Add-Type -AssemblyName System.IO.Compression
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $stream = [IO.File]::Open($Path, [IO.FileMode]::CreateNew, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)
    $archive = [IO.Compression.ZipArchive]::new($stream, [IO.Compression.ZipArchiveMode]::Create, $false)
    try {
        foreach ($name in @($Entries.Keys | Sort-Object -CaseSensitive)) {
            $entry = $archive.CreateEntry([string]$name)
            $writer = [IO.StreamWriter]::new($entry.Open(), [Text.UTF8Encoding]::new($false))
            try { $writer.Write([string]$Entries[$name]) } finally { $writer.Dispose() }
        }
    }
    finally { $archive.Dispose(); $stream.Dispose() }
}

$fixtureRoot = $null
try {
    $tempBase = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\')
    $fixtureRoot = Join-Path $tempBase ('dyson-nebula-private-selftest-' + [guid]::NewGuid().ToString('N'))
    [IO.Directory]::CreateDirectory($fixtureRoot) | Out-Null
    $jobBase = Join-Path $fixtureRoot 'jobs'
    [IO.Directory]::CreateDirectory($jobBase) | Out-Null
    $requestId = [guid]::NewGuid().ToString('D').ToLowerInvariant()
    $jobRoot = Join-Path $jobBase $requestId
    $repositoryRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..\..'))
    $sourceContractPath = Join-Path $repositoryRoot 'integrations\nebula-hostname-wss\contract.json'
    $patchPath = Join-Path $repositoryRoot 'integrations\nebula-hostname-wss\patches\nebula-v0.9.22-hostname-wss.patch'

    Test-Case 'uuid-and-request-scoped-job-root' {
        Assert-True (Test-NebulaPrivateUuid -Value $requestId)
        $resolved = Assert-NebulaPrivateJobRoot -JobRoot $jobRoot -JobBase $jobBase -RequestId $requestId
        Assert-True ($resolved.Equals([IO.Path]::GetFullPath($jobRoot), [StringComparison]::OrdinalIgnoreCase))
        Assert-ThrowsCode { Assert-NebulaPrivateJobRoot -JobRoot (Join-Path $jobBase 'wrong') -JobBase $jobBase `
            -RequestId $requestId } 'NEBULA_PRIVATE_JOB_ROOT_NOT_REQUEST_SCOPED'
        Assert-ThrowsCode { Assert-NebulaPrivateJobRoot -JobRoot $jobRoot -JobBase $jobBase `
            -RequestId $requestId.ToUpperInvariant() } 'NEBULA_PRIVATE_REQUEST_ID_INVALID'
    }

    Test-Case 'reject-unc-traversal-protected-shared-paths' {
        Assert-ThrowsCode { Get-NebulaPrivateFullPath -Path '\\fictional.example\share\job' } `
            'NEBULA_PRIVATE_PATH_NOT_LOCAL_ABSOLUTE'
        Assert-ThrowsCode { Get-NebulaPrivateFullPath -Path 'C:\Fictional\safe\..\escape' } `
            'NEBULA_PRIVATE_PATH_NOT_LOCAL_ABSOLUTE'
        Assert-ThrowsCode { Get-NebulaPrivateFullPath -Path 'C:\Fictional\file.txt:hidden' } 'NEBULA_PRIVATE_PATH_NOT_LOCAL_ABSOLUTE'
        Assert-ThrowsCode { Get-NebulaPrivateFullPath -Path 'C:\Fictional\NUL.txt' } 'NEBULA_PRIVATE_PATH_NOT_LOCAL_ABSOLUTE'
        Assert-ThrowsCode { Get-NebulaPrivateFullPath -Path 'C:\Fictional\alias.\child' } 'NEBULA_PRIVATE_PATH_NOT_LOCAL_ABSOLUTE'
        Assert-ThrowsCode { Assert-NebulaPrivateSafeLocalRoot -Path 'C:\Program Files\FictionalJob' } `
            'NEBULA_PRIVATE_PROTECTED_PATH_REJECTED'
        Assert-ThrowsCode { Assert-NebulaPrivateSafeLocalRoot -Path 'C:\Fictional\Steam\jobs' } `
            'NEBULA_PRIVATE_PROTECTED_PATH_REJECTED'
        $shared = Join-Path $fixtureRoot 'shared'
        [IO.Directory]::CreateDirectory($shared) | Out-Null
        Assert-ThrowsCode { Assert-NebulaPrivateSafeLocalRoot -Path $jobBase -DeniedRoots @($fixtureRoot) } `
            'NEBULA_PRIVATE_SHARED_PATH_REJECTED'
    }

    Test-Case 'reject-reparse-ancestor' {
        $target = Join-Path $fixtureRoot 'junction-target'
        $junction = Join-Path $fixtureRoot 'junction-root'
        [IO.Directory]::CreateDirectory($target) | Out-Null
        New-Item -ItemType Junction -Path $junction -Target $target -ErrorAction Stop | Out-Null
        Assert-ThrowsCode { Assert-NebulaPrivateNoReparseAncestors -Path (Join-Path $junction 'child') } `
            'NEBULA_PRIVATE_REPARSE_POINT_REJECTED'
    }

    Test-Case 'source-contract-and-two-file-patch-anchors' {
        Assert-NebulaPrivateContractAnchors -SourceContractPath $sourceContractPath -PatchPath $patchPath
        $altered = Join-Path $fixtureRoot 'altered-contract.json'
        [IO.File]::Copy($sourceContractPath, $altered, $false)
        [IO.File]::AppendAllText($altered, " `n", [Text.UTF8Encoding]::new($false))
        Assert-ThrowsCode { Assert-NebulaPrivateContractAnchors -SourceContractPath $altered -PatchPath $patchPath } `
            'NEBULA_PRIVATE_SOURCE_ANCHOR_MISMATCH'
    }

    Test-Case 'build-plan-defaults-to-non-executing-isolation' {
        $result = & (Join-Path $PSScriptRoot 'New-NebulaPrivateBuildPlan.ps1') -RequestId $requestId `
            -JobBase $jobBase -SourceContractPath $sourceContractPath -PatchPath $patchPath | ConvertFrom-Json
        Assert-True ($result.executionEnabled -is [bool] -and -not $result.executionEnabled)
        Assert-True ($result.executorIncluded -is [bool] -and -not $result.executorIncluded)
        $planPath = Join-Path $jobRoot 'evidence\build-plan.json'
        $plan = Get-Content -LiteralPath $planPath -Raw -Encoding UTF8 | ConvertFrom-Json
        [void](Assert-NebulaPrivateBuildPlan -Plan $plan -RequestId $requestId -JobRoot $jobRoot)
        Assert-True (-not [bool]$plan.executionEnabled -and -not [bool]$plan.executorIncluded)
        Assert-True ([bool]$plan.isolation.noAutoResponse -and [bool]$plan.isolation.outputsIsolated -and
            [bool]$plan.isolation.nugetIsolated -and [bool]$plan.isolation.tempIsolated)
        Assert-True (@($plan.builds).Count -eq 2)
        Assert-True ([string]$plan.inputFingerprintSha256 -ceq (Get-NebulaPrivateExpectedBuildInputFingerprint))
        Assert-True ((Get-NebulaPrivateObjectSha256 -Value $plan.inputs) -ceq
            (Get-NebulaPrivateExpectedBuildInputFingerprint))
        foreach ($build in @($plan.builds)) {
            Assert-True ([string]$build.inputFingerprintSha256 -ceq [string]$plan.inputFingerprintSha256)
            Assert-True (@($build.invocation.mandatoryArguments) -ccontains '-noAutoResponse')
            Assert-True ([string]$build.invocation.executable -ceq 'dotnet')
            Assert-True ([string]$build.invocation.verb -ceq 'msbuild')
            Assert-True (@($build.invocation.projectsInOrder).Count -eq 7)
            Assert-True (@($build.invocation.projectsInOrder | Where-Object {
                [string]$_.mode -ceq 'verified-stock-reference'
            }).Count -eq 1)
            Assert-True (@($build.invocation.projectsInOrder | Where-Object {
                [string]$_.mode -ceq 'msbuild'
            }).Count -eq 6)
            $stockProject = @($build.invocation.projectsInOrder | Where-Object {
                [string]$_.mode -ceq 'verified-stock-reference'
            })[0]
            Assert-True ([string]$stockProject.name -ceq 'websocket-sharp')
            Assert-True ([string]$stockProject.stockReference.archivePath -ceq
                'nebula-NebulaMultiplayerMod/websocket-sharp.dll')
            Assert-True ([int64]$stockProject.stockReference.size -eq 245248)
            Assert-True ([string]$stockProject.stockReference.sha256 -ceq
                'a54a1400c4f0e4476b1c411bb004ae04695b6412c026ed771f0c7649c74a4b2d')
            Assert-True ([string]$stockProject.stockReference.sourceArchiveSha256 -ceq
                [string]$script:NebulaPrivateContract.candidate.officialMainArchiveSha256)
            Assert-True ([string]$stockProject.stockReference.assemblyIdentity.mvid -ceq
                '36626a57-1b03-4929-be21-7448ddd4d784')
            $projectIntermediateRoots = @($build.invocation.projectsInOrder | ForEach-Object { [string]$_.intermediateRoot })
            Assert-True (@($projectIntermediateRoots | Sort-Object -Unique).Count -eq 7)
            foreach ($projectRoot in $projectIntermediateRoots) {
                Assert-True (Test-NebulaPrivatePathWithin -Candidate $projectRoot -Parent ([string]$build.intermediateRoot))
            }
            Assert-True (@($build.invocation.projectsInOrder | Where-Object { [bool]$_.harvestEligible }).Count -eq 2)
            Assert-True (@($build.invocation.harvestProjects).Count -eq 2)
            Assert-True (@($build.invocation.allowedHarvest).Count -eq 4)
            Assert-True ([bool]$build.invocation.dependencyClosureOutputsAreBuildOnly)
            Assert-True ([string]$build.invocation.properties.RestoreRecursive -ceq 'false')
            Assert-True ([string]$build.invocation.properties.PathMap -ceq
                (([string]$build.sourceRoot) + '=' + [string]$script:NebulaPrivateContract.pathMapTarget + '%2C' +
                ([string]$build.intermediateRoot) + '=' + [string]$script:NebulaPrivateContract.pathMapIntermediateTarget + '%2C' +
                ([string]$build.outputRoot) + '=' + [string]$script:NebulaPrivateContract.pathMapOutputTarget))
            Assert-True ([string]$build.environment.DOTNET_CLI_TELEMETRY_OPTOUT -ceq '1')
            Assert-True ([string]$build.environment.DOTNET_SKIP_FIRST_TIME_EXPERIENCE -ceq '1')
            Assert-True ([string]$build.environment.DOTNET_NOLOGO -ceq '1')
            Assert-True ([string]$build.environment.DOTNET_MULTILEVEL_LOOKUP -ceq '0')
            Assert-True ([string]$build.environment.NUGET_XMLDOC_MODE -ceq 'skip')
            foreach ($pathValue in @($build.sourceRoot,$build.outputRoot,$build.intermediateRoot,$build.harvestRoot,
                $build.environment.DOTNET_CLI_HOME,$build.environment.NUGET_PACKAGES,$build.environment.NUGET_HTTP_CACHE_PATH,
                $build.environment.TEMP,$build.environment.TMP)) {
                Assert-True (Test-NebulaPrivatePathWithin -Candidate ([string]$pathValue) -Parent $jobRoot)
            }
        }
        $buildA = @($plan.builds | Where-Object { [string]$_.slot -ceq 'a' })[0]
        $buildB = @($plan.builds | Where-Object { [string]$_.slot -ceq 'b' })[0]
        foreach ($pair in @(
            @($buildA.sourceRoot,$buildB.sourceRoot), @($buildA.outputRoot,$buildB.outputRoot),
            @($buildA.intermediateRoot,$buildB.intermediateRoot), @($buildA.harvestRoot,$buildB.harvestRoot),
            @($buildA.environment.DOTNET_CLI_HOME,$buildB.environment.DOTNET_CLI_HOME),
            @($buildA.environment.NUGET_PACKAGES,$buildB.environment.NUGET_PACKAGES),
            @($buildA.environment.NUGET_HTTP_CACHE_PATH,$buildB.environment.NUGET_HTTP_CACHE_PATH),
            @($buildA.environment.TEMP,$buildB.environment.TEMP),
            @($buildA.invocation.properties.DirectoryBuildPropsPath,$buildB.invocation.properties.DirectoryBuildPropsPath),
            @($buildA.invocation.properties.RestoreConfigFile,$buildB.invocation.properties.RestoreConfigFile)
        )) {
            Assert-True (-not ([string]$pair[0]).Equals([string]$pair[1], [StringComparison]::OrdinalIgnoreCase))
        }
        foreach ($configPath in @($buildA.invocation.properties.RestoreConfigFile,
            $buildB.invocation.properties.RestoreConfigFile)) {
            $configText = Get-Content -LiteralPath ([string]$configPath) -Raw
            Assert-True ($configText -match '<clear\s*/>')
            Assert-True ($configText.Contains('https://api.nuget.org/v3/index.json'))
            Assert-True ($configText.Contains('https://nuget.bepinex.dev/v3/index.json'))
            Assert-True (@([regex]::Matches($configText, '<add\s+key="[^"]+"\s+value="https://')).Count -eq 2)
            Assert-True ($configText -match '<packageSourceMapping>')
            Assert-True ($configText -notmatch '<package\s+pattern="[^"]*[*?\[\]]')
            foreach ($source in @($script:NebulaPrivateContract.restore.packageSources)) {
                Assert-True ($configText -match ('<packageSource\s+key="' + [regex]::Escape([string]$source.key) + '">'))
                foreach ($packageId in @($source.packageIds)) {
                    Assert-True ($configText -match ('<package\s+pattern="' + [regex]::Escape([string]$packageId) + '"\s*/>'))
                }
            }
        }
        foreach ($propsPath in @($buildA.invocation.properties.DirectoryBuildPropsPath,
            $buildB.invocation.properties.DirectoryBuildPropsPath)) {
            $propsText = Get-Content -LiteralPath ([string]$propsPath) -Raw
            Assert-True ($propsText -notmatch 'jnm2\.ReferenceAssemblies\.net35')
            Assert-True ($propsText -notmatch 'Version="[^"]*[*?\[\]\(\),]')
            Assert-True ($propsText -match "MSBuildProjectName\)' == 'discord_game_sdk_dotnet'")
            Assert-True ($propsText -match "MSBuildProjectName\)' != 'websocket-sharp' And '\$\(MSBuildProjectName\)' != 'discord_game_sdk_dotnet'")
        }
        $targetText = Get-Content -LiteralPath (Join-Path $jobRoot 'isolation\Directory.Build.targets') -Raw
        Assert-True ($targetText -notmatch '<Exec\b|<Copy\b')
        Assert-True ($targetText -match 'NEBULA_PRIVATE_OUTPUT_OUTSIDE_JOB_ROOT')
        $planProjection = [ordered]@{}
        foreach ($property in $plan.PSObject.Properties) {
            if ($property.Name -cne 'previewDigest') { $planProjection[$property.Name] = $property.Value }
        }
        Assert-True ([string]$plan.previewDigest -ceq (Get-NebulaPrivateObjectSha256 -Value $planProjection))
        $tamperedPlan = Get-Content -LiteralPath $planPath -Raw -Encoding UTF8 | ConvertFrom-Json
        $tamperedPlan.gameGate.gameVersion = '0.10.34.28518'
        Assert-ThrowsCode { Assert-NebulaPrivateBuildPlan -Plan $tamperedPlan -RequestId $requestId -JobRoot $jobRoot } `
            'NEBULA_PRIVATE_BUILD_PLAN_INVALID'
        $sharedNugetPlan = Get-Content -LiteralPath $planPath -Raw -Encoding UTF8 | ConvertFrom-Json
        $sharedNugetPlan.builds[1].environment.NUGET_PACKAGES = [string]$sharedNugetPlan.builds[0].environment.NUGET_PACKAGES
        $sharedNugetPlan.builds[1].invocation.properties.RestorePackagesPath = `
            [string]$sharedNugetPlan.builds[0].invocation.properties.RestorePackagesPath
        $sharedNugetProjection = [ordered]@{}
        foreach ($property in $sharedNugetPlan.PSObject.Properties) {
            if ($property.Name -cne 'previewDigest') { $sharedNugetProjection[$property.Name] = $property.Value }
        }
        $sharedNugetPlan.previewDigest = Get-NebulaPrivateObjectSha256 -Value $sharedNugetProjection
        Assert-ThrowsCode { Assert-NebulaPrivateBuildPlan -Plan $sharedNugetPlan -RequestId $requestId -JobRoot $jobRoot } `
            'NEBULA_PRIVATE_RESTORE_CONTRACT_INVALID'
        $badStockPlan = Get-Content -LiteralPath $planPath -Raw -Encoding UTF8 | ConvertFrom-Json
        $badStockPlan.builds[0].invocation.projectsInOrder[0].stockReference.sha256 = ('0' * 64)
        $badStockProjection = [ordered]@{}
        foreach ($property in $badStockPlan.PSObject.Properties) {
            if ($property.Name -cne 'previewDigest') { $badStockProjection[$property.Name] = $property.Value }
        }
        $badStockPlan.previewDigest = Get-NebulaPrivateObjectSha256 -Value $badStockProjection
        Assert-ThrowsCode { Assert-NebulaPrivateBuildPlan -Plan $badStockPlan -RequestId $requestId -JobRoot $jobRoot } `
            'NEBULA_PRIVATE_BUILD_PLAN_INVALID'
        $badInputPlan = Get-Content -LiteralPath $planPath -Raw -Encoding UTF8 | ConvertFrom-Json
        $badInputPlan.inputFingerprintSha256 = ('0' * 64)
        $badInputProjection = [ordered]@{}
        foreach ($property in $badInputPlan.PSObject.Properties) {
            if ($property.Name -cne 'previewDigest') { $badInputProjection[$property.Name] = $property.Value }
        }
        $badInputPlan.previewDigest = Get-NebulaPrivateObjectSha256 -Value $badInputProjection
        Assert-ThrowsCode { Assert-NebulaPrivateBuildPlan -Plan $badInputPlan -RequestId $requestId -JobRoot $jobRoot } `
            'NEBULA_PRIVATE_BUILD_INPUT_INVALID'
    }

    $fixtureBaseline = Join-Path $jobRoot 'fixture-baseline'
    $fixtureCandidate = Join-Path $jobRoot 'fixture-candidate'
    foreach ($relative in $script:NebulaPrivateExpectedFiles) {
        $baselinePath = Join-Path $fixtureBaseline $relative.Replace('/', '\')
        $candidatePath = Join-Path $fixtureCandidate $relative.Replace('/', '\')
        $baseBytes = if ($relative -like '*.dll') {
            [Text.Encoding]::ASCII.GetBytes('MZofficial-' + $relative)
        } elseif ($relative -like '*.pdb') {
            [Text.Encoding]::ASCII.GetBytes('BSJBofficial-' + $relative)
        } else { [Text.UTF8Encoding]::new($false).GetBytes('fictional-stock-' + $relative) }
        $candidateBytes = if ($relative -cin $script:NebulaPrivateCustomFiles) {
            if ($relative -like '*.dll') { [Text.Encoding]::ASCII.GetBytes('MZprivate-' + $relative) }
            else { [Text.Encoding]::ASCII.GetBytes('BSJBprivate-' + $relative) }
        } else { $baseBytes }
        Write-FixtureBytes -Path $baselinePath -Bytes $baseBytes
        Write-FixtureBytes -Path $candidatePath -Bytes $candidateBytes
    }

    Test-Case 'candidate-exact-38-plus-6-and-40-stock-bytes' {
        $result = Assert-NebulaPrivateCandidateTrees -BaselineRoot $fixtureBaseline -CandidateRoot $fixtureCandidate
        Assert-True ([int]$result.totalFiles -eq 44 -and [int]$result.stockFiles -eq 40 -and [int]$result.customFiles -eq 4)
    }

    Test-Case 'candidate-rejects-extra-missing-and-stock-drift' {
        $extra = Join-Path $fixtureCandidate 'unexpected.dll'
        Write-FixtureText -Path $extra -Text 'MZextra'
        Assert-ThrowsCode { Assert-NebulaPrivateCandidateTrees -BaselineRoot $fixtureBaseline `
            -CandidateRoot $fixtureCandidate } 'NEBULA_PRIVATE_CANDIDATE_FILE_SET_INVALID'
        [IO.File]::Delete($extra)
        $missingRelative = 'nebula-NebulaMultiplayerMod/README.md'
        $missing = Join-Path $fixtureCandidate $missingRelative.Replace('/', '\')
        $saved = [IO.File]::ReadAllBytes($missing)
        [IO.File]::Delete($missing)
        Assert-ThrowsCode { Assert-NebulaPrivateCandidateTrees -BaselineRoot $fixtureBaseline `
            -CandidateRoot $fixtureCandidate } 'NEBULA_PRIVATE_CANDIDATE_FILE_SET_INVALID'
        Write-FixtureBytes -Path $missing -Bytes $saved
        Write-FixtureText -Path $missing -Text 'fictional-stock-drift'
        Assert-ThrowsCode { Assert-NebulaPrivateCandidateTrees -BaselineRoot $fixtureBaseline `
            -CandidateRoot $fixtureCandidate } 'NEBULA_PRIVATE_STOCK_BYTES_CHANGED'
        Write-FixtureBytes -Path $missing -Bytes $saved
    }

    Test-Case 'candidate-rejects-unreplaced-custom-file' {
        $relative = 'nebula-NebulaMultiplayerMod/NebulaNetwork.dll'
        $candidatePath = Join-Path $fixtureCandidate $relative.Replace('/', '\')
        $privateBytes = [IO.File]::ReadAllBytes($candidatePath)
        [IO.File]::Copy((Join-Path $fixtureBaseline $relative.Replace('/', '\')), $candidatePath, $true)
        Assert-ThrowsCode { Assert-NebulaPrivateCandidateTrees -BaselineRoot $fixtureBaseline `
            -CandidateRoot $fixtureCandidate } 'NEBULA_PRIVATE_CUSTOM_FILE_NOT_REPLACED'
        Write-FixtureBytes -Path $candidatePath -Bytes $privateBytes
    }

    $harvestA = Join-Path $jobRoot 'fixture-harvest-a'
    $harvestB = Join-Path $jobRoot 'fixture-harvest-b'
    foreach ($relative in $script:NebulaPrivateCustomFiles) {
        $source = Join-Path $fixtureCandidate $relative.Replace('/', '\')
        Write-FixtureBytes -Path (Join-Path $harvestA $relative.Replace('/', '\')) -Bytes ([IO.File]::ReadAllBytes($source))
        Write-FixtureBytes -Path (Join-Path $harvestB $relative.Replace('/', '\')) -Bytes ([IO.File]::ReadAllBytes($source))
    }
    $metadataA = New-FixtureMetadata -HarvestRoot $harvestA
    $metadataB = New-FixtureMetadata -HarvestRoot $harvestB

    Test-Case 'metadata-validates-game-28529-mvid-assemblyref-pdb' {
        [void](Assert-NebulaPrivateMetadata -Metadata $metadataA -HarvestRoot $harvestA)
        Assert-NebulaPrivateDeterministicBuilds -MetadataA $metadataA -MetadataB $metadataB `
            -HarvestRootA $harvestA -HarvestRootB $harvestB
    }

    Test-Case 'metadata-rejects-wrong-game-version-and-mvid' {
        $bad = New-FixtureMetadata -HarvestRoot $harvestA
        $bad.game.gameVersion = '0.10.34.28518'
        Assert-ThrowsCode { Assert-NebulaPrivateMetadata -Metadata $bad -HarvestRoot $harvestA } `
            'NEBULA_PRIVATE_GAME_VERSION_INVALID'
        $bad = New-FixtureMetadata -HarvestRoot $harvestA
        $bad.game.assemblyCSharpMvid = '33333333-3333-4333-8333-333333333333'
        Assert-ThrowsCode { Assert-NebulaPrivateMetadata -Metadata $bad -HarvestRoot $harvestA } `
            'NEBULA_PRIVATE_GAME_VERSION_INVALID'
    }

    Test-Case 'metadata-rejects-websocket-version-and-strong-name' {
        $badVersion = New-FixtureMetadata -HarvestRoot $harvestA -WebSocketVersion '1.0.3.0'
        Assert-ThrowsCode { Assert-NebulaPrivateMetadata -Metadata $badVersion -HarvestRoot $harvestA } `
            'NEBULA_PRIVATE_ASSEMBLY_REFERENCE_INVALID'
        $badToken = New-FixtureMetadata -HarvestRoot $harvestA -WebSocketPublicKeyToken 'none'
        Assert-ThrowsCode { Assert-NebulaPrivateMetadata -Metadata $badToken -HarvestRoot $harvestA } `
            'NEBULA_PRIVATE_ASSEMBLY_REFERENCE_INVALID'
        $badStock = New-FixtureMetadata -HarvestRoot $harvestA
        $badStock.build.stockReferences[0].assemblyIdentity.mvid = '33333333-3333-4333-8333-333333333333'
        Assert-ThrowsCode { Assert-NebulaPrivateMetadata -Metadata $badStock -HarvestRoot $harvestA } `
            'NEBULA_PRIVATE_BUILD_STOCK_REFERENCE_INVALID'
        $badFingerprint = New-FixtureMetadata -HarvestRoot $harvestA
        $badFingerprint.build.inputFingerprintSha256 = ('0' * 64)
        Assert-ThrowsCode { Assert-NebulaPrivateMetadata -Metadata $badFingerprint -HarvestRoot $harvestA } `
            'NEBULA_PRIVATE_BUILD_GUARDS_INVALID'
    }

    Test-Case 'metadata-rejects-extra-or-missing-artifact-and-pdb-path' {
        $bad = New-FixtureMetadata -HarvestRoot $harvestA
        $bad.artifacts = @($bad.artifacts | Select-Object -First 3)
        Assert-ThrowsCode { Assert-NebulaPrivateMetadata -Metadata $bad -HarvestRoot $harvestA } `
            'NEBULA_PRIVATE_HARVEST_SCOPE_INVALID'
        $bad = New-FixtureMetadata -HarvestRoot $harvestA
        $bad.artifacts += [pscustomobject][ordered]@{ path = 'extra.dll'; kind = 'managed-dll'; size = 1; sha256 = ('0' * 64) }
        Assert-ThrowsCode { Assert-NebulaPrivateMetadata -Metadata $bad -HarvestRoot $harvestA } `
            'NEBULA_PRIVATE_HARVEST_SCOPE_INVALID'
        $bad = New-FixtureMetadata -HarvestRoot $harvestA
        $bad.assemblies[0].debug.codeViewPath = 'C:\Users\Fictional\build\NebulaNetwork.pdb'
        Assert-ThrowsCode { Assert-NebulaPrivateMetadata -Metadata $bad -HarvestRoot $harvestA } `
            'NEBULA_PRIVATE_PDB_PATH_HYGIENE_FAILED'
    }

    Test-Case 'metadata-rejects-nondeterministic-second-build' {
        $different = New-FixtureMetadata -HarvestRoot $harvestB -NetworkProductVersion '0.9.22.2+3cdf95c-different'
        Assert-ThrowsCode { Assert-NebulaPrivateDeterministicBuilds -MetadataA $metadataA -MetadataB $different `
            -HarvestRootA $harvestA -HarvestRootB $harvestB } 'NEBULA_PRIVATE_BUILDS_NOT_DETERMINISTIC'
    }

    Test-Case 'harvest-tree-rejects-extra-file' {
        $records = Get-NebulaPrivatePlainFiles -Root $harvestA
        Assert-NebulaPrivateExactFileSet -Records $records -Expected $script:NebulaPrivateCustomFiles `
            -Code 'NEBULA_PRIVATE_HARVEST_SCOPE_INVALID'
        $extra = Join-Path $harvestA 'nebula-NebulaMultiplayerMod\Extra.pdb'
        Write-FixtureText -Path $extra -Text 'BSJBextra'
        $records = Get-NebulaPrivatePlainFiles -Root $harvestA
        Assert-ThrowsCode { Assert-NebulaPrivateExactFileSet -Records $records -Expected $script:NebulaPrivateCustomFiles `
            -Code 'NEBULA_PRIVATE_HARVEST_SCOPE_INVALID' } 'NEBULA_PRIVATE_HARVEST_SCOPE_INVALID'
        [IO.File]::Delete($extra)
    }

    Test-Case 'atomic-writes-cannot-escape-job-root' {
        Assert-ThrowsCode { Write-NebulaPrivateTextAtomic -Path (Join-Path $fixtureRoot 'escaped.txt') `
            -Value 'fictional' -JobRoot $jobRoot } 'NEBULA_PRIVATE_WRITE_OUTSIDE_JOB_ROOT'
        Assert-ThrowsCode { Write-NebulaPrivateJsonAtomic -Path (Join-Path $jobRoot '..\escaped.json') `
            -Value ([ordered]@{ value = 'fictional' }) -JobRoot $jobRoot } 'NEBULA_PRIVATE_PATH_NOT_LOCAL_ABSOLUTE'
    }

    Test-Case 'zip-extraction-rejects-traversal-extra-and-duplicate' {
        $zipRoot = Join-Path $jobRoot 'zip-fixtures'
        [IO.Directory]::CreateDirectory($zipRoot) | Out-Null
        $validZip = Join-Path $zipRoot 'valid.zip'
        New-FixtureZip -Path $validZip -Entries @{
            'fictional-package/' = ''
            'fictional-package/one.txt' = 'one'
            'fictional-package/two.txt' = 'two'
        }
        $expected = @('fictional-package/one.txt','fictional-package/two.txt')
        [void](Expand-NebulaPrivateZipExact -ArchivePath $validZip -DestinationRoot (Join-Path $zipRoot 'valid-out') `
            -PackageDirectory 'fictional-package' -ExpectedRelativeFiles $expected `
            -ExpectedArchiveSha256 (Get-NebulaPrivateFileSha256 -Path $validZip) -JobRoot $jobRoot)
        $badZip = Join-Path $zipRoot 'traversal.zip'
        New-FixtureZip -Path $badZip -Entries @{ '../escape.txt' = 'escape' }
        Assert-ThrowsCode { Expand-NebulaPrivateZipExact -ArchivePath $badZip `
            -DestinationRoot (Join-Path $zipRoot 'traversal-out') -PackageDirectory 'fictional-package' `
            -ExpectedRelativeFiles @('fictional-package/one.txt') `
            -ExpectedArchiveSha256 (Get-NebulaPrivateFileSha256 -Path $badZip) -JobRoot $jobRoot } `
            'NEBULA_PRIVATE_ARCHIVE_ENTRY_INVALID'
        $absoluteZip = Join-Path $zipRoot 'absolute.zip'
        New-FixtureZip -Path $absoluteZip -Entries @{ '/fictional-package/one.txt' = 'absolute' }
        Assert-ThrowsCode { Expand-NebulaPrivateZipExact -ArchivePath $absoluteZip -DestinationRoot (Join-Path $zipRoot 'absolute-out') -PackageDirectory 'fictional-package' -ExpectedRelativeFiles @('fictional-package/one.txt') -ExpectedArchiveSha256 (Get-NebulaPrivateFileSha256 -Path $absoluteZip) -JobRoot $jobRoot } 'NEBULA_PRIVATE_ARCHIVE_ENTRY_INVALID'
        $extraZip = Join-Path $zipRoot 'extra.zip'
        New-FixtureZip -Path $extraZip -Entries @{
            'fictional-package/one.txt' = 'one'; 'fictional-package/extra.txt' = 'extra'
        }
        Assert-ThrowsCode { Expand-NebulaPrivateZipExact -ArchivePath $extraZip `
            -DestinationRoot (Join-Path $zipRoot 'extra-out') -PackageDirectory 'fictional-package' `
            -ExpectedRelativeFiles @('fictional-package/one.txt') `
            -ExpectedArchiveSha256 (Get-NebulaPrivateFileSha256 -Path $extraZip) -JobRoot $jobRoot } `
            'NEBULA_PRIVATE_ARCHIVE_ENTRY_INVALID'
        $duplicateZip = Join-Path $zipRoot 'duplicate.zip'
        New-FixtureZip -Path $duplicateZip -Entries ([ordered]@{
            'fictional-package/one.txt' = 'one'; 'one.txt' = 'duplicate'
        })
        Assert-ThrowsCode { Expand-NebulaPrivateZipExact -ArchivePath $duplicateZip `
            -DestinationRoot (Join-Path $zipRoot 'duplicate-out') -PackageDirectory 'fictional-package' `
            -ExpectedRelativeFiles @('fictional-package/one.txt') `
            -ExpectedArchiveSha256 (Get-NebulaPrivateFileSha256 -Path $duplicateZip) -JobRoot $jobRoot } `
            'NEBULA_PRIVATE_ARCHIVE_DUPLICATE_ENTRY'
    }

    Test-Case 'public-manifest-hygiene-rejects-secret-and-machine-path' {
        Test-NebulaPrivatePublicText -Value '{"path":"nebula-NebulaMultiplayerMod/NebulaNetwork.dll"}'
        Assert-ThrowsCode { Test-NebulaPrivatePublicText -Value '{"password":"fictional"}' } `
            'NEBULA_PRIVATE_PUBLIC_HYGIENE_FAILED'
        Assert-ThrowsCode { Test-NebulaPrivatePublicText -Value 'C:\Users\Fictional\build' } `
            'NEBULA_PRIVATE_PUBLIC_HYGIENE_FAILED'
        Assert-ThrowsCode { Test-NebulaPrivatePublicText -Value '\\fictional.example\share' } `
            'NEBULA_PRIVATE_PUBLIC_HYGIENE_FAILED'
    }

    Copy-FixtureTree -SourceRoot $fixtureCandidate -DestinationRoot (Join-Path $jobRoot 'candidate')
    $candidateRecords = Get-NebulaPrivatePlainFiles -Root (Join-Path $jobRoot 'candidate')
    $candidateTree = Get-NebulaPrivateTreeDigest -Records $candidateRecords
    $candidateManifestCore = [ordered]@{
        protocol = $script:NebulaPrivateCandidateProtocol
        schemaVersion = 1
        source = [ordered]@{
            upstreamCommit = [string]$script:NebulaPrivateContract.upstream.commit
            websocketSubmoduleCommit = [string]$script:NebulaPrivateContract.upstream.websocketSubmoduleCommit
            sourceContractSha256 = [string]$script:NebulaPrivateContract.sourcePatch.contractSha256
            patchSha256 = [string]$script:NebulaPrivateContract.sourcePatch.patchSha256
        }
        game = [ordered]@{
            gameVersion = [string]$script:NebulaPrivateContract.game.gameVersion
            gameLibVersion = [string]$script:NebulaPrivateContract.game.gameLibVersion
            assemblyCSharpMvid = [string]$script:NebulaPrivateContract.game.assemblyCSharpMvid
        }
        baseline = [ordered]@{
            mainArchiveSha256 = [string]$script:NebulaPrivateContract.candidate.officialMainArchiveSha256
            apiArchiveSha256 = [string]$script:NebulaPrivateContract.candidate.officialApiArchiveSha256
            sourceManifestSha256 = [string]$script:NebulaPrivateContract.candidate.officialTreeManifestSha256
            treeSha256 = [string]$script:NebulaPrivateContract.candidate.officialTreeDigestSha256
            treeDigestAlgorithm = [string]$script:NebulaPrivateContract.candidate.treeDigestAlgorithm
        }
        candidate = [ordered]@{ treeSha256 = $candidateTree; totalFiles = 44; stockFilesExact = 40; customFiles = 4 }
        deterministicBuildEvidence = [ordered]@{
            buildPlanDigest = ('d' * 64)
            inputFingerprintSha256 = Get-NebulaPrivateExpectedBuildInputFingerprint
            metadataASha256 = ('b' * 64)
            metadataBSha256 = ('c' * 64)
            matched = $true
        }
        files = @($candidateRecords | ForEach-Object {
            [pscustomobject][ordered]@{
                path = [string]$_.path
                size = [int64]$_.size
                sha256 = [string]$_.sha256
                origin = if ([string]$_.path -cin $script:NebulaPrivateCustomFiles) { 'private-build' } else { 'official-stock' }
            }
        })
    }
    $candidateManifest = [ordered]@{}
    foreach ($key in $candidateManifestCore.Keys) { $candidateManifest[$key] = $candidateManifestCore[$key] }
    $candidateManifest.manifestDigest = Get-NebulaPrivateObjectSha256 -Value $candidateManifestCore
    $candidateManifestPath = Join-Path $jobRoot 'evidence\candidate-manifest.json'
    [void](Write-NebulaPrivateJsonAtomic -Path $candidateManifestPath -Value $candidateManifest -JobRoot $jobRoot)

    Test-Case 'candidate-manifest-binds-source-game-files-and-digest' {
        $qualifiedManifest = ConvertTo-Json $candidateManifest -Depth 32 | ConvertFrom-Json
        [void](Assert-NebulaPrivateCandidateManifest -Manifest $qualifiedManifest `
            -CandidateRoot (Join-Path $jobRoot 'candidate'))
        $tampered = (ConvertTo-Json $candidateManifest -Depth 32 | ConvertFrom-Json)
        $tampered.source.upstreamCommit = ('0' * 40)
        Assert-ThrowsCode { Assert-NebulaPrivateCandidateManifest -Manifest $tampered `
            -CandidateRoot (Join-Path $jobRoot 'candidate') } 'NEBULA_PRIVATE_CANDIDATE_MANIFEST_INVALID'
        $tampered = (ConvertTo-Json $candidateManifest -Depth 32 | ConvertFrom-Json)
        $tampered.files[0].sha256 = ('0' * 64)
        Assert-ThrowsCode { Assert-NebulaPrivateCandidateManifest -Manifest $tampered `
            -CandidateRoot (Join-Path $jobRoot 'candidate') } 'NEBULA_PRIVATE_CANDIDATE_MANIFEST_INVALID'
    }

    Test-Case 'nested-transaction-diagnostics-retain-case-without-private-paths' {
        $failure = [pscustomobject]@{
            name = 'maintenance-window-expiry-after-intent-fails-closed'
            detail = 'wrong-failure: C:\fictional-fixture\script.ps1 NEBULA_PLUGIN_WINDOW_EXPIRED ' + ('x' * 200)
        }
        $code = Get-NestedTransactionFailureCode $failure
        $nestedException = [InvalidOperationException]::new($code)
        $nestedException.Data['Code'] = $code
        Assert-True ((Get-NebulaPrivateErrorCode $nestedException) -ceq
            'NEBULA_PRIVATE_NESTED_CASE_MAINTENANCE_WINDOW_EXPIRY_AFTER_INTENT_FAILS_CLOSED__NEBULA_PLUGIN_WINDOW_EXPIRED')
        Assert-True ($code -cnotmatch '[\\/:]' -and $code -notmatch 'fictional')
    }

    Test-Case 'whole-tree-cutover-transaction-adversarial-selftest' {
        $windowsPowerShell = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
        $transactionOutput = @(& $windowsPowerShell -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass `
            -File (Join-Path $PSScriptRoot 'SelfTest-NebulaPluginTransaction.ps1'))
        $transactionExitCode = [int]$LASTEXITCODE
        $transactionText = $transactionOutput -join "`n"
        if ([string]::IsNullOrWhiteSpace($transactionText)) {
            throw ('NESTED_TRANSACTION_SUMMARY_MISSING_EXIT_' + $transactionExitCode)
        }
        try { $transaction = $transactionText | ConvertFrom-Json -ErrorAction Stop }
        catch { throw ('NESTED_TRANSACTION_SUMMARY_INVALID_EXIT_' + $transactionExitCode) }
        $transactionProperties = @($transaction.PSObject.Properties | ForEach-Object { [string]$_.Name })
        if ($null -eq $transaction -or $transactionProperties.Count -ne 4 -or
            $transactionProperties -cnotcontains 'protocol' -or $transactionProperties -cnotcontains 'passed' -or
            $transactionProperties -cnotcontains 'failed' -or $transactionProperties -cnotcontains 'results' -or
            [string]$transaction.protocol -cne 'DYSON_NEBULA_PLUGIN_TRANSACTION_SELFTEST_V1') {
            throw ('NESTED_TRANSACTION_SUMMARY_INVALID_EXIT_' + $transactionExitCode)
        }
        if ($transactionExitCode -ne 0) {
            $failures = @($transaction.results | Where-Object { -not [bool]$_.passed } | Select-Object -First 1)
            if ($failures.Count -eq 0) {
                throw ('NESTED_TRANSACTION_FAILED_WITHOUT_RESULT_EXIT_' + $transactionExitCode)
            }
            $code = Get-NestedTransactionFailureCode $failures[0]
            $nestedException = [InvalidOperationException]::new($code)
            $nestedException.Data['Code'] = $code
            throw $nestedException
        }
        Assert-True ([int]$transaction.failed -eq 0 -and [int]$transaction.passed -ge 12)
        Assert-True (@($transaction.results | Where-Object { -not [bool]$_.passed }).Count -eq 0)
    }

    Test-Case 'pipeline-scripts-contain-no-arbitrary-process-executor' {
        $forbiddenCommands = @('dotnet','msbuild','Start-Process','Invoke-Expression','cmd','robocopy','xcopy')
        $scriptFiles = Get-ChildItem -LiteralPath $PSScriptRoot -Filter '*.ps1' | Where-Object {
            $_.Name -cne 'SelfTest-NebulaPrivateBuild.ps1'
        }
        foreach ($file in $scriptFiles) {
            $errors = $null
            $tokens = $null
            $ast = [Management.Automation.Language.Parser]::ParseFile($file.FullName, [ref]$tokens, [ref]$errors)
            Assert-True (@($errors).Count -eq 0)
            $commands = @($ast.FindAll({ param($node) $node -is [Management.Automation.Language.CommandAst] }, $true) |
                ForEach-Object { $_.GetCommandName() } | Where-Object { -not [string]::IsNullOrWhiteSpace($_) })
            foreach ($forbidden in $forbiddenCommands) {
                Assert-True ($commands -cnotcontains $forbidden)
            }
        }
    }
}
catch {
    Add-SelfTestResult -Name 'selftest-harness' -Passed $false -Detail $_.Exception.GetType().Name
}
finally {
    if (-not [string]::IsNullOrWhiteSpace($fixtureRoot) -and (Test-Path -LiteralPath $fixtureRoot)) {
        $fullFixture = [IO.Path]::GetFullPath($fixtureRoot).TrimEnd('\')
        $tempParent = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\')
        if ($fullFixture.StartsWith($tempParent + '\', [StringComparison]::OrdinalIgnoreCase) -and
            [IO.Path]::GetFileName($fullFixture).StartsWith('dyson-nebula-private-selftest-', [StringComparison]::Ordinal)) {
            $fixtureJunction = Join-Path $fullFixture 'junction-root'
            if (Test-Path -LiteralPath $fixtureJunction) {
                $junctionItem = Get-Item -LiteralPath $fixtureJunction -Force
                if (($junctionItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -eq 0) {
                    throw 'SELFTEST_FIXTURE_JUNCTION_IDENTITY_INVALID'
                }
                Remove-Item -LiteralPath $fixtureJunction -Force -ErrorAction Stop
            }
            [IO.Directory]::Delete($fullFixture, $true)
        }
        else { Add-SelfTestResult -Name 'fixture-cleanup-scope' -Passed $false -Detail 'unsafe-scope' }
    }
}

$result = [pscustomobject][ordered]@{
    protocol = 'DYSON_NEBULA_PRIVATE_BUILD_SELFTEST_V1'
    passed = $script:Passed
    failed = $script:Failed
    tests = @($script:Results | ForEach-Object { $_ })
}
$result | ConvertTo-Json -Depth 8
if ($script:Failed -gt 0) { exit 1 }
