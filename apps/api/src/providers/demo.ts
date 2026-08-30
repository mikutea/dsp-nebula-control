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
        threadCount: 277
      },
      versions: {
        dsp: '0.10.29.21902',
        nebula: '0.9.22',
        bepInEx: '5.4.17',
        compatible: true
      },
      save: {
        name: 'DSP_Main_Save',
        dsvPresent: true,
        serverPresent: true,
        consistent: true,
        lastSavedAt: new Date(Date.now() - 2 * 60 * 1000).toISOString()
      },
      connections: [
        { id: 'game-port', label: '游戏端口 8469', status: 'healthy', detail: '本机监听正常' },
        { id: 'public-wss', label: '公网 WSS', status: 'healthy', detail: '演示检查正常' }
      ],
      capabilities: { refresh: true, save: false, gracefulStop: false, restart: false }
    }
  }
}
