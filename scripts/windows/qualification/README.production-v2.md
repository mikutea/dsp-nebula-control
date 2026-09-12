# Fixed production qualification adapters v2

Protocol v2 is the minimal production-capable framework for four bounded
qualification actions. A separate receipt-only orchestration v2 adapter now
ingests protected results from the existing restore, reboot, update,
deployment, cutover/removal, soak, panel, network, and external-client
transactions without reimplementing or invoking those transactions. Both are
deliberately separate from protocol v1. V1
remains Shadow-only forever; its environment values, confirmation phrase,
requests, receipts, and checkpoints are invalid under v2.

This repository delivery is implementation evidence, not production evidence.
The production backend has not been invoked while building or testing it, and
all acceptance requirements remain `not-started` until an independently
authorized target-host run produces verified private evidence.

## Public files and private profile

- `Qualification.ProtocolV2.ps1` defines strict schemas, canonical hashing,
  profile/request/protection-point validation, and confirmation vocabulary.
- `Qualification.ExecutorV2.ps1` provides read-only preview, exclusive durable
  execution, same-directory atomic publication of create-new intents and
  receipts, full receipt/intent-chain replay validation, inspection-only resume,
  compensation, and recovery-required latches.
- `Qualification.ProductionAdaptersV2.ps1` defines the four fixed Windows
  adapters. Loading it defines functions only.
- `Qualification.FakeV2.ps1` and `Invoke-QualificationV2SelfTest.ps1` exercise
  the same protocol entirely inside a uniquely marked temporary fixture.
- `Qualification.OrchestrationV2.ps1` and
  `Invoke-QualificationOrchestrationV2.ps1` provide the default-off,
  receipt-only orchestration adapter. Its public bounds are frozen in
  `fixtures/orchestration-adapter-contract.v2.json`; its private profile,
  request, and protected evidence documents have strict v2 schemas. The
  adapter writes only its own qualification intent/receipt chain and never
  starts, stops, restores, deploys, switches, removes, reboots, or changes a
  route.
- `qualification-production-profile.v2.schema.json` is the public shape of the
  private production profile. `qualification-action-request.v2.schema.json`
  publishes the strict request/protection-point shape.
  `fixtures/adapter-contract.v2.json` records the public adapter bounds.

Do not commit a populated production profile. Its paths, scheduled-task
identities and exported-definition SHA-256 values, share identity, and host
binding belong in the private evidence store. The
profile is an exact-property JSON document, expires within 31 days, defaults to
`enabled: false`, and is bound by SHA-256 into every request, intent, and
receipt. The runtime host identity is the SHA-256 of the normalized Windows
MachineGuid with the v2 domain-separation prefix; the raw MachineGuid must not
be emitted or stored in public evidence.

The state root must be an existing regular local directory. Production
operation also requires a fresh target-matched protection point, a canonical
request UUID, an unexpired maintenance window, an enabled exact action, and the
versioned process environment gate. Before an intent is written, the production
executor additionally requires an ACL-controlled private evidence record at
`<stateRoot>\qualification-v2\private-protection-points\<protectionPointId>.evidence.json`.
The evidence directory DACL must have inheritance disabled, contain no inherited
ACE, and be owned by the current executor identity, `SYSTEM`, or the local
Administrators group. Only those same principals may hold an allow ACE with
write, delete, permission-change, or ownership rights; any other writable SID
fails closed.
That self-digested record binds the exact profile digest, request digest,
approval, target, action, preview, and public protection point. It also names an
existing same-basename `.dsv`/`.server` pair and independent evidence file inside
protected roots; observed SHA-256 values must reproduce the public pair and
evidence digests. The fixture constructor exists only in
`Qualification.FakeV2.ps1`. No one condition is sufficient by itself.

## Preview and exact confirmation

Preview performs validation and returns the immutable preview SHA-256 without
creating the v2 state store or invoking an adapter. Production preview also
reports whether the private profile matches the current Windows host.

An execute confirmation has this exact shape:

```text
EXECUTE DYSON QUALIFICATION PRODUCTION V2 <UPPERCASE-ACTION> <profile-uuid> <request-uuid> <preview-sha256>
```

The full preview digest is part of the phrase. Changing parameters, target,
profile, maintenance window, protection point, or receipt predecessor changes
that digest and invalidates the confirmation. Fake execution uses the distinct
word `FAKE`; it cannot be replayed as production authority.

`New-DysonQualificationV2Request` does not synthesize an execute confirmation.
The operator first reviews the preview result and supplies its displayed phrase
explicitly to `ConvertTo-DysonQualificationV2ExecuteRequest`. That conversion
accepts only the unchanged preview request and the exact full phrase. Constructing
an execute-shaped request with an empty or generated-by-caller placeholder does
not pass the executor gate.

Execution is default-off even when a profile is present. Production requires
all protocol gates plus the exact v2 production environment value. Fake tests
use a different environment name and value and are additionally confined to a
marked `dyson-qualification-v2-selftest-*` directory under the system temporary
root. Neither environment value is a substitute for fresh operator approval.

## Fixed adapters

| Action | Exact target and mutation | Bound and compensation |
| --- | --- | --- |
| `control-plane-restart` | Immediately before capture and again immediately before `Stop-Process`, the configured PID file must equal the request's `expectedPid`. That PID must resolve to the exact executable path, file SHA-256, and command-line SHA-256, so another `node.exe` instance is not interchangeable. Only the captured object is stopped; then the exact digest-bound scheduled task is started. | 30–900 second deadline. Success requires a self-digested readiness JSON receipt bound to target ID, request, new PID/start UTC, executable/command-line/release/runtime digests, receipt sequence, and intent digest. Mtime or unrelated text is never readiness. |
| `dsp-crash-recovery` | The same double-read PID-file, PID/path/file/command-line, and task-definition binding applies to the distinct DSP target. There is no image-name or all-process operation. | 30–900 second deadline, a new exact PID plus the same content-bound readiness receipt, inspection-only resume, and no-duplicate compensation. |
| `storage-interruption` | Only one exact SMB global mapping whose local and remote paths both match the profile may be removed. No network adapter, filesystem root, wildcard share, or other volume is accepted. Provider/CIM/query failure is an observation failure, never “mapping absent.” | The approved maximum is 10–300 seconds and reserves at least five seconds for automatic restoration. Query failure during inspect, poll, or compensation cannot report success; an initial query failure cannot start the restore task. |
| `disk-pressure` | Only `pressure-<request-uuid>.bin` inside an existing, non-reparse, non-compressed, otherwise-empty directory bearing the exact disposable marker may be created. | Allocation is 1 MiB–64 GiB in freshly randomized chunks, hold is at most 300 seconds, used space may never exceed the profile ceiling (hard maximum 85%), and free space may never fall below the profile floor (hard minimum 10 GiB). Capacity is checked before and during allocation. `finally` and compensation delete only the exact request file and re-inspect the empty marked directory. |

The disk directory must be on the exact profiled volume and may neither contain
nor be contained by a state, system, application, data, save, backup, recovery,
or evidence root. The production adapter has no recursive delete primitive.

## Protected orchestration receipts

The separate orchestration adapter has a closed 11-action allowlist:
`paired-save-restore`, `windows-reboot-recovery`, `update-rollback`,
`side-by-side-deployment`, `gsmanager-recoverable-switch`,
`gsmanager-removal`, `six-hour-soak`, `seventy-two-hour-soak`,
`authenticated-panel`, `game-protocol-path`, and `external-client-e2e`.
It consumes evidence; it is not another mutation engine. The fixed contract
names every adapter, verifier, independent HMAC key, artifact role/protocol,
complete check set, freshness/duration/sample bound, and mandatory protection
or rollback receipt. A caller-supplied `verified` or `qualified` Boolean does
not exist.

Each protected envelope binds the request, approval, run, profile, action
target, target identity, subject commit, runtime payload, verifier, nonce,
observation window, and source artifacts. The subject-binding digest is
recomputed from those canonical identities. JSON duplicate keys are rejected
before PowerShell conversion, including Unicode-escaped aliases. The adapter opens each plain,
non-reparse source below the exact private root, hashes the bytes actually
parsed, and rejects path escape, duplicate artifacts, protocol/hash drift,
staleness, missing or extra checks, rollback mismatch, and evidence/nonce
replay. Controlled observations must carry the exact action target and cannot
relabel an old completion as a fresh envelope. External-client artifacts are
additionally passed through the existing v1 11-event dual-challenge transcript
verifier and must form one run with ten `observed` events and one terminal
`passed` event. Six-hour and 72-hour evidence requires at least 21,600 and
259,200 `real-monotonic` seconds, 1,441 and 17,281 inclusive 15-second samples,
respectively, and no sample gap above 30 seconds. Virtual time never qualifies
either receipt.

Preview and PowerShell `-WhatIf` perform all evidence checks without creating
state. Consume is
default-off at profile, action, and process-environment layers and requires the
full digest-bound confirmation. Production roots and the key-ring directory
must be protected fixed local storage. A consume request is current for at most
15 minutes. The adapter atomically writes its own validated intent before its
redacted receipt. An interrupted intent requires explicit `-Resume`, which
revalidates the same evidence and cannot replay a lower transaction. Exact
replay returns the immutable receipt; changed UUID content, reused evidence,
broken predecessor, or another orphan intent fails closed. Receipt output has
no path, host/network/player/save detail, log, or secret and always reports
`productionChanged: false`.

## Durable intent, replay, and recovery

Execute takes an exclusive lock beneath `<stateRoot>\qualification-v2`. Before
the adapter runs, it publishes a create-new, digested intent containing the
request digest, exact action target, sequence, predecessor receipt digest, and
deadline. Publication writes a unique temporary file in the final directory,
completes `Flush(true)`, closes the handle, then performs a same-volume move
whose destination must not exist. Receipts use the same protocol. An orphan
temporary file is an explicit fail-closed recovery condition.

Before any immutable replay, the executor verifies every receipt from sequence
1, every predecessor, every corresponding self-valid intent, and all request,
profile, action, target, sequence, predecessor, and intent-digest relationships.
Missing intents, orphan receipts, or a broken predecessor fail closed. Only an
identical fully validated request returns the old receipt; changed content is a
UUID collision.

While holding the execution lock, the executor also enumerates the complete
intent directory and reconciles it with the validated receipt chain. There may
be at most one intent without a receipt, it must belong to the current request,
and that request must use explicit `-Resume`. A different or additional orphan
intent blocks the request with manual recovery required before any adapter can
run or a new intent can be created.

An intent without a receipt always requires explicit `-Resume`. Resume inspects
the exact target and never replays the original mutation. It records a verified
completed or safe terminal state, or runs bounded compensation. A failed or
uncertain compensation writes `recovery-required`, which blocks every new
action while still allowing immutable receipt replay for audit. Manual recovery
and new authorization are then required. The identical persisted request may be
resumed for up to 31 days even after its original request, maintenance window,
protection point, or action deadline expires. This exception authorizes only
inspection and compensation; it cannot replay the original action. An expired
action deadline receives a new compensation window capped at 300 seconds.

## Repository validation

Run the existing qualification self-test; it invokes the v1 Shadow matrix, the
v2 fake matrix, and the orchestration v2 protected-receipt matrix in child
scope:

```powershell
powershell.exe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass `
  -File .\scripts\windows\qualification\Invoke-QualificationSelfTest.ps1
```

The v2 matrix covers preview immutability, both default-off gates, exact
confirmation/preview binding, strict request shapes and numeric bounds,
double-read PID-file isolation, command-line identity, content-bound readiness,
SMB query failures across observation/poll/compensation, request-bound private
evidence, protected ACL inheritance, unapproved writer SIDs, exact disk cleanup,
global orphan-intent exclusion, and full intent/receipt-chain replay validation.
It injects and recovers from before-write, mid-write, after-flush-before-rename,
and after-rename failures for both intent and receipt publication. It also tests
hard-exit resume without replay, timeout/failed compensation, the recovery latch,
broad-target rejection, no arbitrary command surface, and unchanged unrelated
process/volume/network/save counters. It never invokes the production backend.
The combined test also runs the orchestration v2 fixture matrix across all 11
receipt adapters. That matrix covers exact schemas/contracts, duplicate JSON-key
rejection, preview/`-WhatIf` zero-write, default-off consume, actual source-byte rehash,
HMAC/subject-binding tamper, check-set and soak bounds, failed-event external
transcript revalidation, collision/idempotence, and explicit
hard-exit intent resume, while asserting every production side-effect flag false.

Still unproved until a separately authorized real-host run: scheduled-task ACLs
and runtime behavior beyond the enforced XML digest, exact installed executable
hashes and readiness behavior,
real SMB restore timing, real disk and workload behavior, paired-save integrity,
external client reconnect, update rollback, save restore, reboot recovery,
authority switch/removal, and real six-hour/72-hour monotonic soaks. The four
mutation adapters and 11 receipt adapters are implementation coverage only;
neither silently stands in for target-host evidence.
