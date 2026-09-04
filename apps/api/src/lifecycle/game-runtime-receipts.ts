import path from 'node:path'
import { createHash } from 'node:crypto'
import { lstat, open, opendir, realpath, type FileHandle } from 'node:fs/promises'
import type { BigIntStats, Dirent } from 'node:fs'
import { TextDecoder } from 'node:util'
import { z } from 'zod'

export const GAME_RUNTIME_RECEIPT_PROTOCOL = 'DYSON_CONTROL_GAME_RUNTIME_RECEIPT_V1' as const
export const GAME_RUNTIME_PUBLIC_RECEIPT_DIGEST_DOMAIN =
  'DYSON_CONTROL_GAME_RUNTIME_RECEIPT_PUBLIC_PROJECTION_V1\0' as const
export const DEFAULT_GAME_RUNTIME_RECEIPT_LIMIT = 20
export const MAX_GAME_RUNTIME_RECEIPT_LIMIT = 50
export const MAX_GAME_RUNTIME_RECEIPT_CURSOR_LENGTH = 256
export const MAX_GAME_RUNTIME_RECEIPT_BYTES = 8_192
export const MAX_GAME_RUNTIME_RECEIPT_FILES = 2_048

const receiptPropertyNames = [
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
  'projectRootSha256',
  'dataRootIdentity'
] as const

const canonicalGuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const hashPattern = /^[0-9a-f]{64}$/
const versionPattern = /^[0-9A-Za-z][0-9A-Za-z._+-]{0,63}$/
const errorCodePattern = /^BOOTSTRAP_[A-Z0-9_]{1,96}$/
const cursorTextPattern = /^[A-Za-z0-9_-]+$/
const timestampPattern = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})\.(\d{7})(Z|[+-]\d{2}:\d{2})$/
const receiptOutcomes = [
  'clean-exit',
  'abnormal-exit',
  'startup-failure',
  'finalization-failure'
] as const

const nullableCanonicalGuidSchema = z.union([z.string().regex(canonicalGuidPattern), z.null()])
const nullableVersionSchema = z.union([z.string().regex(versionPattern), z.null()])
const nullableErrorCodeSchema = z.union([z.string().regex(errorCodePattern), z.null()])
const nullableTimestampSchema = z.union([z.string().max(64), z.null()])
const nullableHashSchema = z.union([z.string().regex(hashPattern), z.null()])
const receiptSchema = z.strictObject({
  protocol: z.literal(GAME_RUNTIME_RECEIPT_PROTOCOL),
  schemaVersion: z.literal(1),
  attemptId: z.string().regex(canonicalGuidPattern),
  bindingId: nullableCanonicalGuidSchema,
  version: nullableVersionSchema,
  outcome: z.enum(receiptOutcomes),
  errorCode: nullableErrorCodeSchema,
  restartExpected: z.boolean(),
  startedAt: z.string().max(64),
  publishedAt: nullableTimestampSchema,
  completedAt: z.string().max(64),
  projectRootSha256: nullableHashSchema,
  dataRootIdentity: z.string().regex(hashPattern)
})
const cursorPayloadSchema = z.strictObject({
  v: z.literal(1),
  completedAt: z.string().max(64),
  attemptId: z.string().regex(canonicalGuidPattern)
})

type PersistedGameRuntimeReceipt = z.infer<typeof receiptSchema>

export const gameRuntimeReceiptListQuerySchema = z.strictObject({
  limit: z.coerce.number().int().min(1).max(MAX_GAME_RUNTIME_RECEIPT_LIMIT).optional(),
  cursor: z.string().min(1).max(MAX_GAME_RUNTIME_RECEIPT_CURSOR_LENGTH)
    .regex(cursorTextPattern).optional()
})

export type GameRuntimeReceiptOutcome = (typeof receiptOutcomes)[number]

export interface PublicGameRuntimeReceipt {
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
  projectRootIdentityVerified: boolean
  dataRootIdentityVerified: true
  receiptSha256: string
}

type PublicGameRuntimeReceiptCore = Omit<PublicGameRuntimeReceipt, 'receiptSha256'>

export interface GameRuntimeReceiptListInput {
  limit?: number
  cursor?: string | null
}

export interface GameRuntimeReceiptPage {
  items: PublicGameRuntimeReceipt[]
  nextCursor: string | null
}

export interface GameRuntimeReceiptSource {
  list(input?: GameRuntimeReceiptListInput): Promise<GameRuntimeReceiptPage>
}

export class GameRuntimeReceiptReadError extends Error {
  readonly code = 'GAME_RUNTIME_RECEIPTS_UNAVAILABLE' as const

  constructor() {
    super('GAME_RUNTIME_RECEIPTS_UNAVAILABLE')
    this.name = 'GameRuntimeReceiptReadError'
  }
}

export interface FileGameRuntimeReceiptSourceOptions {
  dataRoot: string
  projectRoot: string | null
}

interface ValidatedReceipt {
  receipt: PublicGameRuntimeReceipt
  completedAtTicks: bigint
}

interface CursorAnchor {
  completedAt: string
  completedAtTicks: bigint
  attemptId: string
}

export class FileGameRuntimeReceiptSource implements GameRuntimeReceiptSource {
  readonly #dataRoot: string
  readonly #stateRoot: string
  readonly #receiptRoot: string
  readonly #dataRootIdentity: string
  readonly #projectRootIdentity: string | null

  constructor(options: FileGameRuntimeReceiptSourceOptions) {
    this.#dataRoot = path.resolve(options.dataRoot)
    this.#stateRoot = path.resolve(this.#dataRoot, 'state')
    this.#receiptRoot = path.resolve(this.#stateRoot, 'game-runtime-receipts')
    if (!samePath(path.dirname(this.#stateRoot), this.#dataRoot) ||
        !samePath(path.dirname(this.#receiptRoot), this.#stateRoot)) {
      throw new GameRuntimeReceiptReadError()
    }
    this.#dataRootIdentity = pathIdentity(this.#dataRoot)
    this.#projectRootIdentity = options.projectRoot === null
      ? null
      : pathIdentity(path.resolve(options.projectRoot))
  }

  async list(input: GameRuntimeReceiptListInput = {}): Promise<GameRuntimeReceiptPage> {
    try {
      const limit = input.limit ?? DEFAULT_GAME_RUNTIME_RECEIPT_LIMIT
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_GAME_RUNTIME_RECEIPT_LIMIT ||
          (input.cursor !== undefined && input.cursor !== null && typeof input.cursor !== 'string')) {
        throw new Error('invalid input')
      }
      const cursor = input.cursor === undefined || input.cursor === null
        ? null
        : decodeCursor(input.cursor)
      const receiptRootInitial = await lstatIfPresent(this.#receiptRoot)
      if (receiptRootInitial === null) return { items: [], nextCursor: null }

      const [dataRootInitial, stateRootInitial] = await Promise.all([
        lstat(this.#dataRoot, { bigint: true }),
        lstat(this.#stateRoot, { bigint: true })
      ])
      await assertPlainCanonicalDirectory(this.#dataRoot, dataRootInitial)
      await assertPlainCanonicalDirectory(this.#stateRoot, stateRootInitial)
      await assertPlainCanonicalDirectory(this.#receiptRoot, receiptRootInitial)

      const entries = await readBoundedEntries(this.#receiptRoot)
      const receipts: ValidatedReceipt[] = []
      for (const entry of entries) {
        if (!entry.isFile() || entry.isSymbolicLink() ||
            !entry.name.endsWith('.json') ||
            !canonicalGuidPattern.test(entry.name.slice(0, -5))) {
          throw new Error('invalid entry')
        }
        receipts.push(await readReceipt(
          this.#receiptRoot,
          entry.name,
          this.#dataRootIdentity,
          this.#projectRootIdentity
        ))
      }

      const [dataRootFinal, stateRootFinal, receiptRootFinal] = await Promise.all([
        lstat(this.#dataRoot, { bigint: true }),
        lstat(this.#stateRoot, { bigint: true }),
        lstat(this.#receiptRoot, { bigint: true })
      ])
      if (!sameDirectoryIdentity(dataRootInitial, dataRootFinal) ||
          !sameDirectoryIdentity(stateRootInitial, stateRootFinal) ||
          !sameDirectoryIdentity(receiptRootInitial, receiptRootFinal)) {
        throw new Error('directory changed')
      }
      await Promise.all([
        assertPlainCanonicalDirectory(this.#dataRoot, dataRootFinal),
        assertPlainCanonicalDirectory(this.#stateRoot, stateRootFinal),
        assertPlainCanonicalDirectory(this.#receiptRoot, receiptRootFinal)
      ])

      receipts.sort(compareNewestFirst)
      const eligible = cursor === null
        ? receipts
        : receipts.filter((entry) => isOlderThanCursor(entry, cursor))
      const page = eligible.slice(0, limit)
      const nextCursor = eligible.length > page.length && page.length > 0
        ? encodeCursor(page[page.length - 1]!)
        : null
      return { items: page.map((entry) => entry.receipt), nextCursor }
    } catch {
      throw new GameRuntimeReceiptReadError()
    }
  }
}

async function lstatIfPresent(target: string): Promise<BigIntStats | null> {
  try {
    return await lstat(target, { bigint: true })
  } catch (error) {
    if (isMissing(error)) return null
    throw error
  }
}

async function assertPlainCanonicalDirectory(target: string, metadata: BigIntStats): Promise<void> {
  if (!metadata.isDirectory() || metadata.isSymbolicLink() ||
      !await hasExpectedRealPath(target)) {
    throw new Error('invalid directory')
  }
}

async function hasExpectedRealPath(target: string): Promise<boolean> {
  const resolvedTarget = path.resolve(target)
  const volumeRoot = path.parse(resolvedTarget).root
  // A mapped drive legitimately expands to its UNC share. Canonicalize only
  // that root so a redirect in any descendant still changes the final path.
  const canonicalVolumeRoot = await realpath(volumeRoot)
  const expectedRealPath = path.resolve(
    canonicalVolumeRoot,
    path.relative(volumeRoot, resolvedTarget)
  )
  return samePath(await realpath(resolvedTarget), expectedRealPath)
}

async function readBoundedEntries(directoryPath: string): Promise<Dirent[]> {
  const entries: Dirent[] = []
  const directory = await opendir(directoryPath)
  for await (const entry of directory) {
    entries.push(entry)
    if (entries.length > MAX_GAME_RUNTIME_RECEIPT_FILES) throw new Error('entry limit exceeded')
  }
  return entries
}

async function readReceipt(
  receiptRoot: string,
  fileName: string,
  expectedDataRootIdentity: string,
  expectedProjectRootIdentity: string | null
): Promise<ValidatedReceipt> {
  const attemptId = fileName.slice(0, -5)
  const filePath = path.resolve(receiptRoot, fileName)
  if (!samePath(path.dirname(filePath), receiptRoot)) throw new Error('file escaped')

  const initial = await lstat(filePath, { bigint: true })
  if (!initial.isFile() || initial.isSymbolicLink() || initial.size < 1n ||
      initial.size > BigInt(MAX_GAME_RUNTIME_RECEIPT_BYTES) ||
      !await hasExpectedRealPath(filePath)) {
    throw new Error('invalid file')
  }

  let handle: FileHandle | null = null
  try {
    handle = await open(filePath, 'r')
    const opened = await handle.stat({ bigint: true })
    if (!sameStableStats(initial, opened)) throw new Error('file changed')
    const bytes = await handle.readFile()
    const afterRead = await handle.stat({ bigint: true })
    const final = await lstat(filePath, { bigint: true })
    if (bytes.byteLength !== Number(initial.size) || !sameStableStats(initial, afterRead) ||
        !sameStableStats(initial, final) || final.isSymbolicLink() ||
        !await hasExpectedRealPath(filePath)) {
      throw new Error('file changed')
    }
    return validateReceipt(bytes, attemptId, expectedDataRootIdentity, expectedProjectRootIdentity)
  } finally {
    await handle?.close()
  }
}

function validateReceipt(
  bytes: Buffer,
  fileAttemptId: string,
  expectedDataRootIdentity: string,
  expectedProjectRootIdentity: string | null
): ValidatedReceipt {
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    throw new Error('byte order mark forbidden')
  }
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  const value = JSON.parse(text) as unknown
  if (!isRecord(value) || !sameOrderedKeys(Object.keys(value), receiptPropertyNames)) {
    throw new Error('invalid properties')
  }
  const parsed = receiptSchema.safeParse(value)
  if (!parsed.success || parsed.data.attemptId !== fileAttemptId ||
      parsed.data.dataRootIdentity !== expectedDataRootIdentity ||
      (parsed.data.projectRootSha256 !== null &&
        (expectedProjectRootIdentity === null || parsed.data.projectRootSha256 !== expectedProjectRootIdentity))) {
    throw new Error('invalid receipt')
  }

  const startedAtTicks = parseTimestamp(parsed.data.startedAt)
  const publishedAtTicks = parsed.data.publishedAt === null ? null : parseTimestamp(parsed.data.publishedAt)
  const completedAtTicks = parseTimestamp(parsed.data.completedAt)
  if (startedAtTicks > completedAtTicks ||
      (publishedAtTicks !== null &&
        (publishedAtTicks < startedAtTicks || publishedAtTicks > completedAtTicks))) {
    throw new Error('invalid timestamp order')
  }
  assertOutcomeConsistency(parsed.data)

  const canonicalPersistedReceipt: PersistedGameRuntimeReceipt = {
    protocol: parsed.data.protocol,
    schemaVersion: parsed.data.schemaVersion,
    attemptId: parsed.data.attemptId,
    bindingId: parsed.data.bindingId,
    version: parsed.data.version,
    outcome: parsed.data.outcome,
    errorCode: parsed.data.errorCode,
    restartExpected: parsed.data.restartExpected,
    startedAt: parsed.data.startedAt,
    publishedAt: parsed.data.publishedAt,
    completedAt: parsed.data.completedAt,
    projectRootSha256: parsed.data.projectRootSha256,
    dataRootIdentity: parsed.data.dataRootIdentity
  }
  if (JSON.stringify(canonicalPersistedReceipt) !== text) throw new Error('non-canonical receipt')

  const publicCore: PublicGameRuntimeReceiptCore = {
    protocol: parsed.data.protocol,
    schemaVersion: parsed.data.schemaVersion,
    attemptId: parsed.data.attemptId,
    bindingId: parsed.data.bindingId,
    version: parsed.data.version,
    outcome: parsed.data.outcome,
    errorCode: parsed.data.errorCode,
    restartExpected: parsed.data.restartExpected,
    startedAt: parsed.data.startedAt,
    publishedAt: parsed.data.publishedAt,
    completedAt: parsed.data.completedAt,
    projectRootIdentityVerified: parsed.data.projectRootSha256 !== null,
    dataRootIdentityVerified: true
  }
  const receipt: PublicGameRuntimeReceipt = {
    ...publicCore,
    receiptSha256: sha256(Buffer.from(
      GAME_RUNTIME_PUBLIC_RECEIPT_DIGEST_DOMAIN + JSON.stringify(publicCore),
      'utf8'
    ))
  }
  return { receipt, completedAtTicks }
}

function assertOutcomeConsistency(receipt: PersistedGameRuntimeReceipt): void {
  const hasPublishedBinding = receipt.publishedAt !== null && receipt.bindingId !== null &&
    receipt.version !== null && receipt.projectRootSha256 !== null
  if (receipt.outcome === 'clean-exit') {
    if (receipt.errorCode !== null || receipt.restartExpected || !hasPublishedBinding) {
      throw new Error('invalid clean exit')
    }
    return
  }
  if (receipt.errorCode === null || !receipt.restartExpected) throw new Error('invalid failure')
  if (receipt.outcome === 'startup-failure') {
    if (receipt.publishedAt !== null ||
        (receipt.version !== null && receipt.projectRootSha256 === null) ||
        (receipt.bindingId !== null && (receipt.version === null || receipt.projectRootSha256 === null))) {
      throw new Error('invalid startup failure')
    }
    return
  }
  if (!hasPublishedBinding) throw new Error('invalid published failure')
}

function parseTimestamp(value: string): bigint {
  const matched = timestampPattern.exec(value)
  if (!matched) throw new Error('invalid timestamp')
  const year = Number(matched[1])
  const month = Number(matched[2])
  const day = Number(matched[3])
  const hour = Number(matched[4])
  const minute = Number(matched[5])
  const second = Number(matched[6])
  const fraction = matched[7]!
  const zone = matched[8]!
  if (year < 1 || month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month) ||
      hour > 23 || minute > 59 || second > 59) {
    throw new Error('invalid timestamp')
  }
  let offsetMinutes = 0
  if (zone !== 'Z') {
    const offsetHour = Number(zone.slice(1, 3))
    const offsetMinute = Number(zone.slice(4, 6))
    if (offsetHour > 14 || offsetMinute > 59 || (offsetHour === 14 && offsetMinute !== 0)) {
      throw new Error('invalid timestamp offset')
    }
    offsetMinutes = (offsetHour * 60 + offsetMinute) * (zone[0] === '+' ? 1 : -1)
  }
  const local = new Date(0)
  local.setUTCFullYear(year, month - 1, day)
  local.setUTCHours(hour, minute, second, Number(fraction.slice(0, 3)))
  const utcMilliseconds = local.getTime() - offsetMinutes * 60_000
  if (!Number.isFinite(utcMilliseconds)) throw new Error('invalid timestamp')
  return BigInt(utcMilliseconds) * 10_000n + BigInt(fraction.slice(3))
}

function daysInMonth(year: number, month: number): number {
  if (month === 2) return isLeapYear(year) ? 29 : 28
  return [4, 6, 9, 11].includes(month) ? 30 : 31
}

function isLeapYear(year: number): boolean {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0)
}

function compareNewestFirst(left: ValidatedReceipt, right: ValidatedReceipt): number {
  if (left.completedAtTicks !== right.completedAtTicks) {
    return left.completedAtTicks > right.completedAtTicks ? -1 : 1
  }
  return right.receipt.attemptId.localeCompare(left.receipt.attemptId, 'en')
}

function isOlderThanCursor(entry: ValidatedReceipt, cursor: CursorAnchor): boolean {
  return entry.completedAtTicks < cursor.completedAtTicks ||
    (entry.completedAtTicks === cursor.completedAtTicks && entry.receipt.attemptId < cursor.attemptId)
}

function encodeCursor(entry: ValidatedReceipt): string {
  return Buffer.from(JSON.stringify({
    v: 1,
    completedAt: entry.receipt.completedAt,
    attemptId: entry.receipt.attemptId
  }), 'utf8').toString('base64url')
}

function decodeCursor(value: string): CursorAnchor {
  if (value.length < 1 || value.length > MAX_GAME_RUNTIME_RECEIPT_CURSOR_LENGTH ||
      !cursorTextPattern.test(value)) {
    throw new Error('invalid cursor')
  }
  const decodedBytes = Buffer.from(value, 'base64url')
  if (decodedBytes.toString('base64url') !== value) throw new Error('invalid cursor')
  const decodedText = new TextDecoder('utf-8', { fatal: true }).decode(decodedBytes)
  const parsed = cursorPayloadSchema.safeParse(JSON.parse(decodedText) as unknown)
  if (!parsed.success || JSON.stringify(parsed.data) !== decodedText) throw new Error('invalid cursor')
  return {
    completedAt: parsed.data.completedAt,
    completedAtTicks: parseTimestamp(parsed.data.completedAt),
    attemptId: parsed.data.attemptId
  }
}

function pathIdentity(root: string): string {
  return sha256(Buffer.from(root.toUpperCase(), 'utf8'))
}

function sha256(value: Uint8Array): string {
  return createHash('sha256').update(value).digest('hex')
}

function samePath(left: string, right: string): boolean {
  const normalizedLeft = path.resolve(left)
  const normalizedRight = path.resolve(right)
  return process.platform === 'win32'
    ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
    : normalizedLeft === normalizedRight
}

function sameStableStats(left: BigIntStats, right: BigIntStats): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.mode === right.mode &&
    left.size === right.size && left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs &&
    left.isFile() === right.isFile() && left.isDirectory() === right.isDirectory() &&
    left.isSymbolicLink() === right.isSymbolicLink()
}

function sameDirectoryIdentity(left: BigIntStats, right: BigIntStats): boolean {
  // SMB directory content timestamps can settle after enumeration; object
  // identity remains bound by the volume/file ids and creation metadata.
  return left.dev === right.dev && left.ino === right.ino && left.mode === right.mode &&
    left.birthtimeNs === right.birthtimeNs && left.isDirectory() === right.isDirectory() &&
    left.isSymbolicLink() === right.isSymbolicLink()
}

function sameOrderedKeys(actual: string[], expected: readonly string[]): boolean {
  return actual.length === expected.length && actual.every((name, index) => name === expected[index])
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isMissing(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT'
}
