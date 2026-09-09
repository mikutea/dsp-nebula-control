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
  type LifecycleBlockerCode,
  type LifecycleCheck,
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
import {
  WindowsLifecycleBrokerClientError,
  type LifecycleBrokerPreflightEvidence,
  type WindowsLifecycleBrokerClient
} from './windows-lifecycle-broker.js'

export interface LifecycleBridgeClient {
  probe(signal?: AbortSignal): Promise<BridgeHeartbeat>
  requestSave(requestId?: string, signal?: AbortSignal): Promise<BridgeReceipt>
}

export interface WindowsLifecycleAdapterOptions {
  projectRoot: string
  runtimeBootstrapRoot: string
  statusProvider: StatusProvider
  scriptRunner: LifecycleScriptRunner
  brokerClient: WindowsLifecycleBrokerClient
  bridgeClient: LifecycleBridgeClient | FileBridgeClient
  bridgePluginVersion?: string
  serverTaskName?: string
  stopTaskName?: string
  gamePort?: number
}

const protectionExecutionSchema = z.strictObject({
  protocol: z.literal('DYSON_CONTROL_PROTECTION_V1'),
  schemaVersion: z.literal(1),
  requestId: z.string().uuid(),
  state: z.literal('succeeded'),
  dryRun: z.literal(false),
  mutationPerformed: z.boolean(),
  protectionPointId: z.string().regex(/^save:[0-9a-f-]{36}$/i),
  sourcePairVerified: z.literal(true),
  dsvBytes: z.number().int().nonnegative(),
  serverBytes: z.number().int().nonnegative(),
  manifestVerified: z.literal(true),
  reused: z.boolean()
})

export class WindowsLifecycleAdapter implements LifecycleMutationAdapter {
  readonly mutationEnabled = true
  readonly #options: Required<Omit<WindowsLifecycleAdapterOptions, 'bridgeClient' | 'statusProvider' | 'scriptRunner' | 'brokerClient'>> &
    Pick<WindowsLifecycleAdapterOptions, 'bridgeClient' | 'statusProvider' | 'scriptRunner' | 'brokerClient'>

  constructor(options: WindowsLifecycleAdapterOptions) {
    if (!Number.isInteger(options.gamePort ?? 8469) || (options.gamePort ?? 8469) < 1 || (options.gamePort ?? 8469) > 65535) {
      throw new LifecycleExecutionError('GAME_PORT_INVALID')
    }
    for (const taskName of [options.serverTaskName ?? 'Dyson-Nebula-Server', options.stopTaskName ?? 'Dyson-Nebula-Stop']) {
      if (!/^[\p{L}\p{N}_. -]{1,128}$/u.test(taskName)) throw new LifecycleExecutionError('TASK_NAME_INVALID')
    }
    this.#options = {
      ...options,
      bridgePluginVersion: options.bridgePluginVersion ?? '0.1.0-rc.16',
      serverTaskName: options.serverTaskName ?? 'Dyson-Nebula-Server',
      stopTaskName: options.stopTaskName ?? 'Dyson-Nebula-Stop',
      gamePort: options.gamePort ?? 8469
    }
  }

  async previewLifecycle(
    action: LifecycleAction,
    context: LifecyclePreviewContext = { executionLockReady: true }
  ): Promise<LifecyclePreview> {
    const signal = context.signal ?? new AbortController().signal
    if (signal.aborted) throw new LifecycleExecutionError('HOST_SCRIPT_ABORTED')
    const preview = await this.#options.statusProvider.previewLifecycle(action, signal)
    if (preview.action !== action) throw new LifecycleExecutionError('LIFECYCLE_PREVIEW_MISMATCH')
    let brokerEvidence: LifecycleBrokerPreflightEvidence | null = null
    try {
      brokerEvidence = await this.#options.brokerClient.preflight({
        action,
        ...(context.requestId ? { outerRequestId: context.requestId } : {}),
        signal
      })
    } catch {
      if (signal.aborted) throw new LifecycleExecutionError('HOST_SCRIPT_ABORTED')
      brokerEvidence = null
    }
    let bridgeReady = false
    if (action !== 'start') {
      try {
        const heartbeat = await this.#options.bridgeClient.probe(signal)
        bridgeReady = heartbeat.pluginVersion === this.#options.bridgePluginVersion
      } catch {
        if (signal.aborted) throw new LifecycleExecutionError('HOST_SCRIPT_ABORTED')
        bridgeReady = false
      }
    }

    const brokerAuthoritativeBlockers = new Set<LifecycleBlockerCode>([
      'managed-process-unverified', 'server-already-running', 'pid-file-unverified',
      'game-port-unverified', 'game-port-listening', 'server-task-missing',
      'server-task-disabled', 'server-task-not-ready', 'server-task-principal-mismatch',
      'server-task-not-interactive', 'server-task-action-unallowlisted',
      'stop-task-missing', 'stop-task-principal-mismatch', 'stop-task-not-interactive',
      'stop-task-action-unallowlisted', 'stop-task-last-result-failed',
      'start-preflight-incomplete', 'receipt-channel-missing', 'lifecycle-broker-unavailable'
    ])
    const blockers = preview.blockers.filter((blocker) => {
      if (blocker === 'execution-disabled') return false
      if (blocker === 'save-trigger-unverified' && bridgeReady) return false
      if (brokerEvidence && brokerAuthoritativeBlockers.has(blocker)) return false
      return true
    })
    if (brokerEvidence) {
      for (const blocker of brokerEvidence.blockers.map(mapBrokerBlocker)) {
        if (!blockers.includes(blocker)) blockers.push(blocker)
      }
    } else if (!blockers.includes('lifecycle-broker-unavailable')) {
      blockers.push('lifecycle-broker-unavailable')
    }
    if (!context.executionLockReady && !blockers.includes('execution-lock-busy')) {
      blockers.push('execution-lock-busy')
    }
    const checks: LifecycleCheck[] = preview.checks.map((check) => {
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
    this.#applyBrokerChecks(checks, action, brokerEvidence)
    if (action === 'start') {
      const requiredStartChecks = [
        'project-root', 'managed-executable', 'managed-process', 'pid-file', 'game-port',
        'save-pair', 'server-task', 'server-task-principal', 'server-task-action',
        'interactive-session', 'steam-session', 'lifecycle-broker',
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
      allowed: blockers.length === 0 && preview.rollback.ready &&
        checks.every((check) => check.status !== 'block'),
      checks,
      blockers
    }
  }

  async createProtectionPoint(context: LifecycleOperationContext): Promise<LifecyclePhaseResult> {
    const parsed = await this.#runAndParse(
      'New-DysonSaveProtectionPoint.ps1',
      [
        '-ProjectRoot', this.#options.projectRoot,
        '-RequestId', context.requestId
      ],
      context,
      protectionExecutionSchema
    )
    this.#assertRequestId(parsed.requestId, context.requestId)
    if (parsed.protectionPointId.toLowerCase() !== `save:${context.requestId.toLowerCase()}`) {
      throw new LifecycleExecutionError('HOST_RECEIPT_MISMATCH')
    }
    if (parsed.mutationPerformed === parsed.reused) {
      throw new LifecycleExecutionError('HOST_RECEIPT_INVALID')
    }
    return {
      summary: parsed.reused ? '已复用并重新验证配对存档保护点' : '已创建并验证配对存档保护点',
      protectionPointId: parsed.protectionPointId,
      evidence: {
        dsvBytes: parsed.dsvBytes,
        serverBytes: parsed.serverBytes,
        manifestVerified: parsed.manifestVerified,
        sourcePairVerified: parsed.sourcePairVerified,
        mutationPerformed: parsed.mutationPerformed,
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
    return this.#requestTask('graceful-stop', context)
  }

  verifyStopped(context: LifecycleOperationContext): Promise<LifecyclePhaseResult> {
    return this.#verifyRuntime('stopped', context)
  }

  requestStart(context: LifecycleOperationContext): Promise<LifecyclePhaseResult> {
    return this.#requestTask('start', context)
  }

  verifyRunning(context: LifecycleOperationContext): Promise<LifecyclePhaseResult> {
    return this.#verifyRuntime('running', context)
  }

  requestRollbackStart(context: LifecycleOperationContext): Promise<LifecyclePhaseResult> {
    return this.#requestTask('rollback-start', context)
  }

  async #requestTask(
    operation: 'graceful-stop' | 'start' | 'rollback-start',
    context: LifecycleOperationContext
  ): Promise<LifecyclePhaseResult> {
    if (!context.hostMutation) throw new LifecycleExecutionError('LIFECYCLE_HOST_LEASE_MISSING')
    try {
      context.hostMutation.assertActive()
      const evidence = await this.#options.brokerClient.dispatch({
        operation,
        outerRequestId: context.requestId,
        hostMutation: context.hostMutation,
        signal: context.signal
      })
      context.hostMutation.assertActive()
      return {
        summary: operation === 'graceful-stop'
          ? '固定代理已触发优雅停服任务'
          : operation === 'rollback-start'
            ? '固定代理已触发回滚启动任务'
            : '固定代理已触发启动任务',
        evidence: {
          dispatched: evidence.dispatched,
          recovered: 'recovered' in evidence ? evidence.recovered : false,
          taskName: 'taskName' in evidence ? evidence.taskName : null,
          readyVerified: 'readyVerified' in evidence ? evidence.readyVerified : false
        }
      }
    } catch (error) {
      throw this.#normalizeError(error)
    }
  }

  async #verifyRuntime(
    expected: 'running' | 'stopped',
    context: LifecycleOperationContext
  ): Promise<LifecyclePhaseResult> {
    try {
      const evidence = await this.#options.brokerClient.verify({
        expected,
        outerRequestId: context.requestId,
        signal: context.signal
      })
      const runtimeMatched = expected === 'running'
        ? evidence.runtime.lifecycleState === 'running_verified' &&
          evidence.runtime.process.status === 'verified' && evidence.runtime.port.listenerCount === 1 &&
          evidence.runtime.pidFile.present && evidence.runtime.pidFile.valid
        : evidence.runtime.lifecycleState === 'stopped_verified' &&
          evidence.runtime.process.status === 'absent' && evidence.runtime.port.listenerCount === 0 &&
          !evidence.runtime.pidFile.present && !evidence.runtime.pidFile.valid
      if (!evidence.matched || !runtimeMatched) {
        throw new LifecycleExecutionError('WINDOWS_LIFECYCLE_BROKER_RESULT_INVALID')
      }
      return {
        summary: expected === 'running' ? 'SYSTEM 代理已确认游戏进程和监听端口运行' : 'SYSTEM 代理已确认游戏进程停止',
        evidence: {
          processVerified: expected === 'running'
            ? evidence.runtime.process.status === 'verified'
            : evidence.runtime.process.status === 'absent',
          gamePortListening: evidence.runtime.port.listenerCount === 1,
          lifecycleState: evidence.runtime.lifecycleState
        }
      }
    } catch (error) {
      throw this.#normalizeError(error)
    }
  }

  #applyBrokerChecks(
    checks: LifecycleCheck[],
    action: LifecycleAction,
    evidence: LifecycleBrokerPreflightEvidence | null
  ): void {
    const setCheck = (
      id: LifecycleCheck['id'],
      status: LifecycleCheck['status'],
      message: string
    ) => {
      const index = checks.findIndex((check) => check.id === id)
      const value = { id, status, message }
      if (index >= 0) checks[index] = value
      else checks.push(value)
    }
    if (!evidence) {
      setCheck('lifecycle-broker', 'block', '固定 SYSTEM 生命周期代理不可用或回执无效。')
      return
    }

    setCheck('lifecycle-broker', 'pass', '固定 SYSTEM 生命周期代理、任务和证据回执均已验证。')
    setCheck('receipt-channel', 'pass', '固定代理请求、intent 与持久化回执通道均已验证。')
    setCheck(
      'interactive-session',
      evidence.runtime.session.status === 'verified' ? 'pass' : 'block',
      evidence.runtime.session.status === 'verified'
        ? '游戏专用账号存在唯一可用交互会话。'
        : evidence.runtime.session.status === 'missing'
          ? '游戏专用账号没有可用交互会话。'
          : '游戏专用账号存在多个候选交互会话，无法唯一绑定。'
    )
    if (action === 'start' || action === 'restart') {
      setCheck(
        'steam-session',
        evidence.runtime.steam.status === 'verified' ? 'pass' : 'block',
        evidence.runtime.steam.status === 'verified'
          ? 'Steam 与游戏专用账号位于同一唯一交互会话。'
          : 'Steam 未在游戏专用账号的唯一交互会话中通过验证。'
      )
    } else {
      setCheck('steam-session', 'not-applicable', '此操作不需要启动 Steam。')
    }

    const taskStatus: LifecycleCheck['status'] = evidence.task.valid ? 'pass' : 'block'
    for (const id of [
      'server-task', 'server-task-principal', 'server-task-action',
      'stop-task', 'stop-task-principal', 'stop-task-action'
    ] as const) {
      setCheck(id, taskStatus, evidence.task.valid
        ? '固定任务定义、主体、动作和描述符摘要已验证。'
        : '固定任务定义或描述符摘要不匹配。')
    }

    const expectedState = action === 'start' ? 'stopped_verified' : 'running_verified'
    const runtimeReady = evidence.runtime.lifecycleState === expectedState
    setCheck('managed-process', runtimeReady ? 'pass' : 'block', runtimeReady
      ? `游戏运行状态已由 SYSTEM 代理确认为 ${expectedState}。`
      : 'SYSTEM 代理无法确认本次操作所需的游戏运行状态。')
    setCheck('pid-file', runtimeReady ? 'pass' : 'block', runtimeReady
      ? 'PID 文件与权威进程证据一致。'
      : 'PID 文件与权威进程证据未形成一致结论。')
    setCheck('game-port', runtimeReady ? 'pass' : 'block', runtimeReady
      ? '游戏端口与权威进程证据一致。'
      : '游戏端口与权威进程证据未形成一致结论。')
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
    if (error instanceof WindowsLifecycleBrokerClientError) {
      return new LifecycleExecutionError(error.brokerErrorCode ?? error.code)
    }
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

function mapBrokerBlocker(blocker: LifecycleBrokerPreflightEvidence['blockers'][number]): LifecycleBlockerCode {
  switch (blocker) {
    case 'task_definition_mismatch': return 'task-definition-mismatch'
    case 'interactive_session_missing': return 'interactive-session-missing'
    case 'session_ambiguous': return 'interactive-session-ambiguous'
    case 'steam_session_missing': return 'steam-session-missing'
    case 'process_unverifiable': return 'managed-process-unverified'
    case 'server_already_running': return 'server-already-running'
    case 'server_not_running':
    case 'state_mismatch':
    case 'recovery_required': return 'runtime-state-mismatch'
  }
}
