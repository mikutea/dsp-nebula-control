import { describe, expect, it } from 'vitest'
import { matchesStructuredLogFilters, parseStructuredLogLine } from './parser.js'
import { normalizeStructuredLogFilters, normalizeStructuredLogReadRequest } from './query.js'
import { redactStructuredLogText } from './redaction.js'

describe('BepInEx structured log parsing and redaction', () => {
  it('parses canonical levels, sources, and absolute timestamps', () => {
    expect(parseStructuredLogLine('[2026-08-30T04:05:06.789Z] [Warn : NebulaNetwork] Slow tick')).toEqual({
      timestamp: '2026-08-30T04:05:06.789Z',
      timestampUnixMs: Date.parse('2026-08-30T04:05:06.789Z'),
      level: 'warning',
      source: 'NebulaNetwork',
      text: 'Slow tick'
    })
    expect(parseStructuredLogLine('[Info   :   BepInEx] Loading chainloader')).toMatchObject({
      timestamp: null, level: 'info', source: 'BepInEx', text: 'Loading chainloader'
    })
    expect(parseStructuredLogLine('[12:34:56] native stack continuation')).toMatchObject({
      timestamp: null, level: 'unknown', source: 'runtime', text: 'native stack continuation'
    })
    expect(parseStructuredLogLine('   ')).toBeNull()
  })

  it('conservatively redacts secrets, paths, endpoints, and player identifiers', () => {
    const raw = [
      'password="fictional password"',
      'Bearer abcdefghijklmnopqrstuvwxyz',
      'token=do-not-return-this',
      'https://ops.example.com:8443/private',
      '203.0.113.42:8469',
      '2001:db8:abcd::42',
      'C:\\Games\\DSP\\BepInEx\\LogOutput.log',
      '"C:\\Program Files\\Fictional Game\\private config.ini"',
      '\\\\fictional-host\\share\\private.log',
      '/srv/dsp/BepInEx/LogOutput.log',
      'playerName=Alice',
      '76561198000000000',
      '8b5d3a7e-118a-4c4f-8ec0-9da8db9e4d26',
      'Player Bob joined'
    ].join('; ')
    const redacted = redactStructuredLogText(raw)
    for (const sensitive of [
      'fictional password', 'abcdefghijklmnopqrstuvwxyz', 'do-not-return-this',
      'ops.example.com', '203.0.113.42', '2001:db8', 'C:\\Games', 'Program Files', 'fictional-host', '/srv/dsp',
      'Alice', '76561198000000000', '8b5d3a7e', 'Bob'
    ]) expect(redacted).not.toContain(sensitive)
    expect(redacted).toContain('[credential]')
    expect(redacted).toContain('[endpoint]')
    expect(redacted).toContain('[path]')
    expect(redacted).toContain('[player]')
  })

  it('filters only redacted structured fields without regular expressions', () => {
    const parsed = parseStructuredLogLine(
      '[2026-08-30T04:05:06Z] [Error: NebulaNetwork] Player Alice connected from 203.0.113.2'
    )
    expect(parsed).not.toBeNull()
    const filters = normalizeStructuredLogFilters({
      levels: ['error'], source: 'nebula',
      from: '2026-08-30T04:00:00Z', to: '2026-08-30T05:00:00Z',
      text: '203.0.113.2'
    })
    expect(matchesStructuredLogFilters(parsed!, filters)).toBe(true)
    expect(matchesStructuredLogFilters(parsed!, normalizeStructuredLogFilters({ text: 'Alice' }))).toBe(false)
    expect(matchesStructuredLogFilters(parsed!, normalizeStructuredLogFilters({ to: '2026-08-30T04:00:00Z' }))).toBe(false)
  })

  it('rejects unknown query fields, arbitrary path/command fields, invalid times, and hard-limit overflow', () => {
    const policy = { maximumReadBytes: 1024, maximumResults: 10 }
    for (const query of [
      { path: 'C:\\private.log' },
      { command: 'Get-Content' },
      { maxBytes: 1025 },
      { limit: 11 },
      { cursor: 'abc', start: 'beginning' },
      { filters: { regex: '.*' } },
      { filters: { from: '2026-08-31T00:00:00Z', to: '2026-08-30T00:00:00Z' } }
    ]) {
      expect(() => normalizeStructuredLogReadRequest(query, policy)).toThrowError(expect.objectContaining({
        code: 'CONSOLE_LOG_QUERY_INVALID'
      }))
    }
  })
})
