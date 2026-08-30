import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { JobKind, JobRecord, JobState } from '../domain.js'

interface SessionRow {
  username: string
  expires_at: string
}

interface JobRow {
  id: string
  kind: JobKind
  state: JobState
  actor: string
  created_at: string
  started_at: string | null
  finished_at: string | null
  duration_ms: number | null
  summary: string
  error_code: string | null
}

export class ControlDatabase {
  readonly #database: DatabaseSync

  constructor(dataDirectory: string, inMemory = false) {
    fs.mkdirSync(dataDirectory, { recursive: true })
    this.#database = new DatabaseSync(inMemory ? ':memory:' : path.join(dataDirectory, 'control.db'))
    this.#database.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;')
    this.#database.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        token_hash TEXT PRIMARY KEY,
        username TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS jobs (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        state TEXT NOT NULL,
        actor TEXT NOT NULL,
        created_at TEXT NOT NULL,
        started_at TEXT,
        finished_at TEXT,
        duration_ms INTEGER,
        summary TEXT NOT NULL,
        error_code TEXT
      );
      CREATE INDEX IF NOT EXISTS jobs_created_at_idx ON jobs(created_at DESC);
    `)
  }

  createSession(tokenHash: string, username: string, expiresAt: string): void {
    this.#database.prepare(
      'INSERT INTO sessions(token_hash, username, expires_at, created_at) VALUES (?, ?, ?, ?)'
    ).run(tokenHash, username, expiresAt, new Date().toISOString())
  }

  getSession(tokenHash: string): SessionRow | null {
    const row = this.#database.prepare(
      'SELECT username, expires_at FROM sessions WHERE token_hash = ? AND expires_at > ?'
    ).get(tokenHash, new Date().toISOString()) as unknown as SessionRow | undefined
    return row ?? null
  }

  deleteSession(tokenHash: string): void {
    this.#database.prepare('DELETE FROM sessions WHERE token_hash = ?').run(tokenHash)
  }

  purgeExpiredSessions(): void {
    this.#database.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(new Date().toISOString())
  }

  createJob(kind: JobKind, actor: string, summary: string): JobRecord {
    const job: JobRecord = {
      id: randomUUID(), kind, state: 'queued', actor,
      createdAt: new Date().toISOString(), startedAt: null, finishedAt: null,
      durationMs: null, summary, errorCode: null
    }
    this.#database.prepare(`
      INSERT INTO jobs(id, kind, state, actor, created_at, summary)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(job.id, job.kind, job.state, job.actor, job.createdAt, job.summary)
    return job
  }

  updateJob(id: string, values: Partial<Pick<JobRecord, 'state' | 'startedAt' | 'finishedAt' | 'durationMs' | 'summary' | 'errorCode'>>): JobRecord {
    const current = this.getJob(id)
    if (!current) throw new Error(`Unknown job: ${id}`)
    const next = { ...current, ...values }
    this.#database.prepare(`
      UPDATE jobs SET state = ?, started_at = ?, finished_at = ?, duration_ms = ?, summary = ?, error_code = ?
      WHERE id = ?
    `).run(next.state, next.startedAt, next.finishedAt, next.durationMs, next.summary, next.errorCode, id)
    return next
  }

  getJob(id: string): JobRecord | null {
    const row = this.#database.prepare('SELECT * FROM jobs WHERE id = ?').get(id) as unknown as JobRow | undefined
    return row ? this.#toJob(row) : null
  }

  listJobs(limit = 20): JobRecord[] {
    const rows = this.#database.prepare('SELECT * FROM jobs ORDER BY created_at DESC LIMIT ?').all(limit) as unknown as JobRow[]
    return rows.map((row) => this.#toJob(row))
  }

  close(): void {
    this.#database.close()
  }

  #toJob(row: JobRow): JobRecord {
    return {
      id: row.id, kind: row.kind, state: row.state, actor: row.actor,
      createdAt: row.created_at, startedAt: row.started_at, finishedAt: row.finished_at,
      durationMs: row.duration_ms, summary: row.summary, errorCode: row.error_code
    }
  }
}
