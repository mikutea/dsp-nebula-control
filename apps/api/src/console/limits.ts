export const CONSOLE_LOG_LIMITS = Object.freeze({
  absoluteMaximumFileBytes: 2 * 1024 * 1024 * 1024,
  defaultMaximumFileBytes: 512 * 1024 * 1024,
  absoluteMaximumLineBytes: 64 * 1024,
  defaultMaximumLineBytes: 32 * 1024,
  absoluteMaximumReadBytes: 1024 * 1024,
  defaultReadBytes: 256 * 1024,
  minimumReadBytes: 512,
  absoluteMaximumResults: 500,
  defaultResults: 200,
  maximumCursorCharacters: 1024,
  maximumSourceFilterCharacters: 128,
  maximumTextFilterCharacters: 256,
  maximumDownloadResults: 2_000,
  defaultDownloadResults: 1_000,
  maximumDownloadOutputBytes: 4 * 1024 * 1024,
  defaultDownloadOutputBytes: 2 * 1024 * 1024,
  maximumDownloadScanBytes: 16 * 1024 * 1024,
  defaultDownloadScanBytes: 8 * 1024 * 1024,
  maximumDownloadPages: 64,
  cursorAnchorBytes: 64
})

export const FIXED_BEPINEX_LOG_SEGMENTS = Object.freeze(['BepInEx', 'LogOutput.log'] as const)
