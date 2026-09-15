import { describe, expect, it } from 'vitest'
import { buildServerObservabilitySnapshot } from './snapshot.js'
import {
  PersistentObservabilityAlerts,
  PersistentObservabilityAlertError,
  type ObservabilityAlertStateStore,
  type StoredObservabilityAlertState
} from './persistent-alerts.js'

const baseTime = Date.parse('2026-08-31T00:00:00.000Z')

describe('PersistentObservabilityAlerts', () => {
  it('persists before publishing and skips writes for an exact duplicate snapshot', () => {
    const store = new MemoryAlertStore()
    const alerts = persistent(store)
    const first = snapshot(0, 90)

    alerts.ingest(first)
    expect(alerts.revision).toBe(1)
    expect(store.writeCount).toBe(1)
    expect(alerts.project().episodes).toHaveLength(1)

    const before = alerts.project()
    expect(alerts.ingest(structuredClone(first))).toEqual(before)
    expect(alerts.revision).toBe(1)
    expect(store.writeCount).toBe(1)
  })

  it('hydrates the authoritative state and continues with compare-and-swap revisions', () => {
    const store = new MemoryAlertStore()
    const firstProcess = persistent(store, { resolveAfterMissingSamples: 1 })
    firstProcess.ingest(snapshot(0, 90))

    const restarted = persistent(store, { resolveAfterMissingSamples: 1 })
    expect(restarted.revision).toBe(1)
    expect(restarted.project()).toEqual(firstProcess.project())
    restarted.ingest(snapshot(1, 20))

    expect(restarted.revision).toBe(2)
    expect(restarted.project().episodes[0]).toMatchObject({
      status: 'resolved', resolvedAt: observedAt(1)
    })
  })

  it('persists acknowledgement separately and treats an exact replay as a no-op', () => {
    const store = new MemoryAlertStore()
    const alerts = persistent(store)
    alerts.ingest(snapshot(0, 90))
    const episodeId = alerts.list()[0]!.id
    const acknowledgement = { episodeId, actor: 'Operator', acknowledgedAt: observedAt(0) }

    alerts.acknowledge(acknowledgement)
    expect(alerts.revision).toBe(2)
    expect(store.writeCount).toBe(2)
    expect(alerts.acknowledge(acknowledgement).acknowledgement?.actor).toBe('Operator')
    expect(alerts.revision).toBe(2)
    expect(store.writeCount).toBe(2)
  })

  it('fails closed on stored-state corruption or configuration drift', () => {
    const invalidStore = new MemoryAlertStore({ revision: 1, payload: '{"invalid":true}' })
    expectPersistentCode(
      () => persistent(invalidStore),
      'OBSERVABILITY_ALERT_PERSISTENCE_STATE_INVALID'
    )

    const store = new MemoryAlertStore()
    persistent(store, { capacity: 4 }).ingest(snapshot(0, 90))
    expectPersistentCode(
      () => persistent(store, { capacity: 5 }),
      'OBSERVABILITY_ALERT_PERSISTENCE_CONFIGURATION_MISMATCH'
    )
  })

  it('does not publish an uncertain write and locks later mutations until restart', () => {
    const store = new MemoryAlertStore()
    const alerts = persistent(store)
    alerts.ingest(snapshot(0, 90))
    const before = alerts.project()
    store.throwAfterNextWrite = true

    expectPersistentCode(
      () => alerts.ingest(snapshot(1, 20)),
      'OBSERVABILITY_ALERT_PERSISTENCE_WRITE_UNCERTAIN'
    )
    expect(alerts.project()).toEqual(before)
    expect(alerts.recoveryRequired).toBe(true)
    expectPersistentCode(
      () => alerts.ingest(snapshot(2, 20)),
      'OBSERVABILITY_ALERT_PERSISTENCE_RECOVERY_REQUIRED'
    )

    const restarted = persistent(store)
    expect(restarted.project().observedThrough).toBe(observedAt(1))
    expect(restarted.recoveryRequired).toBe(false)
  })

  it('turns a concurrent writer conflict into a recovery-required instance', () => {
    const store = new MemoryAlertStore()
    const seed = persistent(store)
    seed.ingest(snapshot(0, 90))

    const first = persistent(store)
    const stale = persistent(store)
    first.ingest(snapshot(1, 90))
    expectPersistentCode(
      () => stale.ingest(snapshot(1, 20)),
      'OBSERVABILITY_ALERT_PERSISTENCE_WRITE_UNCERTAIN'
    )
    expect(stale.recoveryRequired).toBe(true)
  })

  it('rejects invalid store revisions and read failures without creating a machine', () => {
    const invalidRevisionStore: ObservabilityAlertStateStore = {
      read: () => ({ revision: 0, payload: '{}' }),
      write: () => 1
    }
    expectPersistentCode(
      () => persistent(invalidRevisionStore),
      'OBSERVABILITY_ALERT_PERSISTENCE_STATE_INVALID'
    )

    const failingStore: ObservabilityAlertStateStore = {
      read: () => { throw new Error('database offline') },
      write: () => 1
    }
    expectPersistentCode(
      () => persistent(failingStore),
      'OBSERVABILITY_ALERT_PERSISTENCE_READ_FAILED'
    )
  })
})

class MemoryAlertStore implements ObservabilityAlertStateStore {
  state: StoredObservabilityAlertState | null
  writeCount = 0
  throwAfterNextWrite = false

  constructor(initial: StoredObservabilityAlertState | null = null) {
    this.state = initial === null ? null : { ...initial }
  }

  read(): StoredObservabilityAlertState | null {
    return this.state === null ? null : { ...this.state }
  }

  write(expectedRevision: number | null, payload: string): number {
    if ((this.state?.revision ?? null) !== expectedRevision) throw new Error('revision conflict')
    const revision = (this.state?.revision ?? 0) + 1
    this.state = { revision, payload }
    this.writeCount++
    if (this.throwAfterNextWrite) {
      this.throwAfterNextWrite = false
      throw new Error('commit result uncertain')
    }
    return revision
  }
}

function persistent(
  store: ObservabilityAlertStateStore,
  options: { capacity?: number; resolveAfterMissingSamples?: number } = {}
): PersistentObservabilityAlerts {
  return new PersistentObservabilityAlerts({
    store,
    ...options,
    idFactory: ({ sequence, code }) => `episode-${sequence}-${code}`
  })
}

function snapshot(index: number, hostCpuPercent: number) {
  return buildServerObservabilitySnapshot({
    schemaVersion: 1,
    observedAt: observedAt(index),
    source: 'fixture.persistent-alerts',
    runtime: {
      state: 'running', processId: 4242, startedAt: '2026-08-30T11:00:00.000Z'
    },
    host: {
      cpu: {
        logicalProcessorCount: 2,
        totalPercent: hostCpuPercent,
        cores: [{ index: 0, percent: hostCpuPercent }, { index: 1, percent: 10 }]
      },
      memory: { totalBytes: 1_000_000, availableBytes: 500_000 },
      storage: {
        projectVolume: { totalBytes: 2_000_000, availableBytes: 1_000_000 },
        saveVolume: { totalBytes: 2_000_000, availableBytes: 1_000_000 }
      },
      network: {
        receiveBytesPerSecond: 10_000,
        sendBytesPerSecond: 5_000,
        sampledInterfaceCount: 2
      }
    },
    process: {
      cpuPercent: 20,
      cpuCoresUsed: 0.4,
      workingSetBytes: 250_000,
      privateBytes: 300_000,
      threadCount: 200
    },
    network: { gamePort: { port: 8469, listening: true } },
    simulation: { ups: 60, tps: 60, targetUps: 60 },
    automation: { storageDependencyKind: 'none', projectRootAvailable: true }
  })
}

function observedAt(index: number): string {
  return new Date(baseTime + index * 1_000).toISOString()
}

function expectPersistentCode(
  action: () => unknown,
  code: PersistentObservabilityAlertError['code']
): void {
  try {
    action()
    throw new Error(`expected ${code}`)
  } catch (error) {
    expect(error).toBeInstanceOf(PersistentObservabilityAlertError)
    expect((error as PersistentObservabilityAlertError).code).toBe(code)
  }
}
