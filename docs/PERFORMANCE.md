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

## Persistent 72-hour continuity window

The six-hour raw history remains the authoritative input for the detailed
late-game performance profile. In parallel, every accepted raw snapshot now
produces a path-free, size-bounded continuity sample in the same SQLite
transaction. The default long-window capacity is 20,000 samples. At the fixed
15-second cadence, a complete 72-hour interval contains exactly 17,281 samples;
the default therefore retains about 83 hours while leaving deterministic room
for delayed collection and restart recovery.

Each slim sample carries the managed runtime identity and state, game-port
listener state, the bounded performance summary, project-root availability,
the declared storage dependency, SMB global-mapping and recovery-task state
when applicable, and the evaluated health status. It contains no host path,
save name, player value, endpoint, credential, or raw provider response. Samples
form a SHA-256 predecessor chain. Startup re-parses the retained chain and fails
closed on malformed, reordered, duplicated, spliced, or digest-mismatched data;
retention always removes the oldest complete records.

The `dyson-observability-72h-continuity-report` requires at least 17,281 samples,
at least 72 hours of monotonic wall-clock span, no gap above 30 seconds, one
stable source and runtime identity, a continuously running process and game
listener, and an explicitly classified storage dependency. The project root
must remain available in every sample. For `smb-global-mapping`, the mapping
must remain available and the recovery task must report `ready` or `running`
with result `0`; `none` marks those two SMB checks not applicable, while
`unknown` can never qualify. This report proves continuity only and does not
replace the detailed six-hour UPS/CPU/memory qualification or the production
fault and external-client drills.

## Trusted save and backup latency

Latency is derived only from lifecycle receipts and save-job records already
accepted by the control database. A successful save uses its server-written
phase start and finish times. A successful backup additionally requires the
bound backup job and run to agree, a committed result with audit storage, and
no cleanup, maintenance, or recovery flag. Failed and incomplete operations are
counted explicitly but receive no duration and therefore cannot improve P50,
P95, or maximum latency. There is intentionally no request-body parser that
accepts a client-supplied latency value. The derivation and summary interface is
projected through the authenticated read-only qualification route together with
the 72-hour continuity report. The API and Web UI keep missing values as
`unknown`/`null`, never substitute `0 ms`, and always label these statistics as
`NOT QUALIFIED`; they do not constitute completed production drill evidence.

Measured simulation UPS/TPS comes from the public Bridge sampler, not from the
configured `-Ups` target. The sampler publishes a bounded HMAC-authenticated
record. The Windows reader accepts it only when its runtime-session ID, DSP
process ID and start time, Bridge start generation, monotonic sequence, sample
window, timestamp freshness, and signature all agree with the independently
validated runtime identity. It returns only the bounded measurement and public
binding metadata; the shared secret, raw file contents, paths, and signature do
not enter provider or API output. Tamper, replay, stale data, a prior process,
or a prior Bridge generation fails closed instead of falling back to the target
UPS value.

The release artifact contains the public C# sampler and the two runtime
PowerShell reader/wrapper files. Their adversarial PowerShell 5.1 Shadow
self-test remains repository-only and is run against the packaged runtime
files during release-artifact validation. This is implementation evidence, not
evidence that a production DSP/Nebula process emitted valid telemetry.

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

## Qualification-harness boundary

The repository-only [production qualification runbook](PRODUCTION-QUALIFICATION.md)
binds this telemetry profile to the fixed `six-hour-soak` step and to the other
reboot, crash, storage, update, restore, and external-client steps required by
`PRD-005`. Its Windows PowerShell 5.1 Shadow self-test advances a marked
temporary fixture by exactly six virtual hours to verify timer, checkpoint, and
resume logic. The result is explicitly `shadow-virtual` and cannot satisfy a
production soak.

Run `npm run qualification:selftest` only as repository validation. A qualifying
soak still needs at least six real monotonic hours, the representative workload,
complete genuine telemetry, exact release/runtime/save bindings, and private
evidence linked into the final acceptance gate. The v1 harness has no production
adapter and does not authorize a real fault or host mutation.

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
