# Reversible cutover observation V2

`DYSON_REVERSIBLE_CUTOVER_OBSERVATION_V2` is a fail-closed, local evidence protocol for a future CUT-002 reversible cutover drill. Adding or testing this protocol does **not** execute the drill and does not change CUT-002 from `not-started`.

The collector and validator never contact a host or endpoint and never perform a lifecycle action. They read already-persisted evidence files plus one `.dsv` / `.server` pair. Their output records `collectorEffects.networkTouched=false` and `collectorEffects.productionChanged=false`.

## Required evidence

The observation binds all of the following to one externally supplied approval, window, qualification run, target identity, release, 40-character commit, runtime payload digest, release-manifest digest, data-root identity, save generation, and authority inventory revision:

- an approved `DYSON_APPROVED_MAINTENANCE_WINDOW_V2`;
- a `DYSON_CONTROL_RUNTIME_RELEASE_MANIFEST_V2` whose actual file digest equals the externally expected manifest digest;
- a paired-save `DYSON_CONTROL_PAIRED_SAVE_PROTECTION_POINT_V2`;
- a `DYSON_REVERSIBLE_CUTOVER_GSMANAGER_AUTHORITY_SNAPSHOT_V2` backed by `DYSON_GSMANAGER_AUTHORITY_PROFILE_V1`;
- persisted `DYSON_REVERSIBLE_CUTOVER_SWITCH_RECEIPT_V2` evidence in both directions, each containing the exact three ordered broker/host action receipts required for that direction;
- authenticated management and Nebula game-protocol health observations for Dyson Control and for restored GSManager authority;
- the restored `.dsv` and `.server` files, verified as one atomic pair against the protection point;
- a seven-entry, contiguous, strictly ordered audit trail whose evidence digests and timestamps match the supplied artifacts.

The evidence expires. Validation rejects observations whose evidence or observation expiry has already elapsed, as well as observations outside the approved maintenance window.

## Commands

Create a new observation with `New-DysonQualificationReversibleCutoverObservationV2.ps1`. The destination must not already exist. Validate it read-only with `Test-DysonQualificationReversibleCutoverObservationV2.ps1`, passing the same source files and all external expected bindings. The validator reconstructs the complete canonical observation from those sources and requires byte-equivalent JSON semantics, so editing a summary and recomputing only its top-level digest is insufficient.

Run the repository-only self-test:

```powershell
pwsh -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File scripts/windows/qualification/SelfTest-DysonQualificationReversibleCutoverObservationV2.ps1
```

The self-test uses only generated fictional artifacts below the workspace `.codex-temp` directory. Its positive path invokes both public wrappers. Negative paths cover generic HTTP/TCP status, run/target/release/save-generation splicing, one-way success, a missing save mate, pair hash drift, audit sequence drift, expired evidence, and a recomputed-summary tamper.

The JSON Schema is `reversible-cutover-observation.v2.schema.json`. It describes the emitted observation, while the PowerShell validator remains authoritative for cross-file hashes, cross-field equality, time ordering, current expiry, paired-save integrity, and audit/source reconstruction.
