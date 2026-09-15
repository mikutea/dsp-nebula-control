[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$RequestId,
    [Parameter(Mandatory)][string]$JobBase,
    [string]$SourceContractPath,
    [string]$PatchPath,
    [string]$OutputPath
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2.0
. (Join-Path $PSScriptRoot 'NebulaPrivateBuild.Common.ps1')

try {
    $repositoryRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..\..'))
    if ([string]::IsNullOrWhiteSpace($SourceContractPath)) {
        $SourceContractPath = Join-Path $repositoryRoot 'integrations\nebula-hostname-wss\contract.json'
    }
    if ([string]::IsNullOrWhiteSpace($PatchPath)) {
        $PatchPath = Join-Path $repositoryRoot 'integrations\nebula-hostname-wss\patches\nebula-v0.9.22-hostname-wss.patch'
    }

    Assert-NebulaPrivateContractAnchors -SourceContractPath $SourceContractPath -PatchPath $PatchPath
    if (-not (Test-Path -LiteralPath $JobBase -PathType Container)) {
        Throw-NebulaPrivateError -Code 'NEBULA_PRIVATE_JOB_BASE_MISSING'
    }

    $deniedRoots = @()
    foreach ($candidate in @($repositoryRoot, $env:ProgramFiles, ${env:ProgramFiles(x86)}, $env:SystemRoot)) {
        if (-not [string]::IsNullOrWhiteSpace($candidate) -and $candidate -match '^[A-Za-z]:\\') {
            $deniedRoots += [IO.Path]::GetFullPath($candidate)
        }
    }
    $jobRootCandidate = Join-Path $JobBase $RequestId
    $jobRoot = Assert-NebulaPrivateJobRoot -JobRoot $jobRootCandidate -JobBase $JobBase `
        -RequestId $RequestId -DeniedRoots $deniedRoots
    if (Test-Path -LiteralPath $jobRoot) { Throw-NebulaPrivateError -Code 'NEBULA_PRIVATE_JOB_ROOT_ALREADY_EXISTS' }
    [IO.Directory]::CreateDirectory($jobRoot) | Out-Null
    Assert-NebulaPrivateNoReparseAncestors -Path $jobRoot

    $paths = [ordered]@{
        jobRoot = $jobRoot
        sourceTemplate = Join-Path $jobRoot 'source-template'
        sourceA = Join-Path $jobRoot 'build-a\src'
        sourceB = Join-Path $jobRoot 'build-b\src'
        outputA = Join-Path $jobRoot 'build-a\out'
        outputB = Join-Path $jobRoot 'build-b\out'
        objA = Join-Path $jobRoot 'build-a\obj'
        objB = Join-Path $jobRoot 'build-b\obj'
        harvestA = Join-Path $jobRoot 'harvest-a'
        harvestB = Join-Path $jobRoot 'harvest-b'
        baseline = Join-Path $jobRoot 'baseline'
        candidate = Join-Path $jobRoot 'candidate'
        evidence = Join-Path $jobRoot 'evidence'
        archives = Join-Path $jobRoot 'archives'
        nugetPackagesA = Join-Path $jobRoot 'build-a\nuget\packages'
        nugetPackagesB = Join-Path $jobRoot 'build-b\nuget\packages'
        nugetHttpCacheA = Join-Path $jobRoot 'build-a\nuget\http-cache'
        nugetHttpCacheB = Join-Path $jobRoot 'build-b\nuget\http-cache'
        nugetConfigA = Join-Path $jobRoot 'build-a\nuget\NuGet.Config'
        nugetConfigB = Join-Path $jobRoot 'build-b\nuget\NuGet.Config'
        dotnetHomeA = Join-Path $jobRoot 'build-a\dotnet-home'
        dotnetHomeB = Join-Path $jobRoot 'build-b\dotnet-home'
        tempA = Join-Path $jobRoot 'build-a\temp'
        tempB = Join-Path $jobRoot 'build-b\temp'
        propsA = Join-Path $jobRoot 'build-a\isolation\Directory.Build.props'
        propsB = Join-Path $jobRoot 'build-b\isolation\Directory.Build.props'
        targets = Join-Path $jobRoot 'isolation\Directory.Build.targets'
    }
    foreach ($pathValue in @($paths.Values)) {
        [void](Assert-NebulaPrivateJobPath -Path ([string]$pathValue) -JobRoot $jobRoot -AllowJobRoot)
    }
    foreach ($directory in @(
        $paths.archives, $paths.nugetPackagesA, $paths.nugetPackagesB, $paths.nugetHttpCacheA,
        $paths.nugetHttpCacheB, $paths.dotnetHomeA, $paths.dotnetHomeB, $paths.tempA, $paths.tempB,
        $paths.harvestA, $paths.harvestB, $paths.evidence, (Split-Path -Parent $paths.propsA),
        (Split-Path -Parent $paths.propsB), (Split-Path -Parent $paths.targets)
    )) {
        [IO.Directory]::CreateDirectory($directory) | Out-Null
        Assert-NebulaPrivateNoReparseAncestors -Path $directory
    }

    $propsTemplate = @'
<?xml version="1.0" encoding="utf-8"?>
<Project>
  <PropertyGroup>
    <TargetFramework>net472</TargetFramework>
    <LangVersion>latest</LangVersion>
    <AllowUnsafeBlocks>true</AllowUnsafeBlocks>
    <AppendTargetFrameworkToOutputPath>false</AppendTargetFrameworkToOutputPath>
    <AppendRuntimeIdentifierToOutputPath>false</AppendRuntimeIdentifierToOutputPath>
    <DebugType>portable</DebugType>
    <DebugSymbols>true</DebugSymbols>
    <Deterministic>true</Deterministic>
    <ContinuousIntegrationBuild>true</ContinuousIntegrationBuild>
    <PathMap>__SOURCE__=/_/src</PathMap>
    <RestorePackagesPath>__NUGET_PACKAGES__</RestorePackagesPath>
    <RestoreConfigFile>__NUGET_CONFIG__</RestoreConfigFile>
    <RestoreNoCache>true</RestoreNoCache>
    <EnableNETAnalyzers>true</EnableNETAnalyzers>
    <EnforceCodeStyleInBuild>true</EnforceCodeStyleInBuild>
  </PropertyGroup>
  <ItemGroup Condition="'$(MSBuildProjectName)' == 'discord_game_sdk_dotnet'">
    <PackageReference Include="Microsoft.NETFramework.ReferenceAssemblies" Version="1.0.3" PrivateAssets="all" />
  </ItemGroup>
  <ItemGroup Condition="'$(MSBuildProjectName)' != 'websocket-sharp' And '$(MSBuildProjectName)' != 'discord_game_sdk_dotnet'">
    <PackageReference Include="Microsoft.Unity.Analyzers" Version="1.27.0" PrivateAssets="all" />
    <PackageReference Include="Nerdbank.GitVersioning" Version="3.10.94" PrivateAssets="all" />
    <PackageReference Include="BepInEx.Core" Version="5.4.17" PrivateAssets="all" />
    <PackageReference Include="UnityEngine.Modules" Version="2022.3.53" IncludeAssets="compile" PrivateAssets="all" />
    <PackageReference Include="DysonSphereProgram.GameLibs" Version="0.10.34.28529-r.0" IncludeAssets="compile" PrivateAssets="all" />
    <PackageReference Include="Microsoft.NETFramework.ReferenceAssemblies" Version="1.0.3" PrivateAssets="all" />
  </ItemGroup>
  <ItemGroup Condition="'$(MSBuildProjectName)' != 'websocket-sharp' And '$(MSBuildProjectName)' != 'discord_game_sdk_dotnet' And '$(MSBuildProjectName)' != 'NebulaAPI'">
    <PackageReference Include="K4os.Compression.LZ4.Streams" Version="1.3.8" />
    <Reference Include="Unity.TextMeshPro">
      <HintPath>$(NebulaPrivateReferenceRoot)\Unity.TextMeshPro.dll</HintPath>
      <Private>false</Private>
    </Reference>
  </ItemGroup>
</Project>
'@
    $propsTextA = $propsTemplate.Replace('__SOURCE__', [Security.SecurityElement]::Escape($paths.sourceA)).Replace(
        '__NUGET_PACKAGES__', [Security.SecurityElement]::Escape($paths.nugetPackagesA)).Replace(
        '__NUGET_CONFIG__', [Security.SecurityElement]::Escape($paths.nugetConfigA))
    $propsTextB = $propsTemplate.Replace('__SOURCE__', [Security.SecurityElement]::Escape($paths.sourceB)).Replace(
        '__NUGET_PACKAGES__', [Security.SecurityElement]::Escape($paths.nugetPackagesB)).Replace(
        '__NUGET_CONFIG__', [Security.SecurityElement]::Escape($paths.nugetConfigB))
    [void](Write-NebulaPrivateTextAtomic -Path $paths.propsA -Value $propsTextA -JobRoot $jobRoot)
    [void](Write-NebulaPrivateTextAtomic -Path $paths.propsB -Value $propsTextB -JobRoot $jobRoot)

    $targetsText = @'
<?xml version="1.0" encoding="utf-8"?>
<Project>
  <Target Name="NebulaPrivateRejectUnsafeOutputs" BeforeTargets="PrepareForBuild">
    <Error Condition="'$(NebulaPrivateGuard)' != 'DYSON_NEBULA_PRIVATE_BUILD_V1'" Text="NEBULA_PRIVATE_BUILD_GUARD_MISSING" />
    <Error Condition="'$(BuildProjectReferences)' != 'false'" Text="NEBULA_PRIVATE_PROJECT_REFERENCE_BUILD_REJECTED" />
    <Error Condition="'$(RestoreRecursive)' != 'false'" Text="NEBULA_PRIVATE_RECURSIVE_RESTORE_REJECTED" />
    <Error Condition="!$([System.String]::Copy('$(OutputPath)').StartsWith('$(NebulaPrivateJobRoot)', System.StringComparison.OrdinalIgnoreCase))" Text="NEBULA_PRIVATE_OUTPUT_OUTSIDE_JOB_ROOT" />
    <Error Condition="!$([System.String]::Copy('$(BaseIntermediateOutputPath)').StartsWith('$(NebulaPrivateJobRoot)', System.StringComparison.OrdinalIgnoreCase))" Text="NEBULA_PRIVATE_INTERMEDIATE_OUTSIDE_JOB_ROOT" />
    <Error Condition="!$([System.String]::Copy('$(RestorePackagesPath)').StartsWith('$(NebulaPrivateJobRoot)', System.StringComparison.OrdinalIgnoreCase))" Text="NEBULA_PRIVATE_NUGET_OUTSIDE_JOB_ROOT" />
    <Error Condition="!$([System.String]::Copy('$(TEMP)').StartsWith('$(NebulaPrivateJobRoot)', System.StringComparison.OrdinalIgnoreCase))" Text="NEBULA_PRIVATE_TEMP_OUTSIDE_JOB_ROOT" />
    <Error Condition="$([System.String]::Copy('$(OutputPath)').ToLowerInvariant().Contains('program files')) Or $([System.String]::Copy('$(OutputPath)').ToLowerInvariant().Contains('steamapps'))" Text="NEBULA_PRIVATE_PROTECTED_OUTPUT_REJECTED" />
  </Target>
</Project>
'@
    [void](Write-NebulaPrivateTextAtomic -Path $paths.targets -Value $targetsText -JobRoot $jobRoot)

    $nugetSourceLines = @($script:NebulaPrivateContract.restore.packageSources | ForEach-Object {
        '    <add key="' + [Security.SecurityElement]::Escape([string]$_.key) + '" value="' +
            [Security.SecurityElement]::Escape([string]$_.url) + '" protocolVersion="3" />'
    }) -join "`n"
    $nugetMappingLines = @($script:NebulaPrivateContract.restore.packageSources | ForEach-Object {
        $source = $_
        $packageLines = @($source.packageIds | ForEach-Object {
            '      <package pattern="' + [Security.SecurityElement]::Escape([string]$_) + '" />'
        }) -join "`n"
        '    <packageSource key="' + [Security.SecurityElement]::Escape([string]$source.key) + '">' + "`n" +
            $packageLines + "`n" + '    </packageSource>'
    }) -join "`n"
    $nugetText = @"
<?xml version="1.0" encoding="utf-8"?>
<configuration>
  <config>
    <add key="globalPackagesFolder" value="__NUGET_PACKAGES__" />
    <add key="repositoryPath" value="__NUGET_PACKAGES__" />
  </config>
  <packageSources>
    <clear />
$nugetSourceLines
  </packageSources>
  <packageSourceMapping>
$nugetMappingLines
  </packageSourceMapping>
</configuration>
"@
    $nugetTextA = $nugetText.Replace('__NUGET_PACKAGES__', [Security.SecurityElement]::Escape($paths.nugetPackagesA))
    $nugetTextB = $nugetText.Replace('__NUGET_PACKAGES__', [Security.SecurityElement]::Escape($paths.nugetPackagesB))
    [void](Write-NebulaPrivateTextAtomic -Path $paths.nugetConfigA -Value $nugetTextA -JobRoot $jobRoot)
    [void](Write-NebulaPrivateTextAtomic -Path $paths.nugetConfigB -Value $nugetTextB -JobRoot $jobRoot)

    $sourceContract = Get-Content -LiteralPath $SourceContractPath -Raw -Encoding UTF8 | ConvertFrom-Json
    $patchedSources = @($sourceContract.candidate.patchedSources | Sort-Object -Property path | ForEach-Object {
        [ordered]@{ path = [string]$_.path; sha256 = [string]$_.sha256; size = [int64]$_.sizeBytes }
    })
    $commonProperties = [ordered]@{
        Configuration = 'Release'
        BuildProjectReferences = 'false'
        RestoreRecursive = 'false'
        DirectoryBuildTargetsPath = $paths.targets
        NebulaPrivateGuard = $script:NebulaPrivateBuildProtocol
        NebulaPrivateJobRoot = $jobRoot + '\'
        Deterministic = 'true'
        ContinuousIntegrationBuild = 'true'
        PathMap = '<build-source>=/_/src'
    }
    $projectDefinitions = @($script:NebulaPrivateContract.build.projects | ForEach-Object {
        [ordered]@{ name = [string]$_.name; path = [string]$_.path; mode = [string]$_.mode }
    })
    $buildInputs = Get-NebulaPrivateExpectedBuildInputs
    $inputFingerprint = Get-NebulaPrivateExpectedBuildInputFingerprint
    $builds = @()
    foreach ($slot in @('a','b')) {
        $source = if ($slot -ceq 'a') { $paths.sourceA } else { $paths.sourceB }
        $out = if ($slot -ceq 'a') { $paths.outputA } else { $paths.outputB }
        $obj = if ($slot -ceq 'a') { $paths.objA } else { $paths.objB }
        $harvest = if ($slot -ceq 'a') { $paths.harvestA } else { $paths.harvestB }
        $nugetPackages = if ($slot -ceq 'a') { $paths.nugetPackagesA } else { $paths.nugetPackagesB }
        $nugetHttpCache = if ($slot -ceq 'a') { $paths.nugetHttpCacheA } else { $paths.nugetHttpCacheB }
        $nugetConfig = if ($slot -ceq 'a') { $paths.nugetConfigA } else { $paths.nugetConfigB }
        $dotnetHome = if ($slot -ceq 'a') { $paths.dotnetHomeA } else { $paths.dotnetHomeB }
        $temp = if ($slot -ceq 'a') { $paths.tempA } else { $paths.tempB }
        $props = if ($slot -ceq 'a') { $paths.propsA } else { $paths.propsB }
        $properties = [ordered]@{}
        foreach ($key in $commonProperties.Keys) { $properties[$key] = $commonProperties[$key] }
        $properties.DirectoryBuildPropsPath = $props
        $properties.RestorePackagesPath = $nugetPackages
        $properties.RestoreConfigFile = $nugetConfig
        $properties.OutputPath = $out + '\'
        $properties.BaseOutputPath = $out + '\'
        $properties.NebulaPrivateReferenceRoot = Join-Path $source 'Libs'
        $properties.PathMap = $source + '=' + [string]$script:NebulaPrivateContract.pathMapTarget + '%2C' +
            $obj + '=' + [string]$script:NebulaPrivateContract.pathMapIntermediateTarget + '%2C' +
            $out + '=' + [string]$script:NebulaPrivateContract.pathMapOutputTarget
        $projects = @()
        $projectIndex = 0
        foreach ($definition in $projectDefinitions) {
            $projectIndex++
            $projectIntermediate = Join-Path $obj (('{0:d2}-' -f $projectIndex) + [string]$definition.name)
            $projectPlan = [ordered]@{
                name = [string]$definition.name
                path = [string]$definition.path
                mode = [string]$definition.mode
                intermediateRoot = $projectIntermediate
                properties = [ordered]@{
                    BaseIntermediateOutputPath = $projectIntermediate + '\'
                    IntermediateOutputPath = (Join-Path $projectIntermediate 'project') + '\'
                }
                harvestEligible = [string]$definition.name -cin @('NebulaNetwork','NebulaPatcher')
            }
            if ([string]$definition.mode -ceq 'verified-stock-reference') {
                $stock = @($script:NebulaPrivateContract.candidate.buildStockReferences | Where-Object {
                    [string]$_.project -ceq [string]$definition.name
                })
                if ($stock.Count -ne 1) { Throw-NebulaPrivateError -Code 'NEBULA_PRIVATE_BUILD_STOCK_REFERENCE_INVALID' }
                $projectPlan.stockReference = [ordered]@{
                    archivePath = [string]$stock[0].archivePath
                    outputPath = Join-Path $out ([string]$stock[0].outputFileName)
                    size = [int64]$stock[0].size
                    sha256 = [string]$stock[0].sha256
                    sourceArchiveSha256 = [string]$stock[0].sourceArchiveSha256
                    assemblyIdentity = $stock[0].assemblyIdentity
                }
            }
            $projects += $projectPlan
        }
        $builds += [ordered]@{
            slot = $slot
            inputFingerprintSha256 = $inputFingerprint
            sourceRoot = $source
            outputRoot = $out
            intermediateRoot = $obj
            harvestRoot = $harvest
            environment = [ordered]@{
                DOTNET_CLI_HOME = $dotnetHome
                DOTNET_CLI_TELEMETRY_OPTOUT = '1'
                DOTNET_SKIP_FIRST_TIME_EXPERIENCE = '1'
                DOTNET_NOLOGO = '1'
                DOTNET_MULTILEVEL_LOOKUP = '0'
                NUGET_PACKAGES = $nugetPackages
                NUGET_HTTP_CACHE_PATH = $nugetHttpCache
                NUGET_XMLDOC_MODE = 'skip'
                TEMP = $temp
                TMP = $temp
            }
            invocation = [ordered]@{
                executable = 'dotnet'
                verb = 'msbuild'
                mandatoryArguments = @('-noAutoResponse','-nologo','-verbosity:minimal','-nodeReuse:false','-maxCpuCount')
                projectsInOrder = $projects
                dependencyClosureOutputsAreBuildOnly = $true
                harvestProjects = @('NebulaNetwork','NebulaPatcher')
                properties = $properties
                allowedHarvest = @($script:NebulaPrivateCustomFiles)
            }
        }
    }

    $planCore = [ordered]@{
        protocol = $script:NebulaPrivateBuildProtocol
        schemaVersion = 1
        requestId = $RequestId
        executionEnabled = $false
        executorIncluded = $false
        generatedArtifactsOnly = $true
        inputs = $buildInputs
        inputFingerprintSha256 = $inputFingerprint
        anchors = [ordered]@{
            repository = [string]$script:NebulaPrivateContract.upstream.repository
            tag = [string]$script:NebulaPrivateContract.upstream.tag
            commit = [string]$script:NebulaPrivateContract.upstream.commit
            websocketSubmoduleCommit = [string]$script:NebulaPrivateContract.upstream.websocketSubmoduleCommit
            sourceContractSha256 = [string]$script:NebulaPrivateContract.sourcePatch.contractSha256
            patchSha256 = [string]$script:NebulaPrivateContract.sourcePatch.patchSha256
            patchedSources = $patchedSources
        }
        preparation = [ordered]@{
            exactHeadRequired = $true
            recursiveSubmodulesRequired = $true
            cleanTreeBeforePatchRequired = $true
            patchCheckBeforeApplyRequired = $true
            exactlyTwoPatchedFilesRequired = $true
            cloneDestination = $paths.sourceTemplate
            buildCopies = @($paths.sourceA,$paths.sourceB)
            forbiddenSourceArtifacts = @('DevEnv.targets','.remoteBuild','bin','obj')
        }
        gameGate = [ordered]@{
            package = [string]$script:NebulaPrivateContract.game.gameLibPackage
            packageVersion = [string]$script:NebulaPrivateContract.game.gameLibVersion
            gameVersion = [string]$script:NebulaPrivateContract.game.gameVersion
            assemblyCSharpMvid = [string]$script:NebulaPrivateContract.game.assemblyCSharpMvid
        }
        isolation = [ordered]@{
            requestScopedFixedNtfsJobRoot = $true
            noAutoResponse = $true
            directoryBuildPropsIsolated = $true
            directoryBuildTargetsIsolated = $true
            outputsIsolated = $true
            nugetIsolated = $true
            tempIsolated = $true
            pathMapTarget = [string]$script:NebulaPrivateContract.pathMapTarget
            pathMapIntermediateTarget = [string]$script:NebulaPrivateContract.pathMapIntermediateTarget
            pathMapOutputTarget = [string]$script:NebulaPrivateContract.pathMapOutputTarget
            paths = $paths
        }
        builds = $builds
        deterministicComparison = [ordered]@{
            required = $true
            compare = @('artifact-sha256','assembly-version','file-version','product-version','public-key-token',
                'mvid','assembly-references','codeview-id','portable-pdb-id','public-hygiene')
        }
        candidate = [ordered]@{
            officialMainArchivePath = Join-Path $paths.archives 'official-nebula-v0.9.22.zip'
            officialApiArchivePath = Join-Path $paths.archives 'official-nebula-api-v2.1.0.zip'
            officialMainArchiveSha256 = [string]$script:NebulaPrivateContract.candidate.officialMainArchiveSha256
            officialApiArchiveSha256 = [string]$script:NebulaPrivateContract.candidate.officialApiArchiveSha256
            officialTreeManifestSha256 = [string]$script:NebulaPrivateContract.candidate.officialTreeManifestSha256
            officialTreeDigestSha256 = [string]$script:NebulaPrivateContract.candidate.officialTreeDigestSha256
            treeDigestAlgorithm = [string]$script:NebulaPrivateContract.candidate.treeDigestAlgorithm
            totalFiles = 44
            stockFilesExact = 40
            customFiles = @($script:NebulaPrivateCustomFiles)
        }
    }
    $plan = [ordered]@{}
    foreach ($key in $planCore.Keys) { $plan[$key] = $planCore[$key] }
    $plan.previewDigest = Get-NebulaPrivateObjectSha256 -Value $planCore

    if ([string]::IsNullOrWhiteSpace($OutputPath)) { $OutputPath = Join-Path $paths.evidence 'build-plan.json' }
    [void](Write-NebulaPrivateJsonAtomic -Path $OutputPath -Value $plan -JobRoot $jobRoot)
    [pscustomobject][ordered]@{
        protocol = $script:NebulaPrivateBuildProtocol
        requestId = $RequestId
        executionEnabled = $false
        executorIncluded = $false
        previewDigest = $plan.previewDigest
        planPath = $OutputPath
    } | ConvertTo-Json -Compress
}
catch {
    $code = Get-NebulaPrivateErrorCode -Exception $_.Exception
    [Console]::Error.WriteLine($code)
    exit 1
}
