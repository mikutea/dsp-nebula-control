import { lstat, opendir, realpath } from 'node:fs/promises'
import path from 'node:path'
import { SaveCatalogError } from './errors.js'
import { MAX_DIRECTORY_ENTRIES, backupIdSchema } from './schemas.js'

export interface BoundedDirectoryEntry {
  name: string
  kind: 'file' | 'directory' | 'redirected' | 'other'
}

export async function resolveNormalDirectory(directoryPath: string): Promise<string> {
  const resolved = path.resolve(directoryPath)
  try {
    const metadata = await lstat(resolved)
    if (!metadata.isDirectory()) throw new SaveCatalogError('DIRECTORY_UNAVAILABLE')
    if (metadata.isSymbolicLink()) throw new SaveCatalogError('DIRECTORY_REDIRECTED')
    const physical = await realpath(resolved)
    if (!samePath(physical, resolved)) throw new SaveCatalogError('DIRECTORY_REDIRECTED')
    return resolved
  } catch (error) {
    if (error instanceof SaveCatalogError) throw error
    throw new SaveCatalogError('DIRECTORY_UNAVAILABLE')
  }
}

export async function readBoundedDirectory(
  directoryPath: string,
  maximumEntries = MAX_DIRECTORY_ENTRIES
): Promise<BoundedDirectoryEntry[]> {
  const root = await resolveNormalDirectory(directoryPath)
  const entries: BoundedDirectoryEntry[] = []
  const directory = await opendir(root)
  try {
    for await (const entry of directory) {
      if (entries.length >= maximumEntries) {
        throw new SaveCatalogError('DIRECTORY_ENTRY_LIMIT_EXCEEDED')
      }
      entries.push({
        name: entry.name,
        kind: entry.isSymbolicLink()
          ? 'redirected'
          : entry.isFile()
            ? 'file'
            : entry.isDirectory()
              ? 'directory'
              : 'other'
      })
    }
  } finally {
    await directory.close().catch(() => undefined)
  }
  return entries
}

export function safeImmediateChild(root: string, childName: string): string {
  if (!childName || childName === '.' || childName === '..' ||
      childName.includes('/') || childName.includes('\\') || path.isAbsolute(childName)) {
    throw new SaveCatalogError('INVALID_BACKUP_ID')
  }
  const resolvedRoot = path.resolve(root)
  const candidate = path.resolve(resolvedRoot, childName)
  if (!samePath(path.dirname(candidate), resolvedRoot)) {
    throw new SaveCatalogError('INVALID_BACKUP_ID')
  }
  return candidate
}

export async function resolveNormalBackupDirectory(root: string, backupId: string): Promise<string> {
  const parsedId = backupIdSchema.safeParse(backupId)
  if (!parsedId.success) throw new SaveCatalogError('INVALID_BACKUP_ID')
  const resolvedRoot = await resolveNormalDirectory(root)
  return resolveNormalDirectory(safeImmediateChild(resolvedRoot, parsedId.data))
}

function samePath(left: string, right: string): boolean {
  const normalize = (value: string): string => path.resolve(value).replace(/[\\/]+$/, '').toLocaleLowerCase('en-US')
  return normalize(left) === normalize(right)
}
