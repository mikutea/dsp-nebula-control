import { createHash } from 'node:crypto'
import { execFile, spawn } from 'node:child_process'
import { lstat, opendir, readFile, realpath } from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'
import {
  ARTIFACT_EXACT_ALLOWED_PATHS,
  DEFAULT_LIMITS,
  EXACT_ALLOWLIST,
  POLICY_ID,
  POLICY_SHA256,
  POLICY_VERSION,
  PUBLIC_REFERENCE_HOSTS,
  RULE_IDS
} from './policy.mjs'

const execFileAsync = promisify(execFile)
const policyRuleIds = new Set(RULE_IDS)
const exactAllowlist = new Set(EXACT_ALLOWLIST.map((entry) =>
  allowlistKey(entry.scope, entry.ruleId, entry.path, entry.blobId)
))
const artifactExactAllowedPaths = new Set(ARTIFACT_EXACT_ALLOWED_PATHS.map((entry) =>
  entry.toLocaleLowerCase('en-US')
))
const publicReferenceHosts = new Set(PUBLIC_REFERENCE_HOSTS)
const utf8Decoder = new TextDecoder('utf-8', { fatal: true })
const textExtensions = new Set([
  '', '.c', '.cc', '.cfg', '.config', '.cpp', '.cs', '.csproj', '.css', '.csv', '.d.ts', '.editorconfig',
  '.gitignore', '.gitattributes', '.h', '.hpp', '.html', '.ini', '.js', '.json', '.jsx', '.lock', '.md',
  '.mjs', '.ps1', '.props', '.scss', '.sh', '.sln', '.sql', '.svg', '.toml', '.ts', '.tsx', '.txt',
  '.xml', '.yaml', '.yml'
])
const imageExtensions = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.svg'])
const reviewableBinaryExtensions = new Set([
  '.gif', '.ico', '.jpeg', '.jpg', '.node', '.otf', '.png', '.ttf', '.wasm', '.webp', '.woff', '.woff2'
])
const secretKey = '(?:password|passwd|secret|token|credential|api[_-]?key|apikey|private[_-]?key|session[_-]?key|cookie|authorization|steam[_-]?(?:guard|password|token|cookie))'
const quotedSecretAssignment = new RegExp(`\\b(?<key>[A-Za-z0-9_.-]*${secretKey}[A-Za-z0-9_.-]*)\\s*[:=]\\s*(?<quote>["'])(?<value>[^"'\\r\\n]{0,4096})\\k<quote>`, 'gim')
const environmentSecretAssignment = new RegExp(`^[ \\t#]*(?<key>[A-Z0-9_]*${secretKey.toUpperCase()}[A-Z0-9_]*)[ \\t]*=[ \\t]*(?<value>[^\\r\\n#]{0,4096})`, 'gm')
const iniSecretAssignment = /(?:^|\\[nr]|[^A-Za-z0-9_])(?<key>ServerPassword|RemoteAccessPassword|GamePassword)\s*=\s*(?<value>[^\s#;"']{1,512})/gim
const endpointAssignment = /\b(?<key>host|hostname|domain|origin|endpoint|publicUrl|publicOrigin|joinHost|apiUrl|baseUrl|serverUrl)\s*[:=]\s*["'](?<value>[^"'\r\n]{1,512})["']/gim
const vendoredEndpointKeys = new Set(['endpoint', 'publicurl', 'publicorigin', 'joinhost', 'apiurl', 'baseurl', 'serverurl'])
const urlPattern = /\b(?:https?|wss?):\/\/[^\s)\]>'"<\\`]+/gim
// URLs and explicit endpoint assignments above cover apex hosts. This bare-host
// fallback intentionally requires at least three labels so normal source
// expressions such as player.online and System.IO are not mistaken for hosts.
const hostnameLiteralPattern = /(?<![A-Za-z0-9_-])(?<host>(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.){2,}(?:ai|app|cloud|cn|co|com|de|dev|gg|io|jp|live|me|net|online|org|site|tech|top|uk|us|xyz))(?![A-Za-z0-9_-])/gim
const ipv4Pattern = /\b(?<address>(?:\d{1,3}\.){3}\d{1,3})\b/g
const uncPattern = /(?:^|[\s"'=(])(?<path>\\\\[^\\\s"'<>]+\\[^\s"'<>]+)/gm
const windowsUserPath = /\b[A-Za-z]:[\\/](?:Users|Documents and Settings)[\\/](?<user>[^\\/\s"'<>]+)(?:[\\/]|\b)/gim
const posixUserPath = /(?:^|[\s"'=])\/(?:home|Users)\/(?<user>[^/\s"'<>]+)(?:\/|\b)/gm
const steamId64Pattern = /\b7656119\d{10}\b/g
const steamLegacyPattern = /\bSTEAM_[0-5]:[01]:\d+\b/g
const steamAccountPattern = /\[U:1:\d+\]/g
const privateKeyPattern = /-{5}BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-{5}/g
const connectionStringPattern = /\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis):\/\/[^\s"'<>]+/gim

export async function runPublicReleaseScan(options = {}) {
  const limits = Object.freeze({ ...DEFAULT_LIMITS, ...(options.limits ?? {}) })
  const requestedHistory = options.history === true
  const requestedArtifact = options.artifactPath !== undefined && options.artifactPath !== null
  let repositoryRoot
  try {
    repositoryRoot = await realpath(path.resolve(options.repositoryRoot ?? process.cwd()))
  } catch {
    return evidenceForRepositoryFailure(requestedHistory, requestedArtifact)
  }

  const repository = await collectRepositoryIdentity(repositoryRoot, limits)
  const collector = createFindingCollector()
  if (repository.dirty) collector.add('REPOSITORY_DIRTY', { scope: 'worktree' })
  const worktree = await scanWorktree(repositoryRoot, limits, collector)
  const history = requestedHistory
    ? await scanHistory(repositoryRoot, limits, collector)
    : disabledScope()
  const artifact = requestedArtifact
    ? await scanArtifact(path.resolve(options.artifactPath), limits, collector)
    : disabledScope()
  const findings = collector.findings()
  const evidence = {
    protocol: 'DYSON_PUBLIC_RELEASE_HYGIENE_V1',
    policy: { id: POLICY_ID, version: POLICY_VERSION, sha256: POLICY_SHA256 },
    passed: repository.available && worktree.completed && (!requestedHistory || history.completed)
      && (!requestedArtifact || artifact.completed) && findings.length === 0,
    repository,
    scopes: { worktree, history, artifact },
    totals: {
      scannedFiles: worktree.scannedFiles + history.scannedFiles + artifact.scannedFiles,
      scannedBytes: worktree.scannedBytes + history.scannedBytes + artifact.scannedBytes,
      findingCount: findings.length,
      allowlistedMatchCount: collector.allowlistedMatchCount()
    },
    findings
  }
  return evidence
}

async function collectRepositoryIdentity(repositoryRoot, limits) {
  try {
    const [headCommit, headTree, status] = await Promise.all([
      runGit(repositoryRoot, ['rev-parse', '--verify', 'HEAD'], limits.maximumGitOutputBytes, true),
      runGit(repositoryRoot, ['rev-parse', '--verify', 'HEAD^{tree}'], limits.maximumGitOutputBytes, true),
      runGit(repositoryRoot, ['status', '--porcelain=v1', '-z', '--untracked-files=all'], limits.maximumGitOutputBytes)
    ])
    const normalizedCommit = normalizeObjectId(headCommit.toString('utf8').trim())
    const normalizedTree = normalizeObjectId(headTree.toString('utf8').trim())
    if (normalizedCommit === null || normalizedTree === null) {
      return { available: false, headCommit: null, headTree: null, dirty: true }
    }
    return {
      available: true,
      headCommit: normalizedCommit,
      headTree: normalizedTree,
      dirty: status.length > 0
    }
  } catch {
    return { available: false, headCommit: null, headTree: null, dirty: true }
  }
}

async function scanWorktree(repositoryRoot, limits, collector) {
  const scope = baseScope(true)
  let rawCandidates
  try {
    rawCandidates = await runGit(repositoryRoot, [
      'ls-files', '-z', '--cached', '--others', '--exclude-standard'
    ], limits.maximumGitOutputBytes)
  } catch {
    collector.add('SCAN_IO_FAILURE', { scope: 'worktree' })
    return { ...scope, completed: false }
  }

  const rawPaths = splitNullRecords(rawCandidates)
  scope.candidateFiles = rawPaths.length
  if (rawPaths.length > limits.maximumWorktreeFiles) {
    collector.add('WORKTREE_FILE_LIMIT_EXCEEDED', { scope: 'worktree' })
    return { ...scope, completed: false }
  }
  const paths = []
  for (const rawPath of rawPaths) {
    try {
      paths.push(utf8Decoder.decode(rawPath))
    } catch {
      collector.add('UNSAFE_CANDIDATE_PATH', { scope: 'worktree' })
    }
  }
  paths.sort(compareOrdinal)
  const folded = new Map()
  let repositoryReal
  try {
    repositoryReal = await realpath(repositoryRoot)
  } catch {
    collector.add('SCAN_IO_FAILURE', { scope: 'worktree' })
    return { ...scope, completed: false }
  }

  for (const candidate of paths) {
    const relative = normalizeRelativePath(candidate)
    if (relative === null) {
      collector.add('UNSAFE_CANDIDATE_PATH', { scope: 'worktree' })
      continue
    }
    const foldedPath = relative.toLocaleLowerCase('en-US')
    if (folded.has(foldedPath) && folded.get(foldedPath) !== relative) {
      collector.add('CASE_COLLIDING_PATH', { scope: 'worktree', path: relative })
    } else {
      folded.set(foldedPath, relative)
    }
    scanPathRules(relative, 'worktree', collector)
    const absolute = path.join(repositoryRoot, ...relative.split('/'))
    let stat
    try {
      stat = await lstat(absolute)
    } catch (error) {
      collector.add(error?.code === 'ENOENT' ? 'WORKTREE_ENTRY_MISSING' : 'SCAN_IO_FAILURE', {
        scope: 'worktree', path: relative
      })
      continue
    }
    if (!stat.isFile() || stat.isSymbolicLink()) {
      collector.add('WORKTREE_REDIRECTED_ENTRY', { scope: 'worktree', path: relative })
      continue
    }
    try {
      const resolved = await realpath(absolute)
      if (!pathWithin(resolved, repositoryReal)) {
        collector.add('WORKTREE_REDIRECTED_ENTRY', { scope: 'worktree', path: relative })
        continue
      }
    } catch {
      collector.add('SCAN_IO_FAILURE', { scope: 'worktree', path: relative })
      continue
    }
    if (stat.size > limits.maximumWorktreeFileBytes) {
      collector.add('WORKTREE_FILE_TOO_LARGE', { scope: 'worktree', path: relative })
      continue
    }
    scope.scannedBytes += stat.size
    if (scope.scannedBytes > limits.maximumWorktreeBytes) {
      collector.add('WORKTREE_TOTAL_BYTES_EXCEEDED', { scope: 'worktree' })
      return { ...scope, completed: false }
    }
    try {
      const bytes = await readFile(absolute)
      scanBytes(bytes, { scope: 'worktree', path: relative }, collector)
      scope.scannedFiles++
    } catch {
      collector.add('SCAN_IO_FAILURE', { scope: 'worktree', path: relative })
    }
  }
  return scope
}

async function scanHistory(repositoryRoot, limits, collector) {
  const scope = baseScope(true)
  let objectOutput
  try {
    objectOutput = await runGit(repositoryRoot, ['rev-list', '--objects', '--all', '-z'], limits.maximumGitOutputBytes)
  } catch {
    collector.add('SCAN_IO_FAILURE', { scope: 'history' })
    return { ...scope, completed: false }
  }
  const objectPaths = new Map()
  const objectIdSet = new Set()
  let pendingObjectId = null
  for (const record of splitNullRecords(objectOutput)) {
    const raw = record.toString('ascii')
    const objectId = normalizeObjectId(raw)
    if (objectId !== null) {
      objectIdSet.add(objectId)
      pendingObjectId = objectId
      continue
    }
    if (!raw.startsWith('path=') || pendingObjectId === null) {
      collector.add('SCAN_IO_FAILURE', { scope: 'history' })
      return { ...scope, completed: false }
    }
    try {
      const candidatePath = normalizeRelativePath(utf8Decoder.decode(record.subarray(5)))
      if (candidatePath === null) collector.add('UNSAFE_CANDIDATE_PATH', { scope: 'history', blobId: pendingObjectId })
      else if (!objectPaths.has(pendingObjectId)) objectPaths.set(pendingObjectId, candidatePath)
    } catch {
      collector.add('UNSAFE_CANDIDATE_PATH', { scope: 'history', blobId: pendingObjectId })
    }
    pendingObjectId = null
  }
  const objectIds = [...objectIdSet].sort(compareOrdinal)
  scope.candidateObjects = objectIds.length
  if (objectIds.length > limits.maximumHistoryObjects) {
    collector.add('HISTORY_OBJECT_LIMIT_EXCEEDED', { scope: 'history' })
    return { ...scope, completed: false }
  }

  let metadataOutput
  try {
    metadataOutput = await runGit(
      repositoryRoot,
      ['cat-file', '--batch-check=%(objectname) %(objecttype) %(objectsize)'],
      limits.maximumGitOutputBytes,
      false,
      Buffer.from(`${objectIds.join('\n')}\n`, 'ascii')
    )
  } catch {
    collector.add('SCAN_IO_FAILURE', { scope: 'history' })
    return { ...scope, completed: false }
  }
  const blobs = []
  const metadataLines = metadataOutput.toString('ascii').trim().split(/\r?\n/).filter(Boolean)
  const metadataIds = new Set()
  for (const line of metadataLines) {
    const match = /^(?<oid>[0-9a-f]{40,64}) (?<type>blob|tree|commit|tag) (?<size>\d+)$/.exec(line)
    if (match === null || metadataIds.has(match?.groups.oid)) {
      collector.add('SCAN_IO_FAILURE', { scope: 'history' })
      return { ...scope, completed: false }
    }
    metadataIds.add(match.groups.oid)
    const size = Number(match.groups.size)
    if (!Number.isSafeInteger(size) || size < 0) {
      collector.add('SCAN_IO_FAILURE', { scope: 'history', blobId: normalizeObjectId(match.groups.oid) })
      return { ...scope, completed: false }
    }
    if (match.groups.type !== 'blob') continue
    const oid = normalizeObjectId(match.groups.oid)
    blobs.push({ oid, size, path: objectPaths.get(oid) })
  }
  if (metadataLines.length !== objectIds.length || metadataIds.size !== objectIds.length
      || objectIds.some((objectId) => !metadataIds.has(objectId))) {
    collector.add('SCAN_IO_FAILURE', { scope: 'history' })
    return { ...scope, completed: false }
  }
  blobs.sort((left, right) => compareOrdinal(left.oid, right.oid))
  scope.candidateFiles = blobs.length
  if (blobs.length > limits.maximumHistoryBlobs) {
    collector.add('HISTORY_BLOB_LIMIT_EXCEEDED', { scope: 'history' })
    return { ...scope, completed: false }
  }
  const readable = []
  for (const blob of blobs) {
    if (blob.path !== undefined) scanPathRules(blob.path, 'history', collector, blob.oid)
    scope.scannedBytes += blob.size
    if (scope.scannedBytes > limits.maximumHistoryBytes) {
      collector.add('HISTORY_TOTAL_BYTES_EXCEEDED', { scope: 'history' })
      return { ...scope, completed: false }
    }
    if (blob.size > limits.maximumHistoryBlobBytes) {
      collector.add('HISTORY_BLOB_TOO_LARGE', { scope: 'history', blobId: blob.oid })
    } else {
      readable.push(blob)
    }
  }
  try {
    await readGitBlobBatch(repositoryRoot, readable, (blob, bytes) => {
      scanBytes(bytes, { scope: 'history', path: blob.path, blobId: blob.oid }, collector)
      scope.scannedFiles++
    }, limits.maximumHistoryBlobBytes)
  } catch {
    collector.add('SCAN_IO_FAILURE', { scope: 'history' })
    return { ...scope, completed: false }
  }
  return scope
}

async function scanArtifact(artifactRoot, limits, collector) {
  const scope = baseScope(true)
  scope.manifest = null
  let rootStat
  let rootReal
  try {
    rootStat = await lstat(artifactRoot)
    rootReal = await realpath(artifactRoot)
  } catch {
    collector.add('ARTIFACT_ROOT_INVALID', { scope: 'artifact' })
    return { ...scope, completed: false }
  }
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    collector.add('ARTIFACT_ROOT_INVALID', { scope: 'artifact' })
    return { ...scope, completed: false }
  }

  const files = []
  try {
    await walkPlainFiles(rootReal, '', files, collector, { entries: 0 }, limits.maximumArtifactFiles)
  } catch (error) {
    collector.add(error?.code === 'ARTIFACT_FILE_LIMIT_EXCEEDED'
      ? 'ARTIFACT_FILE_LIMIT_EXCEEDED' : 'SCAN_IO_FAILURE', { scope: 'artifact' })
    return { ...scope, completed: false }
  }
  files.sort((left, right) => compareOrdinal(left.relative, right.relative))
  scope.candidateFiles = files.length
  if (files.length > limits.maximumArtifactFiles) {
    collector.add('ARTIFACT_FILE_LIMIT_EXCEEDED', { scope: 'artifact' })
    return { ...scope, completed: false }
  }
  const folded = new Map()
  const inventory = []
  let manifestBytes = null
  for (const file of files) {
    const relative = normalizeRelativePath(file.relative)
    if (relative === null) {
      collector.add('UNSAFE_CANDIDATE_PATH', { scope: 'artifact' })
      continue
    }
    const foldedPath = relative.toLocaleLowerCase('en-US')
    if (folded.has(foldedPath) && folded.get(foldedPath) !== relative) {
      collector.add('CASE_COLLIDING_PATH', { scope: 'artifact', path: relative })
    } else {
      folded.set(foldedPath, relative)
    }
    scanPathRules(relative, 'artifact', collector)
    scanArtifactPathContract(relative, collector)
    if (file.stat.size > limits.maximumArtifactFileBytes) {
      collector.add('ARTIFACT_FILE_TOO_LARGE', { scope: 'artifact', path: relative })
      continue
    }
    scope.scannedBytes += file.stat.size
    if (scope.scannedBytes > limits.maximumArtifactBytes) {
      collector.add('ARTIFACT_TOTAL_BYTES_EXCEEDED', { scope: 'artifact' })
      return { ...scope, completed: false }
    }
    if (relative === 'artifact-manifest.json' && file.stat.size > limits.maximumManifestBytes) {
      collector.add('ARTIFACT_MANIFEST_INVALID', { scope: 'artifact', path: relative })
      continue
    }
    let bytes
    try {
      bytes = await readFile(file.absolute)
    } catch {
      collector.add('SCAN_IO_FAILURE', { scope: 'artifact', path: relative })
      continue
    }
    scanBytes(bytes, { scope: 'artifact', path: relative }, collector)
    scope.scannedFiles++
    if (relative === 'artifact-manifest.json') {
      manifestBytes = bytes
    } else {
      inventory.push({ path: relative, length: bytes.length, sha256: sha256(bytes) })
    }
  }
  const manifestResult = verifyArtifactManifest(manifestBytes, inventory, limits)
  if (!manifestResult.valid) {
    collector.add('ARTIFACT_MANIFEST_INVALID', { scope: 'artifact', path: 'artifact-manifest.json' })
  } else {
    scope.manifest = manifestResult.summary
    if (!inventory.some((file) => file.path === manifestResult.summary.entryPoint)) {
      collector.add('ARTIFACT_ENTRY_MISSING', { scope: 'artifact', path: manifestResult.summary.entryPoint })
    }
  }
  return scope
}

async function walkPlainFiles(root, relativeDirectory, files, collector, state, maximumEntries) {
  const absoluteDirectory = relativeDirectory === '' ? root : path.join(root, ...relativeDirectory.split('/'))
  const directory = await opendir(absoluteDirectory)
  const entries = []
  for await (const entry of directory) {
    state.entries++
    if (state.entries > maximumEntries) {
      const error = new Error('artifact entry limit exceeded')
      error.code = 'ARTIFACT_FILE_LIMIT_EXCEEDED'
      throw error
    }
    entries.push(entry)
  }
  entries.sort((left, right) => compareOrdinal(left.name, right.name))
  for (const entry of entries) {
    const relative = relativeDirectory === '' ? entry.name : `${relativeDirectory}/${entry.name}`
    const normalized = normalizeRelativePath(relative)
    if (normalized === null) {
      collector.add('UNSAFE_CANDIDATE_PATH', { scope: 'artifact' })
      continue
    }
    const absolute = path.join(root, ...normalized.split('/'))
    const stat = await lstat(absolute)
    if (entry.isSymbolicLink() || stat.isSymbolicLink()) {
      collector.add('ARTIFACT_REDIRECTED_ENTRY', { scope: 'artifact', path: normalized })
      continue
    }
    if (entry.isDirectory() && stat.isDirectory()) {
      const resolved = await realpath(absolute)
      if (!pathWithin(resolved, root)) {
        collector.add('ARTIFACT_REDIRECTED_ENTRY', { scope: 'artifact', path: normalized })
      } else {
        await walkPlainFiles(root, normalized, files, collector, state, maximumEntries)
      }
    } else if (entry.isFile() && stat.isFile()) {
      const resolved = await realpath(absolute)
      if (!pathWithin(resolved, root)) {
        collector.add('ARTIFACT_REDIRECTED_ENTRY', { scope: 'artifact', path: normalized })
      } else {
        files.push({ relative: normalized, absolute, stat })
      }
    } else {
      collector.add('ARTIFACT_REDIRECTED_ENTRY', { scope: 'artifact', path: normalized })
    }
  }
}

function scanPathRules(relativePath, scope, collector, blobId = undefined) {
  const lower = relativePath.toLocaleLowerCase('en-US')
  const segments = lower.split('/')
  const name = segments.at(-1)
  const extension = path.posix.extname(lower)
  const identity = { scope, path: relativePath, blobId }
  if (name === '.env' || name.startsWith('.env.')) collector.add('FORBIDDEN_ENV_FILE', identity)
  if (['id_rsa', 'id_ed25519', 'credentials.json', 'credentials.xml', '.netrc', '_netrc'].includes(name)
      || ['.pem', '.pfx', '.p12', '.key', '.kdbx'].includes(extension)) {
    collector.add('FORBIDDEN_CREDENTIAL_FILE', identity)
  }
  if (['.dsv', '.server'].includes(extension)) collector.add('FORBIDDEN_SAVE_FILE', identity)
  if (extension === '.log' || name.endsWith('.log.txt')) collector.add('FORBIDDEN_LOG_FILE', identity)
  if (['players.json', 'player-snapshot.json', 'player-roster.json', 'roster.json', 'players.csv'].includes(name)) {
    collector.add('FORBIDDEN_PLAYER_DATA', identity)
  }
  if (['.bak', '.backup', '.dump', '.sql.gz'].includes(extension)
      || segments.some((segment) => ['backup', 'backups', 'snapshot', 'snapshots'].includes(segment))) {
    collector.add('FORBIDDEN_BACKUP_PATH', identity)
  }
  if (segments.some((segment) => ['steam', '.steam', 'steamapps', 'userdata'].includes(segment))
      || ['loginusers.vdf', 'config.vdf', 'registry.vdf'].includes(name) || /^ssfn\d+$/i.test(name)) {
    collector.add('FORBIDDEN_STEAM_STATE', identity)
  }
  if (imageExtensions.has(extension)) collector.add('IMAGE_REVIEW_REQUIRED', identity)
}

function scanArtifactPathContract(relativePath, collector) {
  if (relativePath === 'artifact-manifest.json') return
  const lower = relativePath.toLocaleLowerCase('en-US')
  const segments = lower.split('/')
  const allowed = lower === 'license' || lower.startsWith('license.')
    || lower === 'notice' || lower.startsWith('notice.')
    || lower === 'apps/api/package.json' || lower === 'apps/api/package-lock.json'
    || lower.startsWith('apps/api/dist/') || lower.startsWith('apps/api/node_modules/')
    || lower.startsWith('apps/web/dist/') || lower.startsWith('scripts/windows/')
    || artifactExactAllowedPaths.has(lower)
  const nodeModuleIndex = segments.indexOf('node_modules')
  const nodeModulesAllowed = nodeModuleIndex < 0
    || (segments.length >= 4 && segments[0] === 'apps' && segments[1] === 'api' && segments[2] === 'node_modules')
  if (!allowed || !nodeModulesAllowed
      || ['.git', 'data', 'logs', 'runtime', 'userdata', 'server', 'steam', 'steamapps', 'coverage', 'screenshots'].includes(segments[0])) {
    collector.add('ARTIFACT_PATH_NOT_ALLOWED', { scope: 'artifact', path: relativePath })
  }
}

function scanBytes(bytes, identity, collector) {
  const extension = identity.path === undefined ? '' : path.posix.extname(identity.path.toLocaleLowerCase('en-US'))
  const imageKind = detectImageKind(bytes, extension)
  const imageBlocked = imageKind !== null && scanImageMetadata(bytes, imageKind, identity, collector)

  let text = null
  try {
    if (!bytes.subarray(0, Math.min(bytes.length, 8_192)).includes(0)) text = utf8Decoder.decode(bytes)
  } catch {
    text = null
  }
  if (text !== null) {
    if (!imageBlocked) scanText(text, identity, collector)
    return
  }

  const expectedText = identity.path !== undefined && textExtensions.has(extension)
  if (expectedText) collector.add('TEXT_DECODING_FAILED', identity)
  if (identity.scope === 'history' && imageKind === null) collector.add('HISTORY_BINARY_UNPARSABLE', identity)
  if (identity.scope === 'worktree' && imageKind === null && !reviewableBinaryExtensions.has(extension)) {
    collector.add('UNREVIEWABLE_BINARY', identity)
  }
  if (!imageBlocked) scanBinaryText(bytes, identity, collector)
}

function scanText(text, identity, collector) {
  // Locked production dependencies legitimately contain public project URLs,
  // private-address examples, path parser fixtures, and low-entropy password
  // examples. Treating those generic tokens as operator data makes every real
  // npm artifact unpublishable. The vendor policy below suppresses only those
  // broad example classes for artifact node_modules. Path rules, manifest
  // integrity, private keys, known credentials, database URLs, high-entropy
  // assignments, explicit endpoint fields, Steam/player data, and binary string
  // extraction remain active.
  const vendoredArtifact = isVendoredArtifactPath(identity)
  if (privateKeyPattern.test(text)) collector.add('PRIVATE_KEY_MATERIAL', identity)
  privateKeyPattern.lastIndex = 0
  if (hasKnownCredential(text)) collector.add('KNOWN_CREDENTIAL_PATTERN', identity)
  if (connectionStringPattern.test(text)) collector.add('DATABASE_CONNECTION_STRING', identity)
  connectionStringPattern.lastIndex = 0
  if (identity.path?.toLocaleLowerCase('en-US').endsWith('.json')) {
    try {
      if (containsPlayerDataRecord(JSON.parse(text))) collector.add('PLAYER_DATA_RECORD', identity)
    } catch {
      // Non-JSON text with a .json suffix is handled by the artifact manifest
      // verifier or its owning parser. Content hygiene rules still run below.
    }
  }

  if (!vendoredArtifact) {
    for (const match of text.matchAll(ipv4Pattern)) {
      if (isPrivateIpv4(match.groups.address)) collector.add('PRIVATE_IP_ADDRESS', identity)
    }
    if (/(?:^|[^0-9a-f])f[cd][0-9a-f]{2}:[0-9a-f:]+/i.test(text)
        || /(?:^|[^0-9a-f])fe[89ab][0-9a-f]:[0-9a-f:]+/i.test(text)) {
      collector.add('PRIVATE_IP_ADDRESS', identity)
    }
    for (const match of text.matchAll(uncPattern)) {
      if (!containsFictionalMarker(match.groups.path)) collector.add('UNC_PATH', identity)
    }
    for (const match of text.matchAll(windowsUserPath)) {
      if (!isFictionalName(match.groups.user)) collector.add('USER_ABSOLUTE_PATH', identity)
    }
    for (const match of text.matchAll(posixUserPath)) {
      if (!isFictionalName(match.groups.user)) collector.add('USER_ABSOLUTE_PATH', identity)
    }
  }
  if (steamId64Pattern.test(text) || steamLegacyPattern.test(text) || steamAccountPattern.test(text)) {
    collector.add('STEAM_IDENTIFIER', identity)
  }
  steamId64Pattern.lastIndex = 0
  steamLegacyPattern.lastIndex = 0
  steamAccountPattern.lastIndex = 0

  if (!vendoredArtifact) {
    for (const match of text.matchAll(urlPattern)) {
      if (containsTemplateMarker(match[0])) continue
      const host = safeUrlHost(match[0])
      if (host === null) {
        if (!containsTemplateMarker(match[0])) collector.add('PRODUCTION_ENDPOINT', identity)
      } else {
        if (!isSafePublicHost(host)) collector.add('PRODUCTION_ENDPOINT', identity)
        try {
          const parsed = new URL(match[0])
          if ((parsed.username !== '' || parsed.password !== '') && !isSafePlaceholder(parsed.password)) {
            collector.add('SECRET_LITERAL_ASSIGNMENT', identity)
          }
        } catch {
          collector.add('PRODUCTION_ENDPOINT', identity)
        }
      }
    }
  }
  for (const match of text.matchAll(endpointAssignment)) {
    if (vendoredArtifact && !vendoredEndpointKeys.has(match.groups.key.toLocaleLowerCase('en-US'))) continue
    const candidate = match.groups.value.trim()
    const host = candidate.includes('://') ? safeUrlHost(candidate) : candidate.split(':')[0]
    if (host !== null && looksLikeHost(host) && !isSafePublicHost(host)) {
      collector.add('PRODUCTION_ENDPOINT', identity)
    }
  }
  if (!vendoredArtifact) {
    for (const match of text.matchAll(hostnameLiteralPattern)) {
      if (!isSafePublicHost(match.groups.host)) collector.add('PRODUCTION_ENDPOINT', identity)
    }
  }

  const assignments = [
    ...collectMatches(text, quotedSecretAssignment),
    ...collectMatches(text, environmentSecretAssignment),
    ...collectMatches(text, iniSecretAssignment)
  ]
  for (const match of assignments) {
    if (!isSecretBearingKey(match.groups.key)) continue
    const value = match.groups.value.trim()
    if (isSafePlaceholder(value)) continue
    const highEntropy = isHighEntropy(value)
    if (!vendoredArtifact || highEntropy) collector.add('SECRET_LITERAL_ASSIGNMENT', identity)
    if (highEntropy) collector.add('HIGH_ENTROPY_SECRET_ASSIGNMENT', identity)
  }
}

function isVendoredArtifactPath(identity) {
  return identity.scope === 'artifact' && typeof identity.path === 'string'
    && identity.path.startsWith('apps/api/node_modules/')
}

function scanImageMetadata(bytes, kind, identity, collector) {
  let blocked = false
  try {
    if (kind === 'png') {
      let offset = 8
      let ended = false
      while (offset + 12 <= bytes.length) {
        const length = bytes.readUInt32BE(offset)
        const end = offset + 12 + length
        if (end > bytes.length) throw new Error('invalid png')
        const chunk = bytes.toString('ascii', offset + 4, offset + 8)
        if (['tEXt', 'zTXt', 'iTXt', 'eXIf', 'iCCP', 'caBX', 'meTa', 'exIf'].includes(chunk)) {
          collector.add('IMAGE_EMBEDDED_METADATA', identity)
          blocked = true
        }
        offset = end
        if (chunk === 'IEND') { ended = true; break }
      }
      if (!ended) throw new Error('invalid png')
    } else if (kind === 'jpeg') {
      let offset = 2
      while (offset + 4 <= bytes.length) {
        if (bytes[offset] !== 0xff) throw new Error('invalid jpeg')
        const marker = bytes[offset + 1]
        if (marker === 0xd9 || marker === 0xda) break
        if (marker >= 0xd0 && marker <= 0xd7) { offset += 2; continue }
        const length = bytes.readUInt16BE(offset + 2)
        if (length < 2 || offset + 2 + length > bytes.length) throw new Error('invalid jpeg')
        if ([0xe1, 0xe2, 0xeb, 0xed, 0xfe].includes(marker)) {
          collector.add('IMAGE_EMBEDDED_METADATA', identity)
          blocked = true
        }
        offset += 2 + length
      }
    } else if (kind === 'webp') {
      let offset = 12
      while (offset + 8 <= bytes.length) {
        const chunk = bytes.toString('ascii', offset, offset + 4)
        const length = bytes.readUInt32LE(offset + 4)
        if (offset + 8 + length > bytes.length) throw new Error('invalid webp')
        if (['EXIF', 'XMP ', 'ICCP', 'C2PA'].includes(chunk)) {
          collector.add('IMAGE_EMBEDDED_METADATA', identity)
          blocked = true
        }
        offset += 8 + length + (length % 2)
      }
    } else if (kind === 'svg') {
      const text = utf8Decoder.decode(bytes)
      if (/<metadata\b|\b(?:inkscape|sodipodi|rdf):/i.test(text)) {
        collector.add('IMAGE_EMBEDDED_METADATA', identity)
        blocked = true
      }
    }
  } catch {
    collector.add('IMAGE_CONTAINER_INVALID', identity)
    blocked = true
  }
  return blocked
}

function verifyArtifactManifest(manifestBytes, inventory, limits) {
  if (manifestBytes === null || manifestBytes.length > limits.maximumManifestBytes) return { valid: false }
  let manifest
  try {
    manifest = JSON.parse(utf8Decoder.decode(manifestBytes))
  } catch {
    return { valid: false }
  }
  const expectedKeys = [
    'dependencyInstall', 'dependencyPruning', 'devDependenciesExcluded', 'entryPoint', 'fileCount', 'files',
    'nodeMinimumMajor', 'payloadSha256', 'protocol', 'totalBytes', 'version'
  ]
  if (!isPlainObject(manifest) || !sameOrderedValues(Object.keys(manifest).sort(compareOrdinal), expectedKeys)) return { valid: false }
  if (manifest.protocol !== 'DYSON_CONTROL_RELEASE_ARTIFACT_V1'
      || !/^[0-9A-Za-z][0-9A-Za-z._+-]{0,63}$/.test(manifest.version)
      || manifest.entryPoint !== 'apps/api/dist/index.js'
      || manifest.nodeMinimumMajor !== 24
      || manifest.dependencyInstall !== 'npm-ci-omit-dev-ignore-scripts'
      || manifest.dependencyPruning !== 'non-runtime-package-content-v1'
      || !/^[0-9a-f]{64}$/.test(manifest.payloadSha256)
      || !Number.isSafeInteger(manifest.fileCount) || manifest.fileCount < 1
      || !Number.isSafeInteger(manifest.totalBytes) || manifest.totalBytes < 1
      || !Array.isArray(manifest.files) || !Array.isArray(manifest.devDependenciesExcluded)
      || manifest.devDependenciesExcluded.length > 256) return { valid: false }

  const dependencies = manifest.devDependenciesExcluded
  if (!dependencies.every((value) => typeof value === 'string' && /^(?:@[a-z0-9_.-]+\/)?[a-z0-9_.-]+$/.test(value))
      || !strictlySortedUnique(dependencies)) return { valid: false }
  const expectedFiles = []
  const folded = new Set()
  for (const entry of manifest.files) {
    if (!isPlainObject(entry) || !sameOrderedValues(Object.keys(entry).sort(compareOrdinal), ['length', 'path', 'sha256'])
        || normalizeRelativePath(entry.path) !== entry.path
        || !Number.isSafeInteger(entry.length) || entry.length < 0
        || typeof entry.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(entry.sha256)) return { valid: false }
    const foldedPath = entry.path.toLocaleLowerCase('en-US')
    if (folded.has(foldedPath)) return { valid: false }
    folded.add(foldedPath)
    expectedFiles.push({ path: entry.path, length: entry.length, sha256: entry.sha256 })
  }
  if (!strictlySortedUnique(expectedFiles.map((entry) => entry.path))) return { valid: false }
  if (manifest.fileCount !== inventory.length || manifest.totalBytes !== inventory.reduce((sum, entry) => sum + entry.length, 0)
      || !sameOrderedValues(expectedFiles, inventory)) return { valid: false }
  const canonical = inventory.map((entry) => `${entry.path}|${entry.length}|${entry.sha256}`).join('\n')
  if (sha256(Buffer.from(canonical, 'utf8')) !== manifest.payloadSha256) return { valid: false }
  return {
    valid: true,
    summary: {
      protocol: manifest.protocol,
      version: manifest.version,
      entryPoint: manifest.entryPoint,
      payloadSha256: manifest.payloadSha256,
      manifestSha256: sha256(manifestBytes),
      fileCount: manifest.fileCount,
      totalBytes: manifest.totalBytes
    }
  }
}

async function readGitBlobBatch(repositoryRoot, blobs, onBlob, maximumBlobBytes) {
  if (blobs.length === 0) return
  // Each blob is already bounded before this point. Reading one object per
  // invocation keeps peak memory bounded and avoids buffering the total history.
  for (const blob of blobs) {
    const bytes = await runGit(repositoryRoot, ['cat-file', 'blob', blob.oid], maximumBlobBytes + 1)
    if (bytes.length !== blob.size) throw new Error('git blob length mismatch')
    onBlob(blob, bytes)
  }
}

async function runGit(repositoryRoot, args, maximumBytes, allowMissing = false, input = undefined) {
  const invocation = gitInvocation(repositoryRoot, args)
  try {
    if (input !== undefined) {
      return await spawnWithBoundedOutput('git', invocation.args, invocation.cwd, input, maximumBytes)
    }
    const result = await execFileAsync('git', invocation.args, {
      cwd: invocation.cwd,
      windowsHide: true,
      encoding: 'buffer',
      maxBuffer: maximumBytes
    })
    return Buffer.isBuffer(result.stdout) ? result.stdout : Buffer.from(result.stdout)
  } catch (error) {
    if (allowMissing && error?.code === 128) return Buffer.alloc(0)
    throw error
  }
}

function gitInvocation(repositoryRoot, args) {
  const safeDirectory = repositoryRoot.replaceAll('\\', '/')
  const isWindowsUnc = process.platform === 'win32' && repositoryRoot.startsWith('\\\\')
  return {
    cwd: isWindowsUnc ? path.parse(process.execPath).root : repositoryRoot,
    args: ['-c', `safe.directory=${safeDirectory}`, '-C', repositoryRoot, ...args]
  }
}

function spawnWithBoundedOutput(executable, args, cwd, input, maximumBytes) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { cwd, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
    const output = []
    let outputBytes = 0
    let failed = false
    const rejectOnce = (error) => {
      if (failed) return
      failed = true
      child.kill()
      reject(error)
    }
    child.once('error', rejectOnce)
    child.stdout.on('data', (chunk) => {
      outputBytes += chunk.length
      if (outputBytes > maximumBytes) {
        rejectOnce(new Error('bounded process output exceeded'))
      } else {
        output.push(chunk)
      }
    })
    // Never surface stderr: it can contain a host path supplied by Git.
    child.stderr.resume()
    child.once('close', (code) => {
      if (failed) return
      if (code !== 0) rejectOnce(new Error('bounded process failed'))
      else resolve(Buffer.concat(output, outputBytes))
    })
    child.stdin.once('error', rejectOnce)
    child.stdin.end(input)
  })
}

function createFindingCollector() {
  const found = new Map()
  let allowlisted = 0
  return {
    add(ruleId, identity = {}) {
      if (!policyRuleIds.has(ruleId)) throw new Error('unknown hygiene rule')
      const pathValue = identity.path === undefined ? undefined : normalizeRelativePath(identity.path)
      const blobId = identity.blobId === undefined ? undefined : normalizeObjectId(identity.blobId)
      const scope = identity.scope ?? 'worktree'
      if (pathValue !== undefined && pathValue !== null
          && (exactAllowlist.has(allowlistKey(scope, ruleId, pathValue))
            || (blobId !== undefined && blobId !== null
              && exactAllowlist.has(allowlistKey(scope, ruleId, pathValue, blobId))))) {
        allowlisted++
        return
      }
      const finding = { ruleId }
      if (pathValue !== undefined && pathValue !== null) finding.path = pathValue
      if (blobId !== undefined && blobId !== null) finding.blobId = blobId
      const key = `${ruleId}\0${finding.path ?? ''}\0${finding.blobId ?? ''}`
      found.set(key, finding)
    },
    findings() {
      return [...found.values()].sort((left, right) => compareOrdinal(
        `${left.ruleId}\0${left.path ?? ''}\0${left.blobId ?? ''}`,
        `${right.ruleId}\0${right.path ?? ''}\0${right.blobId ?? ''}`
      ))
    },
    allowlistedMatchCount() { return allowlisted }
  }
}

function evidenceForRepositoryFailure(history, artifact) {
  return {
    protocol: 'DYSON_PUBLIC_RELEASE_HYGIENE_V1',
    policy: { id: POLICY_ID, version: POLICY_VERSION, sha256: POLICY_SHA256 },
    passed: false,
    repository: { available: false, headCommit: null, headTree: null, dirty: true },
    scopes: {
      worktree: { ...baseScope(true), completed: false },
      history: history ? { ...baseScope(true), completed: false } : disabledScope(),
      artifact: artifact ? { ...baseScope(true), completed: false, manifest: null } : disabledScope()
    },
    totals: { scannedFiles: 0, scannedBytes: 0, findingCount: 1, allowlistedMatchCount: 0 },
    findings: [{ ruleId: 'SCAN_IO_FAILURE' }]
  }
}

function baseScope(requested) {
  return { requested, completed: true, candidateFiles: 0, scannedFiles: 0, scannedBytes: 0 }
}

function disabledScope() {
  return { requested: false, completed: false, candidateFiles: 0, scannedFiles: 0, scannedBytes: 0 }
}

function normalizeRelativePath(value) {
  if (typeof value !== 'string' || value.length < 1 || value.length > 1_024 || value.includes('\0')
      || value.includes('\\') || value.startsWith('/') || /^[A-Za-z]:/.test(value)) return null
  const normalized = path.posix.normalize(value)
  if (normalized !== value || normalized === '.' || normalized === '..' || normalized.startsWith('../')
      || value.split('/').some((segment) => segment.length === 0 || segment === '.' || segment === '..')) return null
  return normalized
}

function normalizeObjectId(value) {
  return typeof value === 'string' && /^[0-9a-f]{40,64}$/.test(value) ? value : null
}

function pathWithin(candidate, parent) {
  const relative = path.relative(parent, candidate)
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))
}

function detectImageKind(bytes, extension) {
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'png'
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xd8) return 'jpeg'
  if (bytes.length >= 12 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') return 'webp'
  if (extension === '.svg') return 'svg'
  return null
}

function scanBinaryText(bytes, identity, collector) {
  const chunkBytes = 1_048_576
  const overlapBytes = 8_192
  for (let offset = 0; offset < bytes.length; offset += chunkBytes) {
    const start = Math.max(0, offset - overlapBytes)
    const end = Math.min(bytes.length, offset + chunkBytes)
    const chunk = bytes.subarray(start, end)
    const ascii = chunk.toString('latin1').replace(/[^\x09\x0a\x0d\x20-\x7e]+/g, '\n')
    const evenLength = chunk.length - (chunk.length % 2)
    const utf16 = chunk.subarray(0, evenLength).toString('utf16le')
      .replace(/[^\x09\x0a\x0d\x20-\x7e]+/g, '\n')
    scanText(`${ascii}\n${utf16}`, identity, collector)
  }
}

function splitNullRecords(bytes) {
  const records = []
  let start = 0
  for (let index = 0; index < bytes.length; index++) {
    if (bytes[index] !== 0) continue
    if (index > start) records.push(bytes.subarray(start, index))
    start = index + 1
  }
  if (start < bytes.length) records.push(bytes.subarray(start))
  return records
}

function hasKnownCredential(text) {
  const patterns = [
    /\bgh[pousr]_[A-Za-z0-9_]{24,255}\b/,
    /\bgithub_pat_[A-Za-z0-9_]{20,255}\b/,
    /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/,
    /\bxox[baprs]-[A-Za-z0-9-]{16,255}\b/,
    /\bsk-(?:live-)?[A-Za-z0-9_-]{20,255}\b/,
    /\bAIza[0-9A-Za-z_-]{35}\b/,
    /\bsk_live_[0-9A-Za-z]{20,255}\b/,
    /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/
  ]
  return patterns.some((pattern) => pattern.test(text))
}

function isPrivateIpv4(value) {
  const parts = value.split('.').map(Number)
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false
  if (parts[0] === 127 || parts[0] === 0) return false
  if (parts[0] === 192 && parts[1] === 0 && parts[2] === 2) return false
  if (parts[0] === 198 && parts[1] === 51 && parts[2] === 100) return false
  if (parts[0] === 203 && parts[1] === 0 && parts[2] === 113) return false
  return parts[0] === 10 || (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31)
    || (parts[0] === 192 && parts[1] === 168) || (parts[0] === 169 && parts[1] === 254)
}

function isSafePublicHost(rawHost) {
  const host = rawHost.replace(/^\[|\]$/g, '').toLocaleLowerCase('en-US').replace(/\.$/, '')
  if (host === 'localhost' || host === '::1' || host === '2001:db8'
      || host.endsWith('.example.com') || host === 'example.com'
      || host.endsWith('.example') || host.endsWith('.invalid') || host.endsWith('.test')) return true
  if (ipv4Pattern.test(host)) {
    ipv4Pattern.lastIndex = 0
    const parts = host.split('.').map(Number)
    return parts[0] === 127 || (parts[0] === 192 && parts[1] === 0 && parts[2] === 2)
      || (parts[0] === 198 && parts[1] === 51 && parts[2] === 100)
      || (parts[0] === 203 && parts[1] === 0 && parts[2] === 113)
  }
  ipv4Pattern.lastIndex = 0
  return publicReferenceHosts.has(host)
}

function safeUrlHost(value) {
  try { return new URL(value).hostname } catch { return null }
}

function looksLikeHost(value) {
  return /^(?:[A-Za-z0-9-]+\.)+[A-Za-z]{2,63}$/.test(value) || /^(?:\d{1,3}\.){3}\d{1,3}$/.test(value)
}

function isSafePlaceholder(value) {
  const normalized = value.trim().replace(/^['"]|['"]$/g, '').toLocaleLowerCase('en-US')
  if (normalized === '' || ['null', 'undefined', 'true', 'false', 'include', 'omit', 'same-origin'].includes(normalized)) return true
  if (normalized.includes('${') || normalized.includes('<') || normalized.includes('...')) return true
  return [
    'fictional', 'fixture', 'example', 'test-', '-test', 'placeholder', 'redacted', 'do-not', 'should-never', 'change-this',
    'not-a-real', 'local-demo', 'development-only', 'at-least', 'random-characters', 'choose-a-local-test'
  ].some((marker) => normalized.includes(marker))
}

function isSecretBearingKey(value) {
  const key = value.toLocaleLowerCase('en-US')
  if (/(?:file|path|name|status|storage|boundary|present|removed|passed|calls|invalid|enabled|rejected|content|text|cookie)$/.test(key)) {
    return false
  }
  if (key === 'credentials') return false
  return true
}

function containsTemplateMarker(value) {
  return value.includes('$') || value.includes('<') || value.includes('{{')
}

function containsPlayerDataRecord(root) {
  const pending = [{ value: root, depth: 0 }]
  let visited = 0
  while (pending.length > 0) {
    const current = pending.pop()
    if (++visited > 100_000 || current.depth > 32) return true
    if (current.value === null || typeof current.value !== 'object') continue
    if (Array.isArray(current.value)) {
      for (const value of current.value) pending.push({ value, depth: current.depth + 1 })
      continue
    }
    const keys = new Set(Object.keys(current.value).map((key) => key.toLocaleLowerCase('en-US')))
    if (['steamid', 'steamid64', 'steamaccountid', 'steamtoken'].some((key) => keys.has(key))) return true
    if (keys.has('displayname') && ['sessionplayerid', 'joinedat', 'joinedatunixms', 'online', 'location']
      .some((key) => keys.has(key))) {
      const displayNameKey = Object.keys(current.value).find((key) => key.toLocaleLowerCase('en-US') === 'displayname')
      const displayName = displayNameKey === undefined ? null : current.value[displayNameKey]
      if (typeof displayName !== 'string' || !containsFictionalMarker(displayName)) return true
    }
    for (const value of Object.values(current.value)) pending.push({ value, depth: current.depth + 1 })
  }
  return false
}

function isHighEntropy(value) {
  if (value.length < 20 || value.length > 512 || /\s/.test(value)) return false
  const counts = new Map()
  for (const character of value) counts.set(character, (counts.get(character) ?? 0) + 1)
  let entropy = 0
  for (const count of counts.values()) {
    const probability = count / value.length
    entropy -= probability * Math.log2(probability)
  }
  return entropy >= 3.5
}

function collectMatches(text, pattern) {
  pattern.lastIndex = 0
  const matches = [...text.matchAll(pattern)]
  pattern.lastIndex = 0
  return matches
}

function containsFictionalMarker(value) {
  return /(?:fictional|example|test-host|invalid)/i.test(value)
}

function isFictionalName(value) {
  return /^(?:fictional|example|test|user|username|sample)(?:[-_.].*)?$/i.test(value)
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
}

function strictlySortedUnique(values) {
  return values.every((value, index) => index === 0 || compareOrdinal(values[index - 1], value) < 0)
}

function sameOrderedValues(left, right) {
  return JSON.stringify(left) === JSON.stringify(right)
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

function allowlistKey(scope, ruleId, relativePath, blobId) {
  return `${scope}\0${ruleId}\0${relativePath}\0${blobId ?? ''}`
}

function compareOrdinal(left, right) {
  return left < right ? -1 : left > right ? 1 : 0
}

export function canonicalEvidenceJson(evidence) {
  return `${JSON.stringify(evidence, null, 2)}\n`
}

export function buildArtifactManifestForFixture(files, version = '1.0.0-fixture') {
  const inventory = [...files].sort((left, right) => compareOrdinal(left.path, right.path)).map((file) => ({
    path: file.path,
    length: file.bytes.length,
    sha256: sha256(file.bytes)
  }))
  const canonical = inventory.map((entry) => `${entry.path}|${entry.length}|${entry.sha256}`).join('\n')
  return {
    protocol: 'DYSON_CONTROL_RELEASE_ARTIFACT_V1',
    version,
    entryPoint: 'apps/api/dist/index.js',
    nodeMinimumMajor: 24,
    dependencyInstall: 'npm-ci-omit-dev-ignore-scripts',
    dependencyPruning: 'non-runtime-package-content-v1',
    devDependenciesExcluded: [],
    payloadSha256: sha256(Buffer.from(canonical, 'utf8')),
    fileCount: inventory.length,
    totalBytes: inventory.reduce((sum, entry) => sum + entry.length, 0),
    files: inventory
  }
}
