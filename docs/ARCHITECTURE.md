# Architecture

## Principles

1. Fail closed. Production starts only with explicit authentication secrets.
2. No arbitrary command execution. Every host action maps to an allowlisted
   adapter method and a fixed script.
3. Observe before mutate. Read-only inventory remains useful even when all
   lifecycle capabilities are disabled.
4. Every mutation is a durable job with an actor, input summary, result, and
   rollback reference.
5. A Nebula save is one unit containing matching `.dsv` and `.server` files.
6. A version change is staged and verified before activation.

## Runtime shape

```text
Browser
  | secure HttpOnly session cookie
  v
Fastify control plane (loopback)
  |-- authentication and CSRF/origin checks
  |-- durable SQLite jobs, lifecycle runs, phase receipts, global lock, and alert episodes
  |-- status/event and read-only catalogue APIs
  |-- typed configuration planner and fixed-file transaction
  |-- structured fixed-log reader with signed cursors and redaction
  |-- signed player-snapshot reader with bounded SQLite presence history
  |-- pure compatibility, update-plan, mod-lock, and client-profile libraries
  |-- React production assets
  v
Provider interface
  |-- demo: deterministic, non-mutating development data
  |-- windows: bounded PowerShell status and preflight collectors
  `-- lifecycle adapter: disabled by default; fixed methods only
       `-- verified Windows adapter (deployment opt-in)
       |-- DSP, Nebula, BepInEx, saves, Windows scheduled tasks
       `-- optional signed local file protocol
            `-- disabled-by-default BepInEx save bridge on Unity main thread
```

## Capability negotiation

The provider returns explicit capabilities alongside every status snapshot.
The UI never infers that a button is safe because a process exists. Unsupported
or unverified actions remain disabled.

Initial Windows capabilities:

- refresh status: enabled
- request save: disabled
- graceful stop: disabled
- restart: disabled
- restore: disabled
- update: disabled

Each capability is enabled only after its adapter has an integration test and a
documented failure/rollback path.

Lifecycle previews do not change capability negotiation. An authenticated
preview request first creates a durable job, then calls one fixed provider
method and one fixed PowerShell collector. The provider response is checked
against a strict schema and forced back to `allowed: false` and
`executionEnabled: false` before it reaches the API.

The execution API is a separate durable transaction surface. It requires a
strict confirmation plus idempotency key, then persists a job, lifecycle run,
and ordered receipts before scheduling work. A default-disabled adapter makes
the public repository safe to start on an arbitrary machine: it fails during
preflight and none of its mutation methods can run. Deployment code must inject
a verified Windows adapter explicitly. See [LIFECYCLE.md](LIFECYCLE.md).

The signed save bridge is a candidate adapter, not an enabled capability. Its
request protocol has no caller-supplied command, path, or save name, and both
runtimes validate the same HMAC test vectors. Provider and production
capabilities remain false until the bridge heartbeat, global lifecycle lock,
transaction phases, fresh backup, rollback job, and target-host integration
evidence are complete.

Configuration apply is a separate fixed-file transaction. It accepts only
catalog IDs, creates a byte snapshot, writes a redacted durable audit, atomically
replaces planned files, verifies the aggregate revision, and automatically
restores original bytes after a partial failure. It does not restart the game
or expose an arbitrary file writer. See [CONFIGURATION.md](CONFIGURATION.md).

Console and player surfaces are observation-only. The console opens only
`BepInEx/LogOutput.log` under the trusted server root, signs resumable cursors,
and redacts before filtering or output. The player bridge emits a fresh signed
snapshot with opaque session IDs and no network/Steam identifiers. Neither
surface provides a command or moderation operation. See
[CONSOLE-PLAYERS.md](CONSOLE-PLAYERS.md).

## Data model

SQLite stores sessions, durable jobs, lifecycle runs, ordered phase receipts,
the cross-process lifecycle lock, save-job state, the bounded retained
observability window, and a revisioned singleton projection for durable alert
episodes. Alert updates use compare-and-swap publication: uncertain persistence
locks the live alert reducer until a restart reloads authoritative state, while
exact snapshot and acknowledgement retries remain idempotent. It also stores the last minimized authoritative player
projection, at most eight minimized per-session replay cursors, and a separately
count-and-time-bounded join/leave window so API restarts preserve snapshot
idempotency; those tables contain no raw bridge payload, HMAC, secret, network
identifier, Steam identifier, or filesystem path. Jobs are the operator-facing persistent audit surface;
the lifecycle and save-job tables are machine-recoverable transaction state.
Configuration apply/history, save-pair bytes, mod deployment, and component
activation retain bounded manifests, journals, receipts, backups, and locks
beneath their construction-time trusted roots. Player presence events are
bounded by both count and age, including idle-time pruning, and have no export route. Server-sent events are transient notifications
derived from durable jobs. Saves, packages, backups, staged releases, and
configuration snapshots stay outside SQLite and are referenced publicly only
by opaque IDs. Production paths are configuration, never API output.

## Update transaction boundary

The update pipeline discovers bounded metadata, evaluates a compatibility
matrix, stages offline artifacts into immutable hash-checked directories,
resolves dependencies, produces deterministic server/client locks, and owns a
separate default-off live activation transaction. The preparation plan remains
explicitly `staging-only`; it cannot activate bytes. Authenticated activation
routes and the Web workflow exist, while real host mutation still requires the
fixed Windows adapter and an enabled construction-time gate.

The component transaction is:

```text
compatibility/revision preflight -> verify immutable staged package
-> prove stopped process and closed port -> paired-save protection point
-> revalidate -> publish and hash fixed live files -> fixed start/load smoke
-> commit durable state and receipt
```

Any failure after live publication compensates the actual files, restores the
previous state, and independently smokes the previous version. Unproven
compensation persists `recoveryRequired` for restart reconciliation. Package
layout policies are component-specific; BepInEx bootstrap ownership never
includes user configuration or plugins. Until controlled-host evidence exists,
the execution gate remains false and no repository receipt is production
verification. See [UPDATES-CLIENTS.md](UPDATES-CLIENTS.md).
