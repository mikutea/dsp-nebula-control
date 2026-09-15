import { spawn } from 'node:child_process'
import fs from 'node:fs/promises'
import path from 'node:path'

const repositoryRoot = path.resolve(import.meta.dirname, '..')
const scriptsRoot = path.join(repositoryRoot, 'scripts', 'windows')
const scriptNames = await findPowerShellScripts(scriptsRoot)

if (scriptNames.length === 0) throw new Error('No Windows PowerShell scripts were found')

for (const scriptName of scriptNames) {
  const scriptPath = path.join(scriptsRoot, ...scriptName.split('/'))
  const encodedPath = Buffer.from(scriptPath, 'utf16le').toString('base64')
  const command = [
    `$path = [System.Text.Encoding]::Unicode.GetString([Convert]::FromBase64String('${encodedPath}'))`,
    '$tokens = $null',
    '$errors = $null',
    '[void][System.Management.Automation.Language.Parser]::ParseFile($path, [ref]$tokens, [ref]$errors)',
    'if ($errors.Count -gt 0) { $errors | ForEach-Object { [Console]::Error.WriteLine($_.Message) }; exit 1 }'
  ].join('; ')
  await runPowerShell(command, scriptName)
}

console.log(`PowerShell syntax valid: ${scriptNames.length} scripts.`)

async function findPowerShellScripts(root) {
  const scripts = []
  const pending = [{ absolute: root, relative: '' }]
  while (pending.length > 0) {
    const current = pending.pop()
    const entries = await fs.readdir(current.absolute, { withFileTypes: true })
    for (const entry of entries) {
      const relative = current.relative ? `${current.relative}/${entry.name}` : entry.name
      if (entry.isDirectory()) {
        pending.push({ absolute: path.join(current.absolute, entry.name), relative })
      } else if (entry.isFile() && entry.name.endsWith('.ps1')) {
        scripts.push(relative)
      }
    }
  }
  return scripts.sort((left, right) => left.localeCompare(right))
}

function runPowerShell(command, scriptName) {
  return new Promise((resolve, reject) => {
    const child = spawn('powershell.exe', [
      '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', command
    ], { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] })
    let errorOutput = ''
    child.stderr.setEncoding('utf8').on('data', (chunk) => { errorOutput += chunk })
    child.once('error', reject)
    child.once('exit', (code) => {
      if (code === 0) resolve()
      else reject(new Error(`${scriptName}: ${errorOutput.trim() || `parser exited with ${code}`}`))
    })
  })
}
