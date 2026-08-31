# Performance qualification

Dyson Control treats `60 UPS` as the normal server target. Raising the target
does not create free simulation capacity: it asks the game to simulate more
updates per wall-clock second, which can reduce headroom and make late-game
slowdown appear sooner. The control plane therefore records the configured
target and the measured UPS separately and never claims that a larger number is
automatically better.

## Fixed telemetry profile

`late-game-6h-v1` evaluates the retained, already-redacted server telemetry. It
requires at least 360 samples spanning at least six hours and reports
`insufficient` until all mandatory telemetry has at least 95% coverage.
The production defaults sample every 15 seconds and retain 2,048 samples,
covering a little over eight and a half hours; the bounded capacity can be set
from 360 through 4,096 with `DYSON_OBSERVABILITY_HISTORY_CAPACITY`.

The fixed checks are:

| Check | Requirement |
| --- | --- |
| Managed runtime | running in at least 99% of retained samples |
| Critical health | no more than 1% of samples |
| Simulation | at least 95% of observed running samples at 55 UPS or higher |
| Host CPU | 95th percentile no higher than 90% |
| Hottest logical core | at or above 97% in no more than 10% of samples |
| Single-core bottleneck signature | hottest core at least 97%, host below 75%, and DSP below 1.5 used cores in no more than 5% of eligible samples |
| Host memory | peak used percentage no higher than 90% |
| Project and save volumes | peak used percentage no higher than 90%, with at least 10 GiB free |

The read-only report is available to every authenticated role at:

```text
GET /api/v1/observability/qualification
```

The browser and API must label the result as telemetry qualification, not as a
production sign-off. Even a passing report retains four explicit outstanding
evidence codes: save-latency drill, reboot recovery, crash recovery, and an
external-client join/soak.

## Durable alert episodes

Health hints are reduced into durable alert episodes rather than being shown as
stateless banners. The first observation opens one episode per fixed hint code;
repeated samples update its last-seen time and observation count, while severity
changes retain a bounded transition history. A disappeared hint resolves only
after three consecutive complete, healthy observations by default. Unknown or
incomplete telemetry, or an unavailable metric required by that alert, never
counts as recovery evidence. A recurrence after resolution receives a new
episode ID.

The reducer state is stored in a strict singleton SQLite record using a
compare-and-swap revision. A write whose result is uncertain leaves the running
instance recovery-required and blocks later changes until restart reloads the
authoritative state. Exact duplicate snapshots and same-actor acknowledgement
retries are idempotent. Only resolved episodes may be pruned; open episodes are
never evicted merely to satisfy the configured soft capacity.

```text
GET  /api/v1/observability/alerts
POST /api/v1/observability/alerts/:episodeId/acknowledge
```

Reads require `observability.read`. Acknowledgement requires the separate
Operator-or-Administrator `observability.acknowledge` permission, same-origin
protection and the literal `ACKNOWLEDGE_ALERT`; the server supplies the actor and
timestamp. The public projection contains no raw metric, source, hint message,
path, log, endpoint or internal digest. Capacity and recovery debounce are
bounded by `DYSON_OBSERVABILITY_ALERT_CAPACITY` (default 256) and
`DYSON_OBSERVABILITY_ALERT_RESOLVE_AFTER_MISSING_SAMPLES` (default 3).

## Multi-core expectations

Windows CPU affinity, priority, and VM vCPU allocation can prevent artificial
constraints, but they cannot turn a game subsystem that is internally serial
into a parallel workload. Dyson Control therefore does not promise to “force”
all cores busy. It measures both aggregate CPU use and the hottest logical core,
plus the process's effective core use, and detects the persistent pattern where
one core is saturated while aggregate capacity remains idle.

If that pattern fails qualification, the response is to profile the actual
late-game save and reduce the limiting simulation work or use a faster CPU
core. Assigning more vCPUs alone is not accepted as a fix unless a new soak
window demonstrates improved UPS and removes the bottleneck signature.

## Evidence procedure

1. Load a representative late-game paired `.dsv` and `.server` save in the
   disposable or side-by-side environment.
2. Confirm the configured target remains 60 UPS and telemetry collection is
   enabled at a cadence that can retain the full six-hour window.
3. Run normal multiplayer activity; do not manufacture a pass by pausing the
   simulation or removing the workload.
4. Preserve the qualification report with the exact release, VM allocation,
   game/mod lock, and save revision in private production evidence.
5. Run the separate timed save, reboot, crash recovery, and external join
   drills. Only the complete evidence set may promote `SRV-004` to `verified`.

No real save, player identifier, production endpoint, host path, or credential
belongs in the public repository evidence.
