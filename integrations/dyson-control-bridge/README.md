# Dyson Control Bridge

Dyson Control Bridge is a deliberately narrow BepInEx companion plugin for a
Nebula dedicated host. Version 1 accepts one operation: a signed request to save
the running game to Nebula's fixed `_lastexit_` slot. It has no TCP listener,
HTTP endpoint, shell, caller-supplied command, caller-supplied path, or
caller-supplied save name. It also publishes a read-only signed player snapshot;
that output does not add a player mutation operation.

The bridge exists because Nebula's documented `/server save` command is sent by
an authenticated game client. A Web control plane is not a game client. Nebula
v0.9.22 ultimately performs that command on the Unity main thread through
`GameSave.SaveCurrentGame`; its Harmony patches save the matching `.server`
sidecar and update `GameStatesManager.LastSaveTime`. The bridge invokes the same
main-thread method from its BepInEx `Update` loop and requires all three pieces
of post-save evidence:

1. the game call returned success;
2. Nebula's save timestamp advanced;
3. the `_lastexit_.dsv` and `_lastexit_.server` fingerprints remained stable for
   the configured observation window.

References:

- <https://github.com/NebulaModTeam/nebula/wiki/Setup-Headless-Server>
- <https://github.com/NebulaModTeam/nebula/blob/v0.9.22/NebulaNetwork/PacketProcessors/Chat/RemoteServerCommandProcessor.cs>
- <https://github.com/NebulaModTeam/nebula/blob/v0.9.22/NebulaPatcher/Patches/Dynamic/GameSave_Patch.cs>

## Fail-closed protocol

Requests and receipts use a strict, ordered, line-based V1 protocol with an
HMAC-SHA-256 over every semantic field. The shared secret lives in a separate
ACL-protected file and must contain at least 32 random characters. Request files
are written to `requests/` through a same-directory atomic rename. The plugin
claims them into `processing/`, writes receipts atomically, and archives the
request in `processed/`.

While operational, the plugin atomically refreshes a signed
`DYSON_CONTROL_HEARTBEAT_V1` file every two seconds. The heartbeat binds the
plugin version, DSP process ID, plugin start time, current write time, and ready
state. The control plane rejects missing, stale, malformed, incorrectly signed,
or version-incompatible heartbeats before a lifecycle save can begin.

The Bridge intentionally has two compatible version representations. The full
`ReleaseVersion` (for example `0.1.0-rc.1`) is written to signed runtime evidence,
candidate manifests, and `AssemblyInformationalVersion`/ProductVersion. The
`BepInPlugin` attribute uses only the numeric `PluginVersion` core (`0.1.0`), and
Assembly/File versions use `0.1.0.0`, because those consumers require numeric
`System.Version` values. Activation compares the full ProductVersion exactly and
never treats the numeric Assembly/File version as equivalent to an RC release.

### Client compatibility

The validated Nebula 0.9.22.2 stack requires the Bridge plugin to be present on
joining clients as part of its mod handshake. Include the matching Bridge DLL
in the client package, with `Enabled = false` and empty `ControlRoot` and
`SecretFile` values. The disabled client copy performs no management work.
Never distribute the host configuration, shared secret, control directory,
player snapshots, or saves with a client package.

## Authoritative loaded-save evidence

The bridge maintains one atomically replaced signed file named
`loaded-save-evidence` using `DYSON_CONTROL_LOADED_SAVE_EVIDENCE_V1`. It does
not scan the save directory, sort by timestamp, infer a `latest` `.dsv`, or use
the bridge save-request target as the observation source. A Harmony prefix
revokes the previous load generation, and a postfix records the actual argument
only when `GameSave.LoadCurrentGame(string)` returns `true`. The origin is bound
to the resulting `GameMain.data` and Nebula session instances. Publication still
waits until Nebula reports that the dedicated server game is loaded and this
process is its host. A load predating hook registration remains unknown.

This API contract was verified against the local `Assembly-CSharp.dll` used by
the private bridge build: `GameMain.gameName` returns
`GameMain.data.gameName`. Normal loads (`GameSave.AllowRecursive == false`, the
default) retain the name imported from the save payload; only recursive-path
loads overwrite it with the sanitized load argument. It may therefore be empty
or unrelated to the filename and is not used as loaded-slot authority. Nebula writes
`<saveName>.server` from the same `SaveCurrentGame(saveName)` argument. The
managed lifecycle contract is intentionally narrower: evidence is published
only when the *successful load argument* is exactly `_lastexit_` and both
`_lastexit_.dsv` and `_lastexit_.server` are present, ordinary files, and stable
across complete SHA-256 reads. Paths come from the real `GameConfig.gameSaveFolder`
and retain the existing managed-directory verification; they are not substituted
with a configured or guessed directory.

The successful load fixes each paired file's path, length, write time and creation
time before asynchronous hashing. Later file disappearance or metadata drift
revokes that origin until another successful load; saving new bytes to the same
slot does not relabel them as the loaded generation. Save receipts remain a
separate proof. Failed/exceptional/reentrant loads, new-game entry, replacement
data/session instances, and loss of established host readiness revoke the origin.
AutoPause does not itself revoke a loaded origin while those loaded-host checks
remain valid. The plugin unregisters its own load/new-game hooks on destruction.

The payload binds the random per-plugin-start session ID, plugin version, OS
process ID and process start time, bridge start time, a strictly increasing
per-session observation generation, observation/write times, the observed save
name, and each paired file's byte length, UTC write-time ticks,
and lowercase SHA-256 digest. Hashing runs off Unity's main thread. The fixed
evidence file is removed before the initial hash and whenever the authoritative
name is unknown or not `_lastexit_`, either file is missing, the name or file
metadata changes, or an in-flight hash no longer matches the current runtime
observation. A strict reader must also match the active `runtime-session` tuple
and reject stale or non-increasing observation generations.

A normal plugin shutdown preserves the last complete HMAC evidence so a
stopped-baseline reader can bind it to the process generation that just exited.
The next plugin generation deletes that old file in its constructor before it
starts hashing. An in-process publisher fault explicitly deletes the file before
disabling the publisher. A crash before atomic publication therefore leaves no
partial file; a crash after publication leaves only a complete signed payload,
whose PID/process-start/bridge-session tuple prevents it from masquerading as a
new running generation.

This evidence says only which concrete paired save content the running game
currently identifies under the managed lifecycle slot. Compatibility policy,
release approval, migration safety, and update eligibility are control-plane
decisions and are deliberately absent from the bridge protocol.

## Actual simulation telemetry

The bridge also publishes two independent, atomically replaced signed files:
`runtime-session` (`DYSON_CONTROL_RUNTIME_SESSION_V1`) and
`simulation-telemetry` (`DYSON_CONTROL_SIMULATION_TELEMETRY_V1`). The session
contains a random per-plugin-start UUID and binds the DSP process ID, operating
system process start time, bridge start time, and plugin version. Each telemetry
sample repeats that identity, adds a strictly increasing per-session sequence,
and contains a bounded sampling window.

Actual UPS comes from DSP's stopwatch-backed `FPSController.currentUPS`.
Actual TPS is independently calculated from the change in `GameMain.gameTick`
over a monotonic `Stopwatch` window. The configured command-line `-ups` target
is not an input to either calculation and is not present in the telemetry
protocol. Samples require a loaded, running game. Nebula dedicated hosts can
retain the vanilla pause flag while their game ticks advance. When that flag
is set, the sampler requires positive tick progress in the measured window;
a genuinely paused window produces no sample and resets the baseline. Missing
samples produce a bounded diagnostic at most once every 30 seconds.
Missing, malformed, out-of-range, stale, replayed, differently signed, or
session/PID/process-generation-mismatched samples are unavailable rather than
being replaced with the target UPS.

`Get-DysonBridgeSimulationTelemetry.ps1` provides the same bounded,
fail-closed verification for a PowerShell 5.1 provider. A caller that uses the
script directly passes its last accepted session and sequence to enforce replay
protection across polls. The long-lived TypeScript bridge reader maintains that
guard in memory for each active session.

## Read-only player snapshot

The independent `DYSON_CONTROL_PLAYERS_V1` file is refreshed through the same
same-directory atomic replacement pattern. It is sourced from Nebula's
authoritative server-side `IServer.Players.GetAllPlayerData()` collection and
reconciled with the API's post-sync `OnPlayerJoinedGame` and post-disconnect
`OnPlayerLeftGame` events. This contract was verified against Nebula commit
`3cdf95c594a2f8010b0e87a43be828e6ba2f657f`:

- <https://github.com/NebulaModTeam/nebula/blob/3cdf95c594a2f8010b0e87a43be828e6ba2f657f/NebulaModel/Networking/IServer.cs>
- <https://github.com/NebulaModTeam/nebula/blob/3cdf95c594a2f8010b0e87a43be828e6ba2f657f/NebulaAPI/DataStructures/ConcurrentPlayerCollection.cs>
- <https://github.com/NebulaModTeam/nebula/blob/3cdf95c594a2f8010b0e87a43be828e6ba2f657f/NebulaAPI/NebulaModAPI.cs>

Each bounded row contains only an opaque connection-session ID, a clamped
display name, online status, join time, and an ID-only location summary such as
`planet:101`, `star:2`, or `deep-space`. The protocol is capped at 64 rows and
never serializes connection objects, IP addresses, raw endpoints, Steam data,
credentials, `player.key`, filesystem paths, mecha data, or coordinates. A
collection compatibility failure emits an empty signed `unavailable` snapshot
instead of stale player rows.

## Runtime-gated player-management capabilities

The bridge atomically refreshes a separate signed
`DYSON_CONTROL_PLAYER_CAPABILITIES_V1` file named `player-capabilities` beside
the roster. Its strict contract binds the roster session ID, write time,
official upstream repository, tag, release runtime file version and commit, and
one internally coherent runtime-verification state. The protocol never permits
an enabled action to be combined with an unverified scope.

At plugin startup, `NebulaNoticeRuntimeCompatibility` inspects the actual loaded
assemblies. The reviewed identity is `NebulaAPI, Version=2.1.0.0` with file
version `2.1.0.7` and product version `2.1.0.7+924606f`, plus
`NebulaModel, Version=0.9.22.0` with file version `0.9.22.2` and product version
`0.9.22.2+3cdf95c`. Reflection must also find the reviewed multiplayer network,
server player collection, connected-player dictionary, player connection/data,
connection liveness, generic `INebulaPlayer.SendPacket<T>`, fixed chat packet
constructor, and `SystemWarnMessage` enum member. A missing, duplicated,
unreadable, changed, or structurally incompatible assembly fails closed.

The two signed states are:

| Runtime state | Scope | `actionsEnabled` | Notice result |
| --- | --- | --- | --- |
| unverified | `source-contract-only-runtime-unverified` | `false` | `unavailable` / `NEBULA_NOTICE_RUNTIME_UNVERIFIED` |
| exact identity and primitives verified | `runtime-assembly-identity-verified` | `true` | `available` / `UPSTREAM_TARGETED_NOTICE_PRIMITIVES_VERIFIED` |

The read-only roster is independent of this mutation gate. It remains
displayable when notice verification fails, while every notice request is
rejected before target resolution or packet dispatch. The fixed capability
order remains `observe-roster`, `disconnect`, `kick`, `ban`, `whitelist`,
`blacklist`, `notice`, `permission`; only roster observation and, in the exact
verified state, notice are available. Disconnect, kick, ban, whitelist,
blacklist and permission remain unavailable with their fixed upstream reason
codes.

The protocol self-test fixes both complete states in independently decoded,
unpadded Base64URL and HMAC vectors, rejects unknown state values, and checks
that a source-only scope can never claim an enabled notice. These are repository
tests only: target-VM runtime verification and an actual disposable-player drill
are still required before `PLY-002` can become `verified`.

The source lock is the official `v0.9.22` tag at commit
`3cdf95c594a2f8010b0e87a43be828e6ba2f657f`. Upstream evidence includes:

- [`INebulaPlayer.SendPacket<T>`](https://github.com/NebulaModTeam/nebula/blob/3cdf95c594a2f8010b0e87a43be828e6ba2f657f/NebulaAPI/GameState/INebulaPlayer.cs)
- [`NewChatMessagePacket`](https://github.com/NebulaModTeam/nebula/blob/3cdf95c594a2f8010b0e87a43be828e6ba2f657f/NebulaModel/Packets/Chat/NewChatMessagePacket.cs)
- [`IServer.Players` and `IServer.Disconnect`](https://github.com/NebulaModTeam/nebula/blob/3cdf95c594a2f8010b0e87a43be828e6ba2f657f/NebulaModel/Networking/IServer.cs)
- [`ConcurrentPlayerCollection` roster API](https://github.com/NebulaModTeam/nebula/blob/3cdf95c594a2f8010b0e87a43be828e6ba2f657f/NebulaAPI/DataStructures/ConcurrentPlayerCollection.cs)
- [official `v0.9.22` release/tag](https://github.com/NebulaModTeam/nebula/releases/tag/v0.9.22)

`IServer.Disconnect` is not exposed as kick: the locked implementation removes
the connected entry before the later socket-close path performs authoritative
leave cleanup. The locked source also exposes no supported active-session ban,
whitelist, blacklist or permission primitive. The host-side `/playerdata
remove` command targets persistent certificate/display-name data rather than
this bridge's opaque connected-session identity and is outside this contract.

Notice is a distinct, narrow mutation. A signed
`DYSON_CONTROL_PLAYER_NOTICE_REQUEST_V1` selects only `maintenance-5m`,
`maintenance-now`, or `reconnect-required`; the bridge owns the text and accepts
no free text, raw connection identifier, command, path, or caller-supplied
reason. The request binds UUID idempotency, short expiry, current roster session
and sequence, opaque session player ID, and exact join time. The Unity update
thread re-resolves that binding against the live connected collection directly
before dispatch.

The signed `DYSON_CONTROL_PLAYER_NOTICE_RECEIPT_V1` reports
`transport-dispatched` only after the target player's `SendPacket` call returns;
this is not a delivery or display acknowledgement and notice has no rollback.
If processing is recovered after interruption, or packet dispatch throws after
mutation may have occurred, the receipt is `uncertain` with
`recoveryRequired=true`. The control plane must query the original request ID's
receipt through the read-only reconciliation route. That GET neither creates a
request nor dispatches a packet, and an unknown outcome must never trigger an
automatic POST retry.

An interrupted `processing/` request is never silently replayed. On the next
plugin start it receives an `INTERRUPTED_UNCERTAIN` terminal receipt, allowing
the control plane to reconcile paired-save evidence without issuing a duplicate
mutation.

Invalid or incorrectly signed requests are moved to `rejected/` and receive no
signed receipt. The bridge processes at most one save at a time and enforces a
cooldown matching Nebula's documented remote-save interval.

## Build

The plugin targets .NET Framework 4.7.2. It compiles against the local BepInEx,
Unity, DSP, Nebula API, and Nebula Model assemblies. Save members remain behind
a strict reflection compatibility adapter, while the player roster uses the
public Nebula interfaces above. The build does not redistribute those game or
mod assemblies. Missing or changed members disable the affected bridge surface
for that session.

```powershell
dotnet build .\integrations\dyson-control-bridge\DysonControlBridge.csproj `
  -c Release `
  -p:DysonServerRoot=C:\GameServers\DSP\server
```

Do not commit game assemblies or built packages.

### Public source package and private candidate

Official Dyson Control release artifacts intentionally contain this source
directory, the fixed disabled configuration template, and the PowerShell tools
under `scripts/windows/bridge`. They never contain this plugin DLL, PDB files,
or any DSP, Unity, BepInEx, Harmony, or Nebula reference assembly. Those files
cannot be redistributed by this project.

On a Windows host where the operator lawfully has the matching DSP, Nebula, and
BepInEx installation, create a private candidate without copying references out
of the game tree:

```powershell
$artifact = 'C:\Packages\DysonControl-v0.1.0-rc.1'
$server = 'C:\GameServers\DSP\server'
$candidate = 'C:\Private\DysonControlBridge-0.1.0-rc.1'

& "$artifact\scripts\windows\bridge\Build-DysonControlBridgeCandidate.ps1" `
  -SourcePath "$artifact\integrations\dyson-control-bridge" `
  -DysonServerRoot $server `
  -OutputPath $candidate `
  -ExpectedVersion '0.1.0-rc.1' `
  -Confirm:$false

& "$artifact\scripts\windows\bridge\Test-DysonControlBridgeCandidate.ps1" `
  -CandidatePath $candidate `
  -DysonServerRoot $server `
  -ExpectedVersion '0.1.0-rc.1'
```

The same controlled entry points are available from the release artifact as
`npm run bridge:target-build -- <arguments>` and
`npm run bridge:target-verify -- <arguments>`. They are intentionally separate
from the repository-safe root check: public CI must not receive proprietary game
assemblies, while production acceptance must not substitute fictional-reference
self-tests for this target-host build and verification receipt.

The builder accepts only the fixed reference paths declared by the project,
rejects redirected or abnormal assemblies, records their managed names,
versions, lengths, and SHA-256 digests, and invokes the exact `dotnet` host with
fixed build parameters, no shell, bounded output, and a timeout. The private
candidate contains exactly `DysonControlBridge.dll` and
`bridge-manifest.json`; reference assemblies and PDB files remain local and are
not copied. Candidate verification checks the complete file set, DLL identity,
GUID/version/hash, and the current local reference receipts again.

Stop the exact `DSPGAME.exe` from this server root before installation. Review
the dry run first, then install disabled-by-default:

```powershell
$installer = "$artifact\scripts\windows\bridge\Install-DysonControlBridge.ps1"
$controlServiceSid = 'S-1-5-19' # Local Service used by Dyson Control
$gameServiceSid = '<SID of the dedicated interactive DSP account>'
& $installer -CandidatePath $candidate -DysonServerRoot $server `
  -ControlServiceSid $controlServiceSid -GameServiceSid $gameServiceSid -WhatIf
& $installer -CandidatePath $candidate -DysonServerRoot $server `
  -ControlServiceSid $controlServiceSid -GameServiceSid $gameServiceSid -Confirm:$false

& "$artifact\scripts\windows\bridge\Test-DysonControlBridgeInstallation.ps1" `
  -DysonServerRoot $server
```

The two exact, distinct, non-privileged SIDs are mandatory. The secret grants
both identities read access. The control tree gives the game account Modify,
while the control service gets Modify only in `requests`, Read/Execute on the
root and `receipts`, and no access to `processing`, `processed`, or `rejected`.
SYSTEM, Administrators, and the installer retain FullControl. Every ACL is
protected and exact; broad readers and extra ACEs fail verification. The
installer creates at least 48 cryptographically random secret bytes, never
prints them or records them in a manifest, snapshots any prior DACLs, and
restores them on failure. It publishes the DLL and config using same-directory
atomic replacement, leaves `Enabled = false`, and never starts the game.

Uninstall is also dry-run capable and recoverable. It snapshots the installed
DLL/config/state and preserves the secret and all control data. The returned
snapshot ID can be passed back explicitly:

```powershell
$uninstaller = "$artifact\scripts\windows\bridge\Uninstall-DysonControlBridge.ps1"
& $uninstaller -DysonServerRoot $server -WhatIf
$receipt = (& $uninstaller -DysonServerRoot $server -Confirm:$false | ConvertFrom-Json)
& $uninstaller -DysonServerRoot $server -RestoreSnapshotId $receipt.snapshotId -Confirm:$false
```

Neither install nor uninstall removes or changes saves, the DSP game, Nebula,
BepInEx, or GSManager/GSM, and neither operation restarts the game.

## Configuration

The bridge is disabled by default. A generic example is:

```ini
[Bridge]
Enabled = false
ControlRoot = {{CONTROL_ROOT}}
SecretFile = {{SECRET_FILE}}

[Timing]
PollMilliseconds = 250
StabilityMilliseconds = 2000
SaveTimeoutSeconds = 30
SaveCooldownSeconds = 60
```

Before enabling it, the installer must:

1. generate a random secret without logging or returning it;
2. grant secret read access only to the control service and dedicated game
   account;
3. grant the game account access only to the bridge control directory and save
   location it already needs;
4. verify that none of the control subdirectories are reparse points;
5. install the exact tested plugin build and restart the game in a maintenance
   window;
6. run a signed dry integration request against a disposable or protected save
   before enabling any public lifecycle API.

The repository exposes lifecycle execution through a durable transaction API,
but its default adapter remains non-mutating. A deployment must explicitly
enable the Windows lifecycle adapter and provide the private bridge paths; even
then, a fresh compatible heartbeat and the remaining host preflight checks are
required for each transaction.
