# Configuration management

Dyson Control exposes a typed, allowlisted view of four BepInEx-style
configuration files. It does not expose a generic editor, a caller-selected
path, or the original value of a secret. The repository includes inspection,
redacted preview, confirmed apply, byte-preserving snapshots, post-write
verification, and automatic compensation after a partial commit failure.

This is repository implementation evidence. It has not yet been exercised
against the target Windows VM, and applying a configuration does not restart
DSP/Nebula. Do not point or use the apply workflow against production until the
target-host tests and lifecycle gates in
[`acceptance/manifest.json`](../acceptance/manifest.json) have passed.

## Managed files

The trusted server-side configuration root is derived from
`DYSON_PROJECT_ROOT`; an HTTP request cannot replace it. The current file set
is fixed:

| File ID | Relative file | Managed scope |
| --- | --- | --- |
| `nebula` | `nebula.cfg` | Nebula host, synchronization, privacy, and password settings |
| `galaxy` | `nebulaGameDescSettings.cfg` | New-game galaxy and combat settings |
| `bepinex` | `BepInEx.cfg` | BepInEx console logging switch |
| `bridge` | `io.github.mikutea.dyson-control-bridge.cfg` | Dyson Control bridge enablement and bounded timing values |

The parser preserves comments, unrelated sections, unrelated keys, newline
style, and existing file bytes outside the planned assignments. Missing
allowlisted keys are added through the same parser. Redirected files,
redirected directories, oversized files, duplicate request fields, unknown
setting IDs, and values outside the fixed schema fail closed.

## Upstream Nebula contract

The field names and sections are derived from Nebula's source contract, not
from a locally invented format:

- [`NebulaModel/Config.cs`](https://github.com/NebulaModTeam/nebula/blob/master/NebulaModel/Config.cs)
  defines the `Nebula - Settings` entries read by the multiplayer mod.
- [`NebulaModel/GameDescSettings.cs`](https://github.com/NebulaModTeam/nebula/blob/master/NebulaModel/GameDescSettings.cs)
  defines the game-description file, its sections, and the serialized keys.
- [`NebulaModel/MultiplayerOptions.cs`](https://github.com/NebulaModTeam/nebula/blob/master/NebulaModel/MultiplayerOptions.cs)
  defines the corresponding multiplayer option properties and defaults.
- Nebula's [headless-server setup](https://github.com/NebulaModTeam/nebula/wiki/Setup-Headless-Server)
  documents how these settings are used by a dedicated host.

The repository's numeric limits and enumerated choices are a Dyson Control
policy boundary. They should not be interpreted as a promise that every
upstream Nebula or DSP version supports the same range. A Nebula upgrade must
revalidate this catalog before activation.

## Current field groups

The typed catalog currently includes:

- Nebula auto-pause, game password, remote-access enable/password, host port,
  UPnP/PMP, Ngrok, UPS synchronization, shared soil, and streamer mode;
- galaxy seed, 32-64 stars, resource multiplier, peace/sandbox mode, and the
  listed Dark Fog parameters;
- the BepInEx console-output switch;
- bridge enablement, polling interval, save stability window, save timeout, and
  save cooldown.

`server-password` and `remote-access-password` are write-only in the browser.
Inspection and diff results return only `{ "configured": true|false }`. A
changed non-empty secret can therefore have `changed: true` while both the
before and after display values say only `configured: true`.

The catalog is not yet a complete mod-configuration or arbitrary plugin
configuration system. Unknown plugin keys remain untouched and cannot be
written through the API.

## API workflow

All routes require an authenticated same-origin session.

1. `GET /api/v1/configuration` returns the typed snapshot, a SHA-256 revision,
   field provenance (`file`, `default`, or `invalid`), and invalid setting IDs.
2. `POST /api/v1/configuration/preview` accepts the current
   `expectedRevision` plus 1-32 typed changes. It returns a redacted dry-run
   diff and whether a server restart or a new game is required.
3. The operator reviews that exact diff in the UI.
4. `POST /api/v1/configuration/apply` requires the same revision, the same
   changes, and the literal confirmation `APPLY_CONFIG`.
5. A successful response returns only transaction metadata, changed setting
   IDs, restart/new-game flags, and an opaque snapshot ID.

Example preview using fictional values:

```json
{
  "expectedRevision": "0000000000000000000000000000000000000000000000000000000000000000",
  "changes": [
    { "id": "nebula.host-port", "value": 8469 },
    { "id": "galaxy.resource-multiplier", "value": 8 }
  ]
}
```

The all-zero revision is illustrative only; a real request must use the
revision returned by the immediately preceding inspection. A stale revision
returns HTTP 409 without writing a file.

## Transaction and rollback boundary

Apply holds an exclusive configuration lock, rereads all four files, and
revalidates both the revision and the planner's exact allowlisted output while
holding the lock. It then:

1. stores a byte-for-byte snapshot and verifies its manifest;
2. writes a durable redacted `prepared` audit record;
3. stages only changed files beside their final locations;
4. atomically replaces each changed file;
5. rereads every managed file and verifies the planned aggregate revision;
6. emits the terminal redacted audit record.

If a failure occurs after the first replacement, the service restores every
original byte and reports `rolled-back`. If that compensation also fails, it
reports `rollback-failed` rather than claiming success. Snapshot contents,
hashes, configuration paths, and secret values are not returned by the API.

## Snapshot history and explicit restore

The separate configuration-history transaction keeps bounded, byte-preserving
snapshots under the fixed configuration root and exposes only redacted metadata:

- `GET /api/v1/game-config/history`;
- `GET /api/v1/game-config/history/:snapshotId`;
- `GET /api/v1/game-config/history/:snapshotId/diff`;
- `GET /api/v1/game-config/history/:snapshotId/restore-preview`;
- `POST /api/v1/game-config/history/capture`;
- `POST /api/v1/game-config/history/restore`;
- `POST /api/v1/game-config/history/reconcile`.

Viewer, Operator, and Administrator roles may inspect the bounded history and
redacted diff. Capture, restore, and reconciliation require Administrator,
the exact operation confirmation, and the independently disabled
`DYSON_CONFIG_HISTORY_MUTATIONS_ENABLED` gate. Restore additionally requires
the immediately preceding current revision. Neither a filesystem path nor a
stop-proof token is accepted from the browser.

Before publishing any restored file, the server obtains its own short-lived
proof that the managed DSP process is stopped and port 8469 is closed. The core
creates a pre-restore protection snapshot, journals each step durably, verifies
the final aggregate revision, automatically rolls back a partial publication,
and reconciles an interrupted journal after restart. Request UUIDs are durable
idempotency keys. History contents, raw secrets, fixed paths, and internal
stop-proof tokens never appear in the HTTP response.

The history core, HTTP controller, Fastify routes, fixed Windows stop-proof
authorizer, and application assembly are implemented. Repository tests use
temporary fictional files and injected runners; the application wiring test
also proves that the Windows stack is assembled while mutation remains disabled
by default. None of that is a controlled run on the target Windows VM. A real
stop proof, capture/restore/reconciliation cycle, Nebula acceptance check,
process restart, Windows reboot, and failure rollback still require target-host
evidence. Configuration apply also remains a separate transaction from game
save/restart. Those gaps keep `CFG-001` and `CFG-002` at `implemented`, not
`verified`.

## Activation semantics

- `server-restart` means the new value is written but is not assumed active
  until a separately verified DSP/Nebula restart.
- `new-game-only` means the value affects a subsequently created galaxy; it
  does not rewrite the current save.

A successful configuration transaction proves the managed files match the
plan. It does not prove that Nebula accepted the values, that the current game
changed, or that the server restarted safely.

## Verification still required

Before production enablement, test on a disposable Windows/Nebula installation:

1. read and preview all supported fields from the exact pinned Nebula build;
2. confirm secret values never appear in API responses, browser state, audit
   records, or exported diagnostics;
3. inject a partial multi-file failure and independently verify automatic
   byte-for-byte restoration;
4. verify configuration behavior across process restart and Windows reboot;
5. prove new-game-only settings affect only a newly created fictional save;
6. exercise snapshot capture, redacted diff, dry-run restore, real restore,
   idempotent replay, partial-write rollback, and interrupted-journal recovery;
7. record target-host evidence before changing `CFG-001` or `CFG-002` to
   `verified`.
