import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  canonicalJson,
  hmacSha256Canonical,
  parseStrictCanonicalJsonBytes,
  projectHostnameWssQualificationPreview,
  sha256,
  sha256Canonical,
  verifyHostnameWssQualification
} from './index.js'
import {
  serializeClientParityManifest,
  serializeServerModLock,
  validateModManifestPair
} from '../mods/manifest.js'
import { createQualificationFixture } from './qualification-v2.fixture.test-helper.js'

describe('hostname-preserving WSS qualification V2', () => {
  it('verifies protected material and emits only explicit WSS hostname semantics', async () => {
    const fixture = createQualificationFixture()
    const verified = await verifyHostnameWssQualification(fixture.request, fixture.store, { now: fixture.now })

    expect(verified.connection).toEqual({
      protocol: 'nebula',
      transport: 'wss',
      topology: 'http-websocket-tunnel',
      path: '/socket',
      authoritySemantics: 'hostname-preserved',
      host: 'example.com',
      port: 443,
      displayAddress: 'example.com:443'
    })
    expect(projectHostnameWssQualificationPreview(verified)).toEqual({
      qualificationId: fixture.request.qualificationId,
      runId: fixture.document.runId,
      bindingSha256: fixture.document.documentSha256,
      expiresAtUtc: fixture.document.expiresAtUtc,
      decision: 'preview-valid',
      blockerCodes: ['DYSON_HOSTNAME_WSS_QUALIFICATION_NOT_CONSUMED']
    })
  })

  it('rejects caller-supplied qualification claims before reading protected storage', async () => {
    const fixture = createQualificationFixture()
    await expect(verifyHostnameWssQualification({
      ...fixture.request,
      verified: true,
      qualified: true,
      dllSha256: `sha256:${'a'.repeat(64)}`,
      receipt: { decision: 'qualified' }
    }, fixture.store, { now: fixture.now })).rejects.toMatchObject({ code: 'CLIENT_QUALIFICATION_INVALID' })
    expect(fixture.store.readCount).toBe(0)
  })

  it('zeroes every returned HMAC key buffer on success and invalid key length', async () => {
    const fixture = createQualificationFixture()
    const returnedKeys: Uint8Array[] = []
    const resolveKey = fixture.store.resolveHmacKey.bind(fixture.store)
    fixture.store.resolveHmacKey = async (keyId) => {
      const key = await resolveKey(keyId)
      if (key !== null) returnedKeys.push(key)
      return key
    }
    await verifyHostnameWssQualification(fixture.request, fixture.store, { now: fixture.now })
    expect(returnedKeys).toHaveLength(5)
    expect(returnedKeys.every((key) => key.every((byte) => byte === 0))).toBe(true)

    const invalid = createQualificationFixture()
    const invalidKey = Buffer.alloc(31, 9)
    invalid.store.resolveHmacKey = async () => invalidKey
    await expect(verifyHostnameWssQualification(invalid.request, invalid.store, { now: invalid.now }))
      .rejects.toMatchObject({ code: 'CLIENT_QUALIFICATION_HMAC_KEY_UNAVAILABLE' })
    expect(invalidKey.every((byte) => byte === 0)).toBe(true)
  })

  it('rejects literal IP authorities, non-101 transport, and derived flow/session substitution', async () => {
    for (const mutate of [
      (document: Record<string, any>) => { document.subject.authority = '192.0.2.1' },
      (document: Record<string, any>) => { document.transportBinding.httpStatusCode = 200 },
      (document: Record<string, any>) => { document.routeBinding.flowBindingSha256 = `sha256:${'e'.repeat(64)}` },
      (document: Record<string, any>) => { document.transportBinding.sessionBindingSha256 = `sha256:${'f'.repeat(64)}` },
      (document: Record<string, any>) => { document.expiresAtUtc = '2030-01-01T15:00:00.000Z' }
    ]) {
      const fixture = createQualificationFixture()
      fixture.resignDocument(mutate)
      await expect(verifyHostnameWssQualification(fixture.request, fixture.store, { now: fixture.now }))
        .rejects.toBeInstanceOf(Error)
    }
  })

  it('rejects reused signer roles, wrong collectors, and candidate/client byte substitution', async () => {
    const sameKey = createQualificationFixture()
    const documentKey = sameKey.document.protection.keyId as string
    sameKey.resignDocument(undefined, (document) => {
      document.receiptChain[0].keyId = documentKey
    })
    await expect(verifyHostnameWssQualification(sameKey.request, sameKey.store, { now: sameKey.now }))
      .rejects.toBeInstanceOf(Error)

    const sharedCollectorKey = createQualificationFixture()
    sharedCollectorKey.resignDocument(undefined, (document) => {
      document.receiptChain[1].keyId = document.receiptChain[0].keyId
    })
    await expect(verifyHostnameWssQualification(
      sharedCollectorKey.request, sharedCollectorKey.store, { now: sharedCollectorKey.now }))
      .rejects.toBeInstanceOf(Error)

    const wrongCollector = createQualificationFixture()
    wrongCollector.resignDocument(undefined, (document) => {
      document.receiptChain[1].collectorId = 'nebula-private-build'
    })
    await expect(verifyHostnameWssQualification(wrongCollector.request, wrongCollector.store, { now: wrongCollector.now }))
      .rejects.toBeInstanceOf(Error)

    const candidate = createQualificationFixture()
    candidate.store.candidateFiles.set(
      'nebula-NebulaMultiplayerMod/NebulaNetwork.dll', Buffer.from('substituted-candidate'))
    await expect(verifyHostnameWssQualification(candidate.request, candidate.store, { now: candidate.now }))
      .rejects.toBeInstanceOf(Error)

    const client = createQualificationFixture()
    client.store.clientFiles.set(
      'BepInEx/plugins/NebulaMultiplayerMod/NebulaPatcher.dll', Buffer.from('substituted-client'))
    await expect(verifyHostnameWssQualification(client.request, client.store, { now: client.now }))
      .rejects.toBeInstanceOf(Error)
  })

  it('rejects a tampered external 11-event receipt chain', async () => {
    const fixture = createQualificationFixture()
    const receipts = JSON.parse(fixture.store.documents.get('external-client-receipts')!.toString('utf8')) as any[]
    receipts[3]!.event = 'game-interaction-observed'
    fixture.store.documents.set('external-client-receipts', Buffer.from(canonicalJson(receipts), 'utf8'))
    await expect(verifyHostnameWssQualification(fixture.request, fixture.store, { now: fixture.now }))
      .rejects.toBeInstanceOf(Error)
  })
})

describe('hostname WSS canonical cross-runtime vectors', () => {
  it('matches the PowerShell canonical JSON, SHA-256, and HMAC fixtures', async () => {
    const repositoryRoot = fileURLToPath(new URL('../../../../', import.meta.url))
    const bytes = await readFile(`${repositoryRoot}scripts/windows/network/fixtures/hostname-wss-canonical-v1.fixture.json`)
    const fixture = JSON.parse(bytes.toString('utf8')) as {
      testKeyHex: string
      cases: Array<{ input: unknown; canonicalJson: string; sha256: string; hmacSha256: string }>
    }
    const key = Buffer.from(fixture.testKeyHex, 'hex')
    for (const testCase of fixture.cases) {
      expect(canonicalJson(testCase.input)).toBe(testCase.canonicalJson)
      expect(sha256Canonical(testCase.input)).toBe(testCase.sha256)
      expect(hmacSha256Canonical(testCase.input, key)).toBe(testCase.hmacSha256)
    }
  })

  it('matches the PowerShell server-lock and client-parity digest fixture', async () => {
    const repositoryRoot = fileURLToPath(new URL('../../../../', import.meta.url))
    const bytes = await readFile(
      `${repositoryRoot}scripts/windows/network/fixtures/hostname-wss-mod-manifest-digests-v1.fixture.json`)
    const fixture = JSON.parse(bytes.toString('utf8')) as {
      serverLock: unknown
      clientParity: unknown
      expectedServerText: string
      expectedClientText: string
      serverLockSha256: string
      clientParitySha256: string
    }
    const manifests = validateModManifestPair(fixture.serverLock, fixture.clientParity)
    const serverText = serializeServerModLock(manifests.serverLock)
    const clientText = serializeClientParityManifest(manifests.clientParity)
    expect(serverText).toBe(fixture.expectedServerText)
    expect(clientText).toBe(fixture.expectedClientText)
    expect(`sha256:${sha256(serverText)}`).toBe(fixture.serverLockSha256)
    expect(`sha256:${sha256(clientText)}`).toBe(fixture.clientParitySha256)
  })

  it('rejects BOMs, non-canonical bytes, floats, negative zero, and duplicate keys', () => {
    for (const value of [
      Buffer.from([0xef, 0xbb, 0xbf, 0x7b, 0x7d]),
      Buffer.from('{ "a":1}', 'utf8'),
      Buffer.from('{"a":1.5}', 'utf8'),
      Buffer.from('{"a":-0}', 'utf8'),
      Buffer.from('{"a":1}\n', 'utf8'),
      Buffer.from('{"a":9007199254740992}', 'utf8'),
      Buffer.from('{"a":1,"a":1}', 'utf8')
    ]) {
      expect(() => parseStrictCanonicalJsonBytes(value, 'FIXTURE_INVALID')).toThrow()
    }
  })
})
