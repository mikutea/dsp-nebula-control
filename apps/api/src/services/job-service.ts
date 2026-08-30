import type {
  JobKind, JobRecord, LifecycleAction, LifecyclePreview, ServerStatus, StatusProvider
} from '../domain.js'
import { ControlDatabase } from '../storage/database.js'
import { EventHub } from './event-hub.js'

export class JobService {
  readonly #database: ControlDatabase
  readonly #provider: StatusProvider
  readonly #events: EventHub
  #latestStatus: ServerStatus | null = null
  #queue: Promise<void> = Promise.resolve()

  constructor(database: ControlDatabase, provider: StatusProvider, events: EventHub) {
    this.#database = database
    this.#provider = provider
    this.#events = events
  }

  latestStatus(): ServerStatus | null { return this.#latestStatus }
  listJobs(limit = 20): JobRecord[] { return this.#database.listJobs(limit) }
  getJob(id: string): JobRecord | null { return this.#database.getJob(id) }

  enqueueRefresh(actor: string): JobRecord {
    const job = this.#database.createJob('status.refresh', actor, '刷新服务器状态')
    this.#events.publish({ type: 'job.updated', data: job })
    this.#queue = this.#queue.then(() => this.#runRefresh(job)).catch(() => undefined)
    return job
  }

  async collectInitialStatus(): Promise<ServerStatus> {
    this.#latestStatus = await this.#provider.collectStatus()
    return this.#latestStatus
  }

  async previewLifecycle(action: LifecycleAction, actor: string): Promise<{ job: JobRecord; preview: LifecyclePreview }> {
    const kinds: Record<LifecycleAction, JobKind> = {
      save: 'game.save.preview',
      'graceful-stop': 'game.stop.preview',
      restart: 'game.restart.preview'
    }
    const labels: Record<LifecycleAction, string> = {
      save: '保存',
      'graceful-stop': '优雅停服',
      restart: '重启'
    }
    let job = this.#database.createJob(kinds[action], actor, `${labels[action]}生命周期只读预检`)
    this.#events.publish({ type: 'job.updated', data: job })
    const startedAt = new Date()
    job = this.#database.updateJob(job.id, { state: 'running', startedAt: startedAt.toISOString() })
    this.#events.publish({ type: 'job.updated', data: job })

    try {
      const preview = await this.#provider.previewLifecycle(action)
      const finishedAt = new Date()
      job = this.#database.updateJob(job.id, {
        state: 'succeeded',
        finishedAt: finishedAt.toISOString(),
        durationMs: finishedAt.getTime() - startedAt.getTime(),
        summary: `${labels[action]}生命周期只读预检完成：${preview.blockers.length} 项阻断`
      })
      this.#events.publish({ type: 'job.updated', data: job })
      return { job, preview }
    } catch (error) {
      const finishedAt = new Date()
      job = this.#database.updateJob(job.id, {
        state: 'failed',
        finishedAt: finishedAt.toISOString(),
        durationMs: finishedAt.getTime() - startedAt.getTime(),
        summary: `${labels[action]}生命周期只读预检失败`,
        errorCode: 'LIFECYCLE_PREVIEW_FAILED'
      })
      this.#events.publish({ type: 'job.updated', data: job })
      throw error
    }
  }

  async #runRefresh(job: JobRecord): Promise<void> {
    const startedAt = new Date()
    let current = this.#database.updateJob(job.id, { state: 'running', startedAt: startedAt.toISOString() })
    this.#events.publish({ type: 'job.updated', data: current })
    try {
      this.#latestStatus = await this.#provider.collectStatus()
      const finishedAt = new Date()
      current = this.#database.updateJob(job.id, {
        state: 'succeeded', finishedAt: finishedAt.toISOString(),
        durationMs: finishedAt.getTime() - startedAt.getTime(), summary: '服务器状态刷新完成'
      })
      this.#events.publish({ type: 'status.updated', data: this.#latestStatus })
      this.#events.publish({ type: 'job.updated', data: current })
    } catch (error) {
      const finishedAt = new Date()
      current = this.#database.updateJob(job.id, {
        state: 'failed', finishedAt: finishedAt.toISOString(),
        durationMs: finishedAt.getTime() - startedAt.getTime(),
        summary: '服务器状态刷新失败', errorCode: 'STATUS_COLLECTION_FAILED'
      })
      this.#events.publish({ type: 'job.updated', data: current })
      throw error
    }
  }
}
