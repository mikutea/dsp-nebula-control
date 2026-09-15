#!/usr/bin/env node

import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  NebulaHostnameWssError,
  readRepositoryContract,
  verifyRepositoryContract,
  verifySourceCandidate
} from './lib.mjs'

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')

try {
  const candidateRoot = parseArgs(process.argv.slice(2))
  const loaded = await readRepositoryContract(repositoryRoot)
  const verified = await verifyRepositoryContract(repositoryRoot, loaded)
  const result = await verifySourceCandidate(candidateRoot, {
    contract: verified.contract,
    contractRaw: verified.raw,
    patch: verified.patch
  })
  process.stdout.write(`${JSON.stringify({
    format: 'dyson-control-nebula-source-candidate-verification-result',
    schemaVersion: 2,
    status: 'verified',
    candidateId: result.manifest.candidateId,
    upstreamCommit: result.manifest.upstream.commit,
    manifestSha256: result.manifestSha256,
    files: result.files.length,
    sources: result.manifest.patch.sources.length,
    sourceOnly: true,
    privateBuildRequired: true
  })}\n`)
} catch (error) {
  const code = error instanceof NebulaHostnameWssError ? error.code : 'NEBULA_SOURCE_CANDIDATE_VERIFY_FAILED'
  process.stderr.write(`${code}\n`)
  process.exitCode = 1
}

function parseArgs(argv) {
  if (argv.length !== 2 || argv[0] !== '--candidate-root') {
    throw new NebulaHostnameWssError('ARGUMENTS_INVALID')
  }
  return argv[1]
}
