import path from 'node:path'
import fs from 'node:fs'
import { Readable } from 'node:stream'
import Fastify, { type FastifyInstance, type FastifyReply } from 'fastify'
import cookie from '@fastify/cookie'
import helmet from '@fastify/helmet'
import rateLimit from '@fastify/rate-limit'
import fastifyStatic from '@fastify/static'
import { z } from 'zod'
import apiPackage from '../package.json' with { type: 'json' }
import type { AppConfig } from './config.js'
import { DemoProvider } from './providers/demo.js'
import { WindowsProvider } from './providers/windows.js'
import { DisabledLifecycleAdapter } from './providers/disabled-lifecycle.js'
import { WindowsLifecycleAdapter } from './providers/windows-lifecycle.js'
import { PowerShellLifecycleRunner } from './providers/powershell-runner.js'
import { WindowsUpdateActivationAdapters } from './providers/windows-update-activation.js'
import { createWindowsManagedPluginVersionProbe } from './providers/windows-managed-plugin-version.js'
import { FileBridgeClient } from './bridge/file-client.js'
import { AuthService } from './security/auth.js'
import {
  authenticatedUserFor,
  can,
  controlRoles,
  requirePermission,
  type ControlPermission
} from './security/authorization.js'
import { ControlDatabase } from './storage/database.js'
import { EventHub } from './services/event-hub.js'
import { JobService } from './services/job-service.js'
import { LifecycleExecutionError, LifecycleService } from './services/lifecycle-service.js'
import { HostMutationLeaseManager } from './host-mutation/lease.js'
import {
  HostMutationLifecycleCoordinator,
  type LifecycleMutationCoordinator
} from './host-mutation/lifecycle-coordinator.js'
import {
  HostMutationCoordinator,
  type HostMutationOperationCoordinator
} from './host-mutation/operation-coordinator.js'
import {
  SaveJobService,
  SaveJobServiceError,
  type SaveJobExecutionResult
} from './services/save-job-service.js'
import {
  lifecycleActionRequestSchema,
  lifecycleExecutionRequestSchema,
  type LifecycleMutationAdapter,
  type ServerStatus,
  type StatusProvider
} from './domain.js'
import {
  backupIdSchema,
  BackupRetentionControlService,
  BackupRetentionHttpController,
  catalogBackups,
  catalogSavePairs,
  MAX_BACKUP_PAGE_SIZE,
  MAX_CATALOG_PAGE_SIZE,
  SaveCatalogError,
  SavePairTransferService,
  SaveTransferError,
  SaveTransactionService,
  saveNameSchema,
  type SaveTransactionResult,
  type BackupRetentionRoutesController,
  registerBackupRetentionRoutes,
  verifyBackupPair
} from './saves/index.js'
import { readGameConfigurationFiles } from './game-config/filesystem.js'
import {
  GameConfigPlanError,
  inspectGameConfiguration,
  planGameConfiguration
} from './game-config/planner.js'
import { GameConfigValidationError } from './game-config/catalog.js'
import {
  GameConfigTransactionService,
  type GameConfigTransactionResult
} from './game-config/transaction.js'
import { GameConfigHistoryService } from './game-config/history.js'
import { GameConfigHistoryHttpController } from './game-config/history-http.js'
import type { GameConfigHistoryRoutesController } from './game-config/history-routes.js'
import { registerGameConfigHistoryRoutes } from './game-config/history-routes.js'
import { WindowsConfigHistoryStopProofAuthorizer } from './providers/windows-config-history-stop-proof.js'
import {
  ConsoleCommandError,
  ConsoleLogError,
  StructuredLogReader,
  createStructuredLogDownloadPlan,
  executeConsoleCommand,
  executeStructuredLogDownload,
  previewConsoleCommand
} from './console/index.js'
import {
  CompatibilityValidationError,
  UpdatePlanTransitionError,
  VersionValidationError,
  createUpdatePlan
} from './updates/index.js'
import {
  clientParityManifestSchema,
  DEFAULT_MOD_DEPLOYMENT_HISTORY_PAGE_SIZE,
  MAX_MOD_DEPLOYMENT_HISTORY_CURSOR_LENGTH,
  MAX_MOD_DEPLOYMENT_HISTORY_PAGE_SIZE,
  ModDeploymentError,
  ModDeploymentService,
  ModManifestError,
  ModResolutionInputError,
  modPlatformLockSchema,
  serverModLockSchema,
  ThunderstoreModImportHttpController,
  ThunderstoreModImporter,
  ThunderstoreDependencyError,
  VerifiedModLockError,
  VerifiedModLockService,
  thunderstoreDependencyIdSchema,
  generateModManifests,
  resolveModGraph,
  type ModDeploymentRequest
} from './mods/index.js'
import {
  FilePlayerCapabilitySource,
  FilePlayerSnapshotSource,
  PersistentPlayerPresenceHistory,
  PlayerCapabilityError,
  PlayerSnapshotError,
  playerCapabilityReasonSummaries,
  type PlayerCapabilitySnapshot,
  type PlayerPresenceHistoryStore,
  type PlayerSnapshot
} from './players/index.js'
import {
  ArtifactAcquisitionHttpController,
  BepInExGithubReleaseClient,
  ComponentCandidatePreparationHttpController,
  ComponentCandidatePreparationService,
  ManagedArtifactAcquisitionService,
  NebulaGithubReleaseClient,
  OfflineArtifactStager,
  ComponentUpdateActivationHttpController,
  ComponentUpdateActivationService,
  TrustedCompatibilityHttpController,
  TrustedCompatibilityService,
  ThunderstoreReleaseClient,
  UpdatePipelineError,
  createUpdatePreparationPlan,
  routeThunderstoreDependency,
  thunderstoreDependencyFingerprint,
  type DiscoveredModRelease,
  type DiscoveredModDependencyClosure,
  type DiscoveredBepInExRelease,
  type PagedDiscoveryResult,
  type DiscoveredNebulaRelease,
  type ArtifactCandidateDescriptor,
  type StageArtifactResult,
  type ArtifactStagePlan
} from './update-pipeline/index.js'
import {
  ClientProfileArtifactError,
  ClientProfileGenerationError,
  ClientProfileZipError,
  CLIENT_PROFILE_ZIP_FILE_NAME,
  buildClientProfileZip,
  generateClientProfile,
  verifyClientProfileZip
} from './client-profile/index.js'
import {
  ObservabilityAlertError,
  PersistentObservabilityHistory,
  PersistentObservabilityAlerts,
  PersistentObservabilityAlertError,
  buildObservabilityFromServerStatus,
  evaluateLateGameQualification,
  type ObservabilityHistoryStore,
  type ServerObservabilitySnapshot
} from './observability/index.js'

const loginSchema = z.strictObject({
  role: z.enum(controlRoles).default('administrator'),
  password: z.string().min(1).max(512)
})
const catalogQuerySchema = (maximumPageSize: number) => z.strictObject({
  cursor: z.string().min(1).max(64).regex(/^[A-Za-z0-9_-]+$/).optional(),
  pageSize: z.coerce.number().int().min(1).max(maximumPageSize).optional()
})
const configurationPreviewSchema = z.strictObject({
  expectedRevision: z.string().length(64).regex(/^[0-9a-f]{64}$/),
  changes: z.array(z.strictObject({
    id: z.string().min(1).max(128),
    value: z.union([z.boolean(), z.number(), z.string().max(128)])
  })).min(1).max(32)
})
const configurationApplySchema = configurationPreviewSchema.extend({ confirmation: z.literal('APPLY_CONFIG') }).strict()
const emptyObjectSchema = z.strictObject({})
const thunderstoreDiscoveryRequestSchema = z.strictObject({
  namespace: z.string().min(1).max(64).regex(/^[A-Za-z0-9_]+$/),
  name: z.string().min(1).max(64).regex(/^[A-Za-z0-9_]+$/),
  community: z.literal('dyson-sphere-program').optional()
})
const acquisitionReceiptParamsSchema = z.strictObject({ requestId: z.string().uuid() })
const acquisitionCandidateDescriptorSchema: z.ZodType<ArtifactCandidateDescriptor> = z.strictObject({
  candidateId: z.string().regex(/^candidate-[0-9a-f]{48}$/),
  provider: z.enum(['github', 'thunderstore']),
  release: z.strictObject({
    kind: z.enum(['nebula', 'bepinex', 'plugin']),
    sourceId: z.string().min(3).max(160).regex(/^(?:github|thunderstore):[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/),
    version: z.string().trim().min(1).max(64),
    dependencies: z.array(z.string().min(7).max(170)).max(64).optional(),
    dependencyFingerprint: z.string().length(64).regex(/^[a-f0-9]{64}$/).optional()
  }),
  artifact: z.strictObject({
    artifactId: z.string().min(16).max(96).regex(/^[a-z0-9][a-z0-9-]+$/),
    fileName: z.string().min(5).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9._-]*\.zip$/i),
    sizeBytes: z.number().int().positive().max(2 * 1_024 * 1_024 * 1_024).nullable(),
    sha256: z.string().length(64).regex(/^[a-f0-9]{64}$/).nullable(),
    integrity: z.enum(['provider-sha256', 'locally-computed-required'])
  }),
  expiresAt: z.string().datetime({ offset: true })
})
const stagingExecutionSchema = z.strictObject({
  request: z.unknown(),
  confirmation: z.literal('STAGE_ARTIFACT')
})
const backupSaveRequestSchema = z.strictObject({
  requestId: z.string().uuid(),
  saveName: saveNameSchema
})
const executeBackupSaveRequestSchema = backupSaveRequestSchema.extend({
  confirmation: z.literal('CREATE_BACKUP')
}).strict()
const restoreSaveRequestSchema = z.strictObject({
  requestId: z.string().uuid(),
  backupId: backupIdSchema,
  expectedRevision: z.string().regex(/^pair-v1:[a-f0-9]{64}$/),
  protectionRequestId: z.string().uuid()
})
const executeRestoreSaveRequestSchema = restoreSaveRequestSchema.extend({
  confirmation: z.literal('RESTORE_SAVE_PAIR')
}).strict()
const reconcileSaveJobRequestSchema = z.strictObject({
  confirmation: z.literal('RECONCILE_SAVE_JOB')
})
const observabilityHistoryQuerySchema = z.strictObject({
  points: z.coerce.number().int().min(1).max(120).optional()
})
const observabilityAlertParamsSchema = z.strictObject({
  episodeId: z.string().min(1).max(96).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/)
})
const observabilityAlertAcknowledgeSchema = z.strictObject({
  confirmation: z.literal('ACKNOWLEDGE_ALERT')
})
const modDeploymentRequestSchema: z.ZodType<ModDeploymentRequest> = z.strictObject({
  requestId: z.string().uuid().transform((value) => value.toLowerCase()),
  operation: z.enum(['install', 'update', 'enable', 'disable', 'remove']),
  package: z.strictObject({
    dependencyId: thunderstoreDependencyIdSchema,
    version: z.string().min(5).max(64)
  }),
  manifest: z.strictObject({
    serverLock: serverModLockSchema,
    clientParity: clientParityManifestSchema,
    platformLock: modPlatformLockSchema
  }),
  expectedRevision: z.string().length(64).regex(/^[0-9a-f]{64}$/)
})
const modDeploymentExecuteSchema = z.strictObject({
  request: modDeploymentRequestSchema,
  confirmation: z.strictObject({
    action: z.literal('EXECUTE_MOD_DEPLOYMENT'),
    requestId: z.string().uuid(),
    operation: z.enum(['install', 'update', 'enable', 'disable', 'remove']),
    dependencyId: thunderstoreDependencyIdSchema,
    version: z.string().min(5).max(64),
    expectedRevision: z.string().length(64).regex(/^[0-9a-f]{64}$/)
  })
})
const modDeploymentReceiptParamsSchema = z.strictObject({
  requestId: z.string().uuid().transform((value) => value.toLowerCase())
})
const modDeploymentHistoryQuerySchema = z.strictObject({
  cursor: z.string().min(1).max(MAX_MOD_DEPLOYMENT_HISTORY_CURSOR_LENGTH)
    .regex(/^[A-Za-z0-9_-]+$/).optional(),
  pageSize: z.coerce.number().int().min(1).max(MAX_MOD_DEPLOYMENT_HISTORY_PAGE_SIZE).optional()
})
const runtimeStoppedResultSchema = z.strictObject({
  protocol: z.literal('DYSON_CONTROL_RUNTIME_V1'),
  expected: z.literal('stopped'),
  state: z.literal('matched'),
  processVerified: z.literal(true),
  gamePortListening: z.literal(false)
})
const observabilityStatusFreshnessMs = 5_000
const savePairTransportMediaType = 'application/vnd.dyson-control.save-pair'

export interface BuiltApplication {
  app: FastifyInstance
  close(): Promise<void>
}

export interface ApplicationDependencies {
  statusProvider?: StatusProvider
  lifecycleAdapter?: LifecycleMutationAdapter
  lifecycleCoordinator?: LifecycleMutationCoordinator
  hostMutationCoordinator?: HostMutationOperationCoordinator
  consoleReader?: StructuredLogReader
  playerSnapshotSource?: { read(signal?: AbortSignal): Promise<PlayerSnapshot> }
  playerPresenceHistory?: PlayerPresenceHistoryStore
  playerCapabilitySource?: { read(signal?: AbortSignal): Promise<PlayerCapabilitySnapshot> }
  gameConfigTransactionService?: GameConfigTransactionService
  gameConfigHistoryController?: GameConfigHistoryRoutesController
  saveTransactionService?: Pick<SaveTransactionService, 'inspect' | 'backup' | 'restore'>
  backupRetentionController?: BackupRetentionRoutesController
  savePairTransferService?: Pick<SavePairTransferService, 'exportBackup' | 'openExport' | 'importArchive'>
  thunderstoreReleaseClient?: {
    discoverLatest(input: unknown, signal?: AbortSignal): Promise<DiscoveredModRelease>
    discoverDependencyClosure?(
      input: unknown,
      signal?: AbortSignal
    ): Promise<DiscoveredModDependencyClosure>
  }
  nebulaReleaseClient?: { discover(signal?: AbortSignal): Promise<PagedDiscoveryResult<DiscoveredNebulaRelease>> }
  bepInExReleaseClient?: { discover(signal?: AbortSignal): Promise<PagedDiscoveryResult<DiscoveredBepInExRelease>> }
  updateStager?: {
    preview(input: unknown): ArtifactStagePlan
    stage(input: unknown, signal?: AbortSignal): Promise<StageArtifactResult>
  }
  artifactAcquisitionService?: Pick<
    ManagedArtifactAcquisitionService,
    'registerNebulaRelease' | 'registerBepInExRelease' | 'registerModRelease' | 'preview' | 'acquire' | 'getReceipt'
  >
  artifactAcquisitionController?: Pick<
    ArtifactAcquisitionHttpController,
    'preview' | 'execute' | 'getReceipt'
  >
  componentCandidatePreparationService?: Pick<
    ComponentCandidatePreparationService,
    'preview' | 'execute' | 'getReceipt'
  >
  componentCandidatePreparationController?: Pick<
    ComponentCandidatePreparationHttpController,
    'preview' | 'execute' | 'getReceipt'
  >
  thunderstoreModImportService?: Pick<
    ThunderstoreModImporter,
    'preview' | 'execute' | 'getReceipt' | 'getVerifiedReceipt'
  >
  thunderstoreModImportController?: Pick<
    ThunderstoreModImportHttpController,
    'preview' | 'execute' | 'getReceipt'
  >
  verifiedModLockService?: Pick<VerifiedModLockService, 'preview'>
  componentUpdateActivationController?: Pick<
    ComponentUpdateActivationHttpController,
    'initialize' | 'recoveryStatus' | 'preview' | 'execute' | 'getReceipt' | 'history' | 'previewCleanup'
  >
  componentUpdateActivationService?: Pick<
    ComponentUpdateActivationService,
    'preview' | 'execute' | 'reconcile' | 'getReceipt' | 'getState' | 'previewCleanup'
  >
  trustedCompatibilityService?: Pick<
    TrustedCompatibilityService,
    'status' | 'prepare' | 'getReceipt' | 'assertCurrent'
  >
  trustedCompatibilityController?: Pick<
    TrustedCompatibilityHttpController,
    'status' | 'prepare' | 'getReceipt'
  >
  modDeploymentService?: Pick<
    ModDeploymentService,
    'inspect' | 'preview' | 'execute' | 'previewCleanup' | 'getReceipt' | 'history'
  >
  observabilityHistory?: ObservabilityHistoryStore
  observabilityAlerts?: Pick<
    PersistentObservabilityAlerts,
    'ingest' | 'project' | 'acknowledge' | 'recoveryRequired'
  >
  workspacePaths?: {
    saveRoot: string
    backupRoot: string
    configRoot: string
    serverRoot?: string
  }
}

export async function buildApplication(
  config: AppConfig,
  dependencies: ApplicationDependencies = {}
): Promise<BuiltApplication> {
  const app = Fastify({ logger: config.nodeEnv !== 'test', trustProxy: 'loopback' })
  app.addContentTypeParser(savePairTransportMediaType, (_request, payload, done) => done(null, payload))
  const database = new ControlDatabase(config.dataDir, config.nodeEnv === 'test')
  const events = new EventHub()
  const provider = dependencies.statusProvider ?? (
    config.provider === 'windows'
      ? new WindowsProvider({
          projectRoot: config.projectRoot!, scriptRoot: config.scriptRoot,
          timeoutMs: config.statusTimeoutMs, gamePort: config.gamePort,
          serverTaskName: config.serverTaskName, stopTaskName: config.stopTaskName
        })
      : new DemoProvider()
  )
  const jobs = new JobService(database, provider, events)
  const observabilityHistory = dependencies.observabilityHistory ?? new PersistentObservabilityHistory(
    database,
    config.observabilityHistoryCapacity
  )
  const observabilityAlerts = dependencies.observabilityAlerts ?? new PersistentObservabilityAlerts({
    store: database,
    capacity: config.observabilityAlertCapacity,
    resolveAfterMissingSamples: config.observabilityAlertResolveAfterMissingSamples
  })
  let lastObservedStatusAt = observabilityHistory.latest()?.observedAt ?? null
  let lastStatusAcquiredAtUnixMs = 0
  let statusCollectionInFlight: Promise<ServerStatus> | null = null
  const recordObservability = (status: ServerStatus): ServerObservabilitySnapshot => {
    const latest = observabilityHistory.latest()
    if (lastObservedStatusAt === status.collectedAt && latest) return latest
    const snapshot = buildObservabilityFromServerStatus(status, {
      source: `${provider.name}.server-status`,
      gamePort: config.gamePort
    })
    observabilityAlerts.ingest(snapshot)
    const stored = observabilityHistory.ingest(snapshot)
    lastObservedStatusAt = status.collectedAt
    return stored
  }
  const unsubscribeObservability = events.subscribe((event) => {
    if (event.type !== 'status.updated') return
    lastStatusAcquiredAtUnixMs = Date.now()
    try { recordObservability(event.data) }
    catch { /* Status refresh remains usable when an optional telemetry sample is invalid. */ }
  })
  const collectObservabilityStatus = async (): Promise<ServerStatus> => {
    const latest = jobs.latestStatus()
    if (latest && Date.now() - lastStatusAcquiredAtUnixMs < observabilityStatusFreshnessMs) return latest
    if (statusCollectionInFlight) return statusCollectionInFlight

    const pending = jobs.collectInitialStatus()
    statusCollectionInFlight = pending
    try {
      const status = await pending
      lastStatusAcquiredAtUnixMs = Date.now()
      return status
    } finally {
      if (statusCollectionInFlight === pending) statusCollectionInFlight = null
    }
  }
  const observabilityTimer = config.observabilityIntervalMs > 0
    ? setInterval(() => {
        void collectObservabilityStatus()
          .then((status) => { recordObservability(status) })
          .catch(() => undefined)
      }, config.observabilityIntervalMs)
    : null
  observabilityTimer?.unref()
  const windowsScriptRunner = config.provider === 'windows'
    ? new PowerShellLifecycleRunner(config.scriptRoot, config.lifecycleTimeoutMs)
    : null
  const configuredLifecycleAdapter = config.lifecycleEnabled
    ? new WindowsLifecycleAdapter({
        projectRoot: config.projectRoot!,
        statusProvider: provider,
        scriptRunner: windowsScriptRunner!,
        bridgeClient: new FileBridgeClient({
          controlRoot: config.bridgeControlRoot!,
          secretFile: config.bridgeSecretFile!,
          timeoutMs: Math.min(config.lifecycleTimeoutMs, 180_000)
        }),
        bridgePluginVersion: config.bridgePluginVersion,
        serverTaskName: config.serverTaskName,
        stopTaskName: config.stopTaskName,
        gamePort: config.gamePort
      })
    : new DisabledLifecycleAdapter(provider)
  const activeLifecycleAdapter = dependencies.lifecycleAdapter ?? configuredLifecycleAdapter
  const hostMutationLeaseManager = config.provider === 'windows'
    ? new HostMutationLeaseManager({ scriptRoot: config.scriptRoot })
    : null
  const hostMutationCoordinator = dependencies.hostMutationCoordinator ?? (
    hostMutationLeaseManager
      ? new HostMutationCoordinator(hostMutationLeaseManager, { dataRoot: config.dataDir })
      : undefined
  )
  const lifecycleCoordinator = dependencies.lifecycleCoordinator ?? (
    config.lifecycleEnabled && hostMutationLeaseManager
      ? new HostMutationLifecycleCoordinator(
          hostMutationLeaseManager,
          { dataRoot: config.dataDir }
        )
      : undefined
  )
  const lifecycle = new LifecycleService(
    database,
    activeLifecycleAdapter,
    events,
    config.lifecycleTimeoutMs,
    lifecycleCoordinator
  )
  const auth = new AuthService(config, database)
  const protectedRoute = (permission: ControlPermission) => ({
    preHandler: [auth.authenticate, requirePermission(permission)]
  })
  const workspacePaths = dependencies.workspacePaths ?? (config.projectRoot ? {
    saveRoot: path.join(config.projectRoot, 'userdata', 'Save'),
    backupRoot: path.join(config.projectRoot, 'backups', 'saves'),
    configRoot: path.join(config.projectRoot, 'server', 'BepInEx', 'config'),
    serverRoot: path.join(config.projectRoot, 'server')
  } : null)
  const consoleReader = dependencies.consoleReader ?? (
    workspacePaths?.serverRoot && config.consoleCursorSecret
      ? new StructuredLogReader({
          serverRoot: workspacePaths.serverRoot,
          cursorSecret: config.consoleCursorSecret
        })
      : null
  )
  const playerSnapshotSource = dependencies.playerSnapshotSource ?? (
    config.bridgeControlRoot && config.bridgeSecretFile
      ? new FilePlayerSnapshotSource({
          controlRoot: config.bridgeControlRoot,
          secretFile: config.bridgeSecretFile,
          maximumAgeMs: config.playerSnapshotMaximumAgeMs
        })
      : null
  )
  const playerCapabilitySource = dependencies.playerCapabilitySource ?? (
    config.bridgeControlRoot && config.bridgeSecretFile
      ? new FilePlayerCapabilitySource({
          controlRoot: config.bridgeControlRoot,
          secretFile: config.bridgeSecretFile,
          maximumAgeMs: config.playerSnapshotMaximumAgeMs
        })
      : null
  )
  const playerHistory = dependencies.playerPresenceHistory ?? new PersistentPlayerPresenceHistory(database, {
    capacity: config.playerHistoryCapacity,
    retentionHours: config.playerHistoryRetentionHours
  })
  const stopPlayerHistoryRetention = playerHistory.startRetentionMaintenance?.((error) => {
    app.log.error({ code: error.code }, 'player presence retention maintenance failed')
  }) ?? (() => undefined)
  const gameConfigTransactions = dependencies.gameConfigTransactionService ?? (
    workspacePaths ? new GameConfigTransactionService({ configRoot: workspacePaths.configRoot }) : null
  )
  const gameConfigHistory = dependencies.gameConfigHistoryController ?? (
    workspacePaths && config.projectRoot && windowsScriptRunner
      ? (() => {
          const stopProof = new WindowsConfigHistoryStopProofAuthorizer({
            projectRoot: config.projectRoot!,
            gamePort: config.gamePort,
            runner: windowsScriptRunner
          })
          return new GameConfigHistoryHttpController({
            service: new GameConfigHistoryService({
              configRoot: workspacePaths.configRoot,
              validateStopProof: stopProof.validate
            }),
            mutationGate: () => config.configHistoryMutationsEnabled,
            stopProofTokenProvider: stopProof.issue
          })
        })()
      : null
  )
  const saveTransactions = dependencies.saveTransactionService ?? (
    workspacePaths && config.projectRoot && windowsScriptRunner
      ? new SaveTransactionService({
          saveRoot: workspacePaths.saveRoot,
          backupRoot: workspacePaths.backupRoot,
          verifyServiceStopped: async () => {
            const output = await windowsScriptRunner.run(
              'Test-DysonRuntimeState.ps1',
              [
                '-ProjectRoot', config.projectRoot!,
                '-Expected', 'stopped',
                '-GamePort', String(config.gamePort)
              ],
              new AbortController().signal
            )
            return JSON.parse(output) as unknown
          }
        })
      : null
  )
  const backupRetention = dependencies.backupRetentionController ?? (
    workspacePaths
      ? new BackupRetentionHttpController({
          service: new BackupRetentionControlService({
            backupRoot: workspacePaths.backupRoot,
            minimumPurgeAgeMs: config.saveRetentionPurgeMinimumHours * 60 * 60 * 1_000
          }),
          mutationGate: () => config.saveRetentionMutationsEnabled
        })
      : null
  )
  const saveJobs = saveTransactions
    ? new SaveJobService(database, saveTransactions, events)
    : null
  if (saveJobs && config.saveMutationsEnabled) saveJobs.initialize()
  const saveTransfers = dependencies.savePairTransferService ?? (
    workspacePaths && config.saveTransferRoot
      ? new SavePairTransferService({
          backupRoot: workspacePaths.backupRoot,
          transportRoot: config.saveTransferRoot
        })
      : null
  )
  const thunderstoreReleases = dependencies.thunderstoreReleaseClient ?? new ThunderstoreReleaseClient({ fetch })
  const nebulaReleases = dependencies.nebulaReleaseClient ?? new NebulaGithubReleaseClient({ fetch })
  const bepInExReleases = dependencies.bepInExReleaseClient ?? new BepInExGithubReleaseClient({ fetch })
  const updateStager = dependencies.updateStager ?? (
    config.updateStagingEnabled
      ? new OfflineArtifactStager({
          inboxRoot: config.updateInboxRoot!, stagingRoot: config.updateStagingRoot!
        })
      : null
  )
  const artifactAcquisitionService = dependencies.artifactAcquisitionService ?? (
    config.updateStagingEnabled && config.updateInboxRoot && config.updateStagingRoot
      ? new ManagedArtifactAcquisitionService({
          inboxRoot: config.updateInboxRoot,
          stateRoot: path.join(config.updateStagingRoot, 'acquisitions'),
          fetch
        })
      : null
  )
  const artifactAcquisition = dependencies.artifactAcquisitionController ?? (
    artifactAcquisitionService
      ? new ArtifactAcquisitionHttpController({
          service: artifactAcquisitionService,
          mutationGate: () => config.updateAcquisitionEnabled
        })
      : null
  )
  const componentCandidatePreparationService = dependencies.componentCandidatePreparationService ?? (
    config.updateStagingEnabled && config.updateInboxRoot && config.updateStagingRoot && artifactAcquisitionService
      ? new ComponentCandidatePreparationService({
          acquisition: artifactAcquisitionService,
          acquisitionInboxRoot: config.updateInboxRoot,
          stateRoot: path.join(config.dataDir, 'update-preparations'),
          stagingRoot: config.updateStagingRoot
        })
      : null
  )
  const componentCandidatePreparation = dependencies.componentCandidatePreparationController ?? (
    componentCandidatePreparationService
      ? new ComponentCandidatePreparationHttpController({
          service: componentCandidatePreparationService,
          mutationGate: () => config.updatePreparationEnabled
        })
      : null
  )
  const managedPluginVersionProbe = config.provider === 'windows' && config.projectRoot && windowsScriptRunner
    ? createWindowsManagedPluginVersionProbe({
        projectRoot: config.projectRoot,
        scriptRunner: windowsScriptRunner
      })
    : null
  const trustedCompatibilityService = dependencies.trustedCompatibilityService ?? (
    config.provider === 'windows' && config.projectRoot && config.updateStagingRoot && managedPluginVersionProbe
      ? new TrustedCompatibilityService({
          stateRoot: path.join(config.updateStagingRoot, 'compatibility'),
          policy: config.updateCompatibilityPolicyFile
            ? await readTrustedCompatibilityPolicy(config.updateCompatibilityPolicyFile)
            : null,
          readRuntimeInventory: async () => {
            const status = await provider.collectStatus()
            if (status.versions.dsp === null || status.versions.nebula === null || status.versions.bepInEx === null) {
              throw new Error('runtime version inventory is incomplete')
            }
            const signal = new AbortController().signal
            const [bridge, control] = await Promise.all([
              managedPluginVersionProbe({ component: 'bridge', signal }),
              managedPluginVersionProbe({ component: 'control', signal })
            ])
            return {
              dsp: status.versions.dsp,
              nebula: status.versions.nebula,
              bepInEx: status.versions.bepInEx,
              plugins: [
                ...(bridge === null ? [] : [{ sourceId: 'thunderstore:DysonControl/Bridge', version: bridge }]),
                ...(control === null ? [] : [{ sourceId: 'thunderstore:DysonControl/Control', version: control }])
              ]
            }
          }
        })
      : null
  )
  const trustedCompatibility = dependencies.trustedCompatibilityController ?? (
    trustedCompatibilityService ? new TrustedCompatibilityHttpController(trustedCompatibilityService) : null
  )
  const componentUpdateActivationService = dependencies.componentUpdateActivationService ?? (
    config.provider === 'windows' && provider.name === 'windows' && config.lifecycleEnabled &&
      config.updateStagingEnabled && config.projectRoot && config.updateStagingRoot && windowsScriptRunner &&
        trustedCompatibilityService
      ? (() => {
          const runtimeAdapters = new WindowsUpdateActivationAdapters({
            lifecycleAdapter: activeLifecycleAdapter,
            statusProvider: provider,
            componentVersionProbe: managedPluginVersionProbe!
          })
          const serverRoot = path.join(config.projectRoot!, 'server')
          const bepInExRoot = path.join(serverRoot, 'BepInEx')
          return new ComponentUpdateActivationService({
            projectRoot: config.projectRoot!,
            stagingRoot: config.updateStagingRoot!,
            liveComponentRoots: {
              nebula: bepInExRoot,
              bepinex: serverRoot,
              bridge: bepInExRoot,
              control: bepInExRoot
            },
            compatibilityVerifier: trustedCompatibilityService,
            hostMutationCoordinator,
            verifyStoppedState: (request, hostMutation) =>
              runtimeAdapters.verifyStoppedState(request, hostMutation),
            createSaveProtectionPoint: (request, hostMutation) =>
              runtimeAdapters.createSaveProtectionPoint(request, hostMutation),
            smoke: (request, hostMutation) => runtimeAdapters.smoke(request, hostMutation)
          })
        })()
      : null
  )
  const componentUpdateActivation = dependencies.componentUpdateActivationController ?? (
    componentUpdateActivationService
      ? new ComponentUpdateActivationHttpController({
          service: componentUpdateActivationService,
          mutationGate: () => config.updateActivationEnabled
        })
      : null
  )
  if (componentUpdateActivation) {
    app.addHook('onReady', async () => {
      await componentUpdateActivation.initialize()
    })
  }
  const thunderstoreModImportService = dependencies.thunderstoreModImportService ?? (
    config.updateStagingEnabled && config.updateInboxRoot && config.modStagingRoot && artifactAcquisitionService
      ? new ThunderstoreModImporter({
          acquisition: artifactAcquisitionService,
          acquisitionInboxRoot: config.updateInboxRoot,
          stagingRoot: config.modStagingRoot,
          stateRoot: path.join(config.dataDir, 'mod-imports')
        })
      : null
  )
  const thunderstoreModImport = dependencies.thunderstoreModImportController ?? (
    thunderstoreModImportService
      ? new ThunderstoreModImportHttpController({
          service: thunderstoreModImportService,
          mutationGate: () => config.modImportEnabled
        })
      : null
  )
  const verifiedModLocks = dependencies.verifiedModLockService ?? (
    thunderstoreModImportService
      ? new VerifiedModLockService({
          receipts: thunderstoreModImportService,
          ...(trustedCompatibilityService
            ? {
                readPlatformInventory: async () => {
                  const current = await trustedCompatibilityService.status()
                  return {
                    inventoryRevision: current.inventoryRevision,
                    inventory: {
                      nebula: current.inventory.nebula,
                      bepInEx: current.inventory.bepInEx
                    }
                  }
                }
              }
            : {})
        })
      : null
  )
  const modDeployments = dependencies.modDeploymentService ?? (
    config.modStagingRoot && config.modPluginsRoot
      ? new ModDeploymentService({
          stagingRoot: config.modStagingRoot,
          pluginsRoot: config.modPluginsRoot,
          maxSnapshots: config.modSnapshotLimit,
          hostMutationCoordinator,
          ...(trustedCompatibilityService
            ? {
                readPlatformInventory: async () => {
                  const current = await trustedCompatibilityService.status()
                  return {
                    inventoryRevision: current.inventoryRevision,
                    inventory: {
                      nebula: current.inventory.nebula,
                      bepInEx: current.inventory.bepInEx
                    }
                  }
                }
              }
            : {}),
          verifyStoppedState: async (signal) => {
            if (!windowsScriptRunner || !config.projectRoot) {
              return { processStopped: false, portClosed: false }
            }
            const output = await windowsScriptRunner.run(
              'Test-DysonRuntimeState.ps1',
              [
                '-ProjectRoot', config.projectRoot,
                '-Expected', 'stopped',
                '-GamePort', String(config.gamePort)
              ],
              signal ?? new AbortController().signal
            )
            const proof = runtimeStoppedResultSchema.parse(JSON.parse(output) as unknown)
            return { processStopped: proof.processVerified, portClosed: !proof.gamePortListening }
          }
        })
      : null
  )

  await app.register(cookie)
  await app.register(helmet, {
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'"],
        imgSrc: ["'self'", 'data:'],
        connectSrc: ["'self'"],
        objectSrc: ["'none'"],
        frameAncestors: ["'none'"]
      }
    }
  })
  await app.register(rateLimit, { global: false })
  await auth.initialize()
  lifecycle.initialize()

  app.decorateRequest('actor', null)
  app.decorateRequest('actorRole', null)

  app.addHook('onRequest', async (request, reply) => {
    if (!auth.assertSameOrigin(request)) {
      await reply.code(403).send({ error: { code: 'ORIGIN_REJECTED', message: 'Request origin rejected' } })
    }
  })

  if (gameConfigHistory) {
    registerGameConfigHistoryRoutes(app, {
      controller: gameConfigHistory,
      authenticate: auth.authenticate
    })
  }
  if (backupRetention) {
    registerBackupRetentionRoutes(app, {
      controller: backupRetention,
      authenticate: auth.authenticate
    })
  }

  app.get('/healthz', async (_request, reply) => {
    if (config.deploymentVersion) {
      reply.header('X-Dyson-Control-Release', config.deploymentVersion)
    }
    return {
      status: 'ok',
      provider: provider.name,
      version: apiPackage.version,
      deploymentVersion: config.deploymentVersion
    }
  })

  app.get('/readyz', {
    config: { rateLimit: { max: 30, timeWindow: '1 minute' } }
  }, async (_request, reply) => {
    if (config.deploymentVersion) {
      reply.header('X-Dyson-Control-Release', config.deploymentVersion)
    }
    reply.header('Cache-Control', 'no-store')

    const checks: Record<string, 'pass' | 'fail' | 'not-applicable'> = {
      deploymentVersion: config.nodeEnv === 'production'
        ? (config.deploymentVersion ? 'pass' : 'fail')
        : 'not-applicable',
      statusProvider: 'fail',
      projectRoot: provider.name === 'windows' ? 'fail' : 'not-applicable',
      activationRecovery: componentUpdateActivation ? 'fail' : 'not-applicable'
    }

    try {
      const status = await collectObservabilityStatus()
      checks.statusProvider = 'pass'
      if (provider.name === 'windows') {
        checks.projectRoot = status.automation.projectRootAvailable ? 'pass' : 'fail'
      }
    } catch {
      // Readiness is deliberately code-only and never reflects provider errors.
    }

    if (componentUpdateActivation) {
      try {
        const recovery = await componentUpdateActivation.recoveryStatus({})
        checks.activationRecovery = recovery.statusCode === 200 && recovery.body.ok
          && recovery.body.data.phase === 'ready'
          ? 'pass'
          : 'fail'
      } catch {
        checks.activationRecovery = 'fail'
      }
    }

    const ready = Object.values(checks).every((state) => state !== 'fail')
    return reply.code(ready ? 200 : 503).send({
      status: ready ? 'ready' : 'not-ready',
      provider: provider.name,
      version: apiPackage.version,
      deploymentVersion: config.deploymentVersion,
      checks
    })
  })

  app.post('/api/v1/auth/login', {
    config: { rateLimit: { max: 5, timeWindow: '1 minute' } }
  }, async (request, reply) => {
    const parsed = loginSchema.safeParse(request.body)
    if (!parsed.success || !(await auth.login(parsed.data.password, reply, parsed.data.role))) {
      await new Promise((resolve) => setTimeout(resolve, 250))
      return reply.code(401).send({ error: { code: 'INVALID_CREDENTIALS', message: '用户名或密码错误' } })
    }
    return { user: authenticatedUserFor(parsed.data.role) }
  })

  app.get('/api/v1/auth/session', async (request, reply) => {
    const session = auth.session(request)
    if (!session) return reply.code(401).send({ error: { code: 'AUTH_REQUIRED', message: 'Authentication required' } })
    return { user: authenticatedUserFor(session.role), expiresAt: session.expiresAt }
  })

  app.post('/api/v1/auth/logout', { preHandler: auth.authenticate }, async (request, reply) => {
    auth.logout(request, reply)
    return reply.code(204).send()
  })

  app.get('/api/v1/status', protectedRoute('status.read'), async (request, reply) => {
    let status = jobs.latestStatus()
    if (!status) {
      try {
        status = await jobs.collectInitialStatus()
        lastStatusAcquiredAtUnixMs = Date.now()
      }
      catch { return reply.code(503).send({ error: { code: 'STATUS_UNAVAILABLE', message: '服务器状态暂不可用' } }) }
    }
    try { recordObservability(status) }
    catch { /* Preserve the existing status contract if observability normalization fails. */ }
    const lifecycleUiEnabled = config.lifecycleEnabled && provider.name === 'windows'
      && request.actorRole !== null && can(request.actorRole, 'lifecycle.execute')
    const refreshUiEnabled = request.actorRole !== null && can(request.actorRole, 'status.refresh')
    const running = status.state === 'running'
    return {
      data: {
        ...status,
        capabilities: {
          refresh: refreshUiEnabled,
          start: lifecycleUiEnabled && status.state === 'stopped',
          save: lifecycleUiEnabled && running,
          gracefulStop: lifecycleUiEnabled && running,
          restart: lifecycleUiEnabled && running
        }
      },
      meta: { provider: provider.name, environment: config.nodeEnv }
    }
  })

  app.get('/api/v1/observability/snapshot', protectedRoute('observability.read'), async (_request, reply) => {
    try {
      const status = await collectObservabilityStatus()
      return {
        data: recordObservability(status),
        meta: {
          provider: provider.name,
          environment: config.nodeEnv,
          retainedSamples: observabilityHistory.size,
          capacity: observabilityHistory.capacity
        }
      }
    } catch {
      return observabilityUnavailable(reply)
    }
  })

  app.get('/api/v1/observability/history', protectedRoute('observability.read'), async (request, reply) => {
    const parsed = observabilityHistoryQuerySchema.safeParse(request.query)
    if (!parsed.success) {
      return reply.code(400).send({
        error: { code: 'INVALID_OBSERVABILITY_QUERY', message: '服务器观测历史查询无效' }
      })
    }
    try {
      const status = await collectObservabilityStatus()
      recordObservability(status)
      return {
        data: observabilityHistory.downsample(parsed.data.points ?? 48),
        meta: {
          provider: provider.name,
          environment: config.nodeEnv,
          capacity: observabilityHistory.capacity
        }
      }
    } catch {
      return observabilityUnavailable(reply)
    }
  })

  app.get('/api/v1/observability/qualification', protectedRoute('observability.read'), async (_request, reply) => {
    try {
      const status = await collectObservabilityStatus()
      recordObservability(status)
      return {
        data: evaluateLateGameQualification(observabilityHistory.list()),
        meta: {
          provider: provider.name,
          environment: config.nodeEnv,
          capacity: observabilityHistory.capacity
        }
      }
    } catch {
      return observabilityUnavailable(reply)
    }
  })

  app.get('/api/v1/observability/alerts', protectedRoute('observability.read'), async (_request, reply) => {
    try {
      const status = await collectObservabilityStatus()
      recordObservability(status)
      return {
        data: observabilityAlerts.project(),
        meta: { recoveryRequired: observabilityAlerts.recoveryRequired }
      }
    } catch {
      return observabilityAlertUnavailable(reply)
    }
  })

  app.post('/api/v1/observability/alerts/:episodeId/acknowledge', {
    ...protectedRoute('observability.acknowledge'),
    bodyLimit: 1_024
  }, async (request, reply) => {
    const params = observabilityAlertParamsSchema.safeParse(request.params)
    const body = observabilityAlertAcknowledgeSchema.safeParse(request.body)
    if (!params.success || !body.success) {
      return reply.code(400).send({
        error: { code: 'OBSERVABILITY_ALERT_REQUEST_INVALID', message: '告警确认请求无效' }
      })
    }
    try {
      const actor = request.actor ?? 'Operator'
      const existingAcknowledgement = observabilityAlerts.project().episodes
        .find((episode) => episode.id === params.data.episodeId)?.acknowledgement
      return {
        data: observabilityAlerts.acknowledge({
          episodeId: params.data.episodeId,
          actor,
          acknowledgedAt: existingAcknowledgement?.actor === actor
            ? existingAcknowledgement.acknowledgedAt
            : new Date().toISOString()
        })
      }
    } catch (error) {
      return observabilityAlertError(reply, error)
    }
  })

  app.get('/api/v1/jobs', protectedRoute('jobs.read'), async () => ({ data: jobs.listJobs() }))
  app.get('/api/v1/jobs/:id', protectedRoute('jobs.read'), async (request, reply) => {
    const id = (request.params as { id: string }).id
    const job = jobs.getJob(id)
    return job ? { data: job } : reply.code(404).send({ error: { code: 'JOB_NOT_FOUND', message: '任务不存在' } })
  })

  app.post('/api/v1/actions/refresh', protectedRoute('status.refresh'), async (request, reply) => {
    const job = jobs.enqueueRefresh(request.actor ?? 'unknown')
    return reply.code(202).send({ data: job })
  })

  app.get('/api/v1/saves', protectedRoute('saves.read'), async (request, reply) => {
    if (!workspacePaths) return workspaceUnavailable(reply)
    const parsed = catalogQuerySchema(MAX_CATALOG_PAGE_SIZE).safeParse(request.query)
    if (!parsed.success) return invalidInventoryRequest(reply)
    try {
      const data = await catalogSavePairs({
        saveRoot: workspacePaths.saveRoot,
        query: { cursor: parsed.data.cursor ?? null, pageSize: parsed.data.pageSize ?? 25 }
      })
      return { data }
    } catch (error) {
      return inventoryError(reply, error)
    }
  })

  app.get('/api/v1/backups', protectedRoute('saves.read'), async (request, reply) => {
    if (!workspacePaths) return workspaceUnavailable(reply)
    const parsed = catalogQuerySchema(MAX_BACKUP_PAGE_SIZE).safeParse(request.query)
    if (!parsed.success) return invalidInventoryRequest(reply)
    try {
      const data = await catalogBackups({
        backupRoot: workspacePaths.backupRoot,
        query: { cursor: parsed.data.cursor ?? null, pageSize: parsed.data.pageSize ?? 10 }
      })
      return { data }
    } catch (error) {
      return inventoryError(reply, error)
    }
  })

  app.get('/api/v1/backups/:backupId/verify', protectedRoute('saves.read'), async (request, reply) => {
    if (!workspacePaths) return workspaceUnavailable(reply)
    const parsedId = backupIdSchema.safeParse((request.params as { backupId: string }).backupId)
    if (!parsedId.success) return invalidInventoryRequest(reply)
    try {
      return { data: await verifyBackupPair({ backupRoot: workspacePaths.backupRoot, backupId: parsedId.data }) }
    } catch (error) {
      if (error instanceof SaveCatalogError && error.code === 'DIRECTORY_UNAVAILABLE') {
        return reply.code(404).send({ error: { code: 'BACKUP_NOT_FOUND', message: '备份不存在' } })
      }
      return inventoryError(reply, error)
    }
  })

  app.get('/api/v1/saves/:saveName/revision', protectedRoute('saves.read'), async (request, reply) => {
    if (!saveTransactions) return saveTransactionsUnavailable(reply)
    const parsed = saveNameSchema.safeParse((request.params as { saveName: string }).saveName)
    if (!parsed.success) return invalidSaveTransactionRequest(reply)
    try {
      return { data: await saveTransactions.inspect(parsed.data) }
    } catch {
      return saveTransactionStorageError(reply)
    }
  })

  app.post('/api/v1/saves/backup/preview', protectedRoute('saves.backup'), async (request, reply) => {
    if (!saveTransactions) return saveTransactionsUnavailable(reply)
    const parsed = backupSaveRequestSchema.safeParse(request.body)
    if (!parsed.success) return invalidSaveTransactionRequest(reply)
    try {
      const result = await saveTransactions.backup({ ...parsed.data, dryRun: true })
      return saveTransactionReply(reply, result, config.saveMutationsEnabled)
    } catch {
      return saveTransactionStorageError(reply)
    }
  })

  app.post('/api/v1/saves/backup/execute', protectedRoute('saves.backup'), async (request, reply) => {
    if (!saveTransactions || !saveJobs) return saveTransactionsUnavailable(reply)
    if (!config.saveMutationsEnabled) return saveMutationsDisabled(reply)
    const parsed = executeBackupSaveRequestSchema.safeParse(request.body)
    if (!parsed.success) return invalidSaveTransactionRequest(reply)
    try {
      const result = saveJobs.enqueue({
        operation: 'backup',
        idempotencyKey: parsed.data.requestId,
        saveName: parsed.data.saveName
      }, request.actor ?? 'authenticated-user')
      return saveJobReply(reply, result)
    } catch (error) {
      return saveJobError(reply, error)
    }
  })

  app.get('/api/v1/saves/jobs/:jobId', protectedRoute('saves.read'), async (request, reply) => {
    if (!saveJobs) return saveTransactionsUnavailable(reply)
    const parsed = z.string().uuid().safeParse((request.params as { jobId: string }).jobId)
    if (!parsed.success) return invalidSaveTransactionRequest(reply)
    const result = saveJobs.get(parsed.data)
    return result
      ? { data: result }
      : reply.code(404).send({ error: { code: 'SAVE_JOB_NOT_FOUND', message: '存档事务任务不存在' } })
  })

  app.post('/api/v1/saves/jobs/:jobId/reconcile', protectedRoute('saves.restore'), async (request, reply) => {
    if (!saveJobs) return saveTransactionsUnavailable(reply)
    if (!config.saveMutationsEnabled) return saveMutationsDisabled(reply)
    const jobId = z.string().uuid().safeParse((request.params as { jobId: string }).jobId)
    const body = reconcileSaveJobRequestSchema.safeParse(request.body)
    if (!jobId.success || !body.success) return invalidSaveTransactionRequest(reply)
    try {
      return saveJobReply(reply, saveJobs.reconcile(jobId.data, request.actor ?? 'authenticated-user'))
    } catch (error) {
      return saveJobError(reply, error)
    }
  })

  app.post('/api/v1/saves/transfers/exports', protectedRoute('saves.transfer'), async (request, reply) => {
    if (!config.saveTransferEnabled) return saveTransferMutationsDisabled(reply)
    if (!saveTransfers) return saveTransferUnavailable(reply)
    try {
      const receipt = await saveTransfers.exportBackup(request.body)
      return reply.code(receipt.reused ? 200 : 201).send({ data: receipt })
    } catch (error) {
      return saveTransferError(reply, error)
    }
  })

  app.get('/api/v1/saves/transfers/exports/:requestId', protectedRoute('saves.transfer'), async (request, reply) => {
    if (!config.saveTransferEnabled) return saveTransferMutationsDisabled(reply)
    if (!saveTransfers) return saveTransferUnavailable(reply)
    try {
      const download = await saveTransfers.openExport(request.params)
      reply.header('Content-Type', savePairTransportMediaType)
      reply.header('Content-Disposition', `attachment; filename="dyson-save-${download.receipt.requestId}.dspair"`)
      reply.header('Content-Length', String(download.receipt.archiveBytes))
      reply.header('X-Dyson-Content-SHA256', download.receipt.archiveSha256)
      reply.header('Cache-Control', 'no-store')
      return reply.send(Readable.from(download.source))
    } catch (error) {
      return saveTransferError(reply, error)
    }
  })

  app.post('/api/v1/saves/transfers/imports/:requestId', protectedRoute('saves.transfer'), async (request, reply) => {
    if (!config.saveTransferEnabled) return saveTransferMutationsDisabled(reply)
    if (!saveTransfers) return saveTransferUnavailable(reply)
    const headers = request.headers
    const requestId = (request.params as { requestId?: unknown }).requestId
    const declaredBytes = typeof headers['content-length'] === 'string'
      ? Number(headers['content-length'])
      : headers['content-length']
    const sha256 = headers['x-dyson-content-sha256']
    const source = request.body
    if (typeof requestId !== 'string' || typeof sha256 !== 'string' || !Number.isSafeInteger(declaredBytes) ||
        source === null || typeof source !== 'object' || !(Symbol.asyncIterator in source)) {
      return saveTransferError(reply, new SaveTransferError('SAVE_TRANSFER_REQUEST_INVALID'))
    }
    try {
      const receipt = await saveTransfers.importArchive(
        { requestId, declaredBytes, sha256 },
        source as AsyncIterable<Uint8Array>
      )
      return reply.code(receipt.reused ? 200 : 201).send({ data: receipt })
    } catch (error) {
      return saveTransferError(reply, error)
    }
  })

  app.post('/api/v1/saves/restore/preview', protectedRoute('saves.restore'), async (request, reply) => {
    if (!saveTransactions) return saveTransactionsUnavailable(reply)
    const parsed = restoreSaveRequestSchema.safeParse(request.body)
    if (!parsed.success) return invalidSaveTransactionRequest(reply)
    try {
      const result = await saveTransactions.restore({ ...parsed.data, dryRun: true })
      return saveTransactionReply(reply, result, config.saveMutationsEnabled)
    } catch {
      return saveTransactionStorageError(reply)
    }
  })

  app.post('/api/v1/saves/restore/execute', protectedRoute('saves.restore'), async (request, reply) => {
    if (!saveTransactions || !saveJobs) return saveTransactionsUnavailable(reply)
    if (!config.saveMutationsEnabled) return saveMutationsDisabled(reply)
    const parsed = executeRestoreSaveRequestSchema.safeParse(request.body)
    if (!parsed.success) return invalidSaveTransactionRequest(reply)
    try {
      const result = saveJobs.enqueue({
        operation: 'restore',
        idempotencyKey: parsed.data.requestId,
        backupId: parsed.data.backupId,
        expectedRevision: parsed.data.expectedRevision,
        protectionRequestId: parsed.data.protectionRequestId
      }, request.actor ?? 'authenticated-user')
      return saveJobReply(reply, result)
    } catch (error) {
      return saveJobError(reply, error)
    }
  })

  app.get('/api/v1/configuration', protectedRoute('configuration.read'), async (_request, reply) => {
    if (!workspacePaths) return workspaceUnavailable(reply)
    try {
      const files = await readGameConfigurationFiles(workspacePaths.configRoot)
      return { data: inspectGameConfiguration(files) }
    } catch {
      return reply.code(503).send({
        error: { code: 'CONFIGURATION_UNAVAILABLE', message: '游戏配置暂不可用' }
      })
    }
  })

  app.post('/api/v1/configuration/preview', protectedRoute('configuration.preview'), async (request, reply) => {
    if (!workspacePaths) return workspaceUnavailable(reply)
    const parsed = configurationPreviewSchema.safeParse(request.body)
    if (!parsed.success) {
      return reply.code(400).send({ error: { code: 'INVALID_CONFIGURATION_CHANGE', message: '配置变更请求无效' } })
    }
    try {
      const files = await readGameConfigurationFiles(workspacePaths.configRoot)
      const plan = planGameConfiguration(files, parsed.data.expectedRevision, parsed.data.changes)
      const { files: _privateFiles, ...publicPlan } = plan
      return { data: { mode: 'dry-run', ...publicPlan } }
    } catch (error) {
      if (error instanceof GameConfigPlanError && error.code === 'CONFIG_REVISION_CONFLICT') {
        return reply.code(409).send({
          error: { code: error.code, message: '配置已发生变化，请刷新后重新预览' }
        })
      }
      if (error instanceof GameConfigPlanError || error instanceof GameConfigValidationError) {
        return reply.code(400).send({
          error: { code: error.code, message: '配置变更不符合固定字段约束' }
        })
      }
      return reply.code(503).send({
        error: { code: 'CONFIGURATION_UNAVAILABLE', message: '配置预览暂不可用' }
      })
    }
  })

  app.post('/api/v1/configuration/apply', protectedRoute('configuration.apply'), async (request, reply) => {
    if (!workspacePaths || !gameConfigTransactions) return workspaceUnavailable(reply)
    const parsed = configurationApplySchema.safeParse(request.body)
    if (!parsed.success) {
      return reply.code(400).send({ error: { code: 'INVALID_CONFIGURATION_APPLY', message: '配置提交请求无效' } })
    }
    try {
      const files = await readGameConfigurationFiles(workspacePaths.configRoot)
      const plan = planGameConfiguration(files, parsed.data.expectedRevision, parsed.data.changes)
      return configTransactionReply(reply, await gameConfigTransactions.apply(plan))
    } catch (error) {
      if (error instanceof GameConfigPlanError && error.code === 'CONFIG_REVISION_CONFLICT') {
        return reply.code(409).send({
          error: { code: error.code, message: '配置已发生变化，请刷新后重新预览' }
        })
      }
      if (error instanceof GameConfigPlanError || error instanceof GameConfigValidationError) {
        return reply.code(400).send({
          error: { code: error.code, message: '配置提交不符合固定字段约束' }
        })
      }
      return reply.code(503).send({
        error: { code: 'CONFIGURATION_APPLY_UNAVAILABLE', message: '配置提交暂不可用' }
      })
    }
  })

  app.post('/api/v1/console/logs/query', protectedRoute('console.read'), async (request, reply) => {
    if (!consoleReader) return consoleUnavailable(reply, 'CONSOLE_NOT_CONFIGURED')
    try {
      return { data: await consoleReader.read(request.body) }
    } catch (error) {
      return consoleError(reply, error)
    }
  })

  app.post('/api/v1/console/logs/download/preview', protectedRoute('console.export'), async (request, reply) => {
    if (!consoleReader) return consoleUnavailable(reply, 'CONSOLE_NOT_CONFIGURED')
    try {
      return { data: { mode: 'dry-run', ...createStructuredLogDownloadPlan(request.body) } }
    } catch (error) {
      return consoleError(reply, error)
    }
  })

  app.post('/api/v1/console/logs/download', protectedRoute('console.export'), async (request, reply) => {
    if (!consoleReader) return consoleUnavailable(reply, 'CONSOLE_NOT_CONFIGURED')
    try {
      const plan = createStructuredLogDownloadPlan(request.body)
      const download = await executeStructuredLogDownload(consoleReader, plan)
      reply.header('Content-Disposition', `attachment; filename="${plan.fileName}"`)
      reply.header('X-Dyson-Console-Entries', String(download.entries))
      reply.header('X-Dyson-Console-Truncated', String(download.truncated))
      return reply.type(plan.contentType).send(download.body)
    } catch (error) {
      return consoleError(reply, error)
    }
  })

  app.post('/api/v1/console/commands/preview', protectedRoute('console.command'), async (request, reply) => {
    try {
      return { data: await previewConsoleCommand(request.body, lifecycle) }
    } catch (error) {
      return consoleCommandError(reply, error)
    }
  })

  app.post('/api/v1/console/commands/execute', protectedRoute('console.command'), async (request, reply) => {
    try {
      const result = executeConsoleCommand(request.body, lifecycle, request.actor ?? 'authenticated-user')
      return reply.code(result.reused || result.run.state === 'succeeded' ? 200 : 202).send({ data: result })
    } catch (error) {
      return consoleCommandError(reply, error)
    }
  })

  app.get('/api/v1/updates/compatibility/status', protectedRoute('updates.read'), async (request, reply) => {
    if (!trustedCompatibility) return trustedCompatibilityUnavailable(reply)
    const result = await trustedCompatibility.status(request.query ?? {})
    return reply.code(result.statusCode).send(result.body)
  })

  app.post('/api/v1/updates/compatibility/prepare', protectedRoute('updates.stage'), async (request, reply) => {
    if (!trustedCompatibility) return trustedCompatibilityUnavailable(reply)
    const result = await trustedCompatibility.prepare(request.body)
    return reply.code(result.statusCode).send(result.body)
  })

  app.get('/api/v1/updates/compatibility/receipts/:receiptId', protectedRoute('updates.read'), async (request, reply) => {
    if (!trustedCompatibility) return trustedCompatibilityUnavailable(reply)
    const params = request.params as Record<string, unknown>
    const query = request.query as Record<string, unknown>
    const result = await trustedCompatibility.getReceipt({ ...params, ...query })
    return reply.code(result.statusCode).send(result.body)
  })

  app.post('/api/v1/updates/compatibility/preview', protectedRoute('updates.read'), async (_request, reply) => {
    return reply.code(410).send({
      error: { code: 'UPDATE_COMPATIBILITY_BROWSER_POLICY_REMOVED', message: '兼容性策略现由服务端固定配置' }
    })
  })

  app.post('/api/v1/updates/discovery/nebula', protectedRoute('updates.read'), async (request, reply) => {
    if (!emptyObjectSchema.safeParse(request.body ?? {}).success) return invalidPlanningRequest(reply)
    try {
      const discovered = await nebulaReleases.discover()
      const candidates = await Promise.all(discovered.items.map((release) =>
        registerNebulaAcquisitionCandidate(artifactAcquisitionService, release)))
      return {
        data: discovered,
        meta: acquisitionDiscoveryMeta(
          artifactAcquisitionService !== null,
          artifactAcquisition !== null && config.updateAcquisitionEnabled,
          candidates
        )
      }
    } catch {
      return reply.code(502).send({
        error: { code: 'UPDATE_DISCOVERY_FAILED', message: 'Nebula 官方版本发现暂不可用' }
      })
    }
  })

  app.post('/api/v1/updates/discovery/bepinex', protectedRoute('updates.read'), async (request, reply) => {
    if (!emptyObjectSchema.safeParse(request.body ?? {}).success) return invalidPlanningRequest(reply)
    try {
      const discovered = await bepInExReleases.discover()
      const candidates = await Promise.all(discovered.items.map((release) =>
        registerBepInExAcquisitionCandidate(artifactAcquisitionService, release)))
      return {
        data: discovered,
        meta: acquisitionDiscoveryMeta(
          artifactAcquisitionService !== null,
          artifactAcquisition !== null && config.updateAcquisitionEnabled,
          candidates
        )
      }
    } catch {
      return reply.code(502).send({
        error: { code: 'UPDATE_DISCOVERY_FAILED', message: 'BepInEx 官方 Windows x64 版本发现暂不可用' }
      })
    }
  })

  app.post('/api/v1/updates/discovery/thunderstore', protectedRoute('updates.read'), async (request, reply) => {
    const parsed = thunderstoreDiscoveryRequestSchema.safeParse(request.body)
    if (!parsed.success) return invalidPlanningRequest(reply)
    try {
      const discovered = await thunderstoreReleases.discoverLatest(parsed.data)
      const candidate = await registerModAcquisitionCandidate(artifactAcquisitionService, discovered)
      return {
        data: discovered,
        meta: {
          ...acquisitionDiscoveryMeta(
            artifactAcquisitionService !== null,
            artifactAcquisition !== null && config.updateAcquisitionEnabled,
            [candidate]
          ),
          routing: routeThunderstoreDependency(discovered)
        }
      }
    } catch {
      return reply.code(502).send({
        error: { code: 'UPDATE_DISCOVERY_FAILED', message: 'Thunderstore 模组版本发现暂不可用' }
      })
    }
  })

  app.post(
    '/api/v1/updates/discovery/thunderstore/dependencies',
    protectedRoute('updates.read'),
    async (request, reply) => {
      if (typeof thunderstoreReleases.discoverDependencyClosure !== 'function') {
        return thunderstoreDependencyDiscoveryUnavailable(reply)
      }
      const controller = new AbortController()
      const abortRequest = () => controller.abort('http-request-aborted')
      const abortDisconnectedResponse = () => {
        if (!reply.raw.writableEnded) controller.abort('http-client-disconnected')
      }
      if (request.raw.aborted) abortRequest()
      request.raw.once('aborted', abortRequest)
      reply.raw.once('close', abortDisconnectedResponse)
      try {
        const discovered = await thunderstoreReleases.discoverDependencyClosure(
          request.body,
          controller.signal
        )
        const candidates = await Promise.all(discovered.items.map((release) =>
          registerModAcquisitionCandidate(artifactAcquisitionService, release)))
        return {
          data: discovered,
          meta: acquisitionDiscoveryMeta(
            artifactAcquisitionService !== null,
            artifactAcquisition !== null && config.updateAcquisitionEnabled,
            candidates
          )
        }
      } catch (error) {
        return thunderstoreDependencyDiscoveryError(reply, error)
      } finally {
        request.raw.off('aborted', abortRequest)
        reply.raw.off('close', abortDisconnectedResponse)
      }
    }
  )

  app.post('/api/v1/updates/candidates/preview', protectedRoute('updates.read'), async (_request, reply) => {
    return reply.code(410).send({
      error: { code: 'UPDATE_COMPATIBILITY_BROWSER_POLICY_REMOVED', message: '候选兼容性必须使用服务端回执' }
    })
  })

  app.post('/api/v1/updates/preparation/preview', protectedRoute('updates.read'), async (request, reply) => {
    try {
      return { data: createUpdatePreparationPlan(request.body) }
    } catch (error) {
      return planningError(reply, error)
    }
  })

  app.post('/api/v1/mods/import/preview', protectedRoute('mods.read'), async (request, reply) => {
    if (!thunderstoreModImport) return thunderstoreModImportUnavailable(reply)
    const controller = new AbortController()
    const abortRequest = () => controller.abort('http-request-aborted')
    const abortDisconnectedResponse = () => {
      if (!reply.raw.writableEnded) controller.abort('http-client-disconnected')
    }
    if (request.raw.aborted) abortRequest()
    request.raw.once('aborted', abortRequest)
    reply.raw.once('close', abortDisconnectedResponse)
    try {
      const result = await thunderstoreModImport.preview(request.body, controller.signal)
      return reply.code(result.statusCode).send(result.body)
    } finally {
      request.raw.off('aborted', abortRequest)
      reply.raw.off('close', abortDisconnectedResponse)
    }
  })

  app.post('/api/v1/mods/import/execute', protectedRoute('mods.mutate'), async (request, reply) => {
    if (!thunderstoreModImport) return thunderstoreModImportUnavailable(reply)
    const controller = new AbortController()
    const abortRequest = () => controller.abort('http-request-aborted')
    const abortDisconnectedResponse = () => {
      if (!reply.raw.writableEnded) controller.abort('http-client-disconnected')
    }
    if (request.raw.aborted) abortRequest()
    request.raw.once('aborted', abortRequest)
    reply.raw.once('close', abortDisconnectedResponse)
    try {
      const result = await thunderstoreModImport.execute(request.body, controller.signal)
      return reply.code(result.statusCode).send(result.body)
    } finally {
      request.raw.off('aborted', abortRequest)
      reply.raw.off('close', abortDisconnectedResponse)
    }
  })

  app.get('/api/v1/mods/import/receipts/:requestId', protectedRoute('mods.read'), async (request, reply) => {
    if (!thunderstoreModImport) return thunderstoreModImportUnavailable(reply)
    const params = request.params as Record<string, unknown>
    const query = request.query as Record<string, unknown>
    const result = await thunderstoreModImport.getReceipt({ ...params, ...query })
    return reply.code(result.statusCode).send(result.body)
  })

  app.post('/api/v1/mods/verified-lock/preview', protectedRoute('mods.read'), async (request, reply) => {
    if (!verifiedModLocks) return verifiedModLockUnavailable(reply)
    const controller = new AbortController()
    const abortRequest = () => controller.abort('http-request-aborted')
    const abortDisconnectedResponse = () => {
      if (!reply.raw.writableEnded) controller.abort('http-client-disconnected')
    }
    if (request.raw.aborted) abortRequest()
    request.raw.once('aborted', abortRequest)
    reply.raw.once('close', abortDisconnectedResponse)
    try {
      return { data: await verifiedModLocks.preview(request.body, controller.signal) }
    } catch (error) {
      return verifiedModLockFailure(reply, error)
    } finally {
      request.raw.off('aborted', abortRequest)
      reply.raw.off('close', abortDisconnectedResponse)
    }
  })

  app.get('/api/v1/mods/deployment/state', protectedRoute('mods.read'), async (_request, reply) => {
    if (!modDeployments) return modDeploymentUnavailable(reply)
    try {
      return {
        data: await modDeployments.inspect(),
        meta: { executionEnabled: config.modDeploymentEnabled }
      }
    } catch (error) {
      return modDeploymentError(reply, error)
    }
  })

  app.get('/api/v1/mods/deployment/recovery', protectedRoute('mods.read'), async (_request, reply) => {
    if (!modDeployments) return modDeploymentUnavailable(reply)
    try {
      return { data: await modDeployments.previewCleanup() }
    } catch (error) {
      return modDeploymentError(reply, error)
    }
  })

  app.get('/api/v1/mods/deployment/receipts/:requestId', protectedRoute('mods.read'), async (request, reply) => {
    if (!modDeployments) return modDeploymentUnavailable(reply)
    const parsed = modDeploymentReceiptParamsSchema.safeParse(request.params)
    if (!parsed.success || !emptyObjectSchema.safeParse(request.query ?? {}).success) {
      return invalidModDeploymentReceiptRequest(reply)
    }
    try {
      const receipt = await modDeployments.getReceipt(parsed.data.requestId)
      return receipt === null
        ? modDeploymentReceiptNotFound(reply)
        : { data: receipt }
    } catch (error) {
      return modDeploymentError(reply, error)
    }
  })

  app.get('/api/v1/mods/deployment/history', protectedRoute('mods.read'), async (request, reply) => {
    if (!modDeployments) return modDeploymentUnavailable(reply)
    const parsed = modDeploymentHistoryQuerySchema.safeParse(request.query ?? {})
    if (!parsed.success) return invalidModDeploymentHistoryRequest(reply)
    try {
      return { data: await modDeployments.history({
        cursor: parsed.data.cursor ?? null,
        pageSize: parsed.data.pageSize ?? DEFAULT_MOD_DEPLOYMENT_HISTORY_PAGE_SIZE
      }) }
    } catch (error) {
      return modDeploymentError(reply, error)
    }
  })

  app.post('/api/v1/mods/deployment/preview', protectedRoute('mods.read'), async (request, reply) => {
    if (!modDeployments) return modDeploymentUnavailable(reply)
    const parsed = modDeploymentRequestSchema.safeParse(request.body)
    if (!parsed.success) return invalidModDeploymentRequest(reply)
    try {
      return {
        data: await modDeployments.preview(parsed.data),
        meta: { executionEnabled: config.modDeploymentEnabled }
      }
    } catch (error) {
      return modDeploymentError(reply, error)
    }
  })

  app.post('/api/v1/mods/deployment/execute', protectedRoute('mods.mutate'), async (request, reply) => {
    if (!config.modDeploymentEnabled) return modDeploymentMutationsDisabled(reply)
    if (!modDeployments) return modDeploymentUnavailable(reply)
    const parsed = modDeploymentExecuteSchema.safeParse(request.body)
    if (!parsed.success || !modDeploymentConfirmationMatches(parsed.data.request, parsed.data.confirmation)) {
      return invalidModDeploymentRequest(reply)
    }
    try {
      return { data: await modDeployments.execute(parsed.data.request) }
    } catch (error) {
      return modDeploymentError(reply, error)
    }
  })

  app.post('/api/v1/client-profile/generate', protectedRoute('client-profile.generate'), async (request, reply) => {
    try {
      return { data: generateClientProfile(request.body) }
    } catch (error) {
      if (error instanceof z.ZodError || error instanceof ClientProfileGenerationError
        || error instanceof ClientProfileArtifactError || error instanceof ModManifestError
        || error instanceof CompatibilityValidationError || error instanceof VersionValidationError) {
        return reply.code(400).send({
          error: { code: 'CLIENT_PROFILE_NOT_GENERATED', message: '客户端资料未通过一致性与公开内容校验' }
        })
      }
      throw error
    }
  })

  app.post('/api/v1/client-profile/archive', protectedRoute('client-profile.generate'), async (request, reply) => {
    try {
      const generated = generateClientProfile(request.body)
      const archive = buildClientProfileZip(generated)
      const verification = verifyClientProfileZip(archive.bytes)
      if (verification.archiveSha256 !== archive.sha256 || verification.sizeBytes !== archive.sizeBytes
          || verification.artifactSetSha256 !== generated.artifactSetSha256
          || verification.profileId !== generated.profile.profileId
          || verification.entries.length !== generated.artifacts.length) {
        throw new ClientProfileZipError('CLIENT_PROFILE_ZIP_ARTIFACT_MISMATCH')
      }

      reply.header('Content-Type', archive.mediaType)
      reply.header('Content-Disposition', `attachment; filename="${CLIENT_PROFILE_ZIP_FILE_NAME}"`)
      reply.header('Content-Length', String(archive.sizeBytes))
      reply.header('X-Dyson-Profile-SHA256', verification.archiveSha256)
      reply.header('Cache-Control', 'no-store')
      return reply.send(archive.bytes)
    } catch {
      return reply.code(400).send({
        error: { code: 'CLIENT_PROFILE_ARCHIVE_NOT_GENERATED', message: '客户端 ZIP 未通过生成与独立完整性校验' }
      })
    }
  })

  app.post('/api/v1/updates/acquisition/preview', protectedRoute('updates.read'), async (request, reply) => {
    if (!artifactAcquisition) return updateAcquisitionUnavailable(reply)
    const result = await artifactAcquisition.preview(request.body)
    return reply.code(result.statusCode).send(result.body)
  })

  app.post('/api/v1/updates/acquisition/execute', protectedRoute('updates.stage'), async (request, reply) => {
    if (!artifactAcquisition) return updateAcquisitionUnavailable(reply)
    const controller = new AbortController()
    const abortRequest = () => controller.abort('http-request-aborted')
    const abortDisconnectedResponse = () => {
      if (!reply.raw.writableEnded) controller.abort('http-client-disconnected')
    }
    if (request.raw.aborted) abortRequest()
    request.raw.once('aborted', abortRequest)
    reply.raw.once('close', abortDisconnectedResponse)
    try {
      const result = await artifactAcquisition.execute(request.body, controller.signal)
      return reply.code(result.statusCode).send(result.body)
    } finally {
      request.raw.off('aborted', abortRequest)
      reply.raw.off('close', abortDisconnectedResponse)
    }
  })

  app.get('/api/v1/updates/acquisition/receipts/:requestId', protectedRoute('updates.read'), async (request, reply) => {
    if (!artifactAcquisition) return updateAcquisitionUnavailable(reply)
    if (!emptyObjectSchema.safeParse(request.query ?? {}).success) return invalidAcquisitionRequest(reply)
    const parsed = acquisitionReceiptParamsSchema.safeParse(request.params)
    if (!parsed.success) return invalidAcquisitionRequest(reply)
    const result = await artifactAcquisition.getReceipt(parsed.data)
    return reply.code(result.statusCode).send(result.body)
  })

  app.post('/api/v1/updates/preparation/component/preview', protectedRoute('updates.read'), async (request, reply) => {
    if (!componentCandidatePreparation) return componentCandidatePreparationUnavailable(reply)
    const result = await componentCandidatePreparation.preview(request.body)
    return reply.code(result.statusCode).send(result.body)
  })

  app.post('/api/v1/updates/preparation/component/execute', protectedRoute('updates.stage'), async (request, reply) => {
    if (!componentCandidatePreparation) return componentCandidatePreparationUnavailable(reply)
    const controller = new AbortController()
    const abortRequest = () => controller.abort('http-request-aborted')
    const abortDisconnectedResponse = () => {
      if (!reply.raw.writableEnded) controller.abort('http-client-disconnected')
    }
    if (request.raw.aborted) abortRequest()
    request.raw.once('aborted', abortRequest)
    reply.raw.once('close', abortDisconnectedResponse)
    try {
      const result = await componentCandidatePreparation.execute(request.body, controller.signal)
      return reply.code(result.statusCode).send(result.body)
    } finally {
      request.raw.off('aborted', abortRequest)
      reply.raw.off('close', abortDisconnectedResponse)
    }
  })

  app.get(
    '/api/v1/updates/preparation/component/receipts/:requestId',
    protectedRoute('updates.read'),
    async (request, reply) => {
      if (!componentCandidatePreparation) return componentCandidatePreparationUnavailable(reply)
      const params = request.params as Record<string, unknown>
      const query = request.query as Record<string, unknown>
      const result = await componentCandidatePreparation.getReceipt({ ...params, ...query })
      return reply.code(result.statusCode).send(result.body)
    }
  )

  app.post('/api/v1/updates/staging/preview', protectedRoute('updates.stage'), async (request, reply) => {
    if (!updateStager) return updateStagingUnavailable(reply)
    try {
      return { data: updateStager.preview(request.body) }
    } catch (error) {
      return planningError(reply, error)
    }
  })

  app.post('/api/v1/updates/staging/execute', protectedRoute('updates.stage'), async (request, reply) => {
    if (!updateStager) return updateStagingUnavailable(reply)
    const parsed = stagingExecutionSchema.safeParse(request.body)
    if (!parsed.success) return invalidPlanningRequest(reply)
    try {
      const result = await updateStager.stage(parsed.data.request)
      return reply.code(result.created ? 201 : 200).send({ data: result })
    } catch (error) {
      if (error instanceof UpdatePipelineError && error.code === 'STAGING_LOCK_BUSY') {
        return reply.code(423).send({ error: { code: error.code, message: '该资源已有暂存事务正在执行' } })
      }
      if (error instanceof UpdatePipelineError) {
        return reply.code(409).send({
          error: { code: 'STAGING_PRECONDITION_FAILED', message: '离线资源未通过暂存校验' }
        })
      }
      throw error
    }
  })

  app.get('/api/v1/updates/activation/state', protectedRoute('updates.read'), async (_request, reply) => {
    if (!componentUpdateActivation) return updateActivationUnavailable(reply)
    const result = await componentUpdateActivation.history({})
    return reply.code(result.statusCode).send(result.body)
  })

  app.get('/api/v1/updates/activation/recovery', protectedRoute('updates.read'), async (_request, reply) => {
    if (!componentUpdateActivation) return updateActivationUnavailable(reply)
    const result = await componentUpdateActivation.recoveryStatus({})
    return reply.code(result.statusCode).send(result.body)
  })

  app.get('/api/v1/updates/activation/cleanup/preview', protectedRoute('updates.read'), async (_request, reply) => {
    if (!componentUpdateActivation) return updateActivationUnavailable(reply)
    const result = await componentUpdateActivation.previewCleanup({})
    return reply.code(result.statusCode).send(result.body)
  })

  app.get('/api/v1/updates/activation/receipts/:requestId', protectedRoute('updates.read'), async (request, reply) => {
    if (!componentUpdateActivation) return updateActivationUnavailable(reply)
    const result = await componentUpdateActivation.getReceipt(request.params)
    return reply.code(result.statusCode).send(result.body)
  })

  app.post('/api/v1/updates/activation/preview', protectedRoute('updates.read'), async (request, reply) => {
    if (!componentUpdateActivation) return updateActivationUnavailable(reply)
    const result = await componentUpdateActivation.preview(request.body)
    return reply.code(result.statusCode).send(result.body)
  })

  app.post('/api/v1/updates/activation/execute', protectedRoute('updates.activate'), async (request, reply) => {
    if (!componentUpdateActivation) return updateActivationUnavailable(reply)
    const result = await componentUpdateActivation.execute(request.body)
    return reply.code(result.statusCode).send(result.body)
  })

  app.get('/api/v1/players', protectedRoute('players.read'), async (_request, reply) => {
    if (!playerSnapshotSource) {
      return reply.code(503).send({
        error: { code: 'PLAYER_SNAPSHOT_NOT_CONFIGURED', message: '玩家会话快照尚未配置' }
      })
    }
    try {
      const snapshot = await playerSnapshotSource.read()
      playerHistory.ingest(snapshot)
      const accepted = snapshot.state === 'unavailable' ? null : playerHistory.authoritative()
      if (snapshot.state !== 'unavailable' && accepted === null) {
        throw new PlayerSnapshotError('PLAYER_HISTORY_PERSISTENCE_INVALID')
      }
      const authoritative = accepted !== null
      const responseSnapshot = accepted ?? snapshot
      return { data: {
        schemaVersion: 1,
        state: responseSnapshot.state,
        authoritative,
        observedAt: new Date(responseSnapshot.writtenAtUnixMs).toISOString(),
        sequence: responseSnapshot.sequence,
        truncated: responseSnapshot.truncated,
        playerCount: accepted ? accepted.players.length : null,
        players: accepted ? accepted.players.map(publicPlayer) : null,
        lastKnownPlayers: accepted ? [] : playerHistory.current().map(publicPlayer),
        recentEvents: playerHistory.list().slice(-64).map((event) => ({
          sequence: event.historySequence,
          type: event.type,
          occurredAt: new Date(event.occurredAtUnixMs).toISOString(),
          player: publicPlayer(event.player)
        }))
      } }
    } catch (error) {
      if (error instanceof PlayerSnapshotError) {
        return reply.code(503).send({
          error: { code: 'PLAYER_SNAPSHOT_UNAVAILABLE', message: '玩家会话状态暂不可用' }
        })
      }
      throw error
    }
  })

  app.get('/api/v1/players/capabilities', protectedRoute('players.read'), async (_request, reply) => {
    if (!playerCapabilitySource) {
      return reply.code(503).send({
        error: {
          code: 'PLAYER_CAPABILITIES_NOT_CONFIGURED',
          message: '玩家能力证明尚未配置'
        }
      })
    }
    try {
      const snapshot = await playerCapabilitySource.read()
      return {
        data: {
          repository: snapshot.verifiedUpstreamRepository,
          tag: snapshot.verifiedUpstreamTag,
          runtimeFileVersion: snapshot.verifiedRuntimeFileVersion,
          commit: snapshot.verifiedUpstreamCommit,
          verificationScope: snapshot.verificationScope,
          actionsEnabled: snapshot.actionsEnabled,
          observedAt: new Date(snapshot.writtenAtUnixMs).toISOString(),
          capabilities: snapshot.capabilities.map((capability) => ({
            capability: capability.capability,
            availability: capability.availability,
            mode: capability.mode,
            reasonCode: capability.verifiedReasonCode,
            reasonSummary: playerCapabilityReasonSummaries[capability.verifiedReasonCode]
          }))
        }
      }
    } catch (error) {
      if (error instanceof PlayerCapabilityError) {
        return reply.code(503).send({
          error: {
            code: 'PLAYER_CAPABILITIES_UNAVAILABLE',
            message: '玩家能力证明暂不可用'
          }
        })
      }
      throw error
    }
  })

  app.post('/api/v1/updates/plan/preview', protectedRoute('updates.read'), async (request, reply) => {
    try {
      return { data: { mode: 'dry-run', plan: createUpdatePlan(request.body) } }
    } catch (error) {
      return planningError(reply, error)
    }
  })

  app.post('/api/v1/mods/resolve/preview', protectedRoute('mods.read'), async (request, reply) => {
    try {
      return { data: { mode: 'dry-run', resolution: resolveModGraph(request.body) } }
    } catch (error) {
      return planningError(reply, error)
    }
  })

  app.post('/api/v1/mods/lock/preview', protectedRoute('mods.read'), async (request, reply) => {
    try {
      return { data: { mode: 'dry-run', ...generateModManifests(request.body) } }
    } catch (error) {
      return planningError(reply, error)
    }
  })

  app.post('/api/v1/actions/lifecycle/preview', protectedRoute('lifecycle.preview'), async (request, reply) => {
    const parsed = lifecycleActionRequestSchema.safeParse(request.body)
    if (!parsed.success) {
      return reply.code(400).send({ error: { code: 'INVALID_LIFECYCLE_ACTION', message: '生命周期预检请求无效' } })
    }
    try {
      const result = await jobs.previewLifecycle(
        parsed.data.action,
        request.actor ?? 'unknown',
        (action) => lifecycle.preview(action)
      )
      return reply.code(200).send({ data: result })
    } catch {
      return reply.code(503).send({
        error: { code: 'LIFECYCLE_PREVIEW_FAILED', message: '生命周期只读预检暂不可用' }
      })
    }
  })

  app.post('/api/v1/actions/lifecycle/execute', protectedRoute('lifecycle.execute'), async (request, reply) => {
    const parsed = lifecycleExecutionRequestSchema.safeParse(request.body)
    if (!parsed.success) {
      return reply.code(400).send({
        error: { code: 'INVALID_LIFECYCLE_EXECUTION', message: '生命周期执行请求无效' }
      })
    }
    try {
      const result = lifecycle.enqueue(
        parsed.data.action,
        parsed.data.idempotencyKey,
        request.actor ?? 'unknown'
      )
      return reply.code(result.reused ? 200 : 202).send({ data: result })
    } catch (error) {
      if (error instanceof LifecycleExecutionError && error.code === 'LIFECYCLE_IDEMPOTENCY_CONFLICT') {
        return reply.code(409).send({
          error: { code: error.code, message: '幂等键已用于其他生命周期操作' }
        })
      }
      throw error
    }
  })

  app.get('/api/v1/lifecycle/:id', protectedRoute('jobs.read'), async (request, reply) => {
    const parsedId = z.string().uuid().safeParse((request.params as { id: string }).id)
    if (!parsedId.success) {
      return reply.code(400).send({
        error: { code: 'INVALID_LIFECYCLE_ID', message: '生命周期事务编号无效' }
      })
    }
    const result = lifecycle.get(parsedId.data)
    return result
      ? { data: result }
      : reply.code(404).send({ error: { code: 'LIFECYCLE_NOT_FOUND', message: '生命周期事务不存在' } })
  })

  app.get('/api/v1/events', protectedRoute('jobs.read'), async (request, reply) => {
    reply.hijack()
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no'
    })
    reply.raw.write(': connected\n\n')
    const unsubscribe = events.subscribe((event) => {
      reply.raw.write(`event: ${event.type}\ndata: ${JSON.stringify(event.data)}\n\n`)
    })
    const heartbeat = setInterval(() => reply.raw.write(': heartbeat\n\n'), 20_000)
    request.raw.once('close', () => { clearInterval(heartbeat); unsubscribe() })
  })

  const webRoot = path.resolve(import.meta.dirname, '..', '..', 'web', 'dist')
  if (fs.existsSync(webRoot)) {
    await app.register(fastifyStatic, { root: webRoot, prefix: '/' })
    app.setNotFoundHandler((request, reply) => {
      if (request.url.startsWith('/api/')) {
        return reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'Route not found' } })
      }
      return reply.sendFile('index.html')
    })
  }

  return {
    app,
    async close() {
      if (observabilityTimer) clearInterval(observabilityTimer)
      stopPlayerHistoryRetention()
      unsubscribeObservability()
      await app.close()
      await lifecycle.close()
      await saveJobs?.close()
      database.close()
    }
  }
}

function observabilityUnavailable(reply: FastifyReply) {
  return reply.code(503).send({
    error: { code: 'OBSERVABILITY_UNAVAILABLE', message: '服务器观测数据暂不可用' }
  })
}

function observabilityAlertUnavailable(reply: FastifyReply) {
  return reply.code(503).send({
    error: { code: 'OBSERVABILITY_ALERTS_UNAVAILABLE', message: '告警事件暂不可用' }
  })
}

function observabilityAlertError(reply: FastifyReply, error: unknown) {
  if (error instanceof ObservabilityAlertError) {
    if (error.code === 'OBSERVABILITY_ALERT_EPISODE_NOT_FOUND') {
      return reply.code(404).send({ error: { code: error.code, message: '告警事件不存在' } })
    }
    if (['OBSERVABILITY_ALERT_EPISODE_RESOLVED',
      'OBSERVABILITY_ALERT_ACKNOWLEDGEMENT_CONFLICT'].includes(error.code)) {
      return reply.code(409).send({ error: { code: error.code, message: '告警事件状态已经变化' } })
    }
    if (['OBSERVABILITY_ALERT_INPUT_INVALID',
      'OBSERVABILITY_ALERT_EPISODE_ID_INVALID'].includes(error.code)) {
      return reply.code(400).send({ error: { code: error.code, message: '告警确认请求无效' } })
    }
  }
  if (error instanceof PersistentObservabilityAlertError) {
    return reply.code(503).send({
      error: { code: error.code, message: '告警持久化状态需要重新核验' }
    })
  }
  return observabilityAlertUnavailable(reply)
}

function workspaceUnavailable(reply: FastifyReply) {
  return reply.code(503).send({ error: { code: 'WORKSPACE_UNAVAILABLE', message: '受管游戏目录暂不可用' } })
}

function invalidInventoryRequest(reply: FastifyReply) {
  return reply.code(400).send({ error: { code: 'INVALID_INVENTORY_REQUEST', message: '目录查询请求无效' } })
}

function inventoryError(reply: FastifyReply, error: unknown) {
  if (error instanceof SaveCatalogError && ['INVALID_CURSOR', 'INVALID_BACKUP_ID'].includes(error.code)) {
    return invalidInventoryRequest(reply)
  }
  return reply.code(503).send({ error: { code: 'INVENTORY_UNAVAILABLE', message: '存档目录暂不可用' } })
}

function invalidSaveTransactionRequest(reply: FastifyReply) {
  return reply.code(400).send({
    error: { code: 'INVALID_SAVE_TRANSACTION_REQUEST', message: '存档事务请求无效' }
  })
}

function saveTransactionsUnavailable(reply: FastifyReply) {
  return reply.code(503).send({
    error: { code: 'SAVE_TRANSACTIONS_UNAVAILABLE', message: '存档事务服务尚未配置' }
  })
}

function saveMutationsDisabled(reply: FastifyReply) {
  return reply.code(503).send({
    error: { code: 'SAVE_MUTATIONS_DISABLED', message: '存档写操作尚未显式启用' }
  })
}

function saveTransactionStorageError(reply: FastifyReply) {
  return reply.code(503).send({
    error: { code: 'SAVE_TRANSACTION_UNAVAILABLE', message: '存档事务暂不可用' }
  })
}

function saveTransactionReply(
  reply: FastifyReply,
  result: SaveTransactionResult,
  executionEnabled: boolean
) {
  if (result.status === 'dry-run' || result.status === 'succeeded') {
    return reply.code(200).send({ data: result, meta: { executionEnabled } })
  }
  if (result.status === 'busy') {
    return reply.code(423).send({ error: { code: result.errorCode, message: '已有存档事务正在执行' } })
  }
  if (result.status === 'revision-conflict') {
    return reply.code(409).send({ error: { code: result.errorCode, message: '当前存档已变化，请刷新后重新预览' } })
  }
  if (result.status === 'rejected') {
    const statusCode = result.errorCode === 'SAVE_SERVICE_NOT_STOPPED' ? 409 : 400
    const message = result.errorCode === 'SAVE_SERVICE_NOT_STOPPED'
      ? '恢复前必须确认游戏进程已停止且游戏端口未监听'
      : '存档事务因配对、身份或完整性门禁被拒绝'
    return reply.code(statusCode).send({ error: { code: result.errorCode, message } })
  }
  return reply.code(503).send({
    error: {
      code: result.errorCode ?? 'SAVE_TRANSACTION_FAILED',
      message: result.rollback === 'succeeded'
        ? '存档事务失败，原存档对已自动恢复'
        : result.rollback === 'failed'
          ? '存档事务失败且自动恢复未完成，需要人工核验'
          : '存档事务失败，未提交任何已验证变更'
    }
  })
}

function saveJobReply(reply: FastifyReply, result: SaveJobExecutionResult) {
  const accepted = ['queued', 'running'].includes(result.run.state)
  return reply.code(accepted ? 202 : 200).send({ data: result })
}

function saveJobError(reply: FastifyReply, error: unknown) {
  if (error instanceof SaveJobServiceError) {
    if (error.code === 'SAVE_JOB_REQUEST_INVALID') {
      return invalidSaveTransactionRequest(reply)
    }
    if (error.code === 'SAVE_JOB_IDEMPOTENCY_CONFLICT') {
      return reply.code(409).send({
        error: { code: error.code, message: '该幂等请求标识已经用于不同的存档事务' }
      })
    }
    if (error.code === 'SAVE_JOB_RECONCILE_NOT_ALLOWED' ||
        error.code === 'SAVE_JOB_RECONCILE_CONFLICT') {
      return reply.code(409).send({
        error: {
          code: error.code,
          message: error.code === 'SAVE_JOB_RECONCILE_NOT_ALLOWED'
            ? '该存档任务没有可安全重放的维护终态'
            : '存档任务状态已变化，请刷新后重试'
        }
      })
    }
    if (error.code === 'SAVE_JOB_SERVICE_CLOSED') {
      return reply.code(503).send({
        error: { code: error.code, message: '存档作业服务正在关闭' }
      })
    }
  }
  return saveTransactionStorageError(reply)
}

function consoleUnavailable(reply: FastifyReply, code = 'CONSOLE_UNAVAILABLE') {
  return reply.code(503).send({ error: { code, message: '结构化控制台暂不可用' } })
}

function consoleError(reply: FastifyReply, error: unknown) {
  if (error instanceof ConsoleLogError) {
    if (['CONSOLE_LOG_QUERY_INVALID', 'CONSOLE_LOG_CURSOR_INVALID',
      'CONSOLE_LOG_CURSOR_SIGNATURE_INVALID', 'CONSOLE_LOG_DOWNLOAD_INVALID'].includes(error.code)) {
      return reply.code(400).send({ error: { code: 'INVALID_CONSOLE_REQUEST', message: '控制台请求无效' } })
    }
    if (error.code === 'CONSOLE_LOG_FILE_TOO_LARGE') {
      return reply.code(413).send({ error: { code: error.code, message: '控制台日志超过读取上限' } })
    }
  }
  return consoleUnavailable(reply)
}

function consoleCommandError(reply: FastifyReply, error: unknown) {
  if (error instanceof ConsoleCommandError) {
    const status = error.code === 'CONSOLE_COMMAND_CONFIRMATION_MISMATCH' ? 422 : 400
    return reply.code(status).send({
      error: {
        code: error.code,
        message: error.code === 'CONSOLE_COMMAND_CONFIRMATION_MISMATCH'
          ? '固定控制台动作的确认短语不匹配'
          : '固定控制台动作请求无效'
      }
    })
  }
  if (error instanceof LifecycleExecutionError) {
    if (error.code === 'LIFECYCLE_IDEMPOTENCY_CONFLICT') {
      return reply.code(409).send({
        error: { code: error.code, message: '该幂等标识已经用于不同的生命周期动作' }
      })
    }
    if (error.code === 'LIFECYCLE_BUSY') {
      return reply.code(423).send({
        error: { code: error.code, message: '已有生命周期事务正在执行' }
      })
    }
  }
  return reply.code(503).send({
    error: { code: 'CONSOLE_COMMAND_UNAVAILABLE', message: '固定控制台动作暂不可用' }
  })
}

function invalidPlanningRequest(reply: FastifyReply) {
  return reply.code(400).send({ error: { code: 'INVALID_PLANNING_REQUEST', message: '版本或模组预览请求无效' } })
}

function modDeploymentConfirmationMatches(
  request: ModDeploymentRequest,
  confirmation: z.infer<typeof modDeploymentExecuteSchema>['confirmation']
): boolean {
  return confirmation.requestId.toLowerCase() === request.requestId
    && confirmation.operation === request.operation
    && confirmation.dependencyId === request.package.dependencyId
    && confirmation.version === request.package.version
    && confirmation.expectedRevision === request.expectedRevision
}

function invalidModDeploymentRequest(reply: FastifyReply) {
  return reply.code(400).send({
    error: { code: 'INVALID_MOD_DEPLOYMENT_REQUEST', message: '模组部署请求不符合固定逻辑字段约束' }
  })
}

function invalidModDeploymentReceiptRequest(reply: FastifyReply) {
  return reply.code(400).send({
    error: { code: 'INVALID_MOD_DEPLOYMENT_RECEIPT_REQUEST', message: '模组部署回执编号无效' }
  })
}

function invalidModDeploymentHistoryRequest(reply: FastifyReply) {
  return reply.code(400).send({
    error: { code: 'INVALID_MOD_DEPLOYMENT_HISTORY_REQUEST', message: '模组部署回执历史查询无效' }
  })
}

function modDeploymentReceiptNotFound(reply: FastifyReply) {
  return reply.code(404).send({
    error: { code: 'MOD_DEPLOYMENT_RECEIPT_NOT_FOUND', message: '模组部署回执不存在' }
  })
}

function modDeploymentUnavailable(reply: FastifyReply) {
  return reply.code(503).send({
    error: { code: 'MOD_DEPLOYMENT_NOT_CONFIGURED', message: '模组部署服务尚未配置固定根目录' }
  })
}

function modDeploymentMutationsDisabled(reply: FastifyReply) {
  return reply.code(503).send({
    error: { code: 'MOD_DEPLOYMENT_MUTATIONS_DISABLED', message: '模组部署写操作尚未显式启用' }
  })
}

function modDeploymentError(reply: FastifyReply, error: unknown) {
  if (!(error instanceof ModDeploymentError)) {
    return reply.code(503).send({
      error: { code: 'MOD_DEPLOYMENT_UNAVAILABLE', message: '模组部署服务暂不可用' }
    })
  }
  if (error.code === 'MOD_DEPLOYMENT_REQUEST_INVALID') return invalidModDeploymentRequest(reply)
  if (error.code === 'MOD_DEPLOYMENT_RECEIPT_REQUEST_INVALID') return invalidModDeploymentReceiptRequest(reply)
  if (error.code === 'MOD_DEPLOYMENT_HISTORY_REQUEST_INVALID' ||
      error.code === 'MOD_DEPLOYMENT_HISTORY_CURSOR_INVALID') {
    return invalidModDeploymentHistoryRequest(reply)
  }
  if (error.code === 'MOD_DEPLOYMENT_BUSY') {
    return reply.code(423).send({ error: { code: error.code, message: '已有模组部署事务正在执行' } })
  }
  if (error.code === 'MOD_DEPLOYMENT_HOST_LEASE_BUSY') {
    return reply.code(423).send({
      error: { code: error.code, message: '已有服务器主机变更事务正在执行' }
    })
  }
  if (['MOD_DEPLOYMENT_HOST_LEASE_DIRTY', 'MOD_DEPLOYMENT_HOST_LEASE_RECOVERY_REQUIRED',
    'MOD_DEPLOYMENT_HOST_LEASE_LOST', 'MOD_DEPLOYMENT_HOST_LEASE_UNAVAILABLE'].includes(error.code)) {
    return reply.code(503).send({
      error: { code: error.code, message: '主机变更互斥状态需要核验，模组部署已关闭放行' }
    })
  }
  if (error.code === 'MOD_DEPLOYMENT_RECOVERY_REQUIRED') {
    return reply.code(503).send({
      error: { code: error.code, message: '模组部署回执或托管状态需要恢复核验' }
    })
  }
  if (error.code === 'MOD_DEPLOYMENT_PLATFORM_INVENTORY_UNAVAILABLE') {
    return reply.code(503).send({
      error: { code: error.code, message: '可信平台版本清单暂不可用，模组部署已关闭放行' }
    })
  }
  if (error.code === 'MOD_DEPLOYMENT_STOP_GATE_REJECTED') {
    return reply.code(409).send({
      error: { code: error.code, message: '执行要求游戏进程已停止且游戏端口未监听' }
    })
  }
  if (['MOD_DEPLOYMENT_ROOT_INVALID', 'MOD_DEPLOYMENT_ROOT_LINK_REJECTED', 'MOD_DEPLOYMENT_PATH_ESCAPE',
    'MOD_DEPLOYMENT_UNMANAGED_CONTENT', 'MOD_DEPLOYMENT_STATE_INVALID'].includes(error.code)) {
    return reply.code(503).send({
      error: { code: 'MOD_DEPLOYMENT_UNAVAILABLE', message: '模组托管状态未通过固定根目录完整性校验' }
    })
  }
  if (['MOD_DEPLOYMENT_EXECUTION_FAILED', 'MOD_DEPLOYMENT_ROLLBACK_FAILED'].includes(error.code)) {
    return reply.code(503).send({
      error: { code: error.code, message: '模组部署提交失败，需要依据恢复回执核验托管目录' }
    })
  }
  return reply.code(409).send({
    error: { code: error.code, message: '模组部署预演或执行被一致性门禁拒绝' }
  })
}

function planningError(reply: FastifyReply, error: unknown) {
  if (error instanceof z.ZodError || error instanceof CompatibilityValidationError
    || error instanceof UpdatePlanTransitionError || error instanceof VersionValidationError
    || error instanceof ModManifestError || error instanceof ModResolutionInputError
    || error instanceof ThunderstoreDependencyError || error instanceof UpdatePipelineError) {
    return invalidPlanningRequest(reply)
  }
  throw error
}

type ArtifactAcquisitionRegistrationService = NonNullable<ApplicationDependencies['artifactAcquisitionService']>
type AcquisitionCandidateRegistrationStatus =
  | 'registered'
  | 'not-configured'
  | 'release-ineligible'
  | 'registration-failed'

interface AcquisitionCandidateRegistration {
  artifactId: string
  eligible: boolean
  status: AcquisitionCandidateRegistrationStatus
  candidate: ArtifactCandidateDescriptor | null
}

async function registerNebulaAcquisitionCandidate(
  service: ArtifactAcquisitionRegistrationService | null,
  release: DiscoveredNebulaRelease
): Promise<AcquisitionCandidateRegistration> {
  if (service === null) return unavailableAcquisitionCandidate(release.artifact.artifactId, true, 'not-configured')
  try {
    const parsed = acquisitionCandidateDescriptorSchema.safeParse(await service.registerNebulaRelease(release))
    if (!parsed.success || !acquisitionCandidateMatchesRelease(parsed.data, release)) {
      return unavailableAcquisitionCandidate(release.artifact.artifactId, true, 'registration-failed')
    }
    return { artifactId: release.artifact.artifactId, eligible: true, status: 'registered', candidate: parsed.data }
  } catch {
    return unavailableAcquisitionCandidate(release.artifact.artifactId, true, 'registration-failed')
  }
}

async function registerBepInExAcquisitionCandidate(
  service: ArtifactAcquisitionRegistrationService | null,
  release: DiscoveredBepInExRelease
): Promise<AcquisitionCandidateRegistration> {
  if (service === null) return unavailableAcquisitionCandidate(release.artifact.artifactId, true, 'not-configured')
  try {
    const parsed = acquisitionCandidateDescriptorSchema.safeParse(await service.registerBepInExRelease(release))
    if (!parsed.success || !acquisitionCandidateMatchesRelease(parsed.data, release)) {
      return unavailableAcquisitionCandidate(release.artifact.artifactId, true, 'registration-failed')
    }
    return { artifactId: release.artifact.artifactId, eligible: true, status: 'registered', candidate: parsed.data }
  } catch {
    return unavailableAcquisitionCandidate(release.artifact.artifactId, true, 'registration-failed')
  }
}

async function registerModAcquisitionCandidate(
  service: ArtifactAcquisitionRegistrationService | null,
  release: DiscoveredModRelease
): Promise<AcquisitionCandidateRegistration> {
  if (!release.eligible) {
    return unavailableAcquisitionCandidate(release.artifact.artifactId, false, 'release-ineligible')
  }
  const route = routeThunderstoreDependency(release)
  if (!route.directPluginAcquisitionAllowed) {
    return unavailableAcquisitionCandidate(release.artifact.artifactId, false, 'release-ineligible')
  }
  if (service === null) return unavailableAcquisitionCandidate(release.artifact.artifactId, true, 'not-configured')
  try {
    const parsed = acquisitionCandidateDescriptorSchema.safeParse(await service.registerModRelease(release))
    if (!parsed.success || !acquisitionCandidateMatchesRelease(parsed.data, release)) {
      return unavailableAcquisitionCandidate(release.artifact.artifactId, true, 'registration-failed')
    }
    return { artifactId: release.artifact.artifactId, eligible: true, status: 'registered', candidate: parsed.data }
  } catch {
    return unavailableAcquisitionCandidate(release.artifact.artifactId, true, 'registration-failed')
  }
}

function acquisitionCandidateMatchesRelease(
  candidate: ArtifactCandidateDescriptor,
  release: DiscoveredNebulaRelease | DiscoveredBepInExRelease | DiscoveredModRelease
): boolean {
  const expectedProvider = release.provider === 'github' ? 'github' : 'thunderstore'
  const expectedKind = release.provider === 'thunderstore'
    ? 'plugin'
    : release.sourceId.toLowerCase() === 'github:bepinex/bepinex'
      ? 'bepinex'
      : 'nebula'
  return candidate.provider === expectedProvider && candidate.release.kind === expectedKind &&
    candidate.release.sourceId === release.sourceId && candidate.release.version === release.version &&
    candidate.artifact.artifactId === release.artifact.artifactId &&
    (release.provider !== 'thunderstore' || (
      JSON.stringify(candidate.release.dependencies) === JSON.stringify(release.dependencies) &&
      candidate.release.dependencyFingerprint === thunderstoreDependencyFingerprint(release.dependencies)
    ))
}

function unavailableAcquisitionCandidate(
  artifactId: string,
  eligible: boolean,
  status: Exclude<AcquisitionCandidateRegistrationStatus, 'registered'>
): AcquisitionCandidateRegistration {
  return { artifactId, eligible, status, candidate: null }
}

function acquisitionDiscoveryMeta(
  configured: boolean,
  executionEnabled: boolean,
  candidates: readonly AcquisitionCandidateRegistration[]
) {
  return {
    acquisition: {
      configured,
      executionEnabled,
      candidates
    }
  }
}

function thunderstoreDependencyDiscoveryUnavailable(reply: FastifyReply) {
  return reply.code(503).send({
    error: { code: 'THUNDERSTORE_DEPENDENCY_DISCOVERY_NOT_CONFIGURED' }
  })
}

function thunderstoreDependencyDiscoveryError(reply: FastifyReply, error: unknown) {
  if (error instanceof z.ZodError) return invalidPlanningRequest(reply)
  if (error instanceof UpdatePipelineError) {
    if (['THUNDERSTORE_DEPENDENCY_VERSION_CONFLICT', 'THUNDERSTORE_DEPENDENCY_CYCLE']
      .includes(error.code)) {
      return reply.code(409).send({ error: { code: error.code } })
    }
    if (['THUNDERSTORE_DEPENDENCY_ROOT_DUPLICATE', 'THUNDERSTORE_DEPENDENCY_NODE_LIMIT',
      'THUNDERSTORE_DEPENDENCY_DEPTH_LIMIT'].includes(error.code)) {
      return reply.code(422).send({ error: { code: error.code } })
    }
  }
  return reply.code(502).send({
    error: { code: 'THUNDERSTORE_DEPENDENCY_DISCOVERY_FAILED' }
  })
}

function invalidAcquisitionRequest(reply: FastifyReply) {
  return reply.code(422).send({
    ok: false,
    error: { code: 'UPDATE_ACQUISITION_REQUEST_INVALID' }
  })
}

function updateAcquisitionUnavailable(reply: FastifyReply) {
  return reply.code(503).send({
    ok: false,
    error: { code: 'UPDATE_ACQUISITION_NOT_CONFIGURED' }
  })
}

function componentCandidatePreparationUnavailable(reply: FastifyReply) {
  return reply.code(503).send({
    ok: false,
    error: { code: 'CANDIDATE_PREPARATION_NOT_CONFIGURED' }
  })
}

function thunderstoreModImportUnavailable(reply: FastifyReply) {
  return reply.code(503).send({
    ok: false,
    error: { code: 'THUNDERSTORE_MOD_IMPORT_NOT_CONFIGURED' }
  })
}

function verifiedModLockUnavailable(reply: FastifyReply) {
  return reply.code(503).send({
    error: { code: 'VERIFIED_MOD_LOCK_NOT_CONFIGURED' }
  })
}

function verifiedModLockFailure(reply: FastifyReply, error: unknown) {
  if (error instanceof z.ZodError) {
    return reply.code(422).send({ error: { code: 'VERIFIED_MOD_LOCK_REQUEST_INVALID' } })
  }
  if (error instanceof VerifiedModLockError) {
    if (error.code === 'VERIFIED_MOD_IMPORT_RECEIPT_NOT_FOUND') {
      return reply.code(404).send({ error: { code: error.code } })
    }
    if (['VERIFIED_MOD_IMPORT_RECEIPT_UNAVAILABLE', 'VERIFIED_MOD_LOCK_ABORTED'].includes(error.code)) {
      return reply.code(503).send({ error: { code: error.code } })
    }
    return reply.code(422).send({ error: { code: error.code } })
  }
  if (error instanceof ModManifestError || error instanceof ModResolutionInputError ||
      error instanceof ThunderstoreDependencyError) {
    return reply.code(422).send({ error: { code: 'VERIFIED_MOD_GRAPH_INVALID' } })
  }
  if (error instanceof UpdatePipelineError) {
    return reply.code(422).send({ error: { code: error.code } })
  }
  return reply.code(503).send({ error: { code: 'VERIFIED_MOD_LOCK_UNAVAILABLE' } })
}

function updateStagingUnavailable(reply: FastifyReply) {
  return reply.code(503).send({
    error: { code: 'UPDATE_STAGING_NOT_CONFIGURED', message: '离线更新暂存尚未启用' }
  })
}

function updateActivationUnavailable(reply: FastifyReply) {
  return reply.code(503).send({
    error: { code: 'UPDATE_ACTIVATION_NOT_CONFIGURED', message: '组件更新激活事务尚未配置' }
  })
}

function trustedCompatibilityUnavailable(reply: FastifyReply) {
  return reply.code(503).send({
    ok: false,
    error: { code: 'UPDATE_COMPATIBILITY_NOT_CONFIGURED' }
  })
}

async function readTrustedCompatibilityPolicy(filePath: string): Promise<unknown> {
  try {
    const info = await fs.promises.lstat(filePath)
    if (!info.isFile() || info.isSymbolicLink() || info.size <= 0 || info.size > 1_024 * 1_024) {
      throw new Error('invalid fixed policy file')
    }
    return JSON.parse(await fs.promises.readFile(filePath, 'utf8')) as unknown
  } catch {
    // Startup must fail closed, but never include the configured host path or
    // file contents in the error surfaced by the process manager.
    throw new Error('UPDATE_COMPATIBILITY_POLICY_FILE_INVALID')
  }
}

function saveTransferMutationsDisabled(reply: FastifyReply) {
  return reply.code(423).send({
    error: { code: 'SAVE_TRANSFER_DISABLED', message: '配对存档导入导出门禁尚未启用' }
  })
}

function saveTransferUnavailable(reply: FastifyReply) {
  return reply.code(503).send({
    error: { code: 'SAVE_TRANSFER_NOT_CONFIGURED', message: '配对存档传输固定根目录尚未配置' }
  })
}

function saveTransferError(reply: FastifyReply, error: unknown) {
  if (!(error instanceof SaveTransferError)) throw error
  if (error.code === 'SAVE_TRANSFER_REQUEST_INVALID') {
    return reply.code(400).send({ error: { code: error.code, message: '配对存档传输请求无效' } })
  }
  if (error.code === 'SAVE_TRANSFER_EXPORT_NOT_FOUND') {
    return reply.code(404).send({ error: { code: error.code, message: '导出制品不存在' } })
  }
  if (error.code === 'SAVE_TRANSFER_LOCK_BUSY') {
    return reply.code(423).send({ error: { code: error.code, message: '已有配对存档传输事务正在执行' } })
  }
  if (error.code === 'SAVE_TRANSFER_SPACE_INSUFFICIENT') {
    return reply.code(507).send({ error: { code: error.code, message: '固定传输卷可用空间不足' } })
  }
  if (error.code === 'SAVE_TRANSFER_IDEMPOTENCY_CONFLICT' ||
      error.code === 'SAVE_TRANSFER_BACKUP_UNHEALTHY' || error.code === 'SAVE_TRANSFER_SOURCE_CHANGED') {
    return reply.code(409).send({ error: { code: error.code, message: '配对存档传输前置条件已变化' } })
  }
  if (error.code === 'SAVE_TRANSFER_ROOT_UNAVAILABLE' || error.code === 'SAVE_TRANSFER_SPACE_UNAVAILABLE' ||
      error.code === 'SAVE_TRANSFER_LOCK_FAILED' || error.code === 'SAVE_TRANSFER_FAILED') {
    return reply.code(503).send({ error: { code: error.code, message: '配对存档传输服务暂不可用' } })
  }
  return reply.code(422).send({ error: { code: error.code, message: '配对存档制品未通过完整性校验' } })
}

function publicPlayer(player: {
  sessionPlayerId: string
  displayName: string
  online: boolean
  joinedAtUnixMs: number
  location: string
}) {
  return {
    sessionPlayerId: player.sessionPlayerId,
    displayName: player.displayName,
    online: player.online,
    joinedAt: new Date(player.joinedAtUnixMs).toISOString(),
    location: player.location
  }
}

function configTransactionReply(reply: FastifyReply, result: GameConfigTransactionResult) {
  if (result.status === 'applied') return reply.code(200).send({ data: result })
  if (result.status === 'revision-conflict') {
    return reply.code(409).send({ error: { code: result.errorCode, message: '配置已发生变化，请刷新后重新预览' } })
  }
  if (result.status === 'busy') {
    return reply.code(423).send({ error: { code: result.errorCode, message: '已有配置事务正在执行' } })
  }
  if (result.status === 'rejected' || result.status === 'dry-run') {
    return reply.code(400).send({
      error: { code: result.errorCode ?? 'CONFIG_PLAN_REJECTED', message: '配置事务被拒绝' }
    })
  }
  return reply.code(503).send({
    error: { code: result.errorCode ?? 'CONFIG_TRANSACTION_FAILED', message: '配置提交失败，已执行恢复门禁' }
  })
}
