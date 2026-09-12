import { createHash } from 'node:crypto'

export const POLICY_ID = 'dyson-public-release-hygiene'
export const POLICY_VERSION = '1.4.18'

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
  // Reviewed Win32 extended-path prefix normalization, not a network endpoint.
  { scope: 'worktree', ruleId: 'UNC_PATH', path: 'scripts/windows/bootstrap/DysonStoppedSaveCapture.ps1' },
  { scope: 'artifact', ruleId: 'UNC_PATH', path: 'scripts/windows/bootstrap/DysonStoppedSaveCapture.ps1' },
  { scope: 'history', ruleId: 'UNC_PATH', path: 'scripts/windows/bootstrap/DysonStoppedSaveCapture.ps1', blobId: 'f46dcc63ad79223702099f4cab26c208c60b002e' },
  { scope: 'history', ruleId: 'SECRET_LITERAL_ASSIGNMENT', path: 'scripts/public-release/scanner.test.mjs', blobId: '643e07066dd38d982a90a0a8e54e8135b1a76311' },
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
  { scope: 'history', ruleId: 'SECRET_LITERAL_ASSIGNMENT', path: 'scripts/public-release/scanner.test.mjs', blobId: '2547f0745c68edb8bda47b1f1a37f35a90a9badc' },
  { scope: 'worktree', ruleId: 'STEAM_IDENTIFIER', path: 'apps/api/src/console/parser.test.ts' },
  { scope: 'worktree', ruleId: 'UNC_PATH', path: 'apps/api/src/client-profile/generator.test.ts' },
  // The public CSharp vector reader contains an escaped-string regex, not a network share.
  { scope: 'worktree', ruleId: 'UNC_PATH', path: 'apps/api/src/providers/windows-update-runtime-evidence.test.ts' },
  { scope: 'history', ruleId: 'UNC_PATH', path: 'apps/api/src/providers/windows-update-runtime-evidence.test.ts', blobId: '0c43c5bb19a97a6d207c16e589c0c56911b694c6' },
  { scope: 'history', ruleId: 'UNC_PATH', path: 'apps/api/src/providers/windows-update-runtime-evidence.test.ts', blobId: '55de500c58d217167b167a3a38fe0683b332f7ff' },
  // These sources contain protocol/extended-path syntax, not a deployment endpoint.
  // Reviewed runtime-approval/ACL rollback changes retain only generic extended-path syntax.
  { scope: 'history', ruleId: 'UNC_PATH', path: 'scripts/windows/configuration/DysonConfiguration.Common.ps1', blobId: 'b61ea568d290d89a3e6e1b322b38d31f12453564' },
  { scope: 'history', ruleId: 'UNC_PATH', path: 'scripts/windows/deployment/DysonDeployment.Common.ps1', blobId: '5ec20be499907bdf4afa526bfc8836ae9617e82d' },
  { scope: 'history', ruleId: 'UNC_PATH', path: 'scripts/windows/deployment/SelfTest-DysonControlDeployment.ps1', blobId: 'fbc9442ed303e6bde58f534513a4a9c98c25a3f0' },
  // This reviewed historical test blob also contains only generic extended-path prefix conversion.
  { scope: 'history', ruleId: 'UNC_PATH', path: 'scripts/windows/deployment/SelfTest-DysonControlDeployment.ps1', blobId: '48002a94ba7cab80cc46b4a49ff649b7ca4a8c09' },
  { scope: 'history', ruleId: 'UNC_PATH', path: 'scripts/windows/deployment/SelfTest-DysonControlDeployment.ps1', blobId: '7838bc779031045b2788aded1f67c31543278313' },
  // The added Bridge configuration test uses fictional paths; authentication fixtures remain fictional.
  { scope: 'history', ruleId: 'SECRET_LITERAL_ASSIGNMENT', path: 'apps/api/src/config.test.ts', blobId: 'd4aad480b97f2369497db3aec19773be0d962015' },
  // The builder uses generic Windows extended paths to clean its checked temporary directory.
  { scope: 'history', ruleId: 'UNC_PATH', path: 'scripts/windows/bridge/Build-DysonControlBridgeCandidate.ps1', blobId: 'ecfcc230bd9279d2f15546d3988720c76a22cc1f' },
  { scope: 'worktree', ruleId: 'UNC_PATH', path: 'scripts/windows/bridge/Build-DysonControlBridgeCandidate.ps1' },
  { scope: 'artifact', ruleId: 'UNC_PATH', path: 'scripts/windows/bridge/Build-DysonControlBridgeCandidate.ps1' },
  { scope: 'worktree', ruleId: 'UNC_PATH', path: 'integrations/dyson-control-bridge/BridgeProtocol.cs' },
  { scope: 'artifact', ruleId: 'UNC_PATH', path: 'integrations/dyson-control-bridge/BridgeProtocol.cs' },
  { scope: 'worktree', ruleId: 'UNC_PATH', path: 'scripts/public-release/scanner.mjs' },
  { scope: 'worktree', ruleId: 'UNC_PATH', path: 'scripts/windows/DysonHostMutationLease.Common.ps1' },
  { scope: 'artifact', ruleId: 'UNC_PATH', path: 'scripts/windows/DysonHostMutationLease.Common.ps1' },
  { scope: 'worktree', ruleId: 'UNC_PATH', path: 'scripts/windows/configuration/DysonConfiguration.Common.ps1' },
  { scope: 'artifact', ruleId: 'UNC_PATH', path: 'scripts/windows/configuration/DysonConfiguration.Common.ps1' },
  { scope: 'worktree', ruleId: 'UNC_PATH', path: 'scripts/windows/deployment/DysonDeployment.Common.ps1' },
  { scope: 'artifact', ruleId: 'UNC_PATH', path: 'scripts/windows/deployment/DysonDeployment.Common.ps1' },
  { scope: 'worktree', ruleId: 'UNC_PATH', path: 'scripts/windows/deployment/SelfTest-DysonControlDeployment.ps1' },
  { scope: 'artifact', ruleId: 'UNC_PATH', path: 'scripts/windows/deployment/SelfTest-DysonControlDeployment.ps1' },
  // The V2 network self-test must prove that private/special-use addresses fail closed.
  { scope: 'worktree', ruleId: 'PRIVATE_IP_ADDRESS', path: 'scripts/windows/network/SelfTest-DysonNebulaNetworkV2.ps1' },
  { scope: 'artifact', ruleId: 'PRIVATE_IP_ADDRESS', path: 'scripts/windows/network/SelfTest-DysonNebulaNetworkV2.ps1' },
  {
    scope: 'history',
    ruleId: 'UNC_PATH',
    path: 'scripts/windows/configuration/DysonConfiguration.Common.ps1',
    blobId: '367812fdf0c579c9a4f987202b01fda1751126b0'
  },
  {
    scope: 'history',
    ruleId: 'UNC_PATH',
    path: 'scripts/windows/deployment/DysonDeployment.Common.ps1',
    blobId: '6b3ffe2c56b921d17ed980b6cbf8724eaa4a54e4'
  },
  {
    scope: 'history',
    ruleId: 'UNC_PATH',
    path: 'scripts/windows/deployment/SelfTest-DysonControlDeployment.ps1',
    blobId: 'f2ca6521af2412de66015decb40b48238df8174d'
  },
  // Pending-status preflight changes retain the reviewed path parser and
  // fictional deployment fixtures; bind their new contents explicitly.
  { scope: 'history', ruleId: 'UNC_PATH', path: 'scripts/windows/deployment/DysonDeployment.Common.ps1', blobId: 'e41dad64ed934c92c51f90cf060fc4c9a86d9853' },
  { scope: 'history', ruleId: 'UNC_PATH', path: 'scripts/windows/deployment/SelfTest-DysonControlDeployment.ps1', blobId: 'a103af151998d1a9f7d3411e3bd31baa783a1148' },
  {
    scope: 'history',
    ruleId: 'PRIVATE_IP_ADDRESS',
    path: 'scripts/windows/network/SelfTest-DysonNebulaNetworkV2.ps1',
    blobId: '7958a0c9088f2069e4f7182eeed54f9221ffcbee'
  },
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
    ruleId: 'HIGH_ENTROPY_SECRET_ASSIGNMENT',
    path: 'scripts/public-release/scanner.mjs',
    blobId: '02d2ef9b2ab7df0af6a28775f71ee26215c4be5c'
  },
  {
    scope: 'history',
    ruleId: 'SECRET_LITERAL_ASSIGNMENT',
    path: 'apps/api/src/config.test.ts',
    blobId: '718d0f9d877e2ce7ecb9c3bbac0c6552312bdb88'
  },
  {
    // Reviewed fictional authentication fixtures used only by configuration validation tests.
    scope: 'history',
    ruleId: 'SECRET_LITERAL_ASSIGNMENT',
    path: 'apps/api/src/config.test.ts',
    blobId: '843ccfa417ab96c0e81a8e22babeff0fc3cb6570'
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
    path: 'scripts/public-release/scanner.mjs',
    blobId: '02d2ef9b2ab7df0af6a28775f71ee26215c4be5c'
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
    ruleId: 'SECRET_LITERAL_ASSIGNMENT',
    path: 'scripts/public-release/scanner.test.mjs',
    blobId: '49851ff9aa4655f86875ed17eff2be1087ff9a35'
  },
  {
    scope: 'history',
    ruleId: 'SECRET_LITERAL_ASSIGNMENT',
    path: 'scripts/public-release/scanner.test.mjs',
    blobId: 'e783fe35d22b5ea6d61b98c8c643078c7fa5260c'
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
    path: 'scripts/public-release/scanner.mjs',
    blobId: '02d2ef9b2ab7df0af6a28775f71ee26215c4be5c'
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
  'docs/DATAROOT-RECOVERY.md',
  'docs/GSM-EVALUATION.md',
  'docs/MIGRATION-GSMANAGER.md',
  'docs/NETWORK-CONNECTIVITY.md',
  'docs/PRODUCTION-QUALIFICATION.md',
  'docs/WINDOWS-DEPLOYMENT-DRAFT.md',
  'integrations/dyson-control-bridge/BridgeFileStore.cs',
  'integrations/dyson-control-bridge/BridgeProtocol.cs',
  'integrations/dyson-control-bridge/DysonControlBridge.csproj',
  'integrations/dyson-control-bridge/DysonControlBridgePlugin.cs',
  'integrations/dyson-control-bridge/GameSaveAdapter.cs',
  'integrations/dyson-control-bridge/LoadedSaveEvidencePublisher.cs',
  'integrations/dyson-control-bridge/NebulaNoticeRuntimeCompatibility.cs',
  'integrations/dyson-control-bridge/PlayerNoticeProtocol.cs',
  'integrations/dyson-control-bridge/PlayerRosterPublisher.cs',
  'integrations/dyson-control-bridge/SimulationTelemetrySampler.cs',
  'integrations/dyson-control-bridge/README.md',
  'integrations/dyson-control-bridge/dyson-control-bridge.cfg.example',
  'integrations/nebula-hostname-wss/contract.json',
  'integrations/nebula-hostname-wss/patches/nebula-v0.9.22-hostname-wss.patch'
])

// These are public package registries, source forges, standards bodies, and
// upstream project sites. They are policy categories, not production-host
// exceptions. Subdomains are accepted only where explicitly listed.
export const PUBLIC_REFERENCE_HOSTS = Object.freeze([
  'fsf.org',
  'api.github.com',
  'api.nuget.org',
  'gcdn.thunderstore.io',
  'github.com',
  'json-schema.org',
  'nuget.bepinex.dev',
  'objects.githubusercontent.com',
  'opencollective.com',
  'react.dev',
  'release-assets.githubusercontent.com',
  'registry.npmjs.org',
  'schemas.microsoft.com',
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
