import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { ObservabilityError } from './errors.js'
import {
  BoundedObservabilityLongWindow,
  OBSERVABILITY_72H_MINIMUM_SAMPLES,
  buildObservabilityLongWindowSample,
  evaluateObservabilityLongWindow,
  parseObservabilityLongWindowSample
} from './long-window.js'
import { buildServerObservabilitySnapshot } from './snapshot.js'

const baseTime = Date.parse('2026-08-30T00:00:00.000Z')

describe('72-hour slim observability chain', () => {
  it('retains and qualifies the complete 17,281-sample 72-hour window', () => {
    const window = new BoundedObservabilityLongWindow(OBSERVABILITY_72H_MINIMUM_SAMPLES)
    for (let index = 0; index < OBSERVABILITY_72H_MINIMUM_SAMPLES; index++) {
      const prepared = window.prepare(snapshot(index))
      window.ingest(prepared)
    }

    expect(window.size).toBe(17_281)
    expect(window.report()).toMatchObject({
      result: 'pass',
      sampleCount: 17_281,
      spanMs: 72 * 60 * 60 * 1_000
    })
  }, 60_000)

  it('fails a gap, an SMB interruption, and an unhealthy storage task without weakening non-SMB hosts', () => {
    const healthyNone = buildChain([
      snapshot(0, { storageDependencyKind: 'none' }),
      snapshot(1, { storageDependencyKind: 'none' }),
      snapshot(2, { storageDependencyKind: 'none' })
    ])
    expect(evaluateObservabilityLongWindow(healthyNone, 30_000, 3, 15_000).result).toBe('pass')

    const gap = buildChain([
      snapshot(0), snapshot(1), snapshot(3)
    ])
    expect(check(evaluateObservabilityLongWindow(gap, 30_000, 3, 15_000), 'window.maximum-gap')).toMatchObject({
      status: 'fail'
    })

    const interrupted = buildChain([
      snapshot(0),
      snapshot(1, { globalMappingAvailable: false }),
      snapshot(2, { storageTaskLastResult: 1312 })
    ])
    const report = evaluateObservabilityLongWindow(interrupted, 30_000, 3, 15_000)
    expect(check(report, 'storage.smb-mapping-available')).toMatchObject({ status: 'fail' })
    expect(check(report, 'storage.recovery-task-healthy')).toMatchObject({ status: 'fail' })
  })

  it('rejects duplicate/backward time, payload tampering, and chain splicing', () => {
    const chain = new BoundedObservabilityLongWindow(4)
    chain.ingest(chain.prepare(snapshot(1)))
    expect(() => chain.prepare(snapshot(1))).toThrowError(
      expect.objectContaining<Partial<ObservabilityError>>({
        code: 'OBSERVABILITY_LONG_WINDOW_TIME_NOT_INCREASING'
      })
    )
    expect(() => chain.prepare(snapshot(0))).toThrowError(
      expect.objectContaining<Partial<ObservabilityError>>({
        code: 'OBSERVABILITY_LONG_WINDOW_TIME_NOT_INCREASING'
      })
    )

    const second = chain.prepare(snapshot(2))
    expect(() => chain.ingest({
      ...second,
      performance: { ...second.performance, ups: 1 }
    })).toThrowError(expect.objectContaining<Partial<ObservabilityError>>({
      code: 'OBSERVABILITY_LONG_WINDOW_DIGEST_MISMATCH'
    }))

    const unrelated = buildObservabilityLongWindowSample(snapshot(2), 'f'.repeat(64))
    expect(() => chain.ingest(unrelated)).toThrowError(
      expect.objectContaining<Partial<ObservabilityError>>({
        code: 'OBSERVABILITY_LONG_WINDOW_CHAIN_MISMATCH'
      })
    )
  })

  it('binds identity to process start time and keeps legacy samples insufficient', () => {
    const restarted = buildChain([
      snapshot(0),
      snapshot(1),
      snapshot(2, { processStartedAt: '2026-08-30T00:00:01.000Z' })
    ])
    expect(check(
      evaluateObservabilityLongWindow(restarted, 30_000, 3, 15_000),
      'runtime.identity-stable'
    )).toMatchObject({ status: 'fail' })

    const current = buildObservabilityLongWindowSample(snapshot(0), null)
    const { processStartedAt: _legacyMissingField, ...legacyRuntime } = current.runtime
    const { sampleSha256: _currentDigest, ...currentUnsigned } = current
    const legacyUnsigned = { ...currentUnsigned, runtime: legacyRuntime }
    const legacy = {
      ...legacyUnsigned,
      sampleSha256: createHash('sha256').update(JSON.stringify(legacyUnsigned), 'utf8').digest('hex')
    }
    expect(() => parseObservabilityLongWindowSample(legacy)).not.toThrow()
    expect(check(
      evaluateObservabilityLongWindow([legacy], 15_000, 2, 15_000),
      'runtime.identity-stable'
    )).toMatchObject({ status: 'insufficient' })

    const missing = buildChain([
      snapshot(0, { omitProcessStartedAt: true }),
      snapshot(1, { omitProcessStartedAt: true })
    ])
    expect(check(
      evaluateObservabilityLongWindow(missing, 15_000, 2, 15_000),
      'runtime.identity-stable'
    )).toMatchObject({ status: 'insufficient' })
    expect(() => snapshot(0, { processStartedAt: 'not-a-time' })).toThrowError(
      expect.objectContaining<Partial<ObservabilityError>>({
        code: 'OBSERVABILITY_SAMPLE_INVALID'
      })
    )
  })

  it('prunes deterministically while retaining a verifiable chain suffix', () => {
    const window = new BoundedObservabilityLongWindow(2)
    for (let index = 0; index < 4; index++) window.ingest(window.prepare(snapshot(index)))
    expect(window.size).toBe(2)
    expect(window.droppedSamples).toBe(2)
    expect(window.list().map((sample) => sample.observedAt)).toEqual([
      observedAt(2), observedAt(3)
    ])
    expect(() => evaluateObservabilityLongWindow(window.list(), 15_000, 2, 15_000)).not.toThrow()
  })
})

function buildChain(snapshots: ReturnType<typeof snapshot>[]) {
  const result = []
  let predecessor: string | null = null
  for (const item of snapshots) {
    const record = buildObservabilityLongWindowSample(item, predecessor)
    result.push(record)
    predecessor = record.sampleSha256
  }
  return result
}

function check(report: ReturnType<typeof evaluateObservabilityLongWindow>, id: string) {
  return report.checks.find((entry) => entry.id === id)
}

function snapshot(index: number, options: {
  storageDependencyKind?: 'none' | 'smb-global-mapping'
  globalMappingAvailable?: boolean
  storageTaskLastResult?: number
  processStartedAt?: string
  omitProcessStartedAt?: boolean
} = {}) {
  const storageDependencyKind = options.storageDependencyKind ?? 'smb-global-mapping'
  return buildServerObservabilitySnapshot({
    schemaVersion: 1,
    observedAt: observedAt(index),
    source: 'dyson.windows-bridge-v1',
    runtime: {
      state: 'running',
      processId: 4242,
      ...(options.omitProcessStartedAt
        ? {}
        : { startedAt: options.processStartedAt ?? '2026-08-29T23:00:00.000Z' })
    },
    host: {
      cpu: {
        logicalProcessorCount: 2,
        totalPercent: 40,
        cores: [{ index: 0, percent: 60 }, { index: 1, percent: 40 }]
      },
      memory: { totalBytes: 64_000_000_000, availableBytes: 32_000_000_000 },
      storage: {
        projectVolume: { totalBytes: 512_000_000_000, availableBytes: 256_000_000_000 },
        saveVolume: { totalBytes: 512_000_000_000, availableBytes: 256_000_000_000 }
      },
      network: { receiveBytesPerSecond: 10_000, sendBytesPerSecond: 5_000, sampledInterfaceCount: 1 }
    },
    process: {
      cpuCoresUsed: 2, workingSetBytes: 8_000_000_000,
      privateBytes: 9_000_000_000, threadCount: 200
    },
    network: { gamePort: { port: 8469, listening: true } },
    simulation: { ups: 60, tps: 60, targetUps: 60 },
    automation: storageDependencyKind === 'none'
      ? { storageDependencyKind, projectRootAvailable: true }
      : {
          storageDependencyKind,
          projectRootAvailable: true,
          globalMappingAvailable: options.globalMappingAvailable ?? true,
          storageTask: { state: 'ready', lastResult: options.storageTaskLastResult ?? 0 }
        }
  })
}

function observedAt(index: number): string {
  return new Date(baseTime + index * 15_000).toISOString()
}
