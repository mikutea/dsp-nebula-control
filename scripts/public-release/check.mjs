#!/usr/bin/env node
import { writeFile } from 'node:fs/promises'
import path from 'node:path'
import { canonicalEvidenceJson, runPublicReleaseScan } from './scanner.mjs'

const parsed = parseArguments(process.argv.slice(2))
if (parsed.help) {
  process.stdout.write([
    'Usage: node scripts/public-release/check.mjs [--history] [--artifact <directory>] [--evidence <file>]',
    '',
    'The repository root is fixed from this script location. Evidence never contains its host path.',
    ''
  ].join('\n'))
  process.exitCode = 0
} else if (parsed.error) {
  process.stdout.write(`${JSON.stringify({
    protocol: 'DYSON_PUBLIC_RELEASE_HYGIENE_V1',
    passed: false,
    findings: [{ ruleId: 'UNSAFE_CANDIDATE_PATH' }]
  }, null, 2)}\n`)
  process.exitCode = 2
} else {
  try {
    const repositoryRoot = path.resolve(import.meta.dirname, '..', '..')
    const evidence = await runPublicReleaseScan({
      repositoryRoot,
      history: parsed.history,
      artifactPath: parsed.artifact
    })
    const json = canonicalEvidenceJson(evidence)
    if (parsed.evidence !== null) await writeFile(path.resolve(parsed.evidence), json, { encoding: 'utf8', flag: 'wx' })
    process.stdout.write(json)
    process.exitCode = evidence.passed ? 0 : 1
  } catch {
    process.stdout.write(`${JSON.stringify({
      protocol: 'DYSON_PUBLIC_RELEASE_HYGIENE_V1',
      passed: false,
      findings: [{ ruleId: 'SCAN_IO_FAILURE' }]
    }, null, 2)}\n`)
    process.exitCode = 2
  }
}

function parseArguments(args) {
  const result = { history: false, artifact: null, evidence: null, help: false, error: false }
  for (let index = 0; index < args.length; index++) {
    const argument = args[index]
    if (argument === '--history') result.history = true
    else if (argument === '--artifact' && args[index + 1] !== undefined) result.artifact = args[++index]
    else if (argument === '--evidence' && args[index + 1] !== undefined) result.evidence = args[++index]
    else if (argument === '--help' || argument === '-h') result.help = true
    else result.error = true
  }
  return result
}
