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
  |-- durable SQLite jobs used as the current audit record
  |-- status/event API
  |-- React production assets
  v
Provider interface
  |-- demo: deterministic, non-mutating development data
  `-- windows: allowlisted PowerShell collectors/actions
       |
       `-- DSP, Nebula, BepInEx, saves, Windows scheduled tasks
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
`executionEnabled: false` before it reaches the API. See
[LIFECYCLE.md](LIFECYCLE.md).

## Data model

SQLite stores sessions and durable jobs. Jobs are the current persistent audit
surface; server-sent events are transient notifications derived from those
records. Saves, packages, and backups stay outside the database and are
referenced by opaque IDs plus hashes. Production paths are configuration, never
API output.

## Future update transaction

```text
preflight -> maintenance -> save -> graceful stop -> paired backup
-> stage packages -> hash/dependency validation -> smoke test -> activate
-> internal/public health checks -> commit
```

Any failure after the backup step transitions into a recorded rollback job.
