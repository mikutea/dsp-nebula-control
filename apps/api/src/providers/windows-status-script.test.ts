import { execFile } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { expect, it } from 'vitest'

const run = promisify(execFile)

it.skipIf(process.platform !== 'win32')('resolves drive and UNC mapping health without matching adjacent shares or hiding ambiguity', async () => {
  const temporary = await mkdtemp(path.join(tmpdir(), 'dyson-status-mapping-'))
  const source = path.resolve(import.meta.dirname, '../../../../scripts/windows/Get-DysonStatus.ps1')
  const fixture = path.join(temporary, 'fixture.ps1')
  try {
    await writeFile(fixture, `
param([string]$Source)
$ErrorActionPreference='Stop'
$tokens=$null;$errors=$null
$ast=[Management.Automation.Language.Parser]::ParseFile($Source,[ref]$tokens,[ref]$errors)
if($errors.Count){throw 'SOURCE_PARSE_FAILED'}
$definition=@($ast.FindAll({param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -ceq 'Get-DysonProjectGlobalMappingAvailability'},$true))
if($definition.Count -ne 1){throw 'FUNCTION_BINDING_INVALID'}
Invoke-Expression $definition[0].Extent.Text
function Get-SmbGlobalMapping {
 [CmdletBinding()]param([string]$LocalPath)
 if($script:queryFails){throw 'FIXTURE_QUERY_DENIED'}
 $script:entries|Where-Object { !$LocalPath -or $_.LocalPath -ieq $LocalPath }
}
$script:queryFails=$false
$script:entries=@([pscustomobject]@{LocalPath='Y:';RemotePath='\\\\files.example.com\\share';Status='OK'})
$results=@()
$results+=Get-DysonProjectGlobalMappingAvailability -Root 'Y:\\Projects\\Game'
$results+=Get-DysonProjectGlobalMappingAvailability -Root '\\\\FILES.EXAMPLE.COM\\SHARE\\Projects\\Game'
$results+=Get-DysonProjectGlobalMappingAvailability -Root '\\\\files.example.com\\share\\'
$results+=Get-DysonProjectGlobalMappingAvailability -Root '\\\\files.example.com\\share-other\\Game'
$script:entries[0].Status='Unavailable'
$results+=Get-DysonProjectGlobalMappingAvailability -Root '\\\\files.example.com\\share\\Game'
$script:entries+= [pscustomobject]@{LocalPath='Z:';RemotePath='\\\\files.example.com\\share';Status='OK'}
$results+=Get-DysonProjectGlobalMappingAvailability -Root '\\\\files.example.com\\share\\Game'
$script:entries=@()
$results+=Get-DysonProjectGlobalMappingAvailability -Root 'Y:\\Projects\\Game'
$script:queryFails=$true
$results+=Get-DysonProjectGlobalMappingAvailability -Root '\\\\files.example.com\\share\\Game'
ConvertTo-Json -InputObject $results -Compress
`)
    const result = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', fixture, '-Source', source], { timeout: 15_000 })
    expect(JSON.parse(result.stdout.trim())).toEqual([true, true, true, null, false, null, null, null])
  } finally {
    await rm(temporary, { recursive: true, force: true })
  }
}, 20_000)
