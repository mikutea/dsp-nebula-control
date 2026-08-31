import fs from 'node:fs/promises'
import path from 'node:path'
import {
  maximumPlayerCapabilityBytes,
  parsePlayerCapabilitySnapshot,
  PlayerCapabilityError,
  type PlayerCapabilitySnapshot
} from './capabilities.js'

export interface FilePlayerCapabilitySourceOptions {
  controlRoot: string
  secretFile: string
  maximumAgeMs?: number
}

/** Reads only the fixed, signed capability declaration emitted by the local bridge. */
export class FilePlayerCapabilitySource {
  readonly #options: Required<FilePlayerCapabilitySourceOptions>

  constructor(options: FilePlayerCapabilitySourceOptions) {
    const controlRoot = path.resolve(options.controlRoot)
    if (!path.isAbsolute(options.controlRoot) || controlRoot === path.parse(controlRoot).root) {
      throw new PlayerCapabilityError('PLAYER_CAPABILITY_ROOT_INVALID')
    }
    if (!path.isAbsolute(options.secretFile)) {
      throw new PlayerCapabilityError('PLAYER_CAPABILITY_SECRET_PATH_INVALID')
    }
    const maximumAgeMs = options.maximumAgeMs ?? 10_000
    if (!Number.isInteger(maximumAgeMs) || maximumAgeMs < 2_000 || maximumAgeMs > 120_000) {
      throw new PlayerCapabilityError('PLAYER_CAPABILITY_MAXIMUM_AGE_INVALID')
    }
    this.#options = { controlRoot, secretFile: path.resolve(options.secretFile), maximumAgeMs }
  }

  async read(signal?: AbortSignal): Promise<PlayerCapabilitySnapshot> {
    signal?.throwIfAborted()
    await this.#assertDirectory(this.#options.controlRoot)
    const secret = await this.#readBoundedFile(this.#options.secretFile, 32, 1_024, 'SECRET')
    const payload = await this.#readBoundedFile(
      path.join(this.#options.controlRoot, 'player-capabilities'),
      1,
      maximumPlayerCapabilityBytes,
      'FILE'
    )
    signal?.throwIfAborted()
    const snapshot = parsePlayerCapabilitySnapshot(payload, secret)
    const ageMs = Date.now() - snapshot.writtenAtUnixMs
    if (ageMs < -5_000 || ageMs > this.#options.maximumAgeMs) {
      throw new PlayerCapabilityError('PLAYER_CAPABILITY_STALE')
    }
    return snapshot
  }

  async #assertDirectory(directoryPath: string): Promise<void> {
    let stats
    try {
      stats = await fs.lstat(directoryPath)
    } catch {
      throw new PlayerCapabilityError('PLAYER_CAPABILITY_DIRECTORY_UNAVAILABLE')
    }
    if (!stats.isDirectory() || stats.isSymbolicLink()) {
      throw new PlayerCapabilityError('PLAYER_CAPABILITY_DIRECTORY_INVALID')
    }
  }

  async #readBoundedFile(
    filePath: string,
    minimumBytes: number,
    maximumBytes: number,
    label: 'SECRET' | 'FILE'
  ): Promise<string> {
    let stats
    try {
      stats = await fs.lstat(filePath)
    } catch {
      throw new PlayerCapabilityError(`PLAYER_CAPABILITY_${label}_UNAVAILABLE`)
    }
    if (!stats.isFile() || stats.isSymbolicLink() || stats.size < minimumBytes || stats.size > maximumBytes) {
      throw new PlayerCapabilityError(`PLAYER_CAPABILITY_${label}_INVALID`)
    }
    try {
      return await fs.readFile(filePath, 'utf8')
    } catch {
      throw new PlayerCapabilityError(`PLAYER_CAPABILITY_${label}_READ_FAILED`)
    }
  }
}
