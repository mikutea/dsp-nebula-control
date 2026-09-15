import { execFile } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

interface CpuTelemetryFixture {
  totalPercent: number | null
  coreSamples: Array<{ index: number, percent: number }> | null
  unavailableReason: 'cim-unavailable' | 'inconsistent-sample' | null
}

const temporaryRoots: string[] = []

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('Windows host CPU telemetry collector', () => {
  it.each([
    { name: 'accepts one complete 8-processor group', expected: 8, visible: 8, grouped: false },
    { name: 'rejects one visible group when the host reports 128 logical processors', expected: 128, visible: 64, grouped: false },
    { name: 'accepts two complete groups for 128 logical processors', expected: 128, visible: 128, grouped: true }
  ])('$name', async ({ expected, visible, grouped }) => {
    const repositoryRoot = path.resolve(import.meta.dirname, '..', '..', '..', '..')
    const fixtureRoot = await mkdtemp(path.join(tmpdir(), 'dyson-cpu-telemetry-'))
    temporaryRoots.push(fixtureRoot)
    const harnessPath = path.join(fixtureRoot, 'Invoke-CpuTelemetryFixture.ps1')
    await writeFile(harnessPath, cpuTelemetryHarness, 'utf8')

    const output = await runPowerShell(harnessPath, [
      '-TargetScript', path.join(repositoryRoot, 'scripts', 'windows', 'Get-DysonStatus.ps1'),
      '-ExpectedLogicalProcessors', String(expected),
      '-VisibleLogicalProcessors', String(visible),
      '-UseProcessorGroups', grouped ? '1' : '0'
    ])
    const telemetry = JSON.parse(output) as CpuTelemetryFixture

    expect(telemetry.totalPercent).toBe(42)
    if (visible !== expected) {
      expect(telemetry).toMatchObject({ coreSamples: null, unavailableReason: 'inconsistent-sample' })
      return
    }
    expect(telemetry.unavailableReason).toBeNull()
    expect(telemetry.coreSamples).toHaveLength(expected)
    expect(telemetry.coreSamples?.map((sample) => sample.index)).toEqual(
      Array.from({ length: expected }, (_, index) => index)
    )
  }, 30_000)
})

function runPowerShell(scriptPath: string, scriptArguments: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('powershell.exe', [
      '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
      '-File', scriptPath, ...scriptArguments
    ], { windowsHide: true, encoding: 'utf8', timeout: 30_000, maxBuffer: 2 * 1024 * 1024 },
    (error, stdout, stderr) => {
      if (error) {
        reject(new Error(`CPU telemetry fixture failed: ${String(stderr).trim() || error.message}`))
        return
      }
      resolve(String(stdout).trim())
    })
  })
}

const cpuTelemetryHarness = String.raw`param(
    [Parameter(Mandatory = $true)][string]$TargetScript,
    [Parameter(Mandatory = $true)][int]$ExpectedLogicalProcessors,
    [Parameter(Mandatory = $true)][int]$VisibleLogicalProcessors,
    [Parameter(Mandatory = $true)][ValidateSet(0, 1)][int]$UseProcessorGroups
)

$ErrorActionPreference = 'Stop'
$tokens = $null
$parseErrors = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile(
    $TargetScript,
    [ref]$tokens,
    [ref]$parseErrors
)
if ($parseErrors.Count -gt 0) {
    throw "Target collector failed to parse: $($parseErrors[0].Message)"
}
$definition = $ast.Find({
    param($node)
    $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and
        $node.Name -eq 'Get-HostCpuTelemetry'
}, $true)
if ($null -eq $definition) {
    throw 'Get-HostCpuTelemetry was not found in the target collector.'
}
Invoke-Expression $definition.Extent.Text

$script:CpuFixtureInstances = @(
    for ($index = 0; $index -lt $VisibleLogicalProcessors; $index++) {
        $name = if ($UseProcessorGroups -eq 1) {
            '{0},{1}' -f [math]::Floor($index / 64), ($index % 64)
        } else {
            [string]$index
        }
        [pscustomobject]@{
            Name = $name
            PercentProcessorTime = [double]($index % 101)
        }
    }
    [pscustomobject]@{ Name = '_Total'; PercentProcessorTime = [double]42 }
)

function Get-CimInstance {
    [CmdletBinding()]
    param([Parameter(Mandatory = $true)][string]$ClassName)

    if ($ClassName -ne 'Win32_PerfFormattedData_PerfOS_Processor') {
        throw "Unexpected CIM class in CPU fixture: $ClassName"
    }
    return $script:CpuFixtureInstances
}

Get-HostCpuTelemetry -ExpectedLogicalProcessors $ExpectedLogicalProcessors |
    ConvertTo-Json -Depth 5 -Compress
`
