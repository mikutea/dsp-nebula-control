[CmdletBinding(SupportsShouldProcess, ConfirmImpact = 'High')]
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
$apply = $PSCmdlet.ShouldProcess(
    'Windows Winlogon LSA private data and fixed non-secret automatic-logon flags',
    'Configure the dedicated Dyson interactive session with a rollback backup'
)
$result = Invoke-DysonConfigureInteractiveSession -Credential $Credential -Context $context -Apply $apply
$result | ConvertTo-Json -Depth 7 -Compress
