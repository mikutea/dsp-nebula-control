import { createHash } from 'node:crypto'
import {
  maximumSnapshotPlayers,
  playerSnapshotProtocol,
  PlayerSnapshotError,
  type PlayerSnapshot,
  type PlayerSnapshotEntry
} from './protocol.js'

export const defaultPlayerHistoryCapacity = 512
export const maximumPlayerHistoryCapacity = 2_048
export const defaultPlayerHistoryRetentionHours = 168
export const maximumPlayerHistoryRetentionHours = 720
const maximumPlayerHistoryCursors = 8
const maximumRetentionTimerDelayMs = 2_147_000_000
const retentionMaintenanceRetryMs = 60_000

export type PlayerPresenceEventType = 'join' | 'leave'

export interface PlayerPresenceEvent {
  historySequence: number
  type: PlayerPresenceEventType
  occurredAtUnixMs: number
  sessionId: string
  player: Omit<PlayerSnapshotEntry, 'online'> & { online: boolean }
}

export interface PlayerPresenceAuthoritativeSnapshot {
  sessionId: string
  sequence: number
  writtenAtUnixMs: number
  state: 'active' | 'inactive'
  truncated: boolean
  players: PlayerSnapshotEntry[]
}

export interface PlayerPresenceHistoryStore {
  ingest(snapshot: PlayerSnapshot): PlayerPresenceEvent[]
  list(): PlayerPresenceEvent[]
  current(): PlayerSnapshotEntry[]
  authoritative(): PlayerPresenceAuthoritativeSnapshot | null
  startRetentionMaintenance?(onError: (error: PlayerSnapshotError) => void): () => void
}

export interface StoredPlayerPresenceEventRow {
  historySequence: number
  type: string
  occurredAtUnixMs: number
  sessionId: string
  sessionPlayerId: string
  displayName: string
  online: number
  joinedAtUnixMs: number
  location: string
}

export interface PlayerPresenceHistoryPersistenceState {
  projectionJson: string | null
  cursorJson: string
  events: StoredPlayerPresenceEventRow[]
}

export interface PlayerPresenceEventDraft {
  type: PlayerPresenceEventType
  occurredAtUnixMs: number
  sessionId: string
  player: Omit<PlayerSnapshotEntry, 'online'> & { online: boolean }
}

export interface PlayerPresenceHistoryPersistence {
  loadPlayerPresenceHistory(): PlayerPresenceHistoryPersistenceState
  prunePlayerPresenceHistory(
    capacity: number,
    cutoffUnixMs: number
  ): PlayerPresenceHistoryPersistenceState
  commitPlayerPresenceHistory(input: {
    expectedProjectionJson: string | null
    expectedCursorJson: string
    projectionJson: string | null
    cursorJson: string
    events: PlayerPresenceEventDraft[]
    capacity: number
    cutoffUnixMs: number
  }): PlayerPresenceHistoryPersistenceState & { insertedHistorySequences: number[] }
}

interface AuthoritativeProjection {
  schemaVersion: 1
  sessionId: string
  snapshotSequence: number
  writtenAtUnixMs: number
  state: 'active' | 'inactive'
  truncated: boolean
  players: PlayerSnapshotEntry[]
}

interface PlayerSnapshotCursor {
  sessionId: string
  sequence: number
  writtenAtUnixMs: number
  state: PlayerSnapshot['state']
  fingerprint: string
}

export interface PersistentPlayerPresenceHistoryOptions {
  capacity?: number
  retentionHours?: number
  now?: () => number
}

/**
 * Restores the last accepted authoritative projection and a privacy-minimized event window
 * from the control database. Raw bridge payloads, HMACs, secrets and filesystem paths never
 * cross the persistence interface.
 */
export class PersistentPlayerPresenceHistory implements PlayerPresenceHistoryStore {
  readonly #persistence: PlayerPresenceHistoryPersistence
  readonly #capacity: number
  readonly #retentionMs: number
  readonly #now: () => number
  #projection: AuthoritativeProjection | null = null
  #projectionJson: string | null = null
  #cursors: PlayerSnapshotCursor[] = []
  #cursorJson = '[]'
  #events: PlayerPresenceEvent[] = []
  #retentionTimer: ReturnType<typeof setTimeout> | null = null
  #retentionErrorHandler: ((error: PlayerSnapshotError) => void) | null = null

  constructor(
    persistence: PlayerPresenceHistoryPersistence,
    options: PersistentPlayerPresenceHistoryOptions = {}
  ) {
    const capacity = options.capacity ?? defaultPlayerHistoryCapacity
    const retentionHours = options.retentionHours ?? defaultPlayerHistoryRetentionHours
    if (!Number.isInteger(capacity) || capacity < 1 || capacity > maximumPlayerHistoryCapacity) {
      throw new PlayerSnapshotError('PLAYER_HISTORY_LIMIT_INVALID')
    }
    if (!Number.isInteger(retentionHours) || retentionHours < 1 ||
        retentionHours > maximumPlayerHistoryRetentionHours) {
      throw new PlayerSnapshotError('PLAYER_HISTORY_RETENTION_INVALID')
    }
    this.#persistence = persistence
    this.#capacity = capacity
    this.#retentionMs = retentionHours * 60 * 60 * 1_000
    this.#now = options.now ?? Date.now
    this.#refresh()
  }

  ingest(snapshot: PlayerSnapshot): PlayerPresenceEvent[] {
    const normalized = normalizeSnapshot(snapshot)
    this.#refresh()
    const incomingCursor = cursorFromSnapshot(normalized)
    if (snapshotProgress(this.#cursors, incomingCursor) === 'replay') return []

    // unavailable advances only the signed source high-water. It never closes or replaces the
    // last authoritative roster and never emits a leave.
    const nextProjection = normalized.state === 'unavailable'
      ? this.#projection
      : projectionFromSnapshot(normalized)
    const nextProjectionJson = nextProjection === null ? null : serializeProjection(nextProjection)
    const drafts = normalized.state === 'unavailable' || nextProjection === null
      ? []
      : deriveEvents(this.#projection, nextProjection)
    const nextCursors = advanceCursors(
      this.#cursors,
      incomingCursor,
      nextProjection?.sessionId ?? null
    )
    const nextCursorJson = serializeCursors(nextCursors)
    let stored: PlayerPresenceHistoryPersistenceState & { insertedHistorySequences: number[] }
    try {
      stored = this.#persistence.commitPlayerPresenceHistory({
        expectedProjectionJson: this.#projectionJson,
        expectedCursorJson: this.#cursorJson,
        projectionJson: nextProjectionJson,
        cursorJson: nextCursorJson,
        events: drafts,
        capacity: this.#capacity,
        cutoffUnixMs: this.#cutoffUnixMs()
      })
    } catch (error) {
      if (error instanceof PlayerSnapshotError) throw error
      throw new PlayerSnapshotError('PLAYER_HISTORY_PERSISTENCE_FAILED')
    }
    this.#applyPersistenceState(stored)
    this.#scheduleRetentionMaintenance()
    const inserted = new Set(stored.insertedHistorySequences)
    return this.#events.filter((event) => inserted.has(event.historySequence)).map(cloneEvent)
  }

  list(): PlayerPresenceEvent[] {
    this.#refresh()
    this.#scheduleRetentionMaintenance()
    return this.#events.map(cloneEvent)
  }

  current(): PlayerSnapshotEntry[] {
    this.#refresh()
    this.#scheduleRetentionMaintenance()
    return sortedPlayers(this.#projection?.players ?? []).map(clonePlayer)
  }

  authoritative(): PlayerPresenceAuthoritativeSnapshot | null {
    this.#refresh()
    this.#scheduleRetentionMaintenance()
    return this.#projection === null ? null : publicProjection(this.#projection)
  }

  /**
   * Enforces the age boundary even while no player route is being read. The returned disposer
   * must run before the persistence connection closes.
   */
  startRetentionMaintenance(onError: (error: PlayerSnapshotError) => void): () => void {
    this.stopRetentionMaintenance()
    this.#retentionErrorHandler = onError
    this.#scheduleRetentionMaintenance()
    return () => { this.stopRetentionMaintenance() }
  }

  stopRetentionMaintenance(): void {
    this.#retentionErrorHandler = null
    if (this.#retentionTimer !== null) {
      clearTimeout(this.#retentionTimer)
      this.#retentionTimer = null
    }
  }

  #refresh(): void {
    let loaded: PlayerPresenceHistoryPersistenceState
    try {
      loaded = this.#persistence.loadPlayerPresenceHistory()
    } catch (error) {
      if (error instanceof PlayerSnapshotError) throw error
      throw new PlayerSnapshotError('PLAYER_HISTORY_PERSISTENCE_FAILED')
    }
    // Validate every stored row before retention is allowed to delete anything. Corruption is
    // never silently pruned into an apparently healthy history.
    parsePersistenceState(loaded)
    try {
      loaded = this.#persistence.prunePlayerPresenceHistory(
        this.#capacity,
        this.#cutoffUnixMs()
      )
    } catch (error) {
      if (error instanceof PlayerSnapshotError) throw error
      throw new PlayerSnapshotError('PLAYER_HISTORY_PERSISTENCE_FAILED')
    }
    this.#applyPersistenceState(loaded)
  }

  #applyPersistenceState(stored: PlayerPresenceHistoryPersistenceState): void {
    const parsed = parsePersistenceState(stored)
    this.#projection = parsed.projection
    this.#projectionJson = stored.projectionJson
    this.#cursors = parsed.cursors
    this.#cursorJson = stored.cursorJson
    this.#events = parsed.events
  }

  #cutoffUnixMs(): number {
    const now = this.#now()
    if (!Number.isSafeInteger(now) || now <= 0) {
      throw new PlayerSnapshotError('PLAYER_HISTORY_CLOCK_INVALID')
    }
    return Math.max(1, now - this.#retentionMs)
  }

  #scheduleRetentionMaintenance(retryDelayMs?: number): void {
    if (this.#retentionTimer !== null) {
      clearTimeout(this.#retentionTimer)
      this.#retentionTimer = null
    }
    if (this.#retentionErrorHandler === null) return

    let delayMs: number
    if (retryDelayMs !== undefined) {
      delayMs = retryDelayMs
    } else {
      if (this.#events.length === 0) return
      const earliestOccurredAtUnixMs = Math.min(
        ...this.#events.map((event) => event.occurredAtUnixMs)
      )
      const now = this.#now()
      if (!Number.isSafeInteger(now) || now <= 0) {
        throw new PlayerSnapshotError('PLAYER_HISTORY_CLOCK_INVALID')
      }
      // SQLite removes rows strictly older than the cutoff, hence the extra millisecond.
      delayMs = earliestOccurredAtUnixMs + this.#retentionMs + 1 - now
    }
    delayMs = Math.max(1, Math.min(maximumRetentionTimerDelayMs, delayMs))
    this.#retentionTimer = setTimeout(() => {
      this.#retentionTimer = null
      if (this.#retentionErrorHandler === null) return
      try {
        this.#refresh()
        this.#scheduleRetentionMaintenance()
      } catch (error) {
        const stableError = error instanceof PlayerSnapshotError
          ? error
          : new PlayerSnapshotError('PLAYER_HISTORY_PERSISTENCE_FAILED')
        try { this.#retentionErrorHandler(stableError) } catch { /* Retention retries remain armed. */ }
        this.#scheduleRetentionMaintenance(retentionMaintenanceRetryMs)
      }
    }, delayMs)
    const timer = this.#retentionTimer as { unref?: () => void }
    timer.unref?.()
  }
}

/**
 * Process-local implementation retained for isolated consumers and tests. The application uses
 * PersistentPlayerPresenceHistory so API restarts do not reset the authoritative projection.
 */
export class BoundedPlayerPresenceHistory implements PlayerPresenceHistoryStore {
  readonly #maximumEvents: number
  readonly #events: PlayerPresenceEvent[] = []
  #observedPlayers = new Map<string, PlayerSnapshotEntry>()
  #lastSessionId: string | null = null
  #lastSnapshotSequence = 0
  #lastSnapshotWrittenAtUnixMs = 0
  #lastSnapshotState: 'active' | 'inactive' | null = null
  #lastSnapshotTruncated = false
  #cursors: PlayerSnapshotCursor[] = []
  #nextHistorySequence = 0

  constructor(maximumEvents = defaultPlayerHistoryCapacity) {
    if (!Number.isInteger(maximumEvents) || maximumEvents < 1 ||
        maximumEvents > maximumPlayerHistoryCapacity) {
      throw new PlayerSnapshotError('PLAYER_HISTORY_LIMIT_INVALID')
    }
    this.#maximumEvents = maximumEvents
  }

  ingest(snapshot: PlayerSnapshot): PlayerPresenceEvent[] {
    const normalized = normalizeSnapshot(snapshot)
    const incomingCursor = cursorFromSnapshot(normalized)
    if (snapshotProgress(this.#cursors, incomingCursor) === 'replay') return []
    if (normalized.state === 'unavailable') {
      this.#cursors = advanceCursors(this.#cursors, incomingCursor, this.#lastSessionId)
      return []
    }

    const projection = projectionFromSnapshot(normalized)

    const previous: AuthoritativeProjection | null = this.#lastSessionId === null ? null : {
      schemaVersion: 1,
      sessionId: this.#lastSessionId,
      snapshotSequence: this.#lastSnapshotSequence,
      writtenAtUnixMs: this.#lastSnapshotWrittenAtUnixMs,
      state: this.#lastSnapshotState ?? 'inactive',
      truncated: this.#lastSnapshotTruncated,
      players: sortedPlayers(this.#observedPlayers.values())
    }
    const emitted = deriveEvents(previous, projection).map((draft) => ({
      ...draft,
      historySequence: ++this.#nextHistorySequence,
      player: { ...draft.player }
    }))
    this.#observedPlayers = new Map(
      projection.players.map((player) => [player.sessionPlayerId, clonePlayer(player)])
    )
    this.#lastSessionId = projection.sessionId
    this.#lastSnapshotSequence = projection.snapshotSequence
    this.#lastSnapshotWrittenAtUnixMs = projection.writtenAtUnixMs
    this.#lastSnapshotState = projection.state
    this.#lastSnapshotTruncated = projection.truncated
    this.#cursors = advanceCursors(this.#cursors, incomingCursor, projection.sessionId)
    for (const event of emitted) this.#append(event)
    return emitted.map(cloneEvent)
  }

  list(): PlayerPresenceEvent[] {
    return this.#events.map(cloneEvent)
  }

  current(): PlayerSnapshotEntry[] {
    return sortedPlayers(this.#observedPlayers.values()).map(clonePlayer)
  }

  authoritative(): PlayerPresenceAuthoritativeSnapshot | null {
    if (this.#lastSessionId === null || this.#lastSnapshotState === null) return null
    return {
      sessionId: this.#lastSessionId,
      sequence: this.#lastSnapshotSequence,
      writtenAtUnixMs: this.#lastSnapshotWrittenAtUnixMs,
      state: this.#lastSnapshotState,
      truncated: this.#lastSnapshotTruncated,
      players: sortedPlayers(this.#observedPlayers.values()).map(clonePlayer)
    }
  }

  clear(): void {
    this.#events.length = 0
    this.#observedPlayers.clear()
    this.#lastSessionId = null
    this.#lastSnapshotSequence = 0
    this.#lastSnapshotWrittenAtUnixMs = 0
    this.#lastSnapshotState = null
    this.#lastSnapshotTruncated = false
    this.#cursors = []
    this.#nextHistorySequence = 0
  }

  #append(event: PlayerPresenceEvent): void {
    this.#events.push(cloneEvent(event))
    if (this.#events.length > this.#maximumEvents) {
      this.#events.splice(0, this.#events.length - this.#maximumEvents)
    }
  }
}

function normalizeSnapshot(snapshot: PlayerSnapshot): PlayerSnapshot {
  if (snapshot.protocol !== playerSnapshotProtocol ||
      typeof snapshot.hmac !== 'string' || !/^[0-9a-f]{64}$/i.test(snapshot.hmac) ||
      !isSessionId(snapshot.sessionId) || !isSafePositiveInteger(snapshot.writtenAtUnixMs) ||
      !isSafePositiveInteger(snapshot.sequence) ||
      (snapshot.state !== 'active' && snapshot.state !== 'inactive' && snapshot.state !== 'unavailable') ||
      typeof snapshot.truncated !== 'boolean' || !Number.isSafeInteger(snapshot.playerCount) ||
      snapshot.playerCount !== snapshot.players.length || snapshot.players.length > maximumSnapshotPlayers ||
      (snapshot.state !== 'active' && (snapshot.truncated || snapshot.players.length !== 0))) {
    throw new PlayerSnapshotError('PLAYER_HISTORY_SNAPSHOT_INVALID')
  }
  const players = snapshot.players.map((player) => parsePlayer(
    player,
    snapshot.writtenAtUnixMs,
    true,
    'PLAYER_HISTORY_SNAPSHOT_INVALID'
  ))
  assertStrictPlayerOrder(players)
  return { ...snapshot, sessionId: snapshot.sessionId.toLowerCase(), players }
}

function projectionFromSnapshot(snapshot: PlayerSnapshot): AuthoritativeProjection {
  if (snapshot.state === 'unavailable') {
    throw new PlayerSnapshotError('PLAYER_HISTORY_SNAPSHOT_INVALID')
  }
  return {
    schemaVersion: 1,
    sessionId: snapshot.sessionId,
    snapshotSequence: snapshot.sequence,
    writtenAtUnixMs: snapshot.writtenAtUnixMs,
    state: snapshot.state,
    truncated: snapshot.truncated,
    players: snapshot.players.map(clonePlayer)
  }
}

function deriveEvents(
  previous: AuthoritativeProjection | null,
  next: AuthoritativeProjection
): PlayerPresenceEventDraft[] {
  const events: PlayerPresenceEventDraft[] = []
  const previousPlayers = new Map(
    (previous?.players ?? []).map((player) => [player.sessionPlayerId, player])
  )
  const nextPlayers = new Map(next.players.map((player) => [player.sessionPlayerId, player]))
  const sessionChanged = previous !== null && previous.sessionId !== next.sessionId

  if (sessionChanged) {
    for (const player of sortedPlayers(previousPlayers.values())) {
      events.push(createEventDraft('leave', next.writtenAtUnixMs, previous.sessionId, player))
    }
    if (next.state === 'active') {
      for (const player of sortedPlayers(nextPlayers.values())) {
        events.push(createEventDraft('join', player.joinedAtUnixMs, next.sessionId, player))
      }
    }
    return events
  }

  if (next.state === 'inactive') {
    for (const player of sortedPlayers(previousPlayers.values())) {
      events.push(createEventDraft('leave', next.writtenAtUnixMs, next.sessionId, player))
    }
    return events
  }

  if (previous === null || previous.state === 'inactive') {
    for (const player of sortedPlayers(nextPlayers.values())) {
      events.push(createEventDraft('join', player.joinedAtUnixMs, next.sessionId, player))
    }
    return events
  }

  if (!previous.truncated && !next.truncated) {
    for (const player of sortedPlayers(previousPlayers.values())) {
      if (!nextPlayers.has(player.sessionPlayerId)) {
        events.push(createEventDraft('leave', next.writtenAtUnixMs, next.sessionId, player))
      }
    }
    for (const player of sortedPlayers(nextPlayers.values())) {
      if (!previousPlayers.has(player.sessionPlayerId)) {
        events.push(createEventDraft('join', player.joinedAtUnixMs, next.sessionId, player))
      }
    }
    return events
  }

  if (previous.truncated && !next.truncated) {
    // The prior roster was incomplete: a player absent from it is not proven to have joined.
    // A player present in it but absent from this complete roster is proven to have left.
    for (const player of sortedPlayers(previousPlayers.values())) {
      if (!nextPlayers.has(player.sessionPlayerId)) {
        events.push(createEventDraft('leave', next.writtenAtUnixMs, next.sessionId, player))
      }
    }
  }
  // While the new roster is truncated, omissions and apparent additions can both be window
  // movement. Suppress both directions rather than inventing player events.
  return events
}

function createEventDraft(
  type: PlayerPresenceEventType,
  occurredAtUnixMs: number,
  sessionId: string,
  player: PlayerSnapshotEntry
): PlayerPresenceEventDraft {
  return {
    type,
    occurredAtUnixMs,
    sessionId,
    player: { ...clonePlayer(player), online: type === 'join' }
  }
}

function parsePersistenceState(stored: PlayerPresenceHistoryPersistenceState): {
  projection: AuthoritativeProjection | null
  cursors: PlayerSnapshotCursor[]
  events: PlayerPresenceEvent[]
} {
  if (typeof stored !== 'object' || stored === null ||
      (stored.projectionJson !== null && typeof stored.projectionJson !== 'string') ||
      typeof stored.cursorJson !== 'string' ||
      !Array.isArray(stored.events) || stored.events.length > maximumPlayerHistoryCapacity) {
    throw new PlayerSnapshotError('PLAYER_HISTORY_PERSISTENCE_INVALID')
  }
  const projection = stored.projectionJson === null ? null : parseProjection(stored.projectionJson)
  const cursors = parseCursors(stored.cursorJson)
  const events = stored.events.map(parseStoredEvent)
  if (projection === null && events.length > 0) {
    throw new PlayerSnapshotError('PLAYER_HISTORY_PERSISTENCE_INVALID')
  }
  validatePersistenceMetadata(projection, cursors)
  for (let index = 1; index < events.length; index++) {
    if (events[index - 1]!.historySequence >= events[index]!.historySequence) {
      throw new PlayerSnapshotError('PLAYER_HISTORY_PERSISTENCE_INVALID')
    }
  }
  return { projection, cursors, events }
}

export function validatePlayerPresencePersistenceState(
  stored: PlayerPresenceHistoryPersistenceState
): void {
  parsePersistenceState(stored)
}

function parseProjection(payload: string): AuthoritativeProjection {
  if (Buffer.byteLength(payload, 'utf8') > 32_768 || payload.includes('\0')) {
    throw new PlayerSnapshotError('PLAYER_HISTORY_PERSISTENCE_INVALID')
  }
  let value: unknown
  try {
    value = JSON.parse(payload)
  } catch {
    throw new PlayerSnapshotError('PLAYER_HISTORY_PERSISTENCE_INVALID')
  }
  if (!isRecordWithExactKeys(value, [
    'schemaVersion', 'sessionId', 'snapshotSequence', 'writtenAtUnixMs',
    'state', 'truncated', 'players'
  ]) || value.schemaVersion !== 1 || !isSessionId(value.sessionId) ||
      !isSafePositiveInteger(value.snapshotSequence) ||
      !isSafePositiveInteger(value.writtenAtUnixMs) ||
      (value.state !== 'active' && value.state !== 'inactive') ||
      typeof value.truncated !== 'boolean' || !Array.isArray(value.players) ||
      value.players.length > maximumSnapshotPlayers ||
      (value.state === 'inactive' && (value.truncated || value.players.length !== 0))) {
    throw new PlayerSnapshotError('PLAYER_HISTORY_PERSISTENCE_INVALID')
  }
  const players = value.players.map((player) => parsePlayer(player, value.writtenAtUnixMs as number, true))
  assertStrictPlayerOrder(players, 'PLAYER_HISTORY_PERSISTENCE_INVALID')
  const projection: AuthoritativeProjection = {
    schemaVersion: 1,
    sessionId: (value.sessionId as string).toLowerCase(),
    snapshotSequence: value.snapshotSequence as number,
    writtenAtUnixMs: value.writtenAtUnixMs as number,
    state: value.state,
    truncated: value.truncated,
    players
  }
  if (serializeProjection(projection) !== payload) {
    throw new PlayerSnapshotError('PLAYER_HISTORY_PERSISTENCE_INVALID')
  }
  return projection
}

export function validatePlayerPresenceProjectionJson(payload: string): void {
  parseProjection(payload)
}

export function validatePlayerPresencePersistenceMetadata(
  projectionJson: string | null,
  cursorJson: string
): void {
  const projection = projectionJson === null ? null : parseProjection(projectionJson)
  validatePersistenceMetadata(projection, parseCursors(cursorJson))
}

function parseCursors(payload: string): PlayerSnapshotCursor[] {
  if (Buffer.byteLength(payload, 'utf8') > 8_192 || payload.includes('\0')) {
    throw new PlayerSnapshotError('PLAYER_HISTORY_PERSISTENCE_INVALID')
  }
  let value: unknown
  try {
    value = JSON.parse(payload)
  } catch {
    throw new PlayerSnapshotError('PLAYER_HISTORY_PERSISTENCE_INVALID')
  }
  if (!Array.isArray(value) || value.length > maximumPlayerHistoryCursors) {
    throw new PlayerSnapshotError('PLAYER_HISTORY_PERSISTENCE_INVALID')
  }
  const cursors = value.map((item): PlayerSnapshotCursor => {
    if (!isRecordWithExactKeys(item, [
      'sessionId', 'sequence', 'writtenAtUnixMs', 'state', 'fingerprint'
    ]) || !isSessionId(item.sessionId) || !isSafePositiveInteger(item.sequence) ||
        !isSafePositiveInteger(item.writtenAtUnixMs) ||
        (item.state !== 'active' && item.state !== 'inactive' && item.state !== 'unavailable') ||
        typeof item.fingerprint !== 'string' || !/^[0-9a-f]{64}$/.test(item.fingerprint)) {
      throw new PlayerSnapshotError('PLAYER_HISTORY_PERSISTENCE_INVALID')
    }
    return {
      sessionId: item.sessionId.toLowerCase(),
      sequence: item.sequence,
      writtenAtUnixMs: item.writtenAtUnixMs,
      state: item.state,
      fingerprint: item.fingerprint
    }
  })
  if (new Set(cursors.map((cursor) => cursor.sessionId)).size !== cursors.length ||
      serializeCursors(cursors) !== payload) {
    throw new PlayerSnapshotError('PLAYER_HISTORY_PERSISTENCE_INVALID')
  }
  for (let index = 1; index < cursors.length; index++) {
    if (cursors[index - 1]!.writtenAtUnixMs >= cursors[index]!.writtenAtUnixMs) {
      throw new PlayerSnapshotError('PLAYER_HISTORY_PERSISTENCE_INVALID')
    }
  }
  return cursors
}

function validatePersistenceMetadata(
  projection: AuthoritativeProjection | null,
  cursors: PlayerSnapshotCursor[]
): void {
  if (projection === null) {
    if (cursors.some((cursor) => cursor.state !== 'unavailable')) {
      throw new PlayerSnapshotError('PLAYER_HISTORY_PERSISTENCE_INVALID')
    }
    return
  }
  const cursor = cursors.find((candidate) => candidate.sessionId === projection.sessionId)
  if (!cursor || cursor.sequence < projection.snapshotSequence ||
      (cursor.sequence > projection.snapshotSequence && cursor.state !== 'unavailable') ||
      (cursor.sequence === projection.snapshotSequence &&
        (cursor.state !== projection.state || cursor.fingerprint !== fingerprintProjection(projection)))) {
    throw new PlayerSnapshotError('PLAYER_HISTORY_PERSISTENCE_INVALID')
  }
}

function cursorFromSnapshot(snapshot: PlayerSnapshot): PlayerSnapshotCursor {
  return {
    sessionId: snapshot.sessionId,
    sequence: snapshot.sequence,
    writtenAtUnixMs: snapshot.writtenAtUnixMs,
    state: snapshot.state,
    fingerprint: fingerprintSnapshot(snapshot)
  }
}

function snapshotProgress(
  current: PlayerSnapshotCursor[],
  incoming: PlayerSnapshotCursor
): 'advance' | 'replay' {
  const previous = current.find((cursor) => cursor.sessionId === incoming.sessionId)
  const latest = current.at(-1)
  if (previous) {
    if (incoming.sequence < previous.sequence) {
      throw new PlayerSnapshotError('PLAYER_HISTORY_SEQUENCE_REGRESSION')
    }
    if (incoming.sequence === previous.sequence) {
      if (incoming.fingerprint !== previous.fingerprint) {
        throw new PlayerSnapshotError('PLAYER_HISTORY_SEQUENCE_CONFLICT')
      }
      // An exact replay is idempotent only for the globally latest accepted snapshot. Accepting
      // an older session's replay would let the raw route observation diverge from the retained
      // authoritative projection.
      if (latest?.sessionId !== incoming.sessionId) {
        throw new PlayerSnapshotError('PLAYER_HISTORY_SESSION_REPLAY')
      }
      return 'replay'
    }
  }

  // The final retained cursor is a bounded global clock high-water. New accepted snapshots must
  // advance it strictly, including sessions whose per-session cursor has already been evicted.
  if (latest && incoming.writtenAtUnixMs <= latest.writtenAtUnixMs) {
    throw new PlayerSnapshotError('PLAYER_HISTORY_TIME_REGRESSION')
  }
  return 'advance'
}

function advanceCursors(
  current: PlayerSnapshotCursor[],
  incoming: PlayerSnapshotCursor,
  authoritativeSessionId: string | null
): PlayerSnapshotCursor[] {
  const next = current.filter((cursor) => cursor.sessionId !== incoming.sessionId)
    .map((cursor) => ({ ...cursor }))
  next.push({ ...incoming })
  while (next.length > maximumPlayerHistoryCursors) {
    const removable = next.findIndex((cursor) =>
      cursor.sessionId !== authoritativeSessionId && cursor.sessionId !== incoming.sessionId
    )
    if (removable < 0) throw new PlayerSnapshotError('PLAYER_HISTORY_PERSISTENCE_INVALID')
    next.splice(removable, 1)
  }
  return next
}

function serializeCursors(cursors: PlayerSnapshotCursor[]): string {
  return JSON.stringify(cursors.map((cursor) => ({
    sessionId: cursor.sessionId,
    sequence: cursor.sequence,
    writtenAtUnixMs: cursor.writtenAtUnixMs,
    state: cursor.state,
    fingerprint: cursor.fingerprint
  })))
}

function fingerprintSnapshot(snapshot: PlayerSnapshot): string {
  return fingerprintSnapshotFields(
    snapshot.sessionId,
    snapshot.sequence,
    snapshot.writtenAtUnixMs,
    snapshot.state,
    snapshot.truncated,
    snapshot.players
  )
}

function fingerprintProjection(projection: AuthoritativeProjection): string {
  return fingerprintSnapshotFields(
    projection.sessionId,
    projection.snapshotSequence,
    projection.writtenAtUnixMs,
    projection.state,
    projection.truncated,
    projection.players
  )
}

function fingerprintSnapshotFields(
  sessionId: string,
  sequence: number,
  writtenAtUnixMs: number,
  state: PlayerSnapshot['state'],
  truncated: boolean,
  players: PlayerSnapshotEntry[]
): string {
  const canonical = JSON.stringify({
    sessionId,
    sequence,
    writtenAtUnixMs,
    state,
    truncated,
    players: players.map((player) => ({
      sessionPlayerId: player.sessionPlayerId,
      displayName: player.displayName,
      online: true,
      joinedAtUnixMs: player.joinedAtUnixMs,
      location: player.location
    }))
  })
  return createHash('sha256').update(canonical, 'utf8').digest('hex')
}

function parseStoredEvent(row: StoredPlayerPresenceEventRow): PlayerPresenceEvent {
  if (!isRecordWithExactKeys(row, [
    'historySequence', 'type', 'occurredAtUnixMs', 'sessionId', 'sessionPlayerId',
    'displayName', 'online', 'joinedAtUnixMs', 'location'
  ]) || !isSafePositiveInteger(row.historySequence) ||
      (row.type !== 'join' && row.type !== 'leave') ||
      !isSafePositiveInteger(row.occurredAtUnixMs) || !isSessionId(row.sessionId) ||
      (row.online !== 0 && row.online !== 1) || row.online !== (row.type === 'join' ? 1 : 0)) {
    throw new PlayerSnapshotError('PLAYER_HISTORY_PERSISTENCE_INVALID')
  }
  const player = parsePlayer({
    sessionPlayerId: row.sessionPlayerId,
    displayName: row.displayName,
    online: true,
    joinedAtUnixMs: row.joinedAtUnixMs,
    location: row.location
  }, Math.max(row.occurredAtUnixMs as number, row.joinedAtUnixMs as number), false)
  if (row.occurredAtUnixMs < player.joinedAtUnixMs - 5_000) {
    throw new PlayerSnapshotError('PLAYER_HISTORY_PERSISTENCE_INVALID')
  }
  return {
    historySequence: row.historySequence,
    type: row.type,
    occurredAtUnixMs: row.occurredAtUnixMs,
    sessionId: row.sessionId.toLowerCase(),
    player: { ...player, online: row.online === 1 }
  }
}

function parsePlayer(
  value: unknown,
  writtenAtUnixMs: number,
  requireOnline: boolean,
  errorCode = 'PLAYER_HISTORY_PERSISTENCE_INVALID'
): PlayerSnapshotEntry {
  if (!isRecordWithExactKeys(value, [
    'sessionPlayerId', 'displayName', 'online', 'joinedAtUnixMs', 'location'
  ]) || typeof value.sessionPlayerId !== 'string' ||
      !/^player-[0-9]{6,12}$/.test(value.sessionPlayerId) ||
      typeof value.displayName !== 'string' || value.displayName.trim().length === 0 ||
      [...value.displayName].length > 64 || Buffer.byteLength(value.displayName, 'utf8') > 128 ||
      /[\0\r\n]/.test(value.displayName) ||
      (requireOnline && value.online !== true) ||
      !isSafePositiveInteger(value.joinedAtUnixMs) || value.joinedAtUnixMs > writtenAtUnixMs + 5_000 ||
      typeof value.location !== 'string' ||
      !/^(?:deep-space|planet:[1-9][0-9]{0,9}|star:[1-9][0-9]{0,9})$/.test(value.location)) {
    throw new PlayerSnapshotError(errorCode)
  }
  return {
    sessionPlayerId: value.sessionPlayerId,
    displayName: value.displayName,
    online: true,
    joinedAtUnixMs: value.joinedAtUnixMs,
    location: value.location
  }
}

function serializeProjection(projection: AuthoritativeProjection): string {
  return JSON.stringify({
    schemaVersion: 1,
    sessionId: projection.sessionId,
    snapshotSequence: projection.snapshotSequence,
    writtenAtUnixMs: projection.writtenAtUnixMs,
    state: projection.state,
    truncated: projection.truncated,
    players: projection.players.map((player) => ({
      sessionPlayerId: player.sessionPlayerId,
      displayName: player.displayName,
      online: true,
      joinedAtUnixMs: player.joinedAtUnixMs,
      location: player.location
    }))
  })
}

function publicProjection(projection: AuthoritativeProjection): PlayerPresenceAuthoritativeSnapshot {
  return {
    sessionId: projection.sessionId,
    sequence: projection.snapshotSequence,
    writtenAtUnixMs: projection.writtenAtUnixMs,
    state: projection.state,
    truncated: projection.truncated,
    players: projection.players.map(clonePlayer)
  }
}

function assertStrictPlayerOrder(
  players: PlayerSnapshotEntry[],
  code = 'PLAYER_HISTORY_SNAPSHOT_INVALID'
): void {
  for (let index = 1; index < players.length; index++) {
    if (players[index - 1]!.sessionPlayerId >= players[index]!.sessionPlayerId) {
      throw new PlayerSnapshotError(code)
    }
  }
}

function isRecordWithExactKeys(value: unknown, expectedKeys: readonly string[]): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const keys = Object.keys(value)
  return keys.length === expectedKeys.length && expectedKeys.every((key, index) => keys[index] === key)
}

function isSafePositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
}

function isSessionId(value: unknown): value is string {
  return typeof value === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)
}

function sortedPlayers(players: Iterable<PlayerSnapshotEntry>): PlayerSnapshotEntry[] {
  return [...players].sort((left, right) => {
    if (left.joinedAtUnixMs !== right.joinedAtUnixMs) return left.joinedAtUnixMs - right.joinedAtUnixMs
    return left.sessionPlayerId < right.sessionPlayerId ? -1 : left.sessionPlayerId > right.sessionPlayerId ? 1 : 0
  })
}

function clonePlayer(player: PlayerSnapshotEntry): PlayerSnapshotEntry {
  return { ...player }
}

function cloneEvent(event: PlayerPresenceEvent): PlayerPresenceEvent {
  return { ...event, player: { ...event.player } }
}
