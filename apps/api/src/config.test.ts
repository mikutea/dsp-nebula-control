import { describe, expect, it } from 'vitest'
import { loadConfig } from './config.js'

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

  it('accepts only a bounded deployment release identifier', () => {
    expect(loadConfig({
      NODE_ENV: 'test', DYSON_DEPLOYMENT_VERSION: 'v0.1.0-rc.2+fixture'
    }).deploymentVersion).toBe('v0.1.0-rc.2+fixture')
    expect(() => loadConfig({
      NODE_ENV: 'test', DYSON_DEPLOYMENT_VERSION: '../untrusted release'
    })).toThrow()
  })

  it('keeps the console disabled without its independent signed-cursor secret', () => {
    expect(loadConfig({ NODE_ENV: 'test' }).consoleCursorSecret).toBeNull()
    expect(() => loadConfig({ NODE_ENV: 'test', DYSON_CONSOLE_CURSOR_SECRET: 'too-short' })).toThrow()
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
      DYSON_BRIDGE_SECRET_FILE: 'C:\\ProgramData\\DysonControl\\bridge.secret'
    })).toThrow(/requires offline update staging/)
    expect(() => loadConfig({
      NODE_ENV: 'test', DYSON_PROVIDER: 'windows', DYSON_PROJECT_ROOT: 'C:\\Fictional\\Dyson',
      DYSON_UPDATE_ACTIVATION_ENABLED: 'true', DYSON_LIFECYCLE_ENABLED: 'true',
      DYSON_BRIDGE_CONTROL_ROOT: 'C:\\Fictional\\Dyson\\run\\control-bridge',
      DYSON_BRIDGE_SECRET_FILE: 'C:\\ProgramData\\DysonControl\\bridge.secret',
      DYSON_UPDATE_STAGING_ENABLED: 'true',
      DYSON_UPDATE_INBOX_ROOT: 'C:\\ProgramData\\DysonControl\\update-inbox',
      DYSON_UPDATE_STAGING_ROOT: 'C:\\ProgramData\\DysonControl\\staging'
    })).toThrow(/requires a trusted compatibility policy file/)
    expect(loadConfig({
      NODE_ENV: 'test', DYSON_PROVIDER: 'windows', DYSON_PROJECT_ROOT: 'C:\\Fictional\\Dyson',
      DYSON_UPDATE_ACTIVATION_ENABLED: 'true', DYSON_LIFECYCLE_ENABLED: 'true',
      DYSON_BRIDGE_CONTROL_ROOT: 'C:\\Fictional\\Dyson\\run\\control-bridge',
      DYSON_BRIDGE_SECRET_FILE: 'C:\\ProgramData\\DysonControl\\bridge.secret',
      DYSON_UPDATE_STAGING_ENABLED: 'true',
      DYSON_UPDATE_INBOX_ROOT: 'C:\\ProgramData\\DysonControl\\update-inbox',
      DYSON_UPDATE_STAGING_ROOT: 'C:\\ProgramData\\DysonControl\\staging',
      DYSON_UPDATE_COMPATIBILITY_POLICY_FILE: 'C:\\ProgramData\\DysonControl\\compatibility-policy.json'
    }).updateActivationEnabled).toBe(true)
    expect(() => loadConfig({
      NODE_ENV: 'test', DYSON_UPDATE_COMPATIBILITY_POLICY_FILE: 'relative\\policy.json'
    })).toThrow(/must be an absolute path/)
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
      DYSON_PROJECT_ROOT: 'C:\\Fictional\\Dyson', DYSON_SAVE_MUTATIONS_ENABLED: 'true'
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
      DYSON_PROJECT_ROOT: 'C:\\Fictional\\Dyson', DYSON_CONFIG_HISTORY_MUTATIONS_ENABLED: 'true'
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

    const enabled = loadConfig({
      NODE_ENV: 'test', DYSON_PROVIDER: 'windows', DYSON_PROJECT_ROOT: 'C:\\Fictional\\Dyson',
      DYSON_LIFECYCLE_ENABLED: 'true',
      DYSON_BRIDGE_CONTROL_ROOT: 'C:\\Fictional\\Dyson\\run\\control-bridge',
      DYSON_BRIDGE_SECRET_FILE: 'C:\\ProgramData\\DysonControl\\bridge.secret'
    })
    expect(enabled).toMatchObject({
      lifecycleEnabled: true, lifecycleTimeoutMs: 240_000, gamePort: 8469,
      serverTaskName: 'Dyson-Nebula-Server', stopTaskName: 'Dyson-Nebula-Stop',
      playerSnapshotMaximumAgeMs: 10_000,
      playerHistoryCapacity: 512,
      playerHistoryRetentionHours: 168
    })

    expect(() => loadConfig({
      NODE_ENV: 'test', DYSON_BRIDGE_CONTROL_ROOT: 'C:\\Fictional\\control'
    })).toThrow(/configured together/)
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
