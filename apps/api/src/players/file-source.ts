import fs from 'node:fs/promises'
import path from 'node:path'
import {
  maximumPlayerSnapshotBytes,
  parsePlayerSnapshot,
  PlayerSnapshotError,
  type PlayerSnapshot
} from './protocol.js'

export interface FilePlayerSnapshotSourceOptions {
  controlRoot: string
  secretFile: string
  maximumAgeMs?: number
}

export class FilePlayerSnapshotSource {
  readonly #options: Required<FilePlayerSnapshotSourceOptions>

  constructor(options: FilePlayerSnapshotSourceOptions) {
    const controlRoot = path.resolve(options.controlRoot)
    if (!path.isAbsolute(options.controlRoot) || controlRoot === path.parse(controlRoot).root) {
      throw new PlayerSnapshotError('PLAYER_SNAPSHOT_ROOT_INVALID')
    }
    if (!path.isAbsolute(options.secretFile)) {
      throw new PlayerSnapshotError('PLAYER_SNAPSHOT_SECRET_PATH_INVALID')
    }
    const maximumAgeMs = options.maximumAgeMs ?? 10_000
    if (!Number.isInteger(maximumAgeMs) || maximumAgeMs < 2_000 || maximumAgeMs > 120_000) {
      throw new PlayerSnapshotError('PLAYER_SNAPSHOT_MAXIMUM_AGE_INVALID')
    }
    this.#options = { controlRoot, secretFile: path.resolve(options.secretFile), maximumAgeMs }
  }

  async read(signal?: AbortSignal): Promise<PlayerSnapshot> {
    signal?.throwIfAborted()
    await this.#assertDirectory(this.#options.controlRoot)
    const secret = await this.#readBoundedFile(this.#options.secretFile, 32, 1_024, 'SECRET')
    const snapshotPath = path.join(this.#options.controlRoot, 'players')
    const payload = await this.#readBoundedFile(
      snapshotPath, 1, maximumPlayerSnapshotBytes, 'FILE'
    )
    signal?.throwIfAborted()
    const snapshot = parsePlayerSnapshot(payload, secret)
    const ageMs = Date.now() - snapshot.writtenAtUnixMs
    if (ageMs < -5_000 || ageMs > this.#options.maximumAgeMs) {
      throw new PlayerSnapshotError('PLAYER_SNAPSHOT_STALE')
    }
    return snapshot
  }

  async #assertDirectory(directoryPath: string): Promise<void> {
    let stats
    try {
      stats = await fs.lstat(directoryPath)
    } catch {
      throw new PlayerSnapshotError('PLAYER_SNAPSHOT_DIRECTORY_UNAVAILABLE')
    }
    if (!stats.isDirectory() || stats.isSymbolicLink()) {
      throw new PlayerSnapshotError('PLAYER_SNAPSHOT_DIRECTORY_INVALID')
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
      throw new PlayerSnapshotError(`PLAYER_SNAPSHOT_${label}_UNAVAILABLE`)
    }
    if (!stats.isFile() || stats.isSymbolicLink() || stats.size < minimumBytes || stats.size > maximumBytes) {
      throw new PlayerSnapshotError(`PLAYER_SNAPSHOT_${label}_INVALID`)
    }
    try {
      return await fs.readFile(filePath, 'utf8')
    } catch {
      throw new PlayerSnapshotError(`PLAYER_SNAPSHOT_${label}_READ_FAILED`)
    }
  }
}
