import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { z } from 'zod'

const maximumProfileBytes = 128 * 1024
const maximumManagedScriptBytes = 4 * 1024 * 1024
const sha256Schema = z.string().regex(/^[0-9a-f]{64}$/)
const pathIdentitySchema = z.string().regex(/^sha256:[0-9a-f]{64}$/)
const requestIdSchema = z.string().uuid().transform((value) => value.toLowerCase())

const taskSchema = z.strictObject({
  taskName: z.string().min(1).max(128),
  taskPath: z.literal('\\'),
  definitionSha256: sha256Schema,
  enabled: z.literal(true)
})

const profileSchema = z.strictObject({
  protocol: z.literal('DYSON_GSMANAGER_AUTHORITY_PROFILE_V1'),
  schemaVersion: z.literal(1),
  requestId: requestIdSchema,
  requestFingerprint: sha256Schema,
  projectRootIdentity: pathIdentitySchema,
  dataRootIdentity: pathIdentitySchema,
  authorityRootIdentity: pathIdentitySchema,
  runtimeBootstrapIdentity: pathIdentitySchema,
  runtimeBootstrapStartSha256: sha256Schema,
  runtimeBootstrapStopSha256: sha256Schema,
  runtimeTaskTransactionRootIdentity: pathIdentitySchema,
  serviceUser: z.string().min(3).max(128).regex(/^[^"\r\n]+$/),
  gamePort: z.number().int().min(1).max(65_535),
  previousAuthority: z.strictObject({
    main: taskSchema.extend({ taskName: z.literal('Dyson-GSManager') }),
    start: taskSchema.extend({ taskName: z.literal('Dyson-GSManager-Server') }),
    stop: taskSchema.extend({ taskName: z.literal('Dyson-GSManager-Stop') })
  }),
  candidateAuthority: z.strictObject({
    startTaskName: z.literal('Dyson-Nebula-Server'),
    stopTaskName: z.literal('Dyson-Nebula-Stop'),
    taskPath: z.literal('\\'),
    legacyPreimage: z.strictObject({
      startDefinitionSha256: sha256Schema,
      stopDefinitionSha256: sha256Schema,
      expectedEnabledBeforeIsolation: z.literal(true),
      expectedEnabledAfterIsolation: z.literal(false)
    }),
    expectedPreparedDisabled: z.strictObject({
      startDescriptorSha256: sha256Schema,
      stopDescriptorSha256: sha256Schema
    }),
    expectedActive: z.strictObject({
      startDescriptorSha256: sha256Schema,
      stopDescriptorSha256: sha256Schema
    }),
    allowedTransitions: z.tuple([
      z.literal('legacy-preimage-disabled'),
      z.literal('prepared-disabled'),
      z.literal('active')
    ])
  }),
  previousScriptBundleRevision: sha256Schema,
  inventoryRevision: sha256Schema
})

export type CutoverAuthorityProfile = Readonly<z.output<typeof profileSchema>>

export type CutoverAuthorityProfileErrorCode =
  | 'CUTOVER_PROFILE_INPUT_INVALID'
  | 'CUTOVER_PROFILE_UNAVAILABLE'
  | 'CUTOVER_PROFILE_REDIRECTED'
  | 'CUTOVER_PROFILE_SCHEMA_INVALID'
  | 'CUTOVER_PROFILE_BINDING_MISMATCH'
  | 'CUTOVER_PROFILE_REVISION_INVALID'

export class CutoverAuthorityProfileError extends Error {
  readonly code: CutoverAuthorityProfileErrorCode

  constructor(code: CutoverAuthorityProfileErrorCode) {
    super(code)
    this.name = 'CutoverAuthorityProfileError'
    this.code = code
  }
}

export interface ReadCutoverAuthorityProfileOptions {
  profileFile: string
  projectRoot: string
  dataRoot: string
  runtimeBootstrapRoot: string
  runtimeTaskTransactionRoot: string
  serviceUser: string
  gamePort: number
}

/** Reads one fixed, host-generated profile and revalidates every local binding. */
export function readCutoverAuthorityProfile(
  options: ReadCutoverAuthorityProfileOptions
): CutoverAuthorityProfile {
  assertOptions(options)
  const dataRoot = plainDirectory(options.dataRoot)
  const expectedProfile = path.join(dataRoot, 'authority-inventory', 'authority-profile.json')
  const profileFile = plainFile(options.profileFile, maximumProfileBytes)
  if (!samePath(profileFile, expectedProfile)) {
    throw new CutoverAuthorityProfileError('CUTOVER_PROFILE_BINDING_MISMATCH')
  }

  let decoded: unknown
  try {
    const bytes = fs.readFileSync(profileFile)
    decoded = JSON.parse(bytes.toString('utf8')) as unknown
  } catch {
    throw new CutoverAuthorityProfileError('CUTOVER_PROFILE_SCHEMA_INVALID')
  }
  const parsed = profileSchema.safeParse(decoded)
  if (!parsed.success) throw new CutoverAuthorityProfileError('CUTOVER_PROFILE_SCHEMA_INVALID')
  const profile = parsed.data

  const projectRoot = plainDirectory(options.projectRoot)
  const runtimeBootstrapRoot = plainDirectory(options.runtimeBootstrapRoot)
  const runtimeTaskTransactionRoot = plainDirectory(options.runtimeTaskTransactionRoot)
  const profileRoot = plainDirectory(path.dirname(profileFile))
  const bindings = [
    [profile.projectRootIdentity, identity(projectRoot)],
    [profile.dataRootIdentity, identity(dataRoot)],
    [profile.authorityRootIdentity, identity(profileRoot)],
    [profile.runtimeBootstrapIdentity, identity(runtimeBootstrapRoot)],
    [profile.runtimeTaskTransactionRootIdentity, identity(runtimeTaskTransactionRoot)]
  ] as const
  if (bindings.some(([actual, expected]) => actual !== expected) ||
      profile.serviceUser.toUpperCase() !== options.serviceUser.toUpperCase() ||
      profile.gamePort !== options.gamePort) {
    throw new CutoverAuthorityProfileError('CUTOVER_PROFILE_BINDING_MISMATCH')
  }

  const bootstrapStart = plainFile(path.join(runtimeBootstrapRoot, 'Start-DysonServer.ps1'), maximumManagedScriptBytes)
  const bootstrapStop = plainFile(path.join(runtimeBootstrapRoot, 'Stop-DysonServer.ps1'), maximumManagedScriptBytes)
  const previousStart = plainFile(
    path.join(dataRoot, 'private', 'gsmanager-authority', 'start-dyson-server.ps1'),
    maximumManagedScriptBytes
  )
  const previousStop = plainFile(
    path.join(dataRoot, 'private', 'gsmanager-authority', 'stop-dyson-server.ps1'),
    maximumManagedScriptBytes
  )
  const previousBundleRevision = sha256Text(`${sha256File(previousStart)}:${sha256File(previousStop)}`)
  if (profile.runtimeBootstrapStartSha256 !== sha256File(bootstrapStart) ||
      profile.runtimeBootstrapStopSha256 !== sha256File(bootstrapStop) ||
      profile.previousScriptBundleRevision !== previousBundleRevision) {
    throw new CutoverAuthorityProfileError('CUTOVER_PROFILE_BINDING_MISMATCH')
  }

  const { inventoryRevision: _inventoryRevision, ...revisionCore } = profile
  if (profile.inventoryRevision !== sha256Text(JSON.stringify(revisionCore))) {
    throw new CutoverAuthorityProfileError('CUTOVER_PROFILE_REVISION_INVALID')
  }
  return deepFreeze(profile)
}

function assertOptions(options: ReadCutoverAuthorityProfileOptions): void {
  if (!options || typeof options !== 'object' ||
      !Number.isInteger(options.gamePort) || options.gamePort < 1 || options.gamePort > 65_535 ||
      typeof options.serviceUser !== 'string' || !/^[^"\r\n]{3,128}$/.test(options.serviceUser)) {
    throw new CutoverAuthorityProfileError('CUTOVER_PROFILE_INPUT_INVALID')
  }
  for (const candidate of [
    options.profileFile,
    options.projectRoot,
    options.dataRoot,
    options.runtimeBootstrapRoot,
    options.runtimeTaskTransactionRoot
  ]) {
    if (typeof candidate !== 'string' || !path.isAbsolute(candidate) || /[\0\r\n]/.test(candidate)) {
      throw new CutoverAuthorityProfileError('CUTOVER_PROFILE_INPUT_INVALID')
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
      throw new CutoverAuthorityProfileError('CUTOVER_PROFILE_REDIRECTED')
    }
    const canonical = fs.realpathSync.native(resolved)
    if (!samePath(canonical, resolved)) {
      throw new CutoverAuthorityProfileError('CUTOVER_PROFILE_REDIRECTED')
    }
    assertPlainAncestors(resolved)
    return canonical
  } catch (error) {
    if (error instanceof CutoverAuthorityProfileError) throw error
    throw new CutoverAuthorityProfileError('CUTOVER_PROFILE_UNAVAILABLE')
  }
}

function assertPlainAncestors(candidate: string): void {
  let current = path.dirname(candidate)
  while (true) {
    const information = fs.lstatSync(current)
    if (information.isSymbolicLink() || !information.isDirectory()) {
      throw new CutoverAuthorityProfileError('CUTOVER_PROFILE_REDIRECTED')
    }
    const parent = path.dirname(current)
    if (parent === current) return
    current = parent
  }
}

function identity(candidate: string): string {
  return `sha256:${sha256Text(candidate.replace(/[\\/]+$/, '').toUpperCase())}`
}

function sha256File(candidate: string): string {
  return createHash('sha256').update(fs.readFileSync(candidate)).digest('hex')
}

function sha256Text(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

function samePath(left: string, right: string): boolean {
  return path.resolve(left).replace(/[\\/]+$/, '').toUpperCase() ===
    path.resolve(right).replace(/[\\/]+$/, '').toUpperCase()
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value)
    for (const nested of Object.values(value as Record<string, unknown>)) deepFreeze(nested)
  }
  return value
}
