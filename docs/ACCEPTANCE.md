# Acceptance and production-readiness gates

Dyson Control is complete only when every `P0` and `P1` requirement in
[`acceptance/manifest.json`](../acceptance/manifest.json) is `verified` by
evidence that matches the scope of the requirement. A rendered screen, an HTTP
200 response, a passing unit test, or an operator's intention cannot stand in
for an end-to-end production requirement.

The manifest is the public, non-sensitive source of truth for product scope.
Production hostnames, addresses, task exports, player details, logs, saves,
credentials, and drill output stay in the private deployment evidence store and
are referenced by opaque evidence IDs in the final release record.

## States

| State | Meaning |
| --- | --- |
| `not-started` | The repository does not yet contain a complete implementation. |
| `implemented` | Relevant code or a contract exists, but the required verification is incomplete or narrower than the criterion. |
| `verified` | Current evidence directly proves the full criterion at its required unit, integration, installation, or production scope. |

Changing a requirement to `verified` requires adding repository-safe evidence
references. Production-only requirements also require a private signed or
hashed evidence record; the public manifest alone cannot prove them.

Legacy `{ kind, ref }` entries use exactly those two fields and document
implementation and test coverage, but
they cannot promote a requirement to `verified`. Every private or versioned
evidence entry must instead include an `evidenceId`, a bounded `scope`, the exact
40-character lowercase `subjectCommit` that was deployed, the exact runtime
artifact `runtimePayloadSha256` that was observed, and a `ref` to its bounded
public index. Evidence for another runtime payload cannot release the current
artifact.

Both evidence declaration shapes are exact-key contracts: extra, misspelled, or
missing fields fail closed. `expiresAt` is deliberately unsupported in protocol
version 1 because it is not mirrored into the public index or evaluated against
an authoritative release time; adding expiry requires a future versioned schema
and explicit release-time enforcement.

The shared PowerShell/validator evidence-ID grammar is
`^[a-z0-9](?:[a-z0-9._-]{6,126}[a-z0-9])$`: 8–128 ASCII characters,
beginning and ending with a lowercase letter or digit, with only lowercase
letters, digits, `.`, `_`, or `-` between them. Consecutive dots and Windows
device-name stems (`CON`, `PRN`, `AUX`, `NUL`, `COM1`–`COM9`, and
`LPT1`–`LPT9`) are also rejected. The manifest reference is derived exactly
from that ID and has no other valid form:
`acceptance/evidence/<evidenceId>.json`. Backslashes, nested paths, absolute
paths, traversal, a different filename, and redirected filesystem entries are
rejected.

Target-host, production, external-client, and cutover evidence stays private.
The public manifest records only an opaque private-store ID, its SHA-256,
observation time, evidence kind/scope, and release commit. It never embeds the
underlying log, save, player identity, endpoint, task export, or configuration.

```json
{
  "evidenceId": "prd-001-run-0001",
  "kind": "operator-run",
  "scope": "dyson-side-by-side",
  "subjectCommit": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "runtimePayloadSha256": "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
  "opaqueId": "private:prd-001-run-0001",
  "sha256": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  "observedAt": "2026-08-31T00:00:00.000Z",
  "ref": "acceptance/evidence/prd-001-run-0001.json"
}
```

The referenced public file is generated from a successfully verified private
bundle by `scripts/windows/evidence/New-DysonAcceptanceEvidenceIndex.ps1`. Its
complete protocol is:

```json
{
  "protocol": "DYSON_ACCEPTANCE_EVIDENCE_INDEX_V1",
  "schemaVersion": 1,
  "evidence": {
    "evidenceId": "prd-001-run-0001",
    "kind": "operator-run",
    "scope": "dyson-side-by-side",
    "subjectCommit": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    "runtimePayloadSha256": "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
    "opaqueId": "private:prd-001-run-0001",
    "sha256": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    "observedAt": "2026-08-31T00:00:00.000Z",
    "requirementIds": ["PRD-001"]
  }
}
```

The values in both examples are deliberately fictional and do not assert that
production evidence exists. The index contains no private path, log, payload,
endpoint, save, player identity, or host export. The validator accepts exactly
the fields shown, requires protocol/schema version 1, verifies canonical unique
`requirementIds`, rejects duplicate JSON object keys, and requires every mirrored
manifest value to equal the index byte-for-value. The requirement containing the
manifest entry must be listed in `requirementIds`.

One verified bundle may cover several requirements. Each listed requirement may
reference the same index only with the same `ref` and identical `evidenceId`,
`kind`, `scope`, `subjectCommit`, `runtimePayloadSha256`, `opaqueId`, `sha256`, and
`observedAt`. Duplicate declarations within one requirement and conflicting
reuse across requirements fail closed.

The current PowerShell generator verifies and indexes private-bundle kinds and
scopes. Repository-scoped `{ kind, ref }` entries remain valid legacy supporting
evidence. If repository evidence uses the versioned metadata form, it is also
index-bound and subject to the same strict protocol and equality checks; its
scope is not silently promoted to a private or production scope.

The repository-safe generation step is performed only after the private bundle
has been collected and verified. Using fictional placeholders, the shape is:

```powershell
powershell.exe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass `
  -File scripts/windows/evidence/New-DysonAcceptanceEvidenceIndex.ps1 `
  -DataRoot 'C:\ProgramData\FictionalDysonControl' `
  -EvidenceId prd-001-run-0001 `
  -ExpectedManifestSha256 <exact-lowercase-private-manifest-sha256> `
  -ExpectedSubjectCommit <exact-40-character-candidate-commit> `
  -ExpectedRuntimePayloadSha256 <exact-lowercase-runtime-payload-sha256> `
  -OutputPath acceptance/evidence/prd-001-run-0001.json -WhatIf
```

Do not hand-copy private output into the repository. Review the generated index,
then rerun the same command without `-WhatIf` and add the matching manifest entry
to every requirement named by that index.
The validator rejects malformed commits/digests/timestamps, missing store
identity, insufficient scope, runtime-payload drift, unknown fields, unsafe
paths, symlinks/junctions/reparse points, and index/manifest mismatches.

This avoids an impossible Git self-reference. The release process is explicitly
two-stage:

1. Freeze candidate commit A, build its immutable runtime artifact, deploy that
   artifact, and collect evidence bound to A plus its payload SHA-256.
2. Create commit B containing only the public acceptance manifest, bounded
   `acceptance/evidence/` indexes, and this acceptance document. The release job
   rebuilds B, requires the same runtime payload SHA-256, proves A is an ancestor
   of B, and rejects every A-to-B change outside those evidence-only paths.

Application code, dependencies, Windows scripts, package versions, configuration
templates, or release tooling cannot change between the attested candidate and
the final tag. Any such change requires a new candidate deployment and evidence
run.

## Priorities

The manifest release policy is also exact: it contains only
`blockingPriorities: ["P0", "P1"]`, `releaseReadyState: "verified"`, and
`productionEvidenceLivesOutsideRepository: true`. Empty, reordered, duplicate,
partial, extended, or otherwise altered blocker sets are rejected, and blocker
calculation uses the fixed P0/P1 contract rather than trusting mutable manifest
input.

- `P0` protects saves, credentials, access, lifecycle integrity, recovery,
  networking, and production cutover. A failed `P0` prohibits production use.
- `P1` is required for the general-purpose stable release: complete management
  workflows, productized deployment, monitoring, documentation, and client
  parity.
- `P2` may follow the first stable release only when it is explicitly recorded
  and does not weaken a `P0` or `P1` workflow.

## Commands

```powershell
npm run acceptance:check
npm run acceptance:summary
npm run acceptance:gate -- --release-commit <exact-final-tag-commit> `
  --artifact-manifest <exact-built-artifact-manifest>
```

`acceptance:check` validates schema, IDs, required functional areas, states, and
evidence paths/scopes and is part of `npm run check`. `acceptance:selftest`
proves that repository test paths cannot impersonate production evidence and
that private evidence is digest- and commit-bound. `acceptance:summary` prints
the current distribution without changing state. `acceptance:gate` additionally
requires the exact final tag commit and built artifact manifest. It exits
non-zero until every `P0` and `P1` requirement is verified by qualifying
evidence for that runtime payload and until the candidate-to-tag Git diff is
evidence-only; it is the final release and cutover gate, not a progress
indicator.

## Evidence scopes

Scopes are ordered from narrowest to strongest:

1. `repository-unit`
2. `repository-integration`
3. `local-windows`
4. `release`
5. `dyson-side-by-side`
6. `production`
7. `external-client`
8. `cutover`

Every P0/P1 requirement requires at least `dyson-side-by-side` proof unless a
stronger policy applies. Public-release hygiene requires `release`; the real
game network and join require `external-client`; soak and restore-drill gates
require `production`; and removal/switching gates require `cutover` evidence.
An implementation file or contract is useful supporting evidence but is never
qualifying proof by itself.

## Required evidence levels

| Requirement type | Minimum acceptable evidence |
| --- | --- |
| Pure domain logic | Deterministic unit tests including malformed and boundary input. |
| API authorization or mutation | Authenticated integration tests for allowed, denied, duplicate, timeout, and interrupted requests. |
| Windows adapter | Fixture tests plus a controlled Windows integration run against fixed allowlisted scripts. |
| Save, update, mod, or configuration mutation | Transaction receipt, pre-change protection point, post-condition check, tamper/failure test, and successful rollback. |
| Installer, upgrade, migration, or uninstall | Clean-host installation matrix and preservation/removal assertions. |
| Network reachability | Protocol-correct probe and a real external Nebula client join; DNS or HTTP health alone is insufficient. |
| Reboot or crash recovery | Observed service recovery after a real reboot or injected process interruption. |
| Production cutover | Timestamped private evidence, exact release hash, backup hash, rollback drill, and post-cutover observation. |

## Cutover invariants

1. GSManager remains available during side-by-side deployment.
2. No lifecycle capability is enabled merely because preflight is green; its
   action adapter, durable receipt protocol, rollback job, and integration tests
   must also be verified.
3. `.dsv` and `.server` are always protected, moved, restored, and validated as
   one atomic unit.
4. The Node listener remains loopback-only behind authenticated TLS routing.
5. Management transport and Nebula game transport are verified separately.
6. The final game path must be demonstrated to bypass PassWall.
7. GSManager is backed up and removed only after external client, reboot,
   restore, update rollback, and sustained-operation gates pass.

## Current foundation

The `0.1.x` foundation implements and tests authenticated fail-closed
configuration, fixed provider commands, strict non-mutating lifecycle preview,
paired-save inventory, bounded host status, and installed-version discovery at
repository-test scope. Those entries remain `implemented` until exact-commit
Dyson side-by-side evidence satisfies the stronger release policy.

The repository also implements narrower, tested foundations for durable
lifecycle execution, signed save/player bridging, save backup/restore
transactions, typed configuration apply, structured console reads, compatibility
and update planning, offline artifact staging, mod locks, client-profile
metadata, and reusable Windows control-plane deployment. These are marked only
`implemented` when their complete criterion still requires a clean-host run,
real target-host evidence, an external client, or a wider production drill.

In particular:

| Area | Repository implementation | Why it is not verified |
| --- | --- | --- |
| Saves | catalogue, durable backup/restore jobs, confirmation UI, manifest verifier, annotated recoverable retirement/restore, grace-period purge, deterministic streaming export and import quarantine | target-host/browser execution and a real Nebula save-load/restore drill remain |
| Configuration | typed schema, redacted preview, confirmed apply, bounded snapshot history, redacted diff, Administrator capture/restore/reconcile routes, server-issued Windows stop proof, and automatic compensation | no real target-host capture/restore/reconcile run, Nebula acceptance check, process restart, Windows reboot, or interrupted recovery drill |
| Console | fixed log source, signed cursor, filters, redacted bounded download, role-gated fixed lifecycle commands and durable receipts | no target-host/browser reconnect and leakage verification |
| Players | signed authoritative snapshot, restart-safe minimized SQLite projection/cursors, actively count-and-time-pruned event history, 64-event public route cap, role policy and signed upstream capability proof | no target-host bridge run or real API/bridge restart drill; Nebula does not currently provide the claimed moderation mutations |
| Updates/mods | authenticated discovery; role-aware Nebula acquisition; complete browser continuations for component acquisition, preparation, activation and receipt verification; a dedicated Thunderstore workflow for exact closure discovery, platform routing, confirmed import, verified lock generation, client parity, and handoff into reversible deployment; dependency-bound candidate IDs and receipts; ZIP graph/staging revalidation; fixed-root component publication; Windows lifecycle/save-protection/smoke adapter; and bounded deterministic receipt history | there is no controlled target-host publication, real DSP/Nebula load and bridge heartbeat, previous-release rollback and paired-save load, restart reconciliation, live installed-mod drift proof, or external join |
| Client | reproducible parity metadata plus deterministic authenticated browser ZIP download | no package install QA or external join |
| Windows deployment | immutable releases, startup task, upgrade rollback, recoverable uninstall, protected automatic interactive-session configuration, and a fail-closed pre-reboot checkpoint/read-only resume protocol | fixture testing cannot prove a real reboot, native Task Scheduler/ACL/LSA behavior, clean-host matrix, or target deployment |
| Open-source release | bounded source/history/artifact scanner, exact-path and exact-blob review policy, deterministic provenance evidence, manifest and SHA-256 verification | no final exact-commit release artifact or independently checked public tag exists yet |
| Performance | persistent bounded telemetry, durable acknowledged alert episodes, and a fixed six-hour late-game qualification report for UPS, CPU/core balance, memory, storage, runtime coverage, and health | no representative production late-game save, save-latency drill, reboot/crash recovery evidence, external join, or completed soak window |

Production, network, external-client, reboot/soak, and GSManager cutover
requirements remain `not-started`. GSManager has not been removed or replaced,
and no production endpoint is verified by this repository state.
