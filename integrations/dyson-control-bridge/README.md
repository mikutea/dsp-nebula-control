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

## Verified player-management capabilities

The bridge atomically refreshes a separate signed
`DYSON_CONTROL_PLAYER_CAPABILITIES_V1` file named `player-capabilities` beside
the roster. Its strict contract binds the roster session ID, write time,
official upstream repository, tag, release runtime file version and commit, a
source-only verification scope, `actionsEnabled=false`, and this fixed
capability set:

| Capability | Result | Verified reason |
| --- | --- | --- |
| `observe-roster` | `available` / `read-only` | `UPSTREAM_ROSTER_API_VERIFIED` |
| `disconnect` | `unavailable` / `mutation` | `UPSTREAM_CONNECTED_DISCONNECT_UNSAFE` |
| `kick` | `unavailable` / `mutation` | `UPSTREAM_KICK_API_ABSENT` |
| `ban` | `unavailable` / `mutation` | `UPSTREAM_BAN_API_ABSENT` |
| `whitelist` | `unavailable` / `mutation` | `UPSTREAM_WHITELIST_API_ABSENT` |
| `permission` | `unavailable` / `mutation` | `UPSTREAM_PERMISSION_API_ABSENT` |

The source lock is the official `v0.9.22` tag at commit
`3cdf95c594a2f8010b0e87a43be828e6ba2f657f`. Its official GitHub release asset
contains `NebulaPatcher.dll` with file version `0.9.22.2` and product version
`0.9.22.2+3cdf95c`; the capability contract records that runtime file version
separately from the tag. The file deliberately says
`source-contract-only-runtime-unverified`: this proves the upstream mapping,
not which DLL is currently loaded on a real VM. A deployment still needs an
exact assembly/runtime compatibility check before even the read-only roster is
considered operational.

Upstream evidence:

- [`IServer.Players` and `IServer.Disconnect`](https://github.com/NebulaModTeam/nebula/blob/3cdf95c594a2f8010b0e87a43be828e6ba2f657f/NebulaModel/Networking/IServer.cs)
- [`ConcurrentPlayerCollection` roster API](https://github.com/NebulaModTeam/nebula/blob/3cdf95c594a2f8010b0e87a43be828e6ba2f657f/NebulaAPI/DataStructures/ConcurrentPlayerCollection.cs)
- [`DisconnectionReason` enum](https://github.com/NebulaModTeam/nebula/blob/3cdf95c594a2f8010b0e87a43be828e6ba2f657f/NebulaAPI/Networking/DisconnectionReason.cs)
- [`Server.Disconnect` removes before closing the socket](https://github.com/NebulaModTeam/nebula/blob/3cdf95c594a2f8010b0e87a43be828e6ba2f657f/NebulaNetwork/Server.cs#L324-L335)
- [the later socket-close path expects to remove and clean up that same player](https://github.com/NebulaModTeam/nebula/blob/3cdf95c594a2f8010b0e87a43be828e6ba2f657f/NebulaNetwork/Server.cs#L111-L170)
- [official `v0.9.22` release/tag](https://github.com/NebulaModTeam/nebula/releases/tag/v0.9.22)

Although `IServer.Disconnect` is public, the locked source uses it for
connection rejection while a player is pending/syncing. Calling it for an
already connected player removes the collection entry before the socket-close
callback can perform the authoritative leave broadcast and cleanup. Treating it
as kick would therefore invent unsupported semantics. The enum also has no kick
reason, and the locked source exposes no player ban, whitelist, or per-player
permission operation.

Nebula does contain a host-side [`/playerdata remove`
command](https://github.com/NebulaModTeam/nebula/blob/3cdf95c594a2f8010b0e87a43be828e6ba2f657f/NebulaWorld/Chat/Commands/PlayerDataCommandHandler.cs#L64-L91),
but that operation targets a long-lived client-certificate hash or display name
inside the `.server` data set. It is not an active-session moderation action,
cannot be addressed solely by this bridge's opaque session player ID, and has
no crash-safe rollback receipt. It is therefore deliberately outside this
contract rather than being mislabeled as a safe player action.

Because there is no verified mutation, this bridge intentionally defines no
player-action request or receipt protocol at all. That is stricter than
accepting signed requests only to reject them: there is no dormant execution
surface, arbitrary command, caller-supplied reason/chat text, target path, or
raw Nebula player/connection identifier. UUID idempotency, expiry, replay
blocking, durable mutation receipts, timeouts, and rollback are required gates
for a future *supported* action, but are not falsely claimed for this
observation-only contract.

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
$artifact = 'C:\Packages\DysonControl-v0.1.0'
$server = 'C:\GameServers\DSP\server'
$candidate = 'C:\Private\DysonControlBridge-0.1.0'

& "$artifact\scripts\windows\bridge\Build-DysonControlBridgeCandidate.ps1" `
  -SourcePath "$artifact\integrations\dyson-control-bridge" `
  -DysonServerRoot $server `
  -OutputPath $candidate `
  -ExpectedVersion '0.1.0' `
  -Confirm:$false

& "$artifact\scripts\windows\bridge\Test-DysonControlBridgeCandidate.ps1" `
  -CandidatePath $candidate `
  -DysonServerRoot $server `
  -ExpectedVersion '0.1.0'
```

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
& $installer -CandidatePath $candidate -DysonServerRoot $server -WhatIf
& $installer -CandidatePath $candidate -DysonServerRoot $server -Confirm:$false

& "$artifact\scripts\windows\bridge\Test-DysonControlBridgeInstallation.ps1" `
  -DysonServerRoot $server
```

If the game and control plane run under different Windows identities, pass
their exact SID strings with `-SecretReaderSid`. The installer creates at least
48 cryptographically random secret bytes, never prints them or records them in
a manifest, disables ACL inheritance, and rejects broad readers. It snapshots
the old plugin/config/state, publishes the DLL and config using same-directory
atomic replacement, rolls back on failure, leaves `Enabled = false`, and never
starts the game.

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
