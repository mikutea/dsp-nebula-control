import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  ArchiveRestore, Camera, Check, ChevronRight, CircleMinus, CircleX, FileDiff,
  FileLock2, HardDrive, History, LockKeyhole, RefreshCw, RotateCcw, ShieldAlert,
  ShieldCheck, TriangleAlert
} from 'lucide-react'
import { api, ApiError, GameConfigHistoryApiError } from './api'
import { isGameConfigRevision, gameConfigHistoryFileIds } from './game-config-history-contract'
import type {
  GameConfigFileId,
  GameConfigHistoryDiff,
  GameConfigHistoryRecoveryResult,
  GameConfigHistoryRestoreReceipt,
  GameConfigHistorySnapshotDetail,
  GameConfigHistorySnapshotSummary,
  PublicGameConfigValue
} from './model'
import { createUiRequestId } from './request-id'
import { relativeTime } from './format'

const captureConfirmation = 'CREATE_CONFIG_SNAPSHOT'
const restoreConfirmation = 'RESTORE_CONFIG_SNAPSHOT'
const reconcileConfirmation = 'RECONCILE_CONFIG_RESTORE'

type HistoryAction = 'capture' | 'restore-preview' | 'dry-run' | 'restore' | 'reconcile' | null

export function ConfigHistoryWorkspace({ canManage, demo = false, onConfigurationChanged }: {
  canManage: boolean
  demo?: boolean
  onConfigurationChanged: () => void | Promise<void>
}) {
  const [snapshots, setSnapshots] = useState<GameConfigHistorySnapshotSummary[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [detail, setDetail] = useState<GameConfigHistorySnapshotDetail | null>(null)
  const [diff, setDiff] = useState<GameConfigHistoryDiff | null>(null)
  const [listBusy, setListBusy] = useState(true)
  const [detailBusy, setDetailBusy] = useState(false)
  const [readError, setReadError] = useState('')
  const [action, setAction] = useState<HistoryAction>(null)
  const [actionError, setActionError] = useState('')
  const [detailRefresh, setDetailRefresh] = useState(0)

  const [captureArmed, setCaptureArmed] = useState(false)
  const [captureInput, setCaptureInput] = useState('')
  const [captured, setCaptured] = useState<GameConfigHistorySnapshotDetail | null>(null)

  const [restorePreview, setRestorePreview] = useState<GameConfigHistoryDiff | null>(null)
  const [restoreExpectedRevision, setRestoreExpectedRevision] = useState<string | null>(null)
  const [dryRunReceipt, setDryRunReceipt] = useState<GameConfigHistoryRestoreReceipt | null>(null)
  const [restoreReceipt, setRestoreReceipt] = useState<GameConfigHistoryRestoreReceipt | null>(null)
  const [restoreInput, setRestoreInput] = useState('')

  const [reconcileInput, setReconcileInput] = useState('')
  const [recoveryResults, setRecoveryResults] = useState<GameConfigHistoryRecoveryResult[] | null>(null)

  const listControllerRef = useRef<AbortController | null>(null)
  const detailControllerRef = useRef<AbortController | null>(null)
  const actionControllerRef = useRef<AbortController | null>(null)
  const previousSelectedIdRef = useRef<string | null>(null)

  const resetRestoreWorkflow = useCallback(() => {
    setRestorePreview(null)
    setRestoreExpectedRevision(null)
    setDryRunReceipt(null)
    setRestoreInput('')
  }, [])

  const loadHistory = useCallback(async (preferredSnapshotId?: string) => {
    listControllerRef.current?.abort()
    const controller = new AbortController()
    listControllerRef.current = controller
    setListBusy(true)
    setReadError('')
    try {
      const response = await api.gameConfigHistory(controller.signal)
      if (controller.signal.aborted) return
      setSnapshots(response.data)
      setSelectedId((current) => {
        if (preferredSnapshotId && response.data.some(({ snapshotId }) => snapshotId === preferredSnapshotId)) {
          return preferredSnapshotId
        }
        if (current && response.data.some(({ snapshotId }) => snapshotId === current)) return current
        return response.data[0]?.snapshotId ?? null
      })
    } catch (error) {
      if (!controller.signal.aborted) setReadError(historyErrorText(error, '配置快照列表暂不可用'))
    } finally {
      if (listControllerRef.current === controller) {
        listControllerRef.current = null
        setListBusy(false)
      }
    }
  }, [])

  useEffect(() => {
    if (demo) return
    void loadHistory()
    return () => {
      listControllerRef.current?.abort()
      detailControllerRef.current?.abort()
      actionControllerRef.current?.abort()
      listControllerRef.current = null
      detailControllerRef.current = null
      actionControllerRef.current = null
    }
  }, [demo, loadHistory])

  useEffect(() => {
    if (demo) return
    detailControllerRef.current?.abort()
    if (previousSelectedIdRef.current !== selectedId) {
      previousSelectedIdRef.current = selectedId
      setRestoreReceipt(null)
    }
    resetRestoreWorkflow()
    setActionError('')
    setDetail(null)
    setDiff(null)
    if (!selectedId) return
    const controller = new AbortController()
    detailControllerRef.current = controller
    setDetailBusy(true)
    void Promise.all([
      api.gameConfigHistoryDetail(selectedId, controller.signal),
      api.gameConfigHistoryDiff(selectedId, controller.signal)
    ]).then(([detailResponse, diffResponse]) => {
      if (controller.signal.aborted) return
      setDetail(detailResponse.data)
      setDiff(diffResponse.data)
    }).catch((error: unknown) => {
      if (!controller.signal.aborted) setReadError(historyErrorText(error, '所选配置快照读取失败'))
    }).finally(() => {
      if (detailControllerRef.current === controller) {
        detailControllerRef.current = null
        setDetailBusy(false)
      }
    })
    return () => controller.abort()
  }, [demo, detailRefresh, resetRestoreWorkflow, selectedId])

  const selectedSummary = useMemo(
    () => snapshots.find(({ snapshotId }) => snapshotId === selectedId) ?? null,
    [selectedId, snapshots]
  )
  const changedSettings = diff?.settings.filter(({ changed }) => changed) ?? []
  const changedFiles = diff?.files.filter(({ changed }) => changed).length ?? 0
  const restoreReady = dryRunReceipt?.status === 'dry-run'
    && dryRunReceipt.expectedCurrentRevision === restoreExpectedRevision
    && dryRunReceipt.finalRevision === restoreExpectedRevision
    && restorePreview?.currentRevision === restoreExpectedRevision

  function startAction(next: Exclude<HistoryAction, null>): AbortController {
    actionControllerRef.current?.abort()
    const controller = new AbortController()
    actionControllerRef.current = controller
    setAction(next)
    setActionError('')
    return controller
  }

  function finishAction(controller: AbortController): void {
    if (actionControllerRef.current === controller) {
      actionControllerRef.current = null
      setAction(null)
    }
  }

  async function captureSnapshot(): Promise<void> {
    if (!canManage || captureInput !== captureConfirmation) return
    const controller = startAction('capture')
    try {
      const response = await api.captureGameConfigHistory(controller.signal)
      if (controller.signal.aborted) return
      setCaptured(response.data)
      setCaptureInput('')
      setCaptureArmed(false)
      await loadHistory(response.data.snapshotId)
    } catch (error) {
      if (!controller.signal.aborted) setActionError(historyErrorText(error, '配置快照创建失败'))
    } finally {
      finishAction(controller)
    }
  }

  async function prepareRestore(): Promise<void> {
    if (!canManage || !selectedId || !detail) return
    const controller = startAction('restore-preview')
    resetRestoreWorkflow()
    setRestoreReceipt(null)
    try {
      const current = await readCurrentRevision(controller.signal)
      const previewResponse = await api.gameConfigHistoryRestorePreview(selectedId, controller.signal)
      if (controller.signal.aborted) return
      if (previewResponse.data.currentRevision !== current
          || previewResponse.data.targetRevision !== detail.revision) throw staleRevisionError()
      setRestoreExpectedRevision(current)
      setRestorePreview(previewResponse.data)
    } catch (error) {
      if (!controller.signal.aborted) setActionError(historyErrorText(error, '配置恢复预演失败'))
    } finally {
      finishAction(controller)
    }
  }

  async function runDryRun(): Promise<void> {
    if (!canManage || !selectedId || !restorePreview || !restoreExpectedRevision) return
    const controller = startAction('dry-run')
    setDryRunReceipt(null)
    setRestoreReceipt(null)
    setRestoreInput('')
    try {
      const current = await readCurrentRevision(controller.signal)
      if (current !== restoreExpectedRevision || current !== restorePreview.currentRevision) {
        throw staleRevisionError()
      }
      const response = await api.restoreGameConfigHistory(
        createUiRequestId(), selectedId, current, true, controller.signal
      )
      if (controller.signal.aborted) return
      if (response.data.targetRevision !== restorePreview.targetRevision
          || response.data.finalRevision !== current) throw staleRevisionError()
      setDryRunReceipt(response.data)
    } catch (error) {
      if (!controller.signal.aborted) {
        if (isRevisionFailure(error)) {
          setRestorePreview(null)
          setRestoreExpectedRevision(null)
        }
        setActionError(historyErrorText(error, '配置恢复 dry-run 失败'))
      }
    } finally {
      finishAction(controller)
    }
  }

  async function executeRestore(): Promise<void> {
    if (!canManage || !selectedId || !restorePreview || !restoreExpectedRevision
        || !restoreReady || restoreInput !== restoreConfirmation) return
    const controller = startAction('restore')
    setRestoreReceipt(null)
    try {
      const current = await readCurrentRevision(controller.signal)
      if (current !== restoreExpectedRevision || current !== restorePreview.currentRevision
          || dryRunReceipt?.finalRevision !== current) throw staleRevisionError()
      const response = await api.restoreGameConfigHistory(
        createUiRequestId(), selectedId, current, false, controller.signal
      )
      if (controller.signal.aborted) return
      if (response.data.targetRevision !== restorePreview.targetRevision
          || response.data.finalRevision !== restorePreview.targetRevision) throw staleRevisionError()
      setRestoreReceipt(response.data)
      setRestorePreview(null)
      setRestoreExpectedRevision(null)
      setDryRunReceipt(null)
      setRestoreInput('')
      await Promise.resolve(onConfigurationChanged()).catch(() => {
        setReadError('恢复已经提交，但当前配置编辑器刷新失败；请手动重新读取。')
      })
      await loadHistory(selectedId)
      setDetailRefresh((currentRefresh) => currentRefresh + 1)
    } catch (error) {
      if (!controller.signal.aborted) {
        if (error instanceof GameConfigHistoryApiError && error.data && !Array.isArray(error.data)) {
          setRestoreReceipt(error.data)
        }
        setDryRunReceipt(null)
        setRestoreInput('')
        if (isRevisionFailure(error)) {
          setRestorePreview(null)
          setRestoreExpectedRevision(null)
        }
        setActionError(historyErrorText(error, '配置恢复被 fail-closed 门禁拒绝'))
      }
    } finally {
      finishAction(controller)
    }
  }

  async function reconcileHistory(): Promise<void> {
    if (!canManage || reconcileInput !== reconcileConfirmation) return
    const controller = startAction('reconcile')
    setRecoveryResults(null)
    try {
      const response = await api.reconcileGameConfigHistory(controller.signal)
      if (controller.signal.aborted) return
      setRecoveryResults(response.data)
      setReconcileInput('')
      await Promise.resolve(onConfigurationChanged()).catch(() => {
        setReadError('恢复对账已经提交，但当前配置编辑器刷新失败；请手动重新读取。')
      })
      await loadHistory(selectedId ?? undefined)
      setDetailRefresh((currentRefresh) => currentRefresh + 1)
    } catch (error) {
      if (!controller.signal.aborted) {
        if (error instanceof GameConfigHistoryApiError && Array.isArray(error.data)) {
          setRecoveryResults(error.data)
        }
        setActionError(historyErrorText(error, '配置恢复对账失败'))
      }
    } finally {
      finishAction(controller)
    }
  }

  if (demo) {
    return <section className="config-history-workspace" aria-labelledby="config-history-title">
      <header>
        <div className="config-history-orbit"><History size={18} /><i /><i /></div>
        <div><strong id="config-history-title">CONFIGURATION HISTORY ARRAY</strong><small>四文件内容寻址快照 · 脱敏差异 · 受控恢复</small></div>
        <span><b>0</b><small>DEMO READ-ONLY</small></span>
      </header>
      <div className="config-history-readonly">
        <ShieldCheck size={18} /><span><strong>演示环境未装载持久化配置历史控制器</strong><small>这里不会伪造快照、差异或恢复回执，也不会请求生产专用接口。Windows Provider 会继续执行 revision、停止态、dry-run、确认与补偿门禁。</small></span>
      </div>
      <footer><ShieldCheck size={14} /><strong>演示边界</strong><span>配置历史必须来自固定四文件的真实内容寻址快照；虚构数据不能取得恢复资格。</span></footer>
    </section>
  }

  return <section className="config-history-workspace" aria-labelledby="config-history-title">
    <header>
      <div className="config-history-orbit"><History size={18} /><i /><i /></div>
      <div><strong id="config-history-title">CONFIGURATION HISTORY ARRAY</strong><small>四文件内容寻址快照 · 脱敏差异 · 受控恢复</small></div>
      <span><b>{snapshots.length}</b><small>RETAINED SNAPSHOTS</small></span>
      <button type="button" onClick={() => void loadHistory(selectedId ?? undefined)} disabled={listBusy}>
        <RefreshCw className={listBusy ? 'spin' : ''} size={14} />{listBusy ? '读取中' : '刷新历史'}
      </button>
    </header>

    {!canManage ? <div className="config-history-readonly">
      <LockKeyhole size={18} /><span><strong>只读历史会话</strong><small>Viewer 与 Operator 可读取快照、四文件详情和脱敏差异；capture、restore、reconcile 控件仅对拥有 configuration.apply 的 Administrator 渲染。前端提示不是授权边界。</small></span>
    </div> : null}
    {readError ? <HistoryError title="历史读取失败" message={readError} /> : null}
    {actionError ? <HistoryError title="历史事务保持关闭" message={actionError} /> : null}

    <div className="config-history-grid">
      <section className="config-history-list" aria-label="配置快照列表">
        <header><div><HardDrive size={15} /><span><strong>快照索引</strong><small>最多 128 个受控快照</small></span></div><b>{listBusy ? 'SYNC' : 'READ ONLY'}</b></header>
        <div>{snapshots.length ? snapshots.map((snapshot) => <button type="button"
          className={snapshot.snapshotId === selectedId ? 'selected' : ''}
          aria-pressed={snapshot.snapshotId === selectedId}
          key={snapshot.snapshotId}
          onClick={() => setSelectedId(snapshot.snapshotId)}>
          <span className={`snapshot-kind ${snapshot.kind}`}><History size={14} /></span>
          <span><strong>{snapshot.kind === 'manual' ? '手动快照' : '恢复保护点'}</strong><small>{relativeTime(snapshot.createdAt)} · {formatBytes(snapshot.totalBytes)}</small><code>{shortHash(snapshot.snapshotId, 12)}</code></span>
          <ChevronRight size={14} />
        </button>) : <p>{listBusy ? '正在读取快照索引…' : '尚无配置历史快照'}</p>}</div>
      </section>

      <section className="config-history-detail" aria-live="polite">
        <header><div><FileLock2 size={15} /><span><strong>固定四文件快照</strong><small>{selectedSummary ? `${selectedSummary.kind} · ${selectedSummary.createdAt}` : '选择一个快照查看详情'}</small></span></div><b>{detailBusy ? 'VERIFYING' : detail ? 'CONTRACT VALID' : 'NO SELECTION'}</b></header>
        {detailBusy ? <div className="config-history-loading"><span className="spinner" />验证详情与脱敏差异…</div>
          : detail && diff ? <>
            <div className="config-history-identity">
              <HistoryIdentity label="SNAPSHOT ID" value={shortHash(detail.snapshotId, 18)} detail={detail.kind === 'manual' ? 'manual capture' : 'pre-restore protection'} />
              <HistoryIdentity label="TARGET REVISION" value={shortHash(detail.revision)} detail="SHA-256 configuration revision" />
              <HistoryIdentity label="MANIFEST" value={shortHash(detail.manifestSha256)} detail={`${detail.fileCount} present · ${formatBytes(detail.totalBytes)}`} />
              <HistoryIdentity label="CURRENT REVISION" value={shortHash(diff.currentRevision)} detail={`${changedFiles} files · ${changedSettings.length} changed settings`} />
            </div>
            <div className="config-history-files">{gameConfigHistoryFileIds.map((fileId) => {
              const file = detail.files.find(({ id }) => id === fileId)!
              const fileDiff = diff.files.find(({ id }) => id === fileId)!
              return <article className={fileDiff.changed ? 'changed' : ''} key={fileId}>
                <span>{file.present ? <Check size={14} /> : <CircleMinus size={14} />}</span>
                <div><strong>{configHistoryFileLabel(fileId)}</strong><small>{file.present ? `${formatBytes(file.bytes)} verified` : 'not present in snapshot'}</small></div>
                <b>{fileDiff.changed ? 'CHANGED' : 'SAME'}</b>
                <em>{presenceTransition(fileDiff.beforePresent, fileDiff.afterPresent)}</em>
              </article>
            })}</div>
            <section className="config-history-diff">
              <header><div><FileDiff size={15} /><span><strong>REDACTED SETTING DIFF</strong><small>secret 永远只显示 configured 状态，不显示原值</small></span></div><b>{changedSettings.length} CHANGED / {diff.settings.length} TOTAL</b></header>
              <div>{diff.settings.length ? diff.settings.map((entry) => <article className={entry.changed ? 'changed' : ''} key={entry.id}>
                <span>{entry.changed ? <FileDiff size={14} /> : <Check size={14} />}</span>
                <div><strong>{entry.id}</strong><small>{configHistoryFileLabel(entry.file)} · {isConfiguredValue(entry.before) || isConfiguredValue(entry.after) ? 'SECRET REDACTED' : 'PUBLIC SETTING'}</small></div>
                <code>{displayHistoryValue(entry.before)} → {displayHistoryValue(entry.after)}</code>
                <b>{entry.changed ? 'CHANGED' : 'SAME'}</b>
              </article>) : <p>该快照与当前固定 Schema 没有设置差异。</p>}</div>
              <footer><ShieldCheck size={14} />差异数据只包含布尔值、有限数值或 <code>{'{ configured: boolean }'}</code>；客户端会拒绝字符串 secret 与额外字段。</footer>
            </section>
          </> : <div className="config-history-loading"><FileLock2 size={24} /><strong>选择一个通过合同校验的快照</strong><small>不会接受路径、URL、命令、文件名或浏览器 stop-proof token。</small></div>}
      </section>
    </div>

    {captured ? <HistoryReceipt tone="success" title="手动配置快照已创建"
      detail={`${shortHash(captured.snapshotId, 18)} · ${captured.fileCount} files · ${formatBytes(captured.totalBytes)}`} /> : null}
    {restoreReceipt ? <HistoryReceipt tone={restoreReceipt.status === 'restored' ? 'success' : 'danger'}
      title={restoreReceipt.status === 'restored' ? '配置快照恢复已提交' : `恢复状态：${restoreReceipt.status}`}
      detail={`${shortHash(restoreReceipt.requestId, 18)} · ${restoreReceipt.errorCode} · ${restoreReceipt.reused ? 'idempotent replay' : 'new receipt'}`} /> : null}

    {canManage ? <div className="config-history-admin">
      <section className="config-history-capture">
        <header><div><Camera size={15} /><span><strong>手动捕获当前配置</strong><small>创建只读四文件内容寻址快照，不重启服务端</small></span></div><b>ADMIN</b></header>
        {!captureArmed ? <button type="button" onClick={() => { setCaptureArmed(true); setCaptureInput(''); setActionError('') }} disabled={action !== null}><Camera size={14} />准备创建快照</button>
          : <div className="config-history-confirm"><label><span>输入精确确认短语 <code>{captureConfirmation}</code></span><input aria-label="创建快照确认短语" value={captureInput} onChange={(event) => setCaptureInput(event.target.value)} autoComplete="off" spellCheck={false} /></label><button type="button" onClick={() => { setCaptureArmed(false); setCaptureInput('') }}>取消</button><button type="button" className="confirm" disabled={captureInput !== captureConfirmation || action !== null} onClick={() => void captureSnapshot()}>{action === 'capture' ? '创建中…' : '确认创建'}</button></div>}
      </section>

      <section className="config-history-restore">
        <header><div><ArchiveRestore size={16} /><span><strong>快照恢复资格链</strong><small>最新 revision → 只读预演 → 新 UUID dry-run → 精确二次确认</small></span></div><b>FAIL-CLOSED</b></header>
        <div className="config-history-steps">
          <button type="button" onClick={() => void prepareRestore()} disabled={!detail || action !== null}><span>01</span><strong>读取最新 revision 并预演</strong><small>调用只读 restore-preview</small></button>
          <button type="button" onClick={() => void runDryRun()} disabled={!restorePreview || !restoreExpectedRevision || action !== null}><span>02</span><strong>执行 dry-run</strong><small>新 UUID + 服务端停止态证明</small></button>
          <div className={restoreReady ? 'ready' : ''}><span>03</span><strong>执行资格</strong><small>{restoreReady ? 'dry-run receipt 已验证；提交时再次检查 revision' : '等待 dry-run 且 revision 一致'}</small></div>
        </div>
        {restorePreview ? <div className="config-history-preview-result">
          <span><b>CURRENT</b><code>{shortHash(restorePreview.currentRevision)}</code></span>
          <ChevronRight size={14} />
          <span><b>TARGET</b><code>{shortHash(restorePreview.targetRevision)}</code></span>
          <strong>{restorePreview.files.filter(({ changed }) => changed).length} FILES · {restorePreview.settings.filter(({ changed }) => changed).length} SETTINGS</strong>
        </div> : null}
        {dryRunReceipt ? <HistoryReceipt tone="dry-run" title="恢复 dry-run 回执已验证"
          detail={`${shortHash(dryRunReceipt.requestId, 18)} · revision ${shortHash(dryRunReceipt.expectedCurrentRevision)} · persisted ${String(dryRunReceipt.persisted)}`} /> : null}
        {restoreReady ? <div className="config-history-execute" role="group" aria-labelledby="restore-execute-title">
          <div><ShieldAlert size={19} /><span><strong id="restore-execute-title">高风险恢复二次确认</strong><small>执行前会重新读取当前 revision；不一致时清空 dry-run 资格。输入 <code>{restoreConfirmation}</code></small></span></div>
          <input aria-label="恢复快照确认短语" value={restoreInput} onChange={(event) => setRestoreInput(event.target.value)} autoComplete="off" spellCheck={false} />
          <button type="button" disabled={restoreInput !== restoreConfirmation || action !== null} onClick={() => void executeRestore()}>{action === 'restore' ? '恢复中…' : '确认恢复快照'}</button>
        </div> : null}
      </section>

      <section className="config-history-reconcile">
        <header><div><RotateCcw size={15} /><span><strong>中断恢复对账</strong><small>独立高风险操作；只处理服务端固定 pending/orphan 状态</small></span></div><b>ADMIN · STOPPED</b></header>
        <div><TriangleAlert size={18} /><label><span>输入 <code>{reconcileConfirmation}</code></span><input aria-label="配置恢复对账确认短语" value={reconcileInput} onChange={(event) => setReconcileInput(event.target.value)} autoComplete="off" spellCheck={false} /></label><button type="button" disabled={reconcileInput !== reconcileConfirmation || action !== null} onClick={() => void reconcileHistory()}>{action === 'reconcile' ? '对账中…' : '执行独立对账'}</button></div>
        {recoveryResults ? <div className="config-history-recovery-results">{recoveryResults.length ? recoveryResults.map((result) => <article className={result.status === 'recovery-required' ? 'danger' : ''} key={result.requestId}><span>{result.status === 'recovery-required' ? <CircleX size={14} /> : <Check size={14} />}</span><div><strong>{result.status}</strong><small>{shortHash(result.requestId, 18)}</small></div><code>{result.errorCode}</code></article>) : <p>没有需要对账的中断恢复事务。</p>}</div> : null}
      </section>
    </div> : null}

    <footer><ShieldCheck size={14} /><strong>浏览器边界</strong><span>所有写请求仅含固定 UUID、snapshotId、SHA-256 revision、dryRun 和操作专属确认短语；主机路径、URL、命令、文件名及 stop-proof token 均不会进入浏览器合同。</span></footer>
  </section>
}

function HistoryIdentity({ label, value, detail }: { label: string; value: string; detail: string }) {
  return <div><span>{label}</span><strong title={value}>{value}</strong><small>{detail}</small></div>
}

function HistoryError({ title, message }: { title: string; message: string }) {
  return <div className="config-history-error" role="alert"><TriangleAlert size={16} /><span><strong>{title}</strong><small>{message}</small></span></div>
}

function HistoryReceipt({ tone, title, detail }: {
  tone: 'success' | 'dry-run' | 'danger'
  title: string
  detail: string
}) {
  return <div className={`config-history-receipt ${tone}`}><span>{tone === 'danger' ? <CircleX size={15} /> : <Check size={15} />}</span><div><strong>{title}</strong><small>{detail}</small></div><b>{tone === 'dry-run' ? 'DRY-RUN' : tone === 'success' ? 'DURABLE RECEIPT' : 'FAIL-CLOSED'}</b></div>
}

async function readCurrentRevision(signal: AbortSignal): Promise<string> {
  let response: Awaited<ReturnType<typeof api.configuration>>
  try {
    response = await api.configuration(signal)
  } catch (error) {
    if (signal.aborted || (error instanceof DOMException && error.name === 'AbortError')) throw error
    if (error instanceof ApiError && (error.status === 401 || error.code === 'AUTH_REQUIRED')) {
      throw new GameConfigHistoryApiError(
        401,
        '配置历史需要重新建立认证会话。',
        'AUTH_REQUIRED'
      )
    }
    if (error instanceof ApiError && (error.status === 403 || error.code === 'AUTHORIZATION_DENIED')) {
      throw new GameConfigHistoryApiError(
        403,
        '当前角色没有读取配置 revision 的服务端权限。',
        'AUTHORIZATION_DENIED'
      )
    }
    if (error instanceof ApiError && error.status === 409) throw staleRevisionError()
    throw new GameConfigHistoryApiError(
      503,
      '当前配置 revision 暂不可用；恢复工作流保持关闭。',
      'CONFIG_HISTORY_HTTP_UNAVAILABLE'
    )
  }
  const revision = response.data.revision
  if (!isGameConfigRevision(revision)) {
    throw new GameConfigHistoryApiError(
      502,
      '当前配置 revision 未通过 SHA-256 合同校验；恢复保持关闭。',
      'CONFIG_HISTORY_CURRENT_REVISION_INVALID'
    )
  }
  return revision.toLowerCase()
}

function staleRevisionError(): GameConfigHistoryApiError {
  return new GameConfigHistoryApiError(
    409,
    '当前配置 revision 已变化；必须重新读取、预演并执行 dry-run。',
    'CONFIG_HISTORY_REVISION_CONFLICT'
  )
}

function isRevisionFailure(error: unknown): boolean {
  return error instanceof ApiError && (error.status === 409 || error.code === 'CONFIG_HISTORY_REVISION_CONFLICT')
}

function historyErrorText(error: unknown, fallback: string): string {
  return error instanceof ApiError
    ? `${error.message}${error.code ? ` · ${error.code}` : ''}`
    : fallback
}

function configHistoryFileLabel(file: GameConfigFileId): string {
  return ({
    nebula: 'Nebula Multiplayer',
    galaxy: 'Galaxy Generation',
    bepinex: 'BepInEx Runtime',
    bridge: 'Control Bridge'
  } satisfies Record<GameConfigFileId, string>)[file]
}

function isConfiguredValue(value: PublicGameConfigValue): value is { configured: boolean } {
  return typeof value === 'object'
}

function displayHistoryValue(value: PublicGameConfigValue): string {
  if (isConfiguredValue(value)) return value.configured ? 'configured' : 'not configured'
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  return Number.isInteger(value) ? String(value) : value.toFixed(4).replace(/0+$/, '').replace(/\.$/, '')
}

function presenceTransition(before: boolean, after: boolean): string {
  if (before === after) return before ? 'present → present' : 'absent → absent'
  return before ? 'present → absent' : 'absent → present'
}

function shortHash(value: string, length = 12): string {
  return value.length <= length ? value : `${value.slice(0, length)}…`
}

function formatBytes(bytes: number): string {
  if (bytes < 1_024) return `${bytes} B`
  if (bytes < 1_024 ** 2) return `${(bytes / 1_024).toFixed(1)} KiB`
  return `${(bytes / 1_024 ** 2).toFixed(2)} MiB`
}
