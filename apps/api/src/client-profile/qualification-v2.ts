import { z } from 'zod'
import { isIP } from 'node:net'
import { serializeClientParityManifest } from '../mods/manifest.js'
import {
  assessClientProfile,
  type AssessedClientProfileInput
} from './parity.js'
import {
  assertDigestEqual,
  bareSha256,
  canonicalJson,
  hmacSha256Canonical,
  parseStrictCanonicalJsonBytes,
  parseStrictJsonBytes,
  sha256Bytes,
  sha256Canonical
} from './canonical.js'
import {
  ClientQualificationStoreError,
  assertSafeRelativePath,
  type ProtectedClientQualificationStore
} from './qualification-store.js'
import { sha256 } from './artifact.js'

export const HOSTNAME_WSS_QUALIFICATION_PROTOCOL = 'DYSON_NEBULA_HOSTNAME_WSS_QUALIFICATION_V1' as const
export const HOSTNAME_WSS_COLLECTOR_RECEIPT_PROTOCOL = 'DYSON_NEBULA_HOSTNAME_WSS_COLLECTOR_RECEIPT_V1' as const
export const QUALIFIED_CLIENT_MANIFEST_PROTOCOL = 'DYSON_QUALIFIED_CLIENT_MANIFEST_V1' as const

const digestSchema = z.string().regex(/^sha256:[0-9a-f]{64}$/)
const bareSha256Schema = z.string().regex(/^[0-9a-f]{64}$/)
const gitCommitSchema = z.string().regex(/^[0-9a-f]{40}$/)
const uuidSchema = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
const identifierSchema = z.string().min(8).max(128).refine(isBoundedIdentifier)
const mvidSchema = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
const utcMillisecondsSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
  .refine((value) => {
    const time = Date.parse(value)
    return Number.isFinite(time) && new Date(time).toISOString() === value
  })
const safeCountSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
const safePositiveSizeSchema = z.number().int().positive().max(Number.MAX_SAFE_INTEGER)
const relativePathSchema = z.string().min(1).max(512).refine(isSafeRelativePath)
const publicHostnameSchema = z.string().min(4).max(253).regex(/^[a-z0-9.-]+$/).refine(isPublicHostname)

export const qualifiedClientProfileRequestV2Schema = z.strictObject({
  schemaVersion: z.literal(2),
  qualificationId: uuidSchema
})

const protectionSchema = z.strictObject({
  algorithm: z.literal('hmac-sha256'),
  keyId: identifierSchema,
  hmacSha256: digestSchema
})

const subjectSchema = z.strictObject({
  authority: publicHostnameSchema,
  port: z.literal(443),
  topology: z.literal('http-websocket-tunnel'),
  transport: z.literal('wss'),
  websocketPath: z.literal('/socket'),
  authoritySemantics: z.literal('hostname-preserved')
})

export const hostnameWssContractBindingSchema = z.strictObject({
  sourcePatchContractSha256: digestSchema,
  privateBuildContractSha256: digestSchema,
  binaryMetadataASha256: digestSchema,
  binaryMetadataBSha256: digestSchema,
  upstreamCommit: gitCommitSchema,
  patchSha256: digestSchema,
  candidateManifestSha256: digestSchema,
  candidateTreeSha256: digestSchema,
  clientManifestSha256: digestSchema,
  clientPackageSha256: digestSchema,
  profileInputSha256: digestSchema,
  serverLockSha256: digestSchema,
  clientParitySha256: digestSchema,
  compatibilityPolicySha256: digestSchema
})

const binaryEvidenceSchema = z.strictObject({
  role: z.enum(['nebula-network', 'nebula-patcher']),
  fileName: z.enum(['NebulaNetwork.dll', 'NebulaPatcher.dll']),
  sha256: digestSchema,
  mvid: mvidSchema
})

const binaryPairSchema = z.tuple([binaryEvidenceSchema, binaryEvidenceSchema]).superRefine((value, context) => {
  if (value[0].role !== 'nebula-network' || value[0].fileName !== 'NebulaNetwork.dll' ||
      value[1].role !== 'nebula-patcher' || value[1].fileName !== 'NebulaPatcher.dll') {
    context.addIssue({ code: 'custom', message: 'binary binding order or role mismatch' })
  }
})

export const hostnameWssBinaryBindingSchema = z.strictObject({
  candidate: binaryPairSchema,
  client: binaryPairSchema
})

const transportBindingSchema = z.strictObject({
  sniAuthority: publicHostnameSchema,
  hostHeaderAuthority: z.string().min(8).max(257),
  websocketPath: z.literal('/socket'),
  tlsProtocol: z.enum(['tls12', 'tls13']),
  httpStatusCode: z.literal(101),
  ingressProvider: z.literal('cloudflare-tunnel'),
  ingressConfigSha256: digestSchema,
  originBindingSha256: digestSchema,
  websocketTranscriptSha256: digestSchema,
  sessionBindingSha256: digestSchema
})

const routeCountersSchema = z.strictObject({
  packetsBefore: safeCountSchema,
  packetsAfter: safeCountSchema,
  bytesBefore: safeCountSchema,
  bytesAfter: safeCountSchema
})

const routeBindingSchema = z.strictObject({
  ruleRevisionBefore: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  ruleRevisionAfter: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  ruleIdentitySha256: digestSchema,
  flowBindingSha256: digestSchema,
  sessionBindingSha256: digestSchema,
  directCounters: routeCountersSchema,
  proxyCounters: routeCountersSchema
})

const externalClientBindingSchema = z.strictObject({
  receiptChainSha256: digestSchema,
  receiptCount: z.literal(11),
  terminalReceiptSha256: digestSchema,
  joinReceiptSha256: digestSchema,
  reconnectReceiptSha256: digestSchema,
  initialChallengeId: uuidSchema,
  reconnectChallengeId: uuidSchema,
  transcriptBindingSha256: digestSchema,
  sessionBindingSha256: digestSchema,
  observedAtUtc: utcMillisecondsSchema,
  expiresAtUtc: utcMillisecondsSchema
})

const challengeIdsSchema = z.strictObject({
  initial: uuidSchema,
  reconnect: uuidSchema
}).refine((value) => value.initial !== value.reconnect)

const collectorReceiptSchema = z.strictObject({
  protocol: z.literal(HOSTNAME_WSS_COLLECTOR_RECEIPT_PROTOCOL),
  schemaVersion: z.literal(1),
  receiptId: uuidSchema,
  qualificationId: uuidSchema,
  runId: uuidSchema,
  collectorId: identifierSchema,
  keyId: identifierSchema,
  sequence: z.number().int().min(1).max(4),
  evidenceType: z.enum(['build-binary', 'wss-transport', 'passwall-route', 'external-client']),
  challengeIds: challengeIdsSchema,
  sessionId: uuidSchema,
  nonce: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  observedAtUtc: utcMillisecondsSchema,
  expiresAtUtc: utcMillisecondsSchema,
  previousReceiptSha256: digestSchema.nullable(),
  evidenceSha256: digestSchema,
  receiptSha256: digestSchema,
  hmacSha256: digestSchema
})

export const hostnameWssQualificationDocumentSchema = z.strictObject({
  protocol: z.literal(HOSTNAME_WSS_QUALIFICATION_PROTOCOL),
  schemaVersion: z.literal(1),
  qualificationId: uuidSchema,
  runId: uuidSchema,
  issuedAtUtc: utcMillisecondsSchema,
  expiresAtUtc: utcMillisecondsSchema,
  subject: subjectSchema,
  contractBinding: hostnameWssContractBindingSchema,
  binaryBinding: hostnameWssBinaryBindingSchema,
  transportBinding: transportBindingSchema,
  routeBinding: routeBindingSchema,
  externalClientBinding: externalClientBindingSchema,
  receiptChain: z.tuple([
    collectorReceiptSchema,
    collectorReceiptSchema,
    collectorReceiptSchema,
    collectorReceiptSchema
  ]),
  documentSha256: digestSchema,
  protection: protectionSchema
})

const clientManifestFileSchema = z.strictObject({
  path: relativePathSchema,
  size: safePositiveSizeSchema,
  sha256: digestSchema
})

export const qualifiedClientManifestSchema = z.strictObject({
  protocol: z.literal(QUALIFIED_CLIENT_MANIFEST_PROTOCOL),
  schemaVersion: z.literal(1),
  qualificationId: uuidSchema,
  createdAtUtc: utcMillisecondsSchema,
  files: z.array(clientManifestFileSchema).min(2).max(4096),
  treeSha256: digestSchema,
  packageSha256: digestSchema,
  manifestSha256: digestSchema
})

const candidateFileSchema = z.strictObject({
  path: relativePathSchema,
  size: safePositiveSizeSchema,
  sha256: bareSha256Schema,
  origin: z.enum(['private-build', 'official-stock'])
})

const candidateManifestSchema = z.strictObject({
  protocol: z.literal('DYSON_NEBULA_PRIVATE_CANDIDATE_V1'),
  schemaVersion: z.literal(1),
  source: z.strictObject({
    upstreamCommit: gitCommitSchema,
    websocketSubmoduleCommit: gitCommitSchema,
    sourceContractSha256: bareSha256Schema,
    patchSha256: bareSha256Schema
  }),
  game: z.strictObject({
    gameVersion: z.string().min(1).max(64),
    gameLibVersion: z.string().min(1).max(96),
    assemblyCSharpMvid: mvidSchema
  }),
  baseline: z.strictObject({
    mainArchiveSha256: bareSha256Schema,
    apiArchiveSha256: bareSha256Schema,
    sourceManifestSha256: bareSha256Schema,
    treeSha256: bareSha256Schema,
    treeDigestAlgorithm: z.string().min(1).max(256)
  }),
  candidate: z.strictObject({
    treeSha256: bareSha256Schema,
    totalFiles: z.number().int().positive().max(4096),
    stockFilesExact: z.number().int().nonnegative().max(4096),
    customFiles: z.number().int().nonnegative().max(4096)
  }),
  deterministicBuildEvidence: z.strictObject({
    buildPlanDigest: bareSha256Schema,
    inputFingerprintSha256: bareSha256Schema,
    metadataASha256: bareSha256Schema,
    metadataBSha256: bareSha256Schema,
    matched: z.literal(true)
  }),
  files: z.array(candidateFileSchema).min(2).max(4096),
  manifestDigest: bareSha256Schema
})

const artifactMetadataSchema = z.strictObject({
  path: relativePathSchema,
  kind: z.enum(['managed-dll', 'portable-pdb']),
  size: safePositiveSizeSchema,
  sha256: bareSha256Schema
})

const assemblyMetadataSchema = z.object({
  path: relativePathSchema,
  name: z.enum(['NebulaNetwork', 'NebulaPatcher']),
  assemblyVersion: z.string().min(1).max(64),
  fileVersion: z.string().min(1).max(64),
  productVersion: z.string().min(1).max(256),
  publicKeyToken: z.string().min(1).max(32),
  mvid: mvidSchema,
  references: z.array(z.unknown()),
  debug: z.unknown()
}).strict()

const binaryMetadataSchema = z.object({
  protocol: z.literal('DYSON_NEBULA_PRIVATE_BINARY_METADATA_V1'),
  schemaVersion: z.literal(1),
  source: z.object({
    upstreamCommit: gitCommitSchema,
    sourceContractSha256: bareSha256Schema,
    patchSha256: bareSha256Schema
  }).passthrough(),
  game: z.object({ gameVersion: z.string().min(1).max(64) }).passthrough(),
  build: z.unknown(),
  artifacts: z.array(artifactMetadataSchema).min(4).max(32),
  assemblies: z.array(assemblyMetadataSchema).length(2),
  publicHygieneFindings: z.array(z.never()).length(0)
}).strict()

const sourcePatchContractSchema = z.object({
  format: z.literal('dyson-control-nebula-source-patch-contract'),
  schemaVersion: z.literal(2),
  upstream: z.object({ commit: gitCommitSchema }).passthrough(),
  patch: z.object({ sha256: bareSha256Schema }).passthrough()
}).passthrough()

const privateBuildContractSchema = z.object({
  protocol: z.literal('DYSON_NEBULA_PRIVATE_BUILD_CONTRACT_V1'),
  schemaVersion: z.literal(1),
  upstream: z.object({ commit: gitCommitSchema }).passthrough(),
  sourcePatch: z.object({
    contractSha256: bareSha256Schema,
    patchSha256: bareSha256Schema
  }).passthrough(),
  game: z.object({ gameVersion: z.string().min(1).max(64) }).passthrough(),
  candidate: z.object({ treeDigestAlgorithm: z.string().min(1).max(256) }).passthrough()
}).passthrough()

const externalEvidenceReferenceSchema = z.strictObject({
  opaqueId: uuidSchema,
  type: identifierSchema,
  sha256: bareSha256Schema,
  observedAtUtc: utcMillisecondsSchema,
  expiresAtUtc: utcMillisecondsSchema,
  attestationClass: identifierSchema
})

const externalPublicSummarySchema = z.strictObject({
  checkCodes: z.array(identifierSchema).max(64),
  transcriptBindingSha256: bareSha256Schema.nullable()
})

const externalClientReceiptSchema = z.strictObject({
  protocol: z.literal('DYSON_PRODUCTION_QUALIFICATION_V1'),
  schemaVersion: z.literal(1),
  receiptId: uuidSchema,
  runId: uuidSchema,
  idempotencyKey: uuidSchema,
  stepId: z.literal('external-client-e2e'),
  sequence: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  event: identifierSchema,
  status: z.enum(['observed', 'passed', 'failed', 'interrupted', 'rolled-back']),
  issuedAtUtc: utcMillisecondsSchema,
  expiresAtUtc: utcMillisecondsSchema,
  predecessorSha256: bareSha256Schema,
  challengeId: uuidSchema,
  evidenceRef: externalEvidenceReferenceSchema,
  publicSummary: externalPublicSummarySchema,
  receiptSha256: bareSha256Schema
})

const externalClientReceiptArraySchema = z.array(externalClientReceiptSchema).length(11)

export interface VerifiedHostnameWssQualification {
  qualificationId: string
  runId: string
  documentSha256: string
  issuedAtUtc: string
  expiresAtUtc: string
  connection: {
    protocol: 'nebula'
    transport: 'wss'
    topology: 'http-websocket-tunnel'
    path: '/socket'
    authoritySemantics: 'hostname-preserved'
    host: string
    port: 443
    displayAddress: string
  }
  bindings: z.output<typeof hostnameWssContractBindingSchema>
  binaries: z.output<typeof hostnameWssBinaryBindingSchema>
  clientManifest: z.output<typeof qualifiedClientManifestSchema>
  assessedProfile: AssessedClientProfileInput
}

export interface ClientQualificationProjection {
  qualificationId: string
  runId: string
  bindingSha256: string
  expiresAtUtc: string
  decision: 'qualified'
  blockerCodes: []
}

export interface ClientQualificationPreviewProjection {
  qualificationId: string
  runId: string
  bindingSha256: string
  expiresAtUtc: string
  decision: 'preview-valid'
  blockerCodes: ['DYSON_HOSTNAME_WSS_QUALIFICATION_NOT_CONSUMED']
}

export interface QualificationConsumeRequest {
  qualificationId: string
  runId: string
  bindingSha256: string
  expiresAtUtc: string
}

/** Production implementations must delegate to the protected Windows replay ledger. */
export interface ProtectedClientQualificationConsumer {
  consumeQualification(request: QualificationConsumeRequest): Promise<unknown>
}

export const clientQualificationProjectionSchema = z.strictObject({
  qualificationId: uuidSchema,
  runId: uuidSchema,
  bindingSha256: digestSchema,
  expiresAtUtc: utcMillisecondsSchema,
  decision: z.literal('qualified'),
  blockerCodes: z.tuple([])
})

export interface VerifyHostnameWssQualificationOptions {
  now?: Date
}

export class ClientQualificationVerificationError extends Error {
  readonly code: string

  constructor(code: string) {
    super(code)
    this.name = 'ClientQualificationVerificationError'
    this.code = code
  }
}

export async function verifyHostnameWssQualification(
  requestInput: unknown,
  store: ProtectedClientQualificationStore,
  options: VerifyHostnameWssQualificationOptions = {}
): Promise<VerifiedHostnameWssQualification> {
  try {
    const request = qualifiedClientProfileRequestV2Schema.parse(requestInput)
    const qualificationBytes = await store.readDocument(request.qualificationId, 'qualification')
    const document = hostnameWssQualificationDocumentSchema.parse(parseStrictCanonicalJsonBytes(
      qualificationBytes,
      'CLIENT_QUALIFICATION_DOCUMENT_INVALID'
    ))
    if (document.qualificationId !== request.qualificationId) fail('CLIENT_QUALIFICATION_ID_MISMATCH')

    const { documentSha256, protection, ...documentCore } = document
    assertDigestEqual(sha256Canonical(documentCore), documentSha256, 'CLIENT_QUALIFICATION_DOCUMENT_DIGEST_INVALID')
    await verifyDocumentHmac(documentSha256, protection, store)
    verifyFreshness(document.issuedAtUtc, document.expiresAtUtc, options.now ?? new Date())
    if (Date.parse(document.expiresAtUtc) - Date.parse(document.issuedAtUtc) > 2 * 60 * 60 * 1000) {
      fail('CLIENT_QUALIFICATION_DOCUMENT_LIFETIME_INVALID')
    }
    await verifyReceiptChain(document, store, options.now ?? new Date())
    verifyBindingInvariants(document)

    const [sourcePatchBytes, privateBuildBytes, metadataABytes, metadataBBytes, candidateManifestBytes,
      clientManifestBytes, profileInputBytes, externalReceiptBytes, clientPackageBytes] = await Promise.all([
      store.readDocument(request.qualificationId, 'source-patch-contract'),
      store.readDocument(request.qualificationId, 'private-build-contract'),
      store.readDocument(request.qualificationId, 'binary-metadata-a'),
      store.readDocument(request.qualificationId, 'binary-metadata-b'),
      store.readDocument(request.qualificationId, 'candidate-manifest'),
      store.readDocument(request.qualificationId, 'client-manifest'),
      store.readDocument(request.qualificationId, 'profile-input'),
      store.readDocument(request.qualificationId, 'external-client-receipts'),
      store.readClientPackage(request.qualificationId)
    ])
    verifyRawBindings(document.contractBinding, {
      sourcePatchBytes,
      privateBuildBytes,
      metadataABytes,
      metadataBBytes,
      candidateManifestBytes,
      clientManifestBytes,
      profileInputBytes,
      clientPackageBytes
    })

    const sourcePatch = sourcePatchContractSchema.parse(parseStrictJsonBytes(
      sourcePatchBytes, 'CLIENT_QUALIFICATION_SOURCE_CONTRACT_INVALID'))
    const privateBuild = privateBuildContractSchema.parse(parseStrictJsonBytes(
      privateBuildBytes, 'CLIENT_QUALIFICATION_PRIVATE_BUILD_CONTRACT_INVALID'))
    const metadataA = binaryMetadataSchema.parse(parseStrictJsonBytes(
      metadataABytes, 'CLIENT_QUALIFICATION_BINARY_METADATA_INVALID'))
    const metadataB = binaryMetadataSchema.parse(parseStrictJsonBytes(
      metadataBBytes, 'CLIENT_QUALIFICATION_BINARY_METADATA_INVALID'))
    const candidateManifest = candidateManifestSchema.parse(parseStrictJsonBytes(
      candidateManifestBytes, 'CLIENT_QUALIFICATION_CANDIDATE_MANIFEST_INVALID'))
    const clientManifest = qualifiedClientManifestSchema.parse(parseStrictCanonicalJsonBytes(
      clientManifestBytes, 'CLIENT_QUALIFICATION_CLIENT_MANIFEST_INVALID'))
    const assessedProfile = assessClientProfile(parseStrictJsonBytes(
      profileInputBytes, 'CLIENT_QUALIFICATION_PROFILE_INPUT_INVALID'))
    const externalReceipts = externalClientReceiptArraySchema.parse(parseStrictCanonicalJsonBytes(
      externalReceiptBytes, 'CLIENT_QUALIFICATION_EXTERNAL_RECEIPTS_INVALID'))

    verifyContractGraph(document, sourcePatch, privateBuild, metadataA, metadataB, candidateManifest)
    verifyExternalClientReceipts(document, externalReceipts, externalReceiptBytes, options.now ?? new Date())
    await verifyCandidateFiles(request.qualificationId, candidateManifest, store)
    await verifyClientFiles(request.qualificationId, clientManifest, document, store)
    verifyMetadataBindings(document, metadataA, metadataB, candidateManifest, clientManifest)
    verifyProfilePolicy(document, assessedProfile)

    return {
      qualificationId: document.qualificationId,
      runId: document.runId,
      documentSha256: document.documentSha256,
      issuedAtUtc: document.issuedAtUtc,
      expiresAtUtc: document.expiresAtUtc,
      connection: {
        protocol: 'nebula',
        transport: 'wss',
        topology: 'http-websocket-tunnel',
        path: '/socket',
        authoritySemantics: 'hostname-preserved',
        host: document.subject.authority,
        port: 443,
        displayAddress: `${document.subject.authority}:443`
      },
      bindings: document.contractBinding,
      binaries: document.binaryBinding,
      clientManifest,
      assessedProfile
    }
  } catch (error) {
    if (error instanceof ClientQualificationVerificationError) throw error
    if (error instanceof ClientQualificationStoreError) {
      throw new ClientQualificationVerificationError(error.code)
    }
    const code = typeof error === 'object' && error !== null && 'code' in error &&
      typeof error.code === 'string' && error.code.startsWith('CLIENT_QUALIFICATION_')
      ? error.code
      : 'CLIENT_QUALIFICATION_INVALID'
    throw new ClientQualificationVerificationError(code)
  }
}

export async function consumeVerifiedHostnameWssQualification(
  qualification: VerifiedHostnameWssQualification,
  consumer: ProtectedClientQualificationConsumer
): Promise<ClientQualificationProjection> {
  const expected: QualificationConsumeRequest = {
    qualificationId: qualification.qualificationId,
    runId: qualification.runId,
    bindingSha256: qualification.documentSha256,
    expiresAtUtc: qualification.expiresAtUtc
  }
  const projection = clientQualificationProjectionSchema.parse(await consumer.consumeQualification(expected))
  if (projection.qualificationId !== expected.qualificationId || projection.runId !== expected.runId ||
      projection.bindingSha256 !== expected.bindingSha256 || projection.expiresAtUtc !== expected.expiresAtUtc) {
    fail('CLIENT_QUALIFICATION_CONSUMPTION_BINDING_INVALID')
  }
  return projection
}

/** A verified preview is intentionally blocked until the protected consumer accepts it. */
export function projectHostnameWssQualificationPreview(
  qualification: VerifiedHostnameWssQualification
): ClientQualificationPreviewProjection {
  return {
    qualificationId: qualification.qualificationId,
    runId: qualification.runId,
    bindingSha256: qualification.documentSha256,
    expiresAtUtc: qualification.expiresAtUtc,
    decision: 'preview-valid',
    blockerCodes: ['DYSON_HOSTNAME_WSS_QUALIFICATION_NOT_CONSUMED']
  }
}

/** V1 metadata profiles have no protected qualification and can never promote. */
export function isProductionQualifiedClientProfile(value: unknown): value is ClientQualificationProjection {
  return clientQualificationProjectionSchema.safeParse(value).success
}

async function verifyDocumentHmac(
  documentSha256: string,
  protection: z.output<typeof protectionSchema>,
  store: ProtectedClientQualificationStore
): Promise<void> {
  const key = await store.resolveHmacKey(protection.keyId)
  if (key === null) fail('CLIENT_QUALIFICATION_HMAC_KEY_UNAVAILABLE')
  try {
    if (key.byteLength !== 32) fail('CLIENT_QUALIFICATION_HMAC_KEY_UNAVAILABLE')
    const expected = hmacSha256Canonical({
      domain: 'DYSON_NEBULA_HOSTNAME_WSS_QUALIFICATION_V1_DOCUMENT',
      keyId: protection.keyId,
      documentSha256
    }, key)
    assertDigestEqual(expected, protection.hmacSha256, 'CLIENT_QUALIFICATION_DOCUMENT_HMAC_INVALID')
  } finally {
    key.fill(0)
  }
}

async function verifyReceiptChain(
  document: z.output<typeof hostnameWssQualificationDocumentSchema>,
  store: ProtectedClientQualificationStore,
  now: Date
): Promise<void> {
  const expectedTypes = ['build-binary', 'wss-transport', 'passwall-route', 'external-client'] as const
  const expectedCollectors = [
    'nebula-private-build',
    'wss-edge-observer',
    'passwall-route-observer',
    'external-client-coordinator'
  ] as const
  const expectedEvidence = [
    sha256Canonical({ contractBinding: document.contractBinding, binaryBinding: document.binaryBinding }),
    sha256Canonical(document.transportBinding),
    sha256Canonical(document.routeBinding),
    sha256Canonical(document.externalClientBinding)
  ]
  const first = document.receiptChain[0]
  const seenReceipts = new Set<string>()
  const seenNonces = new Set<string>()
  const seenKeyIds = new Set<string>()
  let previousObservedMs = Number.NEGATIVE_INFINITY
  for (let index = 0; index < document.receiptChain.length; index += 1) {
    const receipt = document.receiptChain[index]!
    if (receipt.sequence !== index + 1 || receipt.evidenceType !== expectedTypes[index] ||
        receipt.qualificationId !== document.qualificationId || receipt.runId !== document.runId ||
        receipt.sessionId !== first.sessionId || receipt.collectorId !== expectedCollectors[index] ||
        receipt.challengeIds.initial !== first.challengeIds.initial ||
        receipt.challengeIds.reconnect !== first.challengeIds.reconnect ||
        receipt.challengeIds.initial !== document.externalClientBinding.initialChallengeId ||
        receipt.challengeIds.reconnect !== document.externalClientBinding.reconnectChallengeId ||
        receipt.evidenceSha256 !== expectedEvidence[index] ||
        receipt.previousReceiptSha256 !== (index === 0 ? null : document.receiptChain[index - 1]!.receiptSha256) ||
        seenReceipts.has(receipt.receiptId) || seenNonces.has(receipt.nonce) || seenKeyIds.has(receipt.keyId)) {
      fail('CLIENT_QUALIFICATION_RECEIPT_CHAIN_INVALID')
    }
    seenReceipts.add(receipt.receiptId)
    seenNonces.add(receipt.nonce)
    seenKeyIds.add(receipt.keyId)
    verifyFreshness(receipt.observedAtUtc, receipt.expiresAtUtc, now)
    const observedMs = Date.parse(receipt.observedAtUtc)
    const expiresMs = Date.parse(receipt.expiresAtUtc)
    if (observedMs < Date.parse(document.issuedAtUtc) || observedMs < previousObservedMs ||
        expiresMs > Date.parse(document.expiresAtUtc) || expiresMs - observedMs > 2 * 60 * 60 * 1000) {
      fail('CLIENT_QUALIFICATION_RECEIPT_CHAIN_INVALID')
    }
    previousObservedMs = observedMs
    const { receiptSha256, hmacSha256, ...unsignedReceipt } = receipt
    assertDigestEqual(sha256Canonical(unsignedReceipt), receiptSha256, 'CLIENT_QUALIFICATION_RECEIPT_DIGEST_INVALID')
    const key = await store.resolveHmacKey(receipt.keyId)
    if (key === null) fail('CLIENT_QUALIFICATION_HMAC_KEY_UNAVAILABLE')
    try {
      if (key.byteLength !== 32) fail('CLIENT_QUALIFICATION_HMAC_KEY_UNAVAILABLE')
      assertDigestEqual(
        hmacSha256Canonical(unsignedReceipt, key),
        hmacSha256,
        'CLIENT_QUALIFICATION_RECEIPT_HMAC_INVALID'
      )
    } finally {
      key.fill(0)
    }
  }
  if (seenKeyIds.has(document.protection.keyId)) {
    fail('CLIENT_QUALIFICATION_SIGNER_ROLE_NOT_SEPARATED')
  }
}

function verifyBindingInvariants(document: z.output<typeof hostnameWssQualificationDocumentSchema>): void {
  const sessionId = document.receiptChain[0].sessionId
  const expectedSessionBinding = sha256Canonical({
    protocol: 'DYSON_NEBULA_HOSTNAME_WSS_SESSION_BINDING_V1',
    qualificationId: document.qualificationId,
    runId: document.runId,
    sessionId,
    initialChallengeId: document.externalClientBinding.initialChallengeId,
    reconnectChallengeId: document.externalClientBinding.reconnectChallengeId,
    externalReceiptChainSha256: document.externalClientBinding.receiptChainSha256,
    externalTerminalReceiptSha256: document.externalClientBinding.terminalReceiptSha256
  })
  const expectedFlowBinding = sha256Canonical({
    protocol: 'DYSON_NEBULA_HOSTNAME_WSS_FLOW_BINDING_V1',
    qualificationId: document.qualificationId,
    runId: document.runId,
    sessionId,
    sessionBindingSha256: expectedSessionBinding,
    websocketTranscriptSha256: document.transportBinding.websocketTranscriptSha256,
    ruleIdentitySha256: document.routeBinding.ruleIdentitySha256
  })
  if (document.transportBinding.sniAuthority !== document.subject.authority ||
      document.transportBinding.hostHeaderAuthority !== `${document.subject.authority}:443` ||
      document.transportBinding.websocketPath !== document.subject.websocketPath ||
      document.transportBinding.httpStatusCode !== 101 ||
      document.transportBinding.sessionBindingSha256 !== expectedSessionBinding ||
      document.routeBinding.sessionBindingSha256 !== expectedSessionBinding ||
      document.externalClientBinding.sessionBindingSha256 !== expectedSessionBinding ||
      document.routeBinding.flowBindingSha256 !== expectedFlowBinding ||
      document.externalClientBinding.initialChallengeId === document.externalClientBinding.reconnectChallengeId ||
      document.binaryBinding.candidate.some((entry, index) =>
        entry.sha256 !== document.binaryBinding.client[index]!.sha256 ||
        entry.mvid !== document.binaryBinding.client[index]!.mvid) ||
      document.routeBinding.ruleRevisionBefore !== document.routeBinding.ruleRevisionAfter ||
      document.routeBinding.directCounters.packetsAfter <= document.routeBinding.directCounters.packetsBefore ||
      document.routeBinding.directCounters.bytesAfter <= document.routeBinding.directCounters.bytesBefore ||
      document.routeBinding.proxyCounters.packetsAfter !== document.routeBinding.proxyCounters.packetsBefore ||
      document.routeBinding.proxyCounters.bytesAfter !== document.routeBinding.proxyCounters.bytesBefore) {
    fail('CLIENT_QUALIFICATION_BINDING_INVALID')
  }
  if (Date.parse(document.externalClientBinding.observedAtUtc) >= Date.parse(document.externalClientBinding.expiresAtUtc)) {
    fail('CLIENT_QUALIFICATION_BINDING_INVALID')
  }
}

function verifyExternalClientReceipts(
  document: z.output<typeof hostnameWssQualificationDocumentSchema>,
  receipts: z.output<typeof externalClientReceiptArraySchema>,
  receiptBytes: Uint8Array,
  now: Date
): void {
  const events = [
    'client-challenge-issued',
    'game-address-resolved',
    'game-authenticated',
    'game-joined',
    'game-interaction-observed',
    'save-requested',
    'save-independently-acknowledged',
    'game-disconnected',
    'reconnect-challenge-issued',
    'game-rejoined',
    'external-sequence-complete'
  ] as const
  const evidenceTypes = [
    'operator-client-challenge',
    'game-protocol-resolution-observation',
    'server-authentication-observation',
    'server-authoritative-join',
    'server-authoritative-interaction',
    'server-save-request-observation',
    'independent-paired-save-observation',
    'server-authoritative-disconnect',
    'operator-reconnect-challenge',
    'server-authoritative-rejoin',
    'dual-party-sequence-attestation'
  ] as const
  const attestationClasses = [
    'operator-challenge',
    'independent-network-observer',
    'server-authoritative',
    'server-authoritative',
    'server-authoritative',
    'server-authoritative',
    'independent-save-observer',
    'server-authoritative',
    'operator-challenge',
    'server-authoritative',
    'dual-party-attestation'
  ] as const
  const maximumLegSeconds = [300, 300, 300, 300, 300, 300, 600, 300, 300, 600, 120] as const
  const seenReceiptIds = new Set<string>()
  const seenIdempotencyKeys = new Set<string>()
  let firstObservedMs = 0
  let previousObservedMs = 0
  for (let index = 0; index < receipts.length; index += 1) {
    const receipt = receipts[index]!
    const issuedMs = Date.parse(receipt.issuedAtUtc)
    const expiresMs = Date.parse(receipt.expiresAtUtc)
    const observedMs = Date.parse(receipt.evidenceRef.observedAtUtc)
    const evidenceExpiresMs = Date.parse(receipt.evidenceRef.expiresAtUtc)
    const nowMs = now.getTime()
    const expectedChallengeId = index <= 7
      ? document.externalClientBinding.initialChallengeId
      : document.externalClientBinding.reconnectChallengeId
    const sortedCheckCodes = [...receipt.publicSummary.checkCodes].sort(compareOrdinal)
    const { receiptSha256: _receiptSha256, ...unsignedReceipt } = receipt
    const expectedReceiptSha256 = bareSha256(
      sha256Canonical(unsignedReceipt),
      'CLIENT_QUALIFICATION_EXTERNAL_RECEIPT_INVALID'
    )
    if (receipt.runId !== document.runId || receipt.event !== events[index] ||
        receipt.evidenceRef.type !== evidenceTypes[index] ||
        receipt.evidenceRef.attestationClass !== attestationClasses[index] ||
        receipt.status !== (index === receipts.length - 1 ? 'passed' : 'observed') ||
        receipt.sequence !== receipts[0]!.sequence + index ||
        (index > 0 && receipt.predecessorSha256 !== receipts[index - 1]!.receiptSha256) ||
        receipt.challengeId !== expectedChallengeId ||
        seenReceiptIds.has(receipt.receiptId) || seenIdempotencyKeys.has(receipt.idempotencyKey) ||
        receipt.receiptSha256 !== expectedReceiptSha256 ||
        receipt.publicSummary.checkCodes.some((code, checkIndex) => code !== sortedCheckCodes[checkIndex]) ||
        new Set(receipt.publicSummary.checkCodes).size !== receipt.publicSummary.checkCodes.length ||
        (index < receipts.length - 1 && receipt.publicSummary.transcriptBindingSha256 !== null) ||
        expiresMs <= issuedMs || expiresMs > issuedMs + 24 * 60 * 60 * 1000 ||
        issuedMs > nowMs + 60 * 1000 || nowMs >= expiresMs ||
        observedMs > issuedMs + 5 * 60 * 1000 || observedMs > nowMs + 60 * 1000 ||
        evidenceExpiresMs <= observedMs || evidenceExpiresMs > observedMs + 24 * 60 * 60 * 1000 ||
        nowMs >= evidenceExpiresMs) {
      fail('CLIENT_QUALIFICATION_EXTERNAL_RECEIPT_INVALID')
    }
    if (index === 0) {
      firstObservedMs = observedMs
    } else if (observedMs < previousObservedMs ||
        observedMs - previousObservedMs > maximumLegSeconds[index]! * 1000) {
      fail('CLIENT_QUALIFICATION_EXTERNAL_TIMING_INVALID')
    }
    previousObservedMs = observedMs
    seenReceiptIds.add(receipt.receiptId)
    seenIdempotencyKeys.add(receipt.idempotencyKey)
  }
  if (previousObservedMs - firstObservedMs > 2400 * 1000) {
    fail('CLIENT_QUALIFICATION_EXTERNAL_TIMING_INVALID')
  }

  const expectedTranscript = bareSha256(sha256Canonical({
    protocol: 'DYSON_EXTERNAL_CLIENT_TRANSCRIPT_BINDING_V1',
    firstChallengeId: document.externalClientBinding.initialChallengeId,
    reconnectChallengeId: document.externalClientBinding.reconnectChallengeId,
    predecessorSha256: receipts[9]!.receiptSha256
  }), 'CLIENT_QUALIFICATION_EXTERNAL_BINDING_INVALID')
  const binding = document.externalClientBinding
  const minimumExpiry = receipts.flatMap((receipt) => [receipt.expiresAtUtc, receipt.evidenceRef.expiresAtUtc])
    .reduce((current, candidate) => Date.parse(candidate) < Date.parse(current) ? candidate : current)
  if (sha256Bytes(receiptBytes) !== binding.receiptChainSha256 ||
      binding.receiptCount !== receipts.length ||
      binding.joinReceiptSha256 !== `sha256:${receipts[3]!.receiptSha256}` ||
      binding.reconnectReceiptSha256 !== `sha256:${receipts[9]!.receiptSha256}` ||
      binding.terminalReceiptSha256 !== `sha256:${receipts[10]!.receiptSha256}` ||
      binding.transcriptBindingSha256 !== `sha256:${expectedTranscript}` ||
      receipts[10]!.publicSummary.transcriptBindingSha256 !== expectedTranscript ||
      binding.observedAtUtc !== receipts[0]!.evidenceRef.observedAtUtc ||
      binding.expiresAtUtc !== minimumExpiry ||
      Date.parse(binding.observedAtUtc) < Date.parse(document.issuedAtUtc) ||
      Date.parse(binding.expiresAtUtc) > Date.parse(document.expiresAtUtc) ||
      now.getTime() < Date.parse(binding.observedAtUtc) || now.getTime() >= Date.parse(binding.expiresAtUtc)) {
    fail('CLIENT_QUALIFICATION_EXTERNAL_BINDING_INVALID')
  }
}

function verifyRawBindings(
  binding: z.output<typeof hostnameWssContractBindingSchema>,
  bytes: {
    sourcePatchBytes: Uint8Array
    privateBuildBytes: Uint8Array
    metadataABytes: Uint8Array
    metadataBBytes: Uint8Array
    candidateManifestBytes: Uint8Array
    clientManifestBytes: Uint8Array
    profileInputBytes: Uint8Array
    clientPackageBytes: Uint8Array
  }
): void {
  const checks: Array<[string, Uint8Array]> = [
    [binding.sourcePatchContractSha256, bytes.sourcePatchBytes],
    [binding.privateBuildContractSha256, bytes.privateBuildBytes],
    [binding.binaryMetadataASha256, bytes.metadataABytes],
    [binding.binaryMetadataBSha256, bytes.metadataBBytes],
    [binding.candidateManifestSha256, bytes.candidateManifestBytes],
    [binding.clientManifestSha256, bytes.clientManifestBytes],
    [binding.profileInputSha256, bytes.profileInputBytes],
    [binding.clientPackageSha256, bytes.clientPackageBytes]
  ]
  for (const [expected, value] of checks) {
    assertDigestEqual(sha256Bytes(value), expected, 'CLIENT_QUALIFICATION_RAW_BINDING_INVALID')
  }
}

function verifyContractGraph(
  document: z.output<typeof hostnameWssQualificationDocumentSchema>,
  sourcePatch: z.output<typeof sourcePatchContractSchema>,
  privateBuild: z.output<typeof privateBuildContractSchema>,
  metadataA: z.output<typeof binaryMetadataSchema>,
  metadataB: z.output<typeof binaryMetadataSchema>,
  candidate: z.output<typeof candidateManifestSchema>
): void {
  const binding = document.contractBinding
  const { manifestDigest: _manifestDigest, ...candidateCore } = candidate
  if (candidate.manifestDigest !== sha256(canonicalJson(candidateCore)) ||
      binding.upstreamCommit !== sourcePatch.upstream.commit ||
      binding.upstreamCommit !== privateBuild.upstream.commit ||
      binding.upstreamCommit !== candidate.source.upstreamCommit ||
      binding.upstreamCommit !== metadataA.source.upstreamCommit ||
      binding.upstreamCommit !== metadataB.source.upstreamCommit ||
      bareSha256(binding.sourcePatchContractSha256, 'CLIENT_QUALIFICATION_CONTRACT_GRAPH_INVALID') !==
        privateBuild.sourcePatch.contractSha256 ||
      sourcePatch.patch.sha256 !== bareSha256(binding.patchSha256, 'CLIENT_QUALIFICATION_CONTRACT_GRAPH_INVALID') ||
      privateBuild.sourcePatch.patchSha256 !== sourcePatch.patch.sha256 ||
      candidate.source.sourceContractSha256 !== privateBuild.sourcePatch.contractSha256 ||
      candidate.source.patchSha256 !== sourcePatch.patch.sha256 ||
      metadataA.source.sourceContractSha256 !== privateBuild.sourcePatch.contractSha256 ||
      metadataB.source.sourceContractSha256 !== privateBuild.sourcePatch.contractSha256 ||
      metadataA.source.patchSha256 !== sourcePatch.patch.sha256 || metadataB.source.patchSha256 !== sourcePatch.patch.sha256 ||
      candidate.game.gameVersion !== privateBuild.game.gameVersion || metadataA.game.gameVersion !== candidate.game.gameVersion ||
      metadataB.game.gameVersion !== candidate.game.gameVersion ||
      candidate.baseline.treeDigestAlgorithm !== privateBuild.candidate.treeDigestAlgorithm ||
      candidate.candidate.treeSha256 !== bareSha256(binding.candidateTreeSha256,
        'CLIENT_QUALIFICATION_CONTRACT_GRAPH_INVALID') ||
      candidate.deterministicBuildEvidence.metadataASha256 !== bareSha256(binding.binaryMetadataASha256,
        'CLIENT_QUALIFICATION_CONTRACT_GRAPH_INVALID') ||
      candidate.deterministicBuildEvidence.metadataBSha256 !== bareSha256(binding.binaryMetadataBSha256,
        'CLIENT_QUALIFICATION_CONTRACT_GRAPH_INVALID')) {
    fail('CLIENT_QUALIFICATION_CONTRACT_GRAPH_INVALID')
  }
}

async function verifyCandidateFiles(
  qualificationId: string,
  manifest: z.output<typeof candidateManifestSchema>,
  store: ProtectedClientQualificationStore
): Promise<void> {
  assertSortedUniqueFiles(manifest.files)
  if (manifest.files.length !== manifest.candidate.totalFiles ||
      manifest.files.filter((entry) => entry.origin === 'official-stock').length !== manifest.candidate.stockFilesExact ||
      manifest.files.filter((entry) => entry.origin === 'private-build').length !== manifest.candidate.customFiles) {
    fail('CLIENT_QUALIFICATION_CANDIDATE_FILE_SET_INVALID')
  }
  const records: string[] = []
  for (const entry of manifest.files) {
    const bytes = await store.readCandidateFile(qualificationId, entry.path)
    const actual = bareSha256(sha256Bytes(bytes), 'CLIENT_QUALIFICATION_CANDIDATE_FILE_INVALID')
    if (bytes.byteLength !== entry.size || actual !== entry.sha256) {
      fail('CLIENT_QUALIFICATION_CANDIDATE_FILE_INVALID')
    }
    records.push(`${entry.path}\0${entry.size}\0${entry.sha256}\n`)
  }
  const tree = sha256(records.join(''))
  if (tree !== manifest.candidate.treeSha256) fail('CLIENT_QUALIFICATION_CANDIDATE_TREE_INVALID')
}

async function verifyClientFiles(
  qualificationId: string,
  manifest: z.output<typeof qualifiedClientManifestSchema>,
  document: z.output<typeof hostnameWssQualificationDocumentSchema>,
  store: ProtectedClientQualificationStore
): Promise<void> {
  const { manifestSha256: _manifestSha256, ...manifestCore } = manifest
  assertDigestEqual(sha256Canonical(manifestCore), manifest.manifestSha256,
    'CLIENT_QUALIFICATION_CLIENT_MANIFEST_DIGEST_INVALID')
  if (manifest.qualificationId !== document.qualificationId ||
      manifest.packageSha256 !== document.contractBinding.clientPackageSha256) {
    fail('CLIENT_QUALIFICATION_CLIENT_MANIFEST_BINDING_INVALID')
  }
  assertSortedUniqueFiles(manifest.files)
  const records: string[] = []
  for (const entry of manifest.files) {
    const bytes = await store.readClientFile(qualificationId, entry.path)
    const actual = sha256Bytes(bytes)
    if (bytes.byteLength !== entry.size || actual !== entry.sha256) {
      fail('CLIENT_QUALIFICATION_CLIENT_FILE_INVALID')
    }
    records.push(`${entry.path}\0${entry.size}\0${bareSha256(entry.sha256,
      'CLIENT_QUALIFICATION_CLIENT_FILE_INVALID')}\n`)
  }
  assertDigestEqual(`sha256:${sha256(records.join(''))}`, manifest.treeSha256,
    'CLIENT_QUALIFICATION_CLIENT_TREE_INVALID')
}

function verifyMetadataBindings(
  document: z.output<typeof hostnameWssQualificationDocumentSchema>,
  metadataA: z.output<typeof binaryMetadataSchema>,
  metadataB: z.output<typeof binaryMetadataSchema>,
  candidateManifest: z.output<typeof candidateManifestSchema>,
  clientManifest: z.output<typeof qualifiedClientManifestSchema>
): void {
  for (let index = 0; index < 2; index += 1) {
    const boundCandidate = document.binaryBinding.candidate[index]!
    const boundClient = document.binaryBinding.client[index]!
    const expectedName = index === 0 ? 'NebulaNetwork' : 'NebulaPatcher'
    const expectedFileName = `${expectedName}.dll`
    const assemblyA = metadataA.assemblies.find((entry) => entry.name === expectedName)
    const assemblyB = metadataB.assemblies.find((entry) => entry.name === expectedName)
    const artifactA = metadataA.artifacts.find((entry) => entry.path.endsWith(`/${expectedFileName}`))
    const artifactB = metadataB.artifacts.find((entry) => entry.path.endsWith(`/${expectedFileName}`))
    const candidateFile = candidateManifest.files.find((entry) => entry.path.endsWith(`/${expectedFileName}`))
    const clientFiles = clientManifest.files.filter((entry) => entry.path.endsWith(`/${expectedFileName}`))
    if (assemblyA === undefined || assemblyB === undefined || artifactA === undefined || artifactB === undefined ||
        candidateFile === undefined || clientFiles.length !== 1 || assemblyA.mvid !== assemblyB.mvid ||
        artifactA.sha256 !== artifactB.sha256 || artifactA.sha256 !== candidateFile.sha256 ||
        boundCandidate.fileName !== expectedFileName || boundCandidate.mvid !== assemblyA.mvid ||
        boundCandidate.sha256 !== `sha256:${candidateFile.sha256}` ||
        boundClient.sha256 !== clientFiles[0]!.sha256 || boundClient.sha256 !== boundCandidate.sha256 ||
        boundClient.mvid !== boundCandidate.mvid) {
      fail('CLIENT_QUALIFICATION_BINARY_BINDING_INVALID')
    }
  }
}

function verifyProfilePolicy(
  document: z.output<typeof hostnameWssQualificationDocumentSchema>,
  assessed: AssessedClientProfileInput
): void {
  const connection = assessed.input.profile.connection
  const serverLockSha256 = `sha256:${assessed.manifests.serverLockSha256}`
  const clientParitySha256 = `sha256:${sha256(serializeClientParityManifest(assessed.manifests.clientParity))}`
  const compatibilityPolicySha256 = sha256Canonical(assessed.input.compatibility.matrix)
  if (!assessed.report.canGenerate || assessed.compatibility.matchedEntryId === null ||
      connection.host !== document.subject.authority || connection.port !== 443 ||
      serverLockSha256 !== document.contractBinding.serverLockSha256 ||
      clientParitySha256 !== document.contractBinding.clientParitySha256 ||
      compatibilityPolicySha256 !== document.contractBinding.compatibilityPolicySha256) {
    fail('CLIENT_QUALIFICATION_PROFILE_POLICY_INVALID')
  }
}

function assertSortedUniqueFiles(files: readonly { path: string }[]): void {
  const sorted = [...files].map((entry) => entry.path).sort(compareOrdinal)
  if (new Set(sorted.map((entry) => entry.toLowerCase())).size !== sorted.length ||
      files.some((entry, index) => entry.path !== sorted[index])) {
    fail('CLIENT_QUALIFICATION_FILE_ORDER_INVALID')
  }
}

function verifyFreshness(start: string, end: string, now: Date): void {
  const startMs = Date.parse(start)
  const endMs = Date.parse(end)
  const nowMs = now.getTime()
  if (!Number.isFinite(nowMs) || startMs >= endMs || nowMs < startMs || nowMs >= endMs) {
    fail('CLIENT_QUALIFICATION_EXPIRED_OR_NOT_YET_VALID')
  }
}

function isSafeRelativePath(value: string): boolean {
  try {
    assertSafeRelativePath(value)
    return true
  } catch {
    return false
  }
}

function isBoundedIdentifier(value: string): boolean {
  if (!/^[a-z0-9][a-z0-9._-]{6,126}[a-z0-9]$/.test(value) || value.includes('..')) return false
  return !/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(value.split('.', 1)[0] ?? '')
}

function isPublicHostname(value: string): boolean {
  if (isIP(value) !== 0 || value === 'localhost' || value.endsWith('.') || value.includes('..')) return false
  return /^(?=.{4,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])$/.test(value)
}

function compareOrdinal(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

function fail(code: string): never {
  throw new ClientQualificationVerificationError(code)
}
