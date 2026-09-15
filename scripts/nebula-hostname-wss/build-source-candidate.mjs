#!/usr/bin/env node

import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  buildSourceCandidate,
  NebulaHostnameWssError
} from './lib.mjs'

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')

try {
  const args = parseArgs(process.argv.slice(2))
  const result = await buildSourceCandidate({
    repositoryRoot,
    sourceRoot: args.sourceRoot,
    outputRoot: args.outputRoot
  })
  process.stdout.write(`${JSON.stringify({
    format: 'dyson-control-nebula-source-candidate-build-result',
    schemaVersion: 2,
    status: 'built-and-verified',
    candidateId: result.manifest.candidateId,
    upstreamCommit: result.manifest.upstream.commit,
    manifestSha256: result.manifestSha256,
    sources: result.manifest.patch.sources.length,
    sourceOnly: true,
    privateBuildRequired: true
  })}\n`)
} catch (error) {
  const code = error instanceof NebulaHostnameWssError ? error.code : 'NEBULA_SOURCE_CANDIDATE_BUILD_FAILED'
  process.stderr.write(`${code}\n`)
  process.exitCode = 1
}

function parseArgs(argv) {
  const values = new Map()
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index]
    const value = argv[index + 1]
    if (!['--source-root', '--output-root'].includes(name) || value === undefined || values.has(name)) {
      throw new NebulaHostnameWssError('ARGUMENTS_INVALID')
    }
    values.set(name, value)
  }
  if (values.size !== 2) throw new NebulaHostnameWssError('ARGUMENTS_INVALID')
  return { sourceRoot: values.get('--source-root'), outputRoot: values.get('--output-root') }
}
