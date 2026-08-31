# Save and backup management

Dyson Control treats a Nebula save as one atomic unit: a matching `.dsv` file
and `.server` sidecar with the same base name. A single file is never a healthy
save, backup, restore source, or retention candidate.

The browser now exposes bounded catalogues, backup verification, save-pair
revision reads, and preview/confirmation flows for atomic backup and guarded
restore. The matching API routes are authenticated and same-origin protected.
Execution is independently disabled by default and none of these workflows has
been run on the target VM. Restore must remain disabled in production until the
host and game-load gates below pass.

## Catalogue and transaction API

Authenticated operators can use:

- `GET /api/v1/saves?pageSize=<n>&cursor=<opaque>`;
- `GET /api/v1/backups?pageSize=<n>&cursor=<opaque>`;
- `GET /api/v1/backups/:backupId/verify`;
- `GET /api/v1/saves/:saveName/revision`;
- `POST /api/v1/saves/backup/preview`;
- `POST /api/v1/saves/backup/execute`;
- `POST /api/v1/saves/restore/preview`;
- `POST /api/v1/saves/restore/execute`;
- `POST /api/v1/saves/transfers/exports`;
- `GET /api/v1/saves/transfers/exports/:requestId`;
- `POST /api/v1/saves/transfers/imports/:requestId`;
- `GET /api/v1/backups/retention/annotations`;
- `POST /api/v1/backups/retention/annotations`;
- `POST /api/v1/backups/retention/preview`;
- `POST /api/v1/backups/retention/execute`;
- `POST /api/v1/backups/retention/restore`;
- `POST /api/v1/backups/retention/purge/preview`;
- `POST /api/v1/backups/retention/purge/execute`.

Roots are derived from the trusted project configuration. Catalogue and
backup/restore responses contain bounded IDs, names, timestamps, sizes, health,
and stable issue codes; they do not contain filesystem paths, file contents, or
pair hashes. Transfer receipts intentionally include the transport artifact's
SHA-256 so a browser can independently verify downloaded or uploaded bytes.
The save catalogue page limit is 100, the backup limit is 25, and directory
scans fail closed above 10,000 entries.

Preview routes always invoke the transaction service in dry-run mode and return
`meta.executionEnabled` separately. Execute routes fail with
`SAVE_MUTATIONS_DISABLED` unless the host explicitly sets:

```text
DYSON_SAVE_MUTATIONS_ENABLED=true
```

The setting is `false` by default and is rejected unless
`DYSON_PROVIDER=windows`. Backup execution additionally requires the literal
confirmation `CREATE_BACKUP`; restore execution requires
`RESTORE_SAVE_PAIR`. Request bodies are strict and cannot select a root, path,
script, command, or port.

## Backup transaction implementation

The transaction service and authenticated UI support dry-run followed by
explicitly confirmed, idempotent backup using the same UUID request ID. The
service verifies a stable live pair, streams both files to private staging,
records exact lengths and SHA-256 values in a schema-v1 manifest, and publishes
the protection directory atomically. An incomplete or continuously changing
pair is never published. One cross-process save lock serializes backup and
restore operations, and redacted durable audit records omit paths, hashes, and
file contents.

The fixed-root retention execution core is wired through authenticated,
same-origin HTTP routes and the save-management browser workspace. All
mutation routes require the Administrator `saves.restore` permission. The
browser can submit only bounded backup IDs, policy fields, digests, UUIDs and
fixed confirmations; it cannot submit a root, path, command, URL or file name.
The HTTP controller strictly reparses core output before returning it and
fails closed if an unexpected field, duplicate backup ID or request/receipt
binding mismatch appears.

Retention writes use a distinct default-off Windows-only gate:

```text
DYSON_SAVE_RETENTION_MUTATIONS_ENABLED=true
DYSON_SAVE_RETENTION_PURGE_MINIMUM_HOURS=168
```

The purge minimum is server-owned, accepts 1..8760 hours, and defaults to seven
days. A successful preview remains available while the write gate is closed and
returns `meta.executionEnabled=false`; annotation, retirement, restore and
purge return HTTP 423 before calling the core. The service inventories backup
directories itself, re-verifies manifests and pair hashes, folds versioned
annotations and protection pins into a digest-bound dry-run, and rejects
redirected or changed candidates. A confirmed first-stage transaction moves
only the selected backup directories into a private retirement area beneath the
configured backup root. Every move is journaled, idempotent, and compensated in
reverse on failure; a separately confirmed restore transaction returns the
entire retired set to the active catalogue.

Permanent pruning is a distinct second-stage transaction. It defaults to a
seven-day retirement grace period, requires a fresh purge preview digest and
the literal `PURGE_RETIRED_BACKUPS`, preflights the complete batch, refuses
extra or redirected files, and writes a durable per-backup deletion intent
before unlinking its three owned files. A crash during irreversible removal is
reported as recovery-required and only the same bound purge request may resume.
Annotations use immutable private events, optimistic revisions, a 256-character
limit, and the shared retention lock; they do not enter manifests, logs, public
release artifacts, or live-save directories. The browser requires a fresh
server preview and exact local `RETIRE`, `RESTORE` or `PURGE` text before it
sends the longer fixed API confirmation. It labels first-stage retirement as
recoverable and explicitly states that disk space has not yet been released.
HTTP/controller, RBAC and UI wiring are repository-tested, but the execution
gate must remain closed until the target-host maintenance and restore-drill
requirements below pass. The filesystem journal and immutable receipt are the
authoritative durable operation record; mirroring these operations into the
generic jobs page remains a post-RC usability enhancement, not a substitute for
the private receipt.

## Bounded download and upload quarantine

Raw save transfer is a separate Administrator-only permission and a separate
default-off host gate:

```text
DYSON_SAVE_TRANSFER_ENABLED=true
DYSON_SAVE_TRANSFER_ROOT=C:\GameServers\DSP\transfers
```

The gate is accepted only with the Windows provider and an absolute, fixed
server-side transfer root. Requests cannot choose a path, URL, executable,
temporary name or multipart destination. Export preparation accepts only a
UUID and verified backup ID. A download is opened only by that UUID and returns
fixed content type, byte length and archive digest headers.

The deterministic `DYSONPAIRARCHV1` stream contains exactly three ordered
entries: a canonical transport manifest and one matching `.dsv`/`.server`
pair. Every entry has bounded length, CRC32 and SHA-256 evidence, and the whole
stream has a declared byte length and SHA-256. Export rereads and rehashes the
source through stable handles before publication and independently verifies the
finished archive before it can be downloaded.

Upload metadata is limited to the URL UUID, `Content-Length`, and
`X-Dyson-Content-SHA256`; bytes use
`application/vnd.dyson-control.save-pair` and remain streamed. The verifier
rejects traversal, absolute/UNC/drive/ADS/device names, duplicate or extra
entries, trailing bytes, truncation, oversized chunks/files/pairs, redirected
roots and all digest/CRC mismatches. A successful import is atomically
published only to a fixed quarantine/inbox and returns
`restoreExecuted: false`. It never calls restore and never overwrites an active
save. Export and import both have cross-instance locks, idempotent file
receipts, orphan-publication reconciliation and bounded free-space checks.

The Web workspace exposes transfer controls only to an authenticated
Administrator with `saves.transfer`. Export selection is populated solely from
healthy, manifest-verified catalogue entries; there is no free-form backup ID,
path, URL, or command field. After download, the browser independently checks
the fixed media type, declared length, disposition, response digest, and actual
byte digest before offering the `.dyson-save-pair` file.

Import accepts only one `.dyson-save-pair`, calculates its SHA-256 in the
browser, and sends the fixed media type plus bounded length/digest metadata.
The UI labels a successful result as quarantine/inbox publication and always
shows `restoreExecuted=false`; it deliberately has no restore button. A 403,
423, or 503 response locks the workspace fail-closed, while browser cancellation
is described accurately as cancelling the wait rather than undoing a request
that the server may already have completed.

## Restore transaction workflow

The browser first reads the current save-pair revision, submits a no-write
preview, displays the protection and rollback behavior, and requires a second
confirmation before execution. The restore service requires:

- a trusted backup ID whose exact pair and manifest reverify;
- the expected revision of the live pair;
- independent evidence that the managed process is stopped and the game port
  is not listening;
- a separate request ID for a fresh protection backup of the current live pair.

On the Windows provider, that independent evidence comes only from the fixed
`Test-DysonRuntimeState.ps1` adapter with server-configured project root,
`Expected=stopped`, and the configured game port. The request cannot replace
those arguments. Both exact process state and closed-port evidence must match.

Only then does the transaction stage and replace both files. The stopped-state
gate is checked again before commit. A partial replacement failure triggers
byte-for-byte compensation from the protection point; the result distinguishes
`rolled-back` from `rollback-failed`. Dry-run does not create a protection point
or write a target file. The UI reports whether the result was reused, whether
the audit was persisted, and whether compensation was required without
returning paths, hashes, or save contents.

Tests cover authentication, the closed execution gate, preview versus execute,
fixed confirmation tokens, paired backup and restore, stopped-process plus
closed-port refusal, incomplete and changing pairs, optimistic revision
conflict, tampered backup bytes, running/unverifiable service state, concurrent
calls, path traversal, redirected roots, partial commit failure, replay of a
completed receipt, retention preview, recoverable retirement/restore,
annotation concurrency, grace-period purge, and crash-resumable purge.

## Production boundary

The repository tests use temporary fictional directories. Authenticated routes,
durable save jobs, role-based authorization and confirmation UI exist, but
there is still no target-host access-control test, real save-load proof, or
browser verification against the target service. A passing route test showing
that bytes were restored does not prove DSP/Nebula can load the pair.

Before production restore is enabled:

1. keep `DYSON_SAVE_MUTATIONS_ENABLED=false` until an approved disposable-host
   test and maintenance window;
2. verify coordination between the durable save-job lock and lifecycle/update
   maintenance windows on the target host;
3. verify the fixed stopped-state script, API/UI confirmation chain, transfer
   quarantine, audit and
   rollback result in a real browser without exposing paths, hashes, or contents;
4. restore a disposable paired save, start the pinned server build, load it,
   join with an external Nebula client, save again, and verify the new pair;
5. inject partial, tampered, interrupted, disk-pressure, and control-plane
   restart cases on a controlled Windows host;
6. confirm the implemented Viewer/Operator/Administrator policy against the
   deployed reverse-proxy session boundary;
7. keep the private drill evidence outside the repository.

`SAV-003` and `SAV-004` may be `implemented` based on repository code and tests,
but `SAV-005` and production restore remain `not-started` until those host and
game-load gates pass.
