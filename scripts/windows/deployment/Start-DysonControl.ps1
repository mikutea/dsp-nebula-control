[CmdletBinding()]
param(
    [string]$InstallRoot = (Join-Path $env:ProgramFiles 'DysonControl'),
    [string]$DataRoot = (Join-Path $env:ProgramData 'DysonControl'),
    [Parameter(Mandatory)][string]$NodeExecutable,
    [string]$EnvironmentFile
)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
. (Join-Path $PSScriptRoot 'DysonDeployment.Common.ps1')

$installFull = Assert-DysonSafeRoot -Path $InstallRoot -Name 'InstallRoot'
$dataFull = Assert-DysonSafeRoot -Path $DataRoot -Name 'DataRoot'
$nodePath = Resolve-DysonNodeExecutablePath -NodeExecutable $NodeExecutable
if (-not $EnvironmentFile) { $EnvironmentFile = Join-Path (Join-Path $dataFull 'config') 'dyson-control.env' }
$environmentPath = (Resolve-Path -LiteralPath $EnvironmentFile -ErrorAction Stop).ProviderPath
if (-not (Test-DysonPathWithin -Candidate $environmentPath -Parent (Join-Path $dataFull 'config'))) {
    throw 'The production environment file must remain under the deployment config directory.'
}
$environmentItem = Get-Item -LiteralPath $environmentPath -Force -ErrorAction Stop
if ($environmentItem.PSIsContainer -or ($environmentItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -or
    $environmentItem.Length -gt 65536) {
    throw 'The production environment file is unavailable, redirected, or too large.'
}
$active = Get-DysonActiveRelease -InstallRoot $installFull -DataRoot $dataFull
if (-not $active) { throw 'No Dyson Control release is active.' }
[void](Test-DysonNodeRuntime -NodeExecutable $nodePath -MinimumMajor $active.nodeMinimumMajor)

$configured = @{}
foreach ($line in [System.IO.File]::ReadAllLines($environmentPath, [System.Text.Encoding]::UTF8)) {
    $trimmed = $line.Trim()
    if ($trimmed.Length -eq 0 -or $trimmed.StartsWith('#')) { continue }
    $separator = $line.IndexOf('=')
    if ($separator -lt 1) { throw 'The production environment file contains an invalid line.' }
    $name = $line.Substring(0, $separator).Trim()
    $value = $line.Substring($separator + 1)
    if ($name -ne 'NODE_ENV' -and $name -notmatch '^DYSON_[A-Z0-9_]{1,96}$') {
        throw "Unsupported environment variable in production configuration: $name"
    }
    if ($configured.ContainsKey($name)) { throw "Duplicate environment variable in production configuration: $name" }
    $configured[$name] = $value
}

foreach ($entry in @(Get-ChildItem Env: | Where-Object { $_.Name -eq 'NODE_ENV' -or $_.Name -like 'DYSON_*' })) {
    Remove-Item -LiteralPath ('Env:' + $entry.Name) -ErrorAction SilentlyContinue
}
Remove-Item Env:NODE_OPTIONS -ErrorAction SilentlyContinue
Remove-Item Env:NODE_PATH -ErrorAction SilentlyContinue
foreach ($name in $configured.Keys) { [System.Environment]::SetEnvironmentVariable($name, [string]$configured[$name], 'Process') }

[System.Environment]::SetEnvironmentVariable('NODE_ENV', 'production', 'Process')
[System.Environment]::SetEnvironmentVariable('DYSON_HOST', '127.0.0.1', 'Process')
[System.Environment]::SetEnvironmentVariable('DYSON_DATA_DIR', (Join-Path $dataFull 'data'), 'Process')
[System.Environment]::SetEnvironmentVariable('DYSON_SCRIPT_ROOT', (Join-Path $active.releaseRoot 'scripts\windows'), 'Process')
[System.Environment]::SetEnvironmentVariable('DYSON_DEPLOYMENT_VERSION', ([string]$active.pointer.version), 'Process')

[void](New-DysonDirectory -Path (Join-Path $dataFull 'data'))
[void](New-DysonDirectory -Path (Join-Path $dataFull 'logs'))
Push-Location -LiteralPath $active.releaseRoot
try {
    & $nodePath $active.entryPointPath
    $exitCode = $LASTEXITCODE
}
finally { Pop-Location }
if ($null -eq $exitCode) { $exitCode = 1 }
exit [int]$exitCode
