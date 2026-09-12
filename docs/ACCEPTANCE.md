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
npm run qualification:selftest
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

`qualification:selftest` validates the repository-only Windows PowerShell 5.1
qualification protocol, fixed 13-step plan, receipt chains, interruption and
rollback handling, execution gates, and marked temporary Shadow adapters. Its
virtual six-hour soak and fictional dangerous actions leave all nine production
requirements `not-started`; they create neither target-host evidence nor
authority to run a real adapter. See
[the production qualification runbook](PRODUCTION-QUALIFICATION.md).

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
| Saves | catalogue, durable backup/restore jobs, confirmation UI, manifest verifier, annotated recoverable retirement/restore, grace-period purge, deterministic streaming export/import quarantine, and confirmed promotion of a verified import through host/transfer locks, a protection point, atomic pair replacement, durable receipts, and orphan recovery; the host protection-point script also has zero-write `WhatIf`, same-request idempotent reuse, manifest revalidation, and tamper-rejection coverage | target-host/browser execution and a real Nebula save-load/restore drill remain |
| Configuration | typed schema, redacted preview, confirmed apply, bounded snapshot history, redacted diff, Administrator capture/restore/reconcile routes, server-issued Windows stop proof, and automatic compensation | no real target-host capture/restore/reconcile run, Nebula acceptance check, process restart, Windows reboot, or interrupted recovery drill |
| Console | fixed log source, signed cursor, filters, redacted bounded download, role-gated fixed lifecycle commands and durable receipts | no target-host/browser reconnect and leakage verification |
| Players | signed authoritative snapshot, restart-safe minimized SQLite projection/cursors, actively count-and-time-pruned event history, 64-event public route cap, role policy and signed upstream capability proof | no target-host bridge run or real API/bridge restart drill; Nebula does not currently provide the claimed moderation mutations |
| Updates/mods | authenticated discovery; role-aware Nebula acquisition; complete browser continuations for component acquisition, preparation, activation and receipt verification; a default-off official Steam-client manual handoff with durable baseline/protection/stopped-state/recovery receipts and exact version, compatibility, and current-generation exact-save proof; a fixed-root Windows transaction provider bound to configuration stop proof, paired-save protection, the managed mod authority, runtime receipts, and an independently re-evaluated reviewed compatibility policy; a versioned HMAC loaded-save evidence writer/reader bound to the actual `_lastexit_` game name, process identity, Bridge generation, observation generation, and `.dsv` plus `.server` content identity; a fail-closed default production-assembly regression test for activation, recovery, Steam handoff, and every fixed authority; a dedicated Thunderstore workflow for exact closure discovery, platform routing, confirmed import, verified lock generation, client parity, and handoff into reversible deployment; dependency-bound candidate IDs and receipts; ZIP graph/staging revalidation; fixed-root component publication; a five-surface rollback journal for component bytes, configuration, server mod lock, paired save, and exact previous-save load; Windows lifecycle/save-protection/smoke adapters; and bounded deterministic receipt history | repository protocol, provider, cross-runtime, and assembly tests do not prove a controlled target-host publication or Steam handoff, real DSP/Nebula load and Bridge heartbeat, target-VM five-surface previous-release rollback, paired-save reload, restart reconciliation, live installed-mod drift proof, or external join |
| Client | reproducible parity metadata plus deterministic authenticated browser ZIP download; and a V2 qualified-client path that accepts only an opaque qualification ID, independently revalidates the protected hostname-WSS receipt/document chain and actual candidate/client/package bytes, binds the server lock, client parity and compatibility policy, and issues only after the shared protected acceptance marker is consumed for the same immutable binding | no accepted production qualification, real package install QA, or external join/reconnect evidence |
| Windows deployment | immutable releases, startup task, upgrade rollback, recoverable uninstall, protected automatic interactive-session configuration, fail-closed pre-reboot checkpoint/read-only resume, path-free game-runtime exit receipts, a bounded authenticated receipt API, and a target-root Bridge candidate builder/verifier that requires the fixed DSP `netstandard.dll` reference set and rejects missing, conditional, or reparse-point dependencies | fixture/API testing cannot prove a real reboot, native Task Scheduler/ACL/LSA behavior, crash restart, a real target-root Bridge build/load, clean-host matrix, client rejoin, or target deployment |
| DataRoot recovery | private full-tree bundle with relative-path/type/length/SHA-256 and ACL intent, independent tamper/missing/extra verification, quiescence and no-pending gates, automatic pre-overwrite protection point, atomic directory swap, exact rollback, idempotent receipts, and a temporary-root Shadow fault-injection self-test | no target-host bundle, offline copy, native scheduled-task/ACL matrix, production restore, post-restore application health, or private operator evidence exists |
| Network assessment | versioned redacted local/read-only v1 and v2 assessment schemas; separate game and management planes; local single-owner `DSPGAME` listener identity; all-answer DNS and public first-address semantics; TCP, TLS, hostname-preserving SNI/Host, and HTTP/WebSocket classification; permanent mutation denial; injected Shadow fixtures with zero native network calls; and a v2 fixed same-tree verifier boundary that derives WSS `/socket` semantics only from an exact, consumed, protected six-field qualification projection whose PassWall result comes from the signed receipt chain | no repository test contacted a real remote target, proved a public route, observed live router/firewall/PassWall counters, completed the Nebula application handshake, or supplied an accepted external-client production record; a passing v2 self-test or preview cannot qualify production, so `PRD-003` and `PRD-004` remain `not-started` |
| Production qualification harness | strict 13-step plan for the nine open requirements; immutable plan/checkpoint/receipt digests; exact public receipt projection; private-evidence references; prerequisite, challenge, timing, pause/resume, idempotency, hard-exit and rollback recovery; permanently Shadow-only v1 adapters; four fixed, default-off production-capable v2 adapters with an isolated fake backend; and a protected Orchestration V2 layer that accepts only fixed schemas/adapters and normalizes controlled evidence into bounded receipt chains, all covered by Windows PowerShell 5.1 self-tests | repository tests invoke only v1 Shadow, v2 fake, and the Orchestration V2 protected receipt fixture; no v2 adapter has passed a target-host run, reboot remains out of scope, and no real process fault, SMB interruption, disk-pressure drill, authority switch, save restore, external join, or qualifying private evidence has been accepted; all nine mapped requirements remain `not-started` |
| GSManager recoverable removal | fixed-root, snapshot-bound and paired-save-protection-bound removal; exact tree/task/ACL guard; preflight authority and pending-mutation gates; durable receipts; failure compensation; independent inspection; and explicit restore to a disabled, activation-required state, covered by a fictional temporary-root Shadow self-test | no clean-host/native Task Scheduler matrix, target-host preimage, operator confirmation, observation window, rollback drill, production removal, or production restoration exists; `CUT-003` remains `not-started` |
| Open-source release | Windows CI pins Node.js 24 and runs the complete gate, including Windows PowerShell 5.1 self-tests and both builds; the tag-only release workflow binds a canonical tag/version/commit, rejects a dirty checkout, runs acceptance and public-history/artifact scans, then publishes only the deterministic ZIP, SHA-256, canonical provenance, and bounded scan evidence; exact required-file gates cover the compiled observability runtime, Orchestration V2 contracts, Bridge source/build contract and fixed `netstandard.dll` reference; release self-tests exercise removal, unexpected-file, conditional-reference, and re-manifesting failures; cross-runtime version checks pin the PowerShell, JSON Schema, and TypeScript protocol/schema literals | no final exact-commit release artifact, successful tag workflow, hosting-platform cache/fork review, or independently checked public tag exists yet |
| Performance | persistent bounded raw telemetry plus a restart-persistent 72-hour slim hash chain; continuity qualification for sample coverage, monotonic order, maximum gap, SMB mapping/task health, and chain integrity; server-authoritative save/backup receipt latency with failures kept separate and missing or truncated evidence reported as unknown; read-only API/UI projection; a signed Bridge UPS/TPS sampler bound to the verified runtime process/session and current Bridge generation; durable acknowledged alert episodes; and a separate fixed six-hour late-game report | repository tests use fictional or temporary inputs, including the 17,281-sample restart/continuity matrix; there is no real-VM Bridge telemetry, representative production late-game save, trusted target-host latency drill, reboot/crash recovery evidence, external join, or completed 72-hour soak window |

The Windows transaction provider, runtime-evidence reader, compatibility
inspector, Bridge loaded-save publisher, cross-runtime protocol coverage, and
default production-assembly regression path are repository implementation
evidence only. They add no signed or hashed target-host evidence and cannot
promote an update, rollback, or production requirement to `verified`.

The manifest therefore still contains exactly 48 requirements: 39
`implemented`, nine `not-started`, and zero `verified`. All nine
production-only requirements remain `not-started`, and no real-VM evidence has
been added. GSManager has not been removed or replaced, and no production
endpoint is verified by this repository state.
