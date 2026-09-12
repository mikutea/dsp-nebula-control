import path from 'node:path'
import { z } from 'zod'
import { normalizeVersion } from '../updates/version.js'
import type { FixedComponentVersionProbe } from './windows-update-activation.js'
import type { LifecycleScriptRunner } from './powershell-runner.js'

const componentSchema = z.enum(['bridge', 'control'])
export const fixedWindowsManagedPluginIdentities = Object.freeze({
  bridge: Object.freeze({
    directoryName: 'dyson-control-bridge',
    fileName: 'DysonControlBridge.dll',
    relativePath: 'plugins/dyson-control-bridge/DysonControlBridge.dll'
  }),
  control: Object.freeze({
    directoryName: 'dyson-control',
    fileName: 'DysonControl.dll',
    relativePath: 'plugins/dyson-control/DysonControl.dll'
  })
} as const)

const responseSchema = z.discriminatedUnion('state', [
  z.strictObject({
    protocol: z.literal('DYSON_CONTROL_MANAGED_PLUGIN_VERSION_V1'),
    component: componentSchema,
    fileName: z.enum(['DysonControlBridge.dll', 'DysonControl.dll']),
    relativePath: z.enum([
      'plugins/dyson-control-bridge/DysonControlBridge.dll',
      'plugins/dyson-control/DysonControl.dll'
    ]),
    state: z.literal('available'),
    version: z.string().trim().min(1).max(64)
  }),
  z.strictObject({
    protocol: z.literal('DYSON_CONTROL_MANAGED_PLUGIN_VERSION_V1'),
    component: componentSchema,
    fileName: z.enum(['DysonControlBridge.dll', 'DysonControl.dll']),
    relativePath: z.enum([
      'plugins/dyson-control-bridge/DysonControlBridge.dll',
      'plugins/dyson-control/DysonControl.dll'
    ]),
    state: z.literal('absent'),
    version: z.null()
  })
])
const requestSchema = z.strictObject({
  component: componentSchema,
  signal: z.instanceof(AbortSignal)
})

export const fixedWindowsManagedPluginFileNames = Object.freeze({
  bridge: 'DysonControlBridge.dll',
  control: 'DysonControl.dll'
} as const)

export interface WindowsManagedPluginVersionProbeOptions {
  projectRoot: string
  scriptRunner: LifecycleScriptRunner
}

export class WindowsManagedPluginVersionProbeError extends Error {
  readonly code: string

  constructor(code: string) {
    super(code)
    this.name = 'WindowsManagedPluginVersionProbeError'
    this.code = code
  }
}

/**
 * Reads bridge/control versions through one fixed host script. The project root,
 * script identity, and DLL mapping are all construction-time constants; the
 * invocation surface deliberately has no path, file, URL, or command field.
 */
export class WindowsManagedPluginVersionProbe {
  readonly #projectRoot: string
  readonly #scriptRunner: LifecycleScriptRunner

  constructor(options: WindowsManagedPluginVersionProbeOptions) {
    if (typeof options?.projectRoot !== 'string' ||
        options.projectRoot.length < 1 || options.projectRoot.length > 1_024 ||
        /[\r\n\0]/.test(options.projectRoot) || !path.isAbsolute(options.projectRoot) ||
        typeof options.scriptRunner?.run !== 'function') {
      throw new WindowsManagedPluginVersionProbeError('WINDOWS_PLUGIN_VERSION_PROBE_CONFIG_INVALID')
    }
    this.#projectRoot = path.resolve(options.projectRoot)
    this.#scriptRunner = options.scriptRunner
  }

  readonly probe: FixedComponentVersionProbe = async (input): Promise<string | null> => {
    let request: z.infer<typeof requestSchema>
    try {
      request = requestSchema.parse(input)
    } catch {
      throw new WindowsManagedPluginVersionProbeError('WINDOWS_PLUGIN_VERSION_PROBE_REQUEST_INVALID')
    }

    try {
      const output = await this.#scriptRunner.run(
        'Get-DysonManagedPluginVersion.ps1',
        ['-ProjectRoot', this.#projectRoot, '-Component', request.component],
        request.signal
      )
      const response = responseSchema.parse(JSON.parse(output))
      const expectedIdentity = fixedWindowsManagedPluginIdentities[request.component]
      if (response.component !== request.component ||
          response.fileName !== expectedIdentity.fileName ||
          response.relativePath !== expectedIdentity.relativePath) {
        throw new Error('fixed managed plugin identity mismatch')
      }
      return response.state === 'absent' ? null : normalizeVersion(response.version, 'plugin')
    } catch {
      throw new WindowsManagedPluginVersionProbeError('WINDOWS_PLUGIN_VERSION_PROBE_FAILED')
    }
  }
}

export function createWindowsManagedPluginVersionProbe(
  options: WindowsManagedPluginVersionProbeOptions
): FixedComponentVersionProbe {
  return new WindowsManagedPluginVersionProbe(options).probe
}
