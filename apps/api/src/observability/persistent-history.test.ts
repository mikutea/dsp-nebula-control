import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ControlDatabase } from '../storage/database.js'
import { ObservabilityError } from './errors.js'
import { PersistentObservabilityHistory } from './persistent-history.js'
import { buildServerObservabilitySnapshot } from './snapshot.js'

const temporaryDirectories: string[] = []
const baseTime = Date.parse('2026-08-30T00:00:00.000Z')

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

describe('persistent observability history', () => {
  it('survives a control-plane restart and retains only the configured bounded window', () => {
    const directory = temporaryDirectory()
    const firstDatabase = new ControlDatabase(directory)
    const first = new PersistentObservabilityHistory(firstDatabase, 2)
    first.ingest(snapshot(0, 10))
    first.ingest(snapshot(1, 20))
    first.ingest(snapshot(2, 30))
    expect(first.size).toBe(2)
    expect(first.latest()?.observedAt).toBe(observedAt(2))
    firstDatabase.close()

    const reopenedDatabase = new ControlDatabase(directory)
    const reopened = new PersistentObservabilityHistory(reopenedDatabase, 2)
    expect(reopened.size).toBe(2)
    expect(reopened.latest()?.observedAt).toBe(observedAt(2))
    const history = reopened.downsample(2)
    expect(history.points.map((point) => point.from)).toEqual([observedAt(1), observedAt(2)])
    reopenedDatabase.close()
  })

  it('does not persist a time-regressing sample', () => {
    const directory = temporaryDirectory()
    const database = new ControlDatabase(directory)
    const history = new PersistentObservabilityHistory(database, 4)
    history.ingest(snapshot(2, 30))
    expect(() => history.ingest(snapshot(1, 20))).toThrowError(
      expect.objectContaining({ code: 'OBSERVABILITY_HISTORY_TIME_REGRESSION' })
    )
    database.close()

    const reopenedDatabase = new ControlDatabase(directory)
    const reopened = new PersistentObservabilityHistory(reopenedDatabase, 4)
    expect(reopened.size).toBe(1)
    expect(reopened.latest()?.observedAt).toBe(observedAt(2))
    reopenedDatabase.close()
  })

  it('fails closed when persisted history is malformed', () => {
    const directory = temporaryDirectory()
    const database = new ControlDatabase(directory)
    database.close()
    const raw = new DatabaseSync(path.join(directory, 'control.db'))
    raw.prepare(
      'INSERT INTO observability_samples(observed_at, payload_json) VALUES (?, ?)'
    ).run(observedAt(0), '{"not":"a snapshot"}')
    raw.close()

    const reopened = new ControlDatabase(directory)
    try {
      expect(() => new PersistentObservabilityHistory(reopened, 4)).toThrowError(
        expect.objectContaining<Partial<ObservabilityError>>({ code: 'OBSERVABILITY_PERSISTENCE_INVALID' })
      )
    } finally {
      reopened.close()
    }
  })
})

function temporaryDirectory(): string {
  const directory = mkdtempSync(path.join(tmpdir(), 'dyson-observability-persistence-'))
  temporaryDirectories.push(directory)
  return directory
}

function snapshot(index: number, cpuPercent: number) {
  return buildServerObservabilitySnapshot({
    schemaVersion: 1,
    observedAt: observedAt(index),
    source: 'fixture.persistence',
    runtime: { state: 'running', processId: 4242 },
    host: {
      cpu: {
        logicalProcessorCount: 2,
        totalPercent: cpuPercent,
        cores: [{ index: 0, percent: cpuPercent }, { index: 1, percent: cpuPercent / 2 }]
      },
      memory: { totalBytes: 1_000_000, availableBytes: 500_000 },
      storage: {
        projectVolume: { totalBytes: 2_000_000, availableBytes: 1_000_000 },
        saveVolume: { totalBytes: 2_000_000, availableBytes: 1_000_000 }
      },
      network: { receiveBytesPerSecond: 10_000, sendBytesPerSecond: 5_000, sampledInterfaceCount: 2 }
    },
    process: {
      cpuPercent,
      cpuCoresUsed: 1,
      workingSetBytes: 250_000,
      privateBytes: 300_000,
      threadCount: 200
    },
    network: { gamePort: { port: 8469, listening: true } },
    simulation: { ups: 60, tps: 60, targetUps: 60 }
  })
}

function observedAt(index: number): string {
  return new Date(baseTime + index * 1_000).toISOString()
}
