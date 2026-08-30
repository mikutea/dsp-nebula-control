# Lifecycle safety contract

Dyson Control treats save, graceful stop, and restart as separate lifecycle
transactions. In the current release, the lifecycle endpoint is **dry-run
only**. It collects bounded evidence, creates a durable audit job, and returns
fixed check and blocker codes. It cannot change a process, scheduled task,
save, backup, or configuration.

## API contract

Authenticated operators can submit exactly one of these actions to
`POST /api/v1/actions/lifecycle/preview`:

- `save`
- `graceful-stop`
- `restart`

The request is strict: unknown actions and extra properties are rejected. A
successful response contains both the completed preview job and a strictly
validated `LifecyclePreview` object. Provider failures return a generic error;
raw paths, task names, command lines, logs, and exception text are not returned
to the browser.

Every preview has these invariant fields:

- `mode` is `dry-run`;
- `allowed` is `false`;
- `executionEnabled` is `false`;
- `execution-disabled` is present in `blockers`;
- `checks` contains only the documented fixed IDs;
- `rollback` describes the required recovery strategy without mutating data.

The API job is marked `succeeded` when evidence collection succeeds even if the
preview has blockers. A blocker is a valid safety result, not a collector
failure.

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
| `execution-lock` | The global lifecycle execution gate is locked. |

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
- release gate: `execution-disabled`.

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

## Requirements before execution can exist

Actual lifecycle mutation remains out of scope until all of the following are
implemented and integration-tested:

1. a fixed allowlisted adapter per action, with no arbitrary shell input;
2. a versioned request ID and durable phase receipts written atomically;
3. a separately observable save acknowledgement tied to the requested save;
4. verified `.dsv` + `.server` stability before and after the save phase;
5. a fresh hash-manifest backup before stop/restart activation;
6. bounded timeouts and explicit terminal outcomes for every phase;
7. a tested rollback job that references the same transaction and backup;
8. explicit production configuration enabling only the verified capability;
9. API, provider, and host integration tests covering success, timeout,
   tampering, stale PID, wrong principal, partial save, and interrupted restart.

Until those gates pass, the provider capability flags for save, graceful stop,
and restart remain false and no mutation route exists.
