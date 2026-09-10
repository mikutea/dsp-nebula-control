import { describe, expect, it } from 'vitest'
import { loadConfig } from './config.js'

const lifecycleBrokerEnvironment = {
  DYSON_LIFECYCLE_BROKER_PROFILE_FILE:
    'C:\\ProgramData\\DysonControl\\data\\lifecycle-broker\\broker-profile.json',
  DYSON_RUNTIME_SERVICE_USER: '.\\DysonServer'
} as const
const lifecycleExecutionEnvironment = {
  DYSON_LIFECYCLE_ENABLED: 'true',
  DYSON_BRIDGE_CONTROL_ROOT: 'C:\\Fictional\\Dyson\\run\\control-bridge',
  DYSON_BRIDGE_SECRET_FILE: 'C:\\ProgramData\\DysonControl\\bridge.secret',
  DYSON_RUNTIME_BOOTSTRAP_ROOT: 'C:\\Program Files\\DysonControl\\bootstrap',
  ...lifecycleBrokerEnvironment
} as const
const invalidConsoleCursorSecret = ['too', 'short'].join('-')

describe('production configuration', () => {
  it('fails closed on misspelled DYSON variables while ignoring unrelated host variables', () => {
    expect(() => loadConfig({
      NODE_ENV: 'test',
      DYSON_LIFECYLE_ENABLED: 'true'
    })).toThrow(/Unsupported DYSON environment variable: DYSON_LIFECYLE_ENABLED/)

    expect(loadConfig({
      NODE_ENV: 'test',
      SYSTEMROOT: 'C:\\Windows',
      PATH: 'C:\\Fictional\\bin'
    })).toMatchObject({ nodeEnv: 'test', lifecycleEnabled: false })
  })

  it('fails closed without production authentication material', () => {
    expect(() => loadConfig({ NODE_ENV: 'production' })).toThrow(/DYSON_ADMIN_PASSWORD_HASH/)
  })

  it('leaves least-privilege accounts disabled unless their hashes are explicitly configured', () => {
    expect(loadConfig({ NODE_ENV: 'test' })).toMatchObject({
      operatorPasswordHash: null,
      viewerPasswordHash: null
    })
    expect(loadConfig({
      NODE_ENV: 'test',
      DYSON_OPERATOR_PASSWORD_HASH: 'scrypt$operator-fixture',
      DYSON_VIEWER_PASSWORD_HASH: 'scrypt$viewer-fixture'
    })).toMatchObject({
      operatorPasswordHash: 'scrypt$operator-fixture',
      viewerPasswordHash: 'scrypt$viewer-fixture'
    })
  })

  it('requires a project root for the Windows provider', () => {
    expect(() => loadConfig({ NODE_ENV: 'test', DYSON_PROVIDER: 'windows' })).toThrow(/DYSON_PROJECT_ROOT/)
  })

  it('allows private Bridge storage outside the game share without enabling mutations', () => {
    const config = loadConfig({
      NODE_ENV: 'test',
      DYSON_PROVIDER: 'windows',
      DYSON_PROJECT_ROOT: 'Y:\\Fictional\\Game',
      DYSON_BRIDGE_CONTROL_ROOT: 'C:\\ProgramData\\ExampleBridge\\control',
      DYSON_BRIDGE_SECRET_FILE: 'C:\\ProgramData\\ExampleBridge\\bridge.secret'
    })
    expect(config.projectRoot).toBe('Y:\\Fictional\\Game')
    expect(config.bridgeControlRoot).toBe('C:\\ProgramData\\ExampleBridge\\control')
    expect(config.bridgeSecretFile).toBe('C:\\ProgramData\\ExampleBridge\\bridge.secret')
    expect(config.lifecycleEnabled).toBe(false)
  })

  it('accepts only a bounded deployment release identifier', () => {
    expect(loadConfig({
      NODE_ENV: 'test', DYSON_DEPLOYMENT_VERSION: 'v0.1.0-rc.19+fixture'
    }).deploymentVersion).toBe('v0.1.0-rc.19+fixture')
    expect(() => loadConfig({
      NODE_ENV: 'test', DYSON_DEPLOYMENT_VERSION: '../untrusted release'
    })).toThrow()
  })

  it('defaults the expected Bridge heartbeat to the full repository release version', () => {
    expect(loadConfig({ NODE_ENV: 'test' }).bridgePluginVersion).toBe('0.1.0-rc.19')
  })

  it('keeps player notices disabled and validates the closed mutation gate', () => {
    expect(loadConfig({ NODE_ENV: 'test' }).playerNoticeMutationsEnabled).toBe(false)
    expect(() => loadConfig({
      NODE_ENV: 'test', DYSON_PLAYER_NOTICE_MUTATIONS_ENABLED: 'true'
    })).toThrow(/requires the Windows provider/)
    expect(() => loadConfig({
      NODE_ENV: 'test', DYSON_PLAYER_NOTICE_MUTATIONS_ENABLED: 'enabled'
    })).toThrow()
  })

  it('keeps the console disabled without its independent signed-cursor secret', () => {
    expect(loadConfig({ NODE_ENV: 'test' }).consoleCursorSecret).toBeNull()
    expect(() => loadConfig({
      NODE_ENV: 'test', DYSON_CONSOLE_CURSOR_SECRET: invalidConsoleCursorSecret
    })).toThrow()
    expect(loadConfig({
      NODE_ENV: 'test', DYSON_CONSOLE_CURSOR_SECRET: 'console-fixture-secret-at-least-32-bytes'
    }).consoleCursorSecret).toBe('console-fixture-secret-at-least-32-bytes')
  })

  it('keeps background telemetry off in tests and validates an explicit bounded cadence', () => {
    expect(loadConfig({ NODE_ENV: 'test' })).toMatchObject({
      observabilityIntervalMs: 0,
      observabilityHistoryCapacity: 2_048,
      observabilityAlertCapacity: 256,
      observabilityAlertResolveAfterMissingSamples: 3
    })
    expect(loadConfig({
      NODE_ENV: 'test', DYSON_OBSERVABILITY_INTERVAL_MS: '15000'
    }).observabilityIntervalMs).toBe(15_000)
    expect(loadConfig({
      NODE_ENV: 'production',
      DYSON_ADMIN_PASSWORD_HASH: 'scrypt$fictional-production-hash',
      DYSON_SESSION_SECRET: 'fictional-production-session-secret-32-bytes'
    }).observabilityIntervalMs).toBe(15_000)
    expect(() => loadConfig({
      NODE_ENV: 'test', DYSON_OBSERVABILITY_INTERVAL_MS: '999'
    })).toThrow()
    expect(() => loadConfig({
      NODE_ENV: 'test', DYSON_OBSERVABILITY_INTERVAL_MS: '300001'
    })).toThrow()
    expect(loadConfig({
      NODE_ENV: 'test', DYSON_OBSERVABILITY_HISTORY_CAPACITY: '4096'
    }).observabilityHistoryCapacity).toBe(4_096)
    expect(() => loadConfig({
      NODE_ENV: 'test', DYSON_OBSERVABILITY_HISTORY_CAPACITY: '359'
    })).toThrow()
    expect(() => loadConfig({
      NODE_ENV: 'test', DYSON_OBSERVABILITY_HISTORY_CAPACITY: '4097'
    })).toThrow()
    expect(loadConfig({
      NODE_ENV: 'test', DYSON_OBSERVABILITY_ALERT_CAPACITY: '4096',
      DYSON_OBSERVABILITY_ALERT_RESOLVE_AFTER_MISSING_SAMPLES: '1000'
    })).toMatchObject({
      observabilityAlertCapacity: 4_096,
      observabilityAlertResolveAfterMissingSamples: 1_000
    })
    expect(() => loadConfig({
      NODE_ENV: 'test', DYSON_OBSERVABILITY_ALERT_CAPACITY: '0'
    })).toThrow()
    expect(() => loadConfig({
      NODE_ENV: 'test', DYSON_OBSERVABILITY_ALERT_RESOLVE_AFTER_MISSING_SAMPLES: '1001'
    })).toThrow()
  })

  it('keeps offline update staging separately disabled and requires two fixed roots', () => {
    expect(loadConfig({ NODE_ENV: 'test' })).toMatchObject({
      updateStagingEnabled: false,
      updateAcquisitionEnabled: false,
      updatePreparationEnabled: false,
      updateActivationEnabled: false,
      updateActivationRecoveryEnabled: false
    })
    expect(() => loadConfig({
      NODE_ENV: 'test', DYSON_UPDATE_STAGING_ENABLED: 'true',
      DYSON_UPDATE_INBOX_ROOT: 'C:\\Fictional\\inbox'
    })).toThrow(/DYSON_UPDATE_STAGING_ROOT/)
    expect(loadConfig({
      NODE_ENV: 'test', DYSON_UPDATE_STAGING_ENABLED: 'true',
      DYSON_UPDATE_INBOX_ROOT: 'C:\\Fictional\\inbox',
      DYSON_UPDATE_STAGING_ROOT: 'D:\\Fictional\\staging'
    })).toMatchObject({ updateStagingEnabled: true })
    expect(() => loadConfig({
      NODE_ENV: 'test', DYSON_UPDATE_ACQUISITION_ENABLED: 'true'
    })).toThrow(/requires offline update staging/)
    expect(() => loadConfig({
      NODE_ENV: 'test', DYSON_UPDATE_PREPARATION_ENABLED: 'true'
    })).toThrow(/requires offline update staging/)
    expect(loadConfig({
      NODE_ENV: 'test', DYSON_UPDATE_STAGING_ENABLED: 'true',
      DYSON_UPDATE_ACQUISITION_ENABLED: 'true',
      DYSON_UPDATE_PREPARATION_ENABLED: 'true',
      DYSON_UPDATE_INBOX_ROOT: 'C:\\Fictional\\inbox',
      DYSON_UPDATE_STAGING_ROOT: 'D:\\Fictional\\staging'
    })).toMatchObject({
      updateStagingEnabled: true,
      updateAcquisitionEnabled: true,
      updatePreparationEnabled: true
    })
  })

  it('keeps component activation disabled and requires the complete Windows lifecycle and staging chain', () => {
    expect(() => loadConfig({
      NODE_ENV: 'test', DYSON_UPDATE_ACTIVATION_ENABLED: 'true'
    })).toThrow(/requires the Windows provider/)
    expect(() => loadConfig({
      NODE_ENV: 'test', DYSON_PROVIDER: 'windows', DYSON_PROJECT_ROOT: 'C:\\Fictional\\Dyson',
      DYSON_UPDATE_ACTIVATION_ENABLED: 'true'
    })).toThrow(/requires lifecycle execution/)
    expect(() => loadConfig({
      NODE_ENV: 'test', DYSON_PROVIDER: 'windows', DYSON_PROJECT_ROOT: 'C:\\Fictional\\Dyson',
      DYSON_UPDATE_ACTIVATION_ENABLED: 'true', DYSON_LIFECYCLE_ENABLED: 'true',
      DYSON_BRIDGE_CONTROL_ROOT: 'C:\\Fictional\\Dyson\\run\\control-bridge',
      DYSON_BRIDGE_SECRET_FILE: 'C:\\ProgramData\\DysonControl\\bridge.secret',
      DYSON_RUNTIME_BOOTSTRAP_ROOT: 'C:\\Program Files\\DysonControl\\bootstrap',
      ...lifecycleBrokerEnvironment
    })).toThrow(/requires offline update staging/)
    expect(() => loadConfig({
      NODE_ENV: 'test', DYSON_PROVIDER: 'windows', DYSON_PROJECT_ROOT: 'C:\\Fictional\\Dyson',
      DYSON_UPDATE_ACTIVATION_ENABLED: 'true', DYSON_LIFECYCLE_ENABLED: 'true',
      DYSON_BRIDGE_CONTROL_ROOT: 'C:\\Fictional\\Dyson\\run\\control-bridge',
      DYSON_BRIDGE_SECRET_FILE: 'C:\\ProgramData\\DysonControl\\bridge.secret',
      DYSON_RUNTIME_BOOTSTRAP_ROOT: 'C:\\Program Files\\DysonControl\\bootstrap',
      ...lifecycleBrokerEnvironment,
      DYSON_UPDATE_STAGING_ENABLED: 'true',
      DYSON_UPDATE_INBOX_ROOT: 'C:\\ProgramData\\DysonControl\\update-inbox',
      DYSON_UPDATE_STAGING_ROOT: 'C:\\ProgramData\\DysonControl\\staging'
    })).toThrow(/requires a trusted compatibility policy file/)
    expect(loadConfig({
      NODE_ENV: 'test', DYSON_PROVIDER: 'windows', DYSON_PROJECT_ROOT: 'C:\\Fictional\\Dyson',
      DYSON_UPDATE_ACTIVATION_ENABLED: 'true', DYSON_LIFECYCLE_ENABLED: 'true',
      DYSON_BRIDGE_CONTROL_ROOT: 'C:\\Fictional\\Dyson\\run\\control-bridge',
      DYSON_BRIDGE_SECRET_FILE: 'C:\\ProgramData\\DysonControl\\bridge.secret',
      DYSON_RUNTIME_BOOTSTRAP_ROOT: 'C:\\Program Files\\DysonControl\\bootstrap',
      ...lifecycleBrokerEnvironment,
      DYSON_UPDATE_STAGING_ENABLED: 'true',
      DYSON_UPDATE_INBOX_ROOT: 'C:\\ProgramData\\DysonControl\\update-inbox',
      DYSON_UPDATE_STAGING_ROOT: 'C:\\ProgramData\\DysonControl\\staging',
      DYSON_UPDATE_COMPATIBILITY_POLICY_FILE: 'C:\\ProgramData\\DysonControl\\compatibility-policy.json'
    }).updateActivationEnabled).toBe(true)
    expect(() => loadConfig({
      NODE_ENV: 'test', DYSON_UPDATE_COMPATIBILITY_POLICY_FILE: 'relative\\policy.json'
    })).toThrow(/must be an absolute path/)
  })

  it('keeps the Steam manual handoff disabled and requires the fixed Windows lifecycle and policy chain', () => {
    expect(loadConfig({ NODE_ENV: 'test' }).steamManualHandoffEnabled).toBe(false)
    expect(() => loadConfig({
      NODE_ENV: 'test', DYSON_STEAM_MANUAL_HANDOFF_ENABLED: 'true'
    })).toThrow(/DYSON_STEAM_MANUAL_HANDOFF_ENABLED requires the Windows provider/)
    expect(() => loadConfig({
      NODE_ENV: 'test', DYSON_PROVIDER: 'windows', DYSON_PROJECT_ROOT: 'C:\\Fictional\\Dyson',
      DYSON_STEAM_MANUAL_HANDOFF_ENABLED: 'true'
    })).toThrow(/DYSON_STEAM_MANUAL_HANDOFF_ENABLED requires lifecycle execution/)
    expect(() => loadConfig({
      NODE_ENV: 'test', DYSON_PROVIDER: 'windows', DYSON_PROJECT_ROOT: 'C:\\Fictional\\Dyson',
      ...lifecycleExecutionEnvironment,
      DYSON_STEAM_MANUAL_HANDOFF_ENABLED: 'true'
    })).toThrow(/DYSON_STEAM_MANUAL_HANDOFF_ENABLED requires a trusted compatibility policy file/)
    expect(() => loadConfig({
      NODE_ENV: 'test', DYSON_PROVIDER: 'windows', DYSON_PROJECT_ROOT: 'C:\\Fictional\\Dyson',
      ...lifecycleExecutionEnvironment,
      DYSON_STEAM_MANUAL_HANDOFF_ENABLED: 'true',
      DYSON_UPDATE_COMPATIBILITY_POLICY_FILE: 'relative\\compatibility-policy.json'
    })).toThrow(/DYSON_UPDATE_COMPATIBILITY_POLICY_FILE must be an absolute path/)

    expect(loadConfig({
      NODE_ENV: 'test', DYSON_PROVIDER: 'windows', DYSON_PROJECT_ROOT: 'C:\\Fictional\\Dyson',
      ...lifecycleExecutionEnvironment,
      DYSON_STEAM_MANUAL_HANDOFF_ENABLED: 'true',
      DYSON_UPDATE_COMPATIBILITY_POLICY_FILE: 'C:\\ProgramData\\DysonControl\\compatibility-policy.json'
    })).toMatchObject({
      steamManualHandoffEnabled: true,
      updateStagingEnabled: false,
      updateActivationEnabled: false
    })
  })

  it('keeps explicit component recovery independently disabled and validates its complete host chain', () => {
    expect(() => loadConfig({
      NODE_ENV: 'test', DYSON_UPDATE_ACTIVATION_RECOVERY_ENABLED: 'true'
    })).toThrow(/requires the Windows provider/)
    expect(() => loadConfig({
      NODE_ENV: 'test', DYSON_PROVIDER: 'windows', DYSON_PROJECT_ROOT: 'C:\\Fictional\\Dyson',
      DYSON_UPDATE_ACTIVATION_RECOVERY_ENABLED: 'true'
    })).toThrow(/requires lifecycle execution/)
    const config = loadConfig({
      NODE_ENV: 'test', DYSON_PROVIDER: 'windows', DYSON_PROJECT_ROOT: 'C:\\Fictional\\Dyson',
      DYSON_UPDATE_ACTIVATION_ENABLED: 'false',
      DYSON_UPDATE_ACTIVATION_RECOVERY_ENABLED: 'true', DYSON_LIFECYCLE_ENABLED: 'true',
      DYSON_BRIDGE_CONTROL_ROOT: 'C:\\Fictional\\Dyson\\run\\control-bridge',
      DYSON_BRIDGE_SECRET_FILE: 'C:\\ProgramData\\DysonControl\\bridge.secret',
      DYSON_RUNTIME_BOOTSTRAP_ROOT: 'C:\\Program Files\\DysonControl\\bootstrap',
      ...lifecycleBrokerEnvironment,
      DYSON_UPDATE_STAGING_ENABLED: 'true',
      DYSON_UPDATE_INBOX_ROOT: 'C:\\ProgramData\\DysonControl\\update-inbox',
      DYSON_UPDATE_STAGING_ROOT: 'C:\\ProgramData\\DysonControl\\staging',
      DYSON_UPDATE_COMPATIBILITY_POLICY_FILE: 'C:\\ProgramData\\DysonControl\\compatibility-policy.json'
    })
    expect(config).toMatchObject({
      updateActivationEnabled: false,
      updateActivationRecoveryEnabled: true
    })
  })

  it('keeps cutover and explicit recovery independently closed behind the complete fixed Windows chain', () => {
    expect(loadConfig({ NODE_ENV: 'test' })).toMatchObject({
      cutoverEnabled: false,
      cutoverRecoveryEnabled: false,
      cutoverProfileFile: null,
      cutoverServiceUser: null,
      cutoverTaskTransactionRoot: null,
      cutoverDataDirectory: expect.stringMatching(/[\\/]data[\\/]cutover$/)
    })
    expect(() => loadConfig({
      NODE_ENV: 'test', DYSON_CUTOVER_ENABLED: 'true'
    })).toThrow(/Windows provider/)
    expect(() => loadConfig({
      NODE_ENV: 'test', DYSON_PROVIDER: 'windows', DYSON_PROJECT_ROOT: 'C:\\Fictional\\Dyson',
      DYSON_CUTOVER_ENABLED: 'true'
    })).toThrow(/lifecycle execution/)

    const lifecycle = {
      NODE_ENV: 'test',
      DYSON_PROVIDER: 'windows',
      DYSON_PROJECT_ROOT: 'C:\\Fictional\\Dyson',
      DYSON_LIFECYCLE_ENABLED: 'true',
      DYSON_BRIDGE_CONTROL_ROOT: 'C:\\Fictional\\Dyson\\run\\control-bridge',
      DYSON_BRIDGE_SECRET_FILE: 'C:\\ProgramData\\DysonControl\\bridge.secret',
      DYSON_RUNTIME_BOOTSTRAP_ROOT: 'C:\\Program Files\\DysonControl\\bootstrap',
      ...lifecycleBrokerEnvironment
    } as const
    expect(() => loadConfig({ ...lifecycle, DYSON_CUTOVER_ENABLED: 'true' }))
      .toThrow(/DYSON_CUTOVER_PROFILE_FILE/)
    expect(() => loadConfig({
      ...lifecycle,
      DYSON_CUTOVER_ENABLED: 'true',
      DYSON_CUTOVER_PROFILE_FILE: 'C:\\ProgramData\\DysonControl\\authority-profile.json'
    })).toThrow(/DYSON_CUTOVER_SERVICE_USER/)
    expect(() => loadConfig({
      ...lifecycle,
      DYSON_CUTOVER_ENABLED: 'true',
      DYSON_CUTOVER_PROFILE_FILE: 'C:\\ProgramData\\DysonControl\\authority-profile.json',
      DYSON_CUTOVER_SERVICE_USER: '.\\DysonServer'
    })).toThrow(/DYSON_CUTOVER_TASK_TRANSACTION_ROOT/)
    expect(() => loadConfig({
      ...lifecycle,
      DYSON_CUTOVER_ENABLED: 'true',
      DYSON_CUTOVER_PROFILE_FILE: 'C:\\ProgramData\\DysonControl\\authority-profile.json',
      DYSON_CUTOVER_SERVICE_USER: '.\\DysonServer',
      DYSON_CUTOVER_TASK_TRANSACTION_ROOT: 'C:\\ProgramData\\DysonControl\\runtime-task-transactions'
    })).toThrow(/absolute DYSON_DATA_DIR/)

    const configured = loadConfig({
      ...lifecycle,
      DYSON_CUTOVER_ENABLED: 'false',
      DYSON_CUTOVER_RECOVERY_ENABLED: 'true',
      DYSON_CUTOVER_PROFILE_FILE: 'C:\\ProgramData\\DysonControl\\authority-profile.json',
      DYSON_CUTOVER_SERVICE_USER: '.\\DysonServer',
      DYSON_CUTOVER_TASK_TRANSACTION_ROOT: 'C:\\ProgramData\\DysonControl\\runtime-task-transactions',
      DYSON_DATA_DIR: 'C:\\ProgramData\\DysonControl\\data'
    })
    expect(configured).toMatchObject({
      cutoverEnabled: false,
      cutoverRecoveryEnabled: true,
      cutoverProfileFile: 'C:\\ProgramData\\DysonControl\\authority-profile.json',
      cutoverServiceUser: '.\\DysonServer',
      cutoverTaskTransactionRoot: 'C:\\ProgramData\\DysonControl\\runtime-task-transactions',
      dataDir: 'C:\\ProgramData\\DysonControl\\data'
    })
    expect(() => loadConfig({
      NODE_ENV: 'test', DYSON_CUTOVER_PROFILE_FILE: 'relative\\authority-profile.json'
    })).toThrow(/must be an absolute path/)
    expect(() => loadConfig({
      NODE_ENV: 'test', DYSON_CUTOVER_TASK_TRANSACTION_ROOT: 'relative\\transactions'
    })).toThrow(/must be an absolute path/)
    expect(() => loadConfig({
      NODE_ENV: 'test', DYSON_CUTOVER_SERVICE_USER: 'bad"account'
    })).toThrow()
  })

  it('keeps qualified client issuance closed behind complete disjoint protected Windows roots', () => {
    expect(loadConfig({ NODE_ENV: 'test' })).toMatchObject({
      qualifiedClientProfileEnabled: false,
      clientQualificationEvidenceRoot: null,
      clientQualificationBuildHarvestRootA: null,
      clientQualificationBuildHarvestRootB: null,
      clientQualificationKeyRingRoot: null,
      clientQualificationReplayRoot: null,
      qualifiedClientIssueRoot: null,
      clientQualificationAuthority: null
    })
    expect(() => loadConfig({
      NODE_ENV: 'test', DYSON_QUALIFIED_CLIENT_PROFILE_ENABLED: 'true'
    })).toThrow(/Windows provider/)
    expect(() => loadConfig({
      NODE_ENV: 'test', DYSON_PROVIDER: 'windows', DYSON_PROJECT_ROOT: 'C:\\Fictional\\Dyson',
      DYSON_QUALIFIED_CLIENT_PROFILE_ENABLED: 'true'
    })).toThrow(/every protected root and authority/)

    const complete = {
      NODE_ENV: 'test',
      DYSON_PROVIDER: 'windows',
      DYSON_PROJECT_ROOT: 'C:\\Fictional\\Dyson',
      DYSON_QUALIFIED_CLIENT_PROFILE_ENABLED: 'true',
      DYSON_CLIENT_QUALIFICATION_EVIDENCE_ROOT: 'C:\\Fictional\\QualificationEvidence',
      DYSON_CLIENT_QUALIFICATION_BUILD_HARVEST_ROOT_A: 'D:\\Fictional\\BuildA',
      DYSON_CLIENT_QUALIFICATION_BUILD_HARVEST_ROOT_B: 'E:\\Fictional\\BuildB',
      DYSON_CLIENT_QUALIFICATION_KEY_RING_ROOT: 'F:\\Fictional\\Keys',
      DYSON_CLIENT_QUALIFICATION_REPLAY_ROOT: 'G:\\Fictional\\Replay',
      DYSON_QUALIFIED_CLIENT_ISSUE_ROOT: 'H:\\Fictional\\IssuedProfiles',
      DYSON_CLIENT_QUALIFICATION_AUTHORITY: 'game.example.com'
    } as const
    expect(loadConfig(complete)).toMatchObject({
      qualifiedClientProfileEnabled: true,
      clientQualificationEvidenceRoot: 'C:\\Fictional\\QualificationEvidence',
      clientQualificationBuildHarvestRootA: 'D:\\Fictional\\BuildA',
      clientQualificationBuildHarvestRootB: 'E:\\Fictional\\BuildB',
      clientQualificationKeyRingRoot: 'F:\\Fictional\\Keys',
      clientQualificationReplayRoot: 'G:\\Fictional\\Replay',
      qualifiedClientIssueRoot: 'H:\\Fictional\\IssuedProfiles',
      clientQualificationAuthority: 'game.example.com'
    })
    expect(() => loadConfig({
      ...complete,
      DYSON_CLIENT_QUALIFICATION_BUILD_HARVEST_ROOT_A: 'relative\\BuildA'
    })).toThrow(/absolute paths below a filesystem root/)
    expect(() => loadConfig({
      ...complete,
      DYSON_CLIENT_QUALIFICATION_KEY_RING_ROOT: 'C:\\Fictional\\QualificationEvidence\\keys'
    })).toThrow(/pairwise disjoint/)
    expect(() => loadConfig({
      ...complete,
      DYSON_CLIENT_QUALIFICATION_AUTHORITY: '192.0.2.10'
    })).toThrow(/canonical public DNS hostname/)
    expect(() => loadConfig({
      ...complete,
      DYSON_CLIENT_QUALIFICATION_AUTHORITY: 'Game.Example.com'
    })).toThrow(/canonical public DNS hostname/)
  })

  it('keeps mod deployment independently disabled and binds activation to fixed Windows roots', () => {
    expect(loadConfig({ NODE_ENV: 'test' })).toMatchObject({
      modImportEnabled: false,
      modDeploymentEnabled: false,
      modDeploymentRecoveryEnabled: false,
      modStagingRoot: null,
      modPluginsRoot: null,
      modSnapshotLimit: 8
    })
    expect(() => loadConfig({
      NODE_ENV: 'test', DYSON_MOD_STAGING_ROOT: 'C:\\Fictional\\staged-mods'
    })).toThrow(/configured together/)
    expect(() => loadConfig({
      NODE_ENV: 'test', DYSON_MOD_IMPORT_ENABLED: 'true'
    })).toThrow(/requires offline update staging/)
    expect(() => loadConfig({
      NODE_ENV: 'test', DYSON_MOD_IMPORT_ENABLED: 'true',
      DYSON_UPDATE_STAGING_ENABLED: 'true',
      DYSON_UPDATE_INBOX_ROOT: 'C:\\Fictional\\inbox',
      DYSON_UPDATE_STAGING_ROOT: 'C:\\Fictional\\update-staging'
    })).toThrow(/requires the fixed mod staging root/)
    expect(() => loadConfig({
      NODE_ENV: 'test', DYSON_PROVIDER: 'demo', DYSON_PROJECT_ROOT: 'C:\\Fictional\\Dyson',
      DYSON_MOD_DEPLOYMENT_ENABLED: 'true',
      DYSON_MOD_STAGING_ROOT: 'C:\\Fictional\\staged-mods',
      DYSON_MOD_PLUGINS_ROOT: 'C:\\Fictional\\Dyson\\server\\BepInEx\\plugins\\dyson-managed-mods'
    })).toThrow(/requires the Windows provider/)
    expect(() => loadConfig({
      NODE_ENV: 'test', DYSON_PROVIDER: 'windows', DYSON_PROJECT_ROOT: 'C:\\Fictional\\Dyson',
      DYSON_MOD_STAGING_ROOT: 'C:\\Fictional\\staged-mods',
      DYSON_MOD_PLUGINS_ROOT: 'C:\\Fictional\\Dyson\\server\\BepInEx\\plugins'
    })).toThrow(/fixed dyson-managed-mods subtree/)
    expect(loadConfig({
      NODE_ENV: 'test', DYSON_PROVIDER: 'windows', DYSON_PROJECT_ROOT: 'C:\\Fictional\\Dyson',
      ...lifecycleExecutionEnvironment,
      DYSON_MOD_IMPORT_ENABLED: 'true',
      DYSON_MOD_DEPLOYMENT_ENABLED: 'true',
      DYSON_UPDATE_STAGING_ENABLED: 'true',
      DYSON_UPDATE_INBOX_ROOT: 'C:\\Fictional\\inbox',
      DYSON_UPDATE_STAGING_ROOT: 'C:\\Fictional\\update-staging',
      DYSON_MOD_STAGING_ROOT: 'C:\\Fictional\\staged-mods',
      DYSON_MOD_PLUGINS_ROOT: 'C:\\Fictional\\Dyson\\server\\BepInEx\\plugins\\dyson-managed-mods',
      DYSON_MOD_SNAPSHOT_LIMIT: '16'
    })).toMatchObject({
      modImportEnabled: true,
      modDeploymentEnabled: true,
      modDeploymentRecoveryEnabled: false,
      modPluginsRoot: 'C:\\Fictional\\Dyson\\server\\BepInEx\\plugins\\dyson-managed-mods',
      modSnapshotLimit: 16
    })
  })

  it('keeps explicit mod recovery independently disabled and requires the fixed Windows roots', () => {
    expect(() => loadConfig({
      NODE_ENV: 'test', DYSON_MOD_DEPLOYMENT_RECOVERY_ENABLED: 'true'
    })).toThrow(/requires the Windows provider/)
    const config = loadConfig({
      NODE_ENV: 'test', DYSON_PROVIDER: 'windows', DYSON_PROJECT_ROOT: 'C:\\Fictional\\Dyson',
      ...lifecycleExecutionEnvironment,
      DYSON_MOD_DEPLOYMENT_ENABLED: 'false',
      DYSON_MOD_DEPLOYMENT_RECOVERY_ENABLED: 'true',
      DYSON_MOD_STAGING_ROOT: 'C:\\Fictional\\staged-mods',
      DYSON_MOD_PLUGINS_ROOT: 'C:\\Fictional\\Dyson\\server\\BepInEx\\plugins\\dyson-managed-mods'
    })
    expect(config).toMatchObject({
      modDeploymentEnabled: false,
      modDeploymentRecoveryEnabled: true
    })
  })

  it('keeps save mutations disabled and only permits the explicit Windows gate', () => {
    expect(loadConfig({ NODE_ENV: 'test' })).toMatchObject({
      saveMutationsEnabled: false,
      saveRetentionMutationsEnabled: false,
      saveRetentionPurgeMinimumHours: 168,
      configHistoryMutationsEnabled: false
    })
    expect(() => loadConfig({
      NODE_ENV: 'test', DYSON_PROVIDER: 'demo', DYSON_SAVE_MUTATIONS_ENABLED: 'true'
    })).toThrow(/requires the Windows provider/)
    expect(loadConfig({
      NODE_ENV: 'test', DYSON_PROVIDER: 'windows',
      DYSON_PROJECT_ROOT: 'C:\\Fictional\\Dyson', ...lifecycleExecutionEnvironment,
      DYSON_SAVE_MUTATIONS_ENABLED: 'true'
    }).saveMutationsEnabled).toBe(true)
    expect(() => loadConfig({
      NODE_ENV: 'test', DYSON_PROVIDER: 'demo', DYSON_SAVE_RETENTION_MUTATIONS_ENABLED: 'true'
    })).toThrow(/requires the Windows provider/)
    expect(loadConfig({
      NODE_ENV: 'test', DYSON_PROVIDER: 'windows', DYSON_PROJECT_ROOT: 'C:\\Fictional\\Dyson',
      DYSON_SAVE_RETENTION_MUTATIONS_ENABLED: 'true',
      DYSON_SAVE_RETENTION_PURGE_MINIMUM_HOURS: '336'
    })).toMatchObject({
      saveRetentionMutationsEnabled: true,
      saveRetentionPurgeMinimumHours: 336
    })
    expect(() => loadConfig({
      NODE_ENV: 'test', DYSON_PROVIDER: 'demo', DYSON_CONFIG_HISTORY_MUTATIONS_ENABLED: 'true'
    })).toThrow(/requires the Windows provider/)
    expect(loadConfig({
      NODE_ENV: 'test', DYSON_PROVIDER: 'windows',
      DYSON_PROJECT_ROOT: 'C:\\Fictional\\Dyson', ...lifecycleExecutionEnvironment,
      DYSON_CONFIG_HISTORY_MUTATIONS_ENABLED: 'true'
    }).configHistoryMutationsEnabled).toBe(true)
  })

  it('keeps raw save transfer administrator-gated and bound to one fixed Windows root', () => {
    expect(loadConfig({ NODE_ENV: 'test' })).toMatchObject({
      saveTransferEnabled: false,
      saveTransferRoot: null
    })
    expect(() => loadConfig({
      NODE_ENV: 'test', DYSON_SAVE_TRANSFER_ROOT: 'relative\\transfer'
    })).toThrow(/DYSON_SAVE_TRANSFER_ROOT must be an absolute path/)
    expect(() => loadConfig({
      NODE_ENV: 'test', DYSON_PROVIDER: 'demo', DYSON_SAVE_TRANSFER_ENABLED: 'true',
      DYSON_SAVE_TRANSFER_ROOT: 'C:\\Fictional\\Dyson\\transfers'
    })).toThrow(/requires the Windows provider/)
    expect(loadConfig({
      NODE_ENV: 'test', DYSON_PROVIDER: 'windows', DYSON_PROJECT_ROOT: 'C:\\Fictional\\Dyson',
      DYSON_SAVE_TRANSFER_ENABLED: 'true',
      DYSON_SAVE_TRANSFER_ROOT: 'C:\\Fictional\\Dyson\\transfers'
    })).toMatchObject({
      saveTransferEnabled: true,
      saveTransferRoot: 'C:\\Fictional\\Dyson\\transfers'
    })
  })

  it('keeps lifecycle mutation disabled by default and requires its complete Windows bridge configuration', () => {
    const disabled = loadConfig({ NODE_ENV: 'test', DYSON_PROVIDER: 'demo' })
    expect(disabled).toMatchObject({
      lifecycleEnabled: false,
      playerHistoryCapacity: 512,
      playerHistoryRetentionHours: 168
    })

    expect(() => loadConfig({
      NODE_ENV: 'test', DYSON_PROVIDER: 'windows', DYSON_PROJECT_ROOT: 'C:\\Fictional\\Dyson',
      DYSON_LIFECYCLE_ENABLED: 'true'
    })).toThrow(/DYSON_BRIDGE_CONTROL_ROOT/)
    expect(() => loadConfig({
      NODE_ENV: 'test', DYSON_PROVIDER: 'windows', DYSON_PROJECT_ROOT: 'C:\\Fictional\\Dyson',
      DYSON_LIFECYCLE_ENABLED: 'true',
      DYSON_BRIDGE_CONTROL_ROOT: 'C:\\Fictional\\Dyson\\run\\control-bridge',
      DYSON_BRIDGE_SECRET_FILE: 'C:\\ProgramData\\DysonControl\\bridge.secret'
    })).toThrow(/DYSON_RUNTIME_BOOTSTRAP_ROOT/)

    expect(() => loadConfig({
      NODE_ENV: 'test', DYSON_PROVIDER: 'windows', DYSON_PROJECT_ROOT: 'C:\\Fictional\\Dyson',
      DYSON_LIFECYCLE_ENABLED: 'true',
      DYSON_BRIDGE_CONTROL_ROOT: 'C:\\Fictional\\Dyson\\run\\control-bridge',
      DYSON_BRIDGE_SECRET_FILE: 'C:\\ProgramData\\DysonControl\\bridge.secret',
      DYSON_RUNTIME_BOOTSTRAP_ROOT: 'C:\\Program Files\\DysonControl\\bootstrap'
    })).toThrow(/DYSON_LIFECYCLE_BROKER_PROFILE_FILE/)
    expect(() => loadConfig({
      NODE_ENV: 'test', DYSON_PROVIDER: 'windows', DYSON_PROJECT_ROOT: 'C:\\Fictional\\Dyson',
      DYSON_LIFECYCLE_ENABLED: 'true',
      DYSON_BRIDGE_CONTROL_ROOT: 'C:\\Fictional\\Dyson\\run\\control-bridge',
      DYSON_BRIDGE_SECRET_FILE: 'C:\\ProgramData\\DysonControl\\bridge.secret',
      DYSON_RUNTIME_BOOTSTRAP_ROOT: 'C:\\Program Files\\DysonControl\\bootstrap',
      DYSON_LIFECYCLE_BROKER_PROFILE_FILE:
        'C:\\ProgramData\\DysonControl\\data\\lifecycle-broker\\broker-profile.json'
    })).toThrow(/DYSON_RUNTIME_SERVICE_USER/)

    const enabled = loadConfig({
      NODE_ENV: 'test', DYSON_PROVIDER: 'windows', DYSON_PROJECT_ROOT: 'C:\\Fictional\\Dyson',
      DYSON_LIFECYCLE_ENABLED: 'true',
      DYSON_BRIDGE_CONTROL_ROOT: 'C:\\Fictional\\Dyson\\run\\control-bridge',
      DYSON_BRIDGE_SECRET_FILE: 'C:\\ProgramData\\DysonControl\\bridge.secret',
      DYSON_RUNTIME_BOOTSTRAP_ROOT: 'C:\\Program Files\\DysonControl\\bootstrap',
      ...lifecycleBrokerEnvironment
    })
    expect(enabled).toMatchObject({
      lifecycleEnabled: true, lifecycleTimeoutMs: 240_000, gamePort: 8469,
      runtimeBootstrapRoot: 'C:\\Program Files\\DysonControl\\bootstrap',
      lifecycleBrokerProfileFile:
        'C:\\ProgramData\\DysonControl\\data\\lifecycle-broker\\broker-profile.json',
      runtimeServiceUser: '.\\DysonServer',
      serverTaskName: 'Dyson-Nebula-Server', stopTaskName: 'Dyson-Nebula-Stop',
      playerSnapshotMaximumAgeMs: 10_000,
      playerHistoryCapacity: 512,
      playerHistoryRetentionHours: 168
    })

    expect(() => loadConfig({
      NODE_ENV: 'test', DYSON_BRIDGE_CONTROL_ROOT: 'C:\\Fictional\\control'
    })).toThrow(/configured together/)
    expect(() => loadConfig({
      NODE_ENV: 'test', DYSON_RUNTIME_BOOTSTRAP_ROOT: 'relative\\bootstrap'
    })).toThrow(/must be an absolute path/)
  })

  it('pins lifecycle execution to the two fixed scheduled tasks while preserving disabled compatibility', () => {
    const lifecycle = {
      NODE_ENV: 'test',
      DYSON_PROVIDER: 'windows',
      DYSON_PROJECT_ROOT: 'C:\\Fictional\\Dyson',
      ...lifecycleExecutionEnvironment
    } as const

    expect(() => loadConfig({
      ...lifecycle,
      DYSON_SERVER_TASK: 'Legacy-Dyson-Server'
    })).toThrow(/DYSON_SERVER_TASK.*Dyson-Nebula-Server/)
    expect(() => loadConfig({
      ...lifecycle,
      DYSON_STOP_TASK: 'Legacy-Dyson-Stop'
    })).toThrow(/DYSON_STOP_TASK.*Dyson-Nebula-Stop/)

    expect(loadConfig({
      NODE_ENV: 'test',
      DYSON_PROVIDER: 'windows',
      DYSON_PROJECT_ROOT: 'C:\\Fictional\\Dyson',
      DYSON_LIFECYCLE_ENABLED: 'false',
      DYSON_SERVER_TASK: 'Legacy-Dyson-Server',
      DYSON_STOP_TASK: 'Legacy-Dyson-Stop'
    })).toMatchObject({
      lifecycleEnabled: false,
      serverTaskName: 'Legacy-Dyson-Server',
      stopTaskName: 'Legacy-Dyson-Stop'
    })
  })

  it('bounds durable player history by both event count and retention time', () => {
    expect(loadConfig({
      NODE_ENV: 'test',
      DYSON_PLAYER_HISTORY_CAPACITY: '2048',
      DYSON_PLAYER_HISTORY_RETENTION_HOURS: '720'
    })).toMatchObject({
      playerHistoryCapacity: 2_048,
      playerHistoryRetentionHours: 720
    })
    for (const [name, value] of [
      ['DYSON_PLAYER_HISTORY_CAPACITY', '0'],
      ['DYSON_PLAYER_HISTORY_CAPACITY', '2049'],
      ['DYSON_PLAYER_HISTORY_RETENTION_HOURS', '0'],
      ['DYSON_PLAYER_HISTORY_RETENTION_HOURS', '721']
    ] as const) {
      expect(() => loadConfig({ NODE_ENV: 'test', [name]: value })).toThrow()
    }
  })
})
