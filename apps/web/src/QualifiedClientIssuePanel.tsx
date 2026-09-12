import { useEffect, useRef, useState } from 'react'
import { Check, Download, KeyRound, LockKeyhole, PackageCheck, ShieldCheck, TriangleAlert } from 'lucide-react'
import { api, ApiError } from './api'
import type {
  QualifiedClientArtifactDownload,
  QualifiedClientArtifactKind,
  QualifiedClientProfileIssueReference
} from './model'

const qualificationIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '未知大小'
  if (bytes < 1024) return `${bytes} B`
  const units = ['KiB', 'MiB', 'GiB']
  let value = bytes / 1024
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit += 1 }
  return `${value >= 10 ? value.toFixed(0) : value.toFixed(1)} ${units[unit]}`
}

const artifactLabels: Record<QualifiedClientArtifactKind, { title: string; detail: string }> = {
  profile: { title: '配置资料包', detail: '连接资料、模组锁与校验清单' },
  client: { title: '客户端运行包', detail: '资格绑定并重新验真的 Nebula 客户端制品' },
  runtime: { title: '运行时清单', detail: '连接、二进制和策略摘要' }
}

export function QualifiedClientIssuePanel({ canGenerate }: { canGenerate: boolean }) {
  const [qualificationId, setQualificationId] = useState('')
  const [issued, setIssued] = useState<QualifiedClientProfileIssueReference | null>(null)
  const [issuing, setIssuing] = useState(false)
  const [downloading, setDownloading] = useState<QualifiedClientArtifactKind | null>(null)
  const [downloads, setDownloads] = useState<Partial<Record<QualifiedClientArtifactKind, Omit<QualifiedClientArtifactDownload, 'blob'>>>>({})
  const [error, setError] = useState('')
  const objectUrls = useRef(new Set<string>())

  useEffect(() => () => {
    for (const url of objectUrls.current) URL.revokeObjectURL(url)
    objectUrls.current.clear()
  }, [])

  function updateQualificationId(value: string): void {
    setQualificationId(value.trim().toLowerCase())
    setIssued(null)
    setDownloads({})
    setError('')
  }

  async function issue(): Promise<void> {
    if (!canGenerate || !qualificationIdPattern.test(qualificationId)) return
    setIssuing(true)
    setError('')
    try {
      const response = await api.issueQualifiedClientProfile({ schemaVersion: 2, qualificationId })
      setIssued(response.data)
      setDownloads({})
    } catch (reason) {
      setError(reason instanceof ApiError
        ? `${reason.message}${reason.code ? ` · ${reason.code}` : ''}`
        : '生产资格签发失败；资格标识仍保留在当前页面。')
    } finally {
      setIssuing(false)
    }
  }

  async function download(kind: QualifiedClientArtifactKind): Promise<void> {
    if (!canGenerate || !issued) return
    const expected = kind === 'profile'
      ? issued.archive
      : kind === 'client'
        ? issued.metadata.artifacts.qualifiedClientPayload
        : issued.metadata.artifacts.qualifiedRuntime
    setDownloading(kind)
    setError('')
    try {
      const result = await api.downloadQualifiedClientArtifact(
        issued.downloadId,
        kind,
        { sha256: expected.sha256, sizeBytes: expected.sizeBytes }
      )
      const url = URL.createObjectURL(result.blob)
      objectUrls.current.add(url)
      const link = document.createElement('a')
      link.href = url
      link.download = result.fileName
      link.rel = 'noopener'
      document.body.append(link)
      link.click()
      link.remove()
      const { blob: _blob, ...receipt } = result
      setDownloads((current) => ({ ...current, [kind]: receipt }))
    } catch (reason) {
      setError(reason instanceof ApiError
        ? `${reason.message}${reason.code ? ` · ${reason.code}` : ''}`
        : '资格客户端制品下载失败；签发回执仍保留在当前页面。')
    } finally {
      setDownloading(null)
    }
  }

  const validQualificationId = qualificationIdPattern.test(qualificationId)

  return <section className="qualified-client-panel" aria-labelledby="qualified-client-title">
    <header className="qualified-client-header">
      <div><span className="qualified-client-mark"><ShieldCheck size={19} /></span><span><strong id="qualified-client-title">生产资格签发</strong><small>只有已完成 Hostname/WSS、真实加入与客户端一致性证明的资格才能生成可下载制品。</small></span></div>
      <b>{issued ? 'QUALIFIED' : 'GATED'}</b>
    </header>

    {!canGenerate && <div className="qualified-client-lock"><LockKeyhole size={15} /><span>当前角色只能查看资格签发边界。</span></div>}

    <div className="qualified-client-input-row">
      <label htmlFor="qualified-client-id"><KeyRound size={14} />资格 ID</label>
      <input id="qualified-client-id" aria-label="生产资格 ID" value={qualificationId}
        placeholder="00000000-0000-0000-0000-000000000000" spellCheck={false} autoComplete="off"
        onChange={(event) => updateQualificationId(event.currentTarget.value)} />
      <button type="button" onClick={() => void issue()}
        disabled={!canGenerate || !validQualificationId || issuing || downloading !== null}>
        <PackageCheck className={issuing ? 'spin' : ''} size={15} />
        {issuing ? '签发校验中…' : '签发客户端套件'}
      </button>
    </div>
    <p className="qualified-client-warning">签发会原子消费受保护资格；重复提交同一绑定只返回同一下载标识，不会绕过重放门禁。</p>

    {error && <div className="qualified-client-error" role="alert"><TriangleAlert size={15} /><span>{error}</span></div>}

    {issued && <div className="qualified-client-result">
      <div className="qualified-client-summary">
        <div><span>PROFILE</span><strong>{issued.metadata.profile.displayName}</strong><small>{issued.metadata.profile.profileId}</small></div>
        <div><span>连接地址</span><strong>{issued.metadata.profile.connection.displayAddress}</strong><small>WSS · HOSTNAME PRESERVED</small></div>
        <div><span>运行时</span><strong>DSP {issued.metadata.profile.runtime.dsp}</strong><small>Nebula {issued.metadata.profile.runtime.nebula} · BepInEx {issued.metadata.profile.runtime.bepInEx}</small></div>
        <div><span>资格有效期</span><strong>{new Date(issued.expiresAtUtc).toLocaleString()}</strong><small>{issued.bindingSha256.slice(0, 23)}…</small></div>
      </div>

      <div className="qualified-client-artifacts">
        {(['profile', 'client', 'runtime'] as const).map((kind) => {
          const metadata = kind === 'profile' ? issued.archive
            : kind === 'client' ? issued.metadata.artifacts.qualifiedClientPayload
              : issued.metadata.artifacts.qualifiedRuntime
          const receipt = downloads[kind]
          return <article key={kind}>
            <div><strong>{artifactLabels[kind].title}</strong><small>{artifactLabels[kind].detail}</small></div>
            <code>{formatBytes(metadata.sizeBytes)} · {metadata.sha256.replace('sha256:', '').slice(0, 12)}…</code>
            <button type="button" onClick={() => void download(kind)}
              disabled={!canGenerate || downloading !== null}>
              {receipt ? <Check size={14} /> : <Download className={downloading === kind ? 'spin' : ''} size={14} />}
              {downloading === kind ? '下载校验中…' : receipt ? '重新下载' : '下载'}
            </button>
          </article>
        })}
      </div>

      <div className="qualified-client-receipt" aria-live="polite">
        <Check size={15} /><span><strong>签发回执已持久化</strong><small>下载 ID {issued.downloadId} · 收据 {issued.issueReceiptSha256.slice(0, 23)}…</small></span>
      </div>
    </div>}
  </section>
}
