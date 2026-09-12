# Dyson Control DataRoot recovery bundles

The public recovery tools create, independently verify, and restore a complete
Dyson Control `DataRoot` without embedding a production path in the repository.
They are operator tools, not evidence that a production backup or restore has
been performed. All examples below use fictional local paths.

## Safety contract

Use Windows PowerShell 5.1. Every command requires an explicit absolute
`DataRoot` and `RecoveryRoot`; neither has a production default. The roots must
not overlap. Keep `RecoveryRoot` on protected storage and outside `DataRoot`,
because it contains private configuration, logs, application state, save data,
ACL descriptors, protection points, receipts, and audit records.

Before a create or restore operation can acquire the fixed host-mutation lease,
the tools require all of the following:

- the exact `Dyson-Control-Plane` scheduled task exists at `\` and is `Ready`
  or `Disabled`, never `Running` or `Queued`;
- the shared host-mutation lease is empty or released;
- lifecycle- and cutover-broker intents are empty, cutover work is empty, and
  every retained broker request has a matching terminal receipt with the same
  ID, fingerprint, and capability;
- no interrupted DataRoot recovery intent is present;
- the DataRoot contains only `acceptance`, `audit`, `config`, `data`, `logs`,
  `migration`, `runtime-task-transactions`, `snapshots`, and `state` at its top
  level;
- the entire selected tree consists only of ordinary files and directories,
  with no junction, symlink, mount point, or other reparse point;
- no SQLite `-wal` or `-shm` sidecar remains; checkpoint and close the database
  before continuing; and
- every `.dsv` file has its same-stem `.server` partner and vice versa.

These checks are repeated after the lease is acquired. A failure is closed and
returns a fixed error code; file contents and child-process output are not
included in the result.

## Bundle format

A recovery bundle is published only after a sibling partial directory has been
fully copied and independently verified. Its exact layout is:

```text
<RecoveryRoot>\
  bundles\<bundle-id>\
    manifest.json
    payload\...
  protection-points\<restore-operation-id>\...
  state\<data-root-identity>\
    intents\
    receipts\
    audit.jsonl
```

The manifest records a bounded, sorted inventory. Each file entry has its
relative path, type, length, SHA-256, and exact binary security-descriptor
intent. Directory entries, including the DataRoot itself and empty directories,
also carry their ACL intent. The manifest binds the bundle ID and the normalized
DataRoot identity. Creation reads and hashes the source before and after the
streaming copy; any concurrent byte, path, or ACL change rejects the operation.

The manifest SHA-256 printed by a successful create operation is the independent
verification anchor. Store that digest separately from the bundle. Verification
and restore require the expected digest rather than trusting a manifest found
beside its own payload.

## Create and verify

First preview the complete preflight. `-WhatIf` does not create `RecoveryRoot`,
the fixed lease sidecar, a partial bundle, a receipt, or an audit record.

```powershell
$artifact = 'C:\GameServer\Example\Packages\DysonControl-0.2.0'
$dataRoot = 'C:\GameServer\Example\DysonControlData'
$recoveryRoot = 'D:\ExampleProtectedRecovery\DysonControl'
$bundleId = '11111111-2222-4333-8444-555555555555'
$tools = Join-Path $artifact 'scripts\windows\data-recovery'

& (Join-Path $tools 'New-DysonDataRootRecoveryBundle.ps1') `
  -DataRoot $dataRoot `
  -RecoveryRoot $recoveryRoot `
  -BundleId $bundleId `
  -WhatIf
```

After reviewing the preview, run the same bounded command without `-WhatIf`.
The returned JSON contains only opaque IDs, hashes, counts, and byte totals.

```powershell
$created = & (Join-Path $tools 'New-DysonDataRootRecoveryBundle.ps1') `
  -DataRoot $dataRoot `
  -RecoveryRoot $recoveryRoot `
  -BundleId $bundleId `
  -Confirm:$false | ConvertFrom-Json

$manifestSha256 = [string]$created.manifestSha256
```

Independently verify the exact bundle before copying it to another protected
medium and again before every restore:

```powershell
& (Join-Path $tools 'Test-DysonDataRootRecoveryBundle.ps1') `
  -RecoveryRoot $recoveryRoot `
  -BundleId $bundleId `
  -ExpectedManifestSha256 $manifestSha256
```

An extra, missing, redirected, resized, or modified payload item fails
verification. A changed manifest also fails against the separately retained
digest.

## Preview and perform a restore

A restore has both PowerShell `ShouldProcess` protection and a fixed explicit
confirmation phrase. Preview does not require the phrase and performs no write:

```powershell
$operationId = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'

& (Join-Path $tools 'Restore-DysonDataRootRecoveryBundle.ps1') `
  -DataRoot $dataRoot `
  -RecoveryRoot $recoveryRoot `
  -BundleId $bundleId `
  -ExpectedManifestSha256 $manifestSha256 `
  -OperationId $operationId `
  -WhatIf
```

For an approved restore, stop all control-plane use, recheck that the scheduled
task remains quiesced, then supply the literal confirmation phrase:

```powershell
& (Join-Path $tools 'Restore-DysonDataRootRecoveryBundle.ps1') `
  -DataRoot $dataRoot `
  -RecoveryRoot $recoveryRoot `
  -BundleId $bundleId `
  -ExpectedManifestSha256 $manifestSha256 `
  -OperationId $operationId `
  -Confirmation RESTORE_DYSON_CONTROL_DATA_ROOT `
  -Confirm:$false
```

Before the visible DataRoot is replaced, the tool creates and fully verifies a
private protection-point bundle of the current tree. It reconstructs the
candidate in a same-volume sibling directory, applies every recorded ACL, and
verifies bytes and ACLs before using directory renames for the visible swap. If
any later restore stage fails, the superseded original directory is renamed back
and verified against the protection point. A failed exact rollback abandons the
lease and reports recovery-required state instead of continuing.

Successful create and restore operation IDs are idempotent. Replaying an exact
ID validates the immutable receipt and current bundle or restored tree, then
returns `reused: true`. Reusing an ID with a different operation, bundle,
DataRoot identity, or manifest digest is rejected. Do not delete or edit the
fixed lease record, recovery receipts, protection points, or audit log to force
an operation through.

## Repository-only validation

The self-test uses a fresh temporary Shadow root and never calls the production
scheduler. It covers a 32 MiB streaming file, SQLite sidecars, save pairing,
reparse escape, broker pending state, task quiescence, manifest and payload
tampering, missing and extra entries, `WhatIf`, explicit confirmation,
protection-point creation, idempotent replay, and an injected post-publication
failure with byte- and ACL-exact rollback:

```powershell
npm run data-recovery:selftest
```

A passing Shadow test proves the repository transaction and validation logic;
it is not production acceptance evidence. A real recovery drill still requires
private evidence bound to the exact host, artifact, manifest digest, operator
approval, and observed application health after restart.
