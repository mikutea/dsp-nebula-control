import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  FileSystemIssuedQualifiedClientProfileStore,
  generateClientProfile,
  generateQualifiedClientProfileV2,
  isProductionQualifiedClientProfile,
  issueQualifiedClientProfileV2,
  projectGeneratedQualifiedClientProfile,
  QUALIFIED_CLIENT_PROFILE_ZIP_FILE_NAME,
  QUALIFIED_NEBULA_CLIENT_ZIP_FILE_NAME,
  sha256
} from './index.js'
import { createQualificationFixture } from './qualification-v2.fixture.test-helper.js'

describe('qualified client profile generation', () => {
  it('issues reproducible WSS metadata, profile ZIP, runtime manifest, and verified client payload', async () => {
    const firstFixture = createQualificationFixture()
    const secondFixture = createQualificationFixture()
    const first = await generateQualifiedClientProfileV2(
      firstFixture.request, firstFixture.store, firstFixture.consumer, { now: firstFixture.now })
    const second = await generateQualifiedClientProfileV2(
      secondFixture.request, secondFixture.store, secondFixture.consumer, { now: secondFixture.now })

    expect(firstFixture.consumer.calls).toBe(1)
    expect(firstFixture.consumer.requests[0]).toEqual({
      qualificationId: firstFixture.request.qualificationId,
      runId: firstFixture.document.runId,
      bindingSha256: firstFixture.document.documentSha256,
      expiresAtUtc: firstFixture.document.expiresAtUtc
    })
    expect(first.profileArchive.bytes.equals(second.profileArchive.bytes)).toBe(true)
    expect(first.qualifiedRuntimeArtifact.content).toBe(second.qualifiedRuntimeArtifact.content)
    expect(first.qualifiedClientPayload.bytes.equals(second.qualifiedClientPayload.bytes)).toBe(true)
    expect(first.qualifiedClientPayload).toMatchObject({
      fileName: QUALIFIED_NEBULA_CLIENT_ZIP_FILE_NAME,
      mediaType: 'application/zip',
      sha256: first.qualifiedClientRuntime.contracts.clientPackageSha256
    })
    expect(first.qualifiedClientRuntime).toMatchObject({
      connection: {
        protocol: 'nebula', transport: 'wss', topology: 'http-websocket-tunnel',
        path: '/socket', authoritySemantics: 'hostname-preserved', host: 'example.com', port: 443
      },
      clientPayload: {
        fileName: QUALIFIED_NEBULA_CLIENT_ZIP_FILE_NAME,
        packageSha256: first.qualifiedClientPayload.sha256,
        packageSizeBytes: first.qualifiedClientPayload.sizeBytes
      }
    })

    const metadata = projectGeneratedQualifiedClientProfile(first)
    const publicJson = JSON.stringify(metadata)
    expect(publicJson).not.toContain('"bytes"')
    expect(publicJson).not.toMatch(/(?:hmac|receiptchain|protectedroot|[A-Za-z]:\\|\\\\)/i)
    expect(metadata.artifacts).toMatchObject({
      profileArchive: { fileName: QUALIFIED_CLIENT_PROFILE_ZIP_FILE_NAME },
      qualifiedClientPayload: { fileName: QUALIFIED_NEBULA_CLIENT_ZIP_FILE_NAME },
      qualifiedRuntime: { entryName: 'qualified-client-runtime.json' }
    })
  })

  it('never promotes the compatible V1 metadata generator', () => {
    const fixture = createQualificationFixture()
    const legacy = generateClientProfile(fixture.profileInput)
    expect(isProductionQualifiedClientProfile(legacy)).toBe(false)
    expect(isProductionQualifiedClientProfile(legacy.profile)).toBe(false)
  })
})

describe('durable qualified client issue store', () => {
  it('atomically reuses one opaque issue and serves three independently verified downloads', async () => {
    const temporaryParent = process.env.TEMP
    if (temporaryParent === undefined) throw new Error('TEMP is required for the test')
    const root = await mkdtemp(path.join(temporaryParent, 'dyson-client-issue-'))
    try {
      const fixture = createQualificationFixture()
      const generated = await generateQualifiedClientProfileV2(
        fixture.request, fixture.store, fixture.consumer, { now: fixture.now })
      const downloadId = '90000000-0000-0000-0000-000000000001'
      const store = await FileSystemIssuedQualifiedClientProfileStore.open({
        protectedRoot: root,
        createDownloadId: () => downloadId,
        clock: () => new Date('2030-01-01T12:31:00.000Z')
      })

      const [first, second] = await Promise.all([store.issue(generated), store.issue(generated)])
      const safeIssue = await issueQualifiedClientProfileV2(
        fixture.request, fixture.store, fixture.consumer, store, { now: fixture.now })
      expect(second).toEqual(first)
      expect(safeIssue).toEqual(first)
      expect(first.downloadId).toBe(downloadId)
      expect(JSON.stringify(first)).not.toContain('"bytes"')

      const [profileArchive, clientPayload, runtime] = await Promise.all([
        store.readArchive(downloadId),
        store.readClientPayload(downloadId),
        store.readRuntimeArtifact(downloadId)
      ])
      expect(profileArchive.bytes.equals(generated.profileArchive.bytes)).toBe(true)
      expect(clientPayload.bytes.equals(generated.qualifiedClientPayload.bytes)).toBe(true)
      expect(runtime.bytes.toString('utf8')).toBe(generated.qualifiedRuntimeArtifact.content)
      expect(profileArchive.sha256).toMatch(/^sha256:[0-9a-f]{64}$/)
      expect(clientPayload.sha256).toBe(generated.qualifiedClientPayload.sha256)
      expect(runtime.sha256).toMatch(/^sha256:[0-9a-f]{64}$/)

      const changedRuntime = `${generated.qualifiedRuntimeArtifact.content}\n`
      const conflicting = {
        ...generated,
        qualifiedRuntimeArtifact: {
          ...generated.qualifiedRuntimeArtifact,
          content: changedRuntime,
          sizeBytes: Buffer.byteLength(changedRuntime, 'utf8'),
          sha256: sha256(changedRuntime)
        }
      }
      await expect(store.issue(conflicting)).rejects.toMatchObject({
        code: 'CLIENT_PROFILE_ISSUE_IDEMPOTENCY_CONFLICT'
      })

      await writeFile(
        path.join(root, 'objects', downloadId, QUALIFIED_NEBULA_CLIENT_ZIP_FILE_NAME),
        Buffer.from('tampered-client-payload'))
      await expect(store.readClientPayload(downloadId)).rejects.toBeInstanceOf(Error)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('rejects path-like opaque IDs without touching storage', async () => {
    const temporaryParent = process.env.TEMP
    if (temporaryParent === undefined) throw new Error('TEMP is required for the test')
    const root = await mkdtemp(path.join(temporaryParent, 'dyson-client-issue-id-'))
    try {
      await mkdir(path.join(root, 'sentinel'))
      const store = await FileSystemIssuedQualifiedClientProfileStore.open({ protectedRoot: root })
      await expect(store.readArchive('../sentinel')).rejects.toMatchObject({ code: 'CLIENT_PROFILE_ISSUE_ID_INVALID' })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('enforces an independent client payload limit before publishing', async () => {
    const temporaryParent = process.env.TEMP
    if (temporaryParent === undefined) throw new Error('TEMP is required for the test')
    const root = await mkdtemp(path.join(temporaryParent, 'dyson-client-issue-limit-'))
    try {
      const fixture = createQualificationFixture()
      const generated = await generateQualifiedClientProfileV2(
        fixture.request, fixture.store, fixture.consumer, { now: fixture.now })
      const store = await FileSystemIssuedQualifiedClientProfileStore.open({
        protectedRoot: root,
        maxArchiveBytes: generated.profileArchive.sizeBytes,
        maxClientPayloadBytes: generated.qualifiedClientPayload.sizeBytes - 1
      })
      await expect(store.issue(generated)).rejects.toMatchObject({
        code: 'CLIENT_PROFILE_ISSUE_ARTIFACT_TOO_LARGE'
      })
      await expect(FileSystemIssuedQualifiedClientProfileStore.open({
        protectedRoot: root,
        maxClientPayloadBytes: 2 * 1024 * 1024 * 1024 + 1
      })).rejects.toMatchObject({ code: 'CLIENT_PROFILE_ISSUE_LIMIT_INVALID' })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
