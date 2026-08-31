# Reusable Windows deployment

This document describes the repository's reusable Windows Server Core deployment
mechanism. The scripts and temporary-root self-test are implemented, but this is
not evidence that a production host was changed. They have not been run on the
target VM and do not install, stop, start, edit, or remove any
DSP/Nebula/GSManager task.

## Prerequisites

- a supported Windows Server host with Windows PowerShell 5.1;
- Node.js 24 or newer at an exact local executable path;
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
- automatic pointer/config rollback when activation or deep loopback readiness validation
  fails;
- `SupportsShouldProcess` / `-WhatIf` on every public mutating entry point;
- a fixed startup task for Node that does not accept an arbitrary command;
- a stable launcher that always forces the Node listener to `127.0.0.1`;
- an uninstaller that preserves ProgramData by default and retains a recoverable
  inactive copy of Program Files;
- machine-readable JSON output and a durable JSONL deployment audit.

This layer does not package licensed DSP files, Steam state, saves, credentials,
real endpoints, logs, or player data.

## Installed layout

The production defaults are shown below. Every root is overridable so the complete
release state machine can also run without elevation in a temporary directory.

```text
C:\Program Files\DysonControl\
  bootstrap\
    DysonDeployment.Common.ps1
    Start-DysonControl.ps1
  releases\
    0.2.0\
      apps\api\dist\index.js
      apps\web\dist\...
      scripts\windows\...
      release-manifest.json

C:\ProgramData\DysonControl\
  config\
    dyson-control.env
    dyson-control.env.example
  data\                 # SQLite and future persistent application state
  logs\                 # application logs, never release payload
  state\
    active-release.json # atomically replaced current pointer
    deployment.lock     # cross-process deployment lock
  snapshots\
    deployments\        # pointer + config captured before changes
    tasks\               # replaced startup-task XML
    bootstrap\           # replaced stable launcher files
  migration\
    snapshots\           # private GSManager file/task snapshots
    restore-guards\      # private pre-restore compensation guards
  audit\
    deployment.jsonl
```

`active-release.json` contains a version, a bounded relative entry point, and the
SHA-256 of the immutable release payload. The launcher resolves the entry point
from this pointer on every start. No mutable `current` directory is copied over a
running release.

## Release artifact contract

`-SourcePath` must name a prepared, local or UNC release artifact. A development
checkout or an ad-hoc directory containing only the API entry point is rejected.
Every accepted artifact must contain:

```text
artifact-manifest.json
apps\api\dist\index.js
scripts\windows\release\DysonReleasePackaging.Common.ps1
scripts\windows\release\Test-DysonControlReleaseArtifact.ps1
scripts\windows\bridge\Build-DysonControlBridgeCandidate.ps1
scripts\windows\bridge\Test-DysonControlBridgeCandidate.ps1
scripts\windows\migration\New-DysonGsManagerSnapshot.ps1
scripts\windows\migration\Test-DysonGsManagerSnapshot.ps1
scripts\windows\migration\Restore-DysonGsManagerSnapshot.ps1
integrations\dyson-control-bridge\DysonControlBridge.csproj
integrations\dyson-control-bridge\dyson-control-bridge.cfg.example
docs\GSM-EVALUATION.md
docs\WINDOWS-DEPLOYMENT-DRAFT.md
```

The manifest fixes the release protocol, exact case-sensitive version, entry
point, Node minimum major, dependency-install policy, exact file set, every file
length and SHA-256, total bytes, and the canonical payload SHA-256. The verifier
is shipped inside that exact file set, so an extracted release can validate
itself without a repository checkout. Transport authenticity still belongs to
the separately published archive hash/provenance; a self-contained manifest is
not a substitute for that external release evidence.

The production packaging job supplies built `apps/api/dist`, built
`apps/web/dist`, runtime Windows scripts (including the fixed managed-plugin
version probe), the self-contained verifier, license/notices, only the runtime
dependencies needed by the API, and the exact public Bridge source/build tool
allowlist. It also carries the exact GSManager migration script allowlist and
the two migration/Windows operator guides. It does not pass a development checkout with test data or local
`.env` files. In particular, the public artifact rejects Bridge DLL/PDB/EXE
outputs and DSP, Unity, BepInEx, Harmony, or Nebula reference assemblies.

Install, stage, and upgrade run the packaged verifier before any release copy and
require its version to match `-Version` exactly. Staging rejects redirected
payload entries, copies into a sibling directory, runs the verifier again there,
requires the pre-copy and post-copy artifact payload hashes to match, writes the
separate deployment `release-manifest.json` including the verified
`nodeMinimumMajor`, and only then renames the directory
into final `releases\<version>`. Missing, extra, changed, or case-drifted files and
manifest-version mismatches fail closed. Reusing a version is idempotent only
when its complete content hash matches; the scripts refuse to overwrite a
different payload under an existing version.

Accepted version labels contain 1-64 characters from letters, numbers, `.`, `_`,
`+`, and `-`. Release automation should normally pass the repository package
version or an immutable release tag.

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
files. It also requires the Bridge project `<Version>` and the exact
`BepInPlugin`-bound `PluginVersion` constant to match that same version. Only
`x.y.z` and `x.y.z-rc.N` are accepted. Release automation also passes the exact
version derived from the `v` tag, so a coordinated manifest, lockfile, or Bridge
metadata drift cannot silently publish a differently versioned package.

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
$downloadRoot = 'C:\Packages\DysonControl-v0.2.0-download'
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
$artifact = 'C:\Packages\DysonControl-v0.2.0'
if (Test-Path -LiteralPath $artifact) {
  throw 'Use a new empty artifact directory.'
}
Expand-Archive -LiteralPath $archivePath -DestinationPath $artifact

& "$artifact\scripts\windows\release\Test-DysonControlReleaseArtifact.ps1" `
  -ArtifactPath $artifact `
  -ExpectedVersion $version
```

Finally supply the local Node executable and a production configuration that
was created outside the downloaded release. Preview the exact install first;
run the same bounded command without `-WhatIf` only after reviewing its JSON.

```powershell
$node = 'C:\Program Files\nodejs\node.exe'
$config = 'C:\Staging\dyson-control.env'
$installer = "$artifact\scripts\windows\deployment\Install-DysonControl.ps1"

& $installer `
  -SourcePath $artifact `
  -Version $version `
  -NodeExecutable $node `
  -ConfigurationSource $config `
  -RegisterStartupTask `
  -WhatIf

& $installer `
  -SourcePath $artifact `
  -Version $version `
  -NodeExecutable $node `
  -ConfigurationSource $config `
  -RegisterStartupTask
```

## Configuration and persistent state

The runtime configuration is a UTF-8 `KEY=value` file at
`ProgramData\DysonControl\config\dyson-control.env`. Blank lines and `#` comments
are supported. Only `NODE_ENV` and `DYSON_*` names are accepted; shell expansion,
quoted commands, and arbitrary process variables are not interpreted.

On every launch the stable bootstrap removes inherited `DYSON_*`, `NODE_ENV`,
`NODE_OPTIONS`, and `NODE_PATH` values, loads the local configuration, and then
forces these deployment-owned values:

```text
NODE_ENV=production
DYSON_HOST=127.0.0.1
DYSON_DATA_DIR=C:\ProgramData\DysonControl\data
DYSON_SCRIPT_ROOT=<active release>\scripts\windows
DYSON_DEPLOYMENT_VERSION=<active manifest version>
```

The application still performs its own production validation. In particular, the
installer never invents an administrator password hash or session secret. Without
a complete local production file, startup fails closed. `Install-DysonControl.ps1
-RegisterStartupTask` consequently requires either an existing
`dyson-control.env` or `-ConfigurationSource`.

The stable launcher exports the active manifest version as
`DYSON_DEPLOYMENT_VERSION`. `/healthz` remains a lightweight liveness response.
The deployment transaction instead uses `/readyz`, which binds the same
`deploymentVersion` and `X-Dyson-Control-Release` to successful provider/project
inspection and, when configured, a clean update-activation recovery state. A
surviving old release or a live-but-unready process is rejected.

Existing configuration is never overwritten by a later install. Configuration is
included in deployment snapshots, but `data`, `logs`, and game files are not.
Upgrading or rolling back code therefore leaves the control-plane database and
game data intact.

## Commands

All examples are fictional and deliberately use non-production roots/endpoints.
Run `-WhatIf` first. The normal install/task operations require an elevated Windows
PowerShell process when they target Program Files or Task Scheduler.

### Preview and install

```powershell
$artifact = 'C:\Packages\DysonControl-0.2.0'
$node = 'C:\Program Files\nodejs\node.exe'
$config = 'C:\Staging\dyson-control.env'

& "$artifact\scripts\windows\release\Test-DysonControlReleaseArtifact.ps1" `
  -ArtifactPath $artifact `
  -ExpectedVersion '0.2.0'

& "$artifact\scripts\windows\deployment\Install-DysonControl.ps1" `
  -SourcePath $artifact `
  -Version '0.2.0' `
  -NodeExecutable $node `
  -ConfigurationSource $config `
  -RegisterStartupTask `
  -WhatIf
```

The explicit verifier command is a useful operator-visible check; the installer
also performs the same verification internally and cannot bypass it. Remove
`-WhatIf` after reviewing the JSON preview. `-StartAfterInstall` is optional
and additionally requires the loopback readiness endpoint
`http://127.0.0.1:13010/readyz`. Without that switch the operator can finish local
configuration and start the fixed task later.

`-WhatIf` resolves and bounds the selected executable file but never starts it.
Immediately before a real installation can create Program Files/ProgramData
state, the installer executes only that fixed file with `--version`, with
`NODE_OPTIONS` and `NODE_PATH` removed. The probe has a three-second timeout and
bounded stdout/stderr. It accepts only the exact stable form
`vMAJOR.MINOR.PATCH` and requires `MAJOR` to be at least the minimum carried by
the verified artifact. A filename such as `node.exe` is not treated as proof;
nonzero exit, stderr, prerelease/forged/oversized output, timeout, reparse point,
or an older major all fail closed with one fixed error that contains neither
the executable path nor child-process output.

### Production upgrade

Use the transaction entry point for later upgrades. A production upgrade should
restart the fixed control-plane task and require deep loopback readiness verification:

```powershell
$newArtifact = 'C:\Packages\DysonControl-0.3.0'

& "$newArtifact\scripts\windows\deployment\Invoke-DysonControlDeployment.ps1" `
  -Operation Upgrade `
  -SourcePath $newArtifact `
  -Version '0.3.0' `
  -RestartControlTask `
  -ControlTaskName 'Dyson-Control-Plane' `
  -ReadinessUri 'http://127.0.0.1:13010/readyz' `
  -ReadinessTimeoutSeconds 45 `
  -WhatIf
```

The real run performs these ordered steps under an exclusive deployment lock:

1. append a deployment-start audit record;
2. snapshot the current pointer and configuration;
3. stage and hash the new immutable release;
4. atomically replace the active pointer;
5. restart only `Dyson-Control-Plane`;
6. poll the fixed loopback `/readyz` endpoint and require HTTP success, `status=ready`,
   the exact target `deploymentVersion` in both JSON and the
   `X-Dyson-Control-Release` response header, and no failed readiness check;
7. append success, or restore the snapshot, restart the old release, verify it,
   and append the rollback outcome.

The staged failed version remains inactive for diagnosis. It is never retried
implicitly and does not alter persistent data.

### Explicit rollback

The upgrade JSON result contains `snapshotId`. Use that exact ID rather than
guessing `latest` during an incident:

```powershell
& .\scripts\windows\deployment\Invoke-DysonControlDeployment.ps1 `
  -Operation Rollback `
  -SnapshotId '20260830-120000000-1a2b3c4d' `
  -RestartControlTask `
  -ReadinessUri 'http://127.0.0.1:13010/readyz' `
  -WhatIf
```

Before restoring the requested snapshot, rollback creates a guard snapshot of the
current state. If the requested snapshot or readiness validation fails, the script
restores that guard. The output reports `guardSnapshotId`, making the rollback
itself reversible.

### Read-only validation

```powershell
& .\scripts\windows\deployment\Test-DysonControlDeployment.ps1 `
  -IncludeTask `
  -ReadinessUri 'http://127.0.0.1:13010/readyz'
```

This checks the layout, active pointer, payload hash, local configuration, stable
launcher, optional startup-task shape, and optional deep loopback readiness. It does not
modify the host.

### Uninstall

```powershell
& .\scripts\windows\deployment\Uninstall-DysonControl.ps1 -WhatIf
```

The default real run stops and removes only `Dyson-Control-Plane`, moves the
Program Files tree into a timestamped
`ProgramData\DysonControl\snapshots\uninstall-releases\<id>` directory, and
preserves all ProgramData. The JSON result contains the task XML and
release-backup locations. The active pointer is moved to a separately reported
uninstall-state backup so a later reinstall does not inherit a stale pointer.
Restoring those exact artifacts is the defined uninstall rollback. Program Files
and ProgramData must be on the same volume for this atomic, recoverable move;
otherwise uninstall fails without removing the existing layout.

`-RemoveData` is a separate, explicit destructive choice. It removes the complete
control-plane ProgramData tree, including the recoverable release copy, after the
uninstall audit is written. It does not
remove the DSP project, game saves, Steam files, or any game task.

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
$artifact = 'C:\Packages\DysonControl-v0.2.0'
$project = 'C:\GameServers\FictionalDSP'
$gsm = 'C:\GameServers\FictionalDSP\tools\GSManager'
$data = 'C:\ProgramData\DysonControl'
$protectionId = 'save:00000000-0000-4000-8000-000000000001'
$protectionDigest = '0000000000000000000000000000000000000000000000000000000000000000'
$migration = "$artifact\scripts\windows\migration"

& "$migration\Get-DysonGsManagerMigration.ps1" `
  -ProjectRoot $project -GsManagerRoot $gsm

& "$migration\New-DysonGsManagerSnapshot.ps1" `
  -ProjectRoot $project -GsManagerRoot $gsm -DataRoot $data `
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
  -DataRoot $data `
  -SnapshotId '<opaque snapshot UUID>' `
  -ExpectedSnapshotManifestSha256 '<64-character snapshot manifest SHA-256>'
```

The fixed snapshot layout is
`DataRoot\migration\snapshots\<snapshotId>`. A same-parent private staging tree
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
  -ProjectRoot $project -GsManagerRoot $gsm -DataRoot $data `
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

## Bridge source-to-private-candidate deployment

The main control-plane release never redistributes the licensed game/mod
reference assemblies. It carries only the exact Bridge sources, `net472`
project, disabled template, and scripts under `scripts\windows\bridge`. Build a
private candidate on the target Windows host while the lawful DSP/Nebula/BepInEx
tree is present:

```powershell
$artifact = 'C:\Packages\DysonControl-v0.1.0'
$server = 'C:\GameServers\DSP\server'
$candidate = 'C:\Private\DysonControlBridge-0.1.0'

& "$artifact\scripts\windows\bridge\Build-DysonControlBridgeCandidate.ps1" `
  -SourcePath "$artifact\integrations\dyson-control-bridge" `
  -DysonServerRoot $server `
  -OutputPath $candidate `
  -ExpectedVersion '0.1.0' `
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
  -CandidatePath $candidate -DysonServerRoot $server -ExpectedVersion '0.1.0'

& "$artifact\scripts\windows\bridge\Install-DysonControlBridge.ps1" `
  -CandidatePath $candidate -DysonServerRoot $server -WhatIf
```

After confirmation, installation writes only the fixed
`BepInEx\plugins\dyson-control-bridge` plugin location and fixed BepInEx config,
state, audit, secret, and snapshot names. The old DLL/config/state are
snapshotted before same-directory atomic publication. The generated secret has
48 random bytes, is never returned or stored in either manifest, and receives a
protected explicit ACL; pass exact additional game/control account SIDs with
`-SecretReaderSid`. The installed config always starts with `Enabled = false`.
Any failure restores the previous DLL/config/state and removes a newly generated
secret. The scripts never start or restart DSP.

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

Task installation reads the Node minimum from the verified active immutable
release and performs the same runtime probe before changing ACLs, stopping an
existing task, writing audit state, or registering a replacement. Its
`-WhatIf` path does not execute Node. The stable launcher repeats the probe on
every task start before it changes the child environment or runs the API, so a
replaced, downgraded, forged, timed-out, or anomalous executable cannot rely on
an earlier installation-time check.

The task definition is backed up before replacement and automatically restored if
registration or verification fails. The installer grants its selected built-in
service identity Modify access to the control-plane ProgramData tree. The chosen
identity must separately have the intended read/write access to any configured DSP
project root; these scripts do not create SMB credentials or mappings.

The task description explicitly records that it does not start or stop the game.
No task named `Dyson-Nebula-Server`, `Dyson-Nebula-Stop`, or any GSManager task is
queried or changed by this deployment directory.

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
$credential = Get-Credential -UserName '.\DysonServer'

& .\scripts\windows\session\Configure-DysonInteractiveSession.ps1 `
  -Credential $credential -WhatIf

& .\scripts\windows\session\Configure-DysonInteractiveSession.ps1 `
  -Credential $credential

& .\scripts\windows\session\Test-DysonInteractiveSession.ps1 `
  -Credential $credential
```

The configuration script accepts no task, executable, project-root, or command
parameters. It validates the existing fixed `Dyson-Nebula-Server` task and
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
- uninstall with preserved data and a recoverable release backup.

The self-test validates PowerShell 5.1 behavior but cannot prove Task Scheduler,
service-account ACL inheritance, boot startup, process termination, or real HTTP
health on the target Windows host. Those remain target-host gates.

`npm run powershell:check` recursively parses every `.ps1` file beneath
`scripts/windows`, including this deployment directory. Parser success and the
self-test are repository evidence only; neither command changes the target VM.

## Required production verification

Before replacing another panel or declaring deployment ready, run these gates on a
non-production Windows Server Core VM and then on the target during an approved
maintenance window:

1. Parse every script in `scripts/windows/deployment` with the Windows PowerShell
   parser and run the Pester-free self-test.
2. Install with a complete local production configuration and the exact supported
   Node 24 executable.
3. Confirm the startup task runs without any RDP/interactive user session and
   survives a guest reboot.
4. Confirm `Get-NetTCPConnection` shows the Node listener only on loopback.
5. Confirm the service identity can access ProgramData and the configured project
   root, while no credentials are copied into a release.
6. Perform a healthy A-to-B upgrade and preserve its exact snapshot ID.
7. Deploy an intentionally unready fictional B-to-C build and prove the script
   restores B plus a fully ready `/readyz` response.
8. Roll back B-to-A by exact snapshot ID and prove configuration and SQLite state
   are consistent.
9. Uninstall without `-RemoveData`, verify ProgramData remains, then restore the
   release tree/task from the reported backups.
10. Only after the control plane passes the project's complete acceptance and soak
    gates should a separate approved cutover remove GSManager.

## Operator inputs still required after release packaging

The release workflow now closes build, artifact assembly, public scanning,
deterministic ZIP, checksum, provenance, and GitHub asset publication. A Windows
operator must still provide or decide:

- `SourcePath`: path to a clean, built runtime artifact;
- `Version`: immutable release version/tag;
- `NodeExecutable`: exact supported Node 24 executable, or a future bundled runtime
  path;
- `EntryPointRelativePath`: normally `apps\api\dist\index.js`;
- `InstallRoot` / `DataRoot`: defaults are Program Files / ProgramData;
- `ConfigurationSource`: a local production file created outside the repository;
- `TaskName`: default `Dyson-Control-Plane`;
- `ServiceAccount`: default `NT AUTHORITY\LOCAL SERVICE`;
- `ReadinessUri`: fixed loopback `/readyz` URI and bounded timeout;
- the artifact retention policy for inactive releases and deployment snapshots.

Release automation must continue to preserve the recursive PowerShell parser,
deployment self-test, exact artifact/package verifiers, and public-release scan.
The real clean-host and target-host commands above have not yet been executed as
production evidence. Until those runs exist, `OSS-001` and `SRV-002` are
`implemented`, not `verified`, and this mechanism is not authorization to replace
GSManager.
