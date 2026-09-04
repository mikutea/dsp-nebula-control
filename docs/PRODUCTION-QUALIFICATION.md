# Production qualification runbook

This runbook defines the resumable qualification path for the nine current
`not-started` requirements in `acceptance/manifest.json`. It is a procedure and
protocol contract. It is not evidence that a Dyson host, route, save, player, or
GSManager installation has been exercised.

The repository qualification tools are Windows PowerShell 5.1 compatible and
default to zero production writes. Protocol v1 and its executor remain
Shadow-only. Protocol v2 adds separately versioned, fixed, default-off mutation
adapters for exactly four actions: control-plane restart, exact-PID DSP crash
recovery, one named SMB global-mapping interruption, and bounded allocation in
one marked disposable qualification directory. A separate orchestration v2
layer can now consume protected receipts for restore, reboot, update,
side-by-side deployment, switch/removal, six-hour/72-hour soak, panel, network,
and external-client evidence. It never invokes those lower transactions. No
production adapter was invoked to build or test this delivery. Every real
action still needs fresh authorization, a reviewed private profile, an approved
maintenance window, and verified protection/evidence.

All examples and identifiers in this document are fictional. Production paths,
addresses, domains, players, saves, logs, credentials, task exports, and host
configuration belong only in the private evidence store.

## What can and cannot qualify a requirement

Repository parser checks, the v1 Shadow self-test, the v2 fake-backend
self-test, and the orchestration v2 protected-receipt matrix prove the
qualification state machines, exact JSON shapes, durable intent/receipt
behavior, interruption recovery, evidence-chain checks, danger gates, and
fictional adapter compensation. They do not prove any target-host behavior. A
public receipt is only a redacted index into private evidence; it does not
become qualifying evidence merely because its JSON is valid.

The following hierarchy is mandatory:

1. **Repository validation** proves that the tool and its isolated fixtures
   behave as specified. It leaves all nine requirements `not-started`, including
   when the v2 fake matrix passes.
2. **Controlled target execution** proves one bounded step on the exact
   candidate, at the evidence scope required by `docs/ACCEPTANCE.md`. A preview,
   HTTP `200`, open TCP port, WebSocket upgrade, healthy process, or operator
   assertion is not an end-to-end pass.
3. **Acceptance promotion** happens only after the private bundle is verified,
   bound to the exact subject commit and runtime-payload SHA-256, converted into
   the bounded public evidence index, and accepted by the final release gate.

Virtual time is allowed only inside the isolated self-tests. A virtual six-hour
advance proves timer and resume logic; it is never sustained-operation evidence.
The production soak requires at least six real hours measured by a monotonic
clock and supported by genuine timestamped telemetry.

## The nine open requirements

The mapping below is exhaustive for the current `not-started` set. Several
qualification steps intentionally support more than one requirement, but no
step silently promotes a wider requirement.

| Requirement | Qualification steps | Minimum real-world conclusion |
| --- | --- | --- |
| `SAV-005` — Production restore drill | `paired-save-restore`, `external-client-e2e` | A real, verified paired backup is restored in a controlled drill, the pinned DSP/Nebula build loads it, an external client joins it, a new save acknowledgement and stable pair are observed, and rollback remains available. Copying bytes or verifying a manifest alone is insufficient. |
| `PRD-001` — Side-by-side Dyson deployment | `side-by-side-deployment` | The exact candidate runs within its declared data boundary while GSManager stays recoverable and production authority remains unchanged. Candidate health must be independently observed; installation success alone is insufficient. |
| `PRD-002` — Authenticated TLS management endpoint | `authenticated-panel` | The approved TLS route reaches the loopback-bound Node service, valid authentication succeeds, unauthenticated and under-privileged requests fail, and the management route cannot consume the game route. No credential is captured in qualification output. |
| `PRD-003` — Game DNS and PassWall-bypass path | `game-protocol-path`, `external-client-e2e` | DNS classification, TCP ownership, any TLS/WebSocket layer, Nebula handshake, and actual route classification all agree. The exact external client joins through the intended path, and private route evidence proves it did not traverse PassWall. |
| `PRD-004` — External client end-to-end join | `external-client-e2e` | A genuinely external production-candidate client authenticates, loads the lobby/world, completes a server-observed interaction, requests a verified save, disconnects cleanly, and reconnects to a fresh session, all within the challenge windows. |
| `PRD-005` — Production reboot, fault, and soak evidence | `windows-reboot-recovery`, `control-plane-restart-recovery`, `game-crash-recovery`, `storage-interruption-recovery`, `controlled-disk-pressure`, `update-rollback`, `paired-save-restore`, `six-hour-soak` | Each real drill ends in independently verified service, game, save, and recovery state with private evidence. The soak also satisfies the full real-time and representative-workload rules below. One combined summary cannot conceal a missing sub-drill. |
| `CUT-001` — GSManager and production recovery package | `side-by-side-deployment`, `paired-save-restore`, `gsmanager-recoverable-switch` | The exact GSManager snapshot, DataRoot recovery bundle, scheduled-task/configuration preimages, candidate recovery state, and paired-save protection point verify independently before authority changes. |
| `CUT-002` — Reversible production cutover | `gsmanager-recoverable-switch`, `authenticated-panel`, `game-protocol-path`, `external-client-e2e` | During a declared maintenance window, authority transfers once to Dyson Control, management/game/save/client health is proven, and the documented rollback restores the prior authority without save loss or concurrent owners. |
| `CUT-003` — GSManager removal and post-cutover acceptance | `gsmanager-recoverable-switch`, `six-hour-soak` plus a later removal-specific operator record | The reversible switch, rollback drill, observation window, final recovery package, release baseline, and evidence index pass before removal is separately approved. The qualification switch step does not itself remove GSManager and cannot by itself verify `CUT-003`. |

`CUT-003` is deliberately last. GSManager remains available until the external
client, real reboot, restore, update rollback, recovery, and sustained-operation
gates pass. A successful Shadow switch or a production preview does not satisfy
this ordering rule.

## Qualification protocol and plan

The fixed public protocol is `DYSON_PRODUCTION_QUALIFICATION_V1`, with
`schemaVersion: 1` and plan ID `dyson-production-qualification-v1`. The plan
is stored at
`scripts/windows/qualification/qualification-plan.v1.json` and contains these
stable step IDs:

| Step ID | Purpose | Normal evidence scope | Production mutation class |
| --- | --- | --- | --- |
| `side-by-side-deployment` | Verify immutable candidate deployment beside the current authority and confirm isolated persistent roots. | `dyson-side-by-side` | Existing deployment transaction, separately authorized; not executed by the qualification Shadow adapter. |
| `authenticated-panel` | Verify TLS, loopback origin, authentication, authorization, session, and management/game route separation. | `production` | Read-only qualification observations. |
| `game-protocol-path` | Verify DNS classification, exact listener ownership, protocol layers, route class, and PassWall bypass. | `external-client` | Read-only preflight; any DNS/router/firewall change is outside this run and separately authorized. |
| `external-client-e2e` | Run the two-sided join/authentication/interaction/save/disconnect/reconnect challenge. | `external-client` | Real external client and save request; no player identity or network address is collected. |
| `paired-save-restore` | Restore and load one atomic `.dsv`/`.server` unit, then save again and prove rollback. | `production` | Dangerous, stopped-host, fresh-protection operation. |
| `windows-reboot-recovery` | Bind a pre-reboot checkpoint to the exact host/candidate and resume it after a separately authorized real reboot. | `production` | The qualification recorder does not initiate the reboot. |
| `control-plane-restart-recovery` | Interrupt only the candidate control plane and prove durable-job reconciliation without repeated mutation. | `production` | Dangerous bounded adapter. |
| `game-crash-recovery` | Hard-exit the managed DSP process and prove exact task/process/listener recovery and client rejoin. | `production` | Dangerous bounded adapter; never a real fault in repository self-test. |
| `storage-interruption-recovery` | Interrupt the explicitly named storage dependency for a bounded interval and prove fail-closed behavior plus recovery. | `production` | Dangerous bounded adapter; no generic mount/share command is permitted. |
| `controlled-disk-pressure` | Exercise a capped, disposable allocation on the approved qualification volume and prove thresholds, abort, cleanup, and recovery. | `production` | Dangerous bounded adapter; system, application, DataRoot, and save volumes are never implicit targets. |
| `update-rollback` | Activate an exact staged candidate, force a bounded failed-smoke outcome, restore prior binaries/config/mod lock/save, and load the prior version. | `production` | Dangerous existing update transaction, separately authorized. |
| `gsmanager-recoverable-switch` | Transfer authority once, prove the no-dual-owner invariant, verify health, and exercise explicit rollback. | `cutover` | Dangerous cutover transaction; it does not remove GSManager. |
| `six-hour-soak` | Run the fixed late-game workload and retain at least six real hours of complete telemetry. | `production` | No fault injection during the qualifying window. |

Every step declares its prerequisites, timeout, evidence expiry, rollback
contract, and predecessor IDs in the plan. A run uses one canonical UUID and one
immutable plan. Replaying the same step request is idempotent only when its
fingerprint and preceding receipt hash match. Reusing an ID for a different
step, target, mode, adapter, plan, or evidence digest fails closed.

The in-memory state machine returns a newly digested run object after every
accepted transition; it does not write a checkpoint itself. Its caller must
atomically persist that object in the approved private evidence store before
continuing. A checkpoint contains only the strict protocol object and opaque
evidence reference; raw adapter output is stored privately first. On
interruption, resume revalidates the plan, receipt hash chain, sequence, expiry,
target binding, completed prerequisites, and private evidence digest before
deciding whether it can continue. It never blindly reruns an in-progress
dangerous phase. An uncertain phase remains recovery-required until the bounded
adapter's read-only inspection proves a terminal outcome.

The fixed step-state vocabulary is `pending`, `ready`, `previewed`,
`awaiting-human`, `executing`, `verifying`, `passed`, `failed`,
`rollback-pending`, `rolled-back`, `interrupted`, and `blocked`. Every emitted
non-terminal state can be persisted as a durable checkpoint, but that does not
mean an operator may kill an underlying host action arbitrarily. A requested
pause is recorded at the next adapter-safe boundary. After a runner hard-exit,
resume verifies the
hash chain and private evidence freshness and moves an interrupted step only to
`verifying`, `rollback-pending`, or `blocked`, based on the interrupted state.
Moving back to `ready` is a later explicit transition with fresh prerequisites.
An interruption from `executing` or `rollback-pending` becomes
`rollback-pending`; `awaiting-human` and other incomplete observations become
`blocked`; an interrupted verification may continue as `verifying`. Resume
fixes `dangerousActionReplayed` to false and never automatically replays the
dangerous action.

Legacy protocol v1 Shadow step receipts use only the exact fields implemented by
that qualification state machine: `protocol`, `schemaVersion`, `receiptId`, `runId`,
`idempotencyKey`, `stepId`, `sequence`, `event`, `status`, UTC issue/expiry
times, `predecessorSha256`, `challengeId` when the step event requires it, an
opaque `evidenceRef`, bounded `publicSummary`, and `receiptSha256`.
`evidenceRef` contains exactly `opaqueId`, `type`, `sha256`, `observedAtUtc`,
`expiresAtUtc`, and `attestationClass`; `publicSummary` contains only
`checkCodes` and the optional legacy external `transcriptBindingSha256`. That
V1-only field is not the V2 External Join observation digest. Extra or misspelled
fields fail closed.

`challengeId` is null for ordinary receipts. Every non-null value must be a
canonical UUID and is permitted only for a challenge-bound event. The separate
public projection contains top-level `protocol`, `schemaVersion`,
`acceptanceIds`, bounded `result` and `timeClassification`, `steps`,
`checkpointDigest`, `planDigest`, and `productionChanged: false`. Each step
contains only `stepId`, `acceptanceIds`, bounded `result` and
`timeClassification`, `evidenceDigests`, and `resultDigest`. It does not
serialize the private run or checkpoint object.

## Preview and execute separation

Preview and execute are separate requests. Preview is read-only and reports
prerequisite checks, blockers, timeout, rollback method, required evidence,
target-match status, protection-point freshness, and the exact confirmation
phrase. Preview never creates a protection point, starts/stops a process,
allocates pressure data, changes storage, changes an authority, restores a save,
or writes a production checkpoint.

Every dangerous execute must satisfy all of these gates at the instant it is
accepted:

- `mode` is exactly `execute`; preview output never doubles as authority;
- execute remains disabled unless the fixed qualification environment switch
  has its exact versioned value;
- the request ID is a new canonical UUID and its fingerprint matches the
  previewed action;
- the operator types
  `EXECUTE DYSON QUALIFICATION SHADOW <UPPERCASE-ALLOWLISTED-ACTION> <canonical-request-id>`
  exactly, using the allowlisted action and the same canonical request UUID that
  were previewed; the literal `SHADOW` is mandatory in protocol v1;
- the observed target fingerprint matches the privately approved host, release,
  runtime payload, data boundary, task identities, and step binding;
- current UTC time is inside the declared maintenance window and the approval
  reference is still valid;
- a fresh, independently verified protection point covers every mutable object
  for that action, including the atomic save pair where applicable;
- no lifecycle, deployment, update, restore, cutover, removal, recovery, or
  qualification request is pending or uncertain;
- the adapter declares fixed duration, resource, free-space, process, retry, and
  cleanup bounds plus an abort path and rollback inspection; and
- the action-specific private evidence sink is available before mutation starts.

Protocol v1 fixes the timing and identity bounds: request, receipt,
idempotency, challenge, and protection-point IDs are canonical lower-case
hyphenated UUIDs; target identities are `sha256:` plus 64 lower-case hexadecimal
characters; an execute request may be at most 15 minutes old and no more than
one minute in the future; a maintenance window may be no longer than four hours
and must contain the current time; and the target-matched protection point may
be at most 30 minutes old, must still be unexpired, and may expire no later than
two hours after creation. Both its atomic-save-pair digest and independent
evidence digest must validate.

Protocol v1 has two independent Shadow-only gates. The protocol gate requires
the exact process value
`DYSON_QUALIFICATION_EXECUTE_ENABLED=ALLOW_BOUNDED_PRODUCTION_QUALIFICATION_V1`
and the exact `SHADOW`/uppercase-action/canonical-UUID confirmation above. It
only validates the fixed request contract; despite the legacy environment value
containing the word `PRODUCTION`, it authorizes no command and cannot authorize
a real production adapter.

The executor gate separately requires
`DYSON_QUALIFICATION_EXECUTE=SHADOW_FIXTURE_ONLY_V1`, the same exact
`EXECUTE DYSON QUALIFICATION SHADOW <UPPERCASE-ALLOWLISTED-ACTION> <canonical-request-id>`
confirmation, and a marked Shadow root beneath the system temporary directory.
The marker, root containment, backend, action, request, and confirmation all
have to match. The v1 executor has no production backend. `Contract` mode
describes the bounded adapter contract without calling system mutation cmdlets,
and every execute request in that mode returns `unsupported`. Setting either or
both v1 environment variables does not authorize or enable a real action.

Any production adapter must use a new protocol version, a new explicit
authorization decision, and newly reviewed gates and confirmation vocabulary.
Protocol v2 does so for its four fixed adapters. It does not reuse the v1
environment variables or treat the v1 `SHADOW` phrase as production authority.
Do not replace any gate with an arbitrary command, script path, service name,
task name, volume, share, hostname, or operator-supplied shell fragment.

### Protocol v2 fixed-adapter gate

Protocol v2 is `DYSON_PRODUCTION_QUALIFICATION_V2`, schema version 2. Its public
implementation contract is
`scripts/windows/qualification/README.production-v2.md`; its private profile
must validate against
`scripts/windows/qualification/qualification-production-profile.v2.schema.json`.
The public request and protection-point shape is
`scripts/windows/qualification/qualification-action-request.v2.schema.json`.
V2 is not an upgrade or alternate spelling of v1. V1 requests, receipts,
environment values, and confirmations are invalid under v2, and vice versa.

Read-only preview validates the exact-property request and profile, reports the
profile SHA-256 and preview SHA-256, and does not create the durable state store
or call an adapter. Production preview also checks the SHA-256 host binding
derived from the current Windows MachineGuid without exposing that raw value.
Execute additionally requires all of the following at once:

- a private profile whose top-level and chosen-action `enabled` values are true,
  whose canonical UUID is unexpired, and whose digest matches the request;
- the exact v2 production environment name and versioned value (not either v1
  value and not the distinct fake-backend value);
- a new canonical request UUID and approval UUID, a current maintenance window,
  and a fresh target-matched protection point backed by an ACL-controlled
  private evidence record that binds the exact request/profile and verifies an
  existing `.dsv`/`.server` pair plus independent evidence file;
- an exact confirmation of
  `EXECUTE DYSON QUALIFICATION PRODUCTION V2 <UPPERCASE-ACTION> <profile-uuid> <request-uuid> <preview-sha256>`;
- the current machine binding, action target ID, predecessor receipt digest,
  strict parameter type, and hard action bounds all match; and
- an exclusive state-store lock followed by same-directory temporary write,
  `Flush(true)`, handle close, and destination-must-not-exist atomic publication
  of a digested intent before any adapter call.

Changing parameters, profile, target, maintenance window, protection point, or
predecessor changes the full preview digest and invalidates the confirmation.
The request builder never generates an execute confirmation: the operator must
review the preview and explicitly supply the displayed full phrase to the
preview-to-execute conversion.
The four action identifiers are a closed allowlist. There is no command,
scriptblock, free-form executable, wildcard process, wildcard share, recursive
delete, network-adapter, reboot, update, restore, or authority-switch input.

Every terminal result is an atomically published create-new, digested receipt
chained to the previous receipt and its persisted intent. Before replay, the
executor verifies the complete sequence from its zero predecessor and requires
every corresponding self-valid intent to match request/profile/action/target/
sequence/predecessor/intent digests. Missing intents, orphan receipts, broken
predecessors, and orphan atomic-write temporaries fail closed. Exact request
replay then returns the immutable receipt without mutation; reuse of the UUID
with any changed request is a collision. An intent without a receipt requires
explicit resume. Resume only
inspects the fixed target, never replays the mutation, and either records a
verified terminal state or runs bounded compensation. Failed compensation
persists `recovery-required` and blocks all new actions until manual recovery
and fresh authorization. Recovery of the same persisted intent may proceed
after its original request, maintenance window, or protection point expires,
but only for the identical request digest, only for at most 31 days, and only
through inspection or compensation. It cannot start the original action. An
expired action deadline receives a new bounded compensation window of no more
than 300 seconds.

### Protocol v2 protected-receipt orchestration

`Qualification.OrchestrationV2.ps1` is a receipt adapter, not a second action
runner. Its fixed public contract and strict profile/request/evidence schemas
cover exactly these 11 evidence actions: paired-save restore, Windows reboot
checkpoint/resume, update rollback, side-by-side deployment, recoverable
GSManager switch, GSManager removal plus restore proof, six-hour and 72-hour
soaks, authenticated panel, game protocol path, and external-client E2E. It
reuses the existing lower transaction receipts; controlled observation
adapters exist only where the observation is external to a repository
transaction. No free-form command, executable, path outside the private root,
or self-reported pass Boolean is accepted.

The private profile is exact-property, unexpired, and disabled by default at
both global and action levels. Every adapter ID, verifier ID, HMAC key ID,
required artifact role/protocol version, complete check-code set, evidence age,
duration, sample/gap floor, protection requirement, and rollback role is fixed
by `fixtures/orchestration-adapter-contract.v2.json`. Each consume request binds
canonical request/approval/run/profile IDs, action target, target identity,
subject commit, runtime payload, evidence file bytes, predecessor receipt, and
the full preview digest. The confirmation is valid for no more than 15 minutes.
Production additionally requires the exact versioned process gate and protected
fixed-local state, evidence, and key-ring roots.

The controlled envelope has its own action-specific verifier HMAC and nonce.
Its `subjectBindingSha256` is recomputed from the canonical evidence, request,
approval, run, profile, action target, target identity, subject commit, runtime
payload, adapter/verifier IDs, and nonce; an opaque caller-supplied digest is not
accepted. Every JSON document is checked for duplicate object keys before
PowerShell conversion, including escaped spellings of the same key. Every
referenced source is opened as a plain non-reparse file below the exact evidence
root, and the bytes parsed are the bytes hashed. Protocol/schema drift, missing
or extra roles/checks, duplicate IDs/paths, stale or relabelled completion time,
source hash change, rollback mismatch, replayed evidence ID/nonce, or HMAC
failure blocks the receipt. Controlled observations additionally bind the exact
action target and their observation timestamp. For external-client artifacts
the adapter calls the strict `DYSON_EXTERNAL_JOIN_OBSERVATION_V2` validator,
requires its complete 12-event chain, and rebinds the exact first/final times,
event count, maximum observed gap, server-authoritative initial join, fresh
rejoin, and terminal observation digest. The game-path adapter requires the
protected hostname/WSS qualification artifact and the fixed
hostname/ingress/server-session/PassWall-counter check set.

The soak adapters accept only `real-monotonic`: at least 21,600 seconds and
1,441 samples for six hours, or 259,200 seconds and 17,281 samples for 72 hours,
with no sample gap above 30 seconds and the exact workload/join/save continuity
checks. The inclusive counts match a 15-second series from the first through the
last sample. Virtual-clock receipts remain repository-test evidence only.

### Strict v2 observation formats and their limits

The following strict formats close local parser, binding, sequencing, expiry,
and tamper-validation gaps. Their generators consume already collected files or
facts and their validators are read-only. They are not live probes, deployment
tools, game clients, soak collectors, or permission to operate the Dyson VM.

| Protocol | What the local validator requires | What it does not prove |
| --- | --- | --- |
| `DYSON_QUALIFICATION_SIDE_BY_SIDE_OBSERVATION_V2` | An independently frozen expectation, HMAC-protected capture, exact candidate release/runtime/root, independent health/runtime observations, verified GSManager snapshot, distinct ports, and unchanged GSManager authority with no dual owner. | It does not install or start the candidate, inspect the VM, or prove that the supplied capture came from the production target. |
| `DYSON_QUALIFICATION_PAIRED_SAVE_LOAD_OBSERVATION_V2` | Exact recovery receipt/bundle, protected paired-save identity, loaded-world Bridge evidence, acknowledged new save, intact new pair, and rollback receipt, all bound to one run/release/runtime/data-root/save generation. | It does not stop the game, restore files, load a world, request a save, or execute rollback. Hash or copy success alone is not a load proof. |
| `DYSON_CONTROL_PANEL_OBSERVATION_V2` | Public host, certificate identity and validity, SNI/Host agreement, authenticated session, viewer mutation rejection, administrator read, loopback-only Node listener, and separate management/game routes. | It does not contact the public endpoint, authenticate a real operator, change TLS/DNS, or turn an HTTP response into target evidence. |
| `DYSON_EXTERNAL_JOIN_OBSERVATION_V2` | One ordered 12-event DNS/TLS/WSS/Nebula/auth/join/interaction/save/disconnect/reconnect/rejoin chain bound to one release, endpoint, pseudonymous external client, world, and stable paired save. | It does not create the external session, contact the game, request a save, or permit player identity/network-address collection. |
| `DYSON_REVERSIBLE_CUTOVER_OBSERVATION_V2` | Approved window, exact release manifest, paired-save protection point, GSManager authority snapshot, forward and rollback switch receipts, management/Nebula health, restored pair, and ordered audit/no-loss proof. | It does not switch authority, activate either owner, contact a host, or authorize the cutover. One-way switch success cannot qualify. |
| `DYSON_POST_GSMANAGER_REMOVAL_OBSERVATION_V2` | A passed cutover, independent observation window, removal receipt, zero installation/task/service/port/process residue, exact Dyson Control identity, management/game/reboot/save health, inactive verified recovery package, and final evidence/runbook/checksum set. | It does not remove GSManager or prove that a zero-residual inventory was collected from the VM. A deletion receipt alone cannot qualify. |
| `DYSON_SOAK_OBSERVATION_V2` | Exact six-hour or 72-hour real-monotonic duration and inclusive sample floors, a chained compact segment proof with gaps at most 30 seconds, representative late-game workload/save, component health, external Nebula join/rejoin, periodic stable saves, zero crash/recovery/data-loss outcome, and a closed alert conclusion. | It does not wait, collect telemetry, fast-forward a production clock, or replace the private raw samples and actual elapsed target observation. |

Passing any generator, validator, schema check, or fictional self-test in this
repository proves only local validation infrastructure. `PRD-*`, `CUT-*`, and
`SAV-*` entries must remain at their pre-production state; they may not be
changed to `implemented` or `verified` until a separately authorized run on the
actual Dyson VM produces independently reviewed private evidence for the exact
release, commit, runtime, manifest, target, run, and applicable save/session.
No combination of locally generated documents substitutes for that evidence.

Preview and PowerShell `-WhatIf` verify all of that but write no state and
cannot qualify a requirement. Consume atomically publishes a validated intent and then a
redacted chained receipt. A hard exit after the intent requires explicit
`-Resume`; resume revalidates the same protected evidence and cannot rerun the
lower transaction. An exact replay returns the immutable receipt, while changed
request content, a broken predecessor, reused evidence, or an unrelated orphan
intent fails closed. The adapter's only mutation is its private qualification
state; its receipt always records `productionChanged: false` and contains no
private path, host/network/player/save detail, raw log, or secret.

### Bounded dangerous-action contracts

The following constraints are part of the overall adapter protocol. V1 tests
all of them only in Shadow. V2 additionally supplies production-capable,
default-off implementations for the four entries explicitly identified below;
its tests still use only a fake backend:

- **Windows reboot:** create and verify the existing reboot-acceptance
  checkpoint, pause the run, and require an out-of-band authorized reboot. The
  qualification adapter must not call a reboot command. Resume must prove a new
  boot, post-boot task instances, dedicated session, exact process/listener,
  loopback readiness, and independent Task Scheduler trigger evidence.
- **Control-plane restart:** do not touch DSP or GSManager. Bound the stop/start
  and readiness windows, reconcile an intentionally interrupted durable job,
  and prove that an already completed phase was not executed twice. V2 binds a
  captured process to exact PID, executable path, file SHA-256, and command-line
  SHA-256. It requires the configured PID file to equal the request PID before
  capture and again immediately before `Stop-Process`, so another identical
  `node.exe` instance is not interchangeable. Its replacement readiness receipt
  is self-digested and binds the target/request, new PID/start UTC, executable,
  command line, release/runtime, sequence, and intent. V2 also requires a process
  identity disjoint from DSP and starts only the exact TaskPath/TaskName whose
  exported task XML SHA-256 matches the private profile.
- **DSP crash:** kill only the exact fingerprint-matched managed PID, never by a
  broad image-name match. Require scheduled recovery, a new exact PID/listener,
  bridge health, paired-save integrity, and an external reconnect. V2 implements
  the same double-read authoritative PID file, command-line identity, and strict
  readiness receipt. Client and save proof remain private target-run obligations.
- **Storage interruption:** act only on an allowlisted dependency whose identity
  and recovery method were approved. Reject filesystem roots, broad shares,
  unrelated volumes, and unresolved paths. Limit the outage, fail closed on
  writes, restore the dependency, verify pending receipts and save pairs, and
  stop on an uncertain cleanup. V2 accepts only one exact SMB global mapping,
  reserves at least five seconds of its 10–300 second hard outage window for
  automatic restore, and uses only the exact profiled restoration task after its
  exported XML SHA-256 matches. A failed SMB provider/query is never treated as
  absence: inspect and polling fail closed, initial observation failure cannot
  start restoration, and no query-failure path may report success.
- **Disk pressure:** allocate only a bounded disposable file inside an approved
  same-volume qualification fixture. Reject system, application, DataRoot,
  live-save, backup, recovery, and evidence roots. Continuously enforce both the
  configured byte cap and the fixed safety floor, abort before 90% used or below
  10 GiB free, remove only the exact allocation, and independently verify
  cleanup. If the real production storage behavior is not exercised, the result
  is integration evidence and cannot verify `PRD-005`. V2 further caps its
  profile at 85% used, 64 GiB allocation, and 300 seconds hold, requires an
  otherwise-empty non-reparse marked directory, and deletes only the exact
  request allocation.
- **Update rollback:** use only the immutable staged update transaction and its
  fresh save protection point. The failed smoke must be bounded and planned;
  restore exact binaries, configuration, mod lock, and save, then start and load
  the previous release and complete an external join.
- **Save restore:** treat `.dsv` and `.server` as one atomic unit, require the
  exact stopped-state proof and fresh protection backup, load the restored world,
  save again, and verify compensation. A hash-only or byte-copy result is not a
  load proof.
- **GSManager switch:** snapshot and verify GSManager plus DataRoot and save
  recovery first. At every observation exactly one authority may own the game
  runtime/port. Rollback restores the old authority in its documented disabled
  or activation-required state, after which the separate cutover coordinator
  explicitly activates the chosen owner. The qualification adapter never
  removes GSManager.

## External Join Observation V2

`DYSON_EXTERNAL_JOIN_OBSERVATION_V2` is the strict read-only format for the
external-client run. It is not a connectivity probe. Its generator consumes
facts already collected by separately authorized external-network,
external-client, server-authoritative, and independent-save observers. It does
not contact the game, create a challenge, request a save, or perform a join.

### Participants and privacy

- The **external-network observer** supplies the public-routable DNS
  classification without retaining resolver answers or source addresses.
- The **external client** supplies TLS/WSS and reconnect transport observations
  for the exact production-candidate client and normal join input.
- The **server-authoritative observer** supplies Nebula transport,
  authentication, join, interaction, save-request, disconnect, and rejoin
  receipts.
- The **independent-save observer** binds the requested save to one acknowledged
  stable pair and manifest.
- The observation identifies the witness only as a one-run
  `client:sha256:<64 lowercase hex>` pseudonym. It requires source address,
  display name, account ID, and device ID collection flags to remain false.
- If an unavoidable raw host or edge log contains an identity or address, it is
  not ingested into the challenge evidence. The collector emits only the fixed
  classification and discards the raw value. Redaction after publishing is not
  an acceptable substitute.

Each event contains its exact sequence and event name, fixed observer class,
qualification-session UUID, the same pseudonym, UTC observation/expiry time,
release/endpoint/session bindings, event-specific evidence, predecessor digest,
and event digest. The validator rejects duplicate JSON keys, expired or
wrong-order events, wrong predecessors, mixed run/release/endpoint/client/save
bindings, failed domain evidence, and mixed qualification sessions. No nonce
plaintext, credential, player identifier, or network address is permitted.

### Ordered stages

The fixed sequence has twelve events. The complete sequence must finish within
2,400 seconds. Each inter-event maximum is fixed by the protocol; an operator
cannot extend one ad hoc.

| Sequence event | Maximum from previous event | Required observation and attestation |
| --- | ---: | --- |
| `dns-resolved` | n/a | The external-network observer binds the expected public host to an opaque answer-set digest and `public-routable` classification. This supports routing only; it is not a join. |
| `tls-established` | 300 s | The external client verifies the expected SNI, TLS 1.2/1.3, certificate digest, validity, and DNS-name match. |
| `wss-established` | 120 s | The external client verifies the expected Host authority, `/socket` path, WebSocket upgrade, and WSS transport. |
| `nebula-transport-established` | 120 s | The authoritative server binds an actual Nebula handshake receipt. HTTP or TCP reachability cannot satisfy this event. |
| `nebula-authenticated` | 300 s | The authoritative server binds successful authentication without retaining an authentication value or player identity. |
| `nebula-joined` | 300 s | The authoritative server binds the initial joined session and exact world. A socket, WebSocket, or client-only assertion is insufficient. |
| `interaction-observed` | 300 s | The authoritative server binds a predefined reversible gameplay interaction on the same world. Player count alone is insufficient. |
| `save-requested` | 300 s | The authoritative server binds the fixed save request UUID to the same world and session. There is no public player mutation endpoint. |
| `save-verified` | 600 s | The independent-save observer binds the same request to a server acknowledgement, save receipt, manifest, and stable atomic `.dsv`/`.server` pair. |
| `disconnected` | 300 s | The authoritative server proves a clean end to the initial session; a dropped probe socket is not sufficient. |
| `reconnect-transport-established` | 600 s | The external client establishes the full TLS/WSS/Nebula stack under a different qualification-session and challenge UUID. |
| `nebula-rejoined` | 600 s | The authoritative server proves a fresh rejoin to the same world and exact verified save pair. A stale session or alternate world fails. |

The first ten events use the initial qualification-session UUID. The final two
use a different reconnect qualification-session UUID and reconnect challenge
UUID. Both session and challenge identities must be fresh. Every event repeats
the same release, endpoint, pseudonym, world, and save bindings and is linked by
its predecessor digest. The top-level `observationSha256` seals the complete
12-event chain; orchestration binds that digest as the terminal receipt instead
of accepting a separately asserted pass Boolean.

Each deadline is defined by the versioned observation protocol rather than an
operator's ad hoc timer. Expired evidence cannot be revived by editing
timestamps or replaying a request. A reconnect that occurs after expiry requires
a new observation/session pair and does not splice into the old event chain.

### What counts as a real join

All of the following are necessary:

- the exact intended Nebula client and candidate versions are bound to the run;
- the host maps the listener to the exact managed executable and candidate;
- the client reaches the intended lobby/world through the production join input;
- authentication completes without collecting its identifying value;
- authoritative bidirectional game state changes in response to the interaction
  challenge;
- a challenge-bound save has an independent acknowledgement and stable atomic
  pair;
- the authoritative server observes disconnect and a new qualification session
  completes the TLS/WSS/Nebula reconnect; and
- the last authoritative rejoin and top-level digest bind the same unexpired
  release, endpoint, pseudonym, world, and verified save pair.

DNS resolution, ICMP, an open port, HTTP `200`, `101 Switching Protocols`, a
dashboard health response, player count, or a self-authored “success” statement
may support a layer classification but can never substitute for these facts.

## Shortest safe qualification sequence

This is the shortest critical path for one long acceptance day after the exact
candidate, private evidence store, operators, external witness, rollback media,
and maintenance authorizations have already been prepared. Durations are
planning estimates, not evidence. Actual step receipts supply authoritative
times.

| Order | Work | Earliest safe checkpoint and resume rule | Human participation |
| --- | --- | --- | --- |
| 0 | Freeze the subject commit/runtime payload, import the fixed plan, allocate a run UUID, verify the private evidence sink, approvals, topology, rollback packages, and evidence clock. Preview every dangerous step. | **`plan-frozen`** — safe to pause before any execute. Resume rehashes the plan and all private recovery anchors. | Qualification lead, host operator, change approver. |
| 1 | Verify or create the GSManager snapshot, DataRoot recovery bundle, paired-save protection point, and their independently retained digests. Deploy the candidate side-by-side without transferring authority. | **`side-by-side-observed`** — pause only after GSManager remains available, the candidate is either healthy or fully rolled back, and no transaction is pending. | Elevated host operator and rollback observer. |
| 2 | Prove the authenticated management panel and the separate game DNS/TCP/TLS/WebSocket/PassWall-bypass classification. Do not change DNS, firewall, router, or PassWall under qualification authority. | **`routes-classified`** — safe because this phase is read-only. Any route change invalidates the checkpoint and requires a fresh observation. | Panel operator; network owner supplies previously approved route evidence. |
| 3 | Run the external join/authentication/interaction/save/disconnect/reconnect challenge on a disposable acceptance world. | **`external-observation-sealed`** — safe after the complete 12-event observation and self digest validate. An incomplete or expired chain is abandoned, not resumed mid-session. | Real external witness, host observer, and independent-save observer at the required stages. |
| 4 | Perform the controlled paired-save restore/load/new-save/rollback drill. Repeat the external join against the loaded result when required by `SAV-005`. | **`restore-terminal`** — pause only after the selected world is healthy or exact compensation has been verified. Uncertain restore state blocks every later mutation. | Elevated save operator, host observer, external witness for load proof. |
| 5 | Run bounded control-plane restart and DSP crash-recovery drills; verify durable reconciliation, exact process identity, bridge/save integrity, and external rejoin. | **`process-recovery-terminal`** — safe only when both drills are independently terminal and no lease/intent remains. | Host operator; external witness for post-recovery rejoin. |
| 6 | Run the separately approved storage-interruption and controlled-disk-pressure drills. Clean and independently verify the exact temporary allocation/dependency after each action. | **`storage-recovery-terminal`** — pause after storage and free-space baselines are restored and all affected receipts are terminal. | Storage owner and host operator; an approver watches safety floors. |
| 7 | Run staged update failure and exact rollback, load the prior world, and rejoin externally. | **`update-rollback-terminal`** — pause after the previous release/config/mod lock/save and runtime health are independently proven. | Release operator, host observer, external witness. |
| 8 | Create the immutable reboot checkpoint, pause, obtain immediate reboot authorization, perform the real guest reboot outside the qualification runner, and resume the exact checkpoint. | **`reboot-resume-terminal`** — safe after new-boot task/process/listener evidence and independent trigger evidence are stored. If the checkpoint expires, start a new reboot drill. | Host console operator/change approver; no manual recovery login may be hidden. |
| 9 | Start the representative late-game six-hour soak after all disruptive drills. Perform normal multiplayer activity, including an external join near the beginning and a rejoin near the end, without pausing simulation or changing the candidate. | **`soak-sealed`** — the observer may checkpoint and resume without counting unobserved time, but service/workload interruption, candidate change, clock anomaly, or inadequate coverage fails/restarts the qualifying six-hour window. | Soak lead at start/end; external witness at scheduled join points; on-call operator for alerts. |
| 10 | Only after steps 0–9 pass, preview and run the recoverable GSManager authority switch. Prove one owner, management/game/save/client health, explicit rollback, and no save loss. Return to the authority declared by the maintenance plan. | **`cutover-drill-terminal`** — pause only after exactly one authority is healthy and all cutover receipts/guards verify. | Cutover owner, GSManager owner, host operator, external witness, change approver. |
| 11 | Seal private bundles, verify their digests and subject/runtime binding, generate only bounded public indexes, and run the acceptance gate. Plan later GSManager removal/post-cutover observation separately. | **`run-sealed`** — immutable. Any candidate or payload change creates a new run. | Evidence custodian and release approver. |

This critical path takes more than six wall-clock hours even when every human is
ready and every preview is clean. Do not schedule a cutover or removal at a time
that assumes the soak can be fast-forwarded. `CUT-003` may require a later
observation/removal window and should not be promised as same-day completion.

## Pause, interruption, and resume rules

The named checkpoints above are operator concepts; the machine record remains
the protocol receipt chain. The following rules apply at every pause:

- Wait for the current request to reach a verified terminal receipt. Never stop
  the qualification process merely because its child output stopped changing.
- Record interruption intent before voluntarily closing the runner. The next
  resume verifies that intent and the predecessor receipt rather than inferring
  success from external state.
- A process hard-exit after a request was accepted creates an unknown outcome.
  Resume calls only the action's read-only inspection. It either reuses the
  exact terminal receipt, rolls back through the same request, or reports
  recovery-required. It does not submit a new UUID until the old one is resolved.
- A duplicate request with the same UUID, fingerprint, predecessor, and terminal
  receipt returns the same result. A duplicate with any drift is rejected.
- Expired evidence, a changed target fingerprint, changed candidate/runtime
  payload, changed route, changed protection point, or changed maintenance
  window invalidates downstream checkpoints.
- A failed rollback blocks all later mutations. Preserve the guard, receipt,
  intent, audit, and private evidence; keep both candidate and prior authority
  quiesced where the action contract requires it.
- The external-client observation is atomic at the event-chain level. Abandon
  an incomplete or expired chain and issue fresh qualification sessions; never
  manufacture missing network, client, host, or independent-save evidence.
- The production soak observer may checkpoint and resume only when the managed
  service and representative workload continued. Unobserved time never counts,
  mandatory coverage still must reach 95%, and two intervals separated by a
  service/workload interruption cannot be concatenated. Shadow virtual time can
  resume for tests but never contributes production elapsed time.

## Six-hour sustained-operation evidence

Use the existing `late-game-6h-v1` telemetry profile with a representative
late-game paired save and the normal multiplayer workload. The configured target
remains 60 UPS. Do not pause the simulation, remove factories or players merely
to improve the result, lower sampling obligations, or substitute a synthetic
fixture for the production save.

The sealed evidence must show:

- at least 1,441 retained samples spanning at least six real hours, matching the
  inclusive 15-second qualification cadence;
- at least 95% coverage for every mandatory metric;
- managed runtime present in at least 99% of samples;
- critical health in no more than 1% of samples;
- at least 95% of observed running samples at 55 UPS or higher;
- host CPU 95th percentile no higher than 90%;
- hottest logical core at or above 97% in no more than 10% of samples;
- the fixed single-core bottleneck signature in no more than 5% of eligible
  samples;
- host memory peak no higher than 90%; and
- project and save volumes no higher than 90% used and never below 10 GiB free.

Use an independent monotonic timer in addition to UTC timestamps. Reject backward
clock movement, implausible jumps, virtual-clock markers, fixture source tags,
manually edited samples, and a report whose first/last sample does not cover the
sealed challenge window. Preserve exact release, VM allocation, game/mod lock,
save revision, report, sampling cadence, gaps, and alert episodes privately.
The public receipt emits only fixed check codes and the opaque bundle reference.

The soak does not replace the timed save, real reboot, crash, storage, disk,
update rollback, restore, or external-client drills. Conversely, completing all
fault drills does not waive the six-hour wall-clock requirement.

## Public output and private evidence boundary

Public output is an intentionally lossy qualification index. The fixed plan
object carries the public plan ID, while the derived run projection carries
only the fields enumerated above. A step receipt may contain only:

- fixed protocol/schema version;
- canonical run, receipt, idempotency, step, and applicable challenge IDs;
- sequence, event, bounded status, and UTC issue/expiry timestamps;
- predecessor and receipt SHA-256 values;
- `evidenceRef` containing only `opaqueId`, bundle `sha256`, fixed `type`,
  `observedAtUtc`, `expiresAtUtc`, and fixed `attestationClass`; and
- `publicSummary.checkCodes`, selected from the plan's fixed vocabulary; a
  legacy V1 Shadow external receipt may also contain its lower-case
  `transcriptBindingSha256`, while V2 orchestration binds the strict External
  Join observation digest as its terminal receipt.

Public output must never contain, even inside exception text, nested metadata,
filenames, or “debug” fields:

- absolute, relative private, UNC, registry, task, executable, project, DataRoot,
  save, backup, recovery, log, or evidence-store paths;
- IP/MAC addresses, ports tied to production, production domains, hostnames,
  URLs, SNI/Host values, resolver answers, source networks, ISP/location, route
  rules, tunnel identifiers, or router/firewall exports;
- player names, account/platform/session/device identifiers, player counts tied
  to an individual event, chat, coordinates, inventory, or source addresses;
- save names, contents, filenames, raw save-pair hashes, screenshots, or world
  details;
- raw logs, console lines, stack traces, command lines, task XML, ACLs,
  environment dumps, process listings, configuration, database rows, telemetry
  samples, or support bundles; or
- passwords, hashes used for login, session cookies, tokens, API keys, private
  keys, one-time challenge nonces, authorization headers, or credential-bearing
  URLs.

The private evidence store may retain the minimum exact host, route, release,
configuration, recovery, receipt, and raw diagnostic facts needed for the
drill, under its approved ACL and retention policy. It still must not collect
external-player identity or network address. Where a source log inevitably
contains either, the collector must derive the bounded classification without
ingesting the raw record. Every public reference is generated only after the
private bundle is sealed and independently verified. The opaque ID and bundle
digest are references, not permission to copy the private payload into Git.

## Repository-only isolated validation

Run the qualification self-test only from the repository. It creates a unique
marked directory beneath the system temporary root, uses fixture clocks and
v1 Shadow plus v2 fake adapters, and never calls production Task Scheduler,
services, network, storage, saves, or process controls:

```powershell
powershell.exe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass `
  -File .\scripts\windows\qualification\Invoke-QualificationSelfTest.ps1
```

The parent self-test must reject execution unless it is running under Windows
PowerShell 5.1. V1 requires its Shadow marker/root/environment gate; the child
v2 matrix requires its distinct fake marker/root/environment gate. The combined
matrix includes:

- complete normal path;
- runner hard exit and checkpoint resume;
- duplicate exact request and conflicting reuse;
- private evidence or receipt tampering;
- expired evidence;
- out-of-order transition or wrong predecessor;
- execute disabled;
- wrong UUID, target fingerprint, maintenance window, protection point, or
  dangerous-action confirmation;
- rollback failure and recovery-required blocking;
- storage/disk/process/update/save/switch Shadow fault adapters; and
- six-hour soak virtual-clock fast-forward with sequence and coverage checks.

The v2 child additionally covers its separate protocol and confirmation,
production-default-off behavior, preview digest immutability, exact host/action
binding, persistent create-new intents and receipts, request collision and
idempotent replay, exact-PID isolation, bounded SMB restoration, exact disk-file
cleanup, hard-exit inspection-only resume, timeout compensation,
recovery-required latching, broad-target rejection, and unchanged unrelated
process/volume/network/save counters. Its summary must state
`productionBackendInvoked: false` and every production side-effect flag false.

The same parent test invokes the orchestration v2 protected-receipt matrix in a
separate marked temporary root. It covers all 11 evidence-action adapters, exact schemas and
contract, duplicate JSON-key rejection, preview/`-WhatIf` zero-write, default-off consume,
source-byte rehash, HMAC and subject-binding tampering, stale-completion
relabeling, rollback binding, the 15-second six-hour/72-hour sample and gap
minimums, incomplete or failed 12-event External Join observation rejection, request collision,
evidence replay protection, immutable replay, and explicit hard-exit intent
resume. The fixture key resolver is isolated from
the production environment gate; no service, task, network, save, or lower
transaction is invoked.

The final virtual-clock assertion uses clock class `shadow-virtual`. It may set
`durationSatisfied: true` after the simulated six-hour advance, but it must also
set `productionQualified: false`, `virtualClockOnly: true`, and
`productionChanged: false`. Only clock class `real-monotonic` with at least
21,600 seconds can set `productionQualified: true`. Do not copy a Shadow receipt
into a private production bundle or change its scope label.

Also run the repository PowerShell parser, the qualification self-test, Git
whitespace check, and the existing sensitive-data scanner required by the parent
release workflow. Those checks verify this implementation and its public-output
boundary; none performs or substitutes for a real qualification step.

## Evidence closeout

After the real run, the evidence custodian must:

1. verify every step's private bundle and receipt chain from the frozen plan;
2. confirm that the exact subject commit and runtime-payload SHA-256 match the
   candidate actually observed;
3. reject any expired, wrong-scope, Shadow, partial, tampered, unsealed, or
   identity-mismatched evidence;
4. verify that every requirement cites enough real steps at its required scope;
5. generate repository-safe evidence indexes with the existing evidence tools,
   never by hand-copying private output;
6. review the indexes for the public field allowlist and scan for paths,
   addresses, domains, players, saves, logs, and credentials; and
7. run the final acceptance gate against the exact final release commit and
   artifact manifest.

Any application, dependency, Windows script, package, configuration template,
or runtime-payload change after the run invalidates the candidate binding and
requires a new production run. A documentation-only statement cannot preserve
evidence across runtime drift.

## Repository integration completed

The bounded repository integration now:

- exposes `qualification:selftest` and includes it in the root `check` while
  preserving the v1 Shadow-only and combined zero-production-mutation guards;
- links this runbook from `README.md`, `docs/ACCEPTANCE.md`,
  `docs/PERFORMANCE.md`, `docs/NETWORK-CONNECTIVITY.md`, and the Windows
  deployment guide;
- records both protocol versions, the v1 plan/executor/Shadow adapter, the v2
  fixed production-capable/fake adapters and schemas, both self-tests, and this runbook as repository
  implementation evidence in `acceptance/manifest.json`, while all nine
  production qualification requirements remain `not-started`;
  and
- keeps the qualification harness repository-only and outside the runtime
  release artifact. Requirement states may change only after exact-scope private
  evidence and bounded public indexes exist.

Those integrations are not authorization to deploy, switch, remove, reboot,
interrupt storage, create disk pressure, crash DSP, restore a save, or change a
production route.
