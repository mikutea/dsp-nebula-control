[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$RequestId,
    [Parameter(Mandatory)][string]$JobBase,
    [Parameter(Mandatory)][ValidateSet('a','b')][string]$BuildSlot,
    [Parameter(Mandatory)][string]$BuildPlanPath,
    [Parameter(Mandatory)][string]$GameAssemblyPath,
    [string]$SourceContractPath,
    [string]$PatchPath,
    [string]$OutputPath
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2.0
. (Join-Path $PSScriptRoot 'NebulaPrivateBuild.Common.ps1')

function Get-UInt16LE {
    param([byte[]]$Bytes, [int]$Offset)
    if ($Offset -lt 0 -or $Offset + 2 -gt $Bytes.Length) { Throw-NebulaPrivateError -Code 'NEBULA_PRIVATE_BINARY_FORMAT_INVALID' }
    return [BitConverter]::ToUInt16($Bytes, $Offset)
}

function Get-UInt32LE {
    param([byte[]]$Bytes, [int]$Offset)
    if ($Offset -lt 0 -or $Offset + 4 -gt $Bytes.Length) { Throw-NebulaPrivateError -Code 'NEBULA_PRIVATE_BINARY_FORMAT_INVALID' }
    return [BitConverter]::ToUInt32($Bytes, $Offset)
}

function Get-NebulaPrivateCodeViewRecord {
    param([Parameter(Mandatory)][string]$Path)
    $bytes = [IO.File]::ReadAllBytes($Path)
    if ($bytes.Length -lt 256 -or $bytes.Length -gt 134217728 -or $bytes[0] -ne 0x4d -or $bytes[1] -ne 0x5a) {
        Throw-NebulaPrivateError -Code 'NEBULA_PRIVATE_PE_FORMAT_INVALID'
    }
    $pe = [int](Get-UInt32LE -Bytes $bytes -Offset 0x3c)
    if ($pe -lt 0 -or $pe + 24 -gt $bytes.Length -or
        $bytes[$pe] -ne 0x50 -or $bytes[$pe + 1] -ne 0x45 -or $bytes[$pe + 2] -ne 0 -or $bytes[$pe + 3] -ne 0) {
        Throw-NebulaPrivateError -Code 'NEBULA_PRIVATE_PE_FORMAT_INVALID'
    }
    $sectionCount = [int](Get-UInt16LE -Bytes $bytes -Offset ($pe + 6))
    if ($sectionCount -lt 1 -or $sectionCount -gt 96) { Throw-NebulaPrivateError -Code 'NEBULA_PRIVATE_PE_FORMAT_INVALID' }
    $optionalSize = [int](Get-UInt16LE -Bytes $bytes -Offset ($pe + 20))
    $optional = $pe + 24
    $magic = Get-UInt16LE -Bytes $bytes -Offset $optional
    $directoryStart = if ($magic -eq 0x10b) { $optional + 96 } elseif ($magic -eq 0x20b) { $optional + 112 } else {
        Throw-NebulaPrivateError -Code 'NEBULA_PRIVATE_PE_FORMAT_INVALID'
    }
    $debugRva = [uint32](Get-UInt32LE -Bytes $bytes -Offset ($directoryStart + (6 * 8)))
    $debugSize = [uint32](Get-UInt32LE -Bytes $bytes -Offset ($directoryStart + (6 * 8) + 4))
    if ($debugRva -eq 0 -or $debugSize -lt 28 -or ($debugSize % 28) -ne 0) {
        Throw-NebulaPrivateError -Code 'NEBULA_PRIVATE_CODEVIEW_MISSING'
    }
    $sectionStart = $optional + $optionalSize
    $debugOffset = -1
    for ($i = 0; $i -lt $sectionCount; $i++) {
        $section = $sectionStart + ($i * 40)
        if ($section + 40 -gt $bytes.Length) { Throw-NebulaPrivateError -Code 'NEBULA_PRIVATE_PE_FORMAT_INVALID' }
        $virtualSize = [uint32](Get-UInt32LE -Bytes $bytes -Offset ($section + 8))
        $virtualAddress = [uint32](Get-UInt32LE -Bytes $bytes -Offset ($section + 12))
        $rawSize = [uint32](Get-UInt32LE -Bytes $bytes -Offset ($section + 16))
        $rawPointer = [uint32](Get-UInt32LE -Bytes $bytes -Offset ($section + 20))
        $span = [Math]::Max([double]$virtualSize, [double]$rawSize)
        if ([double]$debugRva -ge [double]$virtualAddress -and [double]$debugRva -lt ([double]$virtualAddress + $span)) {
            $debugOffset = [int]($rawPointer + ($debugRva - $virtualAddress))
            break
        }
    }
    if ($debugOffset -lt 0 -or $debugOffset + $debugSize -gt $bytes.Length) {
        Throw-NebulaPrivateError -Code 'NEBULA_PRIVATE_CODEVIEW_MISSING'
    }
    $matches = @()
    for ($entry = $debugOffset; $entry -lt $debugOffset + $debugSize; $entry += 28) {
        if ((Get-UInt32LE -Bytes $bytes -Offset ($entry + 12)) -ne 2) { continue }
        $dataSize = [int](Get-UInt32LE -Bytes $bytes -Offset ($entry + 16))
        $dataOffset = [int](Get-UInt32LE -Bytes $bytes -Offset ($entry + 24))
        if ($dataSize -lt 25 -or $dataOffset -lt 0 -or $dataOffset + $dataSize -gt $bytes.Length -or
            [Text.Encoding]::ASCII.GetString($bytes, $dataOffset, 4) -cne 'RSDS') { continue }
        $guidBytes = New-Object byte[] 16
        [Array]::Copy($bytes, $dataOffset + 4, $guidBytes, 0, 16)
        $pathStart = $dataOffset + 24
        $pathEnd = $pathStart
        while ($pathEnd -lt $dataOffset + $dataSize -and $bytes[$pathEnd] -ne 0) { $pathEnd++ }
        $matches += [pscustomobject][ordered]@{
            guid = ([guid]::new($guidBytes)).ToString('D').ToLowerInvariant()
            age = [int](Get-UInt32LE -Bytes $bytes -Offset ($dataOffset + 20))
            timestamp = ([uint32](Get-UInt32LE -Bytes $bytes -Offset ($entry + 4))).ToString('x8')
            path = [Text.Encoding]::UTF8.GetString($bytes, $pathStart, $pathEnd - $pathStart)
        }
    }
    if ($matches.Count -ne 1) { Throw-NebulaPrivateError -Code 'NEBULA_PRIVATE_CODEVIEW_INVALID' }
    return $matches[0]
}

function Get-NebulaPrivatePortablePdbId {
    param([Parameter(Mandatory)][string]$Path)
    $bytes = [IO.File]::ReadAllBytes($Path)
    if ($bytes.Length -lt 64 -or $bytes.Length -gt 134217728 -or
        [Text.Encoding]::ASCII.GetString($bytes, 0, 4) -cne 'BSJB') {
        Throw-NebulaPrivateError -Code 'NEBULA_PRIVATE_PORTABLE_PDB_INVALID'
    }
    $versionLength = [int](Get-UInt32LE -Bytes $bytes -Offset 12)
    $cursor = 16 + $versionLength
    $cursor = ($cursor + 3) -band (-bnot 3)
    if ($cursor + 4 -gt $bytes.Length) { Throw-NebulaPrivateError -Code 'NEBULA_PRIVATE_PORTABLE_PDB_INVALID' }
    $streamCount = [int](Get-UInt16LE -Bytes $bytes -Offset ($cursor + 2))
    if ($streamCount -lt 1 -or $streamCount -gt 64) {
        Throw-NebulaPrivateError -Code 'NEBULA_PRIVATE_PORTABLE_PDB_INVALID'
    }
    $cursor += 4
    $pdbOffset = -1
    $pdbSize = 0
    for ($i = 0; $i -lt $streamCount; $i++) {
        if ($cursor + 8 -gt $bytes.Length) { Throw-NebulaPrivateError -Code 'NEBULA_PRIVATE_PORTABLE_PDB_INVALID' }
        $offset = [int](Get-UInt32LE -Bytes $bytes -Offset $cursor)
        $size = [int](Get-UInt32LE -Bytes $bytes -Offset ($cursor + 4))
        $cursor += 8
        $nameStart = $cursor
        while ($cursor -lt $bytes.Length -and $bytes[$cursor] -ne 0) { $cursor++ }
        if ($cursor -ge $bytes.Length) { Throw-NebulaPrivateError -Code 'NEBULA_PRIVATE_PORTABLE_PDB_INVALID' }
        $name = [Text.Encoding]::ASCII.GetString($bytes, $nameStart, $cursor - $nameStart)
        $cursor++
        $cursor = ($cursor + 3) -band (-bnot 3)
        if ($name -ceq '#Pdb') { $pdbOffset = $offset; $pdbSize = $size }
    }
    if ($pdbOffset -lt 0 -or $pdbSize -lt 20 -or $pdbOffset + 20 -gt $bytes.Length) {
        Throw-NebulaPrivateError -Code 'NEBULA_PRIVATE_PORTABLE_PDB_ID_MISSING'
    }
    $guidBytes = New-Object byte[] 16
    [Array]::Copy($bytes, $pdbOffset, $guidBytes, 0, 16)
    return [pscustomobject][ordered]@{
        guid = ([guid]::new($guidBytes)).ToString('D').ToLowerInvariant()
        stamp = ([uint32](Get-UInt32LE -Bytes $bytes -Offset ($pdbOffset + 16))).ToString('x8')
    }
}

function Get-NebulaPrivateAssemblyInfo {
    param([Parameter(Mandatory)][string]$DllPath, [Parameter(Mandatory)][string]$RelativePath)
    $assembly = [Reflection.Assembly]::ReflectionOnlyLoadFrom($DllPath)
    $name = $assembly.GetName()
    $tokenBytes = $name.GetPublicKeyToken()
    $token = if ($null -eq $tokenBytes -or $tokenBytes.Length -eq 0) { 'none' } else {
        ([BitConverter]::ToString($tokenBytes)).Replace('-', '').ToLowerInvariant()
    }
    $references = @($assembly.GetReferencedAssemblies() | ForEach-Object {
        $referenceToken = $_.GetPublicKeyToken()
        [pscustomobject][ordered]@{
            name = [string]$_.Name
            version = $_.Version.ToString()
            publicKeyToken = if ($null -eq $referenceToken -or $referenceToken.Length -eq 0) { 'none' } else {
                ([BitConverter]::ToString($referenceToken)).Replace('-', '').ToLowerInvariant()
            }
        }
    } | Sort-Object -Property name -CaseSensitive)
    $versionInfo = [Diagnostics.FileVersionInfo]::GetVersionInfo($DllPath)
    return [pscustomobject][ordered]@{
        path = $RelativePath
        name = [string]$name.Name
        assemblyVersion = $name.Version.ToString()
        fileVersion = [string]$versionInfo.FileVersion
        productVersion = [string]$versionInfo.ProductVersion
        publicKeyToken = $token
        mvid = $assembly.ManifestModule.ModuleVersionId.ToString('D').ToLowerInvariant()
        references = $references
    }
}

function Get-NebulaPrivateStockReferenceInfo {
    param(
        [Parameter(Mandatory)][string]$DllPath,
        [Parameter(Mandatory)]$StockProject
    )
    $stock = $StockProject.stockReference
    if (-not (Test-Path -LiteralPath $DllPath -PathType Leaf) -or
        [int64](Get-Item -LiteralPath $DllPath).Length -ne [int64]$stock.size -or
        (Get-NebulaPrivateFileSha256 -Path $DllPath) -cne [string]$stock.sha256) {
        Throw-NebulaPrivateError -Code 'NEBULA_PRIVATE_BUILD_STOCK_REFERENCE_INVALID'
    }
    $assembly = [Reflection.Assembly]::ReflectionOnlyLoadFrom($DllPath)
    $name = $assembly.GetName()
    $tokenBytes = $name.GetPublicKeyToken()
    $token = if ($null -eq $tokenBytes -or $tokenBytes.Length -eq 0) { 'none' } else {
        ([BitConverter]::ToString($tokenBytes)).Replace('-', '').ToLowerInvariant()
    }
    return [pscustomobject][ordered]@{
        project = [string]$StockProject.name
        archivePath = [string]$stock.archivePath
        sourceArchiveSha256 = [string]$stock.sourceArchiveSha256
        outputFileName = [IO.Path]::GetFileName($DllPath)
        size = [int64](Get-Item -LiteralPath $DllPath).Length
        sha256 = Get-NebulaPrivateFileSha256 -Path $DllPath
        assemblyIdentity = [pscustomobject][ordered]@{
            name = [string]$name.Name
            version = $name.Version.ToString()
            culture = if ([string]::IsNullOrWhiteSpace([string]$name.CultureName)) { 'neutral' } else { [string]$name.CultureName }
            publicKeyToken = $token
            mvid = $assembly.ManifestModule.ModuleVersionId.ToString('D').ToLowerInvariant()
        }
    }
}

function Get-NebulaPrivateHygieneFindings {
    param([Parameter(Mandatory)][string[]]$Paths)
    $findings = New-Object Collections.Generic.List[string]
    $patterns = [ordered]@{
        ABSOLUTE_WINDOWS_PATH = '(?i)[A-Z]:\\(?:Users|Program Files|Program Files \(x86\)|Windows|Steam|[^\x00\r\n]{1,80}steamapps)\\'
        UNC_PATH = '\\\\[A-Za-z0-9][A-Za-z0-9._-]*\\'
        CREDENTIAL_LABEL = '(?i)(?<![A-Za-z0-9_])(?:password|api[_-]?key|bearer|secret|access[_-]?token)["'']?\s*[:=]'
    }
    foreach ($path in $Paths) {
        $bytes = [IO.File]::ReadAllBytes($path)
        $texts = @([Text.Encoding]::UTF8.GetString($bytes), [Text.Encoding]::Unicode.GetString($bytes))
        foreach ($entry in $patterns.GetEnumerator()) {
            if (@($texts | Where-Object { $_ -match $entry.Value }).Count -gt 0 -and -not $findings.Contains($entry.Key)) {
                $findings.Add($entry.Key)
            }
        }
    }
    return @($findings | Sort-Object -CaseSensitive)
}

try {
    if ([string]$PSVersionTable.PSEdition -cne 'Desktop') {
        Throw-NebulaPrivateError -Code 'NEBULA_PRIVATE_METADATA_REQUIRES_WINDOWS_POWERSHELL'
    }
    $repositoryRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..\..'))
    if ([string]::IsNullOrWhiteSpace($SourceContractPath)) {
        $SourceContractPath = Join-Path $repositoryRoot 'integrations\nebula-hostname-wss\contract.json'
    }
    if ([string]::IsNullOrWhiteSpace($PatchPath)) {
        $PatchPath = Join-Path $repositoryRoot 'integrations\nebula-hostname-wss\patches\nebula-v0.9.22-hostname-wss.patch'
    }
    Assert-NebulaPrivateContractAnchors -SourceContractPath $SourceContractPath -PatchPath $PatchPath

    $jobRoot = Assert-NebulaPrivateJobRoot -JobRoot (Join-Path $JobBase $RequestId) -JobBase $JobBase `
        -RequestId $RequestId
    $planFile = Assert-NebulaPrivateJobPath -Path $BuildPlanPath -JobRoot $jobRoot
    $plan = Get-Content -LiteralPath $planFile -Raw -Encoding UTF8 | ConvertFrom-Json
    [void](Assert-NebulaPrivateBuildPlan -Plan $plan -RequestId $RequestId -JobRoot $jobRoot)
    $build = @($plan.builds | Where-Object { [string]$_.slot -ceq $BuildSlot })
    if ($build.Count -ne 1) { Throw-NebulaPrivateError -Code 'NEBULA_PRIVATE_BUILD_PLAN_INVALID' }
    $stockProject = @($build[0].invocation.projectsInOrder | Where-Object {
        [string]$_.mode -ceq 'verified-stock-reference'
    })
    if ($stockProject.Count -ne 1) { Throw-NebulaPrivateError -Code 'NEBULA_PRIVATE_BUILD_STOCK_REFERENCE_INVALID' }
    $stockOutput = Assert-NebulaPrivateJobPath -Path ([string]$stockProject[0].stockReference.outputPath) -JobRoot $jobRoot
    $stockReferenceInfo = Get-NebulaPrivateStockReferenceInfo -DllPath $stockOutput -StockProject $stockProject[0]
    $harvestRoot = Assert-NebulaPrivateJobPath -Path ([string]$build[0].harvestRoot) -JobRoot $jobRoot
    $expectedHarvest = if ($BuildSlot -ceq 'a') { Join-Path $jobRoot 'harvest-a' } else { Join-Path $jobRoot 'harvest-b' }
    if (-not $harvestRoot.Equals([IO.Path]::GetFullPath($expectedHarvest), [StringComparison]::OrdinalIgnoreCase)) {
        Throw-NebulaPrivateError -Code 'NEBULA_PRIVATE_HARVEST_SCOPE_INVALID'
    }
    $records = Get-NebulaPrivatePlainFiles -Root $harvestRoot
    Assert-NebulaPrivateExactFileSet -Records $records -Expected $script:NebulaPrivateCustomFiles `
        -Code 'NEBULA_PRIVATE_HARVEST_SCOPE_INVALID'

    $gameAssembly = Assert-NebulaPrivateJobPath -Path $GameAssemblyPath -JobRoot $jobRoot
    $expectedGamePackageRoot = Join-Path ([string]$build[0].environment.NUGET_PACKAGES) `
        'dysonsphereprogram.gamelibs\0.10.34.28529-r.0'
    if (-not (Test-NebulaPrivatePathWithin -Candidate $gameAssembly -Parent $expectedGamePackageRoot) -or
        -not (Test-Path -LiteralPath $gameAssembly -PathType Leaf) -or
        [IO.Path]::GetFileName($gameAssembly) -cne 'Assembly-CSharp.dll') {
        Throw-NebulaPrivateError -Code 'NEBULA_PRIVATE_GAME_VERSION_INVALID'
    }
    $gameAssemblyInfo = [Reflection.Assembly]::ReflectionOnlyLoadFrom($gameAssembly)
    if ($gameAssemblyInfo.ManifestModule.ModuleVersionId.ToString('D').ToLowerInvariant() -cne
        [string]$script:NebulaPrivateContract.game.assemblyCSharpMvid) {
        Throw-NebulaPrivateError -Code 'NEBULA_PRIVATE_GAME_VERSION_INVALID'
    }

    $artifacts = @($records | ForEach-Object {
        $kind = if ([string]$_.path -like '*.dll') { 'managed-dll' } elseif ([string]$_.path -like '*.pdb') {
            'portable-pdb'
        } else { Throw-NebulaPrivateError -Code 'NEBULA_PRIVATE_HARVEST_SCOPE_INVALID' }
        [pscustomobject][ordered]@{ path = [string]$_.path; kind = $kind; size = [int64]$_.size; sha256 = [string]$_.sha256 }
    })
    $assemblies = @()
    foreach ($dllName in @('NebulaNetwork.dll','NebulaPatcher.dll')) {
        $relativeDll = 'nebula-NebulaMultiplayerMod/' + $dllName
        $relativePdb = $relativeDll -replace '\.dll$','.pdb'
        $dllPath = Join-Path $harvestRoot $relativeDll.Replace('/', '\')
        $pdbPath = Join-Path $harvestRoot $relativePdb.Replace('/', '\')
        $assembly = Get-NebulaPrivateAssemblyInfo -DllPath $dllPath -RelativePath $relativeDll
        $codeView = Get-NebulaPrivateCodeViewRecord -Path $dllPath
        $pdbId = Get-NebulaPrivatePortablePdbId -Path $pdbPath
        $assembly | Add-Member -NotePropertyName debug -NotePropertyValue ([pscustomobject][ordered]@{
            pdbPath = $relativePdb
            codeViewGuid = [string]$codeView.guid
            codeViewAge = [int]$codeView.age
            codeViewTimestamp = [string]$codeView.timestamp
            pdbIdGuid = [string]$pdbId.guid
            pdbIdStamp = [string]$pdbId.stamp
            codeViewPath = [string]$codeView.path
        })
        $assemblies += $assembly
    }
    $hygiene = Get-NebulaPrivateHygieneFindings -Paths @($records | ForEach-Object { [string]$_.fullPath })
    $metadata = [pscustomobject][ordered]@{
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
            buildPlanDigest = [string]$plan.previewDigest
            inputFingerprintSha256 = [string]$plan.inputFingerprintSha256
            stockReferences = @($stockReferenceInfo)
            noAutoResponse = [bool]$plan.isolation.noAutoResponse
            buildProjectReferences = $false
            restoreRecursive = $false
            directoryBuildTargetsIsolated = [bool]$plan.isolation.directoryBuildTargetsIsolated
            outputsIsolated = [bool]$plan.isolation.outputsIsolated
            nugetIsolated = [bool]$plan.isolation.nugetIsolated
            tempIsolated = [bool]$plan.isolation.tempIsolated
            pathMapTarget = [string]$plan.isolation.pathMapTarget
            pathMapIntermediateTarget = [string]$plan.isolation.pathMapIntermediateTarget
            pathMapOutputTarget = [string]$plan.isolation.pathMapOutputTarget
        }
        artifacts = $artifacts
        assemblies = @($assemblies | Sort-Object -Property path -CaseSensitive)
        publicHygieneFindings = @($hygiene)
    }
    [void](Assert-NebulaPrivateMetadata -Metadata $metadata -HarvestRoot $harvestRoot)
    if ([string]::IsNullOrWhiteSpace($OutputPath)) {
        $OutputPath = Join-Path $jobRoot ('evidence\binary-metadata-' + $BuildSlot + '.json')
    }
    [void](Write-NebulaPrivateJsonAtomic -Path $OutputPath -Value $metadata -JobRoot $jobRoot)
    [pscustomobject][ordered]@{
        protocol = $script:NebulaPrivateMetadataProtocol
        buildSlot = $BuildSlot
        artifactCount = 4
        metadataSha256 = Get-NebulaPrivateFileSha256 -Path $OutputPath
    } | ConvertTo-Json -Compress
}
catch {
    $code = Get-NebulaPrivateErrorCode -Exception $_.Exception
    [Console]::Error.WriteLine($code)
    exit 1
}
