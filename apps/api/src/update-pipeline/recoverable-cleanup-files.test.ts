import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { expect, it } from 'vitest'
import type { HostMutationOperationScope } from '../host-mutation/operation-coordinator.js'
import { FileCleanupMovePorts } from './recoverable-cleanup-files.js'
import { inspectCleanupObject } from './recoverable-cleanup-inventory.js'
import { moveCleanupObject } from './recoverable-cleanup-move.js'
const requestId = '11111111-1111-4111-8111-111111111111'
const scope: HostMutationOperationScope = { signal: new AbortController().signal, assertActive() {}, toPowerShellBorrowArguments: () => [] }
it.each(['history', 'release'] as const)('quarantines and restores real %s objects using only fixed roots', async kind => {
  const root = await mkdtemp(path.join(tmpdir(), 'cleanup-files-'))
  try {
    const opaqueId = kind === 'history' ? '22222222-2222-4222-8222-222222222222' : 'nebula-' + 'a'.repeat(32)
    const source = kind === 'history' ? path.join(root, 'history', opaqueId + '.json') : path.join(root, 'releases', 'nebula', opaqueId)
    await mkdir(kind === 'history' ? path.dirname(source) : source, { recursive: true })
    await writeFile(kind === 'history' ? source : path.join(source, 'component.bin'), 'fictional')
    const evidence = (await inspectCleanupObject(source))!
    const candidate = { kind, opaqueId, ...evidence }
    const ports = new FileCleanupMovePorts(root, requestId)
    expect(await moveCleanupObject(candidate, 'quarantine', ports, scope)).toEqual({ reused: false })
    expect(await ports.inspect(candidate, 'source')).toBeNull()
    expect(await moveCleanupObject(candidate, 'quarantine', new FileCleanupMovePorts(root, requestId), scope)).toEqual({ reused: true })
    expect(await moveCleanupObject(candidate, 'restore', ports, scope)).toEqual({ reused: false })
    expect(await readFile(kind === 'history' ? source : path.join(source, 'component.bin'), 'utf8')).toBe('fictional')
  } finally { await rm(root, { recursive: true, force: true }) }
})
it('preserves a newly occupied restore target and rejects path-shaped IDs', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'cleanup-conflict-'))
  try {
    const opaqueId = '22222222-2222-4222-8222-222222222222'
    const source = path.join(root, 'history', opaqueId + '.json')
    await mkdir(path.dirname(source))
    await writeFile(source, 'original')
    const candidate = { kind: 'history' as const, opaqueId, ...(await inspectCleanupObject(source))! }
    const ports = new FileCleanupMovePorts(root, requestId)
    await moveCleanupObject(candidate, 'quarantine', ports, scope)
    await writeFile(source, 'new user material')
    await expect(moveCleanupObject(candidate, 'restore', ports, scope)).rejects.toThrow()
    expect(await readFile(source, 'utf8')).toBe('new user material')
    expect(await ports.inspect(candidate, 'quarantine')).toMatchObject({ sha256: candidate.sha256 })
    await expect(ports.inspect({ ...candidate, opaqueId: '../outside' }, 'source')).rejects.toThrow()
  } finally { await rm(root, { recursive: true, force: true }) }
})
