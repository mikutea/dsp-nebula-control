import { describe, expect, it } from 'vitest'
import { formatDuration, relativeTime } from './format'

describe('format helpers', () => {
  it('formats task duration', () => {
    expect(formatDuration(1250)).toBe('1.3 s')
    expect(formatDuration(null)).toBe('—')
  })

  it('formats relative save time', () => {
    const now = new Date('2026-01-01T00:02:00Z').getTime()
    expect(relativeTime('2026-01-01T00:00:00Z', now)).toBe('2 分钟前')
  })
})
