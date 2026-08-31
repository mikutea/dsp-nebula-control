# Dyson Control

Dyson Control is a safety-first, open-source control plane for self-hosted
**Dyson Sphere Program + Nebula** multiplayer servers.

It is intentionally not a generic game panel. Its job is to understand the
parts that generic panels do not: the licensed DSP client, Nebula/BepInEx
compatibility, paired `.dsv` + `.server` saves, locked mod sets, staged updates,
client/server parity, and rollback-oriented operations.

> Project status: `0.1.0` implementation foundation. The repository now
> contains an authenticated dashboard; bounded Windows inventory; durable,
> opt-in lifecycle transactions; paired-save catalogue and default-off,
> authenticated backup/restore workflows;
> deterministic paired-save export/import quarantine; typed configuration
> preview/apply; a redacted structured console with four fixed lifecycle
> commands; signed player observation and capability proof; Viewer/Operator/
> Administrator authorization; authenticated update discovery, offline staging,
> component activation transaction contracts, reversible mod deployment,
> reproducible client ZIP delivery; retained server telemetry; automatic
> Windows interactive-session provisioning; and a reusable Windows control-plane
> deployment transaction; plus a bounded public-source/history/artifact hygiene
> and provenance gate. The repository default remains non-mutating. None of these
> repository implementations is evidence that the target VM or production
> service has been deployed, restarted, or verified.

Product scope and production readiness are tracked by the machine-validated
[`acceptance/manifest.json`](acceptance/manifest.json). See
[`docs/ACCEPTANCE.md`](docs/ACCEPTANCE.md) for evidence levels and the release
and cutover gates. A feature is not complete merely because its navigation,
preview, or API shape exists.

![Dyson Control dashboard](design/dashboard-implementation-dsp-inspired-v2.png)

## Management scope

The information architecture is designed for the entire DSP + Nebula lifecycle:

- **Game management:** process state, preflight, save requests, graceful stop,
  maintenance, restart, and rollback.
- **Version updates:** DSP, Nebula, and BepInEx compatibility, staged activation,
  liveness/readiness checks, and rollback.
- **Mod updates:** Thunderstore dependencies, conflicts, hashes, version locks,
  and client/server parity.
- **Player management:** online sessions, connection quality, bounded public
  identity, join/leave history, and a signed capability matrix. Kick, ban,
  whitelist, and permission controls stay unavailable until Nebula exposes a
  verified authoritative interface.
- **Save management:** atomic `.dsv` + `.server` inventory, backup, retention,
  validation, download, and guarded restore.
- **Server management:** Windows service/task health, resources, storage,
  networking, runtime prerequisites, and diagnostics.
- **Console:** structured logs, filters, search, download, and allowlisted audited
  commands.
- **Configuration:** game/Nebula/mod settings, validation, diff, staged apply,
  export/import, and rollback.
- **Client packages:** generate a client profile from the same version/mod lock
  used by the server.
- **Tasks and audit:** durable jobs, actors, results, timings, and rollback
  references.

The navigation exposes all of these workspaces. Save backup/restore, raw save
transfer, mod deployment and component activation each retain an independent
default-off execution gate plus role and confirmation checks. Client ZIP
delivery and the four fixed console actions have bounded workflows. Player
mutation is not invented where Nebula lacks a verified interface: the signed
capability matrix keeps those controls unavailable. Production actions remain
locked until their complete adapters and target-host evidence pass the
documented gates.

## Why a separate control plane?

The evaluated GSManager plugin surface is a static iframe backed by an
administrator-only generic API. It has no stable extension point for
game-specific backend routes, durable jobs, fine-grained roles, or atomic
Nebula save/update workflows. See [docs/GSM-EVALUATION.md](docs/GSM-EVALUATION.md).

GSManager may remain installed as an emergency terminal while Dyson Control is
developed, but it is not a runtime dependency. The release also carries a
bounded, recoverable GSManager parallel-migration toolkit: read-only inspection,
`-WhatIf`, a private atomic file/task snapshot bound to an existing paired-save
protection manifest, strict full re-verification, and an explicitly confirmed
guarded restore. It never snapshots `.dsv`/`.server`, starts either application,
or provides a silent remove/disable/switch operation. See the
[GSManager evaluation and migration contract](docs/GSM-EVALUATION.md#parallel-migration-and-recovery-contract).

## Safe local preview

Requirements: Node.js 24 or newer. The complete repository gate also uses a
.NET 8 SDK for the cross-runtime bridge protocol self-test; building the actual
BepInEx bridge additionally requires a locally installed, licensed DSP server
tree and never redistributes its assemblies.

```powershell
npm install
npm run install:all
$env:DYSON_DEV_ADMIN_PASSWORD = 'choose-a-local-test-password'
npm run dev
```

Open `http://127.0.0.1:5173`. The development server proxies API calls to
`http://127.0.0.1:13010`.

The demo provider never touches a real game process or save.

## Windows read-only inventory

The allowlisted Windows collector validates the managed `DSPGAME.exe` against
the configured project root and returns bounded summaries rather than raw host
data. The current inventory includes:

- sampled DSP CPU cores, private/working-set memory, thread count, priority,
  start time, uptime, and the configured UPS argument;
- guest logical processors, processor groups, CPU load, and memory capacity;
- DSP, Nebula, and BepInEx versions plus safe compatibility warning codes from
  the current BepInEx startup log;
- the active Nebula `.dsv` + `.server` pair, sizes, last-save time, and the
  presence of a paired backup and manifest;
- scheduled-task summaries, configured-root availability, global SMB mapping
  health, and local TCP listener health.

The API does not return executable paths, project paths, log lines, task names,
player identities, public endpoints, or credentials. Provider JSON is checked
against a strict runtime schema before it is cached or sent to the browser.
Lifecycle capabilities stay false even if an older host task happens to exist.

## Lifecycle transactions

The game-management workspace can preview `save`, `graceful-stop`, and
`restart` safety chains. Each preview creates a durable job, validates fixed
evidence checks, and reports stable blocker codes. Execution requests use an
idempotency key and ordered SQLite phase receipts, reconcile interrupted work
without replaying it, and retain a recovery-required outcome when state is
uncertain.

The opt-in Windows adapter creates an atomic paired-save protection point,
requires a fresh signed heartbeat from the in-game bridge, requests the save on
Unity's main thread, dispatches fixed scheduled tasks, and verifies stopped or
running state separately. These components have fictional-host integration
tests; they are not production-verified until the target-host gates in the
acceptance manifest are complete.

![Dyson Control lifecycle preflight](design/game-lifecycle-preflight-desktop.png)

See [docs/LIFECYCLE.md](docs/LIFECYCLE.md) for the complete contract and the
remaining target-host gates.

## Implemented management foundations

The following repository surfaces are implemented and tested against fictional
fixtures, but remain narrower than their production acceptance criteria:

- [configuration management](docs/CONFIGURATION.md): typed Nebula/game/
  BepInEx/bridge fields, write-only secrets, redacted diff, optimistic revision,
  confirmed atomic apply, snapshot, audit, and automatic compensation;
- [console and players](docs/CONSOLE-PLAYERS.md): fixed-source structured
  BepInEx logs with signed resumable cursors, filters and bounded redacted
  downloads, plus HMAC-authenticated Nebula player snapshots with minimized,
  restart-safe and count/time-bounded SQLite join/leave history;
- [save management](docs/SAVES.md): bounded paired catalogues, manifest
  verification, revision reads, atomic backup, guarded restore, deterministic
  cross-machine transfer, annotations, recoverable retirement/restore and
  grace-period purge behind independently default-off mutation gates;
- [updates, mod locks, and clients](docs/UPDATES-CLIENTS.md): compatibility and
  release planning, authenticated bounded provider discovery, gated offline
  verified staging, Thunderstore dependency resolution, deterministic locks,
  and authenticated client metadata generation;
- [reusable Windows deployment](docs/WINDOWS-DEPLOYMENT-DRAFT.md): immutable
  control-plane releases, startup task, upgrade health gate, rollback, and
  recoverable uninstall.
- [performance qualification](docs/PERFORMANCE.md): persistent telemetry and a
  fixed six-hour late-game UPS/core-balance/memory/storage report, plus durable
  acknowledged alert episodes; these remain separate from save, reboot, crash,
  and external-client drills.

`implemented` means code or a tested contract exists; it does not mean a real
Windows/Nebula host passed the criterion. The precise distinction is maintained
in [the acceptance manifest](acceptance/manifest.json).

## Production configuration

Generate a password hash locally:

```powershell
npm run hash-password -- 'a-long-unique-panel-password'
```

Then configure at minimum:

```text
NODE_ENV=production
DYSON_HOST=127.0.0.1
DYSON_PUBLIC_ORIGIN=https://game.example.com
DYSON_ADMIN_PASSWORD_HASH=scrypt$...
DYSON_SESSION_SECRET=<at least 32 random characters>
DYSON_PROVIDER=windows
DYSON_PROJECT_ROOT=C:\GameServers\DSP
DYSON_CONSOLE_CURSOR_SECRET=<at least 32 random characters>
```

Real lifecycle execution additionally requires the fixed task/bridge
installation and all of these explicit values:

```text
DYSON_LIFECYCLE_ENABLED=true
DYSON_LIFECYCLE_TIMEOUT_MS=240000
DYSON_BRIDGE_CONTROL_ROOT=C:\GameServers\DSP\run\control-bridge
DYSON_BRIDGE_SECRET_FILE=C:\ProgramData\DysonControl\bridge.secret
```

Leaving `DYSON_LIFECYCLE_ENABLED` unset or `false` keeps the execution endpoint
available for audited testing but terminates every request before any host
mutation method is called.

Save writes use an independent fail-closed gate. The default permits previews
but rejects backup and restore execution:

```text
DYSON_SAVE_MUTATIONS_ENABLED=false
```

Setting it to `true` is accepted only with the Windows provider. Restore still
requires the fixed runtime-state script to prove the exact managed process is
stopped and the configured game port is not listening, an optimistic save-pair
revision, a fresh protection-point request ID, and explicit UI/API confirmation.
Do not enable it on a production save before the target-host restore drill in
[the save guide](docs/SAVES.md) passes.

The application deliberately binds to loopback by default. Put an authenticated
TLS reverse proxy in front of it; do not expose the Node listener directly.

The project root above is fictional. A public deployment guide must never copy
a real hostname, address, Windows path, account, secret, save, log, or task
export into the repository. Create the production environment file locally on
the target host.

## Reusable Windows deployment

The control-plane deployment scripts under `scripts/windows/deployment` support
temporary-root self-testing, immutable release staging, an atomic active pointer,
AtStartup execution without RDP, exact-version deep loopback readiness checks,
one stable cross-process transaction lock, guarded upgrade/rollback, and a
recoverable uninstall that preserves ProgramData by default. Task identity is
globally checked and fixed to the root Task Scheduler path; query failures stop
before mutation. They install Dyson Control only; they do not silently start,
stop, or remove DSP, Nebula, or GSManager.

Run the repository-safe checks before using a package:

```powershell
npm run powershell:check
npm run deployment:selftest
npm run evidence:selftest
powershell.exe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass `
  -File scripts/windows/bridge/SelfTest-DysonControlBridge.ps1
powershell.exe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass `
  -File scripts/windows/migration/SelfTest-DysonGsManagerMigration.ps1
```

Then follow [the Windows deployment guide](docs/WINDOWS-DEPLOYMENT-DRAFT.md),
starting every mutating command with `-WhatIf`. The self-test runs under a
temporary fictional root. It does not replace clean-host Task Scheduler, ACL,
reboot, health, rollback, uninstall, or production verification.

The public release artifact ships the Bridge source, project file, disabled
configuration template, bounded Windows build/verify/install tools, the exact
GSManager migration script set, private-acceptance bundle/index tooling, and the
GSManager/Windows migration guides. Private staging must already carry the exact
protected operator/SYSTEM/Administrators ACL before either preview or publish;
only the minimal generated index belongs in Git. The artifact does
not ship `DysonControlBridge.dll`, PDB files, or DSP/Unity/BepInEx/Nebula
assemblies. A private candidate must be built and verified on a Windows host
that lawfully has those exact local files; see the
[Bridge delivery contract](integrations/dyson-control-bridge/README.md#public-source-package-and-private-candidate).

## Public release hygiene

The repository includes a bounded, fail-closed scanner for the worktree,
reachable Git history, image metadata, credentials/private data, and an already
generated release artifact. Its self-test is part of `npm run check`; the real
release scan is intentionally separate because a development worktree is
normally dirty:

```powershell
npm run public-release:selftest
npm run public-release:check
node scripts/public-release/check.mjs --history --artifact <artifact-directory>
```

The final command validates the artifact manifest, exact file set, sizes,
per-file SHA-256 values, and the exact source commit. A passing local scan does
not inspect inaccessible forks, hosting-platform caches, or previously
published assets, and image paths still require the documented visual review.
See [the scanner contract](scripts/public-release/README.md).

## Repository layout

```text
apps/api       Fastify control-plane API, authentication, jobs, audit storage
apps/web       React/Vite operator interface
integrations   Disabled-by-default, protocol-bounded game/client companions
scripts/windows  Bounded Windows collectors and fixed lifecycle actions
docs           Architecture, security model, and migration decisions
design         Accepted UI concept used as an implementation specification
```

## Roadmap

1. Finish the remaining repository-level configuration snapshot/restore and
   component live-publication surfaces, then pass the complete local gate.
2. Run desktop/mobile browser acceptance against fictional local data and
   verify the release artifact with the public hygiene/provenance gate.
3. Run the reusable Windows package through clean-host, reboot, ACL, upgrade,
   rollback, and uninstall matrices.
4. With fresh production approval, deploy side by side on the Dyson VM while
   GSManager remains recoverable.
5. Complete the external join, PassWall-bypass, paired-save restore,
   late-game performance, reboot/fault, and soak evidence.
6. Remove GSManager only after every cutover gate passes and the rollback
   package has been independently verified.

Inspect the current evidence-backed roadmap without changing state:

```powershell
npm run acceptance:summary
```

The final `npm run acceptance:gate` deliberately fails until every blocking
`P0` and `P1` criterion has direct verification evidence.

No game binaries, Steam credentials, Mod archives, real saves, player data, or
production configuration belong in this repository.

## License

GPL-3.0-only. See `LICENSE`.
