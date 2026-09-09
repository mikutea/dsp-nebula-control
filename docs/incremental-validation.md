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

Existing client-join, save, recovery and other real-host results may be reused for
unchanged behavior. Repeat only checks invalidated by a changed address/protocol,
game/mod version, configuration, runtime owner or other relevant dependency.
Do not use a process start, HTTP 200 or preview to claim broader production acceptance.