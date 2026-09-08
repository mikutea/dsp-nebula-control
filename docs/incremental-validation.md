# Cumulative validation

CI and release use `node scripts/validate-incremental.mjs`. They do not automatically
repeat `npm run check`, including for the final release. The complete command remains
available for an explicitly requested investigation.

The reviewed baseline is commit `f0f022eef7b799da21e9adfd37246b62dcf971ee`.
Its complete Windows validation finished successfully on 2026-09-08. The tested source
archive SHA-256 was `637c5432606aa252f4e2bf28a0302a908fa8ca86bb0ff1fe26964aba9a4f0d81`.
This is a maintainer-recorded baseline from target-host validation, not a claim that
GitHub CI passed: the earlier hosted run failed SDK selection before its test gate.
Private host evidence is retained separately and must not be published with the source.

For rc.15, the runner compares all changed and untracked source files with that baseline.
Exact rc.14-to-rc.15 version substitutions reuse prior functional results. The Windows
status script changes run the PowerShell function tests, provider tests, and observability
adapter/snapshot tests. SDK selection and workflow changes run the version and workflow
checks. Validation-runner changes run its fail-closed classification tests.

An unmapped change, dependency change, or deletion stops the job. Maintainers must review
its impact and extend the explicit test plan before continuing; there is no automatic
full-suite fallback. This plan is intentionally scoped to the reviewed rc.15 changes.
Future functionality requires a new mapping and the corresponding affected regressions.

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
