import { createHash, randomUUID } from 'node:crypto'
import { lstat, mkdir, open, readdir, realpath, link, unlink } from 'node:fs/promises'
import path from 'node:path'
import { z } from 'zod'
import type { HostMutationOperationScope } from '../host-mutation/operation-coordinator.js'
import { operatorRollbackPhases, type OperatorRollbackJournal, type OperatorRollbackPhase,
  type OperatorRollbackReceipt, type OperatorRollbackStore } from './operator-rollback.js'
import { operatorRollbackCanonicalJson as canonical, parseOperatorRollbackJournal,
  parseOperatorRollbackReceipt } from './operator-rollback-records.js'

const hash = z.string().regex(/^[0-9a-f]{64}$/)
const checkpointSchema = z.strictObject({ format: z.literal('dyson-operator-rollback-checkpoint-v1'),
  previousSha256: hash.nullable(), journal: z.unknown() })
const terminalSchema = z.strictObject({ format: z.literal('dyson-operator-rollback-terminal-v1'),
  previousSha256: hash, receipt: z.unknown() })
const names = operatorRollbackPhases.map((phase, index) => `${index}-${phase}.json`)
const maximumBytes = 128 * 1024
const id = (value: string) => z.string().uuid().parse(value).toLowerCase()
const samePath = (a: string, b: string) => process.platform === 'win32'
  ? path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase() : path.resolve(a) === path.resolve(b)
const missing = (error: unknown) => typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT'
function fail(): never { throw new Error('UPDATE_ROLLBACK_STORE_INVALID') }

/** Writers require the coordinator's exclusive host lease. Records are append
 * only; hard-link publication cannot replace an existing checkpoint. */
export class FileOperatorRollbackStore implements OperatorRollbackStore {
  private readonly root: string
  constructor(root: string) {
    if (!path.isAbsolute(root) || path.resolve(root) === path.parse(path.resolve(root)).root) fail()
    this.root = path.resolve(root)
  }
  async load(requestId: string) {
    const record = await this.read(id(requestId))
    return record ? { journal: record.journal, receipt: record.receipt } : null
  }
  async pending(): Promise<Array<{ requestId: string; sourceRequestId: string; phase: OperatorRollbackPhase }>> {
    if (!await this.directory(this.root)) return []
    const entries = await readdir(this.root, { withFileTypes: true })
    if (entries.length > 1024) fail()
    const result: Array<{ requestId: string; sourceRequestId: string; phase: OperatorRollbackPhase }> = []
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.isSymbolicLink() || entry.name !== id(entry.name)) fail()
      const record = await this.read(entry.name)
      // A request directory without a published intent is uncertain, not idle.
      if (!record) throw new Error('UPDATE_ROLLBACK_STORE_INCOMPLETE_INTENT')
      if (!record.receipt) result.push({ requestId: record.journal.request.requestId,
        sourceRequestId: record.journal.request.sourceRequestId, phase: record.journal.phase })
    }
    return result.sort((a, b) => a.requestId < b.requestId ? -1 : a.requestId > b.requestId ? 1 : 0)
  }
  /** Recover a fully written first intent; never invent a plan from partial bytes. */
  async recoverIncompleteIntent(requestId: string, scope: HostMutationOperationScope): Promise<boolean> {
    scope.assertActive()
    const directory = path.join(this.root, id(requestId))
    if (!await this.directory(this.root) || !await this.directory(directory)) return false
    if (await this.read(id(requestId))) return false
    const entries = await readdir(directory, { withFileTypes: true })
    if (entries.length === 0) return false
    if (entries.length !== 1) throw new Error('UPDATE_ROLLBACK_STORE_INCOMPLETE_INTENT')
    const entry = entries[0]!
    if (!entry.isFile() || entry.isSymbolicLink() || !/^\.pending-[0-9a-f-]{36}$/.test(entry.name)) fail()
    const temporary = path.join(directory, entry.name)
    const stat = await lstat(temporary)
    if (stat.nlink !== 1 || !samePath(await realpath(temporary), temporary)) fail()
    if (stat.size < 2) return false
    let record
    try { record = await this.readFile(temporary) }
    catch (error) { if (error instanceof SyntaxError) return false; throw error }
    if (!record) fail()
    const parsed = checkpointSchema.parse(record.value)
    const journal = parseOperatorRollbackJournal(parsed.journal)
    if (parsed.previousSha256 !== null || journal.phase !== 'prepared' || journal.request.requestId !== id(requestId)) fail()
    scope.assertActive()
    await link(path.join(directory, entry.name), path.join(directory, names[0]!))
    scope.assertActive()
    await unlink(path.join(directory, entry.name))
    scope.assertActive()
    return true
  }
  async rebuildIncompleteIntent(input: OperatorRollbackJournal, scope: HostMutationOperationScope): Promise<void> {
    const journal = parseOperatorRollbackJournal(input)
    if (journal.phase !== 'prepared') fail()
    const directory = path.join(this.root, id(journal.request.requestId))
    scope.assertActive()
    if (await this.read(journal.request.requestId)) fail()
    await this.ensureDirectory(this.root, scope)
    await this.ensureDirectory(directory, scope)
    const entries = await readdir(directory, { withFileTypes: true })
    if (entries.length > 32) fail()
    // No published checkpoint means no game action was permitted. Only owned
    // unpublished temporary files can be replaced after a fresh exact preview.
    for (const entry of entries) {
      if (!entry.isFile() || entry.isSymbolicLink() || !/^\.pending-[0-9a-f-]{36}$/.test(entry.name)) fail()
      const file = path.join(directory, entry.name)
      const stat = await lstat(file)
      if (stat.nlink !== 1 || !samePath(await realpath(file), file)) fail()
    }
    for (const entry of entries) {
      scope.assertActive()
      await unlink(path.join(directory, entry.name))
    }
    await this.begin(journal, scope)
  }
  async begin(input: OperatorRollbackJournal, scope: HostMutationOperationScope): Promise<void> {
    scope.assertActive()
    const journal = parseOperatorRollbackJournal(input)
    if (journal.phase !== 'prepared') fail()
    const existing = await this.read(journal.request.requestId)
    if (existing) {
      if (canonical(existing.journal) !== canonical(journal)) fail()
      return
    }
    await this.ensureDirectory(this.root, scope)
    const directory = path.join(this.root, id(journal.request.requestId))
    await this.ensureDirectory(directory, scope)
    await this.publish(path.join(directory, names[0]!), { format: 'dyson-operator-rollback-checkpoint-v1',
      previousSha256: null, journal }, scope)
  }
  async checkpoint(previous: OperatorRollbackPhase, input: OperatorRollbackJournal, scope: HostMutationOperationScope): Promise<void> {
    scope.assertActive()
    const journal = parseOperatorRollbackJournal(input)
    const index = operatorRollbackPhases.indexOf(journal.phase)
    if (index !== operatorRollbackPhases.indexOf(previous) + 1) fail()
    const existing = await this.read(journal.request.requestId)
    if (!existing || existing.receipt) fail()
    if (existing.journal.phase === journal.phase && canonical(existing.journal) === canonical(journal)) return
    if (existing.journal.phase !== previous) fail()
    this.assertTransition(existing.journal, journal)
    await this.publish(path.join(this.root, id(journal.request.requestId), names[index]!), {
      format: 'dyson-operator-rollback-checkpoint-v1', previousSha256: existing.digest, journal
    }, scope)
  }
  async complete(input: OperatorRollbackReceipt, scope: HostMutationOperationScope): Promise<void> {
    scope.assertActive()
    const existing = await this.read(id(input.requestId))
    if (!existing) fail()
    const receipt = parseOperatorRollbackReceipt(input, existing.journal)
    if (existing.receipt) {
      if (canonical(receipt) !== canonical(existing.receipt)) fail()
      return
    }
    await this.publish(path.join(this.root, id(input.requestId), 'receipt.json'), {
      format: 'dyson-operator-rollback-terminal-v1', previousSha256: existing.digest, receipt
    }, scope)
  }
  private assertTransition(previous: OperatorRollbackJournal, next: OperatorRollbackJournal) {
    if (canonical(previous.request) !== canonical(next.request) || canonical(previous.plan) !== canonical(next.plan) ||
        (previous.protection !== null && canonical(previous.protection) !== canonical(next.protection))) fail()
  }
  private async read(requestId: string): Promise<{
    journal: OperatorRollbackJournal; receipt: OperatorRollbackReceipt | null; digest: string
  } | null> {
    if (!await this.directory(this.root)) return null
    const directory = path.join(this.root, id(requestId))
    if (!await this.directory(directory)) return null
    const entries = await readdir(directory, { withFileTypes: true })
    if (entries.length > 32 || entries.some(entry => !entry.isFile() || entry.isSymbolicLink() ||
      (!names.includes(entry.name) && entry.name !== 'receipt.json' && !/^\.pending-[0-9a-f-]{36}$/.test(entry.name)))) fail()
    let latest: OperatorRollbackJournal | null = null
    let digest: string | null = null
    let gap = false
    for (const [index, name] of names.entries()) {
      const record = await this.readFile(path.join(directory, name))
      if (!record) { gap = true; continue }
      if (gap) fail()
      const parsed = checkpointSchema.parse(record.value)
      const journal = parseOperatorRollbackJournal(parsed.journal)
      if (journal.request.requestId !== requestId || journal.phase !== operatorRollbackPhases[index] || parsed.previousSha256 !== digest) fail()
      if (latest) this.assertTransition(latest, journal)
      latest = journal; digest = record.digest
    }
    const terminal = await this.readFile(path.join(directory, 'receipt.json'))
    if (!latest || !digest) { if (terminal) fail(); return null }
    let receipt: OperatorRollbackReceipt | null = null
    if (terminal) {
      const parsed = terminalSchema.parse(terminal.value)
      if (parsed.previousSha256 !== digest) fail()
      receipt = parseOperatorRollbackReceipt(parsed.receipt, latest)
    }
    return { journal: latest, receipt, digest }
  }
  private async directory(directory: string): Promise<boolean> {
    try {
      const stat = await lstat(directory)
      if (!stat.isDirectory() || stat.isSymbolicLink() || !samePath(await realpath(directory), directory)) fail()
      return true
    } catch (error) { if (missing(error)) return false; throw error }
  }
  private async ensureDirectory(directory: string, scope: HostMutationOperationScope) {
    if (!await this.directory(path.dirname(directory))) fail()
    scope.assertActive()
    await mkdir(directory).catch(error => { if (!(error && error.code === 'EEXIST')) throw error })
    scope.assertActive()
    if (!await this.directory(directory)) fail()
  }
  private async readFile(file: string): Promise<{ value: unknown; digest: string; text: string } | null> {
    let handle: Awaited<ReturnType<typeof open>> | undefined
    let observed = false
    try {
      const before = await lstat(file)
      observed = true
      if (!before.isFile() || before.isSymbolicLink() || before.size < 2 || before.size > maximumBytes ||
          !samePath(await realpath(file), file)) fail()
      handle = await open(file, 'r')
      const opened = await handle.stat()
      if (opened.ino !== before.ino || opened.dev !== before.dev || opened.size < 2 || opened.size > maximumBytes) fail()
      if (opened.nlink !== 1) {
        if (opened.nlink !== 2) fail()
        const candidates = (await readdir(path.dirname(file))).filter(name => /^\.pending-[0-9a-f-]{36}$/.test(name))
        let matched = 0
        for (const name of candidates) {
          const other = await lstat(path.join(path.dirname(file), name))
          if (other.isFile() && !other.isSymbolicLink() && other.ino === opened.ino && other.dev === opened.dev) matched++
        }
        if (matched !== 1) fail()
      }
      const buffer = Buffer.alloc(maximumBytes + 1)
      let length = 0
      while (length < buffer.length) {
        const result = await handle.read(buffer, length, buffer.length - length, length)
        if (result.bytesRead === 0) break
        length += result.bytesRead
      }
      if (length > maximumBytes) fail()
      const bytes = buffer.subarray(0, length)
      const after = await lstat(file)
      if (after.ino !== opened.ino || after.dev !== opened.dev || after.size !== opened.size ||
          after.mtimeMs !== opened.mtimeMs || after.ctimeMs !== opened.ctimeMs || bytes.length !== opened.size) fail()
      const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
      const value = JSON.parse(text)
      if (canonical(value) !== text) fail()
      return { value, text, digest: createHash('sha256').update(bytes).digest('hex') }
    } catch (error) { if (!observed && missing(error)) return null; throw error }
    finally { await handle?.close() }
  }
  private async publish(file: string, value: unknown, scope: HostMutationOperationScope) {
    const text = canonical(value)
    if (Buffer.byteLength(text) > maximumBytes) fail()
    const temporary = path.join(path.dirname(file), `.pending-${randomUUID()}`)
    scope.assertActive()
    const handle = await open(temporary, 'wx', 0o600)
    try { await handle.writeFile(text); scope.assertActive(); await handle.sync() } finally { await handle.close() }
    scope.assertActive()
    try { await link(temporary, file) } catch (error) {
      if (!(error && typeof error === 'object' && 'code' in error && error.code === 'EEXIST')) throw error
      if ((await this.readFile(file))?.text !== text) fail()
    }
    scope.assertActive()
    await unlink(temporary)
    scope.assertActive()
  }
}
