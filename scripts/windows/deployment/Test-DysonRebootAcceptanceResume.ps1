[CmdletBinding()]
param(
    [string]$InstallRoot = (Join-Path $env:ProgramFiles 'DysonControl'),
    [string]$DataRoot = (Join-Path $env:ProgramData 'DysonControl'),
    [Parameter(Mandatory)][string]$RuntimeRoot,
    [Parameter(Mandatory)][string]$NodeExecutable,
    [Parameter(Mandatory)][ValidatePattern('^[0-9a-f]{64}$')][string]$ExpectedNodeSha256,
    [Parameter(Mandatory)][ValidatePattern('^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$')]
    [string]$CheckpointId,
    [Parameter(Mandatory)][uri]$ReadinessUri
)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$commonPath = Join-Path $PSScriptRoot 'DysonRebootAcceptance.Common.ps1'
$commonItem = Get-Item -LiteralPath $commonPath -Force -ErrorAction Stop
if ($commonItem.PSIsContainer -or
    ($commonItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint)) {
    throw 'The fixed reboot-acceptance helper is unavailable or redirected.'
}
. $commonItem.FullName

$context = New-DysonNativeRebootAcceptanceContext -InstallRoot $InstallRoot `
    -DataRoot $DataRoot -RuntimeRoot $RuntimeRoot -NodeExecutable $NodeExecutable `
    -ExpectedNodeSha256 $ExpectedNodeSha256 -ReadinessUri $ReadinessUri
$result = Invoke-DysonTestRebootAcceptanceResume -DataRoot $DataRoot `
    -CheckpointId $CheckpointId -Context $context
$result | ConvertTo-Json -Depth 7 -Compress
