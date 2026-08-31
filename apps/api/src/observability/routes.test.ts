import { afterEach, describe, expect, it } from 'vitest'
import { buildApplication, type BuiltApplication } from '../app.js'
import { loadConfig } from '../config.js'
import type { LifecycleAction, LifecyclePreview, ServerStatus, StatusProvider } from '../domain.js'
import { BoundedObservabilityHistory } from './history.js'

const origin = 'http://127.0.0.1:13010'
let application: BuiltApplication | null = null

afterEach(async () => {
  if (application) await application.close()
  application = null
})

describe('authenticated server observability API', () => {
  it('protects the read API and preserves missing/per-core/actual-simulation boundaries', async () => {
    const provider = new SequentialStatusProvider({ gamePortStatus: 'warning' })
    application = await buildApplication(testConfig(), { statusProvider: provider })

    expect((await application.app.inject({
      method: 'GET', url: '/api/v1/observability/snapshot'
    })).statusCode).toBe(401)
    expect((await application.app.inject({
      method: 'GET', url: '/api/v1/observability/history'
    })).statusCode).toBe(401)
    expect((await application.app.inject({
      method: 'GET', url: '/api/v1/observability/qualification'
    })).statusCode).toBe(401)
    expect((await application.app.inject({
      method: 'GET', url: '/api/v1/observability/alerts'
    })).statusCode).toBe(401)

    const cookie = await login(application)
    const response = await application.app.inject({
      method: 'GET', url: '/api/v1/observability/snapshot',
      cookies: { dyson_session: cookie }
    })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toMatchObject({
      data: {
        source: 'windows.server-status',
        host: {
          cpu: {
            totalPercent: { status: 'available', value: 37.5 },
            perCorePercent: { status: 'available' }
          },
          storage: {
            projectVolume: { usedPercent: { status: 'available', value: 60 } },
            saveVolume: { usedPercent: { status: 'available', value: 50 } }
          },
          network: {
            receiveBytesPerSecond: { status: 'available', value: 12_500 },
            sendBytesPerSecond: { status: 'available', value: 4_200 }
          }
        },
        process: {
          cpuPercent: { status: 'unavailable', reason: 'not-provided' },
          cpuCoresUsed: { status: 'available', value: 2.75 }
        },
        simulation: {
          ups: { status: 'unavailable', reason: 'not-provided' },
          tps: { status: 'unavailable', reason: 'not-provided' },
          targetUps: { status: 'available', value: 60 }
        },
        health: { status: 'critical' }
      },
      meta: { provider: 'windows', environment: 'test', retainedSamples: 1, capacity: 2_048 }
    })
    expect(response.json().data.health.hints).toContainEqual(expect.objectContaining({
      code: 'GAME_PORT_NOT_LISTENING'
    }))
    expect(response.json().data.host.cpu.perCorePercent.value).toHaveLength(16)

    const alerts = await application.app.inject({
      method: 'GET', url: '/api/v1/observability/alerts',
      cookies: { dyson_session: cookie }
    })
    expect(alerts.statusCode).toBe(200)
    expect(alerts.json()).toMatchObject({
      data: {
        schemaVersion: 1,
        kind: 'observability-alert-episode-projection',
        observedThrough: '2026-08-30T12:00:00.000Z'
      },
      meta: { recoveryRequired: false }
    })
    const gamePortAlert = alerts.json().data.episodes.find(
      (episode: { code: string }) => episode.code === 'GAME_PORT_NOT_LISTENING'
    )
    expect(gamePortAlert).toMatchObject({ status: 'open', currentSeverity: 'critical' })
    expect(JSON.stringify(alerts.json())).not.toMatch(/relatedMetrics|server-status|gamePort\.listening/)

    const rejectedAcknowledgement = await application.app.inject({
      method: 'POST',
      url: `/api/v1/observability/alerts/${gamePortAlert.id}/acknowledge`,
      cookies: { dyson_session: cookie },
      payload: { confirmation: 'ACKNOWLEDGE_ALERT' }
    })
    expect(rejectedAcknowledgement.statusCode).toBe(403)

    const acknowledgement = await application.app.inject({
      method: 'POST',
      url: `/api/v1/observability/alerts/${gamePortAlert.id}/acknowledge`,
      headers: { origin }, cookies: { dyson_session: cookie },
      payload: { confirmation: 'ACKNOWLEDGE_ALERT' }
    })
    expect(acknowledgement.statusCode).toBe(200)
    expect(acknowledgement.json().data).toMatchObject({
      id: gamePortAlert.id,
      status: 'open',
      acknowledgement: { actor: 'Administrator' }
    })
    const replayedAcknowledgement = await application.app.inject({
      method: 'POST',
      url: `/api/v1/observability/alerts/${gamePortAlert.id}/acknowledge`,
      headers: { origin }, cookies: { dyson_session: cookie },
      payload: { confirmation: 'ACKNOWLEDGE_ALERT' }
    })
    expect(replayedAcknowledgement.statusCode).toBe(200)
    expect(replayedAcknowledgement.json()).toEqual(acknowledgement.json())

    const duplicate = await application.app.inject({
      method: 'GET', url: '/api/v1/observability/snapshot',
      cookies: { dyson_session: cookie }
    })
    expect(duplicate.json().meta.retainedSamples).toBe(1)
    expect(provider.collections).toBe(1)

    const qualification = await application.app.inject({
      method: 'GET', url: '/api/v1/observability/qualification',
      cookies: { dyson_session: cookie }
    })
    expect(qualification.statusCode).toBe(200)
    expect(qualification.json()).toMatchObject({
      data: {
        profileId: 'late-game-6h-v1',
        result: 'insufficient',
        sampleCount: 1,
        remainingEvidence: [
          'SAVE_LATENCY_DRILL_REQUIRED',
          'REBOOT_RECOVERY_DRILL_REQUIRED',
          'CRASH_RECOVERY_DRILL_REQUIRED',
          'EXTERNAL_JOIN_SOAK_REQUIRED'
        ]
      },
      meta: { provider: 'windows', environment: 'test', capacity: 2_048 }
    })

    for (const query of ['points=0', 'points=121', 'points=2&unknown=true']) {
      const invalid = await application.app.inject({
        method: 'GET', url: `/api/v1/observability/history?${query}`,
        cookies: { dyson_session: cookie }
      })
      expect(invalid.statusCode).toBe(400)
      expect(invalid.json().error.code).toBe('INVALID_OBSERVABILITY_QUERY')
    }
  })

  it('samples successful status refreshes into a fixed ring and bounds returned points', async () => {
    const provider = new SequentialStatusProvider()
    const history = new BoundedObservabilityHistory(2)
    application = await buildApplication(testConfig(), {
      statusProvider: provider,
      observabilityHistory: history
    })
    const cookie = await login(application)

    await application.app.inject({
      method: 'GET', url: '/api/v1/status', cookies: { dyson_session: cookie }
    })
    for (let refreshIndex = 0; refreshIndex < 3; refreshIndex++) {
      const accepted = await application.app.inject({
        method: 'POST',
        url: '/api/v1/actions/refresh',
        headers: { origin },
        cookies: { dyson_session: cookie }
      })
      expect(accepted.statusCode).toBe(202)
      await waitForJob(application, cookie, accepted.json().data.id)
    }

    const response = await application.app.inject({
      method: 'GET', url: '/api/v1/observability/history?points=1',
      cookies: { dyson_session: cookie }
    })
    expect(response.statusCode).toBe(200)
    expect(response.json()).toMatchObject({
      data: {
        retainedSamples: 2,
        droppedSamples: 2,
        points: [{ sampleCount: 2 }]
      },
      meta: { capacity: 2, provider: 'windows', environment: 'test' }
    })
    expect(response.json().data.points).toHaveLength(1)
    expect(response.json().data.points[0].metrics.hostCpuPercent).toMatchObject({
      status: 'available', observedSamples: 2, unavailableSamples: 0
    })
    expect(response.json().data.points[0].metrics.networkReceiveBytesPerSecond).toMatchObject({
      status: 'available', observedSamples: 2, unavailableSamples: 0
    })
    expect(provider.collections).toBe(4)
  })
})

function testConfig() {
  return loadConfig({
    NODE_ENV: 'test',
    DYSON_PROVIDER: 'demo',
    DYSON_DEV_ADMIN_PASSWORD: 'test-password-long-enough',
    DYSON_PUBLIC_ORIGIN: origin,
    DYSON_GAME_PORT: '8469'
  })
}

async function login(target: BuiltApplication): Promise<string> {
  const response = await target.app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    headers: { origin },
    payload: { password: 'test-password-long-enough' }
  })
  expect(response.statusCode).toBe(200)
  const cookie = response.cookies[0]?.value
  expect(cookie).toBeTruthy()
  return cookie!
}

async function waitForJob(target: BuiltApplication, cookie: string, id: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt++) {
    const response = await target.app.inject({
      method: 'GET', url: `/api/v1/jobs/${id}`, cookies: { dyson_session: cookie }
    })
    const state = response.json().data?.state
    if (state === 'succeeded') return
    if (state === 'failed') throw new Error(`status refresh ${id} failed`)
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  throw new Error(`status refresh ${id} did not complete`)
}

class SequentialStatusProvider implements StatusProvider {
  readonly name = 'windows' as const
  collections = 0
  readonly #gamePortStatus: 'healthy' | 'warning' | 'unknown'

  constructor(options: { gamePortStatus?: 'healthy' | 'warning' | 'unknown' } = {}) {
    this.#gamePortStatus = options.gamePortStatus ?? 'healthy'
  }

  async collectStatus(): Promise<ServerStatus> {
    const collectedAt = new Date(Date.parse('2026-08-30T12:00:00.000Z') + this.collections * 1_000).toISOString()
    const cpuPercent = 37.5 + this.collections
    this.collections++
    return statusFixture(collectedAt, cpuPercent, this.#gamePortStatus)
  }

  async previewLifecycle(_action: LifecycleAction): Promise<LifecyclePreview> {
    throw new Error('not used by observability route tests')
  }
}

function statusFixture(
  collectedAt: string,
  cpuPercent: number,
  gamePortStatus: 'healthy' | 'warning' | 'unknown'
): ServerStatus {
  return {
    collectedAt,
    serverName: 'Fictional DSP server',
    state: 'running',
    runtime: {
      targetUps: 60,
      onlinePlayers: 2,
      maxPlayers: 8,
      processId: 4242,
      processCoresUsed: 2.75,
      workingSetGiB: 6.25,
      privateMemoryGiB: 7,
      threadCount: 240,
      priority: 'High',
      startedAt: '2026-08-30T10:00:00.000Z',
      uptimeSeconds: 7_200
    },
    host: {
      logicalProcessors: 16,
      processorGroups: 1,
      cpuPercent,
      memoryTotalGiB: 64,
      memoryFreeGiB: 40,
      cpuCores: {
        samples: Array.from({ length: 16 }, (_, index) => ({
          index,
          percent: index === 0 ? Math.min(100, cpuPercent + 20) : Math.max(0, cpuPercent - 10)
        })),
        unavailableReason: null
      },
      projectVolume: {
        totalBytes: 1_000_000,
        availableBytes: 400_000,
        usedPercent: 60,
        unavailableReason: null
      },
      saveVolume: {
        totalBytes: 2_000_000,
        availableBytes: 1_000_000,
        usedPercent: 50,
        unavailableReason: null
      },
      network: {
        receiveBytesPerSecond: 12_500,
        sendBytesPerSecond: 4_200,
        sampledInterfaceCount: 2,
        unavailableReason: null
      }
    },
    versions: {
      dsp: null,
      nebula: null,
      bepInEx: null,
      compatible: null,
      gameLoaded: null,
      warnings: []
    },
    save: {
      name: null,
      dsvPresent: false,
      serverPresent: false,
      consistent: false,
      lastSavedAt: null,
      dsvSizeMiB: null,
      serverSizeKiB: null,
      latestBackupAt: null,
      backupManifestPresent: false,
      backupPairPresent: false
    },
    automation: {
      serverTask: { state: null, lastResult: null, lastRunAt: null },
      stopTask: { state: null, lastResult: null, lastRunAt: null },
      storageTask: { state: null, lastResult: null, lastRunAt: null },
      projectRootAvailable: true,
      globalMappingAvailable: null
    },
    connections: [
      { id: 'game-port', label: 'Game port', status: gamePortStatus, detail: 'Fixture listener state' }
    ],
    capabilities: { refresh: true, start: false, save: false, gracefulStop: false, restart: false }
  }
}
