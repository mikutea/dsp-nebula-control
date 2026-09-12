[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$protocol = 'DYSON_CONTROL_GAME_BOOTSTRAP_V1'
try {
    $commonPath = [System.IO.Path]::Combine($PSScriptRoot, 'DysonGameLifecycleBootstrap.Common.ps1')
    $commonItem = [System.IO.FileInfo]::new($commonPath)
    $commonItem.Refresh()
    if (-not $commonItem.Exists -or ($commonItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint)) {
        throw 'bootstrap common unavailable'
    }
    . $commonItem.FullName
    $context = Get-DysonGameBootstrapContext -BootstrapRoot $PSScriptRoot
    $release = Resolve-DysonGameBootstrapActiveRelease -Context $context
    [ordered]@{
        protocol = $protocol
        state = 'resolved'
        version = [string]$release.version
        payloadSha256 = [string]$release.payloadSha256
        pointerSha256 = [string]$release.pointerSha256
        manifestSha256 = [string]$release.manifestSha256
        startScriptSha256 = [string]$release.startScriptSha256
        stopScriptSha256 = [string]$release.stopScriptSha256
    } | ConvertTo-DysonGameBootstrapJsonLine
    exit 0
}
catch {
    [ordered]@{
        protocol = $protocol
        state = 'failed'
        errorCode = 'BOOTSTRAP_RESOLUTION_FAILED'
    } | Microsoft.PowerShell.Utility\ConvertTo-Json -Depth 4 -Compress
    exit 1
}
