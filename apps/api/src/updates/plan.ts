import { z } from 'zod'
import { normalizeVersion, sha256Schema, sourceIdSchema, type VersionComponent } from './version.js'

export type UpdateTargetKind = VersionComponent
export type UpdatePlanState =
  | 'planned' | 'staging' | 'staged' | 'activating' | 'active'
  | 'rolling-back' | 'rolled-back' | 'failed'
export type UpdateTargetState = 'pending' | 'staged' | 'active' | 'rolled-back'

export interface ReleaseIdentity {
  sourceId: string
  version: string
  sha256: string
}

export interface UpdateTarget {
  targetId: string
  kind: UpdateTargetKind
  current: ReleaseIdentity
  candidate: ReleaseIdentity
  state: UpdateTargetState
}

export interface UpdateFailure {
  phase: 'staging' | 'activation' | 'rollback'
  errorCode: string
  summary: string
}

export interface UpdatePlan {
  schemaVersion: 1
  planId: string
  state: UpdatePlanState
  revision: number
  createdAt: string
  updatedAt: string
  rollbackRequired: boolean
  failure: UpdateFailure | null
  targets: UpdateTarget[]
}

export type UpdatePlanEvent =
  | { type: 'begin-staging'; at: string }
  | { type: 'mark-staged'; at: string; targetId: string }
  | { type: 'complete-staging'; at: string }
  | { type: 'begin-activation'; at: string }
  | { type: 'mark-activated'; at: string; targetId: string }
  | { type: 'complete-activation'; at: string }
  | { type: 'begin-rollback'; at: string }
  | { type: 'mark-rolled-back'; at: string; targetId: string }
  | { type: 'complete-rollback'; at: string }
  | { type: 'fail'; at: string; errorCode: string; summary: string }

export class UpdatePlanTransitionError extends Error {
  readonly code: string

  constructor(code: string) {
    super(code)
    this.name = 'UpdatePlanTransitionError'
    this.code = code
  }
}

const planIdSchema = z.string().min(8).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/)
const targetIdSchema = z.string().min(3).max(160).regex(/^[A-Za-z0-9][A-Za-z0-9._:/+-]*$/)
const isoDateSchema = z.string().datetime({ offset: true })
const errorCodeSchema = z.string().min(3).max(48).regex(/^[A-Z][A-Z0-9_]*$/)
const releaseIdentityInputSchema = z.strictObject({
  sourceId: sourceIdSchema,
  version: z.string().trim().min(1).max(64),
  sha256: sha256Schema
})
const updateTargetInputSchema = z.strictObject({
  targetId: targetIdSchema,
  kind: z.enum(['dsp', 'nebula', 'bepinex', 'plugin']),
  current: releaseIdentityInputSchema,
  candidate: releaseIdentityInputSchema
})

export const updatePlanInputSchema = z.strictObject({
  planId: planIdSchema,
  createdAt: isoDateSchema,
  targets: z.array(updateTargetInputSchema).min(1).max(128)
})

const updateFailureSchema = z.strictObject({
  phase: z.enum(['staging', 'activation', 'rollback']),
  errorCode: errorCodeSchema,
  summary: z.string().min(1).max(256)
})
const releaseIdentitySchema = z.strictObject({
  sourceId: sourceIdSchema,
  version: z.string().min(1).max(64),
  sha256: sha256Schema
})
const updateTargetSchema = z.strictObject({
  targetId: targetIdSchema,
  kind: z.enum(['dsp', 'nebula', 'bepinex', 'plugin']),
  current: releaseIdentitySchema,
  candidate: releaseIdentitySchema,
  state: z.enum(['pending', 'staged', 'active', 'rolled-back'])
})

export const updatePlanSchema: z.ZodType<UpdatePlan> = z.strictObject({
  schemaVersion: z.literal(1),
  planId: planIdSchema,
  state: z.enum(['planned', 'staging', 'staged', 'activating', 'active', 'rolling-back', 'rolled-back', 'failed']),
  revision: z.number().int().nonnegative().max(10_000),
  createdAt: isoDateSchema,
  updatedAt: isoDateSchema,
  rollbackRequired: z.boolean(),
  failure: updateFailureSchema.nullable(),
  targets: z.array(updateTargetSchema).min(1).max(128)
})

const simpleEvent = <T extends UpdatePlanEvent['type']>(type: T) => z.strictObject({
  type: z.literal(type), at: isoDateSchema
})
const targetEvent = <T extends 'mark-staged' | 'mark-activated' | 'mark-rolled-back'>(type: T) => z.strictObject({
  type: z.literal(type), at: isoDateSchema, targetId: targetIdSchema
})

export const updatePlanEventSchema = z.discriminatedUnion('type', [
  simpleEvent('begin-staging'),
  targetEvent('mark-staged'),
  simpleEvent('complete-staging'),
  simpleEvent('begin-activation'),
  targetEvent('mark-activated'),
  simpleEvent('complete-activation'),
  simpleEvent('begin-rollback'),
  targetEvent('mark-rolled-back'),
  simpleEvent('complete-rollback'),
  z.strictObject({
    type: z.literal('fail'), at: isoDateSchema,
    errorCode: errorCodeSchema, summary: z.string().min(1).max(256)
  })
])

export function createUpdatePlan(input: unknown): UpdatePlan {
  const parsed = updatePlanInputSchema.parse(input)
  const targets = parsed.targets.map((target) => normalizeTarget(target)).sort(compareTargets)
  assertUnique(targets.map((target) => canonicalTargetId(target.targetId)), 'UPDATE_TARGET_DUPLICATE')
  const plan: UpdatePlan = {
    schemaVersion: 1,
    planId: parsed.planId,
    state: 'planned',
    revision: 0,
    createdAt: parsed.createdAt,
    updatedAt: parsed.createdAt,
    rollbackRequired: false,
    failure: null,
    targets
  }
  assertPlanConsistency(plan)
  return plan
}

export function transitionUpdatePlan(planInput: unknown, eventInput: unknown): UpdatePlan {
  const plan = updatePlanSchema.parse(planInput)
  assertPlanConsistency(plan)
  const event = updatePlanEventSchema.parse(eventInput) as UpdatePlanEvent
  if (plan.revision >= 10_000) throw new UpdatePlanTransitionError('UPDATE_REVISION_LIMIT_REACHED')
  if (Date.parse(event.at) < Date.parse(plan.updatedAt)) {
    throw new UpdatePlanTransitionError('UPDATE_EVENT_TIME_REVERSED')
  }

  const next = structuredClone(plan)
  next.revision += 1
  next.updatedAt = event.at

  switch (event.type) {
    case 'begin-staging':
      requireState(plan, ['planned'])
      next.state = 'staging'
      break
    case 'mark-staged':
      requireState(plan, ['staging'])
      setTargetState(next, event.targetId, ['pending'], 'staged')
      break
    case 'complete-staging':
      requireState(plan, ['staging'])
      requireEveryTarget(plan, ['staged'], 'UPDATE_STAGING_INCOMPLETE')
      next.state = 'staged'
      break
    case 'begin-activation':
      requireState(plan, ['staged'])
      next.state = 'activating'
      break
    case 'mark-activated':
      requireState(plan, ['activating'])
      setTargetState(next, event.targetId, ['staged'], 'active')
      break
    case 'complete-activation':
      requireState(plan, ['activating'])
      requireEveryTarget(plan, ['active'], 'UPDATE_ACTIVATION_INCOMPLETE')
      next.state = 'active'
      break
    case 'begin-rollback':
      requireState(plan, ['activating', 'active', 'failed'])
      if (!hasChangedTarget(plan)) throw new UpdatePlanTransitionError('UPDATE_ROLLBACK_NOT_REQUIRED')
      next.state = 'rolling-back'
      next.rollbackRequired = true
      break
    case 'mark-rolled-back':
      requireState(plan, ['rolling-back'])
      setTargetState(next, event.targetId, ['staged', 'active'], 'rolled-back')
      break
    case 'complete-rollback':
      requireState(plan, ['rolling-back'])
      if (hasChangedTarget(plan)) throw new UpdatePlanTransitionError('UPDATE_ROLLBACK_INCOMPLETE')
      next.state = 'rolled-back'
      next.rollbackRequired = false
      break
    case 'fail': {
      requireState(plan, ['staging', 'activating', 'active', 'rolling-back'])
      const phase = plan.state === 'staging' ? 'staging'
        : plan.state === 'rolling-back' ? 'rollback' : 'activation'
      next.state = 'failed'
      next.failure = { phase, errorCode: event.errorCode, summary: event.summary }
      next.rollbackRequired = hasChangedTarget(plan)
      break
    }
  }
  assertPlanConsistency(next)
  return next
}

function normalizeTarget(target: z.infer<typeof updateTargetInputSchema>): UpdateTarget {
  if (target.kind === 'plugin') {
    if (canonicalTargetId(target.targetId) !== canonicalTargetId(target.current.sourceId) ||
        canonicalTargetId(target.targetId) !== canonicalTargetId(target.candidate.sourceId)) {
      throw new UpdatePlanTransitionError('UPDATE_PLUGIN_IDENTITY_MISMATCH')
    }
  } else if (target.targetId !== target.kind) {
    throw new UpdatePlanTransitionError('UPDATE_CORE_IDENTITY_MISMATCH')
  }
  const normalized: UpdateTarget = {
    targetId: target.targetId,
    kind: target.kind,
    current: normalizeRelease(target.current, target.kind),
    candidate: normalizeRelease(target.candidate, target.kind),
    state: 'pending'
  }
  if (sameRelease(normalized.current, normalized.candidate)) {
    throw new UpdatePlanTransitionError('UPDATE_RELEASE_UNCHANGED')
  }
  return normalized
}

function normalizeRelease(
  release: z.infer<typeof releaseIdentityInputSchema>,
  component: VersionComponent
): ReleaseIdentity {
  return {
    sourceId: release.sourceId,
    version: normalizeVersion(release.version, component),
    sha256: release.sha256.toLowerCase()
  }
}

function sameRelease(left: ReleaseIdentity, right: ReleaseIdentity): boolean {
  return canonicalTargetId(left.sourceId) === canonicalTargetId(right.sourceId) &&
    left.version === right.version && left.sha256 === right.sha256
}

function setTargetState(
  plan: UpdatePlan,
  targetId: string,
  allowed: UpdateTargetState[],
  state: UpdateTargetState
): void {
  const target = plan.targets.find((candidate) => canonicalTargetId(candidate.targetId) === canonicalTargetId(targetId))
  if (target === undefined) throw new UpdatePlanTransitionError('UPDATE_TARGET_UNKNOWN')
  if (!allowed.includes(target.state)) throw new UpdatePlanTransitionError('UPDATE_TARGET_STATE_INVALID')
  target.state = state
}

function requireState(plan: UpdatePlan, states: UpdatePlanState[]): void {
  if (!states.includes(plan.state)) throw new UpdatePlanTransitionError('UPDATE_PLAN_STATE_INVALID')
}

function requireEveryTarget(plan: UpdatePlan, states: UpdateTargetState[], code: string): void {
  if (!plan.targets.every((target) => states.includes(target.state))) {
    throw new UpdatePlanTransitionError(code)
  }
}

function hasChangedTarget(plan: UpdatePlan): boolean {
  return plan.targets.some((target) => target.state === 'staged' || target.state === 'active')
}

function assertPlanConsistency(plan: UpdatePlan): void {
  assertUnique(plan.targets.map((target) => canonicalTargetId(target.targetId)), 'UPDATE_TARGET_DUPLICATE')
  for (const target of plan.targets) assertTargetConsistency(target)
  const sortedTargetIds = [...plan.targets].sort(compareTargets).map((target) => target.targetId)
  if (sortedTargetIds.some((targetId, index) => targetId !== plan.targets[index]?.targetId)) {
    throw new UpdatePlanTransitionError('UPDATE_PLAN_TARGET_ORDER_INVALID')
  }
  if (Date.parse(plan.updatedAt) < Date.parse(plan.createdAt)) {
    throw new UpdatePlanTransitionError('UPDATE_PLAN_TIME_INVALID')
  }
  if (plan.state === 'planned' && plan.targets.some((target) => target.state !== 'pending')) {
    throw new UpdatePlanTransitionError('UPDATE_PLAN_SNAPSHOT_INVALID')
  }
  if (plan.state === 'staged' && plan.targets.some((target) => target.state !== 'staged')) {
    throw new UpdatePlanTransitionError('UPDATE_PLAN_SNAPSHOT_INVALID')
  }
  if (plan.state === 'active' && plan.targets.some((target) => target.state !== 'active')) {
    throw new UpdatePlanTransitionError('UPDATE_PLAN_SNAPSHOT_INVALID')
  }
  if (plan.state === 'rolled-back' && hasChangedTarget(plan)) {
    throw new UpdatePlanTransitionError('UPDATE_PLAN_SNAPSHOT_INVALID')
  }
  if (plan.state === 'failed' && plan.failure === null) {
    throw new UpdatePlanTransitionError('UPDATE_PLAN_SNAPSHOT_INVALID')
  }
  if (plan.state === 'failed' && plan.rollbackRequired !== hasChangedTarget(plan)) {
    throw new UpdatePlanTransitionError('UPDATE_PLAN_SNAPSHOT_INVALID')
  }
  if (plan.state === 'rolling-back' && !plan.rollbackRequired) {
    throw new UpdatePlanTransitionError('UPDATE_PLAN_SNAPSHOT_INVALID')
  }
  if (plan.state === 'staging' && plan.targets.some((target) => target.state !== 'pending' && target.state !== 'staged')) {
    throw new UpdatePlanTransitionError('UPDATE_PLAN_SNAPSHOT_INVALID')
  }
  if (plan.state === 'activating' && plan.targets.some((target) => target.state !== 'staged' && target.state !== 'active')) {
    throw new UpdatePlanTransitionError('UPDATE_PLAN_SNAPSHOT_INVALID')
  }
}

function assertTargetConsistency(target: UpdateTarget): void {
  if (target.kind === 'plugin') {
    if (canonicalTargetId(target.targetId) !== canonicalTargetId(target.current.sourceId) ||
        canonicalTargetId(target.targetId) !== canonicalTargetId(target.candidate.sourceId)) {
      throw new UpdatePlanTransitionError('UPDATE_PLUGIN_IDENTITY_MISMATCH')
    }
  } else if (target.targetId !== target.kind) {
    throw new UpdatePlanTransitionError('UPDATE_CORE_IDENTITY_MISMATCH')
  }
  for (const release of [target.current, target.candidate]) {
    if (normalizeVersion(release.version, target.kind) !== release.version || release.sha256 !== release.sha256.toLowerCase()) {
      throw new UpdatePlanTransitionError('UPDATE_RELEASE_NOT_NORMALIZED')
    }
  }
  if (sameRelease(target.current, target.candidate)) {
    throw new UpdatePlanTransitionError('UPDATE_RELEASE_UNCHANGED')
  }
}

function assertUnique(values: readonly string[], code: string): void {
  if (new Set(values).size !== values.length) throw new UpdatePlanTransitionError(code)
}

function canonicalTargetId(value: string): string {
  return value.toLowerCase()
}

const kindOrder: Record<UpdateTargetKind, number> = { dsp: 0, bepinex: 1, nebula: 2, plugin: 3 }

function compareTargets(left: UpdateTarget, right: UpdateTarget): number {
  const kindDifference = kindOrder[left.kind] - kindOrder[right.kind]
  if (kindDifference !== 0) return kindDifference
  const leftId = canonicalTargetId(left.targetId)
  const rightId = canonicalTargetId(right.targetId)
  return leftId < rightId ? -1 : leftId > rightId ? 1 : 0
}
