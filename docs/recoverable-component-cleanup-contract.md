# Recoverable component cleanup contract

Implementation target for U13. This document is not execution authority and does
not claim the cleanup endpoint exists.

The existing cleanup preview remains read-only. A new executable plan must bind
an administrator request UUID, active revision, the full sorted candidate list,
each source content digest, and a canonical plan SHA-256. Only server-derived
opaque history/release IDs enter the HTTP contract; filesystem paths never do.

Before publication, acquire the shared host mutation lease and activation lock,
reject pending activation/operator recovery, re-read active state and each source,
and regenerate the plan. A mismatch rejects before moving any file. Protect the
current transaction history, all active releases, all releases referenced by
retained histories, and all live rollback journals/material still required for
recovery. Retiring history alone must not implicitly retire its live snapshots.

Write a durable intent before the first move. Move eligible objects into a fixed
request-owned quarantine on the same volume; never permanently delete in this
workflow. Journal each object's original opaque ID, size/digest and quarantine
identity. Use atomic rename and exact readback; after interruption, classify each
object as source-only, quarantine-only, both or neither. Only the first two exact
states may converge automatically; ambiguous or mismatching bytes require
recovery and must not be overwritten.

A completed cleanup releases a history slot only after all planned moves are
proven and a terminal receipt is durable. The receipt binds the original plan,
authenticated actor, start/completion times and recoverability manifest. Retain
quarantine capacity accounting separately: moving on the same volume does not
free disk space, and the UI must never claim that it does.

Restore is its own request-bound, audited transaction. Reject occupied source
names and preserve current active revision. Prove quarantine digests, journal
before reverse moves, and emit a separate restore receipt. Restore may exceed the
normal active-history limit; if so, further updates remain blocked until another
explicit cleanup. Never prevent disaster recovery merely to meet a retention cap.

Required tests: current predecessor exclusion; unresolved recovery rejection;
state/source drift between preview and execute; lease loss at every move boundary;
source-only/quarantine-only replay; both/neither rejection; symlink/hardlink and
outside-root rejection; failed quarantine publication; restore collision; restore
after process restart; preserved audit/original receipts; and Windows volume/ACL
behavior. The final API/UI must expose preview, confirmation, receipt lookup,
interrupted recovery and quarantine restore. No automatic purge is part of U13.
