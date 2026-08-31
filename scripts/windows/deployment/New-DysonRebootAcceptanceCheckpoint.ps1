[CmdletBinding(SupportsShouldProcess, ConfirmImpact = 'Medium')]
param(
    [string]$InstallRoot = (Join-Path $env:ProgramFiles 'DysonControl'),
    [string]$DataRoot = (Join-Path $env:ProgramData 'DysonControl'),
    [Parameter(Mandatory)][uri]$ReadinessUri,
    [ValidatePattern('^[\p{L}\p{N}_. -]{1,128}$')][string]$TaskName = 'Dyson-Control-Plane',
    [ValidateRange(1, 65535)][int]$GamePort = 8469,
    [ValidateRange(1, 72)][int]$ValidityHours = 24
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
    -DataRoot $DataRoot -ReadinessUri $ReadinessUri
$apply = $PSCmdlet.ShouldProcess(
    'the ACL-restricted Dyson Control reboot-acceptance checkpoint store',
    'capture a bounded healthy pre-reboot checkpoint without restarting or rebooting the host'
)
$result = Invoke-DysonCreateRebootAcceptanceCheckpoint -DataRoot $DataRoot -Context $context `
    -TaskName $TaskName -GamePort $GamePort -ValidityHours $ValidityHours -Apply $apply
$result | ConvertTo-Json -Depth 7 -Compress
