# Recoverable GSManager removal

This runbook describes the packaged, reusable GSManager removal transaction. It
is an implementation contract, not evidence that GSManager has been removed on
the Dyson host. All paths, identities, IDs, hashes, and ports below are
fictional. Keep real profiles, manifests, receipts, task XML, ACL exports, host
paths, logs, and operator evidence outside the public repository.

The removal tool does not delete a GSManager installation. It atomically moves
the fixed installation tree into a private recovery guard under `DataRoot`,
captures its file and directory hashes, ACL intent, scheduled-task XML, task
enabled state, and task DACL, then unregisters the already-disabled task. The
guard remains available for an explicitly confirmed restore. The operation is
serialized by the fixed host-mutation lease and produces bounded intents and
receipts without echoing private paths or file content.

## Reversible cutover before removal

The complete operator entry point is the authenticated HTTP API, not an
independent local CLI. An administrator uses `/api/v1/cutover/preview` before
the matching `/prepare`, `/activate`, or `/rollback` route under
`/api/v1/cutover`; each mutation binds its request ID and confirmation to the
returned plan fingerprint. Later rollback uses `later-operator-rollback`.
Use `/api/v1/cutover/status` to inspect recovery state before proceeding.
Lifecycle acceptance uses the authenticated preview, execute, and receipt
routes in [LIFECYCLE.md](LIFECYCLE.md). Windows administrator or SSH access
does not itself establish an application session. The `Submit-*BrokerRequest.ps1`
scripts expose individual host capabilities; manually chaining them does not
provide the complete coordinator, protection-point, compensation, and audit
workflow.

The previous-runtime stop path uses a transaction-bound temporary task in the
configured game account's `Interactive`, `Limited` session. It invokes the
release-bound stop script against the observed process identity and validates
the durable stop receipt and stopped runtime. It preserves the captured legacy
scripts and task definitions. Temporary-task cleanup must be verified before
the previous authority can be re-enabled or restarted; an incomplete stop
record requires recovery rather than a blind retry. This implementation does
not establish that a target-host switch or rollback drill has passed. Preserve
both the GSManager snapshot and paired-save protection point until those
separate acceptance records exist.

## Preconditions

Copy completion is not snapshot completion. The snapshot creator verifies the
copied bytes, canonical inventory, filesystem permissions, task capture, and
paired-save binding before publishing a final snapshot. A failed publication
or an unpublished temporary directory is not a recovery point. Require the
final snapshot ID and manifest hash, then run `Test-DysonGsManagerSnapshot.ps1`
with those exact values before proceeding. Preserve the independent save
protection point when a GSManager snapshot fails; do not remove the old manager
or retry a deterministic inventory failure without fixing its cause.

Run the Windows backend from an elevated Windows PowerShell 5.1 session only
after the approved cutover coordinator has established all of these facts:

- The declared candidate authority profile is valid, active, and bound to the
  exact project root, `DataRoot`, stable bootstrap root, runtime-task
  transaction root, service identity, game port, task names, and authority
  inventory revision supplied to the command.
- The candidate owns the active runtime and is healthy. The previous GSManager
  authority is disabled and not running; no GSManager process or listener owns
  the game port.
- A verified GSManager snapshot exists at the exact `SnapshotId` and manifest
  SHA-256, including the expected fixed root and scheduled-task preimage.
- A separate, verified protection point exists for the atomic `.dsv` and
  `.server` save pair. Its ID and manifest SHA-256 must match the command.
- Cutover-broker queues, intents, and work directories are empty; authority,
  runtime-task, host-mutation, and GSManager-removal transactions have no
  unresolved work.
- The GSManager installation contains no reparse point, redirected child, or
  entry outside the bounded tree. The recovery guard is on the same volume so
  the root move is atomic.

Every binding is checked again by the tool. A missing, ambiguous, pending, or
drifted precondition fails closed before the installation is moved. `-WhatIf`
performs the same read-only preflight but creates no lease, guard, intent, or
receipt file.

## Fictional command setup

The example values are deliberately non-production. Replace them only in the
private approved operator procedure, using digests copied from independently
verified receipts rather than typed from memory.

```powershell
$artifact = 'C:\GameServer\Example\Packages\DysonControl-v0.2.0'
$project = 'C:\GameServer\Example\DSP'
$gsm = 'C:\GameServer\Example\DSP\tools\ExampleGameManager'
$installRoot = 'C:\GameServer\Example\DysonControl'
$deploymentDataRoot = 'C:\GameServer\Example\DysonControlData'
$appDataRoot = Join-Path $deploymentDataRoot 'data'
$recoverySnapshotRoot = Join-Path $appDataRoot 'migration\snapshots'
$profile = Join-Path $appDataRoot 'authority-inventory\authority-profile.json'
$bootstrap = Join-Path $installRoot 'bootstrap'
$runtimeTransactions = Join-Path $deploymentDataRoot 'runtime-task-transactions'

$snapshotId = '00000000-0000-4000-8000-000000000001'
$snapshotManifestSha256 = ('a' * 64)
$saveProtectionPointId = 'save:22222222-2222-4222-8222-222222222222'
$saveProtectionManifestSha256 = ('b' * 64)
$authorityRevision = ('c' * 64)
$removalRequestId = '11111111-1111-4111-8111-111111111111'

$remove = Join-Path $artifact 'scripts\windows\migration\Remove-DysonGsManagerInstallation.ps1'
$inspect = Join-Path $artifact 'scripts\windows\migration\Test-DysonGsManagerRemoval.ps1'
$restore = Join-Path $artifact 'scripts\windows\migration\Restore-DysonGsManagerRemoval.ps1'

$binding = @{
  ProjectRoot = $project
  GsManagerRoot = $gsm
  DataRoot = $appDataRoot
  SnapshotId = $snapshotId
  SnapshotManifestSha256 = $snapshotManifestSha256
  PairedSaveProtectionPointId = $saveProtectionPointId
  PairedSaveProtectionManifestSha256 = $saveProtectionManifestSha256
  TaskName = 'Dyson-GSManager'
  ProfileFile = $profile
  RuntimeBootstrapRoot = $bootstrap
  RuntimeTaskTransactionRoot = $runtimeTransactions
  ServiceUser = '.\ExampleGameService'
  GamePort = 27015
  AuthorityInventoryRevision = $authorityRevision
}
```

Reuse the same instance and bindings used for installation and authority
initialization. The snapshot ID above must identify a verified snapshot below
`$recoverySnapshotRoot`; create, verify, and restore that snapshot with
`-DataRoot $appDataRoot`. Runtime task transactions default to the sibling
`$runtimeTransactions`, not a directory inside the application data root.

## Preview and remove

Preview first. A successful preview reports protocol
`DYSON_GSMANAGER_REMOVAL_V1`, `status: preview`, and
`productionChanged: false`; it does not authorize the real operation.

```powershell
& $remove @binding -RequestId $removalRequestId -WhatIf
```

Review the private pre-cutover evidence and the command's redacted preview.
Then use a fresh request ID from the approved maintenance record and the exact,
case-sensitive confirmation phrase:

```powershell
& $remove @binding `
  -RequestId $removalRequestId `
  -ConfirmationToken 'REMOVE_GSMANAGER_INSTALLATION' `
  -Confirm:$false
```

Retain the terminal removal receipt SHA-256 returned by the command. Repeating
the exact same request is idempotent only when its fingerprint and terminal
receipt match. Do not use `-Recover` as a retry shortcut: it is reserved for the
same request after inspection proves that its fixed lease was abandoned and its
durable intent is recoverable.

Inspect the terminal state independently:

```powershell
$removalReceiptSha256 = ('d' * 64) # fictional verified receipt digest

& $inspect @binding `
  -RemovalRequestId $removalRequestId `
  -RemovalReceiptSha256 $removalReceiptSha256
```

Inspection revalidates the receipt and guard binding, snapshot and paired-save
protection, pending-transaction gates, exact guarded tree, ACL intent, and the
absence of the old task and fixed installation root. It does not start or stop
either authority.

## Failure compensation

The removal intent records enough preimage to restore the exact installation
tree bytes and ACLs and the exact task XML, enabled state, and task DACL. If a
failure occurs after mutation starts, the transaction compensates before
returning an error. Treat an uncertain or compensation-failed result as a
maintenance incident: keep both authorities quiesced, preserve the private
guard, intents, and receipts, and investigate through the same request's
read-only inspection or explicitly approved recovery. Never manually copy the
guard over a live root and never delete a guard to make a retry pass.

## Preview and restore

Restore is a separate transaction. Before previewing it, the candidate must be
fully quiesced: candidate processes and tasks stopped, the game port closed,
GSManager still absent, and all unrelated mutations terminal. The removal
receipt and guard must validate exactly.

```powershell
$restoreRequestId = '33333333-3333-4333-8333-333333333333'

& $restore @binding `
  -RemovalRequestId $removalRequestId `
  -RemovalReceiptSha256 $removalReceiptSha256 `
  -RestoreRequestId $restoreRequestId `
  -WhatIf
```

After the private rollback decision and preview are approved, use the exact,
case-sensitive restore phrase:

```powershell
& $restore @binding `
  -RemovalRequestId $removalRequestId `
  -RemovalReceiptSha256 $removalReceiptSha256 `
  -RestoreRequestId $restoreRequestId `
  -ConfirmationToken 'RESTORE_GSMANAGER_REMOVAL' `
  -Confirm:$false
```

A successful restore is deliberately terminal as `restored-disabled` with
`activationRequired: true`. It restores the original bytes, ACLs, task XML, and
task DACL, but leaves the GSManager task disabled and does not start GSManager,
DSP, or Dyson Control. Authority activation belongs to the separate approved
cutover coordinator after inspection and health checks; this tool never performs
an implicit failback.

Verify the restore receipt and the disabled state independently:

```powershell
$restoreReceiptSha256 = ('e' * 64) # fictional verified receipt digest

& $inspect @binding `
  -RemovalRequestId $removalRequestId `
  -RemovalReceiptSha256 $removalReceiptSha256 `
  -RestoreRequestId $restoreRequestId `
  -RestoreReceiptSha256 $restoreReceiptSha256
```

The repository self-test exercises only fictional temporary roots and a Shadow
task scheduler. It covers non-mutating previews, confirmation and digest gates,
authority/activity/pending-work rejection, drift and guard tamper detection,
remove and restore fault compensation, idempotent receipts, independent
inspection, and exact `restored-disabled` recovery. Native Windows ACL and Task
Scheduler behavior, an observation window, and production removal/restore must
still be proven privately before any production acceptance item can be marked
verified.

Run that repository-only fixture from the repository root; it never authorizes a
real removal and all of its roots, tasks, identities, hashes, and receipts are
fictional:

```powershell
npm run migration:removal-selftest
```
