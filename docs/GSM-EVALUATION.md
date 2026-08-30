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

## Revisit condition

Reconsider only if GSManager publishes a documented, versioned server-plugin API
with route registration, scoped permissions, background jobs, event streaming,
and compatibility guarantees. A static iframe API expansion is not sufficient.
