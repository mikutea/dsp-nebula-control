[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$ProjectRoot,
    [Parameter(Mandatory)][string]$GsManagerRoot,
    [string]$TaskName = 'Dyson-GSManager',
    [ValidateRange(1, 50000)][int]$MaximumFiles = 10000,
    [ValidateRange(1, 8589934592)][int64]$MaximumTotalBytes = [int64](2GB),
    [ValidateRange(1, 2147483648)][int64]$MaximumSingleFileBytes = [int64](512MB)
)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
. (Join-Path $PSScriptRoot 'DysonGsManagerMigration.Common.ps1')

Assert-DysonGsTaskName -TaskName $TaskName
$layout = Resolve-DysonGsLayout -ProjectRoot $ProjectRoot -GsManagerRoot $GsManagerRoot
$inventory = Get-DysonGsTreeInventory -Root $layout.gsManagerRoot -MaximumFiles $MaximumFiles `
    -MaximumTotalBytes $MaximumTotalBytes -MaximumSingleFileBytes $MaximumSingleFileBytes -RejectSaveFiles
$task = Get-DysonGsTaskCapture -TaskName $TaskName
[ordered]@{
    protocol = $script:DysonGsMigrationProtocol
    state = 'inspected'
    dryRun = $true
    fileCount = $inventory.fileCount
    totalBytes = $inventory.totalBytes
    treeSha256 = $inventory.treeSha256
    taskStatus = if ([bool]$task.present) { 'present' } else { 'absent' }
    saveFilesAccepted = $false
    snapshotPublished = $false
    productionChanged = $false
} | ConvertTo-DysonGsJsonLine
