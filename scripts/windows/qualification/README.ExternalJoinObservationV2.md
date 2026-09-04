# External join observation v2

`DYSON_EXTERNAL_JOIN_OBSERVATION_V2` is a read-only evidence format for the
`PRD-004` external-client sequence. It does not contact a server, change a
route, request a game save, or promote the requirement to `verified`.

The generator consumes facts already collected by separately authorized host,
external-network, external-client, and independent-save observers. It binds the
following twelve events into one strictly increasing digest chain:

1. DNS resolved from an external network.
2. TLS established with the expected SNI and certificate.
3. WSS upgraded with the expected Host and `/socket` path.
4. Nebula transport established.
5. Nebula authentication observed by the server.
6. Initial join observed by the server.
7. A gameplay interaction observed by the server.
8. A save requested.
9. The same request independently acknowledged with an exact paired-save hash.
10. A clean disconnect observed by the server.
11. The transport re-established under a fresh qualification session and challenge.
12. The client rejoined the same world and exact saved pair.

Every event is bound to the same release, commit, runtime payload, release and
client/server manifests, public hostname, one-run client pseudonym, world, and
session binding. The reconnect leg must use a different qualification-session
UUID and challenge UUID. `status=verified` is not part of the schema and cannot
replace any domain field.

## Privacy boundary

The document accepts only `client:sha256:<64 lowercase hex>` as the one-run
pseudonym. It requires `sourceAddressCollected`, `displayNameCollected`,
`accountIdCollected`, and `deviceIdCollected` to be `false`. Do not place raw
authentication material, account/platform identifiers, player names, device
identifiers, source addresses, ISP, or location in the input document.

The client network classification must be `public-external`. A LAN client,
loopback probe, TCP-open result, or client-only success claim cannot qualify.

## Create and validate

Create a canonical document without overwriting an existing evidence file:

```powershell
powershell.exe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass `
  -File scripts/windows/qualification/New-DysonExternalJoinObservationV2.ps1 `
  -InputPath D:\DysonControl\Qualification\external-input.json `
  -OutputPath D:\DysonControl\Qualification\external-observation.json
```

Validate it while pinning the approved public hostname and immutable release
identity:

```powershell
powershell.exe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass `
  -File scripts/windows/qualification/Test-DysonExternalJoinObservationV2.ps1 `
  -ObservationPath D:\DysonControl\Qualification\external-observation.json `
  -ExpectedPublicHost join.example.com `
  -ExpectedSubjectCommit aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa `
  -ExpectedRuntimePayloadSha256 sha256:1111111111111111111111111111111111111111111111111111111111111111
```

Run the fictional, network-free test matrix with an explicit temporary root:

```powershell
powershell.exe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass `
  -File scripts/windows/qualification/SelfTest-DysonExternalJoinObservationV2.ps1 `
  -TestRoot D:\DysonControl\Temp
```

Passing this self-test proves only repository behavior. `PRD-004` remains
`not-started` until an approved external client run produces qualifying private
evidence for the exact release.
