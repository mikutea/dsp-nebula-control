import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, it } from 'node:test'
import { promisify } from 'node:util'
import {
  buildArtifactManifestForFixture,
  canonicalEvidenceJson,
  runPublicReleaseScan
} from './scanner.mjs'
import { EXACT_ALLOWLIST } from './policy.mjs'

const execFileAsync = promisify(execFile)
const projectRoot = path.resolve(import.meta.dirname, '..', '..')
const temporaryRoots = []

function gitTextBlobId (bytes) {
  // Git stores text blobs with LF even when a Windows checkout materializes
  // the same file as CRLF through `.gitattributes` (`eol=crlf`).  Bind the
  // reviewed history exception to those canonical repository bytes instead
  // of the platform-specific working-tree representation.
  const canonicalBytes = Buffer.from(bytes.toString('latin1').replaceAll('\r\n', '\n'), 'latin1')
  const blobHeader = Buffer.from(`blob ${canonicalBytes.length}\0`, 'utf8')
  return createHash('sha1').update(blobHeader).update(canonicalBytes).digest('hex')
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('public release hygiene gate', () => {
  it('pins reviewed parser and negative-test history exceptions to the current Git blobs', async () => {
    const bindings = [
      ['HIGH_ENTROPY_SECRET_ASSIGNMENT', 'scripts/public-release/scanner.mjs'],
      ['SECRET_LITERAL_ASSIGNMENT', 'scripts/public-release/scanner.mjs'],
      ['UNC_PATH', 'scripts/public-release/scanner.mjs'],
      ['SECRET_LITERAL_ASSIGNMENT', 'scripts/public-release/scanner.test.mjs'],
      ['UNC_PATH', 'scripts/windows/configuration/DysonConfiguration.Common.ps1'],
      ['UNC_PATH', 'scripts/windows/deployment/DysonDeployment.Common.ps1'],
      ['UNC_PATH', 'scripts/windows/deployment/SelfTest-DysonControlDeployment.ps1'],
      ['PRIVATE_IP_ADDRESS', 'scripts/windows/network/SelfTest-DysonNebulaNetworkV2.ps1']
    ]
    for (const [ruleId, relativePath] of bindings) {
      const bytes = await readFile(path.join(projectRoot, ...relativePath.split('/')))
      const blobId = gitTextBlobId(bytes)
      const crlfBytes = Buffer.from(bytes.toString('latin1').replaceAll('\r\n', '\n').replaceAll('\n', '\r\n'), 'latin1')
      assert.equal(gitTextBlobId(crlfBytes), blobId, `Git text hash changed across EOL checkout: ${relativePath}`)
      const matches = EXACT_ALLOWLIST.filter((entry) => entry.scope === 'history'
        && entry.ruleId === ruleId && entry.path === relativePath && entry.blobId === blobId)
      assert.equal(matches.length, 1, `stale or missing history binding: ${relativePath}`)
    }

    const repository = await newRepository()
    for (const relativePath of [...new Set(bindings.map(([, file]) => file))]) {
      const bytes = await readFile(path.join(projectRoot, ...relativePath.split('/')))
      const canonicalBytes = Buffer.from(bytes.toString('latin1').replaceAll('\r\n', '\n'), 'latin1')
      await write(repository, relativePath, canonicalBytes)
    }
    await commitAll(repository, 'reviewed parser blobs')
    const evidence = await runPublicReleaseScan({ repositoryRoot: repository, history: true })
    assert.equal(evidence.passed, true)
    assert.deepEqual(evidence.findings, [])
  })

  it('keeps command-line failures machine-readable and free of host paths', async () => {
    let failure
    try {
      await execFileAsync(process.execPath, [path.join(import.meta.dirname, 'check.mjs'), '--artifact'], {
        cwd: process.cwd(), windowsHide: true
      })
    } catch (error) {
      failure = error
    }
    assert.equal(failure?.code, 2)
    const output = String(failure.stdout)
    const parsed = JSON.parse(output)
    assert.deepEqual(parsed.findings, [{ ruleId: 'UNSAFE_CANDIDATE_PATH' }])
    assert.equal(output.includes(process.cwd()), false)
  })

  it('accepts a deterministic fictional worktree and reachable history', async () => {
    const repository = await newRepository()
    await write(repository, '.gitignore', 'ignored.env\n')
    await write(repository, '.env.example', 'PUBLIC_ORIGIN=https://game.example.com\nJOIN_IP=203.0.113.42\n')
    await write(repository, 'README.md', '# Fictional fixture\n')
    await write(repository, 'ignored.env', `TOKEN=${knownToken()}\n`)
    await commitAll(repository, 'clean fixture')

    const first = await runPublicReleaseScan({ repositoryRoot: repository, history: true })
    const second = await runPublicReleaseScan({ repositoryRoot: repository, history: true })
    assert.equal(first.passed, true)
    assert.deepEqual(second, first)
    assert.equal(canonicalEvidenceJson(first), canonicalEvidenceJson(second))
    assert.equal(first.repository.dirty, false)
    assert.equal(first.scopes.history.scannedFiles > 0, true)
    assert.equal(canonicalEvidenceJson(first).includes(repository), false)
  })

  it('accepts only exact public release content hosts used by fixed upstream acquisition', async () => {
    const repository = await newRepository()
    await write(repository, 'references.txt', [
      'https://release-assets.githubusercontent.com/fictional/signed.zip',
      'https://objects.githubusercontent.com/fictional/signed.zip',
      'https://gcdn.thunderstore.io/package/Fictional/ServerHelper/1.2.3/',
      'https://api.nuget.org/v3/index.json',
      'https://nuget.bepinex.dev/v3/index.json',
      'https://react.dev/errors/418'
    ].join('\n'))
    await commitAll(repository, 'fixed public GitHub content host references')

    const evidence = await runPublicReleaseScan({ repositoryRoot: repository })
    assert.equal(evidence.passed, true)

    const lookalikeHost = ['api', 'nuget', 'org', 'invalidly-real', 'net'].join('.')
    await write(repository, 'references.txt', `https://${lookalikeHost}/v3/index.json\n`)
    const rejected = await runPublicReleaseScan({ repositoryRoot: repository })
    assertRules(rejected, ['PRODUCTION_ENDPOINT', 'REPOSITORY_DIRTY'])

    const bepinexLookalikeHost = ['nuget', 'bepinex', 'dev', 'invalidly-real', 'net'].join('.')
    await write(repository, 'references.txt', `https://${bepinexLookalikeHost}/v3/index.json\n`)
    const bepinexRejected = await runPublicReleaseScan({ repositoryRoot: repository })
    assertRules(bepinexRejected, ['PRODUCTION_ENDPOINT', 'REPOSITORY_DIRTY'])
  })

  it('allows only the exact canonical JSON Schema host and rejects its lookalikes', async () => {
    const repository = await newRepository()
    await write(repository, 'schema.json', JSON.stringify({
      $schema: 'https://json-schema.org/draft/2020-12/schema'
    }))
    await commitAll(repository, 'canonical JSON Schema dialect fixture')

    const accepted = await runPublicReleaseScan({ repositoryRoot: repository })
    assert.equal(accepted.passed, true)

    const lookalikeSchemaHost = 'evil' + 'json-schema.org'
    await write(repository, 'schema.json', JSON.stringify({
      $schema: `https://${lookalikeSchemaHost}/draft/2020-12/schema`
    }))
    const rejected = await runPublicReleaseScan({ repositoryRoot: repository })
    assert.deepEqual(
      rejected.findings.filter((entry) => entry.ruleId === 'PRODUCTION_ENDPOINT').map((entry) => entry.path),
      ['schema.json']
    )
    assert.equal(rejected.passed, false)
  })

  it('refuses provenance when the repository has no committed HEAD', async () => {
    const repository = await newRepository()

    const evidence = await runPublicReleaseScan({ repositoryRoot: repository })
    assert.equal(evidence.passed, false)
    assert.equal(evidence.repository.available, false)
    assert.equal(evidence.repository.headCommit, null)
    assertRules(evidence, ['REPOSITORY_DIRTY'])
  })

  it('rejects secret files and content without echoing a secret value', async () => {
    const repository = await newRepository()
    const credential = knownToken()
    await write(repository, '.env', `AUTH_TOKEN=${credential}\n`)
    await write(repository, 'world.dsv', 'fictional-save-bytes')
    await write(repository, 'runtime.log', 'fictional log')
    await write(repository, 'private.txt', `${privateKeyHeader()}\n${credential}\n`)
    await write(repository, 'players.json', JSON.stringify({
      players: [{ sessionPlayerId: 'player-000001', displayName: 'Unreviewed Name', online: true }]
    }))

    const evidence = await runPublicReleaseScan({ repositoryRoot: repository })
    assert.equal(evidence.passed, false)
    assertRules(evidence, [
      'FORBIDDEN_ENV_FILE', 'FORBIDDEN_LOG_FILE', 'FORBIDDEN_SAVE_FILE',
      'FORBIDDEN_PLAYER_DATA', 'KNOWN_CREDENTIAL_PATTERN', 'PLAYER_DATA_RECORD', 'PRIVATE_KEY_MATERIAL'
    ])
    assert.equal(canonicalEvidenceJson(evidence).includes(credential), false)
    assert.deepEqual(Object.keys(evidence.findings[0]).every((key) => ['ruleId', 'path', 'blobId'].includes(key)), true)
  })

  it('finds a credential in a reachable historical blob after the worktree is sanitized', async () => {
    const repository = await newRepository()
    const credential = knownToken()
    await write(repository, '.env', `AUTH_TOKEN=${credential}\n`)
    await commitAll(repository, 'unsafe historical fixture')
    await rm(path.join(repository, '.env'))
    await write(repository, 'historical.txt', 'sanitized fictional fixture\n')
    await commitAll(repository, 'sanitize fixture')

    const worktreeOnly = await runPublicReleaseScan({ repositoryRoot: repository })
    const withHistory = await runPublicReleaseScan({ repositoryRoot: repository, history: true })
    assert.equal(worktreeOnly.passed, true)
    assert.equal(withHistory.passed, false)
    const finding = withHistory.findings.find((entry) => entry.ruleId === 'KNOWN_CREDENTIAL_PATTERN')
    assert.match(finding.blobId, /^[0-9a-f]{40,64}$/)
    assert.equal(finding.path, '.env')
    assert.equal(withHistory.findings.some((entry) => entry.ruleId === 'FORBIDDEN_ENV_FILE'
      && entry.path === '.env' && entry.blobId === finding.blobId), true)
    assert.equal(canonicalEvidenceJson(withHistory).includes(credential), false)
  })

  it('rejects private addressing, UNC, user paths, production hosts, and literal or high-entropy secrets', async () => {
    const repository = await newRepository()
    const privateAddress = ['192', '168', '44', '10'].join('.')
    const unc = ['\\\\private-host', 'share', 'save'].join('\\')
    const userPath = ['C:', 'Users', 'Administrator', 'Steam'].join('\\')
    const productionHost = ['game', 'production', 'invalidly-real', 'net'].join('.')
    const highEntropy = 'A7vQ9xLm2Pz8Nr4Ks6Wd1Yc5Ht3Bg0Fj'
    await write(repository, 'config.txt', [
      `address=${privateAddress}`,
      `path=${unc}`,
      `profile=${userPath}`,
      `publicOrigin="https://${productionHost}"`,
      'ServerPassword=short-real-value',
      `AUTH_TOKEN="${highEntropy}"`
    ].join('\n'))

    const evidence = await runPublicReleaseScan({ repositoryRoot: repository })
    assertRules(evidence, [
      'HIGH_ENTROPY_SECRET_ASSIGNMENT', 'PRIVATE_IP_ADDRESS', 'PRODUCTION_ENDPOINT',
      'SECRET_LITERAL_ASSIGNMENT', 'UNC_PATH', 'USER_ABSOLUTE_PATH'
    ])
  })

  it('does not treat fixed Fetch credentials modes as credential literals', async () => {
    const repository = await newRepository()
    await write(repository, 'client.js', [
      'fetch("https://game.example.com/api", { credentials: "include" })',
      'fetch("https://game.example.com/api", { credentials: "omit" })',
      'fetch("https://game.example.com/api", { credentials: "same-origin" })'
    ].join('\n'))
    await commitAll(repository, 'fetch credentials modes fixture')

    const evidence = await runPublicReleaseScan({ repositoryRoot: repository })
    assert.equal(evidence.passed, true)

    await write(repository, 'client.js', 'const authCredential = "real-password-value"\n')
    const rejected = await runPublicReleaseScan({ repositoryRoot: repository })
    assertRules(rejected, ['REPOSITORY_DIRTY', 'SECRET_LITERAL_ASSIGNMENT'])
  })

  it('accepts only shaped assembly public key tokens while retaining ordinary secret detection', async () => {
    const repository = await newRepository()
    await write(repository, 'assembly-identities.ps1', [
      "$NebulaPublicKeyToken = '0123456789abcdef'",
      "$UnsignedAssemblyPublicKeyToken = 'none'"
    ].join('\n'))
    await commitAll(repository, 'assembly public key token fixture')

    const accepted = await runPublicReleaseScan({ repositoryRoot: repository })
    assert.equal(accepted.passed, true)

    const secretAssignments = [
      ['api-key.ps1', "$API_KEY = 'ordinary-live-value'"],
      ['password.ps1', "$Password = 'ordinary-live-value'"],
      ['public-key-token-invalid.ps1', "$NebulaPublicKeyToken = 'ordinary-live-value'"],
      ['secret.ps1', "$Secret = 'ordinary-live-value'"],
      ['token.ps1', "$Token = 'ordinary-live-value'"],
      ['websocket-token.ps1', "$WebSocketToken = 'ordinary-live-value'"]
    ]
    for (const [relativePath, content] of secretAssignments) {
      await write(repository, relativePath, `${content}\n`)
    }
    await commitAll(repository, 'ordinary secret assignment fixtures')

    const rejected = await runPublicReleaseScan({ repositoryRoot: repository })
    assert.deepEqual(
      rejected.findings
        .filter((entry) => entry.ruleId === 'SECRET_LITERAL_ASSIGNMENT')
        .map((entry) => entry.path)
        .sort(),
      secretAssignments.map(([relativePath]) => relativePath).sort()
    )
    assert.equal(rejected.passed, false)
  })

  it('fails closed on embedded image metadata and bounded historical blobs', async () => {
    const repository = await newRepository()
    await write(repository, 'image.png', pngWithMetadata())
    await commitAll(repository, 'metadata fixture')

    const evidence = await runPublicReleaseScan({
      repositoryRoot: repository,
      history: true,
      limits: { maximumHistoryBlobBytes: 8 }
    })
    assertRules(evidence, ['HISTORY_BLOB_TOO_LARGE', 'IMAGE_EMBEDDED_METADATA', 'IMAGE_REVIEW_REQUIRED'])
  })

  it('does not let a blob-scoped historical metadata review suppress new metadata at the same path', async () => {
    const repository = await newRepository()
    const reviewedPath = 'design/dashboard-concept-v1.png'
    await write(repository, reviewedPath, pngWithMetadata())
    await commitAll(repository, 'different metadata fixture')

    const evidence = await runPublicReleaseScan({ repositoryRoot: repository, history: true })
    const historicalFinding = evidence.findings.find((entry) =>
      entry.ruleId === 'IMAGE_EMBEDDED_METADATA' && entry.path === reviewedPath && entry.blobId !== undefined
    )
    assert.notEqual(historicalFinding, undefined)
    assert.notEqual(
      historicalFinding.blobId,
      'e5f7652e74653ca3aa1784bc10fa34e8069f9009'
    )
  })

  it('verifies an existing release manifest and rejects payload tampering', async () => {
    const repository = await newRepository()
    await write(repository, 'README.md', 'Fictional repository\n')
    await commitAll(repository, 'fixture')
    const artifact = await mkdtemp(path.join(tmpdir(), 'dyson-public-release-artifact-'))
    temporaryRoots.push(artifact)
    await mkdir(path.join(artifact, 'apps', 'api', 'dist'), { recursive: true })
    const payload = Buffer.from('export const fixture = true\n', 'utf8')
    const files = [{ path: 'apps/api/dist/index.js', bytes: payload }]
    await writeFile(path.join(artifact, 'apps', 'api', 'dist', 'index.js'), payload)
    await writeFile(path.join(artifact, 'artifact-manifest.json'), JSON.stringify(buildArtifactManifestForFixture(files)))

    const valid = await runPublicReleaseScan({ repositoryRoot: repository, artifactPath: artifact })
    assert.equal(valid.passed, true)
    assert.equal(valid.scopes.artifact.manifest?.fileCount, 1)
    assert.equal(valid.findings.some((entry) => entry.ruleId === 'ARTIFACT_MANIFEST_INVALID'), false)

    const unexpected = Buffer.from('unexpected fixture\n', 'utf8')
    await writeFile(path.join(artifact, 'unexpected.txt'), unexpected)
    await writeFile(path.join(artifact, 'artifact-manifest.json'), JSON.stringify(buildArtifactManifestForFixture([
      ...files, { path: 'unexpected.txt', bytes: unexpected }
    ])))
    const invalidLayout = await runPublicReleaseScan({ repositoryRoot: repository, artifactPath: artifact })
    assertRules(invalidLayout, ['ARTIFACT_PATH_NOT_ALLOWED'])
    assert.equal(invalidLayout.findings.some((entry) => entry.ruleId === 'ARTIFACT_MANIFEST_INVALID'), false)

    await rm(path.join(artifact, 'unexpected.txt'))
    await writeFile(path.join(artifact, 'artifact-manifest.json'), JSON.stringify(buildArtifactManifestForFixture(files)))
    await writeFile(path.join(artifact, 'apps', 'api', 'dist', 'index.js'), 'tampered fixture\n')
    const tampered = await runPublicReleaseScan({ repositoryRoot: repository, artifactPath: artifact })
    assertRules(tampered, ['ARTIFACT_MANIFEST_INVALID'])
    assert.equal(canonicalEvidenceJson(tampered).includes(repository), false)
  })

  it('accepts only the exact Bridge and hostname-WSS sources plus reviewed migration, recovery, or network docs in the artifact protocol', async () => {
    const repository = await newRepository()
    await write(repository, 'README.md', 'Fictional repository\n')
    await commitAll(repository, 'fixture')
    const artifact = await mkdtemp(path.join(tmpdir(), 'dyson-public-release-contract-artifact-'))
    temporaryRoots.push(artifact)
    const windowsSeparator = String.fromCharCode(92)
    const reviewedProtocolPattern = `${windowsSeparator.repeat(2)}A[0-9]+${windowsSeparator.repeat(2)}z`
    const reviewedExtendedPath = [windowsSeparator.repeat(2) + '?', 'UNC', 'placeholder-host'].join(windowsSeparator)
    const privateV2Address = ['10', '0', '0', '1'].join('.')
    const protocolFiles = [
      { path: 'apps/api/dist/index.js', bytes: Buffer.from('export const fixture = true\n') },
      { path: 'docs/DATAROOT-RECOVERY.md', bytes: Buffer.from('# Fictional DataRoot recovery\n') },
      { path: 'docs/GSM-EVALUATION.md', bytes: Buffer.from('# Fictional GSM evaluation\n') },
      { path: 'docs/MIGRATION-GSMANAGER.md', bytes: Buffer.from('# Fictional GSManager removal\n') },
      { path: 'docs/NETWORK-CONNECTIVITY.md', bytes: Buffer.from('# Fictional network contract\n') },
      { path: 'docs/WINDOWS-DEPLOYMENT-DRAFT.md', bytes: Buffer.from('# Fictional deployment draft\n') },
      { path: 'scripts/windows/network/dyson-nebula-network-assessment-v1.schema.json', bytes: Buffer.from('{"title":"Fictional schema"}\n') },
      { path: 'scripts/windows/network/DysonNetwork.Common.ps1', bytes: Buffer.from("$script:Fixture = 'fictional'\n") },
      { path: 'scripts/windows/network/fixtures/shadow-ready-direct-ws.json', bytes: Buffer.from('{"fixture":"fictional"}\n') },
      { path: 'scripts/windows/network/fixtures/shadow-websocket-classification.json', bytes: Buffer.from('{"fixture":"fictional"}\n') },
      { path: 'scripts/windows/network/fixtures/shadow-wss-hostname-boundary.json', bytes: Buffer.from('{"fixture":"fictional"}\n') },
      { path: 'scripts/windows/network/SelfTest-DysonNebulaNetwork.ps1', bytes: Buffer.from("Write-Output 'fictional network self-test'\n") },
      {
        path: 'scripts/windows/network/SelfTest-DysonNebulaNetworkV2.ps1',
        bytes: Buffer.from(`$script:RejectedPrivateAddress = '${privateV2Address}'\n`)
      },
      { path: 'scripts/windows/network/Test-DysonNebulaNetwork.ps1', bytes: Buffer.from("Write-Output 'fictional network assessment'\n") },
      { path: 'scripts/windows/migration/DysonGsManagerRemoval.Common.ps1', bytes: Buffer.from("$script:Fixture = 'fictional'\n") },
      { path: 'scripts/windows/migration/Remove-DysonGsManagerInstallation.ps1', bytes: Buffer.from("Write-Output 'fictional removal'\n") },
      { path: 'scripts/windows/migration/Restore-DysonGsManagerRemoval.ps1', bytes: Buffer.from("Write-Output 'fictional restore'\n") },
      { path: 'scripts/windows/migration/SelfTest-DysonGsManagerRemoval.ps1', bytes: Buffer.from("Write-Output 'fictional self-test'\n") },
      { path: 'scripts/windows/migration/Test-DysonGsManagerRemoval.ps1', bytes: Buffer.from("Write-Output 'fictional inspection'\n") },
      {
        path: 'scripts/windows/DysonHostMutationLease.Common.ps1',
        bytes: Buffer.from(`$script:ReviewedExtendedPath = '${reviewedExtendedPath}'\n`)
      },
      {
        path: 'scripts/windows/configuration/DysonConfiguration.Common.ps1',
        bytes: Buffer.from(`$script:ReviewedExtendedPath = '${reviewedExtendedPath}'\n`)
      },
      {
        path: 'scripts/windows/deployment/DysonDeployment.Common.ps1',
        bytes: Buffer.from(`$script:ReviewedExtendedPath = '${reviewedExtendedPath}'\n`)
      },
      {
        path: 'scripts/windows/deployment/SelfTest-DysonControlDeployment.ps1',
        bytes: Buffer.from(`$script:ReviewedExtendedPath = '${reviewedExtendedPath}'\n`)
      },
      { path: 'integrations/dyson-control-bridge/BridgeFileStore.cs', bytes: Buffer.from('namespace Fictional;\n') },
      {
        path: 'integrations/dyson-control-bridge/BridgeProtocol.cs',
        bytes: Buffer.from(`namespace Fictional { const string ReviewedPattern = "${reviewedProtocolPattern}"; }\n`)
      },
      { path: 'integrations/dyson-control-bridge/DysonControlBridge.csproj', bytes: Buffer.from('<Project />\n') },
      { path: 'integrations/dyson-control-bridge/DysonControlBridgePlugin.cs', bytes: Buffer.from('namespace Fictional;\n') },
      { path: 'integrations/dyson-control-bridge/GameSaveAdapter.cs', bytes: Buffer.from('namespace Fictional;\n') },
      { path: 'integrations/dyson-control-bridge/LoadedSaveEvidencePublisher.cs', bytes: Buffer.from('namespace Fictional;\n') },
      { path: 'integrations/dyson-control-bridge/PlayerRosterPublisher.cs', bytes: Buffer.from('namespace Fictional;\n') },
      { path: 'integrations/dyson-control-bridge/SimulationTelemetrySampler.cs', bytes: Buffer.from('namespace Fictional;\n') },
      { path: 'integrations/dyson-control-bridge/README.md', bytes: Buffer.from('# Fictional Bridge\n') },
      { path: 'integrations/dyson-control-bridge/dyson-control-bridge.cfg.example', bytes: Buffer.from('Enabled=false\n') },
      { path: 'integrations/nebula-hostname-wss/contract.json', bytes: Buffer.from('{"protocol":"FICTIONAL_HOSTNAME_WSS_CONTRACT"}\n') },
      {
        path: 'integrations/nebula-hostname-wss/patches/nebula-v0.9.22-hostname-wss.patch',
        bytes: Buffer.from('diff --git a/src/fictional.cs b/src/fictional.cs\n')
      }
    ]
    for (const file of protocolFiles) {
      await mkdir(path.dirname(path.join(artifact, ...file.path.split('/'))), { recursive: true })
      await writeFile(path.join(artifact, ...file.path.split('/')), file.bytes)
    }
    await writeFile(path.join(artifact, 'artifact-manifest.json'), JSON.stringify(buildArtifactManifestForFixture(protocolFiles)))

    const valid = await runPublicReleaseScan({ repositoryRoot: repository, artifactPath: artifact })
    assert.equal(valid.passed, true)
    assert.equal(valid.totals.allowlistedMatchCount, 6)
    assert.equal(valid.findings.some((entry) => entry.ruleId === 'ARTIFACT_PATH_NOT_ALLOWED'), false)

    const unexpectedFiles = [
      { path: 'docs/UNREVIEWED.md', bytes: Buffer.from('# Unreviewed fixture\n') },
      { path: 'integrations/dyson-control-bridge/Unreviewed.cs', bytes: Buffer.from('namespace Fictional;\n') },
      {
        path: 'integrations/dyson-control-bridge/BridgeProtocol.Copy.cs',
        bytes: Buffer.from(`namespace Fictional { const string ReviewedPattern = "${reviewedProtocolPattern}"; }\n`)
      },
      {
        path: 'integrations/dyson-control-bridge/LoadedSaveEvidencePublisher.Copy.cs',
        bytes: Buffer.from('namespace Fictional;\n')
      },
      {
        path: 'integrations/nebula-hostname-wss/README.md',
        bytes: Buffer.from('# Unreviewed hostname-WSS fixture\n')
      },
      {
        path: 'scripts/windows/DysonHostMutationLease.Copy.ps1',
        bytes: Buffer.from(`$script:ReviewedExtendedPath = '${reviewedExtendedPath}'\n`)
      },
      {
        path: 'scripts/windows/configuration/DysonConfiguration.Copy.ps1',
        bytes: Buffer.from(`$script:ReviewedExtendedPath = '${reviewedExtendedPath}'\n`)
      },
      {
        path: 'scripts/windows/deployment/DysonDeployment.Copy.ps1',
        bytes: Buffer.from(`$script:ReviewedExtendedPath = '${reviewedExtendedPath}'\n`)
      },
      {
        path: 'scripts/windows/deployment/SelfTest-DysonControlDeployment.Copy.ps1',
        bytes: Buffer.from(`$script:ReviewedExtendedPath = '${reviewedExtendedPath}'\n`)
      },
      {
        path: 'scripts/windows/network/SelfTest-DysonNebulaNetworkV2.Copy.ps1',
        bytes: Buffer.from(`$script:RejectedPrivateAddress = '${privateV2Address}'\n`)
      }
    ]
    for (const file of unexpectedFiles) {
      await writeFile(path.join(artifact, ...file.path.split('/')), file.bytes)
    }
    await writeFile(path.join(artifact, 'artifact-manifest.json'), JSON.stringify(buildArtifactManifestForFixture([
      ...protocolFiles, ...unexpectedFiles
    ])))

    const rejected = await runPublicReleaseScan({ repositoryRoot: repository, artifactPath: artifact })
    assert.deepEqual(
      rejected.findings.filter((entry) => entry.ruleId === 'ARTIFACT_PATH_NOT_ALLOWED').map((entry) => entry.path),
      [
        'docs/UNREVIEWED.md',
        'integrations/dyson-control-bridge/BridgeProtocol.Copy.cs',
        'integrations/dyson-control-bridge/LoadedSaveEvidencePublisher.Copy.cs',
        'integrations/dyson-control-bridge/Unreviewed.cs',
        'integrations/nebula-hostname-wss/README.md'
      ]
    )
    assert.deepEqual(
      rejected.findings.filter((entry) => entry.ruleId === 'UNC_PATH').map((entry) => entry.path),
      [
        'integrations/dyson-control-bridge/BridgeProtocol.Copy.cs',
        'scripts/windows/DysonHostMutationLease.Copy.ps1',
        'scripts/windows/configuration/DysonConfiguration.Copy.ps1',
        'scripts/windows/deployment/DysonDeployment.Copy.ps1',
        'scripts/windows/deployment/SelfTest-DysonControlDeployment.Copy.ps1'
      ]
    )
    assert.deepEqual(
      rejected.findings.filter((entry) => entry.ruleId === 'PRIVATE_IP_ADDRESS').map((entry) => entry.path),
      ['scripts/windows/network/SelfTest-DysonNebulaNetworkV2.Copy.ps1']
    )
    assert.equal(rejected.findings.some((entry) => entry.ruleId === 'ARTIFACT_MANIFEST_INVALID'), false)
    assert.equal(rejected.passed, false)

    for (const file of unexpectedFiles) {
      await rm(path.join(artifact, ...file.path.split('/')))
    }
    const privateAddress = ['10', '20', '30', '40'].join('.')
    const differentSensitiveLiteral = [windowsSeparator.repeat(2) + privateAddress, 'share'].join(windowsSeparator)
    const differentBridgeProtocol = {
      path: 'integrations/dyson-control-bridge/BridgeProtocol.cs',
      bytes: Buffer.from(`namespace Fictional { const string Endpoint = "${differentSensitiveLiteral}"; }\n`)
    }
    await writeFile(
      path.join(artifact, ...differentBridgeProtocol.path.split('/')),
      differentBridgeProtocol.bytes
    )
    const differentLiteralFiles = protocolFiles.map((file) => (
      file.path === differentBridgeProtocol.path ? differentBridgeProtocol : file
    ))
    await writeFile(
      path.join(artifact, 'artifact-manifest.json'),
      JSON.stringify(buildArtifactManifestForFixture(differentLiteralFiles))
    )

    const differentLiteralRejected = await runPublicReleaseScan({ repositoryRoot: repository, artifactPath: artifact })
    assert.deepEqual(
      differentLiteralRejected.findings.filter((entry) => entry.ruleId === 'PRIVATE_IP_ADDRESS').map((entry) => entry.path),
      ['integrations/dyson-control-bridge/BridgeProtocol.cs']
    )
    assert.equal(
      differentLiteralRejected.findings.some((entry) => entry.ruleId === 'UNC_PATH'
        && entry.path === 'integrations/dyson-control-bridge/BridgeProtocol.cs'),
      false
    )
    assert.equal(differentLiteralRejected.passed, false)
  })

  it('suppresses only generic vendored examples while retaining high-signal artifact blocks', async () => {
    const repository = await newRepository()
    await write(repository, 'README.md', 'Fictional repository\n')
    await commitAll(repository, 'fixture')
    const artifact = await mkdtemp(path.join(tmpdir(), 'dyson-public-release-vendor-artifact-'))
    temporaryRoots.push(artifact)
    const entryPoint = Buffer.from('export const fixture = true\n', 'utf8')
    const vendorDocumentationHost = ['docs', 'vendor-project', 'net'].join('.')
    const vendorPrivateAddress = ['10', '20', '30', '40'].join('.')
    const windowsSeparator = String.fromCharCode(92)
    const vendorUncExample = [windowsSeparator + windowsSeparator + 'vendor-host', 'share'].join(windowsSeparator)
    const vendorUserPath = ['C:', 'Users', 'VendorAuthor', 'fixture'].join(windowsSeparator)
    const vendorNoise = Buffer.from([
      `export const documentation = "https://${vendorDocumentationHost}/guide"`,
      `export const privateAddressExample = "${vendorPrivateAddress}"`,
      `export const uncParserExample = "${vendorUncExample}"`,
      `export const userPathExample = "${vendorUserPath}"`,
      'export const password = "short-documentation-example"'
    ].join('\n'), 'utf8')
    const safeFiles = [
      { path: 'apps/api/dist/index.js', bytes: entryPoint },
      { path: 'apps/api/node_modules/fictional-vendor/runtime.js', bytes: vendorNoise }
    ]
    for (const file of safeFiles) {
      await mkdir(path.dirname(path.join(artifact, ...file.path.split('/'))), { recursive: true })
      await writeFile(path.join(artifact, ...file.path.split('/')), file.bytes)
    }
    await writeFile(path.join(artifact, 'artifact-manifest.json'), JSON.stringify(buildArtifactManifestForFixture(safeFiles)))

    const genericExamples = await runPublicReleaseScan({ repositoryRoot: repository, artifactPath: artifact })
    assert.equal(genericExamples.passed, true)

    const highEntropy = 'A7vQ9xLm2Pz8Nr4Ks6Wd1Yc5Ht3Bg0Fj'
    const vendorProductionHost = ['control', 'vendor-production', 'net'].join('.')
    const vendorDatabaseHost = ['database', 'vendor-production', 'net'].join('.')
    const steamIdentifier = ['7656119', '0000000000'].join('')
    const unsafeRuntime = Buffer.from([
      `export const apiKey = "${highEntropy}"`,
      `export const publicUrl = "https://${vendorProductionHost}/api"`,
      `export const database = "postgres${'ql'}://operator:password@${vendorDatabaseHost}/control"`,
      privateKeyHeader(),
      `export const steamAccount = "${steamIdentifier}"`
    ].join('\n'), 'utf8')
    const nativeCredential = Buffer.concat([Buffer.from([0, 1, 2]), Buffer.from(knownToken(), 'ascii')])
    const playerRecord = Buffer.from(JSON.stringify({
      players: [{ sessionPlayerId: 'player-000001', displayName: 'Unreviewed Name', online: true }]
    }), 'utf8')
    const forbiddenEnvironment = Buffer.from('FICTIONAL=value\n', 'utf8')
    const unsafeFiles = [
      ...safeFiles,
      { path: 'apps/api/node_modules/fictional-vendor/unsafe-runtime.js', bytes: unsafeRuntime },
      { path: 'apps/api/node_modules/fictional-vendor/native.node', bytes: nativeCredential },
      { path: 'apps/api/node_modules/fictional-vendor/players.json', bytes: playerRecord },
      { path: 'apps/api/node_modules/fictional-vendor/.env', bytes: forbiddenEnvironment }
    ]
    for (const file of unsafeFiles.slice(safeFiles.length)) {
      await writeFile(path.join(artifact, ...file.path.split('/')), file.bytes)
    }
    await writeFile(path.join(artifact, 'artifact-manifest.json'), JSON.stringify(buildArtifactManifestForFixture(unsafeFiles)))

    const unsafe = await runPublicReleaseScan({ repositoryRoot: repository, artifactPath: artifact })
    assertRules(unsafe, [
      'DATABASE_CONNECTION_STRING', 'FORBIDDEN_ENV_FILE', 'HIGH_ENTROPY_SECRET_ASSIGNMENT',
      'KNOWN_CREDENTIAL_PATTERN', 'PLAYER_DATA_RECORD', 'PRIVATE_KEY_MATERIAL',
      'PRODUCTION_ENDPOINT', 'SECRET_LITERAL_ASSIGNMENT', 'STEAM_IDENTIFIER'
    ])
    assert.equal(canonicalEvidenceJson(unsafe).includes(highEntropy), false)
    assert.equal(canonicalEvidenceJson(unsafe).includes(knownToken()), false)
  })

  it('bounds artifact traversal before reading an oversized candidate set', async () => {
    const repository = await newRepository()
    await write(repository, 'README.md', 'Fictional repository\n')
    await commitAll(repository, 'fixture')
    const artifact = await mkdtemp(path.join(tmpdir(), 'dyson-public-release-artifact-limit-'))
    temporaryRoots.push(artifact)
    await mkdir(path.join(artifact, 'apps', 'api', 'dist'), { recursive: true })
    await writeFile(path.join(artifact, 'apps', 'api', 'dist', 'index.js'), 'export {}\n')
    await writeFile(path.join(artifact, 'artifact-manifest.json'), '{}')

    const evidence = await runPublicReleaseScan({
      repositoryRoot: repository,
      artifactPath: artifact,
      limits: { maximumArtifactFiles: 1 }
    })
    assertRules(evidence, ['ARTIFACT_FILE_LIMIT_EXCEEDED'])
    assert.equal(evidence.scopes.artifact.completed, false)
    assert.equal(evidence.scopes.artifact.scannedFiles, 0)
  })

  it('excludes ignored candidates but scans untracked nonignored files', async () => {
    const repository = await newRepository()
    await write(repository, '.gitignore', 'ignored-secret.txt\n')
    await write(repository, 'ignored-secret.txt', knownToken())
    await write(repository, 'safe.txt', 'Fictional fixture\n')
    await commitAll(repository, 'fixture')
    const clean = await runPublicReleaseScan({ repositoryRoot: repository })
    assert.equal(clean.passed, true)

    await write(repository, 'untracked.txt', knownToken())
    const dirty = await runPublicReleaseScan({ repositoryRoot: repository })
    assertRules(dirty, ['KNOWN_CREDENTIAL_PATTERN', 'REPOSITORY_DIRTY'])
    assert.equal(dirty.repository.dirty, true)
  })
})

async function newRepository() {
  const root = await mkdtemp(path.join(tmpdir(), 'dyson-public-release-fixture-'))
  temporaryRoots.push(root)
  await git(root, ['init', '--quiet'])
  await git(root, ['config', 'user.name', 'Fictional Release Test'])
  await git(root, ['config', 'user.email', 'release-test@example.com'])
  return root
}

async function commitAll(repository, message) {
  await git(repository, ['add', '--all'])
  await git(repository, ['commit', '--quiet', '-m', message])
}

async function git(repository, args) {
  await execFileAsync('git', ['-c', `safe.directory=${repository}`, ...args], {
    cwd: repository,
    windowsHide: true
  })
}

async function write(repository, relative, value) {
  const absolute = path.join(repository, ...relative.split('/'))
  await mkdir(path.dirname(absolute), { recursive: true })
  await writeFile(absolute, value)
}

function knownToken() {
  return ['github', '_pat_', 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6'].join('')
}

function privateKeyHeader() {
  return ['-----BEGIN', 'PRIVATE KEY-----'].join(' ')
}

function pngWithMetadata() {
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
  const ihdr = pngChunk('IHDR', Buffer.alloc(13))
  const metadata = pngChunk('caBX', Buffer.from('fictional metadata'))
  const end = pngChunk('IEND', Buffer.alloc(0))
  return Buffer.concat([signature, ihdr, metadata, end])
}

function pngChunk(type, data) {
  const header = Buffer.alloc(8)
  header.writeUInt32BE(data.length, 0)
  header.write(type, 4, 4, 'ascii')
  return Buffer.concat([header, data, Buffer.alloc(4)])
}

function assertRules(evidence, expected) {
  const actual = new Set(evidence.findings.map((entry) => entry.ruleId))
  for (const rule of expected) assert.equal(actual.has(rule), true, `missing rule ${rule}`)
  assert.equal(evidence.passed, false)
}
