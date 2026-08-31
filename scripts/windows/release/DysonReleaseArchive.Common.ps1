Set-StrictMode -Version 2.0

. (Join-Path $PSScriptRoot 'DysonReleasePackaging.Common.ps1')

$script:DysonReleasePackageProtocol = 'DYSON_CONTROL_RELEASE_PACKAGE_V1'
$script:DysonReleaseProvenanceProtocol = 'DYSON_CONTROL_RELEASE_PROVENANCE_V1'
$script:DysonReleasePackageBuilderName = 'dsp-nebula-control-release-packager'
$script:DysonReleasePackageBuilderVersion = '1.0.0'
$script:DysonReleaseArchiveFormat = 'zip-store-v1'
$script:DysonReleaseArchiveFixedTimestamp = '1980-01-01T00:00:00Z'
$script:DysonReleaseArchiveExternalAttributes = -2119958528 # Unix regular file 0644 (0x81A40000).
$script:DysonReleaseArchiveBufferBytes = 1MB
$script:DysonReleaseMaximumManifestBytes = 32MB
$script:DysonReleaseMaximumArchiveBytes = [int64](3GB)

function Initialize-DysonReleaseArchiveWriter {
    if ('Dyson.Release.ZipStoreWriter' -as [type]) { return }

    Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Security.Cryptography;
using System.Text;

namespace Dyson.Release
{
    public sealed class ZipEntrySpec
    {
        public string RelativePath { get; set; }
        public string FullPath { get; set; }
        public long ExpectedLength { get; set; }
        public string ExpectedSha256 { get; set; }
    }

    internal sealed class ZipCentralRecord
    {
        internal byte[] Name;
        internal uint Crc32;
        internal uint Size;
        internal uint Offset;
    }

    public static class ZipStoreWriter
    {
        private const ushort Utf8AndDescriptorFlags = 0x0808;
        private const ushort StoredMethod = 0;
        private const ushort DosTime = 0;
        private const ushort DosDate = 0x0021;
        private const uint ExternalAttributes = 0x81A40000;
        private static readonly uint[] CrcTable = BuildCrcTable();

        public static void Write(string outputPath, ZipEntrySpec[] entries)
        {
            if (String.IsNullOrWhiteSpace(outputPath) || entries == null || entries.Length < 1 || entries.Length > 65534)
                throw new InvalidDataException("The deterministic ZIP input is invalid.");

            List<ZipCentralRecord> central = new List<ZipCentralRecord>(entries.Length);
            UTF8Encoding utf8 = new UTF8Encoding(false, true);
            using (FileStream output = new FileStream(outputPath, FileMode.CreateNew, FileAccess.Write, FileShare.None, 1048576, FileOptions.SequentialScan))
            {
                foreach (ZipEntrySpec spec in entries)
                {
                    if (spec == null || String.IsNullOrWhiteSpace(spec.RelativePath) || String.IsNullOrWhiteSpace(spec.FullPath)
                        || spec.ExpectedLength < 0 || spec.ExpectedLength > UInt32.MaxValue
                        || String.IsNullOrWhiteSpace(spec.ExpectedSha256) || spec.ExpectedSha256.Length != 64)
                        throw new InvalidDataException("A deterministic ZIP entry is invalid.");
                    byte[] name = utf8.GetBytes(spec.RelativePath);
                    if (name.Length < 1 || name.Length > UInt16.MaxValue || output.Position > UInt32.MaxValue)
                        throw new InvalidDataException("A deterministic ZIP entry exceeds ZIP32 bounds.");
                    uint offset = checked((uint)output.Position);

                    WriteUInt32(output, 0x04034b50);
                    WriteUInt16(output, 20);
                    WriteUInt16(output, Utf8AndDescriptorFlags);
                    WriteUInt16(output, StoredMethod);
                    WriteUInt16(output, DosTime);
                    WriteUInt16(output, DosDate);
                    WriteUInt32(output, 0);
                    WriteUInt32(output, 0);
                    WriteUInt32(output, 0);
                    WriteUInt16(output, checked((ushort)name.Length));
                    WriteUInt16(output, 0);
                    output.Write(name, 0, name.Length);

                    uint crc = UInt32.MaxValue;
                    long written = 0;
                    byte[] buffer = new byte[1048576];
                    string actualSha256;
                    using (SHA256 hasher = SHA256.Create())
                    using (FileStream input = new FileStream(spec.FullPath, FileMode.Open, FileAccess.Read, FileShare.Read, 1048576, FileOptions.SequentialScan))
                    {
                        if (input.Length != spec.ExpectedLength)
                            throw new InvalidDataException("A deterministic ZIP source changed before it was read.");
                        int read;
                        while ((read = input.Read(buffer, 0, buffer.Length)) > 0)
                        {
                            written += read;
                            if (written > spec.ExpectedLength)
                                throw new InvalidDataException("A deterministic ZIP source changed while it was read.");
                            for (int index = 0; index < read; index++)
                                crc = CrcTable[(crc ^ buffer[index]) & 0xff] ^ (crc >> 8);
                            hasher.TransformBlock(buffer, 0, read, buffer, 0);
                            output.Write(buffer, 0, read);
                        }
                        hasher.TransformFinalBlock(new byte[0], 0, 0);
                        actualSha256 = ToLowerHex(hasher.Hash);
                    }
                    crc ^= UInt32.MaxValue;
                    if (written != spec.ExpectedLength || !String.Equals(actualSha256, spec.ExpectedSha256, StringComparison.Ordinal))
                        throw new InvalidDataException("A deterministic ZIP source no longer matches its verified manifest.");
                    uint size = checked((uint)written);

                    WriteUInt32(output, 0x08074b50);
                    WriteUInt32(output, crc);
                    WriteUInt32(output, size);
                    WriteUInt32(output, size);
                    central.Add(new ZipCentralRecord { Name = name, Crc32 = crc, Size = size, Offset = offset });
                }

                if (output.Position > UInt32.MaxValue)
                    throw new InvalidDataException("The deterministic ZIP central directory exceeds ZIP32 bounds.");
                uint centralOffset = checked((uint)output.Position);
                foreach (ZipCentralRecord record in central)
                {
                    WriteUInt32(output, 0x02014b50);
                    WriteUInt16(output, 0x0314); // Unix creator, ZIP 2.0.
                    WriteUInt16(output, 20);
                    WriteUInt16(output, Utf8AndDescriptorFlags);
                    WriteUInt16(output, StoredMethod);
                    WriteUInt16(output, DosTime);
                    WriteUInt16(output, DosDate);
                    WriteUInt32(output, record.Crc32);
                    WriteUInt32(output, record.Size);
                    WriteUInt32(output, record.Size);
                    WriteUInt16(output, checked((ushort)record.Name.Length));
                    WriteUInt16(output, 0);
                    WriteUInt16(output, 0);
                    WriteUInt16(output, 0);
                    WriteUInt16(output, 0);
                    WriteUInt32(output, ExternalAttributes);
                    WriteUInt32(output, record.Offset);
                    output.Write(record.Name, 0, record.Name.Length);
                }
                long centralLength = output.Position - centralOffset;
                if (centralLength < 0 || centralLength > UInt32.MaxValue)
                    throw new InvalidDataException("The deterministic ZIP central directory is invalid.");

                WriteUInt32(output, 0x06054b50);
                WriteUInt16(output, 0);
                WriteUInt16(output, 0);
                WriteUInt16(output, checked((ushort)central.Count));
                WriteUInt16(output, checked((ushort)central.Count));
                WriteUInt32(output, checked((uint)centralLength));
                WriteUInt32(output, centralOffset);
                WriteUInt16(output, 0);
                output.Flush(true);
            }
        }

        private static uint[] BuildCrcTable()
        {
            uint[] table = new uint[256];
            for (uint index = 0; index < table.Length; index++)
            {
                uint value = index;
                for (int bit = 0; bit < 8; bit++)
                    value = (value & 1) == 1 ? 0xedb88320 ^ (value >> 1) : value >> 1;
                table[index] = value;
            }
            return table;
        }

        private static string ToLowerHex(byte[] value)
        {
            StringBuilder result = new StringBuilder(value.Length * 2);
            foreach (byte item in value) result.Append(item.ToString("x2", CultureInfo.InvariantCulture));
            return result.ToString();
        }

        private static void WriteUInt16(Stream output, ushort value)
        {
            output.WriteByte((byte)value);
            output.WriteByte((byte)(value >> 8));
        }

        private static void WriteUInt32(Stream output, uint value)
        {
            output.WriteByte((byte)value);
            output.WriteByte((byte)(value >> 8));
            output.WriteByte((byte)(value >> 16));
            output.WriteByte((byte)(value >> 24));
        }
    }
}
'@ -Language CSharp -ErrorAction Stop
}

function Assert-DysonReleaseTag {
    param([Parameter(Mandatory)][string]$Tag)

    if ($Tag.Length -gt 64 -or
        $Tag -notmatch '^v(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)(?:-rc\.(?:0|[1-9][0-9]*))?$') {
        throw 'Release tags must be canonical vMAJOR.MINOR.PATCH or vMAJOR.MINOR.PATCH-rc.NUMBER values.'
    }
    return $Tag.Substring(1)
}

function Assert-DysonReleaseCommit {
    param([Parameter(Mandatory)][string]$Commit)

    if ($Commit -cnotmatch '^[0-9a-f]{40}$') {
        throw 'Release commits must be exact lowercase 40-character Git object IDs.'
    }
}

function Assert-DysonReleaseNodeVersion {
    param([Parameter(Mandatory)][string]$NodeVersion)

    if ($NodeVersion -cnotmatch '^24\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$') {
        throw 'The release builder must report an exact Node.js 24 version without a leading v.'
    }
}

function Get-DysonReleaseAssetNames {
    param([Parameter(Mandatory)][string]$Tag)

    [void](Assert-DysonReleaseTag -Tag $Tag)
    $baseName = "DysonControl-$Tag"
    return [ordered]@{
        archive = "$baseName.zip"
        checksum = "$baseName.zip.sha256"
        provenance = "$baseName.provenance.json"
    }
}

function Get-DysonReleaseArtifactArchiveEntries {
    param(
        [Parameter(Mandatory)][string]$ArtifactRoot,
        [Parameter(Mandatory)]$Manifest
    )

    $entriesByPath = @{}
    $manifestPath = Join-Path $ArtifactRoot $script:DysonArtifactManifestName
    $manifestItem = Get-Item -LiteralPath $manifestPath -Force -ErrorAction Stop
    if ($manifestItem.PSIsContainer -or ($manifestItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -or
        $manifestItem.Length -lt 1 -or $manifestItem.Length -gt $script:DysonReleaseMaximumManifestBytes) {
        throw 'The artifact manifest cannot be archived safely.'
    }
    $entriesByPath[$script:DysonArtifactManifestName] = [ordered]@{
        path = $script:DysonArtifactManifestName
        fullPath = $manifestItem.FullName
        length = [int64]$manifestItem.Length
        sha256 = Get-DysonArtifactFileSha256 -Path $manifestItem.FullName
    }

    foreach ($manifestFile in @($Manifest.files)) {
        Assert-DysonArtifactExactProperties -Value $manifestFile -Expected @('path', 'length', 'sha256') -Name 'Artifact file entry'
        $relative = [string]$manifestFile.path
        Assert-DysonArtifactRelativePath -Path $relative
        if ($relative -match '[:*?"<>|]' -or $relative.Contains('\')) {
            throw 'An artifact file cannot be represented as a portable release archive entry.'
        }
        if ($entriesByPath.ContainsKey($relative)) { throw 'The release archive input contains duplicate paths.' }
        $fullPath = Get-DysonArtifactFullPath -Path (Join-Path $ArtifactRoot $relative)
        if (-not (Test-DysonArtifactPathWithin -Candidate $fullPath -Parent $ArtifactRoot)) {
            throw 'A release archive entry escaped the artifact root.'
        }
        $item = Get-Item -LiteralPath $fullPath -Force -ErrorAction Stop
        if ($item.PSIsContainer -or ($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint)) {
            throw 'A release archive entry is not a regular file.'
        }
        $entriesByPath[$relative] = [ordered]@{
            path = $relative
            fullPath = $item.FullName
            length = [int64]$manifestFile.length
            sha256 = [string]$manifestFile.sha256
        }
    }

    $paths = [string[]]@($entriesByPath.Keys)
    [System.Array]::Sort($paths, [System.StringComparer]::Ordinal)
    return @($paths | ForEach-Object { $entriesByPath[$_] })
}

function Write-DysonDeterministicReleaseArchive {
    param(
        [Parameter(Mandatory)][string]$ArtifactRoot,
        [Parameter(Mandatory)]$Manifest,
        [Parameter(Mandatory)][string]$ArchivePath
    )

    $entries = @(Get-DysonReleaseArtifactArchiveEntries -ArtifactRoot $ArtifactRoot -Manifest $Manifest)
    if ($entries.Count -lt 2 -or $entries.Count -gt ($script:DysonArtifactMaximumFiles + 1)) {
        throw 'The release archive entry count is outside its bounds.'
    }
    Initialize-DysonReleaseArchiveWriter
    $specifications = [System.Array]::CreateInstance([Dyson.Release.ZipEntrySpec], $entries.Count)
    for ($index = 0; $index -lt $entries.Count; $index++) {
        $sourceEntry = $entries[$index]
        $specification = [Dyson.Release.ZipEntrySpec]::new()
        $specification.RelativePath = [string]$sourceEntry.path
        $specification.FullPath = [string]$sourceEntry.fullPath
        $specification.ExpectedLength = [int64]$sourceEntry.length
        $specification.ExpectedSha256 = [string]$sourceEntry.sha256
        $specifications.SetValue($specification, $index)
    }
    [Dyson.Release.ZipStoreWriter]::Write($ArchivePath, $specifications)
    $archiveItem = Get-Item -LiteralPath $ArchivePath -Force -ErrorAction Stop
    if ($archiveItem.Length -lt 1 -or $archiveItem.Length -gt $script:DysonReleaseMaximumArchiveBytes) {
        throw 'The generated release archive is outside its size bounds.'
    }
    return [ordered]@{
        sha256 = Get-DysonArtifactFileSha256 -Path $archiveItem.FullName
        bytes = [int64]$archiveItem.Length
        entryCount = [int]$entries.Count
    }
}

function New-DysonReleaseProvenance {
    param(
        [Parameter(Mandatory)][string]$Tag,
        [Parameter(Mandatory)][string]$Commit,
        [Parameter(Mandatory)][string]$NodeVersion,
        [Parameter(Mandatory)]$ArtifactVerification,
        [Parameter(Mandatory)][string]$ArchiveName,
        [Parameter(Mandatory)]$ArchiveResult
    )

    return [ordered]@{
        protocol = $script:DysonReleaseProvenanceProtocol
        schemaVersion = 1
        tag = $Tag
        commit = $Commit
        artifact = [ordered]@{
            protocol = [string]$ArtifactVerification.protocol
            version = [string]$ArtifactVerification.version
            nodeMinimumMajor = [int]$ArtifactVerification.nodeMinimumMajor
            payloadSha256 = [string]$ArtifactVerification.payloadSha256
            fileCount = [int]$ArtifactVerification.fileCount
            totalBytes = [int64]$ArtifactVerification.totalBytes
        }
        archive = [ordered]@{
            fileName = $ArchiveName
            format = $script:DysonReleaseArchiveFormat
            sha256 = [string]$ArchiveResult.sha256
            bytes = [int64]$ArchiveResult.bytes
            entryCount = [int]$ArchiveResult.entryCount
            fixedTimestamp = $script:DysonReleaseArchiveFixedTimestamp
            fileMode = '0644'
        }
        builder = [ordered]@{
            name = $script:DysonReleasePackageBuilderName
            version = $script:DysonReleasePackageBuilderVersion
            nodeVersion = $NodeVersion
            powerShellVersion = $PSVersionTable.PSVersion.ToString()
            operatingSystem = 'windows'
        }
    }
}

function Assert-DysonReleaseCanonicalJson {
    param(
        [Parameter(Mandatory)][string]$Raw,
        [Parameter(Mandatory)]$Value
    )

    $canonical = $Value | ConvertTo-Json -Depth 12 -Compress
    if (-not [string]::Equals($Raw, $canonical, [System.StringComparison]::Ordinal)) {
        throw 'Release provenance JSON is not in the canonical form.'
    }
}

function Read-DysonReleaseProvenance {
    param([Parameter(Mandatory)][string]$Path)

    $item = Get-Item -LiteralPath $Path -Force -ErrorAction Stop
    if ($item.PSIsContainer -or ($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -or
        $item.Length -lt 1 -or $item.Length -gt 1MB) {
        throw 'Release provenance is unavailable, redirected, empty, or too large.'
    }
    $raw = [System.IO.File]::ReadAllText($item.FullName, [System.Text.Encoding]::UTF8)
    try { $value = $raw | ConvertFrom-Json }
    catch { throw 'Release provenance is invalid JSON.' }
    Assert-DysonReleaseCanonicalJson -Raw $raw -Value $value
    return $value
}

function Assert-DysonReleaseProvenanceContract {
    param(
        [Parameter(Mandatory)]$Provenance,
        [Parameter(Mandatory)][string]$ExpectedTag,
        [string]$ExpectedCommit
    )

    $version = Assert-DysonReleaseTag -Tag $ExpectedTag
    Assert-DysonArtifactExactProperties -Value $Provenance -Expected @(
        'protocol', 'schemaVersion', 'tag', 'commit', 'artifact', 'archive', 'builder'
    ) -Name 'Release provenance'
    Assert-DysonArtifactExactProperties -Value $Provenance.artifact -Expected @(
        'protocol', 'version', 'nodeMinimumMajor', 'payloadSha256', 'fileCount', 'totalBytes'
    ) -Name 'Release provenance artifact'
    Assert-DysonArtifactExactProperties -Value $Provenance.archive -Expected @(
        'fileName', 'format', 'sha256', 'bytes', 'entryCount', 'fixedTimestamp', 'fileMode'
    ) -Name 'Release provenance archive'
    Assert-DysonArtifactExactProperties -Value $Provenance.builder -Expected @(
        'name', 'version', 'nodeVersion', 'powerShellVersion', 'operatingSystem'
    ) -Name 'Release provenance builder'

    Assert-DysonReleaseCommit -Commit ([string]$Provenance.commit)
    Assert-DysonReleaseNodeVersion -NodeVersion ([string]$Provenance.builder.nodeVersion)
    $names = Get-DysonReleaseAssetNames -Tag $ExpectedTag
    if (-not [string]::Equals([string]$Provenance.protocol, $script:DysonReleaseProvenanceProtocol, [System.StringComparison]::Ordinal) -or
        [int]$Provenance.schemaVersion -ne 1 -or
        -not [string]::Equals([string]$Provenance.tag, $ExpectedTag, [System.StringComparison]::Ordinal) -or
        ($ExpectedCommit -and -not [string]::Equals([string]$Provenance.commit, $ExpectedCommit, [System.StringComparison]::Ordinal)) -or
        -not [string]::Equals([string]$Provenance.artifact.protocol, $script:DysonArtifactProtocol, [System.StringComparison]::Ordinal) -or
        -not [string]::Equals([string]$Provenance.artifact.version, $version, [System.StringComparison]::Ordinal) -or
        [int]$Provenance.artifact.nodeMinimumMajor -ne 24 -or
        [string]$Provenance.artifact.payloadSha256 -cnotmatch '^[0-9a-f]{64}$' -or
        [int64]$Provenance.artifact.fileCount -lt 1 -or [int64]$Provenance.artifact.fileCount -gt $script:DysonArtifactMaximumFiles -or
        [int64]$Provenance.artifact.totalBytes -lt 1 -or [int64]$Provenance.artifact.totalBytes -gt $script:DysonArtifactMaximumBytes -or
        -not [string]::Equals([string]$Provenance.archive.fileName, [string]$names.archive, [System.StringComparison]::Ordinal) -or
        -not [string]::Equals([string]$Provenance.archive.format, $script:DysonReleaseArchiveFormat, [System.StringComparison]::Ordinal) -or
        [string]$Provenance.archive.sha256 -cnotmatch '^[0-9a-f]{64}$' -or
        [int64]$Provenance.archive.bytes -lt 1 -or [int64]$Provenance.archive.bytes -gt $script:DysonReleaseMaximumArchiveBytes -or
        [int64]$Provenance.archive.entryCount -ne ([int64]$Provenance.artifact.fileCount + 1) -or
        -not [string]::Equals([string]$Provenance.archive.fixedTimestamp, $script:DysonReleaseArchiveFixedTimestamp, [System.StringComparison]::Ordinal) -or
        -not [string]::Equals([string]$Provenance.archive.fileMode, '0644', [System.StringComparison]::Ordinal) -or
        -not [string]::Equals([string]$Provenance.builder.name, $script:DysonReleasePackageBuilderName, [System.StringComparison]::Ordinal) -or
        -not [string]::Equals([string]$Provenance.builder.version, $script:DysonReleasePackageBuilderVersion, [System.StringComparison]::Ordinal) -or
        [string]$Provenance.builder.powerShellVersion -cnotmatch '^[0-9]+\.[0-9]+(?:\.[0-9]+){0,2}$' -or
        -not [string]::Equals([string]$Provenance.builder.operatingSystem, 'windows', [System.StringComparison]::Ordinal)) {
        throw 'Release provenance does not satisfy the supported contract.'
    }
}

function Test-DysonReleasePackageDirectoryCore {
    param(
        [Parameter(Mandatory)][string]$PackageDirectory,
        [Parameter(Mandatory)][string]$ExpectedTag,
        [string]$ExpectedCommit
    )

    $version = Assert-DysonReleaseTag -Tag $ExpectedTag
    if ($ExpectedCommit) { Assert-DysonReleaseCommit -Commit $ExpectedCommit }
    $root = Assert-DysonArtifactPlainDirectory -Path $PackageDirectory
    $names = Get-DysonReleaseAssetNames -Tag $ExpectedTag
    $expectedNames = [string[]]@($names.archive, $names.checksum, $names.provenance)
    [System.Array]::Sort($expectedNames, [System.StringComparer]::Ordinal)
    $actualItems = @(Get-ChildItem -LiteralPath $root -Force -ErrorAction Stop)
    if ($actualItems.Count -ne $expectedNames.Count) { throw 'The release package must contain exactly three fixed assets.' }
    $actualNames = New-Object 'System.Collections.Generic.List[string]'
    foreach ($item in $actualItems) {
        if ($item.PSIsContainer -or ($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint)) {
            throw 'Release package assets must be regular files.'
        }
        $actualNames.Add($item.Name)
    }
    $actualNameArray = [string[]]@($actualNames)
    [System.Array]::Sort($actualNameArray, [System.StringComparer]::Ordinal)
    if (-not [string]::Equals([string]::Join("`n", $actualNameArray), [string]::Join("`n", $expectedNames), [System.StringComparison]::Ordinal)) {
        throw 'The release package asset set is missing, extra, or case-drifted.'
    }

    $archivePath = Join-Path $root $names.archive
    $checksumPath = Join-Path $root $names.checksum
    $provenancePath = Join-Path $root $names.provenance
    $provenance = Read-DysonReleaseProvenance -Path $provenancePath
    Assert-DysonReleaseProvenanceContract -Provenance $provenance -ExpectedTag $ExpectedTag -ExpectedCommit $ExpectedCommit

    $expectedChecksumLine = "{0}  {1}`n" -f ([string]$provenance.archive.sha256), ([string]$names.archive)
    $checksumItem = Get-Item -LiteralPath $checksumPath -Force -ErrorAction Stop
    if ($checksumItem.Length -gt 256) { throw 'The release checksum file is too large.' }
    $actualChecksumLine = [System.IO.File]::ReadAllText($checksumItem.FullName, [System.Text.Encoding]::ASCII)
    if (-not [string]::Equals($actualChecksumLine, $expectedChecksumLine, [System.StringComparison]::Ordinal)) {
        throw 'The release checksum file is invalid.'
    }

    $archiveItem = Get-Item -LiteralPath $archivePath -Force -ErrorAction Stop
    $actualArchiveSha256 = Get-DysonArtifactFileSha256 -Path $archiveItem.FullName
    if ($archiveItem.Length -ne [int64]$provenance.archive.bytes -or
        -not [string]::Equals($actualArchiveSha256, [string]$provenance.archive.sha256, [System.StringComparison]::Ordinal)) {
        throw 'The release archive does not match its checksum and provenance.'
    }

    Add-Type -AssemblyName System.IO.Compression
    $temporaryBase = [System.IO.Path]::GetFullPath([System.IO.Path]::GetTempPath()).TrimEnd('\', '/')
    $extractionRoot = Join-Path $temporaryBase ('dyson-release-verify-' + [guid]::NewGuid().ToString('N'))
    [System.IO.Directory]::CreateDirectory($extractionRoot) | Out-Null
    try {
        $fileStream = [System.IO.File]::Open($archiveItem.FullName, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::Read)
        $archive = $null
        try {
            $archive = [System.IO.Compression.ZipArchive]::new(
                $fileStream,
                [System.IO.Compression.ZipArchiveMode]::Read,
                $true,
                [System.Text.UTF8Encoding]::new($false)
            )
            if ($archive.Entries.Count -ne [int]$provenance.archive.entryCount) {
                throw 'The release archive entry count does not match provenance.'
            }
            $entryPaths = @{}
            $totalBytes = [int64]0
            foreach ($entry in $archive.Entries) {
                $relative = [string]$entry.FullName
                Assert-DysonArtifactRelativePath -Path $relative
                if ($relative.Contains('\') -or $relative -match '[:*?"<>|]' -or [string]::IsNullOrWhiteSpace($entry.Name) -or
                    $entryPaths.ContainsKey($relative)) {
                    throw 'The release archive contains a duplicate, directory, or unsafe entry.'
                }
                $entryPaths[$relative] = $true
                $totalBytes += [int64]$entry.Length
                if ($entry.Length -lt 0 -or $entry.Length -gt $script:DysonArtifactMaximumBytes -or
                    $totalBytes -gt ($script:DysonArtifactMaximumBytes + $script:DysonReleaseMaximumManifestBytes)) {
                    throw 'The release archive contains unsupported entry sizes.'
                }
                if ($entry.CompressedLength -ne $entry.Length) {
                    throw 'The release archive must use the deterministic store method.'
                }
                if ($entry.ExternalAttributes -ne $script:DysonReleaseArchiveExternalAttributes) {
                    throw 'The release archive contains unsupported permission metadata.'
                }
                if ($entry.LastWriteTime.DateTime -ne [System.DateTime]::new(1980, 1, 1, 0, 0, 0)) {
                    throw 'The release archive contains unsupported timestamp metadata.'
                }
                $destination = Get-DysonArtifactFullPath -Path (Join-Path $extractionRoot $relative)
                if (-not (Test-DysonArtifactPathWithin -Candidate $destination -Parent $extractionRoot)) {
                    throw 'A release archive extraction target escaped its root.'
                }
                [void](New-DysonArtifactDirectory -Path ([System.IO.Path]::GetDirectoryName($destination)))
                $input = $entry.Open()
                $output = [System.IO.File]::Open($destination, [System.IO.FileMode]::CreateNew, [System.IO.FileAccess]::Write, [System.IO.FileShare]::None)
                try {
                    $buffer = New-Object byte[] $script:DysonReleaseArchiveBufferBytes
                    $written = [int64]0
                    while (($read = $input.Read($buffer, 0, $buffer.Length)) -gt 0) {
                        $written += [int64]$read
                        if ($written -gt [int64]$entry.Length) { throw 'A release archive entry expanded beyond its declared length.' }
                        $output.Write($buffer, 0, $read)
                    }
                    if ($written -ne [int64]$entry.Length) { throw 'A release archive entry was truncated.' }
                }
                finally {
                    $output.Dispose()
                    $input.Dispose()
                }
            }
        }
        finally {
            if ($archive) { $archive.Dispose() }
            $fileStream.Dispose()
        }

        $artifactVerification = Test-DysonControlReleaseArtifactCore -ArtifactRoot $extractionRoot -ExpectedVersion $version
        if (-not [string]::Equals([string]$artifactVerification.protocol, [string]$provenance.artifact.protocol, [System.StringComparison]::Ordinal) -or
            -not [string]::Equals([string]$artifactVerification.version, [string]$provenance.artifact.version, [System.StringComparison]::Ordinal) -or
            [int]$artifactVerification.nodeMinimumMajor -ne [int]$provenance.artifact.nodeMinimumMajor -or
            -not [string]::Equals([string]$artifactVerification.payloadSha256, [string]$provenance.artifact.payloadSha256, [System.StringComparison]::Ordinal) -or
            [int]$artifactVerification.fileCount -ne [int]$provenance.artifact.fileCount -or
            [int64]$artifactVerification.totalBytes -ne [int64]$provenance.artifact.totalBytes) {
            throw 'The archived artifact does not match release provenance.'
        }
    }
    finally {
        $extractionFull = [System.IO.Path]::GetFullPath($extractionRoot).TrimEnd('\', '/')
        $expectedPrefix = $temporaryBase + [System.IO.Path]::DirectorySeparatorChar + 'dyson-release-verify-'
        if ($extractionFull.StartsWith($expectedPrefix, [System.StringComparison]::OrdinalIgnoreCase) -and
            (Test-Path -LiteralPath $extractionFull)) {
            Remove-Item -LiteralPath $extractionFull -Recurse -Force
        }
    }

    return [ordered]@{
        protocol = $script:DysonReleasePackageProtocol
        ready = $true
        tag = $ExpectedTag
        commit = [string]$provenance.commit
        archiveSha256 = $actualArchiveSha256
        archiveBytes = [int64]$archiveItem.Length
        artifactVersion = [string]$provenance.artifact.version
        artifactPayloadSha256 = [string]$provenance.artifact.payloadSha256
        deterministicMetadata = $true
        productionChanged = $false
    }
}
