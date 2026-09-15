export type SaveCatalogErrorCode =
  | 'DIRECTORY_UNAVAILABLE'
  | 'DIRECTORY_REDIRECTED'
  | 'DIRECTORY_ENTRY_LIMIT_EXCEEDED'
  | 'INVALID_CURSOR'
  | 'INVALID_BACKUP_ID'

export class SaveCatalogError extends Error {
  readonly code: SaveCatalogErrorCode

  constructor(code: SaveCatalogErrorCode) {
    super(code)
    this.name = 'SaveCatalogError'
    this.code = code
  }
}
