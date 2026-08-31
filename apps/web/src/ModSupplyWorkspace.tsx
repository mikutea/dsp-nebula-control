import { useEffect, useMemo, useRef, useState } from 'react'
import {
  Boxes, Check, CloudDownload, FileCheck2, GitBranch, LockKeyhole,
  PackageCheck, RefreshCw, ScanSearch, ShieldCheck, TriangleAlert
} from 'lucide-react'
import { api, ApiError } from './api'
import { createUiRequestId } from './request-id'
import type {
  ArtifactAcquisitionCandidate, ArtifactAcquisitionDiscoveryMeta, ArtifactAcquisitionPlan,
  ArtifactAcquisitionReceipt, DiscoveredModRelease, ModClientRequirement,
  ModDeploymentRequest, ThunderstoreDependencyClosure, ThunderstoreDependencyRoute,
  ThunderstoreModImportPlan, ThunderstoreModImportReceipt, VerifiedModManifestPreview
} from './model'

const identifierPattern = /^[A-Za-z0-9_]{1,64}$/
const acquisitionConfirmation = 'ACQUIRE_UPDATE_ARTIFACT'
const importConfirmation = 'IMPORT_THUNDERSTORE_MOD'

interface PackageFlow {
  acquisitionPlan: ArtifactAcquisitionPlan | null
  acquisitionRequestId: string
  acquisitionReceipt: ArtifactAcquisitionReceipt | null
  acquisitionVerified: boolean
  acquisitionConfirmation: string
  importPlan: ThunderstoreModImportPlan | null
  importRequestId: string
  importReceipt: ThunderstoreModImportReceipt | null
  importVerified: boolean
  importConfirmation: string
  clientRequirement: ModClientRequirement
  error: string
}

export function ModSupplyWorkspace({
  demo,
  canAcquire,
  canImport,
  activeRevision,
  onDeploymentRequest
}: {
  demo: boolean
  canAcquire: boolean
  canImport: boolean
  activeRevision: string
  onDeploymentRequest: (request: ModDeploymentRequest, label: string) => void
}) {
  const [namespace, setNamespace] = useState(() => demo ? 'Fictional' : '')
  const [packageName, setPackageName] = useState(() => demo ? 'ServerHelper' : '')
  const [closure, setClosure] = useState<ThunderstoreDependencyClosure | null>(null)
  const [submittedQuery, setSubmittedQuery] = useState('')
  const [acquisitionMeta, setAcquisitionMeta] = useState<ArtifactAcquisitionDiscoveryMeta | null>(null)
  const [flows, setFlows] = useState<Record<string, PackageFlow>>({})
  const [discovering, setDiscovering] = useState(false)
  const [busyDependencyIds, setBusyDependencyIds] = useState<Set<string>>(() => new Set())
  const [buildingLock, setBuildingLock] = useState(false)
  const [generated, setGenerated] = useState<VerifiedModManifestPreview | null>(null)
  const [error, setError] = useState('')
  const [acquisitionGate, setAcquisitionGate] = useState<'unknown' | 'accepted' | 'closed'>('unknown')
  const [importGate, setImportGate] = useState<'unknown' | 'accepted' | 'closed'>('unknown')
  const discoverySequence = useRef(0)
  const buildSequence = useRef(0)
  const packageOperationSequences = useRef(new Map<string, number>())
  const discoveryController = useRef<AbortController | null>(null)

  useEffect(() => () => {
    discoveryController.current?.abort()
    discoverySequence.current += 1
    buildSequence.current += 1
    packageOperationSequences.current.clear()
  }, [])

  const pluginReleases = useMemo(() => {
    if (!closure) return []
    return closure.items.filter((release) => routeFor(closure, release.dependencyId)?.disposition === 'plugin')
  }, [closure])
  const allPluginsImported = pluginReleases.length > 0 && pluginReleases.every((release) =>
    flows[release.dependencyId]?.importVerified === true)

  async function discover(): Promise<void> {
    if (busyDependencyIds.size > 0 || buildingLock) return
    if (!identifierPattern.test(namespace) || !identifierPattern.test(packageName)) {
      setError('namespace 与 package name 只能包含 1–64 位字母、数字或下划线。')
      return
    }
    const sequence = ++discoverySequence.current
    discoveryController.current?.abort()
    const controller = new AbortController()
    discoveryController.current = controller
    setDiscovering(true)
    setError('')
    setGenerated(null)
    setClosure(null)
    setAcquisitionMeta(null)
    setFlows({})
    setSubmittedQuery(`${namespace}/${packageName}`)
    setAcquisitionGate('unknown')
    setImportGate('unknown')
    try {
      const result = demo
        ? fictionalClosureEnvelope
        : await (async () => {
            const latest = await api.discoverThunderstore(namespace, packageName, controller.signal)
            return await api.discoverThunderstoreDependencies([latest.data.dependencyId], controller.signal)
          })()
      if (sequence !== discoverySequence.current) return
      if (!validClosure(result.data, result.meta.acquisition)) {
        setError('服务端返回的精确依赖闭包未通过身份、路由或候选绑定校验。')
        return
      }
      const nextFlows: Record<string, PackageFlow> = {}
      for (const release of result.data.items) {
        if (routeFor(result.data, release.dependencyId)?.disposition === 'plugin') {
          nextFlows[release.dependencyId] = emptyFlow()
        }
      }
      setClosure(result.data)
      setAcquisitionMeta(result.meta.acquisition)
      setFlows(nextFlows)
    } catch (reason) {
      if (controller.signal.aborted) return
      if (sequence === discoverySequence.current) setError(formatSupplyError(reason, '精确 Thunderstore 依赖闭包发现失败。'))
    } finally {
      if (discoveryController.current === controller) discoveryController.current = null
      if (sequence === discoverySequence.current) setDiscovering(false)
    }
  }

  async function previewAcquisition(release: DiscoveredModRelease): Promise<void> {
    const candidate = candidateFor(release)
    if (!canAcquire || demo || !candidate || candidateExpired(candidate)) return
    const sequence = beginPackageOperation(release.dependencyId)
    const requestId = createUiRequestId()
    updateFlow(release.dependencyId, {
      acquisitionPlan: null,
      acquisitionRequestId: requestId,
      acquisitionReceipt: null,
      acquisitionVerified: false,
      acquisitionConfirmation: '',
      importPlan: null,
      importReceipt: null,
      importVerified: false,
      importConfirmation: '',
      error: ''
    })
    try {
      const result = await api.previewArtifactAcquisition(candidate.candidateId)
      if (!packageOperationIsCurrent(release.dependencyId, sequence)) return
      if (!acquisitionPlanMatches(result.data, candidate)) throw new Error('ACQUISITION_PLAN_IDENTITY_MISMATCH')
      updateFlow(release.dependencyId, { acquisitionPlan: result.data })
    } catch (reason) {
      if (packageOperationIsCurrent(release.dependencyId, sequence)) updateFlow(release.dependencyId, {
        error: formatSupplyError(reason, '制品获取预演失败。')
      })
    } finally {
      endPackageOperation(release.dependencyId, sequence)
    }
  }

  async function executeAcquisition(release: DiscoveredModRelease): Promise<void> {
    const flow = flows[release.dependencyId]
    const candidate = flow?.acquisitionPlan?.candidate
    if (!flow || !candidate || !canAcquire || demo || flow.acquisitionConfirmation !== acquisitionConfirmation) return
    const sequence = beginPackageOperation(release.dependencyId)
    updateFlow(release.dependencyId, { error: '', acquisitionVerified: false })
    try {
      const result = await api.executeArtifactAcquisition(flow.acquisitionRequestId, candidate.candidateId)
      if (!packageOperationIsCurrent(release.dependencyId, sequence)) return
      if (!acquisitionReceiptMatches(result.data, flow.acquisitionRequestId, candidate)) {
        throw new Error('ACQUISITION_RECEIPT_IDENTITY_MISMATCH')
      }
      const persisted = await api.artifactAcquisitionReceipt(result.data.requestId)
      if (!packageOperationIsCurrent(release.dependencyId, sequence)) return
      if (!acquisitionReceiptMatches(persisted.data, flow.acquisitionRequestId, candidate)) {
        throw new Error('ACQUISITION_PERSISTED_RECEIPT_MISMATCH')
      }
      setAcquisitionGate('accepted')
      updateFlow(release.dependencyId, {
        acquisitionReceipt: persisted.data,
        acquisitionVerified: true,
        acquisitionConfirmation: ''
      })
    } catch (reason) {
      if (packageOperationIsCurrent(release.dependencyId, sequence)) {
        if (reason instanceof ApiError && reason.status === 423) setAcquisitionGate('closed')
        updateFlow(release.dependencyId, { error: formatSupplyError(reason, '制品获取被拒绝。') })
      }
    } finally {
      endPackageOperation(release.dependencyId, sequence)
    }
  }

  async function previewImport(release: DiscoveredModRelease): Promise<void> {
    const flow = flows[release.dependencyId]
    if (!flow?.acquisitionVerified || !flow.acquisitionReceipt) return
    const sequence = beginPackageOperation(release.dependencyId)
    const requestId = createUiRequestId()
    updateFlow(release.dependencyId, {
      importPlan: null,
      importRequestId: requestId,
      importReceipt: null,
      importVerified: false,
      importConfirmation: '',
      error: ''
    })
    try {
      const result = await api.previewThunderstoreModImport(flow.acquisitionReceipt.requestId)
      if (!packageOperationIsCurrent(release.dependencyId, sequence)) return
      if (!importPlanMatches(result.data, flow.acquisitionReceipt.requestId, release)) {
        throw new Error('IMPORT_PLAN_IDENTITY_MISMATCH')
      }
      updateFlow(release.dependencyId, { importPlan: result.data })
    } catch (reason) {
      if (packageOperationIsCurrent(release.dependencyId, sequence)) updateFlow(release.dependencyId, {
        error: formatSupplyError(reason, 'Thunderstore 包导入预演失败。')
      })
    } finally {
      endPackageOperation(release.dependencyId, sequence)
    }
  }

  async function executeImport(release: DiscoveredModRelease): Promise<void> {
    const flow = flows[release.dependencyId]
    if (!flow?.importPlan || !flow.acquisitionReceipt || !canImport || demo ||
        flow.importConfirmation !== importConfirmation) return
    const sequence = beginPackageOperation(release.dependencyId)
    updateFlow(release.dependencyId, { error: '', importVerified: false })
    try {
      const result = await api.executeThunderstoreModImport(
        flow.importRequestId,
        flow.acquisitionReceipt.requestId
      )
      if (!packageOperationIsCurrent(release.dependencyId, sequence)) return
      if (!importReceiptMatches(result.data, flow.importRequestId, flow.acquisitionReceipt.requestId, release)) {
        throw new Error('IMPORT_RECEIPT_IDENTITY_MISMATCH')
      }
      const persisted = await api.thunderstoreModImportReceipt(result.data.requestId)
      if (!packageOperationIsCurrent(release.dependencyId, sequence)) return
      if (!importReceiptMatches(persisted.data, flow.importRequestId, flow.acquisitionReceipt.requestId, release)) {
        throw new Error('IMPORT_PERSISTED_RECEIPT_MISMATCH')
      }
      setImportGate('accepted')
      updateFlow(release.dependencyId, {
        importReceipt: persisted.data,
        importVerified: true,
        importConfirmation: ''
      })
    } catch (reason) {
      if (packageOperationIsCurrent(release.dependencyId, sequence)) {
        if (reason instanceof ApiError && reason.status === 423) setImportGate('closed')
        updateFlow(release.dependencyId, { error: formatSupplyError(reason, 'Thunderstore 包导入被拒绝。') })
      }
    } finally {
      endPackageOperation(release.dependencyId, sequence)
    }
  }

  async function buildDeploymentRequest(): Promise<void> {
    if (!closure || !allPluginsImported || !/^[0-9a-f]{64}$/.test(activeRevision)) return
    const pluginRoots = closure.roots.filter((root) => routeFor(closure, root)?.disposition === 'plugin')
    if (pluginRoots.length === 0) {
      setError('根包不属于普通 plugin pipeline，不能生成模组部署请求。')
      return
    }
    const sequence = ++buildSequence.current
    setBuildingLock(true)
    setError('')
    setGenerated(null)
    try {
      const input = {
        roots: pluginRoots,
        importReceiptIds: pluginReleases.map((release) => flows[release.dependencyId]!.importReceipt!.requestId),
        policies: pluginReleases.map((release) => ({
          sourceId: release.sourceId,
          serverRequired: true,
          clientRequirement: flows[release.dependencyId]!.clientRequirement
        }))
      }
      const result = await api.previewVerifiedModLock(input)
      if (sequence !== buildSequence.current) return
      if (!validVerifiedManifest(result.data, closure, pluginRoots)) {
        throw new Error('VERIFIED_MOD_LOCK_RESPONSE_INVALID')
      }
      const target = result.data.serverLock.mods.find((entry) =>
        pluginRoots.some((root) => root.toLowerCase() === entry.dependencyId.toLowerCase()))
      if (!target) throw new Error('VERIFIED_MOD_ROOT_MISSING')
      const request: ModDeploymentRequest = {
        requestId: createUiRequestId(),
        operation: 'install',
        package: { dependencyId: target.dependencyId, version: target.version },
        manifest: {
          serverLock: result.data.serverLock,
          clientParity: result.data.clientParity,
          platformLock: result.data.platformLock
        },
        expectedRevision: activeRevision
      }
      setGenerated(result.data)
      onDeploymentRequest(request, `thunderstore-${target.dependencyId}.json`)
    } catch (reason) {
      if (sequence === buildSequence.current) setError(formatSupplyError(reason, '已验证模组锁生成失败。'))
    } finally {
      if (sequence === buildSequence.current) setBuildingLock(false)
    }
  }

  function candidateFor(release: DiscoveredModRelease): ArtifactAcquisitionCandidate | null {
    const registration = acquisitionMeta?.candidates.find((entry) => entry.artifactId === release.artifact.artifactId)
    if (!registration || registration.status !== 'registered' || !registration.eligible || !registration.candidate) return null
    const candidate = registration.candidate
    return candidate.provider === 'thunderstore' && candidate.release.kind === 'plugin' &&
      candidate.release.sourceId === release.sourceId && candidate.release.version === release.version &&
      exactDependenciesMatch(candidate.release.dependencies, release.dependencies) &&
      typeof candidate.release.dependencyFingerprint === 'string' &&
      /^[0-9a-f]{64}$/.test(candidate.release.dependencyFingerprint) &&
      candidate.artifact.artifactId === release.artifact.artifactId ? candidate : null
  }

  function updateFlow(dependencyId: string, patch: Partial<PackageFlow>): void {
    setFlows((current) => current[dependencyId]
      ? { ...current, [dependencyId]: { ...current[dependencyId]!, ...patch } }
      : current)
  }

  function beginPackageOperation(dependencyId: string): number {
    const sequence = (packageOperationSequences.current.get(dependencyId) ?? 0) + 1
    packageOperationSequences.current.set(dependencyId, sequence)
    setBusyDependencyIds((current) => {
      const next = new Set(current)
      next.add(dependencyId)
      return next
    })
    return sequence
  }

  function packageOperationIsCurrent(dependencyId: string, sequence: number): boolean {
    return packageOperationSequences.current.get(dependencyId) === sequence
  }

  function endPackageOperation(dependencyId: string, sequence: number): void {
    if (!packageOperationIsCurrent(dependencyId, sequence)) return
    setBusyDependencyIds((current) => {
      const next = new Set(current)
      next.delete(dependencyId)
      return next
    })
  }

  return <section className="mod-supply-workspace">
    <header><div><span className="mod-supply-orbit"><GitBranch size={20} /></span><span><strong>Thunderstore 可复现供应链</strong><small>精确依赖·服务端候选·持久回执·载荷锁·原子部署</small></span></div><b>{closure ? `${submittedQuery} · ${closure.nodeCount} NODES / DEPENDENCIES-FIRST` : 'SUPPLY CHAIN IDLE'}</b></header>
    <div className="mod-supply-search">
      <label><span>NAMESPACE</span><input aria-label="Thunderstore namespace" value={namespace} disabled={discovering || busyDependencyIds.size > 0} onChange={(event) => setNamespace(event.target.value)} autoComplete="off" /></label>
      <label><span>PACKAGE</span><input aria-label="Thunderstore package name" value={packageName} disabled={discovering || busyDependencyIds.size > 0} onChange={(event) => setPackageName(event.target.value)} autoComplete="off" /></label>
      <button type="button" onClick={() => void discover()} disabled={discovering || busyDependencyIds.size > 0 || buildingLock} aria-label="发现精确依赖闭包"><ScanSearch className={discovering ? 'spin' : ''} size={15} />{discovering ? '解析中…' : busyDependencyIds.size > 0 ? '等待当前事务…' : '发现精确依赖闭包'}</button>
    </div>
    <div className="mod-supply-boundary">
      <div><span>DISCOVERY</span><strong>EXACT VERSION</strong><small>每个 dependency ID 固定 namespace/name/version</small></div>
      <div><span>ACQUISITION GATE</span><strong className={acquisitionGate === 'closed' ? 'danger' : acquisitionGate === 'accepted' ? 'green' : ''}>{acquisitionGate.toUpperCase()}</strong><small>只引用服务端 candidate ID</small></div>
      <div><span>IMPORT GATE</span><strong className={importGate === 'closed' ? 'danger' : importGate === 'accepted' ? 'green' : ''}>{importGate.toUpperCase()}</strong><small>只引用持久 acquisition receipt</small></div>
      <div><span>TRANSPORT</span><strong>NO PATH / URL / ZIP</strong><small>浏览器不能选择主机输入</small></div>
    </div>
    {!canAcquire && <div className="permission-lock-note"><LockKeyhole size={15} /><span><strong>发现与依赖路由只读</strong><small>当前角色不能发起制品获取。</small></span></div>}
    {canAcquire && !canImport && <div className="permission-lock-note operator"><LockKeyhole size={15} /><span><strong>Operator 可获取，不可导入与部署</strong><small>持久到 inbox 后，必须由 Administrator 完成 mod staging 及发布。</small></span></div>}
    {error && <div className="mod-supply-error" role="alert"><TriangleAlert size={16} /><span>{error}</span></div>}
    {closure ? <div className="mod-supply-graph">{closure.items.map((release, index) => {
      const route = routeFor(closure, release.dependencyId)
      const flow = flows[release.dependencyId]
      const candidate = candidateFor(release)
      const busy = busyDependencyIds.has(release.dependencyId)
      if (!route) return null
      return <article className={`mod-supply-node route-${route.disposition}`} data-mod-supply-row={release.dependencyId} key={release.dependencyId}>
        <div className="mod-supply-node-index"><span>{String(index + 1).padStart(2, '0')}</span><i /></div>
        <div className="mod-supply-node-identity"><span>{routeLabel(route)}</span><strong>{release.namespace} / {release.name}</strong><code>{release.dependencyId}</code><small>{release.dependencies.length} direct dependencies · {release.eligible ? 'provider eligible' : release.blockers.join(' · ')}</small></div>
        {route.disposition !== 'plugin' ? <div className="mod-platform-route"><ShieldCheck size={18} /><span><strong>{routeLabel(route)}</strong><small>{routeExplanation(route)}</small></span></div> : <>
          <div className="mod-supply-progress" aria-label={`供应链进度 ${release.dependencyId}`}>
            <span className={flow?.acquisitionPlan ? 'done' : ''}>A1<small>获取预演</small></span>
            <span className={flow?.acquisitionVerified ? 'done' : ''}>A2<small>持久制品</small></span>
            <span className={flow?.importPlan ? 'done' : ''}>I1<small>导入预演</small></span>
            <span className={flow?.importVerified ? 'done' : ''}>I2<small>载荷回执</small></span>
          </div>
          <div className="mod-supply-actions">
            {!flow?.acquisitionPlan && <button type="button" aria-label={`预演获取 ${release.dependencyId}`} disabled={!canAcquire || demo || busy || !candidate || candidateExpired(candidate)} onClick={() => void previewAcquisition(release)}><CloudDownload size={13} />获取预演</button>}
            {flow?.acquisitionPlan && !flow.acquisitionVerified && <><label><span>ACQUIRE CONFIRM</span><input aria-label={`获取确认 ${release.dependencyId}`} value={flow.acquisitionConfirmation} onChange={(event) => updateFlow(release.dependencyId, { acquisitionConfirmation: event.target.value })} placeholder={acquisitionConfirmation} /></label><button type="button" aria-label={`执行获取 ${release.dependencyId}`} disabled={!canAcquire || demo || busy || flow.acquisitionConfirmation !== acquisitionConfirmation} onClick={() => void executeAcquisition(release)}><FileCheck2 size={13} />执行获取</button></>}
            {flow?.acquisitionVerified && !flow.importPlan && <button type="button" aria-label={`预演导入 ${release.dependencyId}`} disabled={busy} onClick={() => void previewImport(release)}><PackageCheck size={13} />导入预演</button>}
            {flow?.importPlan && !flow.importVerified && <><label><span>IMPORT CONFIRM</span><input aria-label={`导入确认 ${release.dependencyId}`} value={flow.importConfirmation} disabled={!canImport} onChange={(event) => updateFlow(release.dependencyId, { importConfirmation: event.target.value })} placeholder={importConfirmation} /></label><button type="button" aria-label={`执行导入 ${release.dependencyId}`} disabled={!canImport || demo || busy || flow.importConfirmation !== importConfirmation} onClick={() => void executeImport(release)}><Boxes size={13} />{canImport ? '执行导入' : '需要 Administrator'}</button></>}
            {flow?.importVerified && <><span className="mod-supply-verified"><Check size={13} />PAYLOAD VERIFIED</span><label><span>CLIENT PARITY</span><select aria-label={`客户端策略 ${release.dependencyId}`} value={flow.clientRequirement} onChange={(event) => updateFlow(release.dependencyId, { clientRequirement: event.target.value as ModClientRequirement })}><option value="required">客户端必须</option><option value="optional">客户端可选</option><option value="not-required">服务端专用</option></select></label></>}
          </div>
          {flow?.error && <div className="mod-node-error"><TriangleAlert size={13} />{flow.error}</div>}
        </>}
      </article>
    })}</div> : <div className="mod-supply-empty"><GitBranch size={30} /><span><strong>输入 Thunderstore 包身份并发现精确闭包</strong><small>服务端会递归固定所有版本，并把 Nebula / BepInEx 平台包从普通模组部署中分流。</small></span></div>}
    <footer className="mod-supply-commit"><div><LockKeyhole size={18} /><span><strong>{generated ? '已生成服务端验证锁' : '等待所有 plugin 持久导入回执'}</strong><small>{generated ? `${generated.serverLock.mods.length} 个包 · ${shortHash(generated.serverLockSha256, 20)}` : '最终请求不接受浏览器提交的 release、哈希或 staged manifest。'}</small></span></div><button type="button" aria-label="生成模组部署请求" disabled={!allPluginsImported || buildingLock || !/^[0-9a-f]{64}$/.test(activeRevision)} onClick={() => void buildDeploymentRequest()}><RefreshCw className={buildingLock ? 'spin' : ''} size={14} />{buildingLock ? '服务端验证中…' : '生成模组部署请求'}</button></footer>
  </section>
}

function emptyFlow(): PackageFlow {
  return {
    acquisitionPlan: null,
    acquisitionRequestId: createUiRequestId(),
    acquisitionReceipt: null,
    acquisitionVerified: false,
    acquisitionConfirmation: '',
    importPlan: null,
    importRequestId: createUiRequestId(),
    importReceipt: null,
    importVerified: false,
    importConfirmation: '',
    clientRequirement: 'required',
    error: ''
  }
}

function routeFor(closure: ThunderstoreDependencyClosure, dependencyId: string): ThunderstoreDependencyRoute | null {
  return closure.routes.find((route) => route.dependencyId.toLowerCase() === dependencyId.toLowerCase()) ?? null
}

function routeLabel(route: ThunderstoreDependencyRoute): string {
  if (route.disposition === 'plugin') return 'PLUGIN PIPELINE'
  if (route.disposition === 'managed-component') return 'MANAGED NEBULA'
  if (route.disposition === 'external-prerequisite') return 'BEPINEX PREREQUISITE'
  return 'MANUAL POLICY'
}

function routeExplanation(route: Exclude<ThunderstoreDependencyRoute, { disposition: 'plugin' }>): string {
  if (route.disposition === 'managed-component') return '该包归 Nebula 组件更新事务，不得写入 mods root。'
  if (route.disposition === 'external-prerequisite') return '仅核对受管 BepInEx inventory，不得当作普通 plugin 导入。'
  return '保留平台包名但来源未受信，需要人工策略审核。'
}

function validClosure(
  closure: ThunderstoreDependencyClosure,
  acquisition: ArtifactAcquisitionDiscoveryMeta
): boolean {
  if (closure.order !== 'dependencies-first' || closure.nodeCount !== closure.items.length ||
      closure.routes.length !== closure.items.length || closure.items.length === 0) return false
  const dependencies = new Set(closure.items.map((item) => item.dependencyId.toLowerCase()))
  const routes = new Set<string>()
  for (const item of closure.items) {
    const route = routeFor(closure, item.dependencyId)
    if (!route || route.sourceId !== item.sourceId || route.requiredVersion !== item.version ||
        routes.has(route.dependencyId.toLowerCase())) return false
    routes.add(route.dependencyId.toLowerCase())
    if (item.dependencies.some((dependency) => !dependencies.has(dependency.toLowerCase()))) return false
    const registration = acquisition.candidates.find((entry) => entry.artifactId === item.artifact.artifactId)
    if (route.disposition === 'plugin') {
      if (!registration) return false
    } else if (registration?.candidate !== null) return false
  }
  return closure.roots.every((root) => dependencies.has(root.toLowerCase()))
}

function candidateExpired(candidate: ArtifactAcquisitionCandidate): boolean {
  const expiresAt = Date.parse(candidate.expiresAt)
  return !Number.isFinite(expiresAt) || expiresAt <= Date.now()
}

function acquisitionPlanMatches(plan: ArtifactAcquisitionPlan, candidate: ArtifactAcquisitionCandidate): boolean {
  return plan.format === 'dyson-control-artifact-acquisition-plan' && plan.schemaVersion === 1 && plan.dryRun === true &&
    plan.candidate.candidateId === candidate.candidateId && plan.candidate.artifact.artifactId === candidate.artifact.artifactId &&
    plan.candidate.release.sourceId === candidate.release.sourceId && plan.candidate.release.version === candidate.release.version
}

function acquisitionReceiptMatches(
  receipt: ArtifactAcquisitionReceipt,
  requestId: string,
  candidate: ArtifactAcquisitionCandidate
): boolean {
  return receipt.format === 'dyson-control-artifact-acquisition-receipt' && receipt.schemaVersion === 1 &&
    receipt.requestId === requestId && receipt.candidateId === candidate.candidateId && receipt.state === 'acquired' &&
    receipt.release.sourceId === candidate.release.sourceId && receipt.release.version === candidate.release.version &&
    exactDependenciesMatch(receipt.release.dependencies, candidate.release.dependencies ?? []) &&
    receipt.release.dependencyFingerprint === candidate.release.dependencyFingerprint &&
    receipt.artifact.artifactId === candidate.artifact.artifactId && /^[0-9a-f]{64}$/.test(receipt.artifact.sha256)
}

function exactDependenciesMatch(actual: string[] | undefined, expected: string[]): boolean {
  if (!Array.isArray(actual) || actual.length !== expected.length) return false
  const normalized = [...expected].sort((left, right) => left < right ? -1 : left > right ? 1 : 0)
  return actual.every((dependency, index) => dependency === normalized[index])
}

function importPlanMatches(
  plan: ThunderstoreModImportPlan,
  acquisitionReceiptId: string,
  release: DiscoveredModRelease
): boolean {
  return plan.format === 'dyson-control-thunderstore-mod-import-plan' && plan.schemaVersion === 1 && plan.dryRun === true &&
    plan.acquisitionReceiptId === acquisitionReceiptId && plan.package.dependencyId === release.dependencyId &&
    plan.package.sourceId === release.sourceId && plan.package.version === release.version
}

function importReceiptMatches(
  receipt: ThunderstoreModImportReceipt,
  requestId: string,
  acquisitionReceiptId: string,
  release: DiscoveredModRelease
): boolean {
  return receipt.format === 'dyson-control-thunderstore-mod-import-receipt' && receipt.schemaVersion === 1 &&
    receipt.requestId === requestId && receipt.acquisitionReceiptId === acquisitionReceiptId && receipt.state === 'staged' &&
    receipt.package.dependencyId === release.dependencyId && receipt.package.sourceId === release.sourceId &&
    receipt.package.version === release.version && receipt.payload.manifest.dependencyId === release.dependencyId &&
    receipt.payload.manifest.sourceId === release.sourceId && receipt.payload.manifest.version === release.version &&
    receipt.payload.fileCount === receipt.payload.manifest.files.length &&
    receipt.payload.sizeBytes === receipt.payload.manifest.files.reduce((total, file) => total + file.sizeBytes, 0) &&
    /^[0-9a-f]{64}$/.test(receipt.payload.sha256)
}

function validVerifiedManifest(
  manifest: VerifiedModManifestPreview,
  closure: ThunderstoreDependencyClosure,
  roots: string[]
): boolean {
  const releases = closure.items.filter((release) => routeFor(closure, release.dependencyId)?.disposition === 'plugin')
  const expectedPlatforms = closure.routes.filter((route) =>
    route.disposition === 'managed-component' || route.disposition === 'external-prerequisite')
  if (manifest.mode !== 'dry-run' || manifest.serverLock.format !== 'dyson-control-server-mod-lock' ||
      manifest.serverLock.schemaVersion !== 1 || manifest.clientParity.format !== 'dyson-control-client-parity' ||
      manifest.clientParity.schemaVersion !== 1 || !/^[0-9a-f]{64}$/.test(manifest.serverLockSha256) ||
      manifest.clientParity.serverLockSha256 !== manifest.serverLockSha256 ||
      manifest.platformLock.format !== 'dyson-control-mod-platform-lock' ||
      manifest.platformLock.schemaVersion !== 1 ||
      manifest.platformLock.serverLockSha256 !== manifest.serverLockSha256 ||
      !/^[0-9a-f]{64}$/.test(manifest.platformLock.digest) ||
      manifest.serverLock.mods.length !== releases.length || manifest.clientParity.mods.length !== releases.length ||
      !Array.isArray(manifest.platformRequirements) || manifest.platformRequirements.length !== expectedPlatforms.length ||
      manifest.platformRequirements.some((requirement) =>
        requirement.satisfied !== true || !['nebula', 'bepinex'].includes(requirement.deploymentOwner) ||
        typeof requirement.dependencyId !== 'string' || typeof requirement.sourceId !== 'string' ||
        typeof requirement.requiredVersion !== 'string' || requirement.actualVersion !== requirement.requiredVersion)) return false
  const releaseIds = new Set(releases.map((release) => release.dependencyId.toLowerCase()))
  const lockIds = new Set(manifest.serverLock.mods.map((entry) => entry.dependencyId.toLowerCase()))
  if ((expectedPlatforms.length === 0) !== (manifest.platformLock.inventoryRevision === null) ||
      (manifest.platformLock.inventoryRevision !== null && !/^[0-9a-f]{64}$/.test(manifest.platformLock.inventoryRevision)) ||
      manifest.platformLock.requirements.length !== expectedPlatforms.length) return false
  const platformIds = new Set<string>()
  const platformsMatch = manifest.platformRequirements.every((requirement) => {
    const id = requirement.dependencyId.toLowerCase()
    if (platformIds.has(id)) return false
    platformIds.add(id)
    const route = expectedPlatforms.find((entry) => entry.dependencyId.toLowerCase() === id)
    return route?.sourceId === requirement.sourceId && route.requiredVersion === requirement.requiredVersion &&
      route.deploymentOwner === requirement.deploymentOwner
  })
  const platformLockIds = new Set<string>()
  const platformLockMatches = manifest.platformLock.requirements.every((requirement) => {
    const id = requirement.dependencyId.toLowerCase()
    if (platformLockIds.has(id)) return false
    platformLockIds.add(id)
    const route = expectedPlatforms.find((entry) =>
      entry.dependencyId.toLowerCase() === id)
    return route?.sourceId === requirement.sourceId && route.deploymentOwner === requirement.deploymentOwner &&
      route.requiredVersion === requirement.requiredVersion
  })
  const releasesMatch = manifest.serverLock.mods.every((entry) => {
    const release = releases.find((candidate) => candidate.dependencyId.toLowerCase() === entry.dependencyId.toLowerCase())
    return release?.sourceId === entry.sourceId && release.version === entry.version && /^[0-9a-f]{64}$/.test(entry.sha256)
  })
  return lockIds.size === releases.length && [...releaseIds].every((id) => lockIds.has(id)) && releasesMatch &&
    platformIds.size === expectedPlatforms.length && platformsMatch &&
    platformLockIds.size === expectedPlatforms.length && platformLockMatches &&
    roots.every((root) => lockIds.has(root.toLowerCase()))
}

function formatSupplyError(reason: unknown, fallback: string): string {
  if (reason instanceof ApiError) return `${reason.message}${reason.code ? ` · ${reason.code}` : ''}`
  return reason instanceof Error && /^[A-Z0-9_]+$/.test(reason.message) ? `${fallback} · ${reason.message}` : fallback
}

function shortHash(value: string, length: number): string {
  return value.length <= length ? value : `${value.slice(0, length)}…`
}

const fictionalRelease: DiscoveredModRelease = {
  provider: 'thunderstore',
  sourceId: 'thunderstore:Fictional/ServerHelper',
  dependencyId: 'Fictional-ServerHelper-1.0.0',
  namespace: 'Fictional', name: 'ServerHelper', version: '1.0.0', dependencies: [],
  publishedAt: '2026-08-31T00:00:00.000Z', deprecated: false, eligible: true,
  blockers: ['artifact-integrity-pending'],
  artifact: {
    artifactId: `fictional-artifact-${'a'.repeat(32)}`,
    downloadUrl: 'https://thunderstore.io/package/download/Fictional/ServerHelper/1.0.0/',
    fileName: 'Fictional-ServerHelper-1.0.0.zip', sizeBytes: null, sha256: null,
    integrity: 'locally-computed-required'
  }
}

const fictionalClosureEnvelope = {
  data: {
    roots: [fictionalRelease.dependencyId],
    order: 'dependencies-first' as const,
    items: [fictionalRelease],
    routes: [{
      dependencyId: fictionalRelease.dependencyId,
      sourceId: fictionalRelease.sourceId,
      requiredVersion: fictionalRelease.version,
      disposition: 'plugin' as const,
      deploymentOwner: 'mods' as const,
      resolution: 'mod-import-pipeline' as const,
      directPluginAcquisitionAllowed: true as const
    }],
    nodeCount: 1,
    maximumDepth: 0,
    canAcquireAll: false,
    blocked: []
  },
  meta: {
    acquisition: {
      configured: false,
      executionEnabled: false,
      candidates: [{ artifactId: fictionalRelease.artifact.artifactId, eligible: true, status: 'not-configured' as const, candidate: null }]
    }
  }
}
