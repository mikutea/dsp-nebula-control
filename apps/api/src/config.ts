import path from 'node:path'
import { isIP } from 'node:net'
import { z } from 'zod'
import { managedOrdinaryModsDirectoryName } from './update-pipeline/plugin-ownership.js'

const fixedServerTaskName = 'Dyson-Nebula-Server'
const fixedStopTaskName = 'Dyson-Nebula-Stop'

const environmentSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  DYSON_HOST: z.string().default('127.0.0.1'),
  DYSON_PORT: z.coerce.number().int().min(1).max(65535).default(13010),
  DYSON_PROVIDER: z.enum(['demo', 'windows']).default('demo'),
  DYSON_PUBLIC_ORIGIN: z.string().url().default('http://127.0.0.1:13010'),
  DYSON_DATA_DIR: z.string().optional(),
  DYSON_PROJECT_ROOT: z.string().optional(),
  DYSON_SCRIPT_ROOT: z.string().optional(),
  DYSON_RUNTIME_BOOTSTRAP_ROOT: z.string().optional(),
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
  DYSON_UPDATE_ACTIVATION_RECOVERY_ENABLED: z.enum(['true', 'false']).default('false'),
  DYSON_STEAM_MANUAL_HANDOFF_ENABLED: z.enum(['true', 'false']).default('false'),
  DYSON_NEBULA_PLUGIN_TRANSACTION_ENABLED: z.enum(['true', 'false']).default('false'),
  DYSON_NEBULA_PLUGIN_TRANSACTION_RECOVERY_ENABLED: z.enum(['true', 'false']).default('false'),
  DYSON_NEBULA_PLUGIN_JOB_BASE: z.string().optional(),
  DYSON_CUTOVER_ENABLED: z.enum(['true', 'false']).default('false'),
  DYSON_CUTOVER_RECOVERY_ENABLED: z.enum(['true', 'false']).default('false'),
  DYSON_CUTOVER_PROFILE_FILE: z.string().optional(),
  DYSON_CUTOVER_SERVICE_USER: z.string().min(3).max(128).regex(/^[^"\r\n]+$/).optional(),
  DYSON_CUTOVER_TASK_TRANSACTION_ROOT: z.string().optional(),
  DYSON_QUALIFIED_CLIENT_PROFILE_ENABLED: z.enum(['true', 'false']).default('false'),
  DYSON_CLIENT_QUALIFICATION_EVIDENCE_ROOT: z.string().optional(),
  DYSON_CLIENT_QUALIFICATION_BUILD_HARVEST_ROOT_A: z.string().optional(),
  DYSON_CLIENT_QUALIFICATION_BUILD_HARVEST_ROOT_B: z.string().optional(),
  DYSON_CLIENT_QUALIFICATION_KEY_RING_ROOT: z.string().optional(),
  DYSON_CLIENT_QUALIFICATION_REPLAY_ROOT: z.string().optional(),
  DYSON_QUALIFIED_CLIENT_ISSUE_ROOT: z.string().optional(),
  DYSON_CLIENT_QUALIFICATION_AUTHORITY: z.string().min(4).max(253).optional(),
  DYSON_UPDATE_INBOX_ROOT: z.string().optional(),
  DYSON_UPDATE_STAGING_ROOT: z.string().optional(),
  DYSON_UPDATE_COMPATIBILITY_POLICY_FILE: z.string().optional(),
  DYSON_MOD_IMPORT_ENABLED: z.enum(['true', 'false']).default('false'),
  DYSON_MOD_DEPLOYMENT_ENABLED: z.enum(['true', 'false']).default('false'),
  DYSON_MOD_DEPLOYMENT_RECOVERY_ENABLED: z.enum(['true', 'false']).default('false'),
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
  DYSON_STARTUP_TIMEOUT_MS: z.coerce.number().int().min(10_000).max(900_000).default(600_000),
  DYSON_LIFECYCLE_BROKER_PROFILE_FILE: z.string().optional(),
  DYSON_RUNTIME_SERVICE_USER: z.string().min(3).max(128).regex(/^[^"\r\n]+$/).optional(),
  DYSON_BRIDGE_CONTROL_ROOT: z.string().optional(),
  DYSON_BRIDGE_SECRET_FILE: z.string().optional(),
  DYSON_BRIDGE_PLUGIN_VERSION: z.string().regex(/^\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]{1,32})?$/).default('0.1.0-rc.22'),
  DYSON_PLAYER_SNAPSHOT_MAX_AGE_MS: z.coerce.number().int().min(2_000).max(120_000).default(10_000),
  DYSON_PLAYER_NOTICE_MUTATIONS_ENABLED: z.enum(['true', 'false']).default('false'),
  DYSON_PLAYER_HISTORY_CAPACITY: z.coerce.number().int().min(1).max(2_048).default(512),
  DYSON_PLAYER_HISTORY_RETENTION_HOURS: z.coerce.number().int().min(1).max(720).default(168),
  DYSON_SERVER_TASK: z.string().regex(/^[\p{L}\p{N}_. -]{1,128}$/u).default(fixedServerTaskName),
  DYSON_STOP_TASK: z.string().regex(/^[\p{L}\p{N}_. -]{1,128}$/u).default(fixedStopTaskName),
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
  runtimeBootstrapRoot: string | null
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
  updateActivationRecoveryEnabled: boolean
  steamManualHandoffEnabled: boolean
  nebulaPluginTransactionEnabled: boolean
  nebulaPluginTransactionRecoveryEnabled: boolean
  nebulaPluginJobBase: string | null
  nebulaPluginGameRoot: string | null
  cutoverEnabled: boolean
  cutoverRecoveryEnabled: boolean
  cutoverProfileFile: string | null
  cutoverServiceUser: string | null
  cutoverTaskTransactionRoot: string | null
  cutoverDataDirectory: string
  qualifiedClientProfileEnabled: boolean
  clientQualificationEvidenceRoot: string | null
  clientQualificationBuildHarvestRootA: string | null
  clientQualificationBuildHarvestRootB: string | null
  clientQualificationKeyRingRoot: string | null
  clientQualificationReplayRoot: string | null
  qualifiedClientIssueRoot: string | null
  clientQualificationAuthority: string | null
  updateInboxRoot: string | null
  updateStagingRoot: string | null
  updateCompatibilityPolicyFile: string | null
  modImportEnabled: boolean
  modDeploymentEnabled: boolean
  modDeploymentRecoveryEnabled: boolean
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
  startupTimeoutMs: number
  lifecycleBrokerProfileFile: string | null
  runtimeServiceUser: string | null
  bridgeControlRoot: string | null
  bridgeSecretFile: string | null
  bridgePluginVersion: string
  playerSnapshotMaximumAgeMs: number
  playerNoticeMutationsEnabled: boolean
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
    if (!value.DYSON_RUNTIME_BOOTSTRAP_ROOT || !path.isAbsolute(value.DYSON_RUNTIME_BOOTSTRAP_ROOT)) {
      throw new Error('DYSON_RUNTIME_BOOTSTRAP_ROOT must be an absolute path when lifecycle execution is enabled')
    }
    if (!value.DYSON_LIFECYCLE_BROKER_PROFILE_FILE ||
        !path.isAbsolute(value.DYSON_LIFECYCLE_BROKER_PROFILE_FILE)) {
      throw new Error('DYSON_LIFECYCLE_BROKER_PROFILE_FILE must be an absolute path when lifecycle execution is enabled')
    }
    if (!value.DYSON_RUNTIME_SERVICE_USER) {
      throw new Error('DYSON_RUNTIME_SERVICE_USER is required when lifecycle execution is enabled')
    }
    if (value.DYSON_SERVER_TASK !== fixedServerTaskName) {
      throw new Error(`DYSON_SERVER_TASK must be the fixed ${fixedServerTaskName} task when lifecycle execution is enabled`)
    }
    if (value.DYSON_STOP_TASK !== fixedStopTaskName) {
      throw new Error(`DYSON_STOP_TASK must be the fixed ${fixedStopTaskName} task when lifecycle execution is enabled`)
    }
  }
  if (value.DYSON_RUNTIME_BOOTSTRAP_ROOT && !path.isAbsolute(value.DYSON_RUNTIME_BOOTSTRAP_ROOT)) {
    throw new Error('DYSON_RUNTIME_BOOTSTRAP_ROOT must be an absolute path')
  }
  if (value.DYSON_LIFECYCLE_BROKER_PROFILE_FILE &&
      !path.isAbsolute(value.DYSON_LIFECYCLE_BROKER_PROFILE_FILE)) {
    throw new Error('DYSON_LIFECYCLE_BROKER_PROFILE_FILE must be an absolute path')
  }
  if ((value.DYSON_BRIDGE_CONTROL_ROOT === undefined) !== (value.DYSON_BRIDGE_SECRET_FILE === undefined)) {
    throw new Error('DYSON_BRIDGE_CONTROL_ROOT and DYSON_BRIDGE_SECRET_FILE must be configured together')
  }
  if (value.DYSON_PLAYER_NOTICE_MUTATIONS_ENABLED === 'true') {
    if (value.DYSON_PROVIDER !== 'windows') {
      throw new Error('DYSON_PLAYER_NOTICE_MUTATIONS_ENABLED requires the Windows provider')
    }
    if (!value.DYSON_BRIDGE_CONTROL_ROOT || !value.DYSON_BRIDGE_SECRET_FILE) {
      throw new Error('DYSON_PLAYER_NOTICE_MUTATIONS_ENABLED requires the fixed Bridge control root and secret')
    }
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
  if (value.DYSON_UPDATE_ACTIVATION_RECOVERY_ENABLED === 'true') {
    if (value.DYSON_PROVIDER !== 'windows') {
      throw new Error('DYSON_UPDATE_ACTIVATION_RECOVERY_ENABLED requires the Windows provider')
    }
    if (value.DYSON_LIFECYCLE_ENABLED !== 'true') {
      throw new Error('DYSON_UPDATE_ACTIVATION_RECOVERY_ENABLED requires lifecycle execution')
    }
    if (value.DYSON_UPDATE_STAGING_ENABLED !== 'true' || !value.DYSON_UPDATE_STAGING_ROOT) {
      throw new Error('DYSON_UPDATE_ACTIVATION_RECOVERY_ENABLED requires offline update staging')
    }
    if (!value.DYSON_UPDATE_COMPATIBILITY_POLICY_FILE) {
      throw new Error('DYSON_UPDATE_ACTIVATION_RECOVERY_ENABLED requires a trusted compatibility policy file')
    }
  }
  if (value.DYSON_STEAM_MANUAL_HANDOFF_ENABLED === 'true') {
    if (value.DYSON_PROVIDER !== 'windows') {
      throw new Error('DYSON_STEAM_MANUAL_HANDOFF_ENABLED requires the Windows provider')
    }
    if (value.DYSON_LIFECYCLE_ENABLED !== 'true') {
      throw new Error('DYSON_STEAM_MANUAL_HANDOFF_ENABLED requires lifecycle execution')
    }
    if (!value.DYSON_UPDATE_COMPATIBILITY_POLICY_FILE) {
      throw new Error('DYSON_STEAM_MANUAL_HANDOFF_ENABLED requires a trusted compatibility policy file')
    }
  }
  if (value.DYSON_NEBULA_PLUGIN_JOB_BASE &&
      !isAbsoluteNonRootPath(value.DYSON_NEBULA_PLUGIN_JOB_BASE)) {
    throw new Error('DYSON_NEBULA_PLUGIN_JOB_BASE must be an absolute path below a filesystem root')
  }
  if (value.DYSON_NEBULA_PLUGIN_JOB_BASE ||
      value.DYSON_NEBULA_PLUGIN_TRANSACTION_ENABLED === 'true' ||
      value.DYSON_NEBULA_PLUGIN_TRANSACTION_RECOVERY_ENABLED === 'true') {
    if (value.DYSON_PROVIDER !== 'windows') {
      throw new Error('Nebula plugin transaction requires the Windows provider')
    }
    if (!value.DYSON_PROJECT_ROOT || !path.isAbsolute(value.DYSON_PROJECT_ROOT)) {
      throw new Error('Nebula plugin transaction requires an absolute DYSON_PROJECT_ROOT')
    }
    if (!value.DYSON_DATA_DIR || !path.isAbsolute(value.DYSON_DATA_DIR)) {
      throw new Error('Nebula plugin transaction requires an absolute DYSON_DATA_DIR')
    }
    if (!value.DYSON_SCRIPT_ROOT || !path.isAbsolute(value.DYSON_SCRIPT_ROOT)) {
      throw new Error('Nebula plugin transaction requires an absolute DYSON_SCRIPT_ROOT')
    }
    if (!value.DYSON_NEBULA_PLUGIN_JOB_BASE) {
      throw new Error('Nebula plugin transaction requires DYSON_NEBULA_PLUGIN_JOB_BASE')
    }
    const nebulaGameRoot = path.resolve(value.DYSON_PROJECT_ROOT, 'server')
    if (!isAbsoluteNonRootPath(nebulaGameRoot) || !isAbsoluteNonRootPath(value.DYSON_DATA_DIR)) {
      throw new Error('Nebula plugin transaction fixed roots must be absolute non-root paths')
    }
    for (const [left, right] of [
      [value.DYSON_NEBULA_PLUGIN_JOB_BASE, value.DYSON_PROJECT_ROOT],
      [value.DYSON_NEBULA_PLUGIN_JOB_BASE, nebulaGameRoot],
      [value.DYSON_NEBULA_PLUGIN_JOB_BASE, value.DYSON_DATA_DIR],
      [nebulaGameRoot, value.DYSON_DATA_DIR]
    ] as const) {
      if (!pathsAreDisjoint(left, right)) {
        throw new Error('Nebula plugin transaction fixed roots must be disjoint')
      }
    }
  }
  if (value.DYSON_CUTOVER_PROFILE_FILE && !path.isAbsolute(value.DYSON_CUTOVER_PROFILE_FILE)) {
    throw new Error('DYSON_CUTOVER_PROFILE_FILE must be an absolute path')
  }
  if (value.DYSON_CUTOVER_TASK_TRANSACTION_ROOT &&
      !path.isAbsolute(value.DYSON_CUTOVER_TASK_TRANSACTION_ROOT)) {
    throw new Error('DYSON_CUTOVER_TASK_TRANSACTION_ROOT must be an absolute path')
  }
  if (value.DYSON_CUTOVER_ENABLED === 'true' || value.DYSON_CUTOVER_RECOVERY_ENABLED === 'true') {
    if (value.DYSON_PROVIDER !== 'windows') {
      throw new Error('Dyson cutover requires the Windows provider')
    }
    if (value.DYSON_LIFECYCLE_ENABLED !== 'true') {
      throw new Error('Dyson cutover requires lifecycle execution')
    }
    if (!value.DYSON_CUTOVER_PROFILE_FILE) {
      throw new Error('Dyson cutover requires DYSON_CUTOVER_PROFILE_FILE')
    }
    if (!value.DYSON_CUTOVER_SERVICE_USER) {
      throw new Error('Dyson cutover requires DYSON_CUTOVER_SERVICE_USER')
    }
    if (!value.DYSON_CUTOVER_TASK_TRANSACTION_ROOT) {
      throw new Error('Dyson cutover requires DYSON_CUTOVER_TASK_TRANSACTION_ROOT')
    }
    if (!value.DYSON_DATA_DIR || !path.isAbsolute(value.DYSON_DATA_DIR)) {
      throw new Error('Dyson cutover requires an absolute DYSON_DATA_DIR')
    }
  }
  const qualifiedClientValues = [
    value.DYSON_CLIENT_QUALIFICATION_EVIDENCE_ROOT,
    value.DYSON_CLIENT_QUALIFICATION_BUILD_HARVEST_ROOT_A,
    value.DYSON_CLIENT_QUALIFICATION_BUILD_HARVEST_ROOT_B,
    value.DYSON_CLIENT_QUALIFICATION_KEY_RING_ROOT,
    value.DYSON_CLIENT_QUALIFICATION_REPLAY_ROOT,
    value.DYSON_QUALIFIED_CLIENT_ISSUE_ROOT,
    value.DYSON_CLIENT_QUALIFICATION_AUTHORITY
  ]
  if (value.DYSON_QUALIFIED_CLIENT_PROFILE_ENABLED === 'true' ||
      qualifiedClientValues.some((item) => item !== undefined)) {
    if (value.DYSON_PROVIDER !== 'windows') {
      throw new Error('Qualified client profile issuance requires the Windows provider')
    }
    if (qualifiedClientValues.some((item) => item === undefined)) {
      throw new Error('Qualified client profile issuance requires every protected root and authority')
    }
    const fixedRoots = qualifiedClientValues.slice(0, 6) as string[]
    if (fixedRoots.some((item) => !isAbsoluteNonRootPath(item))) {
      throw new Error('Qualified client profile roots must be absolute paths below a filesystem root')
    }
    for (let left = 0; left < fixedRoots.length; left += 1) {
      for (let right = left + 1; right < fixedRoots.length; right += 1) {
        if (!pathsAreDisjoint(fixedRoots[left]!, fixedRoots[right]!)) {
          throw new Error('Qualified client profile roots must be pairwise disjoint')
        }
      }
    }
    if (!isCanonicalPublicAuthority(value.DYSON_CLIENT_QUALIFICATION_AUTHORITY!)) {
      throw new Error('DYSON_CLIENT_QUALIFICATION_AUTHORITY must be a canonical public DNS hostname')
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
    if (value.DYSON_LIFECYCLE_ENABLED !== 'true') {
      throw new Error('DYSON_MOD_DEPLOYMENT_ENABLED requires lifecycle execution')
    }
  }
  if (value.DYSON_MOD_DEPLOYMENT_RECOVERY_ENABLED === 'true') {
    if (value.DYSON_PROVIDER !== 'windows') {
      throw new Error('DYSON_MOD_DEPLOYMENT_RECOVERY_ENABLED requires the Windows provider')
    }
    if (!value.DYSON_MOD_STAGING_ROOT || !value.DYSON_MOD_PLUGINS_ROOT) {
      throw new Error('DYSON_MOD_DEPLOYMENT_RECOVERY_ENABLED requires both fixed mod roots')
    }
    if (value.DYSON_LIFECYCLE_ENABLED !== 'true') {
      throw new Error('DYSON_MOD_DEPLOYMENT_RECOVERY_ENABLED requires lifecycle execution')
    }
  }
  if (value.DYSON_SAVE_MUTATIONS_ENABLED === 'true' && value.DYSON_PROVIDER !== 'windows') {
    throw new Error('DYSON_SAVE_MUTATIONS_ENABLED requires the Windows provider')
  }
  if (value.DYSON_SAVE_MUTATIONS_ENABLED === 'true' && value.DYSON_LIFECYCLE_ENABLED !== 'true') {
    throw new Error('DYSON_SAVE_MUTATIONS_ENABLED requires lifecycle execution')
  }
  if (value.DYSON_SAVE_RETENTION_MUTATIONS_ENABLED === 'true' && value.DYSON_PROVIDER !== 'windows') {
    throw new Error('DYSON_SAVE_RETENTION_MUTATIONS_ENABLED requires the Windows provider')
  }
  if (value.DYSON_CONFIG_HISTORY_MUTATIONS_ENABLED === 'true' && value.DYSON_PROVIDER !== 'windows') {
    throw new Error('DYSON_CONFIG_HISTORY_MUTATIONS_ENABLED requires the Windows provider')
  }
  if (value.DYSON_CONFIG_HISTORY_MUTATIONS_ENABLED === 'true' && value.DYSON_LIFECYCLE_ENABLED !== 'true') {
    throw new Error('DYSON_CONFIG_HISTORY_MUTATIONS_ENABLED requires lifecycle execution')
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
    runtimeBootstrapRoot: value.DYSON_RUNTIME_BOOTSTRAP_ROOT
      ? path.resolve(value.DYSON_RUNTIME_BOOTSTRAP_ROOT)
      : null,
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
    updateActivationRecoveryEnabled: value.DYSON_UPDATE_ACTIVATION_RECOVERY_ENABLED === 'true',
    steamManualHandoffEnabled: value.DYSON_STEAM_MANUAL_HANDOFF_ENABLED === 'true',
    nebulaPluginTransactionEnabled: value.DYSON_NEBULA_PLUGIN_TRANSACTION_ENABLED === 'true',
    nebulaPluginTransactionRecoveryEnabled:
      value.DYSON_NEBULA_PLUGIN_TRANSACTION_RECOVERY_ENABLED === 'true',
    nebulaPluginJobBase: value.DYSON_NEBULA_PLUGIN_JOB_BASE
      ? path.resolve(value.DYSON_NEBULA_PLUGIN_JOB_BASE)
      : null,
    nebulaPluginGameRoot: value.DYSON_PROJECT_ROOT
      ? path.resolve(value.DYSON_PROJECT_ROOT, 'server')
      : null,
    cutoverEnabled: value.DYSON_CUTOVER_ENABLED === 'true',
    cutoverRecoveryEnabled: value.DYSON_CUTOVER_RECOVERY_ENABLED === 'true',
    cutoverProfileFile: value.DYSON_CUTOVER_PROFILE_FILE
      ? path.resolve(value.DYSON_CUTOVER_PROFILE_FILE)
      : null,
    cutoverServiceUser: value.DYSON_CUTOVER_SERVICE_USER ?? null,
    cutoverTaskTransactionRoot: value.DYSON_CUTOVER_TASK_TRANSACTION_ROOT
      ? path.resolve(value.DYSON_CUTOVER_TASK_TRANSACTION_ROOT)
      : null,
    cutoverDataDirectory: path.resolve(
      value.DYSON_DATA_DIR ?? path.join(repositoryRoot, 'data'),
      'cutover'
    ),
    qualifiedClientProfileEnabled: value.DYSON_QUALIFIED_CLIENT_PROFILE_ENABLED === 'true',
    clientQualificationEvidenceRoot: value.DYSON_CLIENT_QUALIFICATION_EVIDENCE_ROOT
      ? path.resolve(value.DYSON_CLIENT_QUALIFICATION_EVIDENCE_ROOT)
      : null,
    clientQualificationBuildHarvestRootA: value.DYSON_CLIENT_QUALIFICATION_BUILD_HARVEST_ROOT_A
      ? path.resolve(value.DYSON_CLIENT_QUALIFICATION_BUILD_HARVEST_ROOT_A)
      : null,
    clientQualificationBuildHarvestRootB: value.DYSON_CLIENT_QUALIFICATION_BUILD_HARVEST_ROOT_B
      ? path.resolve(value.DYSON_CLIENT_QUALIFICATION_BUILD_HARVEST_ROOT_B)
      : null,
    clientQualificationKeyRingRoot: value.DYSON_CLIENT_QUALIFICATION_KEY_RING_ROOT
      ? path.resolve(value.DYSON_CLIENT_QUALIFICATION_KEY_RING_ROOT)
      : null,
    clientQualificationReplayRoot: value.DYSON_CLIENT_QUALIFICATION_REPLAY_ROOT
      ? path.resolve(value.DYSON_CLIENT_QUALIFICATION_REPLAY_ROOT)
      : null,
    qualifiedClientIssueRoot: value.DYSON_QUALIFIED_CLIENT_ISSUE_ROOT
      ? path.resolve(value.DYSON_QUALIFIED_CLIENT_ISSUE_ROOT)
      : null,
    clientQualificationAuthority: value.DYSON_CLIENT_QUALIFICATION_AUTHORITY ?? null,
    updateInboxRoot: value.DYSON_UPDATE_INBOX_ROOT ? path.resolve(value.DYSON_UPDATE_INBOX_ROOT) : null,
    updateStagingRoot: value.DYSON_UPDATE_STAGING_ROOT ? path.resolve(value.DYSON_UPDATE_STAGING_ROOT) : null,
    updateCompatibilityPolicyFile: value.DYSON_UPDATE_COMPATIBILITY_POLICY_FILE
      ? path.resolve(value.DYSON_UPDATE_COMPATIBILITY_POLICY_FILE)
      : null,
    modImportEnabled: value.DYSON_MOD_IMPORT_ENABLED === 'true',
    modDeploymentEnabled: value.DYSON_MOD_DEPLOYMENT_ENABLED === 'true',
    modDeploymentRecoveryEnabled: value.DYSON_MOD_DEPLOYMENT_RECOVERY_ENABLED === 'true',
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
    startupTimeoutMs: value.DYSON_STARTUP_TIMEOUT_MS,
    lifecycleBrokerProfileFile: value.DYSON_LIFECYCLE_BROKER_PROFILE_FILE
      ? path.resolve(value.DYSON_LIFECYCLE_BROKER_PROFILE_FILE)
      : null,
    runtimeServiceUser: value.DYSON_RUNTIME_SERVICE_USER ?? null,
    bridgeControlRoot: value.DYSON_BRIDGE_CONTROL_ROOT ? path.resolve(value.DYSON_BRIDGE_CONTROL_ROOT) : null,
    bridgeSecretFile: value.DYSON_BRIDGE_SECRET_FILE ? path.resolve(value.DYSON_BRIDGE_SECRET_FILE) : null,
    bridgePluginVersion: value.DYSON_BRIDGE_PLUGIN_VERSION,
    playerSnapshotMaximumAgeMs: value.DYSON_PLAYER_SNAPSHOT_MAX_AGE_MS,
    playerNoticeMutationsEnabled: value.DYSON_PLAYER_NOTICE_MUTATIONS_ENABLED === 'true',
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

function pathsAreDisjoint(left: string, right: string): boolean {
  return !pathContains(left, right) && !pathContains(right, left)
}

function isAbsoluteNonRootPath(value: string): boolean {
  if (!path.isAbsolute(value)) return false
  const resolved = path.resolve(value)
  return resolved !== path.parse(resolved).root
}

function pathContains(parent: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(parent), path.resolve(candidate))
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))
}

function isCanonicalPublicAuthority(value: string): boolean {
  return isIP(value) === 0 && value === value.toLowerCase() && value !== 'localhost' &&
    !value.endsWith('.') && !value.includes('..') &&
    /^(?=.{4,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])$/.test(value)
}
