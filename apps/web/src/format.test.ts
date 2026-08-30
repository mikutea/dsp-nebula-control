import { describe, expect, it } from 'vitest'
import { formatDuration, formatUptime, relativeTime } from './format'

describe('format helpers', () => {
  it('formats task duration', () => {
    expect(formatDuration(1250)).toBe('1.3 s')
    expect(formatDuration(null)).toBe('—')
  })

  it('formats relative save time', () => {
    const now = new Date('2026-01-01T00:02:00Z').getTime()
    expect(relativeTime('2026-01-01T00:00:00Z', now)).toBe('2 分钟前')
  })

  it('formats process uptime without false precision', () => {
    expect(formatUptime(13 * 60 * 60 + 8 * 60)).toBe('13 小时 8 分钟')
    expect(formatUptime(2 * 86_400 + 3 * 3_600)).toBe('2 天 3 小时')
    expect(formatUptime(null)).toBe('—')
  })
})
