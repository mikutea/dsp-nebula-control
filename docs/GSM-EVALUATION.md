# GSManager suitability decision

Decision date: 2026-08-30

## Decision

Do not build the DSP/Nebula control plane as a GSManager plugin. Build and ship
an independent service. Keep GSManager only as an optional emergency tool during
the transition.

## Fast-spike acceptance gates

| Gate | Required | Observed | Result |
| --- | --- | --- | --- |
| Custom authenticated backend routes | Stable plugin-owned route registration | Plugin is static; no supported backend registration surface | Fail |
| Fine-grained authorization | Viewer/operator/admin separation | Plugin API is globally guarded by administrator middleware | Fail |
| Durable long-running jobs | Queue, progress, cancellation, audit | Only generic instance/terminal operations are exposed | Fail |
| Safe domain operations | Atomic save/update/rollback primitives | API exposes generic files and process lifecycle only | Fail |
| Upgrade isolation | Plugin can survive upstream upgrades without core patches | Domain backend would require GSManager core modification or a sidecar bypass | Fail |

The first two failures are hard stops. Continuing inside GSManager would either
grant every operator administrator power or require a long-lived fork of its
server core. A sidecar API embedded in an iframe would also duplicate the
authentication boundary while inheriting the panel's content-security and
routing constraints.

## Preserved value

GSManager still provides a useful emergency terminal, file browser, and generic
process view. Those features are operational conveniences, not dependencies of
Dyson Control.

## Parallel migration and recovery contract

The release contains a general-purpose Windows migration toolset under
`scripts/windows/migration`. It is deliberately a side-by-side preparation and
recovery mechanism, not a cutover command:

- `Get-DysonGsManagerMigration.ps1` performs a read-only bounded inventory and
  task inspection;
- `New-DysonGsManagerSnapshot.ps1` supports `-WhatIf` and atomically publishes a
  private GSManager file/task snapshot beneath the fixed
  `DataRoot\migration\snapshots` tree;
- `Test-DysonGsManagerSnapshot.ps1` rejects unknown schema fields, missing or
  extra files, reparse points, limit violations, and any byte/hash change;
- `Restore-DysonGsManagerSnapshot.ps1` supports `-WhatIf` and restores only a
  caller-selected, digest-bound snapshot after publishing a private compensation
  guard.

`GsManagerRoot` must be a normal, non-root strict child of `ProjectRoot`. Every
existing source/target ancestor and every tree entry is checked for redirection.
Snapshot creation is bounded by file count, total bytes, and single-file bytes;
the defaults are 10,000 files, 2 GiB total, and 512 MiB per file, with hard caps
inside the implementation. Settings and scheduled-task XML stay only in the
private snapshot. Machine-readable output is limited to opaque IDs, counts,
digests, and status flags; it does not return paths, task commands, principals,
XML, or file contents.

Migration snapshots do not claim to be save backups. Before snapshot creation,
the caller must supply the opaque ID and SHA-256 digest of an existing Dyson
Control paired-save protection manifest. The tool verifies and binds that
manifest but never opens, copies, deletes, or packages a `.dsv` or `.server`.
Encountering either extension in the GSManager tree is a hard failure.

An actual restore requires the exact `RESTORE_GSMANAGER_SNAPSHOT` token, an
elevated Administrator shell, a stopped `Dyson-Control-Plane` task, no
`DSPGAME.exe` process (including an ambiguous executable), and a non-running
GSManager task. A missing or empty target can be restored; an already identical
tree is idempotent; a non-empty different tree is rejected. Root and scheduled
task state are guarded before mutation, and a later failure compensates both
from that guard. Restore never starts DSP or GSManager.

There is intentionally no quiet remove, disable, switch, or cutover operation.
GSManager remains available until a separately reviewed maintenance-window
decision removes it. The fixture self-test uses only temporary fictional roots
and a shadowed task adapter; it is implementation evidence, not target-host or
production verification.

## Revisit condition

Reconsider only if GSManager publishes a documented, versioned server-plugin API
with route registration, scoped permissions, background jobs, event streaming,
and compatibility guarantees. A static iframe API expansion is not sufficient.
