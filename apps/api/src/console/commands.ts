import { z } from 'zod'
import type {
  LifecycleAction,
  LifecyclePreview
} from '../domain.js'
import type {
  LifecycleExecutionResult,
  LifecycleService
} from '../services/lifecycle-service.js'

export const consoleCommandNames = [
  'server.start',
  'server.save',
  'server.stop',
  'server.restart'
] as const
export type ConsoleCommandName = (typeof consoleCommandNames)[number]

export type ConsoleCommandConfirmation =
  | 'START_SERVER'
  | 'SAVE_SERVER'
  | 'STOP_SERVER'
  | 'RESTART_SERVER'

const commandSchema = z.enum(consoleCommandNames)
const idempotencyKeySchema = z.string()
  .min(16)
  .max(128)
  .regex(/^[A-Za-z0-9._:-]+$/)

export const consoleCommandPreviewRequestSchema = z.strictObject({
  command: commandSchema
})

export const consoleCommandExecutionRequestSchema = z.strictObject({
  command: commandSchema,
  idempotencyKey: idempotencyKeySchema,
  confirmation: z.enum([
    'START_SERVER',
    'SAVE_SERVER',
    'STOP_SERVER',
    'RESTART_SERVER'
  ])
})

interface ConsoleCommandDefinition {
  action: LifecycleAction
  label: string
  confirmation: ConsoleCommandConfirmation
}

const definitions: Readonly<Record<ConsoleCommandName, ConsoleCommandDefinition>> = {
  'server.start': {
    action: 'start',
    label: '启动服务器',
    confirmation: 'START_SERVER'
  },
  'server.save': {
    action: 'save',
    label: '保存服务器',
    confirmation: 'SAVE_SERVER'
  },
  'server.stop': {
    action: 'graceful-stop',
    label: '保存并优雅停服',
    confirmation: 'STOP_SERVER'
  },
  'server.restart': {
    action: 'restart',
    label: '保存并重启服务器',
    confirmation: 'RESTART_SERVER'
  }
}

export type ConsoleLifecyclePort = Pick<LifecycleService, 'preview' | 'enqueue'>

export interface ConsoleCommandPreview {
  mode: 'dry-run'
  command: ConsoleCommandName
  label: string
  requiredConfirmation: ConsoleCommandConfirmation
  lifecycle: LifecyclePreview
}

export class ConsoleCommandError extends Error {
  readonly code:
    | 'CONSOLE_COMMAND_REQUEST_INVALID'
    | 'CONSOLE_COMMAND_CONFIRMATION_MISMATCH'

  constructor(code: ConsoleCommandError['code']) {
    super(code)
    this.name = 'ConsoleCommandError'
    this.code = code
  }
}

export async function previewConsoleCommand(
  input: unknown,
  lifecycle: ConsoleLifecyclePort
): Promise<ConsoleCommandPreview> {
  const parsed = consoleCommandPreviewRequestSchema.safeParse(input)
  if (!parsed.success) throw new ConsoleCommandError('CONSOLE_COMMAND_REQUEST_INVALID')
  const definition = definitions[parsed.data.command]
  return {
    mode: 'dry-run',
    command: parsed.data.command,
    label: definition.label,
    requiredConfirmation: definition.confirmation,
    lifecycle: await lifecycle.preview(definition.action)
  }
}

export function executeConsoleCommand(
  input: unknown,
  lifecycle: ConsoleLifecyclePort,
  actor: string
): LifecycleExecutionResult {
  const parsed = consoleCommandExecutionRequestSchema.safeParse(input)
  if (!parsed.success) throw new ConsoleCommandError('CONSOLE_COMMAND_REQUEST_INVALID')
  const definition = definitions[parsed.data.command]
  if (parsed.data.confirmation !== definition.confirmation) {
    throw new ConsoleCommandError('CONSOLE_COMMAND_CONFIRMATION_MISMATCH')
  }
  return lifecycle.enqueue(definition.action, parsed.data.idempotencyKey, actor)
}
