import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { buildApplication, type BuiltApplication } from './app.js'
import { loadConfig } from './config.js'
import { hashPassword } from './security/password.js'
import {
  buildPlayerCapabilitySnapshot,
  buildPlayerSnapshot,
  PlayerNoticeError,
  publicRosterGeneration,
  type PlayerPresenceAuthoritativeSnapshot,
  type PlayerPresenceEvent,
  type PlayerPresenceHistoryStore,
  type PlayerCapabilitySnapshot,
  type PlayerNoticeClient,
  type PlayerNoticeReceipt,
  type PlayerSnapshot
} from './players/index.js'

let application: BuiltApplication | null = null
const temporaryDirectories: string[] = []
afterEach(async () => {
  if (application) await application.close()
  application = null
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true })
  }
})

describe('player roster route', () => {
  it('returns only the bounded public roster and keeps unavailable state unknown', async () => {
    const writtenAtUnixMs = Date.parse('2026-08-30T02:00:00.000Z')
    const active = buildPlayerSnapshot({
      sessionId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', writtenAtUnixMs, sequence: 1,
      state: 'active', truncated: false,
      players: [{
        sessionPlayerId: 'player-000001', displayName: 'Fictional Captain', online: true,
        joinedAtUnixMs: writtenAtUnixMs - 60_000, location: 'planet:1001'
      }]
    }, 'player-route-fixture-secret-at-least-32-bytes').snapshot
    const unavailable = buildPlayerSnapshot({
      sessionId: active.sessionId, writtenAtUnixMs: writtenAtUnixMs + 1_000, sequence: 2,
      state: 'unavailable', truncated: false, players: []
    }, 'player-route-fixture-secret-at-least-32-bytes').snapshot
    const source = new SequenceSource([active, unavailable])
    application = await buildApplication(loadConfig({
      NODE_ENV: 'test', DYSON_PROVIDER: 'demo', DYSON_DEV_ADMIN_PASSWORD: 'test-password-long-enough',
      DYSON_PUBLIC_ORIGIN: 'http://127.0.0.1:13010'
    }), { playerSnapshotSource: source })
    const login = await application.app.inject({
      method: 'POST', url: '/api/v1/auth/login', headers: { origin: 'http://127.0.0.1:13010' },
      payload: { password: 'test-password-long-enough' }
    })
    const get = () => application!.app.inject({
      method: 'GET', url: '/api/v1/players', cookies: { dyson_session: login.cookies[0]!.value }
    })

    const live = await get()
    expect(live.statusCode).toBe(200)
    expect(live.json().data).toMatchObject({
      state: 'active', authoritative: true, playerCount: 1,
      players: [{ sessionPlayerId: 'player-000001', displayName: 'Fictional Captain', location: 'planet:1001' }]
    })
    for (const forbidden of ['hmac', 'Steam', 'player.key', 'ipAddress', 'endpoint', 'sessionId']) {
      expect(live.body).not.toContain(forbidden)
    }

    const unknown = await get()
    expect(unknown.statusCode).toBe(200)
    expect(unknown.json().data).toMatchObject({
      state: 'unavailable', authoritative: false, playerCount: null, players: null,
      lastKnownPlayers: [{ sessionPlayerId: 'player-000001' }]
    })
  })

  it('projects a signed capability proof without returning HMAC or session identifiers', async () => {
    const writtenAtUnixMs = Date.parse('2026-08-30T02:00:00.000Z')
    const capability = buildPlayerCapabilitySnapshot({
      sessionId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
      writtenAtUnixMs,
      runtimeVerified: true
    }, 'player-route-fixture-secret-at-least-32-bytes').snapshot
    application = await buildApplication(loadConfig({
      NODE_ENV: 'test',
      DYSON_PROVIDER: 'demo',
      DYSON_DEV_ADMIN_PASSWORD: 'test-password-long-enough',
      DYSON_PUBLIC_ORIGIN: 'http://127.0.0.1:13010'
    }), { playerCapabilitySource: new CapabilitySource(capability) })
    const login = await application.app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      headers: { origin: 'http://127.0.0.1:13010' },
      payload: { password: 'test-password-long-enough' }
    })
    const response = await application.app.inject({
      method: 'GET',
      url: '/api/v1/players/capabilities',
      cookies: { dyson_session: login.cookies[0]!.value }
    })
    expect(response.statusCode).toBe(200)
    const data = response.json().data
    expect(data).toMatchObject({
      repository: 'NebulaModTeam/nebula',
      tag: 'v0.9.22',
      runtimeFileVersion: '0.9.22.2',
      commit: '3cdf95c594a2f8010b0e87a43be828e6ba2f657f',
      verificationScope: 'runtime-assembly-identity-verified',
      actionsEnabled: true
    })
    expect(data.capabilities).toEqual([
      expect.objectContaining({ capability: 'observe-roster', availability: 'available', mode: 'read-only', reasonCode: 'UPSTREAM_ROSTER_API_VERIFIED' }),
      expect.objectContaining({ capability: 'disconnect', availability: 'unavailable', mode: 'mutation', reasonCode: 'UPSTREAM_CONNECTED_DISCONNECT_UNSAFE' }),
      expect.objectContaining({ capability: 'kick', availability: 'unavailable', mode: 'mutation', reasonCode: 'UPSTREAM_KICK_API_ABSENT' }),
      expect.objectContaining({ capability: 'ban', availability: 'unavailable', mode: 'mutation', reasonCode: 'UPSTREAM_BAN_API_ABSENT' }),
      expect.objectContaining({ capability: 'whitelist', availability: 'unavailable', mode: 'mutation', reasonCode: 'UPSTREAM_WHITELIST_API_ABSENT' }),
      expect.objectContaining({ capability: 'blacklist', availability: 'unavailable', mode: 'mutation', reasonCode: 'UPSTREAM_BLACKLIST_API_ABSENT' }),
      expect.objectContaining({ capability: 'notice', availability: 'available', mode: 'mutation', reasonCode: 'UPSTREAM_TARGETED_NOTICE_PRIMITIVES_VERIFIED' }),
      expect.objectContaining({ capability: 'permission', availability: 'unavailable', mode: 'mutation', reasonCode: 'UPSTREAM_PERMISSION_API_ABSENT' })
    ])
    expect(data.capabilities).toHaveLength(8)
    expect(data.capabilities.filter((entry: { availability: string }) => entry.availability === 'unavailable')).toHaveLength(6)
    expect(data.capabilities.filter((entry: { capability: string }) => entry.capability !== 'observe-roster')
      .every((entry: { mode: string }) => entry.mode === 'mutation')).toBe(true)
    for (const forbidden of ['hmac', 'sessionId', 'secret', 'player.key', 'ipAddress']) {
      expect(response.body).not.toContain(forbidden)
    }

    for (const capability of ['disconnect', 'kick', 'ban', 'whitelist', 'blacklist', 'permission']) {
      const mutation = await application.app.inject({
        method: 'POST',
        url: `/api/v1/players/player-000001/${capability}`,
        headers: { origin: 'http://127.0.0.1:13010' },
        cookies: { dyson_session: login.cookies[0]!.value },
        payload: {}
      })
      expect(mutation.statusCode).toBe(404)
    }
  })

  it('reconciles a signed notice receipt read-only without invoking dispatch', async () => {
    const receipt: PlayerNoticeReceipt = {
      protocol: 'DYSON_CONTROL_PLAYER_NOTICE_RECEIPT_V1',
      requestId: '44444444-5555-4666-8777-888888888888',
      action: 'player.notice',
      state: 'transport-dispatched',
      startedAtUnixMs: 1788081001000,
      finishedAtUnixMs: 1788081001001,
      rosterSessionId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
      rosterSequence: 7,
      sessionPlayerId: 'player-000002',
      targetJoinedAtUnixMs: 1788081002000,
      templateId: 'maintenance-5m',
      mutationMayHaveOccurred: true,
      recoveryRequired: false,
      rollback: 'not-possible',
      errorCode: 'NONE',
      hmac: '0'.repeat(64)
    }
    const noticeClient = new FixedNoticeClient(receipt)
    const viewerPassword = 'fictional-viewer-password'
    application = await buildApplication(loadConfig({
      NODE_ENV: 'test',
      DYSON_PROVIDER: 'demo',
      DYSON_DEV_ADMIN_PASSWORD: 'test-password-long-enough',
      DYSON_VIEWER_PASSWORD_HASH: await hashPassword(viewerPassword),
      DYSON_PUBLIC_ORIGIN: 'http://127.0.0.1:13010'
    }), { playerNoticeClient: noticeClient })

    const viewerLogin = await application.app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      headers: { origin: 'http://127.0.0.1:13010' },
      payload: { role: 'viewer', password: viewerPassword }
    })
    const forbidden = await application.app.inject({
      method: 'GET',
      url: `/api/v1/players/notice/receipts/${receipt.requestId}`,
      cookies: { dyson_session: viewerLogin.cookies[0]!.value }
    })
    expect(forbidden.statusCode).toBe(403)
    expect(noticeClient.readRequestIds).toEqual([])

    const login = await application.app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      headers: { origin: 'http://127.0.0.1:13010' },
      payload: { password: 'test-password-long-enough' }
    })
    const cookies = { dyson_session: login.cookies[0]!.value }

    const found = await application.app.inject({
      method: 'GET',
      url: `/api/v1/players/notice/receipts/${receipt.requestId}`,
      cookies
    })
    expect(found.statusCode).toBe(200)
    expect(found.json()).toMatchObject({
      data: {
        receipt: {
          requestId: receipt.requestId,
          state: 'transport-dispatched',
          rosterGeneration: publicRosterGeneration(receipt.rosterSessionId),
          sessionPlayerId: 'player-000002',
          mutationMayHaveOccurred: true,
          recoveryRequired: false,
          rollback: { strategy: 'not-possible' }
        }
      }
    })
    for (const sensitive of ['hmac', receipt.rosterSessionId, 'secret', 'player.key', 'ipAddress']) {
      expect(found.body).not.toContain(sensitive)
    }

    const missingId = '99999999-8888-4777-8666-555555555555'
    const missing = await application.app.inject({
      method: 'GET',
      url: `/api/v1/players/notice/receipts/${missingId}`,
      cookies
    })
    expect(missing.statusCode).toBe(404)
    expect(missing.json()).toEqual({
      error: { code: 'PLAYER_NOTICE_RECEIPT_NOT_FOUND', message: '玩家通知回执不存在' }
    })
    expect(noticeClient.readRequestIds).toEqual([receipt.requestId, missingId])
    expect(noticeClient.executeCalls).toBe(0)
  })

  it('exposes a published notice timeout as outcome unknown instead of a retryable failure', async () => {
    const writtenAtUnixMs = Date.parse('2026-08-30T02:00:00.000Z')
    const roster = buildPlayerSnapshot({
      sessionId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
      writtenAtUnixMs,
      sequence: 7,
      state: 'active',
      truncated: false,
      players: [{
        sessionPlayerId: 'player-000002',
        displayName: 'Fictional Captain',
        online: true,
        joinedAtUnixMs: writtenAtUnixMs - 1_000,
        location: 'deep-space'
      }]
    }, 'player-route-fixture-secret-at-least-32-bytes').snapshot
    const capability = buildPlayerCapabilitySnapshot({
      sessionId: roster.sessionId,
      writtenAtUnixMs,
      runtimeVerified: true
    }, 'player-route-fixture-secret-at-least-32-bytes').snapshot
    const noticeClient = new OutcomeUnknownNoticeClient()
    const config = {
      ...loadConfig({
        NODE_ENV: 'test',
        DYSON_PROVIDER: 'demo',
        DYSON_DEV_ADMIN_PASSWORD: 'test-password-long-enough',
        DYSON_PUBLIC_ORIGIN: 'http://127.0.0.1:13010'
      }),
      playerNoticeMutationsEnabled: true
    }
    application = await buildApplication(config, {
      playerSnapshotSource: new SequenceSource([roster]),
      playerCapabilitySource: new CapabilitySource(capability),
      playerNoticeClient: noticeClient
    })
    const login = await application.app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      headers: { origin: 'http://127.0.0.1:13010' },
      payload: { password: 'test-password-long-enough' }
    })
    const response = await application.app.inject({
      method: 'POST',
      url: '/api/v1/players/notice',
      headers: { origin: 'http://127.0.0.1:13010' },
      cookies: { dyson_session: login.cookies[0]!.value },
      payload: {
        requestId: '44444444-5555-4666-8777-888888888888',
        confirmation: 'EXECUTE',
        rosterGeneration: publicRosterGeneration(roster.sessionId),
        rosterSequence: roster.sequence,
        sessionPlayerId: 'player-000002',
        templateId: 'maintenance-5m'
      }
    })
    expect(response.statusCode).toBe(503)
    expect(response.json()).toMatchObject({
      error: {
        code: 'PLAYER_NOTICE_OUTCOME_UNKNOWN',
        details: {
          requestId: '44444444-5555-4666-8777-888888888888',
          mutationMayHaveOccurred: true,
          recoveryRequired: true,
          job: { state: 'failed', errorCode: 'PLAYER_NOTICE_OUTCOME_UNKNOWN' }
        }
      }
    })
    expect(noticeClient.executeCalls).toBe(1)
    expect(noticeClient.readRequestIds).toEqual([])
  })

  it('keeps the public history window at 64 events and exposes no player export route', async () => {
    const writtenAtUnixMs = Date.parse('2026-08-30T02:00:00.000Z')
    const active = buildPlayerSnapshot({
      sessionId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
      writtenAtUnixMs,
      sequence: 1,
      state: 'active',
      truncated: false,
      players: []
    }, 'player-route-fixture-secret-at-least-32-bytes').snapshot
    const events: PlayerPresenceEvent[] = Array.from({ length: 70 }, (_, index) => ({
      historySequence: index + 1,
      type: 'join',
      occurredAtUnixMs: writtenAtUnixMs + index,
      sessionId: active.sessionId,
      player: {
        sessionPlayerId: `player-${String(index + 1).padStart(6, '0')}`,
        displayName: `Fictional ${index + 1}`,
        online: true,
        joinedAtUnixMs: writtenAtUnixMs + index,
        location: 'deep-space'
      }
    }))
    application = await buildApplication(loadConfig({
      NODE_ENV: 'test',
      DYSON_PROVIDER: 'demo',
      DYSON_DEV_ADMIN_PASSWORD: 'test-password-long-enough',
      DYSON_PUBLIC_ORIGIN: 'http://127.0.0.1:13010'
    }), {
      playerSnapshotSource: new SequenceSource([active]),
      playerPresenceHistory: new FixedPlayerHistory(events)
    })
    const login = await application.app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      headers: { origin: 'http://127.0.0.1:13010' },
      payload: { password: 'test-password-long-enough' }
    })
    const cookies = { dyson_session: login.cookies[0]!.value }
    const response = await application.app.inject({ method: 'GET', url: '/api/v1/players', cookies })
    expect(response.statusCode).toBe(200)
    expect(response.json().data.recentEvents).toHaveLength(64)
    expect(response.json().data.recentEvents.map((event: { sequence: number }) => event.sequence))
      .toEqual(Array.from({ length: 64 }, (_, index) => index + 7))
    expect(response.body).not.toContain(active.sessionId)

    const exportResponse = await application.app.inject({
      method: 'GET', url: '/api/v1/players/export', cookies
    })
    expect(exportResponse.statusCode).toBe(404)
  })

  it('reuses the durable player cursor after an application restart', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'dyson-player-route-restart-'))
    temporaryDirectories.push(directory)
    const writtenAtUnixMs = Date.parse('2026-08-31T02:00:00.000Z')
    const active = buildPlayerSnapshot({
      sessionId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
      writtenAtUnixMs,
      sequence: 1,
      state: 'active',
      truncated: false,
      players: [{
        sessionPlayerId: 'player-000001',
        displayName: 'Fictional Captain',
        online: true,
        joinedAtUnixMs: writtenAtUnixMs - 1_000,
        location: 'deep-space'
      }]
    }, 'player-route-fixture-secret-at-least-32-bytes').snapshot
    const config = loadConfig({
      NODE_ENV: 'development',
      DYSON_PROVIDER: 'demo',
      DYSON_DATA_DIR: directory,
      DYSON_DEV_ADMIN_PASSWORD: 'test-password-long-enough',
      DYSON_PUBLIC_ORIGIN: 'http://127.0.0.1:13010'
    })

    application = await buildApplication(config, { playerSnapshotSource: new SequenceSource([active]) })
    let login = await application.app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      headers: { origin: 'http://127.0.0.1:13010' },
      payload: { password: 'test-password-long-enough' }
    })
    let response = await application.app.inject({
      method: 'GET',
      url: '/api/v1/players',
      cookies: { dyson_session: login.cookies[0]!.value }
    })
    expect(response.json().data.recentEvents).toHaveLength(1)
    await application.close()
    application = null

    application = await buildApplication(config, { playerSnapshotSource: new SequenceSource([active]) })
    login = await application.app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      headers: { origin: 'http://127.0.0.1:13010' },
      payload: { password: 'test-password-long-enough' }
    })
    response = await application.app.inject({
      method: 'GET',
      url: '/api/v1/players',
      cookies: { dyson_session: login.cookies[0]!.value }
    })
    expect(response.statusCode).toBe(200)
    expect(response.json().data.recentEvents).toHaveLength(1)
    expect(response.json().data.recentEvents[0]).toMatchObject({
      sequence: 1,
      type: 'join',
      player: { sessionPlayerId: 'player-000001' }
    })
  })

  it('rejects an older session replay after restart instead of returning its raw roster', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'dyson-player-route-replay-'))
    temporaryDirectories.push(directory)
    const writtenAtUnixMs = Date.parse('2026-08-31T02:00:00.000Z')
    const snapshotA = buildPlayerSnapshot({
      sessionId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
      writtenAtUnixMs,
      sequence: 1,
      state: 'active',
      truncated: false,
      players: [{
        sessionPlayerId: 'player-000001', displayName: 'Fictional A', online: true,
        joinedAtUnixMs: writtenAtUnixMs - 1_000, location: 'deep-space'
      }]
    }, 'player-route-fixture-secret-at-least-32-bytes').snapshot
    const snapshotB = buildPlayerSnapshot({
      sessionId: '11111111-2222-4333-8444-555555555555',
      writtenAtUnixMs: writtenAtUnixMs + 1_000,
      sequence: 1,
      state: 'active',
      truncated: false,
      players: [{
        sessionPlayerId: 'player-000001', displayName: 'Fictional B', online: true,
        joinedAtUnixMs: writtenAtUnixMs, location: 'deep-space'
      }]
    }, 'player-route-fixture-secret-at-least-32-bytes').snapshot
    const config = loadConfig({
      NODE_ENV: 'development',
      DYSON_PROVIDER: 'demo',
      DYSON_DATA_DIR: directory,
      DYSON_DEV_ADMIN_PASSWORD: 'test-password-long-enough',
      DYSON_PUBLIC_ORIGIN: 'http://127.0.0.1:13010'
    })

    application = await buildApplication(config, {
      playerSnapshotSource: new SequenceSource([snapshotA, snapshotB])
    })
    let login = await application.app.inject({
      method: 'POST', url: '/api/v1/auth/login', headers: { origin: 'http://127.0.0.1:13010' },
      payload: { password: 'test-password-long-enough' }
    })
    const cookies = { dyson_session: login.cookies[0]!.value }
    await application.app.inject({ method: 'GET', url: '/api/v1/players', cookies })
    const latest = await application.app.inject({ method: 'GET', url: '/api/v1/players', cookies })
    expect(latest.json().data.players).toMatchObject([{ displayName: 'Fictional B' }])
    await application.close()
    application = null

    application = await buildApplication(config, {
      playerSnapshotSource: new SequenceSource([snapshotA])
    })
    login = await application.app.inject({
      method: 'POST', url: '/api/v1/auth/login', headers: { origin: 'http://127.0.0.1:13010' },
      payload: { password: 'test-password-long-enough' }
    })
    const replay = await application.app.inject({
      method: 'GET', url: '/api/v1/players',
      cookies: { dyson_session: login.cookies[0]!.value }
    })
    expect(replay.statusCode).toBe(503)
    expect(replay.json()).toEqual({
      error: { code: 'PLAYER_SNAPSHOT_UNAVAILABLE', message: '玩家会话状态暂不可用' }
    })
    expect(replay.body).not.toContain('Fictional A')
  })

  it('starts and stops player-history retention maintenance with the application', async () => {
    const history = new MaintenanceAwareHistory()
    application = await buildApplication(loadConfig({
      NODE_ENV: 'test',
      DYSON_PROVIDER: 'demo',
      DYSON_DEV_ADMIN_PASSWORD: 'test-password-long-enough',
      DYSON_PUBLIC_ORIGIN: 'http://127.0.0.1:13010'
    }), { playerPresenceHistory: history })
    expect(history.started).toBe(true)
    expect(history.stopped).toBe(false)

    await application.close()
    application = null
    expect(history.stopped).toBe(true)
  })
})

class SequenceSource {
  #snapshots: PlayerSnapshot[]
  constructor(snapshots: PlayerSnapshot[]) { this.#snapshots = [...snapshots] }
  async read(): Promise<PlayerSnapshot> {
    const snapshot = this.#snapshots.shift()
    if (!snapshot) throw new Error('fixture exhausted')
    return snapshot
  }
}

class CapabilitySource {
  readonly #snapshot: PlayerCapabilitySnapshot
  constructor(snapshot: PlayerCapabilitySnapshot) { this.#snapshot = snapshot }
  async read(): Promise<PlayerCapabilitySnapshot> { return structuredClone(this.#snapshot) }
}

class FixedNoticeClient implements PlayerNoticeClient {
  readonly readRequestIds: string[] = []
  executeCalls = 0
  readonly #receipt: PlayerNoticeReceipt
  constructor(receipt: PlayerNoticeReceipt) { this.#receipt = structuredClone(receipt) }
  async execute(): Promise<PlayerNoticeReceipt> {
    this.executeCalls += 1
    throw new Error('read-only reconciliation invoked dispatch')
  }
  async readReceipt(requestId: string): Promise<PlayerNoticeReceipt | null> {
    this.readRequestIds.push(requestId)
    return requestId === this.#receipt.requestId ? structuredClone(this.#receipt) : null
  }
}

class OutcomeUnknownNoticeClient implements PlayerNoticeClient {
  readonly readRequestIds: string[] = []
  executeCalls = 0
  async execute(): Promise<PlayerNoticeReceipt> {
    this.executeCalls += 1
    throw new PlayerNoticeError('PLAYER_NOTICE_OUTCOME_UNKNOWN', {
      causeCode: 'PLAYER_NOTICE_RECEIPT_TIMEOUT',
      requestPublished: true,
      mutationMayHaveOccurred: true,
      recoveryRequired: true
    })
  }
  async readReceipt(requestId: string): Promise<PlayerNoticeReceipt | null> {
    this.readRequestIds.push(requestId)
    return null
  }
}

class FixedPlayerHistory implements PlayerPresenceHistoryStore {
  readonly #events: PlayerPresenceEvent[]
  #authoritative: PlayerPresenceAuthoritativeSnapshot | null = null
  constructor(events: PlayerPresenceEvent[]) { this.#events = structuredClone(events) }
  ingest(snapshot: PlayerSnapshot): PlayerPresenceEvent[] {
    if (snapshot.state !== 'unavailable') {
      this.#authoritative = {
        sessionId: snapshot.sessionId,
        sequence: snapshot.sequence,
        writtenAtUnixMs: snapshot.writtenAtUnixMs,
        state: snapshot.state,
        truncated: snapshot.truncated,
        players: structuredClone(snapshot.players)
      }
    }
    return []
  }
  list(): PlayerPresenceEvent[] { return structuredClone(this.#events) }
  current() { return [] }
  authoritative(): PlayerPresenceAuthoritativeSnapshot | null {
    return structuredClone(this.#authoritative)
  }
}

class MaintenanceAwareHistory implements PlayerPresenceHistoryStore {
  started = false
  stopped = false
  ingest(): PlayerPresenceEvent[] { return [] }
  list(): PlayerPresenceEvent[] { return [] }
  current() { return [] }
  authoritative(): PlayerPresenceAuthoritativeSnapshot | null { return null }
  startRetentionMaintenance(): () => void {
    this.started = true
    return () => { this.stopped = true }
  }
}
