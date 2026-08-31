[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
. (Join-Path $PSScriptRoot 'DysonReleaseArchive.Common.ps1')

$newPackageScript = Join-Path $PSScriptRoot 'New-DysonControlReleasePackage.ps1'
$testPackageScript = Join-Path $PSScriptRoot 'Test-DysonControlReleasePackage.ps1'
$temporaryBase = [System.IO.Path]::GetFullPath([System.IO.Path]::GetTempPath()).TrimEnd('\', '/')
$testRoot = Join-Path $temporaryBase ('dyson-release-package-selftest-' + [guid]::NewGuid().ToString('N'))
$artifactRoot = Join-Path $testRoot 'artifact'
$packageA = Join-Path $testRoot 'package-a'
$packageB = Join-Path $testRoot 'package-b'
$packagePreview = Join-Path $testRoot 'package-preview'
$packageInvalidTag = Join-Path $testRoot 'package-invalid-tag'
$packageInvalidArtifact = Join-Path $testRoot 'package-invalid-artifact'
$packageArchiveTamper = Join-Path $testRoot 'package-archive-tamper'
$packageChecksumTamper = Join-Path $testRoot 'package-checksum-tamper'
$packageProvenanceTamper = Join-Path $testRoot 'package-provenance-tamper'
$tag = 'v1.2.3-rc.4'
$version = '1.2.3-rc.4'
$commit = '0123456789abcdef0123456789abcdef01234567'
$nodeVersion = '24.14.0'

function Assert-PackageSelfTest {
    param([bool]$Condition, [string]$Message)
    if (-not $Condition) { throw "Release package self-test failed: $Message" }
}

function Write-FixtureText {
    param([string]$Path, [string]$Value)
    [System.IO.Directory]::CreateDirectory([System.IO.Path]::GetDirectoryName($Path)) | Out-Null
    [System.IO.File]::WriteAllText($Path, $Value, [System.Text.UTF8Encoding]::new($false))
}

function Copy-FixturePackage {
    param([string]$Source, [string]$Destination)
    [System.IO.Directory]::CreateDirectory($Destination) | Out-Null
    foreach ($item in @(Get-ChildItem -LiteralPath $Source -File -Force -ErrorAction Stop)) {
        [System.IO.File]::Copy($item.FullName, (Join-Path $Destination $item.Name), $false)
    }
}

function Convert-LastJsonResult {
    param($Output)
    $lines = @(($Output | Out-String) -split "`r?`n" | Where-Object { -not [string]::IsNullOrWhiteSpace($_) })
    if ($lines.Count -eq 0) { throw 'A release package self-test command returned no JSON.' }
    return $lines[$lines.Count - 1] | ConvertFrom-Json
}

function Test-CommandRejected {
    param([scriptblock]$Command)
    try { & $Command; return $false }
    catch { return $true }
}

[System.IO.Directory]::CreateDirectory($artifactRoot) | Out-Null
try {
    Write-FixtureText -Path (Join-Path $artifactRoot 'LICENSE') -Value "Fictional release fixture license.`n"
    Write-FixtureText -Path (Join-Path $artifactRoot 'apps\api\package.json') -Value @'
{"name":"@example/dyson-control-package-fixture","version":"1.2.3-rc.4","private":true,"type":"module","main":"dist/index.js","dependencies":{}}
'@
    Write-FixtureText -Path (Join-Path $artifactRoot 'apps\api\package-lock.json') -Value @'
{"name":"@example/dyson-control-package-fixture","version":"1.2.3-rc.4","lockfileVersion":3,"requires":true,"packages":{}}
'@
    Write-FixtureText -Path (Join-Path $artifactRoot 'apps\api\dist\index.js') -Value "console.log('fictional package fixture')`n"
    Write-FixtureText -Path (Join-Path $artifactRoot 'apps\web\dist\index.html') -Value "<!doctype html><title>Fictional package fixture</title>`n"
    Write-FixtureText -Path (Join-Path $artifactRoot 'scripts\windows\Fictional-Runtime.ps1') -Value "Write-Output 'fictional runtime'`n"
    foreach ($relative in @(
        $script:DysonArtifactRequiredBridgeSources +
        $script:DysonArtifactRequiredBridgeScripts +
        $script:DysonArtifactRequiredMigrationScripts +
        $script:DysonArtifactRequiredEvidenceScripts +
        $script:DysonArtifactRequiredHostMutationScripts +
        $script:DysonArtifactRequiredMigrationDocs
    )) {
        Write-FixtureText -Path (Join-Path $artifactRoot $relative.Replace('/', '\')) `
            -Value "Fictional required release fixture: $relative`n"
    }
    [void](Write-DysonArtifactManifest -ArtifactRoot $artifactRoot -Version $version -DevDependenciesExcluded @())
    [void](Test-DysonControlReleaseArtifactCore -ArtifactRoot $artifactRoot -ExpectedVersion $version)

    $preview = Convert-LastJsonResult -Output (& $newPackageScript -ArtifactPath $artifactRoot -OutputDirectory $packagePreview `
        -Tag $tag -Commit $commit -NodeVersion $nodeVersion -WhatIf)
    Assert-PackageSelfTest -Condition ($preview.state -eq 'preview' -and [bool]$preview.dryRun) -Message 'WhatIf did not return a preview'
    Assert-PackageSelfTest -Condition (-not (Test-Path -LiteralPath $packagePreview)) -Message 'WhatIf created an output directory'

    $createdA = Convert-LastJsonResult -Output (& $newPackageScript -ArtifactPath $artifactRoot -OutputDirectory $packageA `
        -Tag $tag -Commit $commit -NodeVersion $nodeVersion -Confirm:$false)
    $createdB = Convert-LastJsonResult -Output (& $newPackageScript -ArtifactPath $artifactRoot -OutputDirectory $packageB `
        -Tag $tag -Commit $commit -NodeVersion $nodeVersion -Confirm:$false)
    $verifiedA = Convert-LastJsonResult -Output (& $testPackageScript -PackageDirectory $packageA -ExpectedTag $tag -ExpectedCommit $commit)
    $verifiedB = Convert-LastJsonResult -Output (& $testPackageScript -PackageDirectory $packageB -ExpectedTag $tag -ExpectedCommit $commit)
    Assert-PackageSelfTest -Condition ($createdA.state -eq 'created' -and $createdB.state -eq 'created' -and
        [bool]$verifiedA.ready -and [bool]$verifiedB.ready) -Message 'valid release packages did not verify'

    $names = Get-DysonReleaseAssetNames -Tag $tag
    foreach ($name in @($names.archive, $names.checksum, $names.provenance)) {
        $bytesA = [System.IO.File]::ReadAllBytes((Join-Path $packageA $name))
        $bytesB = [System.IO.File]::ReadAllBytes((Join-Path $packageB $name))
        Assert-PackageSelfTest -Condition ($bytesA.Length -eq $bytesB.Length -and
            [System.Convert]::ToBase64String($bytesA) -ceq [System.Convert]::ToBase64String($bytesB)) `
            -Message "repeated packaging changed asset bytes: $name"
    }

    $overwriteRejected = Test-CommandRejected {
        & $newPackageScript -ArtifactPath $artifactRoot -OutputDirectory $packageA -Tag $tag `
            -Commit $commit -NodeVersion $nodeVersion -Confirm:$false | Out-Null
    }
    Assert-PackageSelfTest -Condition $overwriteRejected -Message 'an existing package directory was overwritten'

    $invalidTagRejected = Test-CommandRejected {
        & $newPackageScript -ArtifactPath $artifactRoot -OutputDirectory $packageInvalidTag -Tag 'v01.2.3' `
            -Commit $commit -NodeVersion $nodeVersion -Confirm:$false | Out-Null
    }
    Assert-PackageSelfTest -Condition ($invalidTagRejected -and -not (Test-Path -LiteralPath $packageInvalidTag)) `
        -Message 'a non-canonical release tag was accepted'

    Copy-FixturePackage -Source $packageA -Destination $packageArchiveTamper
    [System.IO.File]::AppendAllText((Join-Path $packageArchiveTamper $names.archive), 'tamper', [System.Text.UTF8Encoding]::new($false))
    $archiveTamperRejected = Test-CommandRejected {
        & $testPackageScript -PackageDirectory $packageArchiveTamper -ExpectedTag $tag -ExpectedCommit $commit | Out-Null
    }
    Assert-PackageSelfTest -Condition $archiveTamperRejected -Message 'archive tampering was not detected'

    Copy-FixturePackage -Source $packageA -Destination $packageChecksumTamper
    [System.IO.File]::WriteAllText(
        (Join-Path $packageChecksumTamper $names.checksum),
        (('f' * 64) + "  $($names.archive)`n"),
        [System.Text.ASCIIEncoding]::new()
    )
    $checksumTamperRejected = Test-CommandRejected {
        & $testPackageScript -PackageDirectory $packageChecksumTamper -ExpectedTag $tag -ExpectedCommit $commit | Out-Null
    }
    Assert-PackageSelfTest -Condition $checksumTamperRejected -Message 'checksum tampering was not detected'

    Copy-FixturePackage -Source $packageA -Destination $packageProvenanceTamper
    $provenancePath = Join-Path $packageProvenanceTamper $names.provenance
    $provenance = [System.IO.File]::ReadAllText($provenancePath, [System.Text.Encoding]::UTF8) | ConvertFrom-Json
    $provenance | Add-Member -NotePropertyName unexpected -NotePropertyValue 'fictional'
    [System.IO.File]::WriteAllText(
        $provenancePath,
        ($provenance | ConvertTo-Json -Depth 12 -Compress),
        [System.Text.UTF8Encoding]::new($false)
    )
    $provenanceTamperRejected = Test-CommandRejected {
        & $testPackageScript -PackageDirectory $packageProvenanceTamper -ExpectedTag $tag -ExpectedCommit $commit | Out-Null
    }
    Assert-PackageSelfTest -Condition $provenanceTamperRejected -Message 'unknown provenance data was accepted'

    $commitMismatchRejected = Test-CommandRejected {
        & $testPackageScript -PackageDirectory $packageA -ExpectedTag $tag `
            -ExpectedCommit 'fedcba9876543210fedcba9876543210fedcba98' | Out-Null
    }
    Assert-PackageSelfTest -Condition $commitMismatchRejected -Message 'a provenance commit mismatch was accepted'

    [System.IO.File]::AppendAllText((Join-Path $artifactRoot 'apps\api\dist\index.js'), 'tamper', [System.Text.UTF8Encoding]::new($false))
    $invalidArtifactRejected = Test-CommandRejected {
        & $newPackageScript -ArtifactPath $artifactRoot -OutputDirectory $packageInvalidArtifact -Tag $tag `
            -Commit $commit -NodeVersion $nodeVersion -Confirm:$false | Out-Null
    }
    Assert-PackageSelfTest -Condition ($invalidArtifactRejected -and -not (Test-Path -LiteralPath $packageInvalidArtifact)) `
        -Message 'a tampered artifact was packaged'

    [ordered]@{
        protocol = 'DYSON_CONTROL_RELEASE_PACKAGE_SELFTEST_V1'
        state = 'passed'
        dryRunWasNonMutating = $true
        deterministicZip = $true
        deterministicChecksum = $true
        deterministicProvenance = $true
        exactThreeAssetContract = $true
        validPackageVerified = $true
        overwriteRejected = $true
        invalidTagRejected = $true
        archiveTamperRejected = $true
        checksumTamperRejected = $true
        provenanceTamperRejected = $true
        commitMismatchRejected = $true
        tamperedArtifactRejected = $true
        archiveSha256 = [string]$verifiedA.archiveSha256
        productionChanged = $false
    } | ConvertTo-Json -Depth 6 -Compress
}
finally {
    $testFull = [System.IO.Path]::GetFullPath($testRoot).TrimEnd('\', '/')
    $expectedPrefix = $temporaryBase + [System.IO.Path]::DirectorySeparatorChar + 'dyson-release-package-selftest-'
    if ($testFull.StartsWith($expectedPrefix, [System.StringComparison]::OrdinalIgnoreCase) -and
        (Test-Path -LiteralPath $testFull)) {
        Remove-Item -LiteralPath $testFull -Recurse -Force
    }
}
