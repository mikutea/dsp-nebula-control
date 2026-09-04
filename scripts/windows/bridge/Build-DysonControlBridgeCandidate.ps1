[CmdletBinding(SupportsShouldProcess, ConfirmImpact = 'Medium')]
param(
    [Parameter(Mandatory)][string]$SourcePath,
    [Parameter(Mandatory)][string]$DysonServerRoot,
    [Parameter(Mandatory)][string]$OutputPath,
    [string]$DotnetExecutable = 'dotnet.exe',
    [string]$ExpectedVersion,
    [ValidateRange(10, 600)][int]$BuildTimeoutSeconds = 180
)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
. (Join-Path $PSScriptRoot 'DysonBridge.Common.ps1')

function ConvertTo-DysonBridgeBuildDirectoryArgument {
    param([Parameter(Mandatory)][string]$Path)
    return [System.IO.Path]::GetFullPath($Path).TrimEnd(
        [System.IO.Path]::DirectorySeparatorChar,
        [System.IO.Path]::AltDirectorySeparatorChar
    ) + [System.IO.Path]::AltDirectorySeparatorChar
}

$source = Get-DysonBridgeSourceContract -SourceRoot $SourcePath
$serverRoot = Assert-DysonBridgePlainDirectory -Path $DysonServerRoot
$references = @(Get-DysonBridgeReferenceReceipts -DysonServerRoot $serverRoot)
$outputFull = Assert-DysonBridgeSafeRoot -Path $OutputPath -Name 'OutputPath'
if (Test-Path -LiteralPath $outputFull) { throw 'OutputPath already exists; Bridge candidates are never overwritten.' }
if ($ExpectedVersion -and $ExpectedVersion -cne $source.version) { throw 'The public Bridge source version does not match ExpectedVersion.' }
if ((Test-DysonBridgePathWithin -Candidate $outputFull -Parent $source.root -AllowEqual) -or
    (Test-DysonBridgePathWithin -Candidate $source.root -Parent $outputFull -AllowEqual) -or
    (Test-DysonBridgePathWithin -Candidate $outputFull -Parent $serverRoot -AllowEqual)) {
    throw 'OutputPath cannot overlap the public source package or DSP server root.'
}

if ([System.IO.Path]::IsPathRooted($DotnetExecutable)) {
    $dotnetPath = (Assert-DysonBridgePlainFile -Path $DotnetExecutable -MaximumBytes 512MB).FullName
}
else {
    $command = Get-Command $DotnetExecutable -CommandType Application -ErrorAction Stop | Select-Object -First 1
    $dotnetPath = (Assert-DysonBridgePlainFile -Path $command.Source -MaximumBytes 512MB).FullName
}
if ([System.IO.Path]::GetFileName($dotnetPath).ToLowerInvariant() -notin @('dotnet.exe', 'dotnet')) {
    throw 'DotnetExecutable must resolve to the dotnet host.'
}
foreach ($value in @($source.projectPath, $serverRoot, $outputFull)) {
    if ($value -match '["\r\n]') { throw 'Bridge build paths cannot contain quotes or line breaks.' }
}

$preview = [ordered]@{
    protocol = $script:DysonBridgeCandidateProtocol
    state = 'preview'
    dryRun = $true
    version = $source.version
    sourceFileCount = @($source.files).Count
    referenceCount = $references.Count
    outputPath = $outputFull
    proprietaryAssembliesWillBePackaged = $false
    productionChanged = $false
}
if (-not $PSCmdlet.ShouldProcess($outputFull, "build private Bridge candidate $($source.version)")) {
    $preview | ConvertTo-DysonBridgeJsonLine
    exit 0
}

$outputParent = [System.IO.Path]::GetDirectoryName($outputFull)
[System.IO.Directory]::CreateDirectory($outputParent) | Out-Null
[void](Assert-DysonBridgePlainDirectory -Path $outputParent)
$temporary = Join-Path $outputParent ('.partial-dyson-bridge-' + [guid]::NewGuid().ToString('N'))
$published = $false
try {
    [System.IO.Directory]::CreateDirectory($temporary) | Out-Null
    $buildRoot = Join-Path $temporary 'private-build'
    $objRoot = ConvertTo-DysonBridgeBuildDirectoryArgument -Path (Join-Path $buildRoot 'obj')
    $binRoot = ConvertTo-DysonBridgeBuildDirectoryArgument -Path (Join-Path $buildRoot 'bin')
    $cliHome = Join-Path $buildRoot 'dotnet-home'
    $packagesRoot = ConvertTo-DysonBridgeBuildDirectoryArgument -Path (Join-Path $buildRoot 'packages')
    foreach ($directory in @($buildRoot, $objRoot, $binRoot, $cliHome, $packagesRoot)) { [System.IO.Directory]::CreateDirectory($directory) | Out-Null }
    $arguments = @(
        'build', ('"{0}"' -f $source.projectPath), '--configuration', 'Release', '--nologo', '--verbosity', 'quiet', '--disable-build-servers',
        ('--property:DysonServerRoot="{0}"' -f $serverRoot),
        ('--property:BaseIntermediateOutputPath="{0}"' -f $objRoot),
        ('--property:MSBuildProjectExtensionsPath="{0}"' -f $objRoot),
        ('--property:OutputPath="{0}"' -f $binRoot),
        ('--property:RestorePackagesPath="{0}"' -f $packagesRoot),
        '--property:ImportDirectoryBuildProps=false', '--property:ImportDirectoryBuildTargets=false',
        '--property:UseSharedCompilation=false', '--property:ContinuousIntegrationBuild=true', '--property:Deterministic=true',
        '--property:IncludeSourceRevisionInInformationalVersion=false'
    ) -join ' '
    $environment = @{
        DOTNET_CLI_HOME = $cliHome
        DOTNET_NOLOGO = '1'
        DOTNET_SKIP_FIRST_TIME_EXPERIENCE = '1'
        DOTNET_CLI_TELEMETRY_OPTOUT = '1'
    }
    [void](Invoke-DysonBridgeProcess -Executable $dotnetPath -Arguments $arguments -WorkingDirectory $source.root `
        -TimeoutMilliseconds ($BuildTimeoutSeconds * 1000) -MaximumOutputCharacters 262144 -Environment $environment)

    $builtDlls = @(Assert-DysonBridgeTreePlain -Root $binRoot | Where-Object { $_.Name -ceq $script:DysonBridgeDllName })
    if ($builtDlls.Count -ne 1) { throw 'The controlled Bridge build did not produce exactly one plugin DLL.' }
    $candidateRoot = Join-Path $temporary 'candidate'
    [System.IO.Directory]::CreateDirectory($candidateRoot) | Out-Null
    [System.IO.File]::Copy($builtDlls[0].FullName, (Join-Path $candidateRoot $script:DysonBridgeDllName), $false)
    $plugin = Get-DysonBridgeAssemblyMetadata -AssemblyPath (Join-Path $candidateRoot $script:DysonBridgeDllName) -DysonServerRoot $serverRoot
    $expectedAssemblyVersion = Get-DysonBridgeAssemblyVersion -Version $source.version
    if ($plugin.guid -ne $script:DysonBridgeGuid -or $plugin.name -ne $script:DysonBridgeName -or
        $plugin.version -ne $source.version -or $plugin.assemblyName -ne $script:DysonBridgeAssemblyName -or
        $plugin.informationalVersion -ne $source.version -or
        $plugin.assemblyVersion -ne $expectedAssemblyVersion -or $plugin.fileVersion -ne $expectedAssemblyVersion) {
        throw 'The compiled Bridge identity does not match its public source contract.'
    }
    [void](Write-DysonBridgeCandidateManifest -CandidateRoot $candidateRoot -Plugin $plugin -References $references -Sources $source.files)
    [void](Test-DysonBridgeCandidateCore -CandidateRoot $candidateRoot -DysonServerRoot $serverRoot -ExpectedVersion $source.version)
    [System.IO.Directory]::Move($candidateRoot, $outputFull)
    $published = $true
    [ordered]@{
        protocol = $script:DysonBridgeCandidateProtocol
        state = 'created'
        version = $source.version
        guid = $script:DysonBridgeGuid
        dllSha256 = $plugin.sha256
        referenceCount = $references.Count
        sourceFileCount = @($source.files).Count
        proprietaryAssembliesPackaged = $false
        productionChanged = $false
    } | ConvertTo-DysonBridgeJsonLine
}
finally {
    if (Test-Path -LiteralPath $temporary) {
        if (-not (Test-DysonBridgePathWithin -Candidate $temporary -Parent $outputParent) -or
            -not ([System.IO.Path]::GetFileName($temporary).StartsWith('.partial-dyson-bridge-', [System.StringComparison]::Ordinal))) {
            throw 'Refusing to clean an unexpected Bridge build path.'
        }
        Remove-Item -LiteralPath $temporary -Recurse -Force
    }
    if (-not $published -and (Test-Path -LiteralPath $outputFull)) {
        throw 'A failed Bridge build unexpectedly published OutputPath.'
    }
}
