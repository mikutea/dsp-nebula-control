# Side-by-side observation protocol v2

`DYSON_QUALIFICATION_SIDE_BY_SIDE_OBSERVATION_V2` is the private,
read-only PRD-001 evidence protocol. It does not deploy a release, start or stop
a process, change an authority, bind a port, or switch away from GSManager.
Successful verification always returns `productionChanged: false`.

The implementation is intentionally separate from the mutation adapters:

- `Qualification.SideBySideV2.ps1` defines strict parsing, canonical hashes,
  semantic and cross-document validation, HMAC protection, and create-new
  publication.
- `New-DysonSideBySideObservationV2.ps1` converts one approved capture into an
  immutable protected observation.
- `Test-DysonSideBySideObservationV2.ps1` revalidates the observation against
  the independent expectation and HMAC key.
- `SelfTest-DysonSideBySideObservationV2.ps1` uses only fictional paths,
  identities, and hashes. Its temporary files stay below the workspace-owned
  `<workspace>\.codex-temp` directory derived from the repository location.

## Three independent inputs

Generation requires three files. The verifier requires the latter two again;
it never treats the observation as its own authority.

1. A `DYSON_QUALIFICATION_SIDE_BY_SIDE_CAPTURE_V2` capture contains the
   deployment receipt and independent, read-only observations.
2. A `DYSON_QUALIFICATION_SIDE_BY_SIDE_EXPECTATION_V2` expectation freezes the
   approved run, target, release, commit, four artifact hashes, deployment
   receipt hash, candidate-root identity, GSManager snapshot identity and
   manifest hash, both ports, and key ID.
3. A `DYSON_QUALIFICATION_SIDE_BY_SIDE_KEY_V2` key file contains 32–128 bytes
   encoded as Base64. It is private operational material and must never be
   committed or copied into a public qualification receipt.

All JSON objects use exact property sets. Unknown properties, duplicate JSON
keys, invalid lowercase UUIDs/digests/commit IDs, malformed UTC timestamps, and
oversized input files fail closed.

## What `verified` means

`status: verified` is necessary but never sufficient. The verifier also proves
all of the following from the complete, HMAC-protected structure:

- the candidate deployment receipt is self-digested, says `installed`, and
  closes over the exact release ID, 40-character commit, release-package,
  artifact-payload, runtime-payload, and manifest SHA-256 values;
- the candidate root is a fixed local NTFS root, is reparse-free, has a
  content-bound root identity, and neither contains nor is contained by the
  production DataRoot or GSManager root;
- the health sample is an independent loopback `GET /readyz`-class observation
  with no mutation, and its release/runtime identity matches the deployment
  receipt;
- the operating-system process query is read-only and binds PID/start time,
  executable, command line, runtime, Nebula and Bridge assembly hashes to the
  same candidate root, release, commit, and runtime payload;
- the GSManager snapshot verification binds the actual
  `DYSON_GSMANAGER_SNAPSHOT_V2` ID, manifest, payload, task XML, filesystem
  security inventory, paired-save protection point, verification time and
  expiry, and says it passed full byte/ACL/task read-only verification;
- the independent authority sample still reports GSManager as authority and
  production-port owner, with its task available and bound to that snapshot;
- there is no switch intent, cutover receipt, production-port takeover,
  production listener owned by the candidate, or dual authority; the candidate
  uses a different loopback-only port;
- capture times agree within five seconds, elapsed time is bounded, the
  observation is no older than four hours, and both observation and snapshot
  receipts are unexpired.

The expectation comparison runs even when every embedded digest and the outer
HMAC have been recomputed. Therefore possession of an internally consistent
capture cannot silently change the release, artifact, root, snapshot, or port
that was approved.

## Example commands

The following names are fictional. Do not place a real key in the repository.

```powershell
& .\scripts\windows\qualification\New-DysonSideBySideObservationV2.ps1 `
  -CapturePath D:\ExampleQualification\capture.json `
  -ExpectationPath D:\ExampleQualification\expectation.json `
  -KeyPath D:\ExampleQualification\private-key.json `
  -OutputPath D:\ExampleQualification\receipts\observation.json

& .\scripts\windows\qualification\Test-DysonSideBySideObservationV2.ps1 `
  -ObservationPath D:\ExampleQualification\receipts\observation.json `
  -ExpectationPath D:\ExampleQualification\expectation.json `
  -KeyPath D:\ExampleQualification\private-key.json
```

The capture is evidence input, not a live-probe implementation. A production
adapter must obtain it from separately authorized, independently implemented
read-only observers and must bind the byte-exact deployment and GSManager
snapshot receipts. A hand-authored capture or repository self-test remains
source/fixture evidence and is not target-runtime verification.

## Self-test

```powershell
& .\scripts\windows\qualification\SelfTest-DysonSideBySideObservationV2.ps1 `
  -TempRoot <workspace>\.codex-temp
```

The negative matrix includes status-only forgery, re-sealed artifact/root/
health/runtime/snapshot/authority mutations, switch intent, port takeover, dual
authority, receipt/HMAC corruption, expiry, and duplicate JSON keys.

The protected observation deliberately has a richer exact schema than the old
generic controlled-observation projection. Orchestration must call
`Assert-DysonSideBySideV2Observation` for the
`candidate-isolation-observation` role; it must not strip the binding fields or
fall back to accepting the generic `status: verified` projection.
