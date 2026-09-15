import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { loadConfig } from './config.js'

const fixedEnvironment = {
  NODE_ENV: 'test',
  DYSON_PROVIDER: 'windows',
  DYSON_PROJECT_ROOT: 'C:\\GameServer\\Example\\DSP',
  DYSON_DATA_DIR: 'D:\\GameServer\\Example\\DysonControlData',
  DYSON_SCRIPT_ROOT: 'E:\\GameServer\\Example\\DysonControl\\scripts\\windows',
  DYSON_NEBULA_PLUGIN_JOB_BASE: 'F:\\GameServer\\Example\\DysonPrivateBuildJobs'
} as const

describe('Nebula plugin transaction configuration', () => {
  it('keeps both independent mutation gates closed and roots absent by default', () => {
    expect(loadConfig({ NODE_ENV: 'test' })).toMatchObject({
      nebulaPluginTransactionEnabled: false,
      nebulaPluginTransactionRecoveryEnabled: false,
      nebulaPluginJobBase: null,
      nebulaPluginGameRoot: null
    })
  })

  it('accepts ordinary and recovery gates independently with fixed absolute roots', () => {
    expect(loadConfig({
      ...fixedEnvironment,
      DYSON_NEBULA_PLUGIN_TRANSACTION_ENABLED: 'true'
    })).toMatchObject({
      nebulaPluginTransactionEnabled: true,
      nebulaPluginTransactionRecoveryEnabled: false,
      nebulaPluginJobBase: path.resolve(fixedEnvironment.DYSON_NEBULA_PLUGIN_JOB_BASE),
      nebulaPluginGameRoot: path.resolve(fixedEnvironment.DYSON_PROJECT_ROOT, 'server')
    })

    expect(loadConfig({
      ...fixedEnvironment,
      DYSON_NEBULA_PLUGIN_TRANSACTION_RECOVERY_ENABLED: 'true'
    })).toMatchObject({
      nebulaPluginTransactionEnabled: false,
      nebulaPluginTransactionRecoveryEnabled: true
    })
  })

  it('rejects either open gate without its Windows provider and explicit absolute roots', () => {
    expect(() => loadConfig({
      NODE_ENV: 'test',
      DYSON_NEBULA_PLUGIN_TRANSACTION_ENABLED: 'true'
    })).toThrow(/requires the Windows provider/)

    for (const missing of [
      'DYSON_PROJECT_ROOT',
      'DYSON_DATA_DIR',
      'DYSON_SCRIPT_ROOT',
      'DYSON_NEBULA_PLUGIN_JOB_BASE'
    ] as const) {
      const environment: Record<string, string> = {
        ...fixedEnvironment,
        DYSON_NEBULA_PLUGIN_TRANSACTION_RECOVERY_ENABLED: 'true'
      }
      delete environment[missing]
      expect(() => loadConfig(environment), missing).toThrow(
        missing === 'DYSON_PROJECT_ROOT'
          ? /DYSON_PROJECT_ROOT is required for the Windows provider/
          : /Nebula plugin transaction requires/
      )
    }
  })

  it('rejects relative or overlapping fixed roots before application construction', () => {
    expect(() => loadConfig({
      NODE_ENV: 'test',
      DYSON_NEBULA_PLUGIN_JOB_BASE: 'relative\\private-jobs'
    })).toThrow(/DYSON_NEBULA_PLUGIN_JOB_BASE must be an absolute path/)

    expect(() => loadConfig({
      ...fixedEnvironment,
      DYSON_NEBULA_PLUGIN_JOB_BASE: `${fixedEnvironment.DYSON_PROJECT_ROOT}\\server\\private-jobs`
    })).toThrow(/fixed roots must be disjoint/)

    expect(() => loadConfig({
      ...fixedEnvironment,
      DYSON_NEBULA_PLUGIN_JOB_BASE: `${fixedEnvironment.DYSON_PROJECT_ROOT}\\private-jobs`
    })).toThrow(/fixed roots must be disjoint/)

    expect(() => loadConfig({
      ...fixedEnvironment,
      DYSON_NEBULA_PLUGIN_JOB_BASE: path.parse(fixedEnvironment.DYSON_NEBULA_PLUGIN_JOB_BASE).root
    })).toThrow(/must be an absolute path below a filesystem root/)

    expect(() => loadConfig({
      ...fixedEnvironment,
      DYSON_DATA_DIR: path.parse(fixedEnvironment.DYSON_DATA_DIR).root
    })).toThrow(/fixed roots must be absolute non-root paths/)
  })

  it('still rejects unknown DYSON variables instead of silently opening a misspelled gate', () => {
    expect(() => loadConfig({
      NODE_ENV: 'test',
      DYSON_NEBULA_PLUGIN_TRANSACTON_ENABLED: 'true'
    })).toThrow(/Unsupported DYSON environment variable/)
  })
})
