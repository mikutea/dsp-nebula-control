# Updates, mod locks, and client profiles

Dyson Control separates release discovery, compatibility decisions, artifact
staging, mod dependency resolution, server locks, and client-profile generation.
The repository also implements default-off component and mod deployment
transactions with real fixed-root publication, smoke/rollback contracts, and a
deterministic authenticated client ZIP. None of those repository tests is
evidence that the target Windows game tree has been changed or verified.

The preparation/staging response still reports `activationEnabled: false` and
`boundary: staging-only` because staging never activates bytes by itself.
Activation is a separate Administrator-only transaction and independent host
gate. No planning response, staged directory, green compatibility decision,
activation receipt, or generated client package is production verification
until the target-host smoke and rollback gates pass.

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

## Component activation and rollback

The authenticated component workspace uses these routes:

- `GET /api/v1/updates/activation/state`;
- `GET /api/v1/updates/activation/recovery`;
- `GET /api/v1/updates/activation/cleanup/preview`;
- `GET /api/v1/updates/activation/receipts/:requestId`;
- `POST /api/v1/updates/activation/preview`;
- `POST /api/v1/updates/activation/execute`.

Viewer and Operator roles may read and preview. Only an Administrator with
`updates.activate` can submit the component-specific confirmation. The browser
sends only a UUID, fixed component, opaque staged artifact ID, SHA-256, target
version, expected state revision, and structured trusted compatibility
evidence. DSP remains `manual/steam-client-required` and has no activation
button.

The component transaction re-verifies the staged archive, assembles an
immutable release, proves the managed process stopped and the game port closed,
creates a paired-save protection point, revalidates revision/compatibility,
publishes actual files to construction-time fixed roots, verifies every live
file, and only then runs the fixed smoke adapter. A failed candidate restores
the previous bytes and independently smokes the previous version. Durable
journals, backups, receipts, UUID idempotency, cross-instance locks, and restart
reconciliation retain `recoveryRequired` whenever rollback cannot be proven.
Before Fastify reports ready, the application runs this reconciliation exactly
once. The read-only recovery route reports `pending`, `reconciling`, `ready`,
`recovery-required`, or `unavailable` without returning paths or adapter error
text. Activation execution remains fail-closed until recovery is `ready`; an
uncertain journal or durable `recoveryRequired` state keeps all activation
mutations blocked while state, receipt, history, and cleanup previews remain
readable. Restarting the application may retry reconciliation, but requests do
not implicitly repeat it within one process.

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
