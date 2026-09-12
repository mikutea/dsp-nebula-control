# Soak observation v2

`DYSON_SOAK_OBSERVATION_V2` is a strict, read-only evidence format for the
future `PRD-005` sustained-operation qualification. It supports exactly two
kinds:

- `six-hour`: at least 21,600 real monotonic seconds and 1,441 retained
  samples;
- `seventy-two-hour`: at least 259,200 real monotonic seconds and 17,281
  retained samples.

Adding, generating, or validating this format does not start a server, wait for
a soak window, contact a network, or promote `PRD-005` beyond `not-started`.
The wrapper result always reports `networkTouched=false` and
`productionChanged=false`.

## Real-time and compact telemetry proof

The observation accepts only an independent `real-monotonic` host counter. Its
clock must be `real-elapsed`, continuous, not virtual, and not bounded. UTC and
monotonic duration must agree within five seconds. One second below the selected
kind's floor fails.

Raw samples remain private. Their ordered chunk digests are represented by
small segment summaries. Every segment binds:

- contiguous first and last sample sequence numbers and an exact count;
- first and last monotonic ticks;
- an asserted maximum gap no greater than 30 seconds;
- a digest of the corresponding private raw payload;
- the prior segment digest and the common subject binding.

The validator reconstructs every segment digest and the ordered segments root,
requires the first sample to match the window start, the last sample to match
the window end, sums the segment counts, verifies cross-segment gaps, and checks
that accumulated ticks exactly equal elapsed seconds times counter frequency.
A six-hour fictional fixture therefore needs only six summaries and a
seventy-two-hour fixture only 72 summaries; it never sleeps or fast-forwards a
clock while claiming production evidence.

## Bound qualification evidence

Every group is bound to the same kind, run, target, release version,
40-character commit, runtime payload, release manifest, workload profile,
representative paired save, and world identity. The validator additionally
accepts independent `Expected*` values for all of those immutable identities.

A qualifying document must also contain:

- the fixed `late-game-6h-v1` representative workload, target 60 UPS, normal
  multiplayer activity, no simulation pause, and no reduced workload;
- an intact representative late-game `.dsv` / `.server` pair;
- UPS, CPU, memory, project/save disk, game process, control plane, and Bridge
  health summaries that meet the documented coverage and performance limits;
- a public-external, server-authoritative Nebula initial join near the start and
  reconnect near the end, with a privacy-preserving one-run client pseudonym;
- acknowledged saves at gaps no greater than ten minutes, with a stable world
  and paired-save identity throughout the window;
- zero crashes, recovery-required events, data loss, workload interruption,
  clock anomalies, unexpected component restarts, critical alerts, and
  unresolved alerts.

The schema has no generic `status` field. Virtual or bounded clocks, too little
elapsed time, one missing sample, a gap above 30 seconds, LAN/HTTP/TCP-only
reachability, cross-run/release/save splicing, health or alert failures, and
semantic tampering followed by digest recomputation all fail closed. The
top-level observation also expires no more than one hour after completion.

## Create and validate

Create a canonical file without overwriting an existing observation:

```powershell
powershell.exe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass `
  -File scripts/windows/qualification/New-DysonSoakObservationV2.ps1 `
  -InputPath D:\Fictional\DysonControl\soak-input.json `
  -OutputPath D:\Fictional\DysonControl\soak-observation.json
```

Validate it read-only while pinning the approved subject:

```powershell
powershell.exe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass `
  -File scripts/windows/qualification/Test-DysonSoakObservationV2.ps1 `
  -ObservationPath D:\Fictional\DysonControl\soak-observation.json `
  -ExpectedKind six-hour `
  -ExpectedRunId 72000000-0000-0000-0000-000000000001 `
  -ExpectedTargetIdentity fixture-dyson-vm `
  -ExpectedReleaseVersion 0.1.0-rc.1 `
  -ExpectedSubjectCommit aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa `
  -ExpectedRuntimePayloadSha256 sha256:1111111111111111111111111111111111111111111111111111111111111111 `
  -ExpectedReleaseManifestSha256 sha256:2222222222222222222222222222222222222222222222222222222222222222 `
  -ExpectedWorkloadProfileSha256 sha256:3333333333333333333333333333333333333333333333333333333333333333 `
  -ExpectedSavePairSha256 sha256:7777777777777777777777777777777777777777777777777777777777777777
```

Run the deterministic, fictional positive and tamper matrix under a
workspace-scoped temporary root:

```powershell
powershell.exe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass `
  -File scripts/windows/qualification/SelfTest-DysonSoakObservationV2.ps1 `
  -TestRoot D:\Fictional\DysonControl\Temp
```

`dyson-soak-observation-v2.schema.json` describes the emitted document. The
PowerShell validator remains authoritative for digest reconstruction,
cross-field equality, clock arithmetic, ordering, coverage, gap, expiry, and
independent expected bindings. Repository self-tests are implementation
evidence only; production qualification still requires the private raw samples
and receipts from a genuinely elapsed approved window.
