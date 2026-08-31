import path from 'node:path'
import { z } from 'zod'
import { managedOrdinaryModsDirectoryName } from './update-pipeline/plugin-ownership.js'

const environmentSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  DYSON_HOST: z.string().default('127.0.0.1'),
  DYSON_PORT: z.coerce.number().int().min(1).max(65535).default(13010),
  DYSON_PROVIDER: z.enum(['demo', 'windows']).default('demo'),
  DYSON_PUBLIC_ORIGIN: z.string().url().default('http://127.0.0.1:13010'),
  DYSON_DATA_DIR: z.string().optional(),
  DYSON_PROJECT_ROOT: z.string().optional(),
  DYSON_SCRIPT_ROOT: z.string().optional(),
  DYSON_STATUS_TIMEOUT_MS: z.coerce.number().int().min(1000).max(120_000).default(15_000),
  DYSON_OBSERVABILITY_INTERVAL_MS: z.coerce.number().int().min(0).max(300_000)
    .refine((value) => value === 0 || value >= 1_000, 'polling interval must be zero or at least 1000 ms')
    .optional(),
  DYSON_OBSERVABILITY_HISTORY_CAPACITY: z.coerce.number().int().min(360).max(4_096).default(2_048),
  DYSON_OBSERVABILITY_ALERT_CAPACITY: z.coerce.number().int().min(1).max(4_096).default(256),
  DYSON_OBSERVABILITY_ALERT_RESOLVE_AFTER_MISSING_SAMPLES: z.coerce.number().int().min(1).max(1_000).default(3),
  DYSON_DEPLOYMENT_VERSION: z.string()
    .regex(/^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/)
    .optional(),
  DYSON_CONSOLE_CURSOR_SECRET: z.string().min(32).max(512).optional(),
  DYSON_UPDATE_STAGING_ENABLED: z.enum(['true', 'false']).default('false'),
  DYSON_UPDATE_ACQUISITION_ENABLED: z.enum(['true', 'false']).default('false'),
  DYSON_UPDATE_PREPARATION_ENABLED: z.enum(['true', 'false']).default('false'),
  DYSON_UPDATE_ACTIVATION_ENABLED: z.enum(['true', 'false']).default('false'),
  DYSON_UPDATE_INBOX_ROOT: z.string().optional(),
  DYSON_UPDATE_STAGING_ROOT: z.string().optional(),
  DYSON_UPDATE_COMPATIBILITY_POLICY_FILE: z.string().optional(),
  DYSON_MOD_IMPORT_ENABLED: z.enum(['true', 'false']).default('false'),
  DYSON_MOD_DEPLOYMENT_ENABLED: z.enum(['true', 'false']).default('false'),
  DYSON_MOD_STAGING_ROOT: z.string().optional(),
  DYSON_MOD_PLUGINS_ROOT: z.string().optional(),
  DYSON_MOD_SNAPSHOT_LIMIT: z.coerce.number().int().min(1).max(64).default(8),
  DYSON_SAVE_MUTATIONS_ENABLED: z.enum(['true', 'false']).default('false'),
  DYSON_SAVE_RETENTION_MUTATIONS_ENABLED: z.enum(['true', 'false']).default('false'),
  DYSON_SAVE_RETENTION_PURGE_MINIMUM_HOURS: z.coerce.number().int().min(1).max(8_760).default(168),
  DYSON_CONFIG_HISTORY_MUTATIONS_ENABLED: z.enum(['true', 'false']).default('false'),
  DYSON_SAVE_TRANSFER_ENABLED: z.enum(['true', 'false']).default('false'),
  DYSON_SAVE_TRANSFER_ROOT: z.string().optional(),
  DYSON_LIFECYCLE_ENABLED: z.enum(['true', 'false']).default('false'),
  DYSON_LIFECYCLE_TIMEOUT_MS: z.coerce.number().int().min(10_000).max(300_000).default(240_000),
  DYSON_BRIDGE_CONTROL_ROOT: z.string().optional(),
  DYSON_BRIDGE_SECRET_FILE: z.string().optional(),
  DYSON_BRIDGE_PLUGIN_VERSION: z.string().regex(/^\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]{1,32})?$/).default('0.1.0'),
  DYSON_PLAYER_SNAPSHOT_MAX_AGE_MS: z.coerce.number().int().min(2_000).max(120_000).default(10_000),
  DYSON_PLAYER_HISTORY_CAPACITY: z.coerce.number().int().min(1).max(2_048).default(512),
  DYSON_PLAYER_HISTORY_RETENTION_HOURS: z.coerce.number().int().min(1).max(720).default(168),
  DYSON_SERVER_TASK: z.string().regex(/^[\p{L}\p{N}_. -]{1,128}$/u).default('Dyson-Nebula-Server'),
  DYSON_STOP_TASK: z.string().regex(/^[\p{L}\p{N}_. -]{1,128}$/u).default('Dyson-Nebula-Stop'),
  DYSON_GAME_PORT: z.coerce.number().int().min(1).max(65535).default(8469),
  DYSON_ADMIN_PASSWORD_HASH: z.string().optional(),
  DYSON_OPERATOR_PASSWORD_HASH: z.string().optional(),
  DYSON_VIEWER_PASSWORD_HASH: z.string().optional(),
  DYSON_SESSION_SECRET: z.string().optional(),
  DYSON_DEV_ADMIN_PASSWORD: z.string().min(12).default('dyson-control-local-demo')
})

const knownDysonEnvironmentNames = new Set(
  Object.keys(environmentSchema.shape).filter((name) => name.startsWith('DYSON_'))
)

function assertNoUnknownDysonEnvironmentVariables(environment: NodeJS.ProcessEnv): void {
  const unknownNames = Object.keys(environment)
    .filter((name) => name.startsWith('DYSON_') && !knownDysonEnvironmentNames.has(name))
    .sort((left, right) => left.localeCompare(right, 'en'))

  if (unknownNames.length > 0) {
    throw new Error(`Unsupported DYSON environment variable: ${unknownNames.join(', ')}`)
  }
}

export interface AppConfig {
  nodeEnv: 'development' | 'test' | 'production'
  host: string
  port: number
  provider: 'demo' | 'windows'
  publicOrigin: string
  dataDir: string
  projectRoot: string | null
  scriptRoot: string
  statusTimeoutMs: number
  observabilityIntervalMs: number
  observabilityHistoryCapacity: number
  observabilityAlertCapacity: number
  observabilityAlertResolveAfterMissingSamples: number
  deploymentVersion: string | null
  consoleCursorSecret: string | null
  updateStagingEnabled: boolean
  updateAcquisitionEnabled: boolean
  updatePreparationEnabled: boolean
  updateActivationEnabled: boolean
  updateInboxRoot: string | null
  updateStagingRoot: string | null
  updateCompatibilityPolicyFile: string | null
  modImportEnabled: boolean
  modDeploymentEnabled: boolean
  modStagingRoot: string | null
  modPluginsRoot: string | null
  modSnapshotLimit: number
  saveMutationsEnabled: boolean
  saveRetentionMutationsEnabled: boolean
  saveRetentionPurgeMinimumHours: number
  configHistoryMutationsEnabled: boolean
  saveTransferEnabled: boolean
  saveTransferRoot: string | null
  lifecycleEnabled: boolean
  lifecycleTimeoutMs: number
  bridgeControlRoot: string | null
  bridgeSecretFile: string | null
  bridgePluginVersion: string
  playerSnapshotMaximumAgeMs: number
  playerHistoryCapacity: number
  playerHistoryRetentionHours: number
  serverTaskName: string
  stopTaskName: string
  gamePort: number
  adminPasswordHash: string | null
  operatorPasswordHash: string | null
  viewerPasswordHash: string | null
  sessionSecret: string
  developmentPassword: string
}

export function loadConfig(environment: NodeJS.ProcessEnv = process.env): AppConfig {
  assertNoUnknownDysonEnvironmentVariables(environment)
  const value = environmentSchema.parse(environment)
  const production = value.NODE_ENV === 'production'

  if (production && !value.DYSON_ADMIN_PASSWORD_HASH) {
    throw new Error('DYSON_ADMIN_PASSWORD_HASH is required in production')
  }
  if (production && (!value.DYSON_SESSION_SECRET || value.DYSON_SESSION_SECRET.length < 32)) {
    throw new Error('DYSON_SESSION_SECRET must contain at least 32 characters in production')
  }
  if (value.DYSON_PROVIDER === 'windows' && !value.DYSON_PROJECT_ROOT) {
    throw new Error('DYSON_PROJECT_ROOT is required for the Windows provider')
  }
  if (value.DYSON_LIFECYCLE_ENABLED === 'true') {
    if (value.DYSON_PROVIDER !== 'windows') {
      throw new Error('DYSON_LIFECYCLE_ENABLED requires the Windows provider')
    }
    if (!value.DYSON_BRIDGE_CONTROL_ROOT || !path.isAbsolute(value.DYSON_BRIDGE_CONTROL_ROOT)) {
      throw new Error('DYSON_BRIDGE_CONTROL_ROOT must be an absolute path when lifecycle execution is enabled')
    }
    if (!value.DYSON_BRIDGE_SECRET_FILE || !path.isAbsolute(value.DYSON_BRIDGE_SECRET_FILE)) {
      throw new Error('DYSON_BRIDGE_SECRET_FILE must be an absolute path when lifecycle execution is enabled')
    }
  }
  if ((value.DYSON_BRIDGE_CONTROL_ROOT === undefined) !== (value.DYSON_BRIDGE_SECRET_FILE === undefined)) {
    throw new Error('DYSON_BRIDGE_CONTROL_ROOT and DYSON_BRIDGE_SECRET_FILE must be configured together')
  }
  if (value.DYSON_BRIDGE_CONTROL_ROOT && !path.isAbsolute(value.DYSON_BRIDGE_CONTROL_ROOT)) {
    throw new Error('DYSON_BRIDGE_CONTROL_ROOT must be an absolute path')
  }
  if (value.DYSON_BRIDGE_SECRET_FILE && !path.isAbsolute(value.DYSON_BRIDGE_SECRET_FILE)) {
    throw new Error('DYSON_BRIDGE_SECRET_FILE must be an absolute path')
  }
  if (value.DYSON_UPDATE_STAGING_ENABLED === 'true') {
    if (!value.DYSON_UPDATE_INBOX_ROOT || !path.isAbsolute(value.DYSON_UPDATE_INBOX_ROOT)) {
      throw new Error('DYSON_UPDATE_INBOX_ROOT must be an absolute path when update staging is enabled')
    }
    if (!value.DYSON_UPDATE_STAGING_ROOT || !path.isAbsolute(value.DYSON_UPDATE_STAGING_ROOT)) {
      throw new Error('DYSON_UPDATE_STAGING_ROOT must be an absolute path when update staging is enabled')
    }
  }
  if (value.DYSON_UPDATE_ACQUISITION_ENABLED === 'true' &&
      value.DYSON_UPDATE_STAGING_ENABLED !== 'true') {
    throw new Error('DYSON_UPDATE_ACQUISITION_ENABLED requires offline update staging')
  }
  if (value.DYSON_UPDATE_PREPARATION_ENABLED === 'true' &&
      value.DYSON_UPDATE_STAGING_ENABLED !== 'true') {
    throw new Error('DYSON_UPDATE_PREPARATION_ENABLED requires offline update staging')
  }
  if (value.DYSON_UPDATE_INBOX_ROOT && !path.isAbsolute(value.DYSON_UPDATE_INBOX_ROOT)) {
    throw new Error('DYSON_UPDATE_INBOX_ROOT must be an absolute path')
  }
  if (value.DYSON_UPDATE_STAGING_ROOT && !path.isAbsolute(value.DYSON_UPDATE_STAGING_ROOT)) {
    throw new Error('DYSON_UPDATE_STAGING_ROOT must be an absolute path')
  }
  if (value.DYSON_UPDATE_COMPATIBILITY_POLICY_FILE && !path.isAbsolute(value.DYSON_UPDATE_COMPATIBILITY_POLICY_FILE)) {
    throw new Error('DYSON_UPDATE_COMPATIBILITY_POLICY_FILE must be an absolute path')
  }
  if (value.DYSON_UPDATE_ACTIVATION_ENABLED === 'true') {
    if (value.DYSON_PROVIDER !== 'windows') {
      throw new Error('DYSON_UPDATE_ACTIVATION_ENABLED requires the Windows provider')
    }
    if (value.DYSON_LIFECYCLE_ENABLED !== 'true') {
      throw new Error('DYSON_UPDATE_ACTIVATION_ENABLED requires lifecycle execution')
    }
    if (value.DYSON_UPDATE_STAGING_ENABLED !== 'true' || !value.DYSON_UPDATE_STAGING_ROOT) {
      throw new Error('DYSON_UPDATE_ACTIVATION_ENABLED requires offline update staging')
    }
    if (!value.DYSON_UPDATE_COMPATIBILITY_POLICY_FILE) {
      throw new Error('DYSON_UPDATE_ACTIVATION_ENABLED requires a trusted compatibility policy file')
    }
  }
  if ((value.DYSON_MOD_STAGING_ROOT === undefined) !== (value.DYSON_MOD_PLUGINS_ROOT === undefined)) {
    throw new Error('DYSON_MOD_STAGING_ROOT and DYSON_MOD_PLUGINS_ROOT must be configured together')
  }
  if (value.DYSON_MOD_STAGING_ROOT && !path.isAbsolute(value.DYSON_MOD_STAGING_ROOT)) {
    throw new Error('DYSON_MOD_STAGING_ROOT must be an absolute path')
  }
  if (value.DYSON_MOD_PLUGINS_ROOT && !path.isAbsolute(value.DYSON_MOD_PLUGINS_ROOT)) {
    throw new Error('DYSON_MOD_PLUGINS_ROOT must be an absolute path')
  }
  if (value.DYSON_MOD_PLUGINS_ROOT) {
    if (!value.DYSON_PROJECT_ROOT || !path.isAbsolute(value.DYSON_PROJECT_ROOT)) {
      throw new Error('DYSON_MOD_PLUGINS_ROOT requires an absolute DYSON_PROJECT_ROOT')
    }
    const expectedModPluginsRoot = path.resolve(
      value.DYSON_PROJECT_ROOT,
      'server',
      'BepInEx',
      'plugins',
      managedOrdinaryModsDirectoryName
    )
    if (path.resolve(value.DYSON_MOD_PLUGINS_ROOT).toLowerCase() !== expectedModPluginsRoot.toLowerCase()) {
      throw new Error(`DYSON_MOD_PLUGINS_ROOT must be the fixed ${managedOrdinaryModsDirectoryName} subtree`)
    }
  }
  if (value.DYSON_MOD_IMPORT_ENABLED === 'true') {
    if (value.DYSON_UPDATE_STAGING_ENABLED !== 'true' ||
        !value.DYSON_UPDATE_INBOX_ROOT || !value.DYSON_UPDATE_STAGING_ROOT) {
      throw new Error('DYSON_MOD_IMPORT_ENABLED requires offline update staging')
    }
    if (!value.DYSON_MOD_STAGING_ROOT) {
      throw new Error('DYSON_MOD_IMPORT_ENABLED requires the fixed mod staging root')
    }
  }
  if (value.DYSON_MOD_DEPLOYMENT_ENABLED === 'true') {
    if (value.DYSON_PROVIDER !== 'windows') {
      throw new Error('DYSON_MOD_DEPLOYMENT_ENABLED requires the Windows provider')
    }
    if (!value.DYSON_MOD_STAGING_ROOT || !value.DYSON_MOD_PLUGINS_ROOT) {
      throw new Error('DYSON_MOD_DEPLOYMENT_ENABLED requires both fixed mod roots')
    }
  }
  if (value.DYSON_SAVE_MUTATIONS_ENABLED === 'true' && value.DYSON_PROVIDER !== 'windows') {
    throw new Error('DYSON_SAVE_MUTATIONS_ENABLED requires the Windows provider')
  }
  if (value.DYSON_SAVE_RETENTION_MUTATIONS_ENABLED === 'true' && value.DYSON_PROVIDER !== 'windows') {
    throw new Error('DYSON_SAVE_RETENTION_MUTATIONS_ENABLED requires the Windows provider')
  }
  if (value.DYSON_CONFIG_HISTORY_MUTATIONS_ENABLED === 'true' && value.DYSON_PROVIDER !== 'windows') {
    throw new Error('DYSON_CONFIG_HISTORY_MUTATIONS_ENABLED requires the Windows provider')
  }
  if (value.DYSON_SAVE_TRANSFER_ROOT && !path.isAbsolute(value.DYSON_SAVE_TRANSFER_ROOT)) {
    throw new Error('DYSON_SAVE_TRANSFER_ROOT must be an absolute path')
  }
  if (value.DYSON_SAVE_TRANSFER_ENABLED === 'true') {
    if (value.DYSON_PROVIDER !== 'windows') {
      throw new Error('DYSON_SAVE_TRANSFER_ENABLED requires the Windows provider')
    }
    if (!value.DYSON_SAVE_TRANSFER_ROOT || !path.isAbsolute(value.DYSON_SAVE_TRANSFER_ROOT)) {
      throw new Error('DYSON_SAVE_TRANSFER_ROOT must be an absolute path when save transfer is enabled')
    }
  }

  const repositoryRoot = path.resolve(import.meta.dirname, '..', '..', '..')
  return {
    nodeEnv: value.NODE_ENV,
    host: value.DYSON_HOST,
    port: value.DYSON_PORT,
    provider: value.DYSON_PROVIDER,
    publicOrigin: value.DYSON_PUBLIC_ORIGIN.replace(/\/$/, ''),
    dataDir: path.resolve(value.DYSON_DATA_DIR ?? path.join(repositoryRoot, 'data')),
    projectRoot: value.DYSON_PROJECT_ROOT ? path.resolve(value.DYSON_PROJECT_ROOT) : null,
    scriptRoot: path.resolve(value.DYSON_SCRIPT_ROOT ?? path.join(repositoryRoot, 'scripts', 'windows')),
    statusTimeoutMs: value.DYSON_STATUS_TIMEOUT_MS,
    observabilityIntervalMs: value.DYSON_OBSERVABILITY_INTERVAL_MS ?? (production ? 15_000 : 0),
    observabilityHistoryCapacity: value.DYSON_OBSERVABILITY_HISTORY_CAPACITY,
    observabilityAlertCapacity: value.DYSON_OBSERVABILITY_ALERT_CAPACITY,
    observabilityAlertResolveAfterMissingSamples:
      value.DYSON_OBSERVABILITY_ALERT_RESOLVE_AFTER_MISSING_SAMPLES,
    deploymentVersion: value.DYSON_DEPLOYMENT_VERSION ?? null,
    consoleCursorSecret: value.DYSON_CONSOLE_CURSOR_SECRET ?? null,
    updateStagingEnabled: value.DYSON_UPDATE_STAGING_ENABLED === 'true',
    updateAcquisitionEnabled: value.DYSON_UPDATE_ACQUISITION_ENABLED === 'true',
    updatePreparationEnabled: value.DYSON_UPDATE_PREPARATION_ENABLED === 'true',
    updateActivationEnabled: value.DYSON_UPDATE_ACTIVATION_ENABLED === 'true',
    updateInboxRoot: value.DYSON_UPDATE_INBOX_ROOT ? path.resolve(value.DYSON_UPDATE_INBOX_ROOT) : null,
    updateStagingRoot: value.DYSON_UPDATE_STAGING_ROOT ? path.resolve(value.DYSON_UPDATE_STAGING_ROOT) : null,
    updateCompatibilityPolicyFile: value.DYSON_UPDATE_COMPATIBILITY_POLICY_FILE
      ? path.resolve(value.DYSON_UPDATE_COMPATIBILITY_POLICY_FILE)
      : null,
    modImportEnabled: value.DYSON_MOD_IMPORT_ENABLED === 'true',
    modDeploymentEnabled: value.DYSON_MOD_DEPLOYMENT_ENABLED === 'true',
    modStagingRoot: value.DYSON_MOD_STAGING_ROOT ? path.resolve(value.DYSON_MOD_STAGING_ROOT) : null,
    modPluginsRoot: value.DYSON_MOD_PLUGINS_ROOT ? path.resolve(value.DYSON_MOD_PLUGINS_ROOT) : null,
    modSnapshotLimit: value.DYSON_MOD_SNAPSHOT_LIMIT,
    saveMutationsEnabled: value.DYSON_SAVE_MUTATIONS_ENABLED === 'true',
    saveRetentionMutationsEnabled: value.DYSON_SAVE_RETENTION_MUTATIONS_ENABLED === 'true',
    saveRetentionPurgeMinimumHours: value.DYSON_SAVE_RETENTION_PURGE_MINIMUM_HOURS,
    configHistoryMutationsEnabled: value.DYSON_CONFIG_HISTORY_MUTATIONS_ENABLED === 'true',
    saveTransferEnabled: value.DYSON_SAVE_TRANSFER_ENABLED === 'true',
    saveTransferRoot: value.DYSON_SAVE_TRANSFER_ROOT ? path.resolve(value.DYSON_SAVE_TRANSFER_ROOT) : null,
    lifecycleEnabled: value.DYSON_LIFECYCLE_ENABLED === 'true',
    lifecycleTimeoutMs: value.DYSON_LIFECYCLE_TIMEOUT_MS,
    bridgeControlRoot: value.DYSON_BRIDGE_CONTROL_ROOT ? path.resolve(value.DYSON_BRIDGE_CONTROL_ROOT) : null,
    bridgeSecretFile: value.DYSON_BRIDGE_SECRET_FILE ? path.resolve(value.DYSON_BRIDGE_SECRET_FILE) : null,
    bridgePluginVersion: value.DYSON_BRIDGE_PLUGIN_VERSION,
    playerSnapshotMaximumAgeMs: value.DYSON_PLAYER_SNAPSHOT_MAX_AGE_MS,
    playerHistoryCapacity: value.DYSON_PLAYER_HISTORY_CAPACITY,
    playerHistoryRetentionHours: value.DYSON_PLAYER_HISTORY_RETENTION_HOURS,
    serverTaskName: value.DYSON_SERVER_TASK,
    stopTaskName: value.DYSON_STOP_TASK,
    gamePort: value.DYSON_GAME_PORT,
    adminPasswordHash: value.DYSON_ADMIN_PASSWORD_HASH ?? null,
    operatorPasswordHash: value.DYSON_OPERATOR_PASSWORD_HASH ?? null,
    viewerPasswordHash: value.DYSON_VIEWER_PASSWORD_HASH ?? null,
    sessionSecret: value.DYSON_SESSION_SECRET ?? 'development-only-session-secret-do-not-deploy',
    developmentPassword: value.DYSON_DEV_ADMIN_PASSWORD
  }
}
