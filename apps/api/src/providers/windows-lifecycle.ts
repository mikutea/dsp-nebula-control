import { z } from 'zod'
import type { FileBridgeClient } from '../bridge/file-client.js'
import {
  BridgeProtocolError,
  assertBridgeReceiptV2,
  computeBridgeSaveGenerationId,
  type BridgeHeartbeat,
  type BridgeReceipt
} from '../bridge/protocol.js'
import {
  LifecycleExecutionError,
  type LifecycleAction,
  type LifecycleMutationAdapter,
  type LifecycleOperationContext,
  type LifecyclePhaseResult,
  type LifecyclePreview,
  type LifecyclePreviewContext,
  type StatusProvider
} from '../domain.js'
import {
  PowerShellRunnerError,
  type LifecycleScriptRunner
} from './powershell-runner.js'

export interface LifecycleBridgeClient {
  probe(signal?: AbortSignal): Promise<BridgeHeartbeat>
  requestSave(requestId?: string, signal?: AbortSignal): Promise<BridgeReceipt>
}

export interface WindowsLifecycleAdapterOptions {
  projectRoot: string
  statusProvider: StatusProvider
  scriptRunner: LifecycleScriptRunner
  bridgeClient: LifecycleBridgeClient | FileBridgeClient
  bridgePluginVersion?: string
  serverTaskName?: string
  stopTaskName?: string
  gamePort?: number
}

const protectionSchema = z.strictObject({
  protocol: z.literal('DYSON_CONTROL_PROTECTION_V1'),
  requestId: z.string().uuid(),
  state: z.literal('succeeded'),
  protectionPointId: z.string().regex(/^save:[0-9a-f-]{36}$/i),
  dsvBytes: z.number().int().nonnegative(),
  serverBytes: z.number().int().nonnegative(),
  manifestVerified: z.literal(true),
  reused: z.boolean()
})

const taskReceiptSchema = z.strictObject({
  protocol: z.literal('DYSON_CONTROL_TASK_RECEIPT_V1'),
  requestId: z.string().uuid(),
  operation: z.enum(['graceful-stop', 'start', 'rollback-start']),
  state: z.literal('succeeded'),
  outcome: z.enum(['stopped', 'already-stopped', 'started', 'already-running']),
  processVerified: z.literal(true),
  writtenAt: z.string().datetime({ offset: true })
})

const runtimeSchema = z.strictObject({
  protocol: z.literal('DYSON_CONTROL_RUNTIME_V1'),
  expected: z.enum(['running', 'stopped']),
  state: z.literal('matched'),
  processVerified: z.literal(true),
  gamePortListening: z.boolean()
})

export class WindowsLifecycleAdapter implements LifecycleMutationAdapter {
  readonly mutationEnabled = true
  readonly #options: Required<Omit<WindowsLifecycleAdapterOptions, 'bridgeClient' | 'statusProvider' | 'scriptRunner'>> &
    Pick<WindowsLifecycleAdapterOptions, 'bridgeClient' | 'statusProvider' | 'scriptRunner'>

  constructor(options: WindowsLifecycleAdapterOptions) {
    if (!Number.isInteger(options.gamePort ?? 8469) || (options.gamePort ?? 8469) < 1 || (options.gamePort ?? 8469) > 65535) {
      throw new LifecycleExecutionError('GAME_PORT_INVALID')
    }
    for (const taskName of [options.serverTaskName ?? 'Dyson-Nebula-Server', options.stopTaskName ?? 'Dyson-Nebula-Stop']) {
      if (!/^[\p{L}\p{N}_. -]{1,128}$/u.test(taskName)) throw new LifecycleExecutionError('TASK_NAME_INVALID')
    }
    this.#options = {
      ...options,
      bridgePluginVersion: options.bridgePluginVersion ?? '0.1.0',
      serverTaskName: options.serverTaskName ?? 'Dyson-Nebula-Server',
      stopTaskName: options.stopTaskName ?? 'Dyson-Nebula-Stop',
      gamePort: options.gamePort ?? 8469
    }
  }

  async previewLifecycle(
    action: LifecycleAction,
    context: LifecyclePreviewContext = { executionLockReady: true }
  ): Promise<LifecyclePreview> {
    const preview = await this.#options.statusProvider.previewLifecycle(action)
    if (preview.action !== action) throw new LifecycleExecutionError('LIFECYCLE_PREVIEW_MISMATCH')
    let bridgeReady = false
    if (action !== 'start') {
      try {
        const heartbeat = await this.#options.bridgeClient.probe()
        bridgeReady = heartbeat.pluginVersion === this.#options.bridgePluginVersion
      } catch {
        bridgeReady = false
      }
    }

    const blockers = preview.blockers.filter((blocker) => {
      if (blocker === 'execution-disabled') return false
      if (blocker === 'save-trigger-unverified' && bridgeReady) return false
      return true
    })
    if (!context.executionLockReady && !blockers.includes('execution-lock-busy')) {
      blockers.push('execution-lock-busy')
    }
    const checks = preview.checks.map((check) => {
      if (check.id === 'execution-lock') {
        return context.executionLockReady
          ? { ...check, status: 'pass' as const, message: 'The durable lifecycle execution lock is available.' }
          : { ...check, status: 'block' as const, message: 'Another lifecycle transaction holds the execution lock.' }
      }
      if (check.id === 'save-trigger' && bridgeReady) {
        return { ...check, status: 'pass' as const, message: 'The signed in-game save bridge heartbeat is current.' }
      }
      return check
    })
    if (action === 'start') {
      const requiredStartChecks = [
        'project-root', 'managed-executable', 'managed-process', 'pid-file', 'game-port',
        'save-pair', 'server-task', 'server-task-principal', 'server-task-action',
        'receipt-channel', 'execution-lock'
      ] as const
      if (requiredStartChecks.some((id) => checks.find((check) => check.id === id)?.status !== 'pass') &&
          !blockers.includes('start-preflight-incomplete')) {
        blockers.push('start-preflight-incomplete')
      }
    }
    return {
      ...preview,
      executionEnabled: true,
      allowed: blockers.length === 0 && preview.rollback.ready,
      checks,
      blockers
    }
  }

  async createProtectionPoint(context: LifecycleOperationContext): Promise<LifecyclePhaseResult> {
    const parsed = await this.#runAndParse(
      'New-DysonSaveProtectionPoint.ps1',
      ['-ProjectRoot', this.#options.projectRoot, '-RequestId', context.requestId],
      context,
      protectionSchema
    )
    this.#assertRequestId(parsed.requestId, context.requestId)
    return {
      summary: parsed.reused ? '已复用并重新验证配对存档保护点' : '已创建并验证配对存档保护点',
      protectionPointId: parsed.protectionPointId,
      evidence: {
        dsvBytes: parsed.dsvBytes,
        serverBytes: parsed.serverBytes,
        manifestVerified: parsed.manifestVerified,
        reused: parsed.reused
      }
    }
  }

  async requestSave(context: LifecycleOperationContext): Promise<LifecyclePhaseResult> {
    try {
      const receipt = await this.#options.bridgeClient.requestSave(context.requestId, context.signal)
      assertBridgeReceiptV2(receipt)
      this.#assertRequestId(receipt.requestId, context.requestId)
      if (receipt.state !== 'succeeded') throw new LifecycleExecutionError(receipt.errorCode)
      return {
        summary: '游戏内保存已完成，配对存档回执有效',
        evidence: {
          generationId: computeBridgeSaveGenerationId(receipt),
          dsvBytes: receipt.dsvBytes,
          serverBytes: receipt.serverBytes,
          saveAdvanced: receipt.saveTimeAfter > receipt.saveTimeBefore,
          durationMs: receipt.finishedAtUnixMs - receipt.startedAtUnixMs
        }
      }
    } catch (error) {
      throw this.#normalizeError(error)
    }
  }

  requestGracefulStop(context: LifecycleOperationContext): Promise<LifecyclePhaseResult> {
    return this.#requestTask('graceful-stop', this.#options.stopTaskName, context)
  }

  verifyStopped(context: LifecycleOperationContext): Promise<LifecyclePhaseResult> {
    return this.#verifyRuntime('stopped', context)
  }

  requestStart(context: LifecycleOperationContext): Promise<LifecyclePhaseResult> {
    return this.#requestTask('start', this.#options.serverTaskName, context)
  }

  verifyRunning(context: LifecycleOperationContext): Promise<LifecyclePhaseResult> {
    return this.#verifyRuntime('running', context)
  }

  requestRollbackStart(context: LifecycleOperationContext): Promise<LifecyclePhaseResult> {
    return this.#requestTask('rollback-start', this.#options.serverTaskName, context)
  }

  async #requestTask(
    operation: 'graceful-stop' | 'start' | 'rollback-start',
    taskName: string,
    context: LifecycleOperationContext
  ): Promise<LifecyclePhaseResult> {
    const parsed = await this.#runAndParse(
      'Invoke-DysonScheduledTask.ps1',
      [
        '-ProjectRoot', this.#options.projectRoot,
        '-RequestId', context.requestId,
        '-Operation', operation,
        '-TaskName', taskName,
        '-GamePort', String(this.#options.gamePort)
      ],
      context,
      taskReceiptSchema
    )
    this.#assertRequestId(parsed.requestId, context.requestId)
    if (parsed.operation !== operation) throw new LifecycleExecutionError('HOST_RECEIPT_MISMATCH')
    return {
      summary: operation === 'graceful-stop'
        ? '优雅停服任务已完成并验证进程停止'
        : operation === 'rollback-start'
          ? '回滚启动任务已完成并验证进程恢复'
          : '启动任务已完成并验证进程运行',
      evidence: { outcome: parsed.outcome, processVerified: parsed.processVerified }
    }
  }

  async #verifyRuntime(
    expected: 'running' | 'stopped',
    context: LifecycleOperationContext
  ): Promise<LifecyclePhaseResult> {
    const parsed = await this.#runAndParse(
      'Test-DysonRuntimeState.ps1',
      [
        '-ProjectRoot', this.#options.projectRoot,
        '-Expected', expected,
        '-GamePort', String(this.#options.gamePort)
      ],
      context,
      runtimeSchema
    )
    if (parsed.expected !== expected) throw new LifecycleExecutionError('HOST_RECEIPT_MISMATCH')
    return {
      summary: expected === 'running' ? '游戏进程和监听端口已确认运行' : '游戏进程已确认停止',
      evidence: { processVerified: parsed.processVerified, gamePortListening: parsed.gamePortListening }
    }
  }

  async #runAndParse<T extends z.ZodType>(
    scriptName: Parameters<LifecycleScriptRunner['run']>[0],
    arguments_: string[],
    context: LifecycleOperationContext,
    schema: T
  ): Promise<z.infer<T>> {
    try {
      const output = await this.#options.scriptRunner.run(scriptName, arguments_, context.signal)
      return schema.parse(JSON.parse(output) as unknown)
    } catch (error) {
      throw this.#normalizeError(error)
    }
  }

  #assertRequestId(actual: string, expected: string): void {
    if (actual.toLowerCase() !== expected.toLowerCase()) {
      throw new LifecycleExecutionError('HOST_RECEIPT_MISMATCH')
    }
  }

  #normalizeError(error: unknown): LifecycleExecutionError {
    if (error instanceof LifecycleExecutionError) return error
    if (error instanceof BridgeProtocolError || error instanceof PowerShellRunnerError) {
      return new LifecycleExecutionError(error.code)
    }
    if (error instanceof z.ZodError || error instanceof SyntaxError) {
      return new LifecycleExecutionError('HOST_RECEIPT_INVALID')
    }
    if (error instanceof DOMException && error.name === 'AbortError') {
      return new LifecycleExecutionError('HOST_SCRIPT_ABORTED')
    }
    return new LifecycleExecutionError('LIFECYCLE_ADAPTER_FAILED')
  }
}
