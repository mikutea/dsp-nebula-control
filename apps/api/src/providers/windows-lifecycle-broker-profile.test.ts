import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  LifecycleBrokerProfileError,
  readLifecycleBrokerProfile,
  type ReadLifecycleBrokerProfileOptions
} from './windows-lifecycle-broker-profile.js'

const dependencyNames = [
  'DysonLifecycleBroker.Common.ps1',
  'DysonLifecycleBroker.TaskAcl.ps1',
  'Install-DysonLifecycleBrokerTask.ps1',
  'Invoke-DysonLifecycleBrokerWorker.ps1',
  'Submit-DysonLifecycleBrokerRequest.ps1',
  'DysonHostMutationLease.Common.ps1',
  'Start-DysonServer.ps1',
  'Stop-DysonServer.ps1'
] as const
const taskPathSeparator = path.win32.sep
const workerTaskPath = [taskPathSeparator, 'DysonControl', taskPathSeparator].join('')

const temporaryRoots: string[] = []

afterEach(() => {
  for (const root of temporaryRoots.splice(0).reverse()) {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

describe('Windows lifecycle broker profile', () => {
  it('accepts only the exact installed bindings and deeply freezes the result', () => {
    const fixture = createFixture()

    const profile = readLifecycleBrokerProfile(fixture.options)

    expect(profile).toEqual(fixture.profile)
    expect(Object.isFrozen(profile)).toBe(true)
    expect(Object.isFrozen(profile.serverTask)).toBe(true)
    expect(Object.isFrozen(profile.stopTask)).toBe(true)
    expect(Object.isFrozen(profile.dependencyHashes)).toBe(true)
    expect(profile.dependencyHashes.every(Object.isFrozen)).toBe(true)
    expect(profile.dependencyHashes.map(({ name }) => name)).toEqual(dependencyNames)
  })

  it.each([
    ['extra top-level field', (profile: Record<string, unknown>) => ({ ...profile, arbitraryCommand: 'whoami' })],
    ['missing required field', (profile: Record<string, unknown>) => {
      const changed = { ...profile }
      delete changed.workerTaskPath
      return changed
    }],
    ['extra nested task field', (profile: Record<string, unknown>) => ({
      ...profile,
      serverTask: { ...(profile.serverTask as Record<string, unknown>), executable: 'Arbitrary.ps1' }
    })],
    ['extra dependency field', (profile: Record<string, unknown>) => ({
      ...profile,
      dependencyHashes: (profile.dependencyHashes as Array<Record<string, unknown>>).map((entry, index) =>
        index === 0 ? { ...entry, arguments: '-Command whoami' } : entry)
    })],
    ['duplicate dependency', (profile: Record<string, unknown>) => {
      const dependencies = (profile.dependencyHashes as Array<Record<string, unknown>>).map((entry) => ({ ...entry }))
      dependencies[7] = { ...dependencies[0]! }
      return { ...profile, dependencyHashes: dependencies }
    }]
  ] as const)('rejects an exact-schema violation: %s', (_label, mutate) => {
    const fixture = createFixture()
    writeJson(fixture.options.profileFile, mutate(fixture.profile))

    expect(() => readLifecycleBrokerProfile(fixture.options)).toThrowError(
      expect.objectContaining({ code: 'LIFECYCLE_BROKER_PROFILE_SCHEMA_INVALID' })
    )
  })

  it.each([
    'brokerRoot',
    'brokerScriptRoot',
    'projectRoot',
    'dataRoot',
    'installedWindowsRoot',
    'runtimeBootstrapRoot'
  ] as const)('rejects drift in the fixed %s path binding', (field) => {
    const fixture = createFixture()
    const other = path.join(fixture.root, 'other', field)
    fs.mkdirSync(other, { recursive: true })
    writeJson(fixture.options.profileFile, { ...fixture.profile, [field]: other })

    expect(() => readLifecycleBrokerProfile(fixture.options)).toThrowError(
      expect.objectContaining({ code: 'LIFECYCLE_BROKER_PROFILE_BINDING_MISMATCH' })
    )
  })

  it('binds the service identity, game port, and profile file to construction-time values', () => {
    const service = createFixture()
    expect(() => readLifecycleBrokerProfile({
      ...service.options,
      serviceUser: '.\\AnotherFictionalUser'
    })).toThrowError(expect.objectContaining({
      code: 'LIFECYCLE_BROKER_PROFILE_BINDING_MISMATCH'
    }))

    const port = createFixture()
    expect(() => readLifecycleBrokerProfile({
      ...port.options,
      gamePort: port.options.gamePort + 1
    })).toThrowError(expect.objectContaining({
      code: 'LIFECYCLE_BROKER_PROFILE_BINDING_MISMATCH'
    }))

    const profilePath = createFixture()
    const alternateProfile = path.join(profilePath.root, 'alternate', 'broker-profile.json')
    fs.mkdirSync(path.dirname(alternateProfile), { recursive: true })
    fs.copyFileSync(profilePath.options.profileFile, alternateProfile)
    expect(() => readLifecycleBrokerProfile({
      ...profilePath.options,
      profileFile: alternateProfile
    })).toThrowError(expect.objectContaining({
      code: 'LIFECYCLE_BROKER_PROFILE_BINDING_MISMATCH'
    }))
  })

  it('accepts only fixed task names, paths, and bounded profile fields', () => {
    const wrongTask = createFixture()
    writeJson(wrongTask.options.profileFile, {
      ...wrongTask.profile,
      serverTask: {
        ...(wrongTask.profile.serverTask as Record<string, unknown>),
        name: 'Dyson-Nebula-Stop'
      }
    })
    expect(() => readLifecycleBrokerProfile(wrongTask.options)).toThrowError(
      expect.objectContaining({ code: 'LIFECYCLE_BROKER_PROFILE_SCHEMA_INVALID' })
    )

    const wrongTaskPath = createFixture()
    writeJson(wrongTaskPath.options.profileFile, {
      ...wrongTaskPath.profile,
      stopTask: {
        ...(wrongTaskPath.profile.stopTask as Record<string, unknown>),
        path: [taskPathSeparator, 'Fictional', taskPathSeparator].join('')
      }
    })
    expect(() => readLifecycleBrokerProfile(wrongTaskPath.options)).toThrowError(
      expect.objectContaining({ code: 'LIFECYCLE_BROKER_PROFILE_SCHEMA_INVALID' })
    )

    const timeout = createFixture()
    writeJson(timeout.options.profileFile, { ...timeout.profile, dispatchReadyTimeoutSeconds: 61 })
    expect(() => readLifecycleBrokerProfile(timeout.options)).toThrowError(
      expect.objectContaining({ code: 'LIFECYCLE_BROKER_PROFILE_SCHEMA_INVALID' })
    )
  })

  it.each(dependencyNames)('rejects SHA-256 drift in the pinned dependency %s', (name) => {
    const fixture = createFixture()
    fs.appendFileSync(fixture.dependencyPaths.get(name)!, '# fictional drift\n')

    expect(() => readLifecycleBrokerProfile(fixture.options)).toThrowError(
      expect.objectContaining({ code: 'LIFECYCLE_BROKER_PROFILE_BINDING_MISMATCH' })
    )
  })

  it('rejects a dependency path rebound to a different existing file', () => {
    const fixture = createFixture()
    const alternate = path.join(fixture.root, 'alternate-dependency.ps1')
    fs.writeFileSync(alternate, '# fictional alternate dependency\n')
    const dependencies = fixture.profile.dependencyHashes as Array<Record<string, unknown>>
    writeJson(fixture.options.profileFile, {
      ...fixture.profile,
      dependencyHashes: dependencies.map((entry, index) => index === 0
        ? { ...entry, path: alternate, sha256: sha256File(alternate) }
        : entry)
    })

    expect(() => readLifecycleBrokerProfile(fixture.options)).toThrowError(
      expect.objectContaining({ code: 'LIFECYCLE_BROKER_PROFILE_BINDING_MISMATCH' })
    )
  })

  it('fails closed when any required dependency is missing', () => {
    const fixture = createFixture()
    fs.rmSync(fixture.dependencyPaths.get('Start-DysonServer.ps1')!)

    expect(() => readLifecycleBrokerProfile(fixture.options)).toThrowError(
      expect.objectContaining({ code: 'LIFECYCLE_BROKER_PROFILE_UNAVAILABLE' })
    )
  })

  it('rejects a reparse-point ancestor instead of following it', () => {
    const fixture = createFixture()
    const brokerScriptRoot = path.join(fixture.scriptRoot, 'lifecycle-broker')
    const target = path.join(fixture.root, 'reparse-target')
    fs.renameSync(brokerScriptRoot, target)
    fs.symlinkSync(target, brokerScriptRoot, process.platform === 'win32' ? 'junction' : 'dir')

    expect(() => readLifecycleBrokerProfile(fixture.options)).toThrowError(
      expect.objectContaining({ code: 'LIFECYCLE_BROKER_PROFILE_REDIRECTED' })
    )
  })

  it('rejects untrusted option paths before any profile is parsed', () => {
    const fixture = createFixture()

    expect(() => readLifecycleBrokerProfile({
      ...fixture.options,
      profileFile: 'relative\\broker-profile.json'
    })).toThrowError(expect.objectContaining({
      code: 'LIFECYCLE_BROKER_PROFILE_INPUT_INVALID'
    }))
    expect(() => readLifecycleBrokerProfile({
      ...fixture.options,
      scriptRoot: `${fixture.scriptRoot}\"-Injected`
    })).toThrowError(expect.objectContaining({
      code: 'LIFECYCLE_BROKER_PROFILE_INPUT_INVALID'
    }))
  })

  it('returns code-only errors without exposing a fictional path or profile content', () => {
    const fixture = createFixture()
    fs.writeFileSync(fixture.options.profileFile, '{bad json\n')

    let error: unknown
    try { readLifecycleBrokerProfile(fixture.options) } catch (caught) { error = caught }

    expect(error).toBeInstanceOf(LifecycleBrokerProfileError)
    expect(error).toMatchObject({
      code: 'LIFECYCLE_BROKER_PROFILE_SCHEMA_INVALID',
      message: 'LIFECYCLE_BROKER_PROFILE_SCHEMA_INVALID'
    })
    expect(JSON.stringify(error)).not.toContain(fixture.root)
    expect(JSON.stringify(error)).not.toContain('.\\FictionalDyson')
  })
})

interface Fixture {
  root: string
  scriptRoot: string
  options: ReadLifecycleBrokerProfileOptions
  profile: Record<string, unknown> & {
    serverTask: Record<string, unknown>
    stopTask: Record<string, unknown>
    dependencyHashes: Array<Record<string, unknown>>
  }
  dependencyPaths: Map<(typeof dependencyNames)[number], string>
}

function createFixture(): Fixture {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fictional-dyson-lifecycle-profile-'))
  temporaryRoots.push(root)
  const dataRoot = path.join(root, 'data')
  const brokerRoot = path.join(dataRoot, 'lifecycle-broker')
  const scriptRoot = path.join(root, 'installed', 'scripts', 'windows')
  const brokerScriptRoot = path.join(scriptRoot, 'lifecycle-broker')
  const projectRoot = path.join(root, 'project')
  const runtimeBootstrapRoot = path.join(root, 'game-bootstrap')
  for (const directory of [brokerRoot, brokerScriptRoot, projectRoot, runtimeBootstrapRoot]) {
    fs.mkdirSync(directory, { recursive: true })
  }

  const dependencyPaths = new Map<(typeof dependencyNames)[number], string>([
    ['DysonLifecycleBroker.Common.ps1', path.join(brokerScriptRoot, 'DysonLifecycleBroker.Common.ps1')],
    ['DysonLifecycleBroker.TaskAcl.ps1', path.join(brokerScriptRoot, 'DysonLifecycleBroker.TaskAcl.ps1')],
    ['Install-DysonLifecycleBrokerTask.ps1', path.join(brokerScriptRoot, 'Install-DysonLifecycleBrokerTask.ps1')],
    ['Invoke-DysonLifecycleBrokerWorker.ps1', path.join(brokerScriptRoot, 'Invoke-DysonLifecycleBrokerWorker.ps1')],
    ['Submit-DysonLifecycleBrokerRequest.ps1', path.join(brokerScriptRoot, 'Submit-DysonLifecycleBrokerRequest.ps1')],
    ['DysonHostMutationLease.Common.ps1', path.join(scriptRoot, 'DysonHostMutationLease.Common.ps1')],
    ['Start-DysonServer.ps1', path.join(runtimeBootstrapRoot, 'Start-DysonServer.ps1')],
    ['Stop-DysonServer.ps1', path.join(runtimeBootstrapRoot, 'Stop-DysonServer.ps1')]
  ])
  dependencyNames.forEach((name, index) => {
    fs.writeFileSync(dependencyPaths.get(name)!, `# fictional pinned dependency ${index}\n`)
  })

  const profile: Fixture['profile'] = {
    protocol: 'DYSON_CONTROL_LIFECYCLE_BROKER_PROFILE_V1',
    schemaVersion: 1,
    brokerRoot,
    brokerScriptRoot,
    projectRoot,
    dataRoot,
    installedWindowsRoot: scriptRoot,
    runtimeBootstrapRoot,
    serviceUser: '.\\FictionalDyson',
    gamePort: 8469,
    workerTaskName: 'Dyson-Control-Lifecycle-Broker',
    workerTaskPath,
    serverTask: {
      name: 'Dyson-Nebula-Server',
      path: taskPathSeparator,
      descriptorHash: 'a'.repeat(64)
    },
    stopTask: {
      name: 'Dyson-Nebula-Stop',
      path: taskPathSeparator,
      descriptorHash: 'b'.repeat(64)
    },
    dependencyHashes: dependencyNames.map((name) => ({
      name,
      path: dependencyPaths.get(name)!,
      sha256: sha256File(dependencyPaths.get(name)!)
    })),
    dispatchReadyTimeoutSeconds: 20,
    createdAt: '2031-02-03T04:05:06.000Z'
  }
  const profileFile = path.join(brokerRoot, 'broker-profile.json')
  writeJson(profileFile, profile)
  return {
    root,
    scriptRoot,
    profile,
    dependencyPaths,
    options: {
      profileFile,
      scriptRoot,
      projectRoot,
      dataRoot,
      runtimeBootstrapRoot,
      serviceUser: '.\\FictionalDyson',
      gamePort: 8469
    }
  }
}

function writeJson(file: string, value: unknown): void {
  fs.writeFileSync(file, `${JSON.stringify(value)}\n`)
}

function sha256File(file: string): string {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex')
}
