import { useEffect, useMemo, useRef, useState } from 'react'
import {
  Archive, Check, Download, FileArchive, LockKeyhole, RefreshCw,
  ShieldCheck, TriangleAlert, Undo2, Upload
} from 'lucide-react'
import { api, ApiError, sha256ArrayBuffer } from './api'
import { relativeTime } from './format'
import { createUiRequestId } from './request-id'
import type {
  BackupCatalogItem, SavePairExportReceipt, SavePairImportReceipt,
  SavePairTransferDownload, SessionUser
} from './model'

type TransferGate = 'server-enforced' | 'accepted' | 'fail-closed'
type ExportPhase = 'idle' | 'preparing' | 'prepared' | 'downloading' | 'downloaded' | 'cancelled' | 'error'
type ImportPhase = 'idle' | 'selected' | 'reading' | 'hashing' | 'uploading' | 'quarantined' | 'cancelled' | 'error'

const maximumArchiveBytes = 16 * 1024 * 1024 * 1024
const savePairExtension = '.dyson-save-pair'

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
  const [dragging, setDragging] = useState(false)
  const fileInputRef = useRef<HTMLInputElement | null>(null)
  const exportAbortRef = useRef<AbortController | null>(null)
  const importAbortRef = useRef<AbortController | null>(null)
  const exportSequenceRef = useRef(0)
  const importSequenceRef = useRef(0)
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
    if (objectUrlRef.current) URL.revokeObjectURL(objectUrlRef.current)
    exportSequenceRef.current += 1
    importSequenceRef.current += 1
  }, [])

  const selectedBackup = verifiedBackups.find((backup) => backup.backupId === selectedBackupId) ?? null
  const exportBusy = exportPhase === 'preparing' || exportPhase === 'downloading'
  const importBusy = importPhase === 'reading' || importPhase === 'hashing' || importPhase === 'uploading'

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
    } catch (reason) {
      if (sequence !== importSequenceRef.current || isAbortError(reason)) return
      setImportPhase('error')
      setImportError(formatTransferError(reason, '传输制品未能进入隔离区。'))
      if (isFailClosedFailure(reason)) setGate('fail-closed')
    } finally {
      if (importAbortRef.current === controller) importAbortRef.current = null
    }
  }

  function requestServerDecisionAgain(): void {
    setGate('server-enforced')
    setExportError('')
    setImportError('')
    if (exportPhase === 'error') setExportPhase(exportReceipt ? 'prepared' : 'idle')
    if (importPhase === 'error') setImportPhase(selectedFile ? 'selected' : 'idle')
  }

  if (!canTransfer) {
    return <section className="save-transfer-workspace readonly">
      <header><div><Archive size={18} /><span><strong>跨机器配对存档传输</strong><small>固定媒体类型 · 内容寻址 · 隔离区导入</small></span></div><b>ADMINISTRATOR ONLY</b></header>
      <div className="save-transfer-readonly"><LockKeyhole size={24} /><span><strong>{user.role === 'viewer' ? 'Viewer 只读说明' : 'Operator 只读说明'}</strong><small>跨机器导出会复制完整存档制品，导入会写入服务器隔离区，因此仅 Administrator 且拥有 saves.transfer 权限时显示操作控件。恢复仍是另一条独立停服事务。</small></span></div>
      <footer><ShieldCheck size={14} />此页面不会向浏览器暴露或提交服务器路径、URL、命令、Steam 状态或存档散件。</footer>
    </section>
  }

  const gateLabel = gate === 'fail-closed' ? 'FAIL-CLOSED' : gate === 'accepted' ? 'SERVER ACCEPTED' : 'DEFAULT CLOSED'
  const gateDetail = gate === 'fail-closed' ? '403 / 423 / 503 后本地控件已锁定'
    : gate === 'accepted' ? '最近一次请求已由服务端校验' : '每次操作由服务端权限与配置最终裁决'

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

    <div className="save-transfer-boundaries">
      <div><ShieldCheck size={17} /><span><strong>导出来源固定</strong><small>只能从当前目录中已验证的 backupId 选择，不能输入服务器路径。</small></span></div>
      <div><FileArchive size={17} /><span><strong>传输格式固定</strong><small>浏览器下载统一命名为 .dyson-save-pair，线级媒体类型由协议固定。</small></span></div>
      <div><Archive size={17} /><span><strong>导入只到隔离区</strong><small>服务端验证 archive、manifest、双文件身份和 SHA-256 后发布到 inbox。</small></span></div>
      <div><Undo2 size={17} /><span><strong>恢复是另一事务</strong><small>仍需停服、revision、保护点和独立确认；本工作区没有恢复动作。</small></span></div>
    </div>
    <footer><ShieldCheck size={14} />浏览器不会提交服务器路径、URL、命令、可执行文件、凭据或单独的 `.dsv` / `.server`；取消只终止浏览器等待，幂等 request ID 用于安全核对重复请求。</footer>
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
