import { createHash } from 'node:crypto'

export const POLICY_ID = 'dyson-public-release-hygiene'
export const POLICY_VERSION = '1.4.1'

export const DEFAULT_LIMITS = Object.freeze({
  maximumWorktreeFiles: 50_000,
  maximumWorktreeBytes: 1_073_741_824,
  maximumWorktreeFileBytes: 67_108_864,
  maximumHistoryObjects: 100_000,
  maximumHistoryBlobs: 50_000,
  maximumHistoryBytes: 536_870_912,
  maximumHistoryBlobBytes: 8_388_608,
  maximumArtifactFiles: 50_000,
  maximumArtifactBytes: 2_147_483_648,
  maximumArtifactFileBytes: 134_217_728,
  maximumManifestBytes: 33_554_432,
  maximumGitOutputBytes: 33_554_432
})

export const RULE_IDS = Object.freeze([
  'ARTIFACT_ENTRY_MISSING',
  'ARTIFACT_FILE_LIMIT_EXCEEDED',
  'ARTIFACT_FILE_TOO_LARGE',
  'ARTIFACT_MANIFEST_INVALID',
  'ARTIFACT_PATH_NOT_ALLOWED',
  'ARTIFACT_REDIRECTED_ENTRY',
  'ARTIFACT_ROOT_INVALID',
  'ARTIFACT_TOTAL_BYTES_EXCEEDED',
  'CASE_COLLIDING_PATH',
  'DATABASE_CONNECTION_STRING',
  'FORBIDDEN_BACKUP_PATH',
  'FORBIDDEN_CREDENTIAL_FILE',
  'FORBIDDEN_ENV_FILE',
  'FORBIDDEN_LOG_FILE',
  'FORBIDDEN_PLAYER_DATA',
  'FORBIDDEN_SAVE_FILE',
  'FORBIDDEN_STEAM_STATE',
  'HIGH_ENTROPY_SECRET_ASSIGNMENT',
  'HISTORY_BINARY_UNPARSABLE',
  'HISTORY_BLOB_LIMIT_EXCEEDED',
  'HISTORY_BLOB_TOO_LARGE',
  'HISTORY_OBJECT_LIMIT_EXCEEDED',
  'HISTORY_TOTAL_BYTES_EXCEEDED',
  'IMAGE_CONTAINER_INVALID',
  'IMAGE_EMBEDDED_METADATA',
  'IMAGE_REVIEW_REQUIRED',
  'KNOWN_CREDENTIAL_PATTERN',
  'PRIVATE_IP_ADDRESS',
  'PRIVATE_KEY_MATERIAL',
  'PLAYER_DATA_RECORD',
  'PRODUCTION_ENDPOINT',
  'REPOSITORY_DIRTY',
  'SCAN_IO_FAILURE',
  'SECRET_LITERAL_ASSIGNMENT',
  'STEAM_IDENTIFIER',
  'TEXT_DECODING_FAILED',
  'UNC_PATH',
  'UNREVIEWABLE_BINARY',
  'UNSAFE_CANDIDATE_PATH',
  'USER_ABSOLUTE_PATH',
  'WORKTREE_ENTRY_MISSING',
  'WORKTREE_FILE_LIMIT_EXCEEDED',
  'WORKTREE_FILE_TOO_LARGE',
  'WORKTREE_REDIRECTED_ENTRY',
  'WORKTREE_TOTAL_BYTES_EXCEEDED'
].sort())

/**
 * Suppressions are deliberately exact triples. A new path, rule, or scope must
 * be reviewed independently; prefixes and glob expressions are not accepted.
 */
export const EXACT_ALLOWLIST = Object.freeze([
  { scope: 'worktree', ruleId: 'FORBIDDEN_ENV_FILE', path: '.env.example' },
  { scope: 'history', ruleId: 'FORBIDDEN_ENV_FILE', path: '.env.example' },
  { scope: 'worktree', ruleId: 'IMAGE_REVIEW_REQUIRED', path: 'design/dashboard-concept-dsp-inspired-v2.png' },
  { scope: 'worktree', ruleId: 'IMAGE_REVIEW_REQUIRED', path: 'design/dashboard-concept-v1.png' },
  { scope: 'worktree', ruleId: 'IMAGE_REVIEW_REQUIRED', path: 'design/dashboard-implementation-dsp-inspired-v2.png' },
  { scope: 'worktree', ruleId: 'IMAGE_REVIEW_REQUIRED', path: 'design/dashboard-implementation-v1.png' },
  { scope: 'worktree', ruleId: 'IMAGE_REVIEW_REQUIRED', path: 'design/game-lifecycle-preflight-desktop.png' },
  { scope: 'history', ruleId: 'IMAGE_REVIEW_REQUIRED', path: 'design/dashboard-concept-dsp-inspired-v2.png' },
  { scope: 'history', ruleId: 'IMAGE_REVIEW_REQUIRED', path: 'design/dashboard-concept-v1.png' },
  { scope: 'history', ruleId: 'IMAGE_REVIEW_REQUIRED', path: 'design/dashboard-implementation-dsp-inspired-v2.png' },
  { scope: 'history', ruleId: 'IMAGE_REVIEW_REQUIRED', path: 'design/dashboard-implementation-v1.png' },
  { scope: 'history', ruleId: 'IMAGE_REVIEW_REQUIRED', path: 'design/game-lifecycle-preflight-desktop.png' },
  {
    scope: 'history',
    ruleId: 'IMAGE_EMBEDDED_METADATA',
    path: 'design/dashboard-concept-dsp-inspired-v2.png',
    blobId: '6235102ad80a12e3b1e1c5ec440a6b2de9fbadbe'
  },
  {
    scope: 'history',
    ruleId: 'IMAGE_EMBEDDED_METADATA',
    path: 'design/dashboard-concept-v1.png',
    blobId: 'e5f7652e74653ca3aa1784bc10fa34e8069f9009'
  },
  { scope: 'worktree', ruleId: 'HIGH_ENTROPY_SECRET_ASSIGNMENT', path: 'scripts/public-release/scanner.mjs' },
  { scope: 'worktree', ruleId: 'SECRET_LITERAL_ASSIGNMENT', path: 'apps/api/src/config.test.ts' },
  // Fictional broker tokens are required to exercise redaction and lease-binding tests.
  { scope: 'worktree', ruleId: 'SECRET_LITERAL_ASSIGNMENT', path: 'apps/api/src/host-mutation/lease.test.ts' },
  { scope: 'worktree', ruleId: 'SECRET_LITERAL_ASSIGNMENT', path: 'apps/api/src/host-mutation/operation-coordinator.test.ts' },
  { scope: 'worktree', ruleId: 'SECRET_LITERAL_ASSIGNMENT', path: 'apps/api/src/update-pipeline/http.test.ts' },
  { scope: 'worktree', ruleId: 'SECRET_LITERAL_ASSIGNMENT', path: 'scripts/public-release/scanner.mjs' },
  { scope: 'worktree', ruleId: 'SECRET_LITERAL_ASSIGNMENT', path: 'scripts/public-release/scanner.test.mjs' },
  { scope: 'worktree', ruleId: 'STEAM_IDENTIFIER', path: 'apps/api/src/console/parser.test.ts' },
  { scope: 'worktree', ruleId: 'UNC_PATH', path: 'apps/api/src/client-profile/generator.test.ts' },
  // These sources contain protocol/extended-path syntax, not a deployment endpoint.
  { scope: 'worktree', ruleId: 'UNC_PATH', path: 'integrations/dyson-control-bridge/BridgeProtocol.cs' },
  { scope: 'worktree', ruleId: 'UNC_PATH', path: 'scripts/public-release/scanner.mjs' },
  { scope: 'worktree', ruleId: 'UNC_PATH', path: 'scripts/windows/DysonHostMutationLease.Common.ps1' },
  { scope: 'worktree', ruleId: 'USER_ABSOLUTE_PATH', path: 'apps/api/src/update-pipeline/activation-http.test.ts' },
  {
    scope: 'history',
    ruleId: 'HIGH_ENTROPY_SECRET_ASSIGNMENT',
    path: 'scripts/public-release/scanner.mjs',
    blobId: '79caf486091e9f257d3f54cf365d2ed0a1a4e013'
  },
  {
    scope: 'history',
    ruleId: 'HIGH_ENTROPY_SECRET_ASSIGNMENT',
    path: 'scripts/public-release/scanner.mjs',
    blobId: 'f9117ffbcd2c3d8636c35bccbc04d13907e678c0'
  },
  {
    scope: 'history',
    ruleId: 'SECRET_LITERAL_ASSIGNMENT',
    path: 'apps/api/src/config.test.ts',
    blobId: '718d0f9d877e2ce7ecb9c3bbac0c6552312bdb88'
  },
  {
    scope: 'history',
    ruleId: 'SECRET_LITERAL_ASSIGNMENT',
    path: 'apps/api/src/host-mutation/lease.test.ts',
    blobId: 'c3c8cc1b2f28e3eee97a91daedf243c7e9f10043'
  },
  {
    scope: 'history',
    ruleId: 'SECRET_LITERAL_ASSIGNMENT',
    path: 'apps/api/src/host-mutation/operation-coordinator.test.ts',
    blobId: '4f6c8d2e5e1762c27d8731f68ab532edb885fc8c'
  },
  {
    scope: 'history',
    ruleId: 'SECRET_LITERAL_ASSIGNMENT',
    path: 'apps/api/src/host-mutation/operation-coordinator.test.ts',
    blobId: 'e9927a52a82cc77cb1f7b970709851ed1225ae73'
  },
  {
    scope: 'history',
    ruleId: 'SECRET_LITERAL_ASSIGNMENT',
    path: 'apps/api/src/update-pipeline/http.test.ts',
    blobId: 'e6b0aff8a2499cc42fbce7bef0c77cc3bab6b4b4'
  },
  {
    scope: 'history',
    ruleId: 'SECRET_LITERAL_ASSIGNMENT',
    path: 'scripts/public-release/scanner.mjs',
    blobId: '79caf486091e9f257d3f54cf365d2ed0a1a4e013'
  },
  {
    scope: 'history',
    ruleId: 'SECRET_LITERAL_ASSIGNMENT',
    path: 'scripts/public-release/scanner.mjs',
    blobId: 'f9117ffbcd2c3d8636c35bccbc04d13907e678c0'
  },
  {
    scope: 'history',
    ruleId: 'SECRET_LITERAL_ASSIGNMENT',
    path: 'scripts/public-release/scanner.test.mjs',
    blobId: '7dd287661db2099d9ea50d04e37f7c7a89246337'
  },
  {
    scope: 'history',
    ruleId: 'SECRET_LITERAL_ASSIGNMENT',
    path: 'scripts/public-release/scanner.test.mjs',
    blobId: '8ead511c515b359e28ed7a0e327a5aec11bf2b74'
  },
  {
    scope: 'history',
    ruleId: 'STEAM_IDENTIFIER',
    path: 'apps/api/src/console/parser.test.ts',
    blobId: '87fb3d72fb77b44635f36aea8c659a1142891b55'
  },
  {
    scope: 'history',
    ruleId: 'UNC_PATH',
    path: 'apps/api/src/client-profile/generator.test.ts',
    blobId: '8b766b3ac84035a27cd15c403acad9dab9824af3'
  },
  {
    scope: 'history',
    ruleId: 'UNC_PATH',
    path: 'integrations/dyson-control-bridge/BridgeProtocol.cs',
    blobId: '83819320c349b69730967a5cd4d1e473faf6d53f'
  },
  {
    scope: 'history',
    ruleId: 'UNC_PATH',
    path: 'scripts/public-release/scanner.mjs',
    blobId: '79caf486091e9f257d3f54cf365d2ed0a1a4e013'
  },
  {
    scope: 'history',
    ruleId: 'UNC_PATH',
    path: 'scripts/public-release/scanner.mjs',
    blobId: 'f9117ffbcd2c3d8636c35bccbc04d13907e678c0'
  },
  {
    scope: 'history',
    ruleId: 'UNC_PATH',
    path: 'scripts/windows/DysonHostMutationLease.Common.ps1',
    blobId: '21be43203aff9862b83bd2d069d337a963007fb2'
  },
  {
    scope: 'history',
    ruleId: 'UNC_PATH',
    path: 'scripts/windows/DysonHostMutationLease.Common.ps1',
    blobId: 'a0c8e57e1489beba0d2b2e92c7ccbde629314d30'
  }
])

// These are the only non-runtime-tree files admitted by the release artifact
// protocol. Keep this list exact: docs/** and integrations/** are not trusted
// as categories merely because the artifact builder selected reviewed files
// from those trees.
export const ARTIFACT_EXACT_ALLOWED_PATHS = Object.freeze([
  'docs/GSM-EVALUATION.md',
  'docs/WINDOWS-DEPLOYMENT-DRAFT.md',
  'integrations/dyson-control-bridge/BridgeFileStore.cs',
  'integrations/dyson-control-bridge/BridgeProtocol.cs',
  'integrations/dyson-control-bridge/DysonControlBridge.csproj',
  'integrations/dyson-control-bridge/DysonControlBridgePlugin.cs',
  'integrations/dyson-control-bridge/GameSaveAdapter.cs',
  'integrations/dyson-control-bridge/PlayerRosterPublisher.cs',
  'integrations/dyson-control-bridge/README.md',
  'integrations/dyson-control-bridge/dyson-control-bridge.cfg.example'
])

// These are public package registries, source forges, standards bodies, and
// upstream project sites. They are policy categories, not production-host
// exceptions. Subdomains are accepted only where explicitly listed.
export const PUBLIC_REFERENCE_HOSTS = Object.freeze([
  'fsf.org',
  'api.github.com',
  'gcdn.thunderstore.io',
  'github.com',
  'objects.githubusercontent.com',
  'opencollective.com',
  'react.dev',
  'release-assets.githubusercontent.com',
  'registry.npmjs.org',
  'ca.trufo.ai',
  'ocsp.trufo.ai',
  'thunderstore.io',
  'tidelift.com',
  'trufo.ai',
  'www.gnu.org',
  'www.w3.org'
])

const allowlistKeys = new Set()
for (const entry of EXACT_ALLOWLIST) {
  if (!['worktree', 'history', 'artifact'].includes(entry.scope) || !RULE_IDS.includes(entry.ruleId)
      || !/^[A-Za-z0-9._+@/-]{1,1024}$/.test(entry.path) || entry.path.startsWith('/')
      || entry.path.includes('..') || /[*?[\]{}]/.test(entry.path)
      || (entry.blobId !== undefined && (entry.scope !== 'history' || !/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/.test(entry.blobId)))) {
    throw new Error('Public release policy contains a non-exact allowlist entry')
  }
  const key = `${entry.scope}\0${entry.ruleId}\0${entry.path}\0${entry.blobId ?? ''}`
  if (allowlistKeys.has(key)) throw new Error('Public release policy contains a duplicate allowlist entry')
  allowlistKeys.add(key)
}

const artifactPathKeys = new Set()
for (const artifactPath of ARTIFACT_EXACT_ALLOWED_PATHS) {
  if (!/^[A-Za-z0-9._+@/-]{1,1024}$/.test(artifactPath) || artifactPath.startsWith('/')
      || artifactPath.includes('..') || /[*?[\]{}]/.test(artifactPath)) {
    throw new Error('Public release policy contains a non-exact artifact path')
  }
  const key = artifactPath.toLocaleLowerCase('en-US')
  if (artifactPathKeys.has(key)) throw new Error('Public release policy contains a duplicate artifact path')
  artifactPathKeys.add(key)
}

export const POLICY_SHA256 = createHash('sha256').update(JSON.stringify({
  id: POLICY_ID,
  version: POLICY_VERSION,
  rules: RULE_IDS,
  allowlist: EXACT_ALLOWLIST,
  artifactExactAllowedPaths: ARTIFACT_EXACT_ALLOWED_PATHS,
  publicReferenceHosts: PUBLIC_REFERENCE_HOSTS,
  limits: DEFAULT_LIMITS
})).digest('hex')
