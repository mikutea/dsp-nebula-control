import { lstat, readFile, realpath } from 'node:fs/promises'
import path from 'node:path'
import type { GameConfigFileId } from './catalog.js'
import type { GameConfigFiles } from './planner.js'

const configFileNames: Record<GameConfigFileId, string> = {
  nebula: 'nebula.cfg',
  galaxy: 'nebulaGameDescSettings.cfg',
  bepinex: 'BepInEx.cfg',
  bridge: 'io.github.mikutea.dyson-control-bridge.cfg'
}

export async function readGameConfigurationFiles(configRoot: string): Promise<GameConfigFiles> {
  const resolvedRoot = path.resolve(configRoot)
  const rootMetadata = await lstat(resolvedRoot).catch(() => null)
  if (!rootMetadata?.isDirectory() || rootMetadata.isSymbolicLink() ||
      !samePath(await realpath(resolvedRoot), resolvedRoot)) {
    throw new GameConfigFilesystemError('CONFIG_ROOT_UNAVAILABLE')
  }
  const entries = await Promise.all(
    (Object.entries(configFileNames) as Array<[GameConfigFileId, string]>).map(async ([id, fileName]) => {
      const filePath = path.resolve(resolvedRoot, fileName)
      if (!samePath(path.dirname(filePath), resolvedRoot)) throw new GameConfigFilesystemError('CONFIG_FILE_REDIRECTED')
      const metadata = await lstat(filePath).catch((error: unknown) => isMissing(error) ? null : Promise.reject(error))
      if (metadata === null) return [id, null] as const
      if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > 512 * 1024 ||
          !samePath(await realpath(filePath), filePath)) {
        throw new GameConfigFilesystemError('CONFIG_FILE_INVALID')
      }
      const content = await readFile(filePath, 'utf8')
      if (content.includes('\0')) throw new GameConfigFilesystemError('CONFIG_FILE_INVALID')
      return [id, content] as const
    })
  )
  return Object.fromEntries(entries) as GameConfigFiles
}

export class GameConfigFilesystemError extends Error {
  constructor(readonly code: 'CONFIG_ROOT_UNAVAILABLE' | 'CONFIG_FILE_REDIRECTED' | 'CONFIG_FILE_INVALID') {
    super(code)
    this.name = 'GameConfigFilesystemError'
  }
}

function samePath(left: string, right: string): boolean {
  const normalize = (value: string): string => path.resolve(value).replace(/[\\/]+$/, '').toLocaleLowerCase('en-US')
  return normalize(left) === normalize(right)
}

function isMissing(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT'
}
