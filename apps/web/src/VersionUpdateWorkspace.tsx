import { useCallback, useEffect, useRef, useState } from 'react'
import {
  Check, CloudDownload, Database, History, LockKeyhole, PackageCheck,
  RefreshCw, ScanSearch, ShieldCheck, TriangleAlert, Undo2, Wrench
} from 'lucide-react'
import { api, ApiError } from './api'
import { relativeTime } from './format'
import { NebulaPluginTransactionWorkspace } from './NebulaPluginTransactionWorkspace'
import { createUiRequestId } from './request-id'
import type {
  ArtifactAcquisitionCandidate, ArtifactAcquisitionDiscoveryMeta, ArtifactAcquisitionPlan,
  ArtifactAcquisitionReceipt, ArtifactAcquisitionRegistration,
  AvailableComponentCandidatePreparationPlan, ComponentCandidatePreparationPlan,
  ComponentCandidatePreparationReceipt, ComponentDiscoveryRelease,
  ManagedUpdateComponent, ServerStatus, SessionUser,
  SupportedComponentCandidatePreparationComponent,
  UpdateActivationConfirmation, UpdateActivationPlan,
  UpdateActivationReceipt, UpdateActivationRecoveryStatus, UpdateActivationRequest, UpdateActivationState,
  UpdateCleanupPlan, UpdateCompatibilityPreparationRequest, UpdateCompatibilityReceipt,
  UpdateCompatibilityStatus
} from './model'

interface ActivationDraft {
  requestId: string
  component: SupportedComponentCandidatePreparationComponent
  artifactId: string
  sha256: string
  targetVersion: string
  expectedRevision: string
}

type SteamManualHandoffPhase =
  | 'preparing' | 'awaiting-steam-client-update' | 'validating-client-update'
  | 'starting-and-verifying' | 'succeeded' | 'recovery-required'

interface SteamManualHandoffRequest {
  requestId: string
  targetVersion: string
  expectedRevision: string
}

interface SteamManualHandoffPlan extends SteamManualHandoffRequest {
  format: 'dyson-control-steam-manual-handoff-plan'
  schemaVersion: 1
  dryRun: true
  timeoutSeconds: number
  accountAutomation: false
  operations: readonly string[]
}

interface SteamManualHandoffReceipt {
  format: 'dyson-control-steam-manual-handoff-receipt'
  schemaVersion: 1
  requestId: string
  targetVersion: string
  phase: SteamManualHandoffPhase
  previousRevision: string
  resultingRevision: string
  transactionBindingSha256: string | null
  protectionBackupId: string | null
  protectionManifestSha256: string | null
  previousDspVersion: string | null
  compatibilityRevision: string | null
  startedAt: string
  expiresAt: string
  completedAt: string | null
  failureCode: string | null
  recoveryRequired: boolean
  steps: {
    protectionPoint: 'pending' | 'verified' | 'failed'
    gracefulStop: 'pending' | 'verified' | 'failed'
    stoppedProof: 'pending' | 'verified' | 'failed'
    operatorConfirmation: 'pending' | 'verified'
    versionResample: 'pending' | 'verified' | 'failed'
    compatibilityResample: 'pending' | 'verified' | 'failed'
    exactSaveLoad: 'pending' | 'verified' | 'failed'
  }
  auditEvents: string[]
  reused: boolean
}

interface SteamManualHandoffState {
  format: 'dyson-control-steam-manual-handoff-state'
  schemaVersion: 1
  revision: string
  recoveryRequired: boolean
  activeRequestId: string | null
  lastCompletedTargetVersion: string | null
  current: SteamManualHandoffReceipt | null
}

interface ComponentRollbackReceiptProjection {
  rollbackBindingSha256: string | null
  rollbackSteps: {
    component: 'not-required' | 'pending' | 'verified' | 'failed'
    configuration: 'not-required' | 'pending' | 'verified' | 'failed'
    serverModLock: 'not-required' | 'pending' | 'verified' | 'failed'
    pairedSave: 'not-required' | 'pending' | 'verified' | 'failed'
    previousSaveLoad: 'not-required' | 'pending' | 'verified' | 'failed'
  }
}

type ExecutionGateSignal = 'server-enforced' | 'accepted' | 'fail-closed'
type SteamHandoffBusy = 'preview' | 'begin' | 'confirm' | null

type CompatibilityReceiptStateCode =
  | 'ready' | 'status-unavailable' | 'policy-unavailable' | 'receipt-missing'
  | 'receipt-unverified' | 'receipt-invalid' | 'candidate-mismatch'
  | 'revision-stale' | 'receipt-expired' | 'incompatible'

interface CompatibilityReceiptState {
  code: CompatibilityReceiptStateCode
  label: string
  detail: string
  tone: 'green' | 'amber' | 'red' | 'muted'
}

const managedComponents: Array<{
  component: SupportedComponentCandidatePreparationComponent
  label: string
  source: string
  description: string
}> = [
  { component: 'nebula', label: 'Nebula', source: 'github:NebulaModTeam/nebula', description: '多人运行时' },
  { component: 'bepinex', label: 'BepInEx', source: 'github:BepInEx/BepInEx', description: '模组加载框架' }
]

const unavailableManagedComponents = [
  { component: 'bridge', label: 'Bridge', description: '固定桥接插件' },
  { component: 'control', label: 'Control', description: '固定控制插件' }
] as const

const componentConfirmations: Record<SupportedComponentCandidatePreparationComponent, UpdateActivationConfirmation> = {
  nebula: 'ACTIVATE_NEBULA_UPDATE',
  bepinex: 'ACTIVATE_BEPINEX_UPDATE'
}

const versionPattern = /^(?:v)?\d+\.\d+\.\d+(?:\.\d+)?(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/
const artifactIdPattern = /^[a-z0-9][a-z0-9-]{15,95}$/
const sha256Pattern = /^[0-9a-f]{64}$/i
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const acquisitionConfirmation = 'ACQUIRE_UPDATE_ARTIFACT'
const preparationConfirmation = 'PREPARE_COMPONENT_CANDIDATE'
const compatibilityConfirmation = 'PREPARE_COMPATIBILITY_EVIDENCE'
const recoveryConfirmation = 'RECOVER_COMPONENT_UPDATE' as const
const steamHandoffBeginConfirmation = 'BEGIN_STEAM_CLIENT_UPDATE_HANDOFF' as const
const steamHandoffCompleteConfirmation = 'CONFIRM_STEAM_CLIENT_UPDATE_COMPLETED' as const
const steamHandoffOperations = [
  'capture-runtime-and-save-baseline',
  'create-paired-save-protection-point',
  'request-graceful-stop',
  'prove-process-stopped-and-port-closed',
  'await-official-steam-client-update',
  'require-fixed-operator-confirmation',
  'resample-exact-dsp-version-and-compatibility',
  'start-and-prove-current-generation-exact-save-load',
  'persist-audit-receipt'
] as const

export const steamManualHandoffApi = {
  state: (signal?: AbortSignal) => steamHandoffRequest(
    '/api/v1/updates/steam-handoff/state', parseSteamHandoffState, { signal }
  ),
  preview: (request: SteamManualHandoffRequest, signal?: AbortSignal) => steamHandoffRequest(
    '/api/v1/updates/steam-handoff/preview', parseSteamHandoffPlan,
    { method: 'POST', signal, body: JSON.stringify(request) }
  ),
  begin: (request: SteamManualHandoffRequest, signal?: AbortSignal) => steamHandoffRequest(
    '/api/v1/updates/steam-handoff/begin', parseSteamHandoffReceipt,
    {
      method: 'POST', signal,
      body: JSON.stringify({ ...request, confirmation: steamHandoffBeginConfirmation })
    }
  ),
  confirm: (requestId: string, signal?: AbortSignal) => steamHandoffRequest(
    '/api/v1/updates/steam-handoff/confirm', parseSteamHandoffReceipt,
    {
      method: 'POST', signal,
      body: JSON.stringify({ requestId, confirmation: steamHandoffCompleteConfirmation })
    }
  ),
  receipt: (requestId: string, signal?: AbortSignal) => steamHandoffRequest(
    `/api/v1/updates/steam-handoff/receipts/${encodeURIComponent(requestId)}`,
    parseSteamHandoffReceipt,
    { signal }
  )
}

export function VersionUpdateWorkspace({ status, demo, user }: {
  status: ServerStatus
  demo: boolean
  user: SessionUser
}) {
  const [activationState, setActivationState] = useState<UpdateActivationState | null>(null)
  const [recoveryStatus, setRecoveryStatus] = useState<UpdateActivationRecoveryStatus | null>(null)
  const [recoveryRequestId, setRecoveryRequestId] = useState('')
  const [recoveryConfirmationInput, setRecoveryConfirmationInput] = useState('')
  const [recovering, setRecovering] = useState(false)
  const [cleanupPlan, setCleanupPlan] = useState<UpdateCleanupPlan | null>(null)
  const [compatibilityStatus, setCompatibilityStatus] = useState<UpdateCompatibilityStatus | null>(null)
  const [compatibilityReceipt, setCompatibilityReceipt] = useState<UpdateCompatibilityReceipt | null>(null)
  const [compatibilityReceiptVerified, setCompatibilityReceiptVerified] = useState(false)
  const [compatibilityConfirmationInput, setCompatibilityConfirmationInput] = useState('')
  const [compatibilityReceiptLookupId, setCompatibilityReceiptLookupId] = useState('')
  const [compatibilityPreparing, setCompatibilityPreparing] = useState(false)
  const [compatibilityReadingReceipt, setCompatibilityReadingReceipt] = useState(false)
  const [compatibilityError, setCompatibilityError] = useState('')
  const [draft, setDraft] = useState<ActivationDraft>(() => emptyDraft('nebula'))
  const [preparedRequest, setPreparedRequest] = useState<UpdateActivationRequest | null>(null)
  const [plan, setPlan] = useState<UpdateActivationPlan | null>(null)
  const [receipt, setReceipt] = useState<UpdateActivationReceipt | null>(null)
  const [receiptVerified, setReceiptVerified] = useState(false)
  const [confirmation, setConfirmation] = useState('')
  const [gateSignal, setGateSignal] = useState<ExecutionGateSignal>(demo ? 'fail-closed' : 'server-enforced')
  const [discoveryComponent, setDiscoveryComponent] =
    useState<SupportedComponentCandidatePreparationComponent>('nebula')
  const [releases, setReleases] = useState<ComponentDiscoveryRelease[]>([])
  const [acquisitionMeta, setAcquisitionMeta] = useState<ArtifactAcquisitionDiscoveryMeta | null>(null)
  const [acquisitionPlan, setAcquisitionPlan] = useState<ArtifactAcquisitionPlan | null>(null)
  const [acquisitionReceipt, setAcquisitionReceipt] = useState<ArtifactAcquisitionReceipt | null>(null)
  const [acquisitionReceiptVerified, setAcquisitionReceiptVerified] = useState(false)
  const [acquisitionRequestId, setAcquisitionRequestId] = useState(() => createUiRequestId())
  const [acquisitionReceiptLookupId, setAcquisitionReceiptLookupId] = useState('')
  const [acquisitionConfirmationInput, setAcquisitionConfirmationInput] = useState('')
  const [acquisitionPreviewing, setAcquisitionPreviewing] = useState(false)
  const [acquisitionExecuting, setAcquisitionExecuting] = useState(false)
  const [acquisitionReadingReceipt, setAcquisitionReadingReceipt] = useState(false)
  const [acquisitionError, setAcquisitionError] = useState('')
  const [preparationPlan, setPreparationPlan] = useState<ComponentCandidatePreparationPlan | null>(null)
  const [preparationReceipt, setPreparationReceipt] = useState<ComponentCandidatePreparationReceipt | null>(null)
  const [preparationReceiptVerified, setPreparationReceiptVerified] = useState(false)
  const [preparationRequestId, setPreparationRequestId] = useState(() => createUiRequestId())
  const [preparationReceiptLookupId, setPreparationReceiptLookupId] = useState('')
  const [preparationConfirmationInput, setPreparationConfirmationInput] = useState('')
  const [preparationPreviewing, setPreparationPreviewing] = useState(false)
  const [preparationExecuting, setPreparationExecuting] = useState(false)
  const [preparationReadingReceipt, setPreparationReadingReceipt] = useState(false)
  const [preparationError, setPreparationError] = useState('')
  const [preparationGateClosed, setPreparationGateClosed] = useState(false)
  const [pages, setPages] = useState(0)
  const [truncated, setTruncated] = useState(false)
  const [loading, setLoading] = useState(true)
  const [discovering, setDiscovering] = useState(false)
  const [previewing, setPreviewing] = useState(false)
  const [executing, setExecuting] = useState(false)
  const [readingReceipt, setReadingReceipt] = useState(false)
  const [loadError, setLoadError] = useState('')
  const [workflowError, setWorkflowError] = useState('')
  const [steamState, setSteamState] = useState<SteamManualHandoffState | null>(null)
  const [steamTargetVersion, setSteamTargetVersion] = useState('')
  const [steamRequestId, setSteamRequestId] = useState(() => createUiRequestId())
  const [steamPlan, setSteamPlan] = useState<SteamManualHandoffPlan | null>(null)
  const [steamReceipt, setSteamReceipt] = useState<SteamManualHandoffReceipt | null>(null)
  const [steamReceiptVerified, setSteamReceiptVerified] = useState(false)
  const [steamBeginConfirmationInput, setSteamBeginConfirmationInput] = useState('')
  const [steamCompleteConfirmationInput, setSteamCompleteConfirmationInput] = useState('')
  const [steamBusy, setSteamBusy] = useState<SteamHandoffBusy>(null)
  const [steamLoadError, setSteamLoadError] = useState('')
  const [steamError, setSteamError] = useState('')
  const operationSequence = useRef(0)
  const acquisitionSequence = useRef(0)
  const preparationSequence = useRef(0)
  const compatibilitySequence = useRef(0)
  const acquisitionAbort = useRef<AbortController | null>(null)
  const preparationAbort = useRef<AbortController | null>(null)
  const compatibilityAbort = useRef<AbortController | null>(null)
  const operationAbort = useRef<AbortController | null>(null)
  const steamSequence = useRef(0)
  const steamAbort = useRef<AbortController | null>(null)

  const canActivate = user.permissions.includes('updates.activate')
  const canReadUpdates = user.permissions.includes('updates.read')
  const canStage = user.role !== 'viewer' && user.permissions.includes('updates.stage')
  const requiredConfirmation = componentConfirmations[draft.component]
  const selectedActive = activationState?.components.find((entry) => entry.component === draft.component) ?? null
  const activationMutationBlocked = activationState === null ||
    recoveryStatus === null ||
    recoveryStatus.phase !== 'ready' ||
    recoveryStatus.mutationBlocked ||
    recoveryStatus.recoveryRequired ||
    activationState.recoveryRequired

  const load = useCallback(async (signal?: AbortSignal, showLoading = true) => {
    if (showLoading) setLoading(true)
    if (demo) {
      setActivationState(fictionalActivationState)
      setRecoveryStatus(fictionalActivationRecoveryStatus)
      setCleanupPlan(fictionalCleanupPlan)
      setCompatibilityStatus(fictionalCompatibilityStatus)
      setSteamState(fictionalSteamHandoffState)
      setSteamTargetVersion((current) => current || '0.10.35.29485')
      setDraft((current) => current.expectedRevision
        ? current
        : { ...current, expectedRevision: fictionalActivationState.revision })
      setGateSignal('fail-closed')
      setLoadError('')
      setSteamLoadError('')
      if (showLoading) setLoading(false)
      return
    }

    const [stateResult, recoveryResult, cleanupResult, compatibilityResult, steamResult] = await Promise.allSettled([
      api.updateActivationState(signal),
      api.updateActivationRecoveryStatus(signal),
      api.updateActivationCleanupPreview(signal),
      api.updateCompatibilityStatus(signal),
      steamManualHandoffApi.state(signal)
    ])
    if (signal?.aborted) return
    const errors: string[] = []
    const steamErrors: string[] = []
    if (stateResult.status === 'fulfilled') {
      setActivationState(stateResult.value.data)
      setDraft((current) => current.expectedRevision
        ? current
        : { ...current, expectedRevision: stateResult.value.data.revision })
    } else {
      errors.push(formatActivationError(stateResult.reason, '活动组件状态暂不可用。'))
      if (isClosedGateFailure(stateResult.reason)) setGateSignal('fail-closed')
    }
    if (recoveryResult.status === 'fulfilled') {
      const nextRecovery = recoveryResult.value.data
      setRecoveryStatus(nextRecovery)
      if (nextRecovery.reconciledRequestId) {
        setRecoveryRequestId((current) => current || nextRecovery.reconciledRequestId || '')
      }
    } else {
      setRecoveryStatus(null)
      errors.push(formatActivationError(recoveryResult.reason, '显式恢复状态暂不可用；更新写入保持锁定。'))
    }
    if (cleanupResult.status === 'fulfilled') setCleanupPlan(cleanupResult.value.data)
    else errors.push(formatActivationError(cleanupResult.reason, '只读清理预演暂不可用。'))
    if (compatibilityResult.status === 'fulfilled') {
      const nextStatus = compatibilityResult.value.data
      setCompatibilityStatus(nextStatus)
      setCompatibilityReceipt((current) => current === null || compatibilityReceiptMatchesStatus(current, nextStatus)
        ? current
        : null)
      setCompatibilityReceiptVerified(false)
    } else {
      setCompatibilityStatus(null)
      setCompatibilityReceiptVerified(false)
      errors.push(formatCompatibilityError(compatibilityResult.reason, '可信兼容性状态暂不可用；激活保持锁定。'))
    }
    if (steamResult.status === 'fulfilled') {
      const nextSteam = steamResult.value.data
      setSteamState(nextSteam)
      setSteamReceipt(nextSteam.current)
      setSteamReceiptVerified(false)
      setSteamRequestId((current) => nextSteam.activeRequestId ?? current)
      if (nextSteam.current !== null) {
        try {
          const persisted = await steamManualHandoffApi.receipt(nextSteam.current.requestId, signal)
          if (signal?.aborted) return
          if (!sameSteamHandoffReceipt(nextSteam.current, persisted.data)) {
            throw new ApiError(502, 'Steam 交接状态与持久回执不一致。', 'DSP_STEAM_HANDOFF_BROWSER_READBACK_INVALID')
          }
          setSteamReceipt(persisted.data)
          setSteamReceiptVerified(true)
        } catch (reason) {
          steamErrors.push(formatSteamHandoffError(reason, 'Steam 交接持久回执暂不可重读；完成确认保持锁定。'))
        }
      }
    } else {
      setSteamState(null)
      setSteamReceiptVerified(false)
      steamErrors.push(formatSteamHandoffError(steamResult.reason, 'Steam 人工交接状态暂不可用；停服与启动操作保持锁定。'))
    }
    setLoadError(errors.join(' '))
    setSteamLoadError(steamErrors.join(' '))
    if (showLoading) setLoading(false)
  }, [demo])

  useEffect(() => {
    const controller = new AbortController()
    void load(controller.signal)
    return () => {
      controller.abort()
      acquisitionAbort.current?.abort()
      preparationAbort.current?.abort()
      compatibilityAbort.current?.abort()
      operationAbort.current?.abort()
      steamAbort.current?.abort()
      operationSequence.current += 1
      acquisitionSequence.current += 1
      preparationSequence.current += 1
      compatibilitySequence.current += 1
      steamSequence.current += 1
    }
  }, [load])

  function resetTransaction(nextDraft: ActivationDraft): void {
    operationAbort.current?.abort()
    compatibilityAbort.current?.abort()
    operationSequence.current += 1
    compatibilitySequence.current += 1
    setDraft(nextDraft)
    setPreparedRequest(null)
    setPlan(null)
    setReceipt(null)
    setReceiptVerified(false)
    setConfirmation('')
    setWorkflowError('')
    setPreviewing(false)
    setExecuting(false)
    setReadingReceipt(false)
    setCompatibilityReceipt(null)
    setCompatibilityReceiptVerified(false)
    setCompatibilityConfirmationInput('')
    setCompatibilityReceiptLookupId('')
    setCompatibilityPreparing(false)
    setCompatibilityReadingReceipt(false)
    setCompatibilityError('')
  }

  function resetPreparation(): void {
    preparationAbort.current?.abort()
    preparationSequence.current += 1
    setPreparationPlan(null)
    setPreparationReceipt(null)
    setPreparationReceiptVerified(false)
    setPreparationRequestId(createUiRequestId())
    setPreparationReceiptLookupId('')
    setPreparationConfirmationInput('')
    setPreparationPreviewing(false)
    setPreparationExecuting(false)
    setPreparationReadingReceipt(false)
    setPreparationError('')
    setPreparationGateClosed(false)
  }

  function selectComponent(component: SupportedComponentCandidatePreparationComponent): void {
    if (component === draft.component) return
    resetPreparation()
    resetTransaction({
      ...emptyDraft(component),
      expectedRevision: activationState?.revision ?? ''
    })
  }

  function bindCurrentRevision(): void {
    if (!activationState) return
    resetTransaction({ ...draft, requestId: createUiRequestId(), expectedRevision: activationState.revision })
  }

  function useFictionalExample(): void {
    const prepared = fictionalPreparationReceipt()
    const nextDraft: ActivationDraft = {
      requestId: createUiRequestId(),
      component: prepared.component,
      artifactId: prepared.prepared.artifactId,
      sha256: prepared.prepared.sha256,
      targetVersion: prepared.source.version,
      expectedRevision: activationState?.revision ?? fictionalActivationState.revision
    }
    resetTransaction(nextDraft)
    setPreparationReceipt(prepared)
    setPreparationReceiptLookupId(prepared.requestId)
    setPreparationReceiptVerified(true)
    const receipt = fictionalCompatibilityReceipt(nextDraft)
    setCompatibilityReceipt(receipt)
    setCompatibilityReceiptLookupId(receipt.receiptId)
    setCompatibilityReceiptVerified(true)
  }

  async function discover(component: SupportedComponentCandidatePreparationComponent): Promise<void> {
    const controller = replaceAbortController(acquisitionAbort)
    const sequence = ++acquisitionSequence.current
    setDiscovering(true)
    setWorkflowError('')
    setAcquisitionError('')
    setDiscoveryComponent(component)
    setReleases([])
    setPages(0)
    setTruncated(false)
    setAcquisitionMeta(null)
    setAcquisitionPlan(null)
    setAcquisitionReceipt(null)
    setAcquisitionReceiptVerified(false)
    setAcquisitionConfirmationInput('')
    resetPreparation()
    resetTransaction({
      ...emptyDraft(component),
      expectedRevision: activationState?.revision ?? ''
    })
    try {
      if (demo) {
        setReleases(component === 'nebula' ? fictionalNebulaReleases : fictionalBepInExReleases)
        setPages(1)
        setTruncated(false)
        setAcquisitionMeta(component === 'nebula' ? fictionalAcquisitionMeta : fictionalBepInExAcquisitionMeta)
      } else {
        const result = component === 'nebula'
          ? await api.discoverNebula(controller.signal)
          : await api.discoverBepInEx(controller.signal)
        if (sequence !== acquisitionSequence.current || controller.signal.aborted) return
        const normalizedPage = normalizeComponentDiscoveryPage(result.data, component)
        const normalizedMeta = normalizeAcquisitionDiscoveryMeta(result.meta?.acquisition)
        if (!normalizedPage) {
          setAcquisitionError('官方发现响应未通过严格组件合同；获取动作保持锁定。')
          return
        }
        setReleases(normalizedPage.items)
        setPages(normalizedPage.pagesFetched)
        setTruncated(normalizedPage.truncated)
        setAcquisitionMeta(normalizedMeta)
        if (!normalizedMeta) {
          setAcquisitionError('发现响应中的 acquisition 元数据未通过严格合同；获取动作保持锁定。')
        }
      }
    } catch (reason) {
      if (sequence === acquisitionSequence.current && !controller.signal.aborted) {
        setWorkflowError(reason instanceof Error ? reason.message : '官方版本发现失败。')
      }
    } finally {
      if (sequence === acquisitionSequence.current) setDiscovering(false)
    }
  }

  async function previewAcquisition(
    release: ComponentDiscoveryRelease,
    registration: ArtifactAcquisitionRegistration | null
  ): Promise<void> {
    const candidate = validAcquisitionCandidate(release, registration)
    if (!canReadUpdates || demo || acquisitionMeta?.configured !== true || !candidate || candidateExpired(candidate)) return
    const controller = replaceAbortController(acquisitionAbort)
    const sequence = ++acquisitionSequence.current
    const nextRequestId = createUiRequestId()
    const component = componentFromRelease(release)
    setAcquisitionPreviewing(true)
    setAcquisitionError('')
    setAcquisitionPlan(null)
    setAcquisitionReceipt(null)
    setAcquisitionReceiptVerified(false)
    setAcquisitionConfirmationInput('')
    setAcquisitionRequestId(nextRequestId)
    setAcquisitionReceiptLookupId(nextRequestId)
    resetPreparation()
    resetTransaction({
      ...emptyDraft(component),
      expectedRevision: activationState?.revision ?? ''
    })
    try {
      const result = await api.previewArtifactAcquisition(candidate.candidateId, controller.signal)
      if (sequence !== acquisitionSequence.current || controller.signal.aborted) return
      if (!acquisitionPlanMatchesCandidate(result.data, candidate)) {
        setAcquisitionError('服务端获取预演与所选候选身份不一致；已保持 fail-closed。')
        return
      }
      setAcquisitionPlan(result.data)
    } catch (reason) {
      if (sequence === acquisitionSequence.current && !controller.signal.aborted) {
        setAcquisitionError(formatAcquisitionError(reason, '受管制品获取预演失败。'))
      }
    } finally {
      if (sequence === acquisitionSequence.current) setAcquisitionPreviewing(false)
    }
  }

  async function executeAcquisition(): Promise<void> {
    const candidate = acquisitionPlan?.candidate
    if (!candidate || !canStage || demo || acquisitionMeta?.configured !== true ||
        acquisitionMeta.executionEnabled !== true || candidateExpired(candidate) ||
        acquisitionConfirmationInput !== acquisitionConfirmation) return
    const controller = replaceAbortController(acquisitionAbort)
    const sequence = ++acquisitionSequence.current
    setAcquisitionExecuting(true)
    setAcquisitionError('')
    setAcquisitionReceiptVerified(false)
    resetPreparation()
    try {
      const result = await api.executeArtifactAcquisition(
        acquisitionRequestId,
        candidate.candidateId,
        controller.signal
      )
      if (sequence !== acquisitionSequence.current || controller.signal.aborted) return
      if (!acquisitionReceiptMatches(result.data, acquisitionRequestId, candidate)) {
        setAcquisitionError('服务端获取回执与预演身份不一致；不会继续进入激活流程。')
        return
      }
      setAcquisitionReceipt(result.data)
      setAcquisitionReceiptLookupId(result.data.requestId)
      setAcquisitionConfirmationInput('')
      try {
        const persisted = await api.artifactAcquisitionReceipt(result.data.requestId, controller.signal)
        if (sequence !== acquisitionSequence.current || controller.signal.aborted) return
        if (!acquisitionReceiptMatches(persisted.data, result.data.requestId, candidate)) {
          setAcquisitionError('持久获取回执与执行结果不一致；已保持 fail-closed。')
          return
        }
        setAcquisitionReceipt(persisted.data)
        setAcquisitionReceiptVerified(true)
      } catch (reason) {
        if (sequence === acquisitionSequence.current && !controller.signal.aborted) {
          setAcquisitionError(formatAcquisitionError(reason, '制品已返回获取结果，但持久回执尚未重新读取。'))
        }
      }
    } catch (reason) {
      if (sequence === acquisitionSequence.current && !controller.signal.aborted) {
        if (reason instanceof ApiError && reason.status === 423) {
          setAcquisitionMeta((current) => current ? { ...current, executionEnabled: false } : current)
        }
        if (reason instanceof ApiError && reason.code === 'ACQUISITION_CANDIDATE_EXPIRED') {
          setAcquisitionPlan(null)
        }
        setAcquisitionError(formatAcquisitionError(reason, '受管制品获取被拒绝。'))
      }
    } finally {
      if (sequence === acquisitionSequence.current) setAcquisitionExecuting(false)
    }
  }

  async function readAcquisitionReceipt(): Promise<void> {
    const lookupId = acquisitionReceiptLookupId.trim().toLowerCase()
    if (!uuidPattern.test(lookupId) || demo) {
      if (!demo) setAcquisitionError('获取回执 request ID 必须是标准 UUID。')
      return
    }
    const controller = replaceAbortController(acquisitionAbort)
    const sequence = ++acquisitionSequence.current
    setAcquisitionReadingReceipt(true)
    setAcquisitionError('')
    setAcquisitionReceiptVerified(false)
    resetPreparation()
    try {
      const result = await api.artifactAcquisitionReceipt(lookupId, controller.signal)
      if (sequence !== acquisitionSequence.current || controller.signal.aborted) return
      if (!acquisitionReceiptMatches(result.data, lookupId)) {
        setAcquisitionError('持久获取回执未通过固定身份校验。')
        return
      }
      if (!isPreparationComponent(result.data.release.kind)) {
        setAcquisitionError('该获取回执不属于 Nebula/BepInEx 组件候选；不能进入组件准备。')
        return
      }
      setAcquisitionReceipt(result.data)
      setAcquisitionReceiptVerified(true)
      setAcquisitionRequestId(result.data.requestId)
      setAcquisitionReceiptLookupId(result.data.requestId)
      setDiscoveryComponent(result.data.release.kind)
      resetTransaction({
        ...emptyDraft(result.data.release.kind),
        expectedRevision: activationState?.revision ?? ''
      })
    } catch (reason) {
      if (sequence === acquisitionSequence.current && !controller.signal.aborted) {
        setAcquisitionError(formatAcquisitionError(reason, '没有找到该 request ID 的持久获取回执。'))
      }
    } finally {
      if (sequence === acquisitionSequence.current) setAcquisitionReadingReceipt(false)
    }
  }

  async function previewPreparation(): Promise<void> {
    const acquired = acquisitionReceipt
    if (!canReadUpdates || demo || !acquisitionReceiptVerified || !acquired ||
        !isPreparationComponent(acquired.release.kind)) return
    const controller = replaceAbortController(preparationAbort)
    const sequence = ++preparationSequence.current
    const nextRequestId = createUiRequestId()
    setPreparationPreviewing(true)
    setPreparationError('')
    setPreparationPlan(null)
    setPreparationReceipt(null)
    setPreparationReceiptVerified(false)
    setPreparationConfirmationInput('')
    setPreparationRequestId(nextRequestId)
    setPreparationReceiptLookupId(nextRequestId)
    resetTransaction({
      ...emptyDraft(acquired.release.kind),
      expectedRevision: activationState?.revision ?? ''
    })
    try {
      const result = await api.previewComponentCandidatePreparation(
        acquired.release.kind,
        acquired.requestId,
        controller.signal
      )
      if (sequence !== preparationSequence.current || controller.signal.aborted) return
      if (!preparationPlanMatchesAcquisition(result.data, acquired)) {
        setPreparationError('组件准备预演与持久获取回执身份不一致；激活保持锁定。')
        return
      }
      setPreparationPlan(result.data)
    } catch (reason) {
      if (sequence === preparationSequence.current && !controller.signal.aborted) {
        setPreparationError(formatPreparationError(reason, '组件候选准备预演失败。'))
      }
    } finally {
      if (sequence === preparationSequence.current) setPreparationPreviewing(false)
    }
  }

  async function executePreparation(): Promise<void> {
    const acquired = acquisitionReceipt
    const availablePlan = preparationPlan?.available === true ? preparationPlan : null
    if (!availablePlan || !acquired || !acquisitionReceiptVerified || !canStage || demo ||
        preparationGateClosed || preparationConfirmationInput !== preparationConfirmation ||
        !preparationPlanMatchesAcquisition(availablePlan, acquired)) return
    const controller = replaceAbortController(preparationAbort)
    const sequence = ++preparationSequence.current
    setPreparationExecuting(true)
    setPreparationError('')
    setPreparationReceiptVerified(false)
    try {
      const result = await api.executeComponentCandidatePreparation(
        preparationRequestId,
        availablePlan.component,
        acquired.requestId,
        controller.signal
      )
      if (sequence !== preparationSequence.current || controller.signal.aborted) return
      if (result.data.format !== 'dyson-control-component-preparation-receipt' ||
          !preparationReceiptMatches(
            result.data,
            preparationRequestId,
            availablePlan,
            acquired
          )) {
        setPreparationError('组件准备执行结果未通过严格 prepared receipt 校验；激活保持锁定。')
        return
      }
      setPreparationReceipt(result.data)
      setPreparationReceiptLookupId(result.data.requestId)
      setPreparationConfirmationInput('')
      try {
        const persisted = await api.componentCandidatePreparationReceipt(
          result.data.requestId,
          controller.signal
        )
        if (sequence !== preparationSequence.current || controller.signal.aborted) return
        if (!preparationReceiptMatches(
          persisted.data,
          result.data.requestId,
          availablePlan,
          acquired
        )) {
          setPreparationError('持久 prepared receipt 与执行结果不一致；激活保持锁定。')
          return
        }
        setPreparationReceipt(persisted.data)
        setPreparationReceiptVerified(true)
      } catch (reason) {
        if (sequence === preparationSequence.current && !controller.signal.aborted) {
          setPreparationError(formatPreparationError(
            reason,
            '组件候选已返回准备结果，但持久回执尚未重新读取。'
          ))
        }
      }
    } catch (reason) {
      if (sequence === preparationSequence.current && !controller.signal.aborted) {
        if (reason instanceof ApiError && reason.status === 423) setPreparationGateClosed(true)
        setPreparationError(formatPreparationError(reason, '组件候选准备被拒绝；激活保持锁定。'))
      }
    } finally {
      if (sequence === preparationSequence.current) setPreparationExecuting(false)
    }
  }

  async function readPreparationReceipt(): Promise<void> {
    const requestId = preparationReceiptLookupId.trim().toLowerCase()
    if (!uuidPattern.test(requestId) || demo || !canReadUpdates) {
      if (!demo && canReadUpdates) setPreparationError('准备回执 request ID 必须是标准 UUID。')
      return
    }
    const controller = replaceAbortController(preparationAbort)
    const sequence = ++preparationSequence.current
    setPreparationReadingReceipt(true)
    setPreparationError('')
    setPreparationReceiptVerified(false)
    try {
      const result = await api.componentCandidatePreparationReceipt(requestId, controller.signal)
      if (sequence !== preparationSequence.current || controller.signal.aborted) return
      if (!preparationReceiptMatches(result.data, requestId)) {
        setPreparationError('持久 prepared receipt 未通过严格身份、模式和 staging 清单校验。')
        return
      }
      setPreparationReceipt(result.data)
      setPreparationReceiptLookupId(result.data.requestId)
      setPreparationRequestId(result.data.requestId)
      setPreparationReceiptVerified(true)
      setDiscoveryComponent(result.data.component)
      resetTransaction({
        ...emptyDraft(result.data.component),
        expectedRevision: activationState?.revision ?? ''
      })
    } catch (reason) {
      if (sequence === preparationSequence.current && !controller.signal.aborted) {
        setPreparationError(formatPreparationError(reason, '没有找到该 UUID 对应的 prepared receipt。'))
      }
    } finally {
      if (sequence === preparationSequence.current) setPreparationReadingReceipt(false)
    }
  }

  function loadPreparedCandidateForActivation(): void {
    const prepared = preparationReceipt
    if (!prepared || !preparationReceiptVerified || !activationState ||
        !preparationReceiptMatches(prepared, prepared.requestId)) return
    resetTransaction({
      requestId: createUiRequestId(),
      component: prepared.component,
      artifactId: prepared.prepared.artifactId,
      sha256: prepared.prepared.sha256,
      targetVersion: prepared.source.version,
      expectedRevision: activationState.revision
    })
  }

  async function prepareCompatibility(): Promise<void> {
    const validationError = validatePreparedDraft(
      draft,
      activationState,
      preparationReceipt,
      preparationReceiptVerified
    )
    if (validationError) {
      setCompatibilityError(validationError)
      return
    }
    if (!canStage || demo || compatibilityConfirmationInput !== compatibilityConfirmation) return
    if (!compatibilityStatus?.available || compatibilityStatus.policyRevision === null) {
      setCompatibilityError('服务端可信兼容性策略 unavailable；不会由浏览器构造替代策略。')
      return
    }
    const request: UpdateCompatibilityPreparationRequest = {
      requestId: createUiRequestId(),
      component: draft.component,
      artifactId: draft.artifactId,
      sha256: draft.sha256.toLowerCase(),
      targetVersion: draft.targetVersion.trim(),
      expectedInventoryRevision: compatibilityStatus.inventoryRevision,
      expectedPolicyRevision: compatibilityStatus.policyRevision
    }
    const controller = replaceAbortController(compatibilityAbort)
    const sequence = ++compatibilitySequence.current
    setCompatibilityPreparing(true)
    setCompatibilityError('')
    setCompatibilityReceipt(null)
    setCompatibilityReceiptVerified(false)
    try {
      const result = await api.prepareUpdateCompatibility(request, controller.signal)
      if (sequence !== compatibilitySequence.current || controller.signal.aborted) return
      if (!compatibilityReceiptMatchesRequest(result.data, request, compatibilityStatus)) {
        setCompatibilityError('兼容性准备回执与候选身份或服务端修订号不一致；激活保持锁定。')
        return
      }
      setCompatibilityReceipt(result.data)
      setCompatibilityReceiptLookupId(result.data.receiptId)
      setCompatibilityConfirmationInput('')
      try {
        const persisted = await api.updateCompatibilityReceipt(result.data.receiptId, controller.signal)
        if (sequence !== compatibilitySequence.current || controller.signal.aborted) return
        if (!compatibilityReceiptMatchesRequest(persisted.data, request, compatibilityStatus)) {
          setCompatibilityError('持久兼容性回执与准备结果不一致；激活保持锁定。')
          return
        }
        setCompatibilityReceipt(persisted.data)
        setCompatibilityReceiptVerified(true)
        if (!persisted.data.compatible) {
          setCompatibilityError('服务端可信策略判定该候选 incompatible；不会生成激活预演。')
        }
      } catch (reason) {
        if (sequence === compatibilitySequence.current && !controller.signal.aborted) {
          setCompatibilityError(formatCompatibilityError(reason, '兼容性准备已返回结果，但持久回执尚未重新读取。'))
        }
      }
    } catch (reason) {
      if (sequence === compatibilitySequence.current && !controller.signal.aborted) {
        setCompatibilityError(formatCompatibilityError(reason, '兼容性回执准备失败；激活保持锁定。'))
      }
    } finally {
      if (sequence === compatibilitySequence.current) setCompatibilityPreparing(false)
    }
  }

  async function readCompatibilityReceipt(): Promise<void> {
    const receiptId = compatibilityReceiptLookupId.trim().toLowerCase()
    if (!uuidPattern.test(receiptId) || demo) {
      if (!demo) setCompatibilityError('兼容性 receipt ID 必须是标准 UUID。')
      return
    }
    const controller = replaceAbortController(compatibilityAbort)
    const sequence = ++compatibilitySequence.current
    setCompatibilityReadingReceipt(true)
    setCompatibilityError('')
    setCompatibilityReceiptVerified(false)
    try {
      const result = await api.updateCompatibilityReceipt(receiptId, controller.signal)
      if (sequence !== compatibilitySequence.current || controller.signal.aborted) return
      setCompatibilityReceipt(result.data)
      setCompatibilityReceiptLookupId(result.data.receiptId)
      setCompatibilityReceiptVerified(true)
      const state = compatibilityReceiptState(result.data, draft, compatibilityStatus, true)
      if (state.code !== 'ready') setCompatibilityError(state.detail)
    } catch (reason) {
      if (sequence === compatibilitySequence.current && !controller.signal.aborted) {
        setCompatibilityError(formatCompatibilityError(reason, '没有找到该 UUID 对应的兼容性回执。'))
      }
    } finally {
      if (sequence === compatibilitySequence.current) setCompatibilityReadingReceipt(false)
    }
  }

  async function previewActivation(): Promise<void> {
    const compatibilityState = compatibilityReceiptState(
      compatibilityReceipt,
      draft,
      compatibilityStatus,
      compatibilityReceiptVerified
    )
    const validationError = validateDraft(
      draft,
      activationState,
      preparationReceipt,
      preparationReceiptVerified,
      compatibilityState
    )
    if (validationError) {
      setWorkflowError(validationError)
      return
    }
    const request: UpdateActivationRequest & {
      component: ManagedUpdateComponent
      artifactId: string
      compatibilityReceiptId: string
    } = {
      requestId: draft.requestId,
      component: draft.component,
      artifactId: draft.artifactId,
      sha256: draft.sha256.toLowerCase(),
      targetVersion: draft.targetVersion.trim(),
      expectedRevision: draft.expectedRevision,
      compatibilityReceiptId: compatibilityReceipt!.receiptId
    }
    const controller = replaceAbortController(operationAbort)
    const sequence = ++operationSequence.current
    setPreviewing(true)
    setWorkflowError('')
    try {
      const result = demo
        ? { data: fictionalPlan(request, activationState!) }
        : await api.previewUpdateActivation(request, controller.signal)
      if (sequence !== operationSequence.current || controller.signal.aborted) return
      setPreparedRequest(request)
      setPlan(result.data)
      setReceipt(null)
      setReceiptVerified(false)
      setConfirmation('')
    } catch (reason) {
      if (sequence === operationSequence.current && !controller.signal.aborted) {
        setWorkflowError(formatActivationError(reason, '组件更新预演失败；输入与上一份证据保持不变。'))
      }
    } finally {
      if (sequence === operationSequence.current) setPreviewing(false)
    }
  }

  async function executeActivation(): Promise<void> {
    if (!preparedRequest || !plan || !canActivate || demo || gateSignal === 'fail-closed'
        || confirmation !== requiredConfirmation || activationMutationBlocked) return
    const controller = replaceAbortController(operationAbort)
    const sequence = ++operationSequence.current
    setExecuting(true)
    setWorkflowError('')
    setReceiptVerified(false)
    try {
      const result = await api.executeUpdateActivation(preparedRequest, requiredConfirmation, controller.signal)
      if (sequence !== operationSequence.current || controller.signal.aborted) return
      setReceipt(result.data)
      setGateSignal('accepted')
      setConfirmation('')
      try {
        const persisted = await api.updateActivationReceipt(result.data.requestId, controller.signal)
        if (sequence === operationSequence.current && !controller.signal.aborted) {
          setReceipt(persisted.data)
          setReceiptVerified(true)
        }
      } catch (reason) {
        if (sequence === operationSequence.current) {
          setWorkflowError(formatActivationError(reason, '激活已返回终态，但持久回执尚未重新读取。'))
        }
      }
      if (sequence === operationSequence.current) await load(undefined, false)
    } catch (reason) {
      if (sequence === operationSequence.current && !controller.signal.aborted) {
        if (isClosedGateFailure(reason)) setGateSignal('fail-closed')
        setRecoveryRequestId((current) => current || preparedRequest.requestId)
        setWorkflowError(formatActivationError(reason, '组件激活被拒绝；预演与逻辑请求保持不变。'))
        await load(undefined, false)
      }
    } finally {
      if (sequence === operationSequence.current) setExecuting(false)
    }
  }

  async function recoverActivation(): Promise<void> {
    const requestId = recoveryRequestId.trim().toLowerCase()
    if (!canActivate || demo || recoveryStatus?.phase !== 'recovery-required' ||
        !uuidPattern.test(requestId) || recoveryConfirmationInput !== recoveryConfirmation) return
    const controller = replaceAbortController(operationAbort)
    const sequence = ++operationSequence.current
    setRecovering(true)
    setWorkflowError('')
    setReceiptVerified(false)
    try {
      const result = await api.recoverUpdateActivation(requestId, recoveryConfirmation, controller.signal)
      if (sequence !== operationSequence.current || controller.signal.aborted) return
      setReceipt(result.data)
      const persisted = await api.updateActivationReceipt(requestId, controller.signal)
      if (sequence !== operationSequence.current || controller.signal.aborted) return
      setReceipt(persisted.data)
      setReceiptVerified(true)
      setRecoveryConfirmationInput('')
      await load(undefined, false)
    } catch (reason) {
      if (sequence === operationSequence.current && !controller.signal.aborted) {
        setWorkflowError(formatActivationError(
          reason,
          '显式恢复没有得到可验证终态；恢复门禁保持关闭，禁止普通激活。'
        ))
        await load(undefined, false)
      }
    } finally {
      if (sequence === operationSequence.current) setRecovering(false)
    }
  }

  async function readPersistedReceipt(): Promise<void> {
    const requestId = receipt?.requestId ?? preparedRequest?.requestId
    if (!requestId || demo) return
    const controller = replaceAbortController(operationAbort)
    const sequence = ++operationSequence.current
    setReadingReceipt(true)
    setWorkflowError('')
    try {
      const result = await api.updateActivationReceipt(requestId, controller.signal)
      if (sequence !== operationSequence.current || controller.signal.aborted) return
      setReceipt(result.data)
      setReceiptVerified(true)
    } catch (reason) {
      if (sequence === operationSequence.current && !controller.signal.aborted) {
        setWorkflowError(formatActivationError(reason, '尚未找到此 request ID 的持久终态回执。'))
      }
    } finally {
      if (sequence === operationSequence.current) setReadingReceipt(false)
    }
  }

  async function previewSteamHandoff(): Promise<void> {
    const request: SteamManualHandoffRequest = {
      requestId: steamRequestId.trim().toLowerCase(),
      targetVersion: steamTargetVersion.trim(),
      expectedRevision: steamState?.revision ?? ''
    }
    if (validateSteamHandoffDraft(request, steamState) !== null || !canReadUpdates) return
    const controller = replaceAbortController(steamAbort)
    const sequence = ++steamSequence.current
    setSteamBusy('preview')
    setSteamError('')
    setSteamReceiptVerified(false)
    try {
      const result = demo
        ? { data: fictionalSteamHandoffPlan(request) }
        : await steamManualHandoffApi.preview(request, controller.signal)
      if (sequence !== steamSequence.current || controller.signal.aborted) return
      setSteamPlan(result.data)
      setSteamBeginConfirmationInput('')
    } catch (reason) {
      if (sequence === steamSequence.current && !controller.signal.aborted) {
        setSteamError(formatSteamHandoffError(reason, 'Steam 人工交接预演被拒绝；服务器没有发生变更。'))
      }
    } finally {
      if (sequence === steamSequence.current) setSteamBusy(null)
    }
  }

  async function beginSteamHandoff(): Promise<void> {
    if (steamPlan === null || !canActivate || demo || steamState === null ||
        steamState.recoveryRequired || steamState.activeRequestId !== null ||
        steamBeginConfirmationInput !== steamHandoffBeginConfirmation) return
    const request: SteamManualHandoffRequest = {
      requestId: steamPlan.requestId,
      targetVersion: steamPlan.targetVersion,
      expectedRevision: steamPlan.expectedRevision
    }
    const controller = replaceAbortController(steamAbort)
    const sequence = ++steamSequence.current
    setSteamBusy('begin')
    setSteamError('')
    setSteamReceiptVerified(false)
    try {
      const accepted = await steamManualHandoffApi.begin(request, controller.signal)
      if (sequence !== steamSequence.current || controller.signal.aborted) return
      if (accepted.data.phase !== 'awaiting-steam-client-update' || accepted.data.recoveryRequired) {
        throw new ApiError(502, 'Steam 交接响应未证明已进入人工客户端等待阶段。', 'DSP_STEAM_HANDOFF_BROWSER_RESPONSE_INVALID')
      }
      const [stateResult, receiptResult] = await Promise.all([
        steamManualHandoffApi.state(controller.signal),
        steamManualHandoffApi.receipt(request.requestId, controller.signal)
      ])
      if (sequence !== steamSequence.current || controller.signal.aborted) return
      if (!steamHandoffReadbackMatches(
        accepted.data, receiptResult.data, stateResult.data, 'awaiting-steam-client-update'
      )) {
        throw new ApiError(502, 'Steam 交接持久回读不一致。', 'DSP_STEAM_HANDOFF_BROWSER_READBACK_INVALID')
      }
      setSteamState(stateResult.data)
      setSteamReceipt(receiptResult.data)
      setSteamReceiptVerified(true)
      setSteamBeginConfirmationInput('')
    } catch (reason) {
      if (sequence === steamSequence.current && !controller.signal.aborted) {
        setSteamError(formatSteamHandoffError(
          reason,
          'Steam 人工交接没有得到可验证等待回执；请重新读取状态，勿假定服务器已安全停服。'
        ))
      }
    } finally {
      if (sequence === steamSequence.current) setSteamBusy(null)
    }
  }

  async function confirmSteamHandoff(): Promise<void> {
    const current = steamState?.current
    if (!canActivate || demo || !steamReceiptVerified || current?.phase !== 'awaiting-steam-client-update' ||
        current.recoveryRequired || steamCompleteConfirmationInput !== steamHandoffCompleteConfirmation) return
    const controller = replaceAbortController(steamAbort)
    const sequence = ++steamSequence.current
    setSteamBusy('confirm')
    setSteamError('')
    setSteamReceiptVerified(false)
    try {
      const accepted = await steamManualHandoffApi.confirm(current.requestId, controller.signal)
      if (sequence !== steamSequence.current || controller.signal.aborted) return
      if (accepted.data.phase !== 'succeeded' || accepted.data.recoveryRequired) {
        throw new ApiError(502, 'Steam 交接响应未证明 exact save 已加载。', 'DSP_STEAM_HANDOFF_BROWSER_RESPONSE_INVALID')
      }
      const [stateResult, receiptResult] = await Promise.all([
        steamManualHandoffApi.state(controller.signal),
        steamManualHandoffApi.receipt(current.requestId, controller.signal)
      ])
      if (sequence !== steamSequence.current || controller.signal.aborted) return
      if (!steamHandoffReadbackMatches(accepted.data, receiptResult.data, stateResult.data, 'succeeded')) {
        throw new ApiError(502, 'Steam 完成交接的持久回读不一致。', 'DSP_STEAM_HANDOFF_BROWSER_READBACK_INVALID')
      }
      setSteamState(stateResult.data)
      setSteamReceipt(receiptResult.data)
      setSteamReceiptVerified(true)
      setSteamPlan(null)
      setSteamCompleteConfirmationInput('')
      setSteamRequestId(createUiRequestId())
    } catch (reason) {
      if (sequence === steamSequence.current && !controller.signal.aborted) {
        setSteamError(formatSteamHandoffError(
          reason,
          '客户端更新确认未通过 exact version、兼容性或旧存档加载证明；事务保持等待或进入明确恢复状态。'
        ))
        try {
          const [stateResult, receiptResult] = await Promise.all([
            steamManualHandoffApi.state(controller.signal),
            steamManualHandoffApi.receipt(current.requestId, controller.signal)
          ])
          if (sequence === steamSequence.current && !controller.signal.aborted) {
            setSteamState(stateResult.data)
            setSteamReceipt(receiptResult.data)
            setSteamReceiptVerified(true)
          }
        } catch {
          // The primary bounded error remains visible; no stale readback is trusted.
        }
      }
    } finally {
      if (sequence === steamSequence.current) setSteamBusy(null)
    }
  }

  if (loading) {
    return <div className="loading-state compact"><span className="spinner" />正在并行读取活动 revision、Steam 交接、可信兼容性状态与只读清理预演…</div>
  }

  const gateLabel = gateSignal === 'accepted' ? 'GATE ACCEPTED'
    : gateSignal === 'fail-closed' ? 'FAIL-CLOSED' : 'SERVER ENFORCED'
  const gateDetail = gateSignal === 'accepted' ? '最近一次执行已由服务端接受'
    : gateSignal === 'fail-closed' ? '未配置或返回 423；不执行'
      : '默认关闭；提交时由服务端最终裁决'
  const selectedAcquisitionCandidate = acquisitionPlan?.candidate ?? null
  const acquisitionCandidateIsExpired = selectedAcquisitionCandidate
    ? candidateExpired(selectedAcquisitionCandidate)
    : false
  const currentCompatibilityState = compatibilityReceiptState(
    compatibilityReceipt,
    draft,
    compatibilityStatus,
    compatibilityReceiptVerified
  )
  const preparedDraftError = validatePreparedDraft(
    draft,
    activationState,
    preparationReceipt,
    preparationReceiptVerified
  )
  const rollbackProjection = componentRollbackReceiptProjection(receipt)

  return <div className="version-workspace update-activation-workspace">
    <div className="workspace-toolbar update-toolbar"><div><strong>确定性组件更新事务</strong><span>官方发现 · 持久获取 · 严格准备 · revision CAS · smoke · rollback</span></div><div><button type="button" onClick={() => void load()}><RefreshCw size={15} />刷新事务状态</button><button type="button" onClick={() => void discover('nebula')} disabled={discovering || !canReadUpdates}><CloudDownload className={discovering && discoveryComponent === 'nebula' ? 'spin' : ''} size={15} />{discovering && discoveryComponent === 'nebula' ? 'Nebula 发现中…' : '发现 Nebula'}</button><button type="button" onClick={() => void discover('bepinex')} disabled={discovering || !canReadUpdates}><CloudDownload className={discovering && discoveryComponent === 'bepinex' ? 'spin' : ''} size={15} />{discovering && discoveryComponent === 'bepinex' ? 'BepInEx 发现中…' : '发现 BepInEx'}</button></div></div>

    {!canActivate && <div className="permission-lock-note"><LockKeyhole size={15} /><span><strong>{user.role === 'viewer' ? 'Viewer 全局只读' : 'Operator 可获取 / 激活只读'}</strong><small>{user.role === 'viewer' ? '可以发现、预演和精确读取持久回执，但不会提交获取、候选准备、兼容性或激活写请求。' : '可以获取并准备候选、签发兼容性回执和生成激活 dry-run；只有 Administrator 可执行激活。'}</small></span></div>}
    {demo && <div className="permission-lock-note operator"><LockKeyhole size={15} /><span><strong>演示提供者保持 fail-closed</strong><small>可以使用虚构数据走完预演，但不会向执行接口发送组件激活请求。</small></span></div>}
    {loadError && <div className="update-workflow-error" role="alert"><TriangleAlert size={16} /><span>{loadError}</span></div>}
    {workflowError && <div className="update-workflow-error" role="alert"><TriangleAlert size={16} /><span>{workflowError}</span></div>}
    {compatibilityError && <div className="update-workflow-error compatibility-error" role="alert"><TriangleAlert size={16} /><span>{compatibilityError}</span></div>}
    {acquisitionError && <div className="update-workflow-error acquisition-error" role="alert"><TriangleAlert size={16} /><span>{acquisitionError}</span></div>}
    {preparationError && <div className="update-workflow-error acquisition-error" role="alert"><TriangleAlert size={16} /><span>{preparationError}</span></div>}
    {steamError && <div className="update-workflow-error" role="alert"><TriangleAlert size={16} /><span>{steamError}</span></div>}

    <section className="update-state-deck">
      <div><span>ACTIVE REVISION</span><strong>{activationState ? shortHash(activationState.revision, 16) : 'UNAVAILABLE'}</strong><small>{activationState ? `${activationState.components.length} 个托管组件` : '事务未配置或状态不可读'}</small></div>
      <div><span>RECOVERY FLAG</span><strong className={activationState?.recoveryRequired || recoveryStatus?.recoveryRequired ? 'danger' : 'green'}>{activationState ? activationState.recoveryRequired || recoveryStatus?.recoveryRequired ? 'REQUIRED' : 'CLEAR' : 'UNKNOWN'}</strong><small>{activationState?.recoveryRequired || recoveryStatus?.recoveryRequired ? '必须先执行精确 broker-bound 恢复' : '没有活动恢复标志'}</small></div>
      <div><span>HISTORY</span><strong>{activationState?.historyEntries ?? '—'}</strong><small>有界审计安全回执</small></div>
      <div className={gateSignal === 'fail-closed' ? 'gate-closed' : gateSignal === 'accepted' ? 'gate-open' : ''}><span>EXECUTION GATE</span><strong>{gateLabel}</strong><small>{gateDetail}</small></div>
      <div><span>DSP HANDOFF</span><strong className={steamState?.recoveryRequired ? 'danger' : steamState?.current?.phase === 'awaiting-steam-client-update' ? 'amber' : 'green'}>{steamState?.recoveryRequired ? 'RECOVERY' : steamState?.current?.phase === 'awaiting-steam-client-update' ? 'AWAITING CLIENT' : steamState ? 'READY' : 'UNAVAILABLE'}</strong><small>官方 Steam 客户端人工更新；控制面只协调保护、停服与证明</small></div>
    </section>

    {(activationState?.recoveryRequired || recoveryStatus?.phase === 'recovery-required') && <section className="update-execution-confirm update-recovery-confirm">
      <div><TriangleAlert size={22} /><span><strong>组件事务需要显式恢复</strong><small>输入原始 request ID 和固定确认 <code>{recoveryConfirmation}</code>。服务端只会恢复该 ID 已持久化且与全局租约绑定的事务；浏览器不能选择路径、组件或回滚目标。</small></span></div>
      <input aria-label="待恢复组件事务 UUID" value={recoveryRequestId}
        onChange={(event) => setRecoveryRequestId(event.target.value.slice(0, 36))}
        placeholder="00000000-0000-4000-8000-000000000000" autoComplete="off" spellCheck={false} />
      <input aria-label="组件恢复精确确认" value={recoveryConfirmationInput}
        onChange={(event) => setRecoveryConfirmationInput(event.target.value)}
        placeholder={recoveryConfirmation} autoComplete="off" />
      <button type="button" className="confirm-execute" onClick={() => void recoverActivation()}
        disabled={recovering || !canActivate || demo || recoveryStatus?.phase !== 'recovery-required' || !uuidPattern.test(recoveryRequestId.trim()) || recoveryConfirmationInput !== recoveryConfirmation}>
        {recovering ? '恢复证明执行中…' : !canActivate ? '需要 Administrator' : '执行精确显式恢复'}
      </button>
    </section>}

    <section className="dsp-manual-channel">
      <span className="dsp-channel-mark"><CloudDownload size={22} /></span>
      <div><strong>Dyson Sphere Program · {status.versions.dsp ?? '版本待采集'}</strong><small>游戏本体仍必须由已登录的官方 Steam 客户端人工更新。控制面不会读取或自动化账号、密码、Steam Guard、cookie、客户端路径或命令。</small></div>
      <b>MANUAL / DURABLE HANDOFF</b>
    </section>

    <section className="update-compatibility-panel">
      <header><div><CloudDownload size={17} /><span><strong>DSP 官方 Steam 客户端人工交接</strong><small>保护点 + 优雅停服 → 人工客户端更新 → exact version/compatibility → exact previous save 当前代际证明</small></span></div><b>{steamState?.current ? steamHandoffPhaseLabel(steamState.current.phase) : steamState ? 'READY' : 'FAIL-CLOSED'}</b></header>
      {steamLoadError && <div className="update-workflow-error" role="status" aria-label="Steam 人工交接状态不可用"><TriangleAlert size={16} /><span>{steamLoadError}</span></div>}
      <div className="update-compatibility-grid">
        <div><span>CURRENT DSP</span><strong>{status.versions.dsp ?? 'UNAVAILABLE'}</strong><small>只读运行时采集，不作为更新完成证明</small></div>
        <div><span>HANDOFF REVISION</span><strong>{steamState ? shortHash(steamState.revision, 18) : 'UNAVAILABLE'}</strong><small>begin 使用 expectedRevision CAS</small></div>
        <div><span>ACTIVE REQUEST</span><strong>{steamState?.activeRequestId ? shortHash(steamState.activeRequestId, 18) : 'NONE'}</strong><small>{steamReceiptVerified ? '持久 receipt 已按 UUID 重读' : steamState?.activeRequestId ? '回执未重读；确认保持锁定' : '没有等待中的停服交接'}</small></div>
        <div><span>RECOVERY</span><strong className={steamState?.recoveryRequired ? 'danger' : 'green'}>{steamState?.recoveryRequired ? 'REQUIRED' : steamState ? 'CLEAR' : 'UNKNOWN'}</strong><small>{steamState?.current?.failureCode ?? '失败不会写入伪造完成状态'}</small></div>
      </div>
      <div className="compatibility-control-deck">
        <div className={`compatibility-state-callout tone-${steamState?.recoveryRequired || steamState === null ? 'red' : steamState.current ? 'amber' : 'green'}`}><ShieldCheck size={17} /><span><strong>{steamState?.recoveryRequired ? '恢复状态锁定' : steamState?.current ? '已进入人工 Steam 客户端阶段' : steamState ? '可生成零变更预演' : '状态不可用'}</strong><small>{steamState?.recoveryRequired ? '不要启动新交接；按持久失败回执执行受控恢复。' : steamState?.current ? '仅在官方客户端明确完成后输入固定确认；错误版本可重试。' : '预演不会创建保护点、停服、启动或接触 Steam 账号。'}</small></span></div>
        <label><span>TARGET DSP VERSION</span><input aria-label="Steam 人工交接目标 DSP 版本" value={steamTargetVersion}
          disabled={steamBusy !== null || steamState?.activeRequestId !== null}
          onChange={(event) => {
            setSteamTargetVersion(event.target.value)
            setSteamPlan(null)
            setSteamBeginConfirmationInput('')
          }} placeholder="0.10.35.29485" autoComplete="off" spellCheck={false} /></label>
        <button type="button" onClick={() => void previewSteamHandoff()}
          disabled={steamBusy !== null || !canReadUpdates || validateSteamHandoffDraft({
            requestId: steamRequestId.trim().toLowerCase(), targetVersion: steamTargetVersion.trim(),
            expectedRevision: steamState?.revision ?? ''
          }, steamState) !== null}><PackageCheck className={steamBusy === 'preview' ? 'spin' : ''} size={14} />{steamBusy === 'preview' ? '预演中…' : '生成零变更预演'}</button>
        <label><span>REQUEST ID</span><input aria-label="Steam 人工交接 request ID" value={steamRequestId} readOnly /></label>
        <button type="button" onClick={() => {
          setSteamRequestId(createUiRequestId())
          setSteamPlan(null)
          setSteamReceipt(null)
          setSteamReceiptVerified(false)
          setSteamError('')
        }} disabled={steamBusy !== null || steamState?.activeRequestId !== null}><RefreshCw size={14} />新建 request</button>
      </div>
    </section>

    {steamPlan && <>
      <section className="update-operation-plan">
        <header><div><History size={16} /><strong>Steam handoff dry-run operations</strong></div><span>{steamPlan.operations.length} 步 · accountAutomation=false · 零变更</span></header>
        <div>{steamPlan.operations.map((operation, index) => <div key={`${operation}-${index}`}><b>{String(index + 1).padStart(2, '0')}</b><span><strong>{steamHandoffOperationLabel(operation)}</strong><code>{operation}</code></span></div>)}</div>
      </section>
      <section className="update-execution-confirm">
        <div><TriangleAlert size={22} /><span><strong>先保护并优雅停服，再交给官方 Steam 客户端</strong><small>输入 <code>{steamHandoffBeginConfirmation}</code>。服务端会持久化 baseline、配对存档保护点、停止态证明和超时；不会启动或操纵 Steam 客户端。</small></span></div>
        <input aria-label="Steam 人工交接开始精确确认" value={steamBeginConfirmationInput}
          disabled={!canActivate || demo || steamBusy !== null || steamState?.activeRequestId !== null || steamState?.recoveryRequired}
          onChange={(event) => setSteamBeginConfirmationInput(event.target.value)}
          placeholder={steamHandoffBeginConfirmation} autoComplete="off" />
        <button type="button" className="confirm-execute" onClick={() => void beginSteamHandoff()}
          disabled={!canActivate || demo || steamBusy !== null || steamState?.activeRequestId !== null || steamState?.recoveryRequired || steamBeginConfirmationInput !== steamHandoffBeginConfirmation}>
          {steamBusy === 'begin' ? '保护与停服证明中…' : !canActivate ? '需要 Administrator' : demo ? '演示环境不停服' : '建立持久人工交接'}</button>
      </section>
    </>}

    {steamState?.current?.phase === 'awaiting-steam-client-update' && <section className="update-execution-confirm update-recovery-confirm">
      <div><CloudDownload size={22} /><span><strong>等待操作员使用官方 Steam 客户端完成更新</strong><small>交接 request <code>{steamState.current.requestId}</code> 已证明进程停止且端口关闭。完成客户端操作后输入 <code>{steamHandoffCompleteConfirmation}</code>；服务端会重新采集 exact DSP version 与兼容性，再启动并要求 Bridge heartbeat 与加载日志在同一启动代际证明 exact previous save。</small></span></div>
      <input aria-label="Steam 客户端更新完成精确确认" value={steamCompleteConfirmationInput}
        disabled={!canActivate || demo || steamBusy !== null || !steamReceiptVerified}
        onChange={(event) => setSteamCompleteConfirmationInput(event.target.value)}
        placeholder={steamHandoffCompleteConfirmation} autoComplete="off" />
      <button type="button" className="confirm-execute" onClick={() => void confirmSteamHandoff()}
        disabled={!canActivate || demo || steamBusy !== null || !steamReceiptVerified || steamCompleteConfirmationInput !== steamHandoffCompleteConfirmation}>
        {steamBusy === 'confirm' ? '重采、启动与 exact save 证明中…' : !steamReceiptVerified ? '先重读持久回执' : '确认客户端更新已完成'}</button>
    </section>}

    {steamReceipt && <section className="update-receipt-panel">
      <header><div><ShieldCheck size={16} /><strong>Steam handoff 持久回执</strong></div><span>{steamReceiptVerified ? 'RECEIPT REREAD VERIFIED' : 'STATE PROJECTION ONLY'}</span></header>
      <div className="update-receipt-grid">
        <div><span>PHASE</span><strong>{steamHandoffPhaseLabel(steamReceipt.phase)}</strong><small>{steamReceipt.reused ? '幂等重放' : '首次响应'}</small></div>
        <div><span>PROTECTION</span><strong>{steamReceipt.steps.protectionPoint.toUpperCase()}</strong><small>{steamReceipt.protectionBackupId ? shortHash(steamReceipt.protectionBackupId, 22) : '未创建'}</small></div>
        <div><span>EXACT SAVE LOAD</span><strong>{steamReceipt.steps.exactSaveLoad.toUpperCase()}</strong><small>Bridge + 日志同启动代际</small></div>
        <div><span>BINDING</span><strong>{steamReceipt.transactionBindingSha256 ? shortHash(steamReceipt.transactionBindingSha256, 18) : 'UNAVAILABLE'}</strong><small>{steamReceipt.failureCode ?? '没有失败码'}</small></div>
      </div>
    </section>}

    <div className="update-activation-grid">
      <section className="update-component-panel">
        <header><div><Database size={16} /><strong>活动组件与固定身份</strong></div><span>路径不进入 HTTP 合同</span></header>
        <div className="active-component-list">{managedComponents.map((item) => {
          const active = activationState?.components.find((entry) => entry.component === item.component)
          return <button type="button" key={item.component} className={draft.component === item.component ? 'active' : ''} onClick={() => selectComponent(item.component)}>
            <span className={active ? 'online' : 'empty'}>{active ? 'ON' : '—'}</span><div><strong>{item.label}</strong><small>{item.description}</small><code>{item.source}</code></div><b>{active?.version ?? '未记录'}</b>
          </button>
        })}{unavailableManagedComponents.map((item) => {
          const active = activationState?.components.find((entry) => entry.component === item.component)
          return <div className="active-component-unavailable" key={item.component} aria-label={`${item.label} 自更新不可用`}>
            <span className={active ? 'online' : 'empty'}>{active ? 'ON' : '—'}</span><div><strong>{item.label}</strong><small>{item.description}</small><code>自更新 provider 未装配 · READ ONLY</code></div><b>{active?.version ?? '未记录'}</b>
          </div>
        })}</div>
      </section>

      <section className="update-request-panel">
        <header><div><Wrench size={16} /><strong>{componentLabel(draft.component)} 激活请求</strong></div><span>{draft.requestId.slice(0, 8)}</span></header>
        <div className="update-request-form">
          <label><span>ARTIFACT ID</span><input aria-label="组件 artifact ID" value={draft.artifactId} readOnly placeholder="只从 verified prepared receipt 装入" autoComplete="off" /></label>
          <label><span>SHA-256</span><input aria-label="组件 SHA-256" value={draft.sha256} readOnly placeholder="只从 verified prepared receipt 装入" autoComplete="off" spellCheck={false} /></label>
          <label><span>TARGET VERSION</span><input aria-label="组件目标版本" value={draft.targetVersion} readOnly placeholder="只从 verified prepared receipt 装入" autoComplete="off" /></label>
          <div className="update-revision-field"><span>EXPECTED REVISION</span><code>{draft.expectedRevision || 'UNAVAILABLE'}</code><button type="button" onClick={bindCurrentRevision} disabled={!activationState}><RefreshCw size={13} />绑定当前 revision</button></div>
        </div>
        <footer><ShieldCheck size={14} />请求只能由重新读取并严格核验的 prepared receipt 生成；raw acquisition receipt 永远不会直接解锁激活。</footer>
      </section>
    </div>

    <NebulaPluginTransactionWorkspace demo={demo} user={user} />

    <section className={`update-compatibility-panel state-${currentCompatibilityState.code}`}>
      <header><div><PackageCheck size={17} /><span><strong>服务端可信兼容性回执</strong><small>策略与运行时 inventory 只由服务端读取；浏览器无法提交替代矩阵。</small></span></div><b>{currentCompatibilityState.label}</b></header>
      <div className="update-compatibility-grid">
        <div><span>RUNTIME INVENTORY</span><strong>{compatibilityStatus?.inventory.dsp ?? '—'}</strong><small>Nebula {compatibilityStatus?.inventory.nebula ?? '—'} · BepInEx {compatibilityStatus?.inventory.bepInEx ?? '—'}</small></div>
        <div><span>TRUSTED POLICY</span><strong>{compatibilityStatus?.policyId ?? 'UNAVAILABLE'}</strong><small>{compatibilityStatus?.policyRevision ? shortHash(compatibilityStatus.policyRevision, 18) : '没有服务端策略 revision'}</small></div>
        <div><span>INVENTORY REVISION</span><strong>{compatibilityStatus ? shortHash(compatibilityStatus.inventoryRevision, 18) : '—'}</strong><small>{compatibilityStatus?.inventory.plugins.length ?? '—'} 个受管插件记录</small></div>
        <div><span>VERIFIED RECEIPT</span><strong>{compatibilityReceipt ? shortHash(compatibilityReceipt.receiptId, 18) : 'NONE'}</strong><small>{compatibilityReceipt ? `${compatibilityReceipt.matchedEntryId ?? 'NO MATCH'} · ${relativeTime(compatibilityReceipt.expiresAt)}` : '必须签发并重新读取持久回执'}</small></div>
      </div>
      <div className="compatibility-control-deck">
        <div className={`compatibility-state-callout tone-${currentCompatibilityState.tone}`}><ShieldCheck size={17} /><span><strong>{currentCompatibilityState.label}</strong><small>{currentCompatibilityState.detail}</small></span></div>
        <label><span>PREPARE CONFIRMATION</span><input aria-label="兼容性准备精确确认" value={compatibilityConfirmationInput}
          disabled={!canStage || demo || !compatibilityStatus?.available || compatibilityPreparing || preparedDraftError !== null}
          onChange={(event) => setCompatibilityConfirmationInput(event.target.value)} placeholder={compatibilityConfirmation} autoComplete="off" /></label>
        <button type="button" onClick={() => void prepareCompatibility()}
          disabled={!canStage || demo || compatibilityPreparing || !compatibilityStatus?.available || compatibilityConfirmationInput !== compatibilityConfirmation || preparedDraftError !== null}>
          <PackageCheck className={compatibilityPreparing ? 'spin' : ''} size={14} />{compatibilityPreparing ? '服务端裁决中…' : '签发兼容性回执'}
        </button>
        <label><span>COMPATIBILITY RECEIPT ID</span><input aria-label="兼容性回执 UUID" value={compatibilityReceiptLookupId}
          onChange={(event) => setCompatibilityReceiptLookupId(event.target.value.slice(0, 36))}
          placeholder="00000000-0000-4000-8000-000000000000" autoComplete="off" spellCheck={false} /></label>
        <button type="button" onClick={() => void readCompatibilityReceipt()}
          disabled={demo || compatibilityReadingReceipt || !uuidPattern.test(compatibilityReceiptLookupId.trim())}>
          <RefreshCw className={compatibilityReadingReceipt ? 'spin' : ''} size={13} />{compatibilityReadingReceipt ? '核对中…' : '恢复兼容性回执'}
        </button>
      </div>
      <footer><span>当前目标</span><strong>{componentLabel(draft.component)} {draft.targetVersion || '—'}</strong><span>活动记录</span><strong>{selectedActive?.version ?? '未激活记录'}</strong><span>匹配策略</span><strong>服务端 policy + inventory revision + TTL</strong></footer>
    </section>

    <section className="update-preview-gate">
      <div><ScanSearch size={20} /><span><strong>{plan ? 'DRY-RUN 已生成，执行仍未发生' : '先让服务端校验暂存资源与兼容性'}</strong><small>{plan ? `${plan.fileCount} 个文件 · ${formatBytes(plan.expandedBytes)} · release ${shortHash(plan.releaseId, 20)}` : '预演会读取固定暂存清单、核验 archive，并返回有界操作序列与回滚策略。'}</small></span></div>
      {demo && <button type="button" onClick={useFictionalExample}><ScanSearch size={14} />使用虚构示例</button>}
      <button type="button" disabled={previewing || validateDraft(draft, activationState, preparationReceipt, preparationReceiptVerified, currentCompatibilityState) !== null} onClick={() => void previewActivation()}><PackageCheck className={previewing ? 'spin' : ''} size={15} />{previewing ? '预演中…' : '生成激活预演'}</button>
    </section>

    {plan && <>
      <section className="update-operation-plan">
        <header><div><History size={16} /><strong>服务端 dry-run operations</strong></div><span>{plan.operations.length} 步 · 没有执行副作用</span></header>
        <div>{plan.operations.map((operation, index) => <div key={`${operation}-${index}`}><b>{String(index + 1).padStart(2, '0')}</b><span><strong>{operationLabel(operation)}</strong><code>{operation}</code></span></div>)}</div>
      </section>

      <section className="update-safety-semantics">
        <div><span className="semantic-icon"><ShieldCheck size={17} /></span><strong>存档保护点</strong><small>发布前创建 `.dsv + .server` 成对、持久保护；不是单文件复制。</small></div>
        <div><span className="semantic-icon"><LockKeyhole size={17} /></span><strong>停止态证明</strong><small>在保护与发布阶段分别证明 DSP 进程停止且游戏端口关闭。</small></div>
        <div><span className="semantic-icon"><ScanSearch size={17} /></span><strong>当前代际 exact save 证明</strong><small>版本/进程/端口只是前置条件；Bridge heartbeat 与加载日志必须在同一启动代际证明目标存档身份。</small></div>
        <div><span className="semantic-icon"><Undo2 size={17} /></span><strong>事务化回滚</strong><small>{plan.rollback.previousReleaseRequired ? '失败时逐项恢复组件、配置 revision、server mod-lock、配对存档，并证明 exact previous save。' : '首次激活没有上一 release；任何恢复能力或重读证明缺失都会 fail closed 到 recoveryRequired。'}</small></div>
      </section>

      <section className="update-execution-confirm">
        <div><TriangleAlert size={22} /><span><strong>组件专属精确确认</strong><small>输入 <code>{requiredConfirmation}</code>。服务端会重新核验 request、artifact、SHA-256、revision、兼容性和停止态；UI 权限不是安全边界。</small></span></div>
        <input aria-label="组件激活精确确认" value={confirmation} disabled={!canActivate || demo || gateSignal === 'fail-closed' || activationMutationBlocked} onChange={(event) => setConfirmation(event.target.value)} placeholder={requiredConfirmation} autoComplete="off" />
        <button type="button" className="confirm-execute" disabled={executing || !canActivate || demo || gateSignal === 'fail-closed' || activationMutationBlocked || confirmation !== requiredConfirmation}
          onClick={() => void executeActivation()}>{executing ? '事务执行中…' : !canActivate ? '需要 Administrator' : demo ? '演示环境不执行' : gateSignal === 'fail-closed' ? '服务端门禁已关闭' : activationMutationBlocked ? '恢复状态保持锁定' : '提交服务端激活门禁'}</button>
      </section>
    </>}

    <section className={`update-receipt-panel${receipt ? ` status-${receipt.status}` : ''}`}>
      <header><div>{receipt?.status === 'succeeded' ? <Check size={17} /> : <History size={17} />}<strong>事务回执</strong></div><span>{receiptVerified ? '已由 receipts/:requestId 重新读取' : '尚无已核对的持久回执'}</span></header>
      {receipt ? <div className="update-receipt-body"><div><span>STATUS</span><strong>{receipt.status}</strong><small>{receipt.failureCode ?? '没有失败代码'}</small></div><div><span>RESULT REVISION</span><code>{shortHash(receipt.resultingRevision, 18)}</code><small>{receipt.reused ? '幂等复用既有回执' : '首次事务回执'}</small></div><div><span>PROTECTION</span><strong>{receipt.protectionBackupId ?? '未创建'}</strong><small>{receipt.rollbackVerified ? '回滚已验证' : receipt.recoveryRequired ? '需要人工恢复' : '未触发回滚'}</small></div><div><span>COMPLETED</span><strong>{relativeTime(receipt.completedAt)}</strong><small>{receipt.fileCount} 文件 · {formatBytes(receipt.expandedBytes)}</small></div></div>
        : <div className="update-receipt-empty"><History size={23} /><span><strong>历史计数 {activationState?.historyEntries ?? '—'}</strong><small>状态 API 只返回有界计数；具体回执必须使用当前 request ID 精确读取，不枚举主机文件。</small></span></div>}
      {rollbackProjection && <div className="acquisition-operation-strip"><ShieldCheck size={15} /><span><strong>ROLLBACK JOURNAL {rollbackProjection.rollbackBindingSha256 ? shortHash(rollbackProjection.rollbackBindingSha256, 18) : 'UNBOUND'}</strong><small>component {rollbackProjection.rollbackSteps.component} · configuration {rollbackProjection.rollbackSteps.configuration} · server mod-lock {rollbackProjection.rollbackSteps.serverModLock} · paired save {rollbackProjection.rollbackSteps.pairedSave} · exact previous save load {rollbackProjection.rollbackSteps.previousSaveLoad}</small></span></div>}
      {(preparedRequest || receipt) && !demo && <footer><code>{receipt?.requestId ?? preparedRequest?.requestId}</code><button type="button" onClick={() => void readPersistedReceipt()} disabled={readingReceipt}><RefreshCw className={readingReceipt ? 'spin' : ''} size={13} />{readingReceipt ? '读取中…' : '核对持久回执'}</button></footer>}
    </section>

    <div className="update-lower-grid">
      <section className="update-cleanup-panel">
        <header><div><Undo2 size={16} /><strong>清理只读预演</strong></div><span>executeSupported=false</span></header>
        <div className="update-cleanup-summary"><div><strong>{cleanupPlan?.candidates.filter((item) => item.kind === 'history').length ?? '—'}</strong><span>超出保留期历史</span></div><div><strong>{cleanupPlan?.candidates.filter((item) => item.kind === 'release').length ?? '—'}</strong><span>未引用 release</span></div></div>
        <div className="update-cleanup-list">{cleanupPlan?.candidates.length ? cleanupPlan.candidates.slice(0, 12).map((candidate) => <div key={`${candidate.kind}-${candidate.opaqueId}`}><span>{candidate.kind.toUpperCase()}</span><code>{candidate.opaqueId}</code><b>{candidate.reason}</b></div>) : <p>{cleanupPlan ? '当前没有候选；这不是自动删除证明。' : '清理计划不可用，继续保持只读。'}</p>}</div>
        <footer><ShieldCheck size={14} />核心没有清理执行合同，浏览器因此不显示删除按钮；候选均标记 recoverable，但仍需离线核验。</footer>
      </section>

      <section className="release-catalog update-release-catalog">
        <header><div><CloudDownload size={17} /><strong>{demo ? `FictionalOrg / ${discoveryComponent}` : discoveryComponent === 'nebula' ? 'NebulaModTeam / nebula' : 'BepInEx / BepInEx · Windows x64'}</strong></div><span>{pages ? `${pages} 页 · ${releases.length} 个 ZIP 候选${truncated ? ' · 已截断' : ''}` : '尚未执行官方发现'}</span></header>
        <div>{releases.length ? releases.slice(0, 8).map((release) => {
          const registration = acquisitionRegistrationForRelease(acquisitionMeta, release)
          const candidate = validAcquisitionCandidate(release, registration)
          const expired = candidate ? candidateExpired(candidate) : false
          const presentation = acquisitionRegistrationPresentation(acquisitionMeta, registration, candidate, expired)
          return <div className="release-row" key={release.artifact.artifactId}>
            <div><strong>{release.version}</strong><small>{relativeTime(release.publishedAt)} · {release.artifact.fileName}</small></div>
            <span>{release.artifact.sizeBytes === null ? '本地计算' : formatBytes(release.artifact.sizeBytes)}</span>
            <span className={presentation.tone}>{presentation.label}</span>
            <button type="button" aria-label={`获取 ${componentLabel(componentFromRelease(release))} ${release.version} 预演`}
              disabled={!canReadUpdates || demo || !candidate || expired || acquisitionPreviewing}
              onClick={() => void previewAcquisition(release, registration)}>
              {!canReadUpdates ? '无读取权限' : acquisitionPreviewing ? '预演中…' : candidate && !expired ? '获取预演' : presentation.action}
            </button>
          </div>
        }) : <div className="catalog-empty">发现只读取固定 GitHub Releases 源；浏览器不会提交下载 URL、路径或命令。</div>}</div>
      </section>
    </div>

    <section className={`update-acquisition-panel${acquisitionReceipt ? ' has-receipt' : ''}`}>
      <header><div><CloudDownload size={17} /><strong>受管制品获取</strong></div><span>{!acquisitionMeta ? '等待官方发现' : !acquisitionMeta.configured ? 'NOT CONFIGURED' : acquisitionMeta.executionEnabled ? 'MUTATION ENABLED' : 'DEFAULT-OFF / PREVIEW ONLY'}</span></header>
      <div className="acquisition-boundary-grid">
        <div><span>CANDIDATE BINDING</span><strong>{selectedAcquisitionCandidate ? 'SERVER-BOUND' : 'NONE'}</strong><small>浏览器只能引用服务端签发的 opaque candidate ID</small></div>
        <div><span>TRANSPORT</span><strong>STREAM + VERIFY</strong><small>固定 provider、大小上限、ZIP 签名与 SHA-256 由服务端核验</small></div>
        <div><span>DESTINATION</span><strong>MANAGED INBOX</strong><small>原子发布到固定 inbox；响应不返回主机路径</small></div>
        <div><span>NEXT STEP</span><strong>PREPARATION REQUIRED</strong><small>raw acquisition receipt 不能直接生成激活草稿</small></div>
      </div>

      {acquisitionPlan ? <>
        <div className="acquisition-plan-summary">
          <div><span>PROVIDER</span><strong>{acquisitionPlan.candidate.provider.toUpperCase()}</strong><small>{acquisitionPlan.candidate.release.kind} · {acquisitionPlan.candidate.release.version}</small></div>
          <div><span>ARTIFACT</span><strong>{acquisitionPlan.candidate.artifact.fileName}</strong><small>{acquisitionPlan.candidate.artifact.sizeBytes === null ? '服务端流式计算大小' : formatBytes(acquisitionPlan.candidate.artifact.sizeBytes)}</small></div>
          <div><span>INTEGRITY</span><strong>{acquisitionPlan.candidate.artifact.integrity === 'provider-sha256' ? 'PROVIDER + LOCAL' : 'LOCAL REQUIRED'}</strong><small>摘要原文不会展示在获取摘要中</small></div>
          <div><span>EXPIRY</span><strong className={acquisitionCandidateIsExpired ? 'danger' : 'green'}>{acquisitionCandidateIsExpired ? 'EXPIRED' : 'VALID'}</strong><small>{relativeTime(acquisitionPlan.candidate.expiresAt)}</small></div>
        </div>
        <div className="acquisition-operation-strip"><ShieldCheck size={15} /><span><strong>获取 dry-run 已生成</strong><small>{acquisitionPlan.operations.length} 个固定操作；请求只有 candidate ID，不包含 URL、路径、命令、凭据或字节载荷。</small></span></div>
        <div className="update-execution-confirm acquisition-execution-confirm">
          <div><TriangleAlert size={22} /><span><strong>制品获取精确确认</strong><small>输入 <code>{acquisitionConfirmation}</code>。服务端会重新核验候选时效、provider 边界、大小和完整性。</small></span></div>
          <input aria-label="制品获取精确确认" value={acquisitionConfirmationInput}
            disabled={!canStage || demo || acquisitionMeta?.executionEnabled !== true || acquisitionCandidateIsExpired}
            onChange={(event) => setAcquisitionConfirmationInput(event.target.value)}
            placeholder={acquisitionConfirmation} autoComplete="off" />
          <button type="button" className="confirm-execute"
            disabled={acquisitionExecuting || !canStage || demo || acquisitionMeta?.executionEnabled !== true || acquisitionCandidateIsExpired || acquisitionConfirmationInput !== acquisitionConfirmation}
            onClick={() => void executeAcquisition()}>{acquisitionExecuting ? '获取与核验中…' : !canStage ? '需要 Operator' : demo ? '演示环境不获取' : acquisitionMeta?.executionEnabled !== true ? '服务端获取门禁关闭' : acquisitionCandidateIsExpired ? '候选已过期' : '获取到固定 inbox'}</button>
        </div>
      </> : <div className="acquisition-empty"><ScanSearch size={22} /><span><strong>选择已注册且未过期的候选生成获取预演</strong><small>{acquisitionMeta?.configured ? canReadUpdates ? canStage ? '预演保持只读；执行仍受独立 mutation gate 和精确确认约束。' : 'Viewer 可以生成只读预演和读取回执，但不能执行获取。' : '当前角色没有 updates.read。' : '服务端尚未装配固定 acquisition roots，所有获取动作保持锁定。'}</small></span></div>}

      <div className={`acquisition-receipt-summary${acquisitionReceipt ? ' acquired' : ''}`}>
        {acquisitionReceipt ? <>
          <div><span>STATE</span><strong>ACQUIRED</strong><small>{acquisitionReceipt.reused ? '幂等复用既有回执（200）' : '首次获取已创建回执（201）'}</small></div>
          <div><span>RELEASE</span><strong>{acquisitionReceipt.release.version}</strong><small>{acquisitionReceipt.provider} · {acquisitionReceipt.release.kind}</small></div>
          <div><span>MANAGED ARTIFACT</span><strong>{acquisitionReceipt.artifact.fileName}</strong><small>{formatBytes(acquisitionReceipt.artifact.sizeBytes)} · 完整性已核验</small></div>
          <div><span>DURABILITY</span><strong>{acquisitionReceiptVerified ? 'RECEIPT VERIFIED' : 'RESULT ONLY'}</strong><small>{acquisitionReceiptVerified ? '固定 inbox 与持久回执均已确认' : '等待 receipts/:requestId 重新读取'}</small></div>
          <div><span>ACQUIRED</span><strong>{relativeTime(acquisitionReceipt.acquiredAt)}</strong><small>不显示路径、URL 或摘要原文</small></div>
        </> : <div className="acquisition-receipt-empty"><History size={22} /><span><strong>尚无安全获取摘要</strong><small>首次执行与幂等重放都以持久 receipt 为准；页面不枚举服务器文件。</small></span></div>}
      </div>
      <footer className="acquisition-receipt-recovery">
        <label><span>RECEIPT REQUEST ID</span><input aria-label="获取回执 request ID" value={acquisitionReceiptLookupId}
          onChange={(event) => setAcquisitionReceiptLookupId(event.target.value.slice(0, 36))}
          placeholder="00000000-0000-4000-8000-000000000000" autoComplete="off" spellCheck={false} /></label>
        <button type="button" onClick={() => void readAcquisitionReceipt()}
          disabled={demo || acquisitionReadingReceipt || !uuidPattern.test(acquisitionReceiptLookupId.trim())}>
          <RefreshCw className={acquisitionReadingReceipt ? 'spin' : ''} size={13} />{acquisitionReadingReceipt ? '查询中…' : '恢复持久回执'}
        </button>
        <button type="button" onClick={() => void previewPreparation()}
          disabled={!canReadUpdates || preparationPreviewing || !acquisitionReceiptVerified || !acquisitionReceipt || !isPreparationComponent(acquisitionReceipt.release.kind)}>
          <PackageCheck className={preparationPreviewing ? 'spin' : ''} size={13} />{preparationPreviewing ? '准备预演中…' : '生成候选准备预演'}
        </button>
      </footer>
    </section>

    <section className={`update-acquisition-panel${preparationReceipt ? ' has-receipt' : ''}`}>
      <header><div><PackageCheck size={17} /><strong>组件候选准备</strong></div><span>{preparationGateClosed ? 'FAIL-CLOSED' : preparationReceiptVerified ? 'PREPARED + VERIFIED' : preparationPlan?.available === true ? 'DRY-RUN READY' : 'PREPARATION REQUIRED'}</span></header>
      <div className="acquisition-boundary-grid">
        <div><span>SOURCE PROOF</span><strong>DURABLE ACQUISITION</strong><small>只接受重新读取且严格核验的 acquisition receipt UUID</small></div>
        <div><span>NEBULA MODE</span><strong>NORMALIZED</strong><small>重建确定性 server-managed archive 与新 artifact identity</small></div>
        <div><span>BEPINEX MODE</span><strong>DIRECT VERIFIED</strong><small>官方 Windows x64 archive 经 reviewed layout 后直接暂存</small></div>
        <div><span>ACTIVATION BINDING</span><strong>PREPARED RECEIPT ONLY</strong><small>浏览器不能从 raw acquisition receipt 推导激活请求</small></div>
      </div>

      {preparationPlan?.available === true ? <>
        <div className="acquisition-plan-summary">
          <div><span>COMPONENT</span><strong>{componentLabel(preparationPlan.component)}</strong><small>{preparationPlan.source.version}</small></div>
          <div><span>PREPARED MODE</span><strong>{preparationPlan.prepared.mode === 'normalized-nebula-windows' ? 'NORMALIZED' : 'DIRECT'}</strong><small>{preparationPlan.prepared.layoutPolicy}</small></div>
          <div><span>PREPARED ID</span><strong>{shortHash(preparationPlan.prepared.artifactId, 24)}</strong><small>服务端固定逻辑 identity</small></div>
          <div><span>NEXT STEP</span><strong>ACTIVATION PREVIEW</strong><small>仍需持久 receipt reread 与兼容性回执</small></div>
        </div>
        <div className="acquisition-operation-strip"><ShieldCheck size={15} /><span><strong>准备 dry-run 已生成</strong><small>{preparationPlan.operations.length} 个固定操作；没有 path、URL、命令、凭据或 archive 字节进入请求。</small></span></div>
        <div className="update-execution-confirm acquisition-execution-confirm">
          <div><TriangleAlert size={22} /><span><strong>候选准备精确确认</strong><small>输入 <code>{preparationConfirmation}</code>。服务端会重新读取 acquisition receipt、重哈希、校验布局并原子暂存。</small></span></div>
          <input aria-label="候选准备精确确认" value={preparationConfirmationInput}
            disabled={!canStage || demo || preparationGateClosed || preparationExecuting}
            onChange={(event) => setPreparationConfirmationInput(event.target.value)}
            placeholder={preparationConfirmation} autoComplete="off" />
          <button type="button" className="confirm-execute"
            disabled={!canStage || demo || preparationGateClosed || preparationExecuting || preparationConfirmationInput !== preparationConfirmation}
            onClick={() => void executePreparation()}>{preparationExecuting ? '核验与准备中…' : !canStage ? '需要 Operator' : demo ? '演示环境不准备' : preparationGateClosed ? '服务端准备门禁关闭' : '准备并固定暂存'}</button>
        </div>
      </> : <div className="acquisition-empty"><ScanSearch size={22} /><span><strong>先从已核验 acquisition receipt 生成组件准备 dry-run</strong><small>raw 获取只证明下载与 inbox 完整性；它不证明 Nebula 归一化布局或 BepInEx reviewed Windows x64 布局。</small></span></div>}

      <div className={`acquisition-receipt-summary${preparationReceipt ? ' acquired' : ''}`}>
        {preparationReceipt ? <>
          <div><span>STATE</span><strong>STAGED</strong><small>{preparationReceipt.reused ? '幂等复用既有准备回执（200）' : '首次准备已创建回执（201）'}</small></div>
          <div><span>COMPONENT</span><strong>{componentLabel(preparationReceipt.component)}</strong><small>{preparationReceipt.source.version}</small></div>
          <div><span>MODE</span><strong>{preparationReceipt.prepared.mode === 'normalized-nebula-windows' ? 'NORMALIZED' : 'DIRECT'}</strong><small>{preparationReceipt.prepared.layoutPolicy}</small></div>
          <div><span>DURABILITY</span><strong>{preparationReceiptVerified ? 'PREPARED RECEIPT VERIFIED' : 'RESULT ONLY'}</strong><small>{preparationReceiptVerified ? 'prepared identity、摘要与 staging manifest 已交叉核验' : '等待 receipts/:requestId 重新读取'}</small></div>
          <div><span>PREPARED</span><strong>{relativeTime(preparationReceipt.preparedAt)}</strong><small>{formatBytes(preparationReceipt.prepared.sizeBytes)} · 不显示摘要原文</small></div>
        </> : <div className="acquisition-receipt-empty"><History size={22} /><span><strong>尚无 verified prepared receipt</strong><small>没有这份持久回执，激活草稿、兼容性准备和 activation preview 全部保持锁定。</small></span></div>}
      </div>
      <footer className="acquisition-receipt-recovery">
        <label><span>PREPARATION RECEIPT ID</span><input aria-label="准备回执 request ID" value={preparationReceiptLookupId}
          onChange={(event) => setPreparationReceiptLookupId(event.target.value.slice(0, 36))}
          placeholder="00000000-0000-4000-8000-000000000000" autoComplete="off" spellCheck={false} /></label>
        <button type="button" onClick={() => void readPreparationReceipt()}
          disabled={!canReadUpdates || demo || preparationReadingReceipt || !uuidPattern.test(preparationReceiptLookupId.trim())}>
          <RefreshCw className={preparationReadingReceipt ? 'spin' : ''} size={13} />{preparationReadingReceipt ? '核对中…' : '恢复准备回执'}
        </button>
        <button type="button" onClick={loadPreparedCandidateForActivation}
          disabled={!preparationReceiptVerified || !preparationReceipt || !activationState}>
          <PackageCheck size={13} />装入 {preparationReceipt ? componentLabel(preparationReceipt.component) : 'prepared'} 激活请求
        </button>
      </footer>
    </section>
  </div>
}

async function steamHandoffRequest<T>(
  path: string,
  parser: (value: unknown) => T | null,
  init: RequestInit = {}
): Promise<{ data: T }> {
  const headers = new Headers(init.headers)
  if (init.body !== undefined && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json')
  let response: Response
  try {
    response = await fetch(path, { credentials: 'same-origin', ...init, headers })
  } catch (error) {
    if (init.signal?.aborted === true) throw error
    throw new ApiError(503, 'Steam 人工交接接口暂不可用；所有停服与启动操作保持锁定。', 'DSP_STEAM_HANDOFF_BROWSER_UNAVAILABLE')
  }
  const value = await response.json().catch(() => null) as unknown
  if (!response.ok) {
    const code = safeSteamHandoffErrorCode(value)
    throw new ApiError(response.status, steamHandoffErrorMessage(response.status, code), code)
  }
  if (!hasExactObjectKeys(value, ['ok', 'data']) || value.ok !== true) {
    throw new ApiError(502, 'Steam 人工交接响应 envelope 无效；所有操作保持锁定。', 'DSP_STEAM_HANDOFF_BROWSER_RESPONSE_INVALID')
  }
  const data = parser(value.data)
  if (data === null) {
    throw new ApiError(502, 'Steam 人工交接响应未通过严格浏览器合同校验。', 'DSP_STEAM_HANDOFF_BROWSER_RESPONSE_INVALID')
  }
  return { data }
}

function parseSteamHandoffPlan(value: unknown): SteamManualHandoffPlan | null {
  if (!hasExactObjectKeys(value, [
    'format', 'schemaVersion', 'dryRun', 'requestId', 'targetVersion', 'expectedRevision',
    'timeoutSeconds', 'accountAutomation', 'operations'
  ]) || value.format !== 'dyson-control-steam-manual-handoff-plan' || value.schemaVersion !== 1 ||
      value.dryRun !== true || value.accountAutomation !== false ||
      !validSteamHandoffRequestFields(value) || !Number.isSafeInteger(value.timeoutSeconds) ||
      (value.timeoutSeconds as number) < 1 || !Array.isArray(value.operations) ||
      value.operations.length !== steamHandoffOperations.length ||
      value.operations.some((operation, index) => operation !== steamHandoffOperations[index])) return null
  return value as unknown as SteamManualHandoffPlan
}

function parseSteamHandoffReceipt(value: unknown): SteamManualHandoffReceipt | null {
  if (!hasExactObjectKeys(value, [
    'format', 'schemaVersion', 'requestId', 'targetVersion', 'phase', 'previousRevision',
    'resultingRevision', 'transactionBindingSha256', 'protectionBackupId',
    'protectionManifestSha256', 'previousDspVersion', 'compatibilityRevision', 'startedAt',
    'expiresAt', 'completedAt', 'failureCode', 'recoveryRequired', 'steps', 'auditEvents', 'reused'
  ]) || value.format !== 'dyson-control-steam-manual-handoff-receipt' || value.schemaVersion !== 1 ||
      typeof value.requestId !== 'string' || value.requestId !== value.requestId.toLowerCase() ||
      !uuidPattern.test(value.requestId) || typeof value.targetVersion !== 'string' ||
      !versionPattern.test(value.targetVersion) || !isSteamHandoffPhase(value.phase) ||
      typeof value.previousRevision !== 'string' || !sha256Pattern.test(value.previousRevision) ||
      typeof value.resultingRevision !== 'string' || !sha256Pattern.test(value.resultingRevision) ||
      !nullableSha256(value.transactionBindingSha256) || !nullableBoundedString(value.protectionBackupId) ||
      !nullableSha256(value.protectionManifestSha256) || !nullableVersion(value.previousDspVersion) ||
      !nullableSha256(value.compatibilityRevision) || !validIsoTimestamp(value.startedAt) ||
      !validIsoTimestamp(value.expiresAt) || !nullableIsoTimestamp(value.completedAt) ||
      !nullableSteamFailureCode(value.failureCode) || typeof value.recoveryRequired !== 'boolean' ||
      !validSteamHandoffSteps(value.steps) || !Array.isArray(value.auditEvents) ||
      value.auditEvents.length > 32 || value.auditEvents.some((event) => typeof event !== 'string' || event.length > 96) ||
      typeof value.reused !== 'boolean') return null
  if ((value.phase === 'succeeded' && (value.recoveryRequired || value.failureCode !== null || value.completedAt === null)) ||
      (value.phase === 'recovery-required' && (!value.recoveryRequired || value.failureCode === null))) return null
  return value as unknown as SteamManualHandoffReceipt
}

function parseSteamHandoffState(value: unknown): SteamManualHandoffState | null {
  if (!hasExactObjectKeys(value, [
    'format', 'schemaVersion', 'revision', 'recoveryRequired', 'activeRequestId',
    'lastCompletedTargetVersion', 'current'
  ]) || value.format !== 'dyson-control-steam-manual-handoff-state' || value.schemaVersion !== 1 ||
      typeof value.revision !== 'string' || !sha256Pattern.test(value.revision) ||
      typeof value.recoveryRequired !== 'boolean' || !nullableUuid(value.activeRequestId) ||
      !nullableVersion(value.lastCompletedTargetVersion)) return null
  const current = value.current === null ? null : parseSteamHandoffReceipt(value.current)
  if (value.current !== null && current === null) return null
  if ((value.activeRequestId === null) !== (current === null) ||
      (current !== null && current.requestId !== value.activeRequestId) ||
      (value.recoveryRequired && current?.phase !== 'recovery-required')) return null
  return { ...(value as unknown as Omit<SteamManualHandoffState, 'current'>), current }
}

function validSteamHandoffRequestFields(value: Record<string, unknown>): boolean {
  return typeof value.requestId === 'string' && value.requestId === value.requestId.toLowerCase() &&
    uuidPattern.test(value.requestId) && typeof value.targetVersion === 'string' &&
    versionPattern.test(value.targetVersion) && typeof value.expectedRevision === 'string' &&
    sha256Pattern.test(value.expectedRevision)
}

function validSteamHandoffSteps(value: unknown): boolean {
  if (!hasExactObjectKeys(value, [
    'protectionPoint', 'gracefulStop', 'stoppedProof', 'operatorConfirmation',
    'versionResample', 'compatibilityResample', 'exactSaveLoad'
  ])) return false
  const triState = new Set(['pending', 'verified', 'failed'])
  return triState.has(String(value.protectionPoint)) && triState.has(String(value.gracefulStop)) &&
    triState.has(String(value.stoppedProof)) &&
    (value.operatorConfirmation === 'pending' || value.operatorConfirmation === 'verified') &&
    triState.has(String(value.versionResample)) && triState.has(String(value.compatibilityResample)) &&
    triState.has(String(value.exactSaveLoad))
}

function validateSteamHandoffDraft(
  request: SteamManualHandoffRequest,
  state: SteamManualHandoffState | null
): string | null {
  if (state === null) return 'Steam 人工交接状态不可用。'
  if (state.recoveryRequired) return 'Steam 人工交接需要恢复。'
  if (state.activeRequestId !== null) return '已有 Steam 人工交接等待完成。'
  if (!uuidPattern.test(request.requestId) || request.requestId !== request.requestId.toLowerCase()) return 'request ID 无效。'
  if (!versionPattern.test(request.targetVersion)) return '目标 DSP 版本无效。'
  if (!sha256Pattern.test(request.expectedRevision) || request.expectedRevision !== state.revision) return '交接 revision 已过期。'
  return null
}

function steamHandoffReadbackMatches(
  accepted: SteamManualHandoffReceipt,
  persisted: SteamManualHandoffReceipt,
  state: SteamManualHandoffState,
  expectedPhase: 'awaiting-steam-client-update' | 'succeeded'
): boolean {
  if (!sameSteamHandoffReceipt(accepted, persisted) || persisted.phase !== expectedPhase ||
      state.recoveryRequired || persisted.recoveryRequired) return false
  if (expectedPhase === 'awaiting-steam-client-update') {
    return state.activeRequestId === persisted.requestId && state.current !== null &&
      sameSteamHandoffReceipt(state.current, persisted)
  }
  return state.activeRequestId === null && state.current === null &&
    state.lastCompletedTargetVersion === persisted.targetVersion &&
    state.revision === persisted.resultingRevision
}

function sameSteamHandoffReceipt(
  left: SteamManualHandoffReceipt,
  right: SteamManualHandoffReceipt
): boolean {
  return left.requestId === right.requestId && left.targetVersion === right.targetVersion &&
    left.phase === right.phase && left.previousRevision === right.previousRevision &&
    left.resultingRevision === right.resultingRevision &&
    left.transactionBindingSha256 === right.transactionBindingSha256 &&
    left.protectionManifestSha256 === right.protectionManifestSha256 &&
    left.failureCode === right.failureCode && left.recoveryRequired === right.recoveryRequired &&
    JSON.stringify(left.steps) === JSON.stringify(right.steps)
}

function fictionalSteamHandoffPlan(request: SteamManualHandoffRequest): SteamManualHandoffPlan {
  return {
    format: 'dyson-control-steam-manual-handoff-plan', schemaVersion: 1, dryRun: true,
    ...request, timeoutSeconds: 1_800, accountAutomation: false,
    operations: [...steamHandoffOperations]
  }
}

function steamHandoffOperationLabel(operation: string): string {
  return ({
    'capture-runtime-and-save-baseline': '采集运行时、兼容性与旧存档身份基线',
    'create-paired-save-protection-point': '创建配对存档保护点并绑定 manifest',
    'request-graceful-stop': '请求优雅停服',
    'prove-process-stopped-and-port-closed': '证明进程停止且端口关闭',
    'await-official-steam-client-update': '等待官方 Steam 客户端人工更新',
    'require-fixed-operator-confirmation': '要求操作员固定确认',
    'resample-exact-dsp-version-and-compatibility': '重采 exact DSP 版本与兼容性',
    'start-and-prove-current-generation-exact-save-load': '启动并证明当前代际 exact previous save',
    'persist-audit-receipt': '持久化审计回执'
  } as Record<string, string>)[operation] ?? operation
}

function steamHandoffPhaseLabel(phase: SteamManualHandoffPhase): string {
  return ({
    preparing: 'PREPARING',
    'awaiting-steam-client-update': 'AWAITING STEAM CLIENT',
    'validating-client-update': 'VALIDATING CLIENT UPDATE',
    'starting-and-verifying': 'STARTING + VERIFYING',
    succeeded: 'SUCCEEDED',
    'recovery-required': 'RECOVERY REQUIRED'
  } satisfies Record<SteamManualHandoffPhase, string>)[phase]
}

function isSteamHandoffPhase(value: unknown): value is SteamManualHandoffPhase {
  return value === 'preparing' || value === 'awaiting-steam-client-update' ||
    value === 'validating-client-update' || value === 'starting-and-verifying' ||
    value === 'succeeded' || value === 'recovery-required'
}

function nullableSha256(value: unknown): boolean {
  return value === null || (typeof value === 'string' && sha256Pattern.test(value))
}

function nullableUuid(value: unknown): value is string | null {
  return value === null || (typeof value === 'string' && value === value.toLowerCase() && uuidPattern.test(value))
}

function nullableVersion(value: unknown): value is string | null {
  return value === null || (typeof value === 'string' && versionPattern.test(value))
}

function nullableBoundedString(value: unknown): boolean {
  return value === null || (typeof value === 'string' && value.length >= 1 && value.length <= 128)
}

function validIsoTimestamp(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 40 && Number.isFinite(Date.parse(value))
}

function nullableIsoTimestamp(value: unknown): boolean {
  return value === null || validIsoTimestamp(value)
}

function nullableSteamFailureCode(value: unknown): boolean {
  return value === null || (typeof value === 'string' && /^DSP_STEAM_HANDOFF_[A-Z0-9_]{1,72}$/.test(value))
}

function safeSteamHandoffErrorCode(value: unknown): string | null {
  if (!hasExactObjectKeys(value, ['ok', 'error']) || value.ok !== false ||
      !hasExactObjectKeys(value.error, ['code']) || typeof value.error.code !== 'string' ||
      !/^(?:DSP_STEAM_HANDOFF|WINDOWS_STEAM_HANDOFF)_[A-Z0-9_]{1,96}$/.test(value.error.code)) return null
  return value.error.code
}

function steamHandoffErrorMessage(status: number, code: string | null): string {
  if (code === 'DSP_STEAM_HANDOFF_VERSION_MISMATCH') return '官方 Steam 客户端尚未达到 exact 目标版本；事务仍等待，可完成更新后重试。'
  if (code === 'DSP_STEAM_HANDOFF_COMPATIBILITY_CONFLICT') return '更新后运行时与可信兼容性证据不匹配；事务仍等待。'
  if (code?.includes('EXACT_SAVE_LOAD_UNPROVEN')) return '启动后的 Bridge heartbeat/加载日志未在当前代际证明 exact previous save；需要恢复。'
  if (status === 423) return 'Steam 人工交接 mutation gate 默认关闭；当前只允许读取与预演。'
  if (status === 409) return 'Steam 人工交接阶段、revision 或固定确认不一致；请重新读取持久状态。'
  if (status === 503) return 'Steam 人工交接安全状态暂不可证明；所有新操作保持锁定。'
  if (status === 404) return 'Steam 人工交接回执不存在或服务尚未接线。'
  return 'Steam 人工交接请求未完成。'
}

function formatSteamHandoffError(reason: unknown, fallback: string): string {
  if (!(reason instanceof ApiError)) return fallback
  return `${reason.message}${reason.code ? ` · ${reason.code}` : ''}`
}

const fictionalSteamHandoffState: SteamManualHandoffState = {
  format: 'dyson-control-steam-manual-handoff-state',
  schemaVersion: 1,
  revision: '9'.repeat(64),
  recoveryRequired: false,
  activeRequestId: null,
  lastCompletedTargetVersion: null,
  current: null
}

function normalizeComponentDiscoveryPage(
  input: unknown,
  component: SupportedComponentCandidatePreparationComponent
): { items: ComponentDiscoveryRelease[]; pagesFetched: number; truncated: boolean } | null {
  if (!hasExactObjectKeys(input, ['items', 'pagesFetched', 'truncated']) ||
      !Array.isArray(input.items) || input.items.length > 500 ||
      typeof input.pagesFetched !== 'number' || !Number.isInteger(input.pagesFetched) ||
      input.pagesFetched < 1 || input.pagesFetched > 5 || typeof input.truncated !== 'boolean') return null
  const items: ComponentDiscoveryRelease[] = []
  for (const item of input.items) {
    const normalized = normalizeComponentDiscoveryRelease(item, component)
    if (!normalized) return null
    items.push(normalized)
  }
  const artifactIds = new Set(items.map((item) => item.artifact.artifactId))
  if (artifactIds.size !== items.length) return null
  return { items, pagesFetched: input.pagesFetched, truncated: input.truncated }
}

function normalizeComponentDiscoveryRelease(
  input: unknown,
  component: SupportedComponentCandidatePreparationComponent
): ComponentDiscoveryRelease | null {
  const expectedKeys = component === 'nebula'
    ? ['provider', 'sourceId', 'releaseId', 'version', 'publishedAt', 'prerelease', 'artifact']
    : ['provider', 'sourceId', 'releaseId', 'version', 'publishedAt', 'layoutPolicy', 'artifact']
  if (!hasExactObjectKeys(input, expectedKeys) || input.provider !== 'github' ||
      typeof input.releaseId !== 'number' || !Number.isSafeInteger(input.releaseId) || input.releaseId <= 0 ||
      typeof input.version !== 'string' || !versionPattern.test(input.version) || input.version.length > 64 ||
      typeof input.publishedAt !== 'string' || !Number.isFinite(Date.parse(input.publishedAt))) return null
  const artifact = normalizeDiscoveredArtifact(input.artifact)
  if (!artifact) return null
  if (component === 'nebula') {
    if (input.sourceId !== 'github:NebulaModTeam/nebula' || typeof input.prerelease !== 'boolean') return null
    if (!officialGithubAssetUrl(artifact.downloadUrl, '/NebulaModTeam/nebula/releases/download/')) return null
    return { ...input, artifact } as unknown as ComponentDiscoveryRelease
  }
  if (input.sourceId !== 'github:BepInEx/BepInEx' ||
      !supportedBepInExVersions.has(input.version) ||
      !bepInExLayoutPolicies.has(String(input.layoutPolicy)) ||
      expectedBepInExPolicy(input.version) !== input.layoutPolicy ||
      !officialGithubAssetUrl(artifact.downloadUrl, `/BepInEx/BepInEx/releases/download/v${input.version}/`)) return null
  return { ...input, artifact } as unknown as ComponentDiscoveryRelease
}

function normalizeDiscoveredArtifact(input: unknown): ComponentDiscoveryRelease['artifact'] | null {
  if (!hasExactObjectKeys(input, [
    'artifactId', 'downloadUrl', 'fileName', 'sizeBytes', 'sha256', 'integrity'
  ]) || typeof input.artifactId !== 'string' || !artifactIdPattern.test(input.artifactId) ||
      typeof input.downloadUrl !== 'string' || input.downloadUrl.length > 2_048 ||
      typeof input.fileName !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]*\.zip$/i.test(input.fileName) ||
      input.fileName.length > 128 ||
      !(input.sizeBytes === null || validPositiveByteCount(input.sizeBytes)) ||
      !(input.sha256 === null || (typeof input.sha256 === 'string' && sha256Pattern.test(input.sha256))) ||
      !['provider-sha256', 'locally-computed-required'].includes(String(input.integrity))) return null
  if (input.integrity === 'provider-sha256' && (input.sizeBytes === null || input.sha256 === null)) return null
  return input as unknown as ComponentDiscoveryRelease['artifact']
}

function officialGithubAssetUrl(value: string, requiredPathPrefix: string): boolean {
  try {
    const url = new URL(value)
    return url.protocol === 'https:' && url.hostname === 'github.com' && url.username === '' &&
      url.password === '' && url.search === '' && url.hash === '' && url.pathname.startsWith(requiredPathPrefix)
  } catch {
    return false
  }
}

function normalizeAcquisitionDiscoveryMeta(input: unknown): ArtifactAcquisitionDiscoveryMeta | null {
  if (!hasExactObjectKeys(input, ['configured', 'executionEnabled', 'candidates']) ||
      typeof input.configured !== 'boolean' || typeof input.executionEnabled !== 'boolean' ||
      !Array.isArray(input.candidates) || input.candidates.length > 100) return null
  if (!input.configured && input.executionEnabled) return null
  const candidates: ArtifactAcquisitionRegistration[] = []
  for (const entry of input.candidates) {
    if (!hasExactObjectKeys(entry, ['artifactId', 'eligible', 'status', 'candidate']) ||
        typeof entry.artifactId !== 'string' || !artifactIdPattern.test(entry.artifactId) ||
        typeof entry.eligible !== 'boolean' || !isAcquisitionRegistrationStatus(entry.status)) return null
    const status = entry.status
    const candidate = entry.candidate === null ? null : normalizeAcquisitionCandidate(entry.candidate)
    if (entry.candidate !== null && !candidate) return null
    if (status === 'registered' && (!entry.eligible || !candidate)) return null
    if (status !== 'registered' && candidate !== null) return null
    if (status === 'release-ineligible' && entry.eligible) return null
    candidates.push({ artifactId: entry.artifactId, eligible: entry.eligible, status, candidate })
  }
  return { configured: input.configured, executionEnabled: input.executionEnabled, candidates }
}

function normalizeAcquisitionCandidate(input: unknown): ArtifactAcquisitionCandidate | null {
  if (!hasExactObjectKeys(input, ['candidateId', 'provider', 'release', 'artifact', 'expiresAt']) ||
      typeof input.candidateId !== 'string' || !/^candidate-[0-9a-f]{48}$/.test(input.candidateId) ||
      (input.provider !== 'github' && input.provider !== 'thunderstore') ||
      !hasExactObjectKeys(input.release, ['kind', 'sourceId', 'version']) ||
      !['nebula', 'bepinex', 'plugin'].includes(String(input.release.kind)) ||
      typeof input.release.sourceId !== 'string' ||
      !/^(?:github|thunderstore):[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(input.release.sourceId) ||
      typeof input.release.version !== 'string' || !versionPattern.test(input.release.version) ||
      input.release.version.length > 64 ||
      !hasExactObjectKeys(input.artifact, ['artifactId', 'fileName', 'sizeBytes', 'sha256', 'integrity']) ||
      typeof input.artifact.artifactId !== 'string' || !artifactIdPattern.test(input.artifact.artifactId) ||
      typeof input.artifact.fileName !== 'string' || input.artifact.fileName.length > 128 ||
      !/^[A-Za-z0-9][A-Za-z0-9._-]*\.zip$/i.test(input.artifact.fileName) ||
      !(input.artifact.sizeBytes === null || (typeof input.artifact.sizeBytes === 'number' &&
        Number.isSafeInteger(input.artifact.sizeBytes) &&
        input.artifact.sizeBytes > 0 && input.artifact.sizeBytes <= 2 * 1_024 * 1_024 * 1_024)) ||
      !(input.artifact.sha256 === null || (typeof input.artifact.sha256 === 'string' &&
        sha256Pattern.test(input.artifact.sha256))) ||
      !['provider-sha256', 'locally-computed-required'].includes(String(input.artifact.integrity)) ||
      typeof input.expiresAt !== 'string' || !Number.isFinite(Date.parse(input.expiresAt))) return null
  if (input.artifact.integrity === 'provider-sha256' &&
      (input.artifact.sizeBytes === null || input.artifact.sha256 === null)) return null
  return input as unknown as ArtifactAcquisitionCandidate
}

function acquisitionRegistrationForRelease(
  meta: ArtifactAcquisitionDiscoveryMeta | null,
  release: ComponentDiscoveryRelease
): ArtifactAcquisitionRegistration | null {
  const matches = meta?.candidates.filter((entry) => entry.artifactId === release.artifact.artifactId) ?? []
  return matches.length === 1 ? matches[0]! : null
}

function validAcquisitionCandidate(
  release: ComponentDiscoveryRelease,
  registration: ArtifactAcquisitionRegistration | null
): ArtifactAcquisitionCandidate | null {
  const candidate = registration?.candidate
  if (!registration || registration.status !== 'registered' || registration.eligible !== true || !candidate) return null
  if (candidate.provider !== 'github' || candidate.release.kind !== componentFromRelease(release) ||
      candidate.release.sourceId !== release.sourceId || candidate.release.version !== release.version ||
      candidate.artifact.artifactId !== release.artifact.artifactId ||
      candidate.artifact.fileName !== release.artifact.fileName ||
      candidate.artifact.sizeBytes !== release.artifact.sizeBytes ||
      candidate.artifact.sha256 !== release.artifact.sha256 ||
      candidate.artifact.integrity !== release.artifact.integrity) return null
  return candidate
}

function candidateExpired(candidate: ArtifactAcquisitionCandidate): boolean {
  const expiresAt = Date.parse(candidate.expiresAt)
  return !Number.isFinite(expiresAt) || expiresAt <= Date.now()
}

function acquisitionRegistrationPresentation(
  meta: ArtifactAcquisitionDiscoveryMeta | null,
  registration: ArtifactAcquisitionRegistration | null,
  candidate: ArtifactAcquisitionCandidate | null,
  expired: boolean
): { label: string; action: string; tone: 'verified' | 'pending' } {
  if (!meta) return { label: '未返回获取合同', action: '不可获取', tone: 'pending' }
  if (!meta.configured || registration?.status === 'not-configured') {
    return { label: '获取未配置', action: '未配置', tone: 'pending' }
  }
  if (registration?.status === 'release-ineligible') {
    return { label: '候选不合格', action: '不合格', tone: 'pending' }
  }
  if (registration?.status === 'registration-failed' || !candidate) {
    return { label: '注册校验失败', action: '不可获取', tone: 'pending' }
  }
  if (expired) return { label: '候选已过期', action: '已过期', tone: 'pending' }
  return { label: '服务端已绑定', action: '获取预演', tone: 'verified' }
}

function acquisitionPlanMatchesCandidate(
  plan: ArtifactAcquisitionPlan,
  candidate: ArtifactAcquisitionCandidate
): boolean {
  const normalizedCandidate = normalizeAcquisitionCandidate(plan.candidate)
  return hasExactObjectKeys(plan, ['format', 'schemaVersion', 'dryRun', 'candidate', 'operations', 'staging']) &&
    plan.format === 'dyson-control-artifact-acquisition-plan' && plan.schemaVersion === 1 &&
    plan.dryRun === true && normalizedCandidate !== null && Array.isArray(plan.operations) &&
    plan.operations.length > 0 && plan.operations.length <= acquisitionOperations.size &&
    plan.operations.every((operation) => acquisitionOperations.has(operation)) &&
    hasExactObjectKeys(plan.staging, ['automatic', 'nextAction']) && plan.staging.automatic === false &&
    plan.staging.nextAction === 'offline-artifact-staging' &&
    normalizedCandidate.candidateId === candidate.candidateId &&
    normalizedCandidate.provider === candidate.provider &&
    normalizedCandidate.expiresAt === candidate.expiresAt &&
    normalizedCandidate.artifact.artifactId === candidate.artifact.artifactId &&
    normalizedCandidate.artifact.fileName === candidate.artifact.fileName &&
    normalizedCandidate.artifact.sizeBytes === candidate.artifact.sizeBytes &&
    normalizedCandidate.artifact.sha256 === candidate.artifact.sha256 &&
    normalizedCandidate.artifact.integrity === candidate.artifact.integrity &&
    normalizedCandidate.release.kind === candidate.release.kind &&
    normalizedCandidate.release.sourceId === candidate.release.sourceId &&
    normalizedCandidate.release.version === candidate.release.version
}

function acquisitionReceiptMatches(
  receipt: ArtifactAcquisitionReceipt,
  requestId: string,
  candidate?: ArtifactAcquisitionCandidate
): boolean {
  return hasExactObjectKeys(receipt, [
    'format', 'schemaVersion', 'requestId', 'candidateId', 'provider', 'release', 'artifact',
    'state', 'reused', 'acquiredAt'
  ]) && receipt.format === 'dyson-control-artifact-acquisition-receipt' && receipt.schemaVersion === 1 &&
    receipt.state === 'acquired' && receipt.requestId.toLowerCase() === requestId.toLowerCase() &&
    uuidPattern.test(receipt.requestId) && /^candidate-[0-9a-f]{48}$/.test(receipt.candidateId) &&
    (receipt.provider === 'github' || receipt.provider === 'thunderstore') &&
    hasExactObjectKeys(receipt.release, ['kind', 'sourceId', 'version']) &&
    ['nebula', 'bepinex', 'plugin'].includes(receipt.release.kind) &&
    /^(?:github|thunderstore):[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(receipt.release.sourceId) &&
    versionPattern.test(receipt.release.version) && validAcquisitionReleaseIdentity(receipt.release) &&
    hasExactObjectKeys(receipt.artifact, ['artifactId', 'fileName', 'sizeBytes', 'sha256', 'integrity']) &&
    artifactIdPattern.test(receipt.artifact.artifactId) &&
    /^[A-Za-z0-9][A-Za-z0-9._-]*\.zip$/i.test(receipt.artifact.fileName) &&
    sha256Pattern.test(receipt.artifact.sha256) && Number.isSafeInteger(receipt.artifact.sizeBytes) &&
    receipt.artifact.sizeBytes > 0 && receipt.artifact.sizeBytes <= 2 * 1_024 * 1_024 * 1_024 &&
    ['provider-verified', 'locally-computed'].includes(receipt.artifact.integrity) &&
    typeof receipt.reused === 'boolean' && Number.isFinite(Date.parse(receipt.acquiredAt)) &&
    (!candidate || (receipt.candidateId === candidate.candidateId &&
      receipt.provider === candidate.provider && receipt.release.kind === candidate.release.kind &&
      receipt.release.sourceId === candidate.release.sourceId &&
      receipt.release.version === candidate.release.version &&
      receipt.artifact.artifactId === candidate.artifact.artifactId))
}

function preparationPlanMatchesAcquisition(
  plan: ComponentCandidatePreparationPlan,
  acquired: ArtifactAcquisitionReceipt
): plan is AvailableComponentCandidatePreparationPlan {
  if (!hasExactObjectKeys(plan, [
    'format', 'schemaVersion', 'available', 'dryRun', 'component', 'acquisitionReceiptId',
    'source', 'prepared', 'operations', 'activation'
  ]) || plan.format !== 'dyson-control-component-preparation-plan' || plan.schemaVersion !== 1 ||
      plan.available !== true || plan.dryRun !== true || !isPreparationComponent(plan.component) ||
      plan.acquisitionReceiptId !== acquired.requestId || plan.component !== acquired.release.kind ||
      !validPreparationSource(plan.source, plan.component) ||
      plan.source.sourceId !== acquired.release.sourceId || plan.source.version !== acquired.release.version ||
      plan.source.artifactId !== acquired.artifact.artifactId ||
      plan.source.sizeBytes !== acquired.artifact.sizeBytes ||
      plan.source.sha256 !== acquired.artifact.sha256 ||
      plan.source.integrity !== acquired.artifact.integrity ||
      !validPreparationIdentity(plan.component, plan.source, plan.prepared) ||
      !Array.isArray(plan.operations) || plan.operations.length < 1 ||
      plan.operations.length > preparationOperations.size ||
      !plan.operations.every((operation) => preparationOperations.has(operation)) ||
      !hasExactObjectKeys(plan.activation, ['automatic', 'nextAction']) ||
      plan.activation.automatic !== false ||
      plan.activation.nextAction !== 'component-update-activation-preview') return false
  return true
}

function preparationReceiptMatches(
  receipt: ComponentCandidatePreparationReceipt,
  requestId: string,
  plan?: AvailableComponentCandidatePreparationPlan,
  acquired?: ArtifactAcquisitionReceipt
): boolean {
  if (!hasExactObjectKeys(receipt, [
    'format', 'schemaVersion', 'requestId', 'component', 'acquisitionReceiptId', 'source',
    'prepared', 'staging', 'state', 'reused', 'preparedAt'
  ]) || receipt.format !== 'dyson-control-component-preparation-receipt' ||
      receipt.schemaVersion !== 1 || receipt.requestId.toLowerCase() !== requestId.toLowerCase() ||
      !uuidPattern.test(receipt.requestId) || !uuidPattern.test(receipt.acquisitionReceiptId) ||
      !isPreparationComponent(receipt.component) || receipt.state !== 'staged' ||
      typeof receipt.reused !== 'boolean' || !Number.isFinite(Date.parse(receipt.preparedAt)) ||
      !validPreparationSource(receipt.source, receipt.component) ||
      !validPreparedReceiptIdentity(receipt) || !validStagedManifest(receipt)) return false
  if (plan && (receipt.component !== plan.component ||
      receipt.acquisitionReceiptId !== plan.acquisitionReceiptId ||
      !samePreparationSource(receipt.source, plan.source) ||
      receipt.prepared.mode !== plan.prepared.mode ||
      receipt.prepared.artifactId !== plan.prepared.artifactId ||
      receipt.prepared.layoutPolicy !== plan.prepared.layoutPolicy)) return false
  if (acquired && (receipt.acquisitionReceiptId !== acquired.requestId ||
      receipt.component !== acquired.release.kind ||
      receipt.source.sourceId !== acquired.release.sourceId ||
      receipt.source.version !== acquired.release.version ||
      receipt.source.artifactId !== acquired.artifact.artifactId ||
      receipt.source.sizeBytes !== acquired.artifact.sizeBytes ||
      receipt.source.sha256 !== acquired.artifact.sha256 ||
      receipt.source.integrity !== acquired.artifact.integrity)) return false
  return true
}

function validPreparationSource(
  source: unknown,
  component: SupportedComponentCandidatePreparationComponent
): source is AvailableComponentCandidatePreparationPlan['source'] {
  return hasExactObjectKeys(source, [
    'provider', 'sourceId', 'version', 'artifactId', 'sizeBytes', 'sha256', 'integrity'
  ]) && source.provider === 'github' && source.sourceId === expectedComponentSource(component) &&
    typeof source.version === 'string' && versionPattern.test(source.version) && source.version.length <= 64 &&
    typeof source.artifactId === 'string' && artifactIdPattern.test(source.artifactId) &&
    validPositiveByteCount(source.sizeBytes) && typeof source.sha256 === 'string' &&
    sha256Pattern.test(source.sha256) &&
    (source.integrity === 'provider-verified' || source.integrity === 'locally-computed')
}

function validPreparationIdentity(
  component: SupportedComponentCandidatePreparationComponent,
  source: AvailableComponentCandidatePreparationPlan['source'],
  prepared: unknown
): prepared is AvailableComponentCandidatePreparationPlan['prepared'] {
  if (!hasExactObjectKeys(prepared, ['mode', 'artifactId', 'layoutPolicy']) ||
      typeof prepared.artifactId !== 'string' || !artifactIdPattern.test(prepared.artifactId)) return false
  if (component === 'nebula') {
    return source.version === '0.9.22' && prepared.mode === 'normalized-nebula-windows' &&
      prepared.layoutPolicy === 'nebula-official-windows-v0.9.22' &&
      /^prepared-nebula-[0-9a-f]{40}$/.test(prepared.artifactId)
  }
  return supportedBepInExVersions.has(source.version) &&
    prepared.mode === 'official-bepinex-windows-x64-direct' &&
    prepared.layoutPolicy === expectedBepInExPolicy(source.version) &&
    prepared.artifactId === source.artifactId
}

function validPreparedReceiptIdentity(receipt: ComponentCandidatePreparationReceipt): boolean {
  if (!hasExactObjectKeys(receipt.prepared, [
    'mode', 'artifactId', 'layoutPolicy', 'sizeBytes', 'sha256', 'integrity'
  ]) || !validPreparationIdentity(receipt.component, receipt.source, {
    mode: receipt.prepared.mode,
    artifactId: receipt.prepared.artifactId,
    layoutPolicy: receipt.prepared.layoutPolicy
  }) ||
      !validPositiveByteCount(receipt.prepared.sizeBytes) ||
      !sha256Pattern.test(receipt.prepared.sha256)) return false
  if (receipt.component === 'nebula') {
    return receipt.prepared.integrity === 'normalized-locally-computed'
  }
  return receipt.prepared.sizeBytes === receipt.source.sizeBytes &&
    receipt.prepared.sha256 === receipt.source.sha256 &&
    receipt.prepared.integrity === receipt.source.integrity
}

function validStagedManifest(receipt: ComponentCandidatePreparationReceipt): boolean {
  if (!hasExactObjectKeys(receipt.staging, ['created', 'manifest']) ||
      typeof receipt.staging.created !== 'boolean') return false
  const manifest = receipt.staging.manifest
  if (!hasOnlyObjectKeys(manifest, [
    'format', 'schemaVersion', 'artifactId', 'artifactFile', 'release', 'sizeBytes',
    'sha256', 'integrity', 'stagedAt'
  ], ['componentManifest']) || manifest.format !== 'dyson-control-staged-artifact' ||
      manifest.schemaVersion !== 1 || manifest.artifactFile !== 'artifact.bin' ||
      manifest.artifactId !== receipt.prepared.artifactId ||
      manifest.sizeBytes !== receipt.prepared.sizeBytes || manifest.sha256 !== receipt.prepared.sha256 ||
      (manifest.integrity !== 'provider-verified' && manifest.integrity !== 'locally-computed') ||
      !Number.isFinite(Date.parse(manifest.stagedAt)) ||
      !hasExactObjectKeys(manifest.release, ['kind', 'sourceId', 'version']) ||
      manifest.release.kind !== receipt.component ||
      manifest.release.sourceId !== receipt.source.sourceId ||
      manifest.release.version !== receipt.source.version) return false
  if (receipt.component === 'nebula' && manifest.integrity !== 'locally-computed') return false
  if (receipt.component === 'bepinex' && manifest.integrity !== receipt.source.integrity) return false
  return manifest.componentManifest === undefined || validComponentReleaseManifest(
    manifest.componentManifest,
    receipt
  )
}

function validComponentReleaseManifest(
  input: unknown,
  receipt: ComponentCandidatePreparationReceipt
): boolean {
  const hasLayoutPolicy = receipt.component === 'bepinex'
  if (!hasOnlyObjectKeys(input, [
    'format', 'schemaVersion', 'component', 'version', 'artifactId', 'files'
  ], ['layoutPolicy']) || !hasExactObjectKeys(input, hasLayoutPolicy
    ? ['format', 'schemaVersion', 'component', 'version', 'artifactId', 'layoutPolicy', 'files']
    : ['format', 'schemaVersion', 'component', 'version', 'artifactId', 'files']) ||
      input.format !== 'dyson-control-component-release' || input.schemaVersion !== 1 ||
      input.component !== receipt.component || input.version !== receipt.source.version ||
      input.artifactId !== receipt.prepared.artifactId || !Array.isArray(input.files) ||
      input.files.length > 512 || (hasLayoutPolicy
        ? input.layoutPolicy !== receipt.prepared.layoutPolicy
        : Object.hasOwn(input, 'layoutPolicy'))) return false
  return input.files.every((file) => hasExactObjectKeys(file, ['relativePath', 'sizeBytes', 'sha256']) &&
    typeof file.relativePath === 'string' && file.relativePath.length >= 1 && file.relativePath.length <= 240 &&
    validNonNegativeByteCount(file.sizeBytes) && typeof file.sha256 === 'string' &&
    sha256Pattern.test(file.sha256))
}

function samePreparationSource(
  left: AvailableComponentCandidatePreparationPlan['source'],
  right: AvailableComponentCandidatePreparationPlan['source']
): boolean {
  return left.provider === right.provider && left.sourceId === right.sourceId &&
    left.version === right.version && left.artifactId === right.artifactId &&
    left.sizeBytes === right.sizeBytes && left.sha256 === right.sha256 &&
    left.integrity === right.integrity
}

function formatAcquisitionError(reason: unknown, fallback: string): string {
  if (!(reason instanceof ApiError)) return fallback
  return `${reason.message}${reason.code ? ` · ${reason.code}` : ''}`
}

function formatPreparationError(reason: unknown, fallback: string): string {
  if (!(reason instanceof ApiError)) return fallback
  return `${reason.message}${reason.code ? ` · ${reason.code}` : ''}`
}

function hasExactObjectKeys(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const actual = Object.keys(value)
  return actual.length === keys.length && keys.every((key) => Object.hasOwn(value, key))
}

function hasOnlyObjectKeys(
  value: unknown,
  required: readonly string[],
  optional: readonly string[]
): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const actual = Object.keys(value)
  const allowed = new Set([...required, ...optional])
  return required.every((key) => Object.hasOwn(value, key)) && actual.every((key) => allowed.has(key))
}

function validPositiveByteCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 &&
    value <= 2 * 1_024 * 1_024 * 1_024
}

function validNonNegativeByteCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 &&
    value <= 2 * 1_024 * 1_024 * 1_024
}

function isPreparationComponent(value: unknown): value is SupportedComponentCandidatePreparationComponent {
  return value === 'nebula' || value === 'bepinex'
}

function componentFromRelease(
  release: ComponentDiscoveryRelease
): SupportedComponentCandidatePreparationComponent {
  return release.sourceId === 'github:BepInEx/BepInEx' ? 'bepinex' : 'nebula'
}

function expectedComponentSource(component: SupportedComponentCandidatePreparationComponent): string {
  return component === 'nebula' ? 'github:NebulaModTeam/nebula' : 'github:BepInEx/BepInEx'
}

function expectedBepInExPolicy(version: string): string | null {
  if (version === '5.4.22' || version === '5.4.22.0') return 'bepinex5-win-x64-5.4.22-v1'
  if (version === '5.4.23.2' || version === '5.4.23.3' ||
      version === '5.4.23.4' || version === '5.4.23.5') {
    return 'bepinex5-win-x64-5.4.23.2-5-v1'
  }
  return null
}

function validAcquisitionReleaseIdentity(
  release: ArtifactAcquisitionReceipt['release']
): boolean {
  if (release.kind === 'nebula') return release.sourceId === 'github:NebulaModTeam/nebula'
  if (release.kind === 'bepinex') {
    return release.sourceId === 'github:BepInEx/BepInEx' && supportedBepInExVersions.has(release.version)
  }
  return release.sourceId.startsWith('thunderstore:')
}

function replaceAbortController(
  reference: { current: AbortController | null }
): AbortController {
  reference.current?.abort()
  const controller = new AbortController()
  reference.current = controller
  return controller
}

const acquisitionRegistrationStatuses = new Set<ArtifactAcquisitionRegistration['status']>([
  'registered', 'not-configured', 'release-ineligible', 'registration-failed'
])
const acquisitionOperations = new Set<ArtifactAcquisitionPlan['operations'][number]>([
  'load-server-registered-candidate',
  'acquire-exclusive-request-and-artifact-locks',
  'download-from-bound-provider',
  'stream-size-and-sha256-verification',
  'atomically-publish-fixed-inbox-artifact',
  'persist-acquisition-receipt',
  'release-exclusive-locks'
])
const preparationOperations = new Set<AvailableComponentCandidatePreparationPlan['operations'][number]>([
  'load-validated-acquisition-receipt',
  'verify-fixed-inbox-artifact',
  'acquire-exclusive-request-and-artifact-locks',
  'validate-official-nebula-windows-layout-and-identity',
  'build-deterministic-server-managed-component-archive',
  'atomically-publish-fixed-inbox-artifact',
  'validate-reviewed-bepinex-windows-x64-layout',
  'stage-official-artifact-directly',
  'stage-verified-artifact',
  'persist-preparation-receipt',
  'release-exclusive-locks'
])
const supportedBepInExVersions = new Set([
  '5.4.22', '5.4.22.0', '5.4.23.2', '5.4.23.3', '5.4.23.4', '5.4.23.5'
])
const bepInExLayoutPolicies = new Set([
  'bepinex5-win-x64-5.4.22-v1',
  'bepinex5-win-x64-5.4.23.2-5-v1'
])

function isAcquisitionRegistrationStatus(
  value: unknown
): value is ArtifactAcquisitionRegistration['status'] {
  return typeof value === 'string' && acquisitionRegistrationStatuses.has(
    value as ArtifactAcquisitionRegistration['status']
  )
}

function emptyDraft(component: SupportedComponentCandidatePreparationComponent): ActivationDraft {
  return {
    requestId: createUiRequestId(),
    component,
    artifactId: '',
    sha256: '',
    targetVersion: '',
    expectedRevision: ''
  }
}

function validateCandidateDraft(
  draft: ActivationDraft,
  state: UpdateActivationState | null
): string | null {
  if (!state) return '活动组件 revision 不可用；预演保持 fail-closed。'
  if (state.recoveryRequired) return 'recoveryRequired=true；必须先完成离线恢复核验。'
  if (draft.expectedRevision !== state.revision) return 'expectedRevision 已过期；请绑定当前 revision 后重新预演。'
  if (!artifactIdPattern.test(draft.artifactId)) return 'artifact ID 必须是 16–96 位小写字母、数字或连字符的逻辑标识。'
  if (!sha256Pattern.test(draft.sha256)) return 'SHA-256 必须是 64 位十六进制摘要。'
  if (!versionPattern.test(draft.targetVersion.trim()) || draft.targetVersion.trim().length > 64) return '目标版本必须是有界的三段或四段版本号。'
  return null
}

function validatePreparedDraft(
  draft: ActivationDraft,
  state: UpdateActivationState | null,
  preparedReceipt: ComponentCandidatePreparationReceipt | null,
  preparedReceiptVerified: boolean
): string | null {
  const candidateError = validateCandidateDraft(draft, state)
  if (candidateError) return candidateError
  if (!preparedReceipt || !preparedReceiptVerified) {
    return '必须先重新读取并严格核验 prepared receipt；raw acquisition receipt 不能解锁激活。'
  }
  if (!preparationReceiptMatches(preparedReceipt, preparedReceipt.requestId)) {
    return 'prepared receipt 未通过严格身份、模式与 staging manifest 校验。'
  }
  if (draft.component !== preparedReceipt.component ||
      draft.artifactId !== preparedReceipt.prepared.artifactId ||
      draft.sha256.toLowerCase() !== preparedReceipt.prepared.sha256 ||
      draft.targetVersion.trim() !== preparedReceipt.source.version) {
    return '激活草稿与 verified prepared receipt 不一致；请重新装入候选。'
  }
  return null
}

function validateDraft(
  draft: ActivationDraft,
  state: UpdateActivationState | null,
  preparedReceipt: ComponentCandidatePreparationReceipt | null,
  preparedReceiptVerified: boolean,
  compatibilityState: CompatibilityReceiptState
): string | null {
  const preparedError = validatePreparedDraft(draft, state, preparedReceipt, preparedReceiptVerified)
  if (preparedError) return preparedError
  if (compatibilityState.code !== 'ready') return compatibilityState.detail
  return null
}

function compatibilityReceiptState(
  receipt: UpdateCompatibilityReceipt | null,
  draft: ActivationDraft,
  status: UpdateCompatibilityStatus | null,
  verified: boolean
): CompatibilityReceiptState {
  if (!status) return {
    code: 'status-unavailable', label: 'STATUS UNAVAILABLE', tone: 'red',
    detail: '无法读取服务端兼容性状态；激活保持 fail-closed。'
  }
  if (!status.available || status.policyId === null || status.policyRevision === null) return {
    code: 'policy-unavailable', label: 'POLICY UNAVAILABLE', tone: 'red',
    detail: '服务端没有装载可信兼容性策略；浏览器不会构造替代矩阵。'
  }
  if (!receipt) return {
    code: 'receipt-missing', label: 'RECEIPT REQUIRED', tone: 'amber',
    detail: '输入已固定的 artifact 身份，然后让服务端按当前 policy 与 inventory 签发短期回执。'
  }
  if (!verified) return {
    code: 'receipt-unverified', label: 'RECEIPT UNVERIFIED', tone: 'amber',
    detail: '已有执行结果，但尚未通过精确 receipt ID 重新读取持久回执。'
  }
  if (!isCompatibilityReceiptShape(receipt)) return {
    code: 'receipt-invalid', label: 'RECEIPT INVALID', tone: 'red',
    detail: '持久回执未通过严格合同校验；不会用它生成激活预演。'
  }
  if (Date.parse(receipt.expiresAt) <= Date.now()) return {
    code: 'receipt-expired', label: 'RECEIPT EXPIRED', tone: 'red',
    detail: '兼容性回执已过期；请按当前运行时 inventory 重新签发。'
  }
  if (receipt.policyId !== status.policyId || receipt.policyRevision !== status.policyRevision ||
      receipt.inventoryRevision !== status.inventoryRevision) return {
    code: 'revision-stale', label: 'REVISION DRIFT', tone: 'red',
    detail: '策略或运行时 inventory 已变化；旧回执不再可用。'
  }
  if (receipt.component !== draft.component || receipt.artifactId !== draft.artifactId ||
      receipt.artifactSha256 !== draft.sha256.toLowerCase() || receipt.targetVersion !== draft.targetVersion.trim()) return {
    code: 'candidate-mismatch', label: 'IDENTITY MISMATCH', tone: 'red',
    detail: '回执绑定的 component、artifact、SHA-256 或目标版本与当前候选不一致。'
  }
  if (!receipt.compatible) return {
    code: 'incompatible', label: 'INCOMPATIBLE', tone: 'red',
    detail: '服务端可信策略判定该候选不兼容；激活预演保持锁定。'
  }
  return {
    code: 'ready', label: 'COMPATIBLE / VERIFIED', tone: 'green',
    detail: '候选身份、policy revision、inventory revision、TTL 与持久回执均已核对。'
  }
}

function isCompatibilityReceiptShape(receipt: UpdateCompatibilityReceipt): boolean {
  return hasExactObjectKeys(receipt, [
    'format', 'schemaVersion', 'receiptId', 'component', 'artifactId', 'artifactSha256',
    'targetVersion', 'inventoryRevision', 'policyId', 'policyRevision', 'matchedEntryId',
    'compatible', 'issuedAt', 'expiresAt', 'reused'
  ]) && receipt.format === 'dyson-control-trusted-compatibility-receipt' && receipt.schemaVersion === 1 &&
    uuidPattern.test(receipt.receiptId) && managedComponents.some((entry) => entry.component === receipt.component) &&
    artifactIdPattern.test(receipt.artifactId) && sha256Pattern.test(receipt.artifactSha256) &&
    versionPattern.test(receipt.targetVersion) && receipt.targetVersion.length <= 64 &&
    /^[0-9a-f]{64}$/.test(receipt.inventoryRevision) && /^[0-9a-f]{64}$/.test(receipt.policyRevision) &&
    /^[A-Za-z0-9][A-Za-z0-9._:-]{2,95}$/.test(receipt.policyId) &&
    (receipt.matchedEntryId === null || /^[A-Za-z0-9][A-Za-z0-9._:-]{0,95}$/.test(receipt.matchedEntryId)) &&
    typeof receipt.compatible === 'boolean' && typeof receipt.reused === 'boolean' &&
    Number.isFinite(Date.parse(receipt.issuedAt)) && Number.isFinite(Date.parse(receipt.expiresAt)) &&
    Date.parse(receipt.expiresAt) > Date.parse(receipt.issuedAt)
}

function compatibilityReceiptMatchesStatus(
  receipt: UpdateCompatibilityReceipt,
  status: UpdateCompatibilityStatus
): boolean {
  return isCompatibilityReceiptShape(receipt) && status.available && status.policyId !== null &&
    status.policyRevision !== null && receipt.policyId === status.policyId &&
    receipt.policyRevision === status.policyRevision && receipt.inventoryRevision === status.inventoryRevision &&
    Date.parse(receipt.expiresAt) > Date.now()
}

function compatibilityReceiptMatchesRequest(
  receipt: UpdateCompatibilityReceipt,
  request: UpdateCompatibilityPreparationRequest,
  status: UpdateCompatibilityStatus
): boolean {
  return compatibilityReceiptMatchesStatus(receipt, status) && receipt.receiptId === request.requestId &&
    receipt.component === request.component && receipt.artifactId === request.artifactId &&
    receipt.artifactSha256 === request.sha256.toLowerCase() && receipt.targetVersion === request.targetVersion.trim() &&
    receipt.inventoryRevision === request.expectedInventoryRevision && receipt.policyRevision === request.expectedPolicyRevision
}

function formatCompatibilityError(reason: unknown, fallback: string): string {
  if (!(reason instanceof ApiError)) return fallback
  return `${reason.message}${reason.code ? ` · ${reason.code}` : ''}`
}

function componentLabel(component: ManagedUpdateComponent): string {
  return managedComponents.find((entry) => entry.component === component)?.label ?? component
}

function operationLabel(operation: string): string {
  return ({
    'acquire-global-update-lock': '获取全局更新锁',
    'verify-staged-artifact-and-archive': '核验固定暂存资源与压缩包',
    'assemble-immutable-release': '组装不可变 release',
    'prove-process-stopped-and-port-closed': '证明进程停止且端口关闭',
    'capture-config-mod-lock-and-loaded-save-baseline': '采集配置、模组锁与旧存档身份基线',
    'create-paired-save-protection-point': '创建成对存档保护点',
    'bind-rollback-context-journal': '绑定 rollback transaction journal',
    'revalidate-stop-revision-and-compatibility': '重新核验停止态、revision 与兼容性',
    'atomically-switch-active-manifest': '原子切换活动清单（旧预演合同）',
    'publish-and-verify-fixed-live-component': '发布并核验固定 live component',
    'run-fixed-health-check': '运行固定 smoke 健康检查',
    'restore-component-config-mod-lock-and-paired-save-on-failure': '失败时逐项恢复组件、配置、模组锁与配对存档',
    'rollback-and-verify-on-failure': '失败时回滚并重新核验（旧预演合同）',
    'prove-current-generation-exact-save-load': '证明 Bridge 与日志在当前启动代际加载 exact previous save',
    'persist-audit-safe-receipt': '持久化审计安全回执',
    'release-global-update-lock': '释放全局更新锁'
  } as Record<string, string>)[operation] ?? operation
}

function componentRollbackReceiptProjection(
  receipt: UpdateActivationReceipt | null
): ComponentRollbackReceiptProjection | null {
  if (receipt === null || !hasOnlyObjectKeys(receipt, [
    'format', 'schemaVersion', 'requestId', 'component', 'artifactId', 'compatibilityReceiptId',
    'targetVersion', 'releaseId', 'status', 'previousRevision', 'resultingRevision',
    'protectionBackupId', 'rollbackBindingSha256', 'rollbackSteps', 'failureCode',
    'rollbackVerified', 'recoveryRequired', 'fileCount', 'expandedBytes', 'completedAt', 'reused'
  ], [])) return null
  const value = receipt as unknown as Record<string, unknown>
  if (!nullableSha256(value.rollbackBindingSha256) || !hasExactObjectKeys(value.rollbackSteps, [
    'component', 'configuration', 'serverModLock', 'pairedSave', 'previousSaveLoad'
  ])) return null
  const statuses = new Set(['not-required', 'pending', 'verified', 'failed'])
  if (Object.values(value.rollbackSteps).some((status) => !statuses.has(String(status)))) return null
  return {
    rollbackBindingSha256: value.rollbackBindingSha256 as string | null,
    rollbackSteps: value.rollbackSteps as unknown as ComponentRollbackReceiptProjection['rollbackSteps']
  }
}

function formatActivationError(reason: unknown, fallback: string): string {
  if (!(reason instanceof ApiError)) return fallback
  return `${reason.message}${reason.code ? ` · ${reason.code}` : ''}`
}

function isClosedGateFailure(reason: unknown): boolean {
  return reason instanceof ApiError && (
    reason.status === 423
    || reason.code === 'UPDATE_ACTIVATION_NOT_CONFIGURED'
    || reason.code === 'UPDATE_ACTIVATION_HTTP_MUTATION_DISABLED'
    || reason.code === 'UPDATE_ACTIVATION_HTTP_GATE_UNAVAILABLE'
  )
}

function shortHash(value: string, length: number): string {
  return value.length <= length ? value : `${value.slice(0, length)}…`
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '—'
  if (bytes < 1_024) return `${bytes} B`
  if (bytes < 1_048_576) return `${(bytes / 1_024).toFixed(1)} KiB`
  if (bytes < 1_073_741_824) return `${(bytes / 1_048_576).toFixed(1)} MiB`
  return `${(bytes / 1_073_741_824).toFixed(2)} GiB`
}

function fictionalPlan(
  request: UpdateActivationRequest & {
    component: ManagedUpdateComponent
    artifactId: string
    compatibilityReceiptId: string
  },
  state: UpdateActivationState
): UpdateActivationPlan {
  const inventory = {
    ...fictionalCompatibilityStatus.inventory,
    plugins: fictionalCompatibilityStatus.inventory.plugins.map((entry) => ({ ...entry }))
  }
  if (request.component === 'nebula') inventory.nebula = request.targetVersion
  else if (request.component === 'bepinex') inventory.bepInEx = request.targetVersion
  else {
    const sourceId = managedComponents.find((entry) => entry.component === request.component)?.source ?? request.component
    inventory.plugins = inventory.plugins.filter((entry) => entry.sourceId !== sourceId)
    inventory.plugins.push({ sourceId, version: request.targetVersion })
  }
  const matchedEntryId = 'fictional-exact-policy-entry'
  return {
    format: 'dyson-control-component-update-plan',
    schemaVersion: 1,
    dryRun: true,
    requestId: request.requestId,
    component: request.component,
    artifactId: request.artifactId!,
    targetVersion: request.targetVersion,
    expectedRevision: request.expectedRevision,
    compatibilityReceiptId: request.compatibilityReceiptId,
    releaseId: `${request.component}-${'f'.repeat(32)}`,
    fileCount: 7,
    expandedBytes: 262_144,
    compatibility: {
      compatible: true,
      matchedEntryId,
      inventory,
      evaluations: [{ entryId: matchedEntryId, compatible: true, reasons: [] }]
    },
    operations: [
      'acquire-global-update-lock',
      'verify-staged-artifact-and-archive',
      'assemble-immutable-release',
      'prove-process-stopped-and-port-closed',
      'capture-config-mod-lock-and-loaded-save-baseline',
      'create-paired-save-protection-point',
      'bind-rollback-context-journal',
      'revalidate-stop-revision-and-compatibility',
      'publish-and-verify-fixed-live-component',
      'run-fixed-health-check',
      'restore-component-config-mod-lock-and-paired-save-on-failure',
      'prove-current-generation-exact-save-load',
      'persist-audit-safe-receipt',
      'release-global-update-lock'
    ],
    rollback: {
      automatic: true,
      previousReleaseRequired: state.components.some((entry) => entry.component === request.component),
      recoveryRequiredIfUnproven: true
    }
  }
}

const fictionalCompatibilityStatus: UpdateCompatibilityStatus = {
  format: 'dyson-control-trusted-compatibility-status',
  schemaVersion: 1,
  available: true,
  policyId: 'fictional-dsp-nebula-policy-v1',
  policyRevision: '3'.repeat(64),
  policyReviewedAt: '2026-08-31T00:00:00.000Z',
  inventoryRevision: '2'.repeat(64),
  inventory: {
    dsp: '0.10.32.25700',
    nebula: '0.9.22.2',
    bepInEx: '5.4.23',
    plugins: []
  }
}

function fictionalCompatibilityReceipt(draft: ActivationDraft): UpdateCompatibilityReceipt {
  return {
    format: 'dyson-control-trusted-compatibility-receipt',
    schemaVersion: 1,
    receiptId: draft.requestId,
    component: draft.component,
    artifactId: draft.artifactId,
    artifactSha256: draft.sha256.toLowerCase(),
    targetVersion: draft.targetVersion.trim(),
    inventoryRevision: fictionalCompatibilityStatus.inventoryRevision,
    policyId: fictionalCompatibilityStatus.policyId!,
    policyRevision: fictionalCompatibilityStatus.policyRevision!,
    matchedEntryId: 'fictional-exact-policy-entry',
    compatible: true,
    issuedAt: '2026-08-31T00:00:00.000Z',
    expiresAt: '2099-12-31T23:59:59.000Z',
    reused: false
  }
}

function fictionalPreparationReceipt(): ComponentCandidatePreparationReceipt {
  const artifactId = `prepared-nebula-${'b'.repeat(40)}`
  const sha256 = 'a'.repeat(64)
  return {
    format: 'dyson-control-component-preparation-receipt',
    schemaVersion: 1,
    requestId: '11111111-1111-4111-8111-111111111111',
    component: 'nebula',
    acquisitionReceiptId: '22222222-2222-4222-8222-222222222222',
    source: {
      provider: 'github',
      sourceId: 'github:NebulaModTeam/nebula',
      version: '0.9.22',
      artifactId: 'fictional-nebula-source-0001',
      sizeBytes: 4_194_304,
      sha256: 'c'.repeat(64),
      integrity: 'provider-verified'
    },
    prepared: {
      mode: 'normalized-nebula-windows',
      artifactId,
      layoutPolicy: 'nebula-official-windows-v0.9.22',
      sizeBytes: 2_097_152,
      sha256,
      integrity: 'normalized-locally-computed'
    },
    staging: {
      created: true,
      manifest: {
        format: 'dyson-control-staged-artifact',
        schemaVersion: 1,
        artifactId,
        artifactFile: 'artifact.bin',
        release: {
          kind: 'nebula',
          sourceId: 'github:NebulaModTeam/nebula',
          version: '0.9.22'
        },
        sizeBytes: 2_097_152,
        sha256,
        integrity: 'locally-computed',
        stagedAt: '2026-08-31T00:00:00.000Z'
      }
    },
    state: 'staged',
    reused: false,
    preparedAt: '2026-08-31T00:00:00.000Z'
  }
}

const fictionalActivationState: UpdateActivationState = {
  revision: '1'.repeat(64),
  recoveryRequired: false,
  components: [
    { component: 'nebula', version: '0.9.22.2', artifactId: 'fictional-nebula-active-0001', releaseId: `nebula-${'a'.repeat(32)}` },
    { component: 'bepinex', version: '5.4.23', artifactId: 'fictional-bepinex-active-0001', releaseId: `bepinex-${'b'.repeat(32)}` },
    { component: 'bridge', version: '1.2.0', artifactId: 'fictional-bridge-active-0001', releaseId: `bridge-${'c'.repeat(32)}` },
    { component: 'control', version: '1.2.0', artifactId: 'fictional-control-active-0001', releaseId: `control-${'d'.repeat(32)}` }
  ],
  historyEntries: 4
}

const fictionalActivationRecoveryStatus: UpdateActivationRecoveryStatus = {
  schemaVersion: 1,
  phase: 'ready',
  mutationBlocked: false,
  recoveryRequired: false,
  failureCode: null,
  reconciledRequestId: null
}

const fictionalCleanupPlan: UpdateCleanupPlan = {
  format: 'dyson-control-component-update-cleanup-plan',
  schemaVersion: 1,
  dryRun: true,
  executeSupported: false,
  candidates: [
    { kind: 'history', opaqueId: 'fictional-history-0001', recoverable: true, reason: 'history-retention-exceeded' },
    { kind: 'release', opaqueId: 'fictional-release-0001', recoverable: true, reason: 'unreferenced-release' }
  ]
}

const fictionalNebulaReleases: ComponentDiscoveryRelease[] = [
  {
    provider: 'github', sourceId: 'github:NebulaModTeam/nebula', releaseId: 9002,
    version: '0.9.23.0', publishedAt: '2026-08-29T08:00:00.000Z', prerelease: false,
    artifact: {
      artifactId: 'fictional-nebula-artifact-0001',
      downloadUrl: 'https://downloads.example.com/fictional-nebula-0.9.23.0.zip',
      fileName: 'FictionalNebula.zip', sizeBytes: 4_194_304, sha256: 'a'.repeat(64),
      integrity: 'provider-sha256'
    }
  },
  {
    provider: 'github', sourceId: 'github:NebulaModTeam/nebula', releaseId: 9001,
    version: '0.9.22.9', publishedAt: '2026-08-20T08:00:00.000Z', prerelease: false,
    artifact: {
      artifactId: 'fictional-nebula-artifact-0000',
      downloadUrl: 'https://downloads.example.com/fictional-nebula-0.9.22.9.zip',
      fileName: 'FictionalNebula.zip', sizeBytes: 4_100_000, sha256: null,
      integrity: 'locally-computed-required'
    }
  }
]

const fictionalBepInExReleases: ComponentDiscoveryRelease[] = [{
  provider: 'github', sourceId: 'github:BepInEx/BepInEx', releaseId: 540235,
  version: '5.4.23.5', publishedAt: '2026-08-29T08:00:00.000Z',
  layoutPolicy: 'bepinex5-win-x64-5.4.23.2-5-v1',
  artifact: {
    artifactId: 'fictional-bepinex-artifact-0001',
    downloadUrl: 'https://github.com/BepInEx/BepInEx/releases/download/v5.4.23.5/BepInEx_win_x64_5.4.23.5.zip',
    fileName: 'BepInEx_win_x64_5.4.23.5.zip', sizeBytes: 638_940,
    sha256: 'd'.repeat(64), integrity: 'provider-sha256'
  }
}]

const fictionalAcquisitionMeta: ArtifactAcquisitionDiscoveryMeta = {
  configured: false,
  executionEnabled: false,
  candidates: fictionalNebulaReleases.map((release) => ({
    artifactId: release.artifact.artifactId,
    eligible: true,
    status: 'not-configured',
    candidate: null
  }))
}

const fictionalBepInExAcquisitionMeta: ArtifactAcquisitionDiscoveryMeta = {
  configured: false,
  executionEnabled: false,
  candidates: fictionalBepInExReleases.map((release) => ({
    artifactId: release.artifact.artifactId,
    eligible: true,
    status: 'not-configured',
    candidate: null
  }))
}
