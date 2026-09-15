import { createHash } from 'node:crypto'
import {
  gameConfigCatalog,
  gameConfigDefinitionById,
  normalizeGameConfigValue,
  type GameConfigDefinition,
  type GameConfigFileId,
  type GameConfigValue
} from './catalog.js'
import { applyBepInExPatches, findBepInExValue } from './bepinex.js'

export type GameConfigFiles = Record<GameConfigFileId, string | null>
export type PublicGameConfigValue = boolean | number | { configured: boolean }

export interface GameConfigSnapshotEntry {
  id: string
  file: GameConfigFileId
  label: string
  description: string
  activation: GameConfigDefinition['activation']
  type: GameConfigDefinition['type']
  minimum?: number
  maximum?: number
  allowed?: readonly number[]
  value: PublicGameConfigValue
  source: 'file' | 'default' | 'invalid'
}

export interface GameConfigSnapshot {
  revision: string
  entries: GameConfigSnapshotEntry[]
  invalidSettingIds: string[]
}

export interface GameConfigChangeRequest { id: string; value: unknown }

export interface GameConfigDiffEntry {
  id: string
  file: GameConfigFileId
  label: string
  activation: GameConfigDefinition['activation']
  before: PublicGameConfigValue
  after: PublicGameConfigValue
  changed: boolean
}

export interface GameConfigPlan {
  baseRevision: string
  nextRevision: string
  restartRequired: boolean
  newGameOnlyChanged: boolean
  diff: GameConfigDiffEntry[]
  files: GameConfigFiles
}

export function inspectGameConfiguration(files: GameConfigFiles): GameConfigSnapshot {
  const entries = gameConfigCatalog.map((definition) => inspectDefinition(files, definition))
  return {
    revision: revisionOf(files),
    entries,
    invalidSettingIds: entries.filter((entry) => entry.source === 'invalid').map((entry) => entry.id)
  }
}

export function planGameConfiguration(
  files: GameConfigFiles,
  expectedRevision: string,
  changes: readonly GameConfigChangeRequest[]
): GameConfigPlan {
  const current = inspectGameConfiguration(files)
  if (!/^[0-9a-f]{64}$/.test(expectedRevision) || expectedRevision !== current.revision) {
    throw new GameConfigPlanError('CONFIG_REVISION_CONFLICT')
  }
  if (changes.length < 1 || changes.length > 32) throw new GameConfigPlanError('CONFIG_CHANGE_COUNT_INVALID')

  const nextFiles: GameConfigFiles = { ...files }
  const normalized = new Map<string, GameConfigValue>()
  for (const change of changes) {
    if (typeof change.id !== 'string' || normalized.has(change.id)) {
      throw new GameConfigPlanError('CONFIG_CHANGE_DUPLICATE')
    }
    const definition = gameConfigDefinitionById.get(change.id)
    if (!definition) throw new GameConfigPlanError('CONFIG_SETTING_UNKNOWN')
    normalized.set(change.id, normalizeGameConfigValue(definition, change.value))
  }

  for (const fileId of ['nebula', 'galaxy', 'bepinex', 'bridge'] as const) {
    const patches = [...normalized].flatMap(([id, value]) => {
      const definition = gameConfigDefinitionById.get(id)!
      return definition.file === fileId
        ? [{ section: definition.section, key: definition.key, value: serializeValue(value) }]
        : []
    })
    if (patches.length > 0) nextFiles[fileId] = applyBepInExPatches(nextFiles[fileId] ?? '', patches)
  }

  const next = inspectGameConfiguration(nextFiles)
  const byId = new Map(current.entries.map((entry) => [entry.id, entry]))
  const diff = [...normalized.keys()].map((id): GameConfigDiffEntry => {
    const definition = gameConfigDefinitionById.get(id)!
    const before = byId.get(id)!
    const after = next.entries.find((entry) => entry.id === id)!
    const previousRaw = findBepInExValue(files[definition.file] ?? '', definition.section, definition.key)
      ?? serializeValue(definition.defaultValue)
    const nextRaw = findBepInExValue(nextFiles[definition.file] ?? '', definition.section, definition.key)
      ?? serializeValue(definition.defaultValue)
    return {
      id, file: after.file, label: after.label, activation: after.activation,
      before: before.value, after: after.value,
      changed: previousRaw !== nextRaw
    }
  })
  return {
    baseRevision: current.revision,
    nextRevision: next.revision,
    restartRequired: diff.some((entry) => entry.changed && entry.activation === 'server-restart'),
    newGameOnlyChanged: diff.some((entry) => entry.changed && entry.activation === 'new-game-only'),
    diff,
    files: nextFiles
  }
}

function inspectDefinition(files: GameConfigFiles, definition: GameConfigDefinition): GameConfigSnapshotEntry {
  const raw = findBepInExValue(files[definition.file] ?? '', definition.section, definition.key)
  let value: GameConfigValue = definition.defaultValue
  let source: GameConfigSnapshotEntry['source'] = raw === null ? 'default' : 'file'
  if (raw !== null) {
    try {
      value = parseStoredValue(definition, raw)
    } catch {
      source = 'invalid'
    }
  }
  return {
    id: definition.id,
    file: definition.file,
    label: definition.label,
    description: definition.description,
    activation: definition.activation,
    type: definition.type,
    ...(definition.minimum === undefined ? {} : { minimum: definition.minimum }),
    ...(definition.maximum === undefined ? {} : { maximum: definition.maximum }),
    ...(definition.allowed === undefined ? {} : { allowed: definition.allowed }),
    value: publicValue(definition, value),
    source
  }
}

function parseStoredValue(definition: GameConfigDefinition, raw: string): GameConfigValue {
  if (definition.type === 'secret') return normalizeGameConfigValue(definition, raw)
  if (definition.type === 'boolean') {
    if (/^true$/i.test(raw)) return true
    if (/^false$/i.test(raw)) return false
    return normalizeGameConfigValue(definition, raw)
  }
  if (!/^[+-]?(?:\d+\.?\d*|\.\d+)$/.test(raw)) return normalizeGameConfigValue(definition, raw)
  return normalizeGameConfigValue(definition, Number(raw))
}

function publicValue(definition: GameConfigDefinition, value: GameConfigValue): PublicGameConfigValue {
  return definition.type === 'secret' ? { configured: String(value).length > 0 } : value as boolean | number
}

function serializeValue(value: GameConfigValue): string {
  return typeof value === 'boolean' ? String(value).toLowerCase() : String(value)
}

function revisionOf(files: GameConfigFiles): string {
  const hash = createHash('sha256')
  for (const id of ['nebula', 'galaxy', 'bepinex', 'bridge'] as const) {
    hash.update(id).update('\0').update(files[id] ?? '<missing>').update('\0')
  }
  return hash.digest('hex')
}

export class GameConfigPlanError extends Error {
  constructor(readonly code: string) {
    super(code)
    this.name = 'GameConfigPlanError'
  }
}
