import { constants } from 'node:fs'
import { lstat, open, realpath } from 'node:fs/promises'
import path from 'node:path'

export const CLIENT_QUALIFICATION_DOCUMENT_NAMES = [
  'qualification',
  'source-patch-contract',
  'private-build-contract',
  'binary-metadata-a',
  'binary-metadata-b',
  'candidate-manifest',
  'client-manifest',
  'external-client-receipts',
  'profile-input'
] as const

export type ClientQualificationDocumentName = typeof CLIENT_QUALIFICATION_DOCUMENT_NAMES[number]

export interface ProtectedClientQualificationStore {
  readDocument(qualificationId: string, name: ClientQualificationDocumentName): Promise<Uint8Array>
  readCandidateFile(qualificationId: string, relativePath: string): Promise<Uint8Array>
  readClientFile(qualificationId: string, relativePath: string): Promise<Uint8Array>
  readClientPackage(qualificationId: string): Promise<Uint8Array>
  resolveHmacKey(keyId: string): Promise<Uint8Array | null>
}

export interface FileSystemClientQualificationLayout {
  qualification: string
  sourcePatchContract: string
  privateBuildContract: string
  binaryMetadataA: string
  binaryMetadataB: string
  candidateManifest: string
  clientManifest: string
  externalClientReceipts: string
  profileInput: string
  candidateRoot: string
  clientRoot: string
  clientPackage: string
}

export interface FileSystemClientQualificationStoreOptions {
  protectedRoot: string
  protectedKeyRingRoot: string
  layout?: Partial<FileSystemClientQualificationLayout>
  maxDocumentBytes?: number
  maxFileBytes?: number
  maxPackageBytes?: number
}

const DEFAULT_LAYOUT: FileSystemClientQualificationLayout = {
  qualification: 'qualification.json',
  sourcePatchContract: 'source-patch-contract.json',
  privateBuildContract: 'private-build-contract.json',
  binaryMetadataA: 'binary-metadata-a.json',
  binaryMetadataB: 'binary-metadata-b.json',
  candidateManifest: 'candidate-manifest.json',
  clientManifest: 'client-manifest.json',
  externalClientReceipts: 'external-client-receipts.json',
  profileInput: 'profile-input.json',
  candidateRoot: 'candidate',
  clientRoot: 'client',
  clientPackage: 'client-package.zip'
}

const QUALIFICATION_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const KEY_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{6,126}[a-z0-9]$/
const DEFAULT_MAX_DOCUMENT_BYTES = 8 * 1024 * 1024
const DEFAULT_MAX_FILE_BYTES = 256 * 1024 * 1024
const DEFAULT_MAX_PACKAGE_BYTES = 1024 * 1024 * 1024

export class ClientQualificationStoreError extends Error {
  readonly code: string

  constructor(code: string) {
    super(code)
    this.name = 'ClientQualificationStoreError'
    this.code = code
  }
}

/**
 * Read-only store rooted at a server-selected directory. HTTP request data can
 * select only a canonical qualification UUID; it can never select a path or a
 * signing key. ACL validation remains an installer responsibility.
 */
export class FileSystemClientQualificationStore implements ProtectedClientQualificationStore {
  readonly #root: string
  readonly #rootRealPath: string
  readonly #keyRingRoot: string
  readonly #keyRingRealPath: string
  readonly #layout: FileSystemClientQualificationLayout
  readonly #maxDocumentBytes: number
  readonly #maxFileBytes: number
  readonly #maxPackageBytes: number

  private constructor(
    options: FileSystemClientQualificationStoreOptions,
    root: string,
    rootRealPath: string,
    keyRingRoot: string,
    keyRingRealPath: string,
    layout: FileSystemClientQualificationLayout
  ) {
    this.#root = root
    this.#rootRealPath = rootRealPath
    this.#keyRingRoot = keyRingRoot
    this.#keyRingRealPath = keyRingRealPath
    this.#layout = layout
    this.#maxDocumentBytes = boundedLimit(options.maxDocumentBytes, DEFAULT_MAX_DOCUMENT_BYTES)
    this.#maxFileBytes = boundedLimit(options.maxFileBytes, DEFAULT_MAX_FILE_BYTES)
    this.#maxPackageBytes = boundedLimit(options.maxPackageBytes, DEFAULT_MAX_PACKAGE_BYTES)
  }

  static async open(options: FileSystemClientQualificationStoreOptions): Promise<FileSystemClientQualificationStore> {
    if (!path.isAbsolute(options.protectedRoot)) fail('CLIENT_QUALIFICATION_ROOT_INVALID')
    const configuredRoot = path.resolve(options.protectedRoot)
    const rootStat = await safeLstat(configuredRoot, 'CLIENT_QUALIFICATION_ROOT_INVALID')
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) fail('CLIENT_QUALIFICATION_ROOT_INVALID')
    const rootRealPath = await safeRealpath(configuredRoot, 'CLIENT_QUALIFICATION_ROOT_INVALID')
    const root = rootRealPath
    if (!path.isAbsolute(options.protectedKeyRingRoot)) fail('CLIENT_QUALIFICATION_KEY_RING_INVALID')
    const configuredKeyRingRoot = path.resolve(options.protectedKeyRingRoot)
    const keyRingStat = await safeLstat(configuredKeyRingRoot, 'CLIENT_QUALIFICATION_KEY_RING_INVALID')
    if (!keyRingStat.isDirectory() || keyRingStat.isSymbolicLink()) fail('CLIENT_QUALIFICATION_KEY_RING_INVALID')
    const keyRingRealPath = await safeRealpath(configuredKeyRingRoot, 'CLIENT_QUALIFICATION_KEY_RING_INVALID')
    const keyRingRoot = keyRingRealPath
    if (pathWithin(root, keyRingRoot) || pathWithin(keyRingRoot, root)) {
      fail('CLIENT_QUALIFICATION_KEY_RING_INVALID')
    }

    const layout = { ...DEFAULT_LAYOUT, ...options.layout }
    for (const entry of Object.values(layout)) assertSafeRelativePath(entry)
    return new FileSystemClientQualificationStore(
      options, root, rootRealPath, keyRingRoot, keyRingRealPath, layout)
  }

  async readDocument(qualificationId: string, name: ClientQualificationDocumentName): Promise<Uint8Array> {
    const directory = this.#qualificationDirectory(qualificationId)
    const fileName: Record<ClientQualificationDocumentName, string> = {
      qualification: this.#layout.qualification,
      'source-patch-contract': this.#layout.sourcePatchContract,
      'private-build-contract': this.#layout.privateBuildContract,
      'binary-metadata-a': this.#layout.binaryMetadataA,
      'binary-metadata-b': this.#layout.binaryMetadataB,
      'candidate-manifest': this.#layout.candidateManifest,
      'client-manifest': this.#layout.clientManifest,
      'external-client-receipts': this.#layout.externalClientReceipts,
      'profile-input': this.#layout.profileInput
    }
    if (!CLIENT_QUALIFICATION_DOCUMENT_NAMES.includes(name)) fail('CLIENT_QUALIFICATION_DOCUMENT_INVALID')
    return await this.#readBounded(path.join(directory, fileName[name]), this.#maxDocumentBytes)
  }

  async readCandidateFile(qualificationId: string, relativePath: string): Promise<Uint8Array> {
    assertSafeRelativePath(relativePath)
    return await this.#readBounded(
      path.join(this.#qualificationDirectory(qualificationId), this.#layout.candidateRoot, ...relativePath.split('/')),
      this.#maxFileBytes
    )
  }

  async readClientFile(qualificationId: string, relativePath: string): Promise<Uint8Array> {
    assertSafeRelativePath(relativePath)
    return await this.#readBounded(
      path.join(this.#qualificationDirectory(qualificationId), this.#layout.clientRoot, ...relativePath.split('/')),
      this.#maxFileBytes
    )
  }

  async readClientPackage(qualificationId: string): Promise<Uint8Array> {
    return await this.#readBounded(
      path.join(this.#qualificationDirectory(qualificationId), this.#layout.clientPackage),
      this.#maxPackageBytes
    )
  }

  async resolveHmacKey(keyId: string): Promise<Uint8Array | null> {
    const stem = keyId.split('.', 1)[0] ?? ''
    if (!KEY_ID_PATTERN.test(keyId) || keyId.includes('..') ||
        /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(stem)) return null
    try {
      const key = await this.#readBounded(
        path.join(this.#keyRingRoot, `${keyId}.key`), 32, this.#keyRingRoot, this.#keyRingRealPath)
      if (key.byteLength !== 32) {
        key.fill(0)
        fail('CLIENT_QUALIFICATION_HMAC_KEY_INVALID')
      }
      return key
    } catch (error) {
      if (error instanceof ClientQualificationStoreError &&
          error.code === 'CLIENT_QUALIFICATION_MATERIAL_UNAVAILABLE') return null
      throw error
    }
  }

  #qualificationDirectory(qualificationId: string): string {
    assertQualificationId(qualificationId)
    return path.join(this.#root, qualificationId)
  }

  async #readBounded(
    candidate: string,
    maximumBytes: number,
    parent = this.#root,
    parentRealPath = this.#rootRealPath
  ): Promise<Uint8Array> {
    const absolute = path.resolve(candidate)
    if (!pathWithin(absolute, parent)) fail('CLIENT_QUALIFICATION_PATH_ESCAPE')
    const stat = await safeLstat(absolute, 'CLIENT_QUALIFICATION_MATERIAL_UNAVAILABLE')
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 1 || stat.size > maximumBytes) {
      fail('CLIENT_QUALIFICATION_MATERIAL_INVALID')
    }
    const resolved = await safeRealpath(absolute, 'CLIENT_QUALIFICATION_MATERIAL_UNAVAILABLE')
    if (!pathWithin(resolved, parentRealPath) || !samePath(absolute, resolved)) {
      fail('CLIENT_QUALIFICATION_PATH_ESCAPE')
    }

    let handle
    try {
      handle = await open(absolute, constants.O_RDONLY)
      const openedStat = await handle.stat()
      if (!openedStat.isFile() || openedStat.size !== stat.size || openedStat.size > maximumBytes) {
        fail('CLIENT_QUALIFICATION_MATERIAL_CHANGED')
      }
      const bytes = await handle.readFile()
      const finalStat = await handle.stat()
      if (bytes.byteLength !== openedStat.size || finalStat.size !== openedStat.size ||
          finalStat.mtimeMs !== openedStat.mtimeMs || finalStat.ctimeMs !== openedStat.ctimeMs) {
        fail('CLIENT_QUALIFICATION_MATERIAL_CHANGED')
      }
      return bytes
    } catch (error) {
      if (error instanceof ClientQualificationStoreError) throw error
      return fail('CLIENT_QUALIFICATION_MATERIAL_UNAVAILABLE')
    } finally {
      await handle?.close().catch(() => undefined)
    }
  }
}

export function assertQualificationId(value: string): void {
  if (!QUALIFICATION_ID_PATTERN.test(value)) fail('CLIENT_QUALIFICATION_ID_INVALID')
}

export function assertSafeRelativePath(value: string): void {
  if (typeof value !== 'string' || value.length < 1 || value.length > 512 || value.includes('\\') ||
      value.startsWith('/') || value.endsWith('/') || value.includes('//') || /^[A-Za-z]:/.test(value)) {
    fail('CLIENT_QUALIFICATION_RELATIVE_PATH_INVALID')
  }
  const segments = value.split('/')
  if (segments.some((segment) => segment.length === 0 || segment === '.' || segment === '..' ||
      segment.length > 255 || segment.endsWith(' ') || segment.endsWith('.') ||
      /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(segment) ||
      !/^[A-Za-z0-9][A-Za-z0-9 ._+@()-]*$/.test(segment))) {
    fail('CLIENT_QUALIFICATION_RELATIVE_PATH_INVALID')
  }
}

function boundedLimit(value: number | undefined, fallback: number): number {
  const selected = value ?? fallback
  if (!Number.isSafeInteger(selected) || selected < 1 || selected > 2 * 1024 * 1024 * 1024) {
    fail('CLIENT_QUALIFICATION_STORE_LIMIT_INVALID')
  }
  return selected
}

async function safeLstat(value: string, code: string): Promise<Awaited<ReturnType<typeof lstat>>> {
  try {
    return await lstat(value)
  } catch {
    return fail(code)
  }
}

async function safeRealpath(value: string, code: string): Promise<string> {
  try {
    return await realpath(value)
  } catch {
    return fail(code)
  }
}

function pathWithin(candidate: string, parent: string): boolean {
  const relative = path.relative(parent, candidate)
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
}

function samePath(left: string, right: string): boolean {
  return process.platform === 'win32'
    ? path.resolve(left).toLowerCase() === path.resolve(right).toLowerCase()
    : path.resolve(left) === path.resolve(right)
}

function fail(code: string): never {
  throw new ClientQualificationStoreError(code)
}
