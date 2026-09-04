import { createHash, randomUUID } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  CutoverAuthorityProfileError,
  readCutoverAuthorityProfile,
  type ReadCutoverAuthorityProfileOptions
} from './profile.js'

describe('cutover authority profile', () => {
  let root: string
  let fixture: ReturnType<typeof makeFixture>

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'dyson-cutover-profile-'))
    fixture = makeFixture(root)
  })

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true })
  })

  it('validates the exact fixed profile, local script bytes, identities and inventory revision', () => {
    const profile = readCutoverAuthorityProfile(fixture.options)
    expect(profile).toMatchObject({
      protocol: 'DYSON_GSMANAGER_AUTHORITY_PROFILE_V1',
      serviceUser: '.\\FictionalDyson',
      gamePort: 8469,
      candidateAuthority: {
        allowedTransitions: ['legacy-preimage-disabled', 'prepared-disabled', 'active']
      }
    })
    expect(profile.inventoryRevision).toMatch(/^[0-9a-f]{64}$/)
    expect(Object.isFrozen(profile)).toBe(true)
    expect(Object.isFrozen(profile.candidateAuthority)).toBe(true)
  })

  it('rejects an alternate profile location even when its bytes are valid', () => {
    const alternate = path.join(root, 'alternate-profile.json')
    fs.copyFileSync(fixture.options.profileFile, alternate)
    expectCode({ ...fixture.options, profileFile: alternate }, 'CUTOVER_PROFILE_BINDING_MISMATCH')
  })

  it.each([
    ['projectRoot', 'other-project'],
    ['dataRoot', 'other-data'],
    ['runtimeBootstrapRoot', 'other-bootstrap'],
    ['runtimeTaskTransactionRoot', 'other-transactions']
  ] as const)('rejects a different configured %s binding', (field, name) => {
    const other = path.join(root, name)
    fs.mkdirSync(other)
    expectCode({ ...fixture.options, [field]: other }, 'CUTOVER_PROFILE_BINDING_MISMATCH')
  })

  it('rejects service, port, bootstrap and previous-script drift', () => {
    expectCode({ ...fixture.options, serviceUser: '.\\OtherUser' }, 'CUTOVER_PROFILE_BINDING_MISMATCH')
    expectCode({ ...fixture.options, gamePort: 8470 }, 'CUTOVER_PROFILE_BINDING_MISMATCH')

    fs.appendFileSync(path.join(fixture.options.runtimeBootstrapRoot, 'Start-DysonServer.ps1'), 'drift')
    expectCode(fixture.options, 'CUTOVER_PROFILE_BINDING_MISMATCH')
    fixture = makeFixture(root, true)
    fs.appendFileSync(path.join(
      fixture.options.dataRoot, 'private', 'gsmanager-authority', 'stop-dyson-server.ps1'
    ), 'drift')
    expectCode(fixture.options, 'CUTOVER_PROFILE_BINDING_MISMATCH')
  })

  it('rejects unknown fields, a reordered transition set and a forged revision', () => {
    mutateProfile(fixture.options.profileFile, (profile) => { profile.extra = true })
    expectCode(fixture.options, 'CUTOVER_PROFILE_SCHEMA_INVALID')

    fixture = makeFixture(root, true)
    mutateProfile(fixture.options.profileFile, (profile) => {
      profile.candidateAuthority.allowedTransitions.reverse()
      resign(profile)
    })
    expectCode(fixture.options, 'CUTOVER_PROFILE_SCHEMA_INVALID')

    fixture = makeFixture(root, true)
    mutateProfile(fixture.options.profileFile, (profile) => {
      profile.inventoryRevision = 'f'.repeat(64)
    })
    expectCode(fixture.options, 'CUTOVER_PROFILE_REVISION_INVALID')
  })

  it('rejects malformed, missing, oversized and redirected profile files with code-only errors', () => {
    fs.writeFileSync(fixture.options.profileFile, '{not-json')
    expectCode(fixture.options, 'CUTOVER_PROFILE_SCHEMA_INVALID')

    fixture = makeFixture(root, true)
    fs.rmSync(fixture.options.profileFile)
    expectCode(fixture.options, 'CUTOVER_PROFILE_UNAVAILABLE')

    fixture = makeFixture(root, true)
    fs.writeFileSync(fixture.options.profileFile, Buffer.alloc(129 * 1024, 0x61))
    expectCode(fixture.options, 'CUTOVER_PROFILE_REDIRECTED')

    fixture = makeFixture(root, true)
    const authorityRoot = path.dirname(fixture.options.profileFile)
    const target = path.join(root, 'redirected-authority')
    fs.renameSync(authorityRoot, target)
    fs.symlinkSync(target, authorityRoot, 'junction')
    expectCode(fixture.options, 'CUTOVER_PROFILE_REDIRECTED')
  })

  it('rejects relative inputs before touching the filesystem and never leaks a path or payload', () => {
    try {
      readCutoverAuthorityProfile({ ...fixture.options, profileFile: 'relative.json' })
      throw new Error('expected rejection')
    } catch (error) {
      expect(error).toBeInstanceOf(CutoverAuthorityProfileError)
      expect((error as Error).message).toBe('CUTOVER_PROFILE_INPUT_INVALID')
      expect(JSON.stringify(error)).not.toContain(root)
      expect(JSON.stringify(error)).not.toMatch(/FictionalDyson|authority-profile\.json/)
    }
  })
})

function makeFixture(root: string, replace = false) {
  const projectRoot = path.join(root, 'project')
  const dataRoot = path.join(root, 'data')
  const runtimeBootstrapRoot = path.join(root, 'bootstrap')
  const runtimeTaskTransactionRoot = path.join(root, 'transactions')
  if (replace) {
    for (const candidate of [projectRoot, dataRoot, runtimeBootstrapRoot, runtimeTaskTransactionRoot]) {
      fs.rmSync(candidate, { recursive: true, force: true })
    }
  }
  for (const candidate of [
    projectRoot,
    dataRoot,
    runtimeBootstrapRoot,
    runtimeTaskTransactionRoot,
    path.join(dataRoot, 'authority-inventory'),
    path.join(dataRoot, 'private', 'gsmanager-authority')
  ]) fs.mkdirSync(candidate, { recursive: true })
  const bootstrapStart = path.join(runtimeBootstrapRoot, 'Start-DysonServer.ps1')
  const bootstrapStop = path.join(runtimeBootstrapRoot, 'Stop-DysonServer.ps1')
  const previousStart = path.join(dataRoot, 'private', 'gsmanager-authority', 'start-dyson-server.ps1')
  const previousStop = path.join(dataRoot, 'private', 'gsmanager-authority', 'stop-dyson-server.ps1')
  fs.writeFileSync(bootstrapStart, 'fixture bootstrap start\n')
  fs.writeFileSync(bootstrapStop, 'fixture bootstrap stop\n')
  fs.writeFileSync(previousStart, 'fixture previous start\n')
  fs.writeFileSync(previousStop, 'fixture previous stop\n')
  const profileFile = path.join(dataRoot, 'authority-inventory', 'authority-profile.json')
  const profile = buildProfile({
    profileFile, projectRoot, dataRoot, runtimeBootstrapRoot, runtimeTaskTransactionRoot,
    bootstrapStart, bootstrapStop, previousStart, previousStop
  })
  fs.writeFileSync(profileFile, `${JSON.stringify(profile)}\n`)
  const options: ReadCutoverAuthorityProfileOptions = {
    profileFile,
    projectRoot,
    dataRoot,
    runtimeBootstrapRoot,
    runtimeTaskTransactionRoot,
    serviceUser: '.\\FictionalDyson',
    gamePort: 8469
  }
  return { options, profile }
}

function buildProfile(paths: Record<string, string>) {
  const task = (taskName: string) => ({
    taskName, taskPath: '\\', definitionSha256: sha256Text(`task:${taskName}`), enabled: true
  })
  const core = {
    protocol: 'DYSON_GSMANAGER_AUTHORITY_PROFILE_V1',
    schemaVersion: 1,
    requestId: randomUUID(),
    requestFingerprint: sha256Text('request'),
    projectRootIdentity: identity(paths.projectRoot!),
    dataRootIdentity: identity(paths.dataRoot!),
    authorityRootIdentity: identity(path.dirname(paths.profileFile!)),
    runtimeBootstrapIdentity: identity(paths.runtimeBootstrapRoot!),
    runtimeBootstrapStartSha256: sha256File(paths.bootstrapStart!),
    runtimeBootstrapStopSha256: sha256File(paths.bootstrapStop!),
    runtimeTaskTransactionRootIdentity: identity(paths.runtimeTaskTransactionRoot!),
    serviceUser: '.\\FictionalDyson',
    gamePort: 8469,
    previousAuthority: {
      main: task('Dyson-GSManager'),
      start: task('Dyson-GSManager-Server'),
      stop: task('Dyson-GSManager-Stop')
    },
    candidateAuthority: {
      startTaskName: 'Dyson-Nebula-Server',
      stopTaskName: 'Dyson-Nebula-Stop',
      taskPath: '\\',
      legacyPreimage: {
        startDefinitionSha256: sha256Text('legacy-start'),
        stopDefinitionSha256: sha256Text('legacy-stop'),
        expectedEnabledBeforeIsolation: true,
        expectedEnabledAfterIsolation: false
      },
      expectedPreparedDisabled: {
        startDescriptorSha256: sha256Text('prepared-start'),
        stopDescriptorSha256: sha256Text('prepared-stop')
      },
      expectedActive: {
        startDescriptorSha256: sha256Text('active-start'),
        stopDescriptorSha256: sha256Text('active-stop')
      },
      allowedTransitions: ['legacy-preimage-disabled', 'prepared-disabled', 'active']
    },
    previousScriptBundleRevision: sha256Text(`${sha256File(paths.previousStart!)}:${sha256File(paths.previousStop!)}`)
  }
  return { ...core, inventoryRevision: sha256Text(JSON.stringify(core)) }
}

function mutateProfile(file: string, mutate: (profile: any) => void) {
  const profile = JSON.parse(fs.readFileSync(file, 'utf8'))
  mutate(profile)
  fs.writeFileSync(file, `${JSON.stringify(profile)}\n`)
}

function resign(profile: any) {
  const { inventoryRevision: _inventoryRevision, ...core } = profile
  profile.inventoryRevision = sha256Text(JSON.stringify(core))
}

function expectCode(options: ReadCutoverAuthorityProfileOptions, code: string) {
  try {
    readCutoverAuthorityProfile(options)
    throw new Error('expected rejection')
  } catch (error) {
    expect(error).toBeInstanceOf(CutoverAuthorityProfileError)
    expect((error as CutoverAuthorityProfileError).code).toBe(code)
    expect((error as Error).message).toBe(code)
  }
}

function identity(candidate: string) {
  const canonical = fs.realpathSync.native(candidate).replace(/[\\/]+$/, '').toUpperCase()
  return `sha256:${sha256Text(canonical)}`
}

function sha256File(candidate: string) {
  return createHash('sha256').update(fs.readFileSync(candidate)).digest('hex')
}

function sha256Text(value: string) {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}
