# Qualification Shadow fixture

This directory contains a Windows PowerShell 5.1-only, temporary-root fixture for
the production qualification action protocol. It never qualifies as production
evidence and does not contact a service, scheduler, game process, network endpoint,
or save location.

Run the complete isolated test with Windows PowerShell 5.1:

```powershell
powershell.exe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File .\scripts\windows\qualification\Invoke-QualificationSelfTest.ps1
```

The self-test creates a uniquely named directory below the operating-system
temporary directory, writes the exact `DYSON_QUALIFICATION_SHADOW_ROOT_V1`
marker, and removes only that verified directory. The success result is one
public-safe JSON object with the fixed test matrix and explicit false values for
production scheduler, service-control, network, save, and filesystem mutation.

## Execution boundary

`Qualification.Executor.ps1` exposes:

```powershell
Invoke-DysonQualificationAction -Request $request -Backend Contract
Invoke-DysonQualificationAction -Request $request -Backend Shadow -ShadowRoot $temporaryFixtureRoot
```

`preview` validates the fixed request and returns the allowlisted adapter
contract without writing anything. `execute` is disabled unless all gates pass:

- the process environment contains exactly
  `DYSON_QUALIFICATION_EXECUTE=SHADOW_FIXTURE_ONLY_V1`;
- the request ID is a canonical lowercase `D` UUID;
- the action-bound confirmation phrase exactly matches the preview;
- the request, protection point, and marked fixture target identities match;
- the current virtual time is inside a bounded maintenance window of at most
  four hours; and
- the paired-save protection point is untampered, unexpired, and no more than
  30 minutes old.

In protocol v1, only `Backend Shadow` has an executable implementation. `Backend Contract`
always returns `unsupported` for an execute request, even when every gate would
otherwise pass. It contains adapter IDs and bounded rollback contracts but no
commands. This v1 fixture cannot enable production. Protocol v2 separately
provides four fixed, default-off production-capable adapters, but no v1 request,
environment value, receipt, or `SHADOW` phrase can authorize them; see
`README.production-v2.md`.

The allowlist is `windows-restart`, `control-plane-restart`,
`dsp-crash-recovery`, `storage-interruption`, `disk-pressure`,
`update-rollback`, `gsmanager-switch`, and `save-restore`. Storage interruption
is limited to 300 virtual seconds. Disk pressure is limited to 85 percent and
300 virtual seconds.

## Crash, replay, and soak semantics

Every Shadow execute writes a request-bound checkpoint before applying its
fixture transition. The hard-exit test launches a separate Windows PowerShell
5.1 process and terminates it with exit code 93 after that checkpoint, leaving
no receipt. A subsequent call must use `-Resume`; an ordinary replay is rejected.
Once a receipt exists, the same request is idempotent and a different payload
using the same UUID is rejected.

A failed rollback latches `manualRecoveryRequired`. All new or resumable
dangerous requests then fail closed until an out-of-band recovery workflow has
resolved the condition; only replay of the already terminal immutable receipt
remains available. The Shadow soak cannot clear this latch.

The six-hour soak advances an explicit virtual clock through 24 samples. Its
result always states `virtualClock: true`, `realElapsedSeconds: 0`, and
`qualifyingProductionEvidence: false`. It tests orchestration only and must not
be used to satisfy an actual six-hour production duration gate.
