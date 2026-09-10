# Risk-based validation

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
