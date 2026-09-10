# Risk-based validation

## Acquisition and candidate cache mutexes

Changes to `update-pipeline/cache-mutex.ts` require its tests and acquisition,
candidate-preparation, and staging service/controller/route tests plus API
typechecking. Validate real child-process exit and reacquisition, downloaded byte
hashes and receipt replay, partial unpublished staging followed by verified
publication, and active/foreign/legacy/hard-linked ownership rejection. Check
that release never deletes a replaced lock. Request and artifact mutexes protect
cache metadata only; they grant no live installation authority. Legacy PID-only
locks and unproven partial records remain operator-review items. Preserve earlier
partial-attempt evidence until separately authorized cleanup. Obtain final-candidate
target-host evidence before treating these checks as production acceptance.

## Steam handoff metadata lock recovery

Changes to Steam handoff lock recovery require its service, HTTP controller, and
application-route tests plus API typechecking. Verify prior-boot and same-boot
locks owned by an exited child process, live-owner rejection, foreign-host rejection,
future/invalid ownership metadata, and hard-link rejection. Reclamation must keep
the file open while checking bounded contents and filesystem identity. This local
metadata mutex does not replace the global operation/recovery lease or prove an
actual Steam update; final candidate validation on the target host remains required.

## Configuration transaction recovery batch (in progress)

The configuration page consumes server execution metadata and fails closed when
it is missing. Its UI checks cover disabled gates, unchanged retry UUIDs, new UUIDs
after editing, stale preview rejection, and explicit recovery of the pending
request. Run `configuration-workspace.test.tsx`, its history workspace regression,
and affected API route tests. Validate the final built page in a browser; component
tests alone do not establish rendered layout or production execution acceptance.

Changes to configuration apply coordination, durable intent, or residual-lock
ownership require the configuration transaction, configuration apply/reconcile coordination,
configuration history, and workspace-route tests plus API typechecking. Transaction
tests must include a real child-process exit immediately after lock acquisition,
during snapshot creation, after snapshot completion, before replacement, after the first
replacement, after all replacements but before terminal verification, and after
the terminal audit is durable but before lock release. Verify
the retained snapshot and lock binding, byte-state classification, and rejection
of a subsequent writer. Also inject compensating rollback and terminal-audit
storage failures; neither may release an unresolved transaction's lock.
For pre-intent recovery, require the original request revision, complete lock
ownership, unchanged live bytes, absence of staged replacements, and validation
of every existing snapshot fragment before completing the snapshot. Corrupt or
foreign fragments must be preserved and rejected.
Configuration history recovery also requires `history-hard-exit.test.ts`: original
global recovery authority must precede residual-lock removal or fresh local-lock
acquisition. Cover publication exit, terminal-before-unlock exit, a retained journal
without a local lock, foreign live bytes, mismatched authority, and receipt replay.
Keep invalid receipts and later edits intact. Validate any absent-file publication
gap against the transaction's displaced file and staged replacement before recovery.

These interruption/quarantine checks alone do not establish automatic recovery.
Release also requires exact-authority recovery and terminal replay tests, including
foreign lock, changed file, malformed evidence, and interrupted recovery rejection.
Verify that completed-apply replay preserves later configuration edits and that
reuse of a request ID with different input is rejected. Run the affected scenarios from the final candidate on the
target Windows host with disposable configuration fixtures, followed by authenticated
configuration apply/restore acceptance under the production stop-proof and global
lease. Keep real paths, configuration contents, and evidence outside this repository.

Validate changed behavior, not every historical change on the branch. Reuse evidence
when its implementation, dependencies, contract and relevant environment remain valid.
Source validation does not imply production acceptance.

## Verified baselines

The complete current cumulative baseline is
`77e72366e998d92e6d4765700a373d6afe18a342`:
[CI 34358347690](https://github.com/mikutea/dsp-nebula-control/actions/runs/34358347690)
passed version/workflow checks, bootstrap pointer and lifecycle tests, lifecycle
broker tests, and deployment integration/rollback tests. It inherits earlier
unchanged status and recovery results, including
[CI 34272695419](https://github.com/mikutea/dsp-nebula-control/actions/runs/34272695419).
The earlier complete Windows baseline remains
`f0f022eef7b799da21e9adfd37246b62dcf971ee`.

`componentBaselines` in `scripts/validate-incremental.mjs` records evidence separately
for status, recovery, bootstrap, lifecycle broker and deployment coordination.
Advance an entry only after the corresponding checks actually pass. Record the
command or real-host scenario, immutable source commit, relevant inputs and result;
keep private host details outside the public repository. A failing unrelated check
does not invalidate completed evidence for an unchanged component.

## Default: fast checks and an explicit plan

```text
node scripts/validate-incremental.mjs --plan
node scripts/validate-incremental.mjs
```

Default validation runs version and validation-runner checks. Reviewed PowerShell
test-only edits receive a syntax check; documentation changes do not cause runtime
tests. A changed assertion still needs its relevant scenario checked when the
assertion's behavior changes: syntax success is not scenario success.

The plan lists each component's verified commit, evidence and decision: reuse,
run, or require host validation. If changed runtime inputs still need host checks,
default validation exits with code 2 and `host-validation-required`. It does not
silently report those checks as passed and does not start a long suite automatically.
Unmapped changes, dependency changes and deletions still require an impact plan.

## Target-host checks

```text
node scripts/validate-incremental.mjs --host-checks --plan
node scripts/validate-incremental.mjs --host-checks
```

Run selected scenarios on the intended Windows host using an isolated fixture and
the exact candidate source. This mode selects only affected components; it does
not restart a production game. For an archive without Git metadata, generate the
plan in its source checkout and run the listed commands against the matching
target-host archive. Retain the source/archive identity with the result.

Changing the deployment coordinator does not automatically rerun an unchanged
broker's tests. Changes to startup/stop or expected-exit handling select bootstrap
checks; source/test version-label substitutions reuse reviewed behavior.

## Full deployment suite: explicit only

```text
node scripts/validate-incremental.mjs --full-deployment --plan
node scripts/validate-incremental.mjs --full-deployment
```

Use this only when a deployment transaction or recovery change warrants the full
integration matrix. It compiles required API fixture helpers first. A smaller,
relevant target-host deployment/rollback scenario can instead supply evidence for
the affected component; update its baseline after that evidence is verified.
Use `--host-checks --full-deployment` when both sets of checks are needed.

No mode automatically invokes `npm run check`. Do not repeat completed suites for
diagnostic text, test-helper, documentation or packaging-only edits. The narrowly
reviewed artifact allowlist addition is checked separately; real artifact/package
validation and sensitive-data scanning remain required for the release artifact.

The reviewed `STATUS_CONTROL_C_EXIT` launcher correction has an exact-diff mapping
to `SelfTest-DysonGameLifecycleBootstrap.ps1 -ExitPolicyOnly`. This executes the
actual source guard against normal exit, console interruption and unrelated error
codes. It does not assert that the complete production stop transaction succeeded.
Other launcher changes still require a new impact plan. The reboot-acceptance
helper is test tooling; its native observation callback is checked on the target
host, and its source receives a syntax check without a deployment-suite rerun.

Existing client-join, save, recovery and other real-host results may be reused for
unchanged behavior. Repeat only checks invalidated by a changed address/protocol,
game/mod version, configuration, runtime owner or other relevant dependency.
Do not use a process start, HTTP 200 or preview to claim broader production acceptance.

The exact reviewed expected-exit ACL correction selects
`SelfTest-DysonGameLifecycleBootstrap.ps1 -ExpectedExitAclOnly`. It denies
WRITE_OWNER on a disposable receipt, verifies repeated descriptor application,
rejects an actual group change and checks unchanged security and file bytes.
Full normalized source hashes constrain this exception; additional runtime edits
return to the normal bootstrap impact plan. The target-host game-account
requested-to-completed receipt scenario also passed in an isolated directory
with the real state directory ACL. Actual production stop acceptance remains
separate and must use the installed release, its binding and durable receipt.

The exact reviewed lifecycle verification serialization correction selects
`SelfTest-DysonLifecycleBroker.ps1 -VerifyEvidenceOnly`. It executes the worker's
actual blocker assignment and JSON roundtrip for matched, mismatched and
unverifiable process states. Native PowerShell pipeline unrolling must never
turn the array into null or a scalar; the API's strict array schema is unchanged.
Any other worker source edit returns to the regular broker impact plan. A real
broker request against the installed candidate remains the integration gate.

PowerShell invocation changes run the native Windows PowerShell binding fixtures
and lifecycle broker client contracts in the default check. Explicit false
switches must bind as booleans, while quoted paths and metacharacter-containing
values remain data. Script allowlisting, output bounds and cancellation stay in
force. Read-only calls without explicit boolean switches retain their existing
invocation path. Native dispatch on the installed host remains a separate gate.

The lifecycle component baseline advances to
`ade74f3c5dbfed210fc4ed5a95a6577a9f1fcd7d` after its scoped native invocation
checks and [CI 34449324085](https://github.com/mikutea/dsp-nebula-control/actions/runs/34449324085)
passed. This avoids repeating unchanged invocation tests for the next startup
bundle. It is regression evidence, not a declaration that all production
lifecycle behavior was accepted.

The reviewed persistent-startup bundle has exact normalized source fingerprints
for its configuration, application wiring, adapter, phase timer and worker.
Unrelated edits to these inputs require a new plan. Its check runs the affected
configuration, application, adapter and durable-service tests, plus the actual
PowerShell dispatch-state guard. The changed worker's complete Shadow broker
suite also passed on the Windows validation host (107 assertions, no production
scheduler calls); repeat that only when another worker change invalidates it.
