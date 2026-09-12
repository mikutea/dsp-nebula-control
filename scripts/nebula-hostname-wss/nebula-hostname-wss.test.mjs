import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import {
  applySingleFileUnifiedPatch,
  applyUnifiedPatchSet,
  evaluatePatchedJoinInput,
  inspectUnifiedPatch,
  inspectUnifiedPatchSet,
  NebulaHostnameWssError,
  readRepositoryContract,
  validateContract,
  verifyExactGitWorktree,
  verifyRepositoryContract,
  verifySourceCandidate,
  verifySourceCheckout
} from './lib.mjs'

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')

test('the repository contract and GPL source patch are byte-pinned and exactly two-source', async () => {
  const loaded = await readRepositoryContract(repositoryRoot)
  const verified = await verifyRepositoryContract(repositoryRoot, loaded)
  assert.equal(verified.contract.upstream.commit, '3cdf95c594a2f8010b0e87a43be828e6ba2f657f')
  assert.deepEqual(verified.contract.sources.map((source) => source.path), [
    'NebulaNetwork/Client.cs',
    'NebulaPatcher/Patches/Dynamic/UIMainMenu_Patch.cs'
  ])
  assert.equal(verified.inspection.hunks, 7)
  assert.equal(verified.inspection.addedLines, 16)
  assert.equal(verified.inspection.removedLines, 4)
  assert.deepEqual(verified.inspection.files, [
    { path: 'NebulaNetwork/Client.cs', hunks: 5, addedLines: 9, removedLines: 4 },
    { path: 'NebulaPatcher/Patches/Dynamic/UIMainMenu_Patch.cs', hunks: 2, addedLines: 7, removedLines: 0 }
  ])
  assert.match(verified.inspection.text, /var protocolExplicit = false;/)
  assert.match(verified.inspection.text, /if \(!isIP && !protocolExplicit && protocol == "ws" && p == 443\)/)
  assert.doesNotMatch(verified.inspection.text, /protocol == "ws" && port == 443 \? "wss" : protocol/)
  assert.match(verified.inspection.text, /\$"\{serverProtocol\}:\/\/\{serverAuthority\}\/socket"/)
  assert.match(verified.inspection.text, /new Client\(serverHostname, ServerEndpoint\.Port, serverProtocol, password\)/)
  assert.doesNotMatch(verified.inspection.text, /^\+.*new Client\(ServerEndpoint, password\)/m)
})

test('the hard-coded trust anchor rejects a rewritten contract', async () => {
  const loaded = await readRepositoryContract(repositoryRoot)
  for (const mutate of [
    (contract) => { contract.upstream.commit = '0'.repeat(40) },
    (contract) => { contract.sources[0].sha256 = '0'.repeat(64) },
    (contract) => { contract.sources[1].gitBlob = '0'.repeat(40) },
    (contract) => { contract.patch.sha256 = '0'.repeat(64) },
    (contract) => { contract.candidate.patchedSources[1].sha256 = '0'.repeat(64) }
  ]) {
    const changed = structuredClone(loaded.contract)
    mutate(changed)
    assert.throws(() => validateContract(changed), hasCode('PATCH_CONTRACT_INVALID'))
  }
})

test('the unified patch engine applies and reverses an exact source relation', () => {
  const original = Buffer.from('alpha\nbeta\ngamma\n')
  const patch = Buffer.from([
    'diff --git a/NebulaNetwork/Client.cs b/NebulaNetwork/Client.cs',
    '--- a/NebulaNetwork/Client.cs',
    '+++ b/NebulaNetwork/Client.cs',
    '@@ -1,3 +1,4 @@',
    ' alpha',
    '-beta',
    '+beta-two',
    '+extra',
    ' gamma',
    ''
  ].join('\n'))
  const patched = applySingleFileUnifiedPatch(original, patch, 'NebulaNetwork/Client.cs')
  assert.equal(patched.toString(), 'alpha\nbeta-two\nextra\ngamma\n')
  assert.deepEqual(
    applySingleFileUnifiedPatch(patched, patch, 'NebulaNetwork/Client.cs', { reverse: true }),
    original
  )
  assert.deepEqual(inspectUnifiedPatch(patch, 'NebulaNetwork/Client.cs'), {
    oldPath: 'NebulaNetwork/Client.cs',
    newPath: 'NebulaNetwork/Client.cs',
    hunks: 1,
    addedLines: 2,
    removedLines: 1,
    text: patch.toString()
  })
})

test('the exact multi-file patch engine applies, reverses, inventories, and rejects file-set drift', () => {
  const paths = ['NebulaNetwork/Client.cs', 'NebulaPatcher/Patches/Dynamic/UIMainMenu_Patch.cs']
  const patch = Buffer.from([
    'diff --git a/NebulaNetwork/Client.cs b/NebulaNetwork/Client.cs',
    '--- a/NebulaNetwork/Client.cs',
    '+++ b/NebulaNetwork/Client.cs',
    '@@ -1,1 +1,1 @@',
    '-client-before',
    '+client-after',
    'diff --git a/NebulaPatcher/Patches/Dynamic/UIMainMenu_Patch.cs b/NebulaPatcher/Patches/Dynamic/UIMainMenu_Patch.cs',
    '--- a/NebulaPatcher/Patches/Dynamic/UIMainMenu_Patch.cs',
    '+++ b/NebulaPatcher/Patches/Dynamic/UIMainMenu_Patch.cs',
    '@@ -1,1 +1,2 @@',
    ' parser-before',
    '+parser-after',
    ''
  ].join('\n'))
  const originals = new Map([
    [paths[0], Buffer.from('client-before\n')],
    [paths[1], Buffer.from('parser-before\n')]
  ])
  const changed = applyUnifiedPatchSet(originals, patch, paths)
  assert.equal(changed.get(paths[0]).toString(), 'client-after\n')
  assert.equal(changed.get(paths[1]).toString(), 'parser-before\nparser-after\n')
  const restored = applyUnifiedPatchSet(changed, patch, paths, { reverse: true })
  assert.deepEqual(restored, originals)
  assert.deepEqual(inspectUnifiedPatchSet(patch, paths).files, [
    { path: paths[0], hunks: 1, addedLines: 1, removedLines: 1 },
    { path: paths[1], hunks: 1, addedLines: 1, removedLines: 0 }
  ])
  assert.throws(
    () => applyUnifiedPatchSet(new Map([[paths[0], originals.get(paths[0])]]), patch, paths),
    hasCode('PATCH_SOURCE_SET_INVALID')
  )
  assert.throws(() => inspectUnifiedPatchSet(patch, [...paths].reverse()), hasCode('PATCH_SCOPE_INVALID'))
})

test('the patch engine rejects source drift, a second file, malformed counts, and traversal', () => {
  const valid = [
    'diff --git a/NebulaNetwork/Client.cs b/NebulaNetwork/Client.cs',
    '--- a/NebulaNetwork/Client.cs',
    '+++ b/NebulaNetwork/Client.cs',
    '@@ -1,1 +1,1 @@',
    '-before',
    '+after',
    ''
  ].join('\n')
  assert.throws(
    () => applySingleFileUnifiedPatch(Buffer.from('drift\n'), Buffer.from(valid), 'NebulaNetwork/Client.cs'),
    hasCode('PATCH_SOURCE_DRIFT')
  )
  assert.throws(
    () => inspectUnifiedPatch(Buffer.from(`${valid}diff --git a/Other.cs b/Other.cs\n--- a/Other.cs\n+++ b/Other.cs\n`), 'NebulaNetwork/Client.cs'),
    isNebulaError
  )
  assert.throws(
    () => inspectUnifiedPatch(Buffer.from(valid.replace('@@ -1,1 +1,1 @@', '@@ -1,2 +1,1 @@')), 'NebulaNetwork/Client.cs'),
    hasCode('PATCH_HUNK_INVALID')
  )
  const traversal = Buffer.from(valid.replaceAll('NebulaNetwork/Client.cs', '../Client.cs'))
  assert.throws(() => inspectUnifiedPatch(traversal, '../Client.cs'), hasCode('PATH_ESCAPE_REJECTED'))
})

test('the executable join matrix preserves explicit protocols and stock IP behavior', () => {
  const documentationIpv6 = ['2001', 'db8', '', '43'].join(':')
  const cases = [
    {
      input: 'game.example.com:443',
      expected: {
        protocol: 'wss', protocolExplicit: false, port: 443, isIP: false, ipVersion: 0,
        constructorPath: 'hostname', serverAuthority: 'game.example.com:443',
        webSocketUri: 'wss://game.example.com:443/socket', rememberLastIP: 'wss://game.example.com:443'
      }
    },
    {
      input: 'ws://game.example.com:443',
      expected: {
        protocol: 'ws', protocolExplicit: true, port: 443, isIP: false, ipVersion: 0,
        constructorPath: 'hostname', serverAuthority: 'game.example.com:443',
        webSocketUri: 'ws://game.example.com:443/socket', rememberLastIP: 'ws://game.example.com:443'
      }
    },
    {
      input: 'wss://game.example.com:443',
      expected: {
        protocol: 'wss', protocolExplicit: true, port: 443, isIP: false, ipVersion: 0,
        constructorPath: 'hostname', serverAuthority: 'game.example.com:443',
        webSocketUri: 'wss://game.example.com:443/socket', rememberLastIP: 'wss://game.example.com:443'
      }
    },
    {
      input: 'game.example.com:8469',
      expected: {
        protocol: 'ws', protocolExplicit: false, port: 8469, isIP: false, ipVersion: 0,
        constructorPath: 'hostname', serverAuthority: 'game.example.com:8469',
        webSocketUri: 'ws://game.example.com:8469/socket', rememberLastIP: 'game.example.com:8469'
      }
    },
    {
      input: '203.0.113.43:443',
      expected: {
        protocol: 'ws', protocolExplicit: false, port: 443, isIP: true, ipVersion: 4,
        constructorPath: 'endpoint', serverAuthority: '203.0.113.43:443',
        webSocketUri: 'ws://203.0.113.43:443/socket', rememberLastIP: '203.0.113.43:443'
      }
    },
    {
      input: 'wss://203.0.113.43:443',
      expected: {
        protocol: 'wss', protocolExplicit: true, port: 443, isIP: true, ipVersion: 4,
        constructorPath: 'endpoint', serverAuthority: '203.0.113.43:443',
        webSocketUri: 'wss://203.0.113.43:443/socket', rememberLastIP: 'wss://203.0.113.43:443'
      }
    },
    {
      input: `[${documentationIpv6}]:443`,
      expected: {
        protocol: 'ws', protocolExplicit: false, port: 443, isIP: true, ipVersion: 6,
        constructorPath: 'endpoint', serverAuthority: `[${documentationIpv6}]:443`,
        webSocketUri: `ws://[${documentationIpv6}]:443/socket`, rememberLastIP: `[${documentationIpv6}]:443`
      }
    },
    {
      input: `wss://[${documentationIpv6}]:443`,
      expected: {
        protocol: 'wss', protocolExplicit: true, port: 443, isIP: true, ipVersion: 6,
        constructorPath: 'endpoint', serverAuthority: `[${documentationIpv6}]:443`,
        webSocketUri: `wss://[${documentationIpv6}]:443/socket`, rememberLastIP: `wss://[${documentationIpv6}]:443`
      }
    }
  ]
  for (const fixture of cases) {
    const actual = evaluatePatchedJoinInput(fixture.input)
    for (const [key, expected] of Object.entries(fixture.expected)) assert.equal(actual[key], expected, `${fixture.input}: ${key}`)
  }
  assert.equal(evaluatePatchedJoinInput('game.example.com', { defaultPort: 443 }).protocol, 'wss')
})

test('RememberLastIP round-trips explicit WS-on-443 through reconnect parsing and authentication retry', () => {
  const hostname = evaluatePatchedJoinInput('game.example.com:443', { password: 'fixture-passphrase' })
  assert.deepEqual(hostname.retry, {
    constructorPath: 'hostname',
    hostname: 'game.example.com',
    port: 443,
    protocol: 'wss',
    password: 'fixture-passphrase'
  })
  assert.equal(hostname.rememberLastIP, 'wss://game.example.com:443')

  const explicitWs = evaluatePatchedJoinInput('ws://game.example.com:443', { password: 'fixture-passphrase' })
  const explicitWsReplay = evaluatePatchedJoinInput(explicitWs.rememberLastIP, { password: 'fixture-passphrase' })
  assert.equal(explicitWs.protocolExplicit, true)
  assert.equal(explicitWs.protocol, 'ws')
  assert.equal(explicitWs.constructorPath, 'hostname')
  assert.equal(explicitWs.webSocketUri, 'ws://game.example.com:443/socket')
  assert.equal(explicitWs.rememberLastIP, 'ws://game.example.com:443')
  assert.equal(explicitWsReplay.protocolExplicit, true)
  assert.equal(explicitWsReplay.protocol, 'ws')
  assert.equal(explicitWsReplay.constructorPath, 'hostname')
  assert.equal(explicitWsReplay.serverAuthority, 'game.example.com:443')
  assert.deepEqual(explicitWsReplay.retry, {
    constructorPath: 'hostname',
    hostname: 'game.example.com',
    port: 443,
    protocol: 'ws',
    password: 'fixture-passphrase'
  })
  assert.equal(explicitWsReplay.webSocketUri, 'ws://game.example.com:443/socket')
  assert.equal(explicitWsReplay.rememberLastIP, explicitWs.rememberLastIP)

  const stockNon443 = evaluatePatchedJoinInput('ws://game.example.com:8469')
  const stockNon443Replay = evaluatePatchedJoinInput(stockNon443.rememberLastIP)
  assert.equal(stockNon443.rememberLastIP, 'game.example.com:8469')
  assert.equal(stockNon443Replay.rememberLastIP, 'game.example.com:8469')
  assert.equal(stockNon443Replay.protocol, 'ws')
  assert.equal(stockNon443Replay.webSocketUri, 'ws://game.example.com:8469/socket')

  const documentationIpv6 = ['2001', 'db8', '', '43'].join(':')
  const ipv6 = evaluatePatchedJoinInput(`ws://[${documentationIpv6}]:443`, { password: 'fixture-passphrase' })
  assert.deepEqual(ipv6.retry, {
    constructorPath: 'endpoint',
    protocol: 'ws',
    password: 'fixture-passphrase'
  })
  assert.equal(ipv6.rememberLastIP, `[${documentationIpv6}]:443`)
})

test('candidate verification rejects proprietary binaries before accepting a file set', async (t) => {
  const temporary = await mkdtemp(path.join(tmpdir(), 'nebula-wss-candidate-guard-'))
  t.after(async () => rm(temporary, { recursive: true, force: true }))
  const loaded = await readRepositoryContract(repositoryRoot)
  const verified = await verifyRepositoryContract(repositoryRoot, loaded)
  await writeFile(path.join(temporary, 'Assembly-CSharp.dll'), Buffer.from('MZfixture'))
  await assert.rejects(
    verifySourceCandidate(temporary, {
      contract: verified.contract,
      contractRaw: verified.raw,
      patch: verified.patch
    }),
    hasCode('CANDIDATE_PROPRIETARY_OR_BINARY_FILE')
  )
})

test('candidate verification rejects missing and extra source-package files', async (t) => {
  const temporary = await mkdtemp(path.join(tmpdir(), 'nebula-wss-candidate-set-'))
  t.after(async () => rm(temporary, { recursive: true, force: true }))
  const loaded = await readRepositoryContract(repositoryRoot)
  const verified = await verifyRepositoryContract(repositoryRoot, loaded)
  await writeFile(path.join(temporary, 'LICENSE'), Buffer.from('fixture'))
  await assert.rejects(
    verifySourceCandidate(temporary, {
      contract: verified.contract,
      contractRaw: verified.raw,
      patch: verified.patch
    }),
    hasCode('CANDIDATE_FILE_SET_INVALID')
  )
  await writeFile(path.join(temporary, 'unexpected.txt'), Buffer.from('fixture'))
  await assert.rejects(
    verifySourceCandidate(temporary, {
      contract: verified.contract,
      contractRaw: verified.raw,
      patch: verified.patch
    }),
    hasCode('CANDIDATE_FILE_SET_INVALID')
  )
})

test('upstream verification fails closed on any checkout that is not the pinned commit', async (t) => {
  const sourceRoot = await mkdtemp(path.join(tmpdir(), 'nebula-wss-wrong-upstream-'))
  t.after(async () => rm(sourceRoot, { recursive: true, force: true }))
  await mkdir(path.join(sourceRoot, 'NebulaNetwork'))
  await writeFile(path.join(sourceRoot, 'NebulaNetwork', 'Client.cs'), 'fixture\n')
  await writeFile(path.join(sourceRoot, 'LICENSE'), 'GPL fixture\n')
  await writeFile(path.join(sourceRoot, '.gitignore'), 'ignored/\n')
  git(sourceRoot, ['init'])
  git(sourceRoot, ['config', 'user.email', 'fixture@example.com'])
  git(sourceRoot, ['config', 'user.name', 'Fixture Builder'])
  git(sourceRoot, ['add', '.gitignore', 'LICENSE', 'NebulaNetwork/Client.cs'])
  git(sourceRoot, ['commit', '-m', 'fixture'])
  git(sourceRoot, ['tag', 'v0.9.22'])
  git(sourceRoot, ['remote', 'add', 'origin', 'https://github.com/NebulaModTeam/nebula.git'])
  assert.equal(await verifyExactGitWorktree(sourceRoot), true)
  await mkdir(path.join(sourceRoot, 'ignored'))
  await writeFile(path.join(sourceRoot, 'ignored', 'private.dll'), 'fixture\n')
  await assert.rejects(verifyExactGitWorktree(sourceRoot), hasCode('UPSTREAM_WORKTREE_NOT_EXACT'))
  await rm(path.join(sourceRoot, 'ignored'), { recursive: true, force: true })
  await writeFile(path.join(sourceRoot, 'extra.txt'), 'fixture\n')
  await assert.rejects(verifyExactGitWorktree(sourceRoot), hasCode('UPSTREAM_WORKTREE_NOT_EXACT'))
  await rm(path.join(sourceRoot, 'extra.txt'), { force: true })
  await rm(path.join(sourceRoot, 'LICENSE'), { force: true })
  await assert.rejects(verifyExactGitWorktree(sourceRoot), hasCode('UPSTREAM_WORKTREE_NOT_EXACT'))
  git(sourceRoot, ['checkout', '--', 'LICENSE'])
  assert.equal(await verifyExactGitWorktree(sourceRoot), true)
  const loaded = await readRepositoryContract(repositoryRoot)
  await assert.rejects(verifySourceCheckout(sourceRoot, loaded.contract), hasCode('UPSTREAM_COMMIT_INVALID'))
})

test('the public patch contains no binary payload or private game assembly', async () => {
  const patch = await readFile(path.join(
    repositoryRoot,
    'integrations',
    'nebula-hostname-wss',
    'patches',
    'nebula-v0.9.22-hostname-wss.patch'
  ))
  assert.notEqual(patch[0], 0x4d)
  assert.doesNotMatch(patch.toString(), /(?:Assembly-CSharp|UnityEngine|steam_api|\.dll\b|\.exe\b)/i)
})

function git(root, args) {
  execFileSync('git', ['-C', root, ...args], { windowsHide: true, stdio: 'ignore' })
}

function hasCode(code) {
  return (error) => error instanceof NebulaHostnameWssError && error.code === code
}

function isNebulaError(error) {
  return error instanceof NebulaHostnameWssError
}
