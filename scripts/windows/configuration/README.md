# Protected production configuration module

This directory is the fail-closed production configuration boundary used by the
Windows deployment, stable launcher, deployment status, uninstall guard, and
reboot-acceptance checks. Initial installation and byte-identical reuse are
wired into those paths. The same module now also exposes independently callable
protected snapshot, cross-version replacement, and restore transactions; the
top-level deployment orchestrator must pass their snapshot evidence when it
adopts a new release profile.

## Files and trust boundaries

- `dyson-control.environment-contract.json` is the static, reviewable contract.
  It contains the exact 70 `DYSON_*` names currently declared by
  `apps/api/src/config.ts`, plus `NODE_ENV`. The self-test extracts the names
  from that TypeScript source and fails on any drift.
- `DysonConfiguration.Common.ps1` contains strict parsing, local NTFS and
  reparse-point checks, ACL policies, durable records, recovery inspection, and
  protected snapshot validation.
- `Install-DysonControlConfiguration.ps1` performs initial installation,
  idempotent reuse, protected cross-version replacement, and bounded crash
  recovery. Replacement requires `-ProtectedPreimageSnapshotPath` and refuses
  a snapshot that is not an exact byte, ACL, data-root, target, contract, and
  profile match for the live preimage.
- `New-DysonControlConfigurationSnapshot.ps1` creates an atomically published,
  self-describing protected preimage snapshot without changing the live file.
- `Restore-DysonControlConfiguration.ps1` restores a protected source snapshot
  through the same transaction engine. It also requires a distinct protected
  snapshot of the current pre-restore state, so restoration is itself
  reversible and fail-closed.
- `Test-DysonControlConfiguration.ps1` is read-only. It validates the installed
  file, exact ACL, complete receipt chain, and optionally a protected snapshot
  and restore plan.
- `SelfTest-DysonControlConfiguration.ps1` creates only fictional fixtures below
  the current user's temporary directory. It never touches ProgramData, a VM,
  a scheduled task, a service, or the game server.

The configuration source and every existing ancestor of the source and target
must be on a local, fixed NTFS volume and must not be a reparse point. The
shipped static contract may be read from a release share for qualification, but
this exception does not apply to configuration content, transactions, or
snapshots.

## Environment-file policy

The accepted file is UTF-8 without a BOM. Invalid byte sequences, the Unicode
replacement character, bare carriage returns, control characters, duplicate
names, unknown `DYSON_*` names, name whitespace, and multiline injection are
rejected. Production requires `NODE_ENV`, `DYSON_HOST`,
`DYSON_ADMIN_PASSWORD_HASH`, and `DYSON_SESSION_SECRET`.

All six launcher-owned values must also be present and must exactly match the
private launcher profile:

- `NODE_ENV=production`
- `DYSON_HOST=127.0.0.1`
- `DYSON_DATA_DIR=<data-root>\data`
- `DYSON_SCRIPT_ROOT=<active-release>\scripts\windows`
- `DYSON_RUNTIME_BOOTSTRAP_ROOT=<install-root>\bootstrap`
- `DYSON_DEPLOYMENT_VERSION=<active-manifest-version>`

The PowerShell gate validates the secure envelope and launcher bindings. It also
keeps both Nebula whole-plugin-tree transaction gates off by default and accepts
only the exact lowercase Boolean values `true` and `false`. Supplying its job
base, even while both gates are false, activates fixed-root validation: the job
base must be an absolute non-root path, the Windows provider and explicit
project/data/script roots are required, the job base must be disjoint from the
project, derived `server`, and data roots, and the derived server and data roots
must also be non-root and disjoint. The API's Zod schema remains authoritative
for the remaining non-secret options' detailed types, ranges, and cross-option
semantics. Both gates must pass before task registration or process start.

## ACL contract

The installed `config` directory and `dyson-control.env` are owned by the
built-in Administrators group and have a protected DACL with exactly these
principals:

- `SYSTEM`: full control;
- built-in Administrators: full control;
- the configured service SID: read and execute on the directory, read only on
  the file.

The service principal receives no write, delete, permission-change, or
ownership rights. Transaction and snapshot directories and files have only
`SYSTEM` and built-in Administrators full control. A source file must already
have a protected private DACL whose owner and every ACE are limited to
`SYSTEM`, built-in Administrators, or the invoking identity.

Protecting only the child would still allow deletion through a permissive
parent `FILE_DELETE_CHILD` grant. The module therefore also fails closed unless
the data root is owned by `SYSTEM` or built-in Administrators, has a protected
DACL, grants `SYSTEM` and Administrators full control, and grants the service a
direct read-and-execute rule without delete-child, delete, permission-change,
or ownership rights. Other direct writers are rejected. Inherit-only rules may
grant the service the write/delete rights its ordinary data children need; the
protected `config` child does not inherit them. A protected snapshot's immediate
parent must likewise have no untrusted direct writer.

Run the elevated ACL integration gate before deployment integration:

```powershell
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass `
  -File <release-root>\scripts\windows\configuration\SelfTest-DysonControlConfiguration.ps1 `
  -RequireAclIntegration
```

Without elevation, the same self-test still exercises the parser, policy
objects, transaction chain, live-to-tail negative cases, replacement and restore
crash matrices, snapshot contract, and two independent PowerShell writers
contending for the fixed lock. Only ACL application/assertion uses a seam defined
inside the self-test. It reports `policy-and-selftest-seam` rather than claiming
real ACL integration.

## Durable transaction and recovery behavior

Mutation serialization uses a protected fixed lock file below the transaction
root. Intent and receipt JSON records are written to a unique temporary file in the
destination directory with `FileMode.CreateNew`, flushed with `Flush(true)`,
closed, protected, hashed, and renamed on the same volume. The configuration is
staged in its final directory with the same durability and ACL checks. Creation
uses a non-overwriting rename. Replacement and restore use NTFS `File.Replace`
with a transaction-bound same-directory backup; the backup is verified against
the protected preimage before removal. A crash while that backup exists resumes
with `finalize-backup-cleanup` rather than treating it as an unrelated file.

V2 intents carry a monotonically increasing sequence and the previous receipt
file hash. Each receipt binds its exact intent hash, sequence, previous receipt
hash, final target hash/length/ACL, and operation result. Inspection validates
the complete contiguous chain on every call. A candidate clean state is read
under the same exclusive lock and must close the live file's exact byte hash,
length, ACL, contract, target path, and launcher profile to the root-wide tail
receipt. A successful tail resolves to its source; an aborted replacement or
restore resolves to its protected preimage; an aborted create resolves to an
absent target. A present target without a receipt is rejected. Receipts contain
no environment values. Intents and snapshot manifests are protected private
records; public results expose only identifiers, hashes, lengths, counts, and
ACL fingerprints.

Recovery is deterministic:

- no intent means a new request may begin;
- a complete intent with no staged file resumes the configuration write;
- a complete staged file finalizes create or atomic replacement;
- a verified replacement target plus its verified transaction backup finalizes
  backup cleanup;
- a verified target with no receipt finalizes the receipt;
- a partial staged file permits the explicit `-RecoveryAction Abort` path only
  while the target is still absent for create, or is still the exact protected
  preimage for replacement/restore, and no transaction backup exists; the
  executor rechecks that invariant before and after deleting the exact plain
  temporary file;
- an incomplete or complete writer temporary file, an unrelated temporary
  file, multiple pending intents, an orphan receipt, a mismatched receipt, or an
  unexpected directory entry blocks automatically.

Every intent binds the explicit operation, source kind and path hash, target
path hash, source hash/length, contract hash, exact service SID, target and
parent ACL fingerprints, launcher-profile hash and values, deployment version,
preimage hash/length/ACL/profile, and protected snapshot ID/manifest/path hashes.
A restore also binds its source snapshot independently. Every historical intent
must remain compatible with the current contract hash and shape, target path,
service SID, ACL policies, and data-root profile binding. Version, script-root,
runtime-root, and source-profile values may differ across legitimate historical
A-to-B-to-C transitions, but each record remains internally exact and the tail
profile must match the live bytes. A pending transaction must be resumed with
the exact new profile and exact snapshots.

Here, cross-version means a deployment-version and launcher-profile change
under the same reviewed environment contract. A contract-hash or contract-shape
change is intentionally rejected; it requires a separate, reviewed migration
rather than silently interpreting historical snapshots with new semantics.

## Protected snapshots and executable restore

A configuration snapshot contains exactly `configuration-snapshot.json` and
`dyson-control.env`. The manifest binds the snapshot ID, contract hash, service
SID, data-root and target path hashes, complete launcher profile and profile
hash, original target ACL fingerprint, snapshot parent/directory ACLs, and the
exact private payload hash, length, and ACL. Extra, missing, redirected,
traversing, oversized, orphaned-partial, or modified entries are rejected.

`Test-DysonControlConfiguration.ps1 -ProtectedSnapshotPath <snapshot> `
`-PlanSnapshotRestore` remains read-only. To execute a restore, first snapshot
the current target and then pass both snapshots to the restore executor:

```powershell
$preB = & <module>\New-DysonControlConfigurationSnapshot.ps1 `
  -DataRoot C:\DysonExample\data-root `
  -ScriptRoot C:\DysonExample\releases\B\scripts\windows `
  -RuntimeBootstrapRoot C:\DysonExample\bootstrap -DeploymentVersion B

# Install C with -ProtectedPreimageSnapshotPath $preB.snapshotPath, then if
# readiness fails, protect C before restoring B.
$preC = & <module>\New-DysonControlConfigurationSnapshot.ps1 `
  -DataRoot C:\DysonExample\data-root `
  -ScriptRoot C:\DysonExample\releases\C\scripts\windows `
  -RuntimeBootstrapRoot C:\DysonExample\bootstrap -DeploymentVersion C

& <module>\Restore-DysonControlConfiguration.ps1 `
  -DataRoot C:\DysonExample\data-root `
  -ProtectedSnapshotPath $preB.snapshotPath `
  -CurrentProtectedSnapshotPath $preC.snapshotPath -Confirm:$false
```

The A-to-B and B-to-C path uses the same sequence: snapshot A, replace with B;
snapshot B, replace with C; if C readiness fails, snapshot C and restore B.
The self-test exercises this entire round trip and every interruption point
between intent persistence, staged-file flush, atomic publish, backup cleanup,
and receipt persistence.

## Password hashing

The existing `npm run hash-password` command now accepts no password argument.
Run it with no trailing argument and enter the password at the hidden TTY
prompt. Non-interactive secret managers may provide exactly one password line
through standard input. Argument input, multiline input, control characters,
and oversized input are rejected without reflecting the submitted value.

## Integration checklist

The service launcher uses `Test-DysonControlConfiguration.ps1 -RuntimeOnly`.
This verifies the protected current configuration against the administrator-
published `config\dyson-control.runtime.json` approval; it does not open the
private transaction lock, receipts, or historical snapshots. The approval
contains hashes and counters, never environment values. It is revoked under
the mutation lock before a configuration transaction and is published only
after a successful clean terminal state and snapshot validation. Missing,
changed, or mismatched approval prevents startup. Do not hand-write an approval
to bypass an interrupted transaction; recover the transaction with the normal
configuration tools. Older installations acquire an approval through a
verified configuration install/reuse operation.

The default test remains the administrator's full journal/snapshot audit.
Runtime success does not claim that the service account can perform that audit
or restore configuration. Keep those private ACLs unchanged.

The deployment orchestration must:

1. run the elevated self-test and the API CLI tests;
2. create `<data-root>\data`, the active script root, and the runtime bootstrap
   root, and install the reviewed data-root parent ACL before calling the
   installer;
3. call the installer before registering or starting the control-plane task;
4. make the launcher consume only the validated target path and keep its six
   controlled overrides identical to this contract;
5. call the read-only test before start and surface only its public evidence;
6. add a real Local Service read/no-write acceptance test;
7. create and retain the protected preimage snapshot before changing the active
   release profile, pass it to installation, and on readiness failure create a
   snapshot of the failed profile before invoking restore;
8. accept `replace`/`restore` evidence only when the target hash, profile hash,
   ACL fingerprints, chain head, and transaction count match the subsequent
   read-only test;
9. preserve the previous release and both protected snapshots until the
   observation window and rollback drill have passed.
