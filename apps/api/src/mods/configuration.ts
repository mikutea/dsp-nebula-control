import { createHash, randomUUID } from 'node:crypto'
import { lstat, mkdir, open, readFile, readdir, realpath, rename, unlink } from 'node:fs/promises'
import path from 'node:path'
import { z } from 'zod'
import { applyBepInExPatches, findBepInExValue } from '../game-config/bepinex.js'
import {
  HostMutationOperationCoordinatorError,
  hostMutationReturn,
  hostMutationThrow,
  type HostMutationOperationCoordinator
} from '../host-mutation/operation-coordinator.js'
import { sha256Schema } from '../updates/version.js'
import type { ModDeploymentStateSummary } from './deployment-types.js'

interface ManagedModConfigurationBooleanField {
  id: string
  section: string
  key: string
  type: 'boolean'
  defaultValue: boolean
}

interface ManagedModConfigurationIntegerField {
  id: string
  section: string
  key: string
  type: 'integer'
  minimum: number
  maximum: number
  defaultValue: number
}

interface ManagedModConfigurationSecretField {
  id: string
  section: string
  key: string
  type: 'secret'
  maximumLength: number
  defaultValue: ''
}

export type ManagedModConfigurationField =
  | ManagedModConfigurationBooleanField
  | ManagedModConfigurationIntegerField
  | ManagedModConfigurationSecretField

export interface ManagedModConfigurationSchema {
  id: string
  package: { dependencyId: string; version: string }
  authority:
    | { kind: 'ordinary-mod' }
    | { kind: 'platform'; component: 'nebula' | 'bepInEx'; runtimeVersion: string }
  fileName: string
  fields: readonly ManagedModConfigurationField[]
}

/**
 * Mod configuration is intentionally a closed, reviewed registry. A package
 * cannot supply a path, INI section/key, or schema at request time. Each entry
 * is pinned to a real Thunderstore package version whose generated BepInEx
 * configuration contract was reviewed before inclusion.
 */
export const managedModConfigurationSchemas = [
  {
    id: 'nebula-server-v0-9-22',
    package: { dependencyId: 'nebula-NebulaMultiplayerMod-0.9.22', version: '0.9.22' },
    authority: { kind: 'platform', component: 'nebula', runtimeVersion: '0.9.22.2' },
    fileName: 'nebula.cfg',
    fields: [
      { id: 'server-password', section: 'Nebula - Settings', key: 'ServerPassword', type: 'secret', maximumLength: 128, defaultValue: '' },
      { id: 'host-port', section: 'Nebula - Settings', key: 'HostPort', type: 'integer', minimum: 1, maximum: 65_535, defaultValue: 8469 },
      { id: 'enable-upnp-or-pmp', section: 'Nebula - Settings', key: 'EnableUPnpOrPmpSupport', type: 'boolean', defaultValue: false },
      { id: 'cleanup-inactive-sessions', section: 'Nebula - Settings', key: 'CleanupInactiveSessions', type: 'boolean', defaultValue: false },
      { id: 'sync-ups', section: 'Nebula - Settings', key: 'SyncUps', type: 'boolean', defaultValue: true },
      { id: 'sync-soil', section: 'Nebula - Settings', key: 'SyncSoil', type: 'boolean', defaultValue: false },
      { id: 'remote-access-enabled', section: 'Nebula - Settings', key: 'RemoteAccessEnabled', type: 'boolean', defaultValue: false },
      { id: 'remote-access-password', section: 'Nebula - Settings', key: 'RemoteAccessPassword', type: 'secret', maximumLength: 128, defaultValue: '' },
      { id: 'auto-pause-enabled', section: 'Nebula - Settings', key: 'AutoPauseEnabled', type: 'boolean', defaultValue: true }
    ]
  },
  {
    id: 'bepinex-core-v5-4-17',
    package: { dependencyId: 'xiaoye97-BepInEx-5.4.17', version: '5.4.17' },
    authority: { kind: 'platform', component: 'bepInEx', runtimeVersion: '5.4.17.0' },
    fileName: 'BepInEx.cfg',
    fields: [
      { id: 'assembly-cache', section: 'Caching', key: 'EnableAssemblyCache', type: 'boolean', defaultValue: true },
      { id: 'hide-manager-object', section: 'Chainloader', key: 'HideManagerGameObject', type: 'boolean', defaultValue: false },
      { id: 'console-enabled', section: 'Logging.Console', key: 'Enabled', type: 'boolean', defaultValue: false },
      { id: 'disk-log-enabled', section: 'Logging.Disk', key: 'Enabled', type: 'boolean', defaultValue: true },
      { id: 'append-disk-log', section: 'Logging.Disk', key: 'AppendLog', type: 'boolean', defaultValue: false },
      { id: 'write-unity-log', section: 'Logging.Disk', key: 'WriteUnityLog', type: 'boolean', defaultValue: false }
    ]
  },
  {
    id: 'nebula-compatibility-assist-v0-5-0',
    package: { dependencyId: 'starfi5h-NebulaCompatibilityAssist-0.5.0', version: '0.5.0' },
    authority: { kind: 'ordinary-mod' },
    fileName: 'NebulaCompatibilityAssist.cfg',
    fields: [
      { id: 'dsp-star-map-memo', section: 'Sync Patch', key: 'DSPStarMapMemo', type: 'boolean', defaultValue: true },
      { id: 'more-mega-structure', section: 'Sync Patch', key: 'MoreMegaStructure', type: 'boolean', defaultValue: true },
      { id: 'assembler-vertical-construction', section: 'Sync Patch', key: 'AssemblerVerticalConstruction', type: 'boolean', defaultValue: true },
      { id: 'dsp-battle', section: 'Sync Patch', key: 'DSP_Battle', type: 'boolean', defaultValue: true }
    ]
  },
  {
    id: 'bullet-time-v1-5-13',
    package: { dependencyId: 'starfi5h-BulletTime-1.5.13', version: '1.5.13' },
    authority: { kind: 'ordinary-mod' },
    fileName: 'com.starfi5h.plugin.BulletTime.cfg',
    fields: [
      { id: 'mecha-while-paused', section: 'Pause', key: 'EnableMechaFunc', type: 'boolean', defaultValue: false },
      { id: 'background-autosave', section: 'Save', key: 'EnableBackgroundAutosave', type: 'boolean', defaultValue: false },
      { id: 'hotkey-autosave', section: 'Save', key: 'EnableHotkeyAutosave', type: 'boolean', defaultValue: false },
      { id: 'fast-loading', section: 'Speed', key: 'EnableFastLoading', type: 'boolean', defaultValue: true },
      { id: 'remove-gc', section: 'Speed', key: 'RemoveGC', type: 'boolean', defaultValue: true }
    ]
  },
  {
    id: 'error-analyzer-v1-3-3',
    package: { dependencyId: 'starfi5h-ErrorAnalyzer-1.3.3', version: '1.3.3' },
    authority: { kind: 'ordinary-mod' },
    fileName: 'aaa.dsp.plugin.ErrorAnalyzer.cfg',
    fields: [
      { id: 'debug-mode', section: 'DEBUG Mode', key: 'Enable', type: 'boolean', defaultValue: false },
      { id: 'show-all-patches', section: 'Message', key: 'Show All Patches', type: 'boolean', defaultValue: false },
      { id: 'dump-all-patches', section: 'Message', key: 'Dump All Patches', type: 'boolean', defaultValue: false }
    ]
  }
] as const satisfies readonly ManagedModConfigurationSchema[]
export type ManagedModConfigurationValue = boolean | number | string
export type ManagedModConfigurationStatus = 'applied' | 'rolled-back' | 'rollback-failed'

export interface ManagedModConfigurationRequest {
  requestId: string
  operation: 'configure'
  schemaId: string
  package: { dependencyId: string; version: string }
  expectedDeploymentRevision: string
  expectedConfigurationRevision: string
  changes: Array<{ id: string; value: ManagedModConfigurationValue }>
}

export interface ManagedModConfigurationPreview {
  dryRun: true
  operation: 'configure'
  requestId: string
  schemaId: string
  package: { dependencyId: string; version: string }
  deploymentRevision: string
  configurationRevision: string
  nextConfigurationRevision: string
  requestFingerprint: string
  changes: Array<{ id: string; before: ManagedModConfigurationValue | { configured: boolean }; after: ManagedModConfigurationValue | { configured: boolean }; changed: boolean }>
  stoppedStateRequiredForExecute: true
  executionSupported: true
}

export interface ManagedModConfigurationInspection {
  schemaId: string
  package: { dependencyId: string; version: string }
  deploymentRevision: string
  configurationRevision: string
  fields: Array<{ id: string; type: string; value: ManagedModConfigurationValue | { configured: boolean } }>
}

export interface ManagedModConfigurationReceipt {
  format: 'dyson-control-managed-mod-configuration-receipt'
  schemaVersion: 1
  requestId: string
  operation: 'configure'
  schemaId: string
  package: { dependencyId: string; version: string }
  deploymentRevision: string
  previousConfigurationRevision: string
  newConfigurationRevision: string | null
  status: ManagedModConfigurationStatus
  rollback: 'not-needed' | 'succeeded' | 'failed'
  protectionPointCreated: boolean
  changedFieldIds: string[]
  errorCode: 'MOD_CONFIGURATION_EXECUTION_FAILED' | 'MOD_CONFIGURATION_ROLLBACK_FAILED' | null
  completedAt: string
  reused: boolean
}

export interface ManagedModConfigurationHistoryPage {
  format: 'dyson-control-managed-mod-configuration-history'
  schemaVersion: 1
  items: Array<{ persistedAt: string; receipt: ManagedModConfigurationReceipt }>
  page: { limit: number; returned: number; totalReceipts: number; nextCursor: string | null }
}

export class ManagedModConfigurationError extends Error {
  constructor(readonly code: string) { super(code); this.name = 'ManagedModConfigurationError' }
}

const maximumTransportStringLength = 4_096
const requestSchema: z.ZodType<ManagedModConfigurationRequest> = z.strictObject({
  requestId: z.string().uuid().transform((value) => value.toLowerCase()),
  operation: z.literal('configure'),
  schemaId: z.string().regex(/^[a-z0-9][a-z0-9-]{2,80}$/),
  package: z.strictObject({ dependencyId: z.string().min(7).max(160), version: z.string().min(1).max(64) }),
  expectedDeploymentRevision: sha256Schema,
  expectedConfigurationRevision: sha256Schema,
  changes: z.array(z.strictObject({
    id: z.string().regex(/^[a-z0-9][a-z0-9-]{1,80}$/),
    // Keep the wire value bounded, then let the selected reviewed field schema
    // enforce its tighter limit so callers receive a field-value error.
    value: z.union([z.boolean(), z.number().finite(), z.string().max(maximumTransportStringLength)])
  })).min(1).max(32)
})
const inspectionSchema = z.strictObject({
  schemaId: z.string().regex(/^[a-z0-9][a-z0-9-]{2,80}$/),
  package: z.strictObject({ dependencyId: z.string().min(7).max(160), version: z.string().min(1).max(64) }),
  expectedDeploymentRevision: sha256Schema
})
const maximumConfigBytes = 512 * 1024
const schemaById = new Map<string, ManagedModConfigurationSchema>(managedModConfigurationSchemas.map((schema) => [schema.id, schema]))

export interface ManagedModConfigurationServiceOptions {
  /** Fixed server-side BepInEx/config directory, never an HTTP parameter. */
  configRoot: string
  readDeploymentState: () => Promise<ModDeploymentStateSummary>
  /** Exact runtime component inventory for schemas owned outside the ordinary-mod tree. */
  readPlatformState?: () => Promise<{ nebula: string; bepInEx: string }>
  verifyStoppedState: () => Promise<{ processStopped: boolean; portClosed: boolean }>
  hostMutationCoordinator: HostMutationOperationCoordinator
  now?: () => Date
}

export class ManagedModConfigurationService {
  readonly #root: string
  readonly #readDeploymentState: ManagedModConfigurationServiceOptions['readDeploymentState']
  readonly #readPlatformState: ManagedModConfigurationServiceOptions['readPlatformState']
  readonly #verifyStoppedState: ManagedModConfigurationServiceOptions['verifyStoppedState']
  readonly #coordinator: HostMutationOperationCoordinator
  readonly #now: () => Date
  #tail: Promise<void> = Promise.resolve()

  constructor(options: ManagedModConfigurationServiceOptions) {
    if (!path.isAbsolute(options.configRoot) || path.resolve(options.configRoot) === path.parse(path.resolve(options.configRoot)).root ||
        typeof options.readDeploymentState !== 'function' || typeof options.verifyStoppedState !== 'function' ||
        !options.hostMutationCoordinator || typeof options.hostMutationCoordinator.runExclusive !== 'function') {
      throw new ManagedModConfigurationError('MOD_CONFIGURATION_ROOT_INVALID')
    }
    this.#root = path.resolve(options.configRoot)
    this.#readDeploymentState = options.readDeploymentState
    this.#readPlatformState = options.readPlatformState
    this.#verifyStoppedState = options.verifyStoppedState
    this.#coordinator = options.hostMutationCoordinator
    this.#now = options.now ?? (() => new Date())
  }

  schemas(): Array<{
    id: string
    package: { dependencyId: string; version: string }
    fields: Array<{ id: string; type: string; secret: boolean; minimum?: number; maximum?: number; maximumLength?: number }>
  }> {
    return managedModConfigurationSchemas.map((schema) => ({
      id: schema.id,
      package: { ...schema.package },
      fields: schema.fields.map((field) => ({
        id: field.id,
        type: field.type,
        secret: field.type === 'secret',
        ...(field.type === 'integer' ? { minimum: field.minimum, maximum: field.maximum } : {}),
        ...(field.type === 'secret' ? { maximumLength: field.maximumLength } : {})
      }))
    }))
  }

  async preview(input: unknown): Promise<ManagedModConfigurationPreview> {
    const request = parseRequest(input)
    return await this.#serial(async () => this.#previewOf(await this.#prepare(request)))
  }

  async inspect(input: unknown): Promise<ManagedModConfigurationInspection> {
    const parsed = inspectionSchema.safeParse(input)
    if (!parsed.success) throw new ManagedModConfigurationError('MOD_CONFIGURATION_REQUEST_INVALID')
    return await this.#serial(async () => {
      const schema = schemaById.get(parsed.data.schemaId)
      if (!schema || schema.package.dependencyId !== parsed.data.package.dependencyId || schema.package.version !== parsed.data.package.version) {
        throw new ManagedModConfigurationError('MOD_CONFIGURATION_SCHEMA_UNAVAILABLE')
      }
      const deployment = await this.#readDeploymentState()
      if (deployment.revision !== parsed.data.expectedDeploymentRevision) throw new ManagedModConfigurationError('MOD_CONFIGURATION_DEPLOYMENT_REVISION_CONFLICT')
      await this.#assertPackageAvailable(schema, deployment)
      const source = await readRegularTextFile(safeChild(await this.#prepareRoot(), schema.fileName))
      return {
        schemaId: schema.id, package: { ...schema.package }, deploymentRevision: deployment.revision,
        configurationRevision: digest(source),
        fields: schema.fields.map((field) => ({ id: field.id, type: field.type, value: publicValue(field, findBepInExValue(source, field.section, field.key)) }))
      }
    })
  }

  async execute(input: unknown): Promise<ManagedModConfigurationReceipt> {
    const request = parseRequest(input)
    return await this.#serial(async () => {
      const prior = await this.#readReceipt(request.requestId)
      const fingerprint = digest(JSON.stringify(request))
      if (prior) {
        if (prior.fingerprint !== fingerprint) throw new ManagedModConfigurationError('MOD_CONFIGURATION_IDEMPOTENCY_CONFLICT')
        return { ...prior.receipt, reused: true }
      }
      const prepared = await this.#prepare(request)
      try {
        return await this.#coordinator.runExclusive({ operation: 'mod-deployment-configure', requestId: request.requestId }, async () => {
          const stopped = await this.#verifyStoppedState()
          if (!stopped.processStopped || !stopped.portClosed) {
            return hostMutationThrow(new ManagedModConfigurationError('MOD_CONFIGURATION_STOP_GATE_REJECTED'), 'release')
          }
          try {
            const receipt = await this.#commit(prepared)
            return hostMutationReturn(receipt, receipt.status === 'rollback-failed' ? 'abandon' : 'release')
          } catch (error) {
            return hostMutationThrow(
              error instanceof ManagedModConfigurationError ? error : new ManagedModConfigurationError('MOD_CONFIGURATION_EXECUTION_FAILED'),
              'abandon'
            )
          }
        })
      } catch (error) {
        if (error instanceof ManagedModConfigurationError) throw error
        if (error instanceof HostMutationOperationCoordinatorError) throw new ManagedModConfigurationError('MOD_CONFIGURATION_HOST_LEASE_UNAVAILABLE')
        throw new ManagedModConfigurationError('MOD_CONFIGURATION_HOST_LEASE_UNAVAILABLE')
      }
    })
  }

  async history(input: { cursor?: string | null; pageSize?: number } = {}): Promise<ManagedModConfigurationHistoryPage> {
    const pageSize = input.pageSize ?? 20
    if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 100 || (input.cursor !== undefined && input.cursor !== null && !/^[A-Za-z0-9_-]{1,256}$/.test(input.cursor))) {
      throw new ManagedModConfigurationError('MOD_CONFIGURATION_HISTORY_REQUEST_INVALID')
    }
    return await this.#serial(async () => {
      const root = await this.#prepareRoot()
      const receipts = await this.#readAllReceipts(root)
      const offset = input.cursor ? Number(Buffer.from(input.cursor, 'base64url').toString('ascii')) : 0
      if (!Number.isInteger(offset) || offset < 0 || offset > receipts.length) throw new ManagedModConfigurationError('MOD_CONFIGURATION_HISTORY_REQUEST_INVALID')
      const selected = receipts.slice(offset, offset + pageSize)
      const next = offset + selected.length < receipts.length ? Buffer.from(String(offset + selected.length), 'ascii').toString('base64url') : null
      return { format: 'dyson-control-managed-mod-configuration-history', schemaVersion: 1, items: selected, page: { limit: pageSize, returned: selected.length, totalReceipts: receipts.length, nextCursor: next } }
    })
  }

  async receipt(requestIdInput: unknown): Promise<ManagedModConfigurationReceipt | null> {
    const parsed = z.string().uuid().safeParse(requestIdInput)
    if (!parsed.success) throw new ManagedModConfigurationError('MOD_CONFIGURATION_RECEIPT_REQUEST_INVALID')
    return await this.#serial(async () => {
      const stored = await this.#readReceipt(parsed.data.toLowerCase())
      return stored === null ? null : { ...stored.receipt, reused: true }
    })
  }

  async #assertPackageAvailable(
    schema: ManagedModConfigurationSchema,
    deployment: ModDeploymentStateSummary
  ): Promise<void> {
    if (schema.authority.kind === 'ordinary-mod') {
      const deployed = deployment.packages.find((entry) =>
        entry.dependencyId === schema.package.dependencyId && entry.version === schema.package.version)
      if (!deployed || !deployed.enabled) throw new ManagedModConfigurationError('MOD_CONFIGURATION_PACKAGE_UNAVAILABLE')
      return
    }

    const readPlatformState = this.#readPlatformState
    if (readPlatformState === undefined) throw new ManagedModConfigurationError('MOD_CONFIGURATION_PACKAGE_UNAVAILABLE')
    try {
      const platform = await readPlatformState()
      if (platform[schema.authority.component] !== schema.authority.runtimeVersion) {
        throw new ManagedModConfigurationError('MOD_CONFIGURATION_PACKAGE_UNAVAILABLE')
      }
    } catch (error) {
      if (error instanceof ManagedModConfigurationError) throw error
      throw new ManagedModConfigurationError('MOD_CONFIGURATION_PACKAGE_UNAVAILABLE')
    }
  }

  async #prepare(request: ManagedModConfigurationRequest): Promise<PreparedConfiguration> {
    const schema = schemaById.get(request.schemaId)
    if (!schema || schema.package.dependencyId !== request.package.dependencyId || schema.package.version !== request.package.version) {
      throw new ManagedModConfigurationError('MOD_CONFIGURATION_SCHEMA_UNAVAILABLE')
    }
    const deployment = await this.#readDeploymentState()
    if (deployment.revision !== request.expectedDeploymentRevision) throw new ManagedModConfigurationError('MOD_CONFIGURATION_DEPLOYMENT_REVISION_CONFLICT')
    await this.#assertPackageAvailable(schema, deployment)
    const root = await this.#prepareRoot()
    const filePath = safeChild(root, schema.fileName)
    const source = await readRegularTextFile(filePath)
    const revision = digest(source)
    if (revision !== request.expectedConfigurationRevision) throw new ManagedModConfigurationError('MOD_CONFIGURATION_REVISION_CONFLICT')
    const seen = new Set<string>()
    const patches: Array<{ section: string; key: string; value: string }> = []
    const changes: ManagedModConfigurationPreview['changes'] = []
    for (const change of request.changes) {
      if (seen.has(change.id)) throw new ManagedModConfigurationError('MOD_CONFIGURATION_DUPLICATE_FIELD')
      seen.add(change.id)
      const field = schema.fields.find((entry) => entry.id === change.id)
      if (!field) throw new ManagedModConfigurationError('MOD_CONFIGURATION_FIELD_UNAVAILABLE')
      const value = normalizeValue(field, change.value)
      const current = findBepInExValue(source, field.section, field.key)
      const before = publicValue(field, current)
      const after = publicValue(field, stringifyValue(field, value))
      changes.push({ id: field.id, before, after, changed: JSON.stringify(before) !== JSON.stringify(after) })
      patches.push({ section: field.section, key: field.key, value: stringifyValue(field, value) })
    }
    const next = applyBepInExPatches(source, patches)
    return { request, root, filePath, source, next, schema, deploymentRevision: deployment.revision, revision, nextRevision: digest(next), changes }
  }

  #previewOf(prepared: PreparedConfiguration): ManagedModConfigurationPreview {
    return {
      dryRun: true, operation: 'configure', requestId: prepared.request.requestId,
      schemaId: prepared.request.schemaId, package: { ...prepared.request.package },
      deploymentRevision: prepared.deploymentRevision, configurationRevision: prepared.revision,
      nextConfigurationRevision: prepared.nextRevision,
      requestFingerprint: managedModConfigurationRequestFingerprint(prepared.request),
      changes: prepared.changes,
      stoppedStateRequiredForExecute: true, executionSupported: true
    }
  }

  async #commit(prepared: PreparedConfiguration): Promise<ManagedModConfigurationReceipt> {
    const deployment = await this.#readDeploymentState()
    if (deployment.revision !== prepared.deploymentRevision) {
      throw new ManagedModConfigurationError('MOD_CONFIGURATION_DEPLOYMENT_REVISION_CONFLICT')
    }
    await this.#assertPackageAvailable(prepared.schema, deployment)
    const root = await this.#prepareRoot()
    const current = await readRegularTextFile(prepared.filePath)
    if (digest(current) !== prepared.revision) throw new ManagedModConfigurationError('MOD_CONFIGURATION_REVISION_CONFLICT')
    const control = await this.#controlRoot(root)
    const snapshot = safeChild(await ensureRegularDirectory(safeChild(control, 'snapshots')), `${prepared.request.requestId}.cfg`)
    const receipt: ManagedModConfigurationReceipt = {
      format: 'dyson-control-managed-mod-configuration-receipt', schemaVersion: 1, requestId: prepared.request.requestId,
      operation: 'configure', schemaId: prepared.request.schemaId, package: { ...prepared.request.package }, deploymentRevision: prepared.deploymentRevision,
      previousConfigurationRevision: prepared.revision, newConfigurationRevision: null, status: 'rolled-back', rollback: 'succeeded', protectionPointCreated: false,
      changedFieldIds: prepared.changes.filter((entry) => entry.changed).map((entry) => entry.id), errorCode: 'MOD_CONFIGURATION_EXECUTION_FAILED', completedAt: this.#now().toISOString(), reused: false
    }
    try {
      await writeAtomic(snapshot, prepared.source)
      receipt.protectionPointCreated = true
      await writeAtomic(prepared.filePath, prepared.next)
      const verified = await readRegularTextFile(prepared.filePath)
      if (digest(verified) !== prepared.nextRevision) throw new Error('verification')
      receipt.status = 'applied'; receipt.rollback = 'not-needed'; receipt.newConfigurationRevision = prepared.nextRevision; receipt.errorCode = null
      await this.#writeReceipt(root, digest(JSON.stringify(prepared.request)), receipt)
    } catch {
      if (!receipt.protectionPointCreated) throw new ManagedModConfigurationError('MOD_CONFIGURATION_EXECUTION_FAILED')
      try {
        await writeAtomic(prepared.filePath, prepared.source)
        if (digest(await readRegularTextFile(prepared.filePath)) !== prepared.revision) throw new Error('rollback verification')
        receipt.status = 'rolled-back'; receipt.rollback = 'succeeded'; receipt.newConfigurationRevision = null; receipt.errorCode = 'MOD_CONFIGURATION_EXECUTION_FAILED'
      } catch {
        receipt.status = 'rollback-failed'; receipt.rollback = 'failed'; receipt.errorCode = 'MOD_CONFIGURATION_ROLLBACK_FAILED'
      }
      try {
        await this.#writeReceipt(root, digest(JSON.stringify(prepared.request)), receipt)
      } catch {
        throw new ManagedModConfigurationError('MOD_CONFIGURATION_RECEIPT_PERSIST_FAILED')
      }
    }
    return receipt
  }

  async #prepareRoot(): Promise<string> {
    const info = await lstat(this.#root).catch(() => { throw new ManagedModConfigurationError('MOD_CONFIGURATION_ROOT_UNAVAILABLE') })
    if (!info.isDirectory() || info.isSymbolicLink() || !await hasNoReparsePoint(this.#root)) throw new ManagedModConfigurationError('MOD_CONFIGURATION_ROOT_UNAVAILABLE')
    return this.#root
  }

  async #controlRoot(root: string): Promise<string> { return await ensureRegularDirectory(safeChild(root, '.dyson-control-managed-mod-config')) }
  async #writeReceipt(root: string, fingerprint: string, receipt: ManagedModConfigurationReceipt): Promise<void> {
    const directory = await ensureRegularDirectory(safeChild(await this.#controlRoot(root), 'receipts'))
    await writeAtomic(safeChild(directory, `${receipt.requestId}.json`), JSON.stringify({ fingerprint, persistedAt: this.#now().toISOString(), receipt }))
  }
  async #readReceipt(requestId: string): Promise<{ fingerprint: string; receipt: ManagedModConfigurationReceipt } | null> {
    const root = await this.#prepareRoot()
    const control = await this.#existingControlRoot(root)
    if (!control) return null
    const receipts = await this.#existingRegularDirectory(safeChild(control, 'receipts'))
    if (!receipts) return null
    const file = safeChild(receipts, `${requestId}.json`)
    try { const raw = JSON.parse(await readRegularTextFile(file)) as { fingerprint?: unknown; receipt?: unknown }; return parseStoredReceipt(raw) } catch (error) { if (isMissing(error)) return null; throw new ManagedModConfigurationError('MOD_CONFIGURATION_RECEIPT_INVALID') }
  }
  async #readAllReceipts(root: string): Promise<Array<{ persistedAt: string; receipt: ManagedModConfigurationReceipt }>> {
    const control = await this.#existingControlRoot(root)
    if (!control) return []
    const directory = await this.#existingRegularDirectory(safeChild(control, 'receipts'))
    if (!directory) return []
    try {
      const entries = await readdir(directory, { withFileTypes: true }); const result: Array<{ persistedAt: string; receipt: ManagedModConfigurationReceipt }> = []
      for (const entry of entries) {
        if (!entry.isFile() || entry.isSymbolicLink() || !/^[0-9a-f-]{36}\.json$/.test(entry.name)) throw new ManagedModConfigurationError('MOD_CONFIGURATION_RECEIPT_INVALID')
        const raw = JSON.parse(await readRegularTextFile(safeChild(directory, entry.name))) as { persistedAt?: unknown; receipt?: unknown }
        const stored = parseStoredReceipt(raw); if (!stored || typeof raw.persistedAt !== 'string') throw new ManagedModConfigurationError('MOD_CONFIGURATION_RECEIPT_INVALID')
        result.push({ persistedAt: raw.persistedAt, receipt: stored.receipt })
      }
      return result.sort((left, right) => right.persistedAt.localeCompare(left.persistedAt))
    } catch (error) { if (isMissing(error)) return []; throw error }
  }
  async #existingControlRoot(root: string): Promise<string | null> {
    return await this.#existingRegularDirectory(safeChild(root, '.dyson-control-managed-mod-config'))
  }
  async #existingRegularDirectory(directory: string): Promise<string | null> {
    try {
      const info = await lstat(directory)
      if (!info.isDirectory() || info.isSymbolicLink() || !await hasNoReparsePoint(directory)) {
        throw new ManagedModConfigurationError('MOD_CONFIGURATION_PATH_INVALID')
      }
      return directory
    } catch (error) {
      if (isMissing(error)) return null
      throw error
    }
  }
  async #serial<T>(work: () => Promise<T>): Promise<T> { const prior = this.#tail; let release!: () => void; this.#tail = new Promise<void>((resolve) => { release = resolve }); await prior; try { return await work() } finally { release() } }
}

interface PreparedConfiguration { request: ManagedModConfigurationRequest; root: string; filePath: string; source: string; next: string; schema: ManagedModConfigurationSchema; deploymentRevision: string; revision: string; nextRevision: string; changes: ManagedModConfigurationPreview['changes'] }

function parseRequest(input: unknown): ManagedModConfigurationRequest { const parsed = requestSchema.safeParse(input); if (!parsed.success) throw new ManagedModConfigurationError('MOD_CONFIGURATION_REQUEST_INVALID'); return parsed.data }
export function managedModConfigurationRequestFingerprint(input: unknown): string {
  return digest(JSON.stringify(parseRequest(input)))
}
function normalizeValue(field: ManagedModConfigurationField, value: ManagedModConfigurationValue): ManagedModConfigurationValue {
  if (field.type === 'boolean' && typeof value === 'boolean') return value
  if (field.type === 'integer' && typeof value === 'number' && Number.isInteger(value) && value >= field.minimum && value <= field.maximum) return value
  if (field.type === 'secret' && typeof value === 'string' && value.length <= field.maximumLength && !/[\r\n\0]/.test(value)) return value
  throw new ManagedModConfigurationError('MOD_CONFIGURATION_VALUE_INVALID')
}
function stringifyValue(field: ManagedModConfigurationField, value: ManagedModConfigurationValue): string { return field.type === 'boolean' ? (value ? 'true' : 'false') : String(value) }
function publicValue(field: ManagedModConfigurationField, value: string | null): ManagedModConfigurationValue | { configured: boolean } {
  if (field.type === 'secret') return { configured: value !== null && value.length > 0 }
  if (value === null) return field.defaultValue
  if (field.type === 'boolean') {
    if (!/^(?:true|false)$/i.test(value)) throw new ManagedModConfigurationError('MOD_CONFIGURATION_FILE_INVALID')
    return value.toLowerCase() === 'true'
  }
  if (!/^-?\d+$/.test(value)) throw new ManagedModConfigurationError('MOD_CONFIGURATION_FILE_INVALID')
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < field.minimum || parsed > field.maximum) {
    throw new ManagedModConfigurationError('MOD_CONFIGURATION_FILE_INVALID')
  }
  return parsed
}
function digest(value: string): string { return createHash('sha256').update(value, 'utf8').digest('hex') }
function safeChild(root: string, name: string): string { if (!/^[A-Za-z0-9._-]{1,160}$/.test(name)) throw new ManagedModConfigurationError('MOD_CONFIGURATION_PATH_INVALID'); const candidate = path.resolve(root, name); if (path.dirname(candidate) !== path.resolve(root)) throw new ManagedModConfigurationError('MOD_CONFIGURATION_PATH_INVALID'); return candidate }
async function readRegularTextFile(file: string): Promise<string> { const info = await lstat(file).catch((error) => { throw error }); if (!info.isFile() || info.isSymbolicLink() || info.size > maximumConfigBytes || !await hasNoReparsePoint(file)) throw new ManagedModConfigurationError('MOD_CONFIGURATION_FILE_INVALID'); const source = await readFile(file, 'utf8'); if (source.includes('\0')) throw new ManagedModConfigurationError('MOD_CONFIGURATION_FILE_INVALID'); return source }
async function ensureRegularDirectory(directory: string): Promise<string> { await mkdir(directory, { recursive: true }); const info = await lstat(directory); if (!info.isDirectory() || info.isSymbolicLink() || !await hasNoReparsePoint(directory)) throw new ManagedModConfigurationError('MOD_CONFIGURATION_PATH_INVALID'); return directory }
async function writeAtomic(file: string, source: string): Promise<void> { const directory = path.dirname(file); await ensureRegularDirectory(directory); const temp = path.join(directory, `.${path.basename(file)}.${randomUUID()}.partial`); let handle: Awaited<ReturnType<typeof open>> | null = null; try { handle = await open(temp, 'wx', 0o600); await handle.writeFile(source, 'utf8'); await handle.sync(); await handle.close(); handle = null; await rename(temp, file); const written = await lstat(file); if (!written.isFile() || written.isSymbolicLink() || !await hasNoReparsePoint(file)) throw new ManagedModConfigurationError('MOD_CONFIGURATION_FILE_INVALID') } finally { await handle?.close().catch(() => undefined); await unlink(temp).catch(() => undefined) } }
function parseStoredReceipt(value: unknown): { fingerprint: string; receipt: ManagedModConfigurationReceipt } | null { if (!value || typeof value !== 'object') return null; const record = value as { fingerprint?: unknown; receipt?: unknown }; if (typeof record.fingerprint !== 'string' || !/^[0-9a-f]{64}$/.test(record.fingerprint) || !record.receipt || typeof record.receipt !== 'object') return null; const receipt = record.receipt as ManagedModConfigurationReceipt; if (receipt.format !== 'dyson-control-managed-mod-configuration-receipt' || receipt.schemaVersion !== 1 || receipt.operation !== 'configure' || !/^[0-9a-f-]{36}$/.test(receipt.requestId)) return null; return { fingerprint: record.fingerprint, receipt } }
async function hasNoReparsePoint(target: string): Promise<boolean> { const parent = await realpath(path.dirname(target)); const actual = await realpath(target); return samePath(actual, path.join(parent, path.basename(target))) }
function samePath(left: string, right: string): boolean { return comparablePath(left) === comparablePath(right) }
function comparablePath(value: string): string { return path.resolve(value.replace(/^(?:\\\\\?\\|\/\/\?\/)/, '')).replace(/[\\/]+$/, '').toLowerCase() }
function isMissing(error: unknown): boolean { return typeof error === 'object' && error !== null && 'code' in error && (error as { code?: unknown }).code === 'ENOENT' }
