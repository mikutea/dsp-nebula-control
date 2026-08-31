import { createHash } from 'node:crypto'

export const POLICY_ID = 'dyson-public-release-hygiene'
export const POLICY_VERSION = '1.2.0'

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
  { scope: 'worktree', ruleId: 'SECRET_LITERAL_ASSIGNMENT', path: 'apps/api/src/update-pipeline/http.test.ts' },
  { scope: 'worktree', ruleId: 'SECRET_LITERAL_ASSIGNMENT', path: 'scripts/public-release/scanner.mjs' },
  { scope: 'worktree', ruleId: 'SECRET_LITERAL_ASSIGNMENT', path: 'scripts/public-release/scanner.test.mjs' },
  { scope: 'worktree', ruleId: 'STEAM_IDENTIFIER', path: 'apps/api/src/console/parser.test.ts' },
  { scope: 'worktree', ruleId: 'UNC_PATH', path: 'apps/api/src/client-profile/generator.test.ts' },
  { scope: 'worktree', ruleId: 'UNC_PATH', path: 'scripts/public-release/scanner.mjs' },
  { scope: 'worktree', ruleId: 'USER_ABSOLUTE_PATH', path: 'apps/api/src/update-pipeline/activation-http.test.ts' }
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

export const POLICY_SHA256 = createHash('sha256').update(JSON.stringify({
  id: POLICY_ID,
  version: POLICY_VERSION,
  rules: RULE_IDS,
  allowlist: EXACT_ALLOWLIST,
  publicReferenceHosts: PUBLIC_REFERENCE_HOSTS,
  limits: DEFAULT_LIMITS
})).digest('hex')
