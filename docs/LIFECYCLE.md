# Lifecycle safety contract

Dyson Control treats save, graceful stop, and restart as separate durable
lifecycle transactions. The repository contains a read-only preview API, the
transaction coordinator, and an opt-in Windows execution adapter. The default
runtime adapter is still **execution-disabled**, so a normal checkout can be
exercised and audited without changing a process, scheduled task, save, backup,
or configuration. Target-host mutation exists only when the Windows provider
is selected and `DYSON_LIFECYCLE_ENABLED=true` is supplied together with the
absolute bridge-control, secret-file, stable runtime-bootstrap, protected
lifecycle-broker profile, and exact interactive service-account bindings. The
API remains a nonprivileged service. It can submit only four fixed capabilities
to a protected SYSTEM broker, and that broker can trigger only the two pinned
interactive game tasks. Omitting or drifting any boundary fails closed during
configuration, startup validation, or preflight.

## API contract

Authenticated operators can submit exactly one of these actions to the
lifecycle APIs:

- `save`
- `start`
- `graceful-stop`
- `restart`

`POST /api/v1/actions/lifecycle/preview` accepts the strict body
`{ "action": "..." }`. A successful response contains both the completed
preview job and a validated `LifecyclePreview` object. Provider failures return
a generic error; raw paths, task names, command lines, logs, and exception text
are not returned to the browser.

`POST /api/v1/actions/lifecycle/execute` accepts only `action`, a bounded
`idempotencyKey`, and the exact confirmation token `EXECUTE`. A new request is
queued with HTTP 202. Repeating the same idempotency key returns the original
transaction with HTTP 200 and never repeats its phases. Reusing that key for a
different action is rejected with HTTP 409. Operators poll
`GET /api/v1/lifecycle/:id` for the durable job, run, protection-point reference,
recovery flag, and ordered phase receipts.

With the default disabled adapter, every preview has these invariant fields:

- `mode` is `dry-run`;
- `allowed` is `false`;
- `executionEnabled` is `false`;
- `execution-disabled` is present in `blockers`;
- `checks` contains only the documented fixed IDs;
- `rollback` describes the required recovery strategy without mutating data.

When the opt-in Windows adapter is configured, preview is still read-only. It
can report `allowed=true` and `executionEnabled=true` only when the fixed SYSTEM
broker validates the task definitions and authoritative runtime/session state,
the fixed host collector has no remaining data blockers, a fresh signed
game-bridge heartbeat is valid when required, a verified rollback baseline
exists, and the global execution lock is available.
The browser then requires a separate explicit confirmation before submitting an
execution request.

The API job is marked `succeeded` when evidence collection succeeds even if the
preview has blockers. A blocker is a valid safety result, not a collector
failure.

## Durable transaction coordinator

Lifecycle state is persisted in SQLite before work begins:

- `lifecycle_runs` owns the request ID, idempotency key, current phase,
  protection-point reference, terminal state, and recovery-required flag;
- `lifecycle_receipts` records every phase start and terminal result in order;
- `lifecycle_locks` provides one cross-process global mutation lease;
- the existing `jobs` row provides the operator-facing audit summary.

The fixed phase order is:

```text
lock -> preflight -> protection-point -> save
     -> [stop -> verify-stopped]
     -> [start -> verify-running]
```

The bracketed stop phases apply to graceful stop and restart; the start phases
apply to restart. If a restart fails after stop may have occurred, the
coordinator requests `rollback-start` and then performs another
`verify-running`. Every adapter call receives the same request ID, an optional
opaque protection-point ID, a bounded timeout, and an abort signal.

On control-plane startup, queued or running lifecycle rows are reconciled to
the explicit `interrupted` state. Any open phase receives a
`CONTROL_PLANE_RESTARTED` receipt, the job becomes failed with
`LIFECYCLE_INTERRUPTED`, the lock is released, and no unsafe phase is replayed
automatically. The operator must inspect the recovery-required flag before a
new transaction.

## Autonomous start and crash recovery

The installed game task runs the stable bootstrap wrapper in the dedicated
interactive Steam session. It has one exact `AtLogOn` trigger with a bounded
delay, `IgnoreNew` duplicate suppression, no execution-time limit, and a pinned
three-attempt/one-minute Task Scheduler restart policy. `StartWhenAvailable`
is required. The protected broker hashes this complete descriptor—including
the restart settings—so removing or weakening crash recovery makes lifecycle
status unverifiable and blocks dispatch. The stop task has no trigger and no
restart policy, preventing an intentional graceful stop from starting the game
again.

The wrapper remains attached to the managed DSP process. A zero process exit is
clean only when the controlled stable `Stop-DysonServer.ps1` path has published
and completed a matching `DYSON_CONTROL_GAME_EXPECTED_EXIT_V1` intent. The stop
wrapper first creates the `requested` record bound to the exact lifecycle
binding ID, immutable version, project-root SHA-256, and data-root identity. It
then invokes that binding's pinned release stop script. Only after the pinned
stop succeeds does it transition the same record to `completed`. Repeating the
same bound request is idempotent; a different or partially matching record is a
conflict.

The `requested` to `completed` transition uses canonical JSON, verified ACL
intent, a same-directory pending file, atomic replacement, and fixed recovery
and rollback-discard artifacts. Startup reconciles only the byte-, ACL-, and
binding-exact crash states defined by that protocol. An unknown, redirected,
malformed, multiple, or cross-binding expected-exit artifact fails closed and
is preserved for investigation. A new start also reconciles any prior durable
game binding through its pinned old-release stop script before resolving the
current active release.

ACL equivalence is evaluated from the owner SID, primary-group SID, protected
DACL state, and the binary DACL ACE sequence. Windows may normalize only the
`SE_DACL_AUTO_INHERITED` bookkeeping flag during an atomic replacement; that
metadata-only normalization is accepted when all effective and inheritable
permissions remain byte-equivalent. Any owner, group, protection, ACE, or
permission drift still fails closed.

After the managed process returns zero, the attached start wrapper consumes
exactly one matching `completed` intent before returning zero. A missing intent,
a still-`requested` intent, or any field/ACL/recovery mismatch is classified as
`BOOTSTRAP_UNEXPECTED_CLEAN_EXIT`; the wrapper records an abnormal failure when
possible and returns one so Task Scheduler can perform the bounded retry. A
non-zero managed-process exit likewise returns one. Before returning, the
wrapper atomically writes an append-only
`DYSON_CONTROL_GAME_RUNTIME_RECEIPT_V1` record beneath the selected private data
root. Each record is keyed by a new canonical attempt ID and binds the immutable
release version, lifecycle binding ID, project-root identity hash, data-root
identity hash, publication timestamp, terminal outcome, restart expectation,
and receipt SHA-256. It never contains a host path, log text, command line,
player data, or secret.

If a receipt for an already validated intentional clean stop cannot be
persisted, the wrapper reports `receiptPersisted=false` but still returns zero:
an evidence-storage failure after consuming the completed intent must not turn
that stop into an automatic game restart. Conversely, an abnormal exit still
returns non-zero even when its receipt cannot be written, preserving the
bounded recovery attempt while status and acceptance continue to treat the
missing receipt as unverified evidence.

During manual recovery, keep both game tasks and the managed process quiesced
and preserve the binding plus the canonical, pending, recovery, and
rollback-discard expected-exit files. Do not delete, rename, or edit one to make
startup pass. Resume only through the fixed bootstrap recovery path with the
same exact binding and request; if the state cannot be reconciled unambiguously,
leave it fail closed and retain the private artifacts for review.

This repository proof covers real child-process non-zero and unexpected-zero
exits, the crash-safe expected-exit matrix, and the next wrapper invocation in
the Windows PowerShell 5.1 shadow fixture. Production acceptance still requires
an approved DSP process interruption on the target Windows host,
observation of the Task Scheduler retry, a new durable crash receipt, verified
port/process recovery, and a successful client rejoin. A descriptor or unit
test is not production recovery evidence.

## Evidence checks

| Check ID | Evidence collected |
| --- | --- |
| `project-root` | The configured project root resolves. |
| `managed-process` | The PID resolves to the exact managed DSP executable. |
| `pid-file` | The managed PID file points to a live process. |
| `save-pair` | A matching `.dsv` and `.server` pair exists. |
| `backup-pair` | The latest paired backup matches its schema-v1 SHA-256 manifest. |
| `server-task` | The fixed start task exists when restart needs it. |
| `stop-task` | The fixed graceful-stop task exists when stop is needed. |
| `stop-task-principal` | The stop task is interactive and matches the game process owner. |
| `stop-task-action` | The task invokes the exact stable bootstrap wrapper and fixed project root. |
| `stop-task-result` | The previous stop task returned zero. This is supporting evidence only. |
| `task-history` | Task Scheduler operational history is available; absence is a warning. |
| `receipt-channel` | The stop adapter declares the versioned durable receipt protocol. |
| `save-trigger` | A separate, verifiable save acknowledgement exists. |
| `interactive-session` | Exactly one interactive session is bound to the configured game account. |
| `steam-session` | Steam is verified in the same interactive session when start is required. |
| `lifecycle-broker` | The protected profile, dependencies, task definitions, and durable broker channel validate. |
| `execution-lock` | The global lifecycle execution gate is available; an active transaction blocks a new preview. |

Check status is one of `pass`, `warning`, `block`, or `not-applicable`. The UI
maps IDs and statuses to localized labels and does not render host-provided
diagnostic text.

## Blocker codes

Blockers are stable machine-readable reasons. They currently include:

- project/process identity: `project-root-unavailable`,
  `managed-process-unverified`, `pid-file-unverified`;
- data recovery: `save-pair-incomplete`, `backup-pair-unverified`;
- task chain: `server-task-missing`, `stop-task-missing`,
  `stop-task-principal-mismatch`, `stop-task-not-interactive`,
  `stop-task-action-unallowlisted`, `stop-task-last-result-failed`;
- proof of completion: `receipt-channel-missing`,
  `save-trigger-unverified`;
- broker/session authority: `interactive-session-missing`,
  `interactive-session-ambiguous`, `steam-session-missing`,
  `task-definition-mismatch`, `runtime-state-mismatch`,
  `lifecycle-broker-unavailable`;
- execution gate: `execution-disabled`, `execution-lock-busy`.

No UI state, process presence, task state, or previous zero exit code can remove
a blocker by inference.

## Rollback strategies

- `save` requires a fresh paired-save backup before activation. The preview can
  prove that an existing hash-verified baseline is available, but the eventual
  transaction must create its own fresh rollback point.
- `graceful-stop` uses `restart-from-same-save`; it must preserve the verified
  pair unchanged.
- `restart` uses `paired-save-backup`; the stop and start phases share one
  transaction and rollback reference.

The backup verifier requires schema version 1, one `.dsv`, one matching
`.server`, exact byte lengths, and matching SHA-256 hashes. Missing, malformed,
or tampered manifests fail closed.

The repository also contains authenticated paired-save backup, retention,
transfer, quarantine-promotion, restore-preview, and restore execution routes.
They share the global host-mutation coordinator and preserve `.dsv` plus
`.server` as one unit, but production mutation remains fail-closed until the
Windows provider and execution gates are explicitly enabled. See
[SAVES.md](SAVES.md) for the exact confirmation, protection, and recovery
contracts.

## Windows broker deployment and removal

The public release does not bundle Node. Windows deployment requires an
independently provisioned Node.js 24-or-newer runtime under a dedicated
`-RuntimeRoot`, outside both `InstallRoot` and `DataRoot`, plus the exact
`-NodeExecutable` below it and independently authenticated
`-ExpectedNodeSha256`. A game panel's or game manager's embedded runtime is not
a deployment prerequisite and must not be reused implicitly. The runtime root,
path chain, file type, SHA-256, owner, and protected DACL are checked before
installation, task registration, every launch, status/readiness observation,
reboot checkpoint/resume, and uninstall. Runtime evidence is bound into those
receipts and task arguments, not exported to the API as an unknown `DYSON_*`
configuration key.
The top-level installer also requires `-ExpectedArtifactPayloadSha256` copied
from independently authenticated release provenance. Trusted deployment code
recomputes and binds the source manifest/inventory to that digest and never
executes a verifier or common script from the selected source directory,
including during `-WhatIf`.

Lifecycle-broker installation is opt-in through the top-level
`Install-DysonControl.ps1` entry point. The exact lifecycle parameters are:

- `-InstallLifecycleBrokerTask`;
- `-ProjectRoot`, `-RuntimeBootstrapRoot`, `-ServiceUser`, `-GamePort`, and
  `-DispatchReadyTimeout` (5 through 60 seconds);
- `-ConfigurationSource`, `-RegisterStartupTask`, `-StartAfterInstall`, and a
  loopback `-ReadinessUri`;
- `-UpgradeLifecycleBrokerExisting` only for an existing broker that must move
  to a different immutable release.

`RuntimeBootstrapRoot` must equal `<InstallRoot>\bootstrap`. The configuration
source must explicitly set `DYSON_PROVIDER=windows`,
`DYSON_LIFECYCLE_ENABLED=true`, and bind `DYSON_PROJECT_ROOT`,
`DYSON_DATA_DIR`, `DYSON_LIFECYCLE_BROKER_PROFILE_FILE`,
`DYSON_RUNTIME_BOOTSTRAP_ROOT`, `DYSON_RUNTIME_SERVICE_USER`,
`DYSON_GAME_PORT`, `DYSON_SERVER_TASK`, and `DYSON_STOP_TASK` to the same values
used by the installer. `DYSON_DATA_DIR` is exactly `<DataRoot>\data`; the profile
is exactly `<DataRoot>\data\lifecycle-broker\broker-profile.json`; and the two
task variables must name the fixed runtime task pair.

For a fictional custom deployment, those roots may be
`C:\GameServer\Example\DysonControl`,
`C:\GameServer\Example\DysonControlData`, and
`C:\GameServer\Example\DSP`, with
`C:\GameServer\Example\DysonControlRuntime` as the separately installed runtime
root. `Install-DysonNodeRuntime.ps1` can publish an independently authenticated
ZIP through same-volume stage/rename and rollback; control-plane uninstall
preserves that runtime by default. No real host path, account, endpoint, port,
task export, or secret belongs in this repository.

The protected lifecycle profile pins the active release's `scripts\windows`
directory and its exact `lifecycle-broker` child, project/data/bootstrap roots,
service user, game port, fixed server/stop tasks, and dependency hashes. Its
worker task is fixed to SYSTEM with `ServiceAccount` logon, highest run level,
no trigger, `IgnoreNew`, a five-minute execution limit, and one profile-bound
PowerShell action. The profile file/ACL and task/task DACL are part of the
installation preimage and rollback contract.

Cutover installation is rejected unless `-InstallCutoverBrokerTask` is combined
with `-InstallLifecycleBrokerTask` in the same call. Its exact additional inputs
are `-CutoverProjectRoot`, `-CutoverAuthorityProfileFile`,
`-CutoverAuthorityInventoryRevision`, `-CutoverRuntimeTaskTransactionRoot`,
`-CutoverServiceUser`, `-CutoverGamePort`, and
`-CutoverRuntimeBootstrapRoot`; a cross-release change also needs
`-UpgradeCutoverBrokerExisting`. Project, bootstrap, service-user, and game-port
values must equal the lifecycle values. The environment must enable
`DYSON_CUTOVER_ENABLED=true` and `DYSON_CUTOVER_RECOVERY_ENABLED=true` and bind
the same authority profile, transaction root, account, and port.

`-WhatIf` validates these complete bindings and reports the requested install,
upgrade, or reuse modes without running Node, registering tasks, publishing
profiles, starting the control task, or polling readiness. A real operation has
this strict order:

```text
release + bootstrap + configuration + control task
  -> lifecycle broker
  -> cutover broker (when requested)
  -> control-task start + exact-version readiness
```

The final readiness check requires `lifecycleBroker`; a cutover transaction also
requires `cutoverRecovery`. Same-release lifecycle reuse returns `reused`, proves
the preimage stayed exact, and is never compensated. A cross-release lifecycle
change must have `-UpgradeLifecycleBrokerExisting` or the transaction fails
closed.

If anything after a first lifecycle installation fails, the deployment invokes
that active candidate release's lifecycle installer with
`-CompensateFirstInstall`. It removes only the new fixed profile and worker task
and preserves durable requests and receipts. If a cross-release upgrade later
fails, the deployment first removes the replacement control task and restores
the old active release, bootstrap, configuration, and data ACL. Only then does it
invoke the **old release's** lifecycle installer with `-UpgradeExisting`, restore
the old profile bytes/profile ACL and task XML/enabled state/task DACL, and prove
the old preimage exact. Deferred cutover restoration follows lifecycle; the old
control task is restored last.

Normal control-plane uninstall captures the lifecycle profile hash and calls the
active release installer with `-RemoveCurrent -ExpectedProfileHash <sha256>`.
`ExpectedProfileHash` is mandatory for that mode, forbidden outside it, and
`RemoveCurrent` is mutually exclusive with `UpgradeExisting` and
`CompensateFirstInstall`. Before mutation, removal requires the same-release
profile, pinned dependencies, fixed runtime-task pair, profile ACL, worker task
and task DACL, closed request/receipt pairs, an empty intent directory, and no
orphaned or unknown broker state. It removes only the fixed profile and worker
task and returns a bounded
`DYSON_CONTROL_LIFECYCLE_BROKER_REMOVAL_RECEIPT_V1`. Requests, receipts, empty
intent storage, audits, recovery sentinels, and other DataRoot evidence remain.
`-RemoveData` is rejected while retained lifecycle/cutover/authority evidence
exists.

Control-plane uninstall validates both broker preimages before any mutation. It
then stops and removes the control task first to quiesce the request entry point,
removes the dependent cutover broker with `RemoveCurrent`, removes lifecycle with
`-RemoveCurrent -ExpectedProfileHash`, and only then moves the release or performs
explicitly approved data removal. Quiescing the request entry point is not a
reversal of broker dependency order: cutover is still removed before lifecycle;
the early control-task step only prevents new work from arriving during teardown.
If any later step fails, rollback restores release and active-pointer state first,
then lifecycle, then cutover, and restores the exact prior control task last.

`Test-DysonControlDeployment.ps1` performs the read-only static lifecycle check:
an enabled broker must be bound to the active release, environment, dependencies,
runtime tasks, worker task, and clean channel; a disabled configuration must have
no residual broker state. With `-ReadinessUri`, status additionally requires
`lifecycleBroker` and `cutoverRecovery`. Reboot checkpoint creation and resume
are stricter: they require static lifecycle state `ready` and both deep readiness
checks before accepting either side of the reboot. The repository-only gates are
`npm run lifecycle:broker-selftest`, `npm run deployment:status-selftest`, and
`npm run deployment:reboot-selftest`; none is evidence of a real host change.

## Signed save bridge candidate

The repository now contains a disabled-by-default
[`DysonControlBridge`](../integrations/dyson-control-bridge/README.md) candidate
and a TypeScript file-protocol client. The bridge does not listen on a network
socket. It accepts exactly one HMAC-authenticated action, `save`, through an
atomic local request file and always saves to Nebula's fixed `_lastexit_` slot.

The game-side plugin runs the save call on Unity's main thread and emits a
signed durable receipt only after `GameSave.SaveCurrentGame` succeeds,
Nebula's `GameStatesManager.LastSaveTime` advances, and the matching `.dsv` and
`.server` fingerprints remain stable for the configured window. The C# and
TypeScript implementations share fixed protocol vectors, signature-tamper
tests, strict field ordering, bounded files, request expiry, cooldown,
interrupted-request reconciliation, and a signed two-second plugin heartbeat.

The Windows lifecycle adapter now has fixed implementations for protection
point creation and bridge save. Scheduled stop/start dispatch and independent
runtime verification are performed only through the fixed SYSTEM lifecycle
broker; the API no longer invokes the task dispatcher or privileged runtime
probe directly. Broker requests, intents, and receipts are durable,
fingerprint-bound, bounded, and idempotent. Its paired-save protection script copies into a private
same-volume staging directory, compares source fingerprints before and after
the copy, verifies destination hashes, writes a schema-v1 manifest, and only
then publishes the directory atomically. The same request ID re-verifies and
reuses the original protection point; a modified copy fails validation.
`New-DysonSaveProtectionPoint.ps1` is itself a `SupportsShouldProcess` entry
point. `-WhatIf` validates the source pair and any existing final or stale
staging identity without creating the backup root, deleting stale staging,
moving a directory, or writing a file. It emits exactly one redacted,
timestamp-free `DYSON_CONTROL_PROTECTION_V1` preview receipt with
`dryRun=true` and `mutationPerformed=false`. The lifecycle provider accepts
only the distinct successful execution receipt (`dryRun=false`, a verified
manifest, and mutation semantics consistent with `reused`). The unattended
provider reaches that entry point only after the authenticated lifecycle
preview and durable host-mutation lock have passed; an interactive operator can
still request the common `-Confirm` prompt explicitly.

This is implementation evidence, not production verification. The execution
HTTP route feeds the durable coordinator, and the Windows mutation adapter is
constructed only when the lifecycle gate, protected broker profile, fixed
service account, runtime bootstrap, and host bindings all validate. Repository
defaults still use the non-mutating demo provider, and the Bridge is neither
installed nor enabled by default. A Windows save/stop/restart preflight reports
`save-trigger-unverified` until a current signed Bridge heartbeat is verified;
start additionally requires one bound interactive game session and Steam in
that same session.

## Requirements before production cutover

The repository implementation is not, by itself, production verification.
Before enabling target-host lifecycle mutation, the release manifest still
requires all of the following on the target Windows host:

1. install the version-pinned API, web bundle, bridge plugin, and fixed Windows
   scripts through the reviewed deployment package;
2. create the interactive start and graceful-stop scheduled tasks for the same
   Windows account that owns the Steam/DSP process, install the protected SYSTEM
   lifecycle broker, then verify task definitions, DACLs, hashes, principal,
   action, session binding, and durable receipts;
3. verify a fresh signed heartbeat and a controlled save acknowledgement against
   a disposable paired save before any live save is used;
4. exercise save, graceful stop, restart, failed-start rollback, timeout,
   interrupted-control-plane reconciliation, and tampered/partial save cases;
5. independently verify the protection-point manifest and restore rehearsal;
6. record the exact production configuration and then explicitly enable
   `DYSON_LIFECYCLE_ENABLED=true` during the announced maintenance window.

Until these host gates pass, the production configuration must keep lifecycle
execution disabled. Conservative capability flags in the overview remain false;
the game-management workspace uses the per-action preview result as its only
execution gate.
