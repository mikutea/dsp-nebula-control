import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  CutoverBrokerProfileError,
  readCutoverBrokerProfile,
  type ReadCutoverBrokerProfileOptions
} from './broker-profile.js'

const temporaryRoots: string[] = []

afterEach(() => {
  for (const root of temporaryRoots.splice(0).reverse()) {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

describe('cutover broker profile', () => {
  it('strictly validates and freezes every fixed path and dependency hash', () => {
    const fixture = createFixture()
    const result = readCutoverBrokerProfile(fixture.options)

    expect(result).toEqual(fixture.profile)
    expect(Object.isFrozen(result)).toBe(true)
  })

  it.each([
    'DysonHostMutationLease.Common.ps1',
    'cutover/DysonCutoverHost.Common.ps1',
    'cutover/Invoke-DysonCutoverAction.ps1',
    'Install-DysonRuntimeTasks.ps1',
    'cutover-broker/DysonCutoverBroker.Common.ps1',
    'cutover-broker/DysonCutoverBroker.TaskAcl.ps1',
    'cutover-broker/Install-DysonCutoverBrokerTask.ps1',
    'cutover-broker/Invoke-DysonCutoverBrokerWorker.ps1',
    'cutover-broker/Submit-DysonCutoverBrokerRequest.ps1'
  ])('rejects drift in the hash-pinned dependency %s', (relative) => {
    const fixture = createFixture()
    fs.appendFileSync(path.join(fixture.scriptRoot, ...relative.split('/')), '# drift\n')

    expect(() => readCutoverBrokerProfile(fixture.options)).toThrowError(
      expect.objectContaining({ code: 'CUTOVER_BROKER_PROFILE_BINDING_MISMATCH' })
    )
  })

  it('rejects an absent profile before the API can report cutover readiness', () => {
    const fixture = createFixture()
    fs.rmSync(fixture.options.profileFile)

    expect(() => readCutoverBrokerProfile(fixture.options)).toThrowError(
      expect.objectContaining({ code: 'CUTOVER_BROKER_PROFILE_UNAVAILABLE' })
    )
  })

  it('rejects strict-schema, fingerprint, and construction binding drift', () => {
    const extra = createFixture()
    writeProfile(extra.options.profileFile, { ...extra.profile, extra: 'not-allowed' })
    expect(() => readCutoverBrokerProfile(extra.options)).toThrowError(
      expect.objectContaining({ code: 'CUTOVER_BROKER_PROFILE_SCHEMA_INVALID' })
    )

    const fingerprint = createFixture()
    writeProfile(fingerprint.options.profileFile, {
      ...fingerprint.profile,
      profileFingerprint: 'f'.repeat(64)
    })
    expect(() => readCutoverBrokerProfile(fingerprint.options)).toThrowError(
      expect.objectContaining({ code: 'CUTOVER_BROKER_PROFILE_FINGERPRINT_INVALID' })
    )

    const binding = createFixture()
    expect(() => readCutoverBrokerProfile({
      ...binding.options,
      serviceUser: '.\\AnotherUser'
    })).toThrowError(expect.objectContaining({
      code: 'CUTOVER_BROKER_PROFILE_BINDING_MISMATCH'
    }))
  })

  it('returns code-only errors without leaking a path or parsed profile', () => {
    const fixture = createFixture()
    fs.writeFileSync(fixture.options.profileFile, '{bad json\n')

    let error: unknown
    try { readCutoverBrokerProfile(fixture.options) } catch (caught) { error = caught }
    expect(error).toBeInstanceOf(CutoverBrokerProfileError)
    expect(error).toMatchObject({
      code: 'CUTOVER_BROKER_PROFILE_SCHEMA_INVALID',
      message: 'CUTOVER_BROKER_PROFILE_SCHEMA_INVALID'
    })
    expect(JSON.stringify(error)).not.toContain(fixture.root)
  })
})

function createFixture(): {
  root: string
  scriptRoot: string
  options: ReadCutoverBrokerProfileOptions
  profile: Record<string, unknown>
} {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dyson-cutover-broker-profile-'))
  temporaryRoots.push(root)
  const dataRoot = path.join(root, 'data')
  const brokerRoot = path.join(dataRoot, 'cutover-broker')
  const scriptRoot = path.join(root, 'scripts', 'windows')
  const brokerScriptRoot = path.join(scriptRoot, 'cutover-broker')
  const projectRoot = path.join(root, 'project')
  const authorityRoot = path.join(dataRoot, 'authority-inventory')
  const runtimeBootstrapRoot = path.join(root, 'game-bootstrap')
  const runtimeTaskTransactionRoot = path.join(root, 'runtime-task-transactions')
  for (const directory of [
    brokerRoot,
    path.join(scriptRoot, 'cutover'),
    brokerScriptRoot,
    projectRoot,
    authorityRoot,
    runtimeBootstrapRoot,
    runtimeTaskTransactionRoot
  ]) fs.mkdirSync(directory, { recursive: true })

  const authorityProfileFile = path.join(authorityRoot, 'authority-profile.json')
  const dependencyFiles = [
    authorityProfileFile,
    path.join(scriptRoot, 'DysonHostMutationLease.Common.ps1'),
    path.join(scriptRoot, 'cutover', 'DysonCutoverHost.Common.ps1'),
    path.join(scriptRoot, 'cutover', 'Invoke-DysonCutoverAction.ps1'),
    path.join(scriptRoot, 'Install-DysonRuntimeTasks.ps1'),
    path.join(brokerScriptRoot, 'DysonCutoverBroker.Common.ps1'),
    path.join(brokerScriptRoot, 'DysonCutoverBroker.TaskAcl.ps1'),
    path.join(brokerScriptRoot, 'Install-DysonCutoverBrokerTask.ps1'),
    path.join(brokerScriptRoot, 'Invoke-DysonCutoverBrokerWorker.ps1'),
    path.join(brokerScriptRoot, 'Submit-DysonCutoverBrokerRequest.ps1')
  ]
  dependencyFiles.forEach((file, index) => {
    fs.writeFileSync(file, `# fictional dependency ${index}\n`)
  })

  const core = {
    protocol: 'DYSON_CONTROL_CUTOVER_BROKER_PROFILE_V1',
    schemaVersion: 1,
    brokerRoot,
    brokerScriptRoot,
    projectRoot,
    dataRoot,
    authorityProfileFile,
    authorityProfileSha256: sha256File(authorityProfileFile),
    cutoverScriptRoot: scriptRoot,
    leaseCommonSha256: sha256File(dependencyFiles[1]!),
    cutoverHostCommonSha256: sha256File(dependencyFiles[2]!),
    cutoverActionScriptSha256: sha256File(dependencyFiles[3]!),
    runtimeTaskInstallerSha256: sha256File(dependencyFiles[4]!),
    runtimeBootstrapRoot,
    runtimeTaskTransactionRoot,
    serviceUser: '.\\FictionalDyson',
    gamePort: 8469,
    taskName: 'Dyson-Control-Cutover-Broker',
    taskPath: '\\',
    localServiceSid: 'S-1-5-19',
    commonScriptSha256: sha256File(dependencyFiles[5]!),
    taskAclScriptSha256: sha256File(dependencyFiles[6]!),
    installerScriptSha256: sha256File(dependencyFiles[7]!),
    workerScriptSha256: sha256File(dependencyFiles[8]!),
    submitScriptSha256: sha256File(dependencyFiles[9]!)
  }
  const profile = {
    ...core,
    profileFingerprint: sha256Text(JSON.stringify(core))
  }
  const profileFile = path.join(brokerRoot, 'broker-profile.json')
  writeProfile(profileFile, profile)
  return {
    root,
    scriptRoot,
    profile,
    options: {
      profileFile,
      scriptRoot,
      projectRoot,
      dataRoot,
      authorityProfileFile,
      runtimeBootstrapRoot,
      runtimeTaskTransactionRoot,
      serviceUser: '.\\FictionalDyson',
      gamePort: 8469
    }
  }
}

function writeProfile(profileFile: string, value: unknown): void {
  fs.writeFileSync(profileFile, `${JSON.stringify(value)}\n`)
}

function sha256File(file: string): string {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex')
}

function sha256Text(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}
