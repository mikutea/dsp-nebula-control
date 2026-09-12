import { generateModManifests, serializeClientParityManifest } from '../mods/manifest.js'
import { assessClientProfile } from './parity.js'
import { sha256 } from './artifact.js'
import {
  bareSha256,
  canonicalJson,
  hmacSha256Canonical,
  sha256Bytes,
  sha256Canonical
} from './canonical.js'
import type {
  ClientQualificationDocumentName,
  ProtectedClientQualificationStore
} from './qualification-store.js'
import {
  HOSTNAME_WSS_COLLECTOR_RECEIPT_PROTOCOL,
  HOSTNAME_WSS_QUALIFICATION_PROTOCOL,
  QUALIFIED_CLIENT_MANIFEST_PROTOCOL,
  type ClientQualificationProjection,
  type ProtectedClientQualificationConsumer,
  type QualificationConsumeRequest
} from './qualification-v2.js'

const ids = {
  qualification: '10000000-0000-0000-0000-000000000001',
  run: '20000000-0000-0000-0000-000000000001',
  session: '30000000-0000-0000-0000-000000000001',
  initialChallenge: '40000000-0000-0000-0000-000000000001',
  reconnectChallenge: '40000000-0000-0000-0000-000000000002'
} as const

const keyIds = [
  'build-key-0001',
  'transport-key-0002',
  'route-key-0003',
  'external-key-0004',
  'document-key-0005'
] as const

const upstreamCommit = '1'.repeat(40)
const websocketCommit = '2'.repeat(40)
const patchDigest = '3'.repeat(64)
const mvids = [
  '50000000-0000-0000-0000-000000000001',
  '50000000-0000-0000-0000-000000000002'
] as const

export class FixtureQualificationStore implements ProtectedClientQualificationStore {
  readonly documents = new Map<ClientQualificationDocumentName, Buffer>()
  readonly candidateFiles = new Map<string, Buffer>()
  readonly clientFiles = new Map<string, Buffer>()
  readonly keys = new Map<string, Buffer>()
  clientPackage = Buffer.alloc(0)
  readCount = 0

  async readDocument(_qualificationId: string, name: ClientQualificationDocumentName): Promise<Uint8Array> {
    this.readCount += 1
    const value = this.documents.get(name)
    if (value === undefined) throw new Error(`missing fixture document: ${name}`)
    return Buffer.from(value)
  }

  async readCandidateFile(_qualificationId: string, relativePath: string): Promise<Uint8Array> {
    const value = this.candidateFiles.get(relativePath)
    if (value === undefined) throw new Error(`missing fixture candidate: ${relativePath}`)
    return Buffer.from(value)
  }

  async readClientFile(_qualificationId: string, relativePath: string): Promise<Uint8Array> {
    const value = this.clientFiles.get(relativePath)
    if (value === undefined) throw new Error(`missing fixture client file: ${relativePath}`)
    return Buffer.from(value)
  }

  async readClientPackage(): Promise<Uint8Array> {
    return Buffer.from(this.clientPackage)
  }

  async resolveHmacKey(keyId: string): Promise<Uint8Array | null> {
    const value = this.keys.get(keyId)
    return value === undefined ? null : Buffer.from(value)
  }
}

export class FixtureQualificationConsumer implements ProtectedClientQualificationConsumer {
  calls = 0
  readonly requests: QualificationConsumeRequest[] = []

  async consumeQualification(request: QualificationConsumeRequest): Promise<ClientQualificationProjection> {
    this.calls += 1
    this.requests.push(structuredClone(request))
    return {
      qualificationId: request.qualificationId,
      runId: request.runId,
      bindingSha256: request.bindingSha256,
      expiresAtUtc: request.expiresAtUtc,
      decision: 'qualified',
      blockerCodes: []
    }
  }
}

export interface QualificationFixture {
  request: { schemaVersion: 2; qualificationId: string }
  now: Date
  store: FixtureQualificationStore
  consumer: FixtureQualificationConsumer
  document: Record<string, any>
  profileInput: Record<string, any>
  resignDocument(
    mutator?: (document: Record<string, any>) => void,
    receiptMutator?: (document: Record<string, any>) => void
  ): void
}

export function createQualificationFixture(): QualificationFixture {
  const store = new FixtureQualificationStore()
  keyIds.forEach((keyId, index) => store.keys.set(keyId, Buffer.alloc(32, index + 1)))
  const now = new Date('2030-01-01T12:30:00.000Z')
  const documentIssuedAt = '2030-01-01T12:00:00.000Z'
  const documentExpiresAt = '2030-01-01T13:00:00.000Z'

  const manifests = generateModManifests({
    roots: ['Fictional-MultiplayerRoot-2.0.0'],
    packages: [{
      dependencyId: 'Fictional-MultiplayerRoot-2.0.0',
      sha256: 'a'.repeat(64),
      dependencies: [],
      serverRequired: true,
      clientRequirement: 'required'
    }]
  })
  const profileInput = {
    schemaVersion: 1,
    profile: {
      profileId: 'dyson-example',
      displayName: 'Dyson Example',
      connection: { host: 'example.com', port: 443 }
    },
    compatibility: {
      inventory: {
        dsp: '0.10.34.28529',
        nebula: '0.9.22.2',
        bepInEx: '5.4.17.0',
        plugins: [{ sourceId: 'thunderstore:NebulaModTeam/NebulaMultiplayerMod', version: '0.9.22.2' }]
      },
      matrix: {
        schemaVersion: 1,
        entries: [{
          id: 'supported-example',
          core: {
            dsp: { equals: '0.10.34.28529' },
            nebula: { equals: '0.9.22.2' },
            bepInEx: { equals: '5.4.17.0' }
          },
          plugins: [{
            sourceId: 'thunderstore:NebulaModTeam/NebulaMultiplayerMod',
            range: { equals: '0.9.22.2' },
            required: true
          }]
        }]
      }
    },
    serverLock: manifests.serverLock,
    clientParity: manifests.clientParity
  }
  const profileInputBytes = asCanonicalBytes(profileInput)
  store.documents.set('profile-input', profileInputBytes)
  const assessed = assessClientProfile(profileInput)

  const sourcePatch = {
    format: 'dyson-control-nebula-source-patch-contract',
    schemaVersion: 2,
    upstream: { commit: upstreamCommit },
    patch: { sha256: patchDigest }
  }
  const sourcePatchBytes = asCanonicalBytes(sourcePatch)
  store.documents.set('source-patch-contract', sourcePatchBytes)
  const privateBuild = {
    protocol: 'DYSON_NEBULA_PRIVATE_BUILD_CONTRACT_V1',
    schemaVersion: 1,
    upstream: { commit: upstreamCommit },
    sourcePatch: {
      contractSha256: bareSha256(sha256Bytes(sourcePatchBytes), 'fixture'),
      patchSha256: patchDigest
    },
    game: { gameVersion: '0.10.34.28529' },
    candidate: { treeDigestAlgorithm: 'path-nul-size-nul-sha256-lf-v1' }
  }
  const privateBuildBytes = asCanonicalBytes(privateBuild)
  store.documents.set('private-build-contract', privateBuildBytes)

  const candidatePayload: Array<{ path: string; bytes: Buffer; kind: 'managed-dll' | 'portable-pdb' }> = [
    {
      path: 'nebula-NebulaMultiplayerMod/NebulaNetwork.dll',
      bytes: Buffer.from('fictional-nebula-network-dll-v1'),
      kind: 'managed-dll'
    },
    {
      path: 'nebula-NebulaMultiplayerMod/NebulaNetwork.pdb',
      bytes: Buffer.from('fictional-nebula-network-pdb-v1'),
      kind: 'portable-pdb'
    },
    {
      path: 'nebula-NebulaMultiplayerMod/NebulaPatcher.dll',
      bytes: Buffer.from('fictional-nebula-patcher-dll-v1'),
      kind: 'managed-dll'
    },
    {
      path: 'nebula-NebulaMultiplayerMod/NebulaPatcher.pdb',
      bytes: Buffer.from('fictional-nebula-patcher-pdb-v1'),
      kind: 'portable-pdb'
    }
  ]
  candidatePayload.forEach((entry) => store.candidateFiles.set(entry.path, entry.bytes))
  const artifacts = candidatePayload.map((entry) => ({
    path: entry.path,
    kind: entry.kind,
    size: entry.bytes.length,
    sha256: bareSha256(sha256Bytes(entry.bytes), 'fixture')
  }))
  const assemblies = [
    {
      path: candidatePayload[0]!.path,
      name: 'NebulaNetwork',
      assemblyVersion: '1.0.0.0',
      fileVersion: '1.0.0.0',
      productVersion: '1.0.0',
      publicKeyToken: 'null',
      mvid: mvids[0],
      references: [],
      debug: {}
    },
    {
      path: candidatePayload[2]!.path,
      name: 'NebulaPatcher',
      assemblyVersion: '1.0.0.0',
      fileVersion: '1.0.0.0',
      productVersion: '1.0.0',
      publicKeyToken: 'null',
      mvid: mvids[1],
      references: [],
      debug: {}
    }
  ]
  const metadataBase = {
    protocol: 'DYSON_NEBULA_PRIVATE_BINARY_METADATA_V1',
    schemaVersion: 1,
    source: {
      upstreamCommit,
      sourceContractSha256: privateBuild.sourcePatch.contractSha256,
      patchSha256: patchDigest
    },
    game: { gameVersion: '0.10.34.28529' },
    artifacts,
    assemblies,
    publicHygieneFindings: []
  }
  const metadataABytes = asCanonicalBytes({ ...metadataBase, build: { run: 'a' } })
  const metadataBBytes = asCanonicalBytes({ ...metadataBase, build: { run: 'b' } })
  store.documents.set('binary-metadata-a', metadataABytes)
  store.documents.set('binary-metadata-b', metadataBBytes)

  const candidateFiles = candidatePayload.map((entry) => ({
    path: entry.path,
    size: entry.bytes.length,
    sha256: bareSha256(sha256Bytes(entry.bytes), 'fixture'),
    origin: 'private-build'
  }))
  const candidateTree = sha256(candidateFiles.map((entry) =>
    `${entry.path}\0${entry.size}\0${entry.sha256}\n`).join(''))
  const candidateCore = {
    protocol: 'DYSON_NEBULA_PRIVATE_CANDIDATE_V1',
    schemaVersion: 1,
    source: {
      upstreamCommit,
      websocketSubmoduleCommit: websocketCommit,
      sourceContractSha256: privateBuild.sourcePatch.contractSha256,
      patchSha256: patchDigest
    },
    game: {
      gameVersion: '0.10.34.28529',
      gameLibVersion: 'fictional-game-lib-v1',
      assemblyCSharpMvid: '60000000-0000-0000-0000-000000000001'
    },
    baseline: {
      mainArchiveSha256: '4'.repeat(64),
      apiArchiveSha256: '5'.repeat(64),
      sourceManifestSha256: '6'.repeat(64),
      treeSha256: '7'.repeat(64),
      treeDigestAlgorithm: privateBuild.candidate.treeDigestAlgorithm
    },
    candidate: { treeSha256: candidateTree, totalFiles: 4, stockFilesExact: 0, customFiles: 4 },
    deterministicBuildEvidence: {
      buildPlanDigest: '8'.repeat(64),
      inputFingerprintSha256: '9'.repeat(64),
      metadataASha256: bareSha256(sha256Bytes(metadataABytes), 'fixture'),
      metadataBSha256: bareSha256(sha256Bytes(metadataBBytes), 'fixture'),
      matched: true
    },
    files: candidateFiles
  }
  const candidateManifest = { ...candidateCore, manifestDigest: sha256(canonicalJson(candidateCore)) }
  const candidateManifestBytes = asCanonicalBytes(candidateManifest)
  store.documents.set('candidate-manifest', candidateManifestBytes)

  const clientPayload = [
    { path: 'BepInEx/plugins/NebulaMultiplayerMod/NebulaNetwork.dll', bytes: candidatePayload[0]!.bytes },
    { path: 'BepInEx/plugins/NebulaMultiplayerMod/NebulaPatcher.dll', bytes: candidatePayload[2]!.bytes }
  ]
  clientPayload.forEach((entry) => store.clientFiles.set(entry.path, entry.bytes))
  const clientFiles = clientPayload.map((entry) => ({
    path: entry.path,
    size: entry.bytes.length,
    sha256: sha256Bytes(entry.bytes)
  }))
  const clientTreeSha256 = `sha256:${sha256(clientFiles.map((entry) =>
    `${entry.path}\0${entry.size}\0${bareSha256(entry.sha256, 'fixture')}\n`).join(''))}`
  store.clientPackage = Buffer.from('fictional-qualified-client-package-zip-v1')
  const clientManifestCore = {
    protocol: QUALIFIED_CLIENT_MANIFEST_PROTOCOL,
    schemaVersion: 1,
    qualificationId: ids.qualification,
    createdAtUtc: '2030-01-01T12:05:00.000Z',
    files: clientFiles,
    treeSha256: clientTreeSha256,
    packageSha256: sha256Bytes(store.clientPackage)
  }
  const clientManifest = { ...clientManifestCore, manifestSha256: sha256Canonical(clientManifestCore) }
  const clientManifestBytes = asCanonicalBytes(clientManifest)
  store.documents.set('client-manifest', clientManifestBytes)

  const externalReceipts = buildExternalReceipts()
  const externalReceiptBytes = asCanonicalBytes(externalReceipts)
  store.documents.set('external-client-receipts', externalReceiptBytes)
  const externalClientBinding = {
    receiptChainSha256: sha256Bytes(externalReceiptBytes),
    receiptCount: 11,
    terminalReceiptSha256: `sha256:${externalReceipts[10]!.receiptSha256}`,
    joinReceiptSha256: `sha256:${externalReceipts[3]!.receiptSha256}`,
    reconnectReceiptSha256: `sha256:${externalReceipts[9]!.receiptSha256}`,
    initialChallengeId: ids.initialChallenge,
    reconnectChallengeId: ids.reconnectChallenge,
    transcriptBindingSha256: `sha256:${externalReceipts[10]!.publicSummary.transcriptBindingSha256}`,
    sessionBindingSha256: '',
    observedAtUtc: externalReceipts[0]!.evidenceRef.observedAtUtc,
    expiresAtUtc: externalReceipts[0]!.expiresAtUtc
  }

  const contractBinding = {
    sourcePatchContractSha256: sha256Bytes(sourcePatchBytes),
    privateBuildContractSha256: sha256Bytes(privateBuildBytes),
    binaryMetadataASha256: sha256Bytes(metadataABytes),
    binaryMetadataBSha256: sha256Bytes(metadataBBytes),
    upstreamCommit,
    patchSha256: `sha256:${patchDigest}`,
    candidateManifestSha256: sha256Bytes(candidateManifestBytes),
    candidateTreeSha256: `sha256:${candidateTree}`,
    clientManifestSha256: sha256Bytes(clientManifestBytes),
    clientPackageSha256: sha256Bytes(store.clientPackage),
    profileInputSha256: sha256Bytes(profileInputBytes),
    serverLockSha256: `sha256:${assessed.manifests.serverLockSha256}`,
    clientParitySha256: `sha256:${sha256(serializeClientParityManifest(assessed.manifests.clientParity))}`,
    compatibilityPolicySha256: sha256Canonical(assessed.input.compatibility.matrix)
  }
  const binaryBinding = {
    candidate: [
      {
        role: 'nebula-network', fileName: 'NebulaNetwork.dll',
        sha256: sha256Bytes(candidatePayload[0]!.bytes), mvid: mvids[0]
      },
      {
        role: 'nebula-patcher', fileName: 'NebulaPatcher.dll',
        sha256: sha256Bytes(candidatePayload[2]!.bytes), mvid: mvids[1]
      }
    ],
    client: [
      {
        role: 'nebula-network', fileName: 'NebulaNetwork.dll',
        sha256: sha256Bytes(candidatePayload[0]!.bytes), mvid: mvids[0]
      },
      {
        role: 'nebula-patcher', fileName: 'NebulaPatcher.dll',
        sha256: sha256Bytes(candidatePayload[2]!.bytes), mvid: mvids[1]
      }
    ]
  }
  const sessionBindingSha256 = sha256Canonical({
    protocol: 'DYSON_NEBULA_HOSTNAME_WSS_SESSION_BINDING_V1',
    qualificationId: ids.qualification,
    runId: ids.run,
    sessionId: ids.session,
    initialChallengeId: ids.initialChallenge,
    reconnectChallengeId: ids.reconnectChallenge,
    externalReceiptChainSha256: externalClientBinding.receiptChainSha256,
    externalTerminalReceiptSha256: externalClientBinding.terminalReceiptSha256
  })
  externalClientBinding.sessionBindingSha256 = sessionBindingSha256
  const transportBinding = {
    sniAuthority: 'example.com',
    hostHeaderAuthority: 'example.com:443',
    websocketPath: '/socket',
    tlsProtocol: 'tls13',
    httpStatusCode: 101,
    ingressProvider: 'cloudflare-tunnel',
    ingressConfigSha256: `sha256:${'a'.repeat(64)}`,
    originBindingSha256: `sha256:${'b'.repeat(64)}`,
    websocketTranscriptSha256: `sha256:${'c'.repeat(64)}`,
    sessionBindingSha256
  }
  const ruleIdentitySha256 = `sha256:${'d'.repeat(64)}`
  const routeBinding = {
    ruleRevisionBefore: 7,
    ruleRevisionAfter: 7,
    ruleIdentitySha256,
    flowBindingSha256: sha256Canonical({
      protocol: 'DYSON_NEBULA_HOSTNAME_WSS_FLOW_BINDING_V1',
      qualificationId: ids.qualification,
      runId: ids.run,
      sessionId: ids.session,
      sessionBindingSha256,
      websocketTranscriptSha256: transportBinding.websocketTranscriptSha256,
      ruleIdentitySha256
    }),
    sessionBindingSha256,
    directCounters: { packetsBefore: 10, packetsAfter: 12, bytesBefore: 100, bytesAfter: 140 },
    proxyCounters: { packetsBefore: 4, packetsAfter: 4, bytesBefore: 50, bytesAfter: 50 }
  }
  const document: Record<string, any> = {
    protocol: HOSTNAME_WSS_QUALIFICATION_PROTOCOL,
    schemaVersion: 1,
    qualificationId: ids.qualification,
    runId: ids.run,
    issuedAtUtc: documentIssuedAt,
    expiresAtUtc: documentExpiresAt,
    subject: {
      authority: 'example.com',
      port: 443,
      topology: 'http-websocket-tunnel',
      transport: 'wss',
      websocketPath: '/socket',
      authoritySemantics: 'hostname-preserved'
    },
    contractBinding,
    binaryBinding,
    transportBinding,
    routeBinding,
    externalClientBinding,
    receiptChain: [],
    documentSha256: '',
    protection: { algorithm: 'hmac-sha256', keyId: keyIds[4], hmacSha256: '' }
  }

  const resignDocument = (
    mutator?: (value: Record<string, any>) => void,
    receiptMutator?: (value: Record<string, any>) => void
  ): void => {
    mutator?.(document)
    document.receiptChain = buildCollectorReceipts(document, store.keys)
    receiptMutator?.(document)
    for (let index = 0; index < document.receiptChain.length; index += 1) {
      const receipt = document.receiptChain[index]
      receipt.previousReceiptSha256 = index === 0 ? null : document.receiptChain[index - 1].receiptSha256
      const { receiptSha256: _receiptSha256, hmacSha256: _hmacSha256, ...unsignedReceipt } = receipt
      receipt.receiptSha256 = sha256Canonical(unsignedReceipt)
      receipt.hmacSha256 = hmacSha256Canonical(unsignedReceipt, store.keys.get(receipt.keyId)!)
    }
    const { documentSha256: _documentSha256, protection: _protection, ...core } = document
    document.documentSha256 = sha256Canonical(core)
    document.protection = {
      algorithm: 'hmac-sha256',
      keyId: keyIds[4],
      hmacSha256: hmacSha256Canonical({
        domain: 'DYSON_NEBULA_HOSTNAME_WSS_QUALIFICATION_V1_DOCUMENT',
        keyId: keyIds[4],
        documentSha256: document.documentSha256
      }, store.keys.get(keyIds[4])!)
    }
    store.documents.set('qualification', asCanonicalBytes(document))
  }
  resignDocument()
  return {
    request: { schemaVersion: 2, qualificationId: ids.qualification },
    now,
    store,
    consumer: new FixtureQualificationConsumer(),
    document,
    profileInput,
    resignDocument
  }
}

function buildExternalReceipts(): Array<Record<string, any>> {
  const events = [
    'client-challenge-issued', 'game-address-resolved', 'game-authenticated', 'game-joined',
    'game-interaction-observed', 'save-requested', 'save-independently-acknowledged', 'game-disconnected',
    'reconnect-challenge-issued', 'game-rejoined', 'external-sequence-complete'
  ]
  const types = [
    'operator-client-challenge', 'game-protocol-resolution-observation', 'server-authentication-observation',
    'server-authoritative-join', 'server-authoritative-interaction', 'server-save-request-observation',
    'independent-paired-save-observation', 'server-authoritative-disconnect', 'operator-reconnect-challenge',
    'server-authoritative-rejoin', 'dual-party-sequence-attestation'
  ]
  const classes = [
    'operator-challenge', 'independent-network-observer', 'server-authoritative', 'server-authoritative',
    'server-authoritative', 'server-authoritative', 'independent-save-observer', 'server-authoritative',
    'operator-challenge', 'server-authoritative', 'dual-party-attestation'
  ]
  const receipts: Array<Record<string, any>> = []
  let predecessor = '0'.repeat(64)
  for (let index = 0; index < events.length; index += 1) {
    const at = new Date(Date.parse('2030-01-01T12:00:10.000Z') + index * 30_000).toISOString()
    const suffix = String(index + 1).padStart(12, '0')
    const transcript = index === 10 ? bareSha256(sha256Canonical({
      protocol: 'DYSON_EXTERNAL_CLIENT_TRANSCRIPT_BINDING_V1',
      firstChallengeId: ids.initialChallenge,
      reconnectChallengeId: ids.reconnectChallenge,
      predecessorSha256: receipts[9]!.receiptSha256
    }), 'fixture') : null
    const core = {
      protocol: 'DYSON_PRODUCTION_QUALIFICATION_V1',
      schemaVersion: 1,
      receiptId: `70000000-0000-0000-0000-${suffix}`,
      runId: ids.run,
      idempotencyKey: `71000000-0000-0000-0000-${suffix}`,
      stepId: 'external-client-e2e',
      sequence: index + 5,
      event: events[index],
      status: index === 10 ? 'passed' : 'observed',
      issuedAtUtc: at,
      expiresAtUtc: '2030-01-01T12:50:00.000Z',
      predecessorSha256: predecessor,
      challengeId: index <= 7 ? ids.initialChallenge : ids.reconnectChallenge,
      evidenceRef: {
        opaqueId: `72000000-0000-0000-0000-${suffix}`,
        type: types[index],
        sha256: String(index + 1).repeat(64).slice(0, 64),
        observedAtUtc: at,
        expiresAtUtc: '2030-01-01T12:50:00.000Z',
        attestationClass: classes[index]
      },
      publicSummary: { checkCodes: ['external-observed'], transcriptBindingSha256: transcript }
    }
    const receipt = { ...core, receiptSha256: bareSha256(sha256Canonical(core), 'fixture') }
    receipts.push(receipt)
    predecessor = receipt.receiptSha256
  }
  return receipts
}

function buildCollectorReceipts(
  document: Record<string, any>,
  keys: ReadonlyMap<string, Buffer>
): Array<Record<string, any>> {
  const types = ['build-binary', 'wss-transport', 'passwall-route', 'external-client']
  const collectors = [
    'nebula-private-build', 'wss-edge-observer', 'passwall-route-observer', 'external-client-coordinator'
  ]
  const evidence = [
    sha256Canonical({ contractBinding: document.contractBinding, binaryBinding: document.binaryBinding }),
    sha256Canonical(document.transportBinding),
    sha256Canonical(document.routeBinding),
    sha256Canonical(document.externalClientBinding)
  ]
  const receipts: Array<Record<string, any>> = []
  for (let index = 0; index < 4; index += 1) {
    const suffix = String(index + 1).padStart(12, '0')
    const core = {
      protocol: HOSTNAME_WSS_COLLECTOR_RECEIPT_PROTOCOL,
      schemaVersion: 1,
      receiptId: `80000000-0000-0000-0000-${suffix}`,
      qualificationId: document.qualificationId,
      runId: document.runId,
      collectorId: collectors[index],
      keyId: keyIds[index],
      sequence: index + 1,
      evidenceType: types[index],
      challengeIds: { initial: ids.initialChallenge, reconnect: ids.reconnectChallenge },
      sessionId: ids.session,
      nonce: Buffer.alloc(32, index + 10).toString('base64url'),
      observedAtUtc: new Date(Date.parse('2030-01-01T12:10:00.000Z') + index * 60_000).toISOString(),
      expiresAtUtc: '2030-01-01T12:50:00.000Z',
      previousReceiptSha256: index === 0 ? null : receipts[index - 1]!.receiptSha256,
      evidenceSha256: evidence[index]
    }
    receipts.push({
      ...core,
      receiptSha256: sha256Canonical(core),
      hmacSha256: hmacSha256Canonical(core, keys.get(keyIds[index]!)!)
    })
  }
  return receipts
}

function asCanonicalBytes(value: unknown): Buffer {
  return Buffer.from(canonicalJson(value), 'utf8')
}
