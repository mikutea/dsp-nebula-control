import { spawnSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { isIP as isIpLiteral } from 'node:net'
import {
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  rm
} from 'node:fs/promises'
import path from 'node:path'

const CONTRACT_RELATIVE_PATH = 'integrations/nebula-hostname-wss/contract.json'
const CANDIDATE_CONTRACT_NAME = 'nebula-v0.9.22-hostname-wss.contract.json'
const CANDIDATE_PATCH_NAME = 'nebula-v0.9.22-hostname-wss.patch'
const CANDIDATE_MANIFEST_NAME = 'candidate-manifest.json'
const MAX_CONTRACT_BYTES = 64 * 1024
const MAX_PATCH_BYTES = 256 * 1024
const MAX_CANDIDATE_FILE_BYTES = 2 * 1024 * 1024
const PROPRIETARY_OR_BINARY_NAME = /(?:^|\/)(?:assembly-csharp|unityengine|steam_api|gameassembly)(?:[._-]|$)|\.(?:dll|exe|pdb|so|dylib|bundle|lib|dsv|server)$/i
const SOURCE_PATHS = Object.freeze([
  'NebulaNetwork/Client.cs',
  'NebulaPatcher/Patches/Dynamic/UIMainMenu_Patch.cs'
])
const ALLOWED_CANDIDATE_DIRECTORIES = new Set([
  'NebulaNetwork',
  'NebulaPatcher',
  'NebulaPatcher/Patches',
  'NebulaPatcher/Patches/Dynamic'
])
const PINNED = Object.freeze({
  commit: '3cdf95c594a2f8010b0e87a43be828e6ba2f657f',
  licenseGitBlob: 'f288702d2fa16d3cdf0035b15a9fcbc552cd88e7',
  licenseSha256: '3972dc9744f6499f0f9b2dbf76696f2ae7ad8af9b23dde66d6af86c9dfb36986',
  licenseSizeBytes: 35149,
  sources: Object.freeze({
    'NebulaNetwork/Client.cs': Object.freeze({
      gitBlob: '84763fc54a4d01df1dc257efa24ecb6757557587',
      sha256: 'a93a5f17738ef95c4c26db055d4a88da5341c1ad4fda1c5fde6edac011192082',
      sizeBytes: 14871,
      patchedSha256: '79984f61943dd0f908a47b1b0d97d02f4f27526d4fcd8203444157991ff68bd0',
      patchedSizeBytes: 15286
    }),
    'NebulaPatcher/Patches/Dynamic/UIMainMenu_Patch.cs': Object.freeze({
      gitBlob: '90cd938877af1976784baa3426a7127b64d4d7f4',
      sha256: '71360c4b2982cb23f3cb6a8e7be5f4e784acfa24738fc1512372cb8bd42f71cb',
      sizeBytes: 17132,
      patchedSha256: '61665fcce7edf86d5774cd5a723564570385c88cba69b51b37d8084e20f3326e',
      patchedSizeBytes: 17338
    })
  }),
  patchSha256: 'f99aa853122fd83be714f6ee2a7c065dcf298661a1331a639648130fd2ea778b',
  patchSizeBytes: 4068
})

export class NebulaHostnameWssError extends Error {
  constructor(code, options) {
    super(code, options)
    this.name = 'NebulaHostnameWssError'
    this.code = code
  }
}

export async function readRepositoryContract(repositoryRoot) {
  const root = requireAbsolutePath(repositoryRoot, 'REPOSITORY_ROOT_INVALID')
  const contractPath = path.join(root, ...CONTRACT_RELATIVE_PATH.split('/'))
  const raw = await readBoundedFile(contractPath, MAX_CONTRACT_BYTES, 'PATCH_CONTRACT_INVALID')
  const contract = parseJson(raw, 'PATCH_CONTRACT_INVALID')
  validateContract(contract)
  return { contract, raw, contractPath }
}

export async function verifyRepositoryContract(repositoryRoot, loaded) {
  const root = requireAbsolutePath(repositoryRoot, 'REPOSITORY_ROOT_INVALID')
  const bundle = loaded ?? await readRepositoryContract(root)
  validateContract(bundle.contract)
  const patchPath = managedRepositoryPath(root, bundle.contract.patch.path)
  const patch = await readBoundedFile(patchPath, MAX_PATCH_BYTES, 'PATCH_FILE_INVALID')
  assertMeasured(patch, bundle.contract.patch, 'PATCH_FILE_DRIFT')
  const inspection = inspectUnifiedPatchSet(patch, SOURCE_PATHS)
  const expectedMetrics = new Map([
    ['NebulaNetwork/Client.cs', { hunks: 5, addedLines: 9, removedLines: 4 }],
    ['NebulaPatcher/Patches/Dynamic/UIMainMenu_Patch.cs', { hunks: 2, addedLines: 7, removedLines: 0 }]
  ])
  if (inspection.addedLines !== 16 || inspection.removedLines !== 4 || inspection.hunks !== 7 ||
      inspection.files.some((file) => {
        const expected = expectedMetrics.get(file.path)
        return expected === undefined || expected.hunks !== file.hunks ||
          expected.addedLines !== file.addedLines || expected.removedLines !== file.removedLines
      })) {
    fail('PATCH_SCOPE_INVALID')
  }
  assertProductionPatchSemantics(inspection)
  return { ...bundle, patch, patchPath, inspection }
}

export async function verifySourceCheckout(sourceRoot, contract) {
  validateContract(contract)
  const root = requireAbsolutePath(sourceRoot, 'UPSTREAM_ROOT_INVALID')
  await assertPlainDirectory(root, 'UPSTREAM_ROOT_INVALID')
  const rootReal = await realpath(root)

  const topLevel = runGitText(root, ['rev-parse', '--show-toplevel'], 'UPSTREAM_GIT_INVALID')
  if (!samePath(await realpath(topLevel), rootReal)) fail('UPSTREAM_ROOT_INVALID')
  const remote = runGitText(root, ['remote', 'get-url', 'origin'], 'UPSTREAM_REMOTE_INVALID')
  if (remote !== contract.upstream.repository) fail('UPSTREAM_REMOTE_INVALID')
  const head = runGitText(root, ['rev-parse', '--verify', 'HEAD^{commit}'], 'UPSTREAM_COMMIT_INVALID')
  if (head !== contract.upstream.commit) fail('UPSTREAM_COMMIT_INVALID')
  const tagCommit = runGitText(
    root,
    ['rev-parse', '--verify', `refs/tags/${contract.upstream.tag}^{commit}`],
    'UPSTREAM_TAG_INVALID'
  )
  if (tagCommit !== contract.upstream.commit) fail('UPSTREAM_TAG_INVALID')
  await verifyExactGitWorktree(root)

  const sources = new Map()
  for (const descriptor of contract.sources) {
    sources.set(descriptor.path, await readTrackedBlob(
      root,
      contract.upstream.commit,
      descriptor,
      'UPSTREAM_SOURCE'
    ))
  }
  const licenseDescriptor = {
    path: contract.upstream.licensePath,
    gitBlob: contract.upstream.licenseGitBlob,
    sha256: contract.upstream.licenseSha256,
    sizeBytes: contract.upstream.licenseSizeBytes
  }
  const license = await readTrackedBlob(root, contract.upstream.commit, licenseDescriptor, 'UPSTREAM_LICENSE')
  return { root: rootReal, sources, license }
}

export async function verifyExactGitWorktree(sourceRoot) {
  const root = requireAbsolutePath(sourceRoot, 'UPSTREAM_ROOT_INVALID')
  await assertPlainDirectory(root, 'UPSTREAM_ROOT_INVALID')
  const sparse = runGitOptionalText(root, ['config', '--bool', 'core.sparseCheckout'])
  if (sparse === 'true') fail('UPSTREAM_SPARSE_CHECKOUT_REJECTED')
  const status = runGitText(
    root,
    ['status', '--porcelain=v1', '--untracked-files=all', '--ignore-submodules=none'],
    'UPSTREAM_STATUS_INVALID',
    true
  )
  if (status !== '') fail('UPSTREAM_WORKTREE_NOT_EXACT')
  const ignored = runGitText(
    root,
    ['ls-files', '--others', '--ignored', '--exclude-standard'],
    'UPSTREAM_STATUS_INVALID',
    true
  )
  if (ignored !== '') fail('UPSTREAM_WORKTREE_NOT_EXACT')
  return true
}

export function evaluatePatchedJoinInput(input, options = {}) {
  if (typeof input !== 'string' || input.length === 0 || /[\0\r\n]/.test(input)) {
    fail('JOIN_INPUT_INVALID')
  }
  const defaultPort = options.defaultPort ?? 8469
  const password = options.password ?? ''
  if (!Number.isInteger(defaultPort) || defaultPort < 1 || defaultPort > 65535 || typeof password !== 'string') {
    fail('JOIN_INPUT_INVALID')
  }

  let connectionString = input
  let protocol = 'ws'
  let protocolExplicit = false
  const separator = connectionString.indexOf('://')
  if (separator > 0) {
    const candidate = connectionString.slice(0, separator)
    if (candidate === 'ws' || candidate === 'wss') {
      protocol = candidate
      protocolExplicit = true
      connectionString = connectionString.slice(separator + 3)
    }
  }

  const endpoint = parseIpEndpoint(connectionString)
  let isIP = endpoint !== null
  let ipVersion = endpoint?.version ?? 0
  let port = endpoint?.port ?? 0
  if (isIP) {
    connectionString = ipVersion === 6 ? `[${endpoint.address}]` : endpoint.address
  } else {
    const parts = connectionString.split(':')
    if (parts.length === 2 && /^\d+$/.test(parts[1])) {
      port = Number(parts[1])
      connectionString = parts[0]
    }
  }
  if (!Number.isInteger(port) || port < 0 || port > 65535) fail('JOIN_INPUT_INVALID')
  port = port === 0 ? defaultPort : port

  if (!isIP && !protocolExplicit && protocol === 'ws' && port === 443) protocol = 'wss'

  const serverAuthority = `${connectionString}:${port}`
  const rememberLastIP = protocol === 'ws' && (isIP || port !== 443)
    ? serverAuthority
    : `${protocol}://${serverAuthority}`
  return {
    input,
    connectionString,
    protocol,
    protocolExplicit,
    port,
    isIP,
    ipVersion,
    constructorPath: isIP ? 'endpoint' : 'hostname',
    serverAuthority,
    webSocketUri: `${protocol}://${serverAuthority}/socket`,
    rememberLastIP,
    retry: isIP
      ? { constructorPath: 'endpoint', protocol, password }
      : { constructorPath: 'hostname', hostname: connectionString, port, protocol, password }
  }
}

export function applySingleFileUnifiedPatch(original, patchBytes, expectedPath, options = {}) {
  const parsed = parseUnifiedPatchSet(patchBytes, [expectedPath]).files[0]
  return applyParsedUnifiedPatch(original, parsed, options)
}

export function applyUnifiedPatchSet(originals, patchBytes, expectedPaths, options = {}) {
  if (!(originals instanceof Map)) fail('PATCH_SOURCE_SET_INVALID')
  assertSameStringSet([...originals.keys()], expectedPaths, 'PATCH_SOURCE_SET_INVALID')
  const parsed = parseUnifiedPatchSet(patchBytes, expectedPaths)
  return new Map(parsed.files.map((file) => [
    file.path,
    applyParsedUnifiedPatch(originals.get(file.path), file, options)
  ]))
}

function applyParsedUnifiedPatch(original, patch, options = {}) {
  if (!Buffer.isBuffer(original)) fail('PATCH_SOURCE_INVALID')
  const reverse = options.reverse === true
  const hasUtf8Bom = original.length >= 3 && original[0] === 0xef && original[1] === 0xbb && original[2] === 0xbf
  const originalText = decodeCanonicalText(hasUtf8Bom ? original.subarray(3) : original, 'PATCH_SOURCE_INVALID')
  const hadFinalNewline = originalText.endsWith('\n')
  const sourceLines = hadFinalNewline ? originalText.slice(0, -1).split('\n') : originalText.split('\n')
  const output = []
  let sourceIndex = 0

  for (const hunk of patch.hunks) {
    const sourceStart = (reverse ? hunk.newStart : hunk.oldStart) - 1
    const sourceCount = reverse ? hunk.newCount : hunk.oldCount
    const outputCount = reverse ? hunk.oldCount : hunk.newCount
    if (sourceStart < sourceIndex || sourceStart > sourceLines.length) fail('PATCH_HUNK_INVALID')
    output.push(...sourceLines.slice(sourceIndex, sourceStart))
    sourceIndex = sourceStart
    let consumed = 0
    let emitted = 0

    for (const line of hunk.lines) {
      const prefix = line[0]
      const value = line.slice(1)
      const consumes = prefix === ' ' || (!reverse && prefix === '-') || (reverse && prefix === '+')
      const emits = prefix === ' ' || (!reverse && prefix === '+') || (reverse && prefix === '-')
      if (consumes) {
        if (sourceLines[sourceIndex] !== value) fail('PATCH_SOURCE_DRIFT')
        sourceIndex += 1
        consumed += 1
      }
      if (emits) {
        output.push(value)
        emitted += 1
      }
    }
    if (consumed !== sourceCount || emitted !== outputCount) fail('PATCH_HUNK_INVALID')
  }
  output.push(...sourceLines.slice(sourceIndex))
  const body = Buffer.from(`${output.join('\n')}${hadFinalNewline ? '\n' : ''}`, 'utf8')
  return hasUtf8Bom ? Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), body]) : body
}

export async function buildSourceCandidate({ repositoryRoot, sourceRoot, outputRoot, contract: suppliedContract }) {
  const repository = requireAbsolutePath(repositoryRoot, 'REPOSITORY_ROOT_INVALID')
  const verified = suppliedContract === undefined
    ? await verifyRepositoryContract(repository)
    : await verifyRepositoryContract(repository, suppliedContract)
  const upstream = await verifySourceCheckout(sourceRoot, verified.contract)
  const patchedSources = applyUnifiedPatchSet(upstream.sources, verified.patch, SOURCE_PATHS)
  const patchedDescriptors = new Map(verified.contract.candidate.patchedSources.map((entry) => [entry.path, entry]))
  for (const [sourcePath, bytes] of patchedSources) {
    assertMeasured(bytes, patchedDescriptors.get(sourcePath), 'PATCHED_SOURCE_DRIFT')
  }

  const destination = requireAbsolutePath(outputRoot, 'CANDIDATE_OUTPUT_INVALID')
  if (samePath(destination, upstream.root) || isDescendant(destination, upstream.root) ||
      isDescendant(upstream.root, destination) || samePath(destination, repository) ||
      isDescendant(destination, repository) || isDescendant(repository, destination)) {
    fail('CANDIDATE_OUTPUT_OVERLAP')
  }
  await assertAbsent(destination, 'CANDIDATE_OUTPUT_EXISTS')
  const parent = path.dirname(destination)
  await assertPlainDirectory(parent, 'CANDIDATE_OUTPUT_PARENT_INVALID')
  const temporary = path.join(parent, `.${path.basename(destination)}.tmp-${randomUUID()}`)
  await assertAbsent(temporary, 'CANDIDATE_OUTPUT_EXISTS')

  const contractName = CANDIDATE_CONTRACT_NAME
  const patchName = CANDIDATE_PATCH_NAME
  if (path.posix.basename(verified.contract.patch.path) !== patchName) fail('PATCH_CONTRACT_INVALID')
  const payloads = new Map([
    ['LICENSE', upstream.license],
    [contractName, verified.raw],
    [patchName, verified.patch]
  ])
  for (const [sourcePath, bytes] of patchedSources) payloads.set(sourcePath, bytes)
  const manifest = createCandidateManifest(verified.contract, payloads)
  const manifestBytes = Buffer.from(`${canonicalJson(manifest)}\n`, 'utf8')
  payloads.set(CANDIDATE_MANIFEST_NAME, manifestBytes)
  assertExactCandidateFiles([...payloads.keys()], verified.contract)

  try {
    await mkdir(temporary, { mode: 0o700 })
    for (const [relativePath, bytes] of [...payloads.entries()].sort(compareEntries)) {
      const target = managedCandidatePath(temporary, relativePath)
      await mkdir(path.dirname(target), { recursive: true, mode: 0o700 })
      await writeExclusive(target, bytes)
    }
    await verifySourceCandidate(temporary, {
      contract: verified.contract,
      contractRaw: verified.raw,
      patch: verified.patch
    })
    await rename(temporary, destination)
  } catch (error) {
    await rm(temporary, { recursive: true, force: true }).catch(() => undefined)
    throw error
  }
  const receipt = await verifySourceCandidate(destination, {
    contract: verified.contract,
    contractRaw: verified.raw,
    patch: verified.patch
  })
  return { root: destination, manifest: receipt.manifest, manifestSha256: receipt.manifestSha256 }
}

export async function verifySourceCandidate(candidateRoot, supplied) {
  const root = requireAbsolutePath(candidateRoot, 'CANDIDATE_ROOT_INVALID')
  await assertPlainDirectory(root, 'CANDIDATE_ROOT_INVALID')
  validateContract(supplied.contract)
  assertMeasured(supplied.patch, supplied.contract.patch, 'PATCH_FILE_DRIFT')
  const files = await inventoryCandidate(root)
  for (const entry of files) {
    if (PROPRIETARY_OR_BINARY_NAME.test(entry.path)) fail('CANDIDATE_PROPRIETARY_OR_BINARY_FILE')
  }
  assertExactCandidateFiles(files.map((entry) => entry.path), supplied.contract)
  const byPath = new Map(files.map((entry) => [entry.path, entry]))
  const contractEntry = requireInventoryEntry(byPath, CANDIDATE_CONTRACT_NAME)
  const patchEntry = requireInventoryEntry(byPath, CANDIDATE_PATCH_NAME)
  const licenseEntry = requireInventoryEntry(byPath, 'LICENSE')
  const manifestEntry = requireInventoryEntry(byPath, CANDIDATE_MANIFEST_NAME)

  if (!contractEntry.bytes.equals(supplied.contractRaw)) fail('CANDIDATE_CONTRACT_DRIFT')
  if (!patchEntry.bytes.equals(supplied.patch)) fail('CANDIDATE_PATCH_DRIFT')
  const sourceEntries = new Map()
  const patchedDescriptors = new Map(supplied.contract.candidate.patchedSources.map((entry) => [entry.path, entry]))
  for (const source of supplied.contract.sources) {
    const entry = requireInventoryEntry(byPath, source.path)
    assertMeasured(entry.bytes, patchedDescriptors.get(source.path), 'CANDIDATE_SOURCE_DRIFT')
    sourceEntries.set(source.path, entry.bytes)
  }
  assertMeasured(licenseEntry.bytes, {
    sha256: supplied.contract.upstream.licenseSha256,
    sizeBytes: supplied.contract.upstream.licenseSizeBytes
  }, 'CANDIDATE_LICENSE_DRIFT')
  const reconstructed = applyUnifiedPatchSet(sourceEntries, patchEntry.bytes, SOURCE_PATHS, { reverse: true })
  const originalDescriptors = new Map(supplied.contract.sources.map((entry) => [entry.path, entry]))
  for (const [sourcePath, bytes] of reconstructed) {
    assertMeasured(bytes, originalDescriptors.get(sourcePath), 'CANDIDATE_PATCH_RELATION_INVALID')
  }

  const manifest = parseJson(manifestEntry.bytes, 'CANDIDATE_MANIFEST_INVALID')
  const payloads = new Map([
    ['LICENSE', licenseEntry.bytes],
    [CANDIDATE_CONTRACT_NAME, contractEntry.bytes],
    [CANDIDATE_PATCH_NAME, patchEntry.bytes]
  ])
  for (const [sourcePath, bytes] of sourceEntries) payloads.set(sourcePath, bytes)
  const expected = createCandidateManifest(supplied.contract, payloads)
  const expectedBytes = Buffer.from(`${canonicalJson(expected)}\n`, 'utf8')
  if (!manifestEntry.bytes.equals(expectedBytes) || canonicalJson(manifest) !== canonicalJson(expected)) {
    fail('CANDIDATE_MANIFEST_INVALID')
  }
  return {
    manifest: expected,
    manifestSha256: sha256(manifestEntry.bytes),
    files: files.map(({ path: filePath, sizeBytes, sha256: digest }) => ({
      path: filePath,
      sizeBytes,
      sha256: digest
    }))
  }
}

export function inspectUnifiedPatch(patchBytes, expectedPath) {
  const inspection = inspectUnifiedPatchSet(patchBytes, [expectedPath])
  const file = inspection.files[0]
  return {
    oldPath: file.path,
    newPath: file.path,
    hunks: file.hunks,
    addedLines: file.addedLines,
    removedLines: file.removedLines,
    text: inspection.text
  }
}

export function inspectUnifiedPatchSet(patchBytes, expectedPaths) {
  const parsed = parseUnifiedPatchSet(patchBytes, expectedPaths)
  const files = parsed.files.map((file) => summarizeParsedPatch(file))
  return {
    files,
    hunks: files.reduce((total, file) => total + file.hunks, 0),
    addedLines: files.reduce((total, file) => total + file.addedLines, 0),
    removedLines: files.reduce((total, file) => total + file.removedLines, 0),
    text: parsed.text
  }
}

function summarizeParsedPatch(parsed) {
  let addedLines = 0
  let removedLines = 0
  for (const hunk of parsed.hunks) {
    for (const line of hunk.lines) {
      if (line.startsWith('+')) addedLines += 1
      if (line.startsWith('-')) removedLines += 1
    }
  }
  return {
    path: parsed.path,
    hunks: parsed.hunks.length,
    addedLines,
    removedLines
  }
}

export function createCandidateManifest(contract, payloads) {
  validateContract(contract)
  const files = [...payloads.entries()]
    .map(([filePath, bytes]) => ({
      path: filePath,
      role: candidateRole(filePath, contract.sources.map((entry) => entry.path)),
      sizeBytes: bytes.length,
      sha256: sha256(bytes)
    }))
    .sort((left, right) => compareText(left.path, right.path))
  const identity = {
    contractId: contract.id,
    upstreamCommit: contract.upstream.commit,
    patchSha256: contract.patch.sha256,
    patchedSources: contract.candidate.patchedSources.map(({ path: sourcePath, sha256: digest }) => ({
      path: sourcePath,
      sha256: digest
    }))
  }
  return {
    format: 'dyson-control-nebula-source-candidate',
    schemaVersion: 2,
    candidateId: `nebula-source-${sha256(Buffer.from(canonicalJson(identity))).slice(0, 40)}`,
    upstream: {
      repository: contract.upstream.repository,
      tag: contract.upstream.tag,
      commit: contract.upstream.commit,
      license: contract.upstream.license
    },
    patch: {
      contractId: contract.id,
      sources: contract.sources.map((source) => {
        const patched = contract.candidate.patchedSources.find((entry) => entry.path === source.path)
        return {
          path: source.path,
          sourceBeforeSha256: source.sha256,
          sourceAfterSha256: patched.sha256
        }
      }),
      patchSha256: contract.patch.sha256
    },
    distribution: {
      sourceOnly: true,
      binariesIncluded: false,
      proprietaryGameAssembliesIncluded: false,
      privateBuildRequired: true
    },
    files
  }
}

export function validateContract(value) {
  assertRecord(value, 'PATCH_CONTRACT_INVALID')
  assertExactKeys(value, ['format', 'schemaVersion', 'id', 'upstream', 'sources', 'patch', 'candidate'])
  if (value.format !== 'dyson-control-nebula-source-patch-contract' || value.schemaVersion !== 2 ||
      value.id !== 'nebula-v0.9.22-hostname-wss-v2') fail('PATCH_CONTRACT_INVALID')
  assertRecord(value.upstream, 'PATCH_CONTRACT_INVALID')
  assertExactKeys(value.upstream, [
    'repository', 'tag', 'commit', 'license', 'licensePath', 'licenseGitBlob',
    'licenseSha256', 'licenseSizeBytes'
  ])
  if (value.upstream.repository !== 'https://github.com/NebulaModTeam/nebula.git' ||
      value.upstream.tag !== 'v0.9.22' || value.upstream.license !== 'GPL-3.0-only' ||
      value.upstream.licensePath !== 'LICENSE' || value.upstream.commit !== PINNED.commit ||
      value.upstream.licenseGitBlob !== PINNED.licenseGitBlob ||
      value.upstream.licenseSha256 !== PINNED.licenseSha256 ||
      value.upstream.licenseSizeBytes !== PINNED.licenseSizeBytes) fail('PATCH_CONTRACT_INVALID')
  assertSha1(value.upstream.commit)
  assertSha1(value.upstream.licenseGitBlob)
  assertSha256(value.upstream.licenseSha256)
  assertSize(value.upstream.licenseSizeBytes)
  if (!Array.isArray(value.sources) || value.sources.length !== SOURCE_PATHS.length) fail('PATCH_CONTRACT_INVALID')
  value.sources.forEach((source, index) => {
    assertRecord(source, 'PATCH_CONTRACT_INVALID')
    assertExactKeys(source, ['path', 'gitBlob', 'sha256', 'sizeBytes'])
    const pinned = PINNED.sources[SOURCE_PATHS[index]]
    if (source.path !== SOURCE_PATHS[index] || source.gitBlob !== pinned.gitBlob ||
        source.sha256 !== pinned.sha256 || source.sizeBytes !== pinned.sizeBytes) fail('PATCH_CONTRACT_INVALID')
    assertSafeRelativePath(source.path)
    assertSha1(source.gitBlob)
    assertSha256(source.sha256)
    assertSize(source.sizeBytes)
  })
  assertRecord(value.patch, 'PATCH_CONTRACT_INVALID')
  assertExactKeys(value.patch, ['path', 'sha256', 'sizeBytes'])
  assertSafeRelativePath(value.patch.path)
  if (value.patch.path !== 'integrations/nebula-hostname-wss/patches/nebula-v0.9.22-hostname-wss.patch') {
    fail('PATCH_CONTRACT_INVALID')
  }
  if (value.patch.sha256 !== PINNED.patchSha256 || value.patch.sizeBytes !== PINNED.patchSizeBytes) {
    fail('PATCH_CONTRACT_INVALID')
  }
  assertSha256(value.patch.sha256)
  assertSize(value.patch.sizeBytes)
  assertRecord(value.candidate, 'PATCH_CONTRACT_INVALID')
  assertExactKeys(value.candidate, ['patchedSources', 'allowedFiles'])
  if (!Array.isArray(value.candidate.patchedSources) ||
      value.candidate.patchedSources.length !== SOURCE_PATHS.length) fail('PATCH_CONTRACT_INVALID')
  value.candidate.patchedSources.forEach((source, index) => {
    assertRecord(source, 'PATCH_CONTRACT_INVALID')
    assertExactKeys(source, ['path', 'sha256', 'sizeBytes'])
    const pinned = PINNED.sources[SOURCE_PATHS[index]]
    if (source.path !== SOURCE_PATHS[index] || source.sha256 !== pinned.patchedSha256 ||
        source.sizeBytes !== pinned.patchedSizeBytes) fail('PATCH_CONTRACT_INVALID')
    assertSafeRelativePath(source.path)
    assertSha256(source.sha256)
    assertSize(source.sizeBytes)
  })
  if (!Array.isArray(value.candidate.allowedFiles) || value.candidate.allowedFiles.length !== 6) {
    fail('PATCH_CONTRACT_INVALID')
  }
  const expected = [
    'LICENSE',
    ...SOURCE_PATHS,
    CANDIDATE_MANIFEST_NAME,
    CANDIDATE_CONTRACT_NAME,
    CANDIDATE_PATCH_NAME
  ]
  assertSameStringSet(value.candidate.allowedFiles, expected, 'PATCH_CONTRACT_INVALID')
  return value
}

function parseUnifiedPatchSet(patchBytes, expectedPaths) {
  if (!Array.isArray(expectedPaths) || expectedPaths.length === 0 ||
      new Set(expectedPaths).size !== expectedPaths.length) fail('PATCH_SCOPE_INVALID')
  for (const expectedPath of expectedPaths) assertSafeRelativePath(expectedPath)
  const text = decodeCanonicalText(patchBytes, 'PATCH_FILE_INVALID')
  if (!text.endsWith('\n')) fail('PATCH_FILE_INVALID')
  const lines = text.slice(0, -1).split('\n')
  if (lines.length < 4) fail('PATCH_FILE_INVALID')
  const starts = []
  for (let index = 0; index < lines.length; index++) {
    if (lines[index].startsWith('diff --git ')) starts.push(index)
  }
  if (starts.length !== expectedPaths.length || starts[0] !== 0) fail('PATCH_SCOPE_INVALID')
  const files = starts.map((start, index) => {
    const end = starts[index + 1] ?? lines.length
    return parseUnifiedPatchSection(lines.slice(start, end), expectedPaths[index])
  })
  return { files, text }
}

function parseUnifiedPatchSection(lines, expectedPath) {
  if (lines.length < 4) fail('PATCH_FILE_INVALID')
  const diffMatch = /^diff --git a\/(\S+) b\/(\S+)$/.exec(lines[0])
  if (diffMatch === null || diffMatch[1] !== expectedPath || diffMatch[2] !== expectedPath) {
    fail('PATCH_SCOPE_INVALID')
  }
  assertSafeRelativePath(diffMatch[1])
  assertSafeRelativePath(diffMatch[2])
  if (lines[1] !== `--- a/${expectedPath}` || lines[2] !== `+++ b/${expectedPath}`) {
    fail('PATCH_SCOPE_INVALID')
  }
  const hunks = []
  let index = 3
  let previousOldEnd = 0
  let previousNewEnd = 0
  while (index < lines.length) {
    if (lines[index].startsWith('diff --git ') || lines[index].startsWith('--- ') ||
        lines[index].startsWith('+++ ') || lines[index].startsWith('Binary files ')) {
      fail('PATCH_SCOPE_INVALID')
    }
    const header = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(?: .*)?$/.exec(lines[index])
    if (header === null) fail('PATCH_HUNK_INVALID')
    const hunk = {
      oldStart: Number(header[1]),
      oldCount: Number(header[2] ?? '1'),
      newStart: Number(header[3]),
      newCount: Number(header[4] ?? '1'),
      lines: []
    }
    if (hunk.oldStart < 1 || hunk.newStart < 1 || hunk.oldCount < 0 || hunk.newCount < 0 ||
        hunk.oldStart < previousOldEnd || hunk.newStart < previousNewEnd) fail('PATCH_HUNK_INVALID')
    index += 1
    let oldCount = 0
    let newCount = 0
    let changed = false
    while (index < lines.length && !lines[index].startsWith('@@ ')) {
      const line = lines[index]
      if (line.length === 0 || ![' ', '+', '-'].includes(line[0])) fail('PATCH_HUNK_INVALID')
      if (line[0] === ' ') {
        oldCount += 1
        newCount += 1
      } else if (line[0] === '-') {
        oldCount += 1
        changed = true
      } else {
        newCount += 1
        changed = true
      }
      hunk.lines.push(line)
      index += 1
    }
    if (!changed || oldCount !== hunk.oldCount || newCount !== hunk.newCount) fail('PATCH_HUNK_INVALID')
    previousOldEnd = hunk.oldStart + hunk.oldCount
    previousNewEnd = hunk.newStart + hunk.newCount
    hunks.push(hunk)
  }
  if (hunks.length === 0) fail('PATCH_HUNK_INVALID')
  return { path: expectedPath, hunks }
}

function assertProductionPatchSemantics(inspection) {
  const text = inspection.text
  const required = [
    '+    private readonly string serverHostname;',
    '+        serverHostname = url;',
    '+        var serverAuthority = serverHostname == null ? ServerEndpoint.ToString() : $"{serverHostname}:{ServerEndpoint.Port}";',
    '+        clientSocket = new WebSocket($"{serverProtocol}://{serverAuthority}/socket");',
    '+            // Preserve WS for hostname:443 so remembered input is not re-promoted to WSS; otherwise retain the stock display.',
    '+            Config.Options.LastIP = serverProtocol == "ws" && (serverHostname == null || ServerEndpoint.Port != 443) ? serverAuthority : $"{serverProtocol}://{serverAuthority}";',
    '+                                ? new Client(ServerEndpoint, serverProtocol, password)',
    '+                                : new Client(serverHostname, ServerEndpoint.Port, serverProtocol, password));',
    '+        var protocolExplicit = false;',
    '+                    protocolExplicit = true;',
    '+        if (!isIP && !protocolExplicit && protocol == "ws" && p == 443)',
    '+            protocol = "wss";'
  ]
  for (const line of required) if (!text.includes(`${line}\n`)) fail('PATCH_SEMANTICS_INVALID')
  const forbidden = [
    '+        clientSocket = new WebSocket($"{serverProtocol}://{ServerEndpoint}/socket");',
    '+                            Multiplayer.JoinGame(new Client(ServerEndpoint, password));',
    '+        : this(new IPEndPoint(Dns.GetHostEntry(url).AddressList[0], port), protocol == "ws" && port == 443 ? "wss" : protocol, password)',
    '-        : this(new IPEndPoint(Dns.GetHostEntry(url).AddressList[0], port), protocol, password)'
  ]
  for (const line of forbidden) if (text.includes(line)) fail('PATCH_SEMANTICS_INVALID')
  if (!text.includes('\n         : this(new IPEndPoint(Dns.GetHostEntry(url).AddressList[0], port), protocol, password)\n') ||
      !text.includes('\n     public Client(IPEndPoint endpoint, string protocol = "", string password = "")\n')) {
    fail('PATCH_SEMANTICS_INVALID')
  }
  for (const line of [
    'public Client(IPEndPoint endpoint, string protocol = "", string password = "")',
    'ServerEndpoint = endpoint;',
    'if (protocol != "")'
  ]) {
    if (text.includes(`+    ${line}`) || text.includes(`-    ${line}`) ||
        text.includes(`+        ${line}`) || text.includes(`-        ${line}`)) fail('PATCH_SEMANTICS_INVALID')
  }
  for (const line of text.split('\n')) {
    if (['+', '-'].includes(line[0]) && (
      line.includes('new IPEndPoint(IPAddress.Parse(connectionString)') ||
      line.includes('isIP = true') ||
      line.includes('result.AddressFamily == AddressFamily.InterNetworkV6')
    )) fail('PATCH_SEMANTICS_INVALID')
  }
}

async function readTrackedBlob(root, commit, descriptor, prefix) {
  assertSafeRelativePath(descriptor.path)
  const workingPath = managedCandidatePath(root, descriptor.path)
  const info = await lstat(workingPath).catch(() => null)
  if (info === null || !info.isFile() || info.isSymbolicLink()) fail(`${prefix}_WORKTREE_INVALID`)
  runGitText(root, ['ls-files', '--error-unmatch', '--', descriptor.path], `${prefix}_UNTRACKED`)
  const blobId = runGitText(root, ['rev-parse', '--verify', `${commit}:${descriptor.path}`], `${prefix}_BLOB_INVALID`)
  if (blobId !== descriptor.gitBlob) fail(`${prefix}_BLOB_INVALID`)
  const blob = runGitBytes(root, ['cat-file', 'blob', `${commit}:${descriptor.path}`], `${prefix}_BLOB_INVALID`)
  assertMeasured(blob, descriptor, `${prefix}_DRIFT`)
  return blob
}

function parseIpEndpoint(value) {
  const bracketed = /^\[([^\]]+)\](?::(\d+))?$/.exec(value)
  if (bracketed !== null && isIpLiteral(bracketed[1]) === 6) {
    const port = bracketed[2] === undefined ? 0 : Number(bracketed[2])
    if (Number.isInteger(port) && port >= 0 && port <= 65535) {
      return { address: bracketed[1], version: 6, port }
    }
    return null
  }

  const version = isIpLiteral(value)
  if (version !== 0) return { address: value, version, port: 0 }

  const lastColon = value.lastIndexOf(':')
  if (lastColon > 0 && value.slice(0, lastColon).lastIndexOf(':') === -1) {
    const address = value.slice(0, lastColon)
    const portText = value.slice(lastColon + 1)
    const port = /^\d+$/.test(portText) ? Number(portText) : -1
    const addressVersion = isIpLiteral(address)
    if (addressVersion === 4 && Number.isInteger(port) && port >= 0 && port <= 65535) {
      return { address, version: addressVersion, port }
    }
  }
  return null
}

function runGitText(root, args, errorCode, preserveEmpty = false) {
  const result = spawnSync('git', ['-C', root, ...args], {
    encoding: 'utf8',
    windowsHide: true,
    maxBuffer: 4 * 1024 * 1024
  })
  if (result.error !== undefined || result.status !== 0) fail(errorCode)
  const output = result.stdout.replace(/\r\n/g, '\n')
  return preserveEmpty ? output.replace(/\n$/, '') : output.trim()
}

function runGitOptionalText(root, args) {
  const result = spawnSync('git', ['-C', root, ...args], {
    encoding: 'utf8',
    windowsHide: true,
    maxBuffer: 64 * 1024
  })
  if (result.error !== undefined) fail('UPSTREAM_GIT_INVALID')
  if (result.status !== 0) return ''
  return result.stdout.trim()
}

function runGitBytes(root, args, errorCode) {
  const result = spawnSync('git', ['-C', root, ...args], {
    encoding: null,
    windowsHide: true,
    maxBuffer: MAX_CANDIDATE_FILE_BYTES
  })
  if (result.error !== undefined || result.status !== 0) fail(errorCode)
  return result.stdout
}

async function inventoryCandidate(root) {
  const files = []
  async function walk(directory, relativeDirectory) {
    const entries = await readdir(directory, { withFileTypes: true })
    for (const entry of entries.sort((left, right) => compareText(left.name, right.name))) {
      const relative = relativeDirectory === '' ? entry.name : `${relativeDirectory}/${entry.name}`
      assertSafeRelativePath(relative)
      const full = managedCandidatePath(root, relative)
      const info = await lstat(full)
      if (info.isSymbolicLink()) fail('CANDIDATE_SYMLINK_REJECTED')
      if (info.isDirectory()) {
        if (!ALLOWED_CANDIDATE_DIRECTORIES.has(relative)) fail('CANDIDATE_EXTRA_DIRECTORY')
        await walk(full, relative)
      } else if (info.isFile()) {
        if (info.size <= 0 || info.size > MAX_CANDIDATE_FILE_BYTES) fail('CANDIDATE_FILE_INVALID')
        const bytes = await readFile(full)
        if (bytes.length >= 2 && bytes[0] === 0x4d && bytes[1] === 0x5a) {
          fail('CANDIDATE_PROPRIETARY_OR_BINARY_FILE')
        }
        files.push({ path: relative, bytes, sizeBytes: bytes.length, sha256: sha256(bytes) })
      } else {
        fail('CANDIDATE_SPECIAL_FILE_REJECTED')
      }
    }
  }
  await walk(root, '')
  return files
}

function candidateRole(filePath, sourcePaths) {
  if (filePath === 'LICENSE') return 'upstream-license'
  if (sourcePaths.includes(filePath)) return 'patched-gpl-source'
  if (filePath === CANDIDATE_CONTRACT_NAME) return 'source-patch-contract'
  if (filePath === CANDIDATE_PATCH_NAME) return 'unified-source-patch'
  fail('CANDIDATE_FILE_INVALID')
}

function assertExactCandidateFiles(actual, contract) {
  for (const filePath of actual) assertSafeRelativePath(filePath)
  assertSameStringSet(actual, contract.candidate.allowedFiles, 'CANDIDATE_FILE_SET_INVALID')
}

function requireInventoryEntry(byPath, filePath) {
  const entry = byPath.get(filePath)
  if (entry === undefined) fail('CANDIDATE_FILE_SET_INVALID')
  return entry
}

async function writeExclusive(file, bytes) {
  let handle
  try {
    handle = await open(file, 'wx', 0o600)
    await handle.writeFile(bytes)
    await handle.sync()
  } catch (error) {
    throw new NebulaHostnameWssError('CANDIDATE_WRITE_FAILED', { cause: error })
  } finally {
    await handle?.close().catch(() => undefined)
  }
}

async function readBoundedFile(file, maximumBytes, code) {
  const info = await lstat(file).catch(() => null)
  if (info === null || !info.isFile() || info.isSymbolicLink() || info.size <= 0 || info.size > maximumBytes) {
    fail(code)
  }
  return readFile(file)
}

async function assertPlainDirectory(directory, code) {
  const info = await lstat(directory).catch(() => null)
  if (info === null || !info.isDirectory() || info.isSymbolicLink()) fail(code)
}

async function assertAbsent(target, code) {
  const info = await lstat(target).catch((error) => error?.code === 'ENOENT' ? null : Promise.reject(error))
  if (info !== null) fail(code)
}

function managedRepositoryPath(root, relativePath) {
  assertSafeRelativePath(relativePath)
  return managedCandidatePath(root, relativePath)
}

function managedCandidatePath(root, relativePath) {
  assertSafeRelativePath(relativePath)
  const target = path.resolve(root, ...relativePath.split('/'))
  if (!isDescendant(target, root)) fail('PATH_ESCAPE_REJECTED')
  return target
}

function requireAbsolutePath(value, code) {
  if (typeof value !== 'string' || value.length === 0 || !path.isAbsolute(value) || /[\0\r\n]/.test(value)) fail(code)
  return path.resolve(value)
}

function isDescendant(candidate, root) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate))
  return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)
}

function samePath(left, right) {
  const normalizedLeft = path.resolve(left)
  const normalizedRight = path.resolve(right)
  return process.platform === 'win32'
    ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
    : normalizedLeft === normalizedRight
}

function assertSafeRelativePath(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 240 || value.includes('\\') ||
      /[\0\r\n\t]/.test(value) || path.posix.isAbsolute(value) || path.win32.isAbsolute(value) ||
      path.posix.normalize(value) !== value || value.split('/').some((part) => part === '' || part === '.' || part === '..')) {
    fail('PATH_ESCAPE_REJECTED')
  }
}

function assertMeasured(bytes, descriptor, code) {
  if (bytes.length !== descriptor.sizeBytes || sha256(bytes) !== descriptor.sha256) fail(code)
}

function assertSameStringSet(actual, expected, code) {
  if (actual.some((value) => typeof value !== 'string') || new Set(actual).size !== actual.length ||
      actual.length !== expected.length) fail(code)
  const left = [...actual].sort(compareText)
  const right = [...expected].sort(compareText)
  if (left.some((value, index) => value !== right[index])) fail(code)
}

function assertRecord(value, code) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) fail(code)
}

function assertExactKeys(value, keys) {
  const actual = Object.keys(value).sort(compareText)
  const expected = [...keys].sort(compareText)
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    fail('PATCH_CONTRACT_INVALID')
  }
}

function assertSha1(value) {
  if (typeof value !== 'string' || !/^[0-9a-f]{40}$/.test(value)) fail('PATCH_CONTRACT_INVALID')
}

function assertSha256(value) {
  if (typeof value !== 'string' || !/^[0-9a-f]{64}$/.test(value)) fail('PATCH_CONTRACT_INVALID')
}

function assertSize(value) {
  if (!Number.isSafeInteger(value) || value <= 0 || value > MAX_CANDIDATE_FILE_BYTES) fail('PATCH_CONTRACT_INVALID')
}

function parseJson(bytes, code) {
  try {
    return JSON.parse(decodeCanonicalText(bytes, code))
  } catch (error) {
    if (error instanceof NebulaHostnameWssError) throw error
    throw new NebulaHostnameWssError(code, { cause: error })
  }
}

function decodeCanonicalText(bytes, code) {
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    if (text.includes('\r') || text.includes('\0')) fail(code)
    return text
  } catch (error) {
    if (error instanceof NebulaHostnameWssError) throw error
    throw new NebulaHostnameWssError(code, { cause: error })
  }
}

function canonicalJson(value) {
  return JSON.stringify(sortCanonical(value))
}

function sortCanonical(value) {
  if (Array.isArray(value)) return value.map(sortCanonical)
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value)
      .sort(([left], [right]) => compareText(left, right))
      .map(([key, entry]) => [key, sortCanonical(entry)]))
  }
  return value
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

function compareEntries([left], [right]) {
  return compareText(left, right)
}

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0
}

function fail(code) {
  throw new NebulaHostnameWssError(code)
}
