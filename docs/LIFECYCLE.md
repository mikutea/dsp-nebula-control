# Lifecycle safety contract

Dyson Control treats save, graceful stop, and restart as separate durable
lifecycle transactions. The repository contains a read-only preview API, the
transaction coordinator, and an opt-in Windows execution adapter. The default
runtime adapter is still **execution-disabled**, so a normal checkout can be
exercised and audited without changing a process, scheduled task, save, backup,
or configuration. Target-host mutation exists only when the Windows provider
is selected and `DYSON_LIFECYCLE_ENABLED=true` is supplied together with the
absolute bridge-control and secret-file paths. Omitting any of those conditions
fails closed during configuration or preflight.

## API contract

Authenticated operators can submit exactly one of these actions to the
lifecycle APIs:

- `save`
- `graceful-stop`
- `restart`

`POST /api/v1/actions/lifecycle/preview` accepts the strict body
`{ "action": "..." }`. A successful response contains both the completed
preview job and a validated `LifecyclePreview` object. Provider failures return
a generic error; raw paths, task names, command lines, logs, and exception text
are not returned to the browser.

`POST /api/v1/actions/lifecycle/execute` accepts only `action`, a bounded
`idempotencyKey`, and the exact confirmation token `EXECUTE`. A new request is
queued with HTTP 202. Repeating the same idempotency key returns the original
transaction with HTTP 200 and never repeats its phases. Reusing that key for a
different action is rejected with HTTP 409. Operators poll
`GET /api/v1/lifecycle/:id` for the durable job, run, protection-point reference,
recovery flag, and ordered phase receipts.

With the default disabled adapter, every preview has these invariant fields:

- `mode` is `dry-run`;
- `allowed` is `false`;
- `executionEnabled` is `false`;
- `execution-disabled` is present in `blockers`;
- `checks` contains only the documented fixed IDs;
- `rollback` describes the required recovery strategy without mutating data.

When the opt-in Windows adapter is configured, preview is still read-only. It
can report `allowed=true` and `executionEnabled=true` only when the fixed host
collector has no blockers, a fresh signed game-bridge heartbeat is valid, a
verified rollback baseline exists, and the global execution lock is available.
The browser then requires a separate explicit confirmation before submitting an
execution request.

The API job is marked `succeeded` when evidence collection succeeds even if the
preview has blockers. A blocker is a valid safety result, not a collector
failure.

## Durable transaction coordinator

Lifecycle state is persisted in SQLite before work begins:

- `lifecycle_runs` owns the request ID, idempotency key, current phase,
  protection-point reference, terminal state, and recovery-required flag;
- `lifecycle_receipts` records every phase start and terminal result in order;
- `lifecycle_locks` provides one cross-process global mutation lease;
- the existing `jobs` row provides the operator-facing audit summary.

The fixed phase order is:

```text
lock -> preflight -> protection-point -> save
     -> [stop -> verify-stopped]
     -> [start -> verify-running]
```

The bracketed stop phases apply to graceful stop and restart; the start phases
apply to restart. If a restart fails after stop may have occurred, the
coordinator requests `rollback-start` and then performs another
`verify-running`. Every adapter call receives the same request ID, an optional
opaque protection-point ID, a bounded timeout, and an abort signal.

On control-plane startup, queued or running lifecycle rows are reconciled to
the explicit `interrupted` state. Any open phase receives a
`CONTROL_PLANE_RESTARTED` receipt, the job becomes failed with
`LIFECYCLE_INTERRUPTED`, the lock is released, and no unsafe phase is replayed
automatically. The operator must inspect the recovery-required flag before a
new transaction.

## Evidence checks

| Check ID | Evidence collected |
| --- | --- |
| `project-root` | The configured project root resolves. |
| `managed-process` | The PID resolves to the exact managed DSP executable. |
| `pid-file` | The managed PID file points to a live process. |
| `save-pair` | A matching `.dsv` and `.server` pair exists. |
| `backup-pair` | The latest paired backup matches its schema-v1 SHA-256 manifest. |
| `server-task` | The fixed start task exists when restart needs it. |
| `stop-task` | The fixed graceful-stop task exists when stop is needed. |
| `stop-task-principal` | The stop task is interactive and matches the game process owner. |
| `stop-task-action` | The stop adapter is inside the configured script allowlist. |
| `stop-task-result` | The previous stop task returned zero. This is supporting evidence only. |
| `task-history` | Task Scheduler operational history is available; absence is a warning. |
| `receipt-channel` | The stop adapter declares the versioned durable receipt protocol. |
| `save-trigger` | A separate, verifiable save acknowledgement exists. |
| `execution-lock` | The global lifecycle execution gate is available; an active transaction blocks a new preview. |

Check status is one of `pass`, `warning`, `block`, or `not-applicable`. The UI
maps IDs and statuses to localized labels and does not render host-provided
diagnostic text.

## Blocker codes

Blockers are stable machine-readable reasons. They currently include:

- project/process identity: `project-root-unavailable`,
  `managed-process-unverified`, `pid-file-unverified`;
- data recovery: `save-pair-incomplete`, `backup-pair-unverified`;
- task chain: `server-task-missing`, `stop-task-missing`,
  `stop-task-principal-mismatch`, `stop-task-not-interactive`,
  `stop-task-action-unallowlisted`, `stop-task-last-result-failed`;
- proof of completion: `receipt-channel-missing`,
  `save-trigger-unverified`;
- execution gate: `execution-disabled`, `execution-lock-busy`.

No UI state, process presence, task state, or previous zero exit code can remove
a blocker by inference.

## Rollback strategies

- `save` requires a fresh paired-save backup before activation. The preview can
  prove that an existing hash-verified baseline is available, but the eventual
  transaction must create its own fresh rollback point.
- `graceful-stop` uses `restart-from-same-save`; it must preserve the verified
  pair unchanged.
- `restart` uses `paired-save-backup`; the stop and start phases share one
  transaction and rollback reference.

The backup verifier requires schema version 1, one `.dsv`, one matching
`.server`, exact byte lengths, and matching SHA-256 hashes. Missing, malformed,
or tampered manifests fail closed.

The repository also contains a standalone paired-save backup/restore
transaction core and a retention dry-run planner. They are not yet exposed as
authenticated mutation routes or coordinated with this lifecycle service, so
they do not enable restore in the browser or production. See
[SAVES.md](SAVES.md) for that implementation boundary.

## Signed save bridge candidate

The repository now contains a disabled-by-default
[`DysonControlBridge`](../integrations/dyson-control-bridge/README.md) candidate
and a TypeScript file-protocol client. The bridge does not listen on a network
socket. It accepts exactly one HMAC-authenticated action, `save`, through an
atomic local request file and always saves to Nebula's fixed `_lastexit_` slot.

The game-side plugin runs the save call on Unity's main thread and emits a
signed durable receipt only after `GameSave.SaveCurrentGame` succeeds,
Nebula's `GameStatesManager.LastSaveTime` advances, and the matching `.dsv` and
`.server` fingerprints remain stable for the configured window. The C# and
TypeScript implementations share fixed protocol vectors, signature-tamper
tests, strict field ordering, bounded files, request expiry, cooldown,
interrupted-request reconciliation, and a signed two-second plugin heartbeat.

The Windows lifecycle adapter now has fixed implementations for protection
point creation, bridge save, scheduled stop/start dispatch, and independent
runtime verification. Its paired-save protection script copies into a private
same-volume staging directory, compares source fingerprints before and after
the copy, verifies destination hashes, writes a schema-v1 manifest, and only
then publishes the directory atomically. The same request ID re-verifies and
reuses the original protection point; a modified copy fails validation.

This is implementation evidence, not production verification. The execution
HTTP route now feeds the durable coordinator, but its repository-default
adapter is non-mutating, provider capability remains false, and the bridge is
not installed or enabled by repository defaults. The current Windows preflight
continues to report `save-trigger-unverified` until a signed bridge heartbeat
and controlled integration save have been verified on the target host.

## Requirements before production cutover

The repository implementation is not, by itself, production verification.
Before enabling target-host lifecycle mutation, the release manifest still
requires all of the following on the Dyson VM:

1. install the version-pinned API, web bundle, bridge plugin, and fixed Windows
   scripts through the reviewed deployment package;
2. create the interactive start and graceful-stop scheduled tasks for the same
   Windows account that owns the Steam/DSP process, then verify their principal,
   action, history, and durable receipts;
3. verify a fresh signed heartbeat and a controlled save acknowledgement against
   a disposable paired save before any live save is used;
4. exercise save, graceful stop, restart, failed-start rollback, timeout,
   interrupted-control-plane reconciliation, and tampered/partial save cases;
5. independently verify the protection-point manifest and restore rehearsal;
6. record the exact production configuration and then explicitly enable
   `DYSON_LIFECYCLE_ENABLED=true` during the announced maintenance window.

Until these host gates pass, the production configuration must keep lifecycle
execution disabled. Conservative capability flags in the overview remain false;
the game-management workspace uses the per-action preview result as its only
execution gate.
