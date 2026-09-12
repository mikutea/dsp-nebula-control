import { describe, expect, it } from 'vitest'
import { createUiRequestId } from './request-id'

const uuidV4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

describe('UI request identifiers', () => {
  it('uses native randomUUID when the browser exposes it', () => {
    expect(createUiRequestId({ randomUUID: () => '11111111-1111-4111-8111-111111111111' }))
      .toBe('11111111-1111-4111-8111-111111111111')
  })

  it('uses getRandomValues when randomUUID is unavailable', () => {
    const value = createUiRequestId({ getRandomValues: (array) => {
      const bytes = array as unknown as Uint8Array
      bytes.fill(0xab)
      return array
    } })
    expect(value).toMatch(uuidV4)
  })

  it('keeps local control actions functional in constrained browsers without Web Crypto', () => {
    expect(createUiRequestId(undefined, () => 0.5)).toMatch(uuidV4)
  })
})
