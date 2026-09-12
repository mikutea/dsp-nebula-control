export type GameConfigFileId = 'nebula' | 'galaxy' | 'bepinex' | 'bridge'
export type GameConfigValueType = 'boolean' | 'integer' | 'number' | 'secret'
export type GameConfigActivation = 'server-restart' | 'new-game-only'
export type GameConfigValue = boolean | number | string

export interface GameConfigDefinition {
  id: string
  file: GameConfigFileId
  section: string
  key: string
  type: GameConfigValueType
  label: string
  description: string
  activation: GameConfigActivation
  defaultValue: GameConfigValue
  minimum?: number
  maximum?: number
  allowed?: readonly number[]
}

const nebulaDefinitions: GameConfigDefinition[] = [
  {
    id: 'nebula.auto-pause', file: 'nebula', section: 'Nebula - Settings', key: 'AutoPauseEnabled',
    type: 'boolean', label: '无人时自动暂停', description: '没有玩家在线时暂停游戏逻辑。',
    activation: 'server-restart', defaultValue: true
  },
  {
    id: 'nebula.server-password', file: 'nebula', section: 'Nebula - Settings', key: 'ServerPassword',
    type: 'secret', label: '游戏连接密码', description: '玩家加入 Nebula 服务器时使用；现有值永不返回浏览器。',
    activation: 'server-restart', defaultValue: ''
  },
  {
    id: 'nebula.remote-access-enabled', file: 'nebula', section: 'Nebula - Settings', key: 'RemoteAccessEnabled',
    type: 'boolean', label: 'Nebula 远程命令', description: '允许已认证玩家使用 Nebula 的固定远程服务器命令。',
    activation: 'server-restart', defaultValue: false
  },
  {
    id: 'nebula.remote-access-password', file: 'nebula', section: 'Nebula - Settings', key: 'RemoteAccessPassword',
    type: 'secret', label: '远程命令密码', description: '仅用于 Nebula 客户端远程命令认证；现有值永不返回浏览器。',
    activation: 'server-restart', defaultValue: ''
  },
  {
    id: 'nebula.host-port', file: 'nebula', section: 'Nebula - Settings', key: 'HostPort',
    type: 'integer', label: '游戏端口', description: 'Nebula 直接 TCP 连接端口。',
    activation: 'server-restart', defaultValue: 8469, minimum: 1, maximum: 65_535
  },
  {
    id: 'nebula.upnp-enabled', file: 'nebula', section: 'Nebula - Settings', key: 'EnableUPnpOrPmpSupport',
    type: 'boolean', label: '自动端口映射', description: '让 Nebula 尝试通过 UPnP/PMP 创建路由映射。',
    activation: 'server-restart', defaultValue: false
  },
  {
    id: 'nebula.ngrok-enabled', file: 'nebula', section: 'Nebula - Settings', key: 'EnableNgrok',
    type: 'boolean', label: 'Nebula Ngrok', description: '使用 Nebula 内置的实验性 Ngrok；直连部署应保持关闭。',
    activation: 'server-restart', defaultValue: false
  },
  {
    id: 'nebula.sync-ups', file: 'nebula', section: 'Nebula - Settings', key: 'SyncUps',
    type: 'boolean', label: '同步玩家 UPS', description: '让所有玩家使用一致的游戏逻辑帧节奏。',
    activation: 'server-restart', defaultValue: true
  },
  {
    id: 'nebula.sync-soil', file: 'nebula', section: 'Nebula - Settings', key: 'SyncSoil',
    type: 'boolean', label: '共享沙土', description: '将所有玩家的沙土数量合并为服务器共享池。',
    activation: 'server-restart', defaultValue: false
  },
  {
    id: 'nebula.streamer-mode', file: 'nebula', section: 'Nebula - Settings', key: 'StreamerMode',
    type: 'boolean', label: '隐私显示模式', description: '在游戏界面隐藏地址等个人信息。',
    activation: 'server-restart', defaultValue: false
  }
]

const galaxyDefinitions: GameConfigDefinition[] = [
  {
    id: 'galaxy.seed', file: 'galaxy', section: 'Basic', key: 'galaxySeed',
    type: 'integer', label: '星系种子', description: '负数表示随机种子。',
    activation: 'new-game-only', defaultValue: -1, minimum: -2_147_483_648, maximum: 2_147_483_647
  },
  {
    id: 'galaxy.star-count', file: 'galaxy', section: 'Basic', key: 'starCount',
    type: 'integer', label: '恒星数量', description: '新星系中生成的恒星数量。',
    activation: 'new-game-only', defaultValue: 64, minimum: 32, maximum: 64
  },
  {
    id: 'galaxy.resource-multiplier', file: 'galaxy', section: 'Basic', key: 'resourceMultiplier',
    type: 'number', label: '资源倍率', description: '100 表示无限资源。',
    activation: 'new-game-only', defaultValue: 1, allowed: [0.1, 0.5, 1, 1.5, 2, 3, 5, 8, 100]
  },
  {
    id: 'galaxy.aggressiveness', file: 'galaxy', section: 'Combat', key: 'aggressiveness',
    type: 'number', label: '黑雾攻击性', description: '-1 为木桩，3 为狂暴。',
    activation: 'new-game-only', defaultValue: 1, allowed: [-1, 0, 0.5, 1, 2, 3]
  },
  {
    id: 'galaxy.initial-level', file: 'galaxy', section: 'Combat', key: 'initialLevel',
    type: 'integer', label: '黑雾初始等级', description: '黑雾初始等级。',
    activation: 'new-game-only', defaultValue: 0, minimum: 0, maximum: 30
  },
  {
    id: 'galaxy.initial-growth', file: 'galaxy', section: 'Combat', key: 'initialGrowth',
    type: 'number', label: '初始成长', description: '黑雾初始成长系数。',
    activation: 'new-game-only', defaultValue: 1, minimum: 0, maximum: 2
  },
  {
    id: 'galaxy.initial-colonize', file: 'galaxy', section: 'Combat', key: 'initialColonize',
    type: 'number', label: '初始占领', description: '黑雾初始占领系数。',
    activation: 'new-game-only', defaultValue: 1, minimum: 0.01, maximum: 2
  },
  {
    id: 'galaxy.max-density', file: 'galaxy', section: 'Combat', key: 'maxDensity',
    type: 'number', label: '最大密度', description: '黑雾最大密度系数。',
    activation: 'new-game-only', defaultValue: 1, minimum: 1, maximum: 3
  },
  {
    id: 'galaxy.growth-speed', file: 'galaxy', section: 'Combat', key: 'growthSpeedFactor',
    type: 'number', label: '成长速度', description: '黑雾成长速度系数。',
    activation: 'new-game-only', defaultValue: 1, minimum: 0.25, maximum: 3
  },
  {
    id: 'galaxy.power-threat', file: 'galaxy', section: 'Combat', key: 'powerThreatFactor',
    type: 'number', label: '电力威胁', description: '发电产生威胁的倍率。',
    activation: 'new-game-only', defaultValue: 1, minimum: 0.01, maximum: 10
  },
  {
    id: 'galaxy.battle-threat', file: 'galaxy', section: 'Combat', key: 'battleThreatFactor',
    type: 'number', label: '战斗威胁', description: '战斗产生威胁的倍率。',
    activation: 'new-game-only', defaultValue: 1, minimum: 0.01, maximum: 10
  },
  {
    id: 'galaxy.battle-exp', file: 'galaxy', section: 'Combat', key: 'battleExpFactor',
    type: 'number', label: '战斗经验', description: '黑雾战斗经验倍率。',
    activation: 'new-game-only', defaultValue: 1, minimum: 0.01, maximum: 10
  },
  {
    id: 'galaxy.peace-mode', file: 'galaxy', section: 'General', key: 'isPeaceMode',
    type: 'boolean', label: '和平模式', description: '启用后不生成敌对黑雾势力。',
    activation: 'new-game-only', defaultValue: false
  },
  {
    id: 'galaxy.sandbox-mode', file: 'galaxy', section: 'General', key: 'isSandboxMode',
    type: 'boolean', label: '沙盒模式', description: '启用创造/沙盒规则。',
    activation: 'new-game-only', defaultValue: false
  }
]

const bepInExDefinitions: GameConfigDefinition[] = [
  {
    id: 'bepinex.console-enabled', file: 'bepinex', section: 'Logging.Console', key: 'Enabled',
    type: 'boolean', label: 'BepInEx 控制台', description: '为无桌面服务端保留可收集的 BepInEx 控制台输出。',
    activation: 'server-restart', defaultValue: true
  }
]

const bridgeDefinitions: GameConfigDefinition[] = [
  {
    id: 'bridge.enabled', file: 'bridge', section: 'Bridge', key: 'Enabled',
    type: 'boolean', label: '游戏内控制桥', description: '启用签名的本机保存与状态回执桥。',
    activation: 'server-restart', defaultValue: false
  },
  {
    id: 'bridge.poll-milliseconds', file: 'bridge', section: 'Timing', key: 'PollMilliseconds',
    type: 'integer', label: '请求轮询间隔', description: '游戏主线程检查本机签名请求的间隔（毫秒）。',
    activation: 'server-restart', defaultValue: 250, minimum: 100, maximum: 2_000
  },
  {
    id: 'bridge.stability-milliseconds', file: 'bridge', section: 'Timing', key: 'StabilityMilliseconds',
    type: 'integer', label: '存档稳定窗口', description: '配对存档指纹保持不变后才签发成功回执。',
    activation: 'server-restart', defaultValue: 2_000, minimum: 500, maximum: 15_000
  },
  {
    id: 'bridge.save-timeout-seconds', file: 'bridge', section: 'Timing', key: 'SaveTimeoutSeconds',
    type: 'integer', label: '保存确认超时', description: '等待游戏内保存和配对文件稳定的最长秒数。',
    activation: 'server-restart', defaultValue: 30, minimum: 10, maximum: 180
  },
  {
    id: 'bridge.save-cooldown-seconds', file: 'bridge', section: 'Timing', key: 'SaveCooldownSeconds',
    type: 'integer', label: '保存请求冷却', description: '连续受控保存请求之间的最短秒数。',
    activation: 'server-restart', defaultValue: 60, minimum: 30, maximum: 600
  }
]

export const gameConfigCatalog = Object.freeze([
  ...nebulaDefinitions, ...galaxyDefinitions, ...bepInExDefinitions, ...bridgeDefinitions
])

export const gameConfigDefinitionById = new Map(
  gameConfigCatalog.map((definition) => [definition.id, definition] as const)
)

export function normalizeGameConfigValue(
  definition: GameConfigDefinition,
  input: unknown
): GameConfigValue {
  if (definition.type === 'boolean') {
    if (typeof input !== 'boolean') throw new GameConfigValidationError(definition.id, 'CONFIG_BOOLEAN_REQUIRED')
    return input
  }
  if (definition.type === 'secret') {
    if (typeof input !== 'string' || input.length > 128 || /[\r\n\0]/.test(input)) {
      throw new GameConfigValidationError(definition.id, 'CONFIG_SECRET_INVALID')
    }
    return input
  }
  if (typeof input !== 'number' || !Number.isFinite(input)) {
    throw new GameConfigValidationError(definition.id, 'CONFIG_NUMBER_REQUIRED')
  }
  if (definition.type === 'integer' && !Number.isInteger(input)) {
    throw new GameConfigValidationError(definition.id, 'CONFIG_INTEGER_REQUIRED')
  }
  if (definition.minimum !== undefined && input < definition.minimum) {
    throw new GameConfigValidationError(definition.id, 'CONFIG_VALUE_OUT_OF_RANGE')
  }
  if (definition.maximum !== undefined && input > definition.maximum) {
    throw new GameConfigValidationError(definition.id, 'CONFIG_VALUE_OUT_OF_RANGE')
  }
  if (definition.allowed && !definition.allowed.includes(input)) {
    throw new GameConfigValidationError(definition.id, 'CONFIG_VALUE_NOT_ALLOWED')
  }
  return input
}

export class GameConfigValidationError extends Error {
  constructor(readonly settingId: string, readonly code: string) {
    super(code)
    this.name = 'GameConfigValidationError'
  }
}
