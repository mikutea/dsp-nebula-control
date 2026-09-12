# Reusable Windows deployment

This document describes the repository's reusable Windows Server Core deployment
mechanism. The scripts and temporary-root self-test are implemented, but this is
not evidence that any production host was changed. Repository self-tests do not
install, stop, start, edit, or remove any
DSP/Nebula/GSManager task.

## Prerequisites

- a supported Windows Server host with Windows PowerShell 5.1;
- an independent Node.js 24-or-newer runtime root, separate from both
  `InstallRoot` and `DataRoot`, plus the exact lowercase SHA-256 of `node.exe`;
- a clean, built Dyson Control release artifact rather than a development
  checkout;
- for the documented download path, outbound HTTPS access to the fictional
  GitHub repository URL used by the operator;
- an administrator PowerShell session for Program Files, ACL, and Task
  Scheduler changes;
- a complete production environment file created locally outside the release;
- a fixed loopback readiness URI for start-after-install, upgrade, and rollback.

The public repository contains no production environment file. Examples in
this guide use fictional paths and endpoints; operators must not publish their
real paths, hostnames, accounts, task exports, logs, or secrets.

Choose install/data roots that are also valid for rollback and uninstall.
Inside Program Files or ProgramData, only the canonical `DysonControl`
directory is supported; suffixing it with a candidate name is not a supported
side-by-side layout. For an isolated candidate, use separate dedicated trees
outside those managed locations, for example `C:\ExampleCandidate\install` and
`C:\ExampleCandidate\data`, with its own task name and loopback port. Do not
reuse an existing deployment's data root. Preview must reject an unsupported
layout before creating directories, just as an actual install must.

The release does not bundle Node. Install or provision the supported runtime in
its own `RuntimeRoot` and pass `-RuntimeRoot`, the exact `-NodeExecutable`, and
`-ExpectedNodeSha256` to every install, task, launcher, status, reboot-acceptance,
and uninstall operation. Do not place it below `InstallRoot` or `DataRoot`, and
do not borrow a game panel's or game manager's embedded runtime. Give RuntimeRoot
a dedicated direct-parent runtime container that is neither an ancestor nor a
descendant of `InstallRoot` or `DataRoot`. The container, runtime root, and node
path must have protected DACLs: SYSTEM and Administrators have FullControl,
Local Service and the supported Network Service task identity have read/execute
only, and no broad, service, or unknown identity may write, delete children, or
change ownership/ACL at the runtime boundary.
The installer and stable launcher verify the
ordinary non-reparse path chain and exact hash, execute the selected file with a
bounded `--version` probe, and require major version 24 or newer.

## Goals and boundaries

The deployment layer installs only the Dyson Control web/API control plane. The
DSP/Nebula game process keeps its own independently named start and stop tasks.
Installing or uninstalling the control plane therefore cannot implicitly operate
the game server.

The design provides:

- immutable, versioned application releases;
- an atomically replaced active-release pointer instead of an in-place overwrite;
- configuration, SQLite data, logs, audits, and snapshots outside every release;
- a pre-activation snapshot for upgrades and a rollback guard before an explicit
  rollback;
- lower-level pointer/config rollback for release-only transactions and a
  top-level protected preimage/postimage configuration replacement/restore chain;
- `SupportsShouldProcess` / `-WhatIf` on every public mutating entry point;
- a fixed startup task for Node that does not accept an arbitrary command;
- a stable launcher that always forces the Node listener to `127.0.0.1`;
- an uninstaller that preserves ProgramData by default and retains a recoverable
  inactive copy of Program Files;
- machine-readable JSON output and a durable JSONL deployment audit.

This layer does not package licensed DSP files, Steam state, saves, credentials,
real endpoints, logs, or player data.

## Installed layout

The default roots remain Program Files and ProgramData. The equivalent fictional
custom-root layout below is used for every command example in this guide:

```text
C:\GameServer\Example\DysonControl\
  bootstrap\
    bootstrap-layout.json # installer-owned exact data-root binding
    DysonDeployment.Common.ps1
    DysonDeployment.Configuration.ps1
    DysonGameLifecycleBootstrap.Common.ps1
    Resolve-DysonGameLifecycleRelease.ps1
    Start-DysonControl.ps1
    Start-DysonServer.ps1
    Stop-DysonServer.ps1
    configuration\
      DysonConfiguration.Common.ps1
      Install-DysonControlConfiguration.ps1
      Test-DysonControlConfiguration.ps1
      dyson-control.environment-contract.json
  releases\
    0.2.0\
      apps\api\dist\index.js
      apps\web\dist\...
      scripts\windows\...
        cutover\...     # exact host evidence/action/self-test allowlist
        cutover-broker\... # exact six-file fixed SYSTEM broker allowlist
      release-manifest.json

C:\GameServer\Example\DysonControlRuntime\ # dedicated protected container
  node-current\              # RuntimeRoot; verified candidate or predecessor
    node-v24.0.0-win-x64\node.exe
  .dyson-node-runtime-transactions\
    runtime-transaction.lock # FileShare.None lease held across recovery/publish
    intents\                 # protected operation/path/hash-bound V2 intents
    receipts\                # protected durable commit receipts
    recoveries\              # redacted restore/finalize receipts

C:\GameServer\Example\DysonControlData\
  config\
    dyson-control.env
  configuration-transactions\
    intents\             # private durable configuration transaction intents
    receipts\            # private terminal receipts chained to exact intents
  data\                 # SQLite and future persistent application state
    cutover\            # durable cutover journal and append-only audit database
    cutover-broker\     # fixed profile, protected channels, and install receipts
    lifecycle-broker\   # fixed profile plus retained request/receipt history
  logs\                 # application logs, never release payload
  state\
    active-release.json # atomically replaced current pointer
    game-lifecycle-binding.json # exact release bound to a running game lifecycle
  snapshots\
    deployments\        # pointer + config captured before changes
    tasks\               # replaced startup-task XML
    bootstrap\           # replaced stable launcher files
  migration\
    snapshots\           # private GSManager file/task snapshots
    restore-guards\      # private pre-restore compensation guards
  audit\
    deployment.jsonl
  runtime-task-transactions\ # durable pair intents and terminal receipts

C:\GameServer\Example\.dyson-control-deployment-locks\
  <data-root-path-sha256>.lock # stable cross-process deployment lock sidecar
```

`active-release.json` contains a version, a bounded relative entry point, and the
SHA-256 of the immutable release payload. The launcher resolves the entry point
from this pointer on every start. No mutable `current` directory is copied over a
running release.

The deployment lock is a stable sidecar of the configured DataRoot rather than a
file inside DataRoot. Install, upgrade, rollback, startup-task installation, and
uninstall therefore contend on the same lease even while an explicitly approved
uninstall removes the whole DataRoot. Use one exact absolute DataRoot spelling
for every operation; path aliases are outside the lock identity contract. The
small sidecar directory is intentionally retained after uninstall.

## Release artifact contract

`-SourcePath` must name a prepared, local or UNC release artifact. A development
checkout or an ad-hoc directory containing only the API entry point is rejected.
The trusted packaging common defines the exact, closed runtime allowlists. Every
accepted artifact includes these contract anchors, in addition to the complete
specialized Bridge, migration, evidence, bootstrap, cutover, broker, recovery,
and network sets:

```text
artifact-manifest.json
apps\api\package.json
apps\api\package-lock.json
apps\api\dist\index.js
apps\api\dist\lifecycle\game-runtime-receipts.js
scripts\windows\Get-DysonLifecyclePreflight.ps1
scripts\windows\Get-DysonManagedPluginVersion.ps1
scripts\windows\Get-DysonStatus.ps1
scripts\windows\Install-DysonRuntimeTasks.ps1
scripts\windows\Invoke-DysonScheduledTask.ps1
scripts\windows\New-DysonSaveProtectionPoint.ps1
scripts\windows\SelfTest-DysonRuntimeTasks.ps1
scripts\windows\Start-DysonServer.ps1
scripts\windows\Stop-DysonServer.ps1
scripts\windows\Test-DysonRuntimeState.ps1
scripts\windows\release\DysonReleasePackaging.Common.ps1
scripts\windows\release\Test-DysonControlReleaseArtifact.ps1
scripts\windows\deployment\DysonDeployment.Common.ps1
scripts\windows\deployment\DysonRebootAcceptance.Common.ps1
scripts\windows\deployment\Install-DysonControl.ps1
scripts\windows\deployment\Install-DysonControlTask.ps1
scripts\windows\deployment\Install-DysonNodeRuntime.ps1
scripts\windows\deployment\Invoke-DysonControlDeployment.ps1
scripts\windows\deployment\New-DysonRebootAcceptanceCheckpoint.ps1
scripts\windows\deployment\Start-DysonControl.ps1
scripts\windows\deployment\Set-DysonGameBootstrapAccess.ps1
scripts\windows\deployment\Test-DysonControlDeployment.ps1
scripts\windows\deployment\Test-DysonRebootAcceptanceResume.ps1
scripts\windows\deployment\Uninstall-DysonControl.ps1
scripts\windows\session\Configure-DysonInteractiveSession.ps1
scripts\windows\session\Disable-DysonInteractiveSession.ps1
scripts\windows\session\DysonSession.Common.ps1
scripts\windows\session\Test-DysonInteractiveSession.ps1
scripts\windows\bootstrap\DysonGameLifecycleBootstrap.Common.ps1
scripts\windows\bootstrap\Resolve-DysonGameLifecycleRelease.ps1
scripts\windows\bootstrap\SelfTest-DysonGameLifecycleBootstrap.ps1
scripts\windows\bootstrap\Start-DysonServer.ps1
scripts\windows\bootstrap\Stop-DysonServer.ps1
scripts\windows\cutover\DysonCutoverHost.Common.ps1
scripts\windows\cutover\DysonGsManagerAuthority.Common.ps1
scripts\windows\cutover\Get-DysonCutoverEvidence.ps1
scripts\windows\cutover\Initialize-DysonGsManagerAuthority.ps1
scripts\windows\cutover\Invoke-DysonCutoverAction.ps1
scripts\windows\cutover\SelfTest-DysonCutoverHost.ps1
scripts\windows\cutover\SelfTest-DysonGsManagerAuthority.ps1
scripts\windows\cutover-broker\DysonCutoverBroker.Common.ps1
scripts\windows\cutover-broker\DysonCutoverBroker.TaskAcl.ps1
scripts\windows\cutover-broker\Install-DysonCutoverBrokerTask.ps1
scripts\windows\cutover-broker\Invoke-DysonCutoverBrokerWorker.ps1
scripts\windows\cutover-broker\SelfTest-DysonCutoverBroker.ps1
scripts\windows\cutover-broker\Submit-DysonCutoverBrokerRequest.ps1
scripts\windows\bridge\Build-DysonControlBridgeCandidate.ps1
scripts\windows\bridge\Test-DysonControlBridgeCandidate.ps1
scripts\windows\migration\New-DysonGsManagerSnapshot.ps1
scripts\windows\migration\Test-DysonGsManagerSnapshot.ps1
scripts\windows\migration\Restore-DysonGsManagerSnapshot.ps1
scripts\windows\migration\DysonGsManagerRemoval.Common.ps1
scripts\windows\migration\Remove-DysonGsManagerInstallation.ps1
scripts\windows\migration\Restore-DysonGsManagerRemoval.ps1
scripts\windows\migration\SelfTest-DysonGsManagerRemoval.ps1
scripts\windows\migration\Test-DysonGsManagerRemoval.ps1
scripts\windows\evidence\DysonPrivateEvidence.Common.ps1
scripts\windows\evidence\New-DysonAcceptanceEvidenceIndex.ps1
scripts\windows\evidence\New-DysonPrivateEvidenceBundle.ps1
scripts\windows\evidence\SelfTest-DysonPrivateEvidenceBundle.ps1
scripts\windows\evidence\Test-DysonPrivateEvidenceBundle.ps1
scripts\windows\data-recovery\DysonDataRootRecovery.Common.ps1
scripts\windows\data-recovery\New-DysonDataRootRecoveryBundle.ps1
scripts\windows\data-recovery\Restore-DysonDataRootRecoveryBundle.ps1
scripts\windows\data-recovery\SelfTest-DysonDataRootRecovery.ps1
scripts\windows\data-recovery\Test-DysonDataRootRecoveryBundle.ps1
scripts\windows\network\dyson-nebula-network-assessment-v1.schema.json
scripts\windows\network\DysonNetwork.Common.ps1
scripts\windows\network\fixtures\shadow-ready-direct-ws.json
scripts\windows\network\fixtures\shadow-websocket-classification.json
scripts\windows\network\fixtures\shadow-wss-hostname-boundary.json
scripts\windows\network\SelfTest-DysonNebulaNetwork.ps1
scripts\windows\network\Test-DysonNebulaNetwork.ps1
integrations\dyson-control-bridge\DysonControlBridge.csproj
integrations\dyson-control-bridge\dyson-control-bridge.cfg.example
docs\DATAROOT-RECOVERY.md
docs\GSM-EVALUATION.md
docs\MIGRATION-GSMANAGER.md
docs\NETWORK-CONNECTIVITY.md
docs\WINDOWS-DEPLOYMENT-DRAFT.md
```

The manifest fixes the release protocol, exact case-sensitive version, entry
point, Node minimum major, dependency-install policy, exact file set, every file
length and SHA-256, total bytes, and the canonical payload SHA-256. It also binds
the API package version, package-lock top-level version, lock root-package
version, and requested deployment version. The verifier is shipped inside that
exact file set, so an operator can validate an authenticated extracted release
without a repository checkout. Transport authenticity still belongs to the
separately published archive hash/provenance; a self-contained manifest is not a
substitute for that external release evidence.

The production packaging job supplies built `apps/api/dist`, built
`apps/web/dist`, runtime Windows scripts (including the fixed managed-plugin
version probe), the self-contained verifier, license/notices, only the runtime
dependencies needed by the API, and the exact public Bridge source/build tool
allowlist. It also carries the exact stable game-bootstrap allowlist, its
shadow-runtime self-test, the runtime-task pair self-test, the exact cutover
host evidence/action/authority allowlist, the exact six-file cutover-broker
allowlist, all three offline cutover self-tests, the exact five-file DataRoot
recovery allowlist and its Shadow fault-injection self-test, the exact GSManager
migration script allowlist, the separate exact five-file recoverable-removal
allowlist and its Shadow self-test, the exact seven-file Nebula network
assessment allowlist and its zero-native-network-call Shadow self-test, and the
migration, deployment, removal, recovery, and network operator guides. It does
not pass a development checkout with test data or local
`.env` files. In particular, the public artifact rejects Bridge DLL/PDB/EXE
outputs and DSP, Unity, BepInEx, Harmony, or Nebula reference assemblies.
The compiled, read-only game-runtime receipt store and route implementation under
`apps\api\dist\lifecycle` is required; compiled `*.test.js` files remain excluded.

Install, stage, and upgrade require `-ExpectedArtifactPayloadSha256`, copied from
the independently authenticated provenance record. Trusted deployment code then
treats all of `-SourcePath` as data: it never invokes, dot-sources, or imports the
source artifact's verifier or common script. It bounds and parses the manifest,
recomputes the exact file inventory and canonical payload SHA-256, verifies the
package/lock/manifest/version chain, and binds the result to that external
payload digest before any release copy. Staging rejects redirected payload
entries, copies into a sibling directory, repeats the same trusted data-only
verification there, requires the pre-copy and post-copy payload hashes to match,
writes the separate deployment `release-manifest.json` including the verified
`nodeMinimumMajor`, and only then renames the directory into final
`releases\<version>`. Missing, extra, changed, or case-drifted files, provenance
digest drift, and manifest-version mismatches fail closed. Reusing a version is
idempotent only when its complete content hash matches; the scripts refuse to
overwrite a different payload under an existing version. `-WhatIf` performs the
same read-only data validation but never executes source-owned code.
The lower-level `Invoke-DysonControlDeployment.ps1` requires the same digest for
`Stage` and `Upgrade`; `Activate` and `Rollback` reject that irrelevant parameter.

Accepted version labels contain 1-64 characters from letters, numbers, `.`, `_`,
`+`, and `-`. Release automation should normally pass the repository package
version or an immutable release tag.

## Read-only Nebula network assessment

The public artifact includes the exact files under `scripts\windows\network`
listed above and the reviewed [network connectivity contract](NETWORK-CONNECTIVITY.md).
`Test-DysonNebulaNetwork.ps1` is local-only by default: it may inspect the fixed
game port's local listener and a bounded allowlist of expected process names, but
it does not contact DNS or a remote host. Remote DNS, TCP, and WebSocket
classification is enabled only when `-EnableRemoteProbes` is paired with the
literal `I_CONFIRM_READ_ONLY_REMOTE_NETWORK_PROBES` value. Supplying the phrase
while remote mode is disabled is rejected, so it cannot be reused as ambient
authorization.

No invocation implements DNS, route, firewall, router, PassWall, tunnel,
certificate, or endpoint mutation. Even the separate mutation confirmation
fixture remains permanently rejected. Output uses the versioned
`DYSON_NEBULA_NETWORK_ASSESSMENT_V1` schema and reports only bounded,
path-free classifications: local listener/process identity, all-answer DNS and
the reviewed Nebula first-address behavior, TCP/TLS/HTTP/WebSocket outcome,
separate game and management planes, and explicit PassWall evidence fields.

Run `npm run network:selftest` before using the assessment. That test injects
fictional DNS/TCP/WebSocket observations, records zero native network calls, and
proves privacy and the remote/mutation gates. It is implementation evidence
only. A production decision still requires separately approved remote probes,
router/PassWall observation, the real Nebula application handshake, an external
join/reconnect, and private acceptance evidence; the repository carries none of
those results.

## Repository-only production qualification harness

The scripts under `scripts\windows\qualification` and
[the production qualification runbook](PRODUCTION-QUALIFICATION.md) are review
and rehearsal tooling for the nine open acceptance requirements. They define a
fixed 13-step plan, exact public receipt and private-evidence reference shapes,
challenge/timing rules, resumable checkpoints, and fail-closed interruption,
idempotency, rollback, and manual-recovery behavior. Run the Windows PowerShell
5.1 fixture with:

```powershell
npm run qualification:selftest
```

Protocol v1 executes dangerous actions only through a separately gated adapter
against a marked temporary Shadow root. It has no production backend and does
not reboot Windows, stop or crash a real process, interrupt storage, allocate
real disk pressure, switch authority, restore a real save, or contact a network.
Its six-hour soak uses virtual time and is not sustained-operation evidence.

Protocol v2 is the separately reviewed successor and already supplies exactly
four fixed, default-off production-capable adapters: control-plane restart,
exact-PID DSP crash recovery, one exact SMB global-mapping interruption, and
bounded disk pressure in one marked disposable directory. It also has an
isolated fake backend. Repository self-tests invoke only v1 Shadow and v2 fake;
they never enable or call the production backend.

The harness remains repository-only and is not part of the runtime artifact
allowlist above. Any real v2 invocation requires its distinct versioned gate,
fresh authorization, an approved maintenance window, an exact private profile,
and a request-bound private protection-evidence record. Neither v1 environment
gate nor the v1 `SHADOW` confirmation phrase can be reused as v2 authority. No
v2 adapter has yet passed a target-host run, so the self-test leaves all nine
mapped acceptance requirements `not-started`.

## Private acceptance evidence bundles

The release artifact also contains an exact five-file allowlist under
`scripts\windows\evidence`. These tools copy operator-produced evidence from a
fixed staging root into a private, immutable bundle, verify every payload file,
and emit a separate repository-safe index. The tools themselves are public;
the evidence bundles are never release inputs and must never be copied into a
Git checkout or public release asset.

For a fictional run, first create the run directory with the shipped private ACL
helper, then let the collector write its completed output there and preview the
publication:

```powershell
$data = 'C:\GameServer\Example\PrivateAcceptanceData'
$run = 'run-fixture-0001'
$evidence = 'prd-001-run-0001'
$commit = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
$payload = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'

. .\scripts\windows\evidence\DysonPrivateEvidence.Common.ps1
$staging = Join-Path $data "acceptance\staging\$run"
[void](New-DysonPrivateEvidenceDirectory -Path $staging -Private)

# A collector writes its private files beneath $staging before publication.

& .\scripts\windows\evidence\New-DysonPrivateEvidenceBundle.ps1 `
  -DataRoot $data -RunId $run -EvidenceId $evidence `
  -Kind operator-run -Scope dyson-side-by-side `
  -SubjectCommit $commit -RuntimePayloadSha256 $payload `
  -RequirementIds @('PRD-001') -WhatIf
```

The source must be exactly
`<DataRoot>\acceptance\staging\<RunId>` and must already have a protected DACL
owned by the current operator with exactly current-user, SYSTEM, and local
Administrators full-control entries. Both preview and confirmed publication
perform this read-only ACL check before inventorying any private filename or
content; the publisher refuses a broadly accessible staging directory instead
of silently repairing it after collection. A confirmed run inventories the
source before and after copying, rejects reparse points, path collisions,
oversized input and mid-copy changes, applies the same protected ACL to the
publication, writes a manifest with per-file SHA-256 values, verifies the partial
bundle, and atomically renames it to
`<DataRoot>\acceptance\evidence\<EvidenceId>`. Existing evidence IDs are never
overwritten. Failure output reports only a fixed processing stage and does not
echo DataRoot, payload filenames, or underlying I/O error text.

Record the returned manifest SHA-256 outside the bundle, then verify the private
record and create its minimal public index:

```powershell
$manifestSha256 = '<exact-manifest-sha256-returned-by-the-create-command>'

& .\scripts\windows\evidence\Test-DysonPrivateEvidenceBundle.ps1 `
  -DataRoot $data -EvidenceId $evidence `
  -ExpectedManifestSha256 $manifestSha256 `
  -ExpectedSubjectCommit $commit `
  -ExpectedRuntimePayloadSha256 $payload

& .\scripts\windows\evidence\New-DysonAcceptanceEvidenceIndex.ps1 `
  -DataRoot $data -EvidenceId $evidence `
  -ExpectedManifestSha256 $manifestSha256 `
  -ExpectedSubjectCommit $commit `
  -ExpectedRuntimePayloadSha256 $payload `
  -OutputPath ".\acceptance\evidence\$evidence.json" -WhatIf
```

Only the second command's confirmed output file may enter
`acceptance/evidence/`. It contains the opaque ID, evidence kind/scope, exact
commit and runtime payload hashes, manifest hash, observation time, and bounded
requirement IDs. It contains no private path, payload filename, content, account,
endpoint, save, player record, log, task export, or configuration. Run
`npm run evidence:selftest` before relying on the workflow; this is repository
tooling evidence and does not prove that any target-host acceptance run occurred.

## GitHub Release package contract

The repository now has a Windows release workflow at
`.github/workflows/release.yml`. It is triggered only by pushed tags selected by
the release tag filter, and then applies a stricter fail-closed gate: the value
must be exactly `vMAJOR.MINOR.PATCH` or `vMAJOR.MINOR.PATCH-rc.NUMBER`, without
leading zeroes, and the version after `v` must equal the root `package.json`
version. The tag, checked-out `HEAD`, and workflow commit must resolve to the
same 40-character Git commit.

Before dependency installation, build, repository checks, or artifact
assembly, `npm run version:check` verifies the canonical version and fixed
package identity across the root, API, and Web `package.json` files and both
the top-level and `packages[""]` records in all three `package-lock.json`
files. It also binds the Bridge project `<Version>`, `InformationalVersion`,
public `ReleaseVersion`, runtime/API defaults, environment examples, and README
status to that same release. Only `x.y.z` and `x.y.z-rc.N` are accepted. Because
BepInEx 5 exposes plugin metadata through `System.Version`, its attribute-bound
`PluginVersion` is the numeric `x.y.z` core, while Assembly/File versions are
`x.y.z.0`; neither may replace the full RC release in heartbeats, candidate
manifests, activation probes, or smoke comparisons. Release automation also
passes the exact version derived from the `v` tag, so coordinated metadata drift
cannot silently publish a differently versioned package.

The workflow uses Node.js 24 on a Windows runner, installs all three lockfiles,
builds, runs the complete `npm run check` gate, creates the runtime artifact from
that current build, runs the artifact's exact verifier, and scans both reachable
Git history and the artifact with the public-release hygiene gate. It then uses
the formal release packager and package verifier before asking GitHub CLI to
create the release with `--verify-tag`. The workflow has only `contents: write`
permission. It is not runnable from a pull request or arbitrary branch, does not
use asset clobbering, and fails when a release for the tag already exists. An
`-rc.NUMBER` tag is published as a prerelease and never marked latest.

Each successful tag build produces these fixed assets (using `v0.2.0` only as a
fictional example):

```text
DysonControl-v0.2.0.zip
DysonControl-v0.2.0.zip.sha256
DysonControl-v0.2.0.provenance.json
DysonControl-v0.2.0.public-release.json
```

The ZIP uses stored entries in ordinal path order, a fixed DOS timestamp, UTF-8
entry names, and fixed regular-file mode `0644`. Its checksum file has one exact
lowercase SHA-256 line. Provenance has no wall-clock or host path and binds the
tag, commit, artifact protocol/version/payload hash, ZIP hash/length, and release
builder version. The fourth asset is the bounded public-release scanner evidence.
Packaging publishes its three coupled package files by a same-volume directory
rename and never overwrites an existing output.

`npm run release:package-selftest` builds the same fictional package twice and
requires every ZIP, checksum, and provenance byte to match. It also verifies
that archive tampering, checksum tampering, unknown provenance fields, a commit
mismatch, a non-canonical tag, and a tampered source artifact all fail closed.
This is repository evidence only: no tag has been pushed and no GitHub Release or
production host has been changed by the self-test.

### Clean Windows Server download and independent verification

Start in a new, empty directory and use the repository and tag that the operator
intends to trust. The names below are deliberately fictional. Downloading the
ZIP, checksum, and provenance from the same GitHub Release establishes a GitHub
transport/repository trust boundary; the checksum is integrity evidence, not an
independent code-signing identity.

```powershell
$repository = 'example-org/dyson-control'
$tag = 'v0.2.0'
$version = $tag.Substring(1)
$downloadRoot = 'C:\GameServer\Example\Packages\DysonControl-v0.2.0-download'
$assetBase = "DysonControl-$tag"
$archiveName = "$assetBase.zip"
$checksumName = "$assetBase.zip.sha256"
$provenanceName = "$assetBase.provenance.json"
$releaseBase = "https://github.com/$repository/releases/download/$tag"

if (Test-Path -LiteralPath $downloadRoot) {
  throw 'Use a new empty download directory.'
}
[void](New-Item -ItemType Directory -Path $downloadRoot)
foreach ($name in @($archiveName, $checksumName, $provenanceName)) {
  Invoke-WebRequest -UseBasicParsing -Uri "$releaseBase/$name" `
    -OutFile (Join-Path $downloadRoot $name)
}

$archivePath = Join-Path $downloadRoot $archiveName
$checksumText = [System.IO.File]::ReadAllText(
  (Join-Path $downloadRoot $checksumName),
  [System.Text.Encoding]::ASCII
)
$checksumPattern = '^(?<hash>[0-9a-f]{64})  ' +
  [regex]::Escape($archiveName) + "`n$"
$checksumMatch = [regex]::Match(
  $checksumText,
  $checksumPattern,
  [System.Text.RegularExpressions.RegexOptions]::CultureInvariant
)
if (-not $checksumMatch.Success) { throw 'The checksum file is malformed.' }
$actualArchiveHash = (Get-FileHash -LiteralPath $archivePath -Algorithm SHA256).Hash.ToLowerInvariant()
if (-not [string]::Equals(
  $actualArchiveHash,
  $checksumMatch.Groups['hash'].Value,
  [System.StringComparison]::Ordinal
)) { throw 'The independently calculated ZIP SHA-256 does not match.' }

$provenance = Get-Content -LiteralPath (Join-Path $downloadRoot $provenanceName) -Raw |
  ConvertFrom-Json
if ($provenance.protocol -cne 'DYSON_CONTROL_RELEASE_PROVENANCE_V1' -or
    $provenance.tag -cne $tag -or
    $provenance.artifact.version -cne $version -or
    [string]$provenance.artifact.payloadSha256 -cnotmatch '^[0-9a-f]{64}$' -or
    $provenance.archive.fileName -cne $archiveName -or
    $provenance.archive.sha256 -cne $actualArchiveHash -or
    [string]$provenance.commit -cnotmatch '^[0-9a-f]{40}$') {
  throw 'Release provenance does not match the selected tag and archive.'
}
```

Compare `provenance.commit` with the commit shown for that exact tag in the
trusted GitHub repository. Then extract to another new directory and run the
verifier carried inside the artifact. `Expand-Archive` is not the integrity
gate—the post-extraction exact manifest verification is.

```powershell
$artifact = 'C:\GameServer\Example\Packages\DysonControl-v0.2.0'
if (Test-Path -LiteralPath $artifact) {
  throw 'Use a new empty artifact directory.'
}
Expand-Archive -LiteralPath $archivePath -DestinationPath $artifact

& "$artifact\scripts\windows\release\Test-DysonControlReleaseArtifact.ps1" `
  -ArtifactPath $artifact `
  -ExpectedVersion $version

$expectedArtifactPayloadSha256 = [string]$provenance.artifact.payloadSha256
```

Finally supply the local Node executable and a production configuration that
was created outside the downloaded release. Preview the exact install first;
run the same bounded command without `-WhatIf` only after reviewing its JSON.

```powershell
$runtimeRoot = 'C:\GameServer\Example\DysonControlRuntime\node-current'
$node = 'C:\GameServer\Example\DysonControlRuntime\node-current\node-v24.0.0-win-x64\node.exe'
$expectedNodeSha256 = ('d' * 64) # copied from independently authenticated Node provenance
$config = 'C:\GameServer\Example\Config\dyson-control.env'
$installer = "$artifact\scripts\windows\deployment\Install-DysonControl.ps1"

& $installer `
  -SourcePath $artifact `
  -Version $version `
  -ExpectedArtifactPayloadSha256 $expectedArtifactPayloadSha256 `
  -RuntimeRoot $runtimeRoot `
  -NodeExecutable $node `
  -ExpectedNodeSha256 $expectedNodeSha256 `
  -ConfigurationSource $config `
  -RegisterStartupTask `
  -WhatIf

& $installer `
  -SourcePath $artifact `
  -Version $version `
  -ExpectedArtifactPayloadSha256 $expectedArtifactPayloadSha256 `
  -RuntimeRoot $runtimeRoot `
  -NodeExecutable $node `
  -ExpectedNodeSha256 $expectedNodeSha256 `
  -ConfigurationSource $config `
  -RegisterStartupTask
```

## Configuration and persistent state

The runtime configuration is a UTF-8-without-BOM `KEY=value` file at the fixed
`<DataRoot>\config\dyson-control.env` path. Blank lines and `#` comments are
supported. The checked-in environment contract is an exact allowlist; shell
expansion, quoted commands, duplicate/unknown names, arbitrary process variables,
short secrets, non-loopback host values, and mismatched launcher-owned bindings
are rejected before `-WhatIf`, Task Scheduler registration, or any mutation.

On every launch the stable bootstrap removes inherited `DYSON_*`, `NODE_ENV`,
`NODE_OPTIONS`, and `NODE_PATH` values. It calls the configuration module's
single strict byte-stream parser, consumes its `privateValues` only in memory,
clears the parser byte buffer/value table, and never reparses, serializes, or
logs those values. The verified launcher bindings are then placed into the child
environment:

```text
NODE_ENV=production
DYSON_HOST=127.0.0.1
DYSON_DATA_DIR=C:\GameServer\Example\DysonControlData\data
DYSON_SCRIPT_ROOT=<active release>\scripts\windows
DYSON_RUNTIME_BOOTSTRAP_ROOT=C:\GameServer\Example\DysonControl\bootstrap
DYSON_DEPLOYMENT_VERSION=<active manifest version>
```

The application still performs its own production validation. The installer never
invents an administrator password hash or session secret, and
`-ConfigurationSource` is mandatory for every top-level install. The source must
be a plain local-NTFS file with a protected administrator/SYSTEM-owned ACL. Before
copying bytes, the configuration transaction creates a protected config subtree,
records an intent, uses a same-volume durable staged write and atomic rename, and
writes a chained receipt. Initial creation and byte-identical reuse are supported.
For a different existing configuration, the wrapper captures a protected
preimage before release mutation and supplies it to the replacement transaction.

The stable launcher exports the active manifest version as
`DYSON_DEPLOYMENT_VERSION`. `/healthz` remains a lightweight liveness response.
The deployment transaction instead uses `/readyz`, which binds the same
`deploymentVersion` and `X-Dyson-Control-Release` to successful provider/project
inspection and, when configured, a clean update-activation recovery state. A
surviving old release or a live-but-unready process is rejected.

The top-level wrapper implements protected configuration replacement and restore.
It derives the existing launcher binding from the verified active release,
snapshots configuration B, installs C with that exact protected preimage, and on
later failure snapshots C before restoring exact B. Release, bootstrap, broker,
and task rollback proceeds only after the configuration restore receipt matches
the protected B snapshot. A first-install failure has no predecessor to restore,
so it fails closed while retaining the coherent protected configuration rather
than deleting it. Receipts, status, and reboot checkpoints contain only
configuration hash, byte length, contract/binding/name-set digests, and ACL
fingerprints—never values or snapshot paths.

## Commands

All examples are fictional and deliberately use non-production roots/endpoints.
Run `-WhatIf` first. The normal install/task operations require an elevated Windows
PowerShell process when they target Program Files or Task Scheduler.

### Preview and install

```powershell
$artifact = 'C:\GameServer\Example\Packages\DysonControl-0.2.0'
$installRoot = 'C:\GameServer\Example\DysonControl'
$dataRoot = 'C:\GameServer\Example\DysonControlData'
$runtimeRoot = 'C:\GameServer\Example\DysonControlRuntime\node-current'
$runtimeArchive = 'C:\GameServer\Example\Packages\node-v24.0.0-win-x64.zip'
$nodeRelativePath = 'node-v24.0.0-win-x64\node.exe'
$node = Join-Path $runtimeRoot $nodeRelativePath
$expectedRuntimeArchiveSha256 = ('c' * 64) # copied from independently authenticated Node provenance
$expectedNodeSha256 = ('d' * 64) # independently verified node.exe hash
$config = 'C:\GameServer\Example\Config\dyson-control.env'
$expectedArtifactPayloadSha256 = ('f' * 64) # copied from verified external provenance

& "$artifact\scripts\windows\release\Test-DysonControlReleaseArtifact.ps1" `
  -ArtifactPath $artifact `
  -ExpectedVersion '0.2.0'

& "$artifact\scripts\windows\deployment\Install-DysonNodeRuntime.ps1" `
  -RuntimeArchive $runtimeArchive `
  -ExpectedArchiveSha256 $expectedRuntimeArchiveSha256 `
  -RuntimeRoot $runtimeRoot `
  -NodeRelativePath $nodeRelativePath `
  -ExpectedNodeSha256 $expectedNodeSha256 `
  -InstallRoot $installRoot `
  -DataRoot $dataRoot `
  -WhatIf

& "$artifact\scripts\windows\deployment\Install-DysonControl.ps1" `
  -SourcePath $artifact `
  -Version '0.2.0' `
  -ExpectedArtifactPayloadSha256 $expectedArtifactPayloadSha256 `
  -RuntimeRoot $runtimeRoot `
  -NodeExecutable $node `
  -ExpectedNodeSha256 $expectedNodeSha256 `
  -InstallRoot $installRoot `
  -DataRoot $dataRoot `
  -ConfigurationSource $config `
  -RegisterStartupTask `
  -WhatIf
```

The explicit verifier command is a useful operator-visible check after the
archive and provenance have been independently authenticated. The installer
does not invoke that source-owned verifier. Its trusted deployment common
performs a separate data-only manifest/inventory validation and requires the
externally supplied payload digest above. Remove `-WhatIf` after reviewing the
JSON preview. `-StartAfterInstall` is optional and additionally requires the loopback readiness endpoint
`http://127.0.0.1:13010/readyz`. Without that switch the operator can finish local
configuration and start the fixed task later.

The dedicated runtime installer verifies the ZIP digest while holding the
archive open. For a real run it first creates and protects, or strictly verifies,
RuntimeRoot's dedicated direct-parent container. It then acquires the protected
transaction-root `FileShare.None` lease before reading any pending intent or
current RuntimeRoot state, and holds that lease through recovery, publish,
receipt, backup cleanup, or rollback. Extraction occurs in an operation-named
same-volume staging directory. A protected candidate marker binds operation ID,
stage/runtime path identities, ZIP hash, relative node path, and expected
`node.exe` hash; only a fully verified candidate can be renamed into RuntimeRoot.

The V2 recovery state machine handles interruption after durable intent, after
the verified predecessor moved to its operation backup, after the candidate
moved into RuntimeRoot, and after the durable completion receipt but before
backup cleanup. Before commit it removes only an operation-owned candidate and
restores the exact verified predecessor; after commit it retains the verified
candidate and removes only the verified operation backup. It never interprets
`previousRuntimePresent=false` as authority to delete an arbitrary current
RuntimeRoot. The next installer run performs this recovery under the same lease,
or an operator can run `Repair-DysonNodeRuntime.ps1` explicitly. Recovery output
and durable recovery receipts contain only operation state and hashes, not paths
or configuration values.

An existing runtime upgrade additionally requires
`-PreviousExpectedNodeSha256`; never reuse the new expected hash as proof of the
old bytes. RuntimeRoot remains the stable `node-current` child of its dedicated
container, while the ZIP may carry a changed internal top-level directory.
Review the runtime preview, install it without `-WhatIf`, and then run the
control-plane preview above.

If an interrupted operation must be reconciled explicitly, preview and then run:

```powershell
& "$artifact\scripts\windows\deployment\Repair-DysonNodeRuntime.ps1" `
  -RuntimeRoot $runtimeRoot `
  -InstallRoot $installRoot `
  -DataRoot $dataRoot `
  -WhatIf
```

Remove `-WhatIf` only after reviewing the bounded transaction identities. The
repair executor does not acquire or install new Node bytes.

Control-plane `-WhatIf` resolves and bounds the selected executable file but
never starts it. Immediately before a real installation can create Program
Files/ProgramData state, the installer verifies the protected runtime and
executes only that fixed file with `--version`, with
`NODE_OPTIONS` and `NODE_PATH` removed. The probe has a three-second timeout and
bounded stdout/stderr. It accepts only the exact stable form
`vMAJOR.MINOR.PATCH` and requires `MAJOR` to be at least the minimum carried by
the verified artifact. A filename such as `node.exe` is not treated as proof;
nonzero exit, stderr, prerelease/forged/oversized output, timeout, reparse point,
or an older major all fail closed with one fixed error that contains neither
the executable path nor child-process output.

### Explicit lifecycle- and cutover-broker installation

For a controller installation that registers the startup task and installs or
upgrades either broker, `Install-DysonControl.ps1` acquires the shared application
host-mutation lease before stopping the previous panel task. An active game
mutation blocks that step; the installer does not interrupt it. After the panel
stops producing requests, existing status workers finish naturally within a
bounded wait. The installer does not kill broker workers or discard pending
records; the normal pending-work checks still apply. A failure during this
quiescence stage restores the previous panel task state. After broker and
configuration publication, the lease is released before starting the new panel
so startup recovery can acquire it. Verify this sequence and rollback on the
target host; the implementation alone is not upgrade acceptance evidence.

Neither privileged broker is installed by default. Lifecycle installation is
requested only with `-InstallLifecycleBrokerTask`. It requires an explicit
`ConfigurationSource`, `-RegisterStartupTask`, `-StartAfterInstall`, a loopback
`-ReadinessUri`, and all of `-ProjectRoot`, `-RuntimeBootstrapRoot`,
`-ServiceUser`, `-GamePort`, and `-DispatchReadyTimeout`. The timeout is 5 through
60 seconds. `RuntimeBootstrapRoot` must be exactly `<InstallRoot>\bootstrap`.

The configuration source must contain these exact gates and bindings (plus the
locally created authentication secrets). The values below are fictional:

```text
DYSON_PROVIDER=windows
DYSON_LIFECYCLE_ENABLED=true
DYSON_PROJECT_ROOT=C:\GameServer\Example\DSP
DYSON_DATA_DIR=C:\GameServer\Example\DysonControlData\data
DYSON_LIFECYCLE_BROKER_PROFILE_FILE=C:\GameServer\Example\DysonControlData\data\lifecycle-broker\broker-profile.json
DYSON_RUNTIME_BOOTSTRAP_ROOT=C:\GameServer\Example\DysonControl\bootstrap
DYSON_RUNTIME_SERVICE_USER=.\ExampleGameService
DYSON_GAME_PORT=27015
DYSON_SERVER_TASK=Dyson-Nebula-Server
DYSON_STOP_TASK=Dyson-Nebula-Stop
DYSON_CUTOVER_ENABLED=true
DYSON_CUTOVER_RECOVERY_ENABLED=true
DYSON_CUTOVER_PROFILE_FILE=C:\GameServer\Example\DysonControlData\data\authority-inventory\authority-profile.json
DYSON_CUTOVER_TASK_TRANSACTION_ROOT=C:\GameServer\Example\DysonControlData\runtime-task-transactions
DYSON_CUTOVER_SERVICE_USER=.\ExampleGameService
```

The lifecycle profile is fixed at
`<DataRoot>\data\lifecycle-broker\broker-profile.json`. It binds the broker root,
the active release's `scripts\windows` and `lifecycle-broker` directories, the
stable bootstrap, project and data roots, service account, game port, the two
fixed runtime tasks, and every pinned dependency hash. Its worker is the fixed
`\DysonControl\Dyson-Control-Lifecycle-Broker` task: SYSTEM,
`ServiceAccount`, highest run level, no triggers, `IgnoreNew`, a five-minute
execution limit, and a single profile-bound PowerShell action. Profile,
dependency, task-pair, worker-task, and ACL drift fail closed.

Cutover is a dependent capability, not an alternative broker. Supplying
`-InstallCutoverBrokerTask` without `-InstallLifecycleBrokerTask` in the same
deployment transaction is rejected. Its project, bootstrap, service-user, and
game-port arguments must equal the lifecycle values. The configuration must
also enable both cutover gates and bind the exact authority profile and runtime
task transaction root. The cutover profile binds the newly active release's
`scripts\windows` and exact `cutover-broker` child, and its bundle binding hashes
the exact broker directory. Missing, redirected, extra, or mismatched members
fail closed.

Preview the complete transaction before applying it:

```powershell
$installRoot = 'C:\GameServer\Example\DysonControl'
$dataRoot = 'C:\GameServer\Example\DysonControlData'
$projectRoot = 'C:\GameServer\Example\DSP'
$bootstrapRoot = 'C:\GameServer\Example\DysonControl\bootstrap'
$authorityProfile = 'C:\GameServer\Example\DysonControlData\data\authority-inventory\authority-profile.json'
$taskTransactions = Join-Path $dataRoot 'runtime-task-transactions' # deployment data root
$serviceUser = '.\ExampleGameService'
$gamePort = 27015

& "$artifact\scripts\windows\deployment\Install-DysonControl.ps1" `
  -SourcePath $artifact -Version '0.2.0' `
  -ExpectedArtifactPayloadSha256 $expectedArtifactPayloadSha256 `
  -RuntimeRoot $runtimeRoot `
  -NodeExecutable $node `
  -ExpectedNodeSha256 $expectedNodeSha256 `
  -InstallRoot $installRoot -DataRoot $dataRoot `
  -ConfigurationSource $config -RegisterStartupTask -StartAfterInstall `
  -ReadinessUri 'http://127.0.0.1:13010/readyz' -ReadinessTimeoutSeconds 45 `
  -InstallLifecycleBrokerTask -ProjectRoot $projectRoot `
  -RuntimeBootstrapRoot $bootstrapRoot -ServiceUser $serviceUser `
  -GamePort $gamePort -DispatchReadyTimeout 30 `
  -InstallCutoverBrokerTask -CutoverProjectRoot $projectRoot `
  -CutoverAuthorityProfileFile $authorityProfile `
  -CutoverAuthorityInventoryRevision ('a' * 64) `
  -CutoverRuntimeTaskTransactionRoot $taskTransactions `
  -CutoverServiceUser $serviceUser -CutoverGamePort $gamePort `
  -CutoverRuntimeBootstrapRoot $bootstrapRoot `
  -WhatIf
```

`-WhatIf` validates the artifact, paths, complete environment bindings, and
requested broker modes and returns a bounded JSON plan without running Node,
registering tasks, publishing profiles, starting services, or probing readiness.
Remove only `-WhatIf` after reviewing that plan.

The real transaction has one non-negotiable order:

1. verify and stage the immutable release, atomically activate it, publish the
   stable bootstrap and configuration, and register the control task without
   starting it;
2. install, upgrade, or exactly reuse the lifecycle broker;
3. install, upgrade, or exactly reuse the cutover broker, if requested;
4. start the control task and require exact-version loopback readiness with the
   `lifecycleBroker` check and, for cutover, `cutoverRecovery`.

Cross-release lifecycle changes require
`-UpgradeLifecycleBrokerExisting`; cross-release cutover changes additionally
require `-UpgradeCutoverBrokerExisting`. Same-release replay returns `reused`
after proving the captured profile, dependencies, ACLs, and task are unchanged;
it never needs either upgrade switch and is never compensated.

Those broker upgrade switches do not override the configuration boundary:
cross-version control-plane replacement must first bind and snapshot the exact
configuration associated with the verified old active release.

Later failure compensation follows the receipt, not a guess:

| Lifecycle receipt | Required recovery |
| --- | --- |
| `installed` | Invoke the candidate lifecycle installer with `-CompensateFirstInstall`; remove only the fixed profile and worker task while preserving durable requests and receipts. |
| `reused` | Revalidate the exact preimage; perform no compensation. |
| `upgraded` | Restore the captured broker preimage only after protected configuration B has been restored and release/bootstrap state has rolled back. |

Cutover compensation is completed before lifecycle recovery begins for a fresh
install. Deferred cross-release broker restoration runs only after the protected
configuration predecessor and release/bootstrap state are restored successfully.
On the first configuration creation path, a later readiness or broker failure compensates new
broker/task state but deliberately retains the coherent release, bootstrap, and
protected configuration; the control task remains absent and the error reports
`protected-configuration-restore-executor-unavailable`. Never bypass this state
by editing a profile, bundle binding, task action, DACL, or immutable release
directory.

### Production upgrade

This section documents the executable broker orchestration contract. A
cross-control-plane-version change requires the protected configuration
preimage/install/postimage/restore chain described above, in addition to the
applicable explicit broker upgrade switches.

When either broker is installed, repeat the top-level installer with every
binding and the applicable explicit upgrade switches. Do not call the lower-level
release transaction alone: it does not own the broker profile/task restoration
contract. This fictional example upgrades both brokers:

```powershell
$newArtifact = 'C:\GameServer\Example\Packages\DysonControl-0.3.0'
$newArtifactPayloadSha256 = ('e' * 64) # copied from the verified 0.3.0 provenance
$upgrade = @{
  SourcePath = $newArtifact
  Version = '0.3.0'
  ExpectedArtifactPayloadSha256 = $newArtifactPayloadSha256
  RuntimeRoot = 'C:\GameServer\Example\DysonControlRuntime\node-current'
  NodeExecutable = 'C:\GameServer\Example\DysonControlRuntime\node-current\node-v24.0.0-win-x64\node.exe'
  ExpectedNodeSha256 = ('d' * 64)
  InstallRoot = 'C:\GameServer\Example\DysonControl'
  DataRoot = 'C:\GameServer\Example\DysonControlData'
  ConfigurationSource = 'C:\GameServer\Example\Config\dyson-control.env'
  RegisterStartupTask = $true
  StartAfterInstall = $true
  ReadinessUri = [uri]'http://127.0.0.1:13010/readyz'
  ReadinessTimeoutSeconds = 45
  InstallLifecycleBrokerTask = $true
  UpgradeLifecycleBrokerExisting = $true
  ProjectRoot = 'C:\GameServer\Example\DSP'
  RuntimeBootstrapRoot = 'C:\GameServer\Example\DysonControl\bootstrap'
  ServiceUser = '.\ExampleGameService'
  GamePort = 27015
  DispatchReadyTimeout = 30
  InstallCutoverBrokerTask = $true
  UpgradeCutoverBrokerExisting = $true
  CutoverProjectRoot = 'C:\GameServer\Example\DSP'
  CutoverAuthorityProfileFile = 'C:\GameServer\Example\DysonControlData\data\authority-inventory\authority-profile.json'
  CutoverAuthorityInventoryRevision = ('b' * 64)
  CutoverRuntimeTaskTransactionRoot = 'C:\GameServer\Example\DysonControlData\runtime-task-transactions'
  CutoverServiceUser = '.\ExampleGameService'
  CutoverGamePort = 27015
  CutoverRuntimeBootstrapRoot = 'C:\GameServer\Example\DysonControl\bootstrap'
}

& "$newArtifact\scripts\windows\deployment\Install-DysonControl.ps1" @upgrade -WhatIf
```

After reviewing the preview, run the same command without `-WhatIf`. It obeys
the release/bootstrap/config/control-task -> lifecycle broker -> cutover broker
-> task start/readiness order above. The readiness response must have HTTP
success, `status=ready`, the exact target version in both JSON and
`X-Dyson-Control-Release`, and passing `lifecycleBroker` and `cutoverRecovery`
checks. If this is a lifecycle-only installation, omit all cutover parameters
and `-UpgradeCutoverBrokerExisting`, but keep the lifecycle upgrade switch.

The staged failed version remains inactive for diagnosis. It is never retried
implicitly and does not alter persistent data.

### Explicit rollback

The lower-level release transaction's JSON result contains `snapshotId`. Use
that exact ID rather than guessing `latest` during an incident:

```powershell
$installRoot = 'C:\GameServer\Example\DysonControl'
$deploymentDataRoot = 'C:\GameServer\Example\DysonControlData'
$runtimeRoot = 'C:\GameServer\Example\DysonControlRuntime\node-current'
$node = Join-Path $runtimeRoot 'node-v24.0.0-win-x64\node.exe'
$expectedNodeSha256 = ('d' * 64) # same independently verified node.exe hash as installation

& .\scripts\windows\deployment\Invoke-DysonControlDeployment.ps1 `
  -Operation Rollback `
  -InstallRoot $installRoot -DataRoot $deploymentDataRoot `
  -RuntimeRoot $runtimeRoot -NodeExecutable $node `
  -ExpectedNodeSha256 $expectedNodeSha256 `
  -SnapshotId '20300101-000000000-1a2b3c4d' `
  -RestartControlTask `
  -ReadinessUri 'http://127.0.0.1:13010/readyz' `
  -WhatIf
```

Before restoring the requested snapshot, rollback creates a guard snapshot of the
current state. If the requested snapshot or readiness validation fails, the script
restores that guard. The output reports `guardSnapshotId`, making the rollback
itself reversible.

This standalone command applies only when no lifecycle or cutover broker profile
is installed. Once a lifecycle broker exists, changing the active release also
requires broker-aware handling; the lower-level rollback command alone would
leave a release-bound profile inconsistent. Failed top-level upgrades use the
automatic old-release restoration contract described above. Do not improvise a
manual profile/task rewrite as a substitute.

### Read-only validation

```powershell
& .\scripts\windows\deployment\Test-DysonControlDeployment.ps1 `
  -InstallRoot 'C:\GameServer\Example\DysonControl' `
  -DataRoot 'C:\GameServer\Example\DysonControlData' `
  -RuntimeRoot 'C:\GameServer\Example\DysonControlRuntime\node-current' `
  -NodeExecutable 'C:\GameServer\Example\DysonControlRuntime\node-current\node-v24.0.0-win-x64\node.exe' `
  -ExpectedNodeSha256 ('d' * 64) `
  -IncludeTask `
  -ReadinessUri 'http://127.0.0.1:13010/readyz'
```

This checks the layout, active pointer, payload hash, local configuration, stable
launcher, optional startup-task shape, and lifecycle broker static consistency.
When lifecycle is enabled, the fixed profile must be bound to the active release,
environment, stable bootstrap, project/data roots, service user, game port,
pinned dependencies, runtime task pair, and exact worker task, with no pending,
orphaned, or unknown broker state. When lifecycle is disabled, a residual profile,
task, pending item, orphan, or unknown entry fails the `disabled-clean` check.
Supplying `-ReadinessUri` additionally requires the deep `lifecycleBroker` and
`cutoverRecovery` checks. The command does not modify the host. Run the isolated
contract gate with `npm run deployment:status-selftest`.

### Uninstall

```powershell
& .\scripts\windows\deployment\Uninstall-DysonControl.ps1 `
  -InstallRoot 'C:\GameServer\Example\DysonControl' `
  -DataRoot 'C:\GameServer\Example\DysonControlData' `
  -RuntimeRoot 'C:\GameServer\Example\DysonControlRuntime\node-current' `
  -NodeExecutable 'C:\GameServer\Example\DysonControlRuntime\node-current\node-v24.0.0-win-x64\node.exe' `
  -ExpectedNodeSha256 ('d' * 64) `
  -WhatIf
```

The default real run holds the same deployment lease used by install and upgrade.
Before any mutation it validates both installed brokers. Cutover must have no
pending request/intent/work and must match the active release, profile, bundle,
task, and DACL. Lifecycle must match the same active release, pinned dependency
hashes, runtime task pair, profile/profile ACL, and worker task/task ACL, and its
request and receipt directories must contain only closed pairs with an empty
intent directory and no orphaned or unknown entry. Drift or pending/unknown state
rejects the whole uninstall before the control task or release is changed.
The independent Node runtime is verified but preserved by default, even when
`-RemoveData` is explicitly authorized; runtime removal is a separate operator
decision and is never implied by control-plane uninstall.

Normal lifecycle removal invokes the active release's broker installer with
`-RemoveCurrent -ExpectedProfileHash <captured-lowercase-sha256>`. The expected
hash is mandatory and those switches are mutually exclusive with
`-UpgradeExisting` and `-CompensateFirstInstall`. After revalidating the complete
preimage, it removes only the fixed lifecycle profile and worker task and returns
the bounded `DYSON_CONTROL_LIFECYCLE_BROKER_REMOVAL_RECEIPT_V1`. Requests,
receipts, the empty intents directory, installation/removal evidence, deployment
audit, recovery sentinels, cutover/authority evidence, and game-manager data are
preserved. Cutover normal removal likewise removes only its fixed task/profile/
binding.

After both read-only broker preflights succeed, uninstall requires the fixed
control task to be globally unique at its fixed root task path, then stops and
removes only that task first. This quiesces the request entry point so no new work
can arrive while broker state is being removed. It next invokes cutover
`RemoveCurrent`, invokes lifecycle
`-RemoveCurrent -ExpectedProfileHash <captured-lowercase-sha256>`, and only then
moves the install tree into a
timestamped `<DataRoot>\snapshots\uninstall-releases\<id>` directory, and
preserves the data root. The JSON result contains the task XML and
release-backup locations. The active pointer is moved to a separately reported
uninstall-state backup so a later reinstall does not inherit a stale pointer.
Restoring those exact artifacts is the defined uninstall rollback. InstallRoot
and DataRoot must be on the same volume for this atomic, recoverable move;
otherwise uninstall fails without removing the existing layout.

The early control-task step is request-entry quiescence, not a reversal of broker
dependency order. Among brokers, the dependent cutover broker is still removed
before lifecycle.

If task removal stops the task but a later unregister or filesystem step fails,
the rollback restores the release tree, active pointer, bootstrap/configuration,
and data ACL first; restores and verifies lifecycle; then restores and verifies
cutover; and only then restores the exact control-task XML and its prior Running
or non-Running state. A broker restoration failure blocks the control-task
restart. It never restarts the old task against an incompletely restored state.

`-RemoveData` is a separate, explicit destructive choice. It is rejected while
retained lifecycle-broker, cutover-broker, or authority evidence exists; that
evidence is never implicitly deleted by control-plane uninstall. Otherwise it
removes the complete data root, including the recoverable release copy, after the
uninstall audit is written while the external deployment lease is still held. It does not
remove the DSP project, game saves, Steam files, or any game task.

## DataRoot recovery bundles

The packaged `scripts\windows\data-recovery` tools provide an independent,
private full-DataRoot recovery transaction. They require the control task to be
quiesced, the shared host-mutation lease to be available, broker request/receipt
history to be terminal, broker/recovery intents to be empty, SQLite WAL/SHM to
be absent, save pairs to be complete, and the entire bounded tree to be free of
reparse points. Creation and restoration both support non-mutating `-WhatIf`.
An approved restore also requires a literal confirmation phrase, automatically
creates and verifies a protection point, publishes through a same-volume
directory swap, and restores the byte- and ACL-exact original directory after
an injected or observed failure.

See [Dyson Control DataRoot recovery bundles](DATAROOT-RECOVERY.md) for the exact
bundle format, fictional commands, manifest-digest handling, and the boundary
between repository Shadow validation and private production acceptance.

## GSManager parallel-migration snapshot and restore

The verified release artifact includes the exact scripts under
`scripts\windows\migration` plus this guide and `docs\GSM-EVALUATION.md`. These
scripts prepare a recoverable parallel deployment. They do not disable, remove,
or switch away from GSManager and they do not authorize production cutover.

Use fictional paths below to understand the contract. On a real host, obtain the
opaque ID and SHA-256 digest from an independently completed Dyson Control
paired-save protection point. The migration snapshot only verifies that manifest;
it never opens or copies the `.dsv`/`.server` pair.

```powershell
$artifact = 'C:\GameServer\Example\Packages\DysonControl-v0.2.0'
$project = 'C:\GameServer\Example\DSP'
$gsm = 'C:\GameServer\Example\DSP\tools\ExampleGameManager'
$deploymentDataRoot = 'C:\GameServer\Example\DysonControlData'
$appDataRoot = Join-Path $deploymentDataRoot 'data'
$recoverySnapshotRoot = Join-Path $appDataRoot 'migration\snapshots'
$protectionId = 'save:00000000-0000-4000-8000-000000000001'
$protectionDigest = '0000000000000000000000000000000000000000000000000000000000000000'
$migration = "$artifact\scripts\windows\migration"

& "$migration\Get-DysonGsManagerMigration.ps1" `
  -ProjectRoot $project -GsManagerRoot $gsm

& "$migration\New-DysonGsManagerSnapshot.ps1" `
  -ProjectRoot $project -GsManagerRoot $gsm -DataRoot $appDataRoot `
  -PairedSaveProtectionPointId $protectionId `
  -PairedSaveProtectionManifestSha256 $protectionDigest `
  -WhatIf
```

Review the redacted preview, then run the same snapshot command without
`-WhatIf`. Preserve its opaque `snapshotId` and `snapshotManifestSha256` outside
the snapshot tree. Verification rehashes every byte and requires the exact
schema and exact file set:

```powershell
& "$migration\Test-DysonGsManagerSnapshot.ps1" `
  -DataRoot $appDataRoot `
  -SnapshotId '<opaque snapshot UUID>' `
  -ExpectedSnapshotManifestSha256 '<64-character snapshot manifest SHA-256>'
```

The fixed snapshot layout is `$recoverySnapshotRoot\<snapshotId>`, or
`<application DataRoot>\migration\snapshots\<snapshotId>`. Snapshot creation,
verification, restoration, and the later GSManager removal procedure must all
use the same `$appDataRoot`; the deployment root is not the snapshot lookup root.
A same-parent private staging tree
is completely copied, re-inventoried, manifested, and self-verified before one
directory rename publishes it. Failure removes the bounded partial directory and
never publishes a half snapshot. Its protected ACL admits only the creating
identity, local Administrators, and SYSTEM. GSManager settings and scheduled-task
XML remain inside that private tree. JSON output contains only opaque IDs,
counts, SHA-256 values, and statuses—never a path, command, account, XML, or file
content.

Both source and destination must be ordinary non-reparse paths. `GsManagerRoot`
is required to be a strict child of `ProjectRoot`; it cannot be a filesystem root
or overlap `DataRoot\migration`. The snapshot refuses reparse points, source
changes during copy, `.dsv`/`.server`, unknown entries, more than the configured
file count, more than the configured total bytes, or a file above the configured
single-file bound. The verifier repeats the complete inventory and rejects a
changed manifest, payload byte, extra file, missing file, or redirected entry.

Restore has a stronger gate. Start with `-WhatIf`; it does not create a guard or
write the target:

```powershell
& "$migration\Restore-DysonGsManagerSnapshot.ps1" `
  -ProjectRoot $project -GsManagerRoot $gsm -DataRoot $appDataRoot `
  -SnapshotId '<opaque snapshot UUID>' `
  -ExpectedSnapshotManifestSha256 '<64-character snapshot manifest SHA-256>' `
  -PairedSaveProtectionPointId $protectionId `
  -PairedSaveProtectionManifestSha256 $protectionDigest `
  -Confirmation 'RESTORE_GSMANAGER_SNAPSHOT' `
  -WhatIf
```

An actual restore requires an elevated Administrator PowerShell process. It also
requires the `Dyson-Control-Plane` scheduled task to exist but not be running,
rejects any running or ambiguous `DSPGAME.exe`, and rejects a running GSManager
task (default name `Dyson-GSManager`). The caller may supply another bounded task
name explicitly. The target must be missing, empty, or already byte-identical to
the verified snapshot; a non-empty different GSManager tree is never overwritten.

Before root or task mutation, restore atomically publishes a private guard below
`DataRoot\migration\restore-guards\<guardId>` containing the prior bounded root
and task XML/state. The root is staged beside its destination for atomic rename.
If task registration/state restoration or a later phase fails, task and root are
compensated from the guard. A successful restore retains the opaque guard for
manual recovery and does not start DSP, Dyson Control, or GSManager. Restoring an
absent/disabled task state is possible only as part of this explicit,
digest-bound restore; there is no standalone silent remove/disable/switch mode.

Run the temporary, non-production fixture before clean-host evaluation:

```powershell
powershell.exe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass `
  -File "$migration\SelfTest-DysonGsManagerMigration.ps1"
```

The fixture covers no-write previews, atomic publication, protection binding,
tamper/extra/reparse and limit rejection, save exclusion, output redaction,
restore conflict, guard verification, injected failure compensation, and proof
that fictional GSM/game/save markers survive. It shadows Task Scheduler and does
not verify a real host. Clean-host and target-host restore rehearsals remain
required; `OSS-001` therefore stays `implemented`, not `verified`.

## GSManager recoverable removal

The release also packages a separate, fixed-root GSManager removal transaction.
It is not part of snapshot creation and it is not an automatic cutover action.
Only after the candidate authority is healthy, the old authority is disabled and
inactive, the GSManager snapshot and paired-save protection point verify, and all
cutover/authority/runtime/removal mutations are terminal can an elevated operator
preview the removal. The real operation additionally requires the literal
`REMOVE_GSMANAGER_INSTALLATION` confirmation phrase.

The tool moves the installation into a private same-volume guard, preserves the
exact tree and ACL intent plus scheduled-task XML/enabled state/DACL, unregisters
the already-disabled old task, and writes bounded idempotent receipts.
Any later failure compensates the exact bytes, ACLs, and task preimage. A
separate, receipt-bound restore requires the candidate to be quiesced and the
literal `RESTORE_GSMANAGER_REMOVAL` phrase. It restores the old task only as
disabled and reports `activationRequired`; it never starts or re-enables either
authority.

See [Recoverable GSManager removal](MIGRATION-GSMANAGER.md) for the complete
fictional `-WhatIf`, confirmed removal, inspection, rollback, and
restore-disabled procedure. The repository self-test is Shadow-only; no target
host or production removal is evidenced, so `CUT-003` remains `not-started`.

## Bridge source-to-private-candidate deployment

Controller and running Bridge versions can be managed separately. Set
`DYSON_BRIDGE_PLUGIN_VERSION` explicitly in the protected configuration source
to the installed plugin version whose protocol compatibility has been verified
with the selected controller. The lifecycle heartbeat check requires that exact
version; this setting does not disable signature or runtime checks. A
controller-only reader fix therefore need not replace the Bridge or restart the
game solely to align release labels. Omitting the setting uses the controller's
default expected plugin version. Do not infer compatibility from a version pin:
verify the signed heartbeat and the affected save/runtime evidence before
accepting the combination.

The main control-plane release never redistributes the licensed game/mod
reference assemblies. It carries only the exact Bridge sources, `net472`
project, disabled template, and scripts under `scripts\windows\bridge`. Build a
private candidate on the target Windows host while the lawful DSP/Nebula/BepInEx
tree is present:

```powershell
$artifact = 'C:\GameServer\Example\Packages\DysonControl-v0.1.0-rc.1'
$server = 'C:\GameServer\Example\DSP\server'
$candidate = 'C:\GameServer\Example\Private\DysonControlBridge-0.1.0-rc.1'

& "$artifact\scripts\windows\bridge\Build-DysonControlBridgeCandidate.ps1" `
  -SourcePath "$artifact\integrations\dyson-control-bridge" `
  -DysonServerRoot $server `
  -OutputPath $candidate `
  -ExpectedVersion '0.1.0-rc.1' `
  -WhatIf
```

The real build reads only the fixed reference paths from the source project,
rejects reparse points, path escape, missing, non-managed, empty, or oversized
assemblies, and records only reference filenames, relative paths, managed
names/versions, lengths, and SHA-256 values. It invokes the exact resolved
`dotnet` host without a shell, using fixed Release/net472/deterministic
parameters, bounded output, a timeout, and isolated temporary build paths. The
published private directory contains exactly `DysonControlBridge.dll` and
`bridge-manifest.json`; it contains no PDB or reference assembly.

Candidate verification rechecks the exact two-file inventory, manifest schema,
source receipts, DLL GUID/version/assembly/file version/hash, and every current
local reference receipt. Stop the exact `DSPGAME.exe` from `$server` before
install or uninstall. Both operations query that exact image and fail closed if
its state cannot be established.

```powershell
& "$artifact\scripts\windows\bridge\Test-DysonControlBridgeCandidate.ps1" `
  -CandidatePath $candidate -DysonServerRoot $server -ExpectedVersion '0.1.0-rc.1'

& "$artifact\scripts\windows\bridge\Install-DysonControlBridge.ps1" `
  -CandidatePath $candidate -DysonServerRoot $server `
  -ControlServiceSid 'S-1-5-19' `
  -GameServiceSid '<SID of the dedicated interactive DSP account>' `
  -WhatIf
```

For a game directory on a share, explicitly select a dedicated private runtime
directory on the **game VM's** local NTFS volume with
`-PrivateRuntimeRoot 'C:\ProgramData\ExampleBridge\current'`. Its direct parent
must be a dedicated container, not a shared directory such as ProgramData.
This does not relocate the
game, plugin DLL, or saves. The private layout stores the secret at
`C:\ProgramData\ExampleBridge\current\dyson-control-bridge.secret` and protocol files
under `C:\ProgramData\ExampleBridge\current\control`; configure the control plane's
`DYSON_BRIDGE_SECRET_FILE` and `DYSON_BRIDGE_CONTROL_ROOT` with those respective
paths. Use the same explicit option for the approved install after preview.
The installation state binds this layout so verification and recoverable
uninstall/restore can distinguish it from the legacy server-tree layout.

With the default legacy layout, installation writes only the fixed
`BepInEx\plugins\dyson-control-bridge` plugin location and fixed BepInEx config,
state, audit, secret, control-tree, and snapshot names. The old DLL/config/state are
snapshotted before same-directory atomic publication. The generated secret has
48 random bytes, is never returned or stored in either manifest, and receives a
protected exact ACL. The distinct control/game SIDs are mandatory. LocalService
can atomically create and rename request files and read signed root/receipt
outputs, but cannot access private processing/archive directories; the game
account can process and publish the complete fixed protocol. Any failure restores
the previous DLL/config/state and DACLs and removes only a newly generated
secret/empty control directories. The installed config always starts with
`Enabled = false`; the scripts never start or restart DSP.

A successful `-WhatIf` does not prove that the target filesystem can preserve
these ACLs: it deliberately does not write a secret or exercise `Set-Acl`.
An SMB/NAS mapping may accept a write but normalize the resulting permissions
differently from local NTFS. If installation reports an exact-ACL mismatch,
do not enable the plugin or weaken the verifier. Inspect the failed transaction
and independently confirm the previous DLL/config/state and secret preimage
were restored. Keep game/save storage in its configured location; qualify the
private communication storage separately under the actual control and game
identities before retrying installation.

`Test-DysonControlBridgeInstallation.ps1` is read-only. The uninstall script is
dry-run capable, snapshots the current DLL/config/state, preserves the secret,
and returns a snapshot ID that its explicit `-RestoreSnapshotId` mode can verify
and restore. Neither path deletes saves, the game, Nebula, BepInEx, GSM/GSManager,
or Bridge control data. The repository Bridge self-test uses only temporary
controlled assemblies; a successful full plugin compilation remains a
target-host boundary because proprietary references are intentionally absent.

## Startup task

`Install-DysonControlTask.ps1` registers one fixed AtStartup task named
`Dyson-Control-Plane`. Its default identity is the built-in Local Service account,
with `ServiceAccount` logon and limited run level, so no interactive/RDP session is
required. The task has one Windows PowerShell action pointing to the stable
launcher; the launcher then starts the exact verified Node executable and the active
manifest-bound API entry point.

Registration, status, and reboot acceptance use one complete task contract:
the root task path and exact task name; Local Service; `ServiceAccount` and
`Limited`; one enabled AtStartup trigger; one exact action with an empty working
directory and no secret argv; `Enabled`; `IgnoreNew`; restart count 5 at one-minute
intervals; zero execution time limit; `StartWhenAvailable`; and the required
Ready/Running state for that phase. A principal, trigger, action, setting, or
runtime-state drift fails closed instead of being hashed into acceptance evidence.

Task installation reads the Node minimum from the verified active immutable
release and performs the same runtime-root identity, ordinary-path, exact-hash,
protected-DACL, and version probe, plus a complete protected-configuration test,
before stopping an existing task, writing audit state, or registering a
replacement. The task action binds all three runtime arguments and only the fixed
configuration path; it carries no secret value. Its
`-WhatIf` path does not execute Node. The stable launcher repeats the probe on
every task start before it changes the child environment or runs the API, so a
replaced, downgraded, forged, timed-out, or anomalous executable cannot rely on
an earlier installation-time check. Runtime evidence is retained in deployment,
task, status, readiness, and reboot-acceptance records; it is not injected as an
unrecognized `DYSON_*` application setting.

The task installer backs up the task definition and restores it if task
registration or fixed-definition verification itself fails. A later top-level
readiness failure after protected replacement removes the replacement task,
snapshots the candidate configuration, restores the predecessor, rolls back the
release/bootstrap state, and only then restores an eligible previous task. A
failure after first protected configuration creation still leaves the control
task absent because no predecessor exists. The top-level installer creates DataRoot with
a protected DACL: SYSTEM and Administrators have FullControl, Local Service has
only root ReadAndExecute, and one inherit-only Modify ACE reaches ordinary data,
logs, audit, state, and snapshot descendants. Local Service has no root
Delete/DeleteChild/ACL/owner right. The config and configuration-transaction
subtrees replace inheritance with their own protected read-only/private ACLs.
Task installation never broadens DataRoot ACLs, and DataRoot ACL changes cannot
grant write access to the independently protected Node RuntimeRoot.
Repository fixtures create ordinary `data` and `logs` descendants and verify the
intended inherited Modify boundary structurally. Effective-access execution under
a real Local Service token remains an elevated target-VM qualification gate and
is not claimed by the repository-only self-test.

The task description explicitly records that it does not start or stop the game.
No task named `Dyson-Nebula-Server`, `Dyson-Nebula-Stop`, or any GSManager task is
queried or changed by this deployment directory.

The installer atomically creates `bootstrap\bootstrap-layout.json` with an exact,
path-identity-verified binding to the selected deployment data root. Stable game
entry points refuse a missing, redirected, malformed, tampered, or mismatched
layout and never infer the root from `%ProgramData%`; custom installs therefore
use the same fail-closed path as the production default.

The separate `Install-DysonRuntimeTasks.ps1` command owns the game task pair.
It writes one durable intent before changing either task, treats the pair as one
transaction, restores the complete prior pair on a proved-safe failure, and
requires explicit recovery after an interrupted or uncertain handoff. Both task
actions point to the stable bootstrap rather than an immutable release. The
bootstrap verifies the active pointer, complete release manifest/inventory, and
the exact start/stop script hashes, then keeps a durable binding to that release
until the managed game exits or is stopped. An upgrade can therefore move the
control-plane pointer without making a running release call a different
release's stop script.

A managed process exit code of zero is not sufficient evidence of an intentional
stop. Only the stable `Stop-DysonServer.ps1` wrapper may create the fixed
`DYSON_CONTROL_GAME_EXPECTED_EXIT_V1` record. It publishes `requested` with the
exact binding ID, immutable release version, project-root SHA-256, and
data-root identity, invokes the pinned stop script from that bound release, and
changes the same record to `completed` only after that stop succeeds. The
transition is crash-safe: canonical JSON and ACL intent are verified across the
fixed pending, recovery, and rollback-discard files, and retrying the same bound
request is idempotent.

The ACL comparison binds owner and primary-group SIDs, the DACL protection
state, and the binary DACL ACE list. NTFS is allowed to normalize only its
automatic-inheritance bookkeeping flag during `File.Replace`; permissions,
inheritance ACEs, ownership, and protection remain fail-closed.

The attached start wrapper consumes one matching `completed` record after the
child returns zero. Missing, still-`requested`, malformed, redirected, multiple,
or cross-binding state yields `BOOTSTRAP_UNEXPECTED_CLEAN_EXIT`, an abnormal
runtime receipt when persistence is available, and exit code 1 so the pinned
three-attempt/one-minute Task Scheduler recovery policy applies. Startup also
reconciles a prior release binding through that release's pinned stop script
before selecting the current active release. It never infers that an ambiguous
or manually edited intent is clean. Once the completed intent has been consumed,
a clean-receipt storage failure is reported as `receiptPersisted=false` but does
not force a restart of an intentionally stopped server; abnormal failures remain
exit code 1 even when their receipt cannot be persisted.

For manual recovery, first keep both game tasks and the managed process
quiesced. Preserve the durable binding and all canonical/pending/recovery/
rollback-discard expected-exit artifacts; do not delete, rename, or edit them to
force startup. Re-enter only through the fixed bootstrap using the same exact
binding and request. If its byte, ACL, or full-field recovery rules cannot prove
one unambiguous state, leave the runtime fail closed and retain the private
artifacts for investigation.

For a parallel installation while GSManager still owns production, preview and
apply only `PrepareDisabled` from an administrator PowerShell session:

Initialize the separate GSManager authority before replacing its legacy task
definitions. Use the application data directory for authority initialization:

| Command or setting | Data directory in the example layout |
| --- | --- |
| `Install-DysonControl.ps1 -DataRoot` | `C:\GameServer\Example\DysonControlData` |
| `DYSON_DATA_DIR` | `C:\GameServer\Example\DysonControlData\data` |
| `Initialize-DysonGsManagerAuthority.ps1 -DataRoot` | `C:\GameServer\Example\DysonControlData\data` |
| Authority profile consumed by the API | `C:\GameServer\Example\DysonControlData\data\authority-inventory\authority-profile.json` |
| Runtime-task transaction root (default) | `C:\GameServer\Example\DysonControlData\runtime-task-transactions` |
| GSManager recovery snapshot directory | `C:\GameServer\Example\DysonControlData\data\migration\snapshots` |

The top-level installer derives this application directory by appending `data`
to its deployment data root. Keep the runtime-task transaction root identical
across authority initialization, the API configuration, and broker installation.

If the candidate pair has already been prepared, the initializer
also accepts `-PreparedLegacyTemplateRoot` and
`-ExpectedLegacyTemplateSha256`. That directory must contain only
`legacy-server.xml` and `legacy-stop.xml`, defining the fixed legacy scripts
under the configured project. The digest is SHA-256 of the UTF-8 text
`<lowercase server byte hash>:<lowercase stop byte hash>`. The initializer
checks that both current candidate tasks are disabled and match the installed
bootstrap, retains their real preimages, and creates separate GSManager task
entries from the templates. It records `authoritySource=reconstructed-template`
and the template digest; these templates are new desired definitions, not
historical task backups. Preview the same request with `-WhatIf` before applying.

The lifecycle broker can be installed while both candidate tasks are Disabled.
Installation validates their complete definitions and records the expected
active definitions without enabling the tasks. Mixed enabled/disabled pairs
are rejected. The broker worker still requires both tasks to be active before
dispatching a game operation; deployment readiness alone does not activate them.

Before preparing game tasks, provision the separate game account's bootstrap
state access with `scripts/windows/deployment/Set-DysonGameBootstrapAccess.ps1`
from Windows PowerShell 5.1. Pass the installed `-BootstrapRoot` and the same
`-GameServiceSid` used for Bridge installation; run `-WhatIf` first. The game
must be stopped. The command grants state reads and creation of game-owned
state files without granting write access to the active release pointer. It
records the previous descriptors below `DataRoot/game-access-snapshots` and
supports `-RestoreSnapshotId` with the returned `-ExpectedSnapshotSha256` while
the stopped state tree is unchanged. Repeating an already-applied grant is a
no-op. Verify the actual game account can read the bootstrap context and write
its own state before activating its tasks.

```powershell
$runtimeRequest = [guid]::NewGuid().ToString('D')
$project = 'C:\GameServer\Example\DSP'
$data = 'C:\GameServer\Example\DysonControlData\data'
$bootstrap = 'C:\GameServer\Example\DysonControl\bootstrap'

& .\scripts\windows\Install-DysonRuntimeTasks.ps1 `
  -ProjectRoot $project -DataRoot $data -StableScriptRoot $bootstrap `
  -ServiceUser '.\ExampleGameService' -Mode PrepareDisabled `
  -RequestId $runtimeRequest -WhatIf

& .\scripts\windows\Install-DysonRuntimeTasks.ps1 `
  -ProjectRoot $project -DataRoot $data -StableScriptRoot $bootstrap `
  -ServiceUser '.\ExampleGameService' -Mode PrepareDisabled `
  -RequestId $runtimeRequest
```

`PrepareDisabled` publishes both final definitions as Disabled from their first
native registration; it never starts a task. Do not manually run `Activate`
while GSManager has any task, service, startup entry, process, or port authority.
Activation belongs inside the later cutover transaction, after it has durably
captured the old authority, protected the paired save, disabled every old
startup source, and proved zero managed processes and zero game-port listeners.
That coordinator passes the same `DataRoot` and borrows its already-held global
host-mutation lease with the fixed `-LeaseInstanceId/-LeaseToken` pair.

If the command reports that explicit recovery is required, repeat the exact
request and arguments with `-Recover`; do not invent a new request ID. The
transaction writes private task preimages to a fixed `-TaskBackupRoot` when one
is configured. Otherwise it derives `runtime-task-transactions` beside the
selected `DataRoot` (for the production layout,
`C:\GameServer\Example\DysonControlData\runtime-task-transactions`) and never falls back to
the process `%ProgramData%`. Receipts never print XML or local paths. The
installer retains completed transaction preimages in its private `completed`
directory. To undo a successful installation, pass the original deployment
arguments and mode, `-RestoreCompletedRequestId` with its original request ID,
and a new `-RequestId`. Preview with `-WhatIf` first. This creates a separate
rollback receipt and preserves the original evidence. It restores the archived
Enabled state, so an old enabled task becomes enabled again. For an interrupted
rollback, repeat its new request ID and exact arguments with `-Recover`.
Older installations without a completed archive cannot be restored from a
receipt alone. The isolated regression gates are:

```powershell
npm run runtime-tasks:selftest
npm run game-bootstrap:selftest
npm run game-bootstrap:access-selftest
npm run cutover:selftest
```

The access suite uses real ACLs on temporary local directories. The other suites
use file-backed fake scheduler/runtime fixtures and temporary fictional
roots only; they do not touch the native Task Scheduler, Steam, DSP, saves,
GSManager, or production processes. `cutover:selftest` includes the authority,
host, and 38-case cutover-broker suites. The broker suite covers cross-release
commit, exact-request and same-release idempotence, six injected rollback
stages, restored-old-broker usability, first-install compensation, safe current
removal with pending/drift refusal and failure rollback, bundle tamper, and
reparse rejection.
Release self-testing additionally runs
the broker self-test from inside the assembled artifact and rejects each missing
member or any extra member of the exact six-file broker directory.

This no-RDP guarantee applies to the Dyson Control API/web task only. The
separate game-runtime installer currently defines an interactive
`Dyson-Nebula-Server` task with an AtLogOn trigger because the licensed Unity
game process and Steam session have a different runtime boundary. The repository
includes an explicit automatic-interactive-session transaction for a dedicated
local account. It does not turn DSP, Steam, or Unity into a Windows service and
does not start a process during configuration.

Use an administrator PowerShell session and enter the dedicated local account
password only through `Get-Credential`:

```powershell
$credential = Get-Credential -UserName '.\ExampleGameService'
$runtimeBootstrap = 'C:\GameServer\Example\DysonControl\bootstrap'

& .\scripts\windows\session\Configure-DysonInteractiveSession.ps1 `
  -Credential $credential -RuntimeBootstrapRoot $runtimeBootstrap -WhatIf

& .\scripts\windows\session\Configure-DysonInteractiveSession.ps1 `
  -Credential $credential -RuntimeBootstrapRoot $runtimeBootstrap

& .\scripts\windows\session\Test-DysonInteractiveSession.ps1 `
  -Credential $credential -RuntimeBootstrapRoot $runtimeBootstrap
```

The configuration script accepts no task name, executable, project-root, or
command parameters. Its only path parameter is the already installed stable
runtime-bootstrap root; it validates the existing fixed `Dyson-Nebula-Server` task and
dedicated local account, stores the Winlogon password as LSA private data, writes
an ACL-restricted rollback record, and reports that activation requires the next
boot or an explicit user logon. LSA private data prevents ordinary registry
disclosure; it is not a boundary against a local administrator, who can retrieve
the secret. A configured legal-notice banner blocks the transaction because it
can prevent automatic logon.

To preview or perform a rollback:

```powershell
& .\scripts\windows\session\Disable-DysonInteractiveSession.ps1 -WhatIf
& .\scripts\windows\session\Disable-DysonInteractiveSession.ps1
```

The scripts never reboot, log on, log off, start a task, or start the game.
Therefore the repository still does not claim that DSP/Nebula starts after boot
until a separately approved real reboot proves a non-Session-0 interactive
session, the exact AtLogOn task, duplicate-instance prevention, and game health.
`SRV-002` remains only `implemented` until that production evidence exists.
The offline transaction/rollback fixture runs as `npm run session:selftest` and
is included in the root `npm run check` gate; it deliberately reports that
native LSA runtime and real boot validation are still required.

## Reboot-resume acceptance checkpoint

The deployment directory includes a bounded two-command protocol for an
operator-approved reboot drill. It does not initiate a reboot, register or run
a task, log on, or change the game/control processes. The first command proves a
healthy pre-reboot baseline and, unless run with `-WhatIf`, creates one immutable
checkpoint beneath `DataRoot\acceptance\reboot-checkpoints`. The checkpoint is
restricted with the deployment backup ACL and binds the current host/boot,
active release and payload, exact protected Node runtime identity/hash, exact
control task, game project/account identities, port, both tasks' baseline
last-run times, creation time, and expiry. Its
SHA-256 field detects accidental or local content corruption; it is not a
signature and does not replace a private acceptance evidence bundle.

This runtime-bound checkpoint format is schema version 2. Earlier checkpoint
files are intentionally not upgraded in place; create a fresh checkpoint with
the current scripts before the approved reboot drill.

Both checkpoint creation and resume require the lifecycle broker's static state
to be `ready`, including its active-release/environment/profile/task/dependency
bindings and clean durable channel. Both also call `/readyz` with the required
checks `lifecycleBroker` and `cutoverRecovery`; an HTTP-ready application with
either check absent or failing is rejected. This gate is stricter than the
ordinary read-only status command's lifecycle-disabled `disabled-clean` state.

Preview first, then create the checkpoint only on the intended validation host:

```powershell
& .\scripts\windows\deployment\New-DysonRebootAcceptanceCheckpoint.ps1 `
  -InstallRoot 'C:\GameServer\Example\DysonControl' `
  -DataRoot 'C:\GameServer\Example\DysonControlData' `
  -RuntimeRoot 'C:\GameServer\Example\DysonControlRuntime\node-current' `
  -NodeExecutable 'C:\GameServer\Example\DysonControlRuntime\node-current\node-v24.0.0-win-x64\node.exe' `
  -ExpectedNodeSha256 ('d' * 64) `
  -GamePort 27015 `
  -ReadinessUri 'http://127.0.0.1:13010/readyz' `
  -WhatIf

$checkpointJson = & .\scripts\windows\deployment\New-DysonRebootAcceptanceCheckpoint.ps1 `
  -InstallRoot 'C:\GameServer\Example\DysonControl' `
  -DataRoot 'C:\GameServer\Example\DysonControlData' `
  -RuntimeRoot 'C:\GameServer\Example\DysonControlRuntime\node-current' `
  -NodeExecutable 'C:\GameServer\Example\DysonControlRuntime\node-current\node-v24.0.0-win-x64\node.exe' `
  -ExpectedNodeSha256 ('d' * 64) `
  -GamePort 27015 `
  -ReadinessUri 'http://127.0.0.1:13010/readyz'
$checkpoint = $checkpointJson | ConvertFrom-Json
```

After a separately authorized real guest reboot, resume with the exact returned
ID and the same roots:

```powershell
& .\scripts\windows\deployment\Test-DysonRebootAcceptanceResume.ps1 `
  -InstallRoot 'C:\GameServer\Example\DysonControl' `
  -DataRoot 'C:\GameServer\Example\DysonControlData' `
  -RuntimeRoot 'C:\GameServer\Example\DysonControlRuntime\node-current' `
  -NodeExecutable 'C:\GameServer\Example\DysonControlRuntime\node-current\node-v24.0.0-win-x64\node.exe' `
  -ExpectedNodeSha256 ('d' * 64) `
  -CheckpointId $checkpoint.checkpointId `
  -ReadinessUri 'http://127.0.0.1:13010/readyz'
```

Resume is read-only and fails closed when the checkpoint is missing, redirected,
noncanonical, ACL-invalid, tampered, expired, resumed on a different host, or
still on the original boot. It also rejects a boot timestamp outside the
checkpoint window, control release/task drift, game project/account drift, a
missing non-Session-0 dedicated session, an unhealthy loopback API, or a game
runtime/process/listener mismatch. The control and game scheduled tasks must
both be in `Running` state, and each current `LastRunTime` must be newer than
the checkpoint baseline and fall within the new boot window. This proves that
both task instances executed after the reboot; Task Scheduler's `LastRunTime`
does not by itself prove that the boot/logon trigger, rather than a later manual
`Start-ScheduledTask`, caused the run. The native receipt therefore fixes
`automaticTaskTriggerProven`, `unattendedStartupValidated`, and
`qualifyingProductionEvidence` to `false`, and fixes
`requiresPrivateEvidenceBundle` to `true`. The operator must place the receipt,
Task Scheduler Operational trigger/instance evidence, and independently
captured no-manual-login evidence in the private acceptance workflow.

`npm run deployment:reboot-selftest` exercises this state machine using only a
unique fictional temporary root and injected fixture observations. Its receipt
always reports `realRebootObserved: false`,
`nativeTaskSchedulerValidated: false`, and `productionChanged: false`. It proves
the repository contract and rejection behavior, not a real reboot, native Task
Scheduler/LSA behavior, or target-host recovery.

## Non-administrator self-test

The Pester-free self-test creates fictional payloads beneath a unique temporary
directory and exercises real filesystem operations. It is part of the root
`npm run check` gate:

```powershell
powershell.exe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass `
  -File .\scripts\windows\deployment\SelfTest-DysonControlDeployment.ps1
```

It verifies:

- initial staging and content-identical staging idempotency;
- rejection of different content under an existing immutable version;
- rejection of a concurrent mutation while the deployment lock is held;
- fail-closed task installation and uninstall before mutation when Task Scheduler
  cannot be queried;
- activation through the atomic pointer;
- A-to-B upgrade with a pre-upgrade snapshot;
- a B-to-C health failure that automatically restores B;
- explicit rollback from B to A and configuration restoration;
- preservation of persistent data;
- a non-mutating `-WhatIf` result;
- durable audit records;
- reusable install and read-only layout validation;
- execution of the installed launcher with proof that a fictional non-loopback
  setting is forced back to `127.0.0.1`, persistent paths target ProgramData,
  and the manifest-bound release version is exported to the child process;
- startup-task `-WhatIf` validation without administrator changes;
- acceptance of a controlled stable Node 24 fixture and rejection of Node 23,
  forged versions, stderr/nonzero exit, oversized output, and timeout;
- proof that installer/task previews do not execute Node and that rejected Node
  runtimes do not create install/data state, change task audit state, or run the
  active API entry point;
- uninstaller rejection of a concurrent deployment-lock owner without task,
  pointer, install, or audit mutation;
- fixed-root task removal, task XML/active-pointer/release recovery assets, and
  byte-for-byte persistent-data preservation on successful uninstall;
- restoration of the exact task XML and prior Running state when unregister fails
  after Stop, and when a later uninstall filesystem step fails.
- broker-aware uninstall `-WhatIf` non-mutation, pending/drift refusal, exact
  active release/profile/task/DACL restoration when a later control-task step
  fails, and successful fixed broker removal with retained receipts, authority,
  and GSManager data.

The deployment self-tests validate PowerShell 5.1 behavior but cannot prove
Task Scheduler, service-account ACL inheritance, boot startup, process
termination, or real HTTP health on the target Windows host. Those remain
target-host gates.

`npm run node-runtime:selftest` covers the independent-root, exact-hash,
non-reparse path, protected owner/DACL, service identities read-only, DataRoot ACL
independence, and failed-runtime-activation rollback contract under a fresh
temporary root. The deployment self-test also proves that task-install failure
does not change runtime bytes or ACLs and that private runtime evidence is not
passed to the API as an unknown `DYSON_*` key.

`npm run powershell:check` recursively parses every `.ps1` file beneath
`scripts/windows`, including this deployment directory. Parser success and the
self-test are repository evidence only; neither command changes a target host.

## Required production verification

Before replacing another panel or declaring deployment ready, run these gates on a
non-production Windows Server Core VM and then on the target during an approved
maintenance window:

1. Parse every shipped PowerShell script and run the deployment, deployment
   status, deployment reboot, lifecycle-broker, cutover-broker, and release-package
   self-tests.
2. Install from an independently authenticated Node ZIP into a separate protected
   RuntimeRoot, then install with a complete local production configuration and
   the exact expected `node.exe` SHA-256.
3. Create a reboot-acceptance checkpoint, perform a separately approved guest
   reboot, and resume the exact checkpoint ID. Preserve the private receipt and
   independently prove the AtStartup and dedicated-account AtLogOn triggers
   caused the recorded task instances without an RDP/manual recovery action,
   the dedicated game session/task became healthy, and neither runtime
   duplicated.
4. Confirm `Get-NetTCPConnection` shows the Node listener only on loopback.
5. Confirm the service identity can access ProgramData and the configured project
   root, while no credentials are copied into a release.
6. Prove a lifecycle first install followed by an injected later failure invokes
   `-CompensateFirstInstall`, removes only the fixed profile/task, and preserves
   request/receipt/audit evidence.
7. Prove same-release replay returns `reused` and performs no compensation.
8. Perform a healthy A-to-B upgrade with the explicit broker upgrade switches.
9. Deploy an intentionally unready fictional B-to-C build and prove the old
   active release is restored before the old release's lifecycle installer runs
   with `-UpgradeExisting`; verify the old profile/task/ACL and both deep
   readiness checks.
10. Exercise the exact-snapshot lower-level rollback only in a lifecycle-disabled
    fixture and prove configuration and SQLite state remain consistent.
11. Uninstall without `-RemoveData`; verify both broker profiles/tasks are removed,
    durable requests/receipts/audit/authority evidence and DataRoot remain, and
    the release/task can be restored from the reported backups.
12. Only after the control plane passes the project's complete acceptance and soak
    gates should a separate approved cutover remove GSManager.

## Operator inputs still required after release packaging

Qualified-client storage rollback restores an adopted empty directory's captured
owner, group, DACL, and inheritance control bits exactly. The rollback uses
`SetFileSecurityW` for the captured directory descriptor; the ordinary ACL
installer retains its existing inheritance behavior. Lifecycle and cutover
broker rollback use the same primitive for their captured directory preimages,
without propagating changes to descendants. This avoids the automatic
`SE_DACL_AUTO_INHERITED` conversion described in Microsoft's Win32 documentation,
"Automatic Propagation of Inheritable ACEs".
A populated or redirected rollback target is rejected, audit rules are not
rewritten, and the resulting SDDL must equal the captured preimage. Run
`SelfTest-DysonDeploymentConfigurationIntegration.ps1` with an elevated Windows
token to exercise real directory ACLs, including legacy and protected descriptors.

The release workflow now closes build, artifact assembly, public scanning,
deterministic ZIP, checksum, provenance, and GitHub asset publication. A Windows
operator must still provide or decide:

- `SourcePath`: path to a clean, built runtime artifact;
- `Version`: immutable release version/tag;
- `RuntimeRoot`: independent protected Node root outside `InstallRoot` and
  `DataRoot`;
- `NodeExecutable`: exact Node 24-or-newer executable below `RuntimeRoot`;
- `ExpectedNodeSha256`: independently authenticated lowercase SHA-256 of that
  executable;
- `EntryPointRelativePath`: normally `apps\api\dist\index.js`;
- `InstallRoot` / `DataRoot`: defaults are Program Files / ProgramData;
- `ConfigurationSource`: a local production file created outside the repository;
- `TaskName`: default `Dyson-Control-Plane`;
- `ServiceAccount`: default `NT AUTHORITY\LOCAL SERVICE`;
- `ReadinessUri`: fixed loopback `/readyz` URI and bounded timeout;
- optional lifecycle-broker installation: `-InstallLifecycleBrokerTask` plus
  explicit project/bootstrap roots, service user, game port, dispatch-readiness
  timeout, registered/start-after-install control task, loopback readiness, and
  matching environment bindings;
- `-UpgradeLifecycleBrokerExisting` for a cross-release lifecycle change;
  same-release replay is idempotent without it;
- optional dependent cutover installation: `-InstallCutoverBrokerTask` in the
  same transaction as lifecycle, plus the authority profile/revision, runtime
  task transaction root, and matching project/bootstrap/user/port bindings;
- `-UpgradeCutoverBrokerExisting` for a cross-release cutover change;
- the artifact retention policy for inactive releases and deployment snapshots.

Release automation must continue to preserve the recursive PowerShell parser,
deployment/status/reboot and broker self-tests, exact artifact/package
verifiers, and public-release scan.
The real clean-host and target-host commands above have not yet been executed as
production evidence. Until those runs exist, `OSS-001` and `SRV-002` are
`implemented`, not `verified`, and this mechanism is not authorization to replace
GSManager.
