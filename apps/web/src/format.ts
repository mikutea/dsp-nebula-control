export function formatDuration(milliseconds: number | null): string {
  if (milliseconds === null) return '—'
  if (milliseconds < 1000) return `${milliseconds} ms`
  return `${(milliseconds / 1000).toFixed(1)} s`
}

export function relativeTime(iso: string | null, now = Date.now()): string {
  if (!iso) return '未知'
  const seconds = Math.max(0, Math.round((now - new Date(iso).getTime()) / 1000))
  if (seconds < 60) return `${seconds} 秒前`
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes} 分钟前`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours} 小时前`
  return `${Math.round(hours / 24)} 天前`
}
