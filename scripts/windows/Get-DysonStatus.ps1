[CmdletBinding()]
param(
    [Parameter(Mandatory)]
    [string]$ProjectRoot,
    [ValidateRange(1, 65535)]
    [int]$GamePort = 8469
)

$ErrorActionPreference = 'Stop'
$process = Get-Process -Name 'DSPGAME' -ErrorAction SilentlyContinue | Select-Object -First 1
$saveRoot = Join-Path $ProjectRoot 'userdata\Save'
$latestDsv = if (Test-Path -LiteralPath $saveRoot) {
    Get-ChildItem -LiteralPath $saveRoot -Filter '*.dsv' -File |
        Sort-Object LastWriteTime -Descending | Select-Object -First 1
}
$sidecar = if ($latestDsv) {
    Get-Item -LiteralPath (Join-Path $saveRoot ($latestDsv.BaseName + '.server')) -ErrorAction SilentlyContinue
}

$status = [ordered]@{
    collectedAt = (Get-Date).ToUniversalTime().ToString('o')
    serverName = 'Dyson Sphere Program - Nebula'
    state = if ($process) { 'running' } else { 'stopped' }
    runtime = [ordered]@{
        targetUps = 60
        onlinePlayers = $null
        maxPlayers = $null
        processId = if ($process) { [int]$process.Id } else { $null }
        processCoresUsed = $null
        workingSetGiB = if ($process) { [math]::Round($process.WorkingSet64 / 1GB, 2) } else { $null }
        threadCount = if ($process) { [int]$process.Threads.Count } else { $null }
    }
    versions = [ordered]@{ dsp = $null; nebula = $null; bepInEx = $null; compatible = $null }
    save = [ordered]@{
        name = if ($latestDsv) { $latestDsv.BaseName } else { $null }
        dsvPresent = [bool]$latestDsv
        serverPresent = [bool]$sidecar
        consistent = [bool]($latestDsv -and $sidecar)
        lastSavedAt = if ($latestDsv) { $latestDsv.LastWriteTimeUtc.ToString('o') } else { $null }
    }
    connections = @(
        [ordered]@{
            id = 'game-port'; label = "游戏端口 $GamePort"
            status = if (Get-NetTCPConnection -State Listen -LocalPort $GamePort -ErrorAction SilentlyContinue) { 'healthy' } else { 'warning' }
            detail = '本机监听检查'
        },
        [ordered]@{ id = 'public-wss'; label = '公网 WSS'; status = 'unknown'; detail = '未配置外部探针' }
    )
    capabilities = [ordered]@{ refresh = $true; save = $false; gracefulStop = $false; restart = $false }
}

$status | ConvertTo-Json -Depth 8 -Compress
