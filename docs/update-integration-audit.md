# Update integration audit

Status: consolidated implementation and targeted local/Windows fixture validation
are in progress. The native package and full installer self-tests have passed;
real DSP update/rollback acceptance is still outstanding. The findings below
record the original defects; dated follow-ups retain investigation history.
They must not be read as a current claim that every original defect still exists.
No claim is made that all project defects have been discovered.

Current release gates:

- U01-U09: implementation and composed tests exist; prove final-save capture,
  candidate startup and predecessor health with the real installed bootstrap,
  broker and game in one native component update/rollback exercise.
- U10-U11: copy/intent interruptions recover in fixture tests on Windows;
  verify real broker/process interruption and the saved-request UI recovery flow.
- U12: SQLite attempt auditing and restart interruption handling are implemented;
  finish durable transaction/audit identity linkage and real crash evidence.
- Verify the sidebar accessibility fix in the IAB tree with the final web build.
- Review retained rollback material capacity/cleanup, then complete exact-source
  incremental checks, public hygiene, exact-commit CI and release provenance.

Package/installer self-tests use fictional payloads and isolated temporary roots.
Their success does not constitute a new live installation, a real DSP update,
an external player join, GSManager removal or whole-project completion.

## Confirmed findings

| ID | Boundary and evidence | Effect | Required validation |
| --- | --- | --- | --- |
| U01 | `WindowsLifecycleAdapter.#verifyRuntime` emits `lifecycleState`; update stopped/running strict schemas omit it. | Valid native stopped proof is rejected before publication; running proof would also be rejected. | Compose both real adapters; accept verified states and reject contradictory, absent or unknown evidence. |
| U02 | Lifecycle protection emits `sourcePairVerified` and `mutationPerformed`; update protection schema omits them. | Real paired-save protection result cannot cross the update boundary. | Real lifecycle runner result through update adapter; enforce pair proof and mutation/reuse consistency. |
| U03 | Lifecycle task dispatch emits `dispatched`, `recovered`, `taskName`, `readyVerified`; update schemas expect `outcome` and `processVerified`. | Candidate startup, smoke cleanup and Steam handoff cannot consume actual dispatch results. | Use real lifecycle adapter and fixed broker boundary; distinguish dispatch acceptance from independent process/port proof. |
| U04 | Update `createLifecycleContext` omits `hostMutation`; real lifecycle task dispatch requires it. | Mutating broker dispatch is rejected even after result schemas are corrected. | Assert the original active scope reaches broker and script borrowing; reject lost lease and propagate cancellation. |
| U05 | `verifyStoppedState` uses the original request UUID for both `before-protection` and `before-publish`; only `jobId` contains the phase. Lifecycle verify derives broker identity from UUID and expected state. The submit script returns an existing receipt immediately. | A later check can reuse an earlier successful observation instead of proving current stopped state. This also needs examination across recovery calls. | Successful stopped observation, intervening running state, second observation must fail; read observations must be fresh while mutation dispatch remains idempotent. |
| U06 | Lifecycle runtime verification retries state mismatch until its signal aborts. Update smoke creates an abort controller without a phase deadline. Host lease cancellation represents lost ownership, not an operation deadline. | A game that never reaches expected state can keep update verification and its lease pending indefinitely. | Deterministic startup and stop deadlines; never-starting game, stuck stop, cancellation and bounded cleanup under a still-valid lease. |
| U07 | `Get-DysonStatus.ps1` maps the existing BepInEx target-version warning to `mod-bepinex-target-mismatch` and `compatible=false`. Update smoke requires zero warnings and compatibility for candidate and rollback alike. The retained predecessor emits that warning. | A byte-correct restoration of the accepted predecessor cannot pass the current rollback smoke predicate. Merely allowing its version in the compatibility matrix does not fix this. | Establish explicit predecessor health acceptance before maintenance; distinguish restored baseline from candidate acceptance without globally ignoring warnings or weakening exact-generation/save proof. |
| U08 | Full Bridge composition uses `LoadedSaveOriginTracker.TryMatchFiles`, which rejects metadata differing from the actual load. Protocol tests explicitly require a subsequent save not to become a loaded-generation proof. Transaction baseline nevertheless requires persisted loaded identity to equal the latest stopped fixed save. | After a legitimate final save changes the pair, baseline capture can reject the normal save-then-stop maintenance workflow. The standalone publisher's rehash behavior does not establish that the composed Bridge permits rebinding. | Introduce or consume a distinct signed final-save authority bound to the stopped generation and exact pair. Preserve actual-load proof semantics for post-update and rollback startup; do not label newly saved bytes as already loaded. Validate save, stop, final hash, restart and exact-load lineage end to end. |
| U09 | `TrustedCompatibilityService.assertCurrent` checks expiry before awaiting inventory and does not check it again before returning authorization. A deterministic test advances the injected clock during inventory collection and receives success after expiry. | Slow authoritative collection extends the effective validity of an expired receipt. | Reject expiry at the final authorization boundary, including exact expiry time; retain inventory and policy drift rejection. |

The earlier incomplete adapter edit was saved outside the repository and the
runtime source restored to the published baseline before reproducing failures.
`windows-update-lifecycle-composition.test.ts` currently has four intentionally
failing acceptance regressions on that baseline: stopped proof, real protection
result/lease forwarding, real stop dispatch, and independent repeated-observation
freshness. The last test bypasses the mismatched update schema by exercising the
real lifecycle adapter directly: two read observations currently reuse one ID,
while repeated stop dispatch correctly preserves its mutation ID. These are not
passing release evidence.

## Remaining investigation before the batch is closed

| Area | Current evidence | Remaining proof |
| --- | --- | --- |
| Candidate acquisition/preparation | Exact prepared archive was re-read before native preview. | Expiry/revocation between preparation and publication; no raw-receipt activation route. |
| Authority and revision | Runtime layout binds receipt location and authority digest; production runtime evidence and compatibility inspection are bracketed by authority revalidation. Core activation rereads revision and compatibility before publication. U09 separately reproduces expiry during the compatibility read. | Changes during lease acquisition and recovery must reject, not silently refresh authority; test final clock boundary as well as entry checks. |
| Stopped baseline | Transaction provider compares persisted generation, latest runtime receipt and paired-save identity. Although the standalone publisher can rehash, the composed origin tracker pins actual-load metadata; U08 records the cross-layer conflict. | Real stop/save evidence composition and pending hash invalidation immediately before shutdown; inspect installed Bridge provenance separately before claiming every source behavior is present in an older deployed binary. |
| Configuration protection | Capture is followed by revision readback. | Real history provider composed under borrowed update lease, including interrupted capture and restore. |
| Save rollback | Exact protection manifest and pair identity are re-read; restore result is checked. Native protection script and reader agree on `DYSON_CONTROL_PROTECTION_V1`, `tx-<UUID>` directories, and the two-file manifest shape. | Faults between each file replacement and exact post-restore generation evidence; structural agreement alone does not prove restore execution. |
| Mod lock | Rollback only accepts unchanged lock; drift is explicitly unrestorable. | Verify component publication cannot touch independently managed plugin files; drift must preserve recovery state. |
| Startup/load readiness | Smoke currently samples load evidence immediately after process/port proof. | Determine whether real Bridge/log evidence can lag; bounded convergence without accepting stale generation. |
| Smoke cleanup | Cleanup uses the same operation controller as startup checks. | Timeout or cancellation must not prevent necessary cleanup; lost ownership must not permit further mutation. |
| Rollback and recovery | Durable core journals and separate recovery receipts exist. | Compose actual adapters for publication failure, process crash, exact prior-version restoration, replay and foreign state rejection. |
| Successful-update rollback | The component HTTP controller exposes activation and recovery, but no dedicated revert-successful-update operation; reconciliation returns for an existing terminal non-recovery receipt. | Design a revision-bound operator rollback using retained trusted baseline material, or prove an equivalent supported workflow including a previously unmanaged installation. Do not count automatic failure rollback as that capability. |
| Test fidelity | Existing update unit fixtures model a different lifecycle contract. | Keep real adapter composition at the integration boundary; fake only external broker/runner/Bridge I/O. |

## Validation and deployment gate

Audit checks executed: transaction provider (6 tests) and signed runtime evidence
reader (8 tests) pass on the published runtime source. They do not compose the
final-save/stop/Bridge origin transition. Acquisition and preparation suites
also pass 23 tests. The fixed SDK 8.0.424 was obtained from Microsoft's official
release metadata and its ZIP verified against the published SHA-512 in a private
tool directory. Bridge protocol self-tests then passed using that exact SDK;
`global.json` was not changed. In particular, those tests preserve actual-load
origin semantics rather than accepting later saved bytes as loaded evidence.

The fixed live publication suite also passes all 12 tests, including lease loss
at write boundaries and restart reconciliation. Its rollback implementation
requires a stopped proof before restoring files; this is a guard that exists,
not a missing check. The U05 freshness failure still applies to the production
callback supplying that proof.

Repository acceptance inventory remains 48 requirements: 39 `implemented`,
9 `not-started`, zero `verified`. These are registry states, not a claim that no
private production work exists. Reconcile private evidence before changing them.
The nine open entries cover production restore, side-by-side deployment, TLS,
game routing/bypass, external join, reboot/fault/soak, recovery package, cutover,
and removal. No update-only test batch satisfies these broader release gates.

## Consolidated implementation batch

Batch regression on the VM passes 164 tests across nine application/activation/
recovery/Steam-handoff suites. A subsequent retention change preserves committed
live journals and predecessor snapshots, while cleaning transient game-tree
siblings. Other journals are ignored as completed history only after a matching
committed receipt is verified; unresolved journals still block publication.
Thirteen live-deployment tests pass locally and on the VM, including unmanaged
predecessor retention across commit replay and a later update. The operator
rollback execution/API and retention cleanup contract are not yet implemented.

Committed rollback material now has a read-only inspection method. It requires
the matching successful receipt and current candidate state, verifies retained
predecessor bytes, and returns a digest of the exact journal plus bounded file
counts. A later update or tampered predecessor snapshot is rejected. The 13-case
live-deployment suite passes on the VM with these assertions. This is a material
preflight only; execution must revalidate it under a fresh stopped proof.

Explicit rollback journals can now carry a separate source-transaction/material
binding. Ordinary candidate reconciliation and failure rollback refuse such
journals instead of interpreting them as ordinary updates. Fourteen live-layer
tests pass locally and on the VM, including refusal without changing live bytes.
The dedicated writer/executor for these journals and its HTTP contract remain
unfinished; this guard does not itself perform an operator rollback.

The live-file layer now has `rollbackCommitted`: a separate request ID and
source/material binding, durable rollback journal before snapshot copying,
fresh stopped checks, original snapshot restoration, and a separate terminal
receipt. It preserves the source success receipt and source material. Sixteen
live-layer tests pass locally and on the VM, including interruption at a live
restore boundary and replay that preserves later edits. This is not the complete
operator workflow: top-level revision coordination, configuration/save protection,
health verification, HTTP/UI and complete interruption-matrix coverage remain.

The core service now exposes a read-only rollback plan for the latest successful
transaction at the exact current revision. It binds predecessor version, retained
live material, original rollback binding and protection point, then rereads the
whole active state to reject concurrent change. Older transactions and stale
revisions are rejected. The VM passes 66 core/live tests plus typechecking.
Execution coordination and validation of configuration/save material remain
required; a plan is not an executed rollback or complete recovery proof.

The rollback plan now requires the read-only configuration snapshot, protected
pair and mod-lock inspection, and binds the observed current configuration
revision into its digest. Missing inspection capability fails closed. Core and
HTTP regression suites pass 101 tests locally and on the VM with typechecking.
Top-level rollback mutation/recovery coordination is still pending.

U07 development: protected compatibility policies can now carry narrowly scoped
`rollbackWarningApprovals`, keyed by an existing matrix entry. The approvals
participate in policy revision normalization. The predicate accepts only the
explicit target-version warning for a matching rollback inventory and rejects
candidate/reconcile-candidate phases, missing authority and other warnings.
Runtime inspector/provider/smoke wiring is implemented in the development tree.
The inspector independently rechecks policy and inventory revisions plus the
expected restored component version; the app brackets it with authority checks.
Only rollback smoke with a loaded game and matching version may request this
approval. Candidate health and exact-generation/save proof remain unchanged.
Twenty-two inspector/adapter tests and typechecking pass locally and on the VM.
No live policy or installed control release was changed by this development work.

The user clarified that the target VM is not yet publicly serving players and
authorized direct integration, restart and fault tests there, including test
saves. Current save preservation is not a reason to defer those tests. Preserve
unrelated VM configuration and keep installation rollback available.

Initial implementation changes for U01-U05 and U09 are present in the development
tree. On the target Windows VM with Node 24.20.0, four selected suites pass 47
tests. They compose the real lifecycle/update adapters but mock external broker
and script boundaries; this is not yet a real task-dispatch/update acceptance
result. No versioned release was installed for this development run. Protection
scripts accept cancellation but no lease-borrow CLI arguments: the regression
checks their supported signal contract rather than inventing such arguments.

A subsequent native run compiled the development source on that VM and used
the real fixed PowerShell runner, lifecycle broker client, SYSTEM worker and
lifecycle adapter. Two consecutive running proofs returned verified process/
port state with distinct broker request IDs. The harness allowed only
`LifecycleVerify`; no task dispatch occurred. This verifies fresh native running
observations, not stopped-state transition, update publication or rollback.

Lifecycle phases now have an internal default ten-minute deadline (bounded
construction-time override), with cancellation acknowledgement awaited before
cleanup. The original lease remains separate from each phase signal. Composition
coverage proves a timed-out observation leaves a fresh cleanup phase available,
and later lease cancellation prevents another dispatch. The target VM passes
22 selected adapter/composition tests plus API typechecking for this change.
This covers lifecycle waiting, not yet bounded load-evidence convergence or a
real deliberately hung game process.

Load-evidence convergence now retries only an absent fixed evidence file,
distinguished from invalid bytes/HMAC/session/generation. The read-only evidence
wait has an internal two-minute default deadline and late completion cannot
authorize a timed-out request. Component smoke collects health after evidence
arrival. Tests cover delayed publication, immediate corruption rejection and a
never-completing read; native cross-runtime tests retain the C# vector source.
The live hung-game and real delayed-hash acceptance runs remain separate gates.

- Correct lifecycle result contracts and forward the original active lease for
  protection, task dispatch, Steam handoff, smoke and recovery (U01-U04).
- Generate fresh observation identities independently from idempotent task
  dispatch identities; test repeated success and restart recovery (U05).
- Bound startup, load-evidence convergence and stop phases. A phase timeout may
  permit bounded cleanup under the still-valid lease; lease loss never does
  (U06 and cleanup/load-readiness review rows).
- Model accepted predecessor health separately from candidate health without
  suppressing all warnings. Bind any accepted baseline conditions to protected
  authority and exact rollback material (U07).
- Bind a distinct final-save proof to clean stop and exact backup bytes; retain
  actual-load evidence for candidate/rollback startup validation (U08).
- Revalidate compatibility expiry after asynchronous inventory collection (U09).
- Add a supported, revision-bound rollback of a successful component update,
  including the first update of an unmanaged installation. Existing recovery
  endpoints must not be repurposed to fabricate an interrupted transaction.

Do not package each item separately. The corrected composition, interruption,
cleanup and replay tests are the gate for one reviewed release candidate.

1. Reproduce each confirmed finding and investigate the remaining rows with
   bounded tests or read-only native evidence. Record exclusions explicitly.
2. Batch implementation changes and update the incremental impact mapping.
3. Run affected lifecycle, update, Steam handoff, recovery and production
   assembly checks, API typechecking and required native contract checks.
4. Only then build one versioned candidate, validate exact-commit CI and public
   artifacts, and perform native update/rollback acceptance with recovery ready.

This audit does not claim every project requirement or production gate is met.

### Remaining interruption findings from source review

- U10 (release blocker): `rollbackCommitted` copies each predecessor snapshot
  directly to its final transaction backup filename. `copyStableFile` preserves
  a partial destination on lease loss; retry sees that destination and rejects
  its digest as `UPDATE_LIVE_ROLLBACK_MATERIAL_INVALID`. Thus loss after creating
  the destination but before completing its bytes cannot currently converge.
  The existing restore-boundary test loses the lease after live bytes have been
  restored and does not cover this earlier boundary. Repair must publish verified
  snapshot bytes atomically from a transaction-owned temporary file, handle
  interrupted temporary copies under a renewed lease, and continue to reject
  tampered published snapshots. Add interruption tests at destination creation,
  mid-copy, post-sync/pre-publication and post-publication before native release.
- U11 (release blocker): `FileOperatorRollbackStore.begin` creates the request
  directory before publishing its first intent. A crash between those steps
  leaves `pending()` throwing `UPDATE_ROLLBACK_STORE_INCOMPLETE_INTENT`, while
  there is no published request/plan for the recovery endpoint to consume.
  Design an atomic intent-directory publication or a strictly bound incomplete
  intent recovery path; an empty directory must not silently mean idle.

The ordinary activation recovery entry now checks operator rollback idleness
before evidence processing and again inside the recovery lock. Its pending
operator rollback regression passes within the 52-test activation suite.
These findings remain open; this batch is not release qualified.

U10 implementation follow-up: rollback snapshots now copy into the fixed
transaction-owned `.copying` sibling and rename only after full digest validation.
Retry removes only a normal, single-link unpublished temporary file under the
active lease; published snapshot digest mismatches still reject. Fault tests at
0, 1 MiB and 2 MiB of a 2 MiB snapshot now resume with a fresh service instance.
The 19-test live deployment suite and API typecheck pass. A source handle leak
when destination creation loses its lease was also corrected; the repeated suite
no longer emits the FileHandle garbage-collection warning. Native VM interruption
acceptance and U11 remain pending before release qualification.

U11 partial implementation: explicit recovery under the request-bound recovery
lease can validate and publish a single complete canonical first-intent temporary
record. It checks the checkpoint schema, plan digest, request ID and prepared
phase before publication. Fresh-store interruption/replay tests pass, along with
the coordinator suite (11 tests) and API typecheck. Recovery errors now retain
the recovery disposition even if reading or publishing the intent failed.
Empty directories, partial bytes and multiple ambiguous temporary files remain
fail-closed and unresolved. U11 is not closed; do not release this batch yet.

U11 engine follow-up: under the exact request-bound recovery lease, an unpublished
initial intent can now be rebuilt after a fresh preview matches every submitted
request field and its original plan hash. Rebuild requires the existing canonical
request directory, no published checkpoint, and only normal single-link owned
temporary files. The directory remains present through cleanup/republication so
another interruption can retry. Published checkpoint validation is unchanged.
Fresh coordinator tests cover empty and partial first-intent directories, reject
a changed plan before protection or restore, then recover the original request.
The 13 store/coordinator tests and API typecheck pass. Native VM acceptance,
recovery UI access when pending enumeration reports incomplete intent, and the
pre-directory lease-loss case still require verification before U11 is closed.

Native Windows follow-up: the four affected suites ran in the Dyson VM
integration workspace against the synchronized seven source files. Initial run:
81 passed, 3 failed with the default per-test timeout. Focused rerun using the
batch's already prescribed 30-second timeout passed all three copy interruptions
(7.36, 7.69, 7.65 seconds). These tests use temporary fixture files and simulated
lease-loss scopes on the real VM filesystem, not the live DSP save or actual
broker crash. Private JSON reports and source hashes are retained outside Git.
The real-game/bootstrap/broker interruption gate remains distinct and pending.

U11 pre-directory follow-up: after the same request-bound recovery lease and
exact fresh plan verification, rebuilding now also creates an absent store/request
directory. The tests cover absent, empty and partially written intent states,
changed-plan rejection before game actions, and preservation of foreign entries
and external hardlinked files. All 15 store/coordinator tests pass locally and
on the Dyson VM with the synchronized current sources. Recovery UI access and
real broker/game fault acceptance remain open.

U11 UI follow-up: the panel retains the full validated request (UUIDs and hashes
only) in session storage before submission. On an incomplete-state response it
keeps new execution disabled but exposes an explicitly confirmed retry of that
saved request through the existing recovery endpoint. The server remains the
permission, configuration-gate and exact recovery-lease authority. Successful
receipt verification clears the saved request. The six focused frontend tests
and web typecheck pass; authenticated IAB rendering/interaction QA is pending.
Full deployment self-test remains running under the recorded SSH process handle;
do not redispatch based solely on an empty buffered log.

UI boundary follow-up: 23 tests across the operator panel, API client and existing
update workspace pass. Added cases reject malformed saved requests, deny a
read-only role, respect an explicitly closed recovery gate, and prove no automatic
submission during initialization. Web typecheck passes. These are rendered DOM
unit tests; authenticated IAB interaction and screenshot evidence remain pending.
The native full deployment self-test process remains live and responsive; its
output is buffered. Continue observing the original handle, not a duplicate run.

Initial-intent binding review: recovery first publishes a complete valid
unpublished intent and compares all original request fields. Only an empty or
syntactically incomplete temporary record falls through to fresh-plan rebuild.
A regression submits the same UUID with a different plan hash and verifies
request-conflict rejection before preview or game actions, retaining recovery.
All 15 affected tests and API typecheck pass. Native source sync must include
this follow-up before final acceptance; prior VM evidence is an older snapshot.

Current VM preparation: latest initial-intent binding sources pass all 15 focused
store/coordinator tests in `intent-binding-current-results.json`. Updated web
sources compile and Vite builds successfully; API TypeScript emit also succeeds
in the VM integration workspace. Vite retains its existing large-entry warning
(about 647 kB minified); build success is not runtime or performance acceptance.
The approved in-app browser surface is available. The full deployment self-test
continues on its original handle and has advanced into installer preview cases.
No candidate-panel task switch or production release was performed in this step.

Authenticated IAB check against the current VM development build: component
rollback panel rendered with real revision and admin session; the known failed
update request was rejected as a non-current successful rollback source. The
Chinese error and form layout were visually inspected; no console warnings or
errors were recorded. No rollback execution was submitted. Saved-request recovery
under a real incomplete transaction still requires end-to-end acceptance.
Browser inspection additionally found icon-only sidebar buttons have no accessible
names (their text is visually hidden from the accessibility tree). Track this
as an accessibility fix within the consolidated batch.

Sidebar accessibility follow-up: navigation buttons now expose their existing
Chinese labels through aria-label even in icon-only layouts, mark the current
page with aria-current, and hide decorative icons from assistive technology.
Web typecheck and all 26 incremental-runner tests pass. The exact App.tsx source
hash is added to the reviewed batch mapping. This is a targeted semantic change;
post-change IAB accessibility-tree verification remains pending with the next
consolidated UI validation session.

### U12: operator rollback audit identity gap

Source review confirms `OperatorRollbackReceipt` has no completed timestamp or
actor, and `/updates/rollback/execute` plus `/recovery` pass only request.body to
the controller. The authenticated request actor is not propagated into this
transaction's journal/receipt. Hash-linked checkpoints prove ordering and request
identity, but do not by themselves prove who acted or when. This is a release
blocker for the audit requirement. Bind the server-derived actor and durable
start/completion times without accepting client-supplied identity; preserve the
original initiator on retries and separately record recovery actors. Exercise
restart/replay and mismatched-actor input at the API boundary before release.
Do not label the current receipt chain as complete operator audit evidence.

U12 partial implementation: authenticated rollback execute/recovery routes now
write separate SQLite job audit attempts before invoking the transaction, using
the server request actor and validated request UUID. Start/finish timestamps and
outcome are recorded, and the jobs UI labels both action kinds. Eleven affected
API route/audit tests, seven jobs UI tests, and API/web typechecks pass. This is
attempt-level audit linkage, not yet immutable initiator metadata within the
rollback receipt. Crash reconciliation, original-initiator retention and durable
receipt/audit cross-check tests remain required before closing U12.

U12 HTTP readback evidence: route regression now retrieves the SQLite-backed jobs
API after a gated rejection and a successful recovery. Both rows carry the
server-authenticated Administrator actor, the same validated request UUID,
start/finish timestamps and appropriate outcomes. A forged body actor is rejected
with HTTP 400, never reaches recovery, and its audit row retains the authenticated
actor. Filtering by the new recovery job kind works. Six route tests and 26
incremental-runner tests pass. Crash reconciliation remains separately pending.

U12 crash-attempt reconciliation: startup now closes only queued/running operator
rollback audit jobs with UPDATE_ROLLBACK_AUDIT_INTERRUPTED, retaining actor and
request summary. It does not mark the game rollback successful or replay it;
transaction receipts remain authoritative. Duration stays unknown rather than
including downtime as execution time. A database reopen test proves idempotence,
preservation of terminal records, and no changes to unrelated jobs. All 19
storage/route tests and API typecheck pass. Immutable receipt metadata and
real-process crash evidence remain pending; this does not close U12.

Native installation batch completed: DYSON_CONTROL_DEPLOYMENT_SELFTEST_V1 reports
state=passed, process exited zero. Its fixture matrix includes idempotent staging,
immutable artifact rejection, install/upgrade/explicit rollback, failed-upgrade
compensation, protected configuration restore, broker task/ACL compensation,
uninstall evidence preservation and recoverable uninstall. Full private output
is retained on the VM and local validation directory. This does not prove a new
production release or a real DSP component update. The current audit sources
also pass all 24 VM storage/route/audit tests. Incremental plan recognizes all
current changes and remains releaseQualified=false. Corrected its misleading
fallback description so reviewed runtime changes are explicitly labeled as such.

Current incremental run completed its selected local checks and returned the
intentional `host-validation-required` state (exit 2), not a test assertion
failure. Native acceptance evidence is tracked separately; do not convert that
state to release-qualified merely because fixture self-tests passed. The one
Bridge-secret symlink test skipped locally for EPERM was run explicitly on the
Dyson VM and passed (other tests excluded by the targeted name filter).

### U13: bounded history has no executable retention path

`maximumHistoryEntries` defaults to 8 (configurable only within 1..64), while
`previewCleanup` returns executeSupported=false. Reaching the cap prevents future
updates. Retained committed live journals/snapshots also lack an integrated
retirement contract. Reusable operation requires revision-bound, audited,
recoverable quarantine/restore of eligible unreferenced history and materials,
protecting the active predecessor and every pending transaction. Do not solve
this by removing the cap or automatically deleting rollback evidence.

U13 planning protection fix: cleanup preview now rejects unresolved ordinary or
operator recovery and excludes the current lastTransaction history record from
retention candidates. At a one-entry limit it correctly offers no protected
history for removal. With two successful updates it offers only the older
record, preserving the current update predecessor. The 52 existing activation
tests passed after the change; four focused history/predecessor tests including
the new eligibility case also pass. Recoverable execution/quarantine is still
unimplemented, so U13 remains open. No files were removed by this change.

U13 implementation step: recoverable-cleanup-plan module strictly binds request,
revision, sorted history/release IDs, content digests and safe aggregate sizes.
It rejects duplicate sources, path injection and tampered/reused plan hashes.
Three targeted tests pass. It is an internal contract primitive awaiting protected
inventory, quarantine execution, restore and HTTP/UI integration; the existing
cleanup endpoint remains explicitly read-only.

U13 move-state engine: implements quarantine/restore direction, exact evidence
checks before and after move, completed-move replay and lease-loss propagation.
Both/neither locations, changed digest/size and an unproven move reject. Six
port-level tests pass, including loss after rename then renewed-lease replay.
This is not a native filesystem adapter: protected path resolution, atomic
rename, durable intent/checkpoints, orchestration and endpoint wiring remain.
No real cleanup capability is enabled by these internal primitives.

U13 filesystem inventory: added bounded real-file and directory inspection,
streamed file hashes, relative tree identities including empty directories,
post-read identity checks, link rejection, and limits of 4096 entries/depth 16/
1 GiB per object. Two real temporary-filesystem tests prove identity survives
rename to quarantine, filename changes alter the digest, and hardlinks reject.
The inspector is read-only; fixed-root path mapping, native move adapter and
transaction integration are still pending. No production materials were moved.

U13 fixed-root filesystem adapter: history UUIDs map only to history/*.json;
release IDs map only to releases/<component>/<id>; quarantine is request-owned.
Every existing parent is canonical and non-linked. Moves recheck source evidence
and destination absence, use rename without cross-volume copy fallback, and
require the caller's protected ACL plus exclusive host/activation locks. Real
file and directory quarantine/replay/restore tests pass, as does typecheck.
This adapter is not yet reachable from HTTP. Durable intent, transaction store,
recovery orchestration, protected eligibility and audit assembly remain open.

U13 native primitive check: all four cleanup primitive suites pass on the Dyson
VM (14 tests) using actual temporary history/release files. Added restore-target
collision coverage proves newly occupied original content is preserved and its
quarantine copy remains intact; path-shaped IDs reject. This is filesystem
adapter evidence, not durable cleanup transaction or public endpoint acceptance.

U13 durable-record contract: cleanup records now validate server-origin actor,
start/completion times, the exact plan digest, sequential candidate progress and
separate quarantine/restore request identities. Terminal publication is a distinct
step after all move checkpoints, and identical terminal replay is accepted.
Two targeted tests and typecheck pass. The filesystem journal store and its
atomic publication/recovery tests are still to be implemented; these schemas
alone are not durable transaction execution.

U13 SQLite journal persistence: added atomically appended, request-keyed progress
rows with sequence and predecessor SHA-256. Reads validate every record, chain,
identity, initial state and transition. Identical append replay is idempotent;
actor replacement, phase regression and premature terminal records reject.
All 14 storage tests and API typecheck pass, including database close/reopen.
The shared global lease/activation-lock orchestrator must still wrap these store
operations and filesystem moves before any endpoint can be enabled. Process-kill
and power-loss durability are not proven merely by orderly database reopen.

U13 execution composition: internal executor appends intent before moving,
checkpoints each object, revalidates all destinations before terminal publication,
and reads the terminal back. A real filesystem/SQLite integration test interrupts
after rename but before checkpoint, reopens the database, resumes without another
move, replays completion and restores through a separate request. It passes with
API typecheck. Shared lease acquisition/recovery, eligibility/revision checks,
request enumeration and endpoint/UI assembly are still caller responsibilities
not yet wired. The simulated throw is not an actual process-kill acceptance.

U13 host coordinator: internal cleanup/restore operations now select fixed host
operation identities and use ordinary/recovery coordinator capabilities plus an
activation-lock callback. Eligibility runs inside both boundaries before first
intent; interrupted intent/read/write failures retain recovery disposition.
Two targeted tests verify exact ordinary/recovery bindings, locked eligibility,
no mutation on revision failure and correct release/abandon behavior. Typecheck
passes. Production adapters for lock/eligibility, request discovery, audit and
HTTP/UI remain unwired; no cleanup route is enabled.

U13 protected inventory composition: the activation service now exposes an
internal recoverable-cleanup preview that derives eligible objects from its own
history/release state, hashes their actual bytes through fixed paths, and checks
state and eligibility again before returning a request/revision-bound plan.
An empty eligible set rejects. A composed test with two actual updates verifies
only the old history is included, real size/hash evidence exists, and identical
preview inputs produce the same plan. Targeted test and API typecheck pass.
Execution and HTTP registration remain pending; old cleanup preview stays read-only.

U13 recovery discovery: database now enumerates request journals with full chain
validation and a fail-closed 1024-request bound (never silently truncates pending
work). Reopen tests distinguish running from completed records. All current
cleanup primitive, record, execution/coordinator and storage suites pass on the
Dyson VM: 33 tests in cleanup-persistence-current-results.json. Production service
registry wiring and conflict gating remain pending; this is fixture composition
on Windows, not public cleanup endpoint or actual process-kill acceptance.

U13 production conflict gate: the Windows activation service is now wired to the
SQLite cleanup journal registry. Pending cleanup marks update state recoveryRequired
and blocks ordinary update preview/execute, operator rollback entry points and
cleanup preview. A focused test proves no protection action starts. The full
activation and production-assembly suites pass (73 passed, one known local
symlink-privilege skip already separately exercised on the VM). API typecheck
passes. Cleanup mutation itself remains unregistered pending eligibility and
execution service assembly; the new callback only adds conflict protection.

U13 activation-service assembly: internal execution now uses the existing
cross-instance activation lock with host cleanup/restore identities, SQLite
journals and fixed-root files. New quarantine validates the exact fresh plan;
resume checks persisted eligibility/current references without trying to rescan
already quarantined sources. Restore requires the original completed quarantine
plan. A composed two-update test quarantines only old history (2 -> 1), then a
separate restore returns it (1 -> 2). API typecheck and targeted composition pass.
HTTP still cannot invoke this internal method; request parsing, server actor/time
construction, recovery discovery UI and actual process-kill gates remain open.

U13 HTTP controller draft: strict preview/quarantine/recovery/restore requests,
separate default-disabled mutation/recovery gates, server actor/time construction,
original-journal reuse and terminal readback are implemented. Two controller tests
and API typecheck pass. Routes are not registered. Before registration, complete
restore-recovery identity handling for interruption before its first record,
recovery attempt auditing and route authorization tests; do not infer restore
intent from a bare missing request record.

U13 restore-recovery identity: recovery requests now explicitly discriminate
quarantine from restore. Missing restore intent is rebuilt only from a specified
completed quarantine source and matching plan digest; it never calls fresh
quarantine preview. Existing records reject a conflicting direction. Three HTTP
controller tests and API typecheck pass. HTTP route registration, authorization,
recovery-attempt audit and UI remain pending before enabling the capability.

U13 route registration: added authenticated recoverable-cleanup preview/state
and mutation/recovery/restore routes. Preview/state require updates.read;
mutations require updates.activate. Execution/recovery remain hard-disabled
until explicit config and audit integration are completed. Route tests prove
401 unauthenticated, 403 Viewer, 423 Administrator with gate closed, readable
Viewer preview/state and zero execution calls. Six route tests and API typecheck
pass. Do not claim executable cleanup delivery while these gates remain fixed off.

U13 config contract: added independent DYSON_UPDATE_CLEANUP_ENABLED and
DYSON_UPDATE_CLEANUP_RECOVERY_ENABLED flags, default false, to API configuration,
Windows environment allowlist and example environment. Enabling requires the
Windows lifecycle/staging/trusted-policy chain. All 26 config tests and API
typecheck pass. Live VM configuration is unchanged. Controller callbacks remain
fixed false until request-attempt audit is integrated; then they can be bound to
these explicit flags. Native configuration validation remains required for the
updated environment contract before a new release.

U13 enabled-route/audit assembly: cleanup callbacks now use the independent
configuration flags. Quarantine, restore and recovery each create SQLite audit
attempts before domain execution; restart marks unfinished attempts uncertain.
Jobs UI labels all three kinds. Seven route tests include explicit enabled
execution with real journal persistence and audit API readback (the domain move
service is injected), plus default-off/authorization cases. Storage tests and
API/web typechecks pass. Live VM flags remain unchanged. Full real-file HTTP
composition, UI, native config validation and process-kill acceptance remain.

U13 receipt/discovery routes: authenticated terminal lookup returns the exact
validated SQLite completion record, distinguishes absent (404) from unfinished
(409), and rejects unauthenticated reads. State summaries now include the original
expected revision together with request/source IDs, direction and plan hash so
recovery need not rely solely on browser storage. Seven route tests pass,
including execute response/readback equality and missing receipt behavior.
UI and real-process interruption acceptance remain pending.

Native cleanup process-kill fixture passed against the current compiled VM API.
A child using the real SQLite store, executor and fixed-root file adapter was
SIGKILLed after rename and before its first progress checkpoint. A new process
read completedCount=0 from the durable intent, completed quarantine and restored
the original bytes with matching SHA-256. Evidence protocol:
DYSON_CLEANUP_PROCESS_KILL_FIXTURE_V1, state=passed, realBrokerUsed=false,
productionMaterialTouched=false. Private harness/result files stay outside Git.
This proves a process boundary, not power-loss durability or real broker recovery.

U13 frontend API client: added bounded typed cleanup plan/state/terminal parsing,
same-origin authenticated requests, exact request/plan binding, separate restore
and recovery payloads, and mandatory terminal reread before success. Three tests
cover minimal submitted bindings, changed/unfinished receipt rejection and no
request for path-shaped IDs. Typecheck passes. No rendered panel uses it yet;
UI implementation and IAB verification remain pending.

U13 rendered panel draft: version workspace now includes cleanup preview,
confirmation, quarantine, server-recorded pending recovery, terminal lookup and
restore controls. It states quarantine frees history slots, not disk space.
Role/server gates, pending conflicts and revision changes disable submission;
completion requires the client's verified readback. Sixteen panel/workspace
DOM tests and web typecheck pass. IAB visual/interaction QA and local preservation
of attempts interrupted before the first server record remain pending.

U13 pre-intent UI recovery: before mutation, the panel saves only request/source
UUIDs, direction, original revision and plan hash in session storage. Reload
validates that binding and offers explicit recovery, including restore before
its first server record. Verified completion clears it; clearing the local
reference never cancels server work. Twenty related DOM/client/workspace tests
and web typecheck pass. The reload test proves no automatic submission and
unchanged restore identity when state enumeration is unavailable. IAB QA pending.

U13 authenticated IAB QA on VM development build: cleanup preview discovered one
real unreferenced failed-update release (1,798,670 bytes), displayed its opaque ID
and size, and left execution disabled even after confirmation because live cleanup
flags are off. Screenshot inspected; console error/warn query empty. No quarantine
or restore submitted. Sidebar accessible names are now visible in the IAB tree.
Original panel task restored and health=ok; game PID 9964 and its start identity
unchanged. Browser was reloaded after restoring the original panel version.
Positive enabled UI execution/recovery and real host-broker acceptance remain.

Actual source/history hygiene scan completed with two findings: REPOSITORY_DIRTY
(expected for this uncommitted batch) and UNC_PATH in the stopped-save capture
helper. Inspection identified only generic Win32 extended-path prefix handling.
Added exact helper-path worktree/artifact review entries and a history blob binding;
the scanner regression now pins this helper's current Git bytes too. All 19
scanner tests pass. The full scan has not been rerun after this policy change;
REPOSITORY_DIRTY remains a publication blocker until the batch is committed.

Native broker-backed cleanup process-kill fixture passed. The compiled real
HostMutationLeaseManager/HostMutationCoordinator acquired the PowerShell lease
for component-update-cleanup. After SIGKILL at rename-before-checkpoint, a new
recovery call acquired the exact prior operation/request binding, completed the
SQLite-backed cleanup and ran restore under component-update-cleanup-restore.
Both final byte identity and completion records were verified. Evidence:
DYSON_CLEANUP_BROKER_PROCESS_KILL_FIXTURE_V1, realBrokerUsed=true,
productionMaterialTouched=false. This ran as the authorized SSH administrator in
an isolated VM fixture, not under the installed panel's LocalService identity.
Private harness and output remain outside the repository.

Cleanup HTTP boundary follow-up: gate callback exceptions now enter the bounded
code-only failure path. Stored and terminal records are explicitly compared to
the submitted request ID, action direction and plan hash, in addition to schema
and result/readback equality. Four controller tests and API typecheck pass,
including a valid but foreign restore terminal returned for quarantine and an
exception containing a private diagnostic that must not cross the response.
