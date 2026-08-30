import path from 'node:path'
import { z } from 'zod'

const environmentSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  DYSON_HOST: z.string().default('127.0.0.1'),
  DYSON_PORT: z.coerce.number().int().min(1).max(65535).default(13010),
  DYSON_PROVIDER: z.enum(['demo', 'windows']).default('demo'),
  DYSON_PUBLIC_ORIGIN: z.string().url().default('http://127.0.0.1:13010'),
  DYSON_DATA_DIR: z.string().optional(),
  DYSON_PROJECT_ROOT: z.string().optional(),
  DYSON_SCRIPT_ROOT: z.string().optional(),
  DYSON_STATUS_TIMEOUT_MS: z.coerce.number().int().min(1000).max(120_000).default(15_000),
  DYSON_ADMIN_PASSWORD_HASH: z.string().optional(),
  DYSON_SESSION_SECRET: z.string().optional(),
  DYSON_DEV_ADMIN_PASSWORD: z.string().min(12).default('dyson-control-local-demo')
})

export interface AppConfig {
  nodeEnv: 'development' | 'test' | 'production'
  host: string
  port: number
  provider: 'demo' | 'windows'
  publicOrigin: string
  dataDir: string
  projectRoot: string | null
  scriptRoot: string
  statusTimeoutMs: number
  adminPasswordHash: string | null
  sessionSecret: string
  developmentPassword: string
}

export function loadConfig(environment: NodeJS.ProcessEnv = process.env): AppConfig {
  const value = environmentSchema.parse(environment)
  const production = value.NODE_ENV === 'production'

  if (production && !value.DYSON_ADMIN_PASSWORD_HASH) {
    throw new Error('DYSON_ADMIN_PASSWORD_HASH is required in production')
  }
  if (production && (!value.DYSON_SESSION_SECRET || value.DYSON_SESSION_SECRET.length < 32)) {
    throw new Error('DYSON_SESSION_SECRET must contain at least 32 characters in production')
  }
  if (value.DYSON_PROVIDER === 'windows' && !value.DYSON_PROJECT_ROOT) {
    throw new Error('DYSON_PROJECT_ROOT is required for the Windows provider')
  }

  const repositoryRoot = path.resolve(import.meta.dirname, '..', '..', '..')
  return {
    nodeEnv: value.NODE_ENV,
    host: value.DYSON_HOST,
    port: value.DYSON_PORT,
    provider: value.DYSON_PROVIDER,
    publicOrigin: value.DYSON_PUBLIC_ORIGIN.replace(/\/$/, ''),
    dataDir: path.resolve(value.DYSON_DATA_DIR ?? path.join(repositoryRoot, 'data')),
    projectRoot: value.DYSON_PROJECT_ROOT ? path.resolve(value.DYSON_PROJECT_ROOT) : null,
    scriptRoot: path.resolve(value.DYSON_SCRIPT_ROOT ?? path.join(repositoryRoot, 'scripts', 'windows')),
    statusTimeoutMs: value.DYSON_STATUS_TIMEOUT_MS,
    adminPasswordHash: value.DYSON_ADMIN_PASSWORD_HASH ?? null,
    sessionSecret: value.DYSON_SESSION_SECRET ?? 'development-only-session-secret-do-not-deploy',
    developmentPassword: value.DYSON_DEV_ADMIN_PASSWORD
  }
}
