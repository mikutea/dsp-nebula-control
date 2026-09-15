# Nebula private binary qualification pipeline

This directory defines a fail-closed, request-scoped pipeline for producing and
qualifying the two Nebula assemblies affected by the hostname/WSS source patch.
It deliberately does **not** contain a build executor. It does contain a
whole-tree deployment transaction for a separately qualified candidate.
Generating or previewing a plan never runs `dotnet`, MSBuild, NuGet restore,
Steam, the game, or a server command, and never writes to an installed game
tree. The mutation entry points remain dry-run unless the caller supplies both
`-Apply` and the exact digest-bound confirmation phrase.

The current contract is pinned to:

- Nebula `v0.9.22` at commit
  `3cdf95c594a2f8010b0e87a43be828e6ba2f657f`;
- websocket-sharp submodule commit
  `00d2a2fe1151d4352fe3f88aabae280b66cc4670`;
- the exact two-file patch and source contract under
  `integrations/nebula-hostname-wss/`;
- `DysonSphereProgram.GameLibs` `0.10.34.28529-r.0`, game version
  `0.10.34.28529`, and the pinned `Assembly-CSharp.dll` MVID;
- the official 38-file Nebula package and 6-file API package; and
- a 44-file candidate in which exactly 40 files retain official bytes and only
  `NebulaNetwork.dll/.pdb` plus `NebulaPatcher.dll/.pdb` are private outputs.

`private-build-contract.v1.json` is the machine-readable anchor. Changing an
upstream commit, patch, package, game build, MVID, strong-name identity, official
archive, or file count requires a reviewed contract update; no wildcard upgrade
is accepted by the qualification scripts.

## Pipeline phases

1. `New-NebulaPrivateBuildPlan.ps1` creates a new direct child of a caller-owned
   NTFS job base. The request ID must be a lower-case UUID. UNC paths, shared
   repository roots, Steam/game roots, Windows, Program Files, traversal,
   reparse points, and pre-existing job roots are rejected. It writes isolated
   props, targets, NuGet configuration, and a non-executing two-build plan.
2. An out-of-tree executor, which is intentionally absent here, may consume the
   plan only after independent review. It must check out the exact commit and
   submodule, verify the clean tree, check and apply the exact two-file patch,
   verify both patched-source hashes, seed only verified official references,
   preseed the exact contract-pinned `websocket-sharp.dll` from the verified
   official archive, and invoke the remaining dependency closure followed by
   Network and Patcher with `BuildProjectReferences=false` and
   `-noAutoResponse`. The websocket source remains commit-pinned but is not
   compiled because its wildcard assembly version is incompatible with a
   deterministic build. Dependency outputs are build-only; only the two
   Network and Patcher DLL/PDB pairs may be harvested.
   All output, intermediate,
   NuGet, CLI-home, and TEMP paths must remain beneath the request job root.
3. `Get-NebulaPrivateBinaryMetadata.ps1` is a read-only post-build inspector. It
   accepts only the four harvest files. It verifies the 28529 GameLib/MVID gate,
   assembly/file/product versions, unsigned Nebula identity, websocket-sharp
   strong name, required assembly references, custom MVIDs, PE CodeView and
   Portable PDB identity, PathMap hygiene, and absence of machine paths or
   credential-like strings. It uses reflection-only assembly loading.
4. Two independent harvests must pass
   `Assert-NebulaPrivateDeterministicBuilds`. Their byte hashes, versions, MVIDs,
   references, CodeView data, PDB IDs, and hygiene findings must be identical.
5. `New-NebulaPrivateCandidate.ps1` verifies both official archive hashes,
   rejects traversal, duplicate, missing, and extra entries, reconstructs the
   official 38+6 baseline, verifies its content-tree hash, substitutes only the four
   qualified files, and emits a path-redacted manifest. The candidate contains
   no metadata file and no extra PDB or dependency.
6. `Test-NebulaPrivateCandidate.ps1` independently revalidates the baseline,
   candidate, deterministic metadata, exact 40/4 byte boundary, manifest digest,
   and public hygiene.
7. `New-NebulaPluginCutoverPlan.ps1` reads the target tree and emits a V3
   dry-run plan plus an exact preimage content/ACL inventory. The ACL digest
   covers owner, primary group, and the complete DACL for every directory and
   file; it deliberately does not require SACL audit privilege. Client and server
   policy remains role-bound, but both roles share one physical-target pending
   intent gate and one receipt chain, so a role change cannot split a plugin tree's
   transaction history. The plan binds the exact candidate manifest and tree digest, game version,
   GameLib version, `Assembly-CSharp.dll` MVID, fresh stopped-process proof,
   maintenance window, prior receipt-chain head, preimage hash, and preimage
   ACL digest. It also binds real NTFS volume serial/file-index identities for the
   game, `BepInEx`, and preimage directories. `BepInEx` must have a protected DACL
   and must not grant `DeleteSubdirectoriesAndFiles` (`DeleteChild`) to any principal
   other than LocalSystem, Builtin Administrators, the protected directory owner,
   or the current mutation identity. Neither the target absolute path nor the
   candidate absolute path is persisted in the plan.
8. `Invoke-NebulaPluginCutover.ps1` defaults to a read-only preview. With
   explicit `-Apply`, the exact phrase from the plan, `ShouldProcess`
   authorization, and a borrowed global host-mutation lease, it takes an exclusive
   transaction lock, rechecks the live compatibility/process/tree/ACL/receipt-chain
   gates, copies the exact 44-file
   candidate into a same-volume stage, verifies content and ACLs, persists an
   immutable write-through intent, then revalidates stage content, ACL, real NTFS
   directory identity, parent boundary, maintenance window, stopped-process proof,
   receipt-chain head, and borrowed lease immediately before the renames. It uses two same-volume directory renames
   to quarantine the preimage and activate the candidate. The old tree is never
   deleted. A failure after the intent automatically restores the exact
   preimage; `-Recover` conservatively restores it after a recognized crash
   state only while the intent's prior receipt remains the current physical-chain
   head. Any unrecognized combination, stale recovery, expired window, lost lease,
   or replaced directory identity fails closed without guessing.
9. `Test-NebulaPluginCutover.ps1` independently verifies the intent/receipt
   binding, current physical-chain head, exact active content and ACL inventory,
   operation-owned directory identities, exact retained rollback tree, role binding,
   and absence of a persisted candidate-source path.
10. `Restore-NebulaPluginCutover.ps1` is independently dry-run by default and
    emits its own digest-bound rollback confirmation phrase. Its explicit apply
    path moves the candidate to a request-specific retained stage and atomically
    restores the exact quarantine. It has compensation and crash recovery that
    restore the previously applied candidate if the rollback itself is
     interrupted. Apply/rollback require a borrowed lease of kind `mutation`;
     apply/rollback recovery require kind `recovery`. Every stage, intent, rename,
     compensation, and receipt boundary re-borrows and validates the lease.
     `Test-NebulaPluginRollback.ps1` verifies either terminal state and requires its
     receipt to be the current physical-chain head.

No transaction command deletes a stage, quarantine, intent, receipt, or audit
artifact. Cleanup is a separate future retention decision and is intentionally
outside these tools.

The mutating scripts expose the same in-memory borrowed-lease interface:
`-HostMutationDataRoot`, `-HostMutationLeaseInstanceId`, and
`-HostMutationLeaseToken`. The caller must already hold the global lease from
`DysonHostMutationLease.Common.ps1` and must pass those three values directly to
the child process. The token is never written into a plan, intent, receipt, audit
record, or command output by these scripts. A caller that cannot supply all three
values cannot mutate the plugin tree. The API/provider caller wiring is outside
this directory and must map its held lease to these exact parameters without
serializing the raw token.

## Plan-only example

Use fictional local paths when documenting or testing the workflow:

```powershell
$requestId = [guid]::NewGuid().ToString('D').ToLowerInvariant()
powershell.exe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass `
  -File scripts/windows/nebula-private-build/New-NebulaPrivateBuildPlan.ps1 `
  -RequestId $requestId `
  -JobBase 'C:\FictionalDysonBuildJobs'
```

The job base must already exist. The command produces JSON plans and isolation
files only. It does not fetch source, restore packages, build binaries, or modify
a game installation.

A cutover preview uses a separately qualified candidate, an existing stopped
fictional target, a role, and a bounded UTC maintenance window:

```powershell
powershell.exe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass `
  -File scripts/windows/nebula-private-build/New-NebulaPluginCutoverPlan.ps1 `
  -RequestId $requestId `
  -JobBase 'C:\FictionalDysonBuildJobs' `
  -GameRoot 'C:\FictionalGames\Dyson Sphere Program' `
  -TargetRole Server `
  -CurrentPluginsTreeSha256 ('a' * 64) `
  -CandidateManifestPath "C:\FictionalDysonBuildJobs\$requestId\evidence\candidate-manifest.json" `
  -MaintenanceWindowStartUtc '2030-01-01T01:00:00Z' `
  -MaintenanceWindowEndUtc '2030-01-01T02:00:00Z'
```

The example hash is illustrative; a real preview succeeds only when it equals
the live exact tree digest. The target must match game `0.10.34.28529`, the
pinned MVID, and stopped-process proof. The preview contains an exact
confirmation phrase and digest, but explicitly records that confirmation has
not been granted. Supplying a preview is not authorization to execute it.

Preview the apply transaction without writing the game tree:

```powershell
powershell.exe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass `
  -File scripts/windows/nebula-private-build/Invoke-NebulaPluginCutover.ps1 `
  -RequestId $requestId `
  -JobBase 'C:\FictionalDysonBuildJobs' `
  -GameRoot 'C:\FictionalGames\Dyson Sphere Program' `
  -TargetRole Server `
  -PlanPath "C:\FictionalDysonBuildJobs\$requestId\evidence\plugin-cutover-plan.json" `
  -CandidateManifestPath "C:\FictionalDysonBuildJobs\$requestId\evidence\candidate-manifest.json"
```

An operator must inspect that preview and then pass `-Apply` and the exact
phrase from `confirmation.exactPhrase`; documentation deliberately does not
embed a reusable confirmation token. Rollback follows the same two-step
preview/apply discipline with a new rollback request UUID and the exact applied
receipt digest.

## Self-test

```powershell
npm run nebula-private-build:selftest
```

The self-test uses newly created local TEMP fixtures and fictional bytes. It
does not run a compiler or package restore. In addition to build qualification,
it executes the real rename transaction only against an explicitly restricted
TEMP `Shadow` backend. It covers malicious paths, UNC and reparse rejection,
anchor drift, missing/extra candidate and harvest files, official stock-byte
drift, wrong game version and MVID, websocket version and strong-name drift,
PDB path leakage, nondeterministic builds, archive traversal and duplicate
entries, write escape attempts, manifest hygiene, default dry-run, exact
   confirmation, client/server binding, physical root-wide pending intents and
   receipt chains, process-stop proof, locked files,
   preimage/candidate mismatch, extra files, ACL drift, automatic compensation,
   protected-parent `DeleteChild`, plan nested-schema injection, real NTFS file-ID
   replacement, stage tamper, maintenance-window expiry, lease kind/loss, stale
   A recovery after a later B winner, receipt replay, crash recovery, manual
   rollback, and independent terminal verification.

The focused transaction suite can also be run directly:

```powershell
powershell.exe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass `
  -File scripts/windows/nebula-private-build/SelfTest-NebulaPluginTransaction.ps1
```

## Source and distribution boundary

Nebula is GPL-3.0-only. A distributed private binary must be accompanied by the
corresponding exact source, patch, license, build instructions, and notices for
that binary. This repository may publish those source-side materials and hashes.
It must not commit or publish Dyson Sphere Program assemblies, Steam content,
official Thunderstore binary packages, user profiles, saves, logs, credentials,
machine paths, or locally built DLL/PDB files. Binary archives and manifests stay
private until a separate release review confirms licensing and public hygiene.

The following remain outside this directory's authority: executing generated
build commands, restoring packages, starting DSP, changing a VM/server,
deleting quarantine/stage evidence, and publishing a release. The transaction
code is capable of replacing a Windows plugin tree only after all explicit
runtime gates and authorization are supplied; this source change and its tests
do not grant that authorization and do not write Program Files, Steam, a VM, or
a public endpoint.

The contract distinguishes the SHA-256 of the prior 44-file audit manifest from
the digest of the 44 file contents. The content digest is recomputed as SHA-256
over ordinal-sorted records encoded as `path`, NUL, invariant-culture decimal
byte size, NUL, lower-case file SHA-256, and LF. The explicit ordering and number
format keep Windows PowerShell and modern PowerShell byte-identical. Neither
value is substituted for the other.
