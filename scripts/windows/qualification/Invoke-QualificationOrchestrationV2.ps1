[CmdletBinding(SupportsShouldProcess = $true, ConfirmImpact = 'Medium')]
param(
    [Parameter(Mandatory)][string]$ProfilePath,
    [Parameter(Mandatory)][string]$RequestPath,
    [Parameter(Mandatory)][string]$KeyRingPath,
    [switch]$Resume
)

Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)

. (Join-Path $PSScriptRoot 'Qualification.OrchestrationV2.ps1')

$keys = @{}
$keyMaterialDigests = @{}
try {
    $now = [datetimeoffset]::UtcNow
    $profile = Import-DysonOrchestrationV2Profile -Path $ProfilePath -NowUtc $now -AllowExpired:$Resume
    $request = Import-DysonOrchestrationV2Request -Path $RequestPath
    [void](Assert-DysonOrchestrationV2Request -Request $request -Profile $profile -NowUtc $now -Resume:$Resume)

    $keyRingFile = Assert-DysonPrivateEvidencePlainFile -Path $KeyRingPath -MaximumBytes 131072
    if ([string]$request.executionScope -ceq 'production') {
        $keyRingRoot = [IO.Path]::GetDirectoryName($keyRingFile.FullName)
        $drive = New-Object IO.DriveInfo([IO.Path]::GetPathRoot($keyRingRoot))
        if ($drive.DriveType -ne [IO.DriveType]::Fixed) {
            Throw-DysonOrchestrationV2Error -Code 'DYSON_QUALIFICATION_ORCHESTRATION_V2_KEYRING_INVALID'
        }
        try { [void](Assert-DysonPrivateEvidenceDirectoryAcl -Path $keyRingRoot) }
        catch { Throw-DysonOrchestrationV2Error -Code 'DYSON_QUALIFICATION_ORCHESTRATION_V2_KEYRING_INVALID' }
    }
    try {
        $keyRing = ConvertFrom-DysonOrchestrationV2StrictJson `
            -Text ([IO.File]::ReadAllText($keyRingFile.FullName, [Text.Encoding]::UTF8)) `
            -Code 'DYSON_QUALIFICATION_ORCHESTRATION_V2_KEYRING_INVALID'
        Assert-DysonQualificationV2ExactProperties -Value $keyRing -Names @('protocol','schemaVersion','keys') `
            -Code 'DYSON_QUALIFICATION_ORCHESTRATION_V2_KEYRING_INVALID'
        if ([string]$keyRing.protocol -cne $script:DysonOrchestrationV2KeyRingProtocol -or
            -not (Test-DysonQualificationV2Integer -Value $keyRing.schemaVersion) -or [int]$keyRing.schemaVersion -ne 2) {
            throw 'invalid key ring'
        }
        $expectedKeyIds = @((Get-DysonOrchestrationV2Contract).actions | ForEach-Object { [string]$_.keyId })
        if (@($keyRing.keys).Count -ne $expectedKeyIds.Count) { throw 'invalid key ring' }
        foreach ($entry in @($keyRing.keys)) {
            Assert-DysonQualificationV2ExactProperties -Value $entry -Names @('keyId','keyBase64') `
                -Code 'DYSON_QUALIFICATION_ORCHESTRATION_V2_KEYRING_INVALID'
            if ($expectedKeyIds -cnotcontains [string]$entry.keyId -or $keys.ContainsKey([string]$entry.keyId) -or
                $entry.keyBase64 -isnot [string] -or ([string]$entry.keyBase64).Length -gt 256) {
                throw 'invalid key ring'
            }
            $decoded = [Convert]::FromBase64String([string]$entry.keyBase64)
            if ($decoded.Length -lt 32 -or $decoded.Length -gt 128) {
                [Array]::Clear($decoded, 0, $decoded.Length)
                throw 'invalid key ring'
            }
            $sha = [Security.Cryptography.SHA256]::Create()
            try { $keyMaterialDigest = [BitConverter]::ToString($sha.ComputeHash($decoded)).Replace('-', '').ToLowerInvariant() }
            finally { $sha.Dispose() }
            if ($keyMaterialDigests.ContainsKey($keyMaterialDigest)) {
                [Array]::Clear($decoded, 0, $decoded.Length)
                throw 'invalid key ring'
            }
            $keyMaterialDigests[$keyMaterialDigest] = $true
            $keys[[string]$entry.keyId] = $decoded
        }
        $keyRing = $null
    }
    catch {
        if ($_.Exception.Data.Contains('Code')) { throw }
        Throw-DysonOrchestrationV2Error -Code 'DYSON_QUALIFICATION_ORCHESTRATION_V2_KEYRING_INVALID'
    }

    $resolver = {
        param([string]$KeyId)
        if (-not $keys.ContainsKey($KeyId)) {
            Throw-DysonOrchestrationV2Error -Code 'DYSON_QUALIFICATION_ORCHESTRATION_V2_KEY_INVALID'
        }
        $source = [byte[]]$keys[$KeyId]
        $copy = New-Object byte[] $source.Length
        [Array]::Copy($source, $copy, $source.Length)
        return $copy
    }
    $result = Invoke-DysonQualificationOrchestrationV2 -Profile $profile -Request $request `
        -KeyResolver $resolver -NowUtc $now -Resume:$Resume
    $result | ConvertTo-Json -Depth 16 -Compress
    exit 0
}
catch {
    $code = Get-DysonOrchestrationV2ErrorCode -Exception $_.Exception
    [pscustomobject][ordered]@{
        ok = $false
        error = [pscustomobject][ordered]@{ code = $code }
        qualificationStateChanged = $false
        productionChanged = $false
    } | ConvertTo-Json -Depth 4 -Compress
    exit 1
}
finally {
    foreach ($key in @($keys.Values)) {
        if ($null -ne $key) { [Array]::Clear([byte[]]$key, 0, ([byte[]]$key).Length) }
    }
}
