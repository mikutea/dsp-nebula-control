import { createHash } from 'node:crypto'
import { z } from 'zod'
import {
  serverStatusSchema,
  type LifecycleMutationAdapter,
  type LifecycleOperationContext,
  type StatusProvider
} from '../domain.js'
import {
  type ComponentUpdateActivationAdapters,
  type FixedUpdateSmokeRequest,
  type FixedUpdateSmokeResult,
  type ManagedUpdateComponent,
  type SaveProtectionPointReceipt,
  type SaveProtectionPointRequest,
  type StoppedStateCheckRequest,
  type StoppedStateProof
} from '../update-pipeline/activation-types.js'
import { normalizeVersion } from '../updates/version.js'

const componentSchema = z.enum(['nebula', 'bepinex', 'bridge', 'control'])
const pluginComponentSchema = z.enum(['bridge', 'control'])
const requestIdSchema = z.string().uuid()
const boundedSummarySchema = z.string().min(1).max(512)
const boundedVersionSchema = z.string().trim().min(1).max(64)
const releaseIdSchema = z.string().regex(/^(?:nebula|bepinex|bridge|control)-[0-9a-f]{32}$/)
const safeByteCountSchema = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER)

const stoppedRequestSchema = z.strictObject({
  requestId: requestIdSchema,
  component: componentSchema,
  phase: z.enum(['before-protection', 'before-publish', 'before-rollback'])
})

const protectionRequestSchema = z.strictObject({
  requestId: requestIdSchema,
  purpose: z.literal('component-update'),
  component: componentSchema,
  targetVersion: boundedVersionSchema,
  expectedRevision: z.string().regex(/^[0-9a-f]{64}$/)
})

const smokeRequestSchema = z.strictObject({
  requestId: requestIdSchema,
  component: componentSchema,
  phase: z.enum(['candidate', 'rollback', 'reconcile-candidate']),
  expectedVersion: boundedVersionSchema.nullable(),
  expectedReleaseId: releaseIdSchema.nullable()
}).superRefine((request, context) => {
  if ((request.expectedVersion === null) !== (request.expectedReleaseId === null)) {
    context.addIssue({ code: 'custom', message: 'expected version and release identity must both be present or absent' })
  }
  if (request.expectedReleaseId !== null && !request.expectedReleaseId.startsWith(`${request.component}-`)) {
    context.addIssue({ code: 'custom', message: 'release identity does not match the component' })
  }
})

const stoppedLifecycleResultSchema = z.strictObject({
  summary: boundedSummarySchema,
  evidence: z.strictObject({
    processVerified: z.literal(true),
    gamePortListening: z.literal(false)
  })
})

const runningLifecycleResultSchema = z.strictObject({
  summary: boundedSummarySchema,
  evidence: z.strictObject({
    processVerified: z.literal(true),
    gamePortListening: z.literal(true)
  })
})

const startLifecycleResultSchema = z.strictObject({
  summary: boundedSummarySchema,
  evidence: z.strictObject({
    outcome: z.enum(['started', 'already-running']),
    processVerified: z.literal(true)
  })
})

const stopLifecycleResultSchema = z.strictObject({
  summary: boundedSummarySchema,
  evidence: z.strictObject({
    outcome: z.enum(['stopped', 'already-stopped']),
    processVerified: z.literal(true)
  })
})

const protectionLifecycleResultSchema = z.strictObject({
  summary: boundedSummarySchema,
  protectionPointId: z.string().regex(/^save:[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i),
  evidence: z.strictObject({
    dsvBytes: safeByteCountSchema,
    serverBytes: safeByteCountSchema,
    manifestVerified: z.literal(true),
    reused: z.boolean()
  })
})

const probedVersionSchema = boundedVersionSchema.nullable()

export interface FixedComponentVersionProbeRequest {
  component: 'bridge' | 'control'
  signal: AbortSignal
}

/**
 * A construction-time fixed probe. Implementations may inspect only their own
 * preconfigured component locations; callers never provide a path or command.
 */
export type FixedComponentVersionProbe = (
  request: Readonly<FixedComponentVersionProbeRequest>
) => Promise<string | null>

export interface WindowsUpdateActivationAdaptersOptions {
  lifecycleAdapter: LifecycleMutationAdapter
  statusProvider: StatusProvider
  componentVersionProbe: FixedComponentVersionProbe
}

export class WindowsUpdateActivationAdapterError extends Error {
  readonly code: string

  constructor(code: string) {
    super(code)
    this.name = 'WindowsUpdateActivationAdapterError'
    this.code = code
  }
}

/**
 * Binds component activation to the existing fixed Windows lifecycle surface.
 * It owns no executable, path, task name, URL, credential, or shell argument.
 */
export class WindowsUpdateActivationAdapters implements ComponentUpdateActivationAdapters {
  readonly #lifecycleAdapter: LifecycleMutationAdapter
  readonly #statusProvider: StatusProvider
  readonly #componentVersionProbe: FixedComponentVersionProbe

  constructor(options: WindowsUpdateActivationAdaptersOptions) {
    if (options.lifecycleAdapter.mutationEnabled !== true) {
      throw new WindowsUpdateActivationAdapterError('WINDOWS_UPDATE_LIFECYCLE_DISABLED')
    }
    if (options.statusProvider.name !== 'windows') {
      throw new WindowsUpdateActivationAdapterError('WINDOWS_UPDATE_STATUS_PROVIDER_INVALID')
    }
    if (typeof options.componentVersionProbe !== 'function') {
      throw new WindowsUpdateActivationAdapterError('WINDOWS_UPDATE_VERSION_PROBE_INVALID')
    }
    this.#lifecycleAdapter = options.lifecycleAdapter
    this.#statusProvider = options.statusProvider
    this.#componentVersionProbe = options.componentVersionProbe
  }

  async verifyStoppedState(input: StoppedStateCheckRequest): Promise<StoppedStateProof> {
    const request = parseRequest(stoppedRequestSchema, input)
    const context = createLifecycleContext(
      request.requestId,
      `update-stop-check:${request.component}:${request.phase}:${request.requestId}`
    )
    try {
      stoppedLifecycleResultSchema.parse(await this.#lifecycleAdapter.verifyStopped(context))
      return { processStopped: true, portClosed: true }
    } catch {
      throw new WindowsUpdateActivationAdapterError('WINDOWS_UPDATE_STOP_PROOF_FAILED')
    }
  }

  async createSaveProtectionPoint(input: SaveProtectionPointRequest): Promise<SaveProtectionPointReceipt> {
    const request = parseRequest(protectionRequestSchema, input)
    const context = createLifecycleContext(
      request.requestId,
      `update-save-protection:${request.component}:${request.requestId}`
    )
    try {
      const result = protectionLifecycleResultSchema.parse(
        await this.#lifecycleAdapter.createProtectionPoint(context)
      )
      return {
        requestId: request.requestId,
        status: 'succeeded',
        backupId: result.protectionPointId.toLowerCase(),
        pairProtected: true,
        durable: true
      }
    } catch {
      throw new WindowsUpdateActivationAdapterError('WINDOWS_UPDATE_SAVE_PROTECTION_FAILED')
    }
  }

  async smoke(input: FixedUpdateSmokeRequest): Promise<FixedUpdateSmokeResult> {
    const request = parseRequest(smokeRequestSchema, input)
    const expectedVersion = normalizeExpectedVersion(request.component, request.expectedVersion)
    const smokeRequestId = deriveWindowsUpdateSmokeRequestId(request)
    const controller = new AbortController()
    const context = createLifecycleContext(smokeRequestId, `update-smoke:${smokeRequestId}`, controller.signal)
    let attemptedStart = false
    let stoppedProven = false
    let result: FixedUpdateSmokeResult | null = null
    let primaryError: WindowsUpdateActivationAdapterError | null = null

    try {
      attemptedStart = true
      try {
        startLifecycleResultSchema.parse(await this.#lifecycleAdapter.requestStart(context))
      } catch {
        throw new WindowsUpdateActivationAdapterError('WINDOWS_UPDATE_SMOKE_START_FAILED')
      }

      try {
        runningLifecycleResultSchema.parse(await this.#lifecycleAdapter.verifyRunning(context))
      } catch {
        throw new WindowsUpdateActivationAdapterError('WINDOWS_UPDATE_SMOKE_RUNNING_UNPROVEN')
      }

      const status = await this.#collectBoundedStatus()
      const observedVersion = await this.#observeComponentVersion(request.component, status, controller.signal)
      const loadingHealthy = status.versions.gameLoaded === true && status.versions.compatible === true &&
        status.versions.warnings.length === 0
      const normalizedBepInEx = normalizeStatusVersion(status.versions.bepInEx, 'bepinex')
      const normalizedNebula = normalizeStatusVersion(status.versions.nebula, 'nebula')
      const gamePortChecks = status.connections.filter((connection) => connection.id === 'game-port')

      result = {
        component: request.component,
        observedVersion,
        versionMatches: observedVersion === expectedVersion,
        bepInExLoaded: loadingHealthy && normalizedBepInEx !== null,
        nebulaLoaded: loadingHealthy && normalizedNebula !== null,
        processHealthy: status.state === 'running' && status.runtime.processId !== null,
        portHealthy: gamePortChecks.length === 1 && gamePortChecks[0]!.status === 'healthy'
      }

      try {
        stopLifecycleResultSchema.parse(await this.#lifecycleAdapter.requestGracefulStop(context))
      } catch {
        throw new WindowsUpdateActivationAdapterError('WINDOWS_UPDATE_SMOKE_STOP_FAILED')
      }
      try {
        stoppedLifecycleResultSchema.parse(await this.#lifecycleAdapter.verifyStopped(context))
        stoppedProven = true
      } catch {
        throw new WindowsUpdateActivationAdapterError('WINDOWS_UPDATE_SMOKE_STOP_VERIFICATION_FAILED')
      }
    } catch (error) {
      primaryError = normalizeAdapterError(error, 'WINDOWS_UPDATE_SMOKE_FAILED')
    } finally {
      if (attemptedStart && !stoppedProven) {
        try {
          stopLifecycleResultSchema.parse(await this.#lifecycleAdapter.requestGracefulStop(context))
        } catch {
          // A failed stop dispatch is followed by an independent stopped-state proof.
        }
        try {
          stoppedLifecycleResultSchema.parse(await this.#lifecycleAdapter.verifyStopped(context))
          stoppedProven = true
        } catch {
          stoppedProven = false
        }
      }
      controller.abort()
    }

    if (!stoppedProven) {
      throw new WindowsUpdateActivationAdapterError('WINDOWS_UPDATE_SMOKE_STOP_UNPROVEN')
    }
    if (primaryError !== null) throw primaryError
    if (result === null) throw new WindowsUpdateActivationAdapterError('WINDOWS_UPDATE_SMOKE_FAILED')
    return result
  }

  async #collectBoundedStatus(): Promise<z.infer<typeof serverStatusSchema>> {
    try {
      return serverStatusSchema.parse(await this.#statusProvider.collectStatus())
    } catch {
      throw new WindowsUpdateActivationAdapterError('WINDOWS_UPDATE_SMOKE_STATUS_FAILED')
    }
  }

  async #observeComponentVersion(
    component: ManagedUpdateComponent,
    status: z.infer<typeof serverStatusSchema>,
    signal: AbortSignal
  ): Promise<string | null> {
    if (component === 'nebula') return normalizeStatusVersion(status.versions.nebula, 'nebula')
    if (component === 'bepinex') return normalizeStatusVersion(status.versions.bepInEx, 'bepinex')
    const fixedComponent = pluginComponentSchema.parse(component)
    try {
      const value = probedVersionSchema.parse(await this.#componentVersionProbe(Object.freeze({
        component: fixedComponent,
        signal
      })))
      return value === null ? null : normalizeVersion(value, 'plugin')
    } catch {
      throw new WindowsUpdateActivationAdapterError('WINDOWS_UPDATE_SMOKE_VERSION_PROBE_FAILED')
    }
  }
}

export function deriveWindowsUpdateSmokeRequestId(
  input: Pick<FixedUpdateSmokeRequest, 'requestId' | 'component' | 'phase'>
): string {
  const parsed = z.strictObject({
    requestId: requestIdSchema,
    component: componentSchema,
    phase: z.enum(['candidate', 'rollback', 'reconcile-candidate'])
  }).parse({ requestId: input.requestId, component: input.component, phase: input.phase })
  const digest = createHash('sha256')
    .update('dyson-control/windows-update-smoke/v1\0', 'utf8')
    .update(parsed.requestId.toLowerCase(), 'utf8')
    .update('\0', 'utf8')
    .update(parsed.component, 'utf8')
    .update('\0', 'utf8')
    .update(parsed.phase, 'utf8')
    .digest()
  digest[6] = (digest[6]! & 0x0f) | 0x50
  digest[8] = (digest[8]! & 0x3f) | 0x80
  const hexadecimal = digest.subarray(0, 16).toString('hex')
  return `${hexadecimal.slice(0, 8)}-${hexadecimal.slice(8, 12)}-${hexadecimal.slice(12, 16)}-` +
    `${hexadecimal.slice(16, 20)}-${hexadecimal.slice(20)}`
}

function createLifecycleContext(
  requestId: string,
  jobId: string,
  signal: AbortSignal = new AbortController().signal
): LifecycleOperationContext {
  return Object.freeze({
    jobId,
    requestId: requestId.toLowerCase(),
    action: 'restart' as const,
    protectionPointId: null,
    signal
  })
}

function parseRequest<T extends z.ZodType>(schema: T, input: unknown): z.infer<T> {
  try {
    return schema.parse(input)
  } catch {
    throw new WindowsUpdateActivationAdapterError('WINDOWS_UPDATE_REQUEST_INVALID')
  }
}

function normalizeExpectedVersion(component: ManagedUpdateComponent, value: string | null): string | null {
  if (value === null) return null
  try {
    return normalizeVersion(value, component === 'nebula' ? 'nebula' : component === 'bepinex' ? 'bepinex' : 'plugin')
  } catch {
    throw new WindowsUpdateActivationAdapterError('WINDOWS_UPDATE_REQUEST_INVALID')
  }
}

function normalizeStatusVersion(value: string | null, component: 'nebula' | 'bepinex'): string | null {
  if (value === null) return null
  try {
    return normalizeVersion(value, component)
  } catch {
    throw new WindowsUpdateActivationAdapterError('WINDOWS_UPDATE_SMOKE_STATUS_FAILED')
  }
}

function normalizeAdapterError(error: unknown, fallback: string): WindowsUpdateActivationAdapterError {
  return error instanceof WindowsUpdateActivationAdapterError
    ? error
    : new WindowsUpdateActivationAdapterError(fallback)
}
