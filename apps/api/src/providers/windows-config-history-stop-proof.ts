import { createHash, randomBytes } from 'node:crypto'
import path from 'node:path'
import { z } from 'zod'
import type {
  GameConfigHistoryStopProofTokenProvider
} from '../game-config/history-http.js'
import type {
  GameConfigStopProofValidator
} from '../game-config/history.js'
import type { LifecycleScriptRunner } from './powershell-runner.js'

const defaultTokenTtlMs = 120_000
const maximumTokenTtlMs = 300_000
const defaultMaximumTokens = 64
const hardMaximumTokens = 256
const tokenBytes = 32
const tokenPattern = /^[A-Za-z0-9_-]{43}$/
const uuidV4Pattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const sha256Pattern = /^[0-9a-f]{64}$/i

const restoreIssueContextSchema = z.strictObject({
  operation: z.literal('restore'),
  requestId: z.string().regex(uuidV4Pattern).transform((value) => value.toLowerCase()),
  snapshotId: z.string().regex(uuidV4Pattern).transform((value) => value.toLowerCase()),
  expectedCurrentRevision: z.string().regex(sha256Pattern).transform((value) => value.toLowerCase()),
  dryRun: z.boolean()
})
const reconcileIssueContextSchema = z.strictObject({ operation: z.literal('reconcile') })
const issueContextSchema = z.discriminatedUnion('operation', [
  restoreIssueContextSchema,
  reconcileIssueContextSchema
])
const validationContextSchema = z.strictObject({
  token: z.string().regex(tokenPattern),
  requestId: z.string().regex(uuidV4Pattern).transform((value) => value.toLowerCase()),
  snapshotId: z.string().regex(uuidV4Pattern).transform((value) => value.toLowerCase()),
  phase: z.enum(['prepare', 'publish', 'reconcile'])
})
const stoppedReceiptSchema = z.strictObject({
  protocol: z.literal('DYSON_CONTROL_RUNTIME_V1'),
  expected: z.literal('stopped'),
  state: z.literal('matched'),
  processVerified: z.literal(true),
  gamePortListening: z.literal(false)
})
const optionsSchema = z.strictObject({
  projectRoot: z.string().min(1).max(1_024).refine((value) =>
    path.isAbsolute(value) && !/[\r\n\0]/.test(value)
  ),
  gamePort: z.number().int().min(1).max(65_535),
  runner: z.custom<LifecycleScriptRunner>((value) =>
    typeof value === 'object' && value !== null &&
    typeof (value as { run?: unknown }).run === 'function'
  ),
  tokenTtlMs: z.number().int().min(1_000).max(maximumTokenTtlMs),
  maximumTokens: z.number().int().min(1).max(hardMaximumTokens),
  now: z.custom<() => number>((value) => typeof value === 'function')
})

export type WindowsConfigHistoryStopProofErrorCode =
  | 'WINDOWS_CONFIG_HISTORY_STOP_PROOF_OPTIONS_INVALID'
  | 'WINDOWS_CONFIG_HISTORY_STOP_PROOF_CONTEXT_INVALID'
  | 'WINDOWS_CONFIG_HISTORY_STOP_PROOF_RUNTIME_UNAVAILABLE'
  | 'WINDOWS_CONFIG_HISTORY_STOP_PROOF_CAPACITY_EXCEEDED'
  | 'WINDOWS_CONFIG_HISTORY_STOP_PROOF_TOKEN_UNAVAILABLE'

export class WindowsConfigHistoryStopProofError extends Error {
  constructor(readonly code: WindowsConfigHistoryStopProofErrorCode) {
    super(code)
    this.name = 'WindowsConfigHistoryStopProofError'
  }
}

export interface WindowsConfigHistoryStopProofOptions {
  /** Trusted, construction-time project root; never sourced from an HTTP request. */
  projectRoot: string
  gamePort: number
  runner: LifecycleScriptRunner
  tokenTtlMs?: number
  maximumTokens?: number
  /** @internal Deterministic monotonic wall clock for unit tests. */
  now?: () => number
}

interface RestoreGrant {
  operation: 'restore'
  requestId: string
  snapshotId: string
  expiresAt: number
}

interface ReconcileGrant {
  operation: 'reconcile'
  expiresAt: number
}

type StopProofGrant = RestoreGrant | ReconcileGrant

/**
 * Issues short-lived, process-local capabilities only after a fixed Windows
 * runtime check. Raw tokens are returned to the server-side controller but are
 * never stored; the in-memory registry keeps only SHA-256 token digests.
 */
export class WindowsConfigHistoryStopProofAuthorizer {
  readonly #projectRoot: string
  readonly #gamePort: number
  readonly #runner: LifecycleScriptRunner
  readonly #tokenTtlMs: number
  readonly #maximumTokens: number
  readonly #now: () => number
  readonly #grants = new Map<string, StopProofGrant>()
  #issueTail: Promise<void> = Promise.resolve()

  constructor(options: WindowsConfigHistoryStopProofOptions) {
    const parsed = optionsSchema.safeParse({
      ...options,
      tokenTtlMs: options?.tokenTtlMs ?? defaultTokenTtlMs,
      maximumTokens: options?.maximumTokens ?? defaultMaximumTokens,
      now: options?.now ?? Date.now
    })
    if (!parsed.success) {
      throw new WindowsConfigHistoryStopProofError(
        'WINDOWS_CONFIG_HISTORY_STOP_PROOF_OPTIONS_INVALID'
      )
    }
    this.#projectRoot = path.resolve(parsed.data.projectRoot)
    this.#gamePort = parsed.data.gamePort
    this.#runner = parsed.data.runner
    this.#tokenTtlMs = parsed.data.tokenTtlMs
    this.#maximumTokens = parsed.data.maximumTokens
    this.#now = parsed.data.now
  }

  readonly issue: GameConfigHistoryStopProofTokenProvider = async (context) => {
    const parsed = issueContextSchema.safeParse(context)
    if (!parsed.success) {
      throw new WindowsConfigHistoryStopProofError(
        'WINDOWS_CONFIG_HISTORY_STOP_PROOF_CONTEXT_INVALID'
      )
    }

    const pending = this.#issueTail.then(
      () => this.#issueGrant(parsed.data),
      () => this.#issueGrant(parsed.data)
    )
    this.#issueTail = pending.then(() => undefined, () => undefined)
    return pending
  }

  readonly validate: GameConfigStopProofValidator = async (context) => {
    const parsed = validationContextSchema.safeParse(context)
    if (!parsed.success) return false
    let now: number
    try {
      now = this.#nowMs()
    } catch {
      return false
    }
    this.#pruneExpired(now)
    const digest = digestToken(parsed.data.token)
    const grant = this.#grants.get(digest)
    if (!grant || grant.expiresAt <= now || !grantMatches(grant, parsed.data)) return false

    try {
      await this.#proveStopped()
      const verifiedAt = this.#nowMs()
      const currentGrant = this.#grants.get(digest)
      if (!currentGrant || currentGrant !== grant || grant.expiresAt <= verifiedAt) {
        if (grant.expiresAt <= verifiedAt) this.#grants.delete(digest)
        return false
      }
      return true
    } catch {
      return false
    }
  }

  async #issueGrant(context: z.output<typeof issueContextSchema>): Promise<string> {
    const now = this.#nowMs()
    this.#pruneExpired(now)
    if (this.#grants.size >= this.#maximumTokens) {
      throw new WindowsConfigHistoryStopProofError(
        'WINDOWS_CONFIG_HISTORY_STOP_PROOF_CAPACITY_EXCEEDED'
      )
    }
    await this.#proveStopped()
    const verifiedAt = this.#nowMs()
    this.#pruneExpired(verifiedAt)
    if (this.#grants.size >= this.#maximumTokens) {
      throw new WindowsConfigHistoryStopProofError(
        'WINDOWS_CONFIG_HISTORY_STOP_PROOF_CAPACITY_EXCEEDED'
      )
    }

    for (let attempt = 0; attempt < 4; attempt++) {
      let token: string
      try {
        token = randomBytes(tokenBytes).toString('base64url')
      } catch {
        throw new WindowsConfigHistoryStopProofError(
          'WINDOWS_CONFIG_HISTORY_STOP_PROOF_TOKEN_UNAVAILABLE'
        )
      }
      const digest = digestToken(token)
      if (!tokenPattern.test(token) || this.#grants.has(digest)) continue
      const expiresAt = verifiedAt + this.#tokenTtlMs
      this.#grants.set(digest, context.operation === 'restore'
        ? {
            operation: 'restore',
            requestId: context.requestId,
            snapshotId: context.snapshotId,
            expiresAt
          }
        : { operation: 'reconcile', expiresAt })
      return token
    }
    throw new WindowsConfigHistoryStopProofError(
      'WINDOWS_CONFIG_HISTORY_STOP_PROOF_TOKEN_UNAVAILABLE'
    )
  }

  async #proveStopped(): Promise<void> {
    try {
      const output = await this.#runner.run(
        'Test-DysonRuntimeState.ps1',
        [
          '-ProjectRoot', this.#projectRoot,
          '-Expected', 'stopped',
          '-GamePort', String(this.#gamePort)
        ],
        new AbortController().signal
      )
      stoppedReceiptSchema.parse(JSON.parse(output) as unknown)
    } catch {
      throw new WindowsConfigHistoryStopProofError(
        'WINDOWS_CONFIG_HISTORY_STOP_PROOF_RUNTIME_UNAVAILABLE'
      )
    }
  }

  #nowMs(): number {
    const value = this.#now()
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new WindowsConfigHistoryStopProofError(
        'WINDOWS_CONFIG_HISTORY_STOP_PROOF_OPTIONS_INVALID'
      )
    }
    return value
  }

  #pruneExpired(now: number): void {
    for (const [digest, grant] of this.#grants) {
      if (grant.expiresAt <= now) this.#grants.delete(digest)
    }
  }
}

function grantMatches(
  grant: StopProofGrant,
  context: z.output<typeof validationContextSchema>
): boolean {
  if (grant.operation === 'restore') {
    return context.phase !== 'reconcile' &&
      context.requestId === grant.requestId && context.snapshotId === grant.snapshotId
  }
  return context.phase === 'reconcile'
}

function digestToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex')
}
