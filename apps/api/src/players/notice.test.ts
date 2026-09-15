import { createHmac } from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  FilePlayerNoticeClient,
  PlayerNoticeError,
  buildPlayerNoticeRequest,
  parsePlayerNoticeReceipt,
  parsePlayerNoticeRequest,
  playerNoticeExecutionRequestSchema,
  previewPlayerNotice,
  publicRosterGeneration,
  type PlayerNoticeExecutionRequest,
  type PlayerNoticeReceiptState,
  type PlayerNoticeTemplateId
} from './notice.js'
import { buildPlayerCapabilitySnapshot } from './capabilities.js'
import { buildPlayerSnapshot } from './protocol.js'

const secret = 'fictional-cross-runtime-secret-0123456789'
const requestId = '44444444-5555-4666-8777-888888888888'
const rosterSessionId = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'
const execution: PlayerNoticeExecutionRequest & {
  rosterSessionId: string
  targetJoinedAtUnixMs: number
} = {
  requestId,
  confirmation: 'EXECUTE',
  rosterGeneration: 'roster-v1:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  rosterSequence: 7,
  rosterSessionId,
  sessionPlayerId: 'player-000002',
  targetJoinedAtUnixMs: 1788081002000,
  templateId: 'maintenance-5m'
}

const fixedRequest = [
  'protocol=DYSON_CONTROL_PLAYER_NOTICE_REQUEST_V1',
  `requestId=${requestId}`,
  'createdAtUnixMs=1788081000000',
  'expiresAtUnixMs=1788081015000',
  'action=player.notice',
  `rosterSessionId=${rosterSessionId}`,
  'rosterSequence=7',
  'sessionPlayerId=player-000002',
  'targetJoinedAtUnixMs=1788081002000',
  'templateId=maintenance-5m',
  'nonce=ABCDEFGHIJKLMNOPQRSTUV',
  'hmac=43c455ccb78a933e52013cc2bb0d370e4dc9f8488d8c61bfbf63c1ec4fa7035e',
  ''
].join('\n')

const fixedReceipt = [
  'protocol=DYSON_CONTROL_PLAYER_NOTICE_RECEIPT_V1',
  `requestId=${requestId}`,
  'action=player.notice',
  'state=transport-dispatched',
  'startedAtUnixMs=1788081001000',
  'finishedAtUnixMs=1788081001001',
  `rosterSessionId=${rosterSessionId}`,
  'rosterSequence=7',
  'sessionPlayerId=player-000002',
  'targetJoinedAtUnixMs=1788081002000',
  'templateId=maintenance-5m',
  'mutationMayHaveOccurred=true',
  'recoveryRequired=false',
  'rollback=not-possible',
  'errorCode=NONE',
  'hmac=f97c72fb9e97f50b5bff43a81722ec864f4d5edbc8722b1a456015915cfb2efb',
  ''
].join('\n')

const temporaryRoots: string[] = []

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })))
})

describe('player notice protocol', () => {
  it('matches the independent C# request and receipt vectors', () => {
    expect(buildPlayerNoticeRequest(
      execution,
      secret,
      1788081000000,
      15_000,
      'ABCDEFGHIJKLMNOPQRSTUV'
    )).toBe(fixedRequest)
    expect(parsePlayerNoticeRequest(fixedRequest, secret)).toMatchObject({
      requestId,
      rosterSessionId,
      rosterSequence: 7,
      sessionPlayerId: 'player-000002',
      templateId: 'maintenance-5m'
    })
    expect(parsePlayerNoticeReceipt(fixedReceipt, secret)).toMatchObject({
      requestId,
      state: 'transport-dispatched',
      mutationMayHaveOccurred: true,
      recoveryRequired: false,
      errorCode: 'NONE'
    })
  })

  it('accepts fixed template identifiers only and rejects signature or receipt-semantic drift', () => {
    expect(playerNoticeExecutionRequestSchema.safeParse({ ...execution, message: 'free text' }).success).toBe(false)
    expect(playerNoticeExecutionRequestSchema.safeParse({ ...execution, templateId: 'free-text' }).success).toBe(false)
    expect(() => parsePlayerNoticeRequest(
      fixedRequest.replace('templateId=maintenance-5m', 'templateId=maintenance-now'),
      secret
    )).toThrow('PLAYER_NOTICE_SIGNATURE_INVALID')
    expect(() => parsePlayerNoticeReceipt(
      fixedReceipt.replace('hmac=f97c', 'hmac=097c'),
      secret
    )).toThrow('PLAYER_NOTICE_SIGNATURE_INVALID')
    expect(() => parsePlayerNoticeReceipt(buildReceipt({
      state: 'failed', mutationMayHaveOccurred: true, recoveryRequired: false, errorCode: 'DISPATCH_FAILED'
    }), secret)).toThrow('PLAYER_NOTICE_RECEIPT_SEMANTICS_INVALID')
  })

  it('fails closed unless the runtime identity, execution gate, roster generation, and target all match', () => {
    const writtenAtUnixMs = 1788081004000
    const roster = buildPlayerSnapshot({
      sessionId: rosterSessionId,
      writtenAtUnixMs,
      sequence: 7,
      state: 'active',
      truncated: false,
      players: [{
        sessionPlayerId: 'player-000002',
        displayName: 'Fictional Captain',
        online: true,
        joinedAtUnixMs: 1788081002000,
        location: 'deep-space'
      }]
    }, secret).snapshot
    const input = {
      rosterGeneration: publicRosterGeneration(rosterSessionId),
      rosterSequence: 7,
      sessionPlayerId: 'player-000002',
      templateId: 'maintenance-5m' as const
    }
    const verified = buildPlayerCapabilitySnapshot({
      sessionId: rosterSessionId,
      writtenAtUnixMs,
      runtimeVerified: true
    }, secret).snapshot
    expect(previewPlayerNotice(input, roster, verified, true)).toMatchObject({
      allowed: true,
      blockers: []
    })
    expect(previewPlayerNotice({ ...input, rosterSequence: 6 }, roster, verified, true)).toMatchObject({
      allowed: false,
      blockers: ['stale-roster-sequence']
    })
    expect(previewPlayerNotice(input, roster, verified, false)).toMatchObject({
      allowed: false,
      blockers: ['execution-disabled']
    })

    const unverified = buildPlayerCapabilitySnapshot({
      sessionId: rosterSessionId,
      writtenAtUnixMs,
      runtimeVerified: false
    }, secret).snapshot
    expect(previewPlayerNotice(input, roster, unverified, true)).toMatchObject({
      allowed: false,
      blockers: ['capability-unavailable']
    })
  })
})

describe('file player notice client', () => {
  it('publishes one signed request and accepts only the matching signed terminal receipt', async () => {
    const fixture = await createFixture()
    const client = createClient(fixture)
    const pending = client.execute(execution)
    const requestFile = path.join(fixture.controlRoot, 'player-notice-requests', `${requestId}.request`)
    await waitForFile(requestFile)
    expect(parsePlayerNoticeRequest(await fs.readFile(requestFile, 'utf8'), secret)).toMatchObject({
      requestId,
      templateId: 'maintenance-5m'
    })
    await fs.writeFile(
      path.join(fixture.controlRoot, 'player-notice-receipts', `${requestId}.receipt`),
      fixedReceipt
    )
    await expect(pending).resolves.toMatchObject({ state: 'transport-dispatched', requestId })
    expect(await fs.readdir(path.join(fixture.controlRoot, 'player-notice-requests'))).toEqual([
      `${requestId}.request`
    ])
  })

  it('rejects an idempotency-key conflict without publishing another request', async () => {
    const fixture = await createFixture()
    const client = createClient(fixture)
    await fs.writeFile(
      path.join(fixture.controlRoot, 'player-notice-receipts', `${requestId}.receipt`),
      buildReceipt({ sessionPlayerId: 'player-000003' })
    )
    await expect(client.execute(execution)).rejects.toThrow('PLAYER_NOTICE_IDEMPOTENCY_CONFLICT')
    expect(await fs.readdir(path.join(fixture.controlRoot, 'player-notice-requests'))).toEqual([])

    await fs.rm(path.join(fixture.controlRoot, 'player-notice-receipts', `${requestId}.receipt`))
    await fs.writeFile(
      path.join(fixture.controlRoot, 'player-notice-processing', `${requestId}.request`),
      buildPlayerNoticeRequest({ ...execution, templateId: 'maintenance-now' }, secret)
    )
    await expect(client.execute(execution)).rejects.toThrow('PLAYER_NOTICE_IDEMPOTENCY_CONFLICT')
    expect(await fs.readdir(path.join(fixture.controlRoot, 'player-notice-requests'))).toEqual([])
  })

  it('marks receipt timeout after publication as outcome unknown and never republishes implicitly', async () => {
    const fixture = await createFixture()
    const client = createClient(fixture, 1_000)
    const firstError = await client.execute(execution).catch((error: unknown) => error)
    expect(firstError).toBeInstanceOf(PlayerNoticeError)
    expect(firstError).toMatchObject({
      code: 'PLAYER_NOTICE_OUTCOME_UNKNOWN',
      causeCode: 'PLAYER_NOTICE_RECEIPT_TIMEOUT',
      requestPublished: true,
      mutationMayHaveOccurred: true,
      recoveryRequired: true
    })
    const requestRoot = path.join(fixture.controlRoot, 'player-notice-requests')
    const original = await fs.readFile(path.join(requestRoot, `${requestId}.request`), 'utf8')

    const controller = new AbortController()
    setTimeout(() => controller.abort(), 50)
    const secondError = await client.execute(execution, controller.signal).catch((error: unknown) => error)
    expect(secondError).toMatchObject({
      code: 'PLAYER_NOTICE_OUTCOME_UNKNOWN',
      causeCode: 'PLAYER_NOTICE_WAIT_ABORTED',
      mutationMayHaveOccurred: true
    })
    expect(await fs.readdir(requestRoot)).toEqual([`${requestId}.request`])
    expect(await fs.readFile(path.join(requestRoot, `${requestId}.request`), 'utf8')).toBe(original)
  })

  it('queries a receipt read-only without creating or replaying a request', async () => {
    const fixture = await createFixture()
    const client = createClient(fixture)
    const requestRoot = path.join(fixture.controlRoot, 'player-notice-requests')
    await expect(client.readReceipt(requestId)).resolves.toBeNull()
    expect(await fs.readdir(requestRoot)).toEqual([])

    await fs.writeFile(
      path.join(fixture.controlRoot, 'player-notice-receipts', `${requestId}.receipt`),
      fixedReceipt
    )
    await expect(client.readReceipt(requestId)).resolves.toMatchObject({
      requestId,
      state: 'transport-dispatched'
    })
    expect(await fs.readdir(requestRoot)).toEqual([])
    await expect(client.readReceipt('../not-a-guid')).rejects.toThrow('PLAYER_NOTICE_GUID_INVALID')
    expect(await fs.readdir(requestRoot)).toEqual([])
  })
})

async function createFixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dyson-player-notice-api-'))
  temporaryRoots.push(root)
  const controlRoot = path.join(root, 'control')
  const secretFile = path.join(root, 'secret')
  await fs.mkdir(controlRoot)
  await Promise.all([
    'player-notice-requests',
    'player-notice-processing',
    'player-notice-receipts',
    'player-notice-processed',
    'player-notice-rejected'
  ].map((directory) => fs.mkdir(path.join(controlRoot, directory))))
  await fs.writeFile(secretFile, secret)
  return { controlRoot, secretFile }
}

function createClient(fixture: { controlRoot: string; secretFile: string }, timeoutMs = 2_000) {
  return new FilePlayerNoticeClient({
    ...fixture,
    timeoutMs,
    pollMs: 25,
    requestLifetimeMs: 15_000
  })
}

async function waitForFile(file: string) {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    try {
      await fs.access(file)
      return
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 25))
    }
  }
  throw new Error('fixture request was not published')
}

function buildReceipt(overrides: {
  state?: PlayerNoticeReceiptState
  sessionPlayerId?: string
  templateId?: PlayerNoticeTemplateId
  mutationMayHaveOccurred?: boolean
  recoveryRequired?: boolean
  errorCode?: string
} = {}) {
  const fields = [
    'DYSON_CONTROL_PLAYER_NOTICE_RECEIPT_V1',
    requestId,
    'player.notice',
    overrides.state ?? 'transport-dispatched',
    '1788081001000',
    '1788081001001',
    rosterSessionId,
    '7',
    overrides.sessionPlayerId ?? 'player-000002',
    '1788081002000',
    overrides.templateId ?? 'maintenance-5m',
    String(overrides.mutationMayHaveOccurred ?? true),
    String(overrides.recoveryRequired ?? false),
    'not-possible',
    overrides.errorCode ?? 'NONE'
  ]
  const hmac = createHmac('sha256', secret).update(fields.join('\n'), 'utf8').digest('hex')
  const keys = [
    'protocol', 'requestId', 'action', 'state', 'startedAtUnixMs', 'finishedAtUnixMs',
    'rosterSessionId', 'rosterSequence', 'sessionPlayerId', 'targetJoinedAtUnixMs',
    'templateId', 'mutationMayHaveOccurred', 'recoveryRequired', 'rollback', 'errorCode'
  ]
  return `${keys.map((key, index) => `${key}=${fields[index]}`).join('\n')}\nhmac=${hmac}\n`
}
