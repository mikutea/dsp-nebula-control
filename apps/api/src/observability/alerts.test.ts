import { describe, expect, it } from 'vitest'
import {
  ObservabilityAlertEpisodeStateMachine,
  ObservabilityAlertError,
  hydrateObservabilityAlertStateMachine,
  type ObservabilityAlertErrorCode
} from './alerts.js'
import { buildServerObservabilitySnapshot } from './snapshot.js'
import type { ObservabilityHintCode } from './types.js'

const baseTime = Date.parse('2026-08-31T00:00:00.000Z')

describe('observability alert episode state machine', () => {
  it('persists incomplete running identity together with unavailable storage evidence', () => {
    const alerts = stateMachine()
    alerts.ingest(snapshot(0))
    alerts.ingest(snapshot(1, { missingStartedAt: true, missingProjectRoot: true }))
    expect(getEpisode(alerts, 'OBSERVABILITY_INCOMPLETE').status).toBe('open')
    const restored = ObservabilityAlertEpisodeStateMachine.hydrate(alerts.serializeJson())
    restored.ingest(snapshot(2, { missingStartedAt: true, missingProjectRoot: true }))
    expect(getEpisode(restored, 'OBSERVABILITY_INCOMPLETE').observationCount).toBe(2)
    const legacy = alerts.serialize()
    const incomplete = legacy.episodes.find((episode) => episode.code === 'OBSERVABILITY_INCOMPLETE')!
    expect(incomplete.relatedMetrics).toEqual(['automation.projectRootAvailable', 'runtime.startedAt'])
    incomplete.relatedMetrics.reverse()
    expect(ObservabilityAlertEpisodeStateMachine.hydrate(legacy).project()).toEqual(alerts.project())
    incomplete.relatedMetrics.push('host.cpu.totalPercent')
    expectAlertCode(() => ObservabilityAlertEpisodeStateMachine.hydrate(legacy), 'OBSERVABILITY_ALERT_STATE_INVALID')
    incomplete.relatedMetrics = ['runtime.startedAt', 'runtime.startedAt']
    expectAlertCode(() => ObservabilityAlertEpisodeStateMachine.hydrate(legacy), 'OBSERVABILITY_ALERT_STATE_INVALID')
  })

  it('opens once, updates repeat observations, and retains severity-change history', () => {
    const alerts = stateMachine()

    alerts.ingest(snapshot(0, { processWorkingSetBytes: 800_000 }))
    const opened = getEpisode(alerts, 'PROCESS_MEMORY_DOMINANT')
    expect(opened).toMatchObject({
      id: 'episode-1-PROCESS_MEMORY_DOMINANT',
      status: 'open',
      currentSeverity: 'warning',
      openedAt: observedAt(0),
      lastSeenAt: observedAt(0),
      observationCount: 1,
      consecutiveMissingSamples: 0,
      acknowledgement: null,
      resolvedAt: null
    })
    expect(opened.severityHistory).toEqual([
      { severity: 'warning', changedAt: observedAt(0) }
    ])

    alerts.ingest(snapshot(1, { processWorkingSetBytes: 950_000 }))
    alerts.ingest(snapshot(2, { processWorkingSetBytes: 950_000 }))
    const repeated = getEpisode(alerts, 'PROCESS_MEMORY_DOMINANT')
    expect(repeated.id).toBe(opened.id)
    expect(repeated).toMatchObject({
      currentSeverity: 'critical',
      lastSeenAt: observedAt(2),
      observationCount: 3,
      consecutiveMissingSamples: 0
    })
    expect(repeated.severityHistory).toEqual([
      { severity: 'warning', changedAt: observedAt(0) },
      { severity: 'critical', changedAt: observedAt(1) }
    ])
    expect(alerts.list().filter((episode) => episode.code === 'PROCESS_MEMORY_DOMINANT')).toHaveLength(1)
  })

  it('keeps acknowledgement separate from automatic resolution', () => {
    const alerts = stateMachine({ resolveAfterMissingSamples: 1 })
    alerts.ingest(snapshot(0, { hostCpuPercent: 90 }))
    const episodeId = getEpisode(alerts, 'HOST_CPU_PRESSURE').id
    const acknowledgement = {
      episodeId,
      actor: 'oncall.ops',
      acknowledgedAt: observedAt(0)
    }

    expect(alerts.acknowledge(acknowledgement)).toMatchObject({
      id: episodeId,
      status: 'open',
      acknowledgement: { actor: 'oncall.ops', acknowledgedAt: observedAt(0) },
      resolvedAt: null
    })
    const afterAcknowledgement = alerts.serialize()
    expect(alerts.acknowledge(acknowledgement)).toEqual(getEpisode(alerts, 'HOST_CPU_PRESSURE'))
    expect(alerts.serialize()).toEqual(afterAcknowledgement)
    expectAlertCode(
      () => alerts.acknowledge({ ...acknowledgement, actor: 'different.operator' }),
      'OBSERVABILITY_ALERT_ACKNOWLEDGEMENT_CONFLICT'
    )

    alerts.ingest(snapshot(1))
    expect(getEpisode(alerts, 'HOST_CPU_PRESSURE')).toMatchObject({
      status: 'resolved',
      acknowledgement: { actor: 'oncall.ops', acknowledgedAt: observedAt(0) },
      resolvedAt: observedAt(1)
    })

    const unacknowledged = stateMachine({ resolveAfterMissingSamples: 1 })
    unacknowledged.ingest(snapshot(0, { hostCpuPercent: 90 }))
    const unacknowledgedId = getEpisode(unacknowledged, 'HOST_CPU_PRESSURE').id
    unacknowledged.ingest(snapshot(1))
    expectAlertCode(
      () => unacknowledged.acknowledge({
        episodeId: unacknowledgedId,
        actor: 'oncall.ops',
        acknowledgedAt: observedAt(1)
      }),
      'OBSERVABILITY_ALERT_EPISODE_RESOLVED'
    )
  })

  it('debounces recovery, resets the absence run on repeats, and gives recurrence a new ID', () => {
    const alerts = stateMachine({ resolveAfterMissingSamples: 2 })
    alerts.ingest(snapshot(0, { ups: 40 }))
    const firstId = getEpisode(alerts, 'SIMULATION_BELOW_TARGET').id

    alerts.ingest(snapshot(1))
    expect(getEpisode(alerts, 'SIMULATION_BELOW_TARGET')).toMatchObject({
      status: 'open', consecutiveMissingSamples: 1, observationCount: 1
    })

    alerts.ingest(snapshot(2, { ups: 40 }))
    expect(getEpisode(alerts, 'SIMULATION_BELOW_TARGET')).toMatchObject({
      status: 'open', consecutiveMissingSamples: 0, observationCount: 2, lastSeenAt: observedAt(2)
    })

    alerts.ingest(snapshot(3))
    alerts.ingest(snapshot(4))
    expect(getEpisode(alerts, 'SIMULATION_BELOW_TARGET')).toMatchObject({
      id: firstId,
      status: 'resolved',
      consecutiveMissingSamples: 2,
      resolvedAt: observedAt(4)
    })

    alerts.ingest(snapshot(5, { ups: 40 }))
    const episodes = alerts.list().filter((episode) => episode.code === 'SIMULATION_BELOW_TARGET')
    expect(episodes).toHaveLength(2)
    expect(episodes.map((episode) => episode.id)).toEqual([
      firstId,
      'episode-2-SIMULATION_BELOW_TARGET'
    ])
    expect(episodes.map((episode) => episode.status)).toEqual(['resolved', 'open'])
  })

  it('does not use unknown or incomplete telemetry as recovery evidence', () => {
    const alerts = stateMachine({ resolveAfterMissingSamples: 2 })
    alerts.ingest(snapshot(0, { hostCpuPercent: 90 }))

    alerts.ingest(snapshot(1, { hostCpuPercent: null }))
    alerts.ingest(snapshot(2, { hostCpuPercent: null }))
    expect(getEpisode(alerts, 'HOST_CPU_PRESSURE')).toMatchObject({
      status: 'open',
      lastSeenAt: observedAt(0),
      observationCount: 1,
      consecutiveMissingSamples: 0
    })
    expect(getEpisode(alerts, 'OBSERVABILITY_INCOMPLETE').status).toBe('open')

    alerts.ingest(snapshot(3))
    expect(getEpisode(alerts, 'HOST_CPU_PRESSURE')).toMatchObject({
      status: 'open', consecutiveMissingSamples: 1
    })
    alerts.ingest(snapshot(4))
    expect(getEpisode(alerts, 'HOST_CPU_PRESSURE')).toMatchObject({
      status: 'resolved', consecutiveMissingSamples: 2, resolvedAt: observedAt(4)
    })

    const volumeAlerts = stateMachine({ resolveAfterMissingSamples: 2 })
    volumeAlerts.ingest(snapshot(0, { saveVolumeAvailableBytes: 300_000 }))
    volumeAlerts.ingest(snapshot(1, { saveVolumeUnavailable: true }))
    volumeAlerts.ingest(snapshot(2, { saveVolumeUnavailable: true }))
    expect(getEpisode(volumeAlerts, 'SAVE_VOLUME_PRESSURE')).toMatchObject({
      status: 'open', consecutiveMissingSamples: 0, lastSeenAt: observedAt(0)
    })
    volumeAlerts.ingest(snapshot(3))
    volumeAlerts.ingest(snapshot(4))
    expect(getEpisode(volumeAlerts, 'SAVE_VOLUME_PRESSURE')).toMatchObject({
      status: 'resolved', consecutiveMissingSamples: 2, resolvedAt: observedAt(4)
    })
  })

  it('is idempotent for exact duplicates and fails closed on timestamp conflict or regression', () => {
    let idFactoryCalls = 0
    const alerts = new ObservabilityAlertEpisodeStateMachine({
      idFactory: ({ sequence, code }) => {
        idFactoryCalls++
        return `episode-${sequence}-${code}`
      }
    })
    const first = snapshot(0, { hostCpuPercent: 90 })
    alerts.ingest(first)
    const beforeDuplicate = alerts.serialize()

    expect(alerts.ingest(structuredClone(first))).toEqual(alerts.project())
    expect(alerts.serialize()).toEqual(beforeDuplicate)
    expect(idFactoryCalls).toBe(1)

    expectAlertCode(
      () => alerts.ingest(snapshot(0, { hostCpuPercent: 91 })),
      'OBSERVABILITY_ALERT_TIMESTAMP_CONFLICT'
    )
    expect(alerts.serialize()).toEqual(beforeDuplicate)
    expectAlertCode(
      () => alerts.ingest(snapshot(-1, { hostCpuPercent: 90 })),
      'OBSERVABILITY_ALERT_TIME_REGRESSION'
    )
    expect(alerts.serialize()).toEqual(beforeDuplicate)
  })

  it('prunes only resolved episodes and permits open episodes to exceed the soft capacity', () => {
    const overCapacity = stateMachine({ capacity: 1 })
    overCapacity.ingest(snapshot(0, { hostCpuPercent: 90, memoryAvailableBytes: 100_000 }))
    expect(overCapacity.size).toBe(2)
    expect(overCapacity.list().every((episode) => episode.status === 'open')).toBe(true)

    const alerts = stateMachine({ capacity: 2, resolveAfterMissingSamples: 2 })
    alerts.ingest(snapshot(0, { hostCpuPercent: 90 }))
    alerts.ingest(snapshot(1))
    alerts.ingest(snapshot(2, { memoryAvailableBytes: 100_000 }))
    expect(getEpisode(alerts, 'HOST_CPU_PRESSURE').status).toBe('resolved')

    alerts.ingest(snapshot(3, {
      memoryAvailableBytes: 100_000,
      saveVolumeAvailableBytes: 300_000
    }))
    expect(alerts.list().map((episode) => episode.code)).toEqual([
      'MEMORY_PRESSURE', 'SAVE_VOLUME_PRESSURE'
    ])
    expect(alerts.list().every((episode) => episode.status === 'open')).toBe(true)

    expectAlertCode(
      () => new ObservabilityAlertEpisodeStateMachine({ capacity: 0 }),
      'OBSERVABILITY_ALERT_CONFIGURATION_INVALID'
    )
    expectAlertCode(
      () => new ObservabilityAlertEpisodeStateMachine({ capacity: 4_097 }),
      'OBSERVABILITY_ALERT_CONFIGURATION_INVALID'
    )
  })

  it('keeps public projections allowlisted and enforces ID, actor, and input text boundaries', () => {
    const alerts = stateMachine()
    alerts.ingest(snapshot(0, { hostCpuPercent: 90, source: 'private.log' }))
    const projectionText = JSON.stringify(alerts.project())
    expect(projectionText).not.toContain('private.log')
    expect(projectionText).not.toContain('host.cpu.totalPercent')
    expect(projectionText).not.toContain('relatedMetrics')
    expect(projectionText).not.toContain('message')
    expect(projectionText).not.toContain('digest')

    const episodeId = getEpisode(alerts, 'HOST_CPU_PRESSURE').id
    expectAlertCode(
      () => alerts.acknowledge({
        episodeId,
        actor: 'C:\\private\\operator.log',
        acknowledgedAt: observedAt(0)
      }),
      'OBSERVABILITY_ALERT_INPUT_INVALID'
    )
    expectAlertCode(
      () => alerts.acknowledge({
        episodeId,
        actor: 'a'.repeat(65),
        acknowledgedAt: observedAt(0)
      }),
      'OBSERVABILITY_ALERT_INPUT_INVALID'
    )
    expectAlertCode(
      () => alerts.acknowledge({
        episodeId,
        actor: 'operator',
        acknowledgedAt: observedAt(0),
        metadata: { log: 'private.log' }
      }),
      'OBSERVABILITY_ALERT_INPUT_INVALID'
    )
    expect(alerts.acknowledge({
      episodeId,
      actor: '值班员01',
      acknowledgedAt: observedAt(0)
    }).acknowledgement?.actor).toBe('值班员01')

    const invalidId = new ObservabilityAlertEpisodeStateMachine({
      idFactory: () => 'C:\\private\\episode.log'
    })
    expectAlertCode(
      () => invalidId.ingest(snapshot(0, { hostCpuPercent: 90 })),
      'OBSERVABILITY_ALERT_EPISODE_ID_INVALID'
    )
    expect(invalidId.size).toBe(0)

    const unexpectedSnapshotField = structuredClone(snapshot(1, { hostCpuPercent: 90 })) as unknown as {
      metadata: unknown
    }
    unexpectedSnapshotField.metadata = { path: 'C:\\private\\server.log' }
    expect(() => alerts.ingest(unexpectedSnapshotField)).toThrow()
  })

  it('round-trips strict serialized state and continues deterministically after hydration', () => {
    const alerts = stateMachine({ capacity: 4, resolveAfterMissingSamples: 2 })
    alerts.ingest(snapshot(0, { ups: 40 }))
    const firstId = getEpisode(alerts, 'SIMULATION_BELOW_TARGET').id
    alerts.acknowledge({
      episodeId: firstId,
      actor: 'oncall.ops',
      acknowledgedAt: observedAt(0)
    })
    const lastBeforeHydration = snapshot(1)
    alerts.ingest(lastBeforeHydration)

    const serialized = alerts.serialize()
    const restored = hydrateObservabilityAlertStateMachine(serialized, {
      idFactory: ({ sequence, code }) => `restored-${sequence}-${code}`
    })
    expect(restored.project()).toEqual(alerts.project())
    expect(restored.serialize()).toEqual(serialized)
    expect(ObservabilityAlertEpisodeStateMachine.hydrate(alerts.serializeJson()).project()).toEqual(
      alerts.project()
    )

    expect(restored.ingest(lastBeforeHydration)).toEqual(alerts.project())
    restored.ingest(snapshot(2))
    expect(getEpisode(restored, 'SIMULATION_BELOW_TARGET').status).toBe('resolved')
    restored.ingest(snapshot(3, { ups: 40 }))
    expect(restored.list().filter((episode) => episode.code === 'SIMULATION_BELOW_TARGET')
      .map((episode) => episode.id)).toEqual([
      firstId,
      'restored-2-SIMULATION_BELOW_TARGET'
    ])

    expectAlertCode(
      () => ObservabilityAlertEpisodeStateMachine.hydrate({
        ...serialized,
        metadata: { path: 'C:\\private\\server.log' }
      }),
      'OBSERVABILITY_ALERT_STATE_INVALID'
    )
    const invalidActor = structuredClone(serialized)
    invalidActor.episodes[0]!.acknowledgement!.actor = 'C:\\private\\operator.log'
    expectAlertCode(
      () => ObservabilityAlertEpisodeStateMachine.hydrate(invalidActor),
      'OBSERVABILITY_ALERT_STATE_INVALID'
    )
    const invalidInvariant = structuredClone(serialized)
    invalidInvariant.episodes[0]!.currentSeverity = 'info'
    invalidInvariant.episodes[0]!.severityHistory[0]!.severity = 'info'
    expectAlertCode(
      () => ObservabilityAlertEpisodeStateMachine.hydrate(invalidInvariant),
      'OBSERVABILITY_ALERT_STATE_INVALID'
    )
    const invalidRelatedMetrics = structuredClone(serialized)
    invalidRelatedMetrics.episodes[0]!.relatedMetrics = []
    expectAlertCode(
      () => ObservabilityAlertEpisodeStateMachine.hydrate(invalidRelatedMetrics),
      'OBSERVABILITY_ALERT_STATE_INVALID'
    )
    expectAlertCode(
      () => ObservabilityAlertEpisodeStateMachine.hydrate('{"schemaVersion":1'),
      'OBSERVABILITY_ALERT_STATE_INVALID'
    )
  })
})

interface SnapshotOptions {
  missingStartedAt?: boolean
  missingProjectRoot?: boolean
  source?: string
  hostCpuPercent?: number | null
  memoryAvailableBytes?: number
  saveVolumeAvailableBytes?: number
  saveVolumeUnavailable?: boolean
  processWorkingSetBytes?: number
  ups?: number | null
}

function snapshot(index: number, options: SnapshotOptions = {}) {
  const hostCpuPercent = options.hostCpuPercent === undefined ? 20 : options.hostCpuPercent
  const ups = options.ups === undefined ? 60 : options.ups
  return buildServerObservabilitySnapshot({
    schemaVersion: 1,
    observedAt: observedAt(index),
    source: options.source ?? 'fixture.alerts',
    runtime: {
      state: 'running', processId: 4242,
      startedAt: options.missingStartedAt ? null : '2026-08-30T11:00:00.000Z'
    },
    host: {
      cpu: {
        logicalProcessorCount: 2,
        totalPercent: hostCpuPercent,
        cores: [{ index: 0, percent: 20 }, { index: 1, percent: 10 }]
      },
      memory: {
        totalBytes: 1_000_000,
        availableBytes: options.memoryAvailableBytes ?? 500_000
      },
      storage: {
        projectVolume: { totalBytes: 2_000_000, availableBytes: 1_000_000 },
        saveVolume: options.saveVolumeUnavailable
          ? null
          : {
              totalBytes: 2_000_000,
              availableBytes: options.saveVolumeAvailableBytes ?? 1_000_000
            }
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
      workingSetBytes: options.processWorkingSetBytes ?? 250_000,
      privateBytes: 300_000,
      threadCount: 200
    },
    network: { gamePort: { port: 8469, listening: true } },
    simulation: { ups, tps: ups, targetUps: 60 },
    automation: { storageDependencyKind: 'none', projectRootAvailable: options.missingProjectRoot ? null : true }
  })
}

function observedAt(index: number): string {
  return new Date(baseTime + index * 1_000).toISOString()
}

function stateMachine(options: {
  capacity?: number
  resolveAfterMissingSamples?: number
} = {}): ObservabilityAlertEpisodeStateMachine {
  return new ObservabilityAlertEpisodeStateMachine({
    ...options,
    idFactory: ({ sequence, code }) => `episode-${sequence}-${code}`
  })
}

function getEpisode(
  alerts: ObservabilityAlertEpisodeStateMachine,
  code: ObservabilityHintCode
) {
  const episode = alerts.list().find((entry) => entry.code === code)
  expect(episode, `missing episode ${code}`).toBeDefined()
  return episode!
}

function expectAlertCode(action: () => unknown, code: ObservabilityAlertErrorCode): void {
  try {
    action()
    throw new Error(`expected ${code}`)
  } catch (error) {
    expect(error).toBeInstanceOf(ObservabilityAlertError)
    expect((error as ObservabilityAlertError).code).toBe(code)
  }
}
