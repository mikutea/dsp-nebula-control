import { createHash } from 'node:crypto'
import { z } from 'zod'
import { backupIdSchema, saveNameSchema } from './schemas.js'

const ARCHIVE_MAGIC = Buffer.from('DYSONPAIRARCHV1\n', 'ascii')
const ARCHIVE_END = Buffer.from('DYSONPAIREND1\n', 'ascii')
const ENTRY_COUNT = 3
const MAX_ENTRY_NAME_BYTES = 240
const IO_CHUNK_BYTES = 1024 * 1024

const sha256Schema = z.string().length(64).regex(/^[a-f0-9]{64}$/)
const isoDateSchema = z.string().datetime({ offset: true })
const transportFileSchema = z.strictObject({
  name: z.string().min(5).max(127),
  bytes: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  sha256: sha256Schema
})

export const savePairTransportManifestSchema = z.strictObject({
  format: z.literal('dyson-control-save-pair-transport'),
  schemaVersion: z.literal(1),
  saveName: saveNameSchema,
  generatedAt: isoDateSchema,
  generation: z.strictObject({ strategy: z.literal('source-backup-created-at') }),
  source: z.strictObject({
    kind: z.literal('verified-backup'),
    backupId: backupIdSchema,
    createdAt: isoDateSchema,
    manifestSha256: sha256Schema
  }),
  files: z.array(transportFileSchema).length(2)
}).superRefine((manifest, context) => {
  const expected = [`${manifest.saveName}.dsv`, `${manifest.saveName}.server`]
  if (manifest.files[0]?.name !== expected[0] || manifest.files[1]?.name !== expected[1]) {
    context.addIssue({ code: 'custom', message: 'transport pair identity mismatch' })
  }
})

export type SavePairTransportManifest = z.infer<typeof savePairTransportManifestSchema>

export interface SavePairTransportLimits {
  maximumArchiveBytes: number
  maximumFileBytes: number
  maximumPairBytes: number
  maximumManifestBytes: number
  maximumInputChunkBytes: number
}

export interface SavePairTransportSourceEntry {
  name: string
  bytes: number
  sha256: string
  source: AsyncIterable<Uint8Array>
}

export interface SavePairTransportSink {
  write(chunk: Uint8Array): Promise<void>
}

export interface SavePairTransportFileSink extends SavePairTransportSink {
  close(): Promise<void>
  abort(): Promise<void>
}

export interface SavePairTransportWriteResult {
  bytes: number
  sha256: string
}

export interface SavePairTransportVerification {
  manifest: SavePairTransportManifest
  archiveBytes: number
  archiveSha256: string
}

export interface VerifySavePairTransportOptions {
  source: AsyncIterable<Uint8Array>
  declaredBytes: number
  declaredSha256: string
  limits?: Partial<SavePairTransportLimits>
  createFileSink?: (file: SavePairTransportManifest['files'][number]) => Promise<SavePairTransportFileSink>
}

export class SaveTransferError extends Error {
  readonly code: string

  constructor(code: string, options?: ErrorOptions) {
    super(code, options)
    this.name = 'SaveTransferError'
    this.code = code
  }
}

export const defaultSavePairTransportLimits: Readonly<SavePairTransportLimits> = Object.freeze({
  maximumArchiveBytes: 16 * 1024 * 1024 * 1024,
  maximumFileBytes: 8 * 1024 * 1024 * 1024,
  maximumPairBytes: 16 * 1024 * 1024 * 1024 - 1024 * 1024,
  maximumManifestBytes: 16 * 1024,
  maximumInputChunkBytes: 2 * 1024 * 1024
})

export async function writeSavePairTransportArchive(options: {
  manifest: SavePairTransportManifest
  entries: readonly [SavePairTransportSourceEntry, SavePairTransportSourceEntry]
  sink: SavePairTransportSink
  limits?: Partial<SavePairTransportLimits>
}): Promise<SavePairTransportWriteResult> {
  const limits = parseLimits(options.limits)
  const manifest = parseManifest(options.manifest, limits)
  validateSourceEntries(manifest, options.entries, limits)
  const writer = new HashedWriter(options.sink, limits.maximumArchiveBytes)
  await writer.write(ARCHIVE_MAGIC)
  await writer.write(unsigned16(ENTRY_COUNT))
  await writeRecord(
    writer,
    'manifest.json',
    canonicalManifestBytes(manifest),
    limits,
    undefined
  )
  for (const entry of options.entries) {
    await writeRecord(writer, entry.name, entry.source, limits, {
      bytes: entry.bytes,
      sha256: entry.sha256
    })
  }
  await writer.write(ARCHIVE_END)
  return writer.finish()
}

export async function verifySavePairTransportArchive(
  options: VerifySavePairTransportOptions
): Promise<SavePairTransportVerification> {
  const limits = parseLimits(options.limits)
  const declared = parseDeclaredArchive(options.declaredBytes, options.declaredSha256, limits)
  const reader = new BoundedHashedReader(options.source, declared.bytes, limits)
  await expectBytes(reader, ARCHIVE_MAGIC, 'SAVE_TRANSFER_ARCHIVE_MAGIC_INVALID')
  const entryCount = (await reader.readExact(2)).readUInt16BE(0)
  if (entryCount !== ENTRY_COUNT) throw new SaveTransferError('SAVE_TRANSFER_ENTRY_COUNT_INVALID')

  const seen = new Set<string>()
  const manifestRecord = await readRecord(reader, limits, async (name, bytes) => {
    if (name !== 'manifest.json') throw new SaveTransferError('SAVE_TRANSFER_ENTRY_ORDER_INVALID')
    if (bytes > limits.maximumManifestBytes) throw new SaveTransferError('SAVE_TRANSFER_MANIFEST_TOO_LARGE')
    return new MemorySink(bytes)
  })
  seen.add(manifestRecord.name.toLocaleLowerCase('en-US'))
  const memory = manifestRecord.sink
  if (!(memory instanceof MemorySink)) throw new SaveTransferError('SAVE_TRANSFER_MANIFEST_INVALID')
  const manifestBytes = memory.bytes()
  let manifest: SavePairTransportManifest
  try {
    const decoded = new TextDecoder('utf-8', { fatal: true }).decode(manifestBytes)
    manifest = parseManifest(JSON.parse(decoded) as unknown, limits)
    if (!manifestBytes.equals(canonicalManifestBytes(manifest))) {
      throw new SaveTransferError('SAVE_TRANSFER_MANIFEST_NOT_CANONICAL')
    }
  } catch (error) {
    if (error instanceof SaveTransferError) throw error
    throw new SaveTransferError('SAVE_TRANSFER_MANIFEST_INVALID', { cause: error })
  }

  for (const expected of manifest.files) {
    const record = await readRecord(reader, limits, async (name, bytes) => {
      assertPortableEntryName(name)
      const canonical = name.toLocaleLowerCase('en-US')
      if (seen.has(canonical)) throw new SaveTransferError('SAVE_TRANSFER_ENTRY_DUPLICATE')
      seen.add(canonical)
      if (name !== expected.name || bytes !== expected.bytes) {
        throw new SaveTransferError('SAVE_TRANSFER_PAIR_MISMATCH')
      }
      return options.createFileSink === undefined
        ? new DiscardSink()
        : await options.createFileSink(expected)
    })
    if (record.name !== expected.name || record.bytes !== expected.bytes || record.sha256 !== expected.sha256) {
      throw new SaveTransferError('SAVE_TRANSFER_PAIR_MISMATCH')
    }
  }

  await expectBytes(reader, ARCHIVE_END, 'SAVE_TRANSFER_ARCHIVE_END_INVALID')
  const archive = await reader.finish()
  if (archive.sha256 !== declared.sha256) throw new SaveTransferError('SAVE_TRANSFER_ARCHIVE_HASH_MISMATCH')
  return { manifest, archiveBytes: archive.bytes, archiveSha256: archive.sha256 }
}

export function canonicalManifestBytes(manifest: SavePairTransportManifest): Buffer {
  return Buffer.from(JSON.stringify(savePairTransportManifestSchema.parse(manifest)), 'utf8')
}

function parseManifest(input: unknown, limits: SavePairTransportLimits): SavePairTransportManifest {
  let manifest: SavePairTransportManifest
  try {
    manifest = savePairTransportManifestSchema.parse(input)
  } catch (error) {
    throw new SaveTransferError('SAVE_TRANSFER_MANIFEST_INVALID', { cause: error })
  }
  assertPortableSaveName(manifest.saveName)
  const total = manifest.files.reduce((sum, file) => sum + file.bytes, 0)
  if (!Number.isSafeInteger(total) || total > limits.maximumPairBytes ||
      manifest.files.some((file) => file.bytes > limits.maximumFileBytes)) {
    throw new SaveTransferError('SAVE_TRANSFER_PAIR_TOO_LARGE')
  }
  for (const file of manifest.files) assertPortableEntryName(file.name)
  return manifest
}

function validateSourceEntries(
  manifest: SavePairTransportManifest,
  entries: readonly SavePairTransportSourceEntry[],
  limits: SavePairTransportLimits
): void {
  if (entries.length !== 2) throw new SaveTransferError('SAVE_TRANSFER_ENTRY_COUNT_INVALID')
  for (let index = 0; index < entries.length; index++) {
    const entry = entries[index]!
    const expected = manifest.files[index]!
    assertPortableEntryName(entry.name)
    if (entry.name !== expected.name || entry.bytes !== expected.bytes ||
        entry.sha256.toLowerCase() !== expected.sha256) {
      throw new SaveTransferError('SAVE_TRANSFER_PAIR_MISMATCH')
    }
  }
}

async function writeRecord(
  writer: HashedWriter,
  name: string,
  source: Uint8Array | AsyncIterable<Uint8Array>,
  limits: SavePairTransportLimits,
  expected: { bytes: number; sha256: string } | undefined
): Promise<void> {
  assertPortableEntryName(name)
  const nameBytes = Buffer.from(name, 'utf8')
  const contentBytes = expected?.bytes ?? (source as Uint8Array).byteLength
  if (!Number.isSafeInteger(contentBytes) || contentBytes < 0 || contentBytes > limits.maximumFileBytes) {
    throw new SaveTransferError('SAVE_TRANSFER_ENTRY_TOO_LARGE')
  }
  await writer.write(unsigned16(nameBytes.length))
  await writer.write(nameBytes)
  await writer.write(unsigned64(contentBytes))

  const digest = createHash('sha256')
  const crc = new Crc32()
  let written = 0
  try {
    for await (const raw of toAsyncIterable(source)) {
      const chunk = Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength)
      if (chunk.length === 0) continue
      if (chunk.length > limits.maximumInputChunkBytes) {
        throw new SaveTransferError('SAVE_TRANSFER_SOURCE_CHUNK_TOO_LARGE')
      }
      written += chunk.length
      if (written > contentBytes) throw new SaveTransferError('SAVE_TRANSFER_SOURCE_SIZE_MISMATCH')
      digest.update(chunk)
      crc.update(chunk)
      await writer.write(chunk)
    }
  } catch (error) {
    if (error instanceof SaveTransferError) throw error
    throw new SaveTransferError('SAVE_TRANSFER_SOURCE_INTERRUPTED', { cause: error })
  }
  const sha256 = digest.digest('hex')
  if (written !== contentBytes || (expected !== undefined && sha256 !== expected.sha256.toLowerCase())) {
    throw new SaveTransferError('SAVE_TRANSFER_SOURCE_SIZE_OR_HASH_MISMATCH')
  }
  await writer.write(Buffer.from(sha256, 'hex'))
  await writer.write(unsigned32(crc.digest()))
}

async function readRecord(
  reader: BoundedHashedReader,
  limits: SavePairTransportLimits,
  createSink: (name: string, bytes: number) => Promise<SavePairTransportFileSink>
): Promise<{ name: string; bytes: number; sha256: string; sink: SavePairTransportFileSink }> {
  const nameLength = (await reader.readExact(2)).readUInt16BE(0)
  if (nameLength < 1 || nameLength > MAX_ENTRY_NAME_BYTES) {
    throw new SaveTransferError('SAVE_TRANSFER_ENTRY_NAME_INVALID')
  }
  let name: string
  try {
    name = new TextDecoder('utf-8', { fatal: true }).decode(await reader.readExact(nameLength))
  } catch (error) {
    throw new SaveTransferError('SAVE_TRANSFER_ENTRY_NAME_INVALID', { cause: error })
  }
  assertPortableEntryName(name)
  const bytesBig = (await reader.readExact(8)).readBigUInt64BE(0)
  if (bytesBig > BigInt(Number.MAX_SAFE_INTEGER) || bytesBig > BigInt(limits.maximumFileBytes)) {
    throw new SaveTransferError('SAVE_TRANSFER_ENTRY_TOO_LARGE')
  }
  const bytes = Number(bytesBig)
  const sink = await createSink(name, bytes)
  const digest = createHash('sha256')
  const crc = new Crc32()
  let remaining = bytes
  try {
    while (remaining > 0) {
      const chunk = await reader.readAtMost(Math.min(remaining, IO_CHUNK_BYTES))
      if (chunk.length === 0) throw new SaveTransferError('SAVE_TRANSFER_ARCHIVE_TRUNCATED')
      digest.update(chunk)
      crc.update(chunk)
      await sink.write(chunk)
      remaining -= chunk.length
    }
    const expectedSha = (await reader.readExact(32)).toString('hex')
    const expectedCrc = (await reader.readExact(4)).readUInt32BE(0)
    const sha256 = digest.digest('hex')
    if (sha256 !== expectedSha) throw new SaveTransferError('SAVE_TRANSFER_ENTRY_HASH_MISMATCH')
    if (crc.digest() !== expectedCrc) throw new SaveTransferError('SAVE_TRANSFER_ENTRY_CRC_MISMATCH')
    await sink.close()
    return { name, bytes, sha256, sink }
  } catch (error) {
    await sink.abort().catch(() => undefined)
    throw error
  }
}

class HashedWriter {
  readonly #sink: SavePairTransportSink
  readonly #maximumBytes: number
  readonly #hash = createHash('sha256')
  #bytes = 0
  #finished = false

  constructor(sink: SavePairTransportSink, maximumBytes: number) {
    this.#sink = sink
    this.#maximumBytes = maximumBytes
  }

  async write(chunk: Uint8Array): Promise<void> {
    if (this.#finished) throw new SaveTransferError('SAVE_TRANSFER_WRITER_FINISHED')
    this.#bytes += chunk.byteLength
    if (!Number.isSafeInteger(this.#bytes) || this.#bytes > this.#maximumBytes) {
      throw new SaveTransferError('SAVE_TRANSFER_ARCHIVE_TOO_LARGE')
    }
    this.#hash.update(chunk)
    await this.#sink.write(chunk)
  }

  finish(): SavePairTransportWriteResult {
    if (this.#finished) throw new SaveTransferError('SAVE_TRANSFER_WRITER_FINISHED')
    this.#finished = true
    return { bytes: this.#bytes, sha256: this.#hash.digest('hex') }
  }
}

class BoundedHashedReader {
  readonly #iterator: AsyncIterator<Uint8Array>
  readonly #declaredBytes: number
  readonly #limits: SavePairTransportLimits
  readonly #hash = createHash('sha256')
  #current: Buffer | null = null
  #offset = 0
  #bytes = 0
  #done = false

  constructor(source: AsyncIterable<Uint8Array>, declaredBytes: number, limits: SavePairTransportLimits) {
    this.#iterator = source[Symbol.asyncIterator]()
    this.#declaredBytes = declaredBytes
    this.#limits = limits
  }

  async readExact(length: number): Promise<Buffer> {
    const output = Buffer.allocUnsafe(length)
    let offset = 0
    while (offset < length) {
      const chunk = await this.readAtMost(length - offset)
      if (chunk.length === 0) throw new SaveTransferError('SAVE_TRANSFER_ARCHIVE_TRUNCATED')
      chunk.copy(output, offset)
      offset += chunk.length
    }
    return output
  }

  async readAtMost(maximum: number): Promise<Buffer> {
    if (maximum < 1) return Buffer.alloc(0)
    while (this.#current === null || this.#offset >= this.#current.length) {
      if (this.#done) return Buffer.alloc(0)
      let next: IteratorResult<Uint8Array>
      try {
        next = await this.#iterator.next()
      } catch (error) {
        throw new SaveTransferError('SAVE_TRANSFER_SOURCE_INTERRUPTED', { cause: error })
      }
      if (next.done === true) {
        this.#done = true
        this.#current = null
        return Buffer.alloc(0)
      }
      if (!(next.value instanceof Uint8Array) || next.value.byteLength > this.#limits.maximumInputChunkBytes) {
        throw new SaveTransferError('SAVE_TRANSFER_SOURCE_CHUNK_INVALID')
      }
      if (next.value.byteLength === 0) continue
      this.#current = Buffer.from(next.value.buffer, next.value.byteOffset, next.value.byteLength)
      this.#offset = 0
    }
    const length = Math.min(maximum, this.#current.length - this.#offset)
    const chunk = this.#current.subarray(this.#offset, this.#offset + length)
    this.#offset += length
    this.#bytes += length
    if (this.#bytes > this.#declaredBytes || this.#bytes > this.#limits.maximumArchiveBytes) {
      throw new SaveTransferError('SAVE_TRANSFER_ARCHIVE_TOO_LARGE')
    }
    this.#hash.update(chunk)
    return chunk
  }

  async finish(): Promise<SavePairTransportWriteResult> {
    const trailing = await this.readAtMost(1)
    if (trailing.length !== 0) throw new SaveTransferError('SAVE_TRANSFER_ARCHIVE_TRAILING_DATA')
    if (this.#bytes !== this.#declaredBytes) throw new SaveTransferError('SAVE_TRANSFER_ARCHIVE_SIZE_MISMATCH')
    return { bytes: this.#bytes, sha256: this.#hash.digest('hex') }
  }
}

class MemorySink implements SavePairTransportFileSink {
  readonly #expected: number
  readonly #chunks: Buffer[] = []
  #bytes = 0

  constructor(expected: number) {
    this.#expected = expected
  }

  async write(chunk: Uint8Array): Promise<void> {
    this.#bytes += chunk.byteLength
    if (this.#bytes > this.#expected) throw new SaveTransferError('SAVE_TRANSFER_MANIFEST_TOO_LARGE')
    this.#chunks.push(Buffer.from(chunk))
  }

  async close(): Promise<void> {
    if (this.#bytes !== this.#expected) throw new SaveTransferError('SAVE_TRANSFER_ARCHIVE_TRUNCATED')
  }

  async abort(): Promise<void> {
    this.#chunks.length = 0
  }

  bytes(): Buffer {
    return Buffer.concat(this.#chunks, this.#bytes)
  }
}

class DiscardSink implements SavePairTransportFileSink {
  async write(_chunk: Uint8Array): Promise<void> {}
  async close(): Promise<void> {}
  async abort(): Promise<void> {}
}

class Crc32 {
  #value = 0xffffffff

  update(bytes: Uint8Array): void {
    for (const byte of bytes) this.#value = (CRC_TABLE[(this.#value ^ byte) & 0xff]! ^ (this.#value >>> 8)) >>> 0
  }

  digest(): number {
    return (this.#value ^ 0xffffffff) >>> 0
  }
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let index = 0; index < table.length; index++) {
    let value = index
    for (let bit = 0; bit < 8; bit++) value = (value & 1) !== 0 ? 0xedb88320 ^ (value >>> 1) : value >>> 1
    table[index] = value >>> 0
  }
  return table
})()

function parseLimits(overrides: Partial<SavePairTransportLimits> | undefined): SavePairTransportLimits {
  const limits = { ...defaultSavePairTransportLimits, ...overrides }
  if (Object.values(limits).some((value) => !Number.isSafeInteger(value) || value < 1024) ||
      limits.maximumFileBytes > limits.maximumPairBytes ||
      limits.maximumPairBytes >= limits.maximumArchiveBytes ||
      limits.maximumManifestBytes > 1024 * 1024 ||
      limits.maximumInputChunkBytes > 16 * 1024 * 1024) {
    throw new SaveTransferError('SAVE_TRANSFER_LIMITS_INVALID')
  }
  return limits
}

function parseDeclaredArchive(bytes: number, sha256: string, limits: SavePairTransportLimits): {
  bytes: number
  sha256: string
} {
  const parsed = z.strictObject({
    bytes: z.number().int().positive().max(limits.maximumArchiveBytes),
    sha256: sha256Schema
  }).safeParse({ bytes, sha256: typeof sha256 === 'string' ? sha256.toLowerCase() : sha256 })
  if (!parsed.success) throw new SaveTransferError('SAVE_TRANSFER_REQUEST_INVALID')
  return parsed.data
}

function assertPortableSaveName(saveName: string): void {
  if (!saveNameSchema.safeParse(saveName).success || saveName.endsWith(' ') || saveName.endsWith('.') || isDeviceName(saveName)) {
    throw new SaveTransferError('SAVE_TRANSFER_SAVE_NAME_INVALID')
  }
}

function assertPortableEntryName(name: string): void {
  const encoded = Buffer.from(name, 'utf8')
  if (encoded.length < 1 || encoded.length > MAX_ENTRY_NAME_BYTES ||
      name.includes('/') || name.includes('\\') || name.includes(':') ||
      name.startsWith('.') && name !== 'manifest.json' ||
      name.endsWith('.') || name.endsWith(' ') ||
      /[\u0000-\u001f<>"|?*]/u.test(name) || isDeviceName(name)) {
    throw new SaveTransferError('SAVE_TRANSFER_ENTRY_NAME_INVALID')
  }
}

function isDeviceName(name: string): boolean {
  const base = name.split('.', 1)[0]!.toLocaleUpperCase('en-US')
  return /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/.test(base)
}

function unsigned16(value: number): Buffer {
  const output = Buffer.allocUnsafe(2)
  output.writeUInt16BE(value)
  return output
}

function unsigned32(value: number): Buffer {
  const output = Buffer.allocUnsafe(4)
  output.writeUInt32BE(value)
  return output
}

function unsigned64(value: number): Buffer {
  const output = Buffer.allocUnsafe(8)
  output.writeBigUInt64BE(BigInt(value))
  return output
}

async function expectBytes(reader: BoundedHashedReader, expected: Buffer, code: string): Promise<void> {
  if (!(await reader.readExact(expected.length)).equals(expected)) throw new SaveTransferError(code)
}

async function* toAsyncIterable(source: Uint8Array | AsyncIterable<Uint8Array>): AsyncIterable<Uint8Array> {
  if (source instanceof Uint8Array) {
    yield source
    return
  }
  yield* source
}
