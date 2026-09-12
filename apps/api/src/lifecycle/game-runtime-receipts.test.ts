import path from 'node:path'
import os from 'node:os'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  FileGameRuntimeReceiptSource,
  GAME_RUNTIME_PUBLIC_RECEIPT_DIGEST_DOMAIN,
  GAME_RUNTIME_RECEIPT_PROTOCOL,
  MAX_GAME_RUNTIME_RECEIPT_FILES,
  type GameRuntimeReceiptOutcome,
  type PublicGameRuntimeReceipt
} from './game-runtime-receipts.js'

const attemptIds = [
  '00000000-0000-0000-0000-000000000001',
  '00000000-0000-0000-0000-000000000002',
  '00000000-0000-0000-0000-000000000003',
  '00000000-0000-0000-0000-000000000004'
] as const
const bindingId = '10000000-0000-0000-0000-000000000001'
const publicReceiptPropertyNames = [
  'protocol',
  'schemaVersion',
  'attemptId',
  'bindingId',
  'version',
  'outcome',
  'errorCode',
  'restartExpected',
  'startedAt',
  'publishedAt',
  'completedAt',
  'projectRootIdentityVerified',
  'dataRootIdentityVerified',
  'receiptSha256'
] as const

let fixtureRoot = ''
let dataRoot = ''
let projectRoot = ''
let receiptRoot = ''

beforeEach(async () => {
  fixtureRoot = await realpath(await mkdtemp(path.join(os.tmpdir(), 'dyson-runtime-receipts-')))
  dataRoot = path.join(fixtureRoot, 'data')
  projectRoot = path.join(fixtureRoot, 'project')
  receiptRoot = path.join(dataRoot, 'state', 'game-runtime-receipts')
  await Promise.all([
    mkdir(receiptRoot, { recursive: true }),
    mkdir(projectRoot, { recursive: true })
  ])
})

afterEach(async () => {
  await rm(fixtureRoot, { recursive: true, force: true })
})

describe('file game runtime receipt source', () => {
  it('returns an empty page when the receipt directory does not exist', async () => {
    await rm(receiptRoot, { recursive: true })
    const source = new FileGameRuntimeReceiptSource({ dataRoot, projectRoot })

    await expect(source.list()).resolves.toEqual({ items: [], nextCursor: null })
  })

  it('accepts a plain receipt tree relative to its canonical volume root', async () => {
    await persist(receipt(attemptIds[0]))
    const source = new FileGameRuntimeReceiptSource({ dataRoot, projectRoot })
    const volumeRoot = path.parse(dataRoot).root
    const expectedCanonicalDataRoot = path.resolve(
      await realpath(volumeRoot),
      path.relative(volumeRoot, dataRoot)
    )

    expect(await realpath(dataRoot)).toBe(expectedCanonicalDataRoot)
    await expect(source.list()).resolves.toMatchObject({
      items: [{ attemptId: attemptIds[0], dataRootIdentityVerified: true }]
    })
  })

  it('returns canonical privacy-safe receipts newest-first with a stable cursor', async () => {
    const raw = await Promise.all([
      persist(receipt(attemptIds[0], '2026-09-01T01:00:00.0000000+00:00')),
      persist(receipt(attemptIds[1], '2026-09-01T02:00:00.0000000+00:00')),
      persist(receipt(attemptIds[2], '2026-09-01T03:00:00.0000000+00:00'))
    ])
    const source = new FileGameRuntimeReceiptSource({ dataRoot, projectRoot })

    const first = await source.list({ limit: 2 })
    expect(first.items.map((item) => item.attemptId)).toEqual([attemptIds[2], attemptIds[1]])
    const newest = first.items[0]!
    expect(Object.keys(newest)).toEqual(publicReceiptPropertyNames)
    expect(newest).toMatchObject({
      protocol: GAME_RUNTIME_RECEIPT_PROTOCOL,
      projectRootIdentityVerified: true,
      dataRootIdentityVerified: true
    })
    const { receiptSha256, ...publicCore } = newest
    expect(receiptSha256).toBe(publicReceiptDigest(publicCore))
    expect(receiptSha256).not.toBe(sha256(raw[2]))
    expect(first.nextCursor).toBe(
      'eyJ2IjoxLCJjb21wbGV0ZWRBdCI6IjIwMjYtMDktMDFUMDI6MDA6MDAuMDAwMDAwMCswMDowMCIsImF0dGVtcHRJZCI6IjAwMDAwMDAwLTAwMDAtMDAwMC0wMDAwLTAwMDAwMDAwMDAwMiJ9'
    )
    const serialized = JSON.stringify(first)
    expect(serialized).not.toContain(fixtureRoot)
    expect(serialized).not.toContain('"projectRootSha256":')
    expect(serialized).not.toContain('"dataRootIdentity":')
    expect(serialized).not.toContain(pathIdentity(projectRoot))
    expect(serialized).not.toContain(pathIdentity(dataRoot))

    await persist(receipt(attemptIds[3], '2026-09-01T04:00:00.0000000+00:00'))
    const second = await source.list({ limit: 2, cursor: first.nextCursor })
    expect(second.items.map((item) => item.attemptId)).toEqual([attemptIds[0]])
    expect(second.nextCursor).toBeNull()
  })

  it('makes the public receipt and digest independent of both private root identities', async () => {
    const primaryReceipt = receipt(attemptIds[0])
    const primaryRaw = await persist(primaryReceipt)
    const otherDataRoot = path.join(fixtureRoot, 'other-data')
    const otherProjectRoot = path.join(fixtureRoot, 'other-project')
    const otherReceiptRoot = path.join(otherDataRoot, 'state', 'game-runtime-receipts')
    await Promise.all([
      mkdir(otherReceiptRoot, { recursive: true }),
      mkdir(otherProjectRoot, { recursive: true })
    ])
    const otherReceipt: RuntimeReceipt = {
      ...primaryReceipt,
      projectRootSha256: pathIdentity(otherProjectRoot),
      dataRootIdentity: pathIdentity(otherDataRoot)
    }
    const otherRaw = await persistAt(otherReceiptRoot, otherReceipt)

    const primaryPublic = (await new FileGameRuntimeReceiptSource({ dataRoot, projectRoot }).list()).items[0]!
    const otherPublic = (await new FileGameRuntimeReceiptSource({
      dataRoot: otherDataRoot,
      projectRoot: otherProjectRoot
    }).list()).items[0]!

    expect(sha256(primaryRaw)).not.toBe(sha256(otherRaw))
    expect(primaryPublic).toEqual(otherPublic)
    expect(primaryPublic.receiptSha256).toBe(otherPublic.receiptSha256)
    expect(primaryPublic.receiptSha256).not.toBe(sha256(primaryRaw))
    expect(otherPublic.receiptSha256).not.toBe(sha256(otherRaw))
  })

  it.each([
    ['clean-exit', null, false, '2026-09-01T00:00:01.0000000+00:00'],
    ['abnormal-exit', 'BOOTSTRAP_RELEASE_START_FAILED', true, '2026-09-01T00:00:01.0000000+00:00'],
    ['finalization-failure', 'BOOTSTRAP_BINDING_FINALIZE_FAILED', true, '2026-09-01T00:00:01.0000000+00:00']
  ] as const)('accepts the canonical %s outcome contract', async (outcome, errorCode, restartExpected, publishedAt) => {
    await persist(receipt(attemptIds[0], '2026-09-01T00:00:02.0000000+00:00', {
      outcome, errorCode, restartExpected, publishedAt
    }))
    const source = new FileGameRuntimeReceiptSource({ dataRoot, projectRoot })

    await expect(source.list()).resolves.toMatchObject({
      items: [{ outcome, errorCode, restartExpected }]
    })
  })

  it('accepts a canonical pre-publication startup failure with nullable bindings', async () => {
    await persist(receipt(attemptIds[0], '2026-09-01T00:00:02.0000000+00:00', {
      outcome: 'startup-failure',
      errorCode: 'BOOTSTRAP_ACTIVE_RELEASE_INVALID',
      restartExpected: true,
      publishedAt: null,
      bindingId: null,
      version: null,
      projectRootSha256: null
    }))
    const source = new FileGameRuntimeReceiptSource({ dataRoot, projectRoot })

    await expect(source.list()).resolves.toMatchObject({
      items: [{
        outcome: 'startup-failure',
        bindingId: null,
        projectRootIdentityVerified: false,
        dataRootIdentityVerified: true
      }]
    })
  })

  it.each([
    ['wrong data identity', () => receipt(attemptIds[0], undefined, { dataRootIdentity: 'f'.repeat(64) })],
    ['wrong project identity', () => receipt(attemptIds[0], undefined, { projectRootSha256: 'e'.repeat(64) })],
    ['published receipt without project identity', () => receipt(attemptIds[0], undefined, {
      projectRootSha256: null
    })],
    ['outcome mismatch', () => receipt(attemptIds[0], undefined, { errorCode: 'BOOTSTRAP_START_FAILED' })],
    ['timestamp reversal', () => receipt(attemptIds[0], '2026-08-31T23:59:59.0000000+00:00')],
    ['missing data identity', () => without(receipt(attemptIds[0]), ['dataRootIdentity'])],
    ['unknown property', () => ({ ...receipt(attemptIds[0]), rawError: 'private failure' })],
    ['public verification field in private receipt', () => ({
      ...receipt(attemptIds[0]), dataRootIdentityVerified: true
    })],
    ['misordered properties', () => {
      const value = receipt(attemptIds[0])
      return { schemaVersion: value.schemaVersion, protocol: value.protocol, ...without(value, ['protocol', 'schemaVersion']) }
    }]
  ])('fails closed for %s', async (_name, makeValue) => {
    await persist(makeValue() as RuntimeReceipt)
    const source = new FileGameRuntimeReceiptSource({ dataRoot, projectRoot })

    await expect(source.list()).rejects.toMatchObject({ code: 'GAME_RUNTIME_RECEIPTS_UNAVAILABLE' })
  })

  it('rejects a non-null project identity when no project root is configured', async () => {
    await persist(receipt(attemptIds[0]))
    const source = new FileGameRuntimeReceiptSource({ dataRoot, projectRoot: null })

    await expect(source.list()).rejects.toMatchObject({ code: 'GAME_RUNTIME_RECEIPTS_UNAVAILABLE' })
  })

  it('rejects non-canonical JSON, malformed UTF-8, oversized files, and filename binding drift', async () => {
    const source = new FileGameRuntimeReceiptSource({ dataRoot, projectRoot })
    const target = path.join(receiptRoot, `${attemptIds[0]}.json`)

    await writeFile(target, `${JSON.stringify(receipt(attemptIds[0]))}\n`, 'utf8')
    await expect(source.list()).rejects.toMatchObject({ code: 'GAME_RUNTIME_RECEIPTS_UNAVAILABLE' })

    await writeFile(target, Buffer.from([0xc3, 0x28]))
    await expect(source.list()).rejects.toMatchObject({ code: 'GAME_RUNTIME_RECEIPTS_UNAVAILABLE' })

    await writeFile(target, Buffer.alloc(8_193, 0x20))
    await expect(source.list()).rejects.toMatchObject({ code: 'GAME_RUNTIME_RECEIPTS_UNAVAILABLE' })

    await writeFile(target, JSON.stringify(receipt(attemptIds[1])), 'utf8')
    await expect(source.list()).rejects.toMatchObject({ code: 'GAME_RUNTIME_RECEIPTS_UNAVAILABLE' })
  })

  it('rejects redirected roots and files plus every unknown directory entry', async () => {
    const source = new FileGameRuntimeReceiptSource({ dataRoot, projectRoot })
    await writeFile(path.join(receiptRoot, 'unknown.txt'), 'not a receipt', 'utf8')
    await expect(source.list()).rejects.toMatchObject({ code: 'GAME_RUNTIME_RECEIPTS_UNAVAILABLE' })

    await rm(path.join(receiptRoot, 'unknown.txt'))
    if (process.platform !== 'win32') {
      const outsideFile = path.join(fixtureRoot, 'outside.json')
      await writeFile(outsideFile, JSON.stringify(receipt(attemptIds[0])), 'utf8')
      await symlink(outsideFile, path.join(receiptRoot, `${attemptIds[0]}.json`), 'file')
      await expect(source.list()).rejects.toMatchObject({ code: 'GAME_RUNTIME_RECEIPTS_UNAVAILABLE' })
    }

    await rm(receiptRoot, { recursive: true })
    const outsideDirectory = path.join(fixtureRoot, 'redirected-receipts')
    await mkdir(outsideDirectory)
    try {
      await symlink(outsideDirectory, receiptRoot, process.platform === 'win32' ? 'junction' : 'dir')
    } catch (error) {
      if (!['EPERM', 'EACCES', 'UNKNOWN', 'ENOTSUP', 'ENOSYS'].some((code) => hasCode(error, code))) throw error
      await expect(realpath(receiptRoot)).rejects.toMatchObject({ code: 'ENOENT' })
      return
    }
    await expect(source.list()).rejects.toMatchObject({ code: 'GAME_RUNTIME_RECEIPTS_UNAVAILABLE' })
  })

  it('fails closed before reading a directory beyond the fixed scan bound', async () => {
    const writes: Promise<void>[] = []
    for (let index = 0; index <= MAX_GAME_RUNTIME_RECEIPT_FILES; index += 1) {
      writes.push(writeFile(path.join(receiptRoot, `entry-${index}.tmp`), 'x'))
    }
    await Promise.all(writes)
    const source = new FileGameRuntimeReceiptSource({ dataRoot, projectRoot })

    await expect(source.list()).rejects.toMatchObject({ code: 'GAME_RUNTIME_RECEIPTS_UNAVAILABLE' })
  })

  it('rejects invalid limits and non-canonical cursors with the same bounded error', async () => {
    const source = new FileGameRuntimeReceiptSource({ dataRoot, projectRoot })
    const validPayload = {
      v: 1,
      completedAt: '2026-09-01T02:00:00.0000000+00:00',
      attemptId: attemptIds[1]
    }

    await expect(source.list({ limit: 51 })).rejects.toMatchObject({ code: 'GAME_RUNTIME_RECEIPTS_UNAVAILABLE' })
    await expect(source.list({ cursor: 'not-a-canonical-cursor' })).rejects.toMatchObject({
      code: 'GAME_RUNTIME_RECEIPTS_UNAVAILABLE'
    })
    await expect(source.list({ cursor: encodeCursor({
      ...validPayload,
      dataRootIdentity: 'f'.repeat(64)
    }) })).rejects.toMatchObject({ code: 'GAME_RUNTIME_RECEIPTS_UNAVAILABLE' })
    await expect(source.list({ cursor: encodeCursor({
      attemptId: validPayload.attemptId,
      completedAt: validPayload.completedAt,
      v: validPayload.v
    }) })).rejects.toMatchObject({ code: 'GAME_RUNTIME_RECEIPTS_UNAVAILABLE' })
  })
})

interface RuntimeReceipt {
  protocol: typeof GAME_RUNTIME_RECEIPT_PROTOCOL
  schemaVersion: 1
  attemptId: string
  bindingId: string | null
  version: string | null
  outcome: GameRuntimeReceiptOutcome
  errorCode: string | null
  restartExpected: boolean
  startedAt: string
  publishedAt: string | null
  completedAt: string
  projectRootSha256: string | null
  dataRootIdentity: string
}

function hasCode(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === code
}

function receipt(
  attemptId: string,
  completedAt = '2026-09-01T00:00:02.0000000+00:00',
  overrides: Partial<RuntimeReceipt> = {}
): RuntimeReceipt {
  return {
    protocol: GAME_RUNTIME_RECEIPT_PROTOCOL,
    schemaVersion: 1,
    attemptId,
    bindingId,
    version: '1.2.3',
    outcome: 'clean-exit',
    errorCode: null,
    restartExpected: false,
    startedAt: '2026-09-01T00:00:00.0000000+00:00',
    publishedAt: '2026-09-01T00:00:01.0000000+00:00',
    completedAt,
    projectRootSha256: pathIdentity(projectRoot),
    dataRootIdentity: pathIdentity(dataRoot),
    ...overrides
  }
}

async function persist(value: RuntimeReceipt): Promise<Buffer> {
  return persistAt(receiptRoot, value)
}

async function persistAt(targetRoot: string, value: RuntimeReceipt): Promise<Buffer> {
  const bytes = Buffer.from(JSON.stringify(value), 'utf8')
  await writeFile(path.join(targetRoot, `${value.attemptId}.json`), bytes)
  return bytes
}

function publicReceiptDigest(value: Omit<PublicGameRuntimeReceipt, 'receiptSha256'>): string {
  return sha256(Buffer.from(
    GAME_RUNTIME_PUBLIC_RECEIPT_DIGEST_DOMAIN + JSON.stringify(value),
    'utf8'
  ))
}

function encodeCursor(value: unknown): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url')
}

function pathIdentity(root: string): string {
  return sha256(Buffer.from(path.resolve(root).toUpperCase(), 'utf8'))
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

function without<T extends object, K extends keyof T>(value: T, keys: readonly K[]): Omit<T, K> {
  const copy = { ...value }
  for (const key of keys) delete copy[key]
  return copy
}
