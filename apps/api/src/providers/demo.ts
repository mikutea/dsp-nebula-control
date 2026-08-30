import type { ServerStatus, StatusProvider } from '../domain.js'

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
        memoryFreeGiB: 43.2
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
      capabilities: { refresh: true, save: false, gracefulStop: false, restart: false }
    }
  }
}
