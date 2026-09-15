import { SaveCatalogError } from './errors.js'
import { MAX_DIRECTORY_ENTRIES } from './schemas.js'

export function encodeCatalogCursor(offset: number): string {
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > MAX_DIRECTORY_ENTRIES) {
    throw new SaveCatalogError('INVALID_CURSOR')
  }
  return Buffer.from(`v1:${offset}`, 'utf8').toString('base64url')
}

export function decodeCatalogCursor(cursor: string | null): number {
  if (cursor === null) return 0
  try {
    const decoded = Buffer.from(cursor, 'base64url').toString('utf8')
    if (!/^v1:(0|[1-9][0-9]{0,4})$/.test(decoded)) throw new Error('invalid')
    const offset = Number(decoded.slice(3))
    if (offset > MAX_DIRECTORY_ENTRIES || encodeCatalogCursor(offset) !== cursor) throw new Error('invalid')
    return offset
  } catch {
    throw new SaveCatalogError('INVALID_CURSOR')
  }
}
