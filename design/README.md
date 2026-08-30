# Accepted dashboard design

`dashboard-concept-v1.png` is the user-selected visual source of truth. It was
generated on 2026-08-29 and intentionally restored after a later simplified
concept was rejected.

Implementation invariants:

- preserve the deep blue-black operations-console aesthetic;
- preserve the dense but readable desktop layout, top instance context bar,
  left navigation, status strip, telemetry, console, deployment/version rail,
  tasks, and save/backup region;
- extend navigation without changing the design language to cover game,
  versions, mods, players, saves, server, console, configuration, client
  delivery, tasks, and audit;
- keep all text and controls code-native;
- do not ship production hostnames, paths, credentials, logs, saves, or player
  information in screenshots or fixtures.
