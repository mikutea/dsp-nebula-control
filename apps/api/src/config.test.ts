import { describe, expect, it } from 'vitest'
import { loadConfig } from './config.js'

describe('production configuration', () => {
  it('fails closed without production authentication material', () => {
    expect(() => loadConfig({ NODE_ENV: 'production' })).toThrow(/DYSON_ADMIN_PASSWORD_HASH/)
  })

  it('requires a project root for the Windows provider', () => {
    expect(() => loadConfig({ NODE_ENV: 'test', DYSON_PROVIDER: 'windows' })).toThrow(/DYSON_PROJECT_ROOT/)
  })
})
