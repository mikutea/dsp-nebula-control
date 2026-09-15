import path from 'node:path'
import { isIP } from 'node:net'
import { z } from 'zod'
import {
  clientQualificationProjectionSchema,
  type ClientQualificationProjection,
  type ProtectedClientQualificationConsumer,
  type QualificationConsumeRequest
} from '../client-profile/index.js'

export const hostnameWssQualificationScriptName =
  'Test-DysonHostnameWssQualification.ps1' as const
export type HostnameWssQualificationScriptName =
  typeof hostnameWssQualificationScriptName

export const hostnameWssQualificationConsumeConfirmation =
  'I_CONFIRM_CONSUME_HOSTNAME_WSS_QUALIFICATION_V1' as const

export interface WindowsHostnameWssQualificationPowerShellRunner {
  run(
    scriptName: HostnameWssQualificationScriptName,
    scriptArguments: string[],
    signal: AbortSignal
  ): Promise<string>
}

export interface FixedWindowsHostnameWssQualificationConsumerOptions {
  evidenceRoot: string
  buildHarvestRootA: string
  buildHarvestRootB: string
  keyRingRoot: string
  replayRoot: string
  expectedAuthority: string
  runner: WindowsHostnameWssQualificationPowerShellRunner
}

const consumeRequestSchema = z.strictObject({
  qualificationId: z.string().regex(
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
  ),
  runId: z.string().regex(
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
  ),
  bindingSha256: z.string().regex(/^sha256:[0-9a-f]{64}$/),
  expiresAtUtc: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
    .refine((value) => {
      const milliseconds = Date.parse(value)
      return Number.isFinite(milliseconds) && new Date(milliseconds).toISOString() === value
    })
})

export class WindowsHostnameWssQualificationError extends Error {
  readonly code: string

  constructor(code: string) {
    super(code)
    this.name = 'WindowsHostnameWssQualificationError'
    this.code = code
  }
}

/**
 * Fixed production boundary for the protected PowerShell replay ledger.
 * Request data selects only one canonical qualification UUID. All roots,
 * authority, port, verifier script and confirmation text are server-owned.
 */
export class FixedWindowsHostnameWssQualificationConsumer
implements ProtectedClientQualificationConsumer {
  readonly #evidenceRoot: string
  readonly #buildHarvestRootA: string
  readonly #buildHarvestRootB: string
  readonly #keyRingRoot: string
  readonly #replayRoot: string
  readonly #expectedAuthority: string
  readonly #runner: WindowsHostnameWssQualificationPowerShellRunner

  constructor(options: FixedWindowsHostnameWssQualificationConsumerOptions) {
    this.#evidenceRoot = fixedAbsoluteNonRoot(options.evidenceRoot)
    this.#buildHarvestRootA = fixedAbsoluteNonRoot(options.buildHarvestRootA)
    this.#buildHarvestRootB = fixedAbsoluteNonRoot(options.buildHarvestRootB)
    this.#keyRingRoot = fixedAbsoluteNonRoot(options.keyRingRoot)
    this.#replayRoot = fixedAbsoluteNonRoot(options.replayRoot)
    this.#expectedAuthority = fixedPublicAuthority(options.expectedAuthority)
    this.#runner = options.runner
    const roots = [
      this.#evidenceRoot,
      this.#buildHarvestRootA,
      this.#buildHarvestRootB,
      this.#keyRingRoot,
      this.#replayRoot
    ]
    for (let left = 0; left < roots.length; left += 1) {
      for (let right = left + 1; right < roots.length; right += 1) {
        if (pathsOverlap(roots[left]!, roots[right]!)) {
          throw new WindowsHostnameWssQualificationError(
            'HOSTNAME_WSS_QUALIFICATION_FIXED_ROOT_OVERLAP'
          )
        }
      }
    }
  }

  async consumeQualification(
    input: QualificationConsumeRequest
  ): Promise<ClientQualificationProjection> {
    let request: z.output<typeof consumeRequestSchema>
    try {
      request = consumeRequestSchema.parse(input)
    } catch {
      throw new WindowsHostnameWssQualificationError(
        'HOSTNAME_WSS_QUALIFICATION_CONSUME_REQUEST_INVALID'
      )
    }

    const evidenceRoot = path.join(this.#evidenceRoot, request.qualificationId)
    let output: string
    try {
      output = await this.#runner.run(hostnameWssQualificationScriptName, [
        '-EvidenceRoot', evidenceRoot,
        '-BuildHarvestRootA', this.#buildHarvestRootA,
        '-BuildHarvestRootB', this.#buildHarvestRootB,
        '-KeyRingRoot', this.#keyRingRoot,
        '-ReplayRoot', this.#replayRoot,
        '-ExpectedQualificationId', request.qualificationId,
        '-ExpectedAuthority', this.#expectedAuthority,
        '-ExpectedPort', '443',
        '-Consume',
        '-Confirmation', hostnameWssQualificationConsumeConfirmation
      ], new AbortController().signal)
    } catch {
      throw new WindowsHostnameWssQualificationError(
        'HOSTNAME_WSS_QUALIFICATION_CONSUME_FAILED'
      )
    }

    let projection: ClientQualificationProjection
    try {
      projection = clientQualificationProjectionSchema.parse(JSON.parse(output))
    } catch {
      throw new WindowsHostnameWssQualificationError(
        'HOSTNAME_WSS_QUALIFICATION_PROJECTION_INVALID'
      )
    }
    if (projection.qualificationId !== request.qualificationId ||
        projection.runId !== request.runId ||
        projection.bindingSha256 !== request.bindingSha256 ||
        projection.expiresAtUtc !== request.expiresAtUtc) {
      throw new WindowsHostnameWssQualificationError(
        'HOSTNAME_WSS_QUALIFICATION_PROJECTION_MISMATCH'
      )
    }
    return projection
  }
}

function fixedAbsoluteNonRoot(value: string): string {
  if (!path.isAbsolute(value)) {
    throw new WindowsHostnameWssQualificationError(
      'HOSTNAME_WSS_QUALIFICATION_FIXED_ROOT_INVALID'
    )
  }
  const resolved = path.resolve(value)
  if (resolved === path.parse(resolved).root) {
    throw new WindowsHostnameWssQualificationError(
      'HOSTNAME_WSS_QUALIFICATION_FIXED_ROOT_INVALID'
    )
  }
  return resolved
}

function fixedPublicAuthority(value: string): string {
  if (isIP(value) !== 0 || value !== value.toLowerCase() || value === 'localhost' ||
      value.endsWith('.') || value.includes('..') ||
      !/^(?=.{4,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])$/.test(value)) {
    throw new WindowsHostnameWssQualificationError(
      'HOSTNAME_WSS_QUALIFICATION_AUTHORITY_INVALID'
    )
  }
  return value
}

function pathsOverlap(left: string, right: string): boolean {
  return pathContains(left, right) || pathContains(right, left)
}

function pathContains(parent: string, candidate: string): boolean {
  const relative = path.relative(parent, candidate)
  return relative === '' ||
    (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
}
