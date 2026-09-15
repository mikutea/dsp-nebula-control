import { createHash } from 'node:crypto'
import { lstat, realpath } from 'node:fs/promises'
import path from 'node:path'
import { readBoundedDirectory, resolveNormalDirectory, safeImmediateChild } from './boundary.js'
import { decodeCatalogCursor, encodeCatalogCursor } from './cursor.js'
import {
  MAX_DIRECTORY_ENTRIES,
  saveCatalogPageSchema,
  saveCatalogQuerySchema,
  saveNameSchema,
  type SaveCatalogPage,
  type SavePairCatalogItem,
  type SavePairIssue
} from './schemas.js'

export interface SaveCatalogOptions {
  saveRoot: string
  query?: unknown
  now?: Date
  maximumDirectoryEntries?: number
}

interface PairCandidate {
  name: string
  dsvEntry: string | null
  dsvKind: 'file' | 'redirected' | 'other' | null
  serverEntry: string | null
  serverKind: 'file' | 'redirected' | 'other' | null
}

interface FileMetadata {
  bytes: number
  modifiedAt: string
}

export async function catalogSavePairs(options: SaveCatalogOptions): Promise<SaveCatalogPage> {
  const query = saveCatalogQuerySchema.parse(options.query ?? {})
  const offset = decodeCatalogCursor(query.cursor)
  const saveRoot = await resolveNormalDirectory(options.saveRoot)
  const entries = await readBoundedDirectory(
    saveRoot,
    options.maximumDirectoryEntries ?? MAX_DIRECTORY_ENTRIES
  )
  const pairs = new Map<string, PairCandidate>()
  let rejectedEntryCount = 0

  for (const entry of entries) {
    const extension = path.extname(entry.name).toLocaleLowerCase('en-US')
    if (extension !== '.dsv' && extension !== '.server') continue
    const name = entry.name.slice(0, -extension.length)
    if (!saveNameSchema.safeParse(name).success) {
      rejectedEntryCount += 1
      continue
    }
    const candidate = pairs.get(name) ?? {
      name,
      dsvEntry: null,
      dsvKind: null,
      serverEntry: null,
      serverKind: null
    }
    const kind = entry.kind === 'file' || entry.kind === 'redirected' ? entry.kind : 'other'
    if (extension === '.dsv') {
      candidate.dsvEntry = entry.name
      candidate.dsvKind = kind
    } else {
      candidate.serverEntry = entry.name
      candidate.serverKind = kind
    }
    pairs.set(name, candidate)
  }

  const ordered = [...pairs.values()].sort((left, right) => compareNames(left.name, right.name))
  const selected = ordered.slice(offset, offset + query.pageSize)
  const items = await Promise.all(selected.map((candidate) => inspectPair(saveRoot, candidate)))
  const nextOffset = offset + items.length
  const nextCursor = nextOffset < ordered.length ? encodeCatalogCursor(nextOffset) : null

  return saveCatalogPageSchema.parse({
    schemaVersion: 1,
    kind: 'saves',
    generatedAt: (options.now ?? new Date()).toISOString(),
    items,
    page: {
      limit: query.pageSize,
      returned: items.length,
      totalUnits: ordered.length,
      nextCursor
    },
    rejectedEntryCount
  })
}

async function inspectPair(root: string, candidate: PairCandidate): Promise<SavePairCatalogItem> {
  const issues: SavePairIssue[] = []
  const dsv = await inspectFile(root, candidate.dsvEntry, candidate.dsvKind, 'dsv', issues)
  const server = await inspectFile(root, candidate.serverEntry, candidate.serverKind, 'server', issues)
  if (dsv?.bytes === 0) issues.push('empty-dsv')
  if (server?.bytes === 0) issues.push('empty-server')

  const incomplete = issues.some((issue) => issue === 'missing-dsv' || issue === 'missing-server')
  const health = issues.length === 0 ? 'healthy' : incomplete ? 'incomplete' : 'corrupt'
  const timestamps = [dsv?.modifiedAt, server?.modifiedAt].filter((value): value is string => Boolean(value))
  const lastModifiedAt = timestamps.sort().at(-1) ?? null

  return {
    id: createHash('sha256').update(`save-pair-v1\0${candidate.name}`, 'utf8').digest('hex'),
    name: candidate.name,
    health,
    issues,
    dsv,
    server,
    lastModifiedAt,
    totalBytes: (dsv?.bytes ?? 0) + (server?.bytes ?? 0)
  }
}

async function inspectFile(
  root: string,
  entryName: string | null,
  kind: PairCandidate['dsvKind'],
  role: 'dsv' | 'server',
  issues: SavePairIssue[]
): Promise<FileMetadata | null> {
  if (entryName === null || kind === null) {
    issues.push(role === 'dsv' ? 'missing-dsv' : 'missing-server')
    return null
  }
  if (kind === 'redirected') {
    issues.push(role === 'dsv' ? 'redirected-dsv' : 'redirected-server')
    return null
  }
  if (kind !== 'file') {
    issues.push(role === 'dsv' ? 'unreadable-dsv' : 'unreadable-server')
    return null
  }

  try {
    const filePath = safeImmediateChild(root, entryName)
    const metadata = await lstat(filePath)
    if (metadata.isSymbolicLink()) {
      issues.push(role === 'dsv' ? 'redirected-dsv' : 'redirected-server')
      return null
    }
    if (!metadata.isFile() || !samePath(await realpath(filePath), filePath)) {
      issues.push(role === 'dsv' ? 'unreadable-dsv' : 'unreadable-server')
      return null
    }
    return { bytes: metadata.size, modifiedAt: metadata.mtime.toISOString() }
  } catch {
    issues.push(role === 'dsv' ? 'unreadable-dsv' : 'unreadable-server')
    return null
  }
}

function compareNames(left: string, right: string): number {
  const normalizedLeft = left.toLocaleLowerCase('en-US')
  const normalizedRight = right.toLocaleLowerCase('en-US')
  if (normalizedLeft < normalizedRight) return -1
  if (normalizedLeft > normalizedRight) return 1
  return left < right ? -1 : left > right ? 1 : 0
}

function samePath(left: string, right: string): boolean {
  const normalize = (value: string): string => path.resolve(value).replace(/[\\/]+$/, '').toLocaleLowerCase('en-US')
  return normalize(left) === normalize(right)
}
