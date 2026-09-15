import { expect, it } from 'vitest'
import type { HostMutationOperationScope } from '../host-mutation/operation-coordinator.js'
import { moveCleanupObject, type CleanupMovePorts, type CleanupObjectEvidence } from './recoverable-cleanup-move.js'
const candidate = { kind: 'history' as const, opaqueId: '11111111-1111-4111-8111-111111111111', sha256: 'a'.repeat(64), sizeBytes: 256 }
const scope: HostMutationOperationScope = { signal: new AbortController().signal, assertActive() {}, toPowerShellBorrowArguments: () => [] }
function fixture(source: CleanupObjectEvidence | null = candidate, quarantine: CleanupObjectEvidence | null = null) {
  let moves = 0
  const ports: CleanupMovePorts = { inspect: async (_candidate, side) => side === 'source' ? source : quarantine,
    move: async (_candidate, direction) => { moves++
      if (direction === 'quarantine') { quarantine = source; source = null }
      else { source = quarantine; quarantine = null }
    } }
  return { ports, moves: () => moves }
}
it('quarantines, replays and restores without repeating a completed move', async () => {
  const f = fixture()
  expect(await moveCleanupObject(candidate, 'quarantine', f.ports, scope)).toEqual({ reused: false })
  expect(await moveCleanupObject(candidate, 'quarantine', f.ports, scope)).toEqual({ reused: true })
  expect(await moveCleanupObject(candidate, 'restore', f.ports, scope)).toEqual({ reused: false })
  expect(await moveCleanupObject(candidate, 'restore', f.ports, scope)).toEqual({ reused: true })
  expect(f.moves()).toBe(2)
})
it.each([[null, null], [candidate, candidate], [{ ...candidate, sha256: 'b'.repeat(64) }, null]])('rejects ambiguous or changed evidence', async (source, quarantine) => {
  const f = fixture(source, quarantine)
  await expect(moveCleanupObject(candidate, 'quarantine', f.ports, scope)).rejects.toThrow()
  expect(f.moves()).toBe(0)
})
it('resumes after rename succeeded but ownership was lost before readback', async () => {
  const f = fixture()
  const lost = new Error('lease lost')
  await expect(moveCleanupObject(candidate, 'quarantine', f.ports, { ...scope,
    assertActive() { if (f.moves() > 0) throw lost } })).rejects.toBe(lost)
  expect(await moveCleanupObject(candidate, 'quarantine', f.ports, scope)).toEqual({ reused: true })
  expect(f.moves()).toBe(1)
})
it('does not acknowledge a move whose destination was not established', async () => {
  const f = fixture()
  await expect(moveCleanupObject(candidate, 'quarantine', { ...f.ports, move: async () => {} }, scope))
    .rejects.toThrow('UPDATE_CLEANUP_MOVE_UNPROVEN')
})
