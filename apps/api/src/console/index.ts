export { ConsoleLogError, type ConsoleLogErrorCode } from './errors.js'
export { CONSOLE_LOG_LIMITS, FIXED_BEPINEX_LOG_SEGMENTS } from './limits.js'
export { StructuredLogCursorCodec, type StructuredLogCursorState } from './cursor.js'
export { parseStructuredLogLine, matchesStructuredLogFilters } from './parser.js'
export { redactStructuredLogSource, redactStructuredLogText } from './redaction.js'
export { normalizeStructuredLogFilters, normalizeStructuredLogReadRequest } from './query.js'
export { StructuredLogReader, type StructuredLogReaderOptions } from './reader.js'
export { createStructuredLogDownloadPlan, executeStructuredLogDownload } from './download.js'
export {
  ConsoleCommandError,
  consoleCommandExecutionRequestSchema,
  consoleCommandNames,
  consoleCommandPreviewRequestSchema,
  executeConsoleCommand,
  previewConsoleCommand,
  type ConsoleCommandConfirmation,
  type ConsoleCommandName,
  type ConsoleCommandPreview,
  type ConsoleLifecyclePort
} from './commands.js'
export type {
  NormalizedStructuredLogFilters,
  NormalizedStructuredLogReadRequest,
  StructuredLogDownload,
  StructuredLogDownloadPlan,
  StructuredLogDownloadRequest,
  StructuredLogEntry,
  StructuredLogFilters,
  StructuredLogLevel,
  StructuredLogPage,
  StructuredLogReadRequest,
  StructuredLogStart,
  StructuredLogTransition
} from './types.js'
