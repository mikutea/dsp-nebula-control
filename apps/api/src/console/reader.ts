import { createHash } from 'node:crypto'
import { lstat, open, realpath, type FileHandle } from 'node:fs/promises'
import type { Stats } from 'node:fs'
import path from 'node:path'
import { StructuredLogCursorCodec, type StructuredLogCursorState } from './cursor.js'
import { ConsoleLogError } from './errors.js'
import { CONSOLE_LOG_LIMITS, FIXED_BEPINEX_LOG_SEGMENTS } from './limits.js'
import { buildStructuredLogEntry, matchesStructuredLogFilters, parseStructuredLogLine } from './parser.js'
import { normalizeStructuredLogReadRequest } from './query.js'
import type {
  NormalizedStructuredLogReadRequest,
  StructuredLogEntry,
  StructuredLogPage,
  StructuredLogReadRequest,
  StructuredLogTransition
} from './types.js'

export interface StructuredLogReaderOptions {
  serverRoot: string
  cursorSecret: string | Buffer
  maximumFileBytes?: number
  maximumLineBytes?: number
  maximumReadBytes?: number
  maximumResults?: number
  now?: () => Date
}

interface ReaderPolicy {
  maximumFileBytes: number
  maximumLineBytes: number
  maximumReadBytes: number
  maximumResults: number
}

interface OpenedLog {
  handle: FileHandle
  fingerprint: string
  size: number
}

interface ScanOutcome {
  entries: StructuredLogEntry[]
  nextOffset: number
  skipRemainder: boolean
  partialLinePending: boolean
  filteredOut: number
}

export class StructuredLogReader {
  readonly #serverRoot: string
  readonly #cursorCodec: StructuredLogCursorCodec
  readonly #policy: ReaderPolicy
  readonly #now: () => Date

  constructor(options: StructuredLogReaderOptions) {
    const serverRoot = path.resolve(options.serverRoot)
    if (!path.isAbsolute(options.serverRoot) || samePath(serverRoot, path.parse(serverRoot).root)) {
      throw new ConsoleLogError('CONSOLE_LOG_ROOT_INVALID')
    }
    this.#serverRoot = serverRoot
    this.#cursorCodec = new StructuredLogCursorCodec(options.cursorSecret)
    this.#policy = Object.freeze({
      maximumFileBytes: boundedPolicyValue(
        options.maximumFileBytes,
        CONSOLE_LOG_LIMITS.defaultMaximumFileBytes,
        1,
        CONSOLE_LOG_LIMITS.absoluteMaximumFileBytes,
        'CONSOLE_LOG_POLICY_INVALID'
      ),
      maximumLineBytes: boundedPolicyValue(
        options.maximumLineBytes,
        CONSOLE_LOG_LIMITS.defaultMaximumLineBytes,
        256,
        CONSOLE_LOG_LIMITS.absoluteMaximumLineBytes,
        'CONSOLE_LOG_POLICY_INVALID'
      ),
      maximumReadBytes: boundedPolicyValue(
        options.maximumReadBytes,
        CONSOLE_LOG_LIMITS.absoluteMaximumReadBytes,
        CONSOLE_LOG_LIMITS.minimumReadBytes,
        CONSOLE_LOG_LIMITS.absoluteMaximumReadBytes,
        'CONSOLE_LOG_POLICY_INVALID'
      ),
      maximumResults: boundedPolicyValue(
        options.maximumResults,
        CONSOLE_LOG_LIMITS.absoluteMaximumResults,
        1,
        CONSOLE_LOG_LIMITS.absoluteMaximumResults,
        'CONSOLE_LOG_POLICY_INVALID'
      )
    })
    this.#now = options.now ?? (() => new Date())
  }

  get limits(): Readonly<ReaderPolicy> {
    return this.#policy
  }

  async read(input: StructuredLogReadRequest | unknown = {}, signal?: AbortSignal): Promise<StructuredLogPage> {
    assertNotAborted(signal)
    const request = normalizeStructuredLogReadRequest(input, {
      maximumReadBytes: this.#policy.maximumReadBytes,
      maximumResults: this.#policy.maximumResults
    })
    const opened = await this.#openFixedLog(signal)
    try {
      const initial = await this.#initialState(opened, request, signal)
      const buffer = Buffer.allocUnsafe(request.maxBytes)
      assertNotAborted(signal)
      const readResult = await opened.handle.read(buffer, 0, request.maxBytes, initial.state.offset)
      assertNotAborted(signal)
      const bytes = buffer.subarray(0, readResult.bytesRead)
      const scan = scanLogBytes({
        bytes,
        fileSizeAtOpen: opened.size,
        startOffset: initial.state.offset,
        skipRemainder: initial.state.skipRemainder,
        fingerprint: opened.fingerprint,
        generation: initial.state.generation,
        maximumLineBytes: this.#policy.maximumLineBytes,
        request
      })
      const postStats = await opened.handle.stat()
      if (postStats.size > this.#policy.maximumFileBytes) {
        throw new ConsoleLogError('CONSOLE_LOG_FILE_TOO_LARGE')
      }
      const nextAnchor = await readAnchor(opened.handle, scan.nextOffset, signal)
      const nextState: StructuredLogCursorState = {
        version: 1,
        fingerprint: opened.fingerprint,
        offset: scan.nextOffset,
        generation: initial.state.generation,
        skipRemainder: scan.skipRemainder,
        anchor: nextAnchor
      }
      const hasMore = !scan.partialLinePending && scan.nextOffset < postStats.size
      return {
        schemaVersion: 1,
        kind: 'bepinex-structured-log-page',
        observedAt: this.#now().toISOString(),
        entries: scan.entries,
        cursor: this.#cursorCodec.encode(nextState),
        generation: nextState.generation,
        transition: initial.transition,
        hasMore,
        partialLinePending: scan.partialLinePending,
        scannedBytes: readResult.bytesRead,
        filteredOut: scan.filteredOut,
        limits: {
          fileBytes: this.#policy.maximumFileBytes,
          lineBytes: this.#policy.maximumLineBytes,
          readBytes: request.maxBytes,
          results: request.limit
        },
        redactionVersion: 1
      }
    } catch (error) {
      if (error instanceof ConsoleLogError) throw error
      if (signal?.aborted) throw new ConsoleLogError('CONSOLE_LOG_READ_ABORTED')
      throw new ConsoleLogError('CONSOLE_LOG_READ_FAILED')
    } finally {
      await opened.handle.close().catch(() => undefined)
    }
  }

  async #initialState(
    opened: OpenedLog,
    request: NormalizedStructuredLogReadRequest,
    signal?: AbortSignal
  ): Promise<{ state: StructuredLogCursorState; transition: StructuredLogTransition }> {
    if (request.cursor === null) {
      const offset = request.start === 'tail' ? Math.max(0, opened.size - request.maxBytes) : 0
      return {
        state: {
          version: 1,
          fingerprint: opened.fingerprint,
          offset,
          generation: 0,
          skipRemainder: offset > 0,
          anchor: await readAnchor(opened.handle, offset, signal)
        },
        transition: request.start === 'tail' ? 'initial-tail' : 'initial-beginning'
      }
    }

    const cursor = this.#cursorCodec.decode(request.cursor)
    if (cursor.fingerprint !== opened.fingerprint) {
      return { state: resetCursor(opened.fingerprint, cursor.generation), transition: 'rotated' }
    }
    const anchorValid = cursor.offset <= opened.size
      && await verifyAnchor(opened.handle, cursor.offset, cursor.anchor, signal)
    if (!anchorValid) {
      return { state: resetCursor(opened.fingerprint, cursor.generation), transition: 'truncated' }
    }
    return { state: cursor, transition: 'none' }
  }

  async #openFixedLog(signal?: AbortSignal): Promise<OpenedLog> {
    assertNotAborted(signal)
    let rootStats: Stats
    try {
      rootStats = await lstat(this.#serverRoot)
    } catch {
      throw new ConsoleLogError('CONSOLE_LOG_ROOT_UNAVAILABLE')
    }
    if (rootStats.isSymbolicLink()) throw new ConsoleLogError('CONSOLE_LOG_ROOT_REDIRECTED')
    if (!rootStats.isDirectory()) throw new ConsoleLogError('CONSOLE_LOG_ROOT_UNAVAILABLE')

    let realRoot: string
    try {
      realRoot = await realpath(this.#serverRoot)
    } catch {
      throw new ConsoleLogError('CONSOLE_LOG_ROOT_UNAVAILABLE')
    }
    if (!samePath(realRoot, this.#serverRoot)) throw new ConsoleLogError('CONSOLE_LOG_ROOT_REDIRECTED')

    const bepInExRoot = path.join(this.#serverRoot, FIXED_BEPINEX_LOG_SEGMENTS[0])
    const logPath = path.join(bepInExRoot, FIXED_BEPINEX_LOG_SEGMENTS[1])
    let directoryStats: Stats
    let fileStats: Stats
    try {
      directoryStats = await lstat(bepInExRoot)
      fileStats = await lstat(logPath)
    } catch {
      throw new ConsoleLogError('CONSOLE_LOG_FILE_UNAVAILABLE')
    }
    if (directoryStats.isSymbolicLink() || fileStats.isSymbolicLink()) {
      throw new ConsoleLogError('CONSOLE_LOG_FILE_REDIRECTED')
    }
    if (!directoryStats.isDirectory() || !fileStats.isFile()) {
      throw new ConsoleLogError('CONSOLE_LOG_FILE_INVALID')
    }

    let realDirectory: string
    let realLog: string
    try {
      [realDirectory, realLog] = await Promise.all([realpath(bepInExRoot), realpath(logPath)])
    } catch {
      throw new ConsoleLogError('CONSOLE_LOG_FILE_UNAVAILABLE')
    }
    if (!insideRoot(realRoot, realDirectory) || !insideRoot(realRoot, realLog)) {
      throw new ConsoleLogError('CONSOLE_LOG_FILE_OUTSIDE_ROOT')
    }
    if (!samePath(realDirectory, bepInExRoot) || !samePath(realLog, logPath)) {
      throw new ConsoleLogError('CONSOLE_LOG_FILE_REDIRECTED')
    }
    if (fileStats.size > this.#policy.maximumFileBytes) {
      throw new ConsoleLogError('CONSOLE_LOG_FILE_TOO_LARGE')
    }

    let handle: FileHandle
    try {
      handle = await open(realLog, 'r')
    } catch {
      throw new ConsoleLogError('CONSOLE_LOG_READ_FAILED')
    }
    try {
      const openedStats = await handle.stat()
      if (!openedStats.isFile()) throw new ConsoleLogError('CONSOLE_LOG_FILE_INVALID')
      if (openedStats.size > this.#policy.maximumFileBytes) {
        throw new ConsoleLogError('CONSOLE_LOG_FILE_TOO_LARGE')
      }
      if (fileFingerprint(openedStats) !== fileFingerprint(fileStats)) {
        throw new ConsoleLogError('CONSOLE_LOG_READ_FAILED')
      }
      return { handle, fingerprint: fileFingerprint(openedStats), size: openedStats.size }
    } catch (error) {
      await handle.close().catch(() => undefined)
      if (error instanceof ConsoleLogError) throw error
      throw new ConsoleLogError('CONSOLE_LOG_READ_FAILED')
    }
  }
}

function scanLogBytes(options: {
  bytes: Buffer
  fileSizeAtOpen: number
  startOffset: number
  skipRemainder: boolean
  fingerprint: string
  generation: number
  maximumLineBytes: number
  request: NormalizedStructuredLogReadRequest
}): ScanOutcome {
  const entries: StructuredLogEntry[] = []
  let filteredOut = 0
  let index = 0
  let nextOffset = options.startOffset
  let skipRemainder = options.skipRemainder
  let partialLinePending = false

  if (skipRemainder) {
    const newline = options.bytes.indexOf(0x0a, index)
    if (newline === -1) {
      return {
        entries,
        nextOffset: options.startOffset + options.bytes.length,
        skipRemainder: true,
        partialLinePending: false,
        filteredOut
      }
    }
    index = newline + 1
    nextOffset = options.startOffset + index
    skipRemainder = false
  }

  while (index < options.bytes.length) {
    const lineStartIndex = index
    const newline = options.bytes.indexOf(0x0a, lineStartIndex)
    if (newline === -1) {
      const knownMoreBytes = options.startOffset + options.bytes.length < options.fileSizeAtOpen
      const remaining = options.bytes.subarray(lineStartIndex)
      if (remaining.length > options.maximumLineBytes || knownMoreBytes) {
        const capped = trimCarriageReturn(remaining.subarray(0, options.maximumLineBytes))
        appendParsed(capped, true, options.startOffset + lineStartIndex,
          options.startOffset + options.bytes.length)
        nextOffset = options.startOffset + options.bytes.length
        skipRemainder = true
      } else {
        nextOffset = options.startOffset + lineStartIndex
        partialLinePending = remaining.length > 0
      }
      break
    }

    const rawLine = options.bytes.subarray(lineStartIndex, newline)
    const line = trimCarriageReturn(rawLine.subarray(0, options.maximumLineBytes))
    const lineEndOffset = options.startOffset + newline + 1
    appendParsed(line, rawLine.length > options.maximumLineBytes,
      options.startOffset + lineStartIndex, lineEndOffset)
    index = newline + 1
    nextOffset = lineEndOffset
    if (entries.length >= options.request.limit) {
      break
    }
  }

  return {
    entries,
    nextOffset,
    skipRemainder,
    partialLinePending,
    filteredOut
  }

  function appendParsed(line: Buffer, truncated: boolean, startOffset: number, endOffset: number): void {
    const parsed = parseStructuredLogLine(line.toString('utf8'))
    if (parsed === null) return
    if (!matchesStructuredLogFilters(parsed, options.request.filters)) {
      filteredOut += 1
      return
    }
    entries.push(buildStructuredLogEntry(
      parsed,
      options.fingerprint,
      options.generation,
      startOffset,
      endOffset,
      truncated
    ))
  }
}

function trimCarriageReturn(value: Buffer): Buffer {
  return value.length > 0 && value[value.length - 1] === 0x0d ? value.subarray(0, -1) : value
}

async function verifyAnchor(
  handle: FileHandle,
  offset: number,
  expected: string | null,
  signal?: AbortSignal
): Promise<boolean> {
  if (offset === 0) return expected === null
  if (expected === null) return false
  return await readAnchor(handle, offset, signal) === expected
}

async function readAnchor(handle: FileHandle, offset: number, signal?: AbortSignal): Promise<string | null> {
  if (offset === 0) return null
  assertNotAborted(signal)
  const length = Math.min(offset, CONSOLE_LOG_LIMITS.cursorAnchorBytes)
  const buffer = Buffer.allocUnsafe(length)
  const result = await handle.read(buffer, 0, length, offset - length)
  assertNotAborted(signal)
  if (result.bytesRead !== length) return createHash('sha256').update(buffer.subarray(0, result.bytesRead)).digest('hex')
  return createHash('sha256').update(buffer).digest('hex')
}

function resetCursor(fingerprint: string, previousGeneration: number): StructuredLogCursorState {
  if (!Number.isSafeInteger(previousGeneration) || previousGeneration >= Number.MAX_SAFE_INTEGER) {
    throw new ConsoleLogError('CONSOLE_LOG_CURSOR_INVALID')
  }
  return { version: 1, fingerprint, offset: 0, generation: previousGeneration + 1,
    skipRemainder: false, anchor: null }
}

function fileFingerprint(stats: Stats): string {
  return createHash('sha256')
    .update('dyson-console-file-v1\0')
    .update(String(stats.dev))
    .update('\0')
    .update(String(stats.ino))
    .update('\0')
    .update(String(stats.birthtimeMs))
    .digest('hex')
}

function insideRoot(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate)
  return relative.length > 0 && !relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative)
}

function samePath(left: string, right: string): boolean {
  const normalize = (value: string): string => path.resolve(value).replace(/[\\/]+$/, '').toLocaleLowerCase('en-US')
  return normalize(left) === normalize(right)
}

function boundedPolicyValue(
  input: number | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
  errorCode: 'CONSOLE_LOG_POLICY_INVALID'
): number {
  const value = input ?? fallback
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new ConsoleLogError(errorCode)
  }
  return value
}

function assertNotAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new ConsoleLogError('CONSOLE_LOG_READ_ABORTED')
}
