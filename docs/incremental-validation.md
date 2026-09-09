# Cumulative validation

CI and release use `node scripts/validate-incremental.mjs`. They do not automatically
repeat `npm run check`, including for the final release. The complete command remains
available for an explicitly requested investigation.

The current reviewed baseline is commit `47b125e57cea4a0ba2457b842b926edc6c4a2faf`.
[CI run 34341084734](https://github.com/mikutea/dsp-nebula-control/actions/runs/34341084734)
passed its affected checks. It inherits commit `9accff7d525ebc5c846ee0f3aff7234ba6e5decc`
and [CI run 34272695419](https://github.com/mikutea/dsp-nebula-control/actions/runs/34272695419),
which covered provider, workflow, and Windows recovery tests, including exact
legacy-inheritance ACL restoration. This cumulative baseline inherits the complete
Windows validation of `f0f022eef7b799da21e9adfd37246b62dcf971ee`, finished on 2026-09-08.
That full baseline's tested source
archive SHA-256 was `637c5432606aa252f4e2bf28a0302a908fa8ca86bb0ff1fe26964aba9a4f0d81`.
The full baseline was recorded from target-host validation; its earlier hosted run
failed SDK selection before its test gate. The newer CI run above passed after that fix.
Private host evidence is retained separately and must not be published with the source.

For rc.17, the runner compares all changed and untracked source files with the current
baseline. Exact rc.16-to-rc.17 version substitutions reuse prior functional results.
Version and validation-infrastructure checks remain lightweight. A Windows status
adapter change selects the PowerShell function, provider, and observability tests;
an unchanged adapter does not repeat them. Recovery changes select the focused recovery
test below. Combined changes retain both groups.

An unmapped change, dependency change, or deletion stops the job. Maintainers must review
its impact and extend the explicit test plan before continuing; there is no automatic
full-suite fallback. This plan is intentionally scoped to the reviewed rc.17 changes.
Future functionality requires a new mapping and the corresponding affected regressions.

The bootstrap/broker upgrade correction runs the lifecycle broker self-test and,
when the deployment coordinator changes, the deployment self-test. Deployment
fixtures use compiled API helpers, so that group builds the API first. The broker
regressions replace bootstrap line endings across releases and verify byte-exact
restoration at each upgrade failure point. The prior bootstrap backup is accepted
only for an explicit existing-broker upgrade and must match the old pinned hashes;
other dependencies continue to be checked at their live immutable-release paths.

Bootstrap resolver changes run the focused pointer test and the existing game
lifecycle bootstrap self-test. Identity-bearing pointers must match the root-bound
deployment marker, partial or unknown fields remain rejected, and Windows entry-point
separators must resolve against the canonical slash-delimited file inventory.
The exact addition of that pointer test to the artifact allowlist is separately
recognized; any other packaging-module change fails closed. Real artifact and
package construction and verification remain mandatory before deployment.

The DataRoot recovery layout correction additionally runs its focused Windows recovery
self-test when either recovery implementation or fixture changes. Its installer-state
fixtures must survive bundle creation, restoration, and failure rollback with their
bytes and ACLs intact; unknown top-level paths remain rejected.
The same focused test covers consumed cutover requests with retained terminal receipts,
strict receipt validation, and rejection of residual intents, unpaired requests, and
failed mutating operations. A terminal failed read-only observation remains history,
not an outstanding host mutation.

`--plan` prints the intended checks without executing them and never reports a pass.
Release builds, artifact/package verification, public-data scanning, and artifact-bound
production acceptance remain separate gates. Existing evidence may be reused only where
the change does not invalidate it. Missing real-host recovery, external join, reboot,
rollback, or sustained-load evidence must still be obtained before production cutover.
