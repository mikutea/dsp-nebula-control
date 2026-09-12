# Post-GSManager-removal observation v2

`DYSON_POST_GSMANAGER_REMOVAL_OBSERVATION_V2` is a strict, read-only evidence
format for the future `CUT-003` post-removal qualification. Adding, generating,
or validating this format does not remove GSManager, contact a server, alter a
route, activate a recovery package, or promote `CUT-003` beyond `not-started`.

The generator consumes facts that were already collected under separate
authorization. It creates a canonical, self-digested document without
overwriting an existing file. The validator reads that document and returns
`networkTouched=false` and `productionChanged=false`.

## Required evidence

One observation binds every evidence group to the same independently supplied
run, target, release version, 40-character commit, runtime payload, and release
manifest:

- a previously qualified cutover observation followed by a GSManager removal
  receipt;
- an independent observation window of at least one hour;
- a read-only residual-authority inventory showing zero installations,
  scheduled tasks, services, listening ports, and processes attributable to
  GSManager;
- the exact Dyson Control release, commit, runtime payload, release manifest,
  and release-checksum identity;
- a loopback-only panel origin plus externally observed TLS and authenticated
  management receipts;
- server-authoritative Nebula join and reconnect receipts, rather than an HTTP
  or TCP reachability result;
- recovery after a new boot;
- a verifiable save receipt and intact paired save whose pair and world
  identities agree with the game and reboot observations;
- a verified recovery bundle for the same save pair that remains inactive and
  requires an explicit activation step;
- final evidence-index, runbook, known-limitations, and release-checksum
  receipts.

All in-window evidence has bounded UTC timestamps. The top-level observation
expires no more than one hour after completion. A subject digest is repeated in
every group, the zero-residual inventory has its own digest, and the complete
observation has a self digest. Recomputing those digests cannot make a semantic
violation qualify.

The schema deliberately has no generic `status` property. A removal-success
receipt alone, a generic HTTP/TCP result, a cross-run/release/save splice, any
GSManager residue, an unusable or activated recovery package, or expired
evidence fails closed.

## Create and validate

Create a new canonical document from an already collected input document:

```powershell
powershell.exe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass `
  -File scripts/windows/qualification/New-DysonPostGsManagerRemovalObservationV2.ps1 `
  -InputPath D:\Fictional\DysonControl\post-removal-input.json `
  -OutputPath D:\Fictional\DysonControl\post-removal-observation.json
```

Validate it read-only while pinning the independent expected identity:

```powershell
powershell.exe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass `
  -File scripts/windows/qualification/Test-DysonPostGsManagerRemovalObservationV2.ps1 `
  -ObservationPath D:\Fictional\DysonControl\post-removal-observation.json `
  -ExpectedRunId 61000000-0000-0000-0000-000000000002 `
  -ExpectedTargetIdentity fixture-dyson-vm `
  -ExpectedReleaseVersion 0.1.0-rc.1 `
  -ExpectedSubjectCommit aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa `
  -ExpectedRuntimePayloadSha256 sha256:1111111111111111111111111111111111111111111111111111111111111111 `
  -ExpectedReleaseManifestSha256 sha256:2222222222222222222222222222222222222222222222222222222222222222
```

The validator also accepts `-ExpectedObservationId`; callers should pass every
expected identity available from the approved run rather than trusting values
inside the evidence document.

Run the fictional, network-free positive and tamper matrix under an explicit
workspace-scoped temporary root:

```powershell
powershell.exe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass `
  -File scripts/windows/qualification/SelfTest-DysonPostGsManagerRemovalObservationV2.ps1 `
  -TestRoot D:\Fictional\DysonControl\Temp
```

The JSON Schema is
`dyson-post-gsmanager-removal-observation-v2.schema.json`. The PowerShell
validator remains authoritative for cross-field identities, sequencing,
expiry, inventory and self digests, paired-save continuity, and independent
expected bindings. Passing repository self-tests is local implementation
evidence only; production qualification still requires an approved observation
run and remains outside this protocol's authority.
