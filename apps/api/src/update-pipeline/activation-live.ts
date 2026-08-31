import { createHash, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import {
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  rmdir,
  unlink
} from 'node:fs/promises'
import type { BigIntStats } from 'node:fs'
import type { FileHandle } from 'node:fs/promises'
import { hostname, uptime } from 'node:os'
import path from 'node:path'
import { z } from 'zod'
import {
  componentReleaseManifestSchema,
  verifyExtractedComponentRelease,
  type ComponentArchiveLimits,
  type ComponentReleaseManifest,
  type ComponentReleaseManifestFile
} from './activation-archive.js'
import {
  ComponentUpdateActivationError,
  type FixedLiveComponentRoots,
  type ManagedUpdateComponent,
  type StoppedStateCheckRequest,
  type StoppedStateProof
} from './activation-types.js'
import { sha256Schema } from '../updates/version.js'
import {
  assertBepInExWindowsX64ManifestLayout,
  isKnownBepInExWindowsX64OwnedPath
} from './bepinex-layout.js'
import {
  isManagedComponentOwnedPath,
  managedPluginOwnedDirectories,
  managedPluginOwnership
} from './plugin-ownership.js'

const componentSchema = z.enum(['nebula', 'bepinex', 'bridge', 'control'])
const requestIdSchema = z.string().uuid()
const releaseIdSchema = z.string().regex(/^(?:nebula|bepinex|bridge|control)-[0-9a-f]{32}$/)
const artifactIdSchema = z.string().min(16).max(96).regex(/^[a-z0-9][a-z0-9-]+$/)
const versionSchema = z.string().min(1).max(64)
const isoDateSchema = z.string().datetime({ offset: true })
const relativePathSchema = z.string().min(1).max(240)

export const fixedLiveComponentSupport = Object.freeze({
  nebula: { supported: true, requiredPrefixes: managedPluginOwnership.nebula },
  bridge: { supported: true, requiredPrefixes: managedPluginOwnership.bridge },
  control: { supported: true, requiredPrefixes: managedPluginOwnership.control },
  bepinex: { supported: true, requiredLayoutPolicy: 'versioned-official-windows-x64-package' }
} as const)

export interface FixedLiveComponentCandidateRequest {
  requestId: string
  component: ManagedUpdateComponent
  releaseId: string
  artifactId: string
  targetVersion: string
}

export interface FixedLiveComponentDeploymentOptions {
  immutableReleaseRoot: string
  controlRoot: string
  componentRoots: FixedLiveComponentRoots
  verifyStoppedState(request: StoppedStateCheckRequest): Promise<StoppedStateProof>
  limits: ComponentArchiveLimits
  now?: () => Date
}

export interface FixedLiveComponentDeploymentReceipt {
  format: 'dyson-control-fixed-live-component-receipt'
  schemaVersion: 1
  requestId: string
  requestFingerprint: string
  component: ManagedUpdateComponent
  releaseId: string
  artifactId: string
  targetVersion: string
  status: 'published' | 'committed' | 'rolled-back'
  fileCount: number
  completedAt: string
  reused: boolean
}

export type FixedLiveReconciliationResult = 'candidate' | 'previous'

const candidateRequestSchema = z.strictObject({
  requestId: requestIdSchema,
  component: componentSchema,
  releaseId: releaseIdSchema,
  artifactId: artifactIdSchema,
  targetVersion: versionSchema
})

const releaseRecordSchema = z.strictObject({
  format: z.literal('dyson-control-component-immutable-release'),
  schemaVersion: z.literal(1),
  releaseId: releaseIdSchema,
  component: componentSchema,
  artifactId: artifactIdSchema,
  artifactSha256: sha256Schema,
  version: versionSchema,
  manifest: componentReleaseManifestSchema,
  createdAt: isoDateSchema
})

const deployedFileSchema = z.strictObject({
  relativePath: relativePathSchema,
  sizeBytes: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  sha256: sha256Schema
})

interface LiveComponentState {
  format: 'dyson-control-fixed-live-component-state'
  schemaVersion: 1
  component: ManagedUpdateComponent
  releaseId: string | null
  artifactId: string | null
  version: string | null
  files: ComponentReleaseManifestFile[]
}

const liveStateSchema: z.ZodType<LiveComponentState> = z.strictObject({
  format: z.literal('dyson-control-fixed-live-component-state'),
  schemaVersion: z.literal(1),
  component: componentSchema,
  releaseId: releaseIdSchema.nullable(),
  artifactId: artifactIdSchema.nullable(),
  version: versionSchema.nullable(),
  files: z.array(deployedFileSchema).max(512)
}).superRefine((state, context) => {
  const identityNull = state.releaseId === null && state.artifactId === null && state.version === null
  const identityPresent = state.releaseId !== null && state.artifactId !== null && state.version !== null
  if ((!identityNull && !identityPresent) || (identityNull && state.files.length !== 0)) {
    context.addIssue({ code: 'custom', message: 'live state identity mismatch' })
  }
  const seen = new Set<string>()
  for (const file of state.files) {
    const key = canonicalPathKey(file.relativePath)
    if (seen.has(key)) context.addIssue({ code: 'custom', message: 'duplicate live state path' })
    seen.add(key)
    try { assertSupportedRelativePath(state.component, file.relativePath) } catch {
      context.addIssue({ code: 'custom', message: 'unsupported live state path' })
    }
  }
})

interface FileSnapshot {
  exists: boolean
  sizeBytes: number | null
  sha256: string | null
  snapshotName: string | null
}

interface LiveJournalEntry {
  relativePath: string
  previous: FileSnapshot
  candidate: ComponentReleaseManifestFile | null
  candidateSnapshotName: string | null
}

type LiveCreatedDirectory =
  | 'BepInEx'
  | 'BepInEx/core'
  | 'plugins'
  | 'plugins/nebula-NebulaMultiplayerMod'
  | 'plugins/nebula-NebulaMultiplayerModApi'
  | 'plugins/dyson-control-bridge'
  | 'plugins/dyson-control'

const liveCreatedDirectorySchema = z.enum([
  'BepInEx',
  'BepInEx/core',
  'plugins',
  'plugins/nebula-NebulaMultiplayerMod',
  'plugins/nebula-NebulaMultiplayerModApi',
  'plugins/dyson-control-bridge',
  'plugins/dyson-control'
])

interface LiveDeploymentJournal {
  format: 'dyson-control-fixed-live-component-journal'
  schemaVersion: 1
  requestFingerprint: string
  request: z.infer<typeof candidateRequestSchema>
  phase: 'prepared' | 'published' | 'rolling-back'
  previousState: LiveComponentState
  candidateState: LiveComponentState
  createdDirectories: LiveCreatedDirectory[]
  entries: LiveJournalEntry[]
}

const snapshotSchema: z.ZodType<FileSnapshot> = z.strictObject({
  exists: z.boolean(),
  sizeBytes: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).nullable(),
  sha256: sha256Schema.nullable(),
  snapshotName: z.string().regex(/^previous-[0-9]{1,3}\.bin$/).nullable()
}).superRefine((snapshot, context) => {
  const complete = snapshot.sizeBytes !== null && snapshot.sha256 !== null && snapshot.snapshotName !== null
  if (snapshot.exists !== complete) context.addIssue({ code: 'custom', message: 'snapshot identity mismatch' })
})

const journalEntrySchema: z.ZodType<LiveJournalEntry> = z.strictObject({
  relativePath: relativePathSchema,
  previous: snapshotSchema,
  candidate: deployedFileSchema.nullable(),
  candidateSnapshotName: z.string().regex(/^candidate-[0-9]{1,3}\.bin$/).nullable()
}).superRefine((entry, context) => {
  if ((entry.candidate === null) !== (entry.candidateSnapshotName === null)) {
    context.addIssue({ code: 'custom', message: 'candidate snapshot identity mismatch' })
  }
})

const journalSchema: z.ZodType<LiveDeploymentJournal> = z.strictObject({
  format: z.literal('dyson-control-fixed-live-component-journal'),
  schemaVersion: z.literal(1),
  requestFingerprint: sha256Schema,
  request: candidateRequestSchema,
  phase: z.enum(['prepared', 'published', 'rolling-back']),
  previousState: liveStateSchema,
  candidateState: liveStateSchema,
  createdDirectories: z.array(liveCreatedDirectorySchema).max(3).default([]),
  entries: z.array(journalEntrySchema).min(1).max(1_024)
})

const receiptSchema: z.ZodType<FixedLiveComponentDeploymentReceipt> = z.strictObject({
  format: z.literal('dyson-control-fixed-live-component-receipt'),
  schemaVersion: z.literal(1),
  requestId: requestIdSchema,
  requestFingerprint: sha256Schema,
  component: componentSchema,
  releaseId: releaseIdSchema,
  artifactId: artifactIdSchema,
  targetVersion: versionSchema,
  status: z.enum(['published', 'committed', 'rolled-back']),
  fileCount: z.number().int().positive().max(512),
  completedAt: isoDateSchema,
  reused: z.boolean()
})

const stoppedProofSchema: z.ZodType<StoppedStateProof> = z.strictObject({
  processStopped: z.boolean(),
  portClosed: z.boolean()
})

interface PreparedRoots {
  immutableReleaseRoot: string
  controlRoot: string
  stateRoot: string
  journalRoot: string
  transactionRoot: string
  receiptRoot: string
  lockRoot: string
}

/** Fixed-root publisher used by activation; public methods contain no paths or commands. */
export class FixedLiveComponentDeployment {
  readonly #immutableReleaseRoot: string
  readonly #controlRoot: string
  readonly #componentRoots: FixedLiveComponentRoots
  readonly #verifyStoppedState: FixedLiveComponentDeploymentOptions['verifyStoppedState']
  readonly #limits: ComponentArchiveLimits
  readonly #now: () => Date
  #tail: Promise<void> = Promise.resolve()

  constructor(options: FixedLiveComponentDeploymentOptions) {
    if (!path.isAbsolute(options.immutableReleaseRoot) || !path.isAbsolute(options.controlRoot) ||
        Object.values(options.componentRoots).some((root) => !path.isAbsolute(root))) {
      throw new ComponentUpdateActivationError('UPDATE_LIVE_ROOT_NOT_ABSOLUTE')
    }
    this.#immutableReleaseRoot = path.resolve(options.immutableReleaseRoot)
    this.#controlRoot = path.resolve(options.controlRoot)
    this.#componentRoots = {
      nebula: path.resolve(options.componentRoots.nebula),
      bepinex: path.resolve(options.componentRoots.bepinex),
      bridge: path.resolve(options.componentRoots.bridge),
      control: path.resolve(options.componentRoots.control)
    }
    for (const liveRoot of new Set(Object.values(this.#componentRoots))) {
      if (pathsOverlap(liveRoot, this.#immutableReleaseRoot) || pathsOverlap(liveRoot, this.#controlRoot)) {
        throw new ComponentUpdateActivationError('UPDATE_LIVE_ROOT_COLLISION')
      }
    }
    this.#verifyStoppedState = options.verifyStoppedState
    this.#limits = { ...options.limits }
    this.#now = options.now ?? (() => new Date())
  }

  assertSupportedManifest(component: ManagedUpdateComponent, manifestInput: unknown): void {
    let manifest: ComponentReleaseManifest
    try {
      manifest = componentReleaseManifestSchema.parse(manifestInput)
    } catch (error) {
      throw new ComponentUpdateActivationError('UPDATE_LIVE_MANIFEST_INVALID', { cause: error })
    }
    if (manifest.component !== component || manifest.files.length === 0) {
      throw new ComponentUpdateActivationError('UPDATE_LIVE_MANIFEST_INVALID')
    }
    if (component === 'bepinex') assertBepInExWindowsX64ManifestLayout(manifest)
    for (const file of manifest.files) assertSupportedRelativePath(component, file.relativePath)
  }

  async publishCandidate(input: unknown): Promise<FixedLiveComponentDeploymentReceipt> {
    const request = parseSupportedCandidateRequest(input)
    return await this.#serialize(async () => {
      const roots = await this.#prepareRoots()
      return await this.#withLock(roots, async () => {
        const fingerprint = fingerprintRequest(request)
        const receipt = await this.#readReceipt(roots, request.requestId)
        if (receipt !== null) {
          assertReceiptIdentity(receipt, request)
          const journal = await this.#readJournal(roots, request.requestId)
          if (journal !== null) await this.#cleanupTransaction(roots, journal)
          if (receipt.status === 'rolled-back') throw new ComponentUpdateActivationError('UPDATE_LIVE_ALREADY_ROLLED_BACK')
          return { ...receipt, reused: true }
        }
        const existing = await this.#readJournal(roots, request.requestId)
        if (existing !== null) {
          if (existing.requestFingerprint !== fingerprint || canonicalJson(existing.request) !== canonicalJson(request)) {
            throw new ComponentUpdateActivationError('UPDATE_LIVE_IDEMPOTENCY_CONFLICT')
          }
          if (existing.phase === 'published') {
            await this.#verifyCandidateLive(existing)
            return makeReceipt(existing, 'published', this.#timestamp(), true)
          }
          await this.#rollbackJournal(roots, existing)
          throw new ComponentUpdateActivationError('UPDATE_LIVE_PUBLISH_INTERRUPTED')
        }
        await this.#assertNoOtherJournal(roots, request.requestId)
        await this.#requireStopped(request, 'before-publish')
        const journal = await this.#prepareJournal(roots, request, fingerprint)
        try {
          await this.#requireStopped(request, 'before-publish')
        } catch (error) {
          await this.#cleanupTransaction(roots, journal).catch(() => undefined)
          await this.#removeCreatedDirectories(journal).catch(() => undefined)
          throw error
        }
        try {
          await this.#applyCandidate(roots, journal)
          const published = { ...journal, phase: 'published' as const }
          await this.#writeJournal(roots, published)
          await this.#verifyCandidateLive(published)
          return makeReceipt(published, 'published', this.#timestamp(), false)
        } catch (error) {
          await this.#rollbackJournal(roots, journal).catch((rollbackError: unknown) => {
            throw new ComponentUpdateActivationError('UPDATE_LIVE_ROLLBACK_FAILED', { cause: rollbackError })
          })
          if (error instanceof ComponentUpdateActivationError) throw error
          throw new ComponentUpdateActivationError('UPDATE_LIVE_PUBLISH_FAILED', { cause: error })
        }
      })
    })
  }

  async commitCandidate(input: unknown): Promise<FixedLiveComponentDeploymentReceipt> {
    const request = parseSupportedCandidateRequest(input)
    return await this.#serialize(async () => {
      const roots = await this.#prepareRoots()
      return await this.#withLock(roots, async () => {
        const existingReceipt = await this.#readReceipt(roots, request.requestId)
        if (existingReceipt !== null) {
          assertReceiptIdentity(existingReceipt, request)
          if (existingReceipt.status !== 'committed') throw new ComponentUpdateActivationError('UPDATE_LIVE_ALREADY_ROLLED_BACK')
          const journal = await this.#readJournal(roots, request.requestId)
          if (journal !== null) await this.#cleanupTransaction(roots, journal)
          return { ...existingReceipt, reused: true }
        }
        const journal = await this.#requireJournal(roots, request)
        if (journal.phase !== 'published') throw new ComponentUpdateActivationError('UPDATE_LIVE_NOT_PUBLISHED')
        await this.#verifyCandidateLive(journal)
        await this.#writeState(roots, journal.candidateState)
        const receipt = makeReceipt(journal, 'committed', this.#timestamp(), false)
        await this.#persistReceipt(roots, receipt)
        await this.#cleanupTransaction(roots, journal)
        return receipt
      })
    })
  }

  async rollbackCandidate(input: unknown): Promise<FixedLiveComponentDeploymentReceipt> {
    const request = parseSupportedCandidateRequest(input)
    return await this.#serialize(async () => {
      const roots = await this.#prepareRoots()
      return await this.#withLock(roots, async () => {
        const existingReceipt = await this.#readReceipt(roots, request.requestId)
        if (existingReceipt !== null) {
          assertReceiptIdentity(existingReceipt, request)
          if (existingReceipt.status !== 'rolled-back') throw new ComponentUpdateActivationError('UPDATE_LIVE_ROLLBACK_UNAVAILABLE')
          const journal = await this.#readJournal(roots, request.requestId)
          if (journal !== null) await this.#cleanupTransaction(roots, journal)
          return { ...existingReceipt, reused: true }
        }
        const journal = await this.#requireJournal(roots, request)
        return await this.#rollbackJournal(roots, journal)
      })
    })
  }

  async reconcileCandidate(
    input: unknown,
    desired: 'candidate' | 'previous'
  ): Promise<FixedLiveReconciliationResult> {
    const request = parseSupportedCandidateRequest(input)
    return await this.#serialize(async () => {
      const roots = await this.#prepareRoots()
      return await this.#withLock(roots, async () => {
        const receipt = await this.#readReceipt(roots, request.requestId)
        if (receipt !== null) {
          assertReceiptIdentity(receipt, request)
          if (receipt.status === 'committed') {
            if (desired !== 'candidate') throw new ComponentUpdateActivationError('UPDATE_LIVE_STATE_CONFLICT')
            await this.#verifyStateAndLive(roots, request.component)
            const journal = await this.#readJournal(roots, request.requestId)
            if (journal !== null) await this.#cleanupTransaction(roots, journal)
            return 'candidate'
          }
          if (receipt.status === 'rolled-back') {
            await this.#verifyStateAndLive(roots, request.component)
            const journal = await this.#readJournal(roots, request.requestId)
            if (journal !== null) await this.#cleanupTransaction(roots, journal)
            return 'previous'
          }
        }
        const journal = await this.#readJournal(roots, request.requestId)
        if (journal === null) {
          if (desired !== 'previous') throw new ComponentUpdateActivationError('UPDATE_LIVE_JOURNAL_MISSING')
          await this.#verifyStateAndLive(roots, request.component)
          return 'previous'
        }
        if (journal.requestFingerprint !== fingerprintRequest(request) || canonicalJson(journal.request) !== canonicalJson(request)) {
          throw new ComponentUpdateActivationError('UPDATE_LIVE_IDEMPOTENCY_CONFLICT')
        }
        if (desired === 'candidate' && journal.phase === 'published') {
          await this.#verifyCandidateLive(journal)
          return 'candidate'
        }
        await this.#rollbackJournal(roots, journal)
        return 'previous'
      })
    })
  }

  async #prepareJournal(
    roots: PreparedRoots,
    request: z.infer<typeof candidateRequestSchema>,
    requestFingerprint: string
  ): Promise<LiveDeploymentJournal> {
    const release = await this.#loadImmutableRelease(roots, request)
    this.assertSupportedManifest(request.component, release.manifest)
    const createdDirectories = await this.#ensureLiveDirectories(request.component)
    let transaction: { root: string; backupRoot: string; candidateRoot: string } | null = null
    const entries: LiveJournalEntry[] = []
    try {
      const previousState = await this.#loadState(roots, request.component)
      const candidateState: LiveComponentState = liveStateSchema.parse({
        format: 'dyson-control-fixed-live-component-state',
        schemaVersion: 1,
        component: request.component,
        releaseId: request.releaseId,
        artifactId: request.artifactId,
        version: request.targetVersion,
        files: release.manifest.files.map(normalizeManifestFile).sort(compareFiles)
      })
      await this.#assertPathsNotOwnedByAnotherComponent(roots, request.component, candidateState.files)
      transaction = await this.#createTransactionDirectories(roots, request.requestId)
      const byPath = new Map<string, {
        previousManaged: ComponentReleaseManifestFile | null
        candidate: ComponentReleaseManifestFile | null
      }>()
      for (const file of previousState.files) {
        byPath.set(canonicalPathKey(file.relativePath), { previousManaged: file, candidate: null })
      }
      for (const file of candidateState.files) {
        const key = canonicalPathKey(file.relativePath)
        const entry = byPath.get(key)
        if (entry === undefined) byPath.set(key, { previousManaged: null, candidate: file })
        else entry.candidate = file
      }
      for (const [index, value] of [...byPath.values()].sort((left, right) => compareText(
        left.candidate?.relativePath ?? left.previousManaged!.relativePath,
        right.candidate?.relativePath ?? right.previousManaged!.relativePath
      )).entries()) {
        const relativePath = value.candidate?.relativePath ?? value.previousManaged!.relativePath
        const livePath = await this.#resolveLiveTarget(request.component, relativePath)
        const previous = await snapshotLiveFile(livePath, transaction.backupRoot, index, this.#limits.maximumFileBytes)
        let candidateSnapshotName: string | null = null
        if (value.candidate !== null) {
          candidateSnapshotName = `candidate-${index}.bin`
          const releasePath = resolveReleasePayloadFile(
            release.payloadRoot,
            request.component,
            value.candidate.relativePath
          )
          await copyStableFile(
            releasePath,
            path.join(transaction.candidateRoot, candidateSnapshotName),
            value.candidate,
            this.#limits.maximumFileBytes
          )
        }
        entries.push({ relativePath, previous, candidate: value.candidate, candidateSnapshotName })
      }
      const journal = journalSchema.parse({
        format: 'dyson-control-fixed-live-component-journal',
        schemaVersion: 1,
        requestFingerprint,
        request,
        phase: 'prepared',
        previousState,
        candidateState,
        createdDirectories,
        entries
      })
      await this.#writeJournal(roots, journal)
      return journal
    } catch (error) {
      if (transaction !== null) await cleanupPreparedTransaction(transaction, entries).catch(() => undefined)
      await this.#removeCreatedDirectoryNames(request.component, createdDirectories).catch(() => undefined)
      throw error
    }
  }

  async #applyCandidate(roots: PreparedRoots, journal: LiveDeploymentJournal): Promise<void> {
    const transaction = transactionPaths(roots, journal.request.requestId)
    for (const [index, entry] of journal.entries.entries()) {
      const target = await this.#resolveLiveTarget(journal.request.component, entry.relativePath)
      await assertTargetMatchesSnapshot(target, entry.previous, this.#limits.maximumFileBytes)
      const siblings = liveSiblingPaths(target, journal.request.requestId, index)
      await assertSiblingPathsAbsent(siblings)
      if (entry.candidate !== null) {
        await copyStableFile(
          path.join(transaction.candidateRoot, entry.candidateSnapshotName!),
          siblings.candidate,
          entry.candidate,
          this.#limits.maximumFileBytes
        )
      }
      if (entry.previous.exists) await rename(target, siblings.previous)
      if (entry.candidate !== null) await rename(siblings.candidate, target)
    }
    await this.#verifyCandidateLive(journal)
  }

  async #rollbackJournal(
    roots: PreparedRoots,
    journalInput: LiveDeploymentJournal
  ): Promise<FixedLiveComponentDeploymentReceipt> {
    const journal = journalInput.phase === 'rolling-back'
      ? journalInput
      : { ...journalInput, phase: 'rolling-back' as const }
    await this.#writeJournal(roots, journal)
    await this.#requireStopped(journal.request, 'before-rollback')
    const transaction = transactionPaths(roots, journal.request.requestId)
    for (const [index, entry] of [...journal.entries.entries()].reverse()) {
      const target = await this.#resolveLiveTarget(journal.request.component, entry.relativePath)
      const siblings = liveSiblingPaths(target, journal.request.requestId, index)
      await unlink(siblings.candidate).catch(() => undefined)
      if (entry.previous.exists) {
        const restore = siblings.candidate
        await unlink(restore).catch(() => undefined)
        await copyStableFile(
          path.join(transaction.backupRoot, entry.previous.snapshotName!),
          restore,
          { sizeBytes: entry.previous.sizeBytes!, sha256: entry.previous.sha256! },
          this.#limits.maximumFileBytes
        )
        const current = await fileEvidenceIfPresent(target, this.#limits.maximumFileBytes)
        if (current !== null && !evidenceMatches(current, entry.previous)) {
          if (entry.candidate === null || !evidenceMatches(current, entry.candidate)) {
            throw new ComponentUpdateActivationError('UPDATE_LIVE_ROLLBACK_AMBIGUOUS')
          }
          await unlink(siblings.discard).catch(() => undefined)
          await rename(target, siblings.discard)
        }
        if (!await pathExists(target)) await rename(restore, target)
        else await unlink(restore)
      } else {
        const current = await fileEvidenceIfPresent(target, this.#limits.maximumFileBytes)
        if (current !== null) {
          if (entry.candidate === null || !evidenceMatches(current, entry.candidate)) {
            throw new ComponentUpdateActivationError('UPDATE_LIVE_ROLLBACK_AMBIGUOUS')
          }
          await unlink(siblings.discard).catch(() => undefined)
          await rename(target, siblings.discard)
        }
      }
      await unlink(siblings.previous).catch(() => undefined)
      await unlink(siblings.discard).catch(() => undefined)
      await assertTargetMatchesSnapshot(target, entry.previous, this.#limits.maximumFileBytes)
    }
    await this.#writeState(roots, journal.previousState)
    const receipt = makeReceipt(journal, 'rolled-back', this.#timestamp(), false)
    await this.#persistReceipt(roots, receipt)
    await this.#cleanupTransaction(roots, journal)
    await this.#removeCreatedDirectories(journal)
    return receipt
  }

  async #verifyCandidateLive(journal: LiveDeploymentJournal): Promise<void> {
    for (const entry of journal.entries) {
      const target = await this.#resolveLiveTarget(journal.request.component, entry.relativePath)
      const evidence = await fileEvidenceIfPresent(target, this.#limits.maximumFileBytes)
      if (entry.candidate === null ? evidence !== null : evidence === null || !evidenceMatches(evidence, entry.candidate)) {
        throw new ComponentUpdateActivationError('UPDATE_LIVE_CANDIDATE_VERIFICATION_FAILED')
      }
    }
  }

  async #verifyStateAndLive(roots: PreparedRoots, component: ManagedUpdateComponent): Promise<void> {
    const state = await this.#loadState(roots, component)
    for (const file of state.files) {
      const target = await this.#resolveLiveTarget(component, file.relativePath)
      const evidence = await fileEvidenceIfPresent(target, this.#limits.maximumFileBytes)
      if (evidence === null || !evidenceMatches(evidence, file)) {
        throw new ComponentUpdateActivationError('UPDATE_LIVE_STATE_VERIFICATION_FAILED')
      }
    }
  }

  async #assertPathsNotOwnedByAnotherComponent(
    roots: PreparedRoots,
    component: ManagedUpdateComponent,
    files: ComponentReleaseManifestFile[]
  ): Promise<void> {
    const requested = new Set(files.map((file) => canonicalPathKey(file.relativePath)))
    const root = path.resolve(this.#componentRoots[component])
    for (const other of componentSchema.options) {
      if (other === component || canonicalPathKey(path.resolve(this.#componentRoots[other])) !== canonicalPathKey(root)) continue
      const state = await this.#loadState(roots, other)
      if (state.files.some((file) => requested.has(canonicalPathKey(file.relativePath)))) {
        throw new ComponentUpdateActivationError('UPDATE_LIVE_PATH_OWNERSHIP_CONFLICT')
      }
    }
  }

  async #loadImmutableRelease(
    roots: PreparedRoots,
    request: z.infer<typeof candidateRequestSchema>
  ): Promise<{ manifest: ComponentReleaseManifest; payloadRoot: string }> {
    const componentRoot = fixedChild(roots.immutableReleaseRoot, request.component)
    const releaseRoot = fixedChild(componentRoot, request.releaseId)
    await assertNormalDirectory(releaseRoot)
    const recordPath = fixedChild(releaseRoot, 'release.json')
    const raw = await readStableSmallFile(recordPath, 2 * 1024 * 1024)
    let record: z.infer<typeof releaseRecordSchema>
    try {
      record = releaseRecordSchema.parse(JSON.parse(raw.toString('utf8')) as unknown)
    } catch (error) {
      throw new ComponentUpdateActivationError('UPDATE_LIVE_RELEASE_RECORD_INVALID', { cause: error })
    }
    if (record.releaseId !== request.releaseId || record.component !== request.component ||
        record.artifactId !== request.artifactId || record.version !== request.targetVersion) {
      throw new ComponentUpdateActivationError('UPDATE_LIVE_RELEASE_IDENTITY_MISMATCH')
    }
    const payloadRoot = fixedChild(releaseRoot, 'payload')
    await verifyExtractedComponentRelease(payloadRoot, record.manifest, this.#limits)
    return { manifest: record.manifest, payloadRoot }
  }

  async #resolveLiveTarget(component: ManagedUpdateComponent, relativePath: string): Promise<string> {
    assertSupportedRelativePath(component, relativePath)
    const root = path.resolve(this.#componentRoots[component])
    await assertNormalDirectory(root)
    const target = path.resolve(root, ...relativePath.split('/'))
    assertDescendant(root, target)
    await assertNormalDirectory(path.dirname(target))
    return target
  }

  async #ensureLiveDirectories(component: ManagedUpdateComponent): Promise<LiveCreatedDirectory[]> {
    const root = path.resolve(this.#componentRoots[component])
    await assertNormalDirectory(root)
    const componentDirectories: readonly LiveCreatedDirectory[] = component === 'bepinex'
      ? ['BepInEx', 'BepInEx/core']
      : ['plugins', ...managedPluginOwnedDirectories[component]] as readonly LiveCreatedDirectory[]
    const created: LiveCreatedDirectory[] = []
    try {
      for (const relativePath of componentDirectories) {
        const directory = path.resolve(root, ...relativePath.split('/'))
        assertDescendant(root, directory)
        const info = await lstat(directory).catch((error: unknown) => isNodeError(error, 'ENOENT') ? null : Promise.reject(error))
        if (info === null) {
          await mkdir(directory, { recursive: false })
          created.push(relativePath)
        }
        await assertNormalDirectory(directory)
      }
      return created
    } catch (error) {
      await this.#removeCreatedDirectoryNames(component, created).catch(() => undefined)
      throw error
    }
  }

  async #removeCreatedDirectories(journal: LiveDeploymentJournal): Promise<void> {
    await this.#removeCreatedDirectoryNames(journal.request.component, journal.createdDirectories)
  }

  async #removeCreatedDirectoryNames(
    component: ManagedUpdateComponent,
    directories: ReadonlyArray<LiveCreatedDirectory>
  ): Promise<void> {
    const root = path.resolve(this.#componentRoots[component])
    for (const relativePath of [...directories].reverse()) {
      const directory = path.resolve(root, ...relativePath.split('/'))
      assertDescendant(root, directory)
      const info = await lstat(directory).catch((error: unknown) => isNodeError(error, 'ENOENT') ? null : Promise.reject(error))
      if (info === null) continue
      if (!info.isDirectory() || info.isSymbolicLink() || !samePath(await realpath(directory), directory)) {
        throw new ComponentUpdateActivationError('UPDATE_LIVE_DIRECTORY_CHANGED')
      }
      await rmdir(directory).catch((error: unknown) => {
        if (!isNodeError(error, 'ENOENT') && !isNodeError(error, 'ENOTEMPTY') && !isNodeError(error, 'EEXIST')) throw error
      })
    }
  }

  async #requireStopped(
    request: z.infer<typeof candidateRequestSchema>,
    phase: 'before-publish' | 'before-rollback'
  ): Promise<void> {
    let proof: StoppedStateProof
    try {
      proof = stoppedProofSchema.parse(await this.#verifyStoppedState({
        requestId: request.requestId,
        component: request.component,
        phase
      }))
    } catch (error) {
      throw new ComponentUpdateActivationError('UPDATE_LIVE_STOP_PROOF_INVALID', { cause: error })
    }
    if (!proof.processStopped || !proof.portClosed) throw new ComponentUpdateActivationError('UPDATE_SERVICE_STILL_RUNNING')
  }

  async #prepareRoots(): Promise<PreparedRoots> {
    await assertNormalDirectory(this.#immutableReleaseRoot)
    const parent = path.dirname(this.#controlRoot)
    await assertNormalDirectory(parent)
    await mkdir(this.#controlRoot, { recursive: false }).catch((error: unknown) => {
      if (!isNodeError(error, 'EEXIST')) throw error
    })
    await assertNormalDirectory(this.#controlRoot)
    const names = ['state', 'journals', 'transactions', 'receipts', 'locks'] as const
    const directories: string[] = []
    for (const name of names) {
      const directory = fixedChild(this.#controlRoot, name)
      await mkdir(directory, { recursive: false }).catch((error: unknown) => {
        if (!isNodeError(error, 'EEXIST')) throw error
      })
      await assertNormalDirectory(directory)
      directories.push(directory)
    }
    return {
      immutableReleaseRoot: this.#immutableReleaseRoot,
      controlRoot: this.#controlRoot,
      stateRoot: directories[0]!,
      journalRoot: directories[1]!,
      transactionRoot: directories[2]!,
      receiptRoot: directories[3]!,
      lockRoot: directories[4]!
    }
  }

  async #createTransactionDirectories(roots: PreparedRoots, requestId: string): Promise<{
    root: string; backupRoot: string; candidateRoot: string
  }> {
    const root = fixedChild(roots.transactionRoot, requestId)
    await mkdir(root, { recursive: false })
    const backupRoot = fixedChild(root, 'backup')
    const candidateRoot = fixedChild(root, 'candidate')
    await mkdir(backupRoot, { recursive: false })
    await mkdir(candidateRoot, { recursive: false })
    return { root, backupRoot, candidateRoot }
  }

  async #loadState(roots: PreparedRoots, component: ManagedUpdateComponent): Promise<LiveComponentState> {
    const filePath = fixedChild(roots.stateRoot, `${component}.json`)
    const value = await readJsonIfPresent(filePath)
    if (value === null) return liveStateSchema.parse({
      format: 'dyson-control-fixed-live-component-state', schemaVersion: 1, component,
      releaseId: null, artifactId: null, version: null, files: []
    })
    try {
      const state = liveStateSchema.parse(value)
      if (state.component !== component) throw new Error('component mismatch')
      return state
    } catch (error) {
      throw new ComponentUpdateActivationError('UPDATE_LIVE_STATE_INVALID', { cause: error })
    }
  }

  async #writeState(roots: PreparedRoots, state: LiveComponentState): Promise<void> {
    await writeAtomicJson(fixedChild(roots.stateRoot, `${state.component}.json`), liveStateSchema.parse(state))
  }

  async #readJournal(roots: PreparedRoots, requestId: string): Promise<LiveDeploymentJournal | null> {
    const value = await readJsonIfPresent(fixedChild(roots.journalRoot, `${requestId}.json`))
    if (value === null) return null
    try {
      const journal = journalSchema.parse(value)
      if (journal.request.requestId !== requestId) throw new Error('request mismatch')
      return journal
    } catch (error) {
      throw new ComponentUpdateActivationError('UPDATE_LIVE_JOURNAL_INVALID', { cause: error })
    }
  }

  async #writeJournal(roots: PreparedRoots, journal: LiveDeploymentJournal): Promise<void> {
    await writeAtomicJson(fixedChild(roots.journalRoot, `${journal.request.requestId}.json`), journalSchema.parse(journal))
  }

  async #requireJournal(
    roots: PreparedRoots,
    request: z.infer<typeof candidateRequestSchema>
  ): Promise<LiveDeploymentJournal> {
    const journal = await this.#readJournal(roots, request.requestId)
    if (journal === null) throw new ComponentUpdateActivationError('UPDATE_LIVE_JOURNAL_MISSING')
    if (journal.requestFingerprint !== fingerprintRequest(request) || canonicalJson(journal.request) !== canonicalJson(request)) {
      throw new ComponentUpdateActivationError('UPDATE_LIVE_IDEMPOTENCY_CONFLICT')
    }
    return journal
  }

  async #assertNoOtherJournal(roots: PreparedRoots, requestId: string): Promise<void> {
    const entries = await readdir(roots.journalRoot, { withFileTypes: true })
    for (const entry of entries) {
      if (!entry.isFile() || entry.isSymbolicLink() || !/^[0-9a-f-]{36}\.json$/i.test(entry.name)) {
        throw new ComponentUpdateActivationError('UPDATE_LIVE_JOURNAL_DIRECTORY_INVALID')
      }
      if (entry.name.toLowerCase() !== `${requestId.toLowerCase()}.json`) {
        throw new ComponentUpdateActivationError('UPDATE_LIVE_RECOVERY_REQUIRED')
      }
    }
  }

  async #readReceipt(roots: PreparedRoots, requestId: string): Promise<FixedLiveComponentDeploymentReceipt | null> {
    const value = await readJsonIfPresent(fixedChild(roots.receiptRoot, `${requestId}.json`))
    if (value === null) return null
    try {
      const receipt = receiptSchema.parse(value)
      if (receipt.requestId !== requestId) throw new Error('request mismatch')
      return receipt
    } catch (error) {
      throw new ComponentUpdateActivationError('UPDATE_LIVE_RECEIPT_INVALID', { cause: error })
    }
  }

  async #persistReceipt(roots: PreparedRoots, receipt: FixedLiveComponentDeploymentReceipt): Promise<void> {
    const finalPath = fixedChild(roots.receiptRoot, `${receipt.requestId}.json`)
    const existing = await this.#readReceipt(roots, receipt.requestId)
    if (existing !== null) {
      if (canonicalJson(existing) !== canonicalJson(receipt)) throw new ComponentUpdateActivationError('UPDATE_LIVE_IDEMPOTENCY_CONFLICT')
      return
    }
    await writeImmutableJson(finalPath, receiptSchema.parse({ ...receipt, reused: false }))
  }

  async #cleanupTransaction(roots: PreparedRoots, journal: LiveDeploymentJournal): Promise<void> {
    const transaction = transactionPaths(roots, journal.request.requestId)
    for (const [index, entry] of journal.entries.entries()) {
      if (entry.previous.snapshotName !== null) await unlinkIfPresent(path.join(transaction.backupRoot, entry.previous.snapshotName))
      if (entry.candidateSnapshotName !== null) await unlinkIfPresent(path.join(transaction.candidateRoot, entry.candidateSnapshotName))
      const target = await this.#resolveLiveTarget(journal.request.component, entry.relativePath)
      const siblings = liveSiblingPaths(target, journal.request.requestId, index)
      for (const candidate of Object.values(siblings)) await unlinkIfPresent(candidate)
    }
    await rmdirIfPresent(transaction.backupRoot)
    await rmdirIfPresent(transaction.candidateRoot)
    await rmdirIfPresent(transaction.root)
    await unlinkIfPresent(fixedChild(roots.journalRoot, `${journal.request.requestId}.json`))
  }

  async #withLock<T>(roots: PreparedRoots, operation: () => Promise<T>): Promise<T> {
    const lockPath = fixedChild(roots.lockRoot, 'live.lock')
    const lock = await acquireLock(lockPath)
    try {
      return await operation()
    } finally {
      await lock.close().catch(() => undefined)
      await unlink(lockPath).catch(() => undefined)
    }
  }

  async #serialize<T>(operation: () => Promise<T>): Promise<T> {
    let release!: () => void
    const previous = this.#tail
    this.#tail = new Promise<void>((resolve) => { release = resolve })
    await previous
    try { return await operation() } finally { release() }
  }

  #timestamp(): string {
    const value = this.#now().toISOString()
    isoDateSchema.parse(value)
    return value
  }
}

function parseCandidateRequest(input: unknown): z.infer<typeof candidateRequestSchema> & {
  component: 'nebula' | 'bridge' | 'control' | 'bepinex'
} {
  try {
    return candidateRequestSchema.parse(input)
  } catch (error) {
    throw new ComponentUpdateActivationError('UPDATE_LIVE_REQUEST_INVALID', { cause: error })
  }
}

function parseSupportedCandidateRequest(input: unknown): z.infer<typeof candidateRequestSchema> & {
  component: ManagedUpdateComponent
} {
  return parseCandidateRequest(input)
}

function assertSupportedRelativePath(component: ManagedUpdateComponent, relativePath: string): void {
  if (component === 'bepinex') {
    if (!isKnownBepInExWindowsX64OwnedPath(relativePath)) {
      throw new ComponentUpdateActivationError('UPDATE_LIVE_LAYOUT_UNSUPPORTED')
    }
    return
  }
  if (!isManagedComponentOwnedPath(component, relativePath)) {
    throw new ComponentUpdateActivationError('UPDATE_LIVE_LAYOUT_UNSUPPORTED')
  }
}

function normalizeManifestFile(file: ComponentReleaseManifestFile): ComponentReleaseManifestFile {
  return { relativePath: file.relativePath, sizeBytes: file.sizeBytes, sha256: file.sha256.toLowerCase() }
}

function compareFiles(left: ComponentReleaseManifestFile, right: ComponentReleaseManifestFile): number {
  return compareText(canonicalPathKey(left.relativePath), canonicalPathKey(right.relativePath))
}

async function snapshotLiveFile(
  livePath: string,
  backupRoot: string,
  index: number,
  maximumBytes: number
): Promise<FileSnapshot> {
  const evidence = await fileEvidenceIfPresent(livePath, maximumBytes)
  if (evidence === null) return { exists: false, sizeBytes: null, sha256: null, snapshotName: null }
  const snapshotName = `previous-${index}.bin`
  await copyStableFile(livePath, path.join(backupRoot, snapshotName), {
    sizeBytes: evidence.sizeBytes, sha256: evidence.sha256
  }, maximumBytes)
  return { exists: true, sizeBytes: evidence.sizeBytes, sha256: evidence.sha256, snapshotName }
}

async function copyStableFile(
  sourcePath: string,
  destinationPath: string,
  expected: Pick<ComponentReleaseManifestFile, 'sizeBytes' | 'sha256'>,
  maximumBytes: number
): Promise<void> {
  await assertNormalFile(sourcePath)
  const source = await open(sourcePath, 'r')
  const destination = await open(destinationPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600)
  try {
    const before = await source.stat({ bigint: true })
    if (!before.isFile() || before.size !== BigInt(expected.sizeBytes) || before.size > BigInt(maximumBytes)) {
      throw new ComponentUpdateActivationError('UPDATE_LIVE_SOURCE_CHANGED')
    }
    const digest = createHash('sha256')
    const buffer = Buffer.allocUnsafe(1024 * 1024)
    let position = 0
    while (position < expected.sizeBytes) {
      const { bytesRead } = await source.read(buffer, 0, Math.min(buffer.length, expected.sizeBytes - position), position)
      if (bytesRead === 0) throw new ComponentUpdateActivationError('UPDATE_LIVE_SOURCE_CHANGED')
      digest.update(buffer.subarray(0, bytesRead))
      let written = 0
      while (written < bytesRead) {
        const result = await destination.write(buffer, written, bytesRead - written, position + written)
        if (result.bytesWritten === 0) throw new ComponentUpdateActivationError('UPDATE_LIVE_WRITE_FAILED')
        written += result.bytesWritten
      }
      position += bytesRead
    }
    await destination.sync()
    const after = await source.stat({ bigint: true })
    if (!sameSnapshot(before, after) || digest.digest('hex') !== expected.sha256.toLowerCase()) {
      throw new ComponentUpdateActivationError('UPDATE_LIVE_SOURCE_CHANGED')
    }
  } catch (error) {
    await destination.close().catch(() => undefined)
    await unlink(destinationPath).catch(() => undefined)
    throw error
  } finally {
    await source.close()
  }
  await destination.close()
  const copied = await fileEvidenceIfPresent(destinationPath, maximumBytes)
  if (copied === null || copied.sizeBytes !== expected.sizeBytes || copied.sha256 !== expected.sha256.toLowerCase()) {
    await unlink(destinationPath).catch(() => undefined)
    throw new ComponentUpdateActivationError('UPDATE_LIVE_COPY_VERIFICATION_FAILED')
  }
}

async function fileEvidenceIfPresent(
  filePath: string,
  maximumBytes: number
): Promise<{ sizeBytes: number; sha256: string } | null> {
  const info = await lstat(filePath).catch((error: unknown) => isNodeError(error, 'ENOENT') ? null : Promise.reject(error))
  if (info === null) return null
  if (!info.isFile() || info.isSymbolicLink() || info.size < 0 || info.size > maximumBytes ||
      !samePath(await realpath(filePath), filePath)) {
    throw new ComponentUpdateActivationError('UPDATE_LIVE_FILE_INVALID')
  }
  const handle = await open(filePath, 'r')
  try {
    const before = await handle.stat({ bigint: true })
    const digest = createHash('sha256')
    const buffer = Buffer.allocUnsafe(1024 * 1024)
    let position = 0
    while (position < Number(before.size)) {
      const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, Number(before.size) - position), position)
      if (bytesRead === 0) throw new ComponentUpdateActivationError('UPDATE_LIVE_FILE_CHANGED')
      digest.update(buffer.subarray(0, bytesRead))
      position += bytesRead
    }
    const after = await handle.stat({ bigint: true })
    if (!sameSnapshot(before, after)) throw new ComponentUpdateActivationError('UPDATE_LIVE_FILE_CHANGED')
    return { sizeBytes: position, sha256: digest.digest('hex') }
  } finally {
    await handle.close()
  }
}

async function assertTargetMatchesSnapshot(
  target: string,
  expected: FileSnapshot,
  maximumBytes: number
): Promise<void> {
  const actual = await fileEvidenceIfPresent(target, maximumBytes)
  if (expected.exists ? actual === null || !evidenceMatches(actual, expected) : actual !== null) {
    throw new ComponentUpdateActivationError('UPDATE_LIVE_TARGET_CHANGED')
  }
}

function evidenceMatches(
  actual: { sizeBytes: number; sha256: string },
  expected: { sizeBytes: number | null; sha256: string | null }
): boolean {
  return actual.sizeBytes === expected.sizeBytes && actual.sha256 === expected.sha256?.toLowerCase()
}

function liveSiblingPaths(target: string, requestId: string, index: number): {
  candidate: string; previous: string; discard: string
} {
  const prefix = `.dyson-${requestId}-${index}`
  return {
    candidate: path.join(path.dirname(target), `${prefix}.candidate.tmp`),
    previous: path.join(path.dirname(target), `${prefix}.previous.tmp`),
    discard: path.join(path.dirname(target), `${prefix}.discard.tmp`)
  }
}

async function assertSiblingPathsAbsent(paths: ReturnType<typeof liveSiblingPaths>): Promise<void> {
  if ((await Promise.all(Object.values(paths).map(pathExists))).some(Boolean)) {
    throw new ComponentUpdateActivationError('UPDATE_LIVE_RECOVERY_REQUIRED')
  }
}

function resolveReleasePayloadFile(payloadRoot: string, component: ManagedUpdateComponent, relativePath: string): string {
  assertSupportedRelativePath(component, relativePath)
  const result = path.resolve(payloadRoot, ...relativePath.split('/'))
  assertDescendant(payloadRoot, result)
  return result
}

function transactionPaths(roots: PreparedRoots, requestId: string): {
  root: string; backupRoot: string; candidateRoot: string
} {
  const root = fixedChild(roots.transactionRoot, requestId)
  return { root, backupRoot: fixedChild(root, 'backup'), candidateRoot: fixedChild(root, 'candidate') }
}

async function cleanupPreparedTransaction(
  transaction: { root: string; backupRoot: string; candidateRoot: string },
  entries: readonly LiveJournalEntry[]
): Promise<void> {
  for (const entry of entries) {
    if (entry.previous.snapshotName !== null) await unlink(path.join(transaction.backupRoot, entry.previous.snapshotName)).catch(() => undefined)
    if (entry.candidateSnapshotName !== null) await unlink(path.join(transaction.candidateRoot, entry.candidateSnapshotName)).catch(() => undefined)
  }
  await rmdir(transaction.backupRoot).catch(() => undefined)
  await rmdir(transaction.candidateRoot).catch(() => undefined)
  await rmdir(transaction.root).catch(() => undefined)
}

function makeReceipt(
  journal: LiveDeploymentJournal,
  status: FixedLiveComponentDeploymentReceipt['status'],
  completedAt: string,
  reused: boolean
): FixedLiveComponentDeploymentReceipt {
  return receiptSchema.parse({
    format: 'dyson-control-fixed-live-component-receipt', schemaVersion: 1,
    requestId: journal.request.requestId, component: journal.request.component,
    requestFingerprint: journal.requestFingerprint,
    releaseId: journal.request.releaseId, artifactId: journal.request.artifactId,
    targetVersion: journal.request.targetVersion, status,
    fileCount: journal.candidateState.files.length, completedAt, reused
  })
}

function assertReceiptIdentity(
  receipt: FixedLiveComponentDeploymentReceipt,
  request: z.infer<typeof candidateRequestSchema>
): void {
  if (receipt.requestId !== request.requestId || receipt.component !== request.component ||
      receipt.releaseId !== request.releaseId || receipt.artifactId !== request.artifactId ||
      receipt.targetVersion !== request.targetVersion || receipt.requestFingerprint !== fingerprintRequest(request)) {
    throw new ComponentUpdateActivationError('UPDATE_LIVE_IDEMPOTENCY_CONFLICT')
  }
}

async function acquireLock(lockPath: string): Promise<FileHandle> {
  for (let attempt = 0; attempt < 2; attempt++) {
    let handle: FileHandle
    try {
      handle = await open(lockPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600)
    } catch (error) {
      if (!isNodeError(error, 'EEXIST')) throw new ComponentUpdateActivationError('UPDATE_LIVE_LOCK_FAILED', { cause: error })
      if (attempt > 0 || !await removeStaleLock(lockPath)) throw new ComponentUpdateActivationError('UPDATE_LIVE_LOCK_BUSY')
      continue
    }
    try {
      await handle.writeFile(`${JSON.stringify({ host: hostname(), bootId: currentBootId(), pid: process.pid })}\n`, 'utf8')
      await handle.sync()
      return handle
    } catch (error) {
      await handle.close().catch(() => undefined)
      await unlink(lockPath).catch(() => undefined)
      throw new ComponentUpdateActivationError('UPDATE_LIVE_LOCK_FAILED', { cause: error })
    }
  }
  throw new ComponentUpdateActivationError('UPDATE_LIVE_LOCK_BUSY')
}

const lockSchema = z.strictObject({
  host: z.string().min(1).max(255), bootId: z.string().min(1).max(64), pid: z.number().int().positive()
})

async function removeStaleLock(lockPath: string): Promise<boolean> {
  try {
    const info = await lstat(lockPath)
    if (!info.isFile() || info.isSymbolicLink() || info.size < 1 || info.size > 2_048) return false
    const lock = lockSchema.parse(JSON.parse(await readFile(lockPath, 'utf8')) as unknown)
    if (lock.host !== hostname()) return false
    if (lock.bootId === currentBootId() && processIsAlive(lock.pid)) return false
    await unlink(lockPath)
    return true
  } catch {
    return false
  }
}

async function assertNormalDirectory(directory: string): Promise<void> {
  const resolved = path.resolve(directory)
  const info = await lstat(resolved).catch((error: unknown) => {
    throw new ComponentUpdateActivationError('UPDATE_LIVE_DIRECTORY_INVALID', { cause: error })
  })
  if (!info.isDirectory() || info.isSymbolicLink() || !samePath(await realpath(resolved), resolved)) {
    throw new ComponentUpdateActivationError('UPDATE_LIVE_DIRECTORY_INVALID')
  }
}

async function assertNormalFile(filePath: string): Promise<void> {
  const info = await lstat(filePath).catch((error: unknown) => {
    throw new ComponentUpdateActivationError('UPDATE_LIVE_FILE_INVALID', { cause: error })
  })
  if (!info.isFile() || info.isSymbolicLink() || !samePath(await realpath(filePath), filePath)) {
    throw new ComponentUpdateActivationError('UPDATE_LIVE_FILE_INVALID')
  }
}

async function readStableSmallFile(filePath: string, maximumBytes: number): Promise<Buffer> {
  await assertNormalFile(filePath)
  const handle = await open(filePath, 'r')
  try {
    const before = await handle.stat({ bigint: true })
    if (before.size < 1 || before.size > BigInt(maximumBytes)) throw new ComponentUpdateActivationError('UPDATE_LIVE_FILE_INVALID')
    const output = Buffer.allocUnsafe(Number(before.size))
    let position = 0
    while (position < output.length) {
      const { bytesRead } = await handle.read(output, position, output.length - position, position)
      if (bytesRead === 0) throw new ComponentUpdateActivationError('UPDATE_LIVE_FILE_CHANGED')
      position += bytesRead
    }
    const after = await handle.stat({ bigint: true })
    if (!sameSnapshot(before, after)) throw new ComponentUpdateActivationError('UPDATE_LIVE_FILE_CHANGED')
    return output
  } finally {
    await handle.close()
  }
}

async function readJsonIfPresent(filePath: string): Promise<unknown | null> {
  const info = await lstat(filePath).catch((error: unknown) => isNodeError(error, 'ENOENT') ? null : Promise.reject(error))
  if (info === null) return null
  if (!info.isFile() || info.isSymbolicLink() || info.size < 1 || info.size > 2 * 1024 * 1024) {
    throw new ComponentUpdateActivationError('UPDATE_LIVE_METADATA_INVALID')
  }
  try { return JSON.parse((await readStableSmallFile(filePath, 2 * 1024 * 1024)).toString('utf8')) as unknown } catch (error) {
    if (error instanceof ComponentUpdateActivationError) throw error
    throw new ComponentUpdateActivationError('UPDATE_LIVE_METADATA_INVALID', { cause: error })
  }
}

async function writeAtomicJson(filePath: string, value: unknown): Promise<void> {
  const temporary = path.join(path.dirname(filePath), `.partial-${randomUUID()}.json`)
  const handle = await open(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600)
  try {
    await handle.writeFile(`${canonicalJson(value)}\n`, 'utf8')
    await handle.sync()
  } catch (error) {
    await handle.close().catch(() => undefined)
    await unlink(temporary).catch(() => undefined)
    throw new ComponentUpdateActivationError('UPDATE_LIVE_PERSISTENCE_FAILED', { cause: error })
  }
  await handle.close()
  try { await rename(temporary, filePath) } catch (error) {
    await unlink(temporary).catch(() => undefined)
    throw new ComponentUpdateActivationError('UPDATE_LIVE_PERSISTENCE_FAILED', { cause: error })
  }
}

async function writeImmutableJson(filePath: string, value: unknown): Promise<void> {
  const handle = await open(filePath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600)
  try {
    await handle.writeFile(`${canonicalJson(value)}\n`, 'utf8')
    await handle.sync()
  } catch (error) {
    await handle.close().catch(() => undefined)
    await unlink(filePath).catch(() => undefined)
    throw new ComponentUpdateActivationError('UPDATE_LIVE_PERSISTENCE_FAILED', { cause: error })
  }
  await handle.close()
}

function fixedChild(root: string, child: string): string {
  if (child === '' || child === '.' || child === '..' || child.includes('/') || child.includes('\\') || path.isAbsolute(child)) {
    throw new ComponentUpdateActivationError('UPDATE_LIVE_PATH_INVALID')
  }
  const result = path.resolve(root, child)
  if (!samePath(path.dirname(result), root)) throw new ComponentUpdateActivationError('UPDATE_LIVE_PATH_INVALID')
  return result
}

function assertDescendant(root: string, candidate: string): void {
  const relative = path.relative(path.resolve(root), path.resolve(candidate))
  if (relative === '' || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new ComponentUpdateActivationError('UPDATE_LIVE_PATH_ESCAPE')
  }
}

function pathsOverlap(left: string, right: string): boolean {
  const leftRoot = `${normalizePath(left)}${path.sep}`
  const rightRoot = `${normalizePath(right)}${path.sep}`
  return leftRoot.startsWith(rightRoot) || rightRoot.startsWith(leftRoot)
}

function sameSnapshot(left: BigIntStats, right: BigIntStats): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size &&
    left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs
}

function canonicalJson(value: unknown): string { return JSON.stringify(sortCanonical(value)) }
function sortCanonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortCanonical)
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).sort(([a], [b]) => compareText(a, b))
      .map(([key, entry]) => [key, sortCanonical(entry)]))
  }
  return value
}

function fingerprintRequest(request: unknown): string {
  return createHash('sha256').update(canonicalJson(request)).digest('hex')
}
function canonicalPathKey(value: string): string { return value.toLocaleLowerCase('en-US') }
function compareText(left: string, right: string): number { return left < right ? -1 : left > right ? 1 : 0 }
function normalizePath(value: string): string { return path.resolve(value).replace(/[\\/]+$/, '').toLocaleLowerCase('en-US') }
function samePath(left: string, right: string): boolean { return normalizePath(left) === normalizePath(right) }
async function pathExists(value: string): Promise<boolean> {
  try { await lstat(value); return true } catch (error) { if (isNodeError(error, 'ENOENT')) return false; throw error }
}
async function unlinkIfPresent(value: string): Promise<void> {
  try { await unlink(value) } catch (error) { if (!isNodeError(error, 'ENOENT')) throw error }
}
async function rmdirIfPresent(value: string): Promise<void> {
  try { await rmdir(value) } catch (error) { if (!isNodeError(error, 'ENOENT')) throw error }
}
function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === code
}
function currentBootId(): string { return Math.round((Date.now() - uptime() * 1_000) / 60_000).toString(36) }
function processIsAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true } catch (error) { return isNodeError(error, 'EPERM') }
}
