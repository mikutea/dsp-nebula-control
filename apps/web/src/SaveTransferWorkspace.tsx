import { useEffect, useMemo, useRef, useState } from 'react'
import {
  Archive, ArrowRight, Check, Database, Download, FileArchive, HardDrive,
  LockKeyhole, RefreshCw, ShieldCheck, TriangleAlert, Undo2, Upload
} from 'lucide-react'
import { api, ApiError, SAVE_PAIR_PROMOTION_CONFIRMATION, sha256ArrayBuffer } from './api'
import { relativeTime } from './format'
import { createUiRequestId } from './request-id'
import type {
  BackupCatalogItem, SavePairExportReceipt, SavePairImportReceipt,
  SavePairPromotionPlan, SavePairPromotionReceipt, SavePairTransferDownload, SessionUser
} from './model'

type TransferGate = 'server-enforced' | 'accepted' | 'fail-closed'
type ExportPhase = 'idle' | 'preparing' | 'prepared' | 'downloading' | 'downloaded' | 'cancelled' | 'error'
type ImportPhase = 'idle' | 'selected' | 'reading' | 'hashing' | 'uploading' | 'quarantined' | 'cancelled' | 'error'
type PromotionPhase = 'idle' | 'previewing' | 'previewed' | 'executing' | 'completed' | 'cancelled' | 'error'

const maximumArchiveBytes = 16 * 1024 * 1024 * 1024
const savePairExtension = '.dyson-save-pair'
const promotionUuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

export function SaveTransferWorkspace({ backups, user }: {
  backups: BackupCatalogItem[]
  user: SessionUser
}) {
  const canTransfer = user.role === 'administrator' && user.permissions.includes('saves.transfer')
  const verifiedBackups = useMemo(() => backups.filter(isVerifiedBackup), [backups])
  const [gate, setGate] = useState<TransferGate>('server-enforced')
  const [selectedBackupId, setSelectedBackupId] = useState('')
  const [exportRequestId, setExportRequestId] = useState(() => createUiRequestId())
  const [exportReceipt, setExportReceipt] = useState<SavePairExportReceipt | null>(null)
  const [download, setDownload] = useState<SavePairTransferDownload | null>(null)
  const [exportPhase, setExportPhase] = useState<ExportPhase>('idle')
  const [exportError, setExportError] = useState('')
  const [selectedFile, setSelectedFile] = useState<File | null>(null)
  const [importRequestId, setImportRequestId] = useState(() => createUiRequestId())
  const [importSha256, setImportSha256] = useState('')
  const [importReceipt, setImportReceipt] = useState<SavePairImportReceipt | null>(null)
  const [importPhase, setImportPhase] = useState<ImportPhase>('idle')
  const [importError, setImportError] = useState('')
  const [promotionGate, setPromotionGate] = useState<TransferGate>('server-enforced')
  const [promotionImportRequestId, setPromotionImportRequestId] = useState('')
  const [promotionRequestId, setPromotionRequestId] = useState('')
  const [promotionPlan, setPromotionPlan] = useState<SavePairPromotionPlan | null>(null)
  const [promotionReceipt, setPromotionReceipt] = useState<SavePairPromotionReceipt | null>(null)
  const [promotionConfirmation, setPromotionConfirmation] = useState('')
  const [promotionPhase, setPromotionPhase] = useState<PromotionPhase>('idle')
  const [promotionError, setPromotionError] = useState('')
  const [dragging, setDragging] = useState(false)
  const fileInputRef = useRef<HTMLInputElement | null>(null)
  const exportAbortRef = useRef<AbortController | null>(null)
  const importAbortRef = useRef<AbortController | null>(null)
  const promotionAbortRef = useRef<AbortController | null>(null)
  const exportSequenceRef = useRef(0)
  const importSequenceRef = useRef(0)
  const promotionSequenceRef = useRef(0)
  const promotionBusyRef = useRef(false)
  const objectUrlRef = useRef<string | null>(null)

  useEffect(() => {
    if (selectedBackupId && verifiedBackups.some((backup) => backup.backupId === selectedBackupId)) return
    setSelectedBackupId(verifiedBackups[0]?.backupId ?? '')
    setExportReceipt(null)
    setDownload(null)
    setExportPhase('idle')
    setExportRequestId(createUiRequestId())
  }, [selectedBackupId, verifiedBackups])

  useEffect(() => () => {
    exportAbortRef.current?.abort()
    importAbortRef.current?.abort()
    promotionAbortRef.current?.abort()
    if (objectUrlRef.current) URL.revokeObjectURL(objectUrlRef.current)
    exportSequenceRef.current += 1
    importSequenceRef.current += 1
    promotionSequenceRef.current += 1
    promotionBusyRef.current = false
  }, [])

  const selectedBackup = verifiedBackups.find((backup) => backup.backupId === selectedBackupId) ?? null
  const exportBusy = exportPhase === 'preparing' || exportPhase === 'downloading'
  const importBusy = importPhase === 'reading' || importPhase === 'hashing' || importPhase === 'uploading'
  const promotionBusy = promotionPhase === 'previewing' || promotionPhase === 'executing'
  const promotionLocked = gate === 'fail-closed' || promotionGate === 'fail-closed'

  function resetExport(newRequestId = true): void {
    exportAbortRef.current?.abort()
    exportSequenceRef.current += 1
    setExportRequestId((current) => newRequestId ? createUiRequestId() : current)
    setExportReceipt(null)
    setDownload(null)
    setExportPhase('idle')
    setExportError('')
  }

  function cancelExport(): void {
    exportAbortRef.current?.abort()
    exportSequenceRef.current += 1
    setExportPhase('cancelled')
    setExportError('已取消浏览器等待；服务器可能已经完成同一 request ID，可安全幂等重试。')
  }

  async function prepareExport(): Promise<void> {
    if (!canTransfer || gate === 'fail-closed' || !selectedBackup) return
    const sequence = ++exportSequenceRef.current
    const controller = new AbortController()
    exportAbortRef.current?.abort()
    exportAbortRef.current = controller
    setExportPhase('preparing')
    setExportError('')
    setDownload(null)
    try {
      const result = await api.prepareSavePairExport(exportRequestId, selectedBackup.backupId, controller.signal)
      if (sequence !== exportSequenceRef.current) return
      setExportReceipt(result.data)
      setExportPhase('prepared')
      setGate('accepted')
    } catch (reason) {
      if (sequence !== exportSequenceRef.current || isAbortError(reason)) return
      setExportPhase('error')
      setExportError(formatTransferError(reason, '配对存档导出创建失败。'))
      if (isFailClosedFailure(reason)) setGate('fail-closed')
    } finally {
      if (exportAbortRef.current === controller) exportAbortRef.current = null
    }
  }

  async function downloadExport(): Promise<void> {
    if (!canTransfer || gate === 'fail-closed' || !exportReceipt) return
    const sequence = ++exportSequenceRef.current
    const controller = new AbortController()
    exportAbortRef.current?.abort()
    exportAbortRef.current = controller
    setExportPhase('downloading')
    setExportError('')
    try {
      const result = await api.downloadSavePairExport(exportReceipt.requestId, exportReceipt, controller.signal)
      if (sequence !== exportSequenceRef.current) return
      if (objectUrlRef.current) URL.revokeObjectURL(objectUrlRef.current)
      const objectUrl = URL.createObjectURL(result.blob)
      objectUrlRef.current = objectUrl
      const anchor = document.createElement('a')
      anchor.href = objectUrl
      anchor.download = result.fileName
      anchor.click()
      setDownload(result)
      setExportPhase('downloaded')
      setGate('accepted')
    } catch (reason) {
      if (sequence !== exportSequenceRef.current || isAbortError(reason)) return
      setExportPhase('error')
      setExportError(formatTransferError(reason, '导出制品下载或浏览器完整性复核失败。'))
      if (isFailClosedFailure(reason) || (reason instanceof ApiError && reason.status === 502)) {
        setGate('fail-closed')
      }
    } finally {
      if (exportAbortRef.current === controller) exportAbortRef.current = null
    }
  }

  function resetImport(newRequestId = true): void {
    importAbortRef.current?.abort()
    importSequenceRef.current += 1
    setImportRequestId((current) => newRequestId ? createUiRequestId() : current)
    setImportSha256('')
    setImportReceipt(null)
    setImportPhase(selectedFile ? 'selected' : 'idle')
    setImportError('')
  }

  function cancelImport(): void {
    importAbortRef.current?.abort()
    importSequenceRef.current += 1
    setImportPhase('cancelled')
    setImportError('已取消浏览器读取或上传；已发送的字节不能撤回，同一 request ID 可用于幂等核对。')
  }

  function selectFiles(files: FileList | readonly File[]): void {
    if (!canTransfer || gate === 'fail-closed') return
    if (files.length !== 1) {
      setImportError('一次只能选择一个配对存档传输制品。')
      return
    }
    const file = files[0]
    if (!file) return
    if (!file.name.toLowerCase().endsWith(savePairExtension)) {
      setImportError(`只接受 ${savePairExtension} 文件；不会读取 ZIP、存档散件或可执行文件。`)
      return
    }
    if (!Number.isSafeInteger(file.size) || file.size < 1 || file.size > maximumArchiveBytes) {
      setImportError('传输制品必须大于 0 B 且不超过 16 GiB。')
      return
    }
    importAbortRef.current?.abort()
    importSequenceRef.current += 1
    setSelectedFile(file)
    setImportRequestId(createUiRequestId())
    setImportSha256('')
    setImportReceipt(null)
    setImportPhase('selected')
    setImportError('')
  }

  async function uploadImport(): Promise<void> {
    if (!canTransfer || gate === 'fail-closed' || !selectedFile) return
    const sequence = ++importSequenceRef.current
    const controller = new AbortController()
    importAbortRef.current?.abort()
    importAbortRef.current = controller
    setImportPhase('reading')
    setImportError('')
    setImportReceipt(null)
    try {
      const payload = await selectedFile.arrayBuffer()
      if (sequence !== importSequenceRef.current || controller.signal.aborted) return
      setImportPhase('hashing')
      const sha256 = await sha256ArrayBuffer(payload)
      if (sequence !== importSequenceRef.current || controller.signal.aborted) return
      setImportSha256(sha256)
      setImportPhase('uploading')
      const result = await api.importSavePairArchive(importRequestId, payload, sha256, controller.signal)
      if (sequence !== importSequenceRef.current) return
      setImportReceipt(result.data)
      setImportPhase('quarantined')
      setGate('accepted')
      resetPromotionEvidence()
      setPromotionImportRequestId(result.data.requestId)
    } catch (reason) {
      if (sequence !== importSequenceRef.current || isAbortError(reason)) return
      setImportPhase('error')
      setImportError(formatTransferError(reason, '传输制品未能进入隔离区。'))
      if (isFailClosedFailure(reason)) setGate('fail-closed')
    } finally {
      if (importAbortRef.current === controller) importAbortRef.current = null
    }
  }

  function resetPromotionEvidence(clearImport = false): void {
    promotionAbortRef.current?.abort()
    promotionAbortRef.current = null
    promotionSequenceRef.current += 1
    promotionBusyRef.current = false
    if (clearImport) setPromotionImportRequestId('')
    setPromotionRequestId('')
    setPromotionPlan(null)
    setPromotionReceipt(null)
    setPromotionConfirmation('')
    setPromotionPhase('idle')
    setPromotionError('')
  }

  function updatePromotionImportRequestId(value: string): void {
    resetPromotionEvidence()
    setPromotionImportRequestId(value.toLowerCase())
  }

  async function previewPromotion(): Promise<void> {
    if (!canTransfer || promotionLocked || promotionBusyRef.current) return
    const normalizedImportRequestId = promotionImportRequestId.trim().toLowerCase()
    if (promotionImportRequestId !== promotionImportRequestId.trim() ||
        !promotionUuidPattern.test(normalizedImportRequestId)) {
      setPromotionPhase('error')
      setPromotionError('只接受隔离导入回执中的完整 import request UUID；不会提交路径、URL 或命令。')
      return
    }
    const requestId = createUiRequestId().toLowerCase()
    const sequence = ++promotionSequenceRef.current
    const controller = new AbortController()
    promotionAbortRef.current?.abort()
    promotionAbortRef.current = controller
    promotionBusyRef.current = true
    setPromotionImportRequestId(normalizedImportRequestId)
    setPromotionRequestId(requestId)
    setPromotionPlan(null)
    setPromotionReceipt(null)
    setPromotionConfirmation('')
    setPromotionPhase('previewing')
    setPromotionError('')
    try {
      const result = await api.previewSavePairPromotion(requestId, normalizedImportRequestId, controller.signal)
      if (sequence !== promotionSequenceRef.current) return
      setPromotionPlan(result.data)
      setPromotionPhase('previewed')
      setPromotionGate('accepted')
    } catch (reason) {
      if (sequence !== promotionSequenceRef.current || isAbortError(reason)) return
      setPromotionPhase('error')
      setPromotionError(formatTransferError(reason, '隔离存档晋升预演失败。'))
      if (isPromotionFailClosedFailure(reason)) setPromotionGate('fail-closed')
    } finally {
      if (sequence === promotionSequenceRef.current) promotionBusyRef.current = false
      if (promotionAbortRef.current === controller) promotionAbortRef.current = null
    }
  }

  async function executePromotion(): Promise<void> {
    if (!canTransfer || promotionLocked || promotionBusyRef.current || !promotionPlan ||
        promotionConfirmation !== SAVE_PAIR_PROMOTION_CONFIRMATION || !promotionPlan.allowed ||
        !promotionPlan.executionEnabled) return
    if (promotionImportRequestId.trim().toLowerCase() !== promotionPlan.importRequestId) {
      setPromotionConfirmation('')
      setPromotionPhase('error')
      setPromotionError('隔离 import UUID 已变化；旧预演已失效，请重新生成。')
      return
    }

    const expected = promotionPlan
    const sequence = ++promotionSequenceRef.current
    const controller = new AbortController()
    promotionAbortRef.current?.abort()
    promotionAbortRef.current = controller
    promotionBusyRef.current = true
    setPromotionPhase('executing')
    setPromotionError('')
    try {
      const refreshed = (await api.previewSavePairPromotion(
        expected.requestId,
        expected.importRequestId,
        controller.signal
      )).data
      if (sequence !== promotionSequenceRef.current) return
      if (!samePromotionPlan(expected, refreshed)) {
        setPromotionPlan(refreshed)
        setPromotionConfirmation('')
        setPromotionPhase('previewed')
        setPromotionGate('accepted')
        setPromotionError('执行前的零写入预演证据已变化；确认词已清空，请核对新目标、哈希和空间后重新确认。')
        return
      }
      const receipt = (await api.executeSavePairPromotion(
        refreshed.requestId,
        refreshed.importRequestId,
        SAVE_PAIR_PROMOTION_CONFIRMATION,
        controller.signal
      )).data
      if (sequence !== promotionSequenceRef.current) return
      if (!promotionReceiptMatchesPlan(receipt, refreshed)) {
        throw new ApiError(502, '晋升回执与刚刚复核的预演证据不一致。', 'SAVE_PROMOTION_RECEIPT_MISMATCH')
      }
      setPromotionPlan(refreshed)
      setPromotionReceipt(receipt)
      setPromotionConfirmation('')
      setPromotionPhase('completed')
      setPromotionGate('accepted')
    } catch (reason) {
      if (sequence !== promotionSequenceRef.current || isAbortError(reason)) return
      setPromotionPhase('error')
      setPromotionError(formatTransferError(reason, '隔离存档未能晋升为已验证保护点。'))
      if (isPromotionFailClosedFailure(reason)) setPromotionGate('fail-closed')
    } finally {
      if (sequence === promotionSequenceRef.current) promotionBusyRef.current = false
      if (promotionAbortRef.current === controller) promotionAbortRef.current = null
    }
  }

  function cancelPromotion(): void {
    promotionAbortRef.current?.abort()
    promotionAbortRef.current = null
    promotionSequenceRef.current += 1
    promotionBusyRef.current = false
    setPromotionConfirmation('')
    setPromotionPhase('cancelled')
    setPromotionError('已取消浏览器等待；如执行请求已经送达，请用同一 request ID 核对幂等回执，不要生成恢复动作。')
  }

  function requestServerDecisionAgain(): void {
    setGate('server-enforced')
    setPromotionGate('server-enforced')
    setExportError('')
    setImportError('')
    setPromotionError('')
    if (exportPhase === 'error') setExportPhase(exportReceipt ? 'prepared' : 'idle')
    if (importPhase === 'error') setImportPhase(selectedFile ? 'selected' : 'idle')
    if (promotionPhase === 'error') setPromotionPhase(promotionPlan ? 'previewed' : 'idle')
  }

  if (!canTransfer) {
    return <section className="save-transfer-workspace readonly">
      <header><div><Archive size={18} /><span><strong>跨机器配对存档传输</strong><small>固定媒体类型 · 隔离导入 · 已验证保护点晋升</small></span></div><b>ADMINISTRATOR ONLY</b></header>
      <div className="save-transfer-readonly"><LockKeyhole size={24} /><span><strong>{user.role === 'viewer' ? 'Viewer 只读说明' : 'Operator 只读说明'}</strong><small>跨机器导出会复制完整存档制品，导入会写入服务器隔离区，晋升会创建新的已验证保护点；因此仅 Administrator 且拥有 saves.transfer 权限时显示操作控件。任何一步都不会恢复或覆盖 live save。</small></span></div>
      <footer><ShieldCheck size={14} />此页面不会向浏览器暴露或提交服务器路径、URL、命令、Steam 状态或存档散件。</footer>
    </section>
  }

  const gateLabel = gate === 'fail-closed' ? 'FAIL-CLOSED' : gate === 'accepted' ? 'SERVER ACCEPTED' : 'DEFAULT CLOSED'
  const gateDetail = gate === 'fail-closed' ? '403 / 423 / 503 后本地控件已锁定'
    : gate === 'accepted' ? '最近一次请求已由服务端校验' : '每次操作由服务端权限与配置最终裁决'
  const promotionGateLabel = promotionLocked ? 'FAIL-CLOSED'
    : promotionGate === 'accepted' ? 'SERVER ACCEPTED' : 'PREVIEW ONLY'
  const promotionGateDetail = promotionLocked ? '403 / 423 后晋升控件已锁定'
    : promotionGate === 'accepted' ? '最近一次晋升预演已由服务端验证'
      : '预演零写入；执行仍由服务端开关裁决'

  return <section className="save-transfer-workspace">
    <header><div><Archive size={18} /><span><strong>跨机器配对存档传输</strong><small>verified backup → content-addressed artifact → quarantine inbox</small></span></div><b>ADMINISTRATOR · SAVES.TRANSFER</b></header>

    <div className="save-transfer-state-grid">
      <div className={gate === 'fail-closed' ? 'closed' : gate === 'accepted' ? 'accepted' : ''}><span>TRANSFER GATE</span><strong>{gateLabel}</strong><small>{gateDetail}</small></div>
      <div><span>VERIFIED BACKUPS</span><strong>{verifiedBackups.length}</strong><small>仅健康清单与完整 pair 可导出</small></div>
      <div><span>EXPORT REQUEST</span><strong>{shortId(exportRequestId)}</strong><small>{exportPhaseLabel(exportPhase)}</small></div>
      <div><span>IMPORT REQUEST</span><strong>{shortId(importRequestId)}</strong><small>{importPhaseLabel(importPhase)}</small></div>
    </div>

    {gate === 'fail-closed' && <div className="save-transfer-gate-lock"><LockKeyhole size={17} /><span><strong>传输已在浏览器侧 fail-closed</strong><small>这不会改变后端配置。确认权限、固定根目录或并发锁状态后，才可重新请求一次服务端裁决。</small></span><button type="button" onClick={requestServerDecisionAgain}><RefreshCw size={14} />重新请求服务端裁决</button></div>}

    <div className="save-transfer-lanes">
      <section className="save-transfer-lane export-lane">
        <header><div><Download size={17} /><span><strong>导出已验证保护点</strong><small>先创建不可变制品，再下载并在浏览器复核 SHA-256</small></span></div><b>OUTBOUND</b></header>
        {exportError && <div className="save-transfer-error" role="alert"><TriangleAlert size={15} />{exportError}</div>}
        <label className="transfer-backup-selector"><span>已验证 BACKUP ID</span><select aria-label="选择已验证导出备份" value={selectedBackupId} disabled={exportBusy || gate === 'fail-closed'} onChange={(event) => {
          setSelectedBackupId(event.target.value)
          resetExport(true)
        }}><option value="">选择一个健康保护点</option>{verifiedBackups.map((backup) => <option key={backup.backupId} value={backup.backupId}>{backup.saveName} · {backup.backupId}</option>)}</select></label>
        <div className="transfer-evidence-row"><span>REQUEST ID</span><code>{exportRequestId}</code><button type="button" disabled={exportBusy} onClick={() => resetExport(true)}><RefreshCw size={13} />新建 ID</button></div>
        <div className="transfer-source-card">{selectedBackup ? <><span className="source-mark"><ShieldCheck size={18} /></span><div><strong>{selectedBackup.saveName}</strong><small>{selectedBackup.backupId} · {formatBytes(selectedBackup.totalBytes)} · {relativeTime(selectedBackup.createdAt)}</small></div><b>MANIFEST + PAIR VERIFIED</b></> : <><span className="source-mark muted"><Archive size={18} /></span><div><strong>没有可导出的已验证保护点</strong><small>先在上方保护点目录执行校验；浏览器不接受手工 backup ID。</small></div></>}</div>
        <TransferProgress value={exportProgress(exportPhase)} label={exportPhaseLabel(exportPhase)} ariaLabel="导出阶段进度" />
        <div className="transfer-actions">
          <button type="button" onClick={() => void prepareExport()} disabled={!selectedBackup || exportBusy || gate === 'fail-closed'}><FileArchive size={15} />{exportReceipt ? '重新提交同一 request ID' : '创建已验证导出'}</button>
          <button type="button" onClick={() => void downloadExport()} disabled={!exportReceipt || exportBusy || gate === 'fail-closed'}><Download size={15} />下载 .dyson-save-pair</button>
          {exportBusy && <button type="button" className="cancel" onClick={cancelExport}>取消浏览器等待</button>}
        </div>
        {exportReceipt && <div className="transfer-receipt export"><header><Check size={15} /><strong>EXPORT RECEIPT</strong><span>{exportReceipt.reused ? '幂等复用' : '新制品'}</span></header><dl><div><dt>requestId</dt><dd>{exportReceipt.requestId}</dd></div><div><dt>archive length</dt><dd>{formatBytes(exportReceipt.archiveBytes)} · {exportReceipt.archiveBytes} B</dd></div><div><dt>SHA-256</dt><dd>{exportReceipt.archiveSha256}</dd></div><div><dt>restore</dt><dd>{exportReceipt.restoreExecuted ? '异常' : '未执行'}</dd></div></dl>{download && <p><Download size={14} />{download.fileName} 已交给浏览器 · {formatBytes(download.sizeBytes)} · SHA-256 已复核</p>}</div>}
      </section>

      <section className="save-transfer-lane import-lane">
        <header><div><Upload size={17} /><span><strong>导入到隔离区</strong><small>本地读取、SHA-256、固定媒体类型上传；不会直接恢复</small></span></div><b>INBOUND</b></header>
        {importError && <div className="save-transfer-error" role="alert"><TriangleAlert size={15} />{importError}</div>}
        <div className={`save-transfer-drop${dragging ? ' dragging' : ''}${selectedFile ? ' selected' : ''}`}
          onDragEnter={(event) => { event.preventDefault(); if (gate !== 'fail-closed') setDragging(true) }}
          onDragOver={(event) => { event.preventDefault(); if (gate !== 'fail-closed') setDragging(true) }}
          onDragLeave={(event) => { if (event.currentTarget === event.target) setDragging(false) }}
          onDrop={(event) => { event.preventDefault(); setDragging(false); selectFiles(event.dataTransfer.files) }}>
          <span className="transfer-file-orbit"><FileArchive size={22} /></span><div><strong>{selectedFile?.name ?? `选择 ${savePairExtension} 制品`}</strong><small>{selectedFile ? `${formatBytes(selectedFile.size)} · 浏览器内存 · 不落盘` : '单一配对制品 · 最大 16 GiB · 不接受 ZIP 或 .dsv/.server 散件'}</small></div><button type="button" disabled={importBusy || gate === 'fail-closed'} onClick={() => fileInputRef.current?.click()}>选择文件</button><input ref={fileInputRef} className="client-file-input" type="file" accept={savePairExtension} aria-label="选择配对存档传输制品" onChange={(event) => {
            const input = event.currentTarget
            if (input.files) selectFiles(input.files)
            input.value = ''
          }} />
        </div>
        <div className="transfer-evidence-row"><span>REQUEST ID</span><code>{importRequestId}</code><button type="button" disabled={importBusy} onClick={() => resetImport(true)}><RefreshCw size={13} />新建 ID</button></div>
        <div className="transfer-hash-card"><span>CLIENT SHA-256</span><code>{importSha256 || '读取 ArrayBuffer 后计算'}</code><small>固定 Blob 由浏览器自动生成 Content-Length，并发送 X-Dyson-Content-SHA256 与固定 media type</small></div>
        <TransferProgress value={importProgress(importPhase)} label={importPhaseLabel(importPhase)} ariaLabel="导入阶段进度" />
        <div className="transfer-actions">
          <button type="button" onClick={() => void uploadImport()} disabled={!selectedFile || importBusy || gate === 'fail-closed'}><Upload size={15} />{importReceipt ? '重新提交同一 request ID' : '校验并上传到隔离区'}</button>
          {importBusy && <button type="button" className="cancel" onClick={cancelImport}>取消浏览器任务</button>}
        </div>
        {importReceipt && <div className="transfer-receipt import"><header><Check size={15} /><strong>QUARANTINE RECEIPT</strong><span>{importReceipt.reused ? '幂等复用' : '新隔离制品'}</span></header><dl><div><dt>requestId</dt><dd>{importReceipt.requestId}</dd></div><div><dt>inboxId</dt><dd>{importReceipt.inboxId}</dd></div><div><dt>pair bytes</dt><dd>.dsv {formatBytes(importReceipt.dsvBytes)} + .server {formatBytes(importReceipt.serverBytes)}</dd></div><div><dt>SHA-256</dt><dd>{importReceipt.archiveSha256}</dd></div></dl><p><LockKeyhole size={14} />已进入 quarantine/inbox；restoreExecuted=false。这里不会显示恢复按钮。</p></div>}
      </section>
    </div>

    <section className={`save-promotion-panel${promotionLocked ? ' locked' : promotionReceipt ? ' completed' : ''}`}>
      <header><div><Database size={18} /><span><strong>隔离存档晋升为已验证保护点</strong><small>quarantine UUID → zero-write preview → immutable verified backup</small></span></div><b>{promotionGateLabel}</b></header>

      {promotionError && <div className={`save-promotion-alert${promotionLocked ? ' locked' : ''}`} role="alert"><TriangleAlert size={16} /><span><strong>{promotionPhase === 'cancelled' ? '浏览器等待已取消' : '晋升流程已停止'}</strong><small>{promotionError}</small></span></div>}
      {promotionLocked && <div className="save-promotion-lock"><LockKeyhole size={17} /><span><strong>晋升门禁已在浏览器侧锁闭</strong><small>{promotionGateDetail}。重新请求只会再次询问服务端，不会修改配置或绕过主机变更租约。</small></span><button type="button" onClick={requestServerDecisionAgain}><RefreshCw size={14} />重新请求服务端裁决</button></div>}

      <div className="save-promotion-flow" aria-label="存档晋升阶段">
        <article className={promotionImportRequestId ? 'ready' : ''}><span>01</span><div><strong>选择 IMPORT UUID</strong><small>只引用隔离导入回执，不接受服务器路径</small></div><Archive size={17} /></article>
        <ArrowRight size={15} />
        <article className={promotionPlan ? 'ready' : ''}><span>02</span><div><strong>零写入预演</strong><small>核对目标、来源哈希、空间、复用与执行开关</small></div><ShieldCheck size={17} /></article>
        <ArrowRight size={15} />
        <article className={promotionReceipt ? 'ready' : ''}><span>03</span><div><strong>发布 VERIFIED BACKUP</strong><small>原子发布新保护点；live save 与 inbox 保持不变</small></div><HardDrive size={17} /></article>
      </div>

      <div className="save-promotion-intent">
        <label><span>隔离导入 REQUEST UUID</span><input aria-label="隔离导入 request UUID" type="text" inputMode="text" autoComplete="off" spellCheck={false} maxLength={36} placeholder="00000000-0000-4000-8000-000000000000" value={promotionImportRequestId} disabled={promotionBusy || promotionLocked} onChange={(event) => updatePromotionImportRequestId(event.target.value)} /><small>{importReceipt?.requestId === promotionImportRequestId ? '已从本次 QUARANTINE RECEIPT 自动选择' : '可粘贴另一份已持久化导入回执的 UUID；不会读取路径'}</small></label>
        <div className="save-promotion-request"><span>PROMOTION REQUEST UUID</span><code>{promotionRequestId || '预演时由浏览器新建，不可编辑'}</code><small>每次重新生成预演都会使用新的 UUID；执行复核复用同一 UUID</small></div>
        <div className="save-promotion-intent-actions"><button type="button" disabled={!promotionImportRequestId || promotionBusy || promotionLocked} onClick={() => void previewPromotion()}><RefreshCw className={promotionPhase === 'previewing' ? 'spin' : ''} size={15} />{promotionPhase === 'previewing' ? '正在生成预演' : '生成零写入晋升预演'}</button>{promotionBusy && <button type="button" className="cancel" onClick={cancelPromotion}>取消晋升等待</button>}</div>
      </div>

      {!promotionPlan && !promotionReceipt && promotionPhase !== 'previewing' && <div className="save-promotion-empty"><ShieldCheck size={19} /><span><strong>只从隔离区创建新的验证保护点</strong><small>预演和执行都不会选择、覆盖或恢复 live save；源 quarantine/inbox 会完整保留。</small></span></div>}

      {promotionPlan && <div className="save-promotion-preview">
        <header><div><ShieldCheck size={16} /><span><strong>DRY-RUN · ZERO WRITE</strong><small>{promotionPlan.saveName} · 服务端固定目标</small></span></div><b>{promotionPlan.allowed ? promotionPlan.executionEnabled ? 'EXECUTION READY' : 'DEFAULT OFF' : 'BLOCKED'}</b></header>
        <dl>
          <div><dt>destinationBackupId</dt><dd>{promotionPlan.backupId}</dd></div>
          <div><dt>source archive SHA-256</dt><dd>{promotionPlan.sourceArchiveSha256}</dd></div>
          <div><dt>pair bytes</dt><dd>.dsv {formatBytes(promotionPlan.dsvBytes)} + .server {formatBytes(promotionPlan.serverBytes)}</dd></div>
          <div><dt>space</dt><dd>{formatBytes(promotionPlan.requiredBytes)} required · {promotionPlan.availableBytes === null ? 'unavailable / reused' : `${formatBytes(promotionPlan.availableBytes)} available`}</dd></div>
          <div><dt>manifest</dt><dd>{promotionPlan.effects.verifiedBackupCreated ? '执行时生成并验证 canonical manifest' : '已验证目标 manifest，允许幂等复用'}</dd></div>
          <div><dt>reuse</dt><dd>{promotionPlan.reused ? '是 · 不再复制 pair' : '否 · 将原子发布新目录'}</dd></div>
        </dl>
        <div className="save-promotion-effects">
          <span><Check size={14} /><strong>INBOX 保留</strong><small>quarantinePreserved=true</small></span>
          <span><Check size={14} /><strong>LIVE SAVE 不变</strong><small>liveSaveChanged=false</small></span>
          <span><Check size={14} /><strong>不会执行恢复</strong><small>restoreExecuted=false</small></span>
          <span className={promotionPlan.executionEnabled && promotionPlan.allowed ? 'ready' : 'blocked'}>{promotionPlan.executionEnabled && promotionPlan.allowed ? <Check size={14} /> : <LockKeyhole size={14} />}<strong>{promotionPlan.executionEnabled ? promotionPlan.allowed ? '执行门禁已满足' : '空间门禁未满足' : '执行默认关闭'}</strong><small>{promotionPlan.blockers.length ? promotionPlan.blockers.map(promotionBlockerLabel).join(' · ') : '无空间阻断项'}</small></span>
        </div>
        {!promotionReceipt && <div className="save-promotion-confirmation">
          <div><LockKeyhole size={16} /><span><strong>执行前会重新运行同一零写入预演</strong><small>目标、哈希、空间、复用或门禁任一变化都会清空确认并停止执行。</small></span></div>
          <label><span>输入精确确认词 <code>{SAVE_PAIR_PROMOTION_CONFIRMATION}</code></span><input aria-label="输入存档晋升确认词" type="text" autoComplete="off" spellCheck={false} value={promotionConfirmation} disabled={promotionBusy || promotionLocked || !promotionPlan.allowed || !promotionPlan.executionEnabled} onChange={(event) => setPromotionConfirmation(event.target.value)} /></label>
          <button type="button" disabled={promotionConfirmation !== SAVE_PAIR_PROMOTION_CONFIRMATION || promotionBusy || promotionLocked || !promotionPlan.allowed || !promotionPlan.executionEnabled} onClick={() => void executePromotion()}><Database size={15} />{promotionPhase === 'executing' ? '复核并发布中' : '确认晋升为已验证保护点'}</button>
        </div>}
      </div>}

      {promotionReceipt && <div className="save-promotion-receipt">
        <header><Check size={16} /><span><strong>VERIFIED BACKUP RECEIPT</strong><small>{promotionReceipt.reused ? '幂等复用既有保护点' : '新保护点已原子发布并重新读取验证'}</small></span><b>{relativeTime(promotionReceipt.completedAt)}</b></header>
        <dl><div><dt>backupId</dt><dd>{promotionReceipt.backupId}</dd></div><div><dt>manifest SHA-256</dt><dd>{promotionReceipt.manifestSha256}</dd></div><div><dt>source archive SHA-256</dt><dd>{promotionReceipt.sourceArchiveSha256}</dd></div><div><dt>pair bytes</dt><dd>.dsv {formatBytes(promotionReceipt.dsvBytes)} + .server {formatBytes(promotionReceipt.serverBytes)}</dd></div></dl>
        <footer><ShieldCheck size={15} /><span><strong>晋升完成，但没有恢复存档</strong><small>源 {promotionReceipt.inboxId} 仍保留；live save 未选择、未写入，restoreExecuted=false。</small></span><button type="button" onClick={() => resetPromotionEvidence(true)}>准备下一次晋升</button></footer>
      </div>}
    </section>

    <div className="save-transfer-boundaries">
      <div><ShieldCheck size={17} /><span><strong>导出来源固定</strong><small>只能从当前目录中已验证的 backupId 选择，不能输入服务器路径。</small></span></div>
      <div><FileArchive size={17} /><span><strong>传输格式固定</strong><small>浏览器下载统一命名为 .dyson-save-pair，线级媒体类型由协议固定。</small></span></div>
      <div><Archive size={17} /><span><strong>导入先到隔离区</strong><small>服务端验证 archive、manifest、双文件身份和 SHA-256 后发布到 inbox；晋升仍需独立预演和确认。</small></span></div>
      <div><Undo2 size={17} /><span><strong>恢复是另一事务</strong><small>仍需停服、revision、保护点和独立确认；本工作区没有恢复动作。</small></span></div>
    </div>
    <footer><ShieldCheck size={14} />浏览器不会提交服务器路径、URL、命令、可执行文件、凭据或单独的 `.dsv` / `.server`；晋升只引用 import UUID，且始终保留 inbox 与 live save。</footer>
  </section>
}

function TransferProgress({ value, label, ariaLabel }: { value: number; label: string; ariaLabel: string }) {
  return <div className="transfer-progress"><div><span>{label}</span><b>{value}%</b></div><progress aria-label={ariaLabel} value={value} max={100} /></div>
}

function isVerifiedBackup(backup: BackupCatalogItem): boolean {
  return backup.health === 'healthy' && backup.manifestPresent && backup.manifestValid && backup.pairPresent
}

function isFailClosedFailure(reason: unknown): boolean {
  return reason instanceof ApiError && [403, 423, 503].includes(reason.status)
}

function isPromotionFailClosedFailure(reason: unknown): boolean {
  return reason instanceof ApiError && [403, 423].includes(reason.status)
}

function samePromotionPlan(left: SavePairPromotionPlan, right: SavePairPromotionPlan): boolean {
  return JSON.stringify([
    left.format, left.schemaVersion, left.mode, left.requestId, left.importRequestId, left.inboxId,
    left.backupId, left.saveName, left.sourceArchiveSha256, left.dsvBytes, left.serverBytes,
    left.requiredBytes, left.availableBytes, left.allowed, left.blockers, left.reused,
    left.requiredConfirmation, left.effects.quarantinePreserved, left.effects.verifiedBackupCreated,
    left.effects.liveSaveChanged, left.effects.restoreExecuted, left.executionEnabled
  ]) === JSON.stringify([
    right.format, right.schemaVersion, right.mode, right.requestId, right.importRequestId, right.inboxId,
    right.backupId, right.saveName, right.sourceArchiveSha256, right.dsvBytes, right.serverBytes,
    right.requiredBytes, right.availableBytes, right.allowed, right.blockers, right.reused,
    right.requiredConfirmation, right.effects.quarantinePreserved, right.effects.verifiedBackupCreated,
    right.effects.liveSaveChanged, right.effects.restoreExecuted, right.executionEnabled
  ])
}

function promotionReceiptMatchesPlan(
  receipt: SavePairPromotionReceipt,
  plan: SavePairPromotionPlan
): boolean {
  return receipt.requestId === plan.requestId && receipt.importRequestId === plan.importRequestId &&
    receipt.inboxId === plan.inboxId && receipt.backupId === plan.backupId &&
    receipt.saveName === plan.saveName && receipt.sourceArchiveSha256 === plan.sourceArchiveSha256 &&
    receipt.dsvBytes === plan.dsvBytes && receipt.serverBytes === plan.serverBytes &&
    receipt.restoreExecuted === false && receipt.reused === plan.reused
}

function promotionBlockerLabel(blocker: SavePairPromotionPlan['blockers'][number]): string {
  return blocker === 'space-insufficient' ? '可用空间不足' : '无法读取可用空间'
}

function isAbortError(reason: unknown): boolean {
  return reason instanceof DOMException && reason.name === 'AbortError'
}

function formatTransferError(reason: unknown, fallback: string): string {
  if (!(reason instanceof ApiError)) return fallback
  return `${reason.message}${reason.code ? ` · ${reason.code}` : ''}`
}

function shortId(requestId: string): string {
  return `${requestId.slice(0, 8)}…${requestId.slice(-4)}`
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '—'
  if (bytes < 1_024) return `${bytes} B`
  if (bytes < 1_048_576) return `${(bytes / 1_024).toFixed(1)} KiB`
  if (bytes < 1_073_741_824) return `${(bytes / 1_048_576).toFixed(1)} MiB`
  return `${(bytes / 1_073_741_824).toFixed(2)} GiB`
}

function exportProgress(phase: ExportPhase): number {
  return ({ idle: 0, preparing: 28, prepared: 54, downloading: 78, downloaded: 100, cancelled: 0, error: 0 })[phase]
}

function importProgress(phase: ImportPhase): number {
  return ({ idle: 0, selected: 14, reading: 28, hashing: 48, uploading: 72, quarantined: 100, cancelled: 0, error: 0 })[phase]
}

function exportPhaseLabel(phase: ExportPhase): string {
  return ({
    idle: '等待选择已验证保护点', preparing: '服务器正在验证并创建导出', prepared: '导出回执就绪，等待下载',
    downloading: '下载并复核浏览器 SHA-256', downloaded: '下载完整性已复核',
    cancelled: '浏览器等待已取消', error: '导出阶段已停止'
  })[phase]
}

function importPhaseLabel(phase: ImportPhase): string {
  return ({
    idle: '等待本地传输制品', selected: '制品已选择，尚未读取', reading: '读取本地 ArrayBuffer',
    hashing: '浏览器计算 SHA-256', uploading: '固定媒体类型上传中', quarantined: '服务端隔离区已接收',
    cancelled: '浏览器任务已取消', error: '导入阶段已停止'
  })[phase]
}
