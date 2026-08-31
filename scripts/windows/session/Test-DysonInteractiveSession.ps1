[CmdletBinding()]
param(
    [Parameter(Mandatory)]
    [System.Management.Automation.PSCredential]$Credential
)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$commonPath = Join-Path $PSScriptRoot 'DysonSession.Common.ps1'
$commonItem = Get-Item -LiteralPath $commonPath -Force -ErrorAction Stop
if ($commonItem.PSIsContainer -or
    ($commonItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint)) {
    throw 'The fixed interactive-session helper is unavailable or redirected.'
}
. $commonItem.FullName

Assert-DysonSessionAdministrator
$context = New-DysonNativeSessionContext
$result = Get-DysonInteractiveSessionConfiguration -Context $context -Credential $Credential
$result | ConvertTo-Json -Depth 7 -Compress
