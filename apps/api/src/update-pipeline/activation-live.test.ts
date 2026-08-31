import { createHash, randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { mkdtemp, mkdir, readFile, rm, symlink, unlink, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  ComponentUpdateActivationError,
  FixedLiveComponentDeployment,
  type FixedLiveComponentCandidateRequest,
  type FixedLiveComponentDeploymentOptions,
  type ManagedUpdateComponent
} from './index.js'

const temporaryRoots: string[] = []
const limits = {
  maximumArchiveBytes: 32 * 1_024 * 1_024,
  maximumFileBytes: 16 * 1_024 * 1_024,
  maximumExpandedBytes: 64 * 1_024 * 1_024,
  maximumFiles: 64
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map(async (root) => await rm(root, { recursive: true, force: true })))
})

describe('fixed live component deployment', () => {
  it('publishes real live files, commits durable state, and reuses the exact UUID only', async () => {
    const fixture = await createFixture()
    const request = await createImmutableRelease(fixture, 'nebula', '0.9.1', 'nebula-artifact-0001', [
      ['plugins/nebula-NebulaMultiplayerMod/Nebula.dll', Buffer.from('candidate-nebula')],
      ['plugins/nebula-NebulaMultiplayerMod/Nebula.json', Buffer.from('{"enabled":true}')]
    ])
    const service = createService(fixture)

    expect(await service.publishCandidate(request)).toMatchObject({ status: 'published', reused: false, fileCount: 2 })
    expect(await readFile(path.join(fixture.liveRoot, 'plugins', 'nebula-NebulaMultiplayerMod', 'Nebula.dll'), 'utf8')).toBe('candidate-nebula')
    expect(await service.commitCandidate(request)).toMatchObject({ status: 'committed', reused: false })
    expect(await service.commitCandidate(request)).toMatchObject({ status: 'committed', reused: true })

    await expect(service.publishCandidate({ ...request, artifactId: 'nebula-artifact-conflict' }))
      .rejects.toMatchObject({ code: 'UPDATE_LIVE_IDEMPOTENCY_CONFLICT' })
    const persisted = await readFile(
      path.join(fixture.controlRoot, 'receipts', `${request.requestId}.json`),
      'utf8'
    )
    expect(persisted).not.toContain(fixture.root)
    expect(persisted).toContain(request.artifactId)
  })

  it('restores the previous live bytes and independently verifies rollback', async () => {
    const fixture = await createFixture()
    const liveFile = path.join(fixture.liveRoot, 'plugins', 'nebula-NebulaMultiplayerMod', 'Nebula.dll')
    await mkdir(path.dirname(liveFile), { recursive: true })
    await writeFile(liveFile, 'previous-nebula')
    const request = await createImmutableRelease(fixture, 'nebula', '0.9.1', 'nebula-artifact-0002', [
      ['plugins/nebula-NebulaMultiplayerMod/Nebula.dll', Buffer.from('candidate-nebula')]
    ])
    const service = createService(fixture)

    await service.publishCandidate(request)
    expect(await readFile(liveFile, 'utf8')).toBe('candidate-nebula')
    expect(await service.rollbackCandidate(request)).toMatchObject({ status: 'rolled-back', reused: false })
    expect(await readFile(liveFile, 'utf8')).toBe('previous-nebula')
    expect(await service.rollbackCandidate(request)).toMatchObject({ status: 'rolled-back', reused: true })
  })

  it('recovers a published-but-uncommitted transaction after a fresh service instance', async () => {
    const fixture = await createFixture()
    const liveFile = path.join(fixture.liveRoot, 'plugins', 'nebula-NebulaMultiplayerMod', 'Nebula.dll')
    await mkdir(path.dirname(liveFile), { recursive: true })
    await writeFile(liveFile, 'previous-nebula')
    const request = await createImmutableRelease(fixture, 'nebula', '0.9.1', 'nebula-artifact-0003', [
      ['plugins/nebula-NebulaMultiplayerMod/Nebula.dll', Buffer.from('candidate-nebula')]
    ])

    await createService(fixture).publishCandidate(request)
    const restarted = createService(fixture)
    await expect(restarted.reconcileCandidate(request, 'previous')).resolves.toBe('previous')
    expect(await readFile(liveFile, 'utf8')).toBe('previous-nebula')
    await expect(restarted.reconcileCandidate(request, 'previous')).resolves.toBe('previous')
  })

  it('compensates every changed file when a later candidate copy fails', async () => {
    const fixture = await createFixture()
    const first = path.join(fixture.liveRoot, 'plugins', 'nebula-NebulaMultiplayerMod', 'A.dll')
    const second = path.join(fixture.liveRoot, 'plugins', 'nebula-NebulaMultiplayerMod', 'B.dll')
    await mkdir(path.dirname(first), { recursive: true })
    await Promise.all([writeFile(first, 'old-a'), writeFile(second, 'old-b')])
    const request = await createImmutableRelease(fixture, 'nebula', '0.9.1', 'nebula-artifact-0004', [
      ['plugins/nebula-NebulaMultiplayerMod/A.dll', Buffer.from('new-a')],
      ['plugins/nebula-NebulaMultiplayerMod/B.dll', Buffer.from('new-b')]
    ])
    let publishProofs = 0
    const service = createService(fixture, {
      verifyStoppedState: async (check) => {
        if (check.phase === 'before-publish' && ++publishProofs === 2) {
          await unlink(path.join(fixture.controlRoot, 'transactions', request.requestId, 'candidate', 'candidate-1.bin'))
        }
        return { processStopped: true, portClosed: true }
      }
    })

    await expect(service.publishCandidate(request)).rejects.toBeInstanceOf(ComponentUpdateActivationError)
    expect(await readFile(first, 'utf8')).toBe('old-a')
    expect(await readFile(second, 'utf8')).toBe('old-b')
    const receipt = JSON.parse(await readFile(
      path.join(fixture.controlRoot, 'receipts', `${request.requestId}.json`),
      'utf8'
    )) as { status: string }
    expect(receipt.status).toBe('rolled-back')
  })

  it('rejects unsupported plugin layout, an unproven stop, and immutable payload tampering without live mutation', async () => {
    const fixture = await createFixture()
    const liveFile = path.join(fixture.liveRoot, 'plugins', 'nebula-NebulaMultiplayerMod', 'Nebula.dll')
    await mkdir(path.dirname(liveFile), { recursive: true })
    await writeFile(liveFile, 'unchanged')

    const unsupportedLayout = await createImmutableRelease(fixture, 'bridge', '0.2.0', 'bridge-artifact-0001', [
      ['core/Bridge.dll', Buffer.from('wrong-root')]
    ])
    const stoppedRequest = await createImmutableRelease(fixture, 'nebula', '0.9.2', 'nebula-artifact-0005', [
      ['plugins/nebula-NebulaMultiplayerMod/Nebula.dll', Buffer.from('candidate')]
    ])
    const tampered = await createImmutableRelease(fixture, 'nebula', '0.9.3', 'nebula-artifact-0006', [
      ['plugins/nebula-NebulaMultiplayerMod/Nebula.dll', Buffer.from('expected')]
    ])
    await writeFile(path.join(
      fixture.releaseRoot,
      tampered.component,
      tampered.releaseId,
      'payload',
      'plugins',
      'nebula-NebulaMultiplayerMod',
      'Nebula.dll'
    ), 'tampered')

    const service = createService(fixture)
    await expect(service.publishCandidate(unsupportedLayout)).rejects.toMatchObject({ code: 'UPDATE_RELEASE_FILE_TYPE_FORBIDDEN' })
    await expect(createService(fixture, {
      verifyStoppedState: async () => ({ processStopped: false, portClosed: true })
    }).publishCandidate(stoppedRequest)).rejects.toMatchObject({ code: 'UPDATE_SERVICE_STILL_RUNNING' })
    await expect(service.publishCandidate(tampered)).rejects.toMatchObject({ code: 'UPDATE_RELEASE_CONTENT_MISMATCH' })
    expect(await readFile(liveFile, 'utf8')).toBe('unchanged')
  })

  it('detects candidate tampering, rejects a cross-owner path, and honors a busy cross-instance lock', async () => {
    const fixture = await createFixture()
    const shared = await createImmutableRelease(fixture, 'nebula', '0.9.1', 'nebula-artifact-0007', [
      ['plugins/nebula-NebulaMultiplayerMod/Shared.dll', Buffer.from('nebula-owner')]
    ])
    const service = createService(fixture)
    await service.publishCandidate(shared)
    await writeFile(path.join(fixture.liveRoot, 'plugins', 'nebula-NebulaMultiplayerMod', 'Shared.dll'), 'tampered-live')
    await expect(service.commitCandidate(shared)).rejects.toMatchObject({ code: 'UPDATE_LIVE_CANDIDATE_VERIFICATION_FAILED' })
    await writeFile(path.join(fixture.liveRoot, 'plugins', 'nebula-NebulaMultiplayerMod', 'Shared.dll'), 'nebula-owner')
    await service.rollbackCandidate(shared)

    const owner = await createImmutableRelease(fixture, 'nebula', '0.9.2', 'nebula-artifact-0008', [
      ['plugins/nebula-NebulaMultiplayerMod/Shared.dll', Buffer.from('nebula-owner-v2')]
    ])
    await service.publishCandidate(owner)
    await service.commitCandidate(owner)
    const collision = await createImmutableRelease(fixture, 'bridge', '0.2.0', 'bridge-artifact-0002', [
      ['plugins/nebula-NebulaMultiplayerMod/Shared.dll', Buffer.from('bridge-collision')]
    ])
    await expect(service.publishCandidate(collision)).rejects.toMatchObject({ code: 'UPDATE_RELEASE_FILE_TYPE_FORBIDDEN' })

    const next = await createImmutableRelease(fixture, 'nebula', '0.9.3', 'nebula-artifact-0009', [
      ['plugins/nebula-NebulaMultiplayerMod/Nebula.dll', Buffer.from('next')]
    ])
    const lockRoot = path.join(fixture.controlRoot, 'locks')
    await writeFile(path.join(lockRoot, 'live.lock'), JSON.stringify({ host: 'another-host', bootId: 'unknown', pid: process.pid }))
    await expect(createService(fixture).publishCandidate(next)).rejects.toMatchObject({ code: 'UPDATE_LIVE_LOCK_BUSY' })
  })

  it('never follows a linked or reparse live root', async () => {
    const fixture = await createFixture()
    const request = await createImmutableRelease(fixture, 'nebula', '0.9.1', 'nebula-artifact-0010', [
      ['plugins/nebula-NebulaMultiplayerMod/Nebula.dll', Buffer.from('candidate')]
    ])
    const linkedRoot = path.join(fixture.root, 'linked-live')
    await symlink(fixture.liveRoot, linkedRoot, process.platform === 'win32' ? 'junction' : 'dir')
    const service = new FixedLiveComponentDeployment({
      immutableReleaseRoot: fixture.releaseRoot,
      controlRoot: fixture.controlRoot,
      componentRoots: { nebula: linkedRoot, bepinex: linkedRoot, bridge: linkedRoot, control: linkedRoot },
      limits,
      verifyStoppedState: async () => ({ processStopped: true, portClosed: true })
    })

    await expect(service.publishCandidate(request)).rejects.toMatchObject({ code: 'UPDATE_LIVE_DIRECTORY_INVALID' })
  })
})

interface Fixture {
  root: string
  releaseRoot: string
  controlRoot: string
  liveRoot: string
}

async function createFixture(): Promise<Fixture> {
  const root = await mkdtemp(path.join(tmpdir(), 'dyson-live-deployment-'))
  temporaryRoots.push(root)
  const releaseRoot = path.join(root, 'releases')
  const controlRoot = path.join(root, 'control')
  const liveRoot = path.join(root, 'live')
  await Promise.all([
    mkdir(releaseRoot),
    mkdir(path.join(liveRoot, 'plugins'), { recursive: true })
  ])
  return { root, releaseRoot, controlRoot, liveRoot }
}

function createService(
  fixture: Fixture,
  overrides: Partial<Pick<FixedLiveComponentDeploymentOptions, 'verifyStoppedState'>> = {}
): FixedLiveComponentDeployment {
  return new FixedLiveComponentDeployment({
    immutableReleaseRoot: fixture.releaseRoot,
    controlRoot: fixture.controlRoot,
    componentRoots: { nebula: fixture.liveRoot, bepinex: fixture.liveRoot, bridge: fixture.liveRoot, control: fixture.liveRoot },
    limits,
    now: () => new Date('2026-08-30T12:00:00.000Z'),
    verifyStoppedState: async () => ({ processStopped: true, portClosed: true }),
    ...overrides
  })
}

async function createImmutableRelease(
  fixture: Fixture,
  component: ManagedUpdateComponent,
  version: string,
  artifactId: string,
  files: Array<readonly [relativePath: string, bytes: Buffer]>
): Promise<FixedLiveComponentCandidateRequest> {
  const releaseId = `${component}-${sha256(Buffer.from(`${component}\0${version}\0${artifactId}`)).slice(0, 32)}`
  const release = path.join(fixture.releaseRoot, component, releaseId)
  const payload = path.join(release, 'payload')
  await mkdir(payload, { recursive: true })
  for (const [relativePath, bytes] of files) {
    const destination = path.join(payload, ...relativePath.split('/'))
    await mkdir(path.dirname(destination), { recursive: true })
    await writeFile(destination, bytes)
  }
  const manifest = {
    format: 'dyson-control-component-release',
    schemaVersion: 1,
    component,
    version,
    artifactId,
    files: files.map(([relativePath, bytes]) => ({ relativePath, sizeBytes: bytes.length, sha256: sha256(bytes) }))
  }
  await writeFile(path.join(release, 'release.json'), JSON.stringify({
    format: 'dyson-control-component-immutable-release',
    schemaVersion: 1,
    releaseId,
    component,
    artifactId,
    artifactSha256: sha256(Buffer.from(`artifact:${artifactId}`)),
    version,
    manifest,
    createdAt: '2026-08-30T10:00:00.000Z'
  }))
  return { requestId: randomUUID(), component, releaseId, artifactId, targetVersion: version }
}

function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex')
}
