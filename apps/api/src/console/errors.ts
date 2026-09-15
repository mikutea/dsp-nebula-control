export type ConsoleLogErrorCode =
  | 'CONSOLE_LOG_ROOT_INVALID'
  | 'CONSOLE_LOG_ROOT_UNAVAILABLE'
  | 'CONSOLE_LOG_ROOT_REDIRECTED'
  | 'CONSOLE_LOG_FILE_UNAVAILABLE'
  | 'CONSOLE_LOG_FILE_REDIRECTED'
  | 'CONSOLE_LOG_FILE_INVALID'
  | 'CONSOLE_LOG_FILE_OUTSIDE_ROOT'
  | 'CONSOLE_LOG_FILE_TOO_LARGE'
  | 'CONSOLE_LOG_POLICY_INVALID'
  | 'CONSOLE_LOG_CURSOR_SECRET_INVALID'
  | 'CONSOLE_LOG_CURSOR_INVALID'
  | 'CONSOLE_LOG_CURSOR_SIGNATURE_INVALID'
  | 'CONSOLE_LOG_QUERY_INVALID'
  | 'CONSOLE_LOG_READ_FAILED'
  | 'CONSOLE_LOG_READ_ABORTED'
  | 'CONSOLE_LOG_DOWNLOAD_INVALID'

const messages: Record<ConsoleLogErrorCode, string> = {
  CONSOLE_LOG_ROOT_INVALID: 'The trusted server root is invalid.',
  CONSOLE_LOG_ROOT_UNAVAILABLE: 'The trusted server root is unavailable.',
  CONSOLE_LOG_ROOT_REDIRECTED: 'The trusted server root must not be redirected.',
  CONSOLE_LOG_FILE_UNAVAILABLE: 'The fixed BepInEx log is unavailable.',
  CONSOLE_LOG_FILE_REDIRECTED: 'The fixed BepInEx log must not be redirected.',
  CONSOLE_LOG_FILE_INVALID: 'The fixed BepInEx log is not a regular file.',
  CONSOLE_LOG_FILE_OUTSIDE_ROOT: 'The fixed BepInEx log resolved outside the trusted server root.',
  CONSOLE_LOG_FILE_TOO_LARGE: 'The fixed BepInEx log exceeds the configured file limit.',
  CONSOLE_LOG_POLICY_INVALID: 'The structured log reader policy is invalid.',
  CONSOLE_LOG_CURSOR_SECRET_INVALID: 'The console cursor secret is invalid.',
  CONSOLE_LOG_CURSOR_INVALID: 'The console cursor is invalid.',
  CONSOLE_LOG_CURSOR_SIGNATURE_INVALID: 'The console cursor signature is invalid.',
  CONSOLE_LOG_QUERY_INVALID: 'The structured log query is invalid.',
  CONSOLE_LOG_READ_FAILED: 'The fixed BepInEx log could not be read.',
  CONSOLE_LOG_READ_ABORTED: 'The structured log read was aborted.',
  CONSOLE_LOG_DOWNLOAD_INVALID: 'The structured log download plan is invalid.'
}

export class ConsoleLogError extends Error {
  readonly code: ConsoleLogErrorCode

  constructor(code: ConsoleLogErrorCode) {
    super(messages[code])
    this.name = 'ConsoleLogError'
    this.code = code
  }
}
