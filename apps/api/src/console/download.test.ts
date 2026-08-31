import { afterEach, describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createStructuredLogDownloadPlan, executeStructuredLogDownload } from './download.js'
import { StructuredLogReader } from './reader.js'

const temporaryRoots: string[] = []
const cursorSecret = 'fictional-download-cursor-secret-that-is-safely-long'

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('bounded structured log download', () => {
  it('creates a path-free fixed-source plan with strict hard limits', () => {
    const plan = createStructuredLogDownloadPlan({
      format: 'json', start: 'beginning', maxResults: 20, maxOutputBytes: 4096, maxScanBytes: 8192,
      filters: { levels: ['error'], source: 'Nebula', text: '203.0.113.9' }
    }, new Date('2026-08-30T07:08:09.000Z'))
    expect(plan).toMatchObject({
      kind: 'bepinex-structured-log-download-plan', format: 'json',
      fileName: 'dyson-console-20260830T070809Z.json',
      maxResults: 20, maxOutputBytes: 4096, maxScanBytes: 8192,
      redactionRequired: true, rawHostOutputIncluded: false
    })
    expect(plan.filters.text).toBe('[endpoint]')
    expect(JSON.stringify(plan)).not.toContain('203.0.113.9')
    expect(collectKeys(plan)).not.toEqual(expect.arrayContaining(['path', 'root', 'command', 'shell']))

    for (const invalid of [
      { path: 'C:\\private.log' },
      { command: 'type secret.log' },
      { maxResults: 2001 },
      { maxOutputBytes: 4 * 1024 * 1024 + 1 },
      { maxScanBytes: 16 * 1024 * 1024 + 1 }
    ]) expect(() => createStructuredLogDownloadPlan(invalid)).toThrowError(expect.objectContaining({
      code: 'CONSOLE_LOG_DOWNLOAD_INVALID'
    }))
  })

  it('executes a multi-page redacted NDJSON download without raw host data', async () => {
    const fixture = await createFixture(Array.from({ length: 12 }, (_value, index) =>
      `[Error: NebulaNetwork] Player User${index} connected from 203.0.113.${index + 1} token=secret-${index}`
    ))
    const reader = new StructuredLogReader({
      serverRoot: fixture.serverRoot,
      cursorSecret,
      maximumReadBytes: 512,
      maximumResults: 3
    })
    const plan = createStructuredLogDownloadPlan({
      format: 'ndjson', start: 'beginning', maxResults: 12,
      maxOutputBytes: 16 * 1024, maxScanBytes: 16 * 1024,
      filters: { levels: ['error'], source: 'nebula' }
    }, new Date('2026-08-30T00:00:00.000Z'))
    const download = await executeStructuredLogDownload(reader, plan)
    expect(download.entries).toBe(12)
    expect(download.truncated).toBe(false)
    expect(download.body.split('\n')).toHaveLength(12)
    expect(download.outputBytes).toBe(Buffer.byteLength(download.body, 'utf8'))
    expect(download.scannedBytes).toBeGreaterThan(0)
    expect(download.scannedBytes).toBeLessThanOrEqual(plan.maxScanBytes)
    expect(download.body).not.toContain(fixture.serverRoot)
    expect(download.body).not.toContain('203.0.113.')
    expect(download.body).not.toContain('secret-')
    expect(download.body).not.toContain('User0')
    expect(download.body).toContain('[endpoint]')
    expect(download.body).toContain('[credential]')
    expect(download.body).toContain('[player]')
  })

  it('stops before exceeding the output or result budget and marks the artifact truncated', async () => {
    const fixture = await createFixture([
      `[Info: BepInEx] ${'x'.repeat(2_000)}`,
      '[Info: BepInEx] second'
    ])
    const reader = new StructuredLogReader({
      serverRoot: fixture.serverRoot, cursorSecret,
      maximumLineBytes: 4096, maximumReadBytes: 4096
    })
    const outputBounded = await executeStructuredLogDownload(reader, createStructuredLogDownloadPlan({
      format: 'json', maxResults: 10, maxOutputBytes: 1024, maxScanBytes: 8192
    }))
    expect(outputBounded.entries).toBe(0)
    expect(outputBounded.truncated).toBe(true)
    expect(outputBounded.outputBytes).toBeLessThanOrEqual(1024)

    const resultBounded = await executeStructuredLogDownload(reader, createStructuredLogDownloadPlan({
      format: 'ndjson', maxResults: 1, maxOutputBytes: 4096, maxScanBytes: 8192
    }))
    expect(resultBounded.entries).toBe(1)
    expect(resultBounded.truncated).toBe(true)
  })
})

async function createFixture(lines: string[]): Promise<{ serverRoot: string }> {
  const serverRoot = await mkdtemp(path.join(tmpdir(), 'dyson-console-download-'))
  temporaryRoots.push(serverRoot)
  const logRoot = path.join(serverRoot, 'BepInEx')
  await mkdir(logRoot, { recursive: true })
  await writeFile(path.join(logRoot, 'LogOutput.log'), `${lines.join('\r\n')}\r\n`, 'utf8')
  return { serverRoot }
}

function collectKeys(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(collectKeys)
  if (typeof value !== 'object' || value === null) return []
  return Object.entries(value).flatMap(([key, child]) => [key, ...collectKeys(child)])
}
