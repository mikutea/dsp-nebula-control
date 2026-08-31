import type { FastifyReply, FastifyRequest } from 'fastify'

export const controlRoles = ['viewer', 'operator', 'administrator'] as const
export type ControlRole = (typeof controlRoles)[number]

export const controlPermissions = [
  'status.read',
  'status.refresh',
  'jobs.read',
  'observability.read',
  'observability.acknowledge',
  'players.read',
  'players.moderate',
  'console.read',
  'console.export',
  'console.command',
  'saves.read',
  'saves.backup',
  'saves.restore',
  'saves.transfer',
  'lifecycle.preview',
  'lifecycle.execute',
  'configuration.read',
  'configuration.preview',
  'configuration.apply',
  'updates.read',
  'updates.stage',
  'updates.activate',
  'mods.read',
  'mods.mutate',
  'client-profile.generate'
] as const
export type ControlPermission = (typeof controlPermissions)[number]

export interface AuthenticatedUser {
  name: 'Viewer' | 'Operator' | 'Administrator'
  role: ControlRole
  permissions: readonly ControlPermission[]
}

const viewerPermissions = [
  'status.read',
  'jobs.read',
  'observability.read',
  'players.read',
  'console.read',
  'saves.read',
  'configuration.read',
  'updates.read',
  'mods.read'
] as const satisfies readonly ControlPermission[]

const operatorPermissions = [
  ...viewerPermissions,
  'status.refresh',
  'observability.acknowledge',
  'console.export',
  'console.command',
  'saves.backup',
  'lifecycle.preview',
  'lifecycle.execute',
  'configuration.preview',
  'updates.stage',
  'client-profile.generate'
] as const satisfies readonly ControlPermission[]

const permissionSets: Readonly<Record<ControlRole, ReadonlySet<ControlPermission>>> = {
  viewer: new Set(viewerPermissions),
  operator: new Set(operatorPermissions),
  administrator: new Set(controlPermissions)
}

declare module 'fastify' {
  interface FastifyRequest {
    actorRole: ControlRole | null
  }
}

export function isControlRole(value: unknown): value is ControlRole {
  return typeof value === 'string' && (controlRoles as readonly string[]).includes(value)
}

export function can(role: ControlRole, permission: ControlPermission): boolean {
  return permissionSets[role].has(permission)
}

export function permissionsFor(role: ControlRole): readonly ControlPermission[] {
  return controlPermissions.filter((permission) => can(role, permission))
}

export function authenticatedUserFor(role: ControlRole): AuthenticatedUser {
  return {
    name: role === 'administrator' ? 'Administrator' : role === 'operator' ? 'Operator' : 'Viewer',
    role,
    permissions: permissionsFor(role)
  }
}

export function requirePermission(permission: ControlPermission) {
  return async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    if (reply.sent) return
    const role = request.actorRole
    if (role !== null && can(role, permission)) return
    await reply.code(403).send({
      error: {
        code: 'AUTHORIZATION_DENIED',
        message: 'The authenticated role is not permitted to perform this operation'
      }
    })
  }
}
