import { afterEach, describe, expect, it } from 'vitest'
import { appendFile, mkdir, mkdtemp, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { StructuredLogReader } from './reader.js'

const temporaryRoots: string[] = []
const cursorSecret = 'fictional-structured-log-secret-that-is-at-least-32-bytes'

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('bounded incremental structured log reader', () => {
  it('continues with a stable signed cursor across result pages and later appends', async () => {
    const fixture = await createFixture([
      '[Info: BepInEx] boot',
      '[Info: NebulaNetwork] listening',
      '[Warning: NebulaWorld] slow tick',
      '[Error: NebulaWorld] simulated fault'
    ])
    const reader = createReader(fixture.serverRoot)
    const first = await reader.read({ start: 'beginning', maxBytes: 512, limit: 2 })
    expect(first.entries.map((entry) => entry.text)).toEqual(['boot', 'listening'])
    expect(first.scannedBytes).toBeLessThanOrEqual(512)
    expect(first.hasMore).toBe(true)
    expect(first.transition).toBe('initial-beginning')
    expect(first.cursor).not.toContain(fixture.serverRoot)

    const repeated = await reader.read({ start: 'beginning', maxBytes: 512, limit: 2 })
    expect(repeated.cursor).toBe(first.cursor)
    expect(repeated.entries.map((entry) => entry.id)).toEqual(first.entries.map((entry) => entry.id))

    const second = await reader.read({ cursor: first.cursor, maxBytes: 512, limit: 2 })
    expect(second.entries.map((entry) => entry.level)).toEqual(['warning', 'error'])
    expect(second.transition).toBe('none')
    expect(second.hasMore).toBe(false)

    await appendFile(fixture.logPath, '[Info: NebulaNetwork] late append\r\n', 'utf8')
    const appended = await reader.read({ cursor: second.cursor, maxBytes: 512, limit: 10 })
    expect(appended.entries).toEqual([
      expect.objectContaining({ level: 'info', source: 'NebulaNetwork', text: 'late append' })
    ])
    expect(appended.generation).toBe(0)
  })

  it('holds an incomplete final line until it is terminated, then emits it exactly once', async () => {
    const fixture = await createFixture([], false)
    await writeFile(fixture.logPath, '[Info: BepInEx] partial', 'utf8')
    const reader = createReader(fixture.serverRoot)
    const pending = await reader.read({ start: 'beginning', maxBytes: 512, limit: 10 })
    expect(pending.entries).toEqual([])
    expect(pending.partialLinePending).toBe(true)
    expect(pending.hasMore).toBe(false)

    await appendFile(fixture.logPath, '\r\n[Info: BepInEx] complete\r\n', 'utf8')
    const completed = await reader.read({ cursor: pending.cursor, maxBytes: 512, limit: 10 })
    expect(completed.entries.map((entry) => entry.text)).toEqual(['partial', 'complete'])
    const noDuplicate = await reader.read({ cursor: completed.cursor, maxBytes: 512, limit: 10 })
    expect(noDuplicate.entries).toEqual([])
  })

  it('detects atomic rotation and same-file truncation, incrementing cursor generations', async () => {
    const fixture = await createFixture(['[Info: BepInEx] generation zero'])
    const reader = createReader(fixture.serverRoot)
    const original = await reader.read({ start: 'beginning', maxBytes: 512, limit: 10 })
    await rename(fixture.logPath, `${fixture.logPath}.1`)
    await writeFile(fixture.logPath, '[Warning: BepInEx] generation one\r\n', 'utf8')

    const rotated = await reader.read({ cursor: original.cursor, maxBytes: 512, limit: 10 })
    expect(rotated.transition).toBe('rotated')
    expect(rotated.generation).toBe(1)
    expect(rotated.entries[0]?.text).toBe('generation one')

    await writeFile(fixture.logPath, '[Error: BepInEx] two\r\n', 'utf8')
    const truncated = await reader.read({ cursor: rotated.cursor, maxBytes: 512, limit: 10 })
    expect(truncated.transition).toBe('truncated')
    expect(truncated.generation).toBe(2)
    expect(truncated.entries[0]?.text).toBe('two')
  })

  it('uses a content anchor to catch truncate-and-regrow before the next poll', async () => {
    const fixture = await createFixture([
      '[Info: BepInEx] original alpha',
      '[Info: BepInEx] original beta'
    ])
    const reader = createReader(fixture.serverRoot)
    const original = await reader.read({ start: 'beginning', maxBytes: 512, limit: 10 })
    await writeFile(fixture.logPath, [
      '[Error: BepInEx] replacement line that is intentionally longer',
      '[Error: BepInEx] replacement tail'
    ].join('\r\n') + '\r\n', 'utf8')

    const replacement = await reader.read({ cursor: original.cursor, maxBytes: 512, limit: 10 })
    expect(replacement.transition).toBe('truncated')
    expect(replacement.entries.map((entry) => entry.level)).toEqual(['error', 'error'])
  })

  it('emits one bounded prefix for an oversized line and skips its remainder on the next poll', async () => {
    const fixture = await createFixture([], false)
    await writeFile(fixture.logPath,
      `${'[Info: Oversized] '}${'x'.repeat(780)}\r\n[Info: BepInEx] after oversized\r\n`, 'utf8')
    const reader = createReader(fixture.serverRoot, { maximumLineBytes: 256, maximumReadBytes: 512 })
    const first = await reader.read({ start: 'beginning', maxBytes: 512, limit: 10 })
    expect(first.entries).toHaveLength(1)
    expect(first.entries[0]).toMatchObject({ level: 'info', source: 'Oversized', lineTruncated: true })
    expect(Buffer.byteLength(first.entries[0]!.text, 'utf8')).toBeLessThanOrEqual(256)
    expect(first.hasMore).toBe(true)

    const second = await reader.read({ cursor: first.cursor, maxBytes: 512, limit: 10 })
    expect(second.entries.map((entry) => entry.text)).toEqual(['after oversized'])
    expect(second.entries.filter((entry) => entry.source === 'Oversized')).toHaveLength(0)
  })

  it('drops an initial tail fragment and applies level, source, time, and redacted-text filters', async () => {
    const fixture = await createFixture([], false)
    const prefix = `[Info: Prefix] ${'x'.repeat(620)}\r\n`
    await writeFile(fixture.logPath, prefix + [
      '[2026-08-30T04:00:00Z] [Info: NebulaNetwork] baseline',
      '[2026-08-30T04:10:00Z] [Error: NebulaNetwork] Player Alice connected from 203.0.113.42',
      '[2026-08-30T05:10:00Z] [Error: Other] later'
    ].join('\r\n') + '\r\n', 'utf8')
    const reader = createReader(fixture.serverRoot)
    const page = await reader.read({
      start: 'tail', maxBytes: 512, limit: 10,
      filters: {
        levels: ['error'], source: 'nebula',
        from: '2026-08-30T04:05:00Z', to: '2026-08-30T05:00:00Z', text: '[endpoint]'
      }
    })
    expect(page.entries).toEqual([
      expect.objectContaining({
        timestamp: '2026-08-30T04:10:00.000Z', level: 'error', source: 'NebulaNetwork'
      })
    ])
    expect(page.entries[0]?.text).not.toContain('Alice')
    expect(page.entries[0]?.text).not.toContain('203.0.113.42')
    expect(JSON.stringify(page)).not.toContain(fixture.serverRoot)
    expect(JSON.stringify(page)).not.toContain(fixture.logPath)
  })

  it('fails closed for invalid roots, missing fixed files, oversized files, invalid fields, and aborts', async () => {
    expect(() => createReader('relative-server-root')).toThrowError(expect.objectContaining({
      code: 'CONSOLE_LOG_ROOT_INVALID'
    }))
    const emptyRoot = await mkdtemp(path.join(tmpdir(), 'dyson-console-empty-'))
    temporaryRoots.push(emptyRoot)
    const missingReader = createReader(emptyRoot)
    await expect(missingReader.read()).rejects.toMatchObject({ code: 'CONSOLE_LOG_FILE_UNAVAILABLE' })

    const fixture = await createFixture(['[Info: BepInEx] too large'])
    const bounded = createReader(fixture.serverRoot, { maximumFileBytes: 4 })
    const error = await bounded.read().catch((caught: unknown) => caught)
    expect(error).toMatchObject({ code: 'CONSOLE_LOG_FILE_TOO_LARGE' })
    expect(JSON.stringify(error)).not.toContain(fixture.serverRoot)

    const reader = createReader(fixture.serverRoot)
    await expect(reader.read({ path: fixture.logPath })).rejects.toMatchObject({
      code: 'CONSOLE_LOG_QUERY_INVALID'
    })
    await expect(reader.read({ command: 'Get-Content' })).rejects.toMatchObject({
      code: 'CONSOLE_LOG_QUERY_INVALID'
    })
    const controller = new AbortController()
    controller.abort()
    await expect(reader.read({}, controller.signal)).rejects.toMatchObject({
      code: 'CONSOLE_LOG_READ_ABORTED'
    })
  })

  it('rejects a redirected BepInEx directory even when it contains the expected fixed filename', async () => {
    const serverRoot = await mkdtemp(path.join(tmpdir(), 'dyson-console-redirect-root-'))
    const outsideRoot = await mkdtemp(path.join(tmpdir(), 'dyson-console-redirect-target-'))
    temporaryRoots.push(serverRoot, outsideRoot)
    await writeFile(path.join(outsideRoot, 'LogOutput.log'), '[Info: BepInEx] outside\r\n', 'utf8')
    await symlink(outsideRoot, path.join(serverRoot, 'BepInEx'), process.platform === 'win32' ? 'junction' : 'dir')
    const reader = createReader(serverRoot)
    const error = await reader.read({ start: 'beginning' }).catch((caught: unknown) => caught)
    expect(error).toMatchObject({ code: 'CONSOLE_LOG_FILE_REDIRECTED' })
    expect(JSON.stringify(error)).not.toContain(outsideRoot)
  })
})

async function createFixture(lines: string[], terminate: boolean = true): Promise<{ serverRoot: string; logPath: string }> {
  const serverRoot = await mkdtemp(path.join(tmpdir(), 'dyson-console-reader-'))
  temporaryRoots.push(serverRoot)
  const logRoot = path.join(serverRoot, 'BepInEx')
  await mkdir(logRoot, { recursive: true })
  const logPath = path.join(logRoot, 'LogOutput.log')
  const content = lines.join('\r\n') + (terminate && lines.length > 0 ? '\r\n' : '')
  await writeFile(logPath, content, 'utf8')
  return { serverRoot, logPath }
}

function createReader(
  serverRoot: string,
  overrides: Partial<{
    maximumFileBytes: number
    maximumLineBytes: number
    maximumReadBytes: number
    maximumResults: number
  }> = {}
): StructuredLogReader {
  return new StructuredLogReader({
    serverRoot,
    cursorSecret,
    now: () => new Date('2026-08-30T06:00:00.000Z'),
    ...overrides
  })
}
