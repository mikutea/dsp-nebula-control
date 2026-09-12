# Console and player management boundaries

The console provides bounded logs plus four typed lifecycle actions; it is not
a terminal or generic file reader. The player workspace exposes the minimized
roster and one narrowly typed mutation: a fixed-template notice to one currently
bound player session. Kick, ban, allow/deny-list, disconnect, permission and
free-text chat controls remain unavailable.

The repository includes API and browser implementations with deterministic
tests. The Dyson Control bridge, its runtime Nebula assembly-identity check,
console collector, browser reconnect behavior, and retention policy have not
yet been verified on the target VM, so the corresponding acceptance
requirements remain `implemented`, not `verified`.

## Structured console

### Fixed source and configuration

The reader can open only this path beneath the trusted server root:

```text
BepInEx\LogOutput.log
```

The path is constructed server-side. Requests cannot submit a path, filename,
regular expression, command, or shell fragment. The reader rejects redirected
roots/files, missing or oversized files, oversized requests, invalid cursors,
and unknown fields.

A production deployment must set a private signing secret for resumable
cursors:

```text
DYSON_CONSOLE_CURSOR_SECRET=<at least 32 random characters>
```

The value belongs in the host's private configuration file, never in the
repository or browser. Without it, the default Windows console reader is not
configured and the API returns a bounded 503 response.

### Read and download APIs

All routes require an authenticated session:

- `POST /api/v1/console/logs/query` reads a bounded page;
- `POST /api/v1/console/logs/download/preview` returns a non-mutating export
  plan;
- `POST /api/v1/console/logs/download` returns a bounded JSON or NDJSON export.

A read request may contain only:

```json
{
  "start": "tail",
  "maxBytes": 262144,
  "limit": 200,
  "filters": {
    "levels": ["warning", "error", "fatal"],
    "source": "NebulaNetwork",
    "from": "2026-08-30T00:00:00.000Z",
    "to": "2026-08-30T01:00:00.000Z",
    "text": "fictional event"
  }
}
```

Later requests use the returned signed cursor and omit `start`. The cursor binds
the fixed file identity, byte position, generation, partial-line state, and a
content anchor. Tests cover append, rotation, truncation, truncate-and-regrow,
partial lines, oversized lines, cursor tampering, and repeatable pagination.
This makes browser reconnection resumable without returning a host path.

The hard per-page limits are 1 MiB scanned and 500 returned records. A download
is capped at 2,000 records, 4 MiB of output, 16 MiB scanned, and 64 pages. The
response explicitly reports truncation instead of silently claiming a complete
export.

Every parsed source and text field passes through the versioned redactor before
filtering, display, or download. Current tests cover credentials, filesystem
paths, endpoints, and common player-identity forms. Raw BepInEx lines are never
returned by these routes.

### Fixed command deck

The console command API accepts exactly `server.start`, `server.save`,
`server.stop`, or `server.restart`. Preview maps the selected command to the
existing durable lifecycle service and returns its dry-run checks, blockers and
rollback state. Execution requires the command-specific literal confirmation,
an idempotency key, Operator-or-higher permission, the independent lifecycle
mutation gate, and all lifecycle preconditions. The browser has no command text
box. Results are followed through the same SQLite lifecycle phases and receipts.

These routes cannot invoke arbitrary PowerShell, accept a caller command line,
write an arbitrary file, or bypass log redaction. Unknown or extra fields are
rejected before the lifecycle service is called. `CON-003` is therefore
repository-implemented but remains unverified until the target-host and browser
receipt chain passes.

## Player sessions

### Authoritative source

The disabled-by-default BepInEx bridge publishes a signed
`DYSON_CONTROL_PLAYERS_V1` snapshot through an atomic local file replacement.
It reads Nebula's server-side connected-player collection and reconciles
Nebula's multiplayer start/end and player join/leave events. The pinned source
contract is documented in the bridge's
[`README`](../integrations/dyson-control-bridge/README.md).

The API reads only the fixed `players` file beneath the configured bridge
control root, verifies HMAC-SHA-256, checks freshness and monotonic sequence,
and rejects redirected, missing, oversized, stale, malformed, or tampered
snapshots. `DYSON_BRIDGE_CONTROL_ROOT` and `DYSON_BRIDGE_SECRET_FILE` must be
configured as an absolute pair. The default freshness window is 10 seconds and
can be changed from 2 to 120 seconds with
`DYSON_PLAYER_SNAPSHOT_MAX_AGE_MS`.

`GET /api/v1/players` returns only:

- an opaque per-session player ID;
- a bounded display name;
- online state and join time;
- a coarse `planet:<id>`, `star:<id>`, or `deep-space` location;
- bounded join/leave observations derived from successive signed snapshots.

The snapshot is capped at 64 players. The bridge does not serialize connection
objects, IP addresses, endpoints, Steam identifiers/state, `player.key`,
coordinates, mecha data, credentials, or filesystem paths. The control database
persists only the last accepted authoritative projection and the minimized event
fields listed above, plus the opaque bridge `sessionId` needed to keep sessions
separate. It never persists the bridge payload, HMAC, HMAC secret, endpoint,
Steam identity, connection object, or source/secret path.

Replay protection survives an API restart without retaining another roster
copy. A canonical cursor list contains at most eight bridge sessions and, for
each, only the opaque session ID, monotonic sequence, source write time, snapshot
state, and a SHA-256 fingerprint of the already-minimized canonical snapshot.
The fingerprint is not an HMAC and stores neither the signing secret nor the raw
bridge file. An `unavailable` snapshot advances this per-session high-water in
the same transaction while leaving the authoritative roster unchanged; an old
signed snapshot therefore cannot be accepted after a restart. Cursor order also
acts as a global source-clock high-water: a newly accepted snapshot must have a
strictly later source write time, and an exact idempotent replay is allowed only
for the globally latest cursor. This remains effective when the oldest
per-session cursor is evicted at the eight-session bound. For authoritative
responses, the API projects the accepted persisted snapshot rather than the raw
file it just read, so an ignored or rejected observation cannot be presented as
the current roster.

Player history is bounded by both count and age. Defaults are 512 events and
168 hours; `DYSON_PLAYER_HISTORY_CAPACITY` accepts 1 through 2048 and
`DYSON_PLAYER_HISTORY_RETENTION_HOURS` accepts 1 through 720. Pruning changes
only the player-event table. On ingest it runs in the same SQLite transaction
as the next authoritative projection and its derived events; startup/access
pruning first validates every stored row, then uses its own table-local
transaction. While the API is running, a deadline timer also executes this
pruning when no player request arrives; failures are reported with a stable
player-history code and retried without treating corrupt data as empty. SQLite
secure deletion is enabled and a successful event deletion is followed by a
truncating WAL checkpoint so expired display-name bytes do not remain in the
live database/WAL files. The public route still returns at most the latest 64
events and has no arbitrary history/export endpoint. The current projection is
retained independently so event expiry cannot turn an online player into a
fabricated join after an API restart. Stored state and rows are parsed
canonically and fail closed with a stable player-history error if the component
schema or data is malformed. Copies or backups made before expiry remain subject
to their own operational deletion policy; this component never scans or deletes
files outside the live control database.

If the bridge cannot obtain an authoritative collection, it publishes
`unavailable`. The API then reports the current count and current-player array
as unknown (`null`) and may show the last persisted authoritative rows
separately. It never converts an observation failure into a false zero-player
claim or invented leave events. This also applies if an unavailable snapshot
contains a different bridge session ID: the persisted authoritative session is
not closed until a subsequent `active` or `inactive` snapshot proves the new
boundary. An active snapshot marked `truncated` is not treated as a complete
roster; window omissions are not converted into leave/join events.

### Signed capability proof and exclusions

`GET /api/v1/players/capabilities` projects a fresh signed proof tied to the
pinned Nebula repository/tag/commit and observed runtime assembly identity. A
proof whose runtime identity is not verified uses
`source-contract-only-runtime-unverified`, sets `actionsEnabled=false`, and
marks notice unavailable with `NEBULA_NOTICE_RUNTIME_UNVERIFIED`. Only an exact
runtime identity match may use `runtime-assembly-identity-verified`, set
`actionsEnabled=true`, and mark `notice` available with
`UPSTREAM_TARGETED_NOTICE_PRIMITIVES_VERIFIED`. The parser cross-checks all
three fields and rejects mixed states. HMACs, bridge session IDs and local paths
are not returned. If the proof is missing, stale or invalid, every player
action remains disabled even when the last roster remains displayable.

The canonical capability order is `observe-roster`, `disconnect`, `kick`,
`ban`, `whitelist`, `blacklist`, `notice`, `permission`: exactly eight entries,
with only roster observation and, after runtime identity verification, notice
available. The remaining six mutations are always unavailable.

The bridge has no verified kick, ban, whitelist, blacklist, permission, or safe
connection-close request. Those controls stay disabled rather than being
simulated. Notice is separate from moderation: callers select exactly one of
`maintenance-5m`, `maintenance-now`, or `reconnect-required`; the Bridge owns
the corresponding text and accepts no caller-supplied message. The request is
HMAC-signed and binds the current roster session, roster sequence, opaque player
session ID, join timestamp, short expiry and idempotency key.

The notice workflow uses these Administrator-only APIs:

- `POST /api/v1/players/notice/preview` performs a dry run;
- `POST /api/v1/players/notice` requires literal `EXECUTE`, the independent
  `DYSON_PLAYER_NOTICE_MUTATIONS_ENABLED=true` gate, a fresh runtime-verified
  capability proof, and a still-matching signed roster target;
- `GET /api/v1/players/notice/receipts/:requestId` performs read-only
  reconciliation. It never creates a request or repeats dispatch.

`transport-dispatched` means only that Nebula's target connection accepted the
packet-dispatch call. Nebula v0.9.22 has no display or delivery acknowledgement,
so neither the API nor UI may label that state “delivered” or “seen”. Notice has
no rollback. If the API publishes a request but times out before reading a
signed receipt, it returns `PLAYER_NOTICE_OUTCOME_UNKNOWN` with
`mutationMayHaveOccurred=true` and `recoveryRequired=true`. The same request
must be reconciled through the GET receipt route; automatic or operator-blind
POST retry is forbidden. A reused request ID with different bound target or
template evidence fails with `PLAYER_NOTICE_IDEMPOTENCY_CONFLICT`.

`PLY-002` is repository-implemented as a fail-closed contract with only the
fixed notice primitive enabled after runtime identity verification. It is not
target-runtime verified and it does not claim general player moderation.

Viewer, Operator and Administrator all receive the same minimized public roster
because no privileged raw identity projection exists; no player export route is
defined. Notice additionally requires the Administrator-only
`players.moderate` permission. Viewer and Operator cannot preview, execute, or
reconcile it. `PLY-003` is still only `implemented` until target-host evidence
exists.

## Target-host verification still required

Before either workspace is declared verified:

1. install the exact bridge build against the pinned licensed DSP/Nebula tree;
2. prove signed player snapshots for join, disconnect, session restart,
   unavailable collection, stale file, and HMAC tamper cases;
3. prove the fail-closed runtime assembly-identity transition and verify that a
   mismatch, unreadable assembly, or stale proof keeps notice disabled;
4. dispatch every fixed notice template to a disposable target session, prove
   stale-session rejection, HMAC tamper rejection, idempotency conflict, signed
   receipt reconciliation, timeout outcome-unknown handling, and no duplicate
   dispatch; record `transport-dispatched` only, not client delivery;
5. reconnect a browser after log append, rotation, and truncation and verify no
   duplicate or skipped structured records within the documented cursor model;
6. inspect browser state and downloaded artifacts for secret, endpoint, path,
   Steam, and player-identity leakage;
7. define and test the operational retention/export policy;
8. retain private, non-sensitive evidence references without committing real
   players or production logs.
