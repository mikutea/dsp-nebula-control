import type {
  LifecycleAction, LifecycleCheck, LifecyclePreview, ServerStatus, StatusProvider
} from '../domain.js'

export class DemoProvider implements StatusProvider {
  readonly name = 'demo' as const

  async collectStatus(): Promise<ServerStatus> {
    await new Promise((resolve) => setTimeout(resolve, 180))
    return {
      collectedAt: new Date().toISOString(),
      serverName: 'DSP 主服务器',
      state: 'running',
      runtime: {
        targetUps: 60,
        onlinePlayers: 8,
        maxPlayers: 20,
        processId: 18342,
        processCoresUsed: 2.4,
        workingSetGiB: 6.1,
        privateMemoryGiB: 6.8,
        threadCount: 277,
        priority: 'High',
        startedAt: new Date(Date.now() - 13 * 60 * 60 * 1000).toISOString(),
        uptimeSeconds: 13 * 60 * 60
      },
      host: {
        logicalProcessors: 32,
        processorGroups: 1,
        cpuPercent: 18.5,
        memoryTotalGiB: 64,
        memoryFreeGiB: 43.2,
        cpuCores: {
          samples: Array.from({ length: 32 }, (_, index) => ({
            index,
            percent: index === 0 ? 41.2 : 8 + (index % 7) * 2.1
          })),
          unavailableReason: null
        },
        projectVolume: {
          totalBytes: 2_000_000_000_000,
          availableBytes: 1_200_000_000_000,
          usedPercent: 40,
          unavailableReason: null
        },
        saveVolume: {
          totalBytes: 2_000_000_000_000,
          availableBytes: 1_200_000_000_000,
          usedPercent: 40,
          unavailableReason: null
        },
        network: {
          receiveBytesPerSecond: 1_250_000,
          sendBytesPerSecond: 420_000,
          sampledInterfaceCount: 2,
          unavailableReason: null
        }
      },
      versions: {
        dsp: '0.10.29.21902',
        nebula: '0.9.22',
        bepInEx: '5.4.17',
        compatible: true,
        gameLoaded: true,
        warnings: []
      },
      save: {
        name: 'DSP_Main_Save',
        dsvPresent: true,
        serverPresent: true,
        consistent: true,
        lastSavedAt: new Date(Date.now() - 2 * 60 * 1000).toISOString(),
        dsvSizeMiB: 842.6,
        serverSizeKiB: 912.4,
        latestBackupAt: new Date(Date.now() - 42 * 60 * 1000).toISOString(),
        backupManifestPresent: true,
        backupPairPresent: true
      },
      automation: {
        serverTask: { state: 'running', lastResult: 267009, lastRunAt: new Date(Date.now() - 13 * 60 * 60 * 1000).toISOString() },
        stopTask: { state: 'ready', lastResult: 0, lastRunAt: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString() },
        storageTask: { state: 'ready', lastResult: 0, lastRunAt: new Date(Date.now() - 13 * 60 * 60 * 1000).toISOString() },
        projectRootAvailable: true,
        globalMappingAvailable: true
      },
      connections: [
        { id: 'game-port', label: '游戏端口 8469', status: 'healthy', detail: '本机监听正常' },
        { id: 'public-wss', label: '公网 WSS', status: 'healthy', detail: '演示检查正常' }
      ],
      capabilities: { refresh: true, start: false, save: false, gracefulStop: false, restart: false }
    }
  }

  async previewLifecycle(action: LifecycleAction): Promise<LifecyclePreview> {
    await new Promise((resolve) => setTimeout(resolve, 120))
    const needsStartTask = action === 'start' || action === 'restart'
    const needsStopTask = action === 'graceful-stop' || action === 'restart'
    const runningEvidence = action !== 'start'
    const checks: LifecycleCheck[] = [
      { id: 'project-root', status: 'pass', message: 'The fictional project root is available.' },
      { id: 'managed-executable', status: 'pass', message: 'The fictional managed executable is available.' },
      { id: 'managed-process', status: runningEvidence ? 'pass' : 'block', message: runningEvidence ? 'The fictional DSP process matches the managed executable.' : 'The fictional demo process is already running.' },
      { id: 'pid-file', status: runningEvidence ? 'pass' : 'block', message: runningEvidence ? 'The fictional PID file matches the running process.' : 'The fictional demo PID file is active.' },
      { id: 'game-port', status: runningEvidence ? 'pass' : 'block', message: runningEvidence ? 'The fictional game port is owned by the managed process.' : 'The fictional demo game port is already listening.' },
      { id: 'save-pair', status: 'pass', message: 'The fictional .dsv and .server pair is present.' },
      { id: 'backup-pair', status: action === 'start' ? 'not-applicable' : 'pass', message: action === 'start' ? 'Starting does not modify the paired save.' : 'The fictional paired backup and manifest are present.' },
      { id: 'server-task', status: needsStartTask ? 'pass' : 'not-applicable', message: needsStartTask ? 'The fictional server start task exists.' : 'The server start task is not used by this preview.' },
      { id: 'server-task-principal', status: needsStartTask ? 'pass' : 'not-applicable', message: needsStartTask ? 'The fictional start-task principal is interactive.' : 'Start-task principal validation is not used by this preview.' },
      { id: 'server-task-action', status: needsStartTask ? 'pass' : 'not-applicable', message: needsStartTask ? 'The fictional start task uses the fixed allowlisted script.' : 'Start-task action validation is not used by this preview.' },
      { id: 'stop-task', status: needsStopTask ? 'pass' : 'not-applicable', message: needsStopTask ? 'The fictional graceful-stop task exists.' : 'The graceful-stop task is not used by this preview.' },
      { id: 'stop-task-principal', status: needsStopTask ? 'pass' : 'not-applicable', message: needsStopTask ? 'The fictional stop principal matches the game session.' : 'Stop-task principal validation is not used by this preview.' },
      { id: 'stop-task-action', status: needsStopTask ? 'pass' : 'not-applicable', message: needsStopTask ? 'The fictional stop action is allowlisted.' : 'Stop-task action validation is not used by this preview.' },
      { id: 'stop-task-result', status: needsStopTask ? 'pass' : 'not-applicable', message: needsStopTask ? 'The fictional stop task last returned success.' : 'Stop-task result validation is not used by this preview.' },
      { id: 'task-history', status: needsStopTask ? 'warning' : 'not-applicable', message: needsStopTask ? 'The demo keeps history as a visible warning.' : 'Task history is not used by this preview.' },
      { id: 'receipt-channel', status: needsStopTask || action === 'start' ? 'block' : 'not-applicable', message: needsStopTask || action === 'start' ? 'A durable lifecycle receipt is intentionally absent in the demo.' : 'A task receipt is not used by this preview.' },
      { id: 'save-trigger', status: action === 'start' ? 'not-applicable' : 'block', message: action === 'start' ? 'Starting a stopped server does not request an in-game save.' : 'A separately verifiable save acknowledgement is intentionally absent.' },
      { id: 'execution-lock', status: 'block', message: 'Lifecycle execution is disabled; this endpoint is dry-run only.' }
    ]
    return {
      collectedAt: new Date().toISOString(), action, mode: 'dry-run',
      allowed: false, executionEnabled: false, checks,
      blockers: [
        ...(action === 'start' ? ['server-already-running' as const, 'game-port-listening' as const] : []),
        ...(needsStopTask || action === 'start' ? ['receipt-channel-missing' as const] : []),
        ...(action === 'start' ? [] : ['save-trigger-unverified' as const]),
        'execution-disabled'
      ],
      rollback: action === 'start'
        ? { strategy: 'no-op', ready: true, summary: 'Demo mode never dispatches the fictional start task.' }
        : action === 'graceful-stop'
        ? { strategy: 'restart-from-same-save', ready: true, summary: 'The fictional paired save can be restarted without modification.' }
        : { strategy: 'paired-save-backup', ready: true, summary: 'The fictional paired backup and manifest are ready.' }
    }
  }
}
