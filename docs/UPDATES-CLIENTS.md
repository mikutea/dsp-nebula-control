# Updates, mod locks, and client profiles

Dyson Control separates release discovery, compatibility decisions, artifact
staging, mod dependency resolution, server locks, and client-profile generation.
The repository also implements default-off component and mod deployment
transactions with real fixed-root publication, smoke/rollback contracts, and a
deterministic authenticated client ZIP. None of those repository tests is
evidence that the target Windows game tree has been changed or verified.

The repository additionally publishes a GPL-3.0-only, source-only Nebula
0.9.22 hostname-preserving WSS patch under
`integrations/nebula-hostname-wss`. That patch is not a Nebula release-discovery
result, acquired component, prepared activation artifact, generated client ZIP,
or Dyson Control runtime release payload. Its offline builder accepts only the
  official pinned Git commit and the exact two source-blob hashes, emits a
  six-file source candidate, and rejects binaries and proprietary game
  assemblies. The parser source preserves explicit `ws`/`wss` while promoting
  only an implicit hostname route on final port 443; the client source preserves
  hostname authority, remembered connection data, and password-retry argument
  order. A lawful private Nebula build
and a real external-client E2E remain separate manual gates; source fixtures do
not prove connectivity.

The preparation/staging response still reports `activationEnabled: false` and
`boundary: staging-only` because staging never activates bytes by itself.
Activation is a separate Administrator-only transaction and independent host
gate. No planning response, staged directory, green compatibility decision,
activation receipt, or generated client package is production verification
until the target-host smoke and rollback gates pass.

## Control-plane Node runtime boundary

The Node.js executable that runs Dyson Control is not a DSP, Nebula, BepInEx,
plugin, mod, or client-profile component. Discovery, acquisition, preparation,
activation, and mod-lock routes therefore never install or update it. Windows
operators maintain it in an independent protected `RuntimeRoot`, outside the
control-plane `InstallRoot` and `DataRoot`, with an exact authenticated ZIP hash
and `node.exe` hash. The RuntimeRoot direct parent is a dedicated protected
container, separate from both control-plane roots; broad or service delete/write
rights on that boundary fail closed. `Install-DysonNodeRuntime.ps1` acquires a
protected `FileShare.None` transaction lease before it reads prior or pending
state, then uses an operation-bound V2 intent, candidate marker, completion
receipt, and same-volume stage/rename. `Repair-DysonNodeRuntime.ps1` restores an
exact verified predecessor before commit or finalizes the verified candidate
after a durable receipt; it never deletes a RuntimeRoot merely because an older
intent recorded no predecessor. An existing-runtime upgrade also requires the
previous expected node hash. Every control-plane start revalidates the container,
ordinary path chain, protected ACL, exact bytes, and Node major version.
Control-plane uninstall preserves the runtime and transaction journal by default.

The control-plane environment is a separate protected deployment boundary too.
Install, task registration, launcher start, status, and reboot acceptance all
validate the exact environment contract, launcher-owned bindings, transaction
chain, and config/DataRoot ACL fingerprints. Evidence contains hashes and byte
length only. The top-level deployment wrapper supports initial creation,
byte-identical reuse, and protected replacement. Replacement snapshots the old
configuration before release mutation; on later failure it snapshots the new
configuration and restores the protected predecessor before release/task
rollback. A first-install failure still has no predecessor to restore and fails
closed while retaining the coherent protected configuration.

## Version and compatibility model

The domain model normalizes DSP, Nebula, BepInEx, and plugin versions and
evaluates them against a schema-versioned compatibility matrix. A decision
contains every evaluated matrix row and stable blocker reasons such as:

- DSP, Nebula, or BepInEx version mismatch;
- missing required plugin;
- plugin version mismatch.

The following authenticated routes expose deterministic, non-mutating planning
or metadata generation:

- `POST /api/v1/updates/compatibility/preview`;
- `POST /api/v1/updates/plan/preview`;
- `POST /api/v1/updates/candidates/preview`;
- `POST /api/v1/updates/preparation/preview`;
- `POST /api/v1/mods/resolve/preview`;
- `POST /api/v1/mods/lock/preview`;
- `POST /api/v1/mods/verified-lock/preview`;
- `POST /api/v1/client-profile/generate`.

They accept strict JSON schemas, reject extra command/path input, and do not
perform network or filesystem mutation.

## Release discovery

The update-pipeline library contains bounded clients for:

- Thunderstore package metadata and exact dependency identities;
- Nebula GitHub release metadata and release assets;
- reviewed official BepInEx 5 Windows x64 assets from the fixed
  `BepInEx/BepInEx` GitHub Releases source.

Discovery uses fixed HTTPS provider boundaries, bounded response sizes,
timeouts, and page limits. Draft/ineligible releases and unexpected artifact
hosts are rejected. Thunderstore metadata without a provider digest remains
`artifact-integrity-pending`; it is never treated as verified merely because a
provider returned a download URL.

### Exact reviewed Thunderstore artifacts

For an existing package whose community review is `unreviewed`, an operator can
qualify an exact ZIP through the server-owned compatibility policy file named by
`DYSON_UPDATE_COMPATIBILITY_POLICY_FILE`. Its optional `trustedModArtifacts`
member has this shape (fictional values; do not deploy this example):

```json
{
  "format": "dyson-control-trusted-mod-artifacts",
  "schemaVersion": 1,
  "policyId": "example-plugin-review",
  "reviewedAt": "2026-09-01T00:00:00Z",
  "expiresAt": "2026-10-01T00:00:00Z",
  "packages": [{
    "dependencyId": "Example-ServerHelper-1.0.0",
    "dependencies": ["Example-Core-2.0.0"],
    "sha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    "sizeBytes": 2048
  }]
}
```

Preserve the containing compatibility policy and its matrix. Protect the file
and parent directories against writes by the web-service identity and unrelated
users; use the same host configuration authority as the compatibility matrix.
Before adding a pin, independently inspect the exact downloaded ZIP, its complete
dependency list, payload layout and installed-package relationship, and record
its measured SHA-256 and byte count in private review evidence. A pin establishes
the reviewed bytes; it does not establish runtime compatibility or safe activation.
Every dependency needs its own qualification or normal provider approval. Platform
packages still follow their separate BepInEx/Nebula component paths.

Pins match exact case-sensitive package/version and dependency identities. They
cannot override rejected community listings, inactive versions or deprecated
packages, and do not approve an entire author or community. A future review time,
expired policy, removed pin or changed digest/size fails closed. Policy revisions
bind both acquisition candidates and compatibility decisions. Editing a policy
invalidates its earlier reviewed candidates; rediscover against the new policy.

The server reloads the file during discovery and acquisition authorization.
Browser requests cannot supply this policy. Candidate descriptors and acquisition
receipts retain `trustedPolicyRevision`; their integrity remains explicitly local
(`locally-computed-required` before download, `locally-computed` after measurement).
The operator's pin is never described as a provider-supplied digest. Download
publication, import and downstream verified receipt reads recheck authority.
An acquired receipt remains historical evidence after revocation, but cannot grant
new import authority. The discovery candidate's short TTL does not invalidate
already acquired bytes by itself; their reviewed policy must still be current.

Revocation blocks future operations; it does not stop the running game or remove
an already installed plugin. Use the separately gated mod rollback/disable flow
when live remediation is required. Before production use, verify protected file
access, the exact archive, dependency routing, native staging and rollback, and
client compatibility. Repository tests do not replace those target-host checks.

The BepInEx client is deliberately narrower than a general GitHub release
browser. It accepts only the reviewed layout-policy versions `5.4.22` /
`5.4.22.0` and `5.4.23.2` through `5.4.23.5`, with their exact official
Windows x64 ZIP names and canonical `github.com/BepInEx/BepInEx/releases`
download paths. Drafts, prereleases, future or unknown versions, x86 and Unix
assets, case/name variants, and third-party repacks do not become candidates.
Matching assets on an unexpected host/path and duplicate official candidates
fail the discovery result closed. GitHub-reported size is retained; a valid
GitHub `sha256:` digest is retained as provider evidence, while an absent
digest leaves the artifact at `locally-computed-required` for independent
staging verification.

The Nebula, BepInEx and Thunderstore clients are connected to authenticated API routes:

- `POST /api/v1/updates/discovery/nebula` reads the fixed official GitHub
  Releases source;
- `POST /api/v1/updates/discovery/bepinex` reads the fixed official GitHub
  Releases source and accepts only the reviewed Windows x64 layouts;
- `POST /api/v1/updates/discovery/thunderstore` resolves a strictly bounded
  package request against the fixed Thunderstore provider.

The version workspace includes operator actions for Nebula and BepInEx discovery. The mod
workspace now provides a dedicated Thunderstore flow that resolves one exact,
dependencies-first closure and routes ordinary plugins separately from managed
Nebula packages, BepInEx prerequisites, and unsupported reserved platform
identities. Neither route is a scheduled updater. Route and browser tests use
fictional fixtures and injected provider clients; no live provider response,
target-host run, or production compatibility matrix has been accepted as
release evidence.

Successful Nebula, BepInEx and Thunderstore discovery also registers each eligible
artifact as a short-lived, provider-bound acquisition candidate in server
memory. The discovery response adds `meta.acquisition`: every discovered
artifact has an explicit registration status and either a redacted descriptor
or `candidate: null`. Descriptors contain only an opaque candidate ID, provider,
release identity, normalized exact plugin dependencies, their dependency-graph
fingerprint, safe file name, bounded size/hash evidence, and expiry; they do not
expose the provider URL or a filesystem path. The normalized dependency list
and fingerprint are part of the immutable candidate ID and persist into the
acquisition receipt. Ineligible releases,
disabled acquisition assembly, and registration failures remain explicit null
candidates rather than pretending that a download can proceed.

`BepInExGithubReleaseClient` is assembled in `app.ts`; the authenticated route
registers its strict discovery output as short-lived acquisition candidates,
and the Web workspace can continue through acquisition, candidate preparation,
activation preview, exact confirmation and receipt verification. There is no
scheduler or silent updater. Injected fixtures and route/browser tests establish
the deterministic contract, but they are not evidence that a live GitHub
response or target Windows installation has been accepted.

## Offline artifact staging

The managed acquisition transaction can stream a server-registered discovery
candidate from its fixed provider into the configured inbox before staging. It
enforces provider host/path policy, response timeout and byte bounds, ZIP
signature, expected size and SHA-256, exclusive locks, temporary-file cleanup,
atomic inbox publication, UUID idempotency, and durable redacted receipts under
the fixed `<DYSON_UPDATE_STAGING_ROOT>/acquisitions` state root. The HTTP
contract is:

- `POST /api/v1/updates/acquisition/preview` for an `updates.read` dry run;
- `POST /api/v1/updates/acquisition/execute` for `updates.stage`, a UUID, opaque
  candidate ID, and the exact `ACQUIRE_UPDATE_ARTIFACT` confirmation;
- `GET /api/v1/updates/acquisition/receipts/:requestId` for `updates.read`.

Acquisition mutation is independently default-off through
`DYSON_UPDATE_ACQUISITION_ENABLED=false` and is assembled only with the fixed
inbox/staging roots. Request bodies cannot supply URLs, paths, commands, or
credentials. Acquisition does not automatically stage or activate the bytes:
its receipt provides the opaque artifact identity and integrity evidence for a
separate staging request. This server/API flow is implemented and covered by
fixture-only route tests. The version workspace now renders the strict
`meta.acquisition` contract for Nebula discovery, including explicit
`not-configured`, `release-ineligible`, `registration-failed`, and expired
states. Operator and Administrator roles can request a dry-run for a valid
server-bound candidate and execute only after entering
`ACQUIRE_UPDATE_ARTIFACT`; Viewer remains read-only but may recover one durable
receipt by exact UUID. HTTP 200 idempotent replays and 201 first acquisitions
share the same safe receipt surface. It reports only provider/release identity,
safe file name, bounded size, verified integrity state, fixed-inbox publication,
and receipt durability—never a path, URL, digest value, command, or secret.

This browser acquisition workflow is covered with fictional component and API
contract tests, but it has not downloaded from a live provider or run on the
target VM. Ordinary Thunderstore plugins can continue from acquisition into a
separately confirmed import transaction in the mod workspace. For managed
components the version workspace now exposes official Nebula and BepInEx
discovery, acquisition, candidate preparation, durable preparation receipt
reread, compatibility evidence, and activation preview as separate gates. A
raw `ACQUIRED` receipt never populates or unlocks an activation draft. Only a
strictly validated, reread `dyson-control-component-preparation-receipt` may do
so.

`ComponentCandidatePreparationService` now closes the core-only gap between a
durable acquisition receipt and immutable staging. Its strict request boundary
contains only UUIDs, one fixed component, and the exact
`PREPARE_COMPONENT_CANDIDATE` confirmation; it does not accept a URL, path,
command, source identity, digest, or arbitrary archive reference. The service
reconstructs source identity from the validated acquisition receipt, rehashes
the fixed inbox artifact, takes request and artifact locks, and persists an
atomic durable receipt. The Fastify-independent controller provides preview,
execute, and receipt lookup contracts with an independent mutation gate that
is disabled by default. The Web client uses the authenticated routes below:

- `POST /api/v1/updates/discovery/bepinex` for reviewed official GitHub Windows
  x64 candidates and their versioned layout policy;
- `POST /api/v1/updates/preparation/component/preview` for an `updates.read`
  dry run bound to one durable acquisition receipt UUID;
- `POST /api/v1/updates/preparation/component/execute` for `updates.stage`, a
  new UUID, and exact `PREPARE_COMPONENT_CANDIDATE` confirmation;
- `GET /api/v1/updates/preparation/component/receipts/:requestId` for an exact
  durable receipt reread with `updates.read`.

Preparation applies component-specific policy rather than treating every ZIP
the same:

- official Nebula `0.9.22` is checked against its exact two-package Windows
  layout and embedded package identities, then rebuilt as a deterministic
  server-managed component ZIP under a new opaque artifact ID before staging;
- reviewed official BepInEx Windows x64 releases are rehashed and passed
  unchanged to the stager, whose versioned layout parser independently checks
  every owned file and produces the component manifest;
- bridge and control preparation return a structured `unavailable` result;
  the core does not invent an artifact or silently substitute a generic plugin
  path.

Synthetic tests cover discovery/register/acquire/prepare/stage through a real
activation preview, BepInEx direct staging, Nebula layout and identity cleanup,
receipt tampering, cross-component references, locks, and UUID replay conflict.
The Web workflow preserves the component policy split: Nebula activation uses
the newly normalized prepared artifact identity and digest, while BepInEx uses
the reviewed direct prepared artifact identity. Viewer can discover, preview,
and reread exact receipts; Operator can acquire, prepare, issue compatibility
evidence, and generate activation dry-runs; only Administrator can activate.
Preparation failures have stable fail-closed Web surfaces for not found (404),
strict validation (422), disabled/busy mutation (423), and unavailable service
(503). Requests are abortable and stale responses cannot overwrite a newer
transaction. None of this is live-provider or target-Windows production
verification, and the mutation gates remain independently default-off.

The current stager reads a fixed, trusted inbox by opaque artifact ID. A caller
cannot provide a source URL or path. It streams bytes into a private temporary
directory, checks expected size and SHA-256 when available, writes a bounded
manifest, and atomically publishes an immutable staged release. An exclusive
lock prevents concurrent staging, and a later idempotent request re-verifies
the published bytes instead of trusting the directory name.

Authenticated staging routes are implemented:

- `POST /api/v1/updates/staging/preview` validates and returns the bounded
  staging plan;
- `POST /api/v1/updates/staging/execute` requires the fixed confirmation token
  `STAGE_ARTIFACT` before it may publish into the staging root.

The routes are unavailable by default because
`DYSON_UPDATE_STAGING_ENABLED=false`. Enabling them requires absolute,
administrator-controlled `DYSON_UPDATE_INBOX_ROOT` and
`DYSON_UPDATE_STAGING_ROOT` values. The caller still supplies only an opaque
artifact ID and expected integrity metadata, never a URL or filesystem path.
The browser exposes discovery and the separate activation workspace without
allowing a caller-supplied path, URL, command, executable, archive, or
compatibility JSON. API availability is not equivalent to an approved operator
workflow or a production-enabled mutation.

Integrity failure removes the temporary directory and leaves the active game
tree unchanged. The stager does not activate an artifact. The current
preparation plan explicitly blocks DSP automation as
`manual/steam-client-required`; Dyson Control does not request Steam passwords,
guard codes, cookies, or tokens, and it does not claim that SteamCMD can install
the licensed game for this workflow.

## Official Steam client manual handoff

DSP remains outside the artifact/component activation path. The separate
manual-handoff transaction coordinates the safe server-side boundary around an
operator updating DSP in the official Steam client. It never reads, stores, or
automates a Steam account, password, Steam Guard code, cookie, token, client
path, executable, or command. The authenticated boundary uses only:

- `GET /api/v1/updates/steam-handoff/state`;
- `GET /api/v1/updates/steam-handoff/recovery`;
- `GET /api/v1/updates/steam-handoff/receipts/:requestId`;
- `POST /api/v1/updates/steam-handoff/preview`;
- `POST /api/v1/updates/steam-handoff/begin`;
- `POST /api/v1/updates/steam-handoff/confirm`.

Read, preview, and receipt routes require `updates.read`; begin and confirm
require `updates.activate` and an independent, default-off host gate:

```text
DYSON_STEAM_MANUAL_HANDOFF_ENABLED=false
```

The configuration parser accepts `true` only with the Windows provider,
lifecycle execution, and an absolute trusted-compatibility policy file. Offline
artifact staging is not a prerequisite for this official-client flow. Enabling
the gate does not manufacture host evidence capabilities: when the fixed
transaction provider is absent, every handoff route remains uniformly
unavailable with `503 DSP_STEAM_HANDOFF_NOT_CONFIGURED`.

Preview is a strict `dryRun: true`, `accountAutomation: false` plan and invokes
no lifecycle or persistence adapter. Begin accepts only a UUID, normalized
target DSP version, exact expected state revision, and
`BEGIN_STEAM_CLIENT_UPDATE_HANDOFF`. It captures the exact pre-update DSP,
compatibility revision, and loaded-save identity; creates a durable paired-save
protection point; requests a graceful stop; proves both process exit and port
closure; then persists `awaiting-steam-client-update`. The host-mutation lease
remains bound to that transaction while the operator uses the official Steam
client manually.

Confirm accepts only the same UUID and
`CONFIRM_STEAM_CLIENT_UPDATE_COMPLETED`. It re-samples the installed DSP version
and compatibility decision before any start. A wrong version or incompatible
sample is rejected but remains retryable in `awaiting-steam-client-update`.
Only an exact target may start, and success then requires the bridge heartbeat
and loaded-save log to belong to the current startup generation and to prove
the exact pre-update save identity. A process or open port is never accepted as
load proof. A failed start/load proof, timeout, ambiguous journal, or
interruption outside the safe waiting phase persists `recovery-required`.

The journal and public receipt bind the baseline, protection manifest, target,
state revisions, step results, expiry, and bounded audit events. Reusing the
same UUID and identical request replays its receipt; a changed request under
that UUID is rejected. Initialization reconciles durable state once before
mutations are opened, so a service restart cannot silently restart or skip a
handoff. Application assembly must bind a fixed Windows evidence provider and
the default-off gate before these routes may be made available.

## Component activation and rollback

The authenticated component workspace uses these routes:

- `GET /api/v1/updates/activation/state`;
- `GET /api/v1/updates/activation/recovery`;
- `POST /api/v1/updates/activation/recovery`;
- `GET /api/v1/updates/activation/cleanup/preview`;
- `GET /api/v1/updates/activation/receipts/:requestId`;
- `POST /api/v1/updates/activation/preview`;
- `POST /api/v1/updates/activation/execute`.

Viewer and Operator roles may read and preview. Only an Administrator with
`updates.activate` can submit the component-specific confirmation. The browser
sends only a UUID, fixed component, opaque staged artifact ID, SHA-256, target
version, expected state revision, and structured trusted compatibility
evidence. DSP remains `manual/steam-client-required`: it has no artifact
activation button and is handled only by the official-client handoff above.

The component transaction re-verifies the staged archive, assembles an
immutable release, proves the managed process stopped and the game port closed,
creates a paired-save protection point, revalidates revision/compatibility,
publishes actual files to construction-time fixed roots, verifies every live
file, and only then runs the fixed smoke adapter. Before publication, its
rollback binding records the configuration snapshot identity and revision,
server mod-lock digest and revision, paired-save protection-manifest digest,
and exact previously loaded-save identity alongside the previous component
bytes.

A failed candidate restores and re-reads each bound item separately: component
bytes, configuration, server mod lock, and the paired save. It then starts the
old component and requires startup, bridge-heartbeat, and loaded-save-log
evidence from the same current startup generation, proving the exact previous
save identity. Process or port health alone is insufficient. The public receipt
exposes the rollback-binding digest and per-step status without exposing paths,
saves, or journal internals. A missing restoration capability, any readback
mismatch, or absent current-generation exact-save proof is fail-closed as
`recoveryRequired`; it must never set `rollbackVerified=true`.

Durable journals, backups, receipts, UUID idempotency, cross-instance locks,
and restart reconciliation retain `recoveryRequired` whenever rollback cannot
be proven.

Before Fastify reports ready, the application runs this reconciliation exactly
once. The read-only recovery route reports `pending`, `reconciling`, `ready`,
`recovery-required`, or `unavailable` without returning paths or adapter error
text. Activation execution remains fail-closed until recovery is `ready`; an
uncertain journal or durable `recoveryRequired` state keeps all activation
mutations blocked while state, receipt, history, and cleanup previews remain
readable. Restarting the application may retry reconciliation, but requests do
not implicitly repeat it within one process.

Ordinary activation and explicit recovery have separate, default-off Windows
gates:

```text
DYSON_UPDATE_ACTIVATION_ENABLED=false
DYSON_UPDATE_ACTIVATION_RECOVERY_ENABLED=false
```

Enabling ordinary activation never enables recovery, and enabling recovery
never authorizes a new update. The recovery request is restricted to an
Administrator with `updates.activate` and contains exactly the persisted
transaction UUID plus `RECOVER_COMPONENT_UPDATE`. The server reconstructs the
component, artifact, paths and terminal action from its durable journal and
the global host-mutation broker. It re-reads the persisted terminal receipt
and active revision before reopening the ordinary activation gate.

Nebula, bridge, and control plugin archives are limited to declared
`plugins/**/*.dll|json` files. BepInEx uses a separate versioned Windows x64
bootstrap policy: reviewed official layouts for 5.4.22/5.4.22.0 and
5.4.23.2-.5 only. Its ownership is limited to `winhttp.dll`,
`doorstop_config.ini`, `changelog.txt`, optional `.doorstop_version`, and the
fixed `BepInEx/core` set. User `BepInEx/config`, `plugins`, logs, patchers, and
unowned files are never deleted. Unknown/future layouts, x86, BepInEx 6,
third-party repacks, scripts, extra executables, links, path escape, case
collisions, and hash/CRC drift fail closed.

The reviewed official Windows x64 release assets were independently downloaded
from `github.com/BepInEx/BepInEx` on 2026-08-30. Their full-archive evidence is:

| Release | Official asset | Bytes | SHA-256 | Files |
| --- | --- | ---: | --- | ---: |
| 5.4.22/5.4.22.0 | `BepInEx_x64_5.4.22.0.zip` | 622553 | `4c149960673f0a387ba7c016c837096ab3a41309d9140f88590bb507c59eda3f` | 21 |
| 5.4.23.2 | `BepInEx_win_x64_5.4.23.2.zip` | 637157 | `f752ce4e838f4c305b9da1404b6745f2cff23b8bfd494f79f0c84d0a01f59b46` | 22 |
| 5.4.23.3 | `BepInEx_win_x64_5.4.23.3.zip` | 638885 | `41a089e5b1b1f0713b331346baf6677b1184c69eabebf51101097954e854c749` | 22 |
| 5.4.23.4 | `BepInEx_win_x64_5.4.23.4.zip` | 638940 | `f881201b79da03e513bf97cdf39607ffa7f9e0d31a519b1aeeca8eb60f8309e7` | 22 |
| 5.4.23.5 | `BepInEx_win_x64_5.4.23.5.zip` | 639118 | `82f9878551030f54657792c0740d9d51a09500eeae1fba21106b0c441e6732c4` | 22 |

GitHub's release API supplied a provider digest for 5.4.23.4 and 5.4.23.5;
all five values above were also recomputed locally from the official downloaded
bytes. The temporary verification archives are not repository or release
assets.

The repository controller/UI/core, fixed-root live publisher, Windows
lifecycle/save-protection/smoke adapter, bridge/control fixed-file version
probe, application assembly, and default-off activation configuration are
implemented and tested with fictional providers, files, and injected runners.
These repository tests do not publish to the target VM or prove a real game
load. Controlled target-host publication, DSP/Nebula load and bridge heartbeat,
previous-version smoke and rollback, paired-save reload, restart
reconciliation, and an external client join still require evidence before
`UPD-003` or `UPD-004` can be `verified`.

## Thunderstore resolver and server lock

The mod resolver uses exact `Namespace-Name-Version` dependency identities. It
computes a bounded dependency closure, reports missing packages, conflicting
versions, and cycles, and produces a deterministic dependency-before-dependent
load order only when the graph is complete.

The generated server lock records, for every resolved package:

- canonical source and dependency IDs;
- normalized version and SHA-256;
- exact dependencies and deterministic load order;
- root/server-required flags;
- `required`, `optional`, or `not-required` client policy.

A client-parity manifest embeds the SHA-256 of the canonical server lock.
Validation rejects altered digests, duplicate sources, topology drift inside
the document, and server/client entry mismatch.

The update-pipeline composition can generate these locks only when discovered
release identities match locally staged, hash-checked bytes and each release
has an explicit server/client policy. The fixed-root mod deployment transaction
supports dry-run, exact expected live revision, manifest/hash revalidation,
snapshot, atomic publish, byte-level verification, compensation, durable
receipt, UUID idempotency, cross-instance lock, and cleanup preview. Durable
receipts are available through strict `GET /api/v1/mods/deployment/receipts/:requestId`
lookup and keyset-paginated `GET /api/v1/mods/deployment/history`; history is
ordered by persisted time plus UUID, defaults to 20 entries, and is capped at
100 entries per response and 10,000 managed receipt files. Viewer, Operator,
and Administrator roles may read those bounded public receipts, while the Web
mutation workspace remains restricted to `mods.mutate` Administrators. Neither
route accepts or returns a server path, URL, command, credential, storage
fingerprint, or arbitrary archive. It still lacks a separately verified
production live-installed-mod drift scan and real Nebula load proof.

Interrupted publication is exposed through a separate bounded contract:

- `GET /api/v1/mods/deployment/recovery/status` returns only `ready` or the
  exact pending request ID, operation and server-approved terminal choices;
- `POST /api/v1/mods/deployment/recovery/execute` accepts exactly that UUID,
  one approved `candidate` or `previous` choice, and
  `RECOVER_MOD_DEPLOYMENT`.

The independent `DYSON_MOD_DEPLOYMENT_RECOVERY_ENABLED=false` gate does not
inherit from `DYSON_MOD_DEPLOYMENT_ENABLED`. While status is missing, invalid,
or recovery-required, the Web workspace and server both keep ordinary mod
publication fail-closed. A successful recovery is accepted by the browser only
after a fresh state read proves the durable terminal revision and a fresh
recovery-status read returns `ready`; paths, journal contents and storage
fingerprints never cross the API boundary.

The Thunderstore browser-to-deployment chain is deliberately receipt-bound:

1. discovery fixes every exact dependency and routes platform packages;
2. the acquisition candidate ID includes the normalized dependency graph and
   its SHA-256 fingerprint;
3. import preview and execute rehash the fixed inbox ZIP and require its root
   `manifest.json` dependency graph to match the discovery-bound receipt;
4. verified-lock accepts only persisted import receipt UUIDs, rehashes the
   inbox ZIP again, rebuilds the prepared package, and verifies the published
   staging manifest plus every payload file;
5. unreachable extra receipts and policy/lock set mismatches are rejected;
6. the generated deployment manifest carries a server-issued `platformLock`
   bound to the server-lock digest and current trusted inventory revision;
7. deployment preview and execute reread trusted Nebula/BepInEx inventory and
   reject revision or exact-version drift.

Acquisition/import receipts created before the dependency-binding contract are
not migrated or trusted. After upgrading, rediscover and reacquire the package
to create new receipts; do not edit or reuse old receipt JSON. This fail-closed
migration rule avoids silently accepting an unbound dependency graph.
Consequently:

- `MOD-001`, `MOD-002`, and `MOD-003` are `implemented`, not `verified`;
- preview and cleanup remain explicitly non-mutating;
- production execution remains independently default-off.

## Client profile artifact set

The client-profile library consumes:

- normalized DSP, Nebula, and BepInEx inventory;
- the same compatibility matrix used for the server decision;
- a validated server mod lock and matching client-parity manifest;
- a public DNS hostname and Nebula port.

It blocks generation when the runtime is incompatible or the lock/parity
digest pair does not match. A successful in-memory result contains deterministic
UTF-8 metadata artifacts:

```text
CHECKSUMS.sha256
INSTALL.md
client-mod-lock.json
client-profile.json
parity-report.json
verification-checklist.json
```

Required and optional client mods are separated, while server-only mods appear
only in the exclusion checklist. Entries and the aggregate set have fixed size
and count limits. The generator rejects URLs, literal IP addresses, path-like
metadata, unsafe archive entry names, passwords, Steam material, secret keys,
and private host paths. Its connection contract is direct Nebula transport to a
public DNS hostname, for example `game.example.com:8469`.

The authenticated `POST /api/v1/client-profile/generate` route returns the
validated structured result. `POST /api/v1/client-profile/archive` creates a
deterministic bounded ZIP, independently reparses and rehashes it, and returns
fixed content type/disposition/length plus the archive SHA-256. The Web
workspace verifies the response and offers the package as a download. It does
not redistribute DSP or third-party mod bytes and is still not an automatic
installer. `MOD-004` is therefore `implemented`, not production-verified.

### Production-qualified V2 delivery

The V1 generator remains useful for planning and deterministic public metadata,
but it can never claim that a real client joined the real server. Production
delivery therefore uses a separate V2 request whose exact body is only:

```json
{"schemaVersion":2,"qualificationId":"10000000-0000-0000-0000-000000000001"}
```

The identifier in this fictional example is not production evidence. The
server resolves it only inside protected, fixed Windows roots and independently
rehashes the qualification document, four collector receipts, candidate
binaries, client package, compatibility policy, server lock, and client-parity
manifest. It also verifies the hostname-preserving `wss` contract on port 443,
the `/socket` upgrade, the real external join/save/disconnect/reconnect chain,
and PassWall-bypass observations. Caller-supplied paths, keys, receipt IDs,
digests, authority, decision fields, and arbitrary qualification payloads are
not accepted.

`POST /api/v2/client-profile/issue` first verifies the protected record, then
atomically consumes its replay claim, builds the profile artifacts, and
persists one opaque download object. Repeating the same qualification and
binding returns the same object; reusing a receipt or nonce across another
binding fails closed. The JSON response contains no archive bytes or protected
filesystem paths. It exposes only the persisted download identifier, public
qualification projection, profile metadata, artifact sizes/digests, and receipt
digest.

The authenticated downloads are deliberately separate:

```text
GET /api/v2/client-profile/archive/{downloadId}
GET /api/v2/client-profile/client/{downloadId}
GET /api/v2/client-profile/runtime/{downloadId}
```

They return, respectively, the deterministic profile ZIP, the independently
verified qualified Nebula client payload, and the canonical runtime binding
manifest. Every read reopens and validates the persisted object, rehashes the
bytes at the HTTP boundary, and returns fixed filename, media type, size,
`X-Dyson-Content-SHA256`, `Cache-Control: no-store`, and
`X-Content-Type-Options: nosniff`. The Web workspace binds those headers back
to the signed issue metadata before offering the download. Profile, runtime,
and client payload limits are 512 MiB, 4 MiB, and 1 GiB respectively.

The production-qualified panel accepts only a canonical lowercase UUID. It
never invents an example qualification, scans a workstation, or falls back to
V1 after V2 rejection. When the protected service is disabled, both API and UI
remain visible but fail closed; enabling it requires the complete Windows root
and authority configuration described in `CONFIGURATION.md`.

## Verification still required

Before enabling updates or publishing client packages:

1. pin approved upstream sources and a reviewed compatibility matrix;
2. verify a clean-room discovery and staging run with independently checked
   artifact hashes and licenses;
3. run and verify the already wired fixed Windows save/stop/start/health adapter
   and bridge/control version probe on a controlled target without enabling the
   production mutation gate;
4. repeat dependency conflicts, tampered archives, interrupted activation,
   failed start, failed save load, and rollback on a disposable Windows tree;
5. compare the generated lock with the live installation and reject drift;
6. perform ZIP installation/parity QA on a separate fictional client profile;
7. verify that neither release artifacts nor client exports contain licensed
   game files, credentials, private endpoints, paths, saves, logs, or players;
8. repeat the full rollback and client-join test on the target VM before any
   `verified` state or production cutover.
