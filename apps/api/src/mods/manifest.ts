import { createHash } from 'node:crypto'
import { z } from 'zod'
import { normalizeVersion, sha256Schema, sourceIdSchema } from '../updates/version.js'
import { parseThunderstoreDependency, thunderstoreDependencyIdSchema } from './dependency.js'
import {
  modResolutionInputSchema,
  resolveModGraph,
  type ClientModRequirement,
  type ModResolutionIssue
} from './resolver.js'

export interface ServerModLockEntry {
  dependencyId: string
  sourceId: string
  version: string
  sha256: string
  dependencies: string[]
  loadOrder: number
  root: boolean
  serverRequired: boolean
  clientRequirement: ClientModRequirement
}

export interface ServerModLock {
  format: 'dyson-control-server-mod-lock'
  schemaVersion: 1
  mods: ServerModLockEntry[]
}

export interface ClientParityEntry {
  sourceId: string
  version: string
  sha256: string
  serverRequired: boolean
  clientRequirement: ClientModRequirement
}

export interface ClientParityManifest {
  format: 'dyson-control-client-parity'
  schemaVersion: 1
  serverLockSha256: string
  mods: ClientParityEntry[]
}

export interface GeneratedModManifests {
  serverLock: ServerModLock
  serverLockSha256: string
  clientParity: ClientParityManifest
}

export class ModManifestError extends Error {
  readonly code: string
  readonly issues: ModResolutionIssue[]

  constructor(code: string, issues: ModResolutionIssue[] = []) {
    super(code)
    this.name = 'ModManifestError'
    this.code = code
    this.issues = issues
  }
}

const requirementSchema = z.enum(['required', 'optional', 'not-required'])
const serverModLockEntrySchema = z.strictObject({
  dependencyId: thunderstoreDependencyIdSchema,
  sourceId: sourceIdSchema,
  version: z.string().min(1).max(64),
  sha256: sha256Schema,
  dependencies: z.array(thunderstoreDependencyIdSchema).max(64),
  loadOrder: z.number().int().nonnegative().max(511),
  root: z.boolean(),
  serverRequired: z.boolean(),
  clientRequirement: requirementSchema
})

export const serverModLockSchema: z.ZodType<ServerModLock> = z.strictObject({
  format: z.literal('dyson-control-server-mod-lock'),
  schemaVersion: z.literal(1),
  mods: z.array(serverModLockEntrySchema).min(1).max(512)
})

const clientParityEntrySchema = z.strictObject({
  sourceId: sourceIdSchema,
  version: z.string().min(1).max(64),
  sha256: sha256Schema,
  serverRequired: z.boolean(),
  clientRequirement: requirementSchema
})

export const clientParityManifestSchema: z.ZodType<ClientParityManifest> = z.strictObject({
  format: z.literal('dyson-control-client-parity'),
  schemaVersion: z.literal(1),
  serverLockSha256: sha256Schema,
  mods: z.array(clientParityEntrySchema).min(1).max(512)
})

export function generateModManifests(input: unknown): GeneratedModManifests {
  modResolutionInputSchema.parse(input)
  const resolution = resolveModGraph(input)
  if (!resolution.ok) throw new ModManifestError('MOD_GRAPH_UNRESOLVED', resolution.issues)

  const serverLock: ServerModLock = {
    format: 'dyson-control-server-mod-lock',
    schemaVersion: 1,
    mods: resolution.mods.map((mod) => {
      if (mod.loadOrder === null) throw new ModManifestError('MOD_LOAD_ORDER_MISSING')
      return {
        dependencyId: mod.dependencyId,
        sourceId: mod.sourceId,
        version: mod.version,
        sha256: mod.sha256,
        dependencies: mod.dependencies,
        loadOrder: mod.loadOrder,
        root: mod.root,
        serverRequired: mod.serverRequired,
        clientRequirement: mod.clientRequirement
      }
    })
  }
  validateServerLock(serverLock)
  const serverLockSha256 = sha256(canonicalJson(serverLock))
  const clientParity: ClientParityManifest = {
    format: 'dyson-control-client-parity',
    schemaVersion: 1,
    serverLockSha256,
    mods: serverLock.mods.map((mod) => ({
      sourceId: mod.sourceId,
      version: mod.version,
      sha256: mod.sha256,
      serverRequired: mod.serverRequired,
      clientRequirement: mod.clientRequirement
    }))
  }
  validateClientParity(clientParity)
  return { serverLock, serverLockSha256, clientParity }
}

export function validateServerLock(input: unknown): ServerModLock {
  const lock = serverModLockSchema.parse(input)
  assertUnique(lock.mods.map((mod) => mod.sourceId.toLowerCase()), 'MOD_LOCK_SOURCE_DUPLICATE')
  assertUnique(lock.mods.map((mod) => mod.dependencyId.toLowerCase()), 'MOD_LOCK_DEPENDENCY_DUPLICATE')
  const orders = lock.mods.map((mod) => mod.loadOrder).sort((left, right) => left - right)
  if (!orders.every((value, index) => value === index)) throw new ModManifestError('MOD_LOCK_ORDER_INVALID')
  if (lock.mods.some((mod, index) => mod.loadOrder !== index)) throw new ModManifestError('MOD_LOCK_ORDER_INVALID')
  const dependencies = new Map(lock.mods.map((mod) => [mod.dependencyId.toLowerCase(), mod]))
  for (const mod of lock.mods) {
    if (!mod.serverRequired && mod.clientRequirement === 'not-required') {
      throw new ModManifestError('MOD_LOCK_REQUIREMENT_INVALID')
    }
    const identity = parseThunderstoreDependency(mod.dependencyId)
    if (identity.sourceId.toLowerCase() !== mod.sourceId.toLowerCase() || identity.version !== mod.version) {
      throw new ModManifestError('MOD_LOCK_IDENTITY_MISMATCH')
    }
    if (normalizeVersion(mod.version, 'plugin') !== mod.version || mod.sha256 !== mod.sha256.toLowerCase()) {
      throw new ModManifestError('MOD_LOCK_VALUE_NOT_NORMALIZED')
    }
    assertUnique(mod.dependencies.map((dependency) => dependency.toLowerCase()), 'MOD_LOCK_DEPENDENCY_DUPLICATE')
    if (mod.dependencies.some((dependency, index) => index > 0 && dependency <= mod.dependencies[index - 1]!)) {
      throw new ModManifestError('MOD_LOCK_DEPENDENCY_ORDER_INVALID')
    }
    for (const dependencyId of mod.dependencies) {
      const dependency = dependencies.get(dependencyId.toLowerCase())
      if (dependency === undefined) throw new ModManifestError('MOD_LOCK_DEPENDENCY_MISSING')
      if (dependency.loadOrder >= mod.loadOrder) throw new ModManifestError('MOD_LOCK_TOPOLOGY_INVALID')
    }
  }
  return lock
}

export function validateClientParity(input: unknown): ClientParityManifest {
  const manifest = clientParityManifestSchema.parse(input)
  assertUnique(manifest.mods.map((mod) => mod.sourceId.toLowerCase()), 'CLIENT_PARITY_SOURCE_DUPLICATE')
  if (manifest.serverLockSha256 !== manifest.serverLockSha256.toLowerCase()) {
    throw new ModManifestError('CLIENT_PARITY_VALUE_NOT_NORMALIZED')
  }
  for (const mod of manifest.mods) {
    if (!mod.serverRequired && mod.clientRequirement === 'not-required') {
      throw new ModManifestError('CLIENT_PARITY_REQUIREMENT_INVALID')
    }
    if (normalizeVersion(mod.version, 'plugin') !== mod.version || mod.sha256 !== mod.sha256.toLowerCase()) {
      throw new ModManifestError('CLIENT_PARITY_VALUE_NOT_NORMALIZED')
    }
  }
  return manifest
}

export function validateModManifestPair(
  serverLockInput: unknown,
  clientParityInput: unknown
): GeneratedModManifests {
  const serverLock = validateServerLock(serverLockInput)
  const clientParity = validateClientParity(clientParityInput)
  const serverLockSha256 = sha256(canonicalJson(serverLock))
  if (clientParity.serverLockSha256 !== serverLockSha256) {
    throw new ModManifestError('CLIENT_PARITY_LOCK_DIGEST_MISMATCH')
  }
  if (serverLock.mods.length !== clientParity.mods.length) {
    throw new ModManifestError('CLIENT_PARITY_ENTRY_MISMATCH')
  }
  for (let index = 0; index < serverLock.mods.length; index++) {
    const server = serverLock.mods[index]!
    const client = clientParity.mods[index]!
    if (server.sourceId !== client.sourceId || server.version !== client.version ||
        server.sha256 !== client.sha256 || server.serverRequired !== client.serverRequired ||
        server.clientRequirement !== client.clientRequirement) {
      throw new ModManifestError('CLIENT_PARITY_ENTRY_MISMATCH')
    }
  }
  return { serverLock, serverLockSha256, clientParity }
}

export function serializeServerModLock(input: unknown): string {
  return canonicalJson(validateServerLock(input))
}

export function serializeClientParityManifest(input: unknown): string {
  return `${JSON.stringify(validateClientParity(input), null, 2)}\n`
}

function canonicalJson(value: ServerModLock): string {
  return `${JSON.stringify(value, null, 2)}\n`
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

function assertUnique(values: readonly string[], code: string): void {
  if (new Set(values).size !== values.length) throw new ModManifestError(code)
}
