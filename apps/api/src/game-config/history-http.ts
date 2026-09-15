import { z } from 'zod'
import {
  GameConfigHistoryError,
  type GameConfigHistoryDiff,
  type GameConfigHistoryErrorCode,
  type GameConfigRecoveryResult,
  type GameConfigRestoreReceipt,
  type GameConfigSnapshotDetail,
  type GameConfigSnapshotSummary,
  type RestoreGameConfigurationRequest
} from './history.js'

const uuidV4Pattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const sha256Pattern = /^[0-9a-f]{64}$/i
const maximumStopProofTokenLength = 2_048
const maximumSnapshots = 128
const maximumSnapshotBytes = 4 * 1024 * 1024
const maximumRecoveryResults = 32

export const gameConfigHistoryHttpConfirmations = Object.freeze({
  capture: 'CREATE_CONFIG_SNAPSHOT',
  restore: 'RESTORE_CONFIG_SNAPSHOT',
  reconcile: 'RECONCILE_CONFIG_RESTORE'
} as const)

const emptyInputSchema = z.strictObject({})
const uuidV4Schema = z.string().regex(uuidV4Pattern).transform((value) => value.toLowerCase())
const sha256Schema = z.string().regex(sha256Pattern).transform((value) => value.toLowerCase())
const confirmationSchema = z.string().min(1).max(64).regex(/^[A-Z_]+$/)
const snapshotInputSchema = z.strictObject({ snapshotId: uuidV4Schema })
const captureInputSchema = z.strictObject({ confirmation: confirmationSchema })
const reconcileInputSchema = z.strictObject({ confirmation: confirmationSchema })
const restoreInputSchema = z.strictObject({
  requestId: uuidV4Schema,
  snapshotId: uuidV4Schema,
  expectedCurrentRevision: sha256Schema,
  dryRun: z.boolean().optional().default(false),
  confirmation: confirmationSchema
})

const isoTimestampSchema = z.string().min(20).max(32).refine((value) => {
  const parsed = new Date(value)
  return Number.isFinite(parsed.valueOf()) && parsed.toISOString() === value
})
const fileIdSchema = z.enum(['nebula', 'galaxy', 'bepinex', 'bridge'])
const publicValueSchema = z.union([
  z.boolean(),
  z.number().finite(),
  z.strictObject({ configured: z.boolean() })
])
const snapshotSummarySchema = z.strictObject({
  format: z.literal('dyson-control-game-config-snapshot'),
  snapshotId: uuidV4Schema,
  kind: z.enum(['manual', 'pre-restore']),
  createdAt: isoTimestampSchema,
  revision: sha256Schema,
  manifestSha256: sha256Schema,
  fileCount: z.number().int().min(0).max(4),
  totalBytes: z.number().int().min(0).max(maximumSnapshotBytes)
})
const snapshotDetailSchema = snapshotSummarySchema.extend({
  files: z.array(z.strictObject({
    id: fileIdSchema,
    present: z.boolean(),
    bytes: z.number().int().min(0).max(maximumSnapshotBytes)
  })).max(4)
}).strict()
const snapshotListSchema = z.array(snapshotSummarySchema).max(maximumSnapshots)
const historyDiffSchema = z.strictObject({
  snapshotId: uuidV4Schema,
  currentRevision: sha256Schema,
  targetRevision: sha256Schema,
  files: z.array(z.strictObject({
    id: fileIdSchema,
    beforePresent: z.boolean(),
    afterPresent: z.boolean(),
    changed: z.boolean()
  })).max(4),
  settings: z.array(z.strictObject({
    id: z.string().min(1).max(128).regex(/^[a-z0-9.-]+$/),
    file: fileIdSchema,
    before: publicValueSchema,
    after: publicValueSchema,
    changed: z.boolean()
  })).max(64)
})
const historyErrorCodeSchema = z.enum([
  'CONFIG_HISTORY_REQUEST_INVALID',
  'CONFIG_HISTORY_REQUEST_CONFLICT',
  'CONFIG_HISTORY_ROOT_UNAVAILABLE',
  'CONFIG_HISTORY_STORAGE_UNAVAILABLE',
  'CONFIG_HISTORY_BUSY',
  'CONFIG_HISTORY_CAPACITY_EXCEEDED',
  'CONFIG_HISTORY_SNAPSHOT_INVALID',
  'CONFIG_HISTORY_REVISION_CONFLICT',
  'CONFIG_HISTORY_STOP_PROOF_REJECTED',
  'CONFIG_HISTORY_RECONCILIATION_REQUIRED',
  'CONFIG_HISTORY_COMMIT_FAILED',
  'CONFIG_HISTORY_ROLLBACK_FAILED',
  'CONFIG_HISTORY_INTERRUPTED_RECOVERED',
  'CONFIG_HISTORY_HOST_LEASE_BUSY',
  'CONFIG_HISTORY_HOST_LEASE_DIRTY',
  'CONFIG_HISTORY_HOST_LEASE_RECOVERY_REQUIRED',
  'CONFIG_HISTORY_HOST_LEASE_LOST',
  'CONFIG_HISTORY_HOST_LEASE_UNAVAILABLE'
])
const receiptSchema = z.strictObject({
  format: z.literal('dyson-control-game-config-restore-receipt'),
  version: z.literal(1),
  requestId: uuidV4Schema,
  snapshotId: uuidV4Schema,
  protectionSnapshotId: uuidV4Schema.nullable(),
  status: z.enum([
    'busy',
    'dry-run',
    'restored',
    'rejected',
    'rolled-back',
    'recovery-required',
    'interrupted-recovered'
  ]),
  dryRun: z.boolean(),
  expectedCurrentRevision: sha256Schema,
  targetRevision: sha256Schema.nullable(),
  finalRevision: sha256Schema.nullable(),
  errorCode: z.union([historyErrorCodeSchema, z.literal('NONE')]),
  startedAt: isoTimestampSchema,
  finishedAt: isoTimestampSchema,
  persisted: z.boolean(),
  reused: z.boolean()
})
const recoveryResultSchema = z.strictObject({
  requestId: uuidV4Schema,
  status: z.enum(['committed-cleanup', 'interrupted-recovered', 'recovery-required']),
  finalRevision: sha256Schema.nullable(),
  errorCode: z.union([historyErrorCodeSchema, z.literal('NONE')])
})
const recoveryResultsSchema = z.array(recoveryResultSchema).max(maximumRecoveryResults)

export interface GameConfigHistoryHttpService {
  list(): Promise<GameConfigSnapshotSummary[]>
  detail(snapshotId: string): Promise<GameConfigSnapshotDetail>
  diff(snapshotId: string): Promise<GameConfigHistoryDiff>
  capture(): Promise<GameConfigSnapshotDetail>
  restore(request: RestoreGameConfigurationRequest): Promise<GameConfigRestoreReceipt>
  reconcileInterrupted(stopProofToken: string): Promise<GameConfigRecoveryResult[]>
}

export type GameConfigHistoryHttpMutationContext =
  | Readonly<{ operation: 'capture' }>
  | Readonly<{
    operation: 'restore'
    requestId: string
    snapshotId: string
    expectedCurrentRevision: string
    dryRun: boolean
  }>
  | Readonly<{ operation: 'reconcile' }>

export type GameConfigHistoryStopProofProviderContext = Extract<
  GameConfigHistoryHttpMutationContext,
  { operation: 'restore' | 'reconcile' }
>

export type GameConfigHistoryMutationGate = (
  context: GameConfigHistoryHttpMutationContext
) => boolean | Promise<boolean>

export type GameConfigHistoryStopProofTokenProvider = (
  context: GameConfigHistoryStopProofProviderContext
) => string | Promise<string>

export interface GameConfigHistoryHttpOptions {
  service: GameConfigHistoryHttpService
  /** Mutations remain locked unless the embedding application explicitly opts in. */
  mutationGate?: GameConfigHistoryMutationGate
  /** Trusted server-side provider; browser input is never forwarded to it as a token. */
  stopProofTokenProvider: GameConfigHistoryStopProofTokenProvider
}

export interface GameConfigHistoryHttpSuccess<T> {
  ok: true
  data: T
}

export interface GameConfigHistoryHttpFailure<T = never> {
  ok: false
  error: { code: string }
  data?: T
}

export interface GameConfigHistoryHttpResult<T> {
  statusCode: number
  body: GameConfigHistoryHttpSuccess<T> | GameConfigHistoryHttpFailure<T>
}

/**
 * Fastify-independent, bounded HTTP contract around GameConfigHistoryService.
 * It deliberately receives no request path, command, URL, file name, role, or
 * stop-proof token. Authentication/authorization belongs to the embedding app;
 * this layer provides a separate default-closed mutation gate.
 */
export class GameConfigHistoryHttpController {
  readonly #service: GameConfigHistoryHttpService
  readonly #mutationGate: GameConfigHistoryMutationGate
  readonly #stopProofTokenProvider: GameConfigHistoryStopProofTokenProvider

  constructor(options: GameConfigHistoryHttpOptions) {
    this.#service = options.service
    this.#mutationGate = options.mutationGate ?? (() => false)
    this.#stopProofTokenProvider = options.stopProofTokenProvider
  }

  async list(input: unknown): Promise<GameConfigHistoryHttpResult<GameConfigSnapshotSummary[]>> {
    try {
      emptyInputSchema.parse(input)
      return success(200, parseCoreOutput(snapshotListSchema, await this.#service.list()))
    } catch (error) {
      return failureFrom(error)
    }
  }

  async detail(input: unknown): Promise<GameConfigHistoryHttpResult<GameConfigSnapshotDetail>> {
    try {
      const { snapshotId } = snapshotInputSchema.parse(input)
      return success(200, parseCoreOutput(snapshotDetailSchema, await this.#service.detail(snapshotId)))
    } catch (error) {
      return failureFrom(error, true)
    }
  }

  async diff(input: unknown): Promise<GameConfigHistoryHttpResult<GameConfigHistoryDiff>> {
    try {
      const { snapshotId } = snapshotInputSchema.parse(input)
      return success(200, parseCoreOutput(historyDiffSchema, await this.#service.diff(snapshotId)))
    } catch (error) {
      return failureFrom(error, true)
    }
  }

  /** Read-only alias for callers presenting a restore preview workflow. */
  async preview(input: unknown): Promise<GameConfigHistoryHttpResult<GameConfigHistoryDiff>> {
    return this.diff(input)
  }

  async capture(input: unknown): Promise<GameConfigHistoryHttpResult<GameConfigSnapshotDetail>> {
    try {
      const { confirmation } = captureInputSchema.parse(input)
      assertConfirmation(confirmation, gameConfigHistoryHttpConfirmations.capture)
      await this.#assertMutationAllowed({ operation: 'capture' })
      return success(201, parseCoreOutput(snapshotDetailSchema, await this.#service.capture()))
    } catch (error) {
      return failureFrom(error)
    }
  }

  async restore(input: unknown): Promise<GameConfigHistoryHttpResult<GameConfigRestoreReceipt>> {
    try {
      const parsed = restoreInputSchema.parse(input)
      assertConfirmation(parsed.confirmation, gameConfigHistoryHttpConfirmations.restore)
      const context: Extract<GameConfigHistoryHttpMutationContext, { operation: 'restore' }> = {
        operation: 'restore',
        requestId: parsed.requestId,
        snapshotId: parsed.snapshotId,
        expectedCurrentRevision: parsed.expectedCurrentRevision,
        dryRun: parsed.dryRun
      }
      await this.#assertMutationAllowed(context)
      const stopProofToken = await this.#provideStopProofToken(context)
      const receipt = parseCoreOutput(receiptSchema, await this.#service.restore({
        requestId: parsed.requestId,
        snapshotId: parsed.snapshotId,
        expectedCurrentRevision: parsed.expectedCurrentRevision,
        dryRun: parsed.dryRun,
        stopProofToken
      }))
      assertReceiptMatchesRequest(receipt, parsed)
      if (receipt.status === 'restored' || receipt.status === 'dry-run') {
        if (receipt.errorCode !== 'NONE') throw responseInvalid()
        return success(200, receipt)
      }
      if (receipt.errorCode === 'NONE') throw responseInvalid()
      return failureWithData(statusForCoreCode(receipt.errorCode), receipt.errorCode, receipt)
    } catch (error) {
      return failureFrom(error)
    }
  }

  async reconcile(input: unknown): Promise<GameConfigHistoryHttpResult<GameConfigRecoveryResult[]>> {
    try {
      const { confirmation } = reconcileInputSchema.parse(input)
      assertConfirmation(confirmation, gameConfigHistoryHttpConfirmations.reconcile)
      const context = { operation: 'reconcile' } as const
      await this.#assertMutationAllowed(context)
      const stopProofToken = await this.#provideStopProofToken(context)
      const results = parseCoreOutput(
        recoveryResultsSchema,
        await this.#service.reconcileInterrupted(stopProofToken)
      )
      assertRecoveryResultsConsistent(results)
      const failureResult = results.find((result) => result.status === 'recovery-required')
      if (failureResult) {
        return failureWithData(
          statusForCoreCode(failureResult.errorCode),
          failureResult.errorCode,
          results
        )
      }
      return success(200, results)
    } catch (error) {
      return failureFrom(error)
    }
  }

  async #assertMutationAllowed(context: GameConfigHistoryHttpMutationContext): Promise<void> {
    let allowed: boolean
    try {
      allowed = await this.#mutationGate(context)
    } catch {
      throw new HistoryHttpFault(503, 'CONFIG_HISTORY_HTTP_GATE_UNAVAILABLE')
    }
    if (allowed !== true) {
      throw new HistoryHttpFault(423, 'CONFIG_HISTORY_HTTP_MUTATION_DISABLED')
    }
  }

  async #provideStopProofToken(context: GameConfigHistoryStopProofProviderContext): Promise<string> {
    let token: string
    try {
      token = await this.#stopProofTokenProvider(context)
    } catch {
      throw new HistoryHttpFault(503, 'CONFIG_HISTORY_HTTP_STOP_PROOF_UNAVAILABLE')
    }
    if (typeof token !== 'string' || token.length < 1 ||
        token.length > maximumStopProofTokenLength || /[\r\n\0]/.test(token)) {
      throw new HistoryHttpFault(503, 'CONFIG_HISTORY_HTTP_STOP_PROOF_UNAVAILABLE')
    }
    return token
  }
}

function parseCoreOutput<TSchema extends z.ZodType>(schema: TSchema, value: unknown): z.output<TSchema> {
  const result = schema.safeParse(value)
  if (!result.success) throw responseInvalid()
  return result.data
}

function assertConfirmation(actual: string, expected: string): void {
  if (actual !== expected) {
    throw new HistoryHttpFault(422, 'CONFIG_HISTORY_HTTP_CONFIRMATION_INVALID')
  }
}

function assertReceiptMatchesRequest(
  receipt: GameConfigRestoreReceipt,
  request: z.output<typeof restoreInputSchema>
): void {
  if (receipt.requestId !== request.requestId || receipt.snapshotId !== request.snapshotId ||
      receipt.expectedCurrentRevision !== request.expectedCurrentRevision ||
      receipt.dryRun !== request.dryRun ||
      (receipt.status === 'dry-run') !== request.dryRun ||
      (receipt.status === 'restored' && request.dryRun)) {
    throw responseInvalid()
  }
}

function assertRecoveryResultsConsistent(results: readonly GameConfigRecoveryResult[]): void {
  const requestIds = new Set<string>()
  for (const result of results) {
    if (requestIds.has(result.requestId)) throw responseInvalid()
    requestIds.add(result.requestId)
    if (result.status === 'committed-cleanup' && result.errorCode !== 'NONE') throw responseInvalid()
    if (result.status === 'interrupted-recovered' &&
        result.errorCode !== 'CONFIG_HISTORY_INTERRUPTED_RECOVERED') throw responseInvalid()
    if (result.status === 'recovery-required' && result.errorCode === 'NONE') throw responseInvalid()
  }
}

function success<T>(statusCode: number, data: T): GameConfigHistoryHttpResult<T> {
  return { statusCode, body: { ok: true, data } }
}

function failure<T = never>(statusCode: number, code: string): GameConfigHistoryHttpResult<T> {
  return { statusCode, body: { ok: false, error: { code } } }
}

function failureWithData<T>(
  statusCode: number,
  code: string,
  data: T
): GameConfigHistoryHttpResult<T> {
  return { statusCode, body: { ok: false, error: { code }, data } }
}

function failureFrom(
  error: unknown,
  snapshotLookup = false
): GameConfigHistoryHttpResult<never> {
  if (error instanceof HistoryHttpFault) return failure(error.statusCode, error.code)
  if (error instanceof z.ZodError) return failure(400, 'CONFIG_HISTORY_HTTP_REQUEST_INVALID')
  if (error instanceof GameConfigHistoryError) {
    if (snapshotLookup && error.code === 'CONFIG_HISTORY_SNAPSHOT_INVALID') {
      return failure(404, 'CONFIG_HISTORY_HTTP_SNAPSHOT_NOT_FOUND')
    }
    return failure(statusForCoreCode(error.code), error.code)
  }
  return failure(503, 'CONFIG_HISTORY_HTTP_UNAVAILABLE')
}

function statusForCoreCode(code: GameConfigHistoryErrorCode | 'NONE'): number {
  if (code === 'CONFIG_HISTORY_BUSY' || code === 'CONFIG_HISTORY_STOP_PROOF_REJECTED' ||
      code === 'CONFIG_HISTORY_HOST_LEASE_BUSY') return 423
  if (code === 'CONFIG_HISTORY_REQUEST_CONFLICT' || code === 'CONFIG_HISTORY_REVISION_CONFLICT') return 409
  if (code === 'CONFIG_HISTORY_REQUEST_INVALID' || code === 'CONFIG_HISTORY_SNAPSHOT_INVALID') return 422
  return 503
}

function responseInvalid(): HistoryHttpFault {
  return new HistoryHttpFault(503, 'CONFIG_HISTORY_HTTP_RESPONSE_INVALID')
}

class HistoryHttpFault extends Error {
  constructor(readonly statusCode: number, readonly code: string) {
    super(code)
    this.name = 'HistoryHttpFault'
  }
}
