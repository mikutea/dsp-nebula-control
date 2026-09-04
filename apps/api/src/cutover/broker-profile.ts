import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { z } from 'zod'

const maximumProfileBytes = 32 * 1024
const maximumScriptBytes = 2 * 1024 * 1024
const sha256Schema = z.string().regex(/^[0-9a-f]{64}$/)
const absolutePathSchema = z.string().min(3).max(1_024).refine((value) =>
  path.isAbsolute(value) && !/[\0\r\n"]/u.test(value)
)

const brokerProfileSchema = z.strictObject({
  protocol: z.literal('DYSON_CONTROL_CUTOVER_BROKER_PROFILE_V1'),
  schemaVersion: z.literal(1),
  brokerRoot: absolutePathSchema,
  brokerScriptRoot: absolutePathSchema,
  projectRoot: absolutePathSchema,
  dataRoot: absolutePathSchema,
  authorityProfileFile: absolutePathSchema,
  authorityProfileSha256: sha256Schema,
  cutoverScriptRoot: absolutePathSchema,
  leaseCommonSha256: sha256Schema,
  cutoverHostCommonSha256: sha256Schema,
  cutoverActionScriptSha256: sha256Schema,
  runtimeTaskInstallerSha256: sha256Schema,
  runtimeBootstrapRoot: absolutePathSchema,
  runtimeTaskTransactionRoot: absolutePathSchema,
  serviceUser: z.string().min(3).max(128).regex(/^[^"\r\n]+$/u),
  gamePort: z.number().int().min(1).max(65_535),
  taskName: z.literal('Dyson-Control-Cutover-Broker'),
  taskPath: z.literal('\\'),
  localServiceSid: z.literal('S-1-5-19'),
  commonScriptSha256: sha256Schema,
  taskAclScriptSha256: sha256Schema,
  installerScriptSha256: sha256Schema,
  workerScriptSha256: sha256Schema,
  submitScriptSha256: sha256Schema,
  profileFingerprint: sha256Schema
})

export type CutoverBrokerProfile = Readonly<z.output<typeof brokerProfileSchema>>

export type CutoverBrokerProfileErrorCode =
  | 'CUTOVER_BROKER_PROFILE_INPUT_INVALID'
  | 'CUTOVER_BROKER_PROFILE_UNAVAILABLE'
  | 'CUTOVER_BROKER_PROFILE_REDIRECTED'
  | 'CUTOVER_BROKER_PROFILE_SCHEMA_INVALID'
  | 'CUTOVER_BROKER_PROFILE_BINDING_MISMATCH'
  | 'CUTOVER_BROKER_PROFILE_FINGERPRINT_INVALID'

export class CutoverBrokerProfileError extends Error {
  readonly code: CutoverBrokerProfileErrorCode

  constructor(code: CutoverBrokerProfileErrorCode) {
    super(code)
    this.name = 'CutoverBrokerProfileError'
    this.code = code
  }
}

export interface ReadCutoverBrokerProfileOptions {
  profileFile: string
  scriptRoot: string
  projectRoot: string
  dataRoot: string
  authorityProfileFile: string
  runtimeBootstrapRoot: string
  runtimeTaskTransactionRoot: string
  serviceUser: string
  gamePort: number
}

/**
 * Revalidates the host-installed immutable broker profile before the API starts.
 * The privileged worker repeats these checks at dispatch time; this read-side
 * check prevents readiness from reporting success when the broker is absent or
 * its fixed code/profile bindings have drifted.
 */
export function readCutoverBrokerProfile(
  options: ReadCutoverBrokerProfileOptions
): CutoverBrokerProfile {
  assertOptions(options)
  const dataRoot = plainDirectory(options.dataRoot)
  const expectedBrokerRoot = path.join(dataRoot, 'cutover-broker')
  const brokerRoot = plainDirectory(expectedBrokerRoot)
  const expectedProfileFile = path.join(brokerRoot, 'broker-profile.json')
  const profileFile = plainFile(options.profileFile, maximumProfileBytes)
  if (!samePath(profileFile, expectedProfileFile)) {
    throw new CutoverBrokerProfileError('CUTOVER_BROKER_PROFILE_BINDING_MISMATCH')
  }

  let decoded: unknown
  try {
    decoded = JSON.parse(fs.readFileSync(profileFile, 'utf8')) as unknown
  } catch {
    throw new CutoverBrokerProfileError('CUTOVER_BROKER_PROFILE_SCHEMA_INVALID')
  }
  const parsed = brokerProfileSchema.safeParse(decoded)
  if (!parsed.success) {
    throw new CutoverBrokerProfileError('CUTOVER_BROKER_PROFILE_SCHEMA_INVALID')
  }
  const profile = parsed.data

  const scriptRoot = plainDirectory(options.scriptRoot)
  const brokerScriptRoot = plainDirectory(path.join(scriptRoot, 'cutover-broker'))
  const projectRoot = plainDirectory(options.projectRoot)
  const authorityProfileFile = plainFile(options.authorityProfileFile, maximumProfileBytes)
  const runtimeBootstrapRoot = plainDirectory(options.runtimeBootstrapRoot)
  const runtimeTaskTransactionRoot = plainDirectory(options.runtimeTaskTransactionRoot)
  const pathBindings = [
    [profile.brokerRoot, brokerRoot],
    [profile.brokerScriptRoot, brokerScriptRoot],
    [profile.projectRoot, projectRoot],
    [profile.dataRoot, dataRoot],
    [profile.authorityProfileFile, authorityProfileFile],
    [profile.cutoverScriptRoot, scriptRoot],
    [profile.runtimeBootstrapRoot, runtimeBootstrapRoot],
    [profile.runtimeTaskTransactionRoot, runtimeTaskTransactionRoot]
  ] as const
  if (pathBindings.some(([actual, expected]) => !samePath(actual, expected)) ||
      profile.serviceUser.toUpperCase() !== options.serviceUser.toUpperCase() ||
      profile.gamePort !== options.gamePort) {
    throw new CutoverBrokerProfileError('CUTOVER_BROKER_PROFILE_BINDING_MISMATCH')
  }

  const fileBindings = [
    [profile.authorityProfileSha256, authorityProfileFile],
    [profile.leaseCommonSha256, path.join(scriptRoot, 'DysonHostMutationLease.Common.ps1')],
    [profile.cutoverHostCommonSha256, path.join(scriptRoot, 'cutover', 'DysonCutoverHost.Common.ps1')],
    [profile.cutoverActionScriptSha256, path.join(scriptRoot, 'cutover', 'Invoke-DysonCutoverAction.ps1')],
    [profile.runtimeTaskInstallerSha256, path.join(scriptRoot, 'Install-DysonRuntimeTasks.ps1')],
    [profile.commonScriptSha256, path.join(brokerScriptRoot, 'DysonCutoverBroker.Common.ps1')],
    [profile.taskAclScriptSha256, path.join(brokerScriptRoot, 'DysonCutoverBroker.TaskAcl.ps1')],
    [profile.installerScriptSha256, path.join(brokerScriptRoot, 'Install-DysonCutoverBrokerTask.ps1')],
    [profile.workerScriptSha256, path.join(brokerScriptRoot, 'Invoke-DysonCutoverBrokerWorker.ps1')],
    [profile.submitScriptSha256, path.join(brokerScriptRoot, 'Submit-DysonCutoverBrokerRequest.ps1')]
  ] as const
  for (const [expected, candidate] of fileBindings) {
    const file = plainFile(candidate, maximumScriptBytes)
    if (sha256File(file) !== expected) {
      throw new CutoverBrokerProfileError('CUTOVER_BROKER_PROFILE_BINDING_MISMATCH')
    }
  }

  const { profileFingerprint: _profileFingerprint, ...core } = profile
  if (sha256Text(JSON.stringify(core)) !== profile.profileFingerprint) {
    throw new CutoverBrokerProfileError('CUTOVER_BROKER_PROFILE_FINGERPRINT_INVALID')
  }
  return deepFreeze(profile)
}

function assertOptions(options: ReadCutoverBrokerProfileOptions): void {
  if (!options || typeof options !== 'object' ||
      !Number.isInteger(options.gamePort) || options.gamePort < 1 || options.gamePort > 65_535 ||
      typeof options.serviceUser !== 'string' || !/^[^"\r\n]{3,128}$/u.test(options.serviceUser)) {
    throw new CutoverBrokerProfileError('CUTOVER_BROKER_PROFILE_INPUT_INVALID')
  }
  for (const candidate of [
    options.profileFile,
    options.scriptRoot,
    options.projectRoot,
    options.dataRoot,
    options.authorityProfileFile,
    options.runtimeBootstrapRoot,
    options.runtimeTaskTransactionRoot
  ]) {
    if (typeof candidate !== 'string' || !path.isAbsolute(candidate) || /[\0\r\n"]/u.test(candidate)) {
      throw new CutoverBrokerProfileError('CUTOVER_BROKER_PROFILE_INPUT_INVALID')
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
      throw new CutoverBrokerProfileError('CUTOVER_BROKER_PROFILE_REDIRECTED')
    }
    const canonical = fs.realpathSync.native(resolved)
    if (!samePath(canonical, resolved)) {
      throw new CutoverBrokerProfileError('CUTOVER_BROKER_PROFILE_REDIRECTED')
    }
    assertPlainAncestors(resolved)
    return canonical
  } catch (error) {
    if (error instanceof CutoverBrokerProfileError) throw error
    throw new CutoverBrokerProfileError('CUTOVER_BROKER_PROFILE_UNAVAILABLE')
  }
}

function assertPlainAncestors(candidate: string): void {
  let current = path.dirname(candidate)
  while (true) {
    const information = fs.lstatSync(current)
    if (information.isSymbolicLink() || !information.isDirectory()) {
      throw new CutoverBrokerProfileError('CUTOVER_BROKER_PROFILE_REDIRECTED')
    }
    const parent = path.dirname(current)
    if (parent === current) return
    current = parent
  }
}

function sha256File(candidate: string): string {
  return createHash('sha256').update(fs.readFileSync(candidate)).digest('hex')
}

function sha256Text(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex')
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
