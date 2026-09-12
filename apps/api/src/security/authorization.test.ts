import { describe, expect, it, vi } from 'vitest'
import {
  can,
  authenticatedUserFor,
  controlPermissions,
  isControlRole,
  permissionsFor,
  requirePermission,
  type ControlRole
} from './authorization.js'

describe('authorization policy', () => {
  it('uses three exact roles and rejects lookalike or missing values', () => {
    expect(isControlRole('viewer')).toBe(true)
    expect(isControlRole('operator')).toBe(true)
    expect(isControlRole('administrator')).toBe(true)
    expect(isControlRole('Administrator')).toBe(false)
    expect(isControlRole('admin')).toBe(false)
    expect(isControlRole('')).toBe(false)
    expect(isControlRole(null)).toBe(false)
  })

  it('keeps the viewer role read-only and denies every mutation or export', () => {
    expect(permissionsFor('viewer')).toEqual([
      'status.read',
      'jobs.read',
      'observability.read',
      'players.read',
      'console.read',
      'saves.read',
      'lifecycle.read',
      'configuration.read',
      'updates.read',
      'mods.read',
      'cutover.read'
    ])
    for (const permission of [
      'jobs.export',
      'console.export',
      'console.command',
      'status.refresh',
      'observability.acknowledge',
      'saves.backup',
      'saves.restore',
      'lifecycle.preview',
      'lifecycle.execute',
      'configuration.preview',
      'configuration.apply',
      'updates.stage',
      'updates.activate',
      'mods.mutate',
      'players.moderate',
      'cutover.execute',
      'client-profile.generate'
    ] as const) {
      expect(can('viewer', permission)).toBe(false)
    }
  })

  it('allows routine operator workflows but reserves destructive mutations for administrators', () => {
    for (const permission of [
      'console.export',
      'console.command',
      'status.refresh',
      'observability.acknowledge',
      'saves.backup',
      'lifecycle.preview',
      'lifecycle.execute',
      'configuration.preview',
      'updates.stage',
      'client-profile.generate'
    ] as const) {
      expect(can('operator', permission)).toBe(true)
    }
    for (const permission of [
      'jobs.export',
      'saves.restore',
      'configuration.apply',
      'updates.activate',
      'mods.mutate',
      'players.moderate',
      'cutover.execute'
    ] as const) {
      expect(can('operator', permission)).toBe(false)
    }
  })

  it('grants the administrator every declared permission', () => {
    expect(permissionsFor('administrator')).toEqual(controlPermissions)
    expect(controlPermissions.every((permission) => can('administrator', permission))).toBe(true)
  })

  it('returns a bounded public session descriptor for the exact role', () => {
    expect(authenticatedUserFor('operator')).toEqual({
      name: 'Operator',
      role: 'operator',
      permissions: permissionsFor('operator')
    })
    expect(JSON.stringify(authenticatedUserFor('operator'))).not.toMatch(/password|secret|token/i)
  })

  it('returns one bounded denial without leaking the requested permission or role', async () => {
    const send = vi.fn()
    const code = vi.fn(() => ({ send }))
    const preHandler = requirePermission('saves.restore')
    await preHandler(
      { actorRole: 'operator' as ControlRole } as never,
      { code } as never
    )

    expect(code).toHaveBeenCalledWith(403)
    expect(send).toHaveBeenCalledWith({
      error: {
        code: 'AUTHORIZATION_DENIED',
        message: 'The authenticated role is not permitted to perform this operation'
      }
    })
    expect(JSON.stringify(send.mock.calls)).not.toContain('saves.restore')
    expect(JSON.stringify(send.mock.calls)).not.toContain('operator')
  })

  it('fails closed when authentication did not attach a role', async () => {
    const send = vi.fn()
    const code = vi.fn(() => ({ send }))
    await requirePermission('status.read')(
      { actorRole: null } as never,
      { code } as never
    )
    expect(code).toHaveBeenCalledWith(403)
  })

  it('does not send a response when the role is permitted', async () => {
    const send = vi.fn()
    const code = vi.fn(() => ({ send }))
    await requirePermission('configuration.apply')(
      { actorRole: 'administrator' } as never,
      { code } as never
    )
    expect(code).not.toHaveBeenCalled()
    expect(send).not.toHaveBeenCalled()
  })

  it('does not replace an authentication response that was already sent', async () => {
    const send = vi.fn()
    const code = vi.fn(() => ({ send }))
    await requirePermission('status.read')(
      { actorRole: null } as never,
      { sent: true, code } as never
    )
    expect(code).not.toHaveBeenCalled()
    expect(send).not.toHaveBeenCalled()
  })
})
