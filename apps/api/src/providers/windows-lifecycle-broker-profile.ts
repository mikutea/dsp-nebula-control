import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { z } from 'zod'

const maximumProfileBytes = 128 * 1024
const maximumDependencyBytes = 4 * 1024 * 1024
const sha256Schema = z.string().regex(/^[0-9a-f]{64}$/u)
const absolutePathSchema = z.string().min(3).max(1_024).refine((value) =>
  path.isAbsolute(value) && !/[\0\r\n"]/u.test(value)
)
const dependencyNames = [
  'DysonLifecycleBroker.Common.ps1',
  'DysonLifecycleBroker.TaskAcl.ps1',
  'Install-DysonLifecycleBrokerTask.ps1',
  'Invoke-DysonLifecycleBrokerWorker.ps1',
  'Submit-DysonLifecycleBrokerRequest.ps1',
  'DysonHostMutationLease.Common.ps1',
  'Start-DysonServer.ps1',
  'Stop-DysonServer.ps1'
] as const
const taskPathSeparator = path.win32.sep
const workerTaskPath = [taskPathSeparator, 'DysonControl', taskPathSeparator].join('')
const profileKeys = [
  'protocol', 'schemaVersion', 'brokerRoot', 'brokerScriptRoot', 'projectRoot',
  'dataRoot', 'installedWindowsRoot', 'runtimeBootstrapRoot', 'serviceUser',
  'gamePort', 'workerTaskName', 'workerTaskPath', 'serverTask', 'stopTask',
  'dependencyHashes', 'dispatchReadyTimeoutSeconds', 'createdAt'
] as const
const fixedTaskKeys = ['name', 'path', 'descriptorHash'] as const
const dependencyKeys = ['name', 'path', 'sha256'] as const

const fixedTaskSchema = z.strictObject({
  name: z.enum(['Dyson-Nebula-Server', 'Dyson-Nebula-Stop']),
  path: z.literal(taskPathSeparator),
  descriptorHash: sha256Schema
})
const dependencySchema = z.strictObject({
  name: z.enum(dependencyNames),
  path: absolutePathSchema,
  sha256: sha256Schema
})
const profileSchema = z.strictObject({
  protocol: z.literal('DYSON_CONTROL_LIFECYCLE_BROKER_PROFILE_V1'),
  schemaVersion: z.literal(1),
  brokerRoot: absolutePathSchema,
  brokerScriptRoot: absolutePathSchema,
  projectRoot: absolutePathSchema,
  dataRoot: absolutePathSchema,
  installedWindowsRoot: absolutePathSchema,
  runtimeBootstrapRoot: absolutePathSchema,
  serviceUser: z.string().min(1).max(128).regex(/^[^"\r\n]+$/u),
  gamePort: z.number().int().min(1).max(65_535),
  workerTaskName: z.literal('Dyson-Control-Lifecycle-Broker'),
  workerTaskPath: z.literal(workerTaskPath),
  serverTask: fixedTaskSchema,
  stopTask: fixedTaskSchema,
  dependencyHashes: z.array(dependencySchema).length(dependencyNames.length),
  dispatchReadyTimeoutSeconds: z.number().int().min(5).max(60),
  createdAt: z.string().datetime({ offset: true })
}).superRefine((profile, context) => {
  if (profile.serverTask.name !== 'Dyson-Nebula-Server') {
    context.addIssue({ code: 'custom', path: ['serverTask', 'name'], message: 'server-task' })
  }
  if (profile.stopTask.name !== 'Dyson-Nebula-Stop') {
    context.addIssue({ code: 'custom', path: ['stopTask', 'name'], message: 'stop-task' })
  }
  if (new Set(profile.dependencyHashes.map((entry) => entry.name)).size !== dependencyNames.length ||
      dependencyNames.some((name, index) => profile.dependencyHashes[index]?.name !== name)) {
    context.addIssue({ code: 'custom', path: ['dependencyHashes'], message: 'dependency-set' })
  }
})

export type LifecycleBrokerProfile = Readonly<z.output<typeof profileSchema>>

export type LifecycleBrokerProfileErrorCode =
  | 'LIFECYCLE_BROKER_PROFILE_INPUT_INVALID'
  | 'LIFECYCLE_BROKER_PROFILE_UNAVAILABLE'
  | 'LIFECYCLE_BROKER_PROFILE_REDIRECTED'
  | 'LIFECYCLE_BROKER_PROFILE_SCHEMA_INVALID'
  | 'LIFECYCLE_BROKER_PROFILE_BINDING_MISMATCH'

export class LifecycleBrokerProfileError extends Error {
  readonly code: LifecycleBrokerProfileErrorCode

  constructor(code: LifecycleBrokerProfileErrorCode) {
    super(code)
    this.name = 'LifecycleBrokerProfileError'
    this.code = code
  }
}

export interface ReadLifecycleBrokerProfileOptions {
  profileFile: string
  scriptRoot: string
  projectRoot: string
  dataRoot: string
  runtimeBootstrapRoot: string
  serviceUser: string
  gamePort: number
}

/** Validate the immutable SYSTEM broker profile and every pinned dependency before readiness. */
export function readLifecycleBrokerProfile(
  options: ReadLifecycleBrokerProfileOptions
): LifecycleBrokerProfile {
  assertOptions(options)
  const dataRoot = plainDirectory(options.dataRoot)
  const brokerRoot = plainDirectory(path.join(dataRoot, 'lifecycle-broker'))
  const profileFile = plainFile(options.profileFile, maximumProfileBytes)
  if (!samePath(profileFile, path.join(brokerRoot, 'broker-profile.json'))) {
    throw new LifecycleBrokerProfileError('LIFECYCLE_BROKER_PROFILE_BINDING_MISMATCH')
  }

  let decoded: unknown
  try {
    decoded = JSON.parse(fs.readFileSync(profileFile, 'utf8')) as unknown
  } catch {
    throw new LifecycleBrokerProfileError('LIFECYCLE_BROKER_PROFILE_SCHEMA_INVALID')
  }
  const result = profileSchema.safeParse(decoded)
  if (!result.success || !hasExactOrderedKeys(decoded, profileKeys)) {
    throw new LifecycleBrokerProfileError('LIFECYCLE_BROKER_PROFILE_SCHEMA_INVALID')
  }
  const profile = result.data
  const raw = decoded as Record<string, unknown>
  if (!hasExactOrderedKeys(raw.serverTask, fixedTaskKeys) ||
      !hasExactOrderedKeys(raw.stopTask, fixedTaskKeys) ||
      !Array.isArray(raw.dependencyHashes) ||
      raw.dependencyHashes.some((entry) => !hasExactOrderedKeys(entry, dependencyKeys))) {
    throw new LifecycleBrokerProfileError('LIFECYCLE_BROKER_PROFILE_SCHEMA_INVALID')
  }

  const scriptRoot = plainDirectory(options.scriptRoot)
  const brokerScriptRoot = plainDirectory(path.join(scriptRoot, 'lifecycle-broker'))
  const projectRoot = plainDirectory(options.projectRoot)
  const runtimeBootstrapRoot = plainDirectory(options.runtimeBootstrapRoot)
  const bindings = [
    [profile.brokerRoot, brokerRoot],
    [profile.brokerScriptRoot, brokerScriptRoot],
    [profile.projectRoot, projectRoot],
    [profile.dataRoot, dataRoot],
    [profile.installedWindowsRoot, scriptRoot],
    [profile.runtimeBootstrapRoot, runtimeBootstrapRoot]
  ] as const
  if (bindings.some(([actual, expected]) => !samePath(actual, expected)) ||
      profile.serviceUser.toUpperCase() !== options.serviceUser.toUpperCase() ||
      profile.gamePort !== options.gamePort) {
    throw new LifecycleBrokerProfileError('LIFECYCLE_BROKER_PROFILE_BINDING_MISMATCH')
  }

  const expectedDependencies = new Map<string, string>([
    ['DysonLifecycleBroker.Common.ps1', path.join(brokerScriptRoot, 'DysonLifecycleBroker.Common.ps1')],
    ['DysonLifecycleBroker.TaskAcl.ps1', path.join(brokerScriptRoot, 'DysonLifecycleBroker.TaskAcl.ps1')],
    ['Install-DysonLifecycleBrokerTask.ps1', path.join(brokerScriptRoot, 'Install-DysonLifecycleBrokerTask.ps1')],
    ['Invoke-DysonLifecycleBrokerWorker.ps1', path.join(brokerScriptRoot, 'Invoke-DysonLifecycleBrokerWorker.ps1')],
    ['Submit-DysonLifecycleBrokerRequest.ps1', path.join(brokerScriptRoot, 'Submit-DysonLifecycleBrokerRequest.ps1')],
    ['DysonHostMutationLease.Common.ps1', path.join(scriptRoot, 'DysonHostMutationLease.Common.ps1')],
    ['Start-DysonServer.ps1', path.join(runtimeBootstrapRoot, 'Start-DysonServer.ps1')],
    ['Stop-DysonServer.ps1', path.join(runtimeBootstrapRoot, 'Stop-DysonServer.ps1')]
  ])
  for (const entry of profile.dependencyHashes) {
    const expectedPath = expectedDependencies.get(entry.name)
    if (!expectedPath || !samePath(entry.path, expectedPath)) {
      throw new LifecycleBrokerProfileError('LIFECYCLE_BROKER_PROFILE_BINDING_MISMATCH')
    }
    const dependency = plainFile(expectedPath, maximumDependencyBytes)
    if (sha256File(dependency) !== entry.sha256) {
      throw new LifecycleBrokerProfileError('LIFECYCLE_BROKER_PROFILE_BINDING_MISMATCH')
    }
  }
  return deepFreeze(profile)
}

function assertOptions(options: ReadLifecycleBrokerProfileOptions): void {
  if (!options || typeof options !== 'object' || !Number.isInteger(options.gamePort) ||
      options.gamePort < 1 || options.gamePort > 65_535 ||
      typeof options.serviceUser !== 'string' || !/^[^"\r\n]{1,128}$/u.test(options.serviceUser)) {
    throw new LifecycleBrokerProfileError('LIFECYCLE_BROKER_PROFILE_INPUT_INVALID')
  }
  for (const candidate of [
    options.profileFile, options.scriptRoot, options.projectRoot, options.dataRoot,
    options.runtimeBootstrapRoot
  ]) {
    if (typeof candidate !== 'string' || !path.isAbsolute(candidate) || /[\0\r\n"]/u.test(candidate)) {
      throw new LifecycleBrokerProfileError('LIFECYCLE_BROKER_PROFILE_INPUT_INVALID')
    }
  }
}

function plainDirectory(candidate: string): string {
  return plainPath(candidate, true, Number.MAX_SAFE_INTEGER)
}

function plainFile(candidate: string, maximumBytes: number): string {
  return plainPath(candidate, false, maximumBytes)
}

function plainPath(candidate: string, directory: boolean, maximumBytes: number): string {
  const resolved = path.resolve(candidate)
  try {
    const information = fs.lstatSync(resolved)
    if (information.isSymbolicLink() || (directory ? !information.isDirectory() : !information.isFile()) ||
        (!directory && (information.size < 2 || information.size > maximumBytes))) {
      throw new LifecycleBrokerProfileError('LIFECYCLE_BROKER_PROFILE_REDIRECTED')
    }
    const canonical = fs.realpathSync.native(resolved)
    if (!samePath(canonical, resolved)) {
      throw new LifecycleBrokerProfileError('LIFECYCLE_BROKER_PROFILE_REDIRECTED')
    }
    assertPlainAncestors(resolved)
    return canonical
  } catch (error) {
    if (error instanceof LifecycleBrokerProfileError) throw error
    throw new LifecycleBrokerProfileError('LIFECYCLE_BROKER_PROFILE_UNAVAILABLE')
  }
}

function assertPlainAncestors(candidate: string): void {
  let current = path.dirname(candidate)
  while (true) {
    const information = fs.lstatSync(current)
    if (information.isSymbolicLink() || !information.isDirectory()) {
      throw new LifecycleBrokerProfileError('LIFECYCLE_BROKER_PROFILE_REDIRECTED')
    }
    const parent = path.dirname(current)
    if (parent === current) return
    current = parent
  }
}

function sha256File(candidate: string): string {
  return createHash('sha256').update(fs.readFileSync(candidate)).digest('hex')
}

function samePath(left: string, right: string): boolean {
  return path.resolve(left).replace(/[\\/]+$/u, '').toUpperCase() ===
    path.resolve(right).replace(/[\\/]+$/u, '').toUpperCase()
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value)
    for (const nested of Object.values(value as Record<string, unknown>)) deepFreeze(nested)
  }
  return value
}

function hasExactOrderedKeys(value: unknown, expected: readonly string[]): boolean {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const keys = Object.keys(value)
  return keys.length === expected.length && keys.every((key, index) => key === expected[index])
}
