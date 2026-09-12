# Production qualification protocol v1

This directory defines the fail-closed protocol and in-memory state machine used
to coordinate private production qualification. Loading either script performs
no host, network, service, scheduler, save, or production write. The scripts are
compatible with Windows PowerShell 5.1.

## Fixed identities

- Qualification protocol: `DYSON_PRODUCTION_QUALIFICATION_V1`
- Plan: `dyson-production-qualification-v1`
- Plan file: `qualification-plan.v1.json`
- Public projection: `DYSON_PRODUCTION_QUALIFICATION_PUBLIC_V1`
- Shadow executor action request: `DYSON_QUALIFICATION_ACTION_REQUEST_V1`
- Execution switch: `DYSON_QUALIFICATION_EXECUTE_ENABLED`
- Required execute value: `ALLOW_BOUNDED_PRODUCTION_QUALIFICATION_V1`

The plan maps all nine current production-only acceptance items: `SAV-005`,
`PRD-001` through `PRD-005`, and `CUT-001` through `CUT-003`. Its thirteen
steps separate the combined reboot/fault/soak criterion into bounded drills.

## Loading and exported functions

Dot-source `Qualification.Protocol.ps1`, or dot-source
`Qualification.Plan.ps1` to load both layers. Important public functions are:

- `Get-DysonQualificationProtocolInfo`
- `Test-DysonQualificationUuid`
- `ConvertTo-DysonQualificationCanonicalJson`
- `Get-DysonQualificationSha256`
- `Test-DysonQualificationPublicValue`
- `New-DysonQualificationReceipt`
- `Assert-DysonQualificationReceipt`
- `Test-DysonQualificationReceiptChain`
- `Add-DysonQualificationReceipt`
- `Assert-DysonExternalClientReceiptSequence`
- `Test-DysonExternalClientTranscript`
- `Test-DysonQualificationSoakWindow`
- `Test-DysonQualificationExecutionGate`
- `Get-DysonQualificationPlanPath`
- `Import-DysonQualificationPlan`
- `Test-DysonQualificationPlan`
- `New-DysonQualificationRun`
- `Test-DysonQualificationRun`
- `Add-DysonQualificationCheckpointReceipt`
- `Invoke-DysonQualificationTransition`
- `Resume-DysonQualificationRun`
- `Get-DysonQualificationPublicProjection`

The state machine never writes a checkpoint itself. A caller may atomically
persist the returned run object in an approved private evidence store. Before a
resume, `Test-DysonQualificationRun` verifies the plan digest, checkpoint
digest, receipt hash chain, sequence, idempotency keys, and evidence freshness.
An interruption during `executing` or `rollback-pending` resumes as
`rollback-pending`; no dangerous action is replayed automatically. Other
interruptions require a fresh prerequisite check or a fresh human challenge.

Step states are `pending`, `ready`, `previewed`, `awaiting-human`, `executing`,
`verifying`, `passed`, `failed`, `rollback-pending`, `rolled-back`,
`interrupted`, and `blocked`. Every terminal result needs a receipt whose
status agrees with the target state.

## Receipt and evidence boundary

A receipt contains canonical UUIDs, a global sequence, event/status, bounded
UTC validity, the preceding receipt digest, an optional challenge UUID, and an
opaque private evidence reference. The evidence reference exposes only an
opaque UUID, evidence type, SHA-256, validity timestamps, and an attestation
class. The receipt digest is SHA-256 over canonical JSON without the digest
field itself. A duplicate is idempotent only when both content and digest are
identical; conflicting reuse is rejected.

Canonical JSON recursively sorts object keys but preserves array order and
cardinality at both the document root and nested properties. In particular, an
empty array remains `[]` and a one-item array remains `[item]` under Windows
PowerShell 5.1; neither is coerced to `null`, a scalar, or a PowerShell wrapper
object before hashing.

Private evidence retains the actual machine paths, endpoint, network
observations, player-side material, paired-save manifests, and logs. None of
those values may be copied into a receipt or public projection. The public
projection exposes only acceptance IDs, step IDs, result/time classifications,
and digests. `Test-DysonQualificationPublicValue` rejects path/address/domain,
identity, save-name, raw-log, credential, secret, token, and key-shaped data.

## External client transcript

`Assert-DysonExternalClientReceiptSequence` accepts exactly this order:

1. `client-challenge-issued`
2. `game-address-resolved`
3. `game-authenticated`
4. `game-joined`
5. `game-interaction-observed`
6. `save-requested`
7. `save-independently-acknowledged`
8. `game-disconnected`
9. `reconnect-challenge-issued`
10. `game-rejoined`
11. `external-sequence-complete`

The first eight receipts share one challenge UUID. The final three share a new
challenge UUID, and reuse is rejected. Each event has an authoritative evidence
type and a 120-to-600-second leg limit; the whole transcript is limited to 2400
seconds. All eleven receipts must use one run UUID; the first ten statuses are
`observed` and the terminal dual-party status is `passed`. A failed,
interrupted, rolled-back, or cross-run chain cannot prove a join. The transcript
contains no nonce, player identity, or address. An HTTP
status, open TCP port, or client self-report is explicitly not accepted as proof
of authentication, a real join, interaction, save acknowledgement, disconnect,
or rejoin. The save acknowledgement must come from an independent paired-save
observer, and the final event must be a dual-party attestation.
Its `transcriptBindingSha256` is the canonical digest of both challenge UUIDs
and the tenth receipt digest, so a label-only attestation cannot validate a
changed or disconnected transcript.

## Execute gate

Preview is the default and does not enable production writes. An `execute`
request is accepted only when all of these match at once:

- the process environment switch has the exact fixed value;
- the request ID is a canonical lower-case D UUID;
- confirmation equals `EXECUTE DYSON QUALIFICATION SHADOW <UPPERCASE-ACTION> <requestId>` exactly;
- observed and requested `sha256:<digest>` target identities match;
- the request is no older than fifteen minutes;
- the current time is inside a maintenance window no longer than four hours;
- a target-matched paired-save protection point is no older than thirty
  minutes, has not expired, and carries valid save-pair and evidence digests.

The protocol gate authorizes no command. It only validates an allowlisted action
request for a separately reviewed bounded adapter. Shadow self-tests may set the
switch in their child process. This protocol must not be treated as authority to
execute a production reboot, storage interruption, disk-pressure allocation,
process termination, update rollback, or GSManager switch.
The literal `SHADOW` in the v1 confirmation is intentional: this version cannot
authorize a production adapter. A production-capable adapter must use a new,
separately reviewed protocol version and fresh operator authorization. Protocol
v2 now supplies a fixed, default-off adapter framework for four actions, but it
does not change this v1 boundary: no v1 request, environment value, `SHADOW`
phrase, receipt, or state can authorize v2. See `README.production-v2.md`.

The six-hour soak step requires at least 21,600 seconds of real elapsed private
evidence. A virtual clock is useful only for state-machine self-tests and cannot
qualify production sustained operation. `Test-DysonQualificationSoakWindow`
therefore reports a virtual fast-forward as duration-satisfied but always sets
`productionQualified=false`; only a real monotonic window can set it true.
